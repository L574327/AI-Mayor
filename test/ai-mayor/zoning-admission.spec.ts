import {
  admitZoningBrushes,
  BRUSH_BUILDING_MARGIN_METERS,
  DistrictBuilder,
  groupBrushesForReading,
  MINIMUM_BRUSH_RADIUS_METERS,
  type DistrictBuilderPort,
} from "../../src/main/services/ai-mayor/v2/district-builder";

type Point = { x: number; z: number };
let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
type TestNode = ReturnType<typeof node>;
const edge = (a: { x: number; z: number }, b: { x: number; z: number }) => {
  const start = node(a.x, a.z);
  const end = node(b.x, b.z);
  return { edge: { entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false, startNode: start.entity, endNode: end.entity,
    start: { x: a.x, y: 0, z: a.z }, end: { x: b.x, y: 0, z: b.z } }, nodes: [start, end] };
};

/** The served network of district-builder.spec: a street along z = -62.5 on the 2.5 / 17.5 lattice, one big owned tile. */
function servedWorld() {
  const nodes: TestNode[] = [];
  const edges: unknown[] = [];
  for (let index = 0; index <= 22; index += 1) nodes.push(node(2.5 + index * 40, -62.5));
  for (let index = 0; index < 22; index += 1) {
    const a = nodes[index]!; const b = nodes[index + 1]!;
    edges.push({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false, startNode: a.entity, endNode: b.entity,
      start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });
  }
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } },
    center: { x: 500, z: 400 }, polygon: [{ x: -100, z: -100 }, { x: 1100, z: -100 }, { x: 1100, z: 900 }, { x: -100, z: 900 }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

/** A world that remembers the streets laid (so they read back), with buildings the test can grow at any moment. */
function liveWorld() {
  const built: ReturnType<typeof edge>[] = [];
  const buildings: Point[] = [];
  const zoned: Array<{ zone: string; center: Point; radius: number; standing: Point[] }> = [];
  const state = { unreadable: false, onRoad: null as null | ((count: number, course: { start: Point; end: Point }) => void) };
  const port: DistrictBuilderPort = {
    scanWorld: async () => servedWorld(),
    listBuildings: async () => [],
    siteDetail: async (center, radius) => state.unreadable
      ? null
      : ({ center, radius, terrain: undefined as never,
        roadGraph: { nodes: built.flatMap((entry) => entry.nodes), edges: built.map((entry) => entry.edge) },
        buildings: buildings.map((point, index) => ({ entity: { index: 10_000 + index, version: 1 }, prefab: "EU_ResidentialLow01", native: false,
          position: { x: point.x, y: 0, z: point.z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null })),
        zoningCells: [] }) as never,
    buildRoad: async (course) => {
      built.push(edge(course.start, course.end));
      state.onRoad?.(built.length, course);
      return { ok: true, detail: "ok" };
    },
    zone: async (zone, center, radius) => { zoned.push({ zone, center, radius, standing: buildings.slice() }); return { ok: true, detail: "ok" }; },
  };
  return { port, built, buildings, zoned, state };
}

/** No brush ever written reaches a building that stood at the moment it was written. */
function expectNoBrushOverBuildings(zoned: ReturnType<typeof liveWorld>["zoned"]) {
  for (const brush of zoned) for (const building of brush.standing) {
    expect(Math.hypot(building.x - brush.center.x, building.z - brush.center.z)).toBeGreaterThanOrEqual(brush.radius + BRUSH_BUILDING_MARGIN_METERS - 1e-6);
  }
}

const input = { demand: { residential: 80, commercial: 0, industrial: 0 }, zoneFor: () => "EU Residential Low" };

describe("precise hands: a zoning brush is admitted against the world at the moment of writing", () => {
  test("pure admission: cut back to clear what stands, dropped where no useful brush fits", () => {
    const brushes = [
      { zone: "R", center: { x: 0, z: 0 }, radius: 36 },
      { zone: "O", center: { x: 100, z: 0 }, radius: 36 },
      { zone: "C", center: { x: 300, z: 0 }, radius: 36 },
    ];
    const { admitted, dropped, shrunk } = admitZoningBrushes(brushes, [{ x: 30, z: 0 }, { x: 105, z: 0 }]);
    expect(admitted.map((brush) => brush.zone)).toEqual(["R", "C"]);
    expect(admitted[0]!.radius).toBeCloseTo(30 - BRUSH_BUILDING_MARGIN_METERS, 6);
    expect(admitted[0]!.radius).toBeGreaterThanOrEqual(MINIMUM_BRUSH_RADIUS_METERS);
    expect(admitted[1]!.radius).toBe(36);
    expect(dropped.map((brush) => brush.zone)).toEqual(["O"]);
    expect(shrunk).toBe(1);
  });

  test("brushes far apart are read in separate groups", () => {
    const groups = groupBrushesForReading([
      { zone: "R", center: { x: 0, z: 0 }, radius: 36 }, { zone: "R", center: { x: 200, z: 0 }, radius: 36 },
      { zone: "R", center: { x: 3_000, z: 0 }, radius: 36 },
    ]);
    expect(groups.map((group) => group.length)).toEqual([2, 1]);
  });

  test("stale plan: houses that grew while the streets were laid are not painted over", async () => {
    const world = liveWorld();
    // Halfway through the streets, a row of houses appears along the third street (the city runs while the Mayor builds).
    world.state.onRoad = (count, course) => {
      if (count !== 3) return;
      for (let step = 0; step <= 4; step += 1) {
        world.buildings.push({ x: course.start.x + (course.end.x - course.start.x) * step / 4, z: course.start.z + (course.end.z - course.start.z) * step / 4 });
      }
    };
    const result = await new DistrictBuilder(world.port, { maximumSitesPerCycle: 1 }).runCycle(input);
    expect(world.built.length).toBeGreaterThan(3);
    expect(world.zoned.length).toBeGreaterThan(0);
    expect(world.buildings.length).toBe(5);
    expectNoBrushOverBuildings(world.zoned);
    expect(world.zoned.some((brush) => brush.radius < 36)).toBe(true);
    expect(result.notes.join(" | ")).toMatch(/zoning brushes cut back to clear what stands there now/);
  });

  test("pending replay after the world changed: a queued brush over grown houses is dropped, the rest is painted cut back", async () => {
    const world = liveWorld();
    const builder = new DistrictBuilder(world.port, { maximumSitesPerCycle: 1 });
    // Water or sewage short: the district is laid as streets only and its brushes wait.
    const held = await builder.runCycle({ ...input, zoningHeld: true });
    expect(world.zoned).toHaveLength(0);
    expect(world.built.length).toBeGreaterThan(0);
    // Meanwhile the city grows houses densely over the western part of the district.
    for (let x = -80; x <= 300; x += 20) for (let z = -20; z <= 650; z += 20) world.buildings.push({ x, z });
    const replay = await builder.runCycle(input);
    expect(held.notes.length).toBeGreaterThan(0);
    expect(world.zoned.length).toBeGreaterThan(0);
    expectNoBrushOverBuildings(world.zoned);
    expect(replay.notes.join(" | ")).toMatch(/queued earlier \(admission now: \d+ cut back, [1-9]\d* dropped/);
  });

  test("target unreadable just before writing: nothing is written blind, the brushes stay queued", async () => {
    const world = liveWorld();
    const builder = new DistrictBuilder(world.port, { maximumSitesPerCycle: 1 });
    await builder.runCycle({ ...input, zoningHeld: true });
    world.state.unreadable = true;
    const replay = await builder.runCycle(input);
    expect(world.zoned).toHaveLength(0);
    expect(replay.notes.join(" | ")).toMatch(/repainted 0\/\d+ zoning spots queued earlier .*[1-9]\d* kept: ground unread/);
    // The ground reads again: the queue is painted, through the same admission.
    world.state.unreadable = false;
    await builder.runCycle(input);
    expect(world.zoned.length).toBeGreaterThan(0);
    expectNoBrushOverBuildings(world.zoned);
  });
});
