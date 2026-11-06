import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HostInvoker } from "./host.js";

const Registry = z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), directory: z.string().min(1) }));
const LegacyExport = z.object({
  schema: z.enum(["memmy.teach-export/v1", "memmy.teach-export/v2"]),
  pluginId: z.literal("teach-mode"), sessionId: z.string().uuid(), skillName: z.string(),
});

function readOptional(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Withdraw retired executors before Host skill activation. Never delete user artifacts. */
export async function retireLegacySkills(host: HostInvoker, directory: string): Promise<void> {
  const raw = readOptional(path.join(directory, ".generated-skills.json"));
  if (raw === undefined) return;
  const entries = Registry.parse(raw), root = fs.realpathSync(directory);
  for (const entry of entries) {
    let resolved: string;
    try { resolved = fs.realpathSync(entry.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const relative = path.relative(root, resolved);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
      throw new Error("retired_skill_path_invalid");
    }
    const metadata = LegacyExport.safeParse(readOptional(path.join(entry.directory, "manifest.json")));
    if (!metadata.success) continue;
    if (metadata.data.skillName !== entry.name || entry.name !== `teach-${metadata.data.sessionId}`) {
      throw new Error("retired_skill_identity_mismatch");
    }
    // The Host owns both the persistent registry and its in-memory active index.
    // Removing through this service also makes retries and reinstalls idempotent.
    await host("skills", { action: "remove", name: entry.name });
  }
}
