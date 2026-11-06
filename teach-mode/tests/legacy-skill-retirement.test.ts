import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { retireLegacySkills } from "../src/legacy-skill-retirement.js";
import type { HostInvoker } from "../src/host.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const id = "ba1142db-f861-4dca-8bff-f602d492d8db";
function fixture(schema = "memmy.teach-export/v2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retired-teach-skills-")); roots.push(root);
  const legacy = path.join(root, id, "exports", "a".repeat(64));
  const current = path.join(root, "generated-skills", "teach-current-note");
  fs.mkdirSync(legacy, { recursive: true }); fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(legacy, "manifest.json"), JSON.stringify({ schema, pluginId: "teach-mode", sessionId: id, skillName: `teach-${id}` }));
  fs.writeFileSync(path.join(legacy, "SKILL.md"), "Retired teach_session invocation");
  fs.writeFileSync(path.join(root, "recording.mp4"), "Retained user video");
  fs.writeFileSync(path.join(current, "SKILL.md"), "Current event skill");
  const registry = path.join(root, ".generated-skills.json");
  fs.writeFileSync(registry, JSON.stringify([{ name: `teach-${id}`, directory: legacy }, { name: "teach-current-note", directory: current }]));
  const remove = vi.fn((name: string) => {
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as Array<{ name: string }>;
    fs.writeFileSync(registry, JSON.stringify(entries.filter(entry => entry.name !== name)));
  });
  const host: HostInvoker = async <T>(service: string, raw: unknown) => {
    const input = raw as { action: string; name: string };
    expect(service).toBe("skills"); expect(input.action).toBe("remove");
    remove(input.name); return { ok: true } as T;
  };
  return { root, legacy, current, registry, host, remove };
}

it.each(["memmy.teach-export/v1", "memmy.teach-export/v2"])("withdraws %s once and retains current skills and all user files", async schema => {
  const f = fixture(schema);
  await retireLegacySkills(f.host, f.root);
  await retireLegacySkills(f.host, f.root);
  expect(f.remove).toHaveBeenCalledExactlyOnceWith(`teach-${id}`);
  expect(JSON.parse(fs.readFileSync(f.registry, "utf8"))).toEqual([{ name: "teach-current-note", directory: f.current }]);
  expect(fs.readFileSync(path.join(f.legacy, "SKILL.md"), "utf8")).toBe("Retired teach_session invocation");
  expect(fs.readFileSync(path.join(f.root, "recording.mp4"), "utf8")).toBe("Retained user video");
});

it("does not infer legacy execution from a skill name alone", async () => {
  const f = fixture("unrelated-export/v1");
  await retireLegacySkills(f.host, f.root);
  expect(f.remove).not.toHaveBeenCalled();
});

it("fails initialization when the Host cannot withdraw an old registration, without deleting files", async () => {
  const f = fixture(); f.remove.mockImplementationOnce(() => { throw new Error("registry unavailable"); });
  await expect(retireLegacySkills(f.host, f.root)).rejects.toThrow("registry unavailable");
  expect(fs.existsSync(path.join(f.legacy, "SKILL.md"))).toBe(true);
  await retireLegacySkills(f.host, f.root);
  expect(JSON.parse(fs.readFileSync(f.registry, "utf8"))).toHaveLength(1);
});

it("refuses an export whose identity differs from the registry entry", async () => {
  const f = fixture();
  const file = path.join(f.legacy, "manifest.json"), metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...metadata, skillName: "another-skill" }));
  await expect(retireLegacySkills(f.host, f.root)).rejects.toThrow("identity_mismatch");
  expect(f.remove).not.toHaveBeenCalled();
});
