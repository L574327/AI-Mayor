import { scopeRoadAuthority } from "../../src/main/services/ai-mayor/v2/main-adapter";
import type { SpatialRoadEdge } from "../../src/main/services/ai-mayor/spatial/types";

const edge = (
  index: number,
  version: number,
  start: { x: number; z: number },
  end: { x: number; z: number } = { x: start.x + 100, z: start.z },
  overrides: Partial<SpatialRoadEdge> = {},
): SpatialRoadEdge => ({
  entity: { index, version },
  prefab: "Medium Road",
  native: true,
  startNode: { index: index + 10_000, version: 1 },
  endNode: { index: index + 10_001, version: 1 },
  start,
  end,
  length: Math.hypot(end.x - start.x, end.z - start.z),
  ...overrides,
});

/**
 * The authority a scoped utility plan builds against.
 *
 * A durable scope certifies roads by entity ref, and a ref names the generation
 * the ROAD was built in — so after a reload the same road is a different entity
 * and every recorded ref resolves to nothing. The approved contact is the
 * geometry that does survive, and it is the only thing a stale authority may be
 * rebuilt from. These cases pin that policy in both directions: same generation
 * is untouched, a single stale road is reacquired, and everything that cannot be
 * proved fails closed instead of quietly widening or narrowing the authority.
 */
describe("scoped utility road authority", () => {
  test("hands the planner the whole current-world road set when no road is certified", () => {
    const world = [edge(7, 1, { x: 0, z: 0 }), edge(9, 1, { x: 400, z: 0 })];

    const authority = scopeRoadAuthority({
      certifiedRoadRefs: [],
      approvedContact: { x: 0, z: 0 },
      currentWorldPlayerRoads: world,
    });

    expect(authority).toEqual(world);
  });

  test("keeps the certified authority exactly when the recorded refs resolve", () => {
    const certified = edge(7, 1, { x: 0, z: 0 });
    const world = [certified, edge(9, 1, { x: 400, z: 0 })];

    const authority = scopeRoadAuthority({
      certifiedRoadRefs: [{ index: 7, version: 1 }],
      approvedContact: { x: 0, z: 0 },
      currentWorldPlayerRoads: world,
    });

    // The recorded edge itself, not a copy: the same generation keeps the
    // certified authority byte-identical to what the durable scope recorded.
    expect(authority).toHaveLength(1);
    expect(authority[0]).toBe(certified);
  });

  test("reacquires a single stale certified road from the approved contact", () => {
    // The ref names the road in the generation the ROAD was built in. After the
    // reload the same road is the same index at a new version, so the recorded
    // ref resolves to nothing and only the contact can find it.
    const current = edge(18_760, 2, { x: 0, z: 0 });
    const world = [current, edge(45_636, 3, { x: 400, z: 0 })];

    const authority = scopeRoadAuthority({
      certifiedRoadRefs: [{ index: 18_760, version: 1 }],
      approvedContact: { x: 0, z: 0 },
      currentWorldPlayerRoads: world,
    });

    expect(authority).toEqual([current]);
  });

  test("reacquires from either endpoint of the approved contact", () => {
    const current = edge(18_760, 2, { x: 300, z: 90 }, { x: 0, z: 0 });

    const authority = scopeRoadAuthority({
      certifiedRoadRefs: [{ index: 18_760, version: 1 }],
      approvedContact: { x: 0, z: 0 },
      currentWorldPlayerRoads: [current],
    });

    expect(authority).toEqual([current]);
  });

  test("fails closed when a single stale certified road has no contact match", () => {
    expect(() =>
      scopeRoadAuthority({
        certifiedRoadRefs: [{ index: 18_760, version: 1 }],
        approvedContact: { x: 0, z: 0 },
        currentWorldPlayerRoads: [edge(45_636, 3, { x: 400, z: 0 })],
      }),
    ).toThrow("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  });

  test("fails closed when the approved contact is ambiguous", () => {
    expect(() =>
      scopeRoadAuthority({
        certifiedRoadRefs: [{ index: 18_760, version: 1 }],
        approvedContact: { x: 0, z: 0 },
        currentWorldPlayerRoads: [edge(45_636, 3, { x: 0, z: 0 }), edge(45_637, 1, { x: 0.1, z: 0 })],
      }),
    ).toThrow("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  });

  test("does not reacquire from a deleted road", () => {
    const live = edge(45_636, 3, { x: 0, z: 0 });
    expect(
      scopeRoadAuthority({
        certifiedRoadRefs: [{ index: 18_760, version: 1 }],
        approvedContact: { x: 0, z: 0 },
        currentWorldPlayerRoads: [edge(18_760, 2, { x: 0, z: 0 }, undefined, { deleted: true }), live],
      }),
    ).toEqual([live]);

    expect(() =>
      scopeRoadAuthority({
        certifiedRoadRefs: [{ index: 18_760, version: 1 }],
        approvedContact: { x: 0, z: 0 },
        currentWorldPlayerRoads: [edge(18_760, 2, { x: 0, z: 0 }, undefined, { deleted: true })],
      }),
    ).toThrow("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  });

  test("fails closed when a multi-road authority loses every road", () => {
    // One contact cannot rebuild a two-road authority, and picking whichever
    // road carries the contact would silently narrow what was certified.
    expect(() =>
      scopeRoadAuthority({
        certifiedRoadRefs: [{ index: 7, version: 1 }, { index: 9, version: 1 }],
        approvedContact: { x: 0, z: 0 },
        currentWorldPlayerRoads: [edge(7, 2, { x: 0, z: 0 }), edge(9, 2, { x: 400, z: 0 })],
      }),
    ).toThrow("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  });

  test("fails closed when a multi-road authority only partly resolves", () => {
    expect(() =>
      scopeRoadAuthority({
        certifiedRoadRefs: [{ index: 7, version: 1 }, { index: 9, version: 1 }],
        approvedContact: { x: 0, z: 0 },
        currentWorldPlayerRoads: [edge(7, 1, { x: 0, z: 0 }), edge(9, 2, { x: 400, z: 0 })],
      }),
    ).toThrow("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  });

  test("keeps a fully resolving multi-road authority in current-world order", () => {
    const first = edge(7, 1, { x: 0, z: 0 });
    const second = edge(9, 1, { x: 400, z: 0 });

    const authority = scopeRoadAuthority({
      certifiedRoadRefs: [{ index: 9, version: 1 }, { index: 7, version: 1 }],
      approvedContact: { x: 0, z: 0 },
      currentWorldPlayerRoads: [first, second],
    });

    expect(authority).toEqual([first, second]);
  });
});
