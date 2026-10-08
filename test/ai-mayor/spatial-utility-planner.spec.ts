import type {
  BootstrapSiteEvaluation,
  SpatialBootstrapAsset,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "../../src/main/services/ai-mayor/spatial/types";
import {
  MAX_COMPLETE_UTILITY_PROPOSALS,
  MAX_UTILITY_SERVICE_ROAD_LENGTH,
  UtilityPlanningError,
  planBootstrapUtilities,
  rankUtilitySiteCandidates,
  rankedPermanentRoadContacts,
  scoreUtilitySiteQuality,
  ROAD_NATIVE_COLLINEAR_FOLD_DEGREES,
  routeFirstLegDuplicatesCorridor,
  serviceRoadFor,
  serviceRoadRouteCandidates,
  selectSupportedWaterPlan,
  selectStageAWaterPlan,
  splitUtilityConnection,
} from "../../src/main/services/ai-mayor/spatial/utility-planner";
import type { SpatialRoadEdge } from "../../src/main/services/ai-mayor/spatial/types";

test("utility contact ranking advances to another authorized road contact after exhaustion", () => {
  const road = (id: number, start: { x: number; z: number }, end: { x: number; z: number }): SpatialRoadEdge => ({
    entity: { index: id, version: 1 }, prefab: "Small Road", native: true,
    startNode: { index: id + 100, version: 1 }, endNode: { index: id + 200, version: 1 },
    start, end, length: Math.hypot(end.x - start.x, end.z - start.z),
  });
  const candidates = rankedPermanentRoadContacts({ x: 0, z: 0 }, [
    road(1, { x: 10, z: -10 }, { x: 10, z: 10 }),
    road(2, { x: 20, z: -10 }, { x: 20, z: 10 }),
    road(3, { x: 10, z: -10 }, { x: 10, z: 10 }),
  ], [{ x: 10, z: 0 }, { x: 10, z: -10 }, { x: 10, z: 10 }]);
  expect(candidates[0].point).toEqual({ x: 20, z: 0 });
  expect(candidates.length).toBeGreaterThan(0);
});

const resolution = 16;
const values = (value: number) => Array(resolution * resolution).fill(value);

test("bounded Pump access routes keep straight contiguous segments in 1–4 segment priority", () => {
  const direct = { id: "water-service-road", role: "side" as const,
    start: { x: 0, z: 0 }, end: { x: 40, z: 0 } };
  const routes = serviceRoadRouteCandidates(direct, { includeHeadingFan: false });
  expect(routes.map((route) => route.length)).toEqual([1, 2, 2, 3, 3, 4, 4]);
  for (const route of routes) {
    expect(route[0].start).toEqual(direct.start);
    expect(route.at(-1)?.end).toEqual(direct.end);
    route.forEach((segment, index) => {
      expect(Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z)).toBeGreaterThan(0);
      if (index > 0) expect(segment.start).toEqual(route[index - 1].end);
    });
  }
});

test("bounded heading fan leaves the source on headings the direct family cannot reach", () => {
  const direct = { id: "service-road", role: "side" as const,
    start: { x: 0, z: 0 }, end: { x: 80, z: 0 } };
  const fan = serviceRoadRouteCandidates(direct).filter((route) => route[0].id.includes(":heading-fan:"));
  expect(fan).toHaveLength(6);
  expect(fan.map((route) => route.length)).toEqual([2, 2, 2, 2, 2, 2]);
  // The direct family never leaves past roughly 50 degrees off the direct bearing;
  // the fan is the bounded complement that covers the rest of the free half-plane.
  const directOnly = serviceRoadRouteCandidates(direct, { includeHeadingFan: false });
  const widestDirect = Math.max(...directOnly.map((route) =>
    Math.abs((Math.atan2(route[0].end.z - route[0].start.z, route[0].end.x - route[0].start.x) * 180) / Math.PI)));
  const widestFan = Math.max(...fan.map((route) =>
    Math.abs((Math.atan2(route[0].end.z - route[0].start.z, route[0].end.x - route[0].start.x) * 180) / Math.PI)));
  expect(widestFan).toBeGreaterThan(widestDirect + 30);
  for (const route of fan) {
    expect(route[0].start).toEqual(direct.start);
    expect(route.at(-1)?.end).toEqual(direct.end);
    expect(route[1].start).toEqual(route[0].end);
  }
});

test("a first leg that follows the source road is recognised as a corridor restatement, not a new road", () => {
  const route = (start: { x: number; z: number }, end: { x: number; z: number }) =>
    [{ id: "route", role: "side" as const, start, end }];
  const corridor = { x: 1, z: 0 };
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: 30, z: 0 }), corridor)).toBe(true);
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: -30, z: 0 }), corridor)).toBe(true);
  // 14.5 degrees off the corridor is still inside the duplication cone at 25 degrees.
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: 40, z: 10.3 }), corridor)).toBe(true);
  // A genuine departure is not.
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: 20, z: 34.6 }), corridor)).toBe(false);
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: 0, z: 30 }), corridor)).toBe(false);
});

test("the corridor-duplication cone is measured from the road's line, in either direction", () => {
  // Kept deliberately absolute. The temptation is to read "leaving along the
  // road's own bearing" as a departure, and it is not: measured live at the end
  // node of a just-built road, a 114 m course on that road's exact bearing is
  // refused (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, proposalEdgeCount 0) while
  // a 1 degree divergence is certified. Native folds the collinear continuation
  // back into the road it continues, so the cone has to cover both signs.
  const route = (start: { x: number; z: number }, end: { x: number; z: number }) =>
    [{ id: "route", role: "side" as const, start, end }];
  const corridor = { x: 1, z: 0 };
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: 30, z: 0 }), corridor)).toBe(true);
  expect(routeFirstLegDuplicatesCorridor(route({ x: 0, z: 0 }, { x: -30, z: 0 }), corridor)).toBe(true);
});

test("the direct course is judged by native's fold cone, not the bounded family's", () => {
  // A straight corridor's planned hop sits a few degrees off the road each hop
  // continues — the departure the corridor planner guarantees. Native certifies
  // it; the bounded family's twenty-five degree dedup cone refuses it. Judging
  // the direct course by that cone is what left the Road step offering courses
  // native folds back, which is the live `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`
  // stall after the first hop landed.
  const atDegrees = (degrees: number) => [{ id: "directed", role: "side" as const,
    start: { x: 0, z: 0 },
    end: { x: 100 * Math.cos((degrees * Math.PI) / 180), z: 100 * Math.sin((degrees * Math.PI) / 180) } }];
  const corridor = { x: 1, z: 0 };
  // Five degrees: the corridor's own departure margin, and certified live.
  expect(routeFirstLegDuplicatesCorridor(atDegrees(5), corridor, ROAD_NATIVE_COLLINEAR_FOLD_DEGREES)).toBe(false);
  expect(routeFirstLegDuplicatesCorridor(atDegrees(5), corridor)).toBe(true);
  // Inside native's measured fold cone it is still a restatement, in either sign.
  expect(routeFirstLegDuplicatesCorridor(atDegrees(0.5), corridor, ROAD_NATIVE_COLLINEAR_FOLD_DEGREES)).toBe(true);
  expect(routeFirstLegDuplicatesCorridor(atDegrees(180.5), corridor, ROAD_NATIVE_COLLINEAR_FOLD_DEGREES)).toBe(true);
  // And a course across the road is a departure under both.
  expect(routeFirstLegDuplicatesCorridor(atDegrees(90), corridor)).toBe(false);
});

test("service-road planning adds bounded T-branch family only when target road direction is known", () => {
  const direct = { id: "service-road", role: "side" as const,
    start: { x: 0, z: 0 }, end: { x: 80, z: 0 } };
  const withoutTarget = serviceRoadRouteCandidates(direct);
  const withTarget = serviceRoadRouteCandidates(direct, { targetRoadDirection: { x: 1, z: 0 } });
  expect(withTarget).toHaveLength(withoutTarget.length + 2);
  expect(withTarget.slice(-2).flat().every((segment) => segment.id.includes("junction-branch"))).toBe(true);
});

test("utility site quality softly prefers simpler road reach and keeps every bounded site eligible", () => {
  const farWindSite = { id: "far-wind", siteEvidence: { windSpeed: 0.9, roadDistance: 120, connectionDistance: 100 } };
  const roadReadySite = { id: "road-ready", siteEvidence: { windSpeed: 0.6, roadDistance: 12, connectionDistance: 24 } };
  const ranked = rankUtilitySiteCandidates([farWindSite, roadReadySite]);
  expect(scoreUtilitySiteQuality(roadReadySite.siteEvidence)).toBeGreaterThan(scoreUtilitySiteQuality(farWindSite.siteEvidence));
  expect(ranked.map((candidate) => candidate.id)).toEqual(["road-ready", "far-wind"]);
  expect(ranked).toHaveLength(2);
});

const model: SpatialWorldModel = {
  worldBounds: { min: -1000, max: 1000, size: 2000 },
  ownedTiles: [
    {
      entity: { index: 1, version: 1 },
      owned: true,
      bounds: { min: { x: -200, z: -100 }, max: { x: 400, z: 500 } },
      center: { x: 100, z: 200 },
      polygon: [],
    },
  ],
  outsideConnections: [],
  connectionCandidates: [],
  roadGraph: { nodes: [], edges: [], truncated: false },
};

const selectedSite: BootstrapSiteEvaluation = {
  connection: {
    reason: "native_terminal_in_owned_area",
    node: {
      entity: { index: 10, version: 1 },
      position: { x: 0, y: 0, z: 0 },
      native: true,
      outsideConnection: false,
      roadDegree: 1,
    },
  },
  valid: true,
  score: 100,
  rejectionReasons: [],
  metrics: {
    sampledPoints: 1,
    meanGradePercent: 0,
    maxGradePercent: 0,
    wetSamples: 0,
    outsideOwnedSamples: 0,
    buildingConflicts: 0,
    usableExistingZoningCells: 0,
  },
  layout: {
    style: "starter_grid",
    entryNode: { index: 10, version: 1 },
    incomingEdge: { index: 20, version: 1 },
    forward: { x: 0, z: 1 },
    right: { x: 1, z: 0 },
    futureExpansionPoint: { x: 0, z: 240 },
    segments: [{ id: "main", role: "main", start: { x: 0, z: 0 }, end: { x: 0, z: 300 } }],
  },
};

function asset(kind: "power" | "water" | "sewage"): SpatialBootstrapAsset {
  return {
    prefab: kind,
    locked: false,
    constructionCost: kind === "power" ? 1000 : 500,
    lotSize: { x: 4, z: 4 },
    size: { x: 32, y: 20, z: 32 },
    capabilities: {
      electricityProduction: 0,
      windMaximum: kind === "power" ? 10 : 0,
      windProduction: kind === "power" ? 100 : 0,
      groundWaterProduction: kind === "water" ? 100 : 0,
      groundWaterMaximum: kind === "water" ? 1000 : 0,
      freshWaterCapacity: kind === "water" ? 100 : 0,
      allowedWaterTypes: kind === "water" ? "GroundWater" : null,
      sewageCapacity: kind === "sewage" ? 100 : 0,
      sewagePurification: 0,
    },
  };
}

function areaDetail(): SpatialSiteDetail {
  const waterDepths = values(0);
  for (let row = 0; row < resolution; row++) waterDepths[row * resolution + resolution - 1] = 4;
  return {
    center: { x: 100, z: 200 },
    radius: 400,
    terrain: {
      resolution,
      bounds: { minX: -200, minZ: -100, maxX: 400, maxZ: 500 },
      cellSize: { x: 37.5, z: 37.5 },
      heights: values(10),
      waterDepths,
      groundWater: values(500),
      groundWaterPollution: values(0),
      windSpeed: values(5),
    },
    buildings: [],
    zoningCells: [],
    roadGraph: {
      nodes: [],
      edges: [
        {
          entity: { index: 30, version: 1 },
          prefab: "Medium Road",
          native: true,
          startNode: { index: 31, version: 1 },
          endNode: { index: 32, version: 1 },
          start: { x: 0, z: 300 },
          end: { x: 300, z: 300 },
          length: 300,
        },
      ],
    },
  };
}

function farShoreModel(): SpatialWorldModel {
  return {
    ...model,
    ownedTiles: [
      {
        ...model.ownedTiles[0],
        bounds: { min: { x: -200, z: -100 }, max: { x: 1200, z: 500 } },
      },
    ],
  };
}

function farShoreDetail(blocked = false): SpatialSiteDetail {
  const detail = areaDetail();
  const waterDepths = values(0);
  for (let row = 0; row < resolution; row++) waterDepths[row * resolution + resolution - 1] = 4;
  detail.terrain = {
    ...detail.terrain,
    bounds: { minX: -200, minZ: -100, maxX: 1200, maxZ: 500 },
    cellSize: { x: 87.5, z: 37.5 },
    waterDepths,
  };
  if (blocked) {
    detail.buildings = [
      {
        entity: { index: 90, version: 1 },
        prefab: "blocking-building",
        native: true,
        position: { x: 650, y: 10, z: 200 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        footprint: {
          size: { x: 120, y: 20, z: 800 },
          bounds: {
            min: { x: 590, y: 0, z: -200 },
            max: { x: 710, y: 20, z: 600 },
          },
        },
      },
    ];
  }
  return detail;
}

describe("bootstrap utility planner", () => {
  const pumpAsset = {
    ...asset("water"),
    prefab: "GroundwaterPumpingStation01",
    lotSize: { x: 6, z: 6 },
    size: { x: 47.6, y: 20, z: 47.6 },
  };
  const pumpCenter = { x: -224.6353, z: 1283.64661 };

  test("Groundwater pump service road endpoint follows current native-frontage witness geometry", () => {
    const existingRoadPoint = { x: -191.433685, z: 1297.03662 };
    const road = serviceRoadFor("water", pumpAsset, pumpCenter, existingRoadPoint, 0);
    expect(road?.start).toEqual(existingRoadPoint);
    expect(road?.end.x).toBeCloseTo(-224.6353, 5);
    expect(road?.end.z).toBeCloseTo(1316.57654, 5);
  });

  test("pump facility-side endpoint is independent of road-network direction", () => {
    const northEast = serviceRoadFor("water", pumpAsset, pumpCenter, { x: 38.61565, z: 1389.81421 }, 0);
    const southWest = serviceRoadFor("water", pumpAsset, pumpCenter, { x: -800, z: 200 }, 0);
    expect(southWest?.end).toEqual(northEast?.end);
  });

  test("pump endpoint rotates with the existing zero-is-plus-Z yaw convention", () => {
    const road = serviceRoadFor("water", pumpAsset, pumpCenter, { x: 100, z: 1600 }, 90);
    expect(road?.end.x).toBeCloseTo(-191.70537, 5);
    expect(road?.end.z).toBeCloseTo(1283.64661, 5);
    expect(Math.hypot(road!.end.x - pumpCenter.x, road!.end.z - pumpCenter.z)).toBeCloseTo(32.92993, 5);
  });

  test("selects data-backed power, groundwater and shoreline sewage sites", () => {
    const plan = planBootstrapUtilities(model, selectedSite, areaDetail(), [
      asset("power"),
      asset("water"),
      asset("sewage"),
    ]);
    expect(plan.facilities.map((facility) => facility.kind)).toEqual(["power", "water", "sewage"]);
    expect(plan.facilities.find((facility) => facility.kind === "water")?.siteEvidence.groundWater).toBe(500);
    const sewage = plan.facilities.find((facility) => facility.kind === "sewage");
    expect(sewage?.rotationCandidates).toHaveLength(4);
    expect(Number(sewage?.siteEvidence.roadDistance)).toBeLessThanOrEqual(320);
    expect(plan.totalFacilityCost).toBe(2000);
  });

  test("bounded utility replan advances to the next ranked site after a service-road site is exhausted", () => {
    const detail = areaDetail();
    const first = planBootstrapUtilities(model, selectedSite, detail, [asset("power")], {
      utilityKind: "power", networkSource: "EXISTING_PLAYER_ROADS_ONLY",
    }).facilities[0];
    const alternate = planBootstrapUtilities(model, selectedSite, detail, [asset("power")], {
      utilityKind: "power", networkSource: "EXISTING_PLAYER_ROADS_ONLY",
      excludedSiteAreas: [{ center: first.position, radius: 0.1 }],
    }).facilities[0];
    expect(alternate.position).not.toEqual(first.position);
    expect(alternate.serviceRoads).not.toEqual(first.serviceRoads);
  });

  test("plans a bounded legal service road when shoreline is far from the road network", () => {
    const plan = planBootstrapUtilities(farShoreModel(), selectedSite, farShoreDetail(), [
      asset("power"),
      asset("water"),
      asset("sewage"),
    ]);
    const sewage = plan.facilities.find((facility) => facility.kind === "sewage");
    expect(sewage?.serviceRoads?.length).toBeGreaterThan(0);
    expect(Number(sewage?.siteEvidence.serviceRoadLength)).toBeGreaterThan(320);
    expect(Number(sewage?.siteEvidence.serviceRoadLength)).toBeLessThanOrEqual(MAX_UTILITY_SERVICE_ROAD_LENGTH);
  });

  test("fails before execution when no shoreline service road has a legal corridor", () => {
    expect(() =>
      planBootstrapUtilities(farShoreModel(), selectedSite, farShoreDetail(true), [
        asset("power"),
        asset("water"),
        asset("sewage"),
      ]),
    ).toThrow("legal service road");
  });

  test("fails explicitly when no clean groundwater source exists", () => {
    const detail = areaDetail();
    detail.terrain.groundWaterPollution.fill(1);
    expect(() =>
      planBootstrapUtilities(model, selectedSite, detail, [asset("power"), asset("water"), asset("sewage")]),
    ).toThrow("no valid unlocked water-source plan");
  });

  test("filters the top-ranked unsupported Water candidate and selects the next supported candidate", async () => {
    let probes = 0;
    const result = await selectSupportedWaterPlan({
      model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async (candidate) => {
        expect(candidate.kind).toBe("water");
        probes += 1;
        return probes > 1 ? ({ supported: true }) : ({ supported: false, reason: "native_rejected" });
      },
    });
    expect(result.candidateCount).toBeGreaterThanOrEqual(2);
    expect(result.selectedRank).toBe(2);
    // The raw pool is wider than the proposal ceiling: a plan needs three
    // complete proposals, not every candidate, so the probe stops as soon as
    // the third one is whole — which here is the fourth probe, the first having
    // been the rejected leader.
    expect(result.supportedCandidateCount).toBe(MAX_COMPLETE_UTILITY_PROPOSALS);
    expect(result.candidateCount).toBeGreaterThan(MAX_COMPLETE_UTILITY_PROPOSALS);
    expect(probes).toBe(MAX_COMPLETE_UTILITY_PROPOSALS + 1);
  });

  test("retains existing deterministic Water ranking among multiple supported candidates", async () => {
    const first = await selectSupportedWaterPlan({ model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async () => ({ supported: true }) });
    const second = await selectSupportedWaterPlan({ model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async () => ({ supported: true }) });
    const original = planBootstrapUtilities(model, selectedSite, areaDetail(), [asset("water")], { utilityKind: "water" }).facilities[0];
    expect(first.supportedCandidateCount).toBeGreaterThan(1);
    expect(first.selectedRank).toBe(1);
    expect(first.facility).toEqual(original);
    expect(second.facility).toEqual(first.facility);
  });

  test("fails closed when every bounded Water candidate is unsupported", async () => {
    await expect(selectSupportedWaterPlan({
      model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async () => ({ supported: false, reason: "native_rejected" }),
    })).rejects.toMatchObject({ code: "NO_SUPPORTED_WATER_TOPOLOGY", supportedCandidateCount: 0, candidateCount: expect.any(Number) });
  });

  test("construction feasibility probes are read-only and cannot authorize or execute", async () => {
    let authorizationCount = 0;
    let nativeMutationCount = 0;
    let feasibilityProbeCount = 0;
    const result = await selectSupportedWaterPlan({
      model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async () => { feasibilityProbeCount += 1; return { supported: true }; },
    });
    expect(result.facility.kind).toBe("water");
    // Every probe accepted means the third whole plan ends the search, and the
    // probes remain read-only throughout: they never authorize or mutate.
    expect(feasibilityProbeCount).toBe(MAX_COMPLETE_UTILITY_PROPOSALS);
    expect(result.supportedCandidateCount).toBe(MAX_COMPLETE_UTILITY_PROPOSALS);
    expect(authorizationCount).toBe(0);
    expect(nativeMutationCount).toBe(0);
  });

  test("Stage A filters invalid placement previews and keeps the original Water ranking", async () => {
    let probes = 0;
    const result = await selectStageAWaterPlan({
      model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async () => {
        probes += 1;
        return probes === 1 ? { valid: false, previewOnly: true, reason: "placement_rejected" }
          : { valid: true, previewOnly: true };
      },
    });
    expect(result.candidateCount).toBeGreaterThanOrEqual(2);
    expect(result.validCandidateCount).toBe(result.candidateCount - 1);
    expect(result.selectedRank).toBe(2);
    expect(probes).toBe(result.candidateCount);
    expect(result.funnel.finalStageACandidateCount).toBe(result.candidateCount);
    expect(result.funnel.groundwaterEligibleCount).toBeGreaterThanOrEqual(result.funnel.withinExistingRoadReachCount);
  });

  test("Stage A fails closed when all bounded facility placement previews are invalid", async () => {
    await expect(selectStageAWaterPlan({ model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      preflight: async () => ({ valid: false, previewOnly: true, reason: "placement_rejected" }) }))
      .rejects.toMatchObject({ code: "NO_SUPPORTED_WATER_TOPOLOGY", supportedCandidateCount: 0 });
  });

  test("Stage A funnel reports an empty scoped domain before preview without probing native placement", async () => {
    let probes = 0;
    await expect(selectStageAWaterPlan({ model, selectedSite, areaDetail: areaDetail(), assets: [asset("water")],
      options: { siteEnvelope: { center: { x: 100_000, z: 100_000 }, radius: 1 } },
      preflight: async () => { probes += 1; return { valid: true, previewOnly: true }; },
    })).rejects.toMatchObject({
      code: "NO_SUPPORTED_WATER_TOPOLOGY",
      funnel: { rawTerrainSampleCount: expect.any(Number), inCurrentScopeCount: 0, finalStageACandidateCount: 0,
        firstZeroingFilter: "CURRENT_SCOPE_ENVELOPE" },
    });
    expect(probes).toBe(0);
  });

  test("Local V2 mode accepts a permanent native road as a current-world target", () => {
    const detail = areaDetail();
    detail.roadGraph.edges[0].native = false;
    const plan = planBootstrapUtilities(
      model,
      selectedSite,
      detail,
      [asset("power"), asset("water"), asset("sewage")],
      { networkSource: "EXISTING_PLAYER_ROADS_ONLY" },
    );
    expect(plan.facilities).toHaveLength(3);
    expect(plan.facilities.every((facility) => facility.connection.end.z === 300)).toBe(true);
    expect(plan.roadAuthorityDiagnostics).toEqual({
      roadCountBoundedDetail: 1,
      roadCountAfterAuthorityFilter: 1,
      roadCountVisibleToPlanner: 1,
      roadCountVisibleToCandidateBuilder: 1,
    });
  });

  test("Local V2 mode accepts a permanent native=true road", () => {
    const plan = planBootstrapUtilities(
      model,
      selectedSite,
      areaDetail(),
      [asset("power"), asset("water"), asset("sewage")],
      { networkSource: "EXISTING_PLAYER_ROADS_ONLY" },
    );
    expect(plan.roadAuthorityDiagnostics?.roadCountAfterAuthorityFilter).toBe(1);
  });

  test.each([
    ["Temp", { temp: true }],
    ["Deleted", { deleted: true }],
    ["owner child", { owner: { index: 90, version: 1 } }],
  ])("Local V2 mode rejects a %s road", (_label, marker) => {
    const detail = areaDetail();
    detail.roadGraph.edges[0] = { ...detail.roadGraph.edges[0], ...marker };
    try {
      planBootstrapUtilities(
        model,
        selectedSite,
        detail,
        [asset("power"), asset("water"), asset("sewage")],
        { networkSource: "EXISTING_PLAYER_ROADS_ONLY" },
      );
      throw new Error("expected authoritative-road planning to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(UtilityPlanningError);
      expect(error).toMatchObject({ code: "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY" });
      expect((error as UtilityPlanningError).diagnostics).toEqual(expect.objectContaining({
        roadCountBoundedDetail: expect.any(Number),
        roadCountAfterAuthorityFilter: 0,
        roadCountVisibleToPlanner: 0,
        roadCountVisibleToCandidateBuilder: 0,
      }));
    }
  });

  test("splits long utility runs into connectable deterministic segments", () => {
    const segments = splitUtilityConnection({
      prefab: "Small Sewage Pipe",
      start: { x: 0, z: 0 },
      end: { x: 0, z: 1576 },
    });
    expect(segments).toHaveLength(2);
    expect(Math.hypot(segments[0].end.x - segments[0].start.x, segments[0].end.z - segments[0].start.z)).toBeLessThan(
      1400,
    );
    expect(segments.at(-1)?.end).toEqual({ x: 0, z: 1576 });
  });

  test("fails closed for an unsplit sub-minimum utility connection", () => {
    expect(splitUtilityConnection({ prefab: "Small Sewage Pipe", start: { x: 0, z: 0 }, end: { x: 7.999, z: 0 } })).toEqual([]);
  });

  test("does not emit a sub-minimum float32 remainder", () => {
    const segments = splitUtilityConnection({ prefab: "Small Sewage Pipe", start: { x: -428.08667, z: -860.865356 }, end: { x: -436.08471858344257, z: -860.6886221410658 } });
    expect(segments).toEqual([]);
  });
});
