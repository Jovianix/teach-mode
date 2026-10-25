import fs from "node:fs";
import { sha256 } from "./pinned-artifacts.mjs";
const base = new URL(process.env.MEMMY_PLUGIN_REGISTRY_URL || "");
if (base.protocol !== "https:") throw new Error("Published Registry verification requires HTTPS");
const expected = JSON.parse(fs.readFileSync(process.env.MEMMY_PLUGIN_RELEASE_FILE || "releases/teach-mode-0.4.1.release.json", "utf8"));
async function read(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Anonymous Registry read failed: HTTP ${response.status}`); return response;
}
const catalog = await (await read(new URL("/api/v1/plugins", base))).json();
const item = catalog.find(item => item.id === expected.manifest.id && item.version === expected.manifest.version);
if (!item || item.minimumHostVersion !== expected.manifest.minimumHostVersion
  || JSON.stringify([...(item.platforms ?? [])].sort()) !== JSON.stringify([...expected.manifest.platforms].sort())) throw new Error("Published catalog does not match the release");
const release = await (await read(new URL(`/api/v1/plugins/${expected.manifest.id}?version=${expected.manifest.version}`, base))).json();
if (release.artifact.sha256 !== expected.artifact.sha256 || release.nativeExecutionAllowed !== true || release.sourceCommit !== expected.sourceCommit) throw new Error("Published release provenance does not match");
const archive = Buffer.from(await (await read(new URL(release.artifact.url, base))).arrayBuffer());
if (sha256(archive) !== expected.artifact.sha256) throw new Error("Published artifact SHA-256 mismatch");
console.log(JSON.stringify({ status: "passed", anonymous: true, registry: base.origin, version: expected.manifest.version, sha256: expected.artifact.sha256 }));
