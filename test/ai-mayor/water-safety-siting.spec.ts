import { parseWaterFlowObservation, unavailableWaterFlowObservation, type WaterFlowObservation } from "../../src/main/services/ai-mayor/spatial/water-flow";
import { districtUtilitySites, realizeUtilityShortfall, terrainSampleAt, type DistrictUtilitiesPort } from "../../src/main/services/ai-mayor/v2/district-utilities";
import {
  nearOpenWater, outfallVerdict, pumpSiteSafe, selectCertifiedOutfalls, type WaterSafety,
} from "../../src/main/services/ai-mayor/v2/water-safety-siting";

/**
 * A river along z = 1550 (one 100 m cell wide), flowing east (+x) from x = 200 to its bank at x = 2700. Land everywhere else.
 * The pump and outlet rules are read against THIS world: which side of a pump an outlet may stand on is a fact of the flow, not of a distance.
 */
const RESOLUTION = 30;
const CELL = 100;
const inRiver = (x: number, z: number) => z >= 1500 && z < 1600 && x >= 200 && x < 2700;
function river(): WaterFlowObservation {
  const depths: number[] = []; const pollutions: number[] = []; const velocities: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < RESOLUTION; row += 1) for (let col = 0; col < RESOLUTION; col += 1) {
    const wet = inRiver(col * CELL + CELL / 2, row * CELL + CELL / 2);
    depths.push(wet ? 5 : 0); pollutions.push(0); velocities.push(wet ? { x: 5, y: 0 } : { x: 0, y: 0 });
  }
  return parseWaterFlowObservation({ resolution: RESOLUTION, cellSize: CELL, worldMin: 0, worldMax: RESOLUTION * CELL, waterDepths: depths, waterPollutions: pollutions, waterVelocities: velocities });
}
const depthAt = (point: { x: number; z: number }) => (inRiver(point.x, point.z) ? 5 : 0);
const bank = (x: number) => ({ x, z: 1640 });
const safetyWith = (intakes: WaterSafety["intakes"] = [], overrides: Partial<WaterSafety> = {}): WaterSafety => ({ observation: river(), intakes, intakesComplete: true, ...overrides });
const surfacePump = (x: number) => ({ prefab: "WaterPumpingStation01", position: bank(x) });

describe("where an outlet and a surface pump may stand together (Bible K39: the pollution must not reach the pump)", () => {
  describe("nearOpenWater", () => {
    test("a bank lot is beside open water; an inland lot, and a lot in the water itself, are not", () => {
      expect(nearOpenWater(bank(1000), depthAt)).toBe(true);
      expect(nearOpenWater({ x: 1000, z: 2600 }, depthAt)).toBe(false);
      expect(nearOpenWater({ x: 1000, z: 1550 }, depthAt)).toBe(false);
    });
  });

  describe("an outlet is certified against the intakes that stand", () => {
    test("control: with no intake at all every bank lot is certified", () => {
      const selection = selectCertifiedOutfalls([{ position: bank(500) }, { position: bank(2200) }], safetyWith(), depthAt);
      expect(selection.sites).toHaveLength(2);
    });
    test("a lot UPSTREAM of a surface pump is refused (its discharge flows to the pump); a lot DOWNSTREAM is certified", () => {
      const safety = safetyWith([surfacePump(1500)]);
      expect(outfallVerdict(bank(500), safety).certified).toBe(false);
      expect(outfallVerdict(bank(2200), safety).certified).toBe(true);
      const selection = selectCertifiedOutfalls([{ position: bank(500) }, { position: bank(2200) }], safety, depthAt);
      expect(selection.sites.map((site) => site.position.x)).toEqual([2200]);
      expect(Object.keys(selection.refusals).some((reason) => reason.startsWith("SEWAGE_DISCHARGE_REACHES_WATER_INTAKE"))).toBe(true);
    });
    test("control: a groundwater pump beside the river is not a river intake, so it blocks no outlet", () => {
      const safety = safetyWith([{ prefab: "GroundwaterPumpingStation01", position: bank(1500) }]);
      expect(outfallVerdict(bank(500), safety).certified).toBe(true);
    });
    test("fails closed: no usable flow, an incomplete intake listing or no listing at all places no outlet", () => {
      for (const safety of [null, safetyWith([], { observation: unavailableWaterFlowObservation() }), safetyWith([], { intakesComplete: false })]) {
        const selection = selectCertifiedOutfalls([{ position: bank(500) }], safety, depthAt);
        expect(selection.sites).toHaveLength(0);
        expect(Object.keys(selection.refusals)).toHaveLength(1);
      }
    });
    test("a lot with no open water near it is never an outlet site, however safe", () => {
      const selection = selectCertifiedOutfalls([{ position: { x: 1000, z: 2600 } }], safetyWith(), depthAt);
      expect(selection.sites).toHaveLength(0);
      expect(selection.refusals.NO_OPEN_WATER_NEAR_LOT).toBe(1);
    });
  });

  describe("a surface pump is kept out of every outlet's discharge, and may not take the last outlet site", () => {
    test("an outlet stands at x=500: a pump downstream of it is refused, a pump upstream of it is allowed", () => {
      const guard = { safety: safetyWith([]), existingOutlets: [bank(500)], outletOptions: null };
      const downstream = pumpSiteSafe(bank(1500), guard);
      expect(downstream.ok).toBe(false);
      expect(downstream.reason).toMatch(/discharge would reach it/);
      expect(pumpSiteSafe(bank(300), guard).ok).toBe(true);
    });
    test("no outlet stands yet and the only certified outlet site is at x=2200: a pump downstream of it would leave none, so it is refused", () => {
      const guard = { safety: safetyWith([]), existingOutlets: [], outletOptions: [bank(2200)] };
      const refused = pumpSiteSafe(bank(2500), guard);
      expect(refused.ok).toBe(false);
      expect(refused.reason).toMatch(/no certified outlet site would remain/);
      // Upstream of that site the pump leaves the outlet where it was.
      expect(pumpSiteSafe(bank(300), guard).ok).toBe(true);
    });
    test("control: nothing to protect (no outlet stands and none could be placed, or the options were not computed) never blocks a pump", () => {
      expect(pumpSiteSafe(bank(2500), { safety: safetyWith([]), existingOutlets: [], outletOptions: [] }).ok).toBe(true);
      expect(pumpSiteSafe(bank(2500), { safety: safetyWith([]), existingOutlets: [], outletOptions: null }).ok).toBe(true);
    });
    test("control: a flow that cannot be read never leaves a city without water: the pump is allowed", () => {
      const guard = { safety: safetyWith([], { observation: unavailableWaterFlowObservation() }), existingOutlets: [bank(500)], outletOptions: null };
      expect(pumpSiteSafe(bank(1500), guard).ok).toBe(true);
    });
  });

  describe("through the site search (a street along the south bank)", () => {
    const terrain = (() => {
      const resolution = 100; const size = 3000;
      const waterDepths: number[] = [];
      for (let row = 0; row < resolution; row += 1) for (let col = 0; col < resolution; col += 1) {
        waterDepths.push(inRiver((col + 0.5) * (size / resolution), (row + 0.5) * (size / resolution)) ? 5 : 0);
      }
      return { resolution, bounds: { minX: 0, minZ: 0, maxX: size, maxZ: size }, cellSize: { x: size / resolution, z: size / resolution },
        heights: new Array(resolution * resolution).fill(0), waterDepths, groundWater: new Array(resolution * resolution).fill(1),
        groundWaterPollution: new Array(resolution * resolution).fill(0), windSpeed: [] } as never;
    })();
    const edges = Array.from({ length: 25 }, (_, index) => ({ entity: { index: index + 1, version: 1 }, prefab: "Medium Road", native: false,
      startNode: { index: 100 + index, version: 1 }, endNode: { index: 101 + index, version: 1 },
      start: { x: index * 120, y: 0, z: 1650 }, end: { x: (index + 1) * 120, y: 0, z: 1650 } })) as never;
    // The street runs 50 m south of the river's bank, so the lots on its north side are beside the water and those on its south side are inland.
    const base = { target: { x: 1400, z: 1650 }, edges, existingFacilities: [], terrain };

    test("an outlet is offered only on lots beside the water, and (with a pump at x=1500) only downstream of it", () => {
      const sewage = districtUtilitySites({ ...base, kind: "sewage", sewageSafety: { safety: safetyWith([surfacePump(1500)]) } });
      expect(sewage.length).toBeGreaterThan(0);
      for (const site of sewage) {
        expect(terrainSampleAt(terrain, site.position)!.waterDepth).toBeLessThanOrEqual(0.05);
        expect(site.position.z).toBeLessThan(1650);
        expect(site.position.x).toBeGreaterThan(1500);
      }
    });
    test("control: without the water rules the same street offers lots at every setback, inland ones included", () => {
      const legacy = districtUtilitySites({ ...base, kind: "sewage" });
      expect(new Set(legacy.map((site) => site.setbackMeters)).size).toBeGreaterThan(1);
    });
    test("fail closed through the search: a flow that cannot be read offers no outlet lot at all", () => {
      const notes: string[] = [];
      expect(districtUtilitySites({ ...base, kind: "sewage", sewageSafety: { safety: null }, diagnostics: notes })).toHaveLength(0);
      expect(notes.join(" ")).toMatch(/SEWAGE_WATER_FLOW_OBSERVATION_UNAVAILABLE/);
    });
    describe("a street that runs far from the shore (no lot 20-50 m from it has water near it)", () => {
      const farEdges = Array.from({ length: 25 }, (_, index) => ({ entity: { index: 700 + index, version: 1 }, prefab: "Medium Road", native: false,
        startNode: { index: 800 + index, version: 1 }, endNode: { index: 801 + index, version: 1 },
        start: { x: index * 120, y: 0, z: 1860 }, end: { x: (index + 1) * 120, y: 0, z: 1860 } })) as never;
      const far = { target: { x: 1400, z: 1860 }, edges: farEdges, existingFacilities: [], terrain };
      test("the outlet is offered on shore lots a long setback from the street, none of them inland", () => {
        const sewage = districtUtilitySites({ ...far, kind: "sewage", sewageSafety: { safety: safetyWith() } });
        expect(sewage.length).toBeGreaterThan(0);
        for (const site of sewage) {
          expect(site.setbackMeters).toBeGreaterThanOrEqual(190);
          expect(nearOpenWater(site.position, depthAt)).toBe(true);
        }
      });
      test("control: with no flow reading no lot at all is offered (fail closed), and the water-blind siting keeps its short setbacks only", () => {
        expect(districtUtilitySites({ ...far, kind: "sewage", sewageSafety: { safety: null } })).toHaveLength(0);
        expect(Math.max(...districtUtilitySites({ ...far, kind: "sewage" }).map((site) => site.setbackMeters))).toBeLessThanOrEqual(50);
      });
    });    describe("a site that could not get a road is not offered again (live 2026-10-05: one pump placed and taken down at the same spot five times)", () => {
      test("no candidate within the excluded radius of a failed site is offered; the rest of the shore still is", () => {
        const all = districtUtilitySites({ ...base, kind: "sewage", sewageSafety: { safety: safetyWith() } });
        expect(all.length).toBeGreaterThan(2);
        const failed = all[0]!.position;
        const rest = districtUtilitySites({ ...base, kind: "sewage", sewageSafety: { safety: safetyWith() }, excludedAround: [{ position: failed, radius: 90 }] });
        expect(rest.length).toBeGreaterThan(0);
        for (const site of rest) expect(Math.hypot(site.position.x - failed.x, site.position.z - failed.z)).toBeGreaterThanOrEqual(90);
      });
    });
    describe("the deadlock: a pump takes the only river reach an outlet could use, and the outlet can then never be placed", () => {
      // A short street of three blocks (x 1400-1760) is all the connected network there is; the river flows east, so an outlet must stand WEST of
      // (upstream of) no pump: its discharge flows east, so the pump must be upstream of the outlet, i.e. further west.
      const shortEdges = [[1400, 1520], [1520, 1640], [1640, 1760]].map(([from, to], index) => ({ entity: { index: 900 + index, version: 1 }, prefab: "Medium Road",
        native: false, startNode: { index: 950 + index, version: 1 }, endNode: { index: 951 + index, version: 1 },
        start: { x: from, y: 0, z: 1650 }, end: { x: to, y: 0, z: 1650 } })) as never;
      const run = (waterReadsFlow: boolean) => {
        const standing = new Map<string, Array<{ entity: { index: number; version: number }; position: { x: number; z: number } }>>();
        let nextEntity = 1;
        const port = (withFlow: boolean): DistrictUtilitiesPort => ({
          listFacilities: async (prefab) => standing.get(prefab) ?? [],
          preflight: async () => true,
          place: async (prefab, point) => { const list = standing.get(prefab) ?? []; list.push({ entity: { index: nextEntity++, version: 1 }, position: { x: point.x, z: point.z } }); standing.set(prefab, list); return { ok: true, detail: "" }; },
          attached: async () => true,
          rankPrefabs: async (kind) => (kind === "water" ? ["WaterPumpingStation01"] : ["SewageOutlet01"]),
          ...(withFlow ? { readWaterSafety: async () => ({ observation: river(), intakesComplete: true,
            intakes: [...(standing.get("WaterPumpingStation01") ?? [])].map((item) => ({ prefab: "WaterPumpingStation01", position: item.position })) }) } : {}),
        });
        const input = (kind: "water" | "sewage") => ({ kind, shortfall: 1, target: { x: 1760, z: 1650 }, edges: shortEdges, terrain });
        return (async () => {
          const notes: string[] = [];
          // The pump is placed first (the repair does water before sewage), nearest the east end of the street where the district is.
          await realizeUtilityShortfall(port(waterReadsFlow), input("water"), notes);
          const sewage = await realizeUtilityShortfall(port(true), input("sewage"), notes);
          return { pump: standing.get("WaterPumpingStation01")?.[0]?.position ?? null, outlet: standing.get("SewageOutlet01")?.[0]?.position ?? null, sewage, notes };
        })();
      };

      test("without the rule the pump takes the east end, every outlet site is then upstream of it, and no outlet can ever be placed", async () => {
        const result = await run(false);
        expect(result.pump).not.toBeNull();
        expect(result.outlet).toBeNull();
      });
      test("with the rule the pump leaves an outlet site standing, and the outlet is placed downstream of it", async () => {
        const result = await run(true);
        expect(result.pump).not.toBeNull();
        expect(result.outlet).not.toBeNull();
        expect(result.outlet!.x).toBeGreaterThan(result.pump!.x);
      });
    });

    test("a surface pump is offered only upstream of an outlet that stands at x=1500", () => {
      const pumps = districtUtilitySites({ ...base, kind: "water", waterSource: "surface",
        pumpGuard: { safety: safetyWith([]), existingOutlets: [bank(1500)], outletOptions: null } });
      expect(pumps.length).toBeGreaterThan(0);
      for (const site of pumps) expect(site.position.x).toBeLessThan(1500);
    });
  });
});
