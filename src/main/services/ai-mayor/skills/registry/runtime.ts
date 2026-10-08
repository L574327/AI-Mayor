import { CommissionUtilitiesAdapter } from "../adapters/k05-commission-utilities";
import type { SkillAdapterContext, SkillIntent } from "../adapters/port";
import { K05CommissionUtilitiesDefinition } from "../definitions/k05-commission-utilities";
import { SkillIntentSchema } from "../schemas/intent";
import { SkillRegistry, type RegisteredSkill } from "./skill-registry";

export function createSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(
    K05CommissionUtilitiesDefinition.manifest,
    new CommissionUtilitiesAdapter(),
    K05CommissionUtilitiesDefinition,
  );
  return registry;
}

export async function compileSkillIntent(
  registry: SkillRegistry,
  input: unknown,
  context: SkillAdapterContext = { observation: null },
) {
  const intent: SkillIntent = SkillIntentSchema.parse(input);
  const entry: RegisteredSkill | undefined = registry.get(intent.skillId);
  if (!entry) throw new Error(`Skill is not registered: ${intent.skillId}`);
  if (!entry.definition || !entry.adapter) throw new Error(`Skill is not compilable: ${intent.skillId}`);
  const validatedIntent = entry.definition.validateIntent(intent);
  return entry.adapter.compile(validatedIntent, entry.manifest, context);
}
