import {
  createSkillRegistry,
  executeProductionSkillIntent,
  K05CommissionUtilitiesWorkflowAdapter,
} from "../../src/main/services/ai-mayor/skills";
import type {
  PlannedUtilityFacility,
  SpatialEntityRef,
  SpatialRoadEdge,
} from "../../src/main/services/ai-mayor/spatial/types";
import type { NativeWorldIdentity } from "../../src/main/services/ai-mayor/v2/durability";
import { type Gate1State, planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";
import type { V2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import {
  type AuthoritativeUtilityAdmissionContext,
  buildUtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import {
  prepareScopedUtilityExecution,
  utilityPlanningScope,
  type UtilityExecutionPlannerPorts,
  type UtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-execution-planner";

const GENERATION = "generation-k05-parity";
/** The road Gate 1 delivered, exactly as the live durable evidence recorded it. */
const DELIVERED_ROAD: SpatialEntityRef = { index: 45586, version: 13 };
/** The reservation the K05 recipe is admitted to build inside. */
const RESERVATION = { center: { x: -1279.5518493553857, z: -12.431820151711868 }, radius: 180 };
const TREASURY = 999_912;

const world: NativeWorldIdentity = {
  worldId: "cs2-session:k05-parity",
  nativeSessionGuid: "session:k05-parity",
  loadPurpose: "LoadGame",
  loadAssetGuid: null,
  saveDataAssetGuid: null,
  mapAssetGuid: null,
  checkpointId: "checkpoint:k05-parity",
  bridgeRuntimeEpoch: "bridge:k05-parity",
  generation: GENERATION,
  generationSequence: 2,
  generationOrigin: "LOAD_COMPLETED",
  worldEpochId: "cs2-session:k05-parity:epoch",
  worldReady: true,
};

function admittedState(): Gate1State {
  const state = planStarterResidentialIntent({
    intentId: "intent:gate1-starter:k05-parity",
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: RESERVATION,
    siteCandidates: [{ id: "site-1", target: { center: RESERVATION.center, radius: 32 }, score: 1, blocked: false }],
  });
  state.tranche.stage = "ROAD_DELIVERED";
  return state;
}

/** The authoritative production context readiness and dispatch both consume. */
const authoritativeContext = (
  overrides: Partial<AuthoritativeUtilityAdmissionContext> = {},
): AuthoritativeUtilityAdmissionContext => ({
  state: admittedState(),
  world,
  treasury: TREASURY,
  certifiedRoad: { entity: DELIVERED_ROAD, position: { x: -1247.55188, z: -12.3875341 }, prefab: "Medium Road" },
  certifiedRoadRefs: [DELIVERED_ROAD],
  firstFacilityPlacement: { status: "NONE" },
  ...overrides,
});

/** The plan the live world produced once the certified road scoped the search. */
const windTurbine: PlannedUtilityFacility = {
  kind: "power",
  prefab: "WindTurbine03",
  position: { x: -1117.8, z: -11.0 },
  rotationCandidates: [0],
  constructionCost: 8_500,
  expectedCapacity: 20_000,
  siteEvidence: { source: "fixture" },
  serviceRoads: [{ start: { x: -1247.6, z: -12.4 }, end: { x: -1236.5, z: -11.7 } }],
  connection: { prefab: "Low-voltage Ground Cable", start: { x: -1117.8, z: -11.0 }, end: { x: -1247.6, z: -12.4 } },
};

const connector = {
  type: "electricity" as const,
  node: { index: 20, version: 1 },
  worldPosition: { x: -1117.8, z: -11.0 },
  attached: true,
  capacity: { electricity: 20_000 },
};

const deliveredRoadEdge: SpatialRoadEdge = {
  entity: DELIVERED_ROAD,
  prefab: "Medium Road",
  native: true,
  startNode: { index: 56051, version: 15 },
  endNode: { index: 45582, version: 13 },
  start: { x: -1247.55188, z: -12.3875341 },
  end: { x: -1263.55, z: -12.41 },
  length: 16,
};

function plannerPorts(options: { plan?: PlannedUtilityFacility } = {}): UtilityExecutionPlannerPorts {
  return {
    plan: async (_kind, context) =>
      context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? { status: "candidate", reason: "fixture" }
        : { status: "candidate", facility: options.plan ?? windTurbine, reason: "fixture" },
    preflight: async () => true,
    readConnectors: async () => [connector],
    readCapacity: async () => ({ revision: GENERATION, capacity: 0, consumption: 0, fulfilledConsumption: 0, issueActive: true }),
    currentRevision: async () => GENERATION,
    findCurrentUtilityBinding: async () => ({ status: "BLOCKED" as const, reason: "UTILITY_FACILITY_NOT_FOUND" }),
    findExistingFacility: async () => undefined,
    roadEdges: async () => [deliveredRoadEdge],
  };
}

/** The production workflow boundary, recording the preparation it was handed. */
function capturingFoundation(): {
  foundation: Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">;
  captured: () => UtilityPreparationInput | undefined;
} {
  let captured: UtilityPreparationInput | undefined;
  return {
    captured: () => captured,
    foundation: {
      greenfieldUtilityBootstrap: {
        prepare: async (input: UtilityPreparationInput) => {
          captured = input;
          return { status: "BLOCKED" as const, reason: "UTILITY_PLAN_UNAVAILABLE" as const, nativeActionsSubmitted: 0 as const };
        },
        run: async () => {
          throw new Error("a blocked preparation must never reach run()");
        },
      },
    } satisfies Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">,
  };
}

describe("K05 production preflight/dispatch parity", () => {
  test.each(["REUSE_REACHABLE_NETWORK", "REPAIR_MISSING_FLOW_PATH", "EXTEND_EXISTING_NETWORK", "RECONNECT_TARGET",
    "ALTERNATE_TARGET", "ALTERNATE_TOPOLOGY"])("post-connection %s enters the persisted Utility plan without stale facility-origin preflight", async (strategyId) => {
    const context = authoritativeContext();
    const prepare = jest.fn(async () => { throw new Error("stale recipe preflight must not run"); });
    const run = jest.fn(async () => ({ serviceCertified: false, waiting: false, reason: "NETWORK_REPAIR_CANDIDATE_REJECTED" }));
    const foundation = { greenfieldUtilityBootstrap: { prepare, run } } as never;
    const adapter = new K05CommissionUtilitiesWorkflowAdapter(foundation);
    const result = await adapter.executeProduction({
      skillId: "skill.K05", utilityKind: "electricity", strategyId,
    }, context, new AbortController().signal);

    expect(prepare).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ commissionedKinds: ["electricity"], targetSemantics: {
      role: "NETWORK_ENTRY", utility: "ELECTRICITY",
    } });
    expect(result).toMatchObject({ status: "FAILED", error: "K05_RUN_BLOCKED:NETWORK_REPAIR_CANDIDATE_REJECTED" });
  });

  test("the read-only preflight preparation and the production dispatch preparation are identical", async () => {
    const context = authoritativeContext();
    // Exactly what MayorRuntime.productionK05Preflight() maps into the builder.
    const preflightPreparation = buildUtilityPreparationInput(context);
    const { foundation, captured } = capturingFoundation();

    const result = await executeProductionSkillIntent({
      registry: createSkillRegistry(),
      foundation,
      intent: { skillId: "skill.K05" },
      authoritativeContext: context,
      workflows: [new K05CommissionUtilitiesWorkflowAdapter(foundation)],
    });

    expect(result).toMatchObject({ status: "FAILED", error: "K05_PREPARE_BLOCKED:UTILITY_PLAN_UNAVAILABLE" });
    // One authoritative context, one preparation: no field may go missing on the
    // real dispatch path that the preflight reported as ready.
    expect(captured()).toEqual(preflightPreparation);
    expect(preflightPreparation.facilityPlacementAuthorization?.certifiedRoadRefs).toEqual([DELIVERED_ROAD]);
    expect(preflightPreparation.firstFacilityPlacement).toEqual({ status: "NONE" });
  });

  test("the production planning scope carries the certified road the placement was authorized against", () => {
    const preparation = buildUtilityPreparationInput(authoritativeContext());
    const authorization = preparation.facilityPlacementAuthorization;
    if (!authorization) throw new Error("expected a first-placement authorization");

    const scope = utilityPlanningScope(preparation);
    expect(scope.certifiedRoadRefs).toEqual([DELIVERED_ROAD]);
    // The entry carries the delivered command's own prefab alongside the road
    // and its committed start endpoint: together they are what reacquires the
    // road by geometry once the durable ref stops naming anything after a
    // reload, and the contact point alone is not unique at a junction.
    expect(scope.targetServiceEntry).toEqual({
      road: DELIVERED_ROAD,
      position: authorization.targetRoad.position,
      prefab: authorization.targetRoad.prefab,
    });
    expect(scope.spatialEnvelope).toEqual(preparation.spatialEnvelope);

    // Without a placement authorization the scope keeps its placeholder road
    // authority; the existing-facility connection path plans no greenfield site.
    const connectionScope = utilityPlanningScope(
      buildUtilityPreparationInput(authoritativeContext({ certifiedRoad: undefined, certifiedRoadRefs: undefined })),
    );
    expect(connectionScope.certifiedRoadRefs).toEqual([]);
    expect(connectionScope.targetServiceEntry.road).toEqual({ index: -1, version: -1 });
  });

  test("an in-reservation plan is admitted while an off-reservation plan stays blocked", async () => {
    const preparation = buildUtilityPreparationInput(authoritativeContext());

    const inside = await prepareScopedUtilityExecution(preparation, plannerPorts());
    expect(inside).toMatchObject({ status: "READY", mode: "GREENFIELD_FIRST_PLACEMENT" });
    if (inside.status !== "READY") return;
    expect(inside.executionScope.certifiedRoadRefs).toEqual([DELIVERED_ROAD]);
    expect(inside.executionScope.targetServiceEntry.road).toEqual(DELIVERED_ROAD);

    const outside = await prepareScopedUtilityExecution(
      preparation,
      plannerPorts({ plan: { ...windTurbine, position: { x: -1117.8, z: -191 } } }),
    );
    expect(outside).toMatchObject({
      status: "BLOCKED",
      reason: "UTILITY_FACILITY_NOT_FOUND",
      nativeActionsSubmitted: 0,
      diagnostics: { preparationReason: "placement_outside_authorized_reservation" },
    });
  });

  test("an unauthorized preparation still fails closed with no native submission", async () => {
    const preparation = buildUtilityPreparationInput(authoritativeContext({ certifiedRoad: undefined, certifiedRoadRefs: undefined }));
    expect(preparation.facilityPlacementAuthorization).toBeUndefined();

    const result = await prepareScopedUtilityExecution(preparation, plannerPorts());
    expect(result).toMatchObject({ status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND", nativeActionsSubmitted: 0 });
  });
});
