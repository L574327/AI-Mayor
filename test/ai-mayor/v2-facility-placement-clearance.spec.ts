import { facilityPlacementClearance } from "@/main/services/ai-mayor/v2/facility-placement-clearance";

const road = (x1: number, z1: number, x2: number, z2: number) => ({ start: { x: x1, z: z1 }, end: { x: x2, z: z2 } });

describe("facility placement clearance", () => {
  it("passes a site that reaches the road and stands clear of other facilities", () => {
    const verdict = facilityPlacementClearance({
      position: { x: 0, z: 30 },
      roads: [road(-100, 0, 100, 0)],
      existingFacilities: [{ position: { x: 400, z: 400 }, footprintRadiusMeters: 20 }],
      footprintRadiusMeters: 20,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.nearestRoadMeters).toBeCloseTo(30, 6);
  });

  it("refuses a site the service connection cannot reach", () => {
    const verdict = facilityPlacementClearance({
      position: { x: 0, z: 120 },
      roads: [road(-100, 0, 100, 0)],
      existingFacilities: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("NO_ROAD_IN_REACH");
    expect(verdict.nearestRoadMeters).toBeCloseTo(120, 6);
  });

  it("catches the two measured pumping stations that crowd one another", () => {
    // Live 2026-10-02: (1403.2,47.9) and (1409.2,-9.2), 57.5 m apart, and the
    // nearest road (a dead-end at 231898:125) is 49.0 m / 106.4 m away.
    const stations = { position: { x: 1403.2, z: 47.9 } };
    const roads = [road(1354.0, 47.9, 1403.0, 47.9)];
    const verdict = facilityPlacementClearance({
      position: stations.position,
      roads,
      existingFacilities: [{ position: { x: 1409.2, z: -9.2 }, footprintRadiusMeters: 20 }],
      footprintRadiusMeters: 20,
    });
    expect(verdict.violations).toContain("CROWDED_BY_FACILITY");
    expect(verdict.ok).toBe(false);
    expect(verdict.nearestFacilityMeters).toBeCloseTo(57.5, 0);
  });

  it("lets two facilities share a site when the aisle between footprints is wide enough", () => {
    const verdict = facilityPlacementClearance({
      position: { x: 0, z: 0 },
      roads: [road(-50, 0, 50, 0)],
      existingFacilities: [{ position: { x: 120, z: 0 }, footprintRadiusMeters: 20 }],
      footprintRadiusMeters: 20,
      accessClearanceMeters: 24,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.nearestFacilityMeters).toBeCloseTo(120, 6);
  });

  it("reports 'no road in reach' when the world read has no roads at all", () => {
    const verdict = facilityPlacementClearance({ position: { x: 0, z: 0 }, roads: [], existingFacilities: [] });
    expect(verdict.violations).toEqual(["NO_ROAD_IN_REACH"]);
    expect(verdict.nearestRoadMeters).toBe(Number.POSITIVE_INFINITY);
  });
});
