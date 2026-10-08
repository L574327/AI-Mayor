import { flatFreePatches, rankFrontierPatches } from "../../src/main/services/ai-mayor/v2/frontier-discovery";

const RES = 16;
const detailWith = (patch: { water?: number[]; heights?: number[]; buildings?: Array<{ x: number; z: number }>;
  edges?: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> } = {}) => ({
  center: { x: 0, z: 0 }, radius: 320,
  terrain: {
    resolution: RES, bounds: { minX: -320, minZ: -320, maxX: 320, maxZ: 320 }, cellSize: { x: 40, z: 40 },
    heights: patch.heights ?? new Array(RES * RES).fill(400),
    waterDepths: patch.water ?? new Array(RES * RES).fill(0),
    groundWater: [], groundWaterPollution: [], windSpeed: [],
  },
  roadGraph: { nodes: [], edges: (patch.edges ?? []).map((edge) => ({ ...edge, deleted: false })) },
  buildings: (patch.buildings ?? []).map((b) => ({ position: { x: b.x, y: 0, z: b.z } })),
  zoningCells: [],
}) as never;
const owned = () => true;

describe("frontier discovery", () => {
  test("flat, dry, empty owned ground yields patches", () => {
    expect(flatFreePatches({ detail: detailWith(), isOwned: owned }).length).toBeGreaterThan(0);
  });

  test("ground the city does not own yields nothing", () => {
    expect(flatFreePatches({ detail: detailWith(), isOwned: () => false })).toEqual([]);
  });

  test("a fully wet read yields nothing and a single wet cell removes every patch that contains it", () => {
    expect(flatFreePatches({ detail: detailWith({ water: new Array(RES * RES).fill(1) }), isOwned: owned })).toEqual([]);
    const all = flatFreePatches({ detail: detailWith(), isOwned: owned }).length;
    const water = new Array(RES * RES).fill(0); water[8 * RES + 8] = 2;
    expect(flatFreePatches({ detail: detailWith({ water }), isOwned: owned }).length).toBeLessThan(all);
  });

  test("steep ground is refused", () => {
    const heights = Array.from({ length: RES * RES }, (_, i) => 400 + (i % RES) * 10);
    expect(flatFreePatches({ detail: detailWith({ heights }), isOwned: owned })).toEqual([]);
  });

  test("a building or an existing road removes the patches around it", () => {
    const all = flatFreePatches({ detail: detailWith(), isOwned: owned }).length;
    expect(flatFreePatches({ detail: detailWith({ buildings: [{ x: 20, z: 20 }] }), isOwned: owned }).length).toBeLessThan(all);
    expect(flatFreePatches({
      detail: detailWith({ edges: [{ start: { x: -320, z: 0 }, end: { x: 320, z: 0 } }] }), isOwned: owned,
    }).length).toBeLessThan(all);
  });

  test("patches are ranked nearest the network first and thinned", () => {
    const patches = [{ center: { x: 500, z: 0 }, sideMeters: 200 }, { center: { x: 120, z: 0 }, sideMeters: 200 },
      { center: { x: 130, z: 10 }, sideMeters: 200 }, { center: { x: 900, z: 0 }, sideMeters: 200 }];
    const ranked = rankFrontierPatches({ patches, network: [{ x: 0, z: 0 }], separationMeters: 200 });
    expect(ranked.map((entry) => entry.center.x)).toEqual([120, 500, 900]);
    expect(ranked[0]!.from).toEqual({ x: 0, z: 0 });
    expect(rankFrontierPatches({ patches, network: [] })).toEqual([]);
  });
});
