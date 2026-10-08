import type { SkillManifest } from "../schemas/manifest";

/** Definition boundary for future Skills; no concrete Skill is registered here. */
export interface SkillDefinition {
  readonly manifest: SkillManifest;
  validateIntent(input: unknown): { skillId: string };
}
