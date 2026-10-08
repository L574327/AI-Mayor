/**
 * One-shot production recovery of a RoadConnection excluded by the currently
 * loaded durable checkpoint, followed by read-only Water Planner preflight.
 *
 * This script does not edit historical commands. Gate1 progression observes
 * the old command in the loaded world, records its absence through the existing
 * durable observer, and creates a fresh operation through the ordinary
 * Admission -> Road Kernel -> Bridge path.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts } from "../src/main/services/ai-mayor/main-adapters";
import {
  createV2FoundationPorts,
  parseV2McpJson,
  netCourseCovered,
} from "../src/main/services/ai-mayor/v2/main-adapter";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION } from "../src/main/services/ai-mayor/v2/durability";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { firstFacilityPlacementDurability } from "../src/main/services/ai-mayor/v2/utility-placement-durability";

type Obj = Record<string, unknown>;
const record = (value: unknown): Obj => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Obj : {};
const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.ROAD_CHECKPOINT_RECOVERY_EVIDENCE ?? "docs/ai-mayor/evidence/road-checkpoint-recovery-live.json";

async function main() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA_NOT_SET");
  const client = new Client({ name: "5ire-ai-mayor-road-checkpoint-recovery", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: Array<{ name: string; args: Obj }> = [];
  const callTool = async (name: string, args: Obj = {}, signal?: AbortSignal) => {
    calls.push({ name, args });
    return parseV2McpJson(await client.callTool({ name, arguments: args }, undefined, { signal }));
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Obj }) => ({
      content: [{ type: "text", text: JSON.stringify(await callTool(name, args)) }],
    }),
  };
  const storage = createCanonicalDurableStateStorage(appData);
  const before = storage.load();
  if (!before) throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  const report: Obj = { serverPath, mode: "ONE_ROAD_MUTATION_THEN_READ_ONLY_WATER_PREFLIGHT" };
  try {
    const gameState = await callTool("cs2_game_state");
    const game = record(gameState); const world = record(game.world); const simulation = record(game.simulation);
    report.loadedWorld = {
      worldId: world.worldId ?? null, generation: world.generation ?? null,
      checkpointId: world.checkpointId ?? null, paused: simulation.paused ?? null,
      worldReady: world.worldReady ?? null,
    };
    if (game.gameMode !== "Game" || game.cityLoaded !== true || game.isLoading !== false || world.worldReady !== true || simulation.paused !== true) {
      throw new Error("LIVE_WORLD_NOT_READY_AND_PAUSED");
    }

    const checkpointId = typeof world.checkpointId === "string" ? world.checkpointId : "";
    const checkpoint = before.checkpoints.find((entry) => entry.worldId === world.worldId && entry.checkpointId === checkpointId);
    if (!checkpoint || !checkpoint.durable) throw new Error("CURRENT_CHECKPOINT_CUT_UNAVAILABLE");
    report.CURRENT_ACTIVE_JOURNAL_CUT = checkpoint.journalPosition;
    const futureRoads = before.commands.filter((entry) =>
      entry.worldId === checkpoint.worldId && entry.baseCheckpointId === checkpoint.checkpointId &&
      entry.position > checkpoint.journalPosition && entry.record.actionFamily === "ROAD" &&
      entry.record.authorizedScope.owner.ownerType === "TASK" &&
      entry.record.authorizedScope.owner.ownerId.endsWith(":task:road_connection") &&
      (entry.outcome === "OBSERVED_MATCH" || entry.outcome === "NATIVE_COMPLETED" || entry.outcome === "APPLIED"),
    ).sort((left, right) => right.position - left.position);
    if (futureRoads.length === 0) throw new Error("POST_CHECKPOINT_ROAD_TASK_OPERATION_MISSING");
    const oldCommand = futureRoads[0];
    if (!oldCommand) throw new Error("POST_CHECKPOINT_ROAD_TASK_OPERATION_MISSING");
    report.postCheckpointRoadOperationCount = futureRoads.length;
    const oldCommandSnapshot = structuredClone(oldCommand);
    const exactInput = record(oldCommand.record.authorizedScope).exactInput;
    if (typeof exactInput !== "string") throw new Error("HISTORICAL_ROAD_AUTHORIZED_INPUT_MISSING");
    const oldInput = JSON.parse(exactInput) as Obj;
    const prefab = String(oldInput.prefab ?? "");
    const start = { x: Number(oldInput.x1), z: Number(oldInput.z1) };
    const end = { x: Number(oldInput.x2), z: Number(oldInput.z2) };
    if (!prefab || ![start.x, start.z, end.x, end.z].every(Number.isFinite)) throw new Error("HISTORICAL_ROAD_GEOMETRY_UNAVAILABLE");
    report.oldRoadCommandId = oldCommand.record.commandId;
    report.historicalRoadPosition = oldCommand.position;

    // Verify the exact historical road course against a complete current-world
    // listing before granting the production progression a chance to recover.
    const listed = record(await callTool("cs2_list_roads", {
      query: prefab, x: (start.x + end.x) / 2, z: (start.z + end.z) / 2,
      radius: Math.max(64, Math.hypot(end.x - start.x, end.z - start.z) + 16), limit: 500,
    }));
    if (listed.truncated === true || listed.hasMore === true || listed.complete === false || !Array.isArray(listed.roads)) {
      throw new Error("CURRENT_WORLD_ROAD_LIST_INCOMPLETE");
    }
    const edges = listed.roads.map((raw) => {
      const row = record(raw); const a = record(row.start); const b = record(row.end);
      return { prefab: String(row.prefab ?? ""), start: { x: Number(a.x), z: Number(a.z) }, end: { x: Number(b.x), z: Number(b.z) } };
    }).filter((edge) => [edge.start.x, edge.start.z, edge.end.x, edge.end.z].every(Number.isFinite));
    const historicalEffectPresent = netCourseCovered({ edges, prefab, start, end, tolerance: 0.75 });
    report.currentWorldRequiredRoadEffectPresent = historicalEffectPresent ? "YES" : "NO";
    report.roadEffectAuthoritativeWitness = {
      source: "complete cs2_list_roads current-world readback",
      prefab, start, end, matchingCoursePresent: historicalEffectPresent,
      returned: edges.length, totalMatches: listed.totalMatches ?? listed.returned ?? null,
    };
    if (historicalEffectPresent) throw new Error("HISTORICAL_ROAD_EFFECT_PRESENT_RECOVERY_NOT_APPLICABLE");
    if (process.argv.includes("--check-only")) {
      const readOnlyPorts = createV2FoundationPorts({
        getToolsManager: () => manager as never,
        durableStateStorage: createMemoryDurableStateStorage(before),
      });
      const readOnlyDurability = readOnlyPorts.durability;
      if (!readOnlyDurability || !readOnlyPorts.observeCurrentWorldCommandEffect) throw new Error("READ_ONLY_DURABILITY_PROBE_UNAVAILABLE");
      const readOnlyActivation = readOnlyDurability.activate(gameState);
      report.readOnlyDurableActivation = {
        status: readOnlyActivation.status, blockedReason: readOnlyActivation.blockedReason,
        durablyActivated: readOnlyDurability.isExecutionDurablyActivated(readOnlyActivation),
      };
      if (readOnlyDurability.isExecutionDurablyActivated(readOnlyActivation)) {
        const observation = await readOnlyPorts.observeCurrentWorldCommandEffect(oldCommand.record.commandId);
        report.productionRoadEffectObservation = observation.effect;
      }
      report.verdict = { CURRENT_WORLD_REQUIRED_ROAD_EFFECT_PRESENT: "NO", CHECK_ONLY: "PASS", MUTATIONS: 0 };
      return;
    }

    const activationPorts = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: storage,
    });
    const activationDurability = activationPorts.durability;
    if (!activationDurability) throw new Error("PRODUCTION_DURABILITY_NOT_CONFIGURED");
    const checkpointActivation = activationDurability.activate(gameState);
    if (!activationDurability.isExecutionDurablyActivated(checkpointActivation)) {
      throw new Error(`CHECKPOINT_ACTIVATION_NOT_DURABLE:${checkpointActivation.status}:${checkpointActivation.blockedReason ?? ""}`);
    }
    const activeCheckpointCut = activationDurability.activeCheckpointJournalPosition();
    const activeProject = activationDurability.projectState();
    report.checkpointActivation = {
      kind: checkpointActivation.kind,
      status: checkpointActivation.status,
      CURRENT_ACTIVE_JOURNAL_CUT: activeCheckpointCut,
      projectStateSchema: activeProject.schemaVersion,
      POST_CHECKPOINT_ROAD_STATE_ACTIVE: activeProject.schemaVersion !== V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION,
      POST_CHECKPOINT_WATER_STATE_ACTIVE: activeProject.schemaVersion !== V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION,
    };
    if (activeCheckpointCut !== checkpoint.journalPosition) throw new Error("ACTIVE_CHECKPOINT_CUT_MISMATCH");
    if (activeProject.schemaVersion !== V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION) {
      throw new Error("POST_CHECKPOINT_PROJECT_STATE_REMAINS_ACTIVE");
    }
    const roadAfterActivation = activationDurability.snapshot().commands.find((entry) => entry.record.commandId === oldCommand.record.commandId);
    if (JSON.stringify(roadAfterActivation) !== JSON.stringify(oldCommandSnapshot)) throw new Error("HISTORICAL_ROAD_OPERATION_CHANGED_DURING_ACTIVATION");

    const roadsBefore = Number(listed.totalMatches ?? listed.returned);
    if (!Number.isFinite(roadsBefore)) throw new Error("CURRENT_WORLD_ROAD_COUNT_UNKNOWN");
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager as never,
      durableStateStorage: storage,
      emit: () => {},
      gate1MaximumDecisions: 2,
    });
    if (!ports.v2ProductionSkillRuntime) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_CONFIGURED");
    ports.v2ProductionSkillRuntime.initialize();
    const projectAdmission = await ports.v2ProductionSkillRuntime.ensureProjectAdmission();
    const admittedState = record(projectAdmission).state;
    report.productionProjectAdmission = {
      status: record(projectAdmission).status ?? null,
      schemaVersion: record(admittedState).schemaVersion ?? null,
      projectId: record(record(admittedState).project).id ?? null,
      trancheStage: record(record(admittedState).tranche).stage ?? null,
    };
    if (record(admittedState).schemaVersion !== "ai-mayor-v2-gate1-state/2") {
      throw new Error("FRESH_ROAD_PLAN_NOT_ADMITTED");
    }
    if (!ports.v2Gate1Progression) throw new Error("V2_PRODUCTION_GATE1_PROGRESSION_NOT_CONFIGURED");
    const progression = await ports.v2Gate1Progression.advanceToStage("ROAD_DELIVERED");
    report.progression = {
      status: progression.status, stage: progression.stage, decisions: progression.decisions,
      roadCommandCount: progression.roadCommandCount, reason: progression.reason,
      markers: progression.state?.tranche.executionRecoveryMarkers ?? null,
    };
    if (progression.status !== "MILESTONE_REACHED" || progression.stage !== "ROAD_DELIVERED" || !progression.state) {
      throw new Error(`ROAD_RECOVERY_PIPELINE_DID_NOT_REACH_DELIVERED:${progression.reason}`);
    }

    const freshStorage = createCanonicalDurableStateStorage(appData);
    const after = freshStorage.load();
    if (!after) throw new Error("DURABLE_STATE_MISSING_AFTER_ROAD_RECOVERY");
    const oldAfter = after.commands.find((entry) => entry.record.commandId === oldCommand.record.commandId);
    report.oldRoadOperationUnchanged = JSON.stringify(oldAfter) === JSON.stringify(oldCommandSnapshot);
    if (report.oldRoadOperationUnchanged !== true) throw new Error("HISTORICAL_ROAD_OPERATION_CHANGED");
    const finalState = progression.state;
    const roadTask = finalState.tasks.find((task) => task.kind === "ROAD_CONNECTION");
    const roadTerminal = roadTask?.terminalOutcomeId ? finalState.journal.find((entry) => entry.id === roadTask.terminalOutcomeId) : undefined;
    if (!roadTerminal?.commandId || roadTerminal.commandId === oldCommand.record.commandId) throw new Error("NEW_ROAD_RECOVERY_OPERATION_MISSING");
    const roadRecord = after.commands.find((entry) => entry.record.commandId === roadTerminal.commandId);
    report.newRoadOperation = roadRecord ? {
      commandId: roadRecord.record.commandId, status: roadRecord.record.status,
      reconciliationStatus: roadRecord.record.reconciliationStatus, position: roadRecord.position,
      worldId: roadRecord.worldId, baseCheckpointId: roadRecord.baseCheckpointId,
    } : null;
    if (!roadRecord || roadRecord.record.status !== "OBSERVED_MATCH" || roadRecord.record.reconciliationStatus !== "MATCH") {
      throw new Error("NEW_ROAD_OPERATION_NOT_TERMINAL_MATCH");
    }

    const newExactInput = record(roadRecord.record.authorizedScope).exactInput;
    if (typeof newExactInput !== "string") throw new Error("NEW_ROAD_AUTHORIZED_INPUT_MISSING");
    const newInput = JSON.parse(newExactInput) as Obj;
    const newStart = { x: Number(newInput.x1), z: Number(newInput.z1) };
    const newEnd = { x: Number(newInput.x2), z: Number(newInput.z2) };
    const roadAfter = record(await callTool("cs2_list_roads", {
      query: String(newInput.prefab ?? prefab), x: (newStart.x + newEnd.x) / 2, z: (newStart.z + newEnd.z) / 2,
      radius: Math.max(64, Math.hypot(newEnd.x - newStart.x, newEnd.z - newStart.z) + 16), limit: 500,
    }));
    if (roadAfter.truncated === true || roadAfter.hasMore === true || roadAfter.complete === false || !Array.isArray(roadAfter.roads)) {
      throw new Error("POST_ROAD_WORLD_LIST_INCOMPLETE");
    }
    const roadCountAfter = Number(roadAfter.totalMatches ?? roadAfter.returned);
    report.roadCountDelta = Number.isFinite(roadCountAfter) ? roadCountAfter - roadsBefore : null;
    const afterEdges = roadAfter.roads.map((raw) => {
      const row = record(raw); const a = record(row.start); const b = record(row.end);
      return { prefab: String(row.prefab ?? ""), start: { x: Number(a.x), z: Number(a.z) }, end: { x: Number(b.x), z: Number(b.z) } };
    }).filter((edge) => [edge.start.x, edge.start.z, edge.end.x, edge.end.z].every(Number.isFinite));
    const currentRoadPresent = netCourseCovered({ edges: afterEdges, prefab: String(newInput.prefab ?? prefab), start: newStart, end: newEnd, tolerance: 0.75 });
    report.roadDeliveredCurrentWorld = currentRoadPresent;
    if (!currentRoadPresent) throw new Error("NEW_ROAD_NOT_PRESENT_IN_AUTHORITATIVE_WORLD_READBACK");

    // Reload current durable state and bind its road certificate to the exact
    // current world before invoking the existing Water preparation boundary.
    const readPorts = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: freshStorage });
    const afterGameState = await callTool("cs2_game_state");
    const postRoadActivation = readPorts.durability!.activate(afterGameState);
    if (!readPorts.durability!.isExecutionDurablyActivated(postRoadActivation)) throw new Error(`POST_ROAD_WORLD_NOT_DURABLY_ACTIVATED:${postRoadActivation.status}`);
    const deliveredRoad = certifyDeliveredRoad({ state: finalState, world: postRoadActivation.world, journal: readPorts.durability!.commandJournal });
    if (deliveredRoad.status !== "CERTIFIED") throw new Error(`ROAD_CURRENT_LINEAGE_CERTIFICATION_FAILED:${deliveredRoad.reason}`);
    const overview = record(await callTool("cs2_city_overview"));
    const treasury = Number(overview.treasury);
    if (!Number.isFinite(treasury)) throw new Error("CURRENT_TREASURY_UNKNOWN");
    const firstPlacement = firstFacilityPlacementDurability(readPorts.durability!.utilityPlacementOperations({
      projectId: finalState.project.id, trancheId: finalState.tranche.id,
      reservationRef: finalState.tranche.reservationRef, utilityKind: "water",
    }));
    const preparation = buildUtilityPreparationInput({
      state: finalState, world: postRoadActivation.world, treasury, kind: "water",
      certifiedRoad: deliveredRoad.target, certifiedRoadRefs: deliveredRoad.refs,
      firstFacilityPlacement: firstPlacement,
    });
    const prepared = await readPorts.greenfieldUtilityBootstrap.prepare(preparation);
    const plan = record(record(prepared).plan);
    const diagnostics = record(record(prepared).diagnostics);
    const selectedConnection = record(plan.connection);
    report.waterPlannerPreflight = {
      status: prepared.status,
      reason: "reason" in prepared ? prepared.reason : null,
      WATER_CANDIDATE_COUNT: diagnostics.waterCandidateCount ?? null,
      SUPPORTED_WATER_CANDIDATE_COUNT: diagnostics.supportedWaterCandidateCount ?? null,
      SELECTED_WATER_TOPOLOGY: prepared.status === "READY" ? {
        facilityPrefab: plan.prefab ?? null, position: plan.position ?? null,
        connectionPrefab: selectedConnection.prefab ?? null, connection: plan.connection ?? null,
      } : null,
      SELECTED_BY_PLANNER: prepared.status === "READY",
      SPECIAL_CASE_USED: "NO",
      firstFacilityPlacement: firstPlacement,
      diagnostics,
    };

    const mutationCalls = calls.filter((call) => ["cs2_build_road", "cs2_mayor_execute_actions", "cs2_build", "cs2_place_building", "cs2_bulldoze", "cs2_zone"].includes(call.name));
    report.nativeMutationCalls = mutationCalls.map((call) => call.name);
    report.finalNativeMutationCount = mutationCalls.filter((call) => call.name === "cs2_build_road").length;
    if (report.finalNativeMutationCount !== 1 || mutationCalls.some((call) => call.name !== "cs2_build_road")) throw new Error("NATIVE_MUTATION_BUDGET_OR_SCOPE_VIOLATION");
    report.currentLineageReconciliation = "PASS";
    report.verdict = {
      ROAD_RECOVERY_OPERATION_CREATED: "YES", ROAD_PREREQUISITE_REBUILT: "YES",
      ROAD_DELIVERED_CURRENT_WORLD: "YES", OLD_ROAD_OPERATION_UNCHANGED: "YES",
      FINAL_NATIVE_MUTATION_COUNT: report.finalNativeMutationCount,
      WATER_PLANNER_PREFLIGHT_REACHED: "YES",
      WATER_READY_FOR_NATIVE_MUTATION: prepared.status === "READY" ? "YES" : "NO",
    };
  } finally {
    report.callLog = calls.map((call) => call.name);
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
