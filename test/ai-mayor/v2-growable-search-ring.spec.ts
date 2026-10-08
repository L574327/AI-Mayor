import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../../src/main/services/ai-mayor/spatial/world-scanner";
import {
  growableSearchSubjectKey,
  mergeGrowableAbsenceReports,
  ringCenter,
  ringRadius,
  selectGrowableSearchAnchors,
  type GrowableFrontageAbsenceReport,
} from "../../src/main/services/ai-mayor/v2/site-selection";

/**
 * A world with one owned tile and a local road network described by `nodes`,
 * where node index N sits at `positions[N]` and consecutive nodes are joined by
 * a Small Road. This is the geometry the growable fast path censuses around.
 */
const worldOf = (positions: Array<[number, number]>) => {
  const nodes = positions.map(([x, z], index) => ({
    entity: { index: 10 + index, version: 1 }, position: { x, y: 0, z }, native: true,
    outsideConnection: false, roadDegree: 1,
  }));
  const edges = positions.slice(1).map(([x, z], index) => ({
    entity: { index: 20 + index, version: 1 }, prefab: "Small Road", native: true,
    startNode: { index: 10 + index, version: 1 }, endNode: { index: 11 + index, version: 1 },
    start: { x: positions[index]![0], z: positions[index]![1] }, end: { x, z },
    length: Math.hypot(x - positions[index]![0], z - positions[index]![1]),
  }));
  return buildSpatialWorldModel(parseSpatialBootstrapScan({
    world: { min: -2000, max: 2000, size: 4000 },
    tiles: [{ entity: { index: 1, version: 1 }, owned: true,
      bounds: { min: { x: -3000, z: -3000 }, max: { x: 3000, z: 3000 } }, center: { x: 0, z: 0 }, polygon: [] }],
    outsideConnections: [], bootstrapAssets: [],
    roadGraph: { truncated: false, nodes, edges },
  }));
};

const report = (over: Partial<GrowableFrontageAbsenceReport> = {}): GrowableFrontageAbsenceReport => ({
  reason: "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT",
  frontageCells: 0, unprotectedFootprints: 0, ownedFootprints: 0, ...over,
});

describe("growable census ring", () => {
  /**
   * The defect this ring exists to fix. The previous growable fast path read
   * exactly one region — the centroid of every owned local road node — and that
   * centre is a deterministic function of the road graph. A region the land had
   * already disproved was therefore re-derived identically on every later cycle
   * until the whole domain was parked, and the Brain reported no goal while
   * buildable land was still on the map.
   */
  it("offers more than one distinct region when the network has more than one end", () => {
    const world = worldOf([[0, 0], [400, 0], [800, 0], [1200, 0]]);
    const { anchors, ownedLocalRoadNodes } = selectGrowableSearchAnchors({
      world, maxAnchors: 8, separationMeters: 192,
    });
    expect(ownedLocalRoadNodes).toBe(4);
    expect(anchors.length).toBeGreaterThan(1);
    // Distinct geography, not samples of one place: every pair is at least one
    // census radius apart, so no two reads cover the same ground.
    for (const [index, anchor] of anchors.entries()) {
      for (const other of anchors.slice(index + 1)) {
        expect(Math.hypot(anchor.x - other.x, anchor.z - other.z)).toBeGreaterThanOrEqual(192);
      }
    }
  });

  it("reads the ends of the network before its interior", () => {
    // A chain: nodes 0 and 3 have one incident edge each, 1 and 2 have two. With
    // a separation small enough to keep them all, the two ends come first and
    // the interior follows — which is what makes the search expand outward
    // instead of oscillating inside the finished city.
    const world = worldOf([[0, 0], [400, 0], [800, 0], [1200, 0]]);
    const anchors = selectGrowableSearchAnchors({ world, maxAnchors: 8, separationMeters: 10 }).anchors;
    expect(anchors.slice(0, 2)).toEqual([{ x: 0, z: 0 }, { x: 1200, z: 0 }]);
    expect(anchors.slice(2).map((anchor) => anchor.x)).toEqual([400, 800]);
  });

  it("is deterministic, so an unchanged world re-reads the same anchors in the same order", () => {
    const world = worldOf([[0, 0], [400, 0], [800, 0]]);
    const first = selectGrowableSearchAnchors({ world, maxAnchors: 8, separationMeters: 192 }).anchors;
    const second = selectGrowableSearchAnchors({ world, maxAnchors: 8, separationMeters: 192 }).anchors;
    expect(second).toEqual(first);
  });

  it("honours the bound, and still reads somewhere when the whole network fits in one circle", () => {
    const world = worldOf([[0, 0], [400, 0], [800, 0], [1200, 0], [1600, 0]]);
    expect(selectGrowableSearchAnchors({ world, maxAnchors: 2, separationMeters: 192 }).anchors).toHaveLength(2);
    // Every node within one separation of the others: the ring collapses to the
    // first anchor offered — the network end — rather than to nothing. A search
    // that returned no anchors here would make admission refuse a world that has
    // land to build on.
    const tight = selectGrowableSearchAnchors({ world, maxAnchors: 4, separationMeters: 100_000 });
    expect(tight.anchors).toEqual([{ x: 0, z: 0 }]);
  });

  it("answers a directed Goal about its own ground first", () => {
    const world = worldOf([[0, 0], [400, 0], [800, 0]]);
    const anchors = selectGrowableSearchAnchors({
      world, targetPoint: { x: -900, z: -900 }, maxAnchors: 4, separationMeters: 192,
    }).anchors;
    expect(anchors[0]).toEqual({ x: -900, z: -900 });
  });

  it("offers nothing for a world with no owned local road, so the caller can refuse by name", () => {
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan({
      world: { min: -200, max: 200, size: 400 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } }, center: { x: 0, z: 0 }, polygon: [] }],
      outsideConnections: [], bootstrapAssets: [],
      roadGraph: {
        truncated: false,
        nodes: [{ entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 }],
        // A highway is not a local road and cannot seed a district.
        edges: [{ entity: { index: 20, version: 1 }, prefab: "Highway", native: true,
          startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 },
          start: { x: 0, z: 0 }, end: { x: 30, z: 0 }, length: 30 }],
      },
    }));
    expect(selectGrowableSearchAnchors({ world, maxAnchors: 8, separationMeters: 192 }).anchors).toEqual([]);
  });
});

/**
 * The roads the product built ARE the frontier.
 *
 * `native` is origin metadata, not authorization — the scan's own type says so
 * (`SpatialRoadEdge`: "Native is only origin metadata"). Measured live
 * (2026-10-02) on `cs2-session:d8413e4f…`: of 50 owned local edges, 8 are the
 * map's own and **42 are the Mayor's**, carrying 38 owned nodes. A ring that
 * required `native` could not see one of them, so a Road the product built could
 * never become the place it looked next and the loop "no frontage → build a road
 * → new frontage → build again" had nothing to stand on.
 */
describe("the growth ring sees the roads the product built", () => {
  const chainWorld = (over: { native?: boolean; prefab?: string; temp?: boolean; deleted?: boolean } = {}) => {
    const nodes = [0, 400, 800].map((x, index) => ({
      entity: { index: 10 + index, version: 1 }, position: { x, y: 0, z: 0 },
      native: over.native ?? true, outsideConnection: false, roadDegree: 1,
    }));
    const edges = [0, 400].map((x, index) => ({
      entity: { index: 20 + index, version: 1 }, prefab: over.prefab ?? "Small Road",
      native: over.native ?? true,
      ...(over.temp ? { temp: true } : {}),
      ...(over.deleted ? { deleted: true } : {}),
      startNode: { index: 10 + index, version: 1 }, endNode: { index: 11 + index, version: 1 },
      start: { x, z: 0 }, end: { x: x + 400, z: 0 }, length: 400,
    }));
    return buildSpatialWorldModel(parseSpatialBootstrapScan({
      world: { min: -2000, max: 2000, size: 4000 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -3000, z: -3000 }, max: { x: 3000, z: 3000 } }, center: { x: 0, z: 0 }, polygon: [] }],
      outsideConnections: [], bootstrapAssets: [],
      roadGraph: { truncated: false, nodes, edges },
    }));
  };

  it("reads a product-built road as an anchor when the catalogue can build its prefab", () => {
    const world = chainWorld({ native: false, prefab: "Medium Road" });
    const { anchors, ownedLocalRoadNodes } = selectGrowableSearchAnchors({
      world, maxAnchors: 8, separationMeters: 10,
      availableRoadPrefabs: ["Small Road", "Medium Road"],
    });
    // Ends first, then the interior — the same outward order the map's own
    // network gets, because the frontier is exactly those ends.
    expect(ownedLocalRoadNodes).toBe(3);
    expect(anchors).toEqual([{ x: 0, z: 0 }, { x: 800, z: 0 }, { x: 400, z: 0 }]);
  });

  it("still refuses a road the catalogue cannot build, so `native` was not simply dropped", () => {
    const world = chainWorld({ native: false, prefab: "Medium Road" });
    expect(selectGrowableSearchAnchors({
      world, maxAnchors: 8, separationMeters: 10, availableRoadPrefabs: ["Small Road"],
    }).anchors).toEqual([]);
  });

  it("keeps the pre-existing answer for a caller that passes no catalogue", () => {
    // A product-built road stays invisible without one, so no unconfigured
    // caller changes meaning by accident…
    expect(selectGrowableSearchAnchors({
      world: chainWorld({ native: false, prefab: "Medium Road" }), maxAnchors: 8, separationMeters: 10,
    }).anchors).toEqual([]);
    // …while a native road is read either way.
    expect(selectGrowableSearchAnchors({
      world: chainWorld({ native: true, prefab: "Medium Road" }), maxAnchors: 8, separationMeters: 10,
    }).anchors).toHaveLength(3);
  });

  it("still excludes temp and deleted roads however buildable their prefab", () => {
    const anchorsOf = (over: { temp?: boolean; deleted?: boolean }) => selectGrowableSearchAnchors({
      world: chainWorld({ native: false, prefab: "Medium Road", ...over }),
      maxAnchors: 8, separationMeters: 10, availableRoadPrefabs: ["Medium Road"],
    }).anchors;
    // A preview entity is not a road the city has…
    expect(anchorsOf({ temp: true })).toEqual([]);
    // …and neither is one the world has deleted.
    expect(anchorsOf({ deleted: true })).toEqual([]);
  });
});

describe("growable absence across a ring", () => {
  it("sums the ground the ring covered and reports the reason most anchors agreed on", () => {
    const merged = mergeGrowableAbsenceReports([
      report({ reason: "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION", frontageCells: 119, unprotectedFootprints: 4, ownedFootprints: 4 }),
      report({ reason: "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION", frontageCells: 40, unprotectedFootprints: 2, ownedFootprints: 2 }),
      report({ reason: "GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES", frontageCells: 7 }),
    ]);
    expect(merged.reason).toBe("GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION");
    expect(merged).toMatchObject({ frontageCells: 166, unprotectedFootprints: 6, ownedFootprints: 6 });
  });

  it("breaks a tie by the absence ladder, so the more specific finding wins", () => {
    const merged = mergeGrowableAbsenceReports([
      report({ reason: "GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES" }),
      report({ reason: "MISSING_FRONTAGE" }),
    ]);
    expect(merged.reason).toBe("MISSING_FRONTAGE");
  });

  it("never reports an empty ring as an absence", () => {
    // No anchor was readable at all is `unproven`, and the caller refuses on
    // that instead; this only has to not invent a reason.
    expect(mergeGrowableAbsenceReports([]).reason).toBe("FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT");
  });
});

describe("growable search identity", () => {
  /**
   * The property that makes the park self-releasing: the key is derived from the
   * ring the search read, so the Mayor's own next Road — which adds owned local
   * road nodes and therefore changes the ring — changes the key. A region parked
   * because a bounded search disproved it is reopened by the act of building
   * into it, and no other component has to remember to release it.
   */
  it("changes when the ring changes and holds when it does not", () => {
    const ring = [{ x: 0, z: 0 }, { x: 400, z: 0 }];
    const grown = [...ring, { x: 800, z: 0 }];
    expect(growableSearchSubjectKey(ring, "RESIDENTIAL")).toBe(growableSearchSubjectKey([...ring], "RESIDENTIAL"));
    expect(growableSearchSubjectKey(ring, "RESIDENTIAL")).not.toBe(growableSearchSubjectKey(grown, "RESIDENTIAL"));
    // Order is not part of the identity: the same geography is the same finding.
    expect(growableSearchSubjectKey(ring, "RESIDENTIAL"))
      .toBe(growableSearchSubjectKey([...ring].reverse(), "RESIDENTIAL"));
  });

  it("separates land uses and the unread part of the ring", () => {
    const ring = [{ x: 0, z: 0 }];
    expect(growableSearchSubjectKey(ring, "RESIDENTIAL")).not.toBe(growableSearchSubjectKey(ring, "INDUSTRIAL"));
    expect(growableSearchSubjectKey(ring, "RESIDENTIAL", 0))
      .not.toBe(growableSearchSubjectKey(ring, "RESIDENTIAL", 1));
  });

  it("encloses the whole ring in the target a refusal is reported against", () => {
    const anchors = [{ x: 0, z: 0 }, { x: 600, z: 0 }];
    expect(ringCenter(anchors)).toEqual({ x: 300, z: 0 });
    expect(ringRadius(anchors, 192)).toBe(492);
    expect(ringCenter([])).toEqual({ x: 0, z: 0 });
    expect(ringRadius([], 192)).toBe(192);
  });
});
