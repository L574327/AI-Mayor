import { facilityPlacementClearance } from "./v2/facility-placement-clearance";
import type { PlannedRoadSegment, PlannedUtilityFacility, PlannedUtilityConnection, SpatialEntityRef, SpatialPoint2 } from "./spatial/types";
import { MAX_UTILITY_CONNECTION_SEGMENT_LENGTH, splitUtilityConnection } from "./spatial/utility-planner";
import type { MayorAction, MayorBatchResult } from "./types";

export type UtilityRecoveryKind = "electricity" | "water" | "sewage";
export type UtilityActionKind = "FACILITY_REPAIR" | "NETWORK_LINK_REPAIR";
export type UtilityConnectionPrimitive = "service-road" | "direct-cable" | "facility-access-road";
export type UtilityPlanningMode = "GREENFIELD_PLACEMENT" | "EXISTING_FACILITY_CONNECTION";
export type UtilityRecoveryStage =
  | "planning"
  | "facility_ready"
  | "facility_placed"
  | "connector_discovered"
  | "connector_connected"
  | "verifying"
  | "resolved"
  | "improving"
  | "blocked";

export function plannedRoadSegmentToMayorAction(
  road: PlannedRoadSegment,
  prefab = "Small Road",
): Extract<MayorAction, { type: "build_road" }> {
  return {
    type: "build_road",
    prefab,
    x1: road.start.x,
    z1: road.start.z,
    x2: road.end.x,
    z2: road.end.z,
  };
}

export interface UtilityEntityRef {
  index: number;
  version: number;
}

export interface UtilityPlacementReceipt {
  entity: UtilityEntityRef;
  prefab: string;
  position: SpatialPoint2 & { y?: number };
}

export interface UtilityConnectorReadback {
  type: "electricity" | "waterPipe";
  node: UtilityEntityRef;
  worldPosition: SpatialPoint2;
  attached: boolean;
  orphan?: boolean;
  capacity: { electricity?: number; fresh?: number; sewage?: number };
  connectedEdges?: Array<{ entity: UtilityEntityRef; owner: UtilityEntityRef | null; prefab: string | null }>;
}

export interface UtilityCapacityReadback {
  revision: string | null;
  capacity: number | null;
  consumption: number | null;
  fulfilledConsumption: number | null;
  issueActive: boolean;
  /** Whether the native utility snapshot is known to be post-load settled. */
  freshness?: "SETTLED" | "UNSETTLED" | "UNKNOWN";
}

export interface UtilityPreflightResult {
  valid: boolean;
  reason?: string;
  native?: UtilityPreflightEvidence;
  /**
   * Which gate produced a rejection. Preflight only becomes a verdict on the
   * proposed course once native validation actually ran. A rejection raised
   * before that (an unresolved or stale live binding, a thrown transport
   * error) never reached a verdict, so it must stay re-validatable instead of
   * terminating the primitive that was never validated.
   */
  rejectionKind?: "PRECONDITION" | "NATIVE";
}

export interface UtilityPreflightEvidence {
  status?: number;
  commandId?: string;
  bridgeCommandId?: string;
  nativeRoadDiagnostics?: unknown;
  bridgeHttpErrorDiagnostics?: unknown;
  mcpBridgeFailureDiagnostics?: unknown;
  nativeToolErrors?: unknown;
  validation?: unknown;
  structural?: unknown;
  diagnostics?: unknown;
  rejectionDiagnostics?: unknown;
  exceptionType?: string;
  exceptionMessage?: string;
  [key: string]: unknown;
}

export interface UtilityConnectionDiagnostic extends UtilityPreflightResult {
  candidate: "service-road" | "direct-cable" | "facility-access-road";
  actionCount: number;
  action?: MayorAction;
  actionIndex?: number;
}

export interface UtilityPreflightDiagnostic {
  candidate: "service-road" | "direct-cable" | "facility-access-road";
  actionCount: number;
  action?: MayorAction;
  actionIndex?: number;
  validationCode?: string;
  failedCondition?: string;
  preflightResult?: Record<string, unknown>;
  error?: string;
  errorType?: string;
  native?: Record<string, unknown>;
  projectedGeometricContactResidual?: number | null;
}

export interface UtilityRecoveryPlanResult {
  status: "candidate" | "no_action_needed" | "no_safe_site" | "unsupported" | "blocked";
  facility?: PlannedUtilityFacility;
  connection?: UtilityConnectionPlan;
  reason: string;
  diagnostics?: Record<string, unknown>;
}

export interface UtilityConnectionPlan {
  mode: "EXISTING_FACILITY_CONNECTION";
  kind: UtilityRecoveryKind;
  facility: UtilityPlacementReceipt;
  connection: PlannedUtilityConnection;
  /** Topology-bound source/target terminals for post-connection network repair. */
  connectionEndpointBindings?: PlannedUtilityFacility["connectionEndpointBindings"];
  /** Fresh facility-side access target, derived from the current facility and road topology. */
  serviceRoads?: PlannedRoadSegment[];
  /** True only when the current scoped planner accepted every route segment natively. */
  serviceRoadsNativePreflighted?: boolean;
  /** True only when the bounded planner accepted every direct cable segment natively. */
  directCableNativePreflighted?: boolean;
  /** Current-world road refs backed by this tranche's observed utility-road commands. */
  authoritativeRoadRefs?: SpatialEntityRef[];
}

export interface UtilityCurrentBinding {
  facility: UtilityPlacementReceipt;
  connector: UtilityConnectorReadback;
}

export type UtilityCurrentBindingResult =
  | { status: "MATCH"; binding: UtilityCurrentBinding }
  | { status: "BLOCKED"; reason: string; diagnostics?: Record<string, unknown> };

export type UtilityPlanningContext =
  | { mode: "GREENFIELD_PLACEMENT" }
  | { mode: "EXISTING_FACILITY_CONNECTION"; binding: UtilityCurrentBinding };

const preflightAccepted = (result: boolean | UtilityPreflightResult) =>
  typeof result === "boolean" ? result : result.valid;

export interface UtilityPlacementContext {
  /** Road edges a service connection could attach to, near the candidate. */
  roads: ReadonlyArray<{ start: SpatialPoint2; end: SpatialPoint2 }>;
  /** Same-purpose facilities already placed, with the radius they occupy. */
  existingFacilities: ReadonlyArray<{ position: SpatialPoint2; footprintRadiusMeters: number }>;
}

export interface SharedUtilityRecoveryPorts {
  plan(kind: UtilityRecoveryKind, context?: UtilityPlanningContext): Promise<UtilityRecoveryPlanResult>;
  preflight(action: MayorAction): Promise<boolean | UtilityPreflightResult>;
  execute(actions: MayorAction[]): Promise<MayorBatchResult>;
  readConnectors(entity: UtilityEntityRef): Promise<UtilityConnectorReadback[]>;
  readCapacity(kind: UtilityRecoveryKind): Promise<UtilityCapacityReadback>;
  settle(): Promise<void>;
  currentRevision(): Promise<string | null>;
  /** Existing same-purpose facility, if any. Prevents blind duplicate placement. */
  findExistingFacility?(
    kind: UtilityRecoveryKind,
    planned: PlannedUtilityFacility,
  ): Promise<UtilityPlacementReceipt | undefined>;
  findCurrentUtilityBinding?(kind: UtilityRecoveryKind): Promise<UtilityCurrentBindingResult>;
  /**
   * Roads and already-placed same-purpose facilities around a candidate position.
   *
   * Optional on purpose: a caller that does not supply it gets today's behaviour
   * exactly. When it IS supplied, the placement loop additionally refuses a
   * position the game would accept but no service connection could ever reach —
   * the measured 2026-10-02 failure, where two pumping stations were placed on a
   * dead end 49 m and 106 m from any road and neither ever connected. The native
   * object preflight stays the authority on legality; this only asks whether the
   * position can WORK, before the attempt is spent on it.
   */
  readPlacementContext?(position: SpatialPoint2): Promise<UtilityPlacementContext | undefined>;
}

export type SharedUtilityPreparationPorts = Omit<SharedUtilityRecoveryPorts, "execute" | "settle"> & {
  execute?: SharedUtilityRecoveryPorts["execute"];
};

export interface UtilityRecoveryResult {
  ok: boolean;
  kind: UtilityRecoveryKind;
  stage: UtilityRecoveryStage;
  reason: string;
  facility?: UtilityPlacementReceipt;
  connector?: UtilityConnectorReadback;
  before: UtilityCapacityReadback;
  after?: UtilityCapacityReadback;
  executedActions: number;
  trace: UtilityRecoveryStage[];
  connectionDiagnostics?: UtilityConnectionDiagnostic[];
  preflightDiagnostics?: UtilityPreflightDiagnostic[];
  selectedPrimitive?: UtilityConnectionPrimitive;
  nativeTelemetry?: import("./v2/foundation").UtilityNativeTelemetryEvidence;
}

export interface PreparedSharedUtilityRecovery {
  status: "READY" | "PLACEMENT_ONLY" | "BLOCKED";
  kind: UtilityRecoveryKind;
  reason: string;
  before: UtilityCapacityReadback;
  facility?: UtilityPlacementReceipt;
  connector?: UtilityConnectorReadback;
  plan?: PlannedUtilityFacility | UtilityConnectionPlan;
  selected?: { primitive: UtilityConnectionPrimitive; actions: MayorAction[] };
  executedActions: number;
  trace: UtilityRecoveryStage[];
  connectionDiagnostics: UtilityConnectionDiagnostic[];
  preflightDiagnostics: UtilityPreflightDiagnostic[];
  diagnostics?: Record<string, unknown>;
  currentBinding?: UtilityCurrentBinding;
  currentBindingResolved?: boolean;
  candidateBuilderCalled?: boolean;
  candidateCount?: number;
  selectedCandidatePrimitive?: UtilityConnectionPrimitive;
  candidateActionCount?: number;
  splitDiagnostics?: Record<string, unknown>;
}

export async function prepareSharedUtilityRecovery(input: {
  kind: UtilityRecoveryKind;
  expectedRevision: string | null;
  treasury?: number | null;
  runwayMonths?: number | null;
  connectionOnly?: boolean;
  allowFacilityPlacementMutation?: boolean;
  /** Stop after the facility placement and exact current entity readback. */
  placementOnly?: boolean;
  /**
   * Exact-action fingerprints of courses whose durable command already reached
   * the world. Re-validating one of them asks the game to accept a duplicate of
   * work that already exists, which it refuses, so the durable submission is
   * taken as the authority for that course instead.
   */
  durablySubmittedFingerprints?: readonly string[];
  before?: UtilityCapacityReadback;
  selectedPrimitive?: UtilityConnectionPrimitive;
  /** Soft family rank supplied by the Runtime Skill; every unchosen legal family remains eligible. */
  candidatePreference?: readonly UtilityConnectionPrimitive[];
  /**
   * The bounded access-road repair course, when this run is the repair.
   *
   * Supplied only by the repair path: the course was derived and priced against
   * the current authoritative topology before native submission, and this is the
   * only way it reaches the candidate list.
   */
  accessRoad?: MayorAction[];
  signal: AbortSignal;
  ports: SharedUtilityPreparationPorts;
}): Promise<PreparedSharedUtilityRecovery> {
  const { kind, ports, signal } = input;
  const trace: UtilityRecoveryStage[] = ["planning"];
  const before = input.before ?? await ports.readCapacity(kind);
  const blockedResult = (reason: string, extra: Partial<PreparedSharedUtilityRecovery> = {}): PreparedSharedUtilityRecovery => ({
    status: "BLOCKED", kind, reason, before, executedActions: 0, trace: [...trace, "blocked"],
    connectionDiagnostics: [], preflightDiagnostics: [], ...extra,
  });
  const revision = await ports.currentRevision();
  if (input.expectedRevision !== null && revision !== null && revision !== input.expectedRevision) return blockedResult("stale_revision");
  let plan: PlannedUtilityFacility | UtilityConnectionPlan;
  let receipt: UtilityPlacementReceipt;
  let connector: UtilityConnectorReadback;
  let placementExecutions = 0;
  let planDiagnostics: Record<string, unknown> | undefined;
  if (input.connectionOnly) {
    const bindingResult = await ports.findCurrentUtilityBinding?.(kind);
    if (!bindingResult) return blockedResult("UTILITY_FACILITY_NOT_FOUND");
    if (bindingResult.status !== "MATCH") return blockedResult(bindingResult.reason, bindingResult.diagnostics ? { diagnostics: bindingResult.diagnostics } : {});
    const planResult = await ports.plan(kind, { mode: "EXISTING_FACILITY_CONNECTION", binding: bindingResult.binding });
    if (planResult.status !== "candidate" || !planResult.connection) {
      return blockedResult(planResult.reason, planResult.diagnostics ? { diagnostics: planResult.diagnostics } : {});
    }
    if (signal.aborted) return blockedResult("aborted");
    plan = planResult.connection;
    receipt = bindingResult.binding.facility;
    connector = bindingResult.binding.connector;
    planDiagnostics = planResult.diagnostics;
    const currentBinding = bindingResult.binding;
    // A persisted direct-cable fallback records the last primitive attempted,
    // not a permanent preference. Re-open the shared service-road candidate
    // when the current bounded planner has since natively accepted a fresh
    // route; otherwise K05 would keep selecting the exhausted cable topology.
    const selectedPrimitive = input.selectedPrimitive === "direct-cable" &&
      "mode" in plan && plan.serviceRoadsNativePreflighted === true
      ? undefined : input.selectedPrimitive;
    const candidates = buildUtilityConnectionCandidates(plan, connector, input.accessRoad)
      .filter((candidate) => !selectedPrimitive || candidate.primitive === selectedPrimitive);
    return prepareCandidates({
      input, kind, before, trace, plan, receipt, connector, planDiagnostics, currentBinding,
      candidates: rankUtilityConnectionCandidates(candidates, input.candidatePreference), ports, placementExecutions,
    });
  } else {
    const planResult = await ports.plan(kind, { mode: "GREENFIELD_PLACEMENT" });
    if (planResult.status !== "candidate" || !planResult.facility) {
      return blockedResult(planResult.reason, planResult.diagnostics ? { diagnostics: planResult.diagnostics } : {});
    }
    if (input.treasury !== undefined && input.runwayMonths !== undefined && input.treasury !== null &&
      input.runwayMonths !== null && input.runwayMonths < 1 && input.treasury < planResult.facility.constructionCost) {
      return blockedResult("finance_guard");
    }
    if (signal.aborted) return blockedResult("aborted");
    plan = { ...planResult.facility, position: { ...planResult.facility.position } };
    receipt = await ports.findExistingFacility?.(kind, plan) as UtilityPlacementReceipt;
    if (!receipt) {
      if (!input.allowFacilityPlacementMutation) return blockedResult("UTILITY_FACILITY_NOT_FOUND", { plan, diagnostics: planResult.diagnostics });
      let placementAction: MayorAction | undefined;
      for (const offset of utilityPlacementOffsets()) {
        for (const rotation of plan.rotationCandidates) {
          const action: MayorAction = { type: "place_building", prefab: plan.prefab, x: plan.position.x + offset.x, z: plan.position.z + offset.z, rotation };
          if (!preflightAccepted(await ports.preflight(action))) continue;
          // Clearance is checked AFTER legality and BEFORE the position is taken:
          // a legal position no service road can reach is a facility that never
          // works, which is how two pumping stations ended up inert on a dead end.
          if (ports.readPlacementContext) {
            const context = await ports.readPlacementContext({ x: action.x!, z: action.z! });
            if (context) {
              const clearance = facilityPlacementClearance({
                position: { x: action.x!, z: action.z! },
                roads: context.roads,
                existingFacilities: context.existingFacilities,
              });
              if (!clearance.ok) continue;
            }
          }
          placementAction = action;
          break;
        }
        if (placementAction) break;
      }
      if (!placementAction) return blockedResult("no_safe_utility_site", { plan });
      if (!ports.execute) return blockedResult("UTILITY_FACILITY_NOT_FOUND", { plan });
      const batch = await ports.execute([placementAction]);
      placementExecutions = batch.executed;
      receipt = receiptFrom(batch) as UtilityPlacementReceipt;
      if (!batch.ok || !receipt) return blockedResult("facility_identity_unavailable", { plan });
    }
    connector = connectorFor(kind, await ports.readConnectors(receipt.entity)) as UtilityConnectorReadback;
    if (!connector) return blockedResult("UTILITY_CONNECTOR_NOT_FOUND", { plan, facility: receipt });
    planDiagnostics = planResult.diagnostics;
    if (input.placementOnly) {
      if (placementExecutions === 0) return blockedResult("STAGE_A_FACILITY_ALREADY_PRESENT", { plan, facility: receipt, connector, diagnostics: planDiagnostics });
      return {
        status: "PLACEMENT_ONLY", kind, reason: "FACILITY_PLACED_AND_READ_BACK", before,
        facility: receipt, connector, plan, executedActions: placementExecutions,
        trace: [...trace, "verifying"], connectionDiagnostics: [], preflightDiagnostics: [],
        diagnostics: planDiagnostics, candidateBuilderCalled: false,
      };
    }
  }
  const candidates = buildUtilityConnectionCandidates(plan, connector, input.accessRoad)
    .filter((candidate) => !input.selectedPrimitive || candidate.primitive === input.selectedPrimitive);
  return prepareCandidates({ input, kind, before, trace, plan, receipt, connector, planDiagnostics,
    candidates: rankUtilityConnectionCandidates(candidates, input.candidatePreference), ports, placementExecutions });
}

function rankUtilityConnectionCandidates<T extends { primitive: UtilityConnectionPrimitive }>(
  candidates: readonly T[], preference: readonly UtilityConnectionPrimitive[] = [],
): T[] {
  if (preference.length === 0) return [...candidates];
  const order = new Map(preference.map((primitive, index) => [primitive, index]));
  return candidates.map((candidate, index) => ({ candidate, index, rank: order.get(candidate.primitive) ?? preference.length }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index).map(({ candidate }) => candidate);
}

async function prepareCandidates(input: {
  input: {
    selectedPrimitive?: UtilityConnectionPrimitive;
    signal: AbortSignal;
    durablySubmittedFingerprints?: readonly string[];
  };
  kind: UtilityRecoveryKind;
  before: UtilityCapacityReadback;
  trace: UtilityRecoveryStage[];
  plan: PlannedUtilityFacility | UtilityConnectionPlan;
  receipt: UtilityPlacementReceipt;
  connector: UtilityConnectorReadback;
  planDiagnostics?: Record<string, unknown>;
  currentBinding?: UtilityCurrentBinding;
  candidates: Array<{ primitive: UtilityConnectionPrimitive; actions: MayorAction[]; nativePreflighted?: boolean }>;
  ports: SharedUtilityPreparationPorts;
  placementExecutions: number;
}): Promise<PreparedSharedUtilityRecovery> {
  const blockedResult = (reason: string, extra: Partial<PreparedSharedUtilityRecovery> = {}): PreparedSharedUtilityRecovery => ({
    status: "BLOCKED", kind: input.kind, reason, before: input.before, executedActions: 0,
    trace: [...input.trace, "blocked"], connectionDiagnostics: [], preflightDiagnostics: [],
    diagnostics: input.planDiagnostics, plan: input.plan, facility: input.receipt, connector: input.connector,
    currentBinding: input.currentBinding, currentBindingResolved: input.currentBinding !== undefined,
    candidateBuilderCalled: true, candidateCount: input.candidates.length,
    ...extra,
  });
  if (input.candidates.length === 0) {
    return blockedResult("UTILITY_CONNECTION_CANDIDATE_MISSING");
  }
  const connectionDiagnostics: UtilityConnectionDiagnostic[] = [];
  const preflightDiagnostics: UtilityPreflightDiagnostic[] = [];
  let emptyCandidate: { primitive: UtilityConnectionPrimitive; actions: MayorAction[] } | undefined;
  for (const candidate of input.candidates) {
    if (candidate.actions.length === 0) {
      emptyCandidate = candidate;
      continue;
    }
    let valid = true;
    // A course whose exact actions are already durably submitted is not
    // re-validated: the game rejects a duplicate of work that already exists in
    // the world, and the durable submission owns the effect until reconciliation
    // settles it from the world.
    const durablySubmitted = (input.input.durablySubmittedFingerprints ?? []).includes(JSON.stringify(candidate.actions));
    const nativePreflighted = candidate.nativePreflighted === true;
    if (durablySubmitted || nativePreflighted) {
      preflightDiagnostics.push({ candidate: candidate.primitive, actionCount: candidate.actions.length,
        preflightResult: { valid: true, reason: nativePreflighted
          ? candidate.primitive === "direct-cable"
            ? "bounded_utility_direct_cable_native_preflight_already_accepted"
            : "bounded_utility_route_native_preflight_already_accepted"
          : "durably_submitted_course_not_revalidated" },
        projectedGeometricContactResidual: null });
    }
    for (const [actionIndex, action] of candidate.actions.entries()) {
      if (durablySubmitted || nativePreflighted) break;
      let raw: boolean | UtilityPreflightResult;
      let thrownError: string | undefined;
      let thrownType: string | undefined;
      try {
        raw = await input.ports.preflight(action);
      } catch (error) {
        thrownError = error instanceof Error ? error.message : String(error);
        thrownType = error instanceof Error ? error.name : typeof error;
        raw = { valid: false, reason: "utility_preflight_threw" };
      }
      const result: UtilityPreflightResult = typeof raw === "boolean" ? { valid: raw, reason: raw ? undefined : "native_preflight_rejected" } : raw;
      const diagnostics = result.native?.diagnostics;
      const targetBinding = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
        ? (diagnostics as Record<string, unknown>).targetBinding : undefined;
      const residual = targetBinding && typeof targetBinding === "object" && !Array.isArray(targetBinding)
        ? (targetBinding as Record<string, unknown>).xzResidual : undefined;
      const nativeValidation = result.native;
      const validationCode = nativeValidation && typeof nativeValidation.code === "string" ? nativeValidation.code :
        nativeValidation && typeof nativeValidation.validationCode === "string" ? nativeValidation.validationCode : undefined;
      const failedCondition = nativeValidation && typeof nativeValidation.failedCondition === "string" ? nativeValidation.failedCondition :
        nativeValidation && typeof nativeValidation.condition === "string" ? nativeValidation.condition : undefined;
      preflightDiagnostics.push({ candidate: candidate.primitive, actionCount: candidate.actions.length, action, actionIndex,
        ...(validationCode ? { validationCode } : {}), ...(failedCondition ? { failedCondition } : {}),
        preflightResult: { valid: result.valid, ...(result.reason ? { reason: result.reason } : {}), ...(result.native ? { native: result.native } : {}) },
        ...(thrownError ? { error: thrownError } : {}), ...(thrownType ? { errorType: thrownType } : {}), native: result.native,
        projectedGeometricContactResidual: typeof residual === "number" ? residual : null });
      if (!result.valid) {
        valid = false;
        connectionDiagnostics.push({ ...result, candidate: candidate.primitive, actionCount: candidate.actions.length, action, actionIndex,
          ...(thrownError ? { reason: `${result.reason}:${thrownError}` } : {}) });
        break;
      }
    }
    if (valid && candidate.actions.length > 0) {
      const transportedDiagnostics = {
        ...(input.planDiagnostics ?? {}),
        ...(input.currentBinding ? { currentBinding: input.currentBinding } : {}),
        currentBindingResolved: input.currentBinding !== undefined,
        candidateBuilderCalled: true,
        candidateCount: input.candidates.length,
        selectedCandidatePrimitive: candidate.primitive,
        candidateActionCount: candidate.actions.length,
        connectionDiagnostics,
        preflightDiagnostics,
      };
      return { status: "READY", kind: input.kind, reason: "prepared", before: input.before, facility: input.receipt, connector: input.connector, plan: input.plan,
        selected: candidate, executedActions: input.placementExecutions, trace: [...input.trace, "facility_ready", "connector_discovered"],
        connectionDiagnostics, preflightDiagnostics, diagnostics: transportedDiagnostics,
        currentBinding: input.currentBinding, currentBindingResolved: input.currentBinding !== undefined,
        candidateBuilderCalled: true, candidateCount: input.candidates.length,
        selectedCandidatePrimitive: candidate.primitive, candidateActionCount: candidate.actions.length };
    }
  }
  if (emptyCandidate && connectionDiagnostics.length === 0) {
    // Each primitive that can be empty says so in its own words: the reason is
    // the only evidence a caller gets about which course produced no segments.
    const emptyReason = emptyCandidate.primitive === "direct-cable" ? "EMPTY_DIRECT_CABLE_ACTIONS"
      : emptyCandidate.primitive === "facility-access-road" ? "EMPTY_FACILITY_ACCESS_ROAD_ACTIONS"
        : "EMPTY_UTILITY_CANDIDATE_ACTIONS";
    return blockedResult(emptyReason, {
      selectedCandidatePrimitive: emptyCandidate.primitive,
      candidateActionCount: 0,
      splitDiagnostics: {
        source: "splitUtilityConnection",
        reason: "SPLIT_UTILITY_CONNECTION_RETURNED_NO_SEGMENTS",
        primitive: emptyCandidate.primitive,
      },
    });
  }
  const rejectedCandidate = input.candidates.find((candidate) => candidate.actions.length > 0) ?? emptyCandidate ?? input.candidates[0];
  return blockedResult("DIRECT_CABLE_PREFLIGHT_REJECTED", {
    selectedCandidatePrimitive: rejectedCandidate.primitive,
    candidateActionCount: rejectedCandidate.actions.length,
    connectionDiagnostics,
    preflightDiagnostics,
  });
}

export function buildUtilityConnectionCandidates(
  facility: PlannedUtilityFacility | UtilityConnectionPlan,
  connector: UtilityConnectorReadback,
  /**
   * A road-repair course already derived by the bounded access-road replan.
   *
   * It is a candidate rather than an input to the plan because it answers a
   * different question from either existing primitive: the plan's own service
   * road is the course the world refused, and the direct cable is a different
   * network entirely. Absent means the repair capability contributed nothing and
   * the candidate list is exactly what it always was.
   */
  accessRoad?: MayorAction[],
): Array<{ primitive: UtilityConnectionPrimitive; actions: MayorAction[]; nativePreflighted?: boolean }> {
  const plannedFacility = facility;
  // In connection-only recovery, a selected bounded service-road route is a
  // Gate 1 planning input: it must be returned to the durable child materializer
  // before a utility cable can be admitted. It is not submitted as a utility
  // network link by this function.
  const serviceRoadPlans = (plannedFacility.serviceRoads ?? []).map((road) => ({ ...road, start: { ...road.start }, end: { ...road.end } }));
  const facilityPosition = plannedFacility.position ?? ("mode" in facility ? facility.facility.position : undefined);
  const finalServiceRoad = serviceRoadPlans.at(-1);
  if (finalServiceRoad && facilityPosition) finalServiceRoad.end = {
    x: finalServiceRoad.end.x + connector.worldPosition.x - facilityPosition.x,
    z: finalServiceRoad.end.z + connector.worldPosition.z - facilityPosition.z,
  };
  const serviceRoads = serviceRoadPlans.map((road) => plannedRoadSegmentToMayorAction(road));
  const directConnections = splitUtilityConnection({ ...plannedFacility.connection,
    start: plannedFacility.connectionEndpointBindings ? plannedFacility.connection.start : connector.worldPosition }).map((connection) => ({
    type: "build_road" as const,
    prefab: connection.prefab,
    x1: connection.start.x, z1: connection.start.z, x2: connection.end.x, z2: connection.end.z,
  }));
  // A topology repair starts at a freshly rebindable node on the already
  // connected physical cable and ends at the exact current target road node.
  // It is still an ordinary bounded Utility candidate: native preview,
  // write-ahead command identity, exactly-once Apply and authoritative readback
  // remain in the existing execution boundary.
  if (plannedFacility.connectionEndpointBindings && directConnections.length === 1) {
    directConnections[0].utilityEndpoints = structuredClone(plannedFacility.connectionEndpointBindings);
  }
  const accessRoadCourse = accessRoad && accessRoad.length > 0 ? accessRoad : undefined;
  const candidates = [
    ...(serviceRoads.length > 0 ? [{ primitive: "service-road" as const, actions: serviceRoads,
      ...("mode" in facility && facility.serviceRoadsNativePreflighted === true ? { nativePreflighted: true } : {}) }] : []),
    ...(accessRoadCourse ? [{ primitive: "facility-access-road" as const, actions: accessRoadCourse }] : []),
    { primitive: "direct-cable" as const, actions: directConnections,
      ...( "mode" in facility && facility.directCableNativePreflighted === true ? { nativePreflighted: true } : {}) },
  ];
  // Connection-only recovery still returns a selected service-road course to
  // the Gate 1 durable child materializer; execution remains owned by Gate 1.
  return candidates;
}

const MAX_PLACEMENT_OFFSETS = 97;

export function utilityPlacementOffsets(): SpatialPoint2[] {
  const offsets: SpatialPoint2[] = [{ x: 0, z: 0 }];
  for (let radius = 8; radius <= 96; radius += 8) {
    for (const offset of [
      { x: 0, z: -radius },
      { x: radius, z: 0 },
      { x: 0, z: radius },
      { x: -radius, z: 0 },
      { x: radius, z: -radius },
      { x: radius, z: radius },
      { x: -radius, z: radius },
      { x: -radius, z: -radius },
    ])
      offsets.push(offset);
  }
  return offsets.slice(0, MAX_PLACEMENT_OFFSETS);
}

function connectorFor(kind: UtilityRecoveryKind, connectors: UtilityConnectorReadback[]) {
  return connectors.find((connector) =>
    kind === "electricity"
      ? connector.type === "electricity"
      : connector.type === "waterPipe" &&
        (kind === "water" ? (connector.capacity.fresh ?? 0) > 0 : (connector.capacity.sewage ?? 0) > 0),
  );
}

function receiptFrom(batch: MayorBatchResult): UtilityPlacementReceipt | undefined {
  const receipt = batch.results.find((result) => result.type === "place_building" && result.ok)?.receipt;
  return receipt
    ? {
        entity: receipt.entity,
        prefab: receipt.prefab,
        position: {
          x: receipt.position.x,
          ...(receipt.position.y !== undefined ? { y: receipt.position.y } : {}),
          z: receipt.position.z,
        },
      }
    : undefined;
}

function blocked(
  kind: UtilityRecoveryKind,
  before: UtilityCapacityReadback,
  trace: UtilityRecoveryStage[],
  reason: string,
  executedActions = 0,
  facility?: UtilityPlacementReceipt,
  connector?: UtilityConnectorReadback,
): UtilityRecoveryResult {
  return {
    ok: false,
    kind,
    stage: "blocked",
    reason,
    before,
    executedActions,
    trace: [...trace, "blocked"],
    ...(facility ? { facility } : {}),
    ...(connector ? { connector } : {}),
  };
}

export async function executeSharedUtilityRecovery(input: {
  kind: UtilityRecoveryKind;
  /** Admission semantics are explicit: a typed network course is not a facility siting request. */
  actionKind?: UtilityActionKind;
  expectedRevision: string | null;
  treasury: number | null;
  runwayMonths: number | null;
  connectionOnly?: boolean;
  placementOnly?: boolean;
  selectedPrimitive?: UtilityConnectionPrimitive;
  /** The bounded access-road repair course, when this run is the repair. */
  accessRoad?: MayorAction[];
  /** One admitted network-link repair step. It reuses these Utility Kernel ports and never submits a native batch. */
  networkLinkRepair?: { actions: MayorAction[]; repairLineage: string; stepIndex: 1 | 2 };
  /** Run the real Utility preflight without creating a command or invoking execute(). */
  admissionOnly?: boolean;
  signal: AbortSignal;
  ports: SharedUtilityRecoveryPorts;
}): Promise<UtilityRecoveryResult> {
  const { kind, ports, signal } = input;
  const initialBefore = await ports.readCapacity(kind);
  const actionKind = input.actionKind ?? (input.networkLinkRepair ? "NETWORK_LINK_REPAIR" : "FACILITY_REPAIR");
  if ((actionKind === "NETWORK_LINK_REPAIR") !== !!input.networkLinkRepair) {
    return blocked(kind, initialBefore, ["planning", "blocked"], "UTILITY_ACTION_KIND_PAYLOAD_MISMATCH", 0);
  }
  if (input.networkLinkRepair) {
    const { actions, repairLineage, stepIndex } = input.networkLinkRepair;
    const endpointBindings = actions[0]?.type === "build_road" ? actions[0].utilityEndpoints : undefined;
    const action = actions[0]?.type === "build_road" ? actions[0] : undefined;
    const validBinding = (binding: NonNullable<typeof endpointBindings>["start"], role: "START" | "END") =>
      !!binding && binding.role === role && binding.utility === kind.toUpperCase() && binding.prefab === action?.prefab &&
      (binding.mode === "EXISTING_NET_NODE" || (role === "END" && binding.mode === "FREE_POINT")) &&
      typeof binding.bindingRule === "string" && binding.bindingRule.trim().length > 0 &&
      typeof binding.topologyRole === "string" && binding.topologyRole.trim().length > 0 &&
      Number.isFinite(binding.expectedPosition?.x) && Number.isFinite(binding.expectedPosition?.z) &&
      (binding.mode !== "EXISTING_NET_NODE" || !!binding.topologyLookup);
    const routeLength = action ? Math.hypot(action.x2 - action.x1, action.z2 - action.z1) : Number.POSITIVE_INFINITY;
    if (!repairLineage || (stepIndex !== 1 && stepIndex !== 2) || actions.length !== 1 ||
      !action || !endpointBindings?.start || !endpointBindings.end ||
      !validBinding(endpointBindings.start, "START") || !validBinding(endpointBindings.end, "END") ||
      endpointBindings.start.utility !== endpointBindings.end.utility || endpointBindings.start.prefab !== endpointBindings.end.prefab ||
      !Number.isFinite(routeLength) || routeLength <= 0 || routeLength > MAX_UTILITY_CONNECTION_SEGMENT_LENGTH ||
      Math.hypot(endpointBindings.start.expectedPosition.x - action.x1, endpointBindings.start.expectedPosition.z - action.z1) > 0.25 ||
      Math.hypot(endpointBindings.end.expectedPosition.x - action.x2, endpointBindings.end.expectedPosition.z - action.z2) > 0.25) {
      return blocked(kind, initialBefore, ["planning", "blocked"], "NETWORK_LINK_REPAIR_EXACT_SINGLE_ACTION_CONTRACT_INVALID", 0);
    }
    const preflight = await ports.preflight(actions[0]);
    if (!preflightAccepted(preflight)) {
      const reason = typeof preflight === "boolean" ? "NETWORK_LINK_REPAIR_PREFLIGHT_REJECTED" : preflight.reason ?? "NETWORK_LINK_REPAIR_PREFLIGHT_REJECTED";
      return blocked(kind, initialBefore, ["planning", "blocked"], reason, 0);
    }
    if (input.admissionOnly) {
      return { ok: true, kind, stage: "planning", reason: `NETWORK_LINK_REPAIR_ADMITTED:${repairLineage}:step-${stepIndex}`,
        before: initialBefore, executedActions: 0, trace: ["planning"], selectedPrimitive: "direct-cable" };
    }
    const submitted = await ports.execute(actions);
    return {
      ok: submitted.ok,
      kind,
      stage: submitted.ok ? "verifying" : "blocked",
      reason: submitted.ok ? `NETWORK_LINK_REPAIR_STEP_${stepIndex}_SUBMITTED:${repairLineage}` : "NETWORK_LINK_REPAIR_UTILITY_KERNEL_REJECTED",
      before: initialBefore,
      executedActions: submitted.executed,
      trace: ["planning", submitted.ok ? "verifying" : "blocked"],
      selectedPrimitive: "direct-cable",
    };
  }
  // "Nothing to do" is a fact about the world, not about the caller's mode.
  //
  // The `connectionOnly` carve-out exists so that a request to BUILD a
  // connection is not answered with a silent early return. It is not a licence
  // to demand a connection that is already there — and treating it as one left a
  // slice whose service was live permanently uncertifiable: the one course it
  // could submit was the one it had already built, the durable write contract
  // refused it as a duplicate, and the objective dead-ended as "candidates
  // exhausted" while the city was already drinking the water.
  //
  // The bound connector answers it directly: `attached` means it carries an edge
  // that is not its own isolated flow-graph edge, i.e. the connection exists. So
  // a satisfied service with an existing connection resolves in every mode, and
  // a connection-only request with NO connection still proceeds to build one.
  if (!initialBefore.issueActive) {
    const binding = input.connectionOnly ? await ports.findCurrentUtilityBinding?.(kind) : undefined;
    const alreadyConnected = binding?.status === "MATCH" && binding.binding.connector.attached === true;
    if (input.selectedPrimitive !== "facility-access-road" && (!input.connectionOnly || alreadyConnected)) {
      return {
        ok: true, kind, stage: "resolved", reason: "no_action_needed", before: initialBefore, after: initialBefore,
        executedActions: 0, trace: ["planning", "resolved"],
      };
    }
  }
  const prepared = await prepareSharedUtilityRecovery({
    kind,
    expectedRevision: input.expectedRevision,
    treasury: input.treasury,
    runwayMonths: input.runwayMonths,
    connectionOnly: input.connectionOnly,
    placementOnly: input.placementOnly,
    allowFacilityPlacementMutation: true,
    before: initialBefore,
    selectedPrimitive: input.selectedPrimitive,
    accessRoad: input.accessRoad,
    signal,
    ports,
  });
  const before = prepared.before;
  const trace = prepared.trace;
  if (prepared.status === "PLACEMENT_ONLY" && prepared.facility && prepared.connector) {
    return { ok: true, kind, stage: "verifying", reason: "FACILITY_PLACED_AND_READ_BACK",
      before, facility: prepared.facility, connector: prepared.connector,
      executedActions: prepared.executedActions, trace };
  }
  if (prepared.status !== "READY" || !prepared.facility || !prepared.connector || !prepared.plan || !prepared.selected) {
    const reason = prepared.reason === "UTILITY_CONNECTOR_NOT_FOUND" ? "utility_connector_missing" : prepared.reason;
    const result = blocked(kind, before, trace, reason, prepared.executedActions, prepared.facility, prepared.connector);
    // The candidate diagnostics are the actionable evidence for a rejected
    // connection primitive; without them a blocked run reports a bare reason and
    // the native rejection it stopped on is lost.
    result.connectionDiagnostics = prepared.connectionDiagnostics;
    result.preflightDiagnostics = prepared.preflightDiagnostics;
    if (prepared.selectedCandidatePrimitive) result.selectedPrimitive = prepared.selectedCandidatePrimitive;
    return result;
  }
  const receipt = prepared.facility;
  const connector = prepared.connector;
  const selected = prepared.selected;
  const networkActions = selected.actions;
  let executedActions = prepared.executedActions;
  if (networkActions.length > 0) {
    const networkBatch = await ports.execute(networkActions);
    executedActions += networkBatch.executed;
    if (!networkBatch.ok)
      return blocked(kind, before, trace, "connector_execution_failed", executedActions, receipt, connector);
  }
  await ports.settle();
  const attached = connectorFor(kind, await ports.readConnectors(receipt.entity));
  if (!attached?.attached) {
    const result = blocked(
      kind,
      before,
      trace,
      "utility_connector_not_attached",
      executedActions,
      receipt,
      attached ?? connector,
    );
    result.connectionDiagnostics = prepared.connectionDiagnostics;
    result.preflightDiagnostics = prepared.preflightDiagnostics;
    result.selectedPrimitive = selected.primitive;
    return result;
  }
  trace.push("connector_connected", "verifying");
  const after = await ports.readCapacity(kind);
  const beforeHeadroom =
    before.capacity !== null && before.consumption !== null ? before.capacity - before.consumption : null;
  const afterHeadroom =
    after.capacity !== null && after.consumption !== null ? after.capacity - after.consumption : null;
  const improved =
    (before.capacity !== null && after.capacity !== null && after.capacity > before.capacity) ||
    (beforeHeadroom !== null && afterHeadroom !== null && afterHeadroom > beforeHeadroom) ||
    (before.fulfilledConsumption !== null &&
      after.fulfilledConsumption !== null &&
      after.fulfilledConsumption > before.fulfilledConsumption);
  const stage: UtilityRecoveryStage = !after.issueActive ? "resolved" : improved ? "improving" : "blocked";
  const reason = stage === "blocked" ? "no_material_issue_improvement" : stage;
  return {
    ok: stage !== "blocked",
    kind,
    stage,
    reason,
    facility: receipt,
    connector: attached,
    before,
    after,
    executedActions,
    trace: [...trace, stage],
    connectionDiagnostics: prepared.connectionDiagnostics,
    preflightDiagnostics: prepared.preflightDiagnostics,
    selectedPrimitive: selected.primitive,
  };
}
