import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./pinned-artifacts.mjs";

const commit = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const version = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
function requireValue(condition, message) { if (!condition) throw new Error(message); }

export function validateHostRelease(host, capabilities, published = false) {
  requireValue(host?.schema === "memmy.plugin-host-release/v1" && version(host.version) && commit(host.sourceCommit)
    && typeof host.dirty === "boolean" && host.nodeMajor === 22 && Array.isArray(host.capabilities)
    && capabilities.every(feature => host.capabilities.includes(feature)), "A compatible, traceable Host release descriptor is required");
  if (published) {
    let address; try { address = new URL(host.release?.url); } catch { /* Report one actionable publication error below. */ }
    requireValue(host.dirty === false && address?.protocol === "https:" && !address.username && !address.password
      && typeof host.release?.publishedAt === "string" && Number.isFinite(Date.parse(host.release.publishedAt))
      && host.release?.tag?.replace(/^v/, "") === host.version, "Publishing requires a clean, published Host release and a matching version tag");
  }
  return host;
}

export const acceptanceChecks = ["anonymousInstall", "permissionDenied", "downloadFailure", "checksumFailure", "duplicateInstall",
  "invocationDoesNotRecord", "explicitStartConsent", "stopDoesNotGenerate", "separateGeneration", "separateTrial",
  "realDesktopCapture", "modelDrivenConversation", "independentOutputVerification", "conversationIsolation", "refreshRecovery",
  "historyIntentPreserved", "otherRecorderExcluded", "cancelCleanup", "workerCrashCleanup", "hostCrashCleanup",
  "disableCleanup", "uninstallCleanup", "migrationPreservesBackup", "reinstallRestoresSkills", "busyUpdateDeferred", "failedUpdateRollback"];

/** Gate publication on retained evidence from the actual Windows application. Fixture conformance is separate. */
export function validateWindowsAcceptance(reportFile, release) {
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  requireValue(report.schema === "memmy.teach-mode-windows-acceptance/v1" && report.status === "passed", "Real Windows acceptance has not passed");
  requireValue(report.platform?.os === "win32" && report.platform.arch === "x64" && report.runtime?.bundledHostNode === true
    && report.runtime.systemNodeInstalled === false && report.runtime.installedApplication === true, "Acceptance must use the installed Windows Host without system Node");
  requireValue(report.host?.version === release.hostRelease?.version && report.host?.sourceCommit === release.hostRelease?.sourceCommit
    && report.plugin?.version === release.manifest.version && report.plugin?.sourceCommit === release.sourceCommit
    && report.plugin?.sha256 === release.artifact.sha256, "Acceptance versions and hashes do not match the release artifacts");
  requireValue(acceptanceChecks.every(check => report.checks?.[check] === true), "The Windows acceptance matrix is incomplete");
  const root = fs.realpathSync(path.dirname(reportFile));
  const evidence = new Map();
  for (const entry of report.evidence ?? []) {
    requireValue(typeof entry.kind === "string" && typeof entry.file === "string" && /^[a-f0-9]{64}$/.test(entry.sha256), "Invalid acceptance evidence descriptor");
    const file = fs.realpathSync(path.resolve(root, entry.file));
    const relative = path.relative(root, file);
    requireValue(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep), "Acceptance evidence must remain inside the report directory");
    const bytes = fs.readFileSync(file);
    requireValue(sha256(bytes) === entry.sha256 && bytes.length > 0 && !evidence.has(entry.kind), "Acceptance evidence is missing, duplicated or has changed");
    evidence.set(entry.kind, bytes);
  }
  for (const kind of ["conversation-trace", "capture-boundaries", "capture-events", "skill", "execution-result", "output-verification", "output-file", "screenshot"])
    requireValue(evidence.has(kind), `Missing real acceptance evidence: ${kind}`);
  const trace = JSON.parse(evidence.get("conversation-trace").toString());
  requireValue(Array.isArray(trace) && trace.every((event, index) => event.sequence === index + 1), "Conversation evidence must have an ordered trace");
  let last = 0;
  for (const phase of ["invoke", "start", "stop", "generate", "trial"]) {
    const event = trace.find(event => event.kind === "user" && event.phase === phase);
    requireValue(event && event.sequence > last && typeof event.messageId === "string" && event.messageId, `Missing separate user request: ${phase}`);
    last = event.sequence;
  }
  requireValue(trace.some(event => event.kind === "model" && event.provider && event.model && event.requestId), "Model request provenance is missing");
  const request = phase => trace.find(event => event.kind === "user" && event.phase === phase).sequence;
  const calls = trace.filter(event => event.kind === "tool" && event.pluginId === "teach-mode");
  requireValue(calls.some(event => event.capabilityId === "record_and_replay" && event.input?.action === "start" && event.input.consent === true
    && event.sequence > request("start") && event.sequence < request("stop")), "Recording did not follow the explicit start request");
  requireValue(calls.every(event => event.input?.action !== "start" || event.sequence > request("start")), "Recording began during invocation");
  requireValue(calls.some(event => event.capabilityId === "record_and_replay" && event.input?.action === "stop" && event.sequence > request("stop") && event.sequence < request("generate")), "Stop evidence is missing");
  requireValue(calls.some(event => event.capabilityId === "create_skill" && event.input?.action === "save" && event.sequence > request("generate") && event.sequence < request("trial"))
    && calls.every(event => event.capabilityId !== "create_skill" || event.sequence > request("generate")), "Generation was not a separate request");
  const boundaries = JSON.parse(evidence.get("capture-boundaries").toString());
  requireValue(boundaries.source === "computer-history/native" && boundaries.checkpoints?.start?.complete === true && boundaries.checkpoints?.stop?.complete === true
    && boundaries.eventCount > 0 && boundaries.eventsSha256 === sha256(evidence.get("capture-events")), "Real capture boundaries or event snapshot hash are unconfirmed");
  const execution = JSON.parse(evidence.get("execution-result").toString());
  const verification = JSON.parse(evidence.get("output-verification").toString());
  requireValue(execution.status === "passed" && execution.userMessageId === trace.find(event => event.kind === "user" && event.phase === "trial").messageId
    && execution.sessionId === boundaries.sessionId && execution.skillSha256 === sha256(evidence.get("skill")), "Trial does not match the separately requested generated skill");
  requireValue(verification.independent === true && verification.editorMatches === true && verification.expectedSha256 === verification.actualSha256
    && verification.actualSha256 === sha256(evidence.get("output-file")), "Independent editor and output-file verification failed");
  return report;
}
