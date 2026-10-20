import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
const root = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync(process.execPath, ["--test", "integration/plugin-host.test.mjs"], { cwd: root, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
const output = path.resolve(process.env.MEMMY_CONFORMANCE_REPORT || path.join(root, ".cache/conformance-report.json"));
mkdirSync(path.dirname(output), { recursive: true });
const host = process.env.MEMMY_HOST_KIT_DIR ? JSON.parse(readFileSync(path.join(process.env.MEMMY_HOST_KIT_DIR, "host-release.json"), "utf8")) : null;
let plugin = null;
if (process.env.MEMMY_PLUGIN_ZIP) {
  const bytes = readFileSync(process.env.MEMMY_PLUGIN_ZIP), zip = await JSZip.loadAsync(bytes);
  const manifest = JSON.parse(await zip.file("plugin.json").async("string")), build = JSON.parse(await zip.file("build.json").async("string"));
  plugin = { archive: path.basename(process.env.MEMMY_PLUGIN_ZIP), version: manifest.version, sourceCommit: build.sourceCommit,
    dirty: build.dirty, sha256: createHash("sha256").update(bytes).digest("hex") };
}
writeFileSync(output, JSON.stringify({ schema: "memmy.plugin-artifact-conformance/v1", status: result.status === 0 ? "passed" : "failed", host, plugin,
  recordedAt: new Date().toISOString(), scope: "Controlled events and drafts through the actual downloaded MCP worker and baseline Host composition. Real Windows capture and model-driven conversations require separate acceptance." }, null, 2) + "\n");
process.exitCode = result.status === 0 ? 0 : result.status || 1;
