import { describe, expect, it, jest } from "@jest/globals";
import type { MayorRuntimePorts } from "../../src/main/services/ai-mayor/types";
import {
  parseUrbanDesignDecisionWire,
  UrbanDesignDecisionWireSchema,
} from "../../src/main/services/ai-mayor/urban-design/decision";
import {
  decideUrbanDesignEpisode,
  executeUrbanDesignRealizationGroup,
  PHASE5B_MAX_EXECUTED_CANDIDATES,
} from "../../src/main/services/ai-mayor/urban-design/decision-flow";
import {
  buildUrbanPlanningAnchors,
  UrbanSiteContextSchema,
} from "../../src/main/services/ai-mayor/urban-design/site-context";

function fixture() {
  const site = UrbanSiteContextSchema.parse({
    version: 1,
    siteId: "harness-site",
    snapshotRevision: "1",
    areaClass: "edge",
    buildableAreaBand: "medium",
    ownedLand: {
      tileCount: 1,
      areaBand: "medium",
      boundaryBand: "simple",
      buildableCoverage: 0.7,
      availableFrontageCells: 20,
    },
    terrain: {
      availability: "available",
      sampleCount: 2,
      slopeProfile: "flat",
      roughness: "smooth",
      meanSlopePercent: 1,
      maxSlopePercent: 3,
    },
    water: { availability: "unavailable", relationship: "none", opportunity: false, waterSampleBand: "none" },
    roadContext: {
      edgeCount: 2,
      nodeCount: 2,
      endpointCount: 1,
      gatewayCount: 0,
      highwayEvidence: "absent",
      dominantOrientation: "east_west",
      orientationSpread: "narrow",
      geometry: "sparse",
      hierarchyEvidence: ["existing_road_direction"],
    },
    development: { buildingCount: 1, occupiedZoningCells: 2, developedClusterCount: 1, extentBand: "small" },
    frontage: {
      visibleRoadsideCells: 20,
      availableRoadsideCells: 20,
      opportunityBand: "medium",
      source: "spatial_zoning_cells",
    },
    adjacency: { residential: "present", commercial: "absent", industrial: "absent", source: "snapshot_catalog" },
    pollution: { availability: "unavailable", note: "unavailable" },
    constraints: [],
    opportunities: ["road_endpoint"],
    unavailableSignals: ["pollution"],
    anchorSeeds: [
      {
        sourceId: "endpoint-1",
        kind: "road_endpoint",
        sourceEntity: { index: 1, version: 1 },
        orientation: "east_west",
        degree: 1,
        waterfrontEligible: false,
        availableFrontageCells: 20,
      },
    ],
  });
  const anchors = buildUrbanPlanningAnchors(site);
  return { site, anchors, snapshot: { urbanDesign: { siteContext: site, anchors, novelty: null } } };
}

function intent(anchorId: string) {
  return {
    goal: "Build a district",
    primaryStyle: "compact-urban",
    preferredAnchorId: anchorId,
    density: "medium",
    developmentEmphasis: "edge_expansion",
    roadCharacter: "balanced",
    commercialTendency: "nodes",
    greenSpaceTendency: "distributed",
    rationale: "Use the available road edge.",
  };
}

function ports(content: string) {
  const calls = { dedicated: 0, routine: 0, realize: 0 };
  const value = {
    getSnapshot: jest.fn(),
    decide: jest.fn(async () => {
      calls.routine += 1;
      throw new Error("routine path must not be called");
    }),
    decideUrbanDesign: jest.fn(async () => {
      calls.dedicated += 1;
      return { content, model: "test", usage: {} as never };
    }),
    realizeUrbanDesignIntent: jest.fn(async () => {
      calls.realize += 1;
      return { status: "no_realization" };
    }),
  } as unknown as Pick<MayorRuntimePorts, "getSnapshot" | "decideUrbanDesign" | "realizeUrbanDesignIntent">;
  return { value, calls };
}

describe("dedicated Phase 5B design decision boundary", () => {
  it("hands only the realized group refs to the existing execution port", async () => {
    const executeActions = jest.fn(
      async (actions: Array<{ type: "choose_candidate"; candidateId: string; reason: string }>) => ({
        ok: true,
        requested: actions.length,
        executed: actions.length,
        results: [],
      }),
    );
    const result = await executeUrbanDesignRealizationGroup({
      ports: { executeActions },
      realization: {
        version: 1,
        proposalId: "proposal-1",
        status: "realized",
        candidateIds: ["E-1", "E-2", "E-3", "E-unrelated"],
        candidateMetadata: [],
        rejectedElements: [],
        constraintReasons: [],
        envelope: {
          version: 1,
          proposalId: "proposal-1",
          anchorId: "anchor-1",
          anchorOrientation: "east_west",
          allowedHeadings: ["east_west"],
          preferredHeading: "east_west",
          approximateScale: "medium",
          topology: "grid",
          curvature: "orthogonal",
          roadHierarchy: "balanced",
          density: "medium",
          frontageTarget: "medium",
          adaptationHints: [],
        },
      },
    });
    expect(result.candidateIds).toEqual(["E-1", "E-2", "E-3"]);
    expect(result.candidateIds).toHaveLength(PHASE5B_MAX_EXECUTED_CANDIDATES);
    expect(executeActions).toHaveBeenCalledWith([
      { type: "choose_candidate", candidateId: "E-1", reason: expect.any(String) },
      { type: "choose_candidate", candidateId: "E-2", reason: expect.any(String) },
      { type: "choose_candidate", candidateId: "E-3", reason: expect.any(String) },
    ]);
  });

  it("canonicalizes the compact wire contract without semantic defaults", () => {
    const data = fixture();
    const wire = {
      version: 1,
      status: "design",
      urbanDesignIntent: {
        goal: "Build a district",
        primaryStyle: "compact-urban",
        preferredAnchorId: data.anchors[0].id,
        density: "medium",
        developmentEmphasis: "edge_expansion",
        roadCharacter: "balanced",
        commercialTendency: "nodes",
        greenSpaceTendency: "distributed",
        rationale: "Use the available road edge.",
      },
    } as const;
    const canonical = parseUrbanDesignDecisionWire(JSON.stringify(wire));
    expect(canonical).toMatchObject({
      version: 1,
      status: "design",
      urbanDesignIntent: { version: 1, status: "design", goal: wire.urbanDesignIntent.goal },
    });
    expect(() => UrbanDesignDecisionWireSchema.parse(wire)).not.toThrow();
  });

  it("rejects missing goal and the old secondaryStyle alias", () => {
    const data = fixture();
    const base = {
      version: 1,
      status: "design",
      urbanDesignIntent: {
        primaryStyle: "compact-urban",
        preferredAnchorId: data.anchors[0].id,
        density: "medium",
        developmentEmphasis: "edge_expansion",
        roadCharacter: "balanced",
        commercialTendency: "nodes",
        greenSpaceTendency: "distributed",
        rationale: "Use the available road edge.",
      },
    };
    expect(() => parseUrbanDesignDecisionWire(JSON.stringify(base))).toThrow();
    expect(() =>
      parseUrbanDesignDecisionWire(
        JSON.stringify({
          ...base,
          urbanDesignIntent: { ...base.urbanDesignIntent, goal: "Build", secondaryStyle: "terrain-organic" },
        }),
      ),
    ).toThrow();
  });

  it("keeps wait free of nested intent and the wire contract coordinate-free", () => {
    expect(parseUrbanDesignDecisionWire('{"version":1,"status":"wait"}')).toEqual({ version: 1, status: "wait" });
    expect(() => parseUrbanDesignDecisionWire('{"version":1,"status":"wait","urbanDesignIntent":{}}')).toThrow();
  });

  it("uses only dedicated decision and proceeds to deterministic proposal/realization", async () => {
    const data = fixture();
    const candidate = ports(
      JSON.stringify({ version: 1, status: "design", urbanDesignIntent: intent(data.anchors[0].id) }),
    );
    const result = await decideUrbanDesignEpisode({
      ports: candidate.value,
      snapshot: data.snapshot,
      goal: "Design a district",
      tick: 1,
      model: "test",
      strategicContext: { phase: "design", strategy: "bounded", operationalNote: "live validation" },
    });
    expect(candidate.calls).toMatchObject({ dedicated: 1, routine: 0, realize: 1 });
    expect(result.resolution?.proposal?.status).toBe("proposal");
  });

  it("wait stops without realization", async () => {
    const data = fixture();
    const candidate = ports(JSON.stringify({ version: 1, status: "wait" }));
    const result = await decideUrbanDesignEpisode({
      ports: candidate.value,
      snapshot: data.snapshot,
      goal: "Design",
      tick: 1,
      model: "test",
      strategicContext: { phase: "design", strategy: "bounded", operationalNote: "live validation" },
    });
    expect(result.resolution).toBeNull();
    expect(candidate.calls.realize).toBe(0);
  });

  it("fails closed for an execution shortcut or invalid dedicated response", async () => {
    const data = fixture();
    const candidate = ports(
      JSON.stringify({ version: 1, status: "design", actions: [{ type: "choose_candidate", candidateId: "R-1" }] }),
    );
    await expect(
      decideUrbanDesignEpisode({
        ports: candidate.value,
        snapshot: data.snapshot,
        goal: "Design",
        tick: 1,
        model: "test",
        strategicContext: { phase: "design", strategy: "bounded", operationalNote: "live validation" },
      }),
    ).rejects.toThrow();
    expect(candidate.calls.realize).toBe(0);
  });
});
