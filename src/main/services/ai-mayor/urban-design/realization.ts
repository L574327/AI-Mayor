import { z } from "zod";
import {
  buildMayorCandidateSet,
  type MayorCandidateSet,
  type PrivateMayorCandidate,
  type RoadExpansionAttemptDiagnostic,
  type RoadExpansionPreferences,
  type RoadExpansionSource,
  type UrbanDesignCandidateMetadataInput,
  type UrbanDesignCandidatePolicy,
} from "../action-candidates";
import type { SpatialEntityRef, SpatialSiteDetail, SpatialTile } from "../spatial/types";
import type { MayorPlanningCandidate, UrbanDesignDevelopmentPolicy } from "../types";
import { type UrbanDesignProposal, UrbanDesignProposalSchema } from "./proposal";
import { PlanningAnchorSchema, type UrbanPlanningAnchor, type UrbanSiteContext } from "./site-context";

export const URBAN_DESIGN_MAX_REALIZED_ROAD_CANDIDATES = 3;
export const URBAN_DESIGN_MAX_REALIZED_ZONING_CANDIDATES = 6;
export const URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES = 8;
export const URBAN_DESIGN_MAX_GEOMETRY_ATTEMPTS = 12;
export const URBAN_DESIGN_MAX_PREVIEW_ATTEMPTS = 8;
export const URBAN_DESIGN_MAX_ROAD_DIAGNOSTICS = 72;

const boundedText = z.string().trim().min(1).max(160);

export const UrbanDesignPlanningEnvelopeSchema = z
  .object({
    version: z.literal(1),
    proposalId: boundedText,
    anchorId: boundedText,
    anchorOrientation: z.enum([
      "north_south",
      "northeast_southwest",
      "east_west",
      "southeast_northwest",
      "mixed",
      "unknown",
    ]),
    allowedHeadings: z.array(z.string().max(32)).min(1).max(3),
    preferredHeading: z.string().max(32),
    approximateScale: z.enum(["small", "medium", "large"]),
    topology: z.enum(["grid", "organic", "linear", "filtered", "node"]),
    curvature: z.enum(["orthogonal", "low", "moderate", "high", "shoreline_adapted"]),
    roadHierarchy: z.enum(["local_first", "balanced", "collector_spine", "fine_grain"]),
    density: z.enum(["low", "medium", "high", "gradient"]),
    frontageTarget: z.enum(["none", "small", "medium", "large"]),
    adaptationHints: z.array(boundedText).max(8),
  })
  .strict();

export type UrbanDesignPlanningEnvelope = z.infer<typeof UrbanDesignPlanningEnvelopeSchema>;

export const UrbanDesignRealizationResultSchema = z
  .object({
    version: z.literal(1),
    proposalId: boundedText,
    status: z.enum(["realized", "no_realization"]),
    candidateIds: z.array(boundedText).max(URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES),
    candidateMetadata: z
      .array(
        z
          .object({
            candidateId: boundedText,
            designRole: z.enum(["primary_road", "branch", "frontage", "district_infill"]),
            realizationGroupId: boundedText,
          })
          .strict(),
      )
      .max(URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES),
    rejectedElements: z.array(boundedText).max(8),
    constraintReasons: z.array(boundedText).max(12),
    roadExpansionDiagnostics: z
      .array(
        z
          .object({
            sourceRoad: z.object({ index: z.number().int(), version: z.number().int() }).strict(),
            start: z.object({ x: z.number(), z: z.number() }).strict(),
            end: z.object({ x: z.number(), z: z.number() }).strict(),
            headingDegrees: z.number().nullable(),
            headingOffsetDegrees: z.number(),
            targetLength: z.number(),
            outcome: z.enum(["accepted", "rejected"]),
            rejectionReason: z
              .enum([
                "invalid_source_geometry",
                "outside_owned_land",
                "water",
                "slope",
                "building_collision",
                "duplicate_road",
              ])
              .optional(),
          })
          .strict(),
      )
      .max(URBAN_DESIGN_MAX_ROAD_DIAGNOSTICS)
      .optional(),
    envelope: UrbanDesignPlanningEnvelopeSchema,
  })
  .strict();

export type UrbanDesignRealizationResult = z.infer<typeof UrbanDesignRealizationResultSchema>;

export interface UrbanDesignRealizationInput {
  proposal: UrbanDesignProposal;
  context: UrbanSiteContext;
  anchor: UrbanPlanningAnchor;
  snapshot: unknown;
  detail: SpatialSiteDetail;
  ownedTiles: SpatialTile[];
  candidateGate?: (candidate: MayorPlanningCandidate) => boolean;
}

function unavailableCandidateSet(note: string, ownedTiles: SpatialTile[]): MayorCandidateSet {
  return { status: "unavailable", candidates: [], note, registry: new Map(), ownedTiles };
}

function scaleFor(proposal: UrbanDesignProposal): UrbanDesignPlanningEnvelope["approximateScale"] {
  if (proposal.semantics.blockScale === "small") return "small";
  if (proposal.semantics.blockScale === "medium_large" || proposal.semantics.blockScale === "mixed") return "large";
  return "medium";
}

function orientationDegrees(orientation: UrbanDesignPlanningEnvelope["anchorOrientation"]): number {
  switch (orientation) {
    case "north_south":
      return 90;
    case "northeast_southwest":
      return 45;
    case "southeast_northwest":
      return -45;
    case "east_west":
      return 0;
    default:
      return 0;
  }
}

function boundedSample(proposal: UrbanDesignProposal, key: string, fallback: number): number {
  const value = proposal.parameterSample[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(32, Math.min(220, value)) : fallback;
}

function buildUrbanDesignCandidatePolicy(
  proposal: UrbanDesignProposal,
  envelope: UrbanDesignPlanningEnvelope,
): UrbanDesignCandidatePolicy | undefined {
  const developmentPolicy = proposal.developmentPolicy as UrbanDesignDevelopmentPolicy | undefined;
  if (!developmentPolicy) return undefined;
  const primary = proposal.grammar.primary;
  const isOrthogonal = primary === "orthogonal-grid";
  const roadExpansion: RoadExpansionPreferences = isOrthogonal
    ? {
        seed: proposal.variationSeed ?? proposal.proposalId,
        preferredHeadingDegrees: orientationDegrees(envelope.anchorOrientation),
        headingOffsetsDegrees: [0, 90, -90],
        headingToleranceDegrees: 8,
        targetLengths: [boundedSample(proposal, "blockDepth", 80)],
        topologyPreference: envelope.topology === "filtered" ? "cross_link" : "grid_axis",
        hierarchyPreference: envelope.roadHierarchy,
      }
    : {
        seed: proposal.variationSeed ?? proposal.proposalId,
        preferredHeadingDegrees: orientationDegrees(envelope.anchorOrientation),
        headingOffsetsDegrees: [0, 15, -15, 30, -30],
        headingToleranceDegrees: 45,
        targetLengths: [boundedSample(proposal, "branchCadence", 96)],
        topologyPreference: "contour_connector",
        hierarchyPreference: envelope.roadHierarchy,
      };
  return {
    developmentPolicy,
    includeExistingFrontage: developmentPolicy !== "expand_first",
    roadExpansion,
  };
}

export function buildUrbanDesignPlanningEnvelope(
  proposalInput: UrbanDesignProposal,
  anchorInput: UrbanPlanningAnchor,
): UrbanDesignPlanningEnvelope {
  const proposal = UrbanDesignProposalSchema.parse(proposalInput);
  const anchor = PlanningAnchorSchema.parse(anchorInput);
  const preferredHeading = anchor.orientation;
  const allowedHeadings =
    preferredHeading === "unknown" || preferredHeading === "mixed" ? ["mixed"] : [preferredHeading];
  return UrbanDesignPlanningEnvelopeSchema.parse({
    version: 1,
    proposalId: proposal.proposalId,
    anchorId: anchor.id,
    anchorOrientation: anchor.orientation,
    allowedHeadings,
    preferredHeading,
    approximateScale: scaleFor(proposal),
    topology: proposal.semantics.topology,
    curvature: proposal.semantics.curvature,
    roadHierarchy: proposal.semantics.roadHierarchy,
    density: proposal.semantics.density,
    frontageTarget: proposal.estimatedCapacity.band,
    adaptationHints: proposal.terrainWaterfrontAdaptations.slice(0, 8),
  });
}

function sameEntity(left: { index?: number; version?: number }, right: { index?: number; version?: number }): boolean {
  return (
    typeof left.index === "number" &&
    typeof left.version === "number" &&
    typeof right.index === "number" &&
    typeof right.version === "number" &&
    left.index === right.index &&
    left.version === right.version
  );
}

function entityKey(entity: { index: number; version: number }): string {
  return `${entity.index}:${entity.version}`;
}

function candidateMatchesAnchor(
  candidate: PrivateMayorCandidate,
  resolvedSources: readonly RoadExpansionSource[],
): boolean {
  const summary = candidate.summary;
  return resolvedSources.some((source) => {
    if (summary.sourceRoad && sameEntity(summary.sourceRoad, source.entity)) return true;
    return sameEntity(summary.adjacentRoad.entity, source.entity);
  });
}

interface CatalogRoadAnchor {
  entity: SpatialEntityRef;
  start: { x: number; z: number };
  end: { x: number; z: number };
}

function catalogRoadAnchors(snapshot: unknown): CatalogRoadAnchor[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const planningCatalog = (snapshot as { planningCatalog?: unknown }).planningCatalog;
  if (!planningCatalog || typeof planningCatalog !== "object" || Array.isArray(planningCatalog)) return [];
  const values = (planningCatalog as { roadAnchors?: unknown }).roadAnchors;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const entity = item.entity as Record<string, unknown> | undefined;
    const start = item.start as Record<string, unknown> | undefined;
    const end = item.end as Record<string, unknown> | undefined;
    if (
      !entity ||
      !start ||
      !end ||
      typeof entity.index !== "number" ||
      typeof entity.version !== "number" ||
      typeof start.x !== "number" ||
      typeof start.z !== "number" ||
      typeof end.x !== "number" ||
      typeof end.z !== "number"
    )
      return [];
    return [
      {
        entity: { index: entity.index, version: entity.version },
        start: { x: start.x, z: start.z },
        end: { x: end.x, z: end.z },
      },
    ];
  });
}

export type UrbanPlanningAnchorResolution =
  | {
      status: "resolved";
      sourceType: "road_anchor" | "incident_road_edge" | "canonical_road_relation";
      source: RoadExpansionSource;
      sources?: RoadExpansionSource[];
    }
  | { status: "unresolved"; reason: "anchor_source_missing" | "anchor_source_has_no_catalog_road" };

/** Resolve the semantic anchor to the real road source used by the existing planner. */
export function resolveUrbanPlanningAnchor(input: {
  anchor: UrbanPlanningAnchor;
  snapshot: unknown;
  detail: SpatialSiteDetail;
}): UrbanPlanningAnchorResolution {
  const catalog = catalogRoadAnchors(input.snapshot);
  const catalogByEntity = new Map(catalog.map((road) => [entityKey(road.entity), road]));
  const canonical = input.anchor.canonicalSource;
  if (canonical) {
    const relations =
      input.anchor.kind === "gateway" && canonical.preferredRoad ? [canonical.preferredRoad] : canonical.incidentRoads;
    const sources = relations.flatMap((relation) => {
      const road = catalogByEntity.get(entityKey(relation.edge));
      if (!road) return [];
      return [
        {
          entity: road.entity,
          endpoint: relation.endpointRole === "start" ? road.start : road.end,
        },
      ];
    });
    if (sources.length === 0) return { status: "unresolved", reason: "anchor_source_has_no_catalog_road" };
    if (input.anchor.kind !== "central_node" && sources.length !== 1) {
      return { status: "unresolved", reason: "anchor_source_has_no_catalog_road" };
    }
    return {
      status: "resolved",
      sourceType: "canonical_road_relation",
      source: sources[0],
      ...(sources.length > 1 ? { sources } : {}),
    };
  }
  const direct = catalog.find((road) => sameEntity(road.entity, input.anchor.sourceEntity));
  if (direct) return { status: "resolved", sourceType: "road_anchor", source: { entity: direct.entity } };

  const incidentEdges = input.detail.roadGraph.edges
    .filter(
      (edge) =>
        edge.native &&
        (sameEntity(edge.startNode, input.anchor.sourceEntity) || sameEntity(edge.endNode, input.anchor.sourceEntity)),
    )
    .sort((left, right) => left.entity.index - right.entity.index || left.entity.version - right.entity.version);
  if (incidentEdges.length === 0) return { status: "unresolved", reason: "anchor_source_missing" };
  const edge = incidentEdges[0];
  const road = catalog.find((candidate) => sameEntity(candidate.entity, edge.entity));
  if (!road) return { status: "unresolved", reason: "anchor_source_has_no_catalog_road" };
  const node = sameEntity(edge.startNode, input.anchor.sourceEntity) ? edge.start : edge.end;
  const startDistance = Math.hypot(node.x - road.start.x, node.z - road.start.z);
  const endDistance = Math.hypot(node.x - road.end.x, node.z - road.end.z);
  if (Math.min(startDistance, endDistance) > 8) {
    return { status: "unresolved", reason: "anchor_source_has_no_catalog_road" };
  }
  return {
    status: "resolved",
    sourceType: "incident_road_edge",
    source: { entity: road.entity, endpoint: startDistance <= endDistance ? road.start : road.end },
  };
}

function scoreCandidate(candidate: PrivateMayorCandidate, proposal: UrbanDesignProposal): number {
  const summary = candidate.summary;
  let score = 0;
  if (proposal.semantics.commercial === "none" && summary.areaType === "Residential") score += 4;
  if (proposal.semantics.commercial !== "none" && summary.areaType === "Commercial") score += 4;
  if (proposal.semantics.density === "high") score += summary.approximateCells ?? 0;
  if (proposal.semantics.density === "low") score -= summary.approximateCells ?? 0;
  if (candidate.action.type === "build_road") score += proposal.semantics.roadHierarchy === "collector_spine" ? 3 : 1;
  return score;
}

function noRealization(
  proposal: UrbanDesignProposal,
  envelope: UrbanDesignPlanningEnvelope,
  constraintReasons: string[],
  rejectedElements: string[] = [],
  roadExpansionDiagnostics: readonly RoadExpansionAttemptDiagnostic[] = [],
): UrbanDesignRealizationResult {
  return UrbanDesignRealizationResultSchema.parse({
    version: 1,
    proposalId: proposal.proposalId,
    status: "no_realization",
    candidateIds: [],
    candidateMetadata: [],
    rejectedElements: rejectedElements.slice(0, 8),
    constraintReasons: constraintReasons.slice(0, 12),
    ...(roadExpansionDiagnostics.length > 0
      ? { roadExpansionDiagnostics: roadExpansionDiagnostics.slice(0, URBAN_DESIGN_MAX_ROAD_DIAGNOSTICS) }
      : {}),
    envelope,
  });
}

export function realizeUrbanDesignProposal(input: UrbanDesignRealizationInput): {
  result: UrbanDesignRealizationResult;
  candidateSet: MayorCandidateSet;
} {
  const proposal = UrbanDesignProposalSchema.parse(input.proposal);
  const anchor = PlanningAnchorSchema.parse(input.anchor);
  const envelope = buildUrbanDesignPlanningEnvelope(proposal, anchor);
  const urbanDesignPolicy = buildUrbanDesignCandidatePolicy(proposal, envelope);
  if (input.ownedTiles.length === 0) {
    return {
      result: noRealization(proposal, envelope, ["no_owned_buildable_land"]),
      candidateSet: unavailableCandidateSet(
        "No owned buildable land is available for UDL realization.",
        input.ownedTiles,
      ),
    };
  }
  const emptyCandidateSet = buildMayorCandidateSet({
    snapshot: input.snapshot,
    detail: input.detail,
    ownedTiles: input.ownedTiles,
  });
  if (
    proposal.grammar.primary === "waterfront-linear" &&
    (!input.context.water.opportunity || !anchor.waterfrontEligible)
  ) {
    return {
      result: noRealization(proposal, envelope, ["verified_waterfront_required"], ["waterfront"]),
      candidateSet: emptyCandidateSet,
    };
  }
  const metadata: UrbanDesignCandidateMetadataInput = {
    metadata: {
      designProposalId: proposal.proposalId,
      primaryStyle: proposal.grammar.primary,
      ...(proposal.grammar.secondary ? { secondaryInfluence: proposal.grammar.secondary } : {}),
      motif: proposal.motif,
      anchorId: anchor.id,
      realizationGroupId: `udl-${proposal.proposalId}`,
    },
  };
  const anchorResolution = resolveUrbanPlanningAnchor({ anchor, snapshot: input.snapshot, detail: input.detail });
  if (anchorResolution.status === "unresolved") {
    return {
      result: noRealization(proposal, envelope, [anchorResolution.reason]),
      candidateSet: emptyCandidateSet,
    };
  }
  const resolvedSource = anchorResolution.source;
  const resolvedSources = anchorResolution.sources ?? [resolvedSource];
  const roadExpansionDiagnostics: RoadExpansionAttemptDiagnostic[] = [];
  const candidateSet = buildMayorCandidateSet({
    snapshot: input.snapshot,
    detail: input.detail,
    ownedTiles: input.ownedTiles,
    urbanDesign: metadata,
    urbanDesignPolicy,
  });
  const rejectedElements: string[] = [];
  const candidates = [...candidateSet.registry.values()]
    .filter((candidate) => candidateMatchesAnchor(candidate, resolvedSources))
    .filter((candidate) => {
      const accepted = input.candidateGate?.(candidate.summary) ?? true;
      if (!accepted) rejectedElements.push(candidate.summary.id);
      return accepted;
    })
    .sort(
      (left, right) =>
        scoreCandidate(right, proposal) - scoreCandidate(left, proposal) ||
        left.summary.id.localeCompare(right.summary.id),
    );
  const roads = candidates
    .filter((candidate) => candidate.action.type === "build_road")
    .slice(0, URBAN_DESIGN_MAX_REALIZED_ROAD_CANDIDATES);
  const zoning = candidates
    .filter((candidate) => candidate.action.type === "zone")
    .slice(0, URBAN_DESIGN_MAX_REALIZED_ZONING_CANDIDATES);
  let selected = [...roads, ...zoning].slice(0, URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES);
  let selectedCandidateSet = candidateSet;
  if (selected.length === 0) {
    const fallbackSets = resolvedSources.slice(0, 4).map((source) =>
      buildMayorCandidateSet({
        snapshot: input.snapshot,
        detail: input.detail,
        ownedTiles: input.ownedTiles,
        urbanDesign: metadata,
        urbanDesignPolicy,
        forceRoadExpansion: true,
        roadExpansionSource: source,
        roadExpansionDiagnostics,
      }),
    );
    const mergedRegistry = new Map<string, PrivateMayorCandidate>();
    for (const fallback of fallbackSets) {
      for (const [candidateId, candidate] of fallback.registry) {
        if (mergedRegistry.size >= URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES) break;
        mergedRegistry.set(candidateId, candidate);
      }
      if (mergedRegistry.size >= URBAN_DESIGN_MAX_REALIZED_TOTAL_CANDIDATES) break;
    }
    selectedCandidateSet = {
      ...(fallbackSets[0] ?? candidateSet),
      candidates: [...mergedRegistry.values()].map((candidate) => candidate.summary),
      registry: mergedRegistry,
    };
    selected = [...selectedCandidateSet.registry.values()]
      .filter((candidate) => {
        const accepted = input.candidateGate?.(candidate.summary) ?? true;
        if (!accepted) rejectedElements.push(candidate.summary.id);
        return accepted;
      })
      .sort(
        (left, right) =>
          scoreCandidate(right, proposal) - scoreCandidate(left, proposal) ||
          left.summary.id.localeCompare(right.summary.id),
      )
      .filter((candidate) => candidate.action.type === "build_road")
      .slice(0, URBAN_DESIGN_MAX_REALIZED_ROAD_CANDIDATES);
  }
  if (selected.length === 0) {
    const expansionAttempted =
      urbanDesignPolicy?.developmentPolicy === "expand_first" || urbanDesignPolicy?.developmentPolicy === "mixed";
    return {
      result: noRealization(
        proposal,
        envelope,
        [expansionAttempted ? "no_valid_road_candidate" : "no_existing_validated_candidate_matches_anchor"],
        rejectedElements,
        roadExpansionDiagnostics,
      ),
      candidateSet: selectedCandidateSet,
    };
  }
  return {
    result: UrbanDesignRealizationResultSchema.parse({
      version: 1,
      proposalId: proposal.proposalId,
      status: "realized",
      candidateIds: selected.map((candidate) => candidate.summary.id),
      candidateMetadata: selected.map((candidate) => ({
        candidateId: candidate.summary.id,
        designRole: candidate.action.type === "build_road" ? "primary_road" : "district_infill",
        realizationGroupId: metadata.metadata.realizationGroupId,
      })),
      rejectedElements,
      constraintReasons: [],
      ...(roadExpansionDiagnostics.length > 0
        ? { roadExpansionDiagnostics: roadExpansionDiagnostics.slice(0, URBAN_DESIGN_MAX_ROAD_DIAGNOSTICS) }
        : {}),
      envelope,
    }),
    candidateSet: selectedCandidateSet,
  };
}
