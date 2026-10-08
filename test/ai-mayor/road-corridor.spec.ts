import type { SpatialSiteDetail } from "../../src/main/services/ai-mayor/spatial/types";
import { planRoadCorridor, type CorridorGround } from "../../src/main/services/ai-mayor/spatial/road-corridor";

const RESOLUTION = 64;
const values = (value: number) => Array(RESOLUTION * RESOLUTION).fill(value);

/** A flat, dry, fully owned square the corridor may plan through. */
function flatSquare(minX: number, minZ: number, size: number, heights = values(10)): SpatialSiteDetail {
  return {
    center: { x: minX + size / 2, z: minZ + size / 2 },
    radius: size / 2,
    terrain: {
      resolution: RESOLUTION,
      bounds: { minX, minZ, maxX: minX + size, maxZ: minZ + size },
      cellSize: { x: size / RESOLUTION, z: size / RESOLUTION },
      heights, waterDepths: values(0), groundWater: values(0),
      groundWaterPollution: values(0), windSpeed: values(0),
    },
    buildings: [], zoningCells: [], roadGraph: { nodes: [], edges: [] },
  };
}

/** The sampler the search reads ground through, built from detail reads. */
const samplerOf = (observations: SpatialSiteDetail[]) => async (point: { x: number; z: number }): Promise<CorridorGround | null> => {
  const detail = observations.find((entry) =>
    point.x >= entry.terrain.bounds.minX && point.x <= entry.terrain.bounds.maxX &&
    point.z >= entry.terrain.bounds.minZ && point.z <= entry.terrain.bounds.maxZ);
  if (!detail) return null;
  const { resolution, bounds, cellSize } = detail.terrain;
  const col = Math.min(resolution - 1, Math.max(0, Math.floor((point.x - bounds.minX) / cellSize.x)));
  const row = Math.min(resolution - 1, Math.max(0, Math.floor((point.z - bounds.minZ) / cellSize.z)));
  const index = row * resolution + col;
  const height = detail.terrain.heights[index];
  if (!Number.isFinite(height)) return null;
  const neighbours = [col > 0 ? index - 1 : -1, col + 1 < resolution ? index + 1 : -1,
    row > 0 ? index - resolution : -1, row + 1 < resolution ? index + resolution : -1]
    .filter((neighbour) => neighbour >= 0);
  const spacing = Math.min(cellSize.x, cellSize.z);
  const gradePercent = neighbours.reduce((worst, neighbour) =>
    Math.max(worst, (Math.abs(height - detail.terrain.heights[neighbour]) / spacing) * 100), 0);
  return { height, waterDepth: detail.terrain.waterDepths[index] ?? 0, gradePercent };
};

const request = (observations: SpatialSiteDetail[], overrides: Partial<Parameters<typeof planRoadCorridor>[0]> = {}) => ({
  start: { x: 100, z: 100 },
  target: { x: 900, z: 100 },
  sampleGround: samplerOf(observations),
  isOwned: () => true,
  cellSizeMeters: 25,
  maximumLength: 2048,
  maximumSegmentLength: 1400,
  maximumGradePercent: 25,
  maximumDetourRatio: 2.5,
  maximumExpandedCells: 20_000,
  maximumSamples: 4_000,
  ...overrides,
});

describe("P4 road corridor route search", () => {
  /**
   * Which way a corridor leaves is only partly a planning question: native
   * certifies some exits at a junction and folds others by local topology the
   * planner cannot see. The planner's answer is to say which exits it would
   * accept, ordered by its own cost, and to re-plan from one of them - never to
   * bend a course or to hand the choice to a second planner.
   */
  it("lists its own exits at the start, ordered by its own cost", async () => {
    const plan = await planRoadCorridor(request([flatSquare(0, 0, 1000)]));
    expect(plan.status).toBe("PLANNED");
    // The eight neighbours at most, and every one of them is a real exit: the
    // bearings are the step the search itself would take.
    expect(plan.entrances.length).toBeGreaterThan(0);
    expect(plan.entrances.length).toBeLessThanOrEqual(8);
    expect([...plan.entrances].sort((left, right) => left.f - right.f)).toEqual(plan.entrances);
  });

  it("re-plans from a named exit, aiming the first hop without changing its reach", async () => {
    const observations = [flatSquare(0, 0, 1000)];
    const bearingOf = (segment: { start: { x: number; z: number }; end: { x: number; z: number } }) =>
      Math.atan2(segment.end.z - segment.start.z, segment.end.x - segment.start.x) * (180 / Math.PI);
    const since = (left: number, right: number) => Math.abs((((left - right) % 360) + 540) % 360 - 180);
    // Centred in the observed square, so an aim at the route's own reach stays
    // on ground whichever exit it names.
    const centred = { start: { x: 500, z: 500 }, target: { x: 900, z: 500 } };
    const own = await planRoadCorridor(request(observations, centred));
    // The best exit that is not the one the route took, in the planner's own
    // order - which is the order a caller certifies them in.
    const ownBearing = bearingOf(own.segments[0]!);
    const other = own.entrances.find((entrance) => since(entrance.bearingDegrees, ownBearing) > 5);
    expect(other).toBeDefined();
    const alternative = await planRoadCorridor(request(observations, { ...centred, firstStep: { col: other!.col, row: other!.row } }));

    expect(alternative.status).toBe("PLANNED");
    const hop = alternative.segments[0]!;
    // The hop leaves along the named exit, and keeps the reach the route itself
    // wanted - the alternative is this route under a different exit, not a
    // different course.
    expect(since(bearingOf(hop), other!.bearingDegrees)).toBeLessThan(0.5);
    expect(hop.length).toBeCloseTo(own.segments[0]!.length, 6);
    // And it still reaches the target: the leg back to the waypoint the route
    // already had is the corridor's first bend.
    expect(alternative.waypoints.at(-1)).toMatchObject({ x: own.waypoints.at(-1)!.x, z: own.waypoints.at(-1)!.z });
  });

  it("plans a complete route across flat ground and compiles bounded segments", async () => {
    const plan = await planRoadCorridor(request([flatSquare(0, 0, 1000)]));
    expect(plan.status).toBe("PLANNED");
    expect(plan.remaining).toBeLessThanOrEqual(40);
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.segments.every((segment) => segment.length <= 1400)).toBe(true);
    expect(plan.waypoints[0]).toMatchObject({ x: 100, z: 100, travelled: 0 });
    // A straight run does not come back as a staircase of hundreds of points.
    expect(plan.waypoints.length).toBeLessThan(10);
    expect(Number(plan.evidence.detourRatio)).toBeLessThan(1.4);
  });

  it("detours around water, accepting steps that are further from the target", async () => {
    const detail = flatSquare(0, 0, 1000);
    const depths = values(0);
    const { minX, minZ } = detail.terrain.bounds;
    const cell = detail.terrain.cellSize;
    for (let row = 0; row < RESOLUTION; row += 1) {
      for (let col = 0; col < RESOLUTION; col += 1) {
        const cellX = minX + (col + 0.5) * cell.x;
        const cellZ = minZ + (row + 0.5) * cell.z;
        if (cellX > 400 && cellX < 550 && cellZ > 50 && cellZ < 400) depths[row * RESOLUTION + col] = 5;
      }
    }
    detail.terrain = { ...detail.terrain, waterDepths: depths };
    const plan = await planRoadCorridor(request([detail]));
    expect(plan.status).toBe("PLANNED");
    // It went round: some waypoint stands well off the straight line.
    expect(plan.waypoints.some((waypoint) => Math.abs(waypoint.z - 100) > 25)).toBe(true);
    // And no waypoint is in the water it went round.
    const sampler = samplerOf([detail]);
    for (const waypoint of plan.waypoints) {
      const ground = await sampler({ x: waypoint.x, z: waypoint.z });
      expect(ground!.waterDepth).toBeLessThanOrEqual(0.05);
    }
    expect(plan.waypoints.length).toBeLessThan(20);
  });

  it("refuses when ground is unobserved, unowned, or too steep, and names which", async () => {
    // The target square was never read.
    const unobserved = await planRoadCorridor(request([flatSquare(0, 0, 400)]));
    expect(unobserved.status).toBe("NO_BOUNDED_CORRIDOR");
    expect(unobserved.reason).toMatch(/no legal corridor|sample budget/);

    const unowned = await planRoadCorridor(request([flatSquare(0, 0, 1000)], { isOwned: (point) => point.x < 300 }));
    expect(unowned.status).toBe("NO_BOUNDED_CORRIDOR");

    const steep = flatSquare(0, 0, 1000);
    const heights = values(10);
    for (let index = 0; index < heights.length; index += 1) heights[index] = index % 2 === 0 ? 10 : 40;
    steep.terrain = { ...steep.terrain, heights };
    expect((await planRoadCorridor(request([steep]))).status).toBe("NO_BOUNDED_CORRIDOR");
  });

  it("stops with a named reason when its own bounds are reached", async () => {
    // A ceiling shorter than the straight line cannot be satisfied.
    const length = await planRoadCorridor(request([flatSquare(0, 0, 1000)], { maximumLength: 300 }));
    expect(length.status).toBe("NO_BOUNDED_CORRIDOR");
    expect(length.reason.length).toBeGreaterThan(0);

    // A sample budget too small to see the route ends the search, and says so.
    const samples = await planRoadCorridor(request([flatSquare(0, 0, 1000)], { maximumSamples: 4 }));
    expect(samples.status).toBe("NO_BOUNDED_CORRIDOR");
    expect(samples.reason).toContain("sample budget");

    // A detour ceiling below the straight line is refused, not returned as a
    // slalom pretending to be a route.
    const detour = await planRoadCorridor(request([flatSquare(0, 0, 1000)], { maximumDetourRatio: 0.9 }));
    expect(detour.status).toBe("NO_BOUNDED_CORRIDOR");
    expect(detour.reason).toContain("detour ceiling");
  });

  it("says ALREADY_REACHED when the target is inside one cell", async () => {
    const plan = await planRoadCorridor(request([flatSquare(0, 0, 1000)], { target: { x: 110, z: 100 } }));
    expect(plan.status).toBe("ALREADY_REACHED");
    expect(plan.remaining).toBe(0);
  });

  it("is deterministic: the same world and request give the same route", async () => {
    const first = await planRoadCorridor(request([flatSquare(0, 0, 1000)]));
    const second = await planRoadCorridor(request([flatSquare(0, 0, 1000)]));
    expect(second.waypoints).toEqual(first.waypoints);
    expect(second.evidence).toEqual(first.evidence);
  });
});
