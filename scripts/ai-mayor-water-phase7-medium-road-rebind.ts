import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const rec = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const raw = await client.callTool({ name, arguments: args });
  const text = rec(raw).content instanceof Array ? rec((rec(raw).content as unknown[])[0]).text : null;
  try { return typeof text === "string" ? JSON.parse(text) : {}; } catch { return { raw: text }; }
};

async function main() {
  const client = new Client({ name: "water-phase7-medium-road-rebind", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  try {
    const [game, roads, smallRoads, pipes, cables, buildings, turbines] = await Promise.all([
      call(client, "cs2_game_state"),
      call(client, "cs2_list_roads", { query: "Medium Road", limit: 500 }),
      call(client, "cs2_list_roads", { query: "Small Road", limit: 500 }),
      call(client, "cs2_list_roads", { query: "Small Water Pipe", limit: 500 }),
      call(client, "cs2_list_roads", { query: "Low-voltage Ground Cable", limit: 500 }),
      call(client, "cs2_list_buildings", { query: "GroundwaterPumpingStation01", limit: 16 }),
      call(client, "cs2_list_buildings", { query: "WindTurbine03", limit: 16 }),
    ]);
    const world = rec(game).world;
    const pump = (Array.isArray(rec(buildings).buildings) ? rec(buildings).buildings : []).map(rec).find((value: Record<string, any>) => value.isSubBuilding !== true);
    const turbine = (Array.isArray(rec(turbines).buildings) ? rec(turbines).buildings : []).map(rec).find((value: Record<string, any>) => value.isSubBuilding !== true);
    const pumpEntity = rec(pump?.entity);
    const turbineEntity = rec(turbine?.entity);
    const [access, connectors, finalGame] = pump ? await Promise.all([
      call(client, "cs2_building_access", { index: pumpEntity.index, version: pumpEntity.version }),
      call(client, "cs2_utility_connectors", { index: pumpEntity.index, version: pumpEntity.version }),
      call(client, "cs2_game_state"),
    ]) : [{}, {}, await call(client, "cs2_game_state")];
    const turbineConnectors = turbine ? await call(client, "cs2_utility_connectors", {
      index: turbineEntity.index, version: turbineEntity.version,
    }) : {};
    const edges = (Array.isArray(rec(roads).roads) ? rec(roads).roads : []).map(rec);
    const anchor = { x: -1247.76172, z: 139.237488 };
    const distance = (point: unknown) => Math.hypot(Number(rec(point).x) - anchor.x, Number(rec(point).z) - anchor.z);
    const candidates = edges.map((edge: Record<string, any>) => ({
      entity: edge.entity, prefab: edge.prefab, start: edge.start, end: edge.end,
      startDistance: distance(edge.start), endDistance: distance(edge.end),
    })).filter((edge: Record<string, any>) => edge.prefab === "Medium Road")
      .sort((a: Record<string, any>, b: Record<string, any>) => Math.min(a.startDistance, a.endDistance) - Math.min(b.startDistance, b.endDistance));
    process.stdout.write(JSON.stringify({
      world: { worldId: world.worldId, generation: world.generation, bridgeRuntimeEpoch: world.bridgeRuntimeEpoch,
        paused: rec(game).simulation?.paused, frameIndex: rec(game).simulation?.frameIndex,
        nativeOperationStage: world.nativeOperationStage, nativeOperationBusy: world.nativeOperationBusy,
        finalFrameIndex: rec(finalGame).simulation?.frameIndex, finalPaused: rec(finalGame).simulation?.paused },
      query: { complete: rec(roads).complete, truncated: rec(roads).truncated, returned: rec(roads).returned },
      anchor, closestCurrentMediumRoads: candidates.slice(0, 4),
      currentWindTurbine: { entity: turbineEntity, position: turbine?.position,
        connectorCount: Array.isArray(rec(turbineConnectors).connectors) ? rec(turbineConnectors).connectors.length : null,
        connectors: rec(turbineConnectors).connectors },
      currentPump: { entity: pumpEntity, position: pump?.position, access: rec(access).roadAttachment,
        connectorCount: Array.isArray(rec(connectors).connectors) ? rec(connectors).connectors.length : null,
        connectors: rec(connectors).connectors, consumerService: rec(connectors).consumerService },
      currentSmallRoads: (Array.isArray(rec(smallRoads).roads) ? rec(smallRoads).roads : []).map((raw: unknown) => {
        const item = rec(raw); return { entity: item.entity, start: item.start, end: item.end };
      }),
      currentWaterPipes: (Array.isArray(rec(pipes).roads) ? rec(pipes).roads : []).map((raw: unknown) => {
        const item = rec(raw); return { entity: item.entity, start: item.start, end: item.end };
      }),
      currentLvCables: (Array.isArray(rec(cables).roads) ? rec(cables).roads : []).map((raw: unknown) => {
        const item = rec(raw); return { entity: item.entity, start: item.start, end: item.end };
      }),
    }, null, 2) + "\n");
  } finally { await client.close(); }
}
void main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
