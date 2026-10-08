import { buildUrbanDesignDecisionPrompt, URBAN_DESIGN_DECISION_SYSTEM_PROMPT } from "../prompt";
import type { MayorRuntimePorts } from "../types";
import {
  parseUrbanDesignDecisionWire,
  type UrbanDesignDecision,
  urbanDesignDecisionHasNoExecutionFields,
} from "./decision";
import { resolveUrbanDesignIntent, type UrbanDesignIntentResolution } from "./intent";
import { readUrbanDesignSnapshot } from "./prompt-context";
import { UrbanDesignRealizationResultSchema } from "./realization";

export const PHASE5B_MAX_EXECUTED_CANDIDATES = 3;

export interface UrbanDesignDecisionEpisodeResult {
  decision: UrbanDesignDecision;
  resolution: UrbanDesignIntentResolution | null;
  realization: unknown | null;
}

/** Dedicated design-mode boundary. It never invokes the routine MayorPlan parser or action path. */
export async function decideUrbanDesignEpisode(input: {
  ports: Pick<MayorRuntimePorts, "decideUrbanDesign" | "realizeUrbanDesignIntent">;
  snapshot: unknown;
  goal: string;
  tick: number;
  playerDirection?: string | null;
  strategicContext?: { goal?: string; phase: string; strategy: string; operationalNote: string };
  model: string;
}): Promise<UrbanDesignDecisionEpisodeResult> {
  const decideUrbanDesign = input.ports.decideUrbanDesign;
  if (!decideUrbanDesign) throw new Error("dedicated urban design decision port is unavailable");
  const urbanDesign = readUrbanDesignSnapshot(input.snapshot);
  if (!urbanDesign) throw new Error("urban design SiteContext is unavailable for dedicated decision");

  const decisionResult = await decideUrbanDesign({
    systemPrompt: URBAN_DESIGN_DECISION_SYSTEM_PROMPT,
    userPrompt: buildUrbanDesignDecisionPrompt({
      goal: input.goal,
      tick: input.tick,
      urbanDesign,
      playerDirection: input.playerDirection,
      strategicContext: input.strategicContext,
    }),
    model: input.model,
  });
  const decision = parseUrbanDesignDecisionWire(decisionResult.content);
  if (!urbanDesignDecisionHasNoExecutionFields(decision))
    throw new Error("dedicated urban design decision contains execution fields");
  if (decision.status === "wait") return { decision, resolution: null, realization: null };
  const resolution = resolveUrbanDesignIntent({ value: decision.urbanDesignIntent, context: urbanDesign });
  if (!resolution.proposal) throw new Error("dedicated urban design decision did not produce a proposal");
  if (!input.ports.realizeUrbanDesignIntent) throw new Error("dedicated urban design realization port is unavailable");
  const realization = await input.ports.realizeUrbanDesignIntent(resolution.intent);
  return { decision, resolution, realization };
}

export async function executeUrbanDesignRealizationGroup(input: {
  ports: Pick<MayorRuntimePorts, "executeActions">;
  realization: unknown;
}) {
  const result = UrbanDesignRealizationResultSchema.parse(input.realization);
  if (result.status !== "realized" || result.candidateIds.length === 0)
    throw new Error("urban design realization group has no executable candidates");
  const candidateIds = result.candidateIds.slice(0, PHASE5B_MAX_EXECUTED_CANDIDATES);
  const actions = candidateIds.map((candidateId) => ({
    type: "choose_candidate" as const,
    candidateId,
    reason: "Execute the validated candidate produced by this urban design realization group.",
  }));
  const batch = await input.ports.executeActions(actions);
  return { candidateIds, actions, batch };
}
