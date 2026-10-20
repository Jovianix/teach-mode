import fs from "node:fs";
import { validateHostRelease, validateWindowsAcceptance } from "./release-validation.mjs";
const releaseFile = process.env.MEMMY_PLUGIN_RELEASE_FILE || "releases/teach-mode-0.3.0.release.json";
const release = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
validateHostRelease(release.hostRelease, release.manifest.requiredHostCapabilities, true);
if (release.dirty !== false || release.publishable !== true || !process.env.MEMMY_WINDOWS_ACCEPTANCE_REPORT) throw new Error("A clean plugin and real Windows acceptance report are required");
validateWindowsAcceptance(process.env.MEMMY_WINDOWS_ACCEPTANCE_REPORT, release);
console.log(JSON.stringify({ status: "passed", version: release.manifest.version, sourceCommit: release.sourceCommit, sha256: release.artifact.sha256 }));
