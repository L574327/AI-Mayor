/**
 * READ-ONLY live preflight for the Water slice.
 *
 * This script answers two questions against the running game and the real
 * durable store, and it answers them without changing either:
 *
 *   1. Does the bounded recovery-admission seam restore the live world's
 *      missing `Gate1State` to `ROAD_DELIVERED` from the durable ROAD lineage
 *      the store already holds, re-proved against the current world?
 *   2. If so, does the water utility slice then reach the original production
 *      boundary — a water-licensed first-facility placement against the
 *      certified road, planned through `greenfieldUtilityBootstrap.prepare`?
 *
 * Nothing here is a new code path: it is `createV2FoundationPorts`,
 * `projectAdmission.ensureFirstProject()`, `certifyDeliveredRoad`,
 * `buildUtilityPreparationInput` and `greenfieldUtilityBootstrap.prepare`.
 *
 * Safety:
 *   - the durable store handed to the foundation ports is an in-memory copy of
 *     the live store, so the recovered Gate 1 state is never persisted and the
 *     live electron-store file is never written;
 *   - the live store file is hashed before and after, and the durable command
 *     journal must still hold exactly the commands it started with;
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
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { V2_GATE1_STATE_SCHEMA_VERSION } from "../src/main/services/ai-mayor/v2/gate1";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { firstFacilityPlacementDurability } from "../src/main/services/ai-mayor/v2/utility-placement-durability";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath =
  process.env.WATER_PREFLIGHT_EVIDENCE ?? "docs/ai-mayor/evidence/water-live-preflight.json";
/** The electron-store key the live durable state lives under. Kept as a literal so this script never imports electron-store. */
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");

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

  const liveCommands = Array.isArray(record(liveState).commands) ? (record(liveState).commands as unknown[]).length : -1;

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-water-live-preflight", version: "1.0.0" });
  await client.connect(transport);

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const manager = {
    legacyList: async () => ({
      tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };

  const report: Record<string, unknown> = {
    serverPath,
    liveStorePath,
    startedAt: new Date().toISOString(),
    mode: "READ_ONLY",
  };
  try {
    // --- Authoritative world preflight (read only) -------------------------
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

    // --- In-memory durability seeded from the live store --------------------
    const durableStorage = createMemoryDurableStateStorage(liveState);
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: durableStorage,
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
      nativeSessionGuid: activation.world.nativeSessionGuid,
      loadPurpose: activation.world.loadPurpose,
      checkpointId: activation.world.checkpointId,
      generation: activation.world.generation,
      worldEpochId: activation.world.worldEpochId,
    };
    report.durableStoreBefore = {
      projectStateSchema: durability.projectState().schemaVersion,
      projectAuthorityStatus: durability.projectAuthority()?.status ?? null,
      authorityUtilityKinds: durability.projectAuthority()?.utilityKinds ?? null,
      authorityInheritedJournalPosition: durability.projectAuthority()?.inheritedJournalPosition ?? null,
      commands: durability.snapshot().commands.length,
      journalPosition: durability.snapshot().journalPosition,
    };

    // --- The production admission seam, with the recovery seam under it -----
    let state = null as ReturnType<typeof durability.projectState> | null;
    let recovered = false;
    try {
      const admission = await projectAdmission.ensureFirstProject();
      state = admission.state;
      recovered = admission.status === "RECOVERED";
      report.productionAdmission = {
        status: admission.status,
        evidence: admission.status === "RECOVERED" ? admission.evidence : null,
        gate1SchemaVersion: state.schemaVersion,
        admissionStage: state.tranche.stage,
        executionRecoveryMarkers: state.tranche.executionRecoveryMarkers ?? null,
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
          terminalOutcomeId: task.terminalOutcomeId,
        })),
        journalEntries: state.journal.map((entry) => ({
          id: entry.id,
          skill: entry.skill,
          execution: entry.execution,
          commandId: entry.commandId,
        })),
        persistedInMemoryOnly: durableStorage.value() !== undefined,
        liveStoreUntouched: true,
      };
    } catch (error) {
      report.productionAdmission = {
        status: "REFUSED",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // --- The water slice at the original production boundary ----------------
    if (state && state.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION) {
      const overview = record(parseV2McpJson(await client.callTool({ name: "cs2_city_overview", arguments: {} })));
      const treasury = Number(overview.treasury);
      report.treasury = Number.isFinite(treasury) ? treasury : null;

      const deliveredRoad = certifyDeliveredRoad({ state, world: activation.world, journal: durability.commandJournal });
      report.certifiedRoad = {
        status: deliveredRoad.status,
        target: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.target : null,
        refs: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.refs : null,
        reason: deliveredRoad.status === "CERTIFIED" ? null : deliveredRoad.reason,
      };

      if (deliveredRoad.status === "CERTIFIED" && Number.isFinite(treasury)) {
        const firstFacilityPlacement = firstFacilityPlacementDurability(
          durability.utilityPlacementOperations({
            projectId: state.project.id,
            trancheId: state.tranche.id,
            reservationRef: state.tranche.reservationRef,
            utilityKind: "water",
          }),
        );
        const preparation = buildUtilityPreparationInput({
          state,
          world: activation.world,
          treasury,
          kind: "water",
          certifiedRoad: deliveredRoad.target,
          certifiedRoadRefs: deliveredRoad.refs,
          firstFacilityPlacement,
        });
        report.waterAdmission = {
          kind: preparation.kind,
          recipe: preparation.facilityPlacementAuthorization?.recipe ?? null,
          maximumPlacements: preparation.facilityPlacementAuthorization?.maximumPlacements ?? null,
          targetRoad: preparation.facilityPlacementAuthorization?.targetRoad ?? null,
          spatialEnvelope: preparation.spatialEnvelope,
          maximumSpend: preparation.maximumSpend,
          firstFacilityPlacement,
        };
        const prepared = await ports.greenfieldUtilityBootstrap.prepare(preparation);
        report.waterPreflight = {
          status: prepared.status,
          reason: "reason" in prepared ? prepared.reason : null,
          mode: "mode" in prepared ? prepared.mode : null,
          planKind: "plan" in prepared && prepared.plan ? prepared.plan.kind : null,
          planPrefab: "plan" in prepared && prepared.plan ? prepared.plan.prefab : null,
          planPosition: "plan" in prepared && prepared.plan ? prepared.plan.position : null,
          connectionPrefab:
            "plan" in prepared && prepared.plan && prepared.plan.connection ? prepared.plan.connection.prefab : null,
          constructionCost: "plan" in prepared && prepared.plan ? prepared.plan.constructionCost : null,
          expectedCapacity: "plan" in prepared && prepared.plan ? prepared.plan.expectedCapacity : null,
          targetServiceEntry: "targetServiceEntry" in prepared ? prepared.targetServiceEntry : null,
          targetSemantics: "targetSemantics" in prepared ? prepared.targetSemantics ?? null : null,
        };
        // A blocked preparation reports its cause through diagnostics rather than
        // its `reason`, which is a coarse bucket. The raw payload is kept whole so
        // the refusal can be diagnosed without re-running the preflight.
        report.waterPreflightRaw = prepared;
      }
    }

    // --- Read-only proof ----------------------------------------------------
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
    if (nativeMutationCalls.length > 0) throw new Error("WATER_PREFLIGHT_EXECUTED_A_NATIVE_MUTATION");
    if (!report.liveStoreUnchanged) throw new Error("WATER_PREFLIGHT_WROTE_TO_THE_LIVE_STORE");
    if (!(report.durableStoreAfter as { commandsUnchanged: boolean }).commandsUnchanged) {
      throw new Error("WATER_PREFLIGHT_ADDED_A_DURABLE_COMMAND");
    }
    report.verdict = {
      GATE1_AUTHORITY_RECOVERED: recovered ? "YES" : "NO",
      LIVE_GATE1_STATE: state ? `${state.schemaVersion}:${state.tranche.stage}` : "NONE",
      LIVE_WATER_PREFLIGHT: report.waterPreflight ? (report.waterPreflight as { status: string }).status : "NOT_REACHED",
      NATIVE_MUTATIONS: nativeMutationCalls.length,
    };
  } catch (error) {
    report.failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      nativeMutationCalls: calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name)).map((call) => call.name),
    };
  } finally {
    report.callLog = calls.map((call) => call.name);
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
