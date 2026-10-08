import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { boundedMemory, fileBuilderMemory, MEMORY_LIMITS, type BuilderMemory } from "../../src/main/services/ai-mayor/v2/builder-memory";
import { emptyMix, type ZoningMixSignals } from "../../src/main/services/ai-mayor/v2/zoning-mix";

const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
const nodes = Array.from({ length: 12 }, (_, i) => node(-300 + i * 60, 0, 100 + i));
const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
  start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
const world = { roadGraph: { nodes, edges }, ownedTiles: [] } as never;

/** The mix of the live city (2026-10-05): commercial 51% and office 60% empty. */
function liveMix(): ZoningMixSignals {
  const mix = emptyMix();
  mix.cells.commercial = { zoned: 22_142, empty: 11_298 } as never;
  mix.cells.office = { zoned: 7_504, empty: 4_530 } as never;
  mix.cells.residential = { zoned: 99_000, empty: 6_000 } as never;
  return mix;
}

describe("P3: zoning that stays undeveloped is withdrawn — only over-supplied uses, only wholly empty free spots", () => {
  function run(rowsAt: (point: { x: number; z: number }) => Array<{ zone: string; cells: number; occupied: number; empty: number }> | null, mix = liveMix()) {
    const painted: Array<{ zone: string; x: number; z: number; radius: number }> = [];
    const port: DistrictBuilderPort = {
      scanWorld: async () => world, listBuildings: async () => [],
      siteDetail: async (center, radius) => ({ center, radius, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async () => ({ ok: true, detail: "ok" }),
      zone: async (zone, center, radius) => { painted.push({ zone, x: center.x, z: center.z, radius }); return { ok: true, detail: "ok" }; },
      readZoningMix: async () => mix,
      readZoningAround: async (center) => rowsAt(center),
    };
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    return { painted, port, run: () => builder.runCycle({ demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null, pipelined: true, mayPurchaseLand: false,
      population: 13_000, finance: { treasury: 400_000, monthlyBalance: 500_000 } } as never) };
  }

  test("a free spot whose disk holds only empty commercial zoning is dezoned ('None'), at most twelve a pass, and the note says why", async () => {
    const { painted, run: go } = run(() => [{ zone: "EU Commercial Low", cells: 30, occupied: 0, empty: 30 }]);
    const result = await go();
    const dezoned = painted.filter((entry) => entry.zone === "None");
    expect(dezoned.length).toBeGreaterThan(0);
    expect(dezoned.length).toBeLessThanOrEqual(12);
    expect(result.notes.join(" | ")).toMatch(/stale zoning \(P3\): commercial, office stand over their empty share: \d+ free spot\(s\) dezoned/);
  });

  test("control: a building at the spot (the fresh read shows it) keeps the brush off it; empty homes zoning beside the stale one is never dezoned", async () => {
    // A block half built: the disk reads 12 occupied cells, and the fresh ground read shows a house right at the spot: every brush is dropped.
    const built = run(() => [{ zone: "EU Commercial Low", cells: 30, occupied: 12, empty: 18 }]);
    const originalDetail = built.port.siteDetail;
    built.port.siteDetail = async (center, radius, resolution, signal) => ({ ...(await originalDetail(center, radius, resolution, signal) as object),
      buildings: nodes.flatMap((n) => [{ position: { x: n.position.x, y: 0, z: 24 } }, { position: { x: n.position.x, y: 0, z: -24 } }, { position: { x: n.position.x - 30, y: 0, z: 24 } }, { position: { x: n.position.x - 30, y: 0, z: -24 } }]) }) as never;
    await built.run();
    expect(built.painted.filter((entry) => entry.zone === "None")).toHaveLength(0);
    const homes = run(() => [{ zone: "EU Commercial Low", cells: 20, occupied: 0, empty: 20 }, { zone: "EU Residential Low", cells: 10, occupied: 0, empty: 10 }]);
    await homes.run();
    expect(homes.painted.filter((entry) => entry.zone === "None")).toHaveLength(0);
  });

  test("control: a use that is not over-supplied (commercial 20% empty) is left alone, and an unreadable disk is not guessed", async () => {
    const calm = liveMix();
    calm.cells.commercial = { zoned: 22_000, empty: 4_400 } as never;
    calm.cells.office = { zoned: 7_500, empty: 1_000 } as never;
    const fine = run(() => [{ zone: "EU Commercial Low", cells: 30, occupied: 0, empty: 30 }], calm);
    await fine.run();
    expect(fine.painted.filter((entry) => entry.zone === "None")).toHaveLength(0);
    const unreadable = run(() => null);
    await unreadable.run();
    expect(unreadable.painted.filter((entry) => entry.zone === "None")).toHaveLength(0);
  });
});

describe("what the builder remembers across a restart of the run process (builder-memory)", () => {
  const file = path.join(os.tmpdir(), `builder-memory-${process.pid}.json`);
  afterAll(() => { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } });
  const memory: BuilderMemory = { key: "world-A", ownFacilities: [{ index: 5, version: 2, position: { x: 1, z: 2 }, prefab: "WaterPumpingStation01" }],
    zoned: [{ role: "industrial", rect: { minX: 0, minZ: 0, maxX: 160, maxZ: 720 } }], accessFailed: [{ position: { x: -1094, z: -537 }, radius: 90 }], signaturesStanding: ["EU_ResidentialLowSignature01"] };

  test("written whole, read back for the same world, ignored for another world, and bounded", () => {
    const store = fileBuilderMemory(file, "world-A");
    store.save(memory);
    expect(store.load()).toEqual(memory);
    expect(fileBuilderMemory(file, "world-B").load()).toBeNull();
    const big = { ...memory, ownFacilities: Array.from({ length: 1_000 }, (_, index) => ({ index, version: 1 })) };
    expect(boundedMemory(big).ownFacilities).toHaveLength(MEMORY_LIMITS.ownFacilities);
    expect(boundedMemory(big).ownFacilities.at(-1)!.index).toBe(999);
  });

  test("a builder started with the memory knows the pump it placed before the restart: it is taken down when it never gets a road, and its site is not offered again", async () => {
    const store = fileBuilderMemory(file, "world-A");
    store.save(memory);
    const removed: number[] = [];
    const a = nodes[0]!; const b = nodes[1]!;
    const streets = { roadGraph: { nodes: [a, b], edges: [edges[0]!] }, ownedTiles: [] } as never;
    const port: DistrictBuilderPort = {
      scanWorld: async () => streets, listBuildings: async () => [], siteDetail: async () => null, buildRoad: async () => ({ ok: true, detail: "ok" }), zone: async () => ({ ok: true, detail: "ok" }),
      preflightRoad: async () => "REJECT:operation blocked by game validation (overlap, water)",
      readIcons: async () => ({ counts: { "No Road Access": 1 }, items: [{ type: "No Road Access", x: -250, z: 40, entity: { index: 5, version: 2 }, prefab: "WaterPumpingStation01" }] }),
      findPrefabs: async () => [],
      utilities: { listFacilities: async () => [], preflight: async () => true, place: async () => ({ ok: true, detail: "" }), attached: async () => true,
        remove: async (target) => { removed.push(target.index); return true; } },
    };
    const builder = new DistrictBuilder(port, { memory: store, memoryKey: "world-A" });
    // Four rounds of failing repair (the pump has "got no road after 4 tries"), then it is taken down.
    for (let round = 0; round < 8; round += 1) await builder.provideServices(streets, { demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null } as never, []);
    expect(removed).toContain(5);
    // The site is remembered for the next restart too (written after each cycle).
    await builder.runCycle({ demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null } as never);
    expect(store.load()!.accessFailed.some((zone) => zone.position.x === 1 && zone.position.z === 2)).toBe(true);
  });
});
