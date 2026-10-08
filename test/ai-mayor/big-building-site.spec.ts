import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { BIG_BUILDING_MARGIN_METERS, BIG_BUILDING_PREFLIGHTS_PER_CALL, fitSites, footprintOf, placeBigBuilding, type BigBuildingPort } from "../../src/main/services/ai-mayor/v2/big-building-site";

/** Live 2026-10-05: a rail yard was hunted with 320 blind preflights (each a ghost building shown in the game) and none was legal. */
const rect = (minX: number, minZ: number, widthMeters: number, heightMeters: number) => ({ minX, minZ, widthMeters, heightMeters });
const yard = { widthMeters: 120, depthMeters: 200 };
const target = { x: 1000, z: 0 };

describe("the footprint of a prefab before anything is placed", () => {
  test("the lot in grid cells of 8 m when the game gives one, else the bounding size, else unknown (never guessed)", () => {
    expect(footprintOf({ lotSize: { x: 15, z: 25 } })).toEqual({ widthMeters: 120, depthMeters: 200 });
    expect(footprintOf({ lotSize: null, size: { x: 90, y: 20, z: 140 } })).toEqual({ widthMeters: 90, depthMeters: 140 });
    expect(footprintOf({})).toBeNull();
    expect(footprintOf(null)).toBeNull();
  });
});

describe("fitSites: free rectangles that really hold the building, nearest the target first", () => {
  test("only a rectangle that holds the footprint plus its margin is a site (a quarter turn may swap the sides); the nearest to the target comes first", () => {
    const sites = fitSites([rect(0, 0, 100, 100), rect(200, -100, 300, 300), rect(900, -50, 160, 260), rect(600, 0, 160, 140), rect(1300, -50, 150, 260)], yard, target, []);
    expect(sites.map((site) => site.rectangle.minX)).toEqual([900, 200]);
    // The 160 x 140 rectangle holds neither 120+32 x 200+32 nor the swapped 200+32 x 120+32; the 150 wide one is 2 m short of the margin.
    for (const site of sites) {
      const swapped = site.rotation % 180 !== 0;
      const width = (swapped ? yard.depthMeters : yard.widthMeters) + 2 * BIG_BUILDING_MARGIN_METERS;
      const depth = (swapped ? yard.widthMeters : yard.depthMeters) + 2 * BIG_BUILDING_MARGIN_METERS;
      expect(site.center.x - width / 2).toBeGreaterThanOrEqual(site.rectangle.minX - 1e-6);
      expect(site.center.x + width / 2).toBeLessThanOrEqual(site.rectangle.minX + site.rectangle.widthMeters + 1e-6);
      expect(site.center.z - depth / 2).toBeGreaterThanOrEqual(site.rectangle.minZ - 1e-6);
      expect(site.center.z + depth / 2).toBeLessThanOrEqual(site.rectangle.minZ + site.rectangle.heightMeters + 1e-6);
    }
  });

  test("a site near one the game refused is not offered again", () => {
    const first = fitSites([rect(900, -50, 160, 260), rect(200, -100, 300, 300)], yard, target, []);
    const again = fitSites([rect(900, -50, 160, 260), rect(200, -100, 300, 300)], yard, target, [first[0]!.center]);
    expect(again).toHaveLength(1);
    expect(again[0]!.rectangle.minX).toBe(200);
  });
});

describe("placeBigBuilding: fit, ask the game a bounded number of times, never the same site twice, buy land when nothing fits", () => {
  function port(options: { footprint?: typeof yard | null; rectangles?: ReturnType<typeof rect>[] | null; legal?: (x: number) => boolean; buy?: boolean } = {}) {
    const asked: Array<{ x: number; z: number }> = []; const placed: Array<{ x: number; z: number }> = []; const bought: Array<{ x: number; z: number }> = [];
    const value: BigBuildingPort = {
      footprint: async () => (options.footprint === undefined ? yard : options.footprint), freeRectangles: async () => (options.rectangles === undefined ? [rect(900, -50, 160, 260), rect(200, -100, 300, 300)] : options.rectangles),
      preflight: async (_prefab, point) => { asked.push(point); return (options.legal ?? (() => false))(point.x); },
      place: async (_prefab, point) => { placed.push(point); return { ok: true, detail: "placed" }; },
      acquireToward: async (point) => { bought.push(point); return options.buy ?? true; },
    };
    return { value, asked, placed, bought };
  }

  test("the first fitted site the game accepts is placed, with one preflight when it is legal at once", async () => {
    const { value, asked, placed } = port({ legal: () => true });
    const notes: string[] = [];
    expect((await placeBigBuilding(value, { prefab: "RailYard01", target, refusedSites: [] }, notes)).status).toBe("PLACED");
    expect(asked).toHaveLength(1);
    expect(placed).toHaveLength(1);
    expect(notes.join(" ")).toMatch(/RailYard01 placed at .* on a free 160 x 260 m rectangle/);
  });

  test("every site refused: at most three asked per call, each remembered, and the next call asks only the sites NOT yet refused — never the same one twice", async () => {
    const refusedSites: Array<{ x: number; z: number }> = [];
    const rectangles = [rect(900, -50, 160, 260), rect(200, -100, 300, 300), rect(-600, -100, 300, 300), rect(-1500, -100, 300, 300), rect(-2500, -100, 300, 300)];
    const first = port({ rectangles, legal: () => false });
    expect((await placeBigBuilding(first.value, { prefab: "RailYard01", target, refusedSites }, [])).status).toBe("REFUSED");
    expect(first.asked.length).toBeLessThanOrEqual(BIG_BUILDING_PREFLIGHTS_PER_CALL);
    expect(refusedSites).toHaveLength(first.asked.length);
    const second = port({ rectangles, legal: () => false });
    await placeBigBuilding(second.value, { prefab: "RailYard01", target, refusedSites }, []);
    for (const site of second.asked) expect(first.asked.some((earlier) => Math.hypot(earlier.x - site.x, earlier.z - site.z) < 40)).toBe(false);
  });

  test("control: no free rectangle holds it: no preflight at all, land is bought toward the target; unknown size or unreadable ground is not tried blind", async () => {
    const small = port({ rectangles: [rect(0, 0, 100, 100)] });
    const notes: string[] = [];
    expect((await placeBigBuilding(small.value, { prefab: "RailYard01", target, refusedSites: [] }, notes)).status).toBe("NO_ROOM_BOUGHT_LAND");
    expect(small.asked).toHaveLength(0);
    expect(small.bought).toEqual([target]);
    expect(notes.join(" ")).toMatch(/no free land holds RailYard01 \(120 x 200 m with 16 m round it\); a tile was bought/);
    expect((await placeBigBuilding(port({ buy: false, rectangles: [] }).value, { prefab: "RailYard01", target, refusedSites: [] }, [])).status).toBe("NO_ROOM");
    const unknown = port({ footprint: null });
    expect((await placeBigBuilding(unknown.value, { prefab: "RailYard01", target, refusedSites: [] }, [])).status).toBe("NO_FOOTPRINT");
    expect(unknown.asked).toHaveLength(0);
    expect((await placeBigBuilding(port({ rectangles: null }).value, { prefab: "RailYard01", target, refusedSites: [] }, [])).status).toBe("GROUND_UNREAD");
  });
});

describe("through the district builder: the rail yard the railway asks for is fitted to free owned land and placed once, never swept for", () => {
  const dry = (() => {
    const resolution = 100;
    return { resolution, bounds: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 }, cellSize: { x: 20, z: 20 }, heights: new Array<number>(resolution * resolution).fill(450),
      waterDepths: new Array<number>(resolution * resolution).fill(0), groundWater: [], groundWaterPollution: [], windSpeed: [] };
  })();
  const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
  const nodes = Array.from({ length: 6 }, (_, i) => node(-300 + i * 40, 0, 100 + i));
  const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
    start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -900, z: -900 }, max: { x: 900, z: 900 } }, center: { x: 0, z: 0 },
    polygon: [{ x: -900, z: -900 }, { x: 900, z: -900 }, { x: 900, z: 900 }, { x: -900, z: 900 }] };
  const world = { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;

  function run(legal: boolean) {
    const preflights: Array<{ prefab: string; x: number; z: number }> = []; const placed: string[] = [];
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [], buildRoad: async () => ({ ok: true, detail: "ok" }), zone: async () => ({ ok: true, detail: "ok" }),
      siteDetail: async (center, radius) => ({ center, radius, terrain: dry as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      readPlanningTerrain: async () => dry as never,
      findPrefabs: async (query) => (query === "RailYard" ? [{ name: "RailYard01", locked: false }] : []),
      trainLink: { railEdges: async () => [{ start: { x: 600, z: -300 }, end: { x: 600, z: 300 }, native: true }], stationPrefabs: async () => [], trackPrefab: async () => null, listStations: async () => [],
        preflight: async (prefab, point) => { preflights.push({ prefab, x: point.x, z: point.z }); return legal; }, place: async (prefab) => { placed.push(prefab); return { ok: true, detail: "" }; },
        ownedTracks: async () => null, frontage: async () => null, lay: async () => ({ ok: false, detail: "" }), remove: async () => true },
      techTree: { read: async () => ({ points: 30, nodes: [] }), prefabLocks: async (prefabs) => prefabs.map((entry) => ({ prefab: entry.prefab, locked: entry.prefab !== "RailYard01", lotSize: { x: 15, z: 25 }, requirements: [] })),
        purchase: async () => ({ ok: true, detail: "" }) },
    };
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    const cycle = () => builder.runCycle({ demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null, pipelined: true, mayPurchaseLand: false, population: 16_000,
      finance: { treasury: 900_000, monthlyBalance: 500_000 } } as never);
    return { cycle, preflights, placed };
  }

  test("the footprint is read, a free rectangle that holds it is found, ONE preflight is asked and the yard is placed", async () => {
    const { cycle, preflights, placed } = run(true);
    const result = await cycle();
    expect(preflights).toHaveLength(1);
    expect(placed).toEqual(["RailYard01"]);
    expect(result.notes.join(" | ")).toMatch(/big building: RailYard01 placed at/);
  });

  test("the game refuses the fitted sites: at most three are asked in a cycle, and a later cycle never asks the same ground again", async () => {
    const { cycle, preflights, placed } = run(false);
    await cycle();
    const first = preflights.length;
    expect(first).toBeLessThanOrEqual(BIG_BUILDING_PREFLIGHTS_PER_CALL);
    expect(placed).toHaveLength(0);
    for (let round = 0; round < 6; round += 1) await cycle();
    // Every later ask is a NEW site: no two preflights within the refused radius of each other.
    for (let i = 0; i < preflights.length; i += 1) for (let j = i + 1; j < preflights.length; j += 1) expect(Math.hypot(preflights[i]!.x - preflights[j]!.x, preflights[i]!.z - preflights[j]!.z)).toBeGreaterThanOrEqual(40);
  });
});