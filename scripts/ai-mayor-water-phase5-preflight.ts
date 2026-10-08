/**
 * Water Phase 5 — supersede the invalid water admission and re-admit, READ-ONLY.
 *
 * The durable project was admitted while the water site constraint was unsound:
 * it accepted a candidate on "the planner returned something" rather than "the
 * planner returned a water facility", and it read the terrain as a SQUARE of
 * half-width equal to the reservation radius, so a source in a corner — outside
 * the circle placement is confined to — counted as reachable. The admitted 180 m
 * reservation contains no clean groundwater at all, and the nearest source in the
 * region is 225.6 m from its centre, so that project can never be served.
 *
 * It is real history: its ROAD was delivered and is a lawful world effect. This
 * does not repair it, delete it or rewrite it. It records that the admission
 * behind it was invalid and admits the ONE replacement a supersession buys, with
 * the corrected constraint and the bounded radius search.
 *
 * Everything here runs against an in-memory copy of the live store and against
 * the running game read-only. Nothing is persisted and no native command is
 * issued; the durable supersession is visible in the report and nowhere else.
 *
 * Safety:
 *   - the live electron-store file is hashed before and after and must be
 *     byte-identical;
 *   - the durable command journal must still hold exactly the commands it
 *     started with;
 *   - the MCP call log is checked afterwards for native action tools, so a
 *     `prepare` that quietly reached a mutation fails the run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import {
  buildSpatialWorldModel,
  parseSpatialBootstrapScan,
} from "../src/main/services/ai-mayor/spatial/world-scanner";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { V2_GATE1_STATE_SCHEMA_VERSION } from "../src/main/services/ai-mayor/v2/gate1";
import {
  createV2FoundationPorts,
  parseV2McpJson,
  parseV2SpatialSiteDetail,
} from "../src/main/services/ai-mayor/v2/main-adapter";
import type { Gate1BoundedSiteCandidate } from "../src/main/services/ai-mayor/v2/site-selection";
import type { V2ProjectSiteConstraint } from "../src/main/services/ai-mayor/v2/project-admission";
import {
  createWaterSiteConstraint,
  type WaterSiteConstraintEvidence,
} from "../src/main/services/ai-mayor/v2/water-site-constraint";

type SpatialBootstrapScan = ReturnType<typeof parseSpatialBootstrapScan>;

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_PHASE5_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase5-preflight.json";
/** The electron-store key the live durable state lives under. Kept as a literal so this script never imports electron-store. */
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");

const SUPERSESSION_REASON = "ADMISSION_INVALIDATED_BY_FIXED_SITE_CONSTRAINT";
const SUPERSESSION_DETAIL =
  "the water site constraint accepted on a planner result of any kind and read the terrain as a square, " +
  "so the admitted reservation contains no clean groundwater and no radius the product allows can serve it";
/** Resolution of the verification read; the radius comes from the admitted reservation. */
const RESERVATION_RESOLUTION = 128;

/** Native tools that mutate the world. Any of these appearing in the call log fails the run. */
const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game",
  "cs2_build_road",
  "cs2_mayor_execute_actions",
  "cs2_run_simulation",
  "cs2_bulldoze",
  "cs2_build",
  "cs2_zone",
  "cs2_place_building",
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

async function main() {
  const storeHashBefore = sha256(liveStorePath);
  const envelope = JSON.parse(fs.readFileSync(liveStorePath, "utf8")) as Record<string, unknown>;
  const liveState = envelope[LIVE_STATE_KEY];
  if (typeof liveState !== "object" || liveState === null) throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  const liveJournal = {
    commands: Array.isArray(record(liveState).commands) ? (record(liveState).commands as unknown[]).length : -1,
    journalPosition: Number(record(liveState).journalPosition ?? -1),
  };

  const client = new Client({ name: "5ire-ai-mayor-water-phase5-preflight", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  // Held in an object rather than a bare `let`: the scan is captured by the
  // admission read inside a closure and read back at the top level, where a
  // `let` would be narrowed to its initial `null`.
  const captured: { scan: SpatialBootstrapScan | null } = { scan: null };
  const manager = {
    legacyList: async () => ({
      tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
      calls.push({ name, args });
      if (name === "cs2_spatial" && record(args).mode === "scan") captured.scan = parseSpatialBootstrapScan(value);
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };

  // The production water constraint, built lazily because it needs the scan the
  // foundation issues on its first admission read.
  const evaluations: WaterSiteConstraintEvidence[] = [];
  let constraint: V2ProjectSiteConstraint | null = null;
  const lazyConstraint: V2ProjectSiteConstraint = {
    kind: "water-source-within-utility-reservation",
    async accepts(candidate, reservationRadius, signal) {
      if (!constraint) {
        if (!captured.scan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");
        const scan = captured.scan;
        constraint = createWaterSiteConstraint({
          world: buildSpatialWorldModel(scan),
          assets: scan.bootstrapAssets,
          // An admission-time project has no certified road, so the production
          // `scopeRoadAuthority` hands the planner the whole current-world set.
          roads: scan.roadGraph.edges,
          readReservation: async (point: SpatialPoint2, radius: number, readSignal?: AbortSignal) =>
            parseV2SpatialSiteDetail(
              parseV2McpJson(
                await client.callTool(
                  {
                    name: "cs2_spatial",
                    arguments: { mode: "detail", x: point.x, z: point.z, radius, resolution: RESERVATION_RESOLUTION },
                  },
                  undefined,
                  { signal: readSignal },
                ),
              ),
            ),
          onEvaluated: (entry) => evaluations.push(entry),
        });
      }
      return constraint.accepts(candidate, reservationRadius, signal);
    },
  };

  const report: Record<string, unknown> = {
    serverPath,
    liveStorePath,
    startedAt: new Date().toISOString(),
    mode: "READ_ONLY",
    supersessionReason: SUPERSESSION_REASON,
    liveJournalBefore: liveJournal,
  };
  const verdict: Record<string, unknown> = {};
  report.verdict = verdict;
  let failed = false;
  try {
    const gameState = parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
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

    const durableStorage = createMemoryDurableStateStorage(liveState);
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: durableStorage,
      projectSiteConstraint: lazyConstraint,
    });
    const durability = ports.durability;
    const projectAdmission = ports.projectAdmission;
    if (!durability || !projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");

    const activation = durability.activate(gameState);
    const durablyActivated = durability.isExecutionDurablyActivated(activation);
    report.liveActivation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      durablyActivated,
      worldId: activation.world.worldId,
      generation: activation.world.generation,
      worldEpochId: activation.world.worldEpochId,
    };
    verdict.DURABLE_WORLD_ACTIVATED = durablyActivated ? "YES" : "NO";

    // --- The project whose admission is invalid ------------------------------
    const superseded = durability.projectState();
    if (superseded.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
      throw new Error("WATER_PHASE5_NO_GATE1_PROJECT_TO_SUPERSEDE");
    }
    report.supersededProject = {
      intentId: superseded.intent.id,
      projectId: superseded.project.id,
      trancheId: superseded.tranche.id,
      stage: superseded.tranche.stage,
      utilityReservation: superseded.project.utilityReservation,
    };

    const alreadySuperseded = durability.supersededProjects();
    report.alreadySuperseded = alreadySuperseded.map((entry) => ({
      supersessionId: entry.supersessionId,
      projectId: entry.projectId,
      replacementProjectId: entry.replacementProjectId,
      reason: entry.reason,
    }));

    // --- Supersede, and admit the one replacement ----------------------------
    let replacement;
    if (alreadySuperseded.length > 0) {
      // A previous run already recorded this. Re-running must not mint a second
      // replacement, so the durable record is resumed rather than repeated.
      const durableProject = durability.projectState();
      if (durableProject.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        throw new Error("WATER_PHASE5_REPLACEMENT_NOT_DURABLE");
      }
      replacement = { status: "RESUMED_EXISTING_REPLACEMENT" as const, supersession: alreadySuperseded[0], state: durableProject };
    } else {
      replacement = await projectAdmission.supersedeAndReplaceFirstProject({
        reason: SUPERSESSION_REASON,
        detail: SUPERSESSION_DETAIL,
      });
    }
    report.replacementStatus = replacement.status;
    report.replacement = {
      intentId: replacement.state.intent.id,
      projectId: replacement.state.project.id,
      trancheId: replacement.state.tranche.id,
      stage: replacement.state.tranche.stage,
      utilityReservation: replacement.state.project.utilityReservation,
      target: replacement.state.tranche.target,
      maximumBudget: replacement.state.project.maximumBudget,
      taskStates: replacement.state.tasks.map((task) => ({ kind: task.kind, status: task.status, attempts: task.attempts })),
    };
    report.supersessionRecord = {
      supersessionId: replacement.supersession.supersessionId,
      projectId: replacement.supersession.projectId,
      intentId: replacement.supersession.intentId,
      trancheId: replacement.supersession.trancheId,
      reservationRef: replacement.supersession.reservationRef,
      reason: replacement.supersession.reason,
      replacementProjectId: replacement.supersession.replacementProjectId,
      // The superseded project's reservation, read back out of the record: it is
      // still 180, because the invalid admission is not what got enlarged.
      supersededReservation: replacement.supersession.supersededState.project.utilityReservation,
      supersededStage: replacement.supersession.supersededState.tranche.stage,
      supersededIntentId: replacement.supersession.supersededState.intent.id,
    };
    report.admissionEvidence = "evidence" in replacement ? replacement.evidence : null;

    verdict.OLD_PROJECT_SUPERSEDED = "YES";
    verdict.OLD_PROJECT_IMMUTABLE =
      replacement.supersession.supersededState.intent.id === superseded.intent.id &&
      replacement.supersession.supersededState.project.utilityReservation.radius ===
        superseded.project.utilityReservation.radius &&
      replacement.supersession.supersededState.tranche.stage === superseded.tranche.stage
        ? "YES"
        : "NO";
    verdict.REPLACEMENT_PROJECT_CREATED = "YES";
    verdict.REPLACEMENT_PROJECT_COUNT = durability.supersededProjects().length;
    const reservation = replacement.state.project.utilityReservation;
    report.SELECTED_RESERVATION_RADIUS = reservation.radius;
    verdict.SELECTED_RESERVATION_RADIUS = reservation.radius;

    // --- The water source, re-proved against the CURRENT world ---------------
    // Not a re-run of the admission's own accept: the reservation is re-read from
    // the live world now, at the radius that was actually persisted, and the
    // production planner is asked whether a water facility fits in it.
    const detail = parseV2SpatialSiteDetail(
      parseV2McpJson(
        await client.callTool({
          name: "cs2_spatial",
          arguments: {
            mode: "detail",
            x: reservation.center.x,
            z: reservation.center.z,
            radius: reservation.radius,
            resolution: RESERVATION_RESOLUTION,
          },
        }),
      ),
    );
    report.reservationRead = {
      center: detail.center,
      radius: detail.radius,
      bounds: detail.terrain.bounds,
      cellSize: detail.terrain.cellSize,
      samples: detail.terrain.groundWater.length,
      roadEdges: detail.roadGraph.edges.length,
    };

    const insideCircle: Array<{ groundWater: number; pollution: number; distance: number }> = [];
    const { resolution, bounds, cellSize } = detail.terrain;
    for (let row = 0; row < resolution; row += 1) {
      for (let col = 0; col < resolution; col += 1) {
        const index = row * resolution + col;
        const x = bounds.minX + (col + 0.5) * cellSize.x;
        const z = bounds.minZ + (row + 0.5) * cellSize.z;
        const distance = Math.hypot(x - reservation.center.x, z - reservation.center.z);
        if (distance > reservation.radius) continue;
        insideCircle.push({
          groundWater: Number(detail.terrain.groundWater[index] ?? 0),
          pollution: Number(detail.terrain.groundWaterPollution[index] ?? 0),
          distance,
        });
      }
    }
    const cleanInside = insideCircle.filter((sample) => sample.groundWater > 0 && sample.pollution === 0);
    report.reservationGroundWater = {
      samplesInsideCircle: insideCircle.length,
      cleanSamplesInsideCircle: cleanInside.length,
      maximumGroundWater: cleanInside.length ? Math.max(...cleanInside.map((sample) => sample.groundWater)) : null,
      nearestCleanSampleMeters: cleanInside.length ? Math.min(...cleanInside.map((sample) => sample.distance)) : null,
    };
    verdict.GROUNDWATER_SOURCE_VALID = cleanInside.length > 0 ? "YES" : "NO";

    // The production predicate, re-run against this read at the persisted radius.
    if (!captured.scan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");
    const scan = captured.scan;
    const verification: WaterSiteConstraintEvidence[] = [];
    const verifyConstraint = createWaterSiteConstraint({
      world: buildSpatialWorldModel(scan),
      assets: scan.bootstrapAssets,
      roads: scan.roadGraph.edges,
      readReservation: async (point: SpatialPoint2, radius: number) =>
        parseV2SpatialSiteDetail(
          parseV2McpJson(
            await client.callTool({
              name: "cs2_spatial",
              arguments: { mode: "detail", x: point.x, z: point.z, radius, resolution: RESERVATION_RESOLUTION },
            }),
          ),
        ),
      onEvaluated: (entry) => verification.push(entry),
    });
    const candidate: Gate1BoundedSiteCandidate = {
      id: `verification:${replacement.state.project.id}`,
      target: { center: reservation.center, radius: reservation.radius },
      score: 0,
      blocked: false,
      direction: { x: 0, z: 1 },
      roadCandidates: [],
      evidence: {
        sourceAnchor: reservation.center,
        openResidentialCells: 0,
        owned: true,
        buildable: true,
        access: "BOUNDED_ROAD_FEASIBLE",
      },
    };
    const accepted = await verifyConstraint.accepts(candidate, reservation.radius);
    report.waterSiteVerification = { accepted, evidence: verification };
    verdict.WATER_SITE_VALID = accepted ? "YES" : "NO";
    report.waterConstraintEvaluations = evaluations;

    // --- Read-only proof ----------------------------------------------------
    const nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    const storeHashAfter = sha256(liveStorePath);
    const afterJournal = {
      commands: durability.snapshot().commands.length,
      journalPosition: durability.snapshot().journalPosition,
    };
    report.nativeMutationCalls = nativeMutationCalls.map((call) => call.name);
    report.liveStoreUnchanged = storeHashBefore !== null && storeHashBefore === storeHashAfter;
    report.liveStoreSha256 = storeHashBefore;
    report.durableJournalAfter = afterJournal;
    report.durableJournalUnchanged =
      afterJournal.commands === liveJournal.commands && afterJournal.journalPosition === liveJournal.journalPosition;
    report.scanCount = calls.filter((call) => call.name === "cs2_spatial" && record(call.args).mode === "scan").length;
    report.detailCount = calls.filter((call) => call.name === "cs2_spatial" && record(call.args).mode === "detail").length;

    if (nativeMutationCalls.length > 0) throw new Error("WATER_PHASE5_EXECUTED_A_NATIVE_MUTATION");
    if (!report.liveStoreUnchanged) throw new Error("WATER_PHASE5_WROTE_TO_THE_LIVE_STORE");
    if (!report.durableJournalUnchanged) throw new Error("WATER_PHASE5_ADDED_A_DURABLE_COMMAND");
    verdict.NATIVE_MUTATIONS = nativeMutationCalls.length;
    verdict.LIVE_STORE_UNCHANGED = report.liveStoreUnchanged ? "YES" : "NO";
    verdict.FORCED_SAVE_COUNT = calls.filter((call) => call.name === "cs2_save_game").length;
  } catch (error) {
    failed = true;
    report.failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      nativeMutationCalls: calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name)).map((call) => call.name),
    };
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
