/**
 * READ-ONLY live preflight for Water Phase 2: the new project identity.
 *
 * Phase 1 found a legal water site, but only through the owned map-highway
 * ingress seed — every owned local frontage failed the water constraint. Phase 2
 * is the normal Gate 1 production admission for that site, and the open question
 * is what identity it mints and what it reserves.
 *
 * This answers that without changing anything:
 *
 *   - `ensureFirstProject()` would RECOVER the electricity project from the
 *     durable reconstructed authority and hand back a reservation with no
 *     groundwater in it. That is the wrong project for this slice.
 *   - `admitFirstProject()` is the strict path: it plans a NEW Gate 1 state, and
 *     it derives the identity from the CURRENT certified baseline, so it cannot
 *     reproduce the electricity project's identity.
 *
 * The script calls the strict path and reports the identity, the reservation and
 * the planned tasks it produces. It is the same production composition root the
 * app uses — `createV2FoundationPorts` with `projectSiteConstraint` — so the
 * water constraint reaching admission here is the wiring that will run live.
 *
 * Safety:
 *   - the durable store is an in-memory copy of the live store, so the admitted
 *     Gate 1 state is never persisted and the live electron-store file is never
 *     written;
 *   - the live store file is hashed before and after and the durable command
 *     journal must still hold exactly the commands it started with;
 *   - the MCP call log is checked afterwards for native action tools.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import {
  createV2FoundationPorts,
  parseV2McpJson,
  parseV2SpatialSiteDetail,
} from "../src/main/services/ai-mayor/v2/main-adapter";
import {
  buildSpatialWorldModel,
  parseSpatialBootstrapScan,
} from "../src/main/services/ai-mayor/spatial/world-scanner";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";

type SpatialBootstrapScan = ReturnType<typeof parseSpatialBootstrapScan>;
import {
  createWaterSiteConstraint,
  type WaterSiteConstraintEvidence,
} from "../src/main/services/ai-mayor/v2/water-site-constraint";
import type { V2ProjectSiteConstraint } from "../src/main/services/ai-mayor/v2/project-admission";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath =
  process.env.WATER_PHASE2_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase2-preflight.json";
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");

/**
 * Resolution of the reservation read. The radius is NOT fixed here: admission
 * searches it (see `planningEnvelopeRadiusLadder`), so the constraint reads at
 * whichever radius it is asked about.
 */
const RESERVATION_RESOLUTION = 128;

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
  const liveCommands = Array.isArray(record(liveState).commands) ? (record(liveState).commands as unknown[]).length : -1;

  const client = new Client({ name: "5ire-ai-mayor-water-phase2-preflight", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name, arguments: args }, undefined, { signal });

  /**
   * Admission scans the world itself. Capturing that exact scan — rather than
   * issuing a second one — is what makes the constraint judge the same world the
   * admission judges.
   */
  let capturedScan: SpatialBootstrapScan | null = null;

  const manager = {
    legacyList: async () => ({
      tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseV2McpJson(await callTool(name, args));
      calls.push({ name, args });
      if (name === "cs2_spatial" && record(args).mode === "scan") {
        capturedScan = parseSpatialBootstrapScan(value);
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };

  const evaluations: WaterSiteConstraintEvidence[] = [];
  const readFailures: unknown[] = [];
  let constraint: V2ProjectSiteConstraint | null = null;
  const lazyConstraint: V2ProjectSiteConstraint = {
    kind: "water-source-within-utility-reservation",
    async accepts(candidate, reservationRadius, signal) {
      if (!constraint) {
        if (!capturedScan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED");
        const scan = capturedScan;
        constraint = createWaterSiteConstraint({
          world: buildSpatialWorldModel(scan),
          assets: scan.bootstrapAssets,
          // An admission-time project has no certified road, so the production
          // `scopeRoadAuthority` hands the planner the whole current-world set.
          roads: scan.roadGraph.edges,
          readReservation: async (point: SpatialPoint2, radius: number, readSignal?: AbortSignal): Promise<SpatialSiteDetail | null> => {
            const raw = await callTool(
              "cs2_spatial",
              { mode: "detail", x: point.x, z: point.z, radius, resolution: RESERVATION_RESOLUTION },
              readSignal,
            );
            const parsed = parseV2McpJson(raw);
            try {
              return parseV2SpatialSiteDetail(parsed);
            } catch (error) {
              // Keep the payload that failed to parse: "incomplete" on its own
              // does not say whether the bridge refused, truncated, or returned
              // an error envelope.
              readFailures.push({
                center: { x: point.x, z: point.z },
                radius,
                error: error instanceof Error ? error.message : String(error),
                topLevelKeys: Object.keys(record(parsed)),
                isError: record(raw).isError ?? null,
                payloadHead: JSON.stringify(parsed).slice(0, 600),
              });
              throw error;
            }
          },
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
  };
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
      worldEpochId: world.worldEpochId ?? null,
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
    report.durableStoreBefore = {
      projectStateSchema: durability.projectState().schemaVersion,
      projectAuthorityStatus: durability.projectAuthority()?.status ?? null,
      authorityUtilityKinds: durability.projectAuthority()?.utilityKinds ?? null,
      authorityInheritedJournalPosition: durability.projectAuthority()?.inheritedJournalPosition ?? null,
      commands: durability.snapshot().commands.length,
      journalPosition: durability.snapshot().journalPosition,
      durablyActivated: durability.isExecutionDurablyActivated(activation),
    };

    try {
      const admission = await projectAdmission.admitFirstProject();
      const state = admission.state;
      report.strictAdmission = {
        status: admission.status,
        evidence: admission.status === "ADMITTED" ? admission.evidence : null,
        gate1SchemaVersion: state.schemaVersion,
        admissionStage: state.tranche.stage,
        intentId: state.intent.id,
        projectId: state.project.id,
        districtId: state.district.id,
        trancheId: state.tranche.id,
        reservationRef: state.tranche.reservationRef,
        utilityReservation: state.project.utilityReservation,
        maximumBudget: state.project.maximumBudget,
        taskStates: state.tasks.map((task) => ({
          id: task.id,
          kind: task.kind,
          status: task.status,
          attempts: task.attempts,
        })),
        journalEntries: state.journal.map((entry) => ({
          id: entry.id,
          skill: entry.skill,
          execution: entry.execution,
          commandId: entry.commandId,
        })),
        writtenToMemoryOnly: true,
      };
    } catch (error) {
      report.strictAdmission = {
        status: "REFUSED",
        reason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      };
    }

    report.waterConstraintEvaluations = evaluations;
    report.reservationReadFailures = readFailures;

    const nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    const storeHashAfter = sha256(liveStorePath);
    report.nativeMutationCalls = nativeMutationCalls.map((call) => call.name);
    report.liveStoreUnchanged = storeHashBefore !== null && storeHashBefore === storeHashAfter;
    report.liveStoreSha256 = storeHashBefore;
    report.durableStoreAfter = {
      projectStateSchema: durability.projectState().schemaVersion,
      commands: durability.snapshot().commands.length,
      journalPosition: durability.snapshot().journalPosition,
      commandsUnchanged: durability.snapshot().commands.length === liveCommands,
    };
    if (nativeMutationCalls.length > 0) throw new Error("WATER_PHASE2_PREFLIGHT_EXECUTED_A_NATIVE_MUTATION");
    if (!report.liveStoreUnchanged) throw new Error("WATER_PHASE2_PREFLIGHT_WROTE_TO_THE_LIVE_STORE");
    if (!(report.durableStoreAfter as { commandsUnchanged: boolean }).commandsUnchanged) {
      throw new Error("WATER_PHASE2_PREFLIGHT_ADDED_A_DURABLE_COMMAND");
    }
    report.verdict = {
      NEW_PROJECT_IDENTITY: (report.strictAdmission as any)?.status === "ADMITTED" ? "YES" : "NO",
      ADMITTED_INTENT_ID: (report.strictAdmission as any)?.intentId ?? null,
      NATIVE_MUTATIONS: nativeMutationCalls.length,
      LIVE_STORE_UNCHANGED: report.liveStoreUnchanged ? "YES" : "NO",
    };
  } catch (error) {
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
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
