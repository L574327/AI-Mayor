import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type V2DurableStateStorage,
} from "@/main/services/ai-mayor/v2/durability";
import { planStarterResidentialIntent } from "@/main/services/ai-mayor/v2/gate1";
import { createV2FoundationPorts } from "@/main/services/ai-mayor/v2/main-adapter";
import type { MayorAction } from "@/main/services/ai-mayor/types";
import type { GreenfieldUtilityExecutionScope } from "@/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import type { UtilityEndpointBinding } from "@/main/services/ai-mayor/v2/utility-endpoints";

const WORLD_ID = "cs2-session:network-link-test";
const GENERATION = "generation-network-link-test";
const SOURCE_NODE = { index: 44, version: 2 };
const SOURCE_EDGE = { index: 40, version: 1 };
const CABLE_EDGE = { index: 60, version: 1 };
const PUMP_SIDE_NODE = { index: 88, version: 1 };
const MIDPOINT = { x: 10, y: 5, z: 10 };
const SOURCE = { x: 0, y: 5, z: 0 };
const TARGET = { x: 20, y: 5, z: 20 };
const CABLE = "Low-voltage Ground Cable";

const binding = (input: Partial<UtilityEndpointBinding> & Pick<UtilityEndpointBinding, "mode" | "role" | "expectedPosition" | "bindingRule" | "topologyRole">): UtilityEndpointBinding => ({
  mode: input.mode, role: input.role, utility: "ELECTRICITY", prefab: CABLE,
  expectedPosition: input.expectedPosition, bindingRule: input.bindingRule, topologyRole: input.topologyRole,
  ...(input.topologyLookup ? { topologyLookup: input.topologyLookup } : {}),
});

const sourceLookup = {
  networkEdgePrefab: "Medium Road",
  edgeGeometry: { x1: -1, z1: 0, x2: 0, z2: 0 },
  edgeEndpointRole: "END" as const,
  sourceAnchor: { buildingPrefab: "WindTurbineElectricity", position: { x: -1, y: 0, z: 0 }, connectorUtility: "ELECTRICITY" as const },
  requireSourceReachability: true,
};

const existing = (role: "START" | "END", point: typeof SOURCE, lookup: typeof sourceLookup, rule: string, topologyRole: string) =>
  binding({ mode: "EXISTING_NET_NODE", role, expectedPosition: point, bindingRule: rule, topologyRole, topologyLookup: lookup });

const free = (point: typeof MIDPOINT) => binding({
  mode: "FREE_POINT", role: "END", expectedPosition: point,
  bindingRule: "NEW_FREE_COURSE_TERMINAL", topologyRole: "COURSE_TERMINAL",
});

const action = (x1: number, z1: number, x2: number, z2: number, start: UtilityEndpointBinding, end: UtilityEndpointBinding): MayorAction => ({
  type: "build_road", prefab: CABLE, x1, z1, x2, z2, utilityEndpoints: { start, end },
});

const game = () => ({
  gameMode: "Game", isLoading: false, cityLoaded: true,
  simulation: { paused: true, frameIndex: 300, simulationHasTickedSinceLoad: true },
  world: {
    identityStatus: "AVAILABLE", worldReady: true, worldId: WORLD_ID, nativeSessionGuid: "network-link-test",
    loadPurpose: "NewGame", loadAssetGuid: null, saveDataAssetGuid: null, mapAssetGuid: "map",
    checkpointId: null, bridgeRuntimeEpoch: "bridge", generation: GENERATION,
    generationSequence: 1, generationOrigin: "LOAD_COMPLETED", nativeOperationBusy: false,
    nativeOperationStage: "Idle", simulationHasTickedSinceLoad: true,
  },
});

const storageWithBaseline = (): V2DurableStateStorage => {
  const storage = createMemoryDurableStateStorage();
  const durable = new V2DurabilityCoordinator(storage);
  durable.activate(game());
  durable.recordBaselineCheckpoint({
    status: "COMPLETED", durable: true, worldId: WORLD_ID, worldGeneration: GENERATION,
    checkpoint: { checkpointId: "save:meta:data", saveMetadataAssetGuid: "meta", saveDataAssetGuid: "data", nativeSessionGuid: "network-link-test" },
  });
  durable.activate(game());
  const project = planStarterResidentialIntent({
    intentId: "network-link-repair", targetResidents: 12, maximumBudget: 25000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 1000 },
    siteCandidates: [{ id: "network-link-site", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }],
  });
  project.tranche.stage = "ROAD_DELIVERED";
  const scope = productionScope(project.project.id, project.tranche.id, project.tranche.reservationRef);
  const emptyUtility = (kind: "electricity" | "water" | "sewage") => ({
    kind, stage: "PLACED", constructionAttempts: 1, maximumConstructionAttempts: 2,
    observationWaits: 0, maximumObservationWaits: 3, authorizedSpend: 0, plan: null, planBinding: null,
    facilityCommandId: null, networkCommandIds: [], commandOutcome: "NONE", lastFailureBoundary: "NONE",
    connectionRecovery: { type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY", consumed: false, consumptionCount: 0, maximumConsumptions: 1, journal: [] },
    connectionReplan: { type: "CONNECTION_COURSE_REPLAN", replanCount: 0, maximumReplans: 2, journal: [] },
    selectedConnectionPrimitive: null, lastRecoveryReason: null, connectionDiagnostics: [],
    facility: null, connector: null, progression: null, serviceEvidence: null, connectionObjective: null,
    candidateLedger: [], accessRoadRepair: null,
  });
  project.tranche.utilityExecution = {
    schemaVersion: "ai-mayor-v2-greenfield-utility-execution/1", scope,
    utilities: { electricity: emptyUtility("electricity"), water: emptyUtility("water"), sewage: emptyUtility("sewage") },
  } as never;
  durable.saveProjectState(project);
  return storage;
};

function productionScope(projectId: string, trancheId: string, reservationRef: string): GreenfieldUtilityExecutionScope {
  return {
    intentId: "network-link-repair", projectId, trancheId, reservationRef, worldId: WORLD_ID,
    worldEpochId: `${WORLD_ID}:generation:${GENERATION}`, generation: GENERATION,
    topologyRevision: `${GENERATION}:production`, certifiedRoadRefs: [],
    targetServiceEntry: { road: { index: 91, version: 1 }, position: { x: 20, z: 20 }, prefab: "Small Road" },
    // The admitted exact course crosses beyond this facility-centered envelope;
    // NETWORK_LINK_REPAIR is bounded by the exact route and endpoint bindings.
    spatialEnvelope: { center: { x: 10, z: 10 }, radius: 10 }, maximumSpend: 25000,
    treasury: 100000, treasurySafetyReserve: 0,
  };
}

function toolsHarness() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let segment1Applied = false;
  const manager = {
    legacyList: async () => ({ tools: ["cs2_game_state", "cs2_mayor_snapshot", "cs2_list_roads", "cs2_list_buildings", "cs2_utility_connectors", "cs2_spatial", "cs2_mayor_execute_actions"].map((name) => ({ name: `cs2--${name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name, args });
      const endpoint = (node: { index: number; version: number }, position: typeof SOURCE, role: string) => ({
        role, node, position, utility: "ELECTRICITY", electricityFlowNode: { index: node.index + 1000, version: 1 }, waterPipeFlowNode: null,
      });
      if (name === "cs2_game_state") return { structuredContent: game() };
      if (name === "cs2_mayor_snapshot") return { structuredContent: { utilities: { electricity: { status: "available", production: 4389, consumption: 3152, fulfilledConsumption: 3152 } } } };
      if (name === "cs2_list_buildings") return { structuredContent: { complete: true, buildings: [{ prefab: "WindTurbineElectricity", isSubBuilding: false, entity: { index: 30, version: 1 }, position: { x: -1, y: 0, z: 0 } }] } };
      if (name === "cs2_list_roads") {
        const query = String(args.query ?? "");
        const roads = query === "Medium Road"
          ? [{ prefab: "Medium Road", entity: SOURCE_EDGE, start: { x: -1, z: 0 }, end: { x: 0, z: 0 } }]
          : query === "Small Road"
            ? [{ prefab: "Small Road", entity: { index: 90, version: 1 }, start: TARGET, end: { x: 21, z: 20 } }]
          : segment1Applied && query === CABLE
            ? [{ prefab: CABLE, entity: CABLE_EDGE, start: SOURCE, end: MIDPOINT }]
            : [];
        return { structuredContent: { complete: true, truncated: false, roads } };
      }
      if (name === "cs2_utility_connectors") {
        if (args.connector && args.target) {
          const target = args.target as { index: number; version: number };
          const sourceQuery = Number(target.index) === SOURCE_EDGE.index;
          const targetAccessRoad = Number(target.index) === 90;
          const endpointSet = sourceQuery
            ? [endpoint(SOURCE_NODE, SOURCE, "end")]
            : targetAccessRoad ? [endpoint(PUMP_SIDE_NODE, TARGET, "start")]
            : [endpoint(SOURCE_NODE, SOURCE, "start"), endpoint({ index: 66, version: 1 }, MIDPOINT, "end")];
          return { structuredContent: {
            complete: true, truncated: false,
            bindingStatus: "VALID", binding: { bindingStatus: "VALID", complete: true, truncated: false },
            targetNetwork: { targetEndpoints: endpointSet, targetNetworkReachable: true, complete: true, truncated: false },
          } };
        }
        return { structuredContent: { complete: true, connectors: [{ type: "electricity", node: { index: 31, version: 1 } }] } };
      }
      if (name === "cs2_spatial") {
        const start = args.startEndpoint as { kind?: string; entity?: { index: number; version: number } } | undefined;
        const end = args.endEndpoint as { kind?: string; entity?: { index: number; version: number } } | undefined;
        return { structuredContent: { valid: true, previewOnly: true, finance: { signedAmount: 792 }, diagnostics: { realization: {
          realizedStartEntity: start?.entity ?? null, realizedEndEntity: end?.entity ?? null,
        } } } };
      }
      if (name === "cs2_mayor_execute_actions") {
        segment1Applied = true;
        return { structuredContent: { ok: true, requested: 1, executed: 1, results: [{ type: "build_road", ok: true }] } };
      }
      return { structuredContent: {} };
    },
  };
  return { manager, calls, get segment1Applied() { return segment1Applied; } };
}

describe("NETWORK_LINK_REPAIR through production Utility Admission and Kernel", () => {
  test("sends one dual-endpoint Utility action then only fresh-previews step 2", async () => {
    const tools = toolsHarness();
    const storage = storageWithBaseline();
    const ports = createV2FoundationPorts({ getToolsManager: () => tools.manager as never, durableStateStorage: storage });
    ports.durability!.activate(game());
    const project = ports.durability!.projectState() as any;
    const currentScope = project.tranche.utilityExecution.scope as GreenfieldUtilityExecutionScope;
    const scope = { ...currentScope, generation: "stale-durable-generation", worldEpochId: `${WORLD_ID}:generation:stale-durable-generation` };
    const source = existing("START", SOURCE, sourceLookup, "POWERED_SOURCE_ROAD_NODE", "POWERED_ELECTRICITY_NODE");
    const midpointLookup = { ...sourceLookup, edgeGeometry: { x1: SOURCE.x, z1: SOURCE.z, x2: MIDPOINT.x, z2: MIDPOINT.z }, edgeEndpointRole: "END" as const };
    const targetLookup = { ...sourceLookup, networkEdgePrefab: "Small Road", edgeGeometry: { x1: TARGET.x, z1: TARGET.z, x2: 21, z2: 20 }, edgeEndpointRole: "START" as const, requireSourceReachability: false };
    const plan = {
      repairLineage: "water-phase7-electricity-hookup",
      actions: [
        action(SOURCE.x, SOURCE.z, MIDPOINT.x, MIDPOINT.z, source, free(MIDPOINT)),
        action(MIDPOINT.x, MIDPOINT.z, TARGET.x, TARGET.z,
          existing("START", MIDPOINT, midpointLookup, "REALIZED_SEGMENT_1_MIDPOINT", "LV_CABLE_TERMINAL"),
          existing("END", TARGET, targetLookup, "PUMP_ACCESS_ROAD_ELECTRICITY_NODE", "LOCAL_ROAD_ELECTRICITY_NODE")),
      ] as const,
    };
    const result = await ports.greenfieldUtilityBootstrap.advanceSequentialUtilityRepair({ scope, repairId: "water-phase7-hookup", plan });
    expect(tools.segment1Applied).toBe(true);
    const submitCalls = tools.calls.filter((call) => call.name === "cs2_mayor_execute_actions");
    expect(submitCalls).toHaveLength(1);
    const submitted = (submitCalls[0].args.actions as Array<Record<string, unknown>>)[0];
    expect(submitted).toMatchObject({ startEndpoint: { kind: "EXISTING_NET_NODE", entity: SOURCE_NODE }, endEndpoint: { kind: "NEW_FREE_ENDPOINT", entity: null } });
    expect(result.repair.status).toBe("WAITING");
    expect(result.repair.state.actions[0]).toMatchObject({ state: "COMPLETE" });
    expect(result.repair.state.actions[0].generation).toBe(GENERATION);
    expect((ports.durability!.projectState() as any).tranche.utilityExecution.utilities.electricity.sequentialUtilityRepairs["water-phase7-hookup"])
      .toMatchObject({ repairId: "water-phase7-hookup", actions: [{ state: "COMPLETE" }] });
    expect(result.segment2FreshPreflight?.preview.generation).toBe(GENERATION);
    expect(result.segment2FreshPreflight?.preview.quote).toBe(792);
    expect(result.segment2FreshPreflight?.candidate.action?.type).toBe("build_road");
    const step2PreviewCall = tools.calls.filter((call) => call.name === "cs2_spatial").at(-1)!;
    expect(step2PreviewCall.args.startEndpoint).toMatchObject({ kind: "EXISTING_NET_NODE" });
    expect(step2PreviewCall.args.endEndpoint).toMatchObject({ kind: "EXISTING_NET_NODE", entity: PUMP_SIDE_NODE });
    expect(tools.calls.filter((call) => call.name === "cs2_mayor_execute_actions")).toHaveLength(1);
    expect(tools.calls.filter((call) => call.name === "cs2_spatial" && call.args.mode === "preflight").length).toBeGreaterThanOrEqual(3);
    const endpointRebinds = tools.calls.filter((call) => call.name === "cs2_utility_connectors" && call.args.connector !== undefined && call.args.target !== undefined &&
      [SOURCE_EDGE.index, 90].includes(Number((call.args.target as { index: number }).index)));
    expect(endpointRebinds.length).toBeGreaterThan(0);
    expect(endpointRebinds.every((call) => call.args.envelope === undefined)).toBe(true);
    const command = ports.durability!.commandJournal.get(result.repair.state.actions[0].commandId);
    expect(command?.networkLinkRepairIdentity).toMatchObject({ repairLineage: plan.repairLineage, stepIndex: 1, quote: 792,
      startEndpoint: { mode: "EXISTING_NET_NODE" }, endEndpoint: { mode: "FREE_POINT" } });
    expect(command?.status).toBe("OBSERVED_MATCH");
    const currentWorldObservation = ports.durability!.worldObservations(result.repair.state.actions[0].commandId).at(-1);
    expect(currentWorldObservation).toMatchObject({
      worldId: WORLD_ID,
      worldEpochId: `${WORLD_ID}:generation:${GENERATION}`,
      currentWorldEffectPresent: true,
      currentWorldObjectiveSatisfied: true,
    });
    expect(JSON.parse(currentWorldObservation!.evidence)).toMatchObject({
      kind: "NETWORK_LINK_REPAIR_AUTHORITATIVE_CURRENT_WORLD_OBSERVATION",
      repairId: "water-phase7-hookup",
      stepIndex: 1,
      generation: GENERATION,
      topologyChecks: {
        sourceComponentReachable: "PASS",
        newCurrentGenerationEdge: "PASS",
        midpointTerminalBound: "PASS",
        sourceSideConnection: "PASS",
        noUnintendedDuplicate: "PASS",
      },
    });
    expect(currentWorldObservation?.historicalVerdict).toEqual({ status: "NATIVE_COMPLETED", effectAbsenceProven: false });
    const resumed = await ports.greenfieldUtilityBootstrap.advanceSequentialUtilityRepair({ scope, repairId: "water-phase7-hookup", plan });
    expect(resumed.repair.status).toBe("WAITING");
    expect(resumed.repair.reason).toBe("ACTION_2_FRESH_PREFLIGHT_COMPLETE_AUTHORIZATION_NOT_REQUESTED");
    expect(tools.calls.filter((call) => call.name === "cs2_mayor_execute_actions")).toHaveLength(1);
    expect((ports.durability!.projectState() as any).tranche.utilityExecution.utilities.electricity.candidateLedger).toHaveLength(1);
  });
});
