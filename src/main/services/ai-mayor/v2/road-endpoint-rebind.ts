import type {
  SpatialEntityRef,
  SpatialPoint2,
  SpatialPoint3,
  SpatialRoadEdge,
  SpatialRoadNode,
} from "../spatial/types";
import type { RoadEndpointAttachment } from "./road-kernel";

export const ROAD_ENDPOINT_LOCATOR_SCHEMA_VERSION = "ai-mayor-v2-road-endpoint-locator/1" as const;

export type RoadEndpointRebindFailureCode =
  | "ROAD_ENDPOINT_REBIND_NOT_FOUND"
  | "ROAD_ENDPOINT_REBIND_AMBIGUOUS"
  | "ROAD_ENDPOINT_TOPOLOGY_MISMATCH"
  | "ROAD_ENDPOINT_REBIND_STALE";

/**
 * Serializable identity for one logical ROAD source across ECS world reloads.
 * historicalRuntimeEvidence is diagnostic only and is never an attachment authority.
 */
export interface DurableRoadEndpointLocator {
  schemaVersion: typeof ROAD_ENDPOINT_LOCATOR_SCHEMA_VERSION;
  durableWorldId: string;
  checkpointLineage: string;
  anchor: SpatialPoint3;
  positionToleranceMeters: number;
  roadDegree: number;
  sourceEdge: {
    prefab: string;
    sourceNodeRole: "start" | "end";
    native: true;
  };
  siteContext: {
    siteTarget: SpatialPoint2;
    contactTarget: SpatialPoint2;
    departureHeadingDegrees: number;
  };
  historicalRuntimeEvidence?: {
    worldEpoch: string;
    node: SpatialEntityRef;
    edge: SpatialEntityRef;
  };
}

export interface RoadEndpointRebindWorld {
  durableWorldId: string;
  checkpointLineage: string;
  worldEpoch: string;
  nodes: SpatialRoadNode[];
  edges: SpatialRoadEdge[];
}

export interface RoadEndpointRebindSuccess {
  ok: true;
  candidateCount: 1;
  positionDeltaMeters: number;
  currentNode: SpatialRoadNode;
  currentEdge: SpatialRoadEdge;
  sourceNodeRole: "start" | "end";
  runtimeAttachment: RoadEndpointAttachment & {
    kind: "EXISTING_NET_NODE";
    role: "START";
    entity: SpatialEntityRef;
  };
}

export interface RoadEndpointRebindFailure {
  ok: false;
  code: RoadEndpointRebindFailureCode;
  candidateCount: number;
  reason: string;
}

export type RoadEndpointRebindResult = RoadEndpointRebindSuccess | RoadEndpointRebindFailure;

const entityKey = (entity: SpatialEntityRef): string => `${entity.index}:${entity.version}`;
const distance = (left: SpatialPoint2, right: SpatialPoint2): number => Math.hypot(left.x - right.x, left.z - right.z);

function incidentEdges(world: RoadEndpointRebindWorld, node: SpatialRoadNode): SpatialRoadEdge[] {
  const nodeKey = entityKey(node.entity);
  return world.edges.filter((edge) => entityKey(edge.startNode) === nodeKey || entityKey(edge.endNode) === nodeKey);
}

function roleAtNode(edge: SpatialRoadEdge, node: SpatialRoadNode): "start" | "end" | null {
  const nodeKey = entityKey(node.entity);
  if (entityKey(edge.startNode) === nodeKey) return "start";
  if (entityKey(edge.endNode) === nodeKey) return "end";
  return null;
}

/** Fail-closed rebinding. Coordinates select a bounded set; topology must make the node and edge unique. */
export function rebindDurableRoadEndpoint(
  locator: DurableRoadEndpointLocator,
  world: RoadEndpointRebindWorld,
): RoadEndpointRebindResult {
  if (
    !world.worldEpoch ||
    world.durableWorldId !== locator.durableWorldId ||
    world.checkpointLineage !== locator.checkpointLineage
  ) {
    return {
      ok: false,
      code: "ROAD_ENDPOINT_REBIND_STALE",
      candidateCount: 0,
      reason: "current world/checkpoint lineage does not match the durable endpoint locator",
    };
  }
  if (!Number.isFinite(locator.positionToleranceMeters) || locator.positionToleranceMeters <= 0) {
    return {
      ok: false,
      code: "ROAD_ENDPOINT_REBIND_STALE",
      candidateCount: 0,
      reason: "durable endpoint locator has an invalid position tolerance",
    };
  }

  const positionCandidates = world.nodes.filter(
    (node) => node.native && distance(node.position, locator.anchor) <= locator.positionToleranceMeters,
  );
  if (positionCandidates.length === 0) {
    return {
      ok: false,
      code: "ROAD_ENDPOINT_REBIND_NOT_FOUND",
      candidateCount: 0,
      reason: "no authoritative network node exists inside the locator tolerance",
    };
  }

  const matches = positionCandidates.flatMap((node) => {
    const incident = incidentEdges(world, node);
    if (node.roadDegree !== locator.roadDegree || incident.length !== locator.roadDegree) return [];
    return incident
      .filter(
        (edge) =>
          edge.native === locator.sourceEdge.native &&
          edge.prefab === locator.sourceEdge.prefab &&
          roleAtNode(edge, node) === locator.sourceEdge.sourceNodeRole,
      )
      .map((edge) => ({ node, edge }));
  });

  if (matches.length === 0) {
    return {
      ok: false,
      code: "ROAD_ENDPOINT_TOPOLOGY_MISMATCH",
      candidateCount: positionCandidates.length,
      reason: "position matched but degree/source-edge topology did not",
    };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      code: "ROAD_ENDPOINT_REBIND_AMBIGUOUS",
      candidateCount: matches.length,
      reason: "more than one current node/source-edge pair satisfies the durable locator",
    };
  }

  const [{ node, edge }] = matches;
  return {
    ok: true,
    candidateCount: 1,
    positionDeltaMeters: distance(node.position, locator.anchor),
    currentNode: node,
    currentEdge: edge,
    sourceNodeRole: locator.sourceEdge.sourceNodeRole,
    runtimeAttachment: {
      kind: "EXISTING_NET_NODE",
      role: "START",
      entity: node.entity,
      expectedPosition: node.position,
      worldEpoch: world.worldEpoch,
    },
  };
}
