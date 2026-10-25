import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostInvoker } from "./host.js";

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
  parameters: z.array(z.object({ name: identifier, description: z.string().min(1), example: z.string().optional() })).max(30),
  steps: z.array(z.object({ instruction: z.string().trim().min(1).max(4_000),
    evidenceIndexes: z.array(z.number().int().nonnegative()).max(100),
    confirmedByUser: z.boolean().optional(),
    evidenceStatus: z.enum(["observed", "context-only", "user-specified", "unverified"]).default("unverified"),
    controlType: z.enum(["text", "date-time", "select", "other"]).optional() })).min(1).max(100),
  tools: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).min(1).max(30),
  executionMode: z.enum(["agent-tools", "desktop"]).default("agent-tools"),
  completionChecks: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  limitations: z.array(z.string().trim().min(1)).max(30),
  teachingGaps: z.array(TeachingGap).max(100).default([]),
}).strict();
type Session = { id: string; state: string; availability: string; eventsSha256: string | null; eventCount: number;
  goal: string; startedAt: string; endedAt: string | null; limitations: string[] };
type Configuration = { version: number; features?: string[]; supported: boolean; toolNames: string[]; skills: Array<{ name: string; path: string }>; skillCreator: { available: boolean; instructions?: string } };
const desktopObservation = /^mcp_(?:memmy|open)_computer_use_get_app_state$/;
const executionRules = [
  "For live desktop UI steps, load the Host computer-use skill and use the managed Computer Use tools. exec is for non-UI commands, not a desktop-input fallback.",
  "Observe the intended application and document before acting. Use the current observation_id and exact window_id; confirm the requested file is the active document, not an earlier demonstration or another tab.",
  "A launcher PID is not proof of the target window: Windows Notepad may hand the file to an existing process. Resolve the actual document through Computer Use before sending any input.",
  "Do not use PowerShell SendKeys, WScript.Shell, SetForegroundWindow, SendInput or raw key injection to replace Computer Use. If the required native tools are unavailable, stop the affected UI steps and report the missing dependency.",
  "Use set_value for a supported text control, or type_text with the native helper's foreground option when needed. Send literal text through the helper rather than keyboard-layout/IME-dependent SendKeys strings.",
  "After each action, inspect fresh state. Independently read the requested output file and compare its content; an empty or wrong file, or a change to a different document, is an execution failure.",
];
function desktopGuidance(config: Configuration) {
  const observationTool = config.toolNames.find(tool => desktopObservation.test(tool)) ?? null;
  return { available: observationTool !== null, observationTool,
    tools: config.toolNames.filter(tool => /^mcp_(?:memmy|open)_computer_use_/.test(tool)),
    rules: executionRules };
}
const Input = z.object({ action: z.string(), session_id: z.string().uuid().optional(), goal: z.string().optional(),
  browser: z.object({ name: z.enum(["chrome", "edge"]), connection_id: z.string().min(1).max(100).optional() }).strict().optional(),
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
    if (!config.features.includes("memmy.event-checkpoints/v1")) throw new Error("Teach Mode requires Host ordered event checkpoints; update the desktop app before recording");
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
      message: usable ? session.availability === "partial"
        ? cn ? "录制片段已保留，部分操作未能确认完整。请先核对缺口，再让我使用 Skill Creator 生成 skill。" : "The recording was retained with coverage gaps. Review missing steps before requesting Skill Creator."
        : cn ? "本次录制已结束，可以继续让我根据这段操作生成 skill。" : "Recording ended. Ask me to generate a skill from these operations."
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
    if (draft.executionMode === "desktop" && !draft.tools.some(tool => desktopObservation.test(tool))) {
      throw new Error("Desktop execution requires a declared, available managed Computer Use get_app_state tool; exec/SendKeys cannot replace it");
    }
    if (["teach-mode", "record-and-replay", "teach-skill-creator", "skill-creator"].includes(draft.name)) throw new Error("Choose a distinct user skill name");
    const parent = path.join(dataDirectory, "generated-skills"), target = path.join(parent, draft.name);
    if (config.skills.some(skill => skill.name === draft.name && canonical(skill.path) !== canonical(path.join(target, "SKILL.md")))) throw new Error("Skill name already exists in this workspace or another plugin; choose another name");
    const first = await read(input.session_id), session = first.session;
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
      const page = await read(input.session_id, nextOffset);
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
      "## Execution boundaries", ...executionRules.map(rule => `- ${rule}`), "",
      "## Procedure", ...draft.steps.map((step, index) => `${index + 1}. ${step.instruction} (${step.evidenceIndexes.length ? `source events: ${step.evidenceIndexes.join(", ")}` : step.evidenceStatus === "user-specified" ? "user-specified requirement; action not observed" : step.confirmedByUser ? "user-confirmed clarification; action not observed" : "action not observed"})`), "",
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
      execution: "not_run", usage: `Ask to use $${draft.name} in a subsequent conversation.`, limitations,
      teachingReview,
      presentation: { message: language === "zh-CN"
        ? `技能已保存。${teachingReview.gaps.length ? `仍有 ${teachingReview.gaps.length} 项教学缺口：${teachingReview.gaps.map(gap => gap.description + "；" + gap.nextAction).join(" / ")}` : "本次检查未声明具体教学缺口。"} 尚未完成新对话中的独立执行验证。`
        : `Skill saved. ${teachingReview.gaps.length ? `${teachingReview.gaps.length} teaching gaps remain: ${teachingReview.gaps.map(gap => gap.description + "; " + gap.nextAction).join(" / ")}` : "No task-specific teaching gaps were declared."} Independent execution has not been verified.` } };
  }
  return { initialize, async shutdown() { closing = true; },
    async invoke(capability: string, raw: unknown): Promise<Record<string, unknown>> {
      if (closing) throw new Error("teach_plugin_stopping");
      await initialize(); const input = Input.parse(raw);
      if (capability === "record_and_replay") {
        if (!["status", "list", "start", "stop", "cancel", "read", "browser-options"].includes(input.action)) throw new Error("Unknown event recording action");
        if ((input.browser || input.action === "browser-options") && !(await configuration()).features?.includes("memmy.browser-event-sessions/v1")) {
          throw new Error("Browser teaching requires Host browser-event-sessions/v1; update the desktop app");
        }
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
      return { ...page, skillCreator: config.skillCreator, availableTools: config.toolNames, desktopExecution: desktopGuidance(config), teachingReviewRequired: true,
        next: `${page.session.availability === "partial" ? "This fragment has coverage gaps: review its limitations with the user before generation. User clarification does not change the original recording completeness. " : ""}Load the Host Skill Creator instructions and read all selected event pages. For a workflow requiring live desktop UI, set executionMode=desktop and declare the actual managed Computer Use observation/action tools from availableTools; do not substitute exec or SendKeys. If native tools are absent, report the missing dependency rather than presenting shell UI automation as usable. Classify each step's evidenceStatus as observed, context-only, user-specified, or unverified. A page navigation or nearby click does not prove a date input, dropdown selection, field reading or successful outcome. Set controlType for form inputs and list missing actions/parameters/outcomes in teachingGaps with affected stepIndexes, reason, resolution and nextAction. Existing user instructions may supply missing requirements without a new clarification; classify those as user-specified without inventing confirmedByUser. They do not make an unrecorded action observed. Save may retain unresolved gaps; report them explicitly and do not call the skill execution-validated. Generation and execution are separate.` };
    }
  };
}
function reviewTeaching(draft: z.infer<typeof Draft>, events: unknown[], session: Session, cn: boolean) {
  const byIndex = new Map(events.map(value => {
    const row = value as { index: number; event?: { eventType?: string; details?: Record<string, unknown> } };
    return [row.index, row.event] as const;
  }));
  const gaps = draft.teachingGaps.map(gap => ({ ...gap }));
  for (const [index, step] of draft.steps.entries()) {
    if (step.evidenceIndexes.some(value => !byIndex.has(value))) throw new Error("Referenced teaching evidence was not returned by the Host");
    const evidence = step.evidenceIndexes.map(value => byIndex.get(value));
    if (step.evidenceStatus === "observed" && ["date-time", "select"].includes(step.controlType ?? "")) {
      const supported = evidence.some(event => {
        const details = event?.details ?? {};
        if (details.redacted === true || !(String(details.text ?? details.value ?? "").trim())) return false;
        return step.controlType === "date-time"
          ? ["text_input", "text_changed"].includes(event?.eventType ?? "")
            && /^(date|datetime-local|time|month|week)$/.test(String(details.inputType ?? ""))
          : ["selection_changed", "select_option", "change"].includes(event?.eventType ?? "")
            && /^(select|option|combobox|listbox)$/.test(String(details.role ?? ""));
      });
      if (!supported) throw new Error(`Step ${index + 1}: ${step.controlType} has no matching recorded value/action. Mark it context-only or user-specified and retain a teaching gap; nearby navigation/click events are not proof.`);
    }
    if (step.evidenceStatus !== "observed" && !gaps.some(gap => gap.stepIndexes.includes(index))) {
      const fromUser = step.evidenceStatus === "user-specified" || step.confirmedByUser === true;
      gaps.push({
        description: cn
          ? `步骤 ${index + 1}（${step.instruction}）：${fromUser ? "要求来自用户指令，录制未证明该动作" : step.evidenceStatus === "context-only" ? "只有相关页面或上下文证据，未证明具体操作" : "示范依据尚未确认"}。`
          : `Step ${index + 1} (${step.instruction}): ${fromUser ? "the requirement comes from user instructions; its action was not observed" : step.evidenceStatus === "context-only" ? "only page/context evidence is present, not the action" : "action evidence has not been verified"}.`,
        stepIndexes: [index], reason: "action-not-observed", resolution: fromUser ? "user-specified" : "needs-validation",
        nextAction: cn ? "补充示范该步骤，或在使用提供的参数执行时单独验证实际结果；不要声称已从录制学会。" : "Demonstrate this step or independently verify its actual result using the supplied parameters; do not claim it was learned from the recording.",
      });
    }
  }
  if (session.availability === "partial" && !gaps.some(gap => gap.reason === "capture-gap")) {
    gaps.push({ description: cn ? "源录制存在完整性缺口，未覆盖部分的操作无法确认。" : "The source recording has capture gaps; actions in the missing interval are not confirmed.",
      stepIndexes: [], reason: "capture-gap", resolution: "needs-demonstration",
      nextAction: cn ? "核对录制限制并补录缺失步骤；文字补充不能改变原始录制完整性。" : "Review capture limitations and demonstrate the missing steps; clarification does not change the original capture integrity." });
  }
  return { schema: "memmy.teaching-review/v1", status: gaps.length ? "gaps_identified" : "no_declared_gaps",
    assessmentScope: "Creator-declared task coverage and structural evidence checks; not an exhaustive semantic audit.",
    recordingAvailability: session.availability, execution: "not_run",
    steps: draft.steps.map((step, index) => ({ index, evidenceStatus: step.evidenceStatus,
      evidenceIndexes: step.evidenceIndexes, ...(step.controlType ? { controlType: step.controlType } : {}) })), gaps };
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
