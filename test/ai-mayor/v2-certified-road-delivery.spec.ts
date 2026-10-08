import { certifyDeliveredRoad } from "../../src/main/services/ai-mayor/v2/certified-road-delivery";
import {
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
  V2DurabilityCoordinator,
  type V2DurableStateStorage,
} from "../../src/main/services/ai-mayor/v2/durability";
import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import { createMemoryCommandJournal, type V2CommandRecord } from "../../src/main/services/ai-mayor/v2/foundation";
import { type Gate1State, planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";

/**
 * The delivered road is a durable fact, not something recomputed here.
 *
 * Every case below runs a real `V2DurabilityCoordinator` over real durable
 * state, so the lineage gate is exercised as a checkpoint state machine: a
 * normal periodic save must not revoke certified road authority, while a
 * rollback, a sibling save, another world, or unprovable lineage must.
 */

const WORLD_SESSION = "cd0d8ea80e624df4abd692fc89df5cc4";
const OTHER_SESSION = "ffffffffffffffffffffffffffffffff";
const SAVE_A = "save:load-asset-a:save-data-a";
const SAVE_B = "save:load-asset-b:save-data-b";
const PERIODIC_0 = "save:periodic-0:periodic-0-data";
const PERIODIC_1 = "save:periodic-1:periodic-1-data";
const PERIODIC_2 = "save:periodic-2:periodic-2-data";
const GENERATION_1 = "generation-1";
const GENERATION_2 = "generation-2";
const COMMAND_ID = "road-command-1";
const SECOND_COMMAND_ID = "road-command-2";
const ROAD = { prefab: "Medium Road", x1: -541.6216, z1: -47.279007, x2: -543.18, z2: -22.33 };
const SECOND_ROAD = { prefab: "Medium Road", x1: -543.18, z1: -22.33, x2: -545.0, z2: -10.0 };
const MATCHED_EDGE = { index: 177757, version: 15 };
const OTHER_EDGE = { index: 177758, version: 1 };

/** Raw `cs2_game_state` payload as `parseNativeWorldIdentity` reads it. */
function rawWorld(checkpointId: string | null, generation: string, session = WORLD_SESSION) {
  const parts = checkpointId?.split(":") ?? [];
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${session}`,
      nativeSessionGuid: session,
      worldReady: true,
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
      loadPurpose: "LoadGame",
      loadAssetGuid: parts[1] ?? null,
      saveDataAssetGuid: parts[2] ?? null,
      mapAssetGuid: "map-a",
      checkpointId,
      bridgeRuntimeEpoch: `bridge-${generation}`,
      generation,
      generationSequence: 1,
      generationOrigin: "LOAD_COMPLETED",
    },
  };
}

function deliveredState(): Gate1State {
  const state = planStarterResidentialIntent({
    intentId: "intent:gate1-starter:test",
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: -541, z: -30 }, radius: 180 },
    siteCandidates: [{ id: "site-1", target: { center: { x: -541, z: -30 }, radius: 32 }, score: 1, blocked: false }],
  });
  state.tranche.stage = "ROAD_DELIVERED";
  const road = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
  road.status = "SUCCEEDED";
  road.attempts = 1;
  road.terminalOutcomeId = "road-outcome-1";
  state.journal.push({
    id: "road-outcome-1",
    taskId: road.id,
    skill: "RoadConnection",
    proposalId: "road-proposal-1",
    admission: "ADMITTED",
    execution: "DELIVERED",
    commandId: COMMAND_ID,
    observationId: "observation-1",
    observedEffect: "NOT_APPLICABLE",
    failureClassification: "NONE",
    recordedAt: "2026-09-21T00:00:00.000Z",
    reason: "authoritative permanent topology contains 1 connected Medium Road effect match(es)",
  });
  return state;
}

function roadCommand(ownerId: string, overrides: Partial<V2CommandRecord> = {}): V2CommandRecord {
  const geometry = overrides.commandId === SECOND_COMMAND_ID ? SECOND_ROAD : ROAD;
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: COMMAND_ID,
    actionFamily: "ROAD",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId },
      actionFamily: "ROAD",
      proposalId: "road-proposal-1",
      quoteId: "road-quote-1",
      fingerprint: stableRoadInput(geometry),
      exactInput: stableRoadInput(geometry),
      budget: { authorizedMaxSpend: 243.54, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
      observationPrecondition: { runtimeEpoch: "bridge:10", frame: 10 },
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    createdAt: "2026-09-21T00:00:00.000Z",
    submittedAt: "2026-09-21T00:00:01.000Z",
    nativeResultSummary: null,
    status: "OBSERVED_MATCH",
    statusHistory: [],
    reconciliationStatus: "MATCH",
    observationEvidence: [
      {
        phase: "RECONCILIATION",
        observationId: "observation-1",
        coherence: "STABLE_FRAME",
        recordedAt: "2026-09-21T00:00:02.000Z",
        summary: "authoritative permanent topology contains 1 connected Medium Road effect match(es)",
        details: {
          matcherResult: "MATCH",
          effectAbsenceProven: false,
          matchedEdges: [MATCHED_EDGE],
          reason: "authoritative permanent topology contains 1 connected Medium Road effect match(es)",
          observedEnvelope: {
            observationId: "observation-1",
            runtimeEpoch: "bridge:10",
            coherence: "STABLE_FRAME",
            worldGeneration: GENERATION_1,
          },
        },
      },
    ],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
    ...overrides,
  };
}

const activate = (
  coordinator: V2DurabilityCoordinator,
  checkpointId: string | null,
  generation: string,
  session?: string,
) => coordinator.activate(rawWorld(checkpointId, generation, session));

/** Record one delivered ROAD command the way the ROAD kernel does. */
function recordDeliveredRoad(
  coordinator: V2DurabilityCoordinator,
  ownerId: string,
  overrides: Partial<V2CommandRecord> = {},
): void {
  coordinator.commandJournal.create(roadCommand(ownerId, overrides));
}

/**
 * A normal native save: `recordCheckpoint` marks the record `PERIODIC` and
 * advances the active rollback boundary to it.
 */
function periodicSave(
  coordinator: V2DurabilityCoordinator,
  world: { worldId: string; generation: string; nativeSessionGuid: string },
  checkpointId: string,
  journalPosition: number,
): void {
  const receipt: SaveCompletionReceipt = {
    status: "COMPLETED",
    durable: true,
    worldId: world.worldId,
    worldGeneration: world.generation,
    checkpoint: {
      checkpointId,
      saveMetadataAssetGuid: `meta:${checkpointId}`,
      saveDataAssetGuid: `data:${checkpointId}`,
      nativeSessionGuid: world.nativeSessionGuid,
    },
  };
  coordinator.recordCheckpoint(receipt, journalPosition);
}

/** A restarted coordinator over the same durable storage. */
const restart = (storage: V2DurableStateStorage) => new V2DurabilityCoordinator(storage);

/** The parsed identity the durable coordinator derives from `rawWorld`. */
function worldIdentity(checkpointId = SAVE_A, generation = GENERATION_1, session = WORLD_SESSION) {
  const parts = checkpointId.split(":");
  return {
    worldId: `cs2-session:${session}`,
    nativeSessionGuid: session,
    loadPurpose: "LoadGame" as const,
    loadAssetGuid: parts[1] ?? null,
    saveDataAssetGuid: parts[2] ?? null,
    mapAssetGuid: "map-a",
    checkpointId,
    bridgeRuntimeEpoch: `bridge-${generation}`,
    generation,
    generationSequence: 1,
    generationOrigin: "LOAD_COMPLETED",
    worldEpochId: `cs2-session:${session}:generation:${generation}`,
    worldReady: true as const,
  };
}

/** A coordinator with one world loaded, one delivered ROAD command, and access to its task id. */
function deliveredHarness() {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  const activation = activate(coordinator, SAVE_A, GENERATION_1);
  const state = deliveredState();
  const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
  recordDeliveredRoad(coordinator, roadTask.id);
  return { storage, coordinator, activation, state, roadTask };
}

describe("certified delivered road from durable ROAD evidence", () => {
  describe("the active durable lineage still contains the ROAD command", () => {
    test("keeps the last delivered road certified while a utility road child is pending", () => {
      const h = deliveredHarness();
      const utilityTask = {
        ...h.roadTask,
        id: "utility-road-child",
        status: "PENDING" as const,
        attempts: 0,
        terminalOutcomeId: null,
        utilityRoadParentTaskId: h.roadTask.id,
        utilityRoadPlanRevision: "plan-revision-1",
      };
      h.state.tasks.push(utilityTask);
      h.state.tranche.currentTaskIds = { ...h.state.tranche.currentTaskIds, ROAD_CONNECTION: utilityTask.id };

      expect(certifyDeliveredRoad({ state: h.state, world: h.activation.world, journal: h.coordinator.commandJournal }))
        .toMatchObject({ status: "CERTIFIED", commandId: COMMAND_ID, refs: [MATCHED_EDGE] });
    });

    test("walks past a failed utility-road child to the nearest delivered ancestor", () => {
      const h = deliveredHarness();
      const failedParent = {
        ...h.roadTask,
        id: "failed-utility-road-parent",
        status: "FAILED" as const,
        attempts: 1,
        terminalOutcomeId: "failed-utility-road-parent-outcome",
        utilityRoadParentTaskId: h.roadTask.id,
        utilityRoadPlanRevision: "plan-revision-1",
      };
      const failedCurrent = {
        ...h.roadTask,
        id: "failed-utility-road-current",
        status: "FAILED" as const,
        attempts: 1,
        terminalOutcomeId: "failed-utility-road-current-outcome",
        utilityRoadParentTaskId: failedParent.id,
        utilityRoadPlanRevision: "plan-revision-2",
      };
      h.state.tasks.push(failedParent, failedCurrent);
      h.state.tranche.currentTaskIds = { ...h.state.tranche.currentTaskIds, ROAD_CONNECTION: failedCurrent.id };

      expect(certifyDeliveredRoad({ state: h.state, world: h.activation.world, journal: h.coordinator.commandJournal }))
        .toMatchObject({ status: "CERTIFIED", commandId: COMMAND_ID, refs: [MATCHED_EDGE] });
    });

    test("keeps the tranche access road as authority after a utility-road child is delivered", () => {
      const h = deliveredHarness();
      const utilityTask = {
        ...h.roadTask,
        id: "delivered-utility-road-child",
        status: "SUCCEEDED" as const,
        attempts: 1,
        terminalOutcomeId: "delivered-utility-road-child-outcome",
        utilityRoadParentTaskId: h.roadTask.id,
        utilityRoadPlanRevision: "plan-revision-1",
      };
      h.state.tasks.push(utilityTask);
      h.state.tranche.currentTaskIds = { ...h.state.tranche.currentTaskIds, ROAD_CONNECTION: utilityTask.id };

      expect(certifyDeliveredRoad({ state: h.state, world: h.activation.world, journal: h.coordinator.commandJournal }))
        .toMatchObject({ status: "CERTIFIED", commandId: COMMAND_ID, refs: [MATCHED_EDGE] });
    });

    test("1. the active checkpoint is unchanged", () => {
      const h = deliveredHarness();
      const result = certifyDeliveredRoad({
        state: h.state,
        world: h.activation.world,
        journal: h.coordinator.commandJournal,
      });

      expect(result).toMatchObject({
        status: "CERTIFIED",
        commandId: COMMAND_ID,
        refs: [MATCHED_EDGE],
        lineage: {
          worldId: `cs2-session:${WORLD_SESSION}`,
          baseCheckpointId: SAVE_A,
          position: 1,
          boundaryCheckpointId: SAVE_A,
          proof: "LIVE_ON_RECORDED_CHECKPOINT",
        },
      });
    });

    test("2. a periodic save produces a descendant checkpoint", () => {
      const h = deliveredHarness();
      periodicSave(h.coordinator, h.activation.world, PERIODIC_1, 1);

      const result = certifyDeliveredRoad({
        state: h.state,
        world: h.activation.world,
        journal: h.coordinator.commandJournal,
      });

      expect(result.status).toBe("CERTIFIED");
      expect(result.status === "CERTIFIED" ? result.lineage : null).toMatchObject({
        baseCheckpointId: SAVE_A,
        boundaryCheckpointId: PERIODIC_1,
        proof: "CERTIFIED_CHECKPOINT_CONTAINS_COMMAND",
      });
      // The evidence still came from the command, not from a re-scan.
      expect(result.status === "CERTIFIED" ? result.refs : []).toEqual([MATCHED_EDGE]);
    });

    test("3. several consecutive periodic descendant saves", () => {
      const h = deliveredHarness();
      periodicSave(h.coordinator, h.activation.world, PERIODIC_1, 1);
      recordDeliveredRoad(h.coordinator, h.roadTask.id, { commandId: SECOND_COMMAND_ID });
      periodicSave(h.coordinator, h.activation.world, PERIODIC_2, 2);

      const result = certifyDeliveredRoad({
        state: h.state,
        world: h.activation.world,
        journal: h.coordinator.commandJournal,
      });

      expect(result.status).toBe("CERTIFIED");
      expect(result.status === "CERTIFIED" ? result.lineage.boundaryCheckpointId : null).toBe(PERIODIC_2);
      expect(result.status === "CERTIFIED" ? result.lineage.position : null).toBe(1);
    });

    test("4. restart onto the latest descendant save", () => {
      const h = deliveredHarness();
      periodicSave(h.coordinator, h.activation.world, PERIODIC_1, 1);
      recordDeliveredRoad(h.coordinator, h.roadTask.id, { commandId: SECOND_COMMAND_ID });
      periodicSave(h.coordinator, h.activation.world, PERIODIC_2, 2);

      const after = restart(h.storage);
      const activation = activate(after, PERIODIC_2, GENERATION_2);
      expect(activation.blockedReason).toBeNull();

      const result = certifyDeliveredRoad({ state: h.state, world: activation.world, journal: after.commandJournal });

      expect(result.status).toBe("CERTIFIED");
      expect(result.status === "CERTIFIED" ? result.lineage.boundaryCheckpointId : null).toBe(PERIODIC_2);
    });
  });

  describe("the active durable lineage no longer contains the ROAD command", () => {
    test("5. rollback onto a checkpoint that predates the ROAD command", () => {
      // A save is taken first, the road is built on top of it, and the world is
      // then reloaded onto a checkpoint that is neither the one the command was
      // recorded against nor one that contains it.
      const storage = createMemoryDurableStateStorage();
      const coordinator = new V2DurabilityCoordinator(storage);
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      periodicSave(coordinator, activation.world, PERIODIC_0, 0);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      recordDeliveredRoad(coordinator, roadTask.id);
      expect(coordinator.snapshot().active?.rollbackBoundaryId).toBe(PERIODIC_0);

      const after = restart(storage);
      const rolledBack = activate(after, SAVE_A, GENERATION_2);
      expect(rolledBack.blockedReason).toBeNull();
      expect(after.snapshot().active?.rollbackBoundaryId).toBe(SAVE_A);

      const result = certifyDeliveredRoad({ state, world: rolledBack.world, journal: after.commandJournal });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_DURABLE_COMMAND_MISSING" });
    });

    test("6. a sibling save of the same world re-baselines rather than quarantining", () => {
      const h = deliveredHarness();

      const after = restart(h.storage);
      const activation = activate(after, SAVE_B, GENERATION_2);
      // A save this store never registered, in a world whose durable journal
      // rests entirely on checkpoints of this very native world, is a descendant
      // *candidate* — not lineage. "The world looks like ours" proves nothing,
      // but the loaded world is now the authority: the save re-baselines the
      // store on itself at the current journal cut instead of quarantining the
      // inherited lineage until every effect is re-proven. The rejected
      // `confirmDescendantSaveReload` / `DESCENDANT_CONFIRMATION_REQUIRED`
      // quarantine is what this case used to pin.
      expect(activation.kind).toBe("DESCENDANT_SAVE_RELOAD");
      expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
      expect(activation.blockedReason).toBeNull();
      expect(after.projectState()).toMatchObject({ status: "PLACEHOLDER" });

      const result = certifyDeliveredRoad({ state: h.state, world: activation.world, journal: after.commandJournal });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_COMMAND_NOT_IN_CURRENT_DURABLE_LINEAGE" });
    });

    test("7. a save lineage belonging to another world in the same store", () => {
      const h = deliveredHarness();

      const after = restart(h.storage);
      const activation = activate(after, null, GENERATION_2, OTHER_SESSION);
      expect(activation.world.worldId).not.toBe(h.activation.world.worldId);

      const result = certifyDeliveredRoad({ state: h.state, world: activation.world, journal: after.commandJournal });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_COMMAND_NOT_IN_CURRENT_DURABLE_LINEAGE" });
    });

    test("8. a different world identity", () => {
      const h = deliveredHarness();
      const elsewhere = { ...h.activation.world, worldId: "cs2-session:another-world" };

      const result = certifyDeliveredRoad({ state: h.state, world: elsewhere, journal: h.coordinator.commandJournal });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_COMMAND_DURABLE_WORLD_MISMATCH" });
    });

    test("9. no durable checkpoint lineage at all", () => {
      const h = deliveredHarness();
      const after = restart(h.storage);
      const activation = after.activate(rawWorld(null, GENERATION_2));
      expect(after.snapshot().active?.rollbackBoundaryId).toBe(`unsaved:${activation.world.worldId}`);

      const result = certifyDeliveredRoad({ state: h.state, world: activation.world, journal: after.commandJournal });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_COMMAND_NOT_IN_CURRENT_DURABLE_LINEAGE" });
    });

    test("10. ancestry holds but the existing rollback classification proves the command was revoked", () => {
      const h = deliveredHarness();
      // The command's own base checkpoint is the active boundary, but the world
      // was reloaded onto it in a new generation: the save predates the build.
      const after = restart(h.storage);
      const activation = activate(after, SAVE_A, GENERATION_2);
      expect(after.snapshot().active?.rollbackBoundaryId).toBe(SAVE_A);

      expect(after.snapshot().commands.find((candidate) => candidate.record.commandId === COMMAND_ID)).toBeUndefined();

      const result = certifyDeliveredRoad({ state: h.state, world: activation.world, journal: after.commandJournal });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_DURABLE_COMMAND_MISSING" });
    });
  });

  describe("owner binding", () => {
    test("fails closed when the command owner is not the current ROAD_CONNECTION task", () => {
      const h = deliveredHarness();
      const foreign = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      activate(foreign, SAVE_A, GENERATION_1);
      recordDeliveredRoad(foreign, "some-other-task");

      const result = certifyDeliveredRoad({
        state: h.state,
        world: h.activation.world,
        journal: foreign.commandJournal,
      });
      expect(result).toEqual({ status: "UNAVAILABLE", reason: "ROAD_COMMAND_OWNER_TASK_MISMATCH" });
    });

    test("fails closed for a non-TASK owner", () => {
      const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      const command = roadCommand(roadTask.id);
      (command.authorizedScope as { owner: unknown }).owner = { ownerType: "PROJECT", ownerId: roadTask.id };
      coordinator.commandJournal.create(command);

      expect(certifyDeliveredRoad({ state, world: activation.world, journal: coordinator.commandJournal })).toEqual({
        status: "UNAVAILABLE",
        reason: "ROAD_COMMAND_OWNER_TYPE_MISMATCH",
      });
    });

    test("fails closed for a missing owner", () => {
      // A record with no owner cannot be created through the durable coordinator
      // (its idempotency key needs one), so it is read from a plain journal.
      const journal = createMemoryCommandJournal();
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      const command = roadCommand(roadTask.id);
      (command.authorizedScope as { owner: unknown }).owner = null;
      journal.create(command);

      expect(certifyDeliveredRoad({ state, world: worldIdentity(), journal })).toEqual({
        status: "UNAVAILABLE",
        reason: "ROAD_COMMAND_OWNER_MISSING",
      });
    });
  });

  describe("evidence and identity", () => {
    test("rejects a ROAD_CONNECTION task that belongs to another tranche", () => {
      const h = deliveredHarness();
      h.roadTask.trancheId = "other-tranche";
      expect(
        certifyDeliveredRoad({ state: h.state, world: h.activation.world, journal: h.coordinator.commandJournal }),
      ).toEqual({ status: "UNAVAILABLE", reason: "ROAD_CONNECTION_LINEAGE_MISMATCH" });
    });

    test("rejects a command that is not the terminal outcome's own command", () => {
      const h = deliveredHarness();
      const other = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      activate(other, SAVE_A, GENERATION_1);
      recordDeliveredRoad(other, h.roadTask.id, { commandId: "unrelated-command" });

      expect(
        certifyDeliveredRoad({ state: h.state, world: h.activation.world, journal: other.commandJournal }),
      ).toEqual({ status: "UNAVAILABLE", reason: "ROAD_DURABLE_COMMAND_MISSING" });
    });

    test("fails closed on an empty matched-edge set", () => {
      const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      const command = roadCommand(roadTask.id);
      (command.observationEvidence[0].details as { matchedEdges: unknown[] }).matchedEdges = [];
      coordinator.commandJournal.create(command);

      expect(certifyDeliveredRoad({ state, world: activation.world, journal: coordinator.commandJournal })).toEqual({
        status: "UNAVAILABLE",
        reason: "ROAD_RECONCILIATION_MATCHED_EDGES_EMPTY",
      });
    });

    test("refuses to choose between several matched edges", () => {
      const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      const command = roadCommand(roadTask.id);
      (command.observationEvidence[0].details as { matchedEdges: unknown[] }).matchedEdges = [MATCHED_EDGE, OTHER_EDGE];
      coordinator.commandJournal.create(command);

      expect(certifyDeliveredRoad({ state, world: activation.world, journal: coordinator.commandJournal })).toEqual({
        status: "UNAVAILABLE",
        reason: "ROAD_RECONCILIATION_MATCHED_EDGE_AMBIGUOUS",
      });
    });

    test("ignores PRE_SUBMIT evidence and reads only the reconciliation record", () => {
      const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      const command = roadCommand(roadTask.id);
      command.observationEvidence = [
        {
          phase: "PRE_SUBMIT",
          observationId: "pre-submit",
          coherence: "STABLE_FRAME",
          recordedAt: "2026-09-21T00:00:00.500Z",
          summary: "decoy",
          details: {
            matcherResult: "MATCH",
            matchedEdges: [OTHER_EDGE],
            observedEnvelope: { worldGeneration: GENERATION_1 },
          },
        },
        ...command.observationEvidence,
      ];
      coordinator.commandJournal.create(command);

      const result = certifyDeliveredRoad({ state, world: activation.world, journal: coordinator.commandJournal });
      expect(result.status).toBe("CERTIFIED");
      expect(result.status === "CERTIFIED" ? result.refs : []).toEqual([MATCHED_EDGE]);
    });

    test.each([
      [
        "no ROAD_CONNECTION task",
        (state: Gate1State) => {
          state.tasks = state.tasks.filter((task) => task.kind !== "ROAD_CONNECTION");
        },
        "ROAD_CONNECTION_TASK_NOT_FOUND",
      ],
      [
        "task not SUCCEEDED",
        (state: Gate1State) => {
          state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.status = "WAITING";
        },
        "ROAD_CONNECTION_TASK_NOT_SUCCEEDED",
      ],
      [
        "no terminal outcome",
        (state: Gate1State) => {
          state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.terminalOutcomeId = null;
        },
        "ROAD_TERMINAL_OUTCOME_MISSING",
      ],
      [
        "outcome missing from journal",
        (state: Gate1State) => {
          state.journal = [];
        },
        "ROAD_TERMINAL_OUTCOME_NOT_IN_JOURNAL",
      ],
      [
        "outcome belongs to another task",
        (state: Gate1State) => {
          state.journal[0].taskId = "other-task";
        },
        "ROAD_TERMINAL_OUTCOME_TASK_MISMATCH",
      ],
      [
        "outcome is not DELIVERED",
        (state: Gate1State) => {
          state.journal[0].execution = "REJECTED";
          state.journal[0].commandId = null;
        },
        "ROAD_TERMINAL_OUTCOME_NOT_DELIVERED",
      ],
      [
        "outcome has no command id",
        (state: Gate1State) => {
          state.journal[0].commandId = null;
        },
        "ROAD_TERMINAL_OUTCOME_COMMAND_MISSING",
      ],
    ])("fails closed when %s", (_name, mutate, reason) => {
      const h = deliveredHarness();
      mutate(h.state);

      expect(
        certifyDeliveredRoad({ state: h.state, world: h.activation.world, journal: h.coordinator.commandJournal }),
      ).toEqual({ status: "UNAVAILABLE", reason });
    });

    test.each([
      ["command is not ROAD", { actionFamily: "ZONING" }, "ROAD_DURABLE_COMMAND_NOT_ROAD"],
      [
        "command is not a certified match",
        { status: "NATIVE_COMPLETED", reconciliationStatus: "NOT_STARTED" },
        "ROAD_DURABLE_COMMAND_NOT_CERTIFIED_MATCH",
      ],
      [
        "command reconciliation is inconclusive",
        { reconciliationStatus: "INCONCLUSIVE" },
        "ROAD_DURABLE_COMMAND_NOT_CERTIFIED_MATCH",
      ],
      ["no reconciliation evidence", { observationEvidence: [] }, "ROAD_RECONCILIATION_EVIDENCE_MISSING"],
    ])("fails closed when the %s", (_name, overrides, reason) => {
      const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      coordinator.commandJournal.create(roadCommand(roadTask.id, overrides));

      expect(certifyDeliveredRoad({ state, world: activation.world, journal: coordinator.commandJournal })).toEqual({
        status: "UNAVAILABLE",
        reason,
      });
    });

    test("fails closed when the authorized ROAD input is malformed", () => {
      const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
      const activation = activate(coordinator, SAVE_A, GENERATION_1);
      const state = deliveredState();
      const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
      const command = roadCommand(roadTask.id);
      (command.authorizedScope as { exactInput: string }).exactInput = "{not json";
      coordinator.commandJournal.create(command);

      expect(certifyDeliveredRoad({ state, world: activation.world, journal: coordinator.commandJournal })).toEqual({
        status: "UNAVAILABLE",
        reason: "ROAD_AUTHORIZED_INPUT_MALFORMED",
      });
    });
  });
});
