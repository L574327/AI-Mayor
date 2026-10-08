import type { PlannedUtilityFacility } from "../../src/main/services/ai-mayor/spatial/types";
import { utilityCanMaterializeServiceRoadChild } from "../../src/main/services/ai-mayor/main-adapters";
import type { DurableGreenfieldUtilityKindState } from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { bindUtilityPlanToCurrentCandidate, persistedUtilityPlacementPlanForScope, utilityPlanStartMatchesCurrentBinding } from "../../src/main/services/ai-mayor/v2/main-adapter";

const alternate: PlannedUtilityFacility = {
  kind: "power", prefab: "WindTurbine03", position: { x: -1194.55, z: -55.94 }, rotationCandidates: [0],
  constructionCost: 8_500, expectedCapacity: 20_000,
  siteEvidence: { roadDistance: 31, connectionDistance: 31 },
  serviceRoads: [{ id: "service-road", role: "side", start: { x: -1194, z: -25 }, end: { x: -1193, z: -32 } }],
  connection: { prefab: "Low-voltage Ground Cable", start: { x: -1194, z: -55 }, end: { x: -1193, z: -25 } },
};
const unplacedScope = (): DurableGreenfieldUtilityKindState => ({
  ...({} as DurableGreenfieldUtilityKindState),
  kind: "electricity", stage: "MISSING", constructionAttempts: 0, maximumConstructionAttempts: 2,
  observationWaits: 0, maximumObservationWaits: 3, authorizedSpend: 0,
  plan: alternate, planBinding: { projectId: "project", worldEpochId: "world:generation:g1", topologyRevision: "g1:production" },
  facilityCommandId: null, networkCommandIds: [], commandOutcome: "NONE", lastFailureBoundary: "NONE",
  connectionRecovery: { type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY", consumed: false, consumptionCount: 0, maximumConsumptions: 1, journal: [] },
  connectionReplan: { type: "CONNECTION_COURSE_REPLAN", replanCount: 0, maximumReplans: 2, journal: [] },
  selectedConnectionPrimitive: null, lastRecoveryReason: null, connectionDiagnostics: [], preflightDiagnostics: [],
  facility: null, connector: null, progression: null, serviceEvidence: null, connectionObjective: null,
  candidateLedger: [], accessRoadRepair: null, placementScopeId: "scope:alternate", placementScopeHistory: [],
});

describe("successor utility placement planning handoff", () => {
  test("preserves topology-bound cable extension start instead of snapping back to facility connector", () => {
    const extension: PlannedUtilityFacility = {
      ...alternate,
      connection: { prefab: "Low-voltage Ground Cable", start: { x: -1237.4, z: -50.3 }, end: { x: -1142.3, z: -26.6 } },
      connectionEndpointBindings: {
        start: { mode: "EXISTING_NET_NODE", role: "START", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
          expectedPosition: { x: -1237.4, y: 2, z: -50.3 }, bindingRule: "CURRENT_REACHABLE_CABLE_TERMINAL",
          topologyRole: "CONNECTED_UTILITY_CABLE_TERMINAL",
          topologyLookup: { networkEdgePrefab: "Low-voltage Ground Cable",
            edgeGeometry: { x1: -1287.3, z1: -100.9, x2: -1237.4, z2: -50.3 }, edgeEndpointRole: "END",
            sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: -1287.3, y: 2, z: -100.9 },
              connectorUtility: "ELECTRICITY" }, requireSourceReachability: true } },
        end: { mode: "EXISTING_NET_NODE", role: "END", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
          expectedPosition: { x: -1142.3, y: 2, z: -26.6 }, bindingRule: "CERTIFIED_TARGET_ROAD_ELECTRICITY_NODE",
          topologyRole: "LOCAL_ROAD_ELECTRICITY_NODE",
          topologyLookup: { networkEdgePrefab: "Small Road",
            edgeGeometry: { x1: -1142.3, z1: -26.6, x2: -1100, z2: -20 }, edgeEndpointRole: "START",
            sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: -1287.3, y: 2, z: -100.9 },
              connectorUtility: "ELECTRICITY" }, requireSourceReachability: false } },
      },
    };
    const bound = bindUtilityPlanToCurrentCandidate({
      plan: extension,
      facility: { entity: { index: 10, version: 2 }, prefab: "WindTurbine03", position: { x: -1287.3, z: -100.9 } },
      connector: { type: "electricity", node: { index: 11, version: 2 }, worldPosition: { x: -1287.3, z: -100.9 },
        attached: true, capacity: { electricity: 20_000 } },
    });
    expect(bound.connection.start).toEqual({ x: -1237.4, z: -50.3 });
    expect(bound.connection.end).toEqual({ x: -1142.3, z: -26.6 });
    expect(bound.connectionEndpointBindings).toEqual(extension.connectionEndpointBindings);
    const connector = { type: "electricity" as const, node: { index: 11, version: 2 },
      worldPosition: { x: -1287.3, z: -100.9 }, attached: true, capacity: { electricity: 20_000 } };
    expect(utilityPlanStartMatchesCurrentBinding(bound, connector)).toBe(true);
    expect(utilityPlanStartMatchesCurrentBinding({ ...bound, connection: { ...bound.connection, start: connector.worldPosition } }, connector)).toBe(false);
    expect(utilityPlanStartMatchesCurrentBinding(alternate, connector)).toBe(false);
    expect(utilityPlanStartMatchesCurrentBinding({ ...alternate, connection: { ...alternate.connection, start: connector.worldPosition } }, connector)).toBe(true);
  });

  test("uses the authoritative connector and exact selected candidate geometry after facility rebind", () => {
    const bound = bindUtilityPlanToCurrentCandidate({
      plan: alternate,
      facility: { entity: { index: 10, version: 2 }, prefab: "WindTurbine03", position: { x: -1194.5542, z: -55.94185 } },
      connector: { type: "electricity", node: { index: 11, version: 2 }, worldPosition: { x: -1194.5542, z: -55.94185 }, attached: false, capacity: { electricity: 20_000 } },
      candidate: { kind: "direct-cable", exactActions: [{ type: "build_road", prefab: "Low-voltage Ground Cable",
        x1: -1194.5542, z1: -55.94185, x2: -1192.991461161851, z2: -24.159704081432622 }] },
    });
    expect(bound.position).toEqual({ x: -1194.5542, z: -55.94185 });
    expect(bound.connection).toEqual({ prefab: "Low-voltage Ground Cable", start: { x: -1194.5542, z: -55.94185 },
      end: { x: -1192.991461161851, z: -24.159704081432622 } });
    const roadBound = bindUtilityPlanToCurrentCandidate({ plan: alternate, candidate: { kind: "service-road",
      exactActions: [{ type: "build_road", prefab: "Small Road", x1: -1192.991461161851, z1: -24.159704081432622,
        x2: -1193.3853207772738, z2: -32.170570662053564 }] } });
    expect(roadBound.serviceRoads).toEqual([{ id: "selected-service-road-1", role: "side",
      start: { x: -1192.991461161851, z: -24.159704081432622 }, end: { x: -1193.3853207772738, z: -32.170570662053564 } }]);
  });

  test("reuses the persisted alternate site only for its exact unplaced scope", () => {
    const utility = unplacedScope();
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate" })).toEqual(alternate);
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate",
      planningContext: { mode: "GREENFIELD_PLACEMENT" } })).toEqual(alternate);
    utility.stage = "BLOCKED";
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate" })).toBeUndefined();
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate", placementUnattempted: true })).toEqual(alternate);
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:other" })).toBeUndefined();
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate", connectionOnly: true })).toBeUndefined();
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate", planningContext: { mode: "EXISTING_FACILITY_CONNECTION", binding: {} as never } })).toBeUndefined();
    utility.stage = "PLACED";
    expect(persistedUtilityPlacementPlanForScope({ utility, placementScopeId: "scope:alternate" })).toBeUndefined();
  });

  test("a missing successor facility cannot create another connection-road child", () => {
    const utility = unplacedScope();
    expect(utilityCanMaterializeServiceRoadChild(utility)).toBe(false);
    expect(utilityCanMaterializeServiceRoadChild({ ...utility, stage: "PLACED", facility: {}, connector: {} })).toBe(true);
    expect(utilityCanMaterializeServiceRoadChild({ ...utility, stage: "PLACED", facility: null, connector: {} })).toBe(false);
  });
});
