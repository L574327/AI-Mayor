import {
  electricityTargetEndpoint,
  bridgeTopologyRevision,
  electricityTargetSemantics,
  narrowTargetRoadsByCertifiedRefs,
  projectApprovedContactOnNativeCurve,
  reacquirePreflightTargetRoad,
  resolveCurrentElectricityTarget,
  type ElectricityTargetTopologyObservation,
} from "../../src/main/services/ai-mayor/v2/utility-target-binding";

const semantic = electricityTargetSemantics({
  contact: { x: 100, z: 200 },
  targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 100, z: 200 } },
  approvedPlanRevision: "plan-1",
});

const straightCurve = {
  a: { x: 100, y: 5, z: 200 },
  b: { x: 100, y: 5, z: 200 },
  c: { x: 140, y: 9, z: 240 },
  d: { x: 180, y: 13, z: 280 },
  length: 113,
};

const observation = (position3D?: { x: number; y: number; z: number }): ElectricityTargetTopologyObservation => ({
  binding: { bindingStatus: "VALID", complete: true, truncated: false, generation: "generation-1", topologyRevision: "topology-1" },
  targetServiceEntryRoad: { index: 10, version: 1 },
  reboundTargetRoad: { index: 10, version: 1 },
  targetEndpoints: [{
    role: "start",
    node: { index: 20, version: 1 },
    position: { x: 111, y: 7, z: 222 },
    electricityFlowNode: { index: 30, version: 1 },
    utility: "ELECTRICITY",
    road: { index: 10, version: 1 },
  }],
});

describe("v2 electricity target geometric contact contract", () => {
  test("accepts an exact current target binding when only the disconnected reachability walk is incomplete", () => {
    const current = observation();
    current.binding.complete = false;
    const resolved = resolveCurrentElectricityTarget({
      semantic,
      observation: current,
      roadEndpoint: { role: "start", position: { x: 100, z: 200 }, nativeCurve: straightCurve },
      worldEpoch: "generation-1",
      generation: "generation-1",
      topologyRevision: "topology-1",
    });
    expect(resolved.status).toBe("PASS");
  });

  test("still rejects an unbound or truncated target identity", () => {
    for (const binding of [
      { ...observation().binding, bindingStatus: "STALE" },
      { ...observation().binding, truncated: true },
    ]) {
      const resolved = resolveCurrentElectricityTarget({
        semantic,
        observation: { ...observation(), binding },
        roadEndpoint: { role: "start", position: { x: 100, z: 200 }, nativeCurve: straightCurve },
        worldEpoch: "generation-1",
        generation: "generation-1",
        topologyRevision: "topology-1",
      });
      expect(resolved).toMatchObject({ status: "FAIL" });
    }
  });

  test("keeps approved contact position separate from selected node position", () => {
    const resolved = resolveCurrentElectricityTarget({
      semantic,
      observation: observation({ x: 100, y: 5, z: 200 }),
      roadEndpoint: { role: "start", position: { x: 100, z: 200 }, nativeCurve: straightCurve },
      worldEpoch: "generation-1",
      generation: "generation-1",
      topologyRevision: "topology-1",
    });
    expect(resolved.status).toBe("PASS");
    if (resolved.status !== "PASS") return;
    expect(resolved.binding.nodePosition).toEqual({ x: 111, y: 7, z: 222 });
    expect(resolved.binding.road).toEqual({ index: 10, version: 1 });
    expect(resolved.binding.approvedContact).toEqual({ x: 100, z: 200 });
    expect(resolved.binding.geometricContactPosition.x).toBeCloseTo(100, 5);
    expect(resolved.binding.geometricContactPosition.y).toBeCloseTo(5, 5);
    expect(resolved.binding.geometricContactPosition.z).toBeCloseTo(200, 5);
    const endpoint = electricityTargetEndpoint(resolved.binding);
    expect(endpoint.entity).toBeNull();
    expect(endpoint.expectedPosition.x).toBeCloseTo(100, 5);
    expect(endpoint.expectedPosition.y).toBeCloseTo(5, 5);
    expect(endpoint.expectedPosition.z).toBeCloseTo(200, 5);
    expect(endpoint.geometricContact?.roadNode).toEqual({ index: 20, version: 1 });
    expect(endpoint.geometricContact?.position.x).toBeCloseTo(100, 5);
    expect(endpoint.geometricContact?.position.y).toBeCloseTo(5, 5);
    expect(endpoint.geometricContact?.position.z).toBeCloseTo(200, 5);
    expect(endpoint.topologyExpectation?.flowNode).toEqual({ index: 30, version: 1 });
  });

  test("fails closed when approved contact has no proven 3D position", () => {
    const resolved = resolveCurrentElectricityTarget({
      semantic,
      observation: observation(),
      roadEndpoint: { role: "start", position: { x: 100, z: 200 } },
      worldEpoch: "generation-1",
      generation: "generation-1",
      topologyRevision: "topology-1",
    });
    expect(resolved).toMatchObject({ status: "FAIL", reason: "APPROVED_CONTACT_3D_POSITION_UNAVAILABLE" });
    if (resolved.status === "FAIL") {
      expect(resolved.diagnostics?.selectedNodePosition).toEqual({ x: 111, y: 7, z: 222 });
      expect(resolved.diagnostics?.resolvedGeometricContactPosition).toBeNull();
      expect(resolved.diagnostics?.approvedContactToNodeDistance).toBeGreaterThan(0.25);
    }
  });

  test("recovers an interior Bezier contact with native Y", () => {
    const resolved = resolveCurrentElectricityTarget({
      semantic: electricityTargetSemantics({
        contact: { x: 130, z: 230 },
        targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 130, z: 230 } },
        approvedPlanRevision: "plan-1",
      }),
      observation: observation(),
      roadEndpoint: { role: "start", position: { x: 130, z: 230 }, nativeCurve: straightCurve },
      worldEpoch: "generation-1",
      generation: "generation-1",
      topologyRevision: "topology-1",
    });
    expect(resolved.status).toBe("PASS");
    if (resolved.status !== "PASS") return;
    expect(resolved.binding.geometricContactPosition.y).toBeGreaterThan(5);
    expect(resolved.binding.geometricContactPosition.y).toBeLessThan(13);
    expect(resolved.binding.diagnostics.projectedT).toBeGreaterThan(0);
    expect(resolved.binding.diagnostics.projectedT).toBeLessThan(1);
  });

  test("fails closed when native curve residual exceeds tolerance", () => {
    const resolved = resolveCurrentElectricityTarget({
      semantic: electricityTargetSemantics({
        contact: { x: 100, z: 205 },
        targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 100, z: 205 } },
        approvedPlanRevision: "plan-1",
      }),
      observation: observation(),
      roadEndpoint: { role: "start", position: { x: 100, z: 205 }, nativeCurve: straightCurve },
      worldEpoch: "generation-1",
      generation: "generation-1",
      topologyRevision: "topology-1",
    });
    expect(resolved).toMatchObject({ status: "FAIL", reason: "APPROVED_CONTACT_3D_POSITION_UNAVAILABLE" });
  });

  test("projects against curved Bezier geometry instead of endpoint line", () => {
    const projection = projectApprovedContactOnNativeCurve({ x: 5, z: 7.5 }, {
      a: { x: 0, y: 10, z: 0 },
      b: { x: 0, y: 20, z: 10 },
      c: { x: 10, y: 30, z: 10 },
      d: { x: 10, y: 40, z: 0 },
      length: 20,
    });
    expect(projection.projectedT).toBeCloseTo(0.5, 2);
    expect(projection.projectedPosition.x).toBeCloseTo(5, 2);
    expect(projection.projectedPosition.z).toBeCloseTo(7.5, 2);
    expect(projection.projectedPosition.y).toBeCloseTo(25, 2);
    expect(projection.xzResidual).toBeLessThan(0.01);
  });
});

describe("bridge topology revision vocabulary", () => {
  test("names the target entity in the form the Bridge reports, not the durable scope revision", () => {
    // The Bridge computes `generation:targetIndex:targetVersion` and marks any
    // other expected value STALE, so the durable scope revision must be
    // translated instead of passed verbatim.
    expect(bridgeTopologyRevision({ generation: "3d206ee9", target: { index: 45586, version: 13 } }))
      .toBe("3d206ee9:45586:13");
    expect(bridgeTopologyRevision({ generation: "3d206ee9", target: { index: 45586, version: 13 } }))
      .not.toBe("3d206ee9:production");
  });
});

describe("preflight target road reacquisition", () => {
  const road = (index: number, start: { x: number; z: number }, end: { x: number; z: number }, prefab = "Small Road") => ({
    entity: { index, version: 1 }, prefab, native: true,
    startNode: { index: index * 10, version: 1 }, endNode: { index: index * 10 + 1, version: 1 },
    start, end, length: Math.hypot(end.x - start.x, end.z - start.z),
  }) as never;

  // The game tessellates one delivered course into several same-prefab edges
  // meeting at the contact node. The immutable semantics name only the contact,
  // and `targetRoad.anchor` is derived from that same contact, so both
  // predicates ask the same question of the same node — and every split edge
  // answers yes.
  const splitEdges = [
    road(1, { x: 100, z: 200 }, { x: 140, z: 200 }),
    road(2, { x: 100, z: 200 }, { x: 100, z: 240 }),
  ];

  test("refuses a split road when only the contact names it", () => {
    const result = reacquirePreflightTargetRoad({ edges: splitEdges, semantic });
    expect(result.status).toBe("AMBIGUOUS");
    expect(result.status === "AMBIGUOUS" ? result.candidates : []).toHaveLength(2);
  });

  test("the committed far endpoint picks out the delivered course", () => {
    const result = reacquirePreflightTargetRoad({
      edges: splitEdges, semantic, farEndpoint: { x: 140, z: 200 },
    });
    expect(result.status).toBe("YES");
    expect(result.status === "YES" ? result.road.entity.index : null).toBe(1);
  });

  test("a far endpoint no current edge carries refuses instead of guessing", () => {
    expect(reacquirePreflightTargetRoad({ edges: splitEdges, semantic, farEndpoint: { x: 999, z: 999 } }).status)
      .toBe("NO");
  });

  test("an unsplit road needs no second key", () => {
    expect(reacquirePreflightTargetRoad({ edges: [splitEdges[0]], semantic }).status).toBe("YES");
  });
});

describe("narrowTargetRoadsByCertifiedRefs", () => {
  const junction = { x: 100, z: 200 };
  const edges = [
    { entity: { index: 48723, version: 231 }, prefab: "Medium Road", start: junction, end: { x: 120, z: 201 } },
    { entity: { index: 45445, version: 7 }, prefab: "Medium Road", start: junction, end: { x: 90, z: 300 } },
  ];

  test("the certified road identity resolves a contact two same-prefab roads share", () => {
    const narrowed = narrowTargetRoadsByCertifiedRefs({
      candidates: edges, certifiedRoadRefs: [{ index: 48723, version: 231 }],
      commandGeneration: "generation-1", currentGeneration: "generation-1",
    });
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0].entity.index).toBe(48723);
  });

  test("a generation change makes the recorded identity name nothing", () => {
    const narrowed = narrowTargetRoadsByCertifiedRefs({
      candidates: edges, certifiedRoadRefs: [{ index: 48723, version: 231 }],
      commandGeneration: "generation-1", currentGeneration: "generation-2",
    });
    expect(narrowed).toHaveLength(2);
  });

  test("a certified ref matching no candidate narrows nothing", () => {
    const narrowed = narrowTargetRoadsByCertifiedRefs({
      candidates: edges, certifiedRoadRefs: [{ index: 999, version: 1 }],
      commandGeneration: "generation-1", currentGeneration: "generation-1",
    });
    expect(narrowed).toHaveLength(2);
  });

  test("a certified ref matching several candidates stays ambiguous", () => {
    const narrowed = narrowTargetRoadsByCertifiedRefs({
      candidates: edges, certifiedRoadRefs: [{ index: 48723, version: 231 }, { index: 45445, version: 7 }],
      commandGeneration: "generation-1", currentGeneration: "generation-1",
    });
    expect(narrowed).toHaveLength(2);
  });

  test("a single candidate is returned untouched", () => {
    const narrowed = narrowTargetRoadsByCertifiedRefs({
      candidates: [edges[0]], certifiedRoadRefs: [],
      commandGeneration: "generation-1", currentGeneration: "generation-1",
    });
    expect(narrowed).toHaveLength(1);
  });
});
