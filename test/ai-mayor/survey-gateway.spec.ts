import { surveyDistrictSites } from "../../src/main/services/ai-mayor/v2/district-builder";

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });

/** A served street along z = -62.5 (nodes every 40 m on the city's 2.5 / 17.5 lattice) and one big owned tile above it. */
function servedWorld() {
  const nodes = Array.from({ length: 23 }, (_, index) => node(2.5 + index * 40, -62.5));
  const edges = Array.from({ length: 22 }, (_, index) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
    startNode: nodes[index]!.entity, endNode: nodes[index + 1]!.entity,
    start: { x: nodes[index]!.position.x, y: 0, z: -62.5 }, end: { x: nodes[index + 1]!.position.x, y: 0, z: -62.5 } }));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } },
    center: { x: 500, z: 400 }, polygon: [] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

describe("survey: the entrance of a district", () => {
  const rectangle = { minX: 122.5, minZ: 17.5, widthMeters: 240, heightMeters: 240 };

  test("a free rectangle with a clear entrance is offered", () => {
    const sites = surveyDistrictSites({ world: servedWorld(), buildings: [], rectangles: [rectangle] });
    expect(sites).toHaveLength(1);
  });

  test("a building on the shortest entrance does not cost the district: the next entrance that runs clear of buildings is taken", () => {
    // Buildings stand in the strip between the street and the rectangle, on every straight 80 m entrance (the shortest ones).
    const buildings = Array.from({ length: 7 }, (_, index) => ({ x: 122.5 + index * 40, z: -22.5 }));
    const sites = surveyDistrictSites({ world: servedWorld(), buildings, rectangles: [rectangle] });
    expect(sites.length).toBeGreaterThan(0);
    const { from, to } = sites[0]!.gateway;
    const distanceToSegment = (point: { x: number; z: number }) => {
      const dx = to.x - from.x; const dz = to.z - from.z;
      const t = dx === 0 && dz === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.z - from.z) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(point.x - (from.x + t * dx), point.z - (from.z + t * dz));
    };
    for (const building of buildings) expect(distanceToSegment(building)).toBeGreaterThanOrEqual(10);
    expect(sites[0]!.gateway.lengthMeters).toBeGreaterThan(80);
  });

  describe("a district held away from homes still reaches the street the homes stand on", () => {
    // The only served street is the one the homes line (as after a city's first housing district). An industrial district must stand 400 m
    // from them, so its nearest entrance is 440 m long: past the 320 m cap that holds when nothing is kept away.
    const homes = Array.from({ length: 6 }, (_, index) => ({ x: 602.5 + index * 40, z: -22.5 }));
    const beyondTheBuffer = { minX: 122.5, minZ: 377.5, widthMeters: 240, heightMeters: 240 };
    const diagnostics = () => ({ noOwnedTiles: false, noServedRoadNetwork: false, considered: 0, excluded: 0,
      outsideOwnedLand: 0, buildingClearance: 0, landUseIsolation: 0, existingRoad: 0, noGateway: 0, blockedGateway: 0, eligible: 0,
      limitReached: false, offered: 0 });

    test("industry 400 m from the homes is offered, joined by an entrance through the buffer", () => {
      const sites = surveyDistrictSites({ world: servedWorld(), buildings: homes, rectangles: [beyondTheBuffer], role: "industrial",
        landUse: { sensitive: homes, polluters: [] } });
      expect(sites).toHaveLength(1);
      expect(sites[0]!.gateway.lengthMeters).toBeGreaterThan(320);
      expect(sites[0]!.gateway.lengthMeters).toBeLessThanOrEqual(480);
    });

    test("control: the same land with nothing to keep away from keeps the 320 m cap, so it is not offered", () => {
      const seen = diagnostics();
      expect(surveyDistrictSites({ world: servedWorld(), buildings: homes, rectangles: [beyondTheBuffer], role: "industrial",
        landUse: { sensitive: [], polluters: [] }, diagnostics: seen })).toHaveLength(0);
      expect(seen.noGateway).toBeGreaterThan(0);
    });

    test("control: the buffer itself still holds; industry closer than 400 m to a home is not offered", () => {
      const seen = diagnostics();
      const inside = { minX: 122.5, minZ: 257.5, widthMeters: 240, heightMeters: 240 };
      const near = [...homes, { x: 242.5, z: -22.5 }];
      expect(surveyDistrictSites({ world: servedWorld(), buildings: homes, rectangles: [inside], role: "industrial",
        landUse: { sensitive: near, polluters: [] }, diagnostics: seen })).toHaveLength(0);
      expect(seen.landUseIsolation).toBeGreaterThan(0);
    });
  });

  test("when every entrance runs through a building the district is not offered", () => {
    const buildings = Array.from({ length: 100 }, (_, index) => ({ x: -100 + index * 10, z: -22.5 }));
    const diagnostics = { noOwnedTiles: false, noServedRoadNetwork: false, considered: 0, excluded: 0,
      outsideOwnedLand: 0, buildingClearance: 0, landUseIsolation: 0, existingRoad: 0, noGateway: 0, blockedGateway: 0, offered: 0 };
    expect(surveyDistrictSites({ world: servedWorld(), buildings, rectangles: [rectangle], diagnostics })).toHaveLength(0);
    expect(diagnostics.blockedGateway).toBe(1);
    expect(diagnostics.buildingClearance).toBe(0);
  });
});
