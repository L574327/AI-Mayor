import { createHash } from "node:crypto";
import { GROWABLE_LAND_USES, type GrowableLandUse } from "../growth-mode";
import type { UtilityRecoveryKind } from "../utility-recovery";
import type {
  CommandObservationEvidence,
  V2AuthorizedMutationScope,
  V2CommandDurableLineage,
  V2CommandJournal,
  V2CommandRecord,
  V2CommandStatus,
  V2RoadEffectProvenance,
} from "./foundation";
import { stableRoadInput } from "./finance";
import { roadPreApplyFailureEvidenceForTask, type Gate1State, V2_GATE1_STATE_SCHEMA_VERSION } from "./gate1";
import { roadCourseGeometry, type RoadGeometryInput } from "./road-kernel";
import {
  FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON,
  UTILITY_BUDGET_AMENDMENT_REASON,
  UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON,
  UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON,
} from "./utility-budget";

export const V2_DURABLE_STATE_SCHEMA_VERSION = "ai-mayor-v2-durability/1";
export const V2_CHECKPOINT_SCHEMA_VERSION = "ai-mayor-v2-checkpoint/1";
export const V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION = "ai-mayor-v2-project-placeholder/1";
export const V2_WORLD_OBSERVATION_SCHEMA_VERSION = "ai-mayor-v2-world-observation/1";
export const V2_SUPERSEDED_PROJECT_SCHEMA_VERSION = "ai-mayor-v2-superseded-project/1";
export const V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION = "ai-mayor-v2-utility-budget-amendment/1";
export const V2_ADMISSION_SEMANTIC_REPAIR_SCHEMA_VERSION = "ai-mayor-v2-admission-semantic-repair/1";

const MAX_DURABLE_COMMANDS = 256;
const MAX_DURABLE_CHECKPOINTS = 64;
const MAX_WORLD_OBSERVATIONS = 512;

/**
 * How many Goal work orders may hold a CLAIM at the same time.
 *
 * This is admission capacity, and it is deliberately not a bound on history.
 * The two used to be the same number, which made a Goal's terminal record 鈥? * finished, reconciled, evidence of a thing that really happened 鈥?keep
 * competing for the right to plan as if it were still live. A city that had
 * taken a few hundred bounded steps could then refuse every future admission
 * for no reason but its own past, which is the opposite of keeping history.
 *
 * Capacity is read through `goalWorkOrderReservationProtected`, so what counts
 * is exactly what still holds something: an active or reconciling work order, an
 * unsettled command, an unreached milestone, or an envelope that was never
 * released. A closed and released work order counts for nothing.
 */
const MAXIMUM_OPEN_GOAL_WORK_ORDERS = 256;

/**
 * How many Goal work orders the registry may hold at all.
 *
 * Not admission policy: a bound this large exists so a corrupt or adversarial
 * store cannot make the loader walk an unbounded array. Reaching it means the
 * branch has recorded tens of thousands of bounded Goal steps, which is a
 * durability problem to investigate rather than a reason to stop planning.
 */
const MAXIMUM_GOAL_WORK_ORDER_HISTORY = 65_536;

export type DurableCommandOutcome =
  | "SUBMITTED"
  | "NATIVE_COMPLETED"
  | "APPLIED"
  | "OBSERVED_MATCH"
  | "FAILED"
  | "UNKNOWN";
/**
 * How a newly observed world relates to the durable lineage this store holds.
 *
 * The split exists because two different questions used to be answered by one
 * value. "Which session is this" is answered by the runtime load identity
 * (`generation`, `worldEpochId`) and changes on every load. "Which save is
 * this" is answered by the persistent save identity (`loadAssetGuid` /
 * `checkpointId`) and does not. Only the second may carry lineage, so a reload
 * of the very same save, a descendant save of the same lineage, and a genuine
 * rollback are now distinct outcomes rather than one degraded bucket.
 */
export type WorldTransitionKind =
  | "FIRST_OBSERVATION"
  | "SAME_WORLD_RECONNECT"
  | "SAME_SAVE_RELOAD"
  | "DESCENDANT_SAVE_RELOAD"
  | "ROLLBACK"
  | "DIFFERENT_SAVE"
  | "DIFFERENT_WORLD"
  | "NEW_GAME";
export type V2DurableActivationStatus =
  | "EXECUTION_WORLD_VERIFICATION_REQUIRED"
  | "BASELINE_CHECKPOINT_REQUIRED"
  | "DESCENDANT_CONFIRMATION_REQUIRED"
  | "DESCENDANT_CHECKPOINT_REQUIRED"
  | "RELOAD_REQUIRED"
  | "ACTIVATED_IN_PLACE"
  | "ACTIVATED";

export type V2DurableProjectState =
  | { schemaVersion: typeof V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION; status: "PLACEHOLDER" }
  | Gate1State;

export interface NativeWorldIdentity {
  worldId: string;
  nativeSessionGuid: string;
  loadPurpose: "LoadGame" | "NewGame" | "LoadMap" | "NewMap" | string;
  loadAssetGuid: string | null;
  saveDataAssetGuid: string | null;
  mapAssetGuid: string | null;
  checkpointId: string | null;
  bridgeRuntimeEpoch: string;
  generation: string;
  generationSequence: number;
  generationOrigin: "LOAD_COMPLETED" | "ATTACHED_EXISTING_WORLD" | string;
  worldEpochId: string;
  worldReady: true;
  /** True only for an unambiguous legacy/uninitialized LoadGame save: no native
   *  checkpoint identity AND no save-data asset. Eligible for first-enable
   *  onboarding. A LoadGame with a save-data asset but no checkpoint is not
   *  eligible and remains fail-closed. */
  legacyOnboardingCandidate?: boolean;
}

export interface V2CheckpointRecord {
  schemaVersion: typeof V2_CHECKPOINT_SCHEMA_VERSION;
  checkpointId: string;
  worldId: string;
  worldEpochId: string;
  durable: boolean;
  journalPosition: number;
  v2StateVersion: number;
  saveMetadataAssetGuid: string | null;
  saveDataAssetGuid: string | null;
  /** Native session observed when this checkpoint was recorded. Persisted so a
   *  certified per-world baseline can be reconstructed after a world switch. */
  nativeSessionGuid: string | null;
  recordedAt: string;
  projectState: V2DurableProjectState;
  purpose?: "BASELINE" | "PERIODIC";
}

export interface V2BaselineActivationRecord {
  worldId: string;
  status: V2DurableActivationStatus;
  checkpointId: string | null;
  journalPosition: number;
  recordedAt: string;
}

export interface V2CertifiedRollbackAnchor {
  status: "CERTIFIED";
  checkpointId: string;
  worldId: string;
  nativeSessionGuid: string;
  sourceGeneration: string;
  sourceWorldEpochId: string;
  /** The journal cut the certified checkpoint contains. `0` for a fresh-world
   *  baseline; the inherited cut for a certified descendant save. */
  journalPosition: number;
  certifiedAt: string;
}

export interface V2CompletedProjectRecord {
  completionId: string;
  projectId: string;
  intentId: string;
  districtId: string;
  completedAt: string;
  terminalOutcomeId: string;
  releasedReservationRefs: string[];
  handoffStatus: "NEXT_DECISION_READY" | "CONSUMED";
  nextDecisionId: string | null;
  handedOffAt: string | null;
}

/**
 * A goal-scoped Gate1 work order. The active project slot remains the execution
 * adapter for legacy workflows; suspended states are retained here so a new
 * goal can receive its own reservation without discarding prior durable work.
 */
export interface V2GoalWorkOrderRecord {
  workOrderId: string;
  goalId: string;
  worldId: string;
  branchId: string;
  projectId: string;
  trancheId: string;
  reservationRef: string;
  status: "ACTIVE" | "SUSPENDED" | "COMPLETE" | "BLOCKED" | "RECONCILING";
  /** Progression returned BLOCKED but Gate1 terminality or command reconciliation was not proven. */
  reconciliationReason?: string | null;
  /** Parent Goal whose missing prerequisite this bounded work order advances. */
  parentGoalId?: string | null;
  /** Canonical land use supplied by the parent Goal when it has not yet admitted its own project. */
  parentLandUse?: GrowableLandUse | null;
  /** Authoritative world point that the prerequisite should move toward. */
  targetPoint?: { x: number; z: number } | null;
  /**
   * The Road course a mature planner compiled for this prerequisite, when it
   * produced one.
   *
   * `targetPoint` is where the step must END; this is the whole segment the
   * planner chose, starting where the corridor starts. Downstream may verify it
   * against the world — bind its start to the nearest authoritative road node,
   * refuse it if the ground moved — but it must not re-derive route, heading or
   * segment geometry, because there is no second planner that knows why this
   * route was chosen.
   */
  roadCourse?: { start: { x: number; z: number }; end: { x: number; z: number } } | null;
  /** Stop this work order at a durable Gate1 milestone before resuming its parent. */
  completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED" | null;
  /**
   * When this store synthesized this record to hold a project slot that a
   * different Goal displaced, and then released the slot's planning envelope.
   *
   * A synthesized slot is not a Goal the Brain can name: its id is minted here,
   * not requested by any planning path. Releasing its envelope is therefore the
   * difference between "the city may be planned again where the abandoned
   * starter stood" and "one abandoned scope vetoes every later project in that
   * region forever". It stays durable history and it is not resumable: a
   * successor must pass the ordinary admission and receive its own scope.
   */
  releasedReservationAt?: string | null;
  state: Gate1State;
  updatedAt: string;
}

/**
 * True when this work order's planning envelope has been given up.
 *
 * The `legacy:` prefix is how a record this store synthesized to hold a
 * displaced project slot is recognized. Such a slot names a Goal no planning
 * path can request 鈥?its id is minted in this store 鈥?so it can never be
 * resumed and must not keep competing for the land it once reserved. The prefix
 * also covers records written before `releasedReservationAt` existed, which is
 * why it is checked alongside the field rather than replaced by it.
 */
export function goalWorkOrderReservationReleased(
  record: Pick<V2GoalWorkOrderRecord, "goalId" | "releasedReservationAt">,
): boolean {
  return !!record.releasedReservationAt || record.goalId.startsWith("legacy:");
}

/**
 * True when a Goal work order can no longer take a step of its own.
 *
 * Read by every caller that has to tell "this Goal still owns the Brain" from
 * "this Goal is finished and the city must be asked what it needs next" 鈥?the
 * runtime's Goal scheduling and the admission's successor resolution. Both must
 * agree, because a Goal read as live by one and closed by the other is a Goal
 * the Brain can never leave: the scheduler would keep deferring to it while the
 * admission kept refusing to resume it.
 *
 * `RECONCILING` is deliberately NOT closed. An unsettled native outcome is not
 * an end, and only the existing reconciliation path may decide that it was; the
 * admission refuses such a record outright rather than admitting a successor
 * beside it.
 */
export function goalWorkOrderChainClosed(
  record: Pick<V2GoalWorkOrderRecord, "status" | "goalId" | "releasedReservationAt">,
): boolean {
  return record.status === "COMPLETE" || record.status === "BLOCKED" ||
    goalWorkOrderReservationReleased(record);
}

/**
 * Whether a work order's own journal proves that its Road target cannot be
 * delivered at all.
 *
 * A work order closes for two opposite reasons and {@link goalWorkOrderChainClosed}
 * deliberately does not separate them. A closure that reached the milestone is a
 * bounded plan that FINISHED — the next successor continues it, which is why the
 * walk exists. A Road target whose every bounded course was previewed against the
 * live game with no road produced is the opposite finding: the same Goal
 * re-derived from the same facts can only reproduce the same refusal, so minting
 * a successor spends a work order's worth of identity on a question the search
 * already answered.
 *
 * Measured live (2026-10-01): `PROVIDE_SERVICE:electricity:facts:f18115fceac9`
 * sat at `SITE_SELECTED` with `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` recorded on
 * its own journal while the successor walk minted eight successors of itself, each
 * refused identically, until `MAXIMUM_GOAL_SUCCESSOR_STEPS` ran out — eight work
 * orders and one command journal entry for the whole run.
 *
 * Two Road findings mean the same thing and only one of them used to count:
 * `ROAD_SITE_TARGET_NOT_REPRODUCED` is the root Goal's own Road step reporting
 * that the site it reserved no longer reproduces; `NO_FEASIBLE_GATE1_ROAD_CANDIDATE`
 * is every bounded course at that target having been previewed with no road
 * produced.
 *
 * Read from the record's OWN journal, so a refusal that happened on a
 * `:prerequisite:` child is not covered here — that child carries its own record
 * and is refused on its own turn.
 */
export function goalWorkOrderJournalProvesUnservableRoadTarget(
  record: { state?: { journal?: ReadonlyArray<{ failureClassification?: string | null; reason?: string | null }> } | null },
): boolean {
  return (record.state?.journal ?? []).some((entry) =>
    entry.failureClassification === "ROAD_SITE_TARGET_NOT_REPRODUCED" ||
    /SITE_TARGET_NOT_REPRODUCED|CANDIDATE_COUNT:0|NO_FEASIBLE_GATE1_ROAD_CANDIDATE/.test(entry.reason ?? ""));
}

/**
 * Whether a work order reached the Gate1 milestone it was admitted for.
 *
 * A prerequisite Road work order stops at `ROAD_DELIVERED`; a Goal's own work
 * order runs to `OCCUPIED`. This is the one place that reads the difference, so
 * "did this bounded step actually deliver?" has a single answer for the
 * registry, for admission's land claims, and for the step numbering that decides
 * whether a prerequisite is continuing or being retried.
 */
export function goalWorkOrderReachedMilestone(
  record: Pick<V2GoalWorkOrderRecord, "completionStage" | "state">,
): boolean {
  const milestone = record.completionStage ?? "OCCUPIED";
  return record.state.project.status === "COMPLETE" || record.state.tranche.stage === milestone;
}

/**
 * The milestones a Goal work order's `completionStage` may persist.
 *
 * ONE list, read by the loader that validates a durable record and by the
 * planner that decides what a Goal's deliverable is. The loader used to keep its
 * own hand-copied array, and a hand-copy has already bricked the store once:
 * `OFFICE` was missing from the land-use copy, so the first office prerequisite a
 * live Brain raised persisted a record its own loader then rejected and the whole
 * store refused to load (measured live 2026-10-01). A new milestone must not be
 * able to repeat that, so this list is the single source both readers share.
 */
export const GOAL_COMPLETION_STAGES = [
  "ROAD_DELIVERED",
  "ZONED_WAITING_FOR_BUILDING",
  "WAITING_FOR_OCCUPANCY",
  "OCCUPIED",
] as const;
export type GoalCompletionStage = (typeof GOAL_COMPLETION_STAGES)[number];

/** Why a durable project's admission was later found not to hold. */
export type V2ProjectSupersessionReason =
  /**
   * The site constraint admission used was unsound, so the site it picked cannot
   * serve the project's own domain. The project is real history 鈥?its ROAD was
   * delivered 鈥?but it can never reach the objective it was admitted for.
   */
  | "ADMISSION_INVALIDATED_BY_FIXED_SITE_CONSTRAINT"
  | "ADMISSION_INVALIDATED"
  /** A valid prior project is superseded only on one loaded checkpoint branch. */
  | "CURRENT_BRANCH_REPLAN";

export interface V2ProjectBranchIdentity {
  worldId: string;
  checkpointId: string;
  journalCut: number;
}

/**
 * A project whose admission was later invalidated, recorded as history.
 *
 * The superseded project is NOT rewritten, deleted or repaired: its identity,
 * its reservation and its delivered world effects are what actually happened, and
 * the durable journal and checkpoints that hold them are left exactly as they
 * were. This record adds the one fact they cannot carry 鈥?that the admission
 * behind them was unsound 鈥?so a later reader can tell an unfinished project
 * apart from one that must not be continued.
 *
 * Deliberately distinct from `V2CompletedProjectRecord`, which asserts a project
 * reached its objective. A superseded project did not, and reading one as though
 * it had would be the exact falsification this record exists to prevent.
 *
 * One supersession admits exactly one replacement. `replacementProjectId` is the
 * whole of that budget: once it is set, the supersession is spent, and a second
 * replacement would have to name a new supersession rather than reuse this one.
 */
export interface V2SupersededProjectRecord {
  schemaVersion: typeof V2_SUPERSEDED_PROJECT_SCHEMA_VERSION;
  supersessionId: string;
  /** The superseded project's identity, verbatim. */
  projectId: string;
  intentId: string;
  trancheId: string;
  reservationRef: string;
  /**
   * The superseded project's durable state, kept verbatim.
   *
   * Copied rather than referenced because the durable project-state slot holds
   * one project and the replacement takes it. Without the copy the superseded
   * project would survive only as long as no replacement was admitted, which is
   * precisely when it does not matter.
   */
  supersededState: Gate1State;
  reason: V2ProjectSupersessionReason;
  /** Present only when a rollback branch receives one bounded project replan. */
  branch?: V2ProjectBranchIdentity;
  /** Deterministic identity of the single replan allowed on this branch. */
  replanId?: string;
  /** Free-text detail for the evidence record. */
  detail: string;
  /** The project admitted to replace it; null until that admission commits. */
  replacementProjectId: string | null;
  supersededAt: string;
}

/**
 * The one reason an admission-semantics repair is ever recorded.
 *
 * Distinct from a supersession on purpose, and the difference is not cosmetic: a
 * supersession says "this admission never held", and a repair says "this
 * admission held under the semantics that existed when it was made, and the
 * product has since changed what admission means". The first is a mistake being
 * recorded; the second is a rule changing under an already-correct decision.
 *
 * They also have different bounds. A supersession is capped at one replacement
 * and cannot touch a replacement at all. A repair is capped per
 * `(root project, semantics revision)` instead, so the lineage may be repaired
 * once per genuinely new semantics while remaining unable to re-mint identities
 * inside one semantics.
 */
export const ADMISSION_SEMANTIC_REPAIR_REASON = "ADMISSION_INVALIDATED_BY_FIXED_ADMISSION_SEMANTICS" as const;

export type V2AdmissionSemanticsRepairReason = typeof ADMISSION_SEMANTIC_REPAIR_REASON;

/**
 * A project admitted under an older admission semantics, superseded-by-rule
 * rather than by-mistake, and the one project admitted to take its place.
 *
 * Why this is a separate record from `V2SupersededProjectRecord`: capping the
 * ordinary supersession lineage at two projects is a real safety property 鈥?it
 * is what stops "supersede, replace, supersede the replacement, forever" from
 * becoming identity re-minting with extra steps 鈥?and it is deliberately left
 * exactly as it was. Widening that cap to two supersessions in order to unblock
 * one world would buy the outcome by weakening the rule, and the rule would then
 * be weak for every future world too.
 *
 * This record buys the same outcome without touching that rule, by bounding on a
 * different axis. `repairId` is derived from the ROOT project and the semantics
 * revision and from nothing else 鈥?no wall clock, no randomness, no ordinal 鈥?so
 * `(root, revision)` names at most one repair forever. A repair that fails
 * cannot be re-minted; a genuinely new semantics revision can repair the lineage
 * once more. There is no counter to increment and therefore no unbounded
 * re-admission to guard against.
 *
 * Append-only, like the supersession it sits beside. The project it replaces is
 * copied into `replacedState` verbatim and is not repaired, deleted or rewritten:
 * its identity, its reservation, its budget amendments, its ROAD, its journal
 * entries and its supersession history all stay exactly as they were.
 */
export interface V2AdmissionSemanticRepairRecord {
  schemaVersion: typeof V2_ADMISSION_SEMANTIC_REPAIR_SCHEMA_VERSION;
  /** Deterministic: `(root project, semantics revision)`. The whole bound. */
  repairId: string;
  /**
   * The root of the admission lineage this repair descends from.
   *
   * The root rather than the currently durable project, because the durable slot
   * changes hands: keying on whatever is durable now would mint a new identity
   * every time the lineage moved, which is the re-minting this record forbids.
   */
  rootProjectId: string;
  rootIntentId: string;
  rootTrancheId: string;
  rootReservationRef: string;
  /** The durable project this repair actually replaced, verbatim. */
  replacedProjectId: string;
  replacedIntentId: string;
  replacedTrancheId: string;
  replacedReservationRef: string;
  /**
   * The supersession records the replaced project descends from, in order.
   *
   * Copied so the repair stands alone as a description of the lineage it
   * continues; the supersession records themselves are untouched.
   */
  supersessionIds: string[];
  /** The admission semantics revision the repair is keyed by. */
  semanticsRevision: string;
  reason: V2AdmissionSemanticsRepairReason;
  /** Free-text detail for the evidence record. */
  detail: string;
  /**
   * The replaced project's durable state, kept verbatim.
   *
   * Copied rather than referenced because the durable project-state slot holds
   * one project and the repair takes it 鈥?the same reason `supersededState` is
   * copied, and for the same window.
   */
  replacedState: Gate1State;
  /** The repair project admitted; null until that admission commits. */
  repairProjectId: string | null;
  repairedAt: string;
}

/**
 * One append-only widening of what an already-admitted project may spend.
 *
 * The admitted budget is part of the admission record, and admission records are
 * immutable 鈥?a project's history is what later proofs rest on, and editing a
 * number in it would invalidate them silently. So when a project turns out to
 * have been admitted under a budget smaller than the utility plan its own
 * reservation justifies, the correction is appended here rather than written
 * back over the admission.
 *
 * The record is deliberately thin. It carries the project's identity verbatim
 * and exactly three numbers: what the project was admitted with, what its plan
 * needs, and the resulting effective budget. It has no reservation, no facility
 * count and no scope of its own, so there is nothing in it that could widen the
 * project beyond the spend. One record per project, ever.
 */
export interface V2UtilityBudgetAmendmentRecord {
  schemaVersion: typeof V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION;
  amendmentId: string;
  /** The amended project's identity, verbatim. */
  projectId: string;
  intentId: string;
  trancheId: string;
  reservationRef: string;
  /** The budget the admission record holds. Copied, never overwritten. */
  originalProjectBudget: number;
  /** The minimum feasible spend the current utility plan declares. */
  requiredUtilityBudget: number;
  /** What utility execution for this project is authorized to spend instead. */
  amendedEffectiveBudget: number;
  reason:
    | typeof UTILITY_BUDGET_AMENDMENT_REASON
    | typeof UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
    | typeof FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON
    | typeof UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON;
  /**
   * Present only for a connection settlement, and required there.
   *
   * An admission prices the connection before the facility exists, so it prices
   * the only geometry it can prove: the plan's own `connection.start`, which is
   * the facility CENTRE. The course the execution actually submits starts at the
   * facility's connector 鈥?a prefab-determined point on its footprint 鈥?which is
   * a different geometry, and the native spending contract does not price the two
   * the same. These two figures are what the settlement was decided on, kept so
   * the delta it recorded is auditable rather than arithmetic nobody can check.
   */
  connectionAllowance?: number;
  actualConnectionQuote?: number;
  /** Free-text detail for the evidence record. */
  detail: string;
  amendedAt: string;
  /** Access-road authorization lifecycle; older records without it are ACTIVE. */
  status?: "ACTIVE" | "SUPERSEDED_UNUSED" | "CONSUMED";
  planRevision?: string;
  courseFingerprint?: string;
  /** Exact geometry for a pre-execution utility service-road child operation. */
  exactRoadInput?: RoadGeometryInput;
  supersedesAmendmentId?: string | null;
  /** Exact, preview-priced one-shot access-road execution binding. */
  nativeQuote?: number;
  segmentQuotes?: number[];
  roadPrefab?: string;
  purpose?: string;
  authorizationWorldId?: string;
  authorizationCheckpointId?: string | null;
  authorizationGeneration?: string;
  executionUseLimit?: 1;
  executionUseStatus?: "UNUSED" | "CONSUMED";
  repairLineage?: string;
  /**
   * The immutable repair attempt ordinal this authorization was minted for.
   *
   * It is what makes the amendment a bounded SEQUENCE rather than a single
   * attempt: the ordinal is fixed when the amendment is recorded, it is never
   * rewritten, and the next attempt is derived from the highest ordinal the
   * lineage already carries. Records minted before the ordinal existed as a
   * field of its own carry it inside repairLineage, which encodes the same
   * number.
   */
  repairAttemptIndex?: number;
  ownerTaskId?: string;
  replacementKey?: string;
  exactInputHash?: string;
  materialInputHash?: string;
}

export interface V2DurableCommandEntry {
  position: number;
  worldId: string;
  baseCheckpointId: string;
  worldEpochId: string;
  idempotencyKey: string;
  outcome: DurableCommandOutcome;
  record: V2CommandRecord;
}

/**
 * The admitted scope a first facility placement is bound to.
 *
 * Every field is durable and restart-stable: project/tranche/reservation come
 * from the admitted Gate 1 state, and `utilityKind` from the recipe. No
 * load-scoped field (generation, `worldEpochId`, `topologyRevision`) may appear
 * here 鈥?matching on one would lose the operation on the restart that follows a
 * crash, which is exactly the window this exists to close.
 */
export interface UtilityPlacementScope {
  projectId: string;
  trancheId: string;
  reservationRef: string;
  utilityKind: UtilityRecoveryKind;
  /** Missing is the historical objective-wide first-placement scope. */
  placementScopeId?: string;
}

const LEGACY_UTILITY_PLACEMENT_SCOPE_ID = "utility-placement:legacy";

/** A durable utility command that carried a facility placement action. */
export interface UtilityPlacementOperation {
  commandId: string;
  position: number;
  outcome: DurableCommandOutcome;
  status: V2CommandStatus;
  /** Durable proof that the previous native attempt provably left no facility. */
  effectAbsenceProven: boolean;
  /** Proven never submitted to native at all. */
  failedBeforeSubmit: boolean;
}

/**
 * What the loaded save proves about one journal-authorized world effect.
 *
 * `EFFECT_PRESENT` is the only verdict that can carry lineage across a save
 * boundary: it means the world this save was loaded into still contains the
 * exact permanent effect the command authorized. `UNPROVEN` never carries
 * authority 鈥?it fails the whole confirmation closed.
 */
export type V2WorldEffectVerdict = "EFFECT_PRESENT" | "EFFECT_ABSENT" | "UNPROVEN";

export interface V2DescendantWorldEffect {
  commandId: string;
  verdict: V2WorldEffectVerdict;
  /** Whether the command's *objective* holds in the loaded world, when the
   *  caller can observe it. `null` means "not observed", never "satisfied". */
  objectiveSatisfied: boolean | null;
  evidence: string;
}

/**
 * RETIRED (2026-10-02): `V2DescendantSaveConfirmation`,
 * `V2DescendantConfirmationRecord`, `V2ReconstructedCommandRecord` and
 * `V2ProjectAuthorityReconstruction` described authority rebuilt from the
 * inherited journal of an unregistered descendant save. That reconstruction was
 * the substance of the retired quarantine: it let a lineage this store had never
 * observed authorize work on land the loaded world had never shown. A Load now
 * re-baselines instead, so nothing produces or consumes these shapes and they
 * are deleted rather than kept as an unused vocabulary. A store written by an
 * older version may still carry the `projectAuthority` /
 * `descendantConfirmation` keys; `validateState` deliberately does not look at
 * them, so such a store loads with the keys ignored.
 */

/**
 * An append-only observation of what the *current* world contains for a command
 * whose execution-time verdict was recorded earlier.
 *
 * The historical verdict is copied verbatim and never rewritten: a command that
 * was proven to leave no effect when it was executed stays that way forever.
 * What can change is the world, so the observation is what records that the
 * physical effect exists now 鈥?without reinterpreting the old verdict as if the
 * cable had never been absent.
 */
export interface V2WorldObservationRecord {
  schemaVersion: typeof V2_WORLD_OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  commandId: string;
  worldId: string;
  worldEpochId: string;
  nativeSessionGuid: string;
  observedAt: string;
  historicalVerdict: { status: string; effectAbsenceProven: boolean };
  /** null means the current-world effect could not be proven either way. */
  currentWorldEffectPresent: boolean | null;
  currentWorldObjectiveSatisfied: boolean | null;
  evidence: string;
}

export interface V2DurableState {
  schemaVersion: typeof V2_DURABLE_STATE_SCHEMA_VERSION;
  v2StateVersion: 1;
  journalPosition: number;
  checkpoints: V2CheckpointRecord[];
  commands: V2DurableCommandEntry[];
  projectState: V2DurableProjectState;
  baselineActivation?: V2BaselineActivationRecord | null;
  certifiedRollbackAnchor?: V2CertifiedRollbackAnchor | null;
  completedProjects?: V2CompletedProjectRecord[];
  /** Goal-scoped successor work orders, separate from invalid-admission history. */
  goalWorkOrders?: V2GoalWorkOrderRecord[];
  activeGoalWorkOrderId?: string | null;
  /**
   * Projects whose admission was later invalidated. Append-only, and never a
   * substitute for the durable journal: the superseded project's world effects
   * stay in the journal exactly as delivered.
   */
  supersededProjects?: V2SupersededProjectRecord[];
  /**
   * Append-only budget corrections. At most one per project, and never a
   * substitute for the admission record: the admitted budget stays exactly as
   * it was written, and this is what later execution reads alongside it.
   */
  utilityBudgetAmendments?: V2UtilityBudgetAmendmentRecord[];
  /**
   * Append-only admission-semantics repairs. At most one per
   * `(root project, semantics revision)`, and never a substitute for the
   * supersession history it descends from: that history stays exactly as it was
   * recorded.
   */
  admissionSemanticRepairs?: V2AdmissionSemanticRepairRecord[];
  active: {
    worldId: string;
    loadedCheckpointId: string | null;
    rollbackBoundaryId: string;
    /** Journal cut last restored for this loaded world epoch. */
    activatedCheckpointJournalCut?: number;
    worldEpochId: string;
    bridgeRuntimeEpoch: string;
    generation: string;
  } | null;
  /** Append-only current-world observations. Never rewrites a command verdict. */
  worldObservations?: V2WorldObservationRecord[];
  continuation?: V2ContinuationProvenance | null;
  executionBranch?: {
    branchId: string;
    parentBranchId: string | null;
    sourceCheckpointId: string | null;
    sourceJournalCut: number;
    loadEventId: string | null;
    /** Historical forks remain unroutable until current-world verification commits. */
    executionReady?: boolean;
  } | null;
}

export interface V2ContinuationProvenance {
  continuationId: string;
  parentNamespaceId: string;
  parentCheckpointId: string;
  parentJournalPosition: number;
  sourceWorldId: string;
  sourceWorldEpochId: string;
  createdAt: string;
}

export interface V2DurableStateStorage {
  load(): unknown;
  save(state: V2DurableState): void;
  namespaceId?: string;
  forkHistoricalBranch?(input: {
    branchId: string;
    parentBranchId: string;
    checkpointId: string | null;
    journalCut: number;
    loadEventId: string;
    state: V2DurableState;
  }): void;
  resolveArchivedCheckpoint?(input: {
    worldId: string;
    checkpointId: string;
    saveMetadataAssetGuid: string | null;
    saveDataAssetGuid: string | null;
  }): unknown | null;
}

export interface SaveCompletionReceipt {
  status: "COMPLETED";
  durable: true;
  worldId: string;
  worldGeneration: string;
  checkpoint: {
    checkpointId: string;
    saveMetadataAssetGuid: string;
    saveDataAssetGuid: string;
    nativeSessionGuid: string;
  };
}

export type RestartReconciliationResult =
  | { result: "MATCH"; reason: string; evidence?: CommandObservationEvidence }
  | { result: "MISMATCH"; reason: string; effectAbsenceProven?: boolean; evidence?: CommandObservationEvidence }
  | { result: "INCONCLUSIVE"; reason: string; evidence?: CommandObservationEvidence };

const objectRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** A budget figure that survived a round trip. Anything else is corruption. */
const nonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A planned Road course that survived a round trip. A half-finite point is corruption. */
const isFiniteRoadCourse = (value: unknown): value is { start: { x: number; z: number }; end: { x: number; z: number } } => {
  const course = objectRecord(value);
  return [course.start, course.end].every((point) => {
    const candidate = objectRecord(point);
    return Number.isFinite(candidate.x) && Number.isFinite(candidate.z);
  });
};

function isValidUtilityServiceRoadInput(value: unknown): value is RoadGeometryInput {
  const input = objectRecord(value);
  return nonEmpty(input.prefab) &&
    [input.x1, input.z1, input.x2, input.z2].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)) &&
    [input.cx, input.cz, input.e1, input.e2].every((coordinate) => coordinate === undefined ||
      (typeof coordinate === "number" && Number.isFinite(coordinate))) &&
    input.networkJunctionInsert === undefined && input.startEndpoint === undefined && input.endEndpoint === undefined;
}

const emptyState = (): V2DurableState => ({
  schemaVersion: V2_DURABLE_STATE_SCHEMA_VERSION,
  v2StateVersion: 1,
  journalPosition: 0,
  checkpoints: [],
  commands: [],
  projectState: { schemaVersion: V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION, status: "PLACEHOLDER" },
  baselineActivation: null,
  certifiedRollbackAnchor: null,
  completedProjects: [],
  goalWorkOrders: [],
  activeGoalWorkOrderId: null,
  supersededProjects: [],
  utilityBudgetAmendments: [],
  admissionSemanticRepairs: [],
  active: null,
  continuation: null,
  executionBranch: null,
});

const clone = <T>(value: T): T => structuredClone(value);

function durableOutcome(record: V2CommandRecord): DurableCommandOutcome {
  if (record.statusHistory.some((item) => item.status === "OBSERVED_MISMATCH")) return "FAILED";
  if (record.status === "OBSERVED_MATCH") return "OBSERVED_MATCH";
  if (record.status === "NATIVE_COMPLETED") return "NATIVE_COMPLETED";
  if (record.status === "COMMIT_ACK" || record.status === "SUBMITTED") return "SUBMITTED";
  if (
    record.status === "NATIVE_COMPLETION_UNKNOWN" ||
    record.status === "UNKNOWN_TIMEOUT" ||
    record.status === "UNKNOWN_TRANSPORT"
  )
    return "UNKNOWN";
  if (
    record.status === "FAILED_BEFORE_SUBMIT" ||
    record.status === "REJECTED" ||
    record.status === "OBSERVED_MISMATCH"
  )
    return "FAILED";
  return "UNKNOWN";
}

function validateCheckpoint(value: unknown): V2CheckpointRecord {
  const item = objectRecord(value);
  const project = objectRecord(item.projectState);
  if (
    item.schemaVersion !== V2_CHECKPOINT_SCHEMA_VERSION ||
    !nonEmpty(item.checkpointId) ||
    !nonEmpty(item.worldId) ||
    !nonEmpty(item.worldEpochId) ||
    typeof item.durable !== "boolean" ||
    !Number.isInteger(item.journalPosition) ||
    Number(item.journalPosition) < 0 ||
    item.v2StateVersion !== 1 ||
    !nonEmpty(item.recordedAt) ||
    !validProjectState(project)
  )
    throw new Error("malformed V2 checkpoint");
  return {
    ...item,
    nativeSessionGuid: nonEmpty(item.nativeSessionGuid) ? item.nativeSessionGuid : null,
  } as unknown as V2CheckpointRecord;
}

function validProjectState(value: Record<string, unknown>): boolean {
  if (value.schemaVersion === V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION) return value.status === "PLACEHOLDER";
  if (value.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) return false;
  const intent = objectRecord(value.intent);
  const project = objectRecord(value.project);
  const district = objectRecord(value.district);
  const tranche = objectRecord(value.tranche);
  return (
    nonEmpty(intent.id) &&
    nonEmpty(project.id) &&
    project.intentId === intent.id &&
    nonEmpty(district.id) &&
    project.districtId === district.id &&
    nonEmpty(tranche.id) &&
    tranche.projectId === project.id &&
    tranche.districtId === district.id &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.journal)
  );
}

function validateWorldEffect(value: unknown): V2DescendantWorldEffect {
  const effect = objectRecord(value);
  if (
    !nonEmpty(effect.commandId) ||
    !["EFFECT_PRESENT", "EFFECT_ABSENT", "UNPROVEN"].includes(String(effect.verdict)) ||
    !(effect.objectiveSatisfied === null || typeof effect.objectiveSatisfied === "boolean") ||
    typeof effect.evidence !== "string"
  )
    throw new Error("malformed V2 descendant world effect");
  return effect as unknown as V2DescendantWorldEffect;
}

function validateWorldObservation(value: unknown): V2WorldObservationRecord {
  const observation = objectRecord(value);
  const historical = objectRecord(observation.historicalVerdict);
  if (
    observation.schemaVersion !== V2_WORLD_OBSERVATION_SCHEMA_VERSION ||
    !nonEmpty(observation.observationId) ||
    !nonEmpty(observation.commandId) ||
    !nonEmpty(observation.worldId) ||
    !nonEmpty(observation.worldEpochId) ||
    !nonEmpty(observation.nativeSessionGuid) ||
    !nonEmpty(observation.observedAt) ||
    !nonEmpty(historical.status) ||
    typeof historical.effectAbsenceProven !== "boolean" ||
    !(typeof observation.currentWorldEffectPresent === "boolean" || observation.currentWorldEffectPresent === null) ||
    !(observation.currentWorldObjectiveSatisfied === null || typeof observation.currentWorldObjectiveSatisfied === "boolean") ||
    typeof observation.evidence !== "string"
  )
    throw new Error("malformed V2 world observation");
  return observation as unknown as V2WorldObservationRecord;
}

function validateState(value: unknown): V2DurableState {
  if (value === undefined || value === null) return emptyState();
  const state = objectRecord(value);
  if (
    state.schemaVersion !== V2_DURABLE_STATE_SCHEMA_VERSION ||
    state.v2StateVersion !== 1 ||
    !Number.isInteger(state.journalPosition) ||
    Number(state.journalPosition) < 0 ||
    !Array.isArray(state.checkpoints) ||
    !Array.isArray(state.commands) ||
    state.checkpoints.length > MAX_DURABLE_CHECKPOINTS ||
    state.commands.length > MAX_DURABLE_COMMANDS
  )
    throw new Error("malformed V2 durable state");
  const checkpoints = state.checkpoints.map(validateCheckpoint);
  const projectState =
    state.projectState === undefined
      ? { schemaVersion: V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION, status: "PLACEHOLDER" as const }
      : objectRecord(state.projectState);
  if (!validProjectState(projectState)) throw new Error("malformed V2 durable project state");
  const commands = state.commands.map((value): V2DurableCommandEntry => {
    const entry = objectRecord(value);
    const record = objectRecord(entry.record);
    if (
      !Number.isInteger(entry.position) ||
      Number(entry.position) <= 0 ||
      !nonEmpty(entry.worldId) ||
      !nonEmpty(entry.baseCheckpointId) ||
      !nonEmpty(entry.worldEpochId) ||
      !nonEmpty(entry.idempotencyKey) ||
      !["SUBMITTED", "NATIVE_COMPLETED", "APPLIED", "OBSERVED_MATCH", "FAILED", "UNKNOWN"].includes(
        String(entry.outcome),
      ) ||
      !nonEmpty(record.commandId) ||
      !nonEmpty(record.status)
    )
      throw new Error("malformed V2 durable command entry");
    const typed = entry as unknown as V2DurableCommandEntry;
    // Before the ROAD execution-truth contract, a correlated Bridge ACK was
    // persisted as APPLIED/MATCH without authoritative topology evidence.
    // Reclassify only that exact poisoned representation for reconciliation.
    if (
      typed.outcome === "APPLIED" &&
      typed.record.actionFamily === "ROAD" &&
      typed.record.status === "COMMIT_ACK" &&
      typed.record.reconciliationStatus === "MATCH" &&
      typed.record.observationEvidence.length === 0
    ) {
      return {
        ...typed,
        outcome: "UNKNOWN",
        record: {
          ...typed.record,
          reconciliationStatus: "INCONCLUSIVE",
          failureOrUnknownReason: "legacy ROAD receipt ACK requires authoritative effect reconciliation",
        },
      };
    }
    const historicalMismatch = typed.record.statusHistory.find((item) => item.status === "OBSERVED_MISMATCH");
    if (historicalMismatch && (typed.record.status !== "OBSERVED_MISMATCH" || typed.outcome !== "FAILED" ||
      (historicalMismatch.reason !== undefined && typed.record.failureOrUnknownReason !== historicalMismatch.reason))) {
      return {
        ...typed,
        outcome: "FAILED",
        record: {
          ...typed.record,
          status: "OBSERVED_MISMATCH",
          reconciliationStatus: "MISMATCH",
          failureOrUnknownReason: historicalMismatch.reason ??
            "Historical OBSERVED_MISMATCH restored; later current-world observations cannot rewrite the execution-time verdict",
        },
      };
    }
    return typed;
  });
  if (commands.some((entry) => entry.position > Number(state.journalPosition))) {
    throw new Error("V2 durable command position exceeds journal position");
  }
  const activeValue = state.active === null ? null : objectRecord(state.active);
  const legacyCheckpointId = activeValue === null ? null : activeValue.checkpointId;
  const loadedCheckpointId =
    activeValue === null
      ? null
      : activeValue.loadedCheckpointId === undefined
        ? state.baselineActivation && objectRecord(state.baselineActivation).status === "RELOAD_REQUIRED"
          ? null
          : legacyCheckpointId
        : activeValue.loadedCheckpointId;
  const rollbackBoundaryId = activeValue === null ? null : (activeValue.rollbackBoundaryId ?? legacyCheckpointId);
  const activatedCheckpointJournalCut = activeValue?.activatedCheckpointJournalCut;
  if (
    activatedCheckpointJournalCut !== undefined &&
    (!Number.isInteger(activatedCheckpointJournalCut) || Number(activatedCheckpointJournalCut) < 0)
  ) {
    throw new Error("malformed V2 active checkpoint journal cut");
  }
  const active =
    activeValue === null
      ? null
      : {
          worldId: activeValue.worldId,
          loadedCheckpointId,
          rollbackBoundaryId,
          ...(activatedCheckpointJournalCut !== undefined
            ? { activatedCheckpointJournalCut: Number(activatedCheckpointJournalCut) }
            : {}),
          worldEpochId: activeValue.worldEpochId,
          bridgeRuntimeEpoch: activeValue.bridgeRuntimeEpoch,
          generation: activeValue.generation,
        };
  if (
    active !== null &&
    (!nonEmpty(active.worldId) ||
      !(active.loadedCheckpointId === null || nonEmpty(active.loadedCheckpointId)) ||
      !nonEmpty(active.rollbackBoundaryId) ||
      !nonEmpty(active.worldEpochId) ||
      !nonEmpty(active.bridgeRuntimeEpoch) ||
      !nonEmpty(active.generation))
  )
    throw new Error("malformed V2 active world binding");
  const baselineActivation =
    state.baselineActivation === undefined || state.baselineActivation === null
      ? null
      : objectRecord(state.baselineActivation);
  if (
    baselineActivation !== null &&
    (!nonEmpty(baselineActivation.worldId) ||
      !["BASELINE_CHECKPOINT_REQUIRED", "DESCENDANT_CONFIRMATION_REQUIRED", "DESCENDANT_CHECKPOINT_REQUIRED", "EXECUTION_WORLD_VERIFICATION_REQUIRED", "RELOAD_REQUIRED", "ACTIVATED_IN_PLACE", "ACTIVATED"].includes(
        String(baselineActivation.status),
      ) ||
      !(baselineActivation.checkpointId === null || nonEmpty(baselineActivation.checkpointId)) ||
      !Number.isInteger(baselineActivation.journalPosition) ||
      Number(baselineActivation.journalPosition) < 0 ||
      !nonEmpty(baselineActivation.recordedAt))
  )
    throw new Error("malformed V2 baseline activation state");
  const rollbackAnchor =
    state.certifiedRollbackAnchor === undefined || state.certifiedRollbackAnchor === null
      ? null
      : objectRecord(state.certifiedRollbackAnchor);
  if (
    rollbackAnchor !== null &&
    (rollbackAnchor.status !== "CERTIFIED" ||
      !nonEmpty(rollbackAnchor.checkpointId) ||
      !nonEmpty(rollbackAnchor.worldId) ||
      !nonEmpty(rollbackAnchor.nativeSessionGuid) ||
      !nonEmpty(rollbackAnchor.sourceGeneration) ||
      !nonEmpty(rollbackAnchor.sourceWorldEpochId) ||
      !Number.isInteger(rollbackAnchor.journalPosition) ||
      Number(rollbackAnchor.journalPosition) < 0 ||
      !nonEmpty(rollbackAnchor.certifiedAt))
  )
    throw new Error("malformed V2 certified rollback anchor");
  const completedProjects = Array.isArray(state.completedProjects)
    ? state.completedProjects.map((value) => {
        const item = objectRecord(value);
        if (
          !nonEmpty(item.completionId) ||
          !nonEmpty(item.projectId) ||
          !nonEmpty(item.intentId) ||
          !nonEmpty(item.districtId) ||
          !nonEmpty(item.completedAt) ||
          !nonEmpty(item.terminalOutcomeId) ||
          !Array.isArray(item.releasedReservationRefs) ||
          !item.releasedReservationRefs.every(nonEmpty) ||
          !["NEXT_DECISION_READY", "CONSUMED"].includes(String(item.handoffStatus)) ||
          !(item.nextDecisionId === null || nonEmpty(item.nextDecisionId)) ||
          !(item.handedOffAt === null || nonEmpty(item.handedOffAt))
        )
          throw new Error("malformed V2 completed project record");
        return item as unknown as V2CompletedProjectRecord;
      })
    : [];
  const goalWorkOrders = Array.isArray(state.goalWorkOrders)
    ? state.goalWorkOrders.map((value) => {
        const item = objectRecord(value);
        const workOrderState = objectRecord(item.state);
        if (!nonEmpty(item.workOrderId) || !nonEmpty(item.goalId) || !nonEmpty(item.worldId) ||
          !/^[a-f0-9]{40}$/.test(String(item.branchId ?? "")) || !nonEmpty(item.projectId) ||
          !nonEmpty(item.trancheId) || !nonEmpty(item.reservationRef) ||
          !["ACTIVE", "SUSPENDED", "COMPLETE", "BLOCKED", "RECONCILING"].includes(String(item.status)) ||
          !nonEmpty(item.updatedAt) || !validProjectState(workOrderState) ||
          objectRecord(workOrderState.project).id !== item.projectId ||
          objectRecord(workOrderState.tranche).id !== item.trancheId ||
          objectRecord(workOrderState.tranche).reservationRef !== item.reservationRef)
          throw new Error("malformed V2 goal work order");
        if ((item.parentGoalId !== undefined && item.parentGoalId !== null && !nonEmpty(item.parentGoalId)) ||
          // The product's own land-use list, not a hand-copy of it: `OFFICE` was
          // missing here, so the first office `ROAD_FRONTAGE` prerequisite the
          // Brain ever raised persisted a record its own loader then rejected as
          // malformed, and the whole store refused to load. Measured live
          // (2026-10-01) on `EXPAND_OFFICE:office:facts:3f3754d18562:prerequisite:
          // ROAD_FRONTAGE:1:4ceab3aac7d23838`.
          (item.parentLandUse !== undefined && item.parentLandUse !== null &&
            !GROWABLE_LAND_USES.includes(String(item.parentLandUse) as GrowableLandUse)) ||
          (item.targetPoint !== undefined && item.targetPoint !== null &&
            (!Number.isFinite(objectRecord(item.targetPoint).x) || !Number.isFinite(objectRecord(item.targetPoint).z))) ||
          (item.roadCourse !== undefined && item.roadCourse !== null && !isFiniteRoadCourse(item.roadCourse)) ||
          (item.completionStage !== undefined && item.completionStage !== null &&
            !GOAL_COMPLETION_STAGES.includes(String(item.completionStage) as GoalCompletionStage)) ||
          (item.reconciliationReason !== undefined && item.reconciliationReason !== null &&
            (typeof item.reconciliationReason !== "string" || item.reconciliationReason.length > 500)) ||
          (item.releasedReservationAt !== undefined && item.releasedReservationAt !== null &&
            !nonEmpty(item.releasedReservationAt)))
          throw new Error("malformed V2 goal prerequisite metadata");
        return item as unknown as V2GoalWorkOrderRecord;
      })
    : [];
  if (goalWorkOrders.length > MAXIMUM_GOAL_WORK_ORDER_HISTORY ||
    new Set(goalWorkOrders.map((item) => item.workOrderId)).size !== goalWorkOrders.length ||
    new Set(goalWorkOrders.map((item) => item.goalId)).size !== goalWorkOrders.length ||
    (state.activeGoalWorkOrderId !== undefined && state.activeGoalWorkOrderId !== null &&
      !goalWorkOrders.some((item) => item.workOrderId === state.activeGoalWorkOrderId &&
        (item.status === "ACTIVE" || item.status === "COMPLETE" || item.status === "BLOCKED" || item.status === "RECONCILING"))))
    throw new Error("malformed V2 goal work order registry");
  const supersededProjects = Array.isArray(state.supersededProjects)
    ? state.supersededProjects.map((value) => {
        const item = objectRecord(value);
        if (
          item.schemaVersion !== V2_SUPERSEDED_PROJECT_SCHEMA_VERSION ||
          !nonEmpty(item.supersessionId) ||
          !nonEmpty(item.projectId) ||
          !nonEmpty(item.intentId) ||
          !nonEmpty(item.trancheId) ||
          !nonEmpty(item.reservationRef) ||
          !(item.reason === "ADMISSION_INVALIDATED_BY_FIXED_SITE_CONSTRAINT" || item.reason === "ADMISSION_INVALIDATED" || item.reason === "CURRENT_BRANCH_REPLAN") ||
          (item.reason === "CURRENT_BRANCH_REPLAN" &&
            (!nonEmpty(objectRecord(item.branch).worldId) ||
              !nonEmpty(objectRecord(item.branch).checkpointId) ||
              !Number.isInteger(objectRecord(item.branch).journalCut) ||
              Number(objectRecord(item.branch).journalCut) < 0 ||
              !nonEmpty(item.replanId))) ||
          (item.reason !== "CURRENT_BRANCH_REPLAN" &&
            (item.branch !== undefined || item.replanId !== undefined)) ||
          !nonEmpty(item.reason) ||
          !nonEmpty(item.detail) ||
          !nonEmpty(item.supersededAt) ||
          !(item.replacementProjectId === null || nonEmpty(item.replacementProjectId)) ||
          !validProjectState(objectRecord(item.supersededState))
        )
          throw new Error("malformed V2 superseded project record");
        return item as unknown as V2SupersededProjectRecord;
      })
    : [];
  const utilityBudgetAmendments = Array.isArray(state.utilityBudgetAmendments)
    ? state.utilityBudgetAmendments.map((value) => {
        const item = objectRecord(value);
        if (
          item.schemaVersion !== V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION ||
          !nonEmpty(item.amendmentId) ||
          !nonEmpty(item.projectId) ||
          !nonEmpty(item.intentId) ||
          !nonEmpty(item.trancheId) ||
          !nonEmpty(item.reservationRef) ||
          !nonNegativeFinite(item.originalProjectBudget) ||
          !nonNegativeFinite(item.requiredUtilityBudget) ||
          !nonNegativeFinite(item.amendedEffectiveBudget) ||
          (item.reason !== UTILITY_BUDGET_AMENDMENT_REASON &&
            item.reason !== UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON &&
            item.reason !== FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON &&
            item.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON) ||
          // The two figures are the whole justification of a connection
          // settlement, so they are required for that reason and refused for the
          // other two, neither of which ever read a connection quote at all: the
          // plan-funding raise prices a plan, and the access-road repair prices a
          // road, and each carries its own justification instead.
          (item.reason === UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
            ? !nonNegativeFinite(item.connectionAllowance) || !nonNegativeFinite(item.actualConnectionQuote)
            : item.connectionAllowance !== undefined || item.actualConnectionQuote !== undefined) ||
          !(item.status === undefined || item.status === "ACTIVE" || item.status === "SUPERSEDED_UNUSED" || item.status === "CONSUMED") ||
          !(item.planRevision === undefined || nonEmpty(item.planRevision)) ||
          !(item.courseFingerprint === undefined || nonEmpty(item.courseFingerprint)) ||
          !(item.supersedesAmendmentId === undefined || item.supersedesAmendmentId === null || nonEmpty(item.supersedesAmendmentId)) ||
          !(item.nativeQuote === undefined || nonNegativeFinite(item.nativeQuote)) ||
          !(item.segmentQuotes === undefined || (Array.isArray(item.segmentQuotes) && item.segmentQuotes.length > 0 && item.segmentQuotes.every(nonNegativeFinite))) ||
          !(item.roadPrefab === undefined || nonEmpty(item.roadPrefab)) ||
          !(item.purpose === undefined || nonEmpty(item.purpose)) ||
          !(item.authorizationWorldId === undefined || nonEmpty(item.authorizationWorldId)) ||
          !(item.authorizationCheckpointId === undefined || item.authorizationCheckpointId === null || nonEmpty(item.authorizationCheckpointId)) ||
          !(item.authorizationGeneration === undefined || nonEmpty(item.authorizationGeneration)) ||
          !(item.executionUseLimit === undefined || item.executionUseLimit === 1) ||
          !(item.executionUseStatus === undefined || item.executionUseStatus === "UNUSED" || item.executionUseStatus === "CONSUMED") ||
          (item.reason === UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON &&
            (!nonEmpty(item.planRevision) || !nonEmpty(item.courseFingerprint) ||
              !nonEmpty(item.authorizationWorldId) || !nonEmpty(item.authorizationCheckpointId) ||
              !nonEmpty(item.authorizationGeneration) || item.executionUseLimit !== 1 ||
              (item.status !== "ACTIVE" && item.status !== "CONSUMED") ||
              (item.executionUseStatus !== "UNUSED" && item.executionUseStatus !== "CONSUMED") ||
              !item.exactRoadInput || typeof item.exactRoadInput !== "object" ||
              !isValidUtilityServiceRoadInput(item.exactRoadInput) ||
              stableRoadInput(item.exactRoadInput) !== item.courseFingerprint)) ||
          (item.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON && item.exactRoadInput !== undefined) ||
          !nonEmpty(item.detail) ||
          !nonEmpty(item.amendedAt)
        )
          throw new Error("malformed V2 utility budget amendment record");
        return item as unknown as V2UtilityBudgetAmendmentRecord;
      })
    : [];
  const admissionSemanticRepairs = Array.isArray(state.admissionSemanticRepairs)
    ? state.admissionSemanticRepairs.map((value) => {
        const item = objectRecord(value);
        if (
          item.schemaVersion !== V2_ADMISSION_SEMANTIC_REPAIR_SCHEMA_VERSION ||
          !nonEmpty(item.repairId) ||
          !nonEmpty(item.rootProjectId) ||
          !nonEmpty(item.rootIntentId) ||
          !nonEmpty(item.rootTrancheId) ||
          !nonEmpty(item.rootReservationRef) ||
          !nonEmpty(item.replacedProjectId) ||
          !nonEmpty(item.replacedIntentId) ||
          !nonEmpty(item.replacedTrancheId) ||
          !nonEmpty(item.replacedReservationRef) ||
          !Array.isArray(item.supersessionIds) ||
          !item.supersessionIds.every(nonEmpty) ||
          !nonEmpty(item.semanticsRevision) ||
          item.reason !== ADMISSION_SEMANTIC_REPAIR_REASON ||
          !nonEmpty(item.detail) ||
          !(item.repairProjectId === null || nonEmpty(item.repairProjectId)) ||
          !nonEmpty(item.repairedAt) ||
          !validProjectState(objectRecord(item.replacedState))
        )
          throw new Error("malformed V2 admission semantic repair record");
        return item as unknown as V2AdmissionSemanticRepairRecord;
      })
    : [];
  const worldObservations = Array.isArray(state.worldObservations)
    ? state.worldObservations.map(validateWorldObservation)
    : [];
  const executionBranch = state.executionBranch === undefined || state.executionBranch === null
    ? null
    : objectRecord(state.executionBranch);
  if (executionBranch !== null && (
    !/^[a-f0-9]{40}$/.test(String(executionBranch.branchId ?? "")) ||
    !(executionBranch.parentBranchId === null || /^[a-f0-9]{40}$/.test(String(executionBranch.parentBranchId))) ||
    !(executionBranch.sourceCheckpointId === null || nonEmpty(executionBranch.sourceCheckpointId)) ||
    !Number.isInteger(executionBranch.sourceJournalCut) || Number(executionBranch.sourceJournalCut) < 0 ||
    !(executionBranch.loadEventId === null || nonEmpty(executionBranch.loadEventId)) ||
    (executionBranch.executionReady !== undefined && typeof executionBranch.executionReady !== "boolean")
  )) throw new Error("malformed V2 execution branch provenance");
  return clone({
    ...state,
    checkpoints,
    commands,
    projectState: projectState as V2DurableProjectState,
    active: active as V2DurableState["active"],
    baselineActivation: baselineActivation as V2BaselineActivationRecord | null,
    certifiedRollbackAnchor: rollbackAnchor as unknown as V2CertifiedRollbackAnchor | null,
    worldObservations,
    completedProjects,
    goalWorkOrders,
    activeGoalWorkOrderId: state.activeGoalWorkOrderId ?? null,
    supersededProjects,
    utilityBudgetAmendments,
    admissionSemanticRepairs,
    executionBranch: executionBranch as V2DurableState["executionBranch"],
  } as V2DurableState);
}

export function parseNativeWorldIdentity(value: unknown): NativeWorldIdentity {
  const root = objectRecord(value);
  const world = objectRecord(root.world);
  if (
    root.gameMode !== "Game" ||
    root.isLoading !== false ||
    root.cityLoaded !== true ||
    world.identityStatus !== "AVAILABLE" ||
    world.worldReady !== true ||
    !nonEmpty(world.worldId) ||
    !nonEmpty(world.nativeSessionGuid) ||
    !nonEmpty(world.loadPurpose) ||
    !nonEmpty(world.bridgeRuntimeEpoch) ||
    !nonEmpty(world.generation) ||
    !Number.isInteger(world.generationSequence) ||
    !nonEmpty(world.generationOrigin)
  )
    throw new Error("native world identity is unavailable or world is not ready");
  if (!["LoadGame", "NewGame", "LoadMap", "NewMap"].includes(String(world.loadPurpose))) {
    throw new Error("native world load purpose is unknown; reconciliation is required");
  }
  const checkpointId = nonEmpty(world.checkpointId) ? world.checkpointId : null;
  const saveDataAssetGuid = nonEmpty(world.saveDataAssetGuid) ? world.saveDataAssetGuid : null;
  // A LoadGame save with no native checkpoint identity is only admissible for
  // first-enable onboarding when it is unambiguously uninitialized: no save-data
  // asset is bound either. A save-data asset without a checkpoint is corrupt or
  // ambiguous and stays fail-closed.
  const legacyOnboardingCandidate =
    world.loadPurpose === "LoadGame" && checkpointId === null && saveDataAssetGuid === null;
  if (world.loadPurpose === "LoadGame" && checkpointId === null && !legacyOnboardingCandidate) {
    throw new Error("loaded save lacks native checkpoint identity");
  }
  return {
    worldId: world.worldId,
    nativeSessionGuid: world.nativeSessionGuid,
    loadPurpose: world.loadPurpose,
    loadAssetGuid: nonEmpty(world.loadAssetGuid) ? world.loadAssetGuid : null,
    saveDataAssetGuid,
    mapAssetGuid: nonEmpty(world.mapAssetGuid) ? world.mapAssetGuid : null,
    checkpointId,
    bridgeRuntimeEpoch: world.bridgeRuntimeEpoch,
    generation: world.generation,
    generationSequence: Number(world.generationSequence),
    generationOrigin: world.generationOrigin,
    worldEpochId: `${world.worldId}:generation:${world.generation}`,
    worldReady: true,
    ...(legacyOnboardingCandidate ? { legacyOnboardingCandidate: true } : {}),
  };
}

export function commandIdempotencyKey(record: V2CommandRecord): string {
  const scope = record.authorizedScope;
  const owner = `${scope.owner.ownerType}:${scope.owner.ownerId}`;
  if (scope.actionFamily === "ROAD") return `${owner}:ROAD:${scope.worldGeneration ?? "legacy"}:${scope.exactInput}`;
  if (scope.actionFamily === "UTILITY") {
    return `${owner}:UTILITY:${scope.utilityKind}:${scope.placementScopeId ?? "utility-placement:legacy"}:${scope.worldEpochId}:${scope.topologyRevision}:${scope.executionMechanismRevision ?? "legacy-unregistered-localconnect-v1"}:${scope.exactInput}`;
  }
  const cells = scope.allowedCells
    .map((cell) => `${cell.block.index}:${cell.block.version}:${cell.cellIndex}`)
    .sort()
    .join(",");
  return `${owner}:${scope.actionFamily}:${record.actionType}:${cells}`;
}

function transientCheckpoint(world: NativeWorldIdentity): string {
  return `unsaved:${world.worldId}`;
}

/**
 * Whether a checkpoint this store registered describes the very save a world
 * was loaded from.
 *
 * `loadAssetGuid` is the save's metadata asset 鈥?the identity the game persists
 * across processes 鈥?and `checkpointId` is that same identity plus the
 * save-data asset, available only when the asset database resolves both. The
 * runtime load `generation` is deliberately absent: it is minted per load and
 * answers "which session is this", never "which save is this". Matching on it
 * made a plain reload of an identical save look like a different save.
 *
 * `loadAssetGuid` names a save only for a world loaded from one. A NewGame is
 * generated from a map, and the Bridge reports that map asset as `loadAssetGuid`
 * (and again as `mapAssetGuid`), so comparing it against a checkpoint's save
 * metadata asset can only ever fail. The first save this store makes for such a
 * world then looks like "a save it never registered", which is what made a
 * fresh world's own baseline unrecognizable.
 */
function saveIdentityMatches(checkpoint: V2CheckpointRecord, world: NativeWorldIdentity): boolean {
  if (world.checkpointId !== null && checkpoint.checkpointId === world.checkpointId) return true;
  if (world.loadPurpose !== "LoadGame") return false;
  return world.loadAssetGuid !== null && checkpoint.saveMetadataAssetGuid === world.loadAssetGuid;
}

/**
 * Whether a certified checkpoint proves the journaled work recorded against it
 * is gone from the world that was just loaded.
 *
 * A checkpoint this store produced from one of its own completed saves states
 * where the durable journal stood when that world was saved; a load-context
 * checkpoint only records where the journal stood when the save was first
 * observed. Neither is a content record for saves this store never observed, so
 * this proof is deliberately narrow: a command recorded against this very
 * boundary, not contained by it, and recorded in a different runtime epoch.
 * Later checkpoints belong to other saved states; they do not change what the
 * exact checkpoint loaded now contains.
 */
function boundaryDiscardsJournaledWork(
  state: V2DurableState,
  world: NativeWorldIdentity,
  boundary: V2CheckpointRecord | undefined,
): boolean {
  if (boundary?.durable !== true) return false;
  return state.commands.some(
    (entry) =>
      entry.worldId === world.worldId &&
      entry.outcome !== "FAILED" &&
      entry.baseCheckpointId === boundary.checkpointId &&
      entry.worldEpochId !== world.worldEpochId &&
      entry.position > boundary.journalPosition,
  );
}

function isPlaceholderProjectState(value: unknown): boolean {
  return objectRecord(value).schemaVersion === V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION;
}

/** A durable command whose recorded outcome is a terminal world success. */
function carriesTerminalSuccess(entry: V2DurableCommandEntry): boolean {
  return entry.outcome === "OBSERVED_MATCH" || entry.outcome === "NATIVE_COMPLETED" || entry.outcome === "APPLIED";
}

/** The exact input of a scope that carries one; zoning scopes carry cells. */
function scopeExactInput(scope: V2AuthorizedMutationScope): string {
  return "exactInput" in scope && typeof scope.exactInput === "string" ? scope.exactInput : "";
}

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * Whether a durable UTILITY command authorized a facility placement.
 *
 * The exact actions are the authority 鈥?not a recipe name and not a role
 * string 鈥?so renaming a recipe cannot silently reopen the duplicate-placement
 * window. An unreadable or non-array `exactInput` answers `true`: it cannot be
 * proven to be a non-placement, so the caller must fail closed rather than read
 * "no placement" out of a corrupt record.
 */
function carriesFacilityPlacement(exactInput: string): boolean {
  try {
    const parsed: unknown = JSON.parse(exactInput);
    if (!Array.isArray(parsed)) return true;
    return parsed.some((action) => objectRecord(action).type === "place_building");
  } catch {
    return true;
  }
}

/**
 * Whether a durable UTILITY command authorized a connection course. The mirror
 * of `carriesFacilityPlacement`, and deliberately conservative the same way: an
 * unreadable action list answers `false` here, because this predicate only ever
 * *narrows* which commands may be treated as a proven connection course, and
 * wrongly claiming a course was not submitted leaves the ordinary native
 * validation in place.
 */
function carriesNetworkConnection(exactInput: string): boolean {
  try {
    const parsed: unknown = JSON.parse(exactInput);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.some((action) => objectRecord(action).type === "build_road");
  } catch {
    return false;
  }
}

export class V2DurabilityCoordinator {
  readonly commandJournal: V2CommandJournal;
  #state: V2DurableState;
  #loadError: Error | null = null;
  #current: NativeWorldIdentity | null = null;
  #blockedReason: string | null = null;

  constructor(
    private readonly storage: V2DurableStateStorage,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      this.#state = validateState(storage.load());
    } catch (error) {
      this.#state = emptyState();
      this.#loadError = error instanceof Error ? error : new Error(String(error));
    }
    this.commandJournal = {
      create: (record) => this.#createCommand(record),
      get: (commandId) => clone(this.#state.commands.find((entry) => entry.record.commandId === commandId)?.record),
      update: (commandId, update) => this.#updateCommand(commandId, update),
      list: () => this.#state.commands.map((entry) => clone(entry.record)),
      durableLineage: (commandId) => this.#durableLineage(commandId),
    };
  }

  /**
   * Whether the active durable world/checkpoint lineage still contains this
   * command, and how that was proven. `null` means it could not be proven.
   *
   * Three conditions, all from existing durable state 鈥?no second checkpoint
   * graph, no new identity system:
   *
   * 1. **Ancestry.** The active rollback boundary is either the very checkpoint
   *    the command was recorded against, or a checkpoint this coordinator
   *    produced as a `PERIODIC` save of this world (`recordCheckpoint`) whose
   *    journal position already included the command. A `PERIODIC` record is a
   *    certified save of this lineage, which is the same ancestry the
   *    continuation cut relies on (`checkpoint.journalPosition` bounds the
   *    commands a checkpoint contains). A load-context checkpoint registered by
   *    `activate()` is not descent evidence: its journal position only says
   *    where this store stood when the save was first seen.
   * 2. **Survival.** The boundary's world must still contain the command 鈥?   *    either its journal position covers it, or the command is live on the very
   *    checkpoint it was recorded against in the current generation. A reload
   *    that moves the boundary back behind the command, and that the command was
   *    not recorded against, is not survival.
   * 3. **Not rolled back**, by the existing `canClassifyCommandRolledBack`.
   *    Today conditions 1鈥? already imply it for every reachable state, so the
   *    call is redundant 鈥?it is kept explicit so that widening survival later
   *    cannot silently drop the rollback gate.
   *
   * So a normal periodic save no longer revokes certified evidence: the boundary
   * advances to a descendant that contains the command, and the lineage holds.
   */
  #durableLineage(commandId: string): V2CommandDurableLineage | null {
    if (this.#loadError || this.#blockedReason) return null;
    const active = this.#state.active;
    const current = this.#current;
    if (!active || !current) return null;
    const entry = this.#applicableCommands().find((candidate) => candidate.record.commandId === commandId);
    if (!entry) return null;
    if (entry.worldId !== active.worldId || entry.worldId !== current.worldId) return null;
    const boundary = this.#state.checkpoints.find(
      (checkpoint) => checkpoint.worldId === active.worldId && checkpoint.checkpointId === active.rollbackBoundaryId,
    );
    if (!boundary?.durable) return null;

    const recordedAgainstBoundary = entry.baseCheckpointId === boundary.checkpointId;
    const certifiedDescendant = boundary.purpose === "PERIODIC" && boundary.journalPosition >= entry.position;
    if (!recordedAgainstBoundary && !certifiedDescendant) return null;

    const contained = entry.position <= boundary.journalPosition;
    const liveOnBoundary = recordedAgainstBoundary && entry.worldEpochId === current.worldEpochId;
    if (!contained && !liveOnBoundary) return null;

    if (this.canClassifyCommandRolledBack(entry)) return null;

    return {
      worldId: entry.worldId,
      baseCheckpointId: entry.baseCheckpointId,
      position: entry.position,
      boundaryCheckpointId: boundary.checkpointId,
      proof: contained ? "CERTIFIED_CHECKPOINT_CONTAINS_COMMAND" : "LIVE_ON_RECORDED_CHECKPOINT",
    };
  }

  /**
   * The durable journal ancestry of a native world: the durable checkpoints
   * every durable command of that world was recorded against, the journal cut
   * they reach, and the runtime epochs they were recorded in.
   *
   * `null` means the loaded save cannot claim this lineage at all 鈥?no commands,
   * a command bound to a checkpoint this store never registered as durable, or a
   * command whose checkpoint belongs to a different native world. Descendant
   * inheritance is gated on this evidence; it is never inferred from "the world
   * looks similar".
   */
  #durableJournalLineage(
    worldId: string,
    nativeSessionGuid: string,
  ): { checkpointIds: string[]; journalPosition: number; worldEpochIds: string[] } | null {
    const commands = this.#state.commands.filter((entry) => entry.worldId === worldId);
    if (commands.length === 0) return null;
    const checkpointIds = new Set<string>();
    const worldEpochIds = new Set<string>();
    let journalPosition = 0;
    for (const entry of commands) {
      const base = this.#state.checkpoints.find(
        (checkpoint) =>
          checkpoint.worldId === worldId &&
          checkpoint.checkpointId === entry.baseCheckpointId &&
          checkpoint.durable,
      );
      if (!base || base.nativeSessionGuid !== nativeSessionGuid) return null;
      checkpointIds.add(base.checkpointId);
      worldEpochIds.add(entry.worldEpochId);
      journalPosition = Math.max(journalPosition, entry.position);
    }
    return { checkpointIds: [...checkpointIds], journalPosition, worldEpochIds: [...worldEpochIds] };
  }

  /**
   * The confirmation this store already holds for the loaded world, if any.
   *
   * Keyed on the persistent identity 鈥?native world and journal cut 鈥?so the
   * lineage does not have to be re-proven on every load of the same world, and
   * so a confirmation earned against a different journal cut cannot be reused
   * for a lineage that has since grown.
   */
  /**
   * The durable world lineage a current-world observation of this command may
   * be attributed to, or `null` when no lineage owns it.
   *
   * This is the identity a world-effect observation has to be judged against,
   * restated for the observation layer. It carries no runtime generation: a
   * generation is minted per load, so it cannot decide which world a scan came
   * from, and requiring it to equal the command's execution-time generation
   * made every reload unprovable.
   *
   * The proof is `#durableLineage`, which proves the active durable boundary
   * still contains the command; its world's session guid is the persistent one
   * the observation must match. A store with a load error, or a world with no
   * activated binding, answers `null` 鈥?callers must fail closed on it rather
   * than read it as "no lineage needed".
   */
  roadObservationProvenance(commandId: string): V2RoadEffectProvenance | null {
    if (this.#loadError) return null;
    // A registered checkpoint can sit before a terminal operation in the
    // later durable journal. That operation cannot authorize execution here,
    // but its immutable origin and this exact checkpoint cut safely attribute
    // a read-only effect observation to the current native world. The normal
    // durable-lineage gate remains unchanged for mutation and certification.
    if (this.isCommandOutsideActiveCheckpoint(commandId)) {
      const current = this.#current;
      const active = this.#state.active;
      const boundary = current && active
        ? this.#state.checkpoints.find((candidate) => candidate.worldId === current.worldId &&
            candidate.checkpointId === active.rollbackBoundaryId && candidate.durable)
        : undefined;
      const entry = this.#state.commands.find((candidate) => candidate.record.commandId === commandId);
      if (current && boundary && entry && entry.baseCheckpointId === boundary.checkpointId) {
        return {
          worldId: current.worldId,
          nativeSessionGuid: current.nativeSessionGuid,
          baseCheckpointId: boundary.checkpointId,
          lineageCheckpointIds: [boundary.checkpointId],
          proof: "REGISTERED_CHECKPOINT_CUT_EXCLUDES_COMMAND",
        };
      }
      return null;
    }
    const lineage = this.#durableLineage(commandId);
    const current = this.#current;
    if (!lineage || !current || lineage.worldId !== current.worldId) return null;
    const boundary = this.#state.checkpoints.find(
      (checkpoint) => checkpoint.worldId === current.worldId && checkpoint.checkpointId === lineage.boundaryCheckpointId,
    );
    if (!boundary?.durable) return null;
    return {
      worldId: lineage.worldId,
      nativeSessionGuid: boundary.nativeSessionGuid ?? current.nativeSessionGuid,
      baseCheckpointId: lineage.baseCheckpointId,
      lineageCheckpointIds: [lineage.boundaryCheckpointId],
      proof: "CERTIFIED_DURABLE_LINEAGE",
    };
  }

  /**
   * Every current-world observation recorded for a command, oldest first. These
   * are append-only: they never rewrite the command's execution-time verdict, so
   * a command that was proven to leave no effect when it ran keeps that verdict
   * while the world is free to change underneath it.
   */
  worldObservations(commandId: string): V2WorldObservationRecord[] {
    return (this.#state.worldObservations ?? [])
      .filter((observation) => observation.commandId === commandId)
      .map(clone);
  }

  /**
   * Append one current-world observation for a command.
   *
   * This is the *only* way a later world reading reaches the durable store, and
   * it is deliberately append-only in both directions:
   *
   * - The command record is never touched. Its `status` and
   *   `effectAbsenceProven` are the verdict reached when the command ran, and
   *   they stay that verdict forever.
   * - The `historicalVerdict` written into the observation is copied from the
   *   command record here, not supplied by the caller, so a caller cannot
   *   restate history to agree with what it just observed.
   *
   * The result is the distinction the store was missing: a command can be
   * proven to have left no effect at execution time *and* the current world can
   * be observed to contain that effect now. Both statements are true, they are
   * recorded separately, and neither silently reinterprets the other.
   */
  recordCurrentWorldObservation(input: {
    commandId: string;
    currentWorldEffectPresent: boolean | null;
    currentWorldObjectiveSatisfied: boolean | null;
    evidence: string;
    /**
     * The runtime the reading was taken in. Defaults to the active world's epoch;
     * a caller that observed the world under a generation whose binding is
     * generation-local may name it, instead of having the reading attributed to
     * whatever generation this coordinator last activated.
     */
    worldEpochId?: string;
  }): V2WorldObservationRecord {
    this.#assertStoreHealthy();
    const world = this.#current;
    const active = this.#state.active;
    if (!world || !active) throw new Error("V2 durability world binding is not initialized");
    const entry = this.#state.commands.find(
      (candidate) => candidate.record.commandId === input.commandId && candidate.worldId === world.worldId,
    );
    if (!entry) throw new Error(`no durable command ${input.commandId} exists in the current world lineage`);
    const at = this.now().toISOString();
    const observation: V2WorldObservationRecord = {
      schemaVersion: V2_WORLD_OBSERVATION_SCHEMA_VERSION,
      observationId: `world-observation:${input.commandId}:${at}`,
      commandId: input.commandId,
      worldId: world.worldId,
      worldEpochId: input.worldEpochId ?? world.worldEpochId,
      nativeSessionGuid: world.nativeSessionGuid,
      observedAt: at,
      historicalVerdict: {
        status: String(entry.record.status),
        effectAbsenceProven: entry.record.effectAbsenceProven === true,
      },
      currentWorldEffectPresent: input.currentWorldEffectPresent,
      currentWorldObjectiveSatisfied: input.currentWorldObjectiveSatisfied,
      evidence: input.evidence,
    };
    const observations = this.#state.worldObservations ?? (this.#state.worldObservations = []);
    observations.push(observation);
    this.#trimAndSave();
    return clone(observation);
  }

  /**
   * Certify a durable rollback boundary for a confirmed descendant save.
   *
   * The loaded save carries no native checkpoint identity of its own, so write
   * authority stays blocked until this store records a completed save for the
   * current world. The inherited journal cut is carried into the checkpoint, so
   * the commands the reconstruction rests on stay applicable to it.
   */
  certifyDescendantCheckpoint(receipt: SaveCompletionReceipt): V2CheckpointRecord {
    this.#assertStoreHealthy();
    const baseline = this.#state.baselineActivation;
    if (!this.#current || !this.#state.active || baseline?.status !== "DESCENDANT_CHECKPOINT_REQUIRED") {
      throw new Error("descendant checkpoint certification requires a confirmed descendant lineage");
    }
    const checkpoint = this.recordCheckpoint(receipt, baseline.journalPosition);
    this.#state.baselineActivation = {
      ...baseline,
      status: "ACTIVATED",
      checkpointId: checkpoint.checkpointId,
      recordedAt: this.now().toISOString(),
    };
    this.#trimAndSave();
    return checkpoint;
  }

  /**
   * Durable first-facility placement operations for one admitted scope.
   *
   * Returns `null` when there is no active durable world/checkpoint lineage to
   * match against, so the caller can distinguish "no operation exists" from
   * "cannot prove anything" and fail closed on the latter.
   *
   * Matching is intentionally **broad** here 鈥?the full applicability predicate,
   * journal-position fallback included 鈥?the mirror image of `#durableLineage`.
   * This answer *withholds* authority, so over-inclusion only holds a placement
   * back for reconciliation, while under-inclusion could authorize a duplicate.
   */
  utilityPlacementOperations(scope: UtilityPlacementScope): UtilityPlacementOperation[] | null {
    if (this.#loadError || this.#blockedReason) return null;
    const active = this.#state.active;
    if (!active) return null;
    const boundary = this.#state.checkpoints.find(
      (checkpoint) => checkpoint.worldId === active.worldId && checkpoint.checkpointId === active.rollbackBoundaryId,
    );
    if (!boundary?.durable) return null;
    const activeCommands = this.#applicableCommands();
    const activeIds = new Set(activeCommands.map((entry) => entry.record.commandId));
    // A placement after the loaded checkpoint cut is historical on this
    // branch, but it can still have left a world effect in another descendant.
    // Keep it as a placement hold until the exact loaded checkpoint has an
    // authoritative absence observation. This does not reactivate or replay
    // the command; it only prevents a new placement from being authorized on
    // the strength of a missing active-lineage entry.
    const checkpoint = this.#state.checkpoints.find((candidate) =>
      candidate.worldId === active.worldId && candidate.checkpointId === active.rollbackBoundaryId,
    );
    const outsideCutPlacements = checkpoint ? this.#state.commands.filter((entry) => {
      const record = entry.record;
      if (activeIds.has(record.commandId) || entry.worldId !== checkpoint.worldId ||
        entry.baseCheckpointId !== checkpoint.checkpointId || entry.position <= checkpoint.journalPosition ||
        record.actionFamily !== "UTILITY" || record.authorizedScope.actionFamily !== "UTILITY") return false;
      const scopeOf = record.authorizedScope;
      if (scopeOf.projectId !== scope.projectId || scopeOf.trancheId !== scope.trancheId ||
        scopeOf.reservationRef !== scope.reservationRef || scopeOf.utilityKind !== scope.utilityKind ||
        (scopeOf.placementScopeId ?? LEGACY_UTILITY_PLACEMENT_SCOPE_ID) !==
          (scope.placementScopeId ?? LEGACY_UTILITY_PLACEMENT_SCOPE_ID) ||
        !carriesFacilityPlacement(scopeOf.exactInput)) return false;
      const provenNoEffect = record.status === "FAILED_BEFORE_SUBMIT" ||
        (record.status === "OBSERVED_MISMATCH" && record.effectAbsenceProven === true);
      if (provenNoEffect) return false;
      const absenceWitness = this.checkpointRecoveryWitness(record.commandId);
      return absenceWitness === null;
    }) : [];
    return [...activeCommands, ...outsideCutPlacements]
      .filter((entry) => {
        const record = entry.record;
        if (record.actionFamily !== "UTILITY") return false;
        const scopeOf = record.authorizedScope;
        if (scopeOf.actionFamily !== "UTILITY") return false;
        if (
          scopeOf.projectId !== scope.projectId ||
          scopeOf.trancheId !== scope.trancheId ||
          scopeOf.reservationRef !== scope.reservationRef ||
          scopeOf.utilityKind !== scope.utilityKind ||
          (scopeOf.placementScopeId ?? LEGACY_UTILITY_PLACEMENT_SCOPE_ID) !==
            (scope.placementScopeId ?? LEGACY_UTILITY_PLACEMENT_SCOPE_ID)
        ) {
          return false;
        }
        return carriesFacilityPlacement(scopeOf.exactInput);
      })
      .sort((left, right) => left.position - right.position)
      .map((entry) => ({
        commandId: entry.record.commandId,
        position: entry.position,
        outcome: entry.outcome,
        status: entry.record.status,
        effectAbsenceProven: entry.record.effectAbsenceProven === true,
        failedBeforeSubmit: entry.record.status === "FAILED_BEFORE_SUBMIT",
      }));
  }

  /**
   * The durable UTILITY *connection* commands for one admitted scope: the exact
   * mirror of `utilityPlacementOperations` for the connection course instead of
   * the facility placement. A course listed here already reached the world, so
   * preparation must accept it rather than ask the game to validate a duplicate
   * of work it already performed. Fail-closed in the same way: `null` means the
   * durable lineage could not be read, which proves nothing.
   */
  utilityNetworkOperations(scope: UtilityPlacementScope): Array<{
    commandId: string;
    position: number;
    outcome: UtilityPlacementOperation["outcome"];
    status: string;
    exactInput: string;
    failedBeforeSubmit: boolean;
  }> | null {
    if (this.#loadError || this.#blockedReason) return null;
    const active = this.#state.active;
    if (!active) return null;
    const boundary = this.#state.checkpoints.find(
      (checkpoint) => checkpoint.worldId === active.worldId && checkpoint.checkpointId === active.rollbackBoundaryId,
    );
    if (!boundary?.durable) return null;
    return this.#applicableCommands()
      .filter((entry) => {
        const record = entry.record;
        if (record.actionFamily !== "UTILITY") return false;
        const scopeOf = record.authorizedScope;
        if (scopeOf.actionFamily !== "UTILITY") return false;
        if (
          scopeOf.projectId !== scope.projectId ||
          scopeOf.trancheId !== scope.trancheId ||
          scopeOf.reservationRef !== scope.reservationRef ||
          scopeOf.utilityKind !== scope.utilityKind ||
          (scopeOf.placementScopeId ?? LEGACY_UTILITY_PLACEMENT_SCOPE_ID) !==
            (scope.placementScopeId ?? LEGACY_UTILITY_PLACEMENT_SCOPE_ID)
        ) {
          return false;
        }
        // A facility placement is a different authority; only a connection
        // course is proven here.
        if (carriesFacilityPlacement(scopeOf.exactInput)) return false;
        return carriesNetworkConnection(scopeOf.exactInput);
      })
      .sort((left, right) => left.position - right.position)
      .map((entry) => ({
        commandId: entry.record.commandId,
        position: entry.position,
        outcome: entry.outcome,
        status: entry.record.status,
        exactInput: scopeExactInput(entry.record.authorizedScope),
        failedBeforeSubmit: entry.record.status === "FAILED_BEFORE_SUBMIT",
      }));
  }

  snapshot(): V2DurableState {
    return clone(this.#state);
  }

  /** True only when this coordinator instance has bound the live in-memory world, not just persisted its identity. */
  isCurrentlyActivatedWorld(worldId: string, generation: string): boolean {
    return this.#blockedReason === null && this.#state.executionBranch?.executionReady !== false &&
      this.#current?.worldId === worldId && this.#current.generation === generation &&
      this.#state.active?.worldId === worldId && this.#state.active.generation === generation;
  }

  /**
   * The checkpoint identity of the branch this store is running, or `null` when
   * the branch cannot be proven.
   *
   * The identity is the branch's **rollback boundary** — the checkpoint this
   * city would be rolled back to — and deliberately not `loadedCheckpointId`,
   * which records where the branch was loaded *from*. Those are the same value
   * for a world loaded from a save, and they are not for a city started fresh:
   * `activateWorld` sets `loadedCheckpointId: world.checkpointId`, which is
   * `null` by construction for a `NewGame`, while the same activation records the
   * BASELINE it created as the rollback boundary and certifies it. Reading the
   * loaded identity made every exact-operation authorization unsatisfiable on a
   * fresh city even though the branch was fully certified — measured live
   * (2026-10-01): `K05: UTILITY_SERVICE_ROAD_CHILD_CURRENT_BRANCH_NOT_PROVEN` on
   * every attempt, a city with 7 roads, no water, no sewage and no residents.
   *
   * This is the same boundary {@link assertMutationAllowed} has always required
   * before any world write, plus the journal-cut and world agreement the
   * exact-operation bindings need on top of it. It is proven rather than
   * asserted, and every term has to hold:
   *
   * - a durable checkpoint record exists for `(active.worldId,
   *   active.rollbackBoundaryId)` at exactly `activatedCheckpointJournalCut`, so
   *   the journal the authorizations bind to starts where the boundary does;
   * - the activation record names that same checkpoint for this world and is in
   *   a completed state, so the boundary is the one the product activated
   *   against rather than a leftover of an earlier world;
   * - the world and generation are still the ones this store has activated, so a
   *   reload or rollback cannot leave an old branch looking current.
   *
   * A caller that gets `null` refuses by name. It never substitutes another
   * checkpoint and never falls back to an unproven one.
   */
  currentBranchCheckpoint(): { worldId: string; generation: string; checkpointId: string; journalCut: number } | null {
    this.#assertStoreHealthy();
    const active = this.#state.active;
    const baseline = this.#state.baselineActivation;
    const cut = active?.activatedCheckpointJournalCut;
    const checkpoint = active
      ? this.#state.checkpoints.find(
          (entry) => entry.worldId === active.worldId && entry.checkpointId === active.rollbackBoundaryId,
        )
      : undefined;
    if (!active || !this.#current || this.#blockedReason !== null ||
      !Number.isInteger(cut) || (cut as number) < 0 ||
      !checkpoint?.durable || checkpoint.journalPosition !== cut ||
      !["ACTIVATED", "ACTIVATED_IN_PLACE"].includes(String(baseline?.status)) ||
      baseline?.worldId !== active.worldId || baseline.checkpointId !== active.rollbackBoundaryId ||
      !this.isCurrentlyActivatedWorld(active.worldId, active.generation)) return null;
    return { worldId: active.worldId, generation: active.generation,
      checkpointId: active.rollbackBoundaryId, journalCut: cut as number };
  }

  isExecutionDurablyActivated(activation: {
    status: V2DurableActivationStatus;
    blockedReason?: string | null;
    world: NativeWorldIdentity;
  }): boolean {
    if (activation.blockedReason || !["ACTIVATED", "ACTIVATED_IN_PLACE"].includes(activation.status) ||
      this.#state.executionBranch?.executionReady === false) return false;
    const active = this.#state.active;
    const baseline = this.#state.baselineActivation;
    const boundary =
      active &&
      this.#state.checkpoints.find(
        (checkpoint) => checkpoint.worldId === active.worldId && checkpoint.checkpointId === active.rollbackBoundaryId,
      );
    if (!this.#current || !active || !boundary?.durable || !baseline || baseline.status !== activation.status)
      return false;
    if (
      this.#current.worldId !== activation.world.worldId ||
      this.#current.nativeSessionGuid !== activation.world.nativeSessionGuid ||
      this.#current.generation !== activation.world.generation ||
      this.#current.worldEpochId !== activation.world.worldEpochId ||
      active.worldId !== activation.world.worldId ||
      active.worldEpochId !== activation.world.worldEpochId ||
      active.generation !== activation.world.generation
    )
      return false;
    if (activation.status !== "ACTIVATED_IN_PLACE") return true;
    // The in-place anchor must be exactly the current rollback boundary, in the
    // same native world, at the same journal cut. The runtime generation and the
    // epoch the anchor was certified in are deliberately not compared: they
    // identify the load, not the lineage.
    const anchor = this.#state.certifiedRollbackAnchor;
    return Boolean(
      anchor?.status === "CERTIFIED" &&
        anchor.checkpointId === boundary.checkpointId &&
        anchor.worldId === activation.world.worldId &&
        anchor.nativeSessionGuid === activation.world.nativeSessionGuid &&
        anchor.journalPosition === boundary.journalPosition,
    );
  }

  /** Commit the second phase of a historical fork after its live world was read authoritatively. */
  markExecutionBranchWorldVerified(input: {
    worldId: string;
    generation: string;
    worldEpochId: string;
    checkpointId: string;
  }): void {
    this.#assertStoreHealthy();
    const active = this.#state.active;
    const branch = this.#state.executionBranch;
    const boundary = active && this.#state.checkpoints.find((checkpoint) =>
      checkpoint.worldId === active.worldId && checkpoint.checkpointId === active.rollbackBoundaryId);
    if (!active || !this.#current || !branch || branch.executionReady !== false || !boundary?.durable ||
      active.worldId !== input.worldId || active.generation !== input.generation || active.worldEpochId !== input.worldEpochId ||
      active.loadedCheckpointId !== input.checkpointId || active.rollbackBoundaryId !== input.checkpointId ||
      this.#current.worldId !== input.worldId || this.#current.generation !== input.generation ||
      this.#current.worldEpochId !== input.worldEpochId || this.#current.checkpointId !== input.checkpointId) {
      throw new Error("HISTORICAL_BRANCH_WORLD_VERIFICATION_BINDING_CHANGED");
    }
    branch.executionReady = true;
    this.#trimAndSave();
  }

  currentJournalPosition(): number {
    return this.#state.journalPosition;
  }

  projectState(): V2DurableProjectState {
    this.#assertStoreHealthy();
    return clone(this.#state.projectState);
  }

  goalWorkOrder(goalId: string): V2GoalWorkOrderRecord | null {
    this.#assertStoreHealthy();
    const record = this.#state.goalWorkOrders?.find((item) => item.goalId === goalId);
    return record ? clone(record) : null;
  }

  #goalWorkOrderHasUnresolvedCommands(state: Gate1State): boolean {
    const trancheTaskIds = new Set(state.tranche.taskIds);
    if (state.tasks.some((task) => trancheTaskIds.has(task.id) && (task.status === "DISPATCHED" || !!task.activeCommandId))) return true;
    const commandIds = new Set(state.journal.filter((entry) => trancheTaskIds.has(entry.taskId) && entry.commandId)
      .map((entry) => entry.commandId!));
    const unresolved = new Set<DurableCommandOutcome>(["SUBMITTED", "NATIVE_COMPLETED", "APPLIED", "UNKNOWN"]);
    for (const commandId of commandIds) {
      const command = this.#state.commands.find((entry) => entry.record.commandId === commandId);
      // A journal reference without its durable command receipt is not proof of
      // completion; retain the scope until the existing reconciliation path can
      // bind it to a known outcome.
      if (!command || unresolved.has(command.outcome)) return true;
    }
    return false;
  }

  #gate1TerminalBlockIsProven(state: Gate1State): boolean {
    if (state.project.status !== "BLOCKED" || state.intent.status !== "BLOCKED") return false;
    const terminalTasks = state.tasks.filter((task) => state.tranche.taskIds.includes(task.id) &&
      (task.status === "BLOCKED" || task.status === "FAILED"));
    return terminalTasks.length > 0 && terminalTasks.every((task) => !!task.terminalOutcomeId &&
      state.journal.some((entry) => entry.id === task.terminalOutcomeId && entry.taskId === task.id));
  }

  #lifecycleForGate1State(state: Gate1State, previous?: V2GoalWorkOrderRecord["status"]): V2GoalWorkOrderRecord["status"] {
    if (state.project.status === "COMPLETE") {
      return this.#goalWorkOrderHasUnresolvedCommands(state) ? "RECONCILING" : "COMPLETE";
    }
    if (state.project.status === "BLOCKED") {
      return this.#gate1TerminalBlockIsProven(state) && !this.#goalWorkOrderHasUnresolvedCommands(state)
        ? "BLOCKED" : "RECONCILING";
    }
    // Saving an intermediate Gate1 observation cannot itself clear a prior
    // lifecycle inconsistency. A later progression result must confirm that the
    // active workflow resumed coherently.
    return previous === "RECONCILING" ? "RECONCILING" : "ACTIVE";
  }

  #isReservationReleased(record: V2GoalWorkOrderRecord): boolean {
    return goalWorkOrderReservationReleased(record);
  }

  /**
   * Whether this work order still holds something: a live step, an unsettled
   * command, an unreached milestone, or an envelope nobody released.
   *
   * One predicate, two readers. It answers "may a successor plan over this land"
   * for admission's protections, and "does this record still consume capacity"
   * for the registry 鈥?and those are the same question. Two spellings of it would
   * eventually disagree, and the disagreement would look like either a lost claim
   * or a permanently blocked city.
   */
  #goalWorkOrderHoldsClaim(record: V2GoalWorkOrderRecord): boolean {
    if (record.status === "ACTIVE" || record.status === "RECONCILING") return true;
    if (record.status === "SUSPENDED") return !this.#isReservationReleased(record);
    if (record.status === "COMPLETE") {
      if (this.#goalWorkOrderHasUnresolvedCommands(record.state)) return true;
      if (goalWorkOrderReachedMilestone(record)) return false;
      // A COMPLETE record that did not reach its milestone is normally kept
      // fail-closed, but not when its own stored project is terminally BLOCKED.
      // Then there is nothing left for it to deliver: no bounded step remains,
      // and its goal id embeds the facts hash of the derivation that raised it,
      // which no later derivation can name again — it can neither be resumed nor
      // re-derived. Holding its envelope would let one dead 180 m scope veto
      // every later project in that region forever, which is the same failure
      // `recordGoalWorkOrderProgressionOutcome` already releases on the same
      // evidence. Measured live (2026-09-30): two such sewage `ROAD_ACCESS`
      // records covered all four Growable Fast Path footprints around the owned
      // road network, so every growth Goal was refused and the Brain spawned a
      // Road prerequisite that could not create a zoning cell.
      return !this.#gate1TerminalBlockIsProven(record.state);
    }
    if (this.#isReservationReleased(record)) return false;
    // BLOCKED is terminal only when Gate1's terminal task outcome and every
    // command it references are settled. Old or partial records fail closed.
    return !this.#gate1TerminalBlockIsProven(record.state) || this.#goalWorkOrderHasUnresolvedCommands(record.state);
  }

  isGoalWorkOrderReservationProtected(workOrderId: string): boolean {
    this.#assertStoreHealthy();
    const record = this.#state.goalWorkOrders?.find((item) => item.workOrderId === workOrderId);
    // An unknown work order is not evidence that its land is free.
    if (!record) return true;
    return this.#goalWorkOrderHoldsClaim(record);
  }

  /** Admission capacity: how many Goal work orders still hold a claim. */
  #openGoalWorkOrderCount(): number {
    return (this.#state.goalWorkOrders ?? []).filter((item) => this.#goalWorkOrderHoldsClaim(item)).length;
  }

  /**
   * Retire the Goal plan when there is no project state for it to stand on.
   *
   * The store only ever mints a work order together with that work order's
   * project state, so a placeholder project state beside a non-empty registry is
   * not a state the write path can produce 鈥?it is what an activation leaves
   * behind when it retires the project state and keeps the plan. That shape
   * deadlocks admission (see the call site in `activate`), so it is reconciled
   * to the only reading that is true: with no project, there is no active plan
   * and no claim on land. Returns whether anything was retired.
   */
  #retirePlanWithoutProject(): boolean {
    const planExists = (this.#state.goalWorkOrders?.length ?? 0) > 0 || this.#state.activeGoalWorkOrderId !== null;
    if (!planExists || !isPlaceholderProjectState(this.#state.projectState)) return false;
    this.#state.activeGoalWorkOrderId = null;
    this.#state.goalWorkOrders = [];
    return true;
  }

  /**
   * Give up a displaced work order's planning reservation, once it is safe to.
   *
   * NOT while anything is unsettled. An in-flight or UNKNOWN native command is a
   * question that has not been answered yet; releasing its land before the
   * existing reconciliation path settles it would let another Goal be admitted
   * into a scope whose world effect is still unknown, and the reconciliation
   * would then have nowhere to put its answer. So the envelope stays protected
   * and the record stays out of the released state until reconciliation finishes.
   */
  #releaseReservationIfReconciled(record: V2GoalWorkOrderRecord): boolean {
    if (this.#isReservationReleased(record)) return false;
    if (this.#goalWorkOrderHasUnresolvedCommands(record.state)) return false;
    record.releasedReservationAt = this.now().toISOString();
    return true;
  }

  /**
   * Bring every already-displaced work order onto the current rule.
   *
   * A store written before displacement released anything holds suspended Goals
   * that still claim 180 m of land each 鈥?and whose goal ids carry world-fact
   * fingerprints no later derivation can produce, so they can neither be resumed
   * nor re-derived. Applying the rule on the write path makes such a store
   * consistent the next time it is written, rather than letting it hold land no
   * planning path can ever name again. History is untouched: only the envelope
   * is released, and only for a record with nothing left to reconcile.
   */
  #releaseDisplacedSuspensions(): number {
    let released = 0;
    for (const record of this.#state.goalWorkOrders ?? []) {
      if (record.status !== "SUSPENDED") continue;
      if (record.workOrderId === this.#state.activeGoalWorkOrderId) continue;
      if (this.#releaseReservationIfReconciled(record)) released += 1;
    }
    return released;
  }

  /**
   * Refuse a new work order only when the branch truly cannot carry another one.
   *
   * Checked before appending, so the count it compares against is the capacity
   * this record is about to consume. Terminal history is not consulted: a
   * finished Goal no longer competes for the right to plan.
   */
  #assertGoalWorkOrderCapacity(): void {
    if (this.#openGoalWorkOrderCount() >= MAXIMUM_OPEN_GOAL_WORK_ORDERS) {
      throw new Error(`GOAL_WORK_ORDER_CAPACITY_EXHAUSTED:${MAXIMUM_OPEN_GOAL_WORK_ORDERS}`);
    }
    if ((this.#state.goalWorkOrders?.length ?? 0) >= MAXIMUM_GOAL_WORK_ORDER_HISTORY) {
      throw new Error(`GOAL_WORK_ORDER_HISTORY_LIMIT_REACHED:${MAXIMUM_GOAL_WORK_ORDER_HISTORY}`);
    }
  }

  recordGoalWorkOrderProgressionOutcome(input: {
    status: string;
    state: Gate1State | null;
    reason?: string;
  }): V2GoalWorkOrderRecord | null {
    this.#assertStoreHealthy();
    const activeId = this.#state.activeGoalWorkOrderId;
    const record = this.#state.goalWorkOrders?.find((item) => item.workOrderId === activeId);
    if (!record) return null;
    const durable = this.#state.projectState;
    const identityMatches = input.state?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
      input.state.project.id === record.projectId && input.state.tranche.id === record.trancheId &&
      durable.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && durable.intent.id === input.state.intent.id &&
      durable.project.id === record.projectId && durable.tranche.id === record.trancheId;
    if (!identityMatches) {
      record.status = "RECONCILING";
      record.reconciliationReason = (input.reason ?? "Gate1 progression state did not match the active durable work order").slice(0, 500);
      record.updatedAt = this.now().toISOString();
      this.#trimAndSave();
      return clone(record);
    }

    const terminalStatus = this.#lifecycleForGate1State(durable as Gate1State);
    if (terminalStatus === "BLOCKED" || terminalStatus === "COMPLETE") {
      record.status = terminalStatus;
      record.reconciliationReason = null;
      // A terminal BLOCKED work order is finished: Gate1 recorded the task
      // outcome, every command it referenced is settled, and nothing is left to
      // reconcile. Holding its planning envelope would keep one scope that
      // cannot be delivered vetoing every later project in the region 鈥?the same
      // reason the bounded-failure path below releases. Recorded on the work
      // order itself rather than left to be recomputed from its state, because
      // "this land is free again" is a durable fact about the city, not a
      // property of one reader.
      if (terminalStatus === "BLOCKED") {
        record.releasedReservationAt = record.releasedReservationAt ?? this.now().toISOString();
      }
    } else if (terminalStatus === "RECONCILING") {
      // The durable Gate1 state is itself inconsistent with its own journal: a
      // project recorded as terminal whose tasks carry no terminal outcome, or a
      // work order that was already reconciling. That is a durability
      // discrepancy rather than a step that could not be taken, so it stays
      // fail-closed until a later progression result proves it coherent.
      record.status = "RECONCILING";
      record.reconciliationReason = (input.reason ?? "Gate1 progression did not prove a durable terminal outcome").slice(0, 500);
    } else if (input.status === "BLOCKED") {
      const reason = input.reason ?? "Gate1 progression did not prove a durable terminal outcome";
      // Reconciliation exists for a native effect whose outcome is genuinely
      // unknown: a command that is in flight, or one that ended UNKNOWN. With
      // none of those there is nothing for the reconciliation path to adopt, so
      // Gate1 refusing to take a step is a bounded, terminal outcome 鈥?an empty
      // road candidate set, a durable site the current world no longer
      // reproduces, a rejected exact candidate.
      //
      // Holding such a work order in reconciliation instead pauses its parent
      // Goal indefinitely and freezes the whole city behind one exhausted step,
      // while no later reconciliation could ever clear it. It keeps its durable
      // history, releases the land it reserved, and a successor is admitted from
      // current facts through the ordinary admission.
      const reconcile = this.#goalWorkOrderHasUnresolvedCommands(durable as Gate1State);
      record.status = reconcile ? "RECONCILING" : "BLOCKED";
      record.reconciliationReason = reason.slice(0, 500);
      if (!reconcile) record.releasedReservationAt = this.now().toISOString();
    } else {
      record.status = "ACTIVE";
      record.reconciliationReason = null;
    }
    record.state = clone(durable as Gate1State);
    record.updatedAt = this.now().toISOString();
    this.#trimAndSave();
    return clone(record);
  }

  /**
   * Atomically activate or resume one admitted goal work order. A different
   * current work order is retained in the same durable store before the active
   * Gate1 adapter slot changes. Submitted or unresolved commands fence a switch
   * until the existing reconciliation path settles them.
   */
  activateGoalWorkOrder(input: { goalId: string; state?: Gate1State; parentGoalId?: string;
    parentLandUse?: GrowableLandUse; targetPoint?: { x: number; z: number };
    roadCourse?: { start: { x: number; z: number }; end: { x: number; z: number } };
    completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED" }): Gate1State {
    this.#assertStoreHealthy();
    if (!nonEmpty(input.goalId)) throw new Error("GOAL_WORK_ORDER_ID_REQUIRED");
    if (input.targetPoint && (!Number.isFinite(input.targetPoint.x) || !Number.isFinite(input.targetPoint.z))) {
      throw new Error("GOAL_WORK_ORDER_TARGET_POINT_INVALID");
    }
    if (input.roadCourse !== undefined && !isFiniteRoadCourse(input.roadCourse)) {
      throw new Error("GOAL_WORK_ORDER_ROAD_COURSE_INVALID");
    }
    if (!this.#current || !this.#state.active || this.#blockedReason) {
      throw new Error(this.#blockedReason ?? "GOAL_WORK_ORDER_REQUIRES_ACTIVE_WORLD");
    }
    if (this.#state.executionBranch?.executionReady === false) throw new Error("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    const workOrders = this.#state.goalWorkOrders ?? (this.#state.goalWorkOrders = []);
    this.#releaseDisplacedSuspensions();
    const target = workOrders.find((item) => item.goalId === input.goalId);
    if (!target && !input.state) throw new Error("GOAL_WORK_ORDER_NOT_FOUND");
    if (target && input.state && target.state.intent.id !== input.state.intent.id) {
      throw new Error("GOAL_WORK_ORDER_IDENTITY_CONFLICT");
    }
    if (target && ((input.parentGoalId !== undefined && target.parentGoalId !== input.parentGoalId) ||
      (input.parentLandUse !== undefined && target.parentLandUse !== input.parentLandUse) ||
      (input.targetPoint !== undefined && JSON.stringify(target.targetPoint) !== JSON.stringify(input.targetPoint)) ||
      (input.roadCourse !== undefined && JSON.stringify(target.roadCourse) !== JSON.stringify(input.roadCourse)) ||
      (input.completionStage !== undefined && target.completionStage !== input.completionStage))) {
      throw new Error("GOAL_WORK_ORDER_PREREQUISITE_IDENTITY_CONFLICT");
    }
    const next = target?.state ?? input.state!;
    if (!validProjectState(objectRecord(next))) throw new Error("GOAL_WORK_ORDER_STATE_INVALID");
    const branchId = this.#state.executionBranch?.branchId;
    if (!branchId || !this.#current.worldId) throw new Error("GOAL_WORK_ORDER_EXECUTION_BRANCH_UNBOUND");
    if (target && (target.worldId !== this.#current.worldId || target.branchId !== branchId)) {
      throw new Error("GOAL_WORK_ORDER_WORLD_OR_BRANCH_MISMATCH");
    }

    const current = this.#state.projectState;
    if (current.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && current.intent.id !== next.intent.id) {
      const taskIds = new Set(current.tranche.taskIds);
      if (current.tasks.some((task) => taskIds.has(task.id) && (task.status === "DISPATCHED" || task.activeCommandId))) {
        throw new Error("GOAL_WORK_ORDER_SWITCH_HAS_IN_FLIGHT_TASK");
      }
      const commandIds = new Set(current.journal.filter((item) => taskIds.has(item.taskId) && item.commandId).map((item) => item.commandId!));
      const unresolved = this.#state.commands.find((entry) => commandIds.has(entry.record.commandId) &&
        ["SUBMITTED", "NATIVE_COMPLETED", "APPLIED", "UNKNOWN"].includes(entry.outcome));
      if (unresolved) throw new Error(`GOAL_WORK_ORDER_SWITCH_REQUIRES_RECONCILIATION:${unresolved.record.commandId}`);
    }

    const activeId = this.#state.activeGoalWorkOrderId ?? null;
    // A work order whose planning envelope was released cannot be resumed:
    // something may already have been admitted into the land it gave up, and
    // re-activating it would put two live claims on one envelope. Successors are
    // admitted, not resurrected. Checked before the BLOCKED branch, because a
    // released record is refused outright rather than reinterpreted.
    if (target && target.status !== "ACTIVE" && this.#isReservationReleased(target)) {
      throw new Error(`GOAL_WORK_ORDER_RELEASED_SCOPE_SUCCESSOR_REQUIRED:${target.goalId}`);
    }
    if (target?.status === "BLOCKED") {
      const settled = this.#gate1TerminalBlockIsProven(target.state) && !this.#goalWorkOrderHasUnresolvedCommands(target.state)
        ? "BLOCKED" : "RECONCILING";
      target.status = settled;
      if (settled === "BLOCKED") throw new Error("GOAL_WORK_ORDER_TERMINAL_SUCCESSOR_REQUIRED");
      target.reconciliationReason = "Stored BLOCKED status lacked terminal Gate1 or command reconciliation proof";
      target.updatedAt = this.now().toISOString();
      this.#trimAndSave();
    }
    if (target?.status === "RECONCILING" && activeId !== target.workOrderId) {
      throw new Error("GOAL_WORK_ORDER_RECONCILIATION_REQUIRES_ACTIVE_SCOPE");
    }
    const currentRecord = activeId
      ? workOrders.find((item) => item.workOrderId === activeId)
      : current.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
        ? workOrders.find((item) => item.projectId === current.project.id && item.trancheId === current.tranche.id && item.status === "COMPLETE")
        : undefined;
    if (current.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && current.intent.id !== next.intent.id) {
      const legacyGoalId = `legacy:${current.intent.id}`;
      const legacyWorkOrderId = `goal-work-order:${legacyGoalId}`;
      // The displaced project slot is synthesized here, so no planning path can
      // ever ask for it again: its Goal id is minted in this store rather than
      // derived by the Brain. Its planning envelope is released with it. Retaining
      // the envelope would let one abandoned scope veto every later project in
      // the region it covers, which is what stops a grown city from being planned
      // around its own original starter. The slot stays durable history, and
      // `activateGoalWorkOrder` refuses to resume it 鈥?a successor has to pass the
      // ordinary admission and receive its own scope.
      const releasedReservationAt = this.now().toISOString();
      if (currentRecord) {
        // A settled scope keeps the status that settled it. Recomputing it from
        // the displaced project state would relabel a terminally closed work
        // order as merely paused, which is the status that claims it can still
        // be resumed.
        if (currentRecord.status !== "COMPLETE" && !this.#isReservationReleased(currentRecord)) {
          const stateLifecycle = this.#lifecycleForGate1State(current, currentRecord.status);
          currentRecord.status = stateLifecycle === "ACTIVE" ? "SUSPENDED" : stateLifecycle;
          // A displaced slot gives up its planning reservation like any other.
          if (currentRecord.status === "SUSPENDED") this.#releaseReservationIfReconciled(currentRecord);
        }
        if (currentRecord.goalId === legacyGoalId) {
          currentRecord.releasedReservationAt = currentRecord.releasedReservationAt ?? releasedReservationAt;
        }
        currentRecord.state = clone(current);
        currentRecord.updatedAt = this.now().toISOString();
      } else {
        this.#assertGoalWorkOrderCapacity();
        workOrders.push({
          workOrderId: legacyWorkOrderId, goalId: legacyGoalId, worldId: this.#current.worldId, branchId,
          projectId: current.project.id,
          trancheId: current.tranche.id, reservationRef: current.tranche.reservationRef,
          status: (() => {
            const lifecycle = this.#lifecycleForGate1State(current);
            return lifecycle === "ACTIVE" ? "SUSPENDED" : lifecycle;
          })(),
          releasedReservationAt,
          state: clone(current), updatedAt: this.now().toISOString(),
        });
      }
    }

    let activated: V2GoalWorkOrderRecord;
    if (target) {
      activated = target;
      // Reactivating a work order that held nothing is a new admission for
      // capacity purposes even though its record already exists 鈥?otherwise the
      // capacity bound could be sidestepped by reusing finished records.
      if (!this.#goalWorkOrderHoldsClaim(activated)) this.#assertGoalWorkOrderCapacity();
      if (activated.status !== "RECONCILING") activated.status = "ACTIVE";
      activated.updatedAt = this.now().toISOString();
    } else {
      this.#assertGoalWorkOrderCapacity();
      const state = clone(input.state!);
      activated = {
        workOrderId: `goal-work-order:${input.goalId}`, goalId: input.goalId,
        worldId: this.#current.worldId, branchId,
        projectId: state.project.id, trancheId: state.tranche.id,
        reservationRef: state.tranche.reservationRef, status: "ACTIVE", state,
        ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
        ...(input.parentLandUse ? { parentLandUse: input.parentLandUse } : {}),
        ...(input.targetPoint ? { targetPoint: clone(input.targetPoint) } : {}),
        ...(input.roadCourse ? { roadCourse: clone(input.roadCourse) } : {}),
        ...(input.completionStage ? { completionStage: input.completionStage } : {}),
        updatedAt: this.now().toISOString(),
      };
      workOrders.push(activated);
    }
    // Being displaced releases the planning reservation. The record, its state
    // and its journal stay durable history 鈥?what ends is this Goal's claim on
    // the land, because the Goal that displaced it is now the one being pursued.
    // A Goal that comes back from a later WorldState goes through admission for a
    // new, legitimate reservation; the old scope is never revived.
    for (const item of workOrders) {
      if (item === activated || item.status !== "ACTIVE") continue;
      item.status = "SUSPENDED";
      this.#releaseReservationIfReconciled(item);
    }
    if (activated.status !== "RECONCILING") activated.status = "ACTIVE";
    this.#state.activeGoalWorkOrderId = activated.workOrderId;
    this.#state.projectState = clone(activated.state);
    this.#trimAndSave();
    return clone(activated.state);
  }

  executionBranchId(): string | null {
    return this.#state.executionBranch?.branchId ?? null;
  }

  completeGoalWorkOrder(goalId: string): V2GoalWorkOrderRecord {
    this.#assertStoreHealthy();
    const record = this.#state.goalWorkOrders?.find((item) => item.goalId === goalId);
    if (!record) throw new Error("GOAL_WORK_ORDER_NOT_FOUND");
    if (record.status !== "ACTIVE" || this.#state.activeGoalWorkOrderId !== record.workOrderId) {
      throw new Error("GOAL_WORK_ORDER_COMPLETION_NOT_ACTIVE");
    }
    if (record.state.project.status !== "COMPLETE" && record.state.tranche.stage !== (record.completionStage ?? "OCCUPIED")) {
      throw new Error("GOAL_WORK_ORDER_COMPLETION_MILESTONE_NOT_OBSERVED");
    }
    if (this.#goalWorkOrderHasUnresolvedCommands(record.state)) {
      throw new Error("GOAL_WORK_ORDER_COMPLETION_REQUIRES_COMMAND_RECONCILIATION");
    }
    record.status = "COMPLETE";
    record.updatedAt = this.now().toISOString();
    this.#state.activeGoalWorkOrderId = null;
    this.#trimAndSave();
    return clone(record);
  }

  saveProjectState(projectState: Gate1State): void {
    this.#assertStoreHealthy();
    if (!this.#current || !this.#state.active || this.#blockedReason) {
      throw new Error(this.#blockedReason ?? "cannot persist Gate 1 state without an active world identity");
    }
    if (this.#state.executionBranch?.executionReady === false) throw new Error("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    if (!validProjectState(objectRecord(projectState))) throw new Error("malformed Gate 1 project state; fail closed");
    if (projectState.predecessorCompletionId) {
      const predecessor = (this.#state.completedProjects ?? []).find(
        (entry) => entry.completionId === projectState.predecessorCompletionId,
      );
      if (!predecessor) throw new Error("next project references an unknown completion handoff");
      if (predecessor.handoffStatus === "CONSUMED" && predecessor.nextDecisionId !== projectState.intent.id) {
        throw new Error("completion handoff was already consumed by a different decision");
      }
      predecessor.handoffStatus = "CONSUMED";
      predecessor.nextDecisionId = projectState.intent.id;
      predecessor.handedOffAt = this.now().toISOString();
    }
    if (projectState.completion) {
      const completion = projectState.completion;
      const completed = this.#state.completedProjects ?? (this.#state.completedProjects = []);
      const record: V2CompletedProjectRecord = {
        completionId: completion.completionId,
        projectId: projectState.project.id,
        intentId: projectState.intent.id,
        districtId: projectState.district.id,
        completedAt: completion.completedAt,
        terminalOutcomeId: completion.terminalOutcomeId,
        releasedReservationRefs: clone(completion.releasedReservationRefs),
        handoffStatus: completion.handoffStatus,
        nextDecisionId: completion.nextDecisionId,
        handedOffAt: completion.handedOffAt,
      };
      const existing = completed.findIndex((entry) => entry.completionId === completion.completionId);
      if (existing < 0) completed.push(record);
      else completed[existing] = record;
    }
    const activeWorkOrder = this.#state.goalWorkOrders?.find((item) => item.workOrderId === this.#state.activeGoalWorkOrderId);
    if (activeWorkOrder) {
      if (activeWorkOrder.projectId !== projectState.project.id || activeWorkOrder.trancheId !== projectState.tranche.id ||
        activeWorkOrder.reservationRef !== projectState.tranche.reservationRef) {
        throw new Error("GOAL_WORK_ORDER_ACTIVE_SCOPE_CHANGED");
      }
    }
    this.#state.projectState = clone(projectState);
    if (activeWorkOrder) {
      activeWorkOrder.state = clone(projectState);
      activeWorkOrder.status = this.#lifecycleForGate1State(projectState, activeWorkOrder.status);
      if (activeWorkOrder.status !== "RECONCILING") activeWorkOrder.reconciliationReason = null;
      activeWorkOrder.updatedAt = this.now().toISOString();
    }
    this.#trimAndSave();
  }

  /**
   * Record that a durable project's admission no longer holds.
   *
   * Append-only and non-destructive: the project's own state is copied into the
   * record and otherwise left alone, and nothing in the journal or the
   * checkpoints is touched.
   *
   * Two refusals, and together they are what bounds replacement. Superseding the
   * same project twice would be a second claim that one admission is invalid,
   * which is not a thing. Superseding a project that was itself a replacement
   * would make the chain unbounded 鈥?supersede, replace, supersede the
   * replacement, forever 鈥?which is identity re-minting by another name. So the
   * lineage is at most two projects deep, and there is no counter to increment.
   */
  recordProjectSupersession(input: {
    supersessionId: string;
    projectId: string;
    intentId: string;
    trancheId: string;
    reservationRef: string;
    supersededState: Gate1State;
    reason: V2ProjectSupersessionReason;
    branch?: V2ProjectBranchIdentity;
    replanId?: string;
    detail: string;
  }): V2SupersededProjectRecord {
    this.#assertStoreHealthy();
    const existing = this.#state.supersededProjects ?? (this.#state.supersededProjects = []);
    if (input.reason === "CURRENT_BRANCH_REPLAN") {
      if (!input.branch || !nonEmpty(input.replanId) || !nonEmpty(input.branch.worldId) || !nonEmpty(input.branch.checkpointId) ||
        !Number.isInteger(input.branch.journalCut) || input.branch.journalCut < 0) {
        throw new Error("current-branch replan identity is incomplete");
      }
      if (existing.some((entry) => entry.reason === "CURRENT_BRANCH_REPLAN" && entry.replanId === input.replanId)) {
        throw new Error("current-branch replan identity is already recorded");
      }
    } else {
      if (input.branch !== undefined || input.replanId !== undefined) throw new Error("admission supersession cannot carry branch identity");
      if (existing.some((entry) => entry.projectId === input.projectId)) {
        throw new Error("project is already superseded");
      }
      if (existing.some((entry) => entry.replacementProjectId === input.projectId)) {
        throw new Error("a replacement project cannot itself be superseded");
      }
    }
    if (existing.some((entry) => entry.supersessionId === input.supersessionId)) {
      throw new Error("supersession id is already recorded");
    }
    if (!validProjectState(objectRecord(input.supersededState))) {
      throw new Error("malformed Gate 1 project state; fail closed");
    }
    const record: V2SupersededProjectRecord = {
      schemaVersion: V2_SUPERSEDED_PROJECT_SCHEMA_VERSION,
      supersessionId: input.supersessionId,
      projectId: input.projectId,
      intentId: input.intentId,
      trancheId: input.trancheId,
      reservationRef: input.reservationRef,
      supersededState: clone(input.supersededState),
      reason: input.reason,
      ...(input.branch ? { branch: clone(input.branch) } : {}),
      ...(input.replanId ? { replanId: input.replanId } : {}),
      detail: input.detail,
      replacementProjectId: null,
      supersededAt: this.now().toISOString(),
    };
    existing.push(record);
    this.#trimAndSave();
    return clone(record);
  }

  /**
   * Name the project admitted to replace a superseded one. Spends the
   * supersession: a second call, or a second replacement for the same
   * supersession, is refused.
   */
  linkProjectSupersessionReplacement(supersessionId: string, replacementProjectId: string): V2SupersededProjectRecord {
    this.#assertStoreHealthy();
    const record = (this.#state.supersededProjects ?? []).find((entry) => entry.supersessionId === supersessionId);
    if (!record) throw new Error("unknown supersession");
    if (record.replacementProjectId !== null) {
      if (record.replacementProjectId === replacementProjectId) return clone(record);
      throw new Error("supersession already names a replacement");
    }
    record.replacementProjectId = replacementProjectId;
    this.#trimAndSave();
    return clone(record);
  }

  supersededProjects(): V2SupersededProjectRecord[] {
    this.#assertStoreHealthy();
    return clone(this.#state.supersededProjects ?? []);
  }

  /**
   * Append the one admission-semantics repair a `(root, revision)` pair may
   * receive.
   *
   * The bound is enforced twice, and deliberately not by trusting the caller's
   * id derivation: once on `repairId`, and once on the `(rootProjectId,
   * semanticsRevision)` pair the id is supposed to be a function of. A caller
   * that computed a different id for the same pair would still be refused, so
   * the identity rule is a property of the store rather than a convention the
   * caller is trusted to keep.
   *
   * Nothing about the replaced project is modified here. Its state is copied
   * into the record and its supersession history is left exactly as recorded;
   * what this adds is the one fact those records cannot carry 鈥?that the
   * admission was correct for the semantics of its time and the semantics have
   * since changed.
   */
  recordAdmissionSemanticRepair(input: {
    repairId: string;
    rootProjectId: string;
    rootIntentId: string;
    rootTrancheId: string;
    rootReservationRef: string;
    replacedProjectId: string;
    replacedIntentId: string;
    replacedTrancheId: string;
    replacedReservationRef: string;
    supersessionIds: string[];
    semanticsRevision: string;
    replacedState: Gate1State;
    detail: string;
  }): V2AdmissionSemanticRepairRecord {
    this.#assertStoreHealthy();
    const existing = this.#state.admissionSemanticRepairs ?? (this.#state.admissionSemanticRepairs = []);
    if (existing.some((entry) => entry.repairId === input.repairId)) {
      throw new Error("admission semantic repair is already recorded");
    }
    if (
      existing.some(
        (entry) => entry.rootProjectId === input.rootProjectId && entry.semanticsRevision === input.semanticsRevision,
      )
    ) {
      throw new Error("root project already has a repair for this admission semantics revision");
    }
    if (existing.some((entry) => entry.replacedProjectId === input.replacedProjectId)) {
      throw new Error("project is already replaced by an admission semantic repair");
    }
    if (!validProjectState(objectRecord(input.replacedState))) {
      throw new Error("malformed Gate 1 project state; fail closed");
    }
    const record: V2AdmissionSemanticRepairRecord = {
      schemaVersion: V2_ADMISSION_SEMANTIC_REPAIR_SCHEMA_VERSION,
      repairId: input.repairId,
      rootProjectId: input.rootProjectId,
      rootIntentId: input.rootIntentId,
      rootTrancheId: input.rootTrancheId,
      rootReservationRef: input.rootReservationRef,
      replacedProjectId: input.replacedProjectId,
      replacedIntentId: input.replacedIntentId,
      replacedTrancheId: input.replacedTrancheId,
      replacedReservationRef: input.replacedReservationRef,
      supersessionIds: [...input.supersessionIds],
      semanticsRevision: input.semanticsRevision,
      reason: ADMISSION_SEMANTIC_REPAIR_REASON,
      detail: input.detail,
      replacedState: clone(input.replacedState),
      repairProjectId: null,
      repairedAt: this.now().toISOString(),
    };
    existing.push(record);
    this.#trimAndSave();
    return clone(record);
  }

  /**
   * Name the project a repair admitted. Spends the repair: a second call, or a
   * second repair project for the same repair, is refused.
   */
  linkAdmissionSemanticRepairProject(repairId: string, repairProjectId: string): V2AdmissionSemanticRepairRecord {
    this.#assertStoreHealthy();
    const record = (this.#state.admissionSemanticRepairs ?? []).find((entry) => entry.repairId === repairId);
    if (!record) throw new Error("unknown admission semantic repair");
    if (record.repairProjectId !== null) throw new Error("admission semantic repair already names a project");
    record.repairProjectId = repairProjectId;
    this.#trimAndSave();
    return clone(record);
  }

  admissionSemanticRepairs(): V2AdmissionSemanticRepairRecord[] {
    this.#assertStoreHealthy();
    return clone(this.#state.admissionSemanticRepairs ?? []);
  }

  /**
   * Append one budget amendment, of which a project may receive at most one per
   * reason.
   *
   * That is the whole bound: there is no counter and no fourth reason. A project
   * that needs a second widening of the same reason is a project whose plan
   * changed, and a changed plan is an admission question, not a budget one.
   * The admitted budget is copied into the record rather than read from it, so
   * the amendment stands on its own as evidence of what it corrected.
   */
  recordUtilityBudgetAmendment(input: {
    amendmentId: string;
    state: Gate1State;
    originalProjectBudget: number;
    requiredUtilityBudget: number;
    amendedEffectiveBudget: number;
    reason?:
      | typeof UTILITY_BUDGET_AMENDMENT_REASON
      | typeof UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
      | typeof FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON;
    connectionAllowance?: number;
    actualConnectionQuote?: number;
    status?: "ACTIVE" | "SUPERSEDED_UNUSED";
    planRevision?: string;
    courseFingerprint?: string;
    supersedesAmendmentId?: string | null;
    nativeQuote?: number;
    segmentQuotes?: number[];
    roadPrefab?: string;
    purpose?: string;
    authorizationWorldId?: string;
    authorizationCheckpointId?: string | null;
    authorizationGeneration?: string;
    executionUseLimit?: 1;
    executionUseStatus?: "UNUSED" | "CONSUMED";
    repairLineage?: string;
    repairAttemptIndex?: number;
    detail: string;
  }): V2UtilityBudgetAmendmentRecord {
    this.#assertStoreHealthy();
    const reason = input.reason ?? UTILITY_BUDGET_AMENDMENT_REASON;
    const existing = this.#state.utilityBudgetAmendments ?? (this.#state.utilityBudgetAmendments = []);
    // One per (project, reason), for each of exactly three reasons. Each answers a
    // different question 鈥?"what does this project's plan cost", "what does the
    // course it will actually submit cost", and "what does the road repair the
    // world actually needs cost" 鈥?and a project may legitimately have needed all
    // three, but never twice for the same one. There is no counter and no fourth
    // reason: a project that needs a second widening of any of them is a project
    // whose plan changed, and a changed plan is an admission question.
    if (existing.some((entry) => entry.projectId === input.state.project.id && entry.reason === reason &&
      !(reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON && entry.status !== "ACTIVE"))) {
      throw new Error(
        reason === UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
          ? "project connection budget is already amended"
          : reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON
            ? "project access road budget is already amended"
            : "project budget is already amended",
      );
    }
    if (existing.some((entry) => entry.amendmentId === input.amendmentId)) {
      throw new Error("amendment id is already recorded");
    }
    if (
      !nonNegativeFinite(input.originalProjectBudget) ||
      !nonNegativeFinite(input.requiredUtilityBudget) ||
      !nonNegativeFinite(input.amendedEffectiveBudget)
    ) {
      throw new Error("malformed utility budget amendment figures; fail closed");
    }
    if (input.amendedEffectiveBudget !== input.requiredUtilityBudget) {
      throw new Error("a budget amendment may only authorize the minimum feasible spend");
    }
    // The figure the amendment raises FROM must be the effective budget at the
    // moment it is recorded 鈥?the admitted budget, or a prior amendment's figure
    // when one already raised it. Anything else is an amendment whose delta
    // describes a budget that never existed.
    const effectiveBefore = existing
      .filter((entry) => entry.projectId === input.state.project.id &&
        !(entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON && entry.status === "SUPERSEDED_UNUSED"))
      .reduce((maximum, entry) => Math.max(maximum, entry.amendedEffectiveBudget), input.state.project.maximumBudget);
    if (input.originalProjectBudget !== effectiveBefore) {
      throw new Error("budget amendment does not match the effective project budget");
    }
    if (reason === UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON) {
      // The delta this record authorizes has exactly one justification: the
      // native contract prices the course the execution will submit higher than
      // the admission's allowance covered. Checked arithmetically so a record
      // cannot claim a raise its own two figures do not support.
      if (!nonNegativeFinite(input.connectionAllowance) || !nonNegativeFinite(input.actualConnectionQuote)) {
        throw new Error("connection budget amendment is missing its connection figures; fail closed");
      }
      if (input.actualConnectionQuote - input.connectionAllowance !== input.amendedEffectiveBudget - input.originalProjectBudget) {
        throw new Error("connection budget amendment delta does not match the connection quote");
      }
    }
    const record: V2UtilityBudgetAmendmentRecord = {
      schemaVersion: V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION,
      amendmentId: input.amendmentId,
      projectId: input.state.project.id,
      intentId: input.state.intent.id,
      trancheId: input.state.tranche.id,
      reservationRef: input.state.tranche.reservationRef,
      originalProjectBudget: input.originalProjectBudget,
      requiredUtilityBudget: input.requiredUtilityBudget,
      amendedEffectiveBudget: input.amendedEffectiveBudget,
      reason,
      ...(reason === UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
        ? { connectionAllowance: input.connectionAllowance, actualConnectionQuote: input.actualConnectionQuote }
        : {}),
      detail: input.detail,
      amendedAt: this.now().toISOString(),
      ...(input.status ? { status: input.status } : {}),
      ...(input.planRevision ? { planRevision: input.planRevision } : {}),
      ...(input.courseFingerprint ? { courseFingerprint: input.courseFingerprint } : {}),
      ...(input.supersedesAmendmentId !== undefined ? { supersedesAmendmentId: input.supersedesAmendmentId } : {}),
      ...(input.nativeQuote !== undefined ? { nativeQuote: input.nativeQuote } : {}),
      ...(input.segmentQuotes !== undefined ? { segmentQuotes: [...input.segmentQuotes] } : {}),
      ...(input.roadPrefab !== undefined ? { roadPrefab: input.roadPrefab } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.authorizationWorldId !== undefined ? { authorizationWorldId: input.authorizationWorldId } : {}),
      ...(input.authorizationCheckpointId !== undefined ? { authorizationCheckpointId: input.authorizationCheckpointId } : {}),
      ...(input.authorizationGeneration !== undefined ? { authorizationGeneration: input.authorizationGeneration } : {}),
      ...(input.executionUseLimit !== undefined ? { executionUseLimit: input.executionUseLimit } : {}),
      ...(input.executionUseStatus !== undefined ? { executionUseStatus: input.executionUseStatus } : {}),
      ...(input.repairLineage !== undefined ? { repairLineage: input.repairLineage } : {}),
      ...(input.repairAttemptIndex !== undefined ? { repairAttemptIndex: input.repairAttemptIndex } : {}),
    };
    existing.push(record);
    this.#trimAndSave();
    return clone(record);
  }

  recordUtilityServiceRoadChildOperation(input: {
    state: Gate1State;
    planRevision: string;
    courseFingerprint: string;
    exactRoadInput: RoadGeometryInput;
    authorizationWorldId: string;
    authorizationCheckpointId: string | null;
    authorizationGeneration: string;
    detail: string;
  }): V2UtilityBudgetAmendmentRecord {
    this.#assertStoreHealthy();
    const active = this.#state.active;
    const current = this.#current;
    if (!active || !current || this.#blockedReason) throw new Error(this.#blockedReason ?? "UTILITY_SERVICE_ROAD_CHILD_WORLD_NOT_ACTIVE");
    if (input.state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION || input.state.project.status !== "ACTIVE" ||
      this.#state.projectState.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION ||
      this.#state.projectState.project.id !== input.state.project.id ||
      this.#state.projectState.tranche.id !== input.state.tranche.id ||
      input.state.tranche.projectId !== input.state.project.id ||
      this.#state.projectState.tranche.reservationRef !== input.state.tranche.reservationRef ||
      input.state.tranche.reservationRef !== input.state.district.reservationRef) {
      throw new Error("UTILITY_SERVICE_ROAD_CHILD_PROJECT_BINDING_MISMATCH");
    }
    if (!input.planRevision.trim() || !input.courseFingerprint.trim() || !input.detail.trim() ||
      !isValidUtilityServiceRoadInput(input.exactRoadInput) ||
      stableRoadInput(input.exactRoadInput) !== input.courseFingerprint) {
      throw new Error("UTILITY_SERVICE_ROAD_CHILD_EXACT_INPUT_INVALID");
    }
    // The child names the branch it was planned for by the branch's own
    // checkpoint identity — its rollback boundary — and this proves that is the
    // branch running right now: the boundary checkpoint exists and is durable at
    // the journal cut, the activation anchored to it, and the live world and
    // generation are still this store's. `loadedCheckpointId` is not consulted:
    // it records where the branch was loaded from, and a city started fresh was
    // loaded from nothing while its baseline boundary is fully certified.
    const branch = this.currentBranchCheckpoint();
    if (!input.authorizationCheckpointId || !branch ||
      branch.checkpointId !== input.authorizationCheckpointId ||
      branch.worldId !== input.authorizationWorldId || branch.generation !== input.authorizationGeneration) {
      throw new Error("UTILITY_SERVICE_ROAD_CHILD_WORLD_BINDING_MISMATCH");
    }
    const amendmentId = [UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON, input.state.project.id,
      input.state.tranche.id, input.planRevision, input.courseFingerprint].map(encodeURIComponent).join(":");
    const amendments = this.#state.utilityBudgetAmendments ?? (this.#state.utilityBudgetAmendments = []);
    const prior = amendments.find((entry) => entry.amendmentId === amendmentId);
    if (prior) {
      if (prior.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON ||
        prior.projectId !== input.state.project.id || prior.trancheId !== input.state.tranche.id ||
        prior.planRevision !== input.planRevision || prior.courseFingerprint !== input.courseFingerprint ||
        prior.authorizationWorldId !== input.authorizationWorldId ||
        prior.authorizationCheckpointId !== input.authorizationCheckpointId ||
        prior.authorizationGeneration !== input.authorizationGeneration ||
        JSON.stringify(prior.exactRoadInput) !== JSON.stringify(input.exactRoadInput)) {
        throw new Error("UTILITY_SERVICE_ROAD_CHILD_IDENTITY_CONFLICT");
      }
      return clone(prior);
    }
    const record: V2UtilityBudgetAmendmentRecord = {
      schemaVersion: V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION,
      amendmentId,
      projectId: input.state.project.id,
      intentId: input.state.intent.id,
      trancheId: input.state.tranche.id,
      reservationRef: input.state.tranche.reservationRef,
      originalProjectBudget: input.state.project.maximumBudget,
      requiredUtilityBudget: input.state.project.maximumBudget,
      amendedEffectiveBudget: input.state.project.maximumBudget,
      reason: UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON,
      detail: input.detail,
      amendedAt: this.now().toISOString(),
      status: "ACTIVE",
      planRevision: input.planRevision,
      courseFingerprint: input.courseFingerprint,
      exactRoadInput: clone(input.exactRoadInput),
      authorizationWorldId: input.authorizationWorldId,
      authorizationCheckpointId: input.authorizationCheckpointId,
      authorizationGeneration: input.authorizationGeneration,
      executionUseLimit: 1,
      executionUseStatus: "UNUSED",
    };
    amendments.push(record);
    this.#trimAndSave();
    return clone(record);
  }

  consumeUtilityServiceRoadChildOperation(amendmentId: string, courseFingerprint: string): V2UtilityBudgetAmendmentRecord {
    this.#assertStoreHealthy();
    const amendment = (this.#state.utilityBudgetAmendments ?? []).find((entry) => entry.amendmentId === amendmentId);
    if (!amendment || amendment.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON ||
      amendment.courseFingerprint !== courseFingerprint || !amendment.exactRoadInput ||
      stableRoadInput(amendment.exactRoadInput) !== courseFingerprint) {
      throw new Error("UTILITY_SERVICE_ROAD_CHILD_OPERATION_BINDING_MISMATCH");
    }
    if (amendment.status !== "ACTIVE" || amendment.executionUseLimit !== 1 || amendment.executionUseStatus !== "UNUSED") {
      throw new Error("UTILITY_SERVICE_ROAD_CHILD_OPERATION_ALREADY_CONSUMED");
    }
    // Consumed against the branch's own checkpoint identity, the same one the
    // record was minted with, so a fresh city's baseline boundary is as good a
    // binding as a loaded save's. A boundary that has moved — a reload, a
    // rollback, a different generation — answers null and the operation is
    // stale rather than replayed onto land it was not planned for.
    const branch = this.currentBranchCheckpoint();
    if (!branch || amendment.authorizationWorldId !== branch.worldId ||
      amendment.authorizationCheckpointId !== branch.checkpointId ||
      amendment.authorizationGeneration !== branch.generation) {
      throw new Error("UTILITY_SERVICE_ROAD_CHILD_OPERATION_STALE_WORLD");
    }
    amendment.status = "CONSUMED";
    amendment.executionUseStatus = "CONSUMED";
    this.#trimAndSave();
    return clone(amendment);
  }

  /** Atomically records the one bounded planner-input successor, its exact child and the current-task handoff. */
  isRoadPlannerInputReplacementEligible(state: Gate1State, taskId: string): boolean {
    this.#assertStoreHealthy();
    const latest = validateState(this.storage.load());
    this.#state = latest;
    const projectState = latest.projectState;
    if (projectState.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) return false;
    const durable = projectState;
    // The branch this replacement would be minted against, read the same way
    // every exact-operation binding reads it. There is no replacement to make on
    // a branch that cannot be proven, and the reason is the same one.
    if (!this.currentBranchCheckpoint()) return false;
    const task = durable.tasks.find((candidate) => candidate.id === taskId && candidate.kind === "ROAD_CONNECTION");
    const currentTaskId = durable.tranche.currentTaskIds?.ROAD_CONNECTION ??
      durable.tasks.find((candidate) => candidate.trancheId === durable.tranche.id && candidate.kind === "ROAD_CONNECTION")?.id;
    if (!task || currentTaskId !== task.id || task.trancheId !== durable.tranche.id ||
      !["BLOCKED", "FAILED"].includes(task.status) || !task.terminalOutcomeId ||
      state.project.id !== durable.project.id || state.tranche.id !== durable.tranche.id ||
      ["OCCUPIED", "COMPLETE"].includes(durable.project.status) || durable.intent.status === "SATISFIED" || durable.completion ||
      durable.tranche.stage !== "SITE_SELECTED" || task.activeCommandId != null) return false;
    const ownedCommands = this.#state.commands.filter((entry) =>
      entry.record.authorizedScope.owner.ownerType === "TASK" && entry.record.authorizedScope.owner.ownerId === task.id);
    if (ownedCommands.length > 0) return false;
    const childIds = [...new Set([task.childOperationAmendmentId, ...(task.childOperationAmendmentIds ?? [])].filter((id): id is string => !!id))];
    const children = childIds.map((id) => this.#state.utilityBudgetAmendments?.find((entry) => entry.amendmentId === id));
    if (children.some((child) => !child || child.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON ||
      (child.ownerTaskId && child.ownerTaskId !== task.id) ||
      !((child.status === "ACTIVE" && child.executionUseStatus === "UNUSED") ||
        (child.status === "CONSUMED" && child.executionUseStatus === "CONSUMED") ||
        (child.status === "SUPERSEDED_UNUSED" && child.executionUseStatus === "UNUSED")))) return false;
    const preApply = roadPreApplyFailureEvidenceForTask(durable, task.id);
    const unused = children.filter((child) => child?.status === "ACTIVE" && child.executionUseStatus === "UNUSED");
    if (!preApply || childIds.length > 1 ||
      (childIds.length === 0 ? preApply.childId !== null :
        preApply.childId !== childIds[0] || JSON.stringify(children[0]?.exactRoadInput) !== JSON.stringify(preApply.exactInput)) ||
      (unused.length > 0 && (unused.length !== children.length || unused.some((child) =>
        child!.amendmentId !== preApply.childId || JSON.stringify(child!.exactRoadInput) !== JSON.stringify(preApply.exactInput))))) return false;
    return true;
  }

  ensurePlannerInputReplacement(input: {
    state: Gate1State;
    expectedCurrentTaskId: string;
    objectiveId: string;
    planRevision: string;
    exactRoadInput: RoadGeometryInput;
    authorizationWorldId: string;
    authorizationCheckpointId: string;
    authorizationGeneration: string;
    activeBranchIdentity: string;
    trigger: "PLANNER_INPUT_CHANGED";
    worldEffect: "ABSENT" | "PARTIAL" | "COMPLETE" | "UNKNOWN";
    correctedInputAvoidsExistingEffects: boolean;
    targetEntityAuthoritative: boolean;
  }): { state: Gate1State; task: Gate1State["tasks"][number]; child: V2UtilityBudgetAmendmentRecord; replacementKey: string; reused: boolean } {
    this.#assertStoreHealthy();
    // Refresh immediately before the synchronous compare-and-set. Independent
    // runners sharing the durable store then observe the first committed key.
    const latest = validateState(this.storage.load());
    this.#state = latest;
    const durable = this.#state.projectState;
    // The same branch proof the child operation itself is bound with, and the
    // same branch identity in the replacement key: a replacement minted against
    // a boundary that has since moved must not be reused on the new one.
    const branch = this.currentBranchCheckpoint();
    if (!branch || !input.authorizationCheckpointId ||
      branch.checkpointId !== input.authorizationCheckpointId ||
      branch.worldId !== input.authorizationWorldId || branch.generation !== input.authorizationGeneration ||
      input.activeBranchIdentity !== `${branch.worldId}|${branch.checkpointId}|${branch.journalCut}`) {
      throw new Error("PLANNER_INPUT_REPLACEMENT_ACTIVE_BRANCH_STALE");
    }
    if (durable.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("PLANNER_INPUT_REPLACEMENT_OBJECTIVE_NOT_ELIGIBLE");
    if (input.trigger !== "PLANNER_INPUT_CHANGED" || !input.targetEntityAuthoritative || !input.objectiveId.trim() ||
      input.objectiveId !== `${durable.project.id}:${durable.tranche.id}:ROAD_CONNECTION` ||
      !input.planRevision.trim() || !isValidUtilityServiceRoadInput(input.exactRoadInput) ||
      durable.project.id !== input.state.project.id ||
      durable.tranche.id !== input.state.tranche.id || ["OCCUPIED", "COMPLETE"].includes(durable.project.status) ||
      input.state.intent.status === "SATISFIED" || input.state.completion || input.state.tranche.stage !== "SITE_SELECTED") {
      throw new Error("PLANNER_INPUT_REPLACEMENT_OBJECTIVE_NOT_ELIGIBLE");
    }
    const exactRoadInput = clone(input.exactRoadInput);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
      value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const immutableExactInputHash = hash(stableRoadInput(exactRoadInput));
    const canonicalMaterialInput = JSON.stringify(canonical({ actionFamily: "ROAD", ...exactRoadInput }));
    const materialInputHash = hash(canonicalMaterialInput);
    const replacementKey = hash(JSON.stringify([
      "planner-input-replacement/1", input.activeBranchIdentity, durable.project.id, input.objectiveId,
      "ROAD_CONNECTION", materialInputHash,
    ]));
    const currentTaskId = durable.tranche.currentTaskIds?.ROAD_CONNECTION ??
      durable.tasks.find((candidate) => candidate.trancheId === durable.tranche.id && candidate.kind === "ROAD_CONNECTION")?.id;
    if (!currentTaskId) throw new Error("PLANNER_INPUT_REPLACEMENT_CURRENT_TASK_MISSING");

    // Re-entry returns the durable winner before checking the one-use budget.
    const existingSuccessor = durable.tasks.find((candidate) => candidate.replacementKey === replacementKey);
    if (existingSuccessor) {
      const child = existingSuccessor.childOperationAmendmentId && this.#state.utilityBudgetAmendments?.find((entry) =>
        entry.amendmentId === existingSuccessor.childOperationAmendmentId);
      if (!child || JSON.stringify(child.exactRoadInput) !== JSON.stringify(exactRoadInput) ||
        existingSuccessor.supersedesTaskId !== input.expectedCurrentTaskId) throw new Error("PLANNER_INPUT_REPLACEMENT_DURABLE_WINNER_CONFLICT");
      return { state: clone(durable), task: clone(existingSuccessor), child: clone(child), replacementKey, reused: true };
    }
    const sameObjective = durable.tasks.filter((candidate) => candidate.objectiveId === input.objectiveId &&
      candidate.activeBranchIdentity === input.activeBranchIdentity && candidate.supersessionReason === "PLANNER_INPUT_CHANGED");
    if (sameObjective.length > 0) throw new Error("PLANNER_INPUT_REPLACEMENT_BUDGET_EXHAUSTED");
    if (currentTaskId !== input.expectedCurrentTaskId) throw new Error("PLANNER_INPUT_REPLACEMENT_STALE_PREDECESSOR");
    const predecessor = durable.tasks.find((candidate) => candidate.id === currentTaskId && candidate.kind === "ROAD_CONNECTION");
    if (!predecessor || !["BLOCKED", "FAILED"].includes(predecessor.status) || !predecessor.terminalOutcomeId)
      throw new Error("PLANNER_INPUT_REPLACEMENT_PREDECESSOR_NOT_TERMINAL");
    const oldChildIds = [...new Set([predecessor.childOperationAmendmentId, ...(predecessor.childOperationAmendmentIds ?? [])]
      .filter((id): id is string => !!id))];
    const oldChildren = oldChildIds.map((id) => this.#state.utilityBudgetAmendments?.find((entry) => entry.amendmentId === id));
    if (oldChildren.some((child) => !child || child.reason !== UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON ||
      (child.ownerTaskId && child.ownerTaskId !== predecessor.id) ||
      !((child.status === "ACTIVE" && child.executionUseStatus === "UNUSED") ||
        (child.status === "CONSUMED" && child.executionUseStatus === "CONSUMED") ||
        (child.status === "SUPERSEDED_UNUSED" && child.executionUseStatus === "UNUSED"))))
      throw new Error("PLANNER_INPUT_REPLACEMENT_OLD_CHILD_INVALID");
    const preApplyEvidence = roadPreApplyFailureEvidenceForTask(durable, predecessor.id);
    const executableOldChildren = oldChildren.filter((child) => child?.status === "ACTIVE" && child.executionUseStatus === "UNUSED");
    if (!preApplyEvidence || oldChildIds.length > 1 ||
      (oldChildIds.length === 0 ? preApplyEvidence.childId !== null :
        preApplyEvidence.childId !== oldChildIds[0] || JSON.stringify(oldChildren[0]?.exactRoadInput) !== JSON.stringify(preApplyEvidence.exactInput)) ||
      (executableOldChildren.length > 0 && (executableOldChildren.length !== oldChildren.length ||
        executableOldChildren.some((child) => child!.amendmentId !== preApplyEvidence.childId ||
          JSON.stringify(child!.exactRoadInput) !== JSON.stringify(preApplyEvidence.exactInput))))) {
      throw new Error("PLANNER_INPUT_REPLACEMENT_OLD_CHILD_STILL_EXECUTABLE");
    }
    const oldInput = oldChildren[0]?.exactRoadInput ?? preApplyEvidence?.exactInput;
    if (!oldInput) throw new Error("PLANNER_INPUT_REPLACEMENT_OLD_EXACT_INPUT_MISSING");
    const oldMaterialHash = hash(JSON.stringify(canonical({ actionFamily: "ROAD", ...oldInput })));
    if (oldMaterialHash === materialInputHash) throw new Error("PLANNER_INPUT_REPLACEMENT_INPUT_NOT_MATERIALLY_CHANGED");
    if (input.worldEffect === "COMPLETE") throw new Error("PLANNER_INPUT_REPLACEMENT_EXISTING_EFFECT_RECONCILIATION_REQUIRED");
    if (input.worldEffect === "UNKNOWN") throw new Error("PLANNER_INPUT_REPLACEMENT_WORLD_EFFECT_UNKNOWN");
    if (input.worldEffect === "PARTIAL" && !input.correctedInputAvoidsExistingEffects) {
      throw new Error("PLANNER_INPUT_REPLACEMENT_PARTIAL_EFFECT_DUPLICATE_RISK");
    }
    const predecessorCommands = this.#state.commands.filter((entry) => entry.record.authorizedScope.owner.ownerType === "TASK" &&
      entry.record.authorizedScope.owner.ownerId === predecessor.id);
    if (predecessorCommands.length > 0) throw new Error("PLANNER_INPUT_REPLACEMENT_PREDECESSOR_COMMAND_EVIDENCE_CONFLICT");
    if (input.state.tranche.currentTaskIds?.ROAD_CONNECTION &&
      input.state.tranche.currentTaskIds.ROAD_CONNECTION !== predecessor.id) throw new Error("PLANNER_INPUT_REPLACEMENT_STALE_TASK_REFERENCE");

    const newTaskId = `gate1-task-successor:${hash(`${replacementKey}|task`)}`;
    const childId = `gate1-road-child:${hash(`${newTaskId}|road-child`)}`;
    const courseFingerprint = stableRoadInput(exactRoadInput);
    const amendments = this.#state.utilityBudgetAmendments ?? (this.#state.utilityBudgetAmendments = []);
    const previousAmendments = clone(amendments);
    if (amendments.some((entry) => entry.amendmentId === childId || entry.replacementKey === replacementKey)) {
      throw new Error("PLANNER_INPUT_REPLACEMENT_CHILD_IDENTITY_CONFLICT");
    }
    const next = clone(durable);
    const successor = {
      id: newTaskId,
      trancheId: next.tranche.id,
      kind: "ROAD_CONNECTION" as const,
      legalStage: predecessor.legalStage,
      status: "PENDING" as const,
      attempts: 0,
      maximumAttempts: predecessor.maximumAttempts,
      terminalOutcomeId: null,
      childOperationAmendmentId: childId,
      supersedesTaskId: predecessor.id,
      supersessionReason: "PLANNER_INPUT_CHANGED" as const,
      previousExactInputHash: hash(stableRoadInput(oldInput)),
      newExactInputHash: immutableExactInputHash,
      newMaterialInputHash: materialInputHash,
      replacementKey,
      activeBranchIdentity: input.activeBranchIdentity,
      objectiveId: input.objectiveId,
    };
    next.tasks.push(successor);
    next.tranche.taskIds.push(successor.id);
    next.tranche.currentTaskIds = { ...next.tranche.currentTaskIds, ROAD_CONNECTION: successor.id };
    const otherTaskBlocker = next.tasks.some((task) => task.id !== predecessor.id && ["BLOCKED", "FAILED"].includes(task.status));
    const unsafeCurrentTask = Object.entries(next.tranche.currentTaskIds ?? {})
      .filter(([kind]) => kind !== "ROAD_CONNECTION")
      .some(([, id]) => {
        const currentTask = next.tasks.find((task) => task.id === id);
        return !currentTask || currentTask.activeCommandId != null || !["PENDING", "SUCCEEDED"].includes(currentTask.status);
      });
    const unresolvedCommand = this.#state.commands.some((entry) => ["CREATED", "AUTHORIZED", "SUBMITTED", "COMMIT_ACK", "NATIVE_COMPLETED",
      "NATIVE_COMPLETION_UNKNOWN", "UNKNOWN_TIMEOUT", "UNKNOWN_TRANSPORT"].includes(entry.record.status) ||
      (entry.record.status === "OBSERVED_MISMATCH" && entry.record.effectAbsenceProven !== true));
    const unknownOtherOutcome = next.journal.some((entry) => entry.taskId !== predecessor.id &&
      (entry.execution === "UNKNOWN" || entry.observedEffect === "UNKNOWN" || entry.failureClassification === "OBSERVATION_UNKNOWN"));
    if (!otherTaskBlocker && !unsafeCurrentTask && !unresolvedCommand && !unknownOtherOutcome) {
      next.project.status = "ACTIVE";
      next.intent.status = "ACTIVE";
    }
    for (const child of executableOldChildren) {
      child!.status = "SUPERSEDED_UNUSED";
    }
    const at = this.now().toISOString();
    const child: V2UtilityBudgetAmendmentRecord = {
      schemaVersion: V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION,
      amendmentId: childId,
      projectId: next.project.id,
      intentId: next.intent.id,
      trancheId: next.tranche.id,
      reservationRef: next.tranche.reservationRef,
      originalProjectBudget: next.project.maximumBudget,
      requiredUtilityBudget: next.project.maximumBudget,
      amendedEffectiveBudget: next.project.maximumBudget,
      reason: UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON,
      detail: `PLANNER_INPUT_CHANGED successor for ${predecessor.id}`,
      amendedAt: at,
      status: "ACTIVE",
      planRevision: input.planRevision,
      courseFingerprint,
      exactRoadInput,
      authorizationWorldId: branch.worldId,
      authorizationCheckpointId: input.authorizationCheckpointId,
      authorizationGeneration: branch.generation,
      executionUseLimit: 1,
      executionUseStatus: "UNUSED",
      ownerTaskId: successor.id,
      replacementKey,
      exactInputHash: immutableExactInputHash,
      materialInputHash,
    };
    amendments.push(child);
    this.#state.projectState = next;
    try {
      this.#trimAndSave();
    } catch (error) {
      this.#state.projectState = durable;
      this.#state.utilityBudgetAmendments = previousAmendments;
      throw error;
    }
    return { state: clone(next), task: clone(successor), child: clone(child), replacementKey, reused: false };
  }

  utilityBudgetAmendments(): V2UtilityBudgetAmendmentRecord[] {
    this.#assertStoreHealthy();
    return clone(this.#state.utilityBudgetAmendments ?? []);
  }

  supersedeUnusedAccessRoadBudgetAmendment(amendmentId: string): V2UtilityBudgetAmendmentRecord {
    this.#assertStoreHealthy();
    const amendment = (this.#state.utilityBudgetAmendments ?? []).find((entry) => entry.amendmentId === amendmentId);
    if (!amendment || amendment.reason !== FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON) {
      throw new Error("FACILITY_ACCESS_ROAD_BUDGET_AMENDMENT_NOT_FOUND");
    }
    amendment.status = "SUPERSEDED_UNUSED";
    this.#trimAndSave();
    return clone(amendment);
  }

  consumeAccessRoadBudgetAmendment(amendmentId: string, courseFingerprint: string): V2UtilityBudgetAmendmentRecord {
    this.#assertStoreHealthy();
    const amendment = (this.#state.utilityBudgetAmendments ?? []).find((entry) => entry.amendmentId === amendmentId);
    if (!amendment || amendment.reason !== FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON || amendment.status !== "ACTIVE" ||
      !(amendment.executionUseLimit === undefined || amendment.executionUseLimit === 1) ||
      !(amendment.executionUseStatus === undefined || amendment.executionUseStatus === "UNUSED") ||
      amendment.courseFingerprint !== courseFingerprint) {
      throw new Error("FACILITY_ACCESS_ROAD_AUTHORIZATION_NOT_CONSUMABLE");
    }
    amendment.executionUseStatus = "CONSUMED";
    amendment.status = "CONSUMED";
    this.#trimAndSave();
    return clone(amendment);
  }

  /**
   * Atomically consumes a one-action facility-road amendment and appends the
   * corresponding ROAD command in the existing canonical durable-state write.
   * Electron Store persists that complete state value using atomically.writeFile;
   * there is no intermediate persisted state containing only one side.
   */
  commitFacilityAccessRoadRepairCommand(input: {
    amendmentId: string;
    expectedJournalPosition: number;
    expectedWorldId: string;
    expectedCheckpointId: string | null;
    expectedGeneration: string;
    repairLineage: string;
    planRevision: string;
    actionFingerprint: string;
    command: V2CommandRecord;
  }): V2CommandRecord {
    this.#assertStoreHealthy();
    const amendment = (this.#state.utilityBudgetAmendments ?? []).find((entry) => entry.amendmentId === input.amendmentId);
    const scope = input.command.authorizedScope;
    const repairBinding = scope.actionFamily === "ROAD" ? scope.facilityAccessRoadRepair : undefined;
    let actionMatchesRoadInput = false;
    if (scope.actionFamily === "ROAD") {
      try {
        const actions = JSON.parse(input.actionFingerprint) as Array<Record<string, unknown>>;
        const action = actions.length === 1 ? actions[0] : undefined;
        const road = JSON.parse(scope.exactInput) as Record<string, unknown>;
        // The authorized course is the ACTION's course, its control point
        // included: a curved course and its chord are two different native
        // courses at two different prices, so an authorization whose fingerprint
        // cannot tell them apart authorizes a course nobody certified. The scope
        // is compared byte for byte against the course rebuilt exactly the way
        // the ROAD kernel rebuilds it.
        const controlIsPaired = (action?.cx === undefined && action?.cz === undefined) ||
          (action?.cx !== undefined && action?.cz !== undefined &&
            Number.isFinite(action.cx) && Number.isFinite(action.cz));
        actionMatchesRoadInput = Array.isArray(actions) && actions.length === 1 && action?.type === "build_road" &&
          action.prefab === "Small Road" && road.actionFamily === "ROAD" && road.prefab === action.prefab &&
          road.x1 === action.x1 && road.z1 === action.z1 && road.x2 === action.x2 && road.z2 === action.z2 &&
          road.cx === action.cx && road.cz === action.cz && controlIsPaired &&
          [action.x1, action.z1, action.x2, action.z2].every((value) => typeof value === "number" && Number.isFinite(value)) &&
          stableRoadInput(roadCourseGeometry({
            prefab: String(action.prefab),
            x1: Number(action.x1), z1: Number(action.z1), x2: Number(action.x2), z2: Number(action.z2),
            ...(typeof action.cx === "number" ? { cx: action.cx } : {}),
            ...(typeof action.cz === "number" ? { cz: action.cz } : {}),
          })) === scope.exactInput;
      } catch { actionMatchesRoadInput = false; }
    }
    if (input.command.actionFamily !== "ROAD" || scope.actionFamily !== "ROAD" || !repairBinding ||
      !actionMatchesRoadInput ||
      repairBinding.amendmentId !== input.amendmentId || repairBinding.repairLineage !== input.repairLineage ||
      repairBinding.planRevision !== input.planRevision || repairBinding.actionFingerprint !== input.actionFingerprint ||
      repairBinding.actionCount !== 1 || repairBinding.purpose !== "Pump native road attachment repair" ||
      repairBinding.prefab !== "Small Road") {
      throw new Error("FACILITY_ACCESS_ROAD_COMMIT_COMMAND_BINDING_MISMATCH");
    }
    if (!amendment || amendment.reason !== FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON ||
      amendment.courseFingerprint !== input.actionFingerprint || amendment.planRevision !== input.planRevision ||
      amendment.repairLineage !== input.repairLineage || amendment.purpose !== repairBinding.purpose ||
      amendment.roadPrefab !== repairBinding.prefab || amendment.nativeQuote !== scope.budget.authorizedMaxSpend ||
      amendment.authorizationWorldId !== input.expectedWorldId || amendment.authorizationCheckpointId !== input.expectedCheckpointId ||
      amendment.authorizationGeneration !== input.expectedGeneration || this.#current?.worldId !== input.expectedWorldId ||
      this.#current?.checkpointId !== input.expectedCheckpointId || this.#current?.generation !== input.expectedGeneration) {
      throw new Error("FACILITY_ACCESS_ROAD_COMMIT_AUTHORIZATION_BINDING_MISMATCH");
    }
    const idempotencyKey = commandIdempotencyKey(input.command);
    const existing = this.#state.commands.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.record.authorizedScope.actionFamily !== "ROAD" ||
        existing.record.authorizedScope.exactInput !== scope.exactInput || amendment.status !== "CONSUMED" ||
        amendment.executionUseStatus !== "CONSUMED") {
        throw new Error("FACILITY_ACCESS_ROAD_COMMIT_IDEMPOTENCY_CONFLICT");
      }
      if (existing.record.status !== "CREATED") throw new Error("FACILITY_ACCESS_ROAD_COMMAND_ALREADY_SUBMITTED");
      return clone(existing.record);
    }
    if (!Number.isInteger(input.expectedJournalPosition) || input.expectedJournalPosition !== this.#state.journalPosition) {
      throw new Error("FACILITY_ACCESS_ROAD_COMMIT_STALE_DURABLE_REVISION");
    }
    if (amendment.status !== "ACTIVE" || amendment.executionUseLimit !== 1 || amendment.executionUseStatus !== "UNUSED") {
      throw new Error("FACILITY_ACCESS_ROAD_COMMIT_AUTHORIZATION_NOT_ACTIVE");
    }
    if (this.#state.commands.some((entry) => entry.record.commandId === input.command.commandId)) {
      throw new Error("FACILITY_ACCESS_ROAD_COMMIT_COMMAND_ID_CONFLICT");
    }
    if (!this.#state.active || !this.#current || this.#blockedReason) {
      throw new Error(this.#blockedReason ?? "cannot persist command without an active world identity");
    }
    const currentWorld = this.#current;
    const activeWorld = this.#state.active;
    this.assertMutationAllowed(idempotencyKey);

    const priorState = this.#state;
    this.#state = clone(priorState);
    const nextAmendment = this.#state.utilityBudgetAmendments?.find((entry) => entry.amendmentId === input.amendmentId);
    if (!nextAmendment || nextAmendment.status !== "ACTIVE" || nextAmendment.executionUseStatus !== "UNUSED") {
      this.#state = priorState;
      throw new Error("FACILITY_ACCESS_ROAD_COMMIT_AUTHORIZATION_RACED");
    }
    nextAmendment.status = "CONSUMED";
    nextAmendment.executionUseStatus = "CONSUMED";
    this.#state.journalPosition += 1;
    this.#state.commands.push({
      position: this.#state.journalPosition,
      worldId: currentWorld.worldId,
      baseCheckpointId: activeWorld.rollbackBoundaryId,
      worldEpochId: currentWorld.worldEpochId,
      idempotencyKey,
      outcome: durableOutcome(input.command),
      record: clone(input.command),
    });
    try {
      this.#trimAndSave();
    } catch (error) {
      // The store's atomic replacement leaves either the old snapshot or the
      // committed one. Re-read to resolve a possible commit-then-error outcome.
      try {
        const persisted = validateState(this.storage.load());
        const persistedCommand = persisted.commands.find((entry) => entry.idempotencyKey === idempotencyKey);
        if (persistedCommand) {
          this.#state = persisted;
          return clone(persistedCommand.record);
        }
        this.#state = persisted;
      } catch (reloadError) {
        this.#state = priorState;
        this.#loadError = reloadError instanceof Error ? reloadError : new Error(String(reloadError));
      }
      throw error;
    }
    return clone(input.command);
  }

  activate(rawWorldState: unknown): {
    kind: WorldTransitionKind;
    world: NativeWorldIdentity;
    blockedReason: string | null;
    status: V2DurableActivationStatus;
  } {
    this.#assertStoreHealthy();
    // A loaded store converges onto the current displacement rule HERE, not on
    // some later write. The write path is exactly what an unreleased suspension
    // can prevent: a stale claim blocks admission, admission never reaches the
    // activation that would have released it, and the store holds land no
    // planning path can ever name again. Converging on activation breaks that
    // circle, and it is the same rule the write path applies 鈥?history is
    // untouched, and only a record with nothing left to reconcile is released.
    if (this.#releaseDisplacedSuspensions() > 0) this.#trimAndSave();
    const world = parseNativeWorldIdentity(rawWorldState);
    const currentStateBeforeArchivedLookup = this.#state;
    let resolvedArchivedSource = false;
    if (world.loadPurpose === "LoadGame" && world.checkpointId &&
      !this.#state.checkpoints.some((checkpoint) => checkpoint.worldId === world.worldId && checkpoint.durable && saveIdentityMatches(checkpoint, world)) &&
      this.storage.resolveArchivedCheckpoint) {
      const archived = this.storage.resolveArchivedCheckpoint({ worldId: world.worldId, checkpointId: world.checkpointId,
        saveMetadataAssetGuid: world.loadAssetGuid, saveDataAssetGuid: world.saveDataAssetGuid });
      if (archived) {
        this.#state = validateState(archived);
        resolvedArchivedSource = true;
      }
    }
    const previous = this.#state.active;
    if (previous && !this.#state.executionBranch) {
      const legacyBranchId = createHash("sha1").update(`legacy|${previous.worldId}|${previous.rollbackBoundaryId}`).digest("hex");
      this.#state.executionBranch = {
        branchId: legacyBranchId,
        parentBranchId: null,
        sourceCheckpointId: previous.rollbackBoundaryId,
        sourceJournalCut: previous.activatedCheckpointJournalCut ?? 0,
        loadEventId: null,
      };
    }
    if (previous && this.#state.executionBranch &&
      (previous.worldId !== world.worldId || previous.worldEpochId !== world.worldEpochId) &&
      (world.loadPurpose === "NewGame" || world.loadPurpose === "NewMap") && world.generationOrigin === "LOAD_COMPLETED") {
      if (!this.storage.forkHistoricalBranch) throw new Error("NEW_GAME_EXECUTION_BRANCH_ROUTER_UNAVAILABLE");
      const parentBranchId = this.#state.executionBranch.branchId;
      const loadEventId = `${world.generation}|${world.worldEpochId}|${world.bridgeRuntimeEpoch}`;
      const branchId = createHash("sha1").update(`${parentBranchId}|new-world|${loadEventId}`).digest("hex");
      const branchState: V2DurableState = {
        ...emptyState(),
        executionBranch: { branchId, parentBranchId, sourceCheckpointId: null, sourceJournalCut: 0, loadEventId },
      };
      this.storage.forkHistoricalBranch({ branchId, parentBranchId, checkpointId: null, journalCut: 0, loadEventId, state: branchState });
      this.#state = validateState(this.storage.load());
      this.#current = null;
      return this.activate(rawWorldState);
    }
    const observedCheckpointId = world.checkpointId ?? transientCheckpoint(world);
    // A runtime load identity (`generation` / `worldEpochId`) answers "which
    // session is this" and is minted afresh on every load. Only the persistent
    // save identity 鈥?the save metadata asset, plus the save-data asset when the
    // asset database resolves it 鈥?may carry lineage across a reload. Judging
    // lineage by the runtime identity made every reload of an identical save look
    // like a different save and threw away the project state with it.
    const sameEpoch = previous?.worldId === world.worldId && previous.worldEpochId === world.worldEpochId;
    const matchedCheckpoint =
      this.#state.checkpoints.find(
        (checkpoint) =>
          checkpoint.worldId === world.worldId && checkpoint.durable && saveIdentityMatches(checkpoint, world),
      ) ?? null;
    const lineage = this.#durableJournalLineage(world.worldId, world.nativeSessionGuid);
    if (previous !== null && previous.worldId === world.worldId && !sameEpoch && world.loadPurpose === "LoadGame" &&
      !matchedCheckpoint && lineage === null) {
      throw new Error("EXECUTION_BRANCH_CLASSIFICATION_UNKNOWN");
    }
    // LoadGameSystem.context describes the checkpoint that began this generation.
    // A later successful save does not replace that native load context, so retain
    // the coordinator's newer durable checkpoint while the world epoch is unchanged.
    const cutAlreadyRestored =
      sameEpoch &&
      previous !== null &&
      matchedCheckpoint !== null &&
      previous.loadedCheckpointId === matchedCheckpoint.checkpointId &&
      previous.rollbackBoundaryId === matchedCheckpoint.checkpointId &&
      previous.activatedCheckpointJournalCut === matchedCheckpoint.journalPosition;
    const registeredCutRegression =
      matchedCheckpoint !== null &&
      !cutAlreadyRestored &&
      boundaryDiscardsJournaledWork(this.#state, world, matchedCheckpoint);
    const rollbackBoundaryId = registeredCutRegression
      ? matchedCheckpoint?.checkpointId ?? observedCheckpointId
      : sameEpoch
        ? previous.rollbackBoundaryId
        : (matchedCheckpoint?.checkpointId ?? observedCheckpointId);
    // A reconnect means the game never reloaded: the runtime epoch is unchanged
    // since the last activation. That is a statement about the *session*, not
    // about lineage, so it can only stand in for a save this store registered.
    // An unregistered save whose durable journal rests on this world's durable
    // checkpoints is a descendant candidate even inside a single runtime,
    // because the save identity 鈥?not the epoch 鈥?is what decides lineage.
    // Without this, a runtime that once stamped its own generation into
    // `active` could never again see the descendant it was looking at.
    //
    // A descendant candidate is a *save* this store never registered, so only a
    // world loaded from a save can be one. A NewGame has no loaded save at all:
    // its durable journal rests on the checkpoints this store recorded for this
    // very world, and there is no other save for it to inherit from or to be
    // quarantined against. Reading it as a descendant candidate reclassified a
    // live fresh world as NEW_GAME on every cycle after its first command, which
    // discarded the project state the Brain had just built up.
    const descendantCandidate = world.loadPurpose === "LoadGame" && matchedCheckpoint === null && lineage !== null;
    let kind: WorldTransitionKind;
    if (sameEpoch && !descendantCandidate) {
      kind = registeredCutRegression ? "ROLLBACK" : "SAME_WORLD_RECONNECT";
    } else if (world.loadPurpose === "NewGame" || world.loadPurpose === "NewMap") {
      kind = "NEW_GAME";
    } else if (!previous) {
      kind = "FIRST_OBSERVATION";
    } else if (previous.worldId !== world.worldId) {
      kind = "DIFFERENT_WORLD";
    } else if (matchedCheckpoint) {
      // The loaded save is one this store registered. Whether it still contains
      // the journaled work decides between a plain reload and a rollback.
      kind = registeredCutRegression ? "ROLLBACK" : "SAME_SAVE_RELOAD";
    } else if (lineage) {
      // A save this store never registered, loaded into a world whose durable
      // journal rests entirely on checkpoints of this very native world. That is
      // a descendant candidate 鈥?never lineage on its own, because "the world
      // looks similar" proves nothing. Authority is granted only once the loaded
      // world itself is observed to contain the journaled effects.
      kind = "DESCENDANT_SAVE_RELOAD";
    } else {
      kind = "DIFFERENT_SAVE";
    }

    const knownWorld = this.#state.checkpoints.some((checkpoint) => checkpoint.worldId === world.worldId);
    const knownCheckpoint = this.#state.checkpoints.find(
      (checkpoint) => checkpoint.worldId === world.worldId && checkpoint.checkpointId === rollbackBoundaryId,
    );
    // THE WORLD IS THE AUTHORITY (2026-10-02).
    //
    // A save this store never registered used to quarantine the whole lineage:
    // authority was granted only once the loaded world had been observed,
    // command by command, to still contain every journaled effect
    // (`confirmDescendantSaveReload`; driven from `main-adapter.ts:2851`). That
    // gives the ledger the power to deny the world — and it exercised it.
    // Measured live 2026-10-02 on this city: one 2026-10-01 ZONING whose cell the
    // loaded save now carries as `residential` instead of `industrial` made all
    // 222 inherited commands unprovable, and every durable write was refused
    // from then on, for good.
    //
    // That is the inverse of the product rule. After a Load the loaded world is
    // the authority, the product re-establishes its execution baseline on it,
    // and history is not required to pair with the save. So an unprovable
    // descendant is not a quarantine, it is a RE-BASELINE: the inherited
    // authority is retired — no earlier project may authorize work on land it
    // never saw — and the case falls through to `DESCENDANT_CHECKPOINT_REQUIRED`
    // below with its cut taken at the CURRENT journal position, which is what
    // makes the loaded save this store's new rollback boundary and puts every
    // earlier command below it.
    //
    // What is deliberately NOT retired: the journal itself (observability), and
    // every low-level correctness guarantee new commands rely on — finance
    // authorization, Apply-once authorization consumption, and observation
    // preconditions/readback. None of them is touched by this.
    if (kind === "DESCENDANT_SAVE_RELOAD" && lineage !== null) {
      this.#state.certifiedRollbackAnchor = null;
      // The PLAN is inherited lineage too, and retiring only the authority while
      // leaving the plan produces a store that can neither continue nor start:
      // the Brain admits a fresh project against the loaded world while the old
      // work order is still the active one, and every commit is refused with
      // `GOAL_WORK_ORDER_ACTIVE_SCOPE_CHANGED` (durability.ts:2842). Measured
      // live 2026-10-02: six identical failures, journal frozen.
      //
      // So the work orders and the project state go with the authority. The
      // journal stays — it is history and observability, not authority — and the
      // Brain re-derives its next Goal from the world, which is what
      // "re-establish the baseline on the world that is loaded now" means.
      this.#state.activeGoalWorkOrderId = null;
      this.#state.goalWorkOrders = [];
      this.#state.projectState = {
        schemaVersion: V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION,
        status: "PLACEHOLDER",
      };
    }
    this.#blockedReason = null;
    if (knownCheckpoint && knownCheckpoint.v2StateVersion !== this.#state.v2StateVersion) {
      this.#blockedReason = "stale checkpoint V2 state version";
    } else if (kind === "DIFFERENT_SAVE" && world.checkpointId !== null && knownWorld) {
      this.#blockedReason = "unknown checkpoint in known world lineage; inherited actions are quarantined";
    } else if (!knownCheckpoint) {
      this.#state.checkpoints.push({
        schemaVersion: V2_CHECKPOINT_SCHEMA_VERSION,
        checkpointId: rollbackBoundaryId,
        worldId: world.worldId,
        worldEpochId: world.worldEpochId,
        durable: world.checkpointId !== null,
        journalPosition: this.#state.journalPosition,
        v2StateVersion: this.#state.v2StateVersion,
        saveMetadataAssetGuid: world.loadPurpose === "LoadGame" ? world.loadAssetGuid : null,
        saveDataAssetGuid: world.saveDataAssetGuid,
        nativeSessionGuid: world.nativeSessionGuid,
        recordedAt: this.now().toISOString(),
        projectState: { schemaVersion: V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION, status: "PLACEHOLDER" },
      });
    }
    const boundary =
      knownCheckpoint ??
      this.#state.checkpoints.find(
        (checkpoint) => checkpoint.worldId === world.worldId && checkpoint.checkpointId === rollbackBoundaryId,
      );
    const isNewNativeLoad = previous !== null && !sameEpoch && world.loadPurpose === "LoadGame" &&
      world.generationOrigin === "LOAD_COMPLETED" && world.generation !== previous.generation;
    const historicalDivergence = matchedCheckpoint !== null && (
      matchedCheckpoint.journalPosition < this.#state.journalPosition ||
      JSON.stringify(this.#state.projectState) !== JSON.stringify(matchedCheckpoint.projectState) ||
      (this.#state.executionBranch?.parentBranchId !== null && this.#state.executionBranch?.parentBranchId !== undefined) ||
      resolvedArchivedSource
    );
    if (isNewNativeLoad && historicalDivergence && matchedCheckpoint && boundary && this.#state.executionBranch) {
      // B_HISTORICAL is authorized only by the exact loaded checkpoint. The
      // weaker metadata identity remains useful for ordinary same-save resume,
      // but cannot select a branch cut when two saves share metadata.
      if (world.checkpointId === null || matchedCheckpoint.checkpointId !== world.checkpointId) {
        if (resolvedArchivedSource) this.#state = currentStateBeforeArchivedLookup;
        throw new Error("HISTORICAL_LOAD_EXACT_CHECKPOINT_REQUIRED");
      }
      const root = objectRecord(rawWorldState);
      const nativeWorld = objectRecord(root.world);
      if (root.isLoading !== false || root.cityLoaded !== true || nativeWorld.worldReady !== true ||
        nativeWorld.nativeOperationBusy !== false || nativeWorld.nativeOperationStage !== "Idle") {
        if (resolvedArchivedSource) this.#state = currentStateBeforeArchivedLookup;
        throw new Error("HISTORICAL_LOAD_CROSS_GENERATION_OPERATION_NOT_IDLE");
      }
        if (!this.storage.forkHistoricalBranch) {
          if (resolvedArchivedSource) this.#state = currentStateBeforeArchivedLookup;
          throw new Error("HISTORICAL_LOAD_BRANCH_ROUTER_UNAVAILABLE");
        }
        const parentBranchId = this.#state.executionBranch.branchId;
        const loadEventId = `${world.generation}|${world.worldEpochId}|${world.bridgeRuntimeEpoch}`;
        const branchId = createHash("sha1").update(`${parentBranchId}|${matchedCheckpoint.checkpointId}|${matchedCheckpoint.journalPosition}|${loadEventId}`).digest("hex");
        const localCheckpoint: V2CheckpointRecord = {
          ...clone(matchedCheckpoint),
          journalPosition: 0,
          projectState: { schemaVersion: V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION, status: "PLACEHOLDER" },
          worldEpochId: world.worldEpochId,
          nativeSessionGuid: world.nativeSessionGuid,
          recordedAt: this.now().toISOString(),
        };
        const branchState: V2DurableState = {
          ...emptyState(),
          checkpoints: [localCheckpoint],
          active: {
            worldId: world.worldId,
            loadedCheckpointId: matchedCheckpoint.checkpointId,
            rollbackBoundaryId: matchedCheckpoint.checkpointId,
            activatedCheckpointJournalCut: 0,
            worldEpochId: world.worldEpochId,
            bridgeRuntimeEpoch: world.bridgeRuntimeEpoch,
            generation: world.generation,
          },
          baselineActivation: {
            worldId: world.worldId,
            status: "ACTIVATED",
            checkpointId: matchedCheckpoint.checkpointId,
            journalPosition: 0,
            recordedAt: this.now().toISOString(),
          },
          certifiedRollbackAnchor: {
            status: "CERTIFIED",
            checkpointId: matchedCheckpoint.checkpointId,
            worldId: world.worldId,
            nativeSessionGuid: world.nativeSessionGuid,
            sourceGeneration: world.generation,
            sourceWorldEpochId: world.worldEpochId,
            journalPosition: 0,
            certifiedAt: this.now().toISOString(),
          },
          executionBranch: {
            branchId,
            parentBranchId,
            sourceCheckpointId: matchedCheckpoint.checkpointId,
            sourceJournalCut: matchedCheckpoint.journalPosition,
            loadEventId,
            executionReady: false,
          },
        };
        try {
          this.storage.forkHistoricalBranch({ branchId, parentBranchId, checkpointId: matchedCheckpoint.checkpointId,
            journalCut: matchedCheckpoint.journalPosition, loadEventId, state: branchState });
        } catch (error) {
          if (resolvedArchivedSource) this.#state = currentStateBeforeArchivedLookup;
          throw error;
        }
        this.#state = validateState(this.storage.load());
        this.#current = null;
        const activatedBranch = this.activate(rawWorldState);
        return { ...activatedBranch, kind: registeredCutRegression ? "ROLLBACK" : "SAME_SAVE_RELOAD" };
    }
    // Durable state and the authority to mutate it are two different things, and
    // it is only the second that a descendant candidate must not receive.
    //
    // A reconnect, or a same-save reload without a cut regression, keeps the
    // recorded state. A rollback restores the exact checkpoint snapshot so task
    // and project progression match its journal cut.
    const keepsProjectState =
      this.#blockedReason === null &&
      (kind === "SAME_WORLD_RECONNECT" ||
        (kind === "SAME_SAVE_RELOAD" && !boundaryDiscardsJournaledWork(this.#state, world, boundary)));
    if (!keepsProjectState) {
      this.#state.projectState = clone(
        boundary?.projectState ?? {
          schemaVersion: V2_PROJECT_PLACEHOLDER_SCHEMA_VERSION,
          status: "PLACEHOLDER",
        },
      );
    }
    // A PLAN WITHOUT A PROJECT IS NOT A PLAN (2026-10-02).
    //
    // The store mints a work order and the project state it stands on in the
    // same write (`activateGoalWorkOrder` sets `projectState` from the record it
    // activates), so a Gate 1 placeholder beside a non-empty Goal registry can
    // only mean an activation retired the project state and left the plan
    // behind. That shape does not heal: the first-project bootstrap sees the
    // placeholder, mints a fresh project against the world, and the one durable
    // write path refuses it with `GOAL_WORK_ORDER_ACTIVE_SCOPE_CHANGED`
    // (durability.ts:2842) in the name of a Goal whose project this store no
    // longer holds. Every cycle then fails identically and the journal never
    // moves. Measured live 2026-10-02 on a re-baselined branch: 163 inherited
    // work orders beside a placeholder, six identical failures, `journalPosition`
    // frozen at the cut.
    //
    // So the plan goes with the project state, for exactly the reason it does in
    // the re-baseline above: the world is the authority, the Brain re-derives its
    // next Goal from it, and a work order whose project is gone is not a claim on
    // anything. Retiring it here covers every site that can discard the project
    // state, including the boundary restore below, instead of one of them.
    if (this.#retirePlanWithoutProject()) this.#trimAndSave();
    this.#state.active = {
      worldId: world.worldId,
      loadedCheckpointId: world.checkpointId,
      rollbackBoundaryId,
      ...(boundary ? { activatedCheckpointJournalCut: boundary.journalPosition } : {}),
      worldEpochId: world.worldEpochId,
      bridgeRuntimeEpoch: world.bridgeRuntimeEpoch,
      generation: world.generation,
    };
    if (!this.#state.executionBranch) {
      const initialBranchId = createHash("sha1").update(`initial|${world.worldId}|${rollbackBoundaryId}`).digest("hex");
      this.#state.executionBranch = {
        branchId: initialBranchId,
        parentBranchId: null,
        sourceCheckpointId: world.checkpointId,
        sourceJournalCut: boundary?.journalPosition ?? 0,
        loadEventId: null,
      };
    }
    this.#current = world;
    let status: V2DurableActivationStatus = "ACTIVATED";
    const baseline = this.#state.baselineActivation;
    if (kind === "DESCENDANT_SAVE_RELOAD" && lineage !== null) {
      // Re-baseline on the loaded world. The caller records or adopts a durable
      // save of THIS world as the new rollback boundary, taken at the journal
      // position reached now — so every inherited command sits below the
      // boundary and none of them is authority for anything again. There is one
      // re-baseline, not a quarantine and not a proof requirement: the loaded
      // world decides, and the cut is today's.
      status = "DESCENDANT_CHECKPOINT_REQUIRED";
      this.#state.baselineActivation = {
        worldId: world.worldId,
        status,
        checkpointId: null,
        journalPosition: this.#state.journalPosition,
        recordedAt: this.now().toISOString(),
      };
    } else if (world.checkpointId === null) {
      // The loaded save carries no native checkpoint identity, so the only
      // certified rollback boundary this store can offer is one it recorded
      // itself: the certified checkpoint for exactly this save, or 鈥?for a fresh
      // world 鈥?the BASELINE it created before any mutation. The certified
      // rollback anchor is a per-world pointer, not a process-global singleton.
      const certifiedForSave =
        matchedCheckpoint && matchedCheckpoint.checkpointId === rollbackBoundaryId ? matchedCheckpoint : undefined;
      const baselineCheckpoint = this.#state.checkpoints.find(
        (checkpoint) =>
          checkpoint.worldId === world.worldId &&
          checkpoint.durable &&
          checkpoint.journalPosition === 0 &&
          checkpoint.purpose === "BASELINE",
      );
      const anchor = certifiedForSave ?? baselineCheckpoint;
      // An anchor that carries a persistent save identity is judged by that
      // identity plus the proof that the loaded save still contains the
      // journaled work. Only an anchor with no save identity at all 鈥?a fresh
      // world that was never saved 鈥?falls back to the runtime epoch, because
      // there the epoch is the only identity there is.
      //
      // `loadAssetGuid` is a save identity only for a world loaded from a save.
      // A NewGame is generated from a map, and the Bridge reports that same map
      // asset as `loadAssetGuid` and as `mapAssetGuid`; the save identity of a
      // checkpoint this store wrote is a *save* metadata asset and can never
      // equal it. Reading the map asset as a save identity made every fresh
      // world's own BASELINE fail this comparison, so `anchorIsCurrent` was
      // false however many baselines were recorded and the world could never
      // activate in place.
      const loadedSaveAssetGuid = world.loadPurpose === "LoadGame" ? world.loadAssetGuid : null;
      const anchorIsCurrent =
        anchor !== undefined &&
        (anchor.nativeSessionGuid === null || anchor.nativeSessionGuid === world.nativeSessionGuid) &&
        (anchor.saveMetadataAssetGuid !== null && loadedSaveAssetGuid !== null
          ? anchor.saveMetadataAssetGuid === loadedSaveAssetGuid &&
            this.#state.commands.every(
              (entry) => entry.worldId !== world.worldId || entry.position <= anchor.journalPosition,
            )
          : anchor.worldEpochId === world.worldEpochId);
      status = anchorIsCurrent ? "ACTIVATED_IN_PLACE" : "BASELINE_CHECKPOINT_REQUIRED";
      this.#state.certifiedRollbackAnchor = anchorIsCurrent
        ? {
            status: "CERTIFIED",
            checkpointId: anchor.checkpointId,
            worldId: anchor.worldId,
            nativeSessionGuid: anchor.nativeSessionGuid ?? world.nativeSessionGuid,
            sourceGeneration: world.generation,
            sourceWorldEpochId: anchor.worldEpochId,
            journalPosition: anchor.journalPosition,
            certifiedAt: anchor.recordedAt,
          }
        : null;
      this.#state.baselineActivation = {
        worldId: world.worldId,
        status,
        checkpointId: anchorIsCurrent ? anchor.checkpointId : null,
        journalPosition: anchorIsCurrent ? anchor.journalPosition : this.#state.journalPosition,
        recordedAt: anchorIsCurrent ? anchor.recordedAt : this.now().toISOString(),
      };
      if (anchorIsCurrent) this.#state.active.rollbackBoundaryId = anchor.checkpointId;
    } else if (baseline?.worldId === world.worldId && baseline.status === "RELOAD_REQUIRED") {
      if (baseline.checkpointId !== world.checkpointId) {
        this.#blockedReason = "loaded checkpoint does not match the created baseline checkpoint";
      } else {
        this.#state.baselineActivation = { ...baseline, status: "ACTIVATED", recordedAt: this.now().toISOString() };
      }
    } else {
      this.#state.baselineActivation = {
        worldId: world.worldId,
        status: "ACTIVATED",
        checkpointId: world.checkpointId,
        journalPosition: knownCheckpoint?.journalPosition ?? this.#state.journalPosition,
        recordedAt: this.now().toISOString(),
      };
    }
    if (this.#state.executionBranch?.executionReady === false && status === "ACTIVATED") {
      status = "EXECUTION_WORLD_VERIFICATION_REQUIRED";
      this.#state.baselineActivation = {
        worldId: world.worldId,
        status,
        checkpointId: world.checkpointId,
        journalPosition: boundary?.journalPosition ?? 0,
        recordedAt: this.now().toISOString(),
      };
    }
    this.#trimAndSave();
    return { kind, world, blockedReason: this.#blockedReason, status };
  }

  assertMutationAllowed(idempotencyKey: string): void {
    this.#assertStoreHealthy();
    if (!this.#current || !this.#state.active) throw new Error("V2 durability world binding is not initialized");
    if (this.#blockedReason) throw new Error(this.#blockedReason);
    if (this.#state.executionBranch?.executionReady === false) throw new Error("EXECUTION_WORLD_VERIFICATION_REQUIRED");
    const activeCheckpoint = this.#state.checkpoints.find(
      (checkpoint) =>
        checkpoint.worldId === this.#state.active?.worldId &&
        checkpoint.checkpointId === this.#state.active?.rollbackBoundaryId,
    );
    if (
      !activeCheckpoint?.durable ||
      !["ACTIVATED", "ACTIVATED_IN_PLACE"].includes(String(this.#state.baselineActivation?.status))
    ) {
      throw new Error("a certified durable rollback boundary is required before any Mayor world write");
    }
    const entries = this.#applicableCommands().filter((entry) => entry.idempotencyKey === idempotencyKey);
    if (entries.some((entry) => entry.outcome === "OBSERVED_MATCH")) {
      throw new Error("durable terminal success prevents duplicate world write");
    }
    if (
      entries.some(
        (entry) =>
          entry.outcome === "SUBMITTED" ||
          entry.outcome === "NATIVE_COMPLETED" ||
          entry.outcome === "APPLIED" ||
          entry.outcome === "UNKNOWN",
      )
    ) {
      throw new Error("restart reconciliation is required before any replacement world write");
    }
  }

  reconciliationRequired(): V2DurableCommandEntry[] {
    if (!this.#current || this.#blockedReason) return [];
    // Historical uncertain submissions remain eligible for read-only
    // reconciliation even when their position is beyond the loaded checkpoint
    // cut. This does not place them in the active lineage or make them replayable.
    return this.#state.commands
      .filter(
        (entry) =>
          entry.worldId === this.#current?.worldId &&
          (entry.outcome === "SUBMITTED" ||
            entry.outcome === "NATIVE_COMPLETED" ||
            entry.outcome === "APPLIED" ||
            entry.outcome === "UNKNOWN"),
      )
      .map(clone);
  }

  /**
   * A same-save reload can intentionally restore a checkpoint that predates a
   * submitted command. In that case the command's old ECS generation is a
   * historical execution artifact, not the generation of the current world.
   * Keep this proof narrow: a different checkpoint, lineage, or later V2
   * checkpoint must never be treated as an automatic rollback.
   */
  canClassifyCommandRolledBack(entry: V2DurableCommandEntry): boolean {
    this.#assertStoreHealthy();
    if (!this.#current || !this.#state.active) return false;
    if (entry.worldId !== this.#current.worldId || entry.baseCheckpointId !== this.#state.active.rollbackBoundaryId)
      return false;
    if (entry.worldEpochId === this.#current.worldEpochId) return false;
    const activeCheckpoint = this.#state.checkpoints.find(
      (checkpoint) =>
        checkpoint.worldId === this.#state.active?.worldId &&
        checkpoint.checkpointId === this.#state.active?.rollbackBoundaryId,
    );
    if (!activeCheckpoint || activeCheckpoint.journalPosition >= entry.position) return false;
    return !this.#state.checkpoints.some(
      (checkpoint) =>
        checkpoint.worldId === entry.worldId &&
        checkpoint.checkpointId !== activeCheckpoint.checkpointId &&
        checkpoint.journalPosition >= entry.position,
    );
  }

  /**
   * Whether a terminal operation is outside the exact durable checkpoint that
   * is currently loaded and may be replanned after a fresh authoritative
   * absence observation. Unlike `canClassifyCommandRolledBack`, this does not
   * claim the command was rolled back from every descendant save: it proves
   * only that this named, registered checkpoint's journal cut predates the
   * command. Later checkpoints elsewhere in the store cannot add effects to
   * this checkpoint.
   */
  isCommandOutsideActiveCheckpoint(commandId: string): boolean {
    this.#assertStoreHealthy();
    const world = this.#current;
    const active = this.#state.active;
    if (this.#blockedReason !== null || !world || !active || !world.checkpointId || active.loadedCheckpointId !== world.checkpointId ||
      active.rollbackBoundaryId !== world.checkpointId) return false;
    const boundary = this.#state.checkpoints.find((checkpoint) =>
      checkpoint.worldId === world.worldId && checkpoint.checkpointId === world.checkpointId && checkpoint.durable,
    );
    const entry = this.#state.commands.find((candidate) =>
      candidate.record.commandId === commandId && candidate.worldId === world.worldId,
    );
    return !!boundary && !!entry && carriesTerminalSuccess(entry) &&
      entry.baseCheckpointId === boundary.checkpointId && entry.position > boundary.journalPosition &&
      entry.worldEpochId !== world.worldEpochId;
  }

  /**
   * Return the current-world absence witness only when the loaded checkpoint's
   * exact journal cut excludes this terminal operation. Historical command
   * records remain untouched; callers may create a new task operation from this
   * evidence, never replay the old command.
   */
  checkpointRecoveryWitness(commandId: string): V2WorldObservationRecord | null {
    if (!this.isCommandOutsideActiveCheckpoint(commandId)) return null;
    const world = this.#current;
    if (!world) return null;
    const observations = this.#state.worldObservations ?? [];
    const observation = [...observations].reverse().find((candidate) =>
      candidate.commandId === commandId && candidate.worldId === world.worldId &&
      candidate.nativeSessionGuid === world.nativeSessionGuid && candidate.worldEpochId === world.worldEpochId &&
      candidate.currentWorldEffectPresent === false,
    );
    return observation ? clone(observation) : null;
  }

  activeCheckpointJournalPosition(): number | null {
    if (!this.#state.active) return null;
    return (
      this.#state.checkpoints.find(
        (checkpoint) =>
          checkpoint.worldId === this.#state.active?.worldId &&
          checkpoint.checkpointId === this.#state.active?.rollbackBoundaryId,
      )?.journalPosition ?? null
    );
  }

  reconcile(commandId: string, result: RestartReconciliationResult): V2DurableCommandEntry {
    this.#assertStoreHealthy();
    const index = this.#state.commands.findIndex((entry) => entry.record.commandId === commandId);
    if (index < 0) throw new Error(`unknown durable command: ${commandId}`);
    const entry = this.#state.commands[index];
    if (!this.#current || entry.worldId !== this.#current.worldId)
      throw new Error("world identity mismatch blocks reconciliation");
    if (entry.outcome === "FAILED") return clone(entry);
    const at = this.now().toISOString();
    if (result.result === "MATCH") {
      if (entry.record.status === "OBSERVED_MISMATCH" || entry.record.statusHistory.some((item) => item.status === "OBSERVED_MISMATCH")) {
        // A later observation may establish what the world contains now, but it
        // cannot rewrite the command's already-proven execution-time mismatch.
        entry.outcome = "FAILED";
        entry.record = {
          ...entry.record,
          status: "OBSERVED_MISMATCH",
          reconciliationStatus: "MISMATCH",
          observationEvidence: result.evidence
            ? [...entry.record.observationEvidence, result.evidence]
            : entry.record.observationEvidence,
        };
        this.#state.commands[index] = entry;
        this.#trimAndSave();
        return clone(entry);
      }
      entry.outcome = "OBSERVED_MATCH";
      entry.record = {
        ...entry.record,
        status: "OBSERVED_MATCH",
        reconciliationStatus: "MATCH",
        failureOrUnknownReason: null,
        observationEvidence: result.evidence
          ? [...entry.record.observationEvidence, result.evidence]
          : entry.record.observationEvidence,
        statusHistory: [...entry.record.statusHistory, { status: "OBSERVED_MATCH", at, reason: result.reason }],
      };
    } else if (result.result === "MISMATCH") {
      entry.outcome = "FAILED";
      entry.record = {
        ...entry.record,
        status: "OBSERVED_MISMATCH",
        reconciliationStatus: "MISMATCH",
        effectAbsenceProven: result.effectAbsenceProven === true || entry.record.effectAbsenceProven === true,
        failureOrUnknownReason: result.reason,
        observationEvidence: result.evidence
          ? [...entry.record.observationEvidence, result.evidence]
          : entry.record.observationEvidence,
        statusHistory: [...entry.record.statusHistory, { status: "OBSERVED_MISMATCH", at, reason: result.reason }],
      };
    } else {
      entry.outcome = "UNKNOWN";
      entry.record = {
        ...entry.record,
        reconciliationStatus: "INCONCLUSIVE",
        failureOrUnknownReason: result.reason,
        observationEvidence: result.evidence
          ? [...entry.record.observationEvidence, result.evidence]
          : entry.record.observationEvidence,
      };
    }
    this.#state.commands[index] = entry;
    this.#trimAndSave();
    return clone(entry);
  }

  /** Materialize an auditable child continuation from a registered checkpoint. */
  createContinuationFromCheckpoint(input: {
    continuationId: string;
    parentNamespaceId: string;
    checkpointId: string;
    saveMetadataAssetGuid: string;
    saveDataAssetGuid: string;
    expectedWorld: NativeWorldIdentity;
    journalPosition: number;
    childStorage: V2DurableStateStorage;
  }): V2ContinuationProvenance {
    this.#assertStoreHealthy();
    if (
      !nonEmpty(input.continuationId) ||
      !nonEmpty(input.parentNamespaceId) ||
      !nonEmpty(this.storage.namespaceId) ||
      this.storage.namespaceId !== input.parentNamespaceId ||
      !nonEmpty(input.checkpointId) ||
      !Number.isInteger(input.journalPosition) ||
      input.journalPosition < 0
    ) {
      throw new Error("invalid continuation authority inputs");
    }
    if (input.childStorage.load() !== undefined && input.childStorage.load() !== null) {
      throw new Error("continuation child namespace must be empty");
    }
    const checkpoint = this.#state.checkpoints.find(
      (entry) => entry.worldId === input.expectedWorld.worldId && entry.checkpointId === input.checkpointId,
    );
    const baseline = this.#state.certifiedRollbackAnchor;
    if (
      !checkpoint ||
      !checkpoint.durable ||
      checkpoint.journalPosition !== input.journalPosition ||
      checkpoint.saveMetadataAssetGuid !== input.saveMetadataAssetGuid ||
      checkpoint.saveDataAssetGuid !== input.saveDataAssetGuid ||
      !baseline ||
      baseline.status !== "CERTIFIED" ||
      baseline.worldId !== input.expectedWorld.worldId ||
      !validProjectState(objectRecord(checkpoint.projectState)) ||
      this.#state.journalPosition < input.journalPosition ||
      input.expectedWorld.checkpointId !== input.checkpointId ||
      input.expectedWorld.nativeSessionGuid !== checkpoint.worldId.split(":").at(-1)
    ) {
      throw new Error("continuation checkpoint authority mismatch");
    }
    const preCutCommands = this.#state.commands.filter((entry) => entry.position <= input.journalPosition);
    if (
      preCutCommands.length !== input.journalPosition ||
      preCutCommands.some((entry) => entry.position <= 0 || entry.position > input.journalPosition) ||
      preCutCommands.some((entry) => ["SUBMITTED", "NATIVE_COMPLETED", "APPLIED", "UNKNOWN"].includes(entry.outcome)) ||
      !Array.from({ length: input.journalPosition }, (_, index) => index + 1).every((position) =>
        preCutCommands.some((entry) => entry.position === position),
      )
    ) {
      throw new Error("continuation journal cut is not authoritative");
    }
    const provenance: V2ContinuationProvenance = {
      continuationId: input.continuationId,
      parentNamespaceId: input.parentNamespaceId,
      parentCheckpointId: checkpoint.checkpointId,
      parentJournalPosition: checkpoint.journalPosition,
      sourceWorldId: checkpoint.worldId,
      sourceWorldEpochId: checkpoint.worldEpochId,
      createdAt: this.now().toISOString(),
    };
    const child: V2DurableState = {
      schemaVersion: V2_DURABLE_STATE_SCHEMA_VERSION,
      v2StateVersion: this.#state.v2StateVersion,
      journalPosition: input.journalPosition,
      checkpoints: this.#state.checkpoints.filter((entry) => entry.journalPosition <= input.journalPosition).map(clone),
      commands: preCutCommands.map(clone),
      projectState: clone(checkpoint.projectState),
      baselineActivation: {
        worldId: input.expectedWorld.worldId,
        status: "ACTIVATED",
        checkpointId: checkpoint.checkpointId,
        journalPosition: checkpoint.journalPosition,
        recordedAt: this.now().toISOString(),
      },
      certifiedRollbackAnchor: clone(baseline),
      completedProjects: clone(this.#state.completedProjects ?? []),
      active: {
        worldId: input.expectedWorld.worldId,
        loadedCheckpointId: input.expectedWorld.checkpointId,
        rollbackBoundaryId: checkpoint.checkpointId,
        worldEpochId: input.expectedWorld.worldEpochId,
        bridgeRuntimeEpoch: input.expectedWorld.bridgeRuntimeEpoch,
        generation: input.expectedWorld.generation,
      },
      continuation: provenance,
    };
    input.childStorage.save(child);
    return clone(provenance);
  }

  recordCheckpoint(receipt: SaveCompletionReceipt, journalPosition: number): V2CheckpointRecord {
    this.#assertStoreHealthy();
    if (!this.#current || !this.#state.active) throw new Error("cannot checkpoint before world activation");
    if (
      receipt.status !== "COMPLETED" ||
      receipt.durable !== true ||
      receipt.worldId !== this.#current.worldId ||
      receipt.worldGeneration !== this.#current.generation ||
      receipt.checkpoint.nativeSessionGuid !== this.#current.nativeSessionGuid ||
      !nonEmpty(receipt.checkpoint.checkpointId) ||
      journalPosition > this.#state.journalPosition
    )
      throw new Error("stale or mismatched save checkpoint receipt");
    const checkpoint: V2CheckpointRecord = {
      schemaVersion: V2_CHECKPOINT_SCHEMA_VERSION,
      checkpointId: receipt.checkpoint.checkpointId,
      worldId: receipt.worldId,
      worldEpochId: this.#current.worldEpochId,
      durable: true,
      journalPosition,
      v2StateVersion: this.#state.v2StateVersion,
      saveMetadataAssetGuid: receipt.checkpoint.saveMetadataAssetGuid,
      saveDataAssetGuid: receipt.checkpoint.saveDataAssetGuid,
      nativeSessionGuid: receipt.checkpoint.nativeSessionGuid,
      recordedAt: this.now().toISOString(),
      projectState: clone(this.#state.projectState),
      purpose: "PERIODIC",
    };
    this.#state.checkpoints = this.#state.checkpoints.filter(
      (candidate) => !(candidate.worldId === checkpoint.worldId && candidate.checkpointId === checkpoint.checkpointId),
    );
    this.#state.checkpoints.push(checkpoint);
    this.#state.active = { ...this.#state.active, rollbackBoundaryId: checkpoint.checkpointId };
    this.#trimAndSave();
    return clone(checkpoint);
  }

  recordBaselineCheckpoint(receipt: SaveCompletionReceipt): V2CheckpointRecord {
    this.#assertStoreHealthy();
    if (!this.#current || this.#current.checkpointId !== null || !this.#state.active) {
      throw new Error("baseline checkpoint creation is only legal for the active fresh world");
    }
    // First-writer-wins is scoped to the world, not the whole durable store:
    // a single world may hold exactly one certified baseline, but a different
    // world may establish its own.
    const existingBaseline = this.#state.checkpoints.some(
      (checkpoint) =>
        checkpoint.worldId === this.#current?.worldId &&
        checkpoint.durable &&
        checkpoint.journalPosition === 0 &&
        checkpoint.purpose === "BASELINE",
    );
    if (existingBaseline) {
      throw new Error("certified baseline checkpoint cannot be recorded again or replaced");
    }
    if (this.#state.commands.some((entry) => entry.worldId === this.#current?.worldId)) {
      throw new Error("baseline checkpoint must precede every Mayor world mutation");
    }
    const checkpoint = this.recordCheckpoint(receipt, 0);
    const index = this.#state.checkpoints.findIndex(
      (entry) => entry.worldId === checkpoint.worldId && entry.checkpointId === checkpoint.checkpointId,
    );
    this.#state.checkpoints[index] = { ...checkpoint, purpose: "BASELINE" };
    this.#state.certifiedRollbackAnchor = {
      status: "CERTIFIED",
      checkpointId: checkpoint.checkpointId,
      worldId: checkpoint.worldId,
      nativeSessionGuid: this.#current.nativeSessionGuid,
      sourceGeneration: this.#current.generation,
      sourceWorldEpochId: this.#current.worldEpochId,
      journalPosition: 0,
      certifiedAt: this.now().toISOString(),
    };
    this.#state.baselineActivation = {
      worldId: checkpoint.worldId,
      status: "ACTIVATED_IN_PLACE",
      checkpointId: checkpoint.checkpointId,
      journalPosition: checkpoint.journalPosition,
      recordedAt: this.now().toISOString(),
    };
    this.#trimAndSave();
    return clone(this.#state.checkpoints[index]);
  }

  #createCommand(record: V2CommandRecord): void {
    this.#assertStoreHealthy();
    if (!this.#state.active || !this.#current || this.#blockedReason) {
      throw new Error(this.#blockedReason ?? "cannot persist command without an active world identity");
    }
    if (this.#state.commands.some((entry) => entry.record.commandId === record.commandId)) {
      throw new Error(`command already exists: ${record.commandId}`);
    }
    if (record.authorizedScope.actionFamily === "ROAD" && record.authorizedScope.networkJunctionInsert?.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
      this.#state.commands.some((entry) => entry.record.authorizedScope.actionFamily === "ROAD" &&
        entry.record.authorizedScope.networkJunctionInsert?.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
        scopeExactInput(entry.record.authorizedScope) === scopeExactInput(record.authorizedScope))) {
      throw new Error("BOUNDED_JUNCTION_OPERATION_ALREADY_RECORDED");
    }
    const idempotencyKey = commandIdempotencyKey(record);
    this.assertMutationAllowed(idempotencyKey);
    this.#state.journalPosition += 1;
    this.#state.commands.push({
      position: this.#state.journalPosition,
      worldId: this.#current.worldId,
      baseCheckpointId: this.#state.active.rollbackBoundaryId,
      worldEpochId: this.#current.worldEpochId,
      idempotencyKey,
      outcome: durableOutcome(record),
      record: clone(record),
    });
    this.#trimAndSave();
  }

  #updateCommand(commandId: string, update: (current: V2CommandRecord) => V2CommandRecord): V2CommandRecord {
    this.#assertStoreHealthy();
    const index = this.#state.commands.findIndex((entry) => entry.record.commandId === commandId);
    if (index < 0) throw new Error(`unknown command: ${commandId}`);
    const entry = this.#state.commands[index];
    const next = update(clone(entry.record));
    if (next.commandId !== commandId) throw new Error("durable command id cannot change");
    const historicalMismatch = entry.record.status === "OBSERVED_MISMATCH" ||
      entry.record.statusHistory.some((item) => item.status === "OBSERVED_MISMATCH");
    if (historicalMismatch && next.status !== "OBSERVED_MISMATCH") {
      const mismatchReason = entry.record.statusHistory.find((item) => item.status === "OBSERVED_MISMATCH")?.reason;
      next.status = "OBSERVED_MISMATCH";
      next.reconciliationStatus = "MISMATCH";
      next.failureOrUnknownReason = mismatchReason ?? entry.record.failureOrUnknownReason ??
        "Historical OBSERVED_MISMATCH cannot be rewritten by a later current-world observation";
    }
    entry.record = clone(next);
    entry.outcome = durableOutcome(next);
    this.#state.commands[index] = entry;
    this.#trimAndSave();
    return clone(next);
  }

  #applicableCommands(): V2DurableCommandEntry[] {
    if (!this.#state.active) return [];
    const checkpoint = this.#state.checkpoints.find(
      (candidate) =>
        candidate.worldId === this.#state.active?.worldId &&
        candidate.checkpointId === this.#state.active?.rollbackBoundaryId,
    );
    if (!checkpoint) return [];
    return this.#state.commands.filter(
      (entry) =>
        entry.worldId === checkpoint.worldId &&
        (entry.position <= checkpoint.journalPosition ||
          (entry.baseCheckpointId === checkpoint.checkpointId && entry.worldEpochId === this.#state.active?.worldEpochId)),
    );
  }

  #assertStoreHealthy(): void {
    if (this.#loadError) throw new Error(`V2 durable state is malformed; fail closed: ${this.#loadError.message}`);
  }

  #trimAndSave(): void {
    if (this.#state.worldObservations && this.#state.worldObservations.length > MAX_WORLD_OBSERVATIONS) {
      // Observations are derived evidence, never the authority a command rests
      // on, so the oldest may be dropped. The commands themselves never are.
      this.#state.worldObservations = this.#state.worldObservations.slice(-MAX_WORLD_OBSERVATIONS);
    }
    if (this.#state.commands.length > MAX_DURABLE_COMMANDS) {
      const removable = this.#state.commands.filter((entry) => entry.outcome === "FAILED");
      while (this.#state.commands.length > MAX_DURABLE_COMMANDS && removable.length > 0) {
        const next = removable.shift();
        this.#state.commands = this.#state.commands.filter((entry) => entry !== next);
      }
      if (this.#state.commands.length > MAX_DURABLE_COMMANDS) {
        throw new Error("V2 durable command journal is full; terminal/unknown history cannot be discarded safely");
      }
    }
    if (this.#state.checkpoints.length > MAX_DURABLE_CHECKPOINTS) {
      const activeId = this.#state.active?.rollbackBoundaryId;
      const protectedIds = new Set(this.#state.commands.map((entry) => entry.baseCheckpointId));
      const removable = this.#state.checkpoints.filter(
        (checkpoint) => checkpoint.checkpointId !== activeId && !protectedIds.has(checkpoint.checkpointId),
      );
      while (this.#state.checkpoints.length > MAX_DURABLE_CHECKPOINTS && removable.length > 0) {
        const next = removable.shift();
        this.#state.checkpoints = this.#state.checkpoints.filter((checkpoint) => checkpoint !== next);
      }
      if (this.#state.checkpoints.length > MAX_DURABLE_CHECKPOINTS) {
        throw new Error("V2 durable checkpoint registry is full; referenced checkpoints cannot be discarded safely");
      }
    }
    this.storage.save(clone(this.#state));
  }
}

export function createMemoryDurableStateStorage(initial?: unknown): V2DurableStateStorage & { value(): unknown } {
  let current = clone(initial);
  const archivedBranches = new Map<string, V2DurableState>();
  return {
    load: () => clone(current),
    save: (state) => {
      current = clone(state);
    },
    forkHistoricalBranch: ({ branchId, parentBranchId, loadEventId, state }) => {
      const currentState = objectRecord(current);
      const currentBranch = objectRecord(currentState.executionBranch);
      if (current && typeof currentBranch.branchId === "string") archivedBranches.set(currentBranch.branchId, clone(current as V2DurableState));
      const existing = archivedBranches.get(branchId);
      if (existing) {
        const provenance = existing.executionBranch;
        if (provenance?.parentBranchId !== parentBranchId || provenance.loadEventId !== loadEventId) {
          throw new Error("HISTORICAL_EXECUTION_BRANCH_ID_COLLISION");
        }
        current = clone(existing);
      } else current = clone(state);
    },
    resolveArchivedCheckpoint: ({ worldId, checkpointId, saveMetadataAssetGuid, saveDataAssetGuid }) => {
      const candidates = [...archivedBranches.values(), ...(current ? [current as V2DurableState] : [])]
        .filter((candidate) => candidate.checkpoints.some((checkpoint) => checkpoint.durable && checkpoint.worldId === worldId &&
          checkpoint.checkpointId === checkpointId && checkpoint.saveMetadataAssetGuid === saveMetadataAssetGuid &&
          checkpoint.saveDataAssetGuid === saveDataAssetGuid));
      return candidates.length === 1 ? clone(candidates[0]) : null;
    },
    value: () => clone(current),
  };
}
