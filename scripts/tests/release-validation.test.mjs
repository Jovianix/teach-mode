import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateHostRelease, validateWindowsAcceptance, validateMacAcceptance, acceptanceChecks, macAcceptanceChecks } from "../release-validation.mjs";
import { sha256 } from "../pinned-artifacts.mjs";

const host = () => ({ schema: "memmy.plugin-host-release/v1", version: "1.2.3-rc.8", sourceCommit: "a".repeat(40), dirty: false,
  capabilities: ["memmy.host-service/v1"], nodeMajor: 22, release: { url: "https://github.com/example/host/releases/tag/v1.2.3-rc.8", tag: "v1.2.3-rc.8", publishedAt: "2026-10-20T00:00:00Z" } });
test("release builds require explicit clean provenance, complete capabilities and published matching tags", () => {
  assert.equal(validateHostRelease(host(), ["memmy.host-service/v1"], true).version, "1.2.3-rc.8");
  for (const modified of [{ ...host(), dirty: undefined }, { ...host(), dirty: true }, { ...host(), release: null },
    { ...host(), capabilities: [] }, { ...host(), release: { ...host().release, tag: "v1.2.3-rc.7" } },
    { ...host(), release: { ...host().release, publishedAt: "invalid" } }]) {
    assert.throws(() => validateHostRelease(modified, ["memmy.host-service/v1"], true));
  }
});
test("a committed development Host remains valid for conformance without becoming publishable", () => {
  assert.doesNotThrow(() => validateHostRelease({ ...host(), release: null }, ["memmy.host-service/v1"]));
  assert.throws(() => validateHostRelease({ ...host(), release: null }, ["memmy.host-service/v1"], true));
});
test("a controlled Windows Node smoke report cannot pass real Windows acceptance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-release-gate-"));
  try {
    const file = path.join(root, "report.json");
    fs.writeFileSync(file, JSON.stringify({ schema: "memmy.windows-host-node-smoke/v1", status: "passed", platform: "win32", realDesktopCapture: false, modelDrivenConversation: false }));
    assert.throws(() => validateWindowsAcceptance(file, {}), /Real Windows acceptance/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Synthetic reports test the publication contract; they are not acceptance evidence.
function acceptanceFixture(platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-platform-contract-"));
  const release = { hostRelease: host(), sourceCommit: "b".repeat(40), manifest: { version: "0.4.0" }, artifact: { sha256: "c".repeat(64) } };
  const user = phase => ({ kind: "user", phase, messageId: `user-${phase}` });
  const tool = (capabilityId, input) => ({ kind: "tool", pluginId: "teach-mode", capabilityId, input });
  const trace = [user("invoke"), user("start"), tool("record_and_replay", { action: "start", consent: true }),
    user("stop"), tool("record_and_replay", { action: "stop" }), user("generate"), tool("create_skill", { action: "save" }), user("trial"),
    { kind: "model", provider: "unit", model: "fixture", requestId: "controlled-fixture" }].map((event, index) => ({ sequence: index + 1, ...event }));
  const events = Buffer.from('{}\n'), skill = Buffer.from('name: unit-skill\n'), output = Buffer.from('unit output');
  const entries = {
    "conversation-trace": Buffer.from(JSON.stringify(trace)), "capture-events": events, skill, "output-file": output, screenshot: Buffer.from('unit-image-fixture'),
    "capture-boundaries": Buffer.from(JSON.stringify({ source: "computer-history/native", sessionId: "one", eventCount: 1, eventsSha256: sha256(events), checkpoints: { start: { complete: true }, stop: { complete: true } } })),
    "execution-result": Buffer.from(JSON.stringify({ status: "passed", userMessageId: "user-trial", sessionId: "one", skillSha256: sha256(skill) })),
    "output-verification": Buffer.from(JSON.stringify({ independent: true, editorMatches: true, expectedSha256: sha256(output), actualSha256: sha256(output) })),
  };
  const report = { schema: `memmy.teach-mode-${platform === "darwin" ? "macos" : "windows"}-acceptance/v1`, status: "passed",
    platform: { os: platform, arch: platform === "darwin" ? "arm64" : "x64" },
    runtime: { bundledHostNode: true, systemNodeInstalled: false, installedApplication: true, nativeAppAgent: platform === "darwin" },
    host: { version: release.hostRelease.version, sourceCommit: release.hostRelease.sourceCommit },
    plugin: { version: release.manifest.version, sourceCommit: release.sourceCommit, sha256: release.artifact.sha256 },
    checks: Object.fromEntries((platform === "darwin" ? macAcceptanceChecks : acceptanceChecks).map(key => [key, true])),
    evidence: Object.entries(entries).map(([kind, bytes]) => { const file = kind + '.bin'; fs.writeFileSync(path.join(root, file), bytes); return { kind, file, sha256: sha256(bytes) }; }) };
  const file = path.join(root, 'report.json');
  const save = () => fs.writeFileSync(file, JSON.stringify(report)); save();
  return { root, release, report, file, save };
}
test("platform gates require matching desktop, app identity, permissions and unchanged evidence", () => {
  for (const platform of ["win32", "darwin"]) {
    const f = acceptanceFixture(platform), validate = platform === "darwin" ? validateMacAcceptance : validateWindowsAcceptance;
    try {
      assert.equal(validate(f.file, f.release).platform.os, platform);
      if (platform === "darwin") {
        assert.throws(() => validateWindowsAcceptance(f.file, f.release), /Real Windows/);
        f.report.runtime.nativeAppAgent = false; f.save(); assert.throws(() => validate(f.file, f.release), /app-agent/);
        f.report.runtime.nativeAppAgent = true; f.report.checks.macPermissionRecovery = false; f.save(); assert.throws(() => validate(f.file, f.release), /matrix is incomplete/);
        f.report.checks.macPermissionRecovery = true; f.save();
      }
      fs.appendFileSync(path.join(f.root, 'capture-events.bin'), 'changed');
      assert.throws(() => validate(f.file, f.release), /has changed/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
