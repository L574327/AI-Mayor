/**
 * The demand levers that are not supply (the player, 2026-10-08: "taxes, and education buildings, if not hard — add them"): the tax lever of the jobs side and
 * the education need. Their evidence is the game's own: the demand factor "Taxes", and the jobs for the schooled that stand open (cs2_labor freeByEducation).
 */
import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { servicePrefabs, servicesWanted, serviceCap, withEducationGap, EDUCATION_JOBS_PER_NOTICE } from "../../src/main/services/ai-mayor/v2/district-services";
import { emptyMix } from "../../src/main/services/ai-mayor/v2/zoning-mix";

describe("education: the open jobs for the schooled are the evidence", () => {
  const heart = { x: 500, z: 100 };
  test("one notice for each ten open jobs for the schooled, at the heart of the city; fewer than thirty is not a need", () => {
    const some = withEducationGap({ counts: {}, items: [] }, { openHigh: 192, openMiddle: 6 }, heart);
    expect(some.counts["Education Gap (labour market)"]).toBe(Math.floor(198 / EDUCATION_JOBS_PER_NOTICE));
    expect(servicesWanted(some)).toEqual([{ need: "education", icons: 19 }]);
    expect(servicesWanted(withEducationGap({ counts: {}, items: [] }, { openHigh: 12, openMiddle: 6 }, heart))).toEqual([]);
    expect(withEducationGap({ counts: {}, items: [] }, null, heart).items).toHaveLength(0);
  });
  test("the schooling ladder: high school first, elementary next, college and university when unlocked; an extension is not a school", () => {
    expect(servicePrefabs("education", ["ElementarySchool01", "HighSchool02", "ElementarySchool02 Classroom Extension Building", "College01", "HighSchool01 Sports Field"]))
      .toEqual(["HighSchool02", "ElementarySchool01", "College01"]);
    expect(serviceCap("education", 15_000)).toBe(3);
  });
});

describe("education: the builder places the school the jobs ask for, and buys the college only when the open jobs stand in numbers", () => {
  const node = (x: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 2 });
  const nodes = Array.from({ length: 21 }, (_, i) => node(i * 40, 100 + i));
  const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
    start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
  const world = { roadGraph: { nodes, edges }, ownedTiles: [] } as never;

  function harness(gap: { openHigh: number; openMiddle: number }, unlocked: string[]) {
    const log = { placed: [] as string[], bought: [] as string[] };
    let standing = 0;
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, roadGraph: { nodes: [], edges: [] }, zoningCells: [], terrain: undefined, buildings: [] }) as never,
      buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }),
      readIcons: async () => ({ counts: {}, items: [] }),
      readEducationGap: async () => gap,
      findPrefabs: async (query) => unlocked.filter((name) => name.startsWith(query)).map((name) => ({ name, locked: false })),
      techTree: {
        read: async () => ({ points: 5, nodes: [{ name: "College node", service: "Education", serviceLocked: false, cost: 2, locked: true, requirements: [], purchasable: true, refusals: [] }] }),
        prefabLocks: async (prefabs) => prefabs.map((entry) => ({ prefab: entry.prefab, locked: true, requirements: [{ name: "College node", kind: "devTreeNode", locked: true, cost: 2, flags: "" }] })),
        purchase: async (name) => { log.bought.push(name); return { ok: true, detail: "" }; },
      },
      utilities: {
        listFacilities: async (prefab) => (/School/.test(prefab) ? Array.from({ length: standing }, (_, i) => ({ entity: { index: 900 + i, version: 1 }, position: { x: 400, z: 70 + i * 500 } })) : []),
        preflight: async () => true,
        place: async (prefab) => { log.placed.push(prefab); standing += 1; return { ok: true, detail: "" }; },
        attached: async () => null, remove: async () => true,
      },
    };
    const builder = new DistrictBuilder(port);
    const input = { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => "R", population: 15_000 };
    return { log, run: (notes: string[]) => builder.provideServices(world, input, notes) };
  }

  test("192 open jobs for the schooled: a high school is placed (and no college is bought below the number that asks for one)", async () => {
    const h = harness({ openHigh: 100, openMiddle: 10 }, ["HighSchool01", "ElementarySchool01"]);
    const notes: string[] = [];
    expect(await h.run(notes)).toBe(1);
    expect(h.log.placed).toEqual(["HighSchool01"]);
    expect(h.log.bought).toEqual([]);
    expect(notes.join(" | ")).toMatch(/service education: HighSchool01 .*stands/);
  });

  test("open jobs for the schooled at the college number: the college's development node is bought, once", async () => {
    const h = harness({ openHigh: 200, openMiddle: 0 }, ["HighSchool01"]);
    const notes: string[] = [];
    await h.run(notes);
    expect(h.log.bought).toEqual(["College node"]);
    expect(notes.join(" | ")).toMatch(/tech: bought College node/);
  });

  test("no open jobs for the schooled: no school", async () => {
    const h = harness({ openHigh: 0, openMiddle: 5 }, ["HighSchool01"]);
    expect(await h.run([])).toBe(0);
    expect(h.log.placed).toEqual([]);
  });
});

describe("tax: the jobs side, by the game's own factor", () => {
  const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
  const nodes = Array.from({ length: 6 }, (_, i) => node(i * 40, 0, 10 + i));
  const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 30 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
    start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
  const world = { roadGraph: { nodes, edges }, ownedTiles: [] } as never;

  function builder(rows: Record<string, { rate: number; penalty: number }>, writes: Array<[string, number]>) {
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, roadGraph: { nodes: [], edges: [] }, zoningCells: [], terrain: undefined, buildings: [] }) as never,
      buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }),
      readZoningMix: async () => emptyMix(),
      taxes: { read: async () => rows as never, set: async (area, rate) => { writes.push([area, rate]); return true; } },
    };
    return new DistrictBuilder(port);
  }
  const input = { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => "R", pipelined: true, population: 15_000, mayPurchaseLand: false,
    finance: { treasury: 400_000, monthlyBalance: 100_000 } };
  const run = (b: DistrictBuilder, notes: string[], over: Record<string, unknown> = {}) => (b as never as { runCycle(i: unknown): Promise<{ notes: string[] }> }).runCycle({ ...input, ...over }).then((r) => notes.push(...r.notes));

  test("the area the game says its tax holds down is lowered one point; one area, one point, and not again until the review time has passed", async () => {
    const writes: Array<[string, number]> = [];
    const b = builder({ Commercial: { rate: 10, penalty: 0 }, Industrial: { rate: 10, penalty: -30 }, Office: { rate: 10, penalty: -12 } }, writes);
    const notes: string[] = [];
    await run(b, notes);
    expect(writes).toEqual([["Industrial", 9]]);
    expect(notes.join(" | ")).toMatch(/industrial tax \(10%\) holds its demand down/);
    await run(b, notes);
    expect(writes).toHaveLength(1);
  });

  test("never under the floor, never while the city loses money, never when the player did not allow economic changes", async () => {
    const floor: Array<[string, number]> = [];
    await run(builder({ Office: { rate: 5, penalty: -40 } }, floor), []);
    expect(floor).toEqual([]);
    const bleeding: Array<[string, number]> = [];
    await run(builder({ Office: { rate: 10, penalty: -40 } }, bleeding), [], { finance: { treasury: 400_000, monthlyBalance: -1_000 } });
    expect(bleeding).toEqual([]);
    const before = process.env.AI_MAYOR_ALLOW_ECONOMY;
    process.env.AI_MAYOR_ALLOW_ECONOMY = "0";
    try {
      const refused: Array<[string, number]> = [];
      await run(builder({ Office: { rate: 10, penalty: -40 } }, refused), []);
      expect(refused).toEqual([]);
    } finally { if (before === undefined) delete process.env.AI_MAYOR_ALLOW_ECONOMY; else process.env.AI_MAYOR_ALLOW_ECONOMY = before; }
  });

  test("homes' tax is not a lever here: the port offers none, and a neutral factor changes nothing", async () => {
    const writes: Array<[string, number]> = [];
    await run(builder({ Commercial: { rate: 10, penalty: 0 }, Industrial: { rate: 10, penalty: 0 }, Office: { rate: 10, penalty: 0 } }, writes), []);
    expect(writes).toEqual([]);
  });
});
