import { districtUtilitySites, THERMAL_PLANT } from "../../src/main/services/ai-mayor/v2/district-utilities";
import { PLANT_MINIMUM_HOME_DISTANCE_METERS, plantSiteAllowed, plantSiteScore, prevailingWind } from "../../src/main/services/ai-mayor/v2/power-siting";

const terrainWith = (windX: number[] | undefined, windZ: number[] | undefined) => ({ resolution: 2, bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }, cellSize: { x: 1, z: 1 },
  heights: [0, 0, 0, 0], waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [0.3, 0.3, 0.3, 0.3], ...(windX ? { windX } : {}), ...(windZ ? { windZ } : {}) }) as never;

describe("a thermal power plant is sited downwind of the city and away from homes", () => {
  test("the wind is the mean vector of the read, normalised; none when the Bridge does not export it or the air is still", () => {
    const wind = prevailingWind(terrainWith([0.3, 0.3, 0.3, 0.3], [0, 0, 0, 0]));
    expect(wind?.x).toBeCloseTo(1);
    expect(wind?.z).toBeCloseTo(0);
    expect(prevailingWind(terrainWith(undefined, undefined))).toBeNull();
    expect(prevailingWind(terrainWith([0, 0, 0, 0], [0, 0, 0, 0]))).toBeNull();
  });

  test("a downwind site beats an upwind one however far the upwind one is from homes; homes too close rule a site out", () => {
    const city = { x: 0, z: 0 };
    const homes = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: -100, z: 0 }];
    const wind = { x: 1, z: 0, speed: 0.3 };
    const downwind = plantSiteScore({ x: 800, z: 0 }, { city, homes, wind });
    const upwind = plantSiteScore({ x: -1_000, z: 0 }, { city, homes, wind });
    expect(downwind).toBeGreaterThan(upwind);
    expect(plantSiteAllowed({ x: 200, z: 0 }, { city, homes })).toBe(false);
    expect(plantSiteAllowed({ x: 800, z: 0 }, { city, homes })).toBe(true);
    expect(PLANT_MINIMUM_HOME_DISTANCE_METERS).toBeGreaterThanOrEqual(300);
  });

  test("the planner offers plant sites far from homes, downwind first, instead of the lot nearest the load", () => {
    const node = (x: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z: 0 } });
    const nodes = Array.from({ length: 41 }, (_, i) => node(i * 40 - 400, 1 + i));
    const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 100 + i, version: 1 }, prefab: "Medium Road", startNode: n.entity, endNode: nodes[i + 1]!.entity,
      start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
    const homes = [{ x: -300, z: 40 }, { x: -260, z: 40 }, { x: -220, z: 40 }];
    const sites = districtUtilitySites({ kind: "electricity", target: { x: -260, z: 40 }, edges: edges as never, existingFacilities: [],
      terrain: terrainWith([0.3, 0.3, 0.3, 0.3], [0, 0, 0, 0]), plant: { city: { x: -260, z: 40 }, homes } });
    expect(sites.length).toBeGreaterThan(0);
    // Every offered site keeps the homes' distance, and the first lies downwind (east, +x) of the city.
    for (const site of sites) expect(Math.min(...homes.map((home) => Math.hypot(home.x - site.position.x, home.z - site.position.z)))).toBeGreaterThanOrEqual(PLANT_MINIMUM_HOME_DISTANCE_METERS);
    expect(sites[0]!.position.x).toBeGreaterThan(-260);
  });

  test("only fuel-burning plants count as thermal; a turbine, an extension or a locked name does not", () => {
    for (const name of ["SmallCoalPowerPlant01", "CoalPowerPlant01", "GasPowerPlant01"]) expect(THERMAL_PLANT.test(name)).toBe(true);
    for (const name of ["WindTurbine03", "CoalPowerPlant01 Coal Storage Yard", "NuclearPowerPlant01", "SolarPowerStation01"]) expect(THERMAL_PLANT.test(name)).toBe(false);
  });
});
