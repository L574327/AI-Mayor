import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { cornersNearest, doorSides, GROWABLE_PREFAB, wrapPieces, wrapRing, wrapSides } from "../../src/main/services/ai-mayor/v2/wrap-road";

describe("the wrap road in the care round: the coal plant's two doors in one try", () => {
  test("live 2026-10-08: 'No Car Access' at the front and 'No Pedestrian Access' at the side — one ring, joined to the street, passes both", async () => {
    const street = { entity: { index: 1, version: 1 }, prefab: "Medium Road", native: false, startNode: { index: 2, version: 1 }, endNode: { index: 3, version: 1 },
      start: { x: -200, y: 0, z: 100 }, end: { x: 200, y: 0, z: 100 } };
    const world = { roadGraph: { nodes: [
      { entity: { index: 2, version: 1 }, position: { x: -200, y: 0, z: 100 }, native: false, outsideConnection: false, roadDegree: 1 },
      { entity: { index: 3, version: 1 }, position: { x: 200, y: 0, z: 100 }, native: false, outsideConnection: false, roadDegree: 1 },
    ], edges: [street] }, ownedTiles: [] } as never;
    const built: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [], siteDetail: async () => null,
      buildRoad: async (course) => { built.push(course); return { ok: true, detail: "ok" }; },
      preflightRoad: async () => "OK",
      zone: async () => ({ ok: true, detail: "ok" }),
      readIcons: async () => ({ counts: {}, items: [
        { type: "No Car Access", x: 0, z: 24, prefab: "SmallCoalPowerPlant01" }, { type: "No Pedestrian Access", x: 40, z: 0, prefab: "SmallCoalPowerPlant01" }] }),
      findPrefabs: async () => [],
      techTree: { tree: async () => null, prefabLocks: async () => [{ prefab: "SmallCoalPowerPlant01", locked: false, requirements: [], lotSize: { x: 10, z: 6 } }], purchase: async () => ({ ok: true, detail: "" }) } as never,
      utilities: {
        listFacilities: async (prefab) => prefab === "SmallCoalPowerPlant01" ? [{ entity: { index: 9, version: 1 }, position: { x: 0, z: 0 } }] : [],
        preflight: async () => true, place: async () => ({ ok: true, detail: "" }), attached: async () => true,
      },
    };
    const notes: string[] = [];
    await new DistrictBuilder(port).provideServices(world, { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null }, notes);
    expect(notes.join(" | ")).toMatch(/wrap road round SmallCoalPowerPlant01 .* laid/);
    // A connector and the four sides, each piece starting where the road already is.
    expect(built.length).toBe(5);
    expect(built[0]!.start.z).toBeCloseTo(100);
  });
});

describe("a facility's new road is on trial: the water comes first (live 2026-10-08, 布拉丁)", () => {
  test("the outage jumps after the road: water is asked for and the road stays; still dry on the next reading: the road is taken away and never laid again", async () => {
    const street = { entity: { index: 1, version: 1 }, prefab: "Medium Road", native: false, startNode: { index: 2, version: 1 }, endNode: { index: 3, version: 1 },
      start: { x: -200, y: 0, z: 100 }, end: { x: 200, y: 0, z: 100 } };
    const edges: unknown[] = [street];
    const world = { roadGraph: { nodes: [], edges }, ownedTiles: [] } as never;
    const built: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
    const demolished: unknown[] = [];
    let dry = 0;
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [], siteDetail: async () => null,
      buildRoad: async (course) => {
        built.push(course);
        edges.push({ entity: { index: 100 + built.length, version: 1 }, prefab: "Small Road", native: false, startNode: { index: 9, version: 1 }, endNode: { index: 10, version: 1 },
          start: { x: course.start.x, y: 0, z: course.start.z }, end: { x: course.end.x, y: 0, z: course.end.z } });
        return { ok: true, detail: "ok" };
      },
      demolishRoad: async (entity) => { demolished.push(entity); return true; },
      preflightRoad: async () => "OK",
      zone: async () => ({ ok: true, detail: "ok" }),
      readIcons: async () => ({ counts: { "Water Notification": dry }, items: [
        { type: "No Car Access", x: 0, z: 24, prefab: "SmallCoalPowerPlant01" }, { type: "No Pedestrian Access", x: 40, z: 0, prefab: "SmallCoalPowerPlant01" },
        ...Array.from({ length: Math.min(dry, 50) }, (_, index) => ({ type: "Water Notification", x: 300 + index, z: 300 }))] }),
      findPrefabs: async () => [],
      techTree: { tree: async () => null, prefabLocks: async () => [{ prefab: "SmallCoalPowerPlant01", locked: false, requirements: [], lotSize: { x: 10, z: 6 } }], purchase: async () => ({ ok: true, detail: "" }) } as never,
      utilities: {
        listFacilities: async (prefab) => prefab === "SmallCoalPowerPlant01" ? [{ entity: { index: 9, version: 1 }, position: { x: 0, z: 0 } }] : [],
        preflight: async () => true, place: async () => ({ ok: true, detail: "" }), attached: async () => true,
      },
    };
    const builder = new DistrictBuilder(port);
    const input = { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null };
    await builder.provideServices(world, input, []);
    expect(built.length).toBeGreaterThan(0);
    const laid = built.length;
    // The city goes dry.
    dry = 612;
    const second: string[] = [];
    await builder.provideServices(world, input, second);
    expect(second.join(" | ")).toMatch(/water is added where the buildings went dry, and the road is judged again/);
    expect(demolished).toHaveLength(0);
    // Still dry after the water: the road goes, and the plant is not joined again.
    const third: string[] = [];
    await builder.provideServices(world, input, third);
    expect(third.join(" | ")).toMatch(/taken away again, and it is not joined again/);
    expect(demolished.length).toBe(laid);
    await builder.provideServices(world, input, []);
    expect(built.length).toBe(laid);
  });
});

describe("the wrap road: a ring round the building, past every door (the player's rule, 2026-10-08)", () => {
  // A coal plant 80 m wide, 48 m deep, facing +z: centre (0,0), the car door on the front edge (0,24), the footpath door on the east side (40,0).
  const lot = { widthMeters: 80, depthMeters: 48 };
  const ring = wrapRing({ x: 0, z: 0 }, [{ x: 0, z: 24 }], lot, 7)!;

  test("the ring is the lot grown by the clearance on every side", () => {
    const xs = ring.corners.map((corner) => Math.round(corner.x)).sort((a, b) => a - b);
    const zs = ring.corners.map((corner) => Math.round(corner.z)).sort((a, b) => a - b);
    expect([xs[0], xs[3]]).toEqual([-47, 47]);
    expect([zs[0], zs[3]]).toEqual([-31, 31]);
  });

  test("both doors' sides are on the ring, and one walk from the street's corner passes both", () => {
    const sides = doorSides(ring, [{ x: 0, z: 24 }, { x: 40, z: 0 }]);
    expect(sides.size).toBe(2);
    const start = cornersNearest(ring, { x: 60, z: 60 })[0]!;
    const walk = wrapSides(start, () => true, sides)!;
    expect(walk.forward.length + walk.backward.length).toBe(4);
    const pieces = wrapPieces(ring, walk);
    // Laid from the street's corner outward: each piece starts where the road already is.
    const reached = [ring.corners[start]!];
    for (const piece of pieces) {
      expect(reached.some((point) => Math.hypot(point.x - piece.start.x, point.z - piece.start.z) < 0.01)).toBe(true);
      reached.push(piece.end);
    }
  });

  test("a side the game refuses (a street already runs there) is left out, so long as the doors stay joined; a door cut off means no ring", () => {
    const sides = doorSides(ring, [{ x: 0, z: 24 }]);
    const front = [...sides][0]!;
    // The back side refused: the front is still reached.
    const back = (front + 2) % 4;
    expect(wrapSides(front, (side) => side !== back, sides)).not.toBeNull();
    // The front itself refused: nothing is laid.
    expect(wrapSides(front, (side) => side !== front, sides)).toBeNull();
  });

  test("live 2026-10-08: four doors on one edge, off its middle — the way out is square to that edge, not toward the first door", () => {
    // The coal plant at (852, 9.76), lot 112 x 128 m; its notices all on x = 792.28 at z 30-36.
    const doors = [{ x: 792.28, z: 36.5 }, { x: 792.28, z: 30 }, { x: 792.28, z: 34.75 }, { x: 792.28, z: 31.75 }];
    const coal = wrapRing({ x: 852.06, z: 9.76 }, doors, { widthMeters: 112, depthMeters: 128 }, 7)!;
    const xs = coal.corners.map((corner) => corner.x);
    const zs = coal.corners.map((corner) => corner.z);
    // Axis-aligned: the front side on x = 792.28 - 7, the sides 64 + 7 m either side of the centre in z.
    expect(Math.min(...xs)).toBeCloseTo(785.28, 1);
    expect(Math.max(...xs)).toBeCloseTo(852.06 + 59.78 + 7, 1);
    expect(Math.min(...zs)).toBeCloseTo(9.76 - 71, 1);
    expect(Math.max(...zs)).toBeCloseTo(9.76 + 71, 1);
  });

  test("growable homes, shops and factories never get a ring; service buildings and plants do", () => {
    expect(GROWABLE_PREFAB.test("EU_ResidentialLow01_L1_2x3")).toBe(true);
    expect(GROWABLE_PREFAB.test("SmallCoalPowerPlant01")).toBe(false);
    expect(GROWABLE_PREFAB.test("Cemetery01")).toBe(false);
  });
});
