import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };

function world() {
  const nodes = Array.from({ length: 13 }, (_, index) => node(2.5 + index * 40, -62.5));
  const edges = Array.from({ length: 12 }, (_, index) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
    startNode: nodes[index]!.entity, endNode: nodes[index + 1]!.entity,
    start: { x: nodes[index]!.position.x, y: 0, z: -62.5 }, end: { x: nodes[index + 1]!.position.x, y: 0, z: -62.5 } }));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -300, z: -300 }, max: { x: 900, z: 900 } }, center: { x: 300, z: 300 },
    polygon: [{ x: -300, z: -300 }, { x: 900, z: -300 }, { x: 900, z: 900 }, { x: -300, z: 900 }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

/** `canPlace`: the sewage outlet has a legal, attached site; otherwise no lot the world offers can take it. */
function harness(canPlace: boolean) {
  const zones: string[] = [];
  const standing: Array<{ entity: { index: number; version: number }; position: { x: number; z: number } }> = [];
  const port: DistrictBuilderPort = {
    scanWorld: async () => world(), listBuildings: async () => [],
    siteDetail: async (center, radius) => ({ center, radius, terrain: dry as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
    readPlanningTerrain: async () => dry as never,
    buildRoad: async () => ({ ok: true, detail: "ok" }),
    zone: async (zone) => { zones.push(zone); return { ok: true, detail: "ok" }; },
    utilities: {
      listFacilities: async () => standing,
      preflight: async () => canPlace,
      place: async (_prefab, point) => { standing.push({ entity: { index: 50, version: 1 }, position: { x: point.x, z: point.z } }); return { ok: true, detail: "" }; },
      attached: async () => true,
    },
  };
  const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
  const cycle = () => builder.runCycle({ demand: { residential: 80, commercial: 0, industrial: 0 }, zoneFor: () => "EU Zone", pipelined: true, mayPurchaseLand: false,
    population: 0, criticalUtilityShortfalls: { sewage: 1 } } as never);
  return { cycle, zones, standing };
}

describe("a utility that no lot of the world can take does not hold the city's zoning (live 2026-10-05: sewage had no open water near any lot; 12 districts stood unzoned, nobody came)", () => {
  test("every candidate tried and none can stand: the zoning goes on at once and the note says why", async () => {
    const { cycle, zones } = harness(false);
    const first = await cycle();
    const notes = first.notes.join(" | ");
    expect(notes).toMatch(/sewage cannot be placed anywhere the world offers \(every candidate tried\); zoning goes on without waiting for it/);
    expect(notes).not.toMatch(/held back until the utilities answer/);
    expect(zones.every((zone) => typeof zone === "string")).toBe(true);
  });

  test("control: a utility that can stand is placed (the cycle ends there), not given up on", async () => {
    const { cycle, standing } = harness(true);
    const first = await cycle();
    expect(first.status).toBe("UTILITY_REPAIRED");
    expect(standing.length).toBeGreaterThan(0);
    expect(first.notes.join(" | ")).not.toMatch(/cannot be placed anywhere/);
  });
});
