import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const client = new Client({ name: "water-phase7-segment1-production-preflight", version: "1.0.0" });
const allowed = new Set(["cs2_game_state", "cs2_list_buildings", "cs2_list_roads", "cs2_utility_connectors", "cs2_spatial"]);
const calls = [];
const call = async (name, args = {}) => {
  if (!allowed.has(name)) throw new Error(`READ_ONLY_TOOL_DENIED:${name}`);
  calls.push({ name, args });
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (response.isError === true) throw new Error(`${name}:${text ?? "MCP_TOOL_ERROR"}`);
  const payload = text ? JSON.parse(text) : response;
  return payload;
};
const ref = (v) => ({ index: Number(v?.index), version: Number(v?.version) });
const distance2 = (a, b) => Math.hypot(Number(a?.x) - b.x, Number(a?.z) - b.z);
const completeRead = (read) => read.complete === true ||
  (Number.isFinite(Number(read.totalMatches)) && Number(read.returned) === Number(read.totalMatches));

try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const initial = await call("cs2_game_state");
  const generation = initial.world?.generation;
  const worldId = initial.world?.worldId;
  const frameIndex = initial.simulation?.frameIndex;
  if (!worldId || !generation || initial.simulation?.paused !== true || initial.world?.nativeOperationBusy !== false || initial.world?.nativeOperationStage !== "Idle") {
    throw new Error("LIVE_WORLD_NOT_PAUSED_IDLE_OR_BOUND");
  }
  const [wind, medium, cables] = await Promise.all([
    call("cs2_list_buildings", { query: "WindTurbine03", limit: 64 }),
    call("cs2_list_roads", { query: "Medium Road", limit: 500 }),
    call("cs2_list_roads", { query: "Low-voltage Ground Cable", limit: 500 }),
  ]);
  for (const read of [wind, medium, cables]) {
    if (!completeRead(read) || read.truncated === true || read.hasMore === true) throw new Error(`CURRENT_WORLD_REBIND_SCAN_INCOMPLETE:${JSON.stringify({ complete: read.complete, totalMatches: read.totalMatches, returned: read.returned, truncated: read.truncated, hasMore: read.hasMore })}`);
  }
  const turbines = (wind.buildings ?? []).filter((row) => row.isSubBuilding !== true && row.prefab === "WindTurbine03");
  if (turbines.length !== 1) throw new Error(`WIND_TURBINE_REBIND_NOT_UNIQUE:${turbines.length}`);
  const sourceRoads = (medium.roads ?? []).filter((row) => row.prefab === "Medium Road" &&
    (distance2(row.start, { x: -1247.76172, z: 139.237488 }) <= 0.25 || distance2(row.end, { x: -1247.76172, z: 139.237488 }) <= 0.25));
  if (sourceRoads.length !== 1) throw new Error(`SOURCE_MEDIUM_ROAD_REBIND_NOT_UNIQUE:${sourceRoads.length}`);
  const sourceEntity = ref(turbines[0].entity);
  const sourceRoad = sourceRoads[0];
  const connectorRead = await call("cs2_utility_connectors", sourceEntity);
  const electricityConnectors = (connectorRead.connectors ?? []).filter((connector) => connector.type === "electricity");
  if (electricityConnectors.length !== 1) throw new Error(`SOURCE_ELECTRICITY_CONNECTOR_NOT_UNIQUE:${electricityConnectors.length}`);
  const connector = electricityConnectors[0];
  const geometry = { prefab: "Low-voltage Ground Cable", x1: -1247.76172, z1: 139.237488, x2: -737.33536, z2: 727.868744 };
  const sourceTopologyRaw = await call("cs2_utility_connectors", {
    ...sourceEntity, topology: true,
    connectorIndex: connector.node.index, connectorVersion: connector.node.version,
    targetIndex: sourceRoad.entity.index, targetVersion: sourceRoad.entity.version,
    expectedWorldId: worldId, expectedGeneration: generation,
    expectedTopologyRevision: `${generation}:${sourceRoad.entity.index}:${sourceRoad.entity.version}`,
    admittedPrefab: geometry.prefab, admittedStart: { x: geometry.x1, z: geometry.z1 },
    admittedEnd: { x: geometry.x2, z: geometry.z2 }, endpointTolerance: 0.25,
  });
  const sourceTopology = sourceTopologyRaw.topology ?? sourceTopologyRaw;
  const sourceTopologyBinding = sourceTopology.binding ?? {};
  const endpoint = (sourceTopology.targetNetwork?.targetEndpoints ?? []).filter((entry) =>
    String(entry.role ?? entry.endpointRole ?? "").toLowerCase() === "end" &&
    Math.hypot(Number(entry.position?.x) + 1247.76172, Number(entry.position?.z) - 139.237488) <= 0.25);
  if ((sourceTopology.bindingStatus ?? sourceTopologyBinding.bindingStatus) !== "VALID" ||
    (sourceTopology.complete ?? sourceTopologyBinding.complete) !== true ||
    sourceTopology.truncated === true || sourceTopologyBinding.truncated === true ||
    sourceTopology.targetNetwork?.targetNetworkReachable !== true || endpoint.length !== 1 || !endpoint[0].electricityFlowNode) {
    throw new Error(`SEGMENT_1_SOURCE_TOPOLOGY_REBIND_FAILED:${JSON.stringify({ bindingStatus: sourceTopology.bindingStatus ?? sourceTopologyBinding.bindingStatus, complete: sourceTopology.complete ?? sourceTopologyBinding.complete, truncated: sourceTopology.truncated ?? sourceTopologyBinding.truncated, reachable: sourceTopology.targetNetwork?.targetNetworkReachable, endpoints: sourceTopology.targetNetwork?.targetEndpoints })}`);
  }
  const sourceNode = ref(endpoint[0].node);
  const sourcePosition = endpoint[0].position;
  const startEndpoint = {
    kind: "EXISTING_NET_NODE", role: "START", entity: sourceNode, expectedPosition: sourcePosition,
    worldEpoch: generation, utility: "ELECTRICITY", semanticRole: "NETWORK_ENTRY",
    bindingRule: "POWERED_SOURCE_ROAD_NODE", topologyRole: "POWERED_ELECTRICITY_NODE",
  };
  const endEndpoint = {
    kind: "NEW_FREE_ENDPOINT", role: "END", entity: null,
    expectedPosition: { x: geometry.x2, y: 0, z: geometry.z2 }, worldEpoch: generation,
    utility: "ELECTRICITY", semanticRole: "NETWORK_ENTRY",
    bindingRule: "NEW_FREE_COURSE_TERMINAL", topologyRole: "COURSE_TERMINAL",
  };
  const duplicate = (cables.roads ?? []).some((row) => row.prefab === geometry.prefab &&
    ((distance2(row.start, { x: geometry.x1, z: geometry.z1 }) <= 0.25 && distance2(row.end, { x: geometry.x2, z: geometry.z2 }) <= 0.25) ||
     (distance2(row.end, { x: geometry.x1, z: geometry.z1 }) <= 0.25 && distance2(row.start, { x: geometry.x2, z: geometry.z2 }) <= 0.25)));
  if (duplicate) throw new Error("SEGMENT_1_DUPLICATE_EFFECT_PRESENT_RECONCILE_ONLY");
  const preview = await call("cs2_spatial", { mode: "preflight", kind: "net", ...geometry, startEndpoint, endEndpoint });
  const realization = preview.diagnostics?.realization ?? {};
  const realizedStart = ref(realization.realizedStartEntity);
  const sourceAttachmentMatch = realizedStart.index === sourceNode.index && realizedStart.version === sourceNode.version && realization.attachmentMatch === true;
  const freeEndpointMatch = realization.realizedEndEntity === null && realization.endAttachmentMatch !== true;
  const after = await call("cs2_game_state");
  const sameWorld = after.world?.worldId === worldId && after.world?.generation === generation && after.simulation?.frameIndex === frameIndex;
  const report = {
    WORLD_PAUSED: after.simulation?.paused === true,
    BRIDGE_IDLE: after.world?.nativeOperationBusy === false && after.world?.nativeOperationStage === "Idle",
    CURRENT_GENERATION: generation,
    SOURCE_ENTITY: sourceEntity,
    SOURCE_ROAD_ENTITY: sourceRoad.entity,
    SOURCE_NODE: sourceNode,
    SOURCE_POSITION_3D: sourcePosition,
    SOURCE_COMPONENT_REACHABLE: sourceTopology.targetNetwork?.targetNetworkReachable === true,
    SEGMENT_1_GEOMETRY: geometry,
    SEGMENT_1_TYPED_START: startEndpoint,
    SEGMENT_1_TYPED_END: endEndpoint,
    SEGMENT_1_NATIVE_PREVIEW: preview.valid === true && preview.previewOnly === true,
    SEGMENT_1_QUOTE: preview.finance?.signedAmount ?? preview.signedAmount ?? null,
    SEGMENT_1_SOURCE_ATTACHMENT_MATCH: sourceAttachmentMatch,
    SEGMENT_1_FREE_MIDPOINT_SEMANTICS: freeEndpointMatch,
    SEGMENT_1_DUPLICATE_RISK: duplicate ? "YES" : "NO",
    WORLD_UNCHANGED_DURING_READS: sameWorld,
    NATIVE_MUTATION: 0,
    AUTHORIZATION: 0,
    SAVE: 0,
    CALLS: calls.map((item) => item.name),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.WORLD_PAUSED || !report.BRIDGE_IDLE || !report.SEGMENT_1_NATIVE_PREVIEW ||
    report.SEGMENT_1_QUOTE !== 792 || !report.SEGMENT_1_SOURCE_ATTACHMENT_MATCH || !report.SEGMENT_1_FREE_MIDPOINT_SEMANTICS ||
    report.SEGMENT_1_DUPLICATE_RISK !== "NO" || !report.WORLD_UNCHANGED_DURING_READS) {
    throw new Error("SEGMENT_1_FRESH_PREFLIGHT_NOT_CERTIFIED");
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: String(error?.message ?? error), calls: calls.map((item) => item.name), NATIVE_MUTATION: 0, AUTHORIZATION: 0, SAVE: 0 }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
