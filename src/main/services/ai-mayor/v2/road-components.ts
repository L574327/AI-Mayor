import type { SpatialPoint2, SpatialRoadEdge, SpatialRoadNode, SpatialWorldModel } from "../spatial/types";

/**
 * Connected road components, and the rule that new streets grow out of a CONNECTED network.
 *
 * Two streets that share no node are two components: services (water, power, sewage) travel along connected
 * streets, so a street that does not join the network serves nothing. Measured live (2026-10-03): the frontier and
 * access-course paths took their start from the nearest node of ANY component, including 1-2 street stubs, and left
 * three disconnected 120-160 m orphans (no facilities, nothing built beside them).
 *
 * A "served" component is one big enough to be a district rather than a stub; only those are sources for new
 * streets. Components below the floor are orphans: invisible as sources, and targets to be re-joined.
 */
export const SERVED_COMPONENT_MIN_STREETS = 20;

const key = (ref: { index: number; version: number }) => `${ref.index}:${ref.version}`;

export interface RoadComponent {
  id: string;
  streets: number;
  nodes: SpatialRoadNode[];
  edges: SpatialRoadEdge[];
}

export function roadComponents(roadGraph: { nodes: readonly SpatialRoadNode[]; edges: readonly SpatialRoadEdge[] }): RoadComponent[] {
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    let root = value;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const live = roadGraph.edges.filter((edge) => !edge.deleted && !edge.temp);
  for (const edge of live) {
    for (const ref of [edge.startNode, edge.endNode]) if (!parent.has(key(ref))) parent.set(key(ref), key(ref));
    const a = find(key(edge.startNode));
    const b = find(key(edge.endNode));
    if (a !== b) parent.set(a, b);
  }
  const nodeByKey = new Map(roadGraph.nodes.map((node) => [key(node.entity), node]));
  const components = new Map<string, RoadComponent>();
  for (const edge of live) {
    const id = find(key(edge.startNode));
    const component = components.get(id) ?? { id, streets: 0, nodes: [], edges: [] };
    component.streets += 1;
    component.edges.push(edge);
    components.set(id, component);
  }
  for (const [nodeKey, node] of nodeByKey) {
    if (!parent.has(nodeKey)) continue;
    components.get(find(nodeKey))?.nodes.push(node);
  }
  return [...components.values()].sort((left, right) => right.streets - left.streets || left.id.localeCompare(right.id));
}

export function servedComponents(roadGraph: Parameters<typeof roadComponents>[0], minimumStreets = SERVED_COMPONENT_MIN_STREETS): RoadComponent[] {
  return roadComponents(roadGraph).filter((component) => component.streets >= minimumStreets);
}

export function orphanComponents(roadGraph: Parameters<typeof roadComponents>[0], minimumStreets = SERVED_COMPONENT_MIN_STREETS): RoadComponent[] {
  return roadComponents(roadGraph).filter((component) => component.streets < minimumStreets);
}

/**
 * The world as new-street planning should see it: only streets of served components. An orphan stub is not a
 * place a street may start from, so it is removed from the graph the anchors, access nodes and corridors read.
 * With no served component at all (a brand-new city) the world is returned unchanged.
 */
export function withoutOrphanComponents<W extends Pick<SpatialWorldModel, "roadGraph">>(world: W, minimumStreets = SERVED_COMPONENT_MIN_STREETS): W {
  const served = servedComponents(world.roadGraph, minimumStreets);
  if (served.length === 0) return world;
  const keepEdges = new Set(served.flatMap((component) => component.edges));
  const keepNodes = new Set(served.flatMap((component) => component.nodes.map((node) => key(node.entity))));
  if (keepEdges.size === world.roadGraph.edges.filter((edge) => !edge.deleted && !edge.temp).length) return world;
  return {
    ...world,
    roadGraph: {
      ...world.roadGraph,
      nodes: world.roadGraph.nodes.filter((node) => keepNodes.has(key(node.entity))),
      edges: world.roadGraph.edges.filter((edge) => keepEdges.has(edge) || edge.deleted || edge.temp),
    },
  };
}

/** For each orphan component: its node nearest any served node, and that served node — the gap a re-join must close. */
export function orphanReconnections(roadGraph: Parameters<typeof roadComponents>[0], minimumStreets = SERVED_COMPONENT_MIN_STREETS): Array<{
  orphan: RoadComponent; from: SpatialPoint2; to: SpatialPoint2; distanceMeters: number;
}> {
  const served = servedComponents(roadGraph, minimumStreets).flatMap((component) => component.nodes);
  if (served.length === 0) return [];
  return orphanComponents(roadGraph, minimumStreets).flatMap((orphan) => {
    let best: { from: SpatialPoint2; to: SpatialPoint2; distanceMeters: number } | null = null;
    for (const node of orphan.nodes) {
      for (const target of served) {
        const distanceMeters = Math.hypot(node.position.x - target.position.x, node.position.z - target.position.z);
        if (!best || distanceMeters < best.distanceMeters) {
          best = { from: { x: target.position.x, z: target.position.z }, to: { x: node.position.x, z: node.position.z }, distanceMeters };
        }
      }
    }
    return best ? [{ orphan, ...best }] : [];
  }).sort((left, right) => left.distanceMeters - right.distanceMeters);
}
