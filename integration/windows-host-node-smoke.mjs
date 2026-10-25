import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import JSZip from "jszip";

assert.equal(process.platform, "win32", "This smoke test runs on actual Windows");
assert.notEqual(path.basename(process.execPath).toLowerCase(), "node.exe", "Run with the bundled Host executable in Electron Node mode");
assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
const input = name => { if (!process.env[name]) throw new Error(`Missing ${name}`); return process.env[name]; };
const kit = await import(pathToFileURL(path.join(input("MEMMY_HOST_KIT_DIR"), "host-kit.mjs")));
const bytes = fs.readFileSync(input("MEMMY_PLUGIN_ZIP")), hash = createHash("sha256").update(bytes).digest("hex");
assert.equal(hash, input("MEMMY_PLUGIN_SHA256"));
const zip = await JSZip.loadAsync(bytes), manifest = JSON.parse(await zip.file("plugin.json").async("string"));
assert.ok(!Object.keys(zip.files).some(name => name.startsWith("ui/")));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-host-node-smoke-"));
const stream = path.join(root, "source.jsonl"); fs.writeFileSync(stream, "");
let subscribers = 0, downloads = 0, harness;
const release = { manifest, artifact: { url: "/plugin.zip", sha256: hash }, nativeExecutionAllowed: true };
const registry = createServer((request, response) => {
  if (request.url.startsWith("/api/v1/plugins/teach-mode")) return response.end(JSON.stringify(release));
  if (request.url.startsWith("/api/v1/plugins")) return response.end("[]");
  downloads++; response.end(bytes);
});
await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
const report = { schema: "memmy.windows-host-node-smoke/v1", status: "failed", hostCodeVersion: kit.MEMMY_VERSION,
  platform: process.platform, runtime: { executable: path.basename(process.execPath), node: process.versions.node, electron: process.versions.electron,
    systemNodeRequired: false, pathContainsSystemNode: /nodejs|\\nvm\\/i.test(process.env.Path || process.env.PATH || "") },
  plugin: { version: manifest.version, sha256: hash }, source: "controlled event fixture", realDesktopCapture: false, modelDrivenConversation: false };
try {
  harness = kit.createPluginHostHarness({ root, registryUrl: `http://127.0.0.1:${registry.address().port}`, platform: "win32",
    source: { async acquireEventCapture() { subscribers++; let released = false; return {
      checkpoint: async () => ({ running: !released, complete: true, limitations: ["Controlled smoke-test events"], streams: [{ id: "fixture", file: stream, size: fs.statSync(stream).size }] }),
      async release() { if (!released) { released = true; subscribers--; } }
    }; } } });
  await harness.start(); assert.equal(harness.store.repositories.accountSession.get().authenticated, false);
  const installed = await harness.plugins.install(manifest.id, manifest.version);
  await harness.plugins.approvePermissions(manifest.id, installed.manifest.permissions); await harness.plugins.enable(manifest.id);
  assert.equal(subscribers, 0);
  let serial = 0;
  const invoke = async (capabilityId, input) => {
    for await (const event of harness.plugins.invoke({ callId: `smoke-${++serial}`, pluginId: manifest.id, capabilityId, conversationId: "websocket:smoke-chat", input })) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "result") return event.output;
    }
    throw new Error("Missing plugin result");
  };
  const session = await invoke("record_and_replay", { action: "start", goal: "Save a controlled note", consent: true });
  fs.appendFileSync(stream, JSON.stringify({ recordType: "human_event", sequence: 1, eventType: "text_input", timestamp: new Date().toISOString(), application: { name: "Controlled editor" }, details: { text: "A controlled example" } }) + "\n");
  const ended = await invoke("record_and_replay", { action: "stop", session_id: session.id }); assert.equal(ended.eventCount, 1); assert.equal(subscribers, 0);
  await invoke("create_skill", { action: "prepare", session_id: session.id });
  const saved = await invoke("create_skill", { action: "save", session_id: session.id, events_sha256: ended.eventsSha256, generate: true,
    draft: { name: "windows-smoke-note", description: "Save and verify the requested user note", goal: "Save a note", prerequisites: [], parameters: [{ name: "note", description: "Requested note" }],
      steps: [{ instruction: "Save the requested note with write_file and read it back", evidenceIndexes: [0] }], tools: ["write_file", "read_file"], completionChecks: ["Read back and compare the file"], limitations: [] } });
  assert.equal(saved.execution, "not_run"); assert.ok(harness.loader.listSkills(false).some(skill => skill.name === "windows-smoke-note"));
  await harness.plugins.disable(manifest.id); await harness.plugins.uninstall(manifest.id);
  assert.ok(fs.existsSync(path.join(root, "plugin-data", manifest.id, "generated-skills/windows-smoke-note/SKILL.md")));
  Object.assign(report, { status: "passed", anonymousInstall: true, downloads, captureLifecycle: true, skillSaved: true, userDataRetained: true });
} catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await harness?.close(); await new Promise(resolve => registry.close(resolve));
  report.recordedAt = new Date().toISOString(); fs.writeFileSync(input("MEMMY_HOST_NODE_REPORT"), JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
