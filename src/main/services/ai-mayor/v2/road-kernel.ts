import { Mutex } from "@/main/internal/mutex";
import {
  V2_COMMAND_SCHEMA_VERSION,
  observationRequestForZoning,
  type CommandObservationEvidence,
  type EffectMatcherResult,
  type RoadEffectMatcher,
  type RoadAuthorizedMutationScope,
  type V2CommandJournal,
  type V2CommandRecord,
  type V2CommandStatus,
  type V2ObservationPorts,
} from "./foundation";
import {
  V2_FINANCE_SCHEMA_VERSION,
  authorizeSpend,
  stableRoadInput,
  type ApplyFinanceReceipt,
  type FinanceObservation,
  type ProposalIdentity,
  type ProposalQuote,
  type SpendAuthorization,
} from "./finance";
import type { SpatialEntityRef, SpatialPoint3 } from "../spatial/types";
import type { BoundedJunctionAdmissionEvidence, BoundedNetworkJunctionInsert } from "./bounded-network-junction";
import { junctionIdentityFingerprint, junctionReplacementClassFingerprint, junctionReplacementFingerprint, validateBoundedJunctionAdmission } from "./bounded-network-junction";

export type RoadEndpointKind = "EXISTING_NET_NODE" | "NEW_FREE_ENDPOINT";
export type RoadEndpointRole = "START" | "END";
export interface RoadEndpointAttachment {
  kind: RoadEndpointKind;
  role: RoadEndpointRole;
  expectedPosition: SpatialPoint3;
  worldEpoch: string;
  entity?: SpatialEntityRef | null;
  utility?: "ELECTRICITY";
  semanticRole?: "NETWORK_ENTRY";
  geometricContact?: {
    roadEdge: SpatialEntityRef;
    roadNode: SpatialEntityRef;
    position: SpatialPoint3;
    endpointRole: RoadEndpointRole;
  };
  topologyExpectation?: {
    flowNode: SpatialEntityRef;
    roadEdge: SpatialEntityRef;
    expectedReachability: "ELECTRICITY";
  };
}

export interface RoadGeometryInput {
  prefab: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  cx?: number;
  cz?: number;
  e1?: number;
  e2?: number;
  /** Explicit attachments are required for Gate1 ROAD; omitted means a legacy/free endpoint. */
  startEndpoint?: RoadEndpointAttachment;
  endEndpoint?: RoadEndpointAttachment;
  /** Durable junction meaning; never contains generation-local entity IDs. */
  networkJunctionInsert?: BoundedNetworkJunctionInsert;
}

/** Immutable, exact ROAD input shared by preview, quote, admission and Apply. */
export interface CanonicalRoadOperation {
  readonly input: RoadGeometryInput;
  readonly exactInput: string;
}

const canonicalRoadInputs = new WeakSet<object>();

function freezeRoadValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeRoadValue(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalRoadOperation(input: RoadGeometryInput): CanonicalRoadOperation {
  const frozenInput = canonicalRoadInputs.has(input)
    ? input
    : freezeRoadValue(structuredClone(input));
  canonicalRoadInputs.add(frozenInput);
  return Object.freeze({ input: frozenInput, exactInput: stableRoadInput(frozenInput) });
}

/**
 * The real course a road action names.
 *
 * A curved course is not a straight course with a decoration: the control
 * vertex IS part of the authorized geometry, and the native tool prices and
 * attaches the two differently. This lineage's own certified candidate quotes
 * 378 curved and 468 on its chord, and only the curved course passes the
 * attachment precheck -- so a carrier that flattens the course to its chord is
 * not degrading the geometry, it is authorizing a different road.
 *
 * The control point therefore travels whenever the action carries one, in the
 * single shape every downstream carrier (durable scope, authorization binding,
 * ROAD kernel, Bridge request) already agrees on, and a half-specified pair is
 * refused rather than silently dropped.
 */
export function roadCourseGeometry(action: {
  prefab: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  cx?: number;
  cz?: number;
  e1?: number;
  e2?: number;
  networkJunctionInsert?: BoundedNetworkJunctionInsert;
}): RoadGeometryInput {
  const straight: RoadGeometryInput = {
    prefab: action.prefab, x1: action.x1, z1: action.z1, x2: action.x2, z2: action.z2,
    ...(action.e1 === undefined ? {} : { e1: action.e1 }),
    ...(action.e2 === undefined ? {} : { e2: action.e2 }),
    ...(action.networkJunctionInsert ? { networkJunctionInsert: action.networkJunctionInsert } : {}),
  };
  const { cx, cz } = action;
  if (cx === undefined && cz === undefined) return canonicalRoadOperation(straight).input;
  if (cx === undefined || cz === undefined) throw new Error("ROAD_COURSE_CONTROL_POINT_UNPAIRED");
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) throw new Error("ROAD_COURSE_CONTROL_POINT_NOT_FINITE");
  return canonicalRoadOperation({ ...straight, cx, cz }).input;
}

export interface RoadProposal {
  identity: ProposalIdentity;
  quoteId: string;
  fingerprint: string;
  input: RoadGeometryInput;
  owner: RoadAuthorizedMutationScope["owner"];
}

export interface RoadExecutionRequest {
  proposal: RoadProposal;
  quote?: ProposalQuote;
  authorizedMaxSpend: number;
  treasurySafetyReserve: number;
  /** Current native generation. Old generations cannot suppress a new ROAD operation. */
  worldGeneration?: string;
  facilityAccessRoadRepair?: {
    amendmentId: string;
    repairLineage: string;
    planRevision: string;
    actionFingerprint: string;
    actionCount: 1;
    purpose: "Pump native road attachment repair";
    prefab: "Small Road";
    expectedJournalPosition: number;
    expectedWorldId: string;
    expectedCheckpointId: string | null;
    expectedGeneration: string;
  };
  /** Fresh preview witness; runtime refs are checked but never included in durable identity. */
  networkJunctionPreview?: {
    generation: string;
    evidence: BoundedJunctionAdmissionEvidence;
  };
}

export interface RoadExecutionResult {
  command: V2CommandRecord;
  admission: SpendAuthorization;
  bridgeCalled: boolean;
  authorizationConsumed: boolean;
  receipt?: ApplyFinanceReceipt;
  nativeCompletion?: NativeRoadCompletionEvidence;
  effectReport?: RoadEffectReconciliation;
}

export interface V2RoadKernel {
  execute(request: RoadExecutionRequest, signal?: AbortSignal): Promise<RoadExecutionResult>;
  reconcile(commandId: string, signal?: AbortSignal): Promise<RoadExecutionResult>;
}

export interface NativeRoadCompletionEvidence {
  status: "COMPLETED" | "UNKNOWN";
  operation: "ROAD_APPLY";
  commandId: string;
  proposalId: string;
  quoteId: string;
  worldGeneration: string | null;
  applyRequestedFrame: number | null;
  completedFrame: number | null;
  generatedEdgeCount: number;
  generatedNodeCount: number;
  remainingTempEntityCount: number | null;
  resultingPermanentEntities: unknown[];
  raw: unknown;
}

export interface RoadEffectReconciliation {
  matcherResult: EffectMatcherResult;
  effectAbsenceProven: boolean;
  reason: string;
  evidence: unknown;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const bridgeCommandPattern = /^bridge-[0-9a-f]{32}$/i;

function rejectedAuthorization(request: RoadExecutionRequest, reason: string, now: Date): SpendAuthorization {
  return {
    schemaVersion: V2_FINANCE_SCHEMA_VERSION,
    proposalId: request.proposal.identity.proposalId || "unknown",
    quoteId: request.proposal.quoteId || "unknown",
    authorizedMaxSpend: request.authorizedMaxSpend,
    provenance: "PLANNED_RESERVED",
    treasurySafetyReserve: request.treasurySafetyReserve,
    expiry: now.toISOString(),
    decision: "REJECTED",
    reason,
  };
}

function transition(
  journal: V2CommandJournal,
  commandId: string,
  status: V2CommandStatus,
  at: string,
  reason?: string,
  extra: Partial<V2CommandRecord> = {},
): V2CommandRecord {
  return journal.update(commandId, (current) => ({
    ...current,
    ...extra,
    status,
    statusHistory: [...current.statusHistory, { status, at, ...(reason ? { reason } : {}) }],
  }));
}

function proposalError(request: RoadExecutionRequest): string | null {
  const { proposal, quote } = request;
  const exactInput = stableRoadInput(proposal.input);
  if (!proposal.identity.proposalId || proposal.identity.actionFamily !== "ROAD") return "invalid_road_proposal_identity";
  if (!proposal.quoteId) return "missing_quote_identity";
  try {
    const frozenInput = JSON.parse(proposal.identity.exactInput) as RoadGeometryInput;
    if (!sameRoadCourse(frozenInput, proposal.input)) return "OPERATION_DEFINITION_COURSE_MISMATCH";
  } catch {
    // The normal exact-input binding check below rejects malformed identities.
  }
  if (proposal.fingerprint !== exactInput || proposal.identity.exactInput !== exactInput) return "proposal_fingerprint_mismatch";
  const junction = proposal.input.networkJunctionInsert;
  if (junction) {
    const preview = request.networkJunctionPreview;
    if (!preview || !preview.generation) return "BOUNDED_JUNCTION_FRESH_PREVIEW_INCOMPLETE";
    const admission = validateBoundedJunctionAdmission({ contract: junction, evidence: preview.evidence });
    if (!admission.valid) return `BOUNDED_JUNCTION_ADMISSION_REJECTED:${admission.reason}`;
    try {
      roadKernelNativeBuildRequest(proposal.input, proposal.identity.proposalId, proposal.quoteId, preview);
    } catch (error) {
      return error instanceof Error ? error.message : "BOUNDED_JUNCTION_NATIVE_CONTACT_WITNESS_INVALID";
    }
    if (quote && (quote.signedAmount !== preview.evidence.quote || quote.sourceKind !== "NATIVE_TOOL_TEMP_COST")) return "BOUNDED_JUNCTION_QUOTE_WITNESS_MISMATCH";
  } else if (request.networkJunctionPreview) return "BOUNDED_JUNCTION_SEMANTIC_MISSING";
  if (!quote) return null;
  if (quote.proposalId !== proposal.identity.proposalId) return "proposal_id_mismatch";
  if (quote.quoteId !== proposal.quoteId) return "quote_id_mismatch";
  if (quote.exactInput !== exactInput) return "quote_fingerprint_mismatch";
  if (!Number.isFinite(request.authorizedMaxSpend) || request.authorizedMaxSpend < 0) return "authorized_max_spend_invalid";
  if (!Number.isFinite(request.treasurySafetyReserve) || request.treasurySafetyReserve < 0) return "treasury_safety_reserve_invalid";
  return null;
}

function sameRoadCourse(left: RoadGeometryInput, right: RoadGeometryInput): boolean {
  return left.prefab === right.prefab && left.x1 === right.x1 && left.z1 === right.z1 &&
    left.cx === right.cx && left.cz === right.cz && left.x2 === right.x2 && left.z2 === right.z2 &&
    left.e1 === right.e1 && left.e2 === right.e2;
}

export type RoadKernelNativeBuildRequest = RoadGeometryInput & {
  proposalId: string;
  quoteId: string;
  roadOperationKind?: "BOUNDED_NETWORK_JUNCTION_INSERT";
  junctionIdentityFingerprint?: string;
  replacementFingerprint?: string;
  previewOnly?: true;
};

/** The one native ROAD serialization used by authorized Apply and diagnostic preview. */
export function roadKernelNativeBuildRequest(
  input: RoadGeometryInput,
  proposalId: string,
  quoteId: string,
  junctionPreview?: RoadExecutionRequest["networkJunctionPreview"],
  previewOnly = false,
): RoadKernelNativeBuildRequest {
  const { networkJunctionInsert, ...nativeRoadInput } = input;
  if (!networkJunctionInsert) {
    return { ...nativeRoadInput, proposalId, quoteId, ...(previewOnly ? { previewOnly: true } : {}) };
  }
  const generation = junctionPreview?.generation;
  const evidence = junctionPreview?.evidence;
  const contact = evidence?.nativeRoadContact;
  const pumpRoad = evidence?.replacementObservations.find((item) => item.semanticClass === "PUMP_ACCESS_ROAD");
  const validRef = (ref: SpatialEntityRef | undefined) => !!ref && Number.isInteger(ref.index) && ref.index > 0 && Number.isInteger(ref.version) && ref.version > 0;
  if (!generation || !contact || contact.endpointRole !== "START" || !validRef(contact.roadEdge) || !validRef(contact.roadNode) ||
    !pumpRoad || pumpRoad.entity.index !== contact.roadEdge.index || pumpRoad.entity.version !== contact.roadEdge.version ||
    ![contact.position.x, contact.position.y, contact.position.z].every(Number.isFinite) ||
    Math.hypot(contact.position.x - networkJunctionInsert.road.contact.x, contact.position.z - networkJunctionInsert.road.contact.z) > 0.25) {
    throw new Error("BOUNDED_JUNCTION_NATIVE_CONTACT_WITNESS_INVALID");
  }
  return {
    ...nativeRoadInput,
    startEndpoint: {
      kind: "NEW_FREE_ENDPOINT",
      role: "START",
      expectedPosition: contact.position,
      worldEpoch: generation,
      geometricContact: {
        roadEdge: contact.roadEdge,
        roadNode: contact.roadNode,
        position: contact.position,
        endpointRole: "START",
      },
    },
    proposalId,
    quoteId,
    roadOperationKind: "BOUNDED_NETWORK_JUNCTION_INSERT",
    junctionIdentityFingerprint: junctionIdentityFingerprint(networkJunctionInsert),
    replacementFingerprint: evidence ? junctionReplacementFingerprint(evidence.replacementObservations) : undefined,
    ...(previewOnly ? { previewOnly: true } : {}),
  };
}

/** Serialize the diagnostic preview after a fresh live contact rebind. The
 * returned Bridge preview is then independently certified before it can be
 * considered an admitted ROAD proposal. */
export function roadKernelJunctionNativePreviewRequest(
  input: RoadGeometryInput,
  proposalId: string,
  quoteId: string,
  generation: string,
  contact: NonNullable<BoundedJunctionAdmissionEvidence["nativeRoadContact"]>,
): RoadKernelNativeBuildRequest {
  const contract = input.networkJunctionInsert;
  const validRef = (ref: SpatialEntityRef | undefined) => !!ref && Number.isInteger(ref.index) && ref.index > 0 && Number.isInteger(ref.version) && ref.version > 0;
  if (!contract || !generation || contact.endpointRole !== "START" || !validRef(contact.roadEdge) || !validRef(contact.roadNode) ||
    ![contact.position.x, contact.position.y, contact.position.z].every(Number.isFinite) ||
    Math.hypot(contact.position.x - contract.road.contact.x, contact.position.z - contract.road.contact.z) > 0.25) {
    throw new Error("BOUNDED_JUNCTION_NATIVE_CONTACT_WITNESS_INVALID");
  }
  const { networkJunctionInsert: _semantic, ...nativeRoadInput } = input;
  return {
    ...nativeRoadInput,
    startEndpoint: {
      kind: "NEW_FREE_ENDPOINT",
      role: "START",
      expectedPosition: contact.position,
      worldEpoch: generation,
      geometricContact: { ...contact, endpointRole: "START" },
    },
    proposalId,
    quoteId,
    roadOperationKind: contract.kind,
    junctionIdentityFingerprint: junctionIdentityFingerprint(contract),
    replacementFingerprint: junctionReplacementClassFingerprint(contract.replacementClasses),
    previewOnly: true,
  };
}

function authorizationKey(request: RoadExecutionRequest): string {
  const { identity } = request.proposal;
  return [identity.proposalId, request.proposal.quoteId, request.proposal.fingerprint, identity.runtimeEpoch, identity.frame].join("|");
}

function roadScope(request: RoadExecutionRequest): RoadAuthorizedMutationScope {
  const quote = request.quote;
  const repair = request.facilityAccessRoadRepair;
  const junction = request.proposal.input.networkJunctionInsert;
  const junctionPreview = request.networkJunctionPreview;
  return {
    owner: request.proposal.owner,
    actionFamily: "ROAD",
    proposalId: request.proposal.identity.proposalId,
    quoteId: request.proposal.quoteId,
    fingerprint: request.proposal.fingerprint,
    exactInput: request.proposal.identity.exactInput,
    ...(request.worldGeneration ?? request.networkJunctionPreview?.generation
      ? { worldGeneration: request.worldGeneration ?? request.networkJunctionPreview?.generation }
      : {}),
    budget: {
      authorizedMaxSpend: request.authorizedMaxSpend,
      treasurySafetyReserve: request.treasurySafetyReserve,
      currency: "GAME_MONEY",
    },
    observationPrecondition: {
      runtimeEpoch: request.proposal.identity.runtimeEpoch,
      frame: request.proposal.identity.frame,
    },
    expiresAt: quote?.expiresAt ?? new Date(0).toISOString(),
    ...(repair ? { facilityAccessRoadRepair: {
      amendmentId: repair.amendmentId,
      repairLineage: repair.repairLineage,
      planRevision: repair.planRevision,
      actionFingerprint: repair.actionFingerprint,
      actionCount: 1,
      purpose: repair.purpose,
      prefab: repair.prefab,
    } } : {}),
    ...(junction && junctionPreview ? { networkJunctionInsert: {
      operationKind: junction.kind,
      identityFingerprint: junctionIdentityFingerprint(junction),
      replacementFingerprint: junctionPreview.evidence.replacementFingerprint,
    } } : {}),
  };
}

function receiptFromBridge(
  raw: unknown,
  request: RoadExecutionRequest,
  observation: FinanceObservation,
): { receipt?: ApplyFinanceReceipt; commandId?: string; nativeCompletion?: NativeRoadCompletionEvidence; reason?: string; rejectionDiagnostics?: unknown; bridgeHttpErrorDiagnostics?: unknown } {
  const response = record(raw);
  const finance = record(response.finance);
  const commandId = typeof response.commandId === "string" ? response.commandId : "";
  const rejectionDiagnostics = response.rejectionDiagnostics;
  const bridgeHttpErrorDiagnostics = response.bridgeHttpErrorDiagnostics;
  if (response.accepted !== true && response.placed !== true)
    return {
      reason: String(response.error ?? "native ROAD execution was not acknowledged"),
      ...(rejectionDiagnostics !== undefined ? { rejectionDiagnostics } : {}),
      ...(bridgeHttpErrorDiagnostics !== undefined ? { bridgeHttpErrorDiagnostics } : {}),
    };
  if (!bridgeCommandPattern.test(commandId)) return { reason: "successful ROAD response omitted a valid Bridge commandId" };
  if (response.proposalId !== request.proposal.identity.proposalId || response.quoteId !== request.proposal.quoteId)
    return { commandId, reason: "Bridge response proposal/quote identity mismatch" };
  if (
    finance.proposalId !== request.proposal.identity.proposalId ||
    finance.quoteId !== request.proposal.quoteId ||
    finance.apply !== true ||
    finance.state !== "VALID" ||
    finance.provenance !== "OBSERVED_NATIVE" ||
    finance.sourceKind !== "NATIVE_TOOL_TEMP_COST" ||
    finance.attribution !== "BOUNDED_ATTRIBUTION" ||
    typeof finance.signedAmount !== "number" ||
    !Number.isFinite(finance.signedAmount) ||
    typeof finance.frame !== "number" ||
    !Number.isFinite(finance.frame) ||
    typeof finance.eligibleTempEntityCount !== "number" ||
    !Number.isInteger(finance.eligibleTempEntityCount) ||
    finance.eligibleTempEntityCount <= 0
  ) {
    return { commandId, reason: "Bridge finance receipt was incomplete or uncorrelated" };
  }
  if (Math.max(0, finance.signedAmount) > request.authorizedMaxSpend)
    return { commandId, reason: "native receipt exceeded AUTHORIZED_MAX_SPEND" };
  if (!request.quote || finance.signedAmount !== request.quote.signedAmount)
    return { commandId, reason: "native receipt did not match the authorized quote" };
  const completion = record(response.nativeCompletion);
  let nativeCompletion: NativeRoadCompletionEvidence | undefined;
  if (Object.keys(completion).length > 0) {
    const status = completion.status === "COMPLETED" ? "COMPLETED" : "UNKNOWN";
    const validIdentity =
      completion.operation === "ROAD_APPLY" &&
      completion.commandId === commandId &&
      completion.proposalId === request.proposal.identity.proposalId &&
      completion.quoteId === request.proposal.quoteId;
    const validCompletion =
      status === "COMPLETED" &&
      validIdentity &&
      typeof completion.worldGeneration === "string" &&
      completion.worldGeneration.length > 0 &&
      finiteNumber(completion.applyRequestedFrame) !== null &&
      finiteNumber(completion.completedFrame) !== null &&
      Number.isInteger(completion.generatedEdgeCount) &&
      Number(completion.generatedEdgeCount) > 0 &&
      Number.isInteger(completion.generatedNodeCount) &&
      completion.remainingTempEntityCount === 0;
    nativeCompletion = {
      status: validCompletion ? "COMPLETED" : "UNKNOWN",
      operation: "ROAD_APPLY",
      commandId,
      proposalId: request.proposal.identity.proposalId,
      quoteId: request.proposal.quoteId,
      worldGeneration: typeof completion.worldGeneration === "string" ? completion.worldGeneration : null,
      applyRequestedFrame: finiteNumber(completion.applyRequestedFrame),
      completedFrame: finiteNumber(completion.completedFrame),
      generatedEdgeCount: Number.isInteger(completion.generatedEdgeCount) ? Number(completion.generatedEdgeCount) : 0,
      generatedNodeCount: Number.isInteger(completion.generatedNodeCount) ? Number(completion.generatedNodeCount) : 0,
      remainingTempEntityCount: Number.isInteger(completion.remainingTempEntityCount)
        ? Number(completion.remainingTempEntityCount)
        : null,
      resultingPermanentEntities: Array.isArray(completion.resultingPermanentEntities)
        ? completion.resultingPermanentEntities
        : [],
      raw: completion,
    };
  }
  return {
    commandId,
    nativeCompletion,
    receipt: {
      schemaVersion: V2_FINANCE_SCHEMA_VERSION,
      commandId,
      proposalId: request.proposal.identity.proposalId,
      quoteId: request.proposal.quoteId,
      actionFamily: "ROAD",
      applyFrame: finance.frame,
      signedAppliedAmount: finance.signedAmount,
      applySetIdentity: `${commandId}:${request.proposal.identity.proposalId}:${request.proposal.quoteId}:${finance.frame}`,
      applySetCount: finance.eligibleTempEntityCount,
      unlimitedMoney: observation.unlimitedMoney,
      completionState: nativeCompletion?.status === "COMPLETED" ? "COMPLETED" : "UNKNOWN",
      attribution: "BOUNDED_ATTRIBUTION",
    },
  };
}

export function createV2RoadKernel(options: {
  journal: V2CommandJournal;
  observeFinance(signal?: AbortSignal): Promise<FinanceObservation | undefined>;
  submit(input: RoadKernelNativeBuildRequest, signal?: AbortSignal): Promise<unknown>;
  observation?: V2ObservationPorts;
  effectMatcher?: RoadEffectMatcher;
  now?: () => Date;
  createId?: () => string;
  persistCreatedCommand?(record: V2CommandRecord, request: RoadExecutionRequest): V2CommandRecord;
}): V2RoadKernel {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const consumedAuthorizations = new Set<string>();
  const mutex = Mutex.create();

  const reconcile = async (commandId: string, signal?: AbortSignal): Promise<RoadExecutionResult> => {
    const current = options.journal.get(commandId);
    if (!current) throw new Error(`unknown ROAD command: ${commandId}`);
    const roadScope = current.authorizedScope.actionFamily === "ROAD" ? current.authorizedScope : null;
    const unavailableAdmission: SpendAuthorization = roadScope
      ? {
          schemaVersion: V2_FINANCE_SCHEMA_VERSION,
          proposalId: roadScope.proposalId,
          quoteId: roadScope.quoteId,
          authorizedMaxSpend: roadScope.budget.authorizedMaxSpend,
          provenance: "PLANNED_RESERVED",
          treasurySafetyReserve: roadScope.budget.treasurySafetyReserve,
          expiry: roadScope.expiresAt,
          decision: "AUTHORIZED",
          reason: "read-only reconciliation reuses the original admitted command identity",
        }
      : rejectedAuthorization(
          {
            proposal: {
              identity: { proposalId: "unknown", actionFamily: "ROAD", exactInput: "", runtimeEpoch: "", frame: 0, validationState: "INVALID" },
              quoteId: "unknown",
              fingerprint: "",
              input: { prefab: "unknown", x1: 0, z1: 0, x2: 0, z2: 0 },
              owner: current.authorizedScope.owner,
            },
            authorizedMaxSpend: 0,
            treasurySafetyReserve: 0,
          },
          "command_is_not_a_ROAD_execution",
          now(),
        );
    if (!options.observation || !options.effectMatcher || current.authorizedScope.actionFamily !== "ROAD") {
      return { command: current, admission: unavailableAdmission, bridgeCalled: false, authorizationConsumed: false };
    }
    let exact: RoadGeometryInput;
    try {
      exact = JSON.parse(current.authorizedScope.exactInput) as RoadGeometryInput;
    } catch {
      const reason = "durable ROAD exact input is malformed";
      return {
        command: options.journal.update(commandId, (record) => ({
          ...record,
          reconciliationStatus: "INCONCLUSIVE",
          failureOrUnknownReason: reason,
        })),
        admission: unavailableAdmission,
        bridgeCalled: false,
        authorizationConsumed: false,
      };
    }
    const center = { x: (exact.x1 + exact.x2) / 2, z: (exact.z1 + exact.z2) / 2 };
    // Which extra non-road listings this matcher needs is the matcher's own
    // answer, asked before the world is read: a ROAD course answers from the
    // road graph and asks for nothing, so its observation is byte-for-byte the
    // one it has always been given.
    const netEdgePrefabs = options.effectMatcher.netEdgePrefabs?.(current) ?? null;
    const envelope = await options.observation.capture({
      spatialDetail: observationRequestForZoning({ spatialEnvelope: { center, radius: Math.max(64, Math.hypot(exact.x2 - exact.x1, exact.z2 - exact.z1) + 16) } }),
      ...(netEdgePrefabs && netEdgePrefabs.length > 0 ? { netEdgePrefabs } : {}),
      signal,
    });
    const matched = options.effectMatcher.match({ command: current, observation: envelope });
    const effectReport: RoadEffectReconciliation = {
      matcherResult: matched.result,
      effectAbsenceProven: matched.effectAbsenceProven,
      reason: matched.reason,
      evidence: matched.evidence,
    };
    const at = now().toISOString();
    const evidence: CommandObservationEvidence = {
      phase: "RECONCILIATION",
      observationId: envelope.observationId,
      coherence: envelope.coherence,
      recordedAt: at,
      summary: matched.reason,
      details: matched.evidence,
    };
    const command =
      matched.result === "MATCH"
        ? transition(options.journal, commandId, "OBSERVED_MATCH", at, matched.reason, {
            reconciliationStatus: "MATCH",
            observationEvidence: [...current.observationEvidence, evidence],
            failureOrUnknownReason: null,
            effectAbsenceProven: false,
          })
        : matched.result === "MISMATCH" && matched.effectAbsenceProven
          ? transition(options.journal, commandId, "OBSERVED_MISMATCH", at, matched.reason, {
              reconciliationStatus: "MISMATCH",
              observationEvidence: [...current.observationEvidence, evidence],
              failureOrUnknownReason: matched.reason,
              effectAbsenceProven: true,
            })
          : options.journal.update(commandId, (record) => ({
              ...record,
              reconciliationStatus: "INCONCLUSIVE",
              observationEvidence: [...record.observationEvidence, evidence],
              failureOrUnknownReason: matched.reason,
            }));
    return {
      command,
      admission: unavailableAdmission,
      bridgeCalled: false,
      authorizationConsumed: false,
      effectReport,
    };
  };

  return {
    reconcile,
    async execute(request, signal) {
      await mutex.acquire(signal);
      const canonical = canonicalRoadOperation(request.proposal.input);
      request = { ...request, proposal: { ...request.proposal, input: canonical.input } };
      let executionId = createId();
      const createdAt = now().toISOString();
      const createdRecord: V2CommandRecord = {
        schemaVersion: V2_COMMAND_SCHEMA_VERSION,
        commandId: executionId,
        actionFamily: "ROAD",
        actionType: "build_road",
        authorizedScope: roadScope(request),
        bridgeCommandId: null,
        createdAt,
        submittedAt: null,
        nativeResultSummary: null,
        status: "CREATED",
        statusHistory: [{ status: "CREATED", at: createdAt }],
        reconciliationStatus: "NOT_STARTED",
        observationEvidence: [],
        failureOrUnknownReason: null,
        effectAbsenceProven: false,
      };
      const deferredRepairCommit = !!request.facilityAccessRoadRepair;
      const deferredJunctionCommit = !!request.proposal.input.networkJunctionInsert;
      const junctionExactInput = request.proposal.identity.exactInput;
      const priorJunctionCommand = deferredJunctionCommit
        ? options.journal.list().find((entry) => entry.actionFamily === "ROAD" &&
          entry.authorizedScope.actionFamily === "ROAD" && entry.authorizedScope.exactInput === junctionExactInput &&
          !!request.worldGeneration && entry.authorizedScope.worldGeneration === request.worldGeneration &&
          entry.authorizedScope.networkJunctionInsert?.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT")
        : undefined;
      let admission = rejectedAuthorization(request, "admission_unavailable", now());
      let bridgeCalled = false;
      let authorizationConsumed = false;
      try {
        if (priorJunctionCommand) {
          return {
            command: priorJunctionCommand,
            admission: rejectedAuthorization(request, "bounded_junction_operation_already_recorded", now()),
            bridgeCalled: false,
            authorizationConsumed: false,
          };
        }
        if (!deferredRepairCommit && !deferredJunctionCommit) options.journal.create(createdRecord);
        const identityError = proposalError(request);
        if (identityError) admission = rejectedAuthorization(request, identityError, now());
        else {
          let observation: FinanceObservation | undefined;
          try {
            observation = await options.observeFinance(signal);
          } catch {
            observation = undefined;
          }
          if (!observation) admission = rejectedAuthorization(request, "treasury_observation_unavailable", now());
          else {
            admission = authorizeSpend({
              observation,
              quote: request.quote,
              requiredGrossSpend: Math.max(0, request.quote?.signedAmount ?? Number.POSITIVE_INFINITY),
              authorizedMaxSpend: request.authorizedMaxSpend,
              treasurySafetyReserve: request.treasurySafetyReserve,
              now: now(),
              ...(request.proposal.input.networkJunctionInsert ? { operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT" as const } : {}),
            });
            if (admission.decision === "AUTHORIZED") {
              const key = authorizationKey(request);
              if (consumedAuthorizations.has(key)) {
                admission = rejectedAuthorization(request, "authorization_already_consumed", now());
              } else {
                consumedAuthorizations.add(key);
                authorizationConsumed = true;
                if (deferredRepairCommit) {
                  if (!options.persistCreatedCommand) throw new Error("FACILITY_ACCESS_ROAD_DURABLE_COMMIT_UNAVAILABLE");
                  const persisted = options.persistCreatedCommand(createdRecord, request);
                  if (persisted.status !== "CREATED") throw new Error("FACILITY_ACCESS_ROAD_COMMAND_ALREADY_SUBMITTED");
                  executionId = persisted.commandId;
                } else if (deferredJunctionCommit) {
                  if (!options.persistCreatedCommand) throw new Error("BOUNDED_JUNCTION_DURABLE_COMMAND_COMMIT_UNAVAILABLE");
                  const persisted = options.persistCreatedCommand(createdRecord, request);
                  if (persisted.status !== "CREATED") throw new Error("BOUNDED_JUNCTION_COMMAND_ALREADY_SUBMITTED");
                  executionId = persisted.commandId;
                }
                transition(options.journal, executionId, "AUTHORIZED", now().toISOString());
                const submittedAt = now().toISOString();
                transition(options.journal, executionId, "SUBMITTED", submittedAt, undefined, { submittedAt });
                bridgeCalled = true;
                let raw: unknown;
                try {
                  raw = await options.submit(
                    roadKernelNativeBuildRequest(
                      request.proposal.input,
                      request.proposal.identity.proposalId,
                      request.proposal.quoteId,
                      request.networkJunctionPreview,
                    ),
                    signal,
                  );
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  return {
                    command: transition(options.journal, executionId, "UNKNOWN_TRANSPORT", now().toISOString(), reason, {
                      failureOrUnknownReason: reason,
                    }),
                    admission,
                    bridgeCalled,
                    authorizationConsumed,
                  };
                }
                const correlated = receiptFromBridge(raw, request, observation);
                if (!correlated.receipt) {
                  const reason = correlated.reason ?? "native ROAD execution did not produce a correlated receipt";
                  return {
                    command: transition(options.journal, executionId, "REJECTED", now().toISOString(), reason, {
                      bridgeCommandId: correlated.commandId ?? null,
                      failureOrUnknownReason: reason,
                      ...((correlated.rejectionDiagnostics !== undefined || correlated.bridgeHttpErrorDiagnostics !== undefined)
                        ? { evidence: {
                            ...(correlated.rejectionDiagnostics !== undefined ? { rejectionDiagnostics: correlated.rejectionDiagnostics } : {}),
                            ...(correlated.bridgeHttpErrorDiagnostics !== undefined ? { bridgeHttpErrorDiagnostics: correlated.bridgeHttpErrorDiagnostics } : {}),
                          } }
                        : {}),
                    }),
                    admission,
                    bridgeCalled,
                    authorizationConsumed,
                  };
                }
                const acknowledged = transition(options.journal, executionId, "COMMIT_ACK", now().toISOString(), "correlated native ROAD receipt", {
                    bridgeCommandId: correlated.receipt.commandId,
                    nativeResultSummary: `ROAD receipt ${correlated.receipt.signedAppliedAmount}`,
                    reconciliationStatus: "NOT_STARTED",
                    nativeCompletionEvidence: correlated.nativeCompletion,
                  });
                if (correlated.nativeCompletion?.status !== "COMPLETED") {
                  const command = correlated.nativeCompletion
                    ? transition(options.journal, executionId, "NATIVE_COMPLETION_UNKNOWN", now().toISOString(), "Bridge could not certify native ROAD completion", {
                        failureOrUnknownReason: "Bridge could not certify native ROAD completion",
                      })
                    : acknowledged;
                  return {
                    command,
                    admission,
                    bridgeCalled,
                    authorizationConsumed,
                    receipt: correlated.receipt,
                    nativeCompletion: correlated.nativeCompletion,
                  };
                }
                transition(options.journal, executionId, "NATIVE_COMPLETED", now().toISOString(), "Bridge certified native ROAD tool completion", {
                  nativeCompletionEvidence: correlated.nativeCompletion,
                });
                const reconciled = await reconcile(executionId, signal);
                return {
                  ...reconciled,
                  admission,
                  bridgeCalled,
                  authorizationConsumed,
                  receipt: correlated.receipt,
                  nativeCompletion: correlated.nativeCompletion,
                };
              }
            }
          }
        }
        const failureAt = now().toISOString();
        const failedRecord = deferredRepairCommit || deferredJunctionCommit
          ? { ...createdRecord, status: "FAILED_BEFORE_SUBMIT" as const,
              failureOrUnknownReason: admission.reason,
              statusHistory: [...createdRecord.statusHistory, { status: "FAILED_BEFORE_SUBMIT" as const, at: failureAt, reason: admission.reason }] }
          : transition(options.journal, executionId, "FAILED_BEFORE_SUBMIT", failureAt, admission.reason, {
              failureOrUnknownReason: admission.reason,
            });
        return {
          command: failedRecord,
          admission,
          bridgeCalled,
          authorizationConsumed,
        };
      } finally {
        await mutex.release();
      }
    },
  };
}
