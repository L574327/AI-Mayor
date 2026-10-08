import type { SpatialEntityRef, SpatialNativeCurve, SpatialPoint2, SpatialPoint3, SpatialRoadEdge } from "../spatial/types";
import type { RoadEndpointAttachment } from "./road-kernel";

export interface ImmutableElectricityTargetSemantics {
  schemaVersion: "ai-mayor-v2-electricity-target/1";
  utility: "ELECTRICITY";
  role: "NETWORK_ENTRY";
  attachmentRole: "END";
  approvedContact: SpatialPoint2;
  targetRoad: {
    prefab: string;
    endpointRole: "start" | "end";
    anchor: SpatialPoint2;
  };
  approvedPlanRevision: string;
}

export interface CurrentElectricityTargetBinding {
  semantic: ImmutableElectricityTargetSemantics;
  road: SpatialEntityRef;
  node: SpatialEntityRef;
  nodePosition: SpatialPoint3;
  flowNode: SpatialEntityRef;
  approvedContact: SpatialPoint2;
  geometricContactPosition: SpatialPoint3;
  endpointRole: "END";
  /** Compatibility alias; always equals geometricContactPosition. */
  expectedPosition: SpatialPoint3;
  worldEpoch: string;
  generation: string;
  topologyRevision: string;
  diagnostics: ElectricityTargetBindingDiagnostics;
}

export interface ElectricityTargetEndpointObservation {
  role: "start" | "end";
  node: SpatialEntityRef;
  position: SpatialPoint3;
  electricityFlowNode: SpatialEntityRef | null;
  utility: "ELECTRICITY";
  road: SpatialEntityRef | null;
}

export interface ElectricityTargetTopologyObservation {
  binding: { bindingStatus: string; generation?: string; topologyRevision?: string; complete: boolean; truncated: boolean };
  targetServiceEntryRoad: SpatialEntityRef;
  reboundTargetRoad: SpatialEntityRef;
  targetEndpoints: ElectricityTargetEndpointObservation[];
}

export interface ElectricityTargetRoadEndpointObservation {
  role: "start" | "end";
  position: SpatialPoint2;
  nativeCurve?: SpatialNativeCurve;
  /** Only set when current-generation geometry provides the approved contact's 3D point. */
  position3D?: SpatialPoint3;
}

export interface ElectricityTargetBindingDiagnostics {
  targetServiceEntryRoad: SpatialEntityRef;
  reboundTargetRoad: SpatialEntityRef;
  selectedCandidateRoad: SpatialEntityRef | null;
  selectedNode: SpatialEntityRef | null;
  selectedFlowNode: SpatialEntityRef | null;
  roadIdentityMatches: boolean;
  approvedContact: SpatialPoint2;
  selectedNodePosition: SpatialPoint3 | null;
  resolvedGeometricContactPosition: SpatialPoint3 | null;
  approvedContactToNodeDistance: number | null;
  geometricContactToApprovedContactDistance: number | null;
  nativeCurve: SpatialNativeCurve | null;
  projectedT: number | null;
  projectedPosition: SpatialPoint3 | null;
  xzResidual: number | null;
}

export interface NativeCurveProjection {
  projectedT: number;
  projectedPosition: SpatialPoint3;
  xzResidual: number;
}

const bezierPoint = (curve: SpatialNativeCurve, t: number): SpatialPoint3 => {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * curve.a.x + w1 * curve.b.x + w2 * curve.c.x + w3 * curve.d.x,
    y: w0 * curve.a.y + w1 * curve.b.y + w2 * curve.c.y + w3 * curve.d.y,
    z: w0 * curve.a.z + w1 * curve.b.z + w2 * curve.c.z + w3 * curve.d.z,
  };
};

export function projectApprovedContactOnNativeCurve(contact: SpatialPoint2, curve: SpatialNativeCurve): NativeCurveProjection {
  const samples = 257;
  let bestT = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const distanceAt = (t: number) => {
    const point = bezierPoint(curve, t);
    return Math.hypot(point.x - contact.x, point.z - contact.z);
  };
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const distance = distanceAt(t);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestT = t;
    }
  }
  let halfWidth = 1 / (samples - 1);
  for (let iteration = 0; iteration < 12; iteration++) {
    const left = Math.max(0, bestT - halfWidth);
    const right = Math.min(1, bestT + halfWidth);
    const third = (right - left) / 3;
    const t1 = left + third;
    const t2 = right - third;
    bestT = distanceAt(t1) < distanceAt(t2) ? t1 : t2;
    halfWidth = third;
  }
  const projectedT = Math.max(0, Math.min(1, bestT));
  const projectedPosition = bezierPoint(curve, projectedT);
  return {
    projectedT,
    projectedPosition,
    xzResidual: Math.hypot(projectedPosition.x - contact.x, projectedPosition.z - contact.z),
  };
}

const distance2 = (left: SpatialPoint2, right: SpatialPoint2) => Math.hypot(left.x - right.x, left.z - right.z);

/**
 * Current-generation road reacquisition for the preflight residual probe.
 * Durable entity ids are intentionally not used as the lookup key; the
 * immutable target role, prefab, and approved geometry are.
 */
export function reacquirePreflightTargetRoad(input: {
  edges: SpatialRoadEdge[];
  semantic: ImmutableElectricityTargetSemantics;
  tolerance?: number;
  /**
   * The certified target's committed far endpoint, when the durable scope
   * carries one.
   *
   * The contact point is not a unique key on its own, and the immutable
   * semantics do not make it one: `targetRoad.anchor` is derived from the same
   * contact, so both predicates below ask the same question of the same node.
   * As soon as the game tessellates the delivered course into several
   * same-prefab edges meeting at that node — which it does — every one of them
   * matches and the reacquisition can only refuse, which is exactly what
   * `UTILITY_TARGET_ROAD_REBIND_AMBIGUOUS` reports.
   *
   * Which of those edges is the target is not a geometric question about the
   * contact. It is already durable: the target road is the delivered course
   * whose own `exactInput` committed to this far endpoint, which is why the
   * identical ambiguity is already resolved by this same key in
   * `reacquireTargetRoadByApprovedContact`. Passing it here is what makes the
   * preflight probe able to reacquire a split road at all.
   *
   * Absent when the durable scope recorded none; the reacquisition then keeps
   * its old contact-and-prefab behaviour and still refuses a non-unique answer
   * rather than picking one.
   */
  farEndpoint?: SpatialPoint2;
}): { status: "YES"; road: SpatialRoadEdge } | { status: "NO" | "AMBIGUOUS"; candidates: SpatialRoadEdge[] } {
  const tolerance = input.tolerance ?? 0.25;
  const endpoint = input.semantic.targetRoad.endpointRole;
  const carries = (edge: SpatialRoadEdge, point: SpatialPoint2) =>
    distance2(edge.start, point) <= tolerance || distance2(edge.end, point) <= tolerance;
  const candidates = input.edges.filter((edge) =>
    edge.prefab === input.semantic.targetRoad.prefab &&
    distance2(edge[endpoint], input.semantic.approvedContact) <= tolerance &&
    distance2(edge[endpoint], input.semantic.targetRoad.anchor) <= tolerance &&
    (input.farEndpoint === undefined || carries(edge, input.farEndpoint)));
  if (candidates.length === 1) return { status: "YES", road: candidates[0] };
  return { status: candidates.length === 0 ? "NO" : "AMBIGUOUS", candidates };
}

/**
 * Current-generation reacquisition of the certified target road from the
 * admitted course alone.
 *
 * A durable scope's `certifiedRoadRefs` name entities of the generation the
 * command ran in, so after a reload they are stale by construction: the same
 * road is a different entity, and the recorded id resolves to nothing at all.
 * The approved contact — the admitted course's own endpoint — is immutable
 * geometry, so it, and only it, is used as the lookup key. Exactly one current
 * road edge must carry an endpoint there; zero or several prove nothing, and
 * the caller must treat that as UNKNOWN rather than pick a candidate.
 */
export function reacquireTargetRoadByApprovedContact(input: {
  edges: SpatialRoadEdge[];
  approvedContact: SpatialPoint2;
  tolerance?: number;
  /**
   * The prefab the admitted ROAD command was authorized to build.
   *
   * The contact point alone stops being a unique key as soon as the game
   * tessellates the delivered road: the current world can carry the admitted
   * course as several edges meeting at the very node the course was admitted
   * against — the live water world split one Medium Road into two, on a node a
   * map highway also ends at. Prefab is durable authority, not a hint: it comes
   * from the command's own `exactInput`, so it can only ever narrow the search
   * to edges the command could have produced.
   */
  prefab?: string;
  /**
   * The admitted command's far endpoint (`x2, z2` of the same `exactInput`).
   *
   * Also immutable geometry, and the key that survives the split: of two edges
   * sharing the contact node, exactly one also carries the far endpoint the
   * command committed to.
   */
  farEndpoint?: SpatialPoint2;
}): { status: "YES"; road: SpatialRoadEdge } | { status: "NO" | "AMBIGUOUS"; candidates: SpatialRoadEdge[] } {
  const tolerance = input.tolerance ?? 0.25;
  const carries = (edge: SpatialRoadEdge, point: SpatialPoint2) =>
    distance2(edge.start, point) <= tolerance || distance2(edge.end, point) <= tolerance;
  const atContact = input.edges.filter(
    (edge) => edge.deleted !== true && carries(edge, input.approvedContact),
  );
  const candidates = atContact.filter((edge) => {
    if (input.prefab !== undefined && edge.prefab !== input.prefab) return false;
    if (input.farEndpoint !== undefined && !carries(edge, input.farEndpoint)) return false;
    return true;
  });
  if (candidates.length !== 1) return { status: candidates.length === 0 ? "NO" : "AMBIGUOUS", candidates };
  return { status: "YES", road: candidates[0] };
}

/** One current-world net edge of an admitted course, as the world reports it. */
export interface AdmittedNetCourseEdge {
  entity: SpatialEntityRef;
  prefab: string;
  start: SpatialPoint2;
  end: SpatialPoint2;
}

/**
 * The current net edge that carries an admitted course's approved contact.
 *
 * A pipe family's service entry is its own admitted course, not the road the
 * course was routed to, because the contact is where the course meets the
 * certified road — and that is the only place the pipe network can be asked
 * about in its own flow family. The contact alone does not identify it (the
 * course is realized as several same-prefab edges), so the prefab the course was
 * authorized with is the second key. Zero or several matches prove nothing and
 * are refused rather than picked.
 */
export function reacquireAdmittedCourseTerminal(input: {
  edges: readonly AdmittedNetCourseEdge[];
  prefab: string;
  approvedContact: SpatialPoint2;
  tolerance?: number;
}): { status: "YES"; edge: AdmittedNetCourseEdge; contactEnd: "start" | "end" } |
  { status: "NO" | "AMBIGUOUS"; candidates: AdmittedNetCourseEdge[] } {
  const tolerance = input.tolerance ?? 1.5;
  const candidates = input.edges.filter((edge) =>
    edge.prefab === input.prefab &&
    (distance2(edge.start, input.approvedContact) <= tolerance || distance2(edge.end, input.approvedContact) <= tolerance));
  if (candidates.length !== 1) return { status: candidates.length === 0 ? "NO" : "AMBIGUOUS", candidates };
  const only = candidates[0];
  return {
    status: "YES",
    edge: only,
    contactEnd: distance2(only.end, input.approvedContact) <= tolerance ? "end" : "start",
  };
}

export function electricityTargetSemantics(input: {
  contact: SpatialPoint2;
  targetRoad: { prefab: string; endpointRole: "start" | "end"; anchor: SpatialPoint2 };
  approvedPlanRevision: string;
}): ImmutableElectricityTargetSemantics {
  return {
    schemaVersion: "ai-mayor-v2-electricity-target/1",
    utility: "ELECTRICITY",
    role: "NETWORK_ENTRY",
    attachmentRole: "END",
    approvedContact: { ...input.contact },
    targetRoad: { ...input.targetRoad, anchor: { ...input.targetRoad.anchor } },
    approvedPlanRevision: input.approvedPlanRevision,
  };
}

/**
 * The Bridge reports a topology revision as `generation:targetIndex:targetVersion`
 * and treats any other value it is asked to expect as STALE. The durable scope
 * revision speaks a different vocabulary, so the caller must translate it into
 * the Bridge's target-entity form instead of passing the scope revision verbatim.
 */
export function bridgeTopologyRevision(input: {
  generation: string;
  target: { index: number; version: number };
}): string {
  return `${input.generation}:${input.target.index}:${input.target.version}`;
}

export function electricityTargetSemanticFingerprint(value: ImmutableElectricityTargetSemantics): string {
  return JSON.stringify(value);
}

const edgeEntity = (value: unknown): { index: number; version: number } | null => {
  const entity = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).entity
    : undefined;
  const record = typeof entity === "object" && entity !== null && !Array.isArray(entity)
    ? entity as Record<string, unknown>
    : undefined;
  if (!record) return null;
  return Number.isInteger(Number(record.index)) && Number.isInteger(Number(record.version))
    ? { index: Number(record.index), version: Number(record.version) }
    : null;
};

/**
 * Narrows current-prefab target-road candidates by the road identity the durable
 * scope itself certified.
 *
 * The admitted contact cannot be a unique key: `targetRoad.anchor` is derived
 * from that same contact, so both predicates of the contact match ask the same
 * question of the same node, and every same-prefab edge meeting that node
 * answers it. Attaching the Mayor's own access road to an existing junction is
 * enough to produce exactly that — which turns a genuinely realized cable into
 * an unprovable one.
 *
 * `certifiedRoadRefs` are entity ids of the generation the command ran in, so
 * they are an identity only while the world is still that generation; once it is
 * not, this returns the candidates untouched and the geometric answer stands.
 * They are also only ever used to *select among* candidates geometry already
 * produced, so a demolished or replaced target cannot be resurrected here: a ref
 * matching nothing narrows nothing, and a ref matching several stays ambiguous.
 */
export function narrowTargetRoadsByCertifiedRefs<T extends { entity?: unknown }>(input: {
  candidates: readonly T[];
  certifiedRoadRefs: readonly SpatialEntityRef[];
  commandGeneration: string;
  currentGeneration: string;
}): readonly T[] {
  if (input.candidates.length <= 1) return input.candidates;
  if (input.commandGeneration !== input.currentGeneration) return input.candidates;
  const named = input.certifiedRoadRefs
    .map((ref) => ({ index: Number(ref.index), version: Number(ref.version) }))
    .filter((ref) => Number.isInteger(ref.index) && Number.isInteger(ref.version));
  if (named.length === 0) return input.candidates;
  const narrowed = input.candidates.filter((candidate) => {
    const identity = edgeEntity(candidate);
    return identity !== null && named.some((ref) => ref.index === identity.index && ref.version === identity.version);
  });
  return narrowed.length === 1 ? narrowed : input.candidates;
}

export function resolveCurrentElectricityTarget(input: {
  semantic: ImmutableElectricityTargetSemantics;
  observation: ElectricityTargetTopologyObservation;
  roadEndpoint: ElectricityTargetRoadEndpointObservation;
  worldEpoch: string;
  generation: string;
  topologyRevision: string;
  tolerance?: number;
}): { status: "PASS"; binding: CurrentElectricityTargetBinding } | { status: "FAIL"; reason: string; diagnostics?: ElectricityTargetBindingDiagnostics } {
  const tolerance = input.tolerance ?? 0.25;
  const binding = input.observation.binding;
  // Bridge's `binding.complete` is also cleared when its reachability walk
  // finds an incomplete/disconnected flow graph. Before this cable is applied,
  // that walk is expected to be incomplete. Exact binding validity is carried
  // independently by bindingStatus and the world/generation/revision fields;
  // keep rejecting stale or truncated identity evidence here.
  if (binding.bindingStatus !== "VALID" || binding.truncated === true) {
    return { status: "FAIL", reason: "electricity target topology binding is stale, unbound, or truncated" };
  }
  if (binding.generation && binding.generation !== input.generation) return { status: "FAIL", reason: "electricity target generation mismatch" };
  if (binding.topologyRevision && binding.topologyRevision !== input.topologyRevision) return { status: "FAIL", reason: "electricity target topology revision mismatch" };
  if (input.roadEndpoint.role !== input.semantic.targetRoad.endpointRole) return { status: "FAIL", reason: "target road endpoint role mismatch" };
  if (distance2(input.roadEndpoint.position, input.semantic.approvedContact) > tolerance ||
    distance2(input.roadEndpoint.position, input.semantic.targetRoad.anchor) > tolerance) {
    return { status: "FAIL", reason: "approved Electricity contact does not match current road curve endpoint" };
  }
  const projection = input.roadEndpoint.nativeCurve
    ? projectApprovedContactOnNativeCurve(input.semantic.approvedContact, input.roadEndpoint.nativeCurve)
    : null;
  const roadIdentityMatches = sameEntity(input.observation.targetServiceEntryRoad, input.observation.reboundTargetRoad);
  const diagnostics = (selectedCandidate: ElectricityTargetEndpointObservation | null): ElectricityTargetBindingDiagnostics => ({
    targetServiceEntryRoad: input.observation.targetServiceEntryRoad,
    reboundTargetRoad: input.observation.reboundTargetRoad,
    selectedCandidateRoad: selectedCandidate?.road ?? null,
    selectedNode: selectedCandidate?.node ?? null,
    selectedFlowNode: selectedCandidate?.electricityFlowNode ?? null,
    roadIdentityMatches,
    approvedContact: { ...input.semantic.approvedContact },
    selectedNodePosition: selectedCandidate?.position ?? null,
    resolvedGeometricContactPosition: input.roadEndpoint.position3D ?? null,
    approvedContactToNodeDistance: selectedCandidate
      ? distance2({ x: selectedCandidate.position.x, z: selectedCandidate.position.z }, input.semantic.approvedContact)
      : null,
    geometricContactToApprovedContactDistance: projection
      ? projection.xzResidual
      : input.roadEndpoint.position3D
      ? distance2({ x: input.roadEndpoint.position3D.x, z: input.roadEndpoint.position3D.z }, input.semantic.approvedContact)
      : null,
    nativeCurve: input.roadEndpoint.nativeCurve ?? null,
    projectedT: projection?.projectedT ?? null,
    projectedPosition: projection?.projectedPosition ?? input.roadEndpoint.position3D ?? null,
    xzResidual: projection?.xzResidual ?? (input.roadEndpoint.position3D
      ? distance2({ x: input.roadEndpoint.position3D.x, z: input.roadEndpoint.position3D.z }, input.semantic.approvedContact)
      : null),
  });
  if (!roadIdentityMatches) return { status: "FAIL", reason: "TARGET_ROAD_ENDPOINT_NOT_FOUND", diagnostics: diagnostics(null) };
  const candidates = input.observation.targetEndpoints.filter((candidate) =>
    candidate.role === input.semantic.targetRoad.endpointRole &&
    candidate.utility === "ELECTRICITY" &&
    sameEntity(candidate.road, input.observation.reboundTargetRoad),
  );
  if (candidates.length === 0) return { status: "FAIL", reason: "TARGET_ROAD_ENDPOINT_NOT_FOUND", diagnostics: diagnostics(null) };
  if (candidates.length > 1) return { status: "FAIL", reason: "TARGET_ROAD_ENDPOINT_AMBIGUOUS", diagnostics: diagnostics(candidates[0]) };
  const match = candidates[0];
  if (!match.electricityFlowNode) return { status: "FAIL", reason: "target node has no ElectricityNodeConnection flow node", diagnostics: diagnostics(match) };
  if (!projection || projection.xzResidual > tolerance) {
    return { status: "FAIL", reason: "APPROVED_CONTACT_3D_POSITION_UNAVAILABLE", diagnostics: diagnostics(match) };
  }
  const geometricContactPosition = projection.projectedPosition;
  const finalDiagnostics = diagnostics(match);
  finalDiagnostics.projectedT = projection.projectedT;
  finalDiagnostics.projectedPosition = projection.projectedPosition;
  finalDiagnostics.xzResidual = projection.xzResidual;
  finalDiagnostics.geometricContactToApprovedContactDistance = projection.xzResidual;
  return {
    status: "PASS",
    binding: {
      semantic: input.semantic,
      road: match.road!,
      node: match.node,
      nodePosition: match.position,
      flowNode: match.electricityFlowNode,
      approvedContact: { ...input.semantic.approvedContact },
      geometricContactPosition,
      endpointRole: "END",
      expectedPosition: geometricContactPosition,
      worldEpoch: input.worldEpoch,
      generation: input.generation,
      topologyRevision: input.topologyRevision,
      diagnostics: finalDiagnostics,
    },
  };
}

function sameEntity(left: SpatialEntityRef | null, right: SpatialEntityRef | null): boolean {
  return left !== null && right !== null && left.index === right.index && left.version === right.version;
}

export function electricityTargetEndpoint(binding: CurrentElectricityTargetBinding): RoadEndpointAttachment {
  const selectedRoad = binding.road;
  const selectedNode = binding.diagnostics.selectedNode;
  const contact = selectedRoad && selectedNode
    ? {
      roadEdge: selectedRoad,
      roadNode: selectedNode,
      position: binding.geometricContactPosition,
      endpointRole: "END" as const,
    }
    : undefined;
  return {
    kind: "NEW_FREE_ENDPOINT",
    role: "END",
    // The physical endpoint is intentionally a newly-created free node. Keep
    // its entity identity explicit and null; roadNode is only the geometric
    // contact anchor and flowNode is derived electricity topology.
    entity: null,
    expectedPosition: binding.geometricContactPosition,
    worldEpoch: binding.worldEpoch,
    utility: "ELECTRICITY",
    semanticRole: "NETWORK_ENTRY",
    ...(contact ? {
      geometricContact: contact,
      topologyExpectation: {
        flowNode: binding.flowNode,
        roadEdge: selectedRoad!,
        expectedReachability: "ELECTRICITY" as const,
      },
    } : {}),
  };
}

export function currentBindingMatchesSemantic(binding: CurrentElectricityTargetBinding, semantic: ImmutableElectricityTargetSemantics): boolean {
  return electricityTargetSemanticFingerprint(binding.semantic) === electricityTargetSemanticFingerprint(semantic) &&
    binding.semantic.attachmentRole === "END";
}
