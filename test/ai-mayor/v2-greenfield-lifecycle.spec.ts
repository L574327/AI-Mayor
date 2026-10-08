import { createMemoryDurableStateStorage } from "../../src/main/services/ai-mayor/v2/durability";
import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";

const session = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const worldId = `cs2-session:${session}`;
const checkpointId = "save:baseline-meta:baseline-data";

const world = (loaded: boolean, generation = loaded ? "generation-reloaded" : "generation-fresh") => ({
  gameMode: "Game", isLoading: false, cityLoaded: true,
  simulation: { paused: true, frameIndex: 0 },
  world: {
    identityStatus: "AVAILABLE", worldReady: true, worldId, nativeSessionGuid: session,
    loadPurpose: loaded ? "LoadGame" : "NewGame",
    loadAssetGuid: loaded ? "baseline-meta" : null,
    saveDataAssetGuid: loaded ? "baseline-data" : null,
    mapAssetGuid: "map-a", checkpointId: loaded ? checkpointId : null,
    bridgeRuntimeEpoch: loaded ? "bridge-reloaded" : "bridge-fresh",
    generation,
    generationSequence: loaded ? 2 : 1,
    generationOrigin: "LOAD_COMPLETED",
    nativeOperationBusy: false,
    nativeOperationStage: "Idle",
  },
});

describe("V2 greenfield lifecycle closure", () => {
  test("fresh activation creates one baseline artifact and activates in place", async () => {
    let loaded = false;
    let saves = 0;
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown;
        if (name === "cs2_game_state") payload = world(loaded);
        else if (name === "cs2_save_game") {
          saves += 1;
          payload = { status: "SUBMITTED", saveRequestId: "baseline-request" };
        } else if (args.requestId === "baseline-request") {
          payload = {
            status: "COMPLETED", durable: true, worldId, worldGeneration: "generation-fresh",
            checkpoint: {
              checkpointId, saveMetadataAssetGuid: "baseline-meta", saveDataAssetGuid: "baseline-data", nativeSessionGuid: session,
            },
          };
        } else payload = {
          state: "IDLE", status: "COMPLETED", durable: true,
          worldId: "cs2-session:stale", worldGeneration: "generation-stale",
          checkpoint: { checkpointId: "save:stale:stale", nativeSessionGuid: "stale" },
        };
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    const created = await ports.activateDurableWorld!();
    expect(created.status).toBe("ACTIVATED_IN_PLACE");
    expect(saves).toBe(1);
    expect((await ports.activateDurableWorld!()).status).toBe("ACTIVATED_IN_PLACE");
    expect(saves).toBe(1);
    expect(ports.durability?.snapshot()).toMatchObject({
      active: { loadedCheckpointId: null, rollbackBoundaryId: checkpointId },
      baselineActivation: { checkpointId, status: "ACTIVATED_IN_PLACE" },
      certifiedRollbackAnchor: { checkpointId, status: "CERTIFIED", journalPosition: 0 },
    });

    loaded = true;
    const recovered = await ports.activateDurableWorld!();
    expect(recovered.status).toBe("ACTIVATED");
    expect(recovered.world.generation).toBe("generation-reloaded");
    expect(ports.durability?.snapshot().active).toMatchObject({ loadedCheckpointId: checkpointId });
  });

  test("failed baseline save fails closed without certifying an anchor", async () => {
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => ({ structuredContent:
        name === "cs2_game_state" ? world(false) :
          name === "cs2_save_game" ? { status: "SUBMITTED", saveRequestId: "failed-request" } :
            args.requestId === "failed-request" ? { status: "FAILED", reason: "disk failure" } : { state: "IDLE" },
      }),
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    await expect(ports.activateDurableWorld!()).rejects.toThrow("baseline checkpoint did not complete: disk failure");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
    expect(ports.durability?.snapshot().commands).toEqual([]);
  });

  test("volatile observation-only changes do not block fresh activation", async () => {
    let stateReads = 0;
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown;
        if (name === "cs2_game_state") {
          const current = world(false);
          stateReads += 1;
          current.simulation.frameIndex = stateReads;
          (current as Record<string, unknown>).observedAt = `read-${stateReads}`;
          payload = current;
        } else if (name === "cs2_save_game") payload = { status: "SUBMITTED", saveRequestId: "volatile-request" };
        else if (args.requestId === "volatile-request") payload = {
          status: "COMPLETED", durable: true, worldId, worldGeneration: "generation-fresh",
          checkpoint: { checkpointId, saveMetadataAssetGuid: "baseline-meta", saveDataAssetGuid: "baseline-data", nativeSessionGuid: session },
        };
        else payload = { state: "IDLE" };
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    await expect(ports.activateDurableWorld!()).resolves.toMatchObject({ status: "ACTIVATED_IN_PLACE" });
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toMatchObject({ status: "CERTIFIED", checkpointId });
  });

  test("pending baseline save never activates or permits a Mayor write", async () => {
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name }: { name: string }) => ({ structuredContent:
        name === "cs2_game_state" ? world(false) :
          name === "cs2_save_game" ? { status: "SUBMITTED", saveRequestId: "pending-request" } :
            { status: "SUBMITTED", state: "IN_FLIGHT", saveRequestId: "pending-request" },
      }),
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
      baselineSaveCompletionChecks: 2,
      baselineSavePollMs: 0,
    });
    await expect(ports.activateDurableWorld!()).rejects.toThrow("completion remains pending");
    expect(ports.durability?.snapshot()).toMatchObject({ certifiedRollbackAnchor: null, commands: [] });
  });

  test("world replacement after save completion rejects the stale baseline receipt", async () => {
    let stateReads = 0;
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown;
        if (name === "cs2_game_state") payload = world(false, ++stateReads >= 2 ? "generation-replaced" : "generation-fresh");
        else if (name === "cs2_save_game") payload = { status: "SUBMITTED", saveRequestId: "race-request" };
        else if (args.requestId === "race-request") payload = {
          status: "COMPLETED", durable: true, worldId, worldGeneration: "generation-fresh",
          checkpoint: { checkpointId, saveMetadataAssetGuid: "baseline-meta", saveDataAssetGuid: "baseline-data", nativeSessionGuid: session },
        };
        else payload = { state: "IDLE" };
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    await expect(ports.activateDurableWorld!()).rejects.toThrow("fresh baseline world changed");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
    expect(ports.durability?.snapshot().commands).toEqual([]);
  });

  test("wrong-world completion receipt remains uncertified and fails closed", async () => {
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name }: { name: string }) => ({ structuredContent:
        name === "cs2_game_state" ? world(false) :
          name === "cs2_save_game" ? { status: "SUBMITTED", saveRequestId: "wrong-world-request" } : {
            status: "COMPLETED", durable: true, worldId: "cs2-session:wrong", worldGeneration: "generation-fresh",
            checkpoint: { checkpointId, nativeSessionGuid: "wrong" },
          },
      }),
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
      baselineSaveCompletionChecks: 1,
      baselineSavePollMs: 0,
    });
    await expect(ports.activateDurableWorld!()).rejects.toThrow("stale or mismatched world receipt");
    expect(ports.durability?.snapshot().certifiedRollbackAnchor).toBeNull();
  });

  test("same generation but changed authoritative live state cannot authorize first write", async () => {
    let stateReads = 0;
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_save_status", "cs2_save_game"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown;
        if (name === "cs2_game_state") payload = { ...world(false), observedWorldRevision: ++stateReads };
        else if (name === "cs2_save_game") payload = { status: "SUBMITTED", saveRequestId: "external-change-request" };
        else if (args.requestId === "external-change-request") payload = {
          status: "COMPLETED", durable: true, worldId, worldGeneration: "generation-fresh",
          checkpoint: { checkpointId, saveMetadataAssetGuid: "baseline-meta", saveDataAssetGuid: "baseline-data", nativeSessionGuid: session },
        };
        else payload = { state: "IDLE" };
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    await expect(ports.activateDurableWorld!()).rejects.toThrow("fresh baseline world changed");
    expect(ports.durability?.snapshot()).toMatchObject({ certifiedRollbackAnchor: null, commands: [] });
  });
});
