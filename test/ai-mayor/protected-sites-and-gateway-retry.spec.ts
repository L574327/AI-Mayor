import { DistrictBuilder, surveyDistrictSites, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { ProtectionRegistry } from "../../src/main/services/ai-mayor/v2/protection";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
type TestNode = ReturnType<typeof node>;
const edge = (a: TestNode, b: TestNode) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
  startNode: a.entity, endNode: b.entity, start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });

/** A served street along z = -62.5 from x = 2.5 to 882.5, on owned land x -100..1100, z -100..900 (as in district-builder.spec). */
function servedWorld() {
  const nodes: TestNode[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  for (let index = 0; index <= 22; index += 1) nodes.push(node(2.5 + index * 40, -62.5));
  for (let index = 0; index < 22; index += 1) edges.push(edge(nodes[index]!, nodes[index + 1]!));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } },
    center: { x: 500, z: 400 }, polygon: [{ x: -100, z: -100 }, { x: 1100, z: -100 }, { x: 1100, z: 900 }, { x: -100, z: 900 }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

const oldTown = { name: "Old Town", source: "test", polygon: [{ x: -100, z: -20 }, { x: 560, z: -20 }, { x: 560, z: 900 }, { x: -100, z: 900 }] };

describe("protected areas in the planner, and another way in when the first is refused", () => {
  test("a rectangle is caught when it overlaps the area, reaches it within the margin, or holds it whole", () => {
    const registry = new ProtectionRegistry();
    registry.set([{ name: "Square", source: "test", polygon: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }] }]);
    expect(registry.rect(50, 50, 300, 300)?.name).toBe("Square");
    expect(registry.rect(-500, -500, 500, 500)?.name).toBe("Square");
    expect(registry.rect(20, 20, 40, 40)?.name).toBe("Square");
    expect(registry.rect(110, 0, 200, 100)).toBeNull();
    expect(registry.rect(110, 0, 200, 100, 12)?.name).toBe("Square");
  });

  test("the survey offers no site, and no way in, that reaches an area the player asked to keep — and still offers the free land beside it", () => {
    const registry = new ProtectionRegistry();
    registry.set([oldTown]);
    const diagnostics = { noOwnedTiles: false, noServedRoadNetwork: false, considered: 0, excluded: 0, outsideOwnedLand: 0, buildingClearance: 0,
      landUseIsolation: 0, existingRoad: 0, noGateway: 0, blockedGateway: 0, eligible: 0, limitReached: false, offered: 0 };
    const sites = surveyDistrictSites({ world: servedWorld(), buildings: [], protection: registry, diagnostics });
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(registry.rect(site.anchor.x, site.anchor.z, site.anchor.x + site.widthMeters, site.anchor.z + site.heightMeters, 12)).toBeNull();
      expect(registry.segment(site.gateway.from, site.gateway.to)).toBeNull();
      for (const option of site.alternativeGateways ?? []) expect(registry.segment(option.from, option.to)).toBeNull();
    }
    expect((diagnostics as { protectedArea?: number }).protectedArea ?? 0).toBeGreaterThan(0);
    // Without the area, the same land offers sites inside it.
    const free = surveyDistrictSites({ world: servedWorld(), buildings: [] });
    expect(free.some((site) => registry.rect(site.anchor.x, site.anchor.z, site.anchor.x + site.widthMeters, site.anchor.z + site.heightMeters, 12))).toBe(true);
  });

  function port(preflight: (course: { start: { x: number; z: number }; end: { x: number; z: number } }) => Promise<string>, built: string[]): DistrictBuilderPort {
    return {
      scanWorld: async () => servedWorld(), listBuildings: async () => [],
      siteDetail: async (center) => ({ center, radius: 1, terrain: undefined as never, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async (course) => { built.push(`${course.start.x},${course.start.z}>${course.end.x},${course.end.z}`); return { ok: true, detail: "ok" }; },
      zone: async () => ({ ok: true, detail: "ok" }), preflightRoad: async (course) => preflight(course),
    };
  }
  const input = { demand: { residential: 80, commercial: 30, industrial: 10 }, zoneFor: () => "EU Residential Medium", pipelined: true };

  test("the shortest way in refused by the dry run: the next one it certifies is laid, and the district is built around it", async () => {
    const built: string[] = [];
    let first: string | null = null;
    const result = await new DistrictBuilder(port(async (course) => {
      const key = `${course.start.x},${course.start.z}>${course.end.x},${course.end.z}`;
      first ??= key;
      return key === first ? "REJECT:operation blocked by game validation (overlap)" : "OK";
    }, built), { maximumSitesPerCycle: 1 }).runCycle(input as never);
    expect(result.notes.join(" | ")).toMatch(/gateway: the shortest way in was refused; another .* certified by the dry run after 1 try/);
    expect(built.length).toBeGreaterThan(1);
    expect(built).not.toContain(first);
  });

  test("a district whose streets the dry run mostly refuses is not started: no street laid only to be pruned again (live churn, 2026-10-06)", async () => {
    const built: string[] = [];
    let gatewayKey: string | null = null;
    const result = await new DistrictBuilder(port(async (course) => {
      const key = `${course.start.x},${course.start.z}>${course.end.x},${course.end.z}`;
      gatewayKey ??= key;
      // The way in passes; every street of the district (and every half of one) is refused.
      return key === gatewayKey ? "OK" : "REJECT:operation blocked by game validation (water)";
    }, built), { maximumSitesPerCycle: 1 }).runCycle(input as never);
    expect(built).toHaveLength(0);
    expect(result.notes.join(" | ")).toMatch(/the dry run certifies \d+% of its street length \(\d+ asked\), below the 60% a district needs — nothing laid/);
  });

  test("when no other way in is certified, it says so and lays nothing", async () => {
    const built: string[] = [];
    let asked = 0;
    const result = await new DistrictBuilder(port(async () => { asked += 1; return "REJECT:overlap"; }, built), { maximumSitesPerCycle: 1 }).runCycle(input as never);
    expect(built).toHaveLength(0);
    expect(result.notes.join(" | ")).toMatch(/gateway: \d+ other way\(s\) in put to the dry run, none certified/);
    // Each site tried (one per survey pass, at most three passes): its own gateway plus at most six others.
    const sitesTried = (result.notes.join(" | ").match(/none certified/g) ?? []).length;
    expect(sitesTried).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(7 * sitesTried);
  });
});
