/**
 * THE WRAP ROAD (绕直角接路, the player's rule of 2026-10-08): a building with no road gets a road that runs round it at right angles, a road's half width
 * plus a margin off each side of its lot, joined to the nearest street. A road that runs past the door is what the game connects a building to, and a
 * road round the building runs past every door it has: a coal plant hangs "No Car Access" at one side and "No Pedestrian Access" at another (live
 * 2026-10-08: 154 + 107 cycles with both notices up while one 18 m road was laid to one of them), and the ring answers both at once.
 *
 * Geometry: the notice stands at the middle of a lot edge, so the way out of the building is `centre -> notice`, and the distance from the centre to that
 * notice is half the lot's depth in that direction. The other half extent is the lot's other side (the prefab's lot size, 8 m cells; whichever of its two
 * sides the measured depth is nearer to is the depth). The ring is the lot's rectangle grown by `clearance` on every side; it is joined at the corner
 * nearest the street. Sides the game refuses (one already lies along a street) are left out, so long as the sides with doors stay joined to the street.
 */
import type { SpatialPoint2 } from "../spatial/types";

/** Road centre off the door line: a Small Road's half width with its footpath plus a margin (live 2026-10-08: at 7 m its footpath overlapped the coal plant). */
export const WRAP_CLEARANCES_METERS: readonly number[] = [10, 14];
/** Tries per building (each try dry-runs every piece first, and lays nothing unless the doors' sides are all accepted). */
export const WRAP_ATTEMPTS_PER_BUILDING = 2;
/** A growable home, shop or factory (EU_ResidentialLow01_L1_2x3): its lot is a zoning cell row, it never gets a ring. */
export const GROWABLE_PREFAB = /_L\d+_\d+x\d+$/;

export interface WrapRing {
  /** The four corners, in order round the building. */
  corners: [SpatialPoint2, SpatialPoint2, SpatialPoint2, SpatialPoint2];
  /** Side i runs corners[i] -> corners[(i + 1) % 4]. */
  clearance: number;
}

/**
 * The way out of the building and how far its door edge is from the centre. Several doors on one edge (live 2026-10-08: a coal plant's four notices all on
 * x = 792.28, 20-27 m off the middle of that edge) give the edge's own line: the way out is square to it. One door: the way to it.
 */
export function doorEdge(centre: SpatialPoint2, doors: readonly SpatialPoint2[]): { u: SpatialPoint2; halfDepth: number } | null {
  let far: [SpatialPoint2, SpatialPoint2] | null = null; let spread = 0;
  for (const a of doors) for (const b of doors) { const d = Math.hypot(a.x - b.x, a.z - b.z); if (d > spread) { spread = d; far = [a, b]; } }
  const first = doors[0];
  if (!first) return null;
  if (far && spread >= 1) {
    const along = { x: (far[1].x - far[0].x) / spread, z: (far[1].z - far[0].z) / spread };
    let u = { x: -along.z, z: along.x };
    const offset = (first.x - centre.x) * u.x + (first.z - centre.z) * u.z;
    if (offset < 0) u = { x: -u.x, z: -u.z };
    return Math.abs(offset) >= 2 ? { u, halfDepth: Math.abs(offset) } : null;
  }
  const out = { x: first.x - centre.x, z: first.z - centre.z };
  const halfDepth = Math.hypot(out.x, out.z);
  return halfDepth >= 2 ? { u: { x: out.x / halfDepth, z: out.z / halfDepth }, halfDepth } : null;
}

export function wrapRing(centre: SpatialPoint2, doors: readonly SpatialPoint2[], lot: { widthMeters: number; depthMeters: number } | null, clearance: number): WrapRing | null {
  const edge = doorEdge(centre, doors);
  if (!edge) return null;
  const { u, halfDepth } = edge;
  const v = { x: -u.z, z: u.x };
  // The lot's side across the way out: whichever lot side the measured depth is NOT (no lot read: as deep as wide).
  const halfAcross = lot
    ? (Math.abs(lot.depthMeters / 2 - halfDepth) <= Math.abs(lot.widthMeters / 2 - halfDepth) ? lot.widthMeters / 2 : lot.depthMeters / 2)
    : halfDepth;
  const a = halfDepth + clearance; const b = halfAcross + clearance;
  const at = (along: number, across: number) => ({ x: centre.x + u.x * along + v.x * across, z: centre.z + u.z * along + v.z * across });
  return { corners: [at(a, b), at(a, -b), at(-a, -b), at(-a, b)], clearance };
}

function distanceToSide(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x; const dz = end.z - start.z; const squared = dx * dx + dz * dz;
  const ratio = squared > 0 ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / squared)) : 0;
  return Math.hypot(point.x - (start.x + dx * ratio), point.z - (start.z + dz * ratio));
}

/** The sides (indices) the doors face: for each notice, the side nearest to it. */
export function doorSides(ring: WrapRing, doors: readonly SpatialPoint2[]): Set<number> {
  const sides = new Set<number>();
  for (const door of doors) {
    let best = 0; let bestDistance = Infinity;
    for (let side = 0; side < 4; side += 1) {
      const distance = distanceToSide(door, ring.corners[side]!, ring.corners[(side + 1) % 4]!);
      if (distance < bestDistance) { bestDistance = distance; best = side; }
    }
    sides.add(best);
  }
  return sides;
}

/** Corner indices by distance to the street contact, nearest first. */
export function cornersNearest(ring: WrapRing, street: SpatialPoint2): number[] {
  return [0, 1, 2, 3].sort((left, right) => Math.hypot(ring.corners[left]!.x - street.x, ring.corners[left]!.z - street.z) - Math.hypot(ring.corners[right]!.x - street.x, ring.corners[right]!.z - street.z));
}

/**
 * The sides to lay from corner `start`, given which sides the game accepts: walking round both ways from the start corner, each way until a refused side
 * (a side beyond a refused one would hang loose). Null when a door's side is not reached that way.
 */
export function wrapSides(start: number, accepted: (side: number) => boolean, doors: ReadonlySet<number>): { forward: number[]; backward: number[] } | null {
  // Forward: side start, start+1, ... (side i runs corner i -> i+1); backward: side start-1, start-2, ... (laid corner i+1 -> i).
  const forward: number[] = [];
  const backward: number[] = [];
  for (let step = 0; step < 4; step += 1) { const side = (start + step) % 4; if (!accepted(side)) break; forward.push(side); }
  for (let step = 1; step < 4; step += 1) { const side = (start - step + 4) % 4; if (forward.includes(side) || !accepted(side)) break; backward.push(side); }
  return [...doors].every((side) => forward.includes(side) || backward.includes(side)) ? { forward, backward } : null;
}

/** The pieces to lay from corner `start`, in order, each starting where the road already is. */
export function wrapPieces(ring: WrapRing, walk: { forward: number[]; backward: number[] }): Array<{ start: SpatialPoint2; end: SpatialPoint2 }> {
  const corner = (index: number) => ring.corners[index % 4]!;
  return [...walk.forward.map((side) => ({ start: corner(side), end: corner(side + 1) })), ...walk.backward.map((side) => ({ start: corner(side + 1), end: corner(side) }))];
}
