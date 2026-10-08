import type { SpatialBootstrapScan, SpatialTile } from "../../src/main/services/ai-mayor/spatial/types";
import {
  buildSpatialWorldModel,
  parseSpatialBootstrapScan,
  pointInTile,
  scanSpatialWorld,
} from "../../src/main/services/ai-mayor/spatial/world-scanner";

const ownedTile: SpatialTile = {
  entity: { index: 1, version: 1 },
  owned: true,
  bounds: { min: { x: 0, z: 0 }, max: { x: 100, z: 100 } },
  center: { x: 50, z: 50 },
  polygon: [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
  ],
};

function fixture(): SpatialBootstrapScan {
  return {
    world: { min: -1000, max: 1000, size: 2000 },
    tiles: [ownedTile],
    outsideConnections: [],
    bootstrapAssets: [],
    roadGraph: {
      truncated: false,
      nodes: [
        {
          entity: { index: 10, version: 1 },
          position: { x: 20, y: 5, z: 50 },
          native: true,
          outsideConnection: false,
          roadDegree: 1,
        },
        {
          entity: { index: 11, version: 1 },
          position: { x: -900, y: 5, z: 0 },
          native: true,
          outsideConnection: true,
          roadDegree: 1,
        },
        {
          entity: { index: 12, version: 1 },
          position: { x: 70, y: 5, z: 50 },
          native: true,
          outsideConnection: false,
          roadDegree: 2,
        },
        {
          entity: { index: 13, version: 1 },
          position: { x: 150, y: 5, z: 50 },
          native: true,
          outsideConnection: false,
          roadDegree: 1,
        },
      ],
      edges: [
        {
          entity: { index: 20, version: 1 },
          prefab: "Highway Oneway - 2 lanes",
          native: true,
          startNode: { index: 10, version: 1 },
          endNode: { index: 12, version: 1 },
          start: { x: 20, z: 50 },
          end: { x: 70, z: 50 },
          length: 50,
        },
        {
          entity: { index: 21, version: 1 },
          prefab: "Highway Oneway - 2 lanes",
          native: true,
          startNode: { index: 12, version: 1 },
          endNode: { index: 13, version: 1 },
          start: { x: 70, z: 50 },
          end: { x: 150, z: 50 },
          length: 80,
        },
      ],
    },
  };
}

describe("spatial world scanner", () => {
  test("uses polygon geometry instead of map names", () => {
    expect(pointInTile({ x: 50, z: 50 }, ownedTile)).toBe(true);
    expect(pointInTile({ x: 150, z: 50 }, ownedTile)).toBe(false);
  });

  test("keeps an owned native terminal without using a remote outside entity as the anchor", () => {
    const model = buildSpatialWorldModel(fixture());
    expect(model.connectionCandidates.map((candidate) => candidate.reason)).toEqual(["native_terminal_in_owned_area"]);
    expect(model.connectionCandidates[0].node.entity).toEqual({ index: 10, version: 1 });
  });

  test("traces a remote outside connection to deterministic gateways inside owned land", () => {
    const scan = fixture();
    scan.outsideConnections = [
      {
        entity: { index: 30, version: 1 },
        position: { x: -900, y: 5, z: 50 },
        connectedRoadEdges: [{ index: 40, version: 1 }],
      },
    ];
    scan.roadGraph.nodes = [
      {
        entity: { index: 30, version: 1 },
        position: { x: -900, y: 5, z: 50 },
        native: true,
        outsideConnection: true,
        roadDegree: 1,
      },
      {
        entity: { index: 31, version: 1 },
        position: { x: -100, y: 5, z: 50 },
        native: true,
        outsideConnection: false,
        roadDegree: 2,
      },
      {
        entity: { index: 32, version: 1 },
        position: { x: 20, y: 5, z: 50 },
        native: true,
        outsideConnection: false,
        roadDegree: 3,
      },
      {
        entity: { index: 33, version: 1 },
        position: { x: 70, y: 5, z: 50 },
        native: true,
        outsideConnection: false,
        roadDegree: 2,
      },
      {
        entity: { index: 34, version: 1 },
        position: { x: 70, y: 5, z: 80 },
        native: true,
        outsideConnection: false,
        roadDegree: 2,
      },
    ];
    scan.roadGraph.edges = [
      {
        entity: { index: 40, version: 1 },
        prefab: "Highway Twoway - 4 lanes",
        native: true,
        startNode: { index: 30, version: 1 },
        endNode: { index: 31, version: 1 },
        start: { x: -900, z: 50 },
        end: { x: -100, z: 50 },
        length: 800,
      },
      {
        entity: { index: 41, version: 1 },
        prefab: "Highway Twoway - 4 lanes",
        native: true,
        startNode: { index: 31, version: 1 },
        endNode: { index: 32, version: 1 },
        start: { x: -100, z: 50 },
        end: { x: 20, z: 50 },
        length: 120,
      },
      {
        entity: { index: 42, version: 1 },
        prefab: "Medium Road",
        native: true,
        startNode: { index: 32, version: 1 },
        endNode: { index: 33, version: 1 },
        start: { x: 20, z: 50 },
        end: { x: 70, z: 50 },
        length: 50,
      },
      {
        entity: { index: 43, version: 1 },
        prefab: "Medium Road",
        native: true,
        startNode: { index: 33, version: 1 },
        endNode: { index: 34, version: 1 },
        start: { x: 70, z: 50 },
        end: { x: 70, z: 80 },
        length: 30,
      },
      {
        entity: { index: 44, version: 1 },
        prefab: "Medium Road",
        native: true,
        startNode: { index: 34, version: 1 },
        endNode: { index: 32, version: 1 },
        start: { x: 70, z: 80 },
        end: { x: 20, z: 50 },
        length: 58,
      },
    ];

    const model = buildSpatialWorldModel(scan);
    expect(model.connectionCandidates.length).toBeGreaterThanOrEqual(2);
    expect(model.connectionCandidates.every((candidate) => candidate.reason === "ingress_gateway_in_owned_area")).toBe(
      true,
    );
    expect(model.connectionCandidates.every((candidate) => pointInTile(candidate.node.position, ownedTile))).toBe(true);
    expect(model.connectionCandidates.some((candidate) => candidate.node.entity.index === 32)).toBe(true);
    expect(
      model.connectionCandidates
        .filter((candidate) => candidate.node.entity.index === 32)
        .map((candidate) => candidate.orientationRank)
        .sort(),
    ).toEqual([0, 1]);
  });

  test("rejects incomplete or truncated scans", () => {
    expect(() => parseSpatialBootstrapScan({})).toThrow("world bounds");
    const scan = fixture();
    scan.roadGraph.truncated = true;
    expect(() => parseSpatialBootstrapScan(scan)).toThrow("truncated");
  });

  test("scans through an injected read-only port", async () => {
    const model = await scanSpatialWorld({ scan: async () => fixture() });
    expect(model.ownedTiles).toHaveLength(1);
    expect(model.connectionCandidates).toHaveLength(1);
  });
});
