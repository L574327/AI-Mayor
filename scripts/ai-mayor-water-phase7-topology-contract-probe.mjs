import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const client = new Client({ name: "water-phase7-topology-contract-probe", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
const allowed = new Set(["cs2_game_state", "cs2_list_buildings", "cs2_list_roads", "cs2_utility_connectors", "cs2_building_access", "cs2_spatial"]);
const calls = [];
const call = async (name, args = {}) => {
  if (!allowed.has(name)) throw new Error(`READ_ONLY_TOOL_DENIED:${name}`);
  calls.push(name);
  const result = await client.callTool({ name, arguments: args });
  const block = result.content?.find((part) => part.type === "text");
  return block?.text ? JSON.parse(block.text) : result;
};
const entity = (value) => ({ index: Number(value?.index), version: Number(value?.version) });
try {
  const state = await call("cs2_game_state");
  const world = state.world ?? {};
  const simulation = state.simulation ?? {};
  if (simulation.paused !== true || world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle") {
    throw new Error("WORLD_NOT_PAUSED_BRIDGE_NOT_IDLE");
  }
  const [turbines, mediumRoads, smallRoads, cables, pumps] = await Promise.all([
    call("cs2_list_buildings", { query: "WindTurbine03", limit: 20 }),
    call("cs2_list_roads", { query: "Medium Road", limit: 500 }),
    call("cs2_list_roads", { query: "Small Road", limit: 500 }),
    call("cs2_list_roads", { query: "Low-voltage Ground Cable", limit: 500 }),
    call("cs2_list_buildings", { query: "GroundwaterPumpingStation01", limit: 20 }),
  ]);
  const turbine = turbines.buildings?.find((item) => item.isSubBuilding !== true);
  const pump = pumps.buildings?.find((item) => item.isSubBuilding !== true);
  if (!turbine || !pump) throw new Error("CURRENT_TURBINE_OR_PUMP_REBIND_FAILED");
  const [windConnectorRead, pumpAccess] = await Promise.all([
    call("cs2_utility_connectors", entity(turbine.entity)),
    call("cs2_building_access", entity(pump.entity)),
  ]);
  const windConnector = windConnectorRead.connectors?.find((item) => item.type === "electricity");
  const accessEntity = pumpAccess.roadAttachment?.roadEdge;
  if (!windConnector || !accessEntity) throw new Error("CURRENT_SOURCE_CONNECTOR_OR_PUMP_ROAD_MISSING");
  const accessRoad = smallRoads.roads?.find((item) => item.entity?.index === accessEntity.index && item.entity?.version === accessEntity.version);
  const sourceMedium = mediumRoads.roads?.find((item) => Math.hypot(Number(item.end?.x) + 1247.76172, Number(item.end?.z) - 139.237488) < 0.25);
  if (!accessRoad || !sourceMedium) throw new Error("CURRENT_SOURCE_OR_ACCESS_ROAD_EDGE_REBIND_FAILED");
  const [sourceTopology, localTopology] = await Promise.all([
    call("cs2_utility_connectors", {
      ...entity(turbine.entity), topology: true,
      connectorIndex: windConnector.node.index, connectorVersion: windConnector.node.version,
      targetIndex: sourceMedium.entity.index, targetVersion: sourceMedium.entity.version,
      expectedWorldId: world.worldId, expectedGeneration: world.generation,
    }),
    call("cs2_utility_connectors", {
      ...entity(turbine.entity), topology: true,
      connectorIndex: windConnector.node.index, connectorVersion: windConnector.node.version,
      targetIndex: accessEntity.index, targetVersion: accessEntity.version,
      expectedWorldId: world.worldId, expectedGeneration: world.generation,
    }),
  ]);
  const sourceTopologyRead = sourceTopology.topology ?? sourceTopology;
  const localTopologyRead = localTopology.topology ?? localTopology;
  const endpointAt = (topology, x, z) => topology.targetNetwork?.targetEndpoints?.find((item) => Math.hypot(Number(item.position?.x) - x, Number(item.position?.z) - z) <= 0.25);
  const sourceEndpoint = endpointAt(sourceTopologyRead, -1247.76172, 139.237488);
  const targetEndpoint = endpointAt(localTopologyRead, -226.909, 1316.5);
  const startNode = sourceEndpoint?.node;
  const targetNode = targetEndpoint?.node;
  const targetFlowNode = targetEndpoint?.electricityFlowNode;
  if (!startNode || !targetNode || !targetFlowNode) {
    process.stdout.write(JSON.stringify({
      world: { worldId: world.worldId, generation: world.generation, frameIndex: simulation.frameIndex, paused: simulation.paused },
      sourceRoad: sourceMedium, accessRoad,
      sourceEndpoints: sourceTopologyRead.targetNetwork?.targetEndpoints,
      accessEndpoints: localTopologyRead.targetNetwork?.targetEndpoints,
      callLog: calls, infrastructureMutations: 0, authorizationCalls: 0, saveCalls: 0,
    }, null, 2) + "\n");
    throw new Error("ROAD_NODE_OR_LOCAL_FLOW_NODE_BINDING_UNAVAILABLE");
  }
  const startPos = sourceEndpoint.position;
  const targetPos = targetEndpoint.position;
  const geometry1 = { prefab: "Low-voltage Ground Cable", x1: -1247.76172, z1: 139.237488, x2: -737.33536, z2: 727.868744 };
  const geometry2 = { prefab: "Low-voltage Ground Cable", x1: -737.33536, z1: 727.868744, x2: -226.909, z2: 1316.5 };
  const segment1FreePreview = await call("cs2_spatial", { mode: "preflight", kind: "net", ...geometry1 });
  const idleAfterSegment1Free = await call("cs2_game_state");
  if (idleAfterSegment1Free.world?.nativeOperationStage !== "Idle") throw new Error("BRIDGE_NOT_IDLE_AFTER_SEGMENT1_FREE_PREVIEW");
  const segment1BoundSourcePreview = await call("cs2_spatial", {
    mode: "preflight", kind: "net", ...geometry1,
    startEndpoint: { kind: "EXISTING_NET_NODE", role: "START", entity: entity(startNode), expectedPosition: startPos, worldEpoch: world.generation },
  });
  const idleAfterSegment1Bound = await call("cs2_game_state");
  if (idleAfterSegment1Bound.world?.nativeOperationStage !== "Idle") throw new Error("BRIDGE_NOT_IDLE_AFTER_SEGMENT1_BOUND_PREVIEW");
  const segment2TargetContractPreview = await call("cs2_spatial", {
    mode: "preflight", kind: "net", ...geometry2,
    endEndpoint: {
      kind: "NEW_FREE_ENDPOINT", role: "END", entity: null, expectedPosition: targetPos,
      worldEpoch: world.generation, utility: "ELECTRICITY", semanticRole: "NETWORK_ENTRY",
      geometricContact: { roadEdge: entity(accessEntity), roadNode: entity(targetNode), position: targetPos, endpointRole: "END" },
      topologyExpectation: { flowNode: entity(targetFlowNode), roadEdge: entity(accessEntity), expectedReachability: "ELECTRICITY" },
    },
  });
  const idleAfterSegment2Free = await call("cs2_game_state");
  if (idleAfterSegment2Free.world?.nativeOperationStage !== "Idle") throw new Error("BRIDGE_NOT_IDLE_AFTER_SEGMENT2_FREE_TARGET_PREVIEW");
  const segment2BoundTargetPreview = await call("cs2_spatial", {
    mode: "preflight", kind: "net", ...geometry2,
    endEndpoint: { kind: "EXISTING_NET_NODE", role: "END", entity: entity(targetNode), expectedPosition: targetPos, worldEpoch: world.generation },
  });
  const final = await call("cs2_game_state");
  if (final.simulation?.paused !== true || final.simulation?.frameIndex !== simulation.frameIndex || final.world?.generation !== world.generation) {
    throw new Error("WORLD_CHANGED_DURING_READ_ONLY_PROBE");
  }
  const previewSummary = (preview) => {
    const realization = preview.diagnostics?.realization ?? {};
    const temp = realization.generatedTempEntities ?? [];
    return ({
    valid: preview.valid, previewOnly: preview.previewOnly, quote: preview.finance?.signedAmount ?? preview.signedAmount ?? null,
    reason: preview.reason ?? null, errorCode: preview.errorCode ?? null,
    toolError: preview.error ?? preview.isError ?? null,
    rawError: preview.valid === true ? null : preview,
    diagnosticsKeys: Object.keys(preview.diagnostics ?? {}),
    realization: {
      realizedStartEntity: realization.realizedStartEntity ?? null,
      realizedEndEntity: realization.realizedEndEntity ?? null,
      attachmentMatch: realization.attachmentMatch ?? null,
      endAttachmentMatch: realization.endAttachmentMatch ?? null,
      startPosition: realization.startPosition ?? null,
      endPosition: realization.endPosition ?? null,
      generatedEdgeCount: realization.generatedEdgeCount ?? null,
      generatedNodeCount: realization.generatedNodeCount ?? null,
      tempTopologySummary: {
        edgeCount: temp.filter((item) => item.kind === "EDGE").length,
        nodeCount: temp.filter((item) => item.kind === "NODE").length,
        proposalEdgeCount: temp.filter((item) => item.kind === "EDGE" && item.original == null).length,
        reboundCurrentEdges: temp.filter((item) => item.kind === "EDGE" && item.original != null).map((item) => item.original),
        reboundCurrentNodes: temp.filter((item) => item.kind === "NODE" && item.original != null).map((item) => item.original),
      },
    },
    coursePositionEndpoint: preview.diagnostics?.courseSplitDiagnostics?.preSplitEnd ?? null,
    courseCreation: preview.diagnostics?.courseSplitDiagnostics?.creation ?? null,
    localConnectPatchTelemetry: preview.diagnostics?.courseSplitDiagnostics?.localConnectPatchTelemetry ?? null,
    endpointContract: preview.diagnostics?.endpointContract ?? null,
    electricityGraph: preview.diagnostics?.endpointContract?.postApply?.electricityGraph ?? null,
    endRealizationTelemetry: preview.diagnostics?.endRealizationTelemetry ?? null,
    attachment: preview.diagnostics?.attachment ?? null,
    validation: preview.diagnostics?.validation ?? null,
  });
  };
  const report = {
    world: { worldId: world.worldId, generation: world.generation, frameIndex: simulation.frameIndex, paused: simulation.paused, bridgeStage: world.nativeOperationStage, bridgeRuntimeEpoch: world.bridgeRuntimeEpoch },
    finalWorld: { worldId: final.world?.worldId, generation: final.world?.generation, frameIndex: final.simulation?.frameIndex, paused: final.simulation?.paused, bridgeStage: final.world?.nativeOperationStage, bridgeRuntimeEpoch: final.world?.bridgeRuntimeEpoch },
    source: { turbine: turbine.entity, electricityConnector: windConnector.node, mediumRoad: sourceMedium,
      endpoint: sourceEndpoint, sourceJoinReachable: sourceTopologyRead.targetNetwork?.targetNetworkReachable,
      topologyBinding: sourceTopologyRead.binding, sourceFlowNode: sourceTopologyRead.connector?.flowNode,
      sourceFlowNetworkConnected: sourceTopologyRead.connector?.networkConnected },
    target: { pump: pump.entity, accessRoad: accessRoad, endpoint: targetEndpoint,
      localComponentTopologyBinding: localTopologyRead.binding,
      sourceToLocalReachableBeforeRepair: localTopologyRead.targetNetwork?.targetNetworkReachable,
      localComponentComplete: localTopologyRead.targetNetwork?.complete,
      localComponentTruncated: localTopologyRead.targetNetwork?.truncated },
    currentLvCableEntities: (cables.roads ?? []).map((edge) => ({ entity: edge.entity, start: edge.start, end: edge.end, startNode: edge.startNode, endNode: edge.endNode })),
    previews: { segment1FreePreview: previewSummary(segment1FreePreview), segment1BoundSourcePreview: previewSummary(segment1BoundSourcePreview),
      segment2TargetContractPreview: previewSummary(segment2TargetContractPreview), segment2BoundTargetPreview: previewSummary(segment2BoundTargetPreview) },
    readOnlyCallLog: calls,
    infrastructureMutations: 0,
    authorizationCalls: 0,
    saveCalls: 0,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  await (await import("node:fs/promises")).writeFile("docs/ai-mayor/evidence/water-phase7-two-segment-topology-contract-2026-09-24.json", json, "utf8");
  process.stdout.write(json);
} finally {
  await client.close();
}
