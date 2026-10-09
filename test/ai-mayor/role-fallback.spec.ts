import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { chooseGrowthRole } from "../../src/main/services/ai-mayor/v2/growth-policy";

const HOUR = 262_144 / 24;
const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };
let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });

/** One served street along z = -62.5 and ONE SMALL owned tile (-100..320): every spot of it lies within 400 m of a home at its far corner. */
function smallTileWorld() {
  const nodes = Array.from({ length: 7 }, (_, index) => node(2.5 + index * 40, -62.5));
  const edges = Array.from({ length: 6 }, (_, index) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
    startNode: nodes[index]!.entity, endNode: nodes[index + 1]!.entity,
    start: { x: nodes[index]!.position.x, y: 0, z: -62.5 }, end: { x: nodes[index + 1]!.position.x, y: 0, z: -62.5 } }));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 320, z: 320 } }, center: { x: 110, z: 110 },
    polygon: [{ x: -100, z: -100 }, { x: 320, z: -100 }, { x: 320, z: 320 }, { x: -100, z: 320 }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

describe("a land use without land is held out and the next one is tried (nine idle cycles beside free land, live 2026-10-04)", () => {
  describe("chooseGrowthRole", () => {
    const base = { demand: { residential: 0, commercial: 0, industrial: 0 }, available: ["residential", "industrial", "commercial"], paused: [] as string[] };
    test("jobs wanted and industry has no land: commercial stands in", () => {
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS", blocked: ["industrial"] })).toBe("commercial");
    });
    test("control: nothing held out, jobs are industry's as before", () => {
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS" })).toBe("industrial");
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS", blocked: [] })).toBe("industrial");
    });
    // The live 2026-10-08 case: 26 of 83 cycles waited on `NO_USABLE_JOBS_SUPPLY` while industry was closed by the governor ("391 cells stand empty and
    // 0 filled in 6.3 game hours") and commercial was OPEN with demand 27–35 and shops growing. Industry held for any reason now lets shops stand in.
    test("industry held (no land, locked, or closed on its own empty stock) lets commercial stand in", () => {
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS", available: ["residential", "commercial"] })).toBe("commercial");
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS", paused: ["industrial"] })).toBe("commercial");
    });
    test("control: with no job-bearing use left open there is still nothing to build", () => {
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS", available: ["residential"] })).toBeNull();
      expect(chooseGrowthRole({ ...base, bottleneck: "JOBS", paused: ["industrial", "commercial"] })).toBeNull();
    });
    test("control: homes are never stood in for by another use", () => {
      expect(chooseGrowthRole({ ...base, bottleneck: "HOUSING", blocked: ["residential"] })).toBeNull();
    });
    test("with no bottleneck a held-out use drops out of the demand ranking", () => {
      const demand = { residential: 10, commercial: 20, industrial: 90 };
      expect(chooseGrowthRole({ ...base, demand, bottleneck: "NONE" })).toBe("industrial");
      expect(chooseGrowthRole({ ...base, demand, bottleneck: "NONE", blocked: ["industrial"] })).toBe("commercial");
    });
  });

  describe("the district builder", () => {
    const run = (options: { homes: boolean }) => {
      const state = { frame: 5_000_000 };
      const writes: string[] = [];
      const port: DistrictBuilderPort = {
        scanWorld: async () => smallTileWorld(),
        // The ground is read as in the game (a whole-ground terrain), so the search is a COMPLETE one: `coverage.complete` is only true then.
        readPlanningTerrain: async () => dry as never,
        // The home stands at the tile's far corner: industry must stay 400 m from it, so no industrial district fits anywhere on the tile.
        listBuildings: async () => options.homes ? [{ position: { x: 300, z: 300 }, prefab: "EU_ResidentialLow01" }] : [],
        siteDetail: async (center, radius) => ({ center, radius, terrain: undefined as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        buildRoad: async (course) => { writes.push(`road ${course.start.x},${course.start.z}`); return { ok: true, detail: "ok" }; },
        zone: async () => { writes.push("zone"); return { ok: true, detail: "ok" }; },
        readLabor: async () => ({ employed: 267, unemploymentRate: 0.35, jobsTotal: 267, jobsFree: 9 }),
        readGameFrame: async () => state.frame,
      };
      const builder = new DistrictBuilder(port);
      const cycle = () => builder.runCycle({ demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: () => "EU Zone", pipelined: true });
      return { builder, state, writes, cycle };
    };

    test("industry finds no land: it is held out, and the next cycle lays a commercial district", async () => {
      const { writes, cycle, state } = run({ homes: true });
      const first = await cycle();
      expect(first.status).toBe("NO_SITE");
      expect(first.notes.join(" | ")).toMatch(/policy chose industrial for JOBS/);
      expect(first.notes.join(" | ")).toMatch(/role industrial has no site; held out for 3 game hours/);
      expect(writes).toHaveLength(0);

      state.frame += HOUR / 10;
      const second = await cycle();
      expect(second.notes.join(" | ")).toMatch(/policy chose commercial for JOBS/);
      expect(second.notes.join(" | ")).toMatch(/commercial fallback: shop inventory not read/);
      expect(writes.some((write) => write.startsWith("road"))).toBe(true);
    });

    test("control: with no homes to keep away from, industry has land and is built first, with nothing held out", async () => {
      const { writes, cycle } = run({ homes: false });
      const first = await cycle();
      expect(first.notes.join(" | ")).toMatch(/policy chose industrial for JOBS/);
      expect(first.notes.join(" | ")).not.toMatch(/held out/);
      // The test world does not change when a street is written, so the district reads as "not built"; what matters here is that it WAS written.
      expect(writes.some((write) => write.startsWith("road"))).toBe(true);
    });

    test("the hold is game time: 3 game hours later industry is tried again", async () => {
      const { cycle, state } = run({ homes: true });
      await cycle();
      state.frame += HOUR / 10;
      expect((await cycle()).notes.join(" | ")).toMatch(/policy chose commercial/);
      state.frame += 3 * HOUR + 1;
      expect((await cycle()).notes.join(" | ")).toMatch(/policy chose industrial for JOBS/);
    });
  });
});
