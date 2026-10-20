import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeachSessionService } from "../src/session-service.js";
import { compileTeachWebActions, type TeachBrowser } from "../src/browser.js";
import type { TeachLocator, TeachWebAction, TeachNotepadTarget } from "../src/contracts.js";
import type { TeachRecordings, HostInvoker } from "../src/host.js";
import { createTeachPlugin } from "../src/plugin.js";
import { migrateLegacyTeachData } from "../src/migration.js";

const roots: string[] = [], services: TeachSessionService[] = [];
const url = "https://publications.test/", sourceUrl = `${url}papers`;
const locator: TeachLocator = { selector: "ol > li:nth-of-type(1)", tag: "li", name: "Original publication", heading: "Publications" };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-plugin-")); roots.push(root);
  const directory = path.join(root, "sessions"), recordingRoot = path.join(directory, "recordings");
  const data = { text: "Original publication", uiMismatch: false, diskMismatch: false, missingOutput: false, slowReplay: false, complete: true, started: 0, busy: false };
  const browsers: Array<TeachBrowser & { emit(action: Partial<TeachWebAction>): Promise<void> }> = [];
  const browser = () => {
    let append: (action: TeachWebAction) => Promise<void>, sequence = 0;
    const instance = {
      start: vi.fn(async (_url: string, _dir: string, callback: (event: TeachWebAction) => Promise<void>) => { append = callback; data.started++; }),
      pick: vi.fn(async () => {}),
      read: vi.fn(async () => { if (data.missingOutput) throw new Error("teach_output_not_unique_or_visible"); return { text: data.text, url: sourceUrl }; }),
      screenshot: vi.fn(async (file: string) => { fs.writeFileSync(file, "fixture-png"); }),
      seal: vi.fn(async () => {}), close: vi.fn(async () => {}),
      replay: vi.fn(async (_url: string, _actions: unknown, signal: AbortSignal) => {
        if (data.slowReplay) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      }),
      emit: async (action: Partial<TeachWebAction>) => append({ sequence: ++sequence, timeMs: sequence * 100, type: "click", url, locator, ...action })
    } satisfies TeachBrowser & { emit(action: Partial<TeachWebAction>): Promise<void> };
    browsers.push(instance); return instance;
  };
  const texts = new Map<string, string>();
  const notepad = {
    open: vi.fn(async (file: string): Promise<TeachNotepadTarget> => { texts.set(file, ""); return { pid: 41, hwnd: "42", processStart: "1234", executable: "C:\\Windows\\System32\\notepad.exe", file }; }),
    read: vi.fn(async (target: TeachNotepadTarget) => data.uiMismatch ? "Wrong UI" : texts.get(target.file)!),
    writeAndSave: vi.fn(async (target: TeachNotepadTarget, text: string) => { texts.set(target.file, text); fs.writeFileSync(target.file, data.diskMismatch ? "Wrong file" : text); })
  };
  const recorded = new Map<string, { id: string; state: string; timelineCompleteness: string }>();
  const recordings: TeachRecordings = {
    directory: recordingRoot,
    async start() {
      const id = crypto.randomUUID(), folder = path.join(recordingRoot, id); fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "events.jsonl"), [ { type: "text_input" }, { type: "key_press", action: { key: "Ctrl+S" } } ].map(e => JSON.stringify(e)).join("\n") + "\n");
      fs.writeFileSync(path.join(folder, "recording.mp4"), "video");
      const item = { id, state: "recording", timelineCompleteness: "complete" }; recorded.set(id, item); return item;
    },
    async get(id) { return recorded.get(id)!; },
    async control(id) { const item = recorded.get(id)!; item.state = "ready"; item.timelineCompleteness = data.complete ? "complete" : "partial"; return item; },
    async pin() {}, async delete(id) { fs.rmSync(path.join(recordingRoot, id), { recursive: true }); },
    async openMedia(id) { return { path: path.join(recordingRoot, id, "recording.mp4"), type: "video/mp4", size: 5 }; }, async shutdown() {}
  };
  const gate = { async acquire() { if (data.busy) throw new Error("collector_busy"); data.busy = true; return async () => { data.busy = false; }; } };
  const options = { directory, outputDirectory: path.join(root, "notes"), recordings, browser, notepad, gate, supported: true };
  const service = new TeachSessionService(options); services.push(service);
  const start = async () => {
    const session = await service.start({ title: "Paper to Notepad", url, consent: true });
    await browsers[0]!.emit({ type: "click" }); await browsers[0]!.emit({ type: "output", url: sourceUrl });
    return service.get(session.id);
  };
  const teach = async () => { const session = await start(); const desktop = await service.toDesktop(session.id); await notepad.writeAndSave(desktop.desktop!, data.text); return service.finish(session.id); };
  const published = new Map<string, unknown>();
  const host = vi.fn(async (name: string, raw: unknown) => {
    const input = raw as Record<string, any>;
    if (name === "plugin-context") return { dataDirectory: directory, tools: { teach_session: "mcp_plugins_plugin_teach_session_test" } };
    if (name === "skills" && input.action === "publish") published.set(input.skill.name, input.skill);
    if (name === "skills" && input.action === "remove") published.delete(input.name);
    return { ok: true };
  }) as unknown as HostInvoker;
  const plugin = createTeachPlugin(host, { service, directory });
  return { root, service, options, start, teach, notepad, data, browsers, gate, plugin, published };
}
afterEach(async () => { for (const s of services.splice(0)) await s.shutdown(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("standalone teaching", () => {
  it("opening/discovering does not record and finishing publishes a plugin-owned hash-bound skill", async () => {
    const f = fixture(); await f.plugin.initialize(); expect(f.data.started).toBe(0);
    const session = await f.teach();
    await f.plugin.invoke("teach_manage", { action: "export", session_id: session.id });
    expect(f.published.has(`teach-${session.id}`)).toBe(true);
    const bundle = f.service.artifacts(session.id);
    expect(bundle.manifest.pluginId).toBe("teach-mode");
    expect(bundle.files["SKILL.md"].toString()).toContain("mcp_plugins_plugin_teach_session_test");
    expect(bundle.files["SKILL.md"].toString()).toContain(session.planSha256);
    expect(JSON.parse(bundle.files["plan.json"].toString()).web.output).not.toHaveProperty("text");
    expect(bundle.files["plan.json"]).toEqual(fs.readFileSync(path.join(f.service.directory, session.id, "plan.json")));
  });
  it("chat execution uses fresh content and verifies UI and disk independently", async () => {
    const f = fixture(), session = await f.teach(); f.data.text = "New live publication";
    const result: any = await f.plugin.invoke("teach_session", { action: "run", session_id: session.id, plan_sha256: session.planSha256, consent: true });
    expect(result.run).toMatchObject({ state: "succeeded", uiReadbackMatched: true, fileReadbackMatched: true });
    expect(fs.readFileSync(result.run.file, "utf8")).toBe("New live publication");
    expect(f.data.busy).toBe(false);
  });
  it("requires execution intent and the exact plan hash before desktop input", async () => {
    const f = fixture(), s = await f.teach(); const before = f.notepad.open.mock.calls.length;
    await expect(f.plugin.invoke("teach_session", { action: "run", session_id: s.id })).rejects.toThrow("consent");
    await expect(f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true })).rejects.toThrow("hash_required");
    await expect(f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: "f".repeat(64) })).rejects.toThrow("hash_mismatch");
    expect(f.notepad.open.mock.calls.length).toBe(before);
  });
  it("holds the collector lease across both segments and releases it on cancellation", async () => {
    const f = fixture(), s = await f.start(); expect(f.data.busy).toBe(true);
    await expect(f.gate.acquire()).rejects.toThrow("busy");
    await f.service.toDesktop(s.id); expect(f.data.busy).toBe(true);
    await f.service.cancel(s.id); expect(f.data.busy).toBe(false);
  });
  it("leaves an unsaved or mismatched demonstration open for correction", async () => {
    const f = fixture(), s = await f.start(); await f.service.toDesktop(s.id);
    await expect(f.service.finish(s.id)).rejects.toThrow("does_not_match");
    expect(f.service.get(s.id).state).toBe("recording_desktop"); expect(f.data.busy).toBe(true);
  });
  it("rejects incomplete native recording and releases the lease", async () => {
    const f = fixture(); f.data.complete = false;
    await expect(f.teach()).rejects.toThrow("recording_incomplete"); expect(f.data.busy).toBe(false);
  });
  it("does not claim success when file readback differs", async () => {
    const f = fixture(), s = await f.teach(); f.data.diskMismatch = true;
    const result: any = await f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: s.planSha256 });
    expect(result.run.state).toBe("failed"); expect(result.run.fileReadbackMatched).toBe(false);
  });
  it("does not launch Notepad when the live output is missing", async () => {
    const f = fixture(), s = await f.teach(); f.data.missingOutput = true; const before = f.notepad.open.mock.calls.length;
    const result: any = await f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: s.planSha256 });
    expect(result.run.state).toBe("failed"); expect(f.notepad.open.mock.calls.length).toBe(before);
  });
  it("creates a distinct file for each execution", async () => {
    const f = fixture(), s = await f.teach();
    const first: any = await f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: s.planSha256 });
    f.data.text = "Changed";
    const second: any = await f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: s.planSha256 });
    expect(second.run.file).not.toBe(first.run.file); expect(fs.readFileSync(first.run.file, "utf8")).toBe("Original publication");
  });
  it("aborting a chat call cancels its execution", async () => {
    const f = fixture(), s = await f.teach(), controller = new AbortController(); f.data.slowReplay = true;
    const run = f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: s.planSha256 }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
    expect((await run as any).run.state).toBe("cancelled"); expect(f.data.busy).toBe(false);
  });
  it("rejects tampered plans and exports", async () => {
    const f = fixture(), s = await f.teach(), bundle = f.service.artifacts(s.id);
    fs.appendFileSync(path.join(bundle.directory, "SKILL.md"), "tampered");
    await expect(f.plugin.invoke("teach_session", { action: "run", session_id: s.id, consent: true, plan_sha256: s.planSha256 })).rejects.toThrow("integrity");
    await f.service.export(s.id); fs.appendFileSync(path.join(f.service.directory, s.id, "plan.json"), " ");
    await expect(f.service.run(s.id, true)).rejects.toThrow("integrity");
  });
  it("recovers interrupted sessions without restarting recording", async () => {
    const f = fixture(), s = await f.start(); await f.service.shutdown();
    const file = path.join(f.service.directory, s.id, "session.json"), session = JSON.parse(fs.readFileSync(file, "utf8"));
    session.state = "recording_web"; fs.writeFileSync(file, JSON.stringify(session));
    const restored = new TeachSessionService(f.options); services.push(restored);
    expect(restored.get(s.id).state).toBe("failed"); expect(f.data.started).toBe(1);
  });
  it("deletion removes generated registration and keeps saved output files", async () => {
    const f = fixture(), s = await f.teach(); await f.plugin.invoke("teach_manage", { action: "export", session_id: s.id });
    const note = f.service.get(s.id).desktop!.file;
    await f.plugin.invoke("teach_manage", { action: "delete", session_id: s.id });
    expect(f.published.size).toBe(0); expect(fs.existsSync(note)).toBe(true);
  });
  it("copies and validates legacy evidence while retaining the original backup", async () => {
    const f = fixture(), s = await f.teach(), destination = path.join(f.root, "imported");
    const bytes = fs.readFileSync(path.join(f.service.directory, s.id, "session.json"));
    expect(migrateLegacyTeachData(destination, f.service.directory)).toBe(true);
    expect(fs.readFileSync(path.join(destination, s.id, "session.json"))).toEqual(bytes);
    expect(fs.readFileSync(path.join(f.service.directory, s.id, "session.json"))).toEqual(bytes);
    expect(migrateLegacyTeachData(destination, f.service.directory)).toBe(false);
  });
  it("does not activate corrupted legacy evidence", async () => {
    const f = fixture(), s = await f.teach(), destination = path.join(f.root, "imported");
    fs.appendFileSync(path.join(f.service.directory, s.id, "plan.json"), "corruption");
    expect(() => migrateLegacyTeachData(destination, f.service.directory)).toThrow("hash_mismatch");
    expect(fs.existsSync(destination)).toBe(false);
  });
  it("compiles input changes without losing output provenance", () => {
    const output = { name: "note_text" as const, sourceUrl, locator, text: "text", sha256: "a".repeat(64), observedAt: new Date().toISOString(), evidence: "web/output-1.png" };
    expect(compileTeachWebActions([{ sequence: 1, timeMs: 1, type: "click", url, locator }, { sequence: 2, timeMs: 2, type: "output", url: sourceUrl, locator }], output)).toHaveLength(1);
  });
});
