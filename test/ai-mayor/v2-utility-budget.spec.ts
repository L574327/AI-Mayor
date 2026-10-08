import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
  type V2UtilityBudgetAmendmentRecord,
} from "../../src/main/services/ai-mayor/v2/durability";
import {
  createDurableGate1StateStorage,
  planStarterResidentialIntent,
  type Gate1State,
} from "../../src/main/services/ai-mayor/v2/gate1";
import { V2_PROJECT_ADMISSION_POLICY } from "../../src/main/services/ai-mayor/v2/project-admission";
import {
  UTILITY_BUDGET_AMENDMENT_REASON,
  UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON,
  admitUtilityBudgetAmendment,
  admitUtilityConnectionBudgetAmendment,
  fundStarterProjectBudget,
  minimumFeasibleUtilityBudget,
  type UtilityConnectionSettlementProof,
  type UtilityMutationProof,
  type UtilityPlanBudgetRequirement,
} from "../../src/main/services/ai-mayor/v2/utility-budget";

const INSTANT = new Date("2026-01-02T03:04:05.000Z");
const SESSION_A = "11111111111111111111111111111111";
const SAVE_A = "save:meta-a:data-a";
/** The live world's treasury, so the share bound is exercised at a real size. */
const TREASURY = 957_298;
const ORIGINAL_BUDGET = 25_000;
/** GroundwaterPumpingStation01's asset cost plus a Small Water Pipe quote. */
const FACILITY_COST = 40_000;
const PIPE_QUOTE = 136;

const waterRequirement = (overrides: Partial<UtilityPlanBudgetRequirement> = {}): UtilityPlanBudgetRequirement => ({
  ...minimumFeasibleUtilityBudget({
    kind: "water",
    facilityPrefab: "GroundwaterPumpingStation01",
    facilityCost: FACILITY_COST,
    connectionPrefab: "Small Water Pipe",
    connectionCost: PIPE_QUOTE,
  }),
  ...overrides,
});

const policyBudget = (treasury = TREASURY) => ({
  maximumBudget: Math.min(V2_PROJECT_ADMISSION_POLICY.absoluteBudgetCeiling, Math.floor(treasury * V2_PROJECT_ADMISSION_POLICY.maximumTreasuryShare)),
  treasuryShareLimit: Math.floor(treasury * V2_PROJECT_ADMISSION_POLICY.maximumTreasuryShare),
  budgetBound: "POLICY_CEILING" as const,
});

// ---------------------------------------------------------------------------
// Durable world fixture
// ---------------------------------------------------------------------------

function world() {
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${SESSION_A}`,
      nativeSessionGuid: SESSION_A,
      loadPurpose: "NewGame" as const,
      loadAssetGuid: null,
      saveDataAssetGuid: null,
      mapAssetGuid: "map-a",
      checkpointId: null,
      bridgeRuntimeEpoch: "bridge-a",
      generation: "generation-a",
      generationSequence: 1,
      generationOrigin: "LOAD_COMPLETED",
    },
  };
}

function receipt(checkpointId: string): SaveCompletionReceipt {
  const [, metadata, data] = checkpointId.split(":");
  return {
    status: "COMPLETED",
    durable: true,
    worldId: `cs2-session:${SESSION_A}`,
    worldGeneration: "generation-a",
    checkpoint: {
      checkpointId,
      saveMetadataAssetGuid: metadata,
      saveDataAssetGuid: data,
      nativeSessionGuid: SESSION_A,
    },
  };
}

/** A durably activated world whose baseline checkpoint is certified. */
function activatedWorld() {
  const storage = createMemoryDurableStateStorage();
  const first = new V2DurabilityCoordinator(storage);
  first.activate(world());
  first.recordBaselineCheckpoint(receipt(SAVE_A));
  const coordinator = new V2DurabilityCoordinator(storage);
  const activation = coordinator.activate(world());
  if (!coordinator.isExecutionDurablyActivated(activation)) throw new Error("fixture world is not durably activated");
  return { coordinator, activation };
}

const intentInput = {
  intentId: "intent:budget-amendment",
  targetResidents: 12,
  maximumBudget: ORIGINAL_BUDGET,
  planningEnvelope: { center: { x: 6.638, z: 1388.618 }, radius: 200 },
  siteCandidates: [{ id: "site-1", target: { center: { x: 6.638, z: 1388.618 }, radius: 200 }, score: 1, blocked: false }],
};

/**
 * The durable project state at the stage the amendment is allowed at. Placed
 * directly rather than driven through the lifecycle because the lifecycle is
 * exercised elsewhere; what this seam reads is the stage, and the case that the
 * stage really is only reached at ROAD_DELIVERED lives in the Gate 1 specs.
 */
function roadDeliveredState(overrides: { maximumBudget?: number; stage?: Gate1State["tranche"]["stage"] } = {}): Gate1State {
  const state = planStarterResidentialIntent({ ...intentInput, maximumBudget: overrides.maximumBudget ?? ORIGINAL_BUDGET }, INSTANT);
  state.tranche.stage = overrides.stage ?? "ROAD_DELIVERED";
  return state;
}

/** No durable utility operation, no submitted command: nothing happened. */
const NO_MUTATION: UtilityMutationProof = {
  firstFacilityPlacement: { status: "NONE" },
  submittedCommandIds: [],
};

function amend(
  coordinator: V2DurabilityCoordinator,
  activation: ReturnType<typeof activatedWorld>["activation"],
  state: Gate1State,
  options: {
    requirement?: UtilityPlanBudgetRequirement | null;
    treasury?: number;
    mutation?: UtilityMutationProof;
  } = {},
) {
  return admitUtilityBudgetAmendment({
    durability: coordinator,
    activation,
    state,
    treasury: options.treasury ?? TREASURY,
    policy: V2_PROJECT_ADMISSION_POLICY,
    requirement: options.requirement === undefined ? waterRequirement() : options.requirement,
    mutation: options.mutation ?? NO_MUTATION,
    amendmentId: `${state.project.id}:utility-budget-amendment`,
    detail: "test",
  });
}

// ---------------------------------------------------------------------------
// What a utility plan costs
// ---------------------------------------------------------------------------

describe("minimum feasible utility budget", () => {
  test("sums the plan's asset cost and the native quote for its connection", () => {
    // Both halves, because the native boundary that refuses an over-budget
    // execution sums the facility and every connection primitive against one
    // limit. A budget covering only the facility admits a placed-and-unconnected
    // slice, which is worse than a refusal.
    expect(waterRequirement()).toEqual({
      kind: "water",
      facilityPrefab: "GroundwaterPumpingStation01",
      facilityCost: FACILITY_COST,
      facilityCostSource: "PLAN_ASSET_COST",
      connectionPrefab: "Small Water Pipe",
      connectionCost: PIPE_QUOTE,
      connectionCostSource: "NATIVE_SPENDING_CONTRACT",
      requiredSpend: FACILITY_COST + PIPE_QUOTE,
    });
  });

  test("refuses a requirement built from a figure nobody read", () => {
    const base = { kind: "water" as const, facilityPrefab: "A", connectionPrefab: "B" };
    // An unread cost is not zero: a requirement built on one would authorize an
    // unknown spend, so it is refused at construction rather than downstream.
    expect(() => minimumFeasibleUtilityBudget({ ...base, facilityCost: Number.NaN, connectionCost: 10 })).toThrow(
      "UTILITY_BUDGET_FACILITY_COST_UNKNOWN",
    );
    expect(() => minimumFeasibleUtilityBudget({ ...base, facilityCost: -1, connectionCost: 10 })).toThrow(
      "UTILITY_BUDGET_FACILITY_COST_UNKNOWN",
    );
    expect(() => minimumFeasibleUtilityBudget({ ...base, facilityCost: 10, connectionCost: Number.POSITIVE_INFINITY })).toThrow(
      "UTILITY_BUDGET_CONNECTION_COST_UNKNOWN",
    );
  });
});

// ---------------------------------------------------------------------------
// Funding the plan out of the starter budget
// ---------------------------------------------------------------------------

describe("utility-aware starter budget", () => {
  test("leaves the policy budget byte-identical when no domain declares a requirement", () => {
    const policy = policyBudget();
    const funded = fundStarterProjectBudget({ policyBudget: policy, requirement: null });
    // This is what keeps a constraint-free admission — electricity today —
    // exactly as it was.
    expect(funded).toEqual({ ...policy, requiredUtilityBudget: null });
  });

  test("leaves the policy budget alone when it already covers the plan", () => {
    const policy = policyBudget();
    const cheap = waterRequirement({ requiredSpend: 20_000 });
    expect(fundStarterProjectBudget({ policyBudget: policy, requirement: cheap })).toEqual({
      ...policy,
      requiredUtilityBudget: 20_000,
    });
  });

  test("raises the budget to the plan's own figure rather than assuming the policy ceiling finishes the domain", () => {
    const policy = policyBudget();
    expect(policy.maximumBudget).toBe(V2_PROJECT_ADMISSION_POLICY.absoluteBudgetCeiling);
    const funded = fundStarterProjectBudget({ policyBudget: policy, requirement: waterRequirement() });
    expect(funded.maximumBudget).toBe(FACILITY_COST + PIPE_QUOTE);
    expect(funded.budgetBound).toBe("UTILITY_PLAN_MINIMUM");
    expect(funded.requiredUtilityBudget).toBe(FACILITY_COST + PIPE_QUOTE);
    // Still bounded: the raise is a share of treasury, not the treasury.
    expect(funded.treasuryShareLimit).toBe(policy.treasuryShareLimit);
    expect(funded.maximumBudget).toBeLessThan(policy.treasuryShareLimit);
  });

  test("fails closed when the plan costs more than the policy share of treasury", () => {
    const policy = policyBudget(100_000);
    expect(policy.treasuryShareLimit).toBe(25_000);
    // Affordable in principle, unaffordable within a starter tranche's share.
    // Refused rather than admitted at a budget that cannot deliver it.
    expect(() => fundStarterProjectBudget({ policyBudget: policy, requirement: waterRequirement() })).toThrow(
      "PROJECT_ADMISSION_NO_VALID_BUDGET",
    );
  });
});

// ---------------------------------------------------------------------------
// The one bounded amendment
// ---------------------------------------------------------------------------

describe("utility budget amendment", () => {
  test("appends one bounded amendment for a project admitted under a budget its plan outgrew", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    expect(state.project.maximumBudget).toBe(ORIGINAL_BUDGET);

    const outcome = amend(coordinator, activation, state);

    if (outcome.status !== "AMENDED") throw new Error(`expected an amendment, received ${outcome.status}`);
    expect(outcome.record).toMatchObject({
      projectId: state.project.id,
      intentId: state.intent.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      originalProjectBudget: ORIGINAL_BUDGET,
      requiredUtilityBudget: FACILITY_COST + PIPE_QUOTE,
      amendedEffectiveBudget: FACILITY_COST + PIPE_QUOTE,
      reason: UTILITY_BUDGET_AMENDMENT_REASON,
    });
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);
    expect(coordinator.utilityBudgetAmendments()[0]).toEqual(outcome.record);
  });

  test("is idempotent: a resume records no second amendment and authorizes no more", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const first = amend(coordinator, activation, state);
    if (first.status !== "AMENDED") throw new Error("expected an amendment");

    // The same call again is what a resumed run makes.
    const resumed = amend(coordinator, activation, state);
    expect(resumed.status).toBe("ALREADY_AMENDED");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);
    if (resumed.status !== "ALREADY_AMENDED") throw new Error("expected the recorded amendment");
    expect(resumed.record).toEqual(first.record);
    expect(resumed.effectiveProjectBudget).toBe(first.record.amendedEffectiveBudget);

    // And the durable write path refuses a second record for the same project
    // even when driven directly, so the bound is the store's, not the caller's.
    expect(() =>
      coordinator.recordUtilityBudgetAmendment({
        amendmentId: `${state.project.id}:second`,
        state,
        originalProjectBudget: ORIGINAL_BUDGET,
        requiredUtilityBudget: 99_999,
        amendedEffectiveBudget: 99_999,
        detail: "direct",
      }),
    ).toThrow("project budget is already amended");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);
  });

  test("records nothing when the admitted budget already covers the plan", () => {
    const { coordinator, activation } = activatedWorld();
    const outcome = amend(coordinator, activation, roadDeliveredState({ maximumBudget: FACILITY_COST + PIPE_QUOTE }));
    expect(outcome).toMatchObject({
      status: "NOT_REQUIRED",
      reason: "POLICY_BUDGET_ALREADY_SUFFICIENT",
      requiredUtilityBudget: FACILITY_COST + PIPE_QUOTE,
    });
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("records nothing when no domain declares a requirement", () => {
    const { coordinator, activation } = activatedWorld();
    const outcome = amend(coordinator, activation, roadDeliveredState(), { requirement: null });
    expect(outcome).toMatchObject({ status: "NOT_REQUIRED", reason: "NO_UTILITY_BUDGET_REQUIREMENT", requiredUtilityBudget: null });
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("fails closed when the treasury cannot cover the plan", () => {
    const { coordinator, activation } = activatedWorld();
    // 100_000 * 0.25 = 25_000, below the plan's 40_136.
    expect(() => amend(coordinator, activation, roadDeliveredState(), { treasury: 100_000 })).toThrow(
      "UTILITY_BUDGET_AMENDMENT_TREASURY_INSUFFICIENT",
    );
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("refuses to widen the authorization once any utility mutation has happened", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    // A facility already placed was placed under the old budget. Widening the
    // authorization afterwards would be rewriting what that placement was
    // permitted to cost, so every shape of "it already happened" is refused.
    const mutations: UtilityMutationProof[] = [
      { ...NO_MUTATION, firstFacilityPlacement: { status: "PLACED", commandId: "c1" } },
      { ...NO_MUTATION, firstFacilityPlacement: { status: "UNRESOLVED", commandId: "c1", outcome: "UNKNOWN" } },
      { ...NO_MUTATION, firstFacilityPlacement: { status: "TERMINAL_NO_MUTATION", commandId: "c1" }, submittedCommandIds: ["c1"] },
      { ...NO_MUTATION, submittedCommandIds: ["c1"] },
      { ...NO_MUTATION, firstFacilityPlacement: { status: "UNPROVEN", reason: "lineage unavailable" } },
    ];
    for (const mutation of mutations) {
      expect(() => amend(coordinator, activation, state, { mutation })).toThrow(
        "UTILITY_BUDGET_AMENDMENT_UTILITY_MUTATION_ALREADY_HAPPENED",
      );
    }
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("changes nothing but the budget: no reservation, no facility count, no identity", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const before = coordinator.snapshot();
    const stateBefore = structuredClone(state);

    amend(coordinator, activation, state);
    const after = coordinator.snapshot();

    // The record carries the project's identity and three numbers, and nothing
    // that could widen the project's scope: no reservation, no placement count.
    const record = after.utilityBudgetAmendments?.[0] as V2UtilityBudgetAmendmentRecord;
    expect(Object.keys(record).sort()).toEqual(
      [
        "amendedAt",
        "amendedEffectiveBudget",
        "amendmentId",
        "detail",
        "intentId",
        "originalProjectBudget",
        "projectId",
        "reason",
        "requiredUtilityBudget",
        "reservationRef",
        "schemaVersion",
        "trancheId",
      ].sort(),
    );
    // Identity and reservation are copied verbatim from the project they name.
    expect(record.projectId).toBe(stateBefore.project.id);
    expect(record.trancheId).toBe(stateBefore.tranche.id);
    expect(record.reservationRef).toBe(stateBefore.tranche.reservationRef);
    // The whole store is unchanged except for the appended record.
    expect({ ...after, utilityBudgetAmendments: before.utilityBudgetAmendments }).toEqual(before);
    expect(after.journalPosition).toBe(before.journalPosition);
    expect(after.commands).toEqual(before.commands);
    expect(after.checkpoints).toEqual(before.checkpoints);
  });

  test("leaves the historical admission record immutable", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const stateBefore = structuredClone(state);

    amend(coordinator, activation, state);

    // The admitted budget is what the amendment corrected, and it is exactly
    // what it still says: the correction is appended, never written back.
    expect(state).toEqual(stateBefore);
    expect(state.project.maximumBudget).toBe(ORIGINAL_BUDGET);
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("refuses before ROAD_DELIVERED and outside a durably activated world", () => {
    const { coordinator, activation } = activatedWorld();
    for (const stage of ["PLANNED", "SITE_SELECTED", "ZONED_WAITING_FOR_BUILDING"] as const) {
      expect(() => amend(coordinator, activation, roadDeliveredState({ stage }))).toThrow(
        "UTILITY_BUDGET_AMENDMENT_STAGE_NOT_ROAD_DELIVERED",
      );
    }
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);

    // An activation this coordinator did not itself make is not activation.
    const stranger = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    expect(() => amend(stranger, activation, roadDeliveredState())).toThrow("UTILITY_BUDGET_AMENDMENT_WORLD_NOT_ACTIVATED");
  });

  test("an electricity-shaped project, which declares no requirement, is untouched", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const before = coordinator.snapshot();

    const outcome = amend(coordinator, activation, state, { requirement: null });

    expect(outcome.status).toBe("NOT_REQUIRED");
    expect(coordinator.snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The post-placement connection settlement
// ---------------------------------------------------------------------------

/**
 * The live shape, in the fixture's own numbers: admission funded the facility
 * plus a pipe priced from the plan's geometry, and the course the execution will
 * actually submit — which starts at the facility's connector — costs more.
 */
const ACTUAL_PIPE_QUOTE = PIPE_QUOTE + 16;
const FUNDED_BUDGET = FACILITY_COST + PIPE_QUOTE;

/** The facility landed once, its connector bound, nothing submitted, no pipe yet. */
const SETTLED: UtilityConnectionSettlementProof = {
  facilityPlaced: true,
  facilityPlacementCount: 1,
  connectorResolved: true,
  connectionEffectAbsent: true,
  submittedCommandIds: [],
};

function settle(
  coordinator: V2DurabilityCoordinator,
  activation: ReturnType<typeof activatedWorld>["activation"],
  state: Gate1State,
  options: {
    treasury?: number;
    facilityPlannedCost?: number;
    actualConnectionQuote?: number;
    settlement?: UtilityConnectionSettlementProof;
  } = {},
) {
  return admitUtilityConnectionBudgetAmendment({
    durability: coordinator,
    activation,
    state,
    treasury: options.treasury ?? TREASURY,
    policy: V2_PROJECT_ADMISSION_POLICY,
    facilityPlannedCost: options.facilityPlannedCost ?? FACILITY_COST,
    actualConnectionQuote: options.actualConnectionQuote ?? ACTUAL_PIPE_QUOTE,
    settlement: options.settlement ?? SETTLED,
    amendmentId: `${state.project.id}:utility-connection-budget-amendment`,
    detail: "test",
  });
}

describe("post-placement connection budget settlement", () => {
  test("authorizes exactly the difference between the allowance and the real quote", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });
    const reservationBefore = structuredClone(state.project.utilityReservation);

    const outcome = settle(coordinator, activation, state);
    if (outcome.status !== "AMENDED") throw new Error(`expected a settlement, received ${outcome.status}`);

    // The allowance is DERIVED from the funded budget and the facility's own
    // plan cost, not supplied, so it is the figure admission actually priced.
    expect(outcome.connectionAllowance).toBe(PIPE_QUOTE);
    expect(outcome.actualConnectionQuote).toBe(ACTUAL_PIPE_QUOTE);
    expect(outcome.delta).toBe(16);
    expect(outcome.effectiveProjectBudget).toBe(FACILITY_COST + ACTUAL_PIPE_QUOTE);

    expect(outcome.record.reason).toBe(UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON);
    expect(outcome.record.originalProjectBudget).toBe(FUNDED_BUDGET);
    expect(outcome.record.requiredUtilityBudget).toBe(FACILITY_COST + ACTUAL_PIPE_QUOTE);
    expect(outcome.record.amendedEffectiveBudget).toBe(FACILITY_COST + ACTUAL_PIPE_QUOTE);
    expect(outcome.record.connectionAllowance).toBe(PIPE_QUOTE);
    expect(outcome.record.actualConnectionQuote).toBe(ACTUAL_PIPE_QUOTE);
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);

    // The admitted record is not rewritten by the settlement, and neither is the
    // reservation or the facility's authorization: the amendment only ever adds
    // a number beside them.
    expect(state.project.maximumBudget).toBe(FUNDED_BUDGET);
    expect(state.project.utilityReservation).toEqual(reservationBefore);
    expect(state.tranche.stage).toBe("ROAD_DELIVERED");
  });

  test("records nothing when the real quote already fits the allowance", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });
    const before = coordinator.snapshot();

    const outcome = settle(coordinator, activation, state, { actualConnectionQuote: PIPE_QUOTE });

    expect(outcome.status).toBe("NOT_REQUIRED");
    if (outcome.status !== "NOT_REQUIRED") throw new Error("expected no settlement");
    expect(outcome.reason).toBe("CONNECTION_QUOTE_WITHIN_ALLOWANCE");
    expect(outcome.effectiveProjectBudget).toBe(FUNDED_BUDGET);
    // Not merely unreported: nothing durable was written at all.
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(0);
    expect(coordinator.snapshot()).toEqual(before);
  });

  test("resumes the same settlement instead of adding a second one", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });

    const first = settle(coordinator, activation, state);
    if (first.status !== "AMENDED") throw new Error("expected a settlement");
    const again = settle(coordinator, activation, state);

    expect(again.status).toBe("ALREADY_AMENDED");
    expect(again.record.amendmentId).toBe(first.record.amendmentId);
    expect(again.effectiveProjectBudget).toBe(first.effectiveProjectBudget);
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);

    // A connector that moved is a new authoritative conflict, not a top-up.
    expect(() => settle(coordinator, activation, state, { actualConnectionQuote: ACTUAL_PIPE_QUOTE + 40 })).toThrow(
      "UTILITY_CONNECTION_BUDGET_AMENDMENT_QUOTE_CHANGED",
    );
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);
  });

  test("refuses once the connection has been submitted or already has an effect", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });

    // A submitted command was permitted to cost what the budget then said;
    // widening it afterwards would rewrite what it was allowed to spend.
    expect(() =>
      settle(coordinator, activation, state, { settlement: { ...SETTLED, submittedCommandIds: ["command-1"] } }),
    ).toThrow("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTION_ALREADY_SUBMITTED");
    // And a pipe that is already in the world needs no authorization to build.
    expect(() =>
      settle(coordinator, activation, state, { settlement: { ...SETTLED, connectionEffectAbsent: false } }),
    ).toThrow("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTION_EFFECT_PRESENT");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(0);
  });

  test("refuses until the facility has authoritatively settled exactly once", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });

    for (const settlement of [
      { ...SETTLED, facilityPlaced: false },
      { ...SETTLED, facilityPlacementCount: 0 },
      // Two facilities is not a settled slice, it is a duplicate.
      { ...SETTLED, facilityPlacementCount: 2 },
    ]) {
      expect(() => settle(coordinator, activation, state, { settlement })).toThrow(
        /UTILITY_CONNECTION_BUDGET_AMENDMENT_FACILITY_NOT_SETTLED/,
      );
    }
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(0);
  });

  test("fails closed when the connector cannot be uniquely rebound", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });
    const before = coordinator.snapshot();

    // The connector IS the geometry being priced, so an ambiguous or absent one
    // means the figure would be about a guess.
    expect(() =>
      settle(coordinator, activation, state, { settlement: { ...SETTLED, connectorResolved: false } }),
    ).toThrow("UTILITY_CONNECTION_BUDGET_AMENDMENT_CONNECTOR_NOT_RESOLVED");
    expect(coordinator.snapshot()).toEqual(before);
  });

  test("fails closed when the treasury cannot cover the settled figure", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });
    // 1 000 of treasury is a 250 share, far below the settled figure.
    expect(() => settle(coordinator, activation, state, { treasury: 1_000 })).toThrow(
      "UTILITY_CONNECTION_BUDGET_AMENDMENT_TREASURY_INSUFFICIENT",
    );
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(0);
  });

  test("carries the project's identity verbatim and leaves the durable project state alone", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState({ maximumBudget: FUNDED_BUDGET });
    createDurableGate1StateStorage(coordinator).save(state);
    const projectStateBefore = coordinator.projectState();

    const outcome = settle(coordinator, activation, state);
    if (outcome.status !== "AMENDED") throw new Error("expected a settlement");

    expect(outcome.record.projectId).toBe(state.project.id);
    expect(outcome.record.intentId).toBe(state.intent.id);
    expect(outcome.record.trancheId).toBe(state.tranche.id);
    expect(outcome.record.reservationRef).toBe(state.tranche.reservationRef);
    // The durable project is byte-identical: the settlement is a record beside
    // the admission, never an edit to it.
    expect(coordinator.projectState()).toEqual(projectStateBefore);
    // And it is not the journal's business either: no world effect was claimed.
    expect(coordinator.commandJournal.list()).toEqual([]);
  });

  test("coexists with the plan-funding amendment without changing it", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();

    // The plan-funding path is exactly as it was. An electricity-shaped project
    // declares no requirement, and the refusal for a second plan amendment still
    // says what it always said.
    const plan = amend(coordinator, activation, state);
    expect(plan.status).toBe("AMENDED");
    expect(plan.record.reason).toBe(UTILITY_BUDGET_AMENDMENT_REASON);
    // Idempotent on resume, and the durable one-per-(project, reason) bound still
    // refuses a second plan-funding record outright.
    expect(amend(coordinator, activation, state).status).toBe("ALREADY_AMENDED");
    expect(() =>
      coordinator.recordUtilityBudgetAmendment({
        amendmentId: `${state.project.id}:another`,
        state,
        originalProjectBudget: plan.record.originalProjectBudget,
        requiredUtilityBudget: plan.record.amendedEffectiveBudget,
        amendedEffectiveBudget: plan.record.amendedEffectiveBudget,
        detail: "test",
      }),
    ).toThrow("project budget is already amended");

    // A second, connection-scoped settlement is a different question and gets
    // its own record. Its allowance is derived from the budget as the plan
    // amendment left it, not from the admitted one.
    const settled = settle(coordinator, activation, state, { actualConnectionQuote: PIPE_QUOTE + 16 });
    if (settled.status !== "AMENDED") throw new Error(`expected a settlement, received ${settled.status}`);
    expect(settled.connectionAllowance).toBe(PIPE_QUOTE);
    expect(settled.record.originalProjectBudget).toBe(FACILITY_COST + PIPE_QUOTE);
    expect(settled.effectiveProjectBudget).toBe(FACILITY_COST + PIPE_QUOTE + 16);

    const records = coordinator.utilityBudgetAmendments();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.reason).sort()).toEqual(
      [UTILITY_BUDGET_AMENDMENT_REASON, UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON].sort(),
    );
    // The plan amendment's own figures are untouched by the later settlement.
    expect(records.find((record) => record.reason === UTILITY_BUDGET_AMENDMENT_REASON)).toEqual(plan.record);
    // And a further plan amendment still resolves to the recorded one rather
    // than adding anything.
    expect(amend(coordinator, activation, state).status).toBe("ALREADY_AMENDED");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(2);
  });
});
