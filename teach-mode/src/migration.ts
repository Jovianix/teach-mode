import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { TeachSessionSchema } from "./contracts.js";
import { TeachPlanSchema } from "./plan.js";

/** Copy, validate, then activate; the original directory is retained as backup. */
export function migrateLegacyTeachData(destination: string, legacy = path.join(os.homedir(), ".memmy", "teach-sessions")) {
  if (!fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(destination)) return false;
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) return false;
  const stage = `${destination}.import-${crypto.randomUUID()}`;
  try {
    fs.cpSync(legacy, stage, { recursive: true, filter(source) {
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error("teach_legacy_symlink_refused");
      return true;
    } });
    for (const entry of fs.readdirSync(stage, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const folder = path.join(stage, entry.name);
      const session = TeachSessionSchema.parse(JSON.parse(fs.readFileSync(path.join(folder, "session.json"), "utf8")));
      if (session.id !== entry.name) throw new Error("teach_legacy_session_mismatch");
      if (!session.planSha256) continue;
      const bytes = fs.readFileSync(path.join(folder, "plan.json"));
      if (digest(bytes) !== session.planSha256) throw new Error("teach_legacy_plan_hash_mismatch");
      const plan = TeachPlanSchema.parse(JSON.parse(bytes.toString()));
      if (digest(fs.readFileSync(path.join(folder, "web", "events.jsonl"))) !== session.segments[0]?.eventsSha256
        || digest(fs.readFileSync(path.join(stage, "recordings", plan.desktop.recordingId, "events.jsonl"))) !== plan.desktop.eventsSha256) throw new Error("teach_legacy_evidence_hash_mismatch");
    }
    fs.writeFileSync(path.join(stage, ".legacy-import.json"), JSON.stringify({ source: legacy, importedAt: new Date().toISOString() }), { mode: 0o600 });
    if (fs.existsSync(destination)) fs.rmdirSync(destination);
    fs.renameSync(stage, destination);
    return true;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
