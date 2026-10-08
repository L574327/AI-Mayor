import { evaluateBootstrapSites } from "../../src/main/services/ai-mayor/spatial/site-finder";
import type {
  SpatialConnectionCandidate,
  SpatialSiteDetail,
  SpatialTile,
  SpatialWorldModel,
} from "../../src/main/services/ai-mayor/spatial/types";

const tile: SpatialTile = {
  entity: { index: 1, version: 1 },
  owned: true,
  bounds: { min: { x: -300, z: -100 }, max: { x: 300, z: 400 } },
  center: { x: 0, z: 150 },
  polygon: [],
};

const connection: SpatialConnectionCandidate = {
  reason: "native_terminal_in_owned_area",
  node: {
    entity: { index: 10, version: 1 },
    position: { x: 0, y: 10, z: 0 },
    native: true,
    outsideConnection: false,
    roadDegree: 1,
  },
};

function model(): SpatialWorldModel {
  return {
    worldBounds: { min: -1000, max: 1000, size: 2000 },
    ownedTiles: [tile],
    outsideConnections: [],
    connectionCandidates: [connection],
    roadGraph: {
      truncated: false,
      nodes: [connection.node],
      edges: [
        {
          entity: { index: 20, version: 1 },
          prefab: "Medium Road",
          native: true,
          startNode: { index: 11, version: 1 },
          endNode: connection.node.entity,
          start: { x: 0, z: -100 },
          end: { x: 0, z: 0 },
          length: 100,
        },
      ],
    },
  };
}

function detail(wet = false): SpatialSiteDetail {
  const resolution = 64;
  return {
    center: { x: 0, z: 150 },
    radius: 300,
    terrain: {
      resolution,
      bounds: { minX: -300, minZ: -150, maxX: 300, maxZ: 450 },
      cellSize: { x: 600 / resolution, z: 600 / resolution },
      heights: Array(resolution * resolution).fill(10),
      waterDepths: Array(resolution * resolution).fill(wet ? 1 : 0),
      groundWater: Array(resolution * resolution).fill(100),
      groundWaterPollution: Array(resolution * resolution).fill(0),
      windSpeed: Array(resolution * resolution).fill(1),
    },
    roadGraph: { nodes: [], edges: [] },
    buildings: [],
    zoningCells: [],
  };
}

describe("bootstrap site finder", () => {
  test("derives a closed starter grid from the incoming road tangent", () => {
    const evaluation = evaluateBootstrapSites(model(), new Map([["10:1", detail()]]))[0];
    expect(evaluation.valid).toBe(true);
    expect(evaluation.layout.forward).toEqual({ x: 0, z: 1 });
    expect(evaluation.layout.segments).toHaveLength(7);
    expect(evaluation.layout.futureExpansionPoint).toEqual({ x: 0, z: 240 });
  });

  test("rejects a layout whose sampled road geometry intersects water", () => {
    const evaluation = evaluateBootstrapSites(model(), new Map([["10:1", detail(true)]]))[0];
    expect(evaluation.valid).toBe(false);
    expect(evaluation.rejectionReasons.some((reason) => reason.includes("intersect water"))).toBe(true);
  });

  test("builds inward from a traced ingress gateway using its explicit branch direction", () => {
    const ingress: SpatialConnectionCandidate = {
      ...connection,
      reason: "ingress_gateway_in_owned_area",
      incomingEdge: { index: 20, version: 1 },
      forward: { x: 0, z: 1 },
      graphDistanceFromOutside: 1200,
      orientationRank: 0,
    };
    const ingressModel = model();
    ingressModel.connectionCandidates = [ingress];
    const evaluation = evaluateBootstrapSites(ingressModel, new Map([["10:1", detail()]]))[0];
    expect(evaluation.valid).toBe(true);
    expect(evaluation.connection.reason).toBe("ingress_gateway_in_owned_area");
    expect(evaluation.layout.forward).toEqual({ x: 0, z: 1 });
    expect(evaluation.layout.incomingEdge).toEqual({ index: 20, version: 1 });
  });
});
