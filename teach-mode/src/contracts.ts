import { z } from "zod";

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const TeachUrlSchema = z.string().max(4096).url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "An HTTP(S) URL without credentials is required");
export const TeachLocatorSchema = z.object({ selector: z.string().min(1).max(2000), tag: z.string().min(1).max(40),
  name: z.string().max(240), heading: z.string().max(240),
}).strict();
export const TeachWebActionSchema = z.object({ sequence: z.number().int().positive(), timeMs: z.number().nonnegative(),
  type: z.enum(["click", "fill", "press", "scroll", "navigation", "output", "unsupported"]), url: TeachUrlSchema,
  locator: TeachLocatorSchema.nullable(), value: z.string().max(20000).optional(),
}).strict();
export const TeachOutputSchema = z.object({ name: z.literal("note_text"), sourceUrl: TeachUrlSchema,
  locator: TeachLocatorSchema, text: z.string().min(1).max(20000), sha256: hash,
  observedAt: z.string(), evidence: z.string().regex(/^web\/[a-z0-9-]+\.png$/u),
}).strict();
export const TeachSegmentSchema = z.object({ id, backend: z.enum(["web", "windows_notepad"]),
  state: z.enum(["recording", "sealed", "failed"]), startedAt: z.string(), stoppedAt: z.string().nullable(),
  offsetMs: z.number().nonnegative(), recordingId: id.nullable(), eventCount: z.number().int().nonnegative(),
  eventsSha256: hash.nullable(), missing: z.array(z.string()),
}).strict();
export const TeachNotepadTargetSchema = z.object({ pid: z.number().int().positive(), hwnd: z.string().regex(/^[1-9][0-9]*$/u),
  processStart: z.string().min(1), executable: z.string().min(1), file: z.string().min(1),
  editorBackend: z.enum(["uia", "win32_edit"]).optional(),
}).strict();
export const TeachRunSchema = z.object({ id, state: z.enum(["running", "succeeded", "failed", "cancelled"]),
  startedAt: z.string(), stoppedAt: z.string().nullable(), sourceUrl: TeachUrlSchema.nullable(),
  outputText: z.string().max(20000).nullable(), outputSha256: hash.nullable(), file: z.string().nullable(),
  fileSha256: hash.nullable(), uiReadbackMatched: z.boolean(), fileReadbackMatched: z.boolean(),
  error: z.string().nullable(),
}).strict();
export const TeachArtifactExportSchema = z.object({ state: z.enum(["ready", "failed"]),
  skillName: z.string().regex(/^teach-[a-f0-9-]{36}$/u), planSha256: hash, generatedAt: z.string(),
  error: z.string().nullable(),
}).strict();
export const TeachSessionSchema = z.object({ schemaVersion: z.literal(1), id, title: z.string().min(1).max(200),
  state: z.enum(["starting", "recording_web", "switching", "recording_desktop", "ready", "running", "failed", "cancelled"]),
  createdAt: z.string(), stoppedAt: z.string().nullable(), startUrl: TeachUrlSchema,
  segments: z.array(TeachSegmentSchema).max(32), output: TeachOutputSchema.nullable(),
  desktop: TeachNotepadTargetSchema.nullable(), planSha256: hash.nullable(), runs: z.array(TeachRunSchema).max(100),
  error: z.string().nullable(), runtime: z.literal("memmy-web-notepad-v1"),
  openadaptAdmission: z.literal("not_admitted"),
  artifactExport: TeachArtifactExportSchema.nullable().optional(),
  privacy: z.object({ localOnly: z.literal(true), audio: z.literal(false), rawVisibleFrames: z.literal(true) }).strict(),
}).strict();
export const TeachStartSchema = z.object({ title: z.string().trim().min(1).max(200), url: TeachUrlSchema,
  consent: z.literal(true),
}).strict();
export const TeachRunInputSchema = z.object({ consent: z.literal(true) }).strict();
export const TeachConfigurationSchema = z.object({ supported: z.boolean(), reason: z.string().nullable(),
  outputDirectory: z.string(), browser: z.enum(["msedge", "chrome", "chromium"]),
}).strict();
export type TeachSession = z.infer<typeof TeachSessionSchema>;
export type TeachSegment = z.infer<typeof TeachSegmentSchema>;
export type TeachStart = z.infer<typeof TeachStartSchema>;
export type TeachOutput = z.infer<typeof TeachOutputSchema>;
export type TeachLocator = z.infer<typeof TeachLocatorSchema>;
export type TeachWebAction = z.infer<typeof TeachWebActionSchema>;
export type TeachNotepadTarget = z.infer<typeof TeachNotepadTargetSchema>;
export type TeachRun = z.infer<typeof TeachRunSchema>;
