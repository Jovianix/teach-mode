import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createConversationTeachPlugin } from "../src/conversation-plugin.js";
import type { HostInvoker } from "../src/host.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const id = "ba1142db-f861-4dca-8bff-f602d492d8db";
function fixture(options: { language?: string; event?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-teach-")); roots.push(root);
  const bytes = Buffer.from(JSON.stringify({ index: 0, source: { stream: "one", sequence: 1 }, event: options.event ?? { eventType: "text_changed", details: { text: "Example value" } } }) + "\n");
  const eventsSha256 = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(root, "event-sessions", id); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, "events.jsonl"), bytes);
  const session = { id, state: "ready", availability: "available", goal: "Save a note", eventCount: 1, eventsSha256,
    startedAt: "2026-10-20T00:00:00.000Z", endedAt: "2026-10-20T00:01:00.000Z", limitations: ["Only authorized observed events"] };
  const config = { version: 1, features: ["memmy.conversation/v1", "memmy.generated-skills/v1", "memmy.event-checkpoints/v1"], supported: true, toolNames: ["read_file", "write_file"], skills: [] as Array<{ name: string; path: string }>, skillCreator: { available: true, instructions: "Host Skill Creator instructions" } };
  const publish = vi.fn(async (_input: unknown) => ({ ok: true })), eventCall = vi.fn();
  const host: HostInvoker = async <T>(service: string, raw: unknown) => {
    const input = raw as Record<string, any>; let result: unknown;
    if (service === "plugin-context") result = { dataDirectory: root, language: options.language };
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
  it("prepares a compact first page and keeps default raw reads compatible with the Host", async () => {
    const f = fixture({ event: { eventType: "text_input", details: { text: "captured", nativeSessionId: "writer diagnostic" } } });
    const prepared = await f.plugin.invoke("create_skill", { action: "prepare", session_id: id });
    expect(prepared).toMatchObject({ evidenceView: "teaching", session: { eventsSha256: f.eventsSha256 },
      events: [{ index: 0, details: { text: "captured" } }] });
    expect(prepared.next).toContain("do not read it again");
    const raw = await f.plugin.invoke("record_and_replay", { action: "read", session_id: id });
    expect((raw.events as any[])[0].event.details.nativeSessionId).toBe("writer diagnostic");
    const input = { action: "read", session_id: id, view: "teaching", offset: 0, limit: 1 };
    const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
    const schema = manifest.capabilities.find((c: { id: string }) => c.id === "record_and_replay").inputSchema;
    expect(new AjvJsonSchemaValidator().getValidator(schema)(input).valid).toBe(true);
    expect(await f.plugin.invoke("record_and_replay", input)).toMatchObject({ evidenceView: "teaching" });
    expect(f.eventCall).toHaveBeenLastCalledWith({ action: "read", session_id: id, offset: 0, limit: 1 });
    // Saving still selects immutable raw evidence, not this derived view.
    await f.save();
    const saved = fs.readFileSync(path.join(f.root, "generated-skills/save-a-note/references/events.jsonl"), "utf8");
    expect(saved).toContain("writer diagnostic");
  });
  it("reports missing desktop tools without proposing exec as native input", async () => {
    const f = fixture();
    const prepared = await f.plugin.invoke("create_skill", { action: "prepare", session_id: id });
    expect(prepared.desktopExecution).toMatchObject({ available: false, observationTool: null, tools: [] });
    expect(prepared.next).toContain("executionMode=desktop");
    expect(prepared.next).toContain("do not substitute exec or SendKeys");
  });
  it("refuses an exec-only desktop draft before writing or publishing a skill", async () => {
    const f = fixture(); f.config.toolNames.push("exec");
    await expect(f.plugin.invoke("create_skill", { action: "save", session_id: id,
      events_sha256: f.eventsSha256, generate: true,
      draft: { ...f.draft, executionMode: "desktop", tools: ["exec", "read_file"] } }))
      .rejects.toThrow("managed Computer Use get_app_state");
    expect(f.publish).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.root, "generated-skills"))).toBe(false);
  });
  it("preserves document targeting rules and native dependencies in a saved desktop skill", async () => {
    const f = fixture(), observe = "mcp_memmy_computer_use_get_app_state", type = "mcp_memmy_computer_use_type_text";
    f.config.toolNames.push(observe, type);
    const draft = { ...f.draft, executionMode: "desktop", tools: [observe, type, "read_file"] };
    const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
    const validator = new AjvJsonSchemaValidator().getValidator(manifest.capabilities.find((c: { id: string }) => c.id === "create_skill").inputSchema);
    const input = { action: "save", session_id: id, events_sha256: f.eventsSha256, generate: true, draft };
    expect(validator(input).valid).toBe(true);
    const result = await f.plugin.invoke("create_skill", input);
    expect(result).toMatchObject({ execution: "not_run", tools: draft.tools });
    const target = path.join(f.root, "generated-skills", draft.name);
    const markdown = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    expect(markdown).toContain("exact window_id");
    expect(markdown).toContain("Do not use PowerShell SendKeys");
    expect(markdown).toContain("A launcher PID is not proof of the target window");
    expect(markdown).toContain("different document, is an execution failure");
    expect(JSON.parse(markdown.split("metadata: ")[1]!.split("\n")[0]!).memmy.requires.tools).toEqual(draft.tools);
    expect(JSON.parse(fs.readFileSync(path.join(target, "references/source.json"), "utf8"))).toMatchObject({ executionMode: "desktop" });
    expect((await f.plugin.invoke("create_skill", { action: "prepare", session_id: id })).desktopExecution)
      .toMatchObject({ available: true, observationTool: observe, tools: [observe, type] });
  });
  it("accepts teaching coverage through the published Host input schema before saving", async () => {
    const f = fixture();
    const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
    const schema = manifest.capabilities.find((capability: { id: string }) => capability.id === "create_skill").inputSchema;
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    const input = { action: "save", session_id: id, events_sha256: f.eventsSha256, generate: true,
      draft: { ...f.draft, steps: [{ instruction: "Enter the requested date", evidenceIndexes: [],
        evidenceStatus: "user-specified", controlType: "date-time" }],
        teachingGaps: [{ description: "Date entry was not observed", stepIndexes: [0],
          reason: "action-not-observed", resolution: "user-specified", nextAction: "Demonstrate date entry or verify its actual value" }] } };
    expect(validate(input).valid).toBe(true);
    expect(await f.plugin.invoke("create_skill", input)).toMatchObject({ saved: true,
      teachingReview: { status: "gaps_identified", gaps: input.draft.teachingGaps } });
    expect(validate({ ...input, draft: { ...input.draft, teachingGaps: [{ ...input.draft.teachingGaps[0], reason: "invented" }] } }).valid).toBe(false);
    expect(validate({ action: "save", session_id: id, events_sha256: f.eventsSha256, generate: true, draft: f.draft }).valid).toBe(true);
  });
  it("retains unclassified action gaps in the saved skill and published evidence", async () => {
    const f = fixture({ language: "zh-CN" }), result = await f.save();
    expect(result).toMatchObject({ saved: true, execution: "not_run",
      teachingReview: { status: "gaps_identified", recordingAvailability: "available",
        gaps: [{ stepIndexes: [0], resolution: "needs-validation" }] } });
    expect((result.presentation as { message: string }).message).toContain("教学缺口");
    const target = path.join(f.root, "generated-skills", f.draft.name);
    const markdown = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    expect(markdown).toContain("## Teaching gaps");
    expect(markdown).not.toContain("recorded example:");
    expect(JSON.parse(fs.readFileSync(path.join(target, "references/teaching-gaps.json"), "utf8")))
      .toEqual(result.teachingReview);
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ skill: expect.objectContaining({
      files: expect.objectContaining({ "references/teaching-gaps.json": expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }) }));
  });
  it("does not claim independent execution even when all step evidence is classified", async () => {
    const f = fixture();
    const result = await f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: f.eventsSha256,
      generate: true, draft: { ...f.draft, steps: [{ ...f.draft.steps[0], evidenceStatus: "observed" }], teachingGaps: [] } });
    expect(result).toMatchObject({ execution: "not_run",
      teachingReview: { status: "no_declared_gaps", execution: "not_run", gaps: [] } });
  });
  it.each(["date-time", "select"])("does not treat nearby clicks as observed %s input", async controlType => {
    const f = fixture({ event: { eventType: "click", details: { role: "button", label: "Review" } } });
    const input = { action: "save", session_id: id, events_sha256: f.eventsSha256, generate: true,
      draft: { ...f.draft, steps: [{ instruction: "Fill the required field", evidenceIndexes: [0],
        evidenceStatus: "observed", controlType }] } };
    await expect(f.plugin.invoke("create_skill", input)).rejects.toThrow("no matching recorded value/action");
    expect(f.publish).not.toHaveBeenCalled();
    input.draft.steps[0]!.evidenceStatus = "context-only";
    const result = await f.plugin.invoke("create_skill", input);
    expect(result).toMatchObject({ teachingReview: { gaps: [{ reason: "action-not-observed", stepIndexes: [0] }] } });
  });
  it("accepts a recorded date value while keeping execution unverified", async () => {
    const f = fixture({ event: { eventType: "text_input", details: { role: "input", inputType: "date", text: "2026-10-21" } } });
    const result = await f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: f.eventsSha256,
      generate: true, draft: { ...f.draft, steps: [{ instruction: "Fill the invoice date", evidenceIndexes: [0],
        evidenceStatus: "observed", controlType: "date-time" }] } });
    expect(result).toMatchObject({ teachingReview: { status: "no_declared_gaps", execution: "not_run" } });
  });
  it("saves unresolved teaching explicitly without inventing user confirmation", async () => {
    const f = fixture();
    const gap = { description: "The date entry was not demonstrated", stepIndexes: [0],
      reason: "unsupported-control", resolution: "needs-demonstration", nextAction: "Demonstrate date entry and verify its stored value" };
    const result = await f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: f.eventsSha256,
      generate: true, draft: { ...f.draft, steps: [{ instruction: "Enter the date", evidenceIndexes: [],
        evidenceStatus: "unverified", controlType: "date-time" }], teachingGaps: [gap] } });
    expect(result).toMatchObject({ teachingReview: { gaps: [gap] } });
    expect(fs.readFileSync(path.join(f.root, "generated-skills", f.draft.name, "SKILL.md"), "utf8"))
      .not.toContain("user-confirmed clarification");
  });
  it("retains user-specified steps as unobserved instead of changing recording completeness", async () => {
    const f = fixture();
    const result = await f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: f.eventsSha256,
      generate: true, draft: { ...f.draft, steps: [{ instruction: "Use the user's batch rule", evidenceIndexes: [],
        evidenceStatus: "user-specified", confirmedByUser: true }] } });
    expect(result).toMatchObject({ teachingReview: { recordingAvailability: "available",
      gaps: [{ resolution: "user-specified", reason: "action-not-observed" }] } });
    expect(f.session.availability).toBe("available");
  });
  it("accepts requirements already supplied by the user without inventing a new clarification", async () => {
    const f = fixture();
    const result = await f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: f.eventsSha256,
      generate: true, draft: { ...f.draft, steps: [{ instruction: "Enter the date supplied in the user request",
        evidenceIndexes: [], evidenceStatus: "user-specified", controlType: "date-time" }] } });
    expect(result).toMatchObject({ saved: true, execution: "not_run", teachingReview: {
      gaps: [{ stepIndexes: [0], reason: "action-not-observed", resolution: "user-specified" }] } });
    const markdown = fs.readFileSync(path.join(f.root, "generated-skills", f.draft.name, "SKILL.md"), "utf8");
    expect(markdown).toContain("user-specified requirement; action not observed");
    expect(markdown).not.toContain("user-confirmed clarification");
  });
  it("rejects gaps referring to nonexistent steps", async () => {
    const f = fixture();
    await expect(f.plugin.invoke("create_skill", { action: "save", session_id: id, events_sha256: f.eventsSha256,
      generate: true, draft: { ...f.draft, teachingGaps: [{ description: "Missing date entry", stepIndexes: [2],
        reason: "action-not-observed", resolution: "needs-demonstration", nextAction: "Demonstrate it" }] } }))
      .rejects.toThrow("outside the draft");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("keeps partial fragments explicit before Skill Creator preparation", async () => {
    const f = fixture(); f.session.availability = "partial";
    const stopped = await f.plugin.invoke("record_and_replay", {action: "stop", session_id: id});
    expect((stopped.presentation as {message: string}).message).toContain("coverage gaps");
    const prepared = await f.plugin.invoke("create_skill", {action: "prepare", session_id: id});
    expect(prepared.next).toContain("review its limitations with the user");
    expect(f.session.availability).toBe("partial");
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("forwards the explicitly selected browser profile without starting desktop capture", async () => {
    const f = fixture(); f.config.features.push("memmy.browser-event-sessions/v1");
    const browser = { name: "edge", connection_id: "work-profile" };
    await f.plugin.invoke("record_and_replay", { action: "start", goal: "Browser demonstration", consent: true, browser });
    expect(f.eventCall).toHaveBeenLastCalledWith({ action: "start", goal: "Browser demonstration", consent: true, browser });
  });
  it("requires the browser capture Host capability before querying profiles or starting a teaching window", async () => {
    const f = fixture();
    await expect(f.plugin.invoke("record_and_replay", { action: "browser-options" })).rejects.toThrow("browser-event-sessions");
    await expect(f.plugin.invoke("record_and_replay", { action: "start", goal: "Browser", consent: true, browser: { name: "chrome" } })).rejects.toThrow("browser-event-sessions");
    expect(f.eventCall.mock.calls.every(([input]) => input.action === "configuration")).toBe(true);
  });
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
  it("rejects an older Host without ordered event boundaries before starting capture", async () => {
    const f = fixture(); f.config.features = f.config.features.filter(value => value !== "memmy.event-checkpoints/v1");
    await expect(f.plugin.initialize()).rejects.toThrow("ordered event checkpoints");
    expect(f.eventCall.mock.calls.every(([input]) => input.action === "configuration")).toBe(true);
  });
  it("refuses existing workspace skill names and invalid Host-standard names or descriptions", async () => {
    const f = fixture(); f.config.skills.push({ name: f.draft.name, path: path.join(f.root, "workspace", "skills", f.draft.name, "SKILL.md") });
    await expect(f.save()).rejects.toThrow("already exists in this workspace"); f.config.skills = [];
    f.draft.name = "invalid--skill"; await expect(f.save()).rejects.toThrow(); f.draft.name = "save-a-note";
    f.draft.description = "[TODO: fill me in]"; await expect(f.save()).rejects.toThrow("Host Skill Creator validation");
    expect(f.publish).not.toHaveBeenCalled();
  });
});
