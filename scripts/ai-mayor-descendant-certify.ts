/**
 * Formal descendant-checkpoint certification against the LIVE durable store.
 *
 * This is the production path — `ports.activateDurableWorld()`, the same
 * composition the app runs — with the default save policy, which never saves the
 * game on the Mayor's own initiative. It performs native READS only: no
 * `cs2_save_game`, no Skill dispatch, no `place_building`, no world mutation of
 * any kind. The script asserts that afterwards and fails the run if any such
 * call appears in the log.
 *
 * It exists because the certified boundary for this world is a save the *user*
 * made. Adopting it has to be proven end to end against the real store, and the
 * only honest way to do that is to run the real path and then read back what it
 * recorded.
 *
 * The Electron app must not have a running Mayor session while this executes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const appData = process.env.APPDATA ?? "";

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
  const client = new Client({ name: "5ire-ai-mayor-v2-descendant-certify", version: "1.0.0" });
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

  const report: Record<string, unknown> = { serverPath, appData, mode: "FORMAL_CERTIFY_READ_ONLY_NATIVE" };
  try {
    const storage = createCanonicalDurableStateStorage(appData);
    // No `automaticRecoverySave`: the default policy is the one under test.
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: storage,
    });
    const durability = ports.durability;
    if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");

    const gameState = record(parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} })));
    const world = record(gameState.world);
    const simulation = record(gameState.simulation);
    report.runtime = {
      gameMode: gameState.gameMode ?? null,
      cityLoaded: gameState.cityLoaded ?? null,
      paused: simulation.paused ?? null,
      worldId: world.worldId ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null,
      loadAssetGuid: world.loadAssetGuid ?? null,
      saveDataAssetGuid: world.saveDataAssetGuid ?? null,
      checkpointId: world.checkpointId ?? null,
      generation: world.generation ?? null,
      generationOrigin: world.generationOrigin ?? null,
    };

    const before = durability.snapshot();
    report.before = {
      journalPosition: before.journalPosition,
      commands: before.commands.length,
      checkpoints: before.checkpoints.length,
      baselineActivation: before.baselineActivation ?? null,
      activeGeneration: before.active?.generation ?? null,
      certifiedRollbackAnchor: before.certifiedRollbackAnchor ?? null,
      projectState: before.projectState,
    };

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");
    report.activation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      worldId: activation.world.worldId,
      worldEpochId: activation.world.worldEpochId,
      nativeSessionGuid: activation.world.nativeSessionGuid,
      generation: activation.world.generation,
      checkpointId: activation.world.checkpointId ?? null,
    };

    const after = durability.snapshot();
    report.after = {
      journalPosition: after.journalPosition,
      commands: after.commands.length,
      checkpoints: after.checkpoints.length,
      baselineActivation: after.baselineActivation ?? null,
      activeGeneration: after.active?.generation ?? null,
      certifiedRollbackAnchor: after.certifiedRollbackAnchor ?? null,
      projectState: after.projectState,
      projectAuthority: after.projectAuthority ?? null,
      reconciliationRequired: durability.reconciliationRequired().map((entry) => entry.record.commandId),
    };
    report.certifiedBoundary = after.checkpoints
      .filter((entry) => entry.checkpointId === after.baselineActivation?.checkpointId)
      .map((entry) => ({
        checkpointId: entry.checkpointId,
        durable: entry.durable,
        worldId: entry.worldId,
        journalPosition: entry.journalPosition,
        nativeSessionGuid: entry.nativeSessionGuid ?? null,
      }));
    report.isExecutionDurablyActivated = durability.isExecutionDurablyActivated(activation);
  } finally {
    report.nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    report.callLog = calls.map((call) => call.name);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`DESCENDANT_CERTIFY_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
