/**
 * Water Phase 5 — the replacement identity, and the first native water attempt, LIVE.
 *
 * The admitted Water project is a historical project: it was admitted under a
 * site-constraint bug that let a reservation with no groundwater inside it pass
 * admission, and it has already delivered a ROAD into the world. Its history is
 * immutable, so this run does not rewrite it. It supersedes it — one durable
 * history record, the superseded state kept verbatim, the journal and the ROAD
 * untouched — and admits the ONE project that replaces it, through the same
 * production admission the app uses, now with the utility-aware bounded
 * envelope and the water site constraint.
 *
 * Then the water service itself, through the production K05 scoped-utility
 * boundary:
 *
 *   1. `supersedeAndReplaceFirstProject()` — the replacement identity, durable.
 *   2. `v2Gate1Progression.advanceToStage("ROAD_DELIVERED")` — the replacement's
 *      ROAD, by normal bounded road admission.
 *   3. `K05CommissionUtilitiesWorkflowAdapter.execute(…, ["water"])` — the
 *      production skill adapter, invoked with an explicit one-family mandate so
 *      the run commissions exactly the family this proof is authorized for.
 *   4. an authoritative readback after EVERY native step, before the next one.
 *
 * Bounds, checked rather than asserted:
 *   - WATER_REPLACEMENT_PROJECT_COUNT <= 1 (durable supersession records);
 *   - ROAD_PLACEMENT_COUNT <= 1, measured as the current-world road delta across
 *     the ROAD phase alone;
 *   - at most one GroundwaterPumpingStation01 and one Small Water Pipe edge
 *     inside the replacement reservation, read from the current world;
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
import {
  createV2FoundationPorts,
  parseV2SpatialSiteDetail,
  readNativeUtilityQuote,
  scopeRoadAuthority,
} from "../src/main/services/ai-mayor/v2/main-adapter";
import { V2_GATE1_STATE_SCHEMA_VERSION, type Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import type { V2DurableState, V2DurableStateStorage, V2ProjectSupersessionReason } from "../src/main/services/ai-mayor/v2/durability";
import { utilityFacilityRecipe } from "../src/main/services/ai-mayor/v2/utility-execution-planner";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { firstFacilityPlacementDurability } from "../src/main/services/ai-mayor/v2/utility-placement-durability";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { K05CommissionUtilitiesWorkflowAdapter } from "../src/main/services/ai-mayor/skills/adapters/k05-commission-utilities-workflow";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import { createWaterSiteConstraint, readWaterUtilityRequirement, type WaterSiteConstraintEvidence } from "../src/main/services/ai-mayor/v2/water-site-constraint";
import type { V2ProjectSiteConstraint } from "../src/main/services/ai-mayor/v2/project-admission";
import { V2_PROJECT_ADMISSION_POLICY } from "../src/main/services/ai-mayor/v2/project-admission";
import { admitUtilityBudgetAmendment } from "../src/main/services/ai-mayor/v2/utility-budget";

type SpatialBootstrapScan = ReturnType<typeof parseSpatialBootstrapScan>;

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_PHASE5_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase5-live.json";
/** The electron-store key the live durable state lives under. Kept as a literal so this script never imports electron-store. */
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const backupPath = process.env.WATER_PHASE5_STORE_BACKUP ?? `${liveStorePath}.water-phase5-backup`;

/** Resolution of the reservation read; the radius comes from admission's search. */
const RESERVATION_RESOLUTION = 128;
const WATER_FACILITY_PREFAB = "GroundwaterPumpingStation01";
const WATER_PIPE_PREFAB = "Small Water Pipe";
const SUPERSESSION_REASON: V2ProjectSupersessionReason = "ADMISSION_INVALIDATED_BY_FIXED_SITE_CONSTRAINT";
const SUPERSESSION_DETAIL =
  "Admitted by a site constraint that evaluated the reservation as a square terrain read, so a groundwater " +
  "source outside the reservation circle could satisfy it. The reservation holds no clean groundwater, and the " +
  "project has already delivered a ROAD, so its history stays as delivered and one replacement is admitted " +
  "under the corrected, utility-aware bounded envelope.";

const MAXIMUM_REPLACEMENT_PROJECTS = 1;
const MAXIMUM_ROAD_PLACEMENTS = 1;
const MAXIMUM_FACILITY_PLACEMENTS = 1;
const MAXIMUM_PIPE_ATTEMPTS = 1;
/** One native step per iteration; the loop stops far earlier whenever anything is unresolved. */
const MAXIMUM_ITERATIONS = 6;

/** Tools that would take the world past this phase's mandate. */
const FORBIDDEN_TOOLS = new Set(["cs2_save_game", "cs2_zone", "cs2_place_building", "cs2_bulldoze"]);

/** Reasons that mean a native command may be in flight. Never retried blindly. */
const STOP_REASONS = new Set([
  "UTILITY_RECONCILIATION_REQUIRED",
  "UTILITY_OBSERVATION_UNKNOWN",
  "UTILITY_CONSTRUCTION_ATTEMPTS_EXHAUSTED",
  "UTILITY_CONNECTION_CANDIDATES_EXHAUSTED",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const sha256 = (file: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const sameRef = (left: { index: number; version: number }, right: { index: number; version: number }) =>
  left.index === right.index && left.version === right.version;

/**
 * The live canonical store, written exactly as `createCanonicalDurableStateStorage`
 * writes it — electron-store's default tab indentation, every sibling key kept.
 * electron-store itself cannot be imported outside Electron, and a script that
 * silently wrote a different shape would corrupt the file the app reads back.
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
  // Kept rather than overwritten: its whole purpose is to make this run
  // reversible, and re-copying a post-run store would destroy exactly the state
  // it exists to preserve.
  const backupWritten = !fs.existsSync(backupPath);
  if (backupWritten) await fsPromises.copyFile(liveStorePath, backupPath);

  const client = new Client({ name: "5ire-ai-mayor-water-phase5-live", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    calls.push({ name, args });
    return client.callTool({ name, arguments: args }, undefined, { signal });
  };

  let capturedScan: SpatialBootstrapScan | null = null;
  const manager = {
    legacyList: async () => ({
      tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseMcpJson(await callTool(name, args));
      if (name === "cs2_spatial" && record(args).mode === "scan") {
        capturedScan = parseSpatialBootstrapScan(value);
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };

  const evaluations: WaterSiteConstraintEvidence[] = [];
  let constraint: V2ProjectSiteConstraint | null = null;
  let constraintWorld: Record<string, unknown> | null = null;

  /**
   * The native spending contract's own quote for a pipe.
   *
   * `cs2_spatial` in preflight mode is the same call the execution boundary uses
   * to price a network action, and it is preview-only: it returns a figure and
   * changes nothing. Nothing in the spatial catalogue prices a net, so this is
   * the only authoritative source for the connection half of the requirement.
   */
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
      throw new Error(
        `WATER_PIPE_QUOTE_REJECTED:${typeof result.reason === "string" ? result.reason : "unknown"}`,
      );
    }
    const quoted = readNativeUtilityQuote(result, Number.NaN);
    if (!Number.isFinite(quoted)) throw new Error("WATER_PIPE_QUOTE_UNKNOWN");
    return quoted;
  };

  /**
   * The game's own verdict on one proposed pumping-station placement.
   *
   * Admission cannot infer this from terrain. The durable 200 m reservation is
   * full of clean, dry, owned, flat groundwater and the game still refuses the
   * station at every position and rotation inside it, so "the planner found a
   * source" and "the station can be built there" are two facts and only the
   * second one is a project.
   *
   * A refusal is not an empty payload: the Bridge answers a blocked placement
   * with HTTP 409 (`BridgeToolSystem.BuildRejectedResponse`), which `parseMcpJson`
   * surfaces as a thrown error carrying that status. So 409 is read as the game
   * saying no, and every other throw stays a probe that was never taken — an
   * unobserved placement is refused, never assumed placeable.
   */
  const probePlacement = async (
    placement: { prefab: string; position: SpatialPoint2; rotation: number },
    probeSignal?: AbortSignal,
  ): Promise<boolean> => {
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
      return result.valid === true && result.previewOnly === true;
    } catch (error) {
      if (record(error).status === 409) return false;
      throw error;
    }
  };

  /** The scan-derived inputs a water constraint needs, read once and reused. */
  const spatialInputs = () => {
    if (!capturedScan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");
    const scan = capturedScan;
    return { scan, world: buildSpatialWorldModel(scan), assets: scan.bootstrapAssets };
  };

  /**
   * Issue the authoritative scan if this run has not already made one.
   *
   * On a resume the site constraint is never invoked — the project already
   * exists — so nothing has captured a scan yet. The budget probe below still
   * needs the current world, and reading it is a bounded read-only call.
   */
  const ensureScan = async () => {
    if (!capturedScan) await manager.legacyCall({ name: "cs2_spatial", arguments: { mode: "scan", roadLimit: 2_000 } });
    return spatialInputs();
  };

  const lazyConstraint: V2ProjectSiteConstraint = {
    kind: "water-source-within-utility-reservation",
    async accepts(candidate, reservationRadius, signal) {
      if (!constraint) {
        const { scan, world, assets } = spatialInputs();
        constraintWorld = {
          roadEdges: scan.roadGraph.edges.length,
          roadNodes: scan.roadGraph.nodes.length,
          assets: assets.length,
          tiles: scan.tiles.length,
        };
        constraint = createWaterSiteConstraint({
          world,
          assets,
          roads: scan.roadGraph.edges,
          quoteConnectionCost,
          probePlacement,
          readReservation: async (point: SpatialPoint2, radius: number, readSignal?: AbortSignal): Promise<SpatialSiteDetail | null> =>
            parseV2SpatialSiteDetail(
              parseMcpJson(
                await callTool(
                  "cs2_spatial",
                  { mode: "detail", x: point.x, z: point.z, radius, resolution: RESERVATION_RESOLUTION },
                  readSignal,
                ),
              ),
            ),
          onEvaluated: (entry) => evaluations.push(entry),
        });
      }
      return constraint.accepts(candidate, reservationRadius, signal);
    },
    async minimumFeasibleBudget(candidate, reservationRadius, signal) {
      // Admission always asks this about a candidate it just accepted, and the
      // acceptance is what builds the constraint. A missing one is a wiring
      // fault, not a world fact.
      if (!constraint?.minimumFeasibleBudget) throw new Error("WATER_CONSTRAINT_NOT_INITIALIZED");
      return constraint.minimumFeasibleBudget(candidate, reservationRadius, signal);
    },
  };

  const liveStorage = createLiveDurableStateStorage(storeEnvelope);
  /** Both list tools cap `limit` at 500; the totals they report are not capped. */
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
    mode: "LIVE_MUTATION_BOUNDED_TO_ONE_REPLACEMENT_ROAD_AND_ONE_WATER_SERVICE",
    supersessionReason: SUPERSESSION_REASON,
    liveStoreSha256Before: storeHashBefore,
  };
  const verdict: Record<string, unknown> = {};
  report.verdict = verdict;
  let failed = false;

  /**
   * The authoritative current-world read of the water slice: what is actually
   * inside the replacement reservation, and what the city reports for water.
   * Every native step is followed by one of these before the next is allowed.
   */
  let reservation: { center: SpatialPoint2; radius: number } | null = null;
  const readWorldWater = async () => {
    if (!reservation) throw new Error("WATER_PHASE5_RESERVATION_UNKNOWN");
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
    const pipes = detail.roadGraph.edges.filter((edge) => edge.prefab === WATER_PIPE_PREFAB);
    const snapshot = record(parseMcpJson(await callTool("cs2_mayor_snapshot", {})));
    const water = record(record(snapshot.utilities).water);
    return {
      detailBuildings: detail.buildings.length,
      detailEdges: detail.roadGraph.edges.length,
      facilityCount: facilities.length,
      facilityInEnvelopeCount: facilities.filter((building) => inEnvelope(building.position)).length,
      facilities: facilities.map((building) => ({ entity: building.entity, position: building.position })),
      pipeCount: pipes.length,
      pipeInEnvelopeCount: pipes.filter((edge) => inEnvelope(edge.start) || inEnvelope(edge.end)).length,
      pipes: pipes.map((edge) => ({ entity: edge.entity, start: edge.start, end: edge.end })),
      water,
      waterCapacity: typeof water.capacity === "number" ? water.capacity : null,
    };
  };

  try {
    // --- 0. Authoritative world preflight (read only) ------------------------
    const gameState = parseMcpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
    const game = record(gameState);
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

    report.worldBefore = await worldCounts();

    // --- 1. The supersession and the one replacement identity ----------------
    // This composition root is built first and discarded after the replacement:
    // its durability is bound to the pre-replacement store.
    const admissionFoundation = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
      projectSiteConstraint: lazyConstraint,
    });
    if (!admissionFoundation.projectAdmission || !admissionFoundation.durability) {
      throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
    }
    const activation = admissionFoundation.durability.activate(gameState);
    const durablyActivated = admissionFoundation.durability.isExecutionDurablyActivated(activation);
    report.liveActivation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      durablyActivated,
      worldId: activation.world.worldId,
      worldEpochId: activation.world.worldEpochId,
      generation: activation.world.generation,
      checkpointId: activation.world.checkpointId,
    };
    verdict.DURABLE_WORLD_ACTIVATED = durablyActivated ? "YES" : "NO";
    if (!durablyActivated) throw new Error(activation.blockedReason ?? "DURABLE_WORLD_NOT_ACTIVATED");

    const ensured = await admissionFoundation.projectAdmission.ensureFirstProject();
    const before = ensured.state;
    report.projectBeforeReplacement = {
      status: ensured.status,
      schemaVersion: before.schemaVersion,
      stage: before.tranche.stage,
      intentId: before.intent.id,
      projectId: before.project.id,
      trancheId: before.tranche.id,
      utilityReservation: before.project.utilityReservation,
    };
    const supersessions = admissionFoundation.durability.supersededProjects();
    if (supersessions.length > MAXIMUM_REPLACEMENT_PROJECTS) {
      throw new Error(`WATER_PHASE5_REPLACEMENT_BOUND_EXCEEDED:${supersessions.length}`);
    }
    const existingReplacement = supersessions.find((entry) => entry.replacementProjectId === before.project.id);
    let replacementStatus: string;
    let supersession = existingReplacement ?? null;
    if (existingReplacement) {
      // Already replaced by an earlier run of this same bounded step. Resuming is
      // the only safe reading: minting a second replacement is exactly what the
      // one-replacement bound forbids.
      replacementStatus = "RESUMED_EXISTING_REPLACEMENT";
      report.replacement = null;
    } else {
      if (supersessions.length > 0) throw new Error("WATER_PHASE5_SUPERSESSION_LINEAGE_UNEXPECTED");
      const replaced = await admissionFoundation.projectAdmission.supersedeAndReplaceFirstProject({
        reason: SUPERSESSION_REASON,
        detail: SUPERSESSION_DETAIL,
      });
      replacementStatus = replaced.status;
      supersession = replaced.supersession;
      report.replacement = {
        status: replaced.status,
        intentId: replaced.state.intent.id,
        projectId: replaced.state.project.id,
        trancheId: replaced.state.tranche.id,
        stage: replaced.state.tranche.stage,
        utilityReservation: replaced.state.project.utilityReservation,
        target: replaced.state.tranche.target,
        maximumBudget: replaced.state.project.maximumBudget,
        selectedCandidateId: replaced.evidence.selectedCandidateId,
        anchorClass: replaced.evidence.anchorClass,
        anchorFallbackReason: replaced.evidence.anchorFallbackReason ?? null,
        reservationRadiusMeters: replaced.evidence.reservationRadiusMeters,
        reservationRadiusLadder: replaced.evidence.reservationRadiusLadder,
      };
    }
    report.supersessionRecord = supersession;
    report.waterConstraintEvaluations = evaluations;
    report.constraintWorld = constraintWorld;
    // Immutability is a comparison, not an assertion. The superseded state the
    // record carries must still be the project that was superseded — its own
    // identity, the stage it was superseded at, and the reservation it held —
    // never the replacement, and never rewritten to the replacement's scope.
    //
    // On the first run the pre-replacement project is still the durable one, so
    // the reservation is compared against the state this run observed. On a
    // resume it is not: the durable slot now holds the replacement. The
    // witnesses then are the record's own identity fields, the fact that the
    // superseded reservation is still not the replacement's, and the superseded
    // project's ROAD command still standing in the journal under its own owner.
    const supersededState = supersession?.supersededState ?? null;
    const supersededReservation = supersededState?.project.utilityReservation ?? null;
    const supersededRoadOwner = supersession ? `${supersession.trancheId}:task:road_connection` : null;
    const supersededRoadCommand = supersededRoadOwner
      ? admissionFoundation.durability.commandJournal
          .list()
          .find(
            (command) =>
              command.actionFamily === "ROAD" &&
              command.status === "OBSERVED_MATCH" &&
              record(record(command.authorizedScope).owner).ownerId === supersededRoadOwner,
          ) ?? null
      : null;
    const observedPreReplacement = supersession && supersession.projectId === before.project.id ? before : null;
    const supersededIdentityHolds =
      supersededState !== null &&
      supersession !== null &&
      supersededState.project.id === supersession.projectId &&
      supersededState.intent.id === supersession.intentId &&
      supersededState.tranche.id === supersession.trancheId &&
      supersededState.tranche.reservationRef === supersession.reservationRef &&
      supersededState.project.id !== supersession.replacementProjectId;
    const supersededScopeUnexpanded =
      supersededReservation !== null &&
      (observedPreReplacement !== null
        ? supersededReservation.radius === observedPreReplacement.project.utilityReservation.radius &&
          supersededReservation.center.x === observedPreReplacement.project.utilityReservation.center.x &&
          supersededReservation.center.z === observedPreReplacement.project.utilityReservation.center.z
        : supersededReservation.radius !== before.project.utilityReservation.radius);
    report.supersededImmutability = {
      supersededStateObservedDirectly: observedPreReplacement !== null,
      supersededStage: supersededState?.tranche.stage ?? null,
      supersededReservation,
      replacementReservation: before.project.utilityReservation,
      supersededRoadCommandId: supersededRoadCommand?.commandId ?? null,
      identityHolds: supersededIdentityHolds,
      scopeUnexpanded: supersededScopeUnexpanded,
    };
    verdict.REPLACEMENT_PROJECT_CREATED = replacementStatus === "REPLACED" ? "YES" : "ALREADY_EXISTED";
    verdict.REPLACEMENT_PROJECT_COUNT = supersessions.length + (replacementStatus === "REPLACED" ? 1 : 0);
    verdict.OLD_PROJECT_SUPERSEDED = supersession ? "YES" : "NO";
    verdict.OLD_PROJECT_IMMUTABLE =
      supersession && supersededIdentityHolds && supersededScopeUnexpanded && supersededRoadCommand !== null
        ? "YES"
        : "NO";
    if (verdict.OLD_PROJECT_IMMUTABLE === "NO") throw new Error("WATER_PHASE5_SUPERSEDED_STATE_NOT_IMMUTABLE");

    // --- 2. The replacement's ROAD, through the production lifecycle owner ---
    // A second composition root, built after the replacement persisted, so its
    // durability loads the replacement exactly as a fresh app start would.
    const progressionPorts = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
      projectSiteConstraint: lazyConstraint,
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
      taskStates: progression.state?.tasks.map((task) => ({ kind: task.kind, status: task.status, attempts: task.attempts })),
    };
    const afterRoad = (await worldCounts()) as { roads: number; buildings: number };
    const beforeRoad = report.worldBefore as { roads: number; buildings: number };
    const roadDelta = { roads: afterRoad.roads - beforeRoad.roads, buildings: afterRoad.buildings - beforeRoad.buildings };
    report.worldAfterRoad = afterRoad;
    report.roadDelta = roadDelta;
    const roadBuildCalls = calls.filter((call) => call.name === "cs2_build_road").length;
    // The replacement's own ROAD ledger, read from the durable store this run has
    // been writing. The world delta alone would read zero on a resume, when the
    // road was delivered by an earlier run of this same bounded step. The
    // journal-wide `roadCommandCount` is not usable either: it counts every
    // submitted ROAD command the store has ever recorded, across identities.
    const replacementRoadOwner = `${progression.state?.tranche.id ?? ""}:task:road_connection`;
    const durableEntries = () => {
      const durable = record(storeEnvelope[LIVE_STATE_KEY]);
      return Array.isArray(durable.commands) ? durable.commands.map(record) : [];
    };
    const replacementRoadCommands = durableEntries().filter((entry) => {
      const command = record(entry.record);
      return (
        command.actionFamily === "ROAD" &&
        command.submittedAt !== null &&
        record(record(command.authorizedScope).owner).ownerId === replacementRoadOwner
      );
    });
    verdict.ROAD_PLACEMENT_COUNT = replacementRoadCommands.length;
    verdict.ROAD_WORLD_DELTA_THIS_RUN = roadDelta.roads;
    verdict.ROAD_BUILD_CALL_COUNT = roadBuildCalls;
    // Duplicates are counted three ways, because each alone can be fooled: the
    // durable ledger of ROAD commands this replacement's own task authorized, the
    // world delta this run produced, and the native build calls this run issued.
    // All three are bounded by one.
    verdict.DUPLICATE_ROAD_COUNT = Math.max(0, replacementRoadCommands.length - 1);
    verdict.GATE1_STAGE_AFTER_PROGRESSION = progression.stage;
    if (replacementRoadCommands.length > MAXIMUM_ROAD_PLACEMENTS) {
      throw new Error(`WATER_PHASE5_ROAD_LEDGER_BOUND_EXCEEDED:${replacementRoadCommands.length}`);
    }
    if (roadDelta.roads > MAXIMUM_ROAD_PLACEMENTS) {
      throw new Error(`WATER_PHASE5_ROAD_BOUND_EXCEEDED:${roadDelta.roads}`);
    }
    if (roadBuildCalls > MAXIMUM_ROAD_PLACEMENTS) {
      throw new Error(`WATER_PHASE5_ROAD_CALL_BOUND_EXCEEDED:${roadBuildCalls}`);
    }
    if (roadDelta.buildings !== 0) throw new Error(`WATER_PHASE5_UNEXPECTED_BUILDING:${roadDelta.buildings}`);

    // --- 3. The water admission, on the replacement's delivered ROAD ---------
    const state: Gate1State | null = progression.state;
    if (!state || state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
      throw new Error("WATER_PHASE5_GATE1_STATE_UNAVAILABLE");
    }
    if (state.tranche.stage !== "ROAD_DELIVERED") throw new Error(`WATER_PHASE5_STAGE_${state.tranche.stage}`);
    reservation = state.project.utilityReservation;
    verdict.SELECTED_RESERVATION_RADIUS = reservation.radius;
    report.replacementState = {
      intentId: state.intent.id,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      utilityReservation: reservation,
      target: state.tranche.target,
    };

    // A third composition root, built now so its durability reads the state the
    // progression just persisted rather than the one this script started with.
    const utilityFoundation = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
    });
    const utilityDurability = utilityFoundation.durability;
    if (!utilityDurability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    // A fresh composition root starts unbound. `certifyDeliveredRoad` proves the
    // delivered road is in the CURRENT durable lineage, and that proof is exactly
    // what an unbound coordinator cannot make: `durableLineage` answers null
    // until the coordinator has bound the world it is being asked about. Bind it
    // here, to the world as it is NOW — after the replacement persisted and its
    // road was delivered — so the certification reads the lineage this run
    // actually produced rather than the one this script started with.
    const utilityActivation = utilityDurability.activate(parseMcpJson(await callTool("cs2_game_state", {})));
    const utilityDurablyActivated = utilityDurability.isExecutionDurablyActivated(utilityActivation);
    report.utilityActivation = {
      kind: utilityActivation.kind,
      status: utilityActivation.status,
      blockedReason: utilityActivation.blockedReason ?? null,
      durablyActivated: utilityDurablyActivated,
      worldId: utilityActivation.world.worldId,
      worldEpochId: utilityActivation.world.worldEpochId,
      generation: utilityActivation.world.generation,
      checkpointId: utilityActivation.world.checkpointId,
    };
    if (!utilityDurablyActivated) {
      throw new Error(utilityActivation.blockedReason ?? "WATER_PHASE5_UTILITY_WORLD_NOT_ACTIVATED");
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
    if (deliveredRoad.status !== "CERTIFIED") throw new Error(`WATER_PHASE5_ROAD_NOT_CERTIFIED:${deliveredRoad.reason}`);

    const overview = record(parseMcpJson(await callTool("cs2_city_overview", {})));
    const treasury = Number(overview.treasury);
    if (!Number.isFinite(treasury)) throw new Error("WATER_PHASE5_TREASURY_UNKNOWN");
    report.treasury = treasury;

    const placementScope = {
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      utilityKind: "water" as const,
    };
    /**
     * The durable proof that this project has not yet reached native.
     *
     * Unreadable lineage is `UNPROVEN`, never "nothing happened": a null here
     * means the journal could not be read, which proves nothing and must refuse
     * the amendment rather than wave it through.
     */
    const placementOperations = utilityDurability.utilityPlacementOperations(placementScope);
    const networkOperations = utilityDurability.utilityNetworkOperations(placementScope);
    const utilityMutation = {
      firstFacilityPlacement:
        placementOperations === null || networkOperations === null
          ? ({ status: "UNPROVEN", reason: "durable utility lineage unavailable" } as const)
          : firstFacilityPlacementDurability(placementOperations),
      submittedCommandIds: [...(placementOperations ?? []), ...(networkOperations ?? [])]
        .filter((operation) => !operation.failedBeforeSubmit)
        .map((operation) => operation.commandId),
    };
    report.utilityMutation = utilityMutation;

    // --- 3b. The one bounded budget amendment -------------------------------
    // The admitted budget is part of an immutable admission record, and this
    // project's plan costs more than it was admitted with. Re-admitting would
    // mean a third identity and a second ROAD; editing the record would rewrite
    // history other proofs rest on. So one amendment is appended, and only if
    // the current plan still declares the requirement it is funding.
    //
    // The requirement is re-derived here from the CURRENT world through the same
    // planner and the same road authority the execution will use, so the budget
    // this authorizes is the budget the execution actually needs. The road
    // authority is the certified road set, exactly as `planScopedUtility`
    // applies it.
    const { scan: budgetScan, world: budgetWorld, assets: budgetAssets } = await ensureScan();
    const budgetRoadAuthority = scopeRoadAuthority({
      certifiedRoadRefs: deliveredRoad.refs,
      approvedContact: deliveredRoad.target.position,
      currentWorldPlayerRoads: budgetScan.roadGraph.edges,
    });
    const requirementInput = {
      world: budgetWorld,
      assets: budgetAssets,
      roads: budgetRoadAuthority,
      quoteConnectionCost,
      readReservation: async (point: SpatialPoint2, radius: number, readSignal?: AbortSignal): Promise<SpatialSiteDetail | null> =>
        parseV2SpatialSiteDetail(
          parseMcpJson(
            await callTool(
              "cs2_spatial",
              { mode: "detail", x: point.x, z: point.z, radius, resolution: RESERVATION_RESOLUTION },
              readSignal,
            ),
          ),
        ),
    };
    const requirement = await readWaterUtilityRequirement(requirementInput, reservation);
    report.waterBudgetRequirement = requirement;
    verdict.REQUIRED_UTILITY_BUDGET = requirement.requiredSpend;

    const amendment = admitUtilityBudgetAmendment({
      durability: utilityDurability,
      activation: utilityActivation,
      state,
      treasury,
      policy: V2_PROJECT_ADMISSION_POLICY,
      requirement,
      mutation: utilityMutation,
      amendmentId: `${state.project.id}:utility-budget-amendment`,
      detail:
        "The admitted budget predates the utility-aware admission budget: the project was admitted under the " +
        "policy ceiling before admission computed what its own water plan costs. The plan needs the facility's " +
        "authoritative asset cost plus the native spending contract's quote for its connection primitive, and the " +
        "amendment authorizes exactly that and nothing else.",
    });
    report.utilityBudgetAmendment = amendment;
    verdict.BUDGET_AMENDMENT_RECORDED = amendment.status === "AMENDED" ? "YES" : amendment.status === "ALREADY_AMENDED" ? "ALREADY_EXISTED" : "NOT_REQUIRED";
    verdict.EFFECTIVE_PROJECT_BUDGET = amendment.effectiveProjectBudget;
    if (amendment.effectiveProjectBudget < requirement.requiredSpend) {
      throw new Error("WATER_PHASE5_BUDGET_STILL_INSUFFICIENT");
    }
    // Only the two outcomes that carry a durable record may widen an execution's
    // authorization; `NOT_REQUIRED` says the admitted budget already stands, and
    // passing anything for it would be authorizing a raise nobody recorded.
    const amendmentRecord = amendment.status === "NOT_REQUIRED" ? null : amendment.record;

    const preparation = buildUtilityPreparationInput({
      state,
      world: utilityActivation.world,
      treasury,
      kind: "water",
      certifiedRoad: deliveredRoad.target,
      certifiedRoadRefs: deliveredRoad.refs,
      firstFacilityPlacement: firstFacilityPlacementDurability(
        utilityDurability.utilityPlacementOperations(placementScope),
      ),
      utilityBudgetAmendment: amendmentRecord,
    });
    report.waterAdmission = {
      kind: preparation.kind,
      recipe: preparation.facilityPlacementAuthorization?.recipe ?? null,
      maximumPlacements: preparation.facilityPlacementAuthorization?.maximumPlacements ?? null,
      spatialEnvelope: preparation.spatialEnvelope,
      maximumSpend: preparation.maximumSpend,
      topologyRevision: preparation.topologyRevision,
    };
    verdict.WATER_ADMISSION_PASS = preparation.facilityPlacementAuthorization ? "YES" : "NO";
    if (!preparation.facilityPlacementAuthorization) throw new Error("WATER_PHASE5_ADMISSION_WITHHELD");

    // The world before the first native water command, so the slice's own
    // effects are separable from the ROAD phase's.
    const worldBeforeWater = await worldCounts();
    const waterBefore = await readWorldWater();
    report.worldBeforeWater = worldBeforeWater;
    report.waterBefore = waterBefore;
    verdict.WATER_CAPACITY_BEFORE = waterBefore.waterCapacity;
    verdict.WATER_FACILITY_PLACEMENT_COUNT_BEFORE = waterBefore.facilityInEnvelopeCount;
    if (waterBefore.facilityInEnvelopeCount > 0) {
      throw new Error(`WATER_PHASE5_FACILITY_ALREADY_PRESENT:${waterBefore.facilityInEnvelopeCount}`);
    }
    if (waterBefore.pipeInEnvelopeCount > 0) {
      throw new Error(`WATER_PHASE5_PIPE_ALREADY_PRESENT:${waterBefore.pipeInEnvelopeCount}`);
    }

    // --- 4. The first native water attempt, through production K05 -----------
    const k05 = new K05CommissionUtilitiesWorkflowAdapter(utilityFoundation);
    const iterations: unknown[] = [];
    let skillResult: Awaited<ReturnType<typeof k05.execute>> | null = null;
    for (let index = 0; index < MAXIMUM_ITERATIONS; index += 1) {
      const stepBefore = await readWorldWater();
      // The admission is rebuilt every iteration from the durable journal, so the
      // first-placement guard reads the placement this run has actually made
      // rather than the one it had made before the loop started. A stale
      // `NONE` here would let a second placement through the admission.
      const firstFacilityPlacement = firstFacilityPlacementDurability(
        utilityDurability.utilityPlacementOperations(placementScope),
      );
      const stepPreparation = buildUtilityPreparationInput({
        state,
        world: utilityActivation.world,
        treasury,
        kind: "water",
        certifiedRoad: deliveredRoad.target,
        certifiedRoadRefs: deliveredRoad.refs,
        firstFacilityPlacement,
        utilityBudgetAmendment: amendmentRecord,
      });
      const result = await k05.execute({ recipeFamily: utilityFacilityRecipe("water"), preparation: stepPreparation }, undefined, ["water"]);
      const stepAfter = await readWorldWater();
      iterations.push({
        index,
        firstFacilityPlacement,
        admissionWithheld: !stepPreparation.facilityPlacementAuthorization,
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
      // The one-facility and one-pipe bounds are the world's, not the ledger's.
      if (stepAfter.facilityInEnvelopeCount > MAXIMUM_FACILITY_PLACEMENTS) {
        throw new Error(`WATER_PHASE5_FACILITY_BOUND_EXCEEDED:${stepAfter.facilityInEnvelopeCount}`);
      }
      if (stepAfter.pipeInEnvelopeCount > MAXIMUM_PIPE_ATTEMPTS) {
        throw new Error(`WATER_PHASE5_PIPE_BOUND_EXCEEDED:${stepAfter.pipeInEnvelopeCount}`);
      }
      if (result.status === "SUCCESS") break;
      // A native outcome this run cannot resolve is never retried: the next
      // attempt could place a second facility beside one that already exists.
      const reason = result.durableOutcome?.reason ?? "";
      if (STOP_REASONS.has(reason) || result.status === "FAILED") break;
    }
    report.waterIterations = iterations;
    report.waterSkillResult = skillResult;
    verdict.WATER_SKILL_RESULT = skillResult?.status ?? "NOT_ATTEMPTED";
    verdict.WATER_SKILL_ERROR = skillResult?.error ?? null;

    // --- 5. Authoritative reconciliation ------------------------------------
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
    verdict.DUPLICATE_PIPE_COUNT = Math.max(0, water.pipeInEnvelopeCount - 1);
    verdict.WATER_NETWORK_CONNECTED = (water.waterCapacity ?? 0) > 0 ? "YES" : "NO";
    verdict.WATER_SERVICE_AVAILABLE = skillResult?.status === "SUCCESS" ? "YES" : "NO";
    verdict.WATER_CAPACITY_AFTER = water.waterCapacity;

    // The durable attempt ledger, so the bounds are proven from the journal too
    // and not only from the world read.
    const waterNetworkOps = utilityDurability.utilityNetworkOperations(placementScope) ?? [];
    const waterNetworkOperations = waterNetworkOps.map((operation) => ({
      commandId: operation.commandId,
      position: operation.position,
      outcome: operation.outcome,
      status: operation.status,
      failedBeforeSubmit: operation.failedBeforeSubmit,
      isPipe: operation.exactInput.includes(WATER_PIPE_PREFAB),
    }));
    report.waterNetworkOperations = waterNetworkOperations;
    const pipeAttempts = waterNetworkOperations.filter((operation) => operation.isPipe && !operation.failedBeforeSubmit).length;
    verdict.WATER_PIPE_NATIVE_ATTEMPT_COUNT = pipeAttempts;
    if (pipeAttempts > MAXIMUM_PIPE_ATTEMPTS) {
      throw new Error(`WATER_PHASE5_PIPE_ATTEMPT_BOUND_EXCEEDED:${pipeAttempts}`);
    }
    report.firstFacilityPlacement = firstFacilityPlacementDurability(utilityDurability.utilityPlacementOperations(placementScope));

    // --- 6. Read/write safety proof -----------------------------------------
    const forbidden = calls.filter((call) => FORBIDDEN_TOOLS.has(call.name));
    const supersededProjectsAfter = utilityDurability.supersededProjects().length;
    report.forbiddenToolCalls = forbidden.map((call) => call.name);
    report.gate1Simulation = GATE1_PROGRESSION_SIMULATION;
    report.liveStoreSha256After = sha256(liveStorePath);
    report.liveStoreRewritten = report.liveStoreSha256After !== storeHashBefore;
    report.supersededProjectsAfter = supersededProjectsAfter;
    if (forbidden.length > 0) throw new Error(`WATER_PHASE5_FORBIDDEN_TOOL:${forbidden.map((call) => call.name).join(",")}`);
    if (supersededProjectsAfter > MAXIMUM_REPLACEMENT_PROJECTS) {
      throw new Error(`WATER_PHASE5_REPLACEMENT_BOUND_EXCEEDED:${supersededProjectsAfter}`);
    }

    verdict.GROUNDWATER_SOURCE_VALID = verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" ? "YES" : "NO";
    verdict.WATER_SITE_VALID = verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" ? "YES" : "NO";
    verdict.FORCED_SAVE_COUNT = calls.filter((call) => call.name === "cs2_save_game").length;
    verdict.NEW_WATER_PROJECT_ADMITTED = replacementStatus === "REPLACED" || replacementStatus === "RESUMED_EXISTING_REPLACEMENT"
      ? "YES" : "NO";
    verdict.LIVE_WATER_PROOF_COMPLETE = verdict.WATER_SERVICE_AVAILABLE === "YES" &&
      verdict.WATER_FACILITY_EFFECT === "OBSERVED_MATCH" &&
      verdict.WATER_PIPE_PHYSICAL_EFFECT === "OBSERVED_MATCH" ? "YES" : "NO";
  } catch (error) {
    failed = true;
    const failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      forbiddenToolCalls: calls.filter((call) => FORBIDDEN_TOOLS.has(call.name)).map((call) => call.name),
    };
    report.waterConstraintEvaluations = evaluations;
    report.constraintWorld = constraintWorld;
    report.failure = failure;
    report.liveStoreSha256After = sha256(liveStorePath);
    report.liveStoreRewritten = report.liveStoreSha256After !== storeHashBefore;
    verdict.FAILURE = failure.message;
  } finally {
    report.callLog = calls.map((call) => `${call.name}${record(call.args).mode ? `:${record(call.args).mode}` : ""}`);
    report.finishedAt = new Date().toISOString();
    await fsPromises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fsPromises.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
