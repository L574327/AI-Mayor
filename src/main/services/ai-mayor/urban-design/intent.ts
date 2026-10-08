import { z } from "zod";
import { resolveUrbanDesignMixCompatibility } from "./grammar";
import { getBundledUrbanGrammar } from "./loader";
import type { UrbanDesignNoveltySummary } from "./novelty";
import { generateUrbanDesignProposal, type UrbanDesignPlannerResult } from "./proposal";
import {
  PlanningAnchorSchema,
  stableUrbanDesignHash,
  type UrbanPlanningAnchor,
  type UrbanSiteContext,
  UrbanSiteContextSchema,
} from "./site-context";

export const URBAN_DESIGN_INTENT_VERSION = 1 as const;
export const URBAN_DESIGN_INTENT_MAX_ADAPTATION_PRIORITIES = 4;

const boundedText = z.string().trim().min(1).max(240);
const styleId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]{1,47}$/);
const anchorId = z.string().trim().min(1).max(160);
const influenceDimension = z.enum(["block_scale", "density", "commercial", "green", "curvature", "transit"]);

const UrbanDesignIntentFieldsSchema = z
  .object({
    goal: boundedText,
    primaryStyle: styleId.optional(),
    secondaryInfluence: z
      .object({
        styleId,
        strength: z.enum(["subtle", "moderate"]),
        dimensions: z.array(influenceDimension).max(6).optional(),
      })
      .strict()
      .optional(),
    preferredAnchorId: anchorId.optional(),
    preferredMotif: styleId.optional(),
    density: z.enum(["low", "medium", "high", "gradient"]).optional(),
    developmentEmphasis: z.enum(["infill", "edge_expansion", "waterfront", "center", "balanced"]).optional(),
    roadCharacter: z.enum(["local_first", "balanced", "collector_spine", "fine_grain"]).optional(),
    commercialTendency: z.enum(["none", "nodes", "main_street", "edge", "mixed_core", "planner_choice"]).optional(),
    greenSpaceTendency: z.enum(["minimal", "distributed", "central", "linear", "buffer", "planner_choice"]).optional(),
    adaptationPriorities: z
      .array(z.enum(["terrain", "waterfront", "existing_roads", "gateway", "owned_land", "pollution_buffer"]))
      .max(URBAN_DESIGN_INTENT_MAX_ADAPTATION_PRIORITIES)
      .optional(),
    variationSeed: z.string().trim().min(1).max(120).optional(),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

function requireDesignIntentFields(
  intent: {
    primaryStyle?: string;
    preferredAnchorId?: string;
    density?: string;
    developmentEmphasis?: string;
    roadCharacter?: string;
    commercialTendency?: string;
    greenSpaceTendency?: string;
    goal?: string;
    secondaryInfluence?: unknown;
  },
  context: z.RefinementCtx,
) {
  const required: Array<[keyof typeof intent, string]> = [
    ["primaryStyle", "primaryStyle"],
    ["preferredAnchorId", "preferredAnchorId"],
    ["density", "density"],
    ["developmentEmphasis", "developmentEmphasis"],
    ["roadCharacter", "roadCharacter"],
    ["commercialTendency", "commercialTendency"],
    ["greenSpaceTendency", "greenSpaceTendency"],
  ];
  for (const [field, name] of required) {
    if (intent[field] === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${name} is required for a design intent`,
      });
  }
  if (intent.secondaryInfluence && !intent.primaryStyle) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["secondaryInfluence"],
      message: "secondary influence requires a primary style",
    });
  }
}

export const UrbanDesignIntentSchema = z
  .object({
    version: z.literal(URBAN_DESIGN_INTENT_VERSION),
    status: z.enum(["design", "continue", "wait"]),
    ...UrbanDesignIntentFieldsSchema.shape,
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.status === "wait") return;
    requireDesignIntentFields(intent, context);
  });

/** Model-facing intent: outer UrbanDesignDecision owns protocol version and status. */
export const UrbanDesignIntentWireSchema = UrbanDesignIntentFieldsSchema.superRefine((intent, context) => {
  requireDesignIntentFields(intent, context);
});

export type UrbanDesignIntent = z.infer<typeof UrbanDesignIntentSchema>;
export type UrbanDesignIntentWire = z.infer<typeof UrbanDesignIntentWireSchema>;

export interface UrbanDesignSnapshotContext {
  siteContext: UrbanSiteContext;
  anchors: readonly UrbanPlanningAnchor[];
  novelty?: UrbanDesignNoveltySummary | null;
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function validateUrbanDesignIntent(value: unknown, contextInput: UrbanDesignSnapshotContext): UrbanDesignIntent {
  const intent = UrbanDesignIntentSchema.parse(value);
  if (intent.status === "wait") return intent;
  const context = UrbanSiteContextSchema.parse(contextInput.siteContext);
  const anchors = contextInput.anchors.map((anchor) => PlanningAnchorSchema.parse(anchor));
  const primaryStyle = intent.primaryStyle;
  const preferredAnchorId = intent.preferredAnchorId;
  if (!primaryStyle || !preferredAnchorId)
    throw new Error("design intent requires a primary style and preferred anchor");
  const grammar = getBundledUrbanGrammar(primaryStyle);
  if (!grammar) throw new Error(`urban design primary style is not available: ${primaryStyle}`);
  const anchor = anchors.find((candidate) => candidate.id === preferredAnchorId);
  if (!anchor) throw new Error(`urban design anchor is not available in the current SiteContext: ${preferredAnchorId}`);
  if (intent.preferredMotif && !grammar.motifs.some((motif) => motif.id === intent.preferredMotif)) {
    throw new Error(`urban design motif is not available in the selected grammar: ${intent.preferredMotif}`);
  }
  if (intent.secondaryInfluence) {
    const secondary = getBundledUrbanGrammar(intent.secondaryInfluence.styleId);
    if (!secondary)
      throw new Error(`urban design secondary style is not available: ${intent.secondaryInfluence.styleId}`);
    if (secondary.id === grammar.id) throw new Error("urban design secondary style must differ from primary style");
    const compatibility = resolveUrbanDesignMixCompatibility(grammar, secondary);
    if (compatibility.status === "incompatible") throw new Error("secondary_influence_incompatible");
    const requestedDimensions = intent.secondaryInfluence.dimensions ?? [];
    const allowed = new Set(compatibility.allowedDimensions);
    for (const dimension of requestedDimensions) {
      if (!allowed.has(dimension))
        throw new Error(`secondary influence dimension is not allowed by the primary grammar: ${dimension}`);
    }
  }
  if (primaryStyle === "waterfront-linear" && (!context.water.opportunity || !anchor.waterfrontEligible)) {
    throw new Error("waterfront design requires a verified waterfront opportunity and anchor");
  }
  return intent;
}

export function validateUrbanDesignIntentAgainstSnapshot(value: unknown, snapshot: unknown): UrbanDesignIntent {
  const urbanDesign = snapshotRecord(snapshot).urbanDesign;
  const record = snapshotRecord(urbanDesign);
  const context = UrbanSiteContextSchema.safeParse(record.siteContext);
  const anchors = Array.isArray(record.anchors)
    ? record.anchors.map((anchor) => PlanningAnchorSchema.safeParse(anchor))
    : [];
  if (!context.success || anchors.length === 0 || anchors.some((result) => !result.success)) {
    const intent = UrbanDesignIntentSchema.parse(value);
    if (intent.status === "wait") return intent;
    throw new Error("urban design SiteContext is unavailable for a design intent");
  }
  return validateUrbanDesignIntent(value, {
    siteContext: context.data,
    anchors: anchors.flatMap((result) => (result.success ? [result.data] : [])),
  });
}

export interface UrbanDesignIntentResolution {
  intent: UrbanDesignIntent;
  proposal: UrbanDesignPlannerResult | null;
  seed: string | null;
}

export function resolveUrbanDesignIntent(input: {
  value: unknown;
  context: UrbanDesignSnapshotContext;
}): UrbanDesignIntentResolution {
  const intent = validateUrbanDesignIntent(input.value, input.context);
  if (intent.status === "wait") return { intent, proposal: null, seed: null };
  const seed =
    intent.variationSeed ??
    `udl-${stableUrbanDesignHash(`${input.context.siteContext.snapshotRevision}|${intent.goal}|${intent.primaryStyle}|${intent.preferredAnchorId}`)}`;
  const anchor = input.context.anchors.find((candidate) => candidate.id === intent.preferredAnchorId);
  if (!anchor || !intent.primaryStyle) throw new Error("validated design intent lost its anchor or primary style");
  const proposal = generateUrbanDesignProposal({
    context: input.context.siteContext,
    anchor,
    grammarId: intent.primaryStyle,
    preferredMotif: intent.preferredMotif,
    secondaryStyleId: intent.secondaryInfluence?.styleId,
    secondaryStrength: intent.secondaryInfluence?.strength,
    developmentEmphasis: intent.developmentEmphasis,
    seed,
  });
  return { intent, proposal, seed };
}
