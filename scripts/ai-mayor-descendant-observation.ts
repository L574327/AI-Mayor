/**
 * Descendant-lineage observation against the LIVE durable store.
 *
 * This script performs authoritative native READS only. It never submits a
 * native mutation: it does not save, does not dispatch a Skill, and does not
 * call `prepare()` or `run()`. It stops one step *before* the recovery save
 * that `ensureDurableWorld()` would take, so `certifyDescendantCheckpoint()`
 * is deliberately not reached and write authority stays blocked.
 *
 * Everything it uses is the production seam — `createV2FoundationPorts`,
 * `durability.activate()`, `observeCurrentWorldCommandEffect()` (the formal
 * append-only current-world observation API) and
 * `durability.confirmDescendantSaveReload()` — composed explicitly instead of
 * through `activateDurableWorld()` for exactly one reason: the production
 * composition continues into a native save, and this round forbids native
 * mutation.
 *
 * The Electron app must not have a running Mayor session while this executes,
 * because the overlay polls `ai-mayor-production-skill-resume`, and the live
 * durable state holds an unfinished utility operation that would dispatch K05.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const appData = process.env.APPDATA ?? "";
const oldCommandId = process.env.AI_MAYOR_OBSERVE_COMMAND ?? "fa032a75-9676-44da-828b-1951f670a74e";

/** Native tools that mutate the world. Any of these in the call log fails the run. */
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
  if (!appData) throw new Error("APPDATA is not set");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-v2-descendant-observation", version: "1.0.0" });
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

  const report: Record<string, unknown> = { serverPath, appData, mode: "READ_ONLY_WORLD_APPEND_ONLY_DURABLE" };
  try {
    const storage = createCanonicalDurableStateStorage(appData);
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: storage,
    });
    const durability = ports.durability;
    if (!durability || !ports.observeCurrentWorldCommandEffect) {
      throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    }

    const gameState = parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
    const game = record(gameState);
    const world = record(game.world);
    const simulation = record(game.simulation);
    report.world = {
      worldId: world.worldId ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null,
      loadPurpose: world.loadPurpose ?? null,
      loadAssetGuid: world.loadAssetGuid ?? null,
      saveDataAssetGuid: world.saveDataAssetGuid ?? null,
      checkpointId: world.checkpointId ?? null,
      generation: world.generation ?? null,
      bridgeRuntimeEpoch: world.bridgeRuntimeEpoch ?? null,
      paused: simulation.paused ?? null,
      nativeOperationBusy: world.nativeOperationBusy ?? null,
      nativeOperationStage: world.nativeOperationStage ?? null,
    };
    if (game.gameMode !== "Game" || game.cityLoaded !== true || simulation.paused !== true) {
      throw new Error("LIVE_WORLD_NOT_READY");
    }

    const before = durability.snapshot();
    report.before = {
      journalPosition: before.journalPosition,
      commands: before.commands.length,
      checkpoints: before.checkpoints.length,
      baselineActivation: before.baselineActivation ?? null,
      projectState: before.projectState,
    };

    const activation = durability.activate(gameState);
    report.activation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason,
      worldId: activation.world.worldId,
      worldEpochId: activation.world.worldEpochId,
      nativeSessionGuid: activation.world.nativeSessionGuid,
    };

    const pending = durability.pendingDescendantCommands() ?? [];
    report.pendingDescendantCommands = pending;
    if (activation.status !== "DESCENDANT_CONFIRMATION_REQUIRED") {
      report.stopped = "activation did not require descendant confirmation; nothing was observed or confirmed";
      return;
    }

    // The formal append-only observation API, for every command the lineage must
    // prove — including the historical cable command, whose execution-time
    // verdict stays untouched.
    const effects = [];
    for (const entry of pending) {
      const { effect, observation } = await ports.observeCurrentWorldCommandEffect(entry.commandId);
      effects.push(effect);
      report[`observation:${entry.commandId}`] = {
        historicalVerdict: observation.historicalVerdict,
        currentWorldEffectPresent: observation.currentWorldEffectPresent,
        currentWorldObjectiveSatisfied: observation.currentWorldObjectiveSatisfied,
        evidence: observation.evidence,
        isOldCommand: entry.commandId === oldCommandId,
      };
    }
    report.effects = effects;

    const reconstruction = durability.confirmDescendantSaveReload({
      worldId: activation.world.worldId,
      worldEpochId: activation.world.worldEpochId,
      nativeSessionGuid: activation.world.nativeSessionGuid,
      effects,
    });
    report.reconstruction = reconstruction;

    const after = durability.snapshot();
    report.after = {
      journalPosition: after.journalPosition,
      commands: after.commands.length,
      checkpoints: after.checkpoints.length,
      baselineActivation: after.baselineActivation ?? null,
      projectState: after.projectState,
      projectAuthority: after.projectAuthority ?? null,
      certifiedRollbackAnchor: after.certifiedRollbackAnchor ?? null,
      worldObservations: (after.worldObservations ?? []).map((entry) => ({
        observationId: entry.observationId,
        commandId: entry.commandId,
        historicalVerdict: entry.historicalVerdict,
        currentWorldEffectPresent: entry.currentWorldEffectPresent,
        currentWorldObjectiveSatisfied: entry.currentWorldObjectiveSatisfied,
      })),
    };
    report.oldCommandAfter = after.commands
      .filter((entry) => entry.record.commandId === oldCommandId)
      .map((entry) => ({
        position: entry.position,
        status: entry.record.status,
        effectAbsenceProven: entry.record.effectAbsenceProven,
        outcome: entry.outcome,
      }));
    report.stopped =
      "stopped before certifyDescendantCheckpoint: no native save, no dispatch, write authority remains blocked";
  } finally {
    report.nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    report.callLog = calls.map((call) => call.name);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`DESCENDANT_OBSERVATION_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
