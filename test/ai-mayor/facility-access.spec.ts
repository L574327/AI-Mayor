import { DistrictBuilder, ROAD_ACCESS_ATTEMPTS_PER_RUN, ROAD_ACCESS_SETTLE_CYCLES, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX, FACILITY_ACCESS_ROAD_PREFAB } from "../../src/main/services/ai-mayor/v2/facility-access-road";
import { distanceToWater, districtUtilitySites, nearestStreetPoint } from "../../src/main/services/ai-mayor/v2/district-utilities";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 1 });
const edge = (x1: number, z1: number, x2: number, z2: number) => ({
  entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false, startNode: { index: 1, version: 1 },
  endNode: { index: 2, version: 1 }, start: { x: x1, y: 0, z: z1 }, end: { x: x2, y: 0, z: z2 },
}) as never;

/** A 300 m street along x = -740, like the one the player fixed a pump against by hand (live 2026-10-04). */
function streetWorld() {
  const a = node(-740, 700);
  const b = node(-740, 1000);
  const street = { entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false, startNode: a.entity, endNode: b.entity,
    start: { x: -740, y: 0, z: 700 }, end: { x: -740, y: 0, z: 1000 } };
  return { roadGraph: { nodes: [a, b], edges: [street] }, ownedTiles: [] } as never;
}

type Course = { start: { x: number; z: number }; end: { x: number; z: number } };

/**
 * A builder whose world shows one "No Road Access" notice 26 m from the street. `verdicts` is what the game's dry run answers to each
 * course in turn ("OK" or a rejection); `built` records the streets that were really laid.
 */
function noticeWorld(verdicts: string[], entity?: { index: number; version: number }) {
  const built: Array<{ course: Course; prefab: string }> = [];
  const dryRuns: Course[] = [];
  const removed: Array<{ index: number; version: number }> = [];
  const world = streetWorld();
  const port: DistrictBuilderPort = {
    scanWorld: async () => world, listBuildings: async () => [], siteDetail: async () => null,
    buildRoad: async (course, prefab) => { built.push({ course, prefab }); return { ok: true, detail: "ok" }; },
    preflightRoad: async (course) => { dryRuns.push(course); return verdicts[Math.min(dryRuns.length - 1, verdicts.length - 1)]!; },
    zone: async () => ({ ok: true, detail: "ok" }),
    readIcons: async () => ({ counts: { "No Road Access": 1 }, items: [{ type: "No Road Access", x: -714, z: 845, ...(entity ? { entity, prefab: "SmallCoalPowerPlant01" } : {}) }] }),
    findPrefabs: async () => [],
    utilities: {
      listFacilities: async () => [], preflight: async () => true, place: async () => ({ ok: true, detail: "" }), attached: async () => true,
      remove: async (target) => { removed.push(target); return true; },
    },
  };
  return { builder: new DistrictBuilder(port), world, built, dryRuns, removed };
}
const cycle = (builder: DistrictBuilder, world: never, notes: string[] = []) =>
  builder.provideServices(world, { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null }, notes);

describe("a notice 'No Road Access' is answered with the product's own facility-access-road ladder", () => {
  test("the plain road comes first — street to the spot the game named — and is dry-run before it is built", async () => {
    const { builder, world, built, dryRuns } = noticeWorld(["OK"]);
    const notes: string[] = [];
    await cycle(builder, world, notes);
    expect(dryRuns).toHaveLength(1);
    expect(built).toHaveLength(1);
    expect(built[0]!.prefab).toBe(FACILITY_ACCESS_ROAD_PREFAB);
    // The zero rung: the road a player draws by hand, from the street to where the game put the notice.
    expect(built[0]!.course.start.x).toBeCloseTo(-740, 6);
    expect(built[0]!.course.start.z).toBeCloseTo(845, 6);
    expect(built[0]!.course.end).toEqual({ x: -714, z: 845 });
    expect(notes.join(" | ")).toMatch(/road access: Small Road 26 m laid to \(-714,845\)/);
  });

  test("when the game's dry run refuses the plain road, the same road moved 12 m to the side is tried — at most three attempts, only the accepted one built", async () => {
    const { builder, world, built, dryRuns } = noticeWorld(["REJECT:NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED", "OK"]);
    await cycle(builder, world);
    expect(dryRuns.length).toBe(2);
    expect(built).toHaveLength(1);
    // The second rung ends at the same spot and starts 12 m along the street.
    expect(built[0]!.course.end).toEqual({ x: -714, z: 845 });
    expect(Math.abs(built[0]!.course.start.z - 845)).toBeCloseTo(12, 6);
    const refusedEverything = noticeWorld(["REJECT:operation blocked by game validation"]);
    await cycle(refusedEverything.builder, refusedEverything.world);
    // The ladder's attempts, then the short roads that stop before the notice point (see `shortAccessRoadCourseCandidates`).
    expect(refusedEverything.dryRuns.length).toBeLessThanOrEqual(ROAD_ACCESS_ATTEMPTS_PER_RUN + 3);
    expect(refusedEverything.built).toHaveLength(0);
  });

  test("every attempt is written to the experience log (write-only), and a log that throws never stops the repair", async () => {
    const rows: unknown[] = [];
    const ok = noticeWorld(["REJECT:operation blocked by game validation (overlap)", "OK"]);
    const okPort = (ok.builder as unknown as { port: DistrictBuilderPort }).port;
    okPort.recordAccessAttempt = (row) => { rows.push(row); };
    await cycle(ok.builder, ok.world);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "FACILITY_ACCESS_ROAD", outcome: "BUILT", distanceToStreetMeters: 26, noticeAt: { x: -714, z: 845 } });
    expect((rows[0] as { verdicts: string[] }).verdicts[0]).toMatch(/^REJECT/);
    const refused = noticeWorld(["REJECT:x"]);
    (refused.builder as unknown as { port: DistrictBuilderPort }).port.recordAccessAttempt = () => { throw new Error("disk full"); };
    await expect(cycle(refused.builder, refused.world)).resolves.not.toThrow();
  });

  test("a footpath-only street is never laid for a building that also lacks a car road (live 2026-10-07: 2 car notices became 54); a footpath-only notice still gets one", async () => {
    const both = noticeWorld(["OK"]);
    const bothPort = (both.builder as unknown as { port: DistrictBuilderPort }).port;
    bothPort.readIcons = async () => ({ counts: {}, items: [
      { type: "No Pedestrian Access", x: -714, z: 845, prefab: "EU_CommercialLowSignature02" }, { type: "No Car Access", x: -714, z: 860, prefab: "EU_CommercialLowSignature02" } ] });
    await cycle(both.builder, both.world);
    expect(both.built.map((entry) => entry.prefab)).toEqual([FACILITY_ACCESS_ROAD_PREFAB]);
    const footOnly = noticeWorld(["OK"]);
    const footPort = (footOnly.builder as unknown as { port: DistrictBuilderPort }).port;
    footPort.readIcons = async () => ({ counts: {}, items: [{ type: "No Pedestrian Access", x: -714, z: 845, prefab: "SmallCoalPowerPlant01" }] });
    await cycle(footOnly.builder, footOnly.world);
    expect(footOnly.built.map((entry) => entry.prefab)).toEqual(["Pedestrian Street Small"]);
  });

  test("a pedestrian street after which the building's car notices pile up is taken away again", async () => {
    const target = noticeWorld(["OK"]);
    const port = (target.builder as unknown as { port: DistrictBuilderPort }).port;
    const gone: Array<{ index: number; version: number }> = [];
    port.demolishRoad = async (entity) => { gone.push(entity); return true; };
    let phase = 0;
    port.readIcons = async () => ({ counts: {}, items: phase === 0
      ? [{ type: "No Pedestrian Access", x: -714, z: 845, prefab: "SmallCoalPowerPlant01" }]
      : [0, 1, 2, 3, 4].map((at) => ({ type: "No Car Access", x: -714, z: 845 + at, prefab: "SmallCoalPowerPlant01" })) });
    await cycle(target.builder, target.world);
    expect(target.built.map((entry) => entry.prefab)).toEqual(["Pedestrian Street Small"]);
    // The street now stands in the world.
    const street = { entity: { index: 555, version: 1 }, prefab: "Pedestrian Street Small", native: false, startNode: { index: 1, version: 1 }, endNode: { index: 2, version: 1 },
      start: { x: -740, y: 0, z: 845 }, end: { x: -714, y: 0, z: 845 }, length: 26 };
    (target.world as unknown as { roadGraph: { edges: unknown[] } }).roadGraph.edges.push(street);
    phase = 1;
    for (let run = 0; run < 6; run += 1) await cycle(target.builder, target.world);
    expect(gone).toContainEqual({ index: 555, version: 1 });
  });

  test("a road just laid is given time: the notice stays up until the city has run, and that is not a failure", async () => {
    const { builder, world, built, dryRuns } = noticeWorld(["OK"], { index: 7, version: 1 });
    for (let run = 0; run < ROAD_ACCESS_SETTLE_CYCLES + 1; run += 1) await cycle(builder, world);
    expect(built).toHaveLength(1);
    expect(dryRuns).toHaveLength(1);
  });

  test("a facility this Mayor placed that the ladder could never reach is taken down; one it did not place is never touched", async () => {
    // Every rung refused, cycle after cycle.
    const own = noticeWorld(["REJECT:operation blocked by game validation"], { index: 7, version: 1 });
    // Make the facility the builder's own by having it place one (the placement carries the entity).
    const placeOwn = async (target: ReturnType<typeof noticeWorld>) => {
      const standing: Array<{ entity: { index: number; version: number }; position: { x: number; z: number } }> = [];
      const port = (target.builder as unknown as { port: DistrictBuilderPort }).port;
      port.utilities!.listFacilities = async () => standing;
      port.utilities!.place = async (_prefab, point) => { standing.push({ entity: { index: 7, version: 1 }, position: { x: point.x, z: point.z } }); return { ok: true, detail: "" }; };
      await target.builder.repairUtilities({ kinds: ["electricity"], shortfalls: { electricity: 1 } });
      return standing.length;
    };
    expect(await placeOwn(own)).toBeGreaterThan(0);
    for (let run = 0; run <= FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX + 1; run += 1) await cycle(own.builder, own.world);
    expect(own.built).toHaveLength(0);
    expect(own.removed.map((entity) => ({ index: entity.index, version: entity.version }))).toEqual([{ index: 7, version: 1 }]);
    // The same notice about a building the Mayor did not place: the ladder fails the same way, and nothing is demolished.
    const foreign = noticeWorld(["REJECT:operation blocked by game validation"], { index: 99, version: 3 });
    for (let run = 0; run <= FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX + 1; run += 1) await cycle(foreign.builder, foreign.world);
    expect(foreign.removed).toHaveLength(0);
  });

  test("a costly service (cemetery) this Mayor placed that no road can reach is NOT taken down (player's rule 2026-10-07: costly facilities are never placed and torn down in a loop); a cheap one still is", async () => {
    const target = noticeWorld(["REJECT:operation blocked by game validation (overlap, water)"]);
    const port = (target.builder as unknown as { port: DistrictBuilderPort }).port;
    const standing: Array<{ entity: { index: number; version: number }; position: { x: number; z: number } }> = [];
    port.findPrefabs = async (query) => query === "Cemetery" ? [{ name: "Cemetery02", locked: false }] : [];
    port.readIcons = async () => ({
      counts: { "No Road Access": 1, "Hearse Notification": 3 },
      items: [
        { type: "Hearse Notification", x: -714, z: 845 }, { type: "Hearse Notification", x: -714, z: 850 }, { type: "Hearse Notification", x: -710, z: 845 },
        ...(standing.length > 0 ? [{ type: "No Road Access", x: standing[0]!.position.x, z: standing[0]!.position.z + 24 }] : []),
      ],
    });
    port.utilities!.listFacilities = async (prefab) => prefab === "Cemetery02" ? standing : [];
    port.utilities!.place = async (_prefab, point) => { standing.push({ entity: { index: 31, version: 2 }, position: { x: point.x, z: point.z } }); return { ok: true, detail: "" }; };
    const input = { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null, population: 9_000 };
    for (let run = 0; run < 2 + FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX + 2; run += 1) await target.builder.provideServices(target.world, input, []);
    expect(target.built).toHaveLength(0);
    // Left standing for the player (the test replaces the port's `place`, so the placement guard itself is covered in high-value-guard.spec.ts).
    expect(target.removed).toHaveLength(0);
  });
});

describe("a surface pump goes as close to the shore as the ground allows", () => {
  // 4 x 4 cells of 100 m over x in [0, 400], z in [-200, 200]; the southern strip (z -200 to -100) is a lake.
  const water = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) water[column] = 3;
  const lake = { resolution: 4, bounds: { minX: 0, minZ: -200, maxX: 400, maxZ: 200 }, cellSize: { x: 100, z: 100 }, heights: new Array<number>(16).fill(10),
    waterDepths: water, groundWater: new Array<number>(16).fill(0), groundWaterPollution: new Array<number>(16).fill(0), windSpeed: [] };

  test("distance to water is read from the terrain", () => {
    expect(distanceToWater(lake as never, { x: 200, z: -60 })).toBeCloseTo(40, 5);
    expect(distanceToWater(undefined, { x: 0, z: 0 })).toBeNull();
    const dry = { ...lake, waterDepths: new Array<number>(16).fill(0) };
    expect(distanceToWater(dry as never, { x: 0, z: 0 })).toBeNull();
  });

  test("within a setback, the lot nearest the water comes first, not the lot nearest the district", () => {
    const street = [edge(0, 0, 400, 0)];
    const sites = districtUtilitySites({ kind: "water", waterSource: "surface", target: { x: 400, z: 180 }, edges: street, existingFacilities: [], terrain: lake as never });
    expect(sites.length).toBeGreaterThan(0);
    const firstSetback = sites[0]!.setbackMeters;
    const group = sites.filter((site) => site.setbackMeters === firstSetback);
    const bucket = (site: { position: { x: number; z: number } }) => Math.floor((distanceToWater(lake as never, site.position) ?? Infinity) / 10);
    for (const other of group) expect(bucket(group[0]!)).toBeLessThanOrEqual(bucket(other));
  });

  test("the nearest street point is the road contact", () => {
    const contact = nearestStreetPoint({ x: -714, z: 845 }, [edge(-740, 700, -740, 1000)] as never);
    expect(contact!.point).toEqual({ x: -740, z: 845 });
    expect(contact!.distance).toBeCloseTo(26, 6);
  });
});
