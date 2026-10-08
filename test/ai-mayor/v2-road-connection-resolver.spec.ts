import { classifyNativeRoadPreviewFailure } from "../../src/main/services/ai-mayor/v2/runtime-road-caller";
import {
  MAXIMUM_BOUNDED_ROAD_CANDIDATES,
  nearCollinearIncidentCorridor,
  resolveBoundedRoadCandidates,
  sharedRoadGridReference,
  type RoadResolverInput,
} from "../../src/main/services/ai-mayor/v2/road-connection-resolver";
import {
  MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  bridgeDomainNetSegmentLength,
  isBridgeDomainNetSegmentLengthValid,
  minimumBridgeDomainEndpoint,
} from "../../src/main/services/ai-mayor/v2/road-contract";

const tile = {
  entity: { index: 1, version: 1 },
  owned: true,
  bounds: { min: { x: -250, z: -250 }, max: { x: 250, z: 250 } },
  center: { x: 0, z: 0 },
  polygon: [],
};
const node = (index: number, position: { x: number; z: number }, roadDegree = 1) => ({
  entity: { index, version: 1 },
  position: { ...position, y: 0 },
  native: true,
  outsideConnection: false,
  roadDegree,
});
const edge = (
  index: number,
  startNode: number,
  endNode: number,
  start: { x: number; z: number },
  end: { x: number; z: number },
  native = true,
) => ({
  entity: { index, version: 1 },
  prefab: "Small Road",
  native,
  startNode: { index: startNode, version: 1 },
  endNode: { index: endNode, version: 1 },
  start,
  end,
  length: Math.hypot(end.x - start.x, end.z - start.z),
});
const base = (overrides: Partial<RoadResolverInput> = {}): RoadResolverInput => ({
  siteTarget: { x: 20, z: 0 },
  reservation: { center: { x: 20, z: 0 }, radius: 40 },
  planningEnvelope: { center: { x: 20, z: 0 }, radius: 100 },
  sourceEdges: [
    edge(1, 100, 101, { x: 0, z: 0 }, { x: 200, z: 100 }),
    edge(2, 100, 102, { x: 0, z: 0 }, { x: 200, z: -100 }),
  ],
  sourceNodes: [
    node(100, { x: 0, z: 0 }, 2),
    node(101, { x: 200, z: 100 }),
    node(102, { x: 200, z: -100 }),
  ],
  ownedTiles: [tile],
  maxSourceDistance: 50,
  ...overrides,
});
const distanceForTest = (left: { x: number; z: number }, right: { x: number; z: number }) =>
  Math.hypot(left.x - right.x, left.z - right.z);

describe("bounded deterministic Gate 1 RoadConnection contract", () => {
  test("derives one stable orthogonal grid reference from the earliest ordinary road", () => {
    const first = edge(1, 100, 101, { x: 4, z: 8 }, { x: 104, z: 8 });
    const later = edge(30, 101, 102, { x: 104, z: 8 }, { x: 104, z: 72 });
    const initial = sharedRoadGridReference([first]);
    const afterAdjacentGoal = sharedRoadGridReference([first, later]);
    expect(initial).toEqual({ origin: { x: 4, z: 8 }, orientationRadians: 0, spacingMeters: 40, sourceEdgeRef: first.entity });
    expect(afterAdjacentGoal).toEqual(initial);
  });

  test("offers orthogonal grid geometry in the ordinary candidate family and retains free corridors", () => {
    const source = edge(1, 100, 101, { x: 0, z: 0 }, { x: 200, z: 0 });
    const result = resolveBoundedRoadCandidates(base({
      siteTarget: { x: 0, z: 20 },
      reservation: { center: { x: 0, z: 20 }, radius: 40 },
      sourceEdges: [source],
      sourceNodes: [node(100, { x: 0, z: 0 }), node(101, { x: 200, z: 0 })],
      roadFamilyPreference: "ORTHOGONAL_GRID",
    }));
    expect(result.candidates.some((candidate) => candidate.family === "ORTHOGONAL_GRID")).toBe(true);
    expect(result.candidates.some((candidate) => candidate.family === "FREE_CORRIDOR")).toBe(true);
    for (const candidate of result.candidates.filter((item) => item.family === "ORTHOGONAL_GRID")) {
      const angle = Math.atan2(candidate.input.z2 - candidate.input.z1, candidate.input.x2 - candidate.input.x1);
      const referenceAngle = candidate.gridReference!.orientationRadians;
      const delta = Math.abs(Math.atan2(Math.sin(4 * (angle - referenceAngle)), Math.cos(4 * (angle - referenceAngle))));
      expect(delta).toBeCloseTo(0, 6);
      expect(candidate.gridReference?.spacingMeters).toBe(40);
    }
  });

  test("separates SITE_TARGET from ROAD_CONTACT_TARGET and anchors at graph node", () => {
    const result = resolveBoundedRoadCandidates(base());
    // The family is the direct contact plus its bounded alternatives (interior
    // inset and the lateral offsets), all bounded by the shared selector cap.
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(MAXIMUM_BOUNDED_ROAD_CANDIDATES);
    const candidate = result.candidates[0];
    expect(candidate.siteTarget).toEqual({ x: 20, z: 0 });
    expect(candidate.roadContactTarget).not.toEqual(candidate.siteTarget);
    expect(candidate.sourceAnchor).toEqual({ x: 0, z: 0 });
    expect(candidate.input.x1).toBe(0);
    expect(candidate.input.z1).toBe(0);
    expect(candidate.input.x2).toBe(-20);
    expect(candidate.input.z2).toBe(0);
    expect(candidate.finalSegmentLength).toBeGreaterThanOrEqual(MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS);
    expect(candidate.lengthContract).toEqual({
      minMeters: MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
      maxMeters: MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
      pass: true,
    });
    expect(candidate.sourceAnchorEvidence.derivation).toBe("AUTHORITATIVE_GRAPH_NODE");
  });

  test("keeps durable WorldEpochId separate from the raw Bridge generation token", () => {
    const result = resolveBoundedRoadCandidates(base({ worldEpoch: "world:session:generation:active", bridgeGeneration: "active" }));
    expect(result.candidates[0]?.input.startEndpoint?.worldEpoch).toBe("active");
    expect(result.candidates[0]?.input.endEndpoint?.worldEpoch).toBe("active");
    expect(result.candidates[0]?.input.startEndpoint?.worldEpoch).not.toContain("world:session:generation:");
  });

  test("keeps a valid near-boundary contact without unnecessary adjustment", () => {
    const result = resolveBoundedRoadCandidates(base({
      reservation: { center: { x: 20, z: 0 }, radius: 12 },
    }));
    const candidate = result.candidates[0];
    expect(candidate.contactDerivation).toBe("RESERVATION_NEAR_BOUNDARY");
    expect(candidate.adjustmentReason).toBe("NONE");
    expect(candidate.initialSegmentLength).toBe(8);
    expect(candidate.finalSegmentLength).toBeGreaterThanOrEqual(MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS);
    expect(result.candidates[1]?.contactDerivation).toBe("RESERVATION_INTERIOR_CONTACT");
    expect(result.candidates[1]?.finalSegmentLength).toBeGreaterThan(candidate.finalSegmentLength);
    expect(Math.hypot(result.candidates[1]!.roadContactTarget.x - 20, result.candidates[1]!.roadContactTarget.z)).toBeCloseTo(8, 5);
  });

  test("advances a short near-boundary contact to the first minimum-length point in the reservation", () => {
    const result = resolveBoundedRoadCandidates(base({
      reservation: { center: { x: 20, z: 0 }, radius: 18 },
    }));
    const candidate = result.candidates[0];
    expect(candidate.contactDerivation).toBe("RESERVATION_MIN_LENGTH_CONTACT");
    expect(candidate.adjustmentReason).toBe("MIN_LENGTH_CONSTRAINT");
    expect(candidate.initialSegmentLength).toBe(2);
    expect(candidate.finalSegmentLength).toBeGreaterThanOrEqual(MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS);
    expect(candidate.roadContactTarget.x).toBeCloseTo(8, 5);
    expect(candidate.roadContactTarget).not.toEqual(candidate.siteTarget);
    expect(bridgeDomainNetSegmentLength(candidate.sourceAnchor, candidate.roadContactTarget)).toBeGreaterThanOrEqual(MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS);
  });

  test.each([
    ["exact 8m", { x: 0, z: 0 }, { x: 8, z: 0 }, true],
    ["just below 8m", { x: 0, z: 0 }, { x: 7.999, z: 0 }, false],
    ["just above 8m", { x: 0, z: 0 }, { x: 8.001, z: 0 }, true],
  ])("mirrors Bridge-domain length contract: %s", (_name, start, end, valid) => {
    expect(isBridgeDomainNetSegmentLengthValid(start, end)).toBe(valid);
  });

  test("adjusts a large-coordinate double-valid endpoint until Bridge-domain length is valid", () => {
    const start = { x: -428.08667, z: -860.865356 };
    const unit = { x: -0.99975594796082401, z: 0.022091729605310896 };
    const endpoint = minimumBridgeDomainEndpoint(start, unit);
    expect(endpoint).toBeDefined();
    expect(Math.hypot(endpoint!.x - start.x, endpoint!.z - start.z)).toBeGreaterThan(8);
    expect(bridgeDomainNetSegmentLength(start, endpoint!)).toBeGreaterThanOrEqual(8);
    const naive = { x: start.x + unit.x * (8 + 1e-6), z: start.z + unit.z * (8 + 1e-6) };
    expect(bridgeDomainNetSegmentLength(start, naive)).toBeLessThan(8);
  });

  test("fails closed when the reservation cannot contain a minimum-length contact", () => {
    const result = resolveBoundedRoadCandidates(base({
      siteTarget: { x: 5, z: 0 },
      reservation: { center: { x: 5, z: 0 }, radius: 1 },
      planningEnvelope: { center: { x: 5, z: 0 }, radius: 100 },
    }));
    expect(result.candidates).toHaveLength(0);
    expect(result.rejectedSources.some((source) => source.reason === "road_contact_length_interval_too_short")).toBe(true);
  });

  test("reruns local geometry filters after minimum-length adjustment", () => {
    const building = {
      entity: { index: 18, version: 1 },
      prefab: "House",
      native: true,
      position: { x: 8, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      footprint: { size: { x: 2, y: 1, z: 2 }, bounds: { min: { x: 7, y: 0, z: -1 }, max: { x: 9, y: 1, z: 1 } } },
    };
    const result = resolveBoundedRoadCandidates(base({
      reservation: { center: { x: 20, z: 0 }, radius: 18 },
      buildings: [building],
    }));
    // The minimum-length-adjusted direct contact runs into the house and is
    // refused for exactly that reason...
    expect(result.rejectedSources.some((source) => source.reason === "building_collision")).toBe(true);
    // ...and the bounded alternatives are alternatives LINE, not exemptions: any
    // candidate that survives must still keep clear of the same footprint.
    for (const candidate of result.candidates) {
      const target = candidate.roadContactTarget;
      expect(target.x >= building.footprint.bounds.min.x && target.x <= building.footprint.bounds.max.x &&
        target.z >= building.footprint.bounds.min.z && target.z <= building.footprint.bounds.max.z).toBe(false);
    }
  });

  /**
   * The scan's `native` flag marks the MAP's network: the roads this product
   * itself delivered come back `native: false` beside a live entity and real
   * geometry. Requiring `native` excluded the whole delivered network as a road
   * source, which left a bounded resolution with too few sources to survive one
   * native rejection. The unlocked catalogue is the authoritative statement that
   * a prefab is a road this project can build.
   */
  test("a delivered road seeds candidates once the unlocked catalogue names its prefab", () => {
    const delivered = { ...edge(1, 100, 101, { x: 0, z: 0 }, { x: 200, z: 100 }), native: false };
    const input = {
      sourceEdges: [delivered],
      sourceNodes: [node(100, { x: 0, z: 0 }, 1), node(101, { x: 200, z: 100 }, 1)],
    };
    expect(resolveBoundedRoadCandidates(base(input)).candidates).toHaveLength(0);
    expect(resolveBoundedRoadCandidates(base({ ...input, availableRoadPrefabs: ["Medium Road", "Small Road"] }))
      .candidates.length).toBeGreaterThan(0);
    // A prefab the catalogue does not name is still not a source.
    expect(resolveBoundedRoadCandidates(base({ ...input, availableRoadPrefabs: ["Medium Road"] })).candidates)
      .toHaveLength(0);
  });

  test("rejects a contact beyond the maximum supported net length locally", () => {
    const result = resolveBoundedRoadCandidates(base({
      siteTarget: { x: 2000, z: 0 },
      reservation: { center: { x: 2000, z: 0 }, radius: 100 },
      planningEnvelope: { center: { x: 2000, z: 0 }, radius: 3000 },
      maxSourceDistance: 3000,
      ownedTiles: [{ ...tile, bounds: { min: { x: -3000, z: -3000 }, max: { x: 3000, z: 3000 } } }],
    }));
    expect(result.candidates).toHaveLength(0);
    expect(result.rejectedSources.some((source) => source.reason === "road_contact_length_exceeds_max")).toBe(true);
  });

  test("does not use an edge curve endpoint as the source anchor", () => {
    const input = base({
      sourceEdges: [edge(1, 100, 101, { x: 17, z: 0 }, { x: 200, z: 100 })],
      sourceNodes: [node(100, { x: 0, z: 0 }), node(101, { x: 200, z: 100 })],
    });
    const candidate = resolveBoundedRoadCandidates(input).candidates[0];
    expect(candidate.sourceAnchor).toEqual({ x: 0, z: 0 });
    expect(candidate.input.x1).not.toBe(17);
  });

  test("historical 68161:3 fixture never regenerates curve-endpoint to cell-center geometry", () => {
    const historicalTarget = { x: -561.9724, z: -151.191086 };
    const historicalEdges = [
      edge(46087, 68161, 347680, { x: -550.765259, z: -163.934662 }, { x: -662.5355, z: -156.764984 }),
      edge(46090, 68161, 355265, { x: -546.517334, z: -160.198959 }, { x: -553.687, z: -271.969238 }),
      edge(64486, 355268, 68161, { x: -540.884, z: -72.37942 }, { x: -524.901062, z: -171.093887 }),
      edge(67999, 355268, 68161, { x: -540.884, z: -72.37942 }, { x: -528.097656, z: -151.351 }, false),
      edge(67985, 355268, 68161, { x: -540.884, z: -72.37942 }, { x: -528.097656, z: -151.351 }, false),
    ];
    const historicalNodes = [
      { ...node(68161, { x: -533.792053, z: -164.436829 }, 5), position: { x: -533.792053, y: 277.760254, z: -164.436829 } },
      node(347680, { x: -662.5355, z: -156.764984 }),
      node(355265, { x: -553.687, z: -271.969238 }),
      node(355268, { x: -540.884, z: -72.37942 }),
    ];
    const result = resolveBoundedRoadCandidates(base({
      siteTarget: historicalTarget,
      reservation: { center: historicalTarget, radius: 28 },
      planningEnvelope: { center: historicalTarget, radius: 180 },
      sourceEdges: historicalEdges,
      sourceNodes: historicalNodes,
      ownedTiles: [{ ...tile, bounds: { min: { x: -1000, z: -1000 }, max: { x: 1000, z: 1000 } } }],
      maxSourceDistance: 40,
    }));
    expect(result.candidates.length).toBeLessThanOrEqual(MAXIMUM_BOUNDED_ROAD_CANDIDATES);
    expect(result.candidates.every((candidate) => candidate.sourceNode.entity.index === 68161)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.input.x1 !== -550.765259 && candidate.input.x1 !== -546.517334)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.input.x2 !== historicalTarget.x || candidate.input.z2 !== historicalTarget.z)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.finalSegmentLength >= MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.finalSegmentLength !== 3.1381063114386922)).toBe(true);
  });

  test("deduplicates source edges but keeps the bounded interior contact family", () => {
    const result = resolveBoundedRoadCandidates(base());
    expect(result.rejectedSources.some((source) => source.reason === "duplicate_source_node")).toBe(true);
    // One source node, however many legal alternatives it offers.
    expect(new Set(result.candidates.map((candidate) =>
      `${candidate.sourceNode.entity.index}:${candidate.sourceNode.entity.version}`)).size).toBe(1);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  test("allows a shared intersection by topology evidence, without a roadDegree rule", () => {
    const edges = [
      edge(1, 100, 101, { x: 0, z: 0 }, { x: 200, z: 100 }),
      edge(2, 100, 102, { x: 0, z: 0 }, { x: 200, z: -100 }),
      edge(3, 100, 103, { x: 0, z: 0 }, { x: 100, z: 200 }),
      edge(4, 100, 104, { x: 0, z: 0 }, { x: -100, z: 200 }),
      edge(5, 100, 105, { x: 0, z: 0 }, { x: -200, z: 100 }),
    ];
    const result = resolveBoundedRoadCandidates(base({
      sourceEdges: edges,
      sourceNodes: [node(100, { x: 0, z: 0 }, 5), ...[101, 102, 103, 104, 105].map((index) => node(index, { x: 200, z: 200 }))],
    }));
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.sourceNode.roadDegree === 5)).toBe(true);
  });

  test("fails closed when node identity or complete topology is unavailable", () => {
    expect(resolveBoundedRoadCandidates(base({ sourceNodes: [] })).candidates).toHaveLength(0);
    expect(resolveBoundedRoadCandidates(base({ sourceGraphTruncated: true })).candidates).toHaveLength(0);
    expect(resolveBoundedRoadCandidates(base({ sourceNodes: [node(100, { x: 0, z: 0 }, 3)] })).candidates).toHaveLength(0);
  });

  test("rejects an existing-road interior intersection and duplicate corridor", () => {
    const crossing = edge(20, 200, 201, { x: -10, z: -20 }, { x: -10, z: 20 });
    expect(resolveBoundedRoadCandidates(base({ sourceEdges: [...base().sourceEdges, crossing], sourceNodes: [...base().sourceNodes, node(200, { x: -10, z: -20 }), node(201, { x: -10, z: 20 })] })).rejectedSources.some((source) => source.reason === "existing_road_interior_intersection")).toBe(true);
    const duplicate = edge(21, 210, 211, { x: -10, z: 0 }, { x: -30, z: 0 });
    expect(resolveBoundedRoadCandidates(base({ sourceEdges: [...base().sourceEdges, duplicate], sourceNodes: [...base().sourceNodes, node(210, { x: -10, z: 0 }), node(211, { x: -30, z: 0 })] })).rejectedSources.some((source) => source.reason === "existing_road_duplicate_corridor")).toBe(true);
  });

  test("rejects a native road curve crossing whose endpoint chord misses the candidate", () => {
    const curved = {
      ...edge(22, 220, 221, { x: -25, z: -20 }, { x: -25, z: 20 }),
      nativeCurve: {
        a: { x: -25, y: 0, z: -20 }, b: { x: -2, y: 0, z: -10 },
        c: { x: -2, y: 0, z: 10 }, d: { x: -25, y: 0, z: 20 }, length: 50,
      },
    };
    const result = resolveBoundedRoadCandidates(base({
      sourceEdges: [...base().sourceEdges, curved],
      allowedSourceNodeRefs: [{ index: 100, version: 1 }],
    }));
    expect(result.candidates.some((candidate) => candidate.input.x2 === -20 && candidate.input.z2 === 0)).toBe(false);
    expect(result.rejectedSources.some((source) => source.reason === "existing_road_interior_intersection")).toBe(true);
  });

  test.each([
    [8, { x: -8, z: 0 }],
    [16, { x: -16, z: 0 }],
    [25, { x: -25, z: 0 }],
  ])("rejects a same-direction near-collinear incident corridor at %sm", (_length, target) => {
    const source = node(51916, { x: 0, z: 0 }, 2);
    const existing = edge(45443, 51916, 45444, { x: 0, z: 0 }, { x: -200, z: 0.005 });
    expect(nearCollinearIncidentCorridor({ x: 0, z: 0 }, target, source, [existing])).toBe(true);
  });

  test("rejects the live 2.8-degree road continuation the native preview reclassified as existing edges", () => {
    const anchor = { x: -1221.62866, z: -22.7515583 };
    const source = node(50509, anchor, 2);
    const existing = edge(193595, 50509, 50512, anchor, { x: -1142.38806, z: -26.64797 });
    const candidate = { x: -1194.3883282793029, z: -22.71202616776713 };
    expect(nearCollinearIncidentCorridor(anchor, candidate, source, [existing])).toBe(true);
  });

  test("rejects a steep native road candidate during geometry preflight", () => {
    const steepTerrain = {
      resolution: 2,
      bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
      cellSize: { x: 100, z: 100 },
      heights: [0, 100, 0, 100],
      waterDepths: [0, 0, 0, 0],
      groundWater: [0, 0, 0, 0],
      groundWaterPollution: [0, 0, 0, 0],
      windSpeed: [0, 0, 0, 0],
    };
    const uphillSource = edge(30, 300, 301, { x: -20, z: 0 }, { x: -200, z: 100 });
    const result = resolveBoundedRoadCandidates(base({
      siteTarget: { x: 20, z: 0 },
      reservation: { center: { x: 20, z: 0 }, radius: 28 },
      sourceEdges: [uphillSource],
      sourceNodes: [node(300, { x: -20, z: 0 }), node(301, { x: -200, z: 100 })],
      maxSourceDistance: 50,
      terrain: steepTerrain,
      maxGradePercent: 12,
    }));
    expect(result.rejectedSources.some((entry) => entry.reason === "slope_exceeds_bound")).toBe(true);
  });

  test.each([
    ["divergent branch", { x: -25, z: 2 }, { x: -200, z: 0 }],
    ["sufficiently separated parallel-ish branch", { x: -25, z: 1.75 }, { x: -200, z: 0 }],
    ["opposite direction", { x: 25, z: 0 }, { x: -200, z: 0 }],
  ])("does not reject %s", (_name, target, existingTarget) => {
    const source = node(51916, { x: 0, z: 0 }, 2);
    const existing = edge(45443, 51916, 45444, { x: 0, z: 0 }, existingTarget);
    expect(nearCollinearIncidentCorridor({ x: 0, z: 0 }, target, source, [existing])).toBe(false);
  });

  test("rejects the 51916-equivalent candidate and advances to a bounded next source", () => {
    const first = edge(45441, 100, 101, { x: 0, z: 0 }, { x: -200, z: 0.005 });
    const second = edge(45442, 200, 201, { x: 0, z: 10 }, { x: 200, z: 10 });
    const result = resolveBoundedRoadCandidates(base({
      siteTarget: { x: -20, z: 0 },
      reservation: { center: { x: -20, z: 0 }, radius: 5 },
      sourceEdges: [first, second],
      sourceNodes: [node(100, { x: 0, z: 0 }), node(101, { x: -200, z: 0.005 }), node(200, { x: 0, z: 10 }), node(201, { x: 200, z: 10 })],
      maxSourceDistance: 50,
    }));
    expect(result.rejectedSources.some((source) => source.reason === "near_collinear_incident_corridor")).toBe(true);
    // The collinear line itself is gone, and the bounded next source still
    // contributes. Any surviving alternative from the first source is a branch
    // off that corridor rather than a duplicate of it: it must not run back
    // along the same axis.
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) =>
      candidate.sourceNode.entity.index === 200 || Math.abs(candidate.roadContactTarget.z) > 1)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.lengthContract.pass)).toBe(true);
  });

  test("retains local ownership, water, terrain, building, and protection filters", () => {
    expect(resolveBoundedRoadCandidates(base({ ownedTiles: [{ ...tile, bounds: { min: { x: 5, z: -250 }, max: { x: 250, z: 250 } } }] })).candidates).toHaveLength(0);
    const terrain = {
      resolution: 2,
      bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
      cellSize: { x: 100, z: 100 },
      heights: [0, 0, 0, 100],
      waterDepths: [0, 0, 0, 1],
      groundWater: [0, 0, 0, 0],
      groundWaterPollution: [0, 0, 0, 0],
      windSpeed: [0, 0, 0, 0],
    };
    expect(resolveBoundedRoadCandidates(base({ terrain })).rejectedSources.length).toBeGreaterThan(0);
    const building = { entity: { index: 8, version: 1 }, prefab: "House", native: true, position: { x: -6.666667, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: { size: { x: 4, y: 1, z: 10 }, bounds: { min: { x: -8, y: 0, z: -5 }, max: { x: -5, y: 1, z: 5 } } } };
    expect(resolveBoundedRoadCandidates(base({ buildings: [building] })).rejectedSources.some((source) => source.reason === "building_collision")).toBe(true);
    expect(resolveBoundedRoadCandidates(base({ protectedScopes: [{ center: { x: -10, z: 0 }, radius: 2 }] })).rejectedSources.some((source) => source.reason === "protected_scope_collision")).toBe(true);
  });

  test("keeps source alternatives and their interior contacts inside the shared selector bound", () => {
    const extraEdge = edge(3, 200, 201, { x: 0, z: 10 }, { x: 200, z: 110 });
    const result = resolveBoundedRoadCandidates(base({
      sourceEdges: [...base().sourceEdges, extraEdge],
      sourceNodes: [...base().sourceNodes, node(200, { x: 0, z: 10 }), node(201, { x: 200, z: 110 })],
      reservation: { center: { x: 20, z: 0 }, radius: 12 },
    }));
    expect(result.candidates.length).toBeGreaterThan(2);
    // Every source stays inside the shared bound, and the family now uses it to
    // offer its headings at more than one length rather than to pay for depth.
    expect(result.candidates.length).toBeLessThanOrEqual(MAXIMUM_BOUNDED_ROAD_CANDIDATES);
    const headings = result.candidates.map((candidate) =>
      Math.round((Math.atan2(candidate.input.z2 - candidate.input.z1, candidate.input.x2 - candidate.input.x1) * 180) / Math.PI));
    const lengths = result.candidates.map((candidate) =>
      Math.round(Math.hypot(candidate.input.x2 - candidate.input.x1, candidate.input.z2 - candidate.input.z1)));
    expect(new Set(headings).size).toBeGreaterThan(2);
    expect(new Set(lengths).size).toBeGreaterThan(1);
    expect(result.candidates[0].input).not.toEqual(result.candidates[1]?.input);
    // Variants are interleaved across sources, so the second source's boundary
    // contact takes the second slot and each source keeps its interior contact
    // immediately after its own boundary contact.
    expect(result.candidates[1].sourceNode.entity).not.toEqual(result.candidates[0].sourceNode.entity);
    expect(result.candidates[2].sourceNode.entity).toEqual(result.candidates[0].sourceNode.entity);
    expect(result.candidates[1].contactDerivation).toBe("RESERVATION_NEAR_BOUNDARY");
    expect(result.candidates[2].contactDerivation).toBe("RESERVATION_INTERIOR_CONTACT");
    expect(result.candidates.some((candidate) => candidate.sourceNode.entity.index === 200)).toBe(true);
    expect(result.candidates.map((candidate) => candidate.input)).toEqual(resolveBoundedRoadCandidates(base({
      sourceEdges: [...base().sourceEdges, extraEdge],
      sourceNodes: [...base().sourceNodes, node(200, { x: 0, z: 10 }), node(201, { x: 200, z: 110 })],
      reservation: { center: { x: 20, z: 0 }, radius: 12 },
    })).candidates.map((candidate) => candidate.input));
  });

  test("restricts a starter connection to its explicitly allowed source node", () => {
    const result = resolveBoundedRoadCandidates(base({
      allowedSourceNodeRefs: [{ index: 100, version: 1 }],
      prefab: "Medium Road",
      reservation: { center: { x: 20, z: 0 }, radius: 12 },
    }));
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.candidates.length).toBeLessThanOrEqual(MAXIMUM_BOUNDED_ROAD_CANDIDATES);
    expect(result.candidates.every((candidate) => candidate.sourceNode.entity.index === 100)).toBe(true);
    expect(result.candidates[0].input.prefab).toBe("Medium Road");
  });

  test("uses the authoritative outward tangent for a certified terminal continuation", () => {
    const continuationEdge = {
      ...edge(300, 301, 302, { x: 0, z: 0 }, { x: 0, z: 16 }, false),
      prefab: "Medium Road",
    };
    const continuationNode = node(302, { x: 0, z: 16 }, 1);
    continuationNode.native = false;
    const result = resolveBoundedRoadCandidates({
      siteTarget: { x: 0, z: 32 },
      reservation: { center: { x: 0, z: 32 }, radius: 28 },
      planningEnvelope: { center: { x: 0, z: 32 }, radius: 180 },
      sourceEdges: [continuationEdge],
      sourceNodes: [node(301, { x: 0, z: 0 }), continuationNode],
      allowedSourceNodeRefs: [continuationNode.entity],
      certifiedContinuationSource: { edge: continuationEdge, node: continuationNode, role: "end" },
      ownedTiles: [{ ...tile, bounds: { min: { x: -250, z: -250 }, max: { x: 250, z: 250 } } }],
      prefab: "Medium Road",
      worldEpoch: "world:active",
      bridgeGeneration: "active",
    });
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.contactDerivation).toBe("OUTWARD_TERMINAL_TANGENT");
    expect(candidate.finalSegmentLength).toBe(16);
    expect(candidate.input.x2).toBeCloseTo(0, 8);
    expect(candidate.input.z2).toBeCloseTo(32, 8);
    expect(candidate.input.z2).toBeGreaterThan(candidate.input.z1);
  });

  test("offers a 16m reservation-interior contact after the boundary contact and keeps it bounded", () => {
    const result = resolveBoundedRoadCandidates(base({
      reservation: { center: { x: 20, z: 0 }, radius: 12 },
    }));
    expect(result.candidates.length).toBeLessThanOrEqual(MAXIMUM_BOUNDED_ROAD_CANDIDATES);
    expect(result.candidates[0].contactDerivation).toBe("RESERVATION_NEAR_BOUNDARY");
    expect(result.candidates[0].input.x2).toBeCloseTo(8, 5);
    expect(result.candidates[1].contactDerivation).toBe("RESERVATION_INTERIOR_CONTACT");
    expect(result.candidates[1].adjustmentReason).toBe("PRODUCTIVE_CONTACT_INSET");
    expect(result.candidates[1].input.x2).toBeCloseTo(12, 5);
    expect(distanceForTest(result.candidates[1].roadContactTarget, { x: 20, z: 0 })).toBeCloseTo(8, 5);
    expect(result.candidates[1].finalSegmentLength).toBeCloseTo(12, 5);
  });

  test("preserves native preview authority and UNKNOWN no-fallback semantics", () => {
    expect(classifyNativeRoadPreviewFailure(new Error("HTTP 409 operation blocked by game validation"))).toBe("REJECTED");
    expect(classifyNativeRoadPreviewFailure(new Error("request timed out"))).toBe("UNKNOWN");
    expect(classifyNativeRoadPreviewFailure(new Error("HTTP 500 bridge unavailable"))).toBe("UNKNOWN");
  });
});
