import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord, V2CommandStatus } from "@/main/services/ai-mayor/v2/foundation";
import { planStarterResidentialIntent } from "@/main/services/ai-mayor/v2/gate1";

/**
 * Persistent world lineage versus runtime load identity.
 *
 * The runtime `generation` (and the `worldEpochId` built on it) is minted afresh
 * on every load, so it can never be the identity of a persistent world. These
 * tests pin the two questions apart:
 *
 *   - *Which session is this?* — the runtime generation.
 *   - *Which save is this?* — the save metadata asset, plus the save-data asset
 *     when the asset database resolves it.
 *
 * Every case below runs a real coordinator over real durable state, so a
 * classification is only ever reached through durable evidence: registered
 * checkpoint ancestry, surviving journal ownership, exact journal-authorized
 * world effects, and rollback absence proof.
 */

const WORLD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORLD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SAVE_A = "save:meta-a:data-a";
const SAVE_B = "save:meta-b:data-b";
const SAVE_DESCENDANT = "save:meta-descendant:data-descendant";
const SAVE_UNRELATED = "save:meta-unrelated:data-unrelated";

function world(
  options: {
    session?: string;
    checkpoint?: string | null;
    generation?: string;
    bridge?: string;
    purpose?: "LoadGame" | "NewGame";
    /** A save whose save-data asset the asset database cannot resolve. */
    loadAssetGuid?: string | null;
  } = {},
) {
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
      worldReady: true,
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
      loadPurpose: purpose,
      loadAssetGuid:
        options.loadAssetGuid !== undefined
          ? options.loadAssetGuid
          : purpose === "LoadGame"
            ? (parts[1] ?? null)
            : null,
      saveDataAssetGuid: purpose === "LoadGame" ? (parts[2] ?? null) : null,
      mapAssetGuid: "map-a",
      checkpointId: checkpoint,
      bridgeRuntimeEpoch: options.bridge ?? "bridge-a",
      generation: options.generation ?? "generation-a",
      generationSequence: 1,
      generationOrigin: "LOAD_COMPLETED",
    },
  };
}

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

/** A ROAD command with its own geometry, so it cannot collide idempotently. */
function roadCommand(commandId: string, offset = 0): V2CommandRecord {
  const base = command(commandId);
  if (base.authorizedScope.actionFamily !== "ROAD") throw new Error("unreachable");
  return {
    ...base,
    authorizedScope: {
      ...base.authorizedScope,
      fingerprint: `road-fixture-${offset}`,
      exactInput: `{"prefab":"Road","x1":${1 + offset},"z1":2,"x2":${3 + offset},"z2":4}`,
    },
  };
}

function utilityCommand(commandId: string, status: V2CommandStatus = "CREATED", offset = 0): V2CommandRecord {
  return {
    ...command(commandId, status),
    actionFamily: "UTILITY",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TRANCHE", ownerId: "tranche-a" },
      actionFamily: "UTILITY",
      utilityKind: "electricity",
      projectId: "project-a",
      trancheId: "tranche-a",
      reservationRef: "reservation-a",
      worldEpochId: `cs2-session:${WORLD_A}:generation:generation-a`,
      generation: "generation-a",
      topologyRevision: "topology-a",
      executionMechanismRevision: "localconnect-membership-production-v2",
      certifiedRoadRefs: [{ index: 5, version: 1 }],
      exactInput: `[{"type":"build_road","prefab":"Low-voltage Ground Cable","x1":${1 + offset},"z1":2,"x2":${3 + offset},"z2":4}]`,
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

function projectState(intentId: string, stage = "ROAD_DELIVERED" as const) {
  const state = planStarterResidentialIntent({
    intentId,
    targetResidents: 12,
    maximumBudget: 10_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
    siteCandidates: [{ id: "site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
  });
  return { ...state, tranche: { ...state.tranche, stage } };
}

/**
 * A world that was first observed on `SAVE_A`, with one delivered ROAD on top of
 * it, saved afterwards as `SAVE_B`.
 *
 * `SAVE_A` is the durable checkpoint the command was recorded against — the
 * ancestry a descendant save has to claim — while `SAVE_B` is a certified save
 * taken *after* the build, so it genuinely contains the journaled work.
 */
function deliveredWorld() {
  const storage = createMemoryDurableStateStorage();
  const first = new V2DurabilityCoordinator(storage);
  first.activate(world({ checkpoint: null, purpose: "NewGame" }));
  first.recordBaselineCheckpoint(receipt(SAVE_A));
  first.activate(world({ checkpoint: SAVE_A, generation: "generation-a" }));
  first.commandJournal.create(command("road-delivered"));
  transition(first, "road-delivered", "OBSERVED_MATCH");
  first.saveProjectState(projectState("intent:lineage"));
  first.recordCheckpoint(receipt(SAVE_B), first.currentJournalPosition());
  return { storage, first };
}

describe("V2 persistent world lineage is not the runtime generation", () => {
  test("1. SAME_WORLD_RECONNECT: a new bridge runtime epoch in the same generation keeps the project state", () => {
    const { storage } = deliveredWorld();
    const reconnected = new V2DurabilityCoordinator(storage);
    const activation = reconnected.activate(world({ checkpoint: SAVE_B, generation: "generation-a", bridge: "bridge-restarted" }));
    expect(activation.kind).toBe("SAME_WORLD_RECONNECT");
    expect(activation.blockedReason).toBeNull();
    expect(reconnected.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
  });

  test("2. SAME_SAVE_RELOAD: a new generation on the same persistent save keeps the project state", () => {
    const { storage } = deliveredWorld();
    const reloaded = new V2DurabilityCoordinator(storage);
    // Same save metadata asset, brand-new runtime generation. Under a
    // generation-keyed lineage this was a "different save" and the project state
    // was thrown away; the persistent save identity is what actually decides.
    const activation = reloaded.activate(world({ checkpoint: SAVE_B, generation: "generation-reloaded" }));
    expect(activation.kind).toBe("SAME_SAVE_RELOAD");
    expect(activation.blockedReason).toBeNull();
    expect(activation.world.generation).toBe("generation-reloaded");
    expect(reloaded.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
    expect(reloaded.snapshot().commands).toHaveLength(1);
  });

  test("2b. a QuickSave whose save-data asset is unresolvable is judged by its save metadata asset", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));

    // A QuickSave reports no save-data asset at all, so `checkpointId` is null
    // and there is no epoch comparison to fall back on. The save metadata asset
    // is still a persistent identity, and it is what the registered baseline
    // carries, so the world is recognised instead of degrading to a different
    // save with the project state thrown away.
    const reloaded = new V2DurabilityCoordinator(storage);
    const activation = reloaded.activate(
      world({ checkpoint: null, generation: "generation-quicksave", loadAssetGuid: "meta-a" }),
    );
    expect(activation.kind).toBe("SAME_SAVE_RELOAD");
    expect(activation.status).toBe("ACTIVATED_IN_PLACE");
    expect(activation.blockedReason).toBeNull();
    expect(reloaded.snapshot().certifiedRollbackAnchor).toMatchObject({ checkpointId: SAVE_A, status: "CERTIFIED" });
  });

  test("2c. a fresh NewGame reports its map asset as `loadAssetGuid` and still activates in place", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    // The Bridge reports the map asset as both `loadAssetGuid` and
    // `mapAssetGuid` for a NewGame. The baseline this store then writes carries
    // a *save* metadata asset, so the two can never be equal. Judging the anchor
    // by that comparison made every fresh world report
    // BASELINE_CHECKPOINT_REQUIRED again immediately after recording the very
    // baseline it asked for, and every later attempt refused to save again.
    first.activate(world({ checkpoint: null, purpose: "NewGame", loadAssetGuid: "map-a" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));

    const activation = first.activate(world({ checkpoint: null, purpose: "NewGame", loadAssetGuid: "map-a" }));
    expect(activation.status).toBe("ACTIVATED_IN_PLACE");
    expect(activation.blockedReason).toBeNull();
    expect(first.snapshot().baselineActivation).toMatchObject({ status: "ACTIVATED_IN_PLACE", checkpointId: SAVE_A });
    expect(first.snapshot().certifiedRollbackAnchor).toMatchObject({ checkpointId: SAVE_A, status: "CERTIFIED" });
    expect(first.isExecutionDurablyActivated(activation)).toBe(true);
  });

  test("2d. a fresh NewGame world with journaled work stays a reconnect, never a descendant candidate", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame", loadAssetGuid: "map-a" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    first.commandJournal.create(command("fresh-road"));
    transition(first, "fresh-road", "OBSERVED_MATCH");
    first.saveProjectState(projectState("intent:fresh-world"));

    // The journal now rests on this world's own durable checkpoints, and no save
    // this store registered matches the world's *map* asset — so the world was
    // read as a descendant candidate and reclassified NEW_GAME on every cycle
    // after its first command. That discarded the live project state and left the
    // Brain re-admitting a first project into an occupied work order.
    const again = new V2DurabilityCoordinator(storage);
    const activation = again.activate(world({ checkpoint: null, purpose: "NewGame", loadAssetGuid: "map-a" }));
    expect(activation.kind).toBe("SAME_WORLD_RECONNECT");
    expect(activation.status).toBe("ACTIVATED_IN_PLACE");
    expect(again.projectState()).toMatchObject({ intent: { id: "intent:fresh-world" } });
    expect(again.snapshot().commands).toHaveLength(1);
  });

  test("3. ROLLBACK: a reload onto a checkpoint starts an empty execution branch", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.saveProjectState(projectState("intent:before-rollback", "PLANNED"));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    first.activate(world({ checkpoint: SAVE_A, generation: "generation-loaded" }));
    first.commandJournal.create(command("road-rolled-back"));
    transition(first, "road-rolled-back", "OBSERVED_MATCH");
    first.saveProjectState(projectState("intent:after-rollback"));

    const rolledBack = new V2DurabilityCoordinator(storage);
    const activation = rolledBack.activate(world({ checkpoint: SAVE_A, generation: "generation-rolled-back" }));
    expect(activation.kind).toBe("ROLLBACK");
    expect(rolledBack.snapshot().commands).toHaveLength(0);
    expect(rolledBack.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("4. DIFFERENT_SAVE fails closed: an unregistered save with no durable journal ancestry inherits nothing", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    // A recorded project state with an empty durable journal: nothing in the
    // journal can prove this state belongs to whatever save is loaded next, so
    // the world is never consulted and the state is never inherited.
    first.saveProjectState(projectState("intent:no-ancestry"));

    const stranger = new V2DurabilityCoordinator(storage);
    expect(() => stranger.activate(world({ checkpoint: SAVE_UNRELATED, generation: "generation-unrelated" })))
      .toThrow("EXECUTION_BRANCH_CLASSIFICATION_UNKNOWN");
    // The retired `pendingDescendantCommands`/`projectAuthority` APIs described
    // what a quarantine withheld; under the world-is-authority rule there is no
    // quarantine. The surviving invariant is that the refused classification
    // mutates nothing — the recorded state is exactly as it was.
    expect(stranger.projectState()).toMatchObject({ intent: { id: "intent:no-ancestry" } });
  });

  test("5. DIFFERENT_WORLD: another native world never inherits stale authority", () => {
    const { storage } = deliveredWorld();
    const other = new V2DurabilityCoordinator(storage);
    const activation = other.activate(world({ session: WORLD_B, checkpoint: SAVE_B, generation: "generation-other" }));
    expect(activation.kind).toBe("DIFFERENT_WORLD");
    // Another native world owes none of this journal: no observation of its
    // commands can be attributed to this lineage, and no project state is
    // inherited. (The retired `pendingDescendantCommands`/`projectAuthority`
    // APIs described the quarantine, which no longer exists.)
    expect(other.roadObservationProvenance("road-delivered")).toBeNull();
    expect(other.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("6. DESCENDANT_SAVE_RELOAD: an unregistered save with durable ancestry is re-baselined on the loaded world", () => {
    const { storage } = deliveredWorld();
    const descendant = new V2DurabilityCoordinator(storage);
    const activation = descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));
    expect(activation.kind).toBe("DESCENDANT_SAVE_RELOAD");
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(activation.blockedReason).toBeNull();
    // The world is the authority (2026-10-02): an unregistered descendant is not
    // quarantined, it is RE-BASELINED. The inherited plan is retired outright —
    // no earlier project may authorize work on land it never saw — and the case
    // demands its own durable boundary rather than a per-command world proof.
    expect(descendant.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(descendant.snapshot().goalWorkOrders).toEqual([]);
    expect(descendant.snapshot().activeGoalWorkOrderId).toBeNull();
    // The journal is history and observability, not authority: it is retained.
    expect(descendant.snapshot().commands.map((entry) => entry.record.commandId)).toEqual(["road-delivered"]);
    expect(descendant.isExecutionDurablyActivated(activation)).toBe(false);
    expect(() => descendant.assertMutationAllowed("any-key")).toThrow(
      "a certified durable rollback boundary is required before any Mayor world write",
    );
  });

  // Case 6b ("a descendant confirmation that leaves a terminal success unproven
  // is refused") is deleted: it exercised `confirmDescendantSaveReload`, which
  // was retired on 2026-10-02 with the whole per-command world-proof quarantine.
  // The surviving invariant — no write authority until the re-baselined world has
  // a durable boundary of its own — is asserted by case 6 and case 11.

  test("6c. a re-baselined descendant keeps its journal and certifies its own durable boundary", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    first.activate(world({ checkpoint: SAVE_A, generation: "generation-a" }));
    first.commandJournal.create(utilityCommand("facility-placed", "CREATED", 0));
    transition(first, "facility-placed", "OBSERVED_MATCH");
    first.commandJournal.create(utilityCommand("cable-failed", "CREATED", 100));
    // The shape the real failed cable command has: an observed mismatch whose
    // absence was proven, which is what makes the durable outcome FAILED.
    first.commandJournal.update("cable-failed", (current) => ({
      ...current,
      status: "OBSERVED_MISMATCH",
      effectAbsenceProven: true,
    }));

    const descendant = new V2DurabilityCoordinator(storage);
    const activation = descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));
    // This case used to read a `reconstruction` out of `confirmDescendantSaveReload`.
    // That reconstruction (and the `UNRECONSTRUCTED_AUTHORITY_FIELDS` /
    // `REPLAN_REQUIRED_AUTHORITY_FIELDS` vocabulary) is retired: re-baselining
    // proves nothing about the inherited commands, so the only durable facts
    // left are that the journal is retained verbatim (observability) while the
    // plan it belonged to is retired.
    expect(activation.kind).toBe("DESCENDANT_SAVE_RELOAD");
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(descendant.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(descendant.snapshot().commands.map((entry) => entry.record.commandId)).toEqual([
      "facility-placed",
      "cable-failed",
    ]);
    expect(descendant.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");

    // Write authority still needs a durable rollback boundary for this save. The
    // inherited journal cut (2) is carried into the new checkpoint, so the
    // commands the journal holds stay applicable to it.
    const checkpoint = descendant.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, "generation-descendant"));
    expect(checkpoint.journalPosition).toBe(2);
    const afterCertify = descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-after" }));
    expect(afterCertify.status).toBe("ACTIVATED");
    expect(descendant.isExecutionDurablyActivated(afterCertify)).toBe(true);
    expect(descendant.snapshot().commands).toHaveLength(2);
  });

  test("7. a historical command keeps its verdict while a later world observation records the opposite", () => {
    const storage = createMemoryDurableStateStorage();
    const first = new V2DurabilityCoordinator(storage);
    first.activate(world({ checkpoint: null, purpose: "NewGame" }));
    first.recordBaselineCheckpoint(receipt(SAVE_A));
    first.activate(world({ checkpoint: SAVE_A, generation: "generation-a" }));
    first.commandJournal.create(utilityCommand("cable-command"));
    transition(first, "cable-command", "OBSERVED_MISMATCH");
    first.commandJournal.update("cable-command", (current) => ({ ...current, effectAbsenceProven: true }));

    const historical = first.snapshot().commands[0];
    expect(historical.outcome).toBe("FAILED");

    const observation = first.recordCurrentWorldObservation({
      commandId: "cable-command",
      currentWorldEffectPresent: true,
      currentWorldObjectiveSatisfied: false,
      evidence: "two permanent cable edges form the admitted course; connector still orphaned",
    });

    // The superseding observation is a new record. It never rewrites the
    // execution-time verdict, and it carries that verdict forward verbatim so the
    // two statements cannot be confused for one another.
    expect(observation.historicalVerdict).toEqual({ status: "OBSERVED_MISMATCH", effectAbsenceProven: true });
    expect(observation.currentWorldEffectPresent).toBe(true);
    expect(observation.currentWorldObjectiveSatisfied).toBe(false);
    const after = first.snapshot().commands[0];
    expect(after.record.status).toBe("OBSERVED_MISMATCH");
    expect(after.record.effectAbsenceProven).toBe(true);
    expect(after.outcome).toBe("FAILED");
    expect(first.worldObservations("cable-command")).toHaveLength(1);

    // The observation is append-only across a restart, and a second reading is
    // added beside it rather than replacing it.
    const restarted = new V2DurabilityCoordinator(storage);
    restarted.activate(world({ checkpoint: SAVE_A, generation: "generation-a" }));
    expect(restarted.worldObservations("cable-command")).toHaveLength(1);
    restarted.recordCurrentWorldObservation({
      commandId: "cable-command",
      currentWorldEffectPresent: true,
      currentWorldObjectiveSatisfied: false,
      evidence: "re-read after restart",
    });
    expect(restarted.worldObservations("cable-command").map((entry) => entry.evidence)).toEqual([
      "two permanent cable edges form the admitted course; connector still orphaned",
      "re-read after restart",
    ]);
    expect(restarted.snapshot().commands[0].record.status).toBe("OBSERVED_MISMATCH");
  });

  test("8. superficially similar world effects without journal lineage never inherit project authority", () => {
    const { storage } = deliveredWorld();
    const stranger = new V2DurabilityCoordinator(storage);

    // A save of another native world whose world happens to look the same. The
    // durable journal belongs to WORLD_A, so there is no lineage to claim.
    // (The retired `confirmDescendantSaveReload`/`pendingDescendantCommands` /
    // `projectAuthority` APIs described the quarantine; under the world-is-
    // authority rule there is simply no authority here to inherit.)
    const activation = stranger.activate(world({ session: WORLD_B, checkpoint: SAVE_DESCENDANT, generation: "generation-similar" }));
    expect(activation.kind).toBe("DIFFERENT_WORLD");
    expect(stranger.roadObservationProvenance("road-delivered")).toBeNull();
    expect(stranger.projectState()).toMatchObject({ status: "PLACEHOLDER" });
  });

  // Case 8b ("a descendant confirmation cannot cover commands outside the
  // lineage") is deleted: it asserted a rule of `confirmDescendantSaveReload`,
  // retired 2026-10-02. There is no confirmation left that could over-reach — a
  // re-baseline inherits no authority at all.

  // Case 8c ("a descendant confirmation must describe the loaded world") is
  // deleted with the retired `confirmDescendantSaveReload` API: re-baselining
  // reads the loaded world directly and asks the caller to confirm nothing.

  /**
   * The certified rollback anchor is the per-world pointer the Mayor writes
   * against. Judging whether it still belongs to the loaded world is the same
   * question as the world-lineage classification itself, so it obeys the same
   * rule: a persistent save identity, where one exists, decides; the runtime
   * epoch only speaks when there is no save identity to speak for.
   */
  describe("anchor semantics", () => {
    test("A. an unchanged persistent save identity survives a changed runtime generation", () => {
      const storage = createMemoryDurableStateStorage();
      const first = new V2DurabilityCoordinator(storage);
      first.activate(world({ checkpoint: null, purpose: "NewGame" }));
      const baseline = first.recordBaselineCheckpoint(receipt(SAVE_A));

      const reloaded = new V2DurabilityCoordinator(storage);
      const activation = reloaded.activate(
        world({
          checkpoint: null,
          generation: "generation-next-process",
          bridge: "bridge-next-process",
          loadAssetGuid: "meta-a",
        }),
      );

      // The runtime identity really did change: a new generation, a new bridge
      // runtime epoch, and therefore a new world epoch. Under an epoch-keyed
      // anchor rule this reload was indistinguishable from a brand-new save and
      // the anchor was thrown away; the save metadata asset is what decides.
      expect(activation.world.worldEpochId).not.toBe(baseline.worldEpochId);
      expect(activation.world.bridgeRuntimeEpoch).toBe("bridge-next-process");
      expect(activation.status).toBe("ACTIVATED_IN_PLACE");
      expect(activation.blockedReason).toBeNull();
      expect(reloaded.snapshot().certifiedRollbackAnchor).toMatchObject({
        status: "CERTIFIED",
        checkpointId: SAVE_A,
        sourceGeneration: "generation-next-process",
      });
      expect(reloaded.snapshot().baselineActivation).toMatchObject({
        status: "ACTIVATED_IN_PLACE",
        checkpointId: SAVE_A,
      });
    });

    test("B. with no persistent save identity the epoch and session boundary still decide", () => {
      const storage = createMemoryDurableStateStorage();
      const first = new V2DurabilityCoordinator(storage);
      first.activate(world({ checkpoint: null, purpose: "NewGame" }));
      first.recordBaselineCheckpoint(receipt(SAVE_A));

      // A fresh unsaved world reports no save identity at all, so there is
      // nothing persistent to compare and the runtime epoch is the only witness
      // there is. While that witness holds, the baseline still belongs here.
      const reconnected = new V2DurabilityCoordinator(storage);
      const sameEpoch = reconnected.activate(world({ checkpoint: null, purpose: "NewGame" }));
      expect(sameEpoch.status).toBe("ACTIVATED_IN_PLACE");
      expect(reconnected.snapshot().certifiedRollbackAnchor).toMatchObject({
        status: "CERTIFIED",
        checkpointId: SAVE_A,
      });

      // A second, brand-new unsaved world in the same native session: still no
      // save identity, and now the epoch has moved on. Nothing is inherited —
      // "both are unsaved NewGames" is not a lineage.
      const restarted = new V2DurabilityCoordinator(storage);
      const fresh = restarted.activate(
        world({ checkpoint: null, purpose: "NewGame", generation: "generation-second-new-game" }),
      );
      expect(fresh.status).toBe("BASELINE_CHECKPOINT_REQUIRED");
      expect(restarted.snapshot().certifiedRollbackAnchor).toBeNull();
      expect(restarted.snapshot().baselineActivation).toMatchObject({
        status: "BASELINE_CHECKPOINT_REQUIRED",
        checkpointId: null,
      });

      // The session boundary is part of the same fallback: another native world
      // is never handed this world's baseline.
      const elsewhere = new V2DurabilityCoordinator(storage);
      const otherWorld = elsewhere.activate(world({ session: WORLD_B, checkpoint: null, purpose: "NewGame" }));
      expect(otherWorld.status).toBe("BASELINE_CHECKPOINT_REQUIRED");
      expect(elsewhere.snapshot().certifiedRollbackAnchor).toBeNull();
    });

    test("C. a clearly different persistent save identity fails closed", () => {
      const storage = createMemoryDurableStateStorage();
      const first = new V2DurabilityCoordinator(storage);
      first.activate(world({ checkpoint: null, purpose: "NewGame" }));
      first.recordBaselineCheckpoint(receipt(SAVE_A));

      // No durable journal lineage to claim, and a save metadata asset this
      // store never registered: the baseline belongs to another save and is not
      // offered as a rollback boundary.
      const stranger = new V2DurabilityCoordinator(storage);
      expect(() => stranger.activate(
        world({ checkpoint: null, generation: "generation-stranger", loadAssetGuid: "meta-z" }),
      )).toThrow("EXECUTION_BRANCH_CLASSIFICATION_UNKNOWN");
      expect(stranger.snapshot().certifiedRollbackAnchor).toMatchObject({ checkpointId: SAVE_A, status: "CERTIFIED" });
      expect(stranger.projectState()).toMatchObject({ status: "PLACEHOLDER" });

      // The same difference with a durable journal in play is re-baselined rather
      // than certified: the unregistered identity is a descendant candidate, the
      // anchor is withheld, and the store demands its own durable boundary.
      const { storage: withJournal } = deliveredWorld();
      const candidate = new V2DurabilityCoordinator(withJournal);
      const descendant = candidate.activate(
        world({ checkpoint: null, generation: "generation-stranger", loadAssetGuid: "meta-z" }),
      );
      expect(descendant.kind).toBe("DESCENDANT_SAVE_RELOAD");
      expect(descendant.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
      expect(descendant.blockedReason).toBeNull();
      expect(candidate.snapshot().certifiedRollbackAnchor).toBeNull();
      expect(candidate.isExecutionDurablyActivated(descendant)).toBe(false);
    });
  });

  test("10. a descendant candidate is not demoted to a reconnect by a runtime the store already stamped", () => {
    const { storage } = deliveredWorld();
    const descendant = new V2DurabilityCoordinator(storage);
    const first = descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));
    expect(first.kind).toBe("DESCENDANT_SAVE_RELOAD");

    // The first activation wrote this runtime's generation into `active`, so the
    // second observation shares its epoch. The epoch answers "did the game
    // reload", not "is this the same save": a *different* save this store never
    // registered is still a descendant candidate, because the persistent save
    // identity — not the stamped generation — decides lineage. (Re-observing the
    // very same save is a reconnect for the honest reason that the first
    // activation registered its identity; that path is covered by case 11.)
    const second = descendant.activate(
      world({ checkpoint: "save:meta-other-descendant:data-other-descendant", generation: "generation-descendant" }),
    );
    expect(second.kind).toBe("DESCENDANT_SAVE_RELOAD");
    expect(second.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(second.blockedReason).toBeNull();
    expect(descendant.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(descendant.snapshot().commands.map((entry) => entry.record.commandId)).toEqual(["road-delivered"]);
  });

  test("11. a re-baselined descendant keeps asking for its own durable boundary until it has one", () => {
    const { storage } = deliveredWorld();
    const descendant = new V2DurabilityCoordinator(storage);
    const activation = descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(descendant.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");

    // No durable boundary of its own yet. This world's own baseline belongs to
    // another save, so the requirement stands and no write is allowed — the old
    // "confirmed descendant" step is retired, so the demand must hold on the
    // plain re-baseline alone.
    expect(descendant.snapshot().certifiedRollbackAnchor).toBeNull();
    expect(descendant.isExecutionDurablyActivated(activation)).toBe(false);
    expect(() => descendant.assertMutationAllowed("any-key")).toThrow(
      "a certified durable rollback boundary is required before any Mayor world write",
    );

    // Once this store has recorded a durable save of its own, the same world
    // activates in place against that boundary — no second re-baseline.
    descendant.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, "generation-descendant"));
    const after = descendant.activate(
      world({ checkpoint: null, generation: "generation-descendant", loadAssetGuid: "meta-descendant" }),
    );
    expect(after.kind).toBe("SAME_WORLD_RECONNECT");
    expect(after.status).toBe("ACTIVATED_IN_PLACE");
    expect(descendant.isExecutionDurablyActivated(after)).toBe(true);
    expect(descendant.snapshot().certifiedRollbackAnchor).toMatchObject({
      status: "CERTIFIED",
      checkpointId: SAVE_DESCENDANT,
    });
  });

  test("12. an observation is attributed only to a lineage the store can prove, and to nothing else", () => {
    const { storage } = deliveredWorld();
    const descendant = new V2DurabilityCoordinator(storage);
    descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));

    // This case used to read a `PENDING_DESCENDANT_LINEAGE` attribution. That
    // proof was retired with the quarantine: a re-baselined descendant carries
    // no boundary the inherited command was recorded against, so nothing owns it
    // yet — the lineage must be certified (case 13) before an attribution
    // exists. A command this journal never recorded has no lineage either, and a
    // different native world owns none of this journal at all.
    expect(descendant.roadObservationProvenance("road-delivered")).toBeNull();
    expect(descendant.roadObservationProvenance("some-other-command")).toBeNull();
    const otherWorld = new V2DurabilityCoordinator(storage);
    expect(otherWorld.roadObservationProvenance("road-delivered")).toBeNull();
    expect(otherWorld.activate(world({ session: WORLD_B, checkpoint: SAVE_B, generation: "generation-other" })).kind).toBe(
      "DIFFERENT_WORLD",
    );
    expect(otherWorld.roadObservationProvenance("road-delivered")).toBeNull();
  });

  test("13. a certified descendant attributes observations to its own durable boundary", () => {
    const { storage } = deliveredWorld();
    const descendant = new V2DurabilityCoordinator(storage);
    descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));
    // Re-baselined but not yet bounded: the inherited command sits below a
    // boundary it was never recorded against, so no lineage owns it yet.
    expect(descendant.roadObservationProvenance("road-delivered")).toBeNull();

    // Certifying this store's own durable save of the world makes the inherited
    // command contained by that boundary, which is the only proof left.
    descendant.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, "generation-descendant"));
    expect(descendant.roadObservationProvenance("road-delivered")).toEqual({
      worldId: `cs2-session:${WORLD_A}`,
      nativeSessionGuid: WORLD_A,
      baseCheckpointId: SAVE_A,
      lineageCheckpointIds: [SAVE_DESCENDANT],
      proof: "CERTIFIED_DURABLE_LINEAGE",
    });
  });

  test("9. a boundary covers only its own journal cut; a grown lineage is re-baselined, not silently confirmed", () => {
    const { storage } = deliveredWorld();
    const descendant = new V2DurabilityCoordinator(storage);
    descendant.activate(world({ checkpoint: SAVE_DESCENDANT, generation: "generation-descendant" }));
    descendant.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, "generation-descendant"));

    // The lineage grows by one more delivered command on top of the certified
    // checkpoint, so the earlier boundary no longer covers the journal cut the
    // world would now have to claim. (The retired `confirmDescendantSaveReload`
    // confirmation could not survive a grown cut either; re-baselining replaces
    // that whole question.)
    descendant.commandJournal.create(roadCommand("road-added", 50));
    transition(descendant, "road-added", "OBSERVED_MATCH");

    const reloaded = new V2DurabilityCoordinator(storage);
    const next = reloaded.activate(world({ checkpoint: "save:meta-next:data-next", generation: "generation-next" }));
    expect(next.kind).toBe("DESCENDANT_SAVE_RELOAD");
    expect(next.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(next.blockedReason).toBeNull();
    // The grown lineage is not silently blessed: the plan is retired again and
    // the loaded world must prove itself with its own durable boundary.
    expect(reloaded.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(reloaded.snapshot().commands.map((entry) => entry.record.commandId)).toEqual([
      "road-delivered",
      "road-added",
    ]);
  });
});
