import {
  FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX,
  facilityAccessRoadRepairAttemptIndexFromLineage,
} from "./facility-access-road";
import type { Gate1State } from "./gate1";
import type {
  NativeWorldIdentity,
  V2DurableActivationStatus,
  V2UtilityBudgetAmendmentRecord,
} from "./durability";
import type { V2ProjectAdmissionPolicy } from "./project-admission";
import type { FirstFacilityPlacementDurability } from "./utility-placement-durability";
import { stableRoadInput } from "./finance";

/** The one reason a project's plan is ever funded beyond its admitted budget. */
export const UTILITY_BUDGET_AMENDMENT_REASON = "UTILITY_PLAN_MINIMUM_FEASIBLE_BUDGET" as const;

/**
 * The one reason a project's CONNECTION is ever funded beyond its admitted
 * budget.
 *
 * A separate reason from the plan funding above because the two are answers to
 * different questions, and the difference is the whole point of this second
 * mechanism. Plan funding asks "does the admitted budget cover the plan this
 * project's own reservation justifies", and it is asked at admission, before
 * anything exists. This asks "does it cover the course the execution will
 * ACTUALLY submit", and that course cannot be priced until the facility exists:
 * its start is the facility's connector, a prefab-determined point on the
 * facility footprint that nothing can observe before the facility lands.
 *
 * Admission prices what it can prove — the plan's own `connection.start`, which
 * is the facility CENTRE — and that figure is an allowance, not the cost. Once
 * the facility has authoritatively landed, the real connector is knowable, the
 * native spending contract can be asked for the real course, and this reason
 * records the one bounded correction between them.
 */
export const UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON = "UTILITY_CONNECTION_BUDGET_AMENDMENT" as const;

/**
 * The one reason a project's ROAD ACCESS REPAIR is ever funded beyond its
 * admitted budget.
 *
 * A third reason rather than a reuse of the connection one, because it funds a
 * different course at a different moment. The connection settlement is decided
 * once the facility has landed and BEFORE any connection command exists; this
 * one is decided when the connection the worlds needs turns out to be a road,
 * after the pipe the plan called for has already been built and observed. The
 * two cannot share a record: the settlement's figures are the connection's own
 * allowance and quote, and reusing its slot would make a repair indistinguishable
 * from a settlement in the durable history.
 */
export const FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON =
  "FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT" as const;
export const UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON =
  "UTILITY_SERVICE_ROAD_CHILD_OPERATION" as const;

/**
 * Where a cost figure in a {@link UtilityPlanBudgetRequirement} came from.
 *
 * Kept per-figure rather than per-requirement because the two figures have
 * genuinely different sources, and a requirement that claimed one source for
 * both would be lying about one of them.
 */
export type UtilityBudgetCostSource =
  /** The authoritative asset catalogue entry the plan was built from. */
  | "PLAN_ASSET_COST"
  /** The native spending contract's own quote for the primitive. */
  | "NATIVE_SPENDING_CONTRACT";

/**
 * What the currently-selected legal utility plan costs to finish, expressed as
 * the spend the project must be authorized for.
 *
 * The scope of the number is NOT a guess: the native boundary that ultimately
 * refuses an over-budget execution compares
 * `otherAuthorizedSpend + authorizedSpend + quoted > scope.maximumSpend`, and it
 * runs that comparison for the facility AND for every connection primitive. So
 * `maximumSpend` covers facility + connection primitives, and a budget that
 * covers only the facility admits an execution that places the facility and then
 * has its pipe refused — a placed-but-unconnected facility, which is worse than
 * a refusal because it is a half-delivered slice.
 *
 * `facilityCost` therefore comes from the plan's authoritative asset cost, and
 * `connectionCost` — for which the plan carries no cost at all, only a prefab —
 * from the existing native spending contract. Neither is hard-coded per family:
 * a domain that ships a cheaper facility, or a shorter pipe, gets a smaller
 * requirement for free.
 */
export interface UtilityPlanBudgetRequirement {
  kind: "electricity" | "water" | "sewage";
  facilityPrefab: string;
  facilityCost: number;
  facilityCostSource: UtilityBudgetCostSource;
  connectionPrefab: string;
  connectionCost: number;
  connectionCostSource: UtilityBudgetCostSource;
  /** `facilityCost + connectionCost`. The spend the slice must be authorized for. */
  requiredSpend: number;
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Assemble a requirement from already-authoritative figures.
 *
 * Pure, and validating rather than coercing: a non-finite or negative figure is
 * a source that failed, and a requirement built from it would authorize an
 * unknown spend. Both are refused here so no caller has to remember to.
 */
export function minimumFeasibleUtilityBudget(input: {
  kind: UtilityPlanBudgetRequirement["kind"];
  facilityPrefab: string;
  facilityCost: number;
  connectionPrefab: string;
  connectionCost: number;
}): UtilityPlanBudgetRequirement {
  if (!finiteNonNegative(input.facilityCost)) throw new Error("UTILITY_BUDGET_FACILITY_COST_UNKNOWN");
  if (!finiteNonNegative(input.connectionCost)) throw new Error("UTILITY_BUDGET_CONNECTION_COST_UNKNOWN");
  if (input.facilityPrefab.length === 0) throw new Error("UTILITY_BUDGET_FACILITY_PREFAB_UNKNOWN");
  if (input.connectionPrefab.length === 0) throw new Error("UTILITY_BUDGET_CONNECTION_PREFAB_UNKNOWN");
  return {
    kind: input.kind,
    facilityPrefab: input.facilityPrefab,
    facilityCost: input.facilityCost,
    facilityCostSource: "PLAN_ASSET_COST",
    connectionPrefab: input.connectionPrefab,
    connectionCost: input.connectionCost,
    connectionCostSource: "NATIVE_SPENDING_CONTRACT",
    requiredSpend: input.facilityCost + input.connectionCost,
  };
}

/** The policy-derived starter budget, before any domain has spoken. */
export interface StarterProjectBudget {
  maximumBudget: number;
  treasuryShareLimit: number;
  budgetBound: "POLICY_CEILING" | "TREASURY_SHARE";
}

/** The starter budget after the selected plan's own requirement is funded. */
export interface UtilityAwareStarterBudget {
  maximumBudget: number;
  treasuryShareLimit: number;
  /**
   * `UTILITY_PLAN_MINIMUM` is the domain's figure rather than the policy's: it
   * says this project's budget was raised to what its own utility plan costs,
   * and that the policy ceiling — not the plan — is what bounds everything else.
   */
  budgetBound: StarterProjectBudget["budgetBound"] | "UTILITY_PLAN_MINIMUM";
  /** The requirement that was funded, or null when no domain declared one. */
  requiredUtilityBudget: number | null;
}

/**
 * Raise the policy-derived starter budget to what the selected utility plan
 * actually costs, when that is more.
 *
 * The policy ceiling is deliberately NOT a cap here. `absoluteBudgetCeiling` is
 * a bound on what a starter project may commit without a utility plan to answer
 * to; it is not a claim that 25000 finishes every domain, and treating it as one
 * is exactly the assumption this function exists to remove. What does bound the
 * result is the policy's `maximumTreasuryShare`: the raised budget is still a
 * bounded share of observed treasury, and a requirement that exceeds that share
 * is refused outright rather than admitted at a budget that cannot deliver it.
 *
 * With no requirement the policy budget is returned unchanged, which is what
 * keeps a domain that declares nothing — electricity today — byte-identical.
 */
export function fundStarterProjectBudget(input: {
  policyBudget: StarterProjectBudget;
  requirement: UtilityPlanBudgetRequirement | null;
}): UtilityAwareStarterBudget {
  const { policyBudget, requirement } = input;
  if (!requirement) return { ...policyBudget, requiredUtilityBudget: null };
  if (!finiteNonNegative(requirement.requiredSpend)) throw new Error("UTILITY_BUDGET_REQUIREMENT_UNKNOWN");
  // Fail closed, and say which refusal this is: the project is affordable in
  // principle but not within the share of treasury a starter project may
  // commit. Admission stops here rather than minting a project whose own
  // utility plan it cannot fund.
  if (requirement.requiredSpend > policyBudget.treasuryShareLimit) throw new Error("PROJECT_ADMISSION_NO_VALID_BUDGET");
  if (requirement.requiredSpend <= policyBudget.maximumBudget) {
    return { ...policyBudget, requiredUtilityBudget: requirement.requiredSpend };
  }
  return {
    maximumBudget: requirement.requiredSpend,
    treasuryShareLimit: policyBudget.treasuryShareLimit,
    budgetBound: "UTILITY_PLAN_MINIMUM",
    requiredUtilityBudget: requirement.requiredSpend,
  };
}

/** The durable coordinator surface the amendment needs, stated structurally. */
export interface UtilityBudgetAmendmentPort {
  isExecutionDurablyActivated(activation: { kind: string; status: V2DurableActivationStatus; world: NativeWorldIdentity }): boolean;
  utilityBudgetAmendments(): V2UtilityBudgetAmendmentRecord[];
  supersedeUnusedAccessRoadBudgetAmendment?(amendmentId: string): V2UtilityBudgetAmendmentRecord;
  consumeAccessRoadBudgetAmendment?(amendmentId: string, courseFingerprint: string): V2UtilityBudgetAmendmentRecord;
  recordUtilityBudgetAmendment(input: {
    amendmentId: string;
    state: Gate1State;
    originalProjectBudget: number;
    requiredUtilityBudget: number;
    amendedEffectiveBudget: number;
    reason?:
      | typeof UTILITY_BUDGET_AMENDMENT_REASON
      | typeof UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
      | typeof FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON;
    connectionAllowance?: number;
    actualConnectionQuote?: number;
    status?: "ACTIVE" | "SUPERSEDED_UNUSED";
    planRevision?: string;
    courseFingerprint?: string;
    supersedesAmendmentId?: string | null;
    nativeQuote?: number;
    segmentQuotes?: number[];
    roadPrefab?: string;
    purpose?: string;
    authorizationWorldId?: string;
    authorizationCheckpointId?: string | null;
    authorizationGeneration?: string;
    executionUseLimit?: 1;
    executionUseStatus?: "UNUSED" | "CONSUMED";
    detail: string;
  }): V2UtilityBudgetAmendmentRecord;
  recordUtilityServiceRoadChildOperation(input: {
    state: Gate1State;
    planRevision: string;
    courseFingerprint: string;
    exactRoadInput: import("./road-kernel").RoadGeometryInput;
    authorizationWorldId: string;
    authorizationCheckpointId: string | null;
    authorizationGeneration: string;
    detail: string;
  }): V2UtilityBudgetAmendmentRecord;
}

/** Persist the planner's exact utility service-road course as a one-shot child operation. */
export function recordUtilityServiceRoadChildOperation(input: {
  durability: Pick<UtilityBudgetAmendmentPort, "recordUtilityServiceRoadChildOperation">;
  state: Gate1State;
  planRevision: string;
  exactRoadInput: import("./road-kernel").RoadGeometryInput;
  authorizationWorldId: string;
  authorizationCheckpointId: string | null;
  authorizationGeneration: string;
  detail: string;
}): V2UtilityBudgetAmendmentRecord {
  const courseFingerprint = stableRoadInput(input.exactRoadInput);
  return input.durability.recordUtilityServiceRoadChildOperation({
    state: input.state,
    planRevision: input.planRevision,
    courseFingerprint,
    exactRoadInput: structuredClone(input.exactRoadInput),
    authorizationWorldId: input.authorizationWorldId,
    authorizationCheckpointId: input.authorizationCheckpointId,
    authorizationGeneration: input.authorizationGeneration,
    detail: input.detail,
  });
}

/**
 * Durable proof that this project has not yet spent or mutated anything through
 * the native utility boundary.
 *
 * Both halves are read from the durable journal by the caller rather than
 * asserted, because the whole point of the amendment's precondition is that it
 * is checked against history and not against the caller's intent. Neither half
 * is a count the caller supplies: the placement status is the journal's own
 * verdict, and the submitted commands are the journal's own entries.
 */
export interface UtilityMutationProof {
  firstFacilityPlacement: FirstFacilityPlacementDurability;
  /** Durable UTILITY command ids that reached native, facility and network alike. */
  submittedCommandIds: readonly string[];
}

export type UtilityBudgetAmendmentOutcome =
  | {
      status: "NOT_REQUIRED";
      reason: "NO_UTILITY_BUDGET_REQUIREMENT" | "POLICY_BUDGET_ALREADY_SUFFICIENT";
      originalProjectBudget: number;
      requiredUtilityBudget: number | null;
      effectiveProjectBudget: number;
    }
  | { status: "AMENDED"; record: V2UtilityBudgetAmendmentRecord; effectiveProjectBudget: number }
  | { status: "ALREADY_AMENDED"; record: V2UtilityBudgetAmendmentRecord; effectiveProjectBudget: number };

/**
 * Record the one bounded budget amendment a project may ever receive.
 *
 * The situation this exists for is narrow and it is checked, not assumed: a
 * project whose admission was correct about its site, whose ROAD is delivered,
 * whose utility plan is still the authoritative one, and which has not yet spent
 * a unit of it — but whose admitted budget predates the requirement that plan
 * declares. Re-admitting would mean a third identity and a second ROAD, and
 * editing the admission record would rewrite history that other proofs rest on.
 * Appending one amendment to what the project is authorized to spend is the
 * smallest change that funds the slice without touching either.
 *
 * What the amendment is NOT allowed to do is as load-bearing as what it is:
 * it copies the project's identity verbatim and carries no reservation, no
 * facility count and no scope of its own. The only thing it can change is the
 * budget, and the only value it can set is the minimum the current plan needs.
 *
 * Idempotent by construction. A resume finds the amendment already recorded and
 * returns it instead of appending a second one; a resume whose plan now needs
 * MORE than the recorded amendment is refused rather than topped up, because
 * growing the authorization twice is the unbounded version of this operation.
 */
export function admitUtilityBudgetAmendment(input: {
  durability: UtilityBudgetAmendmentPort;
  activation: { kind: string; status: V2DurableActivationStatus; world: NativeWorldIdentity };
  state: Gate1State;
  treasury: number;
  policy: V2ProjectAdmissionPolicy;
  requirement: UtilityPlanBudgetRequirement | null;
  mutation: UtilityMutationProof;
  amendmentId: string;
  detail: string;
}): UtilityBudgetAmendmentOutcome {
  const { state } = input;
  if (!input.durability.isExecutionDurablyActivated(input.activation)) {
    throw new Error("UTILITY_BUDGET_AMENDMENT_WORLD_NOT_ACTIVATED");
  }
  if (state.project.status !== "ACTIVE") throw new Error("UTILITY_BUDGET_AMENDMENT_PROJECT_NOT_ACTIVE");
  if (state.tranche.stage !== "ROAD_DELIVERED") {
    throw new Error(`UTILITY_BUDGET_AMENDMENT_STAGE_NOT_ROAD_DELIVERED:${state.tranche.stage}`);
  }
  // "Utility native spend or mutation has not happened yet" is the precondition
  // that makes a budget raise meaningful rather than retroactive. A facility
  // already placed was placed under the old budget; widening the authorization
  // afterwards would be rewriting what that placement was permitted to cost.
  const placement = input.mutation.firstFacilityPlacement.status;
  if (placement !== "NONE" && placement !== "TERMINAL_NO_MUTATION") {
    throw new Error(`UTILITY_BUDGET_AMENDMENT_UTILITY_MUTATION_ALREADY_HAPPENED:${placement}`);
  }
  if (input.mutation.submittedCommandIds.length > 0) {
    throw new Error("UTILITY_BUDGET_AMENDMENT_UTILITY_MUTATION_ALREADY_HAPPENED:DURABLE_UTILITY_JOURNAL");
  }
  const originalProjectBudget = state.project.maximumBudget;
  if (!input.requirement) {
    return {
      status: "NOT_REQUIRED",
      reason: "NO_UTILITY_BUDGET_REQUIREMENT",
      originalProjectBudget,
      requiredUtilityBudget: null,
      effectiveProjectBudget: originalProjectBudget,
    };
  }
  const requiredUtilityBudget = input.requirement.requiredSpend;
  if (requiredUtilityBudget <= originalProjectBudget) {
    return {
      status: "NOT_REQUIRED",
      reason: "POLICY_BUDGET_ALREADY_SUFFICIENT",
      originalProjectBudget,
      requiredUtilityBudget,
      effectiveProjectBudget: originalProjectBudget,
    };
  }
  // The same bound admission applies, applied again at the moment of the raise:
  // the amendment may not commit a larger share of treasury than a starter
  // project is allowed to, and it may not outrun the treasury itself.
  const treasuryShareLimit = Math.floor(input.treasury * input.policy.maximumTreasuryShare);
  if (!Number.isFinite(input.treasury) || requiredUtilityBudget > treasuryShareLimit || requiredUtilityBudget > input.treasury) {
    throw new Error("UTILITY_BUDGET_AMENDMENT_TREASURY_INSUFFICIENT");
  }
  const existing = input.durability
    .utilityBudgetAmendments()
    .find((record) => record.projectId === state.project.id);
  if (existing) {
    // Idempotent resume: the recorded amendment stands. It is only usable while
    // it still covers the plan, so a plan that grew past it is refused instead
    // of silently under-funded.
    if (existing.amendedEffectiveBudget < requiredUtilityBudget) {
      throw new Error("UTILITY_BUDGET_AMENDMENT_STALE");
    }
    return { status: "ALREADY_AMENDED", record: existing, effectiveProjectBudget: existing.amendedEffectiveBudget };
  }
  const record = input.durability.recordUtilityBudgetAmendment({
    amendmentId: input.amendmentId,
    state,
    originalProjectBudget,
    requiredUtilityBudget,
    amendedEffectiveBudget: requiredUtilityBudget,
    detail: input.detail,
  });
  return { status: "AMENDED", record, effectiveProjectBudget: record.amendedEffectiveBudget };
}

/**
 * What the current authoritative world proves about this project's utility
 * slice at the moment a connection settlement is decided.
 *
 * Every field is a durable read the caller must have made, not a claim: the
 * point of the settlement's preconditions is that they are checked against
 * history and the world rather than against the caller's intent. A field that
 * could not be read fails closed upstream — "the connector could not be bound"
 * is not "there is no connector".
 */
export interface UtilityConnectionSettlementProof {
  /** The facility authoritatively landed in the current world. */
  facilityPlaced: boolean;
  /** How many facilities this project's placement authority accounts for. Must be exactly one. */
  facilityPlacementCount: number;
  /**
   * The facility's OWN connector, uniquely rebound in the current world.
   *
   * Load-bearing rather than diagnostic: this connector is the start of the very
   * course being priced. An ambiguous or absent one means the geometry the
   * settlement would price is a guess, so it is refused.
   */
  connectorResolved: boolean;
  /** The connection primitive's physical effect is absent from the current world. */
  connectionEffectAbsent: boolean;
  /** Durable commands carrying this project's connection primitive that reached native. */
  submittedCommandIds: readonly string[];
}

export type UtilityConnectionBudgetAmendmentOutcome =
  | {
      status: "NOT_REQUIRED";
      /** The allowance the admission priced already covers the real quote. */
      reason: "CONNECTION_QUOTE_WITHIN_ALLOWANCE";
      connectionAllowance: number;
      actualConnectionQuote: number;
      effectiveProjectBudget: number;
    }
  | {
      status: "AMENDED";
      record: V2UtilityBudgetAmendmentRecord;
      connectionAllowance: number;
      actualConnectionQuote: number;
      /** What the amendment added, which is exactly `quote - allowance`. */
      delta: number;
      effectiveProjectBudget: number;
    }
  | {
      status: "ALREADY_AMENDED";
      record: V2UtilityBudgetAmendmentRecord;
      connectionAllowance: number;
      actualConnectionQuote: number;
      effectiveProjectBudget: number;
    };

/**
 * Record the one bounded correction a project's connection authorization may
 * ever receive, once its facility has authoritatively landed.
 *
 * The situation is narrow and every part of it is checked. An admission prices
 * the connection before the facility exists, so it can only price the geometry
 * it can prove: the plan's `connection.start`, the facility centre. The course
 * the execution submits starts at the facility's connector instead — a different
 * point, and the native spending contract does not price two different points
 * the same. The gap is small (in the live world it was 16 against a 40 272
 * authorization) and it is entirely deterministic once the facility exists,
 * which is what makes it correctable rather than a policy question.
 *
 * What this can NOT do is as load-bearing as what it can:
 *
 * - it may only be recorded while the world is durably activated and nothing has
 *   been submitted for this connection, because a correction after the fact
 *   would be re-writing what a submitted command was permitted to cost;
 * - it may only move the budget to `facilityCost + actualConnectionQuote`, which
 *   is the exact figure the native boundary will check, not a rounded-up margin;
 * - it copies the project's identity verbatim and carries no reservation, no
 *   facility count and no scope, so there is nothing in it that could widen the
 *   execution beyond the connection spend;
 * - it is idempotent on resume, and a resume whose quote has CHANGED is refused
 *   rather than topped up. A moved connector is a new authoritative conflict,
 *   not a second amendment.
 *
 * The facility's own authorization is never touched. It was decided, and spent,
 * under the admitted budget, and this leaves that decision exactly as it was.
 */
export function admitUtilityConnectionBudgetAmendment(input: {
  durability: UtilityBudgetAmendmentPort;
  activation: { kind: string; status: V2DurableActivationStatus; world: NativeWorldIdentity };
  state: Gate1State;
  treasury: number;
  policy: V2ProjectAdmissionPolicy;
  /** The facility's authoritative planned cost, read from the durable plan. */
  facilityPlannedCost: number;
  /** The native spending contract's exact quote for the course the execution will submit. */
  actualConnectionQuote: number;
  settlement: UtilityConnectionSettlementProof;
  amendmentId: string;
  detail: string;
}): UtilityConnectionBudgetAmendmentOutcome {
  const { state, settlement } = input;
  if (!input.durability.isExecutionDurablyActivated(input.activation)) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_WORLD_NOT_ACTIVATED");
  }
  if (state.project.status !== "ACTIVE") throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_PROJECT_NOT_ACTIVE");
  if (state.tranche.stage !== "ROAD_DELIVERED") {
    throw new Error(`UTILITY_CONNECTION_BUDGET_AMENDMENT_STAGE_NOT_ROAD_DELIVERED:${state.tranche.stage}`);
  }
  if (!settlement.facilityPlaced || settlement.facilityPlacementCount !== 1) {
    throw new Error(`UTILITY_CONNECTION_BUDGET_AMENDMENT_FACILITY_NOT_SETTLED:${settlement.facilityPlacementCount}`);
  }
  if (!settlement.connectorResolved) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTOR_NOT_RESOLVED");
  }
  if (settlement.submittedCommandIds.length > 0) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTION_ALREADY_SUBMITTED");
  }
  if (!settlement.connectionEffectAbsent) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTION_EFFECT_PRESENT");
  }
  if (!finiteNonNegative(input.facilityPlannedCost)) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_FACILITY_COST_UNKNOWN");
  }
  if (!finiteNonNegative(input.actualConnectionQuote)) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTION_QUOTE_UNKNOWN");
  }
  const priorForProject = input.durability
    .utilityBudgetAmendments()
    .filter((entry) => entry.projectId === state.project.id);
  // What the project is authorized for right now: the admitted budget, or a
  // prior amendment's figure when one already raised it.
  const effectiveBefore = priorForProject.reduce(
    (maximum, entry) => Math.max(maximum, entry.amendedEffectiveBudget),
    state.project.maximumBudget,
  );
  // The allowance admission priced the connection at is DERIVED, never supplied:
  // it is whatever the funded budget left after the facility. A caller cannot
  // inflate the gap it is asking to close.
  const connectionAllowance = effectiveBefore - input.facilityPlannedCost;
  const totalRequired = input.facilityPlannedCost + input.actualConnectionQuote;

  const existing = priorForProject.find((entry) => entry.reason === UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON);
  if (existing) {
    // Idempotent on resume, and only while the quote it was decided on still
    // holds: a settlement whose geometry moved is a new authoritative conflict,
    // and topping it up is the unbounded version of this operation.
    if (existing.actualConnectionQuote !== input.actualConnectionQuote) {
      throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_QUOTE_CHANGED");
    }
    return {
      status: "ALREADY_AMENDED",
      record: existing,
      connectionAllowance: existing.connectionAllowance ?? connectionAllowance,
      actualConnectionQuote: input.actualConnectionQuote,
      effectiveProjectBudget: existing.amendedEffectiveBudget,
    };
  }

  if (totalRequired <= effectiveBefore) {
    return {
      status: "NOT_REQUIRED",
      reason: "CONNECTION_QUOTE_WITHIN_ALLOWANCE",
      connectionAllowance,
      actualConnectionQuote: input.actualConnectionQuote,
      effectiveProjectBudget: effectiveBefore,
    };
  }

  // The same bound every other funding path applies: a starter project may not
  // commit a larger share of treasury than the policy allows, and may not outrun
  // the treasury itself.
  const treasuryShareLimit = Math.floor(input.treasury * input.policy.maximumTreasuryShare);
  if (
    !Number.isFinite(input.treasury) ||
    totalRequired > treasuryShareLimit ||
    totalRequired > input.treasury
  ) {
    throw new Error("UTILITY_CONNECTION_BUDGET_AMENDMENT_TREASURY_INSUFFICIENT");
  }

  const record = input.durability.recordUtilityBudgetAmendment({
    amendmentId: input.amendmentId,
    state,
    originalProjectBudget: effectiveBefore,
    requiredUtilityBudget: totalRequired,
    amendedEffectiveBudget: totalRequired,
    reason: UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON,
    connectionAllowance,
    actualConnectionQuote: input.actualConnectionQuote,
    detail: input.detail,
  });
  return {
    status: "AMENDED",
    record,
    connectionAllowance,
    actualConnectionQuote: input.actualConnectionQuote,
    delta: totalRequired - effectiveBefore,
    effectiveProjectBudget: record.amendedEffectiveBudget,
  };
}

/**
 * What the durable world proves about this project's access-road repair at the
 * moment the repair is funded.
 *
 * Read from the journal and the world by the caller, never asserted: the whole
 * point of the preconditions is that they are checked against history. The
 * facility's placement is REQUIRED here — the mirror image of the connection
 * settlement, which requires that no facility has been placed. A repair exists
 * only because a facility is already in the world without road frontage.
 */
export interface UtilityAccessRoadRepairProof {
  /** The facility authoritatively landed in the current world. */
  facilityPlaced: boolean;
  /** The facility's road frontage is absent, and read as absent rather than assumed. */
  roadAttachment: "ATTACHED" | "NONE" | "UNKNOWN";
  /** Durable commands carrying this project's access-road primitive that reached native. */
  accessRoadCommandIds: readonly string[];
  /** Proof that a prior authorized course was observed, spent, and still left the facility unattached. */
  previousAttempt?: {
    commandId: string;
    courseFingerprint: string;
    authorizationSpent: true;
    effectObserved?: true;
    terminalStatus?: "REJECTED";
    currentWorldEffect?: "ABSENT_DUE_TO_USER_ROLLBACK";
    reconciliationComplete?: true;
  };
}

export type UtilityAccessRoadBudgetAmendmentOutcome =
  | {
      status: "AMENDED";
      record: V2UtilityBudgetAmendmentRecord;
      actualAccessRoadQuote: number;
      effectiveProjectBudget: number;
    }
  | {
      status: "ALREADY_AMENDED";
      record: V2UtilityBudgetAmendmentRecord;
      actualAccessRoadQuote: number;
      effectiveProjectBudget: number;
    };

/**
 * Record the one bounded correction a project's road-access repair may receive.
 *
 * The situation is narrow and every part of it is checked. The facility landed,
 * its connection to the utility network is an observed fact, and the frontage
 * the facility needs turned out to be a road that the plan's own course cannot
 * supply — the corridor it was planned down is already occupied. The replacement
 * course is priced by the native spending contract before submission, and the
 * admitted budget cannot be assumed to cover it: the plan priced a road it can no
 * longer build, and this is the one bounded correction between the two.
 *
 * What this shares with the connection settlement is the discipline:
 *
 * - it may only be recorded while the world is durably activated and no
 *   access-road command has been submitted, because a correction after the fact
 *   would be re-writing what a submitted command was permitted to cost;
 * - it may only move the budget to `effectiveBefore + actualAccessRoadQuote`,
 *   which is the figure the native boundary will check, not a rounded-up margin;
 * - it copies the project's identity verbatim and carries no reservation, no
 *   facility count and no scope, so there is nothing in it that could widen the
 *   execution beyond the repair spend;
 * - it is idempotent on resume, and a resume whose quote has CHANGED is refused
 *   rather than topped up. A moved course is a new authoritative conflict, not a
 *   second amendment.
 */
export function admitFacilityAccessRoadBudgetAmendment(input: {
  durability: UtilityBudgetAmendmentPort;
  activation: { kind: string; status: V2DurableActivationStatus; world: NativeWorldIdentity };
  state: Gate1State;
  treasury: number;
  policy: V2ProjectAdmissionPolicy;
  /** The native spending contract's exact quote for the repair course. */
  actualAccessRoadQuote: number;
  /** Per-segment exact native quotes; their sum must equal actualAccessRoadQuote. */
  segmentQuotes?: number[];
  /** Only the certified single-action repair contract may be admitted. */
  actionCount: number;
  roadPrefab?: string;
  repair: UtilityAccessRoadRepairProof;
  amendmentId: string;
  planRevision: string;
  courseFingerprint: string;
  purpose?: string;
  repairLineage?: string;
  /** The immutable repair attempt ordinal this authorization is minted for. */
  repairAttemptIndex?: number;
  detail: string;
}): UtilityAccessRoadBudgetAmendmentOutcome {
  const { state, repair } = input;
  if (!input.durability.isExecutionDurablyActivated(input.activation)) {
    throw new Error("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_WORLD_NOT_ACTIVATED");
  }
  if (input.actionCount !== 1) throw new Error("FACILITY_REPAIR_MULTI_ACTION_NOT_CERTIFIED");
  if (state.project.status !== "ACTIVE") throw new Error("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_PROJECT_NOT_ACTIVE");
  if (state.tranche.stage !== "ROAD_DELIVERED") {
    throw new Error(`UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_STAGE_NOT_ROAD_DELIVERED:${state.tranche.stage}`);
  }
  // The opposite of the connection settlement's precondition, and deliberately
  // so: a repair exists because a facility landed and still cannot reach a road.
  if (!repair.facilityPlaced) throw new Error("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_FACILITY_NOT_PLACED");
  if (repair.roadAttachment !== "NONE") {
    throw new Error(`UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_ROAD_ALREADY_ATTACHED:${repair.roadAttachment}`);
  }
  if (repair.accessRoadCommandIds.length > 0 && !repair.previousAttempt) {
    throw new Error("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_ACCESS_ROAD_ALREADY_SUBMITTED");
  }
  if (!finiteNonNegative(input.actualAccessRoadQuote)) {
    throw new Error("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_QUOTE_UNKNOWN");
  }
  const priorForProject = input.durability
    .utilityBudgetAmendments()
    .filter((entry) => entry.projectId === state.project.id);
  // What the project is authorized for right now: the admitted budget, or a
  // prior amendment's figure when one already raised it.
  const repairAmendments = priorForProject.filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON);
  const existing = repairAmendments.find((entry) => entry.status === "ACTIVE" || entry.status === undefined);
  if (existing && existing.planRevision === input.planRevision && existing.courseFingerprint === input.courseFingerprint) {
    const recordedQuote = existing.amendedEffectiveBudget - existing.originalProjectBudget;
    const requestedSegments = input.segmentQuotes ?? [input.actualAccessRoadQuote];
    if (existing.repairLineage !== input.repairLineage || existing.purpose !== (input.purpose ?? "Pump native road attachment repair") ||
      existing.roadPrefab !== (input.roadPrefab ?? "Small Road")) {
      throw new Error("FACILITY_ACCESS_ROAD_ACTIVE_AUTHORIZATION_BINDING_CONFLICT");
    }
    if (recordedQuote !== input.actualAccessRoadQuote ||
      (existing.segmentQuotes !== undefined && JSON.stringify(existing.segmentQuotes) !== JSON.stringify(requestedSegments))) {
      throw new Error("FACILITY_ACCESS_ROAD_BUDGET_AMENDMENT_QUOTE_CHANGED");
    }
    return {
      status: "ALREADY_AMENDED",
      record: existing,
      actualAccessRoadQuote: recordedQuote,
      effectiveProjectBudget: existing.amendedEffectiveBudget,
    };
  }
  const sameLineage = repairAmendments.find((entry) => entry.repairLineage === input.repairLineage &&
    entry.planRevision === input.planRevision && entry.courseFingerprint === input.courseFingerprint &&
    entry.purpose === (input.purpose ?? "Pump native road attachment repair"));
  if (sameLineage) throw new Error("FACILITY_ACCESS_ROAD_AUTHORIZATION_MINT_ALREADY_FINALIZED");
  // Bounded sequential repair amendments. The ordinal is the lineage's own
  // attempt counter, and a mint may only ever continue the sequence by exactly
  // one: never repeat a spent attempt, never skip over one whose outcome nobody
  // read, and never open an unbounded repair loop. The capability's ceiling is
  // enforced where the ordinal is derived; this is the same rule stated where
  // the record is created, so a caller that derived the wrong number cannot
  // write an amendment that disagrees with the history it is continuing.
  if (input.repairAttemptIndex !== undefined) {
    if (input.repairAttemptIndex > FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX) {
      throw new Error(`FACILITY_ACCESS_ROAD_REPAIR_ATTEMPT_INDEX_BEYOND_CEILING:${input.repairAttemptIndex}`);
    }
    const highestPriorAttempt = repairAmendments.reduce((highest, entry) => Math.max(
      highest,
      entry.repairAttemptIndex ?? facilityAccessRoadRepairAttemptIndexFromLineage(entry.repairLineage) ?? 0,
    ), 0);
    if (input.repairAttemptIndex !== highestPriorAttempt + 1) {
      throw new Error(`FACILITY_ACCESS_ROAD_REPAIR_ATTEMPT_INDEX_NOT_NEXT:${input.repairAttemptIndex}`);
    }
  }
  const priorAttempt = repair.previousAttempt;
  if (!existing && repair.accessRoadCommandIds.length > 0 && priorAttempt &&
    (!repair.accessRoadCommandIds.includes(priorAttempt.commandId) || priorAttempt.authorizationSpent !== true ||
      !(priorAttempt.effectObserved === true || (priorAttempt.terminalStatus === "REJECTED" &&
        priorAttempt.currentWorldEffect === "ABSENT_DUE_TO_USER_ROLLBACK" && priorAttempt.reconciliationComplete === true)))) {
    throw new Error("ACCESS_ROAD_PREVIOUS_ATTEMPT_NOT_TERMINAL_OR_ROLLBACK_RECONCILED");
  }
  if (existing && repair.accessRoadCommandIds.length > 0 &&
    (!priorAttempt || !repair.accessRoadCommandIds.includes(priorAttempt.commandId) || priorAttempt.effectObserved !== true ||
      priorAttempt.authorizationSpent !== true || priorAttempt.courseFingerprint !== existing.courseFingerprint ||
      existing.executionUseStatus === "CONSUMED")) {
    throw new Error("ACCESS_ROAD_REPLAN_AFTER_NATIVE_ATTEMPT_FORBIDDEN");
  }
  if (existing && repair.accessRoadCommandIds.length === 0 && !input.durability.supersedeUnusedAccessRoadBudgetAmendment) {
    throw new Error("ACCESS_ROAD_UNUSED_AUTHORIZATION_CANNOT_BE_SUPERSEDED");
  }
  const segmentQuotes = input.segmentQuotes ?? [input.actualAccessRoadQuote];
  if (segmentQuotes.length === 0 || segmentQuotes.some((quote) => !finiteNonNegative(quote)) ||
    segmentQuotes.reduce((sum, quote) => sum + quote, 0) !== input.actualAccessRoadQuote) {
    throw new Error("UTILITY_ACCESS_ROAD_SEGMENT_QUOTES_MISMATCH");
  }
  const effectiveBefore = priorForProject
    .filter((entry) => entry.reason !== FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON || entry.status === "CONSUMED" ||
      (entry.amendmentId === existing?.amendmentId && !!priorAttempt))
    .reduce((maximum, entry) => Math.max(maximum, entry.amendedEffectiveBudget), state.project.maximumBudget);
  const amendedEffectiveBudget = effectiveBefore + input.actualAccessRoadQuote;

  // The same bound every other funding path applies: a starter project may not
  // commit a larger share of treasury than the policy allows, and may not outrun
  // the treasury itself.
  const treasuryShareLimit = Math.floor(input.treasury * input.policy.maximumTreasuryShare);
  if (
    !Number.isFinite(input.treasury) ||
    amendedEffectiveBudget > treasuryShareLimit ||
    amendedEffectiveBudget > input.treasury
  ) {
    throw new Error("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_TREASURY_INSUFFICIENT");
  }

  if (existing && repair.accessRoadCommandIds.length > 0) {
    if (!input.durability.consumeAccessRoadBudgetAmendment) throw new Error("ACCESS_ROAD_SPENT_AUTHORIZATION_LIFECYCLE_UNSUPPORTED");
    input.durability.consumeAccessRoadBudgetAmendment(existing.amendmentId, existing.courseFingerprint ?? "");
  } else if (existing) input.durability.supersedeUnusedAccessRoadBudgetAmendment!(existing.amendmentId);
  const record = input.durability.recordUtilityBudgetAmendment({
    amendmentId: existing ? `${input.amendmentId}:${input.planRevision}:${input.courseFingerprint}` : input.amendmentId,
    state,
    originalProjectBudget: effectiveBefore,
    requiredUtilityBudget: amendedEffectiveBudget,
    amendedEffectiveBudget,
    reason: FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON,
    status: "ACTIVE",
    planRevision: input.planRevision,
    courseFingerprint: input.courseFingerprint,
    supersedesAmendmentId: existing?.amendmentId ?? null,
    nativeQuote: input.actualAccessRoadQuote,
    segmentQuotes,
    roadPrefab: input.roadPrefab ?? "Small Road",
    purpose: input.purpose ?? "Pump native road attachment repair",
    authorizationWorldId: input.activation.world.worldId,
    authorizationCheckpointId: input.activation.world.checkpointId,
    authorizationGeneration: input.activation.world.generation,
    executionUseLimit: 1,
    executionUseStatus: "UNUSED",
    ...(input.repairLineage ? { repairLineage: input.repairLineage } : {}),
    ...(input.repairAttemptIndex !== undefined ? { repairAttemptIndex: input.repairAttemptIndex } : {}),
    detail: input.detail,
  });
  return {
    status: "AMENDED",
    record,
    actualAccessRoadQuote: input.actualAccessRoadQuote,
    effectiveProjectBudget: record.amendedEffectiveBudget,
  };
}
