import { compileDistrict, DistrictBuilder, type DistrictBuilderPort, type DistrictSite } from "../../src/main/services/ai-mayor/v2/district-builder";
import { findWaterCrossings, selectBridgeBatch, BRIDGES_PER_BATCH, BRIDGE_FAR_BANK_RUN_METERS, MINIMUM_FAR_BANK_FREE_CELLS } from "../../src/main/services/ai-mayor/v2/water-crossing";

/** A terrain read of 2,000 x 2,000 m (20 m cells): dry everywhere except a river band between x = -100 and x = 100, `depth` metres deep. */
function riverTerrain(depth = 10, band = { minX: -100, maxX: 100 }) {
  const resolution = 100;
  const waterDepths = new Array<number>(resolution * resolution).fill(0);
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const x = -1000 + (column + 0.5) * 20;
      if (x >= band.minX && x <= band.maxX) waterDepths[row * resolution + column] = depth;
    }
  }
  return { resolution, bounds: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 }, cellSize: { x: 20, z: 20 }, heights: new Array<number>(resolution * resolution).fill(450),
    waterDepths, groundWater: [], groundWaterPollution: [], windSpeed: [] };
}

const base = (overrides: Record<string, unknown> = {}) => ({ terrain: riverTerrain() as never, servedNodes: [{ x: -300, z: 0 }], isOwned: () => true, freeCellsAround: () => 100, ...overrides });

describe("a river that cuts the owned ground in two is crossed by one road to the far bank (live 2026-10-05: 256-370 m of water, the game builds a Medium Road over it at elevation 0)", () => {
  describe("findWaterCrossings", () => {
    test("from a served node on one bank, straight over the water, to dry land on the other 鈥?with the span, the length and what the far bank opens", () => {
      const crossings = findWaterCrossings(base());
      expect(crossings).toHaveLength(1);
      const crossing = crossings[0]!;
      expect(crossing.from).toEqual({ x: -300, z: 0 });
      expect(crossing.to.z).toBe(0);
      expect(crossing.waterMeters).toBeGreaterThanOrEqual(180);
      expect(crossing.waterMeters).toBeLessThanOrEqual(220);
      // The road ends BRIDGE_FAR_BANK_RUN_METERS beyond the first dry sample, on dry ground.
      expect(crossing.to.x).toBeGreaterThan(100 + BRIDGE_FAR_BANK_RUN_METERS - 1);
      expect(crossing.farFreeCells).toBe(100);
    });

    test("control: water that is wider than the span the game is known to take is not asked for", () => {
      const wide = riverTerrain(10, { minX: -200, maxX: 200 }) as never;
      expect(findWaterCrossings(base({ terrain: wide, maximumSpanMeters: 450 }))).toHaveLength(1);
      expect(findWaterCrossings(base({ terrain: wide, maximumSpanMeters: 300 }))).toHaveLength(0);
    });

    test("control: a far bank nobody owns, an unread far bank, or no far bank at all gives no crossing", () => {
      expect(findWaterCrossings(base({ isOwned: (point: { x: number }) => point.x < 100 }))).toHaveLength(0);
      expect(findWaterCrossings(base({ terrain: undefined }))).toHaveLength(0);
      // Open water all the way to the edge of the read: no far bank.
      expect(findWaterCrossings(base({ terrain: riverTerrain(10, { minX: -100, maxX: 5_000 }) as never }))).toHaveLength(0);
    });

    test("control: a far bank the served streets already reach, or one with too little free land, is not worth a road", () => {
      expect(findWaterCrossings(base({ servedNodes: [{ x: -300, z: 0 }, { x: 200, z: 0 }] }))).toHaveLength(0);
      expect(findWaterCrossings(base({ freeCellsAround: () => MINIMUM_FAR_BANK_FREE_CELLS - 1 }))).toHaveLength(0);
    });

    test("control: shallow wet ground (a puddle) is not open water, so nothing is bridged over dry land", () => {
      expect(findWaterCrossings(base({ terrain: riverTerrain(0.2) as never }))).toHaveLength(0);
    });
  });

  describe("the idle loop of 2026-10-05 (68 of 127 cycles REPLAN_REQUIRED): a site whose way in crosses the river says so", () => {
    // Dry ground east of the river (x 120-520), its gateway from a served node on the west bank (x -300) straight over the water.
    const site: DistrictSite = { anchor: { x: 160, z: -120 }, columnWidths: [120, 120], rowHeights: [120, 120], widthMeters: 240, heightMeters: 240,
      gateway: { from: { x: -300, z: 0 }, to: { x: 160, z: 0 }, lengthMeters: 460 }, score: 0, alternativeGateways: [] };
    test("the ground refuses it with the reason GATEWAY_GROUND (the land is fine; the road to it is the bridge's case)", () => {
      const why: { reason?: string } = {};
      expect(compileDistrict(site, riverTerrain() as never, why as never)).toBeNull();
      expect(why.reason).toBe("GATEWAY_GROUND");
    });
    test("control: the same site with a dry way in compiles", () => {
      const why: { reason?: string } = {};
      expect(compileDistrict({ ...site, gateway: { from: { x: 160, z: -200 }, to: { x: 160, z: -120 }, lengthMeters: 80 } }, riverTerrain() as never, why as never)).not.toBeNull();
      expect(why.reason).toBeUndefined();
    });
  });

  describe("a batch of bridges, like a street grid", () => {
    const nodes = [-600, -400, -200, 0, 200, 400].map((z) => ({ x: -300, z }));
    test("the crossing that opens the most land comes first, not merely the narrowest water", () => {
      const crossings = findWaterCrossings(base({ servedNodes: nodes, freeCellsAround: (point: { z: number }) => (point.z === 200 ? 400 : 100) }));
      expect(crossings[0]!.from.z).toBe(200);
    });
    test("up to BRIDGES_PER_BATCH crossings, spaced apart so none duplicates another", () => {
      const crossings = findWaterCrossings(base({ servedNodes: [...nodes, { x: -300, z: 20 }, { x: -300, z: 40 }] }));
      const batch = selectBridgeBatch(crossings);
      expect(batch.length).toBeGreaterThan(1);
      expect(batch.length).toBeLessThanOrEqual(BRIDGES_PER_BATCH);
      for (const [index, left] of batch.entries()) for (const right of batch.slice(index + 1)) expect(Math.abs(left.from.z - right.from.z)).toBeGreaterThanOrEqual(120);
    });
  });
  describe("through the district builder", () => {
    const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
    const nodes = Array.from({ length: 6 }, (_, i) => node(-560 + i * 40, 0, 100 + i));
    const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
      start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
    const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -900, z: -900 }, max: { x: 900, z: 900 } }, center: { x: 0, z: 0 },
      polygon: [{ x: -900, z: -900 }, { x: 900, z: -900 }, { x: 900, z: 900 }, { x: -900, z: 900 }] };
    const world = { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;

    // Three parallel served streets (z = -400, 0, 400) on the west bank: the river crossing is offered from each, and one cycle builds them together.
    const rows = [-400, 0, 400];
    const gridNodes = rows.flatMap((z, row) => Array.from({ length: 6 }, (_, i) => node(-560 + i * 40, z, 1000 + row * 10 + i)));
    const gridEdges = rows.flatMap((z, row) => Array.from({ length: 5 }, (_, i) => ({ entity: { index: 2000 + row * 10 + i, version: 1 }, prefab: "Medium Road", native: false,
      startNode: gridNodes[row * 6 + i]!.entity, endNode: gridNodes[row * 6 + i + 1]!.entity, start: { x: -560 + i * 40, y: 0, z }, end: { x: -520 + i * 40, y: 0, z } })));
    // One street along the west edge joins the three into one served network.
    for (const row of [0, 1]) gridEdges.push({ entity: { index: 3000 + row, version: 1 }, prefab: "Medium Road", native: false, startNode: gridNodes[row * 6]!.entity, endNode: gridNodes[(row + 1) * 6]!.entity,
      start: { x: -560, y: 0, z: rows[row]! }, end: { x: -560, y: 0, z: rows[row + 1]! } });
    test("a batch: three streets reach the river, and one cycle builds a bridge from each (not one at a time)", async () => {
      const built: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
      const gridWorld = { roadGraph: { nodes: gridNodes, edges: gridEdges }, ownedTiles: [tile] } as never;
      const port: DistrictBuilderPort = {
        scanWorld: async () => gridWorld, listBuildings: async () => [],
        siteDetail: async (center, radius) => ({ center, radius, terrain: riverTerrain() as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        readPlanningTerrain: async () => riverTerrain() as never,
        buildRoad: async (course) => { built.push(course); return { ok: true, detail: "ok" }; },
        preflightRoad: async () => "OK",
        zone: async () => ({ ok: true, detail: "ok" }),
      };
      const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
      const result = await builder.runCycle({ demand: { residential: 80, commercial: 0, industrial: 0 }, zoneFor: () => "EU Zone", pipelined: true, mayPurchaseLand: false,
        population: 500, finance: { treasury: 2_000_000, monthlyBalance: 100_000 } } as never);
      const bridges = built.filter((course) => course.start.x < 0 && course.end.x > 0 && course.end.x - course.start.x > 300);
      expect(new Set(bridges.map((course) => course.start.z)).size).toBe(3);
      expect(result.notes.join(" | ")).toMatch(/bridges: 3 built of 3 asked/);
    });
    function run(verdict: string) {
      const built: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
      const port: DistrictBuilderPort = {
        scanWorld: async () => world, listBuildings: async () => [],
        siteDetail: async (center, radius) => ({ center, radius, terrain: riverTerrain() as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        readPlanningTerrain: async () => riverTerrain() as never,
        buildRoad: async (course) => { built.push(course); return { ok: true, detail: "ok" }; },
        preflightRoad: async () => verdict,
        zone: async () => ({ ok: true, detail: "ok" }),
      };
      const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
      const cycle = () => builder.runCycle({ demand: { residential: 80, commercial: 0, industrial: 0 }, zoneFor: () => "EU Zone", pipelined: true, mayPurchaseLand: false,
        population: 500, finance: { treasury: 2_000_000, monthlyBalance: 100_000 } } as never);
      return { built, cycle };
    }

    test("the land the served streets reach is running low and the far bank is owned and free: one road goes over the river, from the served node, and the note says so", async () => {
      const { built, cycle } = run("OK");
      const result = await cycle();
      const bridge = built.find((course) => course.start.x === -360 && course.start.z === 0 && course.end.x > 0);
      expect(bridge).toBeDefined();
      expect(result.notes.join(" | ")).toMatch(/bridge \(-360,0\) to \(.*\): \d+ m of water, \d+ free cells on the far bank: built/);
    });

    test("control: the game's dry run refuses the road: nothing is built over the river, the refusal is counted and tried again later, a bounded number of times", async () => {
      const { built, cycle } = run("REJECT:operation blocked by game validation (water)");
      const result = await cycle();
      expect(built.some((course) => course.end.x > 0 && course.start.x < 0 && course.end.x - course.start.x > 300)).toBe(false);
      expect(result.notes.join(" | ")).toMatch(/refused by the dry run .*attempt 1 of 3/);
    });
  });
});

