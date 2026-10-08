/**
 * Read-only reconnaissance for K05 Attempt 2 recovery.
 *
 * Answers one question before any planning happens: what does the CURRENT world
 * actually contain for this objective — the facility, its connector, the target
 * road, and any Low-voltage Ground Cable net that is already built. Nothing here
 * writes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const FACILITY = { index: Number(process.env.K05_FACILITY_INDEX ?? 176455), version: Number(process.env.K05_FACILITY_VERSION ?? 1) };
const ROAD = { index: Number(process.env.K05_ROAD_INDEX ?? 187602), version: Number(process.env.K05_ROAD_VERSION ?? 1) };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-k05-recon", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    parseV2McpJson(await client.callTool({ name, arguments: args }));

  const report: Record<string, unknown> = {};
  try {
    const state = record(await call("cs2_game_state", {}));
    const world = record(state.world);
    report.world = {
      worldId: world.worldId ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null,
      checkpointId: world.checkpointId ?? null,
      generation: world.generation ?? null,
      bridgeRuntimeEpoch: world.bridgeRuntimeEpoch ?? null,
      paused: record(state.simulation).paused ?? null,
      frameIndex: record(state.simulation).frameIndex ?? null,
    };

    // The whole current road/net graph: every edge, so a cable that already
    // exists is found by its prefab rather than assumed absent.
    const scan = parseSpatialBootstrapScan(await call("cs2_spatial", { mode: "scan", roadLimit: 2_000 }));
    const model = buildSpatialWorldModel(scan);
    const byPrefab = new Map<string, number>();
    for (const edge of model.roadGraph.edges) byPrefab.set(edge.prefab, (byPrefab.get(edge.prefab) ?? 0) + 1);
    report.roadGraph = { nodes: scan.roadGraph.nodes.length, edges: model.roadGraph.edges.length, byPrefab: Object.fromEntries(byPrefab) };
    report.cableEdges = model.roadGraph.edges
      .filter((edge) => /cable/i.test(edge.prefab))
      .map((edge) => ({
        entity: edge.entity, prefab: edge.prefab, native: edge.native, temp: edge.temp ?? null,
        deleted: edge.deleted ?? null, owner: edge.owner ?? null,
        startNode: edge.startNode, endNode: edge.endNode, start: edge.start, end: edge.end, length: edge.length,
      }));
    report.targetRoadEdge = model.roadGraph.edges
      .filter((edge) => edge.entity.index === ROAD.index && edge.entity.version === ROAD.version)
      .map((edge) => ({ entity: edge.entity, prefab: edge.prefab, startNode: edge.startNode, endNode: edge.endNode, start: edge.start, end: edge.end }));

    // The facility, as the current world reports it.
    const listed = record(await call("cs2_list_buildings", { query: "WindTurbine", limit: 64 }));
    report.facilityList = {
      complete: listed.complete ?? null, truncated: listed.truncated ?? null, hasMore: listed.hasMore ?? null,
      buildings: Array.isArray(listed.buildings) ? listed.buildings : null,
    };

    // The connector, with every field the Bridge exposes for it.
    report.connectorsRaw = await call("cs2_utility_connectors", { index: FACILITY.index, version: FACILITY.version });

    // The net graph the spatial scan does NOT cover: cables are a different net
    // category from roads, so they are enumerated by prefab name instead.
    report.cableRoads = await call("cs2_list_roads", { query: "Cable", limit: 500 });
    report.lowVoltageRoads = await call("cs2_list_roads", { query: "Low-voltage", limit: 500 });
    report.nearFacilityRoads = await call("cs2_list_roads", {
      x: -1117.83313, z: -11.0255737, radius: 400, limit: 200,
    });
    report.nearTargetRoads = await call("cs2_list_roads", {
      x: -1247.55188, z: -12.3875341, radius: 400, limit: 200,
    });

    // The target-building read the utility service port uses.
    report.targetReadRaw = await call("cs2_building_access", { index: FACILITY.index, version: FACILITY.version });

    // City-wide electricity capacity, the service condition the objective needs.
    report.cityOverview = await call("cs2_city_overview", {});
  } finally {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`K05_RECON_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
