/**
 * Water Phase 7: one production NETWORK_LINK_REPAIR step followed by fresh,
 * read-only Segment 2 certification. Segment 2 is never authorized here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import type { Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import type { GreenfieldUtilityExecutionScope } from "../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import type { UtilityEndpointBinding } from "../src/main/services/ai-mayor/v2/utility-endpoints";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const expectedMvid = "791c5d8a-a59e-4c13-8bcb-421ead042e76";
const repairId = "water-phase7-segment1-network-link-20260924-r4";
const lineage = "water-phase7-live-cable-lineage-20260924";
const cable = "Low-voltage Ground Cable";
const midpoint = { x: -737.33536, z: 727.868744 };
const pumpTargetXZ = { x: -226.909, z: 1316.5 };
const bannedTools = new Set(["cs2_save_game", "cs2_run_simulation", "cs2_build_road", "cs2_build_pipe", "cs2_place_building", "cs2_demolish", "cs2_zone", "cs2_bulldoze"]);
const object = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const completeRead = (value: Record<string, any>) => value.complete === true ||
  (Number.isFinite(Number(value.totalMatches)) && Number(value.returned) === Number(value.totalMatches));

async function main() {
  const appData = process.env.APPDATA;
  const userProfile = process.env.USERPROFILE ?? os.homedir();
  if (!appData) throw new Error("APPDATA_UNAVAILABLE");
  const bridgeLog = path.join(userProfile, "AppData", "LocalLow", "Colossal Order", "Cities Skylines II", "Logs", "CS2MCP.log");
  const deployedDll = path.join(userProfile, "AppData", "LocalLow", "Colossal Order", "Cities Skylines II", "Mods", "CS2MCP", "CS2MCP.dll");
  const deployedMvid = execFileSync("dotnet", ["run", "--no-build", "--project", "scripts/_tmp-game-il-inspect", "--", deployedDll], { encoding: "utf8" })
    .match(/ASSEMBLY_MVID\s+([\w-]+)/)?.[1] ?? null;
  const client = new Client({ name: "5ire-water-phase7-network-link-production", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (bannedTools.has(name)) throw new Error(`OUT_OF_SCOPE_TOOL_BLOCKED:${name}`);
    if (name === "cs2_mayor_execute_actions" && calls.filter((call) => call.name === name).length >= 1) {
      throw new Error("NATIVE_MUTATION_LIMIT_REACHED");
    }
    calls.push({ name, args });
    const response = await client.callTool({ name, arguments: args });
    const text = response.content?.find((block) => block.type === "text")?.text;
    if (response.isError === true) throw new Error(`${name}:${text ?? "MCP_TOOL_ERROR"}`);
    try { return text ? JSON.parse(text) : response; } catch { throw new Error(`${name}:INVALID_JSON`); }
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((item) => ({ name: `live--${item.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await tool(name.replace(/^live--/, ""), args)) }],
    }),
  };

  try {
    const foundation = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: createCanonicalDurableStateStorage(appData) });
    const durability = foundation.durability;
    if (!durability || !foundation.activateDurableWorld) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    const activation = await foundation.activateDurableWorld();
    if (!durability.isExecutionDurablyActivated(activation)) throw new Error("DURABLE_WORLD_ACTIVATION_NOT_CONFIRMED");
    const initial = object(await tool("cs2_game_state"));
    const world = object(initial.world); const simulation = object(initial.simulation);
    if (simulation.paused !== true || world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle" ||
      world.worldId !== activation.world.worldId || world.generation !== activation.world.generation) {
      throw new Error("LIVE_WORLD_NOT_PAUSED_IDLE_CURRENT_GENERATION");
    }
    const epoch = String(world.bridgeRuntimeEpoch ?? "");
    const runtimeLine = fs.readFileSync(bridgeLog, "utf8").split(/\r?\n/).find((line) =>
      line.includes("RUNTIME_ASSEMBLY_IDENTITY") && line.includes(`bridgeRuntimeEpoch="${epoch}"`));
    const runtimeMvid = runtimeLine?.match(/moduleVersionId="([\w-]+)"/)?.[1] ?? null;
    if (runtimeMvid !== expectedMvid || deployedMvid !== expectedMvid) throw new Error(`RUNTIME_DEPLOYED_MVID_PARITY_FAILED:${runtimeMvid}:${deployedMvid}`);

    const state = durability.projectState() as Gate1State | null;
    if (!state || state.project.status !== "ACTIVE" || state.tranche.stage !== "ROAD_DELIVERED") throw new Error("CURRENT_PROJECT_BINDING_UNEXPECTED");
    const delivered = certifyDeliveredRoad({ state, world: activation.world, journal: durability.commandJournal });
    if (delivered.status !== "CERTIFIED") throw new Error(`DELIVERED_ROAD_NOT_CERTIFIED:${delivered.reason}`);
    const overview = object(await tool("cs2_city_overview"));
    const effectiveAmendment = durability.utilityBudgetAmendments()
      .filter((entry) => entry.projectId === state.project.id && entry.status !== "SUPERSEDED_UNUSED")
      .reduce<ReturnType<typeof durability.utilityBudgetAmendments>[number] | null>(
        (latest, entry) => !latest || entry.amendedEffectiveBudget > latest.amendedEffectiveBudget ? entry : latest,
        null,
      );
    const preparation = buildUtilityPreparationInput({ state, world: activation.world, treasury: Number(overview.treasury), kind: "water",
      connectionOnly: true, certifiedRoad: delivered.target, certifiedRoadRefs: delivered.refs, utilityBudgetAmendment: effectiveAmendment });
    const prepared = await foundation.greenfieldUtilityBootstrap.prepare(preparation);
    if (prepared.status !== "READY" || !prepared.executionScope) throw new Error(`PRODUCTION_SCOPE_PREPARATION_FAILED:${prepared.status === "READY" ? "NO_SCOPE" : prepared.reason}`);
    const scope = { ...prepared.executionScope, commissionedKinds: ["electricity"] } as GreenfieldUtilityExecutionScope;

    const [windRead, mediumRead, pumpRead, waterPipeRead] = await Promise.all([
      tool("cs2_list_buildings", { query: "WindTurbine03", limit: 64 }),
      tool("cs2_list_roads", { query: "Medium Road", limit: 500 }),
      tool("cs2_list_buildings", { query: "GroundwaterPumpingStation01", limit: 64 }),
      tool("cs2_list_roads", { query: "Small Water Pipe", limit: 500 }),
    ]);
    for (const read of [windRead, mediumRead, pumpRead, waterPipeRead]) {
      if (!completeRead(read) || read.truncated === true || read.hasMore === true) {
        throw new Error(`CURRENT_GENERATION_REBIND_READ_INCOMPLETE:${JSON.stringify({ complete: read.complete, totalMatches: read.totalMatches, returned: read.returned })}`);
      }
    }
    const turbines = array(windRead.buildings).filter((item) => item.isSubBuilding !== true && item.prefab === "WindTurbine03");
    const pumps = array(pumpRead.buildings).filter((item) => item.isSubBuilding !== true && item.prefab === "GroundwaterPumpingStation01");
    if (turbines.length !== 1 || pumps.length !== 1 || array(waterPipeRead.roads).length !== 2) throw new Error("SOURCE_PUMP_OR_WATER_PIPE_REBIND_NOT_UNIQUE");
    const turbine = turbines[0]; const turbineEntity = object(turbine.entity); const turbinePosition = object(turbine.position);
    const mediumMatches = array(mediumRead.roads).filter((edge) => edge.prefab === "Medium Road" &&
      Math.hypot(Number(object(edge.end).x) + 1247.76172, Number(object(edge.end).z) - 139.237488) <= 0.25);
    if (mediumMatches.length !== 1) throw new Error("POWERED_SOURCE_MEDIUM_ROAD_REBIND_NOT_UNIQUE");
    const sourceRoad = mediumMatches[0]; const sourceRoadEntity = object(sourceRoad.entity);
    const sourceConnectorRead = object(await tool("cs2_utility_connectors", { index: turbineEntity.index, version: turbineEntity.version }));
    const sourceConnectors = array(sourceConnectorRead.connectors).filter((entry) => entry.type === "electricity");
    if (sourceConnectors.length !== 1) throw new Error("POWERED_SOURCE_CONNECTOR_NOT_UNIQUE");
    const sourceConnector = object(sourceConnectors[0]); const sourceConnectorNode = object(sourceConnector.node);
    const sourceTopologyResponse = object(await tool("cs2_utility_connectors", {
      index: turbineEntity.index, version: turbineEntity.version, topology: true,
      connectorIndex: sourceConnectorNode.index, connectorVersion: sourceConnectorNode.version,
      targetIndex: sourceRoadEntity.index, targetVersion: sourceRoadEntity.version,
      expectedWorldId: world.worldId, expectedGeneration: world.generation,
      admittedPrefab: cable, admittedStart: { x: -1247.76172, z: 139.237488 },
      admittedEnd: { x: midpoint.x, z: midpoint.z }, endpointTolerance: 0.25,
    }));
    const sourceTopology = Object.keys(object(sourceTopologyResponse.topology)).length ? object(sourceTopologyResponse.topology) : sourceTopologyResponse;
    const sourceEndpoints = array(object(sourceTopology.targetNetwork).targetEndpoints).filter((entry) =>
      String(entry.role ?? entry.endpointRole).toUpperCase() === "END" &&
      Math.hypot(Number(object(entry.position).x) + 1247.76172, Number(object(entry.position).z) - 139.237488) <= 0.25);
    if ((sourceTopology.bindingStatus ?? object(sourceTopology.binding).bindingStatus) !== "VALID" ||
      object(sourceTopology.targetNetwork).targetNetworkReachable !== true || sourceEndpoints.length !== 1) {
      throw new Error("POWERED_SOURCE_TOPOLOGY_REBIND_FAILED");
    }
    const sourceEndpoint = sourceEndpoints[0]; const sourceNode = object(sourceEndpoint.node); const sourcePosition = object(sourceEndpoint.position);
    const sourceLookup = {
      networkEdgePrefab: "Medium Road",
      edgeGeometry: { x1: Number(object(sourceRoad.start).x), z1: Number(object(sourceRoad.start).z),
        x2: Number(object(sourceRoad.end).x), z2: Number(object(sourceRoad.end).z) },
      edgeEndpointRole: "END" as const,
      sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: Number(turbinePosition.x), y: Number(turbinePosition.y), z: Number(turbinePosition.z) }, connectorUtility: "ELECTRICITY" as const },
      requireSourceReachability: true,
    };

    const pump = pumps[0]; const pumpEntity = object(pump.entity);
    const pumpAccess = object(await tool("cs2_building_access", { index: pumpEntity.index, version: pumpEntity.version }));
    const accessEntity = object(object(pumpAccess.roadAttachment).roadEdge);
    const localRoadRead = await tool("cs2_list_roads", { query: "Small Road", limit: 500 });
    if (!completeRead(localRoadRead) || localRoadRead.truncated === true || localRoadRead.hasMore === true) throw new Error("PUMP_ACCESS_ROAD_SCAN_INCOMPLETE");
    const accessRoads = array(localRoadRead.roads).filter((edge) => Number(object(edge.entity).index) === Number(accessEntity.index) &&
      Number(object(edge.entity).version) === Number(accessEntity.version));
    if (accessRoads.length !== 1 || !object(pumpAccess.roadAttachment).reciprocalConnectedBuilding) throw new Error("PUMP_ACCESS_ROAD_NOT_ATTACHED");
    const accessRoad = accessRoads[0];
    // The Pump reports its consumer service but has no electricity connector of
    // its own until the road-side network is energized. Rebind the target node
    // from the certified powered WindTurbine source against the Pump's attached
    // access-road edge, and require its exact local-road endpoint role/position.
    const targetTopologyResponse = object(await tool("cs2_utility_connectors", {
      index: turbineEntity.index, version: turbineEntity.version, topology: true,
      connectorIndex: sourceConnectorNode.index, connectorVersion: sourceConnectorNode.version,
      targetIndex: accessEntity.index, targetVersion: accessEntity.version,
      expectedWorldId: world.worldId, expectedGeneration: world.generation,
      admittedPrefab: cable, admittedStart: midpoint, admittedEnd: pumpTargetXZ, endpointTolerance: 0.25,
    }));
    const targetTopology = Object.keys(object(targetTopologyResponse.topology)).length ? object(targetTopologyResponse.topology) : targetTopologyResponse;
    const targetEndpoints = array(object(targetTopology.targetNetwork).targetEndpoints).filter((entry) =>
      String(entry.role ?? entry.endpointRole).toUpperCase() === "START" &&
      Math.hypot(Number(object(entry.position).x) - Number(object(accessRoad.start).x), Number(object(entry.position).z) - Number(object(accessRoad.start).z)) <= 0.25);
    if ((targetTopology.bindingStatus ?? object(targetTopology.binding).bindingStatus) !== "VALID" || targetEndpoints.length !== 1) {
      throw new Error("PUMP_ACCESS_ELECTRICITY_ENDPOINT_REBIND_FAILED");
    }
    const targetPosition = object(targetEndpoints[0].position);
    const targetLookup = {
      networkEdgePrefab: "Small Road",
      edgeGeometry: { x1: Number(object(accessRoad.start).x), z1: Number(object(accessRoad.start).z),
        x2: Number(object(accessRoad.end).x), z2: Number(object(accessRoad.end).z) },
      edgeEndpointRole: "START" as const,
      sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: Number(turbinePosition.x), y: Number(turbinePosition.y), z: Number(turbinePosition.z) }, connectorUtility: "ELECTRICITY" as const },
      requireSourceReachability: false,
    };
    const existing = (role: "START" | "END", expectedPosition: { x: number; y: number; z: number }, lookup: typeof sourceLookup | typeof targetLookup,
      bindingRule: string, topologyRole: string): UtilityEndpointBinding => ({ mode: "EXISTING_NET_NODE", role,
        utility: "ELECTRICITY", prefab: cable, expectedPosition, bindingRule, topologyRole, topologyLookup: lookup });
    const free = (position: { x: number; z: number }): UtilityEndpointBinding => ({ mode: "FREE_POINT", role: "END",
      utility: "ELECTRICITY", prefab: cable, expectedPosition: { x: position.x, y: 0, z: position.z },
      bindingRule: "NEW_FREE_COURSE_TERMINAL", topologyRole: "COURSE_TERMINAL" });
    const segment1 = { type: "build_road" as const, prefab: cable, x1: -1247.76172, z1: 139.237488, x2: midpoint.x, z2: midpoint.z,
      utilityEndpoints: {
        start: existing("START", { x: Number(sourcePosition.x), y: Number(sourcePosition.y), z: Number(sourcePosition.z) }, sourceLookup,
          "POWERED_SOURCE_ROAD_NODE", "POWERED_ELECTRICITY_NODE"),
        end: free(midpoint),
      } };
    const midpointLookup = { ...sourceLookup, networkEdgePrefab: cable,
      edgeGeometry: { x1: segment1.x1, z1: segment1.z1, x2: segment1.x2, z2: segment1.z2 } };
    const segment2Action = { type: "build_road" as const, prefab: cable, x1: midpoint.x, z1: midpoint.z, x2: pumpTargetXZ.x, z2: pumpTargetXZ.z,
      utilityEndpoints: {
        start: existing("START", { x: midpoint.x, y: 0, z: midpoint.z }, midpointLookup,
          "REALIZED_SEGMENT_1_MIDPOINT", "LV_CABLE_TERMINAL"),
        end: existing("END", { x: Number(targetPosition.x), y: Number(targetPosition.y), z: Number(targetPosition.z) }, targetLookup,
          "PUMP_ACCESS_ROAD_ELECTRICITY_NODE", "LOCAL_ROAD_ELECTRICITY_NODE"),
      } };
    const plan = { repairLineage: lineage, actions: [segment1, segment2Action] as const };

    const beforeAuth = array((durability.projectState() as Gate1State).tranche.utilityExecution?.utilities.electricity.candidateLedger)
      .filter((entry: any) => entry.candidateId === `${repairId}:step:1`);
    if (beforeAuth.length !== 0) throw new Error("SEGMENT_1_AUTHORIZATION_ALREADY_EXISTS");
    const preflight = await foundation.greenfieldUtilityBootstrap.advanceSequentialUtilityRepair({ scope, repairId, plan,
      expectedQuoteByStep: { 1: 792 }, stopAfterStep1Admission: true });
    const certified = preflight.repair.state.actions[0];
    const firstNativeCalls = calls.filter((entry) => entry.name === "cs2_mayor_execute_actions").length;
    const afterPreflightAuth = array((durability.projectState() as Gate1State).tranche.utilityExecution?.utilities.electricity.candidateLedger)
      .filter((entry: any) => entry.candidateId === `${repairId}:step:1`);
    if (preflight.repair.status !== "WAITING" || preflight.repair.reason !== "ACTION_1_PRODUCTION_ADMISSION_COMPLETE_AUTHORIZATION_NOT_REQUESTED" ||
      certified?.state !== "CERTIFIED" || certified.quote !== 792 || certified.generation !== world.generation ||
      firstNativeCalls !== 0 || afterPreflightAuth.length !== 0) {
      throw new Error(`SEGMENT_1_FRESH_PRODUCTION_PREFLIGHT_FAILED:${JSON.stringify({ reason: preflight.repair.reason,
        state: certified?.state, quote: certified?.quote, generation: certified?.generation, firstNativeCalls, authorizationCount: afterPreflightAuth.length })}`);
    }

    // Fresh admission is re-run inside the same production coordinator before
    // the one exact authorization, command, and native action.
    const execution = await foundation.greenfieldUtilityBootstrap.advanceSequentialUtilityRepair({ scope, repairId, plan,
      expectedQuoteByStep: { 1: 792 } });
    const postState = object(await tool("cs2_game_state"));
    if (object(postState.simulation).paused !== true || object(postState.world).nativeOperationStage !== "Idle" ||
      object(postState.world).generation !== world.generation) throw new Error("POST_SEGMENT_1_WORLD_STATE_NOT_STABLE");
    const segment2 = execution.segment2FreshPreflight;
    const action1 = execution.repair.state.actions[0];
    const command1 = action1 ? durability.commandJournal.get(action1.commandId) : null;
    const ledgerAfter = array((durability.projectState() as Gate1State).tranche.utilityExecution?.utilities.electricity.candidateLedger);
    const s1Ledger = ledgerAfter.filter((entry: any) => entry.candidateId === `${repairId}:step:1`);
    const nativeMutationCount = calls.filter((entry) => entry.name === "cs2_mayor_execute_actions").length;
    const saveCount = calls.filter((entry) => entry.name === "cs2_save_game").length;
    const report = {
      LIVE_BRIDGE_SESSION: "PASS", RUNTIME_DEPLOYED_MVID_PARITY: runtimeMvid === deployedMvid ? "PASS" : "FAIL",
      RUNTIME_MVID: runtimeMvid, DEPLOYED_MVID: deployedMvid, CURRENT_GENERATION: world.generation,
      WORLD_PAUSED: true, BRIDGE_IDLE: true, PUMP_ACCESS_ROAD: accessEntity, WATER_PIPES: array(waterPipeRead.roads).length,
      SEGMENT_1_FRESH_PREFLIGHT: preflight.repair.reason, SEGMENT_1_QUOTE: certified?.quote,
      SEGMENT_1_AUTHORIZATION: s1Ledger.length === 1 ? "CONSUMED_EXACTLY_ONCE" : `COUNT_${s1Ledger.length}`,
      SEGMENT_1_COMMAND_COUNT: command1 ? 1 : 0, SEGMENT_1_WORLD_EFFECT: action1?.state === "COMPLETE" ? "PASS" : action1?.state,
      SEGMENT_1_TOPOLOGY_POSTCONDITION: action1?.state === "COMPLETE" ? "PASS" : "FAIL",
      REALIZED_SEGMENT_1_EDGE: action1?.realized?.edge ?? null,
      REALIZED_MIDPOINT_NODE: action1?.realized?.midpointNode ?? null,
      REALIZED_MIDPOINT_3D_POSITION: action1?.realized?.midpointPosition ?? null,
      SEGMENT_2_ELIGIBLE: action1?.state === "COMPLETE" ? "YES" : "NO",
      SEGMENT_2_FRESH_PREFLIGHT: segment2?.preview.valid ? "PASS" : "FAIL",
      SEGMENT_2_NATIVE_PREVIEW: segment2?.preview.valid ? "PASS" : "FAIL", SEGMENT_2_QUOTE: segment2?.preview.quote ?? null,
      SEGMENT_2_DUPLICATE_RISK: segment2?.preview.duplicate ? "YES" : "NO",
      SEGMENT_2_START_ATTACHMENT_MATCH: segment2?.preview.topologyChecks.midpointTerminalBound === "PASS" ? "YES" : "NO",
      SEGMENT_2_END_ATTACHMENT_MATCH: segment2?.preview.topologyChecks.targetAttachmentMatch === "PASS" ? "YES" : "NO",
      SEGMENT_2_TOPOLOGY_PLAN_CERTIFIED: !!segment2?.admission ? "YES" : "NO",
      NATIVE_MUTATION_COUNT: nativeMutationCount, SAVE: saveCount, CALLS: calls.map((entry) => entry.name),
      REPAIR_STATUS: execution.repair.status, FIRST_BLOCKER: execution.repair.status === "STOPPED" ? execution.repair.reason : null,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (nativeMutationCount !== 1 || saveCount !== 0 || action1?.state !== "COMPLETE" || !segment2?.preview.valid || !segment2.admission) {
      throw new Error(`WATER_PHASE7_NETWORK_LINK_ACCEPTANCE_INCOMPLETE:${JSON.stringify(report)}`);
    }
  } finally { await client.close().catch(() => undefined); }
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
