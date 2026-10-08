import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createV2FoundationPorts, matchExactNetCourseReadback, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import type { Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import type { GreenfieldUtilityExecutionScope } from "../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON } from "../src/main/services/ai-mayor/v2/utility-budget";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const action = {
  type: "build_road" as const,
  prefab: "Small Road",
  x1: -226.909,
  z1: 1316.5,
  x2: -156.6602929,
  z2: 1312.469691,
  cx: -191.09731268615568,
  cz: 1326.4651448408797,
};
const forbidden = new Set(["cs2_save_game", "cs2_place_building", "cs2_demolish", "cs2_zone", "cs2_build_pipe"]);
const rec = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
const arr = (value: unknown): any[] => Array.isArray(value) ? value : [];

async function main() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA_UNAVAILABLE");
  const storage = createCanonicalDurableStateStorage(appData);
  const client = new Client({ name: "5ire-water-phase7-single-action-production", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (forbidden.has(name)) throw new Error(`OUT_OF_SCOPE_NATIVE_TOOL:${name}`);
    if (name === "cs2_build_road" && calls.filter((entry) => entry.name === name).length !== 0) {
      throw new Error("SINGLE_ACTION_NATIVE_SUBMISSION_LIMIT_REACHED");
    }
    calls.push({ name, args });
    return parseV2McpJson(await client.callTool({ name, arguments: args }));
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await call(name.replace(/^live--/, ""), args)) }],
    }),
  };
  const foundation = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage });
  const durability = foundation.durability;
  let nativeSubmissionMayHaveOccurred = false;
  try {
    if (!durability || !foundation.activateDurableWorld) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    const activation = await foundation.activateDurableWorld();
    if (!durability.isExecutionDurablyActivated(activation)) throw new Error("WORLD_ACTIVATION_NOT_CONFIRMED");
    const state = durability.projectState() as Gate1State | null;
    if (!state || state.project.status !== "ACTIVE" || state.tranche.stage !== "ROAD_DELIVERED") throw new Error("CURRENT_PROJECT_BINDING_UNEXPECTED");
    const delivered = certifyDeliveredRoad({ state, world: activation.world, journal: durability.commandJournal });
    if (delivered.status !== "CERTIFIED") throw new Error(`DELIVERED_ROAD_NOT_CERTIFIED:${delivered.reason}`);
    const utility = state.tranche.utilityExecution?.utilities.water;
    if (!utility?.plan || utility.constructionAttempts !== 1) throw new Error("WATER_FACILITY_PLAN_NOT_CURRENT");
    const beforeGame = rec(await call("cs2_game_state"));
    const beforeWorld = rec(beforeGame.world);
    if (beforeWorld.generation !== activation.world.generation || beforeWorld.worldId !== activation.world.worldId ||
      rec(beforeGame.simulation).paused !== true || beforeWorld.nativeOperationStage !== "Idle" || beforeWorld.nativeOperationBusy !== false) {
      throw new Error("LIVE_WORLD_PAUSED_IDLE_BINDING_FAILED");
    }
    const active = durability.utilityBudgetAmendments().filter((entry) => entry.projectId === state.project.id &&
      entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON && (entry.status === "ACTIVE" || entry.status === undefined));
    if (active.length > 1 || (active.length === 1 && (active[0].courseFingerprint !== JSON.stringify([action]) ||
      active[0].planRevision !== (utility.connectionObjective?.approvedPlanRevision ?? utility.planBinding?.topologyRevision ?? "") ||
      !Number.isFinite(active[0].nativeQuote) || active[0].executionUseStatus !== "UNUSED" || active[0].executionUseLimit !== 1))) {
      throw new Error("CONFLICTING_ACTIVE_REPAIR_AUTHORIZATION");
    }
    const repairCommands = durability.commandJournal.list().filter((entry) => entry.actionFamily === "UTILITY" &&
      entry.authorizedScope.actionFamily === "UTILITY" && entry.authorizedScope.projectId === state.project.id &&
      entry.authorizedScope.utilityKind === "water" && JSON.parse(entry.authorizedScope.exactInput).some?.((item: any) =>
        item?.type === "build_road" && item?.prefab === "Small Road"));
    const exactAction = JSON.stringify([action]);
    const pipeList = rec(await call("cs2_list_roads", { query: "Small Water Pipe", limit: 500 }));
    const pipeEdges = arr(pipeList.roads);
    if (pipeList.truncated === true || pipeList.hasMore === true || Number(pipeList.totalMatches) !== pipeEdges.length || pipeEdges.length !== 2) {
      throw new Error("WATER_PIPE_AUTHORITATIVE_LIST_NOT_INTACT");
    }
    const roadList = rec(await call("cs2_list_roads", { query: "Small Road", limit: 500 }));
    const roads = arr(roadList.roads);
    if (roadList.truncated === true || roadList.hasMore === true || Number(roadList.totalMatches) !== roads.length || roads.length !== 2) {
      throw new Error("FIRST_SMALL_ROAD_AUTHORITATIVE_LIST_NOT_INTACT");
    }
    const duplicate = matchExactNetCourseReadback({ prefab: "Small Road", start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 },
      control: { x: action.cx, z: action.cz }, roads, totalMatches: roadList.totalMatches, returned: roadList.returned,
      truncated: roadList.truncated, hasMore: roadList.hasMore, tolerance: 1 });
    if (duplicate.result !== "MISMATCH" || duplicate.evidence.matchedEdges.length !== 0) throw new Error("SINGLE_ACTION_DUPLICATE_RISK");
    if (repairCommands.some((entry) => entry.status !== "REJECTED" && entry.status !== "OBSERVED_MATCH")) throw new Error("UNRESOLVED_HISTORICAL_ROAD_COMMAND");

    const overview = rec(await call("cs2_city_overview"));
    const preparation = buildUtilityPreparationInput({ state, world: activation.world, treasury: Number(overview.treasury), kind: "water",
      connectionOnly: true, certifiedRoad: delivered.target, certifiedRoadRefs: delivered.refs });
    const prepared = await foundation.greenfieldUtilityBootstrap.prepare(preparation);
    if (prepared.status !== "READY" || !prepared.executionScope) throw new Error(`WATER_REPAIR_EXECUTION_SCOPE_UNAVAILABLE:${prepared.status === "READY" ? "NO_SCOPE" : prepared.reason}`);
    const scope: GreenfieldUtilityExecutionScope = { ...prepared.executionScope, commissionedKinds: ["water"] };
    if (scope.worldId !== activation.world.worldId || scope.generation !== activation.world.generation) throw new Error("PREPARED_SCOPE_WORLD_BINDING_MISMATCH");

    // From this point the production call may cross the one authorized native
    // submission boundary. A thrown/unknown return is never retried.
    nativeSubmissionMayHaveOccurred = true;
    let result: Awaited<ReturnType<typeof foundation.greenfieldUtilityBootstrap.repairFacilityAccessRoad>> | undefined;
    let executionError: string | undefined;
    try {
      result = await foundation.greenfieldUtilityBootstrap.repairFacilityAccessRoad({
        scope, actions: [action], expectedPlanRevision: utility.connectionObjective?.approvedPlanRevision ??
          utility.planBinding?.topologyRevision ?? scope.topologyRevision,
      });
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    }
    const afterGame = rec(await call("cs2_game_state"));
    const afterWorld = rec(afterGame.world);
    const afterRoadList = rec(await call("cs2_list_roads", { query: "Small Road", limit: 500 }));
    const afterRoads = arr(afterRoadList.roads);
    const effect = matchExactNetCourseReadback({ prefab: "Small Road", start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 },
      roads: afterRoads, totalMatches: afterRoadList.totalMatches, returned: afterRoadList.returned,
      truncated: afterRoadList.truncated, hasMore: afterRoadList.hasMore, tolerance: 1 });
    const pumpRead = rec(await call("cs2_list_buildings", { query: "GroundwaterPumpingStation01", limit: 32 }));
    const pumpList = arr(pumpRead.buildings);
    const pumpEntry = pumpList.map(rec).find((item) => item.isSubBuilding !== true &&
      Math.hypot(Number(rec(item.position).x) - utility.plan!.position.x, Number(rec(item.position).z) - utility.plan!.position.z) <= 1.5);
    const pumpRef = rec(pumpEntry?.entity);
    const access = pumpEntry ? rec(await call("cs2_building_access", { index: pumpRef.index, version: pumpRef.version })) : {};
    const connector = pumpEntry ? rec(await call("cs2_utility_connectors", { index: pumpRef.index, version: pumpRef.version })) : {};
    const settle = effect.result === "MATCH" ? await call("cs2_run_simulation", { hours: 0.5, speed: 4 }) : null;
    const settledGame = settle ? rec(await call("cs2_game_state")) : afterGame;
    const settledWorld = rec(settledGame.world);
    const settledAccess = pumpEntry ? rec(await call("cs2_building_access", { index: pumpRef.index, version: pumpRef.version })) : {};
    const settledConnector = pumpEntry ? rec(await call("cs2_utility_connectors", { index: pumpRef.index, version: pumpRef.version })) : {};
    const cityServices = rec(await call("cs2_city_services"));
    const afterPipes = rec(await call("cs2_list_roads", { query: "Small Water Pipe", limit: 500 }));
    const afterAmendments = durability.utilityBudgetAmendments().filter((entry) => entry.projectId === state.project.id &&
      entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON);
    const afterCommands = durability.commandJournal.list().filter((entry) => entry.actionFamily === "ROAD" &&
      entry.authorizedScope.actionFamily === "ROAD" && entry.authorizedScope.owner.ownerId === state.project.id &&
      !!entry.authorizedScope.facilityAccessRoadRepair);
    process.stdout.write(JSON.stringify({
      status: result ? "EXECUTION_RETURNED" : "EXECUTION_THROWN_READBACK_COMPLETED",
      executionError: executionError ?? null,
      world: { worldId: afterWorld.worldId, generation: afterWorld.generation, runtimeEpoch: afterWorld.bridgeRuntimeEpoch,
        paused: rec(afterGame.simulation).paused, operationStage: afterWorld.nativeOperationStage },
      settle: settle ? { result: settle, pausedAfter: rec(settledGame.simulation).paused, generationAfter: settledWorld.generation } : null,
      action, authorization: result ? { amendmentId: result.authorization.amendmentId, status: result.authorization.status,
        executionUseStatus: result.authorization.executionUseStatus, nativeQuote: result.authorization.nativeQuote,
        courseFingerprint: result.authorization.courseFingerprint, repairLineage: result.authorization.repairLineage } : null,
      execution: result ? { commandId: result.execution.command.commandId, commandStatus: result.execution.command.status,
        admission: result.execution.admission.decision, bridgeCalled: result.execution.bridgeCalled,
        authorizationConsumed: result.execution.authorizationConsumed,
        effectReport: result.execution.effectReport ? { matcherResult: result.execution.effectReport.matcherResult,
          effectAbsenceProven: result.execution.effectReport.effectAbsenceProven, reason: result.execution.effectReport.reason } : null } : null,
      nativeRoadCommandCalls: calls.filter((entry) => entry.name === "cs2_build_road").length,
      roadEntities: afterRoads.map((item: any) => ({ entity: item.entity, prefab: item.prefab, start: item.start, end: item.end })),
      courseEffect: { result: effect.result, evidence: effect.evidence },
      pump: { entity: pumpRef, attachment: access.roadAttachment, noRoadAccess: access.noRoadAccess, noElectricity: access.noElectricity,
        fulfilledElectricity: access.fulfilledElectricity, nativeFrontage: access.nativeRoadFrontage },
      settledPump: { attachment: settledAccess.roadAttachment, noRoadAccess: settledAccess.noRoadAccess, noElectricity: settledAccess.noElectricity,
        fulfilledElectricity: settledAccess.fulfilledElectricity },
      connector: { consumerService: connector.consumerService, connectors: connector.connectors },
      settledConnector: { consumerService: settledConnector.consumerService, connectors: settledConnector.connectors },
      cityServices: { electricity: cityServices.electricity, water: cityServices.water },
      pipes: { count: arr(afterPipes.roads).length, totalMatches: afterPipes.totalMatches, truncated: afterPipes.truncated },
      amendments: afterAmendments.map((entry) => ({ id: entry.amendmentId, status: entry.status, use: entry.executionUseStatus,
        quote: entry.nativeQuote, fingerprint: entry.courseFingerprint, repairLineage: entry.repairLineage })),
      commands: afterCommands.map((entry) => ({ commandId: entry.commandId, status: entry.status,
        exactInput: entry.authorizedScope.actionFamily === "ROAD" ? entry.authorizedScope.exactInput : null })),
      calls: calls.map((entry) => entry.name),
      nativeMutationCount: calls.filter((entry) => entry.name === "cs2_build_road").length,
      forcedSaveCount: calls.filter((entry) => entry.name === "cs2_save_game").length,
      historicalRepairCommandCountBefore: repairCommands.length,
      expectedExactInput: exactAction,
    }, null, 2) + "\n");
  } catch (error) {
    // If the production submission boundary was entered, read-only evidence is
    // collected by a subsequent run; this process never retries this call.
    process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error),
      nativeSubmissionMayHaveOccurred, calls }, null, 2) + "\n");
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

void main();
