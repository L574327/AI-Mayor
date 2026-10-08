import { z } from "zod";
import type { UrbanDesignPromptCard } from "./grammar";
import { getBundledUrbanGrammarPromptCards } from "./loader";
import { type UrbanDesignNoveltySummary, UrbanDesignNoveltySummarySchema } from "./novelty";
import {
  PlanningAnchorSchema,
  type UrbanPlanningAnchor,
  type UrbanSiteContext,
  UrbanSiteContextSchema,
} from "./site-context";

export const URBAN_DESIGN_PROMPT_CONTEXT_MAX_BYTES = 12_000;
export const URBAN_DESIGN_PROMPT_CONTEXT_VERSION = 1 as const;

const boundedText = z.string().trim().min(1).max(240);
const promptCardSchema = z
  .object({
    styleId: boundedText,
    version: boundedText,
    name: boundedText,
    summary: boundedText,
    identity: z.array(boundedText).max(8),
    variation: boundedText,
    motifs: z.array(z.object({ id: boundedText, name: boundedText, summary: boundedText }).strict()).max(12),
    allowInfluenceDimensions: z.array(z.string().max(32)).max(6),
  })
  .strict();

const projectedSiteSchema = z
  .object({
    siteId: boundedText,
    snapshotRevision: boundedText,
    areaClass: z.string().max(32),
    buildableAreaBand: z.string().max(32),
    terrain: z
      .object({ availability: z.string().max(32), slopeProfile: z.string().max(32), roughness: z.string().max(32) })
      .strict(),
    water: z
      .object({ availability: z.string().max(32), relationship: z.string().max(32), opportunity: z.boolean() })
      .strict(),
    roadContext: z
      .object({
        geometry: z.string().max(32),
        dominantOrientation: z.string().max(32),
        endpointCount: z.number().int().min(0).max(512),
        gatewayCount: z.number().int().min(0).max(128),
        hierarchyEvidence: z.array(boundedText).max(6),
      })
      .strict(),
    development: z
      .object({
        buildingCount: z.number().int().min(0).max(2_000),
        developedClusterCount: z.number().int().min(0).max(64),
        extentBand: z.string().max(32),
      })
      .strict(),
    frontage: z
      .object({ opportunityBand: z.string().max(32), availableRoadsideCells: z.number().int().min(0).max(512) })
      .strict(),
    constraints: z.array(boundedText).max(12),
    opportunities: z.array(boundedText).max(12),
    unavailableSignals: z.array(boundedText).max(12),
  })
  .strict();

const projectedAnchorSchema = z
  .object({
    id: boundedText,
    kind: boundedText,
    rank: z.number().int().min(0).max(7),
    orientation: z.string().max(32),
    areaClass: z.string().max(32),
    terrainProfile: z.string().max(32),
    waterfrontEligible: z.boolean(),
    availableFrontageCells: z.number().int().min(0).max(512),
    adaptationHints: z.array(boundedText).max(6),
  })
  .strict();

export const UrbanDesignPromptContextSchema = z
  .object({
    version: z.literal(URBAN_DESIGN_PROMPT_CONTEXT_VERSION),
    role: z.literal("urban_designer"),
    instructions: z.array(boundedText).max(6),
    playerDirection: z.string().trim().max(500).nullable(),
    strategicContext: z
      .object({ goal: boundedText, phase: boundedText, strategy: boundedText, operationalNote: boundedText })
      .strict(),
    site: projectedSiteSchema,
    anchors: z.array(projectedAnchorSchema).max(8),
    grammars: z.array(promptCardSchema).max(5),
    novelty: UrbanDesignNoveltySummarySchema.nullable(),
  })
  .strict();

export type UrbanDesignPromptContext = z.infer<typeof UrbanDesignPromptContextSchema>;

export interface UrbanDesignPromptInput {
  siteContext: UrbanSiteContext;
  anchors: readonly UrbanPlanningAnchor[];
  playerDirection: string | null;
  strategicContext: { goal: string; phase: string; strategy: string; operationalNote: string };
  novelty?: UrbanDesignNoveltySummary | null;
}

export function buildUrbanDesignPromptContext(input: UrbanDesignPromptInput): UrbanDesignPromptContext {
  const site = UrbanSiteContextSchema.parse(input.siteContext);
  const anchors = input.anchors.map((anchor) => PlanningAnchorSchema.parse(anchor)).slice(0, 8);
  const cards: readonly UrbanDesignPromptCard[] = getBundledUrbanGrammarPromptCards();
  const projected: UrbanDesignPromptContext = {
    version: URBAN_DESIGN_PROMPT_CONTEXT_VERSION,
    role: "urban_designer",
    instructions: [
      "Choose high-level urban design intent only; do not emit coordinates or construction actions inside urbanDesignIntent.",
      "Select primaryStyle only from grammars and preferredAnchorId only from anchors shown here.",
      "A secondary influence is optional and limited to one style; primary identity remains dominant.",
      "Use urbanDesignIntent for new districts, road/spatial expansion, coordinated spatial construction or explicit area/style direction; routine operations may remain on the legacy path.",
      "If the site does not support the requested style, choose wait or explain the tradeoff; never fabricate a waterfront or geometry.",
      "Spatial Planner owns coordinates, geometry, collision, slope, water, native validation and execution safety.",
    ],
    playerDirection: input.playerDirection?.trim().slice(0, 500) || null,
    strategicContext: {
      goal: input.strategicContext.goal.trim().slice(0, 240),
      phase: input.strategicContext.phase.trim().slice(0, 240),
      strategy: input.strategicContext.strategy.trim().slice(0, 240),
      operationalNote: input.strategicContext.operationalNote.trim().slice(0, 240),
    },
    site: {
      siteId: site.siteId,
      snapshotRevision: site.snapshotRevision,
      areaClass: site.areaClass,
      buildableAreaBand: site.buildableAreaBand,
      terrain: {
        availability: site.terrain.availability,
        slopeProfile: site.terrain.slopeProfile,
        roughness: site.terrain.roughness,
      },
      water: {
        availability: site.water.availability,
        relationship: site.water.relationship,
        opportunity: site.water.opportunity,
      },
      roadContext: {
        geometry: site.roadContext.geometry,
        dominantOrientation: site.roadContext.dominantOrientation,
        endpointCount: site.roadContext.endpointCount,
        gatewayCount: site.roadContext.gatewayCount,
        hierarchyEvidence: site.roadContext.hierarchyEvidence,
      },
      development: {
        buildingCount: site.development.buildingCount,
        developedClusterCount: site.development.developedClusterCount,
        extentBand: site.development.extentBand,
      },
      frontage: {
        opportunityBand: site.frontage.opportunityBand,
        availableRoadsideCells: site.frontage.availableRoadsideCells,
      },
      constraints: site.constraints,
      opportunities: site.opportunities,
      unavailableSignals: site.unavailableSignals,
    },
    anchors: anchors.map(
      ({
        id,
        kind,
        rank,
        orientation,
        areaClass,
        terrainProfile,
        waterfrontEligible,
        availableFrontageCells,
        adaptationHints,
      }) => ({
        id,
        kind,
        rank,
        orientation,
        areaClass,
        terrainProfile,
        waterfrontEligible,
        availableFrontageCells,
        adaptationHints,
      }),
    ),
    grammars: cards.map((card) => ({
      ...card,
      identity: [...card.identity],
      motifs: card.motifs.map((motif) => ({ ...motif })),
      allowInfluenceDimensions: [...card.allowInfluenceDimensions],
    })),
    novelty: input.novelty ?? null,
  };
  const parsed = UrbanDesignPromptContextSchema.parse(projected);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > URBAN_DESIGN_PROMPT_CONTEXT_MAX_BYTES) {
    throw new Error(`urban design prompt context exceeds ${URBAN_DESIGN_PROMPT_CONTEXT_MAX_BYTES} bytes`);
  }
  return parsed;
}

export function readUrbanDesignSnapshot(
  value: unknown,
): { siteContext: UrbanSiteContext; anchors: UrbanPlanningAnchor[]; novelty: UrbanDesignNoveltySummary | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const urbanDesign = (value as Record<string, unknown>).urbanDesign;
  if (typeof urbanDesign !== "object" || urbanDesign === null || Array.isArray(urbanDesign)) return null;
  const record = urbanDesign as Record<string, unknown>;
  const site = UrbanSiteContextSchema.safeParse(record.siteContext);
  const anchors = Array.isArray(record.anchors)
    ? record.anchors.map((anchor) => PlanningAnchorSchema.safeParse(anchor))
    : [];
  if (!site.success || anchors.length === 0 || anchors.some((anchor) => !anchor.success)) return null;
  const novelty = UrbanDesignNoveltySummarySchema.safeParse(record.novelty);
  return {
    siteContext: site.data,
    anchors: anchors.flatMap((anchor) => (anchor.success ? [anchor.data] : [])),
    novelty: novelty.success ? novelty.data : null,
  };
}
