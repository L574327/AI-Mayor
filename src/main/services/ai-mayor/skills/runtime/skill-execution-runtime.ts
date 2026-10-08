import type { ActionEvidence, ActionSequence } from "../../v2/control-layer/types";
import type { ActionSequenceExecutor } from "../../v2/control-layer/executor";
import type { SkillAdapterContext } from "../adapters/port";
import type { SkillResult } from "../schemas/result";
import { compileSkillIntent } from "../registry/runtime";
import type { SkillRegistry } from "../registry/skill-registry";
import type { V2FoundationPorts } from "../../v2/main-adapter";
import { SkillIntentSchema } from "../schemas/intent";

export interface SkillEvidenceSink {
  readonly entries: readonly ActionEvidence[];
}

export async function executeSkillIntent(input: {
  registry: SkillRegistry;
  executor: ActionSequenceExecutor;
  intent: unknown;
  context?: SkillAdapterContext;
  evidence?: SkillEvidenceSink;
  signal?: AbortSignal;
}): Promise<SkillResult> {
  const sequence: ActionSequence = await compileSkillIntent(input.registry, input.intent, input.context);
  const execution = await input.executor.run(sequence, input.signal);
  return {
    skillId: execution.skillId,
    sequenceId: execution.sequenceId,
    status: execution.state === "SUCCESS" ? "SUCCESS" : "FAILED",
    context: execution,
    evidence: input.evidence?.entries ?? [],
  };
}

/** Production domain dispatch for durable V2 workflows. */
export async function executeProductionSkillIntent(input: {
  registry: SkillRegistry;
  foundation: Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">;
  intent: unknown;
  authoritativeContext: unknown;
  workflows: readonly ProductionSkillWorkflow[];
  signal?: AbortSignal;
}): Promise<SkillResult> {
  const intent = SkillIntentSchema.parse(input.intent);
  if (!input.registry.has(intent.skillId)) throw new Error(`unregistered production skill: ${intent.skillId}`);
  const workflow = input.workflows.find((candidate) => candidate.skillId === intent.skillId);
  if (!workflow) throw new Error(`unregistered production workflow: ${intent.skillId}`);
  return workflow.executeProduction(intent, input.authoritativeContext, input.signal);
}

export interface ProductionSkillWorkflow {
  readonly skillId: string;
  executeProduction(intent: unknown, authoritativeContext: unknown, signal?: AbortSignal): Promise<SkillResult>;
}
