import {
  MAX_COLLECTION_TERRAIN_CELL_METERS,
  pickCollectionSite,
  selectCollectionSite,
  terrainCellMeters,
} from "@/main/services/ai-mayor/v2/grid-collection-site";
import type {
  SpatialLocalTerrain,
  SpatialRoadNode,
  SpatialTile,
} from "@/main/services/ai-mayor/spatial/types";

const terrain = (options: { resolution?: number; span?: number; wetFromX?: number; heightPerCell?: number } = {}): SpatialLocalTerrain => {
  const resolution = options.resolution ?? 128;
  const span = options.span ?? 512;
  const heights = new Array(resolution * resolution).fill(0);
  const waterDepths = new Array(resolution * resolution).fill(0);
  const groundWater = new Array(resolution * resolution).fill(0);
  const groundWaterPollution = new Array(resolution * resolution).fill(0);
  const windSpeed = new Array(resolution * resolution).fill(0);
  const cellSize = { x: span / resolution, z: span / resolution };
  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col;
      if (options.heightPerCell) heights[index] = row * options.heightPerCell;
      if (options.wetFromX !== undefined) {
        const x = (col + 0.5) * cellSize.x;
        if (x >= options.wetFromX) waterDepths[index] = 2;
      }
    }
  }
  return {
    resolution,
    bounds: { minX: 0, minZ: 0, maxX: span, maxZ: span },
    cellSize,
    heights,
    waterDepths,
    groundWater,
    groundWaterPollution,
    windSpeed,
  };
};

const ownedTile = (minX: number, minZ: number, maxX: number, maxZ: number): SpatialTile => ({
  entity: { index: 1, version: 1 },
  owned: true,
  bounds: { min: { x: minX, z: minZ }, max: { x: maxX, z: maxZ } },
  center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
  polygon: [],
});

const node = (index: number, x: number, z: number): SpatialRoadNode => ({
  entity: { index, version: 1 },
  position: { x, y: 0, z },
  native: true,
  outsideConnection: false,
  roadDegree: 2,
});

const collection = { columnWidths: [80, 80], rowHeights: [80, 80] };

describe("collection site selection", () => {
  it("accepts a collection that reaches the network, sits on owned land and clears the ground", () => {
    const verdict = selectCollectionSite({
      anchor: { x: 100, z: 100 },
      collection,
      terrain: terrain(),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 100, 20)],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.anchor?.entity.index).toBe(7);
    expect(verdict.anchor?.distanceMeters).toBeCloseTo(80, 6);
    expect(verdict.terrain.water).toBe(0);
  });

  it("refuses a collection no existing node can anchor", () => {
    const verdict = selectCollectionSite({
      anchor: { x: 100, z: 100 },
      collection,
      terrain: terrain(),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 100, 900)],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("NO_ANCHOR_IN_REACH");
    expect(verdict.anchor).toBeNull();
  });

  it("takes the nearest anchor inside the reach and ignores outside connections", () => {
    const verdict = selectCollectionSite({
      anchor: { x: 100, z: 100 },
      collection,
      terrain: terrain(),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [
        { ...node(1, 200, 100), outsideConnection: true },
        node(2, 320, 100), // 60 m east of the collection's far edge
        node(3, 120, 100), // inside the collection
      ],
    });
    expect(verdict.anchor?.entity.index).toBe(3);
    expect(verdict.anchor?.distanceMeters).toBeCloseTo(0, 6);
  });

  it("refuses a collection that reaches water, and says so", () => {
    const verdict = selectCollectionSite({
      anchor: { x: 100, z: 100 },
      collection,
      terrain: terrain({ wetFromX: 150 }),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 100, 20)],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("WATER");
    expect(verdict.terrain.water).toBeGreaterThan(0);
  });

  it("refuses to certify a dry site from a read too coarse to see a patch", () => {
    // 2048 m across 32 cells is 64 m per cell: the read that called a wet plot dry.
    const coarse = terrain({ resolution: 32, span: 2048 });
    expect(terrainCellMeters(coarse)).toBeCloseTo(64, 6);
    const verdict = selectCollectionSite({
      anchor: { x: 100, z: 100 },
      collection,
      terrain: coarse,
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 100, 20)],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("TERRAIN_READ_TOO_COARSE");
    expect(MAX_COLLECTION_TERRAIN_CELL_METERS).toBeLessThan(terrainCellMeters(coarse));
  });

  it("refuses a collection over the grade bound", () => {
    const steep = terrain({ heightPerCell: 60 });
    const verdict = selectCollectionSite({
      anchor: { x: 100, z: 100 },
      collection,
      terrain: steep,
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 100, 20)],
    });
    expect(verdict.violations).toContain("STEEP_GRADE");
  });

  it("refuses a collection that spills off owned land", () => {
    const verdict = selectCollectionSite({
      anchor: { x: 380, z: 380 },
      collection,
      terrain: terrain(),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 380, 300)],
    });
    expect(verdict.violations).toContain("OUTSIDE_OWNED");
  });

  it("refuses an anchor on a component other than the main one", () => {
    // Two chains. The anchor node 7 is within reach of the collection, but it
    // sits on the island chain 7-8; the main net is 5-6. Being NEAR a road is
    // not being connected to it, which is how the 2026-10-02 district came out
    // an island on a 62-street component with no facility on it.
    const roadEdges = [
      { startNode: { index: 5, version: 1 }, endNode: { index: 6, version: 1 } },
      { startNode: { index: 7, version: 1 }, endNode: { index: 8, version: 1 } },
    ];
    const base = {
      anchor: { x: 100, z: 100 },
      collection,
      terrain: terrain(),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      // 80 m from the rect for node 7 (the island) against 100 m for node 5
      // (the main net), so the island node is the one the site anchors to.
      roadNodes: [node(7, 100, 20), node(5, 118, 0)],
    };
    const island = selectCollectionSite({ ...base, roadEdges, mainComponentRoot: { index: 5, version: 1 } });
    expect(island.anchor?.entity.index).toBe(7);
    expect(island.violations).toContain("ANCHOR_NOT_ON_MAIN_COMPONENT");
    expect(island.ok).toBe(false);

    // Only the MAIN chain reaches this site, so the anchor is on the net that
    // carries the utilities and the component check passes.
    const joined = selectCollectionSite({
      ...base,
      roadNodes: [node(5, 118, 30)],
      roadEdges,
      mainComponentRoot: { index: 5, version: 1 },
    });
    expect(joined.violations).not.toContain("ANCHOR_NOT_ON_MAIN_COMPONENT");
  });

  it("picks the first passing candidate and reports nothing when none pass", () => {
    const bad = {
      anchor: { x: 100, z: 100 },
      collection,
      terrain: terrain({ wetFromX: 0 }),
      ownedTiles: [ownedTile(0, 0, 400, 400)],
      roadNodes: [node(7, 100, 20)],
    };
    const good = { ...bad, terrain: terrain() };
    const picked = pickCollectionSite([bad, good]);
    expect(picked?.index).toBe(1);
    expect(picked?.verdict.ok).toBe(true);
    expect(pickCollectionSite([bad])).toBeNull();
  });
});
