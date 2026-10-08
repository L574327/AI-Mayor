export interface NetworkLinkCourseRoad {
  prefab: string;
  entity?: { index: number; version: number } | null;
  start: { x: number; z: number };
  end: { x: number; z: number };
  [key: string]: unknown;
}

export type NetworkLinkCourseEffect =
  | { status: "MATCH"; edges: readonly NetworkLinkCourseRoad[]; start: { x: number; z: number }; end: { x: number; z: number } }
  | { status: "MISSING" | "AMBIGUOUS" | "MALFORMED"; edges: readonly NetworkLinkCourseRoad[]; reason: string };

const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Match one exact straight native course, whether the world lists it as one edge or a contiguous chain. */
export function matchNetworkLinkCourseEffect(input: {
  roads: readonly NetworkLinkCourseRoad[];
  prefab: string;
  start: { x: number; z: number };
  end: { x: number; z: number };
  tolerance?: number;
}): NetworkLinkCourseEffect {
  const tolerance = input.tolerance ?? 0.25;
  const start = input.start; const end = input.end;
  const length = distance(start, end);
  if (!input.prefab || !Number.isFinite(length) || length <= tolerance || !Number.isFinite(tolerance) || tolerance <= 0 ||
    ![start.x, start.z, end.x, end.z].every(Number.isFinite)) {
    return { status: "MALFORMED", edges: [], reason: "COURSE_GEOMETRY_INVALID" };
  }
  const dx = end.x - start.x; const dz = end.z - start.z; const length2 = dx * dx + dz * dz;
  const along = (p: { x: number; z: number }) => ((p.x - start.x) * dx + (p.z - start.z) * dz) / length2;
  const crossTrack = (p: { x: number; z: number }) => Math.abs((p.x - start.x) * dz - (p.z - start.z) * dx) / length;
  const candidates = input.roads.filter((road) => {
    if (road.prefab !== input.prefab || !road.entity || !Number.isInteger(road.entity.index) || !Number.isInteger(road.entity.version)) return false;
    const a = road.start; const b = road.end;
    if (![a?.x, a?.z, b?.x, b?.z].every(Number.isFinite)) return false;
    const ta = along(a); const tb = along(b);
    return crossTrack(a) <= tolerance && crossTrack(b) <= tolerance &&
      Math.min(ta, tb) >= -tolerance / length && Math.max(ta, tb) <= 1 + tolerance / length;
  });
  if (candidates.length === 0) return { status: "MISSING", edges: [], reason: "REALIZED_COURSE_EDGES_NOT_FOUND" };

  let cursor = start;
  const matched: NetworkLinkCourseRoad[] = [];
  const used = new Set<NetworkLinkCourseRoad>();
  for (let step = 0; step <= candidates.length; step += 1) {
    if (distance(cursor, end) <= tolerance) {
      return { status: "MATCH", edges: matched, start, end };
    }
    const next = candidates.flatMap((road) => {
      if (used.has(road)) return [];
      const a = road.start; const b = road.end; const ta = along(a); const tb = along(b);
      const moves = [];
      if (distance(a, cursor) <= tolerance && tb > ta + tolerance / length / 10) moves.push({ road, from: a, to: b });
      if (distance(b, cursor) <= tolerance && ta > tb + tolerance / length / 10) moves.push({ road, from: b, to: a });
      return moves;
    });
    if (next.length === 0) return { status: "MISSING", edges: matched, reason: matched.length ? "REALIZED_COURSE_CHAIN_GAP" : "REALIZED_COURSE_START_NOT_BOUND" };
    if (next.length > 1) return { status: "AMBIGUOUS", edges: matched, reason: "REALIZED_COURSE_CHAIN_NOT_UNIQUE" };
    const chosen = next[0];
    used.add(chosen.road); matched.push(chosen.road); cursor = chosen.to;
  }
  return { status: "MISSING", edges: matched, reason: "REALIZED_COURSE_CHAIN_DID_NOT_REACH_ENDPOINT" };
}
