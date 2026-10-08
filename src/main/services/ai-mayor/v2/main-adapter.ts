import { Mutex } from "@/main/internal/mutex";
import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB, type BootstrapSiteEvaluation, type BootstrapUtilityPlan, type PlannedUtilityFacility, type SpatialEntityRef, type SpatialPoint2, type SpatialRoadEdge, type SpatialSiteDetail } from "../spatial/types";
import { nearestPermanentRoadPoint, rankedPermanentRoadContacts, NoSupportedWaterTopologyError, planBootstrapUtilities, routeFirstLegDuplicatesCorridor, selectStageAWaterPlan, selectSupportedWaterPlan, serviceRoadFor, serviceRoadRouteCandidates, UtilityPlanningError } from "../spatial/utility-planner";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../spatial/world-scanner";
import {
  scopeNeedsService,
  type ServiceReachFacility,
  type ServiceReachStreet,
  type UtilityNetKind,
} from "./utility-service-reach";
import {
  parseWaterFlowObservation,
  unavailableWaterFlowObservation,
  type WaterFlowObservation,
} from "../spatial/water-flow";
import { SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION, type SewageIntakeCensus } from "./sewage-environmental-safety";
import type { MayorAction, MayorBatchResult } from "../types";
import {
  buildUtilityConnectionCandidates,
  executeSharedUtilityRecovery,
  type UtilityCapacityReadback,
  type UtilityPlacementReceipt,
  type UtilityConnectorReadback,
  type UtilityRecoveryResult,
  type UtilityRecoveryKind,
  type UtilityConnectionPrimitive,
  type UtilityPlanningContext,
  type UtilityPreflightEvidence,
  type UtilityPreflightResult,
  type UtilityCurrentBindingResult,
  type UtilityCurrentBinding,
  type UtilityConnectionPlan,
  plannedRoadSegmentToMayorAction,
} from "../utility-recovery";
import { nativeRoadQuoteFromPreview, normalizeNativeRoadDiagnostics } from "./runtime-road-caller";
import { createBlockingModalRuntimePort } from "./blocking-modal-runtime";
import {
  availableSource,
  createMemoryCommandJournal,
  createV2ObservationPorts,
  createV2ZoningKernel,
  V2SubmissionTimeoutError,
  type ExactZoningCellRef,
  type NativeZoningSubmission,
  type V2CommandJournal,
  type V2CommandRecord,
  type V2ObservationPorts,
  type V2SourcePayload,
  type V2SpatialDetailRequest,
  type V2ZoningKernel,
  type ZoningIntent,
} from "./foundation";
import { createTargetUtilityServicePorts, type TargetUtilityServicePorts } from "./utility-service";
import { createTargetAccessPorts, type TargetAccessPorts } from "./route-access";
import { createTargetRouteQueryPorts, type TargetRouteQueryPorts } from "./route-query";
import { createV2RoadKernel, roadCourseGeometry, type V2RoadKernel } from "./road-kernel";
import {
  MAX_ROAD_FEASIBILITY_CANDIDATES,
  NoFeasibleRoadCandidateError,
  RoadCandidatePreviewUnknownError,
  roadCandidatePreviewFailureVerdict,
  rawRoadCandidatePreviewVerdict,
  selectFeasibleRoadCandidate,
} from "./road-candidate-feasibility";
import { nativeBatchActionEvidence, requiresSequentialRoadExecution } from "./native-batch-evidence";
import { createAuthoritativeRoadEffectMatcher, isSafeCheckpointRollbackObservation } from "./road-effect";
import { V2_FINANCE_SCHEMA_VERSION, stableRoadInput, type FinanceObservation } from "./finance";
import { durableUtilityPlanningJournal, shouldPreviewRoadCandidate } from "./road-planning-policy";
import { ROAD_NETWORK_PLANNING_SKILL } from "./autonomous-brain";
import {
  commandIdempotencyKey,
  type SaveCompletionReceipt,
  type RestartReconciliationResult,
  type V2DescendantWorldEffect,
  type V2WorldObservationRecord,
  type V2UtilityBudgetAmendmentRecord,
  V2DurabilityCoordinator,
  type V2DurableStateStorage,
} from "./durability";
import type { Gate1ResidentObservation } from "./gate1-observation";
import {
  runScopedGreenfieldUtilityBootstrap,
  type DurableGreenfieldUtilityState,
  type GreenfieldUtilityExecutionScope,
  type GreenfieldUtilityKind,
  type GreenfieldUtilityObservation,
  type GreenfieldUtilityServiceEvidence,
  type GreenfieldUtilityRebindResult,
  type ScopedGreenfieldUtilityPorts,
  markFacilityAwaitingProductDecision,
} from "./greenfield-utility-bootstrap";
import {
  DomainWorldStateCache,
  matchUtilityConnectionEffect,
  type UtilityWorldState,
  type WorldStateIdentity,
} from "./domain-world-state";

/**
 * The two optional access-road ports, named once so the workflow's ports object
 * and any driver that prices an access road before the run call exactly the same
 * production functions. Pricing a course through a second, private copy of this
 * logic is how a settlement and its execution would drift apart.
 */
type AccessRoadRepairPorts = Pick<
  Required<ScopedGreenfieldUtilityPorts>,
  "facilityAccessRoadEvidence" | "planFacilityAccessRoad"
>;
import { PhaseAAcceptanceStopError, type PhaseAUtilityExecutePortInput } from "./phase-a-acceptance-boundary";
import type { PhaseBElectricityCertificationInput } from "./phase-b-acceptance-boundary";
import {
  matchCablePrimitiveEffect,
  matchConnectionObjective,
  topologyReachedApprovedContact,
} from "./utility-topology-matchers";

/**
 * Grid resolution for the T20 water-flow read.
 *
 * The Bridge samples the whole 14336 m map square, so the cell size is this
 * number's reciprocal over that square: 256 gives 56 m, which resolves a
 * shoreline's receiving cell and the direction the water leaves it, and is the
 * finest the endpoint offers. Finer would not add a fact the criterion uses.
 */
export const WATER_FLOW_OBSERVATION_RESOLUTION = 256;
/** Bounded prefab sweep for the water-intake census. */
export const MAXIMUM_WATER_INTAKE_PREFAB_QUERIES = 8;

export const committedUtilityPlacementPlan = (input: {
  kind: GreenfieldUtilityKind;
  plan: PlannedUtilityFacility | null;
  facilityCommandId: string | null;
  command: V2CommandRecord | null;
  scope: GreenfieldUtilityExecutionScope;
}): PlannedUtilityFacility | null => {
  const { kind, plan, facilityCommandId, command, scope } = input;
  if (!plan || !facilityCommandId) return plan;
  if (!command || command.commandId !== facilityCommandId || command.status !== "OBSERVED_MATCH" ||
    command.actionType !== "place_building" || command.authorizedScope.actionFamily !== "UTILITY" ||
    command.authorizedScope.utilityKind !== kind || command.authorizedScope.projectId !== scope.projectId ||
    command.authorizedScope.trancheId !== scope.trancheId || command.authorizedScope.reservationRef !== scope.reservationRef ||
    command.authorizedScope.worldEpochId !== scope.worldEpochId || command.authorizedScope.generation !== scope.generation ||
    (scope.placementScopeId !== undefined && command.authorizedScope.placementScopeId !== scope.placementScopeId)) return plan;
  let actions: unknown;
  try { actions = JSON.parse(command.authorizedScope.exactInput); } catch { return plan; }
  if (!Array.isArray(actions) || actions.length !== 1) return plan;
  const action = record(actions[0]);
  if (action.type !== "place_building" || action.prefab !== plan.prefab ||
    !Number.isFinite(Number(action.x)) || !Number.isFinite(Number(action.z))) return plan;
  // Native accepted and the durable command reconciled this exact placement
  // input. Rebind from that committed identity; the planner's site point can
  // differ from the native action point (for example, a snapped footprint).
  return { ...structuredClone(plan), position: { x: Number(action.x), z: Number(action.z) } };
};

export const utilityCommandMatchesPlacementScope = (input: {
  command: V2CommandRecord;
  kind: GreenfieldUtilityKind;
  scope: GreenfieldUtilityExecutionScope;
  currentPlacementScopeId?: string;
  currentCandidates?: Array<{ commandId: string | null; exactActions: MayorAction[] }>;
}): boolean => {
  const { command, kind, scope } = input;
  const authorized = command.authorizedScope;
  const expectedPlacementScopeId = input.currentPlacementScopeId ?? scope.placementScopeId ?? "utility-placement:legacy";
  const placementScopeMatches = (authorized.placementScopeId ?? "utility-placement:legacy") === expectedPlacementScopeId ||
    (expectedPlacementScopeId !== "utility-placement:legacy" &&
      (authorized.placementScopeId ?? "utility-placement:legacy") === "utility-placement:legacy" &&
      input.currentCandidates?.some((candidate) => candidate.commandId === command.commandId &&
        JSON.stringify(candidate.exactActions) === authorized.exactInput) === true);
  return command.actionFamily === "UTILITY" && authorized.actionFamily === "UTILITY" &&
    authorized.utilityKind === kind && authorized.projectId === scope.projectId &&
    authorized.trancheId === scope.trancheId && authorized.reservationRef === scope.reservationRef &&
    authorized.worldEpochId === scope.worldEpochId && authorized.generation === scope.generation &&
    placementScopeMatches;
};

/** Reconcile facility placement only from a complete, exact-prefab census. */
export const reconcileExactUtilityFacilityListing = (input: {
  commandId: string;
  action: Extract<MayorAction, { type: "place_building" }>;
  listed: unknown;
  worldId: string;
  generation: string;
  frameIndex?: number | null;
  recordedAt: string;
}): RestartReconciliationResult => {
  const listed = record(input.listed);
  const rows = Array.isArray(listed.buildings) ? listed.buildings.map(record) : [];
  const returned = Number(listed.returned);
  const totalMatches = Number(listed.totalMatches);
  const complete = Number.isInteger(returned) && Number.isInteger(totalMatches) &&
    returned === rows.length && returned === totalMatches && listed.truncated !== true &&
    listed.hasMore !== true && listed.complete !== false;
  const matches = rows.filter((item) => {
    const position = record(item.position);
    return item.prefab === input.action.prefab && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z)) &&
      Math.hypot(Number(position.x) - input.action.x, Number(position.z) - input.action.z) <= 1;
  });
  const evidence = {
    phase: "RECONCILIATION" as const,
    observationId: `utility-facility:${input.commandId}:${input.frameIndex ?? "current"}`,
    coherence: complete ? "STABLE_FRAME" as const : "UNKNOWN" as const,
    recordedAt: input.recordedAt,
    summary: "UTILITY_FACILITY_EXACT_PREFAB_CENSUS",
    details: {
      commandId: input.commandId,
      worldId: input.worldId,
      generation: input.generation,
      frameIndex: input.frameIndex ?? null,
      exactAction: input.action,
      query: input.action.prefab,
      completeness: { complete, returned: Number.isFinite(returned) ? returned : null,
        totalMatches: Number.isFinite(totalMatches) ? totalMatches : null,
        truncated: listed.truncated === true, hasMore: listed.hasMore === true },
      exactPositionMatchCount: matches.length,
      matchedEntities: matches.map((item) => ({ entity: item.entity, prefab: item.prefab, position: item.position })),
    },
  };
  if (!complete) return { result: "INCONCLUSIVE", reason: "UTILITY facility prefab census is incomplete", evidence };
  if (matches.length === 1) return { result: "MATCH", reason: "unique exact utility facility effect is present in a complete prefab census", evidence };
  if (matches.length === 0) return { result: "MISMATCH", reason: "complete authoritative prefab census proves the exact utility facility effect absent", effectAbsenceProven: true, evidence };
  return { result: "INCONCLUSIVE", reason: "utility facility readback found multiple exact-position matches", evidence };
};
import { rebindUtilityEndpoint, utilityActionIdentity, type BoundUtilityEndpoint, type UtilityEndpointBinding, type UtilityEndpointNodeObservation } from "./utility-endpoints";
import { advanceSequentialUtilityRepair, evaluateSegment2PostApplyTopology, type SequentialRepairObservation, type SequentialRepairState, type SequentialUtilityRepairPorts } from "./sequential-utility-repair";
import { matchNetworkLinkCourseEffect } from "./network-link-course-effect";
import { createNetEdgeCourseEffectMatcher } from "./utility-network-laying";
import {
  cityElectricityCapacityVerdict,
  FACILITY_ACCESS_ROAD_PREFAB,
  FACILITY_ACCESS_ROAD_REPAIR,
  facilityAccessRoadCourseCandidates,
  facilityAccessRoadRepairAttemptIndexFromLineage,
  facilityAccessRoadRepairLineage,
  nextFacilityAccessRoadRepairAttemptIndex,
  selectFacilityAccessRoadCourse,
} from "./facility-access-road";
import {
  bridgeTopologyRevision,
  electricityTargetEndpoint,
  reacquireAdmittedCourseTerminal,
  reacquirePreflightTargetRoad,
  reacquireTargetRoadByApprovedContact,
  resolveCurrentElectricityTarget,
  electricityTargetSemantics,
  narrowTargetRoadsByCertifiedRefs,
  type AdmittedNetCourseEdge,
  type ElectricityTargetTopologyObservation,
} from "./utility-target-binding";
import { prepareScopedUtilityExecution, utilityPlanningScope, type UtilityPreparationInput, type UtilityPreparationResult, type UtilityPreparationFailure } from "./utility-execution-planner";
import { ensureUtilityServiceRoadGoal, V2_GATE1_STATE_SCHEMA_VERSION } from "./gate1";
import { civicIsAffordable, SOLVENCY_TAX_AREAS, solvencyBudgetPlan, solvencyTaxPlan, type TaxArea } from "./solvency";
import {
  CIVIC_MAXIMUM_NATIVE_REJECTIONS,
  civicServicesWithEvidence,
  CIVIC_SETBACKS_METERS,
  civicPrefabFor,
  civicServicesOwed,
  civicSiteCandidates,
  type CivicServiceOutcome,
} from "./civic-service";
import { resolveCurrentUtilityBinding } from "./utility-current-binding";
import {
  admitFacilityAccessRoadBudgetAmendment,
  FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON,
  recordUtilityServiceRoadChildOperation,
} from "./utility-budget";
import {
  firstFacilityPlacementDurability,
  firstFacilityPlacementPermitted,
} from "./utility-placement-durability";
import {
  createV2ProjectAdmissionBootstrap,
  deriveCurrentBranchProjectReplanIdentity,
  V2_PROJECT_ADMISSION_POLICY,
  type V2ProjectAdmissionBootstrap,
  type V2ProjectSiteConstraint,
} from "./project-admission";
import { createWaterSiteConstraint } from "./water-site-constraint";

/** Reuse the formal site decision for its matching, still-unplaced scope. */
export function persistedUtilityPlacementPlanForScope(input: {
  utility?: DurableGreenfieldUtilityState["utilities"][UtilityRecoveryKind];
  placementScopeId?: string;
  connectionOnly?: boolean;
  placementUnattempted?: boolean;
  planningContext?: UtilityPlanningContext;
}): PlannedUtilityFacility | undefined {
  const utility = input.utility;
  if (input.connectionOnly === true ||
    (input.planningContext !== undefined && input.planningContext.mode !== "GREENFIELD_PLACEMENT") || !utility?.plan ||
    utility.placementScopeId !== (input.placementScopeId ?? "utility-placement:legacy") ||
    !(utility.stage === "MISSING" || (utility.stage === "BLOCKED" && input.placementUnattempted === true)) ||
    utility.facilityCommandId !== null || utility.facility !== null) return undefined;
  return structuredClone(utility.plan);
}

/** Align execution geometry to the live durable binding and its exact ledger candidate. */
export function bindUtilityPlanToCurrentCandidate(input: {
  plan: PlannedUtilityFacility;
  facility?: UtilityPlacementReceipt | null;
  connector?: UtilityConnectorReadback | null;
  candidate?: { kind: UtilityConnectionPrimitive; exactActions: MayorAction[] } | null;
}): PlannedUtilityFacility {
  const plan = structuredClone(input.plan);
  if (input.facility) plan.position = { x: input.facility.position.x, z: input.facility.position.z };
  // A bound endpoint pair describes an explicit network extension/reconnection
  // sourced from the authoritative topology. Its start is the existing network
  // terminal, which may differ from the facility's own connector. Preserve that
  // topology-derived geometry when refreshing the facility binding.
  if (input.connector && !plan.connectionEndpointBindings) plan.connection.start = { ...input.connector.worldPosition };
  const actions = input.candidate?.exactActions ?? [];
  if (input.candidate?.kind === "direct-cable" && actions.length === 1 && actions[0]?.type === "build_road" &&
    actions[0].prefab === ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) {
    plan.connection = {
      prefab: actions[0].prefab,
      start: { x: actions[0].x1, z: actions[0].z1 },
      end: { x: actions[0].x2, z: actions[0].z2 },
    };
  }
  if (input.candidate?.kind === "service-road" && actions.length > 0 && actions.every((action) =>
    action.type === "build_road" && action.prefab === "Small Road" &&
    [action.x1, action.z1, action.x2, action.z2].every(Number.isFinite))) {
    plan.serviceRoads = actions.map((action, index) => {
      if (action.type !== "build_road") throw new Error("UTILITY_SERVICE_ROAD_CANDIDATE_ACTION_INVALID");
      return { id: `selected-service-road-${index + 1}`, role: "side", start: { x: action.x1, z: action.z1 },
        end: { x: action.x2, z: action.z2 } };
    });
  }
  return plan;
}

/** Match a refreshed connection plan against its live source endpoint. */
export function utilityPlanStartMatchesCurrentBinding(
  plan: PlannedUtilityFacility,
  connector: UtilityConnectorReadback,
): boolean {
  const boundStart = plan.connectionEndpointBindings?.start?.expectedPosition;
  const expected = boundStart ?? connector.worldPosition;
  return Number.isFinite(expected.x) && Number.isFinite(expected.z) &&
    Math.hypot(plan.connection.start.x - expected.x, plan.connection.start.z - expected.z) <= 0.25;
}

export interface V2McpToolsManager {
  legacyList(): Promise<{ tools: Array<{ name: string }>; error?: unknown }>;
  legacyCall(options: {
    client: string;
    name: string;
    arguments: Record<string, unknown>;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface V2FoundationPorts {
  /** Temporary copy of latest authoritative domain observations; never a mutation gate. */
  worldState: DomainWorldStateCache;
  /**
   * T20 — whether the sewage recipe's environmental judgement can be made.
   *
   * Availability only. The judgement itself is per candidate and lives with the
   * plan; this answers the layer above it, so a Skill can report the contract's
   * BLOCKED_TELEMETRY instead of submitting a facility on a question nobody
   * could answer.
   */
  sewageEnvironmentalObservation(signal?: AbortSignal): Promise<{
    available: boolean;
    missingObservation?: string;
    detail?: string;
  }>;
  observation: V2ObservationPorts;
  commandJournal: V2CommandJournal;
  zoning: V2ZoningKernel;
  utilityService: TargetUtilityServicePorts;
  targetAccess: TargetAccessPorts;
  routeQuery: TargetRouteQueryPorts;
  readBuildingResidents(
    buildingRef: SpatialEntityRef,
    signal?: AbortSignal,
  ): Promise<V2SourcePayload<Gate1ResidentObservation>>;
  road: V2RoadKernel;
  greenfieldUtilityBootstrap: {
    run(scope: GreenfieldUtilityExecutionScope, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runScopedGreenfieldUtilityBootstrap>>>;
    prepare(input: UtilityPreparationInput, signal?: AbortSignal): Promise<UtilityPreparationResult>;
    planAlternateFacilitySite?(input: UtilityPreparationInput, signal?: AbortSignal): Promise<PlannedUtilityFacility>;
    markAwaitingProductDecision(scope: GreenfieldUtilityExecutionScope, kind: GreenfieldUtilityKind, reason: string): Promise<void>;
    repairFacilityAccessRoad(input: {
      scope: GreenfieldUtilityExecutionScope;
      actions: MayorAction[];
      expectedPlanRevision?: string;
    }, signal?: AbortSignal): Promise<{
      authorization: V2UtilityBudgetAmendmentRecord;
      execution: Awaited<ReturnType<V2RoadKernel["execute"]>>;
    }>;
    advanceSequentialUtilityRepair(input: {
      scope: GreenfieldUtilityExecutionScope;
      repairId: string;
      plan: { repairLineage: string; actions: readonly [MayorAction, MayorAction] };
      expectedQuoteByStep?: Partial<Record<1 | 2, number>>;
      stopAfterStep1Admission?: boolean;
      authorizeSegment2?: boolean;
    }, signal?: AbortSignal): Promise<{
      repair: Awaited<ReturnType<typeof advanceSequentialUtilityRepair>>;
      segment2FreshPreflight?: { candidate: import("./sequential-utility-repair").SequentialRepairCandidate; preview: import("./sequential-utility-repair").SequentialRepairPreview; admission: import("./sequential-utility-repair").SequentialRepairAdmission | null };
    }>;
  };
  durability?: V2DurabilityCoordinator;
  activateDurableWorld?(signal?: AbortSignal): Promise<ReturnType<V2DurabilityCoordinator["activate"]>>;
  /**
   * Read-only: observe the current world for one durable command's authorized
   * effect and append the result as superseding evidence. It never reopens,
   * rewrites, or re-executes the command, so a command proven to have left no
   * effect when it ran keeps that historical verdict while the current world is
   * free to be observed to contain the effect now.
   */
  observeCurrentWorldCommandEffect?(
    commandId: string,
    signal?: AbortSignal,
  ): Promise<{ effect: V2DescendantWorldEffect; observation: V2WorldObservationRecord | null }>;
  /**
   * The single production seam that turns an ACTIVATED world with an untouched
   * PLACEHOLDER project state into a durable, admitted Gate 1 project.
   */
  projectAdmission?: V2ProjectAdmissionBootstrap;
  /** Place the first public-service building the city is owed. Absent without durable storage. */
  civicServices?: { provide(signal?: AbortSignal): Promise<CivicServiceOutcome> };
  /** Raise tax rates one bounded step while the treasury runway is short. */
  solvency?: { ensure(signal?: AbortSignal): Promise<Array<{ area: string; rate: number }>> };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const exactNetworkLinkEnvelope = (action: Extract<MayorAction, { type: "build_road" }>) => {
  const length = Math.hypot(action.x2 - action.x1, action.z2 - action.z1);
  return { center: { x: (action.x1 + action.x2) / 2, z: (action.z1 + action.z2) / 2 }, radius: length / 2 + 0.25 };
};

const cloneUnknown = <T>(value: T): T => structuredClone(value);

/**
 * How far a current zoning cell may sit from the position a command recorded
 * for it and still be that same cell.
 *
 * Cells in this city are 8 m apart on the block grid, so the window has to stay
 * well inside that. A surviving cell's recorded and current positions agree to
 * hundredths of a metre; this is the same bounded-distance reasoning every other
 * identity key in the V2 layer uses.
 */
const ZONING_CELL_POSITION_TOLERANCE = 1;

/**
 * The window in which a cell counts as being *at* an authorized position even
 * when it no longer carries `CellFlags.Visible`.
 *
 * Half the block-grid spacing (cells are 8 m apart), and half the wider
 * tolerance, so a stray neighbour that shares the wider band can never be the
 * one picked: the point of this window is to be strict, not to be wide.
 */
const ZONING_CELL_VISIBLE_UNCONFIRMED_METERS = 0.5;

/**
 * Where a ZONING command's authorized cells are, independent of the generation
 * that named them.
 *
 * `scope.allowedCells` identifies cells by `block.index:block.version:cellIndex`,
 * and a block is a generation-local entity: after a reload the same physical
 * block is a different entity. A lookup keyed on those ids then misses
 * completely -- measured on this city, block `54423:1` is absent from the loaded
 * world while its cells are still there and still zoned -- so every zoning
 * command in the lineage reads as unprovable and the whole project stays
 * unconfirmed after any restart.
 *
 * The positions are already durable. The ZONING kernel records the entire
 * envelope read -- every cell with its coordinates -- into the command's
 * PRE_SUBMIT `observationEvidence` before it submits. So `allowedCells` decides
 * *which* cells were authorized and that same record says *where* they are. No
 * new durable field is invented, and the cell set is not widened: only the cells
 * the command actually named are ever read back.
 *
 * Returns null when the record cannot answer -- no PRE_SUBMIT evidence, or an
 * authorized cell the recorded read never saw. Callers must treat that as
 * unprovable rather than falling back to the generation-local ids.
 */
export function recordedZoningCellPositions(
  command: V2CommandRecord,
): Array<{ ref: ExactZoningCellRef; position: SpatialPoint2 }> | null {
  const scope = command.authorizedScope;
  if (scope.actionFamily !== "ZONING") return null;
  const evidence = command.observationEvidence.find((item) => item.phase === "PRE_SUBMIT");
  const cells = record(record(evidence).details).cells;
  if (!Array.isArray(cells)) return null;
  const byId = new Map<string, SpatialPoint2>();
  for (const raw of cells) {
    const cell = record(raw);
    const block = record(cell.block);
    const position = record(cell.position);
    if (!Number.isInteger(block.index) || !Number.isInteger(block.version) || !Number.isInteger(cell.index)) continue;
    if (typeof position.x !== "number" || typeof position.z !== "number") continue;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) continue;
    byId.set(`${Number(block.index)}:${Number(block.version)}:${Number(cell.index)}`, {
      x: position.x,
      z: position.z,
    });
  }
  const resolved: Array<{ ref: ExactZoningCellRef; position: SpatialPoint2 }> = [];
  for (const allowed of scope.allowedCells) {
    const position = byId.get(`${allowed.block.index}:${allowed.block.version}:${allowed.cellIndex}`);
    if (!position) return null;
    resolved.push({ ref: allowed, position });
  }
  return resolved;
}

/**
 * Whether every cell this ZONING command authorized still carries the category
 * it authorized, found at the position the command's own record gives for it.
 *
 * Deliberately strict, and strict in the same direction the ROAD matcher is:
 * every authorized cell must resolve to a current cell inside the bounded window
 * *and* that cell must carry the intended category. Anything else is
 * unprovable, never absent -- a cell this command never touched is not evidence
 * about the cells it did, and a widened envelope match would let any zoned cell
 * nearby stand in for the authorized set.
 */
export function matchRecordedZoningCells(input: {
  command: V2CommandRecord;
  currentCells: SpatialSiteDetail["zoningCells"];
}): { result: "MATCH" | "MISMATCH" | "INCONCLUSIVE"; reason: string } {
  const scope = input.command.authorizedScope;
  if (scope.actionFamily !== "ZONING" || !scope.intendedEffect) {
    return {
      result: "INCONCLUSIVE",
      reason: "authorized zoning cells carry no recorded position, so the current world cannot be read against them",
    };
  }
  const intended = scope.intendedEffect.zoneCategory;
  const recorded = recordedZoningCellPositions(input.command);
  if (!recorded || recorded.length === 0) {
    return {
      result: "INCONCLUSIVE",
      reason: "authorized zoning cells carry no recorded position, so the current world cannot be read against them",
    };
  }
  const preSubmit = input.command.observationEvidence.find((item) => item.phase === "PRE_SUBMIT");
  const preDetails = record(record(preSubmit).details);
  const rawCells = preDetails.cells;
  if (!Array.isArray(rawCells)) {
    return { result: "INCONCLUSIVE", reason: "PRE_SUBMIT zoning footprint was not recorded" };
  }
  const { center, radius } = scope.spatialEnvelope;
  const observedSpatialRadius = typeof preDetails.observedSpatialRadiusMeters === "number"
    ? preDetails.observedSpatialRadiusMeters
    : Math.max(64, radius); // Legacy PRE_SUBMIT records used max(64, radius).
  if (!Number.isFinite(observedSpatialRadius) || observedSpatialRadius < radius * Math.SQRT2) {
    return { result: "INCONCLUSIVE", reason: "PRE_SUBMIT spatial read does not cover the complete native marquee square" };
  }
  const authorizedKeys = new Set(scope.allowedCells.map((cell) =>
    `${cell.block.index}:${cell.block.version}:${cell.cellIndex}`,
  ));
  const recordedFootprint = rawCells.flatMap((raw) => {
    const cell = record(raw);
    const block = record(cell.block);
    const position = record(cell.position);
    if (
      cell.visible !== true || !Number.isInteger(block.index) || !Number.isInteger(block.version) ||
      !Number.isInteger(cell.index) || typeof position.x !== "number" || typeof position.z !== "number" ||
      !Number.isFinite(position.x) || !Number.isFinite(position.z) ||
      Math.abs(position.x - center.x) > radius || Math.abs(position.z - center.z) > radius
    ) return [];
    return [{
      key: `${Number(block.index)}:${Number(block.version)}:${Number(cell.index)}`,
      position: { x: position.x, z: position.z },
      zoneType: typeof cell.zoneType === "number" ? cell.zoneType : null,
      zoneCategory: typeof cell.zoneCategory === "string" ? cell.zoneCategory : null,
    }];
  });
  if (recordedFootprint.length === 0 || recordedFootprint.some((cell) => cell.zoneType === null || cell.zoneCategory === null)) {
    return { result: "INCONCLUSIVE", reason: "PRE_SUBMIT zoning marquee footprint is incomplete" };
  }
  // Only a cell the game would actually zone can be the cell this command
  // zoned. The recorded footprint above is built exclusively from
  // `visible === true` cells, so the current-world lookup must apply the same
  // predicate or it compares a filtered set against an unfiltered one: an
  // invisible neighbour of a different block sitting inside the 1 m tolerance
  // then reads as a second candidate and makes a present effect unprovable.
  // Measured live (2026-10-01) after a save reload: recorded cell `74929:23#3`
  // at (-22.9317, -80.7988) matched `50610:1#3` at distance 0.0000 (residential,
  // visible, roadside) AND an invisible `50551:1#27` at 0.94 m, so the whole
  // descendant confirmation failed and every Brain tick blocked on it.
  const currentAt = (position: SpatialPoint2) => {
    const matches = input.currentCells.filter((cell) =>
      cell.visible === true &&
      Math.hypot(cell.position.x - position.x, cell.position.z - position.z) <= ZONING_CELL_POSITION_TOLERANCE,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const baselineByKey = new Map(recordedFootprint.map((cell) => [cell.key, cell]));
  for (const allowed of scope.allowedCells) {
    const key = `${allowed.block.index}:${allowed.block.version}:${allowed.cellIndex}`;
    if (!baselineByKey.has(key)) {
      return { result: "INCONCLUSIVE", reason: `authorized zoning cell ${key} is outside the recorded native marquee footprint` };
    }
  }

  // Bridge emits a square Quad and GenerateZonesSystem selects every visible
  // cell center inside it. Compare the recorded native footprint, not only the
  // authorized subset, across a descendant save read.
  for (const cell of recordedFootprint) {
    const current = currentAt(cell.position);
    if (!current) return { result: "INCONCLUSIVE", reason: `native marquee cell at ${cell.position.x},${cell.position.z} is missing or ambiguous` };
    if (authorizedKeys.has(cell.key)) {
      if (current.zoneCategory !== intended) {
        return { result: "INCONCLUSIVE", reason: `authorized zoning cell ${cell.key} at ${cell.position.x},${cell.position.z} is not provably ${intended}` };
      }
    } else if (current.zoneType !== cell.zoneType || current.zoneCategory !== cell.zoneCategory) {
      return {
        result: "MISMATCH",
        reason: `unauthorized native marquee cell at ${cell.position.x},${cell.position.z} changed from ${cell.zoneCategory}/${cell.zoneType} to ${current.zoneCategory}/${current.zoneType}`,
      };
    }
  }
  for (const { ref, position } of recorded) {
    const current = input.currentCells.find(
      (cell) => cell.visible === true &&
        Math.hypot(cell.position.x - position.x, cell.position.z - position.z) <= ZONING_CELL_POSITION_TOLERANCE,
    );
    if (!current || current.zoneCategory !== intended) {
      return {
        result: "INCONCLUSIVE",
        reason:
          `cell ${ref.block.index}:${ref.block.version}:${ref.cellIndex} is not provably ${intended} ` +
          "at its recorded position",
      };
    }
  }
  return {
    result: "MATCH",
    reason: `all ${recorded.length} authorized zoning cell(s) still carry ${intended} at their recorded positions`,
  };
}

/**
 * Prove the exact authorized ZONING effects of a terminal command in a
 * descendant world. The command's original full-footprint matcher remains
 * authoritative for execution/reconciliation (including detecting unauthorized
 * marquee changes). Descendant confirmation asks the narrower persistence
 * question: each exact authorized cell, located through its own PRE_SUBMIT
 * identity-to-position evidence, must still be uniquely observable and carry
 * the intended category. Incidental non-authorized cells from the old marquee
 * read may since have been consumed or replaced by later world changes; that
 * cannot make the command's recorded authorized effects unprovable when those
 * exact cells are still present. A historical mismatch remains a mismatch in
 * the durable journal; this function does not rewrite or rehabilitate it.
 */
export function matchRecordedAuthorizedZoningEffect(input: {
  command: V2CommandRecord;
  currentCells: SpatialSiteDetail["zoningCells"];
}): { result: "MATCH" | "INCONCLUSIVE"; reason: string; visibleUnconfirmed?: number } {
  const { command, currentCells } = input;
  const scope = command.authorizedScope;
  const historicalSuccess = command.status === "OBSERVED_MATCH" && command.reconciliationStatus === "MATCH";
  const historicalMismatch = command.status === "OBSERVED_MISMATCH" && command.reconciliationStatus === "MISMATCH";
  if (
    scope.actionFamily !== "ZONING" || !scope.intendedEffect ||
    (!historicalSuccess && !historicalMismatch)
  ) {
    return { result: "INCONCLUSIVE", reason: "no terminally reconciled authorized ZONING effect is available" };
  }
  const positions = recordedZoningCellPositions(command);
  if (!positions || positions.length !== scope.allowedCells.length || positions.length === 0) {
    return { result: "INCONCLUSIVE", reason: "authorized zoning cells do not all have exact PRE_SUBMIT positions" };
  }
  const intended = scope.intendedEffect.zoneCategory;
  const distance = (position: { x: number; z: number }, cell: { position: { x: number; z: number } }) =>
    Math.hypot(cell.position.x - position.x, cell.position.z - position.z);
  let visibleUnconfirmed = 0;
  for (const { ref, position } of positions) {
    const band = currentCells.filter((cell) => distance(position, cell) <= ZONING_CELL_POSITION_TOLERANCE);
    // The recorded predicate: the position holds exactly ONE VISIBLE candidate.
    // Same predicate on both sides, for the same reason as `currentAt`: the
    // recorded position came from a visible-cell read, so an invisible
    // neighbour is not a second candidate — it is not a candidate at all.
    const visible = band.filter((cell) => cell.visible === true);
    if (visible.length === 1 && visible[0]?.zoneCategory === intended) continue;

    // The ONE relaxation, and it covers exactly one situation: the target cell
    // is itself no longer Visible.
    //
    // `CellFlags.Visible` is a state bit the simulation writes, and a cell keeps
    // its zone when it loses the bit. Leaving the zone out of this is how a
    // correct world becomes unprovable: measured 2026-10-02 on command
    // `687c1f35`, all 8 authorized cells sat at 0.00 m carrying `residential`
    // and all 8 read invisible, and a full 0.5 h simulation window
    // (11418507 -> 11423968) did not change a single one of them. The current
    // side's `visible` filter then deleted the only candidate and the lineage
    // stayed quarantined, refusing every durable write in the world.
    //
    // It is deliberately narrow. It applies only where the wider tolerance band
    // already holds exactly one candidate AND that candidate sits within half a
    // metre, so the invisible-neighbour flooding the `visible` predicate was
    // added to stop cannot come back: with two candidates in the band, the
    // visible filter above is final and this is not reached.
    const tight = band.filter((cell) => distance(position, cell) <= ZONING_CELL_VISIBLE_UNCONFIRMED_METERS);
    if (band.length === 1 && tight.length === 1 && tight[0]?.zoneCategory === intended) {
      visibleUnconfirmed += 1;
      continue;
    }
    return {
      result: "INCONCLUSIVE",
      reason: `authorized zoning cell ${ref.block.index}:${ref.block.version}:${ref.cellIndex} is not uniquely present at its recorded position with category ${intended}`,
    };
  }
  // A MATCH that rests on cells nobody can currently see is not the same fact as
  // one where every cell is still Visible, so it is said out loud rather than
  // folded into the same sentence.
  const visibility = visibleUnconfirmed > 0
    ? `; ${visibleUnconfirmed} of ${positions.length} carry the category but do NOT carry CellFlags.Visible, so their visibility is UNCONFIRMED`
    : "";
  return {
    result: "MATCH",
    ...(visibleUnconfirmed > 0 ? { visibleUnconfirmed } : {}),
    reason: (historicalMismatch
      ? `all ${positions.length} authorized zoning cell effect(s) from the historically mismatched command remain ${intended} at their exact recorded positions; the OBSERVED_MISMATCH/MISMATCH history is preserved`
      : `all ${positions.length} historically reconciled authorized zoning cell(s) remain ${intended} at their exact recorded positions`) + visibility,
  };
}

/**
 * How many service-road routes one authorized contact may put through the bounded
 * native preview. It is the existing ceiling `selectFeasibleRoadCandidate` already
 * clamps every caller to; the extra headroom over
 * `MAX_ROAD_FEASIBILITY_CANDIDATES` is what lets the heading fan stay inside the
 * probe after the corridor-duplicating heads are dropped. Still bounded, still
 * ordered, still previewed one at a time.
 */
const SERVICE_ROAD_PROBE_LIMIT = 12;

/**
 * Which net a placed facility serves, as the game names it.
 *
 * `cs2_list_buildings` returns `entity`, `prefab`, `isSubBuilding` and
 * `position` and nothing else — no capability, no service kind — so the prefab
 * name is the only evidence of what a standing building supplies. Substring
 * matching, because the families share prefixes (`SewageOutlet01`,
 * `SewageTreatmentPlant01`).
 */
const UTILITY_FACILITY_PREFAB_NETS: ReadonlyArray<{ contains: string; net: UtilityNetKind }> = [
  { contains: "WindTurbine", net: "ELECTRICITY" },
  { contains: "CoalPowerPlant", net: "ELECTRICITY" },
  { contains: "GasPowerPlant", net: "ELECTRICITY" },
  { contains: "SolarPowerPlant", net: "ELECTRICITY" },
  { contains: "TransformerStation", net: "ELECTRICITY" },
  { contains: "GroundwaterPumpingStation", net: "WATER" },
  { contains: "WaterPumpingStation", net: "WATER" },
  { contains: "WaterTreatment", net: "WATER" },
  { contains: "SewageOutlet", net: "SEWAGE" },
  { contains: "SewageTreatment", net: "SEWAGE" },
];

/** The recovery seam's lowercase kinds, as the reach report's uppercase nets. */
const UTILITY_NET_KIND_FOR_RECOVERY_KIND: Record<UtilityRecoveryKind, UtilityNetKind> = {
  electricity: "ELECTRICITY", water: "WATER", sewage: "SEWAGE",
};

const nonEmptyText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Extract only the bounded END telemetry belonging to this utility batch.
 * The raw Bridge payload is returned unchanged; the durable command journal
 * supplies the outer execution-command scope. Missing or uncorrelated data is
 * represented explicitly and never synthesized from geometry/topology.
 */
export function nativeCompletionTelemetryForUtilityBatch(
  batch: unknown,
  expectedBridgeCommandId?: string | null,
): unknown {
  const results = record(batch).results;
  if (!Array.isArray(results)) return { status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" };
  for (const value of results.slice(0, 20)) {
    const item = record(value);
    if (item.type !== "build_road") continue;
    const v2Road = record(item.v2Road);
    const candidates = [
      record(item.nativeCompletion).endRealizationTelemetry,
      record(v2Road.nativeCompletion).endRealizationTelemetry,
      record(item.nativeCompletionEvidence).endRealizationTelemetry,
      record(v2Road.nativeCompletionEvidence).endRealizationTelemetry,
      record(record(item.raw).nativeCompletion).endRealizationTelemetry,
    ];
    for (const candidate of candidates) {
      const telemetry = record(candidate);
      if (Object.keys(telemetry).length === 0) continue;
      if (typeof expectedBridgeCommandId === "string" && telemetry.commandId !== expectedBridgeCommandId) continue;
      const nativeCompletion = [item.nativeCompletion, v2Road.nativeCompletion, item.nativeCompletionEvidence, v2Road.nativeCompletionEvidence]
        .map(record)
        .find((completion) => completion.endRealizationTelemetry === candidate);
      const courseSplitDiagnostics = nativeCompletion
        ? nativeCompletion.courseSplitDiagnostics
        : undefined;
      const endpointContract = nativeCompletion
        ? nativeCompletion.endpointContract
        : undefined;
      return {
        ...(cloneUnknown(candidate) as Record<string, unknown>),
        ...(endpointContract !== undefined ? { endpointContract: cloneUnknown(endpointContract) } : {}),
        ...(courseSplitDiagnostics !== undefined ? { courseSplitDiagnostics: cloneUnknown(courseSplitDiagnostics) } : {}),
      };
    }
  }
  // NEW_FREE_ENDPOINT deliberately has no requested ECS END entity, so the
  // Bridge's legacy end-realization telemetry may be NOT_APPLICABLE. Preserve
  // the independent operation-scoped CourseSplit diagnostics anyway; this is
  // evidence transport only and must remain UNKNOWN until native topology
  // proves completion.
  for (const value of results.slice(0, 20)) {
    const item = record(value);
    if (item.type !== "build_road") continue;
    const v2Road = record(item.v2Road);
    const completions = [item.nativeCompletion, v2Road.nativeCompletion, item.nativeCompletionEvidence, v2Road.nativeCompletionEvidence]
      .map(record);
    for (const completion of completions) {
      const diagnostics = completion.courseSplitDiagnostics;
      if (diagnostics === undefined) continue;
      if (typeof expectedBridgeCommandId === "string" && completion.commandId !== expectedBridgeCommandId) continue;
      return {
        status: "UNKNOWN",
        ...(typeof completion.commandId === "string" ? { commandId: completion.commandId } : {}),
        unavailable: "END_REALIZATION_TELEMETRY_NOT_APPLICABLE",
        ...(completion.endpointContract !== undefined ? { endpointContract: cloneUnknown(completion.endpointContract) } : {}),
        courseSplitDiagnostics: cloneUnknown(diagnostics),
      };
    }
  }
  return { status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" };
}

export function withUtilityNativeCompletionEvidence(
  current: V2CommandRecord,
  batch: unknown,
  expectedBridgeCommandId?: string | null,
): V2CommandRecord {
  const evidence = nativeCompletionTelemetryForUtilityBatch(batch, expectedBridgeCommandId);
  const results = record(batch).results;
  const firstRoad = Array.isArray(results)
    ? results.slice(0, 20).map(record).find((item) => item.type === "build_road")
    : undefined;
  const sourceTrace = record(firstRoad?.telemetryTrace);
  const telemetryPresent = !(
    record(evidence).status === "UNKNOWN" &&
    record(evidence).unavailable === "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE"
  );
  return {
    ...current,
    nativeCompletionEvidence: evidence,
    nativeCompletionTelemetryTrace: {
      handlerTelemetryPresent: sourceTrace.handlerTelemetryPresent === true,
      batchItemTelemetryPresent: sourceTrace.batchItemTelemetryPresent === true,
      batchResultTelemetryPresent: sourceTrace.batchResultTelemetryPresent === true,
      ...sourceTrace,
      adapterInputTelemetryPresent: telemetryPresent,
      durableTelemetryPresent: telemetryPresent,
      ...(typeof expectedBridgeCommandId === "string" ? { commandId: expectedBridgeCommandId } : {}),
    },
  };
}

/** Bridge returns a facility envelope whose authoritative matcher payload is nested under topology. */
export function normalizeUtilityTopologyPayload(value: unknown): Record<string, unknown> {
  const payload = record(value);
  const topology = record(payload.topology);
  return Object.keys(topology).length > 0 ? topology : payload;
}

/**
 * Preserve only the bounded topology contract returned by the existing
 * cs2_utility_connectors topology read. This is evidence, not a second
 * matcher or utility state: command identity and Bridge-local correlation are
 * carried alongside the raw bounded records.
 */
export function buildUtilityTopologyEvidence(input: {
  topology: unknown;
  commandId: string;
  bridgeCommandId?: string | null;
  action: unknown;
  capturedAt: string;
}): Record<string, unknown> {
  const topology = normalizeUtilityTopologyPayload(input.topology);
  const bounded = {
    binding: topology.binding,
    connector: topology.connector,
    targetNetwork: topology.targetNetwork,
    admittedAction: topology.admittedAction,
    candidateScan: topology.candidateScan,
  };
  return {
    schemaVersion: "ai-mayor-v2-utility-topology-evidence/1",
    commandId: input.commandId,
    ...(typeof input.bridgeCommandId === "string" ? { bridgeCommandId: input.bridgeCommandId } : {}),
    capturedAt: input.capturedAt,
    action: cloneUnknown(input.action),
    topology: cloneUnknown(bounded),
  };
}

export function readNativeUtilityQuote(value: unknown, fallback: number): number {
  const result = record(value);
  const finance = record(result.finance);
  if (typeof result.signedAmount === "number" && Number.isFinite(result.signedAmount)) return Math.max(0, result.signedAmount);
  if (typeof finance.signedAmount === "number" && Number.isFinite(finance.signedAmount)) return Math.max(0, finance.signedAmount);
  return fallback;
}

export function matchUtilityCableTopology(input: {
  topology: unknown;
  action: MayorAction;
  target: SpatialEntityRef;
  tolerance?: number;
}): { result: "MATCH" | "MISMATCH" | "INCONCLUSIVE"; reason: string; effectAbsenceProven?: boolean; evidence?: unknown } {
  const topology = normalizeUtilityTopologyPayload(input.topology);
  if (input.action.type !== "build_road" || input.action.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) {
    return { result: "INCONCLUSIVE", reason: "unsupported utility cable action" };
  }
  const candidateScan = record(topology.candidateScan);
  const matchingEdges = Array.isArray(candidateScan.matchingEdges) ? candidateScan.matchingEdges : [];
  if (matchingEdges.length > 1) {
    return { result: "INCONCLUSIVE", reason: "utility topology has multiple exact candidate edges", evidence: { matchingEdgeCount: matchingEdges.length } };
  }
  const primitive = matchCablePrimitiveEffect({
    topology,
    action: input.action,
    connector: record(topology.connector).entity as unknown as SpatialEntityRef,
    tolerance: input.tolerance,
  });
  if (primitive.decision === "OBSERVED_MATCH") return { result: "MATCH", reason: primitive.reason, evidence: primitive.evidence };
  if (primitive.decision === "PROVEN_MISMATCH") return { result: "MISMATCH", reason: primitive.reason, effectAbsenceProven: true, evidence: primitive.evidence };
  return { result: "INCONCLUSIVE", reason: primitive.reason, evidence: primitive.evidence };
}

export function parseV2McpJson(result: unknown): unknown {
  const response = record(result);
  const content = Array.isArray(response.content) ? response.content : [];
  if (response.isError === true) {
    const blocks = content.map(record);
    const errorItem = blocks.find((item) => item.error !== undefined);
    const textItem = blocks.find((item) => item.type === "text" && typeof item.text === "string");
    const detail = errorItem?.error ?? textItem?.text ?? "MCP tool returned an error";
    const error = new Error(String(detail));
    if (typeof detail === "string") {
      try {
        const envelope = JSON.parse(detail) as Record<string, unknown>;
        if (typeof envelope.error === "string") Object.assign(error, { message: envelope.error, reason: envelope.error, status: envelope.status, commandId: envelope.commandId });
        for (const key of ["status", "commandId", "validation", "structural", "diagnostics", "rejectionDiagnostics", "nativeToolErrors"] as const) {
          if (envelope[key] !== undefined) Object.assign(error, { [key]: envelope[key] });
        }
        if (envelope.bridgeHttpErrorDiagnostics !== undefined) Object.assign(error, { bridgeHttpErrorDiagnostics: envelope.bridgeHttpErrorDiagnostics });
        if (envelope.mcpBridgeFailureDiagnostics !== undefined) Object.assign(error, { mcpBridgeFailureDiagnostics: envelope.mcpBridgeFailureDiagnostics });
        if (typeof envelope.commandId === "string") Object.assign(error, { bridgeCommandId: envelope.commandId });
        const diagnostics = normalizeNativeRoadDiagnostics(envelope);
        if (diagnostics) Object.assign(error, { nativeRoadDiagnostics: diagnostics, diagnostics });
      } catch {
        // Preserve the existing plain-text error behavior.
      }
    }
    throw error;
  }
  if (response.structuredContent !== undefined) return response.structuredContent;
  for (const item of content) {
    const block = record(item);
    if (block.type === "text" && typeof block.text === "string") {
      try {
        return JSON.parse(block.text);
      } catch {
        // Try the next text block.
      }
    }
  }
  throw new Error("MCP tool returned no JSON content");
}

type StructuredPreflightError = Error & {
  status?: unknown;
  commandId?: unknown;
  bridgeCommandId?: unknown;
  nativeRoadDiagnostics?: unknown;
  bridgeHttpErrorDiagnostics?: unknown;
  mcpBridgeFailureDiagnostics?: unknown;
  nativeToolErrors?: unknown;
  validation?: unknown;
  structural?: unknown;
  diagnostics?: unknown;
  rejectionDiagnostics?: unknown;
};

export function preserveUtilityPreflightError(error: unknown): UtilityPreflightResult {
  const source = error instanceof Error ? error as StructuredPreflightError : undefined;
  const reason = error instanceof Error ? error.message : String(error);
  const evidence: UtilityPreflightEvidence = {
    ...(typeof source?.status === "number" ? { status: source.status } : {}),
    ...(typeof source?.commandId === "string" ? { commandId: source.commandId } : {}),
    ...(typeof source?.bridgeCommandId === "string" ? { bridgeCommandId: source.bridgeCommandId } : {}),
    ...(source?.nativeRoadDiagnostics !== undefined ? { nativeRoadDiagnostics: source.nativeRoadDiagnostics } : {}),
    ...(source?.bridgeHttpErrorDiagnostics !== undefined ? { bridgeHttpErrorDiagnostics: source.bridgeHttpErrorDiagnostics } : {}),
    ...(source?.mcpBridgeFailureDiagnostics !== undefined ? { mcpBridgeFailureDiagnostics: source.mcpBridgeFailureDiagnostics } : {}),
    ...(source?.nativeToolErrors !== undefined ? { nativeToolErrors: source.nativeToolErrors } : {}),
    ...(source?.validation !== undefined ? { validation: source.validation } : {}),
    ...(source?.structural !== undefined ? { structural: source.structural } : {}),
    ...(source?.diagnostics !== undefined ? { diagnostics: source.diagnostics } : {}),
    ...(source?.rejectionDiagnostics !== undefined ? { rejectionDiagnostics: source.rejectionDiagnostics } : {}),
    ...(error instanceof Error ? { exceptionType: error.name, exceptionMessage: error.message } : { exceptionType: typeof error, exceptionMessage: reason }),
  };
  return { valid: false, reason, native: evidence };
}

export function parseV2SpatialSiteDetail(value: unknown): SpatialSiteDetail {
  const detail = record(value) as Partial<SpatialSiteDetail>;
  if (!detail.center || !detail.terrain || !detail.roadGraph) throw new Error("spatial site detail is incomplete");
  if (!Array.isArray(detail.roadGraph.edges) || !Array.isArray(detail.buildings) || !Array.isArray(detail.zoningCells)) {
    throw new Error("spatial site detail lacks roads, buildings, or zoning cells");
  }
  return detail as SpatialSiteDetail;
}

/**
 * The current-world roads a scoped utility plan is allowed to build against.
 *
 * A scope's `certifiedRoadRefs` name entities of the generation the ROAD was
 * built in, so after a reload the same road is a different entity and they
 * resolve to nothing: the authority filter would hand the planner an empty road
 * set and every utility would refuse. What survives a world generation is the
 * approved contact �?the delivered road's own endpoint, immutable geometry the
 * placement was authorized against �?so a ref set that no longer resolves is
 * reacquired from it through the existing current-generation reader, exactly as
 * the connection path already reacquires its target road.
 *
 * Only a single-ref authority that resolves to nothing is reacquired: a
 * multi-road authority that lost some of its roads cannot be rebuilt from one
 * contact, and picking one of them would silently narrow it. Same generation:
 * the recorded refs resolve and the authority is kept exactly as certified.
 * Every other outcome fails closed rather than widening the authority.
 */
export function scopeRoadAuthority(input: {
  certifiedRoadRefs: readonly SpatialEntityRef[];
  approvedContact: SpatialPoint2;
  currentWorldPlayerRoads: readonly SpatialRoadEdge[];
  /**
   * The admitted ROAD command's own prefab and far endpoint. Both are immutable
   * durable geometry, and both are needed to reacquire the road once the game
   * has split the delivered course into several edges sharing its contact node.
   */
  certifiedRoadPrefab?: string;
  certifiedRoadFarEndpoint?: SpatialPoint2;
}): SpatialRoadEdge[] {
  const allowed = new Set(input.certifiedRoadRefs.map((ref) => `${ref.index}:${ref.version}`));
  if (allowed.size === 0) return [...input.currentWorldPlayerRoads];
  const recorded = input.currentWorldPlayerRoads.filter((edge) =>
    allowed.has(`${edge.entity.index}:${edge.entity.version}`),
  );
  if (recorded.length === input.certifiedRoadRefs.length) return recorded;
  if (recorded.length > 0 || input.certifiedRoadRefs.length !== 1) {
    throw new Error("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  }
  const reacquired = reacquireTargetRoadByApprovedContact({
    edges: [...input.currentWorldPlayerRoads],
    approvedContact: input.approvedContact,
    ...(input.certifiedRoadPrefab === undefined ? {} : { prefab: input.certifiedRoadPrefab }),
    ...(input.certifiedRoadFarEndpoint === undefined ? {} : { farEndpoint: input.certifiedRoadFarEndpoint }),
  });
  if (reacquired.status !== "YES") throw new Error("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
  return [reacquired.road];
}

const timeoutLike = (error: unknown) =>
  error instanceof V2SubmissionTimeoutError ||
  (error instanceof Error && (error.name === "AbortError" || /timed?\s*out|timeout/i.test(error.message)));

/**
 * Whether the world contains a continuous course of same-prefab net edges
 * running from `start` to `end`.
 *
 * A single authorized primitive is not one edge. The native side splits a course
 * wherever it needs a node �?the live water pipe was realized as two
 * `Small Water Pipe` edges meeting at a midpoint �?so matching one edge's
 * endpoints against the action's is a test of how the game happened to
 * tessellate the course, not of whether the course exists. What was authorized
 * is the course, so the course is what gets checked. A course realized as one
 * edge degenerates to the single-edge case.
 */
export function netCourseCovered(input: {
  edges: readonly { prefab: string; start: SpatialPoint2; end: SpatialPoint2 }[];
  prefab: string;
  start: SpatialPoint2;
  end: SpatialPoint2;
  tolerance: number;
  /**
   * The control vertex, when the submitted course is a curve.
   *
   * A curved course is not its chord, so a chain that only spans the two
   * anchors does not cover it. Each hop of the walk is therefore tested
   * against the course itself, and the chord that a bowed course was cut from
   * is refused: its midpoint lies the bow's own amplitude off the course.
   * Without a control vertex the walk is exactly the straight one it has
   * always been.
   */
  control?: SpatialPoint2;
}): boolean {
  const near = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z) <= input.tolerance;
  const control = input.control;
  const onCourse = (point: SpatialPoint2): boolean => {
    if (!control) return true;
    for (let step = 0; step <= 32; step += 1) {
      const t = step / 32;
      const inverse = 1 - t;
      const x = inverse * inverse * input.start.x + 2 * inverse * t * control.x + t * t * input.end.x;
      const z = inverse * inverse * input.start.z + 2 * inverse * t * control.z + t * t * input.end.z;
      if (Math.hypot(point.x - x, point.z - z) <= input.tolerance) return true;
    }
    return false;
  };
  if (near(input.start, input.end)) return true;
  const remaining = input.edges.filter((edge) => edge.prefab === input.prefab);
  let cursor = input.start;
  for (;;) {
    // Each step consumes an edge, so the walk cannot cycle; an exhausted set is
    // the refusal rather than a bound that has to be counted.
    const next = remaining.find((edge) => near(edge.start, cursor) || near(edge.end, cursor));
    if (!next) return false;
    remaining.splice(remaining.indexOf(next), 1);
    const far = near(next.start, cursor) ? next.end : next.start;
    // The hop leaves the authorised course if either its middle or its far end
    // is off it: a road that merely passes near a bowed course is a different
    // road. Both tests are open only to a curved course.
    if (!onCourse({ x: (cursor.x + far.x) / 2, z: (cursor.z + far.z) / 2 }) || !onCourse(far)) return false;
    cursor = far;
    if (near(cursor, input.end)) return true;
  }
}

/**
 * The node-snap tolerance a committed ROAD course is read back out of the
 * CURRENT world with.
 *
 * Deliberately the SAME number the cable and pipe course readers beside it
 * already use for exactly this job (`exactActionScope ? 0.25 : 1.5`). A road
 * reconciled against a looser standard than the pipes laid under it would not
 * be a better proof, it would be a different one — and the whole point of this
 * reader is that the game's own consolidation is allowed for, not that a road
 * which is merely near the committed one counts as the committed one.
 */
export const COMMITTED_ROAD_COURSE_COVERAGE_TOLERANCE_METERS = 1.5;

/** How many points along a committed course the coverage proof tests. */
const COMMITTED_ROAD_COURSE_COVERAGE_SAMPLES = 64;

/**
 * Whether the current authoritative road network still covers a committed
 * course, as a proof rather than a relaxed comparison.
 *
 * A course survives the game's own consolidation — a later road splitting it at
 * a new junction, a collinear neighbour merging it into one longer edge, a
 * normalize pass rebuilding it — with different edges than were authorized and
 * the same road on the ground. Edge identity is therefore the wrong question to
 * stop at, and so is a chain walk: a merged course is a SUB-SEGMENT of a longer
 * edge, which no walk from its endpoints can find.
 *
 * The question asked instead is the one that actually matters: is every point of
 * the committed course still on a same-prefab road? It is tested at a bounded
 * number of points along the course itself — the quadratic the course was
 * authorized as when it carries a control vertex, its straight chord otherwise —
 * and each point must lie within the shared node-snap tolerance of a current
 * same-prefab edge. Nothing is derived from the candidate edges: an edge only
 * ever answers "is this point on you", so no arrangement of unrelated roads can
 * add up to coverage.
 *
 * It fails closed in every direction it cannot see. An unreadable or bounded
 * current-world read proves nothing, and a course one point of which is off the
 * network is not covered — which is what keeps a committed road the game really
 * did remove reading as `EFFECT_ABSENT`.
 */
export function committedRoadCourseCoverage(input: {
  exactInput: Record<string, unknown>;
  currentWorldRoads: SpatialSiteDetail["roadGraph"] | null;
}): { covered: boolean; evidence: string } {
  const graph = input.currentWorldRoads;
  if (!graph) return { covered: false, evidence: "the bounded current-world road read was not available" };
  const prefab = String(input.exactInput.prefab ?? "");
  const edges = graph.edges
    .filter((edge) => edge.native && edge.deleted !== true && edge.temp !== true && edge.prefab === prefab)
    .map((edge) => ({ start: edge.start, end: edge.end }));
  const start = { x: Number(input.exactInput.x1), z: Number(input.exactInput.z1) };
  const end = { x: Number(input.exactInput.x2), z: Number(input.exactInput.z2) };
  const control = typeof input.exactInput.cx === "number" && typeof input.exactInput.cz === "number"
    ? { x: Number(input.exactInput.cx), z: Number(input.exactInput.cz) }
    : undefined;
  const tolerance = COMMITTED_ROAD_COURSE_COVERAGE_TOLERANCE_METERS;
  const pointOnSegment = (point: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2): number => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const ratio = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared))
      : 0;
    return Math.hypot(point.x - (a.x + ratio * dx), point.z - (a.z + ratio * dz));
  };
  let worstOffCourse = 0;
  let covered = true;
  for (let step = 0; covered && step <= COMMITTED_ROAD_COURSE_COVERAGE_SAMPLES; step += 1) {
    const t = step / COMMITTED_ROAD_COURSE_COVERAGE_SAMPLES;
    const inverse = 1 - t;
    const point = control
      ? { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
          z: inverse * inverse * start.z + 2 * inverse * t * control.z + t * t * end.z }
      : { x: start.x + t * (end.x - start.x), z: start.z + t * (end.z - start.z) };
    const nearest = edges.reduce(
      (best, edge) => Math.min(best, pointOnSegment(point, edge.start, edge.end)),
      Number.POSITIVE_INFINITY,
    );
    worstOffCourse = Math.max(worstOffCourse, nearest);
    if (!(nearest <= tolerance)) covered = false;
  }
  const suffix = `prefab=${prefab}, tolerance=${tolerance}m, ` +
    `candidateEdges=${edges.length}, worstOffCourse=${Number.isFinite(worstOffCourse) ? worstOffCourse.toFixed(2) : "none"}m`;
  return {
    covered,
    evidence: covered
      ? `every point of the committed course is still on a same-prefab road (${suffix})`
      : `part of the committed course is no longer on a same-prefab road (${suffix})`,
  };
}

export interface ExactNetCourseReadback {
  result: "MATCH" | "MISMATCH" | "UNPROVEN";
  evidence: {
    source: "cs2_list_roads";
    complete: boolean;
    prefab: string;
    course: { start: SpatialPoint2; end: SpatialPoint2 };
    tolerance: number;
    matchedEdges: Array<{
      entity: SpatialEntityRef;
      prefab: string;
      start: SpatialPoint2;
      end: SpatialPoint2;
    }>;
    reason: string;
  };
}

/**
 * Match a submitted straight net course to concrete, permanent world edges.
 * Unlike `netCourseCovered`, this does not accept an arbitrary connected path:
 * every edge endpoint must lie on the exact submitted segment, and the whole
 * segment must be covered monotonically without gaps. The caller must pass the
 * complete `cs2_list_roads` result; spatial graph topology is only a candidate
 * source and cannot certify a command effect.
 */
export function matchExactNetCourseReadback(input: {
  prefab: string;
  start: SpatialPoint2;
  end: SpatialPoint2;
  roads: unknown;
  totalMatches: unknown;
  returned: unknown;
  truncated?: unknown;
  hasMore?: unknown;
  tolerance?: number;
  /**
   * The control vertex, when the submitted course is a curve.
   *
   * A curved course is not its chord: comparing a curve against the chord
   * corridor answers a question about a different course, and for a bow of 12 m
   * the two disagree by far more than the tolerance. With the control vertex
   * supplied, proximity is taken against the course itself.
   */
  control?: SpatialPoint2;
}): ExactNetCourseReadback {
  const tolerance = input.tolerance ?? 1;
  const vectorX = input.end.x - input.start.x;
  const vectorZ = input.end.z - input.start.z;
  const length = Math.hypot(vectorX, vectorZ);
  const along = (point: SpatialPoint2) =>
    length === 0 ? 0 : ((point.x - input.start.x) * vectorX + (point.z - input.start.z) * vectorZ) / length;
  const pointAt = (distance: number): SpatialPoint2 => ({
    x: input.start.x + vectorX * (distance / length),
    z: input.start.z + vectorZ * (distance / length),
  });
  const distanceToPoint = (left: SpatialPoint2, right: SpatialPoint2) => Math.hypot(left.x - right.x, left.z - right.z);
  const near = (left: SpatialPoint2, right: SpatialPoint2) => distanceToPoint(left, right) <= tolerance;
  const coursePoint = (step: number): SpatialPoint2 => {
    if (!input.control) return pointAt(Math.max(0, Math.min(length, step)));
    const t = step / length;
    const inverse = 1 - t;
    return {
      x: inverse * inverse * input.start.x + 2 * inverse * t * input.control.x + t * t * input.end.x,
      z: inverse * inverse * input.start.z + 2 * inverse * t * input.control.z + t * t * input.end.z,
    };
  };
  // Sampled rather than projected: the nearest point on a quadratic Bezier has
  // no closed form worth the risk here, and a bounded sampling answers the only
  // question asked -- whether an existing endpoint lies on the submitted course.
  // Without a control vertex this is the chord test the caller already relied on.
  const onCourse = (point: SpatialPoint2): boolean => {
    if (!input.control) return near(point, pointAt(Math.max(0, Math.min(length, along(point)))));
    for (let step = 0; step <= 32; step += 1) {
      if (distanceToPoint(point, coursePoint((length * step) / 32)) <= tolerance) return true;
    }
    return false;
  };
  const complete =
    Array.isArray(input.roads) &&
    Number.isInteger(input.totalMatches) && Number(input.totalMatches) >= 0 &&
    Number.isInteger(input.returned) && Number(input.returned) === input.roads.length &&
    Number(input.returned) === Number(input.totalMatches) &&
    input.truncated !== true && input.hasMore !== true;
  const base = {
    source: "cs2_list_roads" as const,
    complete,
    prefab: input.prefab,
    course: { start: input.start, end: input.end },
    tolerance,
  };
  if (!complete || length <= 0 || !Number.isFinite(length)) {
    const reason = input.truncated === true || input.hasMore === true
      ? "authoritative net entity list is truncated"
      : !complete
        ? "authoritative net entity list is incomplete"
        : "submitted course geometry is invalid";
    return { result: "UNPROVEN", evidence: { ...base, matchedEdges: [], reason } };
  }
  const roadEntries = input.roads as unknown[];
  let malformedMatchingEntity = false;
  const edges = roadEntries.map((raw) => {
    const item = record(raw);
    if (item.prefab !== input.prefab) return null;
    const entity = record(item.entity);
    const start = record(item.start);
    const end = record(item.end);
    if (
      !Number.isInteger(entity.index) || !Number.isInteger(entity.version) ||
      ![start.x, start.z, end.x, end.z].every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      malformedMatchingEntity = true;
      return null;
    }
    const a = { x: Number(start.x), z: Number(start.z) };
    const b = { x: Number(end.x), z: Number(end.z) };
    const ta = along(a);
    const tb = along(b);
    if (ta < -tolerance || tb < -tolerance || ta > length + tolerance || tb > length + tolerance ||
      !onCourse(a) || !onCourse(b) ||
      Math.abs(ta - tb) <= tolerance / 10) return null;
    return {
      entity: { index: Number(entity.index), version: Number(entity.version) },
      prefab: input.prefab,
      start: a,
      end: b,
      low: Math.min(ta, tb),
      high: Math.max(ta, tb),
    };
  }).filter((edge): edge is NonNullable<typeof edge> => edge !== null);
  if (malformedMatchingEntity) {
    return { result: "UNPROVEN", evidence: { ...base, complete: false, matchedEdges: [], reason: "authoritative list contains a malformed same-prefab entity record" } };
  }
  let cursor = 0;
  const used = new Set<string>();
  const matchedEdges: ExactNetCourseReadback["evidence"]["matchedEdges"] = [];
  while (cursor < length - tolerance) {
    const candidates = edges.filter((edge) => {
      const key = `${edge.entity.index}:${edge.entity.version}`;
      return !used.has(key) && edge.low <= cursor + tolerance && edge.high > cursor + tolerance / 10;
    });
    if (candidates.length !== 1) break;
    const edge = candidates[0]!;
    used.add(`${edge.entity.index}:${edge.entity.version}`);
    matchedEdges.push({ entity: edge.entity, prefab: edge.prefab, start: edge.start, end: edge.end });
    cursor = edge.high;
  }
  const matched = cursor >= length - tolerance && matchedEdges.length > 0;
  return {
    result: matched ? "MATCH" : "MISMATCH",
    evidence: {
      ...base,
      matchedEdges,
      reason: matched
        ? "complete authoritative entity list contains a unique same-prefab edge chain covering the exact submitted straight course"
        : "complete authoritative entity list contains no unique same-prefab edge chain covering the exact submitted straight course",
    },
  };
}

export function createV2FoundationPorts(options: {
  getToolsManager(): V2McpToolsManager;
  runtimeEpoch?: string;
  now?: () => Date;
  createId?: () => string;
  durableStateStorage?: V2DurableStateStorage;
  baselineSaveCompletionChecks?: number;
  baselineSavePollMs?: number;
  /**
   * Whether the Mayor may drive a native save of its own to obtain the durable
   * descendant rollback boundary.
   *
   * The product turns this on. An unattended Mayor cannot wait for a human to
   * choose a save point, and the boundary it creates is its own uniquely named
   * save, so a player's save is never overwritten. Manual saving remains
   * available as an explicit checkpoint; it is simply no longer the mandatory
   * step in the ordinary recovery path.
   *
   * What a save has to *prove* is unchanged by this flag and is not relaxed by
   * it: the receipt must still be COMPLETED, durable, and carry this exact
   * world, generation and native session (`matchesWorldSave`), and an existing
   * adoptable save is still looked for before one is ever submitted. The flag
   * decides only whether the Mayor may produce a boundary, never what counts as
   * one.
   *
   * The default here stays explicit rather than on because the certification
   * harnesses exercise the "wait for the user's save" policy deliberately and
   * must keep testing it; the product construction opts in.
   */
  automaticRecoverySave?: boolean;
  /**
   * The domain requirement the project being admitted must satisfy at its site.
   *
   * Absent is the product default and means "no domain precondition beyond what
   * the site evaluator already sees", which is the electricity path: it admits
   * against owned local frontage and never reaches the ingress seed. A domain
   * that needs something the evaluator cannot see �?water needs a source �?   * supplies its constraint here, and only then can admission escalate past
   * local frontage.
   */
  projectSiteConstraint?: V2ProjectSiteConstraint;
  beforeUtilityNativeExecute?: (input: PhaseAUtilityExecutePortInput) => void | Promise<void>;
  afterUtilityKindCertified?: (input: PhaseBElectricityCertificationInput) => void | Promise<void>;
}): V2FoundationPorts {
  const worldState = new DomainWorldStateCache();
  const callTool = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const manager = options.getToolsManager();
    const listed = await manager.legacyList();
    const tool = listed.tools.find((candidate) => candidate.name.endsWith(`--${name}`));
    if (!tool) throw new Error(`Required MCP tool is not connected: ${name}`);
    const separator = tool.name.indexOf("--");
    const client = tool.name.slice(0, separator);
    return parseV2McpJson(
      await manager.legacyCall({ client, name, arguments: args, requestId: crypto.randomUUID(), signal }),
    );
  };
  /**
   * The blocking-modal guard, for the simulation drivers in THIS module.
   *
   * `blocking-modal-guard.ts` states the rule: "Future simulation drivers must
   * call this bounded hook before advancing time." A milestone popup PAUSES the
   * game the moment it mounts, so a driver that submits `cs2_run_simulation`
   * without the hook polls a frame index that never moves and reports
   * `simulation paused before target frame` — every tick, forever.
   *
   * Measured live (2026-10-02): a whole growth run made 8 `cs2_run_simulation`
   * calls and **zero** `cs2_read_blocking_modal` calls, and the game clock did
   * not advance a single frame across three runs — `frame=11121294`,
   * `gameTime=2026-01-09 07:14`, frozen for the entire session. The guard had
   * been attached to `main-adapters.ts`'s `runSimulation` (the 2026-10-01 fix)
   * and this module's own driver was missed, which is the same mistake that fix
   * was written to end: it has to be at every driver, not at most of them.
   */
  const blockingModal = createBlockingModalRuntimePort({
    call: (name, args, signal) => callTool(name, args, signal),
  });
  const worldIdentityFromGameState = (value: unknown): WorldStateIdentity | null => {
    const game = record(value); const world = record(game.world);
    const worldId = nonEmptyText(world.worldId); const generation = nonEmptyText(world.generation);
    if (!worldId || !generation) return null;
    return { worldId, generation, checkpointId: nonEmptyText(world.checkpointId) };
  };

  const waitForNativeIdle = async (signal?: AbortSignal) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const game = record(await callTool("cs2_game_state", {}, signal));
      const world = record(game.world);
      if (world.nativeOperationBusy !== true && world.nativeOperationStage === "Idle") return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("utility bootstrap aborted"));
        }, { once: true });
      });
    }
    throw new Error("UTILITY_NATIVE_OPERATION_BUSY_UNRESOLVED");
  };

  // Shared read-only native construction feasibility request. Both Planner's
  // Water candidate filter and Utility Recovery use this exact preflight shape.
  const constructionPreflightPreview = async (
    action: MayorAction,
    signal?: AbortSignal,
    endpoints?: { startEndpoint?: unknown; endEndpoint?: unknown },
  ) => {
    await waitForNativeIdle(signal);
    const value = action.type === "place_building"
      ? await callTool("cs2_spatial", { mode: "preflight", kind: "object", prefab: action.prefab, x: action.x, z: action.z, rotation: action.rotation ?? 0 }, signal)
      : action.type === "build_road"
        ? await callTool("cs2_spatial", { mode: "preflight", kind: "net", ...roadCourseGeometry(action),
            ...(endpoints?.startEndpoint ? { startEndpoint: endpoints.startEndpoint } : {}),
            ...(endpoints?.endEndpoint ? { endEndpoint: endpoints.endEndpoint } : {}) }, signal)
        : null;
    await waitForNativeIdle(signal);
    return record(value);
  };

  const source = async <T>(read: () => Promise<T>): Promise<V2SourcePayload<T>> => availableSource(await read());
  const readers = {
    readGameState: (signal?: AbortSignal) => source(() => callTool("cs2_game_state", {}, signal)),
    readSnapshot: (signal?: AbortSignal) => source(() => callTool("cs2_mayor_snapshot", {}, signal)),
    readSpatialScan: (signal?: AbortSignal) =>
      source(() => callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal)),
    readSpatialDetail: (request: V2SpatialDetailRequest, signal?: AbortSignal) =>
      source(async () =>
        parseV2SpatialSiteDetail(
          await callTool(
            "cs2_spatial",
            {
              mode: "detail",
              x: request.x,
              z: request.z,
              radius: request.radius,
              resolution: request.resolution ?? 24,
            },
            signal,
          ),
        ),
      ),
    // The listing that DOES hold net edges. `cs2_spatial` is a road-graph view
    // and excludes pipes and cables by prefab component, so a net course can
    // only be certified against this one; its total-vs-returned counts are the
    // completeness contract (it has no truncated flag of its own).
    readNetEdges: (prefabs: readonly string[], signal?: AbortSignal) =>
      source(async () => {
        const listings: Record<string, unknown> = {};
        for (const prefab of prefabs) {
          const listed = record(await callTool("cs2_list_roads", { query: prefab, limit: 500 }, signal));
          listings[prefab] = {
            prefab,
            roads: Array.isArray(listed.roads) ? listed.roads : [],
            totalMatches: listed.totalMatches,
            returned: listed.returned,
            ...(listed.truncated === undefined ? {} : { truncated: listed.truncated }),
            ...(listed.hasMore === undefined ? {} : { hasMore: listed.hasMore }),
          };
        }
        return { listings };
      }),
  };
  /**
   * T20 — the game's own surface-water observation, as the Bridge reports it.
   *
   * One whole-map read, cached for the life of this adapter. The grid is a
   * property of the loaded world rather than of a candidate, so re-reading it
   * inside a bounded site search would multiply the search's cost without
   * changing any answer. A failed read is NOT cached: that would turn one
   * transient transport error into a permanent missing observation.
   */
  let waterFlowObservation: WaterFlowObservation | null = null;
  const readWaterFlowObservation = async (signal?: AbortSignal): Promise<WaterFlowObservation> => {
    if (waterFlowObservation) return waterFlowObservation;
    let parsed: WaterFlowObservation;
    try {
      parsed = parseWaterFlowObservation(
        await callTool("cs2_terrain", { resolution: WATER_FLOW_OBSERVATION_RESOLUTION }, signal),
      );
    } catch {
      parsed = unavailableWaterFlowObservation();
    }
    if (parsed.available) waterFlowObservation = parsed;
    return parsed;
  };
  /**
   * Which water intakes the world actually has, by authoritative listing.
   *
   * Only a completed listing counts. A truncated one is a count that stopped,
   * and reading it as "these are all the intakes" is how a discharge that really
   * does reach a pump would be certified as safe.
   */
  let waterIntakeCensus: SewageIntakeCensus | null = null;
  const readWaterIntakeCensus = async (
    assets: readonly SpatialBootstrapAsset[],
    signal?: AbortSignal,
  ): Promise<SewageIntakeCensus> => {
    if (waterIntakeCensus) return waterIntakeCensus;
    const intakePrefabs = assets
      .filter((asset) => !asset.locked && asset.capabilities.freshWaterCapacity > 0)
      .map((asset) => asset.prefab)
      .filter((prefab, index, all) => all.indexOf(prefab) === index)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAXIMUM_WATER_INTAKE_PREFAB_QUERIES);
    const intakes: Array<{ prefab: string; position: { x: number; z: number } }> = [];
    let available = true;
    for (const prefab of intakePrefabs) {
      let listed: Record<string, unknown>;
      try {
        listed = record(await callTool("cs2_list_buildings", { query: prefab, limit: 200 }, signal));
      } catch {
        available = false;
        continue;
      }
      const buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : [];
      const complete = listed.complete === true ||
        (Number.isInteger(listed.totalMatches) && Number.isInteger(listed.returned) &&
          Number(listed.returned) === buildings.length && Number(listed.returned) === Number(listed.totalMatches));
      if (!complete) available = false;
      for (const building of buildings) {
        const position = record(building.position);
        const x = Number(position.x);
        const z = Number(position.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        intakes.push({ prefab: String(building.prefab ?? prefab), position: { x, z } });
      }
    }
    // A read that failed stays uncached so the next caller can retry it; a
    // complete census is a world fact and is cached like one.
    if (available) waterIntakeCensus = { available: true, intakes };
    return available ? { available: true, intakes } : { available: false, intakes };
  };
  const observation = createV2ObservationPorts({
    readers,
    runtimeEpoch: options.runtimeEpoch,
    now: options.now,
    createId: options.createId,
  });
  const durability = options.durableStateStorage
    ? new V2DurabilityCoordinator(options.durableStateStorage, options.now)
    : undefined;
  // The ROAD effect matcher is only authoritative for a command whose durable
  // world lineage this store can name, so it resolves its provenance from the
  // same durability store the rest of the activation rests on. Without a
  // durable store there is no lineage to attribute an observation to, and the
  // matcher fails closed on every ROAD command rather than certifying a
  // topology it cannot place in a world.
  const roadEffectMatcher = createAuthoritativeRoadEffectMatcher({
    resolveProvenance: (command) => durability?.roadObservationProvenance(command.commandId) ?? null,
  });
  // One kernel, two views. A course whose prefab is a pipe or a cable is judged
  // against the net edge listing, because the road graph cannot hold it; every
  // other course goes to the road matcher untouched. The dispatch is by prefab
  // and is asked before the world is read, so a road course captures exactly the
  // observation it always did and pays nothing for this.
  const effectMatcher = createNetEdgeCourseEffectMatcher({
    road: roadEffectMatcher,
    resolveProvenance: (command) => durability?.roadObservationProvenance(command.commandId) ?? null,
  });
  const observeExactUtilityNetCourse = async (
    command: V2CommandRecord,
    scope: { exactInput?: string; topologyRevision?: string; utilityKind?: string },
    action: Extract<MayorAction, { type: "build_road" }>,
    phase: "RECONCILIATION" | "CURRENT_WORLD",
    signal?: AbortSignal,
  ) => {
    // cs2_spatial is a bounded road-graph view and can contain an unrelated
    // historical path. It is never accepted as positive command-effect proof.
    // cs2_list_roads exposes entity ids and exact edge geometry; its total vs
    // returned counts are the completeness contract (it has no truncated flag).
    const listed = record(await callTool("cs2_list_roads", { query: action.prefab, limit: 500 }, signal));
    const match = matchExactNetCourseReadback({
      prefab: action.prefab,
      start: { x: action.x1, z: action.z1 },
      end: { x: action.x2, z: action.z2 },
      ...(action.cx !== undefined && action.cz !== undefined ? { control: { x: action.cx, z: action.cz } } : {}),
      roads: listed.roads,
      totalMatches: listed.totalMatches,
      returned: listed.returned,
      truncated: listed.truncated,
      hasMore: listed.hasMore,
      tolerance: 1,
    });
    const details = {
      commandId: command.commandId,
      exactInput: scope.exactInput,
      courseFingerprint: JSON.stringify(action),
      planRevision: scope.topologyRevision,
      utilityKind: scope.utilityKind,
      matchSource: match.evidence.source,
      courseMatch: match.evidence,
    };
    const evidence = {
      phase: "RECONCILIATION" as const,
      observationId: `utility-net:${command.commandId}:${Date.now()}`,
      coherence: match.evidence.complete ? "STABLE_FRAME" as const : "UNKNOWN" as const,
      recordedAt: (options.now ?? (() => new Date()))().toISOString(),
      summary: match.evidence.reason,
      details: { observationPhase: phase, ...details },
    };
    if (match.result === "MATCH") return { result: "MATCH" as const, reason: match.evidence.reason, evidence };
    if (match.result === "MISMATCH") {
      return { result: "MISMATCH" as const, reason: match.evidence.reason, effectAbsenceProven: true, evidence };
    }
    return { result: "INCONCLUSIVE" as const, reason: match.evidence.reason, evidence };
  };
  const commandJournal = durability?.commandJournal ?? createMemoryCommandJournal();
  const reconcileDurableCommand = async (
    entry: ReturnType<NonNullable<typeof durability>["reconciliationRequired"]>[number],
    signal?: AbortSignal,
  ): Promise<RestartReconciliationResult> => {
    const scope = entry.record.authorizedScope;
    // A command that never reached its native submission cannot have produced a
    // world effect, so its absence is durable proof rather than missing evidence,
    // and the world must not be asked about it.
    //
    // Every kernel writes `submittedAt` in the same synchronous journal update
    // that moves the command to `SUBMITTED`, and calls its native boundary only
    // after that update has been persisted: the ZONING kernel between its
    // pre-submit observation and `submit`, the ROAD kernel immediately before
    // `submit`, and the UTILITY batch immediately before
    // `cs2_mayor_execute_actions`. A record still at `AUTHORIZED` with a null
    // `submittedAt` is therefore one whose submission never ran -- and nothing
    // can run it later, because only `CREATED` is resumable: the dedicated ROAD
    // commit path adopts a stored `CREATED` record and every later state is
    // reconcile-only (`FACILITY_ACCESS_ROAD_COMMAND_ALREADY_SUBMITTED`).
    //
    // Measured live on this city: a ZONING command whose pre-submit read never
    // returned was left exactly there with an empty `observationEvidence`, and
    // the cell positions the zoning matcher reads are recorded *after*
    // `AUTHORIZED` -- so that record could never answer. Every restart read it as
    // `INCONCLUSIVE`, `ensureDurableWorld` refused with "restart reconciliation
    // remains inconclusive", and the Brain closed one Goal per tick with no
    // world write ever possible again.
    if (entry.record.status === "AUTHORIZED" && entry.record.submittedAt === null) {
      return {
        result: "MISMATCH",
        reason: "command was authorized but never reached native submission, so the world cannot contain its effect",
        effectAbsenceProven: true,
      };
    }
    if (scope.actionFamily === "ROAD") {
      let input: Record<string, unknown>;
      try {
        input = record(JSON.parse(scope.exactInput));
      } catch {
        return { result: "INCONCLUSIVE", reason: "ROAD reconciliation key is malformed" };
      }
      if (![input.x1, input.z1, input.x2, input.z2].every((value) => typeof value === "number" && Number.isFinite(value))) {
        return { result: "INCONCLUSIVE", reason: "ROAD reconciliation geometry is malformed" };
      }
      const center = {
        x: (Number(input.x1) + Number(input.x2)) / 2,
        z: (Number(input.z1) + Number(input.z2)) / 2,
      };
      const envelope = await observation.capture({
        spatialDetail: {
          ...center,
          radius: Math.max(64, Math.hypot(Number(input.x2) - Number(input.x1), Number(input.z2) - Number(input.z1)) + 16),
          resolution: 16,
        },
        signal,
      });
      const matched = roadEffectMatcher.match({ command: entry.record, observation: envelope });
      const evidence = {
        phase: "RECONCILIATION" as const,
        observationId: envelope.observationId,
        coherence: envelope.coherence,
        recordedAt: (options.now ?? (() => new Date()))().toISOString(),
        summary: matched.reason,
        details: matched.evidence,
      };
      if (
        durability.canClassifyCommandRolledBack(entry) &&
        isSafeCheckpointRollbackObservation(envelope)
      ) {
        return {
          result: "MISMATCH",
          reason: "ROAD execution was rolled back by reloading the same checkpoint before the command journal cut",
          effectAbsenceProven: true,
          evidence: {
            ...evidence,
            summary: "ROLLED_BACK_BY_CHECKPOINT_RELOAD",
            details: {
              ...matched.evidence,
              rollback: {
                classification: "ROLLED_BACK_BY_CHECKPOINT_RELOAD",
                checkpointJournalPosition: durability.activeCheckpointJournalPosition(),
                commandPosition: entry.position,
              },
            },
          },
        };
      }
      if (matched.result === "MATCH") return { result: "MATCH", reason: matched.reason, evidence };
      if (matched.result === "MISMATCH" && matched.effectAbsenceProven) {
        return { result: "MISMATCH", reason: matched.reason, effectAbsenceProven: true, evidence };
      }
      return { result: "INCONCLUSIVE", reason: matched.reason, evidence };
    }
    if (scope.actionFamily === "UTILITY") {
      let actions: MayorAction[];
      try {
        const parsed = JSON.parse(scope.exactInput);
        actions = Array.isArray(parsed) ? parsed as MayorAction[] : [];
      } catch {
        return { result: "INCONCLUSIVE", reason: "UTILITY reconciliation input is malformed" };
      }
      if (actions.length === 0) return { result: "INCONCLUSIVE", reason: "UTILITY reconciliation has no exact actions" };
      const cableActions = actions.filter(
        (action): action is Extract<MayorAction, { type: "build_road" }> =>
          action.type === "build_road" && action.prefab === ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
      );
      if (cableActions.length > 0) {
        const persistedMatch = [...entry.record.observationEvidence].reverse().find((candidate) => {
          const details = record(candidate.details);
          const completeness = record(details.completeness);
          const primitive = record(details.primitive);
          const primitiveEvidence = record(primitive.evidence);
          return primitive.decision === "OBSERVED_MATCH" &&
            completeness.bindingStatus === "VALID" && completeness.complete === true && completeness.truncated !== true &&
            primitiveEvidence.matchedEdgeIds !== undefined;
        });
        if (persistedMatch) {
          return { result: "MATCH", reason: "persisted authoritative primitive effect is already OBSERVED_MATCH", evidence: persistedMatch };
        }
        // The current-world binding is built exactly as the current-world observer
        // builds it: the facility from the journal-authorized placement of this
        // utility scope, that facility's live electricity connector, the road
        // reacquired from the admitted course's own endpoint, and the live world
        // identity. The scope's `certifiedRoadRefs` are entity ids of the
        // generation the command ran in and name nothing in this one, so they are
        // deliberately not consulted �?binding to them asks the Bridge about a
        // road that merely moved and reports the answer as "stale". Project state
        // is not consulted either: it is a snapshot a descendant save may not
        // inherit, while the journal-authorized placement is durable.
        for (const action of cableActions) {
          const attempt = await observeAdmittedCableCourse({ scope, admitted: action, commandId: entry.record.commandId,
            exactActionScope: entry.record.networkLinkRepairIdentity !== undefined, signal })
            .then((observed) => ({ ok: true as const, observed }))
            .catch((error: unknown) => ({ ok: false as const, error }));
          if (!attempt.ok) {
            const reason = attempt.error instanceof Error ? attempt.error.message : "utility topology observation exception";
            return {
              result: "INCONCLUSIVE",
              reason: "utility topology observation is UNKNOWN: " + reason,
              evidence: {
                phase: "RECONCILIATION", observationId: `utility-topology:${entry.record.commandId}`,
                coherence: "UNKNOWN", recordedAt: (options.now ?? (() => new Date()))().toISOString(),
                summary: "UTILITY_TOPOLOGY_UNKNOWN",
                details: { worldId: scope.worldEpochId.split(":generation:", 1)[0], generation: scope.generation,
                  topologyRevision: scope.topologyRevision,
                  bindingStatus: "UNKNOWN", primitiveDecision: "UNKNOWN", primitiveReason: reason,
                  objectiveStatus: "UNKNOWN", objectiveReason: reason },
              },
            };
          }
          const observed = attempt.observed;
          if (observed.status === "ABSENT") {
            return { result: "MISMATCH", reason: observed.reason, effectAbsenceProven: true };
          }
          if (observed.status === "UNPROVEN") {
            return { result: "INCONCLUSIVE", reason: `UTILITY cable reconciliation is UNKNOWN: ${observed.reason}` };
          }
          const { binding, primitive, objective, worldId, generation, target } = observed;
          const evidence = {
            phase: "RECONCILIATION" as const,
            observationId: `utility-topology:${String(binding.frameIndex ?? entry.record.commandId)}`,
            coherence: binding.bindingStatus === "VALID" && binding.complete === true && binding.truncated !== true ? "STABLE_FRAME" as const : "UNKNOWN" as const,
            recordedAt: (options.now ?? (() => new Date()))().toISOString(),
            summary: "UTILITY_TOPOLOGY_RECONCILIATION",
            details: {
              worldId: binding.worldId ?? worldId, generation: binding.generation ?? generation,
              topologyRevision: binding.topologyRevision ?? bridgeTopologyRevision({ generation, target }),
              frameIndex: binding.frameIndex ?? null,
              completeness: { bindingStatus: binding.bindingStatus ?? "UNKNOWN", complete: binding.complete === true, truncated: binding.truncated === true },
              bindingReason: binding.bindingStatus === "VALID"
                ? "validated world, generation, target, and connector bindings"
                : "Bridge did not certify the requested topology binding",
              primitive: { decision: primitive.decision, reason: primitive.reason, evidence: primitive.evidence },
              objective: { status: objective.status, reason: objective.reason, networkConnected: objective.networkConnected, targetNetworkReachable: objective.targetNetworkReachable },
            },
          };
          if (observed.utilityEffect === "OBSERVED_MATCH" ||
            (!observed.utilitySemanticKnown && observed.utilityEffect === "UNKNOWN" && primitive.decision === "OBSERVED_MATCH")) {
            return { result: "MATCH", reason: primitive.reason, evidence };
          }
          if (observed.utilityEffect === "OBSERVED_ABSENT") {
            return { result: "MISMATCH", reason: "authoritative utility effect matcher proved the submitted connection absent", effectAbsenceProven: true, evidence };
          }
          // Absence is only provable from a topology the Bridge actually bound;
          // an unbound read proves nothing about this course, so it stays
          // INCONCLUSIVE rather than becoming a proven mismatch.
          if (primitive.decision === "PROVEN_MISMATCH" && binding.bindingStatus === "VALID" && binding.complete === true) {
            return { result: "MISMATCH", reason: primitive.reason, effectAbsenceProven: true, evidence };
          }
          return { result: "INCONCLUSIVE", reason: primitive.reason, evidence };
        }
      }
      // Road-shaped utility effects are read from the complete entity listing
      // below; a bounded spatial graph cannot certify the submitted course.
      const roadEvidence: unknown[] = [];
      for (const action of actions) {
        if (action.type === "place_building") {
          const before = record(await callTool("cs2_game_state", {}, signal));
          const beforeWorld = record(before.world);
          const beforeSimulation = record(before.simulation);
          const frameIndex = Number.isFinite(Number(beforeSimulation.frameIndex)) ? Number(beforeSimulation.frameIndex) :
            Number.isFinite(Number(before.frameIndex)) ? Number(before.frameIndex) : null;
          const expectedEpoch = `${String(beforeWorld.worldId ?? "")}:generation:${String(beforeWorld.generation ?? "")}`;
          if (before.cityLoaded !== true || beforeWorld.worldReady !== true || beforeWorld.worldId !== scope.worldEpochId.split(":generation:", 1)[0] ||
              beforeWorld.generation !== scope.generation || expectedEpoch !== scope.worldEpochId || beforeSimulation.paused !== true ||
              beforeWorld.nativeOperationBusy !== false || beforeWorld.nativeOperationStage !== "Idle") {
            return { result: "INCONCLUSIVE", reason: "UTILITY facility census is not bound to the authorized paused, idle world generation" };
          }
          const listed = await callTool("cs2_list_buildings", { query: action.prefab, limit: 64 }, signal);
          const after = record(await callTool("cs2_game_state", {}, signal));
          const afterWorld = record(after.world);
          const afterSimulation = record(after.simulation);
          const afterFrame = Number.isFinite(Number(afterSimulation.frameIndex)) ? Number(afterSimulation.frameIndex) :
            Number.isFinite(Number(after.frameIndex)) ? Number(after.frameIndex) : null;
          if (after.cityLoaded !== true || afterWorld.worldId !== beforeWorld.worldId || afterWorld.generation !== beforeWorld.generation ||
              afterSimulation.paused !== true || afterWorld.nativeOperationBusy !== false || afterWorld.nativeOperationStage !== "Idle" ||
              (frameIndex !== null && afterFrame !== frameIndex)) {
            return { result: "INCONCLUSIVE", reason: "UTILITY facility census world binding changed during authoritative readback" };
          }
          const reconciled = reconcileExactUtilityFacilityListing({ commandId: entry.record.commandId, action, listed,
            worldId: String(beforeWorld.worldId), generation: String(beforeWorld.generation), frameIndex,
            recordedAt: (options.now ?? (() => new Date()))().toISOString() });
          if (reconciled.result !== "MATCH") return reconciled;
          roadEvidence.push(reconciled.evidence);
        } else if (action.type === "build_road") {
          const observed = await observeExactUtilityNetCourse(entry.record, scope, action, "RECONCILIATION", signal);
          if (observed.result === "MISMATCH") {
            return { result: "MISMATCH", reason: observed.reason, effectAbsenceProven: true, evidence: observed.evidence };
          }
          if (observed.result !== "MATCH") {
            return { result: "INCONCLUSIVE", reason: observed.reason, evidence: observed.evidence };
          }
          roadEvidence.push(observed.evidence);
          continue;
          /* The former graph/list fallback is intentionally retired: a generic
             connected topology is not proof of this exact command course.
          const course = {
            prefab: action.prefab,
            start: { x: action.x1, z: action.z1 },
            end: { x: action.x2, z: action.z2 },
          };
          const inRoadGraph = netCourseCovered({
            edges: detail.roadGraph.edges.map((edge) => ({ prefab: edge.prefab, start: edge.start, end: edge.end })),
            ...course,
            tolerance: 1,
          });
          // The spatial detail read returns the ROAD graph, and a net primitive
          // like a water pipe is not in it. Asking it about a pipe answers "no
          // such edge" for an edge standing in the world, and the command then
          // sits unreconcilable forever. The game's own net listing covers every
          // net prefab, so it is the authority for a primitive the road graph
          // does not carry �?and consulting it only when the road graph has not
          // already answered leaves the road path exactly as it was.
          if (!inRoadGraph) {
            const listed = record(await callTool("cs2_list_roads", {
              query: action.prefab,
              x: (action.x1 + action.x2) / 2,
              z: (action.z1 + action.z2) / 2,
              radius: Math.max(32, Math.hypot(action.x2 - action.x1, action.z2 - action.z1) / 2 + 16),
              limit: 500,
            }, signal));
            // A truncated listing is not evidence of absence, so it stays
            // INCONCLUSIVE rather than becoming a mismatch.
            if (listed.truncated === true || listed.hasMore === true) {
              return { result: "INCONCLUSIVE", reason: "UTILITY network listing is truncated" };
            }
            const match = netCourseCovered({
              edges: (Array.isArray(listed.roads) ? listed.roads : []).map((raw) => {
                const edge = record(raw);
                const start = record(edge.start);
                const end = record(edge.end);
                return {
                  prefab: String(edge.prefab ?? ""),
                  start: { x: Number(start.x), z: Number(start.z) },
                  end: { x: Number(end.x), z: Number(end.z) },
                };
              }),
              ...course,
              tolerance: 1,
            });
            if (!match) {
              return { result: "INCONCLUSIVE", reason: "UTILITY network effect is not authoritatively observable" };
            }
          }
          */
        } else return { result: "INCONCLUSIVE", reason: "UTILITY reconciliation action is unsupported" };
      }
      return {
        result: "MATCH",
        reason: "all exact UTILITY actions have authoritative permanent world effects",
        ...(roadEvidence.length > 0 ? { evidence: {
          phase: "RECONCILIATION" as const,
          observationId: `utility-net:${entry.record.commandId}`,
          coherence: "STABLE_FRAME" as const,
          recordedAt: (options.now ?? (() => new Date()))().toISOString(),
          summary: "all exact UTILITY net courses are covered by listed permanent entities",
          details: { commandId: entry.record.commandId, courses: roadEvidence },
        } } : {}),
      };
    }
    if (scope.actionFamily === "ZONING" && scope.intendedEffect) {
      const detail = parseV2SpatialSiteDetail(
        await callTool(
          "cs2_spatial",
          {
            mode: "detail",
            x: scope.spatialEnvelope.center.x,
            z: scope.spatialEnvelope.center.z,
            radius: Math.max(64, scope.spatialEnvelope.radius * Math.SQRT2),
            resolution: 16,
          },
          signal,
        ),
      );
      // Same key as the descendant observer, for the same reason: the recorded
      // block entity is a thing of the generation that wrote it, so a restart
      // re-reads the authorized cells at the positions the record gives for
      // them rather than by an id that now resolves to a different block.
      return matchRecordedZoningCells({ command: entry.record, currentCells: detail.zoningCells });
    }
    return { result: "INCONCLUSIVE", reason: "no restart matcher exists for this action family" };
  };
  // Descendant inheritance and superseding world observations both rest on the
  // same question: does the *current* world still contain the effect this
  // command was authorized to produce? The observer below answers only that
  // question, from the world, and never from the command's execution-time
  // verdict. It is deliberately separate from `reconcileDurableCommand`, whose
  // job is to decide what a *restarted* command's own outcome is.
  const parseExactActions = (scope: V2CommandRecord["authorizedScope"]): MayorAction[] => {
    try {
      const parsed = JSON.parse("exactInput" in scope ? String(scope.exactInput) : "[]");
      return Array.isArray(parsed) ? (parsed as MayorAction[]) : [];
    } catch {
      return [];
    }
  };
  /** The authoritative facility of this lineage, rediscovered from the journal. */
  const resolveLineageFacility = async (actions: MayorAction[], signal?: AbortSignal,
    currentPlacement?: { prefab: string; position: { x: number; z: number } } | null) => {
    const journalPlacement = actions.find((action) => action.type === "place_building");
    const placement = currentPlacement ?? (journalPlacement?.type === "place_building"
      ? { prefab: journalPlacement.prefab, position: { x: journalPlacement.x, z: journalPlacement.z } } : null);
    if (!placement) return null;
    const listed = record(await callTool("cs2_list_buildings", { query: placement.prefab, limit: 128 }, signal));
    const totalMatches = Number(listed.totalMatches);
    const returned = Number(listed.returned);
    if (listed.truncated === true || listed.hasMore === true || listed.complete === false ||
      (Number.isFinite(totalMatches) && Number.isFinite(returned) && returned !== totalMatches)) return null;
    const buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : [];
    const matches = buildings.filter((item) => {
      const position = record(item.position);
      return (
        item.prefab === placement.prefab &&
        item.isSubBuilding !== true &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.z) &&
        Math.hypot(Number(position.x) - placement.position.x, Number(position.z) - placement.position.z) <= 0.25
      );
    });
    const found = matches.length === 1 ? matches[0] : null;
    const entity = record(found?.entity);
    return typeof entity.index === "number" && typeof entity.version === "number"
      ? ({ index: entity.index, version: entity.version } as SpatialEntityRef)
      : null;
  };
  /**
   * The lineage facility's own electricity connector, as the CURRENT world
   * reports it.
   *
   * The command scope names no connector, and the topology read only resolves
   * one when it is handed an identity to validate, so the connector has to come
   * from the world. A building with zero or several electricity connectors
   * proves nothing about which one the course was anchored to, so that is
   * reported as no connector rather than a guess.
   */
  const resolveCurrentLineageConnector = async (facility: SpatialEntityRef, signal?: AbortSignal) => {
    const listed = record(
      await callTool("cs2_utility_connectors", { index: facility.index, version: facility.version }, signal),
    );
    const electricity = (Array.isArray(listed.connectors) ? listed.connectors.map(record) : []).filter(
      (connector) => connector.type === "electricity",
    );
    if (electricity.length !== 1) return null;
    const node = record(electricity[0].node);
    return typeof node.index === "number" && typeof node.version === "number"
      ? ({ index: node.index, version: node.version } as SpatialEntityRef)
      : null;
  };
  /**
   * The current road edge that carries the admitted course's approved contact.
   *
   * The approved contact is the admitted course's own endpoint: immutable
   * geometry the command was authorized against, and therefore the only lookup
   * key that survives a world generation. The scope's `certifiedRoadRefs` are
   * entity ids of the generation the command ran in and name nothing here, so
   * they are deliberately not consulted.
   */
  const resolveCurrentTargetRoad = async (input: {
    approvedContact: { x: number; z: number };
    envelope: { center: { x: number; z: number }; radius: number };
    signal?: AbortSignal;
  }): Promise<{ road: SpatialRoadEdge | null; detail: SpatialSiteDetail }> => {
    const detail = parseV2SpatialSiteDetail(
      await callTool(
        "cs2_spatial",
        {
          mode: "detail",
          x: input.envelope.center.x,
          z: input.envelope.center.z,
          radius: Math.max(64, input.envelope.radius),
          resolution: 64,
        },
        input.signal,
      ),
    );
    const reacquired = reacquireTargetRoadByApprovedContact({
      edges: detail.roadGraph.edges,
      approvedContact: input.approvedContact,
    });
    return { road: reacquired.status === "YES" ? reacquired.road : null, detail };
  };
  /**
   * The current authoritative binding of one admitted cable course, and the
   * bounded topology read made against it.
   *
   * Both the current-world observer and the restart reconciler have to answer
   * the same question �?does the *current* world contain this admitted course? �?   * and neither may answer it from a recorded entity id. A scope's
   * `certifiedRoadRefs` name entities of the generation the command ran in, so
   * after a reload they name nothing: asking the Bridge about them returns
   * "stale" for a road that simply no longer exists under that id, which reads
   * as "the effect is unproven" when the truth is only that the identity moved.
   * What survives a world generation is the admitted course, which was
   * authorized as immutable geometry.
   *
   * So the binding is rebuilt from what is still provable in this world: the
   * journal-authorized facility of this utility scope, that facility's own live
   * electricity connector, the road reacquired from the admitted course's own
   * endpoint, and the live world identity. Any link that cannot be proven
   * returns a reason instead of a guess, and the physical effect is decided by
   * the production course matcher over the admitted geometry �?so a cable lying
   * nearby is never claimed as this command's effect.
   */
  const observeAdmittedCableCourse = async (input: {
    scope: Extract<V2CommandRecord["authorizedScope"], { actionFamily: "UTILITY" }>;
    admitted: Extract<MayorAction, { type: "build_road" }>;
    commandId?: string;
    exactActionScope?: boolean;
    signal?: AbortSignal;
  }): Promise<
    | {
        status: "OBSERVED";
        facility: SpatialEntityRef;
        connector: SpatialEntityRef;
        target: SpatialEntityRef;
        worldId: string;
        generation: string;
        binding: Record<string, unknown>;
        primitive: ReturnType<typeof matchCablePrimitiveEffect>;
        objective: ReturnType<typeof matchConnectionObjective>;
        utilitySemanticKnown: boolean;
        utilityEffect: "OBSERVED_MATCH" | "OBSERVED_ABSENT" | "UNKNOWN";
      }
    | { status: "ABSENT"; reason: string }
    | { status: "UNPROVEN"; reason: string }
  > => {
    const scope = input.scope;
    // The facility is not in this command's own scope �?a connection command
    // carries no placement �?so it comes from the journal-authorized placement
    // of the *same* utility scope, matched exactly as `utilityPlacementOperations`
    // matches it. Project state is deliberately not consulted: it is a durable
    // snapshot a descendant save may not inherit.
    let facility: SpatialEntityRef | null;
    let connector: SpatialEntityRef | null;
    if (input.exactActionScope) {
      const sourceAnchor = input.admitted.utilityEndpoints?.start.topologyLookup?.sourceAnchor ??
        input.admitted.utilityEndpoints?.end.topologyLookup?.sourceAnchor;
      if (!sourceAnchor || sourceAnchor.connectorUtility !== "ELECTRICITY") {
        return { status: "UNPROVEN", reason: "network-link action has no typed current electricity source anchor" };
      }
      const listed = record(await callTool("cs2_list_buildings", { query: sourceAnchor.buildingPrefab, limit: 128 }, input.signal));
      const buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : null;
      const buildingsComplete = listed.complete === true ||
        (Number.isFinite(Number(listed.totalMatches)) && Number(listed.returned) === Number(listed.totalMatches));
      if (!buildings || listed.truncated === true || listed.hasMore === true || !buildingsComplete) {
        return { status: "UNPROVEN", reason: "network-link source-anchor building listing is incomplete" };
      }
      const matches = buildings.filter((building) => {
        const position = record(building.position);
        return building.prefab === sourceAnchor.buildingPrefab && building.isSubBuilding !== true &&
          Math.hypot(Number(position.x) - sourceAnchor.position.x, Number(position.z) - sourceAnchor.position.z) <= 0.25;
      });
      if (matches.length !== 1) return { status: "UNPROVEN", reason: `network-link source-anchor rebind count ${matches.length}` };
      const sourceEntity = record(matches[0].entity);
      if (!Number.isInteger(Number(sourceEntity.index)) || !Number.isInteger(Number(sourceEntity.version))) {
        return { status: "UNPROVEN", reason: "network-link source-anchor identity is invalid" };
      }
      facility = { index: Number(sourceEntity.index), version: Number(sourceEntity.version) };
      const connectorRead = record(await callTool("cs2_utility_connectors", facility, input.signal));
      const connectors = Array.isArray(connectorRead.connectors) ? connectorRead.connectors.map(record) : null;
      const electrical = connectors?.filter((item) => item.type === "electricity") ?? [];
      const node = record(electrical[0]?.node);
      const connectorsComplete = connectorRead.complete !== false && connectorRead.truncated !== true && connectorRead.hasMore !== true;
      if (connectors === null || connectorRead.truncated === true || connectorRead.hasMore === true ||
        !connectorsComplete || electrical.length !== 1 ||
        !Number.isInteger(Number(node.index)) || !Number.isInteger(Number(node.version))) {
        return { status: "UNPROVEN", reason: "network-link source electricity connector cannot be uniquely rebound" };
      }
      connector = { index: Number(node.index), version: Number(node.version) };
    } else {
      const lineageActions = commandJournal
        .list()
        .filter((command) => {
          const scopeOf = command.authorizedScope;
          return scopeOf.actionFamily === "UTILITY" && scopeOf.projectId === scope.projectId &&
            scopeOf.trancheId === scope.trancheId && scopeOf.reservationRef === scope.reservationRef &&
            scopeOf.utilityKind === scope.utilityKind;
        })
        .flatMap((command) => parseExactActions(command.authorizedScope));
      // A civic command carries no network and has no per-kind utility state.
      const durableUtility = scope.utilityKind === "civic" ? undefined
        : scopedUtilityState({ projectId: scope.projectId, trancheId: scope.trancheId })?.utilities[scope.utilityKind];
      const durableFacility = durableUtility?.facility;
      const currentPlacement = durableFacility && durableFacility.prefab &&
        Number.isFinite(durableFacility.position?.x) && Number.isFinite(durableFacility.position?.z)
        ? { prefab: durableFacility.prefab, position: { x: durableFacility.position.x, z: durableFacility.position.z } }
        : null;
      facility = await resolveLineageFacility(lineageActions, input.signal, currentPlacement);
      if (!facility) return { status: "UNPROVEN", reason: "admitted cable course has no journal-authorized facility to observe against" };
      connector = await resolveCurrentLineageConnector(facility, input.signal);
      if (!connector) return { status: "UNPROVEN", reason: "admitted cable course has no current authoritative connector to observe against" };
    }
    const currentWorld = record(record(await callTool("cs2_game_state", {}, input.signal)).world);
    const generation = typeof currentWorld.generation === "string" ? currentWorld.generation : null;
    const worldId = typeof currentWorld.worldId === "string" ? currentWorld.worldId : null;
    if (!generation || !worldId) {
      return { status: "UNPROVEN", reason: "admitted cable course cannot be placed in the current world generation" };
    }
    let target: { entity: SpatialEntityRef } | null;
    const envelope = input.exactActionScope ? exactNetworkLinkEnvelope(input.admitted) : scope.spatialEnvelope;
    if (input.exactActionScope) {
      // Utility cables are absent from the ordinary road graph. Rebind the
      // target from the complete cable listing and require one exact contiguous
      // native realization of this admitted course.
      const listed = record(await callTool("cs2_list_roads", { query: input.admitted.prefab, limit: 500 }, input.signal));
      const roads = Array.isArray(listed.roads) ? listed.roads.map(record) : null;
      const roadsComplete = Number.isFinite(Number(listed.totalMatches)) && Number(listed.returned) === Number(listed.totalMatches);
      if (!roads || listed.truncated === true || listed.hasMore === true || !roadsComplete) {
        return { status: "UNPROVEN", reason: "network-link cable edge listing is incomplete" };
      }
      const course = matchNetworkLinkCourseEffect({ roads: roads as import("./network-link-course-effect").NetworkLinkCourseRoad[],
        prefab: input.admitted.prefab, start: { x: input.admitted.x1, z: input.admitted.z1 },
        end: { x: input.admitted.x2, z: input.admitted.z2 }, tolerance: 0.25 });
      if (course.status !== "MATCH") {
        return { status: "UNPROVEN", reason: `network-link course readback ${course.status}: ${course.reason}` };
      }
      const edge = record(course.edges.at(-1)?.entity);
      if (!Number.isInteger(Number(edge.index)) || !Number.isInteger(Number(edge.version))) {
        return { status: "UNPROVEN", reason: "network-link realized terminal edge has no permanent identity" };
      }
      target = { entity: { index: Number(edge.index), version: Number(edge.version) } };
    } else {
      const targetRead = await resolveCurrentTargetRoad({
        approvedContact: { x: input.admitted.x2, z: input.admitted.z2 }, envelope, signal: input.signal,
      });
      target = targetRead.road;
      if (!target && input.commandId) {
        const durable = scopedUtilityState({ projectId: scope.projectId, trancheId: scope.trancheId });
        const candidate = scope.utilityKind === "civic" ? undefined
          : durable?.utilities[scope.utilityKind].candidateLedger.find((entry) => entry.commandId === input.commandId);
        let semantic: ReturnType<typeof electricityTargetSemantics> | null = null;
        try {
          const parsed = candidate?.targetSemanticFingerprint ? JSON.parse(candidate.targetSemanticFingerprint) as unknown : null;
          const value = record(parsed);
          if (value.schemaVersion === "ai-mayor-v2-electricity-target/1") semantic = value as ReturnType<typeof electricityTargetSemantics>;
        } catch { /* malformed durable semantics cannot prove absence */ }
        if (!semantic) return { status: "UNPROVEN", reason: "durable admitted target semantics are unavailable for current endpoint reconciliation" };
        // The bounded spatial detail is suitable for candidate rebinding, but
        // it does not certify the entire target-prefab set. Use the native
        // entity listing when absence itself must be proved.
        const targetRoadListing = record(await callTool("cs2_list_roads", { query: semantic.targetRoad.prefab, limit: 500 }, input.signal));
        const targetRoads = Array.isArray(targetRoadListing.roads) ? targetRoadListing.roads.map(record) : null;
        const roadTotal = Number(targetRoadListing.totalMatches);
        const roadReturned = Number(targetRoadListing.returned);
        const roadsComplete = !!targetRoads && targetRoadListing.truncated !== true && targetRoadListing.hasMore !== true &&
          targetRoadListing.complete !== false && Number.isFinite(roadTotal) && roadReturned === roadTotal;
        if (!roadsComplete || !targetRoads) {
          return { status: "UNPROVEN", reason: "authoritative target-prefab road listing is incomplete; endpoint absence remains UNKNOWN" };
        }
        const semanticTargets = narrowTargetRoadsByCertifiedRefs({
          candidates: targetRoads.filter((edge) => {
            const point = record(edge[semantic!.targetRoad.endpointRole]);
            return edge.prefab === semantic!.targetRoad.prefab &&
              Math.hypot(Number(point.x) - semantic!.approvedContact.x, Number(point.z) - semantic!.approvedContact.z) <= 0.25 &&
              Math.hypot(Number(point.x) - semantic!.targetRoad.anchor.x, Number(point.z) - semantic!.targetRoad.anchor.z) <= 0.25;
          }),
          certifiedRoadRefs: scope.certifiedRoadRefs,
          commandGeneration: scope.generation,
          currentGeneration: generation,
        });
        if (semanticTargets.length === 1) {
          const targetEntity = record(semanticTargets[0].entity);
          if (!Number.isInteger(Number(targetEntity.index)) || !Number.isInteger(Number(targetEntity.version))) {
            return { status: "UNPROVEN", reason: "semantic target road has no current permanent entity identity" };
          }
          // The local spatial detail can omit a real endpoint. Rebind it from
          // the complete prefab listing and the immutable admitted contact.
          target = { entity: { index: Number(targetEntity.index), version: Number(targetEntity.version) } };
        } else if (semanticTargets.length > 1) {
          return { status: "UNPROVEN", reason: "multiple current target roads match the admitted semantic endpoint" };
        } else {
          const basicConnector = record(await callTool("cs2_utility_connectors", {
            index: facility.index, version: facility.version,
          }, input.signal));
          const connectorRead = Array.isArray(basicConnector.connectors) ? basicConnector.connectors.map(record) : [];
          const currentConnector = connectorRead.find((entry) => entry.type === "electricity");
          const currentNode = record(currentConnector?.node);
          if (!currentConnector || !Number.isInteger(Number(currentNode.index)) || !Number.isInteger(Number(currentNode.version)) ||
            basicConnector.truncated === true || basicConnector.hasMore === true || basicConnector.complete === false) {
            return { status: "UNPROVEN", reason: "complete road readback lacks a complete authoritative source connector read" };
          }
          connector = { index: Number(currentNode.index), version: Number(currentNode.version) };
          const topology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
            index: facility.index, version: facility.version, connector,
            expectedWorldId: worldId, expectedGeneration: generation,
            admittedPrefab: input.admitted.prefab,
            admittedStart: { x: input.admitted.x1, z: input.admitted.z1 },
            admittedEnd: { x: input.admitted.x2, z: input.admitted.z2 },
            endpointTolerance: 0.25, envelope,
          }, input.signal));
          const binding = record(topology.binding);
          const connectorTopology = record(topology.connector);
          const candidateScan = record(topology.candidateScan);
          const facilityReadback = record(basicConnector.facility);
          const facilityPosition = record(facilityReadback.position);
          const utilityWorld: UtilityWorldState = {
            identity: { worldId, generation, checkpointId: nonEmptyText(currentWorld.checkpointId) },
            // The complete current road graph and uniquely rebound source
            // connector can prove the admitted endpoint absent. A topology
            // query for a nonexistent target cannot be complete by definition.
            readbackComplete: roadsComplete && connectorRead.complete !== false && connectorRead.truncated !== true &&
              connectorRead.hasMore !== true && connectorTopology.physicalComplete === true &&
              candidateScan.complete === true && candidateScan.truncated !== true,
            facility: { entity: facility, prefab: String(facilityReadback.prefab ?? ""),
              position: { x: Number(facilityPosition.x), z: Number(facilityPosition.z) } },
            connector: { entity: connector, attached: typeof connectorTopology.attached === "boolean" ? connectorTopology.attached : null,
              orphan: typeof connectorTopology.orphan === "boolean" ? connectorTopology.orphan : null },
            targetResolutionComplete: roadsComplete,
            resolvedEndpoint: null,
            topology,
          };
          worldState.refresh("UTILITY", { identity: utilityWorld.identity, observedAt: (options.now ?? (() => new Date()))().toISOString(),
            complete: utilityWorld.readbackComplete, value: utilityWorld });
          const effect = matchUtilityConnectionEffect({ action: input.admitted, expectedConnector: connector, semantic, world: utilityWorld });
          if (effect.verdict === "OBSERVED_ABSENT") return { status: "ABSENT", reason: effect.reason };
        }
      }
    }
    if (!target) return { status: "UNPROVEN", reason: "admitted cable course has no current authoritative target to observe against" };
    const topology = normalizeUtilityTopologyPayload(
      await callTool(
        "cs2_utility_connectors",
        {
          index: facility.index, version: facility.version,
          connector, target: target.entity,
          expectedWorldId: worldId, expectedGeneration: generation,
          expectedTopologyRevision: bridgeTopologyRevision({ generation, target: target.entity }),
          admittedPrefab: input.admitted.prefab,
          admittedStart: { x: input.admitted.x1, z: input.admitted.z1 },
          admittedEnd: { x: input.admitted.x2, z: input.admitted.z2 },
          endpointTolerance: input.exactActionScope ? 0.25 : 1.5, envelope,
        },
        input.signal,
      ),
    );
    const binding = record(topology.binding);
    const connectorTopology = record(topology.connector);
    const targetNetwork = record(topology.targetNetwork);
    const targetRecord = record(targetNetwork.target);
    const currentSemantic = (() => {
      const durable = input.commandId ? scopedUtilityState({ projectId: scope.projectId, trancheId: scope.trancheId }) : null;
      const candidate = scope.utilityKind === "civic" ? undefined
        : durable?.utilities[scope.utilityKind].candidateLedger.find((entry) => entry.commandId === input.commandId);
      try { return candidate?.targetSemanticFingerprint ? JSON.parse(candidate.targetSemanticFingerprint) as ReturnType<typeof electricityTargetSemantics> : null; }
      catch { return null; }
    })();
    const targetEndpoints = Array.isArray(targetNetwork.targetEndpoints) ? targetNetwork.targetEndpoints.map(record)
      : Array.isArray(targetRecord.endpoints) ? targetRecord.endpoints.map(record) : [];
    const endpointReadback = targetEndpoints.find((entry) => entry.role === currentSemantic?.targetRoad.endpointRole) ??
      targetEndpoints.find((entry) => entry.role === "start" || entry.role === "end");
    const endpointNode = record(endpointReadback?.node);
    const endpointFlow = record(endpointReadback?.electricityFlowNode);
    const endpointPosition = record(endpointReadback?.position);
    const utilityWorld: UtilityWorldState = {
      identity: { worldId, generation, checkpointId: nonEmptyText(currentWorld.checkpointId) },
      readbackComplete: binding.bindingStatus === "VALID" && binding.complete === true && binding.truncated !== true &&
        connectorTopology.physicalComplete === true && targetEndpoints.length > 0 &&
        targetNetwork.complete === true && targetNetwork.truncated !== true,
      facility: { entity: facility, prefab: String(record(topology.facility).prefab ?? ""),
        position: { x: Number(record(topology.facility).position?.x), z: Number(record(topology.facility).position?.z) } },
      connector: { entity: connector, attached: typeof connectorTopology.attached === "boolean" ? connectorTopology.attached : null,
        orphan: typeof connectorTopology.orphan === "boolean" ? connectorTopology.orphan : null },
      targetResolutionComplete: targetEndpoints.length > 0,
      resolvedEndpoint: endpointReadback && Number.isInteger(Number(endpointNode.index)) && Number.isInteger(Number(endpointNode.version))
        ? { road: target.entity, node: { index: Number(endpointNode.index), version: Number(endpointNode.version) },
            flowNode: Number.isInteger(Number(endpointFlow.index)) && Number.isInteger(Number(endpointFlow.version))
              ? { index: Number(endpointFlow.index), version: Number(endpointFlow.version) } : null,
            prefab: String(targetRecord.prefab ?? ""),
            role: endpointReadback.role as "start" | "end",
            position: { x: Number(endpointPosition.x), y: Number(endpointPosition.y), z: Number(endpointPosition.z) } }
        : null,
      topology,
    };
    worldState.refresh("UTILITY", { identity: utilityWorld.identity, observedAt: (options.now ?? (() => new Date()))().toISOString(),
      complete: utilityWorld.readbackComplete, value: utilityWorld });
    const utilityEffect = currentSemantic
      ? matchUtilityConnectionEffect({ action: input.admitted, expectedConnector: connector, semantic: currentSemantic, world: utilityWorld }).verdict
      : "UNKNOWN";
    return {
      status: "OBSERVED",
      facility,
      connector,
      target: target.entity,
      worldId,
      generation,
      binding: record(topology.binding),
      // The chain is matched by geometry, never by the target road's node: the
      // engine realises the course's far end as a new free node, so the road's
      // own node is not where the chain ends. Target validity is carried by the
      // topology revision and reachability instead.
      primitive: matchCablePrimitiveEffect({ topology, action: input.admitted, connector, tolerance: input.exactActionScope ? 0.25 : 1.5 }),
      objective: matchConnectionObjective({ topology }),
      utilitySemanticKnown: currentSemantic !== null,
      utilityEffect,
    };
  };
  const observeCommandEffectInCurrentWorld = async (
    command: V2CommandRecord,
    signal?: AbortSignal,
  ): Promise<V2DescendantWorldEffect> => {
    const scope = command.authorizedScope;
    const unproven = (evidence: string): V2DescendantWorldEffect => ({
      commandId: command.commandId,
      verdict: "UNPROVEN",
      objectiveSatisfied: null,
      evidence,
    });
    if (scope.actionFamily === "ROAD") {
      let input: Record<string, unknown>;
      try {
        input = record(JSON.parse(scope.exactInput));
      } catch {
        return unproven("ROAD effect key is malformed");
      }
      if (![input.x1, input.z1, input.x2, input.z2].every((value) => typeof value === "number" && Number.isFinite(value))) {
        return unproven("ROAD effect geometry is malformed");
      }
      const envelope = await observation.capture({
        spatialDetail: {
          x: (Number(input.x1) + Number(input.x2)) / 2,
          z: (Number(input.z1) + Number(input.z2)) / 2,
          radius: Math.max(64, Math.hypot(Number(input.x2) - Number(input.x1), Number(input.z2) - Number(input.z1)) + 16),
          resolution: 16,
        },
        signal,
      });
      const matched = roadEffectMatcher.match({ command, observation: envelope });
      if (matched.result === "MATCH") {
        return { commandId: command.commandId, verdict: "EFFECT_PRESENT", objectiveSatisfied: true, evidence: matched.reason };
      }
      // The game consolidates networks: a committed course is split where a
      // later road joins it, or merged with a collinear neighbour, and the edge
      // that was authorized stops existing while the road itself is still
      // exactly where it was put. Edge identity is therefore the wrong question
      // to stop at — the right one is whether the CURRENT authoritative network
      // still covers the committed course.
      //
      // This is a proof, not a wider tolerance. It walks a chain of the same
      // prefab from the authorized start to the authorized end, using the same
      // node-snap tolerance every other current-world course reader in this
      // module already uses, and it fails closed when the bounded read cannot
      // contain the whole course: an unread region is never coverage.
      const detailSource = envelope.sources?.spatialDetail;
      const coverage = committedRoadCourseCoverage({
        exactInput: input,
        currentWorldRoads: detailSource?.status === "AVAILABLE" ? detailSource.data?.roadGraph ?? null : null,
      });
      if (coverage.covered) {
        return { commandId: command.commandId, verdict: "EFFECT_PRESENT", objectiveSatisfied: true,
          evidence: `${matched.reason}; committed course is still covered by the current authoritative road network: ${coverage.evidence}` };
      }
      if (matched.result === "MISMATCH" && matched.effectAbsenceProven) {
        return { commandId: command.commandId, verdict: "EFFECT_ABSENT", objectiveSatisfied: false,
          evidence: `${matched.reason}; ${coverage.evidence}` };
      }
      return unproven(`${matched.reason}; ${coverage.evidence}`);
    }
    if (scope.actionFamily === "UTILITY") {
      const actions = parseExactActions(scope);
      if (actions.length === 0) return unproven("UTILITY effect input has no exact actions");
      const cableActions = actions.filter(
        (action): action is Extract<MayorAction, { type: "build_road" }> =>
          action.type === "build_road" && action.prefab === ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
      );
      if (cableActions.length === 0) {
        const placements = actions.filter(
          (action): action is Extract<MayorAction, { type: "place_building" }> => action.type === "place_building",
        );
        // Every other `build_road` the utility workflow authorizes is a *net
        // course*, not just a cable: a water pipe, a sewage pipe, and the
        // access road a facility repair builds are all the same shape of
        // evidence. The electricity direct cable keeps its own topology path
        // below, because it is the one course whose physical effect the engine
        // can also refuse to join to the network; the rest are answered by the
        // same matcher the restart reconciler already uses, so the two never
        // disagree about whether a course exists in the current world.
        const netCourses = actions.filter(
          (action): action is Extract<MayorAction, { type: "build_road" }> => action.type === "build_road",
        );
        if (placements.length + netCourses.length !== actions.length) {
          return unproven("UTILITY effect action is unsupported");
        }
        const exactNetEvidence: unknown[] = [];
        for (const action of netCourses) {
          const observed = await observeExactUtilityNetCourse(command, scope, action, "CURRENT_WORLD", signal);
          exactNetEvidence.push(observed.evidence);
          if (observed.result === "INCONCLUSIVE") return unproven(JSON.stringify(observed.evidence));
          if (observed.result === "MISMATCH") {
            return {
              commandId: command.commandId,
              verdict: "EFFECT_ABSENT",
              objectiveSatisfied: false,
              evidence: JSON.stringify(observed.evidence),
            };
          }
        }
        for (const action of placements) {
          const listed = record(await callTool("cs2_list_buildings", { query: action.prefab, limit: 64 }, signal));
          const buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : [];
          const complete = listed.complete === true ||
            (Number.isInteger(listed.totalMatches) && Number.isInteger(listed.returned) &&
              Number(listed.returned) === buildings.length && Number(listed.returned) === Number(listed.totalMatches));
          const match = buildings.some((item) => {
            const position = record(item.position);
            return (
              item.prefab === action.prefab &&
              Number.isFinite(position.x) &&
              Number.isFinite(position.z) &&
              Math.hypot(Number(position.x) - action.x, Number(position.z) - action.z) <= 1
            );
          });
          if (!match && !complete) return unproven(`authoritative building listing for ${action.prefab} is incomplete`);
          if (!match) {
            return {
              commandId: command.commandId,
              verdict: "EFFECT_ABSENT",
              objectiveSatisfied: false,
              evidence: `authoritative building listing does not contain ${action.prefab} at the authorized placement`,
            };
          }
        }
        if (netCourses.length > 0) {
          return {
            commandId: command.commandId,
            verdict: "EFFECT_PRESENT",
            objectiveSatisfied: null,
            evidence: JSON.stringify({ exactNetEvidence }),
          };
        }
        // The spatial detail read returns the ROAD graph, which carries a road
        // but not a pipe; a pipe is a net primitive the graph never lists, so
        // the game's own net listing is consulted when the graph has not already
        // answered. Reading the graph first keeps the road-shaped courses �?the
        // access road among them �?on the cheaper, already-proven read.
        let roadGraph: ReturnType<typeof parseV2SpatialSiteDetail>["roadGraph"] | null = null;
        for (const action of netCourses) {
          const course = {
            prefab: action.prefab,
            start: { x: action.x1, z: action.z1 },
            end: { x: action.x2, z: action.z2 },
            ...(action.cx !== undefined && action.cz !== undefined ? { control: { x: action.cx, z: action.cz } } : {}),
          };
          roadGraph ??= parseV2SpatialSiteDetail(
            await callTool(
              "cs2_spatial",
              {
                mode: "detail",
                x: scope.spatialEnvelope.center.x,
                z: scope.spatialEnvelope.center.z,
                radius: Math.max(64, scope.spatialEnvelope.radius),
                resolution: 64,
              },
              signal,
            ),
          ).roadGraph;
          const inRoadGraph = netCourseCovered({
            edges: roadGraph.edges.map((edge) => ({ prefab: edge.prefab, start: edge.start, end: edge.end })),
            ...course,
            tolerance: 1,
          });
          if (inRoadGraph) continue;
          const listed = record(
            await callTool(
              "cs2_list_roads",
              {
                query: action.prefab,
                x: (action.x1 + action.x2) / 2,
                z: (action.z1 + action.z2) / 2,
                radius: Math.max(32, Math.hypot(action.x2 - action.x1, action.z2 - action.z1) / 2 + 16),
                limit: 500,
              },
              signal,
            ),
          );
          // A truncated or incomplete listing is not evidence of absence, so it
          // is reported as unproven rather than becoming a mismatch.
          if (listed.truncated === true || listed.hasMore === true || listed.complete === false) {
            return unproven(`authoritative net listing for ${action.prefab} is truncated or incomplete`);
          }
          const covered = netCourseCovered({
            edges: (Array.isArray(listed.roads) ? listed.roads : []).map((raw) => {
              const edge = record(raw);
              const start = record(edge.start);
              const end = record(edge.end);
              return {
                prefab: String(edge.prefab ?? ""),
                start: { x: Number(start.x), z: Number(start.z) },
                end: { x: Number(end.x), z: Number(end.z) },
              };
            }),
            ...course,
            tolerance: 1,
          });
          if (!covered) {
            return {
              commandId: command.commandId,
              verdict: "EFFECT_ABSENT",
              objectiveSatisfied: false,
              evidence: `authoritative net listing contains no ${action.prefab} course from the authorized start to the authorized end`,
            };
          }
        }
        return {
          commandId: command.commandId,
          verdict: "EFFECT_PRESENT",
          objectiveSatisfied: null,
          evidence: JSON.stringify({
            exactNetEvidence,
            placements: placements.map((action) => ({ prefab: action.prefab, x: action.x, z: action.z })),
          }),
        };
      }
      // A cable is a utility net edge, so it is invisible to the road graph: the
      // only authoritative read is the bounded topology around the lineage's own
      // facility. The facility, the connector, the target road and the world
      // identity all come from the shared current-authoritative binding path, so
      // this observer and the restart reconciler answer the same question the
      // same way �?and neither asks the Bridge about an entity id the command
      // only ever knew in a generation that is gone.
      const observed = await observeAdmittedCableCourse({ scope, admitted: cableActions[0]!, commandId: command.commandId,
        exactActionScope: command.networkLinkRepairIdentity !== undefined, signal });
      if (observed.status === "ABSENT") return { commandId: command.commandId, verdict: "EFFECT_ABSENT", objectiveSatisfied: false, evidence: observed.reason };
      if (observed.status === "UNPROVEN") return unproven(observed.reason);
      const { facility, connector, target, binding, primitive, objective } = observed;
      const objectiveSatisfied = objective.status === "COMPLETE" ? true : objective.status === "INCOMPLETE" ? false : null;
      const present = observed.utilityEffect === "OBSERVED_MATCH" ||
        (!observed.utilitySemanticKnown && observed.utilityEffect === "UNKNOWN" && primitive.decision === "OBSERVED_MATCH");
      const evidence =
        `facility ${facility.index}:${facility.version}; connector ${connector.index}:${connector.version}; ` +
        `target ${target.index}:${target.version}; binding=${String(binding.bindingStatus ?? "UNKNOWN")}; ` +
        `course=${primitive.decision}; matchedCableEdges=${primitive.evidence.matchedEdgeIds.length}; ` +
        `objective=${objective.status}`;
      if (!present && observed.utilityEffect === "OBSERVED_ABSENT") {
        return { commandId: command.commandId, verdict: "EFFECT_ABSENT", objectiveSatisfied: false, evidence };
      }
      if (!present) {
        return binding.bindingStatus === "VALID" && binding.complete === true && primitive.decision === "PROVEN_MISMATCH"
          ? { commandId: command.commandId, verdict: "EFFECT_ABSENT", objectiveSatisfied: false, evidence }
          : unproven(evidence);
      }
      return { commandId: command.commandId, verdict: "EFFECT_PRESENT", objectiveSatisfied, evidence };
    }
    // Zoning is the one family whose effect is not a shape in the world but a
    // category on a cell, and a cell's block is a generation-local entity. The
    // command's recorded pre-submit marquee footprint is the key that survives
    // the reload; see `matchRecordedZoningCells`.
    if (scope.actionFamily === "ZONING") {
      const detail = parseV2SpatialSiteDetail(
        await callTool(
          "cs2_spatial",
          {
            mode: "detail",
            x: scope.spatialEnvelope.center.x,
            z: scope.spatialEnvelope.center.z,
            radius: Math.max(64, scope.spatialEnvelope.radius * Math.SQRT2),
            resolution: 16,
          },
          signal,
        ),
      );
      const matched = matchRecordedAuthorizedZoningEffect({ command, currentCells: detail.zoningCells });
      if (matched.result === "MATCH") {
        return {
          commandId: command.commandId,
          verdict: "EFFECT_PRESENT",
          objectiveSatisfied: true,
          evidence: matched.reason,
        };
      }
      if (matched.result === "MISMATCH") {
        return {
          commandId: command.commandId,
          verdict: "EFFECT_PRESENT",
          objectiveSatisfied: true,
          evidence: `authorized zoning effects remain present; historical OBSERVED_MISMATCH is preserved: ${matched.reason}`,
        };
      }
      return unproven(matched.reason);
    }
    return unproven("no current-world effect observer exists for this action family");
  };
  // Single-flight the durable-world onboarding so two concurrent activation
  // requests cannot both observe BASELINE_CHECKPOINT_REQUIRED and trigger two
  // cs2_save_game submissions. Mutation fail-closed gates are unchanged.
  const ensureDurableWorldMutex = Mutex.create();
  const ensureDurableWorld = async (signal?: AbortSignal) => {
    await ensureDurableWorldMutex.acquire(signal);
    try {
      return await ensureDurableWorldOnce(signal);
    } finally {
      await ensureDurableWorldMutex.release();
    }
  };
  /**
   * The save this world was loaded from, as a durable boundary �?read from the
   * Bridge's save catalogue, never submitted.
   *
   * Only the *loaded* save qualifies here, and the reason is generation. A
   * checkpoint has to name the world generation its boundary belongs to, and CS2
   * does not persist a generation in save metadata �?it is minted per load. For
   * the save that is loaded right now that generation is not a guess: this very
   * load minted it, from this very save. For any other save on disk the
   * generation it was written under is unknowable, so naming the current one
   * would be inventing an identity that save never had. A newer autosave of the
   * same lineage is therefore deliberately not adopted, however recent it is �?   * recency is not lineage and it is not a generation either.
   *
   * The catalogue's own lineage claim (`isCurrentSession`) is required as well
   * as the session guid, and the two are checked against the world being
   * activated rather than against each other, so a save belonging to another
   * world cannot be adopted by matching the catalogue's idea of "current".
   */
  const findLoadedWorldSave = async (
    world: { worldId: string; generation: string; nativeSessionGuid: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> => {
    const catalogue = record(await callTool("cs2_saves", {}, signal));
    const saves = Array.isArray(catalogue.saves) ? catalogue.saves : [];
    const loadedMetadataGuid = nonEmptyText(catalogue.loadedSaveMetadataAssetGuid);
    const candidate = saves
      .map((save) => record(save))
      .find(
        (save) =>
          save.isLoadedSave === true &&
          save.durable === true &&
          save.isCurrentSession === true &&
          nonEmptyText(save.checkpointId) !== null &&
          nonEmptyText(save.saveMetadataAssetGuid) === loadedMetadataGuid &&
          save.nativeSessionGuid === world.nativeSessionGuid,
      );
    if (!candidate) return null;
    return {
      status: "COMPLETED",
      durable: true,
      worldId: world.worldId,
      worldGeneration: world.generation,
      checkpoint: {
        checkpointId: candidate.checkpointId,
        saveMetadataAssetGuid: candidate.saveMetadataAssetGuid,
        saveDataAssetGuid: candidate.saveDataAssetGuid,
        nativeSessionGuid: candidate.nativeSessionGuid,
      },
    };
  };
  /**
   * A durable save receipt this world already has, if any.
   *
   * Read-only by construction: it asks the Bridge whether a completed,
   * world-matched durable save exists and never submits one. A save the user
   * performed themselves is exactly this shape once the Bridge reports it, which
   * is what lets the recovery path adopt the user's save instead of driving one.
   */
  const findAvailableWorldSave = async (
    matches: (status: Record<string, unknown>) => boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> => {
    const status = record(await callTool("cs2_save_status", {}, signal));
    return matches(status) ? status : null;
  };
  /**
   * Drive one native save to a completed, world-matched durable receipt.
   *
   * The baseline flow and the descendant-recovery flow need the same shape of
   * proof �?completed, durable, this world, this generation, this native
   * session �?and differ only in the save name and the word used in failures,
   * so the submission and polling mechanics live here once.
   *
   * This *submits*. Callers that must not save the game on their own have to
   * check `findAvailableWorldSave` first and decline to call this.
   */
  const completeWorldSave = async (
    label: "baseline" | "recovery",
    name: string,
    matches: (status: Record<string, unknown>) => boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    let saveStatus = record(await callTool("cs2_save_status", {}, signal));
    let requestId = typeof saveStatus.saveRequestId === "string" ? saveStatus.saveRequestId : null;
    if (!matches(saveStatus)) {
      if (saveStatus.state === undefined || saveStatus.state === "IDLE" || saveStatus.status === "COMPLETED") {
        const submitted = record(await callTool("cs2_save_game", { name }, signal));
        if (submitted.status !== "SUBMITTED" || typeof submitted.saveRequestId !== "string") {
          throw new Error(`${label} checkpoint submission rejected: ${String(submitted.status ?? "UNKNOWN")}`);
        }
        requestId = submitted.saveRequestId;
      }
      let completed = false;
      for (let check = 0; check < (options.baselineSaveCompletionChecks ?? 120); check += 1) {
        saveStatus = record(await callTool("cs2_save_status", requestId ? { requestId } : {}, signal));
        if (matches(saveStatus)) {
          completed = true;
          break;
        }
        if (saveStatus.status === "COMPLETED") {
          throw new Error(`${label} checkpoint completed with a stale or mismatched world receipt`);
        }
        if (saveStatus.status === "FAILED" || saveStatus.status === "UNKNOWN") {
          throw new Error(`${label} checkpoint did not complete: ${String(saveStatus.reason ?? saveStatus.status)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, options.baselineSavePollMs ?? 250));
      }
      if (!completed) throw new Error(`${label} checkpoint completion remains pending; Mayor writes remain blocked`);
    }
    return saveStatus;
  };
  /**
   * Automatic boundaries already attempted in this process, keyed by the world
   * epoch and which boundary it is.
   *
   * A save is slow and it touches the world, and a recovery path that cannot
   * make progress will otherwise submit one on every retry: measured on this
   * city, 13 submissions across three ticks for a world whose rollback identity
   * could never resolve, which is a loop rather than a recovery. One attempt per
   * boundary per world epoch is the bound. A fresh process is a fresh question,
   * and a boundary that was established never reaches here again.
   */
  const automaticSaveAttempts = new Set<string>();
  const completeAutomaticSave = async (
    boundaryKey: string,
    label: "baseline" | "recovery",
    name: string,
    matches: (status: Record<string, unknown>) => boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    if (automaticSaveAttempts.has(boundaryKey)) {
      throw new Error(
        `${label} checkpoint was already attempted for this world and the boundary is still unresolved; ` +
          "not saving again",
      );
    }
    automaticSaveAttempts.add(boundaryKey);
    return completeWorldSave(label, name, matches, signal);
  };
  const ensureDurableWorldOnce = async (signal?: AbortSignal) => {
    if (!durability) throw new Error("V2 durability is not configured");
    let gameState = await callTool("cs2_game_state", {}, signal);
    let activation = durability.activate(gameState);
    // A save this store never registered no longer has to be proven command by
    // command before the Mayor may move. `activate` re-baselines such a world on
    // the save itself and reports `DESCENDANT_CHECKPOINT_REQUIRED`, which the
    // branch below turns into a rollback boundary; nothing here needs to
    // interrogate the loaded world's inherited effects first.
    // A registered checkpoint rollback can be recognized without entering the
    // unregistered-descendant path above. Terminal placement commands beyond
    // that exact cut remain immutable history, but a fresh current-world read
    // is still required before the active branch can authorize another first
    // facility. Record only an observation; never reconcile or replay the old
    // command.
    const activePlacementCommands = durability.snapshot().commands.filter((entry) => {
      const command = entry.record;
      if (command.actionFamily !== "UTILITY" || !durability.isCommandOutsideActiveCheckpoint(command.commandId)) return false;
      const actions = parseExactActions(command.authorizedScope);
      if (actions.length === 0 || actions.some((action) => action.type !== "place_building")) return false;
      return !durability.worldObservations(command.commandId).some((observation) =>
        observation.worldId === activation.world.worldId && observation.worldEpochId === activation.world.worldEpochId,
      );
    });
    for (const entry of activePlacementCommands) {
      const effect = await observeCommandEffectInCurrentWorld(entry.record, signal);
      if (effect.verdict !== "UNPROVEN") {
        durability.recordCurrentWorldObservation({
          commandId: effect.commandId,
          currentWorldEffectPresent: effect.verdict === "EFFECT_PRESENT" ? true : effect.verdict === "EFFECT_ABSENT" ? false : null,
          currentWorldObjectiveSatisfied: effect.objectiveSatisfied,
          evidence: effect.evidence,
          worldEpochId: activation.world.worldEpochId,
        });
      }
    }
    if (activation.status === "DESCENDANT_CHECKPOINT_REQUIRED") {
      // Authority is reconstructed, but the loaded save carries no native
      // checkpoint identity of its own, so execution stays blocked until this
      // store records a completed save for the current world and adopts it as
      // the rollback boundary. The inherited journal cut rides along in the
      // checkpoint, which is what keeps the reconstructed commands applicable.
      const matchesWorldSave = (status: Record<string, unknown>) =>
        status.status === "COMPLETED" &&
        status.durable === true &&
        status.worldId === activation.world.worldId &&
        status.worldGeneration === activation.world.generation &&
        record(status.checkpoint).nativeSessionGuid === activation.world.nativeSessionGuid;
      // A durable save of this world may already exist because the user made one.
      // Adopting it costs nothing and is the whole point of the product rule, so
      // it is looked for before anything is submitted. The save this world was
      // loaded from is the strongest such case and is checked first.
      const available =
        (await findLoadedWorldSave(activation.world, signal)) ?? (await findAvailableWorldSave(matchesWorldSave, signal));
      if (!available && options.automaticRecoverySave !== true) {
        // Producing one means driving the native save, and the Mayor does not do
        // that on its own: the save and the rollback point are the user's to
        // choose. Failing closed here keeps write authority blocked and waits,
        // rather than turning a durability gap into an unrequested save of the
        // player's city. Only an explicit opt-in reaches the submission below.
        return {
          ...activation,
          blockedReason:
            "DESCENDANT_USER_SAVE_REQUIRED: no durable save of this world exists and the Mayor does not save the game on its own; save the city, then re-run the durable recovery",
        };
      }
      const receipt =
        available ??
        (await completeAutomaticSave(
          `recovery:${activation.world.worldEpochId}`,
          "recovery",
          `AI Mayor V2 Recovery ${activation.world.nativeSessionGuid.slice(0, 8)}`,
          matchesWorldSave,
          signal,
        ));
      durability.certifyDescendantCheckpoint(receipt as unknown as SaveCompletionReceipt);
      activation = durability.activate(await callTool("cs2_game_state", {}, signal));
    }
    if (activation.status === "BASELINE_CHECKPOINT_REQUIRED") {
      const baselineJournalPosition = durability.currentJournalPosition();
      const baselineCommandCount = durability.snapshot().commands.length;
      const baselineSemanticMarkers = (() => {
        const root = record(gameState);
        const nativeWorld = record(root.world);
        return {
          topologyRevision: root.topologyRevision ?? nativeWorld.topologyRevision,
          observedWorldRevision: root.observedWorldRevision ?? nativeWorld.observedWorldRevision,
        };
      })();
      const assertStableFreshWorld = (value: unknown) => {
        const observed = record(value);
        const simulation = record(observed.simulation);
        const nativeWorld = record(observed.world);
        const identity = durability.activate(value).world;
        const observedSemanticMarkers = {
          topologyRevision: observed.topologyRevision ?? nativeWorld.topologyRevision,
          observedWorldRevision: observed.observedWorldRevision ?? nativeWorld.observedWorldRevision,
        };
        if (
          (identity.loadPurpose !== "NewGame" && identity.legacyOnboardingCandidate !== true) ||
          identity.checkpointId !== null ||
          identity.worldId !== activation.world.worldId ||
          identity.nativeSessionGuid !== activation.world.nativeSessionGuid ||
          identity.generation !== activation.world.generation ||
          identity.worldEpochId !== activation.world.worldEpochId ||
          simulation.paused !== true ||
          nativeWorld.nativeOperationBusy !== false ||
          nativeWorld.nativeOperationStage !== "Idle" ||
          durability.currentJournalPosition() !== baselineJournalPosition ||
          durability.snapshot().commands.length !== baselineCommandCount ||
          observedSemanticMarkers.topologyRevision !== baselineSemanticMarkers.topologyRevision ||
          observedSemanticMarkers.observedWorldRevision !== baselineSemanticMarkers.observedWorldRevision
        ) throw new Error("fresh baseline world changed or is not authoritatively stable; Mayor writes remain blocked");
      };
      assertStableFreshWorld(gameState);
      const saveStatus = await completeAutomaticSave(
        `baseline:${activation.world.worldEpochId}`,
        "baseline",
        `AI Mayor V2 Baseline ${activation.world.nativeSessionGuid.slice(0, 8)}`,
        (status) =>
          status.status === "COMPLETED" &&
          status.durable === true &&
          status.worldId === activation.world.worldId &&
          status.worldGeneration === activation.world.generation &&
          record(status.checkpoint).nativeSessionGuid === activation.world.nativeSessionGuid,
        signal,
      );
      gameState = await callTool("cs2_game_state", {}, signal);
      assertStableFreshWorld(gameState);
      durability.recordBaselineCheckpoint(saveStatus as unknown as SaveCompletionReceipt);
      activation = durability.activate(gameState);
    }
    if (activation.status === "EXECUTION_WORLD_VERIFICATION_REQUIRED") {
      const expected = activation.world;
      // Capture the current planning inputs while this branch is still
      // unroutable. Admission performs its scoped facility and objective reads
      // after this gate opens, using the current world as its sole reality.
      parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal));
      const snapshot = record(await callTool("cs2_mayor_snapshot", {}, signal));
      if (Object.keys(snapshot).length === 0) throw new Error("HISTORICAL_BRANCH_PLANNING_READBACK_EMPTY");
      const afterReadback = await callTool("cs2_game_state", {}, signal);
      const confirmed = durability.activate(afterReadback);
      const afterRoot = record(afterReadback);
      const afterWorld = record(afterRoot.world);
      if (confirmed.world.worldId !== expected.worldId || confirmed.world.generation !== expected.generation ||
        confirmed.world.worldEpochId !== expected.worldEpochId || confirmed.world.checkpointId !== expected.checkpointId ||
        confirmed.world.nativeSessionGuid !== expected.nativeSessionGuid || confirmed.world.worldReady !== true ||
        afterRoot.isLoading !== false || afterRoot.cityLoaded !== true ||
        afterWorld.nativeOperationBusy !== false || afterWorld.nativeOperationStage !== "Idle") {
        throw new Error("HISTORICAL_BRANCH_WORLD_CHANGED_DURING_READBACK");
      }
      durability.markExecutionBranchWorldVerified({
        worldId: expected.worldId,
        generation: expected.generation,
        worldEpochId: expected.worldEpochId,
        checkpointId: expected.checkpointId!,
      });
      activation = durability.activate(afterReadback);
    }
    if (!["ACTIVATED", "ACTIVATED_IN_PLACE"].includes(activation.status)) return activation;
    const restartReconciliationResults: Array<{ commandId: string; result: RestartReconciliationResult }> = [];
    for (const entry of durability.reconciliationRequired()) {
      const result = await reconcileDurableCommand(entry, signal);
      durability.reconcile(entry.record.commandId, result);
      restartReconciliationResults.push({ commandId: entry.record.commandId, result });
    }
    const unresolvedReconciliation = durability.reconciliationRequired();
    if (unresolvedReconciliation.length > 0) {
      throw new Error(`restart reconciliation remains inconclusive; automatic world write is blocked: ${JSON.stringify(
        unresolvedReconciliation.map((entry) => ({ commandId: entry.record.commandId, actionFamily: entry.record.authorizedScope.actionFamily,
          status: entry.record.status, result: restartReconciliationResults.find((item) => item.commandId === entry.record.commandId)?.result ?? null })),
      )}`);
    }
    return activation;
  };
  const requireActivatedDurableWorld = async (signal?: AbortSignal) => {
    const activation = await ensureDurableWorld(signal);
    if (!durability.isExecutionDurablyActivated(activation)) {
      // The blocked reason is the actionable half of the refusal �?it names what
      // has to happen before write authority exists �?so it is preferred over
      // the bare status whenever the activation carries one.
      throw new Error(
        activation.blockedReason ??
          `${activation.status}: Local V2 durable execution boundary is not certified for this world`,
      );
    }
    return activation;
  };
  const observeFinance = async (signal?: AbortSignal): Promise<FinanceObservation | undefined> => {
    const overview = record(await callTool("cs2_city_overview", {}, signal));
    if (
      typeof overview.treasury !== "number" ||
      !Number.isFinite(overview.treasury) ||
      typeof overview.unlimitedMoney !== "boolean" ||
      typeof overview.treasuryFrame !== "number" ||
      !Number.isFinite(overview.treasuryFrame) ||
      overview.treasuryProvenance !== "OBSERVED_NATIVE"
    ) return undefined;
    return {
      schemaVersion: V2_FINANCE_SCHEMA_VERSION,
      treasuryAmount: overview.treasury,
      unlimitedMoney: overview.unlimitedMoney,
      runtimeEpoch: `bridge:${overview.treasuryFrame}`,
      frame: overview.treasuryFrame,
      observedAt: (options.now ?? (() => new Date()))().toISOString(),
      freshness: "FRESH",
      provenance: "OBSERVED_NATIVE",
    };
  };
  const baseRoad = createV2RoadKernel({
    journal: commandJournal,
    observeFinance,
    submit: (input, signal) => callTool("cs2_build_road", { ...input }, signal),
    observation,
    effectMatcher,
    now: options.now,
    createId: options.createId,
    persistCreatedCommand: (record, request) => {
      const junction = request.proposal.input.networkJunctionInsert;
      if (junction) {
        if (!durability || !request.networkJunctionPreview || record.authorizedScope.actionFamily !== "ROAD" ||
          record.authorizedScope.networkJunctionInsert?.operationKind !== junction.kind ||
          record.authorizedScope.networkJunctionInsert.identityFingerprint !==
            request.networkJunctionPreview.evidence.identityFingerprint ||
          record.authorizedScope.networkJunctionInsert.replacementFingerprint !==
            request.networkJunctionPreview.evidence.replacementFingerprint) {
          throw new Error("BOUNDED_JUNCTION_DURABLE_COMMAND_BINDING_MISMATCH");
        }
        durability.commandJournal.create(record);
        const persisted = durability.commandJournal.get(record.commandId);
        if (!persisted || persisted.status !== "CREATED") throw new Error("BOUNDED_JUNCTION_DURABLE_COMMAND_NOT_PERSISTED");
        return persisted;
      }
      const repair = request.facilityAccessRoadRepair;
      if (!repair || !durability) throw new Error("FACILITY_ACCESS_ROAD_DURABLE_COMMIT_UNAVAILABLE");
      return durability.commitFacilityAccessRoadRepairCommand({
        amendmentId: repair.amendmentId,
        expectedJournalPosition: repair.expectedJournalPosition,
        expectedWorldId: repair.expectedWorldId,
        expectedCheckpointId: repair.expectedCheckpointId,
        expectedGeneration: repair.expectedGeneration,
        repairLineage: repair.repairLineage,
        planRevision: repair.planRevision,
        actionFingerprint: repair.actionFingerprint,
        command: record,
      });
    },
  });
  const road: V2RoadKernel = durability
    ? {
        execute: async (request, signal) => {
          await requireActivatedDurableWorld(signal);
          const synthetic: V2CommandRecord = {
            schemaVersion: "ai-mayor-v2-command/1",
            commandId: "durability-preflight",
            actionFamily: "ROAD",
            actionType: "build_road",
            authorizedScope: {
              owner: request.proposal.owner,
              actionFamily: "ROAD",
              proposalId: request.proposal.identity.proposalId,
              quoteId: request.proposal.quoteId,
              fingerprint: request.proposal.fingerprint,
              exactInput: request.proposal.identity.exactInput,
              ...(request.worldGeneration ? { worldGeneration: request.worldGeneration } : {}),
              budget: {
                authorizedMaxSpend: request.authorizedMaxSpend,
                treasurySafetyReserve: request.treasurySafetyReserve,
                currency: "GAME_MONEY",
              },
              observationPrecondition: {
                runtimeEpoch: request.proposal.identity.runtimeEpoch,
                frame: request.proposal.identity.frame,
              },
              expiresAt: request.quote?.expiresAt ?? new Date(0).toISOString(),
            },
            createdAt: "",
            submittedAt: null,
            nativeResultSummary: null,
            status: "CREATED",
            statusHistory: [],
            reconciliationStatus: "NOT_STARTED",
            observationEvidence: [],
            failureOrUnknownReason: null,
            effectAbsenceProven: false,
          };
          const roadKey = commandIdempotencyKey(synthetic);
          const priorRoadCommand = commandJournal.list().find((entry) => commandIdempotencyKey(entry) === roadKey);
          if (request.facilityAccessRoadRepair) {
            if (priorRoadCommand && priorRoadCommand.status !== "CREATED") {
              throw new Error("FACILITY_ACCESS_ROAD_COMMAND_ALREADY_SUBMITTED");
            }
            // A persisted CREATED command is the commit-before-submit crash
            // window. It may be resumed under the same identity, never minted
            // as another command. Every later state is reconcile-only.
          } else durability.assertMutationAllowed(roadKey);
          return baseRoad.execute(request, signal);
        },
        reconcile: async (commandId, signal) => {
          await requireActivatedDurableWorld(signal);
          return baseRoad.reconcile(commandId, signal);
        },
      }
    : baseRoad;
  const utilityService = createTargetUtilityServicePorts({
    runtimeEpoch: observation.runtimeEpoch,
    readGameState: readers.readGameState,
    readTarget: (buildingRef, signal) =>
      source(() =>
        callTool(
          "cs2_utility_connectors",
          { index: buildingRef.index, version: buildingRef.version },
          signal,
        ) as Promise<Record<string, unknown>>,
      ),
    now: options.now,
    createId: options.createId,
  });
  const targetAccess = createTargetAccessPorts({
    runtimeEpoch: observation.runtimeEpoch,
    readGameState: readers.readGameState,
    readTarget: (buildingRef, signal) =>
      source(() =>
        callTool(
          "cs2_building_access",
          { index: buildingRef.index, version: buildingRef.version },
          signal,
        ) as Promise<Record<string, unknown>>,
      ),
    now: options.now,
    createId: options.createId,
  });
  const readBuildingResidents = async (buildingRef: SpatialEntityRef, signal?: AbortSignal) =>
    source(async () => {
      const value = record(await callTool("cs2_inspect", buildingRef as unknown as Record<string, unknown>, signal));
      if (!Array.isArray(value.renters)) {
        throw new Error("authoritative renters field is unavailable; resident count is UNKNOWN");
      }
      const renters = value.renters.map(record);
      const counts = renters.map((renter) => renter.citizens ?? renter.citizenCount);
      if (counts.some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0)) {
        throw new Error("authoritative renter citizen count is unavailable; resident count is UNKNOWN");
      }
      const residentCount = counts.reduce<number>((sum, count) => sum + (count as number), 0);
      return {
        residentCount,
        occupied: residentCount > 0,
        provenance: "OBSERVED_NATIVE_COMPONENT" as const,
      } satisfies Gate1ResidentObservation;
    });
  const routeQuery = createTargetRouteQueryPorts({
    runtimeEpoch: observation.runtimeEpoch,
    submit: (request) => callTool("cs2_submit_building_route_query", {
      queryId: request.queryId, buildingIndex: request.buildingRef.index, buildingVersion: request.buildingRef.version,
      anchorIndex: request.targetAnchor.lane.index, anchorVersion: request.targetAnchor.lane.version,
      anchorDelta: request.targetAnchor.delta,
    }, request.signal),
    status: (queryId, signal) => callTool("cs2_building_route_query_status", { queryId }, signal),
    createId: options.createId,
    resume: true,
  });

  const observeUtility = async (kind: UtilityRecoveryKind, signal?: AbortSignal): Promise<GreenfieldUtilityObservation> => {
    try {
      const snapshot = record(await callTool("cs2_mayor_snapshot", {}, signal));
      const utility = record(record(snapshot.utilities)[kind]);
      const capacityValue = utility[kind === "electricity" ? "production" : "capacity"];
      const consumptionValue = utility.consumption;
      const fulfilledValue = utility.fulfilledConsumption;
      if (utility.status !== "available" || typeof capacityValue !== "number" || typeof consumptionValue !== "number") {
        return { status: "UNKNOWN", revision: null, capacity: null, consumption: null, fulfilledConsumption: null, issueActive: true };
      }
      const game = record(await callTool("cs2_game_state", {}, signal));
      const simulation = record(game.simulation);
      const world = record(game.world);
      const capacity = capacityValue;
      const consumption = consumptionValue;
      const fulfilledConsumption = typeof fulfilledValue === "number" ? fulfilledValue : null;
      const freshness = world.simulationHasTickedSinceLoad === true ? "SETTLED" as const
        : world.simulationHasTickedSinceLoad === false ? "UNSETTLED" as const : "UNKNOWN" as const;
      if (freshness !== "SETTLED") {
        return {
          status: "UNKNOWN", revision: `${String(world.generation ?? "unknown")}:${String(simulation.frameIndex ?? "unknown")}`,
          capacity, consumption, fulfilledConsumption, issueActive: true, freshness,
        };
      }
      return {
        status: "AVAILABLE",
        revision: `${String(world.generation ?? "unknown")}:${String(simulation.frameIndex ?? "unknown")}`,
        capacity,
        consumption,
        fulfilledConsumption,
        issueActive: capacity <= 0 || capacity < consumption ||
          (fulfilledConsumption !== null && fulfilledConsumption < consumption),
        freshness,
      };
    } catch {
      return { status: "UNKNOWN", revision: null, capacity: null, consumption: null, fulfilledConsumption: null, issueActive: true };
    }
  };
  const scopedUtilityState = (scope: Pick<GreenfieldUtilityExecutionScope, "projectId" | "trancheId">): DurableGreenfieldUtilityState | null => {
    if (!durability) throw new Error("V2 durability is required for Utility execution");
    const project = durability.projectState();
    if (project.schemaVersion !== "ai-mayor-v2-gate1-state/2" || project.project.id !== scope.projectId ||
      project.tranche.id !== scope.trancheId) return null;
    return project.tranche.utilityExecution ?? null;
  };
  const currentConnectionFacilityPlan = (
    kind: UtilityRecoveryKind,
    scope: GreenfieldUtilityExecutionScope,
    binding: UtilityCurrentBinding,
    connectionPlan: UtilityConnectionPlan,
  ): PlannedUtilityFacility => {
    const storedPlan = scopedUtilityState(scope)?.utilities[kind]?.plan;
    if (!storedPlan) throw new Error("CURRENT_UTILITY_FACILITY_PLAN_METADATA_UNAVAILABLE");
    return {
      ...structuredClone(storedPlan),
      position: { ...binding.facility.position },
      connection: structuredClone(connectionPlan.connection),
      serviceRoads: structuredClone(connectionPlan.serviceRoads ?? []),
    };
  };
  const currentConnectionPlanFromFacility = (
    kind: UtilityRecoveryKind,
    scope: GreenfieldUtilityExecutionScope,
    binding: UtilityCurrentBinding,
    facilityPlan: PlannedUtilityFacility,
  ): UtilityConnectionPlan => ({
    mode: "EXISTING_FACILITY_CONNECTION",
    kind,
    facility: binding.facility,
    serviceRoads: structuredClone(facilityPlan.serviceRoads ?? []),
    authoritativeRoadRefs: [scope.targetServiceEntry.road],
    connection: structuredClone(facilityPlan.connection),
    ...(facilityPlan.connectionEndpointBindings
      ? { connectionEndpointBindings: structuredClone(facilityPlan.connectionEndpointBindings) } : {}),
  });
  const saveScopedUtilityState = (value: DurableGreenfieldUtilityState) => {
    if (!durability) throw new Error("V2 durability is required for Utility execution");
    const project = durability.projectState();
    if (project.schemaVersion !== "ai-mayor-v2-gate1-state/2" || project.project.id !== value.scope.projectId ||
      project.tranche.id !== value.scope.trancheId) throw new Error("utility durable Project binding changed");
    project.tranche.utilityExecution = structuredClone(value);
    durability.saveProjectState(project);
  };
  const rebindFacilityAndConnector = async (
    planned: PlannedUtilityFacility,
    signal?: AbortSignal,
    utility: UtilityRecoveryKind = "electricity",
  ): Promise<GreenfieldUtilityRebindResult> => {
    const listed = record(await callTool("cs2_list_buildings", { query: planned.prefab, limit: 64 }, signal));
    const buildings = Array.isArray(listed.buildings) ? listed.buildings : null;
    if (!buildings || listed.truncated === true || listed.hasMore === true || listed.complete === false)
      return { status: "UNKNOWN", reason: "UTILITY_FACILITY_OBSERVATION_INCOMPLETE" };
    const matches = buildings.map(record).filter((candidate) => {
      const p = record(candidate.position);
      return candidate.prefab === planned.prefab && candidate.isSubBuilding !== true &&
        Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z)) &&
        Math.hypot(Number(p.x) - planned.position.x, Number(p.z) - planned.position.z) <= 1.5;
    });
    if (matches.length === 0) return { status: "PROVEN_MISSING", reason: "UTILITY_FACILITY_PROVEN_MISSING" };
    if (matches.length !== 1) return { status: "UNKNOWN", reason: "UTILITY_FACILITY_REBIND_AMBIGUOUS" };
    const building = matches[0]; const entity = record(building.entity); const position = record(building.position);
    if (!Number.isInteger(Number(entity.index)) || !Number.isInteger(Number(entity.version)))
      return { status: "UNKNOWN", reason: "UTILITY_FACILITY_ENTITY_INVALID" };
    const rawResult = record(await callTool("cs2_utility_connectors", { index: Number(entity.index), version: Number(entity.version) }, signal));
    const connectors = Array.isArray(rawResult.connectors) ? rawResult.connectors.map(record) : null;
    if (!connectors || rawResult.truncated === true || rawResult.hasMore === true || rawResult.complete === false)
      return { status: "UNKNOWN", reason: "UTILITY_CONNECTOR_OBSERVATION_INCOMPLETE" };
    // The completeness guards above already verified the building list and the
    // connector payload (no truncation, exactly one match), so this observation
    // is complete: attest it, or every planned-site rebind resolves BLOCKED and
    // the workflow can never leave the placement-unresolved hold.
    const resolved = resolveCurrentUtilityBinding({
      planned, utility, buildings, connectors, generation: options.runtimeEpoch ?? "UNKNOWN", observationComplete: true,
      // The connectors above were read for THIS facility's entity, so which ones
      // belong to it is settled �?no proximity rule is needed, and the one that
      // used to apply only fits prefabs whose connector sits on their origin.
      connectorsScopedToFacilityEntity: true,
    });
    if (resolved.status !== "MATCH") {
      const reason = resolved.reason === "UTILITY_FACILITY_NOT_FOUND" ? "UTILITY_FACILITY_PROVEN_MISSING" :
        resolved.reason === "UTILITY_CONNECTOR_NOT_FOUND" ? "UTILITY_CONNECTOR_PROVEN_MISSING" : resolved.reason;
      return { status: reason === "UTILITY_FACILITY_PROVEN_MISSING" || reason === "UTILITY_CONNECTOR_PROVEN_MISSING" ? "PROVEN_MISSING" : "UNKNOWN", reason };
    }
    return { status: "MATCH", facility: resolved.binding.currentFacility, connector: resolved.binding.currentConnector };
  };
    /**
     * Resolve a durable network endpoint descriptor to exactly one live node.
     * The descriptor contains geometry/topology selectors only; any entity ID
     * produced here is a generation-local witness for this preflight/request.
     */
    const rebindUtilityNetworkEndpoint = async (
      binding: UtilityEndpointBinding,
      scope: GreenfieldUtilityExecutionScope,
      signal?: AbortSignal,
      exactNetworkLinkAction = false,
    ): Promise<BoundUtilityEndpoint> => {
      if (binding.mode === "FREE_POINT") {
        const result = rebindUtilityEndpoint({ binding, nodes: [], worldId: scope.worldId, generation: scope.generation });
        if (result.status !== "PASS") throw new Error(result.reason);
        return result.endpoint;
      }
      const lookup = binding.topologyLookup;
      if (!lookup?.sourceAnchor) throw new Error("UTILITY_ENDPOINT_TOPOLOGY_ANCHOR_MISSING");
      const roadRead = record(await callTool("cs2_list_roads", { query: lookup.networkEdgePrefab, limit: 500 }, signal));
      const roads = Array.isArray(roadRead.roads) ? roadRead.roads.map(record) : null;
      if (!roads || roadRead.truncated === true || roadRead.hasMore === true || roadRead.complete === false) {
        throw new Error("UTILITY_ENDPOINT_ROAD_OBSERVATION_INCOMPLETE");
      }
      const samePoint = (left: unknown, right: { x: number; z: number }) => {
        const point = record(left);
        return Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.z)) &&
          Math.hypot(Number(point.x) - right.x, Number(point.z) - right.z) <= 0.25;
      };
      const geometry = lookup.edgeGeometry;
      const roadMatches = roads.filter((road) => {
        const start = record(road.start); const end = record(road.end);
        return road.prefab === lookup.networkEdgePrefab &&
          ((samePoint(start, { x: geometry.x1, z: geometry.z1 }) && samePoint(end, { x: geometry.x2, z: geometry.z2 })) ||
           (samePoint(start, { x: geometry.x2, z: geometry.z2 }) && samePoint(end, { x: geometry.x1, z: geometry.z1 })));
      });
      if (roadMatches.length !== 1) throw new Error(roadMatches.length === 0 ? "UTILITY_ENDPOINT_NETWORK_EDGE_MISSING" : "UTILITY_ENDPOINT_NETWORK_EDGE_AMBIGUOUS");
      const road = roadMatches[0]; const roadEntity = record(road.entity);
      if (!Number.isInteger(Number(roadEntity.index)) || !Number.isInteger(Number(roadEntity.version))) {
        throw new Error("UTILITY_ENDPOINT_NETWORK_EDGE_ID_INVALID");
      }
      const sourceRead = record(await callTool("cs2_list_buildings", { query: lookup.sourceAnchor.buildingPrefab, limit: 128 }, signal));
      const buildings = Array.isArray(sourceRead.buildings) ? sourceRead.buildings.map(record) : null;
      if (!buildings || sourceRead.truncated === true || sourceRead.hasMore === true || sourceRead.complete === false) {
        throw new Error("UTILITY_ENDPOINT_SOURCE_OBSERVATION_INCOMPLETE");
      }
      const sourcePosition = lookup.sourceAnchor.position;
      const sourceMatches = buildings.filter((building) => {
        const position = record(building.position);
        return building.prefab === lookup.sourceAnchor!.buildingPrefab && building.isSubBuilding !== true &&
          Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z)) &&
          Math.hypot(Number(position.x) - sourcePosition.x, Number(position.z) - sourcePosition.z) <= 0.25;
      });
      if (sourceMatches.length !== 1) throw new Error(sourceMatches.length === 0 ? "UTILITY_ENDPOINT_SOURCE_ANCHOR_MISSING" : "UTILITY_ENDPOINT_SOURCE_ANCHOR_AMBIGUOUS");
      const sourceEntity = record(sourceMatches[0].entity);
      if (!Number.isInteger(Number(sourceEntity.index)) || !Number.isInteger(Number(sourceEntity.version))) {
        throw new Error("UTILITY_ENDPOINT_SOURCE_ENTITY_INVALID");
      }
      const connectorRead = record(await callTool("cs2_utility_connectors", {
        index: Number(sourceEntity.index), version: Number(sourceEntity.version),
      }, signal));
      const connectors = Array.isArray(connectorRead.connectors) ? connectorRead.connectors.map(record) : null;
      if (!connectors || connectorRead.truncated === true || connectorRead.hasMore === true || connectorRead.complete === false) {
        throw new Error("UTILITY_ENDPOINT_SOURCE_CONNECTOR_READ_INCOMPLETE");
      }
      const connectorMatches = connectors.filter((connector) => connector.type === lookup.sourceAnchor!.connectorUtility.toLowerCase());
      if (connectorMatches.length !== 1) throw new Error(connectorMatches.length === 0 ? "UTILITY_ENDPOINT_SOURCE_CONNECTOR_MISSING" : "UTILITY_ENDPOINT_SOURCE_CONNECTOR_AMBIGUOUS");
      const connectorNode = record(connectorMatches[0].node);
      if (!Number.isInteger(Number(connectorNode.index)) || !Number.isInteger(Number(connectorNode.version))) {
        throw new Error("UTILITY_ENDPOINT_SOURCE_CONNECTOR_ID_INVALID");
      }
      const topology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
        index: Number(sourceEntity.index), version: Number(sourceEntity.version),
        connector: { index: Number(connectorNode.index), version: Number(connectorNode.version) },
        target: { index: Number(roadEntity.index), version: Number(roadEntity.version) },
        expectedWorldId: scope.worldId, expectedGeneration: scope.generation,
        expectedTopologyRevision: bridgeTopologyRevision({ generation: scope.generation, target: roadEntity as unknown as SpatialEntityRef }),
        admittedPrefab: binding.prefab, admittedStart: { x: geometry.x1, z: geometry.z1 },
        admittedEnd: { x: geometry.x2, z: geometry.z2 }, endpointTolerance: 0.25,
        ...(!exactNetworkLinkAction ? { envelope: scope.spatialEnvelope } : {}),
      }, signal));
      const targetNetwork = record(topology.targetNetwork);
      const topologyBinding = record(topology.binding);
      const endpoints = Array.isArray(targetNetwork.targetEndpoints) ? targetNetwork.targetEndpoints.map(record) : null;
      if (!endpoints || (topology.bindingStatus ?? topologyBinding.bindingStatus) !== "VALID" ||
        (topology.complete ?? topologyBinding.complete) !== true || topology.truncated === true || topologyBinding.truncated === true) {
        throw new Error("UTILITY_ENDPOINT_TOPOLOGY_OBSERVATION_INCOMPLETE");
      }
      const endpointMatches = endpoints.filter((endpoint) => {
        const position = record(endpoint.position);
        const role = String(endpoint.role ?? endpoint.endpointRole ?? "").toUpperCase();
        return role === lookup.edgeEndpointRole && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y)) && Number.isFinite(Number(position.z)) &&
          Math.hypot(Number(position.x) - binding.expectedPosition.x, Number(position.y) - binding.expectedPosition.y,
            Number(position.z) - binding.expectedPosition.z) <= 0.25;
      });
      if (endpointMatches.length !== 1) throw new Error(endpointMatches.length === 0 ? "UTILITY_ENDPOINT_NODE_MISSING" : "UTILITY_ENDPOINT_NODE_AMBIGUOUS");
      const endpoint = endpointMatches[0];
      const node = record(endpoint.node); const position = record(endpoint.position);
      const flowNode = record(endpoint.electricityFlowNode);
      const sourceReachable = targetNetwork.targetNetworkReachable === true || targetNetwork.reachableFromSource === true;
      const observation: UtilityEndpointNodeObservation = {
        entity: { index: Number(node.index), version: Number(node.version) },
        position: { x: Number(position.x), y: Number(position.y), z: Number(position.z) },
        worldId: scope.worldId, generation: scope.generation, utility: binding.utility, prefab: binding.prefab,
        bindingRule: binding.bindingRule, topologyRole: binding.topologyRole,
        topologyVerified: Number.isInteger(Number(node.index)) && Number.isInteger(Number(node.version)) &&
          Number.isInteger(Number(flowNode.index)) && Number.isInteger(Number(flowNode.version)) &&
          (!lookup.requireSourceReachability || sourceReachable),
      };
      const result = rebindUtilityEndpoint({ binding, nodes: [observation], worldId: scope.worldId, generation: scope.generation, toleranceMeters: 0.25 });
      if (result.status !== "PASS") throw new Error(result.reason);
      return result.endpoint;
    };

    /**
     * Authoritative binding of the facility and connector that exist in the
     * *current* world. `rebindFacilityAndConnector` searches a planned site; this
     * one is plan-free, and it is what the connection-only execution boundary
     * needs once a first facility exists - placed in this attempt, or recovered
     * from the world after a crash. It never invents identity: an incomplete
     * observation stays BLOCKED.
     */
    const observeCurrentUtilityBinding = async (
      kind: UtilityRecoveryKind,
      signal?: AbortSignal,
    ): Promise<UtilityCurrentBindingResult> => {
      const query = kind === "electricity" ? "WindTurbine" : kind === "water" ? "Water" : "Sewage";
      const listed = record(await callTool("cs2_list_buildings", { query, limit: 64 }, signal));
      const buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : null;
      if (!buildings || listed.truncated === true || listed.hasMore === true || listed.complete === false) {
        return { status: "BLOCKED", reason: "UTILITY_FACILITY_OBSERVATION_INCOMPLETE" };
      }
      const matches = buildings.filter((building) => building.isSubBuilding !== true && record(building.entity).index !== undefined && record(building.position).x !== undefined);
      if (matches.length === 0) return { status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND" };
      const durableProject = durability?.projectState();
      const durableUtilities = record(record(record(durableProject).tranche).utilityExecution).utilities;
      const durableFacility = record(record(record(durableUtilities)[kind]).facility);
      const durableEntity = record(durableFacility.entity);
      const hasDurableEntity = Number.isInteger(durableEntity.index) && Number.isInteger(durableEntity.version);
      const boundMatches = hasDurableEntity
        ? matches.filter((building) => record(building.entity).index === durableEntity.index && record(building.entity).version === durableEntity.version)
        : [];
      // A complete world listing can contain multiple facilities of the same
      // prefab. When this durable tranche already names the facility entity,
      // bind that exact live entity instead of treating unrelated facilities
      // as ambiguity. The entity still has to occur exactly once in the fresh
      // current-world listing; a missing or duplicated identity fails closed.
      const selected = hasDurableEntity
        ? boundMatches.length === 1 ? boundMatches[0] : undefined
        : matches.length === 1 ? matches[0] : undefined;
      if (!selected) {
        if (hasDurableEntity && boundMatches.length === 0) return { status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND" };
        return { status: "BLOCKED", reason: "UTILITY_FACILITY_AMBIGUOUS", diagnostics: { count: hasDurableEntity ? boundMatches.length : matches.length } };
      }
      const rawEntity = record(selected.entity); const rawPosition = record(selected.position);
      const currentFacility: UtilityPlacementReceipt = {
        entity: { index: Number(rawEntity.index), version: Number(rawEntity.version) },
        prefab: String(selected.prefab ?? ""),
        position: { x: Number(rawPosition.x), z: Number(rawPosition.z) },
      };
      const payload = record(await callTool("cs2_utility_connectors", {
        index: currentFacility.entity.index, version: currentFacility.entity.version,
      }, signal));
      const rawConnectors = Array.isArray(payload.connectors) ? payload.connectors : null;
      if (!rawConnectors || payload.truncated === true || payload.hasMore === true || payload.complete === false) {
        return { status: "BLOCKED", reason: "UTILITY_CONNECTOR_OBSERVATION_INCOMPLETE" };
      }
      const connectors = rawConnectors.map((raw) => {
        const connector = record(raw); const node = record(connector.node); const position = record(connector.worldPosition);
        return {
          type: connector.type === "electricity" ? "electricity" as const : "waterPipe" as const,
          node: { index: Number(node.index), version: Number(node.version) },
          worldPosition: { x: Number(position.x), z: Number(position.z) },
          attached: connector.attached === true,
          orphan: connector.orphan === true,
          capacity: record(connector.capacity) as UtilityConnectorReadback["capacity"],
          connectedEdges: [],
        };
      });
      const resolved = resolveCurrentUtilityBinding({
        currentFacility, utility: kind, buildings, connectors, generation: options.runtimeEpoch ?? "UNKNOWN",
        observationComplete: true,
        // These connectors were read for the facility entity above, so
        // provenance settles membership; proximity would refuse every water
        // facility whose connector sits on its footprint rather than its origin.
        connectorsScopedToFacilityEntity: true,
      });
      if (resolved.status !== "MATCH") return resolved;
      return { status: "MATCH", binding: { facility: resolved.binding.currentFacility, connector: resolved.binding.currentConnector } };
    };

  const planScopedUtility = async (kind: UtilityRecoveryKind, scope: GreenfieldUtilityExecutionScope, signal?: AbortSignal, context?: UtilityPlanningContext) => {
    const scan = parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal));
    const model = buildSpatialWorldModel(scan);
    const areaDetail = parseV2SpatialSiteDetail(await callTool("cs2_spatial", {
      mode: "detail", x: scope.spatialEnvelope.center.x, z: scope.spatialEnvelope.center.z,
      radius: Math.max(64, scope.spatialEnvelope.radius), resolution: 128,
    }, signal));
    const currentRoadRefs = new Map(scan.roadGraph.edges.map((edge) => [`${edge.entity.index}:${edge.entity.version}`, edge.entity]));
    const authoritativeRoadRefs = new Map(scope.certifiedRoadRefs.map((ref) => [`${ref.index}:${ref.version}`, ref]));
    const durableRoadState = durability?.projectState();
    if (durability && durableRoadState?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
      durableRoadState.project.id === scope.projectId && durableRoadState.tranche.id === scope.trancheId) {
      const authorizedUtilityRoadTasks = new Set(durableRoadState.tasks.filter((task) => task.kind === "ROAD_CONNECTION" &&
        task.trancheId === scope.trancheId && !!task.utilityRoadParentTaskId).map((task) => task.id));
      for (const command of commandJournal.list()) {
        if (command.actionFamily !== "ROAD" || command.status !== "OBSERVED_MATCH" || command.reconciliationStatus !== "MATCH" ||
          command.authorizedScope.owner.ownerType !== "TASK" || !authorizedUtilityRoadTasks.has(command.authorizedScope.owner.ownerId)) continue;
        const observation = [...command.observationEvidence].reverse().find((entry) => entry.phase === "RECONCILIATION" &&
          record(entry.details).matcherResult === "MATCH");
        const matchedEdges = Array.isArray(record(observation?.details).matchedEdges) ? record(observation?.details).matchedEdges as unknown[] : [];
        for (const rawRef of matchedEdges) {
          const ref = record(rawRef);
          const key = `${Number(ref.index)}:${Number(ref.version)}`;
          const current = currentRoadRefs.get(key);
          if (current) authoritativeRoadRefs.set(key, current);
        }
      }
    }
    const roadAuthorityRefs = [...authoritativeRoadRefs.values()];
    const allowed = new Set(roadAuthorityRefs.map((ref) => `${ref.index}:${ref.version}`));
    const roadAuthority = scopeRoadAuthority({
      certifiedRoadRefs: roadAuthorityRefs,
      approvedContact: scope.targetServiceEntry.position,
      currentWorldPlayerRoads: scan.roadGraph.edges,
      ...(scope.targetServiceEntry.prefab ? { certifiedRoadPrefab: scope.targetServiceEntry.prefab } : {}),
      ...(scope.targetServiceEntry.farEnd ? { certifiedRoadFarEndpoint: scope.targetServiceEntry.farEnd } : {}),
    });
    const scopedDetail = {
      ...areaDetail,
      roadGraph: { ...areaDetail.roadGraph, edges: roadAuthority },
    };
    if (allowed.size > 0 && scopedDetail.roadGraph.edges.length !== roadAuthorityRefs.length) throw new Error("STALE_UTILITY_CERTIFIED_ROAD_TOPOLOGY");
    if (context?.mode === "EXISTING_FACILITY_CONNECTION") {
      const currentFacility = areaDetail.buildings.find((building) =>
        building.entity.index === context.binding.facility.entity.index &&
        building.entity.version === context.binding.facility.entity.version);
      if (!currentFacility) throw new Error("UTILITY_CURRENT_FACILITY_GEOMETRY_UNAVAILABLE");
      const asset = scan.bootstrapAssets.find((candidate) => candidate.prefab === context.binding.facility.prefab);
      if (!asset) throw new Error("UTILITY_CURRENT_FACILITY_ASSET_UNAVAILABLE");
      const rotation = currentFacility.rotation;
      const rotationDegrees = Math.atan2(
        2 * (rotation.w * rotation.y + rotation.x * rotation.z),
        1 - 2 * (rotation.y * rotation.y + rotation.x * rotation.x),
      ) * 180 / Math.PI;
      const planningJournal = durableUtilityPlanningJournal(durableRoadState, kind);
      const siteFingerprint = JSON.stringify({ kind, objectiveId: scope.intentId, projectId: scope.projectId,
        trancheId: scope.trancheId, worldEpochId: scope.worldEpochId, topologyRevision: scope.topologyRevision,
        utilityRevision: worldState.revision("UTILITY"),
        facility: { entity: context.binding.facility.entity, prefab: context.binding.facility.prefab,
          position: context.binding.facility.position }, connector: { entity: context.binding.connector.node,
          position: context.binding.connector.worldPosition },
        roads: roadAuthorityRefs.map((ref) => `${ref.index}:${ref.version}`).sort() });
      // The service-road child was the earlier stage that delivered the road
      // course. Once a facility is already placed, connection planning must
      // bind a cable to the currently certified target road directly; planning
      // another service-road child can revive an already delivered or exhausted
      // road objective and prevent the durable connection ledger from rebinding.
      const currentRoadTaskId = durableRoadState?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
        ? durableRoadState.tranche.currentTaskIds?.ROAD_CONNECTION : undefined;
      const currentRoadTask = currentRoadTaskId
        ? durableRoadState?.tasks.find((task) => task.id === currentRoadTaskId && task.trancheId === scope.trancheId)
        : undefined;
      const currentRoadOutcome = currentRoadTask?.terminalOutcomeId
        ? durableRoadState?.journal.find((entry) => entry.id === currentRoadTask.terminalOutcomeId && entry.taskId === currentRoadTask.id)
        : undefined;
      const currentServiceRoadHasNoEffect = currentRoadTask?.kind === "ROAD_CONNECTION" &&
        currentRoadTask.status === "FAILED" && !!currentRoadTask.utilityRoadParentTaskId &&
        currentRoadOutcome?.execution === "NOT_REQUIRED" &&
        currentRoadOutcome.reason.includes("NO_PRODUCTIVE_ROAD_EFFECT");
      if (currentServiceRoadHasNoEffect) {
        const currentTargetRoadMatches = scopedDetail.roadGraph.edges.filter((edge) =>
          edge.entity.index === scope.targetServiceEntry.road.index &&
          edge.entity.version === scope.targetServiceEntry.road.version);
        if (currentTargetRoadMatches.length !== 1) throw new Error("UTILITY_CURRENT_TARGET_ROAD_NOT_AUTHORITATIVE");
        return {
          connection: {
            mode: "EXISTING_FACILITY_CONNECTION" as const,
            kind,
            facility: context.binding.facility,
            serviceRoads: [],
            authoritativeRoadRefs: [currentTargetRoadMatches[0].entity],
            connection: {
              prefab: kind === "electricity" ? "Low-voltage Ground Cable" : kind === "water" ? "Small Water Pipe" : "Small Sewage Pipe",
              start: context.binding.connector.worldPosition,
              end: scope.targetServiceEntry.position,
            },
          },
          diagnostics: {
            selectedTopology: "authoritative-direct-cable-after-unproductive-road-child",
            siteFingerprint,
            roadCountFullScan: scan.roadGraph.edges.length,
            roadCountBoundedDetail: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToCandidateBuilder: scopedDetail.roadGraph.edges.length,
          },
        };
      }
      const siteAlreadyExhausted = planningJournal.some((entry) => entry.event === "UTILITY_SITE_CONTEXT_EXHAUSTED" &&
        entry.siteFingerprint === siteFingerprint);
      if (siteAlreadyExhausted) {
        throw new NoFeasibleRoadCandidateError([], { contactsTried: 0, rejectedCandidateCount: 0,
          allContactOptionsExhausted: true, facilitySiteExhausted: true, siteFingerprint,
          planningSignal: "NEXT_UTILITY_SITE_OR_TOPOLOGY" });
      }
      const rejectedPlanningCandidates = new Set(planningJournal.filter((entry) =>
        entry.event === "ROAD_PLANNING_CANDIDATE_REJECTED" && entry.planningContextFingerprint === siteFingerprint)
        .map((entry) => entry.candidateFingerprint).filter((value): value is string => typeof value === "string"));
      const rememberPlanningEntry = (entry: { event: "ROAD_PLANNING_CANDIDATE_REJECTED" | "UTILITY_SITE_CONTEXT_EXHAUSTED";
        planningContextFingerprint?: string; candidateFingerprint?: string; siteFingerprint?: string;
        sitePosition?: SpatialPoint2; reason: string }) => {
        const current = durability?.projectState();
        if (!current || current.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION || current.project.id !== scope.projectId ||
          current.tranche.id !== scope.trancheId || !current.tranche.utilityExecution) return;
        const utility = current.tranche.utilityExecution.utilities[kind];
        const journal = utility?.connectionReplan?.journal;
        if (!utility || !journal) return;
        if (entry.event === "ROAD_PLANNING_CANDIDATE_REJECTED" && journal.some((item) =>
          item.event === entry.event && item.planningContextFingerprint === entry.planningContextFingerprint &&
          item.candidateFingerprint === entry.candidateFingerprint)) return;
        if (entry.event === "UTILITY_SITE_CONTEXT_EXHAUSTED" && journal.some((item) =>
          item.event === entry.event && item.siteFingerprint === entry.siteFingerprint)) return;
        journal.push({ ...entry });
        durability!.saveProjectState(current);
      };
      const exhaustedContacts: SpatialPoint2[] = [];
      if (durability) {
        const durableProject = durability.projectState();
        const amendments = new Map(durability.utilityBudgetAmendments().map((entry) => [entry.amendmentId, entry]));
        if (durableProject.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && durableProject.project.id === scope.projectId &&
          durableProject.tranche.id === scope.trancheId) {
          for (const task of durableProject.tasks) {
            if (task.kind !== "ROAD_CONNECTION" || task.status !== "FAILED" || task.trancheId !== scope.trancheId ||
              !task.utilityRoadParentTaskId || !task.terminalOutcomeId) continue;
            const outcome = durableProject.journal.find((entry) => entry.id === task.terminalOutcomeId && entry.taskId === task.id);
            if (outcome?.execution !== "NOT_REQUIRED" || !outcome.reason.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE")) continue;
            const amendmentId = task.childOperationAmendmentId ?? task.childOperationAmendmentIds?.[0];
            const input = amendmentId ? amendments.get(amendmentId)?.exactRoadInput : undefined;
            if (!input) continue;
            const start = { x: input.x1, z: input.z1 }; const end = { x: input.x2, z: input.z2 };
            const contact = Math.hypot(start.x - context.binding.connector.worldPosition.x, start.z - context.binding.connector.worldPosition.z) >=
              Math.hypot(end.x - context.binding.connector.worldPosition.x, end.z - context.binding.connector.worldPosition.z) ? start : end;
            if (nearestPermanentRoadPoint(contact, scopedDetail.roadGraph.edges).distance <= 2 &&
              !exhaustedContacts.some((known) => Math.hypot(known.x - contact.x, known.z - contact.z) <= 2)) exhaustedContacts.push(contact);
          }
        }
      }
      const contacts = kind === "electricity"
        ? (() => {
            const semantic = scope.targetSemantics;
            if (!semantic) throw new Error("UTILITY_ELECTRIC_AUTHORIZED_TARGET_SEMANTICS_MISSING");
            const targetRoads = scopedDetail.roadGraph.edges.filter((edge) =>
              edge.entity.index === scope.targetServiceEntry.road.index &&
              edge.entity.version === scope.targetServiceEntry.road.version &&
              edge.prefab === semantic.targetRoad.prefab);
            if (targetRoads.length !== 1) throw new Error(targetRoads.length === 0
              ? "UTILITY_ELECTRIC_AUTHORIZED_TARGET_ROAD_MISSING" : "UTILITY_ELECTRIC_AUTHORIZED_TARGET_ROAD_AMBIGUOUS");
            const targetRoad = targetRoads[0];
            const point = semantic.targetRoad.endpointRole === "start" ? targetRoad.start : targetRoad.end;
            if (Math.hypot(point.x - semantic.approvedContact.x, point.z - semantic.approvedContact.z) > 0.25) {
              throw new Error("UTILITY_ELECTRIC_AUTHORIZED_TARGET_ENDPOINT_CHANGED");
            }
            return [{ roadRef: targetRoad.entity, point }];
          })()
        : rankedPermanentRoadContacts(context.binding.connector.worldPosition, scopedDetail.roadGraph.edges, exhaustedContacts);
      if (contacts.length === 0) throw new Error("UTILITY_SITE_CONTACT_OPTIONS_EXHAUSTED");
      const rejected: Array<{ candidateIndex: number; candidateId: string; reason: string; details?: Record<string, unknown> }> = [];
      for (const [contactIndex, target] of contacts.entries()) {
        const facilityServiceRoad = serviceRoadFor(kind, asset, context.binding.facility.position, target.point, rotationDegrees);
        if (!facilityServiceRoad) {
          rejected.push({ candidateIndex: rejected.length, candidateId: `contact-${contactIndex + 1}`, reason: "NO_SERVICE_ROAD_TO_AUTHORIZED_CONTACT" });
          continue;
        }
        const planningContext = { objectiveId: `${scope.intentId}:${scope.projectId}:${scope.trancheId}:${kind}`,
          worldEpochId: scope.worldEpochId,
          topologyRevision: `${scope.topologyRevision}|${roadAuthorityRefs.map((ref) => `${ref.index}:${ref.version}`).sort().join(",")}`,
          facility: { entity: context.binding.facility.entity, prefab: context.binding.facility.prefab,
            position: context.binding.facility.position },
          sourceEndpoint: { entity: context.binding.connector.node, position: context.binding.connector.worldPosition },
          targetContact: { road: target.roadRef, position: target.point } };
        const targetRoad = scopedDetail.roadGraph.edges.find((edge) => edge.entity.index === target.roadRef.index &&
          edge.entity.version === target.roadRef.version);
        const targetRoadLength = targetRoad ? Math.hypot(targetRoad.end.x - targetRoad.start.x, targetRoad.end.z - targetRoad.start.z) : 0;
        const targetRoadDirection = targetRoad && targetRoadLength > 0
          ? { x: (targetRoad.end.x - targetRoad.start.x) / targetRoadLength, z: (targetRoad.end.z - targetRoad.start.z) / targetRoadLength }
          : undefined;
        // The service road starts ON the target road it connects to, so a first leg
        // that follows that road is not a new road -- native folds it back into the
        // corridor and emits no proposal edge, which reads back as
        // NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED. The straight and lateral families
        // all leave within roughly 50 degrees of the direct bearing, so when the
        // destination lies along that corridor the whole family is inside it. Drop
        // the duplicating heads and let the bounded heading fan supply the rest.
        const routeCandidates = ROAD_NETWORK_PLANNING_SKILL.rankCandidates(serviceRoadRouteCandidates(facilityServiceRoad,
          targetRoadDirection ? { targetRoadDirection } : {})
          .filter((segments) => !targetRoadDirection ||
            !routeFirstLegDuplicatesCorridor(segments, targetRoadDirection))
          .map((segments, index) => ({ segments,
            family: segments[0]?.id.includes(":heading-fan:") ? "HEADING_FAN"
              : segments[0]?.id.includes(":junction-branch:") ? "T_JUNCTION_BRANCH"
                : index === 0 ? "STRAIGHT_EXTENSION" : "BOUNDED_CORRIDOR_DOGLEG",
            corridorReuse: index === 0 ? 0.5 : 0 })))
          .slice(0, SERVICE_ROAD_PROBE_LIMIT).map((candidate) => candidate.segments);
        const selection = await selectFeasibleRoadCandidate({
          candidates: routeCandidates,
          maximumCandidates: SERVICE_ROAD_PROBE_LIMIT,
          candidateId: (route, index) => route[0]?.id ?? `service-road-route-${index + 1}`,
          probe: async (route) => {
            for (const [segmentIndex, segment] of route.entries()) {
              const geometry = roadCourseGeometry(plannedRoadSegmentToMayorAction(segment));
              const candidateFingerprint = stableRoadInput(geometry, planningContext);
              if (rejectedPlanningCandidates.has(candidateFingerprint) || !shouldPreviewRoadCandidate({
                planningContextFingerprint: siteFingerprint, candidateFingerprint, memory: planningJournal,
              })) return {
                status: "INVALID" as const, reason: "PREVIOUSLY_REJECTED_IN_SAME_PLANNING_CONTEXT",
                details: { segmentIndex, segmentId: segment.id, candidateFingerprint },
              };
              await waitForNativeIdle(signal);
              let preview: Record<string, unknown>;
              try {
                try {
                  preview = record(await callTool("cs2_spatial", { mode: "preflight", kind: "net", ...geometry }, signal));
                } catch (error) {
                  const failure = roadCandidatePreviewFailureVerdict(error);
                  if (failure.status === "INVALID") {
                    rejectedPlanningCandidates.add(candidateFingerprint);
                    rememberPlanningEntry({ event: "ROAD_PLANNING_CANDIDATE_REJECTED",
                      planningContextFingerprint: siteFingerprint, candidateFingerprint, reason: failure.reason });
                    return { status: "INVALID" as const, reason: failure.reason,
                      details: { segmentIndex, segmentId: segment.id, ...failure.details } };
                  }
                  throw new RoadCandidatePreviewUnknownError(failure.reason);
                }
              } finally {
                await waitForNativeIdle(signal);
              }
              const verdict = rawRoadCandidatePreviewVerdict(preview);
              if (verdict.status === "UNKNOWN") throw new RoadCandidatePreviewUnknownError(verdict.reason);
              if (verdict.status === "INVALID") {
                rejectedPlanningCandidates.add(candidateFingerprint);
                rememberPlanningEntry({ event: "ROAD_PLANNING_CANDIDATE_REJECTED",
                  planningContextFingerprint: siteFingerprint, candidateFingerprint, reason: verdict.reason });
                return { status: "INVALID" as const, reason: verdict.reason, details: { segmentIndex, segmentId: segment.id } };
              }
            }
            return { status: "FEASIBLE" as const };
          },
        });
        if (selection.status !== "SELECTED") {
          for (const rejection of selection.rejections) rejected.push({
            candidateIndex: rejected.length, candidateId: `contact-${contactIndex + 1}:${rejection.candidateId}`,
            reason: rejection.reason, ...(rejection.details ? { details: rejection.details } : {}),
          });
          // Bounded service-road routes are one topology. Once exhausted for
          // this authorized contact, give the existing direct-cable primitive
          // its own native preview before moving to another contact or
          // returning planner exhaustion. Candidate construction and final
          // preparation remain in the shared utility recovery path.
          const directConnection = {
            mode: "EXISTING_FACILITY_CONNECTION" as const,
            kind,
            facility: context.binding.facility,
            serviceRoads: [],
            authoritativeRoadRefs: [target.roadRef],
            connection: {
              prefab: kind === "electricity" ? "Low-voltage Ground Cable" : kind === "water" ? "Small Water Pipe" : "Small Sewage Pipe",
              start: context.binding.connector.worldPosition,
              end: target.point,
            },
          };
          const directCandidate = buildUtilityConnectionCandidates(directConnection, context.binding.connector)
            .find((candidate) => candidate.primitive === "direct-cable");
          if (directCandidate && directCandidate.actions.length > 0) {
            let directAccepted = true;
            let directFailure: { reason: string; details?: Record<string, unknown> } | undefined;
            let directTargetEndpoint: ReturnType<typeof electricityTargetEndpoint> | undefined;
            if (kind === "electricity") {
              const endpointMatches = scopedDetail.roadGraph.edges.flatMap((edge) => {
                if (edge.entity.index !== target.roadRef.index || edge.entity.version !== target.roadRef.version) return [];
                const startDistance = Math.hypot(edge.start.x - target.point.x, edge.start.z - target.point.z);
                const endDistance = Math.hypot(edge.end.x - target.point.x, edge.end.z - target.point.z);
                return [
                  ...(startDistance <= 0.25 ? [{ edge, endpointRole: "start" as const, position: edge.start }] : []),
                  ...(endDistance <= 0.25 ? [{ edge, endpointRole: "end" as const, position: edge.end }] : []),
                ];
              });
              if (endpointMatches.length !== 1) {
                directAccepted = false;
                directFailure = { reason: endpointMatches.length === 0
                  ? "DIRECT_CABLE_CONTACT_IS_NOT_A_CERTIFIED_ROAD_ENDPOINT"
                  : "DIRECT_CABLE_CERTIFIED_ROAD_ENDPOINT_AMBIGUOUS", details: { endpointMatchCount: endpointMatches.length } };
              } else {
                const match = endpointMatches[0];
                const semantic = electricityTargetSemantics({
                  contact: target.point,
                  targetRoad: { prefab: match.edge.prefab, endpointRole: match.endpointRole, anchor: target.point },
                  approvedPlanRevision: scope.topologyRevision,
                });
                const topologyRevision = bridgeTopologyRevision({ generation: scope.generation, target: match.edge.entity });
                const topology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
                  index: context.binding.facility.entity.index, version: context.binding.facility.entity.version,
                  connector: context.binding.connector.node, target: match.edge.entity,
                  expectedWorldId: scope.worldId, expectedGeneration: scope.generation,
                  expectedTopologyRevision: topologyRevision,
                  admittedPrefab: directConnection.connection.prefab,
                  admittedStart: directConnection.connection.start, admittedEnd: directConnection.connection.end,
                  endpointTolerance: 0.25, envelope: scope.spatialEnvelope,
                }, signal));
                const targetNetwork = record(topology.targetNetwork);
                const targetRoadEntity = record(record(targetNetwork.target).entity);
                const targetBinding = resolveCurrentElectricityTarget({
                  semantic,
                  observation: {
                    binding: record(topology.binding) as ElectricityTargetTopologyObservation["binding"],
                    targetServiceEntryRoad: match.edge.entity,
                    reboundTargetRoad: match.edge.entity,
                    targetEndpoints: (Array.isArray(targetNetwork.targetEndpoints)
                      ? targetNetwork.targetEndpoints.map((candidate) => ({ ...record(candidate), road: targetRoadEntity ?? null }))
                      : []) as ElectricityTargetTopologyObservation["targetEndpoints"],
                  },
                  roadEndpoint: { role: match.endpointRole, position: match.position, nativeCurve: match.edge.nativeCurve },
                  worldEpoch: scope.generation, generation: scope.generation, topologyRevision,
                });
                if (targetBinding.status !== "PASS") {
                  directAccepted = false;
                  directFailure = { reason: targetBinding.reason, details: targetBinding.diagnostics as Record<string, unknown> | undefined };
                } else {
                  directTargetEndpoint = electricityTargetEndpoint(targetBinding.binding);
                }
              }
            }
            for (const [segmentIndex, action] of directCandidate.actions.entries()) {
              if (!directAccepted) break;
              await waitForNativeIdle(signal);
              let preview: Record<string, unknown>;
              try {
                try {
                  preview = await constructionPreflightPreview(action, signal,
                    segmentIndex === directCandidate.actions.length - 1 && directTargetEndpoint
                      ? { endEndpoint: directTargetEndpoint } : undefined);
                } catch (error) {
                  const failure = roadCandidatePreviewFailureVerdict(error);
                  if (failure.status === "INVALID") {
                    directAccepted = false;
                    directFailure = { reason: failure.reason, details: { segmentIndex, ...failure.details } };
                    break;
                  }
                  throw new RoadCandidatePreviewUnknownError(failure.reason);
                }
              } finally {
                await waitForNativeIdle(signal);
              }
              const verdict = rawRoadCandidatePreviewVerdict(preview);
              if (verdict.status === "UNKNOWN") throw new RoadCandidatePreviewUnknownError(verdict.reason);
              if (verdict.status === "INVALID") {
                directAccepted = false;
                directFailure = { reason: verdict.reason, details: { segmentIndex } };
                break;
              }
            }
            if (directAccepted) {
              return {
                connection: { ...directConnection, directCableNativePreflighted: true },
                diagnostics: {
                  roadCountFullScan: scan.roadGraph.edges.length,
                  roadCountBoundedDetail: scopedDetail.roadGraph.edges.length,
                  roadCountAfterAuthorityFilter: scopedDetail.roadGraph.edges.filter((edge) => Number.isFinite(edge.length) && edge.length > 0).length,
                  roadCountVisibleToPlanner: scopedDetail.roadGraph.edges.length,
                  roadCountVisibleToCandidateBuilder: scopedDetail.roadGraph.edges.length,
                  selectedContactRank: contactIndex + 1,
                  exhaustedContactCount: exhaustedContacts.length,
                  contactOptionsTried: contactIndex + 1,
                  selectedTopology: "direct-cable-after-service-road-exhaustion",
                  rejectedServiceRoadCandidateCount: rejected.length,
                },
              };
            }
            rejected.push({ candidateIndex: rejected.length, candidateId: `contact-${contactIndex + 1}:direct-cable`,
              reason: directFailure?.reason ?? "DIRECT_CABLE_NATIVE_PREVIEW_REJECTED",
              ...(directFailure?.details ? { details: directFailure.details } : {}) });
          }
          continue;
        }
        return {
          connection: {
            mode: "EXISTING_FACILITY_CONNECTION" as const,
            kind,
            facility: context.binding.facility,
            serviceRoads: selection.candidate,
            serviceRoadsNativePreflighted: true,
            authoritativeRoadRefs: [target.roadRef],
            connection: {
              prefab: kind === "electricity" ? "Low-voltage Ground Cable" : kind === "water" ? "Small Water Pipe" : "Small Sewage Pipe",
              start: context.binding.connector.worldPosition,
              end: target.point,
            },
          },
          diagnostics: {
            roadCountFullScan: scan.roadGraph.edges.length,
            roadCountBoundedDetail: scopedDetail.roadGraph.edges.length,
            roadCountAfterAuthorityFilter: scopedDetail.roadGraph.edges.filter((edge) => Number.isFinite(edge.length) && edge.length > 0).length,
            roadCountVisibleToPlanner: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToCandidateBuilder: scopedDetail.roadGraph.edges.length,
            selectedContactRank: contactIndex + 1,
            exhaustedContactCount: exhaustedContacts.length,
            contactOptionsTried: contactIndex + 1,
          },
        };
      }
      rememberPlanningEntry({ event: "UTILITY_SITE_CONTEXT_EXHAUSTED", siteFingerprint,
        sitePosition: context.binding.facility.position,
        reason: "ALL_BOUNDED_ROUTES_AND_CONTACTS_EXHAUSTED" });
      throw new NoFeasibleRoadCandidateError(rejected, {
        contactsTried: contacts.length,
        rejectedCandidateCount: rejected.length,
        allContactOptionsExhausted: true,
        facilitySiteExhausted: true,
        siteFingerprint,
        planningSignal: "NEXT_UTILITY_SITE_OR_TOPOLOGY",
      });
    }
    const selected = { valid: true, layout: { segments: [] } } as unknown as BootstrapSiteEvaluation;
    const plannedKind: "power" | "water" | "sewage" = kind === "electricity" ? "power" : kind;
    let plannedResult: BootstrapUtilityPlan;
    let waterCandidateDiagnostics: Record<string, unknown> = {};
    try {
      const planningOptions = {
        networkSource: "EXISTING_PLAYER_ROADS_ONLY" as const,
        utilityKind: plannedKind,
        // Placement is confined to the admitted reservation, so bound the terrain
        // the planner may pick a site from by that same reservation. The terrain
        // read is a square whose corners reach sqrt(2)*radius from the centre;
        // left unbounded the planner ranks those corners by their own groundwater
        // or wind evidence and proposes a facility admission must reject.
        siteEnvelope: { center: scope.spatialEnvelope.center, radius: scope.spatialEnvelope.radius },
        excludedSiteAreas: [] as Array<{ center: { x: number; z: number }; radius: number }>,
      };
      // A utility service-road child that exhausted Gate 1's bounded native
      // previews is a failed planner option, not a failed utility objective.
      // Reuse the authoritative terrain/site ranking, excluding the terminal
      // end of each durably failed child so its parent cannot mint the same
      // facility/contact course again after a restart.
      if (durability) {
        const durableProject = durability.projectState();
        if (durableProject.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
          durableProject.project.id === scope.projectId && durableProject.tranche.id === scope.trancheId) {
          const amendments = new Map(durability.utilityBudgetAmendments().map((entry) => [entry.amendmentId, entry]));
          const failedSiteAreas: Array<{ center: { x: number; z: number }; radius: number }> = [];
          const planningJournal = durableUtilityPlanningJournal(durableProject, kind);
          for (const entry of planningJournal) {
            const site = record(entry.sitePosition);
            if (entry.event !== "UTILITY_SITE_CONTEXT_EXHAUSTED" || !Number.isFinite(site.x) || !Number.isFinite(site.z)) continue;
            if (!failedSiteAreas.some((area) => Math.hypot(area.center.x - Number(site.x), area.center.z - Number(site.z)) < 1)) {
              failedSiteAreas.push({ center: { x: Number(site.x), z: Number(site.z) }, radius: 64 });
            }
          }
          for (const task of durableProject.tasks) {
            if (task.kind !== "ROAD_CONNECTION" || task.status !== "FAILED" ||
              task.trancheId !== scope.trancheId || !task.utilityRoadParentTaskId || !task.terminalOutcomeId) continue;
            const outcome = durableProject.journal.find((entry) => entry.id === task.terminalOutcomeId && entry.taskId === task.id);
            if (outcome?.execution !== "NOT_REQUIRED" || !outcome.reason.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE")) continue;
            const childIds = task.childOperationAmendmentIds ?? (task.childOperationAmendmentId ? [task.childOperationAmendmentId] : []);
            const child = [...childIds].reverse().map((id) => amendments.get(id)).find((entry) =>
              entry?.reason === "UTILITY_SERVICE_ROAD_CHILD_OPERATION" && entry.exactRoadInput);
            if (!child?.exactRoadInput) continue;
            const input = child.exactRoadInput;
            const start = { x: input.x1, z: input.z1 };
            const end = { x: input.x2, z: input.z2 };
            const distanceToContact = (point: { x: number; z: number }) =>
              Math.hypot(point.x - scope.targetServiceEntry.position.x, point.z - scope.targetServiceEntry.position.z);
            const terminal = distanceToContact(start) >= distanceToContact(end) ? start : end;
            if (!failedSiteAreas.some((area) => Math.hypot(area.center.x - terminal.x, area.center.z - terminal.z) < 1)) {
              failedSiteAreas.push({ center: terminal, radius: 64 });
            }
          }
          // A bounded list of previous site/contact failures guides ranking;
          // reaching eight historical entries is not proof that the admitted
          // reservation has no remaining site. Keep the latest exclusions and
          // let the native planner return the next candidate or a real handoff.
          if (failedSiteAreas.length > 0) planningOptions.excludedSiteAreas = failedSiteAreas.slice(-24);
        }
      }
      if (kind === "water" && scope.facilityPlacementOnly === true) {
        const stageA = await selectStageAWaterPlan({
          model, selectedSite: selected, areaDetail: scopedDetail, assets: scan.bootstrapAssets,
          options: { networkSource: planningOptions.networkSource, siteEnvelope: planningOptions.siteEnvelope,
            excludedSiteAreas: planningOptions.excludedSiteAreas },
          preflight: async (candidate) => {
            const preview = await constructionPreflightPreview({ type: "place_building", prefab: candidate.prefab,
              x: candidate.position.x, z: candidate.position.z, rotation: candidate.rotationCandidates[0] ?? 0 }, signal);
            return { valid: preview.valid === true, previewOnly: preview.previewOnly === true,
              ...(typeof preview.reason === "string" ? { reason: preview.reason } : {}) };
          },
        });
        plannedResult = { facilities: [stageA.facility], totalFacilityCost: stageA.facility.constructionCost,
          roadAuthorityDiagnostics: {
            roadCountBoundedDetail: scopedDetail.roadGraph.edges.length,
            roadCountAfterAuthorityFilter: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToPlanner: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToCandidateBuilder: scopedDetail.roadGraph.edges.length,
          } };
        waterCandidateDiagnostics = { waterStageACandidateCount: stageA.candidateCount,
          stageAValidCandidateCount: stageA.validCandidateCount,
          selectedStageACandidateRank: stageA.selectedRank, waterStageAFunnel: stageA.funnel,
          stageASearchScope: { ...scope.spatialEnvelope, source: "Gate1 project.utilityReservation" } };
      } else if (kind === "water") {
        const supported = await selectSupportedWaterPlan({
          model, selectedSite: selected, areaDetail: scopedDetail, assets: scan.bootstrapAssets,
          options: { networkSource: planningOptions.networkSource, siteEnvelope: planningOptions.siteEnvelope,
            excludedSiteAreas: planningOptions.excludedSiteAreas },
          preflight: async (candidate) => {
            const placement = await constructionPreflightPreview({ type: "place_building", prefab: candidate.prefab,
              x: candidate.position.x, z: candidate.position.z, rotation: candidate.rotationCandidates[0] ?? 0 }, signal);
            if (placement.valid !== true || placement.previewOnly !== true) {
              return { supported: false, reason: typeof placement.reason === "string" ? placement.reason : "FACILITY_PREFLIGHT_REJECTED" };
            }
            const candidatePaths = buildUtilityConnectionCandidates(candidate, {
              type: "waterPipe", node: { index: 0, version: 0 }, worldPosition: candidate.position,
              attached: true, capacity: { fresh: candidate.expectedCapacity },
            }).filter((path) => path.actions.length > 0);
            const reasons: string[] = [];
            for (const path of candidatePaths) {
              let supported = true;
              for (const action of path.actions) {
                const result = await constructionPreflightPreview(action, signal);
                if (result.valid !== true || result.previewOnly !== true) {
                  supported = false;
                  reasons.push(typeof result.reason === "string" ? result.reason : `${path.primitive}_PREFLIGHT_REJECTED`);
                  break;
                }
              }
              if (supported) return { supported: true };
            }
            return { supported: false, reason: reasons[0] ?? "NO_PREFLIGHTABLE_WATER_CONNECTION_PRIMITIVE" };
          },
        });
        plannedResult = { facilities: [supported.facility], totalFacilityCost: supported.facility.constructionCost,
          roadAuthorityDiagnostics: {
            roadCountBoundedDetail: scopedDetail.roadGraph.edges.length,
            roadCountAfterAuthorityFilter: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToPlanner: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToCandidateBuilder: scopedDetail.roadGraph.edges.length,
          } };
        waterCandidateDiagnostics = { waterCandidateCount: supported.candidateCount,
          supportedWaterCandidateCount: supported.supportedCandidateCount,
          selectedWaterCandidateRank: supported.selectedRank };
      } else {
        // A sewage plan is only a plan once its discharge has been judged
        // against the game's own water observation. Without that judgement the
        // planner still ranks legal shorelines, and the durable admission
        // refuses any of them as uncertified — so the observation is read here,
        // where the plan is made, rather than asserted afterwards.
        plannedResult = planBootstrapUtilities(model, selected, scopedDetail, scan.bootstrapAssets, {
          ...planningOptions,
          ...(plannedKind === "sewage"
            ? { sewageEnvironmentalSafety: {
                observation: await readWaterFlowObservation(signal),
                intakeCensus: await readWaterIntakeCensus(scan.bootstrapAssets, signal),
              } }
            : {}),
        });
      }
    } catch (error) {
      if (error instanceof UtilityPlanningError) {
        throw new UtilityPlanningError({ ...error.diagnostics, roadCountFullScan: scan.roadGraph.edges.length });
      }
      throw error;
    }
    const planned = plannedResult.facilities.find((candidate) => candidate.kind === plannedKind);
    if (!planned) throw new Error(`utility_facility_unavailable:${kind}`);
    return { facility: planned, diagnostics: {
      ...(plannedResult.roadAuthorityDiagnostics ?? {}),
      roadCountFullScan: scan.roadGraph.edges.length,
      ...(plannedResult.candidateFacilities ? { rankedFacilitySiteCandidates: plannedResult.candidateFacilities.map((candidate) => ({
        prefab: candidate.prefab, position: candidate.position, siteEvidence: candidate.siteEvidence,
      })) } : {}),
      ...waterCandidateDiagnostics,
    } };
  };
  /**
   * The current net edge of this scope's admitted course that meets the approved
   * contact, or null when the world does not prove exactly one.
   *
   * The listing is the game's own net listing, filtered by the course's own
   * prefab �?the same read the course matcher uses �?so a truncated or unreadable
   * listing is "cannot prove", never "no pipe".
   */
  const resolveAdmittedCourseTerminal = async (
    connection: { prefab: string; start: SpatialPoint2; end: SpatialPoint2 },
    scope: GreenfieldUtilityExecutionScope,
    signal?: AbortSignal,
  ): Promise<SpatialEntityRef | null> => {
    const listed = record(await callTool("cs2_list_roads", {
      query: connection.prefab,
      x: scope.spatialEnvelope.center.x,
      z: scope.spatialEnvelope.center.z,
      radius: Math.max(64, scope.spatialEnvelope.radius),
      limit: 500,
    }, signal));
    if (listed.truncated === true || listed.hasMore === true || listed.complete === false) return null;
    const rows = Array.isArray(listed.roads) ? listed.roads.map(record) : null;
    if (!rows) return null;
    const edges: AdmittedNetCourseEdge[] = [];
    for (const row of rows) {
      const entity = record(row.entity);
      const start = record(row.start);
      const end = record(row.end);
      if (!Number.isInteger(Number(entity.index)) || !Number.isInteger(Number(entity.version)) ||
        !Number.isFinite(Number(start.x)) || !Number.isFinite(Number(start.z)) ||
        !Number.isFinite(Number(end.x)) || !Number.isFinite(Number(end.z))) continue;
      edges.push({
        entity: { index: Number(entity.index), version: Number(entity.version) },
        prefab: String(row.prefab ?? ""),
        start: { x: Number(start.x), z: Number(start.z) },
        end: { x: Number(end.x), z: Number(end.z) },
      });
    }
    const reacquired = reacquireAdmittedCourseTerminal({
      edges,
      prefab: connection.prefab,
      approvedContact: scope.targetServiceEntry.position,
    });
    return reacquired.status === "YES" ? reacquired.edge.entity : null;
  };

  const readScopedUtilityEvidence = async (
    kind: UtilityRecoveryKind,
    scope: GreenfieldUtilityExecutionScope,
    signal?: AbortSignal,
  ): Promise<GreenfieldUtilityServiceEvidence> => {
    const capacity = await observeUtility(kind, signal);
    const observedGeneration = capacity.revision?.split(":", 1)[0] ?? "UNKNOWN";
    const state = scopedUtilityState(scope)?.utilities[kind];
    const topologyRevision = scope.topologyRevision;
    // Road-filtered spatial geometry is not electricity topology: connectivity and
    // reachability are only certifiable from the bounded Bridge topology
    // observation, which reports whether this facility's connector actually
    // reaches the intended target network. Without it the service can never
    // certify, because reachability would stay UNKNOWN forever.
    let targetNetworkReachable: true | false | "UNKNOWN" = "UNKNOWN";
    // `orphan` is a diagnostic, not a connectivity verdict: a building's utility
    // connector node is normally orphaned in the engine's own building graph. An
    // attached connector with an unread topology stays UNKNOWN.
    let networkConnected: true | false | "UNKNOWN" = state?.connector
      ? state.connector.attached === true ? "UNKNOWN" : false
      : "UNKNOWN";
    // The target the reachability question is asked about is NOT the same for
    // every family, and that is a domain fact rather than a preference.
    //
    // The Bridge resolves a target edge's flow family from the edge's OWN nodes,
    // and every road node in this engine carries an `ElectricityNodeConnection`.
    // Handing a water read the certified road therefore fills the target set with
    // ELECTRICITY flow nodes, which a water-pipe walk can never reach: the answer
    // is `false` by construction, however continuous the pipe is. A pipe slice's
    // service entry is its own admitted course �?the edge that meets the approved
    // contact �?and that edge carries the WATER_PIPE family, which is the family
    // the question was always about. Electricity is untouched: it keeps the
    // certified road target it has always used.
    const certifiedTarget = scope.certifiedRoadRefs.at(-1);
    let serviceEntryTarget: SpatialEntityRef | null = kind === "electricity" ? (certifiedTarget ?? null) : null;
    let approvedContactPosition: SpatialPoint2 | null = null;
    if (kind !== "electricity" && state?.plan?.connection) {
      approvedContactPosition = scope.targetServiceEntry.position;
      serviceEntryTarget = await resolveAdmittedCourseTerminal(state.plan.connection, scope, signal);
    }
    if (state?.facility && state.connector && state.plan?.connection && serviceEntryTarget) {
      try {
        const topology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
          index: state.facility.entity.index, version: state.facility.entity.version,
          connector: state.connector.node, target: serviceEntryTarget,
          expectedWorldId: scope.worldEpochId.split(":generation:", 1)[0], expectedGeneration: scope.generation,
          expectedTopologyRevision: bridgeTopologyRevision({ generation: scope.generation, target: serviceEntryTarget }),
          admittedPrefab: state.plan.connection.prefab,
          admittedStart: { x: state.plan.connection.start.x, z: state.plan.connection.start.z },
          admittedEnd: { x: state.plan.connection.end.x, z: state.plan.connection.end.z },
          endpointTolerance: 1.5, envelope: scope.spatialEnvelope,
        }, signal));
        const objective = matchConnectionObjective({ topology });
        networkConnected = objective.networkConnected;
        targetNetworkReachable = objective.targetNetworkReachable;
        const targetNetwork = record(topology.targetNetwork);
        const targetBinding = record(topology.binding);
        // A pipe family's reachability is only this course's entry when the
        // Bridge also confirms the target it walked to is the WATER_PIPE node at
        // the approved contact. Anything else �?an endpoint somewhere else, a
        // family that is not the pipe's �?leaves the claim unproven rather than
        // letting a walk that stopped at the wrong node read as reachable.
        if (approvedContactPosition && targetNetworkReachable === true &&
          !topologyReachedApprovedContact(topology, approvedContactPosition)) {
          targetNetworkReachable = "UNKNOWN";
        }
      } catch {
        // An unreadable topology observation is UNKNOWN, never an assumed effect.
        networkConnected = "UNKNOWN";
        targetNetworkReachable = "UNKNOWN";
      }
    }
    return {
      ...capacity,
      supplyExists: state?.facility !== null && state?.facility !== undefined,
      networkConnected,
      cityCapacityAvailable: capacity.status === "AVAILABLE" && capacity.capacity !== null &&
        capacity.consumption !== null && capacity.capacity > 0 && capacity.capacity >= capacity.consumption,
      targetNetworkReachable,
      facility: state?.facility ?? null,
      connector: state?.connector ?? null,
      targetRoad: scope.targetServiceEntry.road,
      evidenceGeneration: observedGeneration,
      topologyRevision,
    };
  };
  /**
   * Bind the facility a durable placement command has already been proven to
   * have created.
   *
   * The placement hold in `utility-placement-durability.ts` says PLACED exactly
   * when a durable placement operation for this scope reached OBSERVED_MATCH —
   * "claim it; never place a second one". Nothing claimed it, so a scope whose
   * workflow gave up during the uncertain window kept reporting its facility
   * missing while the building stood in the world.
   *
   * The claim is made from the command's OWN exact input: the prefab and the
   * coordinates it was authorized and submitted with. Those are matched against
   * the same authoritative building listing, with the same one-metre tolerance,
   * that the effect matcher used to reach OBSERVED_MATCH — so this adopts an
   * effect that is already proven, and can never adopt a building the command
   * did not create. A listing that no longer shows it claims nothing.
   */
  const claimJournalProvenPlacement = async (input: {
    scope: GreenfieldUtilityExecutionScope;
    kind: UtilityRecoveryKind;
    placementScopeId: string;
    signal?: AbortSignal;
  }): Promise<{ commandId: string; facility: UtilityPlacementReceipt } | null> => {
    const clearance = firstFacilityPlacementDurability(durability?.utilityPlacementOperations({
      projectId: input.scope.projectId, trancheId: input.scope.trancheId, reservationRef: input.scope.reservationRef,
      utilityKind: input.kind, placementScopeId: input.placementScopeId,
    }) ?? null);
    if (clearance.status !== "PLACED") return null;
    const command = commandJournal.get(clearance.commandId);
    if (!command) return null;
    const authorized = record(command.authorizedScope);
    const exactInput = typeof authorized.exactInput === "string" ? authorized.exactInput : null;
    if (!exactInput) return null;
    let actions: unknown;
    try { actions = JSON.parse(exactInput); } catch { return null; }
    if (!Array.isArray(actions) || actions.length !== 1) return null;
    const action = record(actions[0]);
    if (action.type !== "place_building" || typeof action.prefab !== "string" ||
      !Number.isFinite(Number(action.x)) || !Number.isFinite(Number(action.z))) return null;
    const listed = record(await callTool("cs2_list_buildings", { query: action.prefab, limit: 64 }, input.signal));
    const match = (Array.isArray(listed.buildings) ? listed.buildings : []).map(record).find((item) => {
      const position = record(item.position);
      return item.prefab === action.prefab && Number.isFinite(position.x) && Number.isFinite(position.z) &&
        Math.hypot(Number(position.x) - Number(action.x), Number(position.z) - Number(action.z)) <= 1;
    });
    if (!match) return null;
    const entity = record(match.entity);
    const position = record(match.position);
    if (!Number.isInteger(Number(entity.index)) || !Number.isInteger(Number(entity.version))) return null;
    return {
      commandId: clearance.commandId,
      facility: {
        entity: { index: Number(entity.index), version: Number(entity.version) },
        prefab: String(match.prefab),
        position: {
          x: Number(position.x), z: Number(position.z),
          ...(Number.isFinite(Number(position.y)) ? { y: Number(position.y) } : {}),
        },
      },
    };
  };

  /**
   * Record a journal-proven placement in the durable utility scope.
   *
   * Preparation asks the world whether a facility already exists, and the world
   * answer is bound to the durable facility receipt. A scope whose workflow gave
   * up during the uncertain window has no receipt, so every later preparation
   * reports "no facility" while the building stands — the placement hold then
   * refuses a second placement, and the scope can never leave that state.
   * Claiming closes it: the durable scope is brought up to the proof the journal
   * already carries, and ordinary planning continues from there.
   */
  const claimJournalProvenPlacementIntoDurableState = async (
    scope: GreenfieldUtilityExecutionScope,
    kind: UtilityRecoveryKind,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const durable = scopedUtilityState(scope);
    const current = durable?.utilities[kind];
    if (!durable || !current || current.facility !== null) return false;
    const claimed = await claimJournalProvenPlacement({
      scope, kind, placementScopeId: current.placementScopeId ?? scope.placementScopeId ?? "utility-placement:legacy", signal,
    });
    if (!claimed) return false;
    const next = structuredClone(durable);
    const utility = next.utilities[kind];
    utility.stage = "PLACED";
    utility.facility = claimed.facility;
    utility.facilityCommandId = claimed.commandId;
    utility.commandOutcome = "OBSERVED_MATCH";
    utility.lastRecoveryReason = null;
    saveScopedUtilityState(next);
    return true;
  };

  const executeScopedUtility = async (input: {
    scope: GreenfieldUtilityExecutionScope;
    state: DurableGreenfieldUtilityState["utilities"][UtilityRecoveryKind];
    plan: PlannedUtilityFacility;
    selectedPrimitive?: UtilityConnectionPrimitive;
    selectedCandidateId?: string;
    networkLinkRepair?: { actions: MayorAction[]; repairLineage: string; stepIndex: 1 | 2 };
    admissionOnly?: boolean;
    networkLinkAdmissionWitness?: { startEndpoint: unknown; endEndpoint: unknown };
    onAuthorized?: (binding: { commandId: string; actionFingerprint: string }) => Promise<void>;
  }, signal?: AbortSignal) => {
    const { scope } = input;
    const utilityPlacementScopeId = input.state.placementScopeId ?? scope.placementScopeId ?? "utility-placement:legacy";
    const kind = input.state.kind;
    // Claim a placement the durable journal already proves present.
    //
    // `firstFacilityPlacementDurability` reports PLACED the moment a placement
    // operation for this scope reaches OBSERVED_MATCH: the building stands in the
    // world and a second one must never be authorized. It also forbids placing
    // again — but the durable utility state can still say MISSING, because the
    // workflow that submitted the placement gave up while its native outcome was
    // uncertain, and nothing ever carries the journal's later proof back into the
    // scope. The scope then reports "facility not found" forever while the
    // facility stands exactly where its own plan put it, which is a permanent
    // stall no observation can clear.
    if (input.state.facility === null) {
      const claimed = await claimJournalProvenPlacement({
        scope, kind, placementScopeId: utilityPlacementScopeId, signal,
      });
      if (claimed) {
        input.state = {
          ...input.state, stage: "PLACED" as const, facility: claimed.facility,
          facilityCommandId: claimed.commandId, commandOutcome: "OBSERVED_MATCH" as const,
          lastRecoveryReason: null,
        };
      }
    }
    const selectedCandidate = input.selectedCandidateId
      ? input.state.candidateLedger.find((entry) => entry.candidateId === input.selectedCandidateId) ?? null
      : null;
    const facility = bindUtilityPlanToCurrentCandidate({
      plan: input.plan,
      facility: input.state.facility,
      connector: input.state.connector,
      candidate: input.networkLinkRepair ? null : selectedCandidate,
    });
    const preflightCosts = new Map<string, number>();
    const preflightNativeResults = new Map<string, unknown>();
    let authorizedSpend = input.state.authorizedSpend;
    let facilityCommandId: string | null = input.state.facilityCommandId;
    const networkCommandIds = [...input.state.networkCommandIds];
    let facilityConstructionAttempted = false;
    let networkSubmissionAttempted = false;
    const resolvedCableEndpoints = new Map<string, {
      startEndpoint?: BoundUtilityEndpoint;
      endEndpoint?: BoundUtilityEndpoint | ReturnType<typeof electricityTargetEndpoint>;
    }>();
    const commandTelemetry = (commandIds: string[]) => {
      const records = commandIds.map((commandId) => commandJournal.get(commandId)).filter(Boolean).reverse();
      const completion = records.find((value) => value?.nativeCompletionEvidence !== undefined);
      const topology = records.find((value) => value?.topologyEvidence !== undefined);
      return {
        ...(completion?.nativeCompletionEvidence !== undefined ? { nativeCompletionEvidence: structuredClone(completion.nativeCompletionEvidence) } : {}),
        ...(completion?.nativeCompletionTelemetryTrace !== undefined ? { nativeCompletionTelemetryTrace: structuredClone(completion.nativeCompletionTelemetryTrace) } : {}),
        ...(topology?.topologyEvidence !== undefined ? { topologyEvidence: structuredClone(topology.topologyEvidence) } : {}),
      };
    };
    const otherAuthorizedSpend = Object.values(scopedUtilityState(scope)?.utilities ?? {})
      .filter((candidate) => candidate.kind !== kind)
      .reduce((sum, candidate) => sum + candidate.authorizedSpend, 0);
    // The city's spare capacity is not this scope's service (measured live
    // 2026-10-02: a district on its own 66-street component read city headroom
    // and was answered `no_action_needed` while it had no reachable facility of
    // its own). The read is memoised because it is the same world for every kind
    // in one recovery attempt, and it is read at most once per attempt.
    let reachRead: { streets: ServiceReachStreet[]; facilities: ServiceReachFacility[] } | null = null;
    const readServiceReach = async () => {
      if (reachRead) return reachRead;
      // Neither read may fail the recovery: a scope-proving read that could
      // block a placement the city read already authorized would be a new way
      // for an unrelated read to stop the product. Anything unread answers "no
      // evidence", which `scopeNeedsService` already treats as "leave it alone".
      let edges: ReturnType<typeof parseSpatialBootstrapScan>["roadGraph"]["edges"] = [];
      try {
        edges = parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal)).roadGraph.edges;
      } catch { edges = []; }
      let buildings: Array<Record<string, unknown>> = [];
      try {
        const listed = record(await callTool("cs2_list_buildings", { limit: 200 }, signal));
        buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : [];
      } catch { buildings = []; }
      reachRead = {
        streets: edges.map((edge) => ({
          ref: edge.entity, startNode: edge.startNode, endNode: edge.endNode, start: edge.start, end: edge.end,
        })),
        // Which net a placed building serves is only in its prefab name: the
        // listing carries entity/prefab/isSubBuilding/position and nothing else.
        facilities: buildings.flatMap((row) => {
          const prefab = String(row.prefab ?? "");
          const net = UTILITY_FACILITY_PREFAB_NETS.find((entry) => prefab.includes(entry.contains));
          const position = record(row.position);
          const x = Number(position.x); const z = Number(position.z);
          return net && Number.isFinite(x) && Number.isFinite(z)
            ? [{ kind: net.net, position: { x, z } }] : [];
        }),
      };
      return reachRead;
    };
    const asCapacity = async (kind: UtilityRecoveryKind): Promise<UtilityCapacityReadback> => {
      const observed = await observeUtility(kind, signal);
      const { streets, facilities } = await readServiceReach();
      return {
        revision: observed.revision,
        capacity: observed.capacity,
        consumption: observed.consumption,
        fulfilledConsumption: observed.fulfilledConsumption,
        issueActive: scopeNeedsService({
          cityIssueActive: observed.status === "UNKNOWN" || observed.issueActive,
          kind: UTILITY_NET_KIND_FOR_RECOVERY_KIND[kind],
          // The scope's own street is the one its facility has to reach: the
          // certified road this tranche delivered, or the service entry it was
          // admitted against.
          districtStreetRefs: scope.certifiedRoadRefs.length > 0
            ? scope.certifiedRoadRefs
            : [scope.targetServiceEntry.road],
          streets, facilities,
        }),
      };
    };
    const findExistingFacility = async (): Promise<UtilityPlacementReceipt | undefined> => {
      const rebound = await rebindFacilityAndConnector(facility, signal);
      return rebound.status === "MATCH" ? rebound.facility : undefined;
    };
    // A repair run's course is the ledger entry the bootstrap selected, taken as
    // it stands: those exact actions are the approved identity the write-ahead
    // contract binds the command to, so re-deriving them here would submit a
    // course the durable record does not describe. A repair run that cannot find
    // its candidate has lost that authority, so it fails closed before any native
    // call rather than inventing one.
    let accessRoad: MayorAction[] | undefined;
    if (input.selectedPrimitive === "facility-access-road") {
      const candidate = input.selectedCandidateId
        ? input.state.candidateLedger.find((entry) => entry.candidateId === input.selectedCandidateId)
        : undefined;
      if (!candidate) throw new Error("UTILITY_ACCESS_ROAD_CANDIDATE_MISSING");
      accessRoad = candidate.exactActions;
    }
    let recovery: Awaited<ReturnType<typeof executeSharedUtilityRecovery>>;
    try {
      recovery = await executeSharedUtilityRecovery({
      kind,
      actionKind: input.networkLinkRepair ? "NETWORK_LINK_REPAIR" : "FACILITY_REPAIR",
      expectedRevision: null,
      treasury: scope.treasury,
      runwayMonths: 0,
      connectionOnly: !!input.state.facility,
      placementOnly: scope.facilityPlacementOnly === true || scope.deferConnectionUntilPlaced === true,
      selectedPrimitive: input.selectedPrimitive,
      networkLinkRepair: input.networkLinkRepair,
      admissionOnly: input.admissionOnly,
      accessRoad,
      signal: signal ?? new AbortController().signal,
      ports: {
        // The recovery boundary asks for a GREENFIELD_PLACEMENT plan while nothing
        // is placed, and for an EXISTING_FACILITY_CONNECTION plan once a facility
        // exists. The scoped planner already owns both: it returns the facility
        // for a placement and the connection course (facility connector -> the
        // nearest certified road point) for a connection. Returning only the
        // facility here made every connection-only run fail before any native
        // submission, so the workflow could never reach the cable it prepared.
        plan: async (kind, context) => {
          try {
            const currentPlanMatchesBinding = context?.mode === "EXISTING_FACILITY_CONNECTION" &&
              input.state.connectionCandidateContextFingerprint !== undefined &&
              input.state.facility?.entity.index === context.binding.facility.entity.index &&
              input.state.facility?.entity.version === context.binding.facility.entity.version &&
              input.state.connector?.node.index === context.binding.connector.node.index &&
              input.state.connector?.node.version === context.binding.connector.node.version &&
              input.plan.position.x === context.binding.facility.position.x &&
              input.plan.position.z === context.binding.facility.position.z &&
              utilityPlanStartMatchesCurrentBinding(input.plan, context.binding.connector);
            if (currentPlanMatchesBinding) {
              return { status: "candidate", facility: input.plan,
                connection: currentConnectionPlanFromFacility(kind, scope, context!.binding, input.plan),
                reason: "authoritative_connection_context_already_replanned" };
            }
            const currentPlacementScopeId = scopedUtilityState(scope)?.utilities[kind]?.placementScopeId ??
              scope.placementScopeId ?? "utility-placement:legacy";
            const placementOperations = durability?.utilityPlacementOperations({
              projectId: scope.projectId, trancheId: scope.trancheId, reservationRef: scope.reservationRef,
              utilityKind: kind, placementScopeId: currentPlacementScopeId,
            });
            const placementUnattempted = firstFacilityPlacementDurability(placementOperations).status === "NONE";
            const persistedPlacement = persistedUtilityPlacementPlanForScope({
              utility: scopedUtilityState(scope)?.utilities[kind],
              placementScopeId: currentPlacementScopeId,
              placementUnattempted,
              planningContext: context,
            });
            const planned = persistedPlacement
              ? { facility: persistedPlacement, connection: persistedPlacement.connection,
                  diagnostics: { persistedPlacementScopeId: scope.placementScopeId, persistedSelectedSite: true } }
              : await planScopedUtility(kind, scope, signal, context);
            const facilityPlan = context?.mode === "EXISTING_FACILITY_CONNECTION"
              ? currentConnectionFacilityPlan(kind, scope, context.binding, planned.connection as UtilityConnectionPlan)
              : planned.facility;
            const connectionPlan = context?.mode === "EXISTING_FACILITY_CONNECTION"
              ? planned.connection as UtilityConnectionPlan
              : planned.connection;
            return { status: "candidate", facility: facilityPlan, connection: connectionPlan,
              reason: "v2_greenfield_bounded_plan", diagnostics: planned.diagnostics };
          } catch (error) {
            if (error instanceof UtilityPlanningError) return { status: "blocked", reason: error.code };
            const failure = record(error);
            if (error instanceof NoSupportedWaterTopologyError || failure.code === "NO_SUPPORTED_WATER_TOPOLOGY" || failure.name === "NoSupportedWaterTopologyError") {
              return { status: "blocked", reason: "NO_SUPPORTED_WATER_TOPOLOGY",
                diagnostics: { waterStageACandidateCount: Number(failure.candidateCount), stageAValidCandidateCount: Number(failure.supportedCandidateCount),
                  waterStageAFunnel: failure.funnel ?? null,
                  stageASearchScope: { ...scope.spatialEnvelope, source: "Gate1 project.utilityReservation" },
                  roadCoupledFilters: ["existing permanent road reach <= 320m", "facility frontage minimum from network"] } };
            }
            return { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
          }
        },
        preflight: async (action: MayorAction) => {
          try {
            const inScope = (x: number, z: number) => Math.hypot(x - scope.spatialEnvelope.center.x, z - scope.spatialEnvelope.center.z) <= scope.spatialEnvelope.radius;
            if (action.type === "place_building" && !inScope(action.x, action.z)) return { valid: false, reason: "outside_utility_scope" };
            // Facility repair retains its facility-centered fence. Network-link
            // repairs are scoped by the validated exact action and typed,
            // current-generation endpoints below, not by the facility circle.
            if (action.type === "build_road" && !input.networkLinkRepair &&
              (!inScope(action.x1, action.z1) || !inScope(action.x2, action.z2))) {
              return { valid: false, reason: "outside_utility_scope" };
            }
            let endEndpoint: ReturnType<typeof electricityTargetEndpoint> | undefined;
            let startEndpoint: BoundUtilityEndpoint | undefined;
            let targetBindingDiagnostics: unknown;
            if (action.type === "build_road" && action.prefab === ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) {
              if (action.utilityEndpoints) {
                const bindings = action.utilityEndpoints;
                if (bindings.start.role !== "START" || bindings.end.role !== "END" ||
                  bindings.start.utility !== "ELECTRICITY" || bindings.end.utility !== "ELECTRICITY" ||
                  bindings.start.prefab !== action.prefab || bindings.end.prefab !== action.prefab) {
                  return { valid: false, reason: "UTILITY_NETWORK_LINK_ENDPOINT_SEMANTICS_MISMATCH", rejectionKind: "PRECONDITION" as const };
                }
                try {
                  startEndpoint = await rebindUtilityNetworkEndpoint(bindings.start, scope, signal, !!input.networkLinkRepair);
                  endEndpoint = await rebindUtilityNetworkEndpoint(bindings.end, scope, signal, !!input.networkLinkRepair);
                } catch (error) {
                  return { valid: false, reason: error instanceof Error ? error.message : "UTILITY_ENDPOINT_REBIND_FAILED", rejectionKind: "PRECONDITION" as const };
                }
                if (input.networkLinkAdmissionWitness) {
                  const identity = (endpoint: unknown) => {
                    const value = record(endpoint); const entity = record(value.entity);
                    return { kind: value.kind, index: entity.index ?? null, version: entity.version ?? null };
                  };
                  const fresh = { startEndpoint: identity(startEndpoint), endEndpoint: identity(endEndpoint) };
                  const admitted = { startEndpoint: identity(input.networkLinkAdmissionWitness.startEndpoint),
                    endEndpoint: identity(input.networkLinkAdmissionWitness.endEndpoint) };
                  if (JSON.stringify(fresh) !== JSON.stringify(admitted)) {
                    return { valid: false, reason: "NETWORK_LINK_REPAIR_ENDPOINT_BINDING_CHANGED_AFTER_ADMISSION", rejectionKind: "PRECONDITION" as const };
                  }
                }
                resolvedCableEndpoints.set(JSON.stringify(action), { startEndpoint, endEndpoint });
                targetBindingDiagnostics = {
                  start: { bindingRule: bindings.start.bindingRule, topologyRole: bindings.start.topologyRole, rebound: startEndpoint },
                  end: { bindingRule: bindings.end.bindingRule, topologyRole: bindings.end.topologyRole, rebound: endEndpoint },
                };
              } else if (!scope.targetSemantics || !input.state.facility || !input.state.connector) {
                return { valid: false, reason: "UTILITY_ELECTRIC_TARGET_BINDING_MISSING", rejectionKind: "PRECONDITION" as const };
              } else {
              const targetRoadDetail = parseV2SpatialSiteDetail(await callTool("cs2_spatial", {
                mode: "detail", x: scope.targetServiceEntry.position.x, z: scope.targetServiceEntry.position.z,
                radius: Math.max(64, scope.spatialEnvelope.radius), resolution: 64,
              }, signal));
              const reacquired = reacquirePreflightTargetRoad({
                edges: targetRoadDetail.roadGraph.edges,
                semantic: scope.targetSemantics,
                tolerance: 0.25,
                // The contact node alone is not unique once the game splits the
                // delivered course across it. The durable scope's committed far
                // endpoint is the second key, and it is the same one the
                // certified-delivery reader already reacquires by.
                ...(scope.targetServiceEntry.farEnd ? { farEndpoint: scope.targetServiceEntry.farEnd } : {}),
              });
              if (reacquired.status !== "YES") {
                return { valid: false, reason: `UTILITY_TARGET_ROAD_REBIND_${reacquired.status}`, rejectionKind: "PRECONDITION" as const };
              }
              const targetRoad = reacquired.road;
              const roadEndpoint = scope.targetSemantics.targetRoad.endpointRole === "start" ? targetRoad.start : targetRoad.end;
              const observed = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
                index: input.state.facility.entity.index, version: input.state.facility.entity.version,
                connector: input.state.connector.node, target: targetRoad.entity,
                expectedWorldId: scope.worldId, expectedGeneration: scope.generation,
                expectedTopologyRevision: bridgeTopologyRevision({ generation: scope.generation, target: targetRoad.entity }),
                admittedPrefab: action.prefab, admittedStart: { x: action.x1, z: action.z1 }, admittedEnd: { x: action.x2, z: action.z2 },
                endpointTolerance: 0.25, envelope: scope.spatialEnvelope,
              }, signal));
              const observedTargetNetwork = record(observed.targetNetwork);
              const observedTargetRoad = record(observedTargetNetwork.target).entity;
              const resolved = resolveCurrentElectricityTarget({
                semantic: scope.targetSemantics,
                observation: {
                  binding: record(observed.binding) as ElectricityTargetTopologyObservation["binding"],
                  targetServiceEntryRoad: targetRoad.entity,
                  reboundTargetRoad: targetRoad.entity,
                  targetEndpoints: (Array.isArray(observedTargetNetwork.targetEndpoints)
                    ? observedTargetNetwork.targetEndpoints.map((candidate) => ({
                      ...record(candidate),
                      road: observedTargetRoad ?? null,
                    })) : []) as ElectricityTargetTopologyObservation["targetEndpoints"],
                },
                roadEndpoint: {
                  role: scope.targetSemantics.targetRoad.endpointRole,
                  position: roadEndpoint,
                  nativeCurve: targetRoad.nativeCurve,
                },
                // Bridge endpoint validation compares this field with its bare
                // current WorldGeneration. Keep the composite worldEpochId
                // exclusively in durable world/continuation identity.
                worldEpoch: scope.generation, generation: scope.generation,
                // The Bridge compares this against its own target-entity revision.
                topologyRevision: bridgeTopologyRevision({ generation: scope.generation, target: targetRoad.entity }),
              });
              targetBindingDiagnostics = resolved.status === "PASS" ? resolved.binding.diagnostics : resolved.diagnostics;
              if (resolved.status !== "PASS") return { valid: false, reason: resolved.reason, rejectionKind: "PRECONDITION" as const, diagnostics: { targetBinding: resolved.diagnostics } };
              endEndpoint = electricityTargetEndpoint(resolved.binding);
                resolvedCableEndpoints.set(JSON.stringify(action), { endEndpoint });
              }
            }
            const rawResult = await constructionPreflightPreview(action, signal, { startEndpoint, endEndpoint });
            const result = targetBindingDiagnostics
              ? {
                ...rawResult,
                diagnostics: {
                  ...record(rawResult.diagnostics),
                  targetBinding: targetBindingDiagnostics,
                },
              }
              : rawResult;
            const valid = result.valid === true && result.previewOnly === true;
            if (valid && endEndpoint) {
              const realization = record(record(result.diagnostics).realization);
              const realized = record(realization.realizedEndEntity);
              const freeEndpoint = endEndpoint.kind === "NEW_FREE_ENDPOINT";
              if (!freeEndpoint && (Number(realized.index) !== endEndpoint.entity?.index || Number(realized.version) !== endEndpoint.entity?.version)) {
                return { valid: false, reason: "UTILITY_TARGET_ENDPOINT_REALIZATION_MISMATCH", native: result };
              }
            }
            if (valid && startEndpoint?.kind === "EXISTING_NET_NODE") {
              const realization = record(record(result.diagnostics).realization);
              const realized = record(realization.realizedStartEntity);
              if (Number(realized.index) !== startEndpoint.entity?.index || Number(realized.version) !== startEndpoint.entity?.version) {
                return { valid: false, reason: "UTILITY_SOURCE_ENDPOINT_REALIZATION_MISMATCH", native: result };
              }
            }
            if (valid) {
              const quoted = readNativeUtilityQuote(
                result,
                action.type === "place_building" ? facility.constructionCost : Number.NaN,
              );
              if (!Number.isFinite(quoted) || otherAuthorizedSpend + authorizedSpend + quoted > scope.maximumSpend ||
                otherAuthorizedSpend + authorizedSpend + quoted > scope.treasury - scope.treasurySafetyReserve) {
                return { valid: false, reason: "utility_finance_preflight_rejected", native: result };
              }
              preflightCosts.set(JSON.stringify(action), quoted);
              preflightNativeResults.set(JSON.stringify(action), result);
            }
            return valid ? { valid: true, native: result } : {
              valid: false,
              reason: typeof result.reason === "string" ? result.reason : "native_preflight_rejected",
              native: result,
            };
          } catch (error) {
            // A thrown preflight call produced no verdict on the course batch.
            return { valid: false, reason: error instanceof Error ? error.message : "native_preflight_failed", rejectionKind: "PRECONDITION" as const };
          }
        },
        execute: async (actions: MayorAction[]) => {
          if (!durability) throw new Error("V2 durability is required for Utility execution");
          await waitForNativeIdle(signal);
          const exactInput = JSON.stringify(actions);
          const candidate = input.selectedCandidateId
            ? input.state.candidateLedger.find((entry) => entry.candidateId === input.selectedCandidateId) ?? null
            : input.state.candidateLedger.find((entry) => entry.actionFingerprint === exactInput) ?? null;
          // Candidate identity is an immutable write contract. Validate the
          // prospective command before any command id/journal side effect.
          const networkBatch = actions.length > 0 && actions.every((action) => action.type === "build_road");
          // The immutable write contract, spelled out rather than folded into one
          // expression: which candidate is being submitted, that it is unspent,
          // that it names exactly these actions, and �?where the kind HAS an
          // endpoint contract �?that the endpoint was resolved for it.
          //
          // That last clause hangs off `scope.targetSemantics`, which only an
          // electricity scope carries, because `resolvedCableEndpoints` is filled
          // only on the branch that resolves it. Demanding a resolved endpoint
          // from a kind that has none required evidence that can never exist, and
          // refused every water connection at the write-ahead boundary.
          const identityHolds =
            candidate !== null &&
            (!input.selectedPrimitive || candidate.kind === input.selectedPrimitive) &&
            (candidate.ledgerState === "NOT_ATTEMPTED" || (!!input.networkLinkRepair && candidate.ledgerState === "AUTHORIZED")) &&
            candidate.actionFingerprint === exactInput &&
            JSON.stringify(candidate.exactActions) === exactInput &&
            (!input.networkLinkRepair || (actions.length === 1 && actions[0]?.type === "build_road" &&
              candidate.networkLinkRepair?.kind === "NETWORK_LINK_REPAIR" &&
              candidate.networkLinkRepair.repairLineage === input.networkLinkRepair.repairLineage &&
              candidate.networkLinkRepair.stepIndex === input.networkLinkRepair.stepIndex &&
              candidate.networkLinkRepair.exactQuote === preflightCosts.get(JSON.stringify(actions[0])) &&
              candidate.commandId !== null &&
              candidate.networkLinkRepair.actionIdentity === utilityActionIdentity({
                utility: "ELECTRICITY", prefab: actions[0].prefab,
                geometry: roadCourseGeometry(actions[0]) as unknown as Record<string, number>,
                start: actions[0].utilityEndpoints!.start, end: actions[0].utilityEndpoints!.end,
                quote: candidate.networkLinkRepair.exactQuote, actionCount: 1,
                repairLineage: input.networkLinkRepair.repairLineage,
                stepId: `step-${input.networkLinkRepair.stepIndex}`,
              }))) &&
            (!(input.selectedPrimitive === "direct-cable" && scope.targetSemantics && !input.networkLinkRepair) ||
              (candidate.targetSemanticFingerprint === JSON.stringify(scope.targetSemantics) &&
                resolvedCableEndpoints.has(JSON.stringify(actions.at(-1)))));
          if (networkBatch && !identityHolds) {
            throw new Error("UTILITY_PRE_COMMAND_EXACT_IDENTITY_MISMATCH");
          }
          await options.beforeUtilityNativeExecute?.({
            scope: input.scope,
            utilityKind: kind,
            candidateId: candidate?.candidateId ?? null,
            candidateKind: candidate?.kind ?? null,
            actionFingerprint: exactInput,
            exactActions: structuredClone(actions),
            prefab: actions.length === 1 && actions[0].type === "build_road" ? actions[0].prefab : null,
          });
          const batchSpend = actions.reduce((sum, action) => sum + (preflightCosts.get(JSON.stringify(action)) ?? Number.POSITIVE_INFINITY), 0);
          if (candidate && candidate.repair === FACILITY_ACCESS_ROAD_REPAIR) {
            if (actions.length !== 1 || actions[0]?.type !== "build_road" || actions[0].prefab !== FACILITY_ACCESS_ROAD_PREFAB) {
              throw new Error("FACILITY_REPAIR_MULTI_ACTION_NOT_CERTIFIED");
            }
            if (candidate.repairAttemptIndex !== 3 || !candidate.authorizationAmendmentId || !durability) {
              throw new Error("FACILITY_ACCESS_ROAD_REPAIR_LINEAGE_OR_AUTHORIZATION_MISSING");
            }
            const amendments = durability.utilityBudgetAmendments().filter((entry) =>
              entry.projectId === scope.projectId && entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON &&
              entry.status === "ACTIVE");
            const authorization = amendments.length === 1 ? amendments[0] : null;
            const action = actions[0];
            // The whole course, control point included. A candidate whose curve
            // is flattened to its chord here is previewed, priced and authorized as
            // a different native course.
            const geometry = roadCourseGeometry(action);
            await waitForNativeIdle(signal);
            const preview = record(await callTool("cs2_spatial", {
              mode: "preflight", kind: "net", ...geometry,
            }, signal));
            await waitForNativeIdle(signal);
            const quote = nativeRoadQuoteFromPreview(preview, geometry, (options.now ?? (() => new Date()))());
            const actionFingerprint = JSON.stringify(actions);
            const active = durability.snapshot().active;
            if (!authorization || authorization.amendmentId !== candidate.authorizationAmendmentId ||
              authorization.courseFingerprint !== actionFingerprint || authorization.planRevision !== candidate.approvedPlanRevision ||
              authorization.repairLineage === undefined || authorization.purpose !== "Pump native road attachment repair" ||
              authorization.roadPrefab !== FACILITY_ACCESS_ROAD_PREFAB || authorization.segmentQuotes?.length !== 1 ||
              authorization.segmentQuotes[0] !== quote.signedAmount || authorization.nativeQuote !== quote.signedAmount ||
              quote.signedAmount !== batchSpend || authorization.authorizationWorldId !== scope.worldId ||
              authorization.authorizationGeneration !== scope.generation || authorization.authorizationCheckpointId !== active?.loadedCheckpointId ||
              authorization.executionUseLimit !== 1 || authorization.executionUseStatus !== "UNUSED" || !active) {
              throw new Error("AUTHORIZED_ACCESS_ROAD_REPAIR_FINAL_BINDING_MISMATCH");
            }
            const roadInputFingerprint = stableRoadInput(geometry);
            const result = await road.execute({
              proposal: {
                identity: {
                  proposalId: quote.proposalId, actionFamily: "ROAD", exactInput: roadInputFingerprint,
                  runtimeEpoch: quote.runtimeEpoch, frame: quote.frame, validationState: "VALID",
                },
                quoteId: quote.quoteId, fingerprint: roadInputFingerprint, input: geometry,
                owner: { ownerType: "PROJECT", ownerId: scope.projectId },
              },
              quote,
              authorizedMaxSpend: authorization.nativeQuote,
              treasurySafetyReserve: scope.treasurySafetyReserve,
              facilityAccessRoadRepair: {
                amendmentId: authorization.amendmentId,
                repairLineage: authorization.repairLineage,
                planRevision: authorization.planRevision,
                actionFingerprint,
                actionCount: 1,
                purpose: "Pump native road attachment repair",
                prefab: FACILITY_ACCESS_ROAD_PREFAB,
                expectedJournalPosition: durability.snapshot().journalPosition,
                expectedWorldId: scope.worldId,
                expectedCheckpointId: active.loadedCheckpointId,
                expectedGeneration: scope.generation,
              },
            }, signal);
            candidate.commandId = result.command.commandId;
            candidate.ledgerState = result.bridgeCalled
              ? (result.command.status === "OBSERVED_MATCH" ? "OBSERVED_MATCH" :
                result.command.status === "NATIVE_COMPLETED" || result.command.status === "COMMIT_ACK" ? "UNKNOWN" : "FAILED_DETERMINISTIC")
              : "FAILED_DETERMINISTIC";
            candidate.primitiveEffect = candidate.ledgerState === "OBSERVED_MATCH" ? "OBSERVED_MATCH" :
              candidate.ledgerState === "UNKNOWN" ? "UNKNOWN" : "NOT_OBSERVED";
            if (!networkCommandIds.includes(result.command.commandId)) networkCommandIds.push(result.command.commandId);
            networkSubmissionAttempted = result.bridgeCalled;
            if (result.admission.decision === "AUTHORIZED" && result.bridgeCalled) authorizedSpend += quote.signedAmount;
            const submitted = result.bridgeCalled && result.admission.decision === "AUTHORIZED";
            return {
              ok: submitted && result.command.status !== "REJECTED" && result.command.status !== "FAILED_BEFORE_SUBMIT",
              requested: 1,
              executed: submitted ? 1 : 0,
              ...(!submitted ? { failedAt: 0 } : {}),
              results: [{
                index: 0, type: "build_road" as const, ok: submitted,
                summary: `single-action ROAD Kernel command ${result.command.status}; world effect requires authoritative readback`,
                ...(!submitted ? { error: result.command.failureOrUnknownReason ?? result.admission.reason } : {}),
                v2Road: {
                  executionCommandId: result.command.commandId,
                  bridgeCommandId: result.command.bridgeCommandId ?? null,
                  proposalId: quote.proposalId, quoteId: quote.quoteId, fingerprint: roadInputFingerprint,
                  ...(result.receipt ? { financeReceipt: result.receipt } : {}),
                },
                ...(result.nativeCompletion ? { nativeCompletionEvidence: result.nativeCompletion } : {}),
              }],
            } as MayorBatchResult;
          }
          if (requiresSequentialRoadExecution(actions)) {
            throw new Error("UTILITY_MULTI_ROAD_BATCH_REQUIRES_SEQUENTIAL_WORLD_PREFLIGHT");
          }
          if (!Number.isFinite(batchSpend) || otherAuthorizedSpend + authorizedSpend + batchSpend > scope.maximumSpend ||
            otherAuthorizedSpend + authorizedSpend + batchSpend > scope.treasury - scope.treasurySafetyReserve) {
            throw new Error("UTILITY_ADMISSION_FINANCE_LIMIT_EXCEEDED");
          }
          const at = (options.now ?? (() => new Date()))().toISOString();
          const alreadyObserved = commandJournal.list().find((candidate) =>
            candidate.actionFamily === "UTILITY" && candidate.status === "OBSERVED_MATCH" &&
            candidate.authorizedScope.actionFamily === "UTILITY" && candidate.authorizedScope.projectId === scope.projectId &&
            candidate.authorizedScope.trancheId === scope.trancheId && candidate.authorizedScope.utilityKind === kind &&
            candidate.authorizedScope.exactInput === exactInput);
          if (alreadyObserved) return { ok: true, executed: 0, failedAt: null, results: [] } as unknown as MayorBatchResult;
           const commandId = candidate?.networkLinkRepair ? candidate.commandId! : (options.createId ?? (() => crypto.randomUUID()))();
           const facilityBatch = actions.some((action) => action.type === "place_building");
           if (facilityBatch) facilityCommandId = commandId;
           if (networkBatch && !networkCommandIds.includes(commandId)) networkCommandIds.push(commandId);
          const command: V2CommandRecord = {
            schemaVersion: "ai-mayor-v2-command/1", commandId, actionFamily: "UTILITY",
            actionType: actions.map((action) => action.type).join("+"),
            ...(candidate?.networkLinkRepair && actions.length === 1 && actions[0]?.type === "build_road" && actions[0].utilityEndpoints
              ? { networkLinkRepairIdentity: {
                  repairLineage: candidate.networkLinkRepair.repairLineage,
                  stepIndex: candidate.networkLinkRepair.stepIndex,
                  authorizationId: candidate.networkLinkRepair.authorizationId,
                  quote: candidate.networkLinkRepair.exactQuote,
                  actionIdentity: candidate.networkLinkRepair.actionIdentity,
                  startEndpoint: structuredClone(actions[0].utilityEndpoints.start),
                  endEndpoint: structuredClone(actions[0].utilityEndpoints.end),
                } } : {}),
            authorizedScope: {
              owner: { ownerType: "TRANCHE", ownerId: scope.trancheId }, actionFamily: "UTILITY", utilityKind: kind,
              projectId: scope.projectId, trancheId: scope.trancheId, reservationRef: scope.reservationRef,
              placementScopeId: utilityPlacementScopeId,
              worldEpochId: scope.worldEpochId, generation: scope.generation, topologyRevision: scope.topologyRevision,
              executionMechanismRevision: scope.executionMechanismRevision,
              certifiedRoadRefs: scope.certifiedRoadRefs, exactInput, spatialEnvelope: scope.spatialEnvelope,
              budget: { authorizedMaxSpend: scope.maximumSpend, treasurySafetyReserve: scope.treasurySafetyReserve, currency: "GAME_MONEY" },
            },
            createdAt: at, submittedAt: null, nativeResultSummary: null, status: "CREATED",
            statusHistory: [{ status: "CREATED", at }], reconciliationStatus: "NOT_STARTED",
            observationEvidence: [], failureOrUnknownReason: null, effectAbsenceProven: false,
          };
           // First-facility write-ahead idempotency, checked at the native
           // submission boundary and before this command gets its own durable
           // identity. The existing `assertMutationAllowed` compares
           // idempotency keys, which embed the load-scoped generation and so
           // cannot see a placement recorded before a restart; this asks the
           // durable journal for the scope's placement operations directly and
           // refuses while any of them may already have mutated the world.
           if (facilityBatch) {
             const placement = firstFacilityPlacementDurability(
             durability.utilityPlacementOperations({
                 projectId: scope.projectId,
                 trancheId: scope.trancheId,
                 reservationRef: scope.reservationRef,
                 utilityKind: kind,
                 placementScopeId: utilityPlacementScopeId,
               }),
             );
             if (!firstFacilityPlacementPermitted(placement)) {
               throw new Error(`UTILITY_FACILITY_PLACEMENT_UNRESOLVED:${placement.status}`);
             }
           }
           durability.assertMutationAllowed(commandIdempotencyKey(command));
           commandJournal.create(command);
           commandJournal.update(commandId, (current) => ({ ...current, status: "AUTHORIZED", statusHistory: [...current.statusHistory, { status: "AUTHORIZED", at }] }));
           await input.onAuthorized?.({ commandId, actionFingerprint: exactInput });
           commandJournal.update(commandId, (current) => ({ ...current, status: "SUBMITTED", submittedAt: at, statusHistory: [...current.statusHistory, { status: "SUBMITTED", at }] }));
           if (facilityBatch) facilityConstructionAttempted = true;
           if (networkBatch) networkSubmissionAttempted = true;
          try {
            const nativeActions = actions.map((action) => {
              if (action.type !== "build_road" || action.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) return action;
              const endpoints = resolvedCableEndpoints.get(JSON.stringify(action));
              if (!endpoints) return action;
              const { utilityEndpoints: _semanticOnly, ...course } = action;
              return { ...course, ...endpoints } as MayorAction;
            });
            // The apply may have taken effect even if its reply or native
            // completion evidence is uncertain. Refresh is allowed before the
            // command is reconciled.
            if (networkBatch || facilityBatch) worldState.markUtilityDirty();
            const result = await callTool("cs2_mayor_execute_actions", { actions: nativeActions }, signal) as MayorBatchResult;
            await waitForNativeIdle(signal);
            const firstResult = record(result.results?.[0]);
            const actionEvidence = nativeBatchActionEvidence({
              actions: nativeActions,
              quotes: nativeActions.map((action) => preflightCosts.get(JSON.stringify(action))),
              batch: result,
              operationId: commandId,
            });
            const bridgeCommandId = record(firstResult.v2Road).bridgeCommandId;
            const rawCompletion = record(firstResult.nativeCompletionEvidence);
            const correlatedBridgeCommandId = typeof bridgeCommandId === "string"
              ? bridgeCommandId
              : typeof rawCompletion.commandId === "string" ? rawCompletion.commandId : null;
            commandJournal.update(commandId, (current) => ({ ...current,
              ...withUtilityNativeCompletionEvidence(current, result, correlatedBridgeCommandId),
              ...((firstResult.rejectionDiagnostics !== undefined || firstResult.bridgeHttpErrorDiagnostics !== undefined || firstResult.bridgeCommandId !== undefined || firstResult.mcpBridgeFailureDiagnostics !== undefined)
                ? { evidence: {
                    ...(firstResult.rejectionDiagnostics !== undefined ? { rejectionDiagnostics: firstResult.rejectionDiagnostics } : {}),
                    ...(firstResult.bridgeHttpErrorDiagnostics !== undefined ? { bridgeHttpErrorDiagnostics: firstResult.bridgeHttpErrorDiagnostics } : {}),
                    ...(typeof firstResult.bridgeCommandId === "string" ? { bridgeCommandId: firstResult.bridgeCommandId } : {}),
                    ...(firstResult.mcpBridgeFailureDiagnostics !== undefined ? { mcpBridgeFailureDiagnostics: firstResult.mcpBridgeFailureDiagnostics } : {}),
                    nativeBatchSemantics: actionEvidence.batchSemantics,
                    nativeActionResults: actionEvidence.actions,
                  } }
                : { evidence: { nativeBatchSemantics: actionEvidence.batchSemantics, nativeActionResults: actionEvidence.actions } }),
              status: result.ok ? "NATIVE_COMPLETED" : "REJECTED",
              nativeResultSummary: `utility batch bridgeOk=${result.ok} attempted=${result.executed}/${result.requested}; worldEffects=UNOBSERVED`,
              failureOrUnknownReason: result.ok ? null : "native utility batch rejected",
              statusHistory: [...current.statusHistory, { status: result.ok ? "NATIVE_COMPLETED" : "REJECTED", at }],
            }));
            if (networkBatch && kind === "electricity" && input.state.facility && input.state.connector) {
              const topologyCaptures: unknown[] = [];
              for (const action of actions) {
                if (action.type !== "build_road" || action.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) continue;
                try {
                  const rawTopology = await callTool("cs2_utility_connectors", {
                    index: input.state.facility.entity.index,
                    version: input.state.facility.entity.version,
                    connector: input.state.connector.node,
                    target: scope.targetServiceEntry.road,
                    expectedWorldId: scope.worldId,
                    expectedGeneration: scope.generation,
                    expectedTopologyRevision: bridgeTopologyRevision({ generation: scope.generation, target: scope.targetServiceEntry.road }),
                    admittedPrefab: action.prefab,
                    admittedStart: { x: action.x1, z: action.z1 },
                    admittedEnd: { x: action.x2, z: action.z2 },
                    endpointTolerance: 0.25,
                    envelope: scope.spatialEnvelope,
                  }, signal);
                  topologyCaptures.push(buildUtilityTopologyEvidence({
                    topology: rawTopology,
                    commandId,
                    bridgeCommandId: correlatedBridgeCommandId,
                    action,
                    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
                  }));
                } catch (error) {
                  topologyCaptures.push({
                    schemaVersion: "ai-mayor-v2-utility-topology-evidence/1",
                    commandId,
                    ...(typeof correlatedBridgeCommandId === "string" ? { bridgeCommandId: correlatedBridgeCommandId } : {}),
                    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
                    action: cloneUnknown(action),
                    status: "UNAVAILABLE",
                    reason: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              commandJournal.update(commandId, (current) => ({ ...current,
                topologyEvidence: {
                  schemaVersion: "ai-mayor-v2-utility-topology-evidence-batch/1",
                  commandId,
                  ...(typeof correlatedBridgeCommandId === "string" ? { bridgeCommandId: correlatedBridgeCommandId } : {}),
                  captures: topologyCaptures,
                },
              }));
            }
            if (result.ok) authorizedSpend += batchSpend;
            return result;
          } catch (error) {
            commandJournal.update(commandId, (current) => ({ ...current, status: "UNKNOWN_TRANSPORT",
              failureOrUnknownReason: error instanceof Error ? error.message : String(error),
              statusHistory: [...current.statusHistory, { status: "UNKNOWN_TRANSPORT", at }],
            }));
            throw error;
          }
        },
        readConnectors: async (entity) => {
          const value = record(await callTool("cs2_utility_connectors", entity as unknown as Record<string, unknown>, signal));
          return (Array.isArray(value.connectors) ? value.connectors : []).slice(0, 8).map((item) => {
            const connector = record(item);
            const node = record(connector.node);
            const position = record(connector.worldPosition);
            const capacity = record(connector.capacity);
            const connectedEdges = (Array.isArray(connector.connectedEdges) ? connector.connectedEdges : []).map((raw) => {
              const edge = record(raw);
              const entity = record(edge.entity);
              const owner = record(edge.owner);
              return {
                entity: { index: Number(entity.index), version: Number(entity.version) },
                owner: Number.isInteger(owner.index) && Number.isInteger(owner.version)
                  ? { index: Number(owner.index), version: Number(owner.version) } : null,
                prefab: typeof edge.prefab === "string" ? edge.prefab : null,
              };
            }).filter((edge) => Number.isInteger(edge.entity.index) && Number.isInteger(edge.entity.version));
            return {
              type: connector.type === "electricity" ? ("electricity" as const) : ("waterPipe" as const),
              node: { index: Number(node.index), version: Number(node.version) },
              worldPosition: { x: Number(position.x), z: Number(position.z) },
              attached: connector.attached === true,
              orphan: connector.orphan === true,
              capacity: {
                ...(typeof capacity.electricity === "number" ? { electricity: capacity.electricity } : {}),
                ...(typeof capacity.fresh === "number" ? { fresh: capacity.fresh } : {}),
                ...(typeof capacity.sewage === "number" ? { sewage: capacity.sewage } : {}),
              },
              connectedEdges,
            };
          });
        },
        readCapacity: asCapacity,
        settle: async () => undefined,
        currentRevision: async () => (await observeUtility(kind, signal)).revision,
        findExistingFacility,
        findCurrentUtilityBinding: async (kind) => observeCurrentUtilityBinding(kind, signal),
      },
      });
    } catch (error) {
      if (error instanceof PhaseAAcceptanceStopError) throw error;
      const uncertain = [...networkCommandIds, ...(facilityCommandId ? [facilityCommandId] : [])].some((commandId) => {
        const status = commandJournal.get(commandId)?.status;
        return status === "SUBMITTED" || status === "NATIVE_COMPLETED" || status === "NATIVE_COMPLETION_UNKNOWN" ||
          status === "UNKNOWN_TIMEOUT" || status === "UNKNOWN_TRANSPORT";
      });
      if (!uncertain) throw error;
      return {
        state: { ...input.state, facilityCommandId, networkCommandIds, commandOutcome: "UNKNOWN" as const },
        facilityConstructionAttempted,
        networkSubmissionAttempted,
        failedBeforeNetworkSubmission: false,
        executionSucceeded: false,
        reason: "UTILITY_NATIVE_OUTCOME_UNCERTAIN",
        facilityCommandId,
        networkCommandIds,
        nativeTelemetry: commandTelemetry(networkCommandIds),
        authorizedSpend,
      };
    }
    const networkRecords = networkCommandIds.map((commandId) => commandJournal.get(commandId));
    const missingNetworkCommand = networkRecords.some((command) => !command);
    const currentScopeNetworkStatuses = networkRecords.filter((command): command is V2CommandRecord => !!command &&
      utilityCommandMatchesPlacementScope({ command, kind, scope, currentPlacementScopeId: input.state.placementScopeId,
        currentCandidates: input.state.candidateLedger })).map((command) => command.status);
    const allNetworkStatuses = networkRecords.map((command) => command?.status);
    const networkUncertain = missingNetworkCommand || allNetworkStatuses.some((status) => status === "SUBMITTED" || status === "NATIVE_COMPLETED" ||
      status === "NATIVE_COMPLETION_UNKNOWN" || status === "UNKNOWN_TIMEOUT" || status === "UNKNOWN_TRANSPORT");
    const networkObserved = currentScopeNetworkStatuses.length > 0 && currentScopeNetworkStatuses.every((status) => status === "OBSERVED_MATCH");
    const failedBeforeNetworkSubmission = !networkSubmissionAttempted && networkCommandIds.length === 0 && !recovery.ok;
    return {
      state: {
        ...input.state,
        stage: recovery.connector?.attached ? "CONNECTED" as const : recovery.facility ? "PLACED" as const : "BLOCKED" as const,
        facility: recovery.facility ?? input.state.facility,
        connector: recovery.connector ?? input.state.connector,
        facilityCommandId,
        networkCommandIds,
        commandOutcome: networkUncertain ? "SUBMITTED" as const
          : networkObserved ? "OBSERVED_MATCH" as const : "OBSERVED_MISMATCH" as const,
      },
      facilityConstructionAttempted,
      networkSubmissionAttempted,
      failedBeforeNetworkSubmission,
      executionSucceeded: recovery.ok,
      reason: recovery.reason,
      connectionDiagnostics: recovery.connectionDiagnostics,
      preflightDiagnostics: recovery.preflightDiagnostics,
      nativeTelemetry: commandTelemetry(networkCommandIds),
      facilityCommandId,
      networkCommandIds,
      ...(recovery.selectedPrimitive ? { selectedConnectionPrimitive: recovery.selectedPrimitive } : {}),
      ...(input.admissionOnly && input.networkLinkRepair
        ? { admittedQuote: preflightCosts.get(JSON.stringify(input.networkLinkRepair.actions[0])) ?? null,
            admittedEndpoints: resolvedCableEndpoints.get(JSON.stringify(input.networkLinkRepair.actions[0])) ?? null }
        : {}),
      authorizedSpend,
    };
  };
  /**
   * The world reads the access-road repair verdict is decided on: the
   * facility's own road frontage, the engine's own `No Road Access`
   * warning, and whether the city already has the power this facility will
   * draw. All three come from the authoritative read, none from the durable
   * snapshot �?a snapshot cannot say whether the frontage is there NOW.
   */
  const facilityAccessRoadEvidencePort: AccessRoadRepairPorts["facilityAccessRoadEvidence"] = async ({
    kind, scope: currentScope, signal,
  }) => {
  const facility = scopedUtilityState(currentScope)?.utilities[kind]?.facility;
  if (!facility) return null;
  try {
    const access = record(await callTool("cs2_building_access", {
      index: facility.entity.index, version: facility.entity.version,
    }, signal));
    const attachment = record(access.roadAttachment);
    const notifications = record(await callTool("cs2_notifications", { limit: 200 }, signal));
    const total = Number(notifications.total);
    const items = Array.isArray(notifications.notifications)
      ? notifications.notifications.map(record) : null;
    // A warning list the Bridge truncated is not evidence that this
    // facility's warning is absent, so an incomplete read answers UNKNOWN
    // for every clause rather than answering "no warning".
    if (!items || !Number.isFinite(total) || items.length < total) {
      return { roadAttachment: "UNKNOWN", noRoadAccessWarning: "UNKNOWN", cityElectricityCapacitySufficient: "UNKNOWN" };
    }
    const forThisFacility = items.filter((item) => Number(record(item.target).index) === facility.entity.index);
    const capacity = await observeUtility("electricity", signal);
    const cityCapacityGenerationMatches = typeof capacity.revision === "string" &&
      capacity.revision.startsWith(`${currentScope.generation}:`);
    const cityCapacityVerdict = capacity.status === "AVAILABLE" && cityCapacityGenerationMatches
      ? cityElectricityCapacityVerdict({
          freshness: capacity.freshness ?? "UNKNOWN",
          production: capacity.capacity,
          consumption: capacity.consumption,
        })
      : "UNKNOWN";
    return {
      roadAttachment: attachment.roadEdge === null || attachment.roadExists === false
        ? "NONE" as const
        : attachment.roadEdge ? "ATTACHED" as const : "UNKNOWN" as const,
      noRoadAccessWarning: forThisFacility.some((item) => String(item.type) === "No Road Access"),
      cityElectricityCapacitySufficient: cityCapacityVerdict,
    };
  } catch {
    return null;
  }
  };
  const planFacilityAccessRoadPort: AccessRoadRepairPorts["planFacilityAccessRoad"] = async ({
    kind, scope: currentScope, objective, admittedCourse, plan: planned, signal,
  }) => {
  try {
    const lastServiceRoad = (planned.serviceRoads ?? []).at(-1);
    if (!lastServiceRoad) return { status: "REFUSED" as const, reasons: ["ACCESS_ROAD_OBJECTIVE_MISSING"] };
    // The footprint bound is the plan's own, not a constant: the service
    // point the planner chose is the closest a road was ever meant to come
    // to this building, and the native dry-run is the hard gate beyond it.
    const halfExtent = Math.hypot(
      lastServiceRoad.end.x - planned.position.x, lastServiceRoad.end.z - planned.position.z,
    );
    const candidates = facilityAccessRoadCourseCandidates({
      objective, admittedCourse,
      facility: { position: { ...planned.position }, halfExtent },
      facilityServicePoint: { ...lastServiceRoad.end },
      envelope: currentScope.spatialEnvelope,
      prefab: FACILITY_ACCESS_ROAD_PREFAB,
      maximumCandidates: 8,
    });
    if (candidates.length === 0) return { status: "REFUSED" as const, reasons: ["ACCESS_ROAD_NO_CANDIDATE"] };
    const detail = parseV2SpatialSiteDetail(await callTool("cs2_spatial", {
      mode: "detail",
      x: currentScope.spatialEnvelope.center.x, z: currentScope.spatialEnvelope.center.z,
      radius: Math.max(64, currentScope.spatialEnvelope.radius), resolution: 128,
    }, signal));
    const selected = await selectFacilityAccessRoadCourse({
      candidates,
      facilityServicePoint: lastServiceRoad.end,
      worldEdges: detail.roadGraph.edges,
      preflight: async (candidate) => {
        const action = candidate.actions[0];
        if (!action || action.type !== "build_road") {
          return { accepted: false, quote: null, reason: "ACCESS_ROAD_ACTION_UNSUPPORTED" };
        }
        await waitForNativeIdle(signal);
        const raw = record(await callTool("cs2_spatial", {
          mode: "preflight", kind: "net", ...roadCourseGeometry(action),
        }, signal));
        await waitForNativeIdle(signal);
        const accepted = raw.valid === true && raw.previewOnly === true;
        return {
          accepted,
          quote: accepted ? readNativeUtilityQuote(raw, Number.NaN) : null,
          ...(accepted ? {} : { reason: typeof raw.error === "string" ? raw.error : "NATIVE_PREFLIGHT_REJECTED" }),
        };
      },
    });
    if (selected.status !== "SELECTED") return { status: "REFUSED" as const, reasons: selected.reasons };
    if (!Number.isFinite(selected.quote)) return { status: "REFUSED" as const, reasons: ["ACCESS_ROAD_QUOTE_UNKNOWN"] };
    return {
      status: "PLANNED" as const,
      actions: selected.candidate.actions,
      quote: selected.quote,
      offsetFromAdmittedCourse: selected.candidate.offsetFromAdmittedCourse,
    };
  } catch (error) {
    return { status: "UNKNOWN" as const, reason: error instanceof Error ? error.message : String(error) };
  }
  };
  const greenfieldUtilityBootstrap = {
    planAlternateFacilitySite: async (input: UtilityPreparationInput, signal?: AbortSignal): Promise<PlannedUtilityFacility> => {
      const planningScope = utilityPlanningScope(input);
      const planned = await planScopedUtility(input.kind, planningScope, signal);
      if (!planned.facility) throw new Error(`UTILITY_ALTERNATE_SITE_UNAVAILABLE:${input.kind}`);
      return planned.facility;
    },
    prepare: async (input: UtilityPreparationInput, signal?: AbortSignal): Promise<UtilityPreparationResult> => {
      // Activation authoritatively reconciles submitted durable commands. Run
      // it before planning or native preview so unresolved exact effects never
      // enter candidate preparation again.
      await requireActivatedDurableWorld(signal);
      // The plan is scoped by the same road authority the placement was authorized
      // against, so the site search cannot leave the admitted reservation.
      const planningScope: GreenfieldUtilityExecutionScope = utilityPlanningScope(input);
      // Adopt a facility this scope's own placement command is already proven to
      // have created, before any planning can conclude there is none and before
      // the placement hold refuses a second placement forever.
      await claimJournalProvenPlacementIntoDurableState(planningScope, input.kind, signal);
      const readConnectors = async (facility: { index: number; version: number }) => {
        const payload = record(await callTool("cs2_utility_connectors", { index: facility.index, version: facility.version }, signal));
        const rawConnectors = Array.isArray(payload.connectors) ? payload.connectors : [];
        return rawConnectors.map((raw) => {
          const connector = record(raw); const node = record(connector.node); const position = record(connector.worldPosition);
          return {
            type: connector.type === "electricity" ? "electricity" as const : "waterPipe" as const,
            node: { index: Number(node.index), version: Number(node.version) },
            worldPosition: { x: Number(position.x), z: Number(position.z) }, attached: connector.attached === true,
            orphan: connector.orphan === true, capacity: record(connector.capacity) as UtilityConnectorReadback["capacity"], connectedEdges: [],
          };
        });
      };
      const prepared = await prepareScopedUtilityExecution(input, {
        plan: async (kind, context) => {
          try {
            // Alternate sites are a durable planner decision. Re-running the
            // broad site ranker during the same greenfield placement admission
            // can select a different/ambiguous existing facility, disconnecting
            // placement authority from the successor scope. Reuse that exact
            // persisted site while this scope is still unplaced; connection
            // planning remains world-current and is performed after placement.
            const durableUtility = scopedUtilityState(planningScope)?.utilities[kind];
            const persistedPlacement = persistedUtilityPlacementPlanForScope({
              utility: durableUtility,
              placementScopeId: input.placementScopeId ?? input.facilityPlacementAuthorization?.placementScopeId,
              connectionOnly: input.connectionOnly,
              placementUnattempted: input.firstFacilityPlacement?.status === "NONE",
              planningContext: context,
            });
            const planned = persistedPlacement
              ? { facility: structuredClone(persistedPlacement), connection: structuredClone(persistedPlacement.connection),
                  diagnostics: { persistedPlacementScopeId: durableUtility?.placementScopeId,
                  persistedSelectedSite: true } }
              : await planScopedUtility(kind, planningScope, signal, context);
            return { status: "candidate", facility: planned.facility, connection: planned.connection, reason: "current_world_production_plan", diagnostics: planned.diagnostics };
          }
          catch (error) {
            if (error instanceof NoFeasibleRoadCandidateError) {
              return { status: "blocked", reason: error.code, diagnostics: {
                roadCandidateRejections: error.rejections,
                ...error.diagnostics,
              } };
            }
            if (error instanceof UtilityPlanningError) {
              return { status: "blocked", reason: error.code, diagnostics: {
                roadCountFullScan: error.diagnostics.roadCountFullScan,
                roadCountBoundedDetail: error.diagnostics.roadCountBoundedDetail,
                roadCountAfterAuthorityFilter: error.diagnostics.roadCountAfterAuthorityFilter,
                roadCountVisibleToPlanner: error.diagnostics.roadCountVisibleToPlanner,
                roadCountVisibleToCandidateBuilder: error.diagnostics.roadCountVisibleToCandidateBuilder,
              } };
            }
            const failure = record(error);
            if (error instanceof NoSupportedWaterTopologyError || failure.code === "NO_SUPPORTED_WATER_TOPOLOGY" || failure.name === "NoSupportedWaterTopologyError") {
              return { status: "blocked", reason: "NO_SUPPORTED_WATER_TOPOLOGY",
                diagnostics: { waterStageACandidateCount: Number(failure.candidateCount), stageAValidCandidateCount: Number(failure.supportedCandidateCount),
                  waterStageAFunnel: failure.funnel ?? null,
                  stageASearchScope: { ...planningScope.spatialEnvelope, source: "Gate1 project.utilityReservation" },
                  roadCoupledFilters: ["existing permanent road reach <= 320m", "facility frontage minimum from network"] } };
            }
            return { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
          }
        },
        preflight: async (action) => {
          try {
            const payload = record(await callTool("cs2_spatial", { mode: "preflight", kind: "net", ...action }, signal));
            return { valid: payload.valid !== false, native: payload };
          } catch (error) { return preserveUtilityPreflightError(error); }
        },
        readConnectors,
        // The durable journal owns every connection course that already reached
        // the world. Handing those exact actions to preparation keeps it from
        // re-validating a course the game now answers with a duplicate-course
        // rejection. A FAILED command proves no course was built, so it is
        // excluded and its candidate is validated natively as before.
        durablySubmittedConnectionCourses: async () => {
          if (!durability) return [];
          const operations = durability.utilityNetworkOperations({
            projectId: input.projectId,
            trancheId: input.trancheId,
            reservationRef: input.reservationRef,
            utilityKind: input.kind,
            placementScopeId: input.placementScopeId ?? input.facilityPlacementAuthorization?.placementScopeId ?? "utility-placement:legacy",
          }) ?? [];
          return operations
            .filter((operation) => !operation.failedBeforeSubmit &&
              !["CREATED", "AUTHORIZED", "REJECTED"].includes(operation.status) &&
              operation.exactInput.length > 0)
            .map((operation) => operation.exactInput);
        },
        readCapacity: async (kind) => {
          const observed = await observeUtility(kind, signal);
          return { revision: observed.revision, capacity: observed.capacity, consumption: observed.consumption,
            fulfilledConsumption: observed.fulfilledConsumption, issueActive: observed.issueActive };
        },
        currentRevision: async () => (await observeUtility(input.kind, signal)).revision,
        findCurrentUtilityBinding: async (kind) => observeCurrentUtilityBinding(kind, signal),
        findExistingFacility: async (kind, planned) => {
          const rebound = await rebindFacilityAndConnector(planned, signal, kind);
          return rebound.status === "MATCH" ? rebound.facility : undefined;
        },
        roadEdges: async ({ center, radius, signal: roadSignal }) => {
          const detail = parseV2SpatialSiteDetail(await callTool("cs2_spatial", { mode: "detail", x: center.x, z: center.z,
            radius: Math.max(64, radius), resolution: 128 }, roadSignal ?? signal));
          return detail.roadGraph.edges;
        },
      });
      if (prepared.status === "READY" && durability) {
        const durableProject = durability.projectState();
        if (durableProject.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
          durableProject.project.id === input.projectId && durableProject.tranche.id === input.trancheId &&
          durableProject.tranche.reservationRef === input.reservationRef) {
          const storedPlan = durableProject.tranche.utilityExecution?.utilities[input.kind]?.plan;
          const preparedPlan = "kind" in prepared.plan && "position" in prepared.plan ? prepared.plan : null;
          const utilityPlan = preparedPlan ?? storedPlan;
          const preparedConnectionPlan = "mode" in prepared.plan && prepared.plan.mode === "EXISTING_FACILITY_CONNECTION"
            ? prepared.plan : undefined;
          // An explicitly selected direct-cable topology has no service-road
          // child to materialize. Falling back to the facility's older stored
          // road plan here revives an exhausted child and can send K05 into
          // planner-input replacement for the wrong objective.
          // Once the facility has been authoritatively rebound, its observed
          // position can differ slightly from the planned float coordinates.
          // The selected candidate has already been generated and natively
          // checked against that current binding. Materialize those exact
          // actions as durable children; a pre-placement stored plan here can
          // differ by a few float ulps and must not become the child write
          // contract.
          const selectedServiceRoadActions = prepared.status === "READY" && prepared.selected?.primitive === "service-road"
            ? prepared.selected.actions
            : null;
          const selectedDirectCable = prepared.status === "READY" && prepared.selected?.primitive === "direct-cable";
          const serviceRoads = selectedServiceRoadActions
            ? selectedServiceRoadActions.map((action, index) => {
              if (action.type !== "build_road" || ![action.x1, action.z1, action.x2, action.z2].every(Number.isFinite))
                throw new Error("UTILITY_SERVICE_ROAD_CANDIDATE_ACTION_INVALID");
                return { id: `selected-service-road-${index + 1}`, role: "side" as const,
                  start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 } };
              })
            : selectedDirectCable
              ? []
              : preparedConnectionPlan
              ? preparedConnectionPlan.serviceRoads ?? []
              : input.connectionOnly
                ? []
                : utilityPlan?.serviceRoads ?? [];
          if (serviceRoads.length > 4) throw new Error("UTILITY_SERVICE_ROAD_ROUTE_EXCEEDS_FOUR_SEGMENTS");
          if (serviceRoads.length > 0 && planningScope.deferConnectionUntilPlaced !== true) {
            const verifiedActivation = await requireActivatedDurableWorld(signal);
            // The branch this exact child is planned for, proven from the branch's
            // own rollback boundary rather than from the save the world was loaded
            // from: a city started fresh has no loaded checkpoint and its baseline
            // boundary is nonetheless certified and durable. Every other term the
            // binding used is kept — the checkpoint record must exist and be
            // durable at the activation's journal cut, and the world and
            // generation must still be this store's activated ones.
            const branch = durability.currentBranchCheckpoint();
            if (!branch) throw new Error("UTILITY_SERVICE_ROAD_CHILD_CURRENT_BRANCH_NOT_PROVEN");
            const planRevision = deriveCurrentBranchProjectReplanIdentity({
              worldId: branch.worldId,
              checkpointId: branch.checkpointId,
              journalCut: branch.journalCut,
            }).replanId;
            const exactRoadInput = roadCourseGeometry(plannedRoadSegmentToMayorAction(serviceRoads[0]));
            const roadTaskId = durableProject.tranche.currentTaskIds?.ROAD_CONNECTION;
            let roadTask = roadTaskId
              ? durableProject.tasks.find((task) => task.id === roadTaskId && task.trancheId === input.trancheId)
              : durableProject.tasks.find((task) => task.trancheId === input.trancheId && task.kind === "ROAD_CONNECTION");
            if (!roadTask) throw new Error("UTILITY_SERVICE_ROAD_CHILD_GATE1_TASK_NOT_FOUND");
            if (["BLOCKED", "FAILED"].includes(roadTask.status) && roadTask.utilityRoadParentTaskId) {
              const parent = durableProject.tasks.find((task) => task.id === roadTask!.utilityRoadParentTaskId &&
                task.kind === "ROAD_CONNECTION" && task.trancheId === input.trancheId &&
                task.status === "SUCCEEDED" && task.terminalOutcomeId !== null);
              const rejection = roadTask.terminalOutcomeId
                ? durableProject.journal.find((entry) => entry.id === roadTask!.terminalOutcomeId && entry.taskId === roadTask!.id)
                : undefined;
              const amendment = roadTask.childOperationAmendmentId
                ? durability.utilityBudgetAmendments().find((entry) => entry.amendmentId === roadTask!.childOperationAmendmentId)
                : undefined;
              if (parent && rejection?.execution === "NOT_REQUIRED" && rejection.commandId === null &&
                rejection.reason.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE") && amendment?.reason === "UTILITY_SERVICE_ROAD_CHILD_OPERATION" &&
                amendment.status === "ACTIVE" && amendment.executionUseStatus === "UNUSED") {
                roadTask.status = "FAILED";
                durableProject.tranche.currentTaskIds = { ...durableProject.tranche.currentTaskIds, ROAD_CONNECTION: parent.id };
                durability.saveProjectState(durableProject);
                roadTask = parent;
              }
            }
            // A native INVALID preview is a planner rejection, not a world
            // mutation. Retire that exact unused child and let K05 submit its
            // next bounded route candidate from the last delivered Road parent.
            if (roadTask.utilityRoadParentTaskId && roadTask.status === "PENDING" && !roadTask.activeCommandId) {
              const rejection = [...durableProject.journal].reverse().find((entry) => entry.taskId === roadTask!.id &&
                entry.execution === "NOT_REQUIRED" && entry.commandId === null && entry.reason?.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE"));
              const amendment = roadTask.childOperationAmendmentId
                ? durability.utilityBudgetAmendments().find((entry) => entry.amendmentId === roadTask!.childOperationAmendmentId)
                : undefined;
              if (rejection && amendment?.reason === "UTILITY_SERVICE_ROAD_CHILD_OPERATION" &&
                amendment.status === "ACTIVE" && amendment.executionUseStatus === "UNUSED") {
                roadTask.status = "FAILED";
                roadTask.terminalOutcomeId = rejection.id;
                const parent = durableProject.tasks.find((task) => task.id === roadTask!.utilityRoadParentTaskId &&
                  task.kind === "ROAD_CONNECTION" && task.status === "SUCCEEDED" && task.terminalOutcomeId !== null);
                if (!parent) throw new Error("UTILITY_SERVICE_ROAD_REPLAN_PARENT_NOT_CERTIFIED");
                durableProject.tranche.currentTaskIds = { ...durableProject.tranche.currentTaskIds, ROAD_CONNECTION: parent.id };
                durability.saveProjectState(durableProject);
                roadTask = parent;
              }
            }
            if (["BLOCKED", "FAILED"].includes(roadTask.status) && roadTask.terminalOutcomeId !== null) {
              const rebound = await rebindFacilityAndConnector(storedPlan ?? utilityPlan, signal, input.kind);
              if (rebound.status !== "MATCH") throw new Error(`PLANNER_INPUT_REPLACEMENT_TARGET_REBIND_${rebound.status}:${rebound.reason}`);
              const scan = parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal));
              if (scan.roadGraph.truncated) throw new Error("PLANNER_INPUT_REPLACEMENT_ROAD_EFFECT_READBACK_INCOMPLETE");
              const proposedStart = { x: exactRoadInput.x1, z: exactRoadInput.z1 };
              const proposedEnd = { x: exactRoadInput.x2, z: exactRoadInput.z2 };
              const dx = proposedEnd.x - proposedStart.x; const dz = proposedEnd.z - proposedStart.z;
              const lengthSquared = dx * dx + dz * dz;
              const project = (point: { x: number; z: number }) => lengthSquared > 0
                ? ((point.x - proposedStart.x) * dx + (point.z - proposedStart.z) * dz) / lengthSquared : 0;
              const pointSegmentDistance = (point: { x: number; z: number }, edge: { start: { x: number; z: number }; end: { x: number; z: number } }) => {
                const ex = edge.end.x - edge.start.x; const ez = edge.end.z - edge.start.z;
                const denominator = ex * ex + ez * ez;
                const t = denominator > 0 ? Math.max(0, Math.min(1, ((point.x - edge.start.x) * ex + (point.z - edge.start.z) * ez) / denominator)) : 0;
                return Math.hypot(point.x - (edge.start.x + ex * t), point.z - (edge.start.z + ez * t));
              };
              const nearbyRoads = scan.roadGraph.edges.filter((edge) => edge.prefab === exactRoadInput.prefab &&
                pointSegmentDistance(edge.start, { start: proposedStart, end: proposedEnd }) <= 1.25 &&
                pointSegmentDistance(edge.end, { start: proposedStart, end: proposedEnd }) <= 1.25);
              const exactDuplicate = nearbyRoads.some((edge) =>
                Math.hypot(edge.start.x - proposedStart.x, edge.start.z - proposedStart.z) <= 1 &&
                Math.hypot(edge.end.x - proposedEnd.x, edge.end.z - proposedEnd.z) <= 1 ||
                Math.hypot(edge.start.x - proposedEnd.x, edge.start.z - proposedEnd.z) <= 1 &&
                Math.hypot(edge.end.x - proposedStart.x, edge.end.z - proposedStart.z) <= 1);
              if (exactDuplicate) throw new Error("PLANNER_INPUT_REPLACEMENT_EXISTING_EFFECT_RECONCILIATION_REQUIRED");
              const overlapsExisting = nearbyRoads.some((edge) => {
                const first = project(edge.start); const second = project(edge.end);
                const overlap = Math.min(1, Math.max(first, second)) - Math.max(0, Math.min(first, second));
                return overlap * Math.sqrt(lengthSquared) > 1.5;
              });
              const connectsExisting = scan.roadGraph.edges.some((edge) =>
                pointSegmentDistance(proposedStart, edge) <= 1.25 || pointSegmentDistance(proposedEnd, edge) <= 1.25);
              const worldEffect = scan.roadGraph.edges.length === 0 ? "ABSENT" as const : "PARTIAL" as const;
              const replacement = durability.ensurePlannerInputReplacement({
                state: durableProject,
                expectedCurrentTaskId: roadTask.id,
                objectiveId: `${durableProject.project.id}:${durableProject.tranche.id}:ROAD_CONNECTION`,
                planRevision,
                exactRoadInput,
                authorizationWorldId: branch.worldId,
                authorizationCheckpointId: branch.checkpointId,
                authorizationGeneration: branch.generation,
                activeBranchIdentity: `${branch.worldId}|${branch.checkpointId}|${branch.journalCut}`,
                trigger: "PLANNER_INPUT_CHANGED",
                worldEffect,
                correctedInputAvoidsExistingEffects: !overlapsExisting && connectsExisting,
                targetEntityAuthoritative: true,
              });
              if (replacement.task.id === roadTask.id) throw new Error("PLANNER_INPUT_REPLACEMENT_SUCCESSOR_IDENTITY_INVALID");
              const successorState = durability.projectState();
              if (successorState.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION)
                throw new Error("UTILITY_SERVICE_ROAD_SUCCESSOR_STATE_NOT_DURABLE");
              const successor = successorState.tasks.find((task) => task.id === replacement.task.id);
              if (!successor) throw new Error("UTILITY_SERVICE_ROAD_SUCCESSOR_NOT_DURABLE");
              const childIds = [replacement.child.amendmentId];
              for (const segment of serviceRoads.slice(1)) {
                const input = roadCourseGeometry(plannedRoadSegmentToMayorAction(segment));
                const child = recordUtilityServiceRoadChildOperation({
                  durability, state: successorState, planRevision, exactRoadInput: input,
                  authorizationWorldId: branch.worldId, authorizationCheckpointId: branch.checkpointId,
                  authorizationGeneration: branch.generation,
                  detail: "Utility Planner ordered service-road segment",
                });
                if (child.status !== "ACTIVE" || child.executionUseStatus !== "UNUSED")
                  throw new Error("UTILITY_SERVICE_ROAD_SUCCESSOR_SEGMENT_UNAVAILABLE");
                childIds.push(child.amendmentId);
              }
              if (successor.childOperationAmendmentIds && JSON.stringify(successor.childOperationAmendmentIds) !== JSON.stringify(childIds))
                throw new Error("UTILITY_SERVICE_ROAD_SUCCESSOR_ROUTE_CHANGED");
              successor.childOperationAmendmentIds = childIds;
              durability.saveProjectState(successorState);
            } else if (roadTask.status === "SUCCEEDED" && roadTask.terminalOutcomeId !== null &&
              durableProject.tranche.stage === "ROAD_DELIVERED") {
              const delivered = durableProject.journal.find((entry) => entry.id === roadTask.terminalOutcomeId);
              const deliveredCommand = delivered?.commandId ? commandJournal.get(delivered.commandId) : null;
              if (!delivered || delivered.execution !== "DELIVERED" || !deliveredCommand ||
                deliveredCommand.actionFamily !== "ROAD" || deliveredCommand.status !== "OBSERVED_MATCH" ||
                deliveredCommand.reconciliationStatus !== "MATCH" ||
                deliveredCommand.authorizedScope.owner.ownerType !== "TASK" ||
                deliveredCommand.authorizedScope.owner.ownerId !== roadTask.id) {
                throw new Error("UTILITY_SERVICE_ROAD_SUBGOAL_PARENT_EFFECT_NOT_CERTIFIED");
              }
              const childIds: string[] = [];
              for (const [segmentIndex, segment] of serviceRoads.entries()) {
                const segmentInput = roadCourseGeometry(plannedRoadSegmentToMayorAction(segment));
                const child = recordUtilityServiceRoadChildOperation({
                  durability, state: durableProject, planRevision, exactRoadInput: segmentInput,
                  authorizationWorldId: branch.worldId, authorizationCheckpointId: branch.checkpointId,
                  authorizationGeneration: branch.generation,
                  detail: `Utility Planner service-road goal segment ${segmentIndex + 1}/${serviceRoads.length}`,
                });
                if (JSON.stringify(child.exactRoadInput) !== JSON.stringify(segmentInput))
                  throw new Error("UTILITY_SERVICE_ROAD_SUBGOAL_EXACT_INPUT_CONFLICT");
                childIds.push(child.amendmentId);
              }
              const roadGoal = ensureUtilityServiceRoadGoal(durableProject, planRevision, childIds);
              durability.saveProjectState(durableProject);
              if (roadGoal.status !== "SUCCEEDED") {
                throw new Error("UTILITY_SERVICE_ROAD_SUBGOAL_CREATED:" + roadGoal.id);
              }
            } else {
              const childIds: string[] = [];
              for (const [segmentIndex, segment] of serviceRoads.entries()) {
                const segmentInput = roadCourseGeometry(plannedRoadSegmentToMayorAction(segment));
                const alreadyBound = segmentIndex === 0 && roadTask.childOperationAmendmentId
                  ? durability.utilityBudgetAmendments().find((entry) => entry.amendmentId === roadTask.childOperationAmendmentId) ?? null
                  : null;
                const child = alreadyBound ?? recordUtilityServiceRoadChildOperation({
                  durability, state: durableProject, planRevision, exactRoadInput: segmentInput,
                  authorizationWorldId: branch.worldId, authorizationCheckpointId: branch.checkpointId,
                  authorizationGeneration: branch.generation,
                  detail: `Utility Planner service-road segment ${segmentIndex + 1}/${serviceRoads.length}`,
                });
                if (JSON.stringify(child.exactRoadInput) !== JSON.stringify(segmentInput) || child.status !== "ACTIVE" ||
                  child.executionUseStatus !== "UNUSED") throw new Error("UTILITY_SERVICE_ROAD_CHILD_CURRENT_BINDING_MISMATCH");
                childIds.push(child.amendmentId);
              }
              if (!["PENDING", "WAITING"].includes(roadTask.status) || roadTask.terminalOutcomeId !== null ||
                (roadTask.childOperationAmendmentId && roadTask.childOperationAmendmentId !== childIds[0]) ||
                (roadTask.childOperationAmendmentIds && JSON.stringify(roadTask.childOperationAmendmentIds) !== JSON.stringify(childIds))) {
                throw new Error("UTILITY_SERVICE_ROAD_CHILD_GATE1_TASK_NOT_ATTACHABLE");
              }
              if (roadTask.childOperationAmendmentId !== childIds[0] || !roadTask.childOperationAmendmentIds) {
                roadTask.childOperationAmendmentId = childIds[0];
                roadTask.childOperationAmendmentIds = childIds;
                durability.saveProjectState(durableProject);
              }
            }
          }
        }
      }
      return prepared;
    },
    repairFacilityAccessRoad: async ({ scope, actions, expectedPlanRevision }: {
      scope: GreenfieldUtilityExecutionScope;
      actions: MayorAction[];
      expectedPlanRevision?: string;
    }, signal?: AbortSignal) => {
      if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
      if (!scope.commissionedKinds?.includes("water")) throw new Error("FACILITY_ACCESS_ROAD_REPAIR_SCOPE_NOT_WATER");
      if (actions.length !== 1 || actions[0]?.type !== "build_road" || actions[0].prefab !== FACILITY_ACCESS_ROAD_PREFAB) {
        throw new Error("FACILITY_REPAIR_MULTI_ACTION_NOT_CERTIFIED");
      }
      const action = actions[0];
      const activation = await requireActivatedDurableWorld(signal);
      if (activation.world.worldId !== scope.worldId || activation.world.generation !== scope.generation) {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_WORLD_BINDING_MISMATCH");
      }
      await waitForNativeIdle(signal);
      const game = record(await callTool("cs2_game_state", {}, signal));
      const liveWorld = record(game.world);
      if (record(game.simulation).paused !== true || liveWorld.nativeOperationStage !== "Idle" ||
        liveWorld.nativeOperationBusy === true || liveWorld.worldId !== scope.worldId || liveWorld.generation !== scope.generation) {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_LIVE_PREFLIGHT_FAILED");
      }
      const project = durability.projectState();
      if (project.schemaVersion !== "ai-mayor-v2-gate1-state/2" || project.project.id !== scope.projectId ||
        project.tranche.id !== scope.trancheId || project.tranche.stage !== "ROAD_DELIVERED") {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_PROJECT_BINDING_MISMATCH");
      }
      const utilityState = project.tranche.utilityExecution;
      const utility = utilityState?.utilities.water;
      const planned = utility?.plan;
      if (!utility || !utilityState || !planned || utility.constructionAttempts !== 1) {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_FACILITY_NOT_DURABLE");
      }
      const planRevision = utility.connectionObjective?.approvedPlanRevision ?? utility.planBinding?.topologyRevision ?? scope.topologyRevision;
      if (expectedPlanRevision !== undefined && expectedPlanRevision !== planRevision) {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_STALE_PLAN_REVISION");
      }
      // The ordinal of the bounded repair sequence, derived rather than written
      // down: one past the highest attempt any durable record of this lineage
      // already carries, so a later attempt continues the sequence and can never
      // repeat one. The capability refuses to derive past its own ceiling, which
      // is what keeps a lineage from becoming an unbounded repair loop.
      const repairAttemptIndex = nextFacilityAccessRoadRepairAttemptIndex([
        ...durability.utilityBudgetAmendments()
          .filter((entry) => entry.projectId === scope.projectId &&
            entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)
          .map((entry) => entry.repairAttemptIndex ??
            facilityAccessRoadRepairAttemptIndexFromLineage(entry.repairLineage) ?? 0),
        ...(utility.candidateLedger ?? []).map((candidate) => candidate.repairAttemptIndex ?? 0),
      ]);
      const repairLineage = facilityAccessRoadRepairLineage({
        projectId: scope.projectId, planRevision, attemptIndex: repairAttemptIndex,
      });
      const actionFingerprint = JSON.stringify(actions);
      // The course the action names, control point included: a repair may be a
      // curve, and a candidate flattened to its chord would be previewed, priced
      // and authorized as a different native course than the certified one.
      const geometry = roadCourseGeometry(action);

      // Admission is permitted only on a fresh, exact-course native preview and
      // a complete permanent-road list proving that this course is not already
      // present. This is not a candidate search: `actions` is the caller's one
      // certified course and no alternate geometry is generated here.
      await waitForNativeIdle(signal);
      const preview = record(await callTool("cs2_spatial", { mode: "preflight", kind: "net", ...geometry }, signal));
      await waitForNativeIdle(signal);
      if (preview.previewOnly !== true || preview.valid !== true) {
        throw new Error(`FACILITY_ACCESS_ROAD_REPAIR_NATIVE_PREVIEW_REJECTED:${String(preview.error ?? preview.validation ?? "UNKNOWN")}`);
      }
      const quote = nativeRoadQuoteFromPreview(preview, geometry, (options.now ?? (() => new Date()))());
      const roadList = record(await callTool("cs2_list_roads", { query: FACILITY_ACCESS_ROAD_PREFAB, limit: 500 }, signal));
      const duplicateRead = matchExactNetCourseReadback({
        prefab: FACILITY_ACCESS_ROAD_PREFAB,
        start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 },
        ...(geometry.cx !== undefined && geometry.cz !== undefined ? { control: { x: geometry.cx, z: geometry.cz } } : {}),
        roads: roadList.roads, totalMatches: roadList.totalMatches, returned: roadList.returned,
        truncated: roadList.truncated, hasMore: roadList.hasMore, tolerance: 1,
      });
      if (duplicateRead.result !== "MISMATCH" || duplicateRead.evidence.matchedEdges.length !== 0) {
        throw new Error(`FACILITY_ACCESS_ROAD_REPAIR_DUPLICATE_STATE_${duplicateRead.result}`);
      }

      const rebound = await rebindFacilityAndConnector(planned, signal, "water");
      if (rebound.status !== "MATCH") throw new Error(`FACILITY_ACCESS_ROAD_REPAIR_CURRENT_REBIND_${rebound.status}:${rebound.reason}`);
      utility.facility = rebound.facility;
      utility.connector = rebound.connector;
      await saveScopedUtilityState({ ...utilityState, utilities: { ...utilityState.utilities, water: utility } });
      const evidence = await facilityAccessRoadEvidencePort({ kind: "water", scope, signal });
      if (!evidence || evidence.roadAttachment !== "NONE" || evidence.noRoadAccessWarning !== true ||
        evidence.cityElectricityCapacitySufficient !== true) {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_ADMISSION_PRECONDITION_FAILED");
      }
      const priorSmallRoadCommands = commandJournal.list().filter((entry) => {
        if (entry.authorizedScope.actionFamily !== "UTILITY") return false;
        try {
          const priorActions = JSON.parse(entry.authorizedScope.exactInput) as MayorAction[];
          return entry.authorizedScope.projectId === scope.projectId &&
            entry.authorizedScope.utilityKind === "water" && priorActions.some((item) =>
              item.type === "build_road" && item.prefab === FACILITY_ACCESS_ROAD_PREFAB);
        } catch { return false; }
      });
      const previous = [...priorSmallRoadCommands].reverse().find((entry) => entry.status === "REJECTED");
      if (!previous) throw new Error("FACILITY_ACCESS_ROAD_PREVIOUS_ATTEMPT_NOT_TERMINAL_OR_ROLLBACK_RECONCILED");
      const observation = durability.worldObservations(previous.commandId).at(-1);
      let rollbackClassified = false;
      try {
        const details = JSON.parse(observation?.evidence ?? "null") as Record<string, unknown> | null;
        rollbackClassified = !!observation && observation.currentWorldEffectPresent === false && observation.worldId === scope.worldId &&
          details?.classification === "EFFECT_ABSENT_DUE_TO_USER_ROLLBACK";
      } catch { rollbackClassified = false; }
      const priorCandidate = utility.candidateLedger.find((candidate) => candidate.commandId === previous.commandId);
      const spentAuthorization = durability.utilityBudgetAmendments().find((entry) =>
        entry.amendmentId === priorCandidate?.authorizationAmendmentId && entry.status === "CONSUMED" &&
        entry.executionUseStatus === "CONSUMED");
      if (!rollbackClassified || !spentAuthorization) {
        throw new Error("FACILITY_ACCESS_ROAD_PREVIOUS_ATTEMPT_NOT_TERMINAL_OR_ROLLBACK_RECONCILED");
      }
      const overview = record(await callTool("cs2_city_overview", {}, signal));
      const treasury = Number(overview.treasury);
      if (!Number.isFinite(treasury)) throw new Error("FACILITY_ACCESS_ROAD_REPAIR_TREASURY_UNKNOWN");
      const activeRepairAuthorizations = durability.utilityBudgetAmendments().filter((entry) =>
        entry.projectId === scope.projectId && entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON &&
        (entry.status === "ACTIVE" || entry.status === undefined));
      const activeExact = activeRepairAuthorizations.length === 1 &&
        activeRepairAuthorizations[0].repairLineage === repairLineage &&
        activeRepairAuthorizations[0].planRevision === planRevision &&
        activeRepairAuthorizations[0].courseFingerprint === actionFingerprint &&
        activeRepairAuthorizations[0].roadPrefab === FACILITY_ACCESS_ROAD_PREFAB &&
        activeRepairAuthorizations[0].purpose === "Pump native road attachment repair";
      if (activeRepairAuthorizations.length > 0 && !activeExact) {
        throw new Error("FACILITY_ACCESS_ROAD_ACTIVE_AUTHORIZATION_BINDING_CONFLICT");
      }
      const amendment = admitFacilityAccessRoadBudgetAmendment({
        durability, activation, state: project, treasury, policy: V2_PROJECT_ADMISSION_POLICY,
        actualAccessRoadQuote: quote.signedAmount, segmentQuotes: [quote.signedAmount], actionCount: 1,
        roadPrefab: FACILITY_ACCESS_ROAD_PREFAB, repairLineage,
        repair: {
          facilityPlaced: true, roadAttachment: evidence.roadAttachment,
          accessRoadCommandIds: priorSmallRoadCommands.map((entry) => entry.commandId),
          previousAttempt: {
            commandId: previous.commandId, courseFingerprint: "exactInput" in previous.authorizedScope ? previous.authorizedScope.exactInput : "",
            authorizationSpent: true, terminalStatus: "REJECTED",
            currentWorldEffect: "ABSENT_DUE_TO_USER_ROLLBACK", reconciliationComplete: true,
          },
        },
        amendmentId: `${scope.projectId}:facility-access-road:${repairLineage}`,
        planRevision, courseFingerprint: actionFingerprint, purpose: "Pump native road attachment repair",
        detail: `Generation ${scope.generation}; single-action exact native preview quote ${quote.signedAmount}; previous attempt ${previous.commandId} is terminal and reconciled absent due to user rollback.`,
      });
      await waitForNativeIdle(signal);
      const exactRoadInput = stableRoadInput(geometry);
      const activeWorld = durability.snapshot().active;
      if (!activeWorld || activeWorld.worldId !== scope.worldId || activeWorld.generation !== scope.generation ||
        activeWorld.loadedCheckpointId !== activation.world.checkpointId) {
        throw new Error("FACILITY_ACCESS_ROAD_REPAIR_ACTIVE_WORLD_CHANGED");
      }
      // Facility frontage repair is not a utility-connection primitive: an
      // already-connected Water pipe must not let the utility recovery runner
      // short-circuit this road action as `no_action_needed`. Hand the admitted
      // exact action to the existing generic ROAD Kernel, whose durable commit
      // atomically consumes this amendment with creation of its ROAD command.
      const execution = await road.execute({
        proposal: {
          identity: {
            proposalId: quote.proposalId, actionFamily: "ROAD", exactInput: exactRoadInput,
            runtimeEpoch: quote.runtimeEpoch, frame: quote.frame, validationState: "VALID",
          },
          quoteId: quote.quoteId, fingerprint: exactRoadInput, input: geometry,
          owner: { ownerType: "PROJECT", ownerId: scope.projectId },
        },
        quote,
        worldGeneration: scope.generation,
        authorizedMaxSpend: amendment.record.nativeQuote ?? quote.signedAmount,
        treasurySafetyReserve: scope.treasurySafetyReserve,
        facilityAccessRoadRepair: {
          amendmentId: amendment.record.amendmentId,
          repairLineage,
          planRevision,
          actionFingerprint,
          actionCount: 1,
          purpose: "Pump native road attachment repair",
          prefab: FACILITY_ACCESS_ROAD_PREFAB,
          expectedJournalPosition: durability.snapshot().journalPosition,
          expectedWorldId: scope.worldId,
          expectedCheckpointId: activeWorld.loadedCheckpointId,
          expectedGeneration: scope.generation,
        },
      }, signal);

      const latestProject = durability.projectState();
      if (latestProject.schemaVersion === "ai-mayor-v2-gate1-state/2" && latestProject.project.id === scope.projectId &&
        latestProject.tranche.utilityExecution?.utilities.water) {
        const latestExecution = latestProject.tranche.utilityExecution;
        const latestWater = latestExecution.utilities.water;
        const candidate = latestWater.candidateLedger.find((entry) => entry.actionFingerprint === actionFingerprint);
        const ledgerCandidate = candidate ?? {
          candidateId: `${scope.projectId}:${repairLineage}:${amendment.record.amendmentId}`,
          objectiveId: `${scope.projectId}:${scope.trancheId}:water:${planRevision}:authorized-access-road-repair:${repairAttemptIndex}`,
          kind: "facility-access-road" as const,
          repair: FACILITY_ACCESS_ROAD_REPAIR,
          repairAttemptIndex,
          authorizationAmendmentId: amendment.record.amendmentId,
          ordinal: latestWater.candidateLedger.length,
          exactActions: structuredClone(actions),
          actionFingerprint,
          approvedPlanRevision: planRevision,
          repairPlanRevision: planRevision,
          executionMechanismRevision: scope.executionMechanismRevision,
          spatialScope: structuredClone(scope.spatialEnvelope),
          budgetCeiling: amendment.effectiveProjectBudget,
          ledgerState: "NOT_ATTEMPTED" as const,
          commandId: null,
          primitiveEffect: "NOT_OBSERVED" as const,
        };
        ledgerCandidate.authorizationAmendmentId = amendment.record.amendmentId;
        ledgerCandidate.repairAttemptIndex = repairAttemptIndex;
        ledgerCandidate.commandId = execution.command.commandId;
        ledgerCandidate.ledgerState = execution.bridgeCalled
          ? (execution.command.status === "OBSERVED_MATCH" ? "OBSERVED_MATCH" :
            execution.command.status === "NATIVE_COMPLETED" || execution.command.status === "COMMIT_ACK" ? "UNKNOWN" : "FAILED_DETERMINISTIC")
          : "FAILED_DETERMINISTIC";
        ledgerCandidate.primitiveEffect = ledgerCandidate.ledgerState === "OBSERVED_MATCH" ? "OBSERVED_MATCH" :
          ledgerCandidate.ledgerState === "UNKNOWN" ? "UNKNOWN" : "NOT_OBSERVED";
        if (!candidate) latestWater.candidateLedger.push(ledgerCandidate);
        if (!latestWater.networkCommandIds.includes(execution.command.commandId)) latestWater.networkCommandIds.push(execution.command.commandId);
        latestWater.accessRoadRepair = { status: execution.bridgeCalled ? "ATTEMPTED" : "PLANNED",
          quote: quote.signedAmount, offsetFromAdmittedCourse: 0, plannedAtJournalPosition: durability.snapshot().journalPosition };
        latestWater.lastRecoveryReason = execution.command.failureOrUnknownReason ?? execution.command.status;
        latestProject.tranche.utilityExecution.utilities.water = latestWater;
        await saveScopedUtilityState(latestProject.tranche.utilityExecution);
      }
      return { authorization: amendment.record, execution };
    },
    advanceSequentialUtilityRepair: async ({ scope, repairId, plan, expectedQuoteByStep, stopAfterStep1Admission, authorizeSegment2 }: {
      scope: GreenfieldUtilityExecutionScope;
      repairId: string;
      plan: { repairLineage: string; actions: readonly [MayorAction, MayorAction] };
      expectedQuoteByStep?: Partial<Record<1 | 2, number>>;
      stopAfterStep1Admission?: boolean;
      /** Explicit user authorization for one Segment 2 action; defaults to preflight-only. */
      authorizeSegment2?: boolean;
    }, signal?: AbortSignal) => {
      if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
      if (plan.actions.length !== 2 || plan.actions.some((action) => action.type !== "build_road" ||
        action.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB || !action.utilityEndpoints)) {
        throw new Error("NETWORK_LINK_REPAIR_REQUIRES_TWO_TYPED_SINGLE_ACTIONS");
      }
      const readCurrentRepairWorld = async (expectedWorldId: string) => {
        await waitForNativeIdle(signal);
        const live = record(await callTool("cs2_game_state", {}, signal));
        const liveWorld = record(live.world);
        if (record(live.simulation).paused !== true || liveWorld.nativeOperationStage !== "Idle" || liveWorld.nativeOperationBusy === true ||
          liveWorld.worldId !== expectedWorldId || typeof liveWorld.generation !== "string" || liveWorld.generation.length === 0) {
          throw new Error("NETWORK_LINK_REPAIR_CURRENT_WORLD_REBIND_FAILED");
        }
        return { ...scope, worldId: String(liveWorld.worldId), generation: String(liveWorld.generation),
          worldEpochId: `${String(liveWorld.worldId)}:generation:${String(liveWorld.generation)}` };
      };
      const initialLiveScope = await readCurrentRepairWorld(scope.worldId);
      if (!durability.isCurrentlyActivatedWorld(initialLiveScope.worldId, initialLiveScope.generation)) {
        const activation = await requireActivatedDurableWorld(signal);
        if (activation.world.worldId !== initialLiveScope.worldId || activation.world.generation !== initialLiveScope.generation) {
          throw new Error("NETWORK_LINK_REPAIR_DURABLE_GENERATION_REBIND_FAILED");
        }
      }
      if (authorizeSegment2 === true) {
        const stored = scopedUtilityState(scope)?.utilities.electricity.sequentialUtilityRepairs?.[repairId] ??
          (scopedUtilityState(scope)?.utilities.electricity.sequentialUtilityRepair?.repairId === repairId
            ? scopedUtilityState(scope)?.utilities.electricity.sequentialUtilityRepair
            : null);
        if (stored?.status !== "ACTIVE" || stored.actions?.[0]?.state !== "COMPLETE" || stored.actions.length !== 2 ||
          stored.actions[1]?.state !== "CERTIFIED") {
          throw new Error("SEGMENT_2_ONLY_AUTHORIZATION_REQUIRES_CERTIFIED_STEP_1_AND_STEP_2");
        }
      }
      const currentScope = () => readCurrentRepairWorld(scope.worldId);
      const admissionWitnesses = new Map<string, { startEndpoint: unknown; endEndpoint: unknown }>();
      const repairPorts: SequentialUtilityRepairPorts = {
        load: async (id) => {
          if (id !== repairId) return null;
          const utility = scopedUtilityState(scope)?.utilities.electricity;
          return utility?.sequentialUtilityRepairs?.[id] ??
            (utility?.sequentialUtilityRepair?.repairId === id ? utility.sequentialUtilityRepair : null);
        },
        save: async (state) => {
          const durableState = scopedUtilityState(scope);
          if (!durableState) throw new Error("NETWORK_LINK_REPAIR_DURABLE_UTILITY_STATE_MISSING");
          const utility = durableState.utilities.electricity;
          utility.sequentialUtilityRepairs ??= {};
          const prior = utility.sequentialUtilityRepairs[state.repairId];
          if (prior && prior.repairId !== state.repairId) throw new Error("NETWORK_LINK_REPAIR_DURABLE_IDENTITY_INDEX_MISMATCH");
          utility.sequentialUtilityRepairs[state.repairId] = structuredClone(state);
          if (!utility.sequentialUtilityRepair || utility.sequentialUtilityRepair.repairId === state.repairId) {
            utility.sequentialUtilityRepair = structuredClone(state);
          }
          await saveScopedUtilityState(durableState);
        },
        rebind: async (index, priorRealized, actionTemplate) => {
          const liveScope = await currentScope();
          const template = actionTemplate ?? plan.actions[index - 1];
          if (template.type !== "build_road" || !template.utilityEndpoints) throw new Error("NETWORK_LINK_REPAIR_ENDPOINTS_MISSING");
          const semanticAction = structuredClone(template) as Extract<MayorAction, { type: "build_road" }>;
          const endpointBindings = semanticAction.utilityEndpoints!;
          if (index === 2) {
            const position = record(record(priorRealized).midpointPosition);
            const realizedGeometry = record(record(priorRealized).geometry);
            if (![position.x, position.y, position.z].every((value) => Number.isFinite(Number(value)))) {
              throw new Error("SEGMENT_1_REALIZED_MIDPOINT_POSITION_MISSING");
            }
            const routeStart = record(realizedGeometry.start); const routeEnd = record(realizedGeometry.end);
            if (![routeStart.x, routeStart.z, routeEnd.x, routeEnd.z].every((value) => Number.isFinite(Number(value)))) {
              throw new Error("SEGMENT_1_REALIZED_COURSE_GEOMETRY_MISSING");
            }
            const midpointRoadRead = record(await callTool("cs2_list_roads", { query: semanticAction.prefab, limit: 500 }, signal));
            const midpointRoads = Array.isArray(midpointRoadRead.roads) ? midpointRoadRead.roads.map(record) : null;
            const midpointRoadsComplete = midpointRoadRead.complete === true ||
              (Number.isFinite(Number(midpointRoadRead.totalMatches)) &&
                Number(midpointRoadRead.returned) === Number(midpointRoadRead.totalMatches));
            if (!midpointRoads || midpointRoadRead.truncated === true || midpointRoadRead.hasMore === true || !midpointRoadsComplete) {
              throw new Error("SEGMENT_1_CURRENT_CABLE_LIST_INCOMPLETE");
            }
            const course = matchNetworkLinkCourseEffect({
              roads: midpointRoads as import("./network-link-course-effect").NetworkLinkCourseRoad[], prefab: semanticAction.prefab,
              start: { x: Number(routeStart.x), z: Number(routeStart.z) }, end: { x: Number(routeEnd.x), z: Number(routeEnd.z) }, tolerance: 0.25,
            });
            if (course.status !== "MATCH") throw new Error(`SEGMENT_1_CURRENT_COURSE_REBIND_${course.status}:${course.reason}`);
            const lastEdge = course.edges.at(-1)!;
            const realizedStart = record(lastEdge.start); const realizedEnd = record(lastEdge.end);
            const lastStartDistance = Math.hypot(Number(realizedStart.x) - Number(routeEnd.x), Number(realizedStart.z) - Number(routeEnd.z));
            const lastEndDistance = Math.hypot(Number(realizedEnd.x) - Number(routeEnd.x), Number(realizedEnd.z) - Number(routeEnd.z));
            const midpointEndpointRole = lastStartDistance <= 0.25 ? "START" : lastEndDistance <= 0.25 ? "END" : null;
            if (![realizedStart.x, realizedStart.z, realizedEnd.x, realizedEnd.z].every((value) => Number.isFinite(Number(value))) ||
              (midpointEndpointRole !== "START" && midpointEndpointRole !== "END")) {
              throw new Error("SEGMENT_1_REALIZED_MIDPOINT_EDGE_BINDING_MISSING");
            }
            const startBinding = endpointBindings.start;
            endpointBindings.start = {
              ...startBinding,
              expectedPosition: { x: Number(position.x), y: Number(position.y), z: Number(position.z) },
              topologyLookup: {
                ...startBinding.topologyLookup!,
                networkEdgePrefab: semanticAction.prefab,
                edgeGeometry: { x1: Number(realizedStart.x), z1: Number(realizedStart.z), x2: Number(realizedEnd.x), z2: Number(realizedEnd.z) },
                edgeEndpointRole: midpointEndpointRole,
              },
            };
          }
          const start = await rebindUtilityNetworkEndpoint(endpointBindings.start, liveScope, signal, true);
          const end = await rebindUtilityNetworkEndpoint(endpointBindings.end, liveScope, signal, true);
          const geometry = roadCourseGeometry(semanticAction);
          const actionId = crypto.randomUUID();
          return {
            index, worldId: liveScope.worldId, generation: liveScope.generation,
            actionId, commandId: crypto.randomUUID(), authorizationId: crypto.randomUUID(),
            utility: "ELECTRICITY", prefab: semanticAction.prefab,
            geometry: geometry as unknown as Readonly<Record<string, number | string>>,
            // Durable coordinator state carries semantic descriptors only. The
            // entity IDs returned by this rebind are deliberately discarded;
            // every preview and submission rebinds against the then-current world.
            action: semanticAction,
          };
        },
        preview: async (candidate) => {
          const liveScope = await currentScope();
          const action = candidate.action;
          if (!action || action.type !== "build_road" || !action.utilityEndpoints) {
            throw new Error("NETWORK_LINK_REPAIR_BOUND_ACTION_INVALID");
          }
          if (candidate.worldId !== liveScope.worldId || candidate.generation !== liveScope.generation) {
            throw new Error("NETWORK_LINK_REPAIR_STALE_GENERATION");
          }
          const startEndpoint = await rebindUtilityNetworkEndpoint(action.utilityEndpoints.start, liveScope, signal, true);
          const endEndpoint = await rebindUtilityNetworkEndpoint(action.utilityEndpoints.end, liveScope, signal, true);
          await waitForNativeIdle(signal);
          const raw = record(await callTool("cs2_spatial", {
            mode: "preflight", kind: "net", ...roadCourseGeometry(action),
            startEndpoint, endEndpoint,
          }, signal));
          await waitForNativeIdle(signal);
          const quote = readNativeUtilityQuote(raw, Number.NaN);
          const realization = record(record(raw.diagnostics).realization);
          const realizedStart = record(realization.realizedStartEntity);
          const realizedEnd = record(realization.realizedEndEntity);
          const sourceAttachmentMatch = startEndpoint.kind === "EXISTING_NET_NODE" &&
            Number(realizedStart.index) === startEndpoint.entity?.index && Number(realizedStart.version) === startEndpoint.entity?.version;
          const freeMidpointEndpoint = endEndpoint.kind === "NEW_FREE_ENDPOINT" &&
            (realizedEnd.index === null || realizedEnd.index === undefined) &&
            (realizedEnd.version === null || realizedEnd.version === undefined);
          // This is preview-time endpoint realization only; native Apply can remap the
          // generated terminal to a different permanent node, so it is not an effect witness.
          const targetAttachmentMatch = endEndpoint.kind === "EXISTING_NET_NODE" &&
            Number(realizedEnd.index) === endEndpoint.entity?.index && Number(realizedEnd.version) === endEndpoint.entity?.version;
          const duplicateRead = record(await callTool("cs2_list_roads", { query: action.prefab, limit: 500 }, signal));
          const roads = Array.isArray(duplicateRead.roads) ? duplicateRead.roads.map(record) : null;
          if (!roads || duplicateRead.truncated === true || duplicateRead.hasMore === true || duplicateRead.complete === false) {
            throw new Error("NETWORK_LINK_REPAIR_DUPLICATE_SCAN_INCOMPLETE");
          }
          const duplicate = roads.some((road) => {
            const a = record(road.start); const b = record(road.end);
            const close = (point: Record<string, unknown>, x: number, z: number) => Math.hypot(Number(point.x) - x, Number(point.z) - z) <= 0.25;
            return road.prefab === action.prefab &&
              ((close(a, action.x1, action.z1) && close(b, action.x2, action.z2)) ||
               (close(a, action.x2, action.z2) && close(b, action.x1, action.z1)));
          });
          const startBound = startEndpoint.kind === "EXISTING_NET_NODE" && startEndpoint.entity !== null;
          const endBound = endEndpoint.kind === "NEW_FREE_ENDPOINT" || endEndpoint.entity !== null;
          const index = candidate.index;
          const sourceJoinPass = duplicate ? startBound : sourceAttachmentMatch;
          const midpointFreePass = duplicate ? endEndpoint.kind === "NEW_FREE_ENDPOINT" : freeMidpointEndpoint;
          const targetJoinPass = duplicate ? endBound : targetAttachmentMatch;
          const topologyChecks: Record<string, "PASS" | "FAIL" | "UNKNOWN"> = index === 1
            ? { sourceComponentReachable: startBound ? "PASS" : "FAIL", exactSourceEndpointBound: startBound ? "PASS" : "FAIL",
                sourceAttachmentMatch: sourceJoinPass ? "PASS" : "FAIL", freeMidpointEndpoint: midpointFreePass ? "PASS" : "FAIL" }
            : { sourceComponentReachable: startBound ? "PASS" as const : "FAIL" as const,
                segment1ChainConnected: startBound ? "PASS" as const : "FAIL" as const,
                midpointTerminalBound: startBound ? "PASS" as const : "FAIL" as const,
                targetAttachmentMatch: targetJoinPass ? "PASS" as const : "FAIL" as const };
          const topologyPass = Object.values(topologyChecks).every((truth) => truth === "PASS");
          const previewPass = raw.valid === true && raw.previewOnly === true;
          return {
            // A duplicate routes only to authoritative readback reconciliation;
            // it cannot reach authorization or execute through the coordinator.
            valid: (previewPass || duplicate) && startBound && endBound && topologyPass && (duplicate || Number.isFinite(quote)),
            quote: duplicate ? 0 : Number.isFinite(quote) ? quote : -1, duplicate, topologyChecks,
            worldId: liveScope.worldId, generation: liveScope.generation,
            ...(!previewPass && !duplicate ? { reason: String(raw.error ?? "NATIVE_PREVIEW_REJECTED") } : {}),
          };
        },
        admit: async (candidate, quote) => {
          const liveScope = await currentScope();
          const action = candidate.action;
          if (!action || action.type !== "build_road" || candidate.worldId !== liveScope.worldId || candidate.generation !== liveScope.generation) {
            throw new Error("NETWORK_LINK_REPAIR_ADMISSION_BINDING_STALE");
          }
          const utilityState = scopedUtilityState(scope)?.utilities.electricity;
          if (!utilityState) throw new Error("NETWORK_LINK_REPAIR_ADMISSION_UTILITY_STATE_MISSING");
          const admitted = await executeScopedUtility({
            scope: liveScope, state: utilityState, plan: utilityState.plan!, selectedPrimitive: "direct-cable",
            admissionOnly: true,
            networkLinkRepair: { actions: [structuredClone(action)], repairLineage: plan.repairLineage, stepIndex: candidate.index },
          }, signal);
          if (!admitted.executionSucceeded || admitted.networkSubmissionAttempted || admitted.networkCommandIds.length !== 0 ||
            (admitted as typeof admitted & { admittedQuote?: number | null }).admittedQuote !== quote) {
            throw new Error(`NETWORK_LINK_REPAIR_PRODUCTION_ADMISSION_REJECTED:${JSON.stringify({
              reason: admitted.reason, preflightDiagnostics: admitted.preflightDiagnostics ?? null,
              maximumSpend: liveScope.maximumSpend, treasury: liveScope.treasury,
              treasurySafetyReserve: liveScope.treasurySafetyReserve,
            })}`);
          }
          const admittedEndpoints = (admitted as typeof admitted & { admittedEndpoints?: { startEndpoint: unknown; endEndpoint: unknown } | null }).admittedEndpoints;
          if (!admittedEndpoints?.startEndpoint || !admittedEndpoints.endEndpoint) throw new Error("NETWORK_LINK_REPAIR_ADMITTED_ENDPOINT_WITNESS_MISSING");
          admissionWitnesses.set(candidate.authorizationId, admittedEndpoints);
          return { admitted: true, actionFingerprint: JSON.stringify([action]), quote,
            worldId: liveScope.worldId, generation: liveScope.generation };
        },
        authorize: async ({ candidate, quote }) => {
          const liveScope = await currentScope();
          if (!candidate.action || candidate.worldId !== liveScope.worldId || candidate.generation !== liveScope.generation) {
            throw new Error("NETWORK_LINK_REPAIR_AUTHORIZATION_BINDING_STALE");
          }
          const action = candidate.action;
          if (action.type !== "build_road" || !action.utilityEndpoints) throw new Error("NETWORK_LINK_REPAIR_ACTION_INVALID");
          const planState = scopedUtilityState(scope);
          if (!planState) throw new Error("NETWORK_LINK_REPAIR_DURABLE_STATE_MISSING");
          if (candidate.index === 2) {
            const utility = planState.utilities.electricity;
            const repairState = utility.sequentialUtilityRepairs?.[repairId] ??
              (utility.sequentialUtilityRepair?.repairId === repairId ? utility.sequentialUtilityRepair : null);
            const step1 = repairState?.actions.find((entry) => entry.index === 1);
            const step1Command = step1 ? durability.commandJournal.get(step1.commandId) : null;
            const currentObservation = step1 ? durability.worldObservations(step1.commandId).at(-1) : null;
            let observationEvidence: Record<string, unknown> = {};
            try { observationEvidence = JSON.parse(currentObservation?.evidence ?? "{}"); } catch { /* fail closed below */ }
            const topologyChecks = step1?.topologyEvidence?.checks;
            const terminalNonReplayable = !!step1Command &&
              ["OBSERVED_MATCH", "OBSERVED_MISMATCH", "REJECTED", "FAILED_BEFORE_SUBMIT"].includes(step1Command.status);
            if (step1?.state !== "COMPLETE" || !step1.realized || !step1.topologyEvidence ||
              !topologyChecks || Object.values(topologyChecks).some((value) => value !== "PASS") || !terminalNonReplayable ||
              currentObservation?.worldId !== liveScope.worldId || currentObservation.worldEpochId !== liveScope.worldEpochId ||
              currentObservation.currentWorldEffectPresent !== true || currentObservation.currentWorldObjectiveSatisfied !== true ||
              observationEvidence.repairId !== repairId || observationEvidence.stepIndex !== 1 ||
              observationEvidence.actionFingerprint !== JSON.stringify([step1.action]) ||
              observationEvidence.generation !== liveScope.generation) {
              throw new Error("NETWORK_LINK_REPAIR_SEGMENT_1_DURABLE_AUTHORITY_UNPROVEN");
            }
          }
          const ledger = planState.utilities.electricity.candidateLedger;
          const prior = ledger.find((entry) => entry.candidateId === `${repairId}:step:${candidate.index}`);
          if (prior) {
            if (prior.networkLinkRepair?.authorizationId !== candidate.authorizationId || prior.actionFingerprint !== JSON.stringify([action]) ||
              prior.commandId !== candidate.commandId || prior.networkLinkRepair.exactQuote !== quote) {
              throw new Error("NETWORK_LINK_REPAIR_AUTHORIZATION_IMMUTABLE_MISMATCH");
            }
          } else {
            const actionIdentity = utilityActionIdentity({
              utility: "ELECTRICITY", prefab: action.prefab,
              geometry: roadCourseGeometry(action) as unknown as Record<string, number>,
              start: action.utilityEndpoints.start, end: action.utilityEndpoints.end,
              quote, actionCount: 1, repairLineage: plan.repairLineage, stepId: `step-${candidate.index}`,
            });
            ledger.push({
              candidateId: `${repairId}:step:${candidate.index}`, objectiveId: repairId,
              kind: "direct-cable", ordinal: candidate.index - 1, exactActions: [structuredClone(action)],
              actionFingerprint: JSON.stringify([action]), approvedPlanRevision: `${plan.repairLineage}:step:${candidate.index}`,
              executionMechanismRevision: liveScope.executionMechanismRevision, spatialScope: liveScope.spatialEnvelope,
              budgetCeiling: quote, ledgerState: "AUTHORIZED", commandId: candidate.commandId,
              primitiveEffect: "NOT_OBSERVED", networkLinkRepair: {
                kind: "NETWORK_LINK_REPAIR", repairLineage: plan.repairLineage, stepIndex: candidate.index,
                authorizationId: candidate.authorizationId, exactQuote: quote, actionIdentity,
              },
            });
            await saveScopedUtilityState(planState);
          }
          return { actionId: candidate.actionId, authorizationId: candidate.authorizationId, quote, singleUse: true };
        },
        submit: async ({ candidate, quote }) => {
          const liveScope = await currentScope();
          if (candidate.worldId !== liveScope.worldId || candidate.generation !== liveScope.generation) {
            throw new Error("NETWORK_LINK_REPAIR_SUBMISSION_GENERATION_CHANGED_AFTER_ADMISSION");
          }
          const state = scopedUtilityState(scope);
          const utility = state?.utilities.electricity;
          if (!utility || !candidate.action || candidate.action.type !== "build_road") throw new Error("NETWORK_LINK_REPAIR_EXECUTION_STATE_MISSING");
          const admissionWitness = admissionWitnesses.get(candidate.authorizationId);
          if (!admissionWitness) throw new Error("NETWORK_LINK_REPAIR_ADMISSION_WITNESS_MISSING");
          const ledgerCandidate = utility.candidateLedger.find((entry) => entry.candidateId === `${repairId}:step:${candidate.index}`);
          if (!ledgerCandidate || ledgerCandidate.commandId !== candidate.commandId || ledgerCandidate.networkLinkRepair?.exactQuote !== quote) {
            throw new Error("NETWORK_LINK_REPAIR_EXACT_ADMISSION_MISSING");
          }
          const execution = await executeScopedUtility({
            scope: liveScope, state: utility, plan: utility.plan!, selectedPrimitive: "direct-cable",
            selectedCandidateId: ledgerCandidate.candidateId,
            networkLinkAdmissionWitness: admissionWitness,
            networkLinkRepair: { actions: [candidate.action], repairLineage: plan.repairLineage, stepIndex: candidate.index },
          }, signal);
          if (!execution.networkSubmissionAttempted || !execution.networkCommandIds.includes(candidate.commandId)) {
            throw new Error("NETWORK_LINK_REPAIR_UTILITY_KERNEL_SUBMISSION_FAILED");
          }
          return { commandId: candidate.commandId, nativeCallCount: 1 };
        },
        observe: async ({ candidate }) => {
          const liveScope = await currentScope();
          const action = candidate.action;
          if (!action || action.type !== "build_road" || !action.utilityEndpoints) throw new Error("NETWORK_LINK_REPAIR_OBSERVATION_ACTION_MISSING");
          const topologyLookup = action.utilityEndpoints.start.topologyLookup ?? action.utilityEndpoints.end.topologyLookup;
          if (!topologyLookup?.sourceAnchor) throw new Error("NETWORK_LINK_REPAIR_SOURCE_ANCHOR_MISSING");
          const sourceRead = record(await callTool("cs2_list_buildings", { query: topologyLookup.sourceAnchor.buildingPrefab, limit: 128 }, signal));
          const buildings = Array.isArray(sourceRead.buildings) ? sourceRead.buildings.map(record) : null;
          if (!buildings || sourceRead.truncated === true || sourceRead.hasMore === true || sourceRead.complete === false) {
            throw new Error("NETWORK_LINK_REPAIR_SOURCE_READBACK_INCOMPLETE");
          }
          const source = buildings.filter((building) => {
            const p = record(building.position);
            return building.prefab === topologyLookup.sourceAnchor!.buildingPrefab && building.isSubBuilding !== true &&
              Math.hypot(Number(p.x) - topologyLookup.sourceAnchor!.position.x, Number(p.z) - topologyLookup.sourceAnchor!.position.z) <= 0.25;
          });
          if (source.length !== 1) throw new Error("NETWORK_LINK_REPAIR_SOURCE_REBIND_NOT_UNIQUE");
          const sourceEntity = record(source[0].entity);
          const connectorRead = record(await callTool("cs2_utility_connectors", { index: Number(sourceEntity.index), version: Number(sourceEntity.version) }, signal));
          const connectors = Array.isArray(connectorRead.connectors) ? connectorRead.connectors.map(record) : null;
          if (!connectors || connectorRead.truncated === true || connectorRead.hasMore === true || connectorRead.complete === false) {
            throw new Error("NETWORK_LINK_REPAIR_CONNECTOR_READBACK_INCOMPLETE");
          }
          const matches = connectors.filter((connector) => connector.type === topologyLookup.sourceAnchor!.connectorUtility.toLowerCase());
          if (matches.length !== 1) throw new Error("NETWORK_LINK_REPAIR_SOURCE_CONNECTOR_NOT_UNIQUE");
          const connectorNode = record(matches[0].node);
          const roadsRead = record(await callTool("cs2_list_roads", { query: action.prefab, limit: 500 }, signal));
          const roads = Array.isArray(roadsRead.roads) ? roadsRead.roads.map(record) : null;
          if (!roads || roadsRead.truncated === true || roadsRead.hasMore === true || roadsRead.complete === false) {
            throw new Error("NETWORK_LINK_REPAIR_EDGE_READBACK_INCOMPLETE");
          }
          const realizedCourse = matchNetworkLinkCourseEffect({
            roads: roads as import("./network-link-course-effect").NetworkLinkCourseRoad[], prefab: action.prefab,
            start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 }, tolerance: 0.25,
          });
          if (realizedCourse.status !== "MATCH") {
            const checks: Record<string, "UNKNOWN"> = candidate.index === 1
              ? { sourceComponentReachable: "UNKNOWN", newCurrentGenerationEdge: "UNKNOWN", midpointTerminalBound: "UNKNOWN", sourceSideConnection: "UNKNOWN", noUnintendedDuplicate: "UNKNOWN" }
              : { sourceComponentReachable: "UNKNOWN", segment1ChainConnected: "UNKNOWN", segment2CurrentGenerationEdge: "UNKNOWN", localRoadComponentReached: "UNKNOWN", pumpElectricityPathReached: "UNKNOWN", noUnintendedDuplicate: "UNKNOWN" };
            const observation: SequentialRepairObservation = { effect: realizedCourse.status === "MISSING" ? "FAIL" : "UNKNOWN",
              topology: { checks, evidence: { worldId: liveScope.worldId, generation: liveScope.generation } },
              reason: `REALIZED_SEGMENT_COURSE_${realizedCourse.status}:${realizedCourse.reason}` };
            return observation;
          }
          const firstCourseEdge = realizedCourse.edges[0];
          const lastCourseEdge = realizedCourse.edges.at(-1)!;
          const firstCourseStart = Math.hypot(Number(record(firstCourseEdge.start).x) - action.x1,
            Number(record(firstCourseEdge.start).z) - action.z1) <= 0.25 ? firstCourseEdge.start : firstCourseEdge.end;
          const lastCourseEnd = Math.hypot(Number(record(lastCourseEdge.end).x) - action.x2,
            Number(record(lastCourseEdge.end).z) - action.z2) <= 0.25 ? lastCourseEdge.end : lastCourseEdge.start;
          const lastCourseEndRole = lastCourseEnd === lastCourseEdge.end ? "END" as const : "START" as const;
          const edgeEntity = record(lastCourseEdge.entity);
          const topology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
            index: Number(sourceEntity.index), version: Number(sourceEntity.version),
            connector: { index: Number(connectorNode.index), version: Number(connectorNode.version) },
            target: { index: Number(edgeEntity.index), version: Number(edgeEntity.version) },
            expectedWorldId: liveScope.worldId, expectedGeneration: liveScope.generation,
            expectedTopologyRevision: bridgeTopologyRevision({ generation: liveScope.generation, target: edgeEntity as unknown as SpatialEntityRef }),
            endpointTolerance: 0.25, envelope: exactNetworkLinkEnvelope(action),
          }, signal));
          const binding = record(topology.binding);
          const targetNetwork = record(topology.targetNetwork);
          const endpoints = Array.isArray(targetNetwork.targetEndpoints) ? targetNetwork.targetEndpoints.map(record) : [];
          const far = endpoints.filter((endpoint) => {
            const p = record(endpoint.position);
            return Math.hypot(Number(p.x) - action.x2, Number(p.z) - action.z2) <= 0.25;
          });
          const lastEdgeStart = record(lastCourseEdge.start); const lastEdgeEnd = record(lastCourseEdge.end);
          const midpointRebind = far.length === 1 ? await rebindUtilityNetworkEndpoint({
            mode: "EXISTING_NET_NODE", role: "END", utility: "ELECTRICITY", prefab: action.prefab,
            expectedPosition: {
              x: Number(record(far[0].position).x),
              y: Number(record(far[0].position).y),
              z: Number(record(far[0].position).z),
            },
            bindingRule: candidate.index === 1 ? "REALIZED_SEGMENT_1_MIDPOINT" : "REALIZED_SEGMENT_2_TERMINAL",
            topologyRole: candidate.index === 1 ? "LV_CABLE_TERMINAL" : "PUMP_ACCESS_ROAD_ELECTRICITY_NODE",
            topologyLookup: {
              networkEdgePrefab: action.prefab,
              edgeGeometry: { x1: Number(lastEdgeStart.x), z1: Number(lastEdgeStart.z), x2: Number(lastEdgeEnd.x), z2: Number(lastEdgeEnd.z) },
              edgeEndpointRole: lastCourseEndRole,
              sourceAnchor: topologyLookup.sourceAnchor,
              requireSourceReachability: true,
            },
          }, liveScope, signal, true).catch(() => null) : null;
          const midpointBound = !!midpointRebind && far.length === 1 &&
            midpointRebind.entity.index === Number(record(far[0].node).index) && midpointRebind.entity.version === Number(record(far[0].node).version) &&
            Math.hypot(midpointRebind.expectedPosition.x - Number(record(far[0].position).x), midpointRebind.expectedPosition.y - Number(record(far[0].position).y),
              midpointRebind.expectedPosition.z - Number(record(far[0].position).z)) <= 0.25;
          const sourceToSegment2TerminalReachable = targetNetwork.targetNetworkReachable === true || targetNetwork.reachableFromSource === true;
          let sourceToTargetNetworkReachable = false;
          let realizedTerminalNode: Record<string, unknown> | null = null;
          let targetRoadNode: Record<string, unknown> | null = null;
          let targetRoadFlowNode: Record<string, unknown> | null = null;
          let entityIdentityMatch = false;
          let terminalTargetPositionDelta: number | null = null;
          let targetBindingStatus = "UNAVAILABLE";
          let segment2MidpointJoinPresent = false;
          if (candidate.index === 2) {
            const freshMidpoint = await rebindUtilityNetworkEndpoint(action.utilityEndpoints.start, liveScope, signal, true);
            const firstEdgeEntity = record(firstCourseEdge.entity);
            const firstTopology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
              index: Number(sourceEntity.index), version: Number(sourceEntity.version),
              connector: { index: Number(connectorNode.index), version: Number(connectorNode.version) },
              target: { index: Number(firstEdgeEntity.index), version: Number(firstEdgeEntity.version) },
              expectedWorldId: liveScope.worldId, expectedGeneration: liveScope.generation,
              expectedTopologyRevision: bridgeTopologyRevision({ generation: liveScope.generation, target: firstEdgeEntity as unknown as SpatialEntityRef }),
              endpointTolerance: 0.25, envelope: exactNetworkLinkEnvelope(action),
            }, signal));
            const firstTargetNetwork = record(firstTopology.targetNetwork);
            const firstEndpoints = Array.isArray(firstTargetNetwork.targetEndpoints) ? firstTargetNetwork.targetEndpoints.map(record) : [];
            const nearStart = firstEndpoints.filter((endpoint) => {
              const p = record(endpoint.position);
              return Math.hypot(Number(p.x) - action.x1, Number(p.z) - action.z1) <= 0.25;
            });
            if (nearStart.length === 1) {
              const realizedStartNode = record(nearStart[0].node);
              segment2MidpointJoinPresent = freshMidpoint.entity !== null &&
                freshMidpoint.entity.index === Number(realizedStartNode.index) &&
                freshMidpoint.entity.version === Number(realizedStartNode.version) &&
                (firstTopology.bindingStatus ?? record(firstTopology.binding).bindingStatus) === "VALID" &&
                (firstTopology.complete ?? record(firstTopology.binding).complete) === true && firstTopology.truncated !== true;
            }
            const targetBinding = action.utilityEndpoints.end;
            const targetLookup = targetBinding.topologyLookup;
            if (!targetLookup?.sourceAnchor) throw new Error("NETWORK_LINK_REPAIR_TARGET_ROAD_LOOKUP_MISSING");
            const freshTargetEndpoint = await rebindUtilityNetworkEndpoint(targetBinding, liveScope, signal, true);
            // Independently query the freshly rebound target road. Reaching the last cable edge
            // is not evidence that the Pump's road electricity component is reachable.
            const targetRoadRead = record(await callTool("cs2_list_roads", { query: targetLookup.networkEdgePrefab, limit: 500 }, signal));
            const targetRoads = Array.isArray(targetRoadRead.roads) ? targetRoadRead.roads.map(record) : null;
            if (!targetRoads || targetRoadRead.truncated === true || targetRoadRead.hasMore === true || targetRoadRead.complete === false) {
              throw new Error("NETWORK_LINK_REPAIR_TARGET_ROAD_READBACK_INCOMPLETE");
            }
            const g = targetLookup.edgeGeometry;
            const same = (point: unknown, x: number, z: number) => {
              const p = record(point);
              return Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z)) && Math.hypot(Number(p.x) - x, Number(p.z) - z) <= 0.25;
            };
            const targetRoadMatches = targetRoads.filter((road) => {
              const a = record(road.start); const b = record(road.end);
              return road.prefab === targetLookup.networkEdgePrefab &&
                ((same(a, g.x1, g.z1) && same(b, g.x2, g.z2)) || (same(a, g.x2, g.z2) && same(b, g.x1, g.z1)));
            });
            if (targetRoadMatches.length !== 1) throw new Error(targetRoadMatches.length === 0
              ? "NETWORK_LINK_REPAIR_TARGET_ROAD_MISSING" : "NETWORK_LINK_REPAIR_TARGET_ROAD_AMBIGUOUS");
            const targetRoadEntity = record(targetRoadMatches[0].entity);
            const targetTopology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
              index: Number(sourceEntity.index), version: Number(sourceEntity.version),
              connector: { index: Number(connectorNode.index), version: Number(connectorNode.version) },
              target: { index: Number(targetRoadEntity.index), version: Number(targetRoadEntity.version) },
              expectedWorldId: liveScope.worldId, expectedGeneration: liveScope.generation,
              expectedTopologyRevision: bridgeTopologyRevision({ generation: liveScope.generation, target: targetRoadEntity as unknown as SpatialEntityRef }),
              admittedPrefab: targetLookup.networkEdgePrefab, admittedStart: { x: g.x1, z: g.z1 }, admittedEnd: { x: g.x2, z: g.z2 }, endpointTolerance: 0.25,
            }, signal));
            const targetEndpointBinding = record(targetTopology.binding);
            const targetNetwork = record(targetTopology.targetNetwork);
            const targetEndpoints = Array.isArray(targetNetwork.targetEndpoints) ? targetNetwork.targetEndpoints.map(record) : [];
            targetBindingStatus = String(targetTopology.bindingStatus ?? targetEndpointBinding.bindingStatus ?? "UNKNOWN");
            const targetRole = targetLookup.edgeEndpointRole;
            const targetNodeMatch = targetEndpoints.filter((endpoint) => {
              const role = String(endpoint.role ?? endpoint.endpointRole ?? "").toUpperCase();
              const p = record(endpoint.position);
              return role === targetRole && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) && Number.isFinite(Number(p.z)) &&
                Math.hypot(Number(p.x) - targetBinding.expectedPosition.x,
                  Number(p.y) - targetBinding.expectedPosition.y, Number(p.z) - targetBinding.expectedPosition.z) <= 0.25;
            });
            if (targetNodeMatch.length === 1) {
              targetRoadNode = record(targetNodeMatch[0].node);
              targetRoadFlowNode = record(targetNodeMatch[0].electricityFlowNode);
            }
            const targetObservationComplete = targetBindingStatus === "VALID" &&
              (targetTopology.complete ?? targetEndpointBinding.complete) === true && targetTopology.truncated !== true && targetEndpointBinding.truncated !== true;
            sourceToTargetNetworkReachable = targetObservationComplete && targetNodeMatch.length === 1 &&
              freshTargetEndpoint.entity !== null &&
              freshTargetEndpoint.entity.index === Number(record(targetNodeMatch[0]?.node).index) &&
              freshTargetEndpoint.entity.version === Number(record(targetNodeMatch[0]?.node).version) &&
              (targetNetwork.targetNetworkReachable === true || targetNetwork.reachableFromSource === true);
            realizedTerminalNode = record(far[0]?.node);
            entityIdentityMatch = !!realizedTerminalNode && !!targetRoadNode &&
              Number(realizedTerminalNode.index) === Number(targetRoadNode.index) && Number(realizedTerminalNode.version) === Number(targetRoadNode.version);
            if (far.length === 1 && targetNodeMatch.length === 1) {
              const a = record(far[0].position); const b = record(targetNodeMatch[0].position);
              terminalTargetPositionDelta = Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
            }
          }
          const reachable = sourceToSegment2TerminalReachable;
          const checks: Record<string, "PASS" | "FAIL" | "UNKNOWN"> = candidate.index === 1
            ? { sourceComponentReachable: reachable ? "PASS" as const : "FAIL" as const,
                newCurrentGenerationEdge: binding.bindingStatus === "VALID" ? "PASS" as const : "FAIL" as const,
                midpointTerminalBound: midpointBound && Number.isInteger(Number(record(far[0].electricityFlowNode).index)) &&
                  Number.isInteger(Number(record(far[0].electricityFlowNode).version)) ? "PASS" as const : "FAIL" as const,
                sourceSideConnection: reachable ? "PASS" as const : "FAIL" as const, noUnintendedDuplicate: "PASS" as const }
            : evaluateSegment2PostApplyTopology({
                cableEffectPresent: binding.bindingStatus === "VALID" && binding.complete === true && binding.truncated !== true,
                midpointJoinPresent: segment2MidpointJoinPresent,
                // The endpoint itself must identify the freshly rebound road node, and the
                // independent road-component query must be source reachable. Geometry alone fails.
                targetJoinPresent: sourceToSegment2TerminalReachable && sourceToTargetNetworkReachable,
                sourceToSegment2TerminalReachable,
                sourceToTargetNetworkReachable,
                noUnintendedDuplicate: true,
              }).checks as Record<string, "PASS" | "FAIL" | "UNKNOWN">;
          const pass = binding.bindingStatus === "VALID" && binding.complete === true && binding.truncated !== true &&
            checks.sourceComponentReachable === "PASS" && (candidate.index === 1
              ? checks.midpointTerminalBound === "PASS" && checks.sourceSideConnection === "PASS"
              : checks.segment1ChainConnected === "PASS" && checks.targetJoinPresent === "PASS" &&
                checks.sourceToTargetNetworkReachable === "PASS" && checks.localRoadComponentReached === "PASS" && checks.pumpElectricityPathReached === "PASS");
          const realized = {
            edge: { index: Number(edgeEntity.index), version: Number(edgeEntity.version) },
            geometry: { start: firstCourseStart, end: lastCourseEnd },
            midpointEdgeEndpointRole: lastCourseEndRole,
            midpointEdgeGeometry: { start: lastCourseEdge.start, end: lastCourseEdge.end },
            midpointNode: candidate.index === 1 ? far[0]?.node : undefined,
            midpointPosition: candidate.index === 1 ? far[0]?.position : undefined,
            courseEdges: realizedCourse.edges.map((edge) => edge.entity),
            realizedStartPosition: firstCourseStart,
          };
          const observation: SequentialRepairObservation = {
            effect: pass ? "PASS" : "FAIL",
            topology: { checks, evidence: { worldId: liveScope.worldId, generation: liveScope.generation,
              actionGeneration: candidate.generation, reboundCurrentGeneration: true,
            bindingStatus: binding.bindingStatus, targetNetworkReachable: reachable,
            segment2CableEffectPresent: realizedCourse.edges.length > 0,
            midpointJoinPresent: candidate.index === 1 || segment2MidpointJoinPresent,
            targetJoinPresent: candidate.index === 2 ? checks.targetJoinPresent === "PASS" : undefined,
            sourceToSegment2TerminalReachable: candidate.index === 2 ? sourceToSegment2TerminalReachable : undefined,
            sourceToTargetNetworkReachable: candidate.index === 2 ? sourceToTargetNetworkReachable : undefined,
            realizedTerminalNode, targetRoadNode, targetRoadFlowNode, entityIdentityMatch, terminalTargetPositionDelta, targetBindingStatus,
            realizedCourseEdgeCount: realizedCourse.edges.length, midpointReboundCurrentGeneration: midpointBound } },
            realized,
            ...(!pass ? { reason: "AUTHORITATIVE_NETWORK_LINK_TOPOLOGY_POSTCONDITION_FAILED" } : {}) };
          return observation;
        },
        reconcileDuplicate: async (input) => repairPorts.observe(input),
      };
      const result = await advanceSequentialUtilityRepair({ repairId, plan, expectedQuoteByStep, stopAfterStep1Admission,
        stopBeforeStep2Authorization: authorizeSegment2 !== true,
        refreshBeforeStep2Authorization: authorizeSegment2 === true, ports: repairPorts });
      for (const completed of result.state.actions.filter((entry) => entry.state === "COMPLETE")) {
        const command = commandJournal.get(completed.commandId);
        if (!command) throw new Error(`NETWORK_LINK_REPAIR_COMPLETED_COMMAND_MISSING:${completed.commandId}`);
        const observationEvidence = JSON.stringify({
          kind: "NETWORK_LINK_REPAIR_AUTHORITATIVE_CURRENT_WORLD_OBSERVATION",
          repairId,
          repairLineage: plan.repairLineage,
          stepIndex: completed.index,
          actionFingerprint: JSON.stringify([completed.action]),
          generation: completed.topologyEvidence?.generation,
          realized: completed.realized,
          topologyChecks: completed.topologyEvidence?.checks,
        });
        const priorObservation = durability.worldObservations(completed.commandId).at(-1);
        if (priorObservation?.worldId !== scope.worldId || priorObservation.worldEpochId !== scope.worldEpochId ||
          priorObservation.currentWorldEffectPresent !== true || priorObservation.currentWorldObjectiveSatisfied !== true ||
          priorObservation.evidence !== observationEvidence) {
          durability.recordCurrentWorldObservation({
            commandId: completed.commandId,
            currentWorldEffectPresent: true,
            currentWorldObjectiveSatisfied: true,
            worldEpochId: `${scope.worldId}:generation:${String(completed.topologyEvidence?.generation ?? completed.generation)}`,
            evidence: observationEvidence,
          });
        }
        const utilityState = scopedUtilityState(scope);
        const ledgerCandidate = utilityState?.utilities.electricity.candidateLedger.find((entry) => entry.commandId === completed.commandId);
        if (utilityState && ledgerCandidate && ledgerCandidate.ledgerState !== "OBSERVED_MATCH") {
          ledgerCandidate.ledgerState = "OBSERVED_MATCH";
          ledgerCandidate.primitiveEffect = "OBSERVED_MATCH";
          await saveScopedUtilityState(utilityState);
        }
        if (command && command.status !== "OBSERVED_MATCH") {
          durability.reconcile(completed.commandId, { result: "MATCH", reason: "NETWORK_LINK_REPAIR_AUTHORITATIVE_WORLD_EFFECT_AND_TOPOLOGY_PASS" });
        }
      }
      if (result.status === "WAITING" && result.state.actions[0]?.state === "COMPLETE" &&
        (result.state.actions.length === 1 || result.state.actions[1]?.state === "CERTIFIED")) {
        // Step 2 receives a current-world rebind and a new native preview from
        // the realized step-1 midpoint. This read-only preflight deliberately
        // does not call authorize() or create a durable step-2 command.
        const candidate = await repairPorts.rebind(2, result.state.actions[0].realized, plan.actions[1]);
        const preview = await repairPorts.preview(candidate);
        const admission = preview.valid ? await repairPorts.admit(candidate, preview.quote) : null;
        return { repair: result, segment2FreshPreflight: { candidate, preview, admission } };
      }
      return { repair: result };
    },
    markAwaitingProductDecision: async (scope: GreenfieldUtilityExecutionScope, kind: GreenfieldUtilityKind, reason: string) => {
      await requireActivatedDurableWorld();
      const state = scopedUtilityState(scope);
      if (!state) throw new Error("STAGED_FACILITY_STATE_NOT_FOUND");
      const current = state.utilities[kind];
      const command = current.facilityCommandId ? commandJournal.get(current.facilityCommandId) : undefined;
      if (!command || command.status !== "OBSERVED_MATCH" || !current.facility) {
        throw new Error("STAGED_FACILITY_NOT_AUTHORITATIVELY_PLACED");
      }
      await saveScopedUtilityState(markFacilityAwaitingProductDecision({ state, kind, reason }));
    },
      run: async (scope: GreenfieldUtilityExecutionScope, signal?: AbortSignal) => {
      await requireActivatedDurableWorld(signal);
      return runScopedGreenfieldUtilityBootstrap({ scope, ports: {
        load: async () => scopedUtilityState(scope),
        save: async (state) => saveScopedUtilityState(state),
        currentUtilityRevision: () => worldState.revision("UTILITY"),
        observe: (kind, currentScope) => readScopedUtilityEvidence(kind, currentScope, signal),
        rebind: async (kind, state, currentScope) => {
          // Every kind rebinds through the same facility/connector reader. The
          // reader resolves the connector family from `kind`, so restricting this
          // to electricity left a reloaded water or sewage facility unable to
          // re-attach to its own already-built facility.
          if (!state.plan || state.constructionAttempts <= 0) {
            return { status: "UNKNOWN", reason: "UTILITY_REBIND_NOT_APPLICABLE" };
          }
          const command = state.facilityCommandId ? commandJournal.get(state.facilityCommandId) : null;
          const plan = committedUtilityPlacementPlan({ kind, plan: state.plan, facilityCommandId: state.facilityCommandId,
            command, scope: currentScope });
          return rebindFacilityAndConnector(plan ?? state.plan, signal, kind);
        },
        planCurrentConnection: async (kind, binding: UtilityCurrentBinding, currentScope) => {
          const planned = await planScopedUtility(kind, currentScope, signal, {
            mode: "EXISTING_FACILITY_CONNECTION", binding,
          });
          // The existing-facility planner returns the newly bound connection
          // plan directly; facility selection is intentionally out of scope
          // here because `binding.facility` came from the authoritative read.
          if (!planned.connection) throw new Error("CURRENT_UTILITY_CONNECTION_PLAN_UNAVAILABLE");
          const currentPlan = currentConnectionFacilityPlan(kind, currentScope, binding, planned.connection);
          const currentUtility = scopedUtilityState(currentScope)?.utilities[kind];
          if (kind !== "electricity" || currentUtility?.serviceEvidence?.targetNetworkReachable !== false ||
            !currentScope.targetSemantics) return currentPlan;

          // The original facility-to-target line overlaps the already observed
          // cable and native validation rejects it. Rebind that committed cable
          // from authoritative current topology, then extend from its free
          // network terminal to the exact certified target-road endpoint.
          // Durable candidate history supplies only the prior action geometry;
          // the live road scan and flow-node reads below prove today's edge.
          const historicalCable = [...currentUtility.candidateLedger].reverse().find((candidate) =>
            candidate.kind === "direct-cable" && candidate.ledgerState === "OBSERVED_MATCH" &&
            candidate.commandId !== null && candidate.exactActions.length === 1 &&
            candidate.exactActions[0]?.type === "build_road" &&
            candidate.exactActions[0].prefab === ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB);
          const historicalAction = historicalCable?.exactActions[0];
          if (!historicalAction || historicalAction.type !== "build_road") return currentPlan;
          const sourceRoadRead = record(await callTool("cs2_list_roads", { query: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB, limit: 500 }, signal));
          const sourceRoads = Array.isArray(sourceRoadRead.roads) ? sourceRoadRead.roads.map(record) : null;
          if (!sourceRoads || sourceRoadRead.truncated === true || sourceRoadRead.hasMore === true || sourceRoadRead.complete === false) {
            throw new Error("UTILITY_EXTENSION_SOURCE_CABLE_READBACK_INCOMPLETE");
          }
          const close2 = (point: unknown, x: number, z: number) => {
            const p = record(point);
            return Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z)) && Math.hypot(Number(p.x) - x, Number(p.z) - z) <= 0.25;
          };
          const sourceRows = sourceRoads.filter((road) => {
            const a = record(road.start); const b = record(road.end);
            return road.prefab === historicalAction.prefab &&
              ((close2(a, historicalAction.x1, historicalAction.z1) && close2(b, historicalAction.x2, historicalAction.z2)) ||
               (close2(a, historicalAction.x2, historicalAction.z2) && close2(b, historicalAction.x1, historicalAction.z1)));
          });
          if (sourceRows.length !== 1) throw new Error(sourceRows.length === 0
            ? "UTILITY_EXTENSION_SOURCE_CABLE_NO_LONGER_PRESENT" : "UTILITY_EXTENSION_SOURCE_CABLE_AMBIGUOUS");
          const sourceRow = sourceRows[0]; const sourceEntity = record(sourceRow.entity);
          const sourceStart = record(sourceRow.start); const sourceEnd = record(sourceRow.end);
          const connectorPosition = binding.connector.worldPosition;
          const sourceEndpointCandidates = [
            { point: sourceStart, role: "START" as const, attached: close2(sourceStart, connectorPosition.x, connectorPosition.z) },
            { point: sourceEnd, role: "END" as const, attached: close2(sourceEnd, connectorPosition.x, connectorPosition.z) },
          ];
          const terminalCandidates = sourceEndpointCandidates.filter((entry) => !entry.attached);
          if (terminalCandidates.length !== 1 || !Number.isInteger(Number(sourceEntity.index)) || !Number.isInteger(Number(sourceEntity.version))) {
            throw new Error("UTILITY_EXTENSION_SOURCE_TERMINAL_NOT_UNIQUE");
          }
          const sourceTopology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
            index: binding.facility.entity.index, version: binding.facility.entity.version,
            connector: binding.connector.node, target: { index: Number(sourceEntity.index), version: Number(sourceEntity.version) },
            expectedWorldId: currentScope.worldId, expectedGeneration: currentScope.generation,
            expectedTopologyRevision: bridgeTopologyRevision({ generation: currentScope.generation,
              target: sourceEntity as unknown as SpatialEntityRef }),
            admittedPrefab: historicalAction.prefab,
            admittedStart: { x: historicalAction.x1, z: historicalAction.z1 },
            admittedEnd: { x: historicalAction.x2, z: historicalAction.z2 }, endpointTolerance: 0.25,
            envelope: currentScope.spatialEnvelope,
          }, signal));
          const sourceTargetNetwork = record(sourceTopology.targetNetwork);
          const sourceBinding = record(sourceTopology.binding);
          const sourceEndpoints = Array.isArray(sourceTargetNetwork.targetEndpoints) ? sourceTargetNetwork.targetEndpoints.map(record) : [];
          const terminal = terminalCandidates[0];
          const terminalMatches = sourceEndpoints.filter((endpoint) => {
            const p = record(endpoint.position);
            return String(endpoint.role ?? endpoint.endpointRole ?? "").toUpperCase() === terminal.role &&
              close2(p, Number(terminal.point.x), Number(terminal.point.z)) &&
              Number.isInteger(Number(record(endpoint.electricityFlowNode).index)) &&
              Number.isInteger(Number(record(endpoint.electricityFlowNode).version));
          });
          if ((sourceTopology.bindingStatus ?? sourceBinding.bindingStatus) !== "VALID" ||
            (sourceTopology.complete ?? sourceBinding.complete) !== true || sourceTopology.truncated === true ||
            !(sourceTargetNetwork.targetNetworkReachable === true || sourceTargetNetwork.reachableFromSource === true) ||
            terminalMatches.length !== 1) throw new Error("UTILITY_EXTENSION_SOURCE_NETWORK_REACHABILITY_UNPROVEN");

          const targetPrefab = currentScope.targetSemantics.targetRoad.prefab;
          const targetRoadRead = record(await callTool("cs2_list_roads", { query: targetPrefab, limit: 500 }, signal));
          const targetRoads = Array.isArray(targetRoadRead.roads) ? targetRoadRead.roads.map(record) : null;
          if (!targetRoads || targetRoadRead.truncated === true || targetRoadRead.hasMore === true || targetRoadRead.complete === false) {
            throw new Error("UTILITY_EXTENSION_TARGET_ROAD_READBACK_INCOMPLETE");
          }
          const targetRows = targetRoads.filter((road) => {
            const entity = record(road.entity);
            return Number(entity.index) === currentScope.targetServiceEntry.road.index &&
              Number(entity.version) === currentScope.targetServiceEntry.road.version && road.prefab === targetPrefab;
          });
          if (targetRows.length !== 1) throw new Error("UTILITY_EXTENSION_TARGET_ROAD_NOT_UNIQUE");
          const targetRoad = targetRows[0]; const targetEntity = record(targetRoad.entity);
          const targetStart = record(targetRoad.start); const targetEnd = record(targetRoad.end);
          const targetRole = currentScope.targetSemantics.targetRoad.endpointRole.toUpperCase() as "START" | "END";
          const targetEndpointPosition = targetRole === "START" ? targetStart : targetEnd;
          const approvedContact = currentScope.targetSemantics.approvedContact;
          if (!close2(targetEndpointPosition, approvedContact.x, approvedContact.z) ||
            !Number.isInteger(Number(targetEntity.index)) || !Number.isInteger(Number(targetEntity.version))) {
            throw new Error("UTILITY_EXTENSION_TARGET_CONTACT_IDENTITY_MISMATCH");
          }
          const targetTopology = normalizeUtilityTopologyPayload(await callTool("cs2_utility_connectors", {
            index: binding.facility.entity.index, version: binding.facility.entity.version,
            connector: binding.connector.node, target: { index: Number(targetEntity.index), version: Number(targetEntity.version) },
            expectedWorldId: currentScope.worldId, expectedGeneration: currentScope.generation,
            expectedTopologyRevision: bridgeTopologyRevision({ generation: currentScope.generation,
              target: targetEntity as unknown as SpatialEntityRef }),
            admittedPrefab: targetPrefab,
            admittedStart: { x: Number(targetStart.x), z: Number(targetStart.z) },
            admittedEnd: { x: Number(targetEnd.x), z: Number(targetEnd.z) }, endpointTolerance: 0.25,
            envelope: currentScope.spatialEnvelope,
          }, signal));
          const targetBinding = record(targetTopology.binding);
          const targetNetwork = record(targetTopology.targetNetwork);
          const targetEndpoints = Array.isArray(targetNetwork.targetEndpoints) ? targetNetwork.targetEndpoints.map(record) : [];
          const endpointMatches = targetEndpoints.filter((endpoint) => {
            const p = record(endpoint.position);
            return String(endpoint.role ?? endpoint.endpointRole ?? "").toUpperCase() === targetRole &&
              close2(p, approvedContact.x, approvedContact.z) &&
              Number.isInteger(Number(record(endpoint.electricityFlowNode).index)) &&
              Number.isInteger(Number(record(endpoint.electricityFlowNode).version));
          });
          if ((targetTopology.bindingStatus ?? targetBinding.bindingStatus) !== "VALID" ||
            (targetTopology.complete ?? targetBinding.complete) !== true || targetTopology.truncated === true || endpointMatches.length !== 1) {
            throw new Error("UTILITY_EXTENSION_TARGET_ENDPOINT_UNPROVEN");
          }
          const sourceAnchor = { buildingPrefab: binding.facility.prefab,
            position: { x: binding.facility.position.x, y: Number(record(terminalMatches[0].position).y), z: binding.facility.position.z },
            connectorUtility: "ELECTRICITY" as const };
          const sourcePosition = record(terminalMatches[0].position);
          const targetPosition = record(endpointMatches[0].position);
          return {
            ...currentPlan,
            connection: { prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
              start: { x: Number(sourcePosition.x), z: Number(sourcePosition.z) },
              end: { x: Number(targetPosition.x), z: Number(targetPosition.z) } },
            connectionEndpointBindings: {
              start: { mode: "EXISTING_NET_NODE" as const, role: "START" as const, utility: "ELECTRICITY" as const,
                prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
                expectedPosition: { x: Number(sourcePosition.x), y: Number(sourcePosition.y), z: Number(sourcePosition.z) },
                bindingRule: "CURRENT_REACHABLE_CABLE_TERMINAL", topologyRole: "CONNECTED_UTILITY_CABLE_TERMINAL",
                topologyLookup: { networkEdgePrefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
                  edgeGeometry: { x1: Number(sourceStart.x), z1: Number(sourceStart.z), x2: Number(sourceEnd.x), z2: Number(sourceEnd.z) },
                  edgeEndpointRole: terminal.role, sourceAnchor, requireSourceReachability: true } },
              end: { mode: "EXISTING_NET_NODE" as const, role: "END" as const, utility: "ELECTRICITY" as const,
                prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
                expectedPosition: { x: Number(targetPosition.x), y: Number(targetPosition.y), z: Number(targetPosition.z) },
                bindingRule: "CERTIFIED_TARGET_ROAD_ELECTRICITY_NODE", topologyRole: "LOCAL_ROAD_ELECTRICITY_NODE",
                topologyLookup: { networkEdgePrefab: targetPrefab,
                  edgeGeometry: { x1: Number(targetStart.x), z1: Number(targetStart.z), x2: Number(targetEnd.x), z2: Number(targetEnd.z) },
                  edgeEndpointRole: targetRole, sourceAnchor, requireSourceReachability: false } },
            },
          };
        },
        plan: async (kind, currentScope) => {
          const planned = (await planScopedUtility(kind, currentScope, signal)).facility;
          if (!planned) throw new Error("GREENFIELD_UTILITY_PLAN_UNAVAILABLE");
          return planned;
        },
        execute: (request) => executeScopedUtility(request, signal),
        facilityAccessRoadEvidence: facilityAccessRoadEvidencePort,
        planFacilityAccessRoad: planFacilityAccessRoadPort,
        authorizedFacilityAccessRoadRepair: async ({ kind, scope: currentScope, currentPlanRevision, priorNetworkCommands }) => {
          if (kind !== "water" || !durability) return null;
          const active = durability.utilityBudgetAmendments().filter((entry) =>
            entry.projectId === currentScope.projectId && entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON &&
            entry.status === "ACTIVE");
          if (active.length !== 1) return null;
          const amendment = active[0];
          if (amendment.planRevision !== currentPlanRevision || amendment.authorizationWorldId !== currentScope.worldId ||
            amendment.authorizationGeneration !== currentScope.generation || amendment.executionUseLimit !== 1 ||
            amendment.executionUseStatus !== "UNUSED" ||
            amendment.purpose !== "Pump native road attachment repair" || !amendment.courseFingerprint ||
            !amendment.repairLineage || !Array.isArray(amendment.segmentQuotes) || amendment.segmentQuotes.length !== 1 ||
            amendment.nativeQuote !== amendment.segmentQuotes.reduce((sum, quote) => sum + quote, 0)) return null;
          let actions: MayorAction[];
          try { actions = JSON.parse(amendment.courseFingerprint) as MayorAction[]; }
          catch { return null; }
          if (!Array.isArray(actions) || actions.length !== 1 || JSON.stringify(actions) !== amendment.courseFingerprint ||
            actions.some((action) => action.type !== "build_road" || action.prefab !== FACILITY_ACCESS_ROAD_PREFAB)) return null;
          const priorSmallRoadCommands = priorNetworkCommands.filter((command) => {
            try {
              const priorActions = JSON.parse(command.exactInput ?? "[]") as MayorAction[];
              return Array.isArray(priorActions) && priorActions.some((action) => action.type === "build_road" && action.prefab === FACILITY_ACCESS_ROAD_PREFAB);
            } catch { return false; }
          });
          if (priorSmallRoadCommands.length < 1 || priorSmallRoadCommands.some((command) => {
            if (command.status === "OBSERVED_MATCH") return false;
            if (command.status !== "REJECTED") return true;
            const observations = durability.worldObservations(command.commandId);
            const latest = observations.at(-1);
            if (!latest || latest.currentWorldEffectPresent || latest.worldId !== currentScope.worldId) return true;
            try {
              const evidence = JSON.parse(latest.evidence) as Record<string, unknown>;
              return evidence.classification !== "EFFECT_ABSENT_DUE_TO_USER_ROLLBACK";
            } catch { return true; }
          })) return null;
          // The ordinal is rehydrated, never re-derived: it belongs to the
          // amendment that was already minted, and a resumed attempt has to run
          // as the attempt it was authorized as. An amendment whose ordinal
          // cannot be read is not rehydrated at all.
          const attemptIndex = amendment.repairAttemptIndex ??
            facilityAccessRoadRepairAttemptIndexFromLineage(amendment.repairLineage);
          if (attemptIndex === null || !Number.isInteger(attemptIndex) || attemptIndex <= 0) return null;
          return {
            amendmentId: amendment.amendmentId,
            repairLineage: amendment.repairLineage,
            attemptIndex,
            planRevision: amendment.planRevision,
            courseFingerprint: amendment.courseFingerprint,
            actions,
            quote: amendment.nativeQuote,
            segmentQuotes: [...amendment.segmentQuotes],
            worldId: amendment.authorizationWorldId,
            generation: amendment.authorizationGeneration,
          };
        },
        afterKindCertified: options.afterUtilityKindCertified,
        inspectNetworkCommands: async ({ scope: currentScope, state }) => {
          const records = commandJournal.list().flatMap((candidate) => {
            if (candidate.actionFamily === "ROAD" && candidate.authorizedScope.actionFamily === "ROAD" &&
              candidate.authorizedScope.owner.ownerType === "PROJECT" && candidate.authorizedScope.owner.ownerId === currentScope.projectId &&
              candidate.authorizedScope.facilityAccessRoadRepair) {
              try {
                const road = JSON.parse(candidate.authorizedScope.exactInput) as Record<string, unknown>;
                if (road.prefab !== FACILITY_ACCESS_ROAD_PREFAB || ![road.x1, road.z1, road.x2, road.z2].every(Number.isFinite)) return [];
                // Read back as the whole course the command was authorized as,
                // control point included: a repair authorized as a curve must not be
                // re-read as its chord when it is compared against the course
                // fingerprint of the amendment that authorized it.
                const action: MayorAction = { type: "build_road", prefab: FACILITY_ACCESS_ROAD_PREFAB,
                  x1: Number(road.x1), z1: Number(road.z1), x2: Number(road.x2), z2: Number(road.z2),
                  ...(road.cx !== undefined || road.cz !== undefined ? { cx: Number(road.cx), cz: Number(road.cz) } : {}) };
                return [{ ...candidate, logicalExactInput: JSON.stringify([action]) }];
              } catch { return []; }
            }
            if (candidate.actionFamily !== "UTILITY" || candidate.authorizedScope.actionFamily !== "UTILITY" ||
              !utilityCommandMatchesPlacementScope({ command: candidate, kind: state.kind, scope: currentScope,
                currentPlacementScopeId: state.placementScopeId, currentCandidates: state.candidateLedger })) return [];
            try {
              const actions = JSON.parse(candidate.authorizedScope.exactInput) as MayorAction[];
              return Array.isArray(actions) && actions.length > 0 && actions.every((action) => action.type === "build_road")
                ? [{ ...candidate, logicalExactInput: candidate.authorizedScope.exactInput }] : [];
            } catch { return []; }
          });
          return {
            commandIds: records.map((record) => record.commandId),
            uncertain: records.some((record) => ["CREATED", "AUTHORIZED", "SUBMITTED", "NATIVE_COMPLETED", "NATIVE_COMPLETION_UNKNOWN",
              "COMMIT_ACK", "UNKNOWN_TIMEOUT", "UNKNOWN_TRANSPORT"].includes(record.status)),
            authoritativeEffect: records.some((record) => record.status === "OBSERVED_MATCH"),
            commands: records.map((record) => ({ commandId: record.commandId, status: record.status, exactInput: record.logicalExactInput })),
          };
        },
        progress: async ({ prior }) => {
          try {
            if (!prior) {
              // Before advancing time, clear anything that would immediately
              // pause the world again — a milestone popup does exactly that, and
              // without this the submission below is a no-op that reports
              // `simulation paused before target frame` on every tick.
              const modal = await blockingModal.check(signal);
              if (!modal.allowedToContinue) throw new Error(`blocking_modal_guard:${modal.modalClass}`);
              const before = record(await callTool("cs2_game_state", {}, signal));
              const startFrame = Number(record(before.simulation).frameIndex);
              const submitted = record(await callTool("cs2_run_simulation", { hours: 0.5, speed: 4 }, signal));
              const targetFrame = Number(submitted.targetFrame);
              if (![startFrame, targetFrame].every(Number.isFinite) || targetFrame <= startFrame) {
                await callTool("cs2_run_simulation", { cancel: true }, signal);
                return { status: "UNKNOWN" as const, startFrame, targetFrame, currentFrame: startFrame,
                  paused: null, reason: "simulation target acknowledgement is malformed" };
              }
              return { status: "WAITING_FOR_SERVICE_UPDATE" as const, startFrame, targetFrame, currentFrame: startFrame,
                paused: record(before.simulation).paused as boolean | null, reason: "simulation target submitted; completion not yet observed" };
            }
            const game = record(await callTool("cs2_game_state", {}, signal));
            const simulation = record(game.simulation);
            const currentFrame = Number(simulation.frameIndex);
            if (Number.isFinite(currentFrame) && currentFrame >= prior.targetFrame) {
              if (simulation.paused !== true) await callTool("cs2_run_simulation", { cancel: true }, signal);
              return { status: "TARGET_REACHED" as const, ...prior, currentFrame, paused: true, reason: "authoritative target frame reached" };
            }
            if (simulation.paused === true || prior.checks >= prior.maximumChecks) {
              await callTool("cs2_run_simulation", { cancel: true }, signal);
              return { status: "UNKNOWN" as const, ...prior, currentFrame, paused: true,
                reason: simulation.paused === true ? "simulation paused before target frame" : "bounded service-update progression exhausted" };
            }
            return { status: "WAITING_FOR_SERVICE_UPDATE" as const, ...prior, currentFrame,
              paused: false, reason: "target frame has not been reached" };
          } catch (error) {
            try { await callTool("cs2_run_simulation", { cancel: true }, signal); } catch { /* fail closed below */ }
            throw error;
          }
        },
      } });
    },
  };
  // The production Project Admission Bootstrap seam. It reads the authoritative
  // world, derives Identity from durable lineage, and commits the first durable
  // Gate 1 state. It is the only production caller of the Gate 1 planner.
  // Read once and used twice: the admission observation port publishes it, and
  // the goal-scoped water/sewage site constraint needs the SAME catalogue to
  // decide which roads its access corridor may start from. Two reads would be two
  // answers to one question, and the corridor's is the one that decides where a
  // road is built.
  const readAvailableRoadPrefabs = async (signal?: AbortSignal): Promise<readonly string[]> => {
    const snapshot = record(await callTool("cs2_mayor_snapshot", {}, signal));
    const prefabs = record(snapshot.planningCatalog).roadPrefabs;
    return Array.isArray(prefabs) ? prefabs.filter((value): value is string => typeof value === "string") : [];
  };
  const projectAdmission = durability
    ? createV2ProjectAdmissionBootstrap({
        durability,
        activateDurableWorld: ensureDurableWorld,
        observation: {
          scanWorld: async (signal) => {
            const scan = parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal));
            return { ...buildSpatialWorldModel(scan), bootstrapAssets: scan.bootstrapAssets };
          },
          captureSiteDetail: async (request, signal) => {
            // Only the detail is read back out of this envelope. The snapshot and
            // the road-graph scan a full capture takes are declined: admission
            // already holds the world it scanned once, and this runs once per
            // site anchor.
            const envelope = await observation.capture({ spatialDetail: request, globalSources: [], signal });
            const detail = envelope.sources.spatialDetail;
            return {
              detail: detail.status === "AVAILABLE" && detail.data ? detail.data : null,
              coherence: envelope.coherence,
              observationId: envelope.observationId,
            };
          },
          readAvailableRoadPrefabs,
          readTreasury: async (signal) => {
            const overview = record(await callTool("cs2_city_overview", {}, signal));
            const treasury = Number(overview.treasury);
            if (!Number.isFinite(treasury)) throw new Error("PROJECT_ADMISSION_TREASURY_UNKNOWN");
            return treasury;
          },
        },
        // The same bounded native preview the Gate 1 Road step previews against,
        // so admission can refuse land the game will not build on instead of
        // admitting a Goal whose Road step can only die there.
        previewRoad: (input, signal) =>
          callTool("cs2_spatial", { mode: "preflight", kind: "net", ...input }, signal),
        siteConstraintForGoal: async ({ goalId, world, bootstrapAssets }, signal) => {
          // Both piped utilities whose source is a place need this gate. Sewage
          // was admitted without one, so a reservation can be created over
          // terrain that contains no shoreline at all and every K05 attempt
          // inside it is guaranteed to fail — which is exactly what the live
          // world showed (`rawShore=0`). The constraint is the one place that
          // decides whether a candidate reservation can host the facility, so
          // both kinds run through it.
          const utilityKind = /water/i.test(goalId) ? "water" as const
            : /sewage/i.test(goalId) ? "sewage" as const : null;
          if (!utilityKind) return null;
          // A sewage reservation has to be able to host an outfall whose
          // discharge the recipe can actually certify, not merely one the game
          // will place. Water's own source filter is its applicability
          // condition, so it needs no second one.
          const sewageEnvironmentalSafety = utilityKind === "sewage"
            ? { observation: await readWaterFlowObservation(signal),
                intakeCensus: await readWaterIntakeCensus(bootstrapAssets, signal) }
            : undefined;
          return createWaterSiteConstraint({
            utilityKind,
            ...(sewageEnvironmentalSafety ? { sewageEnvironmentalSafety } : {}),
            world,
            assets: [...bootstrapAssets],
            roads: world.roadGraph.edges,
            availableRoadPrefabs: await readAvailableRoadPrefabs(signal),
            readReservation: async (point, radius, readSignal, readResolution) => {
              // A reservation recheck walks candidate points and reads back only
              // this point's grid, so it declines the snapshot and the scan.
              const envelope = await observation.capture({ spatialDetail: {
                x: point.x, z: point.z, radius: Math.max(64, radius),
                // A reader that needs a finer grid than the admission policy's
                // asks for it; everything else keeps the policy's resolution.
                resolution: readResolution ?? V2_PROJECT_ADMISSION_POLICY.siteObservationResolution,
              }, globalSources: [], signal: readSignal ?? signal });
              const source = envelope.sources.spatialDetail;
              return envelope.coherence !== "UNKNOWN" && source.status === "AVAILABLE" ? source.data ?? null : null;
            },
            probePlacement: async (placement, probeSignal) => {
              const preview = await constructionPreflightPreview({
                type: "place_building", prefab: placement.prefab,
                x: placement.position.x, z: placement.position.z, rotation: placement.rotation,
              }, probeSignal ?? signal);
              return preview.valid === true && preview.previewOnly === true;
            },
            quoteConnectionCost: async (connection, quoteSignal) => {
              const preview = await constructionPreflightPreview({
                type: "build_road", prefab: connection.prefab,
                x1: connection.start.x, z1: connection.start.z,
                x2: connection.end.x, z2: connection.end.z,
              }, quoteSignal ?? signal);
              if (preview.valid !== true || preview.previewOnly !== true) throw new Error("WATER_CONNECTION_NATIVE_QUOTE_UNAVAILABLE");
              const quote = readNativeUtilityQuote(preview, Number.NaN);
              if (!Number.isFinite(quote)) throw new Error("WATER_CONNECTION_NATIVE_QUOTE_UNKNOWN");
              return quote;
            },
          });
        },
        ...(options.projectSiteConstraint ? { siteConstraint: options.projectSiteConstraint } : {}),
        now: options.now,
      })
    : undefined;
  const submit = async (intent: ZoningIntent, signal?: AbortSignal): Promise<NativeZoningSubmission> => {
    let value: unknown;
    try {
      worldState.markDirty("ZONING");
      value = await callTool(
        "cs2_mayor_execute_actions",
        {
          actions: [
            {
              type: "zone",
              zone: intent.nativeZone,
              x: intent.spatialEnvelope.center.x,
              z: intent.spatialEnvelope.center.z,
              radius: intent.spatialEnvelope.radius,
              force: false,
            },
          ],
        },
        signal,
      );
    } catch (error) {
      if (timeoutLike(error)) throw new V2SubmissionTimeoutError(error instanceof Error ? error.message : String(error));
      throw error;
    }
    const batch = record(value);
    const results = Array.isArray(batch.results) ? batch.results.map(record) : [];
    const first = results[0] ?? {};
    if (batch.ok === true && first.ok === true) {
      return { kind: "COMMIT_ACK", summary: String(first.summary ?? "native zoning commit acknowledged"), raw: value };
    }
    if (first.ok === false || batch.ok === false) {
      return {
        kind: "REJECTED",
        reason: String(first.error ?? first.summary ?? "native zoning rejected"),
        raw: value,
      };
    }
    throw new Error("native zoning response had no definite commit acknowledgement or rejection");
  };
  const baseZoning = createV2ZoningKernel({
    observation,
    journal: commandJournal,
    submit,
    now: options.now,
    createId: options.createId,
  });
  const zoning: V2ZoningKernel = durability
    ? {
        execute: async (intent, baseline, signal) => {
          await requireActivatedDurableWorld(signal);
          return baseZoning.execute(intent, baseline, signal);
        },
        reconcile: async (commandId, signal) => {
          await requireActivatedDurableWorld(signal);
          return baseZoning.reconcile(commandId, signal);
        },
      }
    : baseZoning;
  /**
   * Place the first public-service building the city is owed (one per call).
   *
   * Same path as a utility facility, end to end: durable activation (which reconciles any open command first), a
   * native object preflight to choose a legal site, one journaled `place_building` command under
   * `actionFamily: "UTILITY"` / `utilityKind: "civic"` (CREATED -> AUTHORIZED -> SUBMITTED before the native call),
   * `cs2_mayor_execute_actions`, and the restart reconciler's prefab-at-position census as the readback. Identity is
   * the admitted Gate 1 project's own; nothing is minted here.
   */
  const provideCivicService = durability ? async (signal?: AbortSignal): Promise<CivicServiceOutcome> => {
    const activation = await requireActivatedDurableWorld(signal);
    const project = durability.projectState();
    if (project.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) return { status: "SKIPPED", reason: "CIVIC_NO_ADMITTED_PROJECT" };
    // Every civic building is recurring upkeep; add one only when the treasury can carry it.
    const budget = record(await callTool("cs2_budget", {}, signal));
    const overview = record(await callTool("cs2_city_overview", {}, signal));
    if (!civicIsAffordable(Number(overview.treasury), Number(budget.balance))) {
      return { status: "SKIPPED", reason: `CIVIC_UNAFFORDABLE:treasury=${overview.treasury},monthlyBalance=${budget.balance}` };
    }
    const series = record(await callTool("cs2_statistics", { type: "Population", samples: 1 }, signal));
    const population = Number.isFinite(Number(series.current)) ? Number(series.current) : null;
    const listed = record(await callTool("cs2_list_buildings", { limit: 500 }, signal));
    const buildings = (Array.isArray(listed.buildings) ? listed.buildings : []).map(record);
    const owedByPopulation = civicServicesOwed({ population, existingPrefabs: buildings.map((item) => String(item.prefab ?? "")) });
    // A service is placed when a citizen is waiting for it (an icon), not because the population has reached a number. If
    // the icons cannot be read at all, the population threshold alone stands, as it did before this evidence existed.
    let owed = owedByPopulation;
    try {
      const counts = record(record(await callTool("cs2_notifications", { limit: 1 }, signal)).countsByType);
      owed = civicServicesWithEvidence(owedByPopulation, Object.fromEntries(Object.entries(counts).map(([type, count]) => [type, Number(count)])));
    } catch { /* icons unreadable */ }
    if (owed.length === 0) return { status: "NOTHING_OWED", population };
    const catalogue = record(record(record(await callTool("cs2_mayor_snapshot", {}, signal)).planningCatalog).buildingPrefabs);
    const residential = buildings.filter((item) => /Residential/i.test(String(item.prefab ?? "")))
      .map((item) => record(item.position)).filter((position) => Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z)))
      .map((position) => ({ x: Number(position.x), z: Number(position.z) }));
    if (residential.length === 0) return { status: "SKIPPED", reason: "CIVIC_NO_RESIDENTS_TO_SERVE", population };
    const centroid = { x: residential.reduce((sum, p) => sum + p.x, 0) / residential.length,
      z: residential.reduce((sum, p) => sum + p.z, 0) / residential.length };
    // Serve where people live: the home nearest the residential centroid, not the centroid itself (which can fall
    // between two separate districts).
    const target = residential.reduce((best, p) =>
      Math.hypot(p.x - centroid.x, p.z - centroid.z) < Math.hypot(best.x - centroid.x, best.z - centroid.z) ? p : best);
    const scan = parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal));
    const refusals: string[] = [];
    for (const kind of owed) {
      const unlocked = (Array.isArray(catalogue[kind]) ? catalogue[kind] as unknown[] : [])
        .filter((name): name is string => typeof name === "string");
      const prefab = civicPrefabFor(kind, unlocked);
      if (!prefab) { refusals.push(`${kind}:NO_UNLOCKED_PREFAB`); continue; }
      const candidates = civicSiteCandidates({ target, edges: scan.roadGraph.edges, setbacksMeters: CIVIC_SETBACKS_METERS });
      const preflightRefusals: Record<string, number> = {};
      let nativeRejections = 0;
      // The object preflight is not the placement: native refused sites the preflight called valid (measured live
      // 2026-10-03, "blocked by game validation"). A deterministic native refusal is journaled as REJECTED and the
      // next preflight-valid site is tried, bounded; only an unknown transport outcome stops the call.
      for (const candidate of candidates) {
        if (nativeRejections >= CIVIC_MAXIMUM_NATIVE_REJECTIONS) break;
        const probe = { type: "place_building" as const, prefab, x: candidate.position.x, z: candidate.position.z,
          rotation: candidate.rotation };
        // An invalid position makes the object preflight THROW a 409 ("blocked by game validation"), it does not
        // return `valid:false`. Measured live (2026-10-03): the first refused site aborted the whole call, so no
        // civic command was ever journaled and no later site was ever tried.
        let answer: Record<string, unknown>;
        try {
          answer = await constructionPreflightPreview(probe, signal);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (!/blocked by game validation|rejected|invalid/i.test(text)) throw error;
          answer = { valid: false, previewOnly: true, reason: text };
        }
        if (!(answer.valid === true && answer.previewOnly === true)) {
          const reason = typeof answer.reason === "string" ? answer.reason.slice(0, 60) : "INVALID";
          preflightRefusals[reason] = (preflightRefusals[reason] ?? 0) + 1;
          continue;
        }
        const site = candidate;
        const preview: Record<string, unknown> = answer;
      const action: MayorAction = { type: "place_building", prefab, x: site.position.x, z: site.position.z, rotation: site.rotation };
      const exactInput = JSON.stringify([action]);
      const cost = Number(preview.cost ?? preview.constructionCost ?? preview.signedAmount ?? Number.NaN);
      const treasury = Number(record(await callTool("cs2_city_overview", {}, signal)).treasury);
      const maximumSpend = Number.isFinite(cost) ? Math.max(1, cost) * 1.25 : Math.max(1, treasury * 0.1);
      if (Number.isFinite(treasury) && Number.isFinite(cost) && cost > treasury * 0.5) {
        refusals.push(`${kind}:${prefab}:FINANCE:${cost}>${treasury}/2`); continue;
      }
      const at = (options.now ?? (() => new Date()))().toISOString();
      const commandId = (options.createId ?? (() => crypto.randomUUID()))();
      const command: V2CommandRecord = {
        schemaVersion: "ai-mayor-v2-command/1", commandId, actionFamily: "UTILITY", actionType: "place_building",
        authorizedScope: {
          owner: { ownerType: "PROJECT", ownerId: project.project.id }, actionFamily: "UTILITY", utilityKind: "civic",
          projectId: project.project.id, trancheId: project.tranche.id, reservationRef: project.tranche.reservationRef,
          placementScopeId: `civic:${kind}`,
          worldEpochId: activation.world.worldEpochId, generation: activation.world.generation,
          topologyRevision: "civic:no-network", executionMechanismRevision: "civic-place-building-v1",
          certifiedRoadRefs: [], exactInput, spatialEnvelope: { center: { ...site.position }, radius: 64 },
          budget: { authorizedMaxSpend: maximumSpend, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        },
        createdAt: at, submittedAt: null, nativeResultSummary: null, status: "CREATED",
        statusHistory: [{ status: "CREATED", at }], reconciliationStatus: "NOT_STARTED",
        observationEvidence: [], failureOrUnknownReason: null, effectAbsenceProven: false,
      };
      durability.assertMutationAllowed(commandIdempotencyKey(command));
      commandJournal.create(command);
      commandJournal.update(commandId, (current) => ({ ...current, status: "AUTHORIZED", statusHistory: [...current.statusHistory, { status: "AUTHORIZED", at }] }));
      commandJournal.update(commandId, (current) => ({ ...current, status: "SUBMITTED", submittedAt: at, statusHistory: [...current.statusHistory, { status: "SUBMITTED", at }] }));
      worldState.markUtilityDirty();
      let nativeRefused = false;
      try {
        const result = await callTool("cs2_mayor_execute_actions", { actions: [action] }, signal) as MayorBatchResult;
        await waitForNativeIdle(signal);
        nativeRefused = !result.ok;
        commandJournal.update(commandId, (current) => ({ ...current,
          status: result.ok ? "NATIVE_COMPLETED" : "REJECTED",
          nativeResultSummary: `civic placement bridgeOk=${result.ok}; worldEffects=UNOBSERVED`,
          failureOrUnknownReason: result.ok ? null : "native civic placement rejected",
          statusHistory: [...current.statusHistory, { status: result.ok ? "NATIVE_COMPLETED" : "REJECTED", at }] }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // "Blocked by game validation" is native saying no before anything exists: a proven refusal, not an unknown.
        if (/blocked by game validation|rejected/i.test(reason)) {
          nativeRefused = true;
          commandJournal.update(commandId, (current) => ({ ...current, status: "REJECTED", failureOrUnknownReason: reason.slice(0, 200),
            nativeResultSummary: "civic placement refused by game validation; nothing was created",
            statusHistory: [...current.statusHistory, { status: "REJECTED", at }] }));
        } else {
          commandJournal.update(commandId, (current) => ({ ...current, status: "UNKNOWN_TRANSPORT", failureOrUnknownReason: reason,
            statusHistory: [...current.statusHistory, { status: "UNKNOWN_TRANSPORT", at }] }));
          throw error;
        }
      }
      if (nativeRefused) {
        nativeRejections += 1;
        refusals.push(`${kind}:${prefab}:NATIVE_REFUSED@${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}`);
        continue;
      }
      // The readback is the restart reconciler's own: a complete prefab census at the exact position.
      const pending = durability.reconciliationRequired().find((entry) => entry.record.commandId === commandId);
      let verdict: RestartReconciliationResult["result"] | "NOT_PENDING" = "NOT_PENDING";
      if (pending) {
        const reconciled = await reconcileDurableCommand(pending, signal);
        durability.reconcile(commandId, reconciled);
        verdict = reconciled.result;
      }
      return { status: "PLACED", kind, prefab, position: site.position, rotation: site.rotation, setbackMeters: site.setbackMeters,
        commandId, verdict, population, refusals };
      }
      if (Object.keys(preflightRefusals).length > 0 || nativeRejections === 0) {
        refusals.push(`${kind}:${prefab}:NO_LEGAL_SITE:${JSON.stringify(preflightRefusals)}`);
      }
    }
    return { status: "NO_PLACEMENT", population, refusals };
  } : undefined;
  /**
   * Raise tax rates one bounded step when the runway is short (see `solvency.ts`). Idempotent: it changes a rate only
   * while it is below the ceiling, and does nothing while the runway is healthy. A tax rate is a city setting, not a
   * structure in the world, so it needs no durable command; every change is returned for the caller to report.
   */
  const ensureSolvency = async (signal?: AbortSignal): Promise<Array<{ area: string; rate: number }>> => {
    const budget = record(await callTool("cs2_budget", {}, signal));
    const overview = record(await callTool("cs2_city_overview", {}, signal));
    const taxes = record(record(await callTool("cs2_get_taxes", {}, signal)).taxRates);
    const rates: Partial<Record<TaxArea, number>> = {};
    for (const area of SOLVENCY_TAX_AREAS) {
      const rate = Number(record(taxes[area]).rate);
      if (Number.isFinite(rate)) rates[area] = rate;
    }
    const plan = solvencyTaxPlan({ treasury: Number(overview.treasury), monthlyBalance: Number(budget.balance), rates });
    for (const change of plan) await callTool("cs2_set_tax", { area: change.area, rate: change.rate }, signal);
    // The second lever: service budgets. Capacity placed far ahead of need costs upkeep at full strength for nothing.
    const budgets = record(await callTool("cs2_service_budgets", {}, signal));
    const services = (Array.isArray(budgets.services) ? budgets.services : []).map(record)
      .filter((service) => typeof service.name === "string")
      .map((service) => ({ name: String(service.name), budgetPercent: Number(service.budgetPercent),
        estimatedUpkeep: Number(service.estimatedUpkeep) }))
      .filter((service) => Number.isFinite(service.budgetPercent) && Number.isFinite(service.estimatedUpkeep));
    const budgetPlan = solvencyBudgetPlan({ treasury: Number(overview.treasury), monthlyBalance: Number(budget.balance), services });
    for (const change of budgetPlan) await callTool("cs2_set_service_budget", { service: change.service, percentage: change.percentage }, signal);
    return [...plan, ...budgetPlan.map((change) => ({ area: `budget:${change.service}`, rate: change.percentage }))];
  };
  return {
    worldState,
    observation,
    sewageEnvironmentalObservation: async (signal?: AbortSignal) => {
      const flow = await readWaterFlowObservation(signal);
      if (!flow.available) {
        return { available: false, missingObservation: SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION,
          detail: "cs2_terrain did not carry a complete surface-water grid" };
      }
      // The census needs a catalogue to know which prefabs are intakes, and the
      // catalogue costs a whole spatial scan. Once the census is known there is
      // nothing left to scan for, so this path never asks twice — the Brain
      // reaches it on every sewage admission attempt, and re-scanning the world
      // there would put an avoidable full read in front of every simulation.
      let census: SewageIntakeCensus;
      if (waterIntakeCensus) {
        census = waterIntakeCensus;
      } else {
        try {
          const scanForIntakes = parseSpatialBootstrapScan(
            await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal),
          );
          census = await readWaterIntakeCensus(scanForIntakes.bootstrapAssets, signal);
        } catch (error) {
          census = { available: false, intakes: [] };
          void error;
        }
      }
      if (!census.available) {
        return { available: false, missingObservation: SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION,
          detail: "the authoritative water-intake listing was incomplete" };
      }
      return { available: true, detail: `waterIntakes=${census.intakes.length}` };
    },
    commandJournal,
    zoning,
    utilityService,
    targetAccess,
    routeQuery,
    readBuildingResidents,
    road,
    greenfieldUtilityBootstrap,
    durability,
    ...(durability
      ? {
          activateDurableWorld: ensureDurableWorld,
          observeCurrentWorldCommandEffect: async (commandId: string, signal?: AbortSignal) => {
            const commands = durability.commandJournal.list();
            const command = commands.find((entry) => entry.commandId === commandId);
            if (!command) throw new Error(`no durable command ${commandId} exists in the journal`);
            const effect = await observeCommandEffectInCurrentWorld(command, signal);
            const observation = durability.recordCurrentWorldObservation({
              commandId,
              currentWorldEffectPresent: effect.verdict === "EFFECT_PRESENT" ? true : effect.verdict === "EFFECT_ABSENT" ? false : null,
              currentWorldObjectiveSatisfied: effect.objectiveSatisfied,
              evidence: effect.evidence,
            });
            return { effect, observation };
          },
        }
      : {}),
    ...(projectAdmission ? { projectAdmission } : {}),
    ...(provideCivicService ? { civicServices: { provide: provideCivicService } } : {}),
    solvency: { ensure: ensureSolvency },
  };
}
