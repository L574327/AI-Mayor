import { V2_FINANCE_SCHEMA_VERSION, stableRoadInput, type ProposalQuote } from "./finance";
import { junctionIdentityFingerprint, junctionReplacementFingerprint, validateBoundedJunctionAdmission, type BoundedJunctionAdmissionEvidence } from "./bounded-network-junction";
import { canonicalRoadOperation, roadKernelJunctionNativePreviewRequest, roadKernelNativeBuildRequest, type RoadExecutionRequest, type RoadExecutionResult, type RoadGeometryInput, type RoadKernelNativeBuildRequest, type V2RoadKernel } from "./road-kernel";

export const ROAD_EXECUTION_TRUTH_CONTRACT = "cs2mcp-road-execution-truth/1";

export interface RuntimeRoadAuthorization {
  authorizedMaxSpend: number;
  treasurySafetyReserve: number;
}

export interface RuntimeRoadTask {
  input: RoadGeometryInput;
  owner: { ownerType: "TASK" | "MANUAL"; ownerId: string };
}

export interface V2RuntimeRoadCaller {
  execute(task: RuntimeRoadTask, signal?: AbortSignal): Promise<RoadExecutionResult>;
  previewJunctionNative(task: RuntimeRoadTask, signal?: AbortSignal): Promise<{
    preflight: unknown;
    buildRequest: RoadKernelNativeBuildRequest;
    preview: unknown;
    quote: ProposalQuote;
    junctionPreview: NonNullable<RoadExecutionRequest["networkJunctionPreview"]>;
  }>;
}

export type NativeRoadPreviewFailure = "REJECTED" | "UNKNOWN";
export const NATIVE_BUILD_SLOT_BUSY = "WAITING_FOR_NATIVE_BUILD_SLOT";

export function isTransientNativeBuildBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /another build operation is in progress, retry shortly/i.test(message);
}
export type NativeRoadDiagnosticClassification =
  | "REJECTED_WITH_NATIVE_ERRORS"
  | "REJECTED_STRUCTURAL"
  | "REJECTED_NO_DETAIL"
  | "UNKNOWN";

export interface NativeRoadValidationError {
  errorType: string | number;
  severity: string | number;
  toolError?: string | number;
  /** The world position the game flagged, when it named one. */
  atX?: string | number;
  atZ?: string | number;
}

export interface NativeRoadStructuralEvidence {
  generatedEdge?: boolean;
  essentialTempValid?: boolean;
  originalDeleted?: boolean;
}

export interface NativeRoadDiagnostics {
  classification: NativeRoadDiagnosticClassification;
  validation?: { status: "REJECTED"; detailAvailable: boolean; errors?: NativeRoadValidationError[] };
  structural?: NativeRoadStructuralEvidence;
  request?: Record<string, unknown>;
  realization?: Record<string, unknown>;
  errorDataStatus?: string;
}

export const STARTER_PRODUCTIVE_ROAD_LENGTHS_METERS = [16, 25] as const;

export interface ProductiveStarterRoadPreview {
  input: RoadGeometryInput;
  preview: unknown;
  quote: ProposalQuote;
  selectedLengthMeters: number;
  attemptedLengthsMeters: number[];
}

export interface RoadQuoteDiagnosticContext {
  roadTaskId?: string;
  roadChildId?: string;
  atomicOperationId?: string;
}

export type RoadQuotePredicateStatus = "PASS" | "FAIL" | "NOT_EVALUATED";

export interface RoadQuoteContractDiagnostics {
  firstFailedQuoteRequirement: string;
  allEvaluatedFailedRequirements: string[];
  predicateStatus: Record<string, RoadQuotePredicateStatus>;
  roadTaskId: string | null;
  roadChildId: string | null;
  atomicOperationId: string | null;
  productionPreviewRequest: {
    prefab: string;
    geometry: Pick<RoadGeometryInput, "x1" | "z1" | "cx" | "cz" | "x2" | "z2" | "e1" | "e2">;
    stableInput: string;
  };
  actual: Record<string, string | number | boolean | null>;
  failedComparison: { expected: string | number | boolean; actual: string | number | boolean | null };
}

export class RoadQuoteContractError extends Error {
  readonly diagnostics: RoadQuoteContractDiagnostics;

  constructor(diagnostics: RoadQuoteContractDiagnostics) {
    super("native ROAD preview did not return a correlated authoritative quote");
    this.name = "RoadQuoteContractError";
    this.diagnostics = diagnostics;
  }
}

const boundedScalar = (value: unknown): string | number | undefined =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;

export function normalizeNativeRoadDiagnostics(value: unknown): NativeRoadDiagnostics | undefined {
  const response = record(value);
  const validation = record(response.validation);
  const errors: NativeRoadValidationError[] = [];
  for (const raw of (Array.isArray(validation.errors) ? validation.errors : []).slice(0, 16)) {
    const item = record(raw);
    const errorType = boundedScalar(item.errorType ?? item.type);
    const severity = boundedScalar(item.severity);
    if (errorType === undefined || severity === undefined) continue;
    const toolError = boundedScalar(item.toolError ?? item.toolErrorName ?? item.toolErrorId);
    errors.push({ errorType, severity, ...(toolError === undefined ? {} : { toolError }) });
  }
  // The game's OWN reasons, which the Bridge already returns and this side used
  // to read only as "some native evidence exists". Each entry carries the native
  // `ErrorType`, the offending position and the offending entity — the only
  // authoritative answer to *why* a course was refused, and the input a planner
  // needs to route around it. Parsed bounded, and never invented.
  for (const raw of (Array.isArray(response.nativeToolErrors) ? response.nativeToolErrors : []).slice(0, 16)) {
    const item = record(raw);
    const errorType = boundedScalar(item.errorType);
    if (errorType === undefined) continue;
    const prefab = record(item.errorPrefab);
    const toolError = boundedScalar(prefab.name ?? item.toolErrorName);
    const position = record(item.position);
    const x = boundedScalar(position.x);
    const z = boundedScalar(position.z);
    errors.push({
      errorType,
      severity: "NATIVE_TOOL_ERROR",
      ...(toolError === undefined ? {} : { toolError }),
      ...(x === undefined || z === undefined ? {} : { atX: x, atZ: z }),
    });
  }
  const rawStructural = record(response.structural);
  const structural: NativeRoadStructuralEvidence = {};
  for (const key of ["generatedEdge", "essentialTempValid", "originalDeleted"] as const) {
    if (typeof rawStructural[key] === "boolean") structural[key] = rawStructural[key];
  }
  const hasStructural = Object.keys(structural).length > 0;
  const layered = record(response.diagnostics);
  const layeredValidation = record(layered.validation);
  const diagnosticStatus = typeof layeredValidation.diagnosticStatus === "string" ? layeredValidation.diagnosticStatus : typeof validation.diagnosticStatus === "string" ? validation.diagnosticStatus : undefined;
  const detailUnavailable = diagnosticStatus === "DIAGNOSTIC_ERRORDATA_READ_FAILED";
  const status = validation.status === "REJECTED" ? "REJECTED" : undefined;
  const detailAvailable = validation.detailAvailable === true || validation.validationDetailAvailable === true;
  if (status !== "REJECTED" && !hasStructural && errors.length === 0) return undefined;
  return {
    classification: errors.length > 0 && !detailUnavailable ? "REJECTED_WITH_NATIVE_ERRORS" : hasStructural ? "REJECTED_STRUCTURAL" : "REJECTED_NO_DETAIL",
    ...(status === "REJECTED" || detailAvailable || errors.length > 0 || diagnosticStatus ? { validation: { status: "REJECTED", detailAvailable: detailAvailable && !detailUnavailable, ...(detailUnavailable ? {} : { errors }) } as NativeRoadDiagnostics["validation"] } : {}),
    ...(hasStructural ? { structural } : {}),
    ...(layered.request ? { request: layered.request } : {}),
    ...(layered.realization ? { realization: layered.realization } : {}),
    ...(diagnosticStatus ? { errorDataStatus: diagnosticStatus } : {}),
  };
}

export function classifyNativeRoadDiagnosticFailure(error: unknown): NativeRoadDiagnosticClassification {
  const candidate = error instanceof Error ? (error as Error & { nativeRoadDiagnostics?: NativeRoadDiagnostics }).nativeRoadDiagnostics : undefined;
  if (candidate) return candidate.classification;
  const message = error instanceof Error ? error.message : String(error);
  const details = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  // These are explicit Bridge validation failures raised before CreationDefinition
  // and before any ROAD command is submitted. They are definite rejections, not
  // uncertain execution outcomes.
  if (/\bROAD_ENDPOINT_WORLD_EPOCH_MISMATCH\b/.test(message)) return "REJECTED_NO_DETAIL";
  const bridgeDiagnostics = details.bridgeHttpErrorDiagnostics;
  const hasNativeValidationEvidence = (Array.isArray(details.nativeToolErrors) && details.nativeToolErrors.length > 0) ||
    (typeof bridgeDiagnostics === "object" && bridgeDiagnostics !== null);
  if (Number(details.status) === 409 && hasNativeValidationEvidence && /validation|rejected|blocked/i.test(message)) {
    return "REJECTED_NO_DETAIL";
  }
  return /(?:HTTP\s*)?409\b/.test(message) && /validation|rejected|blocked/i.test(message) ? "REJECTED_NO_DETAIL" : "UNKNOWN";
}

/** Classifies only an explicit native validation rejection as definite. */
export function classifyNativeRoadPreviewFailure(error: unknown): NativeRoadPreviewFailure {
  return classifyNativeRoadDiagnosticFailure(error) === "UNKNOWN" ? "UNKNOWN" : "REJECTED";
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function nativeRoadQuoteFromPreview(
  value: unknown,
  input: RoadGeometryInput,
  now: Date,
  diagnosticContext: RoadQuoteDiagnosticContext = {},
): ProposalQuote {
  const response = record(value);
  const finance = record(response.finance);
  const exactInput = stableRoadInput(input);
  const junction = input.networkJunctionInsert;
  const junctionMetadata = record(response.junctionOperation);
  const junctionPreviewValid = junction
    ? response.roadOperationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
      junctionMetadata.identityFingerprint === junctionIdentityFingerprint(junction) &&
      junctionMetadata.nativeAllowApply === true &&
      junctionMetadata.nativeCostSource === "NATIVE_TOOL_TEMP_COST" &&
      junctionMetadata.nativeTempCount === finance.eligibleTempEntityCount &&
      typeof junctionMetadata.replacementFingerprint === "string" && junctionMetadata.replacementFingerprint.length > 0
    : response.validNewRoadProposal === true;
  const scalar = (candidate: unknown): string | number | boolean | null => {
    if (candidate === null) return null;
    if (typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    return candidate === undefined ? "<unavailable>" : "<non-scalar>";
  };
  const requirements: Array<{
    id: string;
    expected: string | number | boolean;
    actual: () => unknown;
    pass: () => boolean;
  }> = [
    { id: "VALID_TRUE", expected: true, actual: () => response.valid, pass: () => response.valid === true },
    { id: "PREVIEW_ONLY_TRUE", expected: true, actual: () => response.previewOnly, pass: () => response.previewOnly === true },
    { id: "ROAD_EXECUTION_CONTRACT_MATCH", expected: ROAD_EXECUTION_TRUTH_CONTRACT, actual: () => response.roadExecutionContract, pass: () => response.roadExecutionContract === ROAD_EXECUTION_TRUTH_CONTRACT },
    { id: junction ? "JUNCTION_PREVIEW_VALID" : "VALID_NEW_ROAD_PROPOSAL_TRUE", expected: true, actual: () => junction ? junctionPreviewValid : response.validNewRoadProposal, pass: () => junction ? junctionPreviewValid : response.validNewRoadProposal === true },
    { id: "PROPOSAL_ID_NONEMPTY_STRING", expected: "nonempty string", actual: () => response.proposalId, pass: () => typeof response.proposalId === "string" && response.proposalId.length > 0 },
    { id: "QUOTE_ID_NONEMPTY_STRING", expected: "nonempty string", actual: () => response.quoteId, pass: () => typeof response.quoteId === "string" && response.quoteId.length > 0 },
    { id: "FINANCE_STATE_VALID", expected: "VALID", actual: () => finance.state, pass: () => finance.state === "VALID" },
    { id: "FINANCE_PROPOSAL_ID_MATCH", expected: scalar(response.proposalId), actual: () => finance.proposalId, pass: () => finance.proposalId === response.proposalId },
    { id: "FINANCE_QUOTE_ID_MATCH", expected: scalar(response.quoteId), actual: () => finance.quoteId, pass: () => finance.quoteId === response.quoteId },
    { id: "FINANCE_PROVENANCE_NATIVE", expected: "OBSERVED_NATIVE", actual: () => finance.provenance, pass: () => finance.provenance === "OBSERVED_NATIVE" },
    { id: "FINANCE_SOURCE_NATIVE_TEMP_COST", expected: "NATIVE_TOOL_TEMP_COST", actual: () => finance.sourceKind, pass: () => finance.sourceKind === "NATIVE_TOOL_TEMP_COST" },
    { id: "SIGNED_AMOUNT_FINITE_NUMBER", expected: "finite number", actual: () => finance.signedAmount, pass: () => typeof finance.signedAmount === "number" && Number.isFinite(finance.signedAmount) },
    { id: "ELIGIBLE_TEMP_COUNT_POSITIVE_INTEGER", expected: "positive integer", actual: () => finance.eligibleTempEntityCount, pass: () => typeof finance.eligibleTempEntityCount === "number" && Number.isInteger(finance.eligibleTempEntityCount) && finance.eligibleTempEntityCount > 0 },
    { id: "ORDINARY_ROAD_SIGNED_AMOUNT_NONZERO", expected: junction ? "junction may be zero" : "nonzero", actual: () => finance.signedAmount, pass: () => finance.signedAmount !== 0 || !!junction },
    { id: "RUNTIME_EPOCH_NONEMPTY_STRING", expected: "nonempty string", actual: () => finance.runtimeEpoch, pass: () => typeof finance.runtimeEpoch === "string" && finance.runtimeEpoch.length > 0 },
    { id: "FRAME_NONNEGATIVE_INTEGER", expected: "nonnegative integer", actual: () => finance.frame, pass: () => typeof finance.frame === "number" && Number.isInteger(finance.frame) && finance.frame >= 0 },
  ];
  const predicateStatus: Record<string, RoadQuotePredicateStatus> = {};
  for (const [index, requirement] of requirements.entries()) {
    if (!requirement.pass()) {
      for (let prior = index + 1; prior < requirements.length; prior += 1) {
        predicateStatus[requirements[prior].id] = "NOT_EVALUATED";
      }
      const actual = scalar(requirement.actual());
      predicateStatus[requirement.id] = "FAIL";
      const geometry = {
        x1: input.x1, z1: input.z1, ...(input.cx !== undefined ? { cx: input.cx } : {}),
        ...(input.cz !== undefined ? { cz: input.cz } : {}), x2: input.x2, z2: input.z2,
        ...(input.e1 !== undefined ? { e1: input.e1 } : {}), ...(input.e2 !== undefined ? { e2: input.e2 } : {}),
      };
      const diagnosticActual: Record<string, string | number | boolean | null> = {
        valid: scalar(response.valid), previewOnly: scalar(response.previewOnly),
        toolAllowApply: scalar(response.toolAllowApply), validNewRoadProposal: scalar(response.validNewRoadProposal),
        roadExecutionContract: scalar(response.roadExecutionContract), proposalId: scalar(response.proposalId), quoteId: scalar(response.quoteId),
        financeState: scalar(finance.state), financeProposalId: scalar(finance.proposalId), financeQuoteId: scalar(finance.quoteId),
        financeProvenance: scalar(finance.provenance), financeSourceKind: scalar(finance.sourceKind),
        financeSignedAmount: scalar(finance.signedAmount), eligibleTempEntityCount: scalar(finance.eligibleTempEntityCount),
        runtimeEpoch: scalar(finance.runtimeEpoch), frame: scalar(finance.frame),
      };
      throw new RoadQuoteContractError({
        firstFailedQuoteRequirement: requirement.id,
        allEvaluatedFailedRequirements: [requirement.id],
        predicateStatus: { ...Object.fromEntries(requirements.slice(0, index).map((entry) => [entry.id, "PASS" as const])), ...predicateStatus },
        roadTaskId: diagnosticContext.roadTaskId ?? null,
        roadChildId: diagnosticContext.roadChildId ?? null,
        atomicOperationId: diagnosticContext.atomicOperationId ?? null,
        productionPreviewRequest: { prefab: input.prefab, geometry, stableInput: exactInput },
        actual: diagnosticActual,
        failedComparison: { expected: requirement.expected, actual },
      });
    }
    predicateStatus[requirement.id] = "PASS";
  }
  return {
    schemaVersion: V2_FINANCE_SCHEMA_VERSION,
    proposalId: response.proposalId,
    quoteId: response.quoteId,
    actionFamily: "ROAD",
    signedAmount: finance.signedAmount,
    eligibleTempEntityCount: finance.eligibleTempEntityCount,
    provenance: "OBSERVED_NATIVE",
    sourceKind: "NATIVE_TOOL_TEMP_COST",
    validationResult: "VALID",
    runtimeEpoch: finance.runtimeEpoch,
    frame: finance.frame,
    state: "VALID",
    expiresAt: new Date(now.getTime() + 2_000).toISOString(),
    exactInput,
  };
}

/**
 * Whether a certified ROAD preview generated NEW road topology, rather than only
 * re-shaping entities that were already there.
 *
 * `realization.generatedTempEntities` is a WINDOW, not the set. The Bridge fills
 * it from `m_ProposalTempTopology`, which stops at 32 entries in entity-query
 * order (`CS2MCP.Bridge/BridgeToolSystem.cs`, the `m_ProposalTempTopology.Count
 * < 32` guards), while `generatedEdgeCount` / `generatedNodeCount` are the true
 * totals of that same set. Reading the window as if it were the set makes the
 * verdict a function of how much of the local mesh the operation happened to
 * re-generate.
 *
 * Measured live (2026-10-01) at the junction the Office corridor leaves from:
 * true totals 18 edges / 33 nodes, window exactly 32 entries, and native's own
 * answer `validNewRoadProposal: true` with `courseIntegrity.proposalEdgeCount: 1`
 * and a real price of 220 — while the window happened to hold only replacements.
 * All 24 courses the resolver offered that tick came back
 * `NO_PRODUCTIVE_ROAD_EFFECT`, the Goal re-derived itself on the next tick, and
 * the journal did not move for eight consecutive ticks. The same node's courses
 * at a course whose mesh fits inside the window pass the identical test.
 *
 * So the window is evidence of new topology when it holds some, and evidence of
 * NOTHING when it is incomplete: a window that dropped entries cannot prove
 * their absence. Only a window that is complete speaks for the whole set, and
 * only then is a missing new entity a finding. When it is incomplete, the
 * authority is the course's own certification — the operation is a
 * NEW_ROAD_PROPOSAL_EDGE and native identified a proposal edge for it, which is
 * exactly the answer `rawRoadCandidatePreviewVerdict` already reads and which is
 * how native itself names `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` when a course
 * merely re-lays a road that is already there.
 */
function nativePreviewHasNewRoadEffect(value: unknown, input?: RoadGeometryInput): boolean {
  const response = record(value);
  const diagnostics = record(response.diagnostics);
  const realization = record(diagnostics.realization);
  const generated = Array.isArray(realization.generatedTempEntities) ? realization.generatedTempEntities : [];
  const hasNewEdge = generated.some((entry) => {
    const item = record(entry);
    return item.kind === "EDGE" && item.original === null;
  });
  const hasNewEndpoint = generated.some((entry) => {
    const item = record(entry);
    return item.kind === "NODE" && item.original === null;
  });
  const finance = record(response.finance);
  if (input?.networkJunctionInsert) {
    const operation = record(response.junctionOperation);
    return response.roadOperationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
      operation.identityFingerprint === junctionIdentityFingerprint(input.networkJunctionInsert) &&
      operation.nativeAllowApply === true &&
      typeof operation.replacementFingerprint === "string" && operation.replacementFingerprint.length > 0 &&
      typeof finance.signedAmount === "number" && Number.isFinite(finance.signedAmount) && finance.signedAmount >= 0;
  }
  if (!(typeof finance.signedAmount === "number" && Number.isFinite(finance.signedAmount) && finance.signedAmount > 0)) {
    return false;
  }
  // Positive evidence: the window saw a genuinely new entity — an edge OR a node.
  //
  // It used to demand both, and a real road does not always produce both. A
  // course that attaches to nodes that already exist, or whose far end
  // GenerateEdges splits and regenerates, adds an EDGE and no NODE at all.
  // Measured live (2026-10-01) at `75948:215`: the one course that node
  // certifies answered HTTP 200 with `validNewRoadProposal: true`,
  // `courseIntegrity.proposalEdgeCount: 1`, `postHandoffGeometryPreserved: true`
  // and a COMPLETE ten-entry window holding five regenerated nodes, four
  // regenerated edges and one new edge — and zero new nodes. Demanding a new
  // node read that certified, priced road as `NO_PRODUCTIVE_ROAD_EFFECT`, which
  // is why the live Road step died on the only course the node would take.
  if (hasNewEdge || hasNewEndpoint) return true;
  // Otherwise the window only counts as evidence of absence when it holds the
  // whole set. A Bridge that does not report the totals gives no way to tell, so
  // the window stays the only evidence there is and a new entity in it stays
  // required.
  const generatedEdges = realization.generatedEdgeCount;
  const generatedNodes = realization.generatedNodeCount;
  const windowIsComplete = typeof generatedEdges === "number" && typeof generatedNodes === "number" &&
    Number.isFinite(generatedEdges) && Number.isFinite(generatedNodes) &&
    generated.length >= generatedEdges + generatedNodes;
  if (windowIsComplete) return false;
  const integrity = record(response.courseIntegrity);
  return response.validNewRoadProposal === true &&
    integrity.operationKind === "NEW_ROAD_PROPOSAL_EDGE" &&
    typeof integrity.proposalEdgeCount === "number" && Number.isFinite(integrity.proposalEdgeCount) &&
    integrity.proposalEdgeCount > 0;
}

export function starterRoadGeometryCandidates(
  input: RoadGeometryInput,
  lengthsMeters: readonly number[] = STARTER_PRODUCTIVE_ROAD_LENGTHS_METERS,
): RoadGeometryInput[] {
  const currentLength = Math.hypot(input.x2 - input.x1, input.z2 - input.z1);
  const candidates = [input];
  if (input.cx !== undefined || input.cz !== undefined || input.e1 !== undefined || input.e2 !== undefined) return candidates;
  if (!Number.isFinite(currentLength) || currentLength <= 0) return candidates;
  for (const length of lengthsMeters) {
    if (!Number.isFinite(length) || length <= currentLength + 1e-6 || length <= 0) continue;
    const scale = length / currentLength;
    const candidate = { ...input, x2: input.x1 + (input.x2 - input.x1) * scale, z2: input.z1 + (input.z2 - input.z1) * scale };
    const endEndpoint = input.endEndpoint
      ? {
          ...input.endEndpoint,
          expectedPosition: {
            ...input.endEndpoint.expectedPosition,
            x: candidate.x2,
            z: candidate.z2,
          },
        }
      : undefined;
    const exactCandidate = endEndpoint ? { ...candidate, endEndpoint } : candidate;
    if (!candidates.some((entry) => stableRoadInput(entry) === stableRoadInput(exactCandidate))) candidates.push(exactCandidate);
  }
  return candidates;
}

export async function previewProductiveStarterRoad(options: {
  input: RoadGeometryInput;
  preview(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  diagnosticContext?: RoadQuoteDiagnosticContext;
  now?: () => Date;
  signal?: AbortSignal;
  lengthsMeters?: readonly number[];
}): Promise<ProductiveStarterRoadPreview> {
  const now = options.now ?? (() => new Date());
  const attemptedLengthsMeters: number[] = [];
  let lastError: unknown = undefined;
  for (const candidate of starterRoadGeometryCandidates(options.input, options.lengthsMeters)) {
    const operation = canonicalRoadOperation(candidate);
    const input = operation.input;
    const length = Math.hypot(input.x2 - input.x1, input.z2 - input.z1);
    attemptedLengthsMeters.push(length);
    try {
      const preview = await options.preview(input, options.signal);
      const quote = nativeRoadQuoteFromPreview(preview, input, now(), options.diagnosticContext);
      if (!nativePreviewHasNewRoadEffect(preview, input)) {
        const error = new Error("NO_PRODUCTIVE_ROAD_EFFECT");
        Object.assign(error, { code: "NO_PRODUCTIVE_ROAD_EFFECT", preview, input, quote });
        throw error;
      }
      return { input: operation.input, preview, quote, selectedLengthMeters: length, attemptedLengthsMeters };
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error && (error as Error & { code?: string }).code === "NO_PRODUCTIVE_ROAD_EFFECT")) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("NO_PRODUCTIVE_ROAD_EFFECT");
}

export function createV2RuntimeRoadCaller(options: {
  road: V2RoadKernel;
  preview(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  previewBuild?(input: RoadKernelNativeBuildRequest, signal?: AbortSignal): Promise<unknown>;
  certifyJunctionPreview?(input: RoadGeometryInput, preview: unknown, signal?: AbortSignal): Promise<{ generation: string; evidence: BoundedJunctionAdmissionEvidence }>;
  resolveJunctionContact?(input: RoadGeometryInput, signal?: AbortSignal): Promise<{
    generation: string;
    contact: NonNullable<BoundedJunctionAdmissionEvidence["nativeRoadContact"]>;
  }>;
  authorize?(quote: ProposalQuote, task: RuntimeRoadTask): RuntimeRoadAuthorization;
  now?: () => Date;
  readWorldGeneration?(): Promise<string>;
}): V2RuntimeRoadCaller {
  const now = options.now ?? (() => new Date());
  const completed = new Map<string, Promise<RoadExecutionResult>>();
  const previewBoundedJunction = async (task: RuntimeRoadTask, signal?: AbortSignal) => {
    const input = task.input;
    const contract = input.networkJunctionInsert;
    if (!contract || !options.resolveJunctionContact || !options.previewBuild) throw new Error("BOUNDED_JUNCTION_NATIVE_BUILD_PREVIEW_UNAVAILABLE");
    const bound = await options.resolveJunctionContact(input, signal);
    const identity = junctionIdentityFingerprint(contract);
    const proposalId = `junction:${identity}`;
    const quoteId = `junction:${identity}`;
    const buildRequest = roadKernelJunctionNativePreviewRequest(input, proposalId, quoteId, bound.generation, bound.contact);
    const preview = await options.previewBuild(buildRequest, signal);
    const quote = nativeRoadQuoteFromPreview(preview, input, now());
    const junctionPreview = await options.certifyJunctionPreview?.(input, preview, signal);
    if (!junctionPreview) throw new Error("BOUNDED_JUNCTION_FRESH_REBIND_UNAVAILABLE");
    const admission = validateBoundedJunctionAdmission({ contract, evidence: junctionPreview.evidence });
    const certifiedContact = junctionPreview.evidence.nativeRoadContact;
    if (!admission.valid || junctionReplacementFingerprint(junctionPreview.evidence.replacementObservations) !==
      record(record(preview).junctionOperation).replacementFingerprint || junctionPreview.generation !== bound.generation ||
      !certifiedContact || certifiedContact.roadEdge.index !== bound.contact.roadEdge.index ||
      certifiedContact.roadEdge.version !== bound.contact.roadEdge.version || certifiedContact.roadNode.index !== bound.contact.roadNode.index ||
      certifiedContact.roadNode.version !== bound.contact.roadNode.version ||
      Math.hypot(certifiedContact.position.x - bound.contact.position.x, certifiedContact.position.y - bound.contact.position.y,
        certifiedContact.position.z - bound.contact.position.z) > 0.01) {
      throw new Error(`BOUNDED_JUNCTION_FRESH_PREVIEW_REJECTED:${admission.reason}`);
    }
    return { preflight: null, buildRequest, preview, quote, junctionPreview };
  };
  return {
    async previewJunctionNative(task, signal) {
      const input = task.input;
      if (!input.networkJunctionInsert) throw new Error("BOUNDED_JUNCTION_DIAGNOSTIC_INPUT_REQUIRED");
      if (!options.previewBuild) throw new Error("BOUNDED_JUNCTION_NATIVE_BUILD_PREVIEW_UNAVAILABLE");
      if (options.resolveJunctionContact) return previewBoundedJunction(task, signal);
      const preflight = await options.preview(input, signal);
      const preflightQuote = nativeRoadQuoteFromPreview(preflight, input, now());
      const junctionPreview = await options.certifyJunctionPreview?.(input, preflight, signal);
      if (!junctionPreview) throw new Error("BOUNDED_JUNCTION_FRESH_REBIND_UNAVAILABLE");
      const admission = validateBoundedJunctionAdmission({ contract: input.networkJunctionInsert, evidence: junctionPreview.evidence });
      if (!admission.valid || junctionReplacementFingerprint(junctionPreview.evidence.replacementObservations) !==
        record(record(preflight).junctionOperation).replacementFingerprint) {
        throw new Error(`BOUNDED_JUNCTION_FRESH_PREVIEW_REJECTED:${admission.reason}`);
      }
      const buildRequest = roadKernelNativeBuildRequest(input, preflightQuote.proposalId, preflightQuote.quoteId, junctionPreview, true);
      const preview = await options.previewBuild(buildRequest, signal);
      const body = record(preview);
      const operation = record(body.junctionOperation);
      if (body.valid !== true || body.previewOnly !== true || body.toolAllowApply !== true ||
        body.roadOperationKind !== input.networkJunctionInsert.kind ||
        operation.identityFingerprint !== junctionIdentityFingerprint(input.networkJunctionInsert) ||
        operation.replacementFingerprint !== junctionPreview.evidence.replacementFingerprint) {
        throw new Error("BOUNDED_JUNCTION_BUILD_PREVIEW_IDENTITY_INVALID");
      }
      const quote = nativeRoadQuoteFromPreview(preview, input, now());
      return { preflight, buildRequest, preview, quote, junctionPreview };
    },
    async execute(task, signal) {
      const canonical = canonicalRoadOperation(task.input);
      const canonicalTask = { ...task, input: canonical.input };
      const worldGeneration = await options.readWorldGeneration?.();
      const fingerprint = canonical.exactInput;
      const boundedPreview = canonicalTask.input.networkJunctionInsert && options.resolveJunctionContact
        ? await previewBoundedJunction(canonicalTask, signal)
        : undefined;
      const nativePreview = boundedPreview?.preview ?? await options.preview(canonicalTask.input, signal);
    const quote = boundedPreview?.quote ?? nativeRoadQuoteFromPreview(nativePreview, canonicalTask.input, now(), {
      roadTaskId: task.owner.ownerId,
      atomicOperationId: task.owner.ownerId,
    });
      const junctionPreview = boundedPreview?.junctionPreview ?? (canonicalTask.input.networkJunctionInsert
        ? await options.certifyJunctionPreview?.(canonicalTask.input, nativePreview, signal)
        : undefined);
      if (canonicalTask.input.networkJunctionInsert && !junctionPreview) throw new Error("BOUNDED_JUNCTION_FRESH_REBIND_UNAVAILABLE");
      if (junctionPreview && canonicalTask.input.networkJunctionInsert) {
        const admission = validateBoundedJunctionAdmission({ contract: canonicalTask.input.networkJunctionInsert, evidence: junctionPreview.evidence });
        if (!admission.valid || junctionReplacementFingerprint(junctionPreview.evidence.replacementObservations) !== record(record(nativePreview).junctionOperation).replacementFingerprint) {
          throw new Error(`BOUNDED_JUNCTION_FRESH_PREVIEW_REJECTED:${admission.reason}`);
        }
      }
      const executionKey = [worldGeneration ?? "legacy", quote.proposalId, quote.quoteId, quote.runtimeEpoch, quote.frame, fingerprint].join("|");
      const prior = completed.get(executionKey);
      if (prior) {
        const previous = await prior;
        if (
          previous.command.status === "COMMIT_ACK" ||
          previous.command.status === "NATIVE_COMPLETED" ||
          previous.command.status === "NATIVE_COMPLETION_UNKNOWN"
        ) {
          const reconciliation = options.road.reconcile(previous.command.commandId, signal);
          completed.set(executionKey, reconciliation);
          return reconciliation;
        }
        return previous;
      }
      const execution = (async () => {
        const authorization = options.authorize?.(quote, task) ?? {
          authorizedMaxSpend: Math.max(0, quote.signedAmount),
          treasurySafetyReserve: 0,
        };
        const request: RoadExecutionRequest = {
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
          input: canonicalTask.input,
            owner: task.owner,
          },
          quote,
          ...(junctionPreview ? { networkJunctionPreview: junctionPreview } : {}),
          authorizedMaxSpend: authorization.authorizedMaxSpend,
          treasurySafetyReserve: authorization.treasurySafetyReserve,
          ...(worldGeneration ? { worldGeneration } : {}),
        };
        return options.road.execute(request, signal);
      })();
      completed.set(executionKey, execution);
      while (completed.size > 128) completed.delete(completed.keys().next().value!);
      return execution;
    },
  };
}
