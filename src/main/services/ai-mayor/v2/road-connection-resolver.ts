import type {
  SpatialBuilding,
  SpatialLocalTerrain,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialRoadNode,
  SpatialTile,
} from "../spatial/types";
import { pointInTile } from "../spatial/world-scanner";
import {
  MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  NET_SEGMENT_LENGTH_NUMERIC_EPSILON_METERS,
  bridgeDomainNetSegmentLength,
  minimumBridgeDomainEndpoint,
} from "./road-contract";
import type { RoadEndpointRebindSuccess } from "./road-endpoint-rebind";
import type { RoadEndpointAttachment, RoadGeometryInput } from "./road-kernel";
import { rankRoadPlanningCandidates } from "./road-planning-policy";

// The shared grid frame and the road-candidate shape now live in the grid
// generator, which is their only author; this module re-exports them so existing
// importers keep compiling while the bounded corridor family is retired.
import {
  MAX_PLANNING_ROAD_GRADE_PERCENT,
  sharedRoadGridReference,
  type RoadCandidate,
  type RoadCandidateResolution,
  type RoadCandidateVariant,
  type RoadSourceAnchorEvidence,
  type SharedRoadGridReference,
} from "./road-grid-generator";

export { MAX_PLANNING_ROAD_GRADE_PERCENT, sharedRoadGridReference };
export type {
  RoadCandidate,
  RoadCandidateResolution,
  RoadCandidateVariant,
  RoadSourceAnchorEvidence,
  SharedRoadGridReference,
};

/**
 * How many bounded courses one contact derivation may offer.
 *
 * Seven was a budget spent almost entirely on DEPTH: the round-robin walks one
 * variant per source per round, so with three sources the family reached each
 * source's first two variants and stopped — the direct contact and its interior
 * inset. Every one of the rotated headings the provider builds was past the cap
 * and never previewed.
 *
 * That matters because native's certifiable set is not a property of the
 * direction alone. A live sweep of one failing source node found it certified
 * headings 0..60 and 270..330 degrees at 12 m while refusing the same headings
 * at 20 m, and a second node certified NOTHING at 12 m but two sectors at 20 m.
 * A family that offers each heading at a single length samples half of the space
 * that decides the answer.
 *
 * Twenty-four is eight variants across three sources: enough for the direct
 * contact and its inset plus four rotated headings, two of them at both lengths,
 * and still bounded — every candidate passes the same scope, length, geometry
 * and native-preview filters, and the selector stops at the first FEASIBLE one.
 */
export const MAXIMUM_BOUNDED_ROAD_CANDIDATES = 24;

/**
 * The order one source offers its variants in.
 *
 * Interleaved by heading and length rather than grouped, because the budget is
 * shared with the other sources: whatever comes first is the only thing the
 * family ever previews when a source is one of three.
 */
const WIDEST_CONTACT_OFFSETS_DEGREES = [90, -90, 45, -45, 135, -135, 18, -18] as const;

export interface RoadResolverScope {
  center: SpatialPoint2;
  radius: number;
}

export interface RoadResolverInput {
  siteTarget: SpatialPoint2;
  reservation: RoadResolverScope;
  planningEnvelope?: RoadResolverScope;
  sourceEdges: SpatialRoadEdge[];
  sourceNodes: SpatialRoadNode[];
  /** Optional bounded allow-list for topology nodes that may seed this connection. */
  allowedSourceNodeRefs?: SpatialRoadNode["entity"][];
  /** Prefer one site's admitted frontage first while retaining bounded fallback sources. */
  preferredSourceNodeRefs?: SpatialRoadNode["entity"][];
  /** Ordinary Mayor road work prefers the shared grid; callers may retain the corridor-first order. */
  roadFamilyPreference?: "ORTHOGONAL_GRID" | "FREE_CORRIDOR";
  sourceGraphTruncated?: boolean;
  ownedTiles: SpatialTile[];
  terrain?: SpatialLocalTerrain;
  buildings?: SpatialBuilding[];
  protectedScopes?: RoadResolverScope[];
  prefab?: string;
  maxSourceDistance?: number;
  maxGradePercent?: number;
  /** Raw Bridge generation token. Distinct from durable WorldEpochId. */
  bridgeGeneration?: string;
  worldEpoch?: string;
  /** Optional result of fail-closed durable-locator rebinding in the current WorldEpoch. */
  reboundSource?: RoadEndpointRebindSuccess;
  /** One exact, already certified permanent edge/node may seed a bounded continuation. */
  certifiedContinuationSource?: { edge: SpatialRoadEdge; node: SpatialRoadNode; role: "start" | "end" };
  /**
   * The road prefabs the unlocked catalogue offers, when the caller has them.
   *
   * The scan's `native` flag marks the MAP's own network, not the player's: the
   * roads this product itself delivered come back with `native: false` next to a
   * live entity and real geometry. Requiring `native` therefore excluded the
   * whole delivered network from road planning — a bounded resolution could only
   * seed from the handful of map edges, so its candidate family was too thin to
   * survive a single native rejection, and a corridor step that was refused once
   * had no legal neighbour left to try.
   *
   * With the catalogue, an edge this project could have built is a source too,
   * and the family regains the headings and lengths the delivered network
   * actually offers. Callers that pass no catalogue keep the previous
   * map-native-only behaviour exactly, so nothing that is not a buildable road
   * prefab ever becomes a source.
   */
  availableRoadPrefabs?: readonly string[];
}

/** Whether an observed edge is a road this project can build from. */
const catalogueRoadEdge = (edge: SpatialRoadEdge, availableRoadPrefabs?: readonly string[]): boolean =>
  availableRoadPrefabs?.includes(edge.prefab) ?? false;

/** Whether an observed node is an endpoint of a road this project can build from. */
const catalogueRoadNode = (node: SpatialRoadNode, input: RoadResolverInput): boolean =>
  input.sourceEdges.some((edge) =>
    (entityKey(edge.startNode) === entityKey(node.entity) || entityKey(edge.endNode) === entityKey(node.entity)) &&
    catalogueRoadEdge(edge, input.availableRoadPrefabs));

const EPSILON = 1e-6;
// A candidate leaving a node inside an incident corridor is not a new road
// primitive even when floating-point noise keeps the old cross-product test
// technically non-collinear. These are physical corridor bounds, not native
// minimum-length tolerances: a 25m probe may deviate by at most 1m and remain
// in the same forward corridor. The probe is bounded so distant geometry does
// not make a local junction fail closed.
const INCIDENT_CORRIDOR_PROBE_METERS = 25;
// Native preflight treated the live 2.8-degree continuation below as an edit
// to the existing road corridor at 1.22m lateral separation. Keep a small
// margin above that measured contact so it is rejected before native preview.
const INCIDENT_CORRIDOR_MAX_LATERAL_METERS = 1.5;
const INCIDENT_CORRIDOR_MAX_ANGLE_RADIANS = (5 * Math.PI) / 180;
// Continuation geometry is deliberately longer than the generic native
// minimum.  The Bridge accepts 8m, but a starter continuation must reach a
// productive, free endpoint instead of merely satisfying that input bound.
const PREFERRED_CONTINUATION_LENGTH_METERS = 16;
// A reservation-boundary road can satisfy Bridge's 8m geometry contract while
// Game's CourseSplitSystem still collapses its free endpoint back to the source
// node. Keep one deterministic, terrain-filtered alternative farther inside
// the site. Live evidence shows the 16m inset produces an identifiable proposal
// edge for the current 28m starter reservation while leaving 12m to its center.
const PRODUCTIVE_RESERVATION_CONTACT_INSET_METERS = PREFERRED_CONTINUATION_LENGTH_METERS;
const finitePoint = (point: SpatialPoint2): boolean => Number.isFinite(point.x) && Number.isFinite(point.z);
const entityKey = (entity: { index: number; version: number }): string => `${entity.index}:${entity.version}`;
const distance = (left: SpatialPoint2, right: SpatialPoint2): number =>
  Math.hypot(left.x - right.x, left.z - right.z);
const pointInScope = (point: SpatialPoint2, scope: RoadResolverScope): boolean =>
  scope.radius > 0 && distance(point, scope.center) <= scope.radius + EPSILON;
const lerp = (left: SpatialPoint2, right: SpatialPoint2, amount: number): SpatialPoint2 => ({
  x: left.x + (right.x - left.x) * amount,
  z: left.z + (right.z - left.z) * amount,
});
const vector = (from: SpatialPoint2, to: SpatialPoint2): SpatialPoint2 => ({ x: to.x - from.x, z: to.z - from.z });
const cross = (left: SpatialPoint2, right: SpatialPoint2): number => left.x * right.z - left.z * right.x;
const dot = (left: SpatialPoint2, right: SpatialPoint2): number => left.x * right.x + left.z * right.z;

function gridStationError(point: SpatialPoint2, reference: SharedRoadGridReference): number {
  const offset = vector(reference.origin, point);
  const along = offset.x * Math.cos(reference.orientationRadians) + offset.z * Math.sin(reference.orientationRadians);
  const across = -offset.x * Math.sin(reference.orientationRadians) + offset.z * Math.cos(reference.orientationRadians);
  const residual = (value: number) => {
    const remainder = value - Math.round(value / reference.spacingMeters) * reference.spacingMeters;
    return Math.abs(remainder);
  };
  return Math.hypot(residual(along), residual(across));
}

export function nearCollinearIncidentCorridor(
  sourceAnchor: SpatialPoint2,
  candidateTarget: SpatialPoint2,
  sourceNode: SpatialRoadNode,
  incidentEdges: SpatialRoadEdge[],
): boolean {
  const candidateVector = vector(sourceAnchor, candidateTarget);
  const candidateLength = Math.hypot(candidateVector.x, candidateVector.z);
  if (candidateLength <= EPSILON) return false;
  const candidateUnit = { x: candidateVector.x / candidateLength, z: candidateVector.z / candidateLength };
  for (const edge of incidentEdges) {
    const sourceIsStart = entityKey(edge.startNode) === entityKey(sourceNode.entity);
    const sourceIsEnd = entityKey(edge.endNode) === entityKey(sourceNode.entity);
    if (!sourceIsStart && !sourceIsEnd) continue;
    const incidentTarget = sourceIsStart ? edge.end : edge.start;
    const incidentVector = vector(sourceAnchor, incidentTarget);
    const incidentLength = Math.hypot(incidentVector.x, incidentVector.z);
    if (incidentLength <= EPSILON) continue;
    const incidentUnit = { x: incidentVector.x / incidentLength, z: incidentVector.z / incidentLength };
    const cosine = dot(candidateUnit, incidentUnit);
    // Only the outward, same-direction half-ray is an overlapping corridor.
    // A reverse-direction continuation is a legitimate way to leave the node.
    if (cosine <= 0 || cosine < Math.cos(INCIDENT_CORRIDOR_MAX_ANGLE_RADIANS)) continue;
    const probe = Math.min(INCIDENT_CORRIDOR_PROBE_METERS, candidateLength, incidentLength);
    const lateralSeparation = Math.abs(cross(candidateUnit, incidentUnit)) * probe;
    if (lateralSeparation <= INCIDENT_CORRIDOR_MAX_LATERAL_METERS) return true;
  }
  return false;
}

function terrainIndex(terrain: SpatialLocalTerrain, point: SpatialPoint2): number | null {
  const { minX, minZ, maxX, maxZ } = terrain.bounds;
  if (maxX <= minX || maxZ <= minZ || terrain.resolution <= 0) return null;
  if (point.x < minX || point.x > maxX || point.z < minZ || point.z > maxZ) return null;
  const col = Math.min(terrain.resolution - 1, Math.max(0, Math.floor(((point.x - minX) / (maxX - minX)) * terrain.resolution)));
  const row = Math.min(terrain.resolution - 1, Math.max(0, Math.floor(((point.z - minZ) / (maxZ - minZ)) * terrain.resolution)));
  return row * terrain.resolution + col;
}

function pointInsideBuilding(point: SpatialPoint2, building: SpatialBuilding): boolean {
  const bounds = building.footprint?.bounds;
  return !!bounds && point.x >= bounds.min.x && point.x <= bounds.max.x && point.z >= bounds.min.z && point.z <= bounds.max.z;
}

function segmentIntersectsBuilding(start: SpatialPoint2, end: SpatialPoint2, building: SpatialBuilding): boolean {
  const bounds = building.footprint?.bounds;
  if (!bounds) return false;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let lower = 0;
  let upper = 1;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) <= EPSILON) return q >= 0;
    const t = q / p;
    if (p < 0) lower = Math.max(lower, t);
    else upper = Math.min(upper, t);
    return lower <= upper;
  };
  return clip(-dx, start.x - bounds.min.x) &&
    clip(dx, bounds.max.x - start.x) &&
    clip(-dz, start.z - bounds.min.z) &&
    clip(dz, bounds.max.z - start.z);
}

function pointInsideOwned(point: SpatialPoint2, tiles: SpatialTile[]): boolean {
  return tiles.some((tile) => tile.owned && pointInTile(point, tile));
}

function segmentIntersectsScope(start: SpatialPoint2, end: SpatialPoint2, scope: RoadResolverScope): boolean {
  const length = distance(start, end);
  const samples = Math.max(2, Math.ceil(length / Math.max(1, scope.radius / 2)));
  for (let index = 0; index <= samples; index += 1) {
    if (pointInScope(lerp(start, end, index / samples), scope)) return true;
  }
  return false;
}

function segmentIntersection(start: SpatialPoint2, end: SpatialPoint2, otherStart: SpatialPoint2, otherEnd: SpatialPoint2) {
  const first = vector(start, end);
  const second = vector(otherStart, otherEnd);
  const denominator = cross(first, second);
  if (Math.abs(denominator) <= EPSILON) return null;
  const offset = vector(start, otherStart);
  const alongCandidate = cross(offset, second) / denominator;
  const alongOther = cross(offset, first) / denominator;
  if (alongCandidate < -EPSILON || alongCandidate > 1 + EPSILON || alongOther < -EPSILON || alongOther > 1 + EPSILON) return null;
  return { alongCandidate, alongOther };
}

const nativeCurveSampleCache = new WeakMap<SpatialRoadEdge, SpatialPoint2[] | null>();

function nativeCurveSamples(edge: SpatialRoadEdge): SpatialPoint2[] | null {
  if (nativeCurveSampleCache.has(edge)) return nativeCurveSampleCache.get(edge) ?? null;
  const curve = edge.nativeCurve;
  if (!curve || ![curve.a, curve.b, curve.c, curve.d].every(finitePoint)) {
    nativeCurveSampleCache.set(edge, null);
    return null;
  }
  // Native road geometry is a cubic Bezier. Sample densely enough that crossing
  // checks stay conservative for the short local construction courses planned
  // here, while bounding work for long arterial curves.
  const controlLength = distance(curve.a, curve.b) + distance(curve.b, curve.c) + distance(curve.c, curve.d);
  const count = Math.max(2, Math.min(512, Math.ceil(Math.max(curve.length, controlLength) / 1.5)));
  const points: SpatialPoint2[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const u = 1 - t;
    points.push({
      x: u ** 3 * curve.a.x + 3 * u ** 2 * t * curve.b.x + 3 * u * t ** 2 * curve.c.x + t ** 3 * curve.d.x,
      z: u ** 3 * curve.a.z + 3 * u ** 2 * t * curve.b.z + 3 * u * t ** 2 * curve.c.z + t ** 3 * curve.d.z,
    });
  }
  nativeCurveSampleCache.set(edge, points);
  return points;
}

function segmentIntersectsRoadInterior(
  start: SpatialPoint2,
  end: SpatialPoint2,
  edge: SpatialRoadEdge,
): boolean {
  const points = nativeCurveSamples(edge) ?? [edge.start, edge.end];
  const minX = Math.min(start.x, end.x) - 0.75;
  const maxX = Math.max(start.x, end.x) + 0.75;
  const minZ = Math.min(start.z, end.z) - 0.75;
  const maxZ = Math.max(start.z, end.z) + 0.75;
  let edgeMinX = Number.POSITIVE_INFINITY;
  let edgeMaxX = Number.NEGATIVE_INFINITY;
  let edgeMinZ = Number.POSITIVE_INFINITY;
  let edgeMaxZ = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    edgeMinX = Math.min(edgeMinX, point.x);
    edgeMaxX = Math.max(edgeMaxX, point.x);
    edgeMinZ = Math.min(edgeMinZ, point.z);
    edgeMaxZ = Math.max(edgeMaxZ, point.z);
  }
  if (edgeMaxX < minX || edgeMinX > maxX || edgeMaxZ < minZ || edgeMinZ > maxZ) return false;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const hit = segmentIntersection(start, end, points[index]!, points[index + 1]!);
    if (hit && hit.alongCandidate > EPSILON && hit.alongCandidate < 1 - EPSILON) return true;
  }
  return false;
}

function pointOnSegment(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): { alongCandidate: number } | null {
  const segment = vector(start, end);
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= EPSILON) return null;
  const offset = vector(start, point);
  const alongCandidate = dot(offset, segment) / lengthSquared;
  if (alongCandidate < -EPSILON || alongCandidate > 1 + EPSILON || Math.abs(cross(offset, segment)) > EPSILON) return null;
  return { alongCandidate };
}

function collinearOverlap(start: SpatialPoint2, end: SpatialPoint2, otherStart: SpatialPoint2, otherEnd: SpatialPoint2): boolean {
  const first = vector(start, end);
  if (Math.abs(cross(first, vector(start, otherStart))) > EPSILON || Math.abs(cross(first, vector(start, otherEnd))) > EPSILON) return false;
  const axis = Math.abs(first.x) >= Math.abs(first.z) ? "x" : "z";
  const firstMin = Math.min(start[axis], end[axis]);
  const firstMax = Math.max(start[axis], end[axis]);
  const otherMin = Math.min(otherStart[axis], otherEnd[axis]);
  const otherMax = Math.max(otherStart[axis], otherEnd[axis]);
  return Math.min(firstMax, otherMax) - Math.max(firstMin, otherMin) > EPSILON;
}

interface RoadContactDerivationResult {
  initialTarget: SpatialPoint2;
  target: SpatialPoint2;
  initialLength: number;
  derivation: RoadCandidate["contactDerivation"];
  adjustmentReason: RoadCandidate["adjustmentReason"];
}

function deriveRoadContactTarget(
  siteTarget: SpatialPoint2,
  reservation: RoadResolverScope,
  sourceAnchor: SpatialPoint2,
): RoadContactDerivationResult | { reason: string } {
  if (!finitePoint(siteTarget) || reservation.radius <= 0 || !finitePoint(sourceAnchor)) {
    return { reason: "road_contact_target_unavailable" };
  }
  const direction = vector(sourceAnchor, siteTarget);
  const length = Math.hypot(direction.x, direction.z);
  if (length <= EPSILON) return { reason: "road_contact_target_unavailable" };
  const unit = { x: direction.x / length, z: direction.z / length };
  const initialTarget = {
    x: reservation.center.x - unit.x * reservation.radius,
    z: reservation.center.z - unit.z * reservation.radius,
  };
  const initialLength = distance(initialTarget, sourceAnchor);
  if (!pointInScope(initialTarget, reservation) || initialLength <= EPSILON) {
    return { reason: "road_contact_target_unavailable" };
  }
  if (initialLength > MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS + NET_SEGMENT_LENGTH_NUMERIC_EPSILON_METERS) {
    return { reason: "road_contact_length_exceeds_max" };
  }
  if (initialLength >= MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS) {
    return {
      initialTarget,
      target: initialTarget,
      initialLength,
      derivation: "RESERVATION_NEAR_BOUNDARY",
      adjustmentReason: "NONE",
    };
  }

  // Move only along the source-to-site ray. The point is accepted only when
  // the reservation itself can contain the minimum-length contact.
  const minimumLengthTarget = minimumBridgeDomainEndpoint(sourceAnchor, unit);
  if (!minimumLengthTarget) return { reason: "road_contact_length_interval_too_short" };
  if (!pointInScope(minimumLengthTarget, reservation)) {
    return { reason: "road_contact_length_interval_too_short" };
  }
  return {
    initialTarget,
    target: minimumLengthTarget,
    initialLength,
    derivation: "RESERVATION_MIN_LENGTH_CONTACT",
    adjustmentReason: "MIN_LENGTH_CONSTRAINT",
  };
}

/**
 * Bounded alternatives to one contact: the same derivation approached on rays
 * rotated around the direct one.
 *
 * A corridor step is a real construction in a real city. One refused segment does
 * not mean the direction is wrong — only that this exact line met an overlapping
 * edge, water, a slope or a protected entity. With no neighbours to try, the step
 * dies on its first native rejection and its Goal closes behind it. These are
 * alternatives to the SAME target, and they pass through exactly the same scope,
 * length, geometry and native preview filters as the direct one; nothing is
 * exempted and nothing is loosened.
 *
 * The offsets reach past the few-degrees neighbourhood on purpose, and the widest
 * ones come first. Native does not build a course that runs along a road it already
 * has: it folds that course back into the existing edge, emits no new proposal
 * edge, and the bounded preview reads the result as
 * `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`. Live differential evidence shows whole
 * sectors of the circle behaving this way — one measured source node certified only
 * between 90 and 135 degrees, another only at 180 — so the small laterals are the
 * weakest neighbours to offer: they stay inside whatever corridor the direct ray
 * already sits in and are refused for the same reason. Once the direct contact and
 * its interior inset have been offered, the widest bounded departures are the ones
 * with a chance of leaving that corridor. Every offset still lands on the same
 * reservation boundary and is still filtered and previewed exactly like the direct
 * one.
 */
/**
 * Sources that may contribute to one bounded family.
 *
 * The candidate budget is shared, so an unbounded source list spends it all on
 * direct contacts and leaves no room for any source's alternative headings — the
 * one thing that lets the family survive a corridor that swallows the direct ray.
 */
// Native preview can invalidate every endpoint in one dense local junction
// (for example because an adjacent regenerated segment overlaps a building).
// Keep candidate count bounded while sampling twice as many distinct source
// nodes, so one bad node cluster does not consume the entire preview budget.
const MAXIMUM_BOUNDED_ROAD_SOURCES = 6;

/**
 * The two ways to turn one contact, because which one stays inside the reservation
 * depends on where the source sits relative to it.
 *
 * Deriving against a rotated *site ray* always lands the target exactly on the
 * reservation boundary, which is what keeps a source OUTSIDE the reservation in
 * scope. Turning the *contact itself* about the source instead keeps the direct
 * candidate's length, which is what keeps a source INSIDE the reservation in
 * scope -- the boundary point is then on the far side and the ray derivation
 * leaves the source pointing away from the site. Both are offered; scope,
 * length, geometry and native preview filter them exactly like the direct one.
 */
function deriveLateralRoadContactTargets(
  input: RoadResolverInput,
  sourceAnchor: SpatialPoint2,
  contact: RoadContactDerivationResult,
  degrees: number,
): RoadContactDerivationResult[] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const results: RoadContactDerivationResult[] = [];
  // Along the rotated source→site ray, on the reservation boundary.
  const toCenter = vector(sourceAnchor, input.reservation.center);
  const rotatedSite = {
    x: sourceAnchor.x + toCenter.x * cos - toCenter.z * sin,
    z: sourceAnchor.z + toCenter.x * sin + toCenter.z * cos,
  };
  const derived = deriveRoadContactTarget(rotatedSite, input.reservation, sourceAnchor);
  if ("target" in derived) {
    results.push({ ...derived, derivation: "RESERVATION_LATERAL_CONTACT", adjustmentReason: "LATERAL_OFFSET" });
  }
  // The direct contact turned about the source, keeping its length.
  const offset = vector(sourceAnchor, contact.target);
  const turned = {
    x: sourceAnchor.x + offset.x * cos - offset.z * sin,
    z: sourceAnchor.z + offset.x * sin + offset.z * cos,
  };
  if (pointInScope(turned, input.reservation)) {
    const length = distance(sourceAnchor, turned);
    if (Number.isFinite(length) && length > EPSILON) {
      results.push({
        initialTarget: turned,
        target: turned,
        initialLength: length,
        derivation: "RESERVATION_LATERAL_CONTACT",
        adjustmentReason: "LATERAL_OFFSET",
      });
    }
  }
  return results;
}

function deriveInteriorRoadContactTarget(
  reservation: RoadResolverScope,
  sourceAnchor: SpatialPoint2,
  contact: RoadContactDerivationResult,
): RoadContactDerivationResult | null {
  const centerOffset = vector(contact.target, reservation.center);
  const centerDistance = Math.hypot(centerOffset.x, centerOffset.z);
  const inset = Math.min(
    PRODUCTIVE_RESERVATION_CONTACT_INSET_METERS,
    Math.max(0, centerDistance - MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS),
  );
  if (inset <= EPSILON || centerDistance <= EPSILON) return null;
  const target = {
    x: contact.target.x + (centerOffset.x / centerDistance) * inset,
    z: contact.target.z + (centerOffset.z / centerDistance) * inset,
  };
  if (!pointInScope(target, reservation) || distance(sourceAnchor, target) <= distance(sourceAnchor, contact.target) + EPSILON) return null;
  return {
    ...contact,
    target,
    derivation: "RESERVATION_INTERIOR_CONTACT",
    adjustmentReason: "PRODUCTIVE_CONTACT_INSET",
  };
}

function deriveOutwardContinuationTarget(
  input: RoadResolverInput,
  edge: SpatialRoadEdge,
  role: "start" | "end",
  sourceAnchor: SpatialPoint2,
): RoadContactDerivationResult | { reason: string } {
  const interior = role === "end" ? edge.start : edge.end;
  const direction = vector(interior, sourceAnchor);
  const length = Math.hypot(direction.x, direction.z);
  if (length <= EPSILON) return { reason: "continuation_terminal_tangent_unavailable" };
  const unit = { x: direction.x / length, z: direction.z / length };
  const target = {
    x: sourceAnchor.x + unit.x * PREFERRED_CONTINUATION_LENGTH_METERS,
    z: sourceAnchor.z + unit.z * PREFERRED_CONTINUATION_LENGTH_METERS,
  };
  if (!pointInScope(target, input.reservation) || !pointInScope(sourceAnchor, input.planningEnvelope ?? input.reservation)) {
    return { reason: "continuation_terminal_tangent_outside_scope" };
  }
  return {
    initialTarget: target,
    target,
    initialLength: PREFERRED_CONTINUATION_LENGTH_METERS,
    derivation: "OUTWARD_TERMINAL_TANGENT",
    adjustmentReason: "NONE",
  };
}

function deriveGridContactTargets(
  input: RoadResolverInput,
  sourceAnchor: SpatialPoint2,
  reference: SharedRoadGridReference,
): RoadContactDerivationResult[] {
  const result: RoadContactDerivationResult[] = [];
  const rayToTarget = vector(sourceAnchor, input.siteTarget);
  const baseAngle = reference.orientationRadians;
  for (const angle of [baseAngle, baseAngle + Math.PI / 2]) {
    const axis = { x: Math.cos(angle), z: Math.sin(angle) };
    for (const sign of [-1, 1]) {
      const direction = { x: axis.x * sign, z: axis.z * sign };
      const projection = dot(rayToTarget, direction);
      if (projection <= EPSILON) continue;
      const offset = vector(sourceAnchor, input.reservation.center);
      const along = dot(offset, direction);
      const perpendicularSquared = Math.max(0, dot(offset, offset) - along * along);
      const halfChord = Math.sqrt(Math.max(0, input.reservation.radius ** 2 - perpendicularSquared));
      const t = [along - halfChord, along + halfChord]
        .filter((value) => value > EPSILON)
        .sort((a, b) => Math.abs(a - projection) - Math.abs(b - projection))[0];
      if (t === undefined) continue;
      const target = { x: sourceAnchor.x + direction.x * t, z: sourceAnchor.z + direction.z * t };
      const length = distance(sourceAnchor, target);
      if (length < MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS || length > MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS ||
          !pointInScope(target, input.reservation)) continue;
      result.push({
        initialTarget: target,
        target,
        initialLength: length,
        derivation: "RESERVATION_LATERAL_CONTACT",
        adjustmentReason: "NONE",
      });
    }
  }
  return result;
}

function sourceTopology(
  input: RoadResolverInput,
  edge: SpatialRoadEdge,
  role: "start" | "end",
): { node: SpatialRoadNode; anchor: SpatialPoint2; incidentEdges: SpatialRoadEdge[]; evidence: RoadSourceAnchorEvidence } | { reason: string } {
  if (input.sourceGraphTruncated === true) return { reason: "source_graph_truncated" };
  const nodeRef = role === "start" ? edge.startNode : edge.endNode;
  const node = input.sourceNodes.find((candidate) => entityKey(candidate.entity) === entityKey(nodeRef));
  if (!node) return { reason: "source_node_missing" };
  const certifiedContinuation = input.certifiedContinuationSource &&
    entityKey(input.certifiedContinuationSource.node.entity) === entityKey(node.entity) &&
    entityKey(input.certifiedContinuationSource.edge.entity) === entityKey(edge.entity) &&
    input.certifiedContinuationSource.role === role;
  if ((!node.native && !certifiedContinuation && !catalogueRoadNode(node, input)) || !finitePoint(node.position)) {
    return { reason: "source_node_not_authoritative" };
  }
  const incidentEdges = input.sourceEdges.filter(
    (candidate) => entityKey(candidate.startNode) === entityKey(node.entity) || entityKey(candidate.endNode) === entityKey(node.entity),
  );
  if (incidentEdges.length === 0 || incidentEdges.length !== node.roadDegree) return { reason: "source_incident_topology_incomplete" };
  const anchor = { x: node.position.x, z: node.position.z };
  return {
    node,
    anchor,
    incidentEdges,
    evidence: {
      sourceEdgeRef: edge.entity,
      sourceEndpointRole: role,
      sourceNodeRef: node.entity,
      sourceNodePosition: anchor,
      incidentEdgeRefs: incidentEdges.map((candidate) => candidate.entity),
      roadDegree: node.roadDegree,
      derivation: "AUTHORITATIVE_GRAPH_NODE",
    },
  };
}

function segmentFilter(input: RoadResolverInput, start: SpatialPoint2, end: SpatialPoint2, sourceEdge: SpatialRoadEdge, sourceNode: SpatialRoadNode): string | null {
  const length = distance(start, end);
  if (!pointInScope(end, input.reservation) || !pointInScope(start, input.planningEnvelope ?? input.reservation)) return "outside_connection_scope";
  if (length <= EPSILON) return "zero_length_connection";
  const samples = Math.max(2, Math.ceil(length / 8));
  let previousHeight: number | undefined;
  for (let index = 0; index <= samples; index += 1) {
    const point = lerp(start, end, index / samples);
    if (!pointInsideOwned(point, input.ownedTiles)) return "segment_outside_owned_land";
    if (input.protectedScopes?.some((scope) => segmentIntersectsScope(start, end, scope))) return "protected_scope_collision";
    if (input.buildings?.some((building) => pointInsideBuilding(point, building))) return "building_collision";
    if (input.terrain) {
      const terrainIndexValue = terrainIndex(input.terrain, point);
      if (terrainIndexValue === null || input.terrain.heights[terrainIndexValue] === undefined) return "terrain_unknown";
      if ((input.terrain.waterDepths[terrainIndexValue] ?? 0) > 0.05) return "water_intersection";
      const height = input.terrain.heights[terrainIndexValue];
      if (previousHeight !== undefined && input.maxGradePercent !== undefined) {
        const step = length / samples;
        const grade = step > 0 ? (Math.abs(height - previousHeight) / step) * 100 : 0;
        if (grade > input.maxGradePercent) return "slope_exceeds_bound";
      }
      previousHeight = height;
    }
  }

  if (input.buildings?.some((building) => segmentIntersectsBuilding(start, end, building))) return "building_collision";

  for (const node of input.sourceNodes) {
    if (entityKey(node.entity) === entityKey(sourceNode.entity)) continue;
    const hit = pointOnSegment(node.position, start, end);
    if (hit && hit.alongCandidate > EPSILON && hit.alongCandidate < 1 - EPSILON) return "existing_node_interior_crossing";
  }
  for (const edge of input.sourceEdges) {
    if (segmentIntersectsRoadInterior(start, end, edge)) return "existing_road_interior_intersection";
    const hit = segmentIntersection(start, end, edge.start, edge.end);
    if (collinearOverlap(start, end, edge.start, edge.end)) {
      const isSourceEdge = entityKey(edge.entity) === entityKey(sourceEdge.entity);
      if (!isSourceEdge || hit === null || hit.alongCandidate > EPSILON) return "existing_road_duplicate_corridor";
    }
  }
  if (nearCollinearIncidentCorridor(start, end, sourceNode, input.sourceEdges)) return "near_collinear_incident_corridor";
  return null;
}

export function resolveBoundedRoadCandidates(input: RoadResolverInput): RoadCandidateResolution {
  if (input.reboundSource && input.worldEpoch !== input.reboundSource.runtimeAttachment.worldEpoch) {
    return {
      candidates: [],
      rejectedSources: [{ edge: input.reboundSource.currentEdge, reason: "ROAD_ENDPOINT_REBIND_STALE" }],
    };
  }
  const maxDistance = input.maxSourceDistance ?? 150;
  const allowedSourceNodes = input.allowedSourceNodeRefs
    ? new Set(input.allowedSourceNodeRefs.map(entityKey))
    : null;
  const sourceEdges = input.reboundSource
    ? [input.reboundSource.currentEdge]
    : input.certifiedContinuationSource
      ? [input.certifiedContinuationSource.edge]
      : input.sourceEdges;
  const sources = sourceEdges
    .filter((edge) =>
      (edge.native || catalogueRoadEdge(edge, input.availableRoadPrefabs) ||
        (input.certifiedContinuationSource && entityKey(edge.entity) === entityKey(input.certifiedContinuationSource.edge.entity))) &&
      finitePoint(edge.start) && finitePoint(edge.end))
    .flatMap((edge) =>
      input.reboundSource
        ? [{ edge, role: input.reboundSource.sourceNodeRole }]
        : [
            { edge, role: "start" as const },
            { edge, role: "end" as const },
          ],
    )
    .filter((source) => {
      if (!allowedSourceNodes) return true;
      const nodeRef = source.role === "start" ? source.edge.startNode : source.edge.endNode;
      return allowedSourceNodes.has(entityKey(nodeRef));
    })
    .map((source) => {
      const topology = sourceTopology(input, source.edge, source.role);
      const anchor = "anchor" in topology ? topology.anchor : null;
      return { ...source, topology, distance: anchor ? distance(anchor, input.siteTarget) : Number.POSITIVE_INFINITY };
    })
    .sort((left, right) => left.distance - right.distance || left.edge.entity.index - right.edge.entity.index || left.role.localeCompare(right.role));
  const rejectedSources: RoadCandidateResolution["rejectedSources"] = [];
  const candidates: RoadCandidate[] = [];
  const gridReference = sharedRoadGridReference(input.sourceEdges);
  const eligibleSources: Array<{
    source: (typeof sources)[number] & { topology: Extract<(typeof sources)[number]["topology"], { node: SpatialRoadNode }> };
    contactVariants: Array<{ contact: RoadContactDerivationResult; family: RoadCandidate["family"] }>;
  }> = [];
  const seenNodes = new Set<string>();
  const seenGeometry = new Set<string>();
  for (const source of sources) {
    if (source.distance > maxDistance) continue;
    if (!("node" in source.topology)) {
      rejectedSources.push({ edge: source.edge, reason: source.topology.reason });
      continue;
    }
    const nodeKey = entityKey(source.topology.node.entity);
    if (seenNodes.has(nodeKey)) {
      rejectedSources.push({ edge: source.edge, reason: "duplicate_source_node" });
      continue;
    }
    seenNodes.add(nodeKey);
    if (eligibleSources.length >= MAXIMUM_BOUNDED_ROAD_SOURCES) {
      rejectedSources.push({ edge: source.edge, reason: "bounded_source_budget_exhausted" });
      continue;
    }
    const isCertifiedContinuation = input.certifiedContinuationSource &&
      entityKey(input.certifiedContinuationSource.edge.entity) === entityKey(source.edge.entity) &&
      input.certifiedContinuationSource.role === source.role;
    const contact = isCertifiedContinuation
      ? deriveOutwardContinuationTarget(input, source.edge, source.role, source.topology.anchor)
      : deriveRoadContactTarget(input.siteTarget, input.reservation, source.topology.anchor);
    if (!("target" in contact)) {
      rejectedSources.push({ edge: source.edge, reason: contact.reason });
      continue;
    }
    const sourceAnchor = source.topology.anchor;
    const inset = (value: RoadContactDerivationResult) =>
      deriveInteriorRoadContactTarget(input.reservation, sourceAnchor, value);
    // Rotated headings are offered at BOTH lengths: the boundary contact and the
    // same direction pulled in to the productive inset. Native's certifiable set
    // is a function of heading AND length, so a heading offered at one length is
    // half an alternative — and the half that is missing is the one the
    // measurement says is often the only one that certifies.
    const lateralVariants = WIDEST_CONTACT_OFFSETS_DEGREES
      .flatMap((degrees) => deriveLateralRoadContactTargets(input, sourceAnchor, contact, degrees));
    const freeVariants = [contact, ...(!isCertifiedContinuation
      ? [inset(contact), ...lateralVariants.flatMap((lateral) => [lateral, inset(lateral)])]
          .filter((value): value is RoadContactDerivationResult => value !== null)
      : [])].map((value) => ({ contact: value, family: "FREE_CORRIDOR" as const }));
    const gridVariants = input.roadFamilyPreference === "ORTHOGONAL_GRID" && gridReference
      ? deriveGridContactTargets(input, sourceAnchor, gridReference)
          .map((value) => ({ contact: value, family: "ORTHOGONAL_GRID" as const }))
      : [];
    const contactVariants = [...gridVariants, ...freeVariants];
    eligibleSources.push({ source: { ...source, topology: source.topology }, contactVariants });
  }
  // Round-robin the variants across sources instead of draining one source first.
  // A wider heading family must not cost source diversity: with the whole family
  // taken from the nearest node, every other eligible anchor is crowded out of the
  // bounded list by the first one's rotations.
  const widest = eligibleSources.reduce((maximum, entry) => Math.max(maximum, entry.contactVariants.length), 0);
  for (let round = 0; round < widest && candidates.length < MAXIMUM_BOUNDED_ROAD_CANDIDATES; round += 1) {
    for (const { source, contactVariants } of eligibleSources) {
      const variant = contactVariants[round];
      if (!variant) continue;
      const contactVariant = variant.contact;
      const finalSegmentLength = bridgeDomainNetSegmentLength(source.topology.anchor, contactVariant.target);
      if (
        finalSegmentLength < MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS ||
        finalSegmentLength > MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS
      ) {
        rejectedSources.push({ edge: source.edge, reason: "road_contact_length_out_of_supported_range" });
        continue;
      }
      const reason = segmentFilter(input, source.topology.anchor, contactVariant.target, source.edge, source.topology.node);
      if (reason) {
        rejectedSources.push({ edge: source.edge, reason });
        continue;
      }
      const geometryKey = [
        input.prefab ?? source.edge.prefab,
        source.topology.anchor.x,
        source.topology.anchor.z,
        contactVariant.target.x,
        contactVariant.target.z,
      ].join(":");
      if (seenGeometry.has(geometryKey)) {
        rejectedSources.push({ edge: source.edge, reason: "duplicate_candidate_geometry" });
        continue;
      }
      seenGeometry.add(geometryKey);
      candidates.push({
        family: variant.family,
        gridReference,
        ...(variant.family === "ORTHOGONAL_GRID" && gridReference
          ? { gridAlignmentErrorMeters: gridStationError(contactVariant.target, gridReference) }
          : {}),
        variant: candidates.length === 0 ? "PRIMARY" : "BOUNDED_FALLBACK",
        sourceEdge: source.edge,
        sourceRole: source.role,
        sourceNode: source.topology.node,
        sourceAnchor: source.topology.anchor,
        siteTarget: input.siteTarget,
        initialRoadContactTarget: contactVariant.initialTarget,
        roadContactTarget: contactVariant.target,
        contactDerivation: contactVariant.derivation,
        initialSegmentLength: contactVariant.initialLength,
        finalSegmentLength,
        lengthContract: {
          minMeters: MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
          maxMeters: MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
          pass: true,
        },
        adjustmentReason: contactVariant.adjustmentReason,
        incidentEdgeRefs: source.topology.incidentEdges.map((edge) => edge.entity),
        sourceAnchorEvidence: source.topology.evidence,
        geometryFilterResults: "PASS",
        input: {
          prefab: input.prefab ?? source.edge.prefab,
          x1: source.topology.anchor.x,
          z1: source.topology.anchor.z,
          x2: contactVariant.target.x,
          z2: contactVariant.target.z,
          startEndpoint: {
            ...(input.reboundSource?.runtimeAttachment ?? {
              kind: "EXISTING_NET_NODE",
              role: "START",
              entity: source.topology.node.entity,
              expectedPosition: source.topology.node.position,
              worldEpoch: input.bridgeGeneration ?? "UNVERIFIED",
            }),
          } satisfies RoadEndpointAttachment,
          endEndpoint: {
            kind: "NEW_FREE_ENDPOINT",
            role: "END",
            expectedPosition: { x: contactVariant.target.x, y: source.topology.node.position.y, z: contactVariant.target.z },
            worldEpoch: input.bridgeGeneration ?? "UNVERIFIED",
          } satisfies RoadEndpointAttachment,
        },
      });
      if (candidates.length >= MAXIMUM_BOUNDED_ROAD_CANDIDATES) break;
    }
  }
  const planningCandidates = candidates.map((candidate) => ({
    ...candidate,
    segments: [{
      id: `${candidate.family}:${candidate.sourceNode.entity.index}:${candidate.sourceNode.entity.version}`,
      role: "main" as const,
      start: candidate.sourceAnchor,
      end: candidate.roadContactTarget,
    }],
  }));
  const rankedCandidates = input.roadFamilyPreference === "ORTHOGONAL_GRID"
    ? rankRoadPlanningCandidates(planningCandidates)
    : planningCandidates;
  const preferredSourceNodes = new Set((input.preferredSourceNodeRefs ?? []).map(entityKey));
  const preferred = preferredSourceNodes.size > 0
    ? rankedCandidates.filter((candidate) => preferredSourceNodes.has(entityKey(candidate.sourceNode.entity)))
    : [];
  const fallback = preferredSourceNodes.size > 0
    ? rankedCandidates.filter((candidate) => !preferredSourceNodes.has(entityKey(candidate.sourceNode.entity)))
    : rankedCandidates;
  // Preserve the admitted frontage's best course first, then interleave other
  // bounded source nodes so one rejected junction does not consume the preview
  // budget before a safe neighboring course is considered.
  const orderedCandidates = preferred.length > 0
    ? [preferred[0]!, ...fallback, ...preferred.slice(1)]
    : fallback;
  return {
    candidates: orderedCandidates.map((candidate, index) => ({
      ...candidate,
      variant: index === 0 ? "PRIMARY" : "BOUNDED_FALLBACK",
    })),
    rejectedSources,
  };
}
