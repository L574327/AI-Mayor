import { DistrictBuilder, GROUND_READ_MAXIMUM_AGE_CALLS, UNZONED_SCAN_WINDOW_METERS, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };

function worldWith(tile: { min: { x: number; z: number }; max: { x: number; z: number } }) {
  const nodes = Array.from({ length: 23 }, (_, index) => node(2.5 + index * 40, -62.5));
  const edges = Array.from({ length: 22 }, (_, index) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
    startNode: nodes[index]!.entity, endNode: nodes[index + 1]!.entity,
    start: { x: nodes[index]!.position.x, y: 0, z: -62.5 }, end: { x: nodes[index + 1]!.position.x, y: 0, z: -62.5 } }));
  return { roadGraph: { nodes, edges }, ownedTiles: [{ entity: { index: 1, version: 1 }, owned: true, bounds: tile,
    center: { x: (tile.min.x + tile.max.x) / 2, z: (tile.min.z + tile.max.z) / 2 }, polygon: [] }] } as never;
}

function countingPort(world: never, terrain: unknown = dry) {
  const reads: Array<{ radius: number; resolution: number }> = [];
  const laid: Array<{ nodes: ReturnType<typeof node>[]; edge: Record<string, unknown> }> = [];
  const port: DistrictBuilderPort = {
    scanWorld: async () => world,
    listBuildings: async () => [],
    siteDetail: async (center, radius, resolution) => {
      reads.push({ radius, resolution });
      return { center, radius, terrain, roadGraph: { nodes: laid.flatMap((entry) => entry.nodes), edges: laid.map((entry) => entry.edge) }, buildings: [], zoningCells: [] } as never;
    },
    buildRoad: async (course) => {
      const start = node(course.start.x, course.start.z);
      const end = node(course.end.x, course.end.z);
      laid.push({ nodes: [start, end], edge: { entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false, startNode: start.entity, endNode: end.entity,
        start: { x: course.start.x, y: 0, z: course.start.z }, end: { x: course.end.x, y: 0, z: course.end.z } } });
      return { ok: true, detail: "ok" };
    },
    zone: async () => ({ ok: true, detail: "ok" }),
  };
  return { port, reads };
}

const input = { demand: { residential: 80, commercial: 0, industrial: 0 }, zoneFor: () => "EU Residential Low" };
/** The whole-ground planning read: radius is half the diagonal of the owned ground plus 24 m, at the planning resolution. */
const maskRadius = (width: number, height: number) => Math.hypot(width, height) / 2 + 24;
const bigRead = (width: number, height: number) => (read: { radius: number; resolution: number }) => read.resolution === 128 && Math.abs(read.radius - maskRadius(width, height)) < 0.01;

describe("wall-clock cost: what a decision spends on the Bridge", () => {
  test("the whole-ground planning read is made once, not once per cycle, while the owned ground is the same", async () => {
    const { port, reads } = countingPort(worldWith({ min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } }));
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    for (let cycle = 0; cycle < 3; cycle += 1) await builder.runCycle(input);
    expect(reads.filter(bigRead(1200, 1000))).toHaveLength(1);
    // A load of another world forgets it.
    builder.rebaseline();
    await builder.runCycle(input);
    expect(reads.filter(bigRead(1200, 1000))).toHaveLength(2);
    expect(GROUND_READ_MAXIMUM_AGE_CALLS).toBeGreaterThan(1);
  });

  test("bigger owned ground (land bought) is a new ground: it is read again at once", async () => {
    let tile = { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } };
    const { port, reads } = countingPort(worldWith(tile));
    port.scanWorld = async () => worldWith(tile);
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    await builder.runCycle(input);
    tile = { min: { x: -100, z: -100 }, max: { x: 1300, z: 900 } };
    await builder.runCycle(input);
    expect(reads.filter(bigRead(1200, 1000))).toHaveLength(1);
    expect(reads.filter(bigRead(1400, 1000))).toHaveLength(1);
  });

  test("production planning terrain is reused when ownership changes", async () => {
    let tile = { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } };
    const { port, reads } = countingPort(worldWith(tile));
    port.scanWorld = async () => worldWith(tile);
    let terrainReads = 0;
    port.readPlanningTerrain = async () => { terrainReads += 1; return dry; };
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    await builder.runCycle(input);
    tile = { min: { x: -100, z: -100 }, max: { x: 1300, z: 900 } };
    await builder.runCycle(input);
    expect(terrainReads).toBe(1);
    expect(reads.some((read) => read.resolution === 128 && read.radius > 1000)).toBe(false);
  });

  test("nothing was laid since the last sweep: the owned ground is not swept for unzoned frontage again", async () => {
    // One small tile holds no district, so no cycle builds anything and the frontage cannot have changed.
    const { port, reads } = countingPort(worldWith({ min: { x: 0, z: 0 }, max: { x: 200, z: 200 } }));
    const builder = new DistrictBuilder(port);
    await builder.runCycle(input);
    const sweepReads = () => reads.filter((read) => read.radius === UNZONED_SCAN_WINDOW_METERS && read.resolution === 16).length;
    const first = sweepReads();
    expect(first).toBeGreaterThan(0);
    const second = await builder.runCycle(input);
    expect(sweepReads()).toBe(first);
    expect(second.notes.join(" | ")).toMatch(/unzoned frontage: not swept/);
  });

  /** One quiet street with one unzoned roadside cell; a house stands next to it by the time of the write (or never, for the control). */
  async function frontageScenario(houseGrows: boolean) {
    const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: 0, z: 0 }, max: { x: 300, z: 300 } }, center: { x: 150, z: 150 },
      polygon: [{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: 0, z: 300 }] };
    const start = node(100, 150);
    const end = node(200, 150);
    const world = { roadGraph: { nodes: [start, end], edges: [{ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
      startNode: start.entity, endNode: end.entity, start: start.position, end: end.position }] }, ownedTiles: [tile] } as never;
    const written: Array<{ zone: string; radius: number }> = [];
    const cell = { block: { index: 5, version: 1 }, index: 0, position: { x: 150, y: 0, z: 150 }, visible: true, roadside: true, occupied: false, blocked: false,
      overridden: false, zoneType: 0, zoneCategory: "none" };
    let swept = false;
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      // The sweep's window read (400 m) sees empty ground; the house appears after it, and only the fresh admission read (a smaller window) shows it.
      siteDetail: async (center, radius) => {
        const sweep = radius === UNZONED_SCAN_WINDOW_METERS;
        if (sweep) swept = true;
        return { center, radius, terrain: dry, roadGraph: { nodes: [], edges: [] },
          buildings: !sweep && swept && houseGrows ? [{ entity: { index: 9, version: 1 }, prefab: "EU_ResidentialLow03", native: false, position: { x: 158, y: 0, z: 150 },
            rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null }] : [],
          zoningCells: sweep ? [cell] : [] } as never;
      },
      buildRoad: async () => ({ ok: true, detail: "ok" }),
      zone: async (zone, _center, radius) => { written.push({ zone, radius }); return { ok: true, detail: "ok" }; },
    };
    await new DistrictBuilder(port).runCycle({ demand: { residential: 80, commercial: 10, industrial: 0 }, zoneFor: () => "R" });
    return { written, swept };
  }

  test("unzoned frontage: a house that stands there by the time of the write is not painted over (the sweep's own list is not authority)", async () => {
    const control = await frontageScenario(false);
    // The control proves the scenario writes at all: with nothing in the way the cell is painted.
    expect(control.swept).toBe(true);
    expect(control.written.length).toBeGreaterThan(0);
    const grown = await frontageScenario(true);
    expect(grown.swept).toBe(true);
    expect(grown.written).toHaveLength(0);
  });

  test("a policy hold is a WAIT with its reason; a search that found no ground is NO_FEASIBLE_SITE", async () => {
    const jobless = { employed: 267, unemploymentRate: 0.35, jobsTotal: 267, jobsFree: 9 };
    const waiting = countingPort(worldWith({ min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } }));
    waiting.port.readLabor = async () => jobless;
    const held = await new DistrictBuilder(waiting.port).runCycle({ ...input, pipelined: true,
      zoneFor: (category: string) => category === "residential" || category === "commercial" ? "EU Residential Low" : null });
    expect(held.status).toBe("NO_SITE");
    expect(held.outcome).toBe("WAIT");
    expect(held.waitReason).toBeTruthy();
    // A tile too small for any district, no land policy: building was called for and no ground offered a site.
    const nothing = countingPort(worldWith({ min: { x: 0, z: 0 }, max: { x: 200, z: 200 } }));
    const none = await new DistrictBuilder(nothing.port).runCycle(input);
    expect(none.status).toBe("NO_SITE");
    expect(none.outcome).toBe("NO_FEASIBLE_SITE");
    expect(none.feasibility).toMatchObject({ reason: "NO_SITE_IN_BOUNDED_SEARCH" });
    // (No terrain read: the survey runs without a land mask, as in the zoning-admission tests.)
    const built = await new DistrictBuilder(countingPort(worldWith({ min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } }), null).port, { maximumSitesPerCycle: 1 }).runCycle(input);
    expect(built.outcome).toBe("BUILD");
  });
});
