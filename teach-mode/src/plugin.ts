import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { TeachStartSchema, type TeachSession } from "./contracts.js";
import { TeachSessionService } from "./session-service.js";
import { createHostAdapters, type HostInvoker } from "./host.js";
import { PlaywrightTeachBrowser } from "./browser.js";
import { WindowsTeachNotepad } from "./notepad.js";
import { defaultTeachDirectory, setTeachInvocationTool } from "./artifacts.js";
import { migrateLegacyTeachData } from "./migration.js";

const Input = z.object({ action: z.string(), session_id: z.string().uuid().optional(), title: z.string().optional(),
  url: z.string().optional(), plan_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), consent: z.boolean().optional() }).strict();
export function createTeachPlugin(host: HostInvoker, options: { service?: TeachSessionService; directory?: string; migrate?: boolean } = {}) {
  let initialization: Promise<TeachSessionService> | null = null;
  let service: TeachSessionService | null = options.service ?? null;
  let closing = false;
  const publish = async (current: TeachSessionService, id: string) => {
    const bundle = current.artifacts(id);
    await host("skills", { action: "publish", skill: { name: bundle.manifest.skillName, directory: bundle.directory,
      files: Object.fromEntries(Object.entries(bundle.files).map(([name, bytes]) => [name, digest(bytes)])),
      checks: { [`${id}/plan.json`]: bundle.manifest.planSha256 } } });
  };
  const initialize = () => initialization ??= (async () => {
    const context = await host<{ dataDirectory: string; tools: Record<string, string>; config?: { outputDirectory?: string } }>("plugin-context", {});
    const directory = options.directory ?? context.dataDirectory ?? defaultTeachDirectory();
    if (context.tools.teach_session) setTeachInvocationTool(context.tools.teach_session);
    if (!service) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (options.migrate !== false) migrateLegacyTeachData(directory);
      const adapters = createHostAdapters(host, directory);
      const outputDirectory = context.config?.outputDirectory;
      if (outputDirectory && !path.isAbsolute(outputDirectory)) throw new Error("teach_output_directory_must_be_absolute");
      service = new TeachSessionService({ directory, outputDirectory, ...adapters,
        browser: () => new PlaywrightTeachBrowser(), supported: process.platform === "win32",
        notepad: new WindowsTeachNotepad((pid, hwnd) => host("window-focus", { pid, hwnd })) });
    }
    for (const session of service.list()) {
      if (!session.planSha256 || !["ready", "failed"].includes(session.state)) continue;
      try {
        const manifest = path.join(service.directory, session.id, "exports", session.planSha256, "manifest.json");
        if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).schema === "memmy.teach-export/v1") await service.export(session.id);
        await publish(service, session.id);
      } catch { /* Invalid evidence remains visible in the panel, never in skill discovery. */ }
    }
    return service;
  })();
  return {
    initialize,
    async shutdown() { closing = true; if (initialization) await initialization.catch(() => undefined); await service?.shutdown(); },
    async invoke(capability: string, raw: unknown, signal?: AbortSignal) {
      if (closing) throw new Error("teach_plugin_stopping");
      const current = await initialize(), input = Input.parse(raw); signal?.throwIfAborted();
      const id = input.session_id;
      if (capability === "teach_session") {
        if (input.action === "list") return { sessions: current.list().filter(s => { try { current.artifacts(s.id); return true; } catch { return false; } }).map(s => status(s)) };
        if (!id) throw new Error("teach_session_id_required");
        if (input.action === "get") return status(current.get(id));
        if (input.action === "cancel") return status(await current.cancel(id));
        if (input.action !== "run" || input.consent !== true) throw new Error("teach_execution_consent_required");
        if (!input.plan_sha256) throw new Error("teach_plan_hash_required");
        current.artifacts(id);
        const started = await current.run(id, true, input.plan_sha256), runId = started.runs.at(-1)!.id;
        return status(await current.waitForRun(id, runId, signal), runId);
      }
      if (capability !== "teach_manage") throw new Error("Unknown teaching capability");
      if (input.action === "configuration") return current.configuration();
      if (input.action === "list") return { sessions: current.list() };
      if (input.action === "start") return current.start(TeachStartSchema.parse({ title: input.title, url: input.url, consent: input.consent }));
      if (!id) throw new Error("teach_session_id_required");
      if (input.action === "get") return current.get(id);
      if (input.action === "pick-output") return current.pick(id);
      if (input.action === "desktop") return current.toDesktop(id);
      if (input.action === "cancel") return current.cancel(id);
      if (input.action === "run") {
        if (input.consent !== true || !input.plan_sha256) throw new Error("teach_execution_consent_and_hash_required");
        return current.run(id, true, input.plan_sha256);
      }
      if (input.action === "finish" || input.action === "export") {
        const session = await (input.action === "finish" ? current.finish(id) : current.export(id));
        if (session.artifactExport?.state === "ready") await publish(current, id);
        return session;
      }
      if (input.action === "delete") { await current.delete(id); await host("skills", { action: "remove", name: `teach-${id}` }); return { deleted: true }; }
      if (input.action === "preview") {
        const session = current.get(id); if (!session.output) throw new Error("teach_output_missing");
        const file = path.join(current.directory, id, session.output.evidence);
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4_000_000) throw new Error("teach_preview_invalid");
        return { dataUrl: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}` };
      }
      if (input.action === "recording") return current.recording(id);
      if (input.action === "bundle") {
        const file = path.join(current.directory, id, "exports", `${id}.zip`); fs.writeFileSync(file, await current.bundle(id), { mode: 0o600 });
        return artifact(file, `teach-${id}.zip`, "application/zip");
      }
      if (input.action === "video") {
        const media = await current.media(id); return artifact(media.path, "demonstration.mp4", media.type);
      }
      throw new Error("Unknown teaching action");
    }
  };
}
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
function artifact(file: string, name: string, mediaType: string) {
  return { schema: "memmy.capability-events/v1", events: [{ type: "artifact", artifact: { id: crypto.randomUUID(), name, mediaType, uri: pathToFileURL(file).href } }, { type: "result", output: { ready: true } }] };
}
function status(session: TeachSession, runId?: string) {
  const run = runId ? session.runs.find(r => r.id === runId) : session.runs.at(-1);
  return { session_id: session.id, title: session.title, state: session.state, plan_sha256: session.planSha256,
    skill_name: session.artifactExport?.state === "ready" ? session.artifactExport.skillName : null,
    runtime: session.runtime, openadaptAdmission: session.openadaptAdmission, error: session.error,
    run: run ? { id: run.id, state: run.state, file: run.file, outputSha256: run.outputSha256, fileSha256: run.fileSha256,
      uiReadbackMatched: run.uiReadbackMatched, fileReadbackMatched: run.fileReadbackMatched, error: run.error } : null };
}
