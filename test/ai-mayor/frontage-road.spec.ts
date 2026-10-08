import type { SpatialLocalTerrain } from "../../src/main/services/ai-mayor/spatial/types";
import { FRONTAGE_HALF_ROAD_METERS, FRONTAGE_MARGIN_METERS, frontageCourses, maxGradePercent } from "../../src/main/services/ai-mayor/v2/frontage-road";

/** A square of land, 2 m cells, height given by a function of (x, z). */
function land(height: (x: number, z: number) => number, side = 400): SpatialLocalTerrain {
  const resolution = side / 2;
  const heights: number[] = [];
  for (let row = 0; row < resolution; row += 1) for (let column = 0; column < resolution; column += 1) heights.push(height(column * 2 - side / 2, row * 2 - side / 2));
  return { resolution, bounds: { minX: -side / 2, minZ: -side / 2, maxX: side / 2, maxZ: side / 2 }, cellSize: { x: 2, z: 2 }, heights,
    waterDepths: heights.map(() => 0), groundWater: heights.map(() => 0), groundWaterPollution: heights.map(() => 0), windSpeed: heights.map(() => 0) };
}

const centre = { x: 0, z: 40 };
const notice = { x: 0, z: 20 };       // the middle of the front edge, facing -z toward the street
const street = { x: 0, z: -40 };

describe("the frontage road: a way in that ends at the middle of the building's front and runs along it", () => {
  test("the road runs parallel to the front edge, pushed out by half a road width plus a margin, never into the building", () => {
    const [first] = frontageCourses({ centre, notice, street, terrain: land(() => 100) });
    expect(first!.reason).toMatch(/^frontage:straight/);
    const frontage = first!.segments.at(-1)!;
    // Parallel to the edge: the edge runs along x here, so the frontage road keeps one z, outside the lot.
    expect(frontage.start.z).toBeCloseTo(frontage.end.z, 6);
    expect(frontage.start.z).toBeCloseTo(notice.z - (FRONTAGE_HALF_ROAD_METERS + FRONTAGE_MARGIN_METERS), 6);
    expect(frontage.start.z).toBeLessThan(notice.z);
    // Centred on the middle of the edge.
    expect((frontage.start.x + frontage.end.x) / 2).toBeCloseTo(notice.x, 6);
    // It is reached from the street.
    expect(first!.segments[0]!.start).toEqual(street);
  });

  test("a big building's notices stand at every entrance: the run covers all of them, along the front, centred on them (live 2026-10-07: recycling centre, entrances z 256 / 319 / 377)", () => {
    // Centre (-419,300), front facing -x; the lot edge at x = -491; notices at three entrances, one of them far from the middle.
    const big = { x: -419, z: 300 };
    const first = { x: -487, z: 256 };
    const siblings = [{ x: -487, z: 319 }, { x: -487, z: 377 }];
    const courses = frontageCourses({ centre: big, notice: first, street: { x: -498, z: 297 }, siblings, terrain: land(() => 100, 1200) });
    const front = courses[0]!.segments.at(-1)!;
    // Runs along z (parallel to the front), outside the lot, from before the first entrance to past the last.
    expect(front.start.x).toBeCloseTo(front.end.x, 6);
    expect(front.start.x).toBeLessThan(-487);
    const low = Math.min(front.start.z, front.end.z); const high = Math.max(front.start.z, front.end.z);
    expect(low).toBeLessThanOrEqual(256);
    expect(high).toBeGreaterThanOrEqual(377);
    expect(high - low).toBeLessThanOrEqual(220);
    // 13 m out from the notices' line first (the game refused 11 m and accepted 13 m), and the narrow clearance is still offered, last.
    expect(front.start.x).toBeCloseTo(-487 - 13, 6);
    expect(courses.some((course) => course.segments.at(-1)!.start.x > -495)).toBe(true);
  });

  test("a street that ENDS 12 m in front of the notices anchors the run: both halves start at that very end (live 2026-10-07, third recycling centre)", () => {
    const big = { x: -2275, z: 677 };
    const notices = [{ x: -2207, z: 601 }, { x: -2207, z: 658 }, { x: -2207, z: 719 }];
    const end = { x: -2195, z: 677 };
    const courses = frontageCourses({ centre: big, notice: notices[0]!, siblings: notices.slice(1), street: end, terrain: land(() => 100, 1200) });
    expect(courses[0]!.reason).toBe("frontage:anchored-on-street-end");
    const segments = courses[0]!.segments;
    expect(segments).toHaveLength(2);
    for (const segment of segments) { expect(segment.end).toEqual(end); expect(segment.start.x).toBeCloseTo(-2195, 6); }
    const zs = segments.map((segment) => segment.start.z).sort((a, b) => a - b);
    expect(zs[0]).toBeLessThanOrEqual(601);
    expect(zs[1]).toBeGreaterThanOrEqual(719);
  });

  test("a street end 20 m out gets a stub from the lot's clear edge onto that end (live 2026-10-07, landfill 17-20 m from its road)", () => {
    const courses = frontageCourses({ centre: { x: -423, z: 97 }, notice: { x: -423, z: 37 }, street: { x: -411, z: 16.5 }, terrain: land(() => 100, 1200) });
    expect(courses[0]!.reason).toBe("frontage:stub-to-street-end");
    const piece = courses[0]!.segments[0]!;
    expect(piece.end).toEqual({ x: -411, z: 16.5 });
    expect(piece.start.z).toBeCloseTo(37 - 12.2, 6);
  });

  test("a lone notice keeps the short run", () => {    const courses = frontageCourses({ centre, notice, street, siblings: [], terrain: land(() => 100) });
    const front = courses[0]!.segments.at(-1)!;
    expect(Math.hypot(front.end.x - front.start.x, front.end.z - front.start.z)).toBeCloseTo(24, 6);
  });

  test("on flat ground the straight approach comes first and has no grade", () => {
    const courses = frontageCourses({ centre, notice, street, terrain: land(() => 100) });
    expect(courses[0]!.maxGradePercent).toBe(0);
    expect(courses[0]!.segments.length).toBeLessThanOrEqual(2);
  });

  test("a steep hill between the street and the building rules the straight approach out; a way round on gentler ground is offered", () => {
    // A ridge across the straight line (a rise of 30 m over 20 m near x = 0), flat beyond |x| > 30.
    const ridge = (x: number, z: number) => (Math.abs(x) < 12 && z > -30 && z < -10 ? 100 + (z + 30) * 1.5 : 100 + (Math.abs(x) < 12 && z >= -10 ? 30 : 0));
    const terrain = land(ridge);
    expect(maxGradePercent(terrain, street, { x: 0, z: 13 })).toBeGreaterThan(20);
    const courses = frontageCourses({ centre, notice, street, terrain, maximumGradePercent: 20 });
    expect(courses.length).toBeGreaterThan(0);
    expect(courses.every((course) => course.maxGradePercent === null || course.maxGradePercent <= 20)).toBe(true);
    expect(courses[0]!.reason).not.toMatch(/straight/);
    expect(courses[0]!.segments.length).toBeGreaterThanOrEqual(3);
  });

  test("when the slope cannot be read the course is still offered, after the ones whose slope is known good", () => {
    const small = land(() => 100, 40);
    const courses = frontageCourses({ centre: { x: 0, z: 400 }, notice: { x: 0, z: 380 }, street: { x: 0, z: 300 }, terrain: small });
    expect(courses.length).toBeGreaterThan(0);
    expect(courses.every((course) => course.maxGradePercent === null)).toBe(true);
  });

  test("a notice on the centre has no front and offers nothing", () => {
    expect(frontageCourses({ centre: notice, notice, street })).toEqual([]);
  });
});
