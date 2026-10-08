/**
 * Read-only reconnaissance for the WATER minimum vertical slice.
 *
 * Answers, before anything is planned: what water capability does the CURRENT
 * world already have — the city-level water/sewage service numbers, the placed
 * water/sewage buildings and their pipe connectors, any water pipe net that is
 * already built, and which water prefabs this world actually offers. Nothing
 * here writes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game", "cs2_build_road", "cs2_mayor_execute_actions", "cs2_run_simulation",
  "cs2_bulldoze", "cs2_build", "cs2_zone", "cs2_place_building",
]);

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-water-recon", version: "1.0.0" });
  await client.connect(transport);

  const calls: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
    calls.push(name);
    return value;
  };

  const report: Record<string, unknown> = { serverPath, mode: "WATER_RECON_READ_ONLY" };
  try {
    const state = record(await call("cs2_game_state", {}));
    const world = record(state.world);
    report.world = {
      worldId: world.worldId ?? null, generation: world.generation ?? null,
      worldEpochId: world.worldEpochId ?? null, checkpointId: world.checkpointId ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null, worldReady: world.worldReady ?? null,
      paused: record(state.simulation).paused ?? null, frameIndex: record(state.simulation).frameIndex ?? null,
    };

    // City-level water/sewage service numbers — the authoritative service indicator.
    const services = record(await call("cs2_city_services", {}));
    report.cityServicesWater = services.water ?? null;
    report.cityServicesSewage = services.sewage ?? null;

    const snapshot = record(await call("cs2_mayor_snapshot", {}));
    const utilities = record(snapshot.utilities);
    report.snapshotWater = utilities.water ?? null;
    report.snapshotSewage = utilities.sewage ?? null;

    // Prefabs this world offers for water/sewage.
    report.waterPrefabs = list(record(await call("cs2_find_prefabs", { category: "building", query: "Water", limit: 60 })).prefabs)
      .map((p) => record(p))
      .filter((p) => !String(p.name ?? "").includes("Waterfront"));
    report.pumpingPrefabs = record(await call("cs2_find_prefabs", { category: "building", query: "Pumping", limit: 60 })).prefabs ?? null;
    report.sewagePrefabs = record(await call("cs2_find_prefabs", { category: "building", query: "Sewage", limit: 60 })).prefabs ?? null;
    report.pipeNetPrefabs = record(await call("cs2_find_prefabs", { category: "net", query: "Pipe", limit: 60 })).prefabs ?? null;
    report.waterNetPrefabs = record(await call("cs2_find_prefabs", { category: "net", query: "Water", limit: 60 })).prefabs ?? null;

    // Buildings already placed for water/sewage.
    report.waterBuildings = await call("cs2_list_buildings", { query: "Water", limit: 200 });
    report.sewageBuildings = await call("cs2_list_buildings", { query: "Sewage", limit: 200 });
    report.pumpingBuildings = await call("cs2_list_buildings", { query: "Pumping", limit: 200 });

    // Any water/sewage pipe net already built.
    report.pipeRoads = await call("cs2_list_roads", { query: "Pipe", limit: 500 });
    report.waterPipeRoads = await call("cs2_list_roads", { query: "Water Pipe", limit: 500 });

    // The whole current net graph, by prefab — proves what exists without assuming.
    const scan = parseSpatialBootstrapScan(await call("cs2_spatial", { mode: "scan", roadLimit: 2_000 }));
    const model = buildSpatialWorldModel(scan);
    const byPrefab = new Map<string, number>();
    for (const edge of model.roadGraph.edges) byPrefab.set(edge.prefab, (byPrefab.get(edge.prefab) ?? 0) + 1);
    report.roadGraph = {
      nodes: scan.roadGraph.nodes.length, edges: model.roadGraph.edges.length,
      byPrefab: Object.fromEntries([...byPrefab.entries()].sort()),
    };
    report.bootstrapAssetKinds = list(scan.bootstrapAssets).map((asset) => {
      const a = record(asset);
      const c = record(a.capabilities);
      return {
        prefab: a.prefab, locked: a.locked, constructionCost: a.constructionCost,
        freshWaterCapacity: c.freshWaterCapacity ?? null, sewageCapacity: c.sewageCapacity ?? null,
        groundWaterMaximum: c.groundWaterMaximum ?? null, allowedWaterTypes: c.allowedWaterTypes ?? null,
      };
    }).filter((a) => Number(a.freshWaterCapacity ?? 0) > 0 || Number(a.sewageCapacity ?? 0) > 0);
  } finally {
    report.nativeMutationCalls = calls.filter((name) => NATIVE_MUTATION_TOOLS.has(name));
    report.callLog = calls;
    const outPath = process.env.WATER_RECON_OUT ?? "evidence/water-recon-2026-09-22.json";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`WATER_RECON_WRITTEN: ${outPath}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`WATER_RECON_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
