import type {
  SpatialBootstrapAsset,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "../../src/main/services/ai-mayor/spatial/types";
import {
  buildSpatialWorldModel,
  parseSpatialBootstrapScan,
} from "../../src/main/services/ai-mayor/spatial/world-scanner";
import { createMemoryDurableStateStorage } from "../../src/main/services/ai-mayor/v2/durability";
import {
  createGate1VerticalSlice,
  createMemoryGate1StateStorage,
  type Gate1Observation,
  type Gate1Stage,
  type Gate1State,
  type Gate1WorldBoundary,
  planStarterResidentialIntent,
  V2_GATE1_STATE_SCHEMA_VERSION,
} from "../../src/main/services/ai-mayor/v2/gate1";
import {
  createDurableGreenfieldUtilityState,
  type DurableGreenfieldUtilityState,
  type GreenfieldUtilityExecutionScope,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import {
  createV2ProjectAdmissionBootstrap,
  isStandaloneRoadGoalAdmission,
  goalWorkOrderRoadSearchTarget,
  exactRoadTerminalPoint,
  goalCompletionStageForGoalId,
  latestObservedRoadTerminal,
  maximumSiteAnchorsForGoal,
  deriveCurrentBranchProjectReplanIdentity,
  deriveStarterProjectBudget,
  deriveStarterProjectIntentId,
  deriveGoalSuccessorGoalId,
  deriveReplacementStarterProjectIntentId,
  MAXIMUM_ADMISSION_ROAD_PREVIEWS,
  MAXIMUM_GOAL_SUCCESSOR_STEPS,
  planningEnvelopeRadiusLadder,
  resolveGoalWorkOrderId,
  sameGoalFamilyGoalIds,
  V2_PROJECT_ADMISSION_POLICY,
  V2GrowableFootprintUnserviceableError,
  type V2ProjectAdmissionObservationPort,
  type V2ProjectSiteConstraint,
} from "../../src/main/services/ai-mayor/v2/project-admission";
import type { Gate1BoundedSiteCandidate } from "../../src/main/services/ai-mayor/v2/site-selection";
import { MAXIMUM_BOUNDED_ROAD_CANDIDATES } from "../../src/main/services/ai-mayor/v2/road-connection-resolver";
import { buildUtilityPreparationInput } from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import { minimumFeasibleUtilityBudget, type UtilityMutationProof } from "../../src/main/services/ai-mayor/v2/utility-budget";
import {
  ADMISSION_SEMANTICS_REVISION,
  deriveAdmissionSemanticRepairId,
  deriveAdmissionSemanticRepairIntentId,
  resolveAdmissionLineageRoot,
  type AdmissionSemanticsReplayEvidence,
} from "../../src/main/services/ai-mayor/v2/admission-semantic-repair";
import {
  createWaterSiteConstraint,
  type WaterFacilityPlacement,
} from "../../src/main/services/ai-mayor/v2/water-site-constraint";

const INSTANT = new Date("2026-01-02T03:04:05.000Z");
const SESSION_A = "11111111111111111111111111111111";
const SESSION_B = "22222222222222222222222222222222";
const TREASURY = 40_000;

// ---------------------------------------------------------------------------
// Authoritative observation fixtures. These are the same bounded scan/detail
// payloads the native Bridge returns; nothing here fabricates project identity.
// ---------------------------------------------------------------------------

const scanPayload = {
  world: { min: -200, max: 200, size: 400 },
  tiles: [
    {
      entity: { index: 1, version: 1 },
      owned: true,
      bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } },
      center: { x: 0, z: 0 },
      polygon: [],
    },
  ],
  outsideConnections: [],
  bootstrapAssets: [],
  roadGraph: {
    truncated: false,
    nodes: [
      {
        entity: { index: 10, version: 1 },
        position: { x: 0, y: 0, z: 0 },
        native: true,
        outsideConnection: false,
        roadDegree: 1,
      },
      {
        entity: { index: 11, version: 1 },
        position: { x: 30, y: 0, z: 0 },
        native: true,
        outsideConnection: false,
        roadDegree: 1,
      },
    ],
    edges: [
      {
        entity: { index: 20, version: 1 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 10, version: 1 },
        endNode: { index: 11, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: 30, z: 0 },
        length: 30,
      },
    ],
  },
};

const siteDetail: SpatialSiteDetail = {
  center: { x: 20, z: 0 },
  radius: 96,
  terrain: {
    resolution: 2,
    bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
    cellSize: { x: 100, z: 100 },
    heights: [0, 0, 0, 0],
    waterDepths: [0, 0, 0, 0],
    groundWater: [0, 0, 0, 0],
    groundWaterPollution: [0, 0, 0, 0],
    windSpeed: [0, 0, 0, 0],
  },
  roadGraph: {
    nodes: [],
    edges: [
      {
        entity: { index: 20, version: 1 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 10, version: 1 },
        endNode: { index: 11, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: 30, z: 0 },
        length: 30,
      },
    ],
  },
  buildings: [],
  zoningCells: [
    {
      block: { index: 30, version: 1 },
      index: 0,
      position: { x: 20, y: 0, z: 0 },
      visible: true,
      roadside: true,
      occupied: false,
      blocked: false,
      overridden: false,
      zoneType: 0,
      zoneCategory: "none",
    },
  ],
};

/**
 * Minimal MCP tools double. It reproduces the real Bridge envelope shapes that
 * the production foundation reads; it never supplies project identity.
 */
function toolsFixture() {
  let session = SESSION_A;
  let generation = "generation-fresh";
  let bridgeRuntimeEpoch = "bridge-fresh";
  let checkpointId: string | null = null;
  let loadAssetGuid: string | null = null;
  let saveDataAssetGuid: string | null = null;
  let loadPurpose: "NewGame" | "LoadGame" = "NewGame";
  let generationSequence = 1;
  let saveRequests = 0;
  let failSpatialReadback = false;
  let changeGenerationOnNextGameState = false;
  let changeGenerationAfterSpatialScan = false;
  const receipts = new Map<string, unknown>();

  const worldId = () => `cs2-session:${session}`;
  const baselineCheckpointId = () => `save:${worldId()}:baseline`;

  const gameState = () => ({
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    simulation: { paused: true, frameIndex: 0 },
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: worldId(),
      nativeSessionGuid: session,
      loadPurpose,
      loadAssetGuid,
      saveDataAssetGuid,
      mapAssetGuid: "map-a",
      checkpointId,
      bridgeRuntimeEpoch,
      generation,
      generationSequence,
      generationOrigin: "LOAD_COMPLETED",
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
    },
  });

  return {
    get baselineCheckpointId() {
      return baselineCheckpointId();
    },
    get worldId() {
      return worldId();
    },
    failSpatialReadback() { failSpatialReadback = true; },
    changeGenerationOnNextGameState() { changeGenerationAfterSpatialScan = true; },
    /** Re-enter the certified baseline save in a new generation, as a reload does. */
    reloadCertifiedBaseline() {
      checkpointId = baselineCheckpointId();
      loadAssetGuid = "baseline-meta";
      saveDataAssetGuid = "baseline-data";
      generation = "generation-reloaded";
      bridgeRuntimeEpoch = "bridge-reloaded";
      generationSequence = 2;
      loadPurpose = "LoadGame";
    },
    /** Onboard an unrelated fresh world on the same manager. */
    onboardDifferentWorld() {
      session = SESSION_B;
      generation = "generation-b";
      bridgeRuntimeEpoch = "bridge-b";
      checkpointId = null;
      loadAssetGuid = null;
      saveDataAssetGuid = null;
      generationSequence = 1;
      loadPurpose = "NewGame";
    },
    manager: {
      legacyList: async () => ({
        tools: [
          "cs2_game_state",
          "cs2_save_status",
          "cs2_save_game",
          "cs2_spatial",
          "cs2_mayor_snapshot",
          "cs2_city_overview",
        ].map((name) => ({ name: `cs2--${name}` })),
      }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown;
        if (name === "cs2_game_state") {
          if (changeGenerationOnNextGameState) {
            changeGenerationOnNextGameState = false;
            generation = `${generation}-changed-during-readback`;
            bridgeRuntimeEpoch = `${bridgeRuntimeEpoch}-changed-during-readback`;
            generationSequence += 1;
          }
          payload = gameState();
        } else if (name === "cs2_save_game") {
          saveRequests += 1;
          const requestId = `save-request-${saveRequests}`;
          receipts.set(requestId, {
            status: "COMPLETED",
            durable: true,
            worldId: worldId(),
            worldGeneration: generation,
            checkpoint: {
              checkpointId: baselineCheckpointId(),
              saveMetadataAssetGuid: "baseline-meta",
              saveDataAssetGuid: "baseline-data",
              nativeSessionGuid: session,
            },
          });
          payload = { status: "SUBMITTED", saveRequestId: requestId };
        } else if (name === "cs2_save_status") {
          payload = (typeof args.requestId === "string" ? receipts.get(args.requestId) : undefined) ?? {
            state: "IDLE",
            status: "IDLE",
          };
        } else if (name === "cs2_spatial") {
          if (failSpatialReadback && args.mode === "scan") throw new Error("fixture readback failure");
          if (changeGenerationAfterSpatialScan && args.mode === "scan") {
            changeGenerationAfterSpatialScan = false;
            changeGenerationOnNextGameState = true;
          }
          payload = args.mode === "scan" ? scanPayload : siteDetail;
        } else if (name === "cs2_mayor_snapshot") {
          payload = { planningCatalog: { roadPrefabs: ["Small Road", "Medium Road"] } };
        } else {
          payload = { treasury: TREASURY };
        }
        return { structuredContent: payload };
      },
    },
  };
}

function productionPorts(fixture: ReturnType<typeof toolsFixture>) {
  return createV2FoundationPorts({
    getToolsManager: () => fixture.manager as never,
    durableStateStorage: createMemoryDurableStateStorage(),
    now: () => INSTANT,
    baselineSavePollMs: 1,
  });
}

const observationPort = (treasury = TREASURY): V2ProjectAdmissionObservationPort => ({
  scanWorld: async () => buildSpatialWorldModel(parseSpatialBootstrapScan(scanPayload)),
  captureSiteDetail: async () => ({ detail: siteDetail, coherence: "STABLE_FRAME", observationId: "observation:site" }),
  readAvailableRoadPrefabs: async () => ["Small Road", "Medium Road"],
  readTreasury: async () => treasury,
});

type FoundationPorts = ReturnType<typeof productionPorts>;

/** Assert the production composition actually exposes the admission seam. */
function activated(ports: FoundationPorts) {
  const { durability, activateDurableWorld, projectAdmission } = ports;
  if (!durability || !activateDurableWorld || !projectAdmission) {
    throw new Error("production foundation ports are incomplete");
  }
  return { durability, activateDurableWorld, projectAdmission };
}

/** The durable store's admitted Gate 1 state; the test fails if it is absent. */
function gate1State(ports: FoundationPorts): Gate1State {
  const state = activated(ports).durability.projectState();
  if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
    throw new Error(`expected an admitted Gate 1 state, received ${state.schemaVersion}`);
  }
  return state;
}

describe("production project admission bootstrap", () => {
  test("only standalone Road Goals bypass the later-Zoning frontage gate", () => {
    expect(isStandaloneRoadGoalAdmission({ goalId: "ESTABLISH_ROAD_NETWORK:facts:abc", completionStage: "ROAD_DELIVERED" })).toBe(true);
    expect(isStandaloneRoadGoalAdmission({ goalId: "ESTABLISH_ROAD_NETWORK:facts:abc", completionStage: "ROAD_DELIVERED",
      targetPoint: { x: 10, z: 20 } })).toBe(false);
    expect(isStandaloneRoadGoalAdmission({ goalId: "PROVIDE_SERVICE:water:prerequisite:1", completionStage: "ROAD_DELIVERED" })).toBe(false);
  });

  test("reads a Goal's own deliverable from its id, because admission does not always carry it", () => {
    // The second admission of a Goal usually names it by id alone: a bounded
    // prerequisite completes and the parent is resumed with
    // `ensureGoalWorkOrder(active.parentGoalId)`, creating the parent's record
    // for the first time. Without this the record is indistinguishable from a
    // residential Goal's and walks the growth ladder.
    expect(goalCompletionStageForGoalId("ESTABLISH_ROAD_NETWORK:facts:abc")).toBe("ROAD_DELIVERED");
    expect(goalCompletionStageForGoalId("UTILITY_SERVICE:sewage:city")).toBe("WAITING_FOR_OCCUPANCY");
    expect(goalCompletionStageForGoalId("UTILITY_SERVICE:sewage:city:site_scope:3")).toBe("WAITING_FOR_OCCUPANCY");
    expect(goalCompletionStageForGoalId("PROVIDE_SERVICE:sewage:facts:3617f3ae")).toBe("WAITING_FOR_OCCUPANCY");
    // A successor inherits its root's deliverable; a prerequisite states its own.
    expect(goalCompletionStageForGoalId("UTILITY_SERVICE:water:city:successor:abc123")).toBe("WAITING_FOR_OCCUPANCY");
    expect(goalCompletionStageForGoalId("PROVIDE_SERVICE:sewage:facts:x:prerequisite:ROAD_ACCESS:1:abcd")).toBeUndefined();
    // A growth Goal's deliverable is its delivered frontage plus its rezoned
    // land, both observed — NOT the building that may appear on that land and not
    // the residents who may later move in. Waiting for either put the game's own
    // growth cadence in charge of the Mayor's: `UTILITY_PROVISION` held the
    // tranche waiting for a building that only `ZONING` can produce, so the
    // tranche could neither advance nor close (measured live 2026-09-30).
    for (const landUse of ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "OFFICE"]) {
      expect(goalCompletionStageForGoalId(`EXPAND_${landUse}:${landUse.toLowerCase()}:facts:abc`))
        .toBe("ZONED_WAITING_FOR_BUILDING");
    }
    expect(goalCompletionStageForGoalId("EXPAND_RESIDENTIAL:residential:facts:abc:successor:def"))
      .toBe("ZONED_WAITING_FOR_BUILDING");
    // A prerequisite of a growth Goal states its own milestone and is untouched.
    expect(goalCompletionStageForGoalId("EXPAND_RESIDENTIAL:residential:facts:abc:prerequisite:ROAD_FRONTAGE:1:def"))
      .toBeUndefined();
  });

  test("anchors targetless standalone Road Goal admission to the shared grid origin", () => {
    const road = { entity: { index: 47132, version: 3 }, prefab: "Small Road",
      start: { x: -1247.54456, z: -10.4005432 }, end: { x: -1247.45, z: -45.6701 } } as SpatialRoadEdge;
    expect(goalWorkOrderRoadSearchTarget({ goalId: "ESTABLISH_ROAD_NETWORK:facts:next",
      completionStage: "ROAD_DELIVERED", roadEdges: [road] })).toEqual(road.start);
    expect(goalWorkOrderRoadSearchTarget({ goalId: "PROVIDE_SERVICE:electricity:facts:next",
      completionStage: "ROAD_DELIVERED", roadEdges: [road] })).toBeUndefined();
    expect(goalWorkOrderRoadSearchTarget({ goalId: "ESTABLISH_ROAD_NETWORK:facts:next",
      completionStage: "ROAD_DELIVERED", previousRoadTerminal: { x: -14.219123, z: 1297.46817 },
      roadEdges: [road] })).toEqual({ x: -14.219123, z: 1297.46817 });
    expect(goalWorkOrderRoadSearchTarget({ goalId: "ESTABLISH_ROAD_NETWORK:facts:next",
      completionStage: "ROAD_DELIVERED", targetPoint: { x: 1, z: 2 }, roadEdges: [road] })).toEqual({ x: 1, z: 2 });
    expect(exactRoadTerminalPoint(JSON.stringify({ actionFamily: "ROAD", prefab: "Small Road",
      x1: 0, z1: 0, x2: 10, z2: 20 }))).toEqual({ x: 10, z: 20 });
    expect(exactRoadTerminalPoint(JSON.stringify([{ type: "build_road", prefab: "Small Road",
      x1: 0, z1: 0, x2: -4, z2: 7 }]))).toEqual({ x: -4, z: 7 });
    expect(exactRoadTerminalPoint("malformed")).toBeUndefined();
    const command = (position: number, epoch: string, actionFamily: string, status: string, x2: number) => ({
      position, worldEpochId: epoch,
      record: { actionFamily, status, authorizedScope: { exactInput: JSON.stringify({ actionFamily: "ROAD",
        x1: 0, z1: 0, x2, z2: 1 }) } },
    });
    expect(latestObservedRoadTerminal([
      command(4, "epoch-a", "ROAD", "OBSERVED_MATCH", 4),
      command(8, "epoch-b", "ROAD", "OBSERVED_MATCH", 8),
      command(9, "epoch-a", "UTILITY", "OBSERVED_MATCH", 9),
      command(10, "epoch-a", "ROAD", "UNKNOWN_TRANSPORT", 10),
    ], "epoch-a")).toEqual({ x: 4, z: 1 });
  });

  test("turns an ACTIVATED world with a PLACEHOLDER project state into a persisted Gate 1 project", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld, projectAdmission } = activated(ports);

    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    await expect(activateDurableWorld()).resolves.toMatchObject({ status: "ACTIVATED_IN_PLACE" });
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });

    const result = await projectAdmission.ensureFirstProject();
    expect(result.status).toBe("ADMITTED");

    expect(gate1State(ports)).toMatchObject({
      intent: { id: `intent:gate1-starter:${fixture.worldId}:baseline:${fixture.baselineCheckpointId}:branch:${durability.executionBranchId()}` },
      project: { status: "ACTIVE" },
      tranche: { stage: "PLANNED" },
    });
  });

  test("creates an isolated execution branch for an explicit certified baseline LoadGame", async () => {
    const fixture = toolsFixture();
    const storage = createMemoryDurableStateStorage();
    const factory = () =>
      createV2FoundationPorts({
        getToolsManager: () => fixture.manager as never,
        durableStateStorage: storage,
        now: () => INSTANT,
        baselineSavePollMs: 1,
      });
    const first = factory();
    await activated(first).activateDurableWorld();
    expect((await activated(first).projectAdmission.ensureFirstProject()).status).toBe("ADMITTED");
    const original = gate1State(first);

    // A completed LoadGame is a new execution branch even when it loads the
    // certified baseline again. The old execution remains in its parent branch.
    fixture.reloadCertifiedBaseline();
    const restarted = factory();
    await expect(activated(restarted).activateDurableWorld()).resolves.toMatchObject({ status: "ACTIVATED" });
    expect(restarted.durability?.executionBranchId()).not.toBe(first.durability?.executionBranchId());
    expect(restarted.durability?.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    const readmitted = await activated(restarted).projectAdmission.ensureFirstProject();
    expect(readmitted.status).toBe("ADMITTED");
    const recovered = gate1State(restarted);
    expect(recovered.intent.id).not.toBe(original.intent.id);
    expect(recovered.project.id).not.toBe(original.project.id);
  });

  test("historical branch stays unroutable when current-world readback fails", async () => {
    const fixture = toolsFixture();
    const storage = createMemoryDurableStateStorage();
    const factory = () => createV2FoundationPorts({
      getToolsManager: () => fixture.manager as never, durableStateStorage: storage,
      now: () => INSTANT, baselineSavePollMs: 1,
    });
    const first = factory();
    await activated(first).activateDurableWorld();
    await activated(first).projectAdmission.ensureFirstProject();
    fixture.reloadCertifiedBaseline();
    fixture.failSpatialReadback();

    const restarted = factory();
    await expect(activated(restarted).activateDurableWorld()).rejects.toThrow("fixture readback failure");
    const pending = restarted.durability!.activate((await fixture.manager.legacyCall({
      name: "cs2_game_state", arguments: {},
    })).structuredContent);
    expect(pending.status).toBe("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    expect(restarted.durability!.isExecutionDurablyActivated(pending)).toBe(false);
    expect(restarted.durability!.snapshot().commands).toEqual([]);
    await expect(restarted.projectAdmission!.ensureFirstProject()).rejects.toThrow("fixture readback failure");
  });

  test("historical branch stays unroutable when generation changes during readback", async () => {
    const fixture = toolsFixture();
    const storage = createMemoryDurableStateStorage();
    const factory = () => createV2FoundationPorts({
      getToolsManager: () => fixture.manager as never, durableStateStorage: storage,
      now: () => INSTANT, baselineSavePollMs: 1,
    });
    const first = factory();
    await activated(first).activateDurableWorld();
    await activated(first).projectAdmission.ensureFirstProject();
    fixture.reloadCertifiedBaseline();
    fixture.changeGenerationOnNextGameState();

    const restarted = factory();
    await expect(activated(restarted).activateDurableWorld()).rejects.toThrow("HISTORICAL_BRANCH_WORLD_CHANGED_DURING_READBACK");
    const pending = restarted.durability!.activate((await fixture.manager.legacyCall({
      name: "cs2_game_state", arguments: {},
    })).structuredContent);
    expect(pending.status).toBe("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    expect(restarted.durability!.isExecutionDurablyActivated(pending)).toBe(false);
    expect(restarted.durability!.snapshot().commands).toEqual([]);
  });

  test("rejects a duplicate bootstrap once a Gate 1 project is durable", async () => {
    const ports = productionPorts(toolsFixture());
    const { activateDurableWorld, projectAdmission } = activated(ports);
    await activateDurableWorld();
    await projectAdmission.ensureFirstProject();

    await expect(projectAdmission.admitFirstProject()).rejects.toThrow("PROJECT_ADMISSION_ALREADY_EXISTS");
    // The idempotent production entry returns the admitted project unchanged
    // and performs no further native read.
    await expect(projectAdmission.ensureFirstProject()).resolves.toMatchObject({ status: "ALREADY_ADMITTED" });
  });

  test("refuses a goal work order when no distinct admitted reservation exists", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld, projectAdmission } = activated(ports);
    await activateDurableWorld();
    await projectAdmission.ensureFirstProject();
    const first = gate1State(ports);

    await expect(projectAdmission.ensureGoalWorkOrder({ goalId: "UTILITY_SERVICE:water:site-a" }))
      .rejects.toThrow("PROJECT_ADMISSION_NO_ELIGIBLE_SITE");
    expect(gate1State(ports).project.id).toBe(first.project.id);
    expect(durability.snapshot().goalWorkOrders).toEqual([]);
  });

  test("decomposes a failed domain admission into a target-directed durable Road prerequisite", async () => {
    const prerequisite = { kind: "ROAD_ACCESS" as const, targetPoint: { x: 80, z: 90 },
      completionStage: "ROAD_DELIVERED" as const, evidence: "clean source is outside current road reach" };
    const constraint: V2ProjectSiteConstraint = {
      kind: "test-domain-site",
      accepts: async () => false,
      derivePrerequisite: async () => prerequisite,
    };
    const { bootstrap, durability } = await admitWithConstraint();
    const result = await bootstrap.ensureGoalWorkOrder({ goalId: "PROVIDE_SERVICE:water:scope-1", siteConstraint: constraint });
    expect(result).toMatchObject({ status: "PREREQUISITE_ADMITTED", requestedGoalId: "PROVIDE_SERVICE:water:scope-1",
      activeGoalId: expect.stringContaining(":prerequisite:ROAD_ACCESS:1:"), prerequisite });
    const active = bootstrap.activeGoalWorkOrder();
    expect(active).toMatchObject({ parentGoalId: "PROVIDE_SERVICE:water:scope-1", targetPoint: prerequisite.targetPoint,
      completionStage: "ROAD_DELIVERED", status: "ACTIVE" });
    expect(active?.state.tranche.stage).toBe("PLANNED");
    expect(durability.snapshot().activeGoalWorkOrderId).toBe(active?.workOrderId);
  });

  test("historical LoadGame does not reuse the current-branch project revision", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld, projectAdmission } = activated(ports);
    await activateDurableWorld();
    await projectAdmission.ensureFirstProject();
    fixture.reloadCertifiedBaseline();
    const oldState = gate1State(ports);
    await expect(activateDurableWorld()).resolves.toMatchObject({ status: "ACTIVATED" });
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(durability.executionBranchId()).not.toBeNull();
    await expect(projectAdmission.ensureFirstProject()).resolves.toMatchObject({ status: "ADMITTED" });
    expect(gate1State(ports).intent.id).not.toBe(oldState.intent.id);
  });

  test("current-branch replan identity is deterministic and checkpoint-cut bound", () => {
    const branch = { worldId: "world-a", checkpointId: "save-a", journalCut: 4 };
    const first = deriveCurrentBranchProjectReplanIdentity(branch);
    expect(deriveCurrentBranchProjectReplanIdentity(branch)).toEqual(first);
    expect(deriveCurrentBranchProjectReplanIdentity({ ...branch, journalCut: 5 })).not.toEqual(first);
    expect(deriveCurrentBranchProjectReplanIdentity({ ...branch, checkpointId: "save-b" })).not.toEqual(first);
  });

  test("does not inherit a previous project when an unrelated world is onboarded", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld, projectAdmission } = activated(ports);
    await activateDurableWorld();
    await projectAdmission.ensureFirstProject();
    const previous = gate1State(ports);

    fixture.onboardDifferentWorld();
    await expect(activateDurableWorld()).resolves.toMatchObject({ status: "ACTIVATED_IN_PLACE" });
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });

    expect((await projectAdmission.ensureFirstProject()).status).toBe("ADMITTED");
    const current = gate1State(ports);
    expect(current.intent.id).toBe(`intent:gate1-starter:${fixture.worldId}:baseline:${fixture.baselineCheckpointId}:branch:${durability.executionBranchId()}`);
    expect(current.intent.id).toContain(SESSION_B);
    expect(current.project.id).not.toBe(previous.project.id);
    expect(current.tranche.id).not.toBe(previous.tranche.id);
    expect(current.tranche.reservationRef).not.toBe(previous.tranche.reservationRef);
    for (const inherited of [previous.project.id, previous.tranche.id, previous.tranche.reservationRef]) {
      expect(current.intent.id).not.toContain(inherited);
      expect(current.project.id).not.toContain(inherited);
      expect(current.tranche.id).not.toContain(inherited);
    }
  });

  test("derives project, tranche and reservation from the existing deterministic Gate 1 planner", async () => {
    const ports = productionPorts(toolsFixture());
    const { activateDurableWorld, projectAdmission } = activated(ports);
    await activateDurableWorld();
    const result = await projectAdmission.admitFirstProject();
    expect(result.status).toBe("ADMITTED");
    if (result.status !== "ADMITTED") return;

    const { state, evidence } = result;
    // Exactly the lineage the planner derives from the admitted intent id.
    expect(state.project.id).toBe(`${state.intent.id}:project:starter-residential`);
    expect(state.district.id).toBe(`${state.project.id}:district:1`);
    expect(state.tranche.id).toBe(`${state.district.id}:tranche:1`);
    expect(state.tranche.reservationRef).toBe(`${state.tranche.id}:reservation`);
    expect(evidence).toMatchObject({
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      intentId: state.intent.id,
    });
    expect(evidence.eligibleCandidates).toBeGreaterThan(0);
    expect(evidence.siteObservationIds.length).toBeGreaterThan(0);

    // The durable store holds that same state, not a copy from elsewhere.
    expect(gate1State(ports).project.id).toBe(state.project.id);
    expect(gate1State(ports).tranche.reservationRef).toBe(state.tranche.reservationRef);
  });

  test("bounds the starter project budget by observed treasury and explicit policy", async () => {
    expect(deriveStarterProjectBudget({ treasury: 400_000, policy: V2_PROJECT_ADMISSION_POLICY })).toEqual({
      maximumBudget: V2_PROJECT_ADMISSION_POLICY.absoluteBudgetCeiling,
      treasuryShareLimit: 100_000,
      budgetBound: "POLICY_CEILING",
    });
    expect(deriveStarterProjectBudget({ treasury: 40_000, policy: V2_PROJECT_ADMISSION_POLICY })).toEqual({
      maximumBudget: 10_000,
      treasuryShareLimit: 10_000,
      budgetBound: "TREASURY_SHARE",
    });
    expect(() => deriveStarterProjectBudget({ treasury: 5_000, policy: V2_PROJECT_ADMISSION_POLICY })).toThrow(
      "PROJECT_ADMISSION_BUDGET_BELOW_POLICY_MINIMUM",
    );
    expect(() => deriveStarterProjectBudget({ treasury: Number.NaN, policy: V2_PROJECT_ADMISSION_POLICY })).toThrow(
      "PROJECT_ADMISSION_TREASURY_UNKNOWN",
    );

    const ports = productionPorts(toolsFixture());
    const { activateDurableWorld, projectAdmission } = activated(ports);
    await activateDurableWorld();
    const result = await projectAdmission.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error("expected admission");
    expect(result.evidence.observedTreasury).toBe(TREASURY);
    expect(result.evidence.maximumBudget).toBeLessThan(TREASURY);
    expect(result.state.project.maximumBudget).toBe(result.evidence.maximumBudget);
    expect(result.state.intent.maximumBudget).toBe(result.evidence.maximumBudget);
  });

  test("refuses admission while the world is not durably activated", async () => {
    const ports = productionPorts(toolsFixture());
    const { durability, activateDurableWorld } = activated(ports);
    const world = (await activateDurableWorld()).world;
    const blocked = createV2ProjectAdmissionBootstrap({
      durability,
      activateDurableWorld: async () => ({
        kind: "FIRST_OBSERVATION",
        world,
        blockedReason: "stale checkpoint V2 state version",
        status: "ACTIVATED" as const,
      }),
      observation: observationPort(),
      now: () => INSTANT,
    });
    await expect(blocked.admitFirstProject()).rejects.toThrow("stale checkpoint V2 state version");

    // A world that never certified its baseline cannot be admitted into.
    const uncertified = createV2ProjectAdmissionBootstrap({
      durability,
      activateDurableWorld: async () => ({
        kind: "FIRST_OBSERVATION",
        world,
        blockedReason: null,
        status: "BASELINE_CHECKPOINT_REQUIRED",
      }),
      observation: observationPort(),
      now: () => INSTANT,
    });
    await expect(uncertified.admitFirstProject()).rejects.toThrow(
      "BASELINE_CHECKPOINT_REQUIRED: project admission requires a durably activated world",
    );
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("derives intent identity from durable lineage only", () => {
    expect(deriveStarterProjectIntentId({ worldId: "cs2-session:a", baselineCheckpointId: "save:b" })).toBe(
      "intent:gate1-starter:cs2-session:a:baseline:save:b",
    );
    expect(() => deriveStarterProjectIntentId({ worldId: "", baselineCheckpointId: "save:b" })).toThrow(
      "PROJECT_ADMISSION_WORLD_IDENTITY_MISSING",
    );
    expect(() => deriveStarterProjectIntentId({ worldId: "cs2-session:a", baselineCheckpointId: " " })).toThrow(
      "PROJECT_ADMISSION_BASELINE_IDENTITY_MISSING",
    );
  });
});

// ---------------------------------------------------------------------------
// K05 stage contract
// ---------------------------------------------------------------------------

const intentInput = {
  intentId: "intent:stage-contract",
  targetResidents: 12,
  maximumBudget: 25_000,
  planningEnvelope: { center: { x: 10, z: 20 }, radius: 128 },
  siteCandidates: [{ id: "site-1", target: { center: { x: 10, z: 20 }, radius: 64 }, score: 1, blocked: false }],
};

const worldIdentity = {
  worldId: "cs2-session:stage",
  nativeSessionGuid: "stage",
  loadPurpose: "LoadGame" as const,
  loadAssetGuid: null,
  saveDataAssetGuid: null,
  mapAssetGuid: null,
  checkpointId: "save:stage",
  bridgeRuntimeEpoch: "bridge:stage",
  generation: "generation:stage",
  generationSequence: 1,
  generationOrigin: "ATTACHED_EXISTING_WORLD" as const,
  worldEpochId: "epoch:stage",
  worldReady: true as const,
};

/**
 * Drive the guard under test by placing a planner-produced state at the given
 * lifecycle stage. Nothing here is a substitute for the lifecycle: the test
 * below proves the real state machine only ever reaches utility execution at
 * ROAD_DELIVERED.
 */
function stateAtStage(stage: Gate1Stage): Gate1State {
  const state = planStarterResidentialIntent(intentInput, INSTANT);
  state.tranche.stage = stage;
  return state;
}

const utilityScope = (state: Gate1State): GreenfieldUtilityExecutionScope => ({
  intentId: state.intent.id,
  projectId: state.project.id,
  trancheId: state.tranche.id,
  reservationRef: state.tranche.reservationRef,
  worldId: worldIdentity.worldId,
  worldEpochId: worldIdentity.worldEpochId,
  generation: worldIdentity.generation,
  topologyRevision: `${worldIdentity.generation}:production`,
  certifiedRoadRefs: [{ index: 1, version: 1 }],
  targetServiceEntry: { road: { index: 1, version: 1 }, position: { x: 10, z: 20 } },
  spatialEnvelope: state.project.utilityReservation,
  maximumSpend: 1_000,
  treasury: 5_000,
  treasurySafetyReserve: 0,
});

const zoningObservation = (state: Gate1State): Gate1Observation => ({
  observationId: "observation:zoning",
  runtimeEpoch: "runtime:zoning",
  coherence: "STABLE_FRAME",
  capturedAt: INSTANT.toISOString(),
  trancheId: state.tranche.id,
  access: { value: "PASS", provenance: "OBSERVED" },
  productiveFrontage: { value: "PASS", provenance: "OBSERVED" },
  utilities: { value: "PASS", provenance: "OBSERVED", evidenceKind: "PRE_ZONING_SERVICEABILITY", buildingRefs: [] },
  residentialBuildings: { value: [], provenance: "OBSERVED" },
  actualResidents: { value: 0, provenance: "OBSERVED" },
  occupiedResidentialBuildings: { value: [], provenance: "OBSERVED" },
});

const boundaryStub: Gate1WorldBoundary = {
  execute: async (proposal) => ({
    status: "DELIVERED",
    commandId: `command:${proposal.id}`,
    observedMatch: proposal.actionFamily === "ZONING",
    reason: "test boundary completed",
  }),
};

function certify(utilities: DurableGreenfieldUtilityState, certified: boolean): DurableGreenfieldUtilityState {
  const clone = structuredClone(utilities);
  for (const value of Object.values(clone.utilities)) {
    value.stage = certified ? "SERVICE_CERTIFIED" : "CONNECTED";
    value.serviceEvidence = {
      status: "AVAILABLE",
      revision: `${worldIdentity.generation}:10`,
      capacity: 100,
      consumption: 10,
      fulfilledConsumption: 10,
      issueActive: false,
      supplyExists: true,
      networkConnected: true,
      cityCapacityAvailable: true,
      targetNetworkReachable: true,
      facility: null,
      connector: null,
      targetRoad: { index: 1, version: 1 },
      evidenceGeneration: worldIdentity.generation,
      topologyRevision: `${worldIdentity.generation}:production`,
    };
  }
  return clone;
}

describe("K05 admission stage contract", () => {
  test("admits supply-side utility execution at the stage Gate 1 requires it", () => {
    const state = stateAtStage("ROAD_DELIVERED");
    expect(buildUtilityPreparationInput({ state, world: worldIdentity, treasury: 20_000 })).toMatchObject({
      kind: "electricity",
      intentId: state.intent.id,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      worldId: worldIdentity.worldId,
      worldEpochId: worldIdentity.worldEpochId,
      generation: worldIdentity.generation,
      topologyRevision: `${worldIdentity.generation}:production`,
      spatialEnvelope: state.project.utilityReservation,
      maximumSpend: 20_000,
      treasury: 20_000,
    });
  });

  test.each([
    ["PLANNED"],
    ["SITE_SELECTED"],
    ["ZONED_WAITING_FOR_BUILDING"],
    ["BUILDING_OBSERVED"],
    ["WAITING_FOR_OCCUPANCY"],
    ["OCCUPIED"],
  ] as const)("rejects K05 admission at %s", (stage) => {
    const state = stateAtStage(stage);
    expect(() => buildUtilityPreparationInput({ state, world: worldIdentity, treasury: 20_000 })).toThrow(
      "UTILITY_ADMISSION_STAGE_NOT_ROAD_DELIVERED",
    );
  });

  test("caps K05 spend by the admitted project budget, never by the whole treasury", () => {
    const state = stateAtStage("ROAD_DELIVERED");
    const prepared = buildUtilityPreparationInput({ state, world: worldIdentity, treasury: 900_000 });
    expect(prepared.maximumSpend).toBe(state.project.maximumBudget);
    expect(prepared.maximumSpend).toBeLessThan(900_000);
  });

  test("the state machine records utility execution at ROAD_DELIVERED and nowhere else", () => {
    const later = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(stateAtStage("BUILDING_OBSERVED")),
      boundary: boundaryStub,
      now: () => INSTANT,
    });
    expect(() =>
      later.recordUtilityExecution(createDurableGreenfieldUtilityState(utilityScope(later.snapshot()))),
    ).toThrow("utility execution evidence is outside the current Gate1 scope");

    const inPlace = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(stateAtStage("ROAD_DELIVERED")),
      boundary: boundaryStub,
      now: () => INSTANT,
    });
    const recorded = inPlace.recordUtilityExecution(
      createDurableGreenfieldUtilityState(utilityScope(inPlace.snapshot())),
    );
    expect(recorded.tranche.utilityExecution).not.toBeNull();
    // No manual stage edit: the real lifecycle state feeds K05 directly.
    expect(buildUtilityPreparationInput({ state: recorded, world: worldIdentity, treasury: 20_000 })).toMatchObject({
      projectId: recorded.project.id,
      trancheId: recorded.tranche.id,
    });
  });

  test("a utility that is not SERVICE_CERTIFIED does not hard-block ZONING", async () => {
    const state = stateAtStage("ROAD_DELIVERED");
    const uncertified = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: boundaryStub,
      now: () => INSTANT,
    });
    uncertified.recordUtilityExecution(certify(createDurableGreenfieldUtilityState(utilityScope(state)), false));
    const uncertifiedAdmission = await uncertified.tick(zoningObservation(uncertified.snapshot()));
    expect(uncertifiedAdmission.proposal?.operation).toBe("ZONE_RESIDENTIAL");
    expect(uncertifiedAdmission.state.tranche.stage).toBe("ZONED_WAITING_FOR_BUILDING");

    const certified = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(stateAtStage("ROAD_DELIVERED")),
      boundary: boundaryStub,
      now: () => INSTANT,
    });
    const certifiedState = certified.snapshot();
    certified.recordUtilityExecution(certify(createDurableGreenfieldUtilityState(utilityScope(certifiedState)), true));
    const admitted = await certified.tick(zoningObservation(certified.snapshot()));
    expect(admitted.proposal?.operation).toBe("ZONE_RESIDENTIAL");
    expect(admitted.state.tranche.stage).toBe("ZONED_WAITING_FOR_BUILDING");
  });
});

// ---------------------------------------------------------------------------
// Utility-aware bounded admission envelope
// ---------------------------------------------------------------------------

/**
 * A domain constraint that is satisfied only from `minimumRadius` outward.
 *
 * Radius-gated on purpose: that is the shape of a real one. A utility that
 * needs a source the world placed 226 m away is exactly a step function of the
 * reservation, and admission has to find the step rather than be told it.
 */
function radiusGatedConstraint(minimumRadius: number): { asked: number[]; constraint: V2ProjectSiteConstraint } {
  const asked: number[] = [];
  return {
    asked,
    constraint: {
      kind: `test-radius-gated-at-${minimumRadius}`,
      async accepts(_candidate: Gate1BoundedSiteCandidate, reservationRadius: number) {
        asked.push(reservationRadius);
        return reservationRadius >= minimumRadius;
      },
    },
  };
}

/** Admit against the production foundation with one domain constraint attached. */
/**
 * The exact durable shape a ZONING step leaves behind when the tranche's own
 * reservation carries no cell it may zone: a terminal task with a recorded
 * outcome, and the project and intent closed with it. Nothing was submitted, so
 * there is no command and nothing to reconcile.
 */
function blockedZoningState(state: Gate1State): Gate1State {
  const zoning = state.tasks.find((task) => task.kind === "ZONING");
  if (!zoning) throw new Error("expected a ZONING task");
  const outcomeId = `${zoning.id}:outcome:1`;
  zoning.status = "BLOCKED";
  zoning.attempts = 1;
  zoning.terminalOutcomeId = outcomeId;
  state.journal.push({
    id: outcomeId, taskId: zoning.id, skill: "Zoning", proposalId: null,
    recordedAt: INSTANT.toISOString(), admission: "ADMITTED", execution: "NOT_REQUIRED",
    commandId: null, observationId: null, observedEffect: "NOT_APPLICABLE",
    failureClassification: "ZONING_RESERVATION_DEAD_END",
    reason: "GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
  });
  state.project.status = "BLOCKED";
  state.intent.status = "BLOCKED";
  return state;
}

/**
 * The exact durable shape a Road-only scope leaves behind when its Road step
 * ends without delivering: a terminal `ROAD_CONNECTION` with a recorded outcome
 * and no command, and the project and intent closed with it.
 *
 * A scope whose deliverable is the delivered road has no ZONING task to block —
 * its ladder is `SITE_SELECTION -> ROAD_CONNECTION` and nothing else — so a Road
 * failure is recorded on the Road task.
 */
function blockedRoadState(state: Gate1State): Gate1State {
  const road = state.tasks.find((task) => task.kind === "ROAD_CONNECTION");
  if (!road) throw new Error("expected a ROAD_CONNECTION task");
  const outcomeId = `${road.id}:outcome:1`;
  road.status = "BLOCKED";
  road.attempts = 1;
  road.terminalOutcomeId = outcomeId;
  state.journal.push({
    id: outcomeId, taskId: road.id, skill: "RoadConnection", proposalId: null,
    recordedAt: INSTANT.toISOString(), admission: "ADMITTED", execution: "NOT_REQUIRED",
    commandId: null, observationId: null, observedEffect: "NOT_APPLICABLE",
    failureClassification: "ROAD_PREFLIGHT_REJECTED",
    reason: "GATE1_PROGRESSION_NO_BOUNDED_ROAD_CANDIDATE",
  });
  state.project.status = "BLOCKED";
  state.intent.status = "BLOCKED";
  return state;
}

async function admitWithConstraint(siteConstraint?: V2ProjectSiteConstraint, treasury = TREASURY) {
  const fixture = toolsFixture();
  const ports = productionPorts(fixture);
  const { durability, activateDurableWorld } = activated(ports);
  await activateDurableWorld();
  const bootstrap = createV2ProjectAdmissionBootstrap({
    durability,
    activateDurableWorld,
    observation: observationPort(treasury),
    ...(siteConstraint ? { siteConstraint } : {}),
    now: () => INSTANT,
  });
  return { fixture, ports, durability, bootstrap };
}

describe("utility-aware bounded admission envelope", () => {
  const BASE = V2_PROJECT_ADMISSION_POLICY.planningEnvelopeRadiusMeters;
  const CEILING = V2_PROJECT_ADMISSION_POLICY.maximumPlanningEnvelopeRadiusMeters;

  test("reserves the smallest radius that satisfies the domain constraint, not the base", async () => {
    // Nothing at 180, 200 or 220; 240 is the first radius that works.
    const { constraint, asked } = radiusGatedConstraint(240);
    const { bootstrap, durability } = await admitWithConstraint(constraint);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error(`expected admission, received ${result.status}`);

    expect(result.evidence.reservationRadiusMeters).toBe(240);
    // The radius is the durable reservation's, not just the evidence's.
    const persisted = durability.projectState();
    if (persisted.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a durable Gate 1 state");
    expect(persisted.project.utilityReservation.radius).toBe(240);
    expect(persisted.project.utilityReservation.center).toEqual(result.state.project.utilityReservation.center);

    // The search is ascending and bounded, and it stopped at the first rung that
    // worked rather than running to the ceiling.
    expect(result.evidence.reservationRadiusLadder).toEqual([180, 200, 220, 240, 260, 280, 300, 320, 340, 360]);
    expect(asked).toContain(180);
    expect(asked).toContain(240);
    expect(asked).not.toContain(260);
  });

  test("reserves the minimum, not merely a feasible radius", async () => {
    // Same shape one rung lower: 220 is the first that works, so 220 is reserved.
    const { constraint } = radiusGatedConstraint(220);
    const { bootstrap } = await admitWithConstraint(constraint);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error("expected admission");
    expect(result.evidence.reservationRadiusMeters).toBe(220);
  });

  test("leaves the base radius untouched when the constraint is satisfied there", async () => {
    const { constraint, asked } = radiusGatedConstraint(BASE);
    const { bootstrap, durability } = await admitWithConstraint(constraint);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error("expected admission");

    expect(result.evidence.reservationRadiusMeters).toBe(BASE);
    expect(durability.projectState()).toMatchObject({ project: { utilityReservation: { radius: BASE } } });
    // The ladder was offered, but no rung above the base was ever needed.
    expect(asked.every((radius) => radius === BASE)).toBe(true);
  });

  test("fails closed when no bounded radius can satisfy the constraint", async () => {
    // The ceiling itself is not enough. Enlarging further is not an option: a
    // reservation is a claim on the world, and the product does not make an
    // unbounded one to chase a resource.
    const { constraint, asked } = radiusGatedConstraint(CEILING + 1);
    const { bootstrap, durability } = await admitWithConstraint(constraint);

    await expect(bootstrap.admitFirstProject()).rejects.toThrow("PROJECT_ADMISSION_NO_VALID_SITE");
    // Every rung up to and including the ceiling was tried, and no further.
    expect(asked).toContain(BASE);
    expect(asked).toContain(CEILING);
    expect(Math.max(...asked)).toBe(CEILING);
    // Nothing was persisted: a refused admission is not a project.
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("keeps the electricity admission result unchanged when no constraint is supplied", async () => {
    const { bootstrap, durability } = await admitWithConstraint();
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error("expected admission");

    expect(result.evidence.reservationRadiusMeters).toBe(BASE);
    // No constraint means no search at all — not a search that happens to stop
    // at the base rung.
    expect(result.evidence.reservationRadiusLadder).toEqual([]);
    expect(durability.projectState()).toMatchObject({ project: { utilityReservation: { radius: BASE } } });
  });

  test("the ladder is bounded by policy and reaches its ceiling", () => {
    expect(planningEnvelopeRadiusLadder(V2_PROJECT_ADMISSION_POLICY)).toEqual([
      180, 200, 220, 240, 260, 280, 300, 320, 340, 360,
    ]);
    // A step that does not land on the ceiling still ends there, so the whole
    // bound is reachable rather than merely approached.
    expect(
      planningEnvelopeRadiusLadder({
        ...V2_PROJECT_ADMISSION_POLICY,
        planningEnvelopeRadiusMeters: 100,
        maximumPlanningEnvelopeRadiusMeters: 250,
        planningEnvelopeRadiusStepMeters: 40,
      }),
    ).toEqual([100, 140, 180, 220, 250]);
    expect(() =>
      planningEnvelopeRadiusLadder({
        ...V2_PROJECT_ADMISSION_POLICY,
        planningEnvelopeRadiusStepMeters: 0,
      }),
    ).toThrow("PROJECT_ADMISSION_ENVELOPE_STEP_INVALID");
  });

  test("a persisted reservation cannot be expanded by later utility execution", () => {    const state = stateAtStage("ROAD_DELIVERED");
    state.project.utilityReservation = { center: { x: 10, z: 20 }, radius: 240 };
    const slice = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: boundaryStub,
      now: () => INSTANT,
    });

    const widened = utilityScope(state);
    widened.spatialEnvelope = { center: { x: 10, z: 20 }, radius: 360 };
    expect(() => slice.recordUtilityExecution(createDurableGreenfieldUtilityState(widened))).toThrow(
      "utility execution evidence is outside the current Gate1 scope",
    );

    const exact = utilityScope(state);
    exact.spatialEnvelope = { center: { x: 10, z: 20 }, radius: 240 };
    expect(() => slice.recordUtilityExecution(createDurableGreenfieldUtilityState(exact))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Supersession and replacement
// ---------------------------------------------------------------------------

const SUPERSESSION_REASON = "ADMISSION_INVALIDATED_BY_FIXED_SITE_CONSTRAINT" as const;

describe("superseded project replacement", () => {
  test("records the invalid admission without rewriting the project it supersedes", async () => {
    // The superseded project's admission was made with the unsound constraint,
    // so its reservation cannot reach the source its domain needs. It is real
    // history: it holds a durable reservation and a delivered ROAD.
    const { bootstrap, durability } = await admitWithConstraint();
    const first = await bootstrap.admitFirstProject();
    if (first.status !== "ADMITTED") throw new Error("expected admission");
    const superseded = first.state;
    const journalBefore = durability.commandJournal.list();

    const { constraint } = radiusGatedConstraint(240);
    const replacing = createV2ProjectAdmissionBootstrap({
      durability,
      activateDurableWorld: async (signal) => activated(productionPorts(toolsFixture())).activateDurableWorld(signal),
      observation: observationPort(),
      siteConstraint: constraint,
      now: () => INSTANT,
    });
    const replacement = await replacing.supersedeAndReplaceFirstProject({
      reason: SUPERSESSION_REASON,
      detail: "test: the 180m reservation cannot reach the only water source in the region",
    });

    // --- The superseded project is preserved, not repaired -------------------
    expect(replacement.supersession.projectId).toBe(superseded.project.id);
    expect(replacement.supersession.intentId).toBe(superseded.intent.id);
    expect(replacement.supersession.trancheId).toBe(superseded.tranche.id);
    expect(replacement.supersession.reservationRef).toBe(superseded.tranche.reservationRef);
    expect(replacement.supersession.reason).toBe(SUPERSESSION_REASON);
    // Verbatim, including the reservation that made it invalid.
    expect(replacement.supersession.supersededState).toEqual(superseded);
    expect(replacement.supersession.supersededState.project.utilityReservation.radius).toBe(
      V2_PROJECT_ADMISSION_POLICY.planningEnvelopeRadiusMeters,
    );
    expect(replacement.supersession.supersededState.tranche.stage).toBe(superseded.tranche.stage);

    // The durable journal is not the place a supersession is recorded: it holds
    // world effects, and the superseded project's effects are untouched.
    expect(durability.commandJournal.list()).toEqual(journalBefore);
    expect(durability.supersededProjects()).toHaveLength(1);

    // --- The replacement is a new identity, not a re-minted one --------------
    expect(replacement.state.project.id).not.toBe(superseded.project.id);
    expect(replacement.state.intent.id).not.toBe(superseded.intent.id);
    expect(replacement.state.intent.id).toBe(
      `${superseded.intent.id}:superseded:${SUPERSESSION_REASON}:replacement`,
    );
    expect(replacement.supersession.replacementProjectId).toBe(replacement.state.project.id);
    expect(replacement.state.project.utilityReservation.radius).toBe(240);

    // The durable slot now holds the replacement; the superseded one is the
    // history record, which is the only place it needed to be.
    const durable = durability.projectState();
    if (durable.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a durable Gate 1 state");
    expect(durable.project.id).toBe(replacement.state.project.id);
  });

  test("buys exactly one replacement per supersession", async () => {
    const { bootstrap, durability } = await admitWithConstraint();
    await bootstrap.admitFirstProject();
    const replacing = createV2ProjectAdmissionBootstrap({
      durability,
      activateDurableWorld: async (signal) => activated(productionPorts(toolsFixture())).activateDurableWorld(signal),
      observation: observationPort(),
      siteConstraint: radiusGatedConstraint(240).constraint,
      now: () => INSTANT,
    });

    const first = await replacing.supersedeAndReplaceFirstProject({ reason: SUPERSESSION_REASON, detail: "first" });
    expect(first.status).toBe("REPLACED");

    // Superseding the project that replaced the first one would make the chain
    // unbounded: supersede, replace, supersede the replacement, forever. That is
    // identity re-minting by another name, so the lineage is at most two deep.
    await expect(
      replacing.supersedeAndReplaceFirstProject({ reason: SUPERSESSION_REASON, detail: "second" }),
    ).rejects.toThrow("a replacement project cannot itself be superseded");
    expect(durability.supersededProjects()).toHaveLength(1);
  });

  test("refuses to supersede the same project twice", async () => {
    const { bootstrap, durability } = await admitWithConstraint();
    await bootstrap.admitFirstProject();
    const projectId = durability.supersededProjects();
    expect(projectId).toHaveLength(0);

    // Two supersessions of one project, driven directly: the durable refusal is
    // what bounds replacement, not the caller's restraint.
    const state = durability.projectState();
    if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a Gate 1 state");
    const record = {
      supersessionId: `${state.project.id}:superseded`,
      projectId: state.project.id,
      intentId: state.intent.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      supersededState: state,
      reason: SUPERSESSION_REASON,
      detail: "direct",
    } as const;
    durability.recordProjectSupersession(record);
    expect(() => durability.recordProjectSupersession({ ...record, supersessionId: "another" })).toThrow(
      "project is already superseded",
    );
    // And the same project cannot be reached through a second supersession id
    // either, so there is no way to buy a second replacement.
    expect(durability.supersededProjects()).toHaveLength(1);
  });

  test("refuses a replacement when no project is durable to supersede", async () => {
    const { bootstrap } = await admitWithConstraint();
    await expect(
      bootstrap.supersedeAndReplaceFirstProject({ reason: SUPERSESSION_REASON, detail: "d" }),
    ).rejects.toThrow("PROJECT_REPLACEMENT_NO_SUPERSEDABLE_PROJECT");
  });

  test("derives the replacement identity from the superseded one, not from a counter", () => {
    expect(
      deriveReplacementStarterProjectIntentId({
        supersededIntentId: "intent:gate1-starter:cs2-session:a:baseline:save:b",
        reason: SUPERSESSION_REASON,
      }),
    ).toBe(`intent:gate1-starter:cs2-session:a:baseline:save:b:superseded:${SUPERSESSION_REASON}:replacement`);
    // Same inputs, same identity: it survives a reload as the first project's does.
    expect(
      deriveReplacementStarterProjectIntentId({
        supersededIntentId: "intent:gate1-starter:cs2-session:a:baseline:save:b",
        reason: SUPERSESSION_REASON,
      }),
    ).toBe(
      deriveReplacementStarterProjectIntentId({
        supersededIntentId: "intent:gate1-starter:cs2-session:a:baseline:save:b",
        reason: SUPERSESSION_REASON,
      }),
    );
    expect(() => deriveReplacementStarterProjectIntentId({ supersededIntentId: "", reason: SUPERSESSION_REASON })).toThrow(
      "PROJECT_REPLACEMENT_SUPERSEDED_INTENT_MISSING",
    );
    expect(() => deriveReplacementStarterProjectIntentId({ supersededIntentId: "intent:x", reason: " " })).toThrow(
      "PROJECT_REPLACEMENT_REASON_MISSING",
    );
  });
});

// ---------------------------------------------------------------------------
// Utility-aware bounded admission budget
// ---------------------------------------------------------------------------

/**
 * A domain constraint that both accepts and declares what its plan costs.
 *
 * The two halves are separate on purpose: a site that can host a source is not
 * the same fact as a project that can afford one, and admission has to act on
 * the second before it persists the first.
 */
function pricedConstraint(requiredSpend: number | null): V2ProjectSiteConstraint {
  return {
    kind: "test-priced-constraint",
    async accepts() {
      return true;
    },
    async minimumFeasibleBudget() {
      if (requiredSpend === null) return null;
      return minimumFeasibleUtilityBudget({
        kind: "water",
        facilityPrefab: "GroundwaterPumpingStation01",
        facilityCost: requiredSpend - 136,
        connectionPrefab: "Small Water Pipe",
        connectionCost: 136,
      });
    },
  };
}

describe("utility-aware bounded admission budget", () => {
  /** 1_000_000 * 0.25 = 250_000 of share, so the policy ceiling is the binding bound. */
  const RICH = 1_000_000;

  test("raises the admitted budget to what the selected plan costs, before the identity is persisted", async () => {
    const { bootstrap, durability } = await admitWithConstraint(pricedConstraint(40_136), RICH);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error(`expected admission, received ${result.status}`);

    expect(result.evidence.policyMaximumBudget).toBe(V2_PROJECT_ADMISSION_POLICY.absoluteBudgetCeiling);
    expect(result.evidence.requiredUtilityBudget).toBe(40_136);
    expect(result.evidence.maximumBudget).toBe(40_136);
    expect(result.evidence.budgetBound).toBe("UTILITY_PLAN_MINIMUM");
    expect(result.evidence.utilityBudgetRequirement).toMatchObject({
      facilityCost: 40_000,
      facilityCostSource: "PLAN_ASSET_COST",
      connectionCost: 136,
      connectionCostSource: "NATIVE_SPENDING_CONTRACT",
      requiredSpend: 40_136,
    });

    // Persisted, not merely reported: the budget a later execution reads is the
    // raised one. A budget written after the fact is not a bound on anything.
    const persisted = durability.projectState();
    if (persisted.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a durable Gate 1 state");
    expect(persisted.project.maximumBudget).toBe(40_136);
    // And it is still a bounded share of treasury, not the treasury.
    expect(persisted.project.maximumBudget).toBeLessThan(RICH);
  });

  test("keeps the policy budget exactly when the plan already fits inside it", async () => {
    const { bootstrap } = await admitWithConstraint(pricedConstraint(20_000), RICH);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error(`expected admission, received ${result.status}`);

    expect(result.evidence.maximumBudget).toBe(V2_PROJECT_ADMISSION_POLICY.absoluteBudgetCeiling);
    expect(result.evidence.budgetBound).toBe("POLICY_CEILING");
    expect(result.evidence.requiredUtilityBudget).toBe(20_000);
  });

  test("leaves a constraint that declares no requirement byte-identical", async () => {
    // The electricity-shaped case: a constraint that answers the site question
    // and nothing else changes no budget at all.
    const { bootstrap } = await admitWithConstraint(pricedConstraint(null), RICH);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error(`expected admission, received ${result.status}`);

    expect(result.evidence.maximumBudget).toBe(V2_PROJECT_ADMISSION_POLICY.absoluteBudgetCeiling);
    expect(result.evidence.budgetBound).toBe("POLICY_CEILING");
    expect(result.evidence.requiredUtilityBudget).toBeNull();
    expect(result.evidence.utilityBudgetRequirement).toBeNull();
  });

  test("fails closed, admitting nothing, when the plan costs more than the policy share of treasury", async () => {
    // 100_000 * 0.25 = 25_000 of share against a 40_136 plan. The project is
    // affordable in principle and unaffordable within a starter tranche's share,
    // so no project is admitted rather than one that cannot be delivered.
    const { bootstrap, durability } = await admitWithConstraint(pricedConstraint(40_136), 100_000);
    await expect(bootstrap.admitFirstProject()).rejects.toThrow("PROJECT_ADMISSION_NO_VALID_BUDGET");
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });
});

// ---------------------------------------------------------------------------
// The water domain's real constraint, driven through the radius ladder
// ---------------------------------------------------------------------------

const WATER_RESOLUTION = 16;
const waterValues = (value: number) => Array(WATER_RESOLUTION * WATER_RESOLUTION).fill(value);

/** Wide enough to reserve the policy ceiling in, with clean dry owned land throughout. */
const waterWorld: SpatialWorldModel = {
  worldBounds: { min: -2000, max: 2000, size: 4000 },
  ownedTiles: [
    {
      entity: { index: 1, version: 1 },
      owned: true,
      bounds: { min: { x: -1000, z: -1000 }, max: { x: 1000, z: 1000 } },
      center: { x: 0, z: 0 },
      polygon: [],
    },
  ],
  outsideConnections: [],
  connectionCandidates: [],
  roadGraph: { nodes: [], edges: [], truncated: false },
};

/** One permanent player road through the origin, so every site has a network point. */
const waterRoad: SpatialRoadEdge = {
  entity: { index: 40, version: 1 },
  prefab: "Medium Road",
  native: true,
  startNode: { index: 41, version: 1 },
  endNode: { index: 42, version: 1 },
  start: { x: -600, z: 0 },
  end: { x: 600, z: 0 },
  length: 1200,
};

const waterAsset: SpatialBootstrapAsset = {
  prefab: "GroundwaterPumpingStation01",
  locked: false,
  constructionCost: 500,
  lotSize: { x: 4, z: 4 },
  size: { x: 32, y: 20, z: 32 },
  capabilities: {
    electricityProduction: 0,
    windMaximum: 0,
    windProduction: 0,
    groundWaterProduction: 100,
    groundWaterMaximum: 1000,
    freshWaterCapacity: 100,
    allowedWaterTypes: "GroundWater",
    sewageCapacity: 0,
    sewagePurification: 0,
  },
};

/**
 * A reservation whose groundwater gets richer the further it is from the centre,
 * so the planner's own ordering — richest source first, then nearest road — puts
 * the station at the OUTER edge of whatever envelope it is handed.
 *
 * That is the shape the radius ladder exists for: the site a 180 m reservation
 * reaches is not the site a 260 m one reaches, so "can this project be served"
 * is a real function of the reservation rather than a constant. The water is
 * clean only beyond the frontage the station needs, so the richest sample is
 * never one the planner has to reject for sitting on top of the road.
 */
function gradientSourceReservation(center: SpatialPoint2, radius: number): SpatialSiteDetail {
  const bounds = {
    minX: center.x - radius,
    minZ: center.z - radius,
    maxX: center.x + radius,
    maxZ: center.z + radius,
  };
  const cellSize = (2 * radius) / WATER_RESOLUTION;
  const groundWater: number[] = [];
  for (let row = 0; row < WATER_RESOLUTION; row++) {
    for (let col = 0; col < WATER_RESOLUTION; col++) {
      const x = bounds.minX + (col + 0.5) * cellSize;
      const z = bounds.minZ + (row + 0.5) * cellSize;
      const distance = Math.hypot(x - center.x, z - center.z);
      groundWater.push(distance >= 40 ? 100 + distance : 0);
    }
  }
  return {
    center,
    radius,
    terrain: {
      resolution: WATER_RESOLUTION,
      bounds,
      cellSize: { x: cellSize, z: cellSize },
      heights: waterValues(10),
      waterDepths: waterValues(0),
      groundWater,
      groundWaterPollution: waterValues(0),
      windSpeed: waterValues(5),
    },
    buildings: [],
    zoningCells: [],
    roadGraph: { nodes: [], edges: [waterRoad] },
  };
}

/**
 * The water domain as admission sees it: the REAL production constraint, wired
 * to a placement probe that answers yes only from `placeableFrom` outward.
 *
 * A distance gate is the honest shape of the live failure. Inside the durable
 * 200 m reservation the planner finds clean, dry, owned, flat groundwater and
 * the game refuses the station on all of it; the station only becomes buildable
 * once the reservation reaches ground the game accepts. So the envelope a
 * project may reserve is decided by the game's verdict, not by the water table.
 */
function waterConstraint(placeableFrom: number) {
  const probes: WaterFacilityPlacement[] = [];
  // The probe is asked about the plan the read it just made produced, so the
  // candidate's own centre is the origin every probe is measured against.
  let centre: SpatialPoint2 | null = null;
  const constraint = createWaterSiteConstraint({
    world: waterWorld,
    assets: [waterAsset],
    roads: [waterRoad],
    quoteConnectionCost: async () => 208,
    readReservation: async (point, radius) => {
      centre = point;
      return gradientSourceReservation(point, radius);
    },
    probePlacement: async (placement) => {
      probes.push(placement);
      const origin = centre ?? placement.position;
      return Math.hypot(placement.position.x - origin.x, placement.position.z - origin.z) >= placeableFrom;
    },
  });
  return { constraint, probes };
}

describe("native water facility placeability in admission", () => {
  const BASE = V2_PROJECT_ADMISSION_POLICY.planningEnvelopeRadiusMeters;

  test("reserves the smallest envelope whose water source the game actually accepts", async () => {
    // The planner is satisfied at every rung — the groundwater is right there,
    // and the source it picks sits 0.988 * radius from the candidate, so 180
    // through 240 m all propose a station the game refuses. 260 m is the first
    // envelope that reaches ground the game accepts, so it is the first project
    // that could actually be built.
    const { constraint, probes } = waterConstraint(245);
    const { bootstrap, durability } = await admitWithConstraint(constraint);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error(`expected admission, received ${result.status}`);

    expect(result.evidence.reservationRadiusMeters).toBe(260);
    expect(result.evidence.reservationRadiusLadder).toEqual([180, 200, 220, 240, 260, 280, 300, 320, 340, 360]);
    // The radius is the durable reservation's, not just the evidence's: the value
    // every later utility execution is checked against is the one the game agreed to.
    const persisted = durability.projectState();
    if (persisted.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a durable Gate 1 state");
    expect(persisted.project.utilityReservation.radius).toBe(260);
    // A native verdict was actually taken, and only for rungs the planner
    // proposed a source for.
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((placement) => placement.prefab === "GroundwaterPumpingStation01")).toBe(true);
  });

  test("keeps the base radius when the game accepts the source there", async () => {
    const { constraint } = waterConstraint(150);
    const { bootstrap, durability } = await admitWithConstraint(constraint);
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error("expected admission");

    expect(result.evidence.reservationRadiusMeters).toBe(BASE);
    expect(durability.projectState()).toMatchObject({ project: { utilityReservation: { radius: BASE } } });
  });

  test("fails closed when no bounded envelope holds a placement the game accepts", async () => {
    // The ceiling is not a licence to keep growing the reservation. A project
    // whose domain the game refuses everywhere is not admitted at the largest
    // envelope tried, and not admitted at all.
    const { constraint } = waterConstraint(Number.POSITIVE_INFINITY);
    const { bootstrap, durability } = await admitWithConstraint(constraint);

    await expect(bootstrap.admitFirstProject()).rejects.toThrow("PROJECT_ADMISSION_NO_VALID_SITE");
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("leaves the electricity admission contract untouched", async () => {
    // The electricity slice supplies no site constraint, so it never reaches the
    // water gate: no radius search, no plan to price, no native placement read.
    const { bootstrap, durability } = await admitWithConstraint();
    const result = await bootstrap.admitFirstProject();
    if (result.status !== "ADMITTED") throw new Error("expected admission");

    expect(result.evidence.reservationRadiusMeters).toBe(BASE);
    expect(result.evidence.reservationRadiusLadder).toEqual([]);
    expect(result.evidence.budgetBound).not.toBe("UTILITY_PLAN_MINIMUM");
    expect(result.evidence.requiredUtilityBudget).toBeNull();
    expect(result.evidence.utilityBudgetRequirement).toBeNull();
    expect(durability.projectState()).toMatchObject({ project: { utilityReservation: { radius: BASE } } });
  });

  test("does not retroactively widen an already admitted project", async () => {
    // A project admitted before this gate existed, at the base radius.
    const { bootstrap, durability } = await admitWithConstraint();
    const first = await bootstrap.admitFirstProject();
    if (first.status !== "ADMITTED") throw new Error("expected admission");
    const admittedReservation = first.state.project.utilityReservation;

    // The same store, now wired to the gate that would have demanded 260 m.
    const { constraint, probes } = waterConstraint(245);
    const reopened = createV2ProjectAdmissionBootstrap({
      durability,
      activateDurableWorld: async (signal) => activated(productionPorts(toolsFixture())).activateDurableWorld(signal),
      observation: observationPort(),
      siteConstraint: constraint,
      now: () => INSTANT,
    });

    const result = await reopened.ensureFirstProject();
    expect(result.status).toBe("ALREADY_ADMITTED");
    // The durable reservation is not re-planned, re-sized or re-admitted. A
    // stricter gate is a rule about projects not yet admitted, not a reason to
    // rewrite one that already holds land and a delivered ROAD.
    expect(durability.projectState()).toMatchObject({ project: { utilityReservation: admittedReservation } });
    // And it is not merely unreported: the gate never ran, so it never issued a
    // native read.
    expect(probes).toEqual([]);
  });

  test("derives a bounded Road access prerequisite from clean owned groundwater beyond local-road reach", async () => {
    const { constraint } = waterConstraint(150);
    const prerequisite = await constraint.derivePrerequisite?.();
    expect(prerequisite).toMatchObject({ kind: "ROAD_ACCESS", completionStage: "ROAD_DELIVERED" });
    expect(prerequisite?.targetPoint).toEqual(expect.objectContaining({ x: expect.any(Number), z: expect.any(Number) }));
    expect(prerequisite?.evidence).toContain("authoritative road graph");
  });
});

// ---------------------------------------------------------------------------
// Admission semantic repair
// ---------------------------------------------------------------------------

type Admitted = Awaited<ReturnType<typeof admitWithConstraint>>;

/** A second bootstrap over the same durable store, with a different domain constraint. */
function bootstrapOver(admitted: Admitted, siteConstraint: V2ProjectSiteConstraint) {
  return createV2ProjectAdmissionBootstrap({
    durability: admitted.durability,
    activateDurableWorld: activated(admitted.ports).activateDurableWorld,
    observation: observationPort(),
    siteConstraint,
    now: () => INSTANT,
  });
}

/** The durable proof that nothing has reached the utility native boundary yet. */
const NO_UTILITY_MUTATION: UtilityMutationProof = {
  firstFacilityPlacement: { status: "NONE" },
  submittedCommandIds: [],
};

/** What the live production replay reported for the durable 200 m replacement. */
function replayedInvalid(
  projectId: string,
  overrides: Partial<AdmissionSemanticsReplayEvidence> = {},
): AdmissionSemanticsReplayEvidence {
  return {
    semanticsRevision: ADMISSION_SEMANTICS_REVISION,
    projectId,
    oldProjectValidUnderCurrentSemantics: false,
    oldProjectRefusalReason:
      "WATER_FACILITY_NOT_PLACEABLE:prefab=GroundwaterPumpingStation01:placements=4",
    nativePlacementAccepted: true,
    facilityPrefab: "GroundwaterPumpingStation01",
    facilityPosition: { x: -226.909, z: 1283.57 },
    facilityRotation: 0,
    groundwaterValid: true,
    roadCandidateValid: true,
    requiredUtilityBudget: 40_272,
    ...overrides,
  };
}

/**
 * The exact shape the live world is in: a first project admitted under a
 * constraint that could not see native placeability, and then the one
 * replacement an ordinary supersession buys. The replacement is what is durable,
 * and its admission is what the current semantics invalidate.
 */
async function replacementReady() {
  const admitted = await admitWithConstraint(waterConstraint(150).constraint);
  const first = await admitted.bootstrap.admitFirstProject();
  if (first.status !== "ADMITTED") throw new Error(`expected admission, received ${first.status}`);
  const replacement = await bootstrapOver(admitted, waterConstraint(245).constraint).supersedeAndReplaceFirstProject({
    reason: SUPERSESSION_REASON,
    detail: "test: the first project's reservation cannot serve its own domain",
  });
  return {
    ...admitted,
    admitted,
    first,
    replacement,
    repairing: bootstrapOver(admitted, waterConstraint(245).constraint),
  };
}

describe("admission semantic repair", () => {
  test("repairs an already-replaced project whose admission the current semantics invalidate", async () => {
    const { durability, first, replacement, repairing } = await replacementReady();
    const root = first.state.project.id;

    const result = await repairing.repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test: admitted before native placeability joined site selection",
    });
    if (result.status !== "REPAIRED") throw new Error(`expected a repair, received ${result.status}`);

    // Identity is a function of (root project, semantics revision) and nothing
    // else — no wall clock, no randomness, no repair ordinal.
    expect(result.repair.rootProjectId).toBe(root);
    expect(result.repair.rootIntentId).toBe(first.state.intent.id);
    expect(result.repair.repairId).toBe(`${root}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`);
    expect(result.repair.semanticsRevision).toBe(ADMISSION_SEMANTICS_REVISION);
    expect(result.repair.reason).toBe("ADMISSION_INVALIDATED_BY_FIXED_ADMISSION_SEMANTICS");

    // It replaces the durable replacement, and the repair project is a genuinely
    // new identity derived from the root, not a re-mint of the replacement's.
    expect(result.repair.replacedProjectId).toBe(replacement.state.project.id);
    expect(result.state.project.id).not.toBe(replacement.state.project.id);
    expect(result.state.intent.id).toBe(
      `${first.state.intent.id}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`,
    );
    expect(result.repair.repairProjectId).toBe(result.state.project.id);
    expect(durability.projectState()).toMatchObject({ project: { id: result.state.project.id } });

    // The ordinary supersession history is untouched: the repair is a separate
    // append-only record, not a second supersession.
    expect(durability.supersededProjects()).toHaveLength(1);
    expect(durability.admissionSemanticRepairs()).toHaveLength(1);
  });

  test("resumes the same repair identity rather than buying a second one", async () => {
    const { durability, replacement, repairing } = await replacementReady();
    const input = {
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test: first",
    };
    const first = await repairing.repairAdmissionSemantics(input);
    if (first.status !== "REPAIRED") throw new Error("expected a repair");

    const again = await repairing.repairAdmissionSemantics({ ...input, detail: "test: resume" });
    expect(again.status).toBe("ALREADY_REPAIRED");
    expect(again.repair.repairId).toBe(first.repair.repairId);
    expect(again.repair.repairProjectId).toBe(first.state.project.id);
    expect(again.state.project.id).toBe(first.state.project.id);
    expect(durability.admissionSemanticRepairs()).toHaveLength(1);
  });

  test("cannot mint a second repair identity for the same root and revision", async () => {
    const { durability, first, replacement, repairing } = await replacementReady();
    const repaired = await repairing.repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test",
    });
    if (repaired.status !== "REPAIRED") throw new Error("expected a repair");

    const state = durability.projectState();
    if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a durable Gate 1 state");
    const base = {
      rootProjectId: first.state.project.id,
      rootIntentId: first.state.intent.id,
      rootTrancheId: first.state.tranche.id,
      rootReservationRef: first.state.tranche.reservationRef,
      replacedProjectId: state.project.id,
      replacedIntentId: state.intent.id,
      replacedTrancheId: state.tranche.id,
      replacedReservationRef: state.tranche.reservationRef,
      supersessionIds: [],
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      replacedState: state,
      detail: "test",
    };
    // The same pair under a different id is still refused: the bound is the
    // pair, not the caller's id derivation.
    expect(() =>
      durability.recordAdmissionSemanticRepair({
        ...base,
        repairId: `${first.state.project.id}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}:another`,
      }),
    ).toThrow("root project already has a repair for this admission semantics revision");
    // And re-using the exact identity is refused too.
    expect(() =>
      durability.recordAdmissionSemanticRepair({
        ...base,
        repairId: `${first.state.project.id}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`,
      }),
    ).toThrow("admission semantic repair is already recorded");
    expect(durability.admissionSemanticRepairs()).toHaveLength(1);
  });

  test("refuses a repair on incomplete or contradictory replay evidence, recording nothing", async () => {
    const { durability, replacement, repairing } = await replacementReady();
    const before = durability.projectState();
    const projectId = replacement.state.project.id;

    // The old project judged still valid is a contradiction, not a repair.
    await expect(
      repairing.repairAdmissionSemantics({
        semanticsRevision: ADMISSION_SEMANTICS_REVISION,
        evidence: replayedInvalid(projectId, { oldProjectValidUnderCurrentSemantics: true }),
        mutation: NO_UTILITY_MUTATION,
        detail: "test",
      }),
    ).rejects.toThrow("ADMISSION_SEMANTIC_REPAIR_OLD_PROJECT_STILL_VALID");

    // Each missing half of the new plan's proof is its own refusal.
    for (const invalid of [
      { nativePlacementAccepted: false },
      { groundwaterValid: false },
      { roadCandidateValid: false },
      { oldProjectRefusalReason: "" },
    ]) {
      await expect(
        repairing.repairAdmissionSemantics({
          semanticsRevision: ADMISSION_SEMANTICS_REVISION,
          evidence: replayedInvalid(projectId, invalid),
          mutation: NO_UTILITY_MUTATION,
          detail: "test",
        }),
      ).rejects.toThrow(/ADMISSION_SEMANTIC_REPAIR_/);
    }

    // Evidence about a different project is not evidence about this one.
    await expect(
      repairing.repairAdmissionSemantics({
        semanticsRevision: ADMISSION_SEMANTICS_REVISION,
        evidence: replayedInvalid("intent:some-other-project"),
        mutation: NO_UTILITY_MUTATION,
        detail: "test",
      }),
    ).rejects.toThrow("ADMISSION_SEMANTIC_REPAIR_EVIDENCE_PROJECT_MISMATCH");

    // Nothing durable was written by any of those refusals.
    expect(durability.admissionSemanticRepairs()).toHaveLength(0);
    expect(durability.projectState()).toEqual(before);
  });

  test("refuses a repair once the utility native boundary has been entered", async () => {
    const { durability, replacement, repairing } = await replacementReady();
    const projectId = replacement.state.project.id;
    const call = (mutation: UtilityMutationProof) =>
      repairing.repairAdmissionSemantics({
        semanticsRevision: ADMISSION_SEMANTICS_REVISION,
        evidence: replayedInvalid(projectId),
        mutation,
        detail: "test",
      });

    // A facility is in the world. It was built under the old semantics, and
    // replacing the project afterwards would leave that effect unowned.
    await expect(
      call({ firstFacilityPlacement: { status: "PLACED", commandId: "command-1" }, submittedCommandIds: ["command-1"] }),
    ).rejects.toThrow("PROJECT_SEMANTIC_REPAIR_UTILITY_MUTATION_ALREADY_HAPPENED:PLACED");
    await expect(
      call({
        firstFacilityPlacement: { status: "UNRESOLVED", commandId: "command-2", outcome: "UNKNOWN" },
        submittedCommandIds: ["command-2"],
      }),
    ).rejects.toThrow(/PROJECT_SEMANTIC_REPAIR_UTILITY_MUTATION_ALREADY_HAPPENED/);
    // A pipe that reached native counts even when the placement state alone
    // would not have caught it.
    await expect(
      call({ firstFacilityPlacement: { status: "NONE" }, submittedCommandIds: ["command-3"] }),
    ).rejects.toThrow("PROJECT_SEMANTIC_REPAIR_UTILITY_MUTATION_ALREADY_HAPPENED:DURABLE_UTILITY_JOURNAL");

    expect(durability.admissionSemanticRepairs()).toHaveLength(0);
  });

  test("leaves the replaced project, its reservation, its ROAD and the journal untouched", async () => {
    const { durability, first, replacement, admitted } = await replacementReady();
    const supersessionsBefore = durability.supersededProjects();
    const journalBefore = durability.commandJournal.list();

    // The repair admits against a DIFFERENT gate than the supersession did, so
    // the two projects reserve different envelopes. That is what makes "the
    // replaced state was not rewritten to the repair's scope" a real assertion
    // rather than a coincidence of both landing on the same radius.
    const result = await bootstrapOver(admitted, waterConstraint(150).constraint).repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test",
    });
    if (result.status !== "REPAIRED") throw new Error("expected a repair");

    // The supersession history is byte-identical: the repair appended beside it.
    expect(durability.supersededProjects()).toEqual(supersessionsBefore);
    // The replaced project's state is carried verbatim, including the reservation
    // that made it invalid under the current semantics — never rewritten to the
    // repair's own scope.
    expect(result.repair.replacedState).toEqual(replacement.state);
    expect(result.repair.replacedState.project.utilityReservation).toEqual(
      replacement.state.project.utilityReservation,
    );
    expect(result.repair.replacedState.project.utilityReservation.radius).not.toBe(
      result.state.project.utilityReservation.radius,
    );
    // World effects live in the journal, and the journal does not know about
    // repairs. The first project's delivered ROAD is still there.
    expect(durability.commandJournal.list()).toEqual(journalBefore);
    expect(result.repair.supersessionIds).toEqual(supersessionsBefore.map((entry) => entry.supersessionId));
    expect(first.state.project.id).toBe(result.repair.rootProjectId);
  });

  test("leaves the generic supersession rule exactly as it was", async () => {
    const { durability, replacement, repairing } = await replacementReady();

    // The rule the repair must not have bought its way around, asserted before
    // and after the repair: a project that is itself a supersession replacement
    // still cannot be superseded.
    await expect(
      repairing.supersedeAndReplaceFirstProject({ reason: SUPERSESSION_REASON, detail: "still refused" }),
    ).rejects.toThrow("a replacement project cannot itself be superseded");

    await repairing.repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test",
    });

    const state = durability.projectState();
    if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("expected a durable Gate 1 state");
    // Driven straight at the durable boundary, so the refusal is the store's and
    // not a caller's restraint.
    expect(() =>
      durability.recordProjectSupersession({
        supersessionId: `${replacement.state.project.id}:superseded`,
        projectId: replacement.state.project.id,
        intentId: replacement.state.intent.id,
        trancheId: replacement.state.tranche.id,
        reservationRef: replacement.state.tranche.reservationRef,
        supersededState: replacement.state,
        reason: SUPERSESSION_REASON,
        detail: "second",
      }),
    ).toThrow("a replacement project cannot itself be superseded");
    // Exactly one supersession, and the lineage is still two projects deep.
    expect(durability.supersededProjects()).toHaveLength(1);
    expect(state.project.id).toBe(durability.admissionSemanticRepairs()[0].repairProjectId);
  });

  test("a different root project inherits no repair authority", async () => {
    // Two independent worlds, each with its own root and its own replacement.
    const worldA = await replacementReady();
    const fixtureB = toolsFixture();
    fixtureB.onboardDifferentWorld();
    const portsB = productionPorts(fixtureB);
    const activateB = activated(portsB).activateDurableWorld;
    await activateB();
    const durabilityB = activated(portsB).durability;
    const overB = (siteConstraint: V2ProjectSiteConstraint) =>
      createV2ProjectAdmissionBootstrap({
        durability: durabilityB,
        activateDurableWorld: activateB,
        observation: observationPort(),
        siteConstraint,
        now: () => INSTANT,
      });
    const firstB = await overB(waterConstraint(150).constraint).admitFirstProject();
    if (firstB.status !== "ADMITTED") throw new Error("expected admission");
    const repairingB = overB(waterConstraint(245).constraint);
    const replacementB = await repairingB.supersedeAndReplaceFirstProject({
      reason: SUPERSESSION_REASON,
      detail: "test: world B",
    });

    // Genuinely different roots, so the repair identities cannot collide.
    const rootA = worldA.first.state.project.id;
    const rootB = firstB.state.project.id;
    expect(rootA).not.toBe(rootB);
    const idA = deriveAdmissionSemanticRepairId({ rootProjectId: rootA, semanticsRevision: ADMISSION_SEMANTICS_REVISION });
    const idB = deriveAdmissionSemanticRepairId({ rootProjectId: rootB, semanticsRevision: ADMISSION_SEMANTICS_REVISION });
    expect(idA).not.toBe(idB);

    const repairedA = await worldA.repairing.repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(worldA.replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test",
    });
    if (repairedA.status !== "REPAIRED") throw new Error("expected a repair");
    expect(repairedA.repair.repairId).toBe(idA);

    // World A's repair is authority over world A's lineage and nothing else:
    // world B's store holds no repair at all, and world B's identity is not
    // satisfied by A's record.
    expect(worldA.durability.admissionSemanticRepairs()).toHaveLength(1);
    expect(durabilityB.admissionSemanticRepairs()).toHaveLength(0);
    expect(worldA.durability.admissionSemanticRepairs().find((entry) => entry.repairId === idB)).toBeUndefined();

    // And world B must earn its own, under its own root.
    const repairedB = await repairingB.repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacementB.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test: world B",
    });
    if (repairedB.status !== "REPAIRED") throw new Error("expected a repair");
    expect(repairedB.repair.repairId).toBe(idB);
    expect(repairedB.repair.rootProjectId).toBe(rootB);
  });

  test("keeps the repair identity and state stable across a durability restart", async () => {
    // One durable store, two compositions over it: the second is the restart.
    const fixture = toolsFixture();
    const storage = createMemoryDurableStateStorage();
    const factory = () =>
      createV2FoundationPorts({
        getToolsManager: () => fixture.manager as never,
        durableStateStorage: storage,
        now: () => INSTANT,
        baselineSavePollMs: 1,
      });
    const over = (ports: FoundationPorts, siteConstraint: V2ProjectSiteConstraint) =>
      createV2ProjectAdmissionBootstrap({
        durability: activated(ports).durability,
        activateDurableWorld: activated(ports).activateDurableWorld,
        observation: observationPort(),
        siteConstraint,
        now: () => INSTANT,
      });

    const before = factory();
    await activated(before).activateDurableWorld();
    const first = await over(before, waterConstraint(150).constraint).admitFirstProject();
    if (first.status !== "ADMITTED") throw new Error("expected admission");
    const replacement = await over(before, waterConstraint(245).constraint).supersedeAndReplaceFirstProject({
      reason: SUPERSESSION_REASON,
      detail: "test",
    });
    const repaired = await over(before, waterConstraint(245).constraint).repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(replacement.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test",
    });
    if (repaired.status !== "REPAIRED") throw new Error("expected a repair");

    // A restart rebuilds the composition over the SAME durable store. The repair
    // is read back from it rather than remembered, and re-derives to the same
    // identity — which is what makes a resume safe.
    const after = factory();
    await activated(after).activateDurableWorld();
    const resumed = await over(after, waterConstraint(245).constraint).repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: replayedInvalid(repaired.state.project.id),
      mutation: NO_UTILITY_MUTATION,
      detail: "test: after restart",
    });
    expect(resumed.status).toBe("ALREADY_REPAIRED");
    expect(resumed.repair.repairId).toBe(
      `${first.state.project.id}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`,
    );
    expect(resumed.repair.repairProjectId).toBe(repaired.state.project.id);
    expect(resumed.state.project.id).toBe(repaired.state.project.id);
    expect(activated(after).durability.admissionSemanticRepairs()).toHaveLength(1);
  });

  test("derives the repair identity from the root and the revision, not from a counter", () => {
    const root = "intent:gate1-starter:cs2-session:a:baseline:save:b";
    const id = deriveAdmissionSemanticRepairId({ rootProjectId: root, semanticsRevision: ADMISSION_SEMANTICS_REVISION });
    expect(id).toBe(`${root}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`);
    // Deterministic: the same pair always yields the same identity.
    expect(deriveAdmissionSemanticRepairId({ rootProjectId: root, semanticsRevision: ADMISSION_SEMANTICS_REVISION })).toBe(id);
    // A new revision is a new identity — and that is the only way to get one.
    expect(deriveAdmissionSemanticRepairId({ rootProjectId: root, semanticsRevision: "water-native-placeability-admission-v2" })).not.toBe(id);
    expect(deriveAdmissionSemanticRepairIntentId({ rootIntentId: root, semanticsRevision: ADMISSION_SEMANTICS_REVISION })).toBe(
      `${root}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`,
    );
    expect(() => deriveAdmissionSemanticRepairId({ rootProjectId: "", semanticsRevision: ADMISSION_SEMANTICS_REVISION })).toThrow(
      "ADMISSION_SEMANTIC_REPAIR_ROOT_PROJECT_MISSING",
    );
    expect(() => deriveAdmissionSemanticRepairId({ rootProjectId: root, semanticsRevision: " " })).toThrow(
      "ADMISSION_SEMANTIC_REPAIR_REVISION_MISSING",
    );

    // The root walk follows both relationship records, and refuses to resolve a
    // lineage that is not a chain.
    const repairs = [
      { rootProjectId: "root-1", repairProjectId: "repair-1" },
      { rootProjectId: "root-2", repairProjectId: "repair-2" },
    ] as never;
    const supersessions = [{ projectId: "root-1", replacementProjectId: "replacement-1" }] as never;
    expect(resolveAdmissionLineageRoot({ currentProjectId: "replacement-1", supersessions, repairs })).toBe("root-1");
    expect(resolveAdmissionLineageRoot({ currentProjectId: "root-1", supersessions, repairs })).toBe("root-1");
    // A repair project hands off to the same root, not to itself.
    expect(resolveAdmissionLineageRoot({ currentProjectId: "repair-1", supersessions, repairs })).toBe("root-1");
    expect(resolveAdmissionLineageRoot({ currentProjectId: "repair-2", supersessions, repairs })).toBe("root-2");
  });
});

/**
 * A Goal's bounded steps are one continuous effort. Treating a corridor's own
 * earlier steps as competing claims would let the first Road prerequisite of a
 * Goal refuse the site of the second one, so a Goal whose resource sits beyond
 * one road segment could never be reached no matter how long it waited. A
 * DIFFERENT Goal's envelope stays foreign and still refuses the candidate.
 */
describe("Goal lineage protection families", () => {
  const record = (goalId: string, parentGoalId: string | null = null) => ({ goalId, parentGoalId }) as never;

  test("a prerequisite is in the same family as its parent Goal and its sibling steps", () => {
    const records = [
      record("UTILITY_SERVICE:water:city:site_scope:1"),
      record("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa", "UTILITY_SERVICE:water:city:site_scope:1"),
      record("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:2:bb", "UTILITY_SERVICE:water:city:site_scope:1"),
      record("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:3:cc", "UTILITY_SERVICE:water:city:site_scope:1"),
      record("EXPAND_RESIDENTIAL:residential:facts:ff"),
    ];
    const family = sameGoalFamilyGoalIds(records, {
      goalId: "UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:4:dd",
      parentGoalId: "UTILITY_SERVICE:water:city:site_scope:1",
    });
    expect(family.has("UTILITY_SERVICE:water:city:site_scope:1")).toBe(true);
    expect(family.has("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa")).toBe(true);
    expect(family.has("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:3:cc")).toBe(true);
    // Another Goal's work order is a foreign claim on land, not a continuation.
    expect(family.has("EXPAND_RESIDENTIAL:residential:facts:ff")).toBe(false);
  });

  test("a Goal with no parent is its own family, so unrelated scopes stay foreign", () => {
    const records = [record("a"), record("b", "a")];
    expect([...sameGoalFamilyGoalIds(records, { goalId: "c" })]).toEqual(["c"]);
  });

  test("a malformed lineage cannot make the walk spin", () => {
    const records = [record("b", "a"), record("a", "b")];
    expect([...sameGoalFamilyGoalIds(records, { goalId: "c", parentGoalId: "a" })].sort())
      .toEqual(["a", "b", "c"]);
  });
});

/**
 * A prerequisite corridor is a bounded attempt by its parent Goal, not a
 * separate appetite for land. Counting ATTEMPTS rather than DELIVERED steps gave
 * an unsatisfiable prerequisite an endless supply of identities — each
 * re-derivation differed only by its step number — so the parent "succeeded" at
 * being re-admitted into work that could never build anything, sixteen bounded
 * work orders per Brain cycle. A repeated derivation must instead name the same
 * step, so the parent Goal is the one that decides what happens next.
 */
/**
 * A site this project could zone is still a site it cannot use if native
 * refuses every course that would reach it. Observed live: three consecutive
 * Goals were admitted onto land whose three source nodes refused all 24 sampled
 * courses with `operation blocked by game validation`, so each Goal's Road step
 * could only die and the next admission landed on the same ground.
 */
describe("admission refuses land the game will not build on", () => {
  test("only growth Goals spend the expanded bounded anchor search", () => {
    expect(maximumSiteAnchorsForGoal("EXPAND_RESIDENTIAL:residential:facts:abc")).toBe(96);
    expect(maximumSiteAnchorsForGoal("PROVIDE_SERVICE:sewage:facts:abc")).toBe(48);
    expect(maximumSiteAnchorsForGoal("ESTABLISH_ROAD_NETWORK:facts:abc")).toBe(48);
    expect(maximumSiteAnchorsForGoal()).toBe(48);
  });

  const PRODUCTIVE_PREVIEW = {
    previewOnly: true, valid: true, validNewRoadProposal: true,
    roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
    courseIntegrity: { operationKind: "NEW_ROAD_PROPOSAL_EDGE", postHandoffGeometryPreserved: true, proposalEdgeCount: 1 },
  };
  const bootstrapWithPreview = async (previewRoad: (input: unknown) => Promise<unknown>) => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    return {
      durability,
      bootstrap: createV2ProjectAdmissionBootstrap({
        durability, activateDurableWorld, observation: observationPort(),
        previewRoad: previewRoad as never, now: () => INSTANT,
      }),
    };
  };

  test("refuses a site whose own bounded road courses the game will not build", async () => {
    let previewed = 0;
    const { bootstrap, durability } = await bootstrapWithPreview(async () => {
      previewed += 1;
      // The shape a native game-validation refusal actually reaches the product
      // as: a structured 409 from the Bridge, not a bare status.
      throw Object.assign(new Error("operation blocked by game validation (overlap, water, steep terrain)"), {
        status: 409,
        bridgeHttpErrorDiagnostics: { source: "bridge-http-error" },
        nativeToolErrors: [{ errorType: "Overlap" }],
      });
    });

    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/PROJECT_ADMISSION_NO_ELIGIBLE_SITE/);
    // The refusal is named where the evaluator's own counters cannot show it: a
    // site the road gate removed looks like an ordinary eligible site to them.
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/roadGateRefusals/);
    expect(previewed).toBeGreaterThan(0);
    // Nothing was admitted, so nothing claims the land.
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("a buildable course keeps the site", async () => {
    const { bootstrap } = await bootstrapWithPreview(async () => PRODUCTIVE_PREVIEW);
    await expect(bootstrap.admitFirstProject()).resolves.toMatchObject({ status: "ADMITTED" });
  });

  /**
   * The road gate must ask the Road step's own question or it asks a different one.
   *
   * The Road step sweeps `resolveBoundedRoadCandidates`' whole bounded family —
   * eight variants across three sources — so a gate that samples only the first
   * few courses of each site refuses land the Road step would have built on. This
   * is not hypothetical: measured live on the loaded save (2026-09-29), sampling
   * three per site made EVERY Goal's admission end `PROJECT_ADMISSION_NO_ELIGIBLE_SITE`
   * (`roadGateRefusals: 6`) so no Goal could receive a scope at all, while
   * previewing the family admitted one on the same world in the same run.
   */
  test("the road gate previews a site's whole bounded family, not a sample of it", async () => {
    // The gate's family is the resolver's family. If these ever diverge, the gate
    // is answering a question native is never asked downstream.
    expect(MAXIMUM_ADMISSION_ROAD_PREVIEWS).toBe(MAXIMUM_BOUNDED_ROAD_CANDIDATES);
    let previewed = 0;
    let courses = 0;
    const { bootstrap, durability } = await bootstrapWithPreview(async () => {
      previewed += 1;
      throw Object.assign(new Error("operation blocked by game validation (overlap, water, steep terrain)"), {
        status: 409, bridgeHttpErrorDiagnostics: { source: "bridge-http-error" },
        nativeToolErrors: [{ errorType: "Overlap" }],
      });
    });
    // Count what the fixture actually offers before judging the sweep against it.
    const counting = await bootstrapWithPreview(async () => { courses += 1; return PRODUCTIVE_PREVIEW; });
    await expect(counting.bootstrap.admitFirstProject()).resolves.toMatchObject({ status: "ADMITTED" });

    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/roadGateRefusals/);
    // Every course of every candidate was asked, not three per candidate: the old
    // bound would stop at 3 x (number of candidates), which is strictly fewer than
    // the family the fixture offers.
    expect(courses).toBeGreaterThan(0);
    expect(previewed).toBeGreaterThan(6);
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("an unreadable preview is not evidence against the site", async () => {
    // A transport failure is not a verdict about the land. UNKNOWN must stay
    // UNKNOWN, and admission must not invent a rejection it cannot evidence.
    const { bootstrap } = await bootstrapWithPreview(async () => { throw new Error("transport timeout"); });
    await expect(bootstrap.admitFirstProject()).resolves.toMatchObject({ status: "ADMITTED" });
  });

  test("without a preview port admission judges the site exactly as it did", async () => {
    const { bootstrap } = await admitWithConstraint();
    await expect(bootstrap.admitFirstProject()).resolves.toMatchObject({ status: "ADMITTED" });
  });

  /**
   * A site the zoning step cannot take is not a site this project can use.
   * `evaluateBoundedStarterSites` keeps a frontage-less candidate as its bounded
   * fallback, which is right for a candidate generator and wrong for admission:
   * admitting one spends a real road build on land that is then terminally
   * unusable. Measured live — a reservation with zero usable cells at every
   * radius the zoning step tries, admitted, roaded, and closed at
   * `GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET`.
   */
  const bootstrapWithCensus = async (
    zoneCategory: string | null,
    censusCells: SpatialSiteDetail["zoningCells"] = siteDetail.zoningCells,
  ) => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    return {
      durability,
      bootstrap: createV2ProjectAdmissionBootstrap({
        durability, activateDurableWorld,
        observation: {
          ...observationPort(),
          captureSiteDetail: async () => ({
            detail: zoneCategory === null ? { ...siteDetail, zoningCells: [] } : {
              ...siteDetail,
              zoningCells: censusCells.map((cell) => ({ ...cell, zoneCategory })),
            },
            coherence: "STABLE_FRAME", observationId: "observation:census",
          }),
        },
        previewRoad: async () => PRODUCTIVE_PREVIEW,
        now: () => INSTANT,
      }),
    };
  };

  test("refuses a site whose reservation the zoning step could not take", async () => {
    const { bootstrap, durability } = await bootstrapWithCensus("residential");
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/PROJECT_ADMISSION_NO_ELIGIBLE_SITE/);
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/zoneGateRefusals/);
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("refuses a colorable but non-roadside 1x2 fragment before admission", async () => {
    const currentParcelCells: SpatialSiteDetail["zoningCells"] = [
      { ...siteDetail.zoningCells[0]!, block: { index: 71, version: 1 }, index: 8,
        position: { x: 20, y: 0, z: 0 }, roadside: false },
      { ...siteDetail.zoningCells[0]!, block: { index: 71, version: 1 }, index: 14,
        position: { x: 20.6, y: 0, z: 8 }, roadside: false, roadRight: false },
    ];
    const { bootstrap, durability } = await bootstrapWithCensus("none", currentParcelCells);
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/PROJECT_ADMISSION_NO_ELIGIBLE_SITE/);
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/zoneGateRefusals/);
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("admits a contiguous footprint with authoritative roadside frontage", async () => {
    const frontageCells: SpatialSiteDetail["zoningCells"] = [
      { ...siteDetail.zoningCells[0]!, block: { index: 72, version: 1 }, index: 0,
        position: { x: 20, y: 0, z: 0 }, roadside: true },
      { ...siteDetail.zoningCells[0]!, block: { index: 72, version: 1 }, index: 1,
        position: { x: 20, y: 0, z: 8 }, roadside: false },
    ];
    const { bootstrap } = await bootstrapWithCensus("none", frontageCells);
    await expect(bootstrap.admitFirstProject()).resolves.toMatchObject({ status: "ADMITTED" });
  });

  test("growth Goal uses Zone Block fast path and preserves its bounded strip scope", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    const strip: SpatialSiteDetail["zoningCells"] = Array.from({ length: 12 }, (_, index) => ({
      ...siteDetail.zoningCells[0]!, block: { index: 72, version: 1 }, index,
      position: { x: 20, y: 0, z: index * 8 }, roadside: index === 0,
      occupied: false, blocked: false, overridden: false, zoneCategory: "none",
    }));
    const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async () => ({
        detail: { ...siteDetail, zoningCells: strip }, coherence: "STABLE_FRAME", observationId: "observation:growable-fast-path",
      }) },
      previewRoad: async () => { throw new Error("growable planning must not native-preview road candidates"); },
      now: () => INSTANT,
    });
    const admitted = await bootstrap.ensureGoalWorkOrder({ goalId: "EXPAND_RESIDENTIAL:residential:test", landUse: "RESIDENTIAL" });
    expect(admitted.status).toBe("ADMITTED");
    expect(admitted.state.tranche.target.radius).toBeGreaterThanOrEqual(24);
    expect(admitted.state.tranche.target.radius).toBeLessThanOrEqual(48);
    expect(admitted.state.project.utilityReservation.radius).toBe(admitted.state.tranche.target.radius);
    expect(admitted.evidence.siteObservationIds).toEqual(["observation:growable-fast-path"]);
    expect(admitted.evidence.eligibleCandidates).toBeGreaterThan(0);
  });

  test("growth Goal delivers a Road frontage prerequisite before choosing a zoning footprint", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    const unfrontedCells: SpatialSiteDetail["zoningCells"] = Array.from({ length: 12 }, (_, index) => ({
      ...siteDetail.zoningCells[0]!, block: { index: 73, version: 1 }, index,
      position: { x: 20, y: 0, z: index * 8 }, roadside: false, roadLeft: false, roadRight: false,
      occupied: false, blocked: false, overridden: false, zoneCategory: "none",
    }));
    const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async () => ({
        detail: { ...siteDetail, zoningCells: unfrontedCells }, coherence: "STABLE_FRAME", observationId: "observation:unfronted-zone-block",
      }) },
      previewRoad: async () => PRODUCTIVE_PREVIEW,
      now: () => INSTANT,
    });

    const admitted = await bootstrap.ensureGoalWorkOrder({
      goalId: "EXPAND_RESIDENTIAL:residential:no-frontage", landUse: "RESIDENTIAL",
    });

    expect(admitted.status).toBe("PREREQUISITE_ADMITTED");
    if (admitted.status !== "PREREQUISITE_ADMITTED") throw new Error("expected Road frontage prerequisite");
    expect(admitted.prerequisite).toMatchObject({ kind: "ROAD_FRONTAGE", completionStage: "ROAD_DELIVERED" });
    expect(admitted.activeGoalId).toContain(":prerequisite:ROAD_FRONTAGE:");
    expect(durability.goalWorkOrder(admitted.activeGoalId)).toMatchObject({
      parentGoalId: "EXPAND_RESIDENTIAL:residential:no-frontage",
      parentLandUse: "RESIDENTIAL",
      completionStage: "ROAD_DELIVERED",
    });
  });

  /**
   * A `ROAD_FRONTAGE` step is one Road segment. It owns no lot, claims no zoning
   * footprint, and proves nothing about its own anchor's census, so none of
   * those questions may decide whether it is admitted — measured live
   * (2026-10-01) as every growth domain refused
   * `PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN` on such a work order while the
   * bounded site search underneath found no buildable candidate at all.
   */
  test("a Road frontage prerequisite is admitted from its planned corridor, and reads no zoning census", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    const unfrontedCells: SpatialSiteDetail["zoningCells"] = Array.from({ length: 12 }, (_, index) => ({
      ...siteDetail.zoningCells[0]!, block: { index: 73, version: 1 }, index,
      position: { x: 20, y: 0, z: index * 8 }, roadside: false, roadLeft: false, roadRight: false,
      occupied: false, blocked: false, overridden: false, zoneCategory: "none",
    }));
    // Every census read is recorded with the radius it asked for, so "did a Road
    // prerequisite read a zoning census" is a measurement rather than a reading
    // of the call graph.
    const readRadii: number[] = [];
    const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async (scope) => {
        readRadii.push(scope.radius);
        return { detail: { ...siteDetail, zoningCells: unfrontedCells }, coherence: "STABLE_FRAME",
          observationId: `observation:unfronted:${readRadii.length}` };
      } },
      previewRoad: async () => PRODUCTIVE_PREVIEW,
      now: () => INSTANT,
    });

    const admitted = await bootstrap.ensureGoalWorkOrder({
      goalId: "EXPAND_RESIDENTIAL:residential:planned-corridor", landUse: "RESIDENTIAL",
    });
    expect(admitted.status).toBe("PREREQUISITE_ADMITTED");
    if (admitted.status !== "PREREQUISITE_ADMITTED") throw new Error("expected Road frontage prerequisite");

    // The planner's compiled segment travels with the step, so nothing
    // downstream has to reconstruct its start.
    const course = admitted.prerequisite.roadCourse;
    expect(course).toBeDefined();
    expect([course!.start.x, course!.start.z, course!.end.x, course!.end.z].every(Number.isFinite)).toBe(true);
    expect(course!.start).not.toEqual(course!.end);
    expect(admitted.prerequisite.targetPoint).toEqual(course!.end);

    const child = durability.goalWorkOrder(admitted.activeGoalId);
    if (!child) throw new Error("expected durable Road frontage child");
    expect(child.roadCourse).toEqual(course);
    // The scope owns the tasks its own deliverable requires, and nothing else.
    // A road-only scope has no zoning, building or occupancy semantics to run —
    // and carrying them is not harmless: measured live (2026-10-01) a frontage
    // scope whose road had been delivered was then advanced into its own ZONING
    // step and closed terminally on land that was never a zoning site.
    expect(child.state.tasks.map((entry) => entry.kind)).toEqual(["SITE_SELECTION", "ROAD_CONNECTION"]);
    expect(child.state.tranche.allowedActionFamilies).toEqual(["ROAD"]);
    expect(child.state.tranche.delivery_progress.total).toBe(2);
    // The scope owns exactly the ground its own segment crosses, so the course
    // can never be refused for escaping its own reservation.
    const reservation = child.state.project.utilityReservation;
    for (const point of [course!.start, course!.end]) {
      expect(Math.hypot(point.x - reservation.center.x, point.z - reservation.center.z)).toBeLessThanOrEqual(reservation.radius);
    }
    expect(readRadii).not.toContain(V2_PROJECT_ADMISSION_POLICY.siteObservationRadiusMeters);
  });

  /**
   * The planner decides the route; native decides whether it can be built where
   * it runs. A hop the corridor compiled and native refuses is not a course worth
   * shipping — measured live (2026-10-01): every growth domain raised the
   * prerequisite for the same 94.8 m hop native answered
   * `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, and each refusal closed one work
   * order and minted the next.
   */
  test("a ring whose every compiled hop native refuses parks the target by name", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    const unfrontedCells: SpatialSiteDetail["zoningCells"] = Array.from({ length: 12 }, (_, index) => ({
      ...siteDetail.zoningCells[0]!, block: { index: 73, version: 1 }, index,
      position: { x: 20, y: 0, z: index * 8 }, roadside: false, roadLeft: false, roadRight: false,
      occupied: false, blocked: false, overridden: false, zoneCategory: "none",
    }));
    const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async () => ({
        detail: { ...siteDetail, zoningCells: unfrontedCells }, coherence: "STABLE_FRAME",
        observationId: "observation:unfronted-nothing",
      }) },
      previewRoad: async () => { throw new Error("HTTP 409 native validation rejected the course"); },
      now: () => INSTANT,
    });

    await expect(bootstrap.ensureGoalWorkOrder({
      goalId: "EXPAND_RESIDENTIAL:residential:refused-hop", landUse: "RESIDENTIAL",
    })).rejects.toThrow(/PROJECT_ADMISSION_GROWABLE_FOOTPRINT_UNSERVICEABLE:MISSING_FRONTAGE:.*native refused every course the corridor compiled/);
    // The refusal is a finding, not a prerequisite: no frontage work order was
    // minted for a course native had already answered.
    expect((durability.snapshot().goalWorkOrders ?? [])
      .filter((order) => /prerequisite:ROAD_FRONTAGE/.test(order.goalId))).toHaveLength(0);
  });

  /**
   * The Growth Frontier loop stands on one fact: **a Road the product built is a
   * place the next census reads.**
   *
   * `native` is origin metadata, not authorization (`SpatialRoadEdge` says so
   * itself). Measured live (2026-10-02) on `cs2-session:d8413e4f…`: of 50 owned
   * local edges, 8 are the map's own and 42 are the Mayor's, carrying 38 owned
   * nodes — and a ring that required `native` saw none of them, so building a
   * road could never move the frontier outward and the loop could not close.
   *
   * The world here is the scan plus one node/edge pair the map does not own,
   * 30 m out from the network's end: exactly the shape a delivered Road comes
   * back in. The assertion is which ground the ring censuses, which is the fact
   * the rest of the loop is built on.
   */
  test("a Road the product built becomes ground the next growth census reads", async () => {
    const withProductRoad = {
      ...scanPayload,
      world: { min: -2000, max: 2000, size: 4000 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -1500, z: -1500 }, max: { x: 1500, z: 1500 } }, center: { x: 0, z: 0 }, polygon: [] }],
      roadGraph: {
        truncated: false,
        nodes: [...scanPayload.roadGraph.nodes, {
          // 400 m from the network's end, so it survives the ring's 192 m
          // separation and is read as its own region.
          entity: { index: 12, version: 1 }, position: { x: 400, y: 0, z: 0 },
          native: false, outsideConnection: false, roadDegree: 1,
        }],
        edges: [...scanPayload.roadGraph.edges, {
          entity: { index: 21, version: 1 }, prefab: "Medium Road", native: false,
          startNode: { index: 11, version: 1 }, endNode: { index: 12, version: 1 },
          start: { x: 30, z: 0 }, end: { x: 400, z: 0 }, length: 370,
        }],
      },
    };
    const censusAnchors = async (catalogue: string[]) => {
      const ports = productionPorts(toolsFixture());
      const { durability, activateDurableWorld } = activated(ports);
      await activateDurableWorld();
      const reads: Array<{ x: number; z: number }> = [];
      const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
        observation: { ...observationPort(),
          scanWorld: async () => buildSpatialWorldModel(parseSpatialBootstrapScan(withProductRoad)),
          readAvailableRoadPrefabs: async () => catalogue,
          captureSiteDetail: async (scope) => {
            if (scope.radius >= 192) reads.push({ x: scope.x, z: scope.z });
            return { detail: siteDetail, coherence: "STABLE_FRAME", observationId: `census:${scope.x}:${scope.z}` };
          } },
        previewRoad: async () => PRODUCTIVE_PREVIEW,
        now: () => INSTANT,
      });
      // The census runs before any admission outcome, so a refusal is fine here.
      await bootstrap.ensureGoalWorkOrder({
        goalId: "EXPAND_RESIDENTIAL:residential:frontier", landUse: "RESIDENTIAL",
      }).catch(() => undefined);
      return reads;
    };

    // With the catalogue, the product's own end is an anchor the ring reads.
    const withCatalogue = await censusAnchors(["Small Road", "Medium Road"]);
    expect(withCatalogue).toEqual(expect.arrayContaining([{ x: 400, z: 0 }]));
    // Counterfactual: without it the same world reads exactly what it read
    // before this change — the map's own end, and nothing at 400 m.
    const withoutCatalogue = await censusAnchors([]);
    expect(withoutCatalogue).toEqual(expect.arrayContaining([{ x: 0, z: 0 }]));
    expect(withoutCatalogue.some((read) => read.x === 400)).toBe(false);
  });

  /**
   * An anchor with nothing to reach must not be asked a corridor question.
   *
   * The fallback chain ended `?? anchor`, so an anchor whose census held no clean
   * ground, no missing-frontage land and no target fed `from === to` to the
   * planner, which answered `ALREADY_REACHED: the target is 0.0m away, inside one
   * cell`. That is not a finding about the land — it is a fabricated corridor
   * failure, and it was the only thing two of four live ring anchors ever said.
   */
  test("an anchor with no land to open refuses by name instead of asking for a zero-length corridor", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    const allBuilt: SpatialSiteDetail["zoningCells"] = Array.from({ length: 12 }, (_, index) => ({
      ...siteDetail.zoningCells[0]!, block: { index: 74, version: 1 }, index,
      position: { x: 20, y: 0, z: index * 8 }, roadside: true,
      occupied: true, blocked: false, overridden: false, zoneCategory: "none",
    }));
    const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async () => ({
        detail: { ...siteDetail, zoningCells: allBuilt }, coherence: "STABLE_FRAME",
        observationId: "observation:all-built",
      }) },
      previewRoad: async () => PRODUCTIVE_PREVIEW,
      now: () => INSTANT,
    });

    const refusal = bootstrap.ensureGoalWorkOrder({
      goalId: "EXPAND_RESIDENTIAL:residential:no-land", landUse: "RESIDENTIAL",
    });
    await expect(refusal).rejects.toThrow(/PROJECT_ADMISSION_GROWABLE_FOOTPRINT_UNSERVICEABLE:MISSING_FRONTAGE/);
    await expect(bootstrap.ensureGoalWorkOrder({
      goalId: "EXPAND_RESIDENTIAL:residential:no-land", landUse: "RESIDENTIAL",
    })).rejects.not.toThrow(/ALREADY_REACHED|0\.0m away/);
  });

  /**
   * Only a genuinely unfronted census is a Road question. A census that already
   * carries frontage and already carries an executable footprint — but where the
   * footprint is too small, or the land is not the project's, or another Goal
   * still claims it — is not, and answering it with a Road schedules a build
   * that cannot change the finding.
   *
   * Measured live (2026-09-30) on the first two: the Brain raised a
   * `ROAD_FRONTAGE` prerequisite for a region whose four valid footprints were
   * all covered by a stale 180 m claim, the child could only die, and the next
   * tick derived the same family again — 149 work orders and a journal that
   * never moved. The premise this test replaces is that "no candidate" and "no
   * frontage" are the same sentence.
   */
  test("a growth Goal with frontage but no valid footprint refuses by name instead of demanding a Road", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    // One roadside cell carrying a three-cell strip: frontage exists, and no
    // radius the Fast Path tries reaches its six-cell band.
    const shortStrip: SpatialSiteDetail["zoningCells"] = Array.from({ length: 3 }, (_, index) => ({
      ...siteDetail.zoningCells[0]!, block: { index: 74, version: 1 }, index,
      position: { x: 20, y: 0, z: index * 8 }, roadside: index === 0,
      occupied: false, blocked: false, overridden: false, zoneCategory: "none",
    }));
    const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async () => ({
        detail: { ...siteDetail, zoningCells: shortStrip }, coherence: "STABLE_FRAME",
        observationId: "observation:short-frontage",
      }) },
      previewRoad: async () => PRODUCTIVE_PREVIEW,
      now: () => INSTANT,
    });

    const refusal = await bootstrap.ensureGoalWorkOrder({
      goalId: "EXPAND_RESIDENTIAL:residential:short-frontage", landUse: "RESIDENTIAL",
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(V2GrowableFootprintUnserviceableError);
    const subject = (refusal as V2GrowableFootprintUnserviceableError).subject;
    expect(subject.reason).toBe("FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT");
    expect(subject.evidence).toMatchObject({ frontageCells: 1, unprotectedFootprints: 0 });
    // The target is named, so the caller can park this region rather than the
    // whole family, and it is derived from the census ring the search actually
    // read — so the Mayor's own next Road changes the ring, and with it this
    // key, which is what releases the park without anyone having to remember to.
    expect(subject.subjectKey).toMatch(/^[a-f0-9]{16}$/);
    expect(subject.target.radius).toBeGreaterThanOrEqual(192);
    // Nothing durable was claimed: no work order, no prerequisite child.
    expect(durability.snapshot().goalWorkOrders ?? []).toEqual([]);
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test.each(["RESIDENTIAL", "COMMERCIAL"] as const)(
    "%s parent resumes from durable ROAD_FRONTAGE handoff through one Fast Path census",
    async (landUse) => {
      const fixture = toolsFixture();
      const ports = productionPorts(fixture);
      const { durability, activateDurableWorld } = activated(ports);
      await activateDurableWorld();
      const unfrontedCells: SpatialSiteDetail["zoningCells"] = Array.from({ length: 12 }, (_, index) => ({
        ...siteDetail.zoningCells[0]!, block: { index: 730, version: 1 }, index,
        position: { x: 20, y: 0, z: index * 8 }, roadside: false, roadLeft: false, roadRight: false,
        occupied: false, blocked: false, overridden: false, zoneCategory: "none",
      }));
      const frontedCells = unfrontedCells.map((cell, index) => ({
        ...cell, roadside: index === 0, roadLeft: index === 0,
      }));
      const fastPathRadii: number[] = [];
      let childSearchCaptures = 0;
      const bootstrap = createV2ProjectAdmissionBootstrap({ durability, activateDurableWorld,
        observation: { ...observationPort(), captureSiteDetail: async (scope) => {
          if (scope.radius >= 192) {
            fastPathRadii.push(scope.radius);
            const zoningCells = fastPathRadii.length === 1 ? unfrontedCells : frontedCells;
            return { detail: { ...siteDetail, zoningCells }, coherence: "STABLE_FRAME",
              observationId: `growable:${fastPathRadii.length}` };
          }
          childSearchCaptures += 1;
          return { detail: siteDetail, coherence: "STABLE_FRAME", observationId: `road-child:${childSearchCaptures}` };
        } },
        previewRoad: async () => PRODUCTIVE_PREVIEW,
        now: () => INSTANT,
      });
      const goalId = `EXPAND_${landUse}:facts:resume-${landUse.toLowerCase()}`;
      const prerequisite = await bootstrap.ensureGoalWorkOrder({ goalId, landUse });
      if (prerequisite.status !== "PREREQUISITE_ADMITTED") throw new Error("expected Road frontage prerequisite");
      const child = durability.goalWorkOrder(prerequisite.activeGoalId);
      if (!child) throw new Error("expected durable Road frontage child");
      expect(child).toMatchObject({ parentGoalId: goalId, parentLandUse: landUse,
        completionStage: "ROAD_DELIVERED" });

      const delivered = structuredClone(child.state);
      delivered.tranche.stage = "ROAD_DELIVERED";
      durability.saveProjectState(delivered);
      durability.recordGoalWorkOrderProgressionOutcome({ status: "MILESTONE_REACHED", state: delivered,
        reason: "Road frontage read back" });
      durability.completeGoalWorkOrder(prerequisite.activeGoalId);
      const capturesBeforeResume = childSearchCaptures;
      const resumed = await bootstrap.ensureGoalWorkOrder({ goalId, landUse: child.parentLandUse! });

      expect(resumed.status).toBe("ADMITTED");
      expect(resumed.state.districtPlan.landUse).toBe(landUse);
      // The invariant this guards is ANTI-CHURN: a parent that a delivered
      // prerequisite has just unblocked must be answered by its own Fast Path
      // census, and must NOT mint another frontage prerequisite for the same
      // Goal. That is what the 2026-09-30 "149 work orders, journal never moved"
      // measurement was about.
      //
      // It deliberately does NOT guard how many bounded ground reads a route
      // planner may spend. A frontage prerequisite whose land no frontage
      // reaches now plans its route with `planRoadCorridor` before it names a
      // hop, and that planner reads ground under its own bounded budget (24
      // reads, cached, the identical budget the water corridor runs under —
      // `water-site-constraint.ts:227-231`). Pinning the count here would pin the
      // old 28 m/64 m walk's implementation shape and forbid the long-distance
      // capability that replaces it.
      expect(fastPathRadii.length).toBeGreaterThanOrEqual(2);
      expect((durability.snapshot().goalWorkOrders ?? []).filter((order) =>
        order.parentGoalId === goalId && /prerequisite:ROAD_FRONTAGE/.test(order.goalId))).toHaveLength(1);
      // Nothing about the delivered handoff was duplicated or re-derived: the
      // child is still the one that was delivered.
      expect(durability.goalWorkOrder(prerequisite.activeGoalId)?.goalId).toBe(prerequisite.activeGoalId);
    },
  );

  test("an unclassified cell is not a zoneable cell", async () => {
    // The zoning resolver only ever takes `none`. Counting `unknown` here
    // promised an executability the next step cannot deliver.
    const { bootstrap } = await bootstrapWithCensus("unknown");
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/zoneGateRefusals/);
  });

  test("an absent census is unproven and cannot be admitted to a ZONING step", async () => {
    const { bootstrap } = await bootstrapWithCensus(null);
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN/);
  });

  test("an unreadable zoning census parks the candidate instead of admitting it", async () => {
    const fixture = toolsFixture();
    const ports = productionPorts(fixture);
    const { durability, activateDurableWorld } = activated(ports);
    await activateDurableWorld();
    const bootstrap = createV2ProjectAdmissionBootstrap({
      durability, activateDurableWorld,
      observation: { ...observationPort(), captureSiteDetail: async () => {
        throw new Error("bounded site detail unavailable");
      } },
      previewRoad: async () => PRODUCTIVE_PREVIEW,
      now: () => INSTANT,
    });
    await expect(bootstrap.admitFirstProject()).rejects.toThrow(/PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN/);
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });
});

describe("prerequisite corridor step identity", () => {
  const prerequisite = { kind: "ROAD_ACCESS" as const, targetPoint: { x: 80, z: 90 },
    completionStage: "ROAD_DELIVERED" as const, evidence: "clean source is outside current road reach" };
  const refusingConstraint: V2ProjectSiteConstraint = {
    kind: "test-domain-site",
    accepts: async () => false,
    derivePrerequisite: async () => prerequisite,
  };

  test("a prerequisite that did not deliver is not re-minted under a new identity", async () => {
    const { bootstrap, durability } = await admitWithConstraint();
    const goalId = "PROVIDE_SERVICE:water:scope:spent";
    const first = await bootstrap.ensureGoalWorkOrder({ goalId, siteConstraint: refusingConstraint });
    if (first.status !== "PREREQUISITE_ADMITTED") throw new Error(`expected a prerequisite, received ${first.status}`);
    const child = durability.goalWorkOrder(first.activeGoalId);
    if (!child) throw new Error("expected the prerequisite work order");

    // The bounded Road step ends without delivering anything: no command, no
    // milestone, envelope released.
    durability.saveProjectState(blockedRoadState(structuredClone(child.state)));
    const closed = durability.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state: blockedRoadState(structuredClone(child.state)),
      reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED",
    });
    expect(closed).toMatchObject({ status: "BLOCKED" });
    expect(typeof closed?.releasedReservationAt).toBe("string");

    // The parent is re-derived from the same facts and derives the same
    // prerequisite. That names the step that already exists, and it is over.
    await expect(bootstrap.ensureGoalWorkOrder({ goalId, siteConstraint: refusingConstraint }))
      .rejects.toThrow("GOAL_PREREQUISITE_ALREADY_SPENT:");
    // Nothing new was minted, and the closed step is still the evidence it was.
    expect(durability.snapshot().goalWorkOrders).toHaveLength(1);
    expect(durability.snapshot().activeGoalWorkOrderId).toBe(child.workOrderId);
    expect(durability.goalWorkOrder(first.activeGoalId)).toMatchObject({
      status: "BLOCKED", releasedReservationAt: closed!.releasedReservationAt,
    });
  });

  test("a prerequisite that delivered advances the corridor to its next step", async () => {
    const { bootstrap, durability } = await admitWithConstraint();
    const goalId = "PROVIDE_SERVICE:water:scope:corridor";
    const first = await bootstrap.ensureGoalWorkOrder({ goalId, siteConstraint: refusingConstraint });
    if (first.status !== "PREREQUISITE_ADMITTED") throw new Error("expected a prerequisite");
    const child = durability.goalWorkOrder(first.activeGoalId);
    if (!child) throw new Error("expected the prerequisite work order");

    // This bounded step DID deliver: its tranche reached the milestone it was
    // admitted for and the Brain closed it out, which is what makes the corridor
    // longer rather than spent.
    const delivered = structuredClone(child.state);
    delivered.tranche.stage = "ROAD_DELIVERED";
    durability.saveProjectState(delivered);
    durability.recordGoalWorkOrderProgressionOutcome({
      status: "MILESTONE_REACHED", state: delivered, reason: "corridor step delivered",
    });
    expect(durability.completeGoalWorkOrder(first.activeGoalId).status).toBe("COMPLETE");

    const second = await bootstrap.ensureGoalWorkOrder({ goalId, siteConstraint: refusingConstraint });
    if (second.status !== "PREREQUISITE_ADMITTED") throw new Error("expected the next corridor step");
    expect(second.activeGoalId).not.toBe(first.activeGoalId);
    expect(second.activeGoalId).toContain(":prerequisite:ROAD_ACCESS:2:");
    // The delivered step keeps its record, and stops holding land: the road it
    // built is world state, not an authorization, and the corridor continues
    // through it under the same Goal family.
    const deliveredRecord = durability.goalWorkOrder(first.activeGoalId);
    expect(deliveredRecord).toMatchObject({ goalId: first.activeGoalId, status: "COMPLETE" });
    expect(deliveredRecord?.releasedReservationAt ?? null).toBeNull();
    expect(durability.isGoalWorkOrderReservationProtected(child.workOrderId)).toBe(false);
    expect(durability.snapshot().goalWorkOrders).toHaveLength(2);
  });
});

/**
 * A Goal is identified by the facts it was requested from, so asking for it
 * again from unchanged facts names the work order that already exists. When that
 * work order has closed — its milestone reached, or its bounded chain run out —
 * the answer is a successor that inherits the Goal and nothing else. Re-asking
 * is not a resurrection (the released land may already be claimed), and it is
 * not a reason for the city to stop growing either.
 */
describe("Goal successor work orders", () => {
  const lookupRecord = (status: string, goalId = "goal:a", released: string | null = null) =>
    ({ goalId, workOrderId: `goal-work-order:${goalId}`, status, releasedReservationAt: released }) as never;

  test("a live work order is named as itself", () => {
    for (const status of ["ACTIVE", "SUSPENDED", "RECONCILING"]) {
      const records = new Map([["goal:a", lookupRecord(status)]]);
      expect(resolveGoalWorkOrderId((id) => records.get(id) ?? null, "goal:a")).toBe("goal:a");
    }
  });

  test("an unknown Goal is named as itself", () => {
    expect(resolveGoalWorkOrderId(() => null, "goal:new")).toBe("goal:new");
  });

  test("a closed work order yields a successor derived from it, stably", () => {
    const closed = lookupRecord("BLOCKED", "goal:a", "2026-01-01T00:00:00.000Z");
    const records = new Map([["goal:a", closed]]);
    const look = (id: string) => records.get(id) ?? null;

    const successor = resolveGoalWorkOrderId(look, "goal:a");
    expect(successor).toBe(deriveGoalSuccessorGoalId("goal:a", closed.workOrderId));
    // Deterministic: the same closure always yields the same successor, so a
    // repeated call resumes the same attempt instead of stacking new ones.
    expect(resolveGoalWorkOrderId(look, "goal:a")).toBe(successor);
    // And short: an attempt names itself, not the whole chain before it.
    expect(successor.length).toBeLessThan(48);

    // Once that successor is live, the walk stops at it rather than chaining on.
    records.set(successor, lookupRecord("ACTIVE", successor));
    expect(resolveGoalWorkOrderId(look, "goal:a")).toBe(successor);
  });

  test("a completed work order is closed too, and the chain follows each closure", () => {
    const first = lookupRecord("COMPLETE", "goal:a");
    const secondGoalId = deriveGoalSuccessorGoalId("goal:a", first.workOrderId);
    const second = lookupRecord("BLOCKED", secondGoalId, "2026-01-02T00:00:00.000Z");
    const records = new Map([[first.goalId, first], [second.goalId, second]]);
    const successor = resolveGoalWorkOrderId((id) => records.get(id) ?? null, "goal:a");
    expect(successor).toBe(deriveGoalSuccessorGoalId("goal:a", second.workOrderId));
  });

  test("a released but still active-shaped record is closed", () => {
    const released = lookupRecord("SUSPENDED", "legacy:intent:x");
    expect(resolveGoalWorkOrderId((id) => (id === "legacy:intent:x" ? released : null), "legacy:intent:x"))
      .toBe(deriveGoalSuccessorGoalId("legacy:intent:x", released.workOrderId));
  });

  test("a closure that proved its Road target undeliverable refuses instead of minting", () => {
    // The walk exists to continue a plan that FINISHED. A work order refused at
    // the native road boundary is the opposite finding: the same Goal from the
    // same facts can only reproduce it, so the walk must not spend a work order
    // on a question the search already answered.
    //
    // Measured live (2026-10-01): `PROVIDE_SERVICE:electricity:facts:f18115fceac9`
    // minted eight such successors before its budget ran out.
    const record = {
      goalId: "PROVIDE_SERVICE:electricity:facts:f18115fceac9",
      workOrderId: "goal-work-order:PROVIDE_SERVICE:electricity:facts:f18115fceac9",
      status: "BLOCKED",
      releasedReservationAt: "2026-10-01T00:00:00.000Z",
      state: {
        journal: [{
          taskId: "t",
          skill: "WaitObserve",
          failureClassification: "ROAD_PREFLIGHT_REJECTED",
          reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:75948:215:end:NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED|77160",
        }],
      },
    };
    expect(() => resolveGoalWorkOrderId((id) => (id === record.goalId ? record : null), record.goalId))
      .toThrow("GOAL_SUCCESSOR_UNSERVABLE_ROAD_TARGET");
  });

  test("a closure with no Road finding still yields a successor", () => {
    // The refusal stays specific: a work order whose journal records no Road
    // finding is a plan that finished, and the walk continues it.
    const record = {
      goalId: "goal:b",
      workOrderId: "goal-work-order:goal:b",
      status: "BLOCKED",
      releasedReservationAt: null,
      state: { journal: [{ taskId: "t", failureClassification: "NONE", reason: "slot observed empty" }] },
    };
    expect(resolveGoalWorkOrderId((id) => (id === record.goalId ? record : null), record.goalId))
      .toBe(deriveGoalSuccessorGoalId("goal:b", record.workOrderId));
  });

  test("the chain budget is bounded per Goal root, not per call", () => {
    // A family of exactly the budget, walked from the root, is exhausted — and
    // stays exhausted however many times it is asked, which is what stops a
    // Goal whose facts never change from minting a new attempt every cycle.
    const records = new Map<string, unknown>();
    let goalId: string = "goal:a";
    for (let level = 0; level <= MAXIMUM_GOAL_SUCCESSOR_STEPS; level += 1) {
      const record = lookupRecord("BLOCKED", goalId, "2026-01-01T00:00:00.000Z");
      records.set(goalId, record);
      goalId = deriveGoalSuccessorGoalId("goal:a", (record as { workOrderId: string }).workOrderId);
    }
    expect(() => resolveGoalWorkOrderId((id) => (records.get(id) ?? null) as never, "goal:a"))
      .toThrow(`GOAL_SUCCESSOR_BUDGET_EXHAUSTED:goal:a`);
    expect(() => resolveGoalWorkOrderId((id) => (records.get(id) ?? null) as never, "goal:a"))
      .toThrow(`GOAL_SUCCESSOR_BUDGET_EXHAUSTED:goal:a`);
    // And no id in the family names the chain before it.
    expect([...records.keys()].every((id) => id.length < 48)).toBe(true);
  });

  test("a Goal with a closed work order is re-admitted at a fresh site with its own reservation", async () => {
    const { bootstrap, durability } = await admitWithConstraint();
    const requestedGoalId = "EXPAND_RESIDENTIAL:residential:facts:fp-1";
    const first = await bootstrap.ensureGoalWorkOrder({ goalId: requestedGoalId });
    const firstRecord = durability.goalWorkOrder(requestedGoalId);
    if (!firstRecord) throw new Error("expected an admitted work order");

    durability.saveProjectState(blockedZoningState(structuredClone(firstRecord.state)));
    const closed = durability.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state: blockedZoningState(structuredClone(firstRecord.state)),
      reason: "GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
    });
    expect(closed).toMatchObject({ status: "BLOCKED" });
    expect(typeof closed?.releasedReservationAt).toBe("string");
    // Why it closed is durable in the work order's own record, not only in this
    // call's arguments.
    expect(closed?.state.journal.at(-1)?.reason).toBe("GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET");
    // The land is free again, so a successor may claim it.
    expect(durability.isGoalWorkOrderReservationProtected(closed!.workOrderId)).toBe(false);

    const successor = await bootstrap.ensureGoalWorkOrder({ goalId: requestedGoalId });
    expect(successor.status).toBe("ADMITTED");
    expect(successor.state.project.id).not.toBe(first.state.project.id);
    expect(successor.state.tranche.id).not.toBe(first.state.tranche.id);
    expect(successor.state.tranche.reservationRef).not.toBe(first.state.tranche.reservationRef);
    expect(successor.state.tranche.stage).toBe("PLANNED");
    expect(successor.state.project.utilityReservation.radius).toBeGreaterThan(0);

    // The closed work order keeps everything that actually happened to it.
    const retained = durability.goalWorkOrder(requestedGoalId);
    expect(retained).toMatchObject({
      status: "BLOCKED",
      workOrderId: closed!.workOrderId,
      releasedReservationAt: closed!.releasedReservationAt,
    });
    expect(retained?.state.project.id).toBe(first.state.project.id);
    expect(retained?.state.tranche.reservationRef).toBe(first.state.tranche.reservationRef);

    // Re-asking resumes the successor instead of minting another one.
    const again = await bootstrap.ensureGoalWorkOrder({ goalId: requestedGoalId });
    expect(again.status).toBe("ALREADY_ADMITTED");
    expect(again.state.project.id).toBe(successor.state.project.id);
    expect(durability.snapshot().goalWorkOrders).toHaveLength(2);
    expect(bootstrap.activeGoalWorkOrder()?.state.project.id).toBe(successor.state.project.id);

    // And the successor's own closure chains one step further, from ITS identity.
    const successorRecord = durability.snapshot().goalWorkOrders?.find(
      (item) => item.projectId === successor.state.project.id,
    );
    if (!successorRecord) throw new Error("expected the successor work order");
    durability.saveProjectState(blockedZoningState(structuredClone(successor.state)));
    const closedAgain = durability.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state: blockedZoningState(structuredClone(successor.state)),
      reason: "GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
    });
    const third = await bootstrap.ensureGoalWorkOrder({ goalId: requestedGoalId });
    expect(third.state.project.id).not.toBe(successor.state.project.id);
    expect(durability.snapshot().goalWorkOrders).toHaveLength(3);
    // The chain is a path through terminal outcomes: the third attempt descends
    // from the second, so no terminal record is ever overwritten and no identity
    // is reused.
    const thirdRecord = durability.snapshot().goalWorkOrders?.find(
      (item) => item.projectId === third.state.project.id,
    );
    // Every attempt in the family is named against the ROOT and the attempt it
    // replaces, so the ids stay one short name each however long the family gets.
    expect(thirdRecord?.goalId).toBe(deriveGoalSuccessorGoalId(requestedGoalId, successorRecord.workOrderId));
    expect(closedAgain?.workOrderId).toBe(successorRecord.workOrderId);
    expect(durability.goalWorkOrder(successorRecord.goalId)).toMatchObject({
      workOrderId: successorRecord.workOrderId,
      status: "BLOCKED",
      state: expect.objectContaining({ project: expect.objectContaining({ id: successor.state.project.id }) }),
    });
  });
});
