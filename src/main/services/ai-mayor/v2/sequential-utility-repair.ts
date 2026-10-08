/**
 * Durable coordinator for a small ordered utility repair made of independent
 * native commands. Each step is rebound, previewed, authorized, submitted and
 * reconciled separately. This deliberately does not expose a batch operation.
 */
export const SEQUENTIAL_UTILITY_REPAIR_SCHEMA = "ai-mayor-sequential-utility-repair/1" as const;

export type RepairTruth = "PASS" | "FAIL" | "UNKNOWN";
export type RepairActionState = "CERTIFIED" | "RECONCILING_DUPLICATE" | "AUTHORIZED" | "SUBMITTED" | "EFFECT_PASS" | "COMPLETE" | "STOPPED";

export interface SequentialRepairAction {
  readonly index: 1 | 2;
  readonly worldId: string;
  readonly generation: string;
  readonly actionId: string;
  readonly commandId: string;
  readonly authorizationId: string;
  readonly utility: string;
  readonly prefab: string;
  readonly geometry: Readonly<Record<string, number | string>>;
  readonly quote: number;
  readonly state: RepairActionState;
  readonly realized?: Readonly<Record<string, unknown>>;
  readonly topologyEvidence?: Readonly<Record<string, unknown>>;
  readonly action?: MayorAction;
}

export interface SequentialRepairState {
  readonly schema: typeof SEQUENTIAL_UTILITY_REPAIR_SCHEMA;
  readonly repairId: string;
  readonly actionCount: 2;
  readonly status: "ACTIVE" | "COMPLETE" | "STOPPED";
  readonly plan?: { repairLineage: string; actions: readonly [MayorAction, MayorAction] };
  readonly actions: readonly SequentialRepairAction[];
  readonly blocker?: string;
}

export interface SequentialRepairCandidate {
  index: 1 | 2;
  worldId: string;
  generation: string;
  actionId: string;
  commandId: string;
  authorizationId: string;
  utility: string;
  prefab: string;
  geometry: Readonly<Record<string, number | string>>;
  action?: MayorAction;
}

export interface SequentialRepairPreview {
  valid: boolean;
  quote: number;
  duplicate: boolean;
  topologyChecks: Readonly<Record<string, RepairTruth>>;
  worldId: string;
  generation: string;
  authorizationId?: string;
  reason?: string;
}

export interface SequentialRepairAdmission {
  readonly admitted: true;
  readonly actionFingerprint: string;
  readonly quote: number;
  readonly worldId: string;
  readonly generation: string;
}

export interface SequentialRepairObservation {
  effect: RepairTruth;
  topology: {
    checks: Readonly<Record<string, RepairTruth>>;
    evidence: Readonly<Record<string, unknown>>;
  };
  realized?: Readonly<Record<string, unknown>>;
  reason?: string;
}

const REQUIRED_TOPOLOGY_CHECKS: Record<1 | 2, readonly string[]> = {
  1: ["sourceComponentReachable", "newCurrentGenerationEdge", "midpointTerminalBound", "sourceSideConnection", "noUnintendedDuplicate"],
  2: ["sourceComponentReachable", "segment1ChainConnected", "segment2CurrentGenerationEdge", "targetJoinPresent",
    "sourceToTargetNetworkReachable", "localRoadComponentReached", "pumpElectricityPathReached", "noUnintendedDuplicate"],
};
const REQUIRED_PREVIEW_CHECKS: Record<1 | 2, readonly string[]> = {
  1: ["sourceComponentReachable", "exactSourceEndpointBound", "sourceAttachmentMatch", "freeMidpointEndpoint"],
  2: ["sourceComponentReachable", "segment1ChainConnected", "midpointTerminalBound", "targetAttachmentMatch"],
};

const topologyPassed = (index: 1 | 2, checks: Readonly<Record<string, RepairTruth>>): boolean =>
  REQUIRED_TOPOLOGY_CHECKS[index].every((name) => checks[name] === "PASS");

/** Post-Apply facts stay separate: a cable terminal reaching the source says nothing by itself about the target network. */
export function evaluateSegment2PostApplyTopology(input: {
  cableEffectPresent: boolean;
  midpointJoinPresent: boolean;
  targetJoinPresent: boolean;
  sourceToSegment2TerminalReachable: boolean;
  sourceToTargetNetworkReachable: boolean;
  noUnintendedDuplicate: boolean;
}): { pass: boolean; checks: Readonly<Record<string, RepairTruth>> } {
  const checks: Record<string, RepairTruth> = {
    sourceComponentReachable: input.sourceToSegment2TerminalReachable ? "PASS" : "FAIL",
    segment1ChainConnected: input.midpointJoinPresent ? "PASS" : "FAIL",
    segment2CurrentGenerationEdge: input.cableEffectPresent ? "PASS" : "FAIL",
    targetJoinPresent: input.targetJoinPresent ? "PASS" : "FAIL",
    sourceToTargetNetworkReachable: input.sourceToTargetNetworkReachable ? "PASS" : "FAIL",
    localRoadComponentReached: input.sourceToTargetNetworkReachable ? "PASS" : "FAIL",
    pumpElectricityPathReached: input.sourceToTargetNetworkReachable ? "PASS" : "FAIL",
    noUnintendedDuplicate: input.noUnintendedDuplicate ? "PASS" : "FAIL",
  };
  return { pass: REQUIRED_TOPOLOGY_CHECKS[2].every((name) => checks[name] === "PASS"), checks };
}

export interface SequentialUtilityRepairPorts {
  load(repairId: string): Promise<SequentialRepairState | null>;
  save(state: SequentialRepairState): Promise<void>;
  /** Resolve against the live world; step 2 receives step 1's authoritative realized result. */
  rebind(index: 1 | 2, priorRealized?: Readonly<Record<string, unknown>>, actionTemplate?: MayorAction): Promise<SequentialRepairCandidate>;
  preview(candidate: SequentialRepairCandidate): Promise<SequentialRepairPreview>;
  /** Production, read-only Utility Admission. Must not mint authorization or command identity. */
  admit(candidate: SequentialRepairCandidate, quote: number): Promise<SequentialRepairAdmission>;
  /** Must be idempotent by authorizationId and reject any different exact binding. */
  authorize(input: { candidate: SequentialRepairCandidate; quote: number }): Promise<{
    actionId: string; authorizationId: string; quote: number; singleUse: true;
  }>;
  /** Exactly one native action. Implementations must not translate this into a batch. */
  submit(input: { candidate: SequentialRepairCandidate; quote: number }): Promise<{ commandId: string; nativeCallCount: 1 }>;
  /** Reconcile an existing command after submit/interrupt; this never resubmits. */
  observe(input: { candidate: SequentialRepairCandidate; quote: number }): Promise<SequentialRepairObservation>;
  /** Read-only reconciliation when fresh preview sees an existing matching effect. */
  reconcileDuplicate(input: { candidate: SequentialRepairCandidate; quote: number }): Promise<SequentialRepairObservation>;
}

export type SequentialRepairResult =
  | { status: "COMPLETE"; state: SequentialRepairState }
  | { status: "WAITING"; state: SequentialRepairState; reason: string }
  | { status: "STOPPED"; state: SequentialRepairState; reason: string };

const stop = async (ports: SequentialUtilityRepairPorts, state: SequentialRepairState, reason: string): Promise<SequentialRepairResult> => {
  const stopped: SequentialRepairState = { ...state, status: "STOPPED", blocker: reason,
    actions: state.actions.map((action) => action.state === "COMPLETE" ? action : { ...action, state: "STOPPED" }) };
  await ports.save(stopped);
  return { status: "STOPPED", state: stopped, reason };
};

const settleObservation = async (input: {
  ports: SequentialUtilityRepairPorts;
  state: SequentialRepairState;
  index: 1 | 2;
  action: SequentialRepairAction;
  observation: SequentialRepairObservation;
}): Promise<SequentialRepairResult> => {
  const { ports, state, index, action, observation } = input;
  const checks = observation?.topology?.checks;
  const evidence = observation?.topology?.evidence;
  if (!checks || !evidence) return stop(ports, state, `ACTION_${index}_TOPOLOGY_READBACK_INVALID`);
  if (observation.effect === "UNKNOWN" || Object.values(checks).includes("UNKNOWN")) {
    return { status: "WAITING", state, reason: observation.reason ?? `ACTION_${index}_RECONCILIATION_REQUIRED` };
  }
  const generationRebound = evidence.reboundCurrentGeneration === true && evidence.actionGeneration === action.generation &&
    typeof evidence.generation === "string" && evidence.generation.length > 0;
  if (evidence.worldId !== action.worldId || (evidence.generation !== action.generation && !generationRebound) ||
    observation.effect !== "PASS" || !topologyPassed(index, checks) || !observation.realized) {
    return stop(ports, state, observation.reason ?? `ACTION_${index}_EFFECT_OR_TOPOLOGY_FAILED`);
  }
  let completed: SequentialRepairAction = { ...action, state: "COMPLETE", realized: observation.realized,
    topologyEvidence: { ...evidence, checks } };
  let next: SequentialRepairState = { ...state, actions: state.actions.map((item) => item.index === index ? completed : item) };
  await ports.save(next);
  if (index === 1) return { status: "WAITING", state: next, reason: "ACTION_1_COMPLETE_ACTION_2_REQUIRES_FRESH_WORLD_BINDING" };
  completed = { ...completed, state: "COMPLETE" };
  next = { ...next, status: "COMPLETE", actions: next.actions.map((item) => item.index === index ? completed : item) };
  await ports.save(next);
  return { status: "COMPLETE", state: next };
};

const validCandidate = (candidate: SequentialRepairCandidate, index: 1 | 2): boolean =>
  typeof candidate?.worldId === "string" && candidate.worldId.length > 0 && typeof candidate.generation === "string" && candidate.generation.length > 0 &&
  typeof candidate.actionId === "string" && candidate.actionId.length > 0 && typeof candidate.commandId === "string" && candidate.commandId.length > 0 &&
  typeof candidate.authorizationId === "string" && candidate.authorizationId.length > 0 && typeof candidate.utility === "string" && candidate.utility.length > 0 &&
  typeof candidate.prefab === "string" && candidate.prefab.length > 0 && !!candidate.geometry && Object.keys(candidate.geometry).length > 0 &&
  Object.values(candidate.geometry).every((value) => typeof value === "string" || Number.isFinite(value)) &&
  candidate.index === index;

/**
 * Advance exactly one durable repair. A crash after submission resumes through
 * observe() using the stored identity; submit() is called only from CERTIFIED.
 */
export async function advanceSequentialUtilityRepair(input: {
  repairId: string;
  plan?: { repairLineage: string; actions: readonly [MayorAction, MayorAction] };
  expectedQuoteByStep?: Partial<Record<1 | 2, number>>;
  stopAfterStep1Admission?: boolean;
  stopBeforeStep2Authorization?: boolean;
  /** Force a current-world rebind and native preview before an explicitly authorized step 2. */
  refreshBeforeStep2Authorization?: boolean;
  ports: SequentialUtilityRepairPorts;
}): Promise<SequentialRepairResult> {
  const { repairId, ports } = input;
  let state = await ports.load(repairId) ?? {
    schema: SEQUENTIAL_UTILITY_REPAIR_SCHEMA, repairId, actionCount: 2,
    status: "ACTIVE", actions: [], ...(input.plan ? { plan: structuredClone(input.plan) } : {}),
  } satisfies SequentialRepairState;
  if (state.schema !== SEQUENTIAL_UTILITY_REPAIR_SCHEMA || state.repairId !== repairId || state.actionCount !== 2) {
    return stop(ports, state, "DURABLE_REPAIR_IDENTITY_INVALID");
  }
  if (state.status === "COMPLETE") return { status: "COMPLETE", state };
  if (state.status === "STOPPED") return { status: "STOPPED", state, reason: state.blocker ?? "REPAIR_STOPPED" };
  if (input.plan && JSON.stringify(state.plan) !== JSON.stringify(input.plan)) return stop(ports, state, "DURABLE_REPAIR_PLAN_IMMUTABLE_MISMATCH");

  if (state.actions.length > 2) return stop(ports, state, "REPAIR_ACTION_COUNT_EXCEEDED");
  let index: 1 | 2 = state.actions[0]?.state === "COMPLETE" ? 2 : 1;
  let action = state.actions[index - 1];
  if (index === 2 && state.actions[0]?.state !== "COMPLETE") {
    return stop(ports, state, "ACTION_1_TOPOLOGY_POSTCONDITION_NOT_COMPLETE");
  }
  if (!action) {
    let candidate: SequentialRepairCandidate;
    try { candidate = await ports.rebind(index, index === 2 ? state.actions[0].realized : undefined, state.plan?.actions[index - 1]); }
    catch (error) { return stop(ports, state, `ACTION_${index}_REBIND_FAILED:${String(error)}`); }
    if (!validCandidate(candidate, index)) return stop(ports, state, `ACTION_${index}_REBIND_INVALID`);
    if (state.actions.some((prior) => prior.actionId === candidate.actionId || prior.commandId === candidate.commandId || prior.authorizationId === candidate.authorizationId)) {
      return stop(ports, state, `ACTION_${index}_IDENTITY_NOT_DISTINCT`);
    }
    let preview: SequentialRepairPreview;
    try { preview = await ports.preview(candidate); }
    catch (error) { return stop(ports, state, `ACTION_${index}_FRESH_PREVIEW_FAILED:${String(error)}`); }
    const topologyChecks = preview?.topologyChecks;
    const previewTopologyPass = !!topologyChecks && REQUIRED_PREVIEW_CHECKS[index].every((name) => topologyChecks[name] === "PASS");
    if (!preview?.valid || preview.worldId !== candidate.worldId || preview.generation !== candidate.generation ||
      !Number.isFinite(preview.quote) || preview.quote < 0 || !previewTopologyPass) {
      return stop(ports, state, `ACTION_${index}_PREVIEW_OR_TOPOLOGY_REJECTED:${preview.reason ?? "INVALID_DUPLICATE_OR_UNCERTIFIED"}`);
    }
    const expectedQuote = input.expectedQuoteByStep?.[index];
    if (expectedQuote !== undefined && preview.quote !== expectedQuote) {
      return stop(ports, state, `ACTION_${index}_QUOTE_CHANGED:${expectedQuote}->${preview.quote}`);
    }
    action = { ...candidate, authorizationId: preview.authorizationId ?? candidate.authorizationId,
      index, quote: preview.quote, state: preview.duplicate ? "RECONCILING_DUPLICATE" : "CERTIFIED" };
    state = { ...state, actions: [...state.actions, action] };
    await ports.save(state);
  }

  let candidate: SequentialRepairCandidate = action;
  if (index === 2 && action.state === "CERTIFIED" && input.refreshBeforeStep2Authorization === true) {
    let rebound: SequentialRepairCandidate;
    try { rebound = await ports.rebind(2, state.actions[0].realized, state.plan?.actions[1]); }
    catch (error) { return stop(ports, state, `ACTION_2_FINAL_REBIND_FAILED:${String(error)}`); }
    if (!validCandidate(rebound, 2) || rebound.worldId !== action.worldId ||
      rebound.actionId === state.actions[0].actionId || rebound.commandId === state.actions[0].commandId ||
      rebound.authorizationId === state.actions[0].authorizationId ||
      JSON.stringify(rebound.action ? [rebound.action] : []) !== JSON.stringify(action.action ? [action.action] : [])) {
      return stop(ports, state, "ACTION_2_FINAL_REBIND_SEMANTICS_CHANGED");
    }
    let refreshed: SequentialRepairPreview;
    try { refreshed = await ports.preview(rebound); }
    catch (error) { return stop(ports, state, `ACTION_2_FINAL_PREVIEW_FAILED:${String(error)}`); }
    const checks = refreshed?.topologyChecks;
    const previewPass = REQUIRED_PREVIEW_CHECKS[2].every((name) => checks?.[name] === "PASS");
    if (!refreshed?.valid || refreshed.duplicate || refreshed.worldId !== rebound.worldId ||
      refreshed.generation !== rebound.generation || refreshed.quote !== action.quote || !previewPass) {
      return stop(ports, state, `ACTION_2_FINAL_PREVIEW_CHANGED:${refreshed?.reason ?? "QUOTE_DUPLICATE_OR_TOPOLOGY_CHANGED"}`);
    }
    const expectedQuote = input.expectedQuoteByStep?.[2];
    if (expectedQuote !== undefined && refreshed.quote !== expectedQuote) {
      return stop(ports, state, `ACTION_2_FINAL_QUOTE_CHANGED:${expectedQuote}->${refreshed.quote}`);
    }
    action = { ...rebound, index: 2, quote: refreshed.quote, state: "CERTIFIED" };
    state = { ...state, actions: state.actions.map((item) => item.index === 2 ? action : item) };
    await ports.save(state);
    candidate = action;
  }
  if (action.state === "RECONCILING_DUPLICATE") {
    let observation: SequentialRepairObservation;
    try { observation = await ports.reconcileDuplicate({ candidate, quote: action.quote }); }
    catch (error) { return { status: "WAITING", state, reason: `ACTION_${index}_DUPLICATE_RECONCILIATION_REQUIRED:${String(error)}` }; }
    return settleObservation({ ports, state, index, action, observation });
  }
  if (action.state === "CERTIFIED") {
    const admittedFingerprint = JSON.stringify(candidate);
    let admission: Awaited<ReturnType<typeof ports.admit>>;
    try { admission = await ports.admit(candidate, action.quote); }
    catch (error) { return stop(ports, state, `ACTION_${index}_ADMISSION_FAILED:${String(error)}`); }
    if (JSON.stringify(candidate) !== admittedFingerprint || !admission || admission.admitted !== true ||
      admission.actionFingerprint !== JSON.stringify(candidate.action ? [candidate.action] : []) || admission.quote !== action.quote ||
      admission.worldId !== candidate.worldId || admission.generation !== candidate.generation) {
      return stop(ports, state, `ACTION_${index}_ADMISSION_EXACT_ACTION_MISMATCH`);
    }
    if (index === 1 && input.stopAfterStep1Admission) {
      return { status: "WAITING", state, reason: "ACTION_1_PRODUCTION_ADMISSION_COMPLETE_AUTHORIZATION_NOT_REQUESTED" };
    }
    if (index === 2 && input.stopBeforeStep2Authorization) {
      return { status: "WAITING", state, reason: "ACTION_2_FRESH_PREFLIGHT_COMPLETE_AUTHORIZATION_NOT_REQUESTED" };
    }
    let authorization: Awaited<ReturnType<typeof ports.authorize>>;
    try { authorization = await ports.authorize({ candidate, quote: action.quote }); }
    catch (error) { return stop(ports, state, `ACTION_${index}_AUTHORIZATION_FAILED:${String(error)}`); }
    if (JSON.stringify(candidate) !== admittedFingerprint) {
      return stop(ports, state, `ACTION_${index}_ACTION_CHANGED_AFTER_ADMISSION`);
    }
    if (!authorization || authorization.actionId !== action.actionId || authorization.authorizationId !== action.authorizationId ||
      authorization.quote !== action.quote || authorization.singleUse !== true) {
      return stop(ports, state, `ACTION_${index}_EXACT_SINGLE_USE_AUTHORIZATION_MISMATCH`);
    }
    action = { ...action, state: "AUTHORIZED" };
    state = { ...state, actions: state.actions.map((item) => item.index === index ? action : item) };
    await ports.save(state);
    // Write ahead of the native call. A process interruption from this point on
    // is reconciled by command identity and can never authorize an implicit retry.
    action = { ...action, state: "SUBMITTED" };
    state = { ...state, actions: state.actions.map((item) => item.index === index ? action : item) };
    await ports.save(state);
    let submission: Awaited<ReturnType<typeof ports.submit>>;
    try {
      if (JSON.stringify(candidate) !== admittedFingerprint) return stop(ports, state, `ACTION_${index}_ACTION_CHANGED_BEFORE_SUBMISSION`);
      submission = await ports.submit({ candidate, quote: action.quote });
    }
    catch (error) { return { status: "WAITING", state, reason: `ACTION_${index}_SUBMISSION_UNCERTAIN:${String(error)}` }; }
    if (!submission || submission.commandId !== action.commandId || submission.nativeCallCount !== 1) {
      return stop(ports, state, `ACTION_${index}_NATIVE_COMMAND_ID_OR_COUNT_MISMATCH`);
    }
  }

  if (action.state !== "SUBMITTED") return stop(ports, state, `ACTION_${index}_DURABLE_STATE_INVALID`);
  let observation: SequentialRepairObservation;
  try { observation = await ports.observe({ candidate, quote: action.quote }); }
  catch (error) { return { status: "WAITING", state, reason: `ACTION_${index}_RECONCILIATION_REQUIRED:${String(error)}` }; }
  return settleObservation({ ports, state, index, action, observation });
}
import type { MayorAction } from "../types";
