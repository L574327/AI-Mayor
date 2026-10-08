/**
 * Read-only inventory of the CURRENT world for the WATER slice.
 *
 * The first recon answered "what water capability exists" (nothing: zero water
 * capacity, zero pipes, zero water buildings). This one answers the question
 * that decides the slice: what is there to *serve* — the full placed-building
 * list, the full city service board, the water-related notifications, and every
 * network edge the Bridge exposes (not just roads). Nothing here writes.
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
  const client = new Client({ name: "5ire-water-probe", version: "1.0.0" });
  await client.connect(transport);

  const calls: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
    calls.push(name);
    return value;
  };

  const report: Record<string, unknown> = { serverPath, mode: "WATER_WORLD_PROBE_READ_ONLY" };
  try {
    const state = record(await call("cs2_game_state", {}));
    report.world = record(state.world);
    report.simulation = record(state.simulation);

    report.cityServices = await call("cs2_city_services", {});
    report.snapshot = await call("cs2_mayor_snapshot", {});

    // Every placed building, unfiltered — what exists to be served.
    const allBuildings = record(await call("cs2_list_buildings", { limit: 500 }));
    report.buildings = {
      totalMatches: allBuildings.totalMatches ?? null,
      returned: allBuildings.returned ?? null,
      byPrefab: list(allBuildings.buildings).reduce<Record<string, number>>((acc, b) => {
        const prefab = String(record(b).prefab ?? "?");
        acc[prefab] = (acc[prefab] ?? 0) + 1;
        return acc;
      }, {}),
      entries: allBuildings.buildings ?? null,
    };

    // Every network edge the Bridge exposes, unfiltered.
    const allRoads = record(await call("cs2_list_roads", { limit: 500 }));
    report.roads = {
      totalMatches: allRoads.totalMatches ?? null,
      returned: allRoads.returned ?? null,
      byPrefab: list(allRoads.roads).reduce<Record<string, number>>((acc, r) => {
        const prefab = String(record(r).prefab ?? "?");
        acc[prefab] = (acc[prefab] ?? 0) + 1;
        return acc;
      }, {}),
    };

    // Water-relevant notifications (no water / sewage problems surface here).
    report.notifications = await call("cs2_notifications", { limit: 200 });

    // All net prefabs this world offers, unfiltered.
    report.netPrefabs = record(await call("cs2_find_prefabs", { category: "net", limit: 200 })).prefabs ?? null;

    // Full topology: nodes and edges by prefab, plus outside connections.
    const scan = parseSpatialBootstrapScan(await call("cs2_spatial", { mode: "scan", roadLimit: 2_000 }));
    const model = buildSpatialWorldModel(scan);
    const edgeByPrefab = new Map<string, number>();
    for (const edge of model.roadGraph.edges) edgeByPrefab.set(edge.prefab, (edgeByPrefab.get(edge.prefab) ?? 0) + 1);
    report.topology = {
      nodes: scan.roadGraph.nodes.length,
      edges: model.roadGraph.edges.length,
      edgeByPrefab: Object.fromEntries([...edgeByPrefab.entries()].sort()),
      nodeSample: scan.roadGraph.nodes.slice(0, 5),
      outsideConnections: scan.outsideConnections ?? null,
      tiles: record(scan.tiles).unlockedCount ?? record(scan.tiles).count ?? null,
    };
  } finally {
    report.nativeMutationCalls = calls.filter((name) => NATIVE_MUTATION_TOOLS.has(name));
    report.callLog = calls;
    const outPath = process.env.WATER_PROBE_OUT ?? "evidence/water-world-probe-2026-09-22.json";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`WATER_PROBE_WRITTEN: ${outPath}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`WATER_PROBE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
