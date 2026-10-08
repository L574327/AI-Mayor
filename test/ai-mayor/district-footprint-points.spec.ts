import { DISTRICT_FOOTPRINT_POINT_SPACING_METERS, districtFootprintPoints } from "../../src/main/services/ai-mayor/v2/district-builder";

const distanceToNearestPoint = (points: Array<{ x: number; z: number }>, at: { x: number; z: number }) =>
  Math.min(...points.map((point) => Math.hypot(point.x - at.x, point.z - at.z)));

describe("a zoned district stands for its whole footprint in the isolation rule (live 2026-10-05: industry laid 320 m from a housing district's long side, rule 400 m)", () => {
  // The live housing district: 160 x 720 m, known only by its four corners and centre before.
  const rect = { minX: -600, minZ: -400, maxX: -440, maxZ: 320 };
  const points = districtFootprintPoints(rect);

  test("no place on the footprint is farther than the spacing from a point", () => {
    for (const at of [{ x: -440, z: -40 }, { x: -520, z: -40 }, { x: -600, z: 200 }, { x: -500, z: 0 }]) {
      expect(distanceToNearestPoint(points, at)).toBeLessThanOrEqual(DISTRICT_FOOTPRINT_POINT_SPACING_METERS);
    }
  });

  test("the point nearest an industrial site beside the long side is on that side (320 m away), not a corner 400 m away", () => {
    const industrial = { x: -120, z: -40 };
    expect(Math.min(...points.map((point) => Math.hypot(point.x - industrial.x, point.z - industrial.z)))).toBeLessThan(400);
    expect(Math.min(...points.map((point) => Math.hypot(point.x - industrial.x, point.z - industrial.z)))).toBeGreaterThanOrEqual(320 - 1);
  });

  test("control: a small district and a degenerate one still give points, corners included, and no more than needed", () => {
    const small = districtFootprintPoints({ minX: 0, minZ: 0, maxX: 40, maxZ: 40 });
    expect(small).toHaveLength(4);
    expect(small).toContainEqual({ x: 0, z: 0 });
    expect(small).toContainEqual({ x: 40, z: 40 });
    expect(districtFootprintPoints({ minX: 5, minZ: 5, maxX: 5, maxZ: 5 }).length).toBeGreaterThan(0);
    expect(points.length).toBeLessThan(200);
  });
});
