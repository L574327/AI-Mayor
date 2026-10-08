import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const client = new Client({ name: "water-phase7-segment1-readonly-world-reconcile", version: "1.0.0" });
const allowed = new Set(["cs2_game_state", "cs2_list_buildings", "cs2_list_roads", "cs2_utility_connectors"]);
const calls = [];
const call = async (name, args = {}) => {
  if (!allowed.has(name)) throw new Error(`READ_ONLY_TOOL_DENIED:${name}`);
  calls.push(name);
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (response.isError === true) throw new Error(`${name}:${text ?? "MCP_TOOL_ERROR"}`);
  return text ? JSON.parse(text) : response;
};
const ref = (value) => ({ index: Number(value?.index), version: Number(value?.version) });
const point = (value) => ({ x: Number(value?.x), y: Number(value?.y), z: Number(value?.z) });
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const start = { x: -1247.76172, z: 139.237488 };
const end = { x: -737.33536, z: 727.868744 };

try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const state = await call("cs2_game_state");
  const world = state.world ?? {};
  if (state.simulation?.paused !== true || world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle") throw new Error("WORLD_NOT_PAUSED_IDLE");
  const [buildings, roads] = await Promise.all([
    call("cs2_list_buildings", { query: "WindTurbine03", limit: 64 }),
    call("cs2_list_roads", { query: "Low-voltage Ground Cable", limit: 500 }),
  ]);
  if (roads.truncated === true || roads.hasMore === true || Number(roads.returned) !== Number(roads.totalMatches)) throw new Error("CABLE_SCAN_INCOMPLETE");
  const turbine = (buildings.buildings ?? []).filter((item) => item.prefab === "WindTurbine03" && item.isSubBuilding !== true);
  if (turbine.length !== 1) throw new Error("TURBINE_REBIND_NOT_UNIQUE");
  const turbineEntity = ref(turbine[0].entity);
  const connectorRead = await call("cs2_utility_connectors", turbineEntity);
  const connector = (connectorRead.connectors ?? []).filter((item) => item.type === "electricity");
  if (connector.length !== 1) throw new Error("TURBINE_CONNECTOR_NOT_UNIQUE");
  const sourceNode = ref(connector[0].node);
  const sourceTopologyRaw = await call("cs2_utility_connectors", {
    ...turbineEntity, topology: true, connectorIndex: sourceNode.index, connectorVersion: sourceNode.version,
    targetIndex: 45234, targetVersion: 5, expectedWorldId: world.worldId, expectedGeneration: world.generation,
  });
  const sourceTopology = sourceTopologyRaw.topology ?? sourceTopologyRaw;
  const sourceTerminal = (sourceTopology.targetNetwork?.targetEndpoints ?? []).find((item) => distance(point(item.position), start) <= 0.25);
  const sourceRoadNode = ref(sourceTerminal?.node);
  const dx = end.x - start.x; const dz = end.z - start.z; const length2 = dx * dx + dz * dz;
  const projection = (p) => ((p.x - start.x) * dx + (p.z - start.z) * dz) / length2;
  const lineDistance = (p) => Math.abs((p.x - start.x) * dz - (p.z - start.z) * dx) / Math.sqrt(length2);
  const routeEdges = (roads.roads ?? []).filter((edge) => {
    const a = point(edge.start); const b = point(edge.end); const ta = projection(a); const tb = projection(b);
    return lineDistance(a) <= 0.5 && lineDistance(b) <= 0.5 && Math.min(ta, tb) >= -0.001 && Math.max(ta, tb) <= 1.001;
  }).sort((a, b) => Math.min(projection(point(a.start)), projection(point(a.end))) - Math.min(projection(point(b.start)), projection(point(b.end))));
  let cursor = start;
  const ordered = [];
  for (const edge of routeEdges) {
    const a = point(edge.start); const b = point(edge.end);
    if (distance(a, cursor) <= 0.5) { ordered.push({ ...edge, orientedStart: a, orientedEnd: b }); cursor = b; }
    else if (distance(b, cursor) <= 0.5) { ordered.push({ ...edge, orientedStart: b, orientedEnd: a }); cursor = a; }
    else throw new Error(`REALIZED_CABLE_CHAIN_GAP:${JSON.stringify({ cursor, a, b })}`);
  }
  const routeCoverage = ordered.length > 0 && distance(cursor, end) <= 0.5;
  const first = ordered[0]; const last = ordered.at(-1);
  const firstTopologyRaw = first ? await call("cs2_utility_connectors", {
    ...turbineEntity, topology: true, connectorIndex: sourceNode.index, connectorVersion: sourceNode.version,
    targetIndex: Number(first.entity?.index), targetVersion: Number(first.entity?.version),
    expectedWorldId: world.worldId, expectedGeneration: world.generation,
  }) : {};
  const firstTopology = firstTopologyRaw.topology ?? firstTopologyRaw;
  const firstTerminal = (firstTopology.targetNetwork?.targetEndpoints ?? []).find((item) => distance(point(item.position), start) <= 0.25);
  const firstStartNode = ref(firstTerminal?.node);
  const firstBinding = firstTopology.binding ?? {};
  const sourceToFirstSegmentReachable = (firstTopology.bindingStatus ?? firstBinding.bindingStatus) === "VALID" &&
    (firstTopology.complete ?? firstBinding.complete) === true && firstTopology.truncated !== true && firstBinding.truncated !== true &&
    firstTopology.targetNetwork?.targetNetworkReachable === true;
  const sourceSideJoin = !!sourceTerminal && !!firstTerminal && routeCoverage && sourceToFirstSegmentReachable;
  const terminalTopologyRaw = last ? await call("cs2_utility_connectors", {
    ...turbineEntity, topology: true, connectorIndex: sourceNode.index, connectorVersion: sourceNode.version,
    targetIndex: Number(last.entity?.index), targetVersion: Number(last.entity?.version),
    expectedWorldId: world.worldId, expectedGeneration: world.generation,
  }) : {};
  const terminalTopology = terminalTopologyRaw.topology ?? terminalTopologyRaw;
  const terminalBinding = terminalTopology.binding ?? {};
  const terminal = (terminalTopology.targetNetwork?.targetEndpoints ?? []).find((item) => distance(point(item.position), end) <= 0.25);
  const terminalRef = ref(terminal?.node);
  const topologyPass = (terminalTopology.bindingStatus ?? terminalBinding.bindingStatus) === "VALID" &&
    (terminalTopology.complete ?? terminalBinding.complete) === true &&
    terminalTopology.truncated !== true && terminalBinding.truncated !== true && terminalTopology.targetNetwork?.targetNetworkReachable === true &&
    Number.isInteger(terminalRef.index) && Number.isInteger(terminalRef.version) && !!terminal;
  const final = await call("cs2_game_state");
  const report = {
    world: { worldId: world.worldId, generation: world.generation, frameIndex: state.simulation?.frameIndex,
      paused: state.simulation?.paused, bridgeStage: world.nativeOperationStage,
      finalGeneration: final.world?.generation, finalFrameIndex: final.simulation?.frameIndex,
      finalPaused: final.simulation?.paused, finalBridgeStage: final.world?.nativeOperationStage },
    SEGMENT_1_WORLD_EFFECT: routeCoverage ? "PASS" : "FAIL",
    realizedEdgeCount: ordered.length,
    realizedEdges: ordered.map((edge) => ({ entity: edge.entity, prefab: edge.prefab, start: edge.start, end: edge.end,
      startNode: edge.startNode ?? null, endNode: edge.endNode ?? null })),
    SOURCE_SIDE_JOIN: sourceSideJoin ? "PASS" : "FAIL",
    sourceRoadEndpointNode: sourceRoadNode,
    realizedSegmentStartNode: firstStartNode,
    realizedStartNodeIdentityDiffersFromSourceNode: sourceRoadNode.index !== firstStartNode.index || sourceRoadNode.version !== firstStartNode.version,
    sourceToFirstSegmentReachable,
    REALIZED_MIDPOINT_NODE: terminalRef,
    REALIZED_MIDPOINT_3D_POSITION: terminal?.position ?? null,
    MIDPOINT_CURRENT_GENERATION_BINDING: terminalBinding.generation === world.generation && topologyPass ? "PASS" : "FAIL",
    sourceToMidpointReachable: terminalTopology.targetNetwork?.targetNetworkReachable ?? null,
    SEGMENT_1_TOPOLOGY_POSTCONDITION: routeCoverage && sourceSideJoin && topologyPass ? "PASS" : "FAIL",
    midpointTopologyBinding: terminalBinding,
    NATIVE_MUTATION_COUNT: 0, AUTHORIZATION_COUNT: 0, SAVE: 0, calls,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally { await client.close().catch(() => undefined); }
