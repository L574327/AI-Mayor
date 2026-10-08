import type {
  PlannedRoadSegment,
  SpatialConnectionCandidate,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialWorldModel,
  StarterRoadLayout,
} from "./types";

function sameEntity(a: { index: number; version: number }, b: { index: number; version: number }): boolean {
  return a.index === b.index && a.version === b.version;
}

function add(origin: SpatialPoint2, direction: SpatialPoint2, distance: number): SpatialPoint2 {
  return { x: origin.x + direction.x * distance, z: origin.z + direction.z * distance };
}

function incomingEdgeFor(model: SpatialWorldModel, connection: SpatialConnectionCandidate): SpatialRoadEdge {
  const requestedEdge = connection.incomingEdge;
  if (requestedEdge) {
    const explicit = model.roadGraph.edges.find((item) => sameEntity(item.entity, requestedEdge));
    if (!explicit) throw new Error("connection candidate incoming edge is missing from the road graph");
    return explicit;
  }
  const edge = model.roadGraph.edges.find(
    (item) => sameEntity(item.startNode, connection.node.entity) || sameEntity(item.endNode, connection.node.entity),
  );
  if (!edge) throw new Error("connection candidate has no incoming road edge");
  return edge;
}

export function planStarterGrid(model: SpatialWorldModel, connection: SpatialConnectionCandidate): StarterRoadLayout {
  const incomingEdge = incomingEdgeFor(model, connection);
  const entry = { x: connection.node.position.x, z: connection.node.position.z };
  let forward = connection.forward;
  if (!forward) {
    const nodeAtStart = sameEntity(incomingEdge.startNode, connection.node.entity);
    const innerPoint = nodeAtStart ? incomingEdge.end : incomingEdge.start;
    const dx = entry.x - innerPoint.x;
    const dz = entry.z - innerPoint.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) throw new Error("incoming road tangent is degenerate");
    forward = { x: dx / length, z: dz / length };
  }
  const forwardLength = Math.hypot(forward.x, forward.z);
  if (forwardLength < 0.001) throw new Error("connection candidate forward direction is degenerate");
  forward = { x: forward.x / forwardLength, z: forward.z / forwardLength };
  const right = { x: forward.z, z: -forward.x };

  const firstStation = 80;
  const secondStation = 176;
  const halfWidth = 80;
  const mainEnd = add(entry, forward, 240);
  const firstCenter = add(entry, forward, firstStation);
  const secondCenter = add(entry, forward, secondStation);
  const firstLeft = add(firstCenter, right, -halfWidth);
  const firstRight = add(firstCenter, right, halfWidth);
  const secondLeft = add(secondCenter, right, -halfWidth);
  const secondRight = add(secondCenter, right, halfWidth);
  const segments: PlannedRoadSegment[] = [
    { id: "main", role: "main", start: entry, end: mainEnd },
    { id: "cross-1-left", role: "cross", start: firstCenter, end: firstLeft },
    { id: "cross-1-right", role: "cross", start: firstCenter, end: firstRight },
    { id: "cross-2-left", role: "cross", start: secondCenter, end: secondLeft },
    { id: "cross-2-right", role: "cross", start: secondCenter, end: secondRight },
    { id: "side-left", role: "side", start: firstLeft, end: secondLeft },
    { id: "side-right", role: "side", start: firstRight, end: secondRight },
  ];

  return {
    style: "starter_grid",
    entryNode: connection.node.entity,
    incomingEdge: incomingEdge.entity,
    forward,
    right,
    segments,
    futureExpansionPoint: mainEnd,
  };
}
