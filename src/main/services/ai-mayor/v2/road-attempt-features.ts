/**
 * What a street attempt looks like against the streets already there — the geometry that decides whether the game's own
 * validation will take it. Pure and read-only: it describes a candidate, it never decides one. The district builder attaches
 * it to each road attempt's telemetry row so the rejections can be sorted by shape (execution-telemetry.ts).
 *
 * Why these features (the Bridge's recorded contract, 2026-09-28..10-02): a new course that leaves a node along the same RAY
 * as a street already leaving it is folded back onto that street by the game and certified as nothing
 * (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`), whatever its length; one that runs along an existing street, or crosses one, is
 * refused by placement validation. Node geometry comes from the nodes (a scan edge's own end points are trimmed at junctions
 * and differ from the node by centimetres to metres).
 */
import type { SpatialPoint2, SpatialRoadEdge, SpatialRoadNode } from "../spatial/types";

const key = (ref: { index: number; version: number }) => `${ref.index}:${ref.version}`;
const TOUCH_METERS = 3;
/** A point this close to a street lies on it; tighter than a touch, so a street leaving at a right angle does not count as overlapped. */
const OVERLAP_METERS = 1.5;
/** Bearings closer than this are the same ray (the Bridge's fold-back cone is about 1 degree). */
export const SAME_RAY_DEGREES = 2;

export interface Segment { start: SpatialPoint2; end: SpatialPoint2 }

export interface RoadAttemptFeatures {
  axis: "h" | "v" | "d";
  meters: number;
  /** Distance to the nearest street end (node) at each end of the course, and how many streets leave there. */
  startNodeMeters: number | null;
  startDegree: number;
  endNodeMeters: number | null;
  endDegree: number;
  /** Smallest angle (degrees) between the course and a street already leaving the same point along the same ray. */
  startRayDegrees: number | null;
  endRayDegrees: number | null;
  /** Metres of the course that lie on an existing street. */
  overlapMeters: number;
  /** Existing streets the course crosses in their interiors. */
  crossings: number;
  /** The course starts / ends on the inside of an existing street rather than at a node. */
  startOnStreet: boolean;
  endOnStreet: boolean;
}

function pointSegmentDistance(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
}

function crossInterior(a1: SpatialPoint2, a2: SpatialPoint2, b1: SpatialPoint2, b2: SpatialPoint2): boolean {
  const cross = (o: SpatialPoint2, p: SpatialPoint2, q: SpatialPoint2) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  return cross(b1, b2, a1) * cross(b1, b2, a2) < -1e-6 && cross(a1, a2, b1) * cross(a1, a2, b2) < -1e-6;
}

const bearing = (from: SpatialPoint2, to: SpatialPoint2) => (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** The streets of the graph as segments between their nodes' positions, plus the segments laid since the graph was read. */
export function streetSegments(graph: { nodes: readonly SpatialRoadNode[]; edges: readonly SpatialRoadEdge[] }, extra: readonly Segment[] = []): Segment[] {
  const position = new Map(graph.nodes.map((node) => [key(node.entity), { x: node.position.x, z: node.position.z }]));
  const segments: Segment[] = [];
  for (const edge of graph.edges) {
    if (edge.deleted || edge.temp) continue;
    const a = position.get(key(edge.startNode));
    const b = position.get(key(edge.endNode));
    if (a && b) segments.push({ start: a, end: b });
  }
  return [...segments, ...extra];
}

/**
 * One lattice block (40 m) laid straight on from the dead end of a single street, nothing else leaving that point. Measured
 * live (2026-10-04): every such attempt was refused by the game as `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` (4 builds of 4) and its
 * dry run refused it too, submitted forward or reversed (3 of 3); the same street turned 5 degrees was certified. It cannot be
 * halved (it is one block), so submitting it only shows the player an attempt that fails. Longer straight continuations are
 * NOT filtered: they were accepted as often as refused.
 */
export const STRAIGHT_CONTINUATION_PREFILTER_MAX_METERS = 40;
export function isStraightContinuationOfDeadEnd(features: Pick<RoadAttemptFeatures, "startDegree" | "startRayDegrees" | "meters">): boolean {
  return features.startDegree === 1 && features.startRayDegrees !== null && features.startRayDegrees >= 180 - SAME_RAY_DEGREES &&
    features.meters <= STRAIGHT_CONTINUATION_PREFILTER_MAX_METERS;
}

export function roadAttemptFeatures(course: Segment, streets: readonly Segment[]): RoadAttemptFeatures {
  const meters = Math.hypot(course.end.x - course.start.x, course.end.z - course.start.z);
  const dx = Math.abs(course.end.x - course.start.x);
  const dz = Math.abs(course.end.z - course.start.z);
  const axis = meters > 0 && Math.min(dx, dz) / meters < 0.03 ? (dx > dz ? "h" : "v") : "d";
  const atEnd = (point: SpatialPoint2, toward: SpatialPoint2) => {
    let nearest: number | null = null;
    let degree = 0;
    let ray: number | null = null;
    let onStreet = false;
    const heading = bearing(point, toward);
    for (const street of streets) {
      for (const [near, far] of [[street.start, street.end], [street.end, street.start]] as const) {
        const distance = Math.hypot(near.x - point.x, near.z - point.z);
        if (nearest === null || distance < nearest) nearest = distance;
        if (distance < TOUCH_METERS) {
          degree += 1;
          const angle = angleBetween(heading, bearing(point, far));
          if (ray === null || angle < ray) ray = angle;
        }
      }
      if (pointSegmentDistance(point, street.start, street.end) < TOUCH_METERS &&
        Math.hypot(street.start.x - point.x, street.start.z - point.z) >= TOUCH_METERS && Math.hypot(street.end.x - point.x, street.end.z - point.z) >= TOUCH_METERS) onStreet = true;
    }
    return { nearest, degree, ray, onStreet };
  };
  const start = atEnd(course.start, course.end);
  const end = atEnd(course.end, course.start);
  let overlap = 0;
  const steps = Math.max(1, Math.floor(meters / 5));
  for (let step = 0; step < steps; step += 1) {
    const ratio = (step + 0.5) / steps;
    const sample = { x: course.start.x + (course.end.x - course.start.x) * ratio, z: course.start.z + (course.end.z - course.start.z) * ratio };
    if (streets.some((street) => pointSegmentDistance(sample, street.start, street.end) < OVERLAP_METERS)) overlap += meters / steps;
  }
  const touchesEnd = (street: Segment) => [course.start, course.end].some((point) => Math.hypot(street.start.x - point.x, street.start.z - point.z) < TOUCH_METERS ||
    Math.hypot(street.end.x - point.x, street.end.z - point.z) < TOUCH_METERS || pointSegmentDistance(point, street.start, street.end) < TOUCH_METERS);
  const crossings = streets.filter((street) => !touchesEnd(street) && crossInterior(course.start, course.end, street.start, street.end)).length;
  const round = (value: number | null, places = 1) => value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
  return { axis, meters: Math.round(meters), startNodeMeters: round(start.nearest), startDegree: start.degree, endNodeMeters: round(end.nearest), endDegree: end.degree,
    startRayDegrees: round(start.ray), endRayDegrees: round(end.ray), overlapMeters: Math.round(overlap), crossings, startOnStreet: start.onStreet, endOnStreet: end.onStreet };
}
