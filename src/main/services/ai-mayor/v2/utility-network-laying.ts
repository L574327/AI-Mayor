import type {
  EffectMatcherResult,
  RoadEffectMatcher,
  V2CommandRecord,
  V2ObservationEnvelope,
  V2RoadEffectProvenance,
} from "./foundation";
import type { RoadExecutionResult, RoadGeometryInput } from "./road-kernel";
import type { SpatialEntityRef, SpatialPoint2 } from "../spatial/types";
import { matchNetworkLinkCourseEffect, type NetworkLinkCourseRoad } from "./network-link-course-effect";
import { observedWorldIdentity, operationIdle } from "./road-effect";

export const UTILITY_NETWORK_LAYING_SCHEMA_VERSION = "ai-mayor-v2-utility-network-laying/1";

/**
 * The prefabs a course may be laid with, and the reason this list exists at all.
 *
 * A pipe is a net edge. The bootstrap scan builds its road graph by requiring
 * the prefab to carry `RoadData`, so every one of these is absent from it by
 * construction — measured live 2026-10-02: 429 scanned edges, all road prefabs,
 * while the world held 11 `Small Sewage Pipe` and a `Low-voltage Ground Cable`.
 * Driving the production ROAD matcher with such a course returns
 * `MISMATCH + effectAbsenceProven` for a pipe that is physically present, and
 * returns the identical verdict for the same prefab at empty coordinates. A
 * proven absence is the input to a rollback decision, so that matcher is not
 * merely blind here — it is wrong in the one direction it must not be.
 *
 * Names come from `/prefabs?category=net`. They are a vocabulary, not a
 * guess: a prefab outside this list is a road course and goes to the road
 * matcher.
 */
export const UTILITY_NET_PREFABS: readonly string[] = [
  "Small Water Pipe",
  "Large Water Pipe",
  "Small Sewage Pipe",
  "Large Sewage Pipe",
  "Combined Small Pipe",
  "Combined Large Pipe",
  "Low-voltage Ground Cable",
  "High-voltage Ground Cable",
];

export function isUtilityNetPrefab(prefab: string): boolean {
  return UTILITY_NET_PREFABS.includes(prefab);
}

/** One prefab's placed edges, exactly as the listing that holds them returned them. */
export interface NetEdgeListing {
  prefab: string;
  roads: readonly NetworkLinkCourseRoad[];
  /** The listing's own completeness contract: it has no `truncated` flag of its own. */
  totalMatches: number;
  returned: number;
  truncated?: boolean;
  hasMore?: boolean;
}

export interface NetEdgeListings {
  listings: Readonly<Record<string, NetEdgeListing>>;
}

/** The prefab a durable ROAD command's exact input names, or null if it is not a well-formed course. */
export function utilityNetPrefabOf(command: V2CommandRecord): string | null {
  if (command.authorizedScope.actionFamily !== "ROAD") return null;
  try {
    const input = JSON.parse(command.authorizedScope.exactInput) as Record<string, unknown>;
    return typeof input.prefab === "string" && input.prefab.length > 0 ? input.prefab : null;
  } catch {
    return null;
  }
}

type CourseInput = { prefab: string; x1: number; z1: number; x2: number; z2: number; cx?: number; cz?: number };

function parseCourseInput(command: V2CommandRecord): CourseInput | null {
  if (command.authorizedScope.actionFamily !== "ROAD") return null;
  try {
    const input = JSON.parse(command.authorizedScope.exactInput) as Record<string, unknown>;
    const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
    if (typeof input.prefab !== "string" || !finite(input.x1) || !finite(input.z1) || !finite(input.x2) || !finite(input.z2)) {
      return null;
    }
    return {
      prefab: input.prefab,
      x1: input.x1,
      z1: input.z1,
      x2: input.x2,
      z2: input.z2,
      ...(finite(input.cx) && finite(input.cz) ? { cx: input.cx, cz: input.cz } : {}),
    };
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export interface NetEdgeCourseEffectReport {
  matcherResult: EffectMatcherResult;
  effectAbsenceProven: boolean;
  matchedEdges: SpatialEntityRef[];
  reason: string;
}

/**
 * Whether a submitted net course is present in the world now.
 *
 * This is the same question `matchRoadEffect` answers, asked against the view
 * that actually holds pipes. Every gate the ROAD matcher applies to earn the
 * right to say "absent" is applied here unchanged:
 *
 *   - the observation must be one coherent world,
 *   - the command must be owned by the durable lineage of the world observed,
 *   - native must have been authoritatively Idle, and
 *   - the listing must be complete.
 *
 * A listing that is short of its own total is missing evidence, not evidence of
 * absence, so it is INCONCLUSIVE. That asymmetry is the whole point: a false
 * absence rolls back a healthy world, a false inconclusive only asks again.
 */
export function matchNetEdgeCourseEffect(input: {
  command: V2CommandRecord;
  observation: V2ObservationEnvelope;
  provenance?: V2RoadEffectProvenance | null;
}): NetEdgeCourseEffectReport {
  const { command, observation } = input;
  const inconclusive = (reason: string): NetEdgeCourseEffectReport => ({
    matcherResult: "INCONCLUSIVE",
    effectAbsenceProven: false,
    matchedEdges: [],
    reason,
  });
  if (observation.coherence === "UNKNOWN") {
    return inconclusive("authoritative observation is incoherent; net course effect cannot be judged");
  }
  const course = parseCourseInput(command);
  if (!course) return inconclusive("durable ROAD exact input is malformed");
  if (!isUtilityNetPrefab(course.prefab)) {
    return inconclusive(`prefab ${course.prefab} is not a net pipe/cable course`);
  }
  const provenance = input.provenance ?? null;
  if (!provenance) {
    return inconclusive("no durable world lineage owns this command, so this observation cannot be attributed to a world");
  }
  if (
    provenance.lineageCheckpointIds.length === 0 ||
    !provenance.lineageCheckpointIds.includes(provenance.baseCheckpointId)
  ) {
    return inconclusive("net course provenance does not rest on a durable checkpoint owning this command");
  }
  const observedWorld = observedWorldIdentity(observation);
  if (
    observedWorld.worldId === null ||
    observedWorld.worldId !== provenance.worldId ||
    observedWorld.nativeSessionGuid !== provenance.nativeSessionGuid
  ) {
    return inconclusive(
      "the net edge listing was observed in a world that is not the native world of this command's durable lineage",
    );
  }
  const source = observation.sources.netEdges;
  if (!source || source.status === "UNAVAILABLE") {
    return inconclusive(
      source?.reason ?? "the observation carries no net edge listing, so a net course cannot be judged",
    );
  }
  const listing = (record(source.data) as unknown as NetEdgeListings).listings?.[course.prefab] ?? null;
  if (!listing) {
    return inconclusive(`the net edge listing does not cover prefab ${course.prefab}`);
  }
  const complete =
    Array.isArray(listing.roads) &&
    Number.isInteger(listing.totalMatches) &&
    Number.isInteger(listing.returned) &&
    listing.returned === listing.roads.length &&
    listing.returned === listing.totalMatches &&
    listing.truncated !== true &&
    listing.hasMore !== true;
  if (!complete) {
    return inconclusive(
      listing.truncated === true || listing.hasMore === true
        ? `authoritative net edge listing for ${course.prefab} is truncated`
        : `authoritative net edge listing for ${course.prefab} is incomplete`,
    );
  }
  const match = matchNetworkLinkCourseEffect({
    roads: listing.roads,
    prefab: course.prefab,
    start: { x: course.x1, z: course.z1 },
    end: { x: course.x2, z: course.z2 },
    // The ROAD matcher's endpoint window, and the tolerance the existing
    // network-link readback already reconciles cables with.
    tolerance: 1,
  });
  if (match.status === "MATCH") {
    return {
      matcherResult: "MATCH",
      effectAbsenceProven: false,
      matchedEdges: match.edges.flatMap((edge) => (edge.entity ? [edge.entity] : [])),
      reason: `authoritative net listing contains ${match.edges.length} connected ${course.prefab} course edge(s)`,
    };
  }
  if (match.status === "MISSING") {
    // Absence is only provable from a complete listing of an idle world, which
    // is exactly what the gates above established.
    if (!operationIdle(observation)) {
      return inconclusive("native operation is not authoritatively Idle; net course absence cannot be certified");
    }
    return {
      matcherResult: "MISMATCH",
      effectAbsenceProven: true,
      matchedEdges: [],
      reason: `complete authoritative Idle net listing contains no ${course.prefab} course matching the proposal (${match.reason})`,
    };
  }
  // AMBIGUOUS / MALFORMED: the listing is complete but cannot name one course.
  return inconclusive(`net course could not be identified uniquely (${match.status}: ${match.reason})`);
}

/**
 * The production matcher for a queue that lays roads AND utilities.
 *
 * A course whose prefab is a net pipe/cable is judged against the net listing;
 * everything else is handed to the road matcher untouched. The dispatch is by
 * prefab because that is the only thing that decides which view can see the
 * object — and it is asked before the world is read, so a road course still
 * captures exactly the observation it always did.
 */
export function createNetEdgeCourseEffectMatcher(options: {
  road: RoadEffectMatcher;
  resolveProvenance(command: V2CommandRecord): V2RoadEffectProvenance | null;
}): RoadEffectMatcher {
  return {
    match: ({ command, observation }) => {
      const prefab = utilityNetPrefabOf(command);
      if (!prefab || !isUtilityNetPrefab(prefab)) return options.road.match({ command, observation });
      const report = matchNetEdgeCourseEffect({
        command,
        observation,
        provenance: options.resolveProvenance(command),
      });
      return {
        result: report.matcherResult,
        evidence: report,
        reason: report.reason,
        effectAbsenceProven: report.effectAbsenceProven,
      };
    },
    netEdgePrefabs: (command) => {
      const prefab = utilityNetPrefabOf(command);
      return prefab && isUtilityNetPrefab(prefab) ? [prefab] : null;
    },
  };
}

export interface UtilityStreetSourceEdge {
  entity: SpatialEntityRef;
  start: SpatialPoint2;
  end: SpatialPoint2;
}

export interface UtilityStreetCourse {
  /** The street this course covers. It is the whole reason the course exists. */
  edgeRef: SpatialEntityRef;
  input: RoadGeometryInput;
}

export type UtilityNetKind = "ELECTRICITY" | "WATER" | "SEWAGE";

export interface AllocatableStreet {
  ref: SpatialEntityRef;
  startNode: SpatialEntityRef;
  endNode: SpatialEntityRef;
}

export interface UtilityStreetAllocation {
  assignments: Array<{ net: UtilityNetKind; streets: SpatialEntityRef[] }>;
  /** Streets no net could take without sharing a node with an assigned street. */
  unassigned: SpatialEntityRef[];
  /** Node pairs that ended up carrying two nets anyway — the world has the last word. */
  conflicts: Array<{ node: SpatialEntityRef; nets: UtilityNetKind[] }>;
  detail: string;
}

/**
 * Split a district's streets between the three nets, one net per street.
 *
 * WHY. "Each road node carries exactly one net object" is a strong measured
 * regularity, so the three nets cannot run down the same street: whichever is
 * laid first occupies the nodes and the others are refused. Serving a district
 * therefore needs the split decided BEFORE the first course, not rediscovered as
 * a refusal.
 *
 * It is a GREEDY split, not a graph guarantee. On the east group the node degree
 * histogram reaches 5, so a strictly node-disjoint 3-colouring does not exist
 * (200 random orders all bottomed out at 5 colours), and the world has already
 * shown pairs of streets sharing a node that both succeeded. So this returns the
 * best assignment it can and names the streets it could not place; the native
 * preflight stays the authority on whether any given course is accepted.
 *
 * A MARKER-ONLY SERVICE IS THE EXPECTED OUTCOME. A facility's marker attaches to
 * ONE road edge and its service reaches the streets road-connected to it, so if
 * the measurement shows a marker alone covers the district, the caller lays one
 * course per net and keeps the rest of this split as the fallback — the
 * allocation is cheap to compute and wrong to skip.
 */
export function allocateUtilityStreets(input: {
  streets: readonly AllocatableStreet[];
  nets?: readonly UtilityNetKind[];
}): UtilityStreetAllocation {
  const nets = input.nets ?? (["ELECTRICITY", "SEWAGE", "WATER"] as const);
  if (nets.length === 0) throw new Error("ALLOCATE_UTILITY_STREETS_REQUIRES_AT_LEAST_ONE_NET");
  const key = (ref: SpatialEntityRef) => `${ref.index}:${ref.version}`;

  const quota = Math.ceil(input.streets.length / nets.length);
  const taken = new Map<UtilityNetKind, SpatialEntityRef[]>(nets.map((net) => [net, []]));
  const usedNodes = new Set<string>();
  const unassigned: SpatialEntityRef[] = [];
  const ownerByStreet = new Map<string, UtilityNetKind>();

  for (const [index, street] of input.streets.entries()) {
    const nodes = [street.startNode, street.endNode];
    const nodeKeys = nodes.map(key);
    if (nodeKeys.some((nodeKey) => usedNodes.has(nodeKey))) {
      unassigned.push(street.ref);
      continue;
    }
    let placed = false;
    for (let offset = 0; offset < nets.length; offset += 1) {
      const net = nets[(index + offset) % nets.length]!;
      if ((taken.get(net) ?? []).length >= quota) continue;
      taken.get(net)!.push(street.ref);
      ownerByStreet.set(key(street.ref), net);
      for (const nodeKey of nodeKeys) usedNodes.add(nodeKey);
      placed = true;
      break;
    }
    if (!placed) unassigned.push(street.ref);
  }

  // Report any node that still ended up under two nets, so the caller can
  // preview those streets first instead of discovering them at build time.
  const netsByNode = new Map<string, { node: SpatialEntityRef; nets: UtilityNetKind[] }>();
  for (const street of input.streets) {
    const owner = ownerByStreet.get(key(street.ref));
    if (!owner) continue;
    for (const node of [street.startNode, street.endNode]) {
      const entry = netsByNode.get(key(node)) ?? { node, nets: [] };
      if (!entry.nets.includes(owner)) entry.nets.push(owner);
      netsByNode.set(key(node), entry);
    }
  }
  const conflicts = [...netsByNode.values()].filter((entry) => entry.nets.length > 1);

  return {
    assignments: nets.map((net) => ({ net, streets: taken.get(net) ?? [] })),
    unassigned,
    conflicts,
    detail: `${input.streets.length} streets -> ${nets.map((net) => `${net}:${(taken.get(net) ?? []).length}`).join(" ")}`
      + `, unassigned=${unassigned.length}, nodeConflicts=${conflicts.length}`,
  };
}

export interface StreetSelectionBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * The streets of a component whose MIDPOINT falls inside a box.
 *
 * WHY THIS EXISTS. Serving a whole connected component is right for a city-wide
 * bootstrap and wrong for a district: the moment a new district is road-connected
 * to the old city the two are ONE component, and "the component" measured on
 * 2026-10-02 was 398 streets spanning the whole map. A district needs "the
 * streets I just laid" as the work unit, which is a sub-area question, not a
 * connectivity one.
 *
 * Midpoint (not either endpoint), so a street that merely reaches the box edge
 * across a junction is not dragged in: the box picks streets that are inside it.
 */
export function selectUtilityStreetsInBounds(input: {
  edges: readonly UtilityStreetSourceEdge[];
  bounds: StreetSelectionBounds;
}): UtilityStreetSourceEdge[] {
  const { minX, minZ, maxX, maxZ } = input.bounds;
  return input.edges.filter((edge) => {
    const midX = (edge.start.x + edge.end.x) / 2;
    const midZ = (edge.start.z + edge.end.z) / 2;
    return Number.isFinite(midX) && Number.isFinite(midZ) &&
      midX >= minX && midX <= maxX && midZ >= minZ && midZ <= maxZ;
  });
}

/**
 * One course per street of a road component, each its own command.
 *
 * The component is the input and the streets are the work units: a course that
 * spanned several streets would be one command covering several distinct
 * streets, and a failure in any of them would make the whole command
 * unreadable. Per street, the readback names exactly which street did not take.
 *
 * This does NOT decide WHICH component to serve. That is the plan layer's
 * question; this layer only delivers "every street of this component carries
 * the course".
 */
export function planUtilityStreetsAlongComponent(input: {
  prefab: string;
  edges: readonly UtilityStreetSourceEdge[];
}): UtilityStreetCourse[] {
  if (!isUtilityNetPrefab(input.prefab)) {
    throw new Error(`UTILITY_NET_PREFAB_NOT_LAYABLE:${input.prefab}`);
  }
  const courses: UtilityStreetCourse[] = [];
  const seen = new Set<string>();
  for (const edge of input.edges) {
    const { x, z } = edge.start;
    const end = edge.end;
    if (![x, z, end.x, end.z].every(Number.isFinite)) continue;
    if (Math.hypot(end.x - x, end.z - z) <= 0) continue;
    const key = [x.toFixed(3), z.toFixed(3), end.x.toFixed(3), end.z.toFixed(3)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    courses.push({
      edgeRef: edge.entity,
      input: { prefab: input.prefab, x1: x, z1: z, x2: end.x, z2: end.z },
    });
  }
  return courses;
}

export interface UtilityStreetLayingOutcome {
  edgeRef: SpatialEntityRef;
  commandId: string | null;
  status: string;
  reconciliationStatus: string;
  matcherResult: EffectMatcherResult | null;
  effectAbsenceProven: boolean;
  reason: string;
}

export interface UtilityComponentLayingReport {
  prefab: string;
  matched: number;
  attempted: number;
  planned: number;
  stopped: boolean;
  streets: UtilityStreetLayingOutcome[];
}

/**
 * Lay one course along every street of a component, one command each.
 *
 * The execution channel is the ROAD kernel's, unchanged: same preview, same
 * quote, same admission, same Apply-once, same reconciliation. Nothing is
 * retried here — a street that does not come back as a readback MATCH stops the
 * run and is reported, because a second attempt against a native refusal is how
 * a repeat loop starts.
 */
export async function layUtilityAlongRoadComponent(input: {
  prefab: string;
  edges: readonly UtilityStreetSourceEdge[];
  owner: { ownerType: "PROJECT" | "TRANCHE" | "TASK" | "MANUAL" | "AUDIT"; ownerId: string };
  execute(task: { input: RoadGeometryInput; owner: { ownerType: string; ownerId: string } }, signal?: AbortSignal): Promise<RoadExecutionResult>;
  signal?: AbortSignal;
}): Promise<UtilityComponentLayingReport> {
  const courses = planUtilityStreetsAlongComponent({ prefab: input.prefab, edges: input.edges });
  const streets: UtilityStreetLayingOutcome[] = [];
  let stopped = false;
  for (const course of courses) {
    const result = await input.execute(
      { input: course.input, owner: input.owner },
      input.signal,
    );
    const report = result.effectReport;
    const outcome: UtilityStreetLayingOutcome = {
      edgeRef: course.edgeRef,
      commandId: result.command.commandId,
      status: result.command.status,
      reconciliationStatus: result.command.reconciliationStatus,
      matcherResult: report?.matcherResult ?? null,
      effectAbsenceProven: result.command.effectAbsenceProven,
      reason: report?.reason ?? result.command.failureOrUnknownReason ?? "no reconciliation performed",
    };
    streets.push(outcome);
    if (outcome.matcherResult !== "MATCH") {
      stopped = true;
      break;
    }
  }
  return {
    prefab: input.prefab,
    matched: streets.filter((street) => street.matcherResult === "MATCH").length,
    attempted: streets.length,
    planned: courses.length,
    stopped,
    streets,
  };
}
