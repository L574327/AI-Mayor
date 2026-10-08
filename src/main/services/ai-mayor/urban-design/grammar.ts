import { z } from "zod";

export const URBAN_DESIGN_GRAMMAR_SCHEMA_VERSION = 1 as const;
export const URBAN_DESIGN_MAX_PACKS = 32;
export const URBAN_DESIGN_MAX_MOTIFS_PER_PACK = 12;
export const URBAN_DESIGN_MAX_PARAMETERS_PER_PACK = 24;
export const URBAN_DESIGN_MAX_RNG_CALLS = 128;

const boundedText = z.string().trim().min(1).max(240);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
const parameterIdentifier = z.string().regex(/^[a-z][A-Za-z0-9_-]{1,47}$/);
const weight = z.number().finite().min(0).max(1);
const boundedRange = z
  .object({
    min: z.number().finite().min(0).max(10_000),
    max: z.number().finite().min(0).max(10_000),
  })
  .strict()
  .refine((range) => range.min <= range.max, { message: "parameter range min must not exceed max" });

export const URBAN_DESIGN_OPERATOR_IDS = [
  "parallel-spine",
  "cross-links",
  "contour-path",
  "loop",
  "branch",
  "perimeter-block",
  "green-anchor",
  "shoreline-spine",
  "gateway-axis",
  "filtered-grid",
  "civic-node",
  "cluster",
] as const;

export type UrbanDesignOperatorId = (typeof URBAN_DESIGN_OPERATOR_IDS)[number];

export type UrbanDesignMixDimension = "block_scale" | "density" | "commercial" | "green" | "curvature" | "transit";

export const URBAN_DESIGN_MIX_DIMENSIONS: readonly UrbanDesignMixDimension[] = [
  "block_scale",
  "density",
  "commercial",
  "green",
  "curvature",
  "transit",
];

const mixDimension = z.enum(URBAN_DESIGN_MIX_DIMENSIONS as [UrbanDesignMixDimension, ...UrbanDesignMixDimension[]]);
const operatorId = z.enum(URBAN_DESIGN_OPERATOR_IDS);

const siteCondition = z
  .object({
    areaClass: z
      .array(z.enum(["infill", "edge", "waterfront", "gateway", "isolated_pocket"]))
      .min(1)
      .max(5)
      .optional(),
    slopeProfile: z
      .array(z.enum(["flat", "rolling", "steep", "mixed"]))
      .min(1)
      .max(4)
      .optional(),
    waterRelationship: z
      .array(z.enum(["none", "river_edge", "coastline", "crossing"]))
      .min(1)
      .max(4)
      .optional(),
    roadGeometry: z
      .array(z.enum(["grid_like", "curved", "mixed", "sparse"]))
      .min(1)
      .max(4)
      .optional(),
  })
  .strict()
  .refine((condition) => Object.keys(condition).length > 0, { message: "adaptation condition cannot be empty" });

const metricPreferences = z
  .object({
    roadHierarchyCoherence: weight,
    connectivity: weight,
    frontageUtilization: weight,
    terrainFit: weight,
    shorelineFit: weight,
    blockScaleFit: weight,
    blockVariation: weight,
    deadEndControl: weight,
    landUseBuffering: weight,
    greenDistribution: weight,
    noveltyDistance: weight,
  })
  .strict();

const antiPatterns = z
  .object({
    maxDeadEndRatio: z.number().finite().min(0).max(1),
    maxDisconnectedComponents: z.number().int().min(0).max(32),
    maxRepeatedMotifRatio: z.number().finite().min(0).max(1),
    minTerrainFit: weight,
  })
  .strict();

export const UrbanGrammarPackSchema = z
  .object({
    schemaVersion: z.literal(URBAN_DESIGN_GRAMMAR_SCHEMA_VERSION),
    id: identifier,
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+$/),
    identity: z.array(boundedText).min(1).max(8),
    prompt: z
      .object({
        name: boundedText,
        summary: boundedText,
        variation: boundedText,
      })
      .strict(),
    parameters: z
      .record(parameterIdentifier, boundedRange)
      .refine((parameters) => Object.keys(parameters).length <= URBAN_DESIGN_MAX_PARAMETERS_PER_PACK, {
        message: `grammar packs may define at most ${URBAN_DESIGN_MAX_PARAMETERS_PER_PACK} parameters`,
      }),
    motifs: z
      .array(
        z
          .object({
            id: identifier,
            name: boundedText,
            summary: boundedText,
            operators: z.array(operatorId).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(URBAN_DESIGN_MAX_MOTIFS_PER_PACK),
    adaptationRules: z
      .array(
        z
          .object({
            when: siteCondition,
            preferMotif: identifier,
            preferOperator: operatorId,
          })
          .strict(),
      )
      .max(16),
    preferences: metricPreferences,
    antiPatterns,
    mixing: z
      .object({
        allowInfluenceDimensions: z.array(mixDimension).max(6),
      })
      .strict(),
  })
  .strict()
  .superRefine((pack, context) => {
    const motifIds = new Set(pack.motifs.map((motif) => motif.id));
    for (const [index, rule] of pack.adaptationRules.entries()) {
      if (!motifIds.has(rule.preferMotif)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adaptationRules", index, "preferMotif"],
          message: `adaptation rule references unknown motif: ${rule.preferMotif}`,
        });
      }
    }
  });

export type UrbanGrammarPack = z.infer<typeof UrbanGrammarPackSchema>;

export interface UrbanDesignMixCompatibility {
  readonly status: "compatible" | "incompatible";
  readonly allowedDimensions: readonly UrbanDesignMixDimension[];
  readonly reasons: readonly string[];
}

export function resolveUrbanDesignMixCompatibility(
  primary: Pick<UrbanGrammarPack, "id" | "mixing">,
  secondary: Pick<UrbanGrammarPack, "id" | "mixing">,
): UrbanDesignMixCompatibility {
  const secondaryDimensions = new Set(secondary.mixing.allowInfluenceDimensions);
  const allowedDimensions = URBAN_DESIGN_MIX_DIMENSIONS.filter(
    (dimension) => primary.mixing.allowInfluenceDimensions.includes(dimension) && secondaryDimensions.has(dimension),
  );
  return Object.freeze({
    status: allowedDimensions.length > 0 ? "compatible" : "incompatible",
    allowedDimensions: Object.freeze(allowedDimensions),
    reasons: Object.freeze(
      allowedDimensions.length > 0
        ? []
        : [`no compatible influence dimensions between ${primary.id} and ${secondary.id}`],
    ),
  });
}

export interface UrbanDesignOperatorDefinition {
  readonly id: UrbanDesignOperatorId;
  readonly description: string;
  readonly phase: "grammar";
}

export const URBAN_DESIGN_OPERATOR_REGISTRY: Readonly<Record<UrbanDesignOperatorId, UrbanDesignOperatorDefinition>> =
  Object.freeze({
    "parallel-spine": {
      id: "parallel-spine",
      description: "A bounded line parallel to a site axis.",
      phase: "grammar",
    },
    "cross-links": { id: "cross-links", description: "Bounded links between compatible spines.", phase: "grammar" },
    "contour-path": {
      id: "contour-path",
      description: "A path following a feasible terrain contour.",
      phase: "grammar",
    },
    loop: { id: "loop", description: "A bounded local loop connected to a parent street.", phase: "grammar" },
    branch: { id: "branch", description: "A bounded branch from an existing connector.", phase: "grammar" },
    "perimeter-block": { id: "perimeter-block", description: "A compact block perimeter motif.", phase: "grammar" },
    "green-anchor": { id: "green-anchor", description: "A green-space-centered neighborhood motif.", phase: "grammar" },
    "shoreline-spine": {
      id: "shoreline-spine",
      description: "A safe public-facing shoreline alignment.",
      phase: "grammar",
    },
    "gateway-axis": { id: "gateway-axis", description: "A bounded axis from an access gateway.", phase: "grammar" },
    "filtered-grid": {
      id: "filtered-grid",
      description: "A grid with bounded local filtering and green breaks.",
      phase: "grammar",
    },
    "civic-node": { id: "civic-node", description: "A node-centered civic or market motif.", phase: "grammar" },
    cluster: { id: "cluster", description: "A bounded cluster of compatible local streets.", phase: "grammar" },
  });

export interface UrbanDesignRng {
  readonly seed: string;
  readonly calls: number;
  next(): number;
  integer(min: number, max: number): number;
  range(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function createUrbanDesignRng(seed: string): UrbanDesignRng {
  const normalizedSeed = seed.trim();
  if (normalizedSeed.length === 0 || normalizedSeed.length > 120)
    throw new Error("urban design seed must be 1-120 characters");
  let state = hashSeed(normalizedSeed) || 2_654_435_761;
  let calls = 0;
  const next = () => {
    if (calls >= URBAN_DESIGN_MAX_RNG_CALLS) throw new Error("urban design variation budget exceeded");
    calls += 1;
    state = Math.imul(state ^ (state >>> 16), 2_246_822_519);
    state = Math.imul(state ^ (state >>> 13), 3_266_489_909);
    state ^= state >>> 16;
    return (state >>> 0) / 4_294_967_296;
  };
  return {
    seed: normalizedSeed,
    get calls() {
      return calls;
    },
    next,
    integer(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || min > max)
        throw new Error("invalid urban design integer range");
      return min + Math.floor(next() * (max - min + 1));
    },
    range(min, max) {
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error("invalid urban design range");
      return min + next() * (max - min);
    },
    pick(values) {
      if (values.length === 0) throw new Error("cannot pick from an empty urban design list");
      return values[Math.floor(next() * values.length)];
    },
  };
}

export interface UrbanDesignPromptCard {
  readonly styleId: string;
  readonly version: string;
  readonly name: string;
  readonly summary: string;
  readonly identity: readonly string[];
  readonly variation: string;
  readonly motifs: readonly { id: string; name: string; summary: string }[];
  readonly allowInfluenceDimensions: readonly UrbanDesignMixDimension[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function parseUrbanGrammarPack(value: unknown): UrbanGrammarPack {
  return UrbanGrammarPackSchema.parse(value);
}

export function freezeUrbanGrammarPack(pack: UrbanGrammarPack): UrbanGrammarPack {
  return deepFreeze(pack);
}

export function toUrbanDesignPromptCard(pack: UrbanGrammarPack): UrbanDesignPromptCard {
  return Object.freeze({
    styleId: pack.id,
    version: pack.version,
    name: pack.prompt.name,
    summary: pack.prompt.summary,
    identity: Object.freeze([...pack.identity]),
    variation: pack.prompt.variation,
    motifs: Object.freeze(pack.motifs.map(({ id, name, summary }) => Object.freeze({ id, name, summary }))),
    allowInfluenceDimensions: Object.freeze([...pack.mixing.allowInfluenceDimensions]),
  });
}
