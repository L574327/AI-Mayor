import type { SpatialPoint2, SpatialRoadEdge, SpatialRoadNode } from "../spatial/types";

/**
 * THROUGH STREETS BETWEEN NEIGHBOURING DISTRICTS.
 *
 * Each district joins the network by a gateway, so two districts built side by side can stand a short walk apart and
 * still be a long drive apart: the street that would join them runs the other way round the whole network. A player
 * sees that from the camera at once, and so does every citizen and truck. The fix is a single straight street from a
 * JOINT of one district to a joint of the other — a junction on each side, so the new street makes crossroads at both
 * ends — and only a few of them, not one per joint.
 *
 * Everything is read from the world: junctions are nodes where at least three streets meet, a detour is the network
 * distance against the straight distance, and a street that is already there (built by the player or by an earlier
 * cycle) simply makes the detour disappear. Nothing is remembered.
 */
/** One lattice block: a district laid beside another leaves exactly this gap, and one short street across it closes it. */
export const CORRIDOR_MIN_STRAIGHT_METERS = 30;
export const CORRIDOR_MAX_STRAIGHT_METERS = 320;
/** The network route must be at least this many times the straight distance before a street is worth laying. */
export const CORRIDOR_MIN_DETOUR_RATIO = 2.5;
/** Chosen streets keep at least this far from one another, so a shared front gets a few streets, not one per joint. */
export const CORRIDOR_MIN_SPACING_METERS = 200;
export const CORRIDORS_PER_CYCLE = 3;
/** Junction centres within this distance of an axis count as on it: the district lattices line up. */
export const CORRIDOR_AXIS_TOLERANCE_METERS = 2;
/** A street already running between the two points within this distance means they are joined. */
const OVERLAP_METERS = 3;
const BUILDING_CLEARANCE_METERS = 10;

const key = (ref: { index: number; version: number }) => `${ref.index}:${ref.version}`;
const distance = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);

function pointSegmentDistance(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
}

/** Whether two segments cross in their interiors (touching at an end does not count). */
function crossInterior(a1: SpatialPoint2, a2: SpatialPoint2, b1: SpatialPoint2, b2: SpatialPoint2): boolean {
  const cross = (o: SpatialPoint2, p: SpatialPoint2, q: SpatialPoint2) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return d1 * d2 < -1e-6 && d3 * d4 < -1e-6;
}

export interface CorridorCandidate {
  from: SpatialPoint2;
  to: SpatialPoint2;
  straightMeters: number;
  networkMeters: number;
  /** Metres of driving the street saves, the figure the streets are ranked by. */
  savedMeters: number;
}

/** Network distances from one node over the given streets (Dijkstra), cut off beyond `limit` metres. */
function networkDistances(start: string, adjacency: Map<string, Array<{ to: string; meters: number }>>, limit: number): Map<string, number> {
  const best = new Map<string, number>([[start, 0]]);
  const frontier: Array<{ node: string; meters: number }> = [{ node: start, meters: 0 }];
  while (frontier.length > 0) {
    frontier.sort((left, right) => left.meters - right.meters);
    const { node, meters } = frontier.shift()!;
    if (meters > (best.get(node) ?? Infinity) || meters > limit) continue;
    for (const next of adjacency.get(node) ?? []) {
      const total = meters + next.meters;
      if (total < (best.get(next.to) ?? Infinity) && total <= limit) { best.set(next.to, total); frontier.push({ node: next.to, meters: total }); }
    }
  }
  return best;
}

/** A dead end this close to another street node, on the same lattice line, is a gap in the grid, not a street that stops at a lake. */
export const DEAD_END_CLOSE_MAX_METERS = 120;
export const DEAD_END_CLOSURES_PER_CYCLE = 3;

export interface DeadEndClosure {
  /** The dead end. */
  from: SpatialPoint2;
  /** The street node it should meet. */
  to: SpatialPoint2;
  straightMeters: number;
  /** Driving distance between them today (Infinity: not connected by the streets read). */
  networkMeters: number;
}

/**
 * GAPS IN A DISTRICT'S OWN GRID: a street of ours that ends in nothing within reach of another street node on its own lattice line.
 *
 * A grid line the game refused for a moment while the district was being laid (measured live 2026-10-05: the dry run saw the neighbouring streets
 * built a second earlier, as overlap, and the same 40 m line was accepted minutes later) is halved down to one block and given up, and the street
 * beside it is left ending in nothing, a few metres from the node it was meant to reach. Through streets (`corridorCandidates`) look only at JOINTS
 * (three streets or more) on both sides, so a dead end, which has one street, was never a candidate and nothing ever came back to close the gap.
 * Read from the world, nothing remembered: a dead end of one of OUR streets (`isOwn`), the nearest other node on its own axis within
 * `DEAD_END_CLOSE_MAX_METERS`, which the network reaches only by a long way round (or not at all), over a line free of buildings and of streets.
 */
export function deadEndClosures(input: {
  nodes: readonly SpatialRoadNode[];
  edges: readonly SpatialRoadEdge[];
  buildings: readonly SpatialPoint2[];
  isOwn: (edge: SpatialRoadEdge) => boolean;
  limit?: number;
  /** Any heading, not only the lattice line (the player's dead ends are not on our grid): the nearest node the network reaches only the long way round. */
  anyHeading?: boolean;
  /** How far a closing street may run (default `DEAD_END_CLOSE_MAX_METERS`). */
  maximumMeters?: number;
}): DeadEndClosure[] {
  const reach = input.maximumMeters ?? DEAD_END_CLOSE_MAX_METERS;
  const live = input.edges.filter((edge) => !edge.deleted && !edge.temp);
  const position = new Map(input.nodes.map((node) => [key(node.entity), { x: node.position.x, z: node.position.z }]));
  const outside = new Set(input.nodes.filter((node) => node.outsideConnection).map((node) => key(node.entity)));
  const degree = new Map<string, number>();
  const adjacency = new Map<string, Array<{ to: string; meters: number }>>();
  const edgeAt = new Map<string, SpatialRoadEdge>();
  for (const edge of live) {
    const a = key(edge.startNode);
    const b = key(edge.endNode);
    const meters = distance(edge.start, edge.end);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    adjacency.set(a, [...(adjacency.get(a) ?? []), { to: b, meters }]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), { to: a, meters }]);
    edgeAt.set(a, edge);
    edgeAt.set(b, edge);
  }
  const found: DeadEndClosure[] = [];
  for (const [endKey, count] of degree) {
    if (count !== 1 || outside.has(endKey)) continue;
    const edge = edgeAt.get(endKey);
    const from = position.get(endKey);
    if (!edge || !from || !input.isOwn(edge)) continue;
    const distances = networkDistances(endKey, adjacency, reach * CORRIDOR_MIN_DETOUR_RATIO * 4);
    let best: DeadEndClosure | null = null;
    for (const [otherKey, otherCount] of degree) {
      if (otherKey === endKey || otherCount < 2) continue;
      const to = position.get(otherKey);
      if (!to) continue;
      const straight = distance(from, to);
      if (straight < CORRIDOR_MIN_STRAIGHT_METERS * 0.4 || straight > reach) continue;
      // On the same lattice line: the closing street continues the grid and reads as part of it (any heading when asked).
      if (!input.anyHeading && !(Math.abs(from.x - to.x) <= CORRIDOR_AXIS_TOLERANCE_METERS || Math.abs(from.z - to.z) <= CORRIDOR_AXIS_TOLERANCE_METERS)) continue;
      const network = distances.get(otherKey) ?? Infinity;
      if (!(network >= straight * CORRIDOR_MIN_DETOUR_RATIO)) continue;
      if (input.buildings.some((point) => pointSegmentDistance(point, from, to) < BUILDING_CLEARANCE_METERS)) continue;
      let blocked = false;
      for (const other of live) {
        const meetsAtEnd = [from, to].some((point) => distance(other.start, point) < OVERLAP_METERS || distance(other.end, point) < OVERLAP_METERS);
        if (!meetsAtEnd && crossInterior(from, to, other.start, other.end)) { blocked = true; break; }
        if (pointSegmentDistance(other.start, from, to) < OVERLAP_METERS && pointSegmentDistance(other.end, from, to) < OVERLAP_METERS) { blocked = true; break; }
        for (const probe of [{ x: (from.x * 2 + to.x) / 3, z: (from.z * 2 + to.z) / 3 }, { x: (from.x + to.x * 2) / 3, z: (from.z + to.z * 2) / 3 }]) {
          if (pointSegmentDistance(probe, other.start, other.end) < OVERLAP_METERS) { blocked = true; break; }
        }
        if (blocked) break;
      }
      if (blocked) continue;
      if (!best || straight < best.straightMeters) best = { from, to, straightMeters: straight, networkMeters: network };
    }
    if (best) found.push(best);
  }
  found.sort((left, right) => left.straightMeters - right.straightMeters);
  return found.slice(0, input.limit ?? DEAD_END_CLOSURES_PER_CYCLE);
}

/**
 * The straight, axis-aligned streets that would join two joints which are close in a line but far by the network,
 * best first and spaced out. `edges` are the city's streets (highways left out); `nodes` carry their positions.
 */
export function corridorCandidates(input: {
  nodes: readonly SpatialRoadNode[];
  edges: readonly SpatialRoadEdge[];
  buildings: readonly SpatialPoint2[];
  limit?: number;
}): CorridorCandidate[] {
  const live = input.edges.filter((edge) => !edge.deleted && !edge.temp);
  const position = new Map(input.nodes.map((node) => [key(node.entity), { x: node.position.x, z: node.position.z }]));
  const degree = new Map<string, number>();
  const adjacency = new Map<string, Array<{ to: string; meters: number }>>();
  for (const edge of live) {
    const a = key(edge.startNode);
    const b = key(edge.endNode);
    const meters = distance(edge.start, edge.end);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    adjacency.set(a, [...(adjacency.get(a) ?? []), { to: b, meters }]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), { to: a, meters }]);
  }
  // Joints: junctions, where a street crossing here makes crossroads.
  const joints = [...degree].filter(([, count]) => count >= 3).map(([nodeKey]) => ({ nodeKey, point: position.get(nodeKey)! })).filter((joint) => joint.point);
  const found: CorridorCandidate[] = [];
  const seen = new Set<string>();
  for (const a of joints) {
    const distances = networkDistances(a.nodeKey, adjacency, CORRIDOR_MAX_STRAIGHT_METERS * CORRIDOR_MIN_DETOUR_RATIO * 4);
    for (const b of joints) {
      if (a.nodeKey >= b.nodeKey) continue;
      const straight = distance(a.point, b.point);
      if (straight < CORRIDOR_MIN_STRAIGHT_METERS || straight > CORRIDOR_MAX_STRAIGHT_METERS) continue;
      // Axis-aligned, so the new street continues the lattice and reads as part of it.
      const sameX = Math.abs(a.point.x - b.point.x) <= CORRIDOR_AXIS_TOLERANCE_METERS;
      const sameZ = Math.abs(a.point.z - b.point.z) <= CORRIDOR_AXIS_TOLERANCE_METERS;
      if (!sameX && !sameZ) continue;
      const network = distances.get(b.nodeKey) ?? Infinity;
      if (!(network >= straight * CORRIDOR_MIN_DETOUR_RATIO)) continue;
      const pair = `${a.nodeKey}|${b.nodeKey}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      // Free line: no building beside it, no street across it, none already running along it.
      if (input.buildings.some((point) => pointSegmentDistance(point, a.point, b.point) < BUILDING_CLEARANCE_METERS)) continue;
      let blocked = false;
      for (const edge of live) {
        // A street that ends at one of the two joints meets the new street there; it does not cross it. The scan's node and
        // edge-end positions differ by a few centimetres, which read as a crossing and blocked every candidate (measured live).
        const meetsAtJoint = [a.point, b.point].some((joint) => distance(edge.start, joint) < OVERLAP_METERS || distance(edge.end, joint) < OVERLAP_METERS);
        if (!meetsAtJoint && crossInterior(a.point, b.point, edge.start, edge.end)) { blocked = true; break; }
        if (pointSegmentDistance(edge.start, a.point, b.point) < OVERLAP_METERS && pointSegmentDistance(edge.end, a.point, b.point) < OVERLAP_METERS) { blocked = true; break; }
        // A street running through the middle of the line (not at a joint) would be crossed or doubled.
        for (const probe of [{ x: (a.point.x * 2 + b.point.x) / 3, z: (a.point.z * 2 + b.point.z) / 3 }, { x: (a.point.x + b.point.x * 2) / 3, z: (a.point.z + b.point.z * 2) / 3 }]) {
          if (pointSegmentDistance(probe, edge.start, edge.end) < OVERLAP_METERS) { blocked = true; break; }
        }
        if (blocked) break;
      }
      if (blocked) continue;
      found.push({ from: a.point, to: b.point, straightMeters: straight, networkMeters: network, savedMeters: Number.isFinite(network) ? network - straight : 10_000 });
    }
  }
  found.sort((left, right) => right.savedMeters - left.savedMeters || left.straightMeters - right.straightMeters);
  // Sparse: a few streets per shared front, never one per joint.
  const chosen: CorridorCandidate[] = [];
  for (const candidate of found) {
    const middle = { x: (candidate.from.x + candidate.to.x) / 2, z: (candidate.from.z + candidate.to.z) / 2 };
    if (chosen.some((other) => distance(middle, { x: (other.from.x + other.to.x) / 2, z: (other.from.z + other.to.z) / 2 }) < CORRIDOR_MIN_SPACING_METERS)) continue;
    chosen.push(candidate);
    if (chosen.length >= (input.limit ?? CORRIDORS_PER_CYCLE)) break;
  }
  return chosen;
}
