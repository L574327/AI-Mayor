import { createHash } from "node:crypto";
import type { GrowableLandUse } from "../growth-mode";
import type { SpatialEntityRef, SpatialPoint2 } from "../spatial/types";
import type { V2DurabilityCoordinator, V2UtilityBudgetAmendmentRecord } from "./durability";
import type { V2CommandJournal, V2CommandStatus, V2ObservationEnvelope, ZoningIntent } from "./foundation";
import type { V2FoundationPorts } from "./main-adapter";
import type { RoadExecutionRequest, RoadGeometryInput } from "./road-kernel";
import { stableRoadInput } from "./finance";
import { UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON } from "./utility-budget";
import { pointWithinCircleScope } from "./site-selection";
import { classifyNativeRoadPreviewFailure, isTransientNativeBuildBusy, NATIVE_BUILD_SLOT_BUSY, RoadQuoteContractError } from "./runtime-road-caller";
import type { DurableGreenfieldUtilityState } from "./greenfield-utility-bootstrap";
import { chooseGate1CapabilityTask } from "./autonomous-brain";

export const V2_GATE1_STATE_SCHEMA_VERSION = "ai-mayor-v2-gate1-state/2";

export type EvidenceProvenance = "OBSERVED" | "DERIVED" | "ESTIMATED" | "PLANNED_RESERVED";
export type Gate1Fact = "PASS" | "FAIL" | "UNKNOWN";
export type Gate1Stage =
  | "PLANNED"
  | "SITE_SELECTED"
  | "ROAD_DELIVERED"
  | "ZONED_WAITING_FOR_BUILDING"
  | "BUILDING_OBSERVED"
  | "WAITING_FOR_OCCUPANCY"
  | "OCCUPIED"
  | "DIAGNOSING"
  | "RECOVERING";

export interface CircleScope {
  center: SpatialPoint2;
  radius: number;
}

export interface CityIntent {
  id: string;
  kind: "ESTABLISH_FIRST_RESIDENTIAL_POPULATION";
  targetResidents: number;
  maximumBudget: number;
  createdAt: string;
  status: "ACTIVE" | "SATISFIED" | "BLOCKED";
}

export interface DevelopmentProject {
  id: string;
  intentId: string;
  kind: "RESIDENTIAL_STARTER";
  districtId: string;
  trancheIds: [string];
  maximumBudget: number;
  status: "ACTIVE" | "OCCUPIED" | "COMPLETE" | "BLOCKED";
  utilityReservation: CircleScope;
}

export interface District {
  id: string;
  projectId: string;
  reservationRef: string;
  protectionRefs: string[];
  boundary: CircleScope;
  provenance: "PLANNED_RESERVED";
}

export interface DistrictPlan {
  id: string;
  districtId: string;
  starterTrancheId: string;
  landUse: GrowableLandUse;
  direction: SpatialPoint2;
  capacityTargetResidents: number;
}

export type Gate1TaskKind =
  | "SITE_SELECTION"
  | "ROAD_CONNECTION"
  | "WAIT_FOR_BUILDING"
  | "UTILITY_PROVISION"
  | "ZONING"
  | "WAIT_OBSERVE"
  | "OCCUPANCY_DIAGNOSIS"
  | "RECOVERY";

export interface Gate1Task {
  id: string;
  trancheId: string;
  kind: Gate1TaskKind;
  legalStage: Gate1Stage;
  status: "PENDING" | "DISPATCHED" | "WAITING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
  attempts: number;
  maximumAttempts: number;
  terminalOutcomeId: string | null;
  activeCommandId?: string | null;
  childOperationAmendmentId?: string;
  childOperationAmendmentIds?: string[];
  supersedesTaskId?: string;
  supersessionReason?: "PLANNER_INPUT_CHANGED";
  previousExactInputHash?: string;
  newExactInputHash?: string;
  newMaterialInputHash?: string;
  replacementKey?: string;
  activeBranchIdentity?: string;
  objectiveId?: string;
  utilityRoadParentTaskId?: string;
  utilityRoadPlanRevision?: string;
}

export interface DeliveryProgress {
  completed: number;
  total: number;
  ratio: number;
  lastOutcomeId: string | null;
}

export interface EffectProgress {
  status: "NOT_OBSERVED" | "WAITING" | "OCCUPIED" | "DIAGNOSING";
  attributedResidentialBuildings: SpatialEntityRef[];
  actualResidents: number | null;
  occupiedResidentialBuildings: SpatialEntityRef[];
  boundedWaitsCompleted: number;
  lastObservationId: string | null;
}

export interface Tranche {
  id: string;
  projectId: string;
  districtId: string;
  reservationRef: string;
  stage: Gate1Stage;
  target: CircleScope;
  taskIds: string[];
  /** Current task per objective; historical superseded tasks remain in tasks/taskIds. */
  currentTaskIds?: Partial<Record<Gate1TaskKind, string>>;
  allowedActionFamilies: Array<"ROAD" | "ZONING">;
  delivery_progress: DeliveryProgress;
  effect_progress: EffectProgress;
  recoveryAttempts: number;
  maximumRecoveryAttempts: 1;
  /** Durable one-shot repair markers for known pre-submit execution artifacts. */
  executionRecoveryMarkers?: string[];
  /** Supply-side utility execution is durable and scoped; it never replaces later consumer service proof. */
  utilityExecution?: DurableGreenfieldUtilityState;
}

export interface Gate1Observation {
  observationId: string;
  runtimeEpoch: string;
  coherence: "STABLE_FRAME" | "BOUNDED_DRIFT" | "UNKNOWN";
  capturedAt: string;
  trancheId: string;
  access: { value: Gate1Fact; provenance: EvidenceProvenance };
  productiveFrontage: { value: Gate1Fact; provenance: EvidenceProvenance };
  utilities: {
    value: Gate1Fact;
    provenance: EvidenceProvenance;
    evidenceKind: "ACTUAL_CONSUMER_SERVICE" | "PRE_ZONING_SERVICEABILITY" | "UNKNOWN";
    buildingRefs: SpatialEntityRef[];
  };
  /**
   * The buildings inside this tranche that belong to ITS OWN land use, not
   * residential buildings in general. The field keeps its historical name, but
   * `gate1LandUseZone` decides which prefabs count: a commercial tranche
   * attributes commercial buildings. Reading residential ones for it would let
   * the post-zoning wait be satisfied by a neighbour the Goal's own zoning can
   * never produce.
   */
  residentialBuildings: { value: SpatialEntityRef[] | null; provenance: "OBSERVED" };
  /** People, which only a RESIDENTIAL tranche can have. */
  actualResidents: { value: number | null; provenance: "OBSERVED" };
  /**
   * Occupied buildings of this tranche's land use. Note that the occupancy
   * ladder in `WAIT_OBSERVE` is written for residents: a commercial or
   * industrial Goal has no resident population to observe, so its effect ends
   * at `BUILDING_OBSERVED` and the Goal settles through `OCCUPANCY_DIAGNOSIS`
   * instead. A land-use-specific completion predicate is still open.
   */
  occupiedResidentialBuildings: { value: SpatialEntityRef[] | null; provenance: "OBSERVED" };
  world?: {
    worldId: string;
    worldEpochId: string;
    checkpointId: string | null;
    generation: string;
    provenance: "OBSERVED_NATIVE_IDENTITY";
  };
  diagnosis?: "ACCESS_FAILURE" | "UTILITY_FAILURE" | "ZONING_OR_DEMAND_DELAY" | "UNKNOWN";
  waitingFor?: "ROUTE_RESULT" | "CONSUMER_INITIALIZATION" | "OCCUPANCY";
  /**
   * Which required read made the ENVELOPE incoherent, present only when it is.
   * "coherence is UNKNOWN" on its own cannot be acted on: a read that threw is
   * a Bridge problem, an unreadable frame is a different one, and a caller that
   * can only see "UNKNOWN" cannot tell which of the retry, the world, or its
   * own read window is at fault.
   */
  incoherence?: {
    unavailableSources: string[];
    frameBefore: number | null;
    frameAfter: number | null;
  };
  /**
   * How coherent each in-scope FACT's own read was, over the buildings this
   * tranche attributes.
   *
   * Deliberately separate from `coherence`. That field is the envelope's — one
   * frame, every required source available — and fails the whole observation
   * closed. A building's access or consumer-service read is a fact about that
   * building: its UNKNOWN must refuse the predicates that read it, and nothing
   * else. `STABLE_FRAME` with no buildings means nothing was unreadable, not
   * that a building was found healthy.
   */
  factCoherence?: {
    access: "STABLE_FRAME" | "BOUNDED_DRIFT" | "UNKNOWN";
    utilities: "STABLE_FRAME" | "BOUNDED_DRIFT" | "UNKNOWN";
    /** `access:<index>:<version>` / `utility:<index>:<version>` entries. */
    incoherentRefs?: string[];
  };
}

export interface Gate1SkillProposal {
  id: string;
  attempt: number;
  skill:
    | "SiteSelection"
    | "RoadConnection"
    | "UtilityProvision"
    | "Zoning"
    | "WaitObserve"
    | "OccupancyDiagnosis"
    | "BoundedRecovery";
  taskId: string;
  projectId: string;
  districtId: string;
  trancheId: string;
  reservationRef: string;
  requiredStage: Gate1Stage;
  kind: "STATE" | "OBSERVE" | "WORLD_WRITE";
  actionFamily: "ROAD" | "ZONING" | null;
  operation: "SELECT_SITE" | "BUILD_ROAD" | "CERTIFY_UTILITIES" | "ZONE_RESIDENTIAL" | "WAIT" | "DIAGNOSE" | "RECOVER";
  target: CircleScope;
  boundedFallback: string | null;
  methodVariant: "PRIMARY" | "BOUNDED_FALLBACK";
  concreteChildOperation?: {
    amendmentId: string;
    planRevision: string;
    input: RoadGeometryInput;
    courseFingerprint: string;
  };
}

export interface Gate1ConcreteChildOperationAdmissionContext {
  getAmendment(amendmentId: string): V2UtilityBudgetAmendmentRecord | null;
  current: { worldId: string; checkpointId: string; generation: string; planRevision: string } | null;
  hasRoadOperation(exactInput: string): boolean;
}

export interface Gate1AdmittedProposal extends Gate1SkillProposal {
  admission: {
    decision: "ADMITTED";
    admittedAt: string;
    scopeFingerprint: string;
  };
}

export interface Gate1ExecutionOutcome {
  status: "DELIVERED" | "WAITING" | "REJECTED" | "UNKNOWN";
  commandId: string | null;
  observedMatch: boolean;
  reason: string;
  roadPreApplyFailure?: Gate1RoadPreApplyFailureEvidence;
}

export type Gate1RoadPreflightResult =
  | { status: "FEASIBLE" }
  | { status: "NO_FEASIBLE_CANDIDATE"; reason: string }
  /**
   * The tranche's own reservation already sits on the road network.
   *
   * The Road step exists to give this reservation access. When it already has
   * some — the reservation contains existing road — there is no course to build
   * and none that native would certify: every course short enough to stay inside
   * the reservation from a road-dense site is a rebuild of a road already there,
   * which native folds back. Measured live (2026-09-30): a residential expansion
   * site of radius 28 m with a degree-5 junction 8.1 m from its centre, where all
   * 24 bounded courses the resolver offered were refused, and so were all 12
   * headings of the local fan at 30 m — while the whole grid around it certified
   * freely at longer reaches.
   *
   * It is a refusal to BUILD, not a refusal to proceed: the task completes at
   * `ROAD_DELIVERED` with no command, no Apply and no native call.
   */
  | { status: "ALREADY_CONNECTED"; reason: string };

/** Durable proof that a Road preview was rejected before authorization or Apply. */
export interface Gate1RoadPreApplyFailureEvidence {
  schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1";
  phase: "ROAD_PREVIEW_QUOTE_VALIDATION";
  taskId: string;
  childId: string | null;
  exactInput: RoadGeometryInput;
  firstFailedQuoteRequirement: string;
  previewOnly: true;
  applyCalled: false;
}

/** Read durable proof that every dispatched Road attempt stopped before native authorization. */
export function roadPreApplyFailureEvidenceForTask(
  state: Gate1State,
  taskId: string,
): Gate1RoadPreApplyFailureEvidence | null {
  const task = state.tasks.find((candidate) => candidate.id === taskId && candidate.kind === "ROAD_CONNECTION");
  if (!task || !task.terminalOutcomeId || !["BLOCKED", "FAILED"].includes(task.status)) return null;
  const attemptEntries = Array.from({ length: task.attempts }, (_, index) =>
    state.journal.find((entry) => entry.taskId === taskId && entry.proposalId === `${taskId}:attempt:${index + 1}`),
  );
  if (attemptEntries.some((entry) => !entry || entry.commandId !== null || entry.admission !== "ADMITTED" ||
    entry.execution !== "UNKNOWN" || entry.failureClassification !== "EXECUTION_UNKNOWN" || entry.observedEffect !== "UNKNOWN") ||
    attemptEntries.at(-1)?.id !== task.terminalOutcomeId) return null;
  let latestEvidence: Gate1RoadPreApplyFailureEvidence | null = null;
  for (const entry of attemptEntries) {
    if (!entry) return null;
    const typed = entry.roadPreApplyFailure;
    if (typed && typed.schemaVersion === "ai-mayor-v2-road-pre-apply-failure/1" && typed.phase === "ROAD_PREVIEW_QUOTE_VALIDATION" &&
      typed.taskId === taskId && typed.previewOnly === true && typed.applyCalled === false &&
      typeof typed.firstFailedQuoteRequirement === "string" && typed.firstFailedQuoteRequirement.length > 0 &&
      typed.exactInput && typeof typed.exactInput.prefab === "string" &&
      [typed.exactInput.x1, typed.exactInput.z1, typed.exactInput.x2, typed.exactInput.z2].every(Number.isFinite)) {
      latestEvidence = typed;
      continue;
    }
    // Backward compatibility for durable quote diagnostics emitted before this typed field existed.
    const marker = "[ROAD_QUOTE_DIAGNOSTICS=";
    const offset = entry.reason.indexOf(marker);
    if (offset >= 0) {
      try {
        const diagnostics = JSON.parse(entry.reason.slice(offset + marker.length).replace(/\]$/, "")) as Record<string, unknown>;
        const request = diagnostics.productionPreviewRequest as Record<string, unknown> | undefined;
        const actual = diagnostics.actual as Record<string, unknown> | undefined;
        const geometry = request?.stableInput;
        const exactInput = typeof geometry === "string" ? JSON.parse(geometry) as RoadGeometryInput : null;
        const identityMatches = diagnostics.roadTaskId === taskId &&
          diagnostics.firstFailedQuoteRequirement === "VALID_TRUE" && actual?.previewOnly === true && actual.valid === false &&
          typeof request?.prefab === "string" && exactInput?.prefab === request.prefab;
        if (identityMatches && exactInput && [exactInput.x1, exactInput.z1, exactInput.x2, exactInput.z2].every(Number.isFinite)) {
          latestEvidence = {
            schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1",
            phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
            taskId,
            childId: typeof diagnostics.roadChildId === "string" ? diagnostics.roadChildId : null,
            exactInput,
            firstFailedQuoteRequirement: "VALID_TRUE",
            previewOnly: true,
            applyCalled: false,
          };
          continue;
        }
      } catch { /* Malformed historical diagnostic cannot authorize a successor. */ }
    }
    // The one-shot legacy recovery persisted its safety decision and exact pre-Apply finding in the journal.
    const recovery = state.journal.find((candidate) => candidate.id === `${taskId}:recovery:quote-correlation` &&
      candidate.taskId === taskId && candidate.skill === "BoundedRecovery" && candidate.execution === "NOT_REQUIRED" &&
      candidate.commandId === null && candidate.observedEffect === "NOT_APPLICABLE" &&
      candidate.reason.includes("before authorization or Apply"));
    if (!recovery || !state.tranche.executionRecoveryMarkers?.includes("ROAD_PRE_APPLY_QUOTE_CORRELATION_FAILURE")) return null;
  }
  return latestEvidence;
}

/**
 * The ZONING step found no bounded cell set inside this tranche's own reservation.
 *
 * Distinct from a native rejection on purpose. Nothing was submitted, nothing is
 * in flight, and no retry can change the answer: the land this tranche reserved
 * simply carries no cell this project may zone. It is a property of the
 * reservation, so it is reported before the native boundary rather than as a
 * result from it, and it is terminal for the ZONING task rather than a retryable
 * execution failure.
 *
 * Typed so that only this exact dead end closes the task. Every other failure
 * from the same boundary — an unknown native outcome, a world identity that
 * moved, an admission refusal — must keep propagating untouched.
 */
export class Gate1BoundedZoningDeadEndError extends Error {
  readonly landUse: string;
  constructor(landUse: string) {
    super(`GATE1_ZONING_NO_BOUNDED_${landUse}_CELL_SET`);
    this.name = "Gate1BoundedZoningDeadEndError";
    this.landUse = landUse;
  }
}

/**
 * This tranche's own persisted site target could not be re-derived from the
 * current world.
 *
 * The tranche keeps only its reservation, so the Road step replays the bounded
 * search that admitted it and matches the persisted target. When that search no
 * longer produces the target — the world moved, the observation came back
 * without the anchor — there is nothing to build and no other candidate to try.
 *
 * Same shape as the zoning dead end above, and terminal for the same reason:
 * nothing was submitted, nothing is in flight, and no retry changes the answer.
 * It is a bounded ending of this Goal, not a reason for the city to stop.
 */
export class Gate1BoundedRoadSiteDeadEndError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Gate1BoundedRoadSiteDeadEndError";
  }
}

/** A bounded planning refusal inside the tranche's own scope, before any command. */
export const isGate1BoundedPlanningDeadEnd = (
  error: unknown,
): error is Gate1BoundedZoningDeadEndError | Gate1BoundedRoadSiteDeadEndError =>
  error instanceof Gate1BoundedZoningDeadEndError || error instanceof Gate1BoundedRoadSiteDeadEndError;

/**
 * Which fact the `UTILITY_PROVISION` gate is still missing, named.
 *
 * The gate used to collapse eight distinct conditions — an absent observation,
 * an incoherent frame, an unreadable building list, an empty one, UNKNOWN
 * access, UNKNOWN frontage, UNKNOWN consumer service, a non-consumer evidence
 * kind, a mismatched consumer target — into one `OBSERVATION_UNKNOWN` terminal
 * with one message. Which of them fired was not recorded, so a building whose
 * consumer service the simulation had simply not initialized yet looked exactly
 * like an observation attributed to another project.
 *
 * They are different facts with different answers:
 *
 * - `WAIT` — the world has not answered yet. Every one of these becomes true on
 *   its own once the city runs: a zoned lot is built on, consumers initialize,
 *   service moves from UNKNOWN to SERVED. A bounded wait is the same answer the
 *   neighbouring `WAIT_FOR_BUILDING` branch already gives, so the tranche keeps
 *   its own bounded budget instead of ending the Goal on its first read.
 * - `TERMINAL` — the read itself is not authoritative evidence about this
 *   tranche's consumers: the observation belongs to another scope, or it is a
 *   forecast (a city-wide surplus estimate, a pre-zoning serviceability read)
 *   rather than actual consumer service. No retry changes what such a read is,
 *   so waiting would only spend the budget on an answer already known wrong.
 */
export type Gate1UtilityProvisionReadiness =
  | { disposition: "WAIT"; fact: string }
  | { disposition: "TERMINAL"; fact: string }
  /** Every fact the gate needs is present and known; the read is authoritative. */
  | { disposition: "READY"; observation: Gate1Observation; buildings: SpatialEntityRef[] };

/**
 * A current native renter read plus actual served utility consumers proves the
 * residential building is functioning even when the optional building-access
 * endpoint is unavailable. This only fills UNKNOWN access; an observed access
 * failure remains a failure. The evidence must name the same occupied buildings
 * and the whole scoped consumer set.
 */
function gate1OccupiedConsumerEvidence(observation: Gate1Observation): boolean {
  if (
    observation.coherence === "UNKNOWN" ||
    observation.access.value !== "UNKNOWN" ||
    observation.productiveFrontage.value !== "PASS" ||
    observation.utilities.value !== "PASS" ||
    observation.utilities.evidenceKind !== "ACTUAL_CONSUMER_SERVICE" ||
    !["OBSERVED", "DERIVED"].includes(observation.utilities.provenance) ||
    observation.residentialBuildings.value === null ||
    observation.residentialBuildings.value.length === 0 ||
    observation.actualResidents.value === null ||
    observation.actualResidents.value <= 0 ||
    observation.occupiedResidentialBuildings.value === null ||
    observation.occupiedResidentialBuildings.value.length === 0
  ) return false;

  const buildingKeys = new Set(observation.residentialBuildings.value.map((building) => `${building.index}:${building.version}`));
  const utilityKeys = new Set(observation.utilities.buildingRefs.map((building) => `${building.index}:${building.version}`));
  const occupiedKeys = new Set(observation.occupiedResidentialBuildings.value.map((building) => `${building.index}:${building.version}`));
  return buildingKeys.size === utilityKeys.size &&
    [...buildingKeys].every((key) => utilityKeys.has(key)) &&
    [...occupiedKeys].every((key) => buildingKeys.has(key));
}

function gate1AccessCertified(observation: Gate1Observation): boolean {
  return observation.access.value === "PASS" || gate1OccupiedConsumerEvidence(observation);
}

export function gate1UtilityProvisionReadiness(
  state: Gate1State,
  observation: Gate1Observation | null | undefined,
): Gate1UtilityProvisionReadiness {
  if (!observation) return { disposition: "WAIT", fact: "NO_OBSERVATION" };
  if (observation.trancheId !== state.tranche.id) return { disposition: "TERMINAL", fact: "TRANCHE_MISMATCH" };
  if (observation.coherence === "UNKNOWN") return { disposition: "WAIT", fact: "COHERENCE_UNKNOWN" };
  if (observation.residentialBuildings.value === null) return { disposition: "WAIT", fact: "BUILDING_READ_UNAVAILABLE" };
  if (observation.residentialBuildings.value.length === 0) return { disposition: "WAIT", fact: "NO_ATTRIBUTED_BUILDING" };
  // The evidence has to BE consumer service about THIS scope. Both of these are
  // statements about the read's own authority, not about a fact that is still
  // arriving: a city-wide surplus estimate or a pre-zoning serviceability
  // forecast is not this tranche's consumers whatever the value says, and no
  // amount of waiting turns one into the other. Waiting would only spend the
  // budget on an answer that is already wrong.
  if (observation.utilities.evidenceKind !== "ACTUAL_CONSUMER_SERVICE") {
    return { disposition: "TERMINAL", fact: "EVIDENCE_KIND_NOT_ACTUAL_CONSUMER_SERVICE" };
  }
  if (!["OBSERVED", "DERIVED"].includes(observation.utilities.provenance)) {
    return { disposition: "TERMINAL", fact: "UTILITY_EVIDENCE_NOT_AUTHORITATIVE" };
  }
  if (observation.productiveFrontage.value === "UNKNOWN") return { disposition: "WAIT", fact: "PRODUCTIVE_FRONTAGE_UNKNOWN" };
  if (observation.utilities.value === "UNKNOWN") return { disposition: "WAIT", fact: "CONSUMER_SERVICE_UNKNOWN" };
  // The consumer read must be bound to these very buildings. A census that
  // names other components is not this scope's delivery, whether or not it is
  // otherwise complete — and while consumers initialize that binding lags.
  const residentialKeys = new Set(observation.residentialBuildings.value.map((building) => `${building.index}:${building.version}`));
  const utilityKeys = new Set(observation.utilities.buildingRefs.map((building) => `${building.index}:${building.version}`));
  if (residentialKeys.size !== utilityKeys.size || ![...residentialKeys].every((key) => utilityKeys.has(key))) {
    return { disposition: "WAIT", fact: "UTILITY_CONSUMER_TARGET_MISMATCH" };
  }
  if (observation.access.value === "UNKNOWN" && !gate1OccupiedConsumerEvidence(observation)) {
    return { disposition: "WAIT", fact: "ACCESS_UNKNOWN" };
  }
  return { disposition: "READY", observation, buildings: observation.residentialBuildings.value };
}

/**
 * Whether this tranche's own durable execution has authoritatively delivered a
 * utility.
 *
 * `SERVICE_CERTIFIED` is the utility execution's own terminal: the facility was
 * placed, connected and read back through the durable boundary that owns every
 * other mutation. It is the strongest statement a tranche can hold about a
 * utility, and it is the fact the `UTILITY_PROVISION` task is named for.
 */
export function gate1UtilityDelivered(state: Gate1State): boolean {
  const utilities = state.tranche.utilityExecution?.utilities as
    | Partial<Record<string, { stage?: string } | undefined>>
    | undefined;
  if (!utilities) return false;
  return ["electricity", "water", "sewage"].some((kind) => utilities[kind]?.stage === "SERVICE_CERTIFIED");
}

/**
 * The Goal reached its own end: road delivered, land zoned, and occupancy still
 * did not happen. Nothing inside Gate 1 can change that answer.
 *
 * The diagnosis says which fact is missing, and each one belongs to a
 * capability this tranche does not hold:
 *
 * - `ACCESS_FAILURE` — the building is not connected to the delivered road. A
 *   new Road is a Brain-level `ESTABLISH_ROAD_NETWORK` decision; replaying this
 *   tranche's own delivered course is not it.
 * - `UTILITY_FAILURE` — the building has no service. That is the utility
 *   capability's own Goal (`PROVIDE_SERVICE`), which the growth policy derives
 *   from the same world facts this diagnosis just read.
 * - `ZONING_OR_DEMAND_DELAY` — the land is delivered and zoned; whether anyone
 *   builds there is the simulation's answer and demand's, not this Goal's.
 *
 * So the diagnosis is recorded as this Goal's bounded terminal and handed back
 * to the Brain, which re-derives from fresh facts. It is deliberately NOT a
 * `RECOVERY` dispatch: `RECOVERING` is a hand-off to a repair this boundary can
 * actually perform, and it is only entered when the boundary says it can (see
 * `Gate1WorldBoundary.recover`).
 */
const occupancyDiagnosisTerminal = (diagnosis: NonNullable<Gate1Observation["diagnosis"]>): {
  classification: Gate1OutcomeJournalEntry["failureClassification"];
  reason: string;
} => diagnosis === "ACCESS_FAILURE"
  ? {
      classification: "OCCUPANCY_ACCESS_UNRESOLVED",
      reason: "OCCUPANCY_UNRESOLVED:ACCESS_FAILURE:the building is not connected to this Goal's delivered road, and no scope-local repair changes that",
    }
  : diagnosis === "UTILITY_FAILURE"
    ? {
        classification: "OCCUPANCY_UTILITY_UNRESOLVED",
        reason: "OCCUPANCY_UNRESOLVED:UTILITY_FAILURE:the building has no consumer service, which the utility capability's own Goal must provide",
      }
    : {
        classification: "OCCUPANCY_DEMAND_DELAY",
        reason: "OCCUPANCY_UNRESOLVED:ZONING_OR_DEMAND_DELAY:the land is delivered and zoned; occupancy is the simulation's answer, not this Goal's",
      };

export interface Gate1OutcomeJournalEntry {
  id: string;
  taskId: string;
  skill: Gate1SkillProposal["skill"];
  proposalId: string | null;
  admission: "ADMITTED" | "REJECTED" | "NOT_REQUIRED";
  execution: Gate1ExecutionOutcome["status"] | "NOT_REQUIRED";
  commandId: string | null;
  observationId: string | null;
  /**
   * `UTILITY_DELIVERED` is the utility execution's own certification, recorded
   * as the effect the `UTILITY_PROVISION` task observed. It is deliberately not
   * folded into `NOT_APPLICABLE`: a reader asking "why did this task pass" must
   * be able to tell a delivered utility from a task with no world effect.
   */
  observedEffect: "OCCUPIED" | "NO_OCCUPANCY" | "UTILITY_DELIVERED" | "UNKNOWN" | "NOT_APPLICABLE";
  failureClassification:
    | "NONE"
    | "ADMISSION_REJECTED"
    | "EXECUTION_REJECTED"
    | "EXECUTION_UNKNOWN"
    | "OBSERVATION_UNKNOWN"
    | "ROAD_PREFLIGHT_REJECTED"
    | "ROAD_SITE_TARGET_NOT_REPRODUCED"
    | "ZONING_RESERVATION_DEAD_END"
    | "BOUNDED_WAIT_EXHAUSTED"
    | "RECOVERY_EXHAUSTED"
    /**
     * The occupancy diagnosis is this Goal's own bounded ending rather than a
     * hand-off to a repair. Recorded per diagnosis so "why did this Goal stop"
     * has one named answer each, instead of three facts behind one label.
     */
    | "OCCUPANCY_ACCESS_UNRESOLVED"
    | "OCCUPANCY_UTILITY_UNRESOLVED"
    | "OCCUPANCY_DEMAND_DELAY";
  roadPreApplyFailure?: Gate1RoadPreApplyFailureEvidence;
  recordedAt: string;
  reason: string;
}

export interface Gate1State {
  schemaVersion: typeof V2_GATE1_STATE_SCHEMA_VERSION;
  stateVersion: number;
  intent: CityIntent;
  project: DevelopmentProject;
  district: District;
  districtPlan: DistrictPlan;
  tranche: Tranche;
  tasks: Gate1Task[];
  journal: Gate1OutcomeJournalEntry[];
  predecessorCompletionId?: string | null;
  completion?: {
    completionId: string;
    completedAt: string;
    terminalOutcomeId: string;
    releasedReservationRefs: string[];
    handoffStatus: "NEXT_DECISION_READY" | "CONSUMED";
    nextDecisionId: string | null;
    handedOffAt: string | null;
  };
  /** Planning strategy history only; authoritative predicates remain in observations. */
  brainLedger?: { planningEpoch: string; entries: import("./autonomous-brain").BrainLedgerEntry[] };
}

export interface Gate1StateStorage {
  load(): unknown;
  save(state: Gate1State): void;
}

export interface StarterResidentialIntentInput {
  intentId: string;
  targetResidents: number;
  maximumBudget: number;
  planningEnvelope: CircleScope;
  siteCandidates: Array<{ id: string; target: CircleScope; score: number; blocked: boolean }>;
  protections?: Array<{ ref: string; scope: CircleScope }>;
  maximumWaitObservations?: number;
  starterDirection?: SpatialPoint2;
  /** Zone family for a follow-on goal work order; first project defaults to R. */
  landUse?: DistrictPlan["landUse"];
  /**
   * What this scope delivers, and therefore which tasks it owns.
   *
   * The ladder is exactly the tasks required to reach this stage — not the whole
   * residential ladder with the scope stopping early. A scope that carries tasks
   * it does not own is not merely untidy: measured live (2026-10-01) a
   * `ROAD_FRONTAGE` prerequisite whose road had been delivered was then advanced
   * into its own ZONING step, on land that was never a zoning site, and closed
   * terminally at `GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET` — it had no
   * ZONING deliverable to fail. The delivered road IS that scope's whole
   * deliverable, and the Goal that wanted frontage is the one that zones.
   */
  deliverable?: "ROAD_DELIVERED" | "OCCUPIED";
}

export interface Gate1WorldBoundary {
  /** Preview and select a bounded Road candidate before a formal attempt is admitted. */
  preflightRoad?(proposal: Gate1SkillProposal, signal?: AbortSignal): Promise<Gate1RoadPreflightResult>;
  execute(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<Gate1ExecutionOutcome>;
  reconcile?(commandId: string, signal?: AbortSignal, actionFamily?: "ROAD" | "ZONING"): Promise<Gate1ExecutionOutcome>;
  roadAccessConnected?(proposal: Gate1SkillProposal, signal?: AbortSignal): Promise<boolean>;
  /**
   * A bounded, scope-local recovery this boundary can actually perform.
   *
   * Its presence is the boundary's own declaration that the `RECOVERY` task can
   * be executed: the `RECOVER` proposal is dispatched to this resolver and to
   * nothing else, so a boundary that omits it cannot have a `RECOVERING`
   * tranche. Without that declaration the occupancy diagnosis is recorded as the
   * Goal's own bounded terminal instead (see `occupancyDiagnosisTerminal`),
   * which is what a boundary with no repair to offer should report.
   */
  recover?(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<Gate1ExecutionOutcome>;
}

export interface Gate1FoundationProposalResolvers {
  preflightRoad?(proposal: Gate1SkillProposal, signal?: AbortSignal): Promise<Gate1RoadPreflightResult>;
  road(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<RoadExecutionRequest>;
  roadAccessConnected?(proposal: Gate1SkillProposal, signal?: AbortSignal): Promise<boolean>;
  consumeConcreteChildOperation?(amendmentId: string, courseFingerprint: string): void;
  zoning(
    proposal: Gate1AdmittedProposal,
    signal?: AbortSignal,
  ): Promise<{ intent: ZoningIntent; baseline: V2ObservationEnvelope }>;
  recovery?(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<Gate1ExecutionOutcome>;
}

const clone = <T>(value: T): T => structuredClone(value);
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const distance = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);
const contains = (outer: CircleScope, inner: CircleScope) =>
  finitePositive(outer.radius) &&
  finitePositive(inner.radius) &&
  distance(outer.center, inner.center) + inner.radius <= outer.radius;
const intersects = (left: CircleScope, right: CircleScope) =>
  distance(left.center, right.center) < left.radius + right.radius;
const taskId = (trancheId: string, kind: Gate1TaskKind) => `${trancheId}:task:${kind.toLowerCase()}`;

function task(trancheId: string, kind: Gate1TaskKind, legalStage: Gate1Stage, maximumAttempts = 1): Gate1Task {
  return {
    id: taskId(trancheId, kind),
    trancheId,
    kind,
    legalStage,
    status: "PENDING",
    attempts: 0,
    maximumAttempts,
    terminalOutcomeId: null,
  };
}

function currentTaskOfKind(state: Gate1State, kind: Gate1TaskKind): Gate1Task | undefined {
  const currentId = state.tranche.currentTaskIds?.[kind];
  return currentId ? state.tasks.find((candidate) => candidate.id === currentId && candidate.kind === kind)
    : state.tasks.find((candidate) => candidate.kind === kind);
}

function validateInput(input: StarterResidentialIntentInput): void {
  if (!input.intentId.trim()) throw new Error("CityIntent id is required");
  if (!Number.isInteger(input.targetResidents) || input.targetResidents <= 0 || input.targetResidents > 500)
    throw new Error("starter targetResidents must be an integer in [1, 500]");
  if (!finitePositive(input.maximumBudget)) throw new Error("starter maximumBudget must be positive");
  if (!finitePositive(input.planningEnvelope.radius)) throw new Error("planning envelope must be bounded");
}

export function planStarterResidentialIntent(input: StarterResidentialIntentInput, now = new Date()): Gate1State {
  validateInput(input);
  const protections = input.protections ?? [];
  const candidates = input.siteCandidates
    .filter((candidate) => !candidate.blocked && contains(input.planningEnvelope, candidate.target))
    .filter((candidate) => protections.every((protection) => !intersects(candidate.target, protection.scope)))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = candidates[0];
  if (!selected) throw new Error("no legal bounded starter site candidate");

  const projectId = `${input.intentId}:project:starter-residential`;
  const districtId = `${projectId}:district:1`;
  const trancheId = `${districtId}:tranche:1`;
  const reservationRef = `${trancheId}:reservation`;
  // A scope owns exactly the tasks its own deliverable requires.
  const roadOnly = input.deliverable === "ROAD_DELIVERED";
  const tasks = roadOnly
    ? [
      task(trancheId, "SITE_SELECTION", "PLANNED"),
      task(trancheId, "ROAD_CONNECTION", "SITE_SELECTED", 2),
    ]
    : [
      task(trancheId, "SITE_SELECTION", "PLANNED"),
      task(trancheId, "ROAD_CONNECTION", "SITE_SELECTED", 2),
      task(trancheId, "ZONING", "ROAD_DELIVERED", 2),
      task(trancheId, "WAIT_FOR_BUILDING", "ZONED_WAITING_FOR_BUILDING", input.maximumWaitObservations ?? 3),
      // Service certification reads facts the simulation produces on its own
      // schedule: a building's consumer service moves from UNKNOWN to SERVED only
      // while the city runs. It is a bounded observation wait like the two waits
      // beside it, not a single-shot judgement.
      task(trancheId, "UTILITY_PROVISION", "BUILDING_OBSERVED", input.maximumWaitObservations ?? 3),
      task(trancheId, "WAIT_OBSERVE", "WAITING_FOR_OCCUPANCY", input.maximumWaitObservations ?? 3),
    ];
  return {
    schemaVersion: V2_GATE1_STATE_SCHEMA_VERSION,
    stateVersion: 1,
    intent: {
      id: input.intentId,
      kind: "ESTABLISH_FIRST_RESIDENTIAL_POPULATION",
      targetResidents: input.targetResidents,
      maximumBudget: input.maximumBudget,
      createdAt: now.toISOString(),
      status: "ACTIVE",
    },
    project: {
      id: projectId,
      intentId: input.intentId,
      kind: "RESIDENTIAL_STARTER",
      districtId,
      trancheIds: [trancheId],
      maximumBudget: input.maximumBudget,
      status: "ACTIVE",
      utilityReservation: clone(input.planningEnvelope),
    },
    district: {
      id: districtId,
      projectId,
      reservationRef,
      protectionRefs: protections.map((protection) => protection.ref),
      boundary: clone(selected.target),
      provenance: "PLANNED_RESERVED",
    },
    districtPlan: {
      id: `${districtId}:plan:starter`,
      districtId,
      starterTrancheId: trancheId,
      landUse: input.landUse ?? "RESIDENTIAL",
      direction: input.starterDirection ?? { x: 1, z: 0 },
      capacityTargetResidents: input.targetResidents,
    },
    tranche: {
      id: trancheId,
      projectId,
      districtId,
      reservationRef,
      stage: "PLANNED",
      target: clone(selected.target),
      taskIds: tasks.map((entry) => entry.id),
      // A Road-only scope writes no zoning. The family list is the tranche's own
      // statement of that, and admission checks it, so a ZONING proposal against
      // this scope is refused before any resolver runs rather than after a
      // terminal failure.
      allowedActionFamilies: roadOnly ? ["ROAD"] : ["ROAD", "ZONING"],
      // One figure per delivery this ladder actually produces: the site
      // selection's and the Road's for a Road-only scope, plus zoning and
      // occupancy for a residential one.
      delivery_progress: { completed: 0, total: roadOnly ? 2 : 4, ratio: 0, lastOutcomeId: null },
      effect_progress: {
        status: "NOT_OBSERVED",
        attributedResidentialBuildings: [],
        actualResidents: null,
        occupiedResidentialBuildings: [],
        boundedWaitsCompleted: 0,
        lastObservationId: null,
      },
      recoveryAttempts: 0,
      maximumRecoveryAttempts: 1,
    },
    tasks,
    journal: [],
  };
}

/** Add an exact, bounded Road task when K05 discovers missing utility frontage after starter Road delivery. */
export function ensureUtilityServiceRoadGoal(
  state: Gate1State,
  planRevision: string,
  childAmendmentIds: readonly string[],
): Gate1Task {
  const currentRoadId = state.tranche.currentTaskIds?.ROAD_CONNECTION;
  const currentRoad = currentRoadId ? state.tasks.find((candidate) => candidate.id === currentRoadId && candidate.kind === "ROAD_CONNECTION") : undefined;
  if (currentRoad?.utilityRoadPlanRevision === planRevision &&
    JSON.stringify(currentRoad.childOperationAmendmentIds ?? [currentRoad.childOperationAmendmentId]) === JSON.stringify(childAmendmentIds)) {
    return currentRoad;
  }
  const parentId = currentRoadId ??
    state.tasks.find((candidate) => candidate.trancheId === state.tranche.id && candidate.kind === "ROAD_CONNECTION")?.id;
  const parent = parentId ? state.tasks.find((candidate) => candidate.id === parentId && candidate.kind === "ROAD_CONNECTION") : undefined;
  if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION || state.tranche.stage !== "ROAD_DELIVERED" ||
    state.project.status !== "ACTIVE" || state.intent.status !== "ACTIVE" || !parent || parent.status !== "SUCCEEDED" ||
    !parent.terminalOutcomeId || !planRevision.trim() || childAmendmentIds.length < 1 || childAmendmentIds.length > 4 ||
    new Set(childAmendmentIds).size !== childAmendmentIds.length) {
    throw new Error("UTILITY_SERVICE_ROAD_SUBGOAL_PARENT_NOT_CERTIFIED");
  }
  const delivered = state.journal.find((entry) => entry.id === parent.terminalOutcomeId);
  if (!delivered || delivered.execution !== "DELIVERED" || !delivered.commandId) {
    throw new Error("UTILITY_SERVICE_ROAD_SUBGOAL_PARENT_EFFECT_NOT_CERTIFIED");
  }
  const identity = JSON.stringify([state.tranche.id, parent.id, planRevision, childAmendmentIds]);
  const id = `gate1-task-utility-service-road:${createHash("sha256").update(identity).digest("hex")}`;
  const existing = state.tasks.find((candidate) => candidate.id === id);
  if (existing) {
    if (existing.kind !== "ROAD_CONNECTION" || existing.utilityRoadParentTaskId !== parent.id ||
      existing.utilityRoadPlanRevision !== planRevision ||
      JSON.stringify(existing.childOperationAmendmentIds ?? [existing.childOperationAmendmentId]) !== JSON.stringify(childAmendmentIds)) {
      throw new Error("UTILITY_SERVICE_ROAD_SUBGOAL_IDENTITY_CONFLICT");
    }
    state.tranche.currentTaskIds = { ...state.tranche.currentTaskIds, ROAD_CONNECTION: existing.id };
    return existing;
  }
  const subgoal: Gate1Task = {
    ...task(state.tranche.id, "ROAD_CONNECTION", "ROAD_DELIVERED", 1),
    id,
    childOperationAmendmentId: childAmendmentIds[0],
    childOperationAmendmentIds: [...childAmendmentIds],
    utilityRoadParentTaskId: parent.id,
    utilityRoadPlanRevision: planRevision,
  };
  appendTask(state, subgoal);
  state.tranche.currentTaskIds = { ...state.tranche.currentTaskIds, ROAD_CONNECTION: id };
  state.tranche.delivery_progress.total += 1;
  state.tranche.delivery_progress.ratio = state.tranche.delivery_progress.completed / state.tranche.delivery_progress.total;
  return subgoal;
}

function assertState(value: unknown): Gate1State {
  const state = value as Partial<Gate1State> | null;
  if (
    !state ||
    state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION ||
    !Number.isInteger(state.stateVersion) ||
    !state.intent ||
    !state.project ||
    !state.district ||
    !state.districtPlan ||
    !state.tranche ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.journal)
  )
    throw new Error("Gate 1 durable state is malformed; fail closed");
  if (
    state.project.intentId !== state.intent.id ||
    state.project.districtId !== state.district.id ||
    state.tranche.projectId !== state.project.id ||
    state.tranche.districtId !== state.district.id ||
    state.tranche.reservationRef !== state.district.reservationRef ||
    !contains(state.district.boundary, state.tranche.target)
  )
    throw new Error("Gate 1 ownership or reservation state is inconsistent; fail closed");
  return clone(state as Gate1State);
}

/**
 * Repairs only the historical pre-submit epoch-validation misclassification.
 * The failed attempt and journal evidence remain durable; no Task or Project is
 * recreated, and ambiguous/submitted execution outcomes remain terminal.
 */
/**
 * Bump when the bounded ROAD candidate family changes.
 *
 * The re-evaluation below is deliberately one-shot so a repeated preflight
 * rejection cannot spin. That marker must not outlive the generator that produced
 * the rejection, though: a rejection recorded against a family that could not
 * reach any legal heading would otherwise suppress the fixed generator forever.
 * Same contract as `AUTONOMOUS_BRAIN_LEDGER_REVISION`.
 */
export const ROAD_CANDIDATE_FAMILY_REVISION = "bounded-heading-family/1";

function reconcileRestoredPreSubmitRoadRejection(state: Gate1State, commands?: V2CommandJournal): boolean {
  const candidatePreflightMarker = `ROAD_CANDIDATE_PREFLIGHT_REEVALUATION:${ROAD_CANDIDATE_FAMILY_REVISION}`;
  const zoningWaitingMarker = "ZONING_PREREQUISITE_WAIT_ATTEMPT_ACCOUNTING";
  if (state.tranche.stage === "ROAD_DELIVERED") {
    const zoning = state.tasks.find((candidate) => candidate.kind === "ZONING");
    const zoningOutcomes = zoning
      ? state.journal.filter((candidate) => candidate.taskId === zoning.id)
      : [];
    const waitingOnly = zoningOutcomes.length > 0 && zoningOutcomes.every((outcome) =>
      outcome.admission === "ADMITTED" &&
      outcome.execution === "NOT_REQUIRED" &&
      outcome.commandId === null &&
      outcome.failureClassification === "OBSERVATION_UNKNOWN" &&
      outcome.reason === "post-road authoritative productive-frontage observation is required before zoning"
    );
    if (
      zoning &&
      zoning.status === "PENDING" &&
      zoning.terminalOutcomeId === null &&
      zoning.attempts > 0 &&
      zoningOutcomes.length === zoning.attempts &&
      waitingOnly &&
      state.intent.status === "ACTIVE" &&
      state.project.status === "ACTIVE" &&
      !state.tranche.executionRecoveryMarkers?.includes(zoningWaitingMarker)
    ) {
      const poisonedAttempts = zoning.attempts;
      zoning.attempts = 0;
      state.tranche.executionRecoveryMarkers = [
        ...(state.tranche.executionRecoveryMarkers ?? []),
        zoningWaitingMarker,
      ];
      state.journal.push({
        id: `${zoning.id}:recovery:waiting-attempt-accounting`,
        taskId: zoning.id,
        skill: "BoundedRecovery",
        proposalId: null,
        recordedAt: new Date().toISOString(),
        admission: "NOT_REQUIRED",
        execution: "NOT_REQUIRED",
        commandId: null,
        observationId: null,
        observedEffect: "NOT_APPLICABLE",
        failureClassification: "NONE",
        reason: `one-shot recovery removed ${poisonedAttempts} non-execution attempts recorded while waiting for post-road productive-frontage observation`,
      });
      return true;
    }
  }
  const endpointMarker = "ROAD_ENDPOINT_GENERATION_SEMANTICS_MISMATCH";
  const proposalMarker = "ROAD_PROPOSAL_CONSTRUCTION_IMPORT_MISMATCH";
  const quoteMarker = "ROAD_PRE_APPLY_QUOTE_CORRELATION_FAILURE";
  if (state.tranche.stage !== "SITE_SELECTED") return false;
  const current = currentTaskOfKind(state, "ROAD_CONNECTION");
  if (!current || !current.terminalOutcomeId || !["BLOCKED", "FAILED"].includes(current.status)) return false;
  const terminal = state.journal.find((entry) => entry.id === current.terminalOutcomeId && entry.taskId === current.id);
  const latestTaskOutcome = [...state.journal].reverse().find((entry) => entry.taskId === current.id);
  const currentPreflightRejected = !!commands &&
    state.intent.status === "BLOCKED" && state.project.status === "BLOCKED" &&
    current.status === "BLOCKED" && current.attempts < current.maximumAttempts &&
    current.activeCommandId == null && current.childOperationAmendmentId == null &&
    (current.childOperationAmendmentIds?.length ?? 0) === 0 &&
    state.tasks.filter((task) => task.status === "BLOCKED").every((task) => task.id === current.id) &&
    terminal === latestTaskOutcome && terminal.admission === "NOT_REQUIRED" &&
    terminal.execution === "NOT_REQUIRED" && terminal.commandId === null &&
    terminal.failureClassification === "ROAD_PREFLIGHT_REJECTED" &&
    terminal.proposalId === null &&
    !state.tranche.executionRecoveryMarkers?.includes(candidatePreflightMarker) &&
    !commands.list().some((entry) => entry.authorizedScope.owner.ownerType === "TASK" && entry.authorizedScope.owner.ownerId === current.id) &&
    !commands.list().some((entry) =>
      ["CREATED", "AUTHORIZED", "SUBMITTED", "COMMIT_ACK", "NATIVE_COMPLETED", "NATIVE_COMPLETION_UNKNOWN", "UNKNOWN_TIMEOUT", "UNKNOWN_TRANSPORT"].includes(entry.status),
    );
  if (currentPreflightRejected) {
    state.tranche.executionRecoveryMarkers = [...(state.tranche.executionRecoveryMarkers ?? []), candidatePreflightMarker];
    current.status = "PENDING";
    current.terminalOutcomeId = null;
    state.project.status = "ACTIVE";
    state.intent.status = "ACTIVE";
    state.journal.push({
      id: `${current.id}:recovery:candidate-preflight-reevaluation`,
      taskId: current.id,
      skill: "BoundedRecovery",
      proposalId: null,
      recordedAt: new Date().toISOString(),
      admission: "NOT_REQUIRED",
      execution: "NOT_REQUIRED",
      commandId: null,
      observationId: terminal.observationId,
      observedEffect: "NOT_APPLICABLE",
      failureClassification: "NONE",
      reason: "one-shot recovery reopened the same Road task after a bounded candidate-only preflight rejection; attempts and the original rejection evidence are retained",
    });
    return true;
  }
  const unresolvedCommands = commands?.list().filter((entry) =>
    ["CREATED", "AUTHORIZED", "SUBMITTED", "COMMIT_ACK", "NATIVE_COMPLETED", "NATIVE_COMPLETION_UNKNOWN", "UNKNOWN_TIMEOUT", "UNKNOWN_TRANSPORT"].includes(entry.status),
  ) ?? [];
  const quoteFailureIsRecoverable =
    !!commands &&
    state.intent.status === "BLOCKED" &&
    state.project.status === "BLOCKED" &&
    current.status === "BLOCKED" &&
    current.attempts > 0 && current.attempts < current.maximumAttempts &&
    current.activeCommandId == null &&
    current.childOperationAmendmentId === undefined &&
    (current.childOperationAmendmentIds?.length ?? 0) === 0 &&
    state.tasks.filter((task) => task.status === "BLOCKED").every((task) => task.id === current.id) &&
    terminal === latestTaskOutcome &&
    terminal.admission === "ADMITTED" &&
    terminal.execution === "UNKNOWN" &&
    terminal.commandId === null &&
    terminal.failureClassification === "EXECUTION_UNKNOWN" &&
    !!roadPreApplyFailureEvidenceForTask(state, current.id) &&
    terminal.proposalId === `${current.id}:attempt:${current.attempts}` &&
    unresolvedCommands.length === 0 &&
    !commands.list().some((entry) => entry.authorizedScope.owner.ownerType === "TASK" && entry.authorizedScope.owner.ownerId === current.id) &&
    !state.tranche.executionRecoveryMarkers?.includes(quoteMarker);
  if (quoteFailureIsRecoverable) {
    state.tranche.executionRecoveryMarkers = [...(state.tranche.executionRecoveryMarkers ?? []), quoteMarker];
    current.status = "PENDING";
    current.terminalOutcomeId = null;
    state.project.status = "ACTIVE";
    state.intent.status = "ACTIVE";
    state.journal.push({
      id: `${current.id}:recovery:quote-correlation`,
      taskId: current.id,
      skill: "BoundedRecovery",
      proposalId: null,
      recordedAt: new Date().toISOString(),
      admission: "NOT_REQUIRED",
      execution: "NOT_REQUIRED",
      commandId: null,
      observationId: terminal.observationId,
      observedEffect: "NOT_APPLICABLE",
      failureClassification: "NONE",
      reason: "one-shot recovery reopened the same RoadConnection task after an admitted native preview failed quote correlation before authorization or Apply; attempt budget and failure evidence retained",
    });
    return true;
  }
  const failureOutcomes = state.journal.filter((candidate) =>
    candidate.taskId === current.id && candidate.execution !== "NOT_REQUIRED" && candidate.failureClassification !== "NONE",
  );
  const latest = failureOutcomes.at(-1);
  if (!latest || latest.commandId !== null || !["UNKNOWN", "REJECTED"].includes(latest.execution)) return false;
  const endpointFailure = failureOutcomes.length > 0 && failureOutcomes.every((outcome) =>
    ["UNKNOWN", "REJECTED"].includes(outcome.execution) &&
    ["EXECUTION_UNKNOWN", "EXECUTION_REJECTED"].includes(outcome.failureClassification) &&
    outcome.commandId === null &&
    /\bROAD_ENDPOINT_WORLD_EPOCH_MISMATCH\b/.test(outcome.reason)
  );
  const proposalConstructionFailure = /stableRoadInput\)\s+is not a function/.test(latest.reason) &&
    failureOutcomes.every((outcome) => outcome.commandId === null);
  const marker = endpointFailure ? endpointMarker : proposalConstructionFailure ? proposalMarker : null;
  if (!marker || state.tranche.executionRecoveryMarkers?.includes(marker)) return false;
  if (endpointFailure) {
    if (current.status === "BLOCKED" && current.attempts >= current.maximumAttempts) return false;
    if (current.status === "FAILED" && current.attempts < current.maximumAttempts) return false;
  } else if (current.attempts < current.maximumAttempts) return false;
  state.tranche.executionRecoveryMarkers = [...(state.tranche.executionRecoveryMarkers ?? []), marker];
  current.status = "PENDING";
  current.terminalOutcomeId = null;
  state.project.status = "ACTIVE";
  state.intent.status = "ACTIVE";
  state.journal.push({
    id: `${current.id}:recovery:${state.tranche.executionRecoveryMarkers.length}`,
    taskId: current.id,
    skill: "BoundedRecovery",
    proposalId: null,
    recordedAt: new Date().toISOString(),
    admission: "NOT_REQUIRED",
    execution: "NOT_REQUIRED",
    commandId: null,
    observationId: null,
    observedEffect: "NOT_APPLICABLE",
    failureClassification: "NONE",
    reason: `one-shot recovery reopened the same RoadConnection task after confirmed pre-submit ${endpointFailure ? "endpoint generation semantics" : "proposal construction"} failure`,
  });
  return true;
}

function reconcileRestoredRoadFalseDelivery(state: Gate1State, commands?: V2CommandJournal): boolean {
  if (!commands) return false;
  const markerPrefix = "ROAD_RECEIPT_FALSE_DELIVERY_RECONCILED:";
  const roadTask = currentTaskOfKind(state, "ROAD_CONNECTION");
  if (
    state.tranche.stage === "SITE_SELECTED" &&
    roadTask?.status === "FAILED" &&
    roadTask.terminalOutcomeId &&
    state.intent.status === "BLOCKED" &&
    state.project.status === "BLOCKED"
  ) {
    const outcomes = state.journal.filter((entry) => entry.taskId === roadTask.id);
    const noEffectOutcome = outcomes.find((entry) =>
      entry.execution === "REJECTED" &&
      entry.failureClassification === "EXECUTION_REJECTED" &&
      entry.commandId !== null &&
      /complete authoritative Idle topology contains no connected Medium Road effect matching the proposal/.test(entry.reason),
    );
    const consumedOutcome = outcomes.at(-1);
    const command = noEffectOutcome?.commandId ? commands.get(noEffectOutcome.commandId) : undefined;
    const consumedCommand = consumedOutcome?.commandId ? commands.get(consumedOutcome.commandId) : undefined;
    const marker = noEffectOutcome?.commandId ? `ROAD_LENGTH_OR_SNAP_DEGENERACY:${noEffectOutcome.commandId}` : null;
    const safeRecovery =
      !!noEffectOutcome &&
      consumedOutcome?.reason === "authorization_already_consumed" &&
      !!consumedCommand &&
      consumedCommand.actionFamily === "ROAD" &&
      consumedCommand.status === "FAILED_BEFORE_SUBMIT" &&
      consumedCommand.bridgeCommandId === null &&
      consumedCommand.submittedAt === null &&
      !!command &&
      command.actionFamily === "ROAD" &&
      command.status === "OBSERVED_MISMATCH" &&
      command.reconciliationStatus === "MISMATCH" &&
      command.effectAbsenceProven &&
      roadTask.attempts >= roadTask.maximumAttempts &&
      !!marker &&
      !state.tranche.executionRecoveryMarkers?.includes(marker);
    if (safeRecovery) {
      state.tranche.executionRecoveryMarkers = [
        ...(state.tranche.executionRecoveryMarkers ?? []),
        marker,
      ];
      roadTask.maximumAttempts += 1;
      roadTask.status = "PENDING";
      roadTask.terminalOutcomeId = null;
      roadTask.activeCommandId = null;
      state.project.status = "ACTIVE";
      state.intent.status = "ACTIVE";
      state.journal.push({
        id: `${roadTask.id}:recovery:length:${state.journal.length + 1}`,
        taskId: roadTask.id,
        skill: "BoundedRecovery",
        proposalId: null,
        recordedAt: new Date().toISOString(),
        admission: "NOT_REQUIRED",
        execution: "NOT_REQUIRED",
        commandId: noEffectOutcome.commandId,
        observationId: noEffectOutcome.observationId,
        observedEffect: "UNKNOWN",
        failureClassification: "NONE",
        reason: "one-shot recovery reopened the same RoadConnection task after confirmed nonproductive starter-road geometry; a fresh authorization and execution artifact are required",
      });
      return true;
    }
  }
  if (state.tranche.stage !== "ROAD_DELIVERED") return false;
  if (!roadTask || roadTask.status !== "SUCCEEDED" || !roadTask.terminalOutcomeId) return false;
  const delivered = state.journal.find((entry) => entry.id === roadTask.terminalOutcomeId);
  if (!delivered?.commandId || delivered.execution !== "DELIVERED") return false;
  const command = commands.get(delivered.commandId);
  if (
    !command ||
    command.actionFamily !== "ROAD" ||
    command.status !== "OBSERVED_MISMATCH" ||
    command.reconciliationStatus !== "MISMATCH" ||
    !command.effectAbsenceProven ||
    command.authorizedScope.actionFamily !== "ROAD" ||
    command.authorizedScope.owner.ownerType !== "TASK" ||
    command.authorizedScope.owner.ownerId !== roadTask.id ||
    state.tranche.executionRecoveryMarkers?.includes(`${markerPrefix}${command.commandId}`)
  ) return false;
  const deliveredIndex = state.journal.findIndex((entry) => entry.id === delivered.id);
  const laterWorldWrite = state.journal
    .slice(deliveredIndex + 1)
    .some((entry) => entry.commandId !== null);
  if (laterWorldWrite) return false;

  state.tranche.executionRecoveryMarkers = [
    ...(state.tranche.executionRecoveryMarkers ?? []),
    `${markerPrefix}${command.commandId}`,
  ];
  state.tranche.stage = "SITE_SELECTED";
  roadTask.status = "PENDING";
  roadTask.terminalOutcomeId = null;
  roadTask.activeCommandId = null;
  state.project.status = "ACTIVE";
  state.intent.status = "ACTIVE";
  state.tranche.delivery_progress.completed = Math.max(1, state.tranche.delivery_progress.completed - 1);
  state.tranche.delivery_progress.ratio =
    state.tranche.delivery_progress.completed / state.tranche.delivery_progress.total;
  const siteTask = state.tasks.find((candidate) => candidate.kind === "SITE_SELECTION");
  state.tranche.delivery_progress.lastOutcomeId = siteTask?.terminalOutcomeId ?? null;
  state.tranche.effect_progress.status = "NOT_OBSERVED";
  state.journal.push({
    id: `${roadTask.id}:recovery:execution-truth:${state.journal.length + 1}`,
    taskId: roadTask.id,
    skill: "BoundedRecovery",
    proposalId: null,
    recordedAt: new Date().toISOString(),
    admission: "NOT_REQUIRED",
    execution: "NOT_REQUIRED",
    commandId: command.commandId,
    observationId: command.observationEvidence.at(-1)?.observationId ?? null,
    observedEffect: "UNKNOWN",
    failureClassification: "NONE",
    reason: "same RoadConnection task reopened once after complete authoritative topology proved the prior ACK produced no road effect",
  });
  return true;
}

export function recoverRoadConnectionForStarterFrontage(
  state: Gate1State,
  commands: V2CommandJournal,
  evidence: { observationId: string; reason: string },
): boolean {
  const marker = "ROAD_FRONTAGE_GEOMETRY_RECOVERY:1";
  const roadTask = currentTaskOfKind(state, "ROAD_CONNECTION");
  if (
    state.tranche.stage !== "ROAD_DELIVERED" ||
    state.intent.status !== "ACTIVE" ||
    state.project.status !== "ACTIVE" ||
    !roadTask ||
    roadTask.status !== "SUCCEEDED" ||
    !roadTask.terminalOutcomeId ||
    state.tranche.executionRecoveryMarkers?.includes(marker)
  ) return false;
  const delivered = state.journal.find((entry) => entry.id === roadTask.terminalOutcomeId);
  if (!delivered?.commandId || delivered.execution !== "DELIVERED") return false;
  const command = commands.get(delivered.commandId);
  if (
    !command ||
    command.actionFamily !== "ROAD" ||
    command.status !== "OBSERVED_MATCH" ||
    command.reconciliationStatus !== "MATCH" ||
    command.authorizedScope.owner.ownerType !== "TASK" ||
    command.authorizedScope.owner.ownerId !== roadTask.id
  ) return false;
  state.tranche.executionRecoveryMarkers = [...(state.tranche.executionRecoveryMarkers ?? []), marker];
  roadTask.maximumAttempts += 1;
  roadTask.status = "PENDING";
  roadTask.terminalOutcomeId = null;
  roadTask.activeCommandId = null;
  state.tranche.stage = "SITE_SELECTED";
  state.tranche.delivery_progress.completed = Math.max(1, state.tranche.delivery_progress.completed - 1);
  state.tranche.delivery_progress.ratio = state.tranche.delivery_progress.completed / state.tranche.delivery_progress.total;
  const siteTask = state.tasks.find((candidate) => candidate.kind === "SITE_SELECTION");
  state.tranche.delivery_progress.lastOutcomeId = siteTask?.terminalOutcomeId ?? null;
  state.tranche.effect_progress.status = "NOT_OBSERVED";
  state.tranche.effect_progress.lastObservationId = evidence.observationId;
  state.journal.push({
    id: `${roadTask.id}:recovery:frontage:${state.journal.length + 1}`,
    taskId: roadTask.id,
    skill: "BoundedRecovery",
    proposalId: null,
    recordedAt: new Date().toISOString(),
    admission: "NOT_REQUIRED",
    execution: "NOT_REQUIRED",
    commandId: delivered.commandId,
    observationId: evidence.observationId,
    observedEffect: "UNKNOWN",
    failureClassification: "NONE",
    reason: evidence.reason,
  });
  return true;
}

export function recoverRoadConnectionForContinuationDirection(
  state: Gate1State,
  evidence: { observationId: string; reason: string },
): boolean {
  const marker = "ROAD_CONTINUATION_DIRECTION_RECOVERY:1";
  const roadTask = currentTaskOfKind(state, "ROAD_CONNECTION");
  const latest = roadTask ? [...state.journal].reverse().find((entry) => entry.taskId === roadTask.id) : undefined;
  if (
    state.tranche.stage !== "SITE_SELECTED" ||
    state.intent.status !== "BLOCKED" ||
    state.project.status !== "BLOCKED" ||
    !roadTask ||
    roadTask.status !== "BLOCKED" ||
    !roadTask.terminalOutcomeId ||
    latest?.reason !== "NO_PRODUCTIVE_ROAD_EFFECT" ||
    latest.execution !== "UNKNOWN" ||
    latest.commandId !== null ||
    state.tranche.executionRecoveryMarkers?.includes(marker)
  ) return false;
  state.tranche.executionRecoveryMarkers = [...(state.tranche.executionRecoveryMarkers ?? []), marker];
  roadTask.maximumAttempts += 1;
  roadTask.status = "PENDING";
  roadTask.terminalOutcomeId = null;
  roadTask.activeCommandId = null;
  state.intent.status = "ACTIVE";
  state.project.status = "ACTIVE";
  state.journal.push({
    id: `${roadTask.id}:recovery:direction:${state.journal.length + 1}`,
    taskId: roadTask.id,
    skill: "BoundedRecovery",
    proposalId: null,
    recordedAt: new Date().toISOString(),
    admission: "NOT_REQUIRED",
    execution: "NOT_REQUIRED",
    commandId: null,
    observationId: evidence.observationId,
    observedEffect: "UNKNOWN",
    failureClassification: "NONE",
    reason: evidence.reason,
  });
  return true;
}

export function recoverZoningForPreSubmitRadiusRejection(
  state: Gate1State,
  commands: V2CommandJournal,
  evidence: { observationId: string; reason: string },
): boolean {
  const marker = "ZONING_EXACT_RADIUS_RECOVERY:1";
  const zoning = state.tasks.find((candidate) => candidate.kind === "ZONING");
  const latest = zoning ? [...state.journal].reverse().find((entry) => entry.taskId === zoning.id) : undefined;
  const command = latest?.commandId ? commands.get(latest.commandId) : undefined;
  if (
    state.tranche.stage !== "ROAD_DELIVERED" ||
    state.intent.status !== "BLOCKED" ||
    state.project.status !== "BLOCKED" ||
    !zoning ||
    zoning.status !== "BLOCKED" ||
    !zoning.terminalOutcomeId ||
    latest?.reason !== "zoning delivery lacked exact observed effect" ||
    latest.execution !== "REJECTED" ||
    latest.failureClassification !== "EXECUTION_UNKNOWN" ||
    !command ||
    command.actionFamily !== "ZONING" ||
    command.status !== "FAILED_BEFORE_SUBMIT" ||
    command.submittedAt !== null ||
    command.failureOrUnknownReason !== "native radius could affect 4 unauthorized cell(s)" ||
    state.tranche.executionRecoveryMarkers?.includes(marker)
  ) return false;
  state.tranche.executionRecoveryMarkers = [...(state.tranche.executionRecoveryMarkers ?? []), marker];
  zoning.status = "PENDING";
  zoning.terminalOutcomeId = null;
  zoning.activeCommandId = null;
  state.intent.status = "ACTIVE";
  state.project.status = "ACTIVE";
  state.journal.push({
    id: `${zoning.id}:recovery:exact-radius:${state.journal.length + 1}`,
    taskId: zoning.id,
    skill: "BoundedRecovery",
    proposalId: null,
    recordedAt: new Date().toISOString(),
    admission: "NOT_REQUIRED",
    execution: "NOT_REQUIRED",
    commandId: latest.commandId,
    observationId: evidence.observationId,
    observedEffect: "UNKNOWN",
    failureClassification: "NONE",
    reason: evidence.reason,
  });
  return true;
}

export function createMemoryGate1StateStorage(initial?: unknown): Gate1StateStorage & { value(): unknown } {
  let value = clone(initial);
  return {
    load: () => clone(value),
    save: (state) => {
      value = clone(state);
    },
    value: () => clone(value),
  };
}

export function createDurableGate1StateStorage(coordinator: V2DurabilityCoordinator): Gate1StateStorage {
  return {
    load: () => {
      const value = coordinator.projectState();
      return value.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION ? value : undefined;
    },
    save: (state) => coordinator.saveProjectState(state),
  };
}

function proposalFor(
  state: Gate1State,
  current: Gate1Task,
  getChildOperation?: (amendmentId: string) => V2UtilityBudgetAmendmentRecord | null,
): Gate1SkillProposal {
  const mapping: Record<
    Gate1TaskKind,
    Pick<Gate1SkillProposal, "skill" | "kind" | "actionFamily" | "operation" | "boundedFallback">
  > = {
    SITE_SELECTION: {
      skill: "SiteSelection",
      kind: "STATE",
      actionFamily: null,
      operation: "SELECT_SITE",
      boundedFallback: null,
    },
    ROAD_CONNECTION: {
      skill: "RoadConnection",
      kind: "WORLD_WRITE",
      actionFamily: "ROAD",
      operation: "BUILD_ROAD",
      boundedFallback: "one in-reservation RoadExtension alternative",
    },
    WAIT_FOR_BUILDING: {
      skill: "WaitObserve",
      kind: "OBSERVE",
      actionFamily: null,
      operation: "WAIT",
      boundedFallback: null,
    },
    UTILITY_PROVISION: {
      skill: "UtilityProvision",
      kind: "OBSERVE",
      actionFamily: null,
      operation: "CERTIFY_UTILITIES",
      boundedFallback: null,
    },
    ZONING: {
      skill: "Zoning",
      kind: "WORLD_WRITE",
      actionFamily: "ZONING",
      operation: "ZONE_RESIDENTIAL",
      boundedFallback: "one smaller exact in-reservation cell set",
    },
    WAIT_OBSERVE: {
      skill: "WaitObserve",
      kind: "OBSERVE",
      actionFamily: null,
      operation: "WAIT",
      boundedFallback: null,
    },
    OCCUPANCY_DIAGNOSIS: {
      skill: "OccupancyDiagnosis",
      kind: "OBSERVE",
      actionFamily: null,
      operation: "DIAGNOSE",
      boundedFallback: null,
    },
    RECOVERY: {
      skill: "BoundedRecovery",
      kind: "WORLD_WRITE",
      actionFamily: "ROAD",
      operation: "RECOVER",
      boundedFallback: null,
    },
  };
  const childId = current.childOperationAmendmentId ?? current.childOperationAmendmentIds?.[0];
  const amendment = childId ? getChildOperation?.(childId) : null;
  const concreteChildOperation = amendment?.reason === UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON &&
    amendment.exactRoadInput && amendment.planRevision && amendment.courseFingerprint
    ? {
        amendmentId: amendment.amendmentId,
        planRevision: amendment.planRevision,
        input: clone(amendment.exactRoadInput),
        courseFingerprint: amendment.courseFingerprint,
      }
    : undefined;
  return {
    id: `${current.id}:attempt:${current.attempts + 1}`,
    attempt: current.attempts + 1,
    ...mapping[current.kind],
    taskId: current.id,
    projectId: state.project.id,
    districtId: state.district.id,
    trancheId: state.tranche.id,
    reservationRef: state.tranche.reservationRef,
    requiredStage: current.legalStage,
    target: clone(state.tranche.target),
    methodVariant: current.attempts === 0 ? "PRIMARY" : "BOUNDED_FALLBACK",
    ...(concreteChildOperation ? { concreteChildOperation } : {}),
  };
}

function admissionError(
  state: Gate1State,
  current: Gate1Task,
  proposal: Gate1SkillProposal,
  childContext?: Gate1ConcreteChildOperationAdmissionContext,
  legalStage: Gate1Stage = current.legalStage,
): string | null {
  if (current.status !== "DISPATCHED") return "task is not dispatched";
  if (state.tranche.stage !== legalStage || proposal.requiredStage !== legalStage)
    return "proposal is stale for current tranche stage";
  if (
    proposal.taskId !== current.id ||
    proposal.projectId !== state.project.id ||
    proposal.districtId !== state.district.id ||
    proposal.trancheId !== state.tranche.id ||
    proposal.reservationRef !== state.tranche.reservationRef
  )
    return "proposal ownership differs from bounded project/tranche scope";
  if (!contains(state.district.boundary, proposal.target) || !contains(state.tranche.target, proposal.target))
    return "proposal target escapes tranche reservation";
  if (proposal.actionFamily && !state.tranche.allowedActionFamilies.includes(proposal.actionFamily))
    return "proposal action family is outside tranche scope";
  if (proposal.operation === "RECOVER" && state.tranche.recoveryAttempts >= state.tranche.maximumRecoveryAttempts)
    return "bounded recovery exhausted";
  if ((current.childOperationAmendmentId || current.childOperationAmendmentIds?.length) && !proposal.concreteChildOperation)
    return "referenced utility service-road child operation could not be rehydrated";
  const orderedChildren = current.childOperationAmendmentIds;
  if (orderedChildren?.length) {
    const currentChildId = current.childOperationAmendmentId ?? orderedChildren[0];
    const index = orderedChildren.indexOf(currentChildId);
    if (orderedChildren.length > 4 || new Set(orderedChildren).size !== orderedChildren.length || index < 0)
      return "utility service-road child sequence is invalid";
    if (orderedChildren.slice(0, index).some((id) => {
      const prior = childContext?.getAmendment(id);
      return prior?.status !== "CONSUMED" || prior.executionUseStatus !== "CONSUMED";
    })) return "utility service-road child sequence is out of order";
  }
  if (proposal.concreteChildOperation) {
    const child = proposal.concreteChildOperation;
    const amendment = childContext?.getAmendment(child.amendmentId);
    const exactInput = stableRoadInput(child.input);
    if (!amendment || amendment.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON)
      return "utility service-road child operation is missing";
    if (amendment.status !== "ACTIVE" || amendment.executionUseLimit !== 1 || amendment.executionUseStatus !== "UNUSED")
      return "utility service-road child operation is not available for execution";
    if (amendment.amendmentId !== (current.childOperationAmendmentId ?? current.childOperationAmendmentIds?.[0]) || amendment.projectId !== state.project.id ||
      amendment.trancheId !== state.tranche.id || amendment.reservationRef !== state.tranche.reservationRef)
      return "utility service-road child operation ownership mismatch";
    if (child.courseFingerprint !== amendment.courseFingerprint || exactInput !== amendment.courseFingerprint ||
      !amendment.exactRoadInput || stableRoadInput(amendment.exactRoadInput) !== amendment.courseFingerprint ||
      JSON.stringify(child.input) !== JSON.stringify(amendment.exactRoadInput))
      return "utility service-road child operation exact input mismatch";
    const active = childContext?.current;
    if (!active || amendment.planRevision !== child.planRevision || child.planRevision !== active.planRevision)
      return "utility service-road child operation plan revision is stale";
    if (amendment.authorizationWorldId !== active.worldId || amendment.authorizationCheckpointId !== active.checkpointId ||
      amendment.authorizationGeneration !== active.generation)
      return "utility service-road child operation world identity is stale";
    if (!pointWithinCircleScope({ x: child.input.x1, z: child.input.z1 }, state.project.utilityReservation) ||
      !pointWithinCircleScope({ x: child.input.x2, z: child.input.z2 }, state.project.utilityReservation))
      return "utility service-road child operation escapes utility reservation";
    if (childContext.hasRoadOperation(exactInput)) return "utility service-road child operation already has a Road command";
  }
  return null;
}

export type Gate1AdmissionDecision = Gate1AdmittedProposal | { admission: { decision: "REJECTED"; reason: string } };

export function admitGate1Proposal(
  state: Gate1State,
  current: Gate1Task,
  proposal: Gate1SkillProposal,
  now = new Date(),
  childContext?: Gate1ConcreteChildOperationAdmissionContext,
  /** The stage this Goal says the task belongs at; defaults to the task's own. */
  legalStage: Gate1Stage = current.legalStage,
): Gate1AdmissionDecision {
  const error = admissionError(state, current, proposal, childContext, legalStage);
  if (error) return { admission: { decision: "REJECTED", reason: error } };
  return {
    ...proposal,
    admission: {
      decision: "ADMITTED",
      admittedAt: now.toISOString(),
      scopeFingerprint: `${proposal.projectId}|${proposal.districtId}|${proposal.trancheId}|${proposal.reservationRef}`,
    },
  };
}

type KnownGate1Observation = Gate1Observation & {
  actualResidents: { value: number; provenance: "OBSERVED" };
  occupiedResidentialBuildings: { value: SpatialEntityRef[]; provenance: "OBSERVED" };
};

function isKnownObservation(
  observation: Gate1Observation | undefined,
  trancheId: string,
): observation is KnownGate1Observation {
  return (
    !!observation &&
    observation.trancheId === trancheId &&
    observation.coherence !== "UNKNOWN" &&
    observation.actualResidents.value !== null &&
    observation.occupiedResidentialBuildings.value !== null
  );
}

function updateDelivery(state: Gate1State, outcomeId: string): void {
  state.tranche.delivery_progress.completed += 1;
  state.tranche.delivery_progress.ratio =
    state.tranche.delivery_progress.completed / state.tranche.delivery_progress.total;
  state.tranche.delivery_progress.lastOutcomeId = outcomeId;
}

function appendTask(state: Gate1State, entry: Gate1Task): void {
  if (!state.tasks.some((candidate) => candidate.id === entry.id)) {
    state.tasks.push(entry);
    state.tranche.taskIds.push(entry.id);
  }
}

export interface Gate1TickResult {
  state: Gate1State;
  task: Gate1Task | null;
  proposal: Gate1SkillProposal | null;
  outcome: Gate1OutcomeJournalEntry | null;
}

/**
 * What the Goal this tranche belongs to says its own deliverable is.
 *
 * A tranche is a template, not a purpose: the same starter ladder serves a base
 * utility Goal and a growth Goal, and which one it is serving is a fact only the
 * Goal holds. Passing it down lets a task answer the question its own Goal asked
 * without a second durable field, and without making one Goal's answer apply to
 * the other's.
 */
export interface Gate1TickOptions {
  /** The stage at which the Goal this tranche serves is complete. */
  goalCompletionStage?: Gate1Stage;
  /**
   * Whether the Goal the tranche serves is a base utility Goal, whose
   * deliverable is the utility itself rather than the development on its land.
   *
   * Stated, not inferred. It used to be read off `goalCompletionStage ===
   * "WAITING_FOR_OCCUPANCY"`, which was a proxy that held only while growth
   * Goals declared `OCCUPIED`: the moment the product stopped making a growth
   * Goal wait for occupancy, the two kinds shared a milestone and the proxy
   * silently reclassified every growth Goal as a utility Goal. Measured live
   * (2026-09-30): a commercial tranche then had its `ZONING` task excluded as
   * "not a utility Goal's business", leaving `UTILITY_PROVISION` to wait 110
   * attempts for a building that only zoning could have produced.
   */
  servesBaseUtilityGoal?: boolean;
}

/**
 * Whether the Goal this tranche serves is a base utility Goal.
 *
 * Absent means "not stated", and the conservative reading is the one that keeps
 * the residential ladder intact: a tranche nobody described as a utility
 * tranche runs the growth tasks. Callers that know the Goal state it.
 */
const servesBaseUtilityGoal = (options?: Gate1TickOptions): boolean =>
  options?.servesBaseUtilityGoal === true;

/**
 * The tasks that carry a tranche through RESIDENTIAL GROWTH: zone the land, wait
 * for the simulation to build on it, certify the occupants' service, and
 * diagnose an unabsorbed tranche.
 *
 * A tranche is a template, and these steps belong to a Goal whose deliverable is
 * absorption. A base utility Goal's deliverable is the utility itself, so they
 * are not its business — and running them is not merely wasted work. They move
 * the tranche off `ROAD_DELIVERED`, and `buildUtilityPreparationInput` admits
 * supply-side utility execution only at that stage, so leaving it strands a
 * placed facility permanently. Measured live (2026-09-30): `SewageOutlet01`
 * placed, the tranche then zoned, and the connection could never be admitted
 * again — the Goal ended at `ZONED_WAITING_FOR_BUILDING` reporting "no
 * attributed building yet" about land a sewage Goal was never waiting on.
 */
const RESIDENTIAL_GROWTH_TASK_KINDS: readonly Gate1TaskKind[] =
  ["ZONING", "WAIT_FOR_BUILDING", "WAIT_OBSERVE", "OCCUPANCY_DIAGNOSIS"];

/**
 * The stage a task is executable at, as the Goal this tranche serves defines it.
 *
 * A base utility Goal's `UTILITY_PROVISION` task is executable as soon as the
 * road its facility needs is delivered: there is no consumer to wait for,
 * because the utility IS the deliverable. Its own `legalStage` names the stage
 * the residential ladder arrives at, which a utility Goal never reaches — and
 * would therefore refuse the task on a technicality the Goal does not share.
 * Growth Goals reach the same task through that ladder and are untouched.
 */
const legalStageFor = (state: Gate1State, current: Gate1Task, baseUtilityGoal: boolean): Gate1Stage =>
  baseUtilityGoal && current.kind === "UTILITY_PROVISION" ? "ROAD_DELIVERED" : current.legalStage;

export interface Gate1VerticalSlice {
  snapshot(): Gate1State;
  recordUtilityExecution(value: DurableGreenfieldUtilityState): Gate1State;
  completeOccupiedProject(): { state: Gate1State; newlyCompleted: boolean };
  startNextProject(input: StarterResidentialIntentInput): Gate1State;
  tick(observation?: Gate1Observation, signal?: AbortSignal, options?: Gate1TickOptions): Promise<Gate1TickResult>;
}

export function createGate1VerticalSlice(options: {
  storage: Gate1StateStorage;
  initial?: StarterResidentialIntentInput;
  boundary: Gate1WorldBoundary;
  planIntent?: typeof planStarterResidentialIntent;
  commandJournal?: V2CommandJournal;
  utilityServiceRoadChildOperation?(amendmentId: string): V2UtilityBudgetAmendmentRecord | null;
  concreteChildOperationAdmissionContext?(observation?: Gate1Observation): Gate1ConcreteChildOperationAdmissionContext;
  now?: () => Date;
}): Gate1VerticalSlice {
  const now = options.now ?? (() => new Date());
  const planIntent = options.planIntent ?? planStarterResidentialIntent;
  const loaded = options.storage.load();
  let state =
    loaded === undefined
      ? planIntent(
          options.initial ??
            (() => {
              throw new Error("initial CityIntent is required");
            })(),
          now(),
        )
      : assertState(loaded);
  const restoredPreSubmitRoadRejection = loaded !== undefined && reconcileRestoredPreSubmitRoadRejection(state, options.commandJournal);
  const restoredRoadFalseDelivery = loaded !== undefined && reconcileRestoredRoadFalseDelivery(state, options.commandJournal);
  const restoredStateRepaired = restoredPreSubmitRoadRejection || restoredRoadFalseDelivery;
  if (restoredStateRepaired) state.stateVersion += 1;
  if (loaded === undefined || restoredStateRepaired) options.storage.save(state);

  const persist = () => {
    state.stateVersion += 1;
    options.storage.save(state);
  };
  const journal = (
    current: Gate1Task,
    proposal: Gate1SkillProposal | null,
    fields: Omit<Gate1OutcomeJournalEntry, "id" | "taskId" | "skill" | "proposalId" | "recordedAt">,
  ) => {
    const id = `${current.id}:outcome:${state.journal.length + 1}`;
    const entry: Gate1OutcomeJournalEntry = {
      id,
      taskId: current.id,
      skill: proposal?.skill ?? "WaitObserve",
      proposalId: proposal?.id ?? null,
      recordedAt: now().toISOString(),
      ...fields,
    };
    state.journal.push(entry);
    return entry;
  };

  return {
    snapshot: () => clone(state),
    completeOccupiedProject() {
      if (state.completion) return { state: clone(state), newlyCompleted: false };
      if (state.project.status !== "OCCUPIED" || state.tranche.stage !== "OCCUPIED" || state.intent.status !== "SATISFIED") {
        throw new Error("only an authoritatively occupied Gate 1 project can complete");
      }
      const terminal = [...state.journal].reverse().find((entry) => entry.observedEffect === "OCCUPIED");
      if (!terminal) throw new Error("occupied project lacks durable terminal effect evidence");
      state.project.status = "COMPLETE";
      state.completion = {
        completionId: `${state.project.id}:completion`,
        completedAt: now().toISOString(),
        terminalOutcomeId: terminal.id,
        releasedReservationRefs: [state.tranche.reservationRef],
        handoffStatus: "NEXT_DECISION_READY",
        nextDecisionId: null,
        handedOffAt: null,
      };
      persist();
      return { state: clone(state), newlyCompleted: true };
    },
    startNextProject(input) {
      if (state.project.status !== "COMPLETE" || !state.completion || state.completion.handoffStatus !== "NEXT_DECISION_READY") {
        throw new Error("next decision requires one completed project with an unconsumed handoff");
      }
      const next = planIntent(input, now());
      if (next.intent.id === state.intent.id || next.project.id === state.project.id) {
        throw new Error("next Local V2 decision must have new Intent and Project identities");
      }
      next.predecessorCompletionId = state.completion.completionId;
      state = next;
      // One storage commit replaces the completed current project with the new
      // identity. Durable storage consumes the archived handoff in that same
      // commit, so interruption cannot leave a consumed handoff without a project.
      options.storage.save(state);
      return clone(state);
    },
    recordUtilityExecution(value) {
      if (state.tranche.stage !== "ROAD_DELIVERED" || value.scope.intentId !== state.intent.id ||
        value.scope.projectId !== state.project.id || value.scope.trancheId !== state.tranche.id ||
        value.scope.reservationRef !== state.tranche.reservationRef ||
        value.scope.spatialEnvelope.center.x !== state.project.utilityReservation.center.x ||
        value.scope.spatialEnvelope.center.z !== state.project.utilityReservation.center.z ||
        value.scope.spatialEnvelope.radius !== state.project.utilityReservation.radius) {
        throw new Error("utility execution evidence is outside the current Gate1 scope");
      }
      state.tranche.utilityExecution = clone(value);
      persist();
      return clone(state);
    },
    async tick(observation, signal, tickOptions) {
      const latest = options.storage.load();
      if (latest !== undefined) {
        const refreshed = assertState(latest);
        if (refreshed.project.id === state.project.id && refreshed.tranche.id === state.tranche.id) {
          state = refreshed;
        }
      }
    const baseUtilityGoal = servesBaseUtilityGoal(tickOptions);
    const eligible = state.tasks.filter(
      (candidate) =>
        (!state.tranche.currentTaskIds?.[candidate.kind] || state.tranche.currentTaskIds[candidate.kind] === candidate.id) &&
        (candidate.status === "PENDING" || candidate.status === "WAITING") &&
        legalStageFor(state, candidate, baseUtilityGoal) === state.tranche.stage &&
        (!baseUtilityGoal || !RESIDENTIAL_GROWTH_TASK_KINDS.includes(candidate.kind)),
    );
    const current = chooseGate1CapabilityTask(state.tranche.stage, eligible, state.tranche.currentTaskIds);
      if (!current) return { state: clone(state), task: null, proposal: null, outcome: null };

      // A prerequisite observation is a wait boundary, not an execution
      // attempt. Utility delivery is orchestrated by production progression;
      // frontage and utility supply are planning inputs, not zoning Apply gates.
      if (current.kind === "ZONING" && (
        !observation ||
        observation.trancheId !== state.tranche.id ||
        observation.coherence === "UNKNOWN"
      )) {
        const outcome = journal(current, null, {
          admission: "NOT_REQUIRED",
          execution: "NOT_REQUIRED",
          commandId: null,
          observationId: observation?.observationId ?? null,
          observedEffect: "UNKNOWN",
          failureClassification: "OBSERVATION_UNKNOWN",
          reason: "coherent current-world observation is required before zoning planning",
        });
        persist();
        return { state: clone(state), task: clone(current), proposal: null, outcome };
      }

      const reconciling = current.status === "WAITING" && current.activeCommandId !== null;
      let proposal: Gate1SkillProposal;
      let outcome: Gate1OutcomeJournalEntry | null = null;
      let execution: Gate1ExecutionOutcome = {
        status: "DELIVERED",
        commandId: null,
        observedMatch: true,
        reason: "state/observation proposal accepted",
      };
      if (reconciling) {
        proposal = proposalFor(state, { ...current, attempts: Math.max(0, current.attempts - 1) }, options.utilityServiceRoadChildOperation);
        if (!current.activeCommandId || !options.boundary.reconcile) {
          execution = {
            status: "UNKNOWN",
            commandId: current.activeCommandId ?? null,
            observedMatch: false,
            reason: "waiting ROAD command lacks a typed reconciliation boundary",
          };
        } else {
          execution = await options.boundary.reconcile(current.activeCommandId, signal, proposal.actionFamily ?? undefined);
        }
      } else {
        const candidateProposal = proposalFor(state, current, options.utilityServiceRoadChildOperation);
        if (current.kind === "ROAD_CONNECTION" && options.boundary.preflightRoad) {
          const preflightProposal = { ...candidateProposal, id: `${current.id}:candidate-preflight:${state.journal.length + 1}` };
          let preflight: Gate1RoadPreflightResult;
          try {
            preflight = await options.boundary.preflightRoad(preflightProposal, signal);
          } catch (error) {
            if (!(error instanceof Gate1BoundedRoadSiteDeadEndError)) throw error;
            // The bounded replay of this tranche's own admission could not
            // reproduce the site it reserved, so there is no candidate to
            // preflight and no second candidate to fall back to. Left to
            // propagate, this ended the whole progression as an exception and
            // left a tranche the durable state could not resolve: an ACTIVE
            // project at SITE_SELECTED whose Road task never got a terminal
            // outcome, so its Goal could not close and the Brain had nothing to
            // re-plan from. It is a bounded terminal of THIS task instead — and
            // a classification of its own, so the one-shot candidate-family
            // re-evaluation (which exists for a different, since-fixed defect)
            // cannot reopen it.
            current.status = "BLOCKED";
            current.activeCommandId = null;
            state.project.status = "BLOCKED";
            state.intent.status = "BLOCKED";
            outcome = journal(current, null, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation?.observationId ?? null,
              observedEffect: "NOT_APPLICABLE",
              failureClassification: "ROAD_SITE_TARGET_NOT_REPRODUCED",
              reason: error.message,
            });
            current.terminalOutcomeId = outcome.id;
            persist();
            return { state: clone(state), task: clone(current), proposal: null, outcome };
          }
          if (preflight.status === "NO_FEASIBLE_CANDIDATE") {
            current.status = "BLOCKED";
            state.project.status = "BLOCKED";
            state.intent.status = "BLOCKED";
            outcome = journal(current, null, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation?.observationId ?? null,
              observedEffect: "NOT_APPLICABLE",
              failureClassification: "ROAD_PREFLIGHT_REJECTED",
              reason: preflight.reason,
            });
            current.terminalOutcomeId = outcome.id;
            persist();
            return { state: clone(state), task: clone(current), proposal: null, outcome };
          }
          if (preflight.status === "ALREADY_CONNECTED") {
            // The reservation already has the access this task exists to
            // provide. Nothing is dispatched, admitted or submitted: the task
            // completes on the world's own fact, and the tranche proceeds to the
            // step that actually needs the frontage.
            current.status = "SUCCEEDED";
            current.activeCommandId = null;
            state.tranche.stage = "ROAD_DELIVERED";
            outcome = journal(current, null, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation?.observationId ?? null,
              observedEffect: "NOT_APPLICABLE",
              failureClassification: "NONE",
              reason: `ROAD_ALREADY_CONNECTED:${preflight.reason}`,
            });
            current.terminalOutcomeId = outcome.id;
            updateDelivery(state, outcome.id);
            persist();
            return { state: clone(state), task: clone(current), proposal: null, outcome };
          }
        }
        current.status = "DISPATCHED";
        current.attempts += 1;
        // One stage for the whole dispatch: the task's own, or the one its Goal
        // says it belongs at. The proposal carries it as `requiredStage` and
        // admission checks the same value, so they cannot disagree.
        const dispatchStage = legalStageFor(state, current, baseUtilityGoal);
        proposal = proposalFor(state, { ...current, legalStage: dispatchStage, attempts: current.attempts - 1 },
          options.utilityServiceRoadChildOperation);
        const decision = admitGate1Proposal(state, current, proposal, now(),
          options.concreteChildOperationAdmissionContext?.(observation), dispatchStage);
        if (decision.admission.decision === "REJECTED") {
          const error = decision.admission.reason;
          current.status = "BLOCKED";
          state.project.status = "BLOCKED";
          state.intent.status = "BLOCKED";
          const outcome = journal(current, proposal, {
            admission: "REJECTED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation?.observationId ?? null,
            observedEffect: "NOT_APPLICABLE",
            failureClassification: "ADMISSION_REJECTED",
            reason: error,
          });
          current.terminalOutcomeId = outcome.id;
          persist();
          return { state: clone(state), task: clone(current), proposal, outcome };
        }
        const admitted = decision as Gate1AdmittedProposal;
        if (proposal.kind === "WORLD_WRITE") {
          try {
            // A recovery goes to the boundary's own recovery resolver, not to
            // its generic execution port. Its presence is the declaration that
            // let this tranche enter RECOVERING, so dispatching it here is that
            // same declaration being honoured rather than a second opinion —
            // and a boundary that withdraws it mid-flight fails closed instead
            // of silently running a recovery through a port that has none.
            execution = proposal.operation === "RECOVER" && options.boundary.recover
              ? await options.boundary.recover(admitted, signal)
              : await options.boundary.execute(admitted, signal);
          } catch (error) {
            if (!isGate1BoundedPlanningDeadEnd(error)) throw error;
            // The bounded planner refused inside the tranche's OWN scope, before
            // any native command existed. Left to propagate, this ended the whole
            // progression as an exception: the durable state kept an ACTIVE
            // project at ROAD_DELIVERED with a PENDING ZONING task, so the Goal
            // never closed, its reservation was never released, and the Brain had
            // nothing to re-plan from — one reservation that cannot be zoned
            // stopped the city. It is a bounded terminal of this task instead:
            // nothing was submitted, nothing is in flight, and the durable record
            // of it is what the successor is derived from.
            current.status = "BLOCKED";
            current.activeCommandId = null;
            state.project.status = "BLOCKED";
            state.intent.status = "BLOCKED";
            outcome = journal(current, proposal, {
              admission: "ADMITTED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation?.observationId ?? null,
              observedEffect: "NOT_APPLICABLE",
              failureClassification: error instanceof Gate1BoundedRoadSiteDeadEndError
                ? "ROAD_SITE_TARGET_NOT_REPRODUCED" : "ZONING_RESERVATION_DEAD_END",
              reason: error.message,
            });
            current.terminalOutcomeId = outcome.id;
            persist();
            return { state: clone(state), task: clone(current), proposal, outcome };
          }
        }
      }
      if (execution.status === "WAITING") {
        current.status = "WAITING";
        current.activeCommandId = execution.commandId;
        if (execution.commandId === null && execution.reason === "WAITING_FOR_NATIVE_BUILD_SLOT") {
          current.attempts = Math.max(0, current.attempts - 1);
        }
        outcome = journal(current, proposal, {
          admission: "ADMITTED",
          execution: "WAITING",
          commandId: execution.commandId,
          observationId: observation?.observationId ?? null,
          observedEffect: "UNKNOWN",
          failureClassification: "NONE",
          reason: execution.reason,
        });
        persist();
        return { state: clone(state), task: clone(current), proposal, outcome };
      }
      const effectUncertain = proposal.actionFamily === "ZONING" && !execution.observedMatch;
      if (execution.status !== "DELIVERED" || effectUncertain) {
        const retryable =
          execution.status === "REJECTED" && !effectUncertain && current.attempts < current.maximumAttempts;
        current.status = retryable
          ? "PENDING"
          : execution.status === "UNKNOWN" || effectUncertain
            ? "BLOCKED"
            : "FAILED";
        current.activeCommandId = null;
        if (!retryable) {
          state.project.status = "BLOCKED";
          state.intent.status = "BLOCKED";
        }
        outcome = journal(current, proposal, {
          admission: "ADMITTED",
          execution: execution.status,
          commandId: execution.commandId,
          observationId: observation?.observationId ?? null,
          observedEffect: execution.status === "UNKNOWN" || effectUncertain ? "UNKNOWN" : "NOT_APPLICABLE",
          failureClassification:
            execution.status === "UNKNOWN" || effectUncertain ? "EXECUTION_UNKNOWN" : "EXECUTION_REJECTED",
          ...(execution.roadPreApplyFailure ? { roadPreApplyFailure: execution.roadPreApplyFailure } : {}),
          reason: effectUncertain ? "zoning delivery lacked exact observed effect" : execution.reason,
        });
        if (!retryable) current.terminalOutcomeId = outcome.id;
        persist();
        return { state: clone(state), task: clone(current), proposal, outcome };
      }

      const complete = (nextStage: Gate1Stage, delivery: boolean) => {
        current.status = "SUCCEEDED";
        current.activeCommandId = null;
        state.tranche.stage = nextStage;
        outcome = journal(current, proposal, {
          admission: proposal.kind === "WORLD_WRITE" ? "ADMITTED" : "NOT_REQUIRED",
          execution: proposal.kind === "WORLD_WRITE" ? "DELIVERED" : "NOT_REQUIRED",
          commandId: execution.commandId,
          observationId: observation?.observationId ?? null,
          observedEffect: "NOT_APPLICABLE",
          failureClassification: "NONE",
          reason: execution.reason,
        });
        current.terminalOutcomeId = outcome.id;
        if (delivery) updateDelivery(state, outcome.id);
      };

      if (current.kind === "SITE_SELECTION") complete("SITE_SELECTED", true);
      else if (current.kind === "ROAD_CONNECTION") {
        const children = current.childOperationAmendmentIds;
        if (!children?.length) {
          // Legacy single-course Road tasks retain their existing completion contract.
          complete("ROAD_DELIVERED", true);
        } else {
          if (current.utilityRoadParentTaskId) {
            const index = children.indexOf(current.childOperationAmendmentId ?? children[0]);
            const nextChildId = index >= 0 ? children[index + 1] : undefined;
            if (nextChildId) {
              outcome = journal(current, proposal, {
                admission: "ADMITTED", execution: "DELIVERED", commandId: execution.commandId,
                observationId: observation?.observationId ?? null, observedEffect: "NOT_APPLICABLE",
                failureClassification: "NONE", reason: "UTILITY_SERVICE_ROAD_SEGMENT_DELIVERED",
              });
              current.activeCommandId = null;
              current.childOperationAmendmentId = nextChildId;
              current.attempts = 0;
              current.status = "PENDING";
              persist();
              return { state: clone(state), task: clone(current), proposal, outcome: clone(outcome) };
            }
            complete("ROAD_DELIVERED", true);
          } else {
          let connected: boolean;
          try {
            if (!options.boundary.roadAccessConnected) throw new Error("ROAD_ACCESS_READBACK_UNAVAILABLE");
            connected = await options.boundary.roadAccessConnected(proposal, signal);
          } catch (error) {
            // The Road may already exist. Keep its command bound for reconciliation;
            // an unknown access read cannot authorize the next segment.
            current.status = execution.commandId ? "WAITING" : "BLOCKED";
            current.activeCommandId = execution.commandId;
            if (!execution.commandId) {
              state.project.status = "BLOCKED";
              state.intent.status = "BLOCKED";
            }
            outcome = journal(current, proposal, {
              admission: "ADMITTED", execution: "WAITING", commandId: execution.commandId,
              observationId: observation?.observationId ?? null, observedEffect: "UNKNOWN",
              failureClassification: "NONE",
              reason: `ROAD_ACCESS_READBACK_UNKNOWN:${error instanceof Error ? error.message : String(error)}`,
            });
            if (!execution.commandId) current.terminalOutcomeId = outcome.id;
            persist();
            return { state: clone(state), task: clone(current), proposal, outcome: clone(outcome) };
          }
          if (connected === true) {
            complete("ROAD_DELIVERED", true);
          } else {
            const index = children.indexOf(current.childOperationAmendmentId ?? children[0]);
            const nextChildId = index >= 0 ? children[index + 1] : undefined;
            outcome = journal(current, proposal, {
              admission: "ADMITTED", execution: "DELIVERED", commandId: execution.commandId,
              observationId: observation?.observationId ?? null, observedEffect: "NOT_APPLICABLE",
              failureClassification: "NONE",
              reason: nextChildId ? "ROAD_SEGMENT_DELIVERED_ACCESS_PENDING" : "ROAD_ROUTE_EXHAUSTED_ACCESS_MISSING",
            });
            current.activeCommandId = null;
            if (nextChildId) {
              current.childOperationAmendmentId = nextChildId;
              current.attempts = 0;
              current.status = "PENDING";
            } else {
              current.status = "BLOCKED";
              current.terminalOutcomeId = outcome.id;
              state.project.status = "BLOCKED";
              state.intent.status = "BLOCKED";
            }
          }
          }
        }
      }
      else if (current.kind === "ZONING") {
        complete("ZONED_WAITING_FOR_BUILDING", true);
        state.tranche.effect_progress.status = "WAITING";
      } else if (current.kind === "WAIT_FOR_BUILDING") {
        if (
          !observation ||
          observation.trancheId !== state.tranche.id ||
          observation.coherence === "UNKNOWN" ||
          observation.residentialBuildings.value === null
        ) {
          current.status = "BLOCKED";
          state.project.status = "BLOCKED";
          state.intent.status = "BLOCKED";
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation?.observationId ?? null,
            observedEffect: "UNKNOWN",
            failureClassification: "OBSERVATION_UNKNOWN",
            reason: "tranche-attributed residential building observation is unknown; fail closed",
          });
          current.terminalOutcomeId = outcome.id;
        } else if (observation.residentialBuildings.value.length > 0) {
          current.status = "SUCCEEDED";
          state.tranche.stage = "BUILDING_OBSERVED";
          state.tranche.effect_progress.attributedResidentialBuildings = clone(observation.residentialBuildings.value);
          state.tranche.effect_progress.lastObservationId = observation.observationId;
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation.observationId,
            observedEffect: "NOT_APPLICABLE",
            failureClassification: "NONE",
            reason: "tranche-attributed residential building observed; actual consumer service must now be certified",
          });
          current.terminalOutcomeId = outcome.id;
        } else {
          state.tranche.effect_progress.boundedWaitsCompleted += 1;
          const exhausted = current.attempts >= current.maximumAttempts;
          current.status = exhausted ? "SUCCEEDED" : "PENDING";
          if (exhausted) {
            state.tranche.stage = "DIAGNOSING";
            state.tranche.effect_progress.status = "DIAGNOSING";
            appendTask(state, task(state.tranche.id, "OCCUPANCY_DIAGNOSIS", "DIAGNOSING"));
          }
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation.observationId,
            observedEffect: "NO_OCCUPANCY",
            failureClassification: exhausted ? "BOUNDED_WAIT_EXHAUSTED" : "NONE",
            reason: exhausted
              ? "bounded building-generation wait exhausted"
              : "no attributed building yet; bounded wait remains",
          });
          if (exhausted) current.terminalOutcomeId = outcome.id;
        }
      } else if (current.kind === "UTILITY_PROVISION") {
        // A base utility Goal's own deliverable is the utility. Only such a Goal
        // is answered by the utility's own delivery; a growth Goal keeps the
        // consumer-service contract it has always had, because what it waits for
        // is absorption, not supply.
        if (baseUtilityGoal && gate1UtilityDelivered(state)) {
          // The task certifies a DELIVERED utility, and this tranche's own
          // durable execution says one is delivered. That is the authoritative
          // fact, and it completes the task on the utility's terms.
          //
          // It used to complete only on consumer service observed in residential
          // buildings, which made a base utility Goal depend on residential
          // GROWTH: on a city that has not built there yet no read can ever
          // become authoritative, so the utility could be fully delivered and
          // the Goal still could not end. Occupancy is not dropped — an
          // `OCCUPIED` milestone still waits for it through `WAIT_OBSERVE`, and
          // an unabsorbed tranche still reaches `OCCUPANCY_DIAGNOSIS`. It is
          // simply no longer this task's business.
          complete("WAITING_FOR_OCCUPANCY", true);
          state.tranche.effect_progress.status = "WAITING";
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation?.observationId ?? null,
            observedEffect: "UTILITY_DELIVERED",
            failureClassification: "NONE",
            reason: "UTILITY_PROVISION_DELIVERED: this tranche's durable utility execution certified the service",
          });
        } else if (observation?.waitingFor === "ROUTE_RESULT" || observation?.waitingFor === "CONSUMER_INITIALIZATION") {
          // This is an observation wait, not a construction attempt. Keep the
          // task executable and return a typed wake boundary to the runner.
          current.attempts = Math.max(0, current.attempts - 1);
          current.status = "WAITING";
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "WAITING",
            commandId: null,
            observationId: observation.observationId,
            observedEffect: "UNKNOWN",
            failureClassification: "NONE",
            reason: observation.waitingFor === "ROUTE_RESULT"
              ? "WAITING_FOR_ROUTE_RESULT: native route query is accepted/pending"
              : "WAITING_FOR_CONSUMER_INITIALIZATION: consumer demand evidence is not initialized",
          });
        } else {
          const readiness = gate1UtilityProvisionReadiness(state, observation);
          if (readiness.disposition === "TERMINAL") {
            // The observation belongs to another scope. Waiting cannot turn
            // another tranche's frame into this tranche's facts.
            current.status = "BLOCKED";
            state.project.status = "BLOCKED";
            state.intent.status = "BLOCKED";
            outcome = journal(current, proposal, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation?.observationId ?? null,
              observedEffect: "UNKNOWN",
              failureClassification: "OBSERVATION_UNKNOWN",
              reason: `UTILITY_PROVISION_OBSERVATION_MISATTRIBUTED:${readiness.fact}`,
            });
            current.terminalOutcomeId = outcome.id;
          } else if (readiness.disposition === "WAIT") {
            // Bounded wait, exactly like the neighbouring WAIT_FOR_BUILDING
            // branch. Every fact here becomes available on its own while the
            // city runs — a zoned lot is built on, consumers initialize,
            // service moves from UNKNOWN to SERVED — and a paused city never
            // produces them. The pass stays fail-closed: nothing completes the
            // task without an authoritative PASS, and an exhausted budget goes
            // to DIAGNOSING rather than to a success.
            state.tranche.effect_progress.boundedWaitsCompleted += 1;
            // A base utility Goal's wait is for its OWN utility, and that wait is
            // not this task failing. The facility is placed, connected and
            // certified by the production utility execution on the utility's own
            // schedule; a slowed city answers late, not never. Its bound is the
            // Brain's utility strategy ladder, which parks the Goal once every
            // strategy is spent — so this stays executable rather than
            // diagnosing an occupancy problem a utility Goal does not have, and
            // rather than moving the tranche off the one stage that still admits
            // the connection it is waiting for.
            const exhausted = !baseUtilityGoal && current.attempts >= current.maximumAttempts;
            current.status = exhausted ? "SUCCEEDED" : "PENDING";
            if (exhausted) {
              state.tranche.stage = "DIAGNOSING";
              state.tranche.effect_progress.status = "DIAGNOSING";
              appendTask(state, task(state.tranche.id, "OCCUPANCY_DIAGNOSIS", "DIAGNOSING"));
            }
            outcome = journal(current, proposal, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation?.observationId ?? null,
              observedEffect: "UNKNOWN",
              failureClassification: exhausted ? "BOUNDED_WAIT_EXHAUSTED" : "NONE",
              reason: exhausted
                ? `UTILITY_PROVISION_PENDING:${readiness.fact}:bounded consumer-service wait exhausted`
                : `UTILITY_PROVISION_PENDING:${readiness.fact}`,
            });
            if (exhausted) current.terminalOutcomeId = outcome.id;
          } else if (
            !gate1AccessCertified(readiness.observation) ||
            readiness.observation.productiveFrontage.value !== "PASS" ||
            readiness.observation.utilities.value !== "PASS"
          ) {
            current.status = "FAILED";
            state.tranche.stage = "DIAGNOSING";
            outcome = journal(current, proposal, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: readiness.observation.observationId,
              observedEffect: "NOT_APPLICABLE",
              failureClassification: "EXECUTION_REJECTED",
              reason: "delivery certification observed failed access, frontage, or utilities",
            });
            current.terminalOutcomeId = outcome.id;
            appendTask(state, task(state.tranche.id, "OCCUPANCY_DIAGNOSIS", "DIAGNOSING"));
          } else {
            state.tranche.effect_progress.attributedResidentialBuildings = clone(readiness.buildings);
            complete("WAITING_FOR_OCCUPANCY", true);
            state.tranche.effect_progress.status = "WAITING";
          }
        }
      } else if (current.kind === "WAIT_OBSERVE") {
        if (!isKnownObservation(observation, state.tranche.id)) {
          state.tranche.effect_progress.boundedWaitsCompleted += 1;
          const exhausted = state.tranche.effect_progress.boundedWaitsCompleted >= current.maximumAttempts;
          current.status = exhausted ? "SUCCEEDED" : "WAITING";
          if (exhausted) {
            state.tranche.stage = "DIAGNOSING";
            state.tranche.effect_progress.status = "DIAGNOSING";
            appendTask(state, task(state.tranche.id, "OCCUPANCY_DIAGNOSIS", "DIAGNOSING"));
          }
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "WAITING",
            commandId: null,
            observationId: observation?.observationId ?? null,
            observedEffect: "UNKNOWN",
            failureClassification: exhausted ? "BOUNDED_WAIT_EXHAUSTED" : "NONE",
            reason: exhausted
              ? "bounded occupancy observation wait exhausted without authoritative resident evidence"
              : "WAITING_FOR_OCCUPANCY: resident evidence is unavailable or incoherent",
          });
          if (exhausted) current.terminalOutcomeId = outcome.id;
        } else {
          state.tranche.effect_progress.lastObservationId = observation.observationId;
          state.tranche.effect_progress.actualResidents = observation.actualResidents.value;
          state.tranche.effect_progress.occupiedResidentialBuildings = clone(
            observation.occupiedResidentialBuildings.value,
          );
          const attributed = new Set(
            state.tranche.effect_progress.attributedResidentialBuildings.map(
              (building) => `${building.index}:${building.version}`,
            ),
          );
          const occupiedAreAttributed = observation.occupiedResidentialBuildings.value.every((building) =>
            attributed.has(`${building.index}:${building.version}`),
          );
          if (
            observation.actualResidents.value > 0 &&
            observation.occupiedResidentialBuildings.value.length > 0 &&
            occupiedAreAttributed
          ) {
            current.status = "SUCCEEDED";
            state.tranche.stage = "OCCUPIED";
            state.tranche.effect_progress.status = "OCCUPIED";
            state.project.status = "OCCUPIED";
            state.intent.status = "SATISFIED";
            outcome = journal(current, proposal, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation.observationId,
              observedEffect: "OCCUPIED",
              failureClassification: "NONE",
              reason: "actual tranche residents observed",
            });
            current.terminalOutcomeId = outcome.id;
          } else {
            state.tranche.effect_progress.boundedWaitsCompleted += 1;
            const exhausted = current.attempts >= current.maximumAttempts;
            current.status = exhausted ? "SUCCEEDED" : "PENDING";
            if (exhausted) {
              state.tranche.stage = "DIAGNOSING";
              state.tranche.effect_progress.status = "DIAGNOSING";
              appendTask(state, task(state.tranche.id, "OCCUPANCY_DIAGNOSIS", "DIAGNOSING"));
            }
            outcome = journal(current, proposal, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation.observationId,
              observedEffect: "NO_OCCUPANCY",
              failureClassification: exhausted ? "BOUNDED_WAIT_EXHAUSTED" : "NONE",
              reason: exhausted ? "bounded occupancy wait exhausted" : "no occupancy yet; bounded wait remains",
            });
            if (exhausted) current.terminalOutcomeId = outcome.id;
          }
        }
      } else if (current.kind === "OCCUPANCY_DIAGNOSIS") {
        const currentScopeBuildings = new Set(
          (observation?.residentialBuildings.value ?? []).map((building) => `${building.index}:${building.version}`),
        );
        const diagnosisHasObservedOccupancy = isKnownObservation(observation, state.tranche.id) &&
          observation.actualResidents.value > 0 &&
          observation.occupiedResidentialBuildings.value.length > 0 &&
          observation.occupiedResidentialBuildings.value.every((building) =>
            currentScopeBuildings.has(`${building.index}:${building.version}`),
          );
        // A diagnosable tranche is one whose own facts resolved. This is where
        // a fact-level UNKNOWN must still refuse, and it is the only place that
        // has to: `ZONING_OR_DEMAND_DELAY` says the land is fine and nobody
        // moved in, which is a claim about this tranche's buildings. Reading it
        // off an access or consumer-service read that came back UNKNOWN would
        // be passing UNKNOWN off as PASS.
        //
        // `gate1OccupiedConsumerEvidence` is the documented substitute for an
        // optional access endpoint: a current native renter read plus served
        // actual consumers proves the building is functioning without it. A
        // tranche with NO attributed buildings has nothing to serve, so both
        // values are legitimately UNKNOWN and the diagnosis stands.
        const scopeFactsResolved = ((): boolean => {
          if (!observation) return true;
          const buildings = observation.residentialBuildings.value;
          if (buildings === null || buildings.length === 0) return true;
          return (observation.access.value !== "UNKNOWN" || gate1OccupiedConsumerEvidence(observation)) &&
            observation.factCoherence?.utilities !== "UNKNOWN";
        })();
        const observedDiagnosis = observation && observation.trancheId === state.tranche.id &&
          observation.coherence !== "UNKNOWN" && scopeFactsResolved
          ? (observation.diagnosis && observation.diagnosis !== "UNKNOWN" ? observation.diagnosis : undefined) ?? (
            observation.access.value === "FAIL" ? "ACCESS_FAILURE" :
              observation.utilities.value === "FAIL" ? "UTILITY_FAILURE" :
                observation.residentialBuildings.value !== null &&
                observation.actualResidents.value !== null &&
                observation.occupiedResidentialBuildings.value !== null
                  ? "ZONING_OR_DEMAND_DELAY" : undefined
          )
          : undefined;
        if (diagnosisHasObservedOccupancy && observation) {
          // Diagnosis is a fresh observation boundary. If actual renters have
          // appeared since the bounded wait, the lifecycle has already
          // absorbed the tranche; an older NO_OCCUPANCY result must not win.
          current.status = "SUCCEEDED";
          state.tranche.stage = "OCCUPIED";
          state.tranche.effect_progress.status = "OCCUPIED";
          state.tranche.effect_progress.lastObservationId = observation.observationId;
          state.tranche.effect_progress.actualResidents = observation.actualResidents.value;
          state.tranche.effect_progress.attributedResidentialBuildings = clone(observation.residentialBuildings.value);
          state.tranche.effect_progress.occupiedResidentialBuildings = clone(observation.occupiedResidentialBuildings.value);
          state.project.status = "OCCUPIED";
          state.intent.status = "SATISFIED";
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation.observationId,
            observedEffect: "OCCUPIED",
            failureClassification: "NONE",
            reason: "actual tranche residents observed during diagnosis",
          });
          current.terminalOutcomeId = outcome.id;
        } else if (
          !observation ||
          observation.trancheId !== state.tranche.id ||
          observation.coherence === "UNKNOWN" ||
          !observedDiagnosis ||
          observedDiagnosis === "UNKNOWN"
        ) {
          // TELEMETRY, not a verdict.
          //
          // The tranche's deliverable is its delivered frontage and its rezoned
          // land; whether a building has appeared on that land, and whether a
          // resident has moved into it, is the simulation's own schedule and not
          // the Mayor's. An unreadable occupancy diagnosis is a fact worth
          // recording — and it is recorded, with the same classification it
          // always carried — but it must never be the reason a city stops
          // building. It used to close the Goal here, which made one optional
          // read the gate on every later expansion.
          //
          // The kernel's mutation fail-closed is untouched: nothing is written
          // on an unknown observation, and no command is authorized by this.
          current.status = "SUCCEEDED";
          state.tranche.effect_progress.lastObservationId = observation?.observationId ?? null;
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation?.observationId ?? null,
            observedEffect: "UNKNOWN",
            failureClassification: "OBSERVATION_UNKNOWN",
            reason: "occupancy diagnosis recorded as telemetry; it does not close the tranche",
          });
          current.terminalOutcomeId = outcome.id;
        } else if (options.boundary.recover && observedDiagnosis === "ACCESS_FAILURE") {
          // Only one diagnosis is a repair, and only a boundary that says it
          // can perform one is asked to. `Gate1WorldBoundary.recover` is that
          // declaration: without it, `RECOVERING` would hand the task to an
          // execution the boundary does not have, and the Goal would die on a
          // resolver gap rather than on its own facts.
          if (state.tranche.recoveryAttempts >= state.tranche.maximumRecoveryAttempts) {
            current.status = "FAILED";
            state.project.status = "BLOCKED";
            state.intent.status = "BLOCKED";
            outcome = journal(current, proposal, {
              admission: "NOT_REQUIRED",
              execution: "NOT_REQUIRED",
              commandId: null,
              observationId: observation.observationId,
              observedEffect: "NO_OCCUPANCY",
              failureClassification: "RECOVERY_EXHAUSTED",
              reason: "bounded recovery exhausted",
            });
            current.terminalOutcomeId = outcome.id;
          } else {
            complete("RECOVERING", false);
            appendTask(state, task(state.tranche.id, "RECOVERY", "RECOVERING"));
          }
        } else {
          // The observation itself is recorded, with the same classification it
          // always carried, and the tranche still closes — but on its own
          // deliverable, not on the city's absorption. A diagnosed
          // ZONING_OR_DEMAND_DELAY is exactly what the next expansion should
          // KNOW, not what should stop it.
          const terminal = occupancyDiagnosisTerminal(observedDiagnosis);
          current.status = "SUCCEEDED";
          outcome = journal(current, proposal, {
            admission: "NOT_REQUIRED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation.observationId,
            observedEffect: "NO_OCCUPANCY",
            failureClassification: terminal.classification,
            reason: `${terminal.reason} (recorded as telemetry; the tranche closes on its rezoned land)`,
          });
          current.terminalOutcomeId = outcome.id;
        }
      } else {
        state.tranche.recoveryAttempts += 1;
        const buildingObserved = state.tranche.effect_progress.attributedResidentialBuildings.length > 0;
        complete(buildingObserved ? "BUILDING_OBSERVED" : "ZONED_WAITING_FOR_BUILDING", false);
        state.tranche.effect_progress.status = "WAITING";
        state.tranche.effect_progress.boundedWaitsCompleted = 0;
        const nextTask = buildingObserved
          // The recovered pass keeps the budget the tranche was planned with, so
          // it is bounded exactly like the pass it replaces.
          ? task(state.tranche.id, "UTILITY_PROVISION", "BUILDING_OBSERVED",
              state.tasks.find((candidate) => candidate.kind === "UTILITY_PROVISION")?.maximumAttempts ?? 3)
          : task(state.tranche.id, "WAIT_FOR_BUILDING", "ZONED_WAITING_FOR_BUILDING", 2);
        nextTask.id = `${nextTask.id}:recovery:${state.tranche.recoveryAttempts}`;
        appendTask(state, nextTask);
      }
      persist();
      if (!outcome) throw new Error("Gate 1 task completed without an outcome journal entry");
      return { state: clone(state), task: clone(current), proposal, outcome: clone(outcome) };
    },
  };
}

const roadExecutionStatus = (status: V2CommandStatus): Gate1ExecutionOutcome["status"] => {
  if (status === "OBSERVED_MATCH") return "DELIVERED";
  if (status === "COMMIT_ACK" || status === "NATIVE_COMPLETED") return "WAITING";
  if (status === "UNKNOWN_TIMEOUT" || status === "UNKNOWN_TRANSPORT" || status === "NATIVE_COMPLETION_UNKNOWN") {
    return "UNKNOWN";
  }
  return "REJECTED";
};

export function createGate1FoundationBoundary(
  foundation: Pick<V2FoundationPorts, "road" | "zoning">,
  resolvers: Gate1FoundationProposalResolvers,
): Gate1WorldBoundary {
  const roadOutcome = (result: Awaited<ReturnType<V2FoundationPorts["road"]["execute"]>>): Gate1ExecutionOutcome => ({
    status: roadExecutionStatus(result.command.status),
    commandId: result.command.commandId,
    observedMatch: result.command.status === "OBSERVED_MATCH" && result.effectReport?.matcherResult === "MATCH",
    reason:
      result.command.failureOrUnknownReason ??
      result.effectReport?.reason ??
      result.command.nativeResultSummary ??
      result.command.status,
  });
  // The same resolver that would execute a `RECOVER` proposal is what the state
  // machine reads to decide whether it may enter `RECOVERING` at all. Declaring
  // it on the boundary keeps the two from disagreeing.
  const recovery = resolvers.recovery;
  return {
    ...(resolvers.preflightRoad ? { preflightRoad: resolvers.preflightRoad } : {}),
    ...(resolvers.roadAccessConnected ? { roadAccessConnected: resolvers.roadAccessConnected } : {}),
    ...(recovery ? { recover: recovery } : {}),
    async execute(proposal, signal) {
      if (proposal.admission?.decision !== "ADMITTED") {
        return { status: "REJECTED", commandId: null, observedMatch: false, reason: "Gate 1 Admission token missing" };
      }
      if (proposal.operation === "BUILD_ROAD") {
        let result;
        let roadResolverCompleted = false;
        try {
          const request = await resolvers.road(proposal, signal);
          roadResolverCompleted = true;
          if (proposal.concreteChildOperation) {
            if (!resolvers.consumeConcreteChildOperation) throw new Error("UTILITY_SERVICE_ROAD_CHILD_CONSUMER_UNAVAILABLE");
            resolvers.consumeConcreteChildOperation(
              proposal.concreteChildOperation.amendmentId,
              proposal.concreteChildOperation.courseFingerprint,
            );
          }
          result = await foundation.road.execute(request, signal);
        } catch (error) {
          if (isTransientNativeBuildBusy(error)) {
            return { status: "WAITING", commandId: null, observedMatch: false, reason: NATIVE_BUILD_SLOT_BUSY };
          }
          const classification = classifyNativeRoadPreviewFailure(error);
          const diagnostics = error instanceof RoadQuoteContractError ? error.diagnostics : null;
          let roadPreApplyFailure: Gate1RoadPreApplyFailureEvidence | undefined;
          if (!roadResolverCompleted && diagnostics && diagnostics.actual.previewOnly === true &&
            diagnostics.actual.valid === false && diagnostics.roadTaskId === proposal.taskId &&
            (diagnostics.roadChildId ?? null) === (proposal.concreteChildOperation?.amendmentId ?? null)) {
            try {
              const exactInput = JSON.parse(diagnostics.productionPreviewRequest.stableInput) as RoadGeometryInput;
              if (exactInput.prefab === diagnostics.productionPreviewRequest.prefab &&
                [exactInput.x1, exactInput.z1, exactInput.x2, exactInput.z2].every(Number.isFinite)) {
                roadPreApplyFailure = {
                  schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1",
                  phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
                  taskId: proposal.taskId,
                  childId: diagnostics.roadChildId,
                  exactInput,
                  firstFailedQuoteRequirement: diagnostics.firstFailedQuoteRequirement,
                  previewOnly: true,
                  applyCalled: false,
                };
              }
            } catch { /* An incomplete request identity is not durable safety evidence. */ }
          }
          return {
            status: classification,
            commandId: null,
            observedMatch: false,
            ...(roadPreApplyFailure ? { roadPreApplyFailure } : {}),
            reason: error instanceof RoadQuoteContractError
              ? `${error.message} [ROAD_QUOTE_DIAGNOSTICS=${JSON.stringify(error.diagnostics)}]`
              : error instanceof Error ? error.message : String(error),
          };
        }
        return roadOutcome(result);
      }
      if (proposal.operation === "ZONE_RESIDENTIAL") {
        const resolved = await resolvers.zoning(proposal, signal);
        const result = await foundation.zoning.execute(resolved.intent, resolved.baseline, signal);
        return {
          status:
            result.command.status === "UNKNOWN_TIMEOUT" ||
            result.command.status === "UNKNOWN_TRANSPORT" ||
            result.command.status === "COMMIT_ACK"
              ? "UNKNOWN"
              : result.command.status === "OBSERVED_MATCH"
                ? "DELIVERED"
                : "REJECTED",
          commandId: result.command.commandId,
          observedMatch: result.command.status === "OBSERVED_MATCH" && result.effectReport?.matcherResult === "MATCH",
          reason: result.command.failureOrUnknownReason ?? result.effectReport?.reason ?? result.command.status,
        };
      }
      // A `RECOVER` proposal never reaches this port. It is dispatched to
      // `boundary.recover`, whose presence is what let the tranche enter
      // `RECOVERING`; a proposal that arrives here anyway has no resolver.
      return {
        status: "REJECTED",
        commandId: null,
        observedMatch: false,
        reason: "no bounded Foundation resolver for proposal",
      };
    },
    async reconcile(commandId, signal, actionFamily) {
      if (actionFamily === "ZONING") {
        const result = await foundation.zoning.reconcile(commandId, signal);
        return {
          status:
            result.command.status === "UNKNOWN_TIMEOUT" ||
            result.command.status === "UNKNOWN_TRANSPORT" ||
            result.command.status === "COMMIT_ACK"
              ? "UNKNOWN"
              : result.command.status === "OBSERVED_MATCH"
                ? "DELIVERED"
                : "REJECTED",
          commandId: result.command.commandId,
          observedMatch: result.command.status === "OBSERVED_MATCH" && result.effectReport?.matcherResult === "MATCH",
          reason: result.command.failureOrUnknownReason ?? result.effectReport?.reason ?? result.command.status,
        };
      }
      return roadOutcome(await foundation.road.reconcile(commandId, signal));
    },
  };
}
