import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type V2DurableStateStorage,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord } from "@/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts } from "@/main/services/ai-mayor/v2/main-adapter";

/**
 * A utility workflow authorizes more than cables: a water pipe, a sewage pipe,
 * and the access road a facility repair builds are all `build_road` actions
 * under the UTILITY family, and none of them is the electricity direct cable.
 *
 * (The descendant confirmation quorum this spec once exercised is retired: an
 * unregistered save now re-baselines on the loaded world instead of requiring
 * every inherited command's effect to be re-proven. See G2.)
 *
 * The observer therefore answers for the *course*, not for the cable. It uses
 * the complete entity listing and requires exact same-prefab split geometry;
 * a spatial graph path is only a candidate and never positive command proof.
 *
 * The native side splits a course wherever it needs a node — the live water pipe
 * was realised as two `Small Water Pipe` edges meeting at a midpoint — so a
 * single-edge match would be a test of how the game tessellated the course, not
 * of whether it exists.
 */

const WORLD = "cd0d8ea80e624df4abd692fc89df5cc4";
const WORLD_ID = `cs2-session:${WORLD}`;
const GENERATION = "3d908390d07f44a5b566e9119d72cf46";

const PIPE = "Small Water Pipe";
const ACCESS_ROAD = "Medium Road";
const CABLE = "Low-voltage Ground Cable";

const ENVELOPE = { center: { x: 70.59099720266121, z: 1391.070064796251 }, radius: 320 };

/** The admitted water pipe course, verbatim from the command's own exactInput. */
const PIPE_COURSE = { start: { x: -228.909, z: 1299.57007 }, end: { x: 38.61565000000002, z: 1389.81421 } };
const PIPE_MIDPOINT = { x: -95.1467, z: 1344.6921 };
/** The course does not exist in this world: nothing of the prefab runs from the
 *  authorized start to the authorized end. */
const ELSEWHERE = { x: -600, z: 900 };

const ACCESS_ROAD_COURSE = { start: { x: 38.61565, z: 1389.81421 }, end: { x: 30.62124156951904, z: 1389.5151294051327 } };

function gameState(
  checkpointId: string | null = "save:meta:data",
  generation = GENERATION,
  loadPurpose: "LoadGame" | "NewGame" = "LoadGame",
) {
  const [, loadAssetGuid, saveDataAssetGuid] = checkpointId?.split(":") ?? [];
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    simulation: { paused: true, frameIndex: 10497948 },
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: WORLD_ID,
      nativeSessionGuid: WORLD,
      loadPurpose,
      loadAssetGuid: loadAssetGuid ?? null,
      saveDataAssetGuid: saveDataAssetGuid ?? null,
      mapAssetGuid: "map",
      checkpointId,
      bridgeRuntimeEpoch: "bridge-runtime",
      generation,
      generationSequence: 2,
      generationOrigin: "LOAD_COMPLETED",
      nativeOperationBusy: false,
      nativeOperationStage: "Idle",
    },
  };
}

function utilityCommand(commandId: string, actions: Array<Record<string, unknown>>): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId,
    actionFamily: "UTILITY",
    actionType: actions.some((action) => action.type === "place_building") ? "place_building" : "build_road",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: "tranche-water:task:utility_provision" },
      actionFamily: "UTILITY",
      utilityKind: "water",
      projectId: "project-water",
      trancheId: "tranche-water",
      reservationRef: "reservation-water",
      worldEpochId: `${WORLD_ID}:generation:${GENERATION}`,
      generation: GENERATION,
      topologyRevision: `${GENERATION}:production`,
      certifiedRoadRefs: [],
      exactInput: JSON.stringify(actions),
      spatialEnvelope: { center: { ...ENVELOPE.center }, radius: ENVELOPE.radius },
      budget: { authorizedMaxSpend: 40288, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
    },
    createdAt: "2026-09-23T02:30:00.000Z",
    submittedAt: "2026-09-23T02:30:01.000Z",
    nativeResultSummary: null,
    status: "OBSERVED_MATCH",
    statusHistory: [{ status: "OBSERVED_MATCH", at: "2026-09-23T02:30:02.000Z" }],
    reconciliationStatus: "MATCH",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

const PIPE_COMMAND = "water-pipe";
const ACCESS_ROAD_COMMAND = "water-access-road";
const PLACEMENT_COMMAND = "water-placement";
const CABLE_COMMAND = "electric-cable";
const SEGMENT2_COURSE = { start: { x: -737.33536, z: 727.868744 }, end: { x: -226.909, z: 1316.5 } };

function pipeCommand(): V2CommandRecord {
  return utilityCommand(PIPE_COMMAND, [
    { type: "build_road", prefab: PIPE, x1: PIPE_COURSE.start.x, z1: PIPE_COURSE.start.z, x2: PIPE_COURSE.end.x, z2: PIPE_COURSE.end.z },
  ]);
}

function accessRoadCommand(): V2CommandRecord {
  return utilityCommand(ACCESS_ROAD_COMMAND, [
    {
      type: "build_road",
      prefab: ACCESS_ROAD,
      x1: ACCESS_ROAD_COURSE.start.x,
      z1: ACCESS_ROAD_COURSE.start.z,
      x2: ACCESS_ROAD_COURSE.end.x,
      z2: ACCESS_ROAD_COURSE.end.z,
    },
  ]);
}

function placementCommand(): V2CommandRecord {
  return utilityCommand(PLACEMENT_COMMAND, [
    { type: "place_building", prefab: "GroundwaterPumpingStation01", x: -226.909, z: 1283.57007, rotation: 0 },
  ]);
}

function lineageStorage(...commands: V2CommandRecord[]): V2DurableStateStorage {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  coordinator.activate(gameState());
  for (const command of commands) coordinator.commandJournal.create(command);
  return storage;
}

const siteDetail = (edges: Array<Record<string, unknown>> = []) => ({
  center: { ...ENVELOPE.center },
  terrain: { minHeight: 0, maxHeight: 0, slope: 0 },
  roadGraph: { nodes: [], edges },
  buildings: [],
  zoningCells: [],
});

const netEdge = (entity: { index: number; version: number }, prefab: string, start: { x: number; z: number }, end: { x: number; z: number }) => ({
  entity,
  prefab,
  start: { ...start },
  end: { ...end },
});

/** The live pipe, as the game tessellated it: two edges meeting at a midpoint. */
const splitPipe = () => [
  netEdge({ index: 195163, version: 1 }, PIPE, PIPE_COURSE.start, PIPE_MIDPOINT),
  netEdge({ index: 195164, version: 1 }, PIPE, PIPE_MIDPOINT, PIPE_COURSE.end),
];

/** A pipe of the right prefab, but running somewhere else entirely. */
const pipeElsewhere = () => [netEdge({ index: 195900, version: 1 }, PIPE, ELSEWHERE, { x: ELSEWHERE.x + 40, z: ELSEWHERE.z + 10 })];

const splitSegment2 = () => [
  netEdge({ index: 52164, version: 3 }, CABLE, SEGMENT2_COURSE.start, { x: -680.621338, z: 793.2722 }),
  netEdge({ index: 52165, version: 3 }, CABLE, { x: -680.621338, z: 793.2722 }, { x: -623.907349, z: 858.675659 }),
  netEdge({ index: 52166, version: 3 }, CABLE, { x: -623.907349, z: 858.675659 }, { x: -567.193237, z: 924.079163 }),
  netEdge({ index: 52176, version: 3 }, CABLE, { x: -567.193237, z: 924.079163 }, { x: -510.4792, z: 989.4826 }),
  netEdge({ index: 52177, version: 3 }, CABLE, { x: -510.4792, z: 989.4826 }, { x: -453.7652, z: 1054.88611 }),
  netEdge({ index: 52178, version: 3 }, CABLE, { x: -453.7652, z: 1054.88611 }, { x: -397.051147, z: 1120.28955 }),
  netEdge({ index: 52179, version: 3 }, CABLE, { x: -397.051147, z: 1120.28955 }, { x: -340.337128, z: 1185.693 }),
  netEdge({ index: 52180, version: 3 }, CABLE, { x: -340.337128, z: 1185.693 }, { x: -283.623077, z: 1251.09656 }),
  netEdge({ index: 52181, version: 3 }, CABLE, { x: -283.623077, z: 1251.09656 }, SEGMENT2_COURSE.end),
];

const BASELINE_SAVE = "save:lineage:data-1";
const PARENT_SAVE = "save:lineage:data-2";
const DESCENDANT_SAVE = "save:lineage-descendant:data-3";
const DESCENDANT_GENERATION = "descendant-generation";

function terminalCableCommand() {
  return utilityCommand(CABLE_COMMAND, [
    {
      type: "build_road",
      prefab: CABLE,
      x1: SEGMENT2_COURSE.start.x,
      z1: SEGMENT2_COURSE.start.z,
      x2: SEGMENT2_COURSE.end.x,
      z2: SEGMENT2_COURSE.end.z,
    },
  ]);
}

function saveReceipt(checkpointId: string, worldGeneration = GENERATION) {
  const [, saveMetadataAssetGuid, saveDataAssetGuid] = checkpointId.split(":");
  return {
    status: "COMPLETED" as const,
    durable: true as const,
    worldId: WORLD_ID,
    worldGeneration,
    checkpoint: { checkpointId, saveMetadataAssetGuid, saveDataAssetGuid, nativeSessionGuid: WORLD },
  };
}

function descendantCableStorage() {
  const storage = createMemoryDurableStateStorage();
  const first = new V2DurabilityCoordinator(storage);
  first.activate(gameState(null, GENERATION, "NewGame"));
  first.recordBaselineCheckpoint(saveReceipt(BASELINE_SAVE));
  first.activate(gameState(BASELINE_SAVE));
  const terminal = terminalCableCommand();
  first.commandJournal.create(terminal);
  first.recordCheckpoint(saveReceipt(PARENT_SAVE), first.currentJournalPosition());
  const descendant = new V2DurabilityCoordinator(storage);
  const activation = descendant.activate(gameState(DESCENDANT_SAVE, DESCENDANT_GENERATION));
  if (activation.status !== "DESCENDANT_CHECKPOINT_REQUIRED") throw new Error("fixture did not re-baseline the descendant save");
  return { storage, descendant, activation, terminal };
}

interface ListingOptions {
  roads?: Array<Record<string, unknown>> | null;
  truncated?: boolean;
  hasMore?: boolean;
  roadGraphEdges?: Array<Record<string, unknown>>;
  liveWorld?: Record<string, unknown>;
  saves?: Array<Record<string, unknown>>;
}

function bridgeTools(options: ListingOptions = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const listings: Array<Record<string, unknown>> = [];
  const manager = {
    legacyList: async () => ({
      tools: ["cs2_game_state", "cs2_saves", "cs2_list_buildings", "cs2_utility_connectors", "cs2_spatial", "cs2_list_roads"].map((name) => ({
        name: `cs2--${name}`,
      })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name, args });
      const payload =
        name === "cs2_game_state"
          ? options.liveWorld ?? gameState()
          : name === "cs2_saves"
            ? { loadedSaveMetadataAssetGuid: "lineage-descendant", saves: options.saves ?? [] }
          : name === "cs2_list_buildings"
            ? {
                buildings: [
                  {
                    entity: { index: 190180, version: 73 },
                    prefab: "GroundwaterPumpingStation01",
                    isSubBuilding: false,
                    position: { x: -226.909, z: 1283.57007 },
                  },
                ],
              }
            : name === "cs2_spatial"
              ? siteDetail(options.roadGraphEdges ?? [])
              : name === "cs2_list_roads"
              ? (listings.push(args),
                {
                    roads: options.roads ?? [],
                    totalMatches: (options.roads ?? []).length,
                    returned: (options.roads ?? []).length,
                    complete: true,
                    truncated: options.truncated ?? false,
                    hasMore: options.hasMore ?? false,
                  })
                : { connectors: [] };
      return { structuredContent: payload };
    },
  };
  return {
    manager,
    calls,
    get netListings() {
      return listings;
    },
  };
}

async function observe(commandId: string, options: ListingOptions & { commands?: V2CommandRecord[] } = {}) {
  const storage = lineageStorage(...(options.commands ?? [pipeCommand()]));
  const tools = bridgeTools(options);
  const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
  const durability = ports.durability;
  if (!durability || !ports.observeCurrentWorldCommandEffect) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
  durability.activate(gameState());
  const result = await ports.observeCurrentWorldCommandEffect(commandId);
  return { ...result, tools };
}

describe("a descendant observation answers for the course, not for the cable", () => {
  test("A. a water pipe the road graph cannot carry is proven through the game's own net listing", async () => {
    const { effect, tools } = await observe(PIPE_COMMAND, { roads: splitPipe() });

    expect(effect.verdict).toBe("EFFECT_PRESENT");
    // The net listing was asked about the course's own prefab, and asked once:
    // one question, one answer, for one course.
    expect(tools.netListings).toHaveLength(1);
    expect(tools.netListings[0].query).toBe(PIPE);
  });

  test("B. a road graph candidate is confirmed with concrete entities from the full net listing", async () => {
    const { effect, tools } = await observe(ACCESS_ROAD_COMMAND, {
      commands: [accessRoadCommand()],
      roadGraphEdges: [
        netEdge({ index: 96854, version: 1 }, ACCESS_ROAD, ACCESS_ROAD_COURSE.start, ACCESS_ROAD_COURSE.end),
      ],
      roads: [netEdge({ index: 96854, version: 1 }, ACCESS_ROAD, ACCESS_ROAD_COURSE.start, ACCESS_ROAD_COURSE.end)],
    });

    expect(effect.verdict).toBe("EFFECT_PRESENT");
    expect(effect.evidence).toContain('"index":96854');
    expect(effect.evidence).toContain('"source":"cs2_list_roads"');
    expect(tools.netListings).toHaveLength(1);
  });

  test("C. a complete listing that does not contain the course proves the effect absent", async () => {
    const { effect } = await observe(PIPE_COMMAND, { roads: pipeElsewhere() });

    expect(effect.verdict).toBe("EFFECT_ABSENT");
    expect(effect.evidence).toContain(PIPE);
  });

  test("D. a truncated listing is unproven, never a proven absence", async () => {
    const { effect } = await observe(PIPE_COMMAND, { roads: [], truncated: true });

    expect(effect.verdict).toBe("UNPROVEN");
    expect(effect.evidence).toContain("truncated");
  });

  test("E. an incomplete listing is unproven too", async () => {
    const { effect } = await observe(PIPE_COMMAND, { roads: [], hasMore: true });

    expect(effect.verdict).toBe("UNPROVEN");
  });

  test("F. a facility placement keeps its own evidence and asks for no listing", async () => {
    const { effect, tools } = await observe(PLACEMENT_COMMAND, { commands: [placementCommand()] });

    expect(effect.verdict).toBe("EFFECT_PRESENT");
    expect(effect.evidence).toContain('"prefab":"GroundwaterPumpingStation01"');
    expect(tools.netListings).toEqual([]);
  });

  test("G. the electricity direct cable keeps its own topology path", async () => {
    // The cable's physical effect is the one the engine can also refuse to join
    // to the network, so it is judged by the topology binding — never by "a net
    // edge of that prefab is lying along the course".
    const cable = utilityCommand(CABLE_COMMAND, [
      { type: "build_road", prefab: CABLE, x1: PIPE_COURSE.start.x, z1: PIPE_COURSE.start.z, x2: PIPE_COURSE.end.x, z2: PIPE_COURSE.end.z },
    ]);
    const { effect, tools } = await observe(CABLE_COMMAND, { commands: [cable], roads: splitPipe() });

    expect(effect.verdict).toBe("UNPROVEN");
    expect(effect.evidence).not.toContain("net listing");
    expect(tools.netListings).toEqual([]);
  });

  // REWRITTEN (G2): the old G2 asserted that a descendant activation proved the
  // terminal cable from the exact current-world net course and appended that
  // observation. That descendant-only proof is retired, so the surviving
  // invariant is the new re-baseline: the unregistered save re-bases on the
  // loaded world, the caller certifies a durable checkpoint, history stays
  // immutable, and the cable keeps the regular topology path (no net listing).
  test("G2. an unregistered descendant save re-baselines and certifies instead of proving the inherited cable", async () => {
    const { storage, terminal } = descendantCableStorage();
    const loadedWorld = gameState(DESCENDANT_SAVE, DESCENDANT_GENERATION);
    const tools = bridgeTools({
      roads: splitSegment2(),
      liveWorld: loadedWorld,
      saves: [{
        isLoadedSave: true,
        durable: true,
        isCurrentSession: true,
        checkpointId: DESCENDANT_SAVE,
        saveMetadataAssetGuid: "lineage-descendant",
        saveDataAssetGuid: "data-3",
        nativeSessionGuid: WORLD,
      }],
    });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
    const { durability } = ports;
    if (!durability || !ports.activateDurableWorld || !ports.observeCurrentWorldCommandEffect) {
      throw new Error("V2 production durable activation is unavailable");
    }
    const activation = await ports.activateDurableWorld();

    // The re-baseline certified a durable checkpoint for the loaded world, so
    // execution is activated again: this is the world being the authority, not a
    // proof of the inherited commands.
    expect(durability.isExecutionDurablyActivated(activation)).toBe(true);
    // The re-baseline leaves no project state or Goal plan standing on it.
    expect(durability.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(durability.snapshot().goalWorkOrders).toEqual([]);
    expect(durability.snapshot().activeGoalWorkOrderId).toBeNull();
    // History is immutable: re-baselining moves the journal cut, it never
    // rewrites the command's recorded outcome.
    expect(durability.commandJournal.list().find((entry) => entry.commandId === CABLE_COMMAND)?.status).toBe(terminal.status);
    expect(terminal.status).toBe("OBSERVED_MATCH");

    // The terminal cable now falls back to the regular topology path, and no
    // descendant-only net course listing is consulted for it.
    const { effect } = await ports.observeCurrentWorldCommandEffect(CABLE_COMMAND);
    expect(effect.verdict).toBe("UNPROVEN");
    expect(tools.netListings).toEqual([]);
  });

  // DELETED (G3, G4): both exercised `confirmDescendantSaveReload`'s proof gate —
  // a missing current-world course had to fail it closed and leave the
  // observation log append-only, a truncated one had to stay ambiguous. That API
  // is gone (an unregistered save no longer re-proves inherited commands before
  // authority is granted), so those assertions have no subject. The invariants
  // they rested on — a complete listing with no course proves absence, a
  // truncated one is UNPROVEN — still stand and remain covered by C, D and E.

  test("H. an action that is neither a placement nor a course stays unsupported", async () => {
    const unsupported = utilityCommand("unsupported", [{ type: "bulldoze", x: 1, z: 2 }]);
    const { effect } = await observe("unsupported", { commands: [unsupported] });

    expect(effect.verdict).toBe("UNPROVEN");
    expect(effect.evidence).toBe("UTILITY effect action is unsupported");
  });
});
