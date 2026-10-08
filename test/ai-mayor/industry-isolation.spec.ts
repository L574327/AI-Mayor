import {
  INDUSTRIAL_RESIDENTIAL_BUFFER_METERS, RESIDENTIAL_POLLUTER_BUFFER_METERS, surveyDistrictSites, type DistrictRole,
} from "../../src/main/services/ai-mayor/v2/district-builder";

/**
 * Live 2026-10-05: 127 noise notices. About 310 homes had grown within 320 m of industry on frontage zoned under another role, and 250 more inside
 * commercial districts: the isolation was only asked of a district whose role was "residential", but a commercial district zones homes too.
 */
const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
const nodes = Array.from({ length: 16 }, (_, i) => node(-300 + i * 40, 0, 100 + i));
const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
  start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -1200, z: -1200 }, max: { x: 1200, z: 1200 } }, center: { x: 0, z: 0 },
  polygon: [{ x: -1200, z: -1200 }, { x: 1200, z: -1200 }, { x: 1200, z: 1200 }, { x: -1200, z: 1200 }] };
const world = { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
const rectDistance = (point: { x: number; z: number }, site: { anchor: { x: number; z: number }; widthMeters: number; heightMeters: number }) => {
  const dx = Math.max(site.anchor.x - point.x, 0, point.x - (site.anchor.x + site.widthMeters));
  const dz = Math.max(site.anchor.z - point.z, 0, point.z - (site.anchor.z + site.heightMeters));
  return Math.hypot(dx, dz);
};

describe("isolation of industry and homes holds whatever role the district has", () => {
  const polluter = { x: 0, z: 0 };
  const sitesFor = (role: DistrictRole, landUse: { sensitive: Array<{ x: number; z: number }>; polluters: Array<{ x: number; z: number }> }) =>
    surveyDistrictSites({ world, buildings: [], role, landUse, limit: 40 } as never);

  test("a COMMERCIAL district (it zones homes too) is kept the polluter buffer away from industry, as a residential one is", () => {
    for (const role of ["residential", "commercial"] as const) {
      const sites = sitesFor(role, { sensitive: [], polluters: [polluter] });
      expect(sites.length).toBeGreaterThan(0);
      for (const site of sites) expect(rectDistance(polluter, site)).toBeGreaterThanOrEqual(RESIDENTIAL_POLLUTER_BUFFER_METERS);
    }
  });

  test("an INDUSTRIAL district is kept the industrial buffer (400 m) away from homes, unchanged", () => {
    const sites = sitesFor("industrial", { sensitive: [polluter], polluters: [] });
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(rectDistance(polluter, site)).toBeGreaterThanOrEqual(INDUSTRIAL_RESIDENTIAL_BUFFER_METERS);
  });

  test("control: with nothing to keep clear of, the sites are not pushed away (the buffer is the only thing that moves them)", () => {
    const free = sitesFor("commercial", { sensitive: [], polluters: [] });
    expect(free.some((site) => rectDistance(polluter, site) < RESIDENTIAL_POLLUTER_BUFFER_METERS)).toBe(true);
  });
});
