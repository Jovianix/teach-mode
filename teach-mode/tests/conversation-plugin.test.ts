import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationTeachPlugin } from "../src/conversation-plugin.js";
import type { HostInvoker } from "../src/host.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const id = "ba1142db-f861-4dca-8bff-f602d492d8db";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-teach-")); roots.push(root);
  const bytes = Buffer.from(JSON.stringify({ index: 0, source: { stream: "one", sequence: 1 }, event: { eventType: "text_changed", details: { text: "Example value" } } }) + "\n");
  const eventsSha256 = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(root, "event-sessions", id); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, "events.jsonl"), bytes);
  const session = { id, state: "ready", availability: "available", goal: "Save a note", eventCount: 1, eventsSha256,
    startedAt: "2026-10-20T00:00:00.000Z", endedAt: "2026-10-20T00:01:00.000Z", limitations: ["Only authorized observed events"] };
  const config = { version: 1, features: ["memmy.conversation/v1", "memmy.generated-skills/v1"], supported: true, toolNames: ["read_file", "write_file"], skills: [] as Array<{ name: string; path: string }>, skillCreator: { available: true, instructions: "Host Skill Creator instructions" } };
  const publish = vi.fn(async (_input: unknown) => ({ ok: true })), eventCall = vi.fn();
  const host: HostInvoker = async <T>(service: string, raw: unknown) => {
    const input = raw as Record<string, any>; let result: unknown;
    if (service === "plugin-context") result = { dataDirectory: root };
    else if (service === "skills") result = await publish(input);
    else if (service === "event-sessions") {
      eventCall(input);
      if (input.action === "configuration") result = config;
      else if (input.action === "read") {
        if (session.state !== "ready") throw new Error("capture_ready_events_required");
        result = { session, events: [JSON.parse(bytes.toString())], nextOffset: null };
      } else if (input.action === "list" || input.action === "status") result = { sessions: [session] };
      else result = { ...session, state: input.action === "start" ? "recording" : input.action === "cancel" ? "cancelled" : "ready" };
    } else throw new Error("Unexpected Host service");
    return result as T;
  };
  const plugin = createConversationTeachPlugin(host);
  const draft = { name: "save-a-note", description: "Save a note using the demonstrated workflow", goal: "Save the current requested note",
    prerequisites: ["The output location is available"], parameters: [{ name: "note", description: "The current task's note text", example: "Example value" }],
    steps: [{ instruction: "Use write_file to write the requested note", evidenceIndexes: [0] }], tools: ["write_file", "read_file"],
    completionChecks: ["Read the actual output file and compare its text to the request"], limitations: [] };
  const save = () => plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: eventsSha256, generate: true, draft });
  return { root, plugin, session, config, publish, eventCall, draft, eventsSha256, save };
}
describe("four-step conversation teaching", () => {
  it("does not capture on activation and does not generate on start or stop", async () => {
    const f = fixture(); await f.plugin.initialize();
    expect(f.eventCall.mock.calls.every(([input]) => input.action === "configuration")).toBe(true);
    await f.plugin.invoke("record_and_replay", { action: "start", goal: "Save a note", consent: true });
    const ended = await f.plugin.invoke("record_and_replay", { action: "stop", session_id: id });
    expect(ended.next).toContain("Wait for the user"); expect(f.publish).not.toHaveBeenCalled();
  });
  it("loads the actual Host Skill Creator and requires an unambiguous fragment selection", async () => {
    const f = fixture(); const list = await f.plugin.invoke("create_skill", { action: "prepare" });
    expect(list).toMatchObject({ requiresSelection: true, recordings: [{ id }] });
    const preparation = await f.plugin.invoke("create_skill", { action: "prepare", session_id: id });
    expect(preparation).toMatchObject({ skillCreator: f.config.skillCreator, availableTools: ["read_file", "write_file"], nextOffset: null });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("validates and atomically saves a standard skill with parameters, provenance and independent completion checks", async () => {
    const f = fixture(), result = await f.save();
    expect(result).toMatchObject({ name: "save-a-note", saved: true, validated: true, execution: "not_run" });
    const target = path.join(f.root, "generated-skills", "save-a-note"), markdown = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    expect(markdown).toContain("name: save-a-note"); expect(markdown).toContain("replace for the current task");
    expect(markdown).toContain("Read the actual output file"); expect(markdown).toContain("Only authorized observed events");

  });
  it("rejects absent consent, changed evidence, missing tools and unsupported resource references", async () => {
    const f = fixture(); await expect(f.plugin.invoke("create_skill", { action: "save", draft: f.draft })).rejects.toThrow("Explicit generation");
    await expect(f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: "a".repeat(64), generate: true, draft: f.draft })).rejects.toThrow("hash changed");
    f.draft.tools.push("imaginary_tool"); await expect(f.save()).rejects.toThrow("dependencies"); f.draft.tools.pop();
    f.draft.steps[0]!.instruction = "Read [missing](scripts/missing.py)"; await expect(f.save()).rejects.toThrow("unavailable resource");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("requires conversation clarification for missing step evidence and refuses cancelled recordings", async () => {
    const f = fixture(); f.draft.steps[0]!.evidenceIndexes = []; await expect(f.save()).rejects.toThrow("clarification");
    f.draft.steps[0]!.evidenceIndexes = [10]; await expect(f.save()).rejects.toThrow("outside");
    f.draft.steps[0]!.evidenceIndexes = [0]; f.session.state = "cancelled"; await expect(f.save()).rejects.toThrow("ready_events_required");
  });
  it("fails dependency inspection instead of advertising an incomplete Host", async () => {
    const f = fixture(); f.config.skillCreator.available = false;
    await expect(f.plugin.initialize()).rejects.toThrow("requires the Host skill-creator");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("refuses existing workspace skill names and invalid Host-standard names or descriptions", async () => {
    const f = fixture(); f.config.skills.push({ name: f.draft.name, path: path.join(f.root, "workspace", "skills", f.draft.name, "SKILL.md") });
    await expect(f.save()).rejects.toThrow("already exists in this workspace"); f.config.skills = [];
    f.draft.name = "invalid--skill"; await expect(f.save()).rejects.toThrow(); f.draft.name = "save-a-note";
    f.draft.description = "[TODO: fill me in]"; await expect(f.save()).rejects.toThrow("Host Skill Creator validation");
    expect(f.publish).not.toHaveBeenCalled();
  });
});
