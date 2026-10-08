import {
  rebindUtilityEndpoint,
  utilityActionIdentity,
  type UtilityEndpointBinding,
  type UtilityEndpointNodeObservation,
} from "../../src/main/services/ai-mayor/v2/utility-endpoints";

const existing = (role: "START" | "END", bindingRule: string): UtilityEndpointBinding => ({
  mode: "EXISTING_NET_NODE", role, utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
  expectedPosition: { x: 10, y: 2, z: 20 }, bindingRule, topologyRole: "SOURCE_POWERED_COMPONENT",
  topologyLookup: { networkEdgePrefab: "Medium Road", edgeGeometry: { x1: 1, z1: 2, x2: 10, z2: 20 },
    edgeEndpointRole: role, sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: 0, y: 0, z: 0 }, connectorUtility: "ELECTRICITY" },
    requireSourceReachability: true },
});
const node = (generation: string, index: number, changes: Partial<UtilityEndpointNodeObservation> = {}): UtilityEndpointNodeObservation => ({
  entity: { index, version: 1 }, position: { x: 10, y: 2, z: 20 }, worldId: "world", generation,
  utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable", bindingRule: "powered-source-node",
  topologyRole: "SOURCE_POWERED_COMPONENT", topologyVerified: true, ...changes,
});

describe("dual endpoint utility contract", () => {
  test("supports START EXISTING + END FREE and current-generation node rebind", () => {
    const start = rebindUtilityEndpoint({ binding: existing("START", "powered-source-node"), nodes: [node("g2", 77)], worldId: "world", generation: "g2" });
    const end = rebindUtilityEndpoint({
      binding: { mode: "FREE_POINT", role: "END", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
        expectedPosition: { x: 15, y: 0, z: 25 }, bindingRule: "NEW_COURSE_TERMINAL", topologyRole: "COURSE_TERMINAL" },
      nodes: [], worldId: "world", generation: "g2",
    });
    expect(start.status).toBe("PASS");
    expect(end.status).toBe("PASS");
    if (start.status === "PASS" && end.status === "PASS") {
      expect(start.endpoint.entity).toEqual({ index: 77, version: 1 });
      expect(start.endpoint.worldEpoch).toBe("g2");
      expect(end.endpoint).toMatchObject({ kind: "NEW_FREE_ENDPOINT", role: "END", entity: null });
    }
  });

  test("supports START EXISTING + END EXISTING as separate current-generation bindings", () => {
    const start = rebindUtilityEndpoint({ binding: existing("START", "powered-source-node"), nodes: [node("g3", 81)], worldId: "world", generation: "g3" });
    const end = rebindUtilityEndpoint({ binding: { ...existing("END", "pump-road-node"), topologyRole: "PUMP_ACCESS_ROAD" },
      nodes: [node("g3", 82, { bindingRule: "pump-road-node", topologyRole: "PUMP_ACCESS_ROAD" })], worldId: "world", generation: "g3" });
    expect(start.status).toBe("PASS");
    expect(end.status).toBe("PASS");
  });

  test("fails closed for missing, ambiguous, stale-generation, topology, and position mismatch", () => {
    const binding = existing("START", "powered-source-node");
    expect(rebindUtilityEndpoint({ binding, nodes: [], worldId: "world", generation: "g1" })).toMatchObject({ status: "FAIL", reason: "ENDPOINT_NODE_MISSING" });
    expect(rebindUtilityEndpoint({ binding, nodes: [node("g1", 1), node("g1", 2)], worldId: "world", generation: "g1" })).toMatchObject({ status: "FAIL", reason: "ENDPOINT_NODE_AMBIGUOUS" });
    expect(rebindUtilityEndpoint({ binding, nodes: [node("old", 1)], worldId: "world", generation: "g1" })).toMatchObject({ status: "FAIL", reason: "ENDPOINT_NODE_MISSING" });
    expect(rebindUtilityEndpoint({ binding, nodes: [node("g1", 1, { topologyVerified: false })], worldId: "world", generation: "g1" })).toMatchObject({ status: "FAIL", reason: "ENDPOINT_TOPOLOGY_MISMATCH" });
    expect(rebindUtilityEndpoint({ binding, nodes: [node("g1", 1, { position: { x: 11, y: 2, z: 20 } })], worldId: "world", generation: "g1" })).toMatchObject({ status: "FAIL", reason: "ENDPOINT_POSITION_MISMATCH" });
  });

  test("exact identity binds both endpoint modes, order, quote, and repair step", () => {
    const start = existing("START", "powered-source-node");
    const freeEnd: UtilityEndpointBinding = { mode: "FREE_POINT", role: "END", utility: "ELECTRICITY", prefab: start.prefab,
      expectedPosition: { x: 15, y: 0, z: 25 }, bindingRule: "NEW_COURSE_TERMINAL", topologyRole: "COURSE_TERMINAL" };
    const base = { utility: "ELECTRICITY" as const, prefab: start.prefab, geometry: { x1: 10, z1: 20, x2: 15, z2: 25 },
      start, end: freeEnd, quote: 792, actionCount: 1 as const, repairLineage: "lineage", stepId: "step-1" };
    const identity = utilityActionIdentity(base);
    expect(utilityActionIdentity({ ...base, start: { ...start, mode: "FREE_POINT" } })).not.toBe(identity);
    expect(utilityActionIdentity({ ...base, end: { ...freeEnd, mode: "EXISTING_NET_NODE", bindingRule: "pump-road-node" } })).not.toBe(identity);
    expect(utilityActionIdentity({ ...base, start: { ...start, role: "END" }, end: { ...freeEnd, role: "START" } })).not.toBe(identity);
    expect(utilityActionIdentity({ ...base, quote: 793 })).not.toBe(identity);
    expect(utilityActionIdentity({ ...base, stepId: "step-2" })).not.toBe(identity);
  });
});
