import {
  buildMayorCandidateSet,
  candidateQuery,
  validateZoningCandidate,
  zoningCandidateRemainsValid,
} from "../../src/main/services/ai-mayor/action-candidates";
import type { SpatialSiteDetail, SpatialTile, SpatialZoningCell } from "../../src/main/services/ai-mayor/spatial/types";

const ownedTile: SpatialTile = {
  entity: { index: 1, version: 1 },
  owned: true,
  bounds: { min: { x: -200, z: -200 }, max: { x: 200, z: 200 } },
  center: { x: 0, z: 0 },
  polygon: [
    { x: -200, z: -200 },
    { x: 200, z: -200 },
    { x: 200, z: 200 },
    { x: -200, z: 200 },
  ],
};

const cells = (): SpatialZoningCell[] =>
  Array.from({ length: 25 }, (_, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    return {
      block: { index: 50, version: 1 },
      index,
      position: { x: 34 + column * 8, y: 0, z: -16 + row * 8 },
      visible: true,
      roadside: true,
      occupied: false,
      blocked: false,
      overridden: false,
      zoneType: 0,
    };
  });

const snapshot = {
  demand: { residential: { low: 0, medium: 0, high: 0 }, commercial: 100, industrial: 100, office: 100 },
  planningCatalog: {
    zoneTypes: [
      { name: "EU Residential Low", areaType: "Residential", office: false },
      { name: "EU Commercial Low", areaType: "Commercial", office: false },
      { name: "Industrial Manufacturing", areaType: "Industrial", office: false },
    ],
    roadAnchors: [
      {
        entity: { index: 10, version: 2 },
        prefab: "Small Road",
        start: { x: 0, z: 0 },
        end: { x: 100, z: 0 },
      },
    ],
  },
};

const detail = (zoningCells = cells()): SpatialSiteDetail => ({
  center: { x: 50, z: 0 },
  radius: 128,
  terrain: {
    resolution: 2,
    bounds: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 },
    cellSize: { x: 200, z: 200 },
    heights: [0, 0, 0, 0],
    waterDepths: [0, 0, 0, 0],
    groundWater: [0, 0, 0, 0],
    groundWaterPollution: [0, 0, 0, 0],
    windSpeed: [0, 0, 0, 0],
  },
  roadGraph: { nodes: [], edges: [] },
  buildings: [],
  zoningCells,
});

describe("Mayor actionable planning candidates", () => {
  test("builds stable candidate ids without exposing raw coordinates", () => {
    const first = buildMayorCandidateSet({ snapshot, detail: detail(), ownedTiles: [ownedTile] });
    const second = buildMayorCandidateSet({ snapshot, detail: detail(), ownedTiles: [ownedTile] });
    expect(first.candidates.length).toBe(3);
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(
      second.candidates.map((candidate) => candidate.id),
    );
    expect(first.candidates.map((candidate) => candidate.areaType)).toEqual([
      "Residential",
      "Commercial",
      "Industrial",
    ]);
    expect(JSON.stringify(first.candidates)).not.toContain('"x"');
    expect(JSON.stringify(first.candidates)).not.toContain('"z"');
    expect(first.candidates.every((candidate) => candidate.validationStatus === "validated")).toBe(true);
  });

  test("revalidation rejects a candidate after one covered cell becomes occupied", () => {
    const set = buildMayorCandidateSet({ snapshot, detail: detail(), ownedTiles: [ownedTile] });
    const candidate = set.registry.get(set.candidates[0].id);
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("expected candidate");
    const changed = cells();
    changed[12] = { ...changed[12], occupied: true };
    expect(zoningCandidateRemainsValid(candidate, detail(changed), [ownedTile])).toBe(false);
  });

  test("derives a bounded detail query from road anchors", () => {
    expect(candidateQuery(snapshot)).toEqual({ x: 50, z: 0, radius: 210 });
  });

  test("supplies bounded road expansion candidates when all existing frontage is occupied", () => {
    const occupied = cells().map((cell) => ({ ...cell, occupied: true }));
    const expandedDetail = detail(occupied);
    expandedDetail.roadGraph.edges = [
      {
        entity: { index: 10, version: 2 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 1, version: 1 },
        endNode: { index: 2, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: 100, z: 0 },
        length: 100,
      },
    ];
    const result = buildMayorCandidateSet({ snapshot, detail: expandedDetail, ownedTiles: [ownedTile] });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        actionType: "build_road",
        candidateType: "road_expansion",
        approximateLength: 80,
        approximateNewFrontage: 80,
        validationStatus: "validated",
      }),
    );
    expect(result.candidates[0].id).toMatch(/^E-/);
    expect(result.registry.get(result.candidates[0].id)?.action).toEqual(
      expect.objectContaining({ type: "build_road", prefab: "Small Road" }),
    );
  });

  test("rejects expansion candidates on sampled water", () => {
    const watery = detail(cells());
    watery.zoningCells = cells().map((cell) => ({ ...cell, occupied: true }));
    watery.terrain.waterDepths = [1, 1, 1, 1];
    const result = buildMayorCandidateSet({ snapshot, detail: watery, ownedTiles: [ownedTile] });
    expect(result.candidates).toEqual([]);
  });

  test("uses a bounded smaller contiguous residual frontage patch when the normal minimum is too strict", () => {
    const residual = cells().slice(0, 4);
    const noResidual = buildMayorCandidateSet({
      snapshot,
      detail: detail(residual),
      ownedTiles: [ownedTile],
      urbanDesignPolicy: { developmentPolicy: "infill", includeExistingFrontage: true, growthDomain: "industrial" },
    });
    expect(noResidual.candidates).toEqual([]);
    const recovered = buildMayorCandidateSet({
      snapshot,
      detail: detail(residual),
      ownedTiles: [ownedTile],
      minimumZoningCells: 4,
      urbanDesignPolicy: { developmentPolicy: "infill", includeExistingFrontage: true, growthDomain: "industrial" },
    });
    expect(recovered.candidates).toHaveLength(3);
    expect(recovered.candidates[0]).toEqual(expect.objectContaining({ areaType: "Industrial", approximateCells: 4 }));
    expect(recovered.registry.get(recovered.candidates[0].id)?.frontageRoad).toEqual({
      entity: { index: 10, version: 2 },
      prefab: "Small Road",
    });
  });

  test("filters generator false-positive cells with the canonical frontage predicate", () => {
    const mixed = cells()
      .slice(0, 4)
      .map((cell, index) => (index === 2 ? { ...cell, roadside: false } : cell));
    const result = buildMayorCandidateSet({
      snapshot,
      detail: detail(mixed),
      ownedTiles: [ownedTile],
      minimumZoningCells: 4,
      urbanDesignPolicy: { developmentPolicy: "infill", includeExistingFrontage: true, growthDomain: "residential" },
    });
    expect(result.candidates).toEqual([]);
  });

  test("allows a bounded frontage subset when it still meets the minimum", () => {
    const mixed = cells()
      .slice(0, 4)
      .map((cell, index) => (index === 2 ? { ...cell, roadside: false } : cell));
    const result = buildMayorCandidateSet({
      snapshot,
      detail: detail(mixed),
      ownedTiles: [ownedTile],
      minimumZoningCells: 3,
      urbanDesignPolicy: { developmentPolicy: "infill", includeExistingFrontage: true, growthDomain: "residential" },
    });
    expect(result.candidates[0]).toEqual(expect.objectContaining({ approximateCells: 3 }));
    const candidate = result.registry.get(result.candidates[0]?.id ?? "");
    expect(candidate?.zoningCells).toHaveLength(3);
    expect(candidate?.zoningCells).not.toContainEqual({ block: { index: 50, version: 1 }, index: 2 });
  });

  test("revalidates an L4 residual patch against the exact registered cells", () => {
    const residual = cells().slice(0, 4);
    const recovered = buildMayorCandidateSet({
      snapshot,
      detail: detail(residual),
      ownedTiles: [ownedTile],
      minimumZoningCells: 4,
      urbanDesignPolicy: { developmentPolicy: "infill", includeExistingFrontage: true, growthDomain: "residential" },
    });
    const candidate = recovered.registry.get(recovered.candidates[0]?.id ?? "");
    expect(candidate?.zoningCells).toHaveLength(4);
    if (!candidate) throw new Error("expected residual candidate");
    expect(validateZoningCandidate(candidate, detail(residual), [ownedTile])).toEqual({
      ok: true,
      cells: residual,
    });

    const occupied = residual.map((cell, index) => (index === 2 ? { ...cell, occupied: true } : cell));
    expect(validateZoningCandidate(candidate, detail(occupied), [ownedTile])).toEqual({
      ok: false,
      code: "residual_zoning_revalidation_failure",
      reason: "occupied_cell",
    });
  });

  test("fails closed when an exact residual cell payload is missing", () => {
    const residual = cells().slice(0, 4);
    const recovered = buildMayorCandidateSet({
      snapshot,
      detail: detail(residual),
      ownedTiles: [ownedTile],
      minimumZoningCells: 4,
      urbanDesignPolicy: { developmentPolicy: "infill", includeExistingFrontage: true, growthDomain: "residential" },
    });
    const candidate = recovered.registry.get(recovered.candidates[0]?.id ?? "");
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("expected residual candidate");
    expect(validateZoningCandidate({ ...candidate, zoningCells: undefined }, detail(residual), [ownedTile])).toEqual({
      ok: false,
      code: "residual_zoning_payload_incomplete",
      reason: "missing_exact_cells",
    });
  });

  test("keeps deterministic heading alternatives bounded and canonical", () => {
    const occupied = cells().map((cell) => ({ ...cell, occupied: true }));
    const expandedDetail = detail(occupied);
    expandedDetail.roadGraph.edges = [
      {
        entity: { index: 10, version: 2 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 1, version: 1 },
        endNode: { index: 2, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: 100, z: 0 },
        length: 100,
      },
    ];
    const diagnostics: import("../../src/main/services/ai-mayor/action-candidates").RoadExpansionAttemptDiagnostic[] =
      [];
    const result = buildMayorCandidateSet({
      snapshot,
      detail: expandedDetail,
      ownedTiles: [ownedTile],
      forceRoadExpansion: true,
      roadExpansionSource: { entity: { index: 10, version: 2 }, endpoint: { x: 100, z: 0 } },
      urbanDesignPolicy: {
        developmentPolicy: "expand_first",
        includeExistingFrontage: false,
        growthDomain: "industrial",
        roadExpansion: {
          seed: "recovery-test",
          preferredHeadingDegrees: 0,
          headingOffsetsDegrees: [0, 15, -15, 30, -30, 90, -90],
          headingToleranceDegrees: 0,
          targetLengths: [60, 80, 100],
          topologyPreference: "grid_axis",
          hierarchyPreference: "fine_grain",
        },
      },
      roadExpansionDiagnostics: diagnostics,
    });
    expect(diagnostics.length).toBeLessThanOrEqual(21);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.growthDomain === "industrial")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.sourceRoad?.index === 10)).toBe(true);
  });
});
