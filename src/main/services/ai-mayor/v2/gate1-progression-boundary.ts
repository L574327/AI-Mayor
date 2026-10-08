import type {
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialRoadNode,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "../spatial/types";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../spatial/world-scanner";
import { withoutOrphanComponents } from "./road-components";
import { buildMayorCandidateSet } from "../action-candidates";
import { GROWABLE_ZONE_CATEGORY_FOR_LAND_USE, growableLandUseOf, type GrowableZoneCategory } from "../growth-mode";
import { ROAD_NATIVE_COLLINEAR_FOLD_DEGREES, routeFirstLegDuplicatesCorridor } from "../spatial/utility-planner";
import { stableRoadInput } from "./finance";
import type { V2CommandRecord } from "./foundation";
import {
  createGate1FoundationBoundary,
  Gate1BoundedRoadSiteDeadEndError,
  Gate1BoundedZoningDeadEndError,
  type Gate1AdmittedProposal,
  type Gate1FoundationProposalResolvers,
  type Gate1RoadPreflightResult,
  type Gate1SkillProposal,
  type Gate1WorldBoundary,
} from "./gate1";
import type { V2FoundationPorts } from "./main-adapter";
import { goalWorkOrderRoadSearchTarget, isStandaloneRoadGoalAdmission, latestObservedRoadTerminal, V2_PROJECT_ADMISSION_POLICY } from "./project-admission";
import type { RoadCandidate } from "./road-connection-resolver";
import { buildRoadGridCandidates } from "./road-grid-generator";
import type { RoadEndpointAttachment, RoadExecutionRequest, RoadGeometryInput } from "./road-kernel";
import { planRoadCourseSweep, roadCourseSweepGeometry } from "./road-course-sweep";
import { MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS, MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS } from "./road-contract";
import {
  classifyNativeRoadPreviewFailure,
  previewProductiveStarterRoad,
  RoadQuoteContractError,
} from "./runtime-road-caller";
import { rawRoadCandidatePreviewVerdict, RoadCandidatePreviewUnknownError, selectFeasibleRoadCandidate } from "./road-candidate-feasibility";
import { boundedZoningCellSetInNativeMarquee, buildableRoadEdge, searchBoundedStarterSites, selectAvailableStarterRoadPrefab, selectGoalWorkOrderSiteAnchors } from "./site-selection";
import {
  type AuthorizedMutationScope,
  type AuthorizedZoningCell,
  type ZoningIntent,
} from "./foundation";
import { ZONING_LAYOUT_SKILL } from "./autonomous-brain";

/** Two targets produced by the same deterministic formula agree exactly; this bound only absorbs serialization noise. */
const SITE_TARGET_MATCH_TOLERANCE_METERS = 0.01;

export interface V2Gate1ProgressionBoundaryOptions {
  foundation: Pick<V2FoundationPorts, "road" | "zoning" | "observation" | "durability">;
  /** Activated authoritative world the proposals are bound to. */
  world: { worldEpochId: string; generation: string };
  /** Bounded native ROAD preflight used to prove a productive starter road before submission. */
  previewRoad(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  roadAccessConnected?(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<boolean>;
  /** Authoritative unlocked road prefabs, read from the same source project admission used. */
  readAvailableRoadPrefabs(signal?: AbortSignal): Promise<readonly string[]>;
  /** Native residential zone prefab name from the current planning catalog. */
  readResidentialZone(signal?: AbortSignal): Promise<string>;
  /**
   * Native zone prefab name for this Goal's own zone category.
   *
   * Every category the product can plan for, office included. It used to name
   * only R/C/I, which is how an office scope came to be answered with an
   * industrial prefab: a surface narrower than the product's own land uses is
   * the substitution, whoever performs it.
   */
  readZoneCategory?(zone: GrowableZoneCategory, signal?: AbortSignal): Promise<string>;
}

/** Same bounded discovery sweep the project admission bootstrap uses. */
const MAXIMUM_STARTER_ANCHORS = 48;

const distance = (left: SpatialPoint2, right: SpatialPoint2) => Math.hypot(left.x - right.x, left.z - right.z);

/**
 * Production Gate 1 world boundary.
 *
 * The persisted Gate 1 state keeps only `tranche.target` — no site-candidate id
 * and no source anchor. `evaluateBoundedStarterSites` is deterministic, so the
 * road resolver replays the same bounded evaluation the admission ran and
 * matches the persisted target instead of inventing geometry. An unmatched or
 * ambiguous target fails closed.
 *
 * The replay goes through `searchBoundedStarterSites`, not a single anchor class,
 * because the admission escalated: local frontage first, the owned ingress seed
 * only when no local candidate satisfied the project. Replaying the target as
 * that search's acceptance test reproduces the same escalation, so a target only
 * the ingress seed could produce is still found.
 *
 * ROAD and ZONING both resolve through their existing durable native kernels.
 * No one-shot recovery resolver is supplied.
 */
/**
 * The road course a serialized Road input describes, as comparable geometry.
 *
 * Compared by geometry rather than by serialized text: a recorded `exactInput`
 * is the canonicalised, endpoint-annotated form while a freshly built candidate
 * carries the raw one, and the question — "has this exact road already been
 * shown not to exist" — is about the road, not about how it was spelled.
 */
export const roadCourseKey = (serialized: string): string | null => {
  try {
    const value = JSON.parse(serialized) as
      { prefab?: unknown; x1?: unknown; z1?: unknown; x2?: unknown; z2?: unknown };
    const coordinates = [value.x1, value.z1, value.x2, value.z2].map(Number);
    if (typeof value.prefab !== "string" || !coordinates.every((coordinate) => Number.isFinite(coordinate))) {
      return null;
    }
    return [value.prefab, ...coordinates.map((coordinate) => coordinate.toFixed(3))].join("|");
  } catch {
    return null;
  }
};

/**
 * The road courses this branch has already offered and had read back absent.
 *
 * `foundation.ts` states the rule for one command: when a readback proves the
 * effect did not occur, the next attempt is a NEW command and never a resend. A
 * new command over the SAME course is not a new attempt either — the world has
 * already answered that exact road, and every further offer of it reproduces the
 * answer (or, inside one frame, the Road kernel's own
 * `authorization_already_consumed`) while costing a durable FAILED command.
 *
 * Measured live (2026-09-30): one real `OBSERVED_MISMATCH` followed by sixteen
 * `FAILED_BEFORE_SUBMIT` commands of one unchanged 33.9 m course, across nine
 * successive Goal work orders, none of which ever reached the game.
 */
export const provenAbsentRoadCourses = (commands: readonly { record: V2CommandRecord }[]): Set<string> => {
  const absent = new Set<string>();
  for (const { record } of commands) {
    if (record.actionFamily !== "ROAD" || record.effectAbsenceProven !== true) continue;
    const scope = record.authorizedScope;
    if (scope.actionFamily !== "ROAD" || typeof scope.exactInput !== "string") continue;
    const key = roadCourseKey(scope.exactInput);
    if (key) absent.add(key);
  }
  return absent;
};

/**
 * The growth Goals whose Road step is "give this land access", not "build a road".
 *
 * A standalone Road Goal is asked for a course and a utility prerequisite is
 * asked for a planned corridor hop — both have a place to reach. An expansion
 * Goal asks for the opposite: land it has already reserved, and if that land is
 * already on the network nothing is owed.
 */
const EXPANSION_GOAL_PREFIX = /^EXPAND_(?:RESIDENTIAL|COMMERCIAL|INDUSTRIAL)\b/;

/**
 * A Goal whose Road step is answered by "this land is already served".
 *
 * True for an expansion Goal that has already reserved its land: the admission
 * that admitted it proved a Growable footprint exists there, and a Road step
 * into land that already carries a road is a rebuild of that road, which native
 * folds back rather than certifying.
 *
 * NOT true for a `ROAD_FRONTAGE` prerequisite, whose entire purpose is that no
 * productive frontage exists yet. A road passing through satisfies ACCESS;
 * frontage is a different fact about Zone Block cells, and treating the first as
 * the second is a fake completion. Measured live (2026-09-30): twenty
 * `ROAD_FRONTAGE` children completed `ROAD_ALREADY_CONNECTED` one after another
 * at one unchanged target, each counting as a delivered step so the parent minted
 * the next one — sixteen of them inside a single tick — while the parent's own
 * census still found no footprint.
 */
const roadStepIsAlreadyServed = (goalId: string | undefined): boolean =>
  !!goalId && EXPANSION_GOAL_PREFIX.test(goalId) && !goalId.includes(":prerequisite:ROAD_FRONTAGE:");

/** Whether an existing road the project could build on passes through this circle. */
const existingRoadInsideCircle = (
  world: SpatialWorldModel,
  availableRoadPrefabs: readonly string[] | undefined,
  center: SpatialPoint2,
  radius: number,
): SpatialRoadEdge | null => {
  for (const edge of world.roadGraph.edges) {
    if (edge.deleted || edge.temp || !buildableRoadEdge(edge, availableRoadPrefabs)) continue;
    const dx = edge.end.x - edge.start.x;
    const dz = edge.end.z - edge.start.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.min(512, Math.ceil(length / 2)));
    for (let index = 0; index <= steps; index += 1) {
      const ratio = index / steps;
      if (Math.hypot(edge.start.x + dx * ratio - center.x, edge.start.z + dz * ratio - center.z) <= radius) {
        return edge;
      }
    }
  }
  return null;
};

/** A course is only ever built on the project's own ground, sampled along its whole length. */
const pointOnOwnedLand = (ownedTiles: SpatialWorldModel["ownedTiles"], point: SpatialPoint2): boolean =>
  ownedTiles.some((tile) => {
    const bounds = tile.bounds;
    return tile.owned && bounds !== null &&
      point.x >= bounds.min.x && point.x <= bounds.max.x &&
      point.z >= bounds.min.z && point.z <= bounds.max.z;
  });

/** The resolver's own bounded reach from a site to a source node. */
export const MAXIMUM_SWEEP_SOURCE_DISTANCE_METERS = 150;

/** The sources a sweep may leave from: the resolver's own eligible nodes, nearest the site first. */
const roadCourseSweepSources = (
  world: SpatialWorldModel,
  boundedCandidates: readonly RoadCandidate[],
  availableRoadPrefabs: readonly string[] | undefined,
  siteTarget: SpatialPoint2,
  maximumSources: number,
): Array<{ node: SpatialRoadNode; edge: SpatialRoadEdge; role: "start" | "end"; prefab: string }> => {
  const byNode = new Map<string, { node: SpatialRoadNode; edge: SpatialRoadEdge; role: "start" | "end"; prefab: string }>();
  // The resolver already decided which sources are authoritative and buildable,
  // including the prefab it would use. Reuse that decision rather than repeating
  // it, so the sweep cannot offer a course from a source the family it joins
  // would not have accepted.
  for (const candidate of boundedCandidates) {
    const key = `${candidate.sourceNode.entity.index}:${candidate.sourceNode.entity.version}`;
    if (byNode.has(key)) continue;
    byNode.set(key, {
      node: candidate.sourceNode,
      edge: candidate.sourceEdge,
      role: candidate.sourceRole,
      prefab: candidate.input.prefab,
    });
  }
  if (byNode.size === 0) {
    // The bounded family can be empty — every one of its reservation-boundary
    // contacts filtered out — and that is exactly a world where the sweep is the
    // only thing left. Fall back to the same eligibility rule the directed
    // corridor uses.
    const nodeByKey = new Map(world.roadGraph.nodes.map((node) => [`${node.entity.index}:${node.entity.version}`, node]));
    for (const edge of world.roadGraph.edges) {
      if (edge.deleted || edge.temp) continue;
      if (!edge.native && !availableRoadPrefabs?.includes(edge.prefab)) continue;
      for (const role of ["start", "end"] as const) {
        const ref = role === "start" ? edge.startNode : edge.endNode;
        const node = nodeByKey.get(`${ref.index}:${ref.version}`);
        if (!node || byNode.has(`${ref.index}:${ref.version}`)) continue;
        if (distance(node.position, siteTarget) > MAXIMUM_SWEEP_SOURCE_DISTANCE_METERS) continue;
        byNode.set(`${ref.index}:${ref.version}`, {
          node, edge, role,
          prefab: selectAvailableStarterRoadPrefab({ availableRoadPrefabs: availableRoadPrefabs ?? [], preferred: edge.prefab }),
        });
      }
    }
  }
  return [...byNode.values()]
    .map((source) => ({ source, distance: distance(source.node.position, siteTarget) }))
    .sort((left, right) =>
      left.distance - right.distance ||
      left.source.node.entity.index - right.source.node.entity.index ||
      left.source.role.localeCompare(right.source.role))
    .slice(0, maximumSources)
    .map((entry) => entry.source);
};

/**
 * How many source nodes a sweep family is built from.
 *
 * One, deliberately. The sweep's whole premise is that the certifiable course is
 * deep inside one node's family — measured live (2026-10-01), the only
 * certifiable course at `75948:215` sat at ordinal 16 of 24. Splitting the same
 * probe budget across several sources would put that course past the end of it
 * and find nothing, which is the failure this family exists to end.
 */
const MAXIMUM_SWEEP_SOURCES = 1;

/**
 * The measured heading × length family, as road candidates.
 *
 * The bounded resolver fans a 25° cone out from each source and lands every
 * course it offers on the reservation boundary. Native's certifiable set is
 * neither of those things: at `75948:215` one of twenty-four heading×length
 * courses from the node certified — 225° at 24 m — and at `52196:1`, ten of
 * twenty-four did. A cone anchored to the reservation boundary does not contain
 * those courses, which is why a live cycle reports
 * `NO_FEASIBLE_GATE1_ROAD_CANDIDATE` with road segments at zero cycle after
 * cycle.
 *
 * These candidates carry the same bound START endpoint as their sibling
 * families, are only ever built on owned ground, and are previewed by the same
 * selector. Nothing is loosened: this is one more bounded family, over the axis
 * the others do not search.
 */
const buildRoadCourseSweepCandidates = (input: {
  sources: ReturnType<typeof roadCourseSweepSources>;
  siteTarget: SpatialPoint2;
  worldEpoch: string;
  ownedTiles: SpatialWorldModel["ownedTiles"];
}): RoadCandidate[] => {
  const candidates: RoadCandidate[] = [];
  for (const source of input.sources) {
    const startEndpoint: RoadEndpointAttachment = {
      kind: "EXISTING_NET_NODE",
      role: "START",
      entity: source.node.entity,
      // The scan's own coordinate. Native validates this exactly, and an
      // arithmetic approximation fails with ROAD_ENDPOINT_POSITION_MISMATCH
      // before any road question is asked.
      expectedPosition: source.node.position,
      worldEpoch: input.worldEpoch,
    };
    // Absolute compass headings, deliberately NOT headings turned relative to
    // the site. Which headings a node certifies is a property of the ROAD GRID,
    // not of where the site happens to be: measured live 2026-10-01, every
    // certifiable course found at `75948:215` and `52196:1` sat on a multiple of
    // 45° (225°; 90°/135°/225°/270°/315°). Anchoring the eight offsets to the
    // site bearing rotates the whole family off that grid — measured live at the
    // same node, a site-anchored sweep refused all twenty-four of its courses
    // while the same node certified 225° at 24 m — so the offsets are applied to
    // 0°, and the site's own direction is offered as the family's direct course.
    const plan = planRoadCourseSweep({ from: source.node.position, to: input.siteTarget, bearingDegrees: 0 });
    for (const course of plan.courses) {
      const samples = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
        x: source.node.position.x + (course.endpoint.x - source.node.position.x) * ratio,
        z: source.node.position.z + (course.endpoint.z - source.node.position.z) * ratio,
      }));
      if (samples.some((point) => !pointOnOwnedLand(input.ownedTiles, point))) continue;
      candidates.push({
        family: "FREE_CORRIDOR",
        gridReference: null,
        variant: "COURSE_SWEEP",
        sourceEdge: source.edge,
        sourceRole: source.role,
        sourceNode: source.node,
        sourceAnchor: { x: source.node.position.x, z: source.node.position.z },
        siteTarget: input.siteTarget,
        initialRoadContactTarget: course.endpoint,
        roadContactTarget: course.endpoint,
        contactDerivation: "COURSE_SWEEP_HEADING",
        initialSegmentLength: course.lengthMeters,
        finalSegmentLength: course.lengthMeters,
        lengthContract: {
          minMeters: MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
          maxMeters: MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
          pass: true,
        },
        adjustmentReason: "COURSE_SWEEP",
        incidentEdgeRefs: [source.edge.entity],
        sourceAnchorEvidence: {
          sourceEdgeRef: source.edge.entity,
          sourceEndpointRole: source.role,
          sourceNodeRef: source.node.entity,
          sourceNodePosition: { x: source.node.position.x, z: source.node.position.z },
          incidentEdgeRefs: [source.edge.entity],
          roadDegree: source.node.roadDegree,
          derivation: "AUTHORITATIVE_GRAPH_NODE",
        },
        geometryFilterResults: "PASS",
        input: roadCourseSweepGeometry({
          prefab: source.prefab,
          from: source.node.position,
          course,
          startEndpoint,
        }),
      });
    }
  }
  return candidates;
};

export function createV2Gate1ProgressionBoundary(options: V2Gate1ProgressionBoundaryOptions): Gate1WorldBoundary {
  const policy = V2_PROJECT_ADMISSION_POLICY;
  const preparedRoadRequests = new Map<string, RoadExecutionRequest>();
  const preparedKey = (proposal: Pick<Gate1SkillProposal, "taskId" | "attempt">) => `${proposal.taskId}:${proposal.attempt}`;

  const reproduceCandidate = async (
    proposal: Gate1SkillProposal,
    signal?: AbortSignal,
    /** Filled with the world this replay observed, so a caller can ask a question of it. */
    observed?: { world?: SpatialWorldModel; availableRoadPrefabs?: readonly string[]; shape?: string },
  ): Promise<RoadCandidate[]> => {
    const envelope = await options.foundation.observation.capture({
      spatialDetail: {
        x: proposal.target.center.x,
        z: proposal.target.center.z,
        radius: policy.siteObservationRadiusMeters,
        resolution: policy.siteObservationResolution,
      },
      ...(signal ? { signal } : {}),
    });
    const scanSource = envelope.sources.spatialScan;
    if (scanSource.status === "UNAVAILABLE" || scanSource.data === undefined) {
      throw new Error("GATE1_PROGRESSION_SPATIAL_SCAN_UNAVAILABLE");
    }
    // The same connected-network view the admission searched in (orphan stubs are not sources for new streets).
    const world = withoutOrphanComponents(buildSpatialWorldModel(parseSpatialBootstrapScan(scanSource.data)));

    const availableRoadPrefabs = await options.readAvailableRoadPrefabs(signal);
    if (observed) {
      observed.world = world;
      observed.availableRoadPrefabs = availableRoadPrefabs;
    }
    const durability = options.foundation.durability;
    const durableSnapshot = typeof durability.snapshot === "function"
      ? durability.snapshot() : null;
    const activeGoalWorkOrderId = durableSnapshot?.activeGoalWorkOrderId;
    const activeGoalWorkOrder = durableSnapshot?.goalWorkOrders?.find((item) =>
      item.workOrderId === activeGoalWorkOrderId && item.projectId === proposal.projectId);
    // Growable admission's fast path only selects an executable zoning
    // footprint with a positive roadside witness. Its candidate intentionally
    // has no Road course: the frontage is already there. Revalidate that fact
    // from the current world before attempting the generic Road-site replay,
    // which cannot reproduce a fast-path footprint as a Road candidate.
    if (roadStepIsAlreadyServed(activeGoalWorkOrder?.goalId) &&
      existingRoadInsideCircle(world, availableRoadPrefabs, proposal.target.center, proposal.target.radius)) {
      return [];
    }

    // The persisted target does not record which anchor class produced it, and
    // the admission that produced it escalated: local frontage first, the owned
    // ingress seed only when no local candidate satisfied the project. Replaying
    // one class directly would therefore be wrong — replaying local anchors alone
    // can never reproduce an ingress target, and replaying ingress alone would
    // let the fallback shadow local frontage.
    //
    // So the replay asks the SAME search the admission ran, with the persisted
    // target as the acceptance test in place of the project constraint. The
    // escalation then reproduces itself: a local target is found in the local
    // class, and an ingress target is found because the local class accepts
    // nothing and the search falls through, exactly as it did during admission.
    const detailByAnchor = new Map<string, SpatialSiteDetail>();
    // The replay must run the SAME search the admission ran. Its bias is the
    // admission's own search hint — the work order's `targetPoint`, present only
    // for a target-directed corridor step — and NEVER the reservation it is
    // accepted against.
    //
    // This has now been wrong in both directions. Biasing at the work order's
    // target while accepting the reservation searched one point and demanded a
    // candidate hundreds of metres away. Biasing at the reservation instead
    // looks consistent and is still wrong: a search biased at a point filters
    // every candidate that is not closer to it than its own anchor, so the
    // candidate set it produces is not the set the admission chose from. For a
    // Goal work order — which carries no `targetPoint` at all — that turned a
    // plain local-frontage search into a target-directed one, and the site the
    // admission had just selected could never be found again. Observed live: an
    // ELECTRICITY Goal re-admitted, selected a site, and then failed its Road
    // step with `CANDIDATE_COUNT:0` against anchors that were never the ones its
    // admission used.
    //
    // The acceptance test stays the reservation. Only the bias is the
    // admission's.
    const directedTarget = activeGoalWorkOrder
      ? goalWorkOrderRoadSearchTarget({ goalId: activeGoalWorkOrder.goalId,
        completionStage: activeGoalWorkOrder.completionStage, targetPoint: activeGoalWorkOrder.targetPoint,
        previousRoadTerminal: latestObservedRoadTerminal(durableSnapshot?.commands ?? [], options.world.worldEpochId),
        roadEdges: world.roadGraph.edges })
      : undefined;
    const replayProtections = typeof durability.isGoalWorkOrderReservationProtected === "function"
      ? (durableSnapshot?.goalWorkOrders ?? [])
        .filter((item) => durability.isGoalWorkOrderReservationProtected(item.workOrderId) &&
          item.goalId !== activeGoalWorkOrder?.goalId)
        .map((item) => ({ ref: item.reservationRef, scope: structuredClone(item.state.project.utilityReservation) }))
      : [];
    // One anchor, one detail. The search calls this once per anchor and reads
    // nothing but `spatialDetail` and `coherence` from it, so the snapshot and
    // the whole road-graph scan a full capture would take are declined: this
    // replay already built its `world` from the single scan it took up front,
    // and re-reading the graph once per anchor is bytes nobody reads. Live
    // 2026-10-02, that was 162 scans and 162 snapshots per blocked tick, all
    // discarded, 132 ms + 48 ms each.
    const captureDetail = async (anchor: { node: { position: { x: number; z: number } } }, captureSignal?: AbortSignal) => {
      const capture = await options.foundation.observation.capture({
        spatialDetail: {
          x: anchor.node.position.x,
          z: anchor.node.position.z,
          radius: policy.siteObservationRadiusMeters,
          resolution: policy.siteObservationResolution,
        },
        globalSources: [],
        ...(captureSignal ? { signal: captureSignal } : {}),
      });
      const detail = capture.sources.spatialDetail;
      if (capture.coherence === "UNKNOWN" || detail.status !== "AVAILABLE" || detail.data === undefined) {
        return { detail: null, coherence: capture.coherence };
      }
      detailByAnchor.set(`${anchor.node.position.x}:${anchor.node.position.z}`, detail.data);
      return { detail: detail.data, coherence: capture.coherence };
    };
    let search = await searchBoundedStarterSites({
      world,
      worldEpoch: options.world.worldEpochId,
      bridgeGeneration: options.world.generation,
      availableRoadPrefabs,
      ...(directedTarget ? { targetPoint: directedTarget } : {}),
      ...(directedTarget && activeGoalWorkOrder?.completionStage === "ROAD_DELIVERED"
        ? { allowGenericRoadFallback: true } : {}),
      // The replay runs the admission's own search: a standalone Road Goal's target is a grid reference there.
      ...(directedTarget && activeGoalWorkOrder && isStandaloneRoadGoalAdmission({
        goalId: activeGoalWorkOrder.goalId, completionStage: activeGoalWorkOrder.completionStage,
        targetPoint: activeGoalWorkOrder.targetPoint })
        ? { targetIsReferenceOnly: true } : {}),
      // Gate 1 persists the reservation center/radius, not the discrete search
      // offset that originally selected it. Recheck that exact owned scope while
      // replaying the same site and current geometry constraints.
      replayTarget: proposal.target,
      ...(activeGoalWorkOrder?.goalId?.startsWith("ESTABLISH_ROAD_NETWORK:") &&
        activeGoalWorkOrder.completionStage === "ROAD_DELIVERED" && !directedTarget
        ? { roadDelivery: true } : {}),
      ...(directedTarget ? {
        goalWorkOrderAnchors: selectGoalWorkOrderSiteAnchors(world, MAXIMUM_STARTER_ANCHORS,
          directedTarget, availableRoadPrefabs),
      } : {}),
      ...(activeGoalWorkOrder?.completionStage === "ROAD_DELIVERED" ? { includeIngressFallback: false } : {}),
      // The same land claims the admission had to respect. Without them the
      // replay evaluates a superset, and a candidate the admission never saw can
      // outrank the admitted one out of the top `maximumSiteCandidates`.
      protections: replayProtections,
      maxAnchors: MAXIMUM_STARTER_ANCHORS,
      maxCandidates: policy.maximumSiteCandidates,
      captureDetail,
      accepts: async (candidate) =>
        distance(candidate.target.center, proposal.target.center) <= SITE_TARGET_MATCH_TOLERANCE_METERS,
      ...(signal ? { signal } : {}),
    });
    let nearbyReplaySummary: Record<string, unknown> | null = null;

    // If the admitted search class no longer yields the persisted target, make
    // one bounded replay from current owned-road anchors nearest that same
    // reservation. This changes neither the reservation nor its authority; it
    // only supplies a nearby source course to the same candidate/preflight path.
    if (search.selection.candidates.length === 0 && !directedTarget && activeGoalWorkOrder?.completionStage !== "ROAD_DELIVERED") {
      const nearbyAnchors = selectGoalWorkOrderSiteAnchors(world, MAXIMUM_STARTER_ANCHORS,
        proposal.target.center, availableRoadPrefabs);
      if (nearbyAnchors.length > 0) {
        const nearbyReplay = await searchBoundedStarterSites({
          world,
          worldEpoch: options.world.worldEpochId,
          bridgeGeneration: options.world.generation,
          availableRoadPrefabs,
          replayTarget: proposal.target,
          goalWorkOrderAnchors: nearbyAnchors,
          includeIngressFallback: false,
          protections: replayProtections,
          maxAnchors: MAXIMUM_STARTER_ANCHORS,
          maxCandidates: 1,
          captureDetail,
          accepts: async (candidate) =>
            distance(candidate.target.center, proposal.target.center) <= SITE_TARGET_MATCH_TOLERANCE_METERS,
          ...(signal ? { signal } : {}),
        });
        nearbyReplaySummary = {
          anchorsSeen: nearbyReplay.local.anchors,
          observationsSeen: nearbyReplay.local.observations,
          evaluated: nearbyReplay.local.candidates,
          candidates: nearbyReplay.selection.candidates.length,
          rejections: nearbyReplay.selection.rejections,
        };
        if (nearbyReplay.selection.candidates.length > 0) search = nearbyReplay;
      }
    }

    // Both classes reported, whichever ran, so a world that no longer offers the
    // source anchor at all is still told apart from one that offers it but could
    // not be observed.
    //
    // The refusal carries WHICH clause failed and the counts behind it. Without
    // that, "the site could not be reproduced" is one message for a world with no
    // anchors, a world whose every anchor observed as UNKNOWN, and a world that
    // observed fine but produced a different candidate — three different
    // problems, and an operator cannot tell them apart from a durable journal
    // that says only the first.
    const anchorsSeen = search.local.anchors + (search.ingress?.anchors ?? 0);
    const observationsSeen = search.local.observations + (search.ingress?.observations ?? 0);
    const diagnostics = JSON.stringify({
      target: { x: proposal.target.center.x, z: proposal.target.center.z, radius: proposal.target.radius },
      anchorsSeen, observationsSeen,
      anchorClass: search.anchorClass, fallbackReason: search.fallbackReason,
      candidates: search.selection.candidates.length,
      evaluated: search.local.candidates + (search.ingress?.candidates ?? 0),
      rejections: search.selection.rejections,
      nearbyReplay: nearbyReplaySummary,
    });
    // A bounded failure to re-derive THIS tranche's own reserved site. Typed so
    // the Gate 1 boundary can end the task durably instead of letting an
    // exception leave a tranche the durable state cannot resolve.
    if (anchorsSeen === 0) {
      throw new Gate1BoundedRoadSiteDeadEndError(`GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED:NO_ANCHOR:${diagnostics}`);
    }
    if (observationsSeen === 0) {
      throw new Gate1BoundedRoadSiteDeadEndError(`GATE1_PROGRESSION_SITE_OBSERVATION_UNKNOWN:${diagnostics}`);
    }

    const matches = search.selection.candidates;
    if (matches.length !== 1) {
      throw new Gate1BoundedRoadSiteDeadEndError(
        `GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED:CANDIDATE_COUNT:${matches.length}:${diagnostics}`);
    }
    const site = matches[0];
    const detail = detailByAnchor.get(`${site.evidence.sourceAnchor.x}:${site.evidence.sourceAnchor.z}`);
    if (!detail) throw new Error("GATE1_PROGRESSION_SITE_DETAIL_NOT_REPRODUCED");
    // The course family is THE GRID.
    //
    // Everything that used to stand here — the bounded heading cone, the
    // measured heading x length sweep, and the generic endpoint fan — generated
    // courses by varying a HEADING off one endpoint. That is why a street could
    // come back visibly skewed: native certifies a sparse, node- and
    // length-dependent set (one failing node certified exactly one of twenty-four
    // probes), so a family that spends its budget on arbitrary bearings mostly
    // previews geometry the world refuses and leaves the accepted remainder
    // off-axis. The grid family anchors on the NODE and enumerates only world
    // axes, so no course it offers can be skewed; when one is refused, the
    // alternatives are the same node at another length and then the neighbouring
    // grid node — a translation along the grid, never a change of heading.
    const grid = buildRoadGridCandidates({
      siteTarget: site.target.center,
      sourceEdges: world.roadGraph.edges,
      sourceNodes: world.roadGraph.nodes,
      ...(availableRoadPrefabs ? { availableRoadPrefabs } : {}),
      ownedTiles: world.ownedTiles,
      terrain: detail.terrain,
      buildings: detail.buildings,
      // A target-directed corridor admission can intentionally have no starter
      // route candidate. Rebuilding its courses must then use an unlocked catalog
      // prefab rather than inheriting a possibly locked source road's prefab.
      prefab: site.roadCandidates[0]?.input.prefab ??
        selectAvailableStarterRoadPrefab({ availableRoadPrefabs }) ?? "Small Road",
      worldEpoch: options.world.worldEpochId,
      bridgeGeneration: options.world.generation,
      maxSourceDistance: 150,
    });
    // The site's own courses are what the replay's search just certified for it. The grid is re-derived from the
    // anchor's detail window, whose set of known buildings differs from one anchor to the next, so a recompute can
    // come back empty for a site that was legitimately admitted (measured live 2026-10-02: admittedCourses=1,
    // grid=0, every tick). An empty recompute falls back to the site's own courses.
    const gridCourses = grid.length > 0 ? grid : site.roadCandidates.map((candidate) => candidate as RoadCandidate);
    if (observed) {
      observed.shape = `site=(${site.target.center.x.toFixed(0)},${site.target.center.z.toFixed(0)}) ` +
        `anchor=(${site.evidence.sourceAnchor.x.toFixed(0)},${site.evidence.sourceAnchor.z.toFixed(0)}) ` +
        `buildings=${detail.buildings.length} admittedCourses=${site.roadCandidates.length} grid=${grid.length}`;
    }
    // P4 — the directed course itself, previewed as planned.
    //
    // Everything above this point GENERATES a course: the bounded heading family
    // offers short fixed-offset courses from a source node, and the generic
    // fallback offers 32/48/64 m stubs. Neither of them is the corridor that was
    // planned, so the plan never reached native validation — the Road step aimed
    // at the target's BEARING and then invented its own geometry, which is how a
    // free heading kept turning back into the corridor it was standing on
    // (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, three candidates, one anchor).
    //
    // A directed prerequisite carries the compiled segment's far end. The course
    // from the nearest authoritative node to that point IS the segment, so it is
    // offered as a candidate in its own right, first, ahead of every generated
    // one. Lengths either side of it give native the same heading at a slightly
    // different reach, because certifiability is a function of both.
    const directed: RoadCandidate[] = [];
    const plannedCourse = activeGoalWorkOrder?.roadCourse ?? undefined;
    if (activeGoalWorkOrder?.targetPoint || plannedCourse) {
      // Where the source node is looked for.
      //
      // A work order that carries a planned course names BOTH ends of the
      // segment the planner compiled, and the node this course is bound to has
      // to be the one nearest its START. Resolving it from the far end instead
      // is how the planned segment stopped being the segment that got built: the
      // course then runs from whichever node happens to sit nearest the target,
      // which is a different line, a different heading and a different reach.
      //
      // Only a work order with no planned course — one raised before the course
      // was carried — still resolves from the far end.
      const target = plannedCourse ? { x: plannedCourse.end.x, z: plannedCourse.end.z } : activeGoalWorkOrder!.targetPoint!;
      const sourceAnchor = plannedCourse ? { x: plannedCourse.start.x, z: plannedCourse.start.z } : target;
      const nodeByKey = new Map(world.roadGraph.nodes.map((node) => [`${node.entity.index}:${node.entity.version}`, node]));
      let source: { node: typeof world.roadGraph.nodes[number]; edge: typeof world.roadGraph.edges[number]; role: "start" | "end" } | null = null;
      let nearest = Number.POSITIVE_INFINITY;
      for (const edge of world.roadGraph.edges) {
        if (edge.deleted || edge.temp) continue;
        if (!edge.native && !availableRoadPrefabs?.includes(edge.prefab)) continue;
        for (const role of ["start", "end"] as const) {
          const ref = role === "start" ? edge.startNode : edge.endNode;
          const node = nodeByKey.get(`${ref.index}:${ref.version}`);
          if (!node) continue;
          const heading = distance(node.position, sourceAnchor);
          if (heading < nearest) { nearest = heading; source = { node, edge, role }; }
        }
      }
      if (source) {
        const prefab = selectAvailableStarterRoadPrefab({ availableRoadPrefabs, preferred: source.edge.prefab });
        const start = source.node.position;
        const span = Math.hypot(target.x - start.x, target.z - start.z);
        // The corridor is only ever built on owned ground, and a course that
        // leaves the reservation is not this project's to build.
        if (span > 0) {
          // Once a segment is delivered the node nearest the target can already
          // BE the target, and a zero-length course is not a road — the native
          // boundary refuses anything outside its own 8-1500 m range, so the
          // family never offers one.
          for (const factor of [1, 0.75, 1.25]) {
            const length = span * factor;
            if (!(length >= 8 && length <= 1500)) continue;
            const end = { x: start.x + ((target.x - start.x) / span) * length,
              z: start.z + ((target.z - start.z) / span) * length };
            const input = { type: "build_road" as const, prefab, x1: start.x, z1: start.z, x2: end.x, z2: end.z };
            const samples = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
              x: input.x1 + (input.x2 - input.x1) * ratio,
              z: input.z1 + (input.z2 - input.z1) * ratio,
            }));
            if (samples.some((point) => !world.ownedTiles.some((tile) => {
              const bounds = tile.bounds;
              return tile.owned && bounds !== null && point.x >= bounds.min.x && point.x <= bounds.max.x &&
                point.z >= bounds.min.z && point.z <= bounds.max.z;
            }))) continue;
            // Judged by the fold cone native actually has, not by the bounded
            // family's twenty-five degree dedup cone. See
            // `ROAD_NATIVE_COLLINEAR_FOLD_DEGREES`: the planned hop of a
            // straight corridor is only a few degrees off the road each hop
            // continues, native certifies every one of them, and the wider cone
            // discarded all of them as duplicates — leaving the bounded heading
            // family to offer courses native folds back, which is the live
            // `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` stall.
            const corridor = source.role === "start"
              ? { x: source.edge.end.x - source.edge.start.x, z: source.edge.end.z - source.edge.start.z }
              : { x: source.edge.start.x - source.edge.end.x, z: source.edge.start.z - source.edge.end.z };
            if (routeFirstLegDuplicatesCorridor(
              [{ id: "directed", role: "side", start: { x: input.x1, z: input.z1 }, end: { x: input.x2, z: input.z2 } }],
              corridor,
              ROAD_NATIVE_COLLINEAR_FOLD_DEGREES,
            )) continue;
            directed.push({ input, sourceNode: source.node, sourceEdge: source.edge,
              sourceRole: source.role, variant: "DIRECTED_CORRIDOR" } as RoadCandidate);
          }
        }
      }
    }
    // The planned course is probed FIRST. Native's certifiable set is small and
    // the selector stops at the first accepted candidate, so ordering is what
    // decides whether the corridor that was planned is the one that gets built.
    // The grid family follows it.
    return [...directed, ...gridCourses];
  };

  const resolvers: Gate1FoundationProposalResolvers = {
    async preflightRoad(proposal, signal): Promise<Gate1RoadPreflightResult> {
      const observed: { world?: SpatialWorldModel; availableRoadPrefabs?: readonly string[]; shape?: string } = {};
      const reproduced: RoadCandidate[] = proposal.concreteChildOperation
        ? [{ input: structuredClone(proposal.concreteChildOperation.input) } as RoadCandidate]
        : await reproduceCandidate(proposal, signal, observed);
      // An expansion whose own reservation already carries existing road has the
      // access this task exists to provide, and no course short enough to stay
      // inside that reservation can be anything but a rebuild of a road already
      // there — which native folds back rather than certifying. Measured live
      // (2026-09-30): a 28 m expansion reservation with a degree-5 junction 8.1 m
      // from its centre, all 24 bounded courses the resolver offered refused, and
      // every one of the 12 headings of a local fan at 30 m refused too — while
      // the same grid certified freely at longer reaches. The Goal re-derived
      // itself every tick and the growth mainline never left it.
      const durableOrders = options.foundation.durability?.snapshot?.();
      const activeOrder = durableOrders?.goalWorkOrders?.find((item) =>
        item.workOrderId === durableOrders.activeGoalWorkOrderId && item.projectId === proposal.projectId);
      if (observed.world && roadStepIsAlreadyServed(activeOrder?.goalId)) {
        const serving = existingRoadInsideCircle(observed.world, observed.availableRoadPrefabs,
          proposal.target.center, proposal.target.radius);
        if (serving) {
          return {
            status: "ALREADY_CONNECTED",
            reason: `the reservation already carries existing ${serving.prefab} within its ` +
              `${proposal.target.radius.toFixed(0)}m radius; no course is owed`,
          };
        }
      }
      if (reproduced.length === 0) {
        throw new Error(`GATE1_PROGRESSION_NO_BOUNDED_OR_GENERIC_ROAD_CANDIDATE${observed.shape ? `:${observed.shape}` : ""}`);
      }
      // A course the world has already been shown not to contain is not a
      // candidate. Offering it again cannot produce a road the first offer did
      // not, and the attempt it costs is a durable FAILED command every time:
      // measured live (2026-09-30), one real `OBSERVED_MISMATCH` followed by
      // sixteen `FAILED_BEFORE_SUBMIT` commands of one unchanged 33.9 m course,
      // across nine successive Goal work orders, every one of them refused
      // before it reached the game at all.
      const absentCourses = provenAbsentRoadCourses(options.foundation.durability?.snapshot?.()?.commands ?? []);
      const candidates = absentCourses.size === 0 ? reproduced : reproduced.filter((candidate) => {
        const key = roadCourseKey(stableRoadInput(candidate.input));
        return key === null || !absentCourses.has(key);
      });
      if (candidates.length === 0) {
        return {
          status: "NO_FEASIBLE_CANDIDATE",
          reason: `NO_FEASIBLE_GATE1_ROAD_CANDIDATE: every bounded course for this site is one the world has ` +
            `already been shown not to contain (${reproduced.length} candidate(s), all proved absent)`,
        };
      }
      const preparedByCandidate = new Map<RoadCandidate, RoadExecutionRequest>();
      const selection = await selectFeasibleRoadCandidate({
        candidates,
        // The whole bounded family, not the first seven of it. Native's
        // certifiable set is a function of heading AND length, so the provider
        // builds alternatives across both axes — and a selector that stops
        // before reaching them makes every one of them wasted native work. The
        // bound is the caller's own family size, capped by the selector.
        maximumCandidates: candidates.length,
        candidateId: (candidate, index) =>
          `${candidate.sourceNode?.entity.index ?? "child"}:${candidate.sourceNode?.entity.version ?? index}:${candidate.sourceRole ?? "exact"}`,
        probe: async (candidate) => {
          const input = candidate.input;
          const length = Math.hypot(input.x2 - input.x1, input.z2 - input.z1);
          try {
            const productive = await previewProductiveStarterRoad({
              input,
              lengthsMeters: [length],
              diagnosticContext: {
                roadTaskId: proposal.taskId,
                roadChildId: proposal.concreteChildOperation?.amendmentId,
                atomicOperationId: proposal.concreteChildOperation?.amendmentId ?? proposal.taskId,
              },
              preview: async (roadInput, previewSignal) => {
                const raw = await options.previewRoad(roadInput, previewSignal);
                const verdict = rawRoadCandidatePreviewVerdict(raw);
                if (verdict.status === "INVALID") {
                  throw Object.assign(new Error(verdict.reason), { code: "ROAD_CANDIDATE_INVALID" });
                }
                if (verdict.status === "UNKNOWN") throw new RoadCandidatePreviewUnknownError(verdict.reason);
                return raw;
              },
              signal,
            });
            const quote = productive.quote;
            const fingerprint = stableRoadInput(productive.input);
            preparedByCandidate.set(candidate, {
              proposal: {
                identity: {
                  proposalId: quote.proposalId,
                  actionFamily: "ROAD",
                  exactInput: fingerprint,
                  runtimeEpoch: quote.runtimeEpoch,
                  frame: quote.frame,
                  validationState: "VALID",
                },
                quoteId: quote.quoteId,
                fingerprint,
                input: productive.input,
                owner: { ownerType: "TASK", ownerId: proposal.taskId },
              },
              quote,
              authorizedMaxSpend: Math.max(quote.signedAmount, 1) * 1.25,
              treasurySafetyReserve: 0,
              worldGeneration: options.world.generation,
            });
            return { status: "FEASIBLE" as const };
          } catch (error) {
            if ((error as { code?: unknown })?.code === "ROAD_CANDIDATE_INVALID" ||
              (error as { code?: unknown })?.code === "NO_PRODUCTIVE_ROAD_EFFECT" ||
              (error instanceof RoadQuoteContractError && error.diagnostics.actual.valid === false) ||
              classifyNativeRoadPreviewFailure(error) === "REJECTED") {
              return { status: "INVALID" as const, reason: error instanceof Error ? error.message : String(error) };
            }
            throw error;
          }
        },
      });
      if (selection.status !== "SELECTED") {
        return {
          status: "NO_FEASIBLE_CANDIDATE",
          // Which courses were offered and how many survived to the preview: "1 candidate" and "9 candidates,
          // all refused" are different findings (measured live: a replay offered one access course only).
          reason: `NO_FEASIBLE_GATE1_ROAD_CANDIDATE:${selection.rejections.map((item) => `${item.candidateId}:${item.reason}`).join("|")}` +
            `|offered=${reproduced.length}/${candidates.length}` +
            `|courses=${candidates.slice(0, 4).map((candidate) => `${(candidate as { family?: string }).family ?? "?"}:` +
              `${Math.hypot(candidate.input.x2 - candidate.input.x1, candidate.input.z2 - candidate.input.z1).toFixed(0)}m@` +
              `${(Math.atan2(candidate.input.z2 - candidate.input.z1, candidate.input.x2 - candidate.input.x1) * 180 / Math.PI).toFixed(0)}`).join(",")}`,
        };
      }
      const prepared = preparedByCandidate.get(selection.candidate);
      if (!prepared) throw new Error("GATE1_ROAD_PREFLIGHT_SELECTION_NOT_BOUND");
      preparedRoadRequests.set(preparedKey(proposal), prepared);
      return { status: "FEASIBLE" };
    },
    ...(options.roadAccessConnected ? { roadAccessConnected: options.roadAccessConnected } : {}),
    consumeConcreteChildOperation(amendmentId, courseFingerprint) {
      const durability = options.foundation.durability;
      if (!durability) throw new Error("UTILITY_SERVICE_ROAD_CHILD_DURABILITY_UNAVAILABLE");
      durability.consumeUtilityServiceRoadChildOperation(amendmentId, courseFingerprint);
    },
    async road(proposal, signal): Promise<RoadExecutionRequest> {
      const prepared = preparedRoadRequests.get(preparedKey(proposal));
      if (prepared) {
        preparedRoadRequests.delete(preparedKey(proposal));
        if (prepared.proposal.owner.ownerId !== proposal.taskId ||
          prepared.proposal.fingerprint !== stableRoadInput(prepared.proposal.input)) {
          throw new Error("GATE1_ROAD_PREFLIGHT_REQUEST_BINDING_MISMATCH");
        }
        return structuredClone(prepared);
      }
      let input: RoadGeometryInput;
      if (proposal.concreteChildOperation) {
        input = structuredClone(proposal.concreteChildOperation.input);
        if (stableRoadInput(input) !== proposal.concreteChildOperation.courseFingerprint) {
          throw new Error("GATE1_UTILITY_SERVICE_ROAD_CHILD_FINGERPRINT_MISMATCH");
        }
      } else {
        const candidates = await reproduceCandidate(proposal, signal);
        const candidate = candidates[proposal.methodVariant === "PRIMARY" ? 0 : 1] ?? candidates[0];
        if (!candidate) throw new Error("GATE1_PROGRESSION_NO_BOUNDED_ROAD_CANDIDATE");
        input = candidate.input;
      }

      const length = Math.hypot(input.x2 - input.x1, input.z2 - input.z1);
      const productive = await previewProductiveStarterRoad({
        input,
        preview: options.previewRoad,
        diagnosticContext: {
          roadTaskId: proposal.taskId,
          roadChildId: proposal.concreteChildOperation?.amendmentId,
          atomicOperationId: proposal.concreteChildOperation?.amendmentId ?? proposal.taskId,
        },
        lengthsMeters: [length],
        signal,
      });
      const roadInput = productive.input;
      const fingerprint = stableRoadInput(roadInput);
      if (proposal.concreteChildOperation &&
        (fingerprint !== proposal.concreteChildOperation.courseFingerprint ||
          JSON.stringify(roadInput) !== JSON.stringify(proposal.concreteChildOperation.input))) {
        throw new Error("GATE1_UTILITY_SERVICE_ROAD_PREVIEW_CHANGED_EXACT_INPUT");
      }
      const { quote } = productive;
      return {
        proposal: {
          identity: {
            proposalId: quote.proposalId,
            actionFamily: "ROAD",
            exactInput: fingerprint,
            runtimeEpoch: quote.runtimeEpoch,
            frame: quote.frame,
            validationState: "VALID",
          },
          quoteId: quote.quoteId,
          fingerprint,
          input: roadInput,
          owner: { ownerType: "TASK", ownerId: proposal.taskId },
        },
        quote,
        authorizedMaxSpend: Math.max(quote.signedAmount, 1) * 1.25,
        treasurySafetyReserve: 0,
        worldGeneration: options.world.generation,
      };
    },
    async zoning(proposal, signal): Promise<{ intent: ZoningIntent; baseline: import("./foundation").V2ObservationEnvelope }> {
      const envelope = await options.foundation.observation.capture({
        spatialDetail: {
          x: proposal.target.center.x,
          z: proposal.target.center.z,
          radius: Math.max(64, proposal.target.radius * Math.SQRT2),
          resolution: policy.siteObservationResolution,
        },
        ...(signal ? { signal } : {}),
      });
      const detailSource = envelope.sources.spatialDetail;
      if (envelope.coherence !== "STABLE_FRAME" || detailSource.status !== "AVAILABLE" || !detailSource.data) {
        throw new Error("GATE1_ZONING_BASELINE_UNKNOWN");
      }
      const detail = detailSource.data;
      const projectStateReader = options.foundation.durability as
        (typeof options.foundation.durability & { projectState?: () => unknown }) | undefined;
      const state = typeof projectStateReader?.projectState === "function"
        ? projectStateReader.projectState() as { schemaVersion?: string; districtPlan?: { landUse?: string } }
        : undefined;
      const landUse = state?.schemaVersion === "ai-mayor-v2-gate1-state/2"
        ? state.districtPlan?.landUse ?? "RESIDENTIAL" : "RESIDENTIAL";
      // The scope's own land use, read through the product's table rather than
      // cast into a narrower one. The cast that used to stand here named only
      // residential, commercial and industrial, so an OFFICE scope was
      // re-labelled by its own type — and every reader downstream believed the
      // narrowed value instead of the Goal.
      const zoneCategory = GROWABLE_ZONE_CATEGORY_FOR_LAND_USE[growableLandUseOf(landUse) ?? "RESIDENTIAL"];
      const residentialBuildings = detail.buildings.filter((building) => /residential/i.test(building.prefab));
      const growableFootprint = boundedZoningCellSetInNativeMarquee(detail, proposal.target, zoneCategory);
      if (!growableFootprint) throw new Gate1BoundedZoningDeadEndError(landUse);
      const rankedCells = growableFootprint.cells.map((cell) => ({ ...cell,
        ...(residentialBuildings.length > 0 ? { distanceFromResidentialMeters: Math.min(...residentialBuildings.map((building) =>
          Math.hypot(building.position.x - cell.position.x, building.position.z - cell.position.z))) } : {}),
      }));
      const selected = ZONING_LAYOUT_SKILL.rankCells(rankedCells, proposal.target.center, zoneCategory);
      const actionRadius = growableFootprint.exactRadius;
      // What the scope may allow the marquee to affect.
      //
      // The action radius is the marquee's own Chebyshev half-width plus the
      // epsilon `deriveExactZoningActionRadius` adds so cells sitting exactly on
      // that half-width are not lost to floating point. The reservation radius is
      // what the step was ADMITTED for. They are the same number only when no
      // selected cell reaches the reservation's edge — and when one does, the
      // epsilon puts the action one millimetre past the authorization and
      // `validateIntent` refuses EVERY zoning this step will ever offer with
      // "native zoning radius exceeds authorized maximum".
      //
      // Measured live (2026-10-02): a 32 m reservation whose footprint's
      // half-width was exactly 32 submitted 32.001, the ZONING command never
      // left FAILED_BEFORE_SUBMIT, the Goal re-derived itself every cycle, and
      // the run stalled with the city at a standstill — five of eight ticks
      // blocked on "zoning delivery lacked exact observed effect" behind it.
      //
      // So the bound is the larger of the two. It widens the authorization by at
      // most that epsilon (or to the Bridge's 8 m minimum when the reservation is
      // smaller than that), and the affected set is still bounded where it always
      // was: by the explicit authorized cell list and `maxCellCount`.
      const maximumAffectedRadiusMeters = Math.max(proposal.target.radius, actionRadius);

      const authorizedCells: AuthorizedZoningCell[] = selected.map((cell) => ({
        block: cell.block,
        cellIndex: cell.index,
        expected: {
          zoneType: cell.zoneType,
          zoneCategory: cell.zoneCategory,
          visible: cell.visible,
          roadside: cell.roadside,
          occupied: cell.occupied,
          blocked: cell.blocked,
          overridden: cell.overridden,
        },
      }));
      const scope: AuthorizedMutationScope = {
        owner: { ownerType: "TASK", ownerId: proposal.taskId },
        actionFamily: "ZONING",
        allowedCells: authorizedCells.map(({ block, cellIndex }) => ({ block, cellIndex })),
        spatialEnvelope: { center: proposal.target.center, radius: actionRadius },
        maximumAffectedArea: { maxCellCount: authorizedCells.length, maxRadiusMeters: maximumAffectedRadiusMeters },
        budget: { maximumCost: null, currency: null, status: "PLACEHOLDER" },
        observationPrecondition: {
          observationId: envelope.observationId,
          runtimeEpoch: envelope.runtimeEpoch,
          coherence: envelope.coherence,
        },
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
      return {
        baseline: envelope,
        intent: {
          intentId: proposal.id,
          scope,
          zoneCategory,
          nativeZone: options.readZoneCategory
            ? await options.readZoneCategory(zoneCategory, signal)
            : zoneCategory === "residential"
              ? await options.readResidentialZone(signal)
              : (() => { throw new Error(`GATE1_${zoneCategory.toUpperCase()}_ZONE_PREFAB_UNAVAILABLE`); })(),
          authorizedCells,
          spatialEnvelope: { center: proposal.target.center, radius: actionRadius, resolution: policy.siteObservationResolution },
        },
      };
    },
  };

  return createGate1FoundationBoundary(options.foundation, resolvers);
}
