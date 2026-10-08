import { z } from "zod";

const skillId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/);
const version = z.string().trim().min(1).max(32).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

/** Stable contract for registering a Skill without importing its implementation. */
export const SkillManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: skillId,
    version,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(500),
    adapterId: skillId.optional(),
    capabilities: z.array(skillId).max(32).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export function parseSkillManifest(input: unknown): SkillManifest {
  return SkillManifestSchema.parse(input);
}
