import type { SpatialPoint2, SpatialRoadEdge } from "../spatial/types";
import type { MayorAction } from "../types";

/**
 * The bounded capability this module exists for: giving an already-placed
 * facility road frontage when the connection it really needed turned out to be
 * a road and not a pipe.
 *
 * It is a *repair* primitive rather than a new plan because the plan already
 * carried the target the world refused. The original service road ran down the
 * corridor the admitted connection course now occupies, so re-submitting the
 * plan's own geometry asks the game to host a second course down a corridor
 * that is already taken. The courses derived here are the same objective,
 * laterally displaced off that corridor by the facility's own size, and they
 * are still bounded: a fixed ladder, no search, no randomness, no clock.
 */
export const FACILITY_ACCESS_ROAD_REPAIR = "FACILITY_ACCESS_ROAD";

/**
 * The prefab an access road is built with: the same one the utility connection
 * builder already uses for the plan's own service road, so the repair is a
 * different course of the same kind of road, not a second road vocabulary.
 */
export const FACILITY_ACCESS_ROAD_PREFAB = "Small Road";

/**
 * How many bounded repair amendments one repair lineage may ever hold.
 *
 * The capability is a bounded SEQUENCE -- not a single attempt, and not an
 * unbounded loop. Each attempt is a distinct immutable amendment with its own
 * ordinal and its own exact course, and the next one is admitted only while the
 * previous one is terminal (its effect absent from the authoritative world, or
 * its outcome explicitly requiring a distinct amendment), no authorization is
 * left ACTIVE, and no command is left unresolved. This ceiling is what keeps
 * "the lineage may try again" from becoming "the lineage may try forever": the
 * highest ordinal a lineage can reach is this one, and nothing derives a higher
 * one automatically.
 */
export const FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX = 4;

/**
 * The lineage every repair attempt of one plan revision hangs from.
 *
 * One lineage per (project, plan revision), with the attempt ordinal as its
 * immutable suffix: two attempts of the same revision share the lineage and
 * differ in the ordinal, which is exactly what makes a later attempt a
 * continuation rather than a replay of an earlier one.
 */
export function facilityAccessRoadRepairLineage(input: {
  projectId: string;
  planRevision: string;
  attemptIndex: number;
}): string {
  return `${input.projectId}:${input.planRevision}:facility-access-road:${input.attemptIndex}`;
}

/**
 * The attempt ordinal a durable lineage already carries, or null when it has
 * none.
 *
 * Amendment records minted before the ordinal was a field of its own carry it
 * only inside the lineage suffix. That suffix is deterministic and immutable,
 * so reading it is reading the same number rather than a second opinion about
 * it.
 */
export function facilityAccessRoadRepairAttemptIndexFromLineage(lineage: string | undefined): number | null {
  if (typeof lineage !== "string") return null;
  const match = /:facility-access-road:(\d+)$/.exec(lineage);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

/**
 * The next bounded attempt ordinal for a lineage: one past the highest ordinal
 * any durable record of it already carries.
 *
 * Derived, never stored and never incremented in place, so a resume cannot
 * advance it twice. A lineage that has already spent its last attempt is
 * refused here rather than minted again, so no path can open an attempt five.
 */
export function nextFacilityAccessRoadRepairAttemptIndex(priorAttemptIndices: readonly number[]): number {
  const highest = priorAttemptIndices.reduce(
    (maximum, index) => (Number.isInteger(index) && index > 0 ? Math.max(maximum, index) : maximum),
    0,
  );
  const next = highest + 1;
  if (next > FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX) {
    throw new Error("FACILITY_ACCESS_ROAD_REPAIR_ATTEMPTS_EXHAUSTED");
  }
  return next;
}

/** A zero/zero utility snapshot is meaningful only after the current load has ticked. */
export function cityElectricityCapacityVerdict(input: {
  freshness: "SETTLED" | "UNSETTLED" | "UNKNOWN";
  production: number | null;
  consumption: number | null;
}): boolean | "UNKNOWN" {
  if (input.freshness !== "SETTLED" || input.production === null || input.consumption === null ||
    !Number.isFinite(input.production) || !Number.isFinite(input.consumption)) return "UNKNOWN";
  return input.production > 0 && input.production >= input.consumption;
}

export interface FacilityAccessRoadCourseRequest {
  /**
   * The original plan's service-road target: the road contact, and the point
   * toward the facility. Its bearing and span are the corridor every candidate
   * is derived on, and its start is the anchor every candidate start is
   * displaced from.
   */
  objective: { start: SpatialPoint2; end: SpatialPoint2 };
  /** The world geometry of the connection course that is already there, which the course must avoid. */
  admittedCourse: { prefab: string; start: SpatialPoint2; end: SpatialPoint2 };
  /** Where the facility is, and how far its footprint reaches. */
  facility: { position: SpatialPoint2; halfExtent: number };
  /** Service point explicitly selected by the current utility plan. */
  facilityServicePoint: SpatialPoint2;
  /** Bounded tolerance for a road segment to cover that point. */
  servicePointTolerance?: number;
  envelope: { center: SpatialPoint2; radius: number };
  /** The road prefab the access course is built from. */
  prefab: string;
  /** Bounded upper limit on returned candidates. */
  maximumCandidates: number;
}

export interface FacilityAccessRoadCandidate {
  actions: MayorAction[];
  /**
   * How far the whole course sits from the admitted course, in metres.
   * Derived from the two geometries rather than restated from the ladder, so
   * ordering by it orders by the displacement the world actually sees — and it
   * is the same figure the clearance filter bounded.
   */
  offsetFromAdmittedCourse: number;
  reason: string;
}

export interface FacilityAccessRoadPreflightVerdict {
  accepted: boolean;
  quote: number | null;
  reason?: string;
}

/**
 * The three world clauses the bounded repair stands on, read from the
 * authoritative world and nothing else: the facility has no road frontage, the
 * engine's own warning says so, and the city already has the power this facility
 * will draw.
 *
 * Exported because two boundaries ask this exact question — the repair verdict
 * below, and the workflow's decision about whether it may park in a passive
 * service wait — and a second copy of it would be a second answer about the same
 * world. An absent or unreadable evidence object is not a satisfied clause:
 * nothing here defaults to true.
 */
export function facilityAccessRoadWorldPrecondition(input: {
  roadAttachment: "ATTACHED" | "NONE" | "UNKNOWN";
  noRoadAccessWarning: boolean | "UNKNOWN";
  cityElectricityCapacitySufficient: boolean | "UNKNOWN";
} | null | undefined): boolean {
  return !!input &&
    input.roadAttachment === "NONE" &&
    input.noRoadAccessWarning === true &&
    input.cityElectricityCapacitySufficient === true;
}

export type FacilityAccessRoadSelection =
  | { status: "SELECTED"; candidate: FacilityAccessRoadCandidate; quote: number }
  | { status: "REFUSED"; reasons: string[] };

const distance = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);

/** The lateral clearance a course must keep from an already-built course, given the facility's size. */
const clearanceOf = (halfExtent: number) => halfExtent + 4;

const cross = (origin: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2) =>
  (a.x - origin.x) * (b.z - origin.z) - (a.z - origin.z) * (b.x - origin.x);

const between = (value: number, a: number, b: number) => value >= Math.min(a, b) && value <= Math.max(a, b);

/**
 * Whether two segments share at least one point, including the collinear and
 * touching cases. Needed because "closest approach" is zero for a crossing, and
 * a crossing is exactly the overlap this gate exists to refuse — the four
 * endpoint-to-segment distances alone cannot see it.
 */
function segmentsIntersect(a: SpatialPoint2, b: SpatialPoint2, c: SpatialPoint2, d: SpatialPoint2): boolean {
  const first = cross(c, d, a);
  const second = cross(c, d, b);
  const third = cross(a, b, c);
  const fourth = cross(a, b, d);
  if (((first > 0 && second < 0) || (first < 0 && second > 0)) && ((third > 0 && fourth < 0) || (third < 0 && fourth > 0))) {
    return true;
  }
  if (first === 0 && between(a.x, c.x, d.x) && between(a.z, c.z, d.z)) return true;
  if (second === 0 && between(b.x, c.x, d.x) && between(b.z, c.z, d.z)) return true;
  if (third === 0 && between(c.x, a.x, b.x) && between(c.z, a.z, b.z)) return true;
  if (fourth === 0 && between(d.x, a.x, b.x) && between(d.z, a.z, b.z)) return true;
  return false;
}

function pointSegmentDistance(point: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.z - (a.z + t * dz));
}

export function facilityAccessRoadCourseReachesServicePoint(
  actions: readonly MayorAction[], servicePoint: SpatialPoint2, tolerance = 3,
): boolean {
  return actions.length > 0 && actions.every((action) => action.type === "build_road" &&
    pointSegmentDistance(servicePoint, { x: action.x1, z: action.z1 }, { x: action.x2, z: action.z2 }) <= tolerance);
}

/** Exact minimum distance between two segments. */
export function segmentDistance(a1: SpatialPoint2, a2: SpatialPoint2, b1: SpatialPoint2, b2: SpatialPoint2): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
  );
}

const insideEnvelope = (point: SpatialPoint2, envelope: { center: SpatialPoint2; radius: number }) =>
  distance(point, envelope.center) <= envelope.radius;

/**
 * Derive the bounded ladder of access-road courses for one objective.
 *
 * Everything here is derived from the request's own geometry: the bearing is
 * the objective's, the lateral steps are multiples of the facility's half
 * extent, and the contractions are fractions of the objective's span. No world
 * coordinate, no clock and no randomness takes part, so the same request always
 * yields the same courses in the same order — which is what lets the caller
 * price them once and re-derive them identically on a resume.
 *
 * Every course is the objective on the same bearing, displaced sideways by one
 * rung of the ladder — BOTH endpoints, not just the far one. Displacing only the
 * far end cannot work, and the reason is worth stating because it is the whole
 * shape of this function. The admitted course ends at the objective's own start:
 * that shared point is the road contact, the one place the plan and the pipe
 * agree. A course anchored there is therefore *at* the admitted course where it
 * begins, and its body can only be as far from it as the body is long — the
 * measured clearance of a course that pivots about a point of the admitted
 * course is bounded above by the length it has travelled, so the mandated
 * `clearance` can never be exceeded by trimming. Swinging the far end out does
 * not help either: the clearance grows one metre per metre travelled, so the
 * near part of the body keeps hugging the pipe for most of its length, which is
 * exactly the overlap the game refuses.
 *
 * The zero rung therefore starts exactly at `objective.start` — the objective's
 * own course, reused untouched — and every other rung starts at that same point
 * displaced purely along the ladder's lateral axis. No coordinate is invented:
 * the start of every candidate is `objective.start` plus a multiple of the
 * objective's own lateral.
 *
 * Candidates are ordered by increasing distance from the admitted course so the
 * caller's dry-run ladder prices the least intrusive course first, and the list
 * is truncated to `maximumCandidates`.
 */
/** How far before the service point a short access road stops, in turn, and the game's shortest street. */
export const SHORT_ROAD_BACK_METERS: readonly number[] = [8, 12, 4];
export const MINIMUM_ACCESS_ROAD_METERS = 8;

export function facilityAccessRoadCourseCandidates(
  request: FacilityAccessRoadCourseRequest,
): FacilityAccessRoadCandidate[] {
  const { objective, admittedCourse, facility, facilityServicePoint, envelope, prefab, maximumCandidates } = request;
  const span = distance(objective.start, objective.end);
  if (!(span > 0) || !(facility.halfExtent >= 0) || !(envelope.radius > 0)) return [];
  const along = { x: (objective.end.x - objective.start.x) / span, z: (objective.end.z - objective.start.z) / span };
  // Left normal of the objective bearing: the axis lateral displacement is on.
  const lateral = { x: -along.z, z: along.x };
  const clearance = clearanceOf(facility.halfExtent);
  const servicePointTolerance = request.servicePointTolerance ?? 3;
  if (!(servicePointTolerance >= 0) || !Number.isFinite(servicePointTolerance)) return [];
  const steps = [0, facility.halfExtent + 6, facility.halfExtent + 12, facility.halfExtent + 20];
  const contractions = [1, 0.7, 0.45];
  const candidates: FacilityAccessRoadCandidate[] = [];
  for (const step of steps) {
    for (const offset of step === 0 ? [0] : [step, -step]) {
      for (const contraction of contractions) {
        const reach = span * contraction;
        const start: SpatialPoint2 = {
          x: facilityServicePoint.x - along.x * reach + lateral.x * offset,
          z: facilityServicePoint.z - along.z * reach + lateral.z * offset,
        };
        const end: SpatialPoint2 = { ...facilityServicePoint };
        if (!(distance(start, end) > 0)) continue;
        if (!insideEnvelope(start, envelope) || !insideEnvelope(end, envelope)) continue;
        // A course may not run into the footprint of the facility it is being
        // built to serve: a road through the building is a different problem, not
        // an access road. Both endpoints are checked because the ladder moves
        // them together.
        if (distance(start, facility.position) <= facility.halfExtent) continue;
        // Clearance and a short contraction do not make an access road. The
        // current plan's own service point must lie on (or within bounded
        // geometric tolerance of) the candidate segment.
        if (pointSegmentDistance(facilityServicePoint, start, end) > servicePointTolerance) continue;
        const courseClearance = segmentDistance(start, end, admittedCourse.start, admittedCourse.end);
        candidates.push({
          actions: [{
            type: "build_road", prefab,
            x1: start.x, z1: start.z, x2: end.x, z2: end.z,
          }],
          offsetFromAdmittedCourse: courseClearance,
          reason: `facility_access_road_offset:${offset}:reach:${contraction}`,
        });
      }
    }
  }
  // Functional validity was enforced above. Among those, prefer greater pipe
  // clearance; stable sort preserves ladder order for ties.
  return candidates.sort((left, right) => right.offsetFromAdmittedCourse - left.offsetFromAdmittedCourse)
    .slice(0, Math.max(0, Math.floor(maximumCandidates)));
}

/**
 * The short road (live 2026-10-05, measured by the player by hand): a building is reached by a road that PASSES NEAR its front, not by one that ends on the
 * front point. A water pump on the shore had its front point over the water and its own pipe along the line, so every course ending there was refused
 * ("overlap, water"); a 7.9 m road from the street that stopped about 8 m short of the point joined it. These courses stop `back` metres before the point
 * and keep the game's shortest street (8 m). They are tried AFTER the ladder above has had its answer, never in place of it.
 */
export function shortAccessRoadCourseCandidates(request: FacilityAccessRoadCourseRequest): FacilityAccessRoadCandidate[] {
  const { objective, admittedCourse, facility, facilityServicePoint, envelope, prefab } = request;
  const span = distance(objective.start, objective.end);
  if (!(span > 0) || !(facility.halfExtent >= 0) || !(envelope.radius > 0)) return [];
  const along = { x: (objective.end.x - objective.start.x) / span, z: (objective.end.z - objective.start.z) / span };
  const short: FacilityAccessRoadCandidate[] = [];
  for (const back of SHORT_ROAD_BACK_METERS) {
    if (!(span - back >= MINIMUM_ACCESS_ROAD_METERS)) continue;
    const start: SpatialPoint2 = { x: facilityServicePoint.x - along.x * span, z: facilityServicePoint.z - along.z * span };
    const end: SpatialPoint2 = { x: facilityServicePoint.x - along.x * back, z: facilityServicePoint.z - along.z * back };
    if (!insideEnvelope(start, envelope) || !insideEnvelope(end, envelope) || distance(end, facility.position) <= facility.halfExtent) continue;
    short.push({ actions: [{ type: "build_road", prefab, x1: start.x, z1: start.z, x2: end.x, z2: end.z }],
      offsetFromAdmittedCourse: segmentDistance(start, end, admittedCourse.start, admittedCourse.end), reason: `facility_access_road_short:${back}:reach:1` });
  }
  return short;
}
/**
 * Whether the current world already carries this exact course.
 *
 * Duplicate-safety rather than tidiness: the game answers a second course over
 * an existing edge with a rejection, so a candidate that is already built is not
 * a repair. Both orientations are compared because an edge's stored endpoints
 * are the native node order, not the order the course was submitted in.
 */
export function isDuplicateAccessRoad(input: {
  action: MayorAction;
  worldEdges: readonly SpatialRoadEdge[];
  tolerance: number;
}): boolean {
  const { action, worldEdges, tolerance } = input;
  if (action.type !== "build_road") return false;
  const start: SpatialPoint2 = { x: action.x1, z: action.z1 };
  const end: SpatialPoint2 = { x: action.x2, z: action.z2 };
  return worldEdges.some((edge) => {
    if (edge.prefab !== action.prefab || edge.deleted === true) return false;
    const forward = distance(edge.start, start) <= tolerance && distance(edge.end, end) <= tolerance;
    const reversed = distance(edge.start, end) <= tolerance && distance(edge.end, start) <= tolerance;
    return forward || reversed;
  });
}

/**
 * Price the ladder and take the first course the world will actually host.
 *
 * The verdict is a native dry-run, so it must come from the caller: this
 * function only decides *which* course is taken and refuses to take any when
 * none of them is both duplicate-free and accepted at a finite quote. A refusal
 * carries every rung's reason, because "no course worked" is only actionable
 * when the ladder's own verdicts are.
 */
export async function selectFacilityAccessRoadCourse(input: {
  candidates: readonly FacilityAccessRoadCandidate[];
  facilityServicePoint?: SpatialPoint2;
  servicePointTolerance?: number;
  preflight(candidate: FacilityAccessRoadCandidate): Promise<FacilityAccessRoadPreflightVerdict>;
  worldEdges?: readonly SpatialRoadEdge[];
  tolerance?: number;
}): Promise<FacilityAccessRoadSelection> {
  const worldEdges = input.worldEdges ?? [];
  const tolerance = input.tolerance ?? 0.25;
  const servicePointTolerance = input.servicePointTolerance ?? 3;
  const reasons: string[] = [];
  for (const candidate of input.candidates) {
    if (input.facilityServicePoint && !candidate.reason.startsWith("facility_access_road_short:") && candidate.actions.some((action) => action.type !== "build_road" ||
      pointSegmentDistance(input.facilityServicePoint!, { x: action.x1, z: action.z1 }, { x: action.x2, z: action.z2 }) > servicePointTolerance)) {
      reasons.push(`INVALID_ACCESS_ROAD_COURSE:${candidate.reason}`);
      continue;
    }
    if (candidate.actions.some((action) => isDuplicateAccessRoad({ action, worldEdges, tolerance }))) {
      reasons.push(`DUPLICATE_ACCESS_ROAD_COURSE:${candidate.reason}`);
      continue;
    }
    const verdict = await input.preflight(candidate);
    if (!verdict.accepted) {
      reasons.push(verdict.reason ?? `NATIVE_PREFLIGHT_REJECTED:${candidate.reason}`);
      continue;
    }
    // A quote the spending contract could not read, or a negative one, cannot
    // fund the course it is attached to. Refusing the rung here keeps the
    // selection from handing a budget boundary a figure it must reject anyway.
    if (verdict.quote === null || !Number.isFinite(verdict.quote) || verdict.quote < 0) {
      reasons.push(`ACCESS_ROAD_QUOTE_UNKNOWN:${candidate.reason}`);
      continue;
    }
    return { status: "SELECTED", candidate, quote: verdict.quote };
  }
  return { status: "REFUSED", reasons };
}

export type AccessRoadRepairVerdict =
  | { status: "PERMITTED" }
  | { status: "REFUSED"; reason: string };

/**
 * Whether this slice may receive its one bounded access-road repair.
 *
 * Every clause is checked, and each one is checked in the direction that fails
 * closed: an unreadable value is not a satisfied one. The narrow shape is the
 * point. The facility must be placed (unlike the connection settlement, this
 * repair only exists AFTER a facility has landed), its connection must already
 * be an observed fact, and the frontage must be missing — a facility that
 * already has road access needs nothing and a facility nobody has proven is
 * missing that access is not a repair target.
 *
 * The electricity clause is a prohibition, not a preference: the product verdict
 * for this capability forbids building generation of any kind, so a city that
 * cannot already supply the power must be refused outright rather than answered
 * with a power plant.
 */
export function facilityAccessRoadRepairVerdict(input: {
  kind: "electricity" | "water" | "sewage";
  facilityPlacement: "PLACED" | "MISSING" | "UNRESOLVED" | "UNPROVEN" | "NONE";
  connectionEffect: "OBSERVED_MATCH" | string;
  roadAttachment: "ATTACHED" | "NONE" | "UNKNOWN";
  noRoadAccessWarning: boolean | "UNKNOWN";
  cityElectricityCapacitySufficient: boolean | "UNKNOWN";
  planServiceRoadCount: number;
  priorRepairCommandCount: number;
  duplicateRoadRisk: boolean | "UNKNOWN";
}): AccessRoadRepairVerdict {
  const refuse = (condition: string, observed: unknown): AccessRoadRepairVerdict => ({
    status: "REFUSED",
    reason: observed === "UNKNOWN"
      ? `ACCESS_ROAD_REPAIR_${condition}_UNKNOWN`
      : `ACCESS_ROAD_REPAIR_${condition}:${String(observed)}`,
  });
  // Only water is adjudicated in this round; an electricity or sewage slice has
  // no bounded authority to spend on a repair course.
  if (input.kind !== "water") return refuse("KIND_NOT_ADJUDICATED", input.kind);
  if (input.facilityPlacement !== "PLACED") return refuse("FACILITY_NOT_PLACED", input.facilityPlacement);
  if (input.connectionEffect !== "OBSERVED_MATCH") return refuse("CONNECTION_NOT_OBSERVED_MATCH", input.connectionEffect);
  // The world half of the verdict is the shared predicate's, so the planner and
  // the workflow's pre-wait gate can never disagree about whether this facility
  // still needs its road. The refusal is re-derived clause by clause here only so
  // that it still names the clause that failed, in the order the predicate
  // checks them — "the repair was refused" has to stay actionable.
  if (!facilityAccessRoadWorldPrecondition(input)) {
    if (input.roadAttachment === "UNKNOWN") return refuse("ROAD_ATTACHMENT", "UNKNOWN");
    if (input.roadAttachment !== "NONE") return refuse("ROAD_ALREADY_ATTACHED", input.roadAttachment);
    if (input.noRoadAccessWarning !== true) return refuse("NO_ROAD_ACCESS_WARNING_ABSENT", input.noRoadAccessWarning);
    return refuse("CITY_ELECTRICITY_CAPACITY_INSUFFICIENT", input.cityElectricityCapacitySufficient);
  }
  // The original plan must really have carried a service-road objective. Without
  // one there is no target geometry to avoid and no contact to attach to.
  if (!(input.planServiceRoadCount >= 1)) return refuse("PLAN_SERVICE_ROAD_MISSING", input.planServiceRoadCount);
  // Bounded sequential repair amendments. A prior access-road command spends one
  // attempt of the lineage, not the lineage itself: it may hold up to
  // FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX of them, each admitted only by
  // the clauses above (the previous attempt terminal, no authorization left
  // ACTIVE, no unresolved command) and by the mint's own ordinal derivation,
  // which can only ever advance the sequence by one. Past the ceiling the
  // lineage is closed rather than extended.
  if (input.priorRepairCommandCount >= FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX) {
    return refuse("PRIOR_REPAIR_ALREADY_COMMANDED", input.priorRepairCommandCount);
  }
  if (input.duplicateRoadRisk === "UNKNOWN") return refuse("DUPLICATE_ROAD_RISK", "UNKNOWN");
  if (input.duplicateRoadRisk !== false) return refuse("DUPLICATE_ROAD_RISK", input.duplicateRoadRisk);
  return { status: "PERMITTED" };
}
