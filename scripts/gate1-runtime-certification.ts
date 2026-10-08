import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { createMainMayorPorts } from "../src/main/services/ai-mayor/main-adapters";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-v2-gate1-certification", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const required = [
      "cs2_game_state",
      "cs2_mayor_snapshot",
      "cs2_spatial",
      "cs2_save_game",
      "cs2_save_status",
      "cs2_apply_road",
      "cs2_apply_zoning",
      "cs2_utility_connectors",
      "cs2_building_access",
    ];
    const gameState = object(parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} })));
    const snapshot = object(parseV2McpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} })));
    const spatial = object(
      parseV2McpJson(await client.callTool({ name: "cs2_spatial", arguments: { mode: "scan", roadLimit: 2_000 } })),
    );
    const game = object(gameState);
    const scanGraph = object(spatial.roadGraph);
    const tiles = Array.isArray(spatial.tiles) ? spatial.tiles : [];
    const edges = Array.isArray(scanGraph.edges) ? scanGraph.edges : [];
    const buildings = Array.isArray(spatial.buildings) ? spatial.buildings : [];
    const firstEdge = object(edges[0]);
    const firstPoint = object(firstEdge.start);
    const detail = object(
      parseV2McpJson(
        await client.callTool({
          name: "cs2_spatial",
          arguments: { mode: "detail", x: firstPoint.x, z: firstPoint.z, radius: 96, resolution: 16 },
        }),
      ),
    );
    const detailBuildings = Array.isArray(detail.buildings) ? detail.buildings : [];
    const detailCells = Array.isArray(detail.zoningCells) ? detail.zoningCells : [];
    const ownedTiles = tiles.filter((tile) => object(tile).owned === true);
    const legalCells = detailCells.filter((cell) => {
      const value = object(cell);
      const position = object(value.position);
      const tile = ownedTiles.find((candidate) => {
        const bounds = object(object(candidate).bounds);
        const min = object(bounds.min);
        const max = object(bounds.max);
        return (
          Number(position.x) >= Number(min.x) &&
          Number(position.x) <= Number(max.x) &&
          Number(position.z) >= Number(min.z) &&
          Number(position.z) <= Number(max.z)
        );
      });
      return Boolean(tile) && value.visible === true && value.roadside === true && value.occupied === false && value.blocked === false && value.overridden === false && value.zoneCategory === "none";
    });
    const ownedTileProbes = [];
    for (const tile of ownedTiles) {
      const center = object(object(tile).center);
      const probed = object(
        parseV2McpJson(
          await client.callTool({
            name: "cs2_spatial",
            arguments: { mode: "detail", x: center.x, z: center.z, radius: 96, resolution: 16 },
          }),
        ),
      );
      const cells = Array.isArray(probed.zoningCells) ? probed.zoningCells : [];
      const candidates = cells.filter((cell) => {
        const value = object(cell);
        return value.visible === true && value.roadside === true && value.occupied === false && value.blocked === false && value.overridden === false && value.zoneCategory === "none";
      });
      ownedTileProbes.push({ tile: object(tile).entity, center, zoningCellCount: cells.length, candidateCount: candidates.length, firstCandidate: candidates[0] });
    }
    const report: Record<string, unknown> = {
      serverPath,
      requiredTools: Object.fromEntries(required.map((name) => [name, names.includes(name)])),
      toolCount: names.length,
      gameState: {
        gameMode: game.gameMode,
        isLoading: game.isLoading,
        cityLoaded: game.cityLoaded,
        paused: game.paused,
        frame: game.frame,
        runtimeEpoch: game.runtimeEpoch,
        worldId: game.worldId,
        checkpoint: game.checkpoint,
      },
      snapshot: {
        cityName: object(snapshot.map).cityName ?? snapshot.cityName,
        population: snapshot.population,
        planningCatalog: snapshot.planningCatalog,
        actionablePlanning: snapshot.actionablePlanning,
      },
      spatial: {
        keys: Object.keys(spatial),
        tileCount: tiles.length,
        roadEdgeCount: edges.length,
        buildingCount: buildings.length,
        firstTile: tiles[0],
        firstRoadEdge: edges[0],
        firstBuilding: buildings[0],
        detail: {
          center: detail.center,
          buildingCount: detailBuildings.length,
          zoningCellCount: detailCells.length,
          firstBuilding: detailBuildings[0],
          firstCells: detailCells.slice(0, 5),
          ownedTileCount: ownedTiles.length,
          legalResidentialStarterCellCount: legalCells.length,
          firstLegalCell: legalCells[0],
          ownedTileProbes,
        },
      },
    };
    if (!process.argv.includes("--preflight-only")) {
      const candidateProbe = ownedTileProbes.find((probe) => probe.candidateCount > 0);
      if (!candidateProbe?.firstCandidate) throw new Error("NO_LEGAL_STARTER_SITE");
      const storage = createMemoryDurableStateStorage();
      const manager = {
        legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `t_live--${tool.name}` })) }),
        legacyCall: async ({ name, arguments: input }: { name: string; arguments: Record<string, unknown> }) =>
          client.callTool({ name, arguments: input }),
      };
      const ports = createMainMayorPorts({
        getProvider: () => undefined,
        getToolsManager: () => manager,
        durableStateStorage: storage,
      });
      const checkpointName = `AI Mayor V2 Gate1 Runtime Certification ${new Date().toISOString()}`;
      await ports.save(checkpointName);
      report["disposableCheckpoint"] = {
        name: checkpointName,
        durableState: storage.value(),
      };
      report["certificationHarness"] = {
        status: "CHECKPOINT_CREATED_READ_ONLY_STOP",
        siteCandidate: candidateProbe.firstCandidate,
        blocker: "UTILITY_DELIVERY_CAPABILITY_BLOCKER",
        reason: "Certified utility/access surfaces require a tranche-attributed building reference; no certified pre-zoning utility construction surface exists.",
        gameplayMutations: [],
      };
    }
    process.stdout.write(
      `${JSON.stringify(
        report,
        null,
        2,
      )}\n`,
    );
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
