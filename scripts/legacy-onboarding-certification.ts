import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createV2FoundationPorts,
  parseV2McpJson,
} from "../src/main/services/ai-mayor/v2/main-adapter";
import {
  createMemoryDurableStateStorage,
  parseNativeWorldIdentity,
} from "../src/main/services/ai-mayor/v2/durability";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const onboard = process.argv.includes("--onboard");

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-legacy-onboarding-certification", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));

    const gameState = object(parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} })));
    const world = object(gameState.world);

    const report: Record<string, unknown> = {
      serverPath,
      tools: {
        cs2_game_state: names.has("cs2_game_state"),
        cs2_save_game: names.has("cs2_save_game"),
        cs2_save_status: names.has("cs2_save_status"),
      },
      rawWorld: {
        gameMode: gameState.gameMode,
        isLoading: gameState.isLoading,
        cityLoaded: gameState.cityLoaded,
        paused: object(gameState.simulation).paused,
        worldId: world.worldId,
        nativeSessionGuid: world.nativeSessionGuid,
        loadPurpose: world.loadPurpose,
        checkpointId: world.checkpointId,
        saveDataAssetGuid: world.saveDataAssetGuid,
        loadAssetGuid: world.loadAssetGuid,
        mapAssetGuid: world.mapAssetGuid,
        generation: world.generation,
        generationSequence: world.generationSequence,
        generationOrigin: world.generationOrigin,
        nativeOperationBusy: world.nativeOperationBusy,
        nativeOperationStage: world.nativeOperationStage,
      },
    };

    try {
      const identity = parseNativeWorldIdentity(gameState);
      report["classification"] = {
        parsed: "OK",
        loadPurpose: identity.loadPurpose,
        checkpointId: identity.checkpointId,
        saveDataAssetGuid: identity.saveDataAssetGuid,
        legacyOnboardingCandidate: identity.legacyOnboardingCandidate === true,
        worldId: identity.worldId,
        nativeSessionGuid: identity.nativeSessionGuid,
        worldEpochId: identity.worldEpochId,
        generation: identity.generation,
      };
    } catch (error) {
      report["classification"] = { parsed: "THREW", error: error instanceof Error ? error.message : String(error) };
    }

    const appData = process.env.APPDATA;
    if (appData) {
      const configPath = path.join(appData, "5ire", "config.json");
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        report["durableStore"] = {
          path: configPath,
          hasAiMayorV2DurableState: Object.prototype.hasOwnProperty.call(config, "aiMayorV2DurableState"),
          value: config.aiMayorV2DurableState ?? null,
        };
      } catch (error) {
        report["durableStore"] = { path: configPath, error: error instanceof Error ? error.message : String(error) };
      }
    }

    if (onboard) {
      const readGame = async () =>
        object(parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} })));
      const isPaused = (game: Record<string, unknown>) => {
        const simulation = object(game.simulation);
        return game.simulationPaused === true || simulation.paused === true;
      };
      // assertStableFreshWorld requires the simulation to be paused before the
      // baseline save. Cancel any running simulation and wait for confirmation.
      const pausedBefore = isPaused(gameState);
      let pauseCancelIssued = false;
      let pausedAfter = pausedBefore;
      if (!pausedBefore) {
        await client.callTool({ name: "cs2_run_simulation", arguments: { cancel: true } });
        pauseCancelIssued = true;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (isPaused(await readGame())) {
            pausedAfter = true;
            break;
          }
        }
      }
      report["pause"] = { pausedBefore, cancelIssued: pauseCancelIssued, pausedAfter };

      const manager = {
        legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `t_live--${tool.name}` })) }),
        legacyCall: async ({ name, arguments: input }: { name: string; arguments: Record<string, unknown> }) =>
          client.callTool({ name, arguments: input }),
      };
      const storage = createMemoryDurableStateStorage();
      const foundation = createV2FoundationPorts({ getToolsManager: () => manager, durableStateStorage: storage });
      if (!foundation.activateDurableWorld || !foundation.durability) {
        report["onboarding"] = { error: "durability unavailable" };
      } else {
        const saveStatusBefore = object(
          parseV2McpJson(await client.callTool({ name: "cs2_save_status", arguments: {} })),
        );
        const activation = await foundation.activateDurableWorld();
        const snapshot = foundation.durability.snapshot();
        const baseline = snapshot.checkpoints.find(
          (entry) => entry.purpose === "BASELINE" && entry.durable && entry.journalPosition === 0,
        );
        const saveStatusAfter = object(
          parseV2McpJson(await client.callTool({ name: "cs2_save_status", arguments: {} })),
        );
        const projectState = snapshot.projectState;
        report["onboarding"] = {
          activation: {
            kind: activation.kind,
            status: activation.status,
            blockedReason: activation.blockedReason ?? null,
            worldId: activation.world.worldId,
            nativeSessionGuid: activation.world.nativeSessionGuid,
            legacyOnboardingCandidate: activation.world.legacyOnboardingCandidate === true,
          },
          saveStatusBefore: { status: saveStatusBefore.status, durable: saveStatusBefore.durable },
          baseline: baseline
            ? {
                checkpointId: baseline.checkpointId,
                worldId: baseline.worldId,
                worldEpochId: baseline.worldEpochId,
                nativeSessionGuid: baseline.nativeSessionGuid,
                saveMetadataAssetGuid: baseline.saveMetadataAssetGuid,
                saveDataAssetGuid: baseline.saveDataAssetGuid,
                journalPosition: baseline.journalPosition,
                recordedAt: baseline.recordedAt,
              }
            : null,
          certifiedRollbackAnchor: snapshot.certifiedRollbackAnchor
            ? {
                status: snapshot.certifiedRollbackAnchor.status,
                checkpointId: snapshot.certifiedRollbackAnchor.checkpointId,
                worldId: snapshot.certifiedRollbackAnchor.worldId,
                journalPosition: snapshot.certifiedRollbackAnchor.journalPosition,
              }
            : null,
          baselineActivation: snapshot.baselineActivation,
          projectStateStatus: (projectState as { status?: string } | null)?.status ?? null,
          checkpointCount: snapshot.checkpoints.length,
          saveStatusAfter: {
            status: saveStatusAfter.status,
            saveRequestId: saveStatusAfter.saveRequestId ?? null,
            worldId: saveStatusAfter.worldId ?? null,
            checkpoint: saveStatusAfter.checkpoint ?? null,
          },
        };
      }
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
