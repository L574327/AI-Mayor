import {
  buildMayorPrompt,
  buildUrbanDesignDecisionPrompt,
  URBAN_DESIGN_DECISION_SYSTEM_PROMPT,
} from "../../src/main/services/ai-mayor/prompt";
import { MayorPlanSchema } from "../../src/main/services/ai-mayor/schema";
import {
  parseUrbanDesignDecision,
  UrbanDesignDecisionSchema,
} from "../../src/main/services/ai-mayor/urban-design/decision";
import { resolveUrbanDesignMixCompatibility } from "../../src/main/services/ai-mayor/urban-design/grammar";
import {
  resolveUrbanDesignIntent,
  UrbanDesignIntentSchema,
  validateUrbanDesignIntent,
} from "../../src/main/services/ai-mayor/urban-design/intent";
import { getBundledUrbanGrammar } from "../../src/main/services/ai-mayor/urban-design/loader";
import {
  buildUrbanDesignPromptContext,
  URBAN_DESIGN_PROMPT_CONTEXT_MAX_BYTES,
  UrbanDesignPromptContextSchema,
} from "../../src/main/services/ai-mayor/urban-design/prompt-context";
import {
  buildUrbanPlanningAnchors,
  type UrbanPlanningAnchor,
  type UrbanSiteContext,
  UrbanSiteContextSchema,
} from "../../src/main/services/ai-mayor/urban-design/site-context";

function site(water = false): UrbanSiteContext {
  return UrbanSiteContextSchema.parse({
    version: 1,
    siteId: "phase3-site",
    snapshotRevision: "snapshot-1",
    areaClass: water ? "waterfront" : "edge",
    buildableAreaBand: "medium",
    ownedLand: {
      tileCount: 1,
      areaBand: "medium",
      boundaryBand: "simple",
      buildableCoverage: 0.6,
      availableFrontageCells: 40,
    },
    terrain: {
      availability: "available",
      sampleCount: 16,
      slopeProfile: "rolling",
      roughness: "varied",
      meanSlopePercent: 8,
      maxSlopePercent: 18,
    },
    water: {
      availability: water ? "available" : "unavailable",
      relationship: water ? "river_edge" : "none",
      opportunity: water,
      waterSampleBand: water ? "small" : "none",
    },
    roadContext: {
      edgeCount: 4,
      nodeCount: 5,
      endpointCount: 2,
      gatewayCount: 1,
      highwayEvidence: "present",
      dominantOrientation: "east_west",
      orientationSpread: "narrow",
      geometry: "grid_like",
      hierarchyEvidence: ["existing_road_direction"],
    },
    development: { buildingCount: 12, occupiedZoningCells: 24, developedClusterCount: 1, extentBand: "small" },
    frontage: {
      visibleRoadsideCells: 80,
      availableRoadsideCells: 40,
      opportunityBand: "medium",
      source: "spatial_zoning_cells",
    },
    adjacency: { residential: "present", commercial: "absent", industrial: "absent", source: "snapshot_catalog" },
    pollution: { availability: "unavailable", note: "authoritative pollution data unavailable" },
    constraints: ["owned_land_boundary"],
    opportunities: ["road_endpoint", ...(water ? ["verified_waterfront"] : [])],
    unavailableSignals: ["pollution", "authoritative_district_types"],
    anchorSeeds: [
      {
        sourceId: "road-endpoint",
        kind: "road_endpoint",
        sourceEntity: { index: 10, version: 1 },
        orientation: "east_west",
        degree: 1,
        waterfrontEligible: false,
        availableFrontageCells: 20,
      },
      ...(water
        ? [
            {
              sourceId: "waterfront",
              kind: "waterfront_opportunity",
              sourceEntity: { index: 11, version: 1 },
              orientation: "north_south",
              degree: 2,
              waterfrontEligible: true,
              availableFrontageCells: 18,
            },
          ]
        : []),
    ],
  });
}

function anchorsFor(context: UrbanSiteContext): readonly UrbanPlanningAnchor[] {
  return buildUrbanPlanningAnchors(context);
}

function intent(anchorId: string, primaryStyle = "compact-urban") {
  return {
    version: 1 as const,
    status: "design" as const,
    goal: "Build a stronger mixed center",
    primaryStyle,
    secondaryInfluence: { styleId: "garden-neighborhood", strength: "subtle" as const, dimensions: ["green" as const] },
    preferredAnchorId: anchorId,
    preferredMotif: "civic-square-frame",
    density: "high" as const,
    developmentEmphasis: "center" as const,
    roadCharacter: "fine_grain" as const,
    commercialTendency: "mixed_core" as const,
    greenSpaceTendency: "central" as const,
    adaptationPriorities: ["existing_roads" as const, "owned_land" as const],
    variationSeed: "phase3-seed",
    rationale: "The existing road direction and available frontage support a compact center.",
  };
}

describe("Urban Design Language Phase 3", () => {
  test("validates bounded design intent and deterministic semantic resolution", () => {
    const context = site();
    const anchor = anchorsFor(context)[0];
    const value = intent(anchor.id);
    expect(UrbanDesignIntentSchema.parse(value)).toEqual(value);
    const left = resolveUrbanDesignIntent({ value, context: { siteContext: context, anchors: anchorsFor(context) } });
    const right = resolveUrbanDesignIntent({ value, context: { siteContext: context, anchors: anchorsFor(context) } });
    expect(left).toEqual(right);
    expect(left.proposal?.status).toBe("proposal");
  });

  test("rejects unavailable styles, anchors, duplicate styles and extra influence styles", () => {
    const context = site();
    const anchor = anchorsFor(context)[0];
    expect(() =>
      validateUrbanDesignIntent(
        { ...intent(anchor.id), primaryStyle: "not-a-grammar" },
        { siteContext: context, anchors: [anchor] },
      ),
    ).toThrow("primary style is not available");
    expect(() =>
      validateUrbanDesignIntent(intent("missing-anchor"), { siteContext: context, anchors: [anchor] }),
    ).toThrow("anchor is not available");
    expect(() =>
      validateUrbanDesignIntent(
        { ...intent(anchor.id), secondaryInfluence: { styleId: "compact-urban", strength: "subtle" } },
        { siteContext: context, anchors: [anchor] },
      ),
    ).toThrow("must differ");
    expect(() => UrbanDesignIntentSchema.parse({ ...intent(anchor.id), secondaryInfluences: [] })).toThrow();
  });

  test("resolves secondary compatibility from the deterministic grammar intersection", () => {
    const primary = getBundledUrbanGrammar("compact-urban");
    const secondary = getBundledUrbanGrammar("terrain-organic");
    if (!primary || !secondary) throw new Error("bundled grammar fixture is unavailable");
    const compatibility = resolveUrbanDesignMixCompatibility(primary, secondary);
    expect(compatibility).toEqual({
      status: "compatible",
      allowedDimensions: ["block_scale", "density", "commercial", "green"],
      reasons: [],
    });
    expect(resolveUrbanDesignMixCompatibility(primary, secondary)).toEqual(compatibility);
    const context = site();
    const anchor = anchorsFor(context)[0];
    const omittedDimensions = {
      ...intent(anchor.id),
      secondaryInfluence: { styleId: "terrain-organic", strength: "subtle" as const },
    };
    const resolved = validateUrbanDesignIntent(omittedDimensions, { siteContext: context, anchors: [anchor] });
    expect(resolved.primaryStyle).toBe("compact-urban");
    expect(resolved.secondaryInfluence?.strength).toBe("subtle");
    const proposal = resolveUrbanDesignIntent({
      value: omittedDimensions,
      context: { siteContext: context, anchors: [anchor] },
    }).proposal;
    expect(proposal?.status === "proposal" ? proposal.secondaryInfluence?.dimensions : undefined).toEqual([
      "block_scale",
      "density",
      "commercial",
      "green",
    ]);
  });

  test("keeps explicit incompatible dimensions fail-closed", () => {
    const context = site();
    const anchor = anchorsFor(context)[0];
    expect(() =>
      validateUrbanDesignIntent(
        {
          ...intent(anchor.id),
          secondaryInfluence: { styleId: "terrain-organic", strength: "subtle", dimensions: ["curvature"] },
        },
        { siteContext: context, anchors: [anchor] },
      ),
    ).toThrow("secondary influence dimension is not allowed by the primary grammar: curvature");
  });

  test("reports a pair with no compatible dimensions without inventing an influence", () => {
    const primary = getBundledUrbanGrammar("compact-urban");
    const secondary = getBundledUrbanGrammar("terrain-organic");
    if (!primary || !secondary) throw new Error("bundled grammar fixture is unavailable");
    const compatibility = resolveUrbanDesignMixCompatibility(
      { ...primary, mixing: { allowInfluenceDimensions: ["transit"] } },
      { ...secondary, mixing: { allowInfluenceDimensions: ["curvature"] } },
    );
    expect(compatibility.status).toBe("incompatible");
    expect(compatibility.allowedDimensions).toEqual([]);
    expect(compatibility.reasons).toEqual([
      "no compatible influence dimensions between compact-urban and terrain-organic",
    ]);
  });

  test("keeps rationale bounded and supports an explicit wait path", () => {
    const context = site();
    const anchor = anchorsFor(context)[0];
    expect(() => UrbanDesignIntentSchema.parse({ ...intent(anchor.id), rationale: "x".repeat(501) })).toThrow();
    const wait = UrbanDesignIntentSchema.parse({
      version: 1,
      status: "wait",
      goal: "Wait for better evidence",
      rationale: "The site is not ready.",
    });
    expect(
      resolveUrbanDesignIntent({ value: wait, context: { siteContext: context, anchors: [anchor] } }),
    ).toMatchObject({ proposal: null, seed: null });
  });

  test("projects bounded coordinate-free prompt context with grammar cards and natural player direction", () => {
    const context = site();
    const anchors = anchorsFor(context);
    const projected = buildUrbanDesignPromptContext({
      siteContext: context,
      anchors,
      playerDirection: "沿河做漂亮一点，但这一片也可以自由发挥",
      strategicContext: {
        goal: "Grow safely",
        phase: "expansion",
        strategy: "infill",
        operationalNote: "Demand is stable",
      },
    });
    expect(UrbanDesignPromptContextSchema.parse(projected)).toEqual(projected);
    expect(JSON.stringify(projected)).toContain("waterfront-linear");
    expect(JSON.stringify(projected)).not.toContain("sourceEntity");
    expect(JSON.stringify(projected)).not.toMatch(/"[xz]"\s*:/);
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      URBAN_DESIGN_PROMPT_CONTEXT_MAX_BYTES,
    );
    expect(
      buildMayorPrompt({
        goal: "Grow safely",
        tick: 1,
        memory: {
          phase: "expansion",
          strategy: "infill",
          importantAreas: [],
          recentMilestones: [],
          unresolvedProblems: [],
          nextGoal: "",
        },
        operationalSignals: {
          demandPersistenceTicks: { residential: 0, commercial: 0, industrial: 0, office: 0 },
          consecutiveNoConstructionTicks: 0,
          populationStagnationTicks: 0,
          treasury: { sessionStart: 1000, current: 1000, change: 0 },
          previousNoOpStatus: null,
          note: "stable",
        },
        snapshot: { urbanDesign: { siteContext: context, anchors } },
        lastBatchResult: null,
        command: { text: "给我建一个欧洲风格老城", source: "text", createdAt: "fixture" },
        urbanDesign: { siteContext: context, anchors },
      }),
    ).toContain("compact-urban");
    const prompt = buildMayorPrompt({
      goal: "Expand safely",
      tick: 1,
      memory: {
        phase: "expansion",
        strategy: "open a new district",
        importantAreas: [],
        recentMilestones: [],
        unresolvedProblems: [],
        nextGoal: "plan an edge",
      },
      operationalSignals: {
        demandPersistenceTicks: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        consecutiveNoConstructionTicks: 0,
        populationStagnationTicks: 0,
        treasury: { sessionStart: 1000, current: 1000, change: 0 },
        previousNoOpStatus: null,
        note: "stable",
      },
      snapshot: { urbanDesign: { siteContext: context, anchors } },
      lastBatchResult: null,
      command: null,
      urbanDesign: { siteContext: context, anchors },
    });
    expect(prompt).toContain("first include a design urbanDesignIntent");
    expect(prompt).toContain("canonicalUrbanDesignIntentExample");
    expect(prompt).toContain('"version":1');
    expect(prompt).toContain('"status":"design"');
    expect(prompt).toContain('"strength":"subtle"');
    expect(prompt).toContain('"secondaryInfluence":{"styleId":"terrain-organic","strength":"subtle"}');
    expect(prompt).toContain("normally omit dimensions");
    expect(prompt).toContain("under 300 characters");
  });

  test("requires verified waterfront evidence and preserves MayorPlan compatibility", () => {
    const dry = site();
    const anchor = anchorsFor(dry)[0];
    expect(() =>
      validateUrbanDesignIntent(
        {
          ...intent(anchor.id),
          primaryStyle: "waterfront-linear",
          preferredMotif: undefined,
          secondaryInfluence: undefined,
          developmentEmphasis: "waterfront",
        },
        { siteContext: dry, anchors: [anchor] },
      ),
    ).toThrow("verified waterfront");
    expect(
      MayorPlanSchema.parse({
        status: "ok",
        objective: "observe",
        rationale: "No action",
        blockingReason: "No safe action",
        actions: [],
        simulation: { run: false },
        memoryUpdate: {},
        stop: { requested: false },
      }),
    ).not.toHaveProperty("urbanDesignIntent");
  });

  test("spatial design decision contract excludes legacy execution fields", () => {
    const context = site();
    const anchor = anchorsFor(context)[0];
    const decision = parseUrbanDesignDecision(
      JSON.stringify({
        version: 1,
        status: "design",
        urbanDesignIntent: intent(anchor.id),
      }),
    );
    expect(UrbanDesignDecisionSchema.parse(decision)).toEqual(decision);
    expect(() =>
      parseUrbanDesignDecision(
        JSON.stringify({
          version: 1,
          status: "design",
          urbanDesignIntent: intent(anchor.id),
          actions: [{ type: "choose_candidate", candidateId: "R-73633" }],
        }),
      ),
    ).toThrow();
    const prompt = buildUrbanDesignDecisionPrompt({
      goal: "Plan a new district with a coherent spatial identity.",
      tick: 1,
      urbanDesign: { siteContext: context, anchors: [anchor], novelty: null },
      playerDirection: "Make this district feel distinct.",
      strategicContext: {
        goal: "Plan a new district",
        phase: "expansion",
        strategy: "plan safely",
        operationalNote: "Demand is persistent",
      },
    });
    expect(prompt).toContain("dedicated spatial design decision");
    expect(prompt).not.toContain("R-73633");
    expect(prompt).not.toContain("C-73633");
    expect(prompt).not.toMatch(/"actions"\s*:/);
    expect(prompt).not.toMatch(/"x[z12]?"\s*:/);
    expect(URBAN_DESIGN_DECISION_SYSTEM_PROMPT).toContain("Do not output actions");
    expect(() => UrbanDesignDecisionSchema.parse({ version: 1, status: "wait" })).not.toThrow();
  });
});
