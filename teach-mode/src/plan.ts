import { z } from "zod";
import { TeachLocatorSchema, TeachUrlSchema, TeachWebActionSchema } from "./contracts.js";

// Both the executor and every export consume this compiled representation.
export const TeachPlanSchema = z.object({
  schema: z.literal("memmy.teach-plan/v1"), runtime: z.literal("memmy-web-notepad-v1"),
  openadaptAdmission: z.literal("not_admitted"),
  web: z.object({ backend: z.literal("web"), startUrl: TeachUrlSchema,
    actions: z.array(TeachWebActionSchema).max(2000),
    output: z.object({ name: z.literal("note_text"), sourceUrl: TeachUrlSchema, locator: TeachLocatorSchema }).strict(),
  }).strict(),
  desktop: z.object({ backend: z.literal("windows_notepad"), input: z.literal("web.note_text"),
    operations: z.tuple([z.literal("focus_editor"), z.literal("replace_text"), z.literal("save"), z.literal("verify_ui"), z.literal("verify_file")]),
    recordingId: z.string().uuid(), eventsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();
export type TeachPlan = z.infer<typeof TeachPlanSchema>;
