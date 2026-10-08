import { z } from "zod";
import type { UrbanDesignDevelopmentPolicy } from "../types";
import { createUrbanDesignRng, resolveUrbanDesignMixCompatibility, type UrbanGrammarPack } from "./grammar";
import { getBundledUrbanGrammar } from "./loader";
import {
  PlanningAnchorSchema,
  stableUrbanDesignHash,
  type UrbanPlanningAnchor,
  type UrbanSiteContext,
  UrbanSiteContextSchema,
} from "./site-context";

export const URBAN_DESIGN_PROPOSAL_MAX_TRADEOFFS = 6;
export const URBAN_DESIGN_PROPOSAL_MAX_CONSTRAINTS = 12;
export const URBAN_DESIGN_PROPOSAL_MAX_FUTURE_STAGES = 3;

const boundedText = z.string().trim().min(1).max(240);
const developmentPolicySchema = z.enum(["infill", "expand_first", "mixed"]);
const sampleSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9_-]{1,47}$/), z.number().finite().min(0).max(10_000));
const metricVectorSchema = z
  .object({
    roadHierarchyCoherence: z.number().finite().min(0).max(1),
    connectivity: z.number().finite().min(0).max(1),
    frontageUtilization: z.number().finite().min(0).max(1),
    terrainFit: z.number().finite().min(0).max(1),
    shorelineFit: z.number().finite().min(0).max(1),
    blockScaleFit: z.number().finite().min(0).max(1),
    blockVariation: z.number().finite().min(0).max(1),
    deadEndControl: z.number().finite().min(0).max(1),
    landUseBuffering: z.number().finite().min(0).max(1),
    greenDistribution: z.number().finite().min(0).max(1),
    noveltyDistance: z.number().finite().min(0).max(1),
  })
  .strict();

const semanticSchema = z
  .object({
    topology: z.enum(["grid", "organic", "linear", "filtered", "node"]),
    blockScale: z.enum(["small", "small_medium", "medium", "medium_large", "mixed"]),
    roadHierarchy: z.enum(["local_first", "balanced", "collector_spine", "fine_grain"]),
    curvature: z.enum(["orthogonal", "low", "moderate", "high", "shoreline_adapted"]),
    density: z.enum(["low", "medium", "high", "gradient"]),
    commercial: z.enum(["none", "nodes", "main_street", "edge", "mixed_core"]),
    green: z.enum(["minimal", "distributed", "central", "linear", "buffer"]),
  })
  .strict();

const adaptationSchema = z.array(boundedText).max(8);
const secondarySchema = z
  .object({
    styleId: boundedText,
    strength: z.enum(["subtle", "moderate"]),
    dimensions: z.array(z.enum(["block_scale", "density", "commercial", "green", "curvature", "transit"])).max(6),
  })
  .strict();

const baseProposalSchema = z
  .object({
    proposalId: boundedText,
    intentId: boundedText,
    siteId: boundedText,
    anchorId: boundedText,
    snapshotRevision: boundedText,
    developmentPolicy: developmentPolicySchema.optional(),
    variationSeed: z.string().trim().min(1).max(120).optional(),
    grammar: z
      .object({
        primary: boundedText,
        primaryVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        secondary: boundedText.optional(),
      })
      .strict(),
    designSummary: boundedText,
    motif: boundedText,
    designSignature: boundedText,
    semantics: semanticSchema,
    secondaryInfluence: secondarySchema.optional(),
    terrainWaterfrontAdaptations: adaptationSchema,
    parameterSample: sampleSchema,
    tradeoffs: z.array(boundedText).max(URBAN_DESIGN_PROPOSAL_MAX_TRADEOFFS),
    activeCandidates: z.array(z.never()).max(0),
    futureStages: z
      .array(
        z
          .object({
            after: z.literal("fresh_snapshot"),
            goal: boundedText,
          })
          .strict(),
      )
      .max(URBAN_DESIGN_PROPOSAL_MAX_FUTURE_STAGES),
    utilityServiceImplications: z.array(boundedText).max(6),
    estimatedCapacity: z
      .object({
        band: z.enum(["none", "small", "medium", "large"]),
        approximateCells: z.number().int().min(0).max(512).optional(),
      })
      .strict(),
    estimatedCost: z.object({ band: z.enum(["unknown"]), amount: z.undefined().optional() }).strict(),
    metrics: metricVectorSchema.nullable(),
    metricState: z.enum(["deferred_until_geometry", "semantic_only"]),
    constraints: z.array(boundedText).max(URBAN_DESIGN_PROPOSAL_MAX_CONSTRAINTS),
    validation: z
      .object({
        state: z.enum(["partial", "rejected"]),
        validatedCandidateCount: z.literal(0),
        rejectionReasons: z.array(boundedText).max(6),
      })
      .strict(),
  })
  .strict();

const noProposalSchema = z
  .object({
    status: z.literal("no_proposal"),
    proposalId: boundedText,
    siteId: boundedText,
    anchorId: boundedText,
    grammar: boundedText,
    reason: boundedText,
    constraints: z.array(boundedText).max(URBAN_DESIGN_PROPOSAL_MAX_CONSTRAINTS),
  })
  .strict();

export const UrbanDesignProposalSchema = baseProposalSchema.extend({ status: z.literal("proposal") });
export const UrbanDesignPlannerResultSchema = z.union([UrbanDesignProposalSchema, noProposalSchema]);

export type UrbanDesignProposal = z.infer<typeof UrbanDesignProposalSchema>;
export type UrbanDesignPlannerResult = z.infer<typeof UrbanDesignPlannerResultSchema>;

export interface UrbanDesignProposalInput {
  context: UrbanSiteContext;
  anchor: UrbanPlanningAnchor;
  grammarId: string;
  preferredMotif?: string;
  seed: string;
  secondaryStyleId?: string;
  secondaryStrength?: "subtle" | "moderate";
  developmentEmphasis?: "infill" | "edge_expansion" | "waterfront" | "center" | "balanced";
}

function developmentPolicyFor(
  emphasis: UrbanDesignProposalInput["developmentEmphasis"],
): UrbanDesignDevelopmentPolicy | undefined {
  if (emphasis === "infill") return "infill";
  if (emphasis === "edge_expansion" || emphasis === "waterfront") return "expand_first";
  if (emphasis === "center" || emphasis === "balanced") return "mixed";
  return undefined;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function matchesCondition(
  context: UrbanSiteContext,
  condition: UrbanGrammarPack["adaptationRules"][number]["when"],
): boolean {
  if (condition.areaClass && !condition.areaClass.includes(context.areaClass)) return false;
  if (
    condition.slopeProfile &&
    !condition.slopeProfile.includes(context.terrain.slopeProfile as (typeof condition.slopeProfile)[number])
  )
    return false;
  if (condition.waterRelationship) {
    const relationship = context.water.relationship;
    if (!condition.waterRelationship.includes(relationship as (typeof condition.waterRelationship)[number]))
      return false;
  }
  if (
    condition.roadGeometry &&
    !condition.roadGeometry.includes(context.roadContext.geometry as (typeof condition.roadGeometry)[number])
  )
    return false;
  return true;
}

function topologyForGrammar(grammarId: string, motifId: string): z.infer<typeof semanticSchema>["topology"] {
  if (grammarId === "orthogonal-grid") return motifId === "filtered-grid" ? "filtered" : "grid";
  if (grammarId === "terrain-organic") return "organic";
  if (grammarId === "waterfront-linear") return "linear";
  if (grammarId === "garden-neighborhood") return motifId === "filtered-garden-grid" ? "filtered" : "organic";
  return motifId === "civic-square-frame" ? "node" : "filtered";
}

function semanticsFor(grammarId: string, motifId: string): z.infer<typeof semanticSchema> {
  switch (grammarId) {
    case "orthogonal-grid":
      return {
        topology: topologyForGrammar(grammarId, motifId),
        blockScale: "medium_large",
        roadHierarchy: "balanced",
        curvature: "orthogonal",
        density: "gradient",
        commercial: motifId === "gateway-grid" ? "edge" : "main_street",
        green: motifId === "filtered-grid" ? "distributed" : "minimal",
      };
    case "terrain-organic":
      return {
        topology: "organic",
        blockScale: "mixed",
        roadHierarchy: "collector_spine",
        curvature: "high",
        density: "medium",
        commercial: "nodes",
        green: "distributed",
      };
    case "waterfront-linear":
      return {
        topology: "linear",
        blockScale: "medium",
        roadHierarchy: "collector_spine",
        curvature: "shoreline_adapted",
        density: "gradient",
        commercial: motifId === "waterfront-nodes" ? "nodes" : "main_street",
        green: motifId === "waterfront-nodes" ? "linear" : "buffer",
      };
    case "garden-neighborhood":
      return {
        topology: topologyForGrammar(grammarId, motifId),
        blockScale: "small_medium",
        roadHierarchy: "local_first",
        curvature: motifId === "filtered-garden-grid" ? "low" : "moderate",
        density: "low",
        commercial: "none",
        green: "distributed",
      };
    default:
      return {
        topology: topologyForGrammar(grammarId, motifId),
        blockScale: "small",
        roadHierarchy: "fine_grain",
        curvature: "moderate",
        density: "high",
        commercial: motifId === "market-spine" ? "main_street" : "mixed_core",
        green: "central",
      };
  }
}

function adaptationHints(context: UrbanSiteContext, anchor: UrbanPlanningAnchor, grammarId: string): string[] {
  const hints = [...anchor.adaptationHints];
  if (context.terrain.slopeProfile !== "flat") {
    hints.push(grammarId === "terrain-organic" ? "follow_feasible_contours" : "reduce_cross_slope_alignment");
  }
  if (context.water.opportunity && grammarId !== "waterfront-linear") hints.push("respect_verified_water_boundary");
  if (grammarId === "waterfront-linear") hints.push("shoreline_only_when_waterfront_anchor_is_verified");
  return [...new Set(hints)].slice(0, 8);
}

function parameterSample(
  grammar: UrbanGrammarPack,
  seed: string,
  context: UrbanSiteContext,
  anchor: UrbanPlanningAnchor,
) {
  const rng = createUrbanDesignRng(`${seed}|${context.snapshotRevision}|${anchor.id}|${grammar.id}|${grammar.version}`);
  const sample: Record<string, number> = {};
  for (const name of Object.keys(grammar.parameters).sort()) {
    const range = grammar.parameters[name];
    sample[name] = rounded(rng.range(range.min, range.max));
  }
  return sample;
}

function proposalId(
  input: UrbanDesignProposalInput,
  grammar: UrbanGrammarPack,
  motif: string,
  sample: Record<string, number>,
): string {
  return `proposal-${stableUrbanDesignHash(
    [
      input.context.siteId,
      input.context.snapshotRevision,
      input.anchor.id,
      grammar.id,
      grammar.version,
      input.seed,
      motif,
      Object.keys(sample)
        .sort()
        .map((key) => `${key}=${sample[key]}`)
        .join(","),
    ].join("|"),
  )}`;
}

function noProposal(input: UrbanDesignProposalInput, reason: string): UrbanDesignPlannerResult {
  const id = `proposal-${stableUrbanDesignHash(`${input.context.siteId}|${input.context.snapshotRevision}|${input.anchor.id}|${input.grammarId}|${input.seed}`)}`;
  return {
    status: "no_proposal",
    proposalId: id,
    siteId: input.context.siteId,
    anchorId: input.anchor.id,
    grammar: input.grammarId,
    reason,
    constraints: ["proposal_contains_no_executable_geometry", "spatial_planner_validation_required"],
  };
}

export function generateUrbanDesignProposal(input: UrbanDesignProposalInput): UrbanDesignPlannerResult {
  const context = UrbanSiteContextSchema.parse(input.context);
  const anchor = PlanningAnchorSchema.parse(input.anchor);
  const grammar = getBundledUrbanGrammar(input.grammarId);
  if (!grammar) return noProposal(input, "selected grammar is unavailable");
  if (grammar.id === "waterfront-linear" && (!context.water.opportunity || !anchor.waterfrontEligible)) {
    return noProposal(input, "waterfront grammar requires a verified waterfront opportunity and anchor");
  }
  const secondary = input.secondaryStyleId ? getBundledUrbanGrammar(input.secondaryStyleId) : undefined;
  if (input.secondaryStyleId && (!secondary || secondary.id === grammar.id)) {
    return noProposal(input, "secondary influence is unavailable or duplicates the primary grammar");
  }
  const matchedRule = grammar.adaptationRules.find((rule) => matchesCondition(context, rule.when));
  const motif =
    input.preferredMotif ??
    matchedRule?.preferMotif ??
    createUrbanDesignRng(`${input.seed}|${anchor.id}|${grammar.id}`).pick(
      [...grammar.motifs].sort((left, right) => left.id.localeCompare(right.id)),
    ).id;
  const sample = parameterSample(grammar, input.seed, context, anchor);
  const semantics = semanticsFor(grammar.id, motif);
  const adaptations = adaptationHints(context, anchor, grammar.id);
  const secondaryDimensions = secondary
    ? [...resolveUrbanDesignMixCompatibility(grammar, secondary).allowedDimensions].slice(0, 6)
    : [];
  const result: UrbanDesignProposal = {
    status: "proposal",
    proposalId: proposalId(input, grammar, motif, sample),
    intentId: `phase2-${input.context.siteId}`,
    siteId: input.context.siteId,
    anchorId: anchor.id,
    snapshotRevision: input.context.snapshotRevision,
    ...(developmentPolicyFor(input.developmentEmphasis)
      ? { developmentPolicy: developmentPolicyFor(input.developmentEmphasis) }
      : {}),
    variationSeed: input.seed,
    grammar: {
      primary: grammar.id,
      primaryVersion: grammar.version,
      ...(secondary ? { secondary: secondary.id } : {}),
    },
    designSummary: `${grammar.prompt.name}: ${motif} at ${anchor.kind}; semantic geometry is deferred to Spatial Planner.`,
    motif,
    designSignature: `${grammar.id}|${semantics.topology}|${semantics.blockScale}|${semantics.curvature}|${motif}`,
    semantics,
    ...(secondary
      ? {
          secondaryInfluence: {
            styleId: secondary.id,
            strength: input.secondaryStrength ?? "subtle",
            dimensions: secondaryDimensions,
          },
        }
      : {}),
    terrainWaterfrontAdaptations: adaptations,
    parameterSample: sample,
    tradeoffs: [
      ...(semantics.topology === "organic" ? ["preserves terrain fit at the cost of regular block frontage"] : []),
      ...(semantics.topology === "grid" ? ["improves frontage legibility but may require terrain stepping"] : []),
      ...(semantics.topology === "linear" ? ["prioritizes shoreline continuity and inland connectivity"] : []),
      ...(semantics.density === "low" ? ["uses more land per household to preserve green distribution"] : []),
    ].slice(0, URBAN_DESIGN_PROPOSAL_MAX_TRADEOFFS),
    activeCandidates: [],
    futureStages: [
      {
        after: "fresh_snapshot",
        goal: "Translate this semantic proposal into Spatial Planner candidates after geometry validation.",
      },
    ],
    utilityServiceImplications: ["utility implications deferred until Spatial Planner geometry exists"],
    estimatedCapacity: {
      band: input.context.frontage.opportunityBand,
      ...(input.context.frontage.availableRoadsideCells > 0
        ? {
            approximateCells: Math.min(
              512,
              Math.floor(input.context.frontage.availableRoadsideCells * (semantics.density === "high" ? 0.8 : 0.5)),
            ),
          }
        : {}),
    },
    estimatedCost: { band: "unknown" },
    metrics: null,
    metricState: "deferred_until_geometry",
    constraints: [
      "semantic_proposal_only",
      "no_executable_coordinates",
      "spatial_planner_owns_geometry_and_safety",
      ...context.constraints.slice(0, 4),
    ].slice(0, URBAN_DESIGN_PROPOSAL_MAX_CONSTRAINTS),
    validation: { state: "partial", validatedCandidateCount: 0, rejectionReasons: [] },
  };
  return UrbanDesignPlannerResultSchema.parse(result);
}
