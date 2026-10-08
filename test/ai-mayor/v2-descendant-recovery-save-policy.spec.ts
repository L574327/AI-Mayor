import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
  type V2DurableStateStorage,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord, V2CommandStatus } from "@/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts } from "@/main/services/ai-mayor/v2/main-adapter";

/**
 * The Mayor does not save the player's city to obtain a durable boundary.
 *
 * A world whose authority has been reconstructed but which still has no durable
 * checkpoint of its own needs a native save before write authority exists. That
 * save is the user's to make: it is the rollback point of their city, and the
 * product rule is `USER_CONTROLS_SAVE_AND_ROLLBACK`. So the default path must
 * wait — `DESCENDANT_USER_SAVE_REQUIRED`, zero `cs2_save_game` — and a save the
 * user made themselves must be adoptable without the Mayor driving one.
 *
 * These tests pin exactly that, on the production activation port, against a
 * real durable store.
 */

const WORLD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAVE_A = "save:meta-a:data-a";
const SAVE_DESCENDANT = "save:meta-descendant:data-descendant";
const GENERATION = "generation-descendant";

function world(
  options: { checkpoint?: string | null; generation?: string; loadAssetGuid?: string | null } = {},
) {
  const checkpoint = options.checkpoint === undefined ? SAVE_DESCENDANT : options.checkpoint;
  const parts = checkpoint?.split(":") ?? [];
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    simulation: { paused: true, frameIndex: 0 },
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${WORLD_A}`,
      nativeSessionGuid: WORLD_A,
      loadPurpose: "LoadGame",
      loadAssetGuid: options.loadAssetGuid !== undefined ? options.loadAssetGuid : (parts[1] ?? null),
      saveDataAssetGuid: parts[2] ?? null,
      mapAssetGuid: "map-a",
      checkpointId: checkpoint,
      bridgeRuntimeEpoch: "bridge-a",
      generation: options.generation ?? GENERATION,
      generationSequence: 2,
      generationOrigin: "LOAD_COMPLETED",
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
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

/**
 * A durable store holding one world's lineage, before the load that will be
 * re-baselined onto it.
 *
 * The store holds an earlier load of this world (`generation-a`) with one
 * delivered ROAD command. Nothing here pre-activates the descendant: when the
 * production activation port reads the loaded world, that world is the
 * unregistered descendant this store has never seen, and its own `activate`
 * call re-baselines it on the loaded world (`DESCENDANT_CHECKPOINT_REQUIRED`)
 * instead of requiring the inherited effects to be proven command by command.
 *
 * Reached through the coordinator's own formal APIs rather than by writing the
 * state file, so the fixture cannot claim a status the real flow would not.
 */
function reconstructedDescendantStorage(): V2DurableStateStorage {
  const storage = createMemoryDurableStateStorage();
  const first = new V2DurabilityCoordinator(storage);
  first.activate(world({ checkpoint: null, generation: "generation-a" }));
  first.recordBaselineCheckpoint(receipt(SAVE_A));
  first.activate(world({ checkpoint: SAVE_A, generation: "generation-a" }));
  first.commandJournal.create(command("road-delivered"));
  first.commandJournal.update("road-delivered", (current) => ({
    ...current,
    status: "OBSERVED_MATCH",
    statusHistory: [...current.statusHistory, { status: "OBSERVED_MATCH", at: "2026-09-13T00:00:02.000Z" }],
  }));
  return storage;
}

/**
 * The Bridge tools double. `saveStatus` is what the Bridge reports for an
 * aggregate save-status read, which is how an already-existing durable save of
 * this world becomes visible without anything being submitted. `submittedSave`
 * is what it reports once a save request has actually been made.
 *
 * `catalogue` is the read-only save listing — the surface that makes a save the
 * user performed themselves visible at all, since /state and /game/save/status
 * can only ever describe the load context or a save this bridge submitted.
 */
function bridgeTools(
  saveStatus: Record<string, unknown>,
  submittedSave?: Record<string, unknown>,
  catalogue: Record<string, unknown> = emptyCatalogue(),
) {
  const calls: string[] = [];
  return {
    get saveGameCalls() {
      return calls.filter((name) => name === "cs2_save_game").length;
    },
    get calls() {
      return calls;
    },
    manager: {
      legacyList: async () => ({
        tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game", "cs2_saves"].map((name) => ({ name: `cs2--${name}` })),
      }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        const payload =
          name === "cs2_game_state"
            ? world()
            : name === "cs2_save_status"
              ? typeof args.requestId === "string" && submittedSave
                ? submittedSave
                : saveStatus
              : name === "cs2_saves"
                ? catalogue
                : { status: "SUBMITTED", saveRequestId: "save-request-1" };
        return { structuredContent: payload };
      },
    },
  };
}

/** A catalogue with no saves at all: nothing to adopt, nothing submitted. */
function emptyCatalogue() {
  return {
    worldId: `cs2-session:${WORLD_A}`,
    nativeSessionGuid: WORLD_A,
    readerWorldGeneration: GENERATION,
    loadedSaveMetadataAssetGuid: null,
    count: 0,
    saves: [] as unknown[],
  };
}

/**
 * One catalogue entry, as the Bridge would report it. Defaults describe the save
 * the world was loaded from: durable, of this session, and the loaded one.
 */
function catalogueEntry(overrides: Record<string, unknown> = {}) {
  return {
    checkpointId: SAVE_DESCENDANT,
    saveMetadataAssetGuid: "meta-descendant",
    saveDataAssetGuid: "data-descendant",
    nativeSessionGuid: WORLD_A,
    durable: true,
    isCurrentSession: true,
    isLoadedSave: true,
    worldId: `cs2-session:${WORLD_A}`,
    displayName: "阿瓜弗里亚 2",
    cityName: "阿瓜弗里亚",
    autoSave: false,
    lastModified: "2026-09-22T16:53:39.9811436Z",
    saveWorldGeneration: null,
    ...overrides,
  };
}

/** A catalogue holding exactly one save, which is the loaded one. */
function loadedSaveCatalogue(overrides: Record<string, unknown> = {}) {
  const entry = catalogueEntry(overrides);
  return {
    ...emptyCatalogue(),
    loadedSaveMetadataAssetGuid: entry.saveMetadataAssetGuid,
    count: 1,
    saves: [entry],
  };
}

/** A catalogue of saves that are all of some other world, none of them loaded. */
function catalogueOf(entries: Array<Record<string, unknown>>, loadedSaveMetadataAssetGuid: string | null = null) {
  return {
    ...emptyCatalogue(),
    loadedSaveMetadataAssetGuid,
    count: entries.length,
    saves: entries,
  };
}

const OTHER_SESSION = "11111111222233334444555566667777";


const IDLE_SAVE_STATUS = { state: "IDLE", status: "IDLE" };

/** The receipt the Bridge would report for a save the user performed. */
const USER_SAVE_STATUS = receipt(SAVE_DESCENDANT, GENERATION);

describe("the descendant recovery save is the user's, not the Mayor's", () => {
  test("A. a reconstructed world with no durable save fails closed without saving", async () => {
    const storage = reconstructedDescendantStorage();
    const tools = bridgeTools(IDLE_SAVE_STATUS);
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    // The default save policy must not produce a native save. Not one.
    expect(tools.saveGameCalls).toBe(0);
    expect(tools.calls).not.toContain("cs2_save_game");
    // The refusal is explicit, and the world stays blocked rather than being
    // handed authority it has no boundary for.
    expect(activation.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(activation.blockedReason).toContain("DESCENDANT_USER_SAVE_REQUIRED");
    expect(ports.durability?.isExecutionDurablyActivated(activation)).toBe(false);
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
  });

  test("B. a save the user made is adopted and certifies the boundary, still without saving", async () => {
    const storage = reconstructedDescendantStorage();
    // The Bridge now reports a completed durable save of this very world. It is
    // read, never submitted — the user made it.
    const tools = bridgeTools(USER_SAVE_STATUS);
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    expect(tools.saveGameCalls).toBe(0);
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("ACTIVATED");
    expect(activation.status).not.toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(activation.blockedReason).toBeNull();
    expect(ports.durability?.isExecutionDurablyActivated(activation)).toBe(true);
    // The adopted boundary is the user's save, and it is the rollback point.
    expect(ports.durability?.snapshot().baselineActivation?.checkpointId).toBe(SAVE_DESCENDANT);
    expect(ports.durability?.snapshot().active?.rollbackBoundaryId).toBe(SAVE_DESCENDANT);
    // The inherited journal cut rode along, which is what keeps the
    // reconstructed commands applicable to the new boundary.
    const boundary = ports.durability
      ?.snapshot()
      .checkpoints.find((checkpoint) => checkpoint.checkpointId === SAVE_DESCENDANT);
    expect(boundary).toMatchObject({ durable: true, worldId: `cs2-session:${WORLD_A}`, journalPosition: 1 });
  });

  test("C. an explicit autosave opt-in still saves, and still adopts a save that already exists", async () => {
    const optedIn = bridgeTools(IDLE_SAVE_STATUS, USER_SAVE_STATUS);
    const optedInPorts = createV2FoundationPorts({
      getToolsManager: () => optedIn.manager as never,
      durableStateStorage: reconstructedDescendantStorage(),
      baselineSavePollMs: 1,
      automaticRecoverySave: true,
    });
    // The opt-in is the only thing that reaches the submission.
    const saved = await optedInPorts.activateDurableWorld?.();
    if (!saved) throw new Error("activateDurableWorld is not configured");
    expect(optedIn.saveGameCalls).toBe(1);
    expect(optedInPorts.durability?.snapshot().baselineActivation?.status).toBe("ACTIVATED");

    // Under the opt-in, an available save is still read rather than re-taken:
    // the policy permits an automatic save, it never requires one.
    const available = bridgeTools(USER_SAVE_STATUS);
    const availablePorts = createV2FoundationPorts({
      getToolsManager: () => available.manager as never,
      durableStateStorage: reconstructedDescendantStorage(),
      baselineSavePollMs: 1,
      automaticRecoverySave: true,
    });
    await availablePorts.activateDurableWorld?.();
    expect(available.saveGameCalls).toBe(0);
    expect(availablePorts.durability?.snapshot().baselineActivation?.status).toBe("ACTIVATED");
  });

  test("D. a save of some other world is not this world's boundary", async () => {
    const storage = reconstructedDescendantStorage();
    const tools = bridgeTools(receipt(SAVE_DESCENDANT, "generation-somewhere-else"));
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    // A completed, durable save that is not this world's generation proves
    // nothing about this world, so the refusal stands and nothing is submitted.
    expect(tools.saveGameCalls).toBe(0);
    expect(activation.blockedReason).toContain("DESCENDANT_USER_SAVE_REQUIRED");
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
  });

  test("E. the save the world was loaded from is itself a certifiable boundary", async () => {
    const storage = reconstructedDescendantStorage();
    // The world was loaded from a save the user made. That save is a durable
    // boundary by definition — the load that is running now was started from it,
    // so its generation is the generation this load minted, not a guess.
    const tools = bridgeTools(IDLE_SAVE_STATUS, undefined, loadedSaveCatalogue());
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    expect(tools.saveGameCalls).toBe(0);
    expect(tools.calls).toContain("cs2_saves");
    expect(activation.status).not.toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(activation.blockedReason).toBeNull();
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("ACTIVATED");
    expect(ports.durability?.isExecutionDurablyActivated(activation)).toBe(true);
    // Certified against the loaded save's own identity, not against a file name
    // and not against the newest timestamp in the listing.
    expect(ports.durability?.snapshot().baselineActivation?.checkpointId).toBe(SAVE_DESCENDANT);
    expect(ports.durability?.snapshot().active?.rollbackBoundaryId).toBe(SAVE_DESCENDANT);
  });

  test("F. a newer save that is not the loaded one is not adopted on recency", async () => {
    const storage = reconstructedDescendantStorage();
    // An autosave of the same session, written after the save we loaded from. It
    // is durable and its session guid matches — but nothing CS2 records says
    // which load it was written during, so its generation is unknowable. Naming
    // this load's generation for it would invent an identity, so it is refused.
    const tools = bridgeTools(
      IDLE_SAVE_STATUS,
      undefined,
      catalogueOf([
        catalogueEntry({
          isLoadedSave: false,
          autoSave: true,
          displayName: "22-九月-10-24-00",
          checkpointId: "save:meta-autosave:data-autosave",
          saveMetadataAssetGuid: "meta-autosave",
          saveDataAssetGuid: "data-autosave",
          lastModified: "2026-09-22T17:24:01.0000000Z",
        }),
      ]),
    );
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    expect(tools.saveGameCalls).toBe(0);
    expect(activation.blockedReason).toContain("DESCENDANT_USER_SAVE_REQUIRED");
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
  });

  test("G. the same city name and a newer timestamp are not lineage", async () => {
    const storage = reconstructedDescendantStorage();
    // Another city's save — or the same city's, from another session. It carries
    // the name and the recency but not the identity, and neither of those is
    // allowed to stand in for it.
    const tools = bridgeTools(
      IDLE_SAVE_STATUS,
      undefined,
      catalogueOf([
        catalogueEntry({
          nativeSessionGuid: OTHER_SESSION,
          worldId: `cs2-session:${OTHER_SESSION}`,
          isCurrentSession: false,
          isLoadedSave: false,
          cityName: "阿瓜弗里亚",
          displayName: "阿瓜弗里亚 3",
          lastModified: "2026-09-22T18:00:00.0000000Z",
        }),
      ]),
    );
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    expect(tools.saveGameCalls).toBe(0);
    expect(activation.blockedReason).toContain("DESCENDANT_USER_SAVE_REQUIRED");
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
  });

  test("H. a matching session guid alone does not establish lineage", async () => {
    const storage = reconstructedDescendantStorage();
    // Same session guid as the running world — but not the save it was loaded
    // from, and not a save of this session either. The session guid is shared by
    // every load of one save, so on its own it says nothing about which load a
    // save belongs to.
    const tools = bridgeTools(
      IDLE_SAVE_STATUS,
      undefined,
      catalogueOf([
        catalogueEntry({ isLoadedSave: false, isCurrentSession: false }),
      ]),
    );
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    expect(tools.saveGameCalls).toBe(0);
    expect(activation.blockedReason).toContain("DESCENDANT_USER_SAVE_REQUIRED");
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
  });

  test("I. a loaded save with incomplete metadata fails closed rather than certifying", async () => {
    const storage = reconstructedDescendantStorage();
    // Marked as the loaded save, but CS2 recorded no save-data asset for it, so
    // there is no checkpoint identity to certify. A missing field is reported as
    // missing, never filled in from the other fields that are present.
    const tools = bridgeTools(
      IDLE_SAVE_STATUS,
      undefined,
      catalogueOf([
        catalogueEntry({ checkpointId: null, saveDataAssetGuid: null, durable: false }),
      ], "meta-descendant"),
    );
    const ports = createV2FoundationPorts({
      getToolsManager: () => tools.manager as never,
      durableStateStorage: storage,
      baselineSavePollMs: 1,
    });

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");

    expect(tools.saveGameCalls).toBe(0);
    expect(activation.blockedReason).toContain("DESCENDANT_USER_SAVE_REQUIRED");
    expect(ports.durability?.snapshot().baselineActivation?.status).toBe("DESCENDANT_CHECKPOINT_REQUIRED");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
  });
});
