import type { V2FoundationPorts } from "../../v2/main-adapter";
import type { GreenfieldUtilityKind } from "../../v2/greenfield-utility-bootstrap";
import {
  type UtilityFacilityRecipe,
  type UtilityPreparationInput,
  type UtilityPreparationResult,
  utilityPlanningScope,
  utilityFacilityRecipe,
} from "../../v2/utility-execution-planner";
import type { SkillResult } from "../schemas/result";
import type { AuthoritativeUtilityAdmissionContext } from "../../v2/utility-admission-context";
import { buildUtilityPreparationInput } from "../../v2/utility-admission-context";
import { K05IntentSchema } from "../definitions/k05-commission-utilities";
import { SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION } from "../../v2/sewage-environmental-safety";

/** The recipe family K05 has always carried: basic electricity provision. */
export const K05_ELECTRICITY_RECIPE = "basic-electricity-provision" as const;

/**
 * A K05 admission names the recipe family it is authorized under. It is not
 * free-form: `execute` re-derives the recipe the preparation's own kind must be
 * authorized by and refuses a mismatch, so the family is a redundant witness
 * rather than a second source of authority.
 */
export interface K05UtilityAdmission {
  recipeFamily: UtilityFacilityRecipe;
  preparation: UtilityPreparationInput;
}

/** @deprecated Use {@link K05UtilityAdmission}; K05 is no longer electricity-only. */
export type K05ElectricityAdmission = K05UtilityAdmission;

/**
 * K05 consumes the same authoritative admission contract every utility caller
 * uses — including the certified road Gate 1 delivered. It is an alias, not a
 * second shape, so a field added to production admission cannot silently go
 * missing here.
 */
export type K05AuthoritativeProductionContext = AuthoritativeUtilityAdmissionContext;

type K05WorkflowOutcome = Awaited<ReturnType<V2FoundationPorts["greenfieldUtilityBootstrap"]["run"]>>;

const failureResult = (reason: string): SkillResult => ({
  skillId: "skill.K05",
  sequenceId: "skill.K05.commission-utilities",
  status: "FAILED",
  error: reason,
  evidence: [],
});

/**
 * The one blocked outcome this Skill names.
 *
 * The contract's own terminal for "the diagnostic data a professional
 * judgement needs is not there". It is a typed reason on the existing FAILED
 * result, not a second lifecycle: telemetry-short, capability-short and
 * no-legal-site stay distinguishable by their reason text alone, and nothing
 * gains a new state.
 */
export type K05BlockedReason = "BLOCKED_TELEMETRY";

const blockedResult = (reason: K05BlockedReason, missingObservation: string): SkillResult => ({
  skillId: "skill.K05",
  sequenceId: "skill.K05.commission-utilities",
  status: "FAILED",
  error: `K05_${reason}:${missingObservation}`,
  evidence: [],
});

/**
 * The smallest observation that would let sewage environmental safety be
 * judged, rather than assumed.
 */
export { SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION };

/**
 * Whether the sewage recipe's environmental safety can be judged at all.
 *
 * The contract checks discharge/treatment capacity and environmental risk
 * together, and it is explicit that without water-flow data the claim
 * "pollution will not reach the intake" cannot be made — the one thing a
 * sewage plan may not do is guess a flow direction.
 *
 * There is no certified conservative alternative to fall back on. The
 * production recipe is an authorization marker, `basic-sewage-provision`, and
 * declares no applicable conditions — no discharge risk test, no intake
 * relation, nothing that could stand in for the missing telemetry. So the
 * shipment of a facility onto a legal shoreline proves that a facility fits,
 * and proves nothing about where its discharge goes.
 *
 * The verdict is therefore the contract's own BLOCKED_TELEMETRY, naming the
 * missing observation. The capability is not withdrawn: site selection,
 * connection and readback all still exist and this gate is the single place
 * that would lift, the moment the observation does.
 */
export function sewageEnvironmentalSafety(observation?: K05SewageEnvironmentalObservation): {
  certified: boolean;
  missingObservation: string;
} {
  // No observation supplied is the same answer as an unreadable one. A caller
  // that did not look must not be able to certify by omission.
  if (!observation) return { certified: false, missingObservation: SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION };
  if (!observation.available) {
    return {
      certified: false,
      missingObservation: observation.missingObservation ?? SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION,
    };
  }
  // The observations exist, so the question CAN be answered — per site, by
  // `certifySewageOutfallEnvironmentalSafety`, whose evidence rides on the plan
  // and is what the durable admission accepts. This gate is the layer above
  // that: it refuses to let a commissioning dispatch run when there is nothing
  // to judge with, and it is the single place that refusal lives.
  return { certified: true, missingObservation: "" };
}

/**
 * What the K05 gate needs to know about the world's water observation.
 *
 * `available` means both halves of the judgement are readable: the game's own
 * surface-water grid, and the authoritative census of water intakes. Either one
 * missing makes the question unanswerable, and an unanswerable question is the
 * contract's BLOCKED_TELEMETRY rather than a conservative guess.
 */
export interface K05SewageEnvironmentalObservation {
  available: boolean;
  missingObservation?: string;
  detail?: string;
}

/**
 * What a sewage dispatch is about to do to the world's discharge.
 *
 * `RISK_CHANGING` actions create or move an outfall, or add capacity that can
 * add real discharge — they change the environmental question, so they need
 * evidence for it. `RESTORE_AS_IS` actions put an existing, already-authorized
 * outfall back the way it was; they change nothing about where the discharge
 * goes or how much of it there is, so they do not need a NEW environmental
 * certification to be re-derived. `UNPROVEN` is every dispatch whose intent
 * does not say which of the two it is, and it fails closed: a strategy nobody
 * declared is not evidence that nothing is changing.
 */
export type K05SewageCommissioningKind = "RISK_CHANGING" | "RESTORE_AS_IS" | "UNPROVEN";

const SEWAGE_RISK_CHANGING_STRATEGIES: readonly string[] = [
  // A new facility, and a replacement that moves one, both put an outfall
  // somewhere it was not.
  "INITIAL_FACILITY_PLACEMENT",
  "FACILITY_REPLACEMENT_LAST_RESORT",
  // Extension can add capacity, and added capacity is added discharge.
  "EXTEND_EXISTING_NETWORK",
];
const SEWAGE_RESTORE_AS_IS_STRATEGIES: readonly string[] = [
  // Reuse of an existing reachable network, repair of a missing flow path, and
  // reconnection of a target all leave the outfall's identity, site, discharge
  // path and capacity as they were found.
  "REUSE_REACHABLE_NETWORK",
  "REPAIR_MISSING_FLOW_PATH",
  "RECONNECT_TARGET",
];

/**
 * Label a restore, and only a restore, as a restore.
 *
 * A `RESTORE_AS_IS` dispatch that succeeds has put an existing outfall back
 * into service; nothing established that its discharge is environmentally
 * safe, because nothing needed to — its discharge did not change. Tagging the
 * result keeps a reader from promoting that success into a certification it
 * never earned. A failure is left exactly as it is.
 */
const withRestoreSemantics = (result: SkillResult, restoreAsIs: boolean): SkillResult =>
  restoreAsIs && result.status === "SUCCESS" ? { ...result, successSemantics: "EXISTING_SERVICE_RESTORED" } : result;

export function classifySewageCommissioning(strategyId: string | undefined): K05SewageCommissioningKind {
  if (strategyId === undefined) return "UNPROVEN";
  if (SEWAGE_RISK_CHANGING_STRATEGIES.includes(strategyId)) return "RISK_CHANGING";
  if (SEWAGE_RESTORE_AS_IS_STRATEGIES.includes(strategyId)) return "RESTORE_AS_IS";
  return "UNPROVEN";
}

const resultFromOutcome = (outcome: K05WorkflowOutcome): SkillResult => ({
  skillId: "skill.K05",
  sequenceId: "skill.K05.commission-utilities",
  status: outcome.serviceCertified ? "SUCCESS" : outcome.waiting ? "WAITING" : "FAILED",
  // A terminal run failure must name the durable reason it stopped on; otherwise
  // the caller sees a bare FAILED and cannot act on it.
  ...(outcome.serviceCertified || outcome.waiting ? {} : { error: `K05_RUN_BLOCKED:${outcome.reason}` }),
  evidence: [],
  durableOutcome: outcome,
});

/**
 * Production K05 binding. Admission identity is supplied by the existing V2
 * caller; this adapter never invents scope, project, tranche, or world data.
 */
export class K05CommissionUtilitiesWorkflowAdapter {
  readonly skillId = "skill.K05";

  constructor(
    private readonly foundation: Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">,
    /**
     * The authoritative observation the environmental gate reads.
     *
     * Optional so a caller with no world access — a fixture, a replay — keeps
     * the fail-closed behaviour instead of having to fake an observation.
     */
    private readonly readSewageEnvironmentalObservation?: (
      signal?: AbortSignal,
    ) => Promise<K05SewageEnvironmentalObservation>,
  ) {}

  async execute(admission: K05UtilityAdmission, signal?: AbortSignal, mandate?: readonly GreenfieldUtilityKind[]): Promise<SkillResult> {
    // The recipe family must be the one the preparation's kind is provided by.
    // A caller that pairs the water recipe with an electricity preparation (or
    // the reverse) is refused rather than silently served as the wrong family.
    if (admission.recipeFamily !== utilityFacilityRecipe(admission.preparation.kind)) {
      return failureResult("K05_RECIPE_KIND_MISMATCH");
    }

    const prepared: UtilityPreparationResult =
      await this.foundation.greenfieldUtilityBootstrap.prepare(admission.preparation, signal);
    if (prepared.status !== "READY") {
      // A native preview verdict rejects this exact candidate. Let the durable
      // bootstrap record that candidate result, reconcile submitted history,
      // and advance its bounded planner instead of turning K05 into a terminal
      // prepare failure.
      if (prepared.reason === "DIRECT_CABLE_PREFLIGHT_REJECTED") {
        const scope = mandate
          ? { ...utilityPlanningScope(admission.preparation), commissionedKinds: mandate }
          : utilityPlanningScope(admission.preparation);
        const outcome = await this.foundation.greenfieldUtilityBootstrap.run(scope, signal);
        return resultFromOutcome(outcome);
      }
      // The blocked reason is a stable product code; the underlying preparation
      // reason is the actionable one. Surface it when the planner recorded it.
      const cause = prepared.diagnostics?.preparationReason;
      const rejections = prepared.diagnostics?.connectionDiagnostics;
      const firstRejection = Array.isArray(rejections) ? (rejections[0] as { reason?: unknown } | undefined) : undefined;
      const rejectionReason = firstRejection && typeof firstRejection.reason === "string" ? firstRejection.reason : undefined;
      const suffix = [
        typeof cause === "string" && cause.length > 0 && cause !== prepared.reason ? cause : undefined,
        rejectionReason && rejectionReason !== cause ? rejectionReason : undefined,
      ].filter((part): part is string => part !== undefined).map((part) => ":" + part).join("");
      // A durable placement operation that may already have mutated the world
      // is not a failed intent: the work is unresolved and must be reconciled
      // before anything else is submitted. Report WAITING, never SUCCESS and
      // never a plain failure a caller might retry into a second placement.
      if (prepared.reason === "UTILITY_FACILITY_PLACEMENT_UNRESOLVED") {
        return {
          skillId: "skill.K05",
          sequenceId: "skill.K05.commission-utilities",
          status: "WAITING",
          error: `K05_PREPARE_HELD:${prepared.reason}${suffix}`,
          evidence: [],
        };
      }
      const diagnostics = prepared.diagnostics
        ? `:DIAGNOSTICS=${JSON.stringify(prepared.diagnostics).slice(0, 1200)}`
        : "";
      return failureResult(`K05_PREPARE_BLOCKED:${prepared.reason}${suffix}${diagnostics}`);
    }

    // Both READY admissions carry an execution scope. A first-placement
    // admission has placed nothing yet: `run()` performs the placement and the
    // connection through the existing durable utility execution boundary.
    // A caller that declares a narrower mandate — a bounded single-family
    // capability proof — passes it here, so the bootstrap drives exactly the
    // families that caller is authorized to commission. No mandate is the full
    // commissioning request, which is what every production caller means.
    const scope = mandate ? { ...prepared.executionScope, commissionedKinds: mandate } : prepared.executionScope;
    const outcome = await this.foundation.greenfieldUtilityBootstrap.run(scope, signal);
    return resultFromOutcome(outcome);
  }

  async executeProduction(intent: unknown, context: K05AuthoritativeProductionContext, signal?: AbortSignal): Promise<SkillResult> {
    // Validated against the Skill's own contract, not asserted past it. The
    // fields read below are exactly the ones the manifest's intent schema
    // admits, so a dispatch the contract does not describe cannot reach the
    // execution boundary at all — it stops here with a typed result instead.
    const parsedIntent = K05IntentSchema.safeParse(intent);
    if (!parsedIntent.success) return failureResult("K05_INTENT_INVALID");
    const utilityKind: GreenfieldUtilityKind | undefined = parsedIntent.data.utilityKind;
    const strategyId = parsedIntent.data.strategyId;
    // Refused before anything is read, planned or placed: a judgement that
    // cannot be made must not be replaced by a facility that happens to fit.
    //
    // Only the dispatches that change the discharge question are held to it.
    // Restoring an outfall that already exists, on its own site, over its own
    // path, with no added capacity, changes nothing for the environment to
    // answer — and its success is labelled `EXISTING_SERVICE_RESTORED` further
    // down so it is never read as an environmental certification. Whether the
    // identity and path really are unchanged is the existing facility binding's
    // and readback's question, already enforced on the execution path; asking
    // it again here would be a second, weaker answer to it.
    let restoreAsIs = false;
    if (utilityKind === "sewage") {
      const commissioning = classifySewageCommissioning(strategyId);
      if (commissioning === "RESTORE_AS_IS") {
        restoreAsIs = true;
      } else {
        const observation = this.readSewageEnvironmentalObservation
          ? await this.readSewageEnvironmentalObservation(signal)
          : undefined;
        const safety = sewageEnvironmentalSafety(observation);
        if (!safety.certified) return blockedResult("BLOCKED_TELEMETRY", safety.missingObservation);
      }
    }
    const scopedContext = utilityKind ? { ...context, kind: utilityKind } : context;
    const preparation = buildUtilityPreparationInput(scopedContext);
    if (utilityKind === "electricity" && strategyId && strategyId !== "FACILITY_REPLACEMENT_LAST_RESORT") {
      // A post-connection Network Reachability strategy must resume the live
      // topology-derived Utility plan. Re-running recipe preparation first
      // rebuilds the obsolete facility-origin cable and repeats its known
      // native rejection before the durable planner can consume its repair
      // candidate. This still uses K05's existing Utility planner/executor;
      // only the stale preflight detour is skipped.
      return resultFromOutcome(await this.foundation.greenfieldUtilityBootstrap.run({
        ...utilityPlanningScope(preparation), commissionedKinds: [utilityKind],
      }, signal));
    }
    const candidatePreference = strategyId === "REPAIR_MISSING_FLOW_PATH"
      ? ["direct-cable", "service-road", "facility-access-road"] as const
      : strategyId === "EXTEND_EXISTING_NETWORK"
        ? ["service-road", "direct-cable", "facility-access-road"] as const
        : strategyId === "RECONNECT_TARGET"
          ? ["facility-access-road", "direct-cable", "service-road"] as const
          : undefined;
    if (candidatePreference) preparation.candidatePreference = [...candidatePreference];
    return withRestoreSemantics(
      await this.execute({ recipeFamily: utilityFacilityRecipe(preparation.kind), preparation }, signal,
        utilityKind ? [utilityKind] : undefined),
      restoreAsIs,
    );
  }
}
