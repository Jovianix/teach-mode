import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function descendant(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("prototype_data_path_invalid");
  return relative;
}
function verify(root: string, directory: string, files: Record<string, string>) {
  descendant(root, directory);
  for (const [name, hash] of Object.entries(files)) {
    const file = path.resolve(directory, name); descendant(directory, file);
    if (name.includes("\\") || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()
      || !/^[a-f0-9]{64}$/.test(hash) || digest(fs.readFileSync(file)) !== hash) throw new Error("prototype_data_hash_mismatch");
  }
}

/** Activate a validated copy and retain the complete prototype directory as backup. */
export function migratePrototypePluginData(destination: string, legacy?: string): boolean {
  if (!legacy || !fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(destination)) return false;
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) return false;
  const source = fs.realpathSync(legacy), stage = destination + ".prototype-import-" + randomUUID();
  if (fs.lstatSync(legacy).isSymbolicLink()) throw new Error("prototype_data_symlink_refused");
  try {
    fs.cpSync(source, stage, { recursive: true, filter(file) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("prototype_data_symlink_refused");
      return true;
    } });
    const sessions = path.join(stage, "event-sessions");
    if (fs.existsSync(sessions)) for (const id of fs.readdirSync(sessions)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("prototype_session_invalid");
      const folder = path.join(sessions, id), file = path.join(folder, "session.json");
      const session = JSON.parse(fs.readFileSync(file, "utf8"));
      if (session.id !== id || session.pluginId !== "teach-mode" || typeof session.conversationId !== "string") throw new Error("prototype_session_owner_invalid");
      if (session.eventsSha256 && digest(fs.readFileSync(path.join(folder, "events.jsonl"))) !== session.eventsSha256) throw new Error("prototype_data_hash_mismatch");
      if (["starting", "recording", "finalizing"].includes(session.state)) {
        session.state = "failed"; session.error = "capture_migrated_interrupted";
        session.availability = "partial"; session.endedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(session, null, 2));
      }
    }
    const registry = path.join(stage, ".generated-skills.json");
    if (fs.existsSync(registry)) {
      const entries = JSON.parse(fs.readFileSync(registry, "utf8"));
      if (!Array.isArray(entries)) throw new Error("prototype_skill_registry_invalid");
      for (const entry of entries) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name) || !entry.files?.["SKILL.md"]) throw new Error("prototype_skill_registry_invalid");
        const relative = descendant(source, path.resolve(entry.directory));
        verify(stage, path.join(stage, relative), entry.files);
        if (entry.checks) for (const [name, hash] of Object.entries(entry.checks)) {
          const file = path.resolve(stage, name); descendant(stage, file);
          if (digest(fs.readFileSync(file)) !== hash) throw new Error("prototype_evidence_hash_mismatch");
        }
        entry.directory = path.join(destination, relative);
      }
      fs.writeFileSync(registry, JSON.stringify(entries, null, 2));
    }
    fs.writeFileSync(path.join(stage, ".prototype-import.json"), JSON.stringify({ source, importedAt: new Date().toISOString() }), { mode: 0o600 });
    if (fs.existsSync(destination)) fs.rmdirSync(destination);
    fs.renameSync(stage, destination);
    return true;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
