import { executeSharedUtilityRecovery, type SharedUtilityRecoveryPorts } from "../../src/main/services/ai-mayor/utility-recovery";
import type { PlannedUtilityFacility, SpatialEntityRef, SpatialRoadEdge } from "../../src/main/services/ai-mayor/spatial/types";
import type { MayorAction, MayorBatchResult } from "../../src/main/services/ai-mayor/types";
import {
  createMemoryDurableStateStorage,
  V2DurabilityCoordinator,
} from "../../src/main/services/ai-mayor/v2/durability";
import { planStarterResidentialIntent, type Gate1State } from "../../src/main/services/ai-mayor/v2/gate1";
import {
  createDurableGreenfieldUtilityState,
  runScopedGreenfieldUtilityBootstrap,
  type ScopedGreenfieldUtilityPorts,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import {
  AUTHORITATIVE_UTILITY_KIND,
  buildUtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import {
  prepareScopedUtilityExecution,
  type UtilityExecutionPlannerPorts,
} from "../../src/main/services/ai-mayor/v2/utility-execution-planner";

/**
 * Attempt 2 of the K05 live proof stopped with a facility that really exists in
 * the world (WindTurbine03), a placement command that reached native
 * (`NATIVE_COMPLETED`) but could not certify its completion, and a durable
 * `commandOutcome` of UNKNOWN. The workflow then held on
 * UTILITY_RECONCILIATION_REQUIRED and the connection step was never reached.
 *
 * These tests pin the continuation behavior: a settled facility placement plus
 * a *stale* placement-derived outcome must not hold the connection step, and a
 * proven-missing facility must never cause a blind placement.
 */

const WORLD_SESSION = "cd0d8ea80e624df4abd692fc89df5cc4";
const SAVE_A = "save:load-asset-a:save-data-a";
const GENERATION_1 = "generation-1";
const DELIVERED_ROAD: SpatialEntityRef = { index: 177757, version: 15 };
const FACILITY_ENTITY: SpatialEntityRef = { index: 45581, version: 17 };

function rawWorld(generation: string) {
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${WORLD_SESSION}`,
      nativeSessionGuid: WORLD_SESSION,
      loadPurpose: "LoadGame",
      loadAssetGuid: "load-asset-a",
      saveDataAssetGuid: "save-data-a",
      mapAssetGuid: "map-a",
      checkpointId: SAVE_A,
      bridgeRuntimeEpoch: `bridge-${generation}`,
      generation,
      generationSequence: 1,
      generationOrigin: "LOAD_COMPLETED",
    },
  };
}

function admittedState(): Gate1State {
  const state = planStarterResidentialIntent({
    intentId: "intent:gate1-starter:k05-continuation",
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
    siteCandidates: [{ id: "site-1", target: { center: { x: 0, z: 0 }, radius: 32 }, score: 1, blocked: false }],
  });
  state.tranche.stage = "ROAD_DELIVERED";
  return state;
}

const facilityPlan: PlannedUtilityFacility = {
  kind: "power",
  prefab: "WindTurbine03",
  position: { x: -1117.83313, z: -11.025574 },
  rotationCandidates: [0],
  constructionCost: 8_500,
  expectedCapacity: 20_000,
  siteEvidence: { source: "fixture" },
  serviceRoads: [{ start: { x: -1247.55188, z: -12.3875341 }, end: { x: -1141.6318, z: -11.275444 } }],
  connection: {
    prefab: "Low-voltage Ground Cable",
    start: { x: -1117.83313, z: -11.025574 },
    end: { x: -1247.55188, z: -12.3875341 },
  },
};

const connector = {
  type: "electricity" as const,
  node: { index: 45582, version: 3 },
  worldPosition: { x: -1117.83313, z: -11.025574 },
  attached: false,
  orphan: false,
  capacity: { electricity: 20_000 },
  connectedEdges: [],
};

/** The facility the native placement really created, as the world reports it. */
const placedReceipt = {
  entity: FACILITY_ENTITY,
  prefab: "WindTurbine03",
  position: { x: -1117.83313, z: -11.0255737 },
};

/** The service road the approved candidate contacts: the plan's own geometry. */
const connectionRoadEdge: SpatialRoadEdge = {
  entity: DELIVERED_ROAD,
  prefab: "Medium Road",
  native: true,
  startNode: { index: 1, version: 1 },
  endNode: { index: 2, version: 1 },
  start: { x: -1247.55188, z: -12.3875341 },
  end: { x: -1141.6318, z: -11.275444 },
  length: 106,
};

function harness() {
  const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
  const activation = coordinator.activate(rawWorld(GENERATION_1));
  const state = admittedState();
  return { coordinator, world: activation.world, state };
}

async function continuationScope(): Promise<Awaited<ReturnType<typeof prepareScopedUtilityExecution>>["executionScope"]> {
  const h = harness();
  const input = buildUtilityPreparationInput({
    state: h.state,
    world: h.world,
    treasury: 999_912,
    certifiedRoad: { entity: DELIVERED_ROAD, position: { x: -541.6216, z: -47.279007 }, prefab: "Medium Road" },
    certifiedRoadRefs: [DELIVERED_ROAD],
    // The live durable truth: the first placement reached native and could not
    // certify its completion, while the world really has the facility.
    firstFacilityPlacement: {
      status: "UNRESOLVED",
      commandId: "710cd70f-b219-4255-abb9-48df2f7a263b",
      outcome: "NATIVE_COMPLETED",
    },
  });
  const planner: UtilityExecutionPlannerPorts = {
    plan: async () => ({ status: "candidate", facility: facilityPlan, reason: "fixture" }),
    preflight: async () => true,
    readConnectors: async () => [connector],
    readCapacity: async () => ({
      revision: GENERATION_1, capacity: 0, consumption: 0, fulfilledConsumption: 0, issueActive: true,
    }),
    currentRevision: async () => GENERATION_1,
    findCurrentUtilityBinding: async () =>
      ({ status: "MATCH" as const, binding: { facility: placedReceipt, connector } }),
    findExistingFacility: async () => placedReceipt,
    roadEdges: async () => [connectionRoadEdge],
  };
  const prepared = await prepareScopedUtilityExecution(input, planner);
  expect(prepared.status).toBe("READY");
  return prepared.executionScope;
}

/** The exact durable kind state Attempt 2 stopped in. */
function stuckKindState(scope: Awaited<ReturnType<typeof continuationScope>>) {
  const state = createDurableGreenfieldUtilityState(scope);
  state.utilities.electricity = {
    ...state.utilities.electricity,
    stage: "MISSING",
    constructionAttempts: 1,
    facilityCommandId: "710cd70f-b219-4255-abb9-48df2f7a263b",
    commandOutcome: "UNKNOWN",
    lastRecoveryReason: "UTILITY_NATIVE_OUTCOME_UNCERTAIN",
    lastFailureBoundary: "NATIVE_NETWORK_SUBMISSION",
    plan: { ...facilityPlan },
    planBinding: {
      projectId: scope.projectId,
      worldEpochId: scope.worldEpochId,
      topologyRevision: scope.topologyRevision,
    },
  };
  return state;
}

describe("K05 continuation after a native facility placement", () => {
  const originalDirectCableOnly = process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY;
  beforeEach(() => {
    // Production runs the direct cable. The service-road candidate is not part
    // of this continuation.
    process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY = "1";
  });
  afterEach(() => {
    if (originalDirectCableOnly === undefined) delete process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY;
    else process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY = originalDirectCableOnly;
  });

  test("a settled placement with a stale UNKNOWN outcome still reaches the connection step", async () => {
    const scope = await continuationScope();
    let durable = stuckKindState(scope);
    const batches: MayorAction[][] = [];

    const result = await runScopedGreenfieldUtilityBootstrap({
      scope,
      ports: {
        load: async () => structuredClone(durable),
        save: async (next) => {
          durable = structuredClone(next) as typeof durable;
        },
        // The world still has the facility the native placement created.
        rebind: async () => ({ status: "MATCH" as const, facility: placedReceipt, connector }),
        observe: async (_kind, currentScope) => ({
          status: "AVAILABLE" as const,
          revision: GENERATION_1,
          capacity: 0,
          consumption: 0,
          fulfilledConsumption: 0,
          issueActive: true,
          supplyExists: true,
          networkConnected: false,
          cityCapacityAvailable: false,
          targetNetworkReachable: false,
          facility: placedReceipt,
          connector,
          targetRoad: currentScope.targetServiceEntry?.road ?? DELIVERED_ROAD,
          evidenceGeneration: GENERATION_1,
          topologyRevision: currentScope.topologyRevision,
        }),
        inspectNetworkCommands: async () => ({ commandIds: [], uncertain: false, authoritativeEffect: false, commands: [] }),
        plan: async () => facilityPlan,
        execute: async (request) => {
          const connectionOnly = !!request.state.facility;
          const recovery = await executeSharedUtilityRecovery({
            kind: request.state.kind,
            expectedRevision: null,
            treasury: scope.treasury,
            runwayMonths: 0,
            connectionOnly,
            selectedPrimitive: request.selectedPrimitive,
            signal: new AbortController().signal,
            ports: {
              plan: async () => ({
                status: "candidate" as const,
                connection: {
                  mode: "EXISTING_FACILITY_CONNECTION" as const,
                  kind: AUTHORITATIVE_UTILITY_KIND,
                  facility: placedReceipt,
                  connection: {
                    prefab: "Low-voltage Ground Cable" as const,
                    start: { x: -1117.83313, z: -11.025574 },
                    end: { x: -1247.55188, z: -12.3875341 },
                  },
                },
                reason: "fixture",
              }),
              preflight: async () => true,
              execute: async (batch) => {
                batches.push(batch);
                return { ok: true, executed: batch.length, failedAt: null, results: [] } as unknown as MayorBatchResult;
              },
              readConnectors: async () => [{ ...connector }],
              readCapacity: async () => ({
                revision: GENERATION_1, capacity: 0, consumption: 0, fulfilledConsumption: 0, issueActive: true,
              }),
              settle: async () => undefined,
              currentRevision: async () => GENERATION_1,
              findExistingFacility: async () => placedReceipt,
              findCurrentUtilityBinding: async () =>
                ({ status: "MATCH" as const, binding: { facility: placedReceipt, connector } }),
            } satisfies SharedUtilityRecoveryPorts,
          });
          return {
            state: {
              ...request.state,
              facility: recovery.facility ?? request.state.facility,
              connector: recovery.connector ?? request.state.connector,
              stage: recovery.facility ? ("PLACED" as const) : ("BLOCKED" as const),
            },
            facilityConstructionAttempted: false,
            networkSubmissionAttempted: connectionOnly,
            failedBeforeNetworkSubmission: false,
            executionSucceeded: recovery.ok,
            reason: recovery.reason,
          };
        },
        progress: async () => ({
          status: "TARGET_REACHED" as const,
          startFrame: 0,
          targetFrame: 0,
          currentFrame: 0,
          paused: true,
          reason: "fixture",
        }),
      } satisfies ScopedGreenfieldUtilityPorts,
    });

    // The connection step ran: exactly the primitives of the existing facility.
    expect(batches.flat().some((action) => action.type === "place_building")).toBe(false);
    expect(batches.some((batch) => batch.length > 0 && batch.every((action) => action.type === "build_road"))).toBe(true);
    // It is no longer held on the placement's own uncertainty.
    expect(result.reason).not.toBe("UTILITY_RECONCILIATION_REQUIRED");
    expect(durable.utilities.electricity.stage).not.toBe("MISSING");
  });

  test("a proven-missing facility places nothing and stays fail-closed", async () => {
    const scope = await continuationScope();
    let durable = stuckKindState(scope);
    const batches: MayorAction[][] = [];

    const result = await runScopedGreenfieldUtilityBootstrap({
      scope,
      ports: {
        load: async () => structuredClone(durable),
        save: async (next) => {
          durable = structuredClone(next) as typeof durable;
        },
        rebind: async () => ({ status: "PROVEN_MISSING" as const, reason: "UTILITY_FACILITY_PROVEN_MISSING" }),
        observe: async (_kind, currentScope) => ({
          status: "AVAILABLE" as const,
          revision: GENERATION_1,
          capacity: 0,
          consumption: 0,
          fulfilledConsumption: 0,
          issueActive: true,
          supplyExists: false,
          networkConnected: false,
          cityCapacityAvailable: false,
          targetNetworkReachable: false,
          facility: null,
          connector: null,
          targetRoad: currentScope.targetServiceEntry?.road ?? DELIVERED_ROAD,
          evidenceGeneration: GENERATION_1,
          topologyRevision: currentScope.topologyRevision,
        }),
        plan: async () => facilityPlan,
        execute: async (request) => {
          batches.push([{ type: "place_building", prefab: facilityPlan.prefab, x: request.plan.position.x, z: request.plan.position.z, rotation: 0 }]);
          return {
            state: request.state,
            facilityConstructionAttempted: true,
            networkSubmissionAttempted: false,
            failedBeforeNetworkSubmission: false,
            executionSucceeded: true,
            reason: "fixture",
          };
        },
        progress: async () => ({
          status: "TARGET_REACHED" as const,
          startFrame: 0,
          targetFrame: 0,
          currentFrame: 0,
          paused: true,
          reason: "fixture",
        }),
      } satisfies ScopedGreenfieldUtilityPorts,
    });

    expect(batches).toHaveLength(0);
    expect(result.waiting).toBe(false);
    expect(result.reason).toBe("UTILITY_FACILITY_PROVEN_MISSING");
  });

  test("a durably settled first placement continues connection-only instead of holding", async () => {
    const h = harness();
    // The durable truth after reconciliation: the placement command settled to
    // OBSERVED_MATCH, so this scope's facility exists and may never be placed
    // again. The resumed preparation must rebind it and connect it.
    const input = buildUtilityPreparationInput({
      state: h.state,
      world: h.world,
      treasury: 999_912,
      certifiedRoad: { entity: DELIVERED_ROAD, position: { x: -1247.55188, z: -12.3875341 }, prefab: "Medium Road" },
      certifiedRoadRefs: [DELIVERED_ROAD],
      firstFacilityPlacement: {
        status: "PLACED",
        commandId: "710cd70f-b219-4255-abb9-48df2f7a263b",
      },
    });
    let bindingReads = 0;
    const planner: UtilityExecutionPlannerPorts = {
      plan: async (_kind, context) =>
        context?.mode === "EXISTING_FACILITY_CONNECTION"
          ? {
              status: "candidate",
              reason: "fixture",
              connection: {
                mode: "EXISTING_FACILITY_CONNECTION",
                kind: "electricity",
                facility: placedReceipt,
                connection: {
                  prefab: "Low-voltage Ground Cable",
                  start: { x: -1117.83313, z: -11.0255737 },
                  end: { x: -1247.55188, z: -12.3875341 },
                },
              },
            }
          : { status: "candidate", facility: facilityPlan, reason: "fixture" },
      preflight: async () => true,
      readConnectors: async () => [connector],
      readCapacity: async () => ({
        revision: GENERATION_1, capacity: 0, consumption: 0, fulfilledConsumption: 0, issueActive: true,
      }),
      currentRevision: async () => GENERATION_1,
      findCurrentUtilityBinding: async () => {
        bindingReads += 1;
        return { status: "MATCH" as const, binding: { facility: placedReceipt, connector } };
      },
      // The live divergence: the greenfield site is re-planned, and the plan
      // search no longer contains the facility the placement really created.
      findExistingFacility: async () => undefined,
      roadEdges: async () => [connectionRoadEdge],
    };

    const prepared = await prepareScopedUtilityExecution(input, planner);
    if (prepared.status !== "READY") throw new Error("expected READY, got " + JSON.stringify(prepared.reason));
    expect(bindingReads).toBeGreaterThan(0);
    expect(prepared.nativeActions.some((action) => action.type === "place_building")).toBe(false);
    expect(prepared.nativeActions.length).toBeGreaterThan(0);
    expect(prepared.currentFacility).toEqual(placedReceipt);
  });
});
