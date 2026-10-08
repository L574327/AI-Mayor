import { classifyBottleneck, LABOR_SAMPLE_MINIMUM } from "../../src/main/services/ai-mayor/v2/growth-bottleneck";
import { compileDistrict, DistrictBuilder, MAXIMUM_DISTRICT_SIDE_METERS, surveyDistrictSites, UNZONED_SCAN_WINDOW_METERS, ZONING_WRITE_RUN, type DistrictBuilderPort, type DistrictSite } from "../../src/main/services/ai-mayor/v2/district-builder";
import { absorbableCells, batchConstraint, chooseResidentialDensity, MINIMUM_POPULATION_FOR_RATES, SEED_BATCH_SQUARE_METERS } from "../../src/main/services/ai-mayor/v2/growth-policy";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });

const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };

/** A served street and one very large owned, empty ground (a brand-new game). */
function emptyMapWorld() {
  const nodes = Array.from({ length: 7 }, (_, index) => node(2.5 + index * 40, -62.5));
  const edges = Array.from({ length: 6 }, (_, index) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
    startNode: nodes[index]!.entity, endNode: nodes[index + 1]!.entity,
    start: { x: nodes[index]!.position.x, y: 0, z: -62.5 }, end: { x: nodes[index + 1]!.position.x, y: 0, z: -62.5 } }));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 2100, z: 2300 } }, center: { x: 1000, z: 1100 }, polygon: [] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

describe("V2 S0 (the policy document: a small, complete first loop; no steady-state estimate without a sample)", () => {
  test("P2: with no immigration sample the batch is the seed, not the cash cap", () => {
    const rich = batchConstraint({ capitalArea: 2_266_667, absorptionCells: null, seed: true });
    expect(rich.limit).toBe(SEED_BATCH_SQUARE_METERS);
    expect(rich.binding).toBe("seed");
    // A poor treasury still binds first.
    const poor = batchConstraint({ capitalArea: 40_000, absorptionCells: null, seed: true });
    expect(poor.limit).toBe(40_000);
    expect(poor.binding).toBe("capital");
    // With a sample the absorption cap rules, and the seed is not used.
    const sampled = batchConstraint({ capitalArea: 2_266_667, absorptionCells: 900, seed: true });
    expect(sampled.binding).toBe("absorption");
    expect(sampled.limit).toBeLessThan(SEED_BATCH_SQUARE_METERS * 4);
    // Without the seed flag (a player's named request) the cash alone sizes it, as before.
    expect(batchConstraint({ capitalArea: 2_266_667, absorptionCells: null }).limit).toBe(2_266_667);
  });

  test("a handful of residents is not a rate: below the minimum population absorption is unreadable (so the seed stands)", () => {
    const tiny = absorbableCells({ growthPerDay: 5, population: MINIMUM_POPULATION_FOR_RATES - 1, builtResidentialCells: 20, emptyCellsOfDensity: 0, zonedCellsOfDensity: 20, demand: 50 });
    expect(tiny.cells).toBeNull();
    expect(tiny.detail).toMatch(/too few/);
    const real = absorbableCells({ growthPerDay: 500, population: 5_000, builtResidentialCells: 1_000, emptyCellsOfDensity: 0, zonedCellsOfDensity: 1_000, demand: 50 });
    expect(real.cells).not.toBeNull();
  });

  test("the first district of a clean start is the seed's size, whatever the cash", async () => {
    const world = emptyMapWorld();
    const sites: Array<{ w: number; h: number }> = [];
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      siteDetail: async (center, radius) => ({ center, radius, terrain: undefined, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async (course) => { sites.push({ w: Math.abs(course.end.x - course.start.x), h: Math.abs(course.end.z - course.start.z) }); return { ok: false, detail: "dry" }; },
      zone: async () => ({ ok: false, detail: "dry" }),
    };
    const result = await new DistrictBuilder(port, { maximumSitesPerCycle: 1 }).runCycle({ demand: { residential: 0, commercial: 100, industrial: 84 }, zoneFor: () => "EU Commercial Low",
      pipelined: true, population: 14, targetPopulation: 100_000, mayPurchaseLand: true, finance: { treasury: 1_000_000, monthlyBalance: 0 } });
    expect(result.notes.join(" | ")).toMatch(/seed batch 115200 m2/);
    // Whatever was attempted fits the seed: no street of a 1.2 km district.
    for (const street of sites) expect(Math.max(street.w, street.h)).toBeLessThanOrEqual(Math.sqrt(SEED_BATCH_SQUARE_METERS) + 80);
  });
});

describe("the opening stage, as the policy document defines it (second live run, 2026-10-04)", () => {
  test("S0: the seed is the ceiling even when an immigration rate is readable (a young city's burst is not a steady state)", () => {
    const burst = batchConstraint({ capitalArea: 2_081_686, absorptionCells: 24_370, seedAlways: true });
    expect(burst.limit).toBe(SEED_BATCH_SQUARE_METERS);
    expect(burst.binding).toBe("seed");
    // A smaller absorption still binds below the seed.
    const small = batchConstraint({ capitalArea: 2_081_686, absorptionCells: 100, seedAlways: true });
    expect(small.binding).toBe("absorption");
    expect(small.limit).toBeLessThan(SEED_BATCH_SQUARE_METERS);
    // Beyond S0 the same reading is a real absorption cap.
    expect(batchConstraint({ capitalArea: 2_081_686, absorptionCells: 24_370 }).limit).toBeGreaterThan(SEED_BATCH_SQUARE_METERS);
  });

  test("S0 builds low density even when medium density is unlocked; from S1 the densest density is the default", () => {
    const densities = { low: { unlocked: true, vacancyShare: 0.1, demand: 60 }, medium: { unlocked: true, vacancyShare: 0.05, demand: 70 }, high: { unlocked: false, vacancyShare: null, demand: null } };
    expect(chooseResidentialDensity({ stage: "S0", densities, lowDensityShareSoFar: null }).density).toBe("low");
    expect(chooseResidentialDensity({ stage: "S1", densities, lowDensityShareSoFar: null }).density).toBe("medium");
    // Low density that is not open (no demand) does not hold the opening back from the default.
    expect(chooseResidentialDensity({ stage: "S0", densities: { ...densities, low: { unlocked: true, vacancyShare: 0.1, demand: 0 } }, lowDensityShareSoFar: null }).density).toBe("medium");
  });

  test("a district smaller than its rectangle stands in the corner beside the served street, not always in the lower-left", () => {
    // The street runs along z = -62.5 from x = 2.5 to 242.5; the free rectangle lies above it and extends 1360 m to the WEST of the street's end.
    const world = emptyMapWorld();
    const rectangle = { minX: -1117.5, minZ: 17.5, widthMeters: 1360, heightMeters: 800 };
    const sites = surveyDistrictSites({ world, buildings: [], rectangles: [rectangle], maximumAreaSquareMeters: SEED_BATCH_SQUARE_METERS });
    expect(sites.length).toBeGreaterThan(0);
    // The lower-left corner (x = -1117.5) is far beyond the gateway reach; the offered site is the one by the street.
    expect(sites[0]!.anchor.x).toBeGreaterThan(-600);
    expect(sites[0]!.widthMeters * sites[0]!.heightMeters).toBeLessThanOrEqual(SEED_BATCH_SQUARE_METERS);
  });
});

describe("zoning brushes written in runs: a house that grows during the write is not painted over", () => {
  test("the ground is read again before each run of brushes (the single read before a whole district was a minute stale)", async () => {
    const polygon = [{ x: 0, z: 0 }, { x: 6000, z: 0 }, { x: 6000, z: 300 }, { x: 0, z: 300 }];
    const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: 0, z: 0 }, max: { x: 6000, z: 300 } }, center: { x: 3000, z: 150 }, polygon };
    const start = node(0, 150);
    const end = node(4000, 150);
    const world = { roadGraph: { nodes: [start, end], edges: [{ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
      startNode: start.entity, endNode: end.entity, start: start.position, end: end.position }] }, ownedTiles: [tile] } as never;
    // 100 unzoned roadside cells in a row, 40 m apart; the sweep sees them all empty.
    const cells = Array.from({ length: 100 }, (_, index) => ({ block: { index: 5, version: 1 }, index, position: { x: 20 + 40 * index, y: 0, z: 150 }, visible: true,
      roadside: true, occupied: false, blocked: false, overridden: false, zoneType: 0, zoneCategory: "none" }));
    let writes = 0;
    const written: Array<{ x: number; z: number }> = [];
    const grownAt = { x: 20 + 40 * 80 + 8, z: 150 };
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      siteDetail: async (center, radius) => {
        const sweep = radius === UNZONED_SCAN_WINDOW_METERS;
        // After the first run has been written, a house stands next to cell 80.
        const grown = writes >= 10;
        return { center, radius, terrain: dry, roadGraph: { nodes: [], edges: [] },
          buildings: !sweep && grown ? [{ entity: { index: 9, version: 1 }, prefab: "EU_ResidentialLow03", native: false, position: { x: grownAt.x, y: 0, z: grownAt.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null }] : [],
          zoningCells: sweep ? cells : [] } as never;
      },
      buildRoad: async () => ({ ok: true, detail: "ok" }),
      zone: async (_zone, center) => { writes += 1; written.push({ x: center.x, z: center.z }); return { ok: true, detail: "ok" }; },
    };
    const builder = new DistrictBuilder(port);
    await builder.runCycle({ demand: { residential: 80, commercial: 10, industrial: 0 }, zoneFor: () => "R" });
    expect(writes).toBeGreaterThan(ZONING_WRITE_RUN);
    // No brush written after the house appeared reaches it.
    for (const brush of written) if (brush.x > 20 + 40 * 70) expect(Math.hypot(brush.x - grownAt.x, brush.z - grownAt.z)).toBeGreaterThanOrEqual(9);
    expect(written.some((brush) => Math.abs(brush.x - (20 + 40 * 80)) < 1)).toBe(false);
  });
});

describe("a brand-new city (clean start, measured live 2026-10-04)", () => {
  test("three people out of work beside seventeen open jobs is not a labour bottleneck", () => {
    const young = classifyBottleneck({ employed: 3, unemploymentRate: 0.5, jobsTotal: 17, jobsFree: 14 }, 100);
    expect(young.bottleneck).toBe("NONE");
    expect(young.reason).toMatch(/too few for a labour reading/);
  });

  test("with a real workforce the same shares still decide (a mismatch, jobs short, homes short)", () => {
    expect(LABOR_SAMPLE_MINIMUM).toBeGreaterThan(10);
    expect(classifyBottleneck({ employed: 500, unemploymentRate: 0.5, jobsTotal: 1500, jobsFree: 1400 }).bottleneck).toBe("MATCH");
    expect(classifyBottleneck({ employed: 500, unemploymentRate: 0.01, jobsTotal: 600, jobsFree: 100 }).bottleneck).toBe("HOUSING");
  });

  test("a huge empty rectangle is offered as a district no longer than the game can lay as one street", () => {
    const sites = surveyDistrictSites({ world: emptyMapWorld(), buildings: [], rectangles: [{ minX: 2.5, minZ: 17.5, widthMeters: 2000, heightMeters: 1840 }] });
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.widthMeters).toBeLessThanOrEqual(MAXIMUM_DISTRICT_SIDE_METERS);
      expect(site.heightMeters).toBeLessThanOrEqual(MAXIMUM_DISTRICT_SIDE_METERS);
      expect(() => compileDistrict(site)).not.toThrow();
      expect(compileDistrict(site)).not.toBeNull();
    }
  });

  test("a grid the game cannot lay is a refused district (null), not an exception that ends the cycle", () => {
    const tooTall: DistrictSite = { anchor: { x: 2.5, z: 17.5 }, columnWidths: [200, 200], rowHeights: Array.from({ length: 46 }, () => 40),
      widthMeters: 400, heightMeters: 1840, gateway: { from: { x: 2.5, z: -62.5 }, to: { x: 2.5, z: 17.5 }, lengthMeters: 80 }, score: 0, alternativeGateways: [] };
    expect(() => compileDistrict(tooTall)).not.toThrow();
    expect(compileDistrict(tooTall)).toBeNull();
  });
});
