/**
 * The 2026-10-08 rework (live session: ten 1,200 m districts in ten minutes, the treasury at the spending fuse's floor for half an hour, a blue street preview
 * flashing every cycle, 9,839 of 10,289 office cells empty while housing was the bottleneck, a cemetery placed with no money left for its road):
 * districts are template-sized and paced, sized under the fuse, and nothing that costs money is previewed once the fuse has said no.
 */
import { capitalAreaCap, capitalReserve, DEVIATION_RESERVE, operatingReserve, OPERATING_RESERVE_MINIMUM, SNOWBALL_PIPELINE_CELLS, snowballPipelineCells } from "../../src/main/services/ai-mayor/v2/growth-policy";
import { plannerSpendFloor, SPEND_FLOOR_ENV } from "../../src/main/services/ai-mayor/v2/spend-guard";
import { emptyMix, targetShares, type ZoningMixSignals } from "../../src/main/services/ai-mayor/v2/zoning-mix";
import { DISTRICT_LOCAL_ROAD_PREFAB, DISTRICT_ROAD_PREFAB, DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { FRAMES_PER_GAME_DAY } from "../../src/main/services/ai-mayor/v2/growth-policy";

describe("the batch is sized under the spending fuse", () => {
  test("the reserve is the fuse's floor plus the operating band, never less than the old reserve", () => {
    expect(capitalReserve(null, null)).toBe(DEVIATION_RESERVE);
    expect(capitalReserve(null, 330_000)).toBe(330_000 + operatingReserve(330_000));
    expect(operatingReserve(330_000)).toBe(66_000);
    expect(operatingReserve(10_000)).toBe(OPERATING_RESERVE_MINIMUM);
  });
  test("live 2026-10-08: 1,000,000 taken over, floor 330,000 — the cash above the floor and its band pays the batch, not the whole treasury", () => {
    const open = capitalAreaCap({ treasury: 1_000_000, monthlyBalance: 0, monthlyMaintenance: null });
    const fused = capitalAreaCap({ treasury: 1_000_000, monthlyBalance: 0, monthlyMaintenance: null, spendFloor: 330_000 });
    expect(fused).toBeLessThan(open);
    expect(fused).toBeCloseTo((1_000_000 - 396_000) * 0.8 / 0.3, 0);
    // At 380,000 the treasury is inside the band: no district.
    expect(capitalAreaCap({ treasury: 380_000, monthlyBalance: 0, monthlyMaintenance: null, spendFloor: 330_000 })).toBe(0);
  });
  test("the fuse's hourly cap caps the batch too", () => {
    expect(capitalAreaCap({ treasury: 3_000_000, monthlyBalance: 0, monthlyMaintenance: null, spendFloor: 330_000, hourlyCap: 150_000 })).toBeCloseTo(150_000 * 0.8 / 0.3, 0);
  });
  test("the planner's floor is the fuse's: none without a fuse, none while the city bleeds under it (the fuse stands down then)", () => {
    expect(plannerSpendFloor({ treasury: 500_000, monthlyBalance: 10 }, {})).toBeNull();
    expect(plannerSpendFloor({ treasury: 500_000, monthlyBalance: 10 }, { [SPEND_FLOOR_ENV]: "330000" })).toBe(330_000);
    expect(plannerSpendFloor({ treasury: 200_000, monthlyBalance: -5_000 }, { [SPEND_FLOOR_ENV]: "330000" })).toBeNull();
    expect(plannerSpendFloor({ treasury: 200_000, monthlyBalance: 5_000 }, { [SPEND_FLOOR_ENV]: "330000" })).toBe(330_000);
  });
  test("snowball holds about two template districts of empty homes ahead of its people", () => {
    expect(snowballPipelineCells(0).cells).toBe(SNOWBALL_PIPELINE_CELLS);
    expect(snowballPipelineCells(SNOWBALL_PIPELINE_CELLS + 10).cells).toBe(0);
  });
});

describe("the mix: shops and offices are not laid on their own empty stock", () => {
  const mix = (office: [number, number], commercial: [number, number], officeDemand = 100): ZoningMixSignals => {
    const signals = emptyMix();
    signals.cells.residential = { zoned: 25_000, empty: 700 };
    signals.cells.office = { zoned: office[0], empty: office[1] };
    signals.cells.commercial = { zoned: commercial[0], empty: commercial[1] };
    signals.demand = { residential: 100, commercial: 60, office: officeDemand, industrial: 20 };
    return signals;
  };
  test("live 2026-10-08: 96% empty offices and 61% empty shops get no share, whatever their demand bars say", () => {
    const shares = targetShares(mix([10_289, 9_839], [11_318, 6_902]));
    expect(shares.office).toBe(0);
    expect(shares.commercial).toBe(0);
    expect(shares.residential).toBeGreaterThan(0.5);
  });
  test("an office with no demand gets no floor share; shops keep theirs while they fill", () => {
    const shares = targetShares(mix([1_000, 100], [1_000, 100], 0));
    expect(shares.office).toBe(0);
    expect(shares.commercial).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The builder on a fake world.

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
type TestNode = ReturnType<typeof node>;
const edge = (a: TestNode, b: TestNode) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
  startNode: a.entity, endNode: b.entity, start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });
function servedWorld() {
  const nodes: TestNode[] = []; const edges: ReturnType<typeof edge>[] = [];
  for (let index = 0; index <= 22; index += 1) nodes.push(node(2.5 + index * 40, -62.5));
  for (let index = 0; index < 22; index += 1) edges.push(edge(nodes[index]!, nodes[index + 1]!));
  const bounds = { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } };
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds, center: { x: 500, z: 400 },
    polygon: [bounds.min, { x: bounds.max.x, z: bounds.min.z }, bounds.max, { x: bounds.min.x, z: bounds.max.z }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}
const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };
const series = () => {
  const frames: number[] = []; const values: number[] = [];
  for (let index = 0; index <= 32; index += 1) { frames.push(index * (FRAMES_PER_GAME_DAY / 8)); values.push(10_000 + (200 * index) / 8); }
  return { frames, values };
};
function homesMix(staleOffices = false): ZoningMixSignals {
  const mix = emptyMix();
  mix.residentialByDensity = { low: { zoned: 40_000, empty: 100, demand: 30 }, medium: { zoned: 8_000, empty: 100, demand: 80 }, high: { zoned: 0, empty: 0, demand: null } };
  mix.cells.residential = { zoned: 48_000, empty: 200 };
  if (staleOffices) mix.cells.office = { zoned: 10_289, empty: 9_839 };
  mix.demand = { residential: 100, commercial: 0, office: 0, industrial: 0 };
  return mix;
}
function harness(options: { refuseForMoney?: (course: { start: { x: number; z: number } }) => boolean; staleOffices?: boolean; zones?: string[]; gameRefusesAll?: boolean } = {}) {
  const log = { built: [] as Array<{ prefab: string; at: string }>, preflights: 0, refused: 0, asked: new Map<string, number>() };
  const standing: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
  const port: DistrictBuilderPort = {
    scanWorld: async () => servedWorld(),
    listBuildings: async () => [],
    siteDetail: async (center) => ({ center, radius: 1, terrain: dry, zoningCells: [], buildings: [],
      roadGraph: { nodes: [], edges: standing.map((course) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
        startNode: { index: nextId++, version: 1 }, endNode: { index: nextId++, version: 1 },
        start: { x: course.start.x, y: 0, z: course.start.z }, end: { x: course.end.x, y: 0, z: course.end.z } })) } }) as never,
    preflightRoad: async (course) => {
      log.preflights += 1;
      const key = `${Math.round(course.start.x)},${Math.round(course.start.z)}>${Math.round(course.end.x)},${Math.round(course.end.z)}`;
      log.asked.set(key, (log.asked.get(key) ?? 0) + 1);
      return options.gameRefusesAll ? "REJECT:operation blocked by game validation (overlap)" : "OK";
    },
    buildRoad: async (course, prefab) => {
      if (options.refuseForMoney?.(course)) { log.refused += 1; return { ok: false, detail: "SPEND_GUARD_REFUSED:cs2_build_road: treasury 300000 is within the margin of the floor 300000" }; }
      log.built.push({ prefab, at: `${course.start.x},${course.start.z}` });
      standing.push({ start: course.start, end: course.end });
      return { ok: true, detail: "ok" };
    },
    zone: async (zone) => { options.zones?.push(zone); return { ok: true, detail: "ok" }; },
    readZoningMix: async () => homesMix(options.staleOffices === true),
    // Every disk along the streets holds only empty office zoning.
    readZoningAround: async () => [{ zone: "Office Low", cells: 30, occupied: 0, empty: 30 }],
    readProgress: async () => ({ milestone: 4, xp: 100, nextMilestoneXp: 500, gameDateTime: "2027-01-02 12:30" }),
    readPopulationSeries: async () => series(),
    readLandCosts: async () => ({ tileUpkeep: 0, monthlyExpenses: 500_000 }),
  };
  return { port, log };
}
const cycleInput = (overrides: Record<string, unknown> = {}) => ({
  demand: { residential: 80, commercial: 0, industrial: 0 },
  zoneFor: (category: string, density?: string) => `${category}:${density ?? "default"}`,
  pipelined: true, population: 10_000, mayPurchaseLand: true,
  finance: { treasury: 400_000, monthlyBalance: 100_000 },
  unlocked: { densities: { low: true, medium: true, high: false }, office: true },
  ...overrides,
});

describe("the builder under the spending fuse", () => {
  const before = process.env[SPEND_FLOOR_ENV];
  afterEach(() => { if (before === undefined) delete process.env[SPEND_FLOOR_ENV]; else process.env[SPEND_FLOOR_ENV] = before; });

  test("under the fuse's floor nothing that costs money is tried — no street is even dry-run (its preview would show for nothing)", async () => {
    process.env[SPEND_FLOOR_ENV] = "330000";
    const { port, log } = harness();
    const result = await new DistrictBuilder(port, { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ finance: { treasury: 300_000, monthlyBalance: 20_000 } }));
    expect(log.preflights).toBe(0);
    expect(log.built).toHaveLength(0);
    expect(result.outcome).toBe("WAIT");
  });

  test("inside the operating band the next district waits for the cash, and says so", async () => {
    process.env[SPEND_FLOOR_ENV] = "330000";
    const { port, log } = harness();
    const result = await new DistrictBuilder(port, { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ finance: { treasury: 380_000, monthlyBalance: 20_000 } }));
    expect(log.built).toHaveLength(0);
    expect(result.notes.join(" | ")).toMatch(/funds: the next district waits for the cash/);
  });

  test("a street the fuse refuses ends the district's building for the cycle: no halves, no other way in, no second preview; the site is laid once the cash is back", async () => {
    let money = false;
    const { port, log } = harness({ refuseForMoney: () => !money });
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    const first = await builder.runCycle(cycleInput());
    expect(log.refused).toBe(1);
    expect(first.outcome).toBe("WAIT");
    const previewsAfterRefusal = log.preflights;
    money = true;
    const second = await builder.runCycle(cycleInput());
    expect(second.status).toBe("BUILT");
    expect(log.built.length).toBeGreaterThan(0);
    expect(log.preflights).toBeGreaterThan(previewsAfterRefusal);
  });

  test("live 2026-10-08: offices standing 96% empty while the city asks for homes are repainted as homes, many spots at a time", async () => {
    const zones: string[] = [];
    const { port } = harness({ staleOffices: true, zones });
    const result = await new DistrictBuilder(port, { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    expect(result.notes.join(" | ")).toMatch(/stale zoning: office stand mostly empty while homes are short — \d+ spot\(s\) repainted as homes/);
    expect(zones.filter((zone) => zone === "residential:MEDIUM").length).toBeGreaterThan(12);
    // Nothing of the stale offices is zoned as offices again.
    expect(zones.some((zone) => zone.startsWith("office"))).toBe(false);
  });

  test("the repeat guard: a street the game refused twice is not put to it again — not even as a dry run (its preview) — however many cycles ask", async () => {
    const { port, log } = harness({ gameRefusesAll: true });
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    for (let cycle = 0; cycle < 6; cycle += 1) await builder.runCycle(cycleInput());
    expect(log.asked.size).toBeGreaterThan(0);
    for (const count of log.asked.values()) expect(count).toBeLessThanOrEqual(2);
  });

  test("the ring and the way in are the collector road; the streets inside are the two-lane local street", async () => {
    const { port, log } = harness();
    await new DistrictBuilder(port, { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    const prefabs = new Set(log.built.map((entry) => entry.prefab));
    expect(prefabs.has(DISTRICT_ROAD_PREFAB)).toBe(true);
    expect(prefabs.has(DISTRICT_LOCAL_ROAD_PREFAB)).toBe(true);
  });
});
