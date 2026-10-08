import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type V2DurableStateStorage,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord } from "@/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts } from "@/main/services/ai-mayor/v2/main-adapter";
import { reacquireTargetRoadByApprovedContact } from "@/main/services/ai-mayor/v2/utility-target-binding";
import type { SpatialPoint2, SpatialRoadEdge } from "@/main/services/ai-mayor/spatial/types";

/**
 * `observeCommandEffectInCurrentWorld` answers for the CURRENT world, so every
 * binding it asks the Bridge to validate has to name current entities.
 *
 * A command's `authorizedScope` cannot supply them. Its `certifiedRoadRefs` are
 * entity ids of the generation the command ran in, and an id is not an identity:
 * after a reload the same road is a different entity, and the recorded id
 * resolves to nothing at all. Reading the current world through that id asks the
 * Bridge about a road that no longer exists, and the Bridge — correctly — calls
 * the answer STALE, which leaves the connection objective UNKNOWN forever even
 * though the admitted course is physically present.
 *
 * What does survive is the admitted course, which was authorized as immutable
 * geometry. So the current target road is reacquired from the course's own
 * approved contact, the current connector from the journal-authorized facility,
 * and the physical effect is judged by the same production course matcher the
 * planner uses — never by "a cable is lying nearby".
 *
 * The historical command record stays immutable throughout: the observation is
 * append-only and the execution-time verdict is never restated.
 */

const WORLD = "cd0d8ea80e624df4abd692fc89df5cc4";
const WORLD_ID = `cs2-session:${WORLD}`;
const GENERATION = "90f38559912144c7b494b9445f863974";
/** The generation the cable command was authorized in. Gone, and correctly so. */
const STALE_GENERATION = "3d206ee9596e4315b64cc55dd81a607b";

const CABLE = "Low-voltage Ground Cable";
const FACILITY = { index: 176455, version: 1 };
const FACILITY_PLACEMENT = { prefab: "WindTurbineElectricity", x: -1128.4, z: -11.0 };
const CONNECTOR = { index: 185275, version: 1 };
const TARGET_ROAD = { index: 187602, version: 1 };
/** The road the command was authorized against, in a generation that is gone. */
const STALE_ROAD = { index: 45586, version: 13 };

/** The admitted course, verbatim from the command's own exactInput. */
const ADMITTED = { start: { x: -1117.83313, z: -11.0255737 }, end: { x: -1247.55188, z: -12.3875341 } };
const ENVELOPE = { center: { x: -1279.5518493553857, z: -12.431820151711868 }, radius: 180 };

/** The two permanent segments the engine split the single admitted course into. */
const SEGMENT_A = {
  entity: { index: 192398, version: 1 }, prefab: CABLE, permanent: true, temp: false, deleted: false,
  start: { ...ADMITTED.start }, end: { x: -1182.6925, z: -11.7065535 },
  startNode: { index: 190102, version: 1 }, endNode: { index: 190087, version: 1 },
};
const SEGMENT_B = {
  entity: { index: 192399, version: 1 }, prefab: CABLE, permanent: true, temp: false, deleted: false,
  start: { x: -1182.6925, z: -11.7065535 }, end: { x: -1247.55212, z: -12.3875341 },
  startNode: { index: 190087, version: 1 }, endNode: { index: 190101, version: 1 },
};

/** The same single course, but ending nowhere near the admitted contact. */
const STRAY_COURSE = {
  entity: { index: 192500, version: 1 }, prefab: CABLE, permanent: true, temp: false, deleted: false,
  start: { ...ADMITTED.start }, end: { x: -1050.5, z: -40.25 },
  startNode: { index: 190200, version: 1 }, endNode: { index: 190201, version: 1 },
};

const exactCableInput = () =>
  JSON.stringify([{ type: "build_road", prefab: CABLE, x1: ADMITTED.start.x, z1: ADMITTED.start.z, x2: ADMITTED.end.x, z2: ADMITTED.end.z }]);

function gameState() {
  return {
    gameMode: "Game", isLoading: false, cityLoaded: true,
    simulation: { paused: true, frameIndex: 10497948 },
    world: {
      identityStatus: "AVAILABLE", worldReady: true,
      worldId: WORLD_ID, nativeSessionGuid: WORLD,
      loadPurpose: "LoadGame", loadAssetGuid: "meta", saveDataAssetGuid: "data", mapAssetGuid: "map",
      checkpointId: "save:meta:data", bridgeRuntimeEpoch: "bridge-runtime",
      generation: GENERATION, generationSequence: 2, generationOrigin: "LOAD_COMPLETED",
      nativeOperationBusy: false, nativeOperationStage: "Idle",
    },
  };
}

/** The facility placement command, as the journal recorded it. */
function facilityCommand(): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: "facility-placement",
    actionFamily: "UTILITY",
    actionType: "place_building",
    authorizedScope: {
      owner: { ownerType: "TRANCHE", ownerId: "tranche-a" },
      actionFamily: "UTILITY",
      utilityKind: "electricity",
      projectId: "project-a",
      trancheId: "tranche-a",
      reservationRef: "reservation-a",
      worldEpochId: `${WORLD_ID}:generation:${STALE_GENERATION}`,
      generation: STALE_GENERATION,
      topologyRevision: `${STALE_GENERATION}:production`,
      certifiedRoadRefs: [{ ...STALE_ROAD }],
      exactInput: JSON.stringify([{
        type: "place_building", prefab: FACILITY_PLACEMENT.prefab, x: FACILITY_PLACEMENT.x, z: FACILITY_PLACEMENT.z,
      }]),
      spatialEnvelope: { center: { ...ENVELOPE.center }, radius: ENVELOPE.radius },
      budget: { authorizedMaxSpend: 25000, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
    },
    createdAt: "2026-09-22T16:00:00.000Z",
    submittedAt: "2026-09-22T16:00:01.000Z",
    nativeResultSummary: null,
    status: "OBSERVED_MATCH",
    statusHistory: [{ status: "OBSERVED_MATCH", at: "2026-09-22T16:00:02.000Z" }],
    reconciliationStatus: "MATCH",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

/**
 * The cable command, as the journal recorded it: FAILED, with the effect proven
 * absent when it ran, and authorized against a road of a generation that no
 * longer exists.
 */
function cableCommand(): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: "cable-attempt",
    actionFamily: "UTILITY",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TRANCHE", ownerId: "tranche-a" },
      actionFamily: "UTILITY",
      utilityKind: "electricity",
      projectId: "project-a",
      trancheId: "tranche-a",
      reservationRef: "reservation-a",
      worldEpochId: `${WORLD_ID}:generation:${STALE_GENERATION}`,
      generation: STALE_GENERATION,
      topologyRevision: `${STALE_GENERATION}:production`,
      certifiedRoadRefs: [{ ...STALE_ROAD }],
      exactInput: exactCableInput(),
      spatialEnvelope: { center: { ...ENVELOPE.center }, radius: ENVELOPE.radius },
      budget: { authorizedMaxSpend: 25000, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
    },
    createdAt: "2026-09-22T16:10:00.000Z",
    submittedAt: "2026-09-22T16:10:01.000Z",
    nativeResultSummary: null,
    status: "FAILED",
    statusHistory: [{ status: "FAILED", at: "2026-09-22T16:10:02.000Z" }],
    reconciliationStatus: "MISMATCH",
    observationEvidence: [],
    failureOrUnknownReason: "native command did not complete",
    effectAbsenceProven: true,
  };
}

/** A durable store holding the lineage, activated against the current world. */
function lineageStorage(): V2DurableStateStorage {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  coordinator.activate(gameState());
  coordinator.commandJournal.create(facilityCommand());
  coordinator.commandJournal.create(cableCommand());
  return storage;
}

const plainConnector = () => ({
  type: "electricity", node: { ...CONNECTOR }, prefab: "ElectricityConnection",
  worldPosition: { x: ADMITTED.start.x, y: 0, z: ADMITTED.start.z },
  attached: true, orphan: true,
  connectedEdges: [{ entity: { index: 192398, version: 1 }, prefab: CABLE, ownedByFacility: true }],
});

const siteDetail = (edges: Array<Record<string, unknown>>) => ({
  center: { ...ENVELOPE.center },
  terrain: { minHeight: 0, maxHeight: 0, slope: 0 },
  roadGraph: { nodes: [], edges },
  buildings: [],
  zoningCells: [],
});

/** The current world's road graph: the target road's endpoint IS the approved contact. */
const currentRoadEdges = () => [
  {
    entity: { ...TARGET_ROAD }, prefab: "Medium Road", native: false,
    startNode: { index: 187126, version: 1 }, endNode: { index: 187127, version: 1 },
    start: { ...ADMITTED.end }, end: { x: -1300, z: -12.4 }, length: 52.5,
  },
];

/** The current world's road graph with no road at the approved contact at all. */
const roadsWithoutTheContact = () => [
  {
    entity: { ...TARGET_ROAD }, prefab: "Medium Road", native: false,
    startNode: { index: 187126, version: 1 }, endNode: { index: 187127, version: 1 },
    start: { x: -1300, z: -12.4 }, end: { x: -1350, z: -12.4 }, length: 50,
  },
];

/** Two current roads meeting the approved contact, so the rebind proves nothing. */
const ambiguousRoadsAtTheContact = () => [
  ...currentRoadEdges(),
  {
    entity: { index: 187700, version: 1 }, prefab: "Small Road", native: false,
    startNode: { index: 187701, version: 1 }, endNode: { index: 187702, version: 1 },
    start: { ...ADMITTED.end }, end: { x: -1290, z: -30 }, length: 22,
  },
];

interface TopologyOptions {
  bindingStatus?: string;
  attached?: boolean;
  networkConnected?: boolean;
  targetNetworkReachable?: boolean | null;
  scanEdges?: Array<Record<string, unknown>>;
  physicalEdges?: Array<Record<string, unknown>>;
}

function topologyResponse(options: TopologyOptions = {}) {
  const scanEdges = options.scanEdges ?? [SEGMENT_A, SEGMENT_B];
  const physicalEdges = options.physicalEdges ?? [{ ...SEGMENT_A, incidentNode: { ...CONNECTOR } }];
  return {
    topology: {
      binding: {
        worldId: WORLD_ID, generation: GENERATION, frameIndex: 42,
        topologyRevision: `${GENERATION}:${TARGET_ROAD.index}:${TARGET_ROAD.version}`,
        bindingStatus: options.bindingStatus ?? "VALID", complete: true, truncated: false,
      },
      connector: {
        entity: { ...CONNECTOR }, flowNode: { index: 900001, version: 1 },
        physicalEdges, physicalComplete: true,
        connectedFlowEdges: [], flowComplete: true,
        networkConnected: options.networkConnected ?? true,
        attached: options.attached ?? true,
        orphan: true,
      },
      targetNetwork: {
        target: { entity: { ...TARGET_ROAD } }, flowNodes: [], targetEndpoints: [],
        reachablePath: [{ entity: { index: 700001, version: 1 } }],
        complete: true, truncated: false,
        networkConnected: true,
        targetNetworkReachable: options.targetNetworkReachable ?? true,
      },
      admittedAction: null,
      candidateScan: { complete: true, truncated: false, edges: scanEdges, matchingEdges: [] },
    },
  };
}

const MUTATION_TOOLS = ["cs2_build_road", "cs2_mayor_execute_actions", "cs2_save_game", "cs2_run_simulation", "cs2_bulldoze"];

/**
 * The Bridge tools double. `topology` is what the topology read reports; the
 * road graph, the plain connector list, and the world identity are all
 * separately overridable so a test can break exactly one link of the binding.
 */
function bridgeTools(options: TopologyOptions & {
  roadEdges?: Array<Record<string, unknown>>;
  connectors?: Array<Record<string, unknown>>;
  buildingRead?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const manager = {
    legacyList: async () => ({
      tools: ["cs2_game_state", "cs2_list_buildings", "cs2_utility_connectors", "cs2_spatial", ...MUTATION_TOOLS]
        .map((name) => ({ name: `cs2--${name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name, args });
      const payload =
        name === "cs2_game_state" ? gameState()
          : name === "cs2_list_buildings"
            ? options.buildingRead ?? {
                buildings: [{
                  entity: { ...FACILITY }, prefab: FACILITY_PLACEMENT.prefab, isSubBuilding: false,
                  position: { x: FACILITY_PLACEMENT.x, z: FACILITY_PLACEMENT.z },
                }],
              }
            : name === "cs2_spatial" ? siteDetail(options.roadEdges ?? currentRoadEdges())
              : name === "cs2_utility_connectors"
                ? args.connector && args.target ? topologyResponse(options) : { connectors: options.connectors ?? [plainConnector()] }
                : { status: "SUBMITTED" };
      return { structuredContent: payload };
    },
  };
  return {
    manager,
    calls,
    get nativeMutations() {
      return calls.filter((call) => MUTATION_TOOLS.includes(call.name));
    },
    /** Every target entity the observer ever asked the Bridge about. */
    get requestedTargets() {
      return calls.filter((call) => call.args.target !== undefined)
        .map((call) => {
          const target = call.args.target as Record<string, unknown>;
          return `${String(target.index)}:${String(target.version)}`;
        });
    },
  };
}

const COMMAND_ID = "cable-attempt";

async function observe(options: TopologyOptions & {
  roadEdges?: Array<Record<string, unknown>>;
  connectors?: Array<Record<string, unknown>>;
} = {}) {
  const storage = lineageStorage();
  const tools = bridgeTools(options);
  const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
  const durability = ports.durability;
  if (!durability || !ports.observeCurrentWorldCommandEffect) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
  durability.activate(gameState());
  const result = await ports.observeCurrentWorldCommandEffect(COMMAND_ID);
  return { ...result, durability, tools, storage };
}

describe("the current-world observer binds to the current world, not to a stale entity id", () => {
  test("an incomplete building list cannot prove a placement absent", async () => {
    const storage = lineageStorage();
    const omitted = Array.from({ length: 64 }, (_, index) => ({
      entity: { index: 300000 + index, version: 1 }, prefab: FACILITY_PLACEMENT.prefab, isSubBuilding: false,
      position: { x: 1000 + index, z: 1000 },
    }));
    const tools = bridgeTools({ buildingRead: { buildings: omitted, totalMatches: 100, returned: 64, truncated: true } });
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
    const durability = ports.durability;
    if (!durability || !ports.observeCurrentWorldCommandEffect) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    durability.activate(gameState());
    const result = await ports.observeCurrentWorldCommandEffect("facility-placement");
    expect(result.effect.verdict).toBe("UNPROVEN");
    expect(result.observation?.currentWorldEffectPresent).toBeNull();
  });

  test("A. a stale historical target with a rebindable current one claims the objective", async () => {
    const { observation, tools } = await observe();

    expect(observation.currentWorldEffectPresent).toBe(true);
    expect(observation.currentWorldObjectiveSatisfied).toBe(true);
    // The historical id is gone from the world and is never asked about.
    expect(tools.requestedTargets).toEqual([`${TARGET_ROAD.index}:${TARGET_ROAD.version}`]);
    expect(tools.requestedTargets).not.toContain(`${STALE_ROAD.index}:${STALE_ROAD.version}`);
    expect(tools.nativeMutations).toEqual([]);
  });

  test("B. a historical target that cannot be rebound in the current world is UNKNOWN, not claimed", async () => {
    const { observation, tools } = await observe({ roadEdges: roadsWithoutTheContact() });

    expect(observation.currentWorldEffectPresent).toBeNull();
    expect(observation.currentWorldObjectiveSatisfied).toBeNull();
    // Nothing was asked about the stale id, and no topology read was attempted
    // against a target that could not be proven.
    expect(tools.requestedTargets).toEqual([]);
  });

  test("B. several current roads at the approved contact prove nothing either", async () => {
    const { observation } = await observe({ roadEdges: ambiguousRoadsAtTheContact() });

    expect(observation.currentWorldEffectPresent).toBeNull();
    expect(observation.currentWorldObjectiveSatisfied).toBeNull();
  });

  test("C. a connector that cannot be certified as this facility's own is UNKNOWN", async () => {
    const { observation } = await observe({ connectors: [] });

    expect(observation.currentWorldEffectPresent).toBeNull();
    expect(observation.currentWorldObjectiveSatisfied).toBeNull();
  });

  test("C. two electricity connectors on one facility prove nothing either", async () => {
    const { observation } = await observe({
      connectors: [plainConnector(), { ...plainConnector(), node: { index: 185276, version: 1 } }],
    });

    expect(observation.currentWorldEffectPresent).toBeNull();
    expect(observation.currentWorldObjectiveSatisfied).toBeNull();
  });

  test("C. a connector the Bridge refuses to bind leaves the objective UNKNOWN", async () => {
    const { observation } = await observe({ bindingStatus: "STALE" });

    // An unbound topology proves nothing, so nothing is claimed: the effect is
    // not asserted present and the objective is left UNKNOWN rather than false.
    expect(observation.currentWorldEffectPresent).toBeNull();
    expect(observation.currentWorldObjectiveSatisfied).toBeNull();
    expect(observation.evidence).toContain("binding=STALE");
  });

  test("D. a current cable course that is not the admitted one is not claimed as this command's effect", async () => {
    // The connector and the target road are both valid, but the permanent cable
    // in this world runs somewhere else. "A cable is nearby" is not this
    // command's course, so the objective is never claimed.
    const { observation } = await observe({
      scanEdges: [STRAY_COURSE],
      physicalEdges: [{ ...STRAY_COURSE, incidentNode: { ...CONNECTOR } }],
    });

    expect(observation.currentWorldEffectPresent).toBe(false);
    expect(observation.currentWorldObjectiveSatisfied).not.toBe(true);
    expect(observation.evidence).toContain("course=PROVEN_MISMATCH");
  });

  test("E. the historical command record is not touched by a current-world observation", async () => {
    const { observation, durability } = await observe();
    const entry = durability.snapshot().commands.find((candidate) => candidate.record.commandId === COMMAND_ID);

    expect(entry?.record.status).toBe("FAILED");
    expect(entry?.record.effectAbsenceProven).toBe(true);
    expect(entry?.record.reconciliationStatus).toBe("MISMATCH");
    expect(entry?.record.authorizedScope).toMatchObject({
      certifiedRoadRefs: [{ ...STALE_ROAD }],
      generation: STALE_GENERATION,
      worldEpochId: `${WORLD_ID}:generation:${STALE_GENERATION}`,
      exactInput: exactCableInput(),
    });
    // The verdict recorded alongside the observation is the command's own, copied
    // by the store — a caller cannot restate history to agree with what it saw.
    expect(observation.historicalVerdict).toEqual({ status: "FAILED", effectAbsenceProven: true });
  });

  test("F. observations are append-only and leave the journal position alone", async () => {
    const storage = lineageStorage();
    const tools = bridgeTools();
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
    const durability = ports.durability;
    if (!durability || !ports.observeCurrentWorldCommandEffect) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    durability.activate(gameState());

    const positionBefore = durability.snapshot().journalPosition;
    const first = await ports.observeCurrentWorldCommandEffect(COMMAND_ID);
    const second = await ports.observeCurrentWorldCommandEffect(COMMAND_ID);
    const observations = durability.worldObservations(COMMAND_ID);

    expect(observations).toHaveLength(2);
    expect(observations[0]).toEqual(first.observation);
    expect(observations[1]).toEqual(second.observation);
    expect(durability.snapshot().journalPosition).toBe(positionBefore);
    expect(durability.snapshot().commands.find((entry) => entry.record.commandId === COMMAND_ID)?.record.status).toBe("FAILED");
  });

  test("G. the two existing permanent segments are the admitted course, and nothing is submitted", async () => {
    const { observation, tools } = await observe();

    expect(observation.evidence).toContain("course=OBSERVED_MATCH");
    expect(observation.evidence).toContain("matchedCableEdges=2");
    expect(observation.evidence).toContain("objective=COMPLETE");
    expect(observation.currentWorldObjectiveSatisfied).toBe(true);
    // Reading the world never writes to it: no cable, no save, no Skill dispatch.
    expect(tools.nativeMutations).toEqual([]);
    expect(tools.calls.map((call) => call.name)).toEqual([
      "cs2_list_buildings", "cs2_utility_connectors", "cs2_game_state", "cs2_spatial", "cs2_utility_connectors",
    ]);
  });
});

describe("the target road is reacquired by approved contact, never by entity id", () => {
  const road = (
    index: number,
    start: SpatialPoint2,
    end: SpatialPoint2,
    overrides: Partial<SpatialRoadEdge> = {},
  ): SpatialRoadEdge => ({
    entity: { index, version: 1 }, prefab: "Medium Road", native: false,
    startNode: { index: index * 10, version: 1 }, endNode: { index: index * 10 + 1, version: 1 },
    start, end, length: Math.hypot(end.x - start.x, end.z - start.z), ...overrides,
  });

  test("exactly one current road at the contact is the rebound target", () => {
    expect(reacquireTargetRoadByApprovedContact({
      edges: [road(1, { x: -1300, z: -12.4 }, ADMITTED.end)],
      approvedContact: ADMITTED.end,
    })).toMatchObject({ status: "YES", road: { entity: { index: 1, version: 1 } } });
  });

  test("no current road at the contact proves nothing", () => {
    expect(reacquireTargetRoadByApprovedContact({
      edges: [road(1, { x: -1300, z: -12.4 }, { x: -1350, z: -12.4 })],
      approvedContact: ADMITTED.end,
    }).status).toBe("NO");
  });

  test("several current roads at the contact prove nothing either", () => {
    expect(reacquireTargetRoadByApprovedContact({
      edges: [road(1, { x: -1300, z: -12.4 }, ADMITTED.end), road(2, ADMITTED.end, { x: -1290, z: -30 })],
      approvedContact: ADMITTED.end,
    }).status).toBe("AMBIGUOUS");
  });

  test("a deleted road is not a current road", () => {
    expect(reacquireTargetRoadByApprovedContact({
      edges: [road(1, { x: -1300, z: -12.4 }, ADMITTED.end, { deleted: true })],
      approvedContact: ADMITTED.end,
    }).status).toBe("NO");
  });

  test("a road merely near the contact is not at the contact", () => {
    expect(reacquireTargetRoadByApprovedContact({
      edges: [road(1, { x: -1300, z: -12.4 }, { x: ADMITTED.end.x + 0.4, z: ADMITTED.end.z })],
      approvedContact: ADMITTED.end,
    }).status).toBe("NO");
  });

  // The live water world: the game split one delivered Medium Road into two
  // edges meeting at the very node the course was admitted against, and a map
  // highway also ends there. The contact point identifies three candidates; the
  // command's own prefab and far endpoint identify exactly one.
  describe("a delivered road the game split at its contact node", () => {
    const CONTACT = { x: 38.61565, z: 1389.81421 };
    /** The delivered ROAD command's own far endpoint (`x2, z2` of its exactInput). */
    const FAR = { x: 46.609487533569336, z: 1390.128173727848 };
    const OTHER_SEGMENT_FAR = { x: 30.62124156951904, z: 1389.5151294051327 };
    const delivered = [
      road(186609, CONTACT, OTHER_SEGMENT_FAR),
      road(186610, CONTACT, FAR),
      road(51703, { x: 34.3535843, z: 1503.739 }, CONTACT, { prefab: "Highway Twoway - 2 lanes" }),
    ];

    test("prefab and far endpoint together choose the command's own edge", () => {
      expect(reacquireTargetRoadByApprovedContact({
        edges: delivered, approvedContact: CONTACT, prefab: "Medium Road", farEndpoint: FAR,
      })).toMatchObject({ status: "YES", road: { entity: { index: 186610, version: 1 } } });
    });

    test("the contact alone cannot choose between three edges", () => {
      expect(reacquireTargetRoadByApprovedContact({
        edges: delivered, approvedContact: CONTACT,
      }).status).toBe("AMBIGUOUS");
    });

    test("the prefab alone still leaves several edges at the contact", () => {
      expect(reacquireTargetRoadByApprovedContact({
        edges: delivered, approvedContact: CONTACT, prefab: "Medium Road",
      }).status).toBe("AMBIGUOUS");
    });

    test("the far endpoint alone would accept an edge of another prefab", () => {
      const highwayAtFarEnd = [road(51703, CONTACT, FAR, { prefab: "Highway Twoway - 2 lanes" })];
      expect(reacquireTargetRoadByApprovedContact({
        edges: highwayAtFarEnd, approvedContact: CONTACT, prefab: "Medium Road", farEndpoint: FAR,
      }).status).toBe("NO");
    });

    test("a far endpoint no current edge carries fails closed", () => {
      expect(reacquireTargetRoadByApprovedContact({
        edges: delivered, approvedContact: CONTACT, prefab: "Medium Road", farEndpoint: { x: 0, z: 0 },
      }).status).toBe("NO");
    });
  });
});
