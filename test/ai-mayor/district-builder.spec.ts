import {
  classifyBuilding,
  compileDistrict,
  DistrictBuilder,
  districtLatticeOrigin,
  INDUSTRIAL_BUFFER_STEPS_METERS,
  nextConnectedCourse,
  nextTileCandidates,
  safeBrushRadius,
  splitCourse,
  surveyDistrictSites,
  type DistrictBuilderPort,
  type DistrictCourse,
} from "../../src/main/services/ai-mayor/v2/district-builder";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false,
  outsideConnection: false, roadDegree: 2 });
type TestNode = ReturnType<typeof node>;
const edge = (a: TestNode, b: TestNode) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
  startNode: a.entity, endNode: b.entity, start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });

/** A served network: a 22-street road along z = -40 from x = 0 to 880, axis aligned on the 2.5 / 17.5 lattice. */
function servedWorld(extraEdges: ReturnType<typeof edge>[] = [], extraNodes: TestNode[] = []) {
  const nodes: TestNode[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  for (let index = 0; index <= 22; index += 1) nodes.push(node(2.5 + index * 40, -62.5));
  for (let index = 0; index < 22; index += 1) edges.push(edge(nodes[index]!, nodes[index + 1]!));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } },
    center: { x: 500, z: 400 }, polygon: [{ x: -100, z: -100 }, { x: 1100, z: -100 }, { x: 1100, z: 900 }, { x: -100, z: 900 }] };
  return { roadGraph: { nodes: [...nodes, ...extraNodes], edges: [...edges, ...extraEdges] }, ownedTiles: [tile] } as never;
}

describe("district builder: the player-style decision layer", () => {
  test("continues the city's own lattice to the decimetre", () => {
    expect(districtLatticeOrigin(servedWorld())).toEqual({ x: 2.5, z: 17.5 });
  });

  test("offers the biggest district on empty owned land, joined to the served network by a short gateway", () => {
    const [best] = surveyDistrictSites({ world: servedWorld(), buildings: [], maximumAreaSquareMeters: 224_000 });
    expect(best).toBeDefined();
    // The biggest shape under the cap: four blocks by three at the template's own 112 m street spacing.
    expect(best!.widthMeters * best!.heightMeters).toBe(448 * 336);
    expect(best!.gateway.lengthMeters).toBeLessThanOrEqual(80);
    // The district stays clear of the existing road.
    expect(best!.anchor.z).toBeGreaterThanOrEqual(-62.5 + 12);
  });

  test("never lays a district over a building or across a road", () => {
    const sites = surveyDistrictSites({ world: servedWorld(), buildings: [{ x: 300, z: 200 }] });
    for (const site of sites) {
      const covers = 300 >= site.anchor.x - 12 && 300 <= site.anchor.x + site.widthMeters + 12 &&
        200 >= site.anchor.z - 12 && 200 <= site.anchor.z + site.heightMeters + 12;
      expect(covers).toBe(false);
    }
  });

  test("an earlier gateway stopping on the ring is the district's own entrance, not an obstacle", () => {
    const world = servedWorld() as unknown as { roadGraph: { nodes: TestNode[]; edges: ReturnType<typeof edge>[] } };
    const from = world.roadGraph.nodes[5]!;
    const stub = node(from.position.x, -22.5);
    world.roadGraph.nodes.push(stub);
    world.roadGraph.edges.push(edge(from, stub));
    const sites = surveyDistrictSites({ world: world as never, buildings: [] });
    const joined = sites.find((site) => site.gateway.lengthMeters === 0);
    expect(joined).toBeDefined();
    expect(compileDistrict(joined!)!.courses.some((course) => course.kind === "GATEWAY")).toBe(false);
  });

  test("a compiled district lays every street touching what is already connected — never an orphan", () => {
    const [site] = surveyDistrictSites({ world: servedWorld(), buildings: [] });
    const plan = compileDistrict(site!)!;
    const connected = [{ start: site!.gateway.from, end: site!.gateway.from }];
    const settled = new Set<string>();
    const order: DistrictCourse[] = [];
    for (let course = nextConnectedCourse(plan.courses, connected, settled); course;
      course = nextConnectedCourse(plan.courses, connected, settled)) {
      settled.add(course.id);
      order.push(course);
      connected.push({ start: course.start, end: course.end });
    }
    expect(order[0]!.kind).toBe("GATEWAY");
    expect(order).toHaveLength(plan.courses.length);
    expect(plan.zoneSpots.length).toBeGreaterThan(100);
  });

  test("housing keeps clear of industry and industry keeps clear of housing", () => {
    const factory = { x: 500, z: 300 };
    const homes = surveyDistrictSites({ world: servedWorld(), buildings: [], role: "residential",
      landUse: { sensitive: [], polluters: [factory] } });
    for (const site of homes) {
      const dx = Math.max(site.anchor.x - factory.x, 0, factory.x - (site.anchor.x + site.widthMeters));
      const dz = Math.max(site.anchor.z - factory.z, 0, factory.z - (site.anchor.z + site.heightMeters));
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(320);
    }
    const house = { x: 500, z: 300 };
    const industry = surveyDistrictSites({ world: servedWorld(), buildings: [], role: "industrial",
      landUse: { sensitive: [house], polluters: [] } });
    for (const site of industry) {
      const dx = Math.max(site.anchor.x - house.x, 0, house.x - (site.anchor.x + site.widthMeters));
      const dz = Math.max(site.anchor.z - house.z, 0, house.z - (site.anchor.z + site.heightMeters));
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(400);
    }
  });

  test("industry searched at a narrower distance finds the sites the 400 m rule left none of (the jobs-short city that stood still)", () => {
    const house = { x: 500, z: 300 };
    const wide = surveyDistrictSites({ world: servedWorld(), buildings: [], role: "industrial", landUse: { sensitive: [house], polluters: [] } });
    const narrow = surveyDistrictSites({ world: servedWorld(), buildings: [], role: "industrial", landUse: { sensitive: [house], polluters: [] }, industrialBufferMeters: 180 });
    expect(INDUSTRIAL_BUFFER_STEPS_METERS).toEqual([400, 320]);
    expect(narrow.length).toBeGreaterThanOrEqual(wide.length);
    for (const site of narrow) {
      const dx = Math.max(site.anchor.x - house.x, 0, house.x - (site.anchor.x + site.widthMeters));
      const dz = Math.max(site.anchor.z - house.z, 0, house.z - (site.anchor.z + site.heightMeters));
      expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(180);
    }
    // Homes cover the whole owned ground: nothing is 400 m from them, but something is 180 m from a single house.
    const all = Array.from({ length: 12 }, (_, i) => Array.from({ length: 9 }, (_, j) => ({ x: i * 100, z: j * 100 }))).flat();
    expect(surveyDistrictSites({ world: servedWorld(), buildings: [], role: "industrial", landUse: { sensitive: all, polluters: [] } })).toHaveLength(0);
  });

  test("buildings are classified by what they do to their neighbours", () => {
    expect(classifyBuilding("EU_IndustrialManufacturing03")).toBe("polluter");
    expect(classifyBuilding("CoalPowerPlant01")).toBe("polluter");
    expect(classifyBuilding("SewageOutlet01")).toBe("polluter");
    expect(classifyBuilding("EU_ResidentialMedium02")).toBe("sensitive");
    expect(classifyBuilding("ElementarySchool01")).toBe("sensitive");
    expect(classifyBuilding("EU_CommercialLow01")).toBe("neutral");
  });

  test("when owned land holds no district it buys the dry neighbouring tile nearest the network", async () => {
    // One small owned tile: too small for any district.
    const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: 0, z: 0 }, max: { x: 200, z: 200 } },
      center: { x: 100, z: 100 }, polygon: [{ x: 0, z: 0 }, { x: 200, z: 0 }, { x: 200, z: 200 }, { x: 0, z: 200 }] };
    const base = servedWorld() as unknown as { roadGraph: unknown };
    const world = { roadGraph: base.roadGraph, ownedTiles: [tile] } as never;
    const candidates = nextTileCandidates(world);
    expect(candidates).toHaveLength(4);
    const bought: string[] = [];
    const dry = { resolution: 2, bounds: { minX: -3000, minZ: -3000, maxX: 3000, maxZ: 3000 }, cellSize: { x: 3000, z: 3000 }, heights: [0, 0, 0, 0],
      waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };
    const builder = new DistrictBuilder({
      scanWorld: async () => world,
      listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, terrain: dry, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async () => ({ ok: true, detail: "" }),
      zone: async () => ({ ok: true, detail: "" }),
      purchaseTile: async (point) => { bought.push(`${point.x},${point.z}`); return { ok: true, detail: "purchased" }; },
    });
    const withoutPermission = await builder.runCycle({ demand: { residential: 50, commercial: 0, industrial: 0 }, zoneFor: () => "R" });
    expect(withoutPermission.status).toBe("NO_SITE");
    const result = await builder.runCycle({ demand: { residential: 50, commercial: 0, industrial: 0 }, zoneFor: () => "R",
      mayPurchaseLand: true });
    expect(result.status).toBe("LAND_PURCHASED");
    expect(bought).toEqual([`${candidates[0]!.x},${candidates[0]!.z}`]);
  });

  test("pipelined: a city short of jobs lays no new housing district and does not wait on it, and an unpipelined cycle still builds", async () => {
    const writes: string[] = [];
    const port = (): DistrictBuilderPort => ({
      scanWorld: async () => servedWorld() as never,
      listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, terrain: undefined as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async (course) => { writes.push(`road ${course.start.x},${course.start.z}`); return { ok: true, detail: "ok" }; },
      zone: async () => { writes.push("zone"); return { ok: true, detail: "ok" }; },
      readLabor: async () => ({ employed: 267, unemploymentRate: 0.35, jobsTotal: 267, jobsFree: 9 }),
    });
    const input = { demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: () => "EU Residential Medium" };
    // With no industry on offer (locked) the jobless city simply gets no new homes.
    const noIndustry = { ...input, zoneFor: (category: string) => category === "residential" || category === "commercial" ? "EU Residential Medium" : null };
    const held = await new DistrictBuilder(port()).runCycle({ ...noIndustry, pipelined: true });
    expect(held.status).toBe("NO_SITE");
    expect(writes.filter((write) => write.startsWith("road"))).toHaveLength(0);
    expect(held.notes.join(" | ")).toMatch(/bottleneck JOBS/);
    // With industry on offer, the next district is an industrial one.
    const industrial = await new DistrictBuilder(port(), { maximumSitesPerCycle: 1 }).runCycle({ ...input, pipelined: true });
    expect(industrial.notes.join(" | ")).toMatch(/policy chose industrial for JOBS/);
    const unpipelined = await new DistrictBuilder(port()).runCycle(input);
    expect(unpipelined.notes.join(" | ")).not.toMatch(/bottleneck/);
  });

  test("land is not bought beyond a gateway's reach of the served network, on water, or while the last tile bought holds no district", async () => {
    const tile = (x: number, z: number) => ({ entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x, z }, max: { x: x + 200, z: z + 200 } },
      center: { x: x + 100, z: z + 100 }, polygon: [] });
    const base = servedWorld() as unknown as { roadGraph: unknown };
    const bought: string[] = [];
    const terrain = (wet: boolean) => ({ resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
      waterDepths: wet ? [5, 5, 5, 5] : [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] });
    const run = async (owned: ReturnType<typeof tile>, wet: boolean) => {
      bought.length = 0;
      const world = { roadGraph: base.roadGraph, ownedTiles: [owned] } as never;
      const builder = new DistrictBuilder({
        scanWorld: async () => world, listBuildings: async () => [],
        siteDetail: async (center) => ({ center, radius: 1, terrain: terrain(wet), roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }),
        purchaseTile: async (point) => { bought.push(`${point.x},${point.z}`); return { ok: true, detail: "purchased" }; },
      });
      const input = { demand: { residential: 50, commercial: 0, industrial: 0 }, zoneFor: () => "R", mayPurchaseLand: true };
      return { builder, input, first: await builder.runCycle(input) };
    };
    // Beside the network: bought. Then nothing more is bought until a district stands on it.
    const near = await run(tile(0, 0), false);
    expect(near.first.status).toBe("LAND_PURCHASED");
    const again = await near.builder.runCycle(near.input);
    expect(again.status).toBe("NO_SITE");
    expect(again.notes.join(" | ")).toMatch(/last has not yet held a district/);
    // Far from every street: not bought. Under water: not bought.
    const far = await run(tile(4000, 4000), false);
    expect(far.first.status).toBe("NO_SITE");
    expect(far.first.notes.join(" | ")).toMatch(/beyond a gateway's reach/);
    const wetLand = await run(tile(0, 0), true);
    expect(wetLand.first.status).toBe("NO_SITE");
    expect(wetLand.first.notes.join(" | ")).toMatch(/buildable/);
  });

  test("FAST_EXPANSION submits only the streets the game's dry run certifies, halves a refused one, and builds as before when the dry run fails", async () => {
    const built: string[] = [];
    const run = async (preflight: (course: { start: { x: number; z: number }; end: { x: number; z: number } }) => Promise<string>, pipelined: boolean) => {
      built.length = 0;
      const port: DistrictBuilderPort = {
        scanWorld: async () => servedWorld() as never, listBuildings: async () => [],
        siteDetail: async (center) => ({ center, radius: 1, terrain: undefined as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
        buildRoad: async (course) => { built.push(`${course.start.x},${course.start.z}>${course.end.x},${course.end.z}`); return { ok: true, detail: "ok" }; },
        zone: async () => ({ ok: true, detail: "ok" }), preflightRoad: async (course) => preflight(course),
      };
      return new DistrictBuilder(port, { maximumSitesPerCycle: 1 }).runCycle({ demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: () => "EU Residential Medium", ...(pipelined ? { pipelined: true } : {}) });
    };
    const refuseAll = await run(async () => "REJECT:operation blocked by game validation", true);
    // Every street refused by the dry run: nothing is built, and the notes say it was the dry run.
    expect(built).toHaveLength(0);
    expect(refuseAll.notes.join(" | ")).toMatch(/refused by the dry run/);
    expect(refuseAll.notes.join(" | ")).toMatch(/more refused by the dry run before any build|road pipeline/);
    // A dry run that errors decides nothing: the streets are built as before.
    await run(async () => { throw new Error("bridge busy"); }, true);
    expect(built.length).toBeGreaterThan(0);
    const certified = await run(async () => "OK", true);
    expect(built.length).toBeGreaterThan(0);
    // Not pipelined: the dry run is not consulted at all.
    let asked = 0;
    await run(async () => { asked += 1; return "REJECT:x"; }, false);
    expect(asked).toBe(0);
    expect(built.length).toBeGreaterThan(0);
    expect(certified.notes.join(" | ")).not.toMatch(/refused by the dry run/);
  });

  test("a free rectangle bigger than the treasury should pay for is built smaller inside, not skipped", () => {
    const world = servedWorld();
    const rectangle = { minX: 82.5, minZ: -2.5, widthMeters: 480, heightMeters: 200 };
    const uncapped = surveyDistrictSites({ world, buildings: [], rectangles: [rectangle] });
    expect(uncapped.length).toBeGreaterThan(0);
    // Whole 112 m blocks inside the rectangle: four across, one deep (the 40 m remainder is the gap filler's).
    expect(uncapped[0]!.widthMeters).toBe(448);
    expect(uncapped[0]!.heightMeters).toBe(112);
    // A tight treasury: the same ground still yields a district, sized to the cap.
    const capped = surveyDistrictSites({ world, buildings: [], rectangles: [rectangle], maximumAreaSquareMeters: 25_088 });
    expect(capped.length).toBeGreaterThan(0);
    for (const site of capped) expect(site.widthMeters * site.heightMeters).toBeLessThanOrEqual(25_088);
    expect(Math.max(...capped.map((site) => site.widthMeters * site.heightMeters))).toBe(25_088);
    // A cap too small for any district (under one block a side) still offers nothing.
    expect(surveyDistrictSites({ world, buildings: [], rectangles: [rectangle], maximumAreaSquareMeters: 10_000 })).toEqual([]);
  });
  test("a refused line is halved at a lattice point, down to one block", () => {
    const halves = splitCourse({ id: "v4", kind: "RING", start: { x: 0, z: 0 }, end: { x: 0, z: 400 }, lengthMeters: 400 });
    expect(halves.map((half) => half.end.z)).toEqual([200, 400]);
    expect(splitCourse({ id: "s", kind: "LOCAL", start: { x: 0, z: 0 }, end: { x: 0, z: 40 }, lengthMeters: 40 })).toEqual([]);
  });

  test("builds a whole district in one cycle and stops before laying anything when its gateway is refused", async () => {
    const writes: string[] = [];
    const port = (refuseGateway: boolean): DistrictBuilderPort => ({
      scanWorld: async () => servedWorld() as never,
      listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, terrain: undefined as never,
        roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async (course) => {
        writes.push(`road ${course.start.x},${course.start.z}`);
        return { ok: !refuseGateway, detail: refuseGateway ? "refused" : "ok" };
      },
      zone: async () => { writes.push("zone"); return { ok: true, detail: "ok" }; },
    });
    const refused = await new DistrictBuilder(port(true), { maximumSitesPerCycle: 1 })
      .runCycle({ demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: () => "EU Residential Medium" });
    expect(refused.status).toBe("NO_SITE");
    expect(writes.filter((write) => write === "zone")).toHaveLength(0);
    // One gateway attempt per pass of the survey (three passes: each refusal lets the next size down be offered).
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeLessThanOrEqual(3);
    expect(writes.every((write) => write.startsWith("road"))).toBe(true);
  });

  test("a founding district is offered only to a treasury that can pay for it, and a refusal is per shape", () => {
    const wide = servedWorld() as unknown as { roadGraph: unknown; ownedTiles: Array<{ bounds: { min: unknown; max: unknown } }> };
    const world = { roadGraph: wide.roadGraph, ownedTiles: [{ ...wide.ownedTiles[0]!, bounds: { min: { x: -100, z: -100 }, max: { x: 1400, z: 1000 } },
      polygon: [{ x: -100, z: -100 }, { x: 1400, z: -100 }, { x: 1400, z: 1000 }, { x: -100, z: 1000 }] }] } as never;
    const [founding] = surveyDistrictSites({ world, buildings: [] });
    // Eight blocks by five at the template's own 112 m street spacing.
    expect(founding!.widthMeters * founding!.heightMeters).toBe(896 * 560);
    const [capped] = surveyDistrictSites({ world, buildings: [], maximumAreaSquareMeters: 224_000 });
    expect(capped!.widthMeters * capped!.heightMeters).toBe(448 * 336);
    // The ground refusing the founding district at its corner leaves the smaller districts at that corner on offer.
    const refused = new Set([`${Math.round(founding!.anchor.x)},${Math.round(founding!.anchor.z)},896x560`]);
    const [next] = surveyDistrictSites({ world, buildings: [], excludedAnchors: refused });
    expect(`${next!.anchor.x},${next!.anchor.z},${next!.widthMeters}`).not.toBe(`${founding!.anchor.x},${founding!.anchor.z},${founding!.widthMeters}`);
    // Every founding anchor refused: the corner falls back to the next size down, never to nothing.
    const all = new Set(surveyDistrictSites({ world, buildings: [], limit: 200 }).map((site) => `${Math.round(site.anchor.x)},${Math.round(site.anchor.z)},${site.widthMeters}x${site.heightMeters}`));
    const [smaller] = surveyDistrictSites({ world, buildings: [], excludedAnchors: all, maximumAreaSquareMeters: 896 * 560 });
    expect(smaller).toBeDefined();
  });

  test("a utility shortage is answered once; the same reading next cycle waits for the city instead of placing again", async () => {
    let placed = 0;
    const world = servedWorld() as never;
    const builder = new DistrictBuilder({
      scanWorld: async () => world, listBuildings: async () => [{ position: { x: 100, z: 100 }, prefab: "EU_ResidentialLow01" }],
      siteDetail: async (centre) => ({ center: centre, radius: 1, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [], terrain: undefined }) as never,
      buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }),
      utilities: {
        listFacilities: async () => [], preflight: async () => true,
        place: async () => { placed += 1; return { ok: true, detail: "" }; },
        attached: async () => true,
      },
    });
    const first = await builder.repairUtilities({ kinds: ["electricity"], shortfalls: { electricity: 5 } });
    const second = await builder.repairUtilities({ kinds: ["electricity"], shortfalls: { electricity: 5 } });
    expect(first.placed).toHaveLength(1);
    expect(second.placed).toHaveLength(0);
    expect(second.notes.join(" ")).toMatch(/already attempted/);
    expect(placed).toBe(1);
  });

  describe("a utility repair waits in game time, not in cycles (a cycle is no longer a game hour)", () => {
    const HOUR = 262_144 / 24;
    /** A builder whose game clock the test drives; every repair call may place one facility. */
    const clockedBuilder = () => {
      const state = { frame: 1_000_000 as number | null, placed: 0 };
      const world = servedWorld() as never;
      const builder = new DistrictBuilder({
        scanWorld: async () => world, listBuildings: async () => [{ position: { x: 100, z: 100 }, prefab: "EU_ResidentialLow01" }],
        siteDetail: async (centre) => ({ center: centre, radius: 1, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [], terrain: undefined }) as never,
        buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }),
        readGameFrame: async () => state.frame,
        utilities: {
          listFacilities: async () => [], preflight: async () => true,
          place: async () => { state.placed += 1; return { ok: true, detail: "" }; },
          attached: async () => true,
        },
      });
      return { builder, state };
    };
    const repair = (builder: DistrictBuilder) => builder.repairUtilities({ kinds: ["electricity"], shortfalls: { electricity: 5 } });

    test("five more repair calls a few game minutes later still wait: the old 3-call cooldown would have ended", async () => {
      const { builder, state } = clockedBuilder();
      await repair(builder);
      for (let call = 0; call < 5; call += 1) {
        state.frame! += HOUR / 10;
        const again = await repair(builder);
        expect(again.placed).toHaveLength(0);
        expect(again.notes.join(" ")).toMatch(/already attempted/);
      }
      expect(state.placed).toBe(1);
    });

    test("control: after 3 game hours the same shortage is answered again", async () => {
      const { builder, state } = clockedBuilder();
      await repair(builder);
      state.frame! += 3 * HOUR + 1;
      const again = await repair(builder);
      expect(again.placed).toHaveLength(1);
      expect(state.placed).toBe(2);
    });

    test("with no readable game clock it counts calls as before (never forever, never zero)", async () => {
      const { builder, state } = clockedBuilder();
      state.frame = null;
      await repair(builder);
      const waiting = [await repair(builder), await repair(builder), await repair(builder)];
      expect(waiting.every((result) => result.placed.length === 0)).toBe(true);
      expect((await repair(builder)).placed).toHaveLength(1);
    });
  });

  test("the zoning brush never reaches a building: it shrinks to stop short of one and gives up when it cannot", () => {
    expect(safeBrushRadius({ x: 0, z: 0 }, [])).toBe(36);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 100, z: 0 }])).toBe(36);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 30, z: 0 }])).toBe(22);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 30, z: 0 }, { x: 0, z: 25 }])).toBe(17);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 15, z: 0 }])).toBeNull();
  });

  test("the zoning brush never reaches a building: it shrinks to stop short of one and gives up when it cannot", () => {
    expect(safeBrushRadius({ x: 0, z: 0 }, [])).toBe(36);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 100, z: 0 }])).toBe(36);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 30, z: 0 }])).toBe(22);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 30, z: 0 }, { x: 0, z: 25 }])).toBe(17);
    expect(safeBrushRadius({ x: 0, z: 0 }, [{ x: 15, z: 0 }])).toBeNull();
  });
});
