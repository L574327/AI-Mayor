import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import {
  centreMatchesIntent,
  districtIntentFrom,
  intentNamesAPlace,
  zoneForDensity,
  type DistrictIntent,
} from "../../src/main/services/ai-mayor/v2/district-intent";
import { DISTRICT_BUILDER_PRIMITIVES, planStructuredIntent } from "../../src/main/services/ai-mayor/v2/intent-primitive-map";
import type { MayorStructuredGoalIntent } from "../../src/main/services/ai-mayor/types";

const goal = (type: MayorStructuredGoalIntent["type"], scope?: MayorStructuredGoalIntent["scope"]): MayorStructuredGoalIntent =>
  ({ kind: "GOAL", type, ...(scope ? { scope } : {}), priority: "NORMAL" });

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false,
  outsideConnection: false, roadDegree: 2 });
type TestNode = ReturnType<typeof node>;
const edge = (a: TestNode, b: TestNode) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
  startNode: a.entity, endNode: b.entity, start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });

/** A served 22-street road along z = -62.5 and one big owned tile south of it. */
function world(bounds = { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } }) {
  const nodes: TestNode[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  for (let index = 0; index <= 22; index += 1) nodes.push(node(2.5 + index * 40, -62.5));
  for (let index = 0; index < 22; index += 1) edges.push(edge(nodes[index]!, nodes[index + 1]!));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds, center: { x: 500, z: 400 },
    polygon: [bounds.min, { x: bounds.max.x, z: bounds.min.z }, bounds.max, { x: bounds.min.x, z: bounds.max.z }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}

const detail = (center: { x: number; z: number }, wetShare: number | null = null, resolution = 64) => ({ center, radius: 1, roadGraph: { nodes: [], edges: [] }, buildings: [],
  zoningCells: [], terrain: wetShare === null && resolution !== 32 ? undefined : { resolution: 4, bounds: { minX: -5000, minZ: -5000, maxX: 5000, maxZ: 5000 },
    cellSize: { x: 2500, z: 2500 }, heights: new Array(16).fill(0), waterDepths: [wetShare ? 1 : 0, ...new Array(15).fill(0)], groundWater: [], groundWaterPollution: [], windSpeed: [] } }) as never;

describe("district intent: what the player asked for", () => {
  test("only district work maps to the builder; a service or a traffic fix stays on the Goal path", () => {
    expect(districtIntentFrom(goal("PROVIDE_SERVICE", { serviceKind: "WATER" }))).toBeNull();
    expect(districtIntentFrom(goal("IMPROVE_TRAFFIC"))).toBeNull();
    expect(districtIntentFrom(goal("EXPAND_COMMERCIAL", { density: "HIGH", acquireLand: true }))).toEqual({
      role: "commercial", region: "ANY", density: "HIGH", acquireLand: true, target: null, direction: null });
    expect(districtIntentFrom(goal("EXPAND_RESIDENTIAL", { region: "EDGE" }), { x: 900, z: 100 })?.target).toEqual({ x: 900, z: 100 });
    expect(districtIntentFrom(goal("EXPAND_RESIDENTIAL"), { x: Number.NaN, z: 0 })?.target).toBeNull();
  });

  test("region and map point decide where a district centre counts as 'there'", () => {
    const centre = { x: 0, z: 0 };
    const intent = (region: DistrictIntent["region"], target: DistrictIntent["target"] = null): DistrictIntent =>
      ({ role: "residential", region, density: null, acquireLand: false, target });
    expect(centreMatchesIntent({ x: 300, z: 0 }, intent("INFILL"), centre)).toBe(true);
    expect(centreMatchesIntent({ x: 800, z: 0 }, intent("INFILL"), centre)).toBe(false);
    expect(centreMatchesIntent({ x: 800, z: 0 }, intent("EDGE"), centre)).toBe(true);
    expect(centreMatchesIntent({ x: 800, z: 0 }, intent("FAR"), centre)).toBe(false);
    expect(centreMatchesIntent({ x: 1500, z: 0 }, intent("FAR"), centre)).toBe(true);
    expect(centreMatchesIntent({ x: 900, z: 0 }, intent("ANY", { x: 1000, z: 0 }), centre)).toBe(true);
    expect(centreMatchesIntent({ x: 100, z: 0 }, intent("ANY", { x: 1000, z: 0 }), centre)).toBe(false);
    expect(intentNamesAPlace(intent("ANY"))).toBe(false);
    expect(intentNamesAPlace(intent("NEAR_EXISTING"))).toBe(false);
    expect(intentNamesAPlace(intent("EDGE"))).toBe(true);
    expect(intentNamesAPlace(intent("ANY", { x: 1, z: 1 }))).toBe(true);
  });

  test("density picks the unlocked zone of that density, preferring the city's EU style", () => {
    const zones = [
      { name: "NA Residential Low", areaType: "Residential" }, { name: "EU Residential Low", areaType: "Residential" },
      { name: "EU Residential Medium", areaType: "Residential" }, { name: "Residential High", areaType: "Residential", locked: true },
      { name: "Commercial Low", areaType: "Commercial" }, { name: "Office Low", areaType: "Industrial", office: true },
    ];
    expect(zoneForDensity(zones, "residential", "LOW")).toBe("EU Residential Low");
    expect(zoneForDensity(zones, "residential", "MEDIUM")).toBe("EU Residential Medium");
    expect(zoneForDensity(zones, "residential", "HIGH")).toBeNull();
    expect(zoneForDensity(zones, "commercial", "LOW")).toBe("Commercial Low");
    expect(zoneForDensity(zones, "industrial", "LOW")).toBeNull();
    expect(zoneForDensity(undefined, "residential", "LOW")).toBeNull();
  });

  test("the builder carries out region, density and land purchase, so those are no longer gaps for district work", () => {
    const samples: Array<MayorStructuredGoalIntent> = [
      goal("EXPAND_RESIDENTIAL", { region: "WATERFRONT" }), goal("EXPAND_INDUSTRIAL", { region: "FAR" }),
      goal("EXPAND_RESIDENTIAL", { region: "INFILL" }), goal("EXPAND_RESIDENTIAL", { region: "EDGE" }),
      goal("EXPAND_COMMERCIAL", { density: "HIGH" }), goal("EXPAND_RESIDENTIAL", { acquireLand: true }),
    ];
    for (const intent of samples) {
      expect(planStructuredIntent(intent).executable).toBe(false);
      expect(planStructuredIntent(intent, DISTRICT_BUILDER_PRIMITIVES).executable).toBe(true);
    }
    // What the builder does not do stays a named gap.
    expect(planStructuredIntent(goal("EXPAND_RESIDENTIAL", { roadCharacter: "ORGANIC" }), DISTRICT_BUILDER_PRIMITIVES).gaps).toEqual(["CURVED_ROAD"]);
    expect(planStructuredIntent(goal("REDEVELOP_AREA"), DISTRICT_BUILDER_PRIMITIVES).gaps).toEqual(["DEMOLISH"]);
  });
});

describe("district builder under an intent", () => {
  const recorder = () => {
    const roads: Array<{ x: number; z: number }> = [];
    const zones: Array<{ zone: string; role?: string }> = [];
    const bought: string[] = [];
    const port = (w: unknown, wet: number | null = null): DistrictBuilderPort => ({
      scanWorld: async () => w as never,
      listBuildings: async () => [{ position: { x: 500, z: 0 }, prefab: "EU_ResidentialLow01" }],
      siteDetail: async (centre, _radius, resolution) => detail(centre, wet, resolution),
      buildRoad: async (course) => { roads.push({ ...course.start }); return { ok: true, detail: "" }; },
      zone: async (zone) => { zones.push({ zone }); return { ok: true, detail: "" }; },
      purchaseTile: async (point) => { bought.push(`${Math.round(point.x)},${Math.round(point.z)}`); return { ok: true, detail: "purchased" }; },
    });
    return { roads, zones, bought, port };
  };
  const input = (intent: DistrictIntent | undefined, extra: object = {}) => ({
    demand: { residential: 50, commercial: 0, industrial: 0 },
    zoneFor: (_role: string, density?: string) => (density ? `ZONE-${density}` : "ZONE-DEFAULT"),
    ...(intent ? { intent } : {}), ...extra,
  }) as never;
  const asked = (partial: Partial<DistrictIntent>): DistrictIntent =>
    ({ role: "residential", region: "ANY", density: null, acquireLand: false, target: null, ...partial });

  test("a named point puts the district at that end of the owned land", async () => {
    const east = recorder();
    await new DistrictBuilder(east.port(world()), { maximumSitesPerCycle: 1 }).runCycle(input(asked({ target: { x: 900, z: 400 } }), { maximumAreaSquareMeters: 224_000 }));
    const west = recorder();
    await new DistrictBuilder(west.port(world()), { maximumSitesPerCycle: 1 }).runCycle(input(asked({ target: { x: 0, z: 400 } }), { maximumAreaSquareMeters: 224_000 }));
    expect(east.roads[0]!.x).toBeGreaterThan(west.roads[0]!.x);
  });

  test("the asked density reaches the zone chosen for the brush", async () => {
    const r = recorder();
    // A refused-roads world paints nothing, so let the world 'land' every street by answering the readback with edges.
    const port = r.port(world());
    const landed: DistrictBuilderPort = { ...port,
      siteDetail: async (centre, radius, resolution) => {
        const base = await port.siteDetail(centre, radius, resolution);
        if (resolution !== 16) return base;
        const last = r.roads.at(-1);
        if (!last) return base;
        return { ...(base as object), roadGraph: { nodes: [], edges: [{ entity: { index: 1, version: 1 }, prefab: "Medium Road", native: false, deleted: false, temp: false,
          startNode: { index: 1, version: 1 }, endNode: { index: 2, version: 1 }, start: { x: last.x, z: last.z }, end: { x: last.x, z: last.z } }] } } as never;
      } };
    await new DistrictBuilder(landed, { maximumSitesPerCycle: 1 }).runCycle(input(asked({ density: "MEDIUM" })));
    for (const zone of r.zones) expect(zone.zone).toBe("ZONE-MEDIUM");
  });

  test("a place with no owned land is reported unmet, and nothing is bought unless land was asked for", async () => {
    // The only owned land lies west; the player wants the far east.
    const small = world({ min: { x: -100, z: -100 }, max: { x: 700, z: 500 } });
    const noPermission = recorder();
    const unmet = await new DistrictBuilder(noPermission.port(small)).runCycle(input(asked({ target: { x: 3000, z: 0 } }), { mayPurchaseLand: true }));
    expect(unmet.status).toBe("NO_SITE");
    expect(unmet.intentUnmet).toBe(true);
    expect(noPermission.bought).toEqual([]);
    expect(noPermission.roads).toEqual([]);
  });

  test("with leave to buy land it buys the neighbouring tile that lies in the asked place, and only that one", async () => {
    const tile = world({ min: { x: 0, z: 0 }, max: { x: 200, z: 200 } });
    const r = recorder();
    const result = await new DistrictBuilder(r.port(tile)).runCycle(
      input(asked({ target: { x: 300, z: 100 }, acquireLand: true }), { mayPurchaseLand: true }));
    expect(result.status).toBe("LAND_PURCHASED");
    expect(r.bought).toEqual(["300,100"]);
    // No tile lies near a point nowhere near the city: nothing is bought.
    const far = recorder();
    const none = await new DistrictBuilder(far.port(tile)).runCycle(
      input(asked({ target: { x: 5000, z: 5000 }, acquireLand: true }), { mayPurchaseLand: true }));
    expect(none.status).toBe("NO_SITE");
    expect(far.bought).toEqual([]);
  });

  test("a waterfront district needs water at its edge", async () => {
    const dry = recorder();
    const result = await new DistrictBuilder(dry.port(world(), 0), { maximumSitesPerCycle: 2 }).runCycle(input(asked({ region: "WATERFRONT" })));
    expect(dry.roads).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/no water at its edge/);
    // The same land with water at its edge is a waterfront district.
    const wet = recorder();
    await new DistrictBuilder(wet.port(world(), 1), { maximumSitesPerCycle: 1 }).runCycle(input(asked({ region: "WATERFRONT" })));
    expect(wet.roads.length).toBeGreaterThan(0);
  });
});




