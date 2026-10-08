import { z } from "zod";

export const SkillIntentSchema = z.object({
  skillId: z.string().trim().min(1).max(120),
  utilityKind: z.enum(["electricity", "water", "sewage"]).optional(),
  capabilityId: z.string().trim().min(1).max(120).optional(),
  strategyId: z.string().trim().min(1).max(120).optional(),
}).strict();
export type SkillIntentInput = z.infer<typeof SkillIntentSchema>;
