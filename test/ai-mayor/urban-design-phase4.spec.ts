import {
  createEmptyUrbanDesignNoveltyMemory,
  recordAcceptedUrbanDesign,
  scoreUrbanDesignNovelty,
  summarizeUrbanDesignNovelty,
  URBAN_DESIGN_NOVELTY_MAX_ENTRIES,
  URBAN_DESIGN_NOVELTY_MAX_SERIALIZED_BYTES,
  UrbanDesignNoveltyMemorySchema,
} from "../../src/main/services/ai-mayor/urban-design/novelty";
import { buildUrbanDesignPromptContext } from "../../src/main/services/ai-mayor/urban-design/prompt-context";
import {
  type UrbanDesignProposal,
  UrbanDesignProposalSchema,
} from "../../src/main/services/ai-mayor/urban-design/proposal";
import {
  PlanningAnchorSchema,
  type UrbanPlanningAnchor,
  type UrbanSiteContext,
  UrbanSiteContextSchema,
} from "../../src/main/services/ai-mayor/urban-design/site-context";

function proposal(overrides: Partial<UrbanDesignProposal> = {}): UrbanDesignProposal {
  return UrbanDesignProposalSchema.parse({
    status: "proposal",
    proposalId: "proposal-1",
    intentId: "intent-1",
    siteId: "site-1",
    anchorId: "anchor-1",
    snapshotRevision: "snapshot-1",
    grammar: { primary: "compact-urban", primaryVersion: "1.0.0" },
    designSummary: "A compact semantic district proposal",
    motif: "civic-square-frame",
    designSignature: "compact-urban:civic-square-frame:node",
    semantics: {
      topology: "node",
      blockScale: "small",
      roadHierarchy: "fine_grain",
      curvature: "moderate",
      density: "high",
      commercial: "mixed_core",
      green: "central",
    },
    terrainWaterfrontAdaptations: ["follow_existing_roads"],
    parameterSample: { blockScale: 40 },
    tradeoffs: ["higher coordination"],
    activeCandidates: [],
    futureStages: [],
    utilityServiceImplications: ["check service headroom"],
    estimatedCapacity: { band: "small", approximateCells: 20 },
    estimatedCost: { band: "unknown" },
    metrics: null,
    metricState: "semantic_only",
    constraints: ["owned land"],
    validation: { state: "partial", validatedCandidateCount: 0, rejectionReasons: [] },
    ...overrides,
  });
}

function site(): UrbanSiteContext {
  return UrbanSiteContextSchema.parse({
    version: 1,
    siteId: "site-1",
    snapshotRevision: "snapshot-1",
    areaClass: "edge",
    buildableAreaBand: "small",
    ownedLand: {
      tileCount: 1,
      areaBand: "small",
      boundaryBand: "simple",
      buildableCoverage: 0.5,
      availableFrontageCells: 20,
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
    development: { buildingCount: 2, occupiedZoningCells: 3, developedClusterCount: 1, extentBand: "small" },
    frontage: {
      visibleRoadsideCells: 20,
      availableRoadsideCells: 20,
      opportunityBand: "small",
      source: "spatial_zoning_cells",
    },
    adjacency: { residential: "present", commercial: "absent", industrial: "absent", source: "snapshot_catalog" },
    pollution: { availability: "unavailable", note: "not available" },
    constraints: ["owned_land_boundary"],
    opportunities: ["road_endpoint"],
    unavailableSignals: ["pollution"],
    anchorSeeds: [],
  });
}

function anchor(): UrbanPlanningAnchor {
  return PlanningAnchorSchema.parse({
    id: "anchor-1",
    kind: "road_endpoint",
    sourceId: "road-1",
    sourceEntity: { index: 1, version: 1 },
    rank: 0,
    orientation: "east_west",
    areaClass: "edge",
    terrainProfile: "flat",
    waterfrontEligible: false,
    availableFrontageCells: 20,
    adaptationHints: ["follow_existing_roads"],
  });
}

describe("Urban Design Language Phase 4", () => {
  test("keeps an empty memory neutral and records only accepted proposals", () => {
    const empty = createEmptyUrbanDesignNoveltyMemory();
    expect(summarizeUrbanDesignNovelty(empty).entriesConsidered).toBe(0);
    expect(scoreUrbanDesignNovelty({ memory: empty, proposal: proposal() })).toMatchObject({
      repetitionScore: 0,
      noveltyScore: 1,
    });
    const next = recordAcceptedUrbanDesign({ memory: empty, result: proposal(), anchor: anchor() });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).not.toHaveProperty("x");
    expect(next.entries[0]).not.toHaveProperty("z");
  });

  test("deduplicates proposal IDs, evicts oldest entries, and stays bounded", () => {
    let memory = createEmptyUrbanDesignNoveltyMemory();
    memory = recordAcceptedUrbanDesign({ memory, result: proposal() });
    memory = recordAcceptedUrbanDesign({ memory, result: proposal() });
    expect(memory.entries).toHaveLength(1);
    for (let index = 0; index < URBAN_DESIGN_NOVELTY_MAX_ENTRIES + 4; index += 1) {
      memory = recordAcceptedUrbanDesign({ memory, result: proposal({ proposalId: `proposal-${index + 2}` }) });
    }
    expect(memory.entries).toHaveLength(URBAN_DESIGN_NOVELTY_MAX_ENTRIES);
    expect(memory.entries[0].orderIndex).toBe(memory.nextOrderIndex - memory.entries.length);
    expect(Buffer.byteLength(JSON.stringify(memory), "utf8")).toBeLessThanOrEqual(
      URBAN_DESIGN_NOVELTY_MAX_SERIALIZED_BYTES,
    );
    expect(UrbanDesignNoveltyMemorySchema.parse(memory)).toEqual(memory);
  });

  test("repetition rises for an exact repeat and falls for style or semantic variation", () => {
    const first = proposal();
    const memory = recordAcceptedUrbanDesign({ memory: createEmptyUrbanDesignNoveltyMemory(), result: first });
    const exact = scoreUrbanDesignNovelty({ memory, proposal: first });
    const varied = scoreUrbanDesignNovelty({
      memory,
      proposal: proposal({
        proposalId: "proposal-2",
        motif: "perimeter-block",
        semantics: { ...first.semantics, density: "medium", green: "distributed" },
      }),
    });
    const different = scoreUrbanDesignNovelty({
      memory,
      proposal: proposal({
        proposalId: "proposal-3",
        grammar: { primary: "garden-neighborhood", primaryVersion: "1.0.0" },
        motif: "garden-loop",
        designSignature: "garden-neighborhood:garden-loop:organic",
        semantics: {
          topology: "organic",
          blockScale: "small_medium",
          roadHierarchy: "local_first",
          curvature: "moderate",
          density: "low",
          commercial: "none",
          green: "distributed",
        },
      }),
    });
    expect(exact.repetitionScore).toBeGreaterThan(varied.repetitionScore);
    expect(varied.repetitionScore).toBeGreaterThan(different.repetitionScore);
  });

  test("summary is compact, deterministic and prompt projection exposes no raw geometry", () => {
    const first = proposal();
    let memory = createEmptyUrbanDesignNoveltyMemory();
    memory = recordAcceptedUrbanDesign({ memory, result: first });
    memory = recordAcceptedUrbanDesign({ memory, result: proposal({ proposalId: "proposal-2" }) });
    const summary = summarizeUrbanDesignNovelty(memory);
    expect(summary).toEqual(summarizeUrbanDesignNovelty(memory));
    expect(summary.repeatedPatterns.length).toBeGreaterThan(0);
    const projected = buildUrbanDesignPromptContext({
      siteContext: site(),
      anchors: [anchor()],
      playerDirection: "继续这个老城区风格",
      strategicContext: { goal: "Grow", phase: "district", strategy: "infill", operationalNote: "stable" },
      novelty: summary,
    });
    expect(projected.novelty).toEqual(summary);
    expect(JSON.stringify(projected)).not.toMatch(/"[xz]"\s*:/);
    expect(JSON.stringify(projected)).not.toContain("sourceEntity");
  });

  test("rejected results do not write memory and player continuation remains soft", () => {
    const memory = createEmptyUrbanDesignNoveltyMemory();
    const rejected = {
      status: "no_proposal",
      proposalId: "rejected",
      siteId: "site-1",
      anchorId: "anchor-1",
      grammar: "waterfront-linear",
      reason: "no verified water",
      constraints: [],
    } as const;
    expect(recordAcceptedUrbanDesign({ memory, result: rejected })).toEqual(memory);
    const repeated = scoreUrbanDesignNovelty({
      memory: recordAcceptedUrbanDesign({ memory, result: proposal() }),
      proposal: proposal({ proposalId: "continuation" }),
    });
    expect(repeated.repetitionScore).toBeGreaterThan(0);
    expect(repeated.repetitionScore).toBeLessThanOrEqual(1);
  });
});
