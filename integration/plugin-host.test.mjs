import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";

function required(name) { const value = process.env[name]; if (!value) throw new Error(`Required acceptance artifact input is missing: ${name}`); return value; }
const kitRoot = path.resolve(required("MEMMY_HOST_KIT_DIR"));
const archiveFile = path.resolve(required("MEMMY_PLUGIN_ZIP"));
const archive = fs.readFileSync(archiveFile), sha256 = createHash("sha256").update(archive).digest("hex");
assert.equal(sha256, required("MEMMY_PLUGIN_SHA256"), "Pinned plugin SHA-256 mismatch");
const kit = await import(pathToFileURL(path.join(kitRoot, "host-kit.mjs")));
const hostRelease = JSON.parse(fs.readFileSync(path.join(kitRoot, "host-release.json"), "utf8"));
assert.equal(hostRelease.version, kit.MEMMY_VERSION); assert.equal(hostRelease.platform, process.platform);
if (hostRelease.dirty !== false && process.env.MEMMY_ALLOW_DIRTY_HOST !== "1") throw new Error("Acceptance requires a committed Host artifact");
const zip = await JSZip.loadAsync(archive), manifest = kit.PluginManifestSchema.parse(JSON.parse(await zip.file("plugin.json").async("string")));
const build = JSON.parse(await zip.file("build.json").async("string"));
assert.match(build.sourceCommit, /^[a-f0-9]{40}$/);
if (build.dirty !== false && process.env.MEMMY_ALLOW_DIRTY_PLUGIN !== "1") throw new Error("Acceptance requires a committed plugin artifact");
assert.equal(manifest.id, "teach-mode"); assert.equal(manifest.minimumHostVersion, hostRelease.version);
assert.ok(manifest.requiredHostCapabilities.every(feature => hostRelease.capabilities.includes(feature)));
assert.equal(manifest.ui?.surface, undefined);

async function fixture(t, behavior = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-artifact-conformance-"));
  const stream = path.join(root, "source.jsonl"); fs.writeFileSync(stream, "");
  let downloads = 0, subscribers = 0;
  const release = { manifest, artifact: { url: `/artifacts/teach-mode-${manifest.version}.zip`, sha256 }, nativeExecutionAllowed: true };
  const registry = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.local");
    if (url.pathname === "/api/v1/plugins/catalog") return response.end(JSON.stringify([{ id: manifest.id, name: manifest.name, description: manifest.description,
      version: manifest.version, platforms: manifest.platforms, minimumHostVersion: manifest.minimumHostVersion, installMode: "manual", updateMode: "automatic" }]));
    if (url.pathname === "/api/v1/plugins/teach-mode") return response.end(JSON.stringify(release));
    downloads++;
    if (behavior.downloadFailure) return response.writeHead(503).end();
    response.end(behavior.corrupt ? Buffer.from("invalid archive") : archive);
  });
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
  let harness;
  t.after(async () => { if (harness) await harness.close(); await new Promise(resolve => registry.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  harness = kit.createPluginHostHarness({ root, registryUrl: `http://127.0.0.1:${registry.address().port}`, platform: "win32",
    source: { async acquireEventCapture() {
      subscribers++; let released = false;
      return { checkpoint: async () => ({ running: !released, complete: true, limitations: ["Controlled conformance events; not a real Windows recording"],
        streams: [{ id: "fixture", file: stream, size: fs.statSync(stream).size }] }),
        async release() { if (!released) { released = true; subscribers--; } } };
    } } });
  await harness.start(); let calls = 0;
  const invoke = async (capabilityId, input, conversationId = "chat-a") => {
    for await (const event of harness.plugins.invoke({ callId: `fixture-${++calls}`, pluginId: "teach-mode", capabilityId, conversationId, input })) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "result") return event.output;
    }
    throw new Error("Missing terminal capability result");
  };
  const install = async () => { const record = await harness.plugins.install("teach-mode", manifest.version); await harness.plugins.approvePermissions(record.id, record.manifest.permissions); await harness.plugins.enable(record.id); return record; };
  const append = text => fs.appendFileSync(stream, JSON.stringify({ recordType: "human_event", sequence: 1, eventType: "text_input", timestamp: new Date().toISOString(),
    application: { name: "Controlled editor" }, details: { text } }) + "\n");
  return { ...harness, root, invoke, install, append, downloads: () => downloads, subscribers: () => subscribers };
}
const draft = { name: "recorded-note", description: "Save the user requested note and verify the resulting file", goal: "Save a note", prerequisites: [],
  parameters: [{ name: "note", description: "The requested note" }], steps: [{ instruction: "Write the requested note using write_file", evidenceIndexes: [0] }],
  tools: ["write_file", "read_file"], completionChecks: ["Read and compare the actual file"], limitations: [] };

test("anonymous install and repeated clicks retain permission approval and one download", async t => {
  const f = await fixture(t);
  assert.equal(f.store.repositories.accountSession.get().authenticated, false);
  const installed = await Promise.all([f.plugins.install(manifest.id), f.plugins.install(manifest.id)]);
  assert.deepEqual(installed.map(p => p.state), ["pending_approval", "pending_approval"]); assert.equal(f.downloads(), 1);
  await assert.rejects(f.plugins.enable(manifest.id), /permission/i);
  await f.plugins.approvePermissions(manifest.id, []); await assert.rejects(f.plugins.enable(manifest.id), /permission/i);
  await f.plugins.approvePermissions(manifest.id, manifest.permissions); await f.plugins.enable(manifest.id);
  assert.equal((await f.invoke("teach_session", { action: "list" })).sessions.length, 0);
  assert.equal(f.subscribers(), 0, "Loading the plugin must not start recording");
});

test("recording and generation are separate, conversation scoped, and use the actual Host Skill Creator validator", async t => {
  const f = await fixture(t); await f.install();
  await f.invoke("record_and_replay", { action: "status" }); assert.equal(f.subscribers(), 0);
  const first = await f.invoke("record_and_replay", { action: "start", goal: "Save a note", consent: true }, "websocket:chat-a");
  const second = await f.invoke("record_and_replay", { action: "start", goal: "Another note", consent: true }, "chat-b");
  assert.equal(first.conversationId, "chat-a"); assert.equal(f.subscribers(), 2);
  await assert.rejects(f.plugins.update(manifest.id, "0.3.1"), /deferred|recording|executing/i);
  f.append("Recorded example note");
  const ended = await f.invoke("record_and_replay", { action: "stop", session_id: first.id });
  assert.equal(ended.state, "ready"); assert.equal(ended.eventCount, 1); assert.equal(f.subscribers(), 1);
  assert.ok(ended.presentation.actions[0].prompt.includes(first.id)); assert.equal(f.loader.listSkills(false).some(skill => skill.name === draft.name), false);
  await assert.rejects(f.invoke("record_and_replay", { action: "read", session_id: first.id }, "chat-b"), /conversation/);
  await f.invoke("record_and_replay", { action: "cancel", session_id: second.id }, "chat-b"); assert.equal(f.subscribers(), 0);
  const prepared = await f.invoke("create_skill", { action: "prepare", session_id: first.id }); assert.match(prepared.skillCreator.instructions, /# Skill Creator/);
  const saved = await f.invoke("create_skill", { action: "save", session_id: first.id, events_sha256: ended.eventsSha256, generate: true, draft });
  assert.equal(saved.saved, true); assert.equal(saved.execution, "not_run");
  const generated = f.loader.listSkills(false).find(skill => skill.name === draft.name); assert.ok(generated);
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const validation = spawnSync(python, [f.skillCreatorValidator, path.dirname(generated.path)], { encoding: "utf8" });
  assert.equal(validation.status, 0, String(validation.stdout) + String(validation.stderr));
});

test("disable and uninstall release active captures, withdraw contributions, and reinstall restores retained skills", async t => {
  const f = await fixture(t); await f.install();
  const first = await f.invoke("record_and_replay", { action: "start", goal: "Retain a reusable note", consent: true }); f.append("Example note");
  const ended = await f.invoke("record_and_replay", { action: "stop", session_id: first.id });
  await f.invoke("create_skill", { action: "save", session_id: first.id, events_sha256: ended.eventsSha256, generate: true, draft });
  const active = await f.invoke("record_and_replay", { action: "start", goal: "Interrupted task", consent: true });
  await f.plugins.disable(manifest.id); assert.equal(f.subscribers(), 0); assert.equal(f.loader.listSkills(false).some(skill => skill.name === draft.name), false);
  const interrupted = JSON.parse(fs.readFileSync(path.join(f.root, "plugin-data", manifest.id, "event-sessions", active.id, "session.json"), "utf8")); assert.equal(interrupted.state, "failed");
  await f.plugins.enable(manifest.id); assert.ok(f.loader.listSkills(false).some(skill => skill.name === draft.name));
  await f.plugins.uninstall(manifest.id); assert.equal(f.loader.listSkills(false).some(skill => skill.name === draft.name), false);
  assert.ok(fs.existsSync(path.join(f.root, "plugin-data", manifest.id, "generated-skills", draft.name, "SKILL.md")));
  await f.install(); assert.ok(f.loader.listSkills(false).some(skill => skill.name === draft.name));
});

for (const behavior of [{ downloadFailure: true }, { corrupt: true }]) test(`failed download or checksum leaves no installed plugin: ${JSON.stringify(behavior)}`, async t => {
  const f = await fixture(t, behavior); await assert.rejects(f.plugins.install(manifest.id)); assert.equal(f.plugins.list().length, 0); assert.equal(f.subscribers(), 0);
});
