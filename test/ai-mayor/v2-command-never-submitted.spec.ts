import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type V2DurableStateStorage,
} from "@/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord } from "@/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts } from "@/main/services/ai-mayor/v2/main-adapter";

/**
 * A command that was authorized and then never reached its native submission is
 * proven absent, not unknown.
 *
 * Every kernel writes `submittedAt` in the same synchronous journal update that
 * moves the command to `SUBMITTED`, and calls its native boundary only after
 * that update has been persisted. A record still at `AUTHORIZED` with a null
 * `submittedAt` therefore cannot have produced a world effect -- and nothing can
 * run it later, because only `CREATED` is resumable and every later state is
 * reconcile-only.
 *
 * The live consequence of getting this wrong was total: a ZONING command whose
 * pre-submit read never returned was left at `AUTHORIZED` with an empty
 * `observationEvidence`, and the cell positions the zoning matcher reads are
 * recorded *after* `AUTHORIZED`. That record could never answer, so every
 * restart read it as `INCONCLUSIVE`, `ensureDurableWorld` refused with "restart
 * reconciliation remains inconclusive", and the Brain closed one Goal per tick
 * with no world write ever possible again.
 *
 * The two boundary tests below are the other half of the rule: a *submitted*
 * command is still reconciled from the world, and a `CREATED` command is not
 * proven absent, because a stored `CREATED` record can still be adopted and
 * submitted by the dedicated ROAD commit path.
 */

const WORLD = "326dd3b40b0344f485b78924b8bfa1b1";
const WORLD_ID = `cs2-session:${WORLD}`;
const GENERATION = "b85d64c1c96c48848f32bf93078209a4";
const FACILITY = { index: 176455, version: 1 };
const FACILITY_PLACEMENT = { prefab: "WindTurbineElectricity", x: -1128.4, z: -11.0 };
const FACILITY_COMMAND_ID = "facility-placement";
const ZONING_COMMAND_ID = "zoning-never-submitted";

/** The live blocker's own reservation and authorized cells, verbatim. */
const ZONING_ENVELOPE = { center: { x: -591.254761, z: -357.7403 }, radius: 8 };
const ZONING_CELLS = [
  { block: { index: 333320, version: 1 }, cellIndex: 19 },
  { block: { index: 333306, version: 1 }, cellIndex: 17 },
  { block: { index: 333306, version: 1 }, cellIndex: 10 },
];

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

function facilityCommand(): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: FACILITY_COMMAND_ID,
    actionFamily: "UTILITY",
    actionType: "place_building",
    authorizedScope: {
      owner: { ownerType: "TRANCHE", ownerId: "tranche-a" },
      actionFamily: "UTILITY",
      utilityKind: "electricity",
      projectId: "project-a",
      trancheId: "tranche-a",
      reservationRef: "reservation-a",
      worldEpochId: `${WORLD_ID}:generation:${GENERATION}`,
      generation: GENERATION,
      topologyRevision: `${GENERATION}:production`,
      certifiedRoadRefs: [],
      exactInput: JSON.stringify([{
        type: "place_building", prefab: FACILITY_PLACEMENT.prefab, x: FACILITY_PLACEMENT.x, z: FACILITY_PLACEMENT.z,
      }]),
      spatialEnvelope: { center: { x: -1128.4, z: -11.0 }, radius: 180 },
      budget: { authorizedMaxSpend: 25000, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
    },
    createdAt: "2026-10-01T03:00:00.000Z",
    submittedAt: "2026-10-01T03:00:01.000Z",
    nativeResultSummary: null,
    status: "OBSERVED_MATCH",
    statusHistory: [{ status: "OBSERVED_MATCH", at: "2026-10-01T03:00:02.000Z" }],
    reconciliationStatus: "MATCH",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

/**
 * The blocked command exactly as the live store holds it: `CREATED` then
 * `AUTHORIZED`, no native submission, and no `observationEvidence` -- the
 * pre-submit capture that records the cell positions never ran.
 */
function zoningCommand(overrides: Partial<V2CommandRecord> = {}): V2CommandRecord {
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: ZONING_COMMAND_ID,
    actionFamily: "ZONING",
    actionType: "zone",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: "task-zoning" },
      actionFamily: "ZONING",
      allowedCells: ZONING_CELLS.map((cell) => ({ block: { ...cell.block }, cellIndex: cell.cellIndex })),
      spatialEnvelope: { center: { ...ZONING_ENVELOPE.center }, radius: ZONING_ENVELOPE.radius },
      maximumAffectedArea: { maxCellCount: 8, maxRadiusMeters: 24 },
      budget: { maximumCost: null, currency: null, status: "PLACEHOLDER" },
      observationPrecondition: { observationId: "obs-pre", runtimeEpoch: "runtime:test", coherence: "STABLE_FRAME" },
      expiresAt: "2026-10-01T03:09:24.913Z",
      intendedEffect: { zoneCategory: "commercial" },
    },
    createdAt: "2026-10-01T03:08:55.149Z",
    submittedAt: null,
    nativeResultSummary: null,
    status: "AUTHORIZED",
    statusHistory: [
      { status: "CREATED", at: "2026-10-01T03:08:55.149Z" },
      { status: "AUTHORIZED", at: "2026-10-01T03:08:55.269Z" },
    ],
    reconciliationStatus: "NOT_STARTED",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
    ...overrides,
  };
}

/**
 * A durable store whose only unresolved command is the ZONING one. The facility
 * placement is already terminal, so reconciliation has exactly one question to
 * answer.
 */
function reconcileStorage(zoning: V2CommandRecord): V2DurableStateStorage {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage);
  coordinator.activate(gameState());
  coordinator.commandJournal.create(facilityCommand());
  coordinator.commandJournal.create(zoning);
  const seeded = coordinator.snapshot();
  for (const entry of seeded.commands) {
    if (entry.record.commandId === FACILITY_COMMAND_ID) entry.outcome = "OBSERVED_MATCH";
  }
  storage.save(seeded);
  return storage;
}

function bridgeTools() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const manager = {
    legacyList: async () => ({
      tools: ["cs2_game_state", "cs2_list_buildings", "cs2_spatial", "cs2_save_status", "cs2_saves", "cs2_mayor_snapshot"]
        .map((name) => ({ name: `cs2--${name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name, args });
      const payload =
        name === "cs2_game_state" ? gameState()
          : name === "cs2_list_buildings"
            ? { buildings: [{ entity: { ...FACILITY }, prefab: FACILITY_PLACEMENT.prefab, isSubBuilding: false, position: { x: FACILITY_PLACEMENT.x, z: FACILITY_PLACEMENT.z } }] }
            : name === "cs2_spatial" ? {
                center: { ...ZONING_ENVELOPE.center },
                terrain: { minHeight: 0, maxHeight: 0, slope: 0 },
                roadGraph: { nodes: [], edges: [] },
                buildings: [],
                zoningCells: [],
              }
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
    /** Any authoritative spatial read at all -- what reconciliation must not need. */
    get spatialReads() {
      return calls.filter((call) => call.name === "cs2_spatial");
    },
  };
}

/** Activate the durable world, which is what reconciles the pending command. */
async function activate(zoning: V2CommandRecord) {
  const storage = reconcileStorage(zoning);
  const tools = bridgeTools();
  const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
  let error: Error | null = null;
  try {
    await ports.activateDurableWorld!();
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  return { ports, tools, error };
}

describe("a command that never reached native submission is proven absent", () => {
  test("authorization without a submission reconciles as a proven absence, and the world is never read", async () => {
    const { ports, tools, error } = await activate(zoningCommand());

    // Write authority is restored: the restart no longer refuses.
    expect(error).toBeNull();
    expect(ports.commandJournal.get(ZONING_COMMAND_ID)).toMatchObject({
      status: "OBSERVED_MISMATCH",
      reconciliationStatus: "MISMATCH",
      effectAbsenceProven: true,
      submittedAt: null,
    });
    // The verdict names the reason instead of claiming an observation.
    expect(String(ports.commandJournal.get(ZONING_COMMAND_ID)?.failureOrUnknownReason))
      .toContain("never reached native submission");
    // The absence is proven from the record, so no spatial read was needed and
    // no reconciliation evidence was invented.
    expect(tools.spatialReads).toEqual([]);
    expect(ports.commandJournal.get(ZONING_COMMAND_ID)?.observationEvidence).toEqual([]);
  });

  test("a submitted command is still reconciled from the world, not from the shortcut", async () => {
    const { error, tools } = await activate(zoningCommand({
      submittedAt: "2026-10-01T03:09:00.000Z",
      status: "COMMIT_ACK",
      statusHistory: [
        { status: "CREATED", at: "2026-10-01T03:08:55.149Z" },
        { status: "AUTHORIZED", at: "2026-10-01T03:08:55.269Z" },
        { status: "SUBMITTED", at: "2026-10-01T03:09:00.000Z" },
        { status: "COMMIT_ACK", at: "2026-10-01T03:09:01.000Z" },
      ],
    }));

    // This record may well have written, so it must be read: the zoning matcher
    // asks the world, and an unanswerable record stays blocked rather than being
    // declared absent.
    expect(tools.spatialReads).not.toEqual([]);
    expect(error?.message).toContain("restart reconciliation remains inconclusive");
  });

  test("a created command is not proven absent, because it can still be submitted", async () => {
    const { error } = await activate(zoningCommand({
      status: "CREATED",
      statusHistory: [{ status: "CREATED", at: "2026-10-01T03:08:55.149Z" }],
    }));

    // The dedicated ROAD commit path adopts a stored CREATED record under the
    // same identity, so absence is not provable for it and the restart fails
    // closed exactly as before.
    expect(error?.message).toContain("restart reconciliation remains inconclusive");
  });
});
