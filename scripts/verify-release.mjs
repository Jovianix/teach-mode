import fs from "node:fs";
import { validateHostRelease, validateWindowsAcceptance, validateMacAcceptance } from "./release-validation.mjs";
const releaseFile = process.env.MEMMY_PLUGIN_RELEASE_FILE || "releases/teach-mode-0.4.1.release.json";
const release = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
validateHostRelease(release.hostRelease, release.manifest.requiredHostCapabilities, true);
if (release.dirty !== false || release.publishable !== true) throw new Error("A clean plugin and published Host are required");
for (const platform of release.manifest.platforms) {
  const report = process.env[platform === "win32" ? "MEMMY_WINDOWS_ACCEPTANCE_REPORT" : "MEMMY_MACOS_ACCEPTANCE_REPORT"];
  if (!["win32", "darwin"].includes(platform) || !report) throw new Error(`Real desktop acceptance report is required for ${platform}`);
  (platform === "win32" ? validateWindowsAcceptance : validateMacAcceptance)(report, release);
}
console.log(JSON.stringify({ status: "passed", version: release.manifest.version, sourceCommit: release.sourceCommit, sha256: release.artifact.sha256 }));
