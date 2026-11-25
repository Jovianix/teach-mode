import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostInvoker } from "./host.js";
import { demonstrationScope, type DemonstrationScope } from "./demonstration-scope.js";
import { recordedAction, teachingEvidence } from "./teaching-evidence.js";
import { retireLegacySkills } from "./legacy-skill-retirement.js";

const identifier = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const TeachingGap = z.object({
  description: z.string().trim().min(1).max(2_000),
  stepIndexes: z.array(z.number().int().nonnegative()).max(100),
  reason: z.enum(["action-not-observed", "parameter-not-observed", "result-not-observed", "unsupported-control", "capture-gap", "unverified-step"]),
  resolution: z.enum(["needs-demonstration", "user-specified", "needs-validation"]),
  nextAction: z.string().trim().min(1).max(2_000),
}).strict();
const Draft = z.object({
  name: identifier, description: z.string().trim().min(10).max(1_000).refine(value => !/\bTODO\b|fill me in|\[TODO|[<>]/i.test(value), "Description must satisfy Host Skill Creator validation"), goal: z.string().trim().min(1).max(2_000),
  prerequisites: z.array(z.string().trim().min(1)).max(30),
  parameters: z.array(z.object({ name: identifier, description: z.string().min(1), example: z.string().optional() }).strict()).max(30),
  steps: z.array(z.object({ instruction: z.string().trim().min(1).max(4_000),
    replayInstruction: z.string().trim().min(1).max(4_000).optional(),
    evidenceIndexes: z.array(z.number().int().nonnegative()).max(100),
    confirmedByUser: z.boolean().optional(),
    evidenceStatus: z.enum(["observed", "context-only", "user-specified", "unverified"]).default("unverified"),
    controlType: z.enum(["text", "date-time", "select", "other"]).optional() }).strict()).min(1).max(100),
  tools: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).min(1).max(30),
  executionMode: z.enum(["agent-tools", "desktop"]).default("agent-tools"),
  completionChecks: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  limitations: z.array(z.string().trim().min(1)).max(30),
  teachingGaps: z.array(TeachingGap).max(100).default([]),
}).strict();
type Session = { id: string; state: string; availability: string; eventsSha256: string | null; eventCount: number;
  includeMemmyApp?: boolean; goal: string; startedAt: string; endedAt: string | null; limitations: string[] };
type Configuration = { version: number; features?: string[]; supported: boolean; toolNames: string[]; skills: Array<{ name: string; path: string }>; skillCreator: { available: boolean; instructions?: string } };
const desktopObservation = /^mcp_(?:memmy|open)_computer_use_get_app_state$/;
const executionRules = [
  "Use the Host computer-use skill and its managed tools. Identify the intended app and window from fresh state before acting.",
  "Verify the requested outcome using the current state of the relevant control, page or document.",
];
function desktopGuidance(config: Configuration) {
  const observationTool = config.toolNames.find(tool => desktopObservation.test(tool)) ?? null;
  return { available: observationTool !== null, observationTool,
    tools: config.toolNames.filter(tool => /^mcp_(?:memmy|open)_computer_use_/.test(tool)),
    rules: executionRules };
}
const sessionId = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const RecordingInput = z.object({ action: z.enum(["status", "list", "start", "stop", "cancel", "read"]),
  session_id: sessionId.optional(), goal: z.string().max(2_000).optional(), consent: z.boolean().optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(),
  view: z.enum(["raw", "teaching"]).optional(), include_memmy: z.boolean().optional() }).strict();
const SaveInput = z.object({ action: z.literal("save"), session_id: sessionId, events_sha256: hash,
  draft: Draft, generate: z.literal(true).optional(), include_memmy: z.boolean().optional() }).strict();
const CreatorInput = z.discriminatedUnion("action", [SaveInput, z.object({ action: z.literal("prepare"),
  session_id: sessionId.optional(), include_memmy: z.boolean().optional() }).strict()]);

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
    if (!config.features.includes("memmy.event-checkpoints/v1")) throw new Error("Teach Mode requires Host ordered event checkpoints; update the desktop app before recording");
    if (!config.supported) throw new Error("Event recording is unavailable on this Host platform");
    if (!Array.isArray(config.skills)) throw new Error("Teach Mode requires the Host skill catalog; update the desktop app");
    if (!config.skillCreator.available) throw new Error("Teach Mode requires the Host skill-creator skill");
    // The Host restores generated contributions after this worker initializes.
    // Withdraw retired executors first; retain their files as user evidence.
    await retireLegacySkills(host, context.dataDirectory);
    dataDirectory = context.dataDirectory; language = context.language ?? "en-US";
  })();
  const evidencePaths = (session: Session) => {
    const folder = path.join(dataDirectory, "event-sessions", z.string().uuid().parse(session.id));
    return { metadataPath: path.join(folder, "session.json"), eventsPath: path.join(folder, "events.jsonl") };
  };
  // Cache index sets only. Every tool read still goes through the Host's conversation
  // ownership and integrity checks. Session offsets always refer to the immutable original.
  let cached: { hash: string; scope: Promise<DemonstrationScope> } | undefined;
  async function excludedIndexes(session: Session, legacyIncludeMemmy?: boolean) {
    const hash = session.eventsSha256;
    if (!hash) throw new Error("capture_ready_events_required");
    if (cached?.hash !== hash) {
      const scope = fs.promises.readFile(evidencePaths(session).eventsPath).then(bytes => {
        if (digest(bytes) !== hash) throw new Error("capture_evidence_hash_mismatch");
        return demonstrationScope(bytes.toString("utf8").split("\n"));
      });
      cached = { hash, scope };
      void scope.catch(() => { if (cached?.scope === scope) cached = undefined; });
    }
    const index = await cached.scope;
    return (session.includeMemmyApp ?? legacyIncludeMemmy) ? index.controls : index.host;
  }
  async function read(id: string, offset = 0, limit = 100, legacyIncludeMemmy?: boolean) {
    const page = await host<{ session: Session; events: { index: number; event: Record<string, unknown> }[]; nextOffset: number | null }>(
      "event-sessions", { action: "read", session_id: id, offset, limit });
    const excluded = await excludedIndexes(page.session, legacyIncludeMemmy);
    let nextOffset = page.nextOffset;
    while (nextOffset !== null && excluded.has(nextOffset)) nextOffset++;
    if (nextOffset !== null && nextOffset >= page.session.eventCount) nextOffset = null;
    return { ...page, events: page.events.filter(row => !excluded.has(row.index)), nextOffset,
      teachingEventCount: page.session.eventCount - excluded.size };
  }
  async function save(input: z.infer<typeof SaveInput>) {
    const draft = input.draft, config = await configuration();
    if (draft.tools.some(tool => /^mcp_(?:memmy|open)_computer_use_/.test(tool))) draft.executionMode = "desktop";
    if (!config.skillCreator.available) throw new Error("skill-creator dependency is unavailable");
    if (!config.toolNames.length) throw new Error("Host tool catalog is unavailable; cannot validate tool dependencies");
    const missing = draft.tools.filter(tool => !config.toolNames.includes(tool));
    if (missing.length) throw new Error(`Skill tool dependencies are unavailable: ${missing.join(", ")}`);
    if (draft.executionMode === "desktop" && !draft.tools.some(tool => desktopObservation.test(tool))) {
      throw new Error("Desktop execution requires a declared, available managed Computer Use get_app_state tool; exec/SendKeys cannot replace it");
    }
    if (["teach-mode", "record-and-replay", "teach-skill-creator", "skill-creator"].includes(draft.name)) throw new Error("Choose a distinct user skill name");
    const parent = path.join(dataDirectory, "generated-skills"), target = path.join(parent, draft.name);
    if (config.skills.some(skill => skill.name === draft.name && canonical(skill.path) !== canonical(path.join(target, "SKILL.md")))) throw new Error("Skill name already exists in this workspace or another plugin; choose another name");
    const first = await read(input.session_id, 0, 100, input.include_memmy), session = first.session;
    if (!first.teachingEventCount) throw new Error("No demonstration events remain after excluding recorder activity.");
    if (session.eventsSha256 !== input.events_sha256) throw new Error("Recording evidence hash changed; read the selected recording again");
    for (const [index, step] of draft.steps.entries()) {
      if (!step.evidenceIndexes.length && step.confirmedByUser !== true && step.evidenceStatus !== "user-specified"
        && !draft.teachingGaps.some(gap => gap.stepIndexes.includes(index))) throw new Error("Missing step evidence requires clarification in the conversation or an explicit unresolved teaching gap");
      if (step.evidenceStatus === "observed" && !step.evidenceIndexes.length) throw new Error("Observed steps require recorded action evidence");
      if (step.evidenceIndexes.some(index => index >= session.eventCount)) throw new Error("Skill references an event outside the selected recording");
    }
    if (draft.teachingGaps.some(gap => gap.stepIndexes.some(index => index >= draft.steps.length))) throw new Error("Teaching gap references a step outside the draft");
    const indexes = new Set(draft.steps.flatMap(step => step.evidenceIndexes));
    const selected = (events: unknown[]) => events.filter(event => indexes.has((event as { index: number }).index));
    const events = selected(first.events); let nextOffset = first.nextOffset;
    while (nextOffset !== null) {
      const page = await read(input.session_id, nextOffset, 100, input.include_memmy);
      if (page.session.eventsSha256 !== session.eventsSha256 || page.nextOffset === nextOffset) throw new Error("capture_evidence_changed");
      events.push(...selected(page.events)); nextOffset = page.nextOffset;
    }
    const teachingReview = reviewTeaching(draft, events, session, language === "zh-CN");
    const draftSha256 = digest(Buffer.from(JSON.stringify(draft)));
    const source = { schema: "memmy.recorded-skill/v1", pluginId: "teach-mode", sessionId: session.id,
      eventsSha256: session.eventsSha256, draftSha256, startedAt: session.startedAt, endedAt: session.endedAt,
      eventCount: session.eventCount, selectedEventIndexes: [...indexes], tools: draft.tools,
      executionMode: draft.executionMode,
      teachingReview: "references/teaching-gaps.json" };
    const limitations = [...new Set([...session.limitations, ...draft.limitations])];
    const markdown = ["---", `name: ${draft.name}`, `description: ${JSON.stringify(draft.description)}`,
      `metadata: ${JSON.stringify({ memmy: { requires: { tools: draft.tools } } })}`, "---", "",
      `# ${draft.name}`, "", draft.goal, "", "## Prerequisites", ...draft.prerequisites.map(value => `- ${value}`), "",
      "## Parameters", ...draft.parameters.map(parameter => `- \`${parameter.name}\`: ${parameter.description}${parameter.example ? ` (example: ${parameter.example}; replace for the current task)` : ""}`), "",
      ...(draft.executionMode === "desktop" ? ["## Execution boundaries", ...executionRules.map(rule => `- ${rule}`), ""] : []),
      "## Procedure", ...draft.steps.map((step, index) => {
        const status = teachingReview.steps[index]!.evidenceStatus;
        const cn = language === "zh-CN";
        const label = cn ? { observed: "已观察", "context-only": "仅有上下文依据", "user-specified": "用户指定", unverified: "待验证" }[status] : status;
        const citation = step.evidenceIndexes.length ? `${cn ? "，事件 " : ", events "}${step.evidenceIndexes.join(", ")}` : "";
        const guidance = step.replayInstruction ? `\n   ${cn ? "建议复现方式：" : "Suggested replay: "}${step.replayInstruction}` : "";
        return `${index + 1}. ${step.instruction} [${label}${citation}]${guidance}`;
      }), "",
      "## Teaching gaps",
      "Recording integrity and task coverage are separate. This skill has not passed independent execution validation.",
      ...(teachingReview.gaps.length ? teachingReview.gaps.map(gap => `- ${gap.description} [${gap.resolution}]. ${gap.nextAction}`)
        : ["- No task-specific gaps were declared in this review; this is not proof of complete teaching or successful execution."]),
      "Details: [teaching evidence review](references/teaching-gaps.json).", "",
      "## Completion checks", ...draft.completionChecks.map(value => `- ${value}`), "",
      "## Available tools", ...draft.tools.map(tool => `- \`${tool}\``), "",
      "## Evidence and limitations", "Source: [recording provenance](references/source.json) and [selected events](references/events.jsonl).",
      ...limitations.map(value => `- ${value}`), "- Generation does not prove execution. Run only when the user requests it and verify the current task's outputs.", ""].join("\n");
    validateResources(markdown);
    const files = { "SKILL.md": Buffer.from(markdown), "references/source.json": Buffer.from(JSON.stringify(source, null, 2)),
      "references/teaching-gaps.json": Buffer.from(JSON.stringify(teachingReview, null, 2)),
      "references/events.jsonl": Buffer.from(events.map(raw => {
        const row = raw as { index: number; source: unknown; event: { timestamp?: string; eventType?: string } };
        return JSON.stringify({ index: row.index, source: row.source, timestamp: row.event.timestamp, eventType: row.event.eventType });
      }).join("\n") + (events.length ? "\n" : "")) };
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
      execution: "not_run", usage: `Ask to use $${draft.name} in a subsequent conversation.`, limitations,
      teachingReview,
      presentation: { message: language === "zh-CN"
        ? `技能已保存。${teachingReview.gaps.length ? `仍有 ${teachingReview.gaps.length} 项教学缺口：${teachingReview.gaps.map(gap => gap.description + "；" + gap.nextAction).join(" / ")}` : "本次检查未声明具体教学缺口。"} 尚未完成新对话中的独立执行验证。`
        : `Skill saved. ${teachingReview.gaps.length ? `${teachingReview.gaps.length} teaching gaps remain: ${teachingReview.gaps.map(gap => gap.description + "; " + gap.nextAction).join(" / ")}` : "No task-specific teaching gaps were declared."} Independent execution has not been verified.` } };
  }
  return { initialize, async shutdown() { closing = true; },
    async invoke(capability: string, raw: unknown): Promise<Record<string, unknown>> {
      if (closing) throw new Error("teach_plugin_stopping");
      await initialize();
      if (capability === "record_and_replay") {
        const input = RecordingInput.parse(raw);
        const { view, include_memmy, ...hostInput } = input;
        if (input.action === "start") {
          if (input.consent === false) return { state: "cancelled", recordingStarted: false };
          return host("event-sessions", { ...hostInput, consent: true, ...(include_memmy && { includeMemmyApp: true }), recordingControls: "record-and-replay" });
        }
        if (input.action === "read") {
          if (!input.session_id) throw new Error("capture_session_id_required");
          const page = await read(input.session_id, input.offset, input.limit, include_memmy);
          return view === "teaching" ? teachingEvidence(page, undefined, language === "zh-CN") : page;
        }
        const result = await host<Record<string, unknown>>("event-sessions", hostInput);
        if (input.action === "stop" && result.state === "ready" && Number(result.eventCount) > 0) {
          const session = result as Session, excluded = await excludedIndexes(session, include_memmy);
          const teachingEventCount = session.eventCount - excluded.size;
          return { ...result, ...(excluded.size === 0 && evidencePaths(session)), teachingEventCount,
            next: teachingEventCount ? "When the user reports completion in chat, use Skill Creator with this session now. Wait for the user to report completion after a controls-only stop."
              : "The recording contains no events in the demonstration scope. Tell the user and finish without generating a skill." };
        }
        return result;
      }
      if (capability !== "create_skill") throw new Error("Unknown Teach Mode capability");
      const input = CreatorInput.parse(raw);
      if (input.action === "save") return save(input);
      if (!input.session_id) {
        const { sessions } = await host<{ sessions: Session[] }>("event-sessions", { action: "list" });
        return { recordings: sessions.filter(s => s.state === "ready" && s.eventCount > 0), requiresSelection: true,
          next: "Select the recording identified by the user; clarify when multiple recordings could match." };
      }
      const page = await read(input.session_id, 0, 100, input.include_memmy), config = await configuration();
      if (!page.teachingEventCount) return { session: page.session, teachingEventCount: 0, saved: false,
        next: "The recording contains no events in the demonstration scope. Tell the user and finish without generating a skill." };
      const guidance = { ...(page.teachingEventCount === page.session.eventCount && evidencePaths(page.session)),
        saveArguments: { action: "save", session_id: page.session.id, events_sha256: page.session.eventsSha256,
          ...(page.session.includeMemmyApp === undefined && input.include_memmy && { include_memmy: true }) },
        skillCreator: config.skillCreator, availableTools: config.toolNames,
        desktopExecution: desktopGuidance(config), teachingReviewRequired: true,
        next: `${page.session.availability === "partial" ? "This fragment has coverage gaps: retain the capture limitations and ask only about a missing action that affects the requested workflow. User clarification does not change recording completeness. " : ""}Use the Host Skill Creator instructions. The first page is included; do not read it again. For live UI declare executionMode=desktop and managed Computer Use tools; do not substitute exec or SendKeys. Inspect the action timeline and subsequent pages. Read relevant original events for omitted details. Use the cited row’s recordedAction verbatim for an observed instruction. Put any generalization or proposed method in replayInstruction. Page states alone provide context. Add draft to saveArguments to save. Ask only if an ambiguity changes the workflow, then save. Never execute the generated skill during creation.` };
      // Fit the normal Host 16k-character tool-result window, including creator
      // instructions, so the model can read evidence without unpacking a spill file.
      const budget = Math.max(1_000, 14_500 - JSON.stringify({ ...page, events: [], ...guidance }).length - 1_000);
      return { ...teachingEvidence(page, budget, language === "zh-CN"), ...guidance };
    }
  };
}
function reviewTeaching(draft: z.infer<typeof Draft>, events: unknown[], session: Session, cn: boolean) {
  const byIndex = new Map(events.map(value => {
    const row = value as { index: number; event?: { eventType?: string; details?: Record<string, unknown> } };
    return [row.index, row.event] as const;
  }));
  const gaps = draft.teachingGaps.map(gap => ({ ...gap }));
  const steps = draft.steps.map((step, index) => {
    if (step.evidenceIndexes.some(value => !byIndex.has(value))) throw new Error("Step references an event outside this demonstration. Use original indices from the teaching view.");
    const evidence = step.evidenceIndexes.map(value => byIndex.get(value));
    if (step.evidenceStatus === "observed" && ["date-time", "select"].includes(step.controlType ?? "")) {
      const supported = evidence.some(event => {
        const details = event?.details ?? {};
        const isDateTime = step.controlType === "date-time";
        const dateType = /^(date|datetime-local|time|month|week)$/;
        const selectRole = /^(select|option|combobox|listbox)$/;
        if (event?.eventType === "browser_action") {
          if (details.source !== "browser_history" || details.phase !== "observed" || details.actor !== "human") return false;
          const target = details.target as Record<string, unknown> | undefined;
          if (target?.sensitive || typeof target?.value !== "string" || !target.value.trim() || target.value.includes("[REDACTED]")) return false;
          return isDateTime
            ? (details.action === "input" || details.action === "change") && dateType.test(String(target.inputType))
            : details.action === "change" && (selectRole.test(String(target.role)) || /^(select|option)$/.test(String(target.tag)));
        }
        if (details.redacted === true || !(String(details.text ?? details.value ?? "").trim())) return false;
        return isDateTime
          ? ["text_input", "text_changed"].includes(event?.eventType ?? "") && dateType.test(String(details.inputType ?? ""))
          : ["selection_changed", "select_option", "change"].includes(event?.eventType ?? "") && selectRole.test(String(details.role ?? ""));
      });
      if (!supported) throw new Error(`Step ${index + 1}: ${step.controlType} has no matching recorded value/action. Mark it context-only or user-specified and retain a teaching gap; nearby navigation/click events are not proof.`);
    }
    // Never attach the observed label to creator prose on the strength of nearby indices.
    // For observed steps the instruction itself is a recorder-derived action. A reusable
    // target or proposed method lives separately in replayInstruction.
    let status = step.evidenceStatus;
    if (status === "observed" && !evidence.some(event => event && recordedAction(event, cn) === step.instruction)) {
      status = step.confirmedByUser ? "user-specified" : "context-only";
    }
    if (status !== "observed" && !gaps.some(gap => gap.stepIndexes.includes(index))) {
      const fromUser = status === "user-specified" || step.confirmedByUser === true;
      gaps.push({
        description: cn
          ? `步骤 ${index + 1}（${step.instruction}）：${fromUser ? "要求来自用户指令，录制未证明该动作" : status === "context-only" ? "只有相关页面或上下文证据，未证明具体操作" : "示范依据尚未确认"}。`
          : `Step ${index + 1} (${step.instruction}): ${fromUser ? "the requirement comes from user instructions; its action was not observed" : status === "context-only" ? "only page/context evidence is present, not the action" : "action evidence has not been verified"}.`,
        stepIndexes: [index], reason: "action-not-observed", resolution: fromUser ? "user-specified" : "needs-validation",
        nextAction: cn ? "补充示范该步骤，或在使用提供的参数执行时单独验证实际结果；不要声称已从录制学会。" : "Demonstrate this step or independently verify its actual result using the supplied parameters; do not claim it was learned from the recording.",
      });
    }
    return { index, evidenceStatus: status, evidenceIndexes: step.evidenceIndexes,
      ...(step.controlType ? { controlType: step.controlType } : {}) };
  });
  return { schema: "memmy.teaching-review/v1", status: gaps.length ? "gaps_identified" : "no_declared_gaps",
    assessmentScope: "Creator-declared task coverage and structural evidence checks; not an exhaustive semantic audit.",
    recordingAvailability: session.availability, execution: "not_run",
    steps, gaps };
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
    if (!["references/source.json", "references/events.jsonl", "references/teaching-gaps.json"].includes(target)) throw new Error(`Skill references an unavailable resource: ${target}`);
  }
}
