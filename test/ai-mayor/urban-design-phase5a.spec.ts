import { buildMayorCandidateSet } from "../../src/main/services/ai-mayor/action-candidates";
import type { SpatialSiteDetail, SpatialTile } from "../../src/main/services/ai-mayor/spatial/types";
import {
  createEmptyUrbanDesignNoveltyMemory,
  recordSuccessfulUrbanDesignLifecycle,
} from "../../src/main/services/ai-mayor/urban-design/novelty";
import {
  generateUrbanDesignProposal,
  type UrbanDesignProposal,
  UrbanDesignProposalSchema,
} from "../../src/main/services/ai-mayor/urban-design/proposal";
import {
  buildUrbanDesignPlanningEnvelope,
  realizeUrbanDesignProposal,
  resolveUrbanPlanningAnchor,
  URBAN_DESIGN_MAX_REALIZED_ROAD_CANDIDATES,
  URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES,
  URBAN_DESIGN_MAX_REALIZED_ZONING_CANDIDATES,
  UrbanDesignPlanningEnvelopeSchema,
} from "../../src/main/services/ai-mayor/urban-design/realization";
import {
  PlanningAnchorSchema,
  type UrbanPlanningAnchor,
  type UrbanSiteContext,
  UrbanSiteContextSchema,
} from "../../src/main/services/ai-mayor/urban-design/site-context";

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

const snapshot = {
  demand: { residential: { low: 0, medium: 0, high: 0 }, commercial: 100, industrial: 100, office: 100 },
  planningCatalog: {
    zoneTypes: [
      { name: "Residential", areaType: "Residential", office: false },
      { name: "Commercial", areaType: "Commercial", office: false },
    ],
    roadAnchors: [
      { entity: { index: 10, version: 2 }, prefab: "Small Road", start: { x: 0, z: 0 }, end: { x: 100, z: 0 } },
    ],
  },
};

const detail: SpatialSiteDetail = {
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
  zoningCells: Array.from({ length: 25 }, (_, index) => ({
    block: { index: 50, version: 1 },
    index,
    position: { x: 34 + (index % 5) * 8, y: 0, z: -16 + Math.floor(index / 5) * 8 },
    visible: true,
    roadside: true,
    occupied: false,
    blocked: false,
    overridden: false,
    zoneType: 0,
  })),
};

const anchor = PlanningAnchorSchema.parse({
  id: "anchor-road-10-2",
  kind: "road_endpoint",
  sourceId: "road-10-2",
  sourceEntity: { index: 10, version: 2 },
  rank: 0,
  orientation: "east_west",
  areaClass: "edge",
  terrainProfile: "flat",
  waterfrontEligible: false,
  availableFrontageCells: 25,
  adaptationHints: ["follow_existing_roads"],
}) as UrbanPlanningAnchor;

const context = UrbanSiteContextSchema.parse({
  version: 1,
  siteId: "site-1",
  snapshotRevision: "snapshot-1",
  areaClass: "edge",
  buildableAreaBand: "medium",
  ownedLand: {
    tileCount: 1,
    areaBand: "medium",
    boundaryBand: "simple",
    buildableCoverage: 0.5,
    availableFrontageCells: 25,
  },
  terrain: {
    availability: "available",
    sampleCount: 4,
    slopeProfile: "flat",
    roughness: "smooth",
    meanSlopePercent: 0,
    maxSlopePercent: 0,
  },
  water: { availability: "unavailable", relationship: "none", opportunity: false, waterSampleBand: "none" },
  roadContext: {
    edgeCount: 1,
    nodeCount: 2,
    endpointCount: 1,
    gatewayCount: 0,
    highwayEvidence: "absent",
    dominantOrientation: "east_west",
    orientationSpread: "narrow",
    geometry: "sparse",
    hierarchyEvidence: ["road_endpoint"],
  },
  development: { buildingCount: 0, occupiedZoningCells: 0, developedClusterCount: 0, extentBand: "small" },
  frontage: {
    visibleRoadsideCells: 25,
    availableRoadsideCells: 25,
    opportunityBand: "medium",
    source: "spatial_zoning_cells",
  },
  adjacency: { residential: "absent", commercial: "absent", industrial: "absent", source: "snapshot_catalog" },
  pollution: { availability: "unavailable", note: "not available" },
  constraints: ["owned_land_boundary"],
  opportunities: ["road_endpoint"],
  unavailableSignals: ["pollution"],
  anchorSeeds: [],
}) as UrbanSiteContext;

function proposal(primary: string, overrides: Partial<UrbanDesignProposal> = {}): UrbanDesignProposal {
  const defaults = {
    "orthogonal-grid": {
      motif: "perimeter-block",
      topology: "grid",
      blockScale: "medium_large",
      roadHierarchy: "balanced",
      curvature: "orthogonal",
      density: "gradient",
      commercial: "main_street",
      green: "minimal",
    },
    "terrain-organic": {
      motif: "contour-branch",
      topology: "organic",
      blockScale: "mixed",
      roadHierarchy: "collector_spine",
      curvature: "high",
      density: "medium",
      commercial: "nodes",
      green: "distributed",
    },
    "waterfront-linear": {
      motif: "waterfront-spine",
      topology: "linear",
      blockScale: "medium",
      roadHierarchy: "collector_spine",
      curvature: "shoreline_adapted",
      density: "gradient",
      commercial: "main_street",
      green: "buffer",
    },
    "garden-neighborhood": {
      motif: "garden-loop",
      topology: "organic",
      blockScale: "small_medium",
      roadHierarchy: "local_first",
      curvature: "moderate",
      density: "low",
      commercial: "none",
      green: "distributed",
    },
    "compact-urban": {
      motif: "civic-square-frame",
      topology: "node",
      blockScale: "small",
      roadHierarchy: "fine_grain",
      curvature: "moderate",
      density: "high",
      commercial: "mixed_core",
      green: "central",
    },
  }[primary] ?? {
    motif: "perimeter-block",
    topology: "grid",
    blockScale: "medium",
    roadHierarchy: "balanced",
    curvature: "low",
    density: "medium",
    commercial: "nodes",
    green: "distributed",
  };
  return UrbanDesignProposalSchema.parse({
    status: "proposal",
    proposalId: `proposal-${primary}`,
    intentId: "intent-1",
    siteId: "site-1",
    anchorId: anchor.id,
    snapshotRevision: "snapshot-1",
    grammar: { primary, primaryVersion: "1.0.0" },
    designSummary: "semantic district proposal",
    motif: defaults.motif,
    designSignature: `${primary}:${defaults.motif}:${defaults.topology}`,
    semantics: {
      topology: defaults.topology,
      blockScale: defaults.blockScale,
      roadHierarchy: defaults.roadHierarchy,
      curvature: defaults.curvature,
      density: defaults.density,
      commercial: defaults.commercial,
      green: defaults.green,
    },
    terrainWaterfrontAdaptations: ["follow_existing_roads"],
    parameterSample: { blockScale: 40 },
    tradeoffs: ["bounded planner choice"],
    activeCandidates: [],
    futureStages: [],
    utilityServiceImplications: ["check service headroom"],
    estimatedCapacity: { band: "medium", approximateCells: 25 },
    estimatedCost: { band: "unknown" },
    metrics: null,
    metricState: "semantic_only",
    constraints: ["owned_land_boundary"],
    validation: { state: "partial", validatedCandidateCount: 0, rejectionReasons: [] },
    ...overrides,
  });
}

describe("Urban Design Language Phase 5A", () => {
  test("builds a bounded coordinate-free planning envelope", () => {
    const envelope = buildUrbanDesignPlanningEnvelope(proposal("orthogonal-grid"), anchor);
    expect(UrbanDesignPlanningEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).not.toHaveProperty("x");
    expect(envelope).not.toHaveProperty("z");
    expect(envelope.topology).toBe("grid");
  });

  test("realizes candidates through the existing registry with optional UDL metadata", () => {
    const result = realizeUrbanDesignProposal({
      proposal: proposal("compact-urban"),
      context,
      anchor,
      snapshot,
      detail,
      ownedTiles: [ownedTile],
    });
    expect(result.result.status).toBe("realized");
    expect(result.result.candidateIds.length).toBeGreaterThan(0);
    expect(result.result.candidateIds.length).toBeLessThanOrEqual(URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES);
    for (const id of result.result.candidateIds) {
      expect(result.candidateSet.registry.has(id)).toBe(true);
      expect(result.candidateSet.registry.get(id)?.summary.urbanDesign).toMatchObject({
        primaryStyle: "compact-urban",
        anchorId: anchor.id,
      });
    }
    expect(result.result.candidateMetadata[0].realizationGroupId).toBe("udl-proposal-compact-urban");
  });

  test("resolves a gateway node to its incident catalog road and generates expansion without a matching patch", () => {
    const gatewayAnchor = PlanningAnchorSchema.parse({
      ...anchor,
      id: "anchor-gateway-road-99-1",
      kind: "gateway",
      sourceId: "road-99-1",
      sourceEntity: { index: 99, version: 1 },
    }) as UrbanPlanningAnchor;
    const gatewaySnapshot = {
      ...snapshot,
      planningCatalog: {
        ...snapshot.planningCatalog,
        roadAnchors: [
          ...snapshot.planningCatalog.roadAnchors,
          { entity: { index: 20, version: 1 }, prefab: "Small Road", start: { x: 100, z: 0 }, end: { x: 200, z: 0 } },
        ],
      },
    };
    const gatewayDetail = {
      ...detail,
      roadGraph: {
        nodes: [],
        edges: [
          {
            entity: { index: 20, version: 1 },
            prefab: "Small Road",
            native: true,
            startNode: { index: 99, version: 1 },
            endNode: { index: 98, version: 1 },
            start: { x: 100, z: 0 },
            end: { x: 200, z: 0 },
            length: 100,
          },
        ],
      },
    };
    expect(
      resolveUrbanPlanningAnchor({ anchor: gatewayAnchor, snapshot: gatewaySnapshot, detail: gatewayDetail }),
    ).toEqual({
      status: "resolved",
      sourceType: "incident_road_edge",
      source: { entity: { index: 20, version: 1 }, endpoint: { x: 100, z: 0 } },
    });
    const result = realizeUrbanDesignProposal({
      proposal: proposal("compact-urban", { anchorId: gatewayAnchor.id }),
      context: UrbanSiteContextSchema.parse({ ...context, areaClass: "gateway" }),
      anchor: gatewayAnchor,
      snapshot: gatewaySnapshot,
      detail: gatewayDetail,
      ownedTiles: [ownedTile],
    });
    expect(result.result.status).toBe("realized");
    expect(result.result.candidateIds.some((id) => id.startsWith("E-20-1-"))).toBe(true);
    expect(result.candidateSet.registry.has(result.result.candidateIds[0])).toBe(true);
  });

  test("resolves canonical road identity without local detail or display-id parsing", () => {
    const canonicalAnchor = PlanningAnchorSchema.parse({
      ...anchor,
      sourceId: "road-node-343041:1",
      sourceEntity: { index: 343041, version: 1 },
      canonicalSource: {
        kind: "road_node",
        node: { index: 343041, version: 1 },
        incidentRoads: [{ edge: { index: 10, version: 2 }, endpointRole: "start" }],
      },
    }) as UrbanPlanningAnchor;
    expect(
      resolveUrbanPlanningAnchor({
        anchor: canonicalAnchor,
        snapshot,
        detail: { ...detail, roadGraph: { nodes: [], edges: [] } },
      }),
    ).toEqual({
      status: "resolved",
      sourceType: "canonical_road_relation",
      source: { entity: { index: 10, version: 2 }, endpoint: { x: 0, z: 0 } },
    });
  });

  test("retains all central-node road relations instead of selecting an arbitrary incident edge", () => {
    const canonicalAnchor = PlanningAnchorSchema.parse({
      ...anchor,
      kind: "central_node",
      sourceId: "road-node-343045:1",
      sourceEntity: { index: 343045, version: 1 },
      canonicalSource: {
        kind: "road_node",
        node: { index: 343045, version: 1 },
        incidentRoads: [
          { edge: { index: 10, version: 2 }, endpointRole: "start" },
          { edge: { index: 11, version: 1 }, endpointRole: "end" },
        ],
      },
    }) as UrbanPlanningAnchor;
    const resolved = resolveUrbanPlanningAnchor({
      anchor: canonicalAnchor,
      snapshot: {
        ...snapshot,
        planningCatalog: {
          ...snapshot.planningCatalog,
          roadAnchors: [
            ...snapshot.planningCatalog.roadAnchors,
            { entity: { index: 11, version: 1 }, prefab: "Small Road", start: { x: 0, z: 10 }, end: { x: 0, z: 110 } },
          ],
        },
      },
      detail,
    });
    expect(resolved).toEqual({
      status: "resolved",
      sourceType: "canonical_road_relation",
      source: { entity: { index: 10, version: 2 }, endpoint: { x: 0, z: 0 } },
      sources: [
        { entity: { index: 10, version: 2 }, endpoint: { x: 0, z: 0 } },
        { entity: { index: 11, version: 1 }, endpoint: { x: 0, z: 110 } },
      ],
    });
  });

  test("central node with no reusable candidate enters bounded style-aware expansion", () => {
    const centralAnchor = PlanningAnchorSchema.parse({
      ...anchor,
      id: "anchor-central-node-10-2",
      kind: "central_node",
      sourceId: "road-node-343035:1",
      sourceEntity: { index: 343035, version: 1 },
      canonicalSource: {
        kind: "road_node",
        node: { index: 343035, version: 1 },
        incidentRoads: [
          { edge: { index: 10, version: 2 }, endpointRole: "start" },
          { edge: { index: 11, version: 1 }, endpointRole: "end" },
        ],
      },
    }) as UrbanPlanningAnchor;
    const centralSnapshot = {
      ...snapshot,
      planningCatalog: {
        ...snapshot.planningCatalog,
        roadAnchors: [
          ...snapshot.planningCatalog.roadAnchors,
          { entity: { index: 11, version: 1 }, prefab: "Small Road", start: { x: 0, z: 100 }, end: { x: 0, z: 200 } },
        ],
      },
    };
    const generated = generateUrbanDesignProposal({
      context,
      anchor: centralAnchor,
      grammarId: "orthogonal-grid",
      developmentEmphasis: "edge_expansion",
      seed: "central-node-expansion",
    });
    expect(generated.status).toBe("proposal");
    if (generated.status !== "proposal") throw new Error("expected proposal");
    const result = realizeUrbanDesignProposal({
      proposal: generated,
      context,
      anchor: centralAnchor,
      snapshot: centralSnapshot,
      detail,
      ownedTiles: [ownedTile],
    });
    expect(result.result.envelope).toMatchObject({ topology: "grid", curvature: "orthogonal" });
    expect(result.result.status).toBe("realized");
    expect(result.result.candidateIds.some((id) => id.startsWith("E-10-2-") || id.startsWith("E-11-1-"))).toBe(true);
    expect(result.candidateSet.candidates.some((candidate) => candidate.actionType === "build_road")).toBe(true);
  });

  test("failed expand-first generation reports post-generation failure, not reuse absence", () => {
    const generated = generateUrbanDesignProposal({
      context,
      anchor,
      grammarId: "orthogonal-grid",
      developmentEmphasis: "edge_expansion",
      seed: "blocked-expansion",
    });
    expect(generated.status).toBe("proposal");
    if (generated.status !== "proposal") throw new Error("expected proposal");
    const blockedDetail = {
      ...detail,
      zoningCells: detail.zoningCells.map((cell) => ({ ...cell, visible: false })),
    };
    const result = realizeUrbanDesignProposal({
      proposal: generated,
      context,
      anchor,
      snapshot,
      detail: blockedDetail,
      ownedTiles: [ownedTile],
    });
    expect(result.result.status).toBe("no_realization");
    expect(result.result.constraintReasons).toContain("no_valid_road_candidate");
    expect(result.result.constraintReasons).not.toContain("no_existing_validated_candidate_matches_anchor");
    expect(result.result.roadExpansionDiagnostics?.length).toBeGreaterThan(0);
    expect(result.result.roadExpansionDiagnostics?.every((attempt) => attempt.outcome === "rejected")).toBe(true);
  });

  test("fails closed for stale canonical source identity without falling back to display text or proximity", () => {
    const staleAnchor = PlanningAnchorSchema.parse({
      ...anchor,
      sourceId: "road-10-2",
      sourceEntity: { index: 999, version: 1 },
      canonicalSource: {
        kind: "road_node",
        node: { index: 999, version: 1 },
        incidentRoads: [{ edge: { index: 999, version: 1 }, endpointRole: "start" }],
      },
    }) as UrbanPlanningAnchor;
    expect(resolveUrbanPlanningAnchor({ anchor: staleAnchor, snapshot, detail })).toEqual({
      status: "unresolved",
      reason: "anchor_source_has_no_catalog_road",
    });
  });

  test("fails closed when an anchor source has no incident road or catalog road", () => {
    const missing = resolveUrbanPlanningAnchor({
      anchor: { ...anchor, sourceEntity: { index: 55, version: 1 } },
      snapshot,
      detail,
    });
    expect(missing).toEqual({ status: "unresolved", reason: "anchor_source_missing" });
    const missingCatalog = resolveUrbanPlanningAnchor({
      anchor: { ...anchor, sourceEntity: { index: 99, version: 1 } },
      snapshot,
      detail: {
        ...detail,
        roadGraph: {
          nodes: [],
          edges: [
            {
              entity: { index: 77, version: 1 },
              prefab: "Small Road",
              native: true,
              startNode: { index: 99, version: 1 },
              endNode: { index: 98, version: 1 },
              start: { x: 0, z: 0 },
              end: { x: 100, z: 0 },
              length: 100,
            },
          ],
        },
      },
    });
    expect(missingCatalog).toEqual({ status: "unresolved", reason: "anchor_source_has_no_catalog_road" });
  });

  test("grammar envelopes preserve structural preferences without a second geometry engine", () => {
    const envelopes = ["orthogonal-grid", "terrain-organic", "garden-neighborhood", "compact-urban"].map((style) =>
      buildUrbanDesignPlanningEnvelope(proposal(style), anchor),
    );
    expect(envelopes.map((item) => item.topology)).toEqual(["grid", "organic", "organic", "node"]);
    expect(envelopes.map((item) => item.density)).toEqual(["gradient", "medium", "low", "high"]);
    expect(envelopes.map((item) => item.roadHierarchy)).toEqual([
      "balanced",
      "collector_spine",
      "local_first",
      "fine_grain",
    ]);
  });

  test("Phase 6 deterministic A/B comparison realizes style-aware road geometry", () => {
    const cases = [
      { style: "orthogonal-grid", seed: "phase6-orthogonal-20260911" },
      { style: "terrain-organic", seed: "phase6-terrain-organic-20260911" },
    ] as const;
    const realized = cases.map(({ style, seed }) => {
      const generated = generateUrbanDesignProposal({
        context,
        anchor,
        grammarId: style,
        developmentEmphasis: "edge_expansion",
        seed,
      });
      expect(generated.status).toBe("proposal");
      if (generated.status !== "proposal") throw new Error(`expected ${style} proposal`);
      const realization = realizeUrbanDesignProposal({
        proposal: generated,
        context,
        anchor,
        snapshot,
        detail,
        ownedTiles: [ownedTile],
      });
      expect(realization.result.status).toBe("realized");
      return { style, seed, proposal: generated, realization };
    });
    const [orthogonal, organic] = realized;
    const repeated = cases.map(({ style, seed }) => {
      const generated = generateUrbanDesignProposal({
        context,
        anchor,
        grammarId: style,
        developmentEmphasis: "edge_expansion",
        seed,
      });
      if (generated.status !== "proposal") throw new Error(`expected ${style} proposal`);
      return realizeUrbanDesignProposal({
        proposal: generated,
        context,
        anchor,
        snapshot,
        detail,
        ownedTiles: [ownedTile],
      });
    });
    expect(repeated.map((item) => item.result)).toEqual(realized.map((item) => item.realization.result));
    expect(orthogonal.realization.result.envelope).toMatchObject({
      curvature: "orthogonal",
      roadHierarchy: "balanced",
    });
    expect(["grid", "filtered"]).toContain(orthogonal.realization.result.envelope.topology);
    expect(organic.realization.result.envelope).toMatchObject({
      topology: "organic",
      curvature: "high",
      roadHierarchy: "collector_spine",
    });
    const geometry = (item: (typeof realized)[number]) =>
      item.realization.result.candidateIds.map((candidateId) => {
        const candidate = item.realization.candidateSet.registry.get(candidateId);
        return { candidateId, action: candidate?.action };
      });
    const orthogonalGeometry = geometry(orthogonal);
    const organicGeometry = geometry(organic);
    console.log(
      "PHASE6_AB_EVIDENCE",
      JSON.stringify({
        orthogonal: {
          seed: orthogonal.seed,
          anchor: anchor.id,
          motif: orthogonal.proposal.motif,
          envelope: orthogonal.realization.result.envelope,
          candidates: orthogonalGeometry,
        },
        terrainOrganic: {
          seed: organic.seed,
          anchor: anchor.id,
          motif: organic.proposal.motif,
          envelope: organic.realization.result.envelope,
          candidates: organicGeometry,
        },
      }),
    );
    expect(orthogonalGeometry).not.toEqual(organicGeometry);
    expect(orthogonalGeometry.every((item) => item.action?.type === "build_road")).toBe(true);
    expect(organicGeometry.every((item) => item.action?.type === "build_road")).toBe(true);
    expect(orthogonal.realization.result.candidateIds).not.toEqual(organic.realization.result.candidateIds);
    expect(orthogonal.realization.candidateSet.candidates[0]).toMatchObject({
      roadHeadingDegrees: expect.any(Number),
      roadHeadingDeltaDegrees: expect.any(Number),
      roadLength: expect.any(Number),
      roadTopologyRole: "cross_link",
    });
    expect(organic.realization.candidateSet.candidates[0]).toMatchObject({
      roadHeadingDegrees: expect.any(Number),
      roadHeadingDeltaDegrees: expect.any(Number),
      roadLength: expect.any(Number),
      roadTopologyRole: "contour_connector",
    });
  });

  test("development policy controls zoning and road candidate coexistence", () => {
    const generate = (developmentEmphasis: "infill" | "edge_expansion" | "balanced") => {
      const result = generateUrbanDesignProposal({
        context,
        anchor,
        grammarId: "orthogonal-grid",
        developmentEmphasis,
        seed: `phase6-policy-${developmentEmphasis}`,
      });
      if (result.status !== "proposal") throw new Error("expected a proposal");
      return realizeUrbanDesignProposal({
        proposal: result,
        context,
        anchor,
        snapshot,
        detail,
        ownedTiles: [ownedTile],
      });
    };
    const infill = generate("infill");
    const expandFirst = generate("edge_expansion");
    const mixed = generate("balanced");
    expect(infill.candidateSet.candidates.every((candidate) => candidate.actionType === "zone")).toBe(true);
    expect(expandFirst.candidateSet.candidates.every((candidate) => candidate.actionType === "build_road")).toBe(true);
    expect(mixed.candidateSet.candidates.some((candidate) => candidate.actionType === "zone")).toBe(true);
    expect(mixed.candidateSet.candidates.some((candidate) => candidate.actionType === "build_road")).toBe(true);
  });

  test("legacy road expansion keeps the tangent 80m fallback without UDL preferences", () => {
    const noFrontageDetail = { ...detail, zoningCells: [] };
    const result = realizeUrbanDesignProposal({
      proposal: proposal("orthogonal-grid"),
      context,
      anchor,
      snapshot,
      detail: noFrontageDetail,
      ownedTiles: [ownedTile],
    });
    const road = result.candidateSet.registry.get(result.result.candidateIds[0]);
    expect(road?.action).toMatchObject({ type: "build_road", x1: 100, z1: 0, x2: 180, z2: 0 });
    expect(road?.summary.approximateLength).toBe(80);
  });

  test("preferred road geometry remains bounded by ownership and finite candidate caps", () => {
    const constrainedTile = {
      ...ownedTile,
      bounds: { min: { x: -200, z: -200 }, max: { x: 120, z: 200 } },
      polygon: [
        { x: -200, z: -200 },
        { x: 120, z: -200 },
        { x: 120, z: 200 },
        { x: -200, z: 200 },
      ],
    };
    const generated = generateUrbanDesignProposal({
      context,
      anchor,
      grammarId: "terrain-organic",
      developmentEmphasis: "edge_expansion",
      seed: "phase6-safety-bound-20260911",
    });
    if (generated.status !== "proposal") throw new Error("expected a proposal");
    const result = realizeUrbanDesignProposal({
      proposal: generated,
      context,
      anchor,
      snapshot,
      detail,
      ownedTiles: [constrainedTile],
    });
    expect(result.result.status).toBe("no_realization");
    expect(result.result.candidateIds).toHaveLength(0);
    expect(result.candidateSet.registry.size).toBeLessThanOrEqual(3);
  });

  test("waterfront without verified water fails closed without fabricated geometry", () => {
    const waterfront = proposal("waterfront-linear");
    const result = realizeUrbanDesignProposal({
      proposal: waterfront,
      context,
      anchor: { ...anchor, waterfrontEligible: true },
      snapshot,
      detail,
      ownedTiles: [ownedTile],
    });
    expect(result.result.status).toBe("no_realization");
    expect(result.result.candidateIds).toEqual([]);
    expect(result.result.constraintReasons).toContain("verified_waterfront_required");
  });

  test("waterfront with verified context preserves waterfront preference while using existing candidates", () => {
    const waterfrontContext = UrbanSiteContextSchema.parse({
      ...context,
      areaClass: "waterfront",
      water: { availability: "available", relationship: "river_edge", opportunity: true, waterSampleBand: "small" },
    });
    const waterfrontAnchor = { ...anchor, waterfrontEligible: true };
    const result = realizeUrbanDesignProposal({
      proposal: proposal("waterfront-linear"),
      context: waterfrontContext,
      anchor: waterfrontAnchor,
      snapshot,
      detail,
      ownedTiles: [ownedTile],
    });
    expect(result.result.status).toBe("realized");
    expect(result.result.envelope.curvature).toBe("shoreline_adapted");
    expect(result.result.candidateIds.every((id) => result.candidateSet.registry.has(id))).toBe(true);
  });

  test("candidate gate models collision, ownership and native-preview rejection", () => {
    const result = realizeUrbanDesignProposal({
      proposal: proposal("terrain-organic"),
      context,
      anchor,
      snapshot,
      detail,
      ownedTiles: [ownedTile],
      candidateGate: () => false,
    });
    expect(result.result.status).toBe("no_realization");
    expect(result.result.rejectedElements.length).toBeGreaterThan(0);
  });

  test("unowned land fails closed without publishing candidates", () => {
    const result = realizeUrbanDesignProposal({
      proposal: proposal("orthogonal-grid"),
      context,
      anchor,
      snapshot,
      detail,
      ownedTiles: [],
    });
    expect(result.result.status).toBe("no_realization");
    expect(result.result.constraintReasons).toContain("no_owned_buildable_land");
    expect(result.candidateSet.registry.size).toBe(0);
  });

  test("bounds road/zoning output and remains deterministic", () => {
    const input = {
      proposal: proposal("garden-neighborhood"),
      context,
      anchor,
      snapshot,
      detail,
      ownedTiles: [ownedTile],
    };
    const first = realizeUrbanDesignProposal(input);
    const second = realizeUrbanDesignProposal(input);
    expect(first.result).toEqual(second.result);
    expect(first.result.candidateIds.length).toBeLessThanOrEqual(
      URBAN_DESIGN_MAX_REALIZED_ROAD_CANDIDATES + URBAN_DESIGN_MAX_REALIZED_ZONING_CANDIDATES,
    );
  });

  test("novelty writes only after an explicit successful lifecycle hook", () => {
    const memory = createEmptyUrbanDesignNoveltyMemory();
    const result = proposal("compact-urban");
    expect(
      recordSuccessfulUrbanDesignLifecycle({ memory, result, lifecycle: "realized", successful: false }).entries,
    ).toHaveLength(0);
    expect(
      recordSuccessfulUrbanDesignLifecycle({ memory, result, lifecycle: "executed", successful: true }).entries,
    ).toHaveLength(1);
    expect(
      recordSuccessfulUrbanDesignLifecycle({
        memory: recordSuccessfulUrbanDesignLifecycle({ memory, result, lifecycle: "executed", successful: true }),
        result,
        lifecycle: "executed",
        successful: true,
      }).entries,
    ).toHaveLength(1);
  });

  test("legacy candidate generation remains unchanged without UDL metadata", () => {
    const legacy = buildMayorCandidateSet({ snapshot, detail, ownedTiles: [ownedTile] });
    expect(legacy.candidates.length).toBeGreaterThan(0);
    expect(legacy.candidates.every((candidate) => candidate.urbanDesign === undefined)).toBe(true);
  });
});
