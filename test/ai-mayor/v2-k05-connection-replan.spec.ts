import { executeSharedUtilityRecovery, type SharedUtilityRecoveryPorts } from "../../src/main/services/ai-mayor/utility-recovery";
import type { PlannedUtilityFacility, SpatialEntityRef, SpatialRoadEdge } from "../../src/main/services/ai-mayor/spatial/types";
import type { MayorAction, MayorBatchResult } from "../../src/main/services/ai-mayor/types";
import {
  createMemoryDurableStateStorage,
  V2DurabilityCoordinator,
} from "../../src/main/services/ai-mayor/v2/durability";
import { planStarterResidentialIntent, type Gate1State } from "../../src/main/services/ai-mayor/v2/gate1";
import {
  canReplanConnectionCourse,
  createDurableGreenfieldUtilityState,
  replanConnectionCourse,
  runScopedGreenfieldUtilityBootstrap,
  type DurableGreenfieldUtilityKindState,
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
 * Attempt 2's cable command reached native and settled to an authoritative
 * PROVEN_MISMATCH (`reconciliationStatus=MISMATCH`, `matchedEdgeIds=[]`), so the
 * single approved direct-cable candidate became `FAILED_DETERMINISTIC` and the
 * objective dead-ended at `UTILITY_CONNECTION_CANDIDATES_EXHAUSTED`.
 *
 * A deterministic verdict refuses one *course*, not the objective. These tests
 * pin the bounded replan transition: the refused candidate stays refused and is
 * never re-submitted, a genuinely different course is derived from the current
 * authoritative topology and admitted normally, an identical course is refused,
 * and the bounded budget terminates the objective instead of looping.
 */

const WORLD_SESSION = "cd0d8ea80e624df4abd692fc89df5cc4";
const SAVE_A = "save:load-asset-a:save-data-a";
const GENERATION_1 = "generation-1";
const DELIVERED_ROAD: SpatialEntityRef = { index: 177757, version: 15 };
const FACILITY_ENTITY: SpatialEntityRef = { index: 45581, version: 17 };
const FAILED_CABLE_COMMAND = "fa032a75-9676-44da-828b-1951f670a74e";

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
    intentId: "intent:gate1-starter:k05-replan",
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

const placedReceipt = {
  entity: FACILITY_ENTITY,
  prefab: "WindTurbine03",
  position: { x: -1117.83313, z: -11.0255737 },
};

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

/** The cable course Attempt 2 really submitted: planned against the old connector. */
const refusedCableActions: MayorAction[] = [
  { type: "build_road", prefab: "Low-voltage Ground Cable", x1: -1300.25, z1: -12.75, x2: -1247.55188, z2: -12.3875341 },
];

async function replanScope(): Promise<Awaited<ReturnType<typeof prepareScopedUtilityExecution>>["executionScope"]> {
  const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
  const activation = coordinator.activate(rawWorld(GENERATION_1));
  const input = buildUtilityPreparationInput({
    state: admittedState(),
    world: activation.world,
    treasury: 991_412,
    certifiedRoad: { entity: DELIVERED_ROAD, position: { x: -541.6216, z: -47.279007 }, prefab: "Medium Road" },
    certifiedRoadRefs: [DELIVERED_ROAD],
    // The scope is admission plumbing only; the durable kind state under test is
    // built explicitly below, so this mirrors the proven READY admission shape.
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
  if (prepared.status !== "READY") throw new Error(`expected READY, got ${prepared.reason}`);
  // These cases exercise the pre-revision topology replan contract. The
  // engine-fixed same-geometry retry is covered separately and is opt-in via
  // an explicit production executionMechanismRevision.
  return { ...prepared.executionScope, executionMechanismRevision: undefined };
}

/**
 * The durable kind state Attempt 2 stopped in: the facility is real, the cable
 * command is durably refused, and the objective is exhausted.
 */
function refusedCableKindState(
  scope: Awaited<ReturnType<typeof replanScope>>,
  options: { exactActions?: MayorAction[]; replanCount?: number } = {},
): DurableGreenfieldUtilityKindState {
  const state = createDurableGreenfieldUtilityState(scope);
  const exactActions = options.exactActions ?? refusedCableActions;
  const revision = scope.topologyRevision;
  const objectiveId = `${scope.projectId}:${scope.trancheId}:electricity:${revision}:${FACILITY_ENTITY.index}:${connector.node.index}`;
  state.utilities.electricity = {
    ...state.utilities.electricity,
    stage: "PLACED",
    constructionAttempts: 1,
    facilityCommandId: "710cd70f-b219-4255-abb9-48df2f7a263b",
    networkCommandIds: [FAILED_CABLE_COMMAND],
    commandOutcome: "OBSERVED_MISMATCH",
    lastFailureBoundary: "NATIVE_NETWORK_SUBMISSION",
    plan: { ...facilityPlan },
    planBinding: { projectId: scope.projectId, worldEpochId: scope.worldEpochId, topologyRevision: revision },
    facility: placedReceipt,
    connector,
    connectionObjective: {
      objectiveId, approvedPlanRevision: revision, candidateOrder: ["direct-cable"],
      status: "BLOCKED", observationBudget: 3, candidateBudget: 1,
    },
    candidateLedger: [{
      candidateId: `${objectiveId}:direct-cable`, objectiveId, kind: "direct-cable", ordinal: 0,
      exactActions: structuredClone(exactActions), actionFingerprint: JSON.stringify(exactActions),
      approvedPlanRevision: revision, spatialScope: structuredClone(scope.spatialEnvelope),
      budgetCeiling: scope.maximumSpend, ledgerState: "FAILED_DETERMINISTIC",
      ...(scope.targetSemantics ? { targetSemanticFingerprint: JSON.stringify(scope.targetSemantics) } : {}),
      commandId: FAILED_CABLE_COMMAND, primitiveEffect: "OBSERVED_MISMATCH",
    }],
    connectionReplan: {
      type: "CONNECTION_COURSE_REPLAN", replanCount: options.replanCount ?? 0, maximumReplans: 2, journal: [],
    },
  };
  return state;
}

/** The authoritative world read: the facility and its connector really exist. */
function observePort(scope: Awaited<ReturnType<typeof replanScope>>) {
  return async () => ({
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
    targetRoad: scope.targetServiceEntry?.road ?? DELIVERED_ROAD,
    evidenceGeneration: GENERATION_1,
    topologyRevision: scope.topologyRevision,
  });
}

/** The durable journal still holds Attempt 2's refused cable command. */
function inspectPort() {
  return async () => ({
    commandIds: [FAILED_CABLE_COMMAND],
    uncertain: false,
    authoritativeEffect: false,
    commands: [{ commandId: FAILED_CABLE_COMMAND, status: "OBSERVED_MISMATCH", exactInput: JSON.stringify(refusedCableActions) }],
  });
}

function progressPort() {
  return async () => ({
    status: "TARGET_REACHED" as const,
    startFrame: 0, targetFrame: 0, currentFrame: 0, paused: true, reason: "fixture",
  });
}

/** The real execution seam, driven with the candidate the bootstrap selected. */
function executionPort(
  scope: Awaited<ReturnType<typeof replanScope>>,
  batches: MayorAction[][],
  selectedPrimitives: Array<string | undefined>,
) {
  return async (request: Parameters<ScopedGreenfieldUtilityPorts["execute"]>[0]) => {
    selectedPrimitives.push(request.selectedPrimitive);
    // The authoritative world readback: once the cable batch really lands, the
    // scoped issue stops being active. Before it lands it still is.
    let cableBuilt = false;
    const capacity = async () => ({
      revision: GENERATION_1, capacity: cableBuilt ? 20_000 : 0, consumption: 0,
      fulfilledConsumption: 0, issueActive: !cableBuilt,
    });
    const recovery = await executeSharedUtilityRecovery({
      kind: request.state.kind,
      expectedRevision: null,
      treasury: scope.treasury,
      runwayMonths: 0,
      connectionOnly: true,
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
              start: { ...connector.worldPosition },
              end: { ...facilityPlan.connection.end },
            },
          },
          reason: "fixture",
        }),
        preflight: async () => true,
        execute: async (batch) => {
          batches.push(batch);
          cableBuilt = true;
          return { ok: true, executed: batch.length, failedAt: null, results: [] } as unknown as MayorBatchResult;
        },
        readConnectors: async () => [{ ...connector, attached: cableBuilt }],
        readCapacity: capacity,
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
      networkSubmissionAttempted: true,
      failedBeforeNetworkSubmission: false,
      executionSucceeded: recovery.ok,
      reason: recovery.reason,
    };
  };
}

describe("bounded connection-course replan after a deterministic native refusal", () => {
  const originalDirectCableOnly = process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY;
  beforeEach(() => {
    process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY = "1";
  });
  afterEach(() => {
    if (originalDirectCableOnly === undefined) delete process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY;
    else process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY = originalDirectCableOnly;
  });

  test("a refused candidate is replanned into a distinct course that is admitted, while the refused course is never resubmitted", async () => {
    const scope = await replanScope();
    let durable = createDurableGreenfieldUtilityState(scope);
    durable.utilities.electricity = refusedCableKindState(scope).utilities.electricity;
    const refusedCandidateId = durable.utilities.electricity.candidateLedger[0].candidateId;
    const batches: MayorAction[][] = [];
    const selected: Array<string | undefined> = [];

    const result = await runScopedGreenfieldUtilityBootstrap({
      scope,
      ports: {
        load: async () => structuredClone(durable),
        save: async (next) => { durable = structuredClone(next) as typeof durable; },
        rebind: async () => ({ status: "MATCH" as const, facility: placedReceipt, connector }),
        observe: observePort(scope),
        inspectNetworkCommands: inspectPort(),
        plan: async () => facilityPlan,
        execute: executionPort(scope, batches, selected),
        progress: progressPort(),
      } satisfies ScopedGreenfieldUtilityPorts,
    });

    const ledger = durable.utilities.electricity.candidateLedger;
    const refused = ledger.find((candidate) => candidate.candidateId === refusedCandidateId);
    const replanned = ledger.filter((candidate) => candidate.candidateId !== refusedCandidateId && candidate.kind === "direct-cable");

    // The refused course keeps its verdict and its durable command identity.
    expect(refused?.ledgerState).toBe("FAILED_DETERMINISTIC");
    expect(refused?.commandId).toBe(FAILED_CABLE_COMMAND);
    // A distinct replacement course exists, with a new stable identity.
    expect(replanned).toHaveLength(1);
    expect(replanned[0].candidateId).not.toBe(refusedCandidateId);
    expect(replanned[0].approvedPlanRevision).not.toBe(refused?.approvedPlanRevision);
    expect(replanned[0].actionFingerprint).not.toBe(refused?.actionFingerprint);
    // It was admitted and executed through the normal seam, as the direct cable.
    expect(selected).toEqual(["direct-cable"]);
    expect(batches).toHaveLength(1);
    expect(batches[0].every((action) => action.type === "build_road")).toBe(true);
    // The refused course's exact actions were never submitted again.
    expect(batches.some((batch) => JSON.stringify(batch) === JSON.stringify(refusedCableActions))).toBe(false);
    expect(replanned[0].ledgerState).toBe("OBSERVED_MATCH");
    expect(durable.utilities.electricity.connectionReplan.replanCount).toBe(1);
    expect(durable.utilities.electricity.connectionReplan.journal.at(-1)?.event).toBe("CONNECTION_COURSE_REPLANNED");
    expect(result.reason).not.toBe("UTILITY_CONNECTION_CANDIDATES_EXHAUSTED");
  });

  test("an identical course is refused rather than re-submitted under a new identity", async () => {
    const scope = await replanScope();
    // The world offers exactly the course that was already refused.
    const identical: MayorAction[] = [
      { type: "build_road", prefab: "Low-voltage Ground Cable", x1: connector.worldPosition.x, z1: connector.worldPosition.z, x2: -1247.55188, z2: -12.3875341 },
    ];
    let durable = createDurableGreenfieldUtilityState(scope);
    durable.utilities.electricity = refusedCableKindState(scope, { exactActions: identical }).utilities.electricity;
    durable.utilities.electricity.networkCommandIds = [];
    const batches: MayorAction[][] = [];
    const selected: Array<string | undefined> = [];

    const result = await runScopedGreenfieldUtilityBootstrap({
      scope,
      ports: {
        load: async () => structuredClone(durable),
        save: async (next) => { durable = structuredClone(next) as typeof durable; },
        rebind: async () => ({ status: "MATCH" as const, facility: placedReceipt, connector }),
        observe: observePort(scope),
        inspectNetworkCommands: async () => ({ commandIds: [], uncertain: false, authoritativeEffect: false, commands: [] }),
        plan: async () => facilityPlan,
        execute: executionPort(scope, batches, selected),
        progress: progressPort(),
      } satisfies ScopedGreenfieldUtilityPorts,
    });

    // The refusal consumed the bounded budget and terminated the objective.
    expect(batches).toHaveLength(0);
    expect(selected).toHaveLength(0);
    expect(durable.utilities.electricity.connectionReplan.replanCount).toBe(1);
    expect(durable.utilities.electricity.connectionReplan.journal.at(-1)?.event).toBe("CONNECTION_COURSE_REPLAN_REFUSED");
    expect(durable.utilities.electricity.candidateLedger).toHaveLength(1);
    expect(result.waiting).toBe(false);
    expect(result.reason).toBe("UTILITY_CONNECTION_CANDIDATES_EXHAUSTED");
  });

  test("an exhausted replan budget terminates the objective instead of looping", async () => {
    const scope = await replanScope();
    let durable = createDurableGreenfieldUtilityState(scope);
    durable.utilities.electricity = refusedCableKindState(scope, { replanCount: 2 }).utilities.electricity;
    const batches: MayorAction[][] = [];
    const selected: Array<string | undefined> = [];
    const executed: number[] = [];

    const ports = {
      load: async () => structuredClone(durable),
      save: async (next) => { durable = structuredClone(next) as typeof durable; },
      rebind: async () => ({ status: "MATCH" as const, facility: placedReceipt, connector }),
      observe: observePort(scope),
      inspectNetworkCommands: inspectPort(),
      plan: async () => facilityPlan,
      execute: async (request: Parameters<ScopedGreenfieldUtilityPorts["execute"]>[0]) => {
        executed.push(1);
        return executionPort(scope, batches, selected)(request);
      },
      progress: progressPort(),
    } satisfies ScopedGreenfieldUtilityPorts;

    expect(canReplanConnectionCourse(durable.utilities.electricity)).toBe(false);
    // Three bounded invocations: the budget is spent, so the objective stays
    // terminal and nothing is ever submitted again.
    for (let invocation = 0; invocation < 3; invocation += 1) {
      const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports });
      expect(result.reason).toBe("UTILITY_CONNECTION_CANDIDATES_EXHAUSTED");
      expect(result.waiting).toBe(false);
    }
    expect(executed).toHaveLength(0);
    expect(durable.utilities.electricity.connectionReplan.replanCount).toBe(2);
    expect(durable.utilities.electricity.candidateLedger).toHaveLength(1);
  });

  test("a restart preserves the refusal and continues from the replacement course", async () => {
    const scope = await replanScope();
    let durable = createDurableGreenfieldUtilityState(scope);
    durable.utilities.electricity = refusedCableKindState(scope).utilities.electricity;
    const refusedCandidateId = durable.utilities.electricity.candidateLedger[0].candidateId;
    const batches: MayorAction[][] = [];
    const selected: Array<string | undefined> = [];
    const ports = {
      load: async () => structuredClone(durable),
      save: async (next) => { durable = structuredClone(next) as typeof durable; },
      rebind: async () => ({ status: "MATCH" as const, facility: placedReceipt, connector }),
      observe: observePort(scope),
      inspectNetworkCommands: inspectPort(),
      plan: async () => facilityPlan,
      execute: executionPort(scope, batches, selected),
      progress: progressPort(),
    } satisfies ScopedGreenfieldUtilityPorts;

    await runScopedGreenfieldUtilityBootstrap({ scope, ports });
    const afterFirst = structuredClone(durable);
    // Restart: the durable state is reloaded and re-entered, as resume does.
    durable = structuredClone(afterFirst);
    await runScopedGreenfieldUtilityBootstrap({ scope, ports });

    const ledger = durable.utilities.electricity.candidateLedger;
    const refused = ledger.find((candidate) => candidate.candidateId === refusedCandidateId);
    expect(refused?.ledgerState).toBe("FAILED_DETERMINISTIC");
    expect(refused?.commandId).toBe(FAILED_CABLE_COMMAND);
    // The replacement was attempted, so it is no longer a *new* course: the
    // restart must not mint a third candidate from the same geometry.
    expect(ledger.filter((candidate) => candidate.kind === "direct-cable")).toHaveLength(2);
    expect(durable.utilities.electricity.connectionReplan.replanCount).toBe(2);
    expect(durable.utilities.electricity.connectionReplan.journal.at(-1)?.event).toBe("CONNECTION_COURSE_REPLAN_REFUSED");
    expect(batches.some((batch) => JSON.stringify(batch) === JSON.stringify(refusedCableActions))).toBe(false);
  });
});
