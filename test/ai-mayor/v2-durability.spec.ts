import {
  V2DurabilityCoordinator,
  commandIdempotencyKey,
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
  type V2DurableState,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord, V2CommandStatus } from "@/main/services/ai-mayor/v2/foundation";
import { commandRetrySafety } from "@/main/services/ai-mayor/v2/foundation";
import { createDurableGate1StateStorage, createGate1VerticalSlice, planStarterResidentialIntent, type Gate1RoadPreApplyFailureEvidence, type Gate1State } from "@/main/services/ai-mayor/v2/gate1";

const WORLD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORLD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SAVE_A = "save:meta-a:data-a";
const SAVE_B = "save:meta-b:data-b";

function world(options: {
  session?: string;
  checkpoint?: string | null;
  generation?: string;
  bridge?: string;
  purpose?: "LoadGame" | "NewGame";
  generationOrigin?: "LOAD_COMPLETED" | "ATTACHED_EXISTING_WORLD";
} = {}) {
  const session = options.session ?? WORLD_A;
  const checkpoint = options.checkpoint === undefined ? SAVE_A : options.checkpoint;
  const purpose = options.purpose ?? "LoadGame";
  const parts = checkpoint?.split(":") ?? [];
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${session}`,
      nativeSessionGuid: session,
      loadPurpose: purpose,
      loadAssetGuid: purpose === "LoadGame" ? parts[1] : null,
      saveDataAssetGuid: purpose === "LoadGame" ? parts[2] : null,
      mapAssetGuid: "map-a",
      checkpointId: checkpoint,
      bridgeRuntimeEpoch: options.bridge ?? "bridge-a",
      generation: options.generation ?? "generation-a",
      generationSequence: 1,
      generationOrigin: options.generationOrigin ?? (options.generation || options.bridge ? "ATTACHED_EXISTING_WORLD" : "LOAD_COMPLETED"),
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
    },
  };
}

/** The durable state a bounded ZONING dead end leaves: terminal task, closed project. */
function terminallyBlockedZoning(state: Gate1State): Gate1State {
  const zoning = state.tasks.find((task) => task.kind === "ZONING");
  if (!zoning) throw new Error("expected a ZONING task");
  const outcomeId = `${zoning.id}:outcome:1`;
  zoning.status = "BLOCKED";
  zoning.attempts = 1;
  zoning.terminalOutcomeId = outcomeId;
  state.journal.push({
    id: outcomeId, taskId: zoning.id, skill: "Zoning", proposalId: null,
    recordedAt: "2026-01-01T00:00:00.000Z", admission: "ADMITTED", execution: "NOT_REQUIRED",
    commandId: null, observationId: null, observedEffect: "NOT_APPLICABLE",
    failureClassification: "ZONING_RESERVATION_DEAD_END",
    reason: "GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
  });
  state.project.status = "BLOCKED";
  state.intent.status = "BLOCKED";
  return state;
}

const cloneDurableState = <T>(value: T): T => structuredClone(value);

function command(commandId: string, status: V2CommandStatus = "CREATED"): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId,
    actionFamily: "ROAD",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: "project-a" },
      actionFamily: "ROAD",
      proposalId: "proposal-a",
      quoteId: "quote-a",
      fingerprint: "road-fixture-a",
      exactInput: '{"prefab":"Road","x1":1,"z1":2,"x2":3,"z2":4}',
      budget: { authorizedMaxSpend: 1000, treasurySafetyReserve: 100, currency: "GAME_MONEY" },
      observationPrecondition: { runtimeEpoch: "observation-a", frame: 12 },
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    createdAt: "2026-09-13T00:00:00.000Z",
    submittedAt: status === "SUBMITTED" ? "2026-09-13T00:00:01.000Z" : null,
    nativeResultSummary: null,
    status,
    statusHistory: [{ status, at: "2026-09-13T00:00:00.000Z" }],
    reconciliationStatus: "NOT_STARTED",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

function utilityCommand(commandId: string, status: V2CommandStatus = "CREATED", options: {
  placementScopeId?: string;
  x?: number;
} = {}): V2CommandRecord {
  return {
    ...command(commandId, status),
    actionFamily: "UTILITY",
    actionType: "place_building",
    authorizedScope: {
      owner: { ownerType: "TRANCHE", ownerId: "tranche-a" }, actionFamily: "UTILITY", utilityKind: "electricity",
      projectId: "project-a", trancheId: "tranche-a", reservationRef: "reservation-a",
      ...(options.placementScopeId ? { placementScopeId: options.placementScopeId } : {}),
      worldEpochId: `cs2-session:${WORLD_A}:generation:generation-a`, generation: "generation-a",
      topologyRevision: "topology-a", certifiedRoadRefs: [{ index: 5, version: 1 }],
      exactInput: JSON.stringify([{ type: "place_building", prefab: "WindTurbine01", x: options.x ?? 1, z: 2, rotation: 0 }]),
      spatialEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
      budget: { authorizedMaxSpend: 1000, treasurySafetyReserve: 100, currency: "GAME_MONEY" },
    },
  };
}

function receipt(checkpointId: string, generation = "generation-a", session = WORLD_A): SaveCompletionReceipt {
  const [, metadata, data] = checkpointId.split(":");
  return {
    status: "COMPLETED",
    durable: true,
    worldId: `cs2-session:${session}`,
    worldGeneration: generation,
    checkpoint: {
      checkpointId,
      saveMetadataAssetGuid: metadata,
      saveDataAssetGuid: data,
      nativeSessionGuid: session,
    },
  };
}

function transition(coordinator: V2DurabilityCoordinator, commandId: string, status: V2CommandStatus) {
  return coordinator.commandJournal.update(commandId, (current) => ({
    ...current,
    status,
    statusHistory: [...current.statusHistory, { status, at: "2026-09-13T00:00:02.000Z" }],
  }));
}

describe("V2 durable world/checkpoint contract", () => {
  test("fresh world requires a baseline checkpoint and rejects every Mayor mutation", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    const activation = coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    expect(activation.status).toBe("BASELINE_CHECKPOINT_REQUIRED");
    expect(() => coordinator.commandJournal.create(command("too-early"))).toThrow(
      "certified durable rollback boundary",
    );
  });

  test("certified fresh baseline activates in place without fabricating loaded checkpoint identity", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    expect(first.activate(world({ checkpoint: null, purpose: "NewGame" })).status).toBe("ACTIVATED_IN_PLACE");
    const restarted = new V2DurabilityCoordinator(storage);
    expect(restarted.activate(world({ checkpoint: null, purpose: "NewGame" })).status).toBe("ACTIVATED_IN_PLACE");
    expect(restarted.snapshot()).toMatchObject({
      active: { loadedCheckpointId: null, rollbackBoundaryId: SAVE_A },
      baselineActivation: { checkpointId: SAVE_A, journalPosition: 0, status: "ACTIVATED_IN_PLACE" },
      certifiedRollbackAnchor: { checkpointId: SAVE_A, journalPosition: 0, status: "CERTIFIED" },
    });
    restarted.commandJournal.create(command("first-write"));
    expect(restarted.snapshot().commands[0]).toMatchObject({ position: 1, baseCheckpointId: SAVE_A });
  });

  test("certified baseline is verified after a post-baseline Mayor mutation without rerecording", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    const baseline = coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    coordinator.commandJournal.create(command("road-after-baseline"));

    expect(coordinator.activate(world({ checkpoint: null, purpose: "NewGame" })).status).toBe("ACTIVATED_IN_PLACE");
    expect(coordinator.snapshot()).toMatchObject({
      journalPosition: 1,
      certifiedRollbackAnchor: { checkpointId: SAVE_A, journalPosition: 0 },
      checkpoints: expect.arrayContaining([expect.objectContaining({ checkpointId: baseline.checkpointId, journalPosition: 0, purpose: "BASELINE" })]),
    });
    expect(() => coordinator.recordBaselineCheckpoint(receipt(SAVE_B))).toThrow(
      "certified baseline checkpoint cannot be recorded again or replaced",
    );
  });
  test("a changed fresh generation invalidates the old in-place anchor before first write", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame", generation: "generation-fresh" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A, "generation-fresh"));
    expect(coordinator.activate(world({ checkpoint: null, purpose: "NewGame", generation: "generation-changed" })).status)
      .toBe("BASELINE_CHECKPOINT_REQUIRED");
    expect(() => coordinator.commandJournal.create(command("stale-anchor-write"))).toThrow(
      "certified durable rollback boundary",
    );
  });

  test("loading the exact baseline activates the lineage while rebinding execution generation", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame", generation: "generation-fresh" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A, "generation-fresh"));
    const restarted = new V2DurabilityCoordinator(storage);
    const activation = restarted.activate(world({ checkpoint: SAVE_A, purpose: "LoadGame", generation: "generation-reloaded" }));
    expect(activation.status).toBe("ACTIVATED");
    expect(restarted.snapshot().active).toMatchObject({
      loadedCheckpointId: SAVE_A,
      rollbackBoundaryId: SAVE_A,
      generation: "generation-reloaded",
    });
    expect(restarted.snapshot().checkpoints.find((entry) => entry.checkpointId === SAVE_A)).toMatchObject({
      purpose: "BASELINE",
      worldEpochId: `cs2-session:${WORLD_A}:generation:generation-fresh`,
    });
  });

  test("goal work orders retain separate durable scopes and resume after restart", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const initial = planStarterResidentialIntent({
      intentId: "intent:initial-work-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    first.saveProjectState(initial);
    const water = planStarterResidentialIntent({
      intentId: "intent:water-work-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 120 },
      siteCandidates: [{ id: "site-b", target: { center: { x: 400, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });

    expect(first.activateGoalWorkOrder({ goalId: "UTILITY_SERVICE:water:site-b", state: water }).project.id).toBe(water.project.id);
    expect(first.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: `legacy:${initial.intent.id}`, status: "SUSPENDED", state: expect.objectContaining({ project: expect.objectContaining({ id: initial.project.id }) }) }),
      expect.objectContaining({ goalId: "UTILITY_SERVICE:water:site-b", status: "ACTIVE", reservationRef: water.tranche.reservationRef }),
    ]));

    // A goal-scoped work order is still resumable across a restart: the Brain
    // names it by Goal id, so it can be displaced and brought back.
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.activateGoalWorkOrder({ goalId: "UTILITY_SERVICE:water:site-b" }).project.id).toBe(water.project.id);
    expect(restarted.projectState()).toMatchObject({ project: { id: water.project.id } });
    expect(restarted.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: `legacy:${initial.intent.id}`, status: "SUSPENDED" }),
      expect.objectContaining({ goalId: "UTILITY_SERVICE:water:site-b", status: "ACTIVE" }),
    ]));
  });

  test("an OFFICE Road-frontage prerequisite survives the restart that reads it back", () => {
    // The store's own loader allowed only RESIDENTIAL, COMMERCIAL and
    // INDUSTRIAL for `parentLandUse`, so the first office prerequisite the Brain
    // ever raised persisted a record its own loader then rejected as malformed —
    // and a rejected store blocks EVERY write for the whole session, not just
    // that Goal. Measured live 2026-10-01 on
    // `EXPAND_OFFICE:office:facts:3f3754d18562:prerequisite:ROAD_FRONTAGE:1:4ceab3aac7d23838`.
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const prerequisiteState = planStarterResidentialIntent({
      intentId: "intent:office-frontage-prerequisite", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "frontage-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    const goalId = "EXPAND_OFFICE:office:facts:3f3754d18562:prerequisite:ROAD_FRONTAGE:1:4ceab3aac7d23838";
    first.activateGoalWorkOrder({ goalId, state: prerequisiteState,
      parentGoalId: "EXPAND_OFFICE:office:facts:3f3754d18562", parentLandUse: "OFFICE",
      targetPoint: { x: -516.832764, z: -166.078629 }, completionStage: "ROAD_DELIVERED" });

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId, parentLandUse: "OFFICE", completionStage: "ROAD_DELIVERED" }),
    ]));
  });

  test("a planned corridor course survives a restart, and a malformed one stops the store loading", () => {
    // A prerequisite's course is the segment a planner compiled, carried so no
    // downstream step has to reconstruct its start. It is part of the step's
    // identity and part of what a restart must read back — and a half-finite one
    // is corruption, not a course.
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const prerequisiteState = planStarterResidentialIntent({
      intentId: "intent:planned-corridor-prerequisite", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "corridor-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    const goalId = "EXPAND_OFFICE:office:facts:planned:prerequisite:ROAD_FRONTAGE:1:planned";
    const roadCourse = { start: { x: -516.832764, z: -166.078629 }, end: { x: -512.5, z: -37.5 } };
    first.activateGoalWorkOrder({ goalId, state: prerequisiteState,
      parentGoalId: "EXPAND_OFFICE:office:facts:planned", parentLandUse: "OFFICE",
      targetPoint: roadCourse.end, roadCourse, completionStage: "ROAD_DELIVERED" });

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId, roadCourse }),
    ]));

    // A different plan for the same far end is a different step, not a silent
    // re-bind of the one already spent.
    expect(() => first.activateGoalWorkOrder({ goalId,
      roadCourse: { start: { x: 1, z: 1 }, end: roadCourse.end } }))
      .toThrow(/GOAL_WORK_ORDER_PREREQUISITE_IDENTITY_CONFLICT/);
    expect(() => first.activateGoalWorkOrder({ goalId,
      roadCourse: { start: { x: Number.NaN, z: 1 }, end: roadCourse.end } }))
      .toThrow(/GOAL_WORK_ORDER_ROAD_COURSE_INVALID/);

    // A stored course that is not a course fails the whole store closed rather
    // than resuming a step whose geometry cannot be trusted.
    const persisted = storage.value() as { goalWorkOrders: Array<{ goalId: string; roadCourse?: unknown }> };
    const record = persisted.goalWorkOrders.find((entry) => entry.goalId === goalId);
    if (!record) throw new Error("expected the persisted prerequisite record");
    record.roadCourse = { start: { x: 1, z: "not-a-number" }, end: roadCourse.end };
    storage.save(persisted);
    expect(() => new V2DurabilityCoordinator(storage).activate(world()))
      .toThrow(/malformed V2 goal prerequisite metadata/);
  });

  test("a completed root work order can remain the active handoff identity across restart", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const completed = planStarterResidentialIntent({
      intentId: "intent:completed-root-work-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "completed-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    const goalId = "EXPAND_RESIDENTIAL:residential:completed-root";
    first.activateGoalWorkOrder({ goalId, state: completed });
    completed.project.status = "COMPLETE";
    completed.intent.status = "SATISFIED";
    completed.tranche.stage = "OCCUPIED";
    completed.tranche.effect_progress.status = "OCCUPIED";
    first.saveProjectState(completed);
    expect(first.snapshot()).toMatchObject({
      activeGoalWorkOrderId: `goal-work-order:${goalId}`,
      goalWorkOrders: expect.arrayContaining([expect.objectContaining({ goalId, status: "COMPLETE" })]),
    });

    // A root Goal completed from its own Gate1 absorption remains the active
    // handoff identity until a naturally derived successor replaces it.
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.snapshot()).toMatchObject({
      activeGoalWorkOrderId: `goal-work-order:${goalId}`,
      goalWorkOrders: expect.arrayContaining([expect.objectContaining({ goalId, status: "COMPLETE" })]),
    });
    const next = planStarterResidentialIntent({
      intentId: "intent:after-completed-root", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "next-site", target: { center: { x: 400, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    restarted.activateGoalWorkOrder({ goalId: "EXPAND_RESIDENTIAL:residential:next", state: next });
    expect(restarted.snapshot()).toMatchObject({
      activeGoalWorkOrderId: "goal-work-order:EXPAND_RESIDENTIAL:residential:next",
      goalWorkOrders: expect.arrayContaining([
        expect.objectContaining({ goalId, status: "COMPLETE" }),
        expect.objectContaining({ goalId: "EXPAND_RESIDENTIAL:residential:next", status: "ACTIVE" }),
      ]),
    });
  });

  /**
   * The displaced starter slot is synthesized by this store, so no planning path
   * can ever name it again. Retaining its planning envelope would let the
   * abandoned starter veto every later project in the region it covers — which
   * is exactly what stops a grown city from being planned around its own
   * original starter. Releasing it does not make it resumable: a successor has
   * to pass the ordinary admission and receive its own scope.
   */
  test("a displaced starter slot releases its planning envelope and is not resumable", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const initial = planStarterResidentialIntent({
      intentId: "intent:abandoned-starter", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    coordinator.saveProjectState(initial);
    const water = planStarterResidentialIntent({
      intentId: "intent:water-work-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "site-b", target: { center: { x: 400, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    coordinator.activateGoalWorkOrder({ goalId: "UTILITY_SERVICE:water:site-b", state: water });

    const released = coordinator.snapshot().goalWorkOrders?.find(
      (item) => item.goalId === `legacy:${initial.intent.id}`,
    );
    expect(released?.status).toBe("SUSPENDED");
    expect(typeof released?.releasedReservationAt).toBe("string");
    expect(coordinator.isGoalWorkOrderReservationProtected(released!.workOrderId)).toBe(false);
    // The active Goal keeps its own envelope: only the abandoned slot gave its up.
    const active = coordinator.snapshot().goalWorkOrders?.find((item) => item.goalId === "UTILITY_SERVICE:water:site-b");
    expect(coordinator.isGoalWorkOrderReservationProtected(active!.workOrderId)).toBe(true);
    expect(() => coordinator.activateGoalWorkOrder({ goalId: `legacy:${initial.intent.id}` }))
      .toThrow("GOAL_WORK_ORDER_RELEASED_SCOPE_SUCCESSOR_REQUIRED");
  });

  test("targeted Road prerequisite metadata and its completion milestone survive durable activation", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const parent = planStarterResidentialIntent({
      intentId: "intent:parent-water", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "parent-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    coordinator.saveProjectState(parent);
    const road = planStarterResidentialIntent({
      intentId: "intent:road-prerequisite", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "road-site", target: { center: { x: 400, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    road.tranche.stage = "ROAD_DELIVERED";
    coordinator.activateGoalWorkOrder({ goalId: "water:prerequisite:road:1", state: road,
      parentGoalId: "water:site:1", targetPoint: { x: 900, z: 200 }, completionStage: "ROAD_DELIVERED" });
    expect(coordinator.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: "water:prerequisite:road:1", parentGoalId: "water:site:1",
        targetPoint: { x: 900, z: 200 }, completionStage: "ROAD_DELIVERED", status: "ACTIVE" }),
    ]));
    expect(coordinator.completeGoalWorkOrder("water:prerequisite:road:1").status).toBe("COMPLETE");
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.snapshot()).toMatchObject({ activeGoalWorkOrderId: null,
      goalWorkOrders: expect.arrayContaining([expect.objectContaining({ goalId: "water:prerequisite:road:1", status: "COMPLETE" })]) });
  });

  test("an inconsistent durable Gate1 state keeps its scope in reconciliation", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:blocked-active-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "blocked-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    // A project recorded terminal whose own tasks carry no terminal outcome: the
    // durable state disagrees with itself, so nothing about it may be concluded.
    state.project.status = "BLOCKED";
    state.intent.status = "BLOCKED";
    coordinator.activateGoalWorkOrder({ goalId: "goal:temporary-road-block", state });
    const outcome = coordinator.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state, reason: "progression stopped before Gate1 recorded a terminal task outcome",
    });
    expect(outcome).toMatchObject({ status: "RECONCILING", reconciliationReason: expect.stringContaining("before Gate1") });
    expect(coordinator.isGoalWorkOrderReservationProtected(outcome!.workOrderId)).toBe(true);
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.snapshot()).toMatchObject({ activeGoalWorkOrderId: "goal-work-order:goal:temporary-road-block",
      goalWorkOrders: expect.arrayContaining([expect.objectContaining({ goalId: "goal:temporary-road-block", status: "RECONCILING" })]) });
  });

  /**
   * An exhausted bounded step is not a pending question: the work order never
   * got past its own site, so it has no native effect whose outcome could be in
   * doubt. Leaving it in reconciliation would pause its parent Goal forever and
   * freeze the whole city behind one step, while no later reconciliation could
   * ever adopt anything. It ends terminally, frees the land it reserved, and a
   * successor is admitted from current facts instead.
   */
  test("an exhausted bounded step ends terminally and frees its envelope", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const parent = planStarterResidentialIntent({
      intentId: "intent:water-parent", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "parent-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    coordinator.saveProjectState(parent);
    const child = planStarterResidentialIntent({
      intentId: "intent:stale-road-prerequisite", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 900, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "stale-site", target: { center: { x: 900, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    coordinator.activateGoalWorkOrder({ goalId: "water:site:1:prerequisite:ROAD_ACCESS:3:aa", state: child,
      parentGoalId: "water:site:1", targetPoint: { x: 500, z: 0 }, completionStage: "ROAD_DELIVERED" });

    const outcome = coordinator.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state: child,
      reason: "GATE1_PROGRESSION_NO_BOUNDED_OR_GENERIC_ROAD_CANDIDATE",
    });

    expect(outcome).toMatchObject({
      status: "BLOCKED", reconciliationReason: "GATE1_PROGRESSION_NO_BOUNDED_OR_GENERIC_ROAD_CANDIDATE",
    });
    expect(coordinator.isGoalWorkOrderReservationProtected(outcome!.workOrderId)).toBe(false);
    expect(() => coordinator.activateGoalWorkOrder({ goalId: "water:site:1:prerequisite:ROAD_ACCESS:3:aa" }))
      .toThrow("GOAL_WORK_ORDER_RELEASED_SCOPE_SUCCESSOR_REQUIRED");
    // A successor step of the same Goal is a different goal id, and it may be
    // admitted into the land the exhausted step gave up.
    expect(coordinator.activateGoalWorkOrder({ goalId: "water:site:1:prerequisite:ROAD_ACCESS:4:bb", state: child,
      parentGoalId: "water:site:1", targetPoint: { x: 500, z: 0 }, completionStage: "ROAD_DELIVERED" }).project.id)
      .toBe(child.project.id);
    // The durable record survives the restart, so the history is auditable.
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: "water:site:1:prerequisite:ROAD_ACCESS:3:aa", status: "BLOCKED" }),
    ]));
  });

  /**
   * Admission capacity is about what a branch can still carry, not about how
   * much it has already done. Terminal, fully reconciled work orders are
   * evidence — they stay in the store forever — but they hold nothing, so they
   * must stop competing for the right to plan. Tying both to one number is what
   * would let a city's own past block every future admission.
   */
  test("terminal Goal history is retained but does not consume admission capacity", () => {
    const first = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    first.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:capacity-fixture", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "capacity-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    first.activateGoalWorkOrder({ goalId: "goal:capacity-live", state });
    const blocked = terminallyBlockedZoning(structuredClone(state));
    first.saveProjectState(blocked);
    const closed = first.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state: blocked, reason: "GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
    });
    expect(closed).toMatchObject({ status: "BLOCKED" });
    expect(typeof closed?.releasedReservationAt).toBe("string");
    expect(first.isGoalWorkOrderReservationProtected(closed!.workOrderId)).toBe(false);

    // The same terminal record, replicated far past the old single bound. Every
    // copy is closed, released and settled, so none of them holds anything.
    const seeded = cloneDurableState(first.snapshot());
    const template = seeded.goalWorkOrders![0];
    seeded.goalWorkOrders = Array.from({ length: 400 }, (_unused, index) => ({
      ...structuredClone(template),
      goalId: `${template.goalId}:history:${index}`,
      workOrderId: `goal-work-order:${template.goalId}:history:${index}`,
    }));
    seeded.activeGoalWorkOrderId = null;

    const storage = createMemoryDurableStateStorage(seeded);
    const restored = new V2DurabilityCoordinator(storage);
    restored.activate(world());
    expect(restored.snapshot().goalWorkOrders).toHaveLength(400);

    // A new Goal is still admitted: 400 terminal records are history, not
    // capacity. Under the single old bound this exact store was unplannable.
    const next = planStarterResidentialIntent({
      intentId: "intent:capacity-next", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "next-site", target: { center: { x: 400, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    expect(restored.activateGoalWorkOrder({ goalId: "goal:capacity-next", state: next }).project.id).toBe(next.project.id);
    // 400 terminal history records, the synthesized slot for the displaced
    // project, and the new work order — the history is still all there, and it
    // is the only reason the registry is this long.
    expect(restored.snapshot().goalWorkOrders).toHaveLength(402);
    expect(restored.snapshot().goalWorkOrders?.filter((item) => item.goalId.includes(":history:")))
      .toHaveLength(400);
    expect(restored.snapshot().goalWorkOrders?.filter((item) => item.status === "ACTIVE")).toHaveLength(1);
  });

  /**
   * Being displaced ends a Goal's claim on the land: the Goal that displaced it
   * is the one being pursued. The record, its state and its journal stay durable
   * history, and a Goal that comes back from a later WorldState goes through
   * admission for a NEW reservation rather than reviving the old scope.
   */
  test("a displaced Goal gives up its planning reservation but keeps its history", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const first = planStarterResidentialIntent({
      intentId: "intent:displaced-a", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    coordinator.activateGoalWorkOrder({ goalId: "goal:displaced-a", state: first });
    const before = coordinator.goalWorkOrder("goal:displaced-a")!;

    const second = planStarterResidentialIntent({
      intentId: "intent:displaced-b", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "site-b", target: { center: { x: 400, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    coordinator.activateGoalWorkOrder({ goalId: "goal:displaced-b", state: second });

    const displaced = coordinator.goalWorkOrder("goal:displaced-a")!;
    expect(displaced.status).toBe("SUSPENDED");
    expect(typeof displaced.releasedReservationAt).toBe("string");
    expect(coordinator.isGoalWorkOrderReservationProtected(displaced.workOrderId)).toBe(false);
    // History is untouched: same identity, same reservation reference, same state.
    expect(displaced.state.project.id).toBe(before.state.project.id);
    expect(displaced.state.tranche.reservationRef).toBe(before.state.tranche.reservationRef);
    // And the old scope is not revived — a successor has to be admitted.
    expect(() => coordinator.activateGoalWorkOrder({ goalId: "goal:displaced-a" }))
      .toThrow("GOAL_WORK_ORDER_RELEASED_SCOPE_SUCCESSOR_REQUIRED");
  });

  /**
   * An unsettled native command is a question that has not been answered yet.
   * Releasing its land before reconciliation would let another Goal be admitted
   * into a scope whose world effect is still unknown.
   */
  test("a displaced Goal with an unsettled command keeps its land until reconciliation", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const held = planStarterResidentialIntent({
      intentId: "intent:displaced-in-flight", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "held-site", target: { center: { x: 0, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    held.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.activeCommandId = "command:unresolved";
    coordinator.saveProjectState(held);
    coordinator.activateGoalWorkOrder({ goalId: "goal:displaced-in-flight", state: held });

    const other = planStarterResidentialIntent({
      intentId: "intent:displaced-other", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "other-site", target: { center: { x: 400, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    // Displacement is refused outright while a task is in flight, so an unsettled
    // scope cannot be released out from under its command this way at all.
    expect(() => coordinator.activateGoalWorkOrder({ goalId: "goal:displaced-other", state: other }))
      .toThrow("GOAL_WORK_ORDER_SWITCH_HAS_IN_FLIGHT_TASK");
    expect(coordinator.isGoalWorkOrderReservationProtected(
      coordinator.goalWorkOrder("goal:displaced-in-flight")!.workOrderId)).toBe(true);

    // And a suspended record that already carries an unsettled command — written
    // by an earlier build, or suspended through another path — is left protected
    // when the release rule walks the registry.
    const seeded = cloneDurableState(coordinator.snapshot());
    const template = seeded.goalWorkOrders!.find((item) => item.goalId === "goal:displaced-in-flight")!;
    seeded.goalWorkOrders = [{ ...structuredClone(template), status: "SUSPENDED", releasedReservationAt: null }];
    seeded.activeGoalWorkOrderId = null;
    // The live slot holds a different, settled project, so the release rule is
    // reached through a normal activation rather than through a displacement.
    seeded.projectState = structuredClone(other) as never;
    const restored = new V2DurabilityCoordinator(createMemoryDurableStateStorage(seeded));
    restored.activate(world());
    restored.activateGoalWorkOrder({ goalId: "goal:displaced-other", state: other });
    const stillHeld = restored.goalWorkOrder("goal:displaced-in-flight")!;
    expect(stillHeld.status).toBe("SUSPENDED");
    expect(stillHeld.releasedReservationAt ?? null).toBeNull();
    expect(restored.isGoalWorkOrderReservationProtected(stillHeld.workOrderId)).toBe(true);
  });

  test("an in-flight command keeps a progression failure in reconciliation", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:in-flight-road", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    const task = state.tasks.find((entry) => entry.kind === "ROAD_CONNECTION")!;
    task.activeCommandId = "command:unresolved";
    coordinator.saveProjectState(state);
    coordinator.activateGoalWorkOrder({ goalId: "goal:in-flight-road", state });

    const outcome = coordinator.recordGoalWorkOrderProgressionOutcome({
      status: "BLOCKED", state, reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED",
    });

    // An in-flight command's outcome genuinely is unknown, so the scope is held
    // until the existing reconciliation path can bind it.
    expect(outcome).toMatchObject({ status: "RECONCILING" });
    expect(coordinator.isGoalWorkOrderReservationProtected(outcome!.workOrderId)).toBe(true);
  });

  test("releases only a fully reconciled terminal blocked scope and admits a fresh successor state", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:terminal-road-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "terminal-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    coordinator.activateGoalWorkOrder({ goalId: "goal:terminal-road-order", state });
    const task = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    task.status = "BLOCKED";
    task.terminalOutcomeId = `${task.id}:terminal`;
    state.project.status = "BLOCKED";
    state.intent.status = "BLOCKED";
    state.journal.push({ id: task.terminalOutcomeId, taskId: task.id, skill: "RoadConnection", proposalId: `${task.id}:attempt:1`,
      recordedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(), admission: "NOT_REQUIRED", execution: "NOT_REQUIRED",
      commandId: null, observationId: "observation:terminal-block", observedEffect: "NOT_APPLICABLE",
      failureClassification: "ROAD_PREFLIGHT_REJECTED", reason: "candidate-only preflight was terminally rejected" });
    coordinator.saveProjectState(state);
    const blocked = coordinator.goalWorkOrder("goal:terminal-road-order")!;
    expect(blocked.status).toBe("BLOCKED");
    expect(coordinator.isGoalWorkOrderReservationProtected(blocked.workOrderId)).toBe(false);

    const successor = planStarterResidentialIntent({
      intentId: "intent:terminal-road-successor", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "successor-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    expect(coordinator.activateGoalWorkOrder({ goalId: "goal:terminal-road-successor", state: successor }).intent.id)
      .toBe(successor.intent.id);
    expect(coordinator.snapshot().goalWorkOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: "goal:terminal-road-order", status: "BLOCKED" }),
      expect.objectContaining({ goalId: "goal:terminal-road-successor", status: "ACTIVE", reservationRef: successor.tranche.reservationRef }),
    ]));
  });

  /**
   * A COMPLETE record whose own stored project is terminally BLOCKED can never
   * take another step, and its goal id embeds the facts hash of the derivation
   * that raised it, so no later derivation can name it again. Holding its
   * envelope then lets one dead scope veto every later project in the region.
   *
   * Measured live (2026-09-30): two such sewage `ROAD_ACCESS` records covered
   * all four Growable Fast Path footprints around the owned road network. Every
   * growth Goal was refused, and the Brain answered by raising a `ROAD_FRONTAGE`
   * prerequisite that could not create a zoning cell — 149 work orders, journal
   * flat, no Apply.
   */
  test("a COMPLETE record whose stored project is terminally blocked stops claiming its land", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:dead-prerequisite", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "dead-site", target: { center: { x: 0, z: 0 }, radius: 28 }, score: 1, blocked: false }],
    });
    state.tranche.stage = "ROAD_DELIVERED";
    coordinator.activateGoalWorkOrder({ goalId: "sewage:prerequisite:road:1", state,
      parentGoalId: "sewage:site:1", completionStage: "ROAD_DELIVERED" });
    expect(coordinator.completeGoalWorkOrder("sewage:prerequisite:road:1").status).toBe("COMPLETE");
    expect(coordinator.isGoalWorkOrderReservationProtected(
      coordinator.goalWorkOrder("sewage:prerequisite:road:1")!.workOrderId)).toBe(false);

    // The shape the live store actually held: the record stayed COMPLETE while
    // its stored project went on to a terminal block at a later stage, so it
    // never reaches its ROAD_DELIVERED milestone and the old rule kept the claim.
    const template = cloneDurableState(coordinator.snapshot())
      .goalWorkOrders!.find((item) => item.goalId === "sewage:prerequisite:road:1")!;
    const blocked = structuredClone(template.state);
    const terminal = blocked.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
    terminal.status = "BLOCKED";
    terminal.terminalOutcomeId = `${terminal.id}:terminal`;
    terminal.activeCommandId = null;
    blocked.project.status = "BLOCKED";
    blocked.intent.status = "BLOCKED";
    blocked.tranche.stage = "DIAGNOSING";
    blocked.journal.push({ id: terminal.terminalOutcomeId, taskId: terminal.id, skill: "RoadConnection",
      proposalId: `${terminal.id}:attempt:1`, recordedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      admission: "NOT_REQUIRED", execution: "NOT_REQUIRED", commandId: null,
      observationId: "observation:dead-terminal", observedEffect: "NOT_APPLICABLE",
      failureClassification: "ROAD_PREFLIGHT_REJECTED", reason: "candidate-only preflight was terminally rejected" });
    const seeded = cloneDurableState(coordinator.snapshot());
    seeded.goalWorkOrders = [{ ...cloneDurableState(template), status: "COMPLETE", releasedReservationAt: null,
      state: blocked }];
    seeded.activeGoalWorkOrderId = null;
    const restored = new V2DurabilityCoordinator(createMemoryDurableStateStorage(seeded));
    restored.activate(world());
    const dead = restored.goalWorkOrder("sewage:prerequisite:road:1")!;
    expect(dead.status).toBe("COMPLETE");
    expect(restored.isGoalWorkOrderReservationProtected(dead.workOrderId)).toBe(false);

    // Two controls, so the release is the blocker being terminal and nothing else:
    // a COMPLETE record that DID reach its milestone never claimed land anyway,
    // and one whose command is still unsettled keeps its claim whatever its
    // project status says.
    const reached = cloneDurableState(restored.snapshot());
    reached.goalWorkOrders = [{ ...cloneDurableState(dead), releasedReservationAt: null,
      state: cloneDurableState(template.state) }];
    reached.activeGoalWorkOrderId = null;
    const settled = new V2DurabilityCoordinator(createMemoryDurableStateStorage(reached));
    settled.activate(world());
    expect(settled.isGoalWorkOrderReservationProtected(
      settled.goalWorkOrder("sewage:prerequisite:road:1")!.workOrderId)).toBe(false);

    const unsettled = cloneDurableState(restored.snapshot());
    const inFlight = cloneDurableState(blocked);
    inFlight.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.activeCommandId = "command:unresolved";
    unsettled.goalWorkOrders = [{ ...cloneDurableState(dead), releasedReservationAt: null, state: inFlight }];
    unsettled.activeGoalWorkOrderId = null;
    const held = new V2DurabilityCoordinator(createMemoryDurableStateStorage(unsettled));
    held.activate(world());
    expect(held.isGoalWorkOrderReservationProtected(
      held.goalWorkOrder("sewage:prerequisite:road:1")!.workOrderId)).toBe(true);
  });

  test("keeps a Gate1 terminal-looking scope protected while a referenced command is unresolved", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:unknown-road-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "unknown-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    coordinator.activateGoalWorkOrder({ goalId: "goal:unknown-road-order", state });
    const task = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    task.status = "BLOCKED";
    task.terminalOutcomeId = `${task.id}:terminal`;
    state.project.status = "BLOCKED";
    state.intent.status = "BLOCKED";
    state.journal.push({ id: task.terminalOutcomeId, taskId: task.id, skill: "RoadConnection", proposalId: `${task.id}:attempt:1`,
      recordedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(), admission: "ADMITTED", execution: "UNKNOWN",
      commandId: "command:unreconciled", observationId: "observation:unknown", observedEffect: "UNKNOWN",
      failureClassification: "EXECUTION_UNKNOWN", reason: "native command awaits reconciliation" });
    coordinator.saveProjectState(state);
    const record = coordinator.goalWorkOrder("goal:unknown-road-order")!;
    expect(record.status).toBe("RECONCILING");
    expect(coordinator.isGoalWorkOrderReservationProtected(record.workOrderId)).toBe(true);
  });

  test("goal work order switching refuses a dispatched task", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const current = planStarterResidentialIntent({
      intentId: "intent:in-flight-work-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    current.tasks[0].status = "DISPATCHED";
    current.tasks[0].activeCommandId = "command:in-flight";
    coordinator.saveProjectState(current);
    const next = planStarterResidentialIntent({
      intentId: "intent:next-work-order", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 400, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "site-b", target: { center: { x: 400, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });

    expect(() => coordinator.activateGoalWorkOrder({ goalId: "EXPAND_RESIDENTIAL:second", state: next }))
      .toThrow("GOAL_WORK_ORDER_SWITCH_HAS_IN_FLIGHT_TASK");
    expect(coordinator.projectState()).toMatchObject({ project: { id: current.project.id } });
  });

  test("completed project and reservation release survive restart without replay", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const state = planStarterResidentialIntent({
      intentId: "intent:completed", targetResidents: 12, maximumBudget: 10_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    state.intent.status = "SATISFIED";
    state.project.status = "OCCUPIED";
    state.tranche.stage = "OCCUPIED";
    state.tranche.effect_progress.status = "OCCUPIED";
    state.tasks.forEach((task) => { task.status = "SUCCEEDED"; });
    state.journal.push({
      id: "outcome:occupied", taskId: state.tasks.at(-1)!.id, skill: "WaitObserve", proposalId: null,
      admission: "NOT_REQUIRED", execution: "NOT_REQUIRED", commandId: null, observationId: "observation:occupied",
      observedEffect: "OCCUPIED", failureClassification: "NONE", recordedAt: "2026-09-15T00:00:00.000Z", reason: "occupied",
    });
    first.saveProjectState(state);
    const workflow = createGate1VerticalSlice({
      storage: createDurableGate1StateStorage(first), boundary: { execute: async () => ({ status: "DELIVERED", commandId: null, observedMatch: true, reason: "unused" }) },
    });
    expect(workflow.completeOccupiedProject().newlyCompleted).toBe(true);
    const completion = workflow.snapshot().completion!;
    expect(first.snapshot().completedProjects).toContainEqual(expect.objectContaining({
      completionId: completion.completionId,
      releasedReservationRefs: [state.tranche.reservationRef],
    }));

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ bridge: "bridge-restarted" }));
    const restored = createGate1VerticalSlice({
      storage: createDurableGate1StateStorage(restarted), boundary: { execute: async () => ({ status: "DELIVERED", commandId: null, observedMatch: true, reason: "unused" }) },
    });
    expect(restored.completeOccupiedProject().newlyCompleted).toBe(false);
    expect(restored.snapshot().project.status).toBe("COMPLETE");
    const next = restored.startNextProject({
      intentId: "intent:next", targetResidents: 20, maximumBudget: 12_000,
      planningEnvelope: { center: { x: 100, z: 0 }, radius: 100 },
      siteCandidates: [{ id: "site-next", target: { center: { x: 100, z: 0 }, radius: 20 }, score: 1, blocked: false }],
    });
    expect(next.project.id).not.toBe(state.project.id);
    expect(restarted.snapshot().completedProjects).toContainEqual(expect.objectContaining({
      completionId: completion.completionId,
      handoffStatus: "CONSUMED",
      nextDecisionId: "intent:next",
    }));
    const afterHandoffRestart = new V2DurabilityCoordinator(storage);
    afterHandoffRestart.activate(world({ bridge: "bridge-after-handoff" }));
    expect(afterHandoffRestart.projectState()).toMatchObject({
      intent: { id: "intent:next" }, project: { status: "ACTIVE" }, predecessorCompletionId: completion.completionId,
    });
  });

  test("same world runtime reconnect resumes the exact world epoch", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    expect(coordinator.activate(world()).kind).toBe("FIRST_OBSERVATION");
    expect(coordinator.activate(world({ bridge: "bridge-b" })).kind).toBe("SAME_WORLD_RECONNECT");
  });

  test("same epoch retains a newer completed checkpoint than the original load context", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    coordinator.recordCheckpoint(receipt(SAVE_A), 0);
    const result = coordinator.activate(world({ checkpoint: null, purpose: "NewGame", bridge: "bridge-b" }));
    expect(result.kind).toBe("SAME_WORLD_RECONNECT");
    expect(coordinator.snapshot().active?.rollbackBoundaryId).toBe(SAVE_A);
    expect(coordinator.snapshot().active?.loadedCheckpointId).toBeNull();
  });

  test("same save reload is distinguished from a Bridge reconnect", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.saveProjectState(deliveredProjectState("intent:same-save-reload", "SITE_SELECTED"));
    expect(coordinator.activate(world({ generation: "generation-b", bridge: "bridge-b" })).kind).toBe(
      "SAME_SAVE_RELOAD",
    );
    expect(coordinator.projectState()).toMatchObject({ intent: { id: "intent:same-save-reload" }, tranche: { stage: "SITE_SELECTED" } });
  });

  test("an explicit historical LoadGame forks a new execution branch from a task-only divergence", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const parentBranch = coordinator.executionBranchId();
    coordinator.recordCheckpoint(receipt(SAVE_B), 0);
    coordinator.saveProjectState(deliveredProjectState("intent:task-only-progress", "SITE_SELECTED"));

    const activation = coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-historical", generationOrigin: "LOAD_COMPLETED" }));
    expect(activation.blockedReason).toBeNull();
    expect(activation.status).toBe("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    expect(coordinator.isExecutionDurablyActivated(activation)).toBe(false);
    expect(coordinator.executionBranchId()).not.toBe(parentBranch);
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect((storage.value() as any).executionBranch).toMatchObject({
      parentBranchId: parentBranch,
      sourceCheckpointId: SAVE_B,
      sourceJournalCut: 0,
      loadEventId: expect.stringContaining("generation-historical"),
    });
    const firstBranch = coordinator.executionBranchId();
    coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-independent-load", generationOrigin: "LOAD_COMPLETED" }));
    expect(coordinator.executionBranchId()).not.toBe(firstBranch);
    expect((storage.value() as any).executionBranch.parentBranchId).toBe(firstBranch);
  });

  test("an attached runtime generation resumes the same branch without reducing execution state", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const branchId = coordinator.executionBranchId();
    const state = deliveredProjectState("intent:resume", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const activation = coordinator.activate(world({ generation: "generation-runtime-replaced", generationOrigin: "ATTACHED_EXISTING_WORLD" }));
    expect(activation.kind).toBe("SAME_SAVE_RELOAD");
    expect(coordinator.executionBranchId()).toBe(branchId);
    expect(coordinator.projectState()).toEqual(state);
  });

  test("a checkpoint held only by an archived branch can be loaded into a new fork", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const rootBranch = coordinator.executionBranchId();
    coordinator.recordCheckpoint(receipt(SAVE_B), 0);
    coordinator.saveProjectState(deliveredProjectState("intent:after-b"));
    coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-fork-b", generationOrigin: "LOAD_COMPLETED" }));
    const branchB = coordinator.executionBranchId();
    expect(branchB).not.toBe(rootBranch);

    const older = coordinator.activate(world({ checkpoint: SAVE_A, generation: "generation-fork-a", generationOrigin: "LOAD_COMPLETED" }));
    expect(older.blockedReason).toBeNull();
    expect(coordinator.executionBranchId()).not.toBe(branchB);
    expect((storage.value() as any).executionBranch).toMatchObject({ parentBranchId: rootBranch, sourceCheckpointId: SAVE_A });
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("historical LoadGame forks without inheriting an old branch UNKNOWN and remains unroutable", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    coordinator.recordCheckpoint(receipt(SAVE_B), 0);
    coordinator.commandJournal.create(command("unknown-after-cut", "NATIVE_COMPLETION_UNKNOWN"));
    const parentBranch = coordinator.executionBranchId();
    const activation = coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-unknown", generationOrigin: "LOAD_COMPLETED" }));
    expect(activation.status).toBe("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    expect(coordinator.executionBranchId()).not.toBe(parentBranch);
    expect(coordinator.snapshot().commands).toEqual([]);
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(coordinator.isExecutionDurablyActivated(activation)).toBe(false);
    expect((storage.value() as any).executionBranch.executionReady).toBe(false);
    expect(() => coordinator.commandJournal.create(command("must-not-admit-before-world-readback")))
      .toThrow("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    expect(() => coordinator.saveProjectState(deliveredProjectState("intent:must-not-save-before-readback")))
      .toThrow("EXECUTION_WORLD_VERIFICATION_REQUIRED");
  });

  test("historical branch verification requires the current exact world binding", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    coordinator.recordCheckpoint(receipt(SAVE_B), 0);
    coordinator.saveProjectState(deliveredProjectState("intent:verification-gate"));
    coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-historical", generationOrigin: "LOAD_COMPLETED" }));
    expect(() => coordinator.markExecutionBranchWorldVerified({
      worldId: `cs2-session:${WORLD_A}`, generation: "other-generation", worldEpochId: "epoch-historical", checkpointId: SAVE_B,
    })).toThrow("HISTORICAL_BRANCH_WORLD_VERIFICATION_BINDING_CHANGED");
    coordinator.markExecutionBranchWorldVerified({
      worldId: `cs2-session:${WORLD_A}`, generation: "generation-historical", worldEpochId: `cs2-session:${WORLD_A}:generation:generation-historical`, checkpointId: SAVE_B,
    });
    const activation = coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-historical", generationOrigin: "LOAD_COMPLETED" }));
    expect(activation.status).toBe("ACTIVATED");
    expect(coordinator.isExecutionDurablyActivated(activation)).toBe(true);
  });

  test("historical LoadGame refuses a live native operation before creating a branch", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    coordinator.recordCheckpoint(receipt(SAVE_B), 0);
    coordinator.saveProjectState(deliveredProjectState("intent:busy-gate"));
    const busy = world({ checkpoint: SAVE_B, generation: "generation-busy", generationOrigin: "LOAD_COMPLETED" });
    busy.world.nativeOperationBusy = true;
    busy.world.nativeOperationStage = "Applying";
    expect(() => coordinator.activate(busy)).toThrow("HISTORICAL_LOAD_CROSS_GENERATION_OPERATION_NOT_IDLE");
    expect(coordinator.executionBranchId()).toBe((storage.value() as any).executionBranch.branchId);
  });

  test("metadata-only checkpoint match cannot authorize a historical fork", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    coordinator.recordCheckpoint(receipt(SAVE_B), 0);
    coordinator.saveProjectState(deliveredProjectState("intent:exact-id-gate"));
    const identity = world({ checkpoint: "save:meta-b:different-data", generation: "generation-metadata-only", generationOrigin: "LOAD_COMPLETED" });
    expect(() => coordinator.activate(identity)).toThrow("HISTORICAL_LOAD_EXACT_CHECKPOINT_REQUIRED");
  });

  test("an unregistered LoadGame checkpoint remains quarantined and cannot replace execution state", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world());
    const before = coordinator.projectState();
    const branchId = coordinator.executionBranchId();
    expect(() => coordinator.activate(world({ checkpoint: "save:unregistered-meta:unregistered-data", generation: "generation-unregistered", generationOrigin: "LOAD_COMPLETED" })))
      .toThrow("EXECUTION_BRANCH_CLASSIFICATION_UNKNOWN");
    expect(coordinator.projectState()).toEqual(before);
    expect(coordinator.executionBranchId()).toBe(branchId);
  });

  test("a loaded checkpoint cut excludes later project progression while preserving immutable history", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    for (let position = 1; position <= 4; position += 1) {
      const id = `pre-cut-${position}`;
      const record = command(id);
      record.authorizedScope.proposalId = `proposal-${id}`;
      record.authorizedScope.fingerprint = `fingerprint-${id}`;
      record.authorizedScope.exactInput = JSON.stringify({ prefab: "Road", x1: position, z1: 2, x2: position + 1, z2: 4 });
      first.commandJournal.create(record);
      transition(first, id, "OBSERVED_MATCH");
    }
    const checkpoint = first.recordCheckpoint(receipt(SAVE_B), 4);
    expect(checkpoint.projectState).toMatchObject({ status: "PLACEHOLDER" });

    first.commandJournal.create(command("future-road"));
    transition(first, "future-road", "OBSERVED_MATCH");
    first.commandJournal.create(utilityCommand("future-water", "CREATED"));
    transition(first, "future-water", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:after-cut", "ROAD_DELIVERED"));
    first.recordCheckpoint(receipt("save:later:data-later"), 6);
    const historicalRoad = first.snapshot().commands.find((entry) => entry.record.commandId === "future-road");
    const historicalWater = first.snapshot().commands.find((entry) => entry.record.commandId === "future-water");

    const loaded = new V2DurabilityCoordinator(storage);
    const activation = loaded.activate(world({ checkpoint: SAVE_B, generation: "generation-cut-4" }));

    expect(activation.kind).toBe("ROLLBACK");
    expect(loaded.activeCheckpointJournalPosition()).toBe(4);
    expect(loaded.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(loaded.isCommandOutsideActiveCheckpoint("future-road")).toBe(true);
    expect(loaded.checkpointRecoveryWitness("future-road")).toBeNull();
    expect(loaded.commandJournal.get("future-road")).toEqual(historicalRoad?.record);
    expect(loaded.commandJournal.get("future-water")).toEqual(historicalWater?.record);
    expect(loaded.snapshot().commands.find((entry) => entry.record.commandId === "future-road")).toEqual(historicalRoad);
    expect(loaded.snapshot().commands.find((entry) => entry.record.commandId === "future-water")).toEqual(historicalWater);

    // A new operation on this loaded branch gets a fresh identity; the old
    // operation remains terminal and immutable.
    const newOperation = command("new-branch-road-operation");
    newOperation.authorizedScope.proposalId = "proposal-new-branch";
    newOperation.authorizedScope.fingerprint = "fresh-current-branch-road-plan";
    newOperation.authorizedScope.exactInput = '{"prefab":"Road","x1":11,"z1":12,"x2":13,"z2":14}';
    loaded.commandJournal.create(newOperation);
    expect(loaded.commandJournal.get("new-branch-road-operation")).toBeDefined();
    expect(loaded.commandJournal.get("future-road")?.status).toBe("OBSERVED_MATCH");
    expect(loaded.commandJournal.get("future-road")?.commandId).not.toBe("new-branch-road-operation");
  });

  test("a known cut regression wins over a same-epoch reconnect classification", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("post-cut-road"));
    transition(first, "post-cut-road", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:post-cut", "ROAD_DELIVERED"));

    // Model a prior activation that rebound this runtime epoch but retained the
    // future project state. The registered checkpoint still proves the command
    // is beyond its cut and from an older execution epoch.
    const persisted = storage.value() as any;
    persisted.active = {
      ...persisted.active,
      generation: "generation-loaded-cut",
      worldEpochId: `cs2-session:${WORLD_A}:generation:generation-loaded-cut`,
    };
    delete persisted.active.activatedCheckpointJournalCut;
    storage.save(persisted);

    const loaded = new V2DurabilityCoordinator(storage);
    const activation = loaded.activate(world({ generation: "generation-loaded-cut" }));
    expect(activation.kind).toBe("ROLLBACK");
    expect(loaded.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(loaded.isCommandOutsideActiveCheckpoint("post-cut-road")).toBe(true);
    loaded.saveProjectState(deliveredProjectState("intent:new-branch-project", "PLANNED"));
    expect(loaded.activate(world({ generation: "generation-loaded-cut", bridge: "bridge-reconnected" })).kind).toBe(
      "SAME_WORLD_RECONNECT",
    );
    expect(loaded.projectState()).toMatchObject({ intent: { id: "intent:new-branch-project" }, tranche: { stage: "PLANNED" } });
    const restarted = new V2DurabilityCoordinator(storage);
    expect(restarted.activate(world({ generation: "generation-loaded-cut", bridge: "bridge-restarted" })).kind).toBe(
      "SAME_WORLD_RECONNECT",
    );
    expect(restarted.projectState()).toMatchObject({ intent: { id: "intent:new-branch-project" }, tranche: { stage: "PLANNED" } });
  });

  test("an effect included at or before the loaded checkpoint cut remains current and is not reopened", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-before-cut"));
    transition(first, "road-before-cut", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:before-cut", "ROAD_DELIVERED"));
    first.recordCheckpoint(receipt(SAVE_B), 1);

    const loaded = new V2DurabilityCoordinator(storage);
    loaded.activate(world({ checkpoint: SAVE_B, generation: "generation-before-cut" }));
    expect(loaded.activeCheckpointJournalPosition()).toBe(1);
    expect(loaded.isCommandOutsideActiveCheckpoint("road-before-cut")).toBe(false);
    expect(loaded.canClassifyCommandRolledBack(loaded.snapshot().commands[0])).toBe(false);
    expect(loaded.commandJournal.get("road-before-cut")?.status).toBe("OBSERVED_MATCH");
    expect(loaded.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
  });

  test("same-save reload can classify a post-checkpoint command as rolled back", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("road-after-checkpoint"));
    coordinator.activate(world({ generation: "generation-b" }));
    const entry = coordinator.reconciliationRequired()[0];
    expect(coordinator.activeCheckpointJournalPosition()).toBe(0);
    expect(entry.position).toBe(1);
    expect(coordinator.canClassifyCommandRolledBack(entry)).toBe(true);
  });

  test("PLACE_BUILDING rollback keeps terminal history immutable and outside the active placement scope", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const placement = utilityCommand("facility-placement-after-cut", "CREATED");
    first.commandJournal.create(placement);
    transition(first, placement.commandId, "OBSERVED_MATCH");
    const historical = first.snapshot().commands.find((entry) => entry.record.commandId === placement.commandId)!;

    const loaded = new V2DurabilityCoordinator(storage);
    expect(loaded.activate(world({ generation: "generation-before-facility" })).kind).toBe("ROLLBACK");

    const after = loaded.snapshot().commands.find((entry) => entry.record.commandId === placement.commandId)!;
    expect(after).toEqual(historical);
    expect(loaded.commandJournal.get(placement.commandId)).toEqual(historical.record);
    expect(loaded.canClassifyCommandRolledBack(after)).toBe(true);
    const placementScope = {
      projectId: "project-a",
      trancheId: "tranche-a",
      reservationRef: "reservation-a",
      utilityKind: "electricity",
    } as const;
    expect(loaded.utilityPlacementOperations(placementScope)).toHaveLength(1);
    loaded.recordCurrentWorldObservation({
      commandId: placement.commandId,
      currentWorldEffectPresent: false,
      currentWorldObjectiveSatisfied: false,
      evidence: "complete authoritative building inventory has no matching facility",
    });
    expect(loaded.checkpointRecoveryWitness(placement.commandId)).toMatchObject({ currentWorldEffectPresent: false });
    expect(loaded.utilityPlacementOperations(placementScope)).toEqual([]);

    // The rolled-back placement remains historical authority only. A new
    // current-branch plan must mint a different command identity.
    const next = utilityCommand("facility-placement-current-branch", "CREATED");
    loaded.commandJournal.create(next);
    expect(loaded.commandJournal.get(next.commandId)).toBeDefined();
    expect(loaded.commandJournal.get(placement.commandId)).toEqual(historical.record);
  });

  test("facility placement authority is isolated by durable placement scope while legacy records stay in the root scope", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const siteA = utilityCommand("facility-site-a", "CREATED");
    coordinator.commandJournal.create(siteA);
    transition(coordinator, siteA.commandId, "OBSERVED_MATCH");
    const siteB = utilityCommand("facility-site-b", "CREATED", {
      placementScopeId: "utility-placement:site-b", x: 25,
    });
    coordinator.commandJournal.create(siteB);
    transition(coordinator, siteB.commandId, "OBSERVED_MATCH");

    const base = { projectId: "project-a", trancheId: "tranche-a", reservationRef: "reservation-a", utilityKind: "electricity" as const };
    expect(coordinator.utilityPlacementOperations(base)?.map((operation) => operation.commandId)).toEqual([siteA.commandId]);
    expect(coordinator.utilityPlacementOperations({ ...base, placementScopeId: "utility-placement:site-b" })
      ?.map((operation) => operation.commandId)).toEqual([siteB.commandId]);
    expect(commandIdempotencyKey(siteA)).not.toBe(commandIdempotencyKey(siteB));
  });

  test("rollback classification is rejected for a different checkpoint or later checkpoint cut", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("road-after-checkpoint"));
    coordinator.recordCheckpoint(receipt(SAVE_B), 1);
    coordinator.activate(world({ checkpoint: SAVE_A, generation: "generation-b" }));
    const entry = coordinator.reconciliationRequired()[0];
    expect(coordinator.canClassifyCommandRolledBack(entry)).toBe(false);
  });

  test("exact loaded checkpoint cut supports new planning only after authoritative current-world absence", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage, () => new Date("2026-09-22T17:36:13.968Z"));
    first.activate(world());
    first.commandJournal.create(command("road-after-checkpoint"));
    transition(first, "road-after-checkpoint", "OBSERVED_MATCH");
    first.recordCheckpoint(receipt(SAVE_B), 1);

    const loaded = new V2DurabilityCoordinator(storage, () => new Date("2026-09-26T01:00:00.000Z"));
    loaded.activate(world({ generation: "generation-loaded" }));
    expect(loaded.isCommandOutsideActiveCheckpoint("road-after-checkpoint")).toBe(true);
    expect(loaded.roadObservationProvenance("road-after-checkpoint")).toMatchObject({
      proof: "REGISTERED_CHECKPOINT_CUT_EXCLUDES_COMMAND",
      baseCheckpointId: SAVE_A,
      lineageCheckpointIds: [SAVE_A],
    });
    expect(loaded.checkpointRecoveryWitness("road-after-checkpoint")).toBeNull();

    loaded.recordCurrentWorldObservation({
      commandId: "road-after-checkpoint",
      currentWorldEffectPresent: true,
      currentWorldObjectiveSatisfied: true,
      evidence: "authoritative road effect present",
    });
    expect(loaded.checkpointRecoveryWitness("road-after-checkpoint")).toBeNull();

    loaded.recordCurrentWorldObservation({
      commandId: "road-after-checkpoint",
      currentWorldEffectPresent: false,
      currentWorldObjectiveSatisfied: false,
      evidence: "complete authoritative road list has no matching effect",
    });
    expect(loaded.checkpointRecoveryWitness("road-after-checkpoint")).toMatchObject({
      currentWorldEffectPresent: false,
      worldEpochId: loaded.snapshot().active?.worldEpochId,
    });
    // The older broad rollback classifier remains fail-closed when later
    // checkpoints exist; the new proof is scoped to this exact loaded save.
    expect(loaded.canClassifyCommandRolledBack(loaded.snapshot().commands[0])).toBe(false);
  });

  test("same-lineage terminal operation cannot be reopened by checkpoint recovery proof", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("road-in-current-lineage"));
    transition(coordinator, "road-in-current-lineage", "OBSERVED_MATCH");
    coordinator.recordCurrentWorldObservation({
      commandId: "road-in-current-lineage",
      currentWorldEffectPresent: false,
      currentWorldObjectiveSatisfied: false,
      evidence: "authoritative absence",
    });
    expect(coordinator.isCommandOutsideActiveCheckpoint("road-in-current-lineage")).toBe(false);
    expect(coordinator.checkpointRecoveryWitness("road-in-current-lineage")).toBeNull();
  });

  test("reloading a different registered save in one lineage selects that save's own journal cut", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    coordinator.activate(world({ checkpoint: SAVE_A, purpose: "LoadGame", generation: "generation-loaded" }));
    coordinator.commandJournal.create(command("command-a"));
    coordinator.recordCheckpoint(receipt(SAVE_A, "generation-loaded"), 1);
    coordinator.commandJournal.create({
      ...command("command-b"),
      authorizedScope: { ...command("command-b").authorizedScope, exactInput: "road-fixture-b" } as V2CommandRecord["authorizedScope"],
    });
    coordinator.recordCheckpoint(receipt(SAVE_B, "generation-loaded"), 2);

    // The loaded save is one this store certified, so it is a reload of this
    // lineage - not a "different save" - and it binds its own journal cut rather
    // than the cut of whatever save this process happened to be on before.
    const reloaded = coordinator.activate(world({ checkpoint: SAVE_B, generation: "generation-b" }));
    expect(reloaded.kind).toBe("SAME_SAVE_RELOAD");
    expect(coordinator.snapshot().active?.loadedCheckpointId).toBe(SAVE_B);
    expect(coordinator.activeCheckpointJournalPosition()).toBe(2);
  });

  test("canonical acceptance checkpoint appends after the immutable baseline and advances the active boundary", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    coordinator.commandJournal.create(command("phase-a-road"));

    const registered = coordinator.recordCheckpoint(receipt(SAVE_B), coordinator.currentJournalPosition());
    const snapshot = coordinator.snapshot();

    expect(registered).toMatchObject({
      checkpointId: SAVE_B,
      journalPosition: 1,
      purpose: "PERIODIC",
      worldId: `cs2-session:${WORLD_A}`,
      saveMetadataAssetGuid: "meta-b",
      saveDataAssetGuid: "data-b",
    });
    expect(snapshot.certifiedRollbackAnchor).toMatchObject({ checkpointId: SAVE_A, journalPosition: 0 });
    expect(snapshot.active?.rollbackBoundaryId).toBe(SAVE_B);
    expect(snapshot.checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual([expect.stringContaining("unsaved:"), SAVE_A, SAVE_B]);
    expect(storage.load()).toMatchObject({ active: { rollbackBoundaryId: SAVE_B }, certifiedRollbackAnchor: { checkpointId: SAVE_A } });
  });

  test("save success with a stale receipt fails closed without replacing the baseline", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    coordinator.commandJournal.create(command("phase-a-road"));

    expect(() => coordinator.recordCheckpoint(receipt(SAVE_B, "wrong-generation"), 1)).toThrow(
      "stale or mismatched save checkpoint receipt",
    );
    expect(coordinator.snapshot().active?.rollbackBoundaryId).toBe(SAVE_A);
    expect(coordinator.snapshot().certifiedRollbackAnchor?.checkpointId).toBe(SAVE_A);
    expect(coordinator.snapshot().checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual([expect.stringContaining("unsaved:"), SAVE_A]);
  });

  test("registered canonical checkpoint reloads with its exact journal cut while an unregistered save re-baselines", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    coordinator.commandJournal.create(command("phase-a-road"));
    coordinator.recordCheckpoint(receipt(SAVE_B), 1);

    const restarted = new V2DurabilityCoordinator(storage);
    const accepted = restarted.activate(world({ checkpoint: SAVE_B, generation: "generation-reloaded" }));
    expect(accepted.kind).toBe("SAME_SAVE_RELOAD");

    // A save this store never registered is no longer "rejected": the world is
    // the authority after a Load, so the activation re-baselines on the loaded
    // world. The inherited project state is retired to a placeholder while the
    // journal is kept as history rather than authority.
    const unregistered = restarted.activate(world({ checkpoint: "save:unknown-meta:unknown-data", generation: "generation-other" }));
    expect(unregistered.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(unregistered.blockedReason).toBeNull();
    expect(restarted.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(restarted.snapshot().commands).toHaveLength(1);
  });

  test("new game receives clean world selection semantics", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const result = coordinator.activate(
      world({ session: WORLD_B, checkpoint: null, generation: "generation-new", purpose: "NewGame" }),
    );
    expect(result.kind).toBe("NEW_GAME");
    expect(result.blockedReason).toBeNull();
    expect(coordinator.reconciliationRequired()).toEqual([]);
  });

  test("prior-generation Road terminal outcome does not veto a newly keyed current-generation operation", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("command-success"));
    transition(first, "command-success", "OBSERVED_MATCH");
    first.recordCheckpoint(receipt(SAVE_A), 1);

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ checkpoint: SAVE_A, generation: "generation-reload", bridge: "bridge-reload" }));
    const currentGenerationOperation = command("replacement");
    currentGenerationOperation.authorizedScope.worldGeneration = "generation-reload";
    expect(commandIdempotencyKey(currentGenerationOperation)).not.toBe(commandIdempotencyKey(command("prior-generation")));
    expect(() => restarted.assertMutationAllowed(commandIdempotencyKey(currentGenerationOperation))).not.toThrow();
    expect(restarted.commandJournal.get("command-success")).toMatchObject({ status: "OBSERVED_MATCH" });
  });

  test("terminal Utility effect survives reload and prevents duplicate facility/network writes", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    const completed = utilityCommand("utility-success");
    first.commandJournal.create(completed);
    transition(first, completed.commandId, "OBSERVED_MATCH");
    first.recordCheckpoint(receipt(SAVE_A), 1);

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ checkpoint: SAVE_A, generation: "generation-reload", bridge: "bridge-reload" }));
    expect(() => restarted.assertMutationAllowed(commandIdempotencyKey(completed))).toThrow(
      "durable terminal success prevents duplicate world write",
    );
  });

  test("submitted or unknown command is never auto-replayed", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("command-pending", "SUBMITTED"));
    first.recordCheckpoint(receipt(SAVE_A), 1);

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ generation: "generation-reload" }));
    expect(restarted.reconciliationRequired().map((entry) => entry.record.commandId)).toEqual(["command-pending"]);
    expect(() => restarted.assertMutationAllowed(commandIdempotencyKey(command("replacement")))).toThrow(
      "restart reconciliation is required",
    );
  });

  test("ROAD receipt ACK remains submitted and requires effect reconciliation", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("command-ack"));
    transition(coordinator, "command-ack", "COMMIT_ACK");
    expect(coordinator.snapshot().commands[0]).toMatchObject({ outcome: "SUBMITTED" });
    expect(coordinator.reconciliationRequired().map((entry) => entry.record.commandId)).toEqual(["command-ack"]);
  });

  test("legacy ROAD APPLIED/MATCH without topology evidence is migrated back to reconciliation", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("legacy-ack"));
    transition(first, "legacy-ack", "COMMIT_ACK");
    const poisoned = first.snapshot();
    poisoned.commands[0].outcome = "APPLIED";
    poisoned.commands[0].record.reconciliationStatus = "MATCH";
    storage.save(poisoned);
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world());
    expect(restarted.reconciliationRequired().map((entry) => entry.record.commandId)).toEqual(["legacy-ack"]);
    expect(restarted.commandJournal.get("legacy-ack")).toMatchObject({ reconciliationStatus: "INCONCLUSIVE" });
  });

  test("observed world match reconciles an uncertain command to terminal success", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("command-observed", "UNKNOWN_TRANSPORT"));
    const entry = coordinator.reconcile("command-observed", { result: "MATCH", reason: "exact geometry exists" });
    expect(entry.outcome).toBe("OBSERVED_MATCH");
    expect(entry.record.status).toBe("OBSERVED_MATCH");
  });

  test("a proven execution-time mismatch stays terminal and cannot be rewritten as match later", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("command-mismatch"));
    transition(coordinator, "command-mismatch", "OBSERVED_MISMATCH");
    const original = coordinator.commandJournal.get("command-mismatch");
    expect(coordinator.snapshot().commands[0].outcome).toBe("FAILED");
    expect(coordinator.reconciliationRequired().map((entry) => entry.record.commandId)).not.toContain("command-mismatch");

    const later = coordinator.reconcile("command-mismatch", { result: "MATCH", reason: "authorized effect is present now" });
    expect(later.outcome).toBe("FAILED");
    expect(later.record.status).toBe("OBSERVED_MISMATCH");
    expect(later.record.effectAbsenceProven).toBe(false);
    expect(later.record.statusHistory.map((entry) => entry.status)).toEqual(original?.statusHistory.map((entry) => entry.status));
  });

  test("restores the historical mismatch when an older descendant matcher rewrote it as match", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("command-overwritten-mismatch"));
    transition(first, "command-overwritten-mismatch", "OBSERVED_MISMATCH");
    first.commandJournal.update("command-overwritten-mismatch", (current) => ({
      ...current,
      failureOrUnknownReason: "one or more unauthorized cells changed",
      statusHistory: current.statusHistory.map((item) => item.status === "OBSERVED_MISMATCH"
        ? { ...item, reason: "one or more unauthorized cells changed" } : item),
    }));
    const poisoned = first.snapshot();
    poisoned.commands[0].outcome = "OBSERVED_MATCH";
    poisoned.commands[0].record.status = "OBSERVED_MATCH";
    poisoned.commands[0].record.statusHistory.push({ status: "OBSERVED_MATCH", at: "2026-09-14T00:00:03.000Z", reason: "old descendant subset matcher" });
    storage.save(poisoned);

    const restored = new V2DurabilityCoordinator(storage).snapshot().commands[0];
    expect(restored.outcome).toBe("FAILED");
    expect(restored.record.status).toBe("OBSERVED_MISMATCH");
    expect(restored.record.reconciliationStatus).toBe("MISMATCH");
    expect(restored.record.failureOrUnknownReason).toBe("one or more unauthorized cells changed");
    expect(restored.record.statusHistory.map((entry) => entry.status)).toEqual([
      "CREATED", "OBSERVED_MISMATCH", "OBSERVED_MATCH",
    ]);
  });

  test("failed command remains failed during reconciliation", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("command-failed", "FAILED_BEFORE_SUBMIT"));
    const entry = coordinator.reconcile("command-failed", { result: "MATCH", reason: "irrelevant later match" });
    expect(entry.outcome).toBe("FAILED");
    expect(entry.record.status).toBe("FAILED_BEFORE_SUBMIT");
  });

  test("world identity mismatch blocks inherited action reconciliation", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    coordinator.commandJournal.create(command("command-world-a", "SUBMITTED"));
    coordinator.activate(world({ session: WORLD_B, checkpoint: null, generation: "generation-b", purpose: "NewGame" }));
    expect(() => coordinator.reconcile("command-world-a", { result: "MATCH", reason: "wrong city" })).toThrow(
      "world identity mismatch",
    );
  });

  test("stale checkpoint receipt is rejected", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    expect(() => coordinator.recordCheckpoint(receipt(SAVE_A, "stale-generation"), 0)).toThrow(
      "stale or mismatched save checkpoint receipt",
    );
  });

  test("unknown checkpoint identity fails closed without changing active execution", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const before = coordinator.projectState();
    expect(() => coordinator.activate(world({ checkpoint: "save:foreign:foreign-data", generation: "generation-b" })))
      .toThrow("EXECUTION_BRANCH_CLASSIFICATION_UNKNOWN");
    expect(coordinator.projectState()).toEqual(before);
  });

  test("malformed durable state fails closed", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage({ schemaVersion: "corrupt" }));
    expect(() => coordinator.activate(world())).toThrow("V2 durable state is malformed; fail closed");
  });

  test("unknown native load identity fails closed", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    const unknown = world() as ReturnType<typeof world> & { world: { loadPurpose: string } };
    unknown.world.loadPurpose = "Unknown";
    expect(() => coordinator.activate(unknown)).toThrow("native world load purpose is unknown");
  });

  test("creates an authority-backed child continuation at a registered checkpoint cut", () => {
    const parentStorage = createMemoryDurableStateStorage();
    parentStorage.namespaceId = "parent-canonical";
    const childStorage = createMemoryDurableStateStorage();
    childStorage.namespaceId = "child-continuation";
    const parent = new V2DurabilityCoordinator(parentStorage);
    parent.activate(world({ checkpoint: null, purpose: "NewGame" }));
    parent.recordBaselineCheckpoint(receipt(SAVE_A));
    const project = planStarterResidentialIntent({ intentId: "intent:continuation", targetResidents: 12, maximumBudget: 25_000,
      planningEnvelope: { center: { x: 0, z: 0 }, radius: 200 }, siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }] });
    (project.tranche as any).utilityExecution = {
      utilities: { electricity: { candidateLedger: [{ kind: "direct-cable", ledgerState: "NOT_ATTEMPTED", commandId: null }], authorizedSpend: 321, constructionAttempts: 1, observationWaits: 2, connectionRecovery: { consumed: false } } },
      marker: "snapshot-S3",
    };
    parent.saveProjectState(project);
    for (const id of ["phase-a-1", "phase-a-2", "phase-a-3"]) {
      parent.commandJournal.create({
        ...command(id, "OBSERVED_MATCH"),
        authorizedScope: { ...command(id, "OBSERVED_MATCH").authorizedScope, exactInput: `road-${id}`, fingerprint: `fingerprint-${id}` },
      });
    }
    const checkpoint = parent.recordCheckpoint(receipt(SAVE_B), 3);
    const terminal = {
      ...utilityCommand("terminal", "CREATED"),
      authorizedScope: { ...utilityCommand("terminal").authorizedScope, exactInput: "terminal-exact" },
    };
    parent.commandJournal.create(terminal);
    parent.commandJournal.update("terminal", (current) => ({ ...current, status: "AUTHORIZED" }));
    const parentBefore = parent.snapshot();
    const provenance = parent.createContinuationFromCheckpoint({
      continuationId: "phase-b-run-1", parentNamespaceId: "parent-canonical", checkpointId: SAVE_B,
      saveMetadataAssetGuid: "meta-b", saveDataAssetGuid: "data-b", expectedWorld: {
        ...((new V2DurabilityCoordinator(createMemoryDurableStateStorage())).activate(world({ checkpoint: SAVE_B, generation: "generation-reloaded" })).world),
      }, journalPosition: 3, childStorage,
    });
    const child = childStorage.value() as any;
    expect(provenance).toMatchObject({ continuationId: "phase-b-run-1", parentCheckpointId: SAVE_B, parentJournalPosition: 3 });
    expect(child.continuation).toEqual(provenance);
    expect(child.journalPosition).toBe(3);
    expect(child.commands.map((entry: any) => entry.record.commandId)).toEqual(["phase-a-1", "phase-a-2", "phase-a-3"]);
    expect(child.projectState).toEqual(checkpoint.projectState);
    expect(child.projectState.tranche.utilityExecution).toMatchObject({ marker: "snapshot-S3", utilities: { electricity: { authorizedSpend: 321, constructionAttempts: 1, observationWaits: 2 } } });
    expect(child.projectState.tranche.utilityExecution.utilities.electricity.candidateLedger[0]).toMatchObject({ kind: "direct-cable", ledgerState: "NOT_ATTEMPTED", commandId: null });
    expect(parent.snapshot()).toEqual(parentBefore);
    expect(parent.commandJournal.get("terminal")).toMatchObject({ commandId: "terminal", status: "AUTHORIZED", submittedAt: null });
  });

  test("legacy LoadGame onboarding candidate is admissible and reaches activation via a certified baseline", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(world({ checkpoint: null, purpose: "LoadGame" }));
    expect(activation.status).toBe("BASELINE_CHECKPOINT_REQUIRED");
    expect(activation.world.legacyOnboardingCandidate).toBe(true);
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    expect(coordinator.activate(world({ checkpoint: null, purpose: "LoadGame" })).status).toBe("ACTIVATED_IN_PLACE");
    expect(coordinator.snapshot().certifiedRollbackAnchor).toMatchObject({
      checkpointId: SAVE_A, journalPosition: 0, status: "CERTIFIED",
    });
  });

  test("a loaded save with bound save-data but no checkpoint identity stays fail-closed", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    const corrupted: any = world({ checkpoint: SAVE_A, purpose: "LoadGame" });
    corrupted.world.checkpointId = null;
    expect(() => coordinator.activate(corrupted)).toThrow("loaded save lacks native checkpoint identity");
  });

  test("a different world is classified without inheriting the current branch", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);

    coordinator.activate(world({ session: WORLD_A, checkpoint: null, purpose: "NewGame" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A, "generation-a", WORLD_A));
    coordinator.commandJournal.create(command("world-a-command"));

    const activation = coordinator.activate(world({ session: WORLD_B, checkpoint: null, purpose: "LoadGame", generation: "generation-b" }));
    expect(activation.kind).toBe("DIFFERENT_WORLD");
    // `projectAuthority()` was deleted with the quarantine vocabulary. The fact
    // it stood for - no branch is inherited across worlds - is asserted directly:
    // the project state is a placeholder and no Goal plan survived the switch.
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(coordinator.snapshot().goalWorkOrders ?? []).toEqual([]);
    expect(coordinator.snapshot().commands.map((entry) => entry.record.commandId)).toEqual(["world-a-command"]);
  });

  test("a new native game on a previously seen world starts a clean execution branch", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ session: WORLD_A, checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A, "generation-a", WORLD_A));
    const firstBranch = first.executionBranchId();
    first.activate(world({ session: WORLD_B, checkpoint: null, purpose: "NewGame", generation: "generation-b", generationOrigin: "LOAD_COMPLETED" }));
    first.recordBaselineCheckpoint(receipt(SAVE_B, "generation-b", WORLD_B));
    const secondBranch = first.executionBranchId();
    expect(secondBranch).not.toBe(firstBranch);

    const restarted = new V2DurabilityCoordinator(storage);
    expect(restarted.activate(world({ session: WORLD_B, checkpoint: null, purpose: "NewGame", generation: "generation-b" })).status)
      .toBe("ACTIVATED_IN_PLACE");
    expect(restarted.executionBranchId()).toBe(secondBranch);
    const newGameA = restarted.activate(world({ session: WORLD_A, checkpoint: null, purpose: "NewGame", generation: "generation-a2", generationOrigin: "LOAD_COMPLETED" }));
    expect(newGameA.status).toBe("BASELINE_CHECKPOINT_REQUIRED");
    expect(restarted.executionBranchId()).not.toBe(firstBranch);
    expect(restarted.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(restarted.snapshot().commands).toHaveLength(0);
  });
});

/**
 * A Gate 1 project state that already delivered its certified ROAD. The durable
 * coordinator does not care how a stage was reached; these tests only exercise
 * which recorded project state an activation is allowed to keep.
 */
function deliveredProjectState(intentId: string, stage = "ROAD_DELIVERED" as const) {
  const state = planStarterResidentialIntent({
    intentId,
    targetResidents: 12,
    maximumBudget: 10_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
    siteCandidates: [{ id: "site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
  });
  return { ...state, tranche: { ...state.tranche, stage } };
}

describe("checkpoint activation restores project state at the loaded journal cut", () => {
  test("a same-save rollback marks the command rolled back and restores the checkpoint snapshot", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-reload"));
    transition(first, "road-reload", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:reload"));

    // The bound checkpoint is the save this world was first observed on. Its
    // cut predates the ROAD, so activation restores its project snapshot while
    // keeping the future command immutable in history.
    const reloaded = new V2DurabilityCoordinator(storage);
    const activation = reloaded.activate(world({ generation: "generation-b", bridge: "bridge-b" }));
    expect(activation.kind).toBe("ROLLBACK");
    expect(reloaded.canClassifyCommandRolledBack(reloaded.snapshot().commands[0])).toBe(true);
    expect(reloaded.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(reloaded.snapshot().commands).toHaveLength(1);
  });

  test("2. a process restart onto the same canonical store keeps ROAD_DELIVERED", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-restart"));
    transition(first, "road-restart", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:restart"));

    const restarted = new V2DurabilityCoordinator(storage);
    expect(restarted.activate(world({ bridge: "bridge-restarted" })).kind).toBe("SAME_WORLD_RECONNECT");
    expect(restarted.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
  });

  test("3. reloading onto a certified descendant checkpoint keeps ROAD_DELIVERED", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    first.commandJournal.create(command("road-descendant"));
    transition(first, "road-descendant", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:descendant"));
    first.recordCheckpoint(receipt(SAVE_B), first.currentJournalPosition());

    const reloaded = new V2DurabilityCoordinator(storage);
    const activation = reloaded.activate(world({ checkpoint: SAVE_B, generation: "generation-reloaded" }));
    expect(activation.kind).toBe("SAME_SAVE_RELOAD");
    expect(reloaded.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
  });

  test("4. a rollback onto a checkpoint that predates the ROAD restores the older state", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.saveProjectState(deliveredProjectState("intent:pre-road", "PLANNED"));
    const baseline = first.recordBaselineCheckpoint(receipt(SAVE_A));
    expect(baseline.journalPosition).toBe(0);
    first.activate(world({ checkpoint: SAVE_A, purpose: "LoadGame", generation: "generation-loaded" }));
    first.commandJournal.create(command("road-rolled-back"));
    transition(first, "road-rolled-back", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:rolled-back"));

    const rolledBack = new V2DurabilityCoordinator(storage);
    const activation = rolledBack.activate(world({ checkpoint: SAVE_A, generation: "generation-rolled-back" }));
    expect(activation.kind).toBe("ROLLBACK");
    expect(rolledBack.projectState()).toMatchObject({ tranche: { stage: "PLANNED" } });
  });

  test("a contentless rollback boundary restores its checkpoint state instead of retaining future progression", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-contentless-rollback"));
    transition(first, "road-contentless-rollback", "OBSERVED_MATCH");
    const admitted = deliveredProjectState("intent:contentless-rollback");
    first.saveProjectState(admitted);

    const rolledBack = new V2DurabilityCoordinator(storage);
    const activation = rolledBack.activate(world({ generation: "generation-contentless-rollback" }));

    expect(activation.kind).toBe("ROLLBACK");
    expect(rolledBack.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(rolledBack.canClassifyCommandRolledBack(rolledBack.snapshot().commands[0])).toBe(true);
    expect(rolledBack.reconciliationRequired()).toEqual([]);
  });

  test("a rollback boundary with authoritative replacement state does not preserve the stale project", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-replacement-rollback"));
    transition(first, "road-replacement-rollback", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:stale-project"));
    const durable = storage.value() as any;
    const boundary = durable.checkpoints.find((entry: any) => entry.checkpointId === SAVE_A);
    boundary.projectState = deliveredProjectState("intent:authoritative-replacement", "PLANNED");
    storage.save(durable);

    const rolledBack = new V2DurabilityCoordinator(storage);
    expect(rolledBack.activate(world({ generation: "generation-authoritative-replacement" })).kind).toBe("ROLLBACK");
    expect(rolledBack.projectState()).toMatchObject({ intent: { id: "intent:authoritative-replacement" }, tranche: { stage: "PLANNED" } });
  });

  test("a contentless rollback does not retain a superseded project", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-superseded-rollback"));
    transition(first, "road-superseded-rollback", "OBSERVED_MATCH");
    const admitted = deliveredProjectState("intent:stale-on-rollback");
    first.saveProjectState(admitted);
    first.recordProjectSupersession({
      supersessionId: "supersession:stale-on-rollback",
      projectId: admitted.project.id,
      intentId: admitted.intent.id,
      trancheId: admitted.tranche.id,
      reservationRef: admitted.tranche.reservationRef,
      supersededState: admitted,
      reason: "ADMISSION_INVALIDATED",
      detail: "test supersession",
    });

    const rolledBack = new V2DurabilityCoordinator(storage);
    expect(rolledBack.activate(world({ generation: "generation-superseded-rollback" })).kind).toBe("ROLLBACK");
    expect(rolledBack.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("a contentless rollback does not carry an ACTIVE execution authorization into the new generation", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-active-auth-rollback"));
    transition(first, "road-active-auth-rollback", "OBSERVED_MATCH");
    const admitted = deliveredProjectState("intent:active-auth-rollback");
    first.saveProjectState(admitted);
    first.recordUtilityBudgetAmendment({
      amendmentId: "active-auth-before-rollback",
      state: admitted,
      originalProjectBudget: admitted.project.maximumBudget,
      requiredUtilityBudget: admitted.project.maximumBudget,
      amendedEffectiveBudget: admitted.project.maximumBudget,
      status: "ACTIVE",
      detail: "fixture authorization that must not cross a rollback boundary",
    });

    const rolledBack = new V2DurabilityCoordinator(storage);
    expect(rolledBack.activate(world({ generation: "generation-active-auth-rollback" })).kind).toBe("ROLLBACK");
    expect(rolledBack.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(rolledBack.snapshot().utilityBudgetAmendments?.filter((entry) => entry.status === "ACTIVE")).toHaveLength(1);
  });

  test("same-save rollback preserves a rejected partial utility attempt and records current effect absent without replay", () => {
    const storage = createMemoryDurableStateStorage();
    const beforeRepair = new V2DurabilityCoordinator(storage);
    beforeRepair.activate(world({ checkpoint: SAVE_A, generation: "generation-before-attempt" }));
    const partial = utilityCommand("access-road-attempt-2", "CREATED");
    partial.actionType = "build_road+build_road";
    partial.authorizedScope.exactInput = JSON.stringify([
      { type: "build_road", prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 },
      { type: "build_road", prefab: "Small Road", x1: 3, z1: 4, x2: 5, z2: 6 },
    ]);
    partial.observationEvidence = [{
      phase: "RECONCILIATION",
      observationId: "attempt-2-partial-effect",
      coherence: "STABLE_FRAME",
      recordedAt: "2026-09-23T18:00:00.000Z",
      summary: "historical action 0 effect confirmed; action 1 absent",
      details: { authorization: "CONSUMED_EXACTLY_ONCE", action0: "EFFECT_PRESENT", action1: "EFFECT_ABSENT" },
    }];
    beforeRepair.commandJournal.create(partial);
    transition(beforeRepair, partial.commandId, "REJECTED");

    const rolledBack = new V2DurabilityCoordinator(storage);
    rolledBack.activate(world({ checkpoint: SAVE_A, generation: "generation-after-user-rollback" }));
    const entry = rolledBack.snapshot().commands.find((candidate) => candidate.record.commandId === partial.commandId);
    expect(entry).toBeDefined();
    expect(rolledBack.canClassifyCommandRolledBack(entry!)).toBe(true);
    expect(rolledBack.reconciliationRequired()).toEqual([]);
    expect(commandRetrySafety(rolledBack.commandJournal.get(partial.commandId)!)).toMatchObject({
      automaticResendAllowed: false,
      next: "CREATE_NEW_COMMAND",
    });

    const currentObservation = rolledBack.recordCurrentWorldObservation({
      commandId: partial.commandId,
      currentWorldEffectPresent: false,
      currentWorldObjectiveSatisfied: false,
      evidence: JSON.stringify({
        classification: "EFFECT_ABSENT_DUE_TO_USER_ROLLBACK",
        checkpointId: SAVE_A,
        checkpointJournalPosition: 0,
        commandPosition: entry!.position,
        authoritativeReadback: "complete current-world Small Road list contains neither exact repair action",
      }),
    });
    expect(currentObservation).toMatchObject({
      historicalVerdict: { status: "REJECTED", effectAbsenceProven: false },
      currentWorldEffectPresent: false,
      currentWorldObjectiveSatisfied: false,
    });
    const after = rolledBack.commandJournal.get(partial.commandId)!;
    expect(after.status).toBe("REJECTED");
    expect(after.observationEvidence).toEqual(partial.observationEvidence);
    expect(rolledBack.worldObservations(partial.commandId)).toEqual([currentObservation]);
  });

  test("5. a sibling save inherits no authority, and the re-baseline retires the inherited plan", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-sibling"));
    transition(first, "road-sibling", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:sibling"));

    const sibling = new V2DurabilityCoordinator(storage);
    const activation = sibling.activate(world({ checkpoint: "save:meta-c:data-c", generation: "generation-c" }));

    // No authority of any kind. The sibling is no longer quarantined against the
    // journal - that notion is retired - but nothing inherited survives as a plan
    // either: the project state is retired to a placeholder, and writes are held
    // back by the ordinary boundary gate until the loaded save is certified.
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(activation.blockedReason).toBeNull();
    expect(sibling.isExecutionDurablyActivated(activation)).toBe(false);
    expect(() => sibling.commandJournal.create(command("sibling-write")))
      .toThrow("certified durable rollback boundary");
    expect(() => sibling.assertMutationAllowed("any-key"))
      .toThrow("certified durable rollback boundary");
    expect(sibling.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    // The journal is history and observability, not authority: it is retained.
    expect(sibling.snapshot().commands.map((entry) => entry.record.commandId)).toEqual(["road-sibling"]);

    // Certifying the loaded save is what makes it this store's new rollback
    // boundary - never the journal the sibling happened to still be holding.
    sibling.certifyDescendantCheckpoint(receipt("save:meta-c:data-c", "generation-c"));
    expect(sibling.activate(world({ checkpoint: "save:meta-c:data-c", generation: "generation-c" })).status)
      .toBe("ACTIVATED");
  });

  test("6. a different world never inherits the ROAD_DELIVERED project state", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world());
    first.commandJournal.create(command("road-other-world"));
    transition(first, "road-other-world", "OBSERVED_MATCH");
    first.saveProjectState(deliveredProjectState("intent:other-world"));

    const other = new V2DurabilityCoordinator(storage);
    const activation = other.activate(world({ session: WORLD_B, checkpoint: SAVE_B, generation: "generation-other" }));
    expect(activation.kind).toBe("DIFFERENT_WORLD");
    // `projectAuthority()` was deleted with the quarantine vocabulary; assert the
    // fact it stood for directly - no branch is inherited across worlds.
    expect(other.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(other.snapshot().goalWorkOrders ?? []).toEqual([]);
  });

  test("7. a journal that proves the ROAD survives cannot regress the project state", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.saveProjectState(deliveredProjectState("intent:journal", "PLANNED"));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    first.commandJournal.create(command("road-journal"));
    transition(first, "road-journal", "OBSERVED_MATCH");
    // The world is saved while the durable stage still lags the native build, so
    // the certified checkpoint snapshot records the older stage even though the
    // save it certifies already contains the ROAD. The journal position is what
    // proves the work survived, so the newer project state must not regress.
    const checkpoint = first.recordCheckpoint(receipt(SAVE_B), first.currentJournalPosition());
    expect(checkpoint.projectState).toMatchObject({ tranche: { stage: "PLANNED" } });
    first.saveProjectState(deliveredProjectState("intent:journal"));

    const reloaded = new V2DurabilityCoordinator(storage);
    const activation = reloaded.activate(world({ checkpoint: SAVE_B, generation: "generation-reloaded" }));
    expect(activation.kind).toBe("SAME_SAVE_RELOAD");
    expect(reloaded.snapshot().commands).toHaveLength(1);
    expect(reloaded.snapshot().commands[0]).toMatchObject({ position: 1, outcome: "OBSERVED_MATCH" });
    expect(reloaded.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
  });
});

describe("durable utility service-road child operation", () => {
  test("persists the exact course, reuses its deterministic identity, and consumes it once", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(world());
    const state = deliveredProjectState("intent:utility-service-road-child");
    coordinator.saveProjectState(state);
    const exactRoadInput = { prefab: "Small Road", x1: -20, z1: 10, x2: 20, z2: 10 };
    const request = {
      state,
      planRevision: "project-replan:branch-a",
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...exactRoadInput }),
      exactRoadInput,
      authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId,
      authorizationGeneration: activation.world.generation,
      detail: "test utility road child",
    };
    const first = coordinator.recordUtilityServiceRoadChildOperation(request);
    const repeated = coordinator.recordUtilityServiceRoadChildOperation(request);
    expect(repeated.amendmentId).toBe(first.amendmentId);
    expect(repeated.exactRoadInput).toEqual(exactRoadInput);
    expect(coordinator.snapshot().utilityBudgetAmendments?.filter((item) => item.reason === "UTILITY_SERVICE_ROAD_CHILD_OPERATION")).toHaveLength(1);

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ bridge: "bridge-restarted" }));
    const afterReload = restarted.recordUtilityServiceRoadChildOperation(request);
    expect(afterReload.amendmentId).toBe(first.amendmentId);
    expect(afterReload.exactRoadInput).toEqual(exactRoadInput);

    const consumed = restarted.consumeUtilityServiceRoadChildOperation(first.amendmentId, request.courseFingerprint);
    expect(consumed).toMatchObject({ status: "CONSUMED", executionUseLimit: 1, executionUseStatus: "CONSUMED", exactRoadInput });
    expect(() => restarted.consumeUtilityServiceRoadChildOperation(first.amendmentId, request.courseFingerprint)).toThrow(
      "UTILITY_SERVICE_ROAD_CHILD_OPERATION_ALREADY_CONSUMED",
    );
  });

  test("creates one immutable-history planner-input successor with a fresh exact child and reuses it after restart", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(world());
    const oldInput = { prefab: "Small Road", x1: 38.61565, z1: 1389.81421, x2: -191.43368375956618, z2: 1297.0366316214524 };
    const correctedInput = { prefab: "Small Road", x1: -191.433685, z1: 1297.03662, x2: -224.6353, z2: 1316.57654 };
    let state = deliveredProjectState("intent:planner-input-replacement", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const oldTask = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    const branchIdentity = `${activation.world.worldId}|${activation.world.checkpointId}|${coordinator.snapshot().active!.activatedCheckpointJournalCut}`;
    const planRevision = "project-replan:branch-a";
    const oldChild = coordinator.recordUtilityServiceRoadChildOperation({
      state, planRevision, exactRoadInput: oldInput,
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...oldInput }),
      authorizationWorldId: activation.world.worldId, authorizationCheckpointId: activation.world.checkpointId,
      authorizationGeneration: activation.world.generation, detail: "old consumed fixture child",
    });
    coordinator.consumeUtilityServiceRoadChildOperation(oldChild.amendmentId, oldChild.courseFingerprint!);
    oldTask.status = "BLOCKED"; oldTask.attempts = 1; oldTask.maximumAttempts = 1;
    oldTask.terminalOutcomeId = `${oldTask.id}:outcome:terminal`;
    oldTask.childOperationAmendmentId = oldChild.amendmentId;
    const zoningTask = state.tasks.find((candidate) => candidate.kind === "ZONING")!;
    zoningTask.status = "BLOCKED";
    state.tranche.currentTaskIds = { ROAD_CONNECTION: oldTask.id, ZONING: zoningTask.id };
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    state.journal.push({
      id: oldTask.terminalOutcomeId, taskId: oldTask.id, skill: "RoadConnection", proposalId: `${oldTask.id}:attempt:1`,
      recordedAt: "2026-09-26T00:00:00.000Z", admission: "ADMITTED", execution: "UNKNOWN", commandId: null,
      observationId: null, observedEffect: "UNKNOWN", failureClassification: "EXECUTION_UNKNOWN",
      roadPreApplyFailure: { schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1", phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
        taskId: oldTask.id, childId: oldChild.amendmentId, exactInput: oldInput,
        firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false },
      reason: "typed preview-only quote failure; Apply not called",
    });
    coordinator.saveProjectState(state);
    const request = {
      state, expectedCurrentTaskId: oldTask.id, objectiveId: `${state.project.id}:${state.tranche.id}:ROAD_CONNECTION`,
      planRevision, exactRoadInput: correctedInput, authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId!, authorizationGeneration: activation.world.generation,
      activeBranchIdentity: branchIdentity, trigger: "PLANNER_INPUT_CHANGED" as const,
      worldEffect: "PARTIAL" as const, correctedInputAvoidsExistingEffects: true, targetEntityAuthoritative: true,
    };
    const oldSnapshot = structuredClone(coordinator.projectState());
    const contender = new V2DurabilityCoordinator(storage);
    contender.activate(world({ bridge: "bridge-contender" }));
    const first = coordinator.ensurePlannerInputReplacement(request);
    expect(first).toMatchObject({ reused: false, task: { status: "PENDING", attempts: 0, maximumAttempts: 1,
      supersedesTaskId: oldTask.id, supersessionReason: "PLANNER_INPUT_CHANGED" }, child: { status: "ACTIVE", executionUseStatus: "UNUSED" } });
    expect(first.task.childOperationAmendmentId).not.toBe(oldChild.amendmentId);
    expect(first.child.exactRoadInput).toEqual(correctedInput);
    expect(first.state.tranche.currentTaskIds?.ROAD_CONNECTION).toBe(first.task.id);
    expect(first.state.project.status).toBe("BLOCKED");
    expect(first.state.intent.status).toBe("BLOCKED");
    expect(first.state.tasks.find((candidate) => candidate.id === oldTask.id)).toEqual(oldSnapshot.tasks.find((candidate) => candidate.id === oldTask.id));
    expect(first.state.tasks.find((candidate) => candidate.id === oldTask.id)).toMatchObject({ status: "BLOCKED", attempts: 1,
      terminalOutcomeId: oldTask.terminalOutcomeId, childOperationAmendmentId: oldChild.amendmentId });

    const reentry = coordinator.ensurePlannerInputReplacement(request);
    expect(reentry).toMatchObject({ reused: true, task: { id: first.task.id }, child: { amendmentId: first.child.amendmentId } });
    const concurrentWinner = contender.ensurePlannerInputReplacement({ ...request, state: contender.projectState() as typeof state });
    expect(concurrentWinner).toMatchObject({ reused: true, task: { id: first.task.id }, child: { amendmentId: first.child.amendmentId } });
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ bridge: "bridge-restarted" }));
    const afterReload = restarted.ensurePlannerInputReplacement({ ...request, state: restarted.projectState() as typeof state });
    expect(afterReload).toMatchObject({ reused: true, task: { id: first.task.id }, child: { amendmentId: first.child.amendmentId } });
    expect(() => restarted.ensurePlannerInputReplacement({ ...request, state: restarted.projectState() as typeof state,
      exactRoadInput: { ...correctedInput, x2: -220 } })).toThrow("PLANNER_INPUT_REPLACEMENT_BUDGET_EXHAUSTED");
  });

  test("a consumed child cannot authorize replacement with unknown Apply or native completion evidence", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(world());
    const oldInput = { prefab: "Small Road", x1: 0, z1: 10, x2: 10, z2: 10 };
    const state = deliveredProjectState("intent:consumed-child-unknown-effect", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const task = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    const child = coordinator.recordUtilityServiceRoadChildOperation({ state, planRevision: "plan:old", exactRoadInput: oldInput,
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...oldInput }), authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId, authorizationGeneration: activation.world.generation, detail: "old child" });
    coordinator.consumeUtilityServiceRoadChildOperation(child.amendmentId, child.courseFingerprint!);
    task.childOperationAmendmentId = child.amendmentId;
    task.status = "BLOCKED"; task.attempts = 1; task.maximumAttempts = 1; task.terminalOutcomeId = `${task.id}:terminal`;
    state.tranche.currentTaskIds = { ROAD_CONNECTION: task.id };
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    state.journal.push({ id: task.terminalOutcomeId, taskId: task.id, skill: "RoadConnection", proposalId: `${task.id}:attempt:1`,
      recordedAt: "2026-09-26T00:00:00.000Z", admission: "REJECTED", execution: "NOT_REQUIRED", commandId: null,
      observationId: null, observedEffect: "NOT_APPLICABLE", failureClassification: "ADMISSION_REJECTED", reason: "admission rejected" });
    coordinator.saveProjectState(state);
    const branchIdentity = `${activation.world.worldId}|${activation.world.checkpointId}|${coordinator.snapshot().active!.activatedCheckpointJournalCut}`;
    const request = { state, expectedCurrentTaskId: task.id, objectiveId: `${state.project.id}:${state.tranche.id}:ROAD_CONNECTION`,
      planRevision: "plan:new", exactRoadInput: { ...oldInput, x2: 12 }, authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId!, authorizationGeneration: activation.world.generation,
      activeBranchIdentity: branchIdentity, trigger: "PLANNER_INPUT_CHANGED" as const,
      worldEffect: "UNKNOWN" as const, correctedInputAvoidsExistingEffects: false, targetEntityAuthoritative: true };
    expect(coordinator.isRoadPlannerInputReplacementEligible(coordinator.projectState(), task.id)).toBe(false);
    expect(() => coordinator.ensurePlannerInputReplacement(request)).toThrow("PLANNER_INPUT_REPLACEMENT_OLD_CHILD_STILL_EXECUTABLE");

    const terminal = state.journal.find((entry) => entry.id === task.terminalOutcomeId)!;
    terminal.admission = "ADMITTED";
    terminal.execution = "UNKNOWN";
    terminal.observedEffect = "UNKNOWN";
    terminal.failureClassification = "EXECUTION_UNKNOWN";
    terminal.roadPreApplyFailure = { schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1", phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
      taskId: task.id, childId: child.amendmentId, exactInput: oldInput,
      firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false };
    terminal.proposalId = `${task.id}:attempt:1`;
    coordinator.saveProjectState(state);
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, state: coordinator.projectState() as typeof state,
      worldEffect: "UNKNOWN" })).toThrow("PLANNER_INPUT_REPLACEMENT_WORLD_EFFECT_UNKNOWN");
    const native = command("planner-replacement-native-completion-unknown");
    native.status = "NATIVE_COMPLETION_UNKNOWN";
    native.authorizedScope.owner = { ownerType: "TASK", ownerId: task.id };
    coordinator.commandJournal.create(native);
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, state: coordinator.projectState() as typeof state,
      worldEffect: "ABSENT" })).toThrow("PLANNER_INPUT_REPLACEMENT_PREDECESSOR_COMMAND_EVIDENCE_CONFLICT");
  });

  test("ADMISSION_REJECTED alone does not prove an eligible consumed-child pre-Apply failure", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const state = deliveredProjectState("intent:admission-rejected-road-successor", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const task = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    task.status = "BLOCKED"; task.attempts = 1; task.maximumAttempts = 1; task.terminalOutcomeId = `${task.id}:terminal`;
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    state.journal.push({ id: task.terminalOutcomeId, taskId: task.id, skill: "RoadConnection", proposalId: `${task.id}:attempt:1`,
      recordedAt: "2026-09-26T00:00:00.000Z", admission: "REJECTED", execution: "NOT_REQUIRED", commandId: null,
      observationId: null, observedEffect: "NOT_APPLICABLE", failureClassification: "ADMISSION_REJECTED", reason: "admission rejected" });
    coordinator.saveProjectState(state);
    expect(coordinator.isRoadPlannerInputReplacementEligible(coordinator.projectState(), task.id)).toBe(false);
  });

  test("replans a terminal no-child Road task from typed pre-Apply evidence without exhausting or resetting attempts", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(world());
    const oldInput = { prefab: "Small Road", x1: 0, z1: 10, x2: 10, z2: 10 };
    const correctedInput = { ...oldInput, x2: 12 };
    const state = deliveredProjectState("intent:preapply-road-successor", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const oldTask = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    oldTask.status = "BLOCKED"; oldTask.attempts = 1; oldTask.maximumAttempts = 2;
    oldTask.terminalOutcomeId = `${oldTask.id}:outcome:1`;
    state.tranche.currentTaskIds = { ROAD_CONNECTION: oldTask.id };
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    const evidence = (): Gate1RoadPreApplyFailureEvidence => ({
      schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1",
      phase: "ROAD_PREVIEW_QUOTE_VALIDATION", taskId: oldTask.id, childId: null,
      exactInput: oldInput, firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false,
    });
    state.journal.push({
      id: `${oldTask.id}:outcome:1`, taskId: oldTask.id, skill: "RoadConnection" as const,
      proposalId: `${oldTask.id}:attempt:1`, recordedAt: "2026-09-26T00:00:01.000Z",
      admission: "ADMITTED" as const, execution: "UNKNOWN" as const, commandId: null, observationId: null,
      observedEffect: "UNKNOWN" as const, failureClassification: "EXECUTION_UNKNOWN" as const,
      roadPreApplyFailure: evidence(), reason: "native preview rejected before Apply",
    });
    coordinator.saveProjectState(state);
    const branchIdentity = `${activation.world.worldId}|${activation.world.checkpointId}|${coordinator.snapshot().active!.activatedCheckpointJournalCut}`;
    const request = {
      state, expectedCurrentTaskId: oldTask.id, objectiveId: `${state.project.id}:${state.tranche.id}:ROAD_CONNECTION`,
      planRevision: "project-replan:current-world", exactRoadInput: correctedInput,
      authorizationWorldId: activation.world.worldId, authorizationCheckpointId: activation.world.checkpointId!,
      authorizationGeneration: activation.world.generation, activeBranchIdentity: branchIdentity,
      trigger: "PLANNER_INPUT_CHANGED" as const, worldEffect: "ABSENT" as const,
      correctedInputAvoidsExistingEffects: true, targetEntityAuthoritative: true,
    };
    const before = structuredClone(coordinator.projectState());
    expect(coordinator.isRoadPlannerInputReplacementEligible(before, oldTask.id)).toBe(true);
    const replacement = coordinator.ensurePlannerInputReplacement(request);
    expect(replacement).toMatchObject({ reused: false, task: { status: "PENDING", attempts: 0, supersedesTaskId: oldTask.id },
      child: { status: "ACTIVE", executionUseStatus: "UNUSED", exactRoadInput: correctedInput } });
    expect(replacement.state.tasks.find((candidate) => candidate.id === oldTask.id)).toMatchObject({
      status: "BLOCKED", attempts: 1, maximumAttempts: 2, terminalOutcomeId: oldTask.terminalOutcomeId,
    });
    expect(replacement.state).toMatchObject({ project: { status: "ACTIVE" }, intent: { status: "ACTIVE" } });
    expect(replacement.state.tasks.find((candidate) => candidate.id === oldTask.id)).toEqual(before.tasks.find((candidate) => candidate.id === oldTask.id));
    expect(replacement.state.tasks.filter((candidate) => candidate.supersedesTaskId === oldTask.id)).toHaveLength(1);

    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ bridge: "bridge-restarted" }));
    const replay = restarted.ensurePlannerInputReplacement({ ...request, state: restarted.projectState() as typeof state });
    expect(replay).toMatchObject({ reused: true, task: { id: replacement.task.id }, child: { amendmentId: replacement.child.amendmentId } });
    expect(restarted.projectState().tasks.filter((candidate) => candidate.supersedesTaskId === oldTask.id)).toHaveLength(1);
    expect(() => restarted.ensurePlannerInputReplacement({ ...request, state: restarted.projectState() as typeof state,
      exactRoadInput: { ...correctedInput, x2: 14 } })).toThrow("PLANNER_INPUT_REPLACEMENT_BUDGET_EXHAUSTED");
  });

  test("does not expose blocked Road tasks without complete pre-Apply evidence to automatic replacement", () => {
    const coordinator = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    coordinator.activate(world());
    const state = deliveredProjectState("intent:unsafe-road-successor", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const task = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    task.status = "BLOCKED"; task.attempts = task.maximumAttempts; task.terminalOutcomeId = `${task.id}:outcome:terminal`;
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    state.journal.push({ id: task.terminalOutcomeId, taskId: task.id, skill: "RoadConnection", proposalId: `${task.id}:attempt:1`,
      recordedAt: "2026-09-26T00:00:00.000Z", admission: "ADMITTED", execution: "UNKNOWN", commandId: null,
      observationId: null, observedEffect: "UNKNOWN", failureClassification: "EXECUTION_UNKNOWN", reason: "unclassified failure" });
    coordinator.saveProjectState(state);
    expect(coordinator.isRoadPlannerInputReplacementEligible(coordinator.projectState(), task.id)).toBe(false);
    const unrelated = state.tasks.find((candidate) => candidate.kind !== "ROAD_CONNECTION")!;
    unrelated.status = "BLOCKED";
    state.tranche.currentTaskIds = { ROAD_CONNECTION: task.id, [unrelated.kind]: unrelated.id };
    coordinator.saveProjectState(state);
    expect(coordinator.isRoadPlannerInputReplacementEligible(coordinator.projectState(), task.id)).toBe(false);
  });

  test("refuses same material input, unknown effects, and active predecessors", () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(world());
    const oldInput = { prefab: "Small Road", x1: 0, z1: 10, x2: 10, z2: 10 };
    const correctedInput = { ...oldInput, x2: 11 };
    let state = deliveredProjectState("intent:planner-input-replacement-guards", "SITE_SELECTED");
    coordinator.saveProjectState(state);
    const oldTask = state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION")!;
    const branchIdentity = `${activation.world.worldId}|${activation.world.checkpointId}|${coordinator.snapshot().active!.activatedCheckpointJournalCut}`;
    const planRevision = "project-replan:branch-a";
    const oldChild = coordinator.recordUtilityServiceRoadChildOperation({ state, planRevision, exactRoadInput: oldInput,
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...oldInput }), authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId, authorizationGeneration: activation.world.generation, detail: "old child" });
    coordinator.consumeUtilityServiceRoadChildOperation(oldChild.amendmentId, oldChild.courseFingerprint!);
    oldTask.status = "BLOCKED"; oldTask.attempts = 1; oldTask.maximumAttempts = 1; oldTask.terminalOutcomeId = `${oldTask.id}:terminal`;
    oldTask.childOperationAmendmentId = oldChild.amendmentId; state.tranche.currentTaskIds = { ROAD_CONNECTION: oldTask.id };
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    state.journal.push({ id: oldTask.terminalOutcomeId, taskId: oldTask.id, skill: "RoadConnection", proposalId: `${oldTask.id}:attempt:1`,
      recordedAt: "2026-09-26T00:00:00.000Z", admission: "ADMITTED", execution: "UNKNOWN", commandId: null,
      observationId: null, observedEffect: "UNKNOWN", failureClassification: "EXECUTION_UNKNOWN",
      roadPreApplyFailure: { schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1", phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
        taskId: oldTask.id, childId: oldChild.amendmentId, exactInput: oldInput,
        firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false }, reason: "typed pre-Apply failure" });
    coordinator.saveProjectState(state);
    const request = { state, expectedCurrentTaskId: oldTask.id, objectiveId: `${state.project.id}:${state.tranche.id}:ROAD_CONNECTION`,
      planRevision, exactRoadInput: correctedInput, authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId!, authorizationGeneration: activation.world.generation,
      activeBranchIdentity: branchIdentity, trigger: "PLANNER_INPUT_CHANGED" as const,
      worldEffect: "PARTIAL" as const, correctedInputAvoidsExistingEffects: true, targetEntityAuthoritative: true };
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, exactRoadInput: oldInput })).toThrow("PLANNER_INPUT_REPLACEMENT_INPUT_NOT_MATERIALLY_CHANGED");
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, worldEffect: "UNKNOWN" })).toThrow("PLANNER_INPUT_REPLACEMENT_WORLD_EFFECT_UNKNOWN");
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, worldEffect: "COMPLETE" })).toThrow("PLANNER_INPUT_REPLACEMENT_EXISTING_EFFECT_RECONCILIATION_REQUIRED");
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, authorizationGeneration: "stale-generation" })).toThrow("PLANNER_INPUT_REPLACEMENT_ACTIVE_BRANCH_STALE");
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, activeBranchIdentity: `${branchIdentity}:stale` })).toThrow("PLANNER_INPUT_REPLACEMENT_ACTIVE_BRANCH_STALE");
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, correctedInputAvoidsExistingEffects: false })).toThrow("PLANNER_INPUT_REPLACEMENT_PARTIAL_EFFECT_DUPLICATE_RISK");
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, targetEntityAuthoritative: false })).toThrow("PLANNER_INPUT_REPLACEMENT_OBJECTIVE_NOT_ELIGIBLE");
    const inFlight = command("planner-input-replacement-inflight");
    inFlight.authorizedScope.owner = { ownerType: "TASK", ownerId: oldTask.id };
    coordinator.commandJournal.create(inFlight);
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, state: coordinator.projectState() as typeof state }))
      .toThrow("PLANNER_INPUT_REPLACEMENT_PREDECESSOR_COMMAND_EVIDENCE_CONFLICT");
    state = coordinator.projectState() as typeof state;
    state.intent.status = "SATISFIED";
    coordinator.saveProjectState(state);
    expect(() => coordinator.ensurePlannerInputReplacement({ ...request, state })).toThrow("PLANNER_INPUT_REPLACEMENT_OBJECTIVE_NOT_ELIGIBLE");
  });
});

const SAVE_DESCENDANT = "save:meta-descendant:data-descendant";
const DESCENDANT_GENERATION = "generation-descendant";

/**
 * A durable utility execution slice, the shape an interrupted work stream leaves
 * behind. Nothing later can rebuild it: the plan, the ledger, the reservation
 * and the budget authority are all recorded here and nowhere else.
 */
function waterUtilitySlice(projectId: string) {
  return {
    schemaVersion: "ai-mayor-v2-greenfield-utility-execution/1",
    scope: { projectId, maximumSpend: 40272 },
    utilities: {
      water: {
        kind: "water",
        stage: "WAITING_FOR_SERVICE_UPDATE",
        constructionAttempts: 1,
        authorizedSpend: 40288,
        facility: {
          entity: { index: 190180, version: 73 },
          prefab: "GroundwaterPumpingStation01",
          position: { x: -226.909, z: 1283.57007 },
        },
        connector: { node: { index: 190181, version: 73 } },
        plan: {
          position: { x: -226.909, z: 1283.57007 },
          connection: {
            prefab: "Small Water Pipe",
            start: { x: -226.909, z: 1283.57007 },
            end: { x: 38.61565, z: 1389.81421 },
          },
          serviceRoads: [{ start: { x: 38.61565, z: 1389.81421 }, end: { x: 46.61, z: 1390.13 } }],
        },
        candidateLedger: [
          { candidateId: "service-road", kind: "service-road", ledgerState: "NOT_ATTEMPTED" },
          { candidateId: "direct-cable", kind: "direct-cable", ledgerState: "OBSERVED_MATCH" },
        ],
      },
    },
  };
}

/** The Gate 1 state a durable store holds when its utility work is in flight. */
function inFlightProjectState() {
  const state = deliveredProjectState("intent:gate1-starter:world-a:baseline:save:meta-a:data-a");
  return {
    ...state,
    tranche: { ...state.tranche, stage: "ROAD_DELIVERED", utilityExecution: waterUtilitySlice(state.project.id) },
  } as typeof state;
}

/** The second project root: a journal is per world, not per project. */
function waterUtilityCommand(commandId: string, projectId: string): V2CommandRecord {
  const record = utilityCommand(commandId);
  return {
    ...record,
    authorizedScope: {
      ...(record.authorizedScope as Extract<V2CommandRecord["authorizedScope"], { actionFamily: "UTILITY" }>),
      utilityKind: "water",
      projectId,
      trancheId: `${projectId}:tranche:1`,
      reservationRef: `${projectId}:reservation`,
    },
  };
}

const ELECTRICITY_PROJECT = "project-electricity";
const WATER_PROJECT = "project-water";

/** Two committed, terminal commands — one per project root — then a save the
 *  store never registered, which is what makes this a descendant candidate. */
function descendantCandidateStorage() {
  const storage = createMemoryDurableStateStorage();
  const first = new V2DurabilityCoordinator(storage);
  first.activate(world({ checkpoint: null, purpose: "NewGame" }));
  first.recordBaselineCheckpoint(receipt(SAVE_A));
  first.commandJournal.create(utilityCommand("electricity-facility"));
  first.commandJournal.create(waterUtilityCommand("water-facility", WATER_PROJECT));
  transition(first, "electricity-facility", "OBSERVED_MATCH");
  transition(first, "water-facility", "OBSERVED_MATCH");
  const inFlight = inFlightProjectState();
  first.saveProjectState(inFlight);
  // A live Goal plan, so the re-baseline below retires inherited work rather
  // than an already-empty registry.
  first.activateGoalWorkOrder({ goalId: "UTILITY_SERVICE:water:descendant", state: inFlight });
  first.recordCheckpoint(receipt(SAVE_B), 2);
  return storage;
}

const descendantWorld = (generation = DESCENDANT_GENERATION) =>
  world({ checkpoint: SAVE_DESCENDANT, generation });

/**
 * The first activation of an unregistered descendant save. It re-baselines: the
 * inherited plan and its project state are retired together, the journal is
 * kept as history, and writes wait for the loaded save to be certified.
 *
 * The retired `descendantEffects` / `confirmDescendantSaveReload` fixtures are
 * deleted with the quarantine they served. The world is the authority now, so
 * nothing is proven effect by effect and there is nothing to confirm.
 */
function rebaselinedDescendant(options: { storage?: ReturnType<typeof descendantCandidateStorage> } = {}) {
  const storage = options.storage ?? descendantCandidateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  const activation = coordinator.activate(descendantWorld());
  if (activation.status !== "DESCENDANT_CHECKPOINT_REQUIRED") {
    throw new Error(`fixture expected a re-baselined descendant, got ${activation.status}`);
  }
  return { storage, coordinator, activation };
}

describe("a Load re-baselines on the world instead of quarantining against the journal", () => {
  test("1. an unregistered descendant save retires the inherited plan and its project state", () => {
    const { coordinator, activation } = rebaselinedDescendant();

    // The world is the authority after a Load, so nothing inherited from the
    // pre-Load branch survives as a plan. The state is retired, not withheld:
    // the quarantine the journal could never satisfy is gone, and this is what
    // replaced it.
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(activation.blockedReason).toBeNull();
    expect(coordinator.isExecutionDurablyActivated(activation)).toBe(false);
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(coordinator.snapshot().goalWorkOrders ?? []).toEqual([]);
    expect(coordinator.snapshot().activeGoalWorkOrderId).toBeNull();
    // The refusal is now the ordinary write gate: the loaded save is not a
    // certified rollback boundary yet, so no world write is authorized.
    expect(() => coordinator.commandJournal.create(command("write-before-certification")))
      .toThrow("certified durable rollback boundary");
    expect(() => coordinator.assertMutationAllowed("any-key"))
      .toThrow("certified durable rollback boundary");
    // The journal is history and observability, not authority: it is retained
    // exactly as recorded, and none of it is up for reconciliation.
    expect(coordinator.snapshot().commands.map((entry) => entry.record.commandId))
      .toEqual(["electricity-facility", "water-facility"]);
    expect(coordinator.reconciliationRequired()).toEqual([]);
  });

  test("2. certifying the loaded save re-establishes the boundary and the branch writes again", () => {
    const { coordinator } = rebaselinedDescendant();
    const before = coordinator.snapshot().commands.map((entry) => entry.record.commandId);

    coordinator.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, DESCENDANT_GENERATION));
    const resumed = coordinator.activate(descendantWorld());

    expect(resumed.status).toBe("ACTIVATED");
    expect(resumed.blockedReason).toBeNull();
    expect(coordinator.isExecutionDurablyActivated(resumed)).toBe(true);
    // Nothing inherited was replayed to get here: the journal is exactly what it
    // was, and the next write is a new command with its own identity.
    expect(coordinator.snapshot().commands.map((entry) => entry.record.commandId)).toEqual(before);
    coordinator.commandJournal.create(command("write-after-certification"));
    expect(coordinator.commandJournal.get("write-after-certification")).toBeDefined();
  });

  test("3. the loaded save becomes the boundary at today's cut, so a restart resumes instead of re-quarantining", () => {
    const { storage, coordinator } = rebaselinedDescendant();
    const commandsBefore = coordinator.snapshot().commands.map((entry) => entry.record.commandId);
    const journalBefore = coordinator.snapshot().journalPosition;

    const restarted = new V2DurabilityCoordinator(storage);
    const activation = restarted.activate(descendantWorld());

    // The re-baseline registered the loaded save at the current journal cut, so
    // the same save on restart is no longer an unregistered descendant.
    expect(activation.kind).not.toBe("DESCENDANT_SAVE_RELOAD");
    expect(activation.status).toBe("ACTIVATED");
    expect(restarted.snapshot().journalPosition).toBe(journalBefore);
    expect(restarted.snapshot().commands.map((entry) => entry.record.commandId)).toEqual(commandsBefore);
  });

  test("4. certifying the loaded save binds the inherited journal lineage to it", () => {
    const { coordinator } = rebaselinedDescendant();
    // Before certification the loaded save is not a proven boundary yet, so no
    // inherited command can claim a durable lineage off it.
    expect(coordinator.commandJournal.durableLineage("water-facility")).toBeNull();

    coordinator.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, DESCENDANT_GENERATION));
    expect(coordinator.commandJournal.durableLineage("water-facility")).toMatchObject({
      worldId: `cs2-session:${WORLD_A}`,
      position: 2,
      boundaryCheckpointId: SAVE_DESCENDANT,
      proof: "CERTIFIED_CHECKPOINT_CONTAINS_COMMAND",
    });
  });

  test("5. the two-project journal is kept as history while the inherited plan is retired", () => {
    const { coordinator } = rebaselinedDescendant();
    // The journal genuinely spans two project roots; it is retained as history
    // even though the plan that stood on it is gone. No production read is asked
    // to rebuild a project state from it: `ensureFirstProject` plans against the
    // loaded world instead, which is why the recovery-seam assertions this case
    // used to make are retired with the seam.
    const roots = new Set(coordinator.snapshot().commands.flatMap((entry) => {
      const scope = entry.record.authorizedScope;
      return scope.actionFamily === "UTILITY" ? [scope.projectId] : [];
    }));
    expect(roots).toEqual(new Set(["project-a", WATER_PROJECT]));
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(coordinator.snapshot().goalWorkOrders ?? []).toEqual([]);
  });
});

/**
 * The branch an exact operation may be bound to is the one the product would roll
 * this city back to — `active.rollbackBoundaryId` — and not the save the world
 * was loaded from. Those are the same value for a world loaded from a save and
 * they are not for a city started fresh: `activateWorld` records
 * `loadedCheckpointId: world.checkpointId`, which is `null` for a `NewGame`,
 * while the same activation records and certifies the BASELINE it created as the
 * rollback boundary.
 *
 * Reading the loaded identity made every exact-operation authorization
 * unsatisfiable on a fresh city even though the branch was fully certified —
 * measured live (2026-10-01): `K05:
 * UTILITY_SERVICE_ROAD_CHILD_CURRENT_BRANCH_NOT_PROVEN` on every attempt, a city
 * with seven roads, no water, no sewage and no residents. These are the cases
 * that prove the new identity is a proof and not a bypass: it holds on both a
 * fresh city and a loaded save, and it answers "not proven" for a boundary whose
 * checkpoint is gone, whose journal cut has moved, and whose world generation is
 * no longer the activated one.
 */
describe("the current branch's checkpoint identity", () => {
  const ROAD_INPUT = { prefab: "Small Road", x1: -20, z1: 10, x2: 20, z2: 10 };
  const freshBaseline = (storage = createMemoryDurableStateStorage()) => {
    const coordinator = new V2DurabilityCoordinator(storage);
    coordinator.activate(world({ checkpoint: null, purpose: "NewGame" }));
    coordinator.recordBaselineCheckpoint(receipt(SAVE_A));
    // Activating again is what the product does on the next read: it proves the
    // in-place anchor rather than re-recording it.
    expect(coordinator.activate(world({ checkpoint: null, purpose: "NewGame" })).status)
      .toBe("ACTIVATED_IN_PLACE");
    return { coordinator, storage };
  };
  const tamper = (storage: ReturnType<typeof createMemoryDurableStateStorage>,
    change: (state: V2DurableState) => void) => {
    const state = cloneDurableState(storage.value()) as V2DurableState;
    change(state);
    storage.save(state);
  };
  const replacementRequest = (checkpointId: string, generation: string, journalCut: number) => ({
    state: deliveredProjectState("intent:branch-identity", "SITE_SELECTED"),
    expectedCurrentTaskId: "road-task",
    objectiveId: "project:tranche:ROAD_CONNECTION",
    planRevision: "project-replan:branch-identity",
    exactRoadInput: ROAD_INPUT,
    authorizationWorldId: `cs2-session:${WORLD_A}`,
    authorizationCheckpointId: checkpointId,
    authorizationGeneration: generation,
    activeBranchIdentity: `cs2-session:${WORLD_A}|${checkpointId}|${journalCut}`,
    trigger: "PLANNER_INPUT_CHANGED" as const,
    worldEffect: "ABSENT" as const,
    correctedInputAvoidsExistingEffects: true,
    targetEntityAuthoritative: true,
  });

  test("a city started fresh has a proven branch, and the exact utility service-road child is authorized and spent on it", () => {
    const { coordinator } = freshBaseline();
    expect(coordinator.snapshot().active).toMatchObject({ loadedCheckpointId: null, rollbackBoundaryId: SAVE_A });
    const branch = coordinator.currentBranchCheckpoint();
    expect(branch).toMatchObject({ worldId: `cs2-session:${WORLD_A}`, generation: "generation-a",
      checkpointId: SAVE_A, journalCut: 0 });

    const state = deliveredProjectState("intent:fresh-branch-child");
    coordinator.saveProjectState(state);
    const child = coordinator.recordUtilityServiceRoadChildOperation({
      state, planRevision: "project-replan:fresh-branch",
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...ROAD_INPUT }),
      exactRoadInput: ROAD_INPUT,
      authorizationWorldId: branch!.worldId, authorizationCheckpointId: branch!.checkpointId,
      authorizationGeneration: branch!.generation,
      detail: "fresh-city utility service road child",
    });
    expect(child).toMatchObject({ status: "ACTIVE", executionUseStatus: "UNUSED", authorizationCheckpointId: SAVE_A,
      exactRoadInput: ROAD_INPUT });
    expect(coordinator.consumeUtilityServiceRoadChildOperation(child.amendmentId, child.courseFingerprint!))
      .toMatchObject({ status: "CONSUMED", executionUseLimit: 1, executionUseStatus: "CONSUMED" });
  });

  test("a city loaded from a save proves the same branch identity", () => {
    const storage = createMemoryDurableStateStorage();
    const owner = new V2DurabilityCoordinator(storage);
    owner.activate(world({ checkpoint: null, purpose: "NewGame", generation: "generation-fresh" }));
    owner.recordBaselineCheckpoint(receipt(SAVE_A, "generation-fresh"));

    const reloaded = new V2DurabilityCoordinator(storage);
    reloaded.activate(world({ checkpoint: SAVE_A, purpose: "LoadGame", generation: "generation-reloaded" }));
    expect(reloaded.currentBranchCheckpoint()).toMatchObject({ checkpointId: SAVE_A, journalCut: 0,
      generation: "generation-reloaded" });
    expect(reloaded.snapshot().active).toMatchObject({ loadedCheckpointId: SAVE_A, rollbackBoundaryId: SAVE_A });
  });

  test("a boundary whose checkpoint is gone is not a proven branch", () => {
    const { coordinator, storage } = freshBaseline();
    tamper(storage, (state) => {
      state.checkpoints = state.checkpoints.filter((entry) => entry.checkpointId !== SAVE_A);
    });
    expect(() => coordinator.ensurePlannerInputReplacement(replacementRequest(SAVE_A, "generation-a", 0)))
      .toThrow("PLANNER_INPUT_REPLACEMENT_ACTIVE_BRANCH_STALE");
  });

  test("a journal cut that has moved off its checkpoint is not a proven branch", () => {
    const { coordinator, storage } = freshBaseline();
    tamper(storage, (state) => {
      state.active!.activatedCheckpointJournalCut = 4;
    });
    expect(() => coordinator.ensurePlannerInputReplacement(replacementRequest(SAVE_A, "generation-a", 4)))
      .toThrow("PLANNER_INPUT_REPLACEMENT_ACTIVE_BRANCH_STALE");
  });

  test("a world and generation that are no longer the activated ones are not a proven branch", () => {
    const { coordinator } = freshBaseline();
    expect(coordinator.currentBranchCheckpoint()).not.toBeNull();
    // The same fresh world, one generation later: the anchor recorded for the
    // first generation is invalidated before any write, so the branch is no
    // longer the one any authorization could be bound to.
    expect(coordinator.activate(world({ checkpoint: null, purpose: "NewGame", generation: "generation-changed" })).status)
      .toBe("BASELINE_CHECKPOINT_REQUIRED");
    expect(coordinator.currentBranchCheckpoint()).toBeNull();
  });

  test("an authorization bound to a branch that has since moved is stale, not replayed", () => {
    const { coordinator } = freshBaseline();
    const state = deliveredProjectState("intent:stale-branch-child");
    coordinator.saveProjectState(state);
    const child = coordinator.recordUtilityServiceRoadChildOperation({
      state, planRevision: "project-replan:stale-branch",
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...ROAD_INPUT }),
      exactRoadInput: ROAD_INPUT,
      authorizationWorldId: `cs2-session:${WORLD_A}`, authorizationCheckpointId: SAVE_A,
      authorizationGeneration: "generation-a", detail: "child bound before the world moved",
    });
    expect(coordinator.activate(world({ checkpoint: null, purpose: "NewGame", generation: "generation-changed" })).status)
      .toBe("BASELINE_CHECKPOINT_REQUIRED");
    expect(() => coordinator.consumeUtilityServiceRoadChildOperation(child.amendmentId, child.courseFingerprint!))
      .toThrow("UTILITY_SERVICE_ROAD_CHILD_OPERATION_STALE_WORLD");
  });
});
