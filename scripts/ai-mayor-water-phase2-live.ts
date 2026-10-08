/**
 * Water Phase 2 — the new project identity, live.
 *
 * Phase 1 found a legal water site; the read-only preflight proved the strict
 * admission path mints a genuinely new identity for it. This is the same run
 * with the live durable store, so the admission is real:
 *
 *   1. `admitFirstProject()` — the strict production path, planned against the
 *      water site constraint. It derives the identity from the CURRENT certified
 *      baseline (`save:6d2c0c1f…`), which is not the electricity project's
 *      baseline (`save:444a6f12…`), so it cannot reproduce that identity and
 *      cannot build a second road beside it. If that identity already exists the
 *      run resumes it instead of minting a second one.
 *   2. `v2Gate1Progression.advanceToStage("ROAD_DELIVERED")` — the production
 *      Gate 1 lifecycle owner, over the same composition root the app uses.
 *
 * It stops at ROAD_DELIVERED. No zoning, no utility placement, no save. The
 * progression is asked for one milestone and returns as soon as the state
 * machine reports it reached.
 *
 * Bounds, checked rather than asserted:
 *   - ROAD_PLACEMENT_COUNT <= 1, measured as the current-world road delta;
 *   - the progression's own durable ROAD command count;
 *   - `cs2_save_game` must never appear in the MCP call log;
 *   - the live store is copied aside before the first write, so the durable
 *     admission is reversible without a rollback of the world.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  GATE1_PROGRESSION_SIMULATION,
  createMainMayorPorts,
  parseMcpJson,
} from "../src/main/services/ai-mayor/main-adapters";
import { createV2FoundationPorts, parseV2SpatialSiteDetail } from "../src/main/services/ai-mayor/v2/main-adapter";
import { V2_GATE1_STATE_SCHEMA_VERSION, type Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import type { V2DurableState, V2DurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import {
  createWaterSiteConstraint,
  type WaterSiteConstraintEvidence,
} from "../src/main/services/ai-mayor/v2/water-site-constraint";
import type { V2ProjectSiteConstraint } from "../src/main/services/ai-mayor/v2/project-admission";

type SpatialBootstrapScan = ReturnType<typeof parseSpatialBootstrapScan>;

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_PHASE2_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase2-live.json";
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const backupPath = process.env.WATER_PHASE2_STORE_BACKUP ?? `${liveStorePath}.water-phase2-backup`;

/** Resolution of the reservation read; the radius comes from admission's search. */
const RESERVATION_RESOLUTION = 128;
/** The bound the slice is held to. A road delta above this fails the run. */
const MAXIMUM_ROAD_PLACEMENTS = 1;

/** Tools that would take the world or the save past this phase's mandate. */
const FORBIDDEN_TOOLS = new Set([
  "cs2_save_game",
  "cs2_zone",
  "cs2_place_building",
  "cs2_bulldoze",
  "cs2_mayor_execute_actions",
  "cs2_build",
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
  const rawEnvelope = fs.readFileSync(liveStorePath, "utf8");
  const envelope = JSON.parse(rawEnvelope) as Record<string, unknown>;
  const liveState = envelope[LIVE_STATE_KEY];
  if (typeof liveState !== "object" || liveState === null) throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  // Kept rather than overwritten: its whole purpose is to make the durable
  // admission reversible, and re-copying a post-admission store would destroy
  // exactly the state it exists to preserve.
  const backupWritten = !fs.existsSync(backupPath);
  if (backupWritten) await fsPromises.copyFile(liveStorePath, backupPath);

  const client = new Client({ name: "5ire-ai-mayor-water-phase2-live", version: "1.0.0" });
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
  const lazyConstraint: V2ProjectSiteConstraint = {
    kind: "water-source-within-utility-reservation",
    async accepts(candidate, reservationRadius, signal) {
      if (!constraint) {
        if (!capturedScan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");
        const scan = capturedScan;
        constraintWorld = {
          roadEdges: scan.roadGraph.edges.length,
          roadNodes: scan.roadGraph.nodes.length,
          assets: scan.bootstrapAssets.length,
          tiles: scan.tiles.length,
          worldId: record(scan).worldId ?? null,
          generation: record(scan).generation ?? null,
        };
        constraint = createWaterSiteConstraint({
          world: buildSpatialWorldModel(scan),
          assets: scan.bootstrapAssets,
          roads: scan.roadGraph.edges,
          // `callTool` yields the MCP envelope; the parser wants the payload.
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
  };

  const liveStorage = createLiveDurableStateStorage(envelope);
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
    mode: "LIVE_MUTATION_BOUNDED_TO_ONE_ROAD",
    liveStoreSha256Before: storeHashBefore,
  };
  let failed = false;
  try {
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

    // --- 1. The new project identity, through the strict production path -----
    const admissionFoundation = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
      projectSiteConstraint: lazyConstraint,
    });
    if (!admissionFoundation.projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
    let admitted: Gate1State;
    let admissionStatus: string;
    let admissionEvidence: unknown = null;
    try {
      const admission = await admissionFoundation.projectAdmission.admitFirstProject();
      admitted = admission.state;
      admissionStatus = admission.status;
      admissionEvidence = admission.status === "ADMITTED" ? admission.evidence : null;
    } catch (error) {
      // A Gate 1 state already exists. Minting a second identity for the same
      // site is the one thing this slice must never do, so this resumes the
      // persisted identity instead — the same state a restarted app drives.
      if (!(error instanceof Error) || error.message !== "PROJECT_ADMISSION_ALREADY_EXISTS") throw error;
      const persisted = admissionFoundation.durability?.projectState();
      if (!persisted || persisted.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw error;
      admitted = persisted;
      admissionStatus = "RESUMED_EXISTING_IDENTITY";
    }
    report.admission = {
      status: admissionStatus,
      evidence: admissionEvidence,
      gate1SchemaVersion: admitted.schemaVersion,
      stage: admitted.tranche.stage,
      intentId: admitted.intent.id,
      projectId: admitted.project.id,
      trancheId: admitted.tranche.id,
      reservationRef: admitted.tranche.reservationRef,
      utilityReservation: admitted.project.utilityReservation,
      target: admitted.tranche.target,
      maximumBudget: admitted.project.maximumBudget,
      taskStates: admitted.tasks.map((task) => ({ kind: task.kind, status: task.status, attempts: task.attempts })),
    };
    report.waterConstraintEvaluations = evaluations;
    report.constraintWorld = constraintWorld;
    report.scanCount = calls.filter((call) => call.name === "cs2_spatial" && record(call.args).mode === "scan").length;
    if (admissionStatus !== "ADMITTED" && admissionStatus !== "RESUMED_EXISTING_IDENTITY") {
      throw new Error(`WATER_PHASE2_ADMISSION_${admissionStatus}`);
    }

    // --- 2. The ROAD, through the production Gate 1 lifecycle owner ----------
    // A second composition root, built after the admission persisted, so its
    // durability loads the admitted state exactly as a fresh app start would.
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager as never,
      durableStateStorage: liveStorage,
      projectSiteConstraint: lazyConstraint,
      emit: () => {},
    });
    if (!ports.v2Gate1Progression) throw new Error("V2_PRODUCTION_GATE1_PROGRESSION_NOT_CONFIGURED");
    const progression = await ports.v2Gate1Progression.advanceToStage("ROAD_DELIVERED");
    report.progression = {
      status: progression.status,
      stage: progression.stage,
      milestone: progression.milestone,
      decisions: progression.decisions,
      roadCommandCount: progression.roadCommandCount,
      reason: progression.reason,
      wake: progression.wake ?? null,
      executionRecoveryMarkers: progression.state?.tranche.executionRecoveryMarkers ?? null,
      taskStates: progression.state?.tasks.map((task) => ({ kind: task.kind, status: task.status, attempts: task.attempts })),
      journalEntries: progression.state?.journal.map((entry) => ({
        id: entry.id,
        skill: entry.skill,
        execution: entry.execution,
        commandId: entry.commandId,
      })),
    };

    const before = report.worldBefore as { roads: number; buildings: number };
    const after = (await worldCounts()) as { roads: number; buildings: number };
    report.worldAfter = after;
    const worldDelta = { roads: after.roads - before.roads, buildings: after.buildings - before.buildings };
    report.worldDelta = worldDelta;
    report.gate1Simulation = GATE1_PROGRESSION_SIMULATION;

    const forbidden = calls.filter((call) => FORBIDDEN_TOOLS.has(call.name));
    report.forbiddenToolCalls = forbidden.map((call) => call.name);
    report.liveStoreSha256After = sha256(liveStorePath);
    report.liveStoreRewritten = report.liveStoreSha256After !== storeHashBefore;
    if (forbidden.length > 0) throw new Error(`WATER_PHASE2_FORBIDDEN_TOOL:${forbidden.map((c) => c.name).join(",")}`);
    if (worldDelta.roads > MAXIMUM_ROAD_PLACEMENTS) {
      throw new Error(`WATER_PHASE2_ROAD_BOUND_EXCEEDED:${worldDelta.roads}`);
    }
    if (worldDelta.buildings !== 0) throw new Error(`WATER_PHASE2_UNEXPECTED_BUILDING:${worldDelta.buildings}`);

    report.verdict = {
      NEW_PROJECT_IDENTITY: admissionStatus === "ADMITTED" ? "YES" : "RESUMED_EXISTING",
      ADMITTED_INTENT_ID: admitted.intent.id,
      ADMITTED_STAGE: admitted.tranche.stage,
      GATE1_STAGE_AFTER_PROGRESSION: progression.stage,
      ROAD_PLACEMENT_COUNT: worldDelta.roads,
      BUILDING_PLACEMENT_COUNT: worldDelta.buildings,
      ROAD_COMMAND_COUNT: progression.roadCommandCount,
      FORCED_SAVE_COUNT: calls.filter((call) => call.name === "cs2_save_game").length,
      DUPLICATE_ROAD_COUNT: worldDelta.roads > MAXIMUM_ROAD_PLACEMENTS ? "UNKNOWN" : 0,
    };
  } catch (error) {
    failed = true;
    report.waterConstraintEvaluations = evaluations;
    report.constraintWorld = constraintWorld;
    report.scanCount = calls.filter((call) => call.name === "cs2_spatial" && record(call.args).mode === "scan").length;
    report.failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      forbiddenToolCalls: calls.filter((call) => FORBIDDEN_TOOLS.has(call.name)).map((call) => call.name),
    };
    report.liveStoreSha256After = sha256(liveStorePath);
    report.liveStoreRewritten = report.liveStoreSha256After !== storeHashBefore;
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
