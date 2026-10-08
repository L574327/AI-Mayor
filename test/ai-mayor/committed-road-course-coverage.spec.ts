import type { SpatialSiteDetail } from "../../src/main/services/ai-mayor/spatial/types";
import {
  COMMITTED_ROAD_COURSE_COVERAGE_TOLERANCE_METERS,
  committedRoadCourseCoverage,
} from "../../src/main/services/ai-mayor/v2/main-adapter";

const edge = (prefab: string, x1: number, z1: number, x2: number, z2: number) => ({
  entity: { index: 1, version: 1 },
  prefab,
  native: true,
  startNode: { index: 1, version: 1 },
  endNode: { index: 2, version: 1 },
  start: { x: x1, z: z1 },
  end: { x: x2, z: z2 },
  length: Math.hypot(x2 - x1, z2 - z1),
});

const roads = (...edges: ReturnType<typeof edge>[]): SpatialSiteDetail["roadGraph"] =>
  ({ nodes: [], edges: edges as SpatialSiteDetail["roadGraph"]["edges"] });

const course = (x1: number, z1: number, x2: number, z2: number) =>
  ({ prefab: "Medium Road", x1, z1, x2, z2 }) as Record<string, unknown>;

describe("committed road course coverage", () => {
  it("recognises a course the game split into several edges", () => {
    // A later road joined the middle, so the game split the committed course in
    // two. The edge identity is gone; the course is not.
    const coverage = committedRoadCourseCoverage({
      exactInput: course(0, 0, 100, 0),
      currentWorldRoads: roads(edge("Medium Road", 0, 0, 40, 0), edge("Medium Road", 40, 0, 100, 0)),
    });
    expect(coverage.covered).toBe(true);
    expect(coverage.evidence).toContain("every point of the committed course is still on a same-prefab road");
  });

  it("recognises a course the game merged into a longer collinear edge", () => {
    const coverage = committedRoadCourseCoverage({
      exactInput: course(20, 0, 60, 0),
      currentWorldRoads: roads(edge("Medium Road", 0, 0, 100, 0)),
    });
    expect(coverage.covered).toBe(true);
  });

  it("refuses a road that merely runs near the committed course", () => {
    // The same start node, a different heading: this is the neighbouring road
    // the committed one was absorbed by, and it is NOT the committed course.
    // Accepting it would be exactly the tolerance loosening the contract forbids.
    const coverage = committedRoadCourseCoverage({
      exactInput: course(0, 0, 36, 0),
      currentWorldRoads: roads(edge("Medium Road", 0, 0, 63, 29)),
    });
    expect(coverage.covered).toBe(false);
    expect(coverage.evidence).toContain("no longer on a same-prefab road");
  });

  it("refuses a chain of another prefab, and a chain that stops short", () => {
    expect(committedRoadCourseCoverage({
      exactInput: course(0, 0, 100, 0),
      currentWorldRoads: roads(edge("Small Road", 0, 0, 100, 0)),
    }).covered).toBe(false);
    expect(committedRoadCourseCoverage({
      exactInput: course(0, 0, 100, 0),
      currentWorldRoads: roads(edge("Medium Road", 0, 0, 60, 0)),
    }).covered).toBe(false);
  });

  it("fails closed when the current-world read is not available", () => {
    const coverage = committedRoadCourseCoverage({ exactInput: course(0, 0, 100, 0), currentWorldRoads: null });
    expect(coverage.covered).toBe(false);
    expect(coverage.evidence).toContain("not available");
  });

  it("reads the course back at the same node-snap tolerance the pipes use", () => {
    // A node snapped within the established current-world tolerance still counts.
    const nudged = COMMITTED_ROAD_COURSE_COVERAGE_TOLERANCE_METERS - 0.1;
    expect(committedRoadCourseCoverage({
      exactInput: course(0, 0, 100, 0),
      currentWorldRoads: roads(edge("Medium Road", nudged, 0, 100 + nudged, 0)),
    }).covered).toBe(true);
    // And a course that is off by more than a node snap does not.
    expect(committedRoadCourseCoverage({
      exactInput: course(0, 0, 100, 0),
      currentWorldRoads: roads(edge("Medium Road", nudged * 4, 0, 100 + nudged * 4, 0)),
    }).covered).toBe(false);
  });
});
