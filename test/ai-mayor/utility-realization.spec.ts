import {
  realizeUtilityShortfall,
  type DistrictUtilitiesPort,
} from "../../src/main/services/ai-mayor/v2/district-utilities";
import { powerAssetsOfScan } from "../../src/main/services/ai-mayor/main-adapters";
import { RefusedPlacements } from "../../src/main/services/ai-mayor/v2/district-services";

const edge = (x1: number, z1: number, x2: number, z2: number) => ({
  entity: { index: 1, version: 1 }, prefab: "Medium Road", native: false, startNode: { index: 1, version: 1 },
  endNode: { index: 2, version: 1 }, start: { x: x1, y: 0, z: z1 }, end: { x: x2, y: 0, z: z2 },
}) as never;
const street = [edge(0, 0, 800, 0)];

/** A world where only some prefabs have a legal site; every placed facility stands and reads back attached. */
function world(options: { legal: readonly string[]; ranking: readonly string[]; output?: Record<string, number> }) {
  const standing = new Map<string, Array<{ entity: { index: number; version: number }; position: { x: number; z: number } }>>();
  const preflights = new Map<string, number>();
  const placed: string[] = [];
  let next = 100;
  const port: DistrictUtilitiesPort = {
    rankPrefabs: async () => [...options.ranking],
    expectedOutput: (_kind, prefab) => options.output?.[prefab] ?? null,
    listFacilities: async (prefab) => standing.get(prefab) ?? [],
    preflight: async (prefab) => { preflights.set(prefab, (preflights.get(prefab) ?? 0) + 1); return options.legal.includes(prefab); },
    place: async (prefab, point) => {
      placed.push(prefab);
      standing.set(prefab, [...(standing.get(prefab) ?? []), { entity: { index: next++, version: 1 }, position: { x: point.x, z: point.z } }]);
      return { ok: true, detail: "" };
    },
    attached: async () => true,
  };
  return { port, placed, preflights };
}

const input = (shortfall: number) => ({ kind: "electricity" as const, shortfall, target: { x: 400, z: 0 }, edges: [street[0]!] });

describe("precise hands: the generator catalogue is read from the scan the Bridge really returns", () => {
  test("bootstrapAssets arrives as an array (the live shape): every generator is read, not none", () => {
    const scan = { bootstrapAssets: [
      { prefab: "SmallCoalPowerPlant01", locked: false, constructionCost: 100_000, capabilities: { electricityProduction: 200_000 } },
      { prefab: "WindTurbine01", locked: false, constructionCost: 25_000, capabilities: { electricityProduction: 0, windProduction: 60_000 } },
      { prefab: "NuclearPowerPlant01", locked: true, constructionCost: 5_000_000, capabilities: { electricityProduction: 7_500_000 } },
      { prefab: "ElementarySchool01", locked: false, constructionCost: 9_000, capabilities: {} },
    ] };
    const assets = powerAssetsOfScan(JSON.parse(JSON.stringify(scan)));
    expect(assets.map((asset) => [asset.prefab, asset.production, asset.locked])).toEqual([
      ["SmallCoalPowerPlant01", 200_000, false], ["WindTurbine01", 60_000, false], ["NuclearPowerPlant01", 7_500_000, true]]);
  });
});

describe("precise hands: a utility shortage is realized, not attempted once", () => {
  test("the top three candidates have no site; the fourth stands (the 2026-10-04 live failure)", async () => {
    const { port, placed } = world({ ranking: ["SmallCoalPowerPlant01", "WindTurbine01", "WindTurbine02", "WindTurbine03"], legal: ["WindTurbine03"],
      output: { WindTurbine03: 5_000 } });
    const notes: string[] = [];
    const result = await realizeUtilityShortfall(port, input(4_000), notes);
    expect(placed).toEqual(["WindTurbine03"]);
    expect(result.covered).toBe(5_000);
    expect(result.exhausted).toBe(false);
    expect(result.searched).toEqual(["SmallCoalPowerPlant01", "WindTurbine01", "WindTurbine02", "WindTurbine03"]);
  });

  test("one facility is not enough: the same prefab is placed again until the shortage is covered", async () => {
    const { port, placed } = world({ ranking: ["WindTurbine03"], legal: ["WindTurbine03"], output: { WindTurbine03: 1_000 } });
    const result = await realizeUtilityShortfall(port, input(2_500), []);
    expect(placed).toEqual(["WindTurbine03", "WindTurbine03", "WindTurbine03"]);
    expect(result.covered).toBe(3_000);
  });

  test("every candidate without a site: NO_FEASIBLE_REALIZATION, nothing placed", async () => {
    const { port, placed } = world({ ranking: ["SmallCoalPowerPlant01", "WindTurbine01"], legal: [] });
    const notes: string[] = [];
    const result = await realizeUtilityShortfall(port, input(1_000), notes);
    expect(placed).toEqual([]);
    expect(result.exhausted).toBe(true);
    expect(notes.join(" ")).toMatch(/NO_FEASIBLE_REALIZATION/);
  });

  test("a site the game refused is not offered to it again until the memory lapses (the product's own refused-placement memory)", async () => {
    const { port, preflights } = world({ ranking: ["SmallCoalPowerPlant01", "WindTurbine03"], legal: ["WindTurbine03"], output: { WindTurbine03: 10_000 } });
    const refused = new RefusedPlacements();
    await realizeUtilityShortfall(port, { ...input(1_000), placementMemory: { refused, cycle: 1 } }, []);
    const coalPreflights = preflights.get("SmallCoalPowerPlant01") ?? 0;
    expect(coalPreflights).toBeGreaterThan(0);
    expect(refused.size).toBeGreaterThan(0);
    // The next cycles go straight past the sites the game refused: no new preflight for them.
    await realizeUtilityShortfall(port, { ...input(1_000), placementMemory: { refused, cycle: 2 } }, []);
    expect(preflights.get("SmallCoalPowerPlant01") ?? 0).toBe(coalPreflights);
    // After the memory lapses (buildings spawn, lots change) the game is asked again.
    await realizeUtilityShortfall(port, { ...input(1_000), placementMemory: { refused, cycle: 100 } }, []);
    expect(preflights.get("SmallCoalPowerPlant01") ?? 0).toBeGreaterThan(coalPreflights);
  });
  test("an output the port cannot name: one placement is the whole answer (no blind repetition)", async () => {
    const { port, placed } = world({ ranking: ["WindTurbine03", "WindTurbine01"], legal: ["WindTurbine03", "WindTurbine01"] });
    const result = await realizeUtilityShortfall(port, input(50_000), []);
    expect(placed).toEqual(["WindTurbine03"]);
    expect(result.exhausted).toBe(false);
  });

  test("water: pumps find no groundwater or shore, a water tower needs none and is placed until the shortage is covered", async () => {
    const dry = { resolution: 2, bounds: { minX: 0, minZ: -400, maxX: 800, maxZ: 400 }, cellSize: { x: 400, z: 400 }, heights: [0, 0, 0, 0],
      waterDepths: [0, 0, 0, 0], groundWater: [0, 0, 0, 0], groundWaterPollution: [0, 0, 0, 0], windSpeed: [] };
    const { port, placed } = world({ ranking: ["GroundwaterPumpingStation01", "WaterPumpingStation01", "WaterTower03"],
      legal: ["GroundwaterPumpingStation01", "WaterPumpingStation01", "WaterTower03"], output: { WaterTower03: 10_000 } });
    const result = await realizeUtilityShortfall(port, { ...input(25_000), kind: "water", terrain: dry as never }, []);
    expect(placed).toEqual(["WaterTower03", "WaterTower03", "WaterTower03"]);
    expect(result.covered).toBe(30_000);
    expect(result.exhausted).toBe(false);
  });

  test("an attached sewage outlet already standing is not a siting failure", async () => {
    const { port, placed } = world({ ranking: ["Sewage Outlet 01"], legal: ["Sewage Outlet 01"] });
    await port.place("Sewage Outlet 01", { x: 100, z: 40 }, 0);
    placed.length = 0;
    const notes: string[] = [];
    const result = await realizeUtilityShortfall(port, { ...input(10), kind: "sewage" }, notes);
    expect(placed).toEqual([]);
    expect(result.exhausted).toBe(false);
    expect(notes.join(" ")).toMatch(/already exists/);
  });
});
