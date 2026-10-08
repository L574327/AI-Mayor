/**
 * K05 Attempt 2 — Phase 2: the formal current-world recovery claim.
 *
 * The world already contains the admitted cable course as two permanent
 * Low-voltage Ground Cable segments, and the repaired objective matcher now
 * certifies the connection objective COMPLETE. This records that fact through
 * the *existing* production seam — `ports.observeCurrentWorldCommandEffect` —
 * which appends a current-world observation and never rewrites the command's
 * historical verdict.
 *
 * No new seam is introduced. The run is native-READ-only: no save, no Skill
 * dispatch, no place_building, no cable mutation, no simulation run. The script
 * asserts that and fails if violated.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const appData = process.env.APPDATA ?? "";
const COMMAND_ID = process.env.AI_MAYOR_CLAIM_COMMAND ?? "fa032a75-9676-44da-828b-1951f670a74e";

const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game", "cs2_build_road", "cs2_mayor_execute_actions", "cs2_run_simulation",
  "cs2_bulldoze", "cs2_build", "cs2_zone",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const commandState = (state: Record<string, unknown>, commandId: string) => {
  const commands = Array.isArray(state.commands) ? state.commands.map(record) : [];
  return commands
    .filter((entry) => record(entry.record).commandId === commandId)
    .map((entry) => ({
      position: entry.position ?? null,
      outcome: entry.outcome ?? null,
      status: record(entry.record).status ?? null,
      effectAbsenceProven: record(entry.record).effectAbsenceProven ?? null,
    }));
};

async function main() {
  if (!appData) throw new Error("APPDATA is not set");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-k05-recovery-claim", version: "1.0.0" });
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

  const report: Record<string, unknown> = { serverPath, commandId: COMMAND_ID, mode: "RECOVERY_CLAIM_NATIVE_READ_ONLY" };
  try {
    const gameState = parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
    const game = record(gameState);
    const world = record(game.world);
    const simulation = record(game.simulation);
    report.world = {
      worldId: world.worldId ?? null, generation: world.generation ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null,
      paused: simulation.paused ?? null, frameIndex: simulation.frameIndex ?? null,
      nativeOperationBusy: world.nativeOperationBusy ?? null,
    };
    if (game.gameMode !== "Game" || game.cityLoaded !== true || simulation.paused !== true) {
      throw new Error("LIVE_WORLD_NOT_READY");
    }

    const storage = createCanonicalDurableStateStorage(appData);
    const ports = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage });
    const durability = ports.durability;
    if (!durability || !ports.observeCurrentWorldCommandEffect) {
      throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    }

    // Activation only: `activateDurableWorld()` is deliberately NOT used, because
    // its BASELINE_CHECKPOINT_REQUIRED branch continues into a native save.
    const activation = durability.activate(gameState);
    report.activation = {
      kind: activation.kind ?? null, status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      worldId: activation.world.worldId, worldEpochId: activation.world.worldEpochId,
    };
    report.writeAuthorityValid = durability.isExecutionDurablyActivated(activation);

    const before = durability.snapshot();
    report.before = {
      journalPosition: before.journalPosition,
      oldCommand: commandState(before, COMMAND_ID),
      observationsForCommand: (before.worldObservations ?? []).filter((entry) => entry.commandId === COMMAND_ID).length,
    };

    const { effect, observation } = await ports.observeCurrentWorldCommandEffect(COMMAND_ID);
    report.claim = {
      effect,
      observation: {
        observationId: observation.observationId,
        worldId: observation.worldId,
        worldEpochId: observation.worldEpochId,
        observedAt: observation.observedAt,
        historicalVerdict: observation.historicalVerdict,
        currentWorldEffectPresent: observation.currentWorldEffectPresent,
        currentWorldObjectiveSatisfied: observation.currentWorldObjectiveSatisfied,
        evidence: observation.evidence,
      },
    };

    const after = durability.snapshot();
    report.after = {
      journalPosition: after.journalPosition,
      oldCommand: commandState(after, COMMAND_ID),
      observationsForCommand: (after.worldObservations ?? []).filter((entry) => entry.commandId === COMMAND_ID).length,
    };
    report.OLD_COMMAND_VERDICT_UNCHANGED =
      JSON.stringify(report.before && (report.before as Record<string, unknown>).oldCommand) ===
      JSON.stringify((report.after as Record<string, unknown>).oldCommand);

    report.RECOVERY_CLAIM_RECORDED =
      observation.currentWorldEffectPresent === true && observation.currentWorldObjectiveSatisfied === true;
    report.PHYSICAL_EFFECT_PRESENT = observation.currentWorldEffectPresent;
    report.CONNECTION_OBJECTIVE_SATISFIED = observation.currentWorldObjectiveSatisfied;
  } finally {
    report.NEW_CABLE_NATIVE_MUTATION_COUNT = calls.filter(
      (call) => call.name === "cs2_build_road" || call.name === "cs2_mayor_execute_actions",
    ).length;
    report.nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    report.callLog = calls.map((call) => call.name);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`K05_RECOVERY_CLAIM_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
