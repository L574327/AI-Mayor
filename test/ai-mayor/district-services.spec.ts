import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import {
  densestIcon, RefusedPlacements, reserveSpotIndices, serviceCap, servicePrefabs, servicesWanted, SERVICE_COOLDOWN_CYCLES, splitOutsideOwnedLand,
  garbageBuildingCap,
} from "../../src/main/services/ai-mayor/v2/district-services";

describe("public services where the icons are", () => {
  test("a service is wanted only when enough icons hang, in proportion to the city's size, and is built where they are thickest", () => {
    const reading = { counts: { "Hearse Notification": 57, "Ambulance Notification": 2, "Noise Pollution": 65 }, items: [] };
    expect(servicesWanted(reading)).toEqual([{ need: "deathcare", icons: 57 }]);
    expect(serviceCap("deathcare", 8_200)).toBe(3);
    expect(serviceCap("healthcare", 8_200)).toBe(4);
    expect(serviceCap("deathcare", 0)).toBe(1);
    expect(densestIcon([{ x: 0, z: 0 }, { x: 900, z: 900 }, { x: 910, z: 880 }, { x: 930, z: 905 }])).toEqual({ x: 900, z: 900 });
  });

  test("garbage notices call for a landfill, whole prefab only: the hazardous-waste collection point is not one", () => {
    expect(servicesWanted({ counts: { "Garbage Notification": 14 }, items: [] })).toEqual([{ need: "garbage", icons: 14 }]);
    expect(servicePrefabs("garbage", ["Landfill01 Hazardous Waste Collection Point", "Landfill01"])).toEqual(["Landfill01"]);
    expect(serviceCap("garbage", 10_000)).toBe(1);
  });

  test("icons beyond the owned land are counted apart, not built for: a far wildfire is not a fire-station job", () => {
    const owned = (point: { x: number; z: number }) => point.x < 1000;
    const wild = Array.from({ length: 4 }, (_, index) => ({ type: "Fire Notification", x: 5000 + index, z: 0 }));
    const reading = { counts: { "Fire Notification": 1700, "Hearse Notification": 6 }, items: [...wild, { type: "Hearse Notification", x: 10, z: 10 }] };
    const split = splitOutsideOwnedLand(reading, owned);
    expect(split.outside).toEqual({ "Fire Notification": 1700 });
    expect(split.inside.counts["Fire Notification"]).toBe(0);
    expect(split.inside.counts["Hearse Notification"]).toBe(6);
    expect(split.inside.items).toHaveLength(1);
    const mixed = splitOutsideOwnedLand({ counts: { "Burned Down": 10 }, items: [{ type: "Burned Down", x: 5, z: 5 }, { type: "Burned Down", x: 9000, z: 5 }] }, owned);
    expect(mixed.inside.counts["Burned Down"]).toBe(5);
  });

  test("only whole unlocked buildings are offered: a chapel or an extension is not a cemetery", () => {
    expect(servicePrefabs("deathcare", ["Cemetery01 Chapel", "Cemetery02", "Cemetery01", "Cemetery01 Mausoleum"])).toEqual(["Cemetery01", "Cemetery02"]);
    expect(servicePrefabs("healthcare", ["MedicalClinic01 Extension Wing", "MedicalClinic01", "MedicalClinic02"])).toEqual(["MedicalClinic02", "MedicalClinic01"]);
  });

  test("a district of any size leaves one small block unzoned for a service; a small one leaves none", () => {
    const grid = (columns: number, rows: number) => Array.from({ length: columns * rows }, (_, index) => ({ center: { x: (index % columns) * 40, z: Math.floor(index / columns) * 40 }, onRing: index % columns === 0 || index < columns }));
    expect(reserveSpotIndices(grid(3, 3))).toEqual([]);
    const reserved = reserveSpotIndices(grid(8, 6));
    expect(reserved).toHaveLength(4);
    expect(new Set(reserved).size).toBe(4);
  });

  test("a refused spot is remembered for a while, only to be skipped, and forgotten after", () => {
    const memory = new RefusedPlacements(5);
    memory.remember("Cemetery01", { x: 100, z: 100 }, 10);
    expect(memory.refused("Cemetery01", { x: 101, z: 101 }, 12)).toBe(true);
    expect(memory.refused("MedicalClinic01", { x: 100, z: 100 }, 12)).toBe(false);
    expect(memory.refused("Cemetery01", { x: 100, z: 100 }, 16)).toBe(false);
  });
});

describe("the builder places services near the icons", () => {
  const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
  const nodes = Array.from({ length: 21 }, (_, i) => node(i * 40, 0, 100 + i));
  const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
    start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
  const world = { roadGraph: { nodes, edges }, ownedTiles: [] } as never;
  const icons = (count: number) => ({ counts: { "Hearse Notification": count }, items: Array.from({ length: Math.min(count, 20) }, (_, i) => ({ type: "Hearse Notification", x: 400 + (i % 5) * 10, z: 60 })) });

  function harness(options: { legal: (x: number, z: number) => boolean; standing?: number; demolition?: boolean; homes?: boolean }) {
    const log = { preflights: 0, placed: [] as string[], removed: [] as number[] };
    let standing = options.standing ?? 0;
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, roadGraph: { nodes: [], edges: [] }, zoningCells: [], terrain: undefined,
        buildings: options.homes ? [{ entity: { index: 777, version: 1 }, prefab: "EU_ResidentialLow01_L1_2x4", native: false, position: { x: 410, y: 0, z: 70 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null }] : [] }) as never,
      buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }),
      readIcons: async () => icons(57),
      findPrefabs: async (query) => query === "Cemetery" ? [{ name: "Cemetery01", locked: false }, { name: "Cemetery01 Chapel", locked: false }, { name: "Cemetery02", locked: true }] : [],
      utilities: {
        listFacilities: async (prefab) => prefab === "Cemetery01" ? Array.from({ length: standing }, (_, i) => ({ entity: { index: 900 + i, version: 1 }, position: { x: 400, z: 70 + i * 500 } })) : [],
        preflight: async (_prefab, point) => { log.preflights += 1; return options.legal(point.x, point.z); },
        place: async (prefab, point) => { log.placed.push(`${prefab}@${Math.round(point.x)},${Math.round(point.z)}`); standing += 1; return { ok: true, detail: "" }; },
        attached: async () => null,
        remove: async (entity) => { log.removed.push(entity.index); return true; },
      },
    };
    const builder = new DistrictBuilder(port, { serviceDemolitionExperiment: options.demolition === true });
    const input = { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => "R", population: 8_200 };
    return { builder, log, input, run: (notes: string[] = []) => builder.provideServices(world, input, notes) };
  }

  test("a cemetery is placed on the first legal lot near the hearse icons, read back, and not placed again until the icons have had time to fall", async () => {
    const h = harness({ legal: (x) => x > 300 });
    const notes: string[] = [];
    expect(await h.run(notes)).toBe(1);
    expect(h.log.placed).toHaveLength(1);
    expect(h.log.placed[0]).toMatch(/^Cemetery01@/);
    expect(notes.join(" | ")).toMatch(/stands \(read back\)/);
    for (let cycle = 0; cycle < SERVICE_COOLDOWN_CYCLES - 1; cycle += 1) expect(await h.run()).toBe(0);
    expect(h.log.placed).toHaveLength(1);
  });

  test("no more buildings than the city's size justifies, however many icons remain", async () => {
    const h = harness({ legal: () => true, standing: 3 });
    const notes: string[] = [];
    expect(await h.run(notes)).toBe(0);
    expect(notes.join(" | ")).toMatch(/already stand/);
  });

  test("with no legal lot, a spot the game refused is not offered to it again on the next pass", async () => {
    const h = harness({ legal: () => false });
    await h.run();
    const first = h.log.preflights;
    expect(first).toBeGreaterThan(0);
    for (let cycle = 0; cycle < SERVICE_COOLDOWN_CYCLES; cycle += 1) await h.run();
    expect(h.log.preflights).toBe(first);
    expect(h.log.placed).toEqual([]);
  });

  test("the bulldoze experiment is off unless asked for, and when on clears one low-density home, once, and places the service on its lot", async () => {
    const off = harness({ legal: () => false, homes: true });
    await off.run();
    expect(off.log.removed).toEqual([]);
    // On: the only legal lot is where the home stood (x~410, z~70) once it is gone.
    // eslint-disable-next-line prefer-const
    let on!: ReturnType<typeof harness>;
    on = harness({ legal: (x, z) => on.log.removed.length > 0 && Math.abs(x - 410) < 12 && Math.abs(z - 70) < 12, demolition: true, homes: true });
    const notes: string[] = [];
    expect(await on.run(notes)).toBe(1);
    expect(on.log.removed).toEqual([777]);
    expect(on.log.placed[0]).toMatch(/^Cemetery01@/);
    expect(notes.join(" | ")).toMatch(/EXPERIMENT service deathcare: bulldozed EU_ResidentialLow01/);
    // Never a second one in this process.
    for (let cycle = 0; cycle < SERVICE_COOLDOWN_CYCLES + 1; cycle += 1) await on.run();
    expect(on.log.removed).toEqual([777]);
  });

  test("garbage buildings are counted by kind, as the community guides run them: one incinerator per 25,000, a recycling centre per 15,000, two landfills at most", () => {
    expect(garbageBuildingCap("IncinerationPlant01", 20_000)).toBe(1);
    expect(garbageBuildingCap("IncinerationPlant01", 90_000)).toBe(4);
    expect(garbageBuildingCap("RecyclingCenter01", 29_000)).toBe(2);
    expect(garbageBuildingCap("Landfill01", 500_000)).toBe(2);
    expect(garbageBuildingCap("Landfill01", null)).toBe(2);
  });
  test("garbage buildings are counted by kind, as the community guides run them: one incinerator per 25,000, a recycling centre per 15,000, two landfills at most", () => {
    expect(garbageBuildingCap("IncinerationPlant01", 20_000)).toBe(1);
    expect(garbageBuildingCap("IncinerationPlant01", 90_000)).toBe(4);
    expect(garbageBuildingCap("RecyclingCenter01", 29_000)).toBe(2);
    expect(garbageBuildingCap("Landfill01", 500_000)).toBe(2);
    expect(garbageBuildingCap("Landfill01", null)).toBe(2);
  });});
