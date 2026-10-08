import fs from "node:fs";
import path from "node:path";
import {
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
  V2DurabilityCoordinator,
  type V2DurableState,
} from "../../src/main/services/ai-mayor/v2/durability";
import { planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";
import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import type { V2CommandRecord } from "../../src/main/services/ai-mayor/v2/foundation";

/**
 * A Load re-baselines; the world is the authority (2026-10-02).
 *
 * An unregistered descendant save used to be quarantined until every inherited
 * command had been proven, one by one, to still leave its effect in the loaded
 * world, and a `projectAuthority` was reconstructed from whatever the journal
 * plus the world proved. That gave the ledger the power to deny the world, and
 * it exercised it: one zoning cell the loaded save carried as residential made
 * all 222 inherited commands unprovable and every durable write was refused from
 * then on, for good (measured live 2026-10-02 on this city).
 *
 * This file pins what replaced it, and only that:
 *
 *  1. a Load this store never registered re-baselines — the loaded save becomes
 *     the rollback boundary, nothing is quarantined, nothing is proven per
 *     command;
 *  2. the inherited plan and authority are retired with it, so a stale Goal
 *     registry cannot veto the first project the world now needs (the measured
 *     `GOAL_WORK_ORDER_ACTIVE_SCOPE_CHANGED` deadlock, 163 stale work orders
 *     beside a placeholder);
 *  3. the low-level guarantees new commands still rely on — a certified
 *     rollback boundary and idempotency — are unchanged;
 *  4. no production module grows a new call site for the retired seam.
 *
 * The case that used to live here — thirty assertions about the recovery seam's
 * internal refusals — is gone with the seam. `Gate 1 state materialized from
 * durable authority` was reachable only from an authority that only
 * `confirmDescendantSaveReload` produced, so every one of them described a path
 * the product can no longer take.
 */

const instant = new Date("2026-09-22T12:00:00.000Z");
const SESSION = "cd0d8ea80e624df4abd692fc89df5cc4";
const SAVE_A = "save:load-asset-a:save-data-a";
const SAVE_DESCENDANT = "save:load-asset-descendant:save-data-descendant";
const GENERATION_A = "generation-a";
const GENERATION_B = "generation-b";

const ROAD_TASK_ID = "tranche-1:task:road_connection";
const ROAD = { prefab: "Medium Road", x1: -1279.5, z1: -47.279007, x2: -1281.0, z2: -22.33 };

/** Raw `cs2_game_state` payload as `parseNativeWorldIdentity` reads it. */
function rawWorld(checkpointId: string | null, generation: string, session = SESSION) {
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
      loadPurpose: "LoadGame",
      loadAssetGuid: parts[1] ?? null,
      saveDataAssetGuid: parts[2] ?? null,
      mapAssetGuid: "map-a",
      checkpointId,
      bridgeRuntimeEpoch: `bridge-${generation}`,
      generation,
      generationSequence: 1,
      generationOrigin: "LOAD_COMPLETED",
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
    },
  };
}

function receipt(checkpointId: string, generation: string, session = SESSION): SaveCompletionReceipt {
  const [, metadata, data] = checkpointId.split(":");
  return {
    status: "COMPLETED",
    durable: true,
    worldId: `cs2-session:${session}`,
    worldGeneration: generation,
    checkpoint: { checkpointId, saveMetadataAssetGuid: metadata, saveDataAssetGuid: data, nativeSessionGuid: session },
  };
}

function roadCommand(): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: "road-command-1",
    actionFamily: "ROAD",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: ROAD_TASK_ID },
      actionFamily: "ROAD",
      proposalId: "road-proposal-1",
      quoteId: "road-quote-1",
      fingerprint: stableRoadInput(ROAD),
      exactInput: stableRoadInput(ROAD),
      budget: { authorizedMaxSpend: 243.54, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
      observationPrecondition: { runtimeEpoch: "bridge:10", frame: 10 },
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    createdAt: instant.toISOString(),
    submittedAt: instant.toISOString(),
    nativeResultSummary: null,
    status: "OBSERVED_MATCH",
    statusHistory: [],
    reconciliationStatus: "MATCH",
    observationEvidence: [],
  };
}

/** A Gate 1 state, as the real planner mints one. */
function gate1State(intentId: string) {
  return planStarterResidentialIntent({
    intentId,
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: 10, z: 20 }, radius: 128 },
    siteCandidates: [{ id: "site-1", target: { center: { x: 10, z: 20 }, radius: 64 }, score: 1, blocked: false }],
  });
}

/**
 * A store of one world with a certified baseline and a journaled ROAD command —
 * the state a Load finds: everything the store knows belongs to a save this
 * activation will not recognize.
 */
function loadedStore(): ReturnType<typeof createMemoryDurableStateStorage> {
  const storage = createMemoryDurableStateStorage();
  const first = new V2DurabilityCoordinator(storage, () => instant);
  first.activate(rawWorld(null, GENERATION_A));
  first.recordBaselineCheckpoint(receipt(SAVE_A, GENERATION_A));
  first.activate(rawWorld(SAVE_A, GENERATION_A));
  first.commandJournal.create(roadCommand());
  return storage;
}

const activeState = (storage: ReturnType<typeof createMemoryDurableStateStorage>) =>
  storage.load() as V2DurableState;

describe("a Load re-baselines on the world that is loaded", () => {
  test("an unregistered descendant save is not quarantined, and the loaded save becomes the boundary", () => {
    const storage = loadedStore();
    const journalBefore = activeState(storage).journalPosition;
    const descendant = new V2DurabilityCoordinator(storage, () => instant);

    const activation = descendant.activate(rawWorld(SAVE_DESCENDANT, GENERATION_B));

    expect(activation.kind).toBe("DESCENDANT_SAVE_RELOAD");
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    // Nothing is withheld: the quarantine's distinguishing mark was a
    // `blockedReason` that refused every durable write.
    expect(activation.blockedReason).toBeNull();
    // The journal is history and observability, so it survives the re-baseline.
    expect(activeState(storage).journalPosition).toBe(journalBefore);
    expect(activeState(storage).commands).toHaveLength(1);

    // The caller records or adopts a durable save of THIS world; that is what
    // makes the loaded save the new rollback boundary and puts every inherited
    // command below it.
    descendant.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, GENERATION_B));
    const after = activeState(storage);
    expect(after.baselineActivation?.status).toBe("ACTIVATED");
    expect(after.active?.rollbackBoundaryId).toBe(SAVE_DESCENDANT);
    expect(descendant.isExecutionDurablyActivated(descendant.activate(rawWorld(SAVE_DESCENDANT, GENERATION_B)))).toBe(true);
  });

  test("the inherited Goal plan does not survive the re-baseline", () => {
    const storage = loadedStore();
    const seed = new V2DurabilityCoordinator(storage, () => instant);
    seed.activate(rawWorld(SAVE_A, GENERATION_A));
    seed.activateGoalWorkOrder({ goalId: "EXPAND_INDUSTRIAL:industrial:facts:aaaaaaaaaaaa",
      state: gate1State("intent:inherited") });
    expect(activeState(storage).goalWorkOrders).toHaveLength(1);

    const descendant = new V2DurabilityCoordinator(storage, () => instant);
    descendant.activate(rawWorld(SAVE_DESCENDANT, GENERATION_B));

    // A plan is a claim on land this store admitted against a world the loaded
    // save may not even contain. It goes with the authority.
    expect(activeState(storage).goalWorkOrders).toEqual([]);
    expect(activeState(storage).activeGoalWorkOrderId).toBeNull();
    expect(activeState(storage).projectState).toMatchObject({ status: "PLACEHOLDER" });
  });

  test("a stale plan beside a placeholder project state cannot veto the first project any more", () => {
    // The measured deadlock, reproduced from the on-disk shape rather than from
    // an API: 163 inherited work orders, an active one among them, and a
    // placeholder project state. `admitProject` minted a first project, and the
    // one durable write path refused it with `GOAL_WORK_ORDER_ACTIVE_SCOPE_CHANGED`
    // in the name of a Goal whose project the store no longer held. Every cycle
    // failed identically and the journal never moved.
    const storage = loadedStore();
    const base = activeState(storage);
    const state = gate1State("intent:stale");
    const branchId = base.executionBranch!.branchId;
    const workOrders = Array.from({ length: 163 }, (_, index) => {
      const goalId = `EXPAND_INDUSTRIAL:industrial:facts:${String(index).padStart(12, "0")}`;
      return {
        workOrderId: `goal-work-order:${goalId}`, goalId,
        worldId: base.active!.worldId, branchId,
        projectId: state.project.id, trancheId: state.tranche.id, reservationRef: state.tranche.reservationRef,
        status: index === 162 ? "RECONCILING" : "SUSPENDED",
        state, updatedAt: instant.toISOString(),
      };
    });
    const stale = createMemoryDurableStateStorage({
      ...base,
      goalWorkOrders: workOrders,
      activeGoalWorkOrderId: workOrders[162].workOrderId,
      projectState: { schemaVersion: "ai-mayor-v2-project-placeholder/1", status: "PLACEHOLDER" },
    });
    const coordinator = new V2DurabilityCoordinator(stale, () => instant);
    coordinator.activate(rawWorld(SAVE_A, GENERATION_A));

    expect(activeState(stale).goalWorkOrders).toEqual([]);
    expect(activeState(stale).activeGoalWorkOrderId).toBeNull();

    // And the project the world needs now can actually be committed.
    expect(() => coordinator.saveProjectState(gate1State("intent:first-project-after-load"))).not.toThrow();
    expect(activeState(stale).projectState).toMatchObject({ intent: { id: "intent:first-project-after-load" } });
  });

  test("the guarantees new commands rely on are untouched by the re-baseline", () => {
    const storage = loadedStore();
    const descendant = new V2DurabilityCoordinator(storage, () => instant);
    descendant.activate(rawWorld(SAVE_DESCENDANT, GENERATION_B));

    // No certified boundary yet: no world write is authorized.
    expect(() => descendant.assertMutationAllowed("idempotency-key-1")).toThrow(/rollback boundary/);

    descendant.certifyDescendantCheckpoint(receipt(SAVE_DESCENDANT, GENERATION_B));
    descendant.activate(rawWorld(SAVE_DESCENDANT, GENERATION_B));
    descendant.assertMutationAllowed("idempotency-key-1");

    // Apply-once: one authorization is never spent twice. The inherited ROAD
    // command sits below the new boundary and still holds its idempotency key,
    // so the same course cannot be authorized again under a fresh command id.
    const journal = descendant.commandJournal;
    expect(() => journal.create({ ...roadCommand(), commandId: "road-command-2" })).toThrow(/terminal success/);
  });

  test("no production module grows a new call site for the retired seam", () => {
    // The retired path is deleted, not parked. A reviewer reading the diff can
    // see that; this keeps a later change from quietly re-importing it.
    const root = path.join(__dirname, "..", "..", "src", "main", "services", "ai-mayor");
    const retired = [
      /from\s+"\.\/gate1-authority-recovery"/,
      /\brecoverGate1StateFromDurableAuthority\s*\(/,
      /\bconfirmDescendantSaveReload\s*\(/,
      /\bpendingDescendantWorld\s*\(/,
      /\bpendingDescendantCommands\s*\(/,
      /\bprojectAuthority\s*\(/,
    ];
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const source = fs.readFileSync(full, "utf8");
        for (const pattern of retired) if (pattern.test(source)) offenders.push(`${path.relative(root, full)} :: ${pattern}`);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
