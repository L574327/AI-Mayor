import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";

const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 1 });
const world = (() => {
  const a = node(0, 0, 1); const b = node(0, 300, 2);
  return { roadGraph: { nodes: [a, b], edges: [{ entity: { index: 3, version: 1 }, prefab: "Medium Road", native: false, startNode: a.entity, endNode: b.entity,
    start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 300 } }] }, ownedTiles: [] } as never;
})();
const cycle = (builder: DistrictBuilder, notes: string[] = []) =>
  builder.provideServices(world, { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null }, notes);

/** Live 2026-10-05: 7 burned-down homes stood as ruins (the game names each one in its notice) while the zoned lots under them grew nothing. */
describe("a building the game marks burned down or condemned is taken down exactly, once, so its zoned lot grows a new one", () => {
  function run(items: Array<{ type: string; entity?: { index: number; version: number }; prefab?: string }>, refuse = false) {
    const removed: number[] = [];
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [], siteDetail: async () => null,
      buildRoad: async () => ({ ok: true, detail: "ok" }), zone: async () => ({ ok: true, detail: "ok" }),
      readIcons: async () => ({ counts: {}, items: items.map((item) => ({ x: 10, z: 10, ...item })) }),
      findPrefabs: async () => [],
      utilities: { listFacilities: async () => [], preflight: async () => true, place: async () => ({ ok: true, detail: "" }), attached: async () => true,
        remove: async (target) => { removed.push(target.index); return !refuse; } },
    };
    return { builder: new DistrictBuilder(port), removed };
  }
  const home = (index: number, type = "Burned Down") => ({ type, entity: { index, version: 1 }, prefab: "EU_ResidentialLow01_L2_2x3" });

  test("burned down, collapsed and condemned homes are taken down at their notice; at most eight a cycle", async () => {
    const { builder, removed } = run([home(1), home(2, "Condemned"), home(3, "Collapsed"), home(4), home(5), home(6), home(7), home(8), home(9), home(10)]);
    const notes: string[] = [];
    await cycle(builder, notes);
    expect(removed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(notes.join(" | ")).toMatch(/ruins: 8 of 8 burned down building\(s\) taken down at the notice \(10 stand\)/);
    // The next cycle takes the rest, and never the same building twice.
    await cycle(builder);
    expect(removed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("a ruin is not a player asset: it is taken down although the player's buildings are preserved (2026-10-06)", async () => {
    const previous = process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS;
    process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS = "1";
    try {
      const { builder, removed } = run([home(30, "Abandoned Collapsed")]);
      await cycle(builder);
      expect(removed).toEqual([30]);
    } finally {
      if (previous === undefined) delete process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS; else process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS = previous;
    }
  });

  test("control: a public service, a pump, a Signature building, a notice that names no building, and ordinary notices are left alone", async () => {
    const { builder, removed } = run([
      { type: "Burned Down", entity: { index: 10, version: 1 }, prefab: "Hospital01" },
      { type: "Burned Down", entity: { index: 11, version: 1 }, prefab: "WaterPumpingStation01" },
      { type: "Condemned", entity: { index: 12, version: 1 }, prefab: "EU_ResidentialLowSignature01" },
      { type: "Burned Down" },
      { type: "Noise Pollution", entity: { index: 13, version: 1 }, prefab: "EU_ResidentialLow01_L2_2x3" },
    ]);
    await cycle(builder);
    expect(removed).toEqual([]);
  });

  test("control: a demolition the game refuses is not asked again every cycle", async () => {
    const { builder, removed } = run([home(20)], true);
    await cycle(builder);
    await cycle(builder);
    expect(removed).toEqual([20]);
  });
});
