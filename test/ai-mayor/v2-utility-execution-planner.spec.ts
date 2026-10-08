import { parseV2McpJson, preserveUtilityPreflightError } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { prepareScopedUtilityExecution, utilityPlanningScope, type UtilityExecutionPlannerPorts } from "../../src/main/services/ai-mayor/v2/utility-execution-planner";
import { resolveCurrentUtilityBinding } from "../../src/main/services/ai-mayor/v2/utility-current-binding";
import type { PlannedUtilityFacility } from "../../src/main/services/ai-mayor/spatial/types";

const plan: PlannedUtilityFacility = {
  kind: "power", prefab: "WindTurbine01", position: { x: 0, z: 0 }, rotationCandidates: [0], constructionCost: 100,
  expectedCapacity: 100, siteEvidence: { source: "fixture" },
  connection: { prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 10, z: 0 } },
};

const input = {
  kind: "electricity" as const, intentId: "intent", projectId: "project", trancheId: "tranche", reservationRef: "reservation",
  worldId: "world", worldEpochId: "epoch", generation: "generation", topologyRevision: "topology",
  spatialEnvelope: { center: { x: 0, z: 0 }, radius: 128 }, maximumSpend: 1000, treasury: 1000, treasurySafetyReserve: 0,
  connectionOnly: true, selectedPrimitive: "direct-cable" as const,
};

function ports(overrides: Partial<UtilityExecutionPlannerPorts> = {}): UtilityExecutionPlannerPorts {
  const currentFacility = { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } };
  const currentConnector = { type: "electricity" as const, node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: false, capacity: { electricity: 100 } };
  return {
    plan: async (_kind, context) => context?.mode === "EXISTING_FACILITY_CONNECTION"
      ? { status: "candidate", connection: { mode: "EXISTING_FACILITY_CONNECTION" as const, kind: "electricity" as const, facility: currentFacility, connection: { prefab: "Low-voltage Ground Cable", start: currentConnector.worldPosition, end: { x: 10, z: 0 } } }, reason: "fixture" }
      : { status: "candidate", facility: plan, reason: "fixture" },
    preflight: async () => true,
    readConnectors: async () => [{ type: "electricity", node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: false, capacity: { electricity: 100 } }],
    readCapacity: async () => ({ revision: "revision", capacity: 100, consumption: 0, fulfilledConsumption: 0, issueActive: true }),
    currentRevision: async () => "revision",
    findCurrentUtilityBinding: async () => ({ status: "MATCH" as const, binding: { facility: currentFacility, connector: currentConnector } }),
    findExistingFacility: async () => currentFacility,
    roadEdges: async () => [{ entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 }, start: { x: 10, z: -1 }, end: { x: 10, z: 1 }, length: 2 }],
    ...overrides,
  };
}

describe("production utility execution planner", () => {
  test("keeps the delivered road binding in existing-facility planning scope", () => {
    const certifiedRoad = {
      entity: { index: 46612, version: 77 },
      position: { x: -1142.38806, z: -26.64797 },
      prefab: "Small Road",
      farEnd: { x: -1134.91559, z: -29.80482 },
    };
    const scope = utilityPlanningScope({ ...input, certifiedRoad, certifiedRoadRefs: [certifiedRoad.entity] });

    expect(scope.certifiedRoadRefs).toEqual([certifiedRoad.entity]);
    expect(scope.targetServiceEntry).toEqual({
      road: certifiedRoad.entity,
      position: certifiedRoad.position,
      prefab: certifiedRoad.prefab,
      farEnd: certifiedRoad.farEnd,
    });
    expect(scope.targetSemantics).toEqual({
      schemaVersion: "ai-mayor-v2-electricity-target/1",
      utility: "ELECTRICITY",
      role: "NETWORK_ENTRY",
      attachmentRole: "END",
      approvedContact: certifiedRoad.position,
      targetRoad: { prefab: certifiedRoad.prefab, endpointRole: "start", anchor: certifiedRoad.position },
      approvedPlanRevision: input.topologyRevision,
    });
  });

  const bindingObservation = (buildings: unknown[], connectors: unknown[]) => resolveCurrentUtilityBinding({
    currentFacility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
    utility: "electricity",
    buildings,
    connectors,
    generation: "generation",
    observationComplete: true,
  });

  test("rebinds a planned facility from a complete observation and fails closed without one", () => {
    const buildings = [{ entity: { index: 45581, version: 17 }, prefab: plan.prefab, isSubBuilding: false, position: { x: 0, z: 0 } }];
    const connectors = [{ type: "electricity", node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: false, orphan: true, capacity: { electricity: 100 } }];
    const complete = resolveCurrentUtilityBinding({
      planned: plan, utility: "electricity", buildings, connectors, generation: "generation", observationComplete: true,
    });
    expect(complete).toEqual(expect.objectContaining({ status: "MATCH" }));
    if (complete.status !== "MATCH") return;
    expect(complete.binding.currentFacility.entity).toEqual({ index: 45581, version: 17 });
    expect(complete.binding.currentConnector.node).toEqual({ index: 20, version: 1 });
    // The planned-site path resolves the same world rows as the plan-free path;
    // an un-attested read must never become a binding.
    const incomplete = resolveCurrentUtilityBinding({
      planned: plan, utility: "electricity", buildings, connectors, generation: "generation", observationComplete: false,
    });
    expect(incomplete).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_FACILITY_OBSERVATION_INCOMPLETE" }));
  });

  test("fails closed for ambiguous current facility binding", () => {
    const result = bindingObservation([
      { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
      { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
    ], [{ type: "electricity", node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 } }]);
    expect(result).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_FACILITY_AMBIGUOUS" }));
  });

  test("uses the durable current facility entity to disambiguate other live facilities", () => {
    const result = resolveCurrentUtilityBinding({
      currentFacility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
      utility: "electricity",
      buildings: [
        { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
        { entity: { index: 11, version: 1 }, prefab: "WindTurbine01", position: { x: 50, z: 0 } },
      ],
      connectors: [{ type: "electricity", node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: false, capacity: { electricity: 100 } }],
      generation: "generation",
      observationComplete: true,
      connectorsScopedToFacilityEntity: true,
    });
    expect(result.status).toBe("MATCH");
    if (result.status !== "MATCH") return;
    expect(result.binding.currentFacility.entity).toEqual({ index: 10, version: 1 });
  });

  test("fails closed for missing current connector binding", () => {
    const result = bindingObservation([
      { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
    ], []);
    expect(result).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_CONNECTOR_NOT_FOUND" }));
  });

  test("fails closed for ambiguous current connector binding", () => {
    const result = bindingObservation([
      { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
    ], [
      { type: "electricity", node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 } },
      { type: "electricity", node: { index: 21, version: 1 }, worldPosition: { x: 0, z: 0 } },
    ]);
    expect(result).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_CONNECTOR_AMBIGUOUS" }));
  });

  test("binds a connector that sits on its facility's footprint, not its origin", () => {
    // The live shape: a GroundwaterPumpingStation01 at (-226.909, 1283.57007)
    // whose water connector is at (-228.909, 1299.57007) — 16.12 m away, on the
    // building's footprint. The fixed 2 m rule binds every WindTurbine and
    // refuses every pumping station, so it is a prefab-shaped assumption rather
    // than a safety check.
    const building = [{ entity: { index: 190180, version: 73 }, prefab: "GroundwaterPumpingStation01", position: { x: -226.909, z: 1283.57007 } }];
    const connector = [{ type: "waterPipe", node: { index: 190181, version: 73 }, worldPosition: { x: -228.909, z: 1299.57007 }, attached: false, orphan: true, capacity: { fresh: 1073741823, sewage: 0 } }];
    const base = {
      currentFacility: { entity: { index: 190180, version: 73 }, prefab: "GroundwaterPumpingStation01", position: { x: -226.909, z: 1283.57007 } },
      utility: "water" as const,
      buildings: building,
      connectors: connector,
      generation: "generation",
      observationComplete: true,
    };

    // Without the attestation the strict rule stands, and it refuses a real
    // facility — which is why the production callers must attest.
    expect(resolveCurrentUtilityBinding(base)).toEqual(
      expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_CONNECTOR_NOT_FOUND" }),
    );

    const resolved = resolveCurrentUtilityBinding({ ...base, connectorsScopedToFacilityEntity: true });
    expect(resolved.status).toBe("MATCH");
    if (resolved.status !== "MATCH") return;
    expect(resolved.binding.currentConnector.node).toEqual({ index: 190181, version: 73 });
    expect(resolved.binding.currentFacility.entity).toEqual({ index: 190180, version: 73 });

    // The attestation settles PROVENANCE, not eligibility: a connector that
    // carries no fresh water is still not this project's water connector.
    const dry = resolveCurrentUtilityBinding({
      ...base,
      connectors: [{ ...connector[0], capacity: { fresh: 0, sewage: 0 } }],
      connectorsScopedToFacilityEntity: true,
    });
    expect(dry).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_CONNECTOR_NOT_FOUND" }));
  });

  test("prepares a complete scope without executing native actions", async () => {
    const result = await prepareScopedUtilityExecution(input, ports());
    expect(result.status).toBe("READY");
    if (result.status !== "READY") return;
    expect(result.executionScope.targetServiceEntry.road).toEqual({ index: 30, version: 1 });
    expect(result.targetSemantics?.approvedContact).toEqual({ x: 10, z: 0 });
    expect(result.nativeActions).toHaveLength(1);
  });

  test("binds a service-road route to its first endpoint on the certified road", async () => {
    const serviceRoads = [
      { id: "segment-1", role: "side" as const, start: { x: 10, z: 0 }, end: { x: 5, z: 0 } },
      { id: "segment-2", role: "side" as const, start: { x: 5, z: 0 }, end: { x: 0, z: 0 } },
    ];
    const result = await prepareScopedUtilityExecution({
      ...input,
      selectedPrimitive: "service-road",
      certifiedRoadRefs: [{ index: 30, version: 1 }],
    }, ports({
      plan: async (_kind, context) => context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? { status: "candidate", connection: {
          mode: "EXISTING_FACILITY_CONNECTION", kind: "electricity",
          facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
          serviceRoads, serviceRoadsNativePreflighted: true,
          connection: { prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 10, z: 0 } },
        }, reason: "bounded alternate contact" }
        : { status: "candidate", facility: plan, reason: "fixture" },
    }));
    expect(result.status).toBe("READY");
    if (result.status !== "READY") return;
    expect(result.approvedContact).toEqual({ x: 10, z: 0 });
    expect(result.executionScope.targetServiceEntry.road).toEqual({ index: 30, version: 1 });
    expect(result.nativeActions).toEqual(serviceRoads.map((road) => ({
      type: "build_road", prefab: "Small Road", x1: road.start.x, z1: road.start.z, x2: road.end.x, z2: road.end.z,
    })));
  });

  test("carries an exhausted-route direct-cable topology through Gate 1 without repeating its native preview", async () => {
    let preflightCalls = 0;
    const result = await prepareScopedUtilityExecution({
      ...input,
      selectedPrimitive: "direct-cable",
      certifiedRoadRefs: [{ index: 30, version: 1 }],
    }, ports({
      plan: async (_kind, context) => context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? { status: "candidate", connection: {
          mode: "EXISTING_FACILITY_CONNECTION", kind: "electricity",
          facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
          serviceRoads: [], directCableNativePreflighted: true,
          connection: { prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 10, z: 0 } },
        }, reason: "service-road routes exhausted; direct cable preview accepted" }
        : { status: "candidate", facility: plan, reason: "fixture" },
      preflight: async () => { preflightCalls += 1; return { valid: false, reason: "duplicate_native_preview" }; },
    }));
    expect(result.status).toBe("READY");
    expect(preflightCalls).toBe(0);
    if (result.status !== "READY") return;
    expect(result.candidate.primitive).toBe("direct-cable");
    expect(result.executionScope.targetServiceEntry.road).toEqual({ index: 30, version: 1 });
  });

  test("admits a utility contact on a durable observed utility-road child", async () => {
    const childRoad = { entity: { index: 40, version: 2 }, prefab: "Small Road", native: true,
      startNode: { index: 41, version: 2 }, endNode: { index: 42, version: 2 },
      start: { x: 10, z: 0 }, end: { x: 20, z: 0 }, length: 10 };
    const result = await prepareScopedUtilityExecution({ ...input, selectedPrimitive: "direct-cable",
      certifiedRoadRefs: [{ index: 30, version: 1 }] }, ports({
      plan: async (_kind, context) => context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? { status: "candidate", connection: {
          mode: "EXISTING_FACILITY_CONNECTION", kind: "electricity",
          facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
          serviceRoads: [], directCableNativePreflighted: true,
          authoritativeRoadRefs: [{ index: 40, version: 2 }],
          connection: { prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 10, z: 0 } },
        }, reason: "observed utility-road contact" }
        : { status: "candidate", facility: plan, reason: "fixture" },
      roadEdges: async () => [
        { entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true,
          startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 },
          start: { x: 10, z: 0 }, end: { x: 15, z: 0 }, length: 5 }, childRoad,
      ],
    }));
    expect(result.status).toBe("READY");
    if (result.status !== "READY") return;
    expect(result.executionScope.targetServiceEntry.road).toEqual({ index: 40, version: 2 });
    expect(result.executionScope.certifiedRoadRefs).toEqual([{ index: 40, version: 2 }]);
  });

  test("fails closed when the current target road is ambiguous", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      roadEdges: async () => [
        { entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 }, start: { x: 10, z: -1 }, end: { x: 10, z: 1 }, length: 2 },
        { entity: { index: 40, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 41, version: 1 }, endNode: { index: 42, version: 1 }, start: { x: 9, z: 0 }, end: { x: 11, z: 0 }, length: 2 },
      ],
    }));
    expect(result).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_TARGET_ROAD_AMBIGUOUS", nativeActionsSubmitted: 0 }));
  });

  test("binds the certified road when the contact point matches several", async () => {
    // The live shape: a road delivered later ends on a node an earlier road
    // already occupies, so the contact is within tolerance of both. Which road
    // the connection enters is not a geometric question — the tranche certified
    // its own — so the certified ref decides instead of refusing.
    const crossing = async () => [
      { entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 }, start: { x: 10, z: -1 }, end: { x: 10, z: 1 }, length: 2 },
      { entity: { index: 40, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 41, version: 1 }, endNode: { index: 42, version: 1 }, start: { x: 9, z: 0 }, end: { x: 11, z: 0 }, length: 2 },
    ];

    const first = await prepareScopedUtilityExecution({ ...input, certifiedRoadRefs: [{ index: 30, version: 1 }] }, ports({ roadEdges: crossing }));
    expect(first.status).toBe("READY");
    if (first.status === "READY") {
      expect(first.executionScope.targetServiceEntry.road).toEqual({ index: 30, version: 1 });
      expect(first.executionScope.certifiedRoadRefs).toEqual([{ index: 30, version: 1 }]);
    }

    const second = await prepareScopedUtilityExecution({ ...input, certifiedRoadRefs: [{ index: 40, version: 1 }] }, ports({ roadEdges: crossing }));
    expect(second.status).toBe("READY");
    if (second.status === "READY") expect(second.executionScope.targetServiceEntry.road).toEqual({ index: 40, version: 1 });
  });

  test("still refuses an ambiguous contact when nothing is certified, or too much is", async () => {
    const crossing = async () => [
      { entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 }, start: { x: 10, z: -1 }, end: { x: 10, z: 1 }, length: 2 },
      { entity: { index: 40, version: 1 }, prefab: "Medium Road", native: true, startNode: { index: 41, version: 1 }, endNode: { index: 42, version: 1 }, start: { x: 9, z: 0 }, end: { x: 11, z: 0 }, length: 2 },
    ];
    // Nothing certified: the pre-existing rule, unchanged.
    expect(await prepareScopedUtilityExecution(input, ports({ roadEdges: crossing }))).toEqual(
      expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_TARGET_ROAD_AMBIGUOUS" }),
    );
    // A certified ref that matches nothing is not permission to guess.
    expect(await prepareScopedUtilityExecution({ ...input, certifiedRoadRefs: [{ index: 99, version: 1 }] }, ports({ roadEdges: crossing }))).toEqual(
      expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_TARGET_ROAD_AMBIGUOUS" }),
    );
    // Two certified roads at one contact is still ambiguous — the refs narrow
    // the set, they do not break a tie between themselves.
    expect(await prepareScopedUtilityExecution({ ...input, certifiedRoadRefs: [{ index: 30, version: 1 }, { index: 40, version: 1 }] }, ports({ roadEdges: crossing }))).toEqual(
      expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_TARGET_ROAD_AMBIGUOUS" }),
    );
  });

  test("does not fall back to facility placement in connectionOnly mode", async () => {
    let planned = false;
    const result = await prepareScopedUtilityExecution(input, ports({
      findCurrentUtilityBinding: async () => ({ status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND" }),
      plan: async () => { planned = true; return { status: "blocked", reason: "must not be called" }; },
    }));
    expect(result).toEqual(expect.objectContaining({ status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND", nativeActionsSubmitted: 0 }));
    expect(planned).toBe(false);
  });

  test("binds the current facility and connector before creating a connection-only plan", async () => {
    const events: string[] = [];
    const result = await prepareScopedUtilityExecution(input, ports({
      findCurrentUtilityBinding: async () => { events.push("binding"); return { status: "MATCH" as const, binding: {
        facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
        connector: { type: "electricity" as const, node: { index: 20, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: false, capacity: { electricity: 100 } },
      } }; },
      plan: async (_kind, context) => { events.push(context?.mode ?? "missing"); return {
        status: "candidate" as const,
        connection: { mode: "EXISTING_FACILITY_CONNECTION" as const, kind: "electricity" as const,
          facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
          connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 0, z: 0 }, end: { x: 10, z: 0 } } },
        reason: "fixture",
      }; },
    }));
    expect(result.status).toBe("READY");
    expect(events).toEqual(["binding", "EXISTING_FACILITY_CONNECTION"]);
    if (result.status === "READY") {
      expect(result.plan.mode).toBe("EXISTING_FACILITY_CONNECTION");
      expect(result.candidate.primitive).toBe("direct-cable");
    }
  });

  test("transports authority diagnostics on a typed planning failure", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      plan: async () => ({
        status: "blocked",
        reason: "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY",
        diagnostics: {
          roadCountFullScan: 88,
          roadCountBoundedDetail: 1,
          roadCountAfterAuthorityFilter: 0,
          roadCountVisibleToPlanner: 0,
          roadCountVisibleToCandidateBuilder: 0,
        },
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "BLOCKED",
      reason: "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY",
      diagnostics: expect.objectContaining({
        preparationReason: "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY",
        roadCountFullScan: 88,
        roadCountBoundedDetail: 1,
        roadCountAfterAuthorityFilter: 0,
        roadCountVisibleToPlanner: 0,
        roadCountVisibleToCandidateBuilder: 0,
      }),
    }));
  });

  test("transports authority diagnostics on a successful preparation", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      plan: async (_kind, context) => ({
        status: "candidate" as const,
        ...(context?.mode === "EXISTING_FACILITY_CONNECTION" ? {
          connection: { mode: "EXISTING_FACILITY_CONNECTION" as const, kind: "electricity" as const, facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } }, connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 0, z: 0 }, end: { x: 10, z: 0 } } },
        } : { facility: plan }),
        reason: "fixture",
        diagnostics: {
          roadCountFullScan: 88,
          roadCountBoundedDetail: 1,
          roadCountAfterAuthorityFilter: 1,
          roadCountVisibleToPlanner: 1,
          roadCountVisibleToCandidateBuilder: 1,
        },
      }),
    }));
    expect(result.status).toBe("READY");
    expect(result.status === "READY" ? result.diagnostics : undefined).toEqual(expect.objectContaining({
      roadCountFullScan: 88,
      roadCountAfterAuthorityFilter: 1,
      roadCountVisibleToCandidateBuilder: 1,
    }));
  });

  test("types an authoritative candidate with zero actions as EMPTY_DIRECT_CABLE_ACTIONS", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      plan: async (_kind, context) => ({
        status: "candidate" as const,
        connection: context?.mode === "EXISTING_FACILITY_CONNECTION" ? {
          mode: "EXISTING_FACILITY_CONNECTION" as const, kind: "electricity" as const,
          facility: { entity: { index: 10, version: 1 }, prefab: "WindTurbine01", position: { x: 0, z: 0 } },
          connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 0, z: 0 }, end: { x: 0, z: 0 } },
        } : undefined,
        reason: "fixture",
      }),
    }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "EMPTY_DIRECT_CABLE_ACTIONS", nativeActionsSubmitted: 0 });
    expect(result.status === "BLOCKED" ? result.diagnostics : undefined).toEqual(expect.objectContaining({
      currentBindingResolved: true, candidateBuilderCalled: true, candidateCount: 1,
      selectedCandidatePrimitive: "direct-cable", candidateActionCount: 0,
      splitDiagnostics: expect.objectContaining({ source: "splitUtilityConnection" }),
    }));
  });

  test("types invalid direct-cable preflight as DIRECT_CABLE_PREFLIGHT_REJECTED", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      preflight: async () => ({ valid: false, reason: "fixture_rejected", native: { valid: false } }),
    }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED", nativeActionsSubmitted: 0 });
    expect(result.status === "BLOCKED" ? result.diagnostics : undefined).toEqual(expect.objectContaining({
      currentBindingResolved: true, candidateBuilderCalled: true, candidateCount: 1,
      selectedCandidatePrimitive: "direct-cable", candidateActionCount: 1,
      connectionDiagnostics: [expect.objectContaining({ actionIndex: 0, action: expect.objectContaining({ type: "build_road" }) })],
      preflightDiagnostics: [expect.objectContaining({ actionIndex: 0, action: expect.objectContaining({ type: "build_road" }) })],
    }));
  });

  test("admits a connection course whose exact actions are already durably submitted", async () => {
    // The game rejects a course that already exists in the world, so the durable
    // submission 鈥?not a second native validation 鈥?is the authority for it.
    const captured: unknown[] = [];
    const rejected = await prepareScopedUtilityExecution(input, ports({
      preflight: async (action) => { captured.push(action); return { valid: false, reason: "duplicate_course" }; },
    }));
    expect(rejected).toMatchObject({ status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED" });
    expect(captured).toHaveLength(1);

    const proof = JSON.stringify(captured);
    let preflightCalls = 0;
    const admitted = await prepareScopedUtilityExecution(input, ports({
      durablySubmittedConnectionCourses: async () => [proof],
      preflight: async () => { preflightCalls += 1; return { valid: false, reason: "duplicate_course" }; },
    }));
    expect(preflightCalls).toBe(0);
    expect(admitted).toMatchObject({ status: "READY" });
    expect(admitted.status === "READY" ? admitted.diagnostics?.preflightDiagnostics : undefined).toEqual([
      expect.objectContaining({ preflightResult: expect.objectContaining({ reason: "durably_submitted_course_not_revalidated" }) }),
    ]);
  });

  test("fails closed when the durable course journal cannot be read", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      durablySubmittedConnectionCourses: async () => { throw new Error("journal_unreadable"); },
      preflight: async () => ({ valid: false, reason: "fixture_rejected", native: { valid: false } }),
    }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED" });
  });

  test("does not admit a different course than the one durably submitted", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      durablySubmittedConnectionCourses: async () => [JSON.stringify([
        { type: "build_road", prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 99, z2: 99 },
      ])],
      preflight: async () => ({ valid: false, reason: "fixture_rejected", native: { valid: false } }),
    }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED" });
  });

  test("types thrown direct-cable preflight as DIRECT_CABLE_PREFLIGHT_REJECTED with error diagnostics", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      preflight: async () => { throw new Error("fixture_preflight_throw"); },
    }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED", nativeActionsSubmitted: 0 });
    expect(result.status === "BLOCKED" ? result.diagnostics?.preflightDiagnostics : undefined).toEqual([
      expect.objectContaining({ error: "fixture_preflight_throw", actionIndex: 0 }),
    ]);
  });

  test("reserves candidate-missing for an empty authoritative candidate set", async () => {
    const result = await prepareScopedUtilityExecution(input, ports({
      plan: async () => ({ status: "candidate", reason: "fixture_without_connection" }),
    }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "UTILITY_CONNECTION_CANDIDATE_MISSING", nativeActionsSubmitted: 0 });
  });

  test("preserves the structured MCP/Bridge envelope through preflight failure", async () => {
    const nativeToolErrors = [
      {
        ownerEntity: { index: 700, version: 1 }, iconEntity: { index: 701, version: 1 },
        errorPrefab: { entity: { index: 702, version: 1 }, name: "ToolError" }, errorType: "OverlapExisting",
        targetEntity: { index: 703, version: 1 }, position: { x: 1, y: 2, z: 3 }, priority: "Error",
      },
      {
        ownerEntity: { index: 700, version: 1 }, iconEntity: { index: 704, version: 1 },
        errorPrefab: { entity: { index: 705, version: 1 }, name: "ToolError2" }, errorType: "SteepSlope",
        targetEntity: null, position: { x: 4, y: 5, z: 6 }, priority: "Warning",
      },
    ];
    const envelope = {
      error: "operation blocked by game validation",
      status: 409,
      commandId: "bridge-409",
      validation: { status: "REJECTED", detailAvailable: false, errors: [] },
      structural: { generatedEdge: false, essentialTempValid: false },
      diagnostics: { request: { requestedStartEntity: null }, realization: { generatedEdgeCount: 0 } },
      rejectionDiagnostics: { stage: "APPLY_GUARD", errorType: "UNKNOWN" },
      nativeToolErrors,
      bridgeHttpErrorDiagnostics: { source: "bridge-http-error", rawResponseBody: "{}" },
      mcpBridgeFailureDiagnostics: { stage: "HTTP_NON_2XX", errorName: "BridgeError" },
    };
    let caught: unknown;
    try {
      parseV2McpJson({ isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }] });
    } catch (error) {
      caught = error;
    }
    const preflight = preserveUtilityPreflightError(caught);
    expect(preflight.valid).toBe(false);
    expect(preflight.reason).toBe(envelope.error);
    expect(preflight.native).toEqual(expect.objectContaining({
      status: 409, commandId: "bridge-409",
      validation: envelope.validation, structural: envelope.structural,
      diagnostics: expect.objectContaining({ request: envelope.diagnostics.request }),
      rejectionDiagnostics: envelope.rejectionDiagnostics,
      nativeToolErrors,
      bridgeHttpErrorDiagnostics: envelope.bridgeHttpErrorDiagnostics,
      mcpBridgeFailureDiagnostics: envelope.mcpBridgeFailureDiagnostics,
    }));
  });

  test("preserves an explicitly empty nativeToolErrors array", () => {
    let caught: unknown;
    try {
      parseV2McpJson({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "blocked", nativeToolErrors: [] }) }] });
    } catch (error) {
      caught = error;
    }
    const preflight = preserveUtilityPreflightError(caught);
    expect(preflight.native).toHaveProperty("nativeToolErrors", []);
  });

  test("distinguishes missing nativeToolErrors from an empty array", () => {
    let caught: unknown;
    try {
      parseV2McpJson({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "blocked" }) }] });
    } catch (error) {
      caught = error;
    }
    const preflight = preserveUtilityPreflightError(caught);
    expect(preflight.native).not.toHaveProperty("nativeToolErrors");
  });

  test("keeps unknown native detail unknown and transports it to UtilityPreparationFailure", async () => {
    const generic = preserveUtilityPreflightError(new Error("operation blocked by game validation"));
    expect(generic.valid).toBe(false);
    expect(generic.native?.nativeRoadDiagnostics).toBeUndefined();
    expect(generic.native?.validation).toBeUndefined();
    const result = await prepareScopedUtilityExecution(input, ports({ preflight: async () => generic }));
    expect(result).toMatchObject({ status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED" });
    expect(result.status === "BLOCKED" ? result.diagnostics?.preflightDiagnostics : undefined).toEqual([
      expect.objectContaining({ preflightResult: expect.objectContaining({ valid: false }) }),
    ]);
  });
});
