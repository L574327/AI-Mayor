import type { SpatialSiteDetail, SpatialWorldModel } from "../../src/main/services/ai-mayor/spatial/types";
import {
  generateUrbanDesignProposal,
  UrbanDesignPlannerResultSchema,
} from "../../src/main/services/ai-mayor/urban-design/proposal";
import {
  buildUrbanPlanningAnchors,
  buildUrbanSiteContext,
  URBAN_PLANNING_ANCHOR_MAX_COUNT,
  UrbanSiteContextSchema,
} from "../../src/main/services/ai-mayor/urban-design/site-context";

function world(): SpatialWorldModel {
  return {
    worldBounds: { min: -500, max: 500, size: 1000 },
    ownedTiles: [
      {
        entity: { index: 1, version: 1 },
        owned: true,
        bounds: { min: { x: -300, z: -300 }, max: { x: 300, z: 300 } },
        center: { x: 0, z: 0 },
        polygon: [
          { x: -300, z: -300 },
          { x: 300, z: -300 },
          { x: 300, z: 300 },
          { x: -300, z: 300 },
        ],
      },
    ],
    outsideConnections: [],
    connectionCandidates: [
      {
        node: {
          entity: { index: 10, version: 1 },
          position: { x: -240, y: 0, z: 0 },
          native: true,
          outsideConnection: true,
          roadDegree: 1,
        },
        reason: "ingress_gateway_in_owned_area",
        forward: { x: 1, z: 0 },
        graphDistanceFromOutside: 20,
        orientationRank: 0,
      },
    ],
    roadGraph: {
      truncated: false,
      nodes: [
        {
          entity: { index: 10, version: 1 },
          position: { x: -240, y: 0, z: 0 },
          native: true,
          outsideConnection: true,
          roadDegree: 1,
        },
        {
          entity: { index: 11, version: 1 },
          position: { x: 0, y: 0, z: 0 },
          native: true,
          outsideConnection: false,
          roadDegree: 3,
        },
        {
          entity: { index: 12, version: 1 },
          position: { x: 220, y: 0, z: 0 },
          native: true,
          outsideConnection: false,
          roadDegree: 1,
        },
      ],
      edges: [
        {
          entity: { index: 20, version: 1 },
          prefab: "Small Road",
          native: true,
          startNode: { index: 10, version: 1 },
          endNode: { index: 11, version: 1 },
          start: { x: -240, z: 0 },
          end: { x: 0, z: 0 },
          length: 240,
        },
        {
          entity: { index: 21, version: 1 },
          prefab: "Small Road",
          native: true,
          startNode: { index: 11, version: 1 },
          endNode: { index: 12, version: 1 },
          start: { x: 0, z: 0 },
          end: { x: 220, z: 0 },
          length: 220,
        },
      ],
    },
  };
}

function detail(options: { slope?: number; water?: boolean } = {}): SpatialSiteDetail {
  const slope = options.slope ?? 0;
  const resolution = 4;
  return {
    center: { x: 0, z: 0 },
    radius: 300,
    terrain: {
      resolution,
      bounds: { minX: -300, minZ: -300, maxX: 300, maxZ: 300 },
      cellSize: { x: 200, z: 200 },
      heights: Array.from({ length: 16 }, (_, index) => (index % resolution) * slope),
      waterDepths: Array.from({ length: 16 }, (_, index) => (options.water && index < 4 ? 2 : 0)),
      groundWater: Array(16).fill(0),
      groundWaterPollution: Array(16).fill(0),
      windSpeed: Array(16).fill(0),
    },
    roadGraph: world().roadGraph,
    buildings: [
      {
        entity: { index: 40, version: 1 },
        prefab: "House",
        native: true,
        position: { x: 10, y: 0, z: 10 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        footprint: null,
      },
    ],
    zoningCells: Array.from({ length: 32 }, (_, index) => ({
      block: { index: 50, version: 1 },
      index,
      position: { x: -200 + (index % 8) * 50, y: 0, z: -150 + Math.floor(index / 8) * 50 },
      visible: true,
      roadside: true,
      occupied: index < 4,
      blocked: false,
      overridden: false,
      zoneType: 0,
    })),
  };
}

function context(options: { slope?: number; water?: boolean } = {}) {
  return buildUrbanSiteContext({
    world: world(),
    detail: detail(options),
    snapshot: { planningCatalog: { zoneTypes: [{ areaType: "Residential" }, { areaType: "Commercial" }] } },
    siteId: "fixture-site",
    snapshotRevision: "snapshot-1",
  });
}

describe("Urban Design Language Phase 2", () => {
  test("builds a bounded, stable SiteContext from the same world facts", () => {
    const first = context();
    const second = context();
    expect(first).toEqual(second);
    expect(UrbanSiteContextSchema.parse(first)).toEqual(first);
    expect(first.anchorSeeds.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(first).length).toBeLessThan(12_000);
    expect(first.unavailableSignals).toEqual(expect.arrayContaining(["pollution", "authoritative_district_types"]));
  });

  test("creates deterministic bounded planning anchors with stable IDs", () => {
    const anchors = buildUrbanPlanningAnchors(context({ water: true }));
    expect(anchors.length).toBeLessThanOrEqual(URBAN_PLANNING_ANCHOR_MAX_COUNT);
    expect(anchors).toEqual(buildUrbanPlanningAnchors(context({ water: true })));
    expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(anchors.length);
    expect(anchors.some((anchor) => anchor.kind === "gateway")).toBe(true);
  });

  test("bounds canonical incident roads when a live junction has high degree", () => {
    const highDegreeWorld = structuredClone(world());
    highDegreeWorld.roadGraph.nodes[1].roadDegree = 12;
    for (let index = 22; index < 32; index += 1) {
      highDegreeWorld.roadGraph.edges.push({
        entity: { index, version: 1 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 11, version: 1 },
        endNode: { index: 100 + index, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: index * 10, z: index * 5 },
        length: 12,
      });
    }
    const site = buildUrbanSiteContext({
      world: highDegreeWorld,
      detail: { ...detail(), roadGraph: highDegreeWorld.roadGraph },
      snapshot: { planningCatalog: { zoneTypes: [{ areaType: "Residential" }] } },
      siteId: "high-degree-site",
      snapshotRevision: "snapshot-high-degree",
    });
    expect(UrbanSiteContextSchema.parse(site)).toEqual(site);
    for (const seed of site.anchorSeeds) {
      expect(seed.canonicalSource?.incidentRoads.length ?? 0).toBeLessThanOrEqual(8);
    }
  });

  test("carries canonical node-to-road identity for gateway, endpoint and central anchors", () => {
    const anchors = buildUrbanPlanningAnchors(context());
    const gateway = anchors.find((anchor) => anchor.kind === "gateway");
    const edge = anchors.find((anchor) => anchor.kind === "undeveloped_edge");
    const central = anchors.find((anchor) => anchor.kind === "central_node");

    expect(gateway?.canonicalSource).toEqual({
      kind: "road_node",
      node: { index: 10, version: 1 },
      incidentRoads: [{ edge: { index: 20, version: 1 }, endpointRole: "start" }],
    });
    expect(edge?.canonicalSource).toEqual({
      kind: "road_node",
      node: { index: 10, version: 1 },
      incidentRoads: [{ edge: { index: 20, version: 1 }, endpointRole: "start" }],
    });
    expect(central?.canonicalSource).toEqual({
      kind: "road_node",
      node: { index: 11, version: 1 },
      incidentRoads: [
        { edge: { index: 20, version: 1 }, endpointRole: "end" },
        { edge: { index: 21, version: 1 }, endpointRole: "start" },
      ],
    });
  });

  test("same grammar, site and seed produce an identical semantic proposal", () => {
    const site = context();
    const anchor = buildUrbanPlanningAnchors(site)[0];
    const left = generateUrbanDesignProposal({ context: site, anchor, grammarId: "orthogonal-grid", seed: "seed-1" });
    const right = generateUrbanDesignProposal({ context: site, anchor, grammarId: "orthogonal-grid", seed: "seed-1" });
    expect(left).toEqual(right);
    expect(UrbanDesignPlannerResultSchema.parse(left)).toEqual(left);
    expect(left.status).toBe("proposal");
    if (left.status === "proposal") {
      expect(left.activeCandidates).toEqual([]);
      expect(left.semantics.topology).toBe("grid");
      expect(left).not.toHaveProperty("x");
      expect(left).not.toHaveProperty("z");
    }
  });

  test("same grammar and site vary by seed without losing style identity", () => {
    const site = context();
    const anchor = buildUrbanPlanningAnchors(site)[0];
    const left = generateUrbanDesignProposal({ context: site, anchor, grammarId: "terrain-organic", seed: "seed-a" });
    const right = generateUrbanDesignProposal({ context: site, anchor, grammarId: "terrain-organic", seed: "seed-b" });
    expect(left.status).toBe("proposal");
    expect(right.status).toBe("proposal");
    if (left.status === "proposal" && right.status === "proposal") {
      expect(left.semantics.topology).toBe("organic");
      expect(right.semantics.topology).toBe("organic");
      expect(left.parameterSample).not.toEqual(right.parameterSample);
    }
  });

  test("different grammars produce distinct proposal semantics", () => {
    const site = context();
    const anchor = buildUrbanPlanningAnchors(site)[0];
    const ids = ["orthogonal-grid", "terrain-organic", "garden-neighborhood", "compact-urban"] as const;
    const proposals = ids.map((grammarId) =>
      generateUrbanDesignProposal({ context: site, anchor, grammarId, seed: "same" }),
    );
    expect(proposals.every((proposal) => proposal.status === "proposal")).toBe(true);
    const signatures = proposals.map((proposal) =>
      proposal.status === "proposal" ? proposal.designSignature : proposal.reason,
    );
    expect(new Set(signatures).size).toBe(ids.length);
  });

  test("waterfront grammar requires real water opportunity and adapts on verified water", () => {
    const drySite = context();
    const dryAnchor = buildUrbanPlanningAnchors(drySite)[0];
    const dry = generateUrbanDesignProposal({
      context: drySite,
      anchor: dryAnchor,
      grammarId: "waterfront-linear",
      seed: "water",
    });
    expect(dry.status).toBe("no_proposal");
    const wetSite = context({ water: true });
    const wetAnchor = buildUrbanPlanningAnchors(wetSite).find(
      (candidate) => candidate.kind === "waterfront_opportunity",
    );
    expect(wetAnchor).toBeDefined();
    const wet = generateUrbanDesignProposal({
      context: wetSite,
      anchor: wetAnchor as NonNullable<typeof wetAnchor>,
      grammarId: "waterfront-linear",
      seed: "water",
    });
    expect(wet.status).toBe("proposal");
    if (wet.status === "proposal") expect(wet.semantics.curvature).toBe("shoreline_adapted");
  });

  test("terrain adaptation is visible without generating geometry", () => {
    const site = context({ slope: 80 });
    expect(site.terrain.slopeProfile).not.toBe("flat");
    const anchor = buildUrbanPlanningAnchors(site)[0];
    const organic = generateUrbanDesignProposal({ context: site, anchor, grammarId: "terrain-organic", seed: "slope" });
    expect(organic.status).toBe("proposal");
    if (organic.status === "proposal") {
      expect(organic.terrainWaterfrontAdaptations).toEqual(expect.arrayContaining(["follow_feasible_contours"]));
      expect(organic.activeCandidates).toHaveLength(0);
    }
  });

  test("supports one bounded secondary influence while preserving primary topology", () => {
    const site = context();
    const anchor = buildUrbanPlanningAnchors(site)[0];
    const proposal = generateUrbanDesignProposal({
      context: site,
      anchor,
      grammarId: "orthogonal-grid",
      secondaryStyleId: "garden-neighborhood",
      secondaryStrength: "subtle",
      seed: "mix",
    });
    expect(proposal.status).toBe("proposal");
    if (proposal.status === "proposal") {
      expect(proposal.grammar.primary).toBe("orthogonal-grid");
      expect(proposal.grammar.secondary).toBe("garden-neighborhood");
      expect(proposal.semantics.topology).toBe("grid");
      expect(proposal.secondaryInfluence?.dimensions.length).toBeGreaterThan(0);
    }
  });
});
