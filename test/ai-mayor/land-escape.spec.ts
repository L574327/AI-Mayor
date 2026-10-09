import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { landPurchaseAffordable, landPurchaseRunwayAffordable, LAND_ESCAPE_RUNWAY_MONTHS } from "../../src/main/services/ai-mayor/v2/solvency";

const HOUR = 262_144 / 24;
let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };

/** One served street and ONE SMALL owned tile (-100..320) with a home in its far corner: industry (which must stand 400 m from homes) has no site on it. */
function smallTileWorld() {
  const nodes = Array.from({ length: 7 }, (_, index) => node(2.5 + index * 40, -62.5));
  const edges = Array.from({ length: 6 }, (_, index) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
    startNode: nodes[index]!.entity, endNode: nodes[index + 1]!.entity,
    start: { x: nodes[index]!.position.x, y: 0, z: -62.5 }, end: { x: nodes[index + 1]!.position.x, y: 0, z: -62.5 } }));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 320, z: 320 } }, center: { x: 110, z: 110 },
    polygon: [{ x: -100, z: -100 }, { x: 320, z: -100 }, { x: 320, z: 320 }, { x: -100, z: 320 }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

describe("a young city with cash but no surplus is not left standing still for want of land (live 2026-10-05: 70 of 83 cycles LAND_FINANCE_HELD, 800k in the bank)", () => {
  describe("landPurchaseRunwayAffordable (the way out; K34 stays the rule)", () => {
    const base = { ownedTiles: 9 };
    test("a tile whose deficit the cash carries for 12 months is allowed although the surplus does not cover it", () => {
      // Surplus +948, tile upkeep ~20k: deficit ~19k a month, 12 months = ~229k; the cash left after the district reserve (700k) carries it.
      expect(landPurchaseAffordable({ ...base, treasury: 800_000, monthlyBalance: 948 })).toBe(false);
      expect(landPurchaseRunwayAffordable({ ...base, treasury: 800_000, monthlyBalance: 948 })).toBe(true);
    });
    test("control: cash that cannot carry the deficit for the whole runway is refused (so it never buys itself into a hole)", () => {
      expect(landPurchaseRunwayAffordable({ ...base, treasury: 150_000, monthlyBalance: 948 })).toBe(false);
      // The arithmetic the rule is: 12 months of the deficit the tile adds (~19k a month) is ~229k, and 150k does not carry it.
      expect(150_000).toBeLessThan((20_000 - 948) * LAND_ESCAPE_RUNWAY_MONTHS);
    });
    test("control: unknown figures still refuse, and a surplus city needs no buffer at all", () => {
      // A city earning more than the tile costs carries no deficit to run down: its own cash is the gate (the flat 100,000 district reserve is gone —
      // live 2026-10-08, a city with +705,599 a month and 99,000 in hand was refused every tile by it).
      expect(landPurchaseRunwayAffordable({ ...base, treasury: 99_000, monthlyBalance: 50_000 })).toBe(true);
      expect(landPurchaseRunwayAffordable({ ...base, treasury: null, monthlyBalance: 50_000 })).toBe(false);
      expect(landPurchaseRunwayAffordable({ ...base, treasury: 800_000, monthlyBalance: null })).toBe(false);
    });
    test("a bigger measured upkeep needs more cash: the runway scales with what the tile really costs", () => {
      // A measured addition is taken with a 25% margin: 50k -> 62.5k a month, a 61.5k deficit, 738k over 12 months; 30k -> 37.5k a month, 36.5k, 438k.
      expect(landPurchaseRunwayAffordable({ ...base, treasury: 500_000, monthlyBalance: 948, observedMarginalUpkeep: 50_000 })).toBe(false);
      expect(landPurchaseRunwayAffordable({ ...base, treasury: 500_000, monthlyBalance: 948, observedMarginalUpkeep: 30_000 })).toBe(true);
    });
  });

  describe("through the district builder", () => {
    const run = (finance: { treasury: number; monthlyBalance: number }) => {
      const state = { frame: 5_000_000 };
      const bought: string[] = [];
      const port: DistrictBuilderPort = {
        scanWorld: async () => smallTileWorld(),
        listBuildings: async () => [{ position: { x: 300, z: 300 }, prefab: "EU_ResidentialLow01" }],
        siteDetail: async (center, radius) => ({ center, radius, terrain: dry as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        readPlanningTerrain: async () => dry as never,
        buildRoad: async () => ({ ok: true, detail: "ok" }),
        zone: async () => ({ ok: true, detail: "ok" }),
        readLabor: async () => ({ employed: 267, unemploymentRate: 0.39, jobsTotal: 267, jobsFree: 18 }),
        readGameFrame: async () => state.frame,
        purchaseTile: async (point) => { bought.push(`${Math.round(point.x)},${Math.round(point.z)}`); return { ok: true, detail: "purchased" }; },
      };
      const builder = new DistrictBuilder(port);
      // As in the live city: the unemployed need jobs, industry is the use asked for, and commercial is not on offer (it stood held), so no use can stand in for it.
      const cycle = () => builder.runCycle({ demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: (category: string) => (category === "commercial" ? null : "EU Zone"), pipelined: true,
        // Land is bought only once high density is open (新攻略补充).
        mayPurchaseLand: true, population: 332, finance, unlocked: { densities: { low: true, medium: true, high: true }, office: true } });
      return { cycle, state, bought };
    };

    test("plentiful cash that carries the tile's deficit for 12 months buys the tile at once, ahead of need — no waiting for a dead end (rolling land, P5)", async () => {
      const { cycle, bought } = run({ treasury: 800_000, monthlyBalance: 948 });
      const first = await cycle();
      expect(first.status).toBe("LAND_PURCHASED");
      expect(bought).toHaveLength(1);
      expect(first.notes.join(" | ")).toMatch(/land ahead \(P5\).*a tile is bought ahead of need/);
    });

    test("the tile bought last must hold a district before the next is bought (one unused tile at a time)", async () => {
      const { cycle, bought } = run({ treasury: 800_000, monthlyBalance: 948 });
      await cycle();
      const second = await cycle();
      expect(bought).toHaveLength(1);
      expect(second.status).toBe("NO_SITE");
    });

    test("the game refusing to sell a tile yet ('reach the next milestone') is a WAIT, not NO_FEASIBLE_SITE (live 2026-10-05: three in a row halted the run at 3 minutes)", async () => {
      const state = { frame: 5_000_000 };
      let asked = 0;
      const port: DistrictBuilderPort = {
        scanWorld: async () => smallTileWorld(),
        listBuildings: async () => [{ position: { x: 300, z: 300 }, prefab: "EU_ResidentialLow01" }],
        siteDetail: async (center, radius) => ({ center, radius, terrain: dry as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        readPlanningTerrain: async () => dry as never,
        buildRoad: async () => ({ ok: true, detail: "ok" }), zone: async () => ({ ok: true, detail: "ok" }),
        readLabor: async () => ({ employed: 267, unemploymentRate: 0.39, jobsTotal: 267, jobsFree: 18 }),
        readGameFrame: async () => state.frame,
        purchaseTile: async () => { asked += 1; return { ok: false, detail: "no map tile purchase is available now (reach the next milestone)" }; },
      };
      const builder = new DistrictBuilder(port);
      const finance = { treasury: 5_000_000, monthlyBalance: 200_000 };
      const result = await builder.runCycle({ demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: (category: string) => (category === "commercial" ? null : "EU Zone"), pipelined: true,
        // Land is bought only once high density is open (新攻略补充).
        mayPurchaseLand: true, population: 332, finance, unlocked: { densities: { low: true, medium: true, high: true }, office: true } });
      expect(asked).toBeGreaterThan(0);
      expect(result.outcome).toBe("WAIT");
      expect(result.waitReason).toBe("LAND_PURCHASE_UNAVAILABLE");
    });

    test("the escape buys on cash that can carry the tile's whole runway, and a city that cannot carry it is still held", async () => {
      // ~19k a month of deficit over the 12-month runway is ~229k: 100,000 does not carry it, so the city waits.
      const held = run({ treasury: 100_000, monthlyBalance: 948 });
      await held.cycle();
      held.state.frame += 10 * HOUR;
      expect((await held.cycle()).waitReason).toBe("LAND_FINANCE_HELD");
      expect(held.bought).toHaveLength(0);
      // The same city with 250,000 does carry it, so it buys the tile instead of standing still (the flat 100,000 reserve that used to refuse this was
      // the district reserve K34 held back; live 2026-10-05: 70 of 83 cycles LAND_FINANCE_HELD with 800,000 in the bank).
      const escaped = run({ treasury: 250_000, monthlyBalance: 948 });
      await escaped.cycle();
      escaped.state.frame += 10 * HOUR;
      expect((await escaped.cycle()).status).toBe("LAND_PURCHASED");
      expect(escaped.bought).toHaveLength(1);
    });

    test("control: a surplus that covers the tile still buys at once, by K34, with no escape note", async () => {
      const { cycle, bought } = run({ treasury: 800_000, monthlyBalance: 60_000 });
      const first = await cycle();
      expect(first.status).toBe("LAND_PURCHASED");
      expect(bought).toHaveLength(1);
      expect(first.notes.join(" | ")).not.toMatch(/carries the tile's deficit/);
    });
  });
});
