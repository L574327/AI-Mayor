import type { SpatialEntityRef } from "../spatial/types";

export type UtilityEndpointRole = "START" | "END";
export type UtilityEndpointMode = "FREE_POINT" | "EXISTING_NET_NODE";
export type UtilityEndpointUtility = "ELECTRICITY" | "WATER" | "SEWAGE";

/** Durable endpoint meaning. Entity IDs are deliberately absent. */
export interface UtilityEndpointBinding {
  mode: UtilityEndpointMode;
  role: UtilityEndpointRole;
  utility: UtilityEndpointUtility;
  prefab: string;
  expectedPosition: { x: number; y: number; z: number };
  bindingRule: string;
  topologyRole: string;
  /** Stable, ID-free lookup criteria used to rebind the node in the active world. */
  topologyLookup?: {
    networkEdgePrefab: string;
    edgeGeometry: { x1: number; z1: number; x2: number; z2: number };
    edgeEndpointRole: UtilityEndpointRole;
    sourceAnchor?: { buildingPrefab: string; position: { x: number; y: number; z: number }; connectorUtility: UtilityEndpointUtility };
    requireSourceReachability: boolean;
  };
}

export interface UtilityEndpointNodeObservation {
  entity: SpatialEntityRef;
  position: { x: number; y: number; z: number };
  worldId: string;
  generation: string;
  utility: UtilityEndpointUtility;
  prefab: string;
  bindingRule: string;
  topologyRole: string;
  topologyVerified: boolean;
}

export interface BoundUtilityEndpoint {
  kind: "EXISTING_NET_NODE" | "NEW_FREE_ENDPOINT";
  role: UtilityEndpointRole;
  entity: SpatialEntityRef | null;
  expectedPosition: { x: number; y: number; z: number };
  worldEpoch: string;
  utility: "ELECTRICITY";
  semanticRole: "NETWORK_ENTRY";
  bindingRule: string;
  topologyRole: string;
}

export type UtilityEndpointRebindResult =
  | { status: "PASS"; endpoint: BoundUtilityEndpoint; matched: UtilityEndpointNodeObservation | null }
  | { status: "FAIL"; reason: "ENDPOINT_BINDING_INVALID" | "ENDPOINT_NODE_MISSING" | "ENDPOINT_NODE_AMBIGUOUS" | "ENDPOINT_TOPOLOGY_MISMATCH" | "ENDPOINT_POSITION_MISMATCH" | "ENDPOINT_WORLD_MISMATCH" };

export function rebindUtilityEndpoint(input: {
  binding: UtilityEndpointBinding;
  nodes: readonly UtilityEndpointNodeObservation[];
  worldId: string;
  generation: string;
  toleranceMeters?: number;
}): UtilityEndpointRebindResult {
  const { binding } = input;
  const tolerance = input.toleranceMeters ?? 0.25;
  if (!binding || !["START", "END"].includes(binding.role) || !binding.utility || !binding.prefab ||
    !binding.bindingRule || !binding.topologyRole || !Object.values(binding.expectedPosition).every(Number.isFinite) ||
    !Number.isFinite(tolerance) || tolerance <= 0 || !input.worldId || !input.generation) {
    return { status: "FAIL", reason: "ENDPOINT_BINDING_INVALID" };
  }
  if (binding.mode === "FREE_POINT") {
    if (binding.topologyRole !== "COURSE_TERMINAL") return { status: "FAIL", reason: "ENDPOINT_BINDING_INVALID" };
    return { status: "PASS", matched: null, endpoint: {
      kind: "NEW_FREE_ENDPOINT", role: binding.role, entity: null,
      expectedPosition: { ...binding.expectedPosition }, worldEpoch: input.generation,
      utility: "ELECTRICITY", semanticRole: "NETWORK_ENTRY", bindingRule: binding.bindingRule,
      topologyRole: binding.topologyRole,
    } };
  }
  if (!binding.topologyLookup || !binding.topologyLookup.networkEdgePrefab ||
    !binding.topologyLookup.edgeGeometry || !binding.topologyLookup.edgeEndpointRole) {
    return { status: "FAIL", reason: "ENDPOINT_BINDING_INVALID" };
  }
  const matches = input.nodes.filter((node) => node.worldId === input.worldId && node.generation === input.generation &&
    node.utility === binding.utility && node.prefab === binding.prefab && node.bindingRule === binding.bindingRule &&
    node.topologyRole === binding.topologyRole);
  if (matches.length === 0) return { status: "FAIL", reason: "ENDPOINT_NODE_MISSING" };
  if (matches.length !== 1) return { status: "FAIL", reason: "ENDPOINT_NODE_AMBIGUOUS" };
  const matched = matches[0];
  if (!matched.topologyVerified) return { status: "FAIL", reason: "ENDPOINT_TOPOLOGY_MISMATCH" };
  if (Math.hypot(matched.position.x - binding.expectedPosition.x, matched.position.y - binding.expectedPosition.y,
    matched.position.z - binding.expectedPosition.z) > tolerance) return { status: "FAIL", reason: "ENDPOINT_POSITION_MISMATCH" };
  if (!Number.isInteger(matched.entity.index) || !Number.isInteger(matched.entity.version)) {
    return { status: "FAIL", reason: "ENDPOINT_BINDING_INVALID" };
  }
  return { status: "PASS", matched, endpoint: {
    kind: "EXISTING_NET_NODE", role: binding.role, entity: { ...matched.entity },
    expectedPosition: { ...matched.position }, worldEpoch: input.generation,
    utility: "ELECTRICITY", semanticRole: "NETWORK_ENTRY", bindingRule: binding.bindingRule,
    topologyRole: binding.topologyRole,
  } };
}

/** Exact action identity includes semantic endpoint modes and the one-step lineage. */
export function utilityActionIdentity(input: {
  utility: UtilityEndpointUtility;
  prefab: string;
  geometry: Readonly<Record<string, number>>;
  start: UtilityEndpointBinding;
  end: UtilityEndpointBinding;
  quote: number;
  actionCount: 1;
  repairLineage: string;
  stepId: string;
}): string {
  return JSON.stringify({
    utility: input.utility,
    prefab: input.prefab,
    geometry: input.geometry,
    startEndpoint: input.start,
    endEndpoint: input.end,
    quote: input.quote,
    actionCount: input.actionCount,
    repairLineage: input.repairLineage,
    stepId: input.stepId,
  });
}
