import type {
  SpatialBootstrapScan,
  SpatialConnectionCandidate,
  SpatialEntityRef,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialScanPort,
  SpatialTile,
  SpatialWorldModel,
} from "./types";

function entityKey(entity: SpatialEntityRef): string {
  return `${entity.index}:${entity.version}`;
}

function isFinitePoint(point: SpatialPoint2): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.z);
}

function pointInPolygon(point: SpatialPoint2, polygon: SpatialPoint2[]): boolean {
  let inside = false;
  for (let i = 0, previous = polygon.length - 1; i < polygon.length; previous = i++) {
    const currentPoint = polygon[i];
    const previousPoint = polygon[previous];
    const crosses =
      currentPoint.z > point.z !== previousPoint.z > point.z &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.z - currentPoint.z)) / (previousPoint.z - currentPoint.z) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInTile(point: SpatialPoint2, tile: SpatialTile): boolean {
  if (tile.polygon.length >= 3) return pointInPolygon(point, tile.polygon);
  if (!tile.bounds) return false;
  return (
    point.x >= tile.bounds.min.x &&
    point.x <= tile.bounds.max.x &&
    point.z >= tile.bounds.min.z &&
    point.z <= tile.bounds.max.z
  );
}

function pointInOwnedArea(point: SpatialPoint2, ownedTiles: SpatialTile[]): boolean {
  return ownedTiles.some((tile) => pointInTile(point, tile));
}

interface RoadStep {
  edge: SpatialRoadEdge;
  fromKey: string;
}

interface RankedIngressCandidate {
  candidate: SpatialConnectionCandidate;
  regularRoadRank: number;
  ownedFootprintSamples: number;
}

function discoverIngressCandidates(
  scan: SpatialBootstrapScan,
  ownedTiles: SpatialTile[],
  degreeByNode: ReadonlyMap<string, number>,
): SpatialConnectionCandidate[] {
  const nodeByKey = new Map(scan.roadGraph.nodes.map((node) => [entityKey(node.entity), node]));
  const edgesByNode = new Map<string, SpatialRoadEdge[]>();
  for (const edge of scan.roadGraph.edges) {
    if (!edge.native) continue;
    for (const key of [entityKey(edge.startNode), entityKey(edge.endNode)]) {
      const existing = edgesByNode.get(key) ?? [];
      existing.push(edge);
      edgesByNode.set(key, existing);
    }
  }

  const distances = new Map<string, number>();
  const predecessor = new Map<string, RoadStep>();
  const sourceKeys = new Set([
    ...scan.outsideConnections.map((connection) => entityKey(connection.entity)),
    ...scan.roadGraph.nodes.filter((node) => node.outsideConnection).map((node) => entityKey(node.entity)),
  ]);
  for (const key of sourceKeys) {
    if (nodeByKey.has(key)) distances.set(key, 0);
  }

  const visited = new Set<string>();
  while (true) {
    let currentKey: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const [key, distance] of distances) {
      if (
        !visited.has(key) &&
        (distance < currentDistance || (distance === currentDistance && key < (currentKey ?? key)))
      ) {
        currentKey = key;
        currentDistance = distance;
      }
    }
    if (!currentKey) break;
    visited.add(currentKey);
    for (const edge of edgesByNode.get(currentKey) ?? []) {
      const startKey = entityKey(edge.startNode);
      const endKey = entityKey(edge.endNode);
      const nextKey = startKey === currentKey ? endKey : startKey;
      if (!nodeByKey.has(nextKey)) continue;
      const nextDistance = currentDistance + edge.length;
      const knownDistance = distances.get(nextKey);
      const knownStep = predecessor.get(nextKey);
      if (
        knownDistance === undefined ||
        nextDistance < knownDistance - 0.001 ||
        (Math.abs(nextDistance - knownDistance) <= 0.001 &&
          edge.entity.index < (knownStep?.edge.entity.index ?? Infinity))
      ) {
        distances.set(nextKey, nextDistance);
        predecessor.set(nextKey, { edge, fromKey: currentKey });
      }
    }
  }

  const terminals: SpatialConnectionCandidate[] = [];
  const terminalKeys = new Set<string>();
  for (const node of scan.roadGraph.nodes) {
    const key = entityKey(node.entity);
    if (
      !node.native ||
      (degreeByNode.get(key) ?? node.roadDegree) !== 1 ||
      !pointInOwnedArea(node.position, ownedTiles)
    ) {
      continue;
    }
    const incomingEdge = edgesByNode.get(key)?.[0];
    if (!incomingEdge) continue;
    terminalKeys.add(key);
    terminals.push({
      node,
      reason: "native_terminal_in_owned_area",
      incomingEdge: incomingEdge.entity,
      graphDistanceFromOutside: distances.get(key),
    });
  }
  terminals.sort(
    (a, b) =>
      (a.graphDistanceFromOutside ?? Infinity) - (b.graphDistanceFromOutside ?? Infinity) ||
      a.node.entity.index - b.node.entity.index,
  );

  const gateways: RankedIngressCandidate[] = [];
  for (const node of scan.roadGraph.nodes) {
    const key = entityKey(node.entity);
    const step = predecessor.get(key);
    const graphDistance = distances.get(key);
    if (
      !node.native ||
      terminalKeys.has(key) ||
      !pointInOwnedArea(node.position, ownedTiles) ||
      graphDistance === undefined ||
      !step
    ) {
      continue;
    }
    const fromNode = nodeByKey.get(step.fromKey);
    if (!fromNode) continue;
    const dx = node.position.x - fromNode.position.x;
    const dz = node.position.z - fromNode.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) continue;
    const tangent = { x: dx / length, z: dz / length };
    const orientations = [
      { x: -tangent.z, z: tangent.x },
      { x: tangent.z, z: -tangent.x },
    ];
    const incidentEdges = edgesByNode.get(key) ?? [];
    const regularRoadRank = incidentEdges.some((edge) => !edge.prefab.toLowerCase().includes("highway")) ? 0 : 1;
    for (const [orientationRank, forward] of orientations.entries()) {
      const right = { x: forward.z, z: -forward.x };
      const footprintPoints = [
        { x: node.position.x + forward.x * 32, z: node.position.z + forward.z * 32 },
        { x: node.position.x + forward.x * 80 + right.x * 80, z: node.position.z + forward.z * 80 + right.z * 80 },
        { x: node.position.x + forward.x * 80 - right.x * 80, z: node.position.z + forward.z * 80 - right.z * 80 },
        { x: node.position.x + forward.x * 176 + right.x * 80, z: node.position.z + forward.z * 176 + right.z * 80 },
        { x: node.position.x + forward.x * 176 - right.x * 80, z: node.position.z + forward.z * 176 - right.z * 80 },
        { x: node.position.x + forward.x * 240, z: node.position.z + forward.z * 240 },
      ];
      gateways.push({
        candidate: {
          node,
          reason: "ingress_gateway_in_owned_area",
          incomingEdge: step.edge.entity,
          forward,
          graphDistanceFromOutside: graphDistance,
          orientationRank,
        },
        regularRoadRank,
        ownedFootprintSamples: footprintPoints.filter((point) => pointInOwnedArea(point, ownedTiles)).length,
      });
    }
  }
  gateways.sort(
    (a, b) =>
      a.regularRoadRank - b.regularRoadRank ||
      b.ownedFootprintSamples - a.ownedFootprintSamples ||
      (a.candidate.graphDistanceFromOutside ?? Infinity) - (b.candidate.graphDistanceFromOutside ?? Infinity) ||
      a.candidate.node.entity.index - b.candidate.node.entity.index ||
      (a.candidate.orientationRank ?? 0) - (b.candidate.orientationRank ?? 0),
  );
  return [...terminals, ...gateways.map((item) => item.candidate)];
}

export function parseSpatialBootstrapScan(value: unknown): SpatialBootstrapScan {
  if (!value || typeof value !== "object") throw new Error("spatial scan response must be an object");
  const scan = value as Partial<SpatialBootstrapScan>;
  if (!scan.world || !Number.isFinite(scan.world.min) || !Number.isFinite(scan.world.max)) {
    throw new Error("spatial scan is missing finite world bounds");
  }
  if (!Array.isArray(scan.tiles) || !Array.isArray(scan.outsideConnections)) {
    throw new Error("spatial scan is missing tile or outside-connection arrays");
  }
  if (!Array.isArray(scan.bootstrapAssets)) throw new Error("spatial scan is missing bootstrap asset metadata");
  if (!scan.roadGraph || !Array.isArray(scan.roadGraph.nodes) || !Array.isArray(scan.roadGraph.edges)) {
    throw new Error("spatial scan is missing a road graph");
  }
  if (scan.roadGraph.truncated) {
    throw new Error("spatial road graph was truncated; retry with a larger roadLimit");
  }
  for (const node of scan.roadGraph.nodes) {
    if (!node.entity || !isFinitePoint(node.position)) throw new Error("spatial scan contains an invalid road node");
  }
  return scan as SpatialBootstrapScan;
}

export function buildSpatialWorldModel(scan: SpatialBootstrapScan): SpatialWorldModel {
  const ownedTiles = scan.tiles.filter((tile) => tile.owned);
  if (ownedTiles.length === 0) throw new Error("spatial scan reported no owned tiles");

  const degreeByNode = new Map<string, number>();
  for (const edge of scan.roadGraph.edges) {
    const start = entityKey(edge.startNode);
    const end = entityKey(edge.endNode);
    degreeByNode.set(start, (degreeByNode.get(start) ?? 0) + 1);
    degreeByNode.set(end, (degreeByNode.get(end) ?? 0) + 1);
  }

  const connectionCandidates = discoverIngressCandidates(scan, ownedTiles, degreeByNode);

  return {
    worldBounds: scan.world,
    ownedTiles,
    roadGraph: scan.roadGraph,
    outsideConnections: scan.outsideConnections,
    connectionCandidates,
  };
}

export async function scanSpatialWorld(port: SpatialScanPort): Promise<SpatialWorldModel> {
  return buildSpatialWorldModel(parseSpatialBootstrapScan(await port.scan()));
}
