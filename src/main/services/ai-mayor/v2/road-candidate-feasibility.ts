/** Existing Pump service-road generation is bounded to seven ordered route candidates. */
export const MAX_ROAD_FEASIBILITY_CANDIDATES = 7;

/**
 * The most candidates one caller may ask this selector to probe.
 *
 * A caller that builds a family knows how wide it is; the ceiling only has to
 * keep an accidental unbounded list from turning into unbounded native work.
 * Twelve was the ceiling every caller was silently clamped to, which meant a
 * Gate 1 Road family of twenty-four was probed seven deep and the twenty it had
 * deliberately added were never previewed — the provider paid to build
 * alternatives that the selector could not reach.
 *
 * It is ninety-six rather than twenty-four for the same reason, one family
 * later. Gate 1 composes its ROAD candidates from several bounded families —
 * the planned corridor, the bounded heading family, the measured heading ×
 * length sweep, and the generic fallback — and their sum is already past
 * twenty-four before the sweep is reached. Measured 2026-10-01: the sweep
 * generated all twenty-five of its courses, every one passed the owned-land
 * filter, and the selector previewed none of them, so a node whose only
 * certifiable course was a swept one still reported
 * `NO_FEASIBLE_GATE1_ROAD_CANDIDATE`. The bound is a guard against an unbounded
 * list, not a budget for one family; a caller's own composition is not
 * something this selector should silently truncate.
 *
 * Every candidate still passes exactly the same preview contract. Nothing here
 * relaxes a filter; it only stops the selector from discarding the caller's own
 * bounded family before looking at it.
 */
export const MAXIMUM_ROAD_FEASIBILITY_CANDIDATE_BUDGET = 96;

export type RawRoadCandidatePreviewVerdict =
  | { status: "FEASIBLE" }
  | { status: "INVALID"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export interface RoadCandidateRejection {
  candidateIndex: number;
  candidateId: string;
  reason: string;
  details?: Record<string, unknown>;
}

export type RoadCandidatePreviewFailureVerdict =
  | { status: "INVALID"; reason: string; details: Record<string, unknown> }
  | { status: "UNKNOWN"; reason: string };

export type RoadCandidateSelection<T> =
  | { status: "SELECTED"; candidate: T; candidateIndex: number; rejections: RoadCandidateRejection[] }
  | { status: "NO_FEASIBLE_ROAD_CANDIDATE"; rejections: RoadCandidateRejection[] };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Inspect only the raw preview contract. Quote and finance fields are deliberately unused. */
export function rawRoadCandidatePreviewVerdict(value: unknown): RawRoadCandidatePreviewVerdict {
  const response = record(value);
  const integrity = record(response.courseIntegrity);
  const firstFailure = typeof integrity.firstFailure === "string" && integrity.firstFailure.length > 0
    ? integrity.firstFailure
    : null;

  if (response.previewOnly !== true) return { status: "UNKNOWN", reason: "ROAD_CANDIDATE_PREVIEW_ONLY_NOT_CONFIRMED" };
  if (response.valid === false) return { status: "INVALID", reason: firstFailure ?? "ROAD_CANDIDATE_VALID_FALSE" };
  if (response.valid !== true) return { status: "UNKNOWN", reason: "ROAD_CANDIDATE_VALID_UNAVAILABLE" };
  if (response.validNewRoadProposal === false) return { status: "INVALID", reason: firstFailure ?? "NEW_ROAD_PROPOSAL_NOT_IDENTIFIED" };
  if (response.validNewRoadProposal !== true) return { status: "UNKNOWN", reason: "VALID_NEW_ROAD_PROPOSAL_UNAVAILABLE" };
  if (response.roadOperationKind !== "NEW_ROAD_PROPOSAL_EDGE" || integrity.operationKind !== "NEW_ROAD_PROPOSAL_EDGE") {
    return typeof response.roadOperationKind === "string" && typeof integrity.operationKind === "string"
      ? { status: "INVALID", reason: "ROAD_CANDIDATE_OPERATION_KIND_MISMATCH" }
      : { status: "UNKNOWN", reason: "ROAD_CANDIDATE_OPERATION_KIND_UNAVAILABLE" };
  }
  if (firstFailure) return { status: "INVALID", reason: firstFailure };
  if (integrity.postHandoffGeometryPreserved === false) return { status: "INVALID", reason: "ROAD_CANDIDATE_COURSE_NOT_PRESERVED" };
  if (integrity.postHandoffGeometryPreserved !== true) return { status: "UNKNOWN", reason: "ROAD_CANDIDATE_COURSE_INTEGRITY_UNAVAILABLE" };
  if (typeof integrity.proposalEdgeCount === "number" && integrity.proposalEdgeCount <= 0) {
    return { status: "INVALID", reason: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" };
  }
  if (typeof integrity.proposalEdgeCount !== "number" || !Number.isFinite(integrity.proposalEdgeCount)) {
    return { status: "UNKNOWN", reason: "ROAD_CANDIDATE_PROPOSAL_EDGE_COUNT_UNAVAILABLE" };
  }
  return { status: "FEASIBLE" };
}

/** Only a structured 409 native preview rejection with no command is a bounded invalid route. */
export function roadCandidatePreviewFailureVerdict(error: unknown): RoadCandidatePreviewFailureVerdict {
  const source = record(error);
  const rejection = record(source.rejectionDiagnostics);
  const validation = record(source.validation);
  if (source.status === 409 && validation.status === "REJECTED" && rejection.stage === "APPLY_GUARD" &&
    rejection.allowApply === false && rejection.nativeCommandCreated === false) {
    return {
      status: "INVALID",
      reason: typeof source.message === "string" ? source.message : "ROAD_CANDIDATE_NATIVE_PREVIEW_REJECTED",
      details: {
        status: source.status,
        validation: source.validation,
        rejectionDiagnostics: source.rejectionDiagnostics,
        nativeRoadDiagnostics: source.nativeRoadDiagnostics,
      },
    };
  }
  return { status: "UNKNOWN", reason: error instanceof Error ? error.message : String(error) };
}

/** Probe candidates strictly in order; UNKNOWN aborts in the caller and is never treated as a rejection. */
export async function selectFeasibleRoadCandidate<T>(input: {
  candidates: readonly T[];
  candidateId(candidate: T, index: number): string;
  /** Callers may add one bounded candidate family without changing other planners' budgets. */
  maximumCandidates?: number;
  probe(candidate: T, index: number): Promise<
    | { status: "FEASIBLE" }
    | { status: "INVALID"; reason: string; details?: Record<string, unknown> }
  >;
}): Promise<RoadCandidateSelection<T>> {
  const rejections: RoadCandidateRejection[] = [];
  const maximum = Number.isFinite(input.maximumCandidates)
    ? Math.max(1, Math.min(MAXIMUM_ROAD_FEASIBILITY_CANDIDATE_BUDGET, Math.floor(input.maximumCandidates!)))
    : MAX_ROAD_FEASIBILITY_CANDIDATES;
  const bounded = input.candidates.slice(0, maximum);
  for (let index = 0; index < bounded.length; index += 1) {
    const candidate = bounded[index];
    const result = await input.probe(candidate, index);
    if (result.status === "FEASIBLE") return { status: "SELECTED", candidate, candidateIndex: index, rejections };
    rejections.push({
      candidateIndex: index,
      candidateId: input.candidateId(candidate, index),
      reason: result.reason,
      ...(result.details ? { details: result.details } : {}),
    });
  }
  return { status: "NO_FEASIBLE_ROAD_CANDIDATE", rejections };
}

export class NoFeasibleRoadCandidateError extends Error {
  readonly code = "NO_FEASIBLE_ROAD_CANDIDATE" as const;

  constructor(readonly rejections: RoadCandidateRejection[], readonly diagnostics: Record<string, unknown> = {}) {
    super("NO_FEASIBLE_ROAD_CANDIDATE");
    this.name = "NoFeasibleRoadCandidateError";
  }
}

export class RoadCandidatePreviewUnknownError extends Error {
  constructor(readonly reason: string) {
    super(`ROAD_CANDIDATE_PREVIEW_UNKNOWN:${reason}`);
    this.name = "RoadCandidatePreviewUnknownError";
  }
}
