/** Bounded live proof for one Gate1 PLANNER_INPUT_CHANGED Road successor. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts } from "../src/main/services/ai-mayor/main-adapters";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

type Obj = Record<string, unknown>;
const record = (value: unknown): Obj => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Obj : {};
const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-reconstruction\\mcp-server\\dist\\index.js";
const reportPath = process.env.PLANNER_INPUT_REPLACEMENT_EVIDENCE ?? "docs/ai-mayor/evidence/planner-input-replacement-live.json";

async function main() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const storage = createCanonicalDurableStateStorage(appData);
  const before = storage.load();
  if (!before) throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  const client = new Client({ name: "5ire-ai-mayor-planner-input-replacement", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: Array<{ name: string; args: Obj; result?: unknown }> = [];
  let applyCount = 0;
  const call = async (name: string, args: Obj = {}, signal?: AbortSignal) => {
    const forbidden = new Set(["cs2_save_game", "cs2_load_game", "cs2_rollback", "cs2_place_building", "cs2_demolish", "cs2_zone"]);
    if (forbidden.has(name)) throw new Error(`FORBIDDEN_TOOL:${name}`);
    if (name === "cs2_build_road") {
      applyCount += 1;
      if (applyCount > 1) throw new Error("PLANNER_INPUT_REPLACEMENT_NATIVE_APPLY_BUDGET_EXCEEDED");
    }
    const result = parseV2McpJson(await client.callTool({ name, arguments: args }, undefined, { signal }));
    calls.push({ name, args, result });
    return result;
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Obj }) => ({
      content: [{ type: "text", text: JSON.stringify(await call(name, args)) }],
    }),
  };
  const report: Obj = { mode: "PLANNER_INPUT_CHANGED_SINGLE_ROAD_APPLY", serverPath, applyBudget: 1 };
  try {
    const game = record(await call("cs2_game_state"));
    const world = record(game.world); const simulation = record(game.simulation);
    report.worldBefore = { worldId: world.worldId, generation: world.generation, checkpointId: world.checkpointId,
      ready: world.worldReady, paused: simulation.paused, nativeOperationStage: world.nativeOperationStage };
    if (game.gameMode !== "Game" || game.cityLoaded !== true || game.isLoading !== false || world.worldReady !== true ||
      simulation.paused !== true || world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle") {
      throw new Error("LIVE_WORLD_NOT_PAUSED_READY_AND_IDLE");
    }
    const oldProject = record(before.projectState);
    const oldTranche = record(oldProject.tranche);
    const oldTasks = Array.isArray(oldProject.tasks) ? oldProject.tasks.map(record) : [];
    const oldRoad = oldTasks.find((task) => task.kind === "ROAD_CONNECTION");
    report.oldRoadTaskBefore = oldRoad ? {
      id: oldRoad.id, status: oldRoad.status, attempts: oldRoad.attempts, maximumAttempts: oldRoad.maximumAttempts,
      terminalOutcomeId: oldRoad.terminalOutcomeId, childOperationAmendmentId: oldRoad.childOperationAmendmentId,
    } : null;
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager as never,
      durableStateStorage: storage,
      emit: () => {},
      gate1MaximumDecisions: 4,
    });
    if (!ports.v2Gate1Progression) throw new Error("V2_PRODUCTION_GATE1_PROGRESSION_NOT_CONFIGURED");
    const progression = await ports.v2Gate1Progression.advanceToStage("ROAD_DELIVERED");
    report.progression = { status: progression.status, stage: progression.stage, decisions: progression.decisions,
      reason: progression.reason, roadCommandCount: progression.roadCommandCount };
    report.roadApplyRequests = calls.filter((entry) => entry.name === "cs2_build_road").map((entry) => entry.args);
    report.roadApplyResponses = calls.filter((entry) => entry.name === "cs2_build_road").map((entry) => entry.result);
    report.nativePreviewResponses = calls.filter((entry) => entry.name === "cs2_spatial" && record(entry.args).mode === "preflight")
      .map((entry) => entry.result);
    report.gate1TaskOutcomes = progression.state?.journal.filter((entry) => entry.taskId.includes(":task:road_connection") ||
      progression.state?.tasks.some((task) => task.id === entry.taskId && task.kind === "ROAD_CONNECTION")) ?? [];
    const after = storage.load();
    if (!after) throw new Error("DURABLE_STATE_MISSING_AFTER_PROGRESSION");
    const finalProject = record(after.projectState); const finalTranche = record(finalProject.tranche);
    const finalTasks = Array.isArray(finalProject.tasks) ? finalProject.tasks.map(record) : [];
    report.roadTasksAfter = finalTasks.filter((task) => task.kind === "ROAD_CONNECTION").map((task) => ({
      id: task.id, status: task.status, attempts: task.attempts, maximumAttempts: task.maximumAttempts,
      terminalOutcomeId: task.terminalOutcomeId, childOperationAmendmentId: task.childOperationAmendmentId,
      supersedesTaskId: task.supersedesTaskId, supersessionReason: task.supersessionReason,
      previousExactInputHash: task.previousExactInputHash, newExactInputHash: task.newExactInputHash,
      newMaterialInputHash: task.newMaterialInputHash, replacementKey: task.replacementKey,
    }));
    report.currentRoadTaskId = record(finalTranche.currentTaskIds).ROAD_CONNECTION ?? null;
    const currentRoadTask = finalTasks.find((task) => task.id === report.currentRoadTaskId);
    const amendment = (after.utilityBudgetAmendments ?? []).map(record).find((entry) => entry.amendmentId === currentRoadTask?.childOperationAmendmentId);
    report.currentRoadChild = amendment ? { amendmentId: amendment.amendmentId, exactRoadInput: amendment.exactRoadInput,
      status: amendment.status, executionUseStatus: amendment.executionUseStatus, ownerTaskId: amendment.ownerTaskId,
      replacementKey: amendment.replacementKey } : null;
    report.oldTaskAfter = finalTasks.find((task) => task.id === oldRoad?.id) ?? null;
    if (progression.status === "MILESTONE_REACHED" && progression.stage === "ROAD_DELIVERED" && progression.state) {
      const pump = await call("cs2_building_access", { index: 187607, version: 25 });
      report.pumpBuildingAccess = pump;
      report.nearbyRoadReadback = await call("cs2_spatial", { mode: "detail", x: -224.6353, z: 1298.0, radius: 100, resolution: 32 });
      const pumpRecord = record(pump); const attachment = record(pumpRecord.roadAttachment);
      if (attachment.roadEdge !== null && attachment.roadEdge !== undefined && pumpRecord.noRoadAccessWarning === false &&
        pumpRecord.buildingAccessConnected === true) {
        report.electricityReadback = await call("cs2_utility_connectors", { index: 187607, version: 25 });
      }
    }
    report.toolCalls = calls.map(({ name, args }) => ({ name, args }));
    report.applyCount = applyCount;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ reportPath, progression: report.progression, applyCount, currentRoadTaskId: report.currentRoadTaskId })}\n`);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
