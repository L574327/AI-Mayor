import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts, parseMcpJson } from "../src/main/services/ai-mayor/main-adapters";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = path.resolve(
  process.env.SAVE_SAFETY_EVIDENCE ?? "docs/ai-mayor/evidence/save-safety-runtime-validation-2026-09-13.json",
);

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-save-safety-validation", version: "1.0.0" });
  await client.connect(transport);
  const calls: Array<{ name: string; arguments: Record<string, unknown>; result: unknown }> = [];
  const listed = await client.listTools();
  const manager = {
    legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `t_save--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: input }: { name: string; arguments: Record<string, unknown> }) => {
      const result = await client.callTool({ name, arguments: input });
      let parsed: unknown;
      try {
        parsed = parseMcpJson(result);
      } catch {
        parsed = { parseError: true };
      }
      calls.push({ name, arguments: input, result: parsed });
      return result;
    },
  };
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    serverPath,
    gameplayMutations: 0,
    gate1: "NOT_RUN",
    road: "NOT_RUN",
    zoning: "NOT_RUN",
  };
  try {
    const gameState = object(parseMcpJson(await client.callTool({ name: "cs2_game_state", arguments: {} })));
    const aggregate = object(parseMcpJson(await client.callTool({ name: "cs2_save_status", arguments: {} })));
    report.runtime = {
      gameMode: gameState.gameMode,
      cityLoaded: gameState.cityLoaded,
      isLoading: gameState.isLoading,
      paused: gameState.paused ?? object(gameState.simulation).paused,
      runtimeEpoch: gameState.runtimeEpoch,
      worldId: gameState.worldId,
      worldGeneration: gameState.generation,
    };
    report.initialSaveStatus = aggregate;
    if (aggregate.state !== "IDLE") {
      report.verdict = "STOP_INITIAL_SAVE_NOT_IDLE";
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2));
      return;
    }

    const storage = createMemoryDurableStateStorage();
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
      durableStateStorage: storage,
    });
    const saveName = `AI Mayor V2 Save Safety Validation ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    report.saveName = saveName;
    try {
      await ports.save(saveName);
      report.save = "PASS";
    } catch (error) {
      report.save = error instanceof Error && error.message.includes("SAVE_COMPLETION_UNKNOWN") ? "TIMEOUT" : "FAIL";
      report.error = error instanceof Error ? error.message : String(error);
    }
    const terminalStatusCall = calls
      .filter((call) => call.name === "cs2_save_status" && call.arguments.requestId !== undefined)
      .at(-1);
    const finalAggregate = object(parseMcpJson(await client.callTool({ name: "cs2_save_status", arguments: {} })));
    report.requestId = object(calls.find((call) => call.name === "cs2_save_game")?.result).saveRequestId ?? null;
    report.nativeStatusSequence = calls
      .filter((call) => call.name === "cs2_save_status")
      .map((call) => call.result);
    report.terminalStatus = terminalStatusCall?.result ?? null;
    report.finalAggregateSaveStatus = finalAggregate;
    report.durableState = storage.value();
    report.durableCheckpoint = object(storage.value()).checkpoints ?? [];
    report.singleFlightRuntimeEvidence = "COMPOSITE_STATIC_PLUS_RUNTIME_IDLE_IN_FLIGHT_CONTRACT";
    report.verdict = report.save === "PASS" ? "PASS" : report.save;
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
