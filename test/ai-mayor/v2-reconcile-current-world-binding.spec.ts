import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type V2DurableStateStorage,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord } from "@/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts, matchExactNetCourseReadback, netCourseCovered } from "@/main/services/ai-mayor/v2/main-adapter";

/**
 * Restart reconciliation answers for the CURRENT world too, so it must build the
 * same binding the current-world observer builds — never from the entity ids the
 * command recorded when it ran.
 *
 * A durable scope's `certifiedRoadRefs` name entities of the generation the
 * command ran in. An id is not an identity: after a reload the same road is a
 * different entity, and the recorded id resolves to nothing. Reconciling
 * through it asks the Bridge about a road that no longer exists, and the Bridge
 * — correctly — answers STALE, so a connection that is physically present is
 * never reconciled and the restart stays inconclusive forever.
 *
 * Both callers therefore go through the *one* shared binding path
 * (`observeAdmittedCableCourse`): the facility from the journal-authorized
 * placement of the same utility scope, that facility's current connector, the
 * target road reacquired from the admitted course's own approved contact, the
 * admitted course geometry, and the live world identity. Neither path carries a
 * second implementation, so the two can never drift apart.
 *
 * Reconciliation is still a durable write: it may restate the command's
 * *reconciliation* verdict, but the historical execution facts — the authorized
 * scope, the certified road refs, the generation it ran in, the exact input —
 * are never rewritten.
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

const CABLE_COMMAND_ID = "cable-attempt";

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
 * The cable command, as the journal recorded it: authorized against a road of a
 * generation that no longer exists, and submitted in a runtime that ended before
 * the outcome could be observed — which is exactly what makes it require
 * reconciliation on the next activation.
 */
function cableCommand(): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: CABLE_COMMAND_ID,
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
    nativeResultSummary: "submitted, outcome not observed before the runtime ended",
    status: "COMMIT_ACK",
    statusHistory: [{ status: "COMMIT_ACK", at: "2026-09-22T16:10:02.000Z" }],
    reconciliationStatus: "MATCH",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

/**
 * A durable store holding the lineage, with the cable command left in a pending
 * outcome so that activation has to reconcile it against the current world.
 * The facility placement is already terminal, so only the cable is pending.
 */
function reconcileStorage(): V2DurableStateStorage {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  coordinator.activate(gameState());
  coordinator.commandJournal.create(facilityCommand());
  coordinator.commandJournal.create(cableCommand());
  const seeded = coordinator.snapshot();
  for (const entry of seeded.commands) {
    entry.outcome = entry.record.commandId === CABLE_COMMAND_ID ? "APPLIED" : "OBSERVED_MATCH";
  }
  storage.save(seeded);
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
  roadEdges?: Array<Record<string, unknown>>;
  connectors?: Array<Record<string, unknown>>;
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
 * The Bridge tools double. Every link of the binding is separately overridable so
 * a test can break exactly one of them and watch reconciliation fail closed.
 */
function bridgeTools(options: TopologyOptions = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const manager = {
    legacyList: async () => ({
      tools: ["cs2_game_state", "cs2_list_buildings", "cs2_utility_connectors", "cs2_spatial", "cs2_save_status", "cs2_saves", "cs2_mayor_snapshot", ...MUTATION_TOOLS]
        .map((name) => ({ name: `cs2--${name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name, args });
      const payload =
        name === "cs2_game_state" ? gameState()
          : name === "cs2_list_buildings"
            ? {
                buildings: [{
                  entity: { ...FACILITY }, prefab: FACILITY_PLACEMENT.prefab, isSubBuilding: false,
                  position: { x: FACILITY_PLACEMENT.x, z: FACILITY_PLACEMENT.z },
                }],
              }
            : name === "cs2_spatial" ? siteDetail(options.roadEdges ?? currentRoadEdges())
              : name === "cs2_utility_connectors"
                ? args.connector && args.target ? topologyResponse(options) : { connectors: options.connectors ?? [plainConnector()] }
                : name === "cs2_save_status" ? { status: "IDLE", state: "IDLE" }
                  : name === "cs2_saves" ? { saves: [] }
                    : name === "cs2_mayor_snapshot" ? {}
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
    /** Every target entity the Bridge was ever asked about, in order. */
    get requestedTargets() {
      return calls.filter((call) => call.args.target !== undefined)
        .map((call) => {
          const target = call.args.target as Record<string, unknown>;
          return `${String(target.index)}:${String(target.version)}`;
        });
    },
    /** The one topology read the binding path performs, if it got that far. */
    get topologyReads() {
      return calls.filter((call) => call.name === "cs2_utility_connectors" && call.args.connector !== undefined && call.args.target !== undefined);
    },
    /** The binding-relevant half of a topology read, for cross-path comparison. */
    get bindingArgs() {
      return calls.filter((call) => call.name === "cs2_utility_connectors" && call.args.connector !== undefined && call.args.target !== undefined)
        .map((call) => ({
          index: call.args.index, version: call.args.version,
          connector: call.args.connector, target: call.args.target,
          expectedWorldId: call.args.expectedWorldId, expectedGeneration: call.args.expectedGeneration,
          expectedTopologyRevision: call.args.expectedTopologyRevision,
          admittedPrefab: call.args.admittedPrefab,
          admittedStart: call.args.admittedStart, admittedEnd: call.args.admittedEnd,
        }));
    },
  };
}

/** Activate the durable world, which is what reconciles the pending cable. */
async function activate(options: TopologyOptions = {}) {
  const storage = reconcileStorage();
  const tools = bridgeTools(options);
  const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
  let error: Error | null = null;
  try {
    await ports.activateDurableWorld!();
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  return { ports, durability: ports.durability!, tools, storage, error };
}

/** Run the current-world observer against the identical fixture, for comparison. */
async function observe(options: TopologyOptions = {}) {
  const storage = reconcileStorage();
  const tools = bridgeTools(options);
  const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
  const durability = ports.durability;
  if (!durability || !ports.observeCurrentWorldCommandEffect) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
  durability.activate(gameState());
  const result = await ports.observeCurrentWorldCommandEffect(CABLE_COMMAND_ID);
  return { ...result, tools };
}

describe("restart reconciliation binds to the current world, not to a stale entity id", () => {
  test("A. a stale historical target with a uniquely reacquired current one reconciles the cable", async () => {
    const { ports, tools, error } = await activate();

    expect(error).toBeNull();
    expect(ports.commandJournal.get(CABLE_COMMAND_ID)).toMatchObject({
      status: "OBSERVED_MATCH",
      reconciliationStatus: "MATCH",
    });
    // The historical id is gone from the world and is never asked about: the
    // only target the Bridge is consulted on is the reacquired current road.
    expect(tools.requestedTargets).toEqual([`${TARGET_ROAD.index}:${TARGET_ROAD.version}`]);
    expect(tools.requestedTargets).not.toContain(`${STALE_ROAD.index}:${STALE_ROAD.version}`);
    // Reconciliation reads the world; it never writes to it.
    expect(tools.nativeMutations).toEqual([]);
  });

  test("A. the reconciled evidence names the current binding, not the recorded generation", async () => {
    const { ports } = await activate();
    const record = ports.commandJournal.get(CABLE_COMMAND_ID);
    const evidence = record?.observationEvidence.at(-1);

    expect(evidence?.phase).toBe("RECONCILIATION");
    expect(evidence?.coherence).toBe("STABLE_FRAME");
    expect(evidence?.details).toMatchObject({
      worldId: WORLD_ID,
      generation: GENERATION,
      topologyRevision: `${GENERATION}:${TARGET_ROAD.index}:${TARGET_ROAD.version}`,
      completeness: { bindingStatus: "VALID", complete: true, truncated: false },
      primitive: { decision: "OBSERVED_MATCH" },
      objective: { status: "COMPLETE" },
    });
    expect(String(evidence?.details?.generation)).not.toBe(STALE_GENERATION);
  });

  test("B. a historical target that cannot be uniquely reacquired fails closed", async () => {
    const { ports, tools, error } = await activate({ roadEdges: roadsWithoutTheContact() });

    expect(error?.message).toContain("restart reconciliation remains inconclusive");
    expect(ports.commandJournal.get(CABLE_COMMAND_ID)).toMatchObject({ reconciliationStatus: "INCONCLUSIVE" });
    // Nothing was asked about the stale id, and no topology read was attempted
    // against a target that could not be proven.
    expect(tools.requestedTargets).toEqual([]);
    expect(tools.topologyReads).toEqual([]);
  });

  test("B. several current roads at the approved contact prove nothing either", async () => {
    const { ports, error, tools } = await activate({ roadEdges: ambiguousRoadsAtTheContact() });

    expect(error?.message).toContain("restart reconciliation remains inconclusive");
    expect(ports.commandJournal.get(CABLE_COMMAND_ID)).toMatchObject({ reconciliationStatus: "INCONCLUSIVE" });
    expect(tools.topologyReads).toEqual([]);
  });

  test("C. a connector that cannot be certified as this facility's own fails closed", async () => {
    const { ports, error, tools } = await activate({ connectors: [] });

    expect(error?.message).toContain("restart reconciliation remains inconclusive");
    expect(ports.commandJournal.get(CABLE_COMMAND_ID)).toMatchObject({ reconciliationStatus: "INCONCLUSIVE" });
    expect(tools.topologyReads).toEqual([]);
  });

  test("C. two electricity connectors on one facility prove nothing either", async () => {
    const { ports, error, tools } = await activate({
      connectors: [plainConnector(), { ...plainConnector(), node: { index: 185276, version: 1 } }],
    });

    expect(error?.message).toContain("restart reconciliation remains inconclusive");
    expect(ports.commandJournal.get(CABLE_COMMAND_ID)).toMatchObject({ reconciliationStatus: "INCONCLUSIVE" });
    expect(tools.topologyReads).toEqual([]);
  });

  test("C. a connector the Bridge refuses to bind leaves reconciliation inconclusive", async () => {
    const { ports, error, tools } = await activate({ bindingStatus: "STALE" });

    // An unbound topology proves nothing, so nothing is claimed and nothing is
    // denied: the restart stays blocked rather than inventing a verdict.
    expect(error?.message).toContain("restart reconciliation remains inconclusive");
    const record = ports.commandJournal.get(CABLE_COMMAND_ID);
    expect(record).toMatchObject({ reconciliationStatus: "INCONCLUSIVE" });
    expect(record?.status).not.toBe("OBSERVED_MATCH");
    expect(tools.topologyReads).toHaveLength(1);
  });

  test("D. a current cable course that is not the admitted one is not claimed", async () => {
    // The connector and the target road are both valid, but the permanent cable
    // in this world runs somewhere else. "A cable is nearby" is not this
    // command's course, so reconciliation never claims the effect.
    const { ports, tools } = await activate({
      scanEdges: [STRAY_COURSE],
      physicalEdges: [{ ...STRAY_COURSE, incidentNode: { ...CONNECTOR } }],
    });

    const record = ports.commandJournal.get(CABLE_COMMAND_ID);
    expect(record?.status).not.toBe("OBSERVED_MATCH");
    expect(record?.reconciliationStatus).not.toBe("MATCH");
    // The absence is proven from a topology the Bridge actually bound, so it is
    // recorded as a mismatch rather than left open.
    expect(record).toMatchObject({ status: "OBSERVED_MISMATCH", reconciliationStatus: "MISMATCH", effectAbsenceProven: true });
    expect(tools.nativeMutations).toEqual([]);
  });

  test("E. reconciliation never rewrites the historical execution facts", async () => {
    const { ports, storage } = await activate();
    const record = ports.commandJournal.get(CABLE_COMMAND_ID);

    expect(record?.authorizedScope).toMatchObject({
      certifiedRoadRefs: [{ ...STALE_ROAD }],
      generation: STALE_GENERATION,
      worldEpochId: `${WORLD_ID}:generation:${STALE_GENERATION}`,
      topologyRevision: `${STALE_GENERATION}:production`,
      exactInput: exactCableInput(),
      spatialEnvelope: { center: { ...ENVELOPE.center }, radius: ENVELOPE.radius },
    });
    // The command id, its creation time, and the input it was authorized with
    // are the record of what happened, and reconciliation only appends.
    expect(record?.commandId).toBe(CABLE_COMMAND_ID);
    expect(record?.createdAt).toBe("2026-09-22T16:10:00.000Z");
    expect(record?.submittedAt).toBe("2026-09-22T16:10:01.000Z");
    expect(record?.statusHistory[0]).toEqual({ status: "COMMIT_ACK", at: "2026-09-22T16:10:02.000Z" });
    // And the stored copy on disk says the same thing.
    const persisted = storage.load().commands.find((entry) => entry.record.commandId === CABLE_COMMAND_ID);
    expect(persisted?.record.authorizedScope).toMatchObject({
      certifiedRoadRefs: [{ ...STALE_ROAD }],
      generation: STALE_GENERATION,
      exactInput: exactCableInput(),
    });
  });

  test("E. the already-terminal facility placement is left alone", async () => {
    const { ports } = await activate();
    const record = ports.commandJournal.get("facility-placement");

    expect(record).toMatchObject({ status: "OBSERVED_MATCH", reconciliationStatus: "MATCH" });
    expect(record?.observationEvidence).toEqual([]);
  });

  test("F. reconciliation is append-only and never submits a save or a cable", async () => {
    const { ports, tools } = await activate();

    expect(ports.commandJournal.get(CABLE_COMMAND_ID)?.observationEvidence).toHaveLength(1);
    expect(tools.calls.map((call) => call.name)).not.toContain("cs2_save_game");
    expect(tools.calls.map((call) => call.name)).not.toContain("cs2_build_road");
    expect(tools.nativeMutations).toEqual([]);
  });

  test("G. reconciliation asks the Bridge exactly what the current-world observer asks", async () => {
    const reconciled = await activate();
    const observed = await observe();

    // The same binding, built the same way: one shared path, so the two can
    // never answer the same question differently.
    expect(reconciled.tools.bindingArgs).toHaveLength(1);
    expect(observed.tools.bindingArgs).toHaveLength(1);
    expect(reconciled.tools.bindingArgs[0]).toEqual(observed.tools.bindingArgs[0]);
    expect(reconciled.tools.requestedTargets).toEqual(observed.tools.requestedTargets);

    // ...including the read-only call sequence the binding path performs.
    const bindingPath = ["cs2_list_buildings", "cs2_utility_connectors", "cs2_game_state", "cs2_spatial", "cs2_utility_connectors"];
    const tail = (calls: Array<{ name: string }>) => calls.map((call) => call.name).slice(-bindingPath.length);
    expect(tail(reconciled.tools.calls)).toEqual(bindingPath);
    expect(tail(observed.tools.calls)).toEqual(bindingPath);

    // And both reach the same verdict about the same world.
    expect(observed.observation.currentWorldEffectPresent).toBe(true);
    expect(observed.observation.currentWorldObjectiveSatisfied).toBe(true);
    expect(reconciled.ports.commandJournal.get(CABLE_COMMAND_ID)).toMatchObject({ reconciliationStatus: "MATCH" });
  });
});

// ---------------------------------------------------------------------------
// A course is not an edge
// ---------------------------------------------------------------------------

describe("net course coverage", () => {
  const edge = (prefab: string, sx: number, sz: number, ex: number, ez: number) => ({
    prefab,
    start: { x: sx, z: sz },
    end: { x: ex, z: ez },
  });
  const args = {
    prefab: "Small Water Pipe",
    start: { x: -228.909, z: 1299.57007 },
    end: { x: 38.61565, z: 1389.81421 },
    tolerance: 1,
  };

  test("accepts a course the world realized as several edges", () => {
    // The live water pipe: one authorized primitive, realized as two edges
    // meeting at a midpoint the native side chose. Matching one edge's endpoints
    // against the action's would call this absent.
    expect(
      netCourseCovered({
        edges: [
          edge("Small Water Pipe", -228.909, 1299.57007, -95.14667, 1344.692),
          edge("Small Water Pipe", -95.14667, 1344.692, 38.61565, 1389.81421),
        ],
        ...args,
      }),
    ).toBe(true);
  });

  test("accepts the same course walked from either end, and nothing else", () => {
    const reversed = edge("Small Water Pipe", 38.61565, 1389.81421, -228.909, 1299.57007);
    expect(netCourseCovered({ edges: [reversed], ...args })).toBe(true);
    // A gap is not the course, however close its ends look.
    expect(netCourseCovered({ edges: [edge("Small Water Pipe", -228.909, 1299.57007, -95, 1344)], ...args })).toBe(false);
    // The right geometry under the wrong prefab is a different course.
    expect(netCourseCovered({ edges: [edge("Small Road", -228.909, 1299.57007, 38.61565, 1389.81421)], ...args })).toBe(false);
    expect(netCourseCovered({ edges: [], ...args })).toBe(false);
  });

  test("a bowed course is not covered by the chord it was cut from", () => {
    // The certified access-road repair is a bow of about 12 m: its chord runs
    // from the requested start to the requested end and touches both anchors
    // while covering none of the course between them.
    const curved = {
      prefab: "Small Road",
      start: { x: -226.909, z: 1316.5 },
      end: { x: -156.6602929, z: 1312.469691 },
      control: { x: -191.09731268615568, z: 1326.4651448408797 },
      tolerance: 1,
    };
    expect(netCourseCovered({
      edges: [edge("Small Road", curved.start.x, curved.start.z, curved.end.x, curved.end.z)],
      ...curved,
    })).toBe(false);

    // The course itself, realized as chords of its own samples, is coverage --
    // walked from either end, exactly as a straight course already was.
    const curveAt = (t: number) => {
      const inverse = 1 - t;
      return {
        x: inverse * inverse * curved.start.x + 2 * inverse * t * curved.control.x + t * t * curved.end.x,
        z: inverse * inverse * curved.start.z + 2 * inverse * t * curved.control.z + t * t * curved.end.z,
      };
    };
    const realized = [0, 1, 2, 3, 4].map((step) => {
      const from = curveAt(step / 5);
      const to = curveAt((step + 1) / 5);
      return edge("Small Road", from.x, from.z, to.x, to.z);
    });
    expect(netCourseCovered({ edges: realized, ...curved })).toBe(true);
    expect(netCourseCovered({ edges: [...realized].reverse(), ...curved })).toBe(true);

    // A course with no control vertex is still the straight walk it always
    // was, chord and all: the curve check is open only to a curved course.
    expect(netCourseCovered({
      edges: [edge("Small Road", curved.start.x, curved.start.z, curved.end.x, curved.end.z)],
      prefab: curved.prefab, start: curved.start, end: curved.end, tolerance: 1,
    })).toBe(true);
  });

  const road = (index: number, prefab: string, sx: number, sz: number, ex: number, ez: number) => ({
    entity: { index, version: 1 }, prefab,
    start: { x: sx, z: sz }, end: { x: ex, z: ez }, length: Math.hypot(ex - sx, ez - sz),
  });
  const readbackArgs = {
    prefab: "Small Water Pipe",
    start: { x: 0, z: 0 },
    end: { x: 20, z: 0 },
    totalMatches: 2,
    returned: 2,
  };

  test("an existing same-prefab path away from the exact submitted course cannot impersonate its effect", () => {
    const result = matchExactNetCourseReadback({
      ...readbackArgs,
      roads: [
        road(10, "Small Water Pipe", 0, 0, 10, 8),
        road(11, "Small Water Pipe", 10, 8, 20, 0),
      ],
    });
    expect(result.result).toBe("MISMATCH");
    expect(result.evidence.matchedEdges).toEqual([]);
  });

  test("exact split entities prove the one authorized course and retain auditable ids and geometry", () => {
    const result = matchExactNetCourseReadback({
      ...readbackArgs,
      roads: [
        road(21, "Small Water Pipe", 0, 0, 10, 0),
        road(22, "Small Water Pipe", 10, 0, 20, 0),
      ],
    });
    expect(result.result).toBe("MATCH");
    expect(result.evidence).toMatchObject({
      source: "cs2_list_roads",
      complete: true,
      tolerance: 1,
      matchedEdges: [
        { entity: { index: 21, version: 1 }, start: { x: 0, z: 0 }, end: { x: 10, z: 0 } },
        { entity: { index: 22, version: 1 }, start: { x: 10, z: 0 }, end: { x: 20, z: 0 } },
      ],
    });
  });

  test("the live Water Phase 7 Small Road realization is found as its two submitted-course split entities", () => {
    const result = matchExactNetCourseReadback({
      prefab: "Small Road",
      start: { x: -36.70547541672525, z: 1361.8176797805902 },
      end: { x: -193.8011447224174, z: 1297.1902726019675 },
      totalMatches: 2,
      returned: 2,
      roads: [
        road(186480, "Small Road", -36.7054749, 1361.81763, -69.9983, 1348.12158),
        road(186481, "Small Road", -69.9983, 1348.12158, -193.801147, 1297.19031),
      ],
    });
    expect(result.result).toBe("MATCH");
    expect(result.evidence.matchedEdges.map((edge) => edge.entity)).toEqual([
      { index: 186480, version: 1 },
      { index: 186481, version: 1 },
    ]);
  });

  test("wrong geometry and wrong prefab cannot match", () => {
    expect(matchExactNetCourseReadback({
      ...readbackArgs,
      roads: [road(30, "Small Water Pipe", 0, 0, 20, 6)],
      totalMatches: 1,
      returned: 1,
    }).result).toBe("MISMATCH");
    expect(matchExactNetCourseReadback({
      ...readbackArgs,
      roads: [road(31, "Small Road", 0, 0, 20, 0)],
      totalMatches: 1,
      returned: 1,
    }).result).toBe("MISMATCH");
  });

  test("a truncated or count-incomplete authoritative entity list is unproven", () => {
    expect(matchExactNetCourseReadback({
      ...readbackArgs,
      roads: [road(40, "Small Water Pipe", 0, 0, 20, 0)],
      totalMatches: 2,
      returned: 1,
    })).toMatchObject({ result: "UNPROVEN", evidence: { complete: false, matchedEdges: [] } });
    expect(matchExactNetCourseReadback({
      ...readbackArgs,
      roads: [road(41, "Small Water Pipe", 0, 0, 20, 0)],
      totalMatches: 1,
      returned: 1,
      truncated: true,
    }).result).toBe("UNPROVEN");
  });
});
