import type {
  UtilityCapacityReadback,
  UtilityPlacementReceipt,
  UtilityRecoveryKind,
  UtilityRecoveryResult,
  UtilityCurrentBinding,
} from "../utility-recovery";
import { createHash } from "node:crypto";
import type { PlannedUtilityFacility, SpatialEntityRef, SpatialPoint2 } from "../spatial/types";
import { buildUtilityConnectionCandidates, type UtilityConnectionPrimitive } from "../utility-recovery";
import type { MayorAction } from "../types";
import type { UtilityTruth } from "./utility-topology-matchers";
import type { SequentialRepairState } from "./sequential-utility-repair";
import {
  FACILITY_ACCESS_ROAD_PREFAB,
  FACILITY_ACCESS_ROAD_REPAIR,
  facilityAccessRoadCourseReachesServicePoint,
  facilityAccessRoadRepairVerdict,
  facilityAccessRoadWorldPrecondition,
} from "./facility-access-road";
import { electricityTargetSemanticFingerprint, type ImmutableElectricityTargetSemantics, type CurrentElectricityTargetBinding } from "./utility-target-binding";
import type { FirstFacilityPlacementDurability } from "./utility-placement-durability";
import type { UtilityPlacementOperation } from "./durability";

export const V2_GREENFIELD_UTILITY_BOOTSTRAP_SCHEMA_VERSION =
  "ai-mayor-v2-greenfield-utility-bootstrap/1";
export const EXECUTION_MECHANISM_REVISION = "localconnect-membership-production-v2";
const LEGACY_EXECUTION_MECHANISM_REVISION = "legacy-unregistered-localconnect-v1";

export type GreenfieldUtilityKind = UtilityRecoveryKind;
export type GreenfieldUtilityTruthLayer =
  | "SUPPLY_EXISTS"
  | "NETWORK_CONNECTED"
  | "CITY_CAPACITY_AVAILABLE"
  | "TARGET_NETWORK_REACHABLE"
  | "SERVICE_CERTIFIED";

export interface GreenfieldUtilityExecutionScope {
  intentId: string;
  projectId: string;
  trancheId: string;
  trancheId: string;
  reservationRef: string;
  /** Stable identity for one facility site and its exactly-once placement authority. */
  placementScopeId?: string;
  worldId: string;
  worldEpochId: string;
  generation: string;
  topologyRevision: string;
  /** Stable engine mechanism identity; unlike generation, it survives reloads. */
  executionMechanismRevision?: string;
  /** Durable two-step flow for an alternate site: place/read back, then connect. */
  deferConnectionUntilPlaced?: boolean;
  certifiedRoadRefs: SpatialEntityRef[];
  /**
   * The admitted ROAD command's service entry: the road refs as certified, the
   * committed start endpoint, and — additively, so older durable scopes still
   * load — the command's own prefab and far endpoint.
   *
   * The last two are not decoration. A durable ref names an entity of the
   * generation the command ran in, so after a reload the road has to be
   * reacquired from geometry, and the contact point alone stops being unique as
   * soon as the game splits the delivered course into several edges meeting at
   * that node. Prefab and far endpoint are the command's own `exactInput`,
   * which is exactly the authority that stays immutable.
   */
  targetServiceEntry: {
    road: SpatialEntityRef;
    position: SpatialPoint2;
    prefab?: string;
    farEnd?: SpatialPoint2;
  };
  targetSemantics?: ImmutableElectricityTargetSemantics;
  spatialEnvelope: { center: SpatialPoint2; radius: number };
  maximumSpend: number;
  treasury: number;
  treasurySafetyReserve: number;
  /**
   * The utility families this scope is commissioned to supply, in execution
   * order. Absent means every family, which is what a full commissioning
   * request means and what every existing caller gets.
   *
   * This is a mandate, not a filter: a narrowed scope does not merely skip the
   * families it omits, it never rewrites their durable kind state either. A
   * caller that commissions one family — a bounded capability proof, say — must
   * be able to say so without the bootstrap placing an unrelated facility or
   * advancing another family's objective on its behalf.
   */
  commissionedKinds?: readonly GreenfieldUtilityKind[];
  /** A one-command Stage A scope: placement only, with closure left open. */
  facilityPlacementOnly?: boolean;
}

export interface GreenfieldUtilityServiceEvidence extends GreenfieldUtilityObservation {
  supplyExists: boolean;
  networkConnected: UtilityTruth;
  cityCapacityAvailable: boolean;
  targetNetworkReachable: UtilityTruth;
  facility: UtilityPlacementReceipt | null;
  connector: UtilityRecoveryResult["connector"] | null;
  targetRoad: SpatialEntityRef;
  evidenceGeneration: string;
  topologyRevision: string;
}

export type GreenfieldUtilityCommandOutcome =
  | "NONE" | "SUBMITTED" | "UNKNOWN" | "OBSERVED_MATCH" | "OBSERVED_MISMATCH";
export type UtilityCandidateLedgerState = "NOT_ATTEMPTED" | "PREFLIGHT_REJECTED" | "AUTHORIZED" | "SUBMITTED" | "RECONCILING" | "OBSERVED_MATCH" | "FAILED_DETERMINISTIC" | "UNKNOWN";
export interface DurableUtilityPrimitiveCandidate {
  candidateId: string;
  objectiveId: string;
  kind: UtilityConnectionPrimitive;
  ordinal: number;
  exactActions: MayorAction[];
  actionFingerprint: string;
  approvedPlanRevision: string;
  executionMechanismRevision?: string;
  spatialScope: GreenfieldUtilityExecutionScope["spatialEnvelope"];
  budgetCeiling: number;
  ledgerState: UtilityCandidateLedgerState;
  commandId: string | null;
  primitiveEffect: "NOT_OBSERVED" | "OBSERVED_MATCH" | "OBSERVED_MISMATCH" | "UNKNOWN";
  /**
   * Records that a durable PREFLIGHT_REJECTED state came from a native verdict.
   * Rejections recorded before this marker existed carry no proof that native
   * validation ever ran, so they are re-validated once instead of dead-ending
   * the approved objective.
   */
  preflightVerdict?: "NATIVE_REJECTED";
  targetSemanticFingerprint?: string;
  /** Current plan revision that produced a bounded access-road repair. */
  repairPlanRevision?: string;
  /**
   * Marks a candidate as the one bounded road-access repair course rather than a
   * course the plan or the replan derived.
   *
   * It is a marker and not just a label: the repair is the only course that may
   * be attempted once the facility is already in the world without a road, and
   * the only course whose planning is bounded to one attempt ever.
   */
  repair?: typeof FACILITY_ACCESS_ROAD_REPAIR;
  /** Durable exact authorization that grants one later repair attempt. */
  authorizationAmendmentId?: string;
  repairAttemptIndex?: number;
  /** Exact, single-action network-link repair authorization lineage. */
  networkLinkRepair?: {
    kind: "NETWORK_LINK_REPAIR";
    repairLineage: string;
    stepIndex: 1 | 2;
    authorizationId: string;
    exactQuote: number;
    actionIdentity: string;
  };
}

export type LegacyDirectCableSemanticMaterialization =
  | { status: "PASS"; targetSemanticFingerprint: string }
  | { status: "FAIL"; reason: string };

/**
 * Rehydrates only the additive semantic metadata omitted by the earliest
 * durable candidate records. Command identity remains byte-for-byte strict.
 */
export function materializeLegacyDirectCableSemanticFingerprint(input: {
  candidate: DurableUtilityPrimitiveCandidate;
  approvedExactActions: MayorAction[];
  approvedCablePrefab: string;
  semantic: ImmutableElectricityTargetSemantics | undefined;
}): LegacyDirectCableSemanticMaterialization {
  const { candidate, approvedExactActions, approvedCablePrefab, semantic } = input;
  if (candidate.kind !== "direct-cable") return { status: "FAIL", reason: "NOT_DIRECT_CABLE" };
  if (candidate.ledgerState !== "NOT_ATTEMPTED") return { status: "FAIL", reason: "CANDIDATE_ALREADY_ATTEMPTED" };
  if (candidate.commandId !== null) return { status: "FAIL", reason: "CANDIDATE_HAS_COMMAND" };
  if (candidate.targetSemanticFingerprint !== undefined) return { status: "FAIL", reason: "SEMANTIC_FINGERPRINT_ALREADY_PRESENT" };
  if (!semantic || semantic.schemaVersion !== "ai-mayor-v2-electricity-target/1" ||
    semantic.utility !== "ELECTRICITY" || semantic.role !== "NETWORK_ENTRY" ||
    semantic.attachmentRole !== "END" || !semantic.approvedPlanRevision ||
    !semantic.targetRoad.prefab || !semantic.targetRoad.endpointRole ||
    !Number.isFinite(semantic.approvedContact.x) || !Number.isFinite(semantic.approvedContact.z) ||
    !Number.isFinite(semantic.targetRoad.anchor.x) || !Number.isFinite(semantic.targetRoad.anchor.z)) {
    return { status: "FAIL", reason: "DURABLE_TARGET_SEMANTICS_INCOMPLETE" };
  }
  const exactActions = JSON.stringify(approvedExactActions);
  if (JSON.stringify(candidate.exactActions) !== exactActions) return { status: "FAIL", reason: "EXACT_ACTIONS_MISMATCH" };
  if (candidate.actionFingerprint !== JSON.stringify(candidate.exactActions) || candidate.actionFingerprint !== exactActions) {
    return { status: "FAIL", reason: "ACTION_FINGERPRINT_MISMATCH" };
  }
  if (candidate.approvedPlanRevision !== semantic.approvedPlanRevision) return { status: "FAIL", reason: "APPROVED_PLAN_REVISION_MISMATCH" };
  if (approvedExactActions.length === 0 || approvedExactActions.some((action) => action.type !== "build_road" || action.prefab !== approvedCablePrefab)) {
    return { status: "FAIL", reason: "CABLE_PREFAB_MISMATCH" };
  }
  const last = approvedExactActions.at(-1);
  if (!last || last.type !== "build_road" || last.x2 !== semantic.approvedContact.x || last.z2 !== semantic.approvedContact.z) {
    return { status: "FAIL", reason: "APPROVED_CONTACT_MISMATCH" };
  }
  return { status: "PASS", targetSemanticFingerprint: electricityTargetSemanticFingerprint(semantic) };
}

export interface DurableConnectionPrimitiveFallbackRecovery {
  type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY";
  consumed: boolean;
  consumptionCount: number;
  maximumConsumptions: 1;
  journal: Array<{
    event: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY_CONSUMED" |
      "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY_INVALIDATED_BEFORE_NATIVE_SUBMISSION";
    facility: UtilityPlacementReceipt["entity"];
    connector: NonNullable<UtilityRecoveryResult["connector"]>["node"];
    constructionAttempts: number;
  }>;
}

/**
 * A deterministic native verdict refuses one *course*, not the objective. This
 * record bounds how many replacement courses may be derived from the current
 * authoritative topology, and journals each decision so a restart can prove
 * which courses were already refused. It is the connection-planning analogue of
 * `DurableConnectionPrimitiveFallbackRecovery`: same shape, same discipline.
 */
export interface DurableConnectionCourseReplan {
  type: "CONNECTION_COURSE_REPLAN";
  replanCount: number;
  maximumReplans: number;
  /** Planning memory is attached to the existing bounded replan journal. */
  journal: Array<{
    event: "CONNECTION_COURSE_REPLANNED" | "CONNECTION_COURSE_REPLAN_REFUSED" | "CONNECTION_CONTEXT_REBOUND" |
      "ROAD_PLANNING_CANDIDATE_REJECTED" | "UTILITY_SITE_CONTEXT_EXHAUSTED" | "ALTERNATE_UTILITY_SITE_SELECTED" |
      "UTILITY_PLACEMENT_SCOPE_SUCCESSOR_CREATED";
    supersededPlanRevision?: string;
    supersededCandidateIds?: string[];
    approvedPlanRevision?: string;
    candidateIds?: string[];
    planningContextFingerprint?: string;
    candidateFingerprint?: string;
    siteFingerprint?: string;
    alternateSiteFingerprint?: string;
    exhaustedSiteFingerprint?: string;
    sitePosition?: { x: number; z: number };
    predecessorPlacementScopeId?: string;
    successorPlacementScopeId?: string;
    previousContextFingerprint?: string;
    currentContextFingerprint?: string;
    worldId?: string;
    generation?: string;
    reason: string;
  }>;
}

export interface DurableUtilityPlacementScopeHistory {
  placementScopeId: string;
  siteFingerprint: string;
  disposition: "EXHAUSTED_STRANDED" | "SUPERSEDED";
  plan: PlannedUtilityFacility;
  facilityCommandId: string;
  facility: UtilityPlacementReceipt;
  commandOutcome: GreenfieldUtilityCommandOutcome;
  networkCommandIds: string[];
  serviceEvidence: GreenfieldUtilityServiceEvidence | null;
  worldEpochId: string;
  generation: string;
}

export interface DurableGreenfieldUtilityKindState {
  kind: GreenfieldUtilityKind;
  placementScopeId?: string;
  placementScopeHistory?: DurableUtilityPlacementScopeHistory[];
  stage: GreenfieldUtilityEffectStage | "WAITING_FOR_SERVICE_UPDATE";
  constructionAttempts: number;
  maximumConstructionAttempts: 2;
  observationWaits: number;
  maximumObservationWaits: 3;
  authorizedSpend: number;
  plan: PlannedUtilityFacility | null;
  planBinding: { projectId: string; worldEpochId: string; topologyRevision: string } | null;
  facilityCommandId: string | null;
  networkCommandIds: string[];
  commandOutcome: GreenfieldUtilityCommandOutcome;
  lastFailureBoundary: "NONE" | "PRE_NATIVE_NETWORK_SUBMISSION" | "NATIVE_NETWORK_SUBMISSION";
  connectionRecovery: DurableConnectionPrimitiveFallbackRecovery;
  connectionReplan: DurableConnectionCourseReplan;
  selectedConnectionPrimitive: "service-road" | "direct-cable" | "facility-access-road" | null;
  lastRecoveryReason: string | null;
  connectionDiagnostics: UtilityRecoveryResult["connectionDiagnostics"];
  preflightDiagnostics?: UtilityRecoveryResult["preflightDiagnostics"];
  nativeTelemetry?: UtilityRecoveryResult["nativeTelemetry"];
  facility: UtilityPlacementReceipt | null;
  connector: UtilityRecoveryResult["connector"] | null;
  progression: { startFrame: number; targetFrame: number; checks: number; maximumChecks: number } | null;
  serviceEvidence: GreenfieldUtilityServiceEvidence | null;
  connectionObjective: { objectiveId: string; approvedPlanRevision: string; candidateOrder: string[]; status: "INCOMPLETE" | "COMPLETE" | "BLOCKED"; observationBudget: number; candidateBudget: number } | null;
  candidateLedger: DurableUtilityPrimitiveCandidate[];
  /** Exact current-world context that produced the candidate ledger. */
  connectionCandidateContextFingerprint?: string;
  /** Utility WorldState revision from which the derived plan/ledger was built. */
  basedOnUtilityRevision?: number;
  /** Ordered two-step repair state; each step remains an independent Utility command. */
  sequentialUtilityRepair?: SequentialRepairState | null;
  /** Append-only identity index for distinct sequential repair lineages. */
  sequentialUtilityRepairs?: Record<string, SequentialRepairState>;
  /**
   * The durable record of the one bounded road-access repair this family ever
   * planned, or null when none was.
   *
   * It exists beside the ledger entry rather than inside it because the ledger is
   * the write contract for courses and this is the proof that the repair has
   * already been spent: a resume that finds it must not plan, price or append a
   * second repair course.
   */
  accessRoadRepair?: {
    status: "PLANNED" | "ATTEMPTED" | "STALE";
    quote: number;
    offsetFromAdmittedCourse: number;
    /** No journal position exists at this boundary, so this is null rather than a clock reading. */
    plannedAtJournalPosition: number | null;
  } | null;
}

export interface DurableGreenfieldUtilityState {
  schemaVersion: "ai-mayor-v2-greenfield-utility-execution/1";
  scope: GreenfieldUtilityExecutionScope;
  utilities: Record<GreenfieldUtilityKind, DurableGreenfieldUtilityKindState>;
}

export interface GreenfieldUtilityProgressionResult {
  status: "WAITING_FOR_SERVICE_UPDATE" | "TARGET_REACHED" | "UNKNOWN";
  startFrame: number;
  targetFrame: number;
  currentFrame: number;
  paused: boolean | null;
  reason: string;
}

export type GreenfieldUtilityRebindResult =
  | { status: "MATCH"; facility: UtilityPlacementReceipt; connector: NonNullable<UtilityRecoveryResult["connector"]> }
  | { status: "PROVEN_MISSING"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export interface ScopedGreenfieldUtilityPorts {
  load(scope: GreenfieldUtilityExecutionScope): Promise<DurableGreenfieldUtilityState | null>;
  save(state: DurableGreenfieldUtilityState): Promise<void>;
  observe(kind: GreenfieldUtilityKind, scope: GreenfieldUtilityExecutionScope): Promise<GreenfieldUtilityServiceEvidence>;
  rebind?(kind: GreenfieldUtilityKind, state: DurableGreenfieldUtilityKindState, scope: GreenfieldUtilityExecutionScope): Promise<GreenfieldUtilityRebindResult>;
  plan(kind: GreenfieldUtilityKind, scope: GreenfieldUtilityExecutionScope): Promise<PlannedUtilityFacility>;
  /** Replans connection geometry from the current facility, connector, and target topology. */
  planCurrentConnection?(kind: GreenfieldUtilityKind, binding: UtilityCurrentBinding,
    scope: GreenfieldUtilityExecutionScope): Promise<PlannedUtilityFacility>;
  currentUtilityRevision?(): number;
  execute(input: {
    scope: GreenfieldUtilityExecutionScope;
    state: DurableGreenfieldUtilityKindState;
    plan: PlannedUtilityFacility;
    selectedPrimitive?: UtilityConnectionPrimitive;
    selectedCandidateId?: string;
    onAuthorized?: (binding: { commandId: string; actionFingerprint: string }) => Promise<void>;
  }): Promise<{
    state: DurableGreenfieldUtilityKindState;
    facilityConstructionAttempted: boolean;
    networkSubmissionAttempted: boolean;
    failedBeforeNetworkSubmission: boolean;
    facilityCommandId?: string | null;
    networkCommandIds?: string[];
    selectedConnectionPrimitive?: "service-road" | "direct-cable" | "facility-access-road";
    executionSucceeded: boolean;
    reason: string;
    connectionDiagnostics?: UtilityRecoveryResult["connectionDiagnostics"];
    preflightDiagnostics?: UtilityRecoveryResult["preflightDiagnostics"];
    nativeTelemetry?: UtilityRecoveryResult["nativeTelemetry"];
    authorizedSpend?: number;
  }>;
  inspectNetworkCommands?(input: {
    scope: GreenfieldUtilityExecutionScope;
    state: DurableGreenfieldUtilityKindState;
  }): Promise<{ commandIds: string[]; uncertain: boolean; authoritativeEffect?: boolean; commands?: Array<{ commandId: string; status: string; exactInput?: string }> }>;
  progress(input: {
    scope: GreenfieldUtilityExecutionScope;
    kind: GreenfieldUtilityKind;
    prior: { startFrame: number; targetFrame: number; checks: number; maximumChecks: number } | null;
  }): Promise<GreenfieldUtilityProgressionResult>;
  /**
   * The authoritative world read the road-access repair verdict is decided on.
   *
   * Optional, and its absence is a refusal rather than a default: an unreadable
   * frontage, warning or city capacity is not a satisfied precondition, so a
   * caller that supplies no reader never gets a repair course appended. A null
   * return is the same statement — the world could not be read this invocation.
   */
  facilityAccessRoadEvidence?(input: {
    kind: GreenfieldUtilityKind;
    scope: GreenfieldUtilityExecutionScope;
    signal?: AbortSignal;
  }): Promise<{
    roadAttachment: "ATTACHED" | "NONE" | "UNKNOWN";
    noRoadAccessWarning: boolean | "UNKNOWN";
    cityElectricityCapacitySufficient: boolean | "UNKNOWN";
  } | null>;
  /**
   * Derives and prices one bounded access-road course for this objective.
   *
   * The port owns the world reads this boundary cannot make: the current road
   * edges the course must not duplicate, and the native dry-run that prices it.
   * Its refusal is a verdict on the ladder, not a fault, so it contributes no
   * candidate and no error.
   */
  planFacilityAccessRoad?(input: {
    kind: GreenfieldUtilityKind;
    scope: GreenfieldUtilityExecutionScope;
    objective: { start: SpatialPoint2; end: SpatialPoint2 };
    admittedCourse: { prefab: string; start: SpatialPoint2; end: SpatialPoint2 };
    plan: PlannedUtilityFacility;
    signal?: AbortSignal;
  }): Promise<
    | { status: "PLANNED"; actions: MayorAction[]; quote: number; offsetFromAdmittedCourse: number }
    | { status: "REFUSED"; reasons: string[] }
    | { status: "UNKNOWN"; reason: string }
  >;
  /** Rehydrates already-authorized exact geometry; it never searches or previews. */
  authorizedFacilityAccessRoadRepair?(input: {
    kind: GreenfieldUtilityKind;
    scope: GreenfieldUtilityExecutionScope;
    currentPlanRevision: string;
    priorNetworkCommands: Array<{ commandId: string; status: string; exactInput?: string }>;
  }): Promise<{
    amendmentId: string;
    repairLineage: string;
    /** The immutable attempt ordinal this authorization was minted for. */
    attemptIndex: number;
    planRevision: string;
    courseFingerprint: string;
    actions: MayorAction[];
    quote: number;
    segmentQuotes: number[];
    worldId: string;
    generation: string;
  } | null>;
  /** Acceptance-only continuation seam; production leaves it undefined. */
  afterKindCertified?(input: {
    kind: GreenfieldUtilityKind;
    state: DurableGreenfieldUtilityState;
  }): Promise<void> | void;
}
export type GreenfieldUtilityEffectStage =
  | "MISSING"
  | "PLACED"
  | "CONNECTED"
  | "OPERATING"
  | "SERVICE_CERTIFIED"
  | "PLACED_AWAITING_PRODUCT_DECISION"
  | "BLOCKED";

export interface GreenfieldUtilityObservation extends UtilityCapacityReadback {
  status: "AVAILABLE" | "UNKNOWN";
  /** A city aggregate distinguishes empty-network readiness from current service. */
  readinessKind?: "PRE_CONSUMER_INFRASTRUCTURE" | "CITY_SERVICE" | "UNKNOWN";
}

export interface GreenfieldUtilityProposal {
  schemaVersion: typeof V2_GREENFIELD_UTILITY_BOOTSTRAP_SCHEMA_VERSION;
  proposalId: string;
  ownerId: string;
  method: "UtilityProvision";
  kind: GreenfieldUtilityKind;
  expectedRevision: string | null;
  maximumAttempts: 1;
}

export interface AdmittedGreenfieldUtilityProposal extends GreenfieldUtilityProposal {
  admission: {
    decision: "ADMITTED";
    reason: "BOUNDED_STARTER_UTILITY";
  };
}

export interface GreenfieldUtilityMethodPorts {
  observe(kind: GreenfieldUtilityKind, signal?: AbortSignal): Promise<GreenfieldUtilityObservation>;
  execute(
    proposal: AdmittedGreenfieldUtilityProposal,
    signal?: AbortSignal,
  ): Promise<UtilityRecoveryResult>;
}

export interface GreenfieldUtilityKindResult {
  kind: GreenfieldUtilityKind;
  stage: GreenfieldUtilityEffectStage;
  readinessKind?: GreenfieldUtilityObservation["readinessKind"];
  proposal: GreenfieldUtilityProposal | null;
  recovery: UtilityRecoveryResult | null;
  before: GreenfieldUtilityObservation;
  after: GreenfieldUtilityObservation | null;
  reason: string;
}

export interface GreenfieldUtilityBootstrapResult {
  schemaVersion: typeof V2_GREENFIELD_UTILITY_BOOTSTRAP_SCHEMA_VERSION;
  serviceCertified: boolean;
  results: GreenfieldUtilityKindResult[];
  providerInvocations: 0;
  legacyBrainInvocations: 0;
}

const kinds: readonly GreenfieldUtilityKind[] = ["electricity", "water", "sewage"];

/**
 * The families a scope actually commissions. The scope's mandate is the only
 * thing that narrows the canonical list; an omitted mandate is the full list, so
 * every caller that predates the field keeps commissioning all three families.
 */
function scopeKinds(scope: GreenfieldUtilityExecutionScope): readonly GreenfieldUtilityKind[] {
  return scope.commissionedKinds && scope.commissionedKinds.length > 0 ? scope.commissionedKinds : kinds;
}

export function starterUtilityReadinessKind(
  observation: GreenfieldUtilityObservation,
): NonNullable<GreenfieldUtilityObservation["readinessKind"]> {
  if (
    observation.status !== "AVAILABLE" ||
    observation.capacity === null ||
    observation.consumption === null ||
    !Number.isFinite(observation.capacity) ||
    !Number.isFinite(observation.consumption) ||
    observation.capacity <= 0 ||
    observation.capacity < observation.consumption ||
    observation.issueActive ||
    observation.freshness === "UNSETTLED" || observation.freshness === "UNKNOWN"
  ) return "UNKNOWN";
  if (observation.consumption === 0 &&
    (observation.fulfilledConsumption === null || observation.fulfilledConsumption === 0)) {
    return "PRE_CONSUMER_INFRASTRUCTURE";
  }
  if (observation.fulfilledConsumption !== null &&
    observation.fulfilledConsumption >= observation.consumption) return "CITY_SERVICE";
  return "UNKNOWN";
}

/** City-level readiness is a pre-zoning gate; actual per-building delivery is certified separately by Gate1. */
export function isAuthoritativeStarterUtilityReady(observation: GreenfieldUtilityObservation): boolean {
  return starterUtilityReadinessKind(observation) !== "UNKNOWN";
}

/** A city aggregate alone cannot certify that the current tranche's consumers receive service. */
export function isAuthoritativeStarterUtilityService(observation: GreenfieldUtilityObservation): boolean {
  return starterUtilityReadinessKind(observation) === "CITY_SERVICE";
}

export function proposeGreenfieldUtility(
  ownerId: string,
  kind: GreenfieldUtilityKind,
  observation: GreenfieldUtilityObservation,
): GreenfieldUtilityProposal {
  return {
    schemaVersion: V2_GREENFIELD_UTILITY_BOOTSTRAP_SCHEMA_VERSION,
    proposalId: `${ownerId}:utility:${kind}:attempt:1`,
    ownerId,
    method: "UtilityProvision",
    kind,
    expectedRevision: observation.revision,
    maximumAttempts: 1,
  };
}

export function admitGreenfieldUtilityProposal(
  proposal: GreenfieldUtilityProposal,
): AdmittedGreenfieldUtilityProposal {
  if (!proposal.ownerId || !kinds.includes(proposal.kind) || proposal.maximumAttempts !== 1) {
    throw new Error("greenfield utility proposal is outside the bounded starter scope");
  }
  return {
    ...proposal,
    admission: { decision: "ADMITTED", reason: "BOUNDED_STARTER_UTILITY" },
  };
}

function deliveredStage(
  recovery: UtilityRecoveryResult,
  after: GreenfieldUtilityObservation,
): GreenfieldUtilityEffectStage {
  if (!recovery.facility) return "BLOCKED";
  if (!recovery.connector?.attached) return "PLACED";
  if (after.status === "AVAILABLE" && after.capacity !== null && after.capacity > 0) return "OPERATING";
  return "CONNECTED";
}

/**
 * Provider-free minimum UtilityProvision Method for a zero-utility starter city.
 * Supply-side certification here does not replace Gate 1's later, building-local
 * ACTUAL_CONSUMER_SERVICE observation.
 */
export async function runGreenfieldUtilityBootstrap(input: {
  ownerId: string;
  ports: GreenfieldUtilityMethodPorts;
  signal?: AbortSignal;
}): Promise<GreenfieldUtilityBootstrapResult> {
  const results: GreenfieldUtilityKindResult[] = [];
  for (const kind of kinds) {
    const before = await input.ports.observe(kind, input.signal);
    if (before.status === "UNKNOWN") {
      results.push({ kind, stage: "BLOCKED", proposal: null, recovery: null, before, after: null, reason: "UTILITY_OBSERVATION_UNKNOWN" });
      break;
    }
    if (isAuthoritativeStarterUtilityReady(before)) {
      const readinessKind = starterUtilityReadinessKind(before);
      results.push({ kind, stage: "SERVICE_CERTIFIED", readinessKind, proposal: null, recovery: null, before, after: before,
        reason: readinessKind === "PRE_CONSUMER_INFRASTRUCTURE" ? "PRE_CONSUMER_INFRASTRUCTURE_READY" : "SERVICE_ALREADY_CERTIFIED" });
      continue;
    }
    const proposal = proposeGreenfieldUtility(input.ownerId, kind, before);
    const admitted = admitGreenfieldUtilityProposal(proposal);
    const recovery = await input.ports.execute(admitted, input.signal);
    const after = await input.ports.observe(kind, input.signal);
    if (after.status === "UNKNOWN") {
      results.push({ kind, stage: "BLOCKED", proposal, recovery, before, after, reason: "UTILITY_EFFECT_OBSERVATION_UNKNOWN" });
      break;
    }
    const deliveryChainObserved = !!recovery.facility && recovery.connector?.attached === true;
    if (!deliveryChainObserved || !isAuthoritativeStarterUtilityReady(after)) {
      results.push({
        kind,
        stage: deliveredStage(recovery, after),
        proposal,
        recovery,
        before,
        after,
        reason: !deliveryChainObserved
          ? "PLACEMENT_OR_CONNECTION_NOT_CERTIFIED"
          : recovery.reason === "resolved" ? "SERVICE_NOT_CERTIFIED" : recovery.reason,
      });
      break;
    }
    const readinessKind = starterUtilityReadinessKind(after);
    results.push({ kind, stage: "SERVICE_CERTIFIED", readinessKind, proposal, recovery, before, after,
      reason: readinessKind === "PRE_CONSUMER_INFRASTRUCTURE" ? "PRE_CONSUMER_INFRASTRUCTURE_READY" : "AUTHORITATIVE_SERVICE_CERTIFIED" });
  }
  return {
    schemaVersion: V2_GREENFIELD_UTILITY_BOOTSTRAP_SCHEMA_VERSION,
    serviceCertified: results.length === kinds.length && results.every((result) => result.stage === "SERVICE_CERTIFIED"),
    results,
    providerInvocations: 0,
    legacyBrainInvocations: 0,
  };
}

const sameRef = (left: SpatialEntityRef, right: SpatialEntityRef) =>
  left.index === right.index && left.version === right.version;

const insideEnvelope = (point: SpatialPoint2, scope: GreenfieldUtilityExecutionScope) =>
  Math.hypot(point.x - scope.spatialEnvelope.center.x, point.z - scope.spatialEnvelope.center.z) <=
  scope.spatialEnvelope.radius;

export function assertGreenfieldUtilityScope(scope: GreenfieldUtilityExecutionScope): void {
  if (![scope.intentId, scope.projectId, scope.trancheId, scope.reservationRef, scope.worldId,
    scope.worldEpochId, scope.generation, scope.topologyRevision].every((value) => value.trim().length > 0)) {
    throw new Error("utility execution scope identity is incomplete");
  }
  if (!(scope.spatialEnvelope.radius > 0) || (!scope.facilityPlacementOnly &&
    (scope.certifiedRoadRefs.length === 0 || !scope.certifiedRoadRefs.some((road) => sameRef(road, scope.targetServiceEntry.road))))) {
    throw new Error("utility execution scope lacks its certified target road");
  }
  if (![scope.maximumSpend, scope.treasury, scope.treasurySafetyReserve].every(Number.isFinite) ||
    scope.maximumSpend <= 0 || scope.treasurySafetyReserve < 0 ||
    scope.maximumSpend > Math.max(0, scope.treasury - scope.treasurySafetyReserve)) {
    throw new Error("utility execution scope exceeds its authoritative finance envelope");
  }
  // An empty mandate is refused rather than read as "everything": a caller that
  // says it commissions nothing has made a mistake, and supplying every family
  // would be the worst available reading of it.
  if (scope.commissionedKinds !== undefined &&
    (scope.commissionedKinds.length === 0 ||
      scope.commissionedKinds.some((kind) => !kinds.includes(kind)) ||
      new Set(scope.commissionedKinds).size !== scope.commissionedKinds.length)) {
    throw new Error("utility execution scope declares an invalid commissioning mandate");
  }
}

export function admitScopedGreenfieldUtilityPlan(input: {
  kind: GreenfieldUtilityKind;
  scope: GreenfieldUtilityExecutionScope;
  plan: PlannedUtilityFacility;
}): void {
  assertGreenfieldUtilityScope(input.scope);
  const plannedKind = input.kind === "electricity" ? "power" : input.kind;
  const expectedDirectNetworkPrefab = input.kind === "electricity" ? "Low-voltage Ground Cable"
    : input.kind === "water" ? "Small Water Pipe" : "Small Sewage Pipe";
  const directCableTargetsCertifiedRoad = !input.scope.facilityPlacementOnly &&
    input.plan.connection.prefab === expectedDirectNetworkPrefab &&
    input.scope.certifiedRoadRefs.some((road) => sameRef(road, input.scope.targetServiceEntry.road)) &&
    Math.hypot(input.plan.connection.end.x - input.scope.targetServiceEntry.position.x,
      input.plan.connection.end.z - input.scope.targetServiceEntry.position.z) <= 0.25;
  if (!input.scope.facilityPlacementOnly && !input.plan.serviceRoads?.length && !directCableTargetsCertifiedRoad) {
    throw new Error("utility plan lacks an observable road-owned target-network path");
  }
  // The sewage recipe has applicability conditions, and a native placement
  // verdict is not one of them: a facility the game accepts on a legal shoreline
  // says nothing about where its discharge goes. So a sewage plan is admitted
  // only with the evidence that the criterion was evaluated for THIS site and
  // passed. Electricity and water carry no such condition and are unchanged.
  if (input.kind === "sewage" && input.plan.environmentalCertification === undefined) {
    throw new Error("SEWAGE_ENVIRONMENTAL_SAFETY_NOT_CERTIFIED");
  }
  const serviceRoadsInScope = input.scope.facilityPlacementOnly || (input.plan.serviceRoads ?? []).every((road) =>
    insideEnvelope(road.start, input.scope) && insideEnvelope(road.end, input.scope));
  if (input.plan.kind !== plannedKind || input.plan.constructionCost > input.scope.maximumSpend ||
    !insideEnvelope(input.plan.position, input.scope) || !insideEnvelope(input.plan.connection.end, input.scope) ||
    !serviceRoadsInScope ||
    (!input.scope.facilityPlacementOnly && !sameRef(input.scope.targetServiceEntry.road, input.scope.certifiedRoadRefs.find((road) =>
      sameRef(road, input.scope.targetServiceEntry.road))!))) {
    throw new Error("utility plan is outside its admitted tranche/road/spend scope");
  }
}

export function isScopedUtilityServiceCertified(
  evidence: GreenfieldUtilityServiceEvidence,
  scope: GreenfieldUtilityExecutionScope,
): boolean {
  return evidence.status === "AVAILABLE" &&
    evidence.evidenceGeneration === scope.generation &&
    evidence.topologyRevision === scope.topologyRevision &&
    sameRef(evidence.targetRoad, scope.targetServiceEntry.road) &&
    evidence.supplyExists && evidence.networkConnected && evidence.cityCapacityAvailable &&
    evidence.targetNetworkReachable === true && isAuthoritativeStarterUtilityReady(evidence);
}

function initialKind(kind: GreenfieldUtilityKind): DurableGreenfieldUtilityKindState {
  return {
    kind, placementScopeId: "utility-placement:legacy", placementScopeHistory: [],
    stage: "MISSING", constructionAttempts: 0, maximumConstructionAttempts: 2,
    observationWaits: 0, maximumObservationWaits: 3, authorizedSpend: 0,
    plan: null, planBinding: null, facilityCommandId: null, networkCommandIds: [],
    commandOutcome: "NONE", lastFailureBoundary: "NONE",
    connectionRecovery: {
      type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY", consumed: false,
      consumptionCount: 0, maximumConsumptions: 1, journal: [],
    },
    connectionReplan: {
      type: "CONNECTION_COURSE_REPLAN", replanCount: 0, maximumReplans: 2, journal: [],
    },
    selectedConnectionPrimitive: null, lastRecoveryReason: null, connectionDiagnostics: [],
    preflightDiagnostics: [], nativeTelemetry: undefined,
    facility: null, connector: null, progression: null,
    serviceEvidence: null, connectionObjective: null, candidateLedger: [],
    accessRoadRepair: null,
  };
}

function normalizeKindState(current: DurableGreenfieldUtilityKindState): DurableGreenfieldUtilityKindState {
  const legacy = current as DurableGreenfieldUtilityKindState & {
    lastFailureBoundary?: DurableGreenfieldUtilityKindState["lastFailureBoundary"];
    connectionRecovery?: DurableConnectionPrimitiveFallbackRecovery;
    selectedConnectionPrimitive?: DurableGreenfieldUtilityKindState["selectedConnectionPrimitive"];
    lastRecoveryReason?: string | null;
    connectionDiagnostics?: UtilityRecoveryResult["connectionDiagnostics"];
  };
  legacy.lastFailureBoundary ??= legacy.facility && legacy.networkCommandIds.length === 0 &&
      legacy.commandOutcome === "OBSERVED_MISMATCH"
    ? "PRE_NATIVE_NETWORK_SUBMISSION"
    : "NONE";
  legacy.connectionRecovery ??= {
    type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY", consumed: false,
    consumptionCount: 0, maximumConsumptions: 1, journal: [],
  };
  legacy.connectionReplan ??= {
    type: "CONNECTION_COURSE_REPLAN", replanCount: 0, maximumReplans: 2, journal: [],
  };
  legacy.selectedConnectionPrimitive ??= null;
  legacy.lastRecoveryReason ??= null;
  legacy.connectionDiagnostics ??= [];
  legacy.placementScopeId ??= "utility-placement:legacy";
  legacy.placementScopeHistory ??= [];
  legacy.preflightDiagnostics ??= [];
  legacy.connectionObjective ??= null;
  legacy.candidateLedger ??= [];
  // Absent means no repair was ever planned, which is not the same as "a repair
  // was planned and nothing is known about it". Only a real record can claim the
  // latter, so the backfill is null and never a guess.
  legacy.accessRoadRepair ??= null;
  for (const candidate of legacy.candidateLedger) {
    candidate.actionFingerprint ??= JSON.stringify(candidate.exactActions);
  }
  return legacy;
}

export const MAX_UTILITY_SUCCESSOR_PLACEMENT_SCOPES = 7;

export function utilityPlacementScopeId(kind: GreenfieldUtilityKind, plan: PlannedUtilityFacility): string {
  return `utility-placement:${JSON.stringify({ kind, prefab: plan.prefab, x: plan.position.x, z: plan.position.z })}`;
}

/** Promote a formal, bounded alternate-site plan into its own durable scope. */
export function createUtilityPlacementSuccessor(input: {
  utility: DurableGreenfieldUtilityKindState;
  plan: PlannedUtilityFacility;
  alternateSiteFingerprint: string;
  exhaustedSiteFingerprint: string;
  projectId: string;
  worldId: string;
  worldEpochId: string;
  generation: string;
  branchActivated: boolean;
  predecessorPlacement: FirstFacilityPlacementDurability;
  predecessorOperations: readonly UtilityPlacementOperation[] | null;
}): { utility: DurableGreenfieldUtilityKindState; placementScopeId: string; reused: boolean } | null {
  const utility = structuredClone(input.utility);
  const placementScopeId = utilityPlacementScopeId(utility.kind, input.plan);
  const prior = utility.connectionReplan.journal.find((entry) =>
    entry.event === "UTILITY_PLACEMENT_SCOPE_SUCCESSOR_CREATED" &&
    entry.alternateSiteFingerprint === input.alternateSiteFingerprint);
  if (prior?.successorPlacementScopeId) {
    return prior.successorPlacementScopeId === placementScopeId
      ? { utility, placementScopeId, reused: true }
      : null;
  }
  const exhausted = utility.connectionReplan.journal.some((entry) =>
    entry.event === "UTILITY_SITE_CONTEXT_EXHAUSTED" && entry.siteFingerprint === input.exhaustedSiteFingerprint);
  const matchesSiteFingerprint = (value: string | undefined) => {
    if (value === input.exhaustedSiteFingerprint) return true;
    if (!value) return false;
    try { if (JSON.parse(value) === input.exhaustedSiteFingerprint) return true; }
    catch { /* A legacy marker can contain the JSON string's escaped inner text. */ }
    try { return JSON.parse(`"${value}"`) === input.exhaustedSiteFingerprint; }
    catch { return false; }
  };
  const siteSelected = utility.connectionReplan.journal.some((entry) =>
    entry.event === "ALTERNATE_UTILITY_SITE_SELECTED" &&
    matchesSiteFingerprint(entry.exhaustedSiteFingerprint) &&
    (entry.alternateSiteFingerprint ?? entry.siteFingerprint) === input.alternateSiteFingerprint);
  const sameSite = utility.plan?.prefab === input.plan.prefab && utility.plan &&
    Math.hypot(utility.plan.position.x - input.plan.position.x, utility.plan.position.z - input.plan.position.z) < 2;
  const operations = input.predecessorOperations;
  const predecessorCommandId = input.predecessorPlacement.status === "PLACED"
    ? input.predecessorPlacement.commandId : null;
  const predecessorCommandObserved = predecessorCommandId !== null &&
    operations?.some((operation) => operation.commandId === predecessorCommandId &&
      operation.outcome === "OBSERVED_MATCH" && operation.status === "OBSERVED_MATCH");
  let exhaustedContext: Record<string, unknown> | null = null;
  try {
    exhaustedContext = JSON.parse(input.exhaustedSiteFingerprint) as Record<string, unknown>;
  } catch { /* Historical/unstructured fingerprints do not authorize successor placement. */ }
  const exhaustedContextMatches = exhaustedContext?.projectId === input.projectId &&
    exhaustedContext?.trancheId === input.trancheId && exhaustedContext?.worldEpochId === input.worldEpochId &&
    exhaustedContext?.topologyRevision === utility.planBinding?.topologyRevision &&
    exhaustedContext?.kind === utility.kind &&
    Math.hypot(
      Number((exhaustedContext.facility as Record<string, unknown> | undefined)?.position &&
        ((exhaustedContext.facility as Record<string, unknown>).position as Record<string, unknown>).x) - utility.plan?.position.x,
      Number((exhaustedContext.facility as Record<string, unknown> | undefined)?.position &&
        ((exhaustedContext.facility as Record<string, unknown>).position as Record<string, unknown>).z) - utility.plan?.position.z,
    ) < 1.5;
  const operationsResolved = operations !== null && operations !== undefined && operations.length > 0 &&
    operations.every((operation) =>
      (operation.outcome === "OBSERVED_MATCH" && operation.status === "OBSERVED_MATCH") ||
      (operation.failedBeforeSubmit && operation.outcome === "FAILED") ||
      (operation.outcome === "FAILED" && operation.status === "OBSERVED_MISMATCH" && operation.effectAbsenceProven));
  if (!input.branchActivated || !exhausted || !siteSelected || sameSite || !utility.plan || !utility.facility ||
    !utility.facilityCommandId || !predecessorCommandObserved || !operationsResolved || !exhaustedContextMatches ||
    !input.worldId || !input.worldEpochId || !input.generation ||
    input.worldEpochId !== `${input.worldId}:generation:${input.generation}` ||
    (utility.planBinding !== null && (utility.planBinding.projectId !== input.projectId ||
      utility.planBinding.worldEpochId !== input.worldEpochId)) ||
    (utility.placementScopeHistory?.length ?? 0) >= MAX_UTILITY_SUCCESSOR_PLACEMENT_SCOPES) return null;

  const predecessorPlacementScopeId = utility.placementScopeId ?? "utility-placement:legacy";
  utility.placementScopeHistory ??= [];
  utility.placementScopeHistory.push({
    placementScopeId: predecessorPlacementScopeId,
    siteFingerprint: input.exhaustedSiteFingerprint,
    disposition: "EXHAUSTED_STRANDED",
    plan: structuredClone(utility.plan),
    facilityCommandId: utility.facilityCommandId,
    facility: structuredClone(utility.facility),
    commandOutcome: utility.commandOutcome,
    networkCommandIds: [...utility.networkCommandIds],
    serviceEvidence: utility.serviceEvidence ? structuredClone(utility.serviceEvidence) : null,
    worldEpochId: input.worldEpochId,
    generation: input.generation,
  });
  utility.placementScopeId = placementScopeId;
  utility.stage = "MISSING";
  utility.constructionAttempts = 0;
  utility.observationWaits = 0;
  utility.authorizedSpend = 0;
  utility.plan = structuredClone(input.plan);
  utility.planBinding = utility.planBinding
    ? { ...utility.planBinding, worldEpochId: input.worldEpochId }
    : null;
  utility.facilityCommandId = null;
  utility.networkCommandIds = [];
  utility.commandOutcome = "NONE";
  utility.lastFailureBoundary = "NONE";
  utility.connectionRecovery = {
    type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY", consumed: false,
    consumptionCount: 0, maximumConsumptions: 1, journal: [],
  };
  utility.selectedConnectionPrimitive = null;
  utility.lastRecoveryReason = null;
  utility.connectionDiagnostics = [];
  utility.preflightDiagnostics = [];
  utility.nativeTelemetry = undefined;
  utility.facility = null;
  utility.connector = null;
  utility.progression = null;
  utility.serviceEvidence = null;
  utility.connectionObjective = null;
  utility.candidateLedger = [];
  utility.accessRoadRepair = null;
  utility.connectionReplan.journal.push({
    event: "UTILITY_PLACEMENT_SCOPE_SUCCESSOR_CREATED",
    predecessorPlacementScopeId,
    successorPlacementScopeId: placementScopeId,
    siteFingerprint: input.alternateSiteFingerprint,
    alternateSiteFingerprint: input.alternateSiteFingerprint,
    exhaustedSiteFingerprint: input.exhaustedSiteFingerprint,
    sitePosition: { ...input.plan.position },
    worldId: input.worldId,
    generation: input.generation,
    reason: "BOUNDED_ALTERNATE_SITE_AFTER_AUTHORITATIVE_PREDECESSOR_AND_CONTACT_EXHAUSTION",
  });
  return { utility, placementScopeId, reused: false };
}

export function canConsumeConnectionPrimitiveFallbackRecovery(input: {
  state: DurableGreenfieldUtilityKindState;
  observed: GreenfieldUtilityServiceEvidence;
  uncertainNetworkCommand: boolean;
  authoritativeNetworkEffect: boolean;
}): boolean {
  const { state, observed } = input;
  const facility = observed.facility ?? state.facility;
  const connector = observed.connector ?? state.connector;
  return observed.status === "AVAILABLE" && observed.supplyExists && !!facility && !!connector &&
    Number.isInteger(connector.node.index) && Number.isInteger(connector.node.version) &&
    state.networkCommandIds.length === 0 &&
    state.commandOutcome !== "SUBMITTED" && state.commandOutcome !== "UNKNOWN" &&
    !input.uncertainNetworkCommand && !input.authoritativeNetworkEffect &&
    !observed.networkConnected && !observed.targetNetworkReachable &&
    state.lastFailureBoundary === "PRE_NATIVE_NETWORK_SUBMISSION" &&
    !state.connectionRecovery.consumed && state.connectionRecovery.consumptionCount === 0 &&
    !!state.plan;
}

function consumeConnectionRecovery(current: DurableGreenfieldUtilityKindState): void {
  if (!current.facility || !current.connector) throw new Error("CONNECTION_RECOVERY_AUTHORITATIVE_BINDING_MISSING");
  current.connectionRecovery.consumed = true;
  current.connectionRecovery.consumptionCount = 1;
  current.connectionRecovery.journal.push({
    event: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY_CONSUMED",
    facility: structuredClone(current.facility.entity),
    connector: structuredClone(current.connector.node),
    constructionAttempts: current.constructionAttempts,
  });
}

/**
 * Re-arms preflight rejections that carry no proof of a native verdict. Preflight
 * performs no native mutation, so re-validating a primitive that was never
 * validated is safe; leaving it durably rejected dead-ends an approved objective
 * whose course is still perfectly valid.
 */
function rearmUnverifiedPreflightRejections(current: DurableGreenfieldUtilityKindState): void {
  for (const candidate of current.candidateLedger) {
    if (candidate.ledgerState !== "PREFLIGHT_REJECTED") continue;
    if (candidate.preflightVerdict === "NATIVE_REJECTED") continue;
    if (candidate.commandId !== null || candidate.primitiveEffect !== "NOT_OBSERVED") continue;
    candidate.ledgerState = "NOT_ATTEMPTED";
  }
}

/**
 * A deterministic course failure is scoped to the engine mechanism that
 * produced it. A mechanism revision change may re-authorize the exact same
 * action fingerprint once, while preserving the old failed candidate and its
 * command history forever. Re-entering with the same revision is a no-op.
 */
export function ensureMechanismRevisionRetry(
  current: DurableGreenfieldUtilityKindState,
  mechanismRevision: string,
): boolean {
  if (!mechanismRevision.trim()) return false;
  const failed = current.candidateLedger.filter((candidate) =>
    candidate.ledgerState === "FAILED_DETERMINISTIC" &&
    (candidate.executionMechanismRevision ?? LEGACY_EXECUTION_MECHANISM_REVISION) !== mechanismRevision,
  );
  let added = false;
  for (const candidate of failed) {
    const alreadyMinted = current.candidateLedger.some((entry) =>
      entry.executionMechanismRevision === mechanismRevision &&
      entry.actionFingerprint === candidate.actionFingerprint,
    );
    if (alreadyMinted) continue;
    current.candidateLedger.push({
      ...structuredClone(candidate),
      candidateId: `${candidate.candidateId}:mechanism:${mechanismRevision}`,
      executionMechanismRevision: mechanismRevision,
      ledgerState: "NOT_ATTEMPTED",
      commandId: null,
      primitiveEffect: "NOT_OBSERVED",
      preflightVerdict: undefined,
    });
    added = true;
  }
  return added;
}

/**
 * A deterministic native verdict on one connection course does not exhaust the
 * objective: it is a verdict on that course. While at least one course was
 * refused by authoritative reconciliation and the bounded replan budget is not
 * spent, the Local Mayor may derive a replacement course.
 */
export function canReplanConnectionCourse(current: DurableGreenfieldUtilityKindState): boolean {
  if (!current.plan || !current.facility || !current.connector) return false;
  if (current.connectionReplan.replanCount >= current.connectionReplan.maximumReplans) return false;
  return current.candidateLedger.some((candidate) => candidate.ledgerState === "FAILED_DETERMINISTIC");
}

/**
 * Derives the replacement course from the *current* authoritative topology —
 * the same connection planner, the same candidate ledger, the same durable
 * command journal — and mints a new stable identity for it. The refused
 * candidate is left durably `FAILED_DETERMINISTIC` and is never re-admitted.
 *
 * A replacement must be a course that has not been attempted yet. Identity is
 * deliberately NOT the key: a course that was already executed keeps its
 * eligibility revoked no matter how its `candidateId`, `objectiveId` or
 * `approvedPlanRevision` are re-minted, so a new revision can never resurrect
 * the same geometry. The key is the action fingerprint, and every ledger entry
 * whose state is not `NOT_ATTEMPTED` — refused, rejected, in flight, matched —
 * revokes it. `isAttemptable` applies the caller's own policy (the same
 * predicate the selection uses), so a primitive the current policy would never
 * attempt cannot be passed off as a new course.
 *
 * When nothing genuinely new and policy-eligible remains, the replan is refused
 * and the refusal consumes the bounded budget, so the objective terminates with
 * UTILITY_CONNECTION_CANDIDATES_EXHAUSTED instead of looping.
 */
export function replanConnectionCourse(
  current: DurableGreenfieldUtilityKindState,
  scope: GreenfieldUtilityExecutionScope,
  isAttemptable: (candidate: DurableUtilityPrimitiveCandidate) => boolean,
): boolean {
  if (!current.plan || !current.facility || !current.connector) return false;
  const supersededPlanRevision = current.connectionObjective?.approvedPlanRevision ??
    current.planBinding?.topologyRevision ?? scope.topologyRevision;
  const supersededCandidateIds = current.candidateLedger.map((candidate) => candidate.candidateId);
  const ordinal = current.connectionReplan.replanCount + 1;
  // Deterministic and durable: the generation-derived production revision plus
  // the bounded replan ordinal. No wall clock, no randomness, no LLM.
  const approvedPlanRevision = `${supersededPlanRevision}:replan:${ordinal}`;
  const objectiveId = `${scope.projectId}:${scope.trancheId}:${current.kind}:${approvedPlanRevision}:${current.facility.entity.index}:${current.connector.node.index}`;
  const attemptedFingerprints = new Set(current.candidateLedger
    .filter((candidate) => candidate.ledgerState !== "NOT_ATTEMPTED")
    .map((candidate) => candidate.actionFingerprint));
  const replacement = buildUtilityConnectionCandidates(current.plan, current.connector)
    .filter((candidate) => !attemptedFingerprints.has(JSON.stringify(candidate.actions)))
    .map((candidate, index) => ({
      candidateId: `${objectiveId}:${candidate.primitive}`, objectiveId, kind: candidate.primitive, ordinal: index,
      exactActions: structuredClone(candidate.actions), approvedPlanRevision,
      executionMechanismRevision: scope.executionMechanismRevision,
      actionFingerprint: JSON.stringify(candidate.actions),
      ...(scope.targetSemantics ? { targetSemanticFingerprint: JSON.stringify(scope.targetSemantics) } : {}),
      spatialScope: structuredClone(scope.spatialEnvelope), budgetCeiling: scope.maximumSpend,
      ledgerState: "NOT_ATTEMPTED" as const, commandId: null, primitiveEffect: "NOT_OBSERVED" as const,
    }))
    .filter(isAttemptable);
  current.connectionReplan.replanCount = ordinal;
  if (replacement.length === 0) {
    current.connectionReplan.journal.push({
      event: "CONNECTION_COURSE_REPLAN_REFUSED", supersededPlanRevision, supersededCandidateIds,
      approvedPlanRevision, candidateIds: [], reason: "CONNECTION_COURSE_REPLAN_NOT_DISTINCT",
    });
    return false;
  }
  current.candidateLedger.push(...replacement);
  current.connectionObjective = {
    objectiveId, approvedPlanRevision, candidateOrder: replacement.map((candidate) => candidate.kind),
    status: "INCOMPLETE", observationBudget: current.maximumObservationWaits, candidateBudget: replacement.length,
  };
  current.connectionReplan.journal.push({
    event: "CONNECTION_COURSE_REPLANNED", supersededPlanRevision, supersededCandidateIds,
    approvedPlanRevision, candidateIds: replacement.map((candidate) => candidate.candidateId),
    reason: "CONNECTION_COURSE_DETERMINISTIC_FAILURE_REPLANNED",
  });
  return true;
}

/** The authoritative world read the bounded access-road repair is decided on. */
type AccessRoadWorldEvidence = NonNullable<
  Awaited<ReturnType<NonNullable<ScopedGreenfieldUtilityPorts["facilityAccessRoadEvidence"]>>>
>;

/**
 * The bounded repair course this slice has planned and not yet spent, or null.
 *
 * This is the durable answer to "does the workflow already hold an actionable
 * repair", and it is read from the ledger because that is where the authority
 * lives across a restart. A course that carries a command id, or that has left
 * `NOT_ATTEMPTED` for any other reason, is spent or in flight and is never
 * offered here: the point of the question is whether there is something left to
 * DO, not whether a repair exists.
 */
export function unspentAccessRoadRepairCourse(
  current: DurableGreenfieldUtilityKindState,
): DurableUtilityPrimitiveCandidate | null {
  return current.candidateLedger.find((candidate) =>
    candidate.repair === FACILITY_ACCESS_ROAD_REPAIR &&
    candidate.kind === "facility-access-road" &&
    candidate.ledgerState === "NOT_ATTEMPTED" &&
    candidate.commandId === null) ?? null;
}

/**
 * Plan at most one bounded access-road repair for this family, before any
 * candidate is selected and before the workflow decides whether it may wait.
 *
 * The repair exists because a slice can reach a state the plan cannot answer: the
 * facility landed, its connection to the utility network is observed, and the
 * frontage it needs is a road the plan's own course can no longer supply. That is
 * a verdict the plan was never asked for, so it is decided here, on the world
 * read and the durable history, and it contributes exactly one candidate.
 *
 * Everything about this step is fail-closed and silent. A refusal is not an
 * error and does not block anything: it simply appends no candidate, which
 * leaves the objective exactly as it would have been had the capability not
 * existed. That is deliberate — a repair that could not be proven is not a
 * reason to stop a workflow that has other courses left.
 *
 * It returns the world read when it took one, so the caller's next question —
 * whether the bound repair still stands — is answered from the same observation
 * instead of asking the world a second time inside one invocation. Null means
 * this call observed nothing, which is a refusal to answer, not a satisfied
 * clause.
 */
async function ensureFacilityAccessRoadRepair(input: {
  current: DurableGreenfieldUtilityKindState;
  scope: GreenfieldUtilityExecutionScope;
  observed: GreenfieldUtilityServiceEvidence;
  plan: PlannedUtilityFacility | null;
  priorNetworkCommands?: Array<{ commandId: string; status: string; exactInput?: string }>;
  ports: ScopedGreenfieldUtilityPorts;
}): Promise<AccessRoadWorldEvidence | null> {
  const { current, scope, observed, plan, ports } = input;
  // Only water is adjudicated in this round, and only a caller that supplies the
  // world reads can be answered at all. A missing port is a refusal, never a
  // default: an unreadable frontage is not a missing one.
  if (!plan || current.kind !== "water") return null;
  if (!ports.facilityAccessRoadEvidence || !ports.planFacilityAccessRoad) return null;
  // One repair, ever. A durable record or an existing ledger entry means the
  // bounded attempt was already planned, so a resume never plans, prices or
  // appends a second course — and a geometry that was already attempted is never
  // revived under a new identity.
  const currentPlanRevision = current.connectionObjective?.approvedPlanRevision ??
    current.planBinding?.topologyRevision ?? scope.topologyRevision;
  const priorRepairCandidates = current.candidateLedger.filter((candidate) => candidate.repair === FACILITY_ACCESS_ROAD_REPAIR);
  const authorizedRepair = current.kind === "water" && ports.authorizedFacilityAccessRoadRepair
    ? await ports.authorizedFacilityAccessRoadRepair({
        kind: current.kind, scope, currentPlanRevision,
        priorNetworkCommands: input.priorNetworkCommands ?? [],
      })
    : null;
  if (authorizedRepair) {
    const roadCommands = (input.priorNetworkCommands ?? []).filter((command) => {
      try {
        const actions = JSON.parse(command.exactInput ?? "[]") as MayorAction[];
        return Array.isArray(actions) && actions.some((action) => action.type === "build_road" && action.prefab === FACILITY_ACCESS_ROAD_PREFAB);
      } catch { return false; }
    });
    if (authorizedRepair.planRevision !== currentPlanRevision || authorizedRepair.generation !== scope.generation ||
      authorizedRepair.worldId !== scope.worldId || !Number.isInteger(authorizedRepair.attemptIndex) ||
      authorizedRepair.attemptIndex <= 0 ||
      authorizedRepair.courseFingerprint !== JSON.stringify(authorizedRepair.actions) ||
      authorizedRepair.actions.length !== authorizedRepair.segmentQuotes.length || authorizedRepair.actions.length !== 1 ||
      authorizedRepair.actions.some((action) => action.type !== "build_road" || action.prefab !== FACILITY_ACCESS_ROAD_PREFAB) ||
      !Number.isFinite(authorizedRepair.quote) || authorizedRepair.segmentQuotes.some((quote) => !Number.isFinite(quote) || quote < 0) ||
      authorizedRepair.segmentQuotes.reduce((sum, quote) => sum + quote, 0) !== authorizedRepair.quote ||
      roadCommands.some((command) => ["SUBMITTED", "NATIVE_COMPLETED", "NATIVE_COMPLETION_UNKNOWN", "UNKNOWN", "UNKNOWN_TIMEOUT", "UNKNOWN_TRANSPORT"].includes(command.status))) {
      throw new Error("AUTHORIZED_ACCESS_ROAD_REPAIR_BINDING_OR_ATTEMPT_INDEX_MISMATCH");
    }
    const evidence = await ports.facilityAccessRoadEvidence({ kind: current.kind, scope });
    if (!facilityAccessRoadWorldPrecondition(evidence)) throw new Error("AUTHORIZED_ACCESS_ROAD_REPAIR_PRECONDITION_NO_LONGER_HOLDS");
    const fingerprint = authorizedRepair.courseFingerprint;
    const existingExact = current.candidateLedger.find((candidate) => candidate.actionFingerprint === fingerprint);
    if (existingExact) {
      if (existingExact.authorizationAmendmentId !== authorizedRepair.amendmentId ||
        existingExact.repairAttemptIndex !== authorizedRepair.attemptIndex ||
        existingExact.ledgerState !== "NOT_ATTEMPTED" || existingExact.commandId !== null) {
        throw new Error("AUTHORIZED_ACCESS_ROAD_REPAIR_CANDIDATE_ALREADY_SPENT_OR_MISMATCHED");
      }
    } else {
      const objectiveId = `${scope.projectId}:${scope.trancheId}:water:${currentPlanRevision}:authorized-access-road-repair:${authorizedRepair.attemptIndex}`;
      current.candidateLedger.push({
        candidateId: `${objectiveId}:${authorizedRepair.amendmentId}`,
        objectiveId,
        kind: "facility-access-road",
        repair: FACILITY_ACCESS_ROAD_REPAIR,
        repairAttemptIndex: authorizedRepair.attemptIndex,
        authorizationAmendmentId: authorizedRepair.amendmentId,
        ordinal: current.candidateLedger.length,
        exactActions: structuredClone(authorizedRepair.actions),
        actionFingerprint: fingerprint,
        approvedPlanRevision: authorizedRepair.planRevision,
        repairPlanRevision: authorizedRepair.planRevision,
        executionMechanismRevision: scope.executionMechanismRevision,
        spatialScope: structuredClone(scope.spatialEnvelope),
        budgetCeiling: scope.maximumSpend,
        ledgerState: "NOT_ATTEMPTED",
        commandId: null,
        primitiveEffect: "NOT_OBSERVED",
      });
    }
    current.accessRoadRepair = { status: "PLANNED", quote: authorizedRepair.quote,
      offsetFromAdmittedCourse: 0, plannedAtJournalPosition: null };
    return evidence;
  }
  const priorNativeRepairCommand = input.priorNetworkCommands?.find((command) => {
    try {
      const actions = JSON.parse(command.exactInput ?? "[]") as MayorAction[];
      return Array.isArray(actions) && actions.some((action) => action.type === "build_road" && action.prefab === "Small Road");
    } catch { return false; }
  });
  if (priorNativeRepairCommand) {
    for (const candidate of priorRepairCandidates) {
      if (candidate.actionFingerprint === priorNativeRepairCommand.exactInput || candidate.commandId === priorNativeRepairCommand.commandId) {
        candidate.commandId = priorNativeRepairCommand.commandId;
        candidate.ledgerState = "FAILED_DETERMINISTIC";
        candidate.primitiveEffect = "OBSERVED_MISMATCH";
      }
    }
    if (current.accessRoadRepair && !current.candidateLedger.some((candidate) =>
      candidate.authorizationAmendmentId && candidate.repairAttemptIndex === 2 && candidate.ledgerState === "NOT_ATTEMPTED")) {
      current.accessRoadRepair = { ...current.accessRoadRepair, status: "ATTEMPTED" };
    }
    return null;
  }
  const activeRepair = priorRepairCandidates.find((candidate) => candidate.ledgerState === "NOT_ATTEMPTED" ||
    candidate.ledgerState === "AUTHORIZED" || candidate.ledgerState === "SUBMITTED" ||
    candidate.ledgerState === "RECONCILING" || candidate.ledgerState === "UNKNOWN");
  if (priorRepairCandidates.some((candidate) => candidate.commandId !== null && candidate.approvedPlanRevision !== currentPlanRevision)) {
    throw new Error("ACCESS_ROAD_REPLAN_AFTER_NATIVE_ATTEMPT_FORBIDDEN");
  }
  const serviceRoads = plan.serviceRoads ?? [];
  const lastServiceRoad = serviceRoads.at(-1);
  const activeRepairFunctional = !!activeRepair && !!lastServiceRoad &&
    facilityAccessRoadCourseReachesServicePoint(activeRepair.exactActions, lastServiceRoad.end);
  if (activeRepair && (activeRepair.approvedPlanRevision !== currentPlanRevision || !activeRepairFunctional)) {
    if (activeRepair.commandId !== null) {
      throw new Error("ACCESS_ROAD_REPLAN_AFTER_NATIVE_ATTEMPT_FORBIDDEN");
    }
    activeRepair.ledgerState = "FAILED_DETERMINISTIC";
    if (priorRepairCandidates.length >= 2) throw new Error("STALE_REPAIR_PLAN_REVISION");
    current.accessRoadRepair = null;
  } else if (activeRepair || priorRepairCandidates.some((candidate) => candidate.commandId !== null)) return null;
  const firstServiceRoad = serviceRoads[0];
  if (!firstServiceRoad || !lastServiceRoad) return null;
  const evidence = await ports.facilityAccessRoadEvidence({ kind: current.kind, scope });
  if (!evidence) return null;
  const verdict = facilityAccessRoadRepairVerdict({
    kind: current.kind,
    facilityPlacement: observed.supplyExists && !!current.facility ? "PLACED" : "MISSING",
    connectionEffect: current.commandOutcome,
    roadAttachment: evidence.roadAttachment,
    noRoadAccessWarning: evidence.noRoadAccessWarning,
    cityElectricityCapacitySufficient: evidence.cityElectricityCapacitySufficient,
    planServiceRoadCount: serviceRoads.length,
    // Zero on every reachable path, because the guards above already returned,
    // and read from the durable record rather than assumed: the verdict is a
    // boundary that must hold whatever its caller did.
    priorRepairCommandCount: current.candidateLedger.filter((candidate) =>
      candidate.repair === FACILITY_ACCESS_ROAD_REPAIR && candidate.commandId !== null).length,
    // The duplicate this boundary can prove is a road course down this objective
    // that already reached the world. The plan's own service road is the only road
    // ever planned there, so a bound command on it means the corridor already
    // carries a road and a repair would be a second one.
    duplicateRoadRisk: current.candidateLedger.some((candidate) =>
      candidate.kind === "service-road" && candidate.commandId !== null),
  });
  // The world was read, so it is reported back whatever the verdict says: the
  // caller's pre-wait gate decides on the observation, not on whether a course
  // happened to be appended from it.
  if (verdict.status !== "PERMITTED") return evidence;
  const planned = await ports.planFacilityAccessRoad({
    kind: current.kind,
    scope,
    // The plan's own service-road target: the road contact it must attach to, and
    // the point toward the facility it was planned to reach.
    objective: { start: { ...firstServiceRoad.start }, end: { ...lastServiceRoad.end } },
    // The course the world already carries, which the repair has to clear. The
    // plan's connection course is the geometry this boundary can name without a
    // further world read, and it is the one occupying the corridor.
    admittedCourse: {
      prefab: plan.connection.prefab,
      start: { ...plan.connection.start },
      end: { ...plan.connection.end },
    },
    plan,
  });
  if (planned.status !== "PLANNED") return evidence;
  // Money and geometry are both read or neither is admitted. A course priced by a
  // figure nobody could read is a course the budget amendment would have to
  // refuse later, after the durable record already claimed it was planned.
  if (planned.actions.length === 0) return evidence;
  const plannedFingerprint = JSON.stringify(planned.actions);
  if (priorRepairCandidates.some((candidate) => candidate.actionFingerprint === plannedFingerprint)) return evidence;
  if (!Number.isFinite(planned.quote) || planned.quote < 0) return evidence;
  if (!Number.isFinite(planned.offsetFromAdmittedCourse)) return evidence;
  const revision = current.connectionObjective?.approvedPlanRevision ??
    current.planBinding?.topologyRevision ?? scope.topologyRevision;
  // Deterministic and durable: the current approved revision plus the bounded
  // repair ordinal. No wall clock, no randomness, no LLM. Always the first
  // ordinal, because the guards above admit exactly one repair.
  const ordinal = priorRepairCandidates.length + 1;
  const approvedPlanRevision = revision;
  const objectiveId = `${scope.projectId}:${scope.trancheId}:${current.kind}:${revision}:access-road:${ordinal}`;
  current.candidateLedger.push({
    candidateId: `${objectiveId}:facility-access-road`,
    objectiveId,
    kind: "facility-access-road",
    repair: FACILITY_ACCESS_ROAD_REPAIR,
    ordinal: current.candidateLedger.length,
    exactActions: structuredClone(planned.actions),
    actionFingerprint: plannedFingerprint,
    approvedPlanRevision,
    repairPlanRevision: currentPlanRevision,
    executionMechanismRevision: scope.executionMechanismRevision,
    spatialScope: structuredClone(scope.spatialEnvelope),
    budgetCeiling: scope.maximumSpend,
    ledgerState: "NOT_ATTEMPTED",
    commandId: null,
    primitiveEffect: "NOT_OBSERVED",
  });
  current.accessRoadRepair = {
    status: "PLANNED",
    quote: planned.quote,
    offsetFromAdmittedCourse: planned.offsetFromAdmittedCourse,
    plannedAtJournalPosition: null,
  };
  return evidence;
}

function ensureCandidateLedger(current: DurableGreenfieldUtilityKindState, scope: GreenfieldUtilityExecutionScope): void {
  if (!current.plan || !current.facility || !current.connector) return;
  // Existing ledgers retain the immutable approved revision even when the
  // current-epoch live binding has been refreshed after reload.
  const revision = current.connectionObjective?.approvedPlanRevision ??
    current.planBinding?.topologyRevision ?? scope.topologyRevision;
  const objectiveId = `${scope.projectId}:${scope.trancheId}:${current.kind}:${revision}:${current.facility.entity.index}:${current.connector.node.index}`;
  const planned = buildUtilityConnectionCandidates(current.plan, current.connector);
  if (current.connectionObjective && current.connectionObjective.approvedPlanRevision !== revision) throw new Error("STALE_UTILITY_CONNECTION_PLAN_REVISION");
  current.connectionObjective ??= { objectiveId, approvedPlanRevision: revision, candidateOrder: planned.map((c) => c.primitive), status: "INCOMPLETE", observationBudget: current.maximumObservationWaits, candidateBudget: planned.length };
  if (current.candidateLedger.length > 0) {
    if (current.kind === "electricity" && scope.targetSemantics) {
      const legacyCable = current.candidateLedger.find((candidate) => candidate.kind === "direct-cable" && candidate.targetSemanticFingerprint === undefined);
      if (legacyCable) {
        const approvedCable = planned.find((candidate) => candidate.primitive === "direct-cable");
        const result = materializeLegacyDirectCableSemanticFingerprint({
          candidate: legacyCable,
          approvedExactActions: approvedCable?.actions ?? [],
          approvedCablePrefab: current.plan.connection.prefab,
          semantic: scope.targetSemantics,
        });
        if (result.status === "FAIL") throw new Error(`UTILITY_LEGACY_DIRECT_CABLE_SEMANTIC_MATERIALIZATION_REJECTED:${result.reason}`);
        const candidateId = legacyCable.candidateId;
        const exactActions = JSON.stringify(legacyCable.exactActions);
        const actionFingerprint = legacyCable.actionFingerprint;
        const approvedPlanRevision = legacyCable.approvedPlanRevision;
        legacyCable.targetSemanticFingerprint = result.targetSemanticFingerprint;
        if (legacyCable.candidateId !== candidateId || JSON.stringify(legacyCable.exactActions) !== exactActions ||
          legacyCable.actionFingerprint !== actionFingerprint || legacyCable.approvedPlanRevision !== approvedPlanRevision) {
          throw new Error("UTILITY_LEGACY_DIRECT_CABLE_SEMANTIC_MATERIALIZATION_MUTATED_IMMUTABLE_IDENTITY");
        }
      }
    }
    return;
  }
  current.candidateLedger = planned.map((candidate, index) => ({
    candidateId: `${objectiveId}:${candidate.primitive}`, objectiveId, kind: candidate.primitive, ordinal: index,
    exactActions: structuredClone(candidate.actions), approvedPlanRevision: revision,
    executionMechanismRevision: scope.executionMechanismRevision,
    actionFingerprint: JSON.stringify(candidate.actions),
    ...(scope.targetSemantics ? { targetSemanticFingerprint: JSON.stringify(scope.targetSemantics) } : {}),
    spatialScope: structuredClone(scope.spatialEnvelope), budgetCeiling: scope.maximumSpend,
    ledgerState: "NOT_ATTEMPTED", commandId: null, primitiveEffect: "NOT_OBSERVED",
  }));
  if (current.commandOutcome === "OBSERVED_MATCH" && current.networkCommandIds.length > 0) {
    // The same semantic for both road primitives: a course that reached the world
    // and whose command matched is observed, not merely attempted. The access
    // road is a road course like the plan's service road, and leaving it
    // NOT_ATTEMPTED after a match would re-offer its own geometry to the replan.
    for (const kind of ["service-road", "facility-access-road"] as const) {
      const road = current.candidateLedger.find((candidate) => candidate.kind === kind);
      if (road) { road.ledgerState = "OBSERVED_MATCH"; road.primitiveEffect = "OBSERVED_MATCH"; road.commandId = current.networkCommandIds[0]; }
    }
  }
}

export function utilityConnectionCandidateContextFingerprint(input: {
  binding: UtilityCurrentBinding;
  scope: GreenfieldUtilityExecutionScope;
}): string {
  const { binding, scope } = input;
  const identity = {
    worldId: scope.worldId,
    worldEpochId: scope.worldEpochId,
    generation: scope.generation,
    topologyRevision: scope.topologyRevision,
    placementScopeId: scope.placementScopeId ?? "utility-placement:legacy",
    facility: { entity: binding.facility.entity, prefab: binding.facility.prefab, position: binding.facility.position },
    connector: { entity: binding.connector.node, position: binding.connector.worldPosition },
    targetServiceEntry: scope.targetServiceEntry,
    targetSemantics: scope.targetSemantics ?? null,
    certifiedRoadRefs: [...scope.certifiedRoadRefs]
      .map((ref) => `${ref.index}:${ref.version}`).sort(),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function utilityConnectionPlanMatchesTarget(
  plan: PlannedUtilityFacility | null,
  kind: GreenfieldUtilityKind,
  scope: GreenfieldUtilityExecutionScope,
): boolean {
  if (kind !== "electricity" || !plan || !scope.targetSemantics) return true;
  const end = plan.connection?.end;
  const target = scope.targetSemantics.approvedContact;
  return !!end && Number.isFinite(end.x) && Number.isFinite(end.z) &&
    Math.hypot(end.x - target.x, end.z - target.z) <= 0.25;
}

function rebindCandidateLedgerToCurrentContext(input: {
  current: DurableGreenfieldUtilityKindState;
  plan: PlannedUtilityFacility;
  binding: UtilityCurrentBinding;
  scope: GreenfieldUtilityExecutionScope;
  contextFingerprint: string;
  force?: boolean;
}): void {
  const { current, plan, binding, scope, contextFingerprint } = input;
  const priorFingerprint = current.connectionCandidateContextFingerprint;
  if (priorFingerprint === contextFingerprint && input.force !== true) return;

  const staleUnspent = current.candidateLedger.filter((candidate) =>
    candidate.ledgerState === "NOT_ATTEMPTED" && candidate.commandId === null && !candidate.repair && !candidate.networkLinkRepair);
  const retained = current.candidateLedger.filter((candidate) => !staleUnspent.includes(candidate));
  const spentFingerprints = new Set(retained.map((candidate) => candidate.actionFingerprint));
  const revision = `${scope.topologyRevision}:connection-context:${contextFingerprint}`;
  const objectiveId = `${scope.projectId}:${scope.trancheId}:${current.kind}:${revision}:${binding.facility.entity.index}:${binding.facility.entity.version}:${binding.connector.node.index}:${binding.connector.node.version}`;
  const planned = buildUtilityConnectionCandidates(plan, binding.connector)
    .filter((candidate) => !spentFingerprints.has(JSON.stringify(candidate.actions)));
  const replacements: DurableUtilityPrimitiveCandidate[] = planned.map((candidate, index) => ({
    candidateId: `${objectiveId}:${candidate.primitive}`,
    objectiveId,
    kind: candidate.primitive,
    ordinal: index,
    exactActions: structuredClone(candidate.actions),
    actionFingerprint: JSON.stringify(candidate.actions),
    approvedPlanRevision: revision,
    executionMechanismRevision: scope.executionMechanismRevision,
    spatialScope: structuredClone(scope.spatialEnvelope),
    budgetCeiling: scope.maximumSpend,
    ledgerState: "NOT_ATTEMPTED",
    commandId: null,
    primitiveEffect: "NOT_OBSERVED",
    ...(scope.targetSemantics ? { targetSemanticFingerprint: JSON.stringify(scope.targetSemantics) } : {}),
  }));
  const retainedIds = current.candidateLedger.map((candidate) => candidate.candidateId);
  const removedIds = staleUnspent.map((candidate) => candidate.candidateId);
  current.candidateLedger = [...retained, ...replacements];
  current.connectionObjective = {
    objectiveId,
    approvedPlanRevision: revision,
    candidateOrder: planned.map((candidate) => candidate.primitive),
    status: "INCOMPLETE",
    observationBudget: current.maximumObservationWaits,
    candidateBudget: planned.length,
  };
  current.connectionCandidateContextFingerprint = contextFingerprint;
  current.connectionReplan.journal.push({
    event: "CONNECTION_CONTEXT_REBOUND",
    supersededPlanRevision: current.planBinding?.topologyRevision ?? scope.topologyRevision,
    supersededCandidateIds: removedIds.length > 0 ? removedIds : retainedIds,
    approvedPlanRevision: revision,
    candidateIds: replacements.map((candidate) => candidate.candidateId),
    previousContextFingerprint: priorFingerprint,
    currentContextFingerprint: contextFingerprint,
    reason: "AUTHORITATIVE_FACILITY_CONNECTOR_OR_TARGET_TOPOLOGY_CHANGED",
  });
}

function syncCandidateCommands(current: DurableGreenfieldUtilityKindState, commands?: Array<{ commandId: string; status: string; exactInput?: string }>): void {
  for (const command of commands ?? []) {
    const candidate = current.candidateLedger.find((entry) => entry.exactActions.length > 0 && entry.exactActions.length === (() => { try { return JSON.parse(command.exactInput ?? "[]").length; } catch { return -1; } })() && JSON.stringify(entry.exactActions) === command.exactInput);
    if (!candidate) continue;
    candidate.commandId = command.commandId;
    if (command.status === "OBSERVED_MATCH") { candidate.ledgerState = "OBSERVED_MATCH"; candidate.primitiveEffect = "OBSERVED_MATCH"; }
    else if (["SUBMITTED", "NATIVE_COMPLETED", "NATIVE_COMPLETION_UNKNOWN", "UNKNOWN_TIMEOUT", "UNKNOWN_TRANSPORT"].includes(command.status)) candidate.ledgerState = command.status === "SUBMITTED" ? "SUBMITTED" : "RECONCILING";
    else if (command.status === "REJECTED" || command.status === "OBSERVED_MISMATCH") { candidate.ledgerState = "FAILED_DETERMINISTIC"; candidate.primitiveEffect = "OBSERVED_MISMATCH"; }
  }
}

export function createDurableGreenfieldUtilityState(
  scope: GreenfieldUtilityExecutionScope,
): DurableGreenfieldUtilityState {
  assertGreenfieldUtilityScope(scope);
  return {
    schemaVersion: "ai-mayor-v2-greenfield-utility-execution/1",
    scope: structuredClone(scope),
    utilities: {
      electricity: initialKind("electricity"),
      water: initialKind("water"),
      sewage: initialKind("sewage"),
    },
  };
}

/** Persist a fail-closed human decision boundary after Stage B proved the
 * current facility cannot be completed with existing execution capabilities. */
export function markFacilityAwaitingProductDecision(input: {
  state: DurableGreenfieldUtilityState;
  kind: GreenfieldUtilityKind;
  reason: string;
}): DurableGreenfieldUtilityState {
  if (!input.reason.trim()) throw new Error("PRODUCT_DECISION_REASON_REQUIRED");
  const next = structuredClone(input.state);
  const facility = next.utilities[input.kind];
  if (!facility.facility || !facility.facilityCommandId || facility.stage !== "PLACED") {
    throw new Error("PRODUCT_DECISION_REQUIRES_AUTHORITATIVE_PLACED_FACILITY");
  }
  facility.stage = "PLACED_AWAITING_PRODUCT_DECISION";
  facility.lastRecoveryReason = input.reason;
  return next;
}

function assertCurrentBinding(state: DurableGreenfieldUtilityState, scope: GreenfieldUtilityExecutionScope): void {
  if (state.schemaVersion !== "ai-mayor-v2-greenfield-utility-execution/1" ||
    state.scope.projectId !== scope.projectId || state.scope.trancheId !== scope.trancheId) {
    throw new Error("STALE_UTILITY_EXECUTION_SCOPE");
  }
}

function rebindReloadedState(
  state: DurableGreenfieldUtilityState,
  scope: GreenfieldUtilityExecutionScope,
): DurableGreenfieldUtilityState {
  if (state.scope.worldEpochId === scope.worldEpochId && state.scope.generation === scope.generation) {
    if (state.scope.topologyRevision !== scope.topologyRevision) {
      const hasPlanContinuation = scopeKinds(scope).some((kind) => state.utilities[kind].planBinding !== null || state.utilities[kind].plan !== null);
      if (hasPlanContinuation) throw new Error("STALE_UTILITY_TOPOLOGY_PLAN");
      const rebound = structuredClone(state);
      rebound.scope = structuredClone(scope);
      for (const kind of scopeKinds(scope)) {
        const current = rebound.utilities[kind];
        current.stage = current.plan && current.constructionAttempts > 0 ? "PLACED" : "MISSING";
        current.planBinding = null;
        current.facility = null;
        current.connector = null;
        current.progression = null;
        current.serviceEvidence = null;
        current.commandOutcome = "NONE";
      }
      return rebound;
    }
    // Same world generation: the recorded scope still describes this world, but
    // its spend ceiling is a snapshot of the AUTHORIZATION taken when the
    // execution began, and an append-only budget amendment can have raised that
    // authorization since. The live scope carries the effective budget, so a
    // snapshot that is lower must not be what the durable state reads back —
    // a later run would otherwise under-fund a slice that is, durably, funded.
    //
    // Raise-only, and only the one field: this can never lower what the project
    // is authorized to spend, and it moves no identity, no reservation and no
    // scope.
    if (scope.maximumSpend > state.scope.maximumSpend) {
      const refreshed = structuredClone(state);
      refreshed.scope.maximumSpend = scope.maximumSpend;
      return refreshed;
    }
    return state;
  }
  const rebound = structuredClone(state);
  rebound.scope = structuredClone(scope);
  for (const kind of scopeKinds(scope)) {
    const current = rebound.utilities[kind];
    current.stage = current.plan && current.constructionAttempts > 0 ? "PLACED" : "MISSING";
    current.planBinding = null;
    current.facility = null;
    current.connector = null;
    current.progression = null;
    current.serviceEvidence = null;
    current.commandOutcome = "NONE";
  }
  return rebound;
}

export async function runScopedGreenfieldUtilityBootstrap(input: {
  scope: GreenfieldUtilityExecutionScope;
  ports: ScopedGreenfieldUtilityPorts;
}): Promise<{ serviceCertified: boolean; state: DurableGreenfieldUtilityState; waiting: boolean; reason: string;
  providerInvocations: 0; legacyBrainInvocations: 0 }> {
  assertGreenfieldUtilityScope(input.scope);
  const directCableOnly = process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY === "1";
  let state = (await input.ports.load(input.scope)) ?? createDurableGreenfieldUtilityState(input.scope);
  assertCurrentBinding(state, input.scope);
  state = rebindReloadedState(state, input.scope);
  await input.ports.save(state);
  for (const kind of scopeKinds(input.scope)) {
    let current = normalizeKindState(state.utilities[kind]);
    if (current.stage === "PLACED_AWAITING_PRODUCT_DECISION") {
      return { serviceCertified: false, state, waiting: true, reason: "PLACED_FACILITY_AWAITS_PRODUCT_DECISION",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    if (input.ports.rebind && current.plan && current.constructionAttempts > 0) {
      const rebound = await input.ports.rebind(kind, current, input.scope);
      if (rebound.status === "UNKNOWN") {
        current.serviceEvidence = null;
        state.utilities[kind] = current;
        await input.ports.save(state);
        return { serviceCertified: false, state, waiting: true, reason: rebound.reason,
          providerInvocations: 0, legacyBrainInvocations: 0 };
      }
      if (rebound.status === "PROVEN_MISSING") {
        current.serviceEvidence = null;
        current.stage = "BLOCKED";
        state.utilities[kind] = current;
        await input.ports.save(state);
        return { serviceCertified: false, state, waiting: false, reason: rebound.reason,
          providerInvocations: 0, legacyBrainInvocations: 0 };
      }
      current.facility = rebound.facility;
      current.connector = rebound.connector;
      current.stage = "PLACED";
      // The approved plan revision/candidate identity is immutable. Only the
      // current-epoch binding metadata is refreshed after authoritative rebind.
      const retainedPlanRevision = current.connectionObjective?.approvedPlanRevision ??
        current.candidateLedger.find((candidate) => candidate.repair === FACILITY_ACCESS_ROAD_REPAIR)?.repairPlanRevision ??
        current.candidateLedger.find((candidate) => candidate.repair === FACILITY_ACCESS_ROAD_REPAIR)?.approvedPlanRevision.replace(/:access-road:\d+$/, "") ??
        current.planBinding?.topologyRevision ?? input.scope.topologyRevision;
      current.connectionObjective ??= {
        objectiveId: `${input.scope.projectId}:${input.scope.trancheId}:${kind}:${retainedPlanRevision}`,
        approvedPlanRevision: retainedPlanRevision,
        candidateOrder: current.plan ? buildUtilityConnectionCandidates(current.plan, current.connector).map((candidate) => candidate.primitive) : [],
        status: "INCOMPLETE", observationBudget: current.maximumObservationWaits,
        candidateBudget: current.candidateLedger.length,
      };
      current.planBinding = {
        projectId: input.scope.projectId,
        worldEpochId: input.scope.worldEpochId,
        topologyRevision: input.scope.topologyRevision,
      };
    }
    // The observation port reads the authoritative scoped state from durable
    // storage. Persist the current-epoch facility/connector rebind before
    // observing so canonical-facility reuse is visible to the direct-cable
    // admission guard; never fall back to creating setup mutations.
    state.utilities[kind] = current;
    await input.ports.save(state);
    const observed = await input.ports.observe(kind, input.scope);
    current.serviceEvidence = observed;
    if (observed.supplyExists && observed.facility) current.facility = observed.facility;
    if (observed.connector) current.connector = observed.connector;
    const networkInspection = await input.ports.inspectNetworkCommands?.({ scope: input.scope, state: current }) ?? {
      commandIds: current.networkCommandIds,
      // Only a recorded network command can be uncertain. A first facility
      // placement can leave the durable outcome UNKNOWN before any connection
      // command exists, and reading that placement-derived value as network
      // uncertainty holds the workflow in UTILITY_RECONCILIATION_REQUIRED
      // forever. An empty network command list therefore resolves to NONE.
      uncertain: current.networkCommandIds.length > 0 &&
        (current.commandOutcome === "SUBMITTED" || current.commandOutcome === "UNKNOWN"),
      authoritativeEffect: observed.networkConnected === true || observed.targetNetworkReachable === true,
    };
    current.networkCommandIds = [...new Set([...current.networkCommandIds, ...networkInspection.commandIds])];
    const authoritativeNetworkEffect = networkInspection.authoritativeEffect === true;
    // `commandOutcome` describes the connection/network commands only. A first
    // facility placement is tracked by `facilityCommandId` and the durable
    // placement guard, and its native batch boundary cannot always certify
    // completion. A placement-derived UNKNOWN must never persist here: it would
    // hold the workflow in UTILITY_RECONCILIATION_REQUIRED forever, so an empty
    // network command list resolves to NONE instead of keeping the stale value.
    // The declared union is kept explicit so the downstream UNKNOWN/SUBMITTED
    // reconciliation gates still read as reachable types.
    const networkOutcome: DurableGreenfieldUtilityKindState["commandOutcome"] = authoritativeNetworkEffect
      ? "OBSERVED_MATCH"
      : networkInspection.uncertain ? "UNKNOWN"
        : current.networkCommandIds.length > 0 ? "OBSERVED_MISMATCH" : "NONE";
    current.commandOutcome = networkOutcome;
    if (isScopedUtilityServiceCertified(observed, input.scope)) {
      current.stage = "SERVICE_CERTIFIED";
      state.utilities[kind] = current;
      await input.ports.save(state);
      await input.ports.afterKindCertified?.({ kind, state });
      continue;
    }
    if (observed.status === "UNKNOWN") {
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: true, reason: "UTILITY_OBSERVATION_UNKNOWN",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    if (networkInspection.uncertain || (current.commandOutcome as string) === "SUBMITTED" || current.commandOutcome === "UNKNOWN") {
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: true, reason: "UTILITY_RECONCILIATION_REQUIRED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    syncCandidateCommands(current, networkInspection.commands);
    const utilityRevision = input.ports.currentUtilityRevision?.();
    if (utilityRevision !== undefined && current.plan !== null && current.basedOnUtilityRevision !== utilityRevision) {
      // Stale derived planning data is discarded only after all pending native
      // commands were authoritatively reconciled above. This cache comparison
      // never participates in construction admission or native legality.
      current.plan = null;
      current.planBinding = null;
      current.connectionCandidateContextFingerprint = undefined;
    }
    if (utilityRevision !== undefined) current.basedOnUtilityRevision = utilityRevision;
    if (observed.supplyExists && current.facility && current.connector && input.ports.planCurrentConnection) {
      const currentBinding: UtilityCurrentBinding = { facility: current.facility, connector: current.connector };
      const contextFingerprint = utilityConnectionCandidateContextFingerprint({ binding: currentBinding, scope: input.scope });
      const targetPlanMismatch = !utilityConnectionPlanMatchesTarget(current.plan, kind, input.scope);
      const missingElectricityNetworkExtension = kind === "electricity" && observed.targetNetworkReachable === false &&
        current.plan?.connectionEndpointBindings === undefined;
      if (current.connectionCandidateContextFingerprint !== contextFingerprint || targetPlanMismatch || missingElectricityNetworkExtension) {
        const refreshedPlan = await input.ports.planCurrentConnection(kind, currentBinding, input.scope);
        admitScopedGreenfieldUtilityPlan({ kind, scope: input.scope, plan: refreshedPlan });
        current.plan = refreshedPlan;
        if (utilityRevision !== undefined) current.basedOnUtilityRevision = utilityRevision;
        current.planBinding = {
          projectId: input.scope.projectId,
          worldEpochId: input.scope.worldEpochId,
          topologyRevision: input.scope.topologyRevision,
        };
        rebindCandidateLedgerToCurrentContext({ current, plan: refreshedPlan, binding: currentBinding,
          scope: input.scope, contextFingerprint, force: targetPlanMismatch || missingElectricityNetworkExtension });
        state.utilities[kind] = current;
        await input.ports.save(state);
      }
    }
    const connectionRecoveryAllowed = canConsumeConnectionPrimitiveFallbackRecovery({
      state: current,
      observed,
      uncertainNetworkCommand: networkInspection.uncertain,
      authoritativeNetworkEffect,
    });
    if (connectionRecoveryAllowed) current.progression = null;
    const binding = current.planBinding;
    if (binding && (binding.projectId !== input.scope.projectId || binding.worldEpochId !== input.scope.worldEpochId ||
      binding.topologyRevision !== input.scope.topologyRevision)) {
      throw new Error("STALE_UTILITY_TOPOLOGY_PLAN");
    }
    // The one place a plan is derived, so the repair, the selection and the
    // execution below are provably reading the same admitted plan and none of
    // them can run against a null one. It is a closure rather than an inline
    // block because the observation-budget branch further down still has to
    // discard a plan and re-derive it inside the same invocation.
    const admitPlan = async (): Promise<PlannedUtilityFacility> => {
      current.plan = await input.ports.plan(kind, input.scope);
      if (utilityRevision !== undefined) current.basedOnUtilityRevision = utilityRevision;
      admitScopedGreenfieldUtilityPlan({ kind, scope: input.scope, plan: current.plan });
      current.planBinding = {
        projectId: input.scope.projectId,
        worldEpochId: input.scope.worldEpochId,
        topologyRevision: input.scope.topologyRevision,
      };
      return current.plan;
    };
    let admittedPlan = current.plan ?? await admitPlan();
    ensureCandidateLedger(current, input.scope);
    if (input.scope.executionMechanismRevision) {
      ensureMechanismRevisionRetry(current, input.scope.executionMechanismRevision);
    }
    rearmUnverifiedPreflightRejections(current);
    const unresolvedCandidate = current.candidateLedger.find((candidate) =>
      candidate.ledgerState === "AUTHORIZED" || candidate.ledgerState === "SUBMITTED" ||
      candidate.ledgerState === "RECONCILING" || candidate.ledgerState === "UNKNOWN");
    if (unresolvedCandidate) {
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: true, reason: "UTILITY_RECONCILIATION_REQUIRED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    // The bounded road-access repair is decided BEFORE any candidate is selected
    // and BEFORE the workflow decides whether it may wait, so a repair course it
    // appends is visible to both rather than one invocation late. A refusal
    // appends nothing and changes nothing.
    const accessRoadEvidence = await ensureFacilityAccessRoadRepair({
      current, scope: input.scope, observed, plan: admittedPlan,
      priorNetworkCommands: networkInspection.commands,
      ports: input.ports,
    });
    // An actionable repair outranks a passive wait, and the order of these two
    // questions is the point of this placement.
    //
    // The wait below says "nothing left to do but let the world catch up". That is
    // not true while this slice still owes the world a course it has already
    // derived, priced and been funded for, whose whole purpose is to clear the
    // very blocker being waited on. A facility with no road frontage has no
    // low-voltage electricity either — this engine carries it along the road
    // network — so the service it is waiting for cannot appear however long the
    // workflow waits, and a slice parked here only escapes later by discarding
    // the authority it was waiting under.
    //
    // Both halves are required, and each fails closed in its own direction. An
    // unspent course with no world read is not a satisfied precondition, so it
    // does not skip the wait; and a world that no longer says the frontage is
    // missing no longer wants this course, so it does not skip the wait either.
    // Only a slice that holds the course AND is still told by the engine that it
    // needs one acts before waiting.
    const pendingRepairCourse = unspentAccessRoadRepairCourse(current);
    const repairStillRequired = pendingRepairCourse !== null &&
      facilityAccessRoadWorldPrecondition(
        accessRoadEvidence ?? (input.ports.facilityAccessRoadEvidence
          ? await input.ports.facilityAccessRoadEvidence({ kind, scope: input.scope })
          : null),
      );
    if (!repairStillRequired && current.progression) {
      const progress = await input.ports.progress({ scope: input.scope, kind, prior: current.progression });
      current.progression = { startFrame: progress.startFrame, targetFrame: progress.targetFrame,
        checks: (current.progression?.checks ?? 0) + 1, maximumChecks: current.progression?.maximumChecks ?? 60 };
      state.utilities[kind] = current;
      await input.ports.save(state);
      if (progress.status !== "TARGET_REACHED") {
        return { serviceCertified: false, state, waiting: true, reason: progress.status,
          providerInvocations: 0, legacyBrainInvocations: 0 };
      }
      current.progression = null;
      current.serviceEvidence = await input.ports.observe(kind, input.scope);
      if (isScopedUtilityServiceCertified(current.serviceEvidence, input.scope)) {
        current.stage = "SERVICE_CERTIFIED";
        state.utilities[kind] = current;
        await input.ports.save(state);
        await input.ports.afterKindCertified?.({ kind, state });
        continue;
      }
      current.observationWaits += 1;
      if (current.observationWaits <= current.maximumObservationWaits) {
        const next = await input.ports.progress({ scope: input.scope, kind, prior: null });
        current.progression = { startFrame: next.startFrame, targetFrame: next.targetFrame, checks: 0, maximumChecks: 60 };
        current.stage = "WAITING_FOR_SERVICE_UPDATE";
        state.utilities[kind] = current;
        await input.ports.save(state);
        return { serviceCertified: false, state, waiting: true, reason: "UTILITY_SERVICE_NOT_YET_CERTIFIED",
          providerInvocations: 0, legacyBrainInvocations: 0 };
      }
      // The observation budget bounds the passive wait; it does not revoke
      // authority. While a repair course is planned and unspent, the plan and its
      // binding are what that course was derived from, so clearing them would
      // orphan the one actionable answer this slice holds and drop it back into
      // greenfield planning for a facility that is already in the world. A budget
      // that runs out is a reason to stop waiting, never a reason to forget what
      // is left to do.
      if (!unspentAccessRoadRepairCourse(current)) {
        current.plan = null;
        current.planBinding = null;
        // Discarded AND re-derived, in this invocation: a wait that ran out is
        // the workflow's cue to reconsider its plan, and reconsidering it is only
        // meaningful if the rest of this invocation runs against the new one.
        admittedPlan = await admitPlan();
      }
    }
    // Once authoritative topology reaches the target, an incomplete service is
    // a simulation/readback gap. Start the existing bounded progression port
    // before considering any connection candidate again; no cable or facility
    // action can advance this predicate while the service model is stale.
    if (observed.targetNetworkReachable === true && current.connector?.attached === true &&
      !isScopedUtilityServiceCertified(observed, input.scope) && !current.progression) {
      const progress = await input.ports.progress({ scope: input.scope, kind, prior: null });
      current.progression = { startFrame: progress.startFrame, targetFrame: progress.targetFrame,
        checks: 0, maximumChecks: 60 };
      current.stage = "WAITING_FOR_SERVICE_UPDATE";
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: progress.status !== "TARGET_REACHED",
        reason: progress.status, providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    const facilityExists = observed.supplyExists && !!current.facility;
    const attemptableCandidate = (candidate: DurableUtilityPrimitiveCandidate) =>
      candidate.ledgerState === "NOT_ATTEMPTED" &&
      ((!directCableOnly || candidate.kind === "direct-cable") ||
        (candidate.kind === "facility-access-road" && candidate.repair === FACILITY_ACCESS_ROAD_REPAIR)) &&
      // With a facility already in the world the execution boundary continues
      // connection-only, and that boundary offers the direct cable alone. A
      // placement-phase primitive (the service road) is no longer attemptable, so
      // pinning it here asks the boundary for a candidate it cannot build and
      // dead-ends the approved objective instead of finishing the connection.
      //
      // The access road is the one exception, and it is named explicitly rather
      // than admitted by relaxation: it is a connection-only primitive built for
      // exactly this state, and it is only attemptable while it carries the repair
      // marker the repair step set. A plan-derived service road still is not.
      (!facilityExists || candidate.kind === "direct-cable" ||
        (candidate.kind === "facility-access-road" && candidate.repair === FACILITY_ACCESS_ROAD_REPAIR));
    // A deterministic native verdict refused one course, not the objective. When
    // every approved course is spent and the world still offers a different one,
    // replan from the current authoritative topology instead of dead-ending. The
    // refused candidate stays durably FAILED_DETERMINISTIC and is never re-admitted.
    if (facilityExists && !current.candidateLedger.some(attemptableCandidate) && canReplanConnectionCourse(current)) {
      replanConnectionCourse(current, input.scope, attemptableCandidate);
    }
    // A planned repair is preferred over any other attemptable course, and it is
    // recognized by what it is rather than by the ordinal the lineage happens to
    // have reached: the candidate carries the ordinal its own authorization was
    // minted for, so matching a literal here wrote the ordinal down twice.
    // A rehydrated repair is preferred over any other attemptable course, and it
    // is recognized by what it IS -- a repair course carrying the authorization
    // it was minted under -- rather than by the ordinal the lineage happens to
    // have reached, which is the authorization's own immutable field and not a
    // literal this selection may write down a second time.
    const selectedCandidate = (current.accessRoadRepair?.status === "PLANNED"
      ? current.candidateLedger.find((candidate) => candidate.repair === FACILITY_ACCESS_ROAD_REPAIR &&
        candidate.authorizationAmendmentId !== undefined && attemptableCandidate(candidate))
      : undefined) ?? current.candidateLedger.find(attemptableCandidate);
    const useConnectionRecovery = canConsumeConnectionPrimitiveFallbackRecovery({
      state: current,
      observed,
      uncertainNetworkCommand: networkInspection.uncertain,
      authoritativeNetworkEffect,
    });
    if (!facilityExists && current.constructionAttempts >= current.maximumConstructionAttempts) {
      current.stage = "BLOCKED";
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: false, reason: "UTILITY_CONSTRUCTION_ATTEMPTS_EXHAUSTED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    if (directCableOnly && !facilityExists) {
      current.stage = "BLOCKED";
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: false, reason: "DIRECT_CABLE_CANONICAL_FACILITY_REQUIRED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    // "Nothing attemptable" is exhaustion only while the connection is missing.
    //
    // Every approved course being spent means the objective is dead ONLY if the
    // world still lacks the connection. Once the facility's own connector carries
    // an external edge, the physical goal is already met — the courses are spent
    // because there is nothing left to DO, not because the workflow ran out of
    // ideas — and blocking here left a slice whose service was live permanently
    // uncertifiable, unable to re-submit the pipe it had already built (the
    // durable write contract refuses duplicates) and never asked to certify it.
    //
    // Falling through is not a shortcut: `execute` re-reads the authoritative
    // state and resolves it as `no_action_needed`, or reports whatever is
    // actually wrong. The certifying decision stays where it was.
    const connectionAlreadyPresent = current.connector?.attached === true;
    if (facilityExists && !selectedCandidate && !connectionAlreadyPresent) {
      current.stage = "BLOCKED";
      if (current.connectionObjective) current.connectionObjective.status = "BLOCKED";
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: false,
        reason: "UTILITY_CONNECTION_CANDIDATES_EXHAUSTED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    if (useConnectionRecovery) consumeConnectionRecovery(current);
    state.utilities[kind] = current;
    await input.ports.save(state);
    const executed = await input.ports.execute({
      scope: input.scope, state: current, plan: admittedPlan, selectedPrimitive: selectedCandidate?.kind,
      selectedCandidateId: selectedCandidate?.candidateId,
      onAuthorized: selectedCandidate ? async ({ commandId, actionFingerprint }) => {
        const authorizedCandidate = current.candidateLedger.find((candidate) => candidate.candidateId === selectedCandidate.candidateId);
        if (!authorizedCandidate) throw new Error("UTILITY_AUTHORIZED_CANDIDATE_MISSING");
        if (authorizedCandidate.actionFingerprint !== actionFingerprint) throw new Error("UTILITY_AUTHORIZED_CANDIDATE_FINGERPRINT_MISMATCH");
        authorizedCandidate.commandId = commandId;
        authorizedCandidate.ledgerState = "AUTHORIZED";
        if (!current.networkCommandIds.includes(commandId)) current.networkCommandIds.push(commandId);
        state.utilities[kind] = current;
        await input.ports.save(state);
      } : undefined,
    });
    current = executed.state;
    if (executed.facilityConstructionAttempted) current.constructionAttempts += 1;
    if (executed.facilityCommandId !== undefined) current.facilityCommandId = executed.facilityCommandId;
    if (executed.networkCommandIds) current.networkCommandIds = [...new Set([...current.networkCommandIds, ...executed.networkCommandIds])];
    if (executed.selectedConnectionPrimitive) current.selectedConnectionPrimitive = executed.selectedConnectionPrimitive;
    current.lastRecoveryReason = executed.reason;
    current.connectionDiagnostics = executed.connectionDiagnostics ?? [];
    current.preflightDiagnostics = executed.preflightDiagnostics ?? [];
    current.nativeTelemetry = executed.nativeTelemetry;
    const executedCandidate = selectedCandidate && current.candidateLedger.find((candidate) => candidate.candidateId === selectedCandidate.candidateId);
    if (executedCandidate) {
      // The selected candidate's command was durably bound before native submission.
      // Never infer it from the scope-wide accumulated command list.
      executedCandidate.commandId ??= selectedCandidate.commandId;
      // Only a rejection that reached native validation is a verdict on the
      // course. A rejection raised by a live-binding precondition produced no
      // verdict, so the primitive stays attemptable and is re-validated on the
      // next bounded invocation instead of exhausting the objective.
      const nativePreflightRejection = executed.connectionDiagnostics?.some((diagnostic) =>
        diagnostic.candidate === executedCandidate.kind && diagnostic.rejectionKind !== "PRECONDITION");
      executedCandidate.ledgerState = executed.networkSubmissionAttempted
        ? (current.commandOutcome === "UNKNOWN" || current.commandOutcome === "SUBMITTED" ? "UNKNOWN" : executed.executionSucceeded ? "OBSERVED_MATCH" : "FAILED_DETERMINISTIC")
        : (nativePreflightRejection ? "PREFLIGHT_REJECTED" : executedCandidate.ledgerState);
      if (executedCandidate.ledgerState === "PREFLIGHT_REJECTED") executedCandidate.preflightVerdict = "NATIVE_REJECTED";
      executedCandidate.primitiveEffect = executedCandidate.ledgerState === "OBSERVED_MATCH" ? "OBSERVED_MATCH" : executedCandidate.ledgerState === "UNKNOWN" ? "UNKNOWN" : "NOT_OBSERVED";
      // The bounded repair is spent the moment its course reaches the engine,
      // whether or not the world accepted it. Recording that here is what keeps a
      // resume from planning and pricing a second one.
      //
      // "Reached the engine" is the condition, and it is read rather than assumed:
      // a course that a live-binding precondition refused never left this process,
      // its ledger entry stays re-validatable, and marking the durable record spent
      // would be the record claiming an attempt the journal can prove never
      // happened. A bound command id does count — the write-ahead identity is
      // minted immediately before submission — so a crash inside that window is
      // still recorded as spent, which is the fail-closed direction.
      const repairReachedTheEngine = executed.networkSubmissionAttempted || executedCandidate.commandId !== null;
      if (executedCandidate.repair === FACILITY_ACCESS_ROAD_REPAIR && current.accessRoadRepair && repairReachedTheEngine) {
        current.accessRoadRepair = { ...current.accessRoadRepair, status: "ATTEMPTED" };
      }
    }
    current.lastFailureBoundary = executed.failedBeforeNetworkSubmission
      ? "PRE_NATIVE_NETWORK_SUBMISSION"
      : executed.networkSubmissionAttempted ? "NATIVE_NETWORK_SUBMISSION" : current.lastFailureBoundary;
    if (executed.authorizedSpend !== undefined) current.authorizedSpend = executed.authorizedSpend;
    state.utilities[kind] = current;
    await input.ports.save(state);
    if (current.commandOutcome === "SUBMITTED" || current.commandOutcome === "UNKNOWN") {
      return { serviceCertified: false, state, waiting: true, reason: "UTILITY_RECONCILIATION_REQUIRED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    if (!executed.executionSucceeded) {
      current.stage = current.facility ? "PLACED" : "BLOCKED";
      current.progression = null;
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: false, reason: executed.reason,
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
  if ((input.scope.facilityPlacementOnly || input.scope.deferConnectionUntilPlaced) && current.facility && current.facilityCommandId) {
      current.stage = "PLACED";
      current.progression = null;
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: true, reason: "FACILITY_PLACED_STAGE_B_READBACK_REQUIRED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    // A primitive match is not objective completion. Re-enter on the next bounded
    // invocation so the next approved candidate can be freshly revalidated.
    if (executedCandidate?.ledgerState === "OBSERVED_MATCH" && !isScopedUtilityServiceCertified(current.serviceEvidence ?? observed, input.scope)) {
      current.progression = null;
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: false, reason: "UTILITY_CONNECTION_OBJECTIVE_INCOMPLETE",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    const progress = await input.ports.progress({ scope: input.scope, kind, prior: current.progression });
    current.progression = { startFrame: progress.startFrame, targetFrame: progress.targetFrame,
      checks: 0, maximumChecks: 60 };
    current.stage = "WAITING_FOR_SERVICE_UPDATE";
    state.utilities[kind] = current;
    await input.ports.save(state);
    if (progress.status !== "TARGET_REACHED") {
      return { serviceCertified: false, state, waiting: true, reason: progress.status,
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    current.progression = null;
    current.serviceEvidence = await input.ports.observe(kind, input.scope);
    if (!isScopedUtilityServiceCertified(current.serviceEvidence, input.scope)) {
      current.stage = current.serviceEvidence.targetNetworkReachable === true ? "OPERATING" : "CONNECTED";
      current.observationWaits += 1;
      if (current.observationWaits <= current.maximumObservationWaits) {
        const next = await input.ports.progress({ scope: input.scope, kind, prior: null });
        current.progression = { startFrame: next.startFrame, targetFrame: next.targetFrame, checks: 0, maximumChecks: 60 };
        current.stage = "WAITING_FOR_SERVICE_UPDATE";
      }
      state.utilities[kind] = current;
      await input.ports.save(state);
      return { serviceCertified: false, state, waiting: current.observationWaits <= current.maximumObservationWaits,
        reason: current.observationWaits <= current.maximumObservationWaits
          ? "UTILITY_SERVICE_NOT_YET_CERTIFIED" : "UTILITY_SERVICE_OBSERVATION_EXHAUSTED",
        providerInvocations: 0, legacyBrainInvocations: 0 };
    }
    current.stage = "SERVICE_CERTIFIED";
    state.utilities[kind] = current;
    await input.ports.save(state);
    await input.ports.afterKindCertified?.({ kind, state });
  }
  return { serviceCertified: true, state, waiting: false, reason: "SCOPED_UTILITY_SERVICE_CERTIFIED",
    providerInvocations: 0, legacyBrainInvocations: 0 };
}
