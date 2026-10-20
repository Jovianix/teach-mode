import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateHostRelease, validateWindowsAcceptance } from "../release-validation.mjs";

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
