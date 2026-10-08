import { createHash } from "node:crypto";
import type { SpatialEntityRef, SpatialPoint2, SpatialPoint3, SpatialRoadEdge, SpatialRoadNode } from "../spatial/types";
import type { RoadEndpointAttachment, RoadGeometryInput } from "./road-kernel";
import {
  createRoadCourseCertificationCache,
  roadCourseCertificationCacheMatches,
  roadCourseGeometryKey,
  sweepCertifiableRoadCourse,
  type RoadCourseCertificationCache,
  type RoadCourseProbeRejection,
  type RoadCourseProbeRetry,
  type RoadCourseSweepCourse,
} from "./road-course-sweep";
import { canonicalRoadOperation } from "./road-kernel";

export const ROAD_INTENT_SCHEMA_VERSION = "ai-mayor-v2-road-intent/1";

/**
 * A ROAD the Mayor asked for, as a place to leave from and a place to reach.
 *
 * This is the vocabulary the engineering book could not express: the structured
 * intent channel only ever named "which category of zone", so a goal that needed
 * a road was answered with another zoning tranche and the loop never moved.
 *
 * An endpoint that names an EXISTING_NET_NODE deliberately carries NO position.
 * Native validates a bound endpoint's `expectedPosition` EXACTLY, and a value
 * that did not come from the live scan fails with
 * `ROAD_ENDPOINT_POSITION_MISMATCH` before any road question is asked
 * (`BridgeToolSystem.CreateRoadDefinitions`, stage=DEFINITION). Carrying only the
 * entity ref means the position can only ever be read from the scan, so the
 * failure is not representable.
 */
export interface RoadIntentNodeEndpoint {
  kind: "EXISTING_NET_NODE";
  entity: SpatialEntityRef;
}

export interface RoadIntentPointEndpoint {
  kind: "FREE_POINT";
  position: SpatialPoint3;
}

export type RoadIntentEndpoint = RoadIntentNodeEndpoint | RoadIntentPointEndpoint;

export interface RoadIntentOwner {
  ownerType: "PROJECT" | "TRANCHE" | "TASK" | "MANUAL" | "AUDIT";
  ownerId: string;
}

export interface RoadIntent {
  /** Stable logical identity of this road. It survives world changes; the world does not. */
  intentId: string;
  prefab: string;
  from: RoadIntentEndpoint;
  to: RoadIntentEndpoint;
  owner: RoadIntentOwner;
  /** Optional override of the sweep family. Absent means the measured 8 × 3 grid. */
  offsets?: readonly number[];
  lengths?: readonly number[];
}

/** The live topology a road intent is resolved against. Nodes and edges come from `/spatial/bootstrap-scan`. */
export interface RoadIntentWorld {
  worldId: string;
  worldEpoch: string;
  topologyRevision: string;
  nodes: SpatialRoadNode[];
}

export interface RoadIntentWorldBinding {
  worldId: string;
  worldEpoch: string;
  topologyRevision: string;
}

const entityKey = (entity: SpatialEntityRef) => `${entity.index}:${entity.version}`;

/**
 * A stable revision of the road graph itself.
 *
 * The certification cache is a statement about a road graph, so the thing that
 * invalidates it is the graph changing — a road built, a node split, a course
 * deleted. A native generation is the wrong key for that: it changes on every
 * reload while the graph does not, which would throw away every certification
 * on a save/load and re-pay the 73% of call wall-clock the cache exists to
 * avoid.
 */
export function roadGraphRevision(input: {
  nodes: readonly SpatialRoadNode[];
  edges: readonly SpatialRoadEdge[];
}): string {
  const nodes = input.nodes
    .map((node) => `${entityKey(node.entity)}:${node.roadDegree}:${node.position.x.toFixed(2)},${node.position.z.toFixed(2)}`)
    .sort();
  const edges = input.edges
    .map((edge) => `${entityKey(edge.entity)}:${edge.prefab}:${entityKey(edge.startNode)}>${entityKey(edge.endNode)}`)
    .sort();
  return createHash("sha256").update(JSON.stringify({ nodes, edges })).digest("hex").slice(0, 16);
}

/**
 * The id of one road operation, derived ONLY from the intent's identity and the
 * ordinal of the course within its own deterministic family.
 *
 * Nothing about the world enters it — not population, not demand, not capacity,
 * not treasury, not finance band, and not the native generation. That is the fix
 * for the measured identity churn: `runtime.ts` folded exactly those moving
 * facts into a goal id, and one `PROVIDE_SERVICE:electricity` goal accumulated
 * twenty-four work orders while thirteen `EXPAND_COMMERCIAL` goals each built
 * one lone building twenty to sixty metres from the last.
 *
 * The consequence is the intended one: when the world moves, this id does not
 * change, so the operation is recognised as the same operation over changed
 * facts — and the answer to changed facts is STALE, not a new id.
 */
export function roadIntentOperationId(intentId: string, ordinal: number): string {
  if (!intentId || !Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error("ROAD_INTENT_OPERATION_IDENTITY_INVALID");
  }
  return `road-op:${createHash("sha256").update(`${intentId}|${ordinal}`).digest("hex").slice(0, 16)}`;
}

export type RoadIntentFreshness = "FRESH" | "STALE";

/**
 * Whether a resolution still describes the world being planned against.
 *
 * STALE says the world moved under a road that was already resolved. It does NOT
 * mint a new operation identity: the same intent and the same ordinal name the
 * same operation in any world, and a stale one is re-resolved under its own id.
 */
export function roadIntentFreshness(
  binding: RoadIntentWorldBinding,
  world: { worldId: string; topologyRevision: string },
): RoadIntentFreshness {
  return binding.worldId === world.worldId && binding.topologyRevision === world.topologyRevision ? "FRESH" : "STALE";
}

export type RoadIntentUnresolvedReason =
  | "ROAD_INTENT_FROM_NOT_BOUND"
  | "ROAD_INTENT_TO_NOT_BOUND"
  /**
   * Native refused the binding itself, before judging any course — a stale
   * coordinate or a reloaded world. Kept apart from "no course exists" because
   * re-binding is the repair, not replanning the road.
   */
  | "ROAD_INTENT_ENDPOINT_BINDING_REJECTED"
  | "ROAD_INTENT_NO_CERTIFIABLE_COURSE";

export interface RoadIntentResolutionCertified {
  status: "CERTIFIED";
  intentId: string;
  /** `hash(intentId, ordinal)`. Same intent and same course always spell the same operation. */
  operationId: string;
  ordinal: number;
  /**
   * The one geometry. It is what was certified AND what must be authorized —
   * previewing one shape and authorizing another is authorizing a different road.
   */
  input: RoadGeometryInput;
  course: RoadCourseSweepCourse;
  from: { entity: SpatialEntityRef | null; position: SpatialPoint3 };
  to: SpatialPoint2;
  binding: RoadIntentWorldBinding;
  probes: number;
  cacheHit: boolean;
  preview: unknown;
}

export interface RoadIntentResolutionUnresolved {
  status: "UNRESOLVED";
  intentId: string;
  reason: RoadIntentUnresolvedReason;
  detail?: string;
  rejections: RoadCourseProbeRejection[];
}

export interface RoadIntentResolutionContention {
  status: "UNRESOLVED_CONTENTION";
  intentId: string;
  reason: string;
  rejections: RoadCourseProbeRejection[];
}

export type RoadIntentResolution =
  | RoadIntentResolutionCertified
  | RoadIntentResolutionUnresolved
  | RoadIntentResolutionContention;

export interface RoadIntentResolutionPorts {
  /** The dry-run endpoint. Must be the same `cs2_spatial` preflight the Apply path previews with. */
  probe(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  /**
   * A certification cache. A cache scoped to another world or another graph
   * revision is ignored rather than consulted: its entries describe courses in a
   * road graph that no longer exists.
   */
  cache?: RoadCourseCertificationCache;
  retry?: RoadCourseProbeRetry;
  signal?: AbortSignal;
}

type BoundEndpoint =
  | { ok: true; entity: SpatialEntityRef | null; position: SpatialPoint3 }
  | { ok: false };

function bindEndpoint(endpoint: RoadIntentEndpoint, world: RoadIntentWorld): BoundEndpoint {
  if (endpoint.kind === "FREE_POINT") {
    const { x, y, z } = endpoint.position;
    if (![x, y, z].every(Number.isFinite)) return { ok: false };
    return { ok: true, entity: null, position: { x, y, z } };
  }
  const node = world.nodes.find((candidate) => entityKey(candidate.entity) === entityKey(endpoint.entity));
  if (!node) return { ok: false };
  // `native` is NOT a gate here. It is origin metadata, not authority: the roads
  // this product itself delivered come back `native: false`, so requiring it
  // would exclude exactly the network being expanded. Measured live
  // (2026-10-01): `75948:215` is present in the scan's road graph with a real
  // position and roadDegree 2, and is not marked native. A node the scan lists
  // is a network node; its position is the authoritative anchor either way.
  //
  // The scan's own coordinates, never a value carried in from outside.
  return { ok: true, entity: node.entity, position: node.position };
}

const endpointAttachment = (
  endpoint: { entity: SpatialEntityRef | null; position: SpatialPoint3 },
  role: RoadEndpointAttachment["role"],
  worldEpoch: string,
): RoadEndpointAttachment | undefined =>
  endpoint.entity
    ? { kind: "EXISTING_NET_NODE", role, entity: endpoint.entity, expectedPosition: endpoint.position, worldEpoch }
    : undefined;

/**
 * Resolve ROAD{from,to} into one executable, native-certified road.
 *
 * The order is the point. The intent's own course is tried first; when native
 * refuses it, the same source is swept across heading × length, because the set
 * of courses a node certifies is sparse and varies per node AND per length —
 * measured at one of twenty-four on `75948:215` and ten of twenty-four on
 * `52196:1`. A cone fan does not contain those courses; a sweep does.
 *
 * Nothing is built here and nothing is authorized: every probe is the same
 * `mode=preflight` dry run the product already previews with, so a sweep costs
 * native time and no world change.
 */
export async function resolveRoadIntent(
  intent: RoadIntent,
  world: RoadIntentWorld,
  ports: RoadIntentResolutionPorts,
): Promise<RoadIntentResolution> {
  const from = bindEndpoint(intent.from, world);
  if (!from.ok) {
    return { status: "UNRESOLVED", intentId: intent.intentId, reason: "ROAD_INTENT_FROM_NOT_BOUND", rejections: [] };
  }
  const to = bindEndpoint(intent.to, world);
  if (!to.ok) {
    return { status: "UNRESOLVED", intentId: intent.intentId, reason: "ROAD_INTENT_TO_NOT_BOUND", rejections: [] };
  }

  const supplied = ports.cache;
  const cache = supplied && roadCourseCertificationCacheMatches(supplied, world)
    ? supplied
    : createRoadCourseCertificationCache({ worldId: world.worldId, topologyRevision: world.topologyRevision });

  const startEndpoint = endpointAttachment(from, "START", world.worldEpoch);
  const result = await sweepCertifiableRoadCourse({
    from: from.position,
    prefab: intent.prefab,
    probe: ports.probe,
    to: to.position,
    ...(startEndpoint ? { startEndpoint } : {}),
    ...(intent.offsets ? { offsets: intent.offsets } : {}),
    ...(intent.lengths ? { lengths: intent.lengths } : {}),
    ...(ports.retry ? { retry: ports.retry } : {}),
    ...(ports.signal ? { signal: ports.signal } : {}),
    cache,
  });

  if (result.status === "EXHAUSTED") {
    return {
      status: "UNRESOLVED",
      intentId: intent.intentId,
      reason: "ROAD_INTENT_NO_CERTIFIABLE_COURSE",
      detail: `${result.rejections.length} course(s) refused across ${result.probes} probe(s)`,
      rejections: result.rejections,
    };
  }
  if (result.status === "UNRESOLVED_CONTENTION") {
    return { status: "UNRESOLVED_CONTENTION", intentId: intent.intentId, reason: result.reason, rejections: result.rejections };
  }
  if (result.status === "ENDPOINT_BINDING_FAILED") {
    return {
      status: "UNRESOLVED",
      intentId: intent.intentId,
      reason: "ROAD_INTENT_ENDPOINT_BINDING_REJECTED",
      detail: result.reason,
      rejections: [],
    };
  }

  const binding: RoadIntentWorldBinding = {
    worldId: world.worldId,
    worldEpoch: world.worldEpoch,
    topologyRevision: world.topologyRevision,
  };
  return {
    status: "CERTIFIED",
    intentId: intent.intentId,
    operationId: roadIntentOperationId(intent.intentId, result.course.ordinal),
    ordinal: result.course.ordinal,
    input: result.input,
    course: result.course,
    from: { entity: from.entity, position: from.position },
    to: { x: to.position.x, z: to.position.z },
    binding,
    probes: result.probes,
    cacheHit: result.cacheHit,
    preview: result.preview,
  };
}

/**
 * The runtime road caller's task for a certified intent.
 *
 * `createV2RuntimeRoadCaller().execute` consumes exactly this shape, and the
 * `owner` is what a durable ROAD command's authority is attributed to. Returning
 * it from here keeps the two halves from drifting: the geometry the caller
 * previews and authorizes is the geometry this module certified, not a re-derived
 * one.
 */
export function roadIntentExecutionTask(
  resolution: RoadIntentResolutionCertified,
  owner: RoadIntentOwner,
): { input: RoadGeometryInput; owner: RoadIntentOwner } {
  // `canonicalRoadOperation`, not `roadCourseGeometry`: the latter builds from a
  // `MayorAction`, which carries no endpoints, and would silently drop the bound
  // START this intent is attached by.
  return { input: canonicalRoadOperation(resolution.input).input, owner };
}

/** Whether one certified resolution's course still names the same geometry under a rebuilt input. */
export function roadIntentMatchesGeometry(resolution: RoadIntentResolution, input: RoadGeometryInput): boolean {
  if (resolution.status !== "CERTIFIED") return false;
  return roadCourseGeometryKey(
    { x: resolution.input.x1, z: resolution.input.z1 },
    { x: resolution.input.x2, z: resolution.input.z2 },
  ) === roadCourseGeometryKey({ x: input.x1, z: input.z1 }, { x: input.x2, z: input.z2 });
}
