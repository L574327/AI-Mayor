import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const rec = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

async function main() {
  const client = new Client({ name: "water-phase7-segment1-readonly-certification", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: string[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (!["cs2_game_state", "cs2_list_buildings", "cs2_list_roads", "cs2_building_access", "cs2_utility_connectors", "cs2_spatial", "cs2_city_services"].includes(name)) {
      throw new Error(`READ_ONLY_TOOL_ALLOWLIST_REJECTED:${name}`);
    }
    calls.push(name);
    const raw = await client.callTool({ name, arguments: args });
    const text = array(rec(raw).content).map(rec).find((item) => typeof item.text === "string")?.text;
    try { return typeof text === "string" ? JSON.parse(text) : {}; } catch { return { raw: text }; }
  };
  try {
    const initial = rec(await tool("cs2_game_state"));
    const world = rec(initial.world);
    const simulation = rec(initial.simulation);
    if (simulation.paused !== true || world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle") {
      throw new Error("WORLD_NOT_PAUSED_AND_BRIDGE_IDLE");
    }
    const [buildings, mediumRoads, smallRoads, cables, pipes] = await Promise.all([
      tool("cs2_list_buildings", { query: "WindTurbine03", limit: 16 }),
      tool("cs2_list_roads", { query: "Medium Road", limit: 500 }),
      tool("cs2_list_roads", { query: "Small Road", limit: 500 }),
      tool("cs2_list_roads", { query: "Low-voltage Ground Cable", limit: 500 }),
      tool("cs2_list_roads", { query: "Small Water Pipe", limit: 500 }),
    ]);
    const turbine = array(rec(buildings).buildings).map(rec).find((item) => item.isSubBuilding !== true);
    if (!turbine) throw new Error("CURRENT_WINDTURBINE_REBIND_FAILED");
    const turbineEntity = rec(turbine.entity);
    const turbineConnectors = rec(await tool("cs2_utility_connectors", { index: turbineEntity.index, version: turbineEntity.version }));
    const electricity = array(turbineConnectors.connectors).map(rec).find((item) => item.type === "electricity");
    if (!electricity) throw new Error("CURRENT_WINDTURBINE_ELECTRICITY_CONNECTOR_MISSING");
    const sourceNode = rec(electricity.node);
    const medium = array(rec(mediumRoads).roads).map(rec).find((edge) => {
      const end = rec(edge.end);
      return Math.hypot(Number(end.x) + 1247.76172, Number(end.z) - 139.237488) <= 0.25;
    });
    if (!medium) throw new Error("CURRENT_SOURCE_SIDE_MEDIUM_ROAD_REBIND_FAILED");
    const buildingsPump = rec(await tool("cs2_list_buildings", { query: "GroundwaterPumpingStation01", limit: 16 }));
    const pump = array(buildingsPump.buildings).map(rec).find((item) => item.isSubBuilding !== true);
    if (!pump) throw new Error("CURRENT_PUMP_REBIND_FAILED");
    const pumpEntity = rec(pump.entity);
    const pumpAccess = rec(await tool("cs2_building_access", { index: pumpEntity.index, version: pumpEntity.version }));
    const accessRoad = rec(rec(pumpAccess.roadAttachment).roadEdge);
    if (!Number.isInteger(Number(accessRoad.index))) throw new Error("CURRENT_PUMP_ACCESS_ROAD_REBIND_FAILED");

    const walk = async (target: Record<string, unknown>) => {
      const response = rec(await tool("cs2_utility_connectors", {
        index: turbineEntity.index, version: turbineEntity.version, topology: true,
        connectorIndex: Number(sourceNode.index), connectorVersion: Number(sourceNode.version),
        targetIndex: Number(target.index), targetVersion: Number(target.version),
        expectedWorldId: String(world.worldId), expectedGeneration: String(world.generation),
      }));
      const topology = Object.keys(rec(response.topology)).length ? rec(response.topology) : response;
      return {
        binding: topology.binding,
        connector: { networkConnected: rec(topology.connector).networkConnected, connectedEdgeCount: rec(topology.connector).connectedEdgeCount },
        targetNetwork: {
          complete: rec(topology.targetNetwork).complete, truncated: rec(topology.targetNetwork).truncated,
          networkConnected: rec(topology.targetNetwork).networkConnected,
          targetNetworkReachable: rec(topology.targetNetwork).targetNetworkReachable,
          reachablePath: rec(topology.targetNetwork).reachablePath,
        },
      };
    };
    const [sourceRoadTopology, accessRoadTopology, services] = await Promise.all([
      walk(rec(medium.entity)), walk(accessRoad), tool("cs2_city_services"),
    ]);
    const segment1 = { prefab: "Low-voltage Ground Cable", x1: -1247.76172, z1: 139.237488, x2: -737.33536, z2: 727.868744 };
    const preview = rec(await tool("cs2_spatial", { mode: "preflight", kind: "net", ...segment1 }));
    const finance = rec(preview.finance);
    const realization = rec(rec(preview.diagnostics).realization);
    const currentCableEdges = array(rec(cables).roads).map(rec);
    const exactGeometryDuplicate = currentCableEdges.some((edge) => {
      const start = rec(edge.start); const end = rec(edge.end);
      const same = (a: Record<string, number>, b: Record<string, number>) => Math.hypot(a.x - b.x, a.z - b.z) <= 1.5;
      return (same(start, { x: segment1.x1, z: segment1.z1 }) && same(end, { x: segment1.x2, z: segment1.z2 })) ||
        (same(end, { x: segment1.x1, z: segment1.z1 }) && same(start, { x: segment1.x2, z: segment1.z2 }));
    });
    const finalState = rec(await tool("cs2_game_state"));
    const finalWorld = rec(finalState.world);
    const topologySummary = (value: Record<string, any>) => ({
      binding: { worldId: rec(value.binding).worldId, generation: rec(value.binding).generation,
        frameIndex: rec(value.binding).frameIndex, bindingStatus: rec(value.binding).bindingStatus,
        complete: rec(value.binding).complete, truncated: rec(value.binding).truncated },
      connector: { networkConnected: rec(value.connector).networkConnected,
        attached: rec(value.connector).attached, connectedEdgeCount: rec(value.connector).connectedEdgeCount },
      targetNetwork: { complete: rec(value.targetNetwork).complete, truncated: rec(value.targetNetwork).truncated,
        networkConnected: rec(value.targetNetwork).networkConnected,
        targetNetworkReachable: rec(value.targetNetwork).targetNetworkReachable,
        reachablePathLength: array(value.targetNetwork?.reachablePath).length,
        reachablePathHead: array(value.targetNetwork?.reachablePath).slice(0, 3).map((edge) => rec(edge).entity).filter(Boolean),
        reachablePathTail: array(value.targetNetwork?.reachablePath).slice(-3).map((edge) => rec(edge).entity).filter(Boolean) },
    });
    const report = {
      world: { worldId: world.worldId, generation: world.generation, bridgeRuntimeEpoch: world.bridgeRuntimeEpoch,
        frameIndex: simulation.frameIndex, paused: simulation.paused, nativeOperationStage: world.nativeOperationStage,
        finalFrameIndex: rec(finalState.simulation).frameIndex, finalPaused: rec(finalState.simulation).paused,
        finalGeneration: finalWorld.generation },
      source: { turbine: turbine.entity, electricityConnector: electricity.node, attached: electricity.attached,
        connectedEdges: electricity.connectedEdges, currentLvCables: currentCableEdges.map((edge) => ({ entity: edge.entity, start: edge.start, end: edge.end })) },
      sourceSideMediumRoad: { entity: medium.entity, start: medium.start, end: medium.end,
        topology: topologySummary(sourceRoadTopology) },
      localRoadComponent: { accessRoad: accessRoad, smallRoads: array(rec(smallRoads).roads).map((raw) => {
        const edge = rec(raw); return { entity: edge.entity, start: edge.start, end: edge.end };
      }), sourceTopologyToAccessRoad: topologySummary(accessRoadTopology) },
      pump: { entity: pump.entity, roadAttachment: rec(pumpAccess.roadAttachment), electricity: rec(rec(rec(await tool("cs2_utility_connectors", {
        index: pumpEntity.index, version: pumpEntity.version,
      })).consumerService).electricity) },
      waterPipes: array(rec(pipes).roads).map((raw) => { const edge = rec(raw); return { entity: edge.entity, start: edge.start, end: edge.end }; }),
      cityElectricity: rec(services).electricity,
      segment1: { requested: segment1, valid: preview.valid, previewOnly: preview.previewOnly,
        reason: preview.reason ?? null, errorCode: preview.errorCode ?? null,
        quote: finance.signedAmount ?? preview.signedAmount ?? null,
        realizedStart: realization.startPosition ?? null, realizedEnd: realization.endPosition ?? null,
        generatedEdgeCount: realization.generatedEdgeCount ?? null,
        nativeAttachment: rec(rec(preview.diagnostics).attachment).status ?? null,
        firstFailedNativeAttachmentPredicate: rec(preview.diagnostics).firstFailedNativeAttachmentPredicate ?? null,
        validation: rec(preview.diagnostics).validation,
        exactGeometryDuplicateInCurrentCableList: exactGeometryDuplicate,
        currentCableList: { totalMatches: rec(cables).totalMatches, returned: rec(cables).returned,
          truncated: rec(cables).truncated ?? false,
          complete: rec(cables).truncated !== true && Number(rec(cables).returned) === Number(rec(cables).totalMatches),
          count: currentCableEdges.length },
        nativeMutationCount: 0, authorizationCount: 0 },
      callLog: calls, nativeMutationCalls: calls.filter((name) => !["cs2_game_state", "cs2_list_buildings", "cs2_list_roads", "cs2_building_access", "cs2_utility_connectors", "cs2_spatial", "cs2_city_services"].includes(name)),
    };
    const outPath = "docs/ai-mayor/evidence/water-phase7-segment1-readonly-certification-2026-09-24.json";
    await (await import("node:fs/promises")).writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await client.close(); }
}
void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
