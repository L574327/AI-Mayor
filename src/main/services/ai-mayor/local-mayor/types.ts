import type { MayorPlanAction } from "../types";
import type { CityIssue, CityIssueSummary } from "./issues";
import type { LocalServiceRecoveryIntent } from "./service-recovery";

export const LOCAL_MAYOR_STATE_VERSION = 1 as const;
export const LOCAL_MAYOR_MAX_GOALS = 6;
export const LOCAL_MAYOR_MAX_ACTIONS = 8;
export const LOCAL_MAYOR_MAX_HISTORY = 8;
export const LOCAL_MAYOR_MAX_COOLDOWNS = 12;
export const LOCAL_MAYOR_MAX_TRACE_CANDIDATES = 8;
export const LOCAL_MAYOR_MAX_CORRIDOR_SEGMENTS = 4;
export const LOCAL_MAYOR_MAX_ZONING_BATCH = 4;
export const LOCAL_MAYOR_MAX_DISTRICT_BURST = 8;

export type LocalMayorGoalKind =
  | "stabilize_utilities"
  | "prepare_utility_bootstrap"
  | "protect_finances"
  | "grow_residential"
  | "grow_commercial"
  | "grow_industrial"
  | "grow_office"
  | "expand_frontier"
  | "maintain_development_reserve"
  | "use_existing_frontage"
  | "wait_for_growth"
  | "recover_from_failed_expansion"
  | "address_city_issue";

export type LocalMayorGrowthDomain = "residential" | "commercial" | "industrial" | "office";

export type LocalMayorActionKind = "wait" | "choose_candidate" | "recover_utility" | "simulate" | "replan";
export type LocalMayorActivityKind =
  | "observing"
  | "planning"
  | "building"
  | "waiting_for_growth"
  | "waiting_for_demand"
  | "waiting_for_absorption"
  | "waiting_for_simulation"
  | "selecting_next_district"
  | "building_district"
  | "recovering"
  | "yielding"
  | "blocked";
export type LocalDistrictLifecycle = "building_district" | "fast_absorb" | "selecting_next_district" | "blocked";
export type LocalDistrictTakeoverOutcome =
  | "opportunity_found"
  | "search_incomplete"
  | "search_exhausted"
  | "stale_spatial_context"
  | "technical_failure";
export interface LocalDistrictTakeover {
  previousSiteId: string | null;
  searchRevision: string | null;
  checkedSources: string[];
  outcome: LocalDistrictTakeoverOutcome;
}
export type LocalMayorDecisionStatus =
  | "observing"
  | "deciding"
  | "acting"
  | "waiting"
  | "recovering"
  | "yielding"
  | "blocked";

export interface LocalMayorDemandState {
  residential: number | null;
  commercial: number | null;
  industrial: number | null;
  office: number | null;
}

export interface LocalMayorUtilityState {
  available: boolean;
  headroom: number | null;
  /**
   * Load this utility is actually carrying right now. `null` means the read did
   * not resolve. A shortage is a statement about load that is not being served,
   * so it is this figure — never capacity alone — that decides `risk`.
   */
  load: number | null;
  risk: "unknown" | "healthy" | "tight" | "critical";
  /**
   * Load the city asks for that is not served although supply exceeds it: a delivery gap at particular consumers,
   * not a shortage. Building more supply does not close it, so it does not raise `risk`. `0` when there is none.
   */
  undeliveredLoad?: number;
  /**
   * The utility exists in the world with no supply and no load: nothing is being
   * starved today, but the first committed development cannot go live without
   * it. That is a PREPARATION requirement, deliberately not an emergency — two
   * capacity reads of zero are not a city in crisis, and treating them as one
   * held a NewGame city at emergency priority indefinitely.
   */
  uncommissioned: boolean;
}

export interface LocalMayorCandidateRef {
  id: string;
  kind: "zoning" | "road_expansion";
  areaType: "Residential" | "Commercial" | "Industrial" | "Office" | null;
  estimatedCost: number | null;
  approximateLength: number | null;
  approximateCells: number | null;
  approximateNewFrontage: number | null;
  conflictGroup: string | null;
  spatialRole: "infill" | "small_expansion" | null;
  sourceRoad: { index: number; version: number } | null;
  approximateDirection?: string;
  roadHeadingDegrees?: number;
  roadHeadingDeltaDegrees?: number;
  validationStatus: "validated";
  growthDomain?: LocalMayorGrowthDomain;
}

export type LocalGrowthIntentPhase = "corridor" | "zoning" | "digest";
export type LocalGrowthCorridorCompletionReason =
  | "corridor_target_reached"
  | "corridor_frontage_sufficient"
  | "corridor_safe_truncated"
  | "corridor_no_continuation_candidate"
  | "corridor_world_stale";

export interface LocalGrowthIntent {
  version: 1;
  domain: LocalMayorGrowthDomain;
  phase: LocalGrowthIntentPhase;
  sourceRoad: { index: number; version: number } | null;
  preferredHeadingDegrees: number | null;
  targetCorridorLength: number;
  completedCorridorLength: number;
  remainingSegments: number;
  maxSegments: number;
  remainingZoningPatches: number;
  maxZoningPatches: number;
  createdRevision: string | null;
  valid: boolean;
  status: "active" | "completed" | "blocked";
  digestStartedGameTime?: string | null;
  completionReason?: LocalGrowthCorridorCompletionReason;
}

export interface LocalMayorCooldown {
  key: string;
  remainingObservations: number;
  reason: string;
}

export interface LocalMayorHistoryEntry {
  key: string;
  kind: LocalMayorActionKind;
  outcome: "success" | "failure" | "stale" | "external_world_change";
  reason: string;
  impact?: LocalMayorOutcomeImpact["kind"];
}

export interface LocalMayorHistory {
  recentActions: LocalMayorHistoryEntry[];
  cooldowns: LocalMayorCooldown[];
  consecutiveWaits: number;
  issueMemory?: CityIssue[];
  serviceRecovery?: LocalServiceRecoveryIntent;
}

export type LocalDevelopmentReserveStatus = "empty" | "low" | "adequate" | "digesting" | "unknown";

export interface LocalTypedDevelopmentReserve {
  residential: number;
  commercial: number;
  industrial: number;
  office: number;
  unknown: number;
}

export interface LocalTypedReserveDeficit {
  residential: boolean;
  commercial: boolean;
  industrial: boolean;
  office: boolean;
}

export interface LocalDevelopmentCapacity {
  safeUnzonedRoadsideCells: number;
  safeUnzonedCells: number;
  existingZonedUnoccupiedCells: number;
  zonedUnoccupiedByType?: LocalTypedDevelopmentReserve;
  /**
   * The third stock the growth policy has to keep apart: land that HAS been
   * built on and whose buildings stand empty.
   *
   * `zonedUnoccupiedByType` stops counting a cell the moment a building appears
   * on it, so on its own it cannot tell a batch that was absorbed from a batch
   * that spawned buildings nobody moved into — both read as "the land is used
   * up". This is that missing half, observed by Gate 1 as the buildings it
   * attributed to its own land use minus the ones that have residents.
   *
   * Absent means no durable tranche has observed occupancy yet, which is not
   * the same as "no vacancy" and is never turned into one.
   */
  builtButVacantByType?: LocalTypedDevelopmentReserve;
  typedReserveDeficit?: LocalTypedReserveDeficit;
  existingZonedCells: number;
  candidateZoningCells: number;
  candidateFrontageCapacity: number;
  availableFrontageCells: number;
  frontierAnchorCount: number;
  targetZoningCells: number;
  targetFrontageCapacity: number;
  availableDevelopmentCells: number;
  reserveStatus: LocalDevelopmentReserveStatus;
  reserveDeficit: boolean;
  developmentDigesting: boolean;
  recentZoningAdded: number;
  recentRoadAddedFrontage: number;
}

export interface LocalMayorState {
  version: typeof LOCAL_MAYOR_STATE_VERSION;
  snapshotRevision: string | null;
  worldFingerprint: string | null;
  status: "available" | "unavailable";
  game: { available: boolean; paused: boolean | null; gameDateTime: string | null };
  population: number | null;
  treasury: number | null;
  monthlyBalance: number | null;
  financeRunwayMonths: number | null;
  /**
   * The growable domains the native catalogue exposes an unlocked zone for.
   *
   * A capability of the bridge, re-read with the catalogue every cycle: what the
   * catalogue does not expose, the Mayor cannot zone, and no amount of building
   * in the city changes that until the category unlocks. Recorded here rather
   * than inferred at the ranking step so the planner has the fact BEFORE it
   * generates work, instead of admitting a Goal and discovering the gap when its
   * own ZONING step refuses.
   *
   * `null` means the catalogue was not readable, which is a different finding
   * from "none available" and must not suppress anything.
   */
  availableZoneDomains: readonly LocalMayorGrowthDomain[] | null;
  demands: LocalMayorDemandState;
  /**
   * Job domains whose own demand the game reports as held down by a missing workforce (a negative
   * `UneducatedWorkforce`/`EducatedWorkforce` factor). Their jobs stand empty for want of residents, so housing
   * is the binding constraint. `[]` when the factors were not read.
   */
  laborStarvedDomains: readonly LocalMayorGrowthDomain[];
  developmentCapacity: LocalDevelopmentCapacity;
  utilities: {
    electricity: LocalMayorUtilityState;
    water: LocalMayorUtilityState;
    sewage: LocalMayorUtilityState;
  };
  candidates: {
    zoning: LocalMayorCandidateRef[];
    roadExpansion: LocalMayorCandidateRef[];
    usefulFrontierCount: number;
    currentDevelopmentCapacity: number;
    pendingZoningCells: number;
    pendingFrontageCapacity: number;
  };
  actionability: {
    status: "available" | "empty" | "blocked" | "unavailable";
    reasonCode: string;
    reason: string;
    refreshAttempted: boolean;
    backoffRemaining: number;
    capacityStatus: "sufficient" | "insufficient" | "unknown";
  };
  issues: CityIssueSummary;
  serviceRecovery?: LocalServiceRecoveryIntent;
  growthIntent?: LocalGrowthIntent;
  districtTakeover?: LocalDistrictTakeover;
  history: LocalMayorHistory;
}

export interface LocalMayorFocusTarget {
  kind: "candidate";
  candidateId: string;
  sourceRoad?: { index: number; version: number };
}

export interface LocalMayorActivity {
  status: LocalMayorDecisionStatus;
  goal: LocalMayorGoalKind | null;
  activityKind: LocalMayorActivityKind;
  reasonCode: string;
  displayKey: string;
  focusTarget?: LocalMayorFocusTarget;
  lastMeaningfulAction: string | null;
  waitingReason: string | null;
  nextObservation: string | null;
  topIssue?: Pick<CityIssue, "kind" | "severity" | "message" | "actionable" | "persistence">;
  growthProgress?: {
    domain: LocalMayorGrowthDomain;
    phase: LocalGrowthIntentPhase;
    current: number;
    total: number;
  };
  recentMutation?: {
    roads: number;
    residentialZoning: number;
    commercialZoning: number;
    industrialZoning: number;
    officeZoning: number;
    newBuildings: number | null;
    populationBefore: number | null;
    populationAfter: number | null;
  };
}

export interface LocalMayorGoal {
  kind: LocalMayorGoalKind;
  urgency: number;
  evidence: string[];
  domain?: LocalMayorGrowthDomain;
  expiresAfterObservations?: number;
}

export interface LocalMayorActionBase {
  kind: LocalMayorActionKind;
  reasonCode: string;
}

export interface LocalMayorCandidateAction extends LocalMayorActionBase {
  kind: "choose_candidate";
  candidateId: string;
  candidateKind: "zoning" | "road_expansion";
  candidateIds?: string[];
}

export interface LocalMayorWaitAction extends LocalMayorActionBase {
  kind: "wait";
  observeAfterTicks: number;
}

export interface LocalMayorUtilityRecoveryAction extends LocalMayorActionBase {
  kind: "recover_utility";
  utility: "electricity" | "water" | "sewage";
  issueKey: string;
}

export interface LocalMayorSimulationAction extends LocalMayorActionBase {
  kind: "simulate";
  hours: number;
  speed: number;
}

export interface LocalMayorReplanAction extends LocalMayorActionBase {
  kind: "replan";
  quietObservations: number;
}

export type LocalMayorAction =
  | LocalMayorCandidateAction
  | LocalMayorUtilityRecoveryAction
  | LocalMayorWaitAction
  | LocalMayorSimulationAction
  | LocalMayorReplanAction;

export interface LocalMayorScoreBreakdown {
  goalUrgency: number;
  demandPressure: number;
  utilityRisk: number;
  treasurySafety: number;
  expectedCost: number;
  usefulness: number;
  actionImpact: number;
  developmentCapacity: number;
  repeatedActionPenalty: number;
  recentFailurePenalty: number;
  cooldownPenalty: number;
  waitValue: number;
  total: number;
}

export interface LocalMayorOutcomeImpact {
  kind: "world_changed" | "capacity_added" | "road_added" | "zoning_added" | "no_material_change" | "unavailable";
  worldChanged: boolean;
  capacityAdded: boolean;
  roadAdded: boolean;
  zoningAdded: boolean;
  summary: string;
}

export interface LocalMayorScoredAction {
  action: LocalMayorAction;
  score: LocalMayorScoreBreakdown;
}

export interface LocalMayorDecisionTrace {
  version: typeof LOCAL_MAYOR_STATE_VERSION;
  stateSummary: Pick<
    LocalMayorState,
    "snapshotRevision" | "worldFingerprint" | "population" | "treasury" | "monthlyBalance"
  >;
  goals: LocalMayorGoal[];
  candidates: LocalMayorScoredAction[];
  chosen: LocalMayorScoredAction;
  rejectedAlternatives: Array<{ kind: LocalMayorActionKind; key: string; reason: string }>;
  confidence: number;
  margin: number;
  reasonCode: string;
}

export interface LocalMayorDecisionEpisode {
  status: LocalMayorDecisionStatus;
  state: LocalMayorState;
  goals: LocalMayorGoal[];
  actions: LocalMayorAction[];
  chosen: LocalMayorScoredAction;
  trace: LocalMayorDecisionTrace;
}

export interface LocalMayorWorldComparison {
  status: "unchanged" | "external_world_change" | "unavailable";
  reason: string;
}

export interface LocalMayorOutcomeInput {
  action: LocalMayorAction;
  outcome: "success" | "failure" | "stale" | "external_world_change";
  reason: string;
  impact?: LocalMayorOutcomeImpact;
}

export function toMayorPlanAction(action: LocalMayorAction): MayorPlanAction | null {
  if (action.kind !== "choose_candidate") return null;
  return { type: "choose_candidate", candidateId: action.candidateId, reason: action.reasonCode, priority: "medium" };
}

export function toMayorPlanActions(action: LocalMayorAction): MayorPlanAction[] {
  if (action.kind !== "choose_candidate") return [];
  return (action.candidateIds ?? [action.candidateId]).map((candidateId) => ({
    type: "choose_candidate" as const,
    candidateId,
    reason: action.reasonCode,
    priority: "medium" as const,
  }));
}
