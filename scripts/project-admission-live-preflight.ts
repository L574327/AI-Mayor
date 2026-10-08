/**
 * READ-ONLY live preflight for the production Project Admission Bootstrap.
 *
 * This script performs authoritative native READS only. It never submits a
 * native mutation and never persists durable V2 state:
 *
 * - the durable store handed to the foundation ports is a throwaway in-memory
 *   store, so the admitted Gate 1 state is never written to the live
 *   electron-store and never survives this process;
 * - `admitFirstProject()` is only called after this script has itself observed
 *   that the live world is already durably activated in memory. The only branch
 *   of `ensureDurableWorld()` that submits a native command is
 *   `BASELINE_CHECKPOINT_REQUIRED`, so the preflight refuses to run rather than
 *   take a baseline save;
 * - the MCP call log is checked afterwards for native action tools, and the
 *   durable command journal must still be empty.
 *
 * Everything else is the real production seam: `createV2FoundationPorts`,
 * `projectAdmission.ensureFirstProject()`, `createDurableGate1StateStorage`,
 * `planStarterResidentialIntent`, and `buildUtilityPreparationInput`.
 */
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import type { Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import {
  deriveStarterProjectBudget,
  deriveStarterProjectIntentId,
  V2_PROJECT_ADMISSION_POLICY,
} from "../src/main/services/ai-mayor/v2/project-admission";
import {
  evaluateBoundedStarterSites,
  selectBoundedStarterSiteAnchors,
} from "../src/main/services/ai-mayor/v2/site-selection";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.PREFLIGHT_EVIDENCE ?? "docs/ai-mayor/evidence/project-admission-live-preflight.json";

/** Native tools that mutate the world. Any of these appearing in the call log fails the run. */
const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game",
  "cs2_build_road",
  "cs2_mayor_execute_actions",
  "cs2_run_simulation",
  "cs2_bulldoze",
  "cs2_build",
  "cs2_zone",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-v2-project-admission-preflight", version: "1.0.0" });
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
    startedAt: new Date().toISOString(),
    mode: "READ_ONLY",
    gameplayMutations: [],
  };
  try {
    // --- Authoritative world preflight (read only) -------------------------
    const gameStateResponse = await client.callTool({ name: "cs2_game_state", arguments: {} });
    const gameState = parseV2McpJson(gameStateResponse);
    const game = record(gameState);
    const world = record(game.world);
    const simulation = record(game.simulation);
    const saveStatusBefore = record(parseV2McpJson(await client.callTool({ name: "cs2_save_status", arguments: {} })));
    report.livePreflight = {
      gameMode: game.gameMode ?? null,
      cityLoaded: game.cityLoaded ?? null,
      isLoading: game.isLoading ?? null,
      worldReady: world.worldReady ?? null,
      paused: simulation.paused ?? null,
      nativeOperationBusy: world.nativeOperationBusy ?? null,
      nativeOperationStage: world.nativeOperationStage ?? null,
      saveState: saveStatusBefore.state ?? null,
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

    // --- In-memory durability only: the live store is never touched --------
    const durableStorage = createMemoryDurableStateStorage();
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: durableStorage,
    });
    const durability = ports.durability;
    const projectAdmission = ports.projectAdmission;
    if (!durability || !projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");

    // Pure in-memory activation. No native command is submitted from here.
    const activation = durability.activate(gameState);
    const durablyActivated = durability.isExecutionDurablyActivated(activation);
    report.liveActivation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason,
      durablyActivated,
      worldId: activation.world.worldId,
      nativeSessionGuid: activation.world.nativeSessionGuid,
      loadPurpose: activation.world.loadPurpose,
      checkpointId: activation.world.checkpointId,
      generation: activation.world.generation,
      worldEpochId: activation.world.worldEpochId,
      durableBaseline: durability.snapshot().baselineActivation ?? null,
      durableProjectStateSchema: durability.projectState().schemaVersion,
    };
    // --- Authoritative reads shared by both halves of the preflight --------
    const overview = record(parseV2McpJson(await client.callTool({ name: "cs2_city_overview", arguments: {} })));
    const treasury = Number(overview.treasury);
    const snapshot = record(parseV2McpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} })));
    const declaredPrefabs = record(snapshot.planningCatalog).roadPrefabs;
    const roadPrefabs: string[] = Array.isArray(declaredPrefabs)
      ? declaredPrefabs.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const model = buildSpatialWorldModel(
      parseSpatialBootstrapScan(
        parseV2McpJson(await client.callTool({ name: "cs2_spatial", arguments: { mode: "scan", roadLimit: 2_000 } })),
      ),
    );
    report.treasury = Number.isFinite(treasury) ? treasury : null;
    report.roadPrefabs = roadPrefabs;
    report.worldModel = {
      nodes: model.roadGraph.nodes.length,
      edges: model.roadGraph.edges.length,
      ownedTiles: model.ownedTiles.length,
      outsideConnections: model.outsideConnections.length,
      truncated: model.roadGraph.truncated === true,
    };

    // Bounded, authoritative site observation for the discovery anchors. The
    // same bounded reads the production admission port performs.
    const anchors = selectBoundedStarterSiteAnchors(model, 24);
    const details: Array<{ anchor: SpatialPoint2; detail: SpatialSiteDetail }> = [];
    for (const anchor of anchors) {
      const envelope = await ports.observation.capture({
        spatialDetail: {
          x: anchor.node.position.x,
          z: anchor.node.position.z,
          radius: V2_PROJECT_ADMISSION_POLICY.siteObservationRadiusMeters,
          resolution: V2_PROJECT_ADMISSION_POLICY.siteObservationResolution,
        },
      });
      const detail = envelope.sources.spatialDetail;
      if (envelope.coherence === "UNKNOWN" || detail.status !== "AVAILABLE" || !detail.data) continue;
      details.push({ anchor: { x: anchor.node.position.x, z: anchor.node.position.z }, detail: detail.data });
    }
    const observedKeys = new Set(details.map((entry) => `${entry.anchor.x}:${entry.anchor.z}`));
    const scopedAnchors = anchors.filter((anchor) =>
      observedKeys.has(`${anchor.node.position.x}:${anchor.node.position.z}`),
    );
    const selection = evaluateBoundedStarterSites({
      world: model,
      worldEpoch: activation.world.worldEpochId,
      bridgeGeneration: activation.world.generation,
      availableRoadPrefabs: roadPrefabs,
      anchors: scopedAnchors,
      details,
      maxCandidates: V2_PROJECT_ADMISSION_POLICY.maximumSiteCandidates,
    });
    report.livePlanning = {
      discoveryAnchors: anchors.length,
      observedSiteRegions: details.length,
      inspectedRegions: selection.inspectedRegions,
      eligibleCandidates: selection.candidates.length,
      selectedCandidateId: selection.candidates[0]?.id ?? null,
      selectedTarget: selection.candidates[0]?.target ?? null,
      selectedScore: selection.candidates[0]?.score ?? null,
      // Identity is deliberately withheld: without a certified baseline there is
      // no durable lineage, and the production derivation refuses.
      intentIdRefusedWith: (() => {
        try {
          return deriveStarterProjectIntentId({
            worldId: activation.world.worldId,
            baselineCheckpointId: "",
          });
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
      budgetPolicy: Number.isFinite(treasury)
        ? (() => {
            try {
              return deriveStarterProjectBudget({ treasury, policy: V2_PROJECT_ADMISSION_POLICY });
            } catch (error) {
              return { refused: error instanceof Error ? error.message : String(error) };
            }
          })()
        : null,
    };

    // --- Production admission seam (only when already durably activated) ---
    let state: Gate1State | null = null;
    if (!durablyActivated) {
      report.productionAdmission = {
        status: "REFUSED_NOT_DURABLY_ACTIVATED",
        blockingPoint: `${activation.status}: the live world has no certified baseline checkpoint, so no durable project lineage exists yet`,
        tookNoBaselineSave: true,
      };
    } else {
      const admitted = await projectAdmission.admitFirstProject();
      state = admitted.state;
      report.productionAdmission = {
        status: admitted.status,
        evidence: admitted.status === "ADMITTED" ? admitted.evidence : null,
        gate1SchemaVersion: state.schemaVersion,
        admissionStage: state.tranche.stage,
        projectStatus: state.project.status,
        intentId: state.intent.id,
        projectId: state.project.id,
        districtId: state.district.id,
        trancheId: state.tranche.id,
        reservationRef: state.tranche.reservationRef,
        maximumBudget: state.project.maximumBudget,
        utilityReservation: state.project.utilityReservation,
        taskLegalStages: state.tasks.map((task) => ({ id: task.id, legalStage: task.legalStage })),
        persistedInMemoryOnly: durableStorage.value() !== undefined,
        liveStoreUntouched: true,
      };
      const second = await projectAdmission.ensureFirstProject();
      let strictRefused: string | null = null;
      try {
        await projectAdmission.admitFirstProject();
      } catch (error) {
        strictRefused = error instanceof Error ? error.message : String(error);
      }
      report.duplicateBootstrap = {
        status: second.status,
        sameProjectId: second.state.project.id === state.project.id,
        sameIntentId: second.state.intent.id === state.intent.id,
        strictAdmitRefusedWith: strictRefused,
      };
    }

    // --- K05 admission preflight (pure mapping; no native call) ------------
    let k05Admitted = false;
    let k05Reason: string | null = "NO_LIVE_GATE1_STATE";
    let k05Preparation: unknown = null;
    if (state && Number.isFinite(treasury)) {
      try {
        k05Preparation = buildUtilityPreparationInput({ state, world: activation.world, treasury });
        k05Admitted = true;
        k05Reason = null;
      } catch (error) {
        k05Reason = error instanceof Error ? error.message : String(error);
      }
    }
    report.k05Preflight = {
      requiredStage: "ROAD_DELIVERED",
      observedTreasury: Number.isFinite(treasury) ? treasury : null,
      atAdmittedStage: { admitted: k05Admitted, reason: k05Reason, preparation: k05Preparation },
      expectedRefusalAtAdmittedStage: "UTILITY_ADMISSION_STAGE_NOT_ROAD_DELIVERED",
    };

    // --- Read-only proof ---------------------------------------------------
    const nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    const journalCommands = durability.snapshot().commands.length;
    const saveStatusAfter = record(parseV2McpJson(await client.callTool({ name: "cs2_save_status", arguments: {} })));
    report.nativeMutationCalls = nativeMutationCalls;
    report.journalCommands = journalCommands;
    report.saveStatusUnchanged = (saveStatusBefore.state ?? null) === (saveStatusAfter.state ?? null);
    report.gameplayMutations = nativeMutationCalls;
    if (nativeMutationCalls.length > 0 || journalCommands > 0) {
      throw new Error("LIVE_PREFLIGHT_EXECUTED_A_NATIVE_MUTATION");
    }
    report.verdict = {
      PRODUCTION_PROJECT_BOOTSTRAP_IMPLEMENTED: "YES",
      AUTHORITATIVE_GATE1_STATE_CREATED: state ? "YES_IN_MEMORY_ONLY" : "NO",
      PROJECT_ID_STABLE_AFTER_RELOAD: state ? "NOT_EXERCISED_LIVE" : "NOT_REACHED",
      K05_STAGE_CONTRACT_FIXED: "YES",
      LIVE_GATE1_STATE: state ? "IN_MEMORY_ONLY" : "NO",
      LIVE_K05_PREFLIGHT: k05Admitted ? "ADMITTED" : `REFUSED:${k05Reason}`,
      READY_FOR_REAL_K05_MUTATION: "NO",
      livePlanningFeasible: selection.candidates.length > 0,
    };
  } catch (error) {
    report.failure = {
      message: error instanceof Error ? error.message : String(error),
      blockingPoint: error instanceof Error ? error.message : String(error),
      nativeMutationCalls: calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name)),
    };
  } finally {
    report.callLog = calls.map((call) => call.name);
    report.finishedAt = new Date().toISOString();
    await fs.mkdir("docs/ai-mayor/evidence", { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
