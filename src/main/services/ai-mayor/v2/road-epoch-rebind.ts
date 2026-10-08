import type { SpatialRoadEdge, SpatialEntityRef } from "../spatial/types";

export interface CertifiedRoadActionGeometry {
  prefab: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

const refKey = (ref: SpatialEntityRef) => `${ref.index}:${ref.version}`;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

function projection(point: { x: number; z: number }, start: { x: number; z: number }, dx: number, dz: number, length2: number) {
  return ((point.x - start.x) * dx + (point.z - start.z) * dz) / length2;
}

function lineDistance(point: { x: number; z: number }, start: { x: number; z: number }, dx: number, dz: number, length: number) {
  return Math.abs((point.x - start.x) * dz - (point.z - start.z) * dx) / length;
}

/**
 * Rebinds a certified road effect to current-epoch road edges by exact
 * geometry. The persisted prefab label is descriptive evidence only; road
 * identity is established by the current road graph and unique geometry.
 */
export function rebindCertifiedRoadEffect(input: {
  action: CertifiedRoadActionGeometry;
  currentEdges: SpatialRoadEdge[];
  endpointTolerance?: number;
}): { status: "BOUND" | "STALE" | "AMBIGUOUS"; edges: SpatialRoadEdge[]; reason: string } {
  const { action, currentEdges } = input;
  const start = { x: action.x1, z: action.z1 };
  const end = { x: action.x2, z: action.z2 };
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const total = Math.hypot(dx, dz);
  if (!(total > 0) || !Number.isFinite(total)) return { status: "STALE", edges: [], reason: "certified road geometry is invalid" };
  const tolerance = input.endpointTolerance ?? 1.5;
  // Do not use the historical/display prefab label as an identity gate. A
  // Route B fixture may legitimately have a different current prefab label
  // after reload. `currentEdges` is already the authoritative road-graph
  // eligibility set; the geometry predicates below remain fail-closed.
  const eligible = currentEdges;
  const exact = eligible.filter((edge) =>
    (distance(edge.start, start) <= tolerance && distance(edge.end, end) <= tolerance) ||
    (distance(edge.end, start) <= tolerance && distance(edge.start, end) <= tolerance));
  if (exact.length === 1) return { status: "BOUND", edges: exact, reason: "exact current-epoch road geometry match" };
  if (exact.length > 1) return { status: "AMBIGUOUS", edges: [], reason: "multiple current-epoch edges match exact certified geometry" };

  const pieces = eligible.filter((edge) => {
    const edgeLength = Math.max(edge.length, distance(edge.start, edge.end));
    if (!(edgeLength > 0)) return false;
    const startProjection = projection(edge.start, start, dx, dz, total * total);
    const endProjection = projection(edge.end, start, dx, dz, total * total);
    const lo = Math.min(startProjection, endProjection);
    const hi = Math.max(startProjection, endProjection);
    return hi >= -tolerance / total && lo <= 1 + tolerance / total &&
      lineDistance(edge.start, start, dx, dz, total) <= tolerance &&
      lineDistance(edge.end, start, dx, dz, total) <= tolerance;
  });
  if (pieces.length === 0) return { status: "STALE", edges: [], reason: "no current-epoch road geometry matches certified action" };
  pieces.sort((left, right) => projection(left.start, start, dx, dz, total * total) - projection(right.start, start, dx, dz, total * total));
  const covered = pieces.reduce((max, edge) => Math.max(max,
    projection(edge.start, start, dx, dz, total * total), projection(edge.end, start, dx, dz, total * total)), 0);
  const begins = pieces.some((edge) => Math.min(projection(edge.start, start, dx, dz, total * total), projection(edge.end, start, dx, dz, total * total)) <= tolerance / total);
  if (!begins || covered < 1 - tolerance / total) return { status: "STALE", edges: [], reason: "current road pieces do not cover certified geometry" };
  const unique = [...new Map(pieces.map((edge) => [refKey(edge.entity), edge])).values()];
  return { status: "BOUND", edges: unique, reason: `current-epoch road effect rebound to ${unique.length} edge(s)` };
}
