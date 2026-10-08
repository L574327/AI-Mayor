import type { SpatialPoint2 } from "../spatial/types";
import {
  isBridgeDomainNetSegmentLengthValid,
  MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
} from "./road-contract";
import type { RoadEndpointAttachment, RoadGeometryInput } from "./road-kernel";
import { isTransientNativeBuildBusy } from "./runtime-road-caller";

export const ROAD_COURSE_SWEEP_SCHEMA_VERSION = "ai-mayor-v2-road-course-sweep/1";

/**
 * The headings a sweep offers, as offsets from the course's own bearing.
 *
 * Measured live (2026-10-01, `docs/ai-mayor/INVESTIGATION-2026-10-01-…md` §3):
 * the set of courses a node will actually certify is SPARSE and varies per node
 * AND per length — at node `75948:215`, one of twenty-four heading×length probes
 * was accepted, while at `52196:1` ten were. The bounded 25° cone the resolver
 * fans out does not contain those courses, which is why a live cycle reports
 * `NO_FEASIBLE_GATE1_ROAD_CANDIDATE` with road segments at zero.
 *
 * These are offsets rather than absolute compass headings so the sweep stays
 * aimed: offset 0 IS the course toward the intent's own target, and the other
 * seven are the same eight directions a compass sweep would name.
 */
export const ROAD_COURSE_SWEEP_OFFSETS_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/** The lengths each heading is offered at. Native certifies a heading at one length and not another. */
export const ROAD_COURSE_SWEEP_LENGTHS_METERS = [16, 24, 40] as const;

/**
 * How wide the standard family is: eight offsets times three lengths.
 *
 * Twenty-four is exactly the family `road-candidate-feasibility.ts` was widened
 * to reach (`MAXIMUM_ROAD_FEASIBILITY_CANDIDATE_BUDGET`), and it is the figure a
 * caller declares when it wants the measured sweep rather than an ad-hoc one.
 * It is a reference width, not a clamp: the family is bounded by construction
 * (the offsets and lengths the caller supplies), and truncating it silently
 * would report "no certifiable course" for courses that were never asked about.
 */
export const ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET =
  ROAD_COURSE_SWEEP_OFFSETS_DEGREES.length * ROAD_COURSE_SWEEP_LENGTHS_METERS.length;

/**
 * What native answered about one course.
 *
 * The refusals are kept apart on purpose: they call for different repairs, and
 * collapsing them (as a single `INVALID` does) makes a sweep retry the wrong
 * thing — or worse, records a broken endpoint binding as a fact about the land.
 */
export type RoadCoursePreviewVerdict =
  /** Native identified a new proposal edge AND the course's geometry survived the handoff. Build it. */
  | { status: "CERTIFIABLE"; proposalEdgeCount: number }
  /** No proposal edge formed at this heading at all. Remedy: change heading. */
  | { status: "NO_PROPOSAL_EDGE"; reason: string }
  /**
   * An edge formed but placement validation refused it. Remedy: change length or
   * nudge position. `nativeErrorTypes` are the game's OWN reasons — measured
   * live at `75948:215`, a refused course named `SteepSlope` at a position 0.1 m
   * from the requested end, which is the only thing a planner can route around.
   */
  | { status: "PLACEMENT_REFUSED"; reason: string; nativeErrorTypes: string[] }
  /** The course would re-lay a road already there; it adds no topology. Remedy: change heading or length. */
  | { status: "NO_PRODUCTIVE_EFFECT"; reason: string }
  /**
   * The endpoint binding itself was rejected, before any course question was
   * asked. This is NOT a fact about the course: every course from this source
   * fails identically, so a sweep must stop rather than spend its budget
   * refuting land it never asked about.
   */
  | { status: "ENDPOINT_UNBOUND"; reason: string }
  /** No verdict was produced (dry run unconfirmed, or a malformed answer). Never a rejection. */
  | { status: "UNKNOWN"; reason: string };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The native answer, wherever the transport put it.
 *
 * A refusal arrives as HTTP 409 with a structured body, and depending on the
 * caller it is either returned or thrown: the product's tool call surfaces it as
 * an error whose own fields carry `status` / `validation` /
 * `rejectionDiagnostics` (`roadCandidatePreviewFailureVerdict` reads exactly
 * those), while a plain `fetch` surfaces the same JSON under `body`. Both name
 * the same verdict, so both are read here.
 */
function nativeAnswerBody(value: unknown): Record<string, unknown> {
  const own = record(value);
  if (own.rejectionDiagnostics || own.validation || own.courseIntegrity || own.previewOnly !== undefined) return own;
  const body = record(own.body);
  if (body.rejectionDiagnostics || body.validation || body.previewOnly !== undefined) return body;
  return own;
}

/** The game's own error types, bounded and de-duplicated, as `normalizeNativeRoadDiagnostics` reads them. */
function nativeErrorTypesOf(response: Record<string, unknown>): string[] {
  const types: string[] = [];
  for (const raw of (Array.isArray(response.nativeToolErrors) ? response.nativeToolErrors : []).slice(0, 16)) {
    const errorType = nonEmptyString(record(raw).errorType);
    if (errorType && !types.includes(errorType)) types.push(errorType);
  }
  return types;
}

const ENDPOINT_BINDING_ERROR_TYPES = new Set([
  "ROAD_ENDPOINT_POSITION_MISMATCH",
  "ROAD_ENDPOINT_WORLD_EPOCH_MISMATCH",
  "ROAD_ENDPOINT_NOT_FOUND",
  "ROAD_ENDPOINT_TOPOLOGY_MISMATCH",
]);

function classifyNativeRoadRejection(response: Record<string, unknown>): RoadCoursePreviewVerdict {
  const rejection = record(response.rejectionDiagnostics);
  const errorType = nonEmptyString(rejection.errorType);
  const stage = nonEmptyString(rejection.stage);
  const message = nonEmptyString(rejection.message) ?? nonEmptyString(response.error) ?? errorType ?? "NATIVE_ROAD_PREVIEW_REJECTED";

  // Rejected while DEFINING the course, not while placing it. The binding is
  // what is wrong, and it is wrong for every course this source will offer.
  if ((errorType !== null && ENDPOINT_BINDING_ERROR_TYPES.has(errorType)) || stage === "DEFINITION") {
    return { status: "ENDPOINT_UNBOUND", reason: message };
  }
  if (errorType === "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" || /NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED/.test(message)) {
    return { status: "NO_PROPOSAL_EDGE", reason: message };
  }
  if (errorType === "NO_PRODUCTIVE_ROAD_EFFECT" || /NO_PRODUCTIVE_ROAD_EFFECT/.test(message)) {
    return { status: "NO_PRODUCTIVE_EFFECT", reason: message };
  }
  // An edge formed and the game refused to place it. Whatever it named, this is
  // the class that says "try another length or nudge the position".
  return { status: "PLACEMENT_REFUSED", reason: message, nativeErrorTypes: nativeErrorTypesOf(response) };
}

/**
 * Read a native net preflight answer as one verdict.
 *
 * This reads the same shapes `rawRoadCandidatePreviewVerdict` and
 * `roadCandidatePreviewFailureVerdict` do, but answers a different question. A
 * selector only walks forward and needs "is this admissible"; a sweep has to
 * decide what to change next, so it needs the distinction those two drop:
 *
 *   `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` -> no proposal edge at this heading
 *   `operation blocked by game validation`  -> edge formed, placement refused
 *
 * A `previewOnly !== true` answer that is also not a structured rejection is
 * UNKNOWN, never a rejection: the dry run was not confirmed, so the course has
 * not been answered at all.
 */
export function classifyRoadCoursePreview(value: unknown): RoadCoursePreviewVerdict {
  const response = nativeAnswerBody(value);
  const validation = record(response.validation);
  if (response.rejectionDiagnostics !== undefined || validation.status === "REJECTED") {
    const classified = classifyNativeRoadRejection(response);
    // A rejection with nothing native named is still a rejection, but this
    // module cannot say which repair it calls for.
    if (classified.status !== "UNKNOWN") return classified;
  }
  if (response.previewOnly !== true) {
    return { status: "UNKNOWN", reason: "ROAD_COURSE_PREVIEW_ONLY_NOT_CONFIRMED" };
  }
  const integrity = record(response.courseIntegrity);
  const firstFailure = nonEmptyString(integrity.firstFailure);

  // The definitive positive: native named a proposal edge and the geometry
  // survived the handoff. Everything else is a refusal of one kind or another.
  if (
    response.valid === true &&
    response.validNewRoadProposal === true &&
    response.roadOperationKind === "NEW_ROAD_PROPOSAL_EDGE" &&
    integrity.operationKind === "NEW_ROAD_PROPOSAL_EDGE" &&
    integrity.postHandoffGeometryPreserved !== false &&
    typeof integrity.proposalEdgeCount === "number" &&
    Number.isFinite(integrity.proposalEdgeCount) &&
    integrity.proposalEdgeCount > 0
  ) {
    return { status: "CERTIFIABLE", proposalEdgeCount: integrity.proposalEdgeCount };
  }

  if (firstFailure && /NO_PRODUCTIVE_ROAD_EFFECT/.test(firstFailure)) {
    return { status: "NO_PRODUCTIVE_EFFECT", reason: firstFailure };
  }
  // `proposalEdgeCount === 0` IS the "no proposal edge" finding even when the
  // Bridge did not spell the failure name, which is how the sparse table was
  // measured in the first place.
  if (firstFailure === "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED") {
    return { status: "NO_PROPOSAL_EDGE", reason: firstFailure };
  }
  if (integrity.postHandoffGeometryPreserved === false) {
    return { status: "PLACEMENT_REFUSED", reason: firstFailure ?? "ROAD_COURSE_NOT_PRESERVED", nativeErrorTypes: nativeErrorTypesOf(response) };
  }
  if (typeof integrity.proposalEdgeCount === "number" && integrity.proposalEdgeCount <= 0) {
    return { status: "NO_PROPOSAL_EDGE", reason: firstFailure ?? "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" };
  }

  if (response.valid === false) {
    return {
      status: "PLACEMENT_REFUSED",
      reason: firstFailure ?? "operation blocked by game validation",
      nativeErrorTypes: nativeErrorTypesOf(response),
    };
  }
  if (firstFailure) return { status: "PLACEMENT_REFUSED", reason: firstFailure, nativeErrorTypes: nativeErrorTypesOf(response) };
  return { status: "UNKNOWN", reason: "ROAD_COURSE_PREVIEW_VERDICT_UNAVAILABLE" };
}

/**
 * One course the sweep offers, with the ordinal that names it.
 *
 * The ordinal is a property of the PLAN, not of which course happened to
 * certify: it is the index in the deterministic family below, so the same
 * intent against the same source always spells the same ordinal for the same
 * geometry. That is what lets an operation id be `hash(intentId, ordinal)`
 * without any world fact entering it.
 */
export interface RoadCourseSweepCourse {
  ordinal: number;
  /** Absolute compass heading of the course. */
  headingDegrees: number;
  /** The offset from the intent's own bearing that produced it. */
  offsetDegrees: number;
  lengthMeters: number;
  endpoint: SpatialPoint2;
  /** Whether this is the straight course at the intent's own target, rather than a swept alternative. */
  direct: boolean;
}

export interface RoadCourseSweepPlan {
  from: SpatialPoint2;
  bearingDegrees: number;
  courses: RoadCourseSweepCourse[];
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const normalizeHeading = (degrees: number) => ((degrees % 360) + 360) % 360;
const courseGeometryKey = (from: SpatialPoint2, course: RoadCourseSweepCourse): string =>
  [from.x.toFixed(3), from.z.toFixed(3), course.endpoint.x.toFixed(3), course.endpoint.z.toFixed(3)].join("|");

export const roadCourseGeometryKey = (start: SpatialPoint2, end: SpatialPoint2): string =>
  [start.x.toFixed(3), start.z.toFixed(3), end.x.toFixed(3), end.z.toFixed(3)].join("|");

/**
 * The deterministic course family for one source point.
 *
 * The intent's own target is offered first (ordinal 0) when it is a legal
 * segment at all, so a world where the direct course works never pays for a
 * sweep. The remaining courses are offsets at each length, heading-major: every
 * length a heading can be offered at is tried before moving to the next heading.
 *
 * Courses are filtered by the Bridge's own segment-length contract here, not
 * later, because a course outside `[8, 1500] m` is not "uncertified" — it is
 * not a road the tool can be asked about.
 */
export function planRoadCourseSweep(input: {
  from: SpatialPoint2;
  to?: SpatialPoint2;
  /** Direction of the target from `from`. Defaults to the `to` vector; required when there is no `to`. */
  bearingDegrees?: number;
  offsets?: readonly number[];
  lengths?: readonly number[];
  /** An explicit caller-imposed bound. Absent means the whole family, which is bounded already. */
  maximumProbes?: number;
}): RoadCourseSweepPlan {
  const { from } = input;
  const derived = input.to ? Math.atan2(input.to.z - from.z, input.to.x - from.x) * (180 / Math.PI) : null;
  const bearingDegrees = input.bearingDegrees ?? derived;
  if (bearingDegrees === null || bearingDegrees === undefined || !Number.isFinite(bearingDegrees)) {
    throw new Error("ROAD_COURSE_SWEEP_BEARING_UNKNOWN");
  }
  const offsets = input.offsets ?? ROAD_COURSE_SWEEP_OFFSETS_DEGREES;
  const lengths = input.lengths ?? ROAD_COURSE_SWEEP_LENGTHS_METERS;
  const maximum = Number.isFinite(input.maximumProbes)
    ? Math.max(1, Math.floor(input.maximumProbes!))
    : Number.POSITIVE_INFINITY;

  const courses: RoadCourseSweepCourse[] = [];
  const seen = new Set<string>();
  const push = (course: Omit<RoadCourseSweepCourse, "ordinal">) => {
    if (courses.length >= maximum) return;
    if (!isBridgeDomainNetSegmentLengthValid(from, course.endpoint)) return;
    const key = courseGeometryKey(from, { ...course, ordinal: 0 });
    if (seen.has(key)) return;
    seen.add(key);
    courses.push({ ...course, ordinal: courses.length });
  };

  if (input.to) {
    push({ headingDegrees: normalizeHeading(bearingDegrees), offsetDegrees: 0, lengthMeters: Math.hypot(input.to.x - from.x, input.to.z - from.z), endpoint: { x: input.to.x, z: input.to.z }, direct: true });
  }
  for (const offset of offsets) {
    const heading = normalizeHeading(bearingDegrees + offset);
    const radians = toRadians(heading);
    for (const length of lengths) {
      push({
        headingDegrees: heading,
        offsetDegrees: offset,
        lengthMeters: length,
        endpoint: { x: from.x + Math.cos(radians) * length, z: from.z + Math.sin(radians) * length },
        direct: false,
      });
    }
  }
  return { from, bearingDegrees: normalizeHeading(bearingDegrees), courses };
}

/**
 * Whether a thrown native answer was the Bridge's single-flight contention,
 * which is NOT a verdict on the course.
 *
 * `isTransientNativeBuildBusy` already names this error for the runtime road
 * caller. It is restated here only to keep the reason visible at the call site
 * that must retry: a 409 `another build operation in progress` recorded as
 * "uncertifiable" is a lie about the land, and hides a certifiable course.
 */
export function isRoadCourseProbeContention(error: unknown): boolean {
  if (isTransientNativeBuildBusy(error)) return true;
  const details = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (Number(details.status) !== 409) return false;
  return /another build operation in progress/i.test(error instanceof Error ? error.message : String(error));
}

export interface RoadCourseProbeRetry {
  attempts: number;
  delayMs?: number;
  sleep?(milliseconds: number): Promise<void>;
}

export const DEFAULT_ROAD_COURSE_PROBE_RETRY: RoadCourseProbeRetry = { attempts: 3, delayMs: 150 };

/**
 * Probe courses strictly in ordinal order and report the first certifiable one.
 *
 * Serial by construction: native's build slot is single-flight, so overlapping
 * probes would manufacture the very contention this loop is here to absorb.
 *
 * Contention that outlives its retries stops the sweep as
 * `UNRESOLVED_CONTENTION` rather than consuming the whole budget — the courses
 * after it are unasked, and reporting them as refused would be a fabricated
 * `NO_FEASIBLE` verdict.
 */
export interface RoadCourseProbeRejection {
  ordinal: number;
  headingDegrees: number;
  offsetDegrees: number;
  lengthMeters: number;
  verdict: Exclude<RoadCoursePreviewVerdict, { status: "CERTIFIABLE" }>["status"] | "CONTENTION";
  reason: string;
}

export interface RoadCourseProbeCertification {
  status: "CERTIFIED";
  course: RoadCourseSweepCourse;
  /**
   * The geometry native certified. It travels with the certification because a
   * caller that authorizes a re-derived shape is authorizing a different road
   * than the one that was proven buildable.
   */
  input: RoadGeometryInput;
  verdict: Extract<RoadCoursePreviewVerdict, { status: "CERTIFIABLE" }>;
  /** The dry-run answer itself, kept as the evidence a cache or a journal may carry. */
  preview: unknown;
  probes: number;
  cacheHit: boolean;
}

export interface RoadCourseProbeExhausted {
  status: "EXHAUSTED";
  rejections: RoadCourseProbeRejection[];
  probes: number;
}

export interface RoadCourseProbeContention {
  status: "UNRESOLVED_CONTENTION";
  rejections: RoadCourseProbeRejection[];
  probes: number;
  reason: string;
}

/**
 * Native rejected the binding before it judged any course.
 *
 * Distinct from EXHAUSTED because the repairs are opposite: EXHAUSTED means
 * "this land will not take a road from here", while this means the module's own
 * reach for the network was refused — a stale coordinate, a reloaded world, a
 * node that is no longer what the scan said. Reporting it as EXHAUSTED would
 * blame 24 courses for one bad anchor.
 */
export interface RoadCourseProbeEndpointBindFailure {
  status: "ENDPOINT_BINDING_FAILED";
  reason: string;
  course: RoadCourseSweepCourse;
  probes: number;
}

export type RoadCourseProbeResult =
  | RoadCourseProbeCertification
  | RoadCourseProbeExhausted
  | RoadCourseProbeContention
  | RoadCourseProbeEndpointBindFailure;

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface RoadCourseSweepInput {
  from: SpatialPoint2;
  /** The exact node this sweep leaves from, when it is bound to one. Emitted verbatim as `startEndpoint`. */
  startEndpoint?: RoadEndpointAttachment;
  prefab: string;
  probe(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  to?: SpatialPoint2;
  bearingDegrees?: number;
  offsets?: readonly number[];
  lengths?: readonly number[];
  maximumProbes?: number;
  retry?: RoadCourseProbeRetry;
  signal?: AbortSignal;
  /** Certification is per (world, topology revision); an entry from another revision is a miss, never a stale hit. */
  cache?: RoadCourseCertificationCache;
}

/**
 * The geometry one swept course is turned into.
 *
 * Only the START endpoint is ever attached. That is the shape the certification
 * probe was measured with (`scripts/ai-mayor-road-certification-sweep.cjs`)
 * and the shape production already previews roads with elsewhere
 * (`main-adapter.ts` builds a road preview from `roadCourseGeometry(action)`,
 * which carries no endpoints at all). A far end is a free endpoint by
 * construction, and Bridge answers a bound START plus a free END directly.
 */
export function roadCourseSweepGeometry(input: {
  prefab: string;
  from: SpatialPoint2;
  course: RoadCourseSweepCourse;
  startEndpoint?: RoadEndpointAttachment;
}): RoadGeometryInput {
  return {
    prefab: input.prefab,
    x1: input.from.x,
    z1: input.from.z,
    x2: input.course.endpoint.x,
    z2: input.course.endpoint.z,
    ...(input.startEndpoint ? { startEndpoint: input.startEndpoint } : {}),
  };
}

export async function sweepCertifiableRoadCourse(input: RoadCourseSweepInput): Promise<RoadCourseProbeResult> {
  const plan = planRoadCourseSweep({
    from: input.from,
    ...(input.to ? { to: input.to } : {}),
    ...(input.bearingDegrees === undefined ? {} : { bearingDegrees: input.bearingDegrees }),
    ...(input.offsets ? { offsets: input.offsets } : {}),
    ...(input.lengths ? { lengths: input.lengths } : {}),
    ...(input.maximumProbes === undefined ? {} : { maximumProbes: input.maximumProbes }),
  });
  const retry = input.retry ?? DEFAULT_ROAD_COURSE_PROBE_RETRY;
  const sleep = retry.sleep ?? defaultSleep;
  const fromKey = `${input.from.x.toFixed(3)}:${input.from.z.toFixed(3)}`;

  const rejections: RoadCourseProbeRejection[] = [];
  let probes = 0;
  for (const course of plan.courses) {
    const geometryKey = courseGeometryKey(input.from, course);
    const cached = input.cache?.get(fromKey, geometryKey);
    if (cached?.verdict.status === "CERTIFIABLE") {
      return {
        status: "CERTIFIED",
        course,
        input: roadCourseSweepGeometry({
          prefab: input.prefab,
          from: input.from,
          course,
          ...(input.startEndpoint ? { startEndpoint: input.startEndpoint } : {}),
        }),
        verdict: cached.verdict,
        preview: cached.preview,
        probes,
        cacheHit: true,
      };
    }
    if (cached && cachedRefusalStatuses.has(cached.verdict.status)) {
      rejections.push({
        ordinal: course.ordinal,
        headingDegrees: course.headingDegrees,
        offsetDegrees: course.offsetDegrees,
        lengthMeters: course.lengthMeters,
        verdict: cached.verdict.status as RoadCourseProbeRejection["verdict"],
        reason: "reason" in cached.verdict ? cached.verdict.reason : "cached refusal",
      });
      continue;
    }
    const geometry = roadCourseSweepGeometry({
      prefab: input.prefab,
      from: input.from,
      course,
      ...(input.startEndpoint ? { startEndpoint: input.startEndpoint } : {}),
    });
    let raw: unknown;
    let verdict: RoadCoursePreviewVerdict | null = null;
    const attempts = Math.max(1, retry.attempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        probes += 1;
        raw = await input.probe(geometry, input.signal);
        verdict = classifyRoadCoursePreview(raw);
        break;
      } catch (error) {
        if (isRoadCourseProbeContention(error)) {
          if (attempt + 1 >= attempts) {
            return {
              status: "UNRESOLVED_CONTENTION",
              rejections,
              probes,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          await sleep(retry.delayMs ?? 150);
          continue;
        }
        // A native refusal raised as an error is still a verdict: the product's
        // own tool call throws it that way and classifies it downstream. Only an
        // answer this module cannot read at all is a failure.
        const raised = classifyRoadCoursePreview(error);
        if (raised.status === "UNKNOWN") throw error;
        raw = error;
        verdict = raised;
        break;
      }
    }
    if (!verdict) return { status: "UNRESOLVED_CONTENTION", rejections, probes, reason: "ROAD_COURSE_PROBE_UNANSWERED" };
    if (verdict.status === "ENDPOINT_UNBOUND") {
      return { status: "ENDPOINT_BINDING_FAILED", reason: verdict.reason, course, probes };
    }
    if (verdict.status === "CERTIFIABLE") {
      input.cache?.put(fromKey, geometryKey, { verdict, preview: raw });
      return { status: "CERTIFIED", course, input: geometry, verdict, preview: raw, probes, cacheHit: false };
    }
    if (verdict.status !== "UNKNOWN") {
      rejections.push({
        ordinal: course.ordinal,
        headingDegrees: course.headingDegrees,
        offsetDegrees: course.offsetDegrees,
        lengthMeters: course.lengthMeters,
        verdict: verdict.status,
        reason: verdict.reason,
      });
      input.cache?.put(fromKey, geometryKey, { verdict, preview: raw });
    }
  }
  return { status: "EXHAUSTED", rejections, probes };
}

/**
 * A cached native answer about one course — a certification OR a refusal.
 *
 * Refusals are cached too, and that is the difference between a sweep costing
 * seventeen probes and costing none. Measured live (2026-10-01) at `75948:215`:
 * the one certifiable course in the family sits at ordinal 16, so caching only
 * the hit still re-pays sixteen native round trips per tick against a call that
 * was already measured at 73% of all wall-clock.
 *
 * A cached refusal is safe because of what the cache is scoped to. A course is
 * refused because of the land and the road graph; the moment the Mayor builds
 * anything, the graph revision changes and every entry here becomes unreachable.
 * `ENDPOINT_UNBOUND` and `UNKNOWN` are never cached: the first is a fault in
 * this module's own reach for the network, and the second is not an answer.
 */
export interface CachedRoadCourseCertification {
  verdict: RoadCoursePreviewVerdict;
  preview: unknown;
}

const cachedRefusalStatuses = new Set<RoadCoursePreviewVerdict["status"]>([
  "NO_PROPOSAL_EDGE",
  "PLACEMENT_REFUSED",
  "NO_PRODUCTIVE_EFFECT",
]);

export interface RoadCourseCertificationCache {
  readonly worldId: string;
  readonly topologyRevision: string;
  get(fromKey: string, courseKey: string): CachedRoadCourseCertification | undefined;
  put(fromKey: string, courseKey: string, evidence: CachedRoadCourseCertification): void;
  readonly size: number;
}

export function createRoadCourseCertificationCache(input: {
  worldId: string;
  topologyRevision: string;
}): RoadCourseCertificationCache {
  const entries = new Map<string, CachedRoadCourseCertification>();
  return {
    worldId: input.worldId,
    topologyRevision: input.topologyRevision,
    get(fromKey, courseKey) {
      return entries.get(`${fromKey}|${courseKey}`);
    },
    put(fromKey, courseKey, evidence) {
      entries.set(`${fromKey}|${courseKey}`, evidence);
    },
    get size() {
      return entries.size;
    },
  };
}

/** Whether a cache still describes the world being planned against. False means every entry is a miss. */
export function roadCourseCertificationCacheMatches(
  cache: RoadCourseCertificationCache,
  world: { worldId: string; topologyRevision: string },
): boolean {
  return cache.worldId === world.worldId && cache.topologyRevision === world.topologyRevision;
}

export const roadCourseSegmentBoundsMeters = {
  minimum: MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  maximum: MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
} as const;
