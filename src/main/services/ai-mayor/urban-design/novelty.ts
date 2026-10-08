import { z } from "zod";
import { getBundledUrbanGrammarPromptCards } from "./loader";
import { type UrbanDesignPlannerResult, type UrbanDesignProposal, UrbanDesignProposalSchema } from "./proposal";
import type { UrbanPlanningAnchor } from "./site-context";

export const URBAN_DESIGN_NOVELTY_MEMORY_VERSION = 1 as const;
export const URBAN_DESIGN_NOVELTY_MAX_ENTRIES = 20;
export const URBAN_DESIGN_NOVELTY_MAX_SERIALIZED_BYTES = 6_000;
export const URBAN_DESIGN_NOVELTY_MAX_SUMMARY_ITEMS = 5;
export const URBAN_DESIGN_NOVELTY_MAX_MATCHES = 4;

const boundedText = z.string().trim().min(1).max(96);
const styleId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]{1,47}$/);
const topology = z.enum(["grid", "organic", "linear", "filtered", "node"]);
const density = z.enum(["low", "medium", "high", "gradient"]);
const commercial = z.enum(["none", "nodes", "main_street", "edge", "mixed_core"]);
const green = z.enum(["minimal", "distributed", "central", "linear", "buffer"]);
const anchorKind = z.enum(["gateway", "road_endpoint", "central_node", "undeveloped_edge", "waterfront_opportunity"]);
const siteCharacter = z.enum(["infill", "edge", "waterfront", "gateway", "isolated_pocket", "unknown"]);

export const UrbanDesignNoveltyEntrySchema = z
  .object({
    orderIndex: z.number().int().min(0).max(1_000_000_000),
    proposalId: boundedText,
    primaryStyle: styleId,
    secondaryStyle: styleId.optional(),
    motif: styleId,
    topology,
    density,
    commercial,
    green,
    adaptationTags: z.array(boundedText).max(8),
    anchorKind: anchorKind.optional(),
    siteCharacter,
  })
  .strict();

export const UrbanDesignNoveltyMemorySchema = z
  .object({
    version: z.literal(URBAN_DESIGN_NOVELTY_MEMORY_VERSION),
    nextOrderIndex: z.number().int().min(0).max(1_000_000_000),
    entries: z.array(UrbanDesignNoveltyEntrySchema).max(URBAN_DESIGN_NOVELTY_MAX_ENTRIES),
  })
  .strict();

export type UrbanDesignNoveltyEntry = z.infer<typeof UrbanDesignNoveltyEntrySchema>;
export type UrbanDesignNoveltyMemory = z.infer<typeof UrbanDesignNoveltyMemorySchema>;

const summaryItemSchema = z
  .object({
    value: boundedText,
    count: z.number().int().min(0).max(URBAN_DESIGN_NOVELTY_MAX_ENTRIES),
    lastOrderIndex: z.number().int().min(0),
  })
  .strict();

export const UrbanDesignNoveltySummarySchema = z
  .object({
    version: z.literal(URBAN_DESIGN_NOVELTY_MEMORY_VERSION),
    entriesConsidered: z.number().int().min(0).max(URBAN_DESIGN_NOVELTY_MAX_ENTRIES),
    recentStyles: z.array(summaryItemSchema).max(URBAN_DESIGN_NOVELTY_MAX_SUMMARY_ITEMS),
    recentMotifs: z.array(summaryItemSchema).max(URBAN_DESIGN_NOVELTY_MAX_SUMMARY_ITEMS),
    repeatedPatterns: z.array(boundedText).max(6),
    underusedStyles: z.array(styleId).max(URBAN_DESIGN_NOVELTY_MAX_SUMMARY_ITEMS),
    hints: z.array(boundedText).max(6),
  })
  .strict();

export type UrbanDesignNoveltySummary = z.infer<typeof UrbanDesignNoveltySummarySchema>;

export interface UrbanDesignNoveltyScore {
  repetitionScore: number;
  noveltyScore: number;
  noveltyHints: string[];
  recentMatches: string[];
}

export interface AcceptedUrbanDesignInput {
  memory: UrbanDesignNoveltyMemory;
  result: UrbanDesignPlannerResult;
  anchor?: Pick<UrbanPlanningAnchor, "kind">;
}

export function createEmptyUrbanDesignNoveltyMemory(): UrbanDesignNoveltyMemory {
  return { version: URBAN_DESIGN_NOVELTY_MEMORY_VERSION, nextOrderIndex: 0, entries: [] };
}

function assertMemory(memory: UrbanDesignNoveltyMemory): UrbanDesignNoveltyMemory {
  const parsed = UrbanDesignNoveltyMemorySchema.parse(memory);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > URBAN_DESIGN_NOVELTY_MAX_SERIALIZED_BYTES)
    throw new Error(`urban design novelty memory exceeds ${URBAN_DESIGN_NOVELTY_MAX_SERIALIZED_BYTES} bytes`);
  return parsed;
}

function entryFromProposal(
  proposal: UrbanDesignProposal,
  orderIndex: number,
  anchor?: Pick<UrbanPlanningAnchor, "kind">,
): UrbanDesignNoveltyEntry {
  return {
    orderIndex,
    proposalId: proposal.proposalId,
    primaryStyle: proposal.grammar.primary,
    ...(proposal.grammar.secondary ? { secondaryStyle: proposal.grammar.secondary } : {}),
    motif: proposal.motif,
    topology: proposal.semantics.topology,
    density: proposal.semantics.density,
    commercial: proposal.semantics.commercial,
    green: proposal.semantics.green,
    adaptationTags: proposal.terrainWaterfrontAdaptations.slice(0, 8),
    ...(anchor ? { anchorKind: anchor.kind } : {}),
    siteCharacter: "unknown",
  };
}

export function recordAcceptedUrbanDesign(input: AcceptedUrbanDesignInput): UrbanDesignNoveltyMemory {
  const memory = assertMemory(input.memory);
  if (input.result.status !== "proposal") return memory;
  const proposal = UrbanDesignProposalSchema.parse(input.result);
  if (memory.entries.some((entry) => entry.proposalId === proposal.proposalId)) return memory;
  const nextEntry = entryFromProposal(proposal, memory.nextOrderIndex, input.anchor);
  let entries = [...memory.entries, nextEntry].slice(-URBAN_DESIGN_NOVELTY_MAX_ENTRIES);
  while (
    entries.length > 0 &&
    Buffer.byteLength(
      JSON.stringify({ version: memory.version, nextOrderIndex: memory.nextOrderIndex + 1, entries }),
      "utf8",
    ) > URBAN_DESIGN_NOVELTY_MAX_SERIALIZED_BYTES
  ) {
    entries = entries.slice(1);
  }
  return assertMemory({ version: memory.version, nextOrderIndex: memory.nextOrderIndex + 1, entries });
}

export function recordSuccessfulUrbanDesignLifecycle(input: {
  memory: UrbanDesignNoveltyMemory;
  result: UrbanDesignPlannerResult;
  lifecycle: "realized" | "executed";
  successful: boolean;
  anchor?: Pick<UrbanPlanningAnchor, "kind">;
}): UrbanDesignNoveltyMemory {
  if (!input.successful || (input.lifecycle !== "realized" && input.lifecycle !== "executed"))
    return assertMemory(input.memory);
  return recordAcceptedUrbanDesign({ memory: input.memory, result: input.result, anchor: input.anchor });
}

function compactCounts(entries: readonly UrbanDesignNoveltyEntry[], field: "primaryStyle" | "motif") {
  const counts = new Map<string, { count: number; lastOrderIndex: number }>();
  for (const entry of entries) {
    const value = entry[field];
    const previous = counts.get(value);
    counts.set(value, { count: (previous?.count ?? 0) + 1, lastOrderIndex: entry.orderIndex });
  }
  return [...counts.entries()]
    .sort(
      (left, right) =>
        right[1].count - left[1].count ||
        right[1].lastOrderIndex - left[1].lastOrderIndex ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, URBAN_DESIGN_NOVELTY_MAX_SUMMARY_ITEMS)
    .map(([value, item]) => ({ value, ...item }));
}

export function summarizeUrbanDesignNovelty(
  memory: UrbanDesignNoveltyMemory,
  availableStyleIds = getBundledUrbanGrammarPromptCards().map((card) => card.styleId),
): UrbanDesignNoveltySummary {
  const parsed = assertMemory(memory);
  const recentStyles = compactCounts(parsed.entries, "primaryStyle");
  const recentMotifs = compactCounts(parsed.entries, "motif");
  const used = new Set(recentStyles.map((item) => item.value));
  const repeatedPatterns = [
    ...recentStyles.filter((item) => item.count >= 2).map((item) => `${item.value} style repeated ${item.count} times`),
    ...recentMotifs.filter((item) => item.count >= 2).map((item) => `${item.value} motif repeated ${item.count} times`),
  ].slice(0, 6);
  const underusedStyles = [...new Set(availableStyleIds)]
    .filter((style) => !used.has(style))
    .slice(0, URBAN_DESIGN_NOVELTY_MAX_SUMMARY_ITEMS);
  const hints = [
    ...(repeatedPatterns.length > 0
      ? ["Recent repetition is soft pressure; vary motif, density or green when allowed."]
      : []),
    ...(underusedStyles.length > 0 ? [`Underused styles: ${underusedStyles.join(", ")}.`] : []),
  ].slice(0, 6);
  return UrbanDesignNoveltySummarySchema.parse({
    version: URBAN_DESIGN_NOVELTY_MEMORY_VERSION,
    entriesConsidered: parsed.entries.length,
    recentStyles,
    recentMotifs,
    repeatedPatterns,
    underusedStyles,
    hints: hints.map((hint) => hint.slice(0, 96)),
  });
}

function similarity(
  candidate: UrbanDesignProposal,
  entry: UrbanDesignNoveltyEntry,
  anchor?: Pick<UrbanPlanningAnchor, "kind">,
): number {
  const dimensions: Array<[number, boolean]> = [
    [0.25, candidate.grammar.primary === entry.primaryStyle],
    [0.1, (candidate.grammar.secondary ?? "") === (entry.secondaryStyle ?? "")],
    [0.18, candidate.motif === entry.motif],
    [0.1, candidate.semantics.topology === entry.topology],
    [0.08, candidate.semantics.density === entry.density],
    [0.08, candidate.semantics.commercial === entry.commercial],
    [0.08, candidate.semantics.green === entry.green],
    [0.07, Boolean(anchor?.kind && anchor.kind === entry.anchorKind)],
    [0.06, candidate.terrainWaterfrontAdaptations.join("|") === entry.adaptationTags.join("|")],
  ];
  return dimensions.reduce((score, [weight, matches]) => score + (matches ? weight : 0), 0);
}

export function scoreUrbanDesignNovelty(input: {
  memory: UrbanDesignNoveltyMemory;
  proposal: UrbanDesignProposal;
  anchor?: Pick<UrbanPlanningAnchor, "kind">;
}): UrbanDesignNoveltyScore {
  const memory = assertMemory(input.memory);
  if (memory.entries.length === 0) return { repetitionScore: 0, noveltyScore: 1, noveltyHints: [], recentMatches: [] };
  const scored = memory.entries
    .map((entry) => ({ entry, score: similarity(input.proposal, entry, input.anchor) }))
    .sort((left, right) => right.score - left.score || right.entry.orderIndex - left.entry.orderIndex);
  const best = scored[0].score;
  const strongMatches = scored.filter((item) => item.score >= 0.7).length;
  const repetitionScore = Math.min(
    1,
    Math.round((best + Math.min(0.2, Math.max(0, strongMatches - 1) * 0.05)) * 1_000) / 1_000,
  );
  const hints = [
    ...(repetitionScore >= 0.7
      ? [
          "This proposal closely repeats a recent design; consider a different motif or density if player intent permits.",
        ]
      : []),
    ...(input.proposal.grammar.primary === scored[0].entry.primaryStyle
      ? ["The primary style was used recently; preserve identity but vary a bounded dimension when appropriate."]
      : []),
  ].slice(0, 6);
  return {
    repetitionScore,
    noveltyScore: Math.round((1 - repetitionScore) * 1_000) / 1_000,
    noveltyHints: hints,
    recentMatches: scored.slice(0, URBAN_DESIGN_NOVELTY_MAX_MATCHES).map(({ entry }) => entry.proposalId),
  };
}
