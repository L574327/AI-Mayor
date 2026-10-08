import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB } from "../spatial/types";
import type { MayorAction } from "../types";
import type { SpatialEntityRef } from "../spatial/types";

export type UtilityTruth = true | false | "UNKNOWN";
export type PrimitiveDecision = "OBSERVED_MATCH" | "PROVEN_MISMATCH" | "UNKNOWN";
type CableAction = Extract<MayorAction, { type: "build_road" }>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const refKey = (value: unknown): string | null => {
  const ref = record(value);
  return Number.isInteger(Number(ref.index)) && Number.isInteger(Number(ref.version))
    ? `${Number(ref.index)}:${Number(ref.version)}` : null;
};

const pointDistance = (value: unknown, x: number, z: number): number => {
  const point = record(value);
  return Math.hypot(Number(point.x) - x, Number(point.z) - z);
};

export interface CablePrimitiveMatch {
  decision: PrimitiveDecision;
  reason: string;
  evidence: {
    edgeIds: string[];
    matchedEdgeIds: string[];
    matchedNodeIds: string[];
    bindingStatus: string;
    bindingReason?: string;
    complete: boolean;
    truncated: boolean;
  };
}

/**
 * Reconciles only the permanent physical cable effect. It intentionally does
 * not inspect orphan/network/reachability/objective fields.
 */
export function matchCablePrimitiveEffect(input: {
  topology: unknown;
  action: CableAction;
  connector: SpatialEntityRef;
  targetNode?: SpatialEntityRef;
  tolerance?: number;
}): CablePrimitiveMatch {
  const topology = record(input.topology);
  const binding = record(topology.binding);
  const bindingStatus = typeof binding.bindingStatus === "string" ? binding.bindingStatus : "UNKNOWN";
  const complete = binding.complete === true;
  const truncated = binding.truncated === true;
  const scan = record(topology.candidateScan);
  const rawEdges = Array.isArray(scan.edges) ? scan.edges.map(record) : null;
  const edgeIds = rawEdges?.map((edge) => refKey(edge.entity)).filter((value): value is string => value !== null) ?? [];
  const evidence = {
    edgeIds,
    matchedEdgeIds: [] as string[],
    matchedNodeIds: [] as string[],
    bindingStatus,
    bindingReason: bindingStatus === "VALID" ? "validated world, generation, target, and connector bindings" : undefined,
    complete,
    truncated,
  };
  if (input.action.type !== "build_road" || input.action.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) {
    return { decision: "UNKNOWN", reason: "unsupported utility cable action", evidence };
  }
  if (bindingStatus !== "VALID" || !complete || truncated || !rawEdges || scan.complete !== true || scan.truncated === true) {
    return { decision: "UNKNOWN", reason: "utility topology evidence is stale, incomplete, truncated, or unbound", evidence };
  }
  const connectorKey = refKey(input.connector);
  if (!connectorKey) return { decision: "UNKNOWN", reason: "connector identity is missing", evidence };
  const targetNodeKey = input.targetNode ? refKey(input.targetNode) : null;
  if (input.targetNode && !targetNodeKey) return { decision: "UNKNOWN", reason: "authoritative target node identity is invalid", evidence };
  const connector = record(topology.connector);
  const physicalEdges = Array.isArray(connector.physicalEdges)
    ? connector.physicalEdges.map(record) : null;
  if (!physicalEdges) return { decision: "UNKNOWN", reason: "connector physical-edge relation is missing", evidence };
  const tolerance = input.tolerance ?? 1.5;
  const edgeNodes = (edge: Record<string, unknown>) => {
    const start = refKey(edge.startNode);
    const end = refKey(edge.endNode);
    return start && end ? { start, end } : null;
  };
  const point = (value: unknown): { x: number; z: number } | null => {
    const candidate = record(value);
    return Number.isFinite(Number(candidate.x)) && Number.isFinite(Number(candidate.z))
      ? { x: Number(candidate.x), z: Number(candidate.z) } : null;
  };
  const distance = (value: unknown, x: number, z: number) => {
    const p = point(value);
    return p ? Math.hypot(p.x - x, p.z - z) : Number.POSITIVE_INFINITY;
  };
  const orientPoint = (edge: Record<string, unknown>, side: "start" | "end", reverse: boolean) =>
    point(edge[reverse ? side === "start" ? "end" : "start" : side]);
  const eligible = rawEdges.filter((edge) =>
    edge.permanent === true && edge.temp !== true && edge.deleted !== true &&
    (edge.prefab === input.action.prefab || edge.prefab === "Low-voltage Ground Cable") &&
    point(edge.start) !== null && point(edge.end) !== null,
  );
  const physicalById = new Map(physicalEdges.map((edge) => [refKey(edge.entity), edge] as const));
  const physicalIds = new Set([...physicalById.keys()].filter((value): value is string => value !== null));
  const seeds = eligible.filter((edge) => {
    const id = refKey(edge.entity);
    const physical = id ? physicalById.get(id) : undefined;
    return id !== null && physicalIds.has(id) && refKey(physical?.incidentNode ?? edge.incidentNode) === connectorKey &&
      (distance(edge.start, input.action.x1, input.action.z1) <= tolerance || distance(edge.end, input.action.x1, input.action.z1) <= tolerance);
  });
  if (seeds.length === 0) return { decision: "PROVEN_MISMATCH", reason: "complete bounded cable scan proves no connector-seeded cable chain", evidence };
  const directMatches = seeds.filter((edge) => {
    const nodes = edgeNodes(edge);
    const forwardStart = distance(edge.start, input.action.x1, input.action.z1) <= tolerance;
    const reverseStart = distance(edge.end, input.action.x1, input.action.z1) <= tolerance;
    return targetNodeKey
      ? !!nodes && ((forwardStart && nodes.end === targetNodeKey) || (reverseStart && nodes.start === targetNodeKey))
      : (forwardStart && distance(edge.end, input.action.x2, input.action.z2) <= tolerance) ||
        (reverseStart && distance(edge.start, input.action.x2, input.action.z2) <= tolerance);
  });
  if (directMatches.length > 1) return { decision: "UNKNOWN", reason: "multiple exact permanent cable edges match the command geometry", evidence };
  if (directMatches.length === 1 && edgeNodes(directMatches[0]) === null) {
    const id = refKey(directMatches[0].entity);
    if (id) evidence.matchedEdgeIds = [id];
    return { decision: "OBSERVED_MATCH", reason: "single permanent cable edge matches command geometry", evidence };
  }
  const byNode = new Map<string, Record<string, unknown>[]>();
  for (const edge of eligible) {
    const nodes = edgeNodes(edge);
    if (!nodes) continue;
    for (const node of [nodes.start, nodes.end]) byNode.set(node, [...(byNode.get(node) ?? []), edge]);
  }
  const paths: Array<{ edges: Record<string, unknown>[]; nodes: string[] }> = [];
  let branchAmbiguous = false;
  let searchBudgetExceeded = false;
  let multipleTargetPaths = false;
  let searchSteps = 0;
  const maximumSearchSteps = 2048;
  const visit = (edge: Record<string, unknown>, reverse: boolean, used: Set<string>, pathEdges: Record<string, unknown>[], pathNodes: string[]) => {
    searchSteps += 1;
    if (searchSteps > maximumSearchSteps) { searchBudgetExceeded = true; return; }
    if (multipleTargetPaths) return;
    const id = refKey(edge.entity);
    const nodes = edgeNodes(edge);
    if (!id || !nodes || used.has(id)) return;
    const from = reverse ? nodes.end : nodes.start;
    const to = reverse ? nodes.start : nodes.end;
    const end = orientPoint(edge, "end", reverse);
    if (!end) return;
    const nextEdges = (byNode.get(to) ?? []).filter((candidate) => refKey(candidate.entity) !== id && !used.has(refKey(candidate.entity) ?? ""));
    const priorNodeCount = pathNodes.length;
    used.add(id);
    pathEdges.push(edge);
    if (priorNodeCount === 0) pathNodes.push(from, to);
    else pathNodes.push(to);
    if (targetNodeKey ? to === targetNodeKey : distance(end, input.action.x2, input.action.z2) <= tolerance) {
      const pathFingerprint = pathEdges.map((candidate) => refKey(candidate.entity)).join(",");
      if (!paths.some((path) => path.edges.map((candidate) => refKey(candidate.entity)).join(",") === pathFingerprint)) {
        paths.push({ edges: [...pathEdges], nodes: [...pathNodes] });
        if (paths.length > 1) multipleTargetPaths = true;
      }
      pathEdges.pop();
      pathNodes.length = priorNodeCount;
      used.delete(id);
      return;
    }
    if (nextEdges.length > 1) branchAmbiguous = true;
    for (const next of nextEdges) {
      const nextNodes = edgeNodes(next)!;
      const nextReverse = nextNodes.end === to;
      const nextStart = orientPoint(next, "start", nextReverse);
      if (!nextStart || Math.hypot(end.x - nextStart.x, end.z - nextStart.z) > tolerance) continue;
      visit(next, nextReverse, used, pathEdges, pathNodes);
      if (searchBudgetExceeded || multipleTargetPaths) break;
    }
    pathEdges.pop();
    pathNodes.length = priorNodeCount;
    used.delete(id);
  };
  for (const seed of seeds) {
    const nodes = edgeNodes(seed);
    if (!nodes) continue;
    visit(seed, distance(seed.end, input.action.x1, input.action.z1) <= tolerance, new Set(), [], []);
    if (nodes.start === nodes.end) branchAmbiguous = true;
    if (searchBudgetExceeded || multipleTargetPaths) break;
  }
  const uniquePaths = paths;
  if (searchBudgetExceeded) return { decision: "UNKNOWN", reason: "permanent cable chain search exceeded its bounded path budget", evidence };
  if (uniquePaths.length > 1) return { decision: "UNKNOWN", reason: "ambiguous multiple permanent cable chains reach the command endpoint", evidence };
  if (uniquePaths.length === 0 && branchAmbiguous) return { decision: "UNKNOWN", reason: "branched permanent cable graph has no uniquely resolved command chain", evidence };
  const path = uniquePaths[0];
  if (!path && targetNodeKey && seeds.some((edge) => edgeNodes(edge) === null)) {
    return { decision: "UNKNOWN", reason: "authoritative target identity cannot be checked because cable node identities are incomplete", evidence };
  }
  if (!path) return { decision: "PROVEN_MISMATCH", reason: "complete bounded cable scan proves no exact continuous cable chain", evidence };
  evidence.matchedEdgeIds = path.edges.map((edge) => refKey(edge.entity)).filter((value): value is string => value !== null);
  evidence.matchedNodeIds = path.nodes.filter((value, index, all) => all.indexOf(value) === index);
  return { decision: "OBSERVED_MATCH", reason: targetNodeKey
    ? `unique continuous permanent cable chain matches command start and authoritative target END identity (${evidence.matchedEdgeIds.length} native edge segments)`
    : `unique continuous permanent cable chain matches command geometry (${evidence.matchedEdgeIds.length} native edge segments)`, evidence };
}

export interface ConnectionObjectiveMatch {
  status: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  networkConnected: UtilityTruth;
  targetNetworkReachable: UtilityTruth;
  /**
   * Diagnostic only. A building's utility connector node is normally orphaned in
   * the engine's own building graph, so it is reported as evidence and never used
   * as a connectivity verdict.
   */
  orphan: UtilityTruth;
  reason: string;
}

/**
 * Whether a topology observation's target endpoints actually contain the
 * approved contact, in the pipe family.
 *
 * `targetNetworkReachable` from {@link matchConnectionObjective} says a walk from
 * the facility's flow node arrived somewhere in the target set. For a pipe slice
 * that is only the service-entry claim if the place it arrived is the pipe node
 * standing at the approved contact — the point the admitted course was
 * authorized to meet. A walk that terminated at the right family but the wrong
 * endpoint is not this course's entry, so it is reported as unproven rather than
 * accepted.
 */
export function topologyReachedApprovedContact(
  topology: unknown,
  approvedContact: { x: number; z: number },
  tolerance = 1.5,
): boolean {
  const target = record(record(record(topology).targetNetwork).target);
  const endpoints = Array.isArray(target.endpoints) ? target.endpoints.map(record) : [];
  return endpoints.some((endpoint) => {
    if (endpoint.utility !== "WATER_PIPE") return false;
    const position = record(endpoint.position);
    const x = Number(position.x);
    const z = Number(position.z);
    return Number.isFinite(x) && Number.isFinite(z) &&
      Math.hypot(x - approvedContact.x, z - approvedContact.z) <= tolerance;
  });
}

/** Reconciles the connection objective independently of the cable primitive. */
export function matchConnectionObjective(input: { topology: unknown }): ConnectionObjectiveMatch {
  try {
    const topology = record(input.topology);
    const binding = record(topology.binding);
    if (binding.bindingStatus !== "VALID" || binding.complete !== true || binding.truncated === true) {
      return { status: "UNKNOWN", networkConnected: "UNKNOWN", targetNetworkReachable: "UNKNOWN", orphan: "UNKNOWN", reason: "objective topology binding is unknown or incomplete" };
    }
    const connector = record(topology.connector);
    const target = record(topology.targetNetwork);
    const networkConnected = typeof connector.networkConnected === "boolean"
      ? connector.networkConnected : connector.attached === true ? "UNKNOWN" : false;
    const targetNetworkReachable = typeof target.targetNetworkReachable === "boolean"
      ? target.targetNetworkReachable
      : target.complete === true && target.truncated === false && typeof target.networkConnected === "boolean"
        ? target.networkConnected : "UNKNOWN";
    const attached = connector.attached === true;
    const orphan: UtilityTruth = typeof connector.orphan === "boolean" ? connector.orphan : "UNKNOWN";
    if (!attached || networkConnected !== true || targetNetworkReachable !== true) {
      return { status: "INCOMPLETE", networkConnected, targetNetworkReachable, orphan, reason: "connection objective is not complete" };
    }
    return { status: "COMPLETE", networkConnected, targetNetworkReachable, orphan, reason: "connection objective topology is complete" };
  } catch {
    return { status: "UNKNOWN", networkConnected: "UNKNOWN", targetNetworkReachable: "UNKNOWN", orphan: "UNKNOWN", reason: "objective matcher exception" };
  }
}
