import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../../src/main/services/ai-mayor/spatial/world-scanner";
import {
  type Gate1BoundedSiteCandidate,
  type Gate1StarterSiteAnchor,
  evaluateBoundedStarterSites,
  searchBoundedStarterSites,
  selectBoundedStarterSiteAnchors,
  selectIngressStarterSiteAnchors,
  selectLocalStarterSiteAnchors,
} from "../../src/main/services/ai-mayor/v2/site-selection";
import type { SpatialSiteDetail, SpatialWorldModel } from "../../src/main/services/ai-mayor/spatial/types";

/**
 * A world that owns one plain local road and/or one map-highway ingress.
 *
 * The two classes are placed far apart on the same owned tile so a candidate's
 * `evidence.sourceAnchor.x` identifies which class produced it: the local road
 * sits at x=-150/-120 and the highway ingress at x=150.
 */
const fixture = (options: { local: boolean; ingress: boolean }) => {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  if (options.local) {
    nodes.push(
      { entity: { index: 10, version: 1 }, position: { x: -150, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
      { entity: { index: 11, version: 1 }, position: { x: -120, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
    );
    edges.push({
      entity: { index: 20, version: 1 }, prefab: "Small Road", native: true,
      startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 },
      start: { x: -150, z: 0 }, end: { x: -120, z: 0 }, length: 30,
    });
  }
  if (options.ingress) {
    nodes.push(
      { entity: { index: 30, version: 1 }, position: { x: 150, y: 0, z: 0 }, native: true, outsideConnection: true, roadDegree: 1 },
      { entity: { index: 31, version: 1 }, position: { x: 300, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
    );
    edges.push({
      entity: { index: 40, version: 1 }, prefab: "Highway Twoway - 2 lanes", native: true,
      startNode: { index: 30, version: 1 }, endNode: { index: 31, version: 1 },
      start: { x: 150, z: 0 }, end: { x: 300, z: 0 }, length: 150,
    });
  }
  return parseSpatialBootstrapScan({
    world: { min: -2000, max: 2000, size: 4000 },
    tiles: [{ entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -2000, z: -2000 }, max: { x: 2000, z: 2000 } }, center: { x: 0, z: 0 }, polygon: [] }],
    outsideConnections: options.ingress
      ? [{ entity: { index: 30, version: 1 }, position: { x: 150, y: 0, z: 0 }, connectedRoadEdges: [{ index: 40, version: 1 }] }]
      : [],
    bootstrapAssets: [],
    roadGraph: { truncated: false, nodes, edges },
  });
};

const detailFor = (anchor: Gate1StarterSiteAnchor, world: SpatialWorldModel, flooded: boolean): SpatialSiteDetail => ({
  center: { x: anchor.node.position.x, z: anchor.node.position.z },
  radius: 96,
  terrain: {
    resolution: 2,
    bounds: {
      minX: anchor.node.position.x - 100, minZ: anchor.node.position.z - 100,
      maxX: anchor.node.position.x + 100, maxZ: anchor.node.position.z + 100,
    },
    cellSize: { x: 100, z: 100 },
    heights: [0, 0, 0, 0],
    waterDepths: flooded ? [1, 1, 1, 1] : [0, 0, 0, 0],
    groundWater: [0, 0, 0, 0],
    groundWaterPollution: [0, 0, 0, 0],
    windSpeed: [0, 0, 0, 0],
  },
  roadGraph: { nodes: world.roadGraph.nodes, edges: world.roadGraph.edges },
  buildings: [],
  zoningCells: [],
});

const runSearch = (input: {
  world: SpatialWorldModel;
  accepts?: (candidate: Gate1BoundedSiteCandidate) => Promise<boolean>;
  /** Anchor node entity indexes whose captured detail is flooded, so no site is legal there. */
  flooded?: number[];
  calls?: string[];
}) =>
  searchBoundedStarterSites({
    world: input.world,
    captureDetail: async (anchor) => {
      input.calls?.push(`${anchor.node.entity.index}:${anchor.node.entity.version}`);
      return {
        detail: detailFor(anchor, input.world, input.flooded?.includes(anchor.node.entity.index) ?? false),
        coherence: "STABLE_FRAME",
      };
    },
    ...(input.accepts ? { accepts: (candidate: Gate1BoundedSiteCandidate) => input.accepts!(candidate) } : {}),
  });

const sourceAnchorX = (candidate: Gate1BoundedSiteCandidate) => candidate.evidence.sourceAnchor.x;

describe("starter anchor class escalation", () => {
  test("A: a local candidate that satisfies the project keeps the ingress seed unused", async () => {
    const world = buildSpatialWorldModel(fixture({ local: true, ingress: true }));
    const calls: string[] = [];

    const result = await runSearch({ world, accepts: async () => true, calls });

    expect(result.anchorClass).toBe("OWNED_LOCAL_ROAD_TOPOLOGY");
    expect(result.fallbackReason).toBeNull();
    expect(result.ingress).toBeNull();
    expect(result.selection.candidates.length).toBeGreaterThan(0);
    expect(result.selection.candidates.every((candidate) => sourceAnchorX(candidate) < 0)).toBe(true);
    // The ingress class is not merely unused — it is never even observed.
    expect(calls).toEqual(["10:1", "11:1"]);
  });

  test("B: local anchors exist but every local candidate fails the project, so the ingress seed is used", async () => {
    const world = buildSpatialWorldModel(fixture({ local: true, ingress: true }));

    const result = await runSearch({ world, accepts: async (candidate) => sourceAnchorX(candidate) === 150 });

    expect(result.anchorClass).toBe("OWNED_START_CONNECTION_TOPOLOGY");
    expect(result.fallbackReason).toBe("NO_LOCAL_CANDIDATE_SATISFIES_PROJECT_CONSTRAINT");
    // The local class really did produce candidates; the project refused them.
    expect(result.local.anchors).toBe(2);
    expect(result.local.candidates).toBeGreaterThan(0);
    expect(result.local.accepted).toBe(0);
    expect(result.ingress?.anchors).toBeGreaterThan(0);
    expect(result.ingress?.accepted).toBeGreaterThan(0);
    // Every surviving candidate came from the ingress class, not from local frontage.
    expect(result.selection.candidates.every((candidate) => sourceAnchorX(candidate) >= 150)).toBe(true);
  });

  test("C: a world with no local frontage keeps the original ingress fallback", async () => {
    const world = buildSpatialWorldModel(fixture({ local: false, ingress: true }));

    const result = await runSearch({ world });

    expect(result.anchorClass).toBe("OWNED_START_CONNECTION_TOPOLOGY");
    expect(result.fallbackReason).toBe("NO_LOCAL_ANCHOR");
    expect(result.local.anchors).toBe(0);
    expect(result.selection.candidates.length).toBeGreaterThan(0);
    // The composite the rest of the codebase uses still agrees with this.
    expect(selectBoundedStarterSiteAnchors(world, 24)).toEqual(selectIngressStarterSiteAnchors(world, 24));
  });

  test("D: an illegal ingress site fails closed instead of falling back to anything", async () => {
    const world = buildSpatialWorldModel(fixture({ local: true, ingress: true }));

    // Local frontage is refused by the project AND the whole ingress class is flooded.
    const result = await runSearch({ world, accepts: async () => false, flooded: [30, 31] });

    expect(result.anchorClass).toBe("OWNED_START_CONNECTION_TOPOLOGY");
    expect(result.fallbackReason).toBe("NO_LOCAL_CANDIDATE_SATISFIES_PROJECT_CONSTRAINT");
    expect(result.ingress?.anchors).toBeGreaterThan(0);
    expect(result.ingress?.candidates).toBe(0);
    expect(result.selection.candidates).toEqual([]);

    // A world whose only anchors are illegal fails closed too: there is no third
    // class to escalate to, so admission gets nothing rather than a substitute.
    const ingressOnly = buildSpatialWorldModel(fixture({ local: false, ingress: true }));
    const nothing = await runSearch({ world: ingressOnly, flooded: [30, 31] });
    expect(nothing.local.anchors).toBe(0);
    expect(nothing.ingress?.candidates).toBe(0);
    expect(nothing.selection.candidates).toEqual([]);
  });

  test("E: the ingress node is a connection seed, never local frontage", async () => {
    const world = buildSpatialWorldModel(fixture({ local: false, ingress: true }));

    // Owned native highway nodes are absent from the local class...
    expect(selectLocalStarterSiteAnchors(world, 24)).toEqual([]);
    // ...and present only in the ingress class.
    const ingress = selectIngressStarterSiteAnchors(world, 24);
    expect(ingress.map((anchor) => anchor.node.entity)).toContainEqual({ index: 30, version: 1 });
    expect(ingress.every((anchor) => anchor.derivation === "OWNED_START_CONNECTION_TOPOLOGY")).toBe(true);

    // The same holds in a world that does have local frontage: owning a highway
    // never adds it to the preferred class.
    const mixed = buildSpatialWorldModel(fixture({ local: true, ingress: true }));
    expect(selectLocalStarterSiteAnchors(mixed, 24).map((anchor) => anchor.node.entity.index)).toEqual([10, 11]);

    const result = await runSearch({ world });
    const candidate = result.selection.candidates[0];
    // The seed edge is the highway, but what gets built is a NEW local road.
    expect(candidate.roadCandidates[0].sourceEdge.prefab).toMatch(/Highway/);
    expect(candidate.roadCandidates[0].input.prefab).toBe("Medium Road");
  });

  test("F: a legal local candidate selects exactly what the pre-existing policy selected", async () => {
    const world = buildSpatialWorldModel(fixture({ local: true, ingress: true }));
    const anchors = selectBoundedStarterSiteAnchors(world, 24);
    const details = anchors.map((anchor) => ({
      anchor: { x: anchor.node.position.x, z: anchor.node.position.z },
      detail: detailFor(anchor, world, false),
    }));
    const legacy = evaluateBoundedStarterSites({ world, anchors, details, maxCandidates: 4 });

    // No project constraint at all: byte-identical to the pre-existing evaluation.
    const unconstrained = await runSearch({ world });
    expect(unconstrained.anchorClass).toBe("OWNED_LOCAL_ROAD_TOPOLOGY");
    expect(unconstrained.fallbackReason).toBeNull();
    expect(unconstrained.ingress).toBeNull();
    expect(unconstrained.selection.candidates).toEqual(legacy.candidates);

    // And with a constraint the local candidate satisfies, the pick is unchanged.
    const satisfied = await runSearch({ world, accepts: async (candidate) => sourceAnchorX(candidate) < 0 });
    expect(satisfied.selection.candidates[0].id).toBe(legacy.candidates[0].id);
  });
});
