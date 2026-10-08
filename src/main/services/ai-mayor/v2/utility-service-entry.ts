import type { SpatialEntityRef, SpatialPoint2 } from "../spatial/types";
import type { GreenfieldUtilityExecutionScope } from "./greenfield-utility-bootstrap";

export interface CertifiedUtilityServiceEntry {
  target: { entity: SpatialEntityRef; position: SpatialPoint2; prefab: string; farEnd?: SpatialPoint2 };
  refs: readonly SpatialEntityRef[];
}

/**
 * Keep using the tranche's already admitted utility service entry when the
 * durable scope is still bound to the live world. The root road-delivery
 * certificate remains the fallback for first placement; this only carries an
 * existing same-branch successor target through K05 re-entry.
 */
export function currentUtilityServiceEntry(input: {
  scope: GreenfieldUtilityExecutionScope | null | undefined;
  projectId: string;
  trancheId: string;
  worldId: string;
  worldEpochId: string;
  generation: string;
  fallback: CertifiedUtilityServiceEntry | null;
}): CertifiedUtilityServiceEntry | null {
  const { scope } = input;
  const entry = scope?.targetServiceEntry;
  const semantics = scope?.targetSemantics;
  if (scope && entry && semantics && scope.projectId === input.projectId && scope.trancheId === input.trancheId &&
    scope.worldId === input.worldId && scope.worldEpochId === input.worldEpochId && scope.generation === input.generation &&
    scope.certifiedRoadRefs.some((ref) => ref.index === entry.road.index && ref.version === entry.road.version) &&
    semantics.utility === "ELECTRICITY" && semantics.role === "NETWORK_ENTRY" && semantics.attachmentRole === "END" &&
    Math.hypot(semantics.approvedContact.x - entry.position.x, semantics.approvedContact.z - entry.position.z) <= 0.25 &&
    (!entry.prefab || semantics.targetRoad.prefab === entry.prefab) &&
    Math.hypot(semantics.targetRoad.anchor.x - entry.position.x, semantics.targetRoad.anchor.z - entry.position.z) <= 0.25) {
    return { target: { entity: entry.road, position: entry.position, prefab: entry.prefab ?? semantics.targetRoad.prefab,
      ...(entry.farEnd ? { farEnd: entry.farEnd } : {}) }, refs: [...scope.certifiedRoadRefs] };
  }
  return input.fallback;
}
