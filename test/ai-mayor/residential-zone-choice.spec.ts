import {
  availableZoneDomains,
  residentialZoneChoice,
  residentialZoneDemand,
  residentialZoneDensity,
  unlockedZoneCapabilities,
  zonePrefabForDomain,
} from "../../src/main/services/ai-mayor/action-candidates";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

// The catalogue as the live map exposes it (2026-10-03), in its own order.
const LIVE_ZONES = [
  { name: "Industrial Manufacturing", areaType: "Industrial", office: false, spawnableBuildingCount: 474 },
  { name: "EU Residential Low", areaType: "Residential", office: false, spawnableBuildingCount: 127 },
  { name: "NA Residential Low", areaType: "Residential", office: false, spawnableBuildingCount: 127 },
  { name: "EU Commercial Low", areaType: "Commercial", office: false, spawnableBuildingCount: 143 },
  { name: "Residential Low", areaType: "Residential", office: false, spawnableBuildingCount: 0 },
  { name: "Residential Medium", areaType: "Residential", office: false, spawnableBuildingCount: 0 },
  { name: "NA Residential Medium", areaType: "Residential", office: false, spawnableBuildingCount: 78 },
  { name: "EU Residential Medium Row", areaType: "Residential", office: false, spawnableBuildingCount: 44 },
  { name: "EU Residential Medium", areaType: "Residential", office: false, spawnableBuildingCount: 78 },
  { name: "Residential LowRent", areaType: "Residential", office: false, spawnableBuildingCount: 155 },
];
const snapshot = (residential: { low: number | null; medium: number | null; high: number | null }, zoneTypes = LIVE_ZONES) => ({
  demand: { residential, commercial: 0, industrial: 53, office: 100 },
  planningCatalog: { zoneTypes },
});

describe("residential zone choice", () => {
  test("reads densities from catalogue names", () => {
    expect(residentialZoneDensity("EU Residential Low")).toBe("low");
    expect(residentialZoneDensity("EU Residential Medium Row")).toBe("medium");
    expect(residentialZoneDensity("NA Residential High")).toBe("high");
    expect(residentialZoneDensity("Residential LowRent")).toBeNull();
  });

  test("lays the density the game wants, in the city's own theme, never a zone that grows nothing", () => {
    // Live: low 0 (vacant low houses), medium 100, high 100 (high is locked on this map).
    const live = snapshot({ low: 0, medium: 100, high: 100 });
    expect(zonePrefabForDomain(live, "residential")).toBe("EU Residential Medium");
    expect(residentialZoneDemand(live)).toBe(100);
  });

  test("the demand the policy reads is the demand of the zone it can actually lay", () => {
    const onlyLow = snapshot({ low: 0, medium: 100, high: 100 },
      LIVE_ZONES.filter((zone) => !/Medium/.test(zone.name)));
    expect(zonePrefabForDomain(onlyLow, "residential")).toBe("EU Residential Low");
    expect(residentialZoneDemand(onlyLow)).toBe(0);
    expect(compileLocalMayorState(onlyLow).demands.residential).toBe(0);
  });

  test("V2 P3: the densest unlocked density is laid even when the low-density bar is the taller one", () => {
    // The old rule laid whichever density's bar was tallest, which is why a 10k city was still laid in low density.
    expect(zonePrefabForDomain(snapshot({ low: 120, medium: 30, high: 0 }), "residential")).toBe("EU Residential Medium");
  });

  test("V2 P3: a demand bar only excludes a density, and only when it is exactly nil", () => {
    expect(zonePrefabForDomain(snapshot({ low: 100, medium: 0, high: 0 }), "residential")).toBe("EU Residential Low");
    expect(residentialZoneChoice(LIVE_ZONES, { low: 0, medium: 0, high: 0 })).toEqual({ zone: "EU Residential Medium", demand: 0 });
  });

  test("a catalogue without per-density demand lays the densest unlocked density", () => {
    const choice = residentialZoneChoice(LIVE_ZONES, {});
    expect(choice).toEqual({ zone: "EU Residential Medium", demand: null });
  });

  test("an unlocked high density is the default once the catalogue holds it", () => {
    const withHigh = [...LIVE_ZONES, { name: "EU Residential High", areaType: "Residential", office: false, spawnableBuildingCount: 78 }];
    expect(zonePrefabForDomain(snapshot({ low: 100, medium: 100, high: 100 }, withHigh), "residential")).toBe("EU Residential High");
  });

  test("the unlocked capabilities (stage signal) are read from the catalogue", () => {
    expect(unlockedZoneCapabilities(snapshot({ low: 0, medium: 0, high: 0 }))).toEqual({ densities: { low: true, medium: true, high: false }, office: false });
    const withOffice = [...LIVE_ZONES, { name: "Office Low", areaType: "Industrial", office: true, spawnableBuildingCount: 68 }];
    expect(unlockedZoneCapabilities(snapshot({ low: 0, medium: 0, high: 0 }, withOffice))?.office).toBe(true);
    expect(unlockedZoneCapabilities({})).toBeNull();
  });

  test("zone types that grow nothing are not available domains", () => {
    const empty = snapshot({ low: 0, medium: 100, high: 0 }, [
      { name: "Residential Medium", areaType: "Residential", office: false, spawnableBuildingCount: 0 },
      { name: "Industrial Manufacturing", areaType: "Industrial", office: false, spawnableBuildingCount: 474 },
    ]);
    expect(availableZoneDomains(empty)).toEqual(["industrial"]);
  });
});
