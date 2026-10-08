import {
  districtUtilityShortfall,
  districtUtilitySites,
  districtZonedCells,
  projectDistrictLoad,
  provisionDistrictUtility,
  terrainSampleAt,
  type DistrictUtilitiesPort,
} from "../../src/main/services/ai-mayor/v2/district-utilities";

const edge = (x1: number, z1: number, x2: number, z2: number) => ({
  entity: { index: 1, version: 1 }, prefab: "Medium Road", native: false, startNode: { index: 1, version: 1 },
  endNode: { index: 2, version: 1 }, start: { x: x1, y: 0, z: z1 }, end: { x: x2, y: 0, z: z2 },
}) as never;
const street = [edge(0, 0, 400, 0)];

describe("district utilities: load projection", () => {
  test("projects the load from the city's own consumption per building", () => {
    // 100 buildings consume 1000: a district with 1800 zoned cells holds 100 lots, so it adds about 1000.
    expect(projectDistrictLoad({ zonedCells: 1800, buildingCount: 100, consumption: 1000 })).toBeCloseTo(1000, 5);
    expect(projectDistrictLoad({ zonedCells: 1800, buildingCount: 0, consumption: 1000 })).toBe(0);
    expect(projectDistrictLoad({ zonedCells: 1800, buildingCount: 100, consumption: null })).toBe(0);
  });

  test("a 560 x 400 district holds about two thousand zoned cells", () => {
    expect(districtZonedCells(560, 400)).toBe(2100);
  });

  test("the shortfall is the load beyond the headroom the city really has, counting stranded load as spare", () => {
    expect(districtUtilityShortfall({ headroom: 300, consumption: 1000 }, 1000)).toBe(700);
    expect(districtUtilityShortfall({ headroom: 300, undelivered: 500, consumption: 1000 }, 1000)).toBe(200);
    expect(districtUtilityShortfall({ headroom: 5000, consumption: 1000 }, 1000)).toBe(0);
    expect(districtUtilityShortfall({ headroom: null, consumption: 1000 }, 1000)).toBe(0);
    expect(districtUtilityShortfall({ headroom: -400, consumption: 1000 }, 1000)).toBe(1000);
  });
});

describe("district utilities: site choice", () => {
  const terrain = (groundWater: number[], pollution: number[]) => ({ resolution: 2, bounds: { minX: 0, minZ: -400, maxX: 400, maxZ: 400 },
    cellSize: { x: 200, z: 400 }, heights: [0, 0, 0, 0], waterDepths: [0, 0, 0, 0], groundWater, groundWaterPollution: pollution, windSpeed: [] });

  test("samples terrain by cell and answers null outside the read", () => {
    const t = terrain([0, 5, 0, 0], [0, 0, 0, 0]);
    expect(terrainSampleAt(t, { x: 300, z: -100 })?.groundWater).toBe(5);
    expect(terrainSampleAt(t, { x: 100, z: -100 })?.groundWater).toBe(0);
    expect(terrainSampleAt(t, { x: 900, z: 0 })).toBeNull();
    expect(terrainSampleAt(undefined, { x: 0, z: 0 })).toBeNull();
  });

  test("a turbine lot is offered at every setback in turn, the closest to the street first", () => {
    const sites = districtUtilitySites({ kind: "electricity", target: { x: 200, z: 0 }, edges: [street[0]!], existingFacilities: [] });
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0]!.setbackMeters).toBe(12);
    // The first preflights already sample every distance, so one refused frontage cannot use them all up.
    expect(new Set(sites.slice(0, 6).map((site) => site.setbackMeters)).size).toBeGreaterThanOrEqual(6);
  });

  test("a pumping station only stands over clean groundwater", () => {
    const dry = districtUtilitySites({ kind: "water", target: { x: 200, z: 0 }, edges: [street[0]!], existingFacilities: [],
      terrain: terrain([0, 0, 0, 0], [0, 0, 0, 0]) });
    expect(dry).toEqual([]);
    // Groundwater only in the east column of the south row (z in [-400, 0)): sites there, none in the dirty cell.
    const wet = districtUtilitySites({ kind: "water", target: { x: 200, z: 0 }, edges: [street[0]!], existingFacilities: [],
      terrain: terrain([0, 9, 0, 0], [0, 0, 0, 0]) });
    expect(wet.length).toBeGreaterThan(0);
    for (const site of wet) expect(site.position.x).toBeGreaterThanOrEqual(200);
    const polluted = districtUtilitySites({ kind: "water", target: { x: 200, z: 0 }, edges: [street[0]!], existingFacilities: [],
      terrain: terrain([0, 9, 0, 0], [0, 3, 0, 0]) });
    expect(polluted).toEqual([]);
  });

  test("a surface pump stands on dry land with open water close by, not over groundwater", () => {
    // 4x4 grid of 100 m cells over x,z in [0,400]x[-200,200]; the southern strip (z -200 to -100) is a lake.
    const water = new Array<number>(16).fill(0);
    for (let column = 0; column < 4; column += 1) water[column] = 3;
    const lake = { resolution: 4, bounds: { minX: 0, minZ: -200, maxX: 400, maxZ: 200 }, cellSize: { x: 100, z: 100 }, heights: new Array<number>(16).fill(10),
      waterDepths: water, groundWater: new Array<number>(16).fill(0), groundWaterPollution: new Array<number>(16).fill(0), windSpeed: [] };
    const sites = districtUtilitySites({ kind: "water", target: { x: 200, z: 0 }, edges: [street[0]!], existingFacilities: [], terrain: lake, waterSource: "surface" });
    expect(sites.length).toBeGreaterThan(0);
    // None stands in the water, and every one has the lake within 60 m (the strip begins at z = -100).
    for (const site of sites) {
      expect(site.position.z).toBeGreaterThan(-100);
      expect(site.position.z + 100).toBeLessThanOrEqual(65);
    }
    // The same land with no groundwater offers no groundwater pump.
    expect(districtUtilitySites({ kind: "water", target: { x: 200, z: 0 }, edges: [street[0]!], existingFacilities: [], terrain: lake, waterSource: "ground" })).toEqual([]);
  });

  test("a site crowded by another facility is not offered", () => {
    const crowded = districtUtilitySites({ kind: "electricity", target: { x: 200, z: 0 }, edges: [street[0]!],
      existingFacilities: [{ position: { x: 200, z: 12 }, footprintRadiusMeters: 14 }, { position: { x: 200, z: -12 }, footprintRadiusMeters: 14 }] });
    for (const site of crowded) {
      expect(Math.hypot(site.position.x - 200, site.position.z - 12)).toBeGreaterThan(14 + 14 + 24 - 1);
    }
  });
});

describe("district utilities: placement and readback", () => {
  const fakePort = (overrides: Partial<DistrictUtilitiesPort> & { attachedAfterConnect?: boolean } = {}) => {
    const log: string[] = [];
    let standing: { entity: { index: number; version: number }; position: { x: number; z: number } }[] = [];
    let connected = false;
    const port: DistrictUtilitiesPort = {
      listFacilities: async () => standing,
      preflight: async () => true,
      place: async (_prefab, point) => { log.push("place"); standing = [{ entity: { index: 9, version: 1 }, position: { x: point.x, z: point.z } }]; return { ok: true, detail: "" }; },
      connect: async (prefab) => { log.push(`connect ${prefab}`); connected = true; return { ok: true, detail: "" }; },
      attached: async () => (connected ? (overrides.attachedAfterConnect ?? true) : false),
      remove: async () => { log.push("remove"); standing = []; connected = false; return true; },
      ...overrides,
    };
    return { port, log };
  };

  test("an unattached facility is joined to its street with the net's own connection and read back attached", async () => {
    const { port, log } = fakePort();
    const notes: string[] = [];
    const placed = await provisionDistrictUtility(port, { kind: "electricity", shortfall: 10, target: { x: 200, z: 0 }, edges: [street[0]!] }, notes);
    expect(placed?.attached).toBe(true);
    expect(placed?.prefab).toBe("WindTurbine03");
    expect(log).toEqual(["place", "connect Low-voltage Ground Cable"]);
    expect(notes.join(" ")).toMatch(/attached to the network/);
  });

  test("a facility that stays unattached is bulldozed and the next site is tried, bounded", async () => {
    const { port, log } = fakePort({ attachedAfterConnect: false });
    const notes: string[] = [];
    const placed = await provisionDistrictUtility(port, { kind: "electricity", shortfall: 10, target: { x: 200, z: 0 }, edges: [street[0]!] }, notes);
    expect(placed).toBeNull();
    expect(log.filter((entry) => entry === "place")).toHaveLength(3);
    expect(log.filter((entry) => entry === "remove")).toHaveLength(3);
    expect(notes.join(" ")).toMatch(/unattached, removed/);
  });

  test("V2 P7: the shortage reaches the ranker, and the prefab that covers it in one placement is the one tried first", async () => {
    const asked: Array<number | undefined> = [];
    const { port, log } = fakePort({ rankPrefabs: async (_kind, _signal, needed) => { asked.push(needed); return needed && needed > 60_000 ? ["SmallCoalPowerPlant01", "WindTurbine01"] : ["WindTurbine01"]; } });
    const notes: string[] = [];
    const placed = await provisionDistrictUtility(port, { kind: "electricity", shortfall: 69_000, target: { x: 200, z: 0 }, edges: [street[0]!] }, notes);
    expect(asked).toEqual([69_000]);
    expect(placed?.prefab).toBe("SmallCoalPowerPlant01");
    expect(log[0]).toBe("place");
  });

  test("reports a utility with no legal site instead of placing anything", async () => {
    const { port, log } = fakePort({ preflight: async () => false });
    const notes: string[] = [];
    const placed = await provisionDistrictUtility(port, { kind: "sewage", shortfall: 10, target: { x: 200, z: 0 }, edges: [street[0]!] }, notes);
    expect(placed).toBeNull();
    expect(log).toEqual([]);
    expect(notes.join(" ")).toMatch(/no legal site/);
  });
});
