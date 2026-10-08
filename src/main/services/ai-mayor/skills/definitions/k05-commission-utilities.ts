import { z } from "zod";
import { SkillIntentSchema } from "../schemas/intent";
import type { SkillDefinition } from "./types";

/**
 * What this Skill actually is.
 *
 * The previous text said `planning-only` / "without executing construction",
 * which the adapter, the Brain and the live world had all left behind: this
 * Skill plans, selects a strategy, and then *commissions* — it runs the
 * existing durable utility workflow, which places the facility, submits the
 * connection through the native boundary and reads the result back. The
 * description is corrected to the behaviour rather than the behaviour narrowed
 * to the description.
 *
 * The boundary it does NOT cross is the important half: every mutation goes
 * through the existing durable/native execution contract. This Skill never
 * writes the world itself, and nothing here authorizes it to.
 */
export const K05_COMMISSION_UTILITIES_MANIFEST = Object.freeze({
  schemaVersion: 1 as const,
  id: "skill.K05",
  version: "1.0.0",
  name: "Commission Utilities",
  description:
    "Plans a bounded utility commissioning sequence, selects a strategy, and commissions it through the existing durable execution boundary.",
  adapterId: "commission-utilities",
  capabilities: ["utility-planning", "utility-execution"],
  metadata: { execution: "bounded-commissioning" },
});

/**
 * The intent this Skill is dispatched with.
 *
 * Built from the shared, already-real production intent shape rather than
 * declared again here: the Brain dispatches `utilityKind`, `capabilityId` and
 * `strategyId` alongside the skill id, and a K05-local schema that admitted
 * only `{ skillId }` was a contract the production path had to assert its way
 * past. What is dispatched is what is validated; nothing is added that the
 * dispatch does not send.
 */
const K05IntentSchema = SkillIntentSchema.extend({
  skillId: z.literal(K05_COMMISSION_UTILITIES_MANIFEST.id),
});
export type K05CommissionUtilitiesIntent = z.infer<typeof K05IntentSchema>;

export { K05IntentSchema };

export const K05CommissionUtilitiesDefinition: SkillDefinition = {
  manifest: K05_COMMISSION_UTILITIES_MANIFEST,
  validateIntent(input: unknown): K05CommissionUtilitiesIntent {
    return K05IntentSchema.parse(input);
  },
};
