import {
  MINIMUM_ACCESS_ROAD_METERS, selectFacilityAccessRoadCourse, shortAccessRoadCourseCandidates,
} from "../../src/main/services/ai-mayor/v2/facility-access-road";

/**
 * Live 2026-10-05 (the water pump on the shore at (-1094,-537)): the game's notice stood at the pump's front point (-1069.8,-537), 26 m from the street at
 * x = -1043.8; every course ending on that point was refused ("overlap, water") five times over, and the pump was taken down and placed again at the same
 * spot each time. The player joined it by hand with a 7.9 m road that stopped about 8 m before the point.
 */
const street = { x: -1043.8, z: -536.9 };
const point = { x: -1069.8, z: -536.9 };
const request = { objective: { start: street, end: point }, admittedCourse: { prefab: "", start: point, end: point }, facility: { position: { x: -1093.8, z: -536.9 }, halfExtent: 12 },
  facilityServicePoint: point, envelope: { center: point, radius: 86 }, prefab: "Small Road", maximumCandidates: 64 };
const candidates = shortAccessRoadCourseCandidates(request as never);
const lengthOf = (candidate: (typeof candidates)[number]) => { const a = candidate.actions[0] as { x1: number; z1: number; x2: number; z2: number }; return Math.hypot(a.x2 - a.x1, a.z2 - a.z1); };

describe("the short access road: a road that passes near a building's front joins it where one ending on the front point is refused", () => {
  test("short courses stop 8, 12 and 4 m before the service point, and keep the game's shortest street", () => {
    expect(candidates.map((candidate) => candidate.reason)).toEqual(["facility_access_road_short:8:reach:1", "facility_access_road_short:12:reach:1", "facility_access_road_short:4:reach:1"]);
    const eight = candidates[0]!.actions[0] as { x1: number; z1: number; x2: number; z2: number };
    expect(eight.x1).toBeCloseTo(street.x, 6);
    expect(eight.x2).toBeCloseTo(point.x + 8, 6);
    for (const candidate of candidates) expect(lengthOf(candidate)).toBeGreaterThanOrEqual(MINIMUM_ACCESS_ROAD_METERS);
  });

  test("a facility only 14 m from the street: only the courses that stay at least 8 m long are offered (the very short road the player had to draw)", () => {
    const near = shortAccessRoadCourseCandidates({ ...request, objective: { start: { x: -1083.8, z: -536.9 }, end: point } } as never);
    const shorts = near;
    expect(shorts.length).toBeGreaterThan(0);
    for (const entry of shorts) expect(lengthOf(entry)).toBeGreaterThanOrEqual(MINIMUM_ACCESS_ROAD_METERS);
    expect(shorts.some((entry) => entry.reason.includes(":12:"))).toBe(false);
  });

  test("the live case through the selector: the game refuses everything that ends on the point and accepts the short road, which is taken", async () => {
    const asked: string[] = [];
    const selection = await selectFacilityAccessRoadCourse({ candidates: [{ actions: [{ type: "build_road", prefab: "Small Road", x1: street.x, z1: street.z, x2: point.x, z2: point.z }], offsetFromAdmittedCourse: 0, reason: "facility_access_road_offset:0:reach:1" }, ...candidates], facilityServicePoint: point,
      preflight: async (candidate) => { asked.push(candidate.reason); return candidate.reason.startsWith("facility_access_road_short:8")
        ? { accepted: true, quote: 0 } : { accepted: false, quote: null, reason: "REJECT:operation blocked by game validation (overlap, water)" }; } });
    expect(selection.status).toBe("SELECTED");
    expect((selection as { candidate: { reason: string } }).candidate.reason).toBe("facility_access_road_short:8:reach:1");
    expect(asked[0]).toBe("facility_access_road_offset:0:reach:1");
  });
});
