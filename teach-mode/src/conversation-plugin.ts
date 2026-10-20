import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostInvoker } from "./host.js";

const identifier = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Draft = z.object({
  name: identifier, description: z.string().trim().min(10).max(1_000).refine(value => !/\bTODO\b|fill me in|\[TODO|[<>]/i.test(value), "Description must satisfy Host Skill Creator validation"), goal: z.string().trim().min(1).max(2_000),
  prerequisites: z.array(z.string().trim().min(1)).max(30),
  parameters: z.array(z.object({ name: identifier, description: z.string().min(1), example: z.string().optional() })).max(30),
  steps: z.array(z.object({ instruction: z.string().trim().min(1).max(4_000),
    evidenceIndexes: z.array(z.number().int().nonnegative()).max(100),
    confirmedByUser: z.boolean().optional() })).min(1).max(100),
  tools: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).min(1).max(30),
  completionChecks: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  limitations: z.array(z.string().trim().min(1)).max(30)
}).strict();
type Session = { id: string; state: string; availability: string; eventsSha256: string | null; eventCount: number;
  goal: string; startedAt: string; endedAt: string | null; limitations: string[] };
type Configuration = { version: number; features?: string[]; supported: boolean; toolNames: string[]; skills: Array<{ name: string; path: string }>; skillCreator: { available: boolean; instructions?: string } };
const Input = z.object({ action: z.string(), session_id: z.string().uuid().optional(), goal: z.string().optional(),
  consent: z.boolean().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(),
  events_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), generate: z.boolean().optional(), draft: Draft.optional() }).strict();

/** The model uses the existing Host Skill Creator; the plugin validates/saves its draft. */
export function createConversationTeachPlugin(host: HostInvoker) {
  let dataDirectory = "", initialized: Promise<void> | undefined, closing = false, language = "en-US";
  const configuration = () => host<Configuration>("event-sessions", { action: "configuration" });
  const initialize = () => initialized ??= (async () => {
    const context = await host<{ dataDirectory: string; language?: string }>("plugin-context", {});
    const config = await configuration().catch(error => {
      throw new Error(`Teach Mode requires Host event-sessions/v1 and Skill Creator. Check or update the desktop Host: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!config.features?.includes("memmy.conversation/v1") || !config.features.includes("memmy.generated-skills/v1")) throw new Error("Teach Mode requires the released Host conversation and generated-skill extensions");
    if (config.version !== 1) throw new Error("Teach Mode requires Host event-sessions/v1; update the desktop app");
    if (!config.supported) throw new Error("Event recording is unavailable on this Host platform");
    if (!Array.isArray(config.skills)) throw new Error("Teach Mode requires the Host skill catalog; update the desktop app");
    if (!config.skillCreator.available) throw new Error("Teach Mode requires the Host skill-creator skill");
    dataDirectory = context.dataDirectory; language = context.language ?? "en-US";
  })();
  const present = (raw: unknown) => {
    const session = raw as Session & { id: string; eventCount: number };
    const cn = language === "zh-CN";
    if (session.state !== "ready") return session;
    const usable = session.eventCount > 0;
    return { ...session, presentation: {
      message: usable ? cn ? "本次录制已结束，可以继续让我根据这段操作生成 skill。" : "Recording ended. Ask me to generate a skill from these operations."
        : cn ? "没有采集到可用事件，请确认采集范围后重新录制。" : "No usable events were captured. Check the authorized scope before recording again.",
      actions: usable ? [{ id: "generate-skill", label: cn ? "使用 Skill Creator…" : "Use Skill Creator…",
        prompt: `$teach-skill-creator\n\n${cn ? "根据这段录制生成 skill" : "Generate a skill from this recording"}: ${session.id}` }] : []
    } };
  };
  const read = (id: string, offset = 0) => host<{ session: Session; events: unknown[]; nextOffset: number | null }>("event-sessions", { action: "read", session_id: id, offset, limit: 100 });
  async function save(input: z.infer<typeof Input>) {
    if (input.generate !== true || !input.session_id || !input.events_sha256 || !input.draft) throw new Error("Explicit generation request, session, evidence hash and Skill Creator draft are required");
    const draft = Draft.parse(input.draft), config = await configuration();
    if (!config.skillCreator.available) throw new Error("skill-creator dependency is unavailable");
    if (!config.toolNames.length) throw new Error("Host tool catalog is unavailable; cannot validate tool dependencies");
    const missing = draft.tools.filter(tool => !config.toolNames.includes(tool));
    if (missing.length) throw new Error(`Skill tool dependencies are unavailable: ${missing.join(", ")}`);
    if (["teach-mode", "record-and-replay", "teach-skill-creator", "skill-creator"].includes(draft.name)) throw new Error("Choose a distinct user skill name");
    const parent = path.join(dataDirectory, "generated-skills"), target = path.join(parent, draft.name);
    if (config.skills.some(skill => skill.name === draft.name && canonical(skill.path) !== canonical(path.join(target, "SKILL.md")))) throw new Error("Skill name already exists in this workspace or another plugin; choose another name");
    const first = await read(input.session_id), session = first.session;
    if (session.eventsSha256 !== input.events_sha256) throw new Error("Recording evidence hash changed; read the selected recording again");
    for (const step of draft.steps) {
      if (!step.evidenceIndexes.length && step.confirmedByUser !== true) throw new Error("Missing step evidence requires clarification in the conversation");
      if (step.evidenceIndexes.some(index => index >= session.eventCount)) throw new Error("Skill references an event outside the selected recording");
    }
    const indexes = new Set(draft.steps.flatMap(step => step.evidenceIndexes));
    const selected = (events: unknown[]) => events.filter(event => indexes.has((event as { index: number }).index));
    const events = selected(first.events); let nextOffset = first.nextOffset;
    while (nextOffset !== null) {
      const page = await read(input.session_id, nextOffset);
      if (page.session.eventsSha256 !== session.eventsSha256 || page.nextOffset === nextOffset) throw new Error("capture_evidence_changed");
      events.push(...selected(page.events)); nextOffset = page.nextOffset;
    }
    const draftSha256 = digest(Buffer.from(JSON.stringify(draft)));
    const source = { schema: "memmy.recorded-skill/v1", pluginId: "teach-mode", sessionId: session.id,
      eventsSha256: session.eventsSha256, draftSha256, startedAt: session.startedAt, endedAt: session.endedAt,
      eventCount: session.eventCount, selectedEventIndexes: [...indexes], tools: draft.tools };
    const limitations = [...new Set([...session.limitations, ...draft.limitations])];
    const markdown = ["---", `name: ${draft.name}`, `description: ${JSON.stringify(draft.description)}`,
      `metadata: ${JSON.stringify({ memmy: { requires: { tools: draft.tools } } })}`, "---", "",
      `# ${draft.name}`, "", draft.goal, "", "## Prerequisites", ...draft.prerequisites.map(value => `- ${value}`), "",
      "## Parameters", ...draft.parameters.map(parameter => `- \`${parameter.name}\`: ${parameter.description}${parameter.example ? ` (recorded example: ${parameter.example}; replace for the current task)` : ""}`), "",
      "## Procedure", ...draft.steps.map((step, index) => `${index + 1}. ${step.instruction} (${step.evidenceIndexes.length ? `source events: ${step.evidenceIndexes.join(", ")}` : "user-confirmed clarification"})`), "",
      "## Completion checks", ...draft.completionChecks.map(value => `- ${value}`), "",
      "## Available tools", ...draft.tools.map(tool => `- \`${tool}\``), "",
      "## Evidence and limitations", "Source: [recording provenance](references/source.json) and [selected events](references/events.jsonl).",
      ...limitations.map(value => `- ${value}`), "- Generation does not prove execution. Run only when the user requests it and verify the current task's outputs.", ""].join("\n");
    validateResources(markdown);
    const files = { "SKILL.md": Buffer.from(markdown), "references/source.json": Buffer.from(JSON.stringify(source, null, 2)),
      "references/events.jsonl": Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "")) };
    if (Object.values(files).reduce((size, bytes) => size + bytes.length, 0) > 18_000_000) throw new Error("Selected skill evidence exceeds the bundle limit; choose a smaller, focused recording");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("Unsafe skill directory");
    if (fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Unsafe skill directory");
      const previous = JSON.parse(fs.readFileSync(path.join(target, "references", "source.json"), "utf8"));
      if (previous.draftSha256 !== draftSha256 || previous.sessionId !== session.id) throw new Error("Skill name already exists; choose another name");
    } else {
      const stage = path.join(parent, `.staging-${randomUUID()}`);
      try {
        fs.mkdirSync(path.join(stage, "references"), { recursive: true, mode: 0o700 });
        for (const [name, bytes] of Object.entries(files)) {
          const fd = fs.openSync(path.join(stage, name), "wx", 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        fs.renameSync(stage, target);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
    await host("skills", { action: "publish", skill: { name: draft.name, directory: target,
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])),
      checks: { [`event-sessions/${session.id}/events.jsonl`]: session.eventsSha256 } } });
    return { name: draft.name, description: draft.description, parameters: draft.parameters, tools: draft.tools,
      directory: target, session_id: session.id, events_sha256: session.eventsSha256, validated: true, saved: true,
      execution: "not_run", usage: `Ask to use $${draft.name} in a subsequent conversation.`, limitations };
  }
  return { initialize, async shutdown() { closing = true; },
    async invoke(capability: string, raw: unknown): Promise<Record<string, unknown>> {
      if (closing) throw new Error("teach_plugin_stopping");
      await initialize(); const input = Input.parse(raw);
      if (capability === "record_and_replay") {
        if (!["status", "list", "start", "stop", "cancel", "read"].includes(input.action)) throw new Error("Unknown event recording action");
        const result = await host<Record<string, unknown>>("event-sessions", input);
        if (input.action === "status" || input.action === "list") return { ...result, sessions: (result.sessions as unknown[]).map(present) };
        if (input.action === "stop") return { ...present(result), next: "Recording ended. Wait for the user to request Skill Creator generation; do not generate or execute automatically." };
        return result;
      }
      if (capability !== "create_skill") throw new Error("Unknown Teach Mode capability");
      if (input.action === "save") return save(input);
      if (input.action !== "prepare") throw new Error("Unknown Skill Creator action");
      if (!input.session_id) {
        const { sessions } = await host<{ sessions: Session[] }>("event-sessions", { action: "list" });
        return { recordings: sessions.filter(s => s.state === "ready"), requiresSelection: true,
          next: "Select the recording identified by the user; clarify when multiple recordings could match." };
      }
      const page = await read(input.session_id), config = await configuration();
      return { ...page, skillCreator: config.skillCreator, availableTools: config.toolNames,
        next: "Load the Host Skill Creator instructions, read all selected event pages, clarify missing evidence, then submit a standard structured draft using save. Generation and execution are separate." };
    }
  };
}
function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function canonical(file: string) {
  const resolved = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function validateResources(markdown: string) {
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]!;
    if (/^(?:https?:|#)/.test(target)) continue;
    if (!["references/source.json", "references/events.jsonl"].includes(target)) throw new Error(`Skill references an unavailable resource: ${target}`);
  }
}
