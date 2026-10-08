import { createHash } from "node:crypto";
import { GROWABLE_ZONE_CATEGORY_FOR_LAND_USE, growthPacePolicy, type GrowthPace } from "../growth-mode";
import type { SpatialBootstrapAsset, SpatialPoint2, SpatialRoadEdge, SpatialSiteDetail, SpatialWorldModel } from "../spatial/types";
import { type CircleScope } from "./gate1";
import {
  type NativeWorldIdentity,
  V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION,
  type V2AdmissionSemanticRepairRecord,
  type V2DurabilityCoordinator,
  type V2DurableActivationStatus,
  type V2ProjectSupersessionReason,
  type V2ProjectBranchIdentity,
  type V2SupersededProjectRecord,
  type V2GoalWorkOrderRecord,
  goalWorkOrderChainClosed,
  goalWorkOrderJournalProvesUnservableRoadTarget,
  goalWorkOrderReachedMilestone,
  type GoalCompletionStage,
} from "./durability";
import type { ObservationCoherence, V2ObservationPorts } from "./foundation";
import {
  createDurableGate1StateStorage,
  type Gate1State,
  planStarterResidentialIntent,
  type StarterResidentialIntentInput,
  V2_GATE1_STATE_SCHEMA_VERSION,
} from "./gate1";
import { classifyNativeRoadPreviewFailure } from "./runtime-road-caller";
import { MAXIMUM_BOUNDED_ROAD_CANDIDATES, sharedRoadGridReference } from "./road-connection-resolver";
import { planRoadCorridor, ROAD_CORRIDOR_MAXIMUM_GRADE_PERCENT, type RoadCorridorPlan } from "../spatial/road-corridor";
import {
  roadCourseGeometry,
  type RoadGeometryInput,
} from "./road-kernel";
import { rawRoadCandidatePreviewVerdict } from "./road-candidate-feasibility";
import { flatFreePatches, rankFrontierPatches, type FrontierPatch } from "./frontier-discovery";
import { orphanReconnections, withoutOrphanComponents } from "./road-components";
import { boundedZoningCellSetInNativeMarquee, classifyGrowableFrontageAbsence, growableSearchSubjectKey, growableTargetKey, isOwnedSpatialPoint, mergeGrowableAbsenceReports, requestedZoneCategory, ringCenter, ringRadius, searchBoundedStarterSites, selectAvailableStarterRoadPrefab, selectGoalWorkOrderSiteAnchors, selectGrowableFrontageFootprint, selectGrowableSearchAnchors, type Gate1BoundedSiteCandidate, type Gate1StarterAnchorClass, type Gate1StarterSiteFallbackReason, type Gate1StarterSiteSearchResult, type GrowableFrontageAbsence, type GrowableFrontageAbsenceReport } from "./site-selection";
import {
  fundStarterProjectBudget,
  recordUtilityServiceRoadChildOperation,
  type UtilityMutationProof,
  type UtilityPlanBudgetRequirement,
} from "./utility-budget";
import { plannedRoadSegmentToMayorAction } from "../utility-recovery";
import {
  assertAdmissionSemanticsReplayEvidence,
  deriveAdmissionSemanticRepairId,
  deriveAdmissionSemanticRepairIntentId,
  resolveAdmissionLineageRoot,
  resolveAdmissionLineageRootIdentity,
  type AdmissionSemanticsReplayEvidence,
} from "./admission-semantic-repair";

/** Hard caps shared by the discovery sweep and the bounded planner input. */
const MAXIMUM_STARTER_ANCHORS = 48;
const MAXIMUM_GROWTH_SITE_ANCHORS = 96;

export function maximumSiteAnchorsForGoal(goalId?: string): number {
  return goalId && /^EXPAND_(?:RESIDENTIAL|COMMERCIAL|INDUSTRIAL|OFFICE)\b/.test(goalId)
    ? MAXIMUM_GROWTH_SITE_ANCHORS : MAXIMUM_STARTER_ANCHORS;
}

/**
 * Explicit production policy for the first bounded residential project.
 *
 * These are product policy, not observations. They exist so that a project
 * budget is never silently derived from the whole observed treasury, and so a
 * starter tranche cannot be admitted when the authoritative finance state
 * cannot fund its certified recipe.
 */
export interface V2ProjectAdmissionPolicy {
  /** Bounded starter population target for the first tranche. */
  targetResidents: number;
  /**
   * Planning envelope reserved around the selected site.
   *
   * This is the BASE radius, not always the selected one. A project whose domain
   * has a site precondition (see `V2ProjectSiteConstraint`) may need a larger
   * reservation to reach the resource its domain requires, and admission then
   * selects the smallest larger radius that works 鈥?up to
   * `maximumPlanningEnvelopeRadiusMeters`. A project without such a constraint
   * always reserves exactly this radius.
   */
  planningEnvelopeRadiusMeters: number;
  /**
   * Hard ceiling on the reservation admission may select when a domain site
   * constraint is not satisfied at the base radius.
   *
   * It exists so that "enlarge the reservation until the resource is inside it"
   * stays a BOUNDED search. Without a ceiling, a domain that needs a resource the
   * world placed far away could claim unbounded land, and a project that no
   * radius can serve would be discovered only by never terminating. A search that
   * reaches this ceiling without a satisfying site fails closed instead.
   */
  maximumPlanningEnvelopeRadiusMeters: number;
  /** Granularity of the bounded radius search, in metres. Must be positive. */
  planningEnvelopeRadiusStepMeters: number;
  /** Bounded authoritative site detail radius used per candidate anchor. */
  siteObservationRadiusMeters: number;
  siteObservationResolution: number;
  /** Maximum number of bounded candidates handed to the deterministic planner. */
  maximumSiteCandidates: number;
  /**
   * How many distinct census centres one growable admission may read before it
   * refuses the region.
   *
   * This is the bound that turns "this site is no good" from a finding about the
   * domain into a finding about one site. It is a search bound, not a retry
   * budget: every anchor is read inside the same admission, so exhausting the
   * ring is a positive result about the ground rather than a reason to ask
   * again later. Distinct geography, not samples: anchors closer together than
   * one census radius are collapsed before they are counted.
   */
  maximumGrowableSearchAnchors: number;
  /** Bounded wait budget for post-zoning building observation. */
  maximumWaitObservations: number;
  /** Absolute ceiling for one starter tranche, regardless of treasury. */
  absoluteBudgetCeiling: number;
  /** Largest share of the observed treasury a single starter tranche may commit. */
  maximumTreasuryShare: number;
  /** Admission is refused below this spend ceiling; an unfundable project is not a project. */
  minimumViableBudget: number;
}

export const V2_PROJECT_ADMISSION_POLICY: V2ProjectAdmissionPolicy = {
  targetResidents: 12,
  planningEnvelopeRadiusMeters: 180,
  // Twice the base radius, and the same ceiling every candidate is observed at
  // through the bounded detail read below, so a selected envelope is still a
  // region this admission actually looked at rather than one it extrapolated to.
  maximumPlanningEnvelopeRadiusMeters: 360,
  planningEnvelopeRadiusStepMeters: 20,
  siteObservationRadiusMeters: 96,
  siteObservationResolution: 16,
  maximumSiteCandidates: 4,
  // Full-speed expansion's own pace sets this at runtime; the value here is the
  // absorption-controlled baseline and is never lower than one, so a build with
  // no pace configured still searches at least one region.
  maximumGrowableSearchAnchors: 4,
  maximumWaitObservations: 3,
  absoluteBudgetCeiling: 25_000,
  maximumTreasuryShare: 0.25,
  minimumViableBudget: 2_500,
};

/** Authoritative reads the bootstrap needs. Native access stays in the adapter layer. */
export interface V2ProjectAdmissionObservationPort {
  /** Authoritative bounded spatial scan used to build the world model. */
  scanWorld(signal?: AbortSignal): Promise<SpatialWorldModel & { bootstrapAssets?: SpatialBootstrapAsset[] }>;
  /**
   * Authoritative bounded site detail for one candidate anchor, with capture
   * coherence. `detail` is null when the native source was unavailable; that
   * anchor is then skipped rather than substituted.
   */
  captureSiteDetail(
    request: { x: number; z: number; radius: number; resolution: number },
    signal?: AbortSignal,
  ): Promise<{ detail: SpatialSiteDetail | null; coherence: ObservationCoherence; observationId: string }>;
  /** Authoritative unlocked road prefab catalogue. */
  readAvailableRoadPrefabs(signal?: AbortSignal): Promise<readonly string[]>;
  /** Authoritative treasury for the active world. */
  readTreasury(signal?: AbortSignal): Promise<number>;
}

export interface V2ProjectAdmissionEvidence {
  worldId: string;
  /** Certified baseline identity this project is derived from. */
  baselineCheckpointId: string;
  intentId: string;
  projectId: string;
  trancheId: string;
  reservationRef: string;
  selectedCandidateId: string;
  /**
   * Whether a `ROAD_FRONTAGE` prerequisite's planned course became the scope's
   * exact one-shot child operation, or only travelled on the work order.
   *
   * Present only for those scopes. `false` means the world proved no branch to
   * bind one to, so the Road step will choose its own course from the world
   * instead — a weaker promise, and one the reader should not have to infer.
   */
  roadCourseChildOperationBound?: boolean;
  /** Which anchor class produced the selected site. */
  anchorClass: Gate1StarterAnchorClass;
  /** Why the ingress seed was used; null when local frontage was used. */
  anchorFallbackReason: Gate1StarterSiteFallbackReason | null;
  inspectedRegions: number;
  eligibleCandidates: number;
  observedTreasury: number;
  treasuryShareLimit: number;
  maximumBudget: number;
  budgetBound: "POLICY_CEILING" | "TREASURY_SHARE" | "UTILITY_PLAN_MINIMUM";
  /** The policy-derived budget before the selected plan's requirement was funded. */
  policyMaximumBudget: number;
  /** What the selected plan declared it costs to finish; null when it declared none. */
  requiredUtilityBudget: number | null;
  /** The requirement verbatim, including where each cost figure came from. */
  utilityBudgetRequirement: UtilityPlanBudgetRequirement | null;
  /**
   * Radius of the reservation this admission actually created.
   *
   * Equals `policy.planningEnvelopeRadiusMeters` unless a domain site constraint
   * forced a larger one, in which case it is the smallest radius on the ladder
   * that satisfied the constraint.
   */
  reservationRadiusMeters: number;
  /**
   * The bounded radii admission was allowed to try, ascending from the policy
   * base to the policy ceiling.
   *
   * Recorded so the durable evidence shows the search was bounded rather than
   * open-ended. Empty for a project with no domain site constraint, which never
   * searches.
   */
  reservationRadiusLadder: number[];
  siteObservationIds: string[];
  /** GRID-family courses passed to native preview while admitting the selected road site. */
  roadGridCandidateCount?: number;
  /** Bounded course previews run by the existing candidate-family admission gate. */
  nativeRoadPreviewCount?: number;
  /** Native preview verdicts that rejected a course before any durable mutation. */
  nativeRoadPreviewRejectedCount?: number;
}

/**
 * The current project's own requirement on a starter site.
 *
 * Admission itself is domain-neutral: it knows ownership, terrain, building
 * conflicts, protection reservations and bounded road access, and nothing about
 * what the project is for. A project whose domain has a site precondition the
 * evaluator cannot see 鈥?a utility that needs a source, say 鈥?supplies one of
 * these, and it is the ONLY thing that can make admission prefer the ingress
 * seed over local frontage. Without it, local frontage wins whenever it exists.
 */
export interface V2ProjectSiteConstraint {
  /** Stable name for the durable evidence record. */
  kind: string;
  /**
   * True when this candidate satisfies the current project's own requirement
   * when the project reserves `reservationRadius` metres around it.
   *
   * The radius is an argument rather than a property of the constraint because
   * the requirement is a function of it. A water source 226 m from a candidate
   * is not reachable from a 180 m reservation and is reachable from a 240 m one,
   * and only the domain can say which radii work 鈥?so the domain owns the test
   * and admission owns the search over the radius (see
   * `planningEnvelopeRadiusLadder`). A constraint that ignores the radius is
   * simply radius-independent, which is the pre-existing behaviour.
   */
  accepts(
    candidate: Gate1BoundedSiteCandidate,
    reservationRadius: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /**
   * What the plan this constraint just accepted costs to finish, when the
   * domain has a figure to declare.
   *
   * Asked once, for the candidate and radius admission selected, and asked
   * BEFORE the project identity is persisted 鈥?because the answer is what the
   * budget must be, and a budget written after the fact is not a bound on
   * anything. A constraint that omits this declares no requirement, and the
   * policy budget stands unmodified.
   *
   * The requirement is per-candidate rather than per-constraint because it
   * depends on the plan the accepted reservation yields: a different
   * reservation reaches a different source over a different distance, and the
   * connection that serves it is not free.
   */
  minimumFeasibleBudget?(
    candidate: Gate1BoundedSiteCandidate,
    reservationRadius: number,
    signal?: AbortSignal,
  ): Promise<UtilityPlanBudgetRequirement | null>;
  /**
   * Describe one bounded prerequisite when every observed candidate failed for
   * the same missing world fact. The prerequisite is data only; admission still
   * creates its scope through this module's ordinary ownership, preview,
   * identity, budget, and durability checks.
   */
  derivePrerequisite?(): Promise<V2GoalPrerequisite | null>;
}

export interface V2GoalPrerequisite {
  kind: "ROAD_ACCESS" | "ROAD_FRONTAGE" | "SERVICE_CAPACITY";
  targetPoint?: { x: number; z: number };
  /**
   * The course a mature planner compiled for this step, when one did.
   *
   * Carried rather than re-derived. `targetPoint` alone is only the far end,
   * and a downstream step that starts from "the node nearest that end" is
   * authoring its own segment — which is how a planned route stops being the
   * route that gets built.
   */
  roadCourse?: { start: { x: number; z: number }; end: { x: number; z: number } };
  evidence: string;
  completionStage: "ROAD_DELIVERED" | "OCCUPIED";
}

export class V2GoalPrerequisiteRequiredError extends Error {
  constructor(readonly prerequisite: V2GoalPrerequisite) {
    super(`GOAL_PREREQUISITE_REQUIRED:${prerequisite.kind}`);
    this.name = "V2GoalPrerequisiteRequiredError";
  }
}

/**
 * A growth Goal whose own bounded search certified that the land it can reach
 * has no zoning footprint this project may take, and that no Road would change
 * that.
 *
 * Deliberately NOT a prerequisite. A `ROAD_FRONTAGE` prerequisite asks for a
 * Road because a Road is what produces frontage; here the frontage is already
 * there (or the land is already owned and executable) and the shortfall is
 * cells, ownership or free land, none of which a Road creates. Raising a
 * prerequisite anyway mints a work order that can only fail, closes it, and
 * lets the next tick derive the same Goal from a fresh facts hash — measured
 * live (2026-09-30) as 149 work orders and a journal that never moved.
 *
 * Carrying `subjectKey` lets the caller park this exact target instead of the
 * whole family. The caller decides how long that memory lasts from the local
 * facts it already holds: this error states what and where, not for how long.
 */
export class V2GrowableFootprintUnserviceableError extends Error {
  constructor(readonly subject: {
    reason: GrowableFrontageAbsence;
    evidence: GrowableFrontageAbsenceReport;
    /** The census region the search read, and the reasons it is the one that decides. */
    target: { center: { x: number; z: number }; radius: number };
    subjectKey: string;
    /**
     * Why the ring's own bounded Road search ended with nothing, when a Road was
     * the answer it was looking for. The policy keeps only the first 300
     * characters of this message, so it is short by construction.
     */
    detail?: string;
  }) {
    super(`PROJECT_ADMISSION_GROWABLE_FOOTPRINT_UNSERVICEABLE:${subject.reason}:${subject.subjectKey}` +
      `${subject.detail ? `:${subject.detail}` : ""}`);
    this.name = "V2GrowableFootprintUnserviceableError";
  }
}

export type V2ProjectAdmissionResult =
  | { status: "ALREADY_ADMITTED"; state: Gate1State }
  | { status: "ADMITTED"; state: Gate1State; evidence: V2ProjectAdmissionEvidence }
  | { status: "PREREQUISITE_ADMITTED"; state: Gate1State; requestedGoalId: string; activeGoalId: string; prerequisite: V2GoalPrerequisite };

export interface V2ProjectAdmissionBootstrap {
  /**
   * Strict admission of the first bounded project. Refuses when any durable
   * project state already exists, so a bootstrap can never overwrite or
   * re-derive an admitted project.
   */
  admitFirstProject(signal?: AbortSignal): Promise<V2ProjectAdmissionResult>;
  /**
   * Production entry: admits the first project iff the durable world is
   * activated and its project state is still the untouched PLACEHOLDER. An
   * already admitted project is returned unchanged without any native read.
   */
  ensureFirstProject(signal?: AbortSignal): Promise<V2ProjectAdmissionResult>;
  /** Admit or resume a distinct goal-scoped work order with its own reservation. */
  ensureGoalWorkOrder(input: { goalId: string; siteConstraint?: V2ProjectSiteConstraint;
    landUse?: StarterResidentialIntentInput["landUse"]; parentGoalId?: string; targetPoint?: { x: number; z: number };
    completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED" }, signal?: AbortSignal): Promise<V2ProjectAdmissionResult>;
  activeGoalWorkOrder(): V2GoalWorkOrderRecord | null;
  /**
   * Set the pacing the next admission is sized and bounded by.
   *
   * The base policy is the full-speed baseline; a pace moves how much land one
   * growable admission searches and how large a programme it asks for on that
   * land. Never a legality rule — see `growthPacePolicy`.
   */
  setPace(pace: GrowthPace): void;
  /** Durable Goal history, used to reconstruct unchanged-fact parks after restart. */
  goalWorkOrders?(): V2GoalWorkOrderRecord[];
  completeGoalWorkOrder(goalId: string): V2GoalWorkOrderRecord;
  recordGate1ProgressionOutcome(input: { status: string; state: Gate1State | null; reason?: string }): V2GoalWorkOrderRecord | null;
  /**
   * Record that the durable project's admission no longer holds and admit the
   * ONE project that replaces it.
   *
   * Only for a project whose admission is known to be invalid 鈥?the site it was
   * admitted at cannot serve the domain it was admitted for, and no radius the
   * product allows can make it serve. A project that is merely unfinished is not
   * supersedable, and the lineage is capped at two projects: a superseded project
   * may not be superseded again, and neither may its replacement. Re-superseding
   * is how a caller would try to buy a second replacement, and it is refused
   * durably rather than by convention.
   *
   * The superseded project is not repaired, deleted or rewritten. Its identity,
   * its reservation, its delivered world effects and its journal stay exactly as
   * they were; what is added is the record that its admission was invalid.
   */
  supersedeAndReplaceFirstProject(
    input: { reason: V2ProjectSupersessionReason; detail: string },
    signal?: AbortSignal,
  ): Promise<V2ProjectReplacementResult>;
  /** Replan one admitted project for the active checkpoint branch. */
  replanForCurrentBranch(input: { detail: string }, signal?: AbortSignal): Promise<V2CurrentBranchReplanResult>;
  /**
   * Admit the one project that repairs a durable project whose admission no
   * longer holds because the ADMISSION SEMANTICS changed.
   *
   * This is deliberately not a supersession, and it is not a widening of one.
   * A supersession records that an admission was wrong. This records that an
   * admission was right for the semantics of its time and the product has since
   * changed what admission means 鈥?a rule changing under an already-correct
   * decision. The ordinary supersession lineage stays capped at two projects,
   * exactly as it was, and this cannot reach a project that rule already bounds.
   *
   * What bounds THIS operation instead is identity, not a counter: the repair is
   * keyed by `(root project, semantics revision)`, both derived from durable
   * records, so the same pair names at most one repair forever. Re-entry
   * reproduces that repair rather than buying another, and a repair that itself
   * fails cannot be re-minted 鈥?only a genuinely new semantics revision can
   * repair this lineage again.
   *
   * Refuses, without recording anything, unless the caller supplies positive
   * evidence for all of: the world is durably activated, the durable project has
   * not spent or mutated anything through the utility boundary, the current
   * production replay judged that project's own reservation invalid under the
   * current semantics, and the same replay produced a complete game-verified
   * plan (native placement accepted, groundwater valid, road candidate valid,
   * budget known). A missing or contradictory half is a refusal, never a repair.
   */
  repairAdmissionSemantics(
    input: {
      semanticsRevision: string;
      evidence: AdmissionSemanticsReplayEvidence;
      mutation: UtilityMutationProof;
      detail: string;
    },
    signal?: AbortSignal,
  ): Promise<V2AdmissionSemanticRepairResult>;
}

export type V2CurrentBranchReplanResult =
  | { status: "REPLANNED"; replan: V2SupersededProjectRecord; state: Gate1State; evidence: V2ProjectAdmissionEvidence }
  | { status: "ALREADY_REPLANNED"; replan: V2SupersededProjectRecord; state: Gate1State };

/** Stable key for a project revision created on one certified loaded branch. */
export function deriveCurrentBranchProjectReplanIdentity(input: V2ProjectBranchIdentity): { replanId: string; intentId: string } {
  if (!input.worldId.trim() || !input.checkpointId.trim() || !Number.isInteger(input.journalCut) || input.journalCut < 0) {
    throw new Error("PROJECT_REPLAN_BRANCH_IDENTITY_INVALID");
  }
  const branch = `${input.worldId}|${input.checkpointId}|${input.journalCut}`;
  const encoded = encodeURIComponent(branch);
  return { replanId: `project-replan:${encoded}`, intentId: `intent:gate1-replan:${encoded}` };
}

export type V2ProjectReplacementResult = {
  status: "REPLACED";
  /** The durable history record for the project this replaced. */
  supersession: V2SupersededProjectRecord;
  state: Gate1State;
  evidence: V2ProjectAdmissionEvidence;
};

export type V2AdmissionSemanticRepairResult =
  | {
      status: "REPAIRED";
      /** The durable history record for the admission this replaced, by rule. */
      repair: V2AdmissionSemanticRepairRecord;
      state: Gate1State;
      evidence: V2ProjectAdmissionEvidence;
    }
  /**
   * A previous run of the same `(root, revision)` already recorded this repair.
   * The durable slot already holds the project it names, so resuming is the only
   * safe reading 鈥?minting a second repair is what the identity bound forbids.
   */
  | { status: "ALREADY_REPAIRED"; repair: V2AdmissionSemanticRepairRecord; state: Gate1State };

export interface V2ProjectAdmissionOptions {
  durability: V2DurabilityCoordinator;
  activateDurableWorld(signal?: AbortSignal): Promise<{
    kind: string;
    world: NativeWorldIdentity;
    blockedReason: string | null;
    status: V2DurableActivationStatus;
  }>;
  observation: V2ProjectAdmissionObservationPort;
  /**
   * The current project's own site requirement, when its domain has one.
   *
   * This is the only input that can make admission escalate past owned local
   * frontage to the owned map-highway ingress seed, and it escalates only when
   * every local candidate fails it. Absent means admission behaves exactly as it
   * did before the ingress fallback existed.
   */
  siteConstraint?: V2ProjectSiteConstraint;
  /** Construct a resource-specific constraint from this admission's authoritative scan. */
  siteConstraintForGoal?(input: {
    goalId: string; world: SpatialWorldModel; bootstrapAssets: readonly SpatialBootstrapAsset[];
  }, signal?: AbortSignal): Promise<V2ProjectSiteConstraint | null>;
  /**
   * Bounded, read-only native preview of one Road course 鈥?the same contract the
   * Gate 1 Road step previews against.
   *
   * Supplying it makes admission refuse a site whose own bounded road courses
   * the game will not build, which is a fact about the land that zoneable
   * frontage cannot express. Absent means admission keeps its previous
   * behaviour exactly: it judges a site by its frontage and its domain.
   */
  previewRoad?(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  policy?: V2ProjectAdmissionPolicy;
  now?: () => Date;
}

const clone = <T>(value: T): T => structuredClone(value);

/** How many times re-joining one orphan stub may be refused (no corridor, or native refuses every exit) before it is left alone. */
export const MAXIMUM_ORPHAN_RECONNECTION_REFUSALS = 3;
const orphanReconnectionRefusals = new Map<string, number>();

/** How many refused Road sites a standalone Road Goal remembers; older ones age out so changed ground is retried. */
export const MAXIMUM_UNSERVABLE_ROAD_SITE_EXCLUSIONS = 16;

/**
 * The sites standalone Road Goals have already been refused at, as exclusion circles for the next site search.
 *
 * Measured live (2026-10-03): with the island's land used up, every cycle re-admitted `ESTABLISH_ROAD_NETWORK` with a
 * fresh facts hash, the bounded search picked the SAME site beside node 55896:1, native refused both of its courses,
 * and the cycle ended — 21 ticks, zero writes. The work order's own journal already proves the site unservable
 * (`goalWorkOrderJournalProvesUnservableRoadTarget`, the same predicate the successor walk reads); feeding those
 * reservations to the search as protections makes it pick another site, and when none is left the search's
 * "no eligible site" answer is what opens the frontier survey toward land no road reaches yet.
 */
export function unservableRoadSiteExclusions(
  orders: ReadonlyArray<{ workOrderId: string; goalId: string; status: string;
    state: { project: { utilityReservation: { center: { x: number; z: number }; radius: number } };
      journal?: ReadonlyArray<{ failureClassification?: string | null; reason?: string | null }> } }>,
): Array<{ ref: string; scope: { center: { x: number; z: number }; radius: number } }> {
  return orders
    .filter((order) => /^ESTABLISH_ROAD_NETWORK(?::|$)/.test(order.goalId) && !order.goalId.includes(":prerequisite:") &&
      order.status === "BLOCKED" && goalWorkOrderJournalProvesUnservableRoadTarget(order))
    .slice(-MAXIMUM_UNSERVABLE_ROAD_SITE_EXCLUSIONS)
    .map((order) => ({ ref: `unservable-road-site:${order.workOrderId}`,
      scope: { center: { ...order.state.project.utilityReservation.center }, radius: order.state.project.utilityReservation.radius } }));
}

/** A standalone Road Goal owns only the delivered Road milestone, so frontage for a later Zoning task is irrelevant. */
export function isStandaloneRoadGoalAdmission(input: {
  goalId?: string;
  completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED";
  targetPoint?: { x: number; z: number };
}): boolean {
  return !!input.goalId && /^ESTABLISH_ROAD_NETWORK(?::|$)/.test(input.goalId) &&
    input.completionStage === "ROAD_DELIVERED" && input.targetPoint === undefined;
}

/** Keep a targetless standalone Road Goal's bounded site search on the shared grid. */
export function goalWorkOrderRoadSearchTarget(input: {
  goalId?: string;
  completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED";
  targetPoint?: SpatialPoint2;
  previousRoadTerminal?: SpatialPoint2;
  roadEdges: readonly SpatialRoadEdge[];
}): SpatialPoint2 | undefined {
  if (input.targetPoint) return input.targetPoint;
  if (!isStandaloneRoadGoalAdmission(input)) return undefined;
  return input.previousRoadTerminal ?? sharedRoadGridReference(input.roadEdges)?.origin;
}

/**
 * The same bounds the trusted water corridor runs under
 * (`water-site-constraint.ts:227-231`), restated rather than imported so the two
 * cannot drift apart silently — they are the same class of route over the same
 * ground.
 */
const CORRIDOR_GROUND_READS = 24;
const CORRIDOR_EXPANDED_CELLS = 20_000;
const CORRIDOR_SAMPLED_CELLS = 20_000;
const CORRIDOR_DETOUR_RATIO = 2.5;
/** One committed hop. The water path proved this length buildable on real ground. */
const CORRIDOR_HOP_METERS = 150;

/**
 * One legal hop along a PLANNED route to land that has no frontage.
 *
 * A growth Goal's road chain advances in 28 m reservations carrying <= 64 m
 * segments, one admission per hop, and each hop re-aims at the far target from
 * whatever anchor it starts at. That is a walk with no cost over the whole
 * route: measured live 2026-10-01, three ROAD_FRONTAGE prerequisites for one
 * target were admitted 265 m, 274 m and 710 m away, all three built real roads,
 * and the frontage census at the anchor moved 7 -> 7, 18 -> 19, 7 -> 7.
 *
 * The mature long-distance planner exists and is already trusted with exactly
 * this job for water outfalls (`water-site-constraint.ts:732`): `planRoadCorridor`
 * is deterministic A* over a coarse grid with an explicit grade ceiling, a
 * detour ratio, a route length ceiling and named refusals, and it compiles its
 * route into bounded legal segments. Its consumer hands the Road step
 * `segments[0].end` — "the first bounded hop, never the far target" — and each
 * delivery shortens the next plan, so the chain converges on the ground it was
 * sent to.
 *
 * This is that contract for a frontage prerequisite: the corridor decides the
 * route, the prerequisite carries its FIRST hop as the target, and the ordinary
 * admission/Road/finance/durability path builds it unchanged. Nothing about
 * reservation size, authorization or native legality is altered here.
 *
 * The ground reads are bounded (24), cached per 25 m cell and only ever spent
 * where the Fast Path has already refused, so the anti-churn property that
 * matters is untouched: a parent that can zone still costs exactly one census
 * and never reaches this function.
 *
 * The three answers are DIFFERENT and must not be collapsed:
 *
 * - `planned`   — the planner certified a route. Its first hop is the target.
 * - `unreachable` — the planner ran and refused (`NO_BOUNDED_CORRIDOR`) with its
 *   own detour/length/sample evidence. That is the authority for "this land
 *   cannot be served by the road capability the product actually has", and the
 *   caller must park the target rather than spend a road elsewhere.
 * - `unobserved` — the planner could not read the ground it needed. Nothing is
 *   proven either way, so the caller keeps its previous behaviour.
 *
 * Collapsing `unreachable` into `unobserved` is what let the old bounded walk
 * fall back to the far land point and build three roads that served none of it;
 * a silent fallback onto a path already measured as wrong is not compatibility,
 * it is the defect.
 */
export type CorridorHopAnswer =
  | {
    kind: "planned";
    /**
     * The first hops this planner is willing to leave by, best route first.
     *
     * Not one course: which way a corridor leaves is only partly a planning
     * question, because native certifies some exits at a junction and folds
     * others by local topology the planner cannot see. These are the planner's
     * OWN alternatives — the same route search re-planned from a different exit
     * of its own list — so the caller certifies them in order and binds the first
     * native accepts, without ever falling back to a second planner.
     */
    courses: Array<{ start: SpatialPoint2; end: SpatialPoint2 }>;
    reason: string;
  }
  | { kind: "unreachable"; reason: string }
  | { kind: "unobserved"; reason: string };

/**
 * Exported for the read-only frontage-refusal diagnostic
 * (`tmp/probe-frontage-refusal-class.ts`).
 *
 * The two refusals this returns — `unreachable`/`unobserved` from the planner,
 * and a `planned` route whose every course native refuses — are collapsed into
 * one `MISSING_FRONTAGE` park reason by the caller, so live evidence cannot tell
 * them apart. A diagnostic that re-implemented the corridor call would have to
 * copy `maximumLength: 2048`, `CORRIDOR_HOP_METERS`, the detour ratio and the
 * ground-read budget, and would drift from production. Sharing the function
 * measures the production path itself. No behaviour changes: it is the same
 * call the ring loop makes.
 */
export async function corridorFirstHopTarget(input: {
  world: SpatialWorldModel;
  observation: V2ProjectAdmissionObservationPort;
  /** The network the corridor leaves from. */
  from: SpatialPoint2;
  /** The land that needs frontage. */
  to: SpatialPoint2;
  signal?: AbortSignal;
}): Promise<CorridorHopAnswer> {
  const groundAt = (detail: SpatialSiteDetail | null, point: SpatialPoint2) => {
    if (!detail) return null;
    const { resolution, bounds, cellSize } = detail.terrain;
    if (!(resolution > 0) || !(cellSize.x > 0) || !(cellSize.z > 0)) return null;
    if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) return null;
    const col = Math.min(resolution - 1, Math.max(0, Math.floor((point.x - bounds.minX) / cellSize.x)));
    const row = Math.min(resolution - 1, Math.max(0, Math.floor((point.z - bounds.minZ) / cellSize.z)));
    const index = row * resolution + col;
    const height = detail.terrain.heights[index];
    if (!Number.isFinite(height)) return null;
    // The worst gradient to an orthogonal neighbour, which is what a road
    // crosses. Read exactly as the water corridor reads it
    // (`water-site-constraint.ts:267-279`): `cellSize` IS the per-cell pitch, not
    // the extent of the read. Dividing it by the resolution instead inflates
    // every grade by that factor, which puts every move over the ceiling and
    // makes the planner unreachable — measured live as a corridor that silently
    // returned no route and fell back to the far land point.
    const neighbours = [
      col > 0 ? index - 1 : -1,
      col + 1 < resolution ? index + 1 : -1,
      row > 0 ? index - resolution : -1,
      row + 1 < resolution ? index + resolution : -1,
    ].filter((neighbour) => neighbour >= 0);
    const spacing = Math.min(cellSize.x, cellSize.z);
    const gradePercent = neighbours.reduce((worst, neighbour) => {
      const neighbourHeight = detail.terrain.heights[neighbour];
      if (!Number.isFinite(neighbourHeight)) return worst;
      return Math.max(worst, (Math.abs(height - neighbourHeight) / spacing) * 100);
    }, 0);
    return { height, waterDepth: detail.terrain.waterDepths[index] ?? 0, gradePercent };
  };
  // Ground is read ONCE per READ TILE, and every sample inside a tile the
  // planner has already paid for is answered from the mosaic of what it read.
  //
  // Keyed by the read's own radius, not by the 25 m search cell: one bounded
  // 400 m read already contains the ground for every 25 m cell inside it, while
  // a per-cell key spends the whole budget re-reading the same square. Measured
  // live (2026-10-01) on a 136 m corridor: 24 reads bought 24 cells, every
  // further move was answered "not observed", and the planner returned
  // `no legal corridor connects the start to the target` — a refusal admission
  // reads as `unreachable`, parks the target, and reports
  // `GROWTH_POLICY_ALL_DOMAINS_REFUSED` for the whole family. The water corridor
  // has always run this way (`water-site-constraint.ts:712-731`, whose comment
  // names the same failure); this is the same rule, not a second one.
  const CORRIDOR_READ_RADIUS_METERS = 400;
  const CORRIDOR_READ_RESOLUTION = 64;
  const reads = new Map<string, SpatialSiteDetail | null>();
  const mosaic: SpatialSiteDetail[] = [];
  let readCount = 0;
  const loadedFor = (point: SpatialPoint2): SpatialSiteDetail | null => {
    for (const detail of mosaic) {
      const bounds = detail.terrain.bounds;
      if (point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ) {
        return detail;
      }
    }
    return null;
  };
  const sampleGround = async (point: SpatialPoint2) => {
    // Any ground already paid for answers this sample, whichever tile it came
    // from: the mosaic is what the budget bought, and re-reading a square the
    // planner is standing in is not a second observation of the world.
    const loaded = loadedFor(point);
    if (loaded) return groundAt(loaded, point);
    const tile = `${Math.round(point.x / CORRIDOR_READ_RADIUS_METERS)},` +
      `${Math.round(point.z / CORRIDOR_READ_RADIUS_METERS)}`;
    const cached = reads.get(tile);
    if (cached !== undefined) return groundAt(cached, point);
    if (readCount >= CORRIDOR_GROUND_READS) return null;
    readCount += 1;
    let detail: SpatialSiteDetail | null = null;
    try {
      const captured = await input.observation.captureSiteDetail({
        x: point.x, z: point.z, radius: CORRIDOR_READ_RADIUS_METERS, resolution: CORRIDOR_READ_RESOLUTION,
      }, input.signal);
      detail = captured.coherence === "UNKNOWN" ? null : captured.detail;
    } catch {
      detail = null;
    }
    if (detail) mosaic.push(detail);
    reads.set(tile, detail);
    return groundAt(detail, point);
  };
  const plan = (firstStep?: { col: number; row: number }) => planRoadCorridor({
    start: input.from,
    target: input.to,
    sampleGround,
    maximumLength: 2048,
    maximumSegmentLength: CORRIDOR_HOP_METERS,
    maximumGradePercent: ROAD_CORRIDOR_MAXIMUM_GRADE_PERCENT,
    maximumDetourRatio: CORRIDOR_DETOUR_RATIO,
    maximumExpandedCells: CORRIDOR_EXPANDED_CELLS,
    maximumSamples: CORRIDOR_SAMPLED_CELLS,
    existingRoads: input.world.roadGraph.edges.filter((edge) => !edge.deleted)
      .map((edge) => ({ start: { x: edge.start.x, z: edge.start.z }, end: { x: edge.end.x, z: edge.end.z } })),
    isOwned: (point) => isOwnedSpatialPoint(point, input.world),
    ...(firstStep ? { firstStep } : {}),
  });
  try {
    const corridor = await plan();
    if (corridor.status === "NO_BOUNDED_CORRIDOR" && corridor.entrances.length === 0) {
      // The planner ran on observed ground and refused with nothing to offer
      // instead. Its own evidence is the finding, and it is reported rather than
      // discarded.
      return { kind: "unreachable", reason: `corridor ${corridor.status}: ${corridor.reason}; ` +
        `routeLength=${corridor.evidence.routeLength}m, detourRatio=${corridor.evidence.detourRatio}, ` +
        `samples=${corridor.evidence.samples}, groundReads=${readCount}` };
    }
    // The planner's own route first, then EVERY exit it lists, in its own order,
    // each re-planned rather than bent. A refused first hop does not mean the
    // land is unreachable — it means this planner's first choice of exit is not
    // one native certifies, and the planner has others.
    //
    // Bounded by the planner, not by a number here: the exits are the legal
    // neighbours of the start cell, so there are at most eight, and offering all
    // of them is still a search rather than a heading sweep. A smaller cap was
    // tried and is simply wrong — measured live (2026-10-01), the certified exit
    // at both live anchors was the seventh and eighth of the list.
    const courses: Array<{ start: SpatialPoint2; end: SpatialPoint2 }> = [];
    const taken = new Set<string>();
    const offer = (plan: RoadCorridorPlan) => {
      const segment = plan.segments[0];
      if (!segment) return false;
      const id = `${segment.start.x.toFixed(3)}:${segment.start.z.toFixed(3)}:` +
        `${segment.end.x.toFixed(3)}:${segment.end.z.toFixed(3)}`;
      if (taken.has(id)) return false;
      taken.add(id);
      courses.push({ start: { x: segment.start.x, z: segment.start.z }, end: { x: segment.end.x, z: segment.end.z } });
      return true;
    };
    if (corridor.status === "PLANNED") offer(corridor);
    for (const entrance of corridor.entrances) offer(await plan(entrance));
    if (courses.length === 0) {
      return { kind: "unreachable", reason: `corridor ${corridor.status}: ${corridor.reason}; ` +
        `${corridor.entrances.length} entrance(s) considered, none produced a first hop; ` +
        `groundReads=${readCount}` };
    }
    return { kind: "planned", courses,
      reason: `corridor ${corridor.status}: remaining=${corridor.remaining.toFixed(1)}m, ` +
        `segments=${corridor.segments.length}, routeLength=${corridor.evidence.routeLength}m, ` +
        `${courses.length} entrance course(s) from ${corridor.entrances.length} exit(s)` };
  } catch (error) {
    // A planner that threw proved nothing about the land. Say so explicitly
    // instead of letting the caller read it as "no route exists".
    return { kind: "unobserved", reason: `corridor planner threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The first foreign reservation a course crosses, tested at five points along it, or null. */
export function protectedReservationCrossedBy(
  course: { start: { x: number; z: number }; end: { x: number; z: number } },
  protections: ReadonlyArray<{ ref: string; scope: CircleScope }>,
): { ref: string } | null {
  const { start, end } = course;
  for (const protection of protections) {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const point = { x: start.x + (end.x - start.x) * ratio, z: start.z + (end.z - start.z) * ratio };
      if (Math.hypot(point.x - protection.scope.center.x, point.z - protection.scope.center.z) <= protection.scope.radius) {
        return protection;
      }
    }
  }
  return null;
}

/**
 * The admission of one `ROAD_FRONTAGE` step, taken from the course planned for
 * it rather than from a site search.
 *
 * A frontage step owns no lot, claims no zoning footprint, and proves nothing
 * about its own anchor's census: it is one Road step, asked for one legal
 * segment. Its whole scope is the ground that segment crosses, so that is what
 * this returns as the candidate — with no road-candidate family for a bounded
 * search to re-derive a different course from.
 */
function frontageCorridorSearch(input: {
  goalWorkOrderId?: string;
  course?: { start: { x: number; z: number }; end: { x: number; z: number } };
  policy: V2ProjectAdmissionPolicy;
  reservationRadiusByCandidate: Map<string, number>;
  /** Land another live work order still holds. A foreign scope is never crossed. */
  protections: ReadonlyArray<{ ref: string; scope: CircleScope }>;
}): Gate1StarterSiteSearchResult {
  const label = input.goalWorkOrderId ?? "<no-goal>";
  if (!input.course) {
    // Every prerequisite raised from now on carries its course. A record
    // without one predates that and must be re-derived by the Goal that raised
    // it — admitting it on a guess about which course was meant is exactly the
    // second planner this path exists to remove.
    throw new Error(`ROAD_FRONTAGE_PREREQUISITE_REQUIRES_PLANNED_COURSE:${label}`);
  }
  const { start, end } = input.course;
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  if (!(length > 0)) throw new Error(`ROAD_FRONTAGE_PREREQUISITE_COURSE_DEGENERATE:${label}`);
  // The bounded search refused a candidate standing on land another work order
  // still holds, and this path must keep that property rather than lose it with
  // the search. Every point the segment crosses is tested, not just its ends: a
  // course that bridges two foreign scopes crosses both.
  const crossed = protectedReservationCrossedBy(input.course, input.protections);
  if (crossed) throw new Error(`ROAD_FRONTAGE_PREREQUISITE_COURSE_CROSSES_PROTECTED_RESERVATION:${label}:${crossed.ref}`);
  // Both ends of the segment have to lie inside the scope it reserves: the Road
  // child refuses a course that escapes its own reservation, so a scope that
  // did not cover the course would make the step unexecutable by construction.
  const center = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
  const radius = Math.max(input.policy.planningEnvelopeRadiusMeters, length / 2);
  const id = `frontage-corridor:${start.x.toFixed(3)}:${start.z.toFixed(3)}:${end.x.toFixed(3)}:${end.z.toFixed(3)}`;
  input.reservationRadiusByCandidate.set(id, radius);
  return {
    anchorClass: "OWNED_LOCAL_ROAD_TOPOLOGY", fallbackReason: null,
    selection: {
      candidates: [{
        id, target: { center, radius }, score: 0, blocked: false,
        direction: { x: (end.x - start.x) / length, z: (end.z - start.z) / length },
        // The course reaches Gate 1 as the Road task's own exact child
        // operation, so this scope offers no alternatives: a bounded family here
        // would be a second planner choosing the route again.
        roadCandidates: [],
        evidence: {
          sourceAnchor: { x: start.x, z: start.z }, openResidentialCells: 0,
          owned: true, buildable: true, access: "BOUNDED_ROAD_FEASIBLE",
        },
      }],
      rejections: { NOT_OWNED: 0, OUTSIDE_ANCHOR_OBSERVATION: 0, NOT_BUILDABLE: 0, NO_ACCESS: 0, NO_ROUTE: 0, WATER: 0, TERRAIN: 0,
        PROTECTION_RESERVATION: 0, ZONEABLE_FRONTAGE: 0, OUTSIDE_PROJECT_SCOPE: 0, TARGET_NOT_ADVANCED: 0,
        UNKNOWN: 0, OTHER: 0 },
      inspectedRegions: 1,
    },
    local: { anchors: 1, observations: 1, candidates: 1, accepted: 1 }, ingress: null,
  };
}

/**
 * Bind the planned course to the fresh scope's Road task as its exact child
 * operation.
 *
 * The record is the one the utility service-road path already uses — same
 * schema, same one-shot spend, same world/plan-revision staleness guards, same
 * loader validation on restart — because "this exact course, once" is the same
 * fact whatever planned it. What differs is only who planned it.
 */
function attachPlannedCourseChildOperation(input: {
  durability: V2DurabilityCoordinator;
  state: Gate1State;
  world: NativeWorldIdentity;
  goalWorkOrderId: string;
  course: { start: { x: number; z: number }; end: { x: number; z: number } };
  availableRoadPrefabs?: readonly string[];
  journalCut: number | undefined;
}): boolean {
  const label = input.goalWorkOrderId;
  // A fresh scope is still on its first task, so the Road task is found by its
  // tranche rather than by `currentTaskIds` — the current-task slot only names
  // it once the ladder reaches it.
  const roadTaskId = input.state.tranche.currentTaskIds?.ROAD_CONNECTION ??
    input.state.tasks.find((candidate) =>
      candidate.trancheId === input.state.tranche.id && candidate.kind === "ROAD_CONNECTION")?.id;
  const roadTask = roadTaskId
    ? input.state.tasks.find((candidate) => candidate.id === roadTaskId && candidate.kind === "ROAD_CONNECTION")
    : undefined;
  if (!roadTask) throw new Error(`ROAD_FRONTAGE_PREREQUISITE_ROAD_TASK_MISSING:${label}`);
  if (!["PENDING", "WAITING"].includes(roadTask.status) || roadTask.terminalOutcomeId !== null ||
    roadTask.childOperationAmendmentId !== undefined) {
    throw new Error(`ROAD_FRONTAGE_PREREQUISITE_ROAD_TASK_NOT_ATTACHABLE:${label}:${roadTask.status}`);
  }
  const cut = input.journalCut;
  // A child operation is bound to one certified branch. The branch's identity is
  // its rollback boundary, not the checkpoint its world was loaded from — a city
  // started fresh has no loaded checkpoint and its baseline boundary is still the
  // one the store certified. Binding without a proven branch would mint a course
  // the Road resolver can only ever answer "plan revision is stale" to — a work
  // order that cannot execute at all, which is strictly worse than one whose Road
  // step chooses its own course. So the binding stays graded: the planned course
  // always travels on the work order, and it becomes an exact one-shot child
  // operation only where a branch makes that executable.
  const branch = input.durability.currentBranchCheckpoint();
  if (!branch || branch.worldId !== input.world.worldId || branch.journalCut !== cut ||
    !Number.isInteger(cut) || (cut as number) < 0) return false;
  const checkpointId = branch.checkpointId;
  const planRevision = deriveCurrentBranchProjectReplanIdentity({
    worldId: branch.worldId, checkpointId, journalCut: branch.journalCut,
  }).replanId;
  const prefab = selectAvailableStarterRoadPrefab({ availableRoadPrefabs: [...(input.availableRoadPrefabs ?? [])] });
  const exactRoadInput = roadCourseGeometry(plannedRoadSegmentToMayorAction({
    id: `frontage-corridor:${label}`, role: "side", start: input.course.start, end: input.course.end,
  }, prefab));
  const child = recordUtilityServiceRoadChildOperation({
    durability: input.durability,
    state: input.state,
    planRevision,
    exactRoadInput,
    authorizationWorldId: branch.worldId,
    authorizationCheckpointId: branch.checkpointId,
    authorizationGeneration: branch.generation,
    detail: `ROAD_FRONTAGE prerequisite corridor segment for ${label}`,
  });
  if (JSON.stringify(child.exactRoadInput) !== JSON.stringify(exactRoadInput) ||
    child.status !== "ACTIVE" || child.executionUseStatus !== "UNUSED") {
    throw new Error(`ROAD_FRONTAGE_PREREQUISITE_CHILD_BINDING_MISMATCH:${label}`);
  }
  roadTask.childOperationAmendmentId = child.amendmentId;
  roadTask.childOperationAmendmentIds = [child.amendmentId];
  // The state carrying the child id is the one that must be durable: a child
  // recorded but not attached is a course nobody will ever build.
  input.durability.saveProjectState(input.state);
  return true;
}

/** Read the terminal from either a MayorAction or the durable ROAD geometry envelope. */
export function exactRoadTerminalPoint(exactInput: string): SpatialPoint2 | undefined {
  try {
    const parsed = JSON.parse(exactInput);
    const actions = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [parsed as Record<string, unknown>];
    const action = actions.find((candidate) => (candidate.type === "build_road" || candidate.actionFamily === "ROAD") &&
      [candidate.x1, candidate.z1, candidate.x2, candidate.z2].every((coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate)));
    return action ? { x: Number(action.x2), z: Number(action.z2) } : undefined;
  } catch {
    return undefined;
  }
}

/** Reconstruct the latest successful ordinary Road terminal in this exact world epoch. */
export function latestObservedRoadTerminal(commands: ReadonlyArray<{
  position: number;
  worldEpochId: string;
  record: { actionFamily: string; status: string; authorizedScope?: unknown };
}>, worldEpochId: string): SpatialPoint2 | undefined {
  const latestFirst = [...commands].filter((entry) => entry.worldEpochId === worldEpochId &&
    entry.record.actionFamily === "ROAD" && entry.record.status === "OBSERVED_MATCH")
    .sort((left, right) => right.position - left.position);
  for (const entry of latestFirst) {
    const scope = entry.record.authorizedScope && typeof entry.record.authorizedScope === "object"
      ? entry.record.authorizedScope as { exactInput?: unknown } : null;
    if (typeof scope?.exactInput !== "string") continue;
    const terminal = exactRoadTerminalPoint(scope.exactInput);
    if (terminal) return terminal;
  }
  return undefined;
}

/**
 * Stable first-project identity.
 *
 * The identity is derived from durable lineage only: the durable world identity
 * and the certified baseline checkpoint of that world. Both survive a certified
 * baseline reload/restart unchanged, so a re-bootstrap after a rollback to the
 * certified baseline reproduces exactly the same project/tranche/reservation.
 *
 * Deliberately excluded sources:
 * - `worldEpochId` / `generation`: these are runtime generation identifiers and
 *   change on every reload and re-attach.
 * - the live `checkpointId` of the loaded save, which advances with periodic saves.
 * - wall clock and randomness, which are not identity.
 */
export function deriveStarterProjectIntentId(input: { worldId: string; baselineCheckpointId: string; executionBranchId?: string }): string {
  if (typeof input.worldId !== "string" || input.worldId.trim().length === 0) {
    throw new Error("PROJECT_ADMISSION_WORLD_IDENTITY_MISSING");
  }
  if (typeof input.baselineCheckpointId !== "string" || input.baselineCheckpointId.trim().length === 0) {
    throw new Error("PROJECT_ADMISSION_BASELINE_IDENTITY_MISSING");
  }
  if (input.executionBranchId !== undefined && !input.executionBranchId.trim()) throw new Error("PROJECT_ADMISSION_EXECUTION_BRANCH_ID_MISSING");
  return `intent:gate1-starter:${input.worldId}:baseline:${input.baselineCheckpointId}${input.executionBranchId ? `:branch:${input.executionBranchId}` : ""}`;
}

/** Stable, branch-bound identity for one semantic work order. */
export function deriveGoalWorkOrderIntentId(input: {
  worldId: string; baselineCheckpointId: string; executionBranchId: string; goalId: string;
}): string {
  if (!input.worldId.trim() || !input.baselineCheckpointId.trim() || !input.executionBranchId.trim() || !input.goalId.trim()) {
    throw new Error("GOAL_WORK_ORDER_IDENTITY_INCOMPLETE");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    input.worldId, input.baselineCheckpointId, input.executionBranchId, input.goalId,
  ])).digest("hex");
  return `intent:gate1-goal-work-order:${digest}`;
}

/**
 * Identity of the ONE project admitted to replace a superseded one.
 *
 * Derived from the superseded intent and the reason, so it is deterministic and
 * carries its own lineage: the same supersession always yields the same
 * replacement, and a replacement cannot be minted for a project that was never
 * superseded. Both inputs are durable facts, so this survives a reload exactly
 * as `deriveStarterProjectIntentId` does.
 *
 * Deliberately not an ordinal. A counter would let a caller keep re-minting
 * identities by incrementing it 鈥?the unbounded re-admission that the first
 * project's stable identity exists to prevent. The bound is structural instead:
 * a project may be superseded once, and a project that IS a replacement may not
 * be superseded at all, so the lineage is at most two projects deep.
 */
export function deriveReplacementStarterProjectIntentId(input: {
  supersededIntentId: string;
  reason: string;
}): string {
  if (typeof input.supersededIntentId !== "string" || input.supersededIntentId.trim().length === 0) {
    throw new Error("PROJECT_REPLACEMENT_SUPERSEDED_INTENT_MISSING");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new Error("PROJECT_REPLACEMENT_REASON_MISSING");
  }
  return `${input.supersededIntentId}:superseded:${input.reason}:replacement`;
}


/** Resolve the per-world certified baseline identity the project lineage descends from. */export function certifiedBaselineCheckpointId(durability: V2DurabilityCoordinator, world: NativeWorldIdentity): string {
  const state = durability.snapshot();
  const anchor = state.certifiedRollbackAnchor;
  if (anchor?.status === "CERTIFIED" && anchor.worldId === world.worldId) return anchor.checkpointId;
  const baseline = state.baselineActivation;
  if (baseline?.worldId === world.worldId && typeof baseline.checkpointId === "string") {
    return baseline.checkpointId;
  }
  throw new Error("PROJECT_ADMISSION_BASELINE_NOT_CERTIFIED");
}

/**
 * The bounded ladder of reservation radii admission may try, ascending from the
 * policy base to the policy ceiling.
 *
 * Ascending because the answer wanted is the SMALLEST reservation that can serve
 * the project: a reservation is a claim on the world, and the product must not
 * claim more of it than the project needs. Bounded because the alternative 鈥? * enlarging until the resource is inside 鈥?lets a domain constraint claim
 * unbounded land to reach an arbitrarily distant resource, and turns "no such
 * site exists" from a refusal into a non-terminating search.
 *
 * The ceiling is always the last rung even when the step does not land on it, so
 * the whole bound is reachable and not merely approached.
 */
/**
 * The Goal lineage an admission belongs to, as Goal ids.
 *
 * A prerequisite corridor is a sequence of bounded Road work orders that all
 * descend from one Goal, and each of them reserves land for the step it takes.
 * Those steps are one effort: the second step of a corridor is the continuation
 * of the first, not a rival claim on it. Treating them as foreign would let each
 * step's own envelope refuse the next step's site, so a Goal whose resource sits
 * beyond one road segment could never be reached no matter how long it waited.
 *
 * A DIFFERENT Goal's envelope is still foreign and still refuses the candidate,
 * which is the property the protection exists for.
 */
export function sameGoalFamilyGoalIds(
  records: readonly V2GoalWorkOrderRecord[],
  input: { goalId: string; parentGoalId?: string | null },
): Set<string> {
  const family = new Set<string>([input.goalId]);
  const byGoalId = new Map(records.map((item) => [item.goalId, item]));
  let cursor: string | null = input.parentGoalId ?? null;
  // Bounded by the registry size, so a malformed lineage cannot spin here.
  for (let hop = 0; cursor !== null && hop <= records.length; hop += 1) {
    if (family.has(cursor)) break;
    family.add(cursor);
    cursor = byGoalId.get(cursor)?.parentGoalId ?? null;
  }
  for (const record of records) {
    if (record.parentGoalId && family.has(record.parentGoalId)) family.add(record.goalId);
  }
  return family;
}

/**
 * How many bounded prerequisite steps one Goal may take before admission stops
 * deriving them.
 *
 * It is a cap on a *search*, not a target: each step still has to pass the whole
 * site search, the road resolver, the reservation, the budget and the native
 * preview on its own. It is sized from the corridor it has to cover 鈥?a resource
 * observed a few hundred metres outside the road network needs one bounded Road
 * work order per segment, and each segment is short because a candidate may only
 * be as far from its anchor as the region admission actually observed. A
 * kilometre of corridor is therefore a dozen or so steps, and the rest is
 * headroom for a corridor that has to be replanned after an abandoned step.
 */
export const MAXIMUM_GOAL_PREREQUISITE_STEPS = 48;

/**
 * How many closed successors one Goal may leave behind before admission stops
 * deriving them.
 *
 * A Goal asked for again from unchanged world facts names the work order it was
 * already admitted as. When that work order has closed, the answer is a
 * successor that inherits its Goal but nothing else 鈥?a fresh site, a fresh
 * reservation, a fresh budget. Each successor still has to pass the whole
 * admission on its own, so this cap is not a target either: it is what stops a
 * Goal whose domain can never be satisfied here from spending the whole work
 * order registry on retries of itself.
 *
 * Sized well above the bounded steps a Goal legitimately needs to find a site
 * its domain can actually use, and well below the registry limit, so reaching it
 * is reported as an exhausted Goal rather than as a full history.
 */
export const MAXIMUM_GOAL_SUCCESSOR_STEPS = 8;

/**
 * The milestone a Goal's work order is done at, read from its id.
 *
 * A Road Goal owns its delivered course, and a base utility Goal's deliverable IS
 * the utility — it stops once its own durable execution certifies the service.
 *
 * A growth Goal stops at `WAITING_FOR_OCCUPANCY`: a building has been observed
 * and attributed on the land it rezoned, and whether anybody then moves in is
 * the simulation's answer, not this Goal's deliverable. It used to stop at
 * `OCCUPIED`, which made every expansion package hold the Brain until its
 * buildings filled — the "build, then wait for absorption, then build again"
 * cadence the product has replaced. Waiting for occupancy is an absorption
 * signal, and absorption reorders the domains; it does not schedule the city.
 *
 * The observation is not skipped: the stage is reached only after this
 * tranche's own buildings have been read back as existing. What is dropped is
 * the wait for residents, which is the long half and the half a Mayor has no
 * action to influence.
 *
 * Read here rather than trusted from the caller because a Goal is admitted more
 * than once, and the second admission often names it by id alone: a bounded
 * prerequisite completes and the parent is resumed with
 * `ensureGoalWorkOrder(active.parentGoalId)`, creating the parent's record for
 * the first time. Measured live (2026-09-30): every
 * `UTILITY_SERVICE:sewage:city:site_scope:*` work order carried no stage, walked
 * the residential ladder to `ZONED_WAITING_FOR_BUILDING`, and closed the one
 * stage (`ROAD_DELIVERED`) that admits the connection its placed outfall needed.
 *
 * A prerequisite is deliberately not covered: it is a bounded step with its own
 * milestone, which its parent always states explicitly.
 */
export function goalCompletionStageForGoalId(
  goalId: string,
): GoalCompletionStage | undefined {
  if (goalId.includes(":prerequisite:")) return undefined;
  if (goalId.startsWith("ESTABLISH_ROAD_NETWORK")) return "ROAD_DELIVERED";
  if (/^(?:UTILITY_SERVICE|PROVIDE_SERVICE):/.test(goalId)) return "WAITING_FOR_OCCUPANCY";
  // A growth Goal's deliverable is its delivered frontage plus its rezoned land,
  // both observed — NOT the building that may later appear on the land and not
  // the residents who may later move into it.
  //
  // The product is a bulk expansion machine: it lays the frontage, zones the land
  // and moves on, and the city's own absorption happens in the background on the
  // simulation's schedule. Making a tranche wait for a building put the game's
  // growth cadence in charge of the Mayor's, and it deadlocked: `UTILITY_PROVISION`
  // held the tranche waiting for a building that only `ZONING` can produce, so the
  // tranche could neither advance nor close (measured live 2026-09-30, journaled
  // `UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING` on its 102nd attempt with
  // `ZONING` at `attempts: 0`).
  if (/^EXPAND_(?:RESIDENTIAL|COMMERCIAL|INDUSTRIAL|OFFICE)\b/.test(goalId)) return "ZONED_WAITING_FOR_BUILDING";
  return undefined;
}

/**
 * How many of one site candidate's own road courses admission previews before
 * refusing the site.
 *
 * This is the resolved family's own bound, not a smaller sample of it, because
 * the two numbers answer the same question and a sample answers a DIFFERENT one:
 * admission is asking "can the Road step build into this site", and the Road step
 * sweeps `resolveBoundedRoadCandidates`' whole bounded family. A subset of that
 * family is a question native never gets asked downstream, so a refusal drawn
 * from it refuses land the Road step would have built on.
 *
 * Measured live (2026-09-29, the electricity Goal's site search over the loaded
 * save): with three courses sampled, every candidate was refused and admission
 * reported `PROJECT_ADMISSION_NO_ELIGIBLE_SITE` with `roadGateRefusals: 6` 鈥? * every Goal was unable to receive a scope. Previewing the resolver's own eight
 * variants across three sources admitted a site for the same Goal and the same
 * world. The sweep is not the expensive part: it stops at the first course native
 * certifies, so the extra previews are spent only on the refusals that need the
 * verification. Live cost of the change: 107 -> 119 `cs2_spatial` calls.
 */
export const MAXIMUM_ADMISSION_ROAD_PREVIEWS = MAXIMUM_BOUNDED_ROAD_CANDIDATES;

/**
 * The work order a Goal's request actually resolves to.
 *
 * `goalId` is the Goal a planner asked for *plus the world facts it asked from*,
 * so a Goal requested twice from the same facts names the same work order. That
 * is the identity the store is keyed on and it must not be broken: minting a
 * second work order for a Goal that already has one would put two live claims on
 * the land it reserved.
 *
 * What it must NOT do is treat a *closed* work order as the Goal's permanent
 * identity. A work order that reached its milestone, or whose bounded chain ran
 * out, is finished: its reservation is released and something else may already
 * have been admitted into the land it gave up. Re-asking for such a Goal is not
 * a resurrection, and it is not a reason for the city to stop growing either 鈥? * it is the next bounded attempt at the same Goal from the same facts.
 *
 * So a closed work order yields a SUCCESSOR: a new work order whose identity
 * descends from the one that closed. That makes it deterministic (the same
 * closure always yields the same successor, so a repeated call resumes the same
 * attempt instead of stacking new ones) and bounded (a work order closes once,
 * so the chain is a path through terminal outcomes, capped here).
 */
export function resolveGoalWorkOrderId(
  lookup: (goalId: string) => (Pick<V2GoalWorkOrderRecord, "status" | "goalId" | "releasedReservationAt" | "workOrderId">
    & { state?: { journal?: ReadonlyArray<{ failureClassification?: string | null; reason?: string | null }> } | null }) | null,
  requestedGoalId: string,
): string {
  if (!requestedGoalId.trim()) throw new Error("GOAL_WORK_ORDER_ID_REQUIRED");
  let goalId = requestedGoalId;
  // The walk IS the chain: each successor is derived from the one before it, so
  // hopping from the root visits the whole family in order. Bounding the hops
  // therefore bounds how many successors one Goal root may leave behind 鈥?  // per root, not per call. A per-call bound let a Goal whose facts never
  // changed mint up to the budget again every time it was asked, and the ids
  // grew into one another doing it.
  for (let hop = 1; ; hop += 1) {
    const record = lookup(goalId);
    if (!record) return goalId;
    if (!goalWorkOrderChainClosed(record)) return goalId;
    // A chain that closed because its own Road target was proven undeliverable
    // is not a plan that finished. The same Goal re-derived from the same facts
    // can only reproduce the same refusal, so a successor here is a work order
    // spent on an answered question — measured live as eight identical ones.
    // Refusing is a finding about THIS Goal's land, so the caller classifies it
    // as domain-scoped and the cycle asks the next domain instead of waiting.
    if (goalWorkOrderJournalProvesUnservableRoadTarget(record)) {
      throw new Error(`GOAL_SUCCESSOR_UNSERVABLE_ROAD_TARGET:${requestedGoalId}`);
    }
    if (hop > MAXIMUM_GOAL_SUCCESSOR_STEPS) {
      throw new Error(`GOAL_SUCCESSOR_BUDGET_EXHAUSTED:${requestedGoalId}`);
    }
    goalId = deriveGoalSuccessorGoalId(requestedGoalId, record.workOrderId);
  }
}

/**
 * The identity of one Goal's next bounded attempt.
 *
 * A digest of the root and the work order that closed, not the predecessor's id
 * appended to it. Appending made each attempt name the whole chain before it, so
 * the ids doubled in length every round and fifteen rounds produced an id too
 * long to read 鈥?and the family was bounded only by how often it had been asked.
 * A digest keeps every attempt in the family one short, fixed-size name, which
 * is what makes the hop bound above mean something.
 */
export function deriveGoalSuccessorGoalId(rootGoalId: string, predecessorWorkOrderId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([rootGoalId, predecessorWorkOrderId]))
    .digest("hex").slice(0, 16);
  return `${rootGoalId}:successor:${digest}`;
}

export function planningEnvelopeRadiusLadder(policy: V2ProjectAdmissionPolicy): number[] {
  const base = policy.planningEnvelopeRadiusMeters;
  const maximum = Math.max(base, policy.maximumPlanningEnvelopeRadiusMeters);
  const step = policy.planningEnvelopeRadiusStepMeters;
  if (!Number.isFinite(step) || step <= 0) throw new Error("PROJECT_ADMISSION_ENVELOPE_STEP_INVALID");
  const ladder: number[] = [];
  for (let radius = base; radius <= maximum; radius += step) ladder.push(radius);
  if (ladder[ladder.length - 1] !== maximum) ladder.push(maximum);
  return ladder;
}

/**
 * Bound the starter project budget by observed treasury *and* explicit policy.
 * The whole treasury is never treated as a project budget.
 */
export function deriveStarterProjectBudget(input: { treasury: number; policy: V2ProjectAdmissionPolicy }): {
  maximumBudget: number;
  treasuryShareLimit: number;
  budgetBound: "POLICY_CEILING" | "TREASURY_SHARE";
} {
  if (!Number.isFinite(input.treasury) || input.treasury < 0) {
    throw new Error("PROJECT_ADMISSION_TREASURY_UNKNOWN");
  }
  const treasuryShareLimit = Math.floor(input.treasury * input.policy.maximumTreasuryShare);
  const maximumBudget = Math.min(input.policy.absoluteBudgetCeiling, treasuryShareLimit);
  if (maximumBudget < input.policy.minimumViableBudget) {
    throw new Error("PROJECT_ADMISSION_BUDGET_BELOW_POLICY_MINIMUM");
  }
  return {
    maximumBudget,
    treasuryShareLimit,
    budgetBound: treasuryShareLimit < input.policy.absoluteBudgetCeiling ? "TREASURY_SHARE" : "POLICY_CEILING",
  };
}

export function createV2ProjectAdmissionBootstrap(options: V2ProjectAdmissionOptions): V2ProjectAdmissionBootstrap {
  const basePolicy = options.policy ?? V2_PROJECT_ADMISSION_POLICY;
  // The pace is a property of the work being asked for right now, not of the
  // process, so it lives here as state the runtime can move rather than being
  // frozen into a policy captured at construction. `policy` is what every reader
  // in this factory already uses; it is rebound whenever the pace changes, which
  // is what makes the population-derived brake actually slow the Mayor down
  // instead of being a number nobody consults.
  let policy: V2ProjectAdmissionPolicy = basePolicy;
  const applyPace = (pace: GrowthPace) => { policy = growthPacePolicy(basePolicy, pace); };
  const now = options.now ?? (() => new Date());

  async function admit(signal?: AbortSignal): Promise<V2ProjectAdmissionResult> {
    const existing = options.durability.projectState();
    if (existing.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION) {
      throw new Error("PROJECT_ADMISSION_ALREADY_EXISTS");
    }
    if (existing.schemaVersion !== V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION) {
      throw new Error("PROJECT_ADMISSION_PROJECT_STATE_UNRECOGNIZED");
    }
    return admitProject(
      (world, baselineCheckpointId) => {
        const branchResolver = (options.durability as V2DurabilityCoordinator & { executionBranchId?: () => string | null }).executionBranchId;
        const executionBranchId = branchResolver
          ? branchResolver.call(options.durability)
          : `${world.worldId}:${baselineCheckpointId}`;
        if (!executionBranchId) throw new Error("PROJECT_ADMISSION_EXECUTION_BRANCH_NOT_ACTIVE");
        return deriveStarterProjectIntentId({ worldId: world.worldId, baselineCheckpointId, executionBranchId });
      },
      signal,
    );
  }

  /**
   * The admission itself, with identity supplied by the caller.
   *
   * Everything downstream of identity is identical for a first project and for a
   * replacement: the same bounded site search, the same reservation search, the
   * same budget derivation, the same durable write. Only the intent id differs,
   * and the caller owns it because only the caller knows whether this admission
   * is the first one or the one replacement a supersession buys.
   */
  async function admitProject(
    intentIdFor: (world: NativeWorldIdentity, baselineCheckpointId: string) => string,
    signal?: AbortSignal,
    goalWorkOrderId?: string,
    goalSiteConstraint?: V2ProjectSiteConstraint,
    goalLandUse?: StarterResidentialIntentInput["landUse"],
    goalMetadata?: { parentGoalId?: string; targetPoint?: { x: number; z: number };
      roadCourse?: { start: { x: number; z: number }; end: { x: number; z: number } };
      parentLandUse?: StarterResidentialIntentInput["landUse"];
      completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED"; skipSiteConstraint?: boolean },
  ): Promise<V2ProjectAdmissionResult> {
    const { durability } = options;

    const activation = await options.activateDurableWorld(signal);
    if (activation.blockedReason) throw new Error(activation.blockedReason);
    if (!durability.isExecutionDurablyActivated(activation)) {
      throw new Error(`${activation.status}: project admission requires a durably activated world`);
    }
    const world = activation.world;
    const baselineCheckpointId = certifiedBaselineCheckpointId(durability, world);
    const intentId = intentIdFor(world, baselineCheckpointId);

    const treasury = await options.observation.readTreasury(signal);
    const budget = deriveStarterProjectBudget({ treasury, policy });

    // New streets grow out of the CONNECTED network only: orphan stubs are not sources (see `road-components.ts`).
    const rawModel = await options.observation.scanWorld(signal);
    const model = withoutOrphanComponents(rawModel);
    const availableRoadPrefabs = await options.observation.readAvailableRoadPrefabs(signal);

    // Only anchors whose bounded site detail was captured authoritatively (a
    // non-UNKNOWN coherence) may enter site evaluation. An unavailable or
    // incoherent region is not evidence and is never substituted.
    const siteObservationIds: string[] = [];
    const siteConstraint = goalMetadata?.skipSiteConstraint ? undefined : goalSiteConstraint ??
      (goalWorkOrderId && options.siteConstraintForGoal
        ? await options.siteConstraintForGoal({ goalId: goalWorkOrderId, world: model,
          bootstrapAssets: model.bootstrapAssets ?? [] }, signal)
        : options.siteConstraint);
    const goalScopedWaterSite = goalWorkOrderId && siteConstraint?.kind === "water-source-within-utility-reservation";
    const frontagePrerequisite = !!goalMetadata?.parentGoalId && goalMetadata.completionStage === "ROAD_DELIVERED" &&
      !!goalWorkOrderId && /:prerequisite:ROAD_FRONTAGE:/.test(goalWorkOrderId);
    const roadOnlyGoal = frontagePrerequisite || isStandaloneRoadGoalAdmission({
      goalId: goalWorkOrderId, completionStage: goalMetadata?.completionStage, targetPoint: goalMetadata?.targetPoint,
    });
    // An ordinary Road Goal has no resource coordinate to aim its bounded site
    // search at. Anchor that existing search to the shared road-grid origin so
    // separate Goals continue the same city grid instead of selecting an
    // unrelated owned tile by enumeration order. Candidate generation, native
    // preview, authorization and execution remain on the same path.
    const previousRoadTerminal = roadOnlyGoal
      ? latestObservedRoadTerminal(durability.snapshot().commands, world.worldEpochId)
      : undefined;
    const roadGoalSearchTarget = goalWorkOrderRoadSearchTarget({ goalId: goalWorkOrderId,
      completionStage: goalMetadata?.completionStage, targetPoint: goalMetadata?.targetPoint, previousRoadTerminal,
      roadEdges: model.roadGraph.edges });
    const goalDirectedRoadSearch = !!goalWorkOrderId && (!!roadGoalSearchTarget || goalScopedWaterSite);
    // Growth admission must prove the reservation-shaped zoning census before
    // it commits to a site. If the first bounded neighbourhood contains only
    // rejected or unobserved zoning reservations, inspect one additional ring
    // of existing anchors. Road and utility Goals keep their original bound.
    const maximumSiteAnchors = maximumSiteAnchorsForGoal(goalWorkOrderId);
    // The Goal lineage this admission belongs to: its own Goal, the Goals above
    // it, and the bounded steps already taken for the Goal directly above it.
    // Those are one continuous effort with this admission, not competing claims.
    const goalFamilyGoalIds = goalWorkOrderId
      ? sameGoalFamilyGoalIds(durability.snapshot().goalWorkOrders ?? [], {
        goalId: goalWorkOrderId,
        parentGoalId: goalMetadata?.parentGoalId,
      })
      : new Set<string>();
    // Which reservation radius each accepted candidate needed. Filled by the
    // bounded search below and read back for the candidate admission selects, so
    // the envelope that gets reserved is the one that was actually justified.
    const reservationRadiusByCandidate = new Map<string, number>();
    const radiusLadder = planningEnvelopeRadiusLadder(policy);
    // The bounded set of radii the search below was allowed to try, ascending.
    // Empty without a site constraint, because then no search happens at all.
    const reservationRadiusLadder = siteConstraint ? [...radiusLadder] : [];
    const acceptCandidate = async (candidate: Gate1BoundedSiteCandidate, acceptSignal?: AbortSignal): Promise<boolean> => {
      if (!siteConstraint) return true;
      for (const radius of radiusLadder) {
        if (await siteConstraint.accepts(candidate, radius, acceptSignal)) {
          reservationRadiusByCandidate.set(candidate.id, radius);
          return true;
        }
      }
      // No radius up to the ceiling can serve this candidate. It is refused
      // rather than admitted at the ceiling: a reservation too small to reach the
      // project's own resource is a project that can never be delivered.
      return false;
    };
    /**
     * Whether the game will build at least one of this site's own road courses.
     *
     * A site this project can zone is still a site it cannot use if native
     * refuses every course that would reach it. Admission knew the first fact
     * (`hasZoneableCell`) and nothing about the second, so it kept choosing land
     * whose anchors reject every sampled direction and length 鈥?observed live as
     * three consecutive Goals whose three source nodes refused all 24 courses
     * with `operation blocked by game validation`. The Goal then closed, a
     * successor was admitted from the same facts, and the next one landed on the
     * same unbuildable ground.
     *
     * Only a verdict about the LAND refuses a site. A preview that could not be
     * read, or one that answers UNKNOWN, is not evidence against the site and
     * leaves it accepted 鈥?UNKNOWN must stay UNKNOWN, and admission must not
     * invent a rejection it cannot evidence. A site with no course at all is the
     * corridor fallback, which is judged by its own rules downstream.
     */
    /**
     * Whether the tranche this site would create can actually be zoned.
     *
     * `evaluateBoundedStarterSites` prefers a site that carries zoneable frontage
     * and keeps a frontage-less one as its bounded fallback, so a world that
     * offers nothing better still admits something. That is the right behaviour
     * for a CANDIDATE GENERATOR and the wrong behaviour for ADMISSION: a site the
     * zoning step cannot take is not a site this project can use, and admitting
     * it spends a real road build on land that is then terminally unusable.
     * Measured live: a tranche whose reservation contained zero cells at every
     * radius the zoning step tries, admitted, roaded, and closed at
     * `GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET`.
     *
     * Three-way on purpose. `true` is a proven census; `false` is a census that
     * positively places cells and gives none of them to this reservation; an
     * ABSENT reading is a capture that returned no census, which is unproven
     * rather than disproven and must not become a rejection.
     */
    let roadGateRefusals = 0;
    let zoneGateRefusals = 0;
    let zoneCensusUnproven = 0;
    let nativeRoadPreviewCount = 0;
    let nativeRoadPreviewRejectedCount = 0;
    /**
     * Whether this reservation is one the ZONING step can actually take.
     *
     * The census has to be the one the ZONING step will take: centred on the
     * RESERVATION, at the radius and resolution that resolver reads. A
     * candidate's own `frontage` / `zoningFootprint` are computed from the
     * ANCHOR's observation square, and those are two different reads of two
     * different pieces of ground — measured live (2026-09-30) on a 28 m
     * expansion reservation where the anchor-shaped census called the site
     * zoneable, the reservation-shaped census found no bounded cell set the
     * marquee could take, and the tranche closed terminally at
     * `GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET` after paying for its road.
     *
     * Admission is stricter than ranking: the ZONING step cannot execute from
     * an absent census, so an absent, empty, failed, or incoherent read parks
     * this candidate instead of forwarding it to a step that must fail. A
     * non-empty authoritative census with no bounded executable cell set is a
     * proven refusal.
     */
    const zoneable = async (
      candidate: Gate1BoundedSiteCandidate,
      acceptSignal?: AbortSignal,
    ): Promise<boolean> => {
      if (!options.observation.captureSiteDetail) {
        zoneCensusUnproven += 1;
        return false;
      }
      const scope = { center: candidate.target.center, radius: candidate.target.radius };
      let captured: { detail: SpatialSiteDetail | null; coherence: ObservationCoherence };
      try {
        captured = await options.observation.captureSiteDetail({
          x: scope.center.x, z: scope.center.z,
          radius: Math.max(64, scope.radius * Math.SQRT2),
          resolution: policy.siteObservationResolution,
        }, acceptSignal);
      } catch {
        zoneCensusUnproven += 1;
        return false;
      }
      if (captured.coherence === "UNKNOWN" || captured.detail === null || captured.detail.zoningCells.length === 0) {
        zoneCensusUnproven += 1;
        return false;
      }
      if (boundedZoningCellSetInNativeMarquee(captured.detail, scope) === null) {
        zoneGateRefusals += 1;
        return false;
      }
      return true;
    };
    const roadBuildable = async (candidate: Gate1BoundedSiteCandidate, acceptSignal?: AbortSignal): Promise<boolean> => {
      const preview = options.previewRoad;
      if (!preview) return true;
      const courses = candidate.roadCandidates.slice(0, MAXIMUM_ADMISSION_ROAD_PREVIEWS);
      if (courses.length === 0) return true;
      for (const course of courses) {
        let raw: unknown;
        try {
          nativeRoadPreviewCount += 1;
          raw = await preview(course.input, acceptSignal);
        } catch (error) {
          if (classifyNativeRoadPreviewFailure(error) !== "REJECTED") return true;
          nativeRoadPreviewRejectedCount += 1;
          continue;
        }
        if (rawRoadCandidatePreviewVerdict(raw)?.status !== "INVALID") return true;
        nativeRoadPreviewRejectedCount += 1;
      }
      roadGateRefusals += 1;
      return false;
    };
    /**
     * Whether native will build this exact compiled hop.
     *
     * The planner decides the route; only native answers whether that route can be
     * built where it runs. Every other Road candidate admission considers is
     * verified this way (`roadBuildable`), and a compiled hop earns no exemption
     * for having been planned — measured live (2026-10-01): a 94.8 m hop the
     * corridor compiled from a degree-5 anchor came back
     * `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, while a 45 m hop compiled from
     * another anchor in the same ring certified at 264.
     *
     * A preview that cannot be read is not evidence against the route: UNKNOWN
     * stays UNKNOWN, and the hop is offered.
     */
    const compiledHopVerdict = async (
      course: { start: SpatialPoint2; end: SpatialPoint2 },
      verifySignal?: AbortSignal,
    ): Promise<"accepted" | "refused" | "unverified"> => {
      const preview = options.previewRoad;
      if (!preview) return "unverified";
      const prefab = selectAvailableStarterRoadPrefab({ availableRoadPrefabs: [...availableRoadPrefabs] });
      let raw: unknown;
      try {
        nativeRoadPreviewCount += 1;
        raw = await preview({ prefab, x1: course.start.x, z1: course.start.z, x2: course.end.x, z2: course.end.z }, verifySignal);
      } catch (error) {
        if (classifyNativeRoadPreviewFailure(error) !== "REJECTED") return "unverified";
        nativeRoadPreviewRejectedCount += 1;
        return "refused";
      }
      if (rawRoadCandidatePreviewVerdict(raw)?.status === "INVALID") {
        nativeRoadPreviewRejectedCount += 1;
        return "refused";
      }
      return "accepted";
    };
    /** Flat, dry, building-free owned ground no road reaches yet, nearest the network first. */
    const surveyFrontierLand = async () => {
      const patches: FrontierPatch[] = [];
      for (const tile of model.ownedTiles.filter((entry) => entry.owned && entry.bounds).slice(0, 16)) {
        const bounds = tile.bounds!;
        const centre = { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
        const radius = Math.min(512, Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2 + 8);
        try {
          const captured = await options.observation.captureSiteDetail(
            { x: centre.x, z: centre.z, radius, resolution: 32 }, signal);
          if (captured.coherence === "UNKNOWN" || !captured.detail) continue;
          patches.push(...flatFreePatches({ detail: captured.detail, isOwned: (point) => isOwnedSpatialPoint(point, model) }));
        } catch {
          continue;
        }
      }
      return rankFrontierPatches({
        patches,
        network: model.roadGraph.nodes
          .map((node) => ({ x: node.position.x, z: node.position.z }))
          .filter((point) => isOwnedSpatialPoint(point, model)),
      });
    };
    const growableGoal = !!goalWorkOrderId && !goalMetadata?.parentGoalId && !!goalLandUse &&
      /^EXPAND_(?:RESIDENTIAL|COMMERCIAL|INDUSTRIAL|OFFICE)\b/.test(goalWorkOrderId);
    // A street that joins nothing serves nothing. Before laying anything new, a standalone Road Goal re-joins the
    // orphan stubs the world already holds: the same corridor-hop prerequisite a growth Goal uses, from the nearest
    // connected node toward the stub. An orphan the planner or native cannot reach is remembered, not retried forever.
    if (roadOnlyGoal && !frontagePrerequisite && !goalMetadata?.targetPoint && goalWorkOrderId) {
      // The child step refuses a course that crosses land another live work order holds, and by then the whole Goal
      // closes and the next cycle picks the same gap again (measured live, run-s1: 15 closures, 5 idle ticks). Refuse
      // such a hop here instead, so the next gap — or ordinary grid growth — gets the cycle. Not remembered: the
      // reservation releases by itself when its tranche finishes.
      const foreignProtections = (durability.snapshot().goalWorkOrders ?? [])
        .filter((item) => durability.isGoalWorkOrderReservationProtected(item.workOrderId) && !goalFamilyGoalIds.has(item.goalId))
        .map((item) => ({ ref: item.reservationRef, scope: clone(item.state.project.utilityReservation) }));
      for (const gap of orphanReconnections(rawModel.roadGraph)) {
        const attemptKey = `${gap.orphan.id}:${gap.orphan.streets}`;
        if ((orphanReconnectionRefusals.get(attemptKey) ?? 0) >= MAXIMUM_ORPHAN_RECONNECTION_REFUSALS) continue;
        const hop = await corridorFirstHopTarget({ world: model, observation: options.observation, from: gap.from, to: gap.to,
          ...(signal ? { signal } : {}) });
        let bound: { start: SpatialPoint2; end: SpatialPoint2 } | null = null;
        let heldByForeignReservation = false;
        if (hop.kind === "planned") {
          for (const candidate of hop.courses) {
            if (protectedReservationCrossedBy(candidate, foreignProtections)) { heldByForeignReservation = true; continue; }
            if (await compiledHopVerdict(candidate, signal) !== "refused") { bound = candidate; break; }
          }
        }
        if (!bound && heldByForeignReservation) continue;
        if (!bound) {
          orphanReconnectionRefusals.set(attemptKey, (orphanReconnectionRefusals.get(attemptKey) ?? 0) + 1);
          continue;
        }
        throw new V2GoalPrerequisiteRequiredError({
          kind: "ROAD_FRONTAGE",
          targetPoint: { x: bound.end.x, z: bound.end.z },
          roadCourse: { start: { x: bound.start.x, z: bound.start.z }, end: { x: bound.end.x, z: bound.end.z } },
          completionStage: "ROAD_DELIVERED",
          evidence: `a ${gap.orphan.streets}-street stub at (${gap.to.x.toFixed(0)}, ${gap.to.z.toFixed(0)}) is not joined to the ` +
            `network (${gap.distanceMeters.toFixed(0)} m away); a native-certified ${Math.hypot(bound.end.x - bound.start.x, bound.end.z - bound.start.z).toFixed(0)} m ` +
            `corridor hop leaves the connected network toward it`,
        });
      }
    }
    let search: Gate1StarterSiteSearchResult;
    if (frontagePrerequisite) {
      // A `ROAD_FRONTAGE` prerequisite is admitted from the course a planner
      // compiled for it, and from nothing else.
      //
      // This scope's whole question is "how does a Road step leave the existing
      // network and reach that land", and the answer is a compiled corridor
      // segment. It is NOT "which owned lot may be zoned, is its census
      // complete, is this point itself a buildable lot" — those are the
      // questions of a Goal that means to zone, and asking them of a Road
      // prerequisite means the Road cannot be built until it has already
      // produced the frontage it exists to produce.
      //
      // Measured live (2026-10-01): every growth domain was refused
      // `PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN` on a
      // `:prerequisite:ROAD_FRONTAGE:` work order — 17 empty anchor censuses
      // out of 48 — while the bounded SITE search underneath found no buildable
      // candidate at all. The Road step never ran, in any domain, for tick after
      // tick. The gates leave this path rather than being relaxed inside it:
      // the planner's own answer — source, route, first compiled segment — is
      // already carried by the work order.
      search = frontageCorridorSearch({
        goalWorkOrderId, course: goalMetadata?.roadCourse, policy, reservationRadiusByCandidate,
        // A prerequisite may cross the land its OWN Goal family already holds —
        // that is how a corridor continues across its own earlier step — but
        // never a foreign work order's.
        protections: (durability.snapshot().goalWorkOrders ?? [])
          .filter((item) => durability.isGoalWorkOrderReservationProtected(item.workOrderId) &&
            !goalFamilyGoalIds.has(item.goalId))
          .map((item) => ({ ref: item.reservationRef, scope: clone(item.state.project.utilityReservation) })),
      });
    } else if (growableGoal) {
      // A bounded ring of census centres around the existing owned local road
      // network supplies both Zone Blocks and road geometry. Every anchor is
      // read inside this one admission: exhausting the ring is a positive
      // finding about the ground, not a reason to ask again on a later cycle.
      //
      // The single-centroid search this replaces was deterministic in the road
      // graph, so a region the land had already disproved was re-derived
      // identically forever — the same target, the same refusal, until the whole
      // domain was parked and the Brain reported no goal while buildable land
      // was still on the map. See `selectGrowableSearchAnchors`.
      const observationRadius = Math.min(320, Math.max(192, policy.siteObservationRadiusMeters * 2));
      const anchors = selectGrowableSearchAnchors({
        world: model,
        ...(goalMetadata?.targetPoint ? { targetPoint: goalMetadata.targetPoint } : {}),
        maxAnchors: policy.maximumGrowableSearchAnchors,
        separationMeters: observationRadius,
        // The same catalogue the Road step below already searches with. Without
        // it the ring is blind to every road this product has built, so the
        // frontier could never move outward.
        availableRoadPrefabs,
      }).anchors;
      if (anchors.length === 0) throw new Error("GROWABLE_FAST_PATH_NO_OWNED_LOCAL_ROAD");
      const zoneCategory = GROWABLE_ZONE_CATEGORY_FOR_LAND_USE[goalLandUse];
      const protections = [
        ...((durability.snapshot().goalWorkOrders ?? [])
          .filter((item) => durability.isGoalWorkOrderReservationProtected(item.workOrderId) &&
            !goalFamilyGoalIds.has(item.goalId))
          .map((item) => ({ ref: item.reservationRef, scope: clone(item.state.project.utilityReservation) }))),
        ...(() => {
          const current = durability.projectState();
          return current.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && current.project.status !== "COMPLETE" &&
            !(durability.snapshot().goalWorkOrders ?? []).some((item) => item.projectId === current.project.id)
            ? [{ ref: current.tranche.reservationRef, scope: clone(current.project.utilityReservation) }] : [];
        })(),
      ];
      // What each anchor in the ring answered. Kept per anchor rather than
      // collapsed, because which anchor said what is the finding: a ring where
      // one end reports no frontage is a Road problem at that end, and a ring
      // where every anchor reports the same non-Road absence is a finding about
      // the land use.
      const absences: Array<{ anchor: SpatialPoint2; absence: GrowableFrontageAbsenceReport; detail: SpatialSiteDetail }> = [];
      let unprovenAnchors = 0;
      let selectedAnchor: { anchor: SpatialPoint2; detail: SpatialSiteDetail; candidates: Gate1BoundedSiteCandidate[] } | null = null;
      for (const anchor of anchors) {
        let capture: Awaited<ReturnType<V2ProjectAdmissionObservationPort["captureSiteDetail"]>>;
        try {
          capture = await options.observation.captureSiteDetail({ x: anchor.x, z: anchor.z,
            radius: observationRadius, resolution: Math.max(24, policy.siteObservationResolution) }, signal);
        } catch {
          unprovenAnchors += 1;
          continue;
        }
        if (capture.coherence === "UNKNOWN" || !capture.detail || capture.detail.zoningCells.length === 0) {
          unprovenAnchors += 1;
          continue;
        }
        siteObservationIds.push(capture.observationId);
        const detail = capture.detail;
        const candidates = selectGrowableFrontageFootprint({ detail,
          zoneCategory, protections, maxCandidates: policy.maximumSiteCandidates })
          .filter((candidate) => {
            const footprint = boundedZoningCellSetInNativeMarquee(detail, candidate.target,
              requestedZoneCategory(zoneCategory));
            return isOwnedSpatialPoint(candidate.target.center, model) && !!footprint &&
              footprint.cells.every((cell) => isOwnedSpatialPoint({ x: cell.position.x, z: cell.position.z }, model));
          });
        if (candidates.length > 0) {
          selectedAnchor = { anchor, detail, candidates };
          break;
        }
        absences.push({ anchor, detail, absence: classifyGrowableFrontageAbsence({ detail,
          zoneCategory, protections, isOwned: (point) => isOwnedSpatialPoint(point, model),
          maxCandidates: policy.maximumSiteCandidates }) });
      }
      if (!selectedAnchor) {
        // No anchor in the ring could be read at all: unproven, never disproven.
        if (absences.length === 0) {
          throw new Error(`GROWABLE_FAST_PATH_ZONE_BLOCK_CENSUS_UNPROVEN:${JSON.stringify({
            anchors: anchors.length, unprovenAnchors }) }`);
        }
        // K01 chooses a bounded development region; it must not turn an unfronted
        // Zone Block into a precise zoning reservation that K02 has never proved
        // it can serve. Of the four reasons a region answers "no footprint", only
        // `MISSING_FRONTAGE` is a Road problem: a Road can produce a frontage
        // witness, but it cannot produce a zoning cell, cannot make the project
        // own one, and cannot free land another Goal still holds. Asking for one
        // in those cases mints a work order that can only fail.
        //
        // Read across the ring, `MISSING_FRONTAGE` at ANY anchor is a Road
        // problem — and the Road belongs at that anchor. That is the proactive
        // frontage the rolling pipeline wants: while the current district fills
        // in, the next area's Road is opened at the end of the network that has
        // none.
        // The ring is SEARCHED, not sampled at its first member.
        //
        // `MISSING_FRONTAGE` at any anchor is a Road problem, and each such anchor
        // is a different place to open the Road from. Asking only the first was
        // measured live (2026-10-01) as every growth domain requesting the same
        // 94.8 m course and native refusing all of it — while another anchor in
        // the same ring planned a 45 m hop native certifies. The planner decides
        // the route; this loop is the bounded search over where it leaves the
        // network, and native is the authority on whether that route can be built
        // where it runs.
        //
        // A corridor that refused, or could not read the ground it needed, says
        // nothing about the NEXT anchor, so it moves on. Only when every anchor
        // in the ring has answered does that become a finding about the ring —
        // and then it parks, because the subject key is derived from the ring, so
        // the Mayor's own next Road releases it.
        const frontageAnchors = absences.filter((entry) => entry.absence.reason === "MISSING_FRONTAGE");
        if (frontageAnchors.length > 0) {
          let parkTarget: { center: SpatialPoint2; radius: number } | null = null;
          let refusal = "no anchor in the ring offered a Road course";
          for (const withoutFrontage of frontageAnchors) {
            const zoneCells = withoutFrontage.detail.zoningCells.filter((cell) => cell.visible && !cell.occupied &&
              !cell.blocked && !cell.overridden && cell.zoneCategory === "none");
            // The Road belongs where the frontage is missing. The classifier names
            // that ground when it found it, and it is not the centroid of every
            // clean cell the anchor holds: measured live (2026-10-01), the two
            // were 32 m to 152 m apart across one ring, and a road that lands
            // outside the block it was meant to open frontage for opens nothing.
            // No fallback to the anchor itself. `from === to` is not a corridor
            // question, and asking it produced `ALREADY_REACHED: the target is
            // 0.0m away, inside one cell` — a fabricated failure that reads like
            // a finding about the land while proving nothing. An anchor with no
            // named unfronted land is one this Road cannot serve, which is the
            // same answer the two `continue`s below already give: this anchor
            // offers no course, try the next one.
            const cleanCenter = zoneCells.length > 0 ? {
              x: zoneCells.reduce((sum, cell) => sum + cell.position.x, 0) / zoneCells.length,
              z: zoneCells.reduce((sum, cell) => sum + cell.position.z, 0) / zoneCells.length,
            } : null;
            const landCenter = withoutFrontage.absence.missingFrontage?.center ??
              goalMetadata?.targetPoint ?? cleanCenter;
            if (!landCenter) {
              refusal = `no named unfronted land at (${withoutFrontage.anchor.x.toFixed(1)}, ` +
                `${withoutFrontage.anchor.z.toFixed(1)}): nothing for a Road to open`;
              continue;
            }
            parkTarget = parkTarget ?? { center: landCenter,
              radius: withoutFrontage.absence.missingFrontage?.radius ?? 0 };
            // The Road step is asked for ONE legal hop on a PLANNED route to that
            // land, not for the land itself. Handing over the far point is what
            // let three prerequisites for one target be admitted 265 m, 274 m and
            // 710 m away and build three roads that served none of it.
            const corridorHop = await corridorFirstHopTarget({
              world: model, observation: options.observation,
              from: withoutFrontage.anchor, to: landCenter, ...(signal ? { signal } : {}),
            });
            if (corridorHop.kind !== "planned") {
              refusal = `corridor ${corridorHop.kind} from (${withoutFrontage.anchor.x.toFixed(1)}, ` +
                `${withoutFrontage.anchor.z.toFixed(1)}): ${corridorHop.reason}`;
              continue;
            }
            // The planner's own courses, in its own order, certified one by one.
            // The caller adds nothing to the plan and takes nothing away from it:
            // it asks native which of the planner's exits it will build, and
            // binds the first it certifies. When none certifies, the exit the
            // planner chose is not one native accepts, and this anchor has no
            // course to offer — which is a finding about the entrance, not an
            // invitation to plan the route a different way.
            let bound: { start: SpatialPoint2; end: SpatialPoint2 } | null = null;
            const refusals: string[] = [];
            for (const candidate of corridorHop.courses) {
              if (await compiledHopVerdict(candidate, signal) !== "refused") { bound = candidate; break; }
              refusals.push(`${Math.hypot(candidate.end.x - candidate.start.x, candidate.end.z - candidate.start.z).toFixed(1)}m` +
                `@${(Math.atan2(candidate.end.z - candidate.start.z, candidate.end.x - candidate.start.x) * 180 / Math.PI).toFixed(0)}deg`);
            }
            if (!bound) {
              refusal = `native refused every course the corridor compiled from ` +
                `(${withoutFrontage.anchor.x.toFixed(1)}, ${withoutFrontage.anchor.z.toFixed(1)}): ${refusals.join(", ")}`;
              continue;
            }
            throw new V2GoalPrerequisiteRequiredError({
              kind: "ROAD_FRONTAGE",
              targetPoint: { x: bound.end.x, z: bound.end.z },
              // The compiled segment travels with the step. `targetPoint` is its
              // far end; this is the whole course, so the Road step that commits
              // it builds the segment the planner chose rather than a straight
              // line from whichever node happens to sit nearest that end.
              roadCourse: { start: { x: bound.start.x, z: bound.start.z },
                end: { x: bound.end.x, z: bound.end.z } },
              completionStage: "ROAD_DELIVERED",
              evidence: `coherent owned Zone Block census has no productive Road frontage at ` +
                `(${withoutFrontage.anchor.x.toFixed(1)}, ${withoutFrontage.anchor.z.toFixed(1)}); a native-certified ` +
                `${Math.hypot(bound.end.x - bound.start.x, bound.end.z - bound.start.z).toFixed(1)}m corridor hop ` +
                `(course ${corridorHop.courses.indexOf(bound) + 1} of ${corridorHop.courses.length}) ` +
                `delivers frontage before selecting a zoning footprint`,
            });
          }
          throw new V2GrowableFootprintUnserviceableError({
            reason: "MISSING_FRONTAGE", evidence: mergeGrowableAbsenceReports(absences.map((entry) => entry.absence)),
            target: parkTarget ?? { center: ringCenter(anchors), radius: ringRadius(anchors, observationRadius) },
            subjectKey: growableSearchSubjectKey(anchors, goalLandUse, unprovenAnchors),
            detail: refusal,
          });
        }
        // Every anchor in the ring was read and every one of them refused, for a
        // reason a Road cannot answer. This is now a finding about the ground the
        // search actually covered, and the subject key is derived from that ring
        // — so the Mayor's own next Road changes the anchor set, which changes
        // this key, which releases the park. Nothing else has to remember to.
        const evidence = mergeGrowableAbsenceReports(absences.map((entry) => entry.absence));
        const target = { center: ringCenter(anchors), radius: ringRadius(anchors, observationRadius) };
        throw new V2GrowableFootprintUnserviceableError({
          reason: evidence.reason, evidence, target,
          subjectKey: growableSearchSubjectKey(anchors, goalLandUse, unprovenAnchors),
        });
      }
      const { detail, candidates } = selectedAnchor;
      search = {
        anchorClass: "OWNED_LOCAL_ROAD_TOPOLOGY", fallbackReason: null,
        selection: { candidates, rejections: { NOT_OWNED: 0, OUTSIDE_ANCHOR_OBSERVATION: 0, NOT_BUILDABLE: 0, NO_ACCESS: 0, NO_ROUTE: 0,
          WATER: 0, TERRAIN: 0, PROTECTION_RESERVATION: 0, ZONEABLE_FRONTAGE: 0,
          OUTSIDE_PROJECT_SCOPE: 0, TARGET_NOT_ADVANCED: 0, UNKNOWN: 0, OTHER: 0 }, inspectedRegions: anchors.length },
        local: { anchors: anchors.length, observations: anchors.length,
          candidates: candidates.length, accepted: candidates.length }, ingress: null,
      };
    } else {
      search = await searchBoundedStarterSites({
      world: model,
      worldEpoch: world.worldEpochId,
      bridgeGeneration: world.generation,
      availableRoadPrefabs,
      ...(roadGoalSearchTarget ? { targetPoint: roadGoalSearchTarget } : {}),
      // A standalone Road Goal names no destination: its "target" is the grid-frame reference, which orders the
      // anchors and must not require every step to get closer to it.
      ...(roadGoalSearchTarget && roadOnlyGoal && !frontagePrerequisite && !goalMetadata?.targetPoint
        ? { targetIsReferenceOnly: true } : {}),
      ...(goalMetadata?.targetPoint && goalMetadata.completionStage === "ROAD_DELIVERED"
        ? { allowGenericRoadFallback: true } : {}),
      ...(goalDirectedRoadSearch ? {
        goalWorkOrderAnchors: selectGoalWorkOrderSiteAnchors(model, maximumSiteAnchors,
          roadGoalSearchTarget, availableRoadPrefabs),
      } : {}),
      ...(goalMetadata?.completionStage === "ROAD_DELIVERED" ? { includeIngressFallback: false } : {}),
      ...(roadOnlyGoal ? { roadDelivery: true } : {}),
      // Every unfinished goal keeps its own admitted reservation. A FOREIGN
      // successor must find a distinct scope rather than silently reuse or
      // overlap an earlier work order's authorization envelope. A Goal's own
      // bounded steps are not foreign to it: a prerequisite corridor has to be
      // allowed to continue across the land its own earlier step just reserved,
      // otherwise the first Road prerequisite of a Goal silently vetoes the
      // second one and the Goal can never reach the resource it was admitted for.
      ...(goalWorkOrderId ? { protections: [
        ...((durability.snapshot().goalWorkOrders ?? [])
          .filter((item) => durability.isGoalWorkOrderReservationProtected(item.workOrderId) &&
            !goalFamilyGoalIds.has(item.goalId))
          .map((item) => ({ ref: item.reservationRef, scope: clone(item.state.project.utilityReservation) }))),
        ...(() => {
          const current = durability.projectState();
          return current.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && current.project.status !== "COMPLETE" &&
            !(durability.snapshot().goalWorkOrders ?? []).some((item) => item.projectId === current.project.id)
            ? [{ ref: current.tranche.reservationRef, scope: clone(current.project.utilityReservation) }]
            : [];
        })(),
        // A standalone Road Goal does not re-pick a site the world has already refused every course at.
        ...(roadOnlyGoal && !frontagePrerequisite ? unservableRoadSiteExclusions(durability.snapshot().goalWorkOrders ?? []) : []),
      ] } : {}),
      maxAnchors: maximumSiteAnchors,
      maxCandidates: policy.maximumSiteCandidates,
      captureDetail: async (anchor, captureSignal) => {
        let captured: Awaited<ReturnType<NonNullable<V2ProjectAdmissionObservationPort["captureSiteDetail"]>>>;
        try {
          captured = await options.observation.captureSiteDetail(
            {
              x: anchor.node.position.x,
              z: anchor.node.position.z,
              radius: policy.siteObservationRadiusMeters,
              resolution: policy.siteObservationResolution,
            },
            captureSignal,
          );
        } catch {
          zoneCensusUnproven += 1;
          return { detail: null, coherence: "UNKNOWN", observationId: "unavailable" };
        }
        if (captured.coherence === "UNKNOWN" || captured.detail === null || captured.detail.zoningCells.length === 0) {
          zoneCensusUnproven += 1;
        }
        if (captured.coherence !== "UNKNOWN" && captured.detail !== null) siteObservationIds.push(captured.observationId);
        return captured;
      },
      ...((!roadOnlyGoal || siteConstraint || options.previewRoad) ? {
        accepts: async (candidate: Gate1BoundedSiteCandidate, acceptSignal?: AbortSignal) => {
          if (roadOnlyGoal && candidate.roadCandidates.length === 0) return false;
          return (roadOnlyGoal || await zoneable(candidate, acceptSignal)) &&
            await acceptCandidate(candidate, acceptSignal) &&
            await roadBuildable(candidate, acceptSignal);
        },
      } : {}),
      signal,
      });
    }
    const selected = search.selection.candidates[0];
    if (!selected) {
      const anchorsConsidered = search.local.anchors + (search.ingress?.anchors ?? 0);
      if (anchorsConsidered === 0) throw new Error("PROJECT_ADMISSION_NO_STARTER_ANCHOR");
      if (zoneCensusUnproven > 0) {
        // Which Goal this happened to leads the payload, because the policy's
        // own `message()` bound keeps only the first 300 characters: the counts
        // that follow are unreadable in the live status if the identity is not
        // first. Reaching this throw at all means the Goal was NOT answered by
        // its own growable ring (that branch cannot get here), so the three
        // inputs its `growableGoal` test reads are named: a growth Goal judged by
        // the generic bounded search is a different fact from a world that
        // offered no candidate, and the two are fixed in different places.
        throw new Error(`PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN:${JSON.stringify({
          goalId: goalWorkOrderId ?? null, landUse: goalLandUse ?? null,
          parentGoalId: goalMetadata?.parentGoalId ?? null,
          zoneCensusUnproven, zoneGateRefusals, anchors: search.local.anchors,
          observations: search.local.observations, rejections: search.selection.rejections,
        })}`);
      }
      if (search.selection.inspectedRegions === 0) throw new Error("PROJECT_ADMISSION_SITE_OBSERVATION_UNKNOWN");
      // A constraint that rejected every candidate at every radius is a
      // different fact from a world that offered no candidate: the world may be
      // full of sites, none of which this project's own domain can be served
      // from. Reported separately so the caller does not go looking for terrain
      // that is not missing.
      if (siteConstraint) {
        const prerequisite = await siteConstraint.derivePrerequisite?.();
        if (prerequisite && goalWorkOrderId) throw new V2GoalPrerequisiteRequiredError(prerequisite);
        // Domain candidate generation can itself require a fact supplied by a
        // prerequisite. Ask the typed provider even when it produced zero
        // candidates; zero is not evidence that the domain has no viable site.
        // If it cannot derive a bounded prerequisite from authoritative reads,
        // preserve the ordinary no-site result below.
        const evaluatedCandidates = search.local.candidates + (search.ingress?.candidates ?? 0);
        // Carry WHY nothing was eligible. "No eligible site" on its own cannot
        // be acted on: a world that owns no frontage, a world whose anchors were
        // never observed, and a world whose every candidate failed one specific
        // legality test are three different problems with three different
        // answers, and the caller can only tell them apart if this says so.
        const refusal = JSON.stringify({
          anchors: search.local.anchors, observations: search.local.observations,
          anchorClass: search.anchorClass, fallbackReason: search.fallbackReason,
          rejections: search.selection.rejections,
        });
        if (evaluatedCandidates === 0) throw new Error(`PROJECT_ADMISSION_NO_ELIGIBLE_SITE:${refusal}`);
        throw new Error(`PROJECT_ADMISSION_NO_VALID_SITE:${refusal}`);
      }
      // A standalone Road Goal that found no site around the network's own nodes has exhausted the ground the
      // network can see, which is not the same as exhausting the ground the city owns. Survey the owned tiles
      // for flat open land and walk a corridor toward it with the same ROAD_FRONTAGE step a growth Goal uses.
      let frontierRefusal = "";
      if (roadOnlyGoal && !frontagePrerequisite && !goalMetadata?.targetPoint && goalWorkOrderId) {
        const frontier = await surveyFrontierLand();
        frontierRefusal = `frontier=${frontier.length}`;
        for (const patch of frontier) {
          const hop = await corridorFirstHopTarget({ world: model, observation: options.observation,
            from: patch.from, to: patch.center, ...(signal ? { signal } : {}) });
          if (hop.kind !== "planned") { frontierRefusal += `;${hop.kind}`; continue; }
          let bound: { start: SpatialPoint2; end: SpatialPoint2 } | null = null;
          for (const candidate of hop.courses) {
            if (await compiledHopVerdict(candidate, signal) !== "refused") { bound = candidate; break; }
          }
          if (!bound) { frontierRefusal += ";native_refused"; continue; }
          throw new V2GoalPrerequisiteRequiredError({
            kind: "ROAD_FRONTAGE",
            targetPoint: { x: bound.end.x, z: bound.end.z },
            roadCourse: { start: { x: bound.start.x, z: bound.start.z }, end: { x: bound.end.x, z: bound.end.z } },
            completionStage: "ROAD_DELIVERED",
            evidence: `no owned ground around the road network can take a new street; flat open owned land ` +
              `(${patch.sideMeters.toFixed(0)} m patch) lies ${patch.distanceToNetwork.toFixed(0)} m from the network at ` +
              `(${patch.center.x.toFixed(0)}, ${patch.center.z.toFixed(0)}); a native-certified ` +
              `${Math.hypot(bound.end.x - bound.start.x, bound.end.z - bound.start.z).toFixed(0)} m corridor hop leaves toward it`,
          });
        }
      }
      throw new Error(`PROJECT_ADMISSION_NO_ELIGIBLE_SITE:NO_PROJECT_CONSTRAINT:${frontierRefusal}:${JSON.stringify({
        anchors: search.local.anchors, observations: search.local.observations,
        candidates: search.local.candidates,
        // Only the non-zero counts: the full histogram is mostly zeros and the status bound cut the
        // informative tail off, so the refusal reported a search that rejected nothing and found nothing.
        rejections: Object.fromEntries(Object.entries(search.selection.rejections).filter(([, count]) => count > 0)),
        // Named separately from the evaluator's own rejections: the admission
        // gates refuse a candidate the evaluator had already ACCEPTED, and the
        // evaluator even names them as usable 鈥?a frontage-less site keeps its
        // `ZONEABLE_FRONTAGE` rejection AND still appears as a candidate. A
        // reader who only had the evaluator's counters would see eligible sites
        // disappear.
        roadGateRefusals, zoneGateRefusals,
      })}`);
    }
    const selectedRadius = growableGoal
      ? selected.target.radius
      : reservationRadiusByCandidate.get(selected.id) ?? policy.planningEnvelopeRadiusMeters;
    // What this project's own utility plan costs, asked before the identity is
    // persisted rather than after. A domain that declares no requirement leaves
    // the policy budget exactly as it was, which is what keeps a constraint-free
    // admission byte-identical.
    const requirement = siteConstraint?.minimumFeasibleBudget
      ? await siteConstraint.minimumFeasibleBudget(selected, selectedRadius, signal)
      : null;
    const funded = fundStarterProjectBudget({ policyBudget: budget, requirement });

    const intentInput: StarterResidentialIntentInput = {
      intentId,
      targetResidents: policy.targetResidents,
      maximumBudget: funded.maximumBudget,
      planningEnvelope: { center: clone(selected.target.center), radius: selectedRadius },
      siteCandidates: search.selection.candidates.map((candidate) => ({
        id: candidate.id,
        target: clone(candidate.target),
        score: candidate.score,
        blocked: candidate.blocked,
      })),
      starterDirection: clone(selected.direction),
      maximumWaitObservations: policy.maximumWaitObservations,
      ...(goalWorkOrderId && goalLandUse ? { landUse: goalLandUse } : {}),
      // What this scope delivers is what its work order says it delivers, and
      // its ladder is built to reach exactly that. A scope whose deliverable is
      // the delivered road has no zoning, building or occupancy semantics, so it
      // does not carry those tasks.
      ...(goalWorkOrderId ? { deliverable: goalMetadata?.completionStage === "ROAD_DELIVERED"
        ? "ROAD_DELIVERED" as const : "OCCUPIED" as const } : {}),
    };
    const state = planStarterResidentialIntent(intentInput, now());

    // The only durable write path for a Gate 1 state. The coordinator rejects
    // the write when the world is not durably activated or is blocked.
    if (goalWorkOrderId) durability.activateGoalWorkOrder({ goalId: goalWorkOrderId, state,
      ...(goalMetadata?.parentGoalId ? { parentGoalId: goalMetadata.parentGoalId } : {}),
      ...(goalMetadata?.parentLandUse ? { parentLandUse: goalMetadata.parentLandUse } : {}),
      ...(goalMetadata?.targetPoint ? { targetPoint: goalMetadata.targetPoint } : {}),
      ...(goalMetadata?.roadCourse ? { roadCourse: goalMetadata.roadCourse } : {}),
      ...(goalMetadata?.completionStage ? { completionStage: goalMetadata.completionStage } : {}),
    });
    else createDurableGate1StateStorage(durability).save(state);
    const persisted = durability.projectState();
    if (persisted.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION || persisted.project.id !== state.project.id) {
      throw new Error("PROJECT_ADMISSION_PERSISTENCE_UNVERIFIED");
    }
    // The reserved envelope is the whole point of the radius search, and it is
    // the value every later utility execution is checked against. Verified here
    // rather than trusted, so a reservation that is not the one admission
    // justified can never reach a durable state.
    const reserved = persisted.project.utilityReservation;
    if (reserved.radius !== selectedRadius || reserved.center.x !== selected.target.center.x || reserved.center.z !== selected.target.center.z) {
      throw new Error("PROJECT_ADMISSION_RESERVATION_UNVERIFIED");
    }

    // The planned segment becomes this scope's Road task's exact child
    // operation.
    //
    // Gate 1 already owns the machine for this: a task that carries a
    // `childOperationAmendmentId` is dispatched with that exact course as its
    // only candidate (`gate1-progression-boundary.ts` `preflightRoad`), spends
    // it exactly once, and cannot substitute another. Without it the Road step
    // reproduces a course from the world instead — the second planner — which is
    // why the planned segment was never the segment that got built.
    const frontageCourseBound = frontagePrerequisite && goalMetadata?.roadCourse
      ? attachPlannedCourseChildOperation({
        durability, state: persisted, world, goalWorkOrderId,
        course: goalMetadata.roadCourse,
        availableRoadPrefabs,
        journalCut: durability.snapshot().active?.activatedCheckpointJournalCut,
      })
      : false;

    return {
      status: "ADMITTED",
      state: persisted,
      evidence: {
        worldId: world.worldId,
        baselineCheckpointId,
        intentId: persisted.intent.id,
        projectId: persisted.project.id,
        trancheId: persisted.tranche.id,
        reservationRef: persisted.tranche.reservationRef,
        selectedCandidateId: selected.id,
        // Whether the planned course became this scope's exact one-shot child
        // operation, or only travelled on the work order. Named rather than left
        // to be inferred from the durable record, because the two are not the
        // same promise.
        ...(frontagePrerequisite ? { roadCourseChildOperationBound: frontageCourseBound } : {}),
        roadGridCandidateCount: selected.roadCandidates.filter((candidate) => candidate.family === "ORTHOGONAL_GRID").length,
        nativeRoadPreviewCount,
        nativeRoadPreviewRejectedCount,
        anchorClass: search.anchorClass,
        anchorFallbackReason: search.fallbackReason,
        inspectedRegions: search.selection.inspectedRegions,
        eligibleCandidates: search.selection.candidates.length,
        observedTreasury: treasury,
        treasuryShareLimit: budget.treasuryShareLimit,
        maximumBudget: funded.maximumBudget,
        budgetBound: funded.budgetBound,
        policyMaximumBudget: budget.maximumBudget,
        requiredUtilityBudget: funded.requiredUtilityBudget,
        utilityBudgetRequirement: requirement ? clone(requirement) : null,
        reservationRadiusMeters: reserved.radius,
        reservationRadiusLadder,
        siteObservationIds,
      },
    };
  }

  return {
    admitFirstProject: admit,
    setPace(pace) { applyPace(pace); },
    activeGoalWorkOrder() {
      const snapshot = options.durability.snapshot();
      return snapshot.goalWorkOrders?.find((item) => item.workOrderId === snapshot.activeGoalWorkOrderId) ?? null;
    },
    goalWorkOrders() { return options.durability.snapshot().goalWorkOrders ?? []; },
    completeGoalWorkOrder(goalId) { return options.durability.completeGoalWorkOrder(goalId); },
    recordGate1ProgressionOutcome(input) {
      return options.durability.recordGoalWorkOrderProgressionOutcome(input);
    },
    async ensureFirstProject(signal) {
      const existing = options.durability.projectState();
      if (existing.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION) {
        return { status: "ALREADY_ADMITTED", state: existing };
      }
      // The world is the authority (2026-10-02). A placeholder project state
      // means this store holds no project for the loaded world — including
      // right after a Load re-baselined the branch — so the first project is
      // planned against the world as it is now. There is no seam that mints a
      // state from an inherited journal: that authority was retired with the
      // quarantine it served.
      return admit(signal);
    },
    async ensureGoalWorkOrder(input, signal) {
      // A Goal whose work order has closed resolves to its successor, so the
      // same request is satisfied from current facts instead of being refused
      // for naming a scope that was already given up. The closed work order is
      // left exactly as it is: it is the durable history of what happened, and
      // the successor takes its own site, reservation and budget.
      const goalId = resolveGoalWorkOrderId((id) => options.durability.goalWorkOrder(id), input.goalId);
      // The Goal's own deliverable, whether or not this call carried it. A Goal
      // is admitted more than once, and the second admission often names it by id
      // alone: a bounded prerequisite completes and the parent is resumed with
      // `ensureGoalWorkOrder(active.parentGoalId)`, which creates the parent's
      // record for the first time and would otherwise leave it indistinguishable
      // from a residential one.
      const completionStage = input.completionStage ?? goalCompletionStageForGoalId(goalId);
      const existing = options.durability.goalWorkOrder(goalId);
      if (existing) {
        const state = options.durability.activateGoalWorkOrder({ goalId,
          ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
          ...(input.targetPoint ? { targetPoint: input.targetPoint } : {}),
          ...(completionStage ? { completionStage } : {}),
        });
        return { status: "ALREADY_ADMITTED", state };
      }
      const identity = (workOrderGoalId: string) => (world: NativeWorldIdentity, baselineCheckpointId: string) => {
        const branchResolver = (options.durability as V2DurabilityCoordinator & { executionBranchId?: () => string | null }).executionBranchId;
        const executionBranchId = branchResolver
          ? branchResolver.call(options.durability)
          : `${world.worldId}:${baselineCheckpointId}`;
        if (!executionBranchId) throw new Error("PROJECT_ADMISSION_EXECUTION_BRANCH_NOT_ACTIVE");
        return deriveGoalWorkOrderIntentId({ worldId: world.worldId, baselineCheckpointId, executionBranchId, goalId: workOrderGoalId });
      };
      try {
        return await admitProject(identity(goalId), signal, goalId, input.siteConstraint, input.landUse,
          { parentGoalId: input.parentGoalId, targetPoint: input.targetPoint, completionStage });
      } catch (error) {
        if (!(error instanceof V2GoalPrerequisiteRequiredError) || input.parentGoalId) throw error;
        const prerequisite = error.prerequisite;
        const priorPrerequisites = (options.durability.snapshot().goalWorkOrders ?? [])
          .filter((item) => item.parentGoalId === goalId);
        // A corridor's step number counts the steps it DELIVERED, not the times
        // it was attempted.
        //
        // Counting attempts gave an unsatisfiable prerequisite an unbounded
        // supply of fresh identities: each re-derivation differed only by its
        // step number, so the parent Goal was always "successfully" re-admitted
        // into another bounded work order that could not build anything. One
        // cycle spent sixteen of them, each a new claim on land, and the Goal
        // that raised them never reached a decision of its own. Counting
        // delivered steps makes a repeated derivation name the SAME step, which
        // is the truth about it, and the check below turns that into the parent
        // Goal's decision instead of another attempt.
        const delivered = priorPrerequisites.filter((item) => goalWorkOrderReachedMilestone(item));
        if (delivered.length >= MAXIMUM_GOAL_PREREQUISITE_STEPS) {
          throw new Error(`GOAL_PREREQUISITE_STEP_BUDGET_EXHAUSTED:${goalId}`);
        }
        const step = delivered.length + 1;
        // The planned course is part of the step's identity, not decoration: a
        // different plan for the same far point is a different step, and naming
        // it by the far point alone would let a re-planned route re-use a step
        // that was already spent on a different course.
        const fingerprint = createHash("sha256").update(JSON.stringify([goalId, prerequisite.kind,
          prerequisite.targetPoint?.x ?? null, prerequisite.targetPoint?.z ?? null,
          prerequisite.roadCourse?.start.x ?? null, prerequisite.roadCourse?.start.z ?? null, step])).digest("hex").slice(0, 16);
        const childGoalId = `${goalId}:prerequisite:${prerequisite.kind}:${step}:${fingerprint}`;
        // This corridor already asked for exactly this step and it is over. The
        // parent Goal is the one that decides what happens next 鈥?carry on with a
        // different step, park, or let the growth policy choose another Goal 鈥?        // and it can only make that decision if this refuses rather than minting
        // a duplicate. A prerequisite whose derivation has genuinely changed
        // (a different kind, a different target point, or the next delivered
        // step) has a different identity and is admitted normally.
        const spent = options.durability.goalWorkOrder(childGoalId);
        if (spent && goalWorkOrderChainClosed(spent)) {
          throw new Error(`GOAL_PREREQUISITE_ALREADY_SPENT:${childGoalId}`);
        }
        const child = await admitProject(identity(childGoalId), signal, childGoalId, undefined, undefined, {
          parentGoalId: goalId, parentLandUse: input.landUse, targetPoint: prerequisite.targetPoint,
          ...(prerequisite.roadCourse ? { roadCourse: prerequisite.roadCourse } : {}),
          completionStage: prerequisite.completionStage, skipSiteConstraint: true,
        });
        return { status: "PREREQUISITE_ADMITTED", state: child.state, requestedGoalId: goalId,
          activeGoalId: childGoalId, prerequisite };
      }
    },
    async replanForCurrentBranch({ detail }, signal) {
      const existing = options.durability.projectState();
      if (existing.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        throw new Error("PROJECT_REPLAN_NO_ADMITTED_PROJECT");
      }
      if (!options.siteConstraint) throw new Error("PROJECT_REPLAN_SITE_CONSTRAINT_REQUIRED");
      const activation = await options.activateDurableWorld(signal);
      if (activation.blockedReason) throw new Error(activation.blockedReason);
      if (!options.durability.isExecutionDurablyActivated(activation)) {
        throw new Error(`${activation.status}: current-branch project replan requires durable activation`);
      }
      // The branch this replan is for, read as its own rollback boundary rather
      // than as the save the world was loaded from: a city started fresh has no
      // loaded checkpoint and its baseline boundary is nonetheless certified, and
      // its replan identity has to be derivable for the same reason any other
      // exact operation's is. The store proves the boundary, the cut and the
      // activated world; this only checks the activation we were handed agrees.
      const branch = options.durability.currentBranchCheckpoint();
      if (!branch || branch.worldId !== activation.world.worldId || branch.generation !== activation.world.generation) {
        throw new Error("PROJECT_REPLAN_CURRENT_CHECKPOINT_CUT_UNPROVEN");
      }
      const checkpoint = options.durability.snapshot().checkpoints.find(
        (entry) => entry.worldId === branch.worldId && entry.checkpointId === branch.checkpointId,
      );
      if (!checkpoint?.durable || checkpoint.journalPosition !== branch.journalCut) {
        throw new Error("PROJECT_REPLAN_CHECKPOINT_CUT_MISMATCH");
      }
      const branchIdentity: V2ProjectBranchIdentity = { worldId: branch.worldId, checkpointId: branch.checkpointId, journalCut: branch.journalCut };
      const identity = deriveCurrentBranchProjectReplanIdentity(branchIdentity);
      let replan = options.durability.supersededProjects().find(
        (entry) => entry.reason === "CURRENT_BRANCH_REPLAN" && entry.replanId === identity.replanId,
      );
      if (replan?.replacementProjectId === existing.project.id) {
        return { status: "ALREADY_REPLANNED", replan, state: existing };
      }
      if (replan?.replacementProjectId === null && existing.intent.id === identity.intentId) {
        const linked = options.durability.linkProjectSupersessionReplacement(replan.supersessionId, existing.project.id);
        return { status: "ALREADY_REPLANNED", replan: linked, state: existing };
      }
      if (replan && replan.projectId !== existing.project.id && replan.replacementProjectId !== existing.project.id) {
        throw new Error("PROJECT_REPLAN_BRANCH_ALREADY_SPENT");
      }
      if (!replan) {
        const candidate: Gate1BoundedSiteCandidate = {
          id: `current-project:${existing.project.id}`,
          target: clone(existing.project.utilityReservation),
          score: 0,
          blocked: false,
          direction: clone(existing.districtPlan.direction),
          roadCandidates: [],
          evidence: {
            sourceAnchor: clone(existing.project.utilityReservation.center),
            openResidentialCells: 0,
            owned: true,
            buildable: true,
            access: "BOUNDED_ROAD_FEASIBLE",
          },
        };
        let stillAdmissible: boolean;
        try {
          stillAdmissible = await options.siteConstraint.accepts(candidate, existing.project.utilityReservation.radius, signal);
        } catch (error) {
          throw new Error(`PROJECT_REPLAN_CURRENT_ADMISSION_UNPROVEN:${error instanceof Error ? error.message : String(error)}`);
        }
        if (stillAdmissible) throw new Error("PROJECT_REPLAN_CURRENT_PROJECT_STILL_VALID");
        replan = options.durability.recordProjectSupersession({
          supersessionId: identity.replanId,
          replanId: identity.replanId,
          branch,
          projectId: existing.project.id,
          intentId: existing.intent.id,
          trancheId: existing.tranche.id,
          reservationRef: existing.tranche.reservationRef,
          supersededState: existing,
          reason: "CURRENT_BRANCH_REPLAN",
          detail,
        });
      }
      const result = await admitProject(() => identity.intentId, signal);
      if (result.status !== "ADMITTED") throw new Error("PROJECT_REPLAN_ADMISSION_NOT_CREATED");
      const linked = options.durability.linkProjectSupersessionReplacement(replan.supersessionId, result.state.project.id);
      return { status: "REPLANNED", replan: linked, state: result.state, evidence: result.evidence };
    },
    async supersedeAndReplaceFirstProject({ reason, detail }, signal) {
      const existing = options.durability.projectState();
      if (existing.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        throw new Error("PROJECT_REPLACEMENT_NO_SUPERSEDABLE_PROJECT");
      }
      // Activation is checked before the supersession is written, so a durable
      // history record is only ever created against a world this store is
      // actually executing in.
      const activation = await options.activateDurableWorld(signal);
      if (activation.blockedReason) throw new Error(activation.blockedReason);
      if (!options.durability.isExecutionDurablyActivated(activation)) {
        throw new Error(`${activation.status}: project replacement requires a durably activated world`);
      }
      // The supersession is written first, so the invalid admission is on the
      // record even if the replacement that follows is refused. If it is, the
      // store says exactly what is true: this project's admission does not hold,
      // and nothing has replaced it.
      const supersession = options.durability.recordProjectSupersession({
        supersessionId: `${existing.project.id}:superseded`,
        projectId: existing.project.id,
        intentId: existing.intent.id,
        trancheId: existing.tranche.id,
        reservationRef: existing.tranche.reservationRef,
        supersededState: existing,
        reason,
        detail,
      });
      const intentId = deriveReplacementStarterProjectIntentId({
        supersededIntentId: existing.intent.id,
        reason,
      });
      const result = await admitProject(() => intentId, signal);
      if (result.status !== "ADMITTED") throw new Error("PROJECT_REPLACEMENT_NOT_ADMITTED");
      return {
        status: "REPLACED",
        supersession: options.durability.linkProjectSupersessionReplacement(
          supersession.supersessionId,
          result.state.project.id,
        ),
        state: result.state,
        evidence: result.evidence,
      };
    },
    async repairAdmissionSemantics({ semanticsRevision, evidence, mutation, detail }, signal) {
      const existing = options.durability.projectState();
      if (existing.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        throw new Error("PROJECT_SEMANTIC_REPAIR_NO_DURABLE_PROJECT");
      }
      // Activation is checked before anything is recorded, so a durable history
      // record is only ever appended against a world this store is actually
      // executing in.
      const activation = await options.activateDurableWorld(signal);
      if (activation.blockedReason) throw new Error(activation.blockedReason);
      if (!options.durability.isExecutionDurablyActivated(activation)) {
        throw new Error(`${activation.status}: admission semantic repair requires a durably activated world`);
      }

      // The identity is computed from durable records only. Both relationship
      // tables are consulted because a repair may itself have been replaced
      // later, and a root that stopped at the first hop would let each hand-off
      // start a fresh repair chain under a fresh key.
      const supersessions = options.durability.supersededProjects();
      const repairs = options.durability.admissionSemanticRepairs();
      const rootProjectId = resolveAdmissionLineageRoot({
        currentProjectId: existing.project.id,
        supersessions,
        repairs,
      });
      const repairId = deriveAdmissionSemanticRepairId({ rootProjectId, semanticsRevision });

      const recorded = repairs.find((entry) => entry.repairId === repairId);
      if (recorded) {
        // The identity is spent, and resuming is only safe while the durable slot
        // is still the project this repair named. Anything else means the repair
        // was re-minted under an identity it had already used.
        if (recorded.repairProjectId === null) throw new Error("PROJECT_SEMANTIC_REPAIR_NOT_ADMITTED");
        if (recorded.repairProjectId !== existing.project.id) {
          throw new Error("PROJECT_SEMANTIC_REPAIR_ALREADY_SPENT");
        }
        return { status: "ALREADY_REPAIRED", repair: recorded, state: existing };
      }

      // "Utility native spend or mutation has not happened yet" is what makes a
      // repair a re-decision rather than a re-write. A facility or pipe already
      // in the world was built under the old semantics; replacing the project
      // afterwards would leave that effect unowned by any durable identity.
      const placement = mutation.firstFacilityPlacement.status;
      if (placement !== "NONE" && placement !== "TERMINAL_NO_MUTATION") {
        throw new Error(`PROJECT_SEMANTIC_REPAIR_UTILITY_MUTATION_ALREADY_HAPPENED:${placement}`);
      }
      if (mutation.submittedCommandIds.length > 0) {
        throw new Error("PROJECT_SEMANTIC_REPAIR_UTILITY_MUTATION_ALREADY_HAPPENED:DURABLE_UTILITY_JOURNAL");
      }

      // Both halves of the replay, checked before the record is appended: an old
      // project that is still valid, or a new plan missing any verdict, is a
      // refusal rather than a repair.
      assertAdmissionSemanticsReplayEvidence(evidence, {
        projectId: existing.project.id,
        semanticsRevision,
      });

      const rootIdentity = resolveAdmissionLineageRootIdentity({
        rootProjectId,
        current: existing,
        supersessions,
      });

      // Written first, so the invalid-by-rule admission is on the record even if
      // the project that follows is refused. If it is, the store says exactly
      // what is true: this admission does not hold under the current semantics,
      // and nothing has replaced it.
      const repair = options.durability.recordAdmissionSemanticRepair({
        repairId,
        rootProjectId,
        rootIntentId: rootIdentity.intentId,
        rootTrancheId: rootIdentity.trancheId,
        rootReservationRef: rootIdentity.reservationRef,
        replacedProjectId: existing.project.id,
        replacedIntentId: existing.intent.id,
        replacedTrancheId: existing.tranche.id,
        replacedReservationRef: existing.tranche.reservationRef,
        supersessionIds: supersessions.map((entry) => entry.supersessionId),
        semanticsRevision,
        replacedState: existing,
        detail,
      });

      const intentId = deriveAdmissionSemanticRepairIntentId({
        rootIntentId: rootIdentity.intentId,
        semanticsRevision,
      });
      const result = await admitProject(() => intentId, signal);
      if (result.status !== "ADMITTED") throw new Error("PROJECT_SEMANTIC_REPAIR_NOT_ADMITTED");
      return {
        status: "REPAIRED",
        repair: options.durability.linkAdmissionSemanticRepairProject(repair.repairId, result.state.project.id),
        state: result.state,
        evidence: result.evidence,
      };
    },
  };
}
