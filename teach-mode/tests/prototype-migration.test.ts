import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migratePrototypePluginData } from "../src/prototype-migration.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-plugin-migration-")); roots.push(root);
  const old = path.join(root, "prototype"), target = path.join(root, "released");
  const skill = path.join(old, "generated-skills/example-skill"); fs.mkdirSync(skill, { recursive: true });
  const bytes = Buffer.from("---\nname: example-skill\ndescription: An existing generated skill\n---\nProcedure\n");
  fs.writeFileSync(path.join(skill, "SKILL.md"), bytes);
  fs.writeFileSync(path.join(old, ".generated-skills.json"), JSON.stringify([{ name: "example-skill", directory: skill,
    files: { "SKILL.md": createHash("sha256").update(bytes).digest("hex") } }]));
  return { root, old, target, skill };
}
describe("prototype plugin data migration", () => {
  it("accepts a parent directory alias and retains the requested destination spelling", () => {
    const f = fixture(), alias = path.join(f.root, "parent-alias");
    fs.symlinkSync(f.root, alias, "junction");
    const old = path.join(alias, "prototype"), target = path.join(alias, "released");
    const registry = path.join(old, ".generated-skills.json"), entries = JSON.parse(fs.readFileSync(registry, "utf8"));
    entries[0].directory = path.join(old, "generated-skills/example-skill");
    fs.writeFileSync(registry, JSON.stringify(entries));
    expect(migratePrototypePluginData(target, old)).toBe(true);
    const imported = JSON.parse(fs.readFileSync(path.join(target, ".generated-skills.json"), "utf8"));
    expect(imported[0].directory).toBe(path.join(target, "generated-skills/example-skill"));
    expect(fs.readFileSync(path.join(imported[0].directory, "SKILL.md"), "utf8")).toContain("example-skill");
    expect(fs.existsSync(f.old)).toBe(true);
  });
  it("still refuses a registry directory outside the canonical legacy root", () => {
    const f = fixture(), registry = path.join(f.old, ".generated-skills.json");
    const entries = JSON.parse(fs.readFileSync(registry, "utf8"));
    entries[0].directory = f.root; fs.writeFileSync(registry, JSON.stringify(entries));
    expect(() => migratePrototypePluginData(f.target, f.old)).toThrow("prototype_data_path_invalid");
    expect(fs.existsSync(f.target)).toBe(false); expect(fs.existsSync(f.skill)).toBe(true);
  });
  it("still refuses a symlink inside the copied legacy data", () => {
    const f = fixture(), outside = path.join(f.root, "outside");
    fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.old, "linked-data"), "junction");
    expect(() => migratePrototypePluginData(f.target, f.old)).toThrow("prototype_data_symlink_refused");
    expect(fs.existsSync(f.target)).toBe(false); expect(fs.existsSync(outside)).toBe(true);
  });
  it("validates before activation, rebinds generated paths and retains the complete old directory", () => {
    const f = fixture(); expect(migratePrototypePluginData(f.target, f.old)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(path.join(f.target, ".generated-skills.json"), "utf8"));
    expect(entries[0].directory).toBe(path.join(f.target, "generated-skills/example-skill"));
    expect(fs.existsSync(path.join(f.skill, "SKILL.md"))).toBe(true);
    expect(migratePrototypePluginData(f.target, f.old)).toBe(false);
  });
  it("does not activate a corrupted copy or change its original data", () => {
    const f = fixture(); fs.appendFileSync(path.join(f.skill, "SKILL.md"), "changed");
    expect(() => migratePrototypePluginData(f.target, f.old)).toThrow("hash_mismatch");
    expect(fs.existsSync(f.target)).toBe(false); expect(fs.existsSync(f.old)).toBe(true);
  });
  it("does not overwrite data already stored in the released location", () => {
    const f = fixture(); fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, "retained.txt"), "keep");
    expect(migratePrototypePluginData(f.target, f.old)).toBe(false);
    expect(fs.readFileSync(path.join(f.target, "retained.txt"), "utf8")).toBe("keep");
  });
});
