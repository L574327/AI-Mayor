/**
 * Water Phase 6 -- the ADMISSION SEMANTIC REPAIR, then the water service, LIVE.
 *
 * The durable Water project is a project admitted before native facility
 * placeability joined site selection, so its own reservation is one the game
 * will not let a pumping station be built in. Its history is not rewritten. It
 * is repaired -- one append-only record keyed by `(root project, semantics
 * revision)`, which names at most one repair forever -- and the ONE project that
 * repairs it is admitted through the same production admission the app uses,
 * now with the full fixed semantics:
 *
 *   starter anchor escalation
 *     + utility-aware bounded envelope
 *     + water source constraint
 *     + native placeability probe
 *     + utility-aware bounded budget
 *
 * Then the water service itself, through the production K05 scoped-utility
 * boundary:
 *
 *   1. a READ-ONLY replay that proves the durable project invalid under the
 *      current semantics and produces a complete, game-verified plan;
 *   2. `repairAdmissionSemantics(...)` -- the repair identity, durable;
 *   3. `v2Gate1Progression.advanceToStage("ROAD_DELIVERED")` -- the repair's ROAD,
 *      by normal bounded road admission;
 *   4. `K05CommissionUtilitiesWorkflowAdapter.execute(..., ["water"])`;
 *   5. an authoritative readback after EVERY native step, before the next one.
 *
 * Bounds, checked rather than asserted:
 *   - at most one ROAD this repair authorized;
 *   - at most one GroundwaterPumpingStation01 and one Small Water Pipe edge
 *     inside the repair reservation, read from the current world;
 *   - `cs2_save_game`, zoning and building placement must never be called;
 *   - the live store is copied aside before the first write.
 *
 * It stops the moment the production boundary asks for reconciliation. A
 * command whose native outcome is unknown is never retried blindly.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GATE1_PROGRESSION_SIMULATION, createMainMayorPorts, parseMcpJson } from "../src/main/services/ai-mayor/main-adapters";
import { createV2FoundationPorts, parseV2SpatialSiteDetail, readNativeUtilityQuote } from "../src/main/services/ai-mayor/v2/main-adapter";
import { V2_GATE1_STATE_SCHEMA_VERSION, type Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import {
  createMemoryDurableStateStorage,
  type V2DurableState,
  type V2DurableStateStorage,
  type V2UtilityBudgetAmendmentRecord,
} from "../src/main/services/ai-mayor/v2/durability";
import type { Gate1BoundedSiteCandidate } from "../src/main/services/ai-mayor/v2/site-selection";
import { buildUtilityConnectionCandidates, type UtilityConnectorReadback } from "../src/main/services/ai-mayor/utility-recovery";
import {
  UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON,
  admitUtilityConnectionBudgetAmendment,
} from "../src/main/services/ai-mayor/v2/utility-budget";
import { utilityFacilityRecipe } from "../src/main/services/ai-mayor/v2/utility-execution-planner";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { firstFacilityPlacementDurability } from "../src/main/services/ai-mayor/v2/utility-placement-durability";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { K05CommissionUtilitiesWorkflowAdapter } from "../src/main/services/ai-mayor/skills/adapters/k05-commission-utilities-workflow";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import {
  createWaterSiteConstraint,
  type WaterFacilityPlacement,
  type WaterSiteConstraintEvidence,
} from "../src/main/services/ai-mayor/v2/water-site-constraint";
import { V2_PROJECT_ADMISSION_POLICY, type V2ProjectSiteConstraint } from "../src/main/services/ai-mayor/v2/project-admission";
import { ADMISSION_SEMANTICS_REVISION } from "../src/main/services/ai-mayor/v2/admission-semantic-repair";

type SpatialBootstrapScan = ReturnType<typeof parseSpatialBootstrapScan>;

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_PHASE6_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase6-live.json";
/** The electron-store key the live durable state lives under. Kept as a literal so this script never imports electron-store. */
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const backupPath = process.env.WATER_PHASE6_STORE_BACKUP ?? `${liveStorePath}.water-phase6-backup`;

/** Resolution of the reservation read; the radius comes from admission's search. */
const RESERVATION_RESOLUTION = 128;
const WATER_FACILITY_PREFAB = "GroundwaterPumpingStation01";
const WATER_PIPE_PREFAB = "Small Water Pipe";
const REPAIR_DETAIL =
  "The durable project was admitted before native facility placeability joined site selection, so its own " +
  "reservation is one the game refuses to host a pumping station in. Its identity, reservation, ROAD and " +
  "journal stay exactly as delivered; the one project a `(root, semantics revision)` pair buys is admitted to " +
  "replace it under the corrected admission semantics.";

const MAXIMUM_REPAIR_PROJECTS = 1;
const MAXIMUM_ROAD_PLACEMENTS = 1;
const MAXIMUM_FACILITY_PLACEMENTS = 1;
const MAXIMUM_PIPE_ATTEMPTS = 1;
/** One native step per iteration; the loop stops far earlier whenever anything is unresolved. */
const MAXIMUM_ITERATIONS = 6;

/** Tools that would take the world past this phase's mandate. */
const FORBIDDEN_TOOLS = new Set(["cs2_save_game", "cs2_zone", "cs2_place_building", "cs2_bulldoze"]);

/**
 * Reasons that mean a native command is in flight and its effect is not yet
 * observable. The run advances the clock and re-enters, which is not a retry:
 * the next pass reconciles the command against the world first, and an already
 * attempted course cannot be submitted again.
 */
const OBSERVATION_REASONS = new Set(["UTILITY_RECONCILIATION_REQUIRED", "UTILITY_OBSERVATION_UNKNOWN"]);

/** Reasons that end the run no matter how much time passes. */
const TERMINAL_REASONS = new Set([
  "UTILITY_CONSTRUCTION_ATTEMPTS_EXHAUSTED",
  "UTILITY_CONNECTION_CANDIDATES_EXHAUSTED",
]);

/** How far the clock is advanced between passes; enough for the city to notice. */
const SIMULATION_HOURS = 0.5;
const SIMULATION_SPEED = 4;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const sha256 = (file: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

/**
 * The live canonical store, written exactly as `createCanonicalDurableStateStorage`
 * writes it -- electron-store's default tab indentation, every sibling key kept.
 */
function createLiveDurableStateStorage(envelope: Record<string, unknown>): V2DurableStateStorage {
  return {
    load: () => envelope[LIVE_STATE_KEY],
    save: (state: V2DurableState) => {
      envelope[LIVE_STATE_KEY] = state;
      fs.writeFileSync(liveStorePath, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
    },
    namespaceId: liveStorePath,
  };
}

async function main() {
  const storeHashBefore = sha256(liveStorePath);
  const storeEnvelope = JSON.parse(fs.readFileSync(liveStorePath, "utf8")) as Record<string, unknown>;
  const liveState = storeEnvelope[LIVE_STATE_KEY];
  if (typeof liveState !== "object" || liveState === null) throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  const backupWritten = !fs.existsSync(backupPath);
  if (backupWritten) await fsPromises.copyFile(liveStorePath, backupPath);

  const client = new Client({ name: "5ire-ai-mayor-water-phase6-live", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    calls.push({ name, args });
    return client.callTool({ name, arguments: args }, undefined, { signal });
  };

  const capturedScan: { scan: SpatialBootstrapScan | null } = { scan: null };
  const manager = {
    legacyList: async () => ({
      tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseMcpJson(await callTool(name, args));
      if (name === "cs2_spatial" && record(args).mode === "scan") capturedScan.scan = parseSpatialBootstrapScan(value);
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };

  const evaluations: WaterSiteConstraintEvidence[] = [];
  const ladder: Array<{ candidateId: string; radius: number; accepted: boolean; reason: string | null }> = [];
  /** Every placement probe the production constraint issued, attributed to what it was deciding. */
  const probeAttempts: Array<WaterFacilityPlacement & { candidateId: string; radius: number; accepted: boolean }> = [];
  /** The (candidate, radius) the shared probe is currently answering for. */
  const inFlight = { candidateId: "", radius: 0 };

  /**
   * The game's own verdict on one proposed pumping-station placement.
   *
   * `cs2_spatial mode=preflight` is preview-only. A blocked placement comes back
   * as HTTP 409 (`BridgeToolSystem.BuildRejectedResponse`), which is the game
   * saying no; any other throw is a probe that was never taken, and an
   * unobserved placement is refused rather than assumed placeable.
   */
  const probePlacement = async (placement: WaterFacilityPlacement, probeSignal?: AbortSignal): Promise<boolean> => {
    const attempt = { ...placement, candidateId: inFlight.candidateId, radius: inFlight.radius, accepted: false };
    probeAttempts.push(attempt);
    try {
      const result = record(
        parseMcpJson(
          await callTool(
            "cs2_spatial",
            {
              mode: "preflight",
              kind: "object",
              prefab: placement.prefab,
              x: placement.position.x,
              z: placement.position.z,
              rotation: placement.rotation,
            },
            probeSignal,
          ),
        ),
      );
      attempt.accepted = result.valid === true && result.previewOnly === true;
      return attempt.accepted;
    } catch (error) {
      if (record(error).status === 409) return false;
      throw error;
    }
  };

  /** The native spending contract's own quote for a pipe. Preview-only. */
  const quoteConnectionCost = async (
    connection: { prefab: string; start: SpatialPoint2; end: SpatialPoint2 },
    quoteSignal?: AbortSignal,
  ): Promise<number> => {
    const result = record(
      parseMcpJson(
        await callTool(
          "cs2_spatial",
          {
            mode: "preflight",
            kind: "net",
            prefab: connection.prefab,
            x1: connection.start.x,
            z1: connection.start.z,
            x2: connection.end.x,
            z2: connection.end.z,
          },
          quoteSignal,
        ),
      ),
    );
    if (result.valid !== true || result.previewOnly !== true) {
      throw new Error(`WATER_PIPE_QUOTE_REJECTED:${typeof result.reason === "string" ? result.reason : "unknown"}`);
    }
    const quoted = readNativeUtilityQuote(result, Number.NaN);
    if (!Number.isFinite(quoted)) throw new Error("WATER_PIPE_QUOTE_UNKNOWN");
    return quoted;
  };

  const readReservation = async (
    point: SpatialPoint2,
    radius: number,
    readSignal?: AbortSignal,
  ): Promise<SpatialSiteDetail | null> =>
    parseV2SpatialSiteDetail(
      parseMcpJson(
        await callTool(
          "cs2_spatial",
          { mode: "detail", x: point.x, z: point.z, radius, resolution: RESERVATION_RESOLUTION },
          readSignal,
        ),
      ),
    );

  /**
   * A fresh production water constraint, bound to the current authoritative scan.
   *
   * Every caller gets its own instance: the constraint caches the plan an
   * acceptance was decided on, and sharing one across two different projects
   * would price a budget question against the wrong plan.
   */
  const buildConstraint = (): V2ProjectSiteConstraint => {
    if (!capturedScan.scan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");
    const scan = capturedScan.scan;
    const localEvaluations: WaterSiteConstraintEvidence[] = [];
    const inner = createWaterSiteConstraint({
      world: buildSpatialWorldModel(scan),
      assets: scan.bootstrapAssets,
      // An admission-time project has no certified road, so the production
      // `scopeRoadAuthority` hands the planner the whole current-world set.
      roads: scan.roadGraph.edges,
      readReservation,
      quoteConnectionCost,
      probePlacement,
      onEvaluated: (entry) => {
        evaluations.push(entry);
        localEvaluations.push(entry);
      },
    });
    return {
      kind: inner.kind,
      async accepts(candidate, reservationRadius, signal) {
        inFlight.candidateId = candidate.id;
        inFlight.radius = reservationRadius;
        const accepted = await inner.accepts(candidate, reservationRadius, signal);
        const reason = localEvaluations.filter((entry) => entry.candidateId === candidate.id).at(-1)?.reason ?? null;
        ladder.push({ candidateId: candidate.id, radius: reservationRadius, accepted, reason: accepted ? null : reason });
        return accepted;
      },
      async minimumFeasibleBudget(candidate, reservationRadius, signal) {
        if (!inner.minimumFeasibleBudget) throw new Error("WATER_CONSTRAINT_NOT_MINIMUM_BUDGET_CAPABLE");
        return inner.minimumFeasibleBudget(candidate, reservationRadius, signal);
      },
    };
  };

  const liveStorage = createLiveDurableStateStorage(storeEnvelope);
  const worldCounts = async () => {
    const roads = record(parseMcpJson(await callTool("cs2_list_roads", { limit: 500 })));
    const buildings = record(parseMcpJson(await callTool("cs2_list_buildings", { limit: 500 })));
    return {
      roads: Number(roads.totalMatches ?? roads.returned ?? 0),
      buildings: Number(buildings.totalMatches ?? buildings.returned ?? 0),
    };
  };

  const report: Record<string, unknown> = {
    serverPath,
    liveStorePath,
    backupPath,
    backupWritten,
    startedAt: new Date().toISOString(),
    mode: "LIVE_SEMANTIC_REPAIR_THEN_ONE_WATER_SERVICE",
    semanticsRevision: ADMISSION_SEMANTICS_REVISION,
    liveStoreSha256Before: storeHashBefore,
  };
  const verdict: Record<string, unknown> = {};
  report.verdict = verdict;
  let failed = false;

  let reservation: { center: SpatialPoint2; radius: number } | null = null;

  /** The authoritative current-world read of the water slice. */
  const readWorldWater = async () => {
    if (!reservation) throw new Error("WATER_PHASE6_RESERVATION_UNKNOWN");
    const detail = parseV2SpatialSiteDetail(
      parseMcpJson(
        await callTool("cs2_spatial", {
          mode: "detail",
          x: reservation.center.x,
          z: reservation.center.z,
          radius: Math.max(64, reservation.radius),
          resolution: RESERVATION_RESOLUTION,
        }),
      ),
    );
    const inEnvelope = (point: { x: number; z: number }) =>
      Math.hypot(point.x - reservation!.center.x, point.z - reservation!.center.z) <= reservation!.radius;
    const facilities = detail.buildings.filter((building) => building.prefab === WATER_FACILITY_PREFAB);
    // Pipes are read from the published net listing, not from the spatial detail
    // read: that read returns the ROAD graph, and a water pipe is not in it. A
    // readback that cannot see pipes at all would report "no physical effect"
    // for a pipe that is standing in the world.
    const roadList = record(parseMcpJson(await callTool("cs2_list_roads", { limit: 500 })));
    const pipes = (Array.isArray(roadList.roads) ? roadList.roads.map(record) : []).filter(
      (edge) => String(edge.prefab ?? "") === WATER_PIPE_PREFAB,
    );
    const snapshot = record(parseMcpJson(await callTool("cs2_mayor_snapshot", {})));
    const water = record(record(snapshot.utilities).water);
    return {
      facilityCount: facilities.length,
      facilityInEnvelopeCount: facilities.filter((building) => inEnvelope(building.position)).length,
      facilities: facilities.map((building) => ({ entity: building.entity, position: building.position })),
      pipeCount: pipes.length,
      pipeInEnvelopeCount: pipes.filter(
        (edge) => inEnvelope(record(edge.start) as { x: number; z: number }) || inEnvelope(record(edge.end) as { x: number; z: number }),
      ).length,
      pipes: pipes.map((edge) => ({ entity: edge.entity, start: edge.start, end: edge.end })),
      water,
      waterCapacity: typeof water.capacity === "number" ? water.capacity : null,
    };
  };

  /**
   * Walk the water-pipe edges from the facility's own connector to the road
   * contact the tranche certified.
   *
   * This is what turns "pipes exist in the envelope" into a topology claim. The
   * walk starts at the connector the Bridge reports as the facility's, so a pipe
   * belonging to some other building can never be walked into the chain, and it
   * has to arrive at the admitted contact rather than merely end nearby.
   */
  const pipeChainFrom = (
    pipes: Array<Record<string, unknown>>,
    connector: Record<string, unknown> | null,
    target: SpatialPoint2 | null,
  ): { reachesTarget: boolean; reason: string; edgeIds: string[]; endPosition: SpatialPoint2 | null; gapMeters: number | null } => {
    const start = connector ? { x: Number(connector.x), z: Number(connector.z) } : null;
    if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.z)) {
      return { reachesTarget: false, reason: "CONNECTOR_POSITION_UNKNOWN", edgeIds: [], endPosition: null, gapMeters: null };
    }
    if (!target) {
      return { reachesTarget: false, reason: "TARGET_CONTACT_UNKNOWN", edgeIds: [], endPosition: null, gapMeters: null };
    }
    const TOLERANCE = 0.75;
    const near = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z) <= TOLERANCE;
    const remaining = pipes.map((edge) => ({
      id: `${record(edge.entity).index}:${record(edge.entity).version}`,
      start: { x: Number(record(edge.start).x), z: Number(record(edge.start).z) },
      end: { x: Number(record(edge.end).x), z: Number(record(edge.end).z) },
    }));
    const edgeIds: string[] = [];
    let cursor = start;
    for (;;) {
      const next = remaining.find((edge) => near(edge.start, cursor) || near(edge.end, cursor));
      if (!next) break;
      remaining.splice(remaining.indexOf(next), 1);
      edgeIds.push(next.id);
      cursor = near(next.start, cursor) ? next.end : next.start;
      if (near(cursor, target)) {
        return { reachesTarget: true, reason: "CHAIN_REACHES_CERTIFIED_CONTACT", edgeIds, endPosition: cursor, gapMeters: 0 };
      }
    }
    const gapMeters = Math.hypot(cursor.x - target.x, cursor.z - target.z);
    return {
      reachesTarget: false,
      reason: `CHAIN_ENDS_${gapMeters.toFixed(1)}M_FROM_CONTACT`,
      edgeIds,
      endPosition: cursor,
      gapMeters,
    };
  };

  try {
    // --- 0. Authoritative world preflight (read only) ------------------------
    const gameStateRaw = parseMcpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
    const game = record(gameStateRaw);
    const world = record(game.world);
    const simulation = record(game.simulation);
    report.livePreflight = {
      gameMode: game.gameMode ?? null,
      cityLoaded: game.cityLoaded ?? null,
      isLoading: game.isLoading ?? null,
      worldReady: world.worldReady ?? null,
      paused: simulation.paused ?? null,
      nativeOperationBusy: world.nativeOperationBusy ?? null,
      worldId: world.worldId ?? null,
      generation: world.generation ?? null,
      checkpointId: world.checkpointId ?? null,
    };
    if (
      game.gameMode !== "Game" ||
      game.cityLoaded !== true ||
      game.isLoading !== false ||
      world.worldReady !== true ||
      simulation.paused !== true
    ) {
      throw new Error("LIVE_PREFLIGHT_NOT_READY");
    }
    verdict.LIVE_WORLD_MATCHES_STORE = world.worldId === record(record(liveState).active).worldId ? "YES" : "NO";

    report.worldBefore = await worldCounts();

    // --- A. The read-only replay that decides whether a repair is warranted ---
    const liveFoundation = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
    });
    const liveDurability = liveFoundation.durability;
    if (!liveDurability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    const liveActivation = liveDurability.activate(gameStateRaw);
    verdict.DURABLE_WORLD_ACTIVATED = liveDurability.isExecutionDurablyActivated(liveActivation) ? "YES" : "NO";
    if (!liveDurability.isExecutionDurablyActivated(liveActivation)) {
      throw new Error(liveActivation.blockedReason ?? "DURABLE_WORLD_NOT_ACTIVATED");
    }
    const durableProject = liveDurability.projectState();
    if (durableProject.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
      throw new Error("WATER_PHASE6_NO_DURABLE_PROJECT");
    }
    const oldReservation = durableProject.project.utilityReservation;
    report.durableProjectBefore = {
      intentId: durableProject.intent.id,
      projectId: durableProject.project.id,
      trancheId: durableProject.tranche.id,
      stage: durableProject.tranche.stage,
      utilityReservation: oldReservation,
      maximumBudget: durableProject.project.maximumBudget,
    };
    report.supersededBefore = liveDurability.supersededProjects().map((entry) => ({
      supersessionId: entry.supersessionId,
      projectId: entry.projectId,
      replacementProjectId: entry.replacementProjectId,
      reason: entry.reason,
    }));
    const repairsBefore = liveDurability.admissionSemanticRepairs();
    // A resume: this lineage's repair is already durable and the slot already
    // holds the project it named. Replaying would re-ask a settled question, and
    // re-admitting is exactly what the repair's identity bound forbids.
    const alreadyRepaired =
      repairsBefore.length > 0 && repairsBefore[0].repairProjectId === durableProject.project.id;
    report.repairsBefore = repairsBefore.length;
    report.alreadyRepaired = alreadyRepaired;

    // The scan every constraint below plans against. Read once.
    await manager.legacyCall({ name: "cs2_spatial", arguments: { mode: "scan", roadLimit: 2_000 } });
    if (!capturedScan.scan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");

    let requiredUtilityBudget: number | null = alreadyRepaired ? repairsBefore[0].replacedState.project.maximumBudget : null;
    let acceptedProbe: (WaterFacilityPlacement & { accepted: boolean }) | null = null;
    let oldReason = "resume: the durable repair already records this admission as invalid";

    if (!alreadyRepaired) {
    // A1. Is the DURABLE project still valid under the current semantics? The
    // production constraint is asked about that project's own reservation, at
    // that reservation's own radius -- the question admission would ask if this
    // project were being admitted today.
    const oldEvaluationsBefore = evaluations.length;
    const oldConstraint = buildConstraint();
    const oldCandidate: Gate1BoundedSiteCandidate = {
      id: `phase6:old:${durableProject.project.id}`,
      target: { center: oldReservation.center, radius: oldReservation.radius },
      score: 0,
      blocked: false,
      direction: { x: 0, z: 1 },
      roadCandidates: [],
      evidence: {
        sourceAnchor: oldReservation.center,
        openResidentialCells: 0,
        owned: true,
        buildable: true,
        access: "BOUNDED_ROAD_FEASIBLE",
      },
    };
    const oldAccepted = await oldConstraint.accepts(oldCandidate, oldReservation.radius);
    oldReason =
      evaluations.slice(oldEvaluationsBefore).filter((entry) => entry.candidateId === oldCandidate.id).at(-1)?.reason ??
      "unknown";
    report.oldProjectReplay = {
      reservation: oldReservation,
      validUnderCurrentSemantics: oldAccepted,
      refusalReason: oldAccepted ? null : oldReason,
      probes: probeAttempts.slice(-8),
    };
    verdict.OLD_PROJECT_VALID_UNDER_CURRENT_SEMANTICS = oldAccepted ? "YES" : "NO";
    if (oldAccepted) throw new Error("WATER_PHASE6_OLD_PROJECT_STILL_VALID");

    // A2. What the CURRENT admission would admit instead. Run over a throwaway
    // in-memory store: it mints no durable identity and supersedes nothing.
    const replayFoundation = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: createMemoryDurableStateStorage(),
      projectSiteConstraint: buildConstraint(),
    });
    if (!replayFoundation.projectAdmission || !replayFoundation.durability) {
      throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
    }
    replayFoundation.durability.activate(gameStateRaw);
    const replay = await replayFoundation.projectAdmission.admitFirstProject();
    if (replay.status !== "ADMITTED") throw new Error(`WATER_PHASE6_REPLAY_NOT_ADMITTED:${replay.status}`);
    const replayReservation = replay.state.project.utilityReservation;
    requiredUtilityBudget = replay.evidence.requiredUtilityBudget;
    if (requiredUtilityBudget === null || !Number.isFinite(requiredUtilityBudget)) {
      throw new Error("WATER_PHASE6_REPLAY_BUDGET_UNKNOWN");
    }
    const replayProbes = probeAttempts.filter(
      (probe) => probe.candidateId === replay.evidence.selectedCandidateId && probe.radius === replayReservation.radius,
    );
    acceptedProbe = replayProbes.find((probe) => probe.accepted) ?? null;
    if (!acceptedProbe) throw new Error("WATER_PHASE6_REPLAY_NATIVE_PLACEMENT_UNPROVEN");
    report.newProjectReplay = {
      selectedCandidateId: replay.evidence.selectedCandidateId,
      anchorClass: replay.evidence.anchorClass,
      anchorFallbackReason: replay.evidence.anchorFallbackReason,
      reservationRadiusMeters: replay.evidence.reservationRadiusMeters,
      reservationRadiusLadder: replay.evidence.reservationRadiusLadder,
      utilityReservation: replayReservation,
      maximumBudget: replay.evidence.maximumBudget,
      budgetBound: replay.evidence.budgetBound,
      requiredUtilityBudget,
      utilityBudgetRequirement: replay.evidence.utilityBudgetRequirement,
      acceptedProbe,
      probesAtSelected: replayProbes,
    };
    verdict.REPLAY_SELECTED_RADIUS = replayReservation.radius;
    verdict.REPLAY_SELECTED_SITE = `${replayReservation.center.x},${replayReservation.center.z}`;
    verdict.REPLAY_NATIVE_PLACEMENT_ACCEPTED = acceptedProbe ? "YES" : "NO";
    verdict.REPLAY_REQUIRED_UTILITY_BUDGET = requiredUtilityBudget;

    // The groundwater the accepted reservation actually contains, read back from
    // the world rather than inferred from the planner's agreement.
    const newDetail = await readReservation(replayReservation.center, replayReservation.radius);
    if (!newDetail) throw new Error("WATER_PHASE6_REPLAY_RESERVATION_NOT_OBSERVED");
    let cleanSamples = 0;
    for (let row = 0; row < newDetail.terrain.resolution; row += 1) {
      for (let col = 0; col < newDetail.terrain.resolution; col += 1) {
        const index = row * newDetail.terrain.resolution + col;
        const x = newDetail.terrain.bounds.minX + (col + 0.5) * newDetail.terrain.cellSize.x;
        const z = newDetail.terrain.bounds.minZ + (row + 0.5) * newDetail.terrain.cellSize.z;
        if (Math.hypot(x - replayReservation.center.x, z - replayReservation.center.z) > replayReservation.radius) continue;
        if (
          Number(newDetail.terrain.groundWater[index] ?? 0) > 0 &&
          Number(newDetail.terrain.groundWaterPollution[index] ?? 0) === 0
        ) {
          cleanSamples += 1;
        }
      }
    }
    report.newReservationGroundWater = { cleanSamples };
    verdict.REPLAY_GROUNDWATER_VALID = cleanSamples > 0 ? "YES" : "NO";
    if (cleanSamples === 0) throw new Error("WATER_PHASE6_REPLAY_GROUNDWATER_UNPROVEN");
    }

    // --- B. The repair, durable ----------------------------------------------
    const placementScope = {
      projectId: durableProject.project.id,
      trancheId: durableProject.tranche.id,
      reservationRef: durableProject.tranche.reservationRef,
      utilityKind: "water" as const,
    };
    const placementOperations = liveDurability.utilityPlacementOperations(placementScope);
    const networkOperations = liveDurability.utilityNetworkOperations(placementScope);
    const mutation = {
      firstFacilityPlacement:
        placementOperations === null || networkOperations === null
          ? ({ status: "UNPROVEN", reason: "durable utility lineage unavailable" } as const)
          : firstFacilityPlacementDurability(placementOperations),
      submittedCommandIds: [...(placementOperations ?? []), ...(networkOperations ?? [])]
        .filter((operation) => !operation.failedBeforeSubmit)
        .map((operation) => operation.commandId),
    };
    report.utilityMutation = mutation;
    verdict.UTILITY_MUTATION_BEFORE_REPAIR = mutation.firstFacilityPlacement.status;

    const repairing = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
      projectSiteConstraint: buildConstraint(),
    });
    if (!repairing.projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
    const repairResult = await repairing.projectAdmission.repairAdmissionSemantics({
      semanticsRevision: ADMISSION_SEMANTICS_REVISION,
      evidence: {
        semanticsRevision: ADMISSION_SEMANTICS_REVISION,
        projectId: durableProject.project.id,
        oldProjectValidUnderCurrentSemantics: false,
        oldProjectRefusalReason: oldReason,
        nativePlacementAccepted: true,
        // On a resume the seam answers ALREADY_REPAIRED before it reads any of
        // this, so these are only ever consulted on the run that actually
        // decides the repair.
        facilityPrefab: acceptedProbe?.prefab ?? "unused",
        facilityPosition: acceptedProbe?.position ?? { x: 0, z: 0 },
        facilityRotation: acceptedProbe?.rotation ?? 0,
        groundwaterValid: true,
        roadCandidateValid: true,
        requiredUtilityBudget: requiredUtilityBudget ?? 0,
      },
      mutation,
      detail: REPAIR_DETAIL,
    });
    report.repair = {
      status: repairResult.status,
      repairId: repairResult.repair.repairId,
      rootProjectId: repairResult.repair.rootProjectId,
      replacedProjectId: repairResult.repair.replacedProjectId,
      semanticsRevision: repairResult.repair.semanticsRevision,
      reason: repairResult.repair.reason,
      repairProjectId: repairResult.repair.repairProjectId,
      replacedReservation: repairResult.repair.replacedState.project.utilityReservation,
      repairedAt: repairResult.repair.repairedAt,
    };
    verdict.ADMISSION_SEMANTIC_REPAIR_RECORDED = "YES";
    verdict.WATER_REPAIR_PROJECT_CREATED = repairResult.repair.repairProjectId ? "YES" : "NO";
    const repairEvidence = "evidence" in repairResult ? repairResult.evidence : null;
    report.repairAdmissionEvidence = repairEvidence
      ? {
          selectedCandidateId: repairEvidence.selectedCandidateId,
          anchorClass: repairEvidence.anchorClass,
          reservationRadiusMeters: repairEvidence.reservationRadiusMeters,
          utilityReservation: repairResult.state.project.utilityReservation,
          maximumBudget: repairResult.state.project.maximumBudget,
          budgetBound: repairEvidence.budgetBound,
          requiredUtilityBudget: repairEvidence.requiredUtilityBudget,
        }
      : null;
    report.replacedImmutability = {
      replacedStateMatchesObserved:
        repairResult.repair.replacedState.project.id === durableProject.project.id &&
        repairResult.repair.replacedState.tranche.stage === durableProject.tranche.stage,
      replacedReservation: repairResult.repair.replacedState.project.utilityReservation,
      observedReservation: oldReservation,
      supersessionsAfter: liveDurability.supersededProjects().length,
      repairsAfter: liveDurability.admissionSemanticRepairs().length,
    };
    verdict.GENERIC_SUPERSESSION_RULE_UNCHANGED = liveDurability.supersededProjects().length === 1 ? "YES" : "NO";
    verdict.REPAIR_IDENTITY_DETERMINISTIC =
      repairResult.repair.repairId ===
      `${repairResult.repair.rootProjectId}:admission-semantic-repair:${ADMISSION_SEMANTICS_REVISION}`
        ? "YES"
        : "NO";
    verdict.ADMISSION_SEMANTIC_REPAIR_IMPLEMENTED = "YES";
    if (liveDurability.admissionSemanticRepairs().length > MAXIMUM_REPAIR_PROJECTS) {
      throw new Error(`WATER_PHASE6_REPAIR_BOUND_EXCEEDED:${liveDurability.admissionSemanticRepairs().length}`);
    }

    // --- C. The repair's ROAD, through the production lifecycle owner ---------
    const progressionPorts = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
      projectSiteConstraint: buildConstraint(),
      emit: () => {},
    });
    if (!progressionPorts.v2Gate1Progression) throw new Error("V2_PRODUCTION_GATE1_PROGRESSION_NOT_CONFIGURED");
    const progression = await progressionPorts.v2Gate1Progression.advanceToStage("ROAD_DELIVERED");
    report.progression = {
      status: progression.status,
      stage: progression.stage,
      milestone: progression.milestone,
      decisions: progression.decisions,
      roadCommandCount: progression.roadCommandCount,
      reason: progression.reason,
      wake: progression.wake ?? null,
    };
    const afterRoad = await worldCounts();
    const beforeRoad = report.worldBefore as { roads: number; buildings: number };
    const roadDelta = {
      roads: afterRoad.roads - beforeRoad.roads,
      buildings: afterRoad.buildings - beforeRoad.buildings,
    };
    const roadBuildCalls = calls.filter((call) => call.name === "cs2_build_road").length;
    const repairRoadOwner = `${progression.state?.tranche.id ?? ""}:task:road_connection`;
    const durableEntries = () => {
      const durable = record(storeEnvelope[LIVE_STATE_KEY]);
      return Array.isArray(durable.commands) ? durable.commands.map(record) : [];
    };
    const repairRoadCommands = durableEntries().filter((entry) => {
      const command = record(entry.record);
      return (
        command.actionFamily === "ROAD" &&
        command.submittedAt !== null &&
        record(record(command.authorizedScope).owner).ownerId === repairRoadOwner
      );
    });
    report.roadPhase = { afterRoad, roadDelta, roadBuildCalls };
    verdict.ROAD_PLACEMENT_COUNT = repairRoadCommands.length;
    verdict.GATE1_STAGE_AFTER_PROGRESSION = progression.stage;
    if (repairRoadCommands.length > MAXIMUM_ROAD_PLACEMENTS) {
      throw new Error(`WATER_PHASE6_ROAD_LEDGER_BOUND_EXCEEDED:${repairRoadCommands.length}`);
    }
    if (roadBuildCalls > MAXIMUM_ROAD_PLACEMENTS) throw new Error(`WATER_PHASE6_ROAD_CALL_BOUND_EXCEEDED:${roadBuildCalls}`);
    if (roadDelta.buildings !== 0) throw new Error(`WATER_PHASE6_UNEXPECTED_BUILDING:${roadDelta.buildings}`);

    // --- D. The water admission, on the repair's delivered ROAD --------------
    const state: Gate1State | null = progression.state;
    if (!state || state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
      throw new Error("WATER_PHASE6_GATE1_STATE_UNAVAILABLE");
    }
    if (state.tranche.stage !== "ROAD_DELIVERED") throw new Error(`WATER_PHASE6_STAGE_${state.tranche.stage}`);
    reservation = state.project.utilityReservation;
    verdict.SELECTED_RESERVATION_RADIUS = reservation.radius;
    report.repairState = {
      intentId: state.intent.id,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      utilityReservation: reservation,
      target: state.tranche.target,
      maximumBudget: state.project.maximumBudget,
    };

    const utilityFoundation = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
    });
    const utilityDurability = utilityFoundation.durability;
    if (!utilityDurability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    // Bind the coordinator to the world as it is NOW, so `certifyDeliveredRoad`
    // proves the lineage this run produced rather than the one it started with.
    const utilityActivation = utilityDurability.activate(parseMcpJson(await callTool("cs2_game_state", {})));
    if (!utilityDurability.isExecutionDurablyActivated(utilityActivation)) {
      throw new Error(utilityActivation.blockedReason ?? "WATER_PHASE6_UTILITY_WORLD_NOT_ACTIVATED");
    }
    const deliveredRoad = certifyDeliveredRoad({
      state,
      world: utilityActivation.world,
      journal: utilityDurability.commandJournal,
    });
    report.certifiedRoad = {
      status: deliveredRoad.status,
      target: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.target : null,
      refs: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.refs : null,
      reason: deliveredRoad.status === "CERTIFIED" ? null : deliveredRoad.reason,
    };
    if (deliveredRoad.status !== "CERTIFIED") throw new Error(`WATER_PHASE6_ROAD_NOT_CERTIFIED:${deliveredRoad.reason}`);

    const overview = record(parseMcpJson(await callTool("cs2_city_overview", {})));
    const treasury = Number(overview.treasury);
    if (!Number.isFinite(treasury)) throw new Error("WATER_PHASE6_TREASURY_UNKNOWN");
    report.treasury = treasury;

    const repairScope = {
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      utilityKind: "water" as const,
    };
    const worldBeforeWater = await worldCounts();
    const waterBefore = await readWorldWater();
    report.worldBeforeWater = worldBeforeWater;
    report.waterBefore = waterBefore;
    verdict.WATER_CAPACITY_BEFORE = waterBefore.waterCapacity;
    verdict.WATER_FACILITY_PLACEMENT_COUNT_BEFORE = waterBefore.facilityInEnvelopeCount;
    // A resume legitimately finds the facility an earlier run of this same
    // bounded step placed. What is never legitimate is a SECOND one, or a second
    // pipe: those are the duplicates the bounds exist to prevent.
    if (waterBefore.facilityInEnvelopeCount > MAXIMUM_FACILITY_PLACEMENTS) {
      throw new Error(`WATER_PHASE6_DUPLICATE_FACILITY_PRESENT:${waterBefore.facilityInEnvelopeCount}`);
    }
    verdict.RESUMED_WITH_FACILITY_PLACED = waterBefore.facilityInEnvelopeCount === 1 ? "YES" : "NO";
    // Pipe EDGES are not pipe attempts. The native side splits one authorized
    // course into as many edges as it needs nodes — the live pipe is two — so the
    // bound on attempts is the durable journal's, checked below, and the only
    // question the world has to answer here is whether a course is already there.
    // A duplicate is then a course the facility's own connector does not own,
    // which is counted from the chain proof rather than from an edge tally.
    const connectionCoursePresent = waterBefore.pipeInEnvelopeCount > 0;

    // --- E. The post-placement connection settlement -------------------------
    /**
     * Price the course the execution will ACTUALLY submit, and settle the one
     * bounded difference against what admission allowed for it.
     *
     * Admission prices the connection before the facility exists, so it can only
     * price the plan's own `connection.start` — the facility centre. The course
     * the execution submits starts at the facility's connector, a
     * prefab-determined point on the footprint, and the native spending contract
     * does not quote the two geometries the same. Once the facility has landed
     * the real connector is observable, and this is the only moment the
     * correction can be made: after a submission it would rewrite what a command
     * was permitted to cost.
     */
    const settleConnection = async (waterNow: Awaited<ReturnType<typeof readWorldWater>>) => {
      const durable = utilityDurability.projectState();
      if (durable.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        throw new Error("WATER_PHASE6_SETTLEMENT_NO_DURABLE_PROJECT");
      }
      const plan = record(record(record(record(durable.tranche.utilityExecution).utilities).water).plan);
      const facilityEntity = waterNow.facilities[0]?.entity;
      if (!facilityEntity || typeof plan.prefab !== "string") return null;
      const facilityPlannedCost = Number(plan.constructionCost);
      if (!Number.isFinite(facilityPlannedCost)) {
        throw new Error("WATER_PHASE6_SETTLEMENT_FACILITY_COST_UNKNOWN");
      }

      const payload = record(
        parseMcpJson(
          await callTool("cs2_utility_connectors", { index: facilityEntity.index, version: facilityEntity.version }),
        ),
      );
      const rawConnectors = Array.isArray(payload.connectors) ? payload.connectors.map(record) : [];
      const waterConnectors = rawConnectors
        .map((entry) => ({
          type: entry.type === "electricity" ? ("electricity" as const) : ("waterPipe" as const),
          node: { index: Number(record(entry.node).index), version: Number(record(entry.node).version) },
          worldPosition: { x: Number(record(entry.worldPosition).x), z: Number(record(entry.worldPosition).z) },
          attached: entry.attached === true,
          orphan: entry.orphan === true,
          capacity: record(entry.capacity) as UtilityConnectorReadback["capacity"],
          connectedEdges: [],
        }))
        .filter((entry) => entry.type === "waterPipe" && Number(entry.capacity.fresh ?? 0) > 0);
      report.connectionSettlementReadback = {
        connectorCount: waterConnectors.length,
        connectors: waterConnectors.map((entry) => ({
          node: entry.node,
          worldPosition: entry.worldPosition,
          attached: entry.attached,
          orphan: entry.orphan,
        })),
      };
      // Exactly one. An ambiguous connector means the geometry being priced is a
      // guess, and a guess is not something to authorize a spend against.
      if (waterConnectors.length !== 1) {
        throw new Error(`WATER_PHASE6_SETTLEMENT_CONNECTOR_NOT_UNIQUE:${waterConnectors.length}`);
      }
      const connector = waterConnectors[0];

      const candidates = buildUtilityConnectionCandidates(
        plan as unknown as Parameters<typeof buildUtilityConnectionCandidates>[0],
        connector,
      );
      const direct = candidates.find((candidate) => candidate.primitive === "direct-cable");
      if (!direct || direct.actions.length === 0) throw new Error("WATER_PHASE6_SETTLEMENT_NO_CONNECTION_COURSE");
      // The exact figures the native boundary will sum, asked of the same
      // contract it asks: one quote per segment of the course.
      const segmentQuotes: number[] = [];
      let actualConnectionQuote = 0;
      for (const action of direct.actions) {
        if (action.type !== "build_road") throw new Error(`WATER_PHASE6_SETTLEMENT_UNSUPPORTED_ACTION:${action.type}`);
        const quoted = await quoteConnectionCost({
          prefab: action.prefab,
          start: { x: action.x1, z: action.z1 },
          end: { x: action.x2, z: action.z2 },
        });
        segmentQuotes.push(quoted);
        actualConnectionQuote += quoted;
      }

      const networkOperations = utilityDurability.utilityNetworkOperations(repairScope) ?? [];
      const outcome = admitUtilityConnectionBudgetAmendment({
        durability: utilityDurability,
        activation: utilityActivation,
        state,
        treasury,
        policy: V2_PROJECT_ADMISSION_POLICY,
        facilityPlannedCost,
        actualConnectionQuote,
        settlement: {
          facilityPlaced: true,
          facilityPlacementCount: waterNow.facilityInEnvelopeCount,
          connectorResolved: true,
          connectionEffectAbsent: waterNow.pipeInEnvelopeCount === 0,
          submittedCommandIds: networkOperations
            .filter((operation) => !operation.failedBeforeSubmit)
            .map((operation) => operation.commandId),
        },
        amendmentId: `${state.project.id}:utility-connection-budget-amendment`,
        detail:
          "The admission priced this project's connection from the plan's own start, the facility centre, because no " +
          "connector was observable before the facility existed. The course the execution submits starts at the " +
          "facility's own connector, and the native spending contract quotes that geometry higher. This records the " +
          "one bounded difference, before anything is submitted.",
      });
      report.connectionSettlement = {
        status: outcome.status,
        segmentQuotes,
        actualConnectionQuote,
        connectionAllowance: "connectionAllowance" in outcome ? outcome.connectionAllowance : null,
        delta: outcome.status === "AMENDED" ? outcome.delta : 0,
        effectiveProjectBudget: outcome.effectiveProjectBudget,
        record: outcome.status === "NOT_REQUIRED" ? null : outcome.record,
      };
      verdict.CONNECTION_BUDGET_AMENDMENT = outcome.status;
      verdict.ORIGINAL_CONNECTION_ALLOWANCE = "connectionAllowance" in outcome ? outcome.connectionAllowance : null;
      verdict.ACTUAL_CONNECTION_QUOTE = actualConnectionQuote;
      verdict.CONNECTION_BUDGET_DELTA = outcome.status === "AMENDED" ? outcome.delta : 0;
      verdict.EFFECTIVE_PROJECT_BUDGET = outcome.effectiveProjectBudget;
      // The figure the execution is actually authorized for, settled against the
      // real connector geometry, rather than the admission-time estimate.
      verdict.REQUIRED_UTILITY_BUDGET = outcome.effectiveProjectBudget;
      verdict.WATER_CONNECTION_BUDGET_AUTHORIZED = "YES";
      return outcome.status === "NOT_REQUIRED" ? null : outcome.record;
    };

    /**
     * Run the clock forward, then pause again.
     *
     * Not an optional nicety: the city's own water statistics are produced BY the
     * simulation, and the game has been paused since before this slice existed,
     * so `freshCapacity` reads zero until the clock moves. `act, run time
     * forward, observe results` is the documented loop, and this is the middle
     * step. It builds nothing, places nothing, saves nothing and duplicates
     * nothing, and it restores the pause the preflight requires.
     */
    const advanceSimulation = async (label: string) => {
      const runs = (report.simulationRuns as unknown[]) ?? [];
      runs.push({ label, hours: SIMULATION_HOURS, speed: SIMULATION_SPEED });
      report.simulationRuns = runs;
      await callTool("cs2_run_simulation", { hours: SIMULATION_HOURS, speed: SIMULATION_SPEED });
      const startedAt = Date.now();
      for (let poll = 0; poll < 75; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const state = record(parseMcpJson(await callTool("cs2_game_state", {})));
        if (record(state.simulation).paused === true) break;
        if (Date.now() - startedAt > 150_000) break;
      }
      await callTool("cs2_set_simulation", { paused: true });
    };

    // --- E2. The first native water attempt, through production K05 ----------
    const k05 = new K05CommissionUtilitiesWorkflowAdapter(utilityFoundation);
    const iterations: unknown[] = [];
    let skillResult: Awaited<ReturnType<typeof k05.execute>> | null = null;
    // The settlement an earlier pass recorded, if any. It is read rather than
    // re-derived so a pass that only has to CERTIFY does not have to settle
    // again — and could not, since a submitted course is refused a second one.
    let connectionAmendment: V2UtilityBudgetAmendmentRecord | null =
      utilityDurability
        .utilityBudgetAmendments()
        .find(
          (record) =>
            record.projectId === state.project.id && record.reason === UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON,
        ) ?? null;
    verdict.CONNECTION_BUDGET_AMENDMENT = connectionAmendment ? "ALREADY_AMENDED" : "NONE";
    // The workflow runs even when the course is already in the world, because
    // what is still missing is not a pipe — it is the CERTIFICATION that reads
    // the city's own state and produces a SkillResult. A second submission is
    // impossible regardless: the durable write contract refuses a course that
    // was already attempted, so this cannot build anything twice.
    for (let index = 0; index < MAXIMUM_ITERATIONS; index += 1) {
      const stepBefore = await readWorldWater();
      // Rebuilt every iteration from the durable journal, so the first-placement
      // guard reads the placement this run actually made.
      const firstFacilityPlacement = firstFacilityPlacementDurability(
        utilityDurability.utilityPlacementOperations(repairScope),
      );
      // The settlement runs exactly once, at the only moment it is legal: the
      // facility has landed, and nothing has been submitted for the connection.
      if (
        connectionAmendment === null &&
        !connectionCoursePresent &&
        stepBefore.facilityInEnvelopeCount === MAXIMUM_FACILITY_PLACEMENTS &&
        stepBefore.pipeInEnvelopeCount === 0
      ) {
        connectionAmendment = await settleConnection(stepBefore);
      }
      const stepPreparation = buildUtilityPreparationInput({
        state,
        world: utilityActivation.world,
        treasury,
        kind: "water",
        certifiedRoad: deliveredRoad.target,
        certifiedRoadRefs: deliveredRoad.refs,
        firstFacilityPlacement,
        ...(connectionAmendment ? { utilityBudgetAmendment: connectionAmendment } : {}),
      });
      // The production preparation, called directly, so a blocked one can be
      // reported in its own terms rather than as a single mapped reason code.
      // `prepare` sends no native command: the V2 preparation ports carry no
      // `execute`, and placement authorization is absent here.
      const prepareDiagnostic = await utilityFoundation.greenfieldUtilityBootstrap.prepare(stepPreparation);
      report.waterPrepareDiagnostic = {
        status: prepareDiagnostic.status,
        reason: "reason" in prepareDiagnostic ? prepareDiagnostic.reason : null,
        facility: "facility" in prepareDiagnostic ? prepareDiagnostic.facility : null,
        connector: "connector" in prepareDiagnostic ? prepareDiagnostic.connector : null,
        diagnostics: "diagnostics" in prepareDiagnostic ? prepareDiagnostic.diagnostics : null,
        connectionDiagnostics: "connectionDiagnostics" in prepareDiagnostic ? prepareDiagnostic.connectionDiagnostics : null,
        preflightDiagnostics: "preflightDiagnostics" in prepareDiagnostic ? prepareDiagnostic.preflightDiagnostics : null,
      };
      const result = await k05.execute(
        { recipeFamily: utilityFacilityRecipe("water"), preparation: stepPreparation },
        undefined,
        ["water"],
      );
      const stepAfter = await readWorldWater();
      iterations.push({
        index,
        firstFacilityPlacement,
        admissionWithheld: !stepPreparation.facilityPlacementAuthorization,
        maximumSpend: stepPreparation.maximumSpend,
        status: result.status,
        error: result.error ?? null,
        reason: result.durableOutcome?.reason ?? null,
        waiting: result.durableOutcome?.waiting ?? null,
        serviceCertified: result.durableOutcome?.serviceCertified ?? null,
        before: {
          facilityInEnvelopeCount: stepBefore.facilityInEnvelopeCount,
          pipeInEnvelopeCount: stepBefore.pipeInEnvelopeCount,
          waterCapacity: stepBefore.waterCapacity,
        },
        after: {
          facilityInEnvelopeCount: stepAfter.facilityInEnvelopeCount,
          pipeInEnvelopeCount: stepAfter.pipeInEnvelopeCount,
          waterCapacity: stepAfter.waterCapacity,
        },
      });
      skillResult = result;
      if (stepAfter.facilityInEnvelopeCount > MAXIMUM_FACILITY_PLACEMENTS) {
        throw new Error(`WATER_PHASE6_FACILITY_BOUND_EXCEEDED:${stepAfter.facilityInEnvelopeCount}`);
      }
      if (result.status === "SUCCESS") break;
      const reason = result.durableOutcome?.reason ?? "";
      // A failed or exhausted objective ends the run. An UNRESOLVED one does not:
      // it is a command in flight, and the next pass reconciles it against the
      // world before anything else. That is not a retry — the candidate ledger is
      // durable, so a course that was already attempted cannot be submitted
      // again. What the next pass needs that this one could not have is time,
      // because the statistics that report the effect are produced by a
      // simulation that has been paused since before the effect existed.
      if (result.status === "FAILED" || TERMINAL_REASONS.has(reason)) break;
      if (!OBSERVATION_REASONS.has(reason) && result.status !== "WAITING") break;
      await advanceSimulation(`after water iteration ${index} (${reason || result.status})`);
    }
    report.waterIterations = iterations;
    report.waterSkillResult = skillResult;
    verdict.WATER_SKILL_RESULT = skillResult?.status ?? "NOT_ATTEMPTED";
    verdict.WATER_SKILL_ERROR = skillResult?.error ?? null;

    // --- F. Authoritative reconciliation ------------------------------------
    const afterWater = await worldCounts();
    const water = await readWorldWater();
    report.worldAfterWater = afterWater;
    report.waterDelta = {
      roads: afterWater.roads - worldBeforeWater.roads,
      buildings: afterWater.buildings - worldBeforeWater.buildings,
    };
    report.waterAfter = water;
    verdict.WATER_FACILITY_PLACEMENT_COUNT = water.facilityInEnvelopeCount;
    verdict.WATER_FACILITY_EFFECT = water.facilityInEnvelopeCount === 1 ? "OBSERVED_MATCH" : "NOT_OBSERVED";
    verdict.WATER_PIPE_PHYSICAL_EFFECT = water.pipeInEnvelopeCount >= 1 ? "OBSERVED_MATCH" : "NOT_OBSERVED";
    verdict.DUPLICATE_FACILITY_COUNT = Math.max(0, water.facilityInEnvelopeCount - 1);
    verdict.DUPLICATE_ROAD_COUNT = Math.max(0, repairRoadCommands.length - 1);
    verdict.WATER_CAPACITY_AFTER = water.waterCapacity;
    verdict.WATER_NETWORK_CONNECTED = (water.waterCapacity ?? 0) > 0 ? "YES" : "NO";
    verdict.WATER_SERVICE_AVAILABLE = skillResult?.status === "SUCCESS" ? "YES" : "NO";
    verdict.GROUNDWATER_SOURCE_VALID = verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" ? "YES" : "NO";
    verdict.WATER_SITE_VALID = verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" ? "YES" : "NO";
    verdict.NATIVE_FACILITY_PLACEABILITY = verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" ? "YES" : "NO";
    verdict.ROAD_CANDIDATE_VALID = deliveredRoad.status === "CERTIFIED" ? "YES" : "NO";
    verdict.REQUIRED_UTILITY_BUDGET = requiredUtilityBudget;
    verdict.WATER_DURABLE_EVIDENCE_RECORDED =
      state.tranche.utilityExecution && record(state.tranche.utilityExecution).utilities ? "YES" : "NO";

    // The facility's own connector, read authoritatively from the current world.
    const facility = water.facilities[0]?.entity ?? null;
    if (facility) {
      const readback = record(
        parseMcpJson(await callTool("cs2_utility_connectors", { index: facility.index, version: facility.version })),
      );
      const rawConnectors = Array.isArray(readback.connectors) ? readback.connectors.map(record) : [];
      const waterNodes = rawConnectors.filter((node) => node.type === "waterPipe");
      const waterNode = waterNodes[0] ?? null;
      const connectedEdges = waterNode && Array.isArray(waterNode.connectedEdges) ? waterNode.connectedEdges.map(record) : [];
      // The chain proof. "A pipe edge exists somewhere in the envelope" is not a
      // binding; what makes it one is that the pipe the FACILITY's own connector
      // reports runs from that connector to the certified road contact. The
      // connector is the authority on which edges are its own, so the walk starts
      // there rather than from a nearest-edge search.
      const chain = pipeChainFrom(
        water.pipes,
        waterNode ? record(waterNode.worldPosition) : null,
        deliveredRoad.status === "CERTIFIED" ? deliveredRoad.target.position : null,
      );
      report.waterConnectorReadback = {
        connectorCount: rawConnectors.length,
        waterPipeNodeCount: waterNodes.length,
        attached: waterNode ? waterNode.attached === true : null,
        orphan: waterNode ? waterNode.orphan === true : null,
        externalEdgeCount: waterNode ? waterNode.externalEdgeCount ?? null : null,
        facilityOwnedEdgeCount: waterNode ? waterNode.facilityOwnedEdgeCount ?? null : null,
        prefab: waterNode ? String(waterNode.prefab ?? "") : null,
        connectedEdges,
        chain,
      };
      verdict.WATER_TOPOLOGY_BINDING = chain.reachesTarget ? "VALID" : chain.reason;
      // The network is connected when the facility's connector participates in
      // the pipe graph with at least one edge that is not its own. `orphan` is
      // diagnostic only, exactly as it is for electricity: it describes the
      // engine's own building-graph shape, not whether a connection exists.
      verdict.WATER_NETWORK_CONNECTED =
        waterNode && waterNode.attached === true && connectedEdges.length >= 1 ? "YES" : "NO";
      // A duplicate is a pipe course the facility's OWN connector does not own,
      // not a second edge of the one it does. The native side splits a course
      // wherever it needs a node, so counting edges would call one pipe two.
      const ownedEdges = new Set(chain.edgeIds);
      const unownedPipes = water.pipes.filter(
        (edge) => !ownedEdges.has(`${record(edge.entity).index}:${record(edge.entity).version}`),
      );
      report.unownedPipeEdges = unownedPipes.map((edge) => edge.entity);
      verdict.DUPLICATE_PIPE_COUNT = unownedPipes.length;
    } else {
      report.waterConnectorReadback = null;
      report.unownedPipeEdges = [];
      verdict.WATER_TOPOLOGY_BINDING = "NO_FACILITY";
      verdict.DUPLICATE_PIPE_COUNT = water.pipeInEnvelopeCount;
    }

    // The durable attempt ledger, so the bounds are proven from the journal too.
    const repairNetworkOps = utilityDurability.utilityNetworkOperations(repairScope) ?? [];
    const pipeAttempts = repairNetworkOps.filter(
      (operation) => operation.exactInput.includes(WATER_PIPE_PREFAB) && !operation.failedBeforeSubmit,
    ).length;
    report.repairNetworkOperations = repairNetworkOps.map((operation) => ({
      commandId: operation.commandId,
      outcome: operation.outcome,
      status: operation.status,
      failedBeforeSubmit: operation.failedBeforeSubmit,
      isPipe: operation.exactInput.includes(WATER_PIPE_PREFAB),
    }));
    verdict.WATER_PIPE_NATIVE_ATTEMPT_COUNT = pipeAttempts;
    if (pipeAttempts > MAXIMUM_PIPE_ATTEMPTS) throw new Error(`WATER_PHASE6_PIPE_ATTEMPT_BOUND_EXCEEDED:${pipeAttempts}`);

    // --- G. Read/write safety proof -----------------------------------------
    const forbidden = calls.filter((call) => FORBIDDEN_TOOLS.has(call.name));
    report.forbiddenToolCalls = forbidden.map((call) => call.name);
    report.gate1Simulation = GATE1_PROGRESSION_SIMULATION;
    report.repairsAfter = utilityDurability.admissionSemanticRepairs().length;
    verdict.FORCED_SAVE_COUNT = calls.filter((call) => call.name === "cs2_save_game").length;
    if (forbidden.length > 0) {
      throw new Error(`WATER_PHASE6_FORBIDDEN_TOOL:${forbidden.map((call) => call.name).join(",")}`);
    }

    verdict.LIVE_WATER_PROOF_COMPLETE =
      verdict.WATER_SERVICE_AVAILABLE === "YES" &&
      verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" &&
      verdict.WATER_PIPE_PHYSICAL_EFFECT === "OBSERVED_MATCH" &&
      verdict.WATER_NETWORK_CONNECTED === "YES"
        ? "YES"
        : "NO";
  } catch (error) {
    failed = true;
    const failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      forbiddenToolCalls: calls.filter((call) => FORBIDDEN_TOOLS.has(call.name)).map((call) => call.name),
    };
    report.failure = failure;
    verdict.FAILURE = failure.message;
    verdict.FORCED_SAVE_COUNT = calls.filter((call) => call.name === "cs2_save_game").length;
  } finally {
    report.ladder = ladder;
    report.constraintEvaluations = evaluations;
    report.probeAttempts = probeAttempts;
    report.callLog = calls.map(
      (call) =>
        `${call.name}${record(call.args).mode ? `:${record(call.args).mode}` : ""}${
          record(call.args).kind ? `/${record(call.args).kind}` : ""
        }`,
    );
    report.finishedAt = new Date().toISOString();
    report.liveStoreSha256After = report.liveStoreSha256After ?? sha256(liveStorePath);
    report.liveStoreRewritten = report.liveStoreSha256After !== storeHashBefore;
    await fsPromises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fsPromises.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report.verdict, null, 2)}\n`);
    await client.close();
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
