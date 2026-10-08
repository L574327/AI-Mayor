import {
  roadGraphRevision,
  roadIntentExecutionTask,
  roadIntentFreshness,
  roadIntentOperationId,
  resolveRoadIntent,
  type RoadIntent,
  type RoadIntentWorld,
} from "../../src/main/services/ai-mayor/v2/road-intent";
import { createRoadCourseCertificationCache } from "../../src/main/services/ai-mayor/v2/road-course-sweep";
import type { RoadGeometryInput } from "../../src/main/services/ai-mayor/v2/road-kernel";
import type { SpatialRoadNode } from "../../src/main/services/ai-mayor/spatial/types";

const certifiable = () => ({
  valid: true,
  previewOnly: true,
  validNewRoadProposal: true,
  roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
  courseIntegrity: {
    operationKind: "NEW_ROAD_PROPOSAL_EDGE",
    postHandoffGeometryPreserved: true,
    proposalEdgeCount: 1,
    firstFailure: null,
  },
});

const noProposalEdge = () => ({
  valid: false,
  previewOnly: true,
  validNewRoadProposal: false,
  courseIntegrity: {
    operationKind: "NEW_ROAD_PROPOSAL_EDGE",
    postHandoffGeometryPreserved: true,
    proposalEdgeCount: 0,
    firstFailure: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED",
  },
});

/** The live node `75948:215` from the 2026-10-01 measurement. */
const SOURCE_NODE: SpatialRoadNode = {
  entity: { index: 75948, version: 215 },
  position: { x: 1347.9, y: 12.5, z: 420.6 },
  native: true,
  outsideConnection: false,
  roadDegree: 2,
};

const worldOf = (overrides: Partial<RoadIntentWorld> = {}): RoadIntentWorld => ({
  worldId: "cs2-session:d8413e4f",
  worldEpoch: "epoch-a",
  topologyRevision: "rev-a",
  nodes: [SOURCE_NODE],
  ...overrides,
});

const intentOf = (overrides: Partial<RoadIntent> = {}): RoadIntent => ({
  intentId: "GROWTH:EXPAND_RESIDENTIAL:0007",
  prefab: "Medium Road",
  from: { kind: "EXISTING_NET_NODE", entity: { index: 75948, version: 215 } },
  to: { kind: "FREE_POINT", position: { x: 1400, y: 12.5, z: 420.6 } },
  owner: { ownerType: "TASK", ownerId: "task:road:1" },
  ...overrides,
});

describe("V2 road intent identity", () => {
  test("the operation id is a function of the intent and the course ordinal alone", () => {
    const id = roadIntentOperationId("GROWTH:EXPAND_RESIDENTIAL:0007", 3);
    expect(id).toBe(roadIntentOperationId("GROWTH:EXPAND_RESIDENTIAL:0007", 3));
    expect(id).toMatch(/^road-op:[0-9a-f]{16}$/);
    expect(roadIntentOperationId("GROWTH:EXPAND_RESIDENTIAL:0007", 4)).not.toBe(id);
    expect(roadIntentOperationId("GROWTH:EXPAND_RESIDENTIAL:0008", 3)).not.toBe(id);
  });

  test("refuses an identity it cannot derive", () => {
    expect(() => roadIntentOperationId("", 0)).toThrow("ROAD_INTENT_OPERATION_IDENTITY_INVALID");
    expect(() => roadIntentOperationId("intent", -1)).toThrow("ROAD_INTENT_OPERATION_IDENTITY_INVALID");
    expect(() => roadIntentOperationId("intent", 1.5)).toThrow("ROAD_INTENT_OPERATION_IDENTITY_INVALID");
  });

  test("the same intent keeps its identity across worlds, and a moved world reports STALE", () => {
    const binding = { worldId: "cs2-session:d8413e4f", worldEpoch: "epoch-a", topologyRevision: "rev-a" };
    expect(roadIntentFreshness(binding, { worldId: "cs2-session:d8413e4f", topologyRevision: "rev-a" })).toBe("FRESH");
    // A road was built, so the graph revision moved. The road is not a new road.
    expect(roadIntentFreshness(binding, { worldId: "cs2-session:d8413e4f", topologyRevision: "rev-b" })).toBe("STALE");
    expect(roadIntentFreshness(binding, { worldId: "cs2-session:9999", topologyRevision: "rev-a" })).toBe("STALE");
  });

  test("the graph revision is a function of the road graph, not of the native session", () => {
    const base = { nodes: [SOURCE_NODE], edges: [] };
    expect(roadGraphRevision(base)).toBe(roadGraphRevision(base));
    const withRoad = {
      nodes: base.nodes,
      edges: [{
        entity: { index: 100, version: 1 }, prefab: "Medium Road", native: true,
        startNode: { index: 75948, version: 215 }, endNode: { index: 76300, version: 1 },
        start: { x: 1347.9, z: 420.6 }, end: { x: 1400, z: 420.6 }, length: 52.1,
      }],
    };
    expect(roadGraphRevision(withRoad)).not.toBe(roadGraphRevision(base));
  });
});

describe("V2 road intent resolution", () => {
  test("binds an existing node from the live scan, never from a value carried in the intent", async () => {
    const seen: RoadGeometryInput[] = [];
    const resolution = await resolveRoadIntent(intentOf(), worldOf(), {
      probe: async (input) => {
        seen.push(input);
        return certifiable();
      },
    });
    expect(resolution.status).toBe("CERTIFIED");
    if (resolution.status !== "CERTIFIED") throw new Error("unreachable");
    // The exact scan coordinate, not a fuzzed one: native validates this field
    // exactly and answers ROAD_ENDPOINT_POSITION_MISMATCH otherwise.
    expect(seen[0].startEndpoint).toEqual({
      kind: "EXISTING_NET_NODE",
      role: "START",
      entity: { index: 75948, version: 215 },
      expectedPosition: { x: 1347.9, y: 12.5, z: 420.6 },
      worldEpoch: "epoch-a",
    });
    // Nothing in the intent could have supplied it.
    expect(JSON.stringify(intentOf())).not.toContain("1347.9");
    expect(resolution.from).toEqual({ entity: { index: 75948, version: 215 }, position: SOURCE_NODE.position });
  });

  test("binds a road the product itself delivered, which the scan does not mark native", async () => {
    // Measured live 2026-10-01: node 75948:215 is in the scan's road graph with
    // real geometry and roadDegree 2, and `native: false`. Gating on the origin
    // flag excluded the entire network the Mayor is supposed to extend.
    const productBuilt: SpatialRoadNode = { ...SOURCE_NODE, native: false };
    const resolution = await resolveRoadIntent(intentOf(), worldOf({ nodes: [productBuilt] }), {
      probe: async () => certifiable(),
    });
    expect(resolution.status).toBe("CERTIFIED");
    if (resolution.status !== "CERTIFIED") throw new Error("unreachable");
    expect(resolution.input.startEndpoint?.expectedPosition).toEqual(productBuilt.position);
  });

  test("names the operation from the ordinal the sweep actually certified", async () => {
    let call = 0;
    const resolution = await resolveRoadIntent(intentOf(), worldOf(), {
      probe: async () => {
        call += 1;
        return call < 4 ? noProposalEdge() : certifiable();
      },
    });
    expect(resolution.status).toBe("CERTIFIED");
    if (resolution.status !== "CERTIFIED") throw new Error("unreachable");
    expect(resolution.ordinal).toBe(3);
    expect(resolution.operationId).toBe(roadIntentOperationId("GROWTH:EXPAND_RESIDENTIAL:0007", 3));
    expect(resolution.input.x1).toBe(1347.9);
    expect(resolution.input.z1).toBe(420.6);
    expect(resolution.input.x2).toBe(resolution.course.endpoint.x);
    expect(resolution.input.z2).toBe(resolution.course.endpoint.z);
  });

  test("the certified geometry is the geometry the caller must authorize", async () => {
    const resolution = await resolveRoadIntent(intentOf(), worldOf(), { probe: async () => certifiable() });
    if (resolution.status !== "CERTIFIED") throw new Error("unreachable");
    const task = roadIntentExecutionTask(resolution, intentOf().owner);
    expect(task.owner).toEqual({ ownerType: "TASK", ownerId: "task:road:1" });
    // The bound START survives: an execution built without it would bind a
    // different road than the one native certified.
    expect(task.input.startEndpoint).toEqual(resolution.input.startEndpoint);
    expect(task.input).toMatchObject({ prefab: "Medium Road", x1: resolution.input.x1, z1: resolution.input.z1 });
  });

  test("an endpoint that is not in the live topology fails closed rather than inventing a position", async () => {
    const missing = intentOf({ from: { kind: "EXISTING_NET_NODE", entity: { index: 1, version: 1 } } });
    const resolution = await resolveRoadIntent(missing, worldOf(), {
      probe: async () => {
        throw new Error("the sweep must not be reached");
      },
    });
    expect(resolution).toMatchObject({ status: "UNRESOLVED", reason: "ROAD_INTENT_FROM_NOT_BOUND" });
  });

  test("a refused endpoint binding is reported as a binding failure, not as land that takes no road", async () => {
    const resolution = await resolveRoadIntent(intentOf(), worldOf(), {
      probe: async () => {
        throw Object.assign(new Error("ROAD_ENDPOINT_POSITION_MISMATCH"), {
          status: 409,
          body: {
            rejectionDiagnostics: { stage: "DEFINITION", errorType: "ROAD_ENDPOINT_POSITION_MISMATCH", message: "ROAD_ENDPOINT_POSITION_MISMATCH" },
          },
        });
      },
    });
    expect(resolution).toMatchObject({
      status: "UNRESOLVED",
      reason: "ROAD_INTENT_ENDPOINT_BINDING_REJECTED",
      detail: "ROAD_ENDPOINT_POSITION_MISMATCH",
    });
  });

  test("a source with no certifiable course reports the whole refusal set", async () => {
    const resolution = await resolveRoadIntent(intentOf(), worldOf(), { probe: async () => noProposalEdge() });
    expect(resolution).toMatchObject({ status: "UNRESOLVED", reason: "ROAD_INTENT_NO_CERTIFIABLE_COURSE" });
    if (resolution.status !== "UNRESOLVED") throw new Error("unreachable");
    expect(resolution.rejections.length).toBeGreaterThan(0);
    expect(resolution.rejections[0]).toMatchObject({ verdict: "NO_PROPOSAL_EDGE" });
  });

  test("a cache certified against another graph revision is ignored, not trusted", async () => {
    const staleCache = createRoadCourseCertificationCache({ worldId: "cs2-session:d8413e4f", topologyRevision: "rev-a" });
    staleCache.put("1347.900:420.600", "1347.900:420.600|1400.000:420.600", {
      verdict: { status: "CERTIFIABLE", proposalEdgeCount: 1 },
      preview: {},
    });
    let calls = 0;
    const resolution = await resolveRoadIntent(intentOf(), worldOf({ topologyRevision: "rev-b" }), {
      probe: async () => {
        calls += 1;
        return certifiable();
      },
      cache: staleCache,
    });
    expect(calls).toBe(1);
    expect(resolution.status).toBe("CERTIFIED");
    if (resolution.status !== "CERTIFIED") throw new Error("unreachable");
    expect(resolution.cacheHit).toBe(false);
    expect(resolution.binding.topologyRevision).toBe("rev-b");
  });

  test("a cache certified against the same graph removes the probes on the next tick", async () => {
    const warm = createRoadCourseCertificationCache({ worldId: "cs2-session:d8413e4f", topologyRevision: "rev-a" });
    const first = await resolveRoadIntent(intentOf(), worldOf(), { probe: async () => certifiable(), cache: warm });
    expect(first.status).toBe("CERTIFIED");

    let calls = 0;
    const second = await resolveRoadIntent(intentOf(), worldOf(), {
      probe: async () => {
        calls += 1;
        return certifiable();
      },
      cache: warm,
    });
    expect(calls).toBe(0);
    expect(second.status).toBe("CERTIFIED");
    if (second.status !== "CERTIFIED") throw new Error("unreachable");
    expect(second.cacheHit).toBe(true);
  });
});
