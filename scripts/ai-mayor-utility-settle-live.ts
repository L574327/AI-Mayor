/** Run exactly one production utility reconciliation pass; no Brain tick or simulation wait. */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts } from "../src/main/services/ai-mayor/main-adapters";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { MayorRuntime } from "../src/main/services/ai-mayor/runtime";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Obj : {};
const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const reportPath = process.env.AI_MAYOR_UTILITY_EVIDENCE ?? "docs/ai-mayor/evidence/zoning-marquee-utility-settle-live-2026-09-29.json";
const storage = createCanonicalDurableStateStorage(process.env.APPDATA);
const client = new Client({ name: "5ire-ai-mayor-utility-settle", version: "1.0.0" });
const counts: Record<string, number> = {};
const calls: Array<{ name: string; args: Obj }> = [];
const limits: Record<string, number> = {
  cs2_build_road: 4, cs2_place_building: 1, cs2_zone_area: 0, cs2_zoning: 0,
  cs2_mayor_execute_actions: 8, cs2_run_simulation: 0, cs2_save_game: 0,
};

async function main() {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const call = async (name: string, args: Obj = {}, signal?: AbortSignal) => {
    if (["cs2_load_game", "cs2_rollback", "cs2_run_simulation", "cs2_save_game", "cs2_zone_area", "cs2_zoning"].includes(name)) {
      throw new Error(`UTILITY_SETTLE_FORBIDS_TOOL:${name}`);
    }
    if (name in limits) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (counts[name] > limits[name]) throw new Error(`UTILITY_SETTLE_BUDGET_EXCEEDED:${name}`);
    }
    if (name === "cs2_mayor_execute_actions") {
      const actions = Array.isArray(args.actions) ? args.actions.map(obj) : [];
      if (actions.some((action) => !["build_road", "place_building"].includes(String(action.type)))) {
        throw new Error("UTILITY_SETTLE_FORBIDS_NON_UTILITY_ACTION");
      }
    }
    calls.push({ name, args });
    return parseV2McpJson(await client.callTool({ name, arguments: args }, undefined, { signal }));
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Obj }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await call(name, args)) }],
    }),
  };
  const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager as never,
    durableStateStorage: storage, emit: () => {}, gate1MaximumDecisions: 4 });
  if (!ports.v2Gate1Progression || !ports.v2ProductionSkillRuntime) throw new Error("PRODUCTION_V2_PORTS_UNAVAILABLE");
  ports.save = async () => { throw new Error("UTILITY_SETTLE_FORBIDS_SAVE"); };
  const runtime = new MayorRuntime(ports);
  try {
    const beforeGame = obj(await call("cs2_game_state"));
    const beforeWorld = obj(beforeGame.world);
    const beforeSimulation = obj(beforeGame.simulation);
    if (beforeGame.gameMode !== "Game" || beforeGame.cityLoaded !== true || beforeGame.isLoading !== false ||
      beforeWorld.worldReady !== true || beforeWorld.nativeOperationBusy !== false || beforeWorld.nativeOperationStage !== "Idle" ||
      beforeSimulation.paused !== true) throw new Error("UTILITY_SETTLE_WORLD_NOT_PAUSED_READY_AND_IDLE");
    const beforeState = storage.load();
    runtime.start({ goal: "Reconcile current utility service", maxSessionSpend: 10, minimumBalance: 0,
      decisionMode: "local", continuous: false, tickDelayMs: 0 });
    const settlement = await ports.v2Gate1Progression.settleUtilityGoals(new AbortController().signal);
    const afterState = storage.load();
    const afterGame = obj(await call("cs2_game_state"));
    const report = {
      schemaVersion: "ai-mayor-utility-settle-live/1", serverPath,
      startedAt: new Date().toISOString(),
      worldBefore: { worldId: beforeWorld.worldId, generation: beforeWorld.generation,
        paused: beforeSimulation.paused, frameIndex: beforeSimulation.frameIndex },
      settlement,
      durableBefore: { journalPosition: beforeState?.journalPosition,
        activeGoalWorkOrderId: beforeState?.activeGoalWorkOrderId },
      durableAfter: { journalPosition: afterState?.journalPosition,
        activeGoalWorkOrderId: afterState?.activeGoalWorkOrderId },
      worldAfter: { worldId: obj(afterGame.world).worldId, generation: obj(afterGame.world).generation,
        paused: obj(afterGame.simulation).paused, frameIndex: obj(afterGame.simulation).frameIndex },
      nativeCallCounts: counts, nativeCalls: calls,
      finishedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ reportPath, settlement, nativeCallCounts: counts, durableAfter: report.durableAfter })}\n`);
  } finally {
    await client.close().catch(() => {});
  }
}
void main().catch((error) => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
