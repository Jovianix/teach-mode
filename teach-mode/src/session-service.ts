import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
import { TeachSessionSchema, TeachStartSchema, TeachOutputSchema, TeachWebActionSchema,
  type TeachSession, type TeachStart, type TeachWebAction, type TeachRun } from "./contracts.js";
import { RecordingError, writeJsonAtomic, type TeachRecordings, type TeachCollector } from "./host.js";
import { compileTeachWebActions, normalizeNote, sha256, type TeachBrowser } from "./browser.js";
import type { TeachNotepad } from "./notepad.js";
import { TeachPlanSchema, type TeachPlan } from "./plan.js";
import { exportTeachArtifacts, readTeachArtifacts, teachSkillName } from "./artifacts.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const time = () => new Date().toISOString();
const capturing = (session: TeachSession) => ["starting", "recording_web", "switching", "recording_desktop"].includes(session.state);
type ActiveTeach = { session: TeachSession; browser: TeachBrowser; release: () => Promise<void> };
type ActiveRun = { session: TeachSession; run: TeachRun; controller: AbortController; browser: TeachBrowser; promise: Promise<void>; release: () => Promise<void> };

export function readNote(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error("teach_note_file_invalid");
  const bytes = fs.readFileSync(file);
  return normalizeNote(bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : new TextDecoder("utf8", { fatal: true }).decode(bytes));
}
/** The parent owns the shared collector lease. Its child recorder has a private gate. */
export class TeachSessionService {
  readonly directory: string;
  readonly outputDirectory: string;
  private active: ActiveTeach | null = null;
  private running: ActiveRun | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly watchdog: NodeJS.Timeout;
  private readonly gate: TeachCollector;
  constructor(private readonly options: { directory?: string; outputDirectory?: string; gate: TeachCollector;
    recordings: TeachRecordings; browser: () => TeachBrowser; notepad: TeachNotepad;
    supported?: boolean; historyBusy?: () => boolean }) {
    this.directory = path.resolve(options.directory ?? path.join(os.homedir(), ".memmy", "teach-sessions"));
    this.outputDirectory = path.resolve(options.outputDirectory ?? path.join(os.homedir(), "Documents", "Memmy Teach"));
    this.gate = options.gate;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error("teach_directory_invalid");
    for (const session of this.list()) {
      if (!capturing(session) && session.state !== "running") continue;
      session.state = "failed"; session.error = "teach_interrupted"; session.stoppedAt = time();
      for (const segment of session.segments) if (segment.state === "recording") { segment.state = "failed"; segment.stoppedAt = time(); segment.missing.push("process_exit"); }
      for (const run of session.runs) if (run.state === "running") { run.state = "failed"; run.error = "teach_interrupted"; run.stoppedAt = time(); }
      this.save(session);
    }
    this.watchdog = setInterval(() => {
      void this.serialize(async () => {
        const active = this.active;
        if (!active) return;
        let reason = active.session.segments[0]?.state === "recording" ? active.browser.failureReason?.() : null;
        const child = active.session.segments.find(segment => segment.backend === "windows_notepad");
        if (active.session.state === "recording_desktop" && child?.recordingId) {
          const recording = await this.options.recordings.get(child.recordingId);
          if (["ready", "failed"].includes(recording.state)) reason ??= "teach_desktop_recording_stopped";
        }
        if (reason) await this.failRecording(active, new Error(reason));
      }).catch(() => {});
    }, 1500);
    this.watchdog.unref();
  }
  configuration() { return { supported: this.options.supported !== false, reason: this.options.supported === false ? "teach_requires_windows" : null,
    outputDirectory: this.outputDirectory, browser: "msedge" as const }; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation); this.operations = next.catch(() => {}); return next;
  }
  private folder(id: string): string {
    if (!uuid.test(id)) throw new RecordingError(400, "teach_id_invalid");
    const folder = path.join(this.directory, id);
    if (fs.existsSync(folder) && (fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(folder).isDirectory())) throw new RecordingError(422, "teach_directory_invalid");
    return folder;
  }
  private save(session: TeachSession): void { writeJsonAtomic(path.join(this.folder(session.id), "session.json"), TeachSessionSchema.parse(session)); }
  get(id: string): TeachSession {
    try {
      const file = path.join(this.folder(id), "session.json");
      if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4_000_000) throw new Error();
      const session = TeachSessionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (session.id !== id) throw new Error();
      return session;
    } catch (error) { if (error instanceof RecordingError) throw error; throw new RecordingError(404, "teach_not_found"); }
  }
  list(): TeachSession[] {
    return fs.readdirSync(this.directory).filter(name => uuid.test(name)).flatMap(id => { try { return [this.get(id)]; } catch { return []; } })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async reserve(): Promise<() => Promise<void>> {
    if (this.options.supported === false) throw new RecordingError(400, "teach_requires_windows");
    if (this.closing || this.active || this.running || this.options.historyBusy?.()) throw new RecordingError(409, "teach_busy: stop Computer History or the active task first");
    return this.gate.acquire();
  }
  private current(id: string, state: TeachSession["state"]): ActiveTeach {
    if (!this.active || this.active.session.id !== id || this.active.session.state !== state) throw new RecordingError(409, "teach_state_conflict");
    return this.active;
  }
  private webEvents(session: TeachSession): TeachWebAction[] {
    const file = path.join(this.folder(session.id), "web", "events.jsonl");
    const bytes = fs.readFileSync(file);
    if (bytes.length > 16_000_000 || fs.lstatSync(file).isSymbolicLink()) throw new Error("teach_web_events_invalid");
    const actions = bytes.toString("utf8").split("\n").filter(Boolean).map(line => TeachWebActionSchema.parse(JSON.parse(line)));
    if (actions.length > 2000 || actions.some((action, index) => action.sequence !== index + 1)) throw new Error("teach_web_events_invalid");
    return actions;
  }
  private async appendWeb(active: ActiveTeach, action: TeachWebAction): Promise<void> {
    const session = active.session;
    if (!["starting", "recording_web"].includes(session.state)) return;
    const segment = session.segments[0]!;
    if (segment.eventCount >= 2000) throw new Error("teach_web_event_limit");
    fs.appendFileSync(path.join(this.folder(session.id), "web", "events.jsonl"), JSON.stringify(action) + "\n", { mode: 0o600 });
    segment.eventCount++;
    if (action.type === "unsupported") { segment.missing.push(action.value ?? "unsupported_action"); session.error = "teach_web_action_unsupported"; }
    if (action.type === "output" && action.locator) {
      const result = await active.browser.read(action.locator, action.url);
      const evidence = `web/output-${action.sequence}.png`;
      await active.browser.screenshot(path.join(this.folder(session.id), evidence));
      session.output = TeachOutputSchema.parse({ name: "note_text", sourceUrl: result.url, locator: action.locator,
        text: result.text, sha256: sha256(normalizeNote(result.text)), observedAt: time(), evidence });
    }
    this.save(session);
  }
  start(input: TeachStart): Promise<TeachSession> { return this.serialize(async () => {
    const parsed = TeachStartSchema.safeParse(input);
    if (!parsed.success) throw new RecordingError(422, "teach_requires_url_title_and_consent");
    const release = await this.reserve(), browser = this.options.browser();
    const session: TeachSession = { schemaVersion: 1, id: crypto.randomUUID(), title: parsed.data.title, startUrl: parsed.data.url,
      state: "starting", createdAt: time(), stoppedAt: null, segments: [], output: null, desktop: null, planSha256: null, runs: [], error: null,
      runtime: "memmy-web-notepad-v1", openadaptAdmission: "not_admitted", privacy: { localOnly: true, audio: false, rawVisibleFrames: true } };
    const active = { session, browser, release }; this.active = active;
    try {
      fs.mkdirSync(path.join(this.folder(session.id), "web"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.folder(session.id), "web", "events.jsonl"), "", { flag: "wx", mode: 0o600 });
      session.segments.push({ id: crypto.randomUUID(), backend: "web", state: "recording", startedAt: time(), stoppedAt: null,
        offsetMs: 0, recordingId: null, eventCount: 0, eventsSha256: null, missing: [] });
      this.save(session);
      await browser.start(session.startUrl, this.folder(session.id), action => this.appendWeb(active, action));
      session.state = "recording_web"; this.save(session);
      return this.get(session.id);
    } catch (error) { await this.failRecording(active, error); throw error; }
  }); }
  pick(id: string): Promise<TeachSession> { return this.serialize(async () => {
    const active = this.current(id, "recording_web"); await active.browser.pick(); return this.get(id);
  }); }
  private createNote(id: string, label: string): string {
    fs.mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.outputDirectory).isSymbolicLink()) throw new Error("teach_output_directory_invalid");
    const file = path.join(this.outputDirectory, `${label}-${id}.txt`);
    fs.writeFileSync(file, "\uFEFF", { flag: "wx", mode: 0o600 });
    return file;
  }
  toDesktop(id: string): Promise<TeachSession> { return this.serialize(async () => {
    // A failed native startup may be retried explicitly without discarding a
    // complete, sealed web demonstration. No recording is resumed at startup.
    if (!this.active) {
      const previous = this.get(id), web = previous.segments[0];
      if (previous.state === "failed" && previous.output && previous.segments.length === 1 && web?.state === "sealed" && !web.missing.length) {
        if (sha256(fs.readFileSync(path.join(this.folder(id), "web", "events.jsonl"))) !== web.eventsSha256
          || sha256(normalizeNote(previous.output.text)) !== previous.output.sha256) throw new Error("teach_recording_integrity_failed");
        const release = await this.reserve(); previous.state = "recording_web"; previous.error = null; previous.stoppedAt = null;
        this.active = { session: previous, browser: this.options.browser(), release };
      }
    }
    const active = this.current(id, "recording_web"), session = active.session;
    if (!session.output) throw new RecordingError(422, "teach_select_output_first");
    try {
      await active.browser.seal();
      const actions = this.webEvents(session);
      compileTeachWebActions(actions, session.output);
      session.state = "switching"; this.save(session);
      const segment = session.segments[0]!;
      if (segment.state !== "sealed") {
        segment.state = "sealed"; segment.stoppedAt = time();
        segment.eventsSha256 = sha256(fs.readFileSync(path.join(this.folder(id), "web", "events.jsonl")));
      }
      session.desktop = await this.options.notepad.open(this.createNote(crypto.randomUUID(), "demonstration"));
      const recording = await this.options.recordings.start({ title: session.title, applications: [session.desktop.executable], consent: true, skipIdle: false }, null,
        { pid: session.desktop.pid, hwnd: session.desktop.hwnd, processStart: session.desktop.processStart });
      session.segments.push({ id: crypto.randomUUID(), backend: "windows_notepad", state: "recording", startedAt: time(), stoppedAt: null,
        offsetMs: Date.now() - Date.parse(session.createdAt), recordingId: recording.id, eventCount: 0, eventsSha256: null, missing: [] });
      session.state = "recording_desktop"; this.save(session); return this.get(id);
    } catch (error) { await this.failRecording(active, error); throw error; }
  }); }
  private async verifyDocument(session: TeachSession, expected: string, signal?: AbortSignal): Promise<{ ui: boolean; file: boolean; fileSha256: string }> {
    if (!session.desktop) throw new Error("teach_desktop_missing");
    const ui = normalizeNote(await this.options.notepad.read(session.desktop, signal)) === normalizeNote(expected);
    const actual = readNote(session.desktop.file), file = actual === normalizeNote(expected);
    if (!ui) throw new RecordingError(422, "teach_notepad_text_does_not_match_output");
    if (!file) throw new RecordingError(422, "teach_save_note_before_finishing");
    return { ui, file, fileSha256: sha256(fs.readFileSync(session.desktop.file)) };
  }
  finish(id: string): Promise<TeachSession> { return this.serialize(async () => {
    const existing = this.get(id);
    if (existing.state === "ready" && existing.planSha256) return this.exportSession(existing);
    const active = this.current(id, "recording_desktop"), session = active.session;
    if (!session.output || !session.desktop) throw new RecordingError(422, "teach_binding_missing");
    // A recoverable mismatch leaves recording on, so the user can correct and save.
    await this.verifyDocument(session, session.output.text);
    try {
      const segment = session.segments.at(-1)!;
      const recording = await this.options.recordings.control(segment.recordingId!, "stop");
      if (recording.state !== "ready" || recording.timelineCompleteness !== "complete") throw new Error("teach_desktop_recording_incomplete");
      const file = path.join(this.options.recordings.directory, recording.id, "events.jsonl");
      const raw = fs.readFileSync(file, "utf8"), events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (!events.some(event => event.type === "key_press" && /^(ctrl|control)\+s$/iu.test(event.action?.key ?? ""))) throw new Error("teach_save_action_not_recorded");
      if (!events.some(event => event.type === "text_input" || (event.type === "key_press" && /^(ctrl|control)\+v$/iu.test(event.action?.key ?? "")))) throw new Error("teach_text_input_not_recorded");
      segment.eventCount = events.filter(event => event.type !== "accessibility_snapshot").length;
      segment.eventsSha256 = sha256(raw); segment.state = "sealed"; segment.stoppedAt = time();
      const output = session.output;
      const plan: TeachPlan = { schema: "memmy.teach-plan/v1", runtime: session.runtime, openadaptAdmission: "not_admitted",
        web: { backend: "web", startUrl: session.startUrl, actions: compileTeachWebActions(this.webEvents(session), output),
          output: { name: "note_text", sourceUrl: output.sourceUrl, locator: output.locator } },
        desktop: { backend: "windows_notepad", input: "web.note_text", operations: ["focus_editor", "replace_text", "save", "verify_ui", "verify_file"],
          recordingId: recording.id, eventsSha256: segment.eventsSha256 } };
      writeJsonAtomic(path.join(this.folder(id), "plan.json"), plan);
      session.planSha256 = sha256(fs.readFileSync(path.join(this.folder(id), "plan.json")));
      await this.options.recordings.pin(recording.id, true);
      session.state = "ready"; session.stoppedAt = time(); session.error = null; this.save(session);
      await active.browser.close().catch(() => {}); await active.release(); this.active = null;
      return this.exportSession(session);
    } catch (error) { await this.failRecording(active, error); throw error; }
  }); }
  private loadPlan(session: TeachSession): TeachPlan {
    const file = path.join(this.folder(session.id), "plan.json");
    if (!session.planSha256 || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 2_000_000 || sha256(fs.readFileSync(file)) !== session.planSha256) throw new Error("teach_plan_integrity_failed");
    const plan = TeachPlanSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (sha256(fs.readFileSync(path.join(this.folder(session.id), "web", "events.jsonl"))) !== session.segments[0]?.eventsSha256
      || sha256(fs.readFileSync(path.join(this.options.recordings.directory, plan.desktop.recordingId, "events.jsonl"))) !== plan.desktop.eventsSha256) throw new Error("teach_recording_integrity_failed");
    return plan;
  }
  private exportSession(session: TeachSession): TeachSession {
    try {
      session.artifactExport = exportTeachArtifacts(this.directory, session, this.loadPlan(session));
    } catch (error) {
      session.artifactExport = { state: "failed", skillName: teachSkillName(session.id), planSha256: session.planSha256!,
        generatedAt: time(), error: error instanceof Error ? error.message : "teach_export_failed" };
    }
    this.save(session);
    return this.get(session.id);
  }
  export(id: string): Promise<TeachSession> { return this.serialize(async () => {
    const session = this.get(id);
    if (!session.planSha256 || !["ready", "failed"].includes(session.state)) throw new RecordingError(409, "teach_plan_not_ready");
    return this.exportSession(session);
  }); }
  artifacts(id: string) { return readTeachArtifacts(this.directory, this.get(id)); }
  async bundle(id: string): Promise<Buffer> {
    const exported = this.artifacts(id), archive = new JSZip();
    for (const [name, bytes] of Object.entries(exported.files)) archive.file(`${exported.manifest.skillName}/${name}`, bytes);
    return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }
  run(id: string, consent: boolean, expectedPlanSha256?: string): Promise<TeachSession> { return this.serialize(async () => {
    if (consent !== true) throw new RecordingError(422, "teach_execution_consent_required");
    const session = this.get(id);
    if (expectedPlanSha256 !== undefined && session.planSha256 !== expectedPlanSha256) throw new RecordingError(409, "teach_plan_hash_mismatch");
    if (!["ready", "failed"].includes(session.state) || !session.planSha256) throw new RecordingError(409, "teach_plan_not_ready");
    if (session.runs.length >= 100) throw new RecordingError(422, "teach_run_limit");
    const plan = this.loadPlan(session), release = await this.reserve(), browser = this.options.browser(), controller = new AbortController();
    const run: TeachRun = { id: crypto.randomUUID(), state: "running", startedAt: time(), stoppedAt: null, sourceUrl: null,
      outputText: null, outputSha256: null, file: null, fileSha256: null, uiReadbackMatched: false, fileReadbackMatched: false, error: null };
    session.runs.push(run); session.state = "running"; session.error = null;
    const active: ActiveRun = { session, run, controller, browser, release, promise: Promise.resolve() }; this.running = active;
    const directory = path.join(this.folder(id), "runs", run.id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.save(session);
    active.promise = this.execute(active, plan, directory).catch(() => {
      // A report write failure must not become an unhandled background rejection.
      session.state = "failed"; session.error = "teach_report_write_failed";
      run.state = "failed"; run.error = session.error;
      try { this.save(session); } catch { /* Preserve existing evidence for recovery. */ }
    });
    return this.get(id);
  }); }
  async waitForRun(id: string, runId: string, signal?: AbortSignal | null): Promise<TeachSession> {
    const active = this.running;
    if (active?.session.id !== id || active.run.id !== runId) return this.get(id);
    const cancel = () => { active.controller.abort(); void active.browser.close().catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    try { if (signal?.aborted) cancel(); await active.promise; return this.get(id); }
    finally { signal?.removeEventListener("abort", cancel); }
  }
  private async execute(active: ActiveRun, plan: TeachPlan, directory: string): Promise<void> {
    const { session, run, controller, browser } = active, signal = controller.signal;
    const stop = setTimeout(() => controller.abort(new Error("teach_run_timeout")), 180_000); stop.unref();
    try {
      await browser.start(plan.web.startUrl, directory, async () => {}); await browser.seal(); signal.throwIfAborted();
      await browser.replay(plan.web.startUrl, plan.web.actions, signal);
      const output = await browser.read(plan.web.output.locator, plan.web.output.sourceUrl); signal.throwIfAborted();
      run.sourceUrl = output.url; run.outputText = output.text; run.outputSha256 = sha256(normalizeNote(output.text));
      await browser.screenshot(path.join(directory, "web-output.png")); this.save(session);
      await browser.close(); signal.throwIfAborted();
      const file = this.createNote(run.id, "result"); run.file = file;
      const target = await this.options.notepad.open(file, signal); signal.throwIfAborted();
      // The executor receives the live output. The demonstration's literal text is absent from plan.json.
      await this.options.notepad.writeAndSave(target, output.text, signal); signal.throwIfAborted();
      const checked = await this.verifyDocument({ ...session, desktop: target }, output.text, signal); signal.throwIfAborted();
      run.uiReadbackMatched = checked.ui; run.fileReadbackMatched = checked.file; run.fileSha256 = checked.fileSha256;
      run.state = "succeeded"; session.state = "ready";
    } catch (error) {
      run.state = signal.aborted ? "cancelled" : "failed"; session.state = "failed";
      run.error = signal.aborted ? "teach_run_cancelled_or_timed_out" : error instanceof Error ? error.message : "teach_run_failed";
      session.error = run.error;
    } finally {
      clearTimeout(stop); run.stoppedAt = time();
      await browser.close().catch(() => {});
      try { writeJsonAtomic(path.join(directory, "report.json"), run); this.save(session); }
      finally { await active.release(); if (this.running === active) this.running = null; }
    }
  }
  cancel(id: string): Promise<TeachSession> {
    if (this.running?.session.id === id) {
      const running = this.running; running.controller.abort();
      void running.browser.close().catch(() => {});
      return running.promise.then(() => this.get(id));
    }
    return this.serialize(async () => {
      if (!this.active || this.active.session.id !== id) throw new RecordingError(409, "teach_state_conflict");
      const active = this.active; await this.failRecording(active, new Error("teach_cancelled"));
      active.session.state = "cancelled"; this.save(active.session); return this.get(id);
    });
  }
  private async failRecording(active: ActiveTeach, error: unknown): Promise<void> {
    const session = active.session; session.state = "failed"; session.stoppedAt = time();
    session.error = error instanceof Error ? error.message : "teach_recording_failed";
    try {
      const child = session.segments.find(segment => segment.backend === "windows_notepad" && segment.state === "recording");
      if (child?.recordingId) await this.options.recordings.control(child.recordingId, "stop").catch(() => {});
      for (const segment of session.segments) if (segment.state === "recording") { segment.state = "failed"; segment.stoppedAt = time(); segment.missing.push(session.error); }
      this.save(session);
    } finally { await active.browser.close().catch(() => {}); await active.release(); if (this.active === active) this.active = null; }
  }
  async recording(id: string) {
    const session = this.get(id), child = session.segments.find(segment => segment.recordingId);
    if (!child?.recordingId) throw new RecordingError(404, "teach_desktop_recording_missing");
    return this.options.recordings.get(child.recordingId);
  }
  async media(id: string) {
    const recording = await this.recording(id);
    return this.options.recordings.openMedia(recording.id, "recording");
  }
  delete(id: string): Promise<void> { return this.serialize(async () => {
    const session = this.get(id);
    if (capturing(session) || this.running?.session.id === id) throw new RecordingError(409, "teach_busy");
    for (const segment of session.segments) if (segment.recordingId) await this.options.recordings.delete(segment.recordingId);
    fs.rmSync(this.folder(id), { recursive: true });
  }); }
  async shutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.watchdog);
    if (this.running) await this.cancel(this.running.session.id);
    await this.operations;
    if (this.active) await this.cancel(this.active.session.id);
    await this.options.recordings.shutdown();
  }
}
