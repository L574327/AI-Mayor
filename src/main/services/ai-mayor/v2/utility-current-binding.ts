import type { PlannedUtilityFacility, SpatialPoint2 } from "../spatial/types";
import type { UtilityConnectorReadback, UtilityEntityRef, UtilityPlacementReceipt, UtilityRecoveryKind } from "../utility-recovery";

export type UtilityBindingFailureReason =
  | "UTILITY_FACILITY_NOT_FOUND"
  | "UTILITY_FACILITY_AMBIGUOUS"
  | "UTILITY_FACILITY_OBSERVATION_INCOMPLETE"
  | "UTILITY_FACILITY_ENTITY_INVALID"
  | "UTILITY_CONNECTOR_NOT_FOUND"
  | "UTILITY_CONNECTOR_AMBIGUOUS"
  | "UTILITY_CONNECTOR_OBSERVATION_INCOMPLETE"
  | "UTILITY_CONNECTOR_ENTITY_INVALID";

export interface CurrentUtilityBinding {
  currentFacility: UtilityPlacementReceipt & { generation: string };
  currentConnector: UtilityConnectorReadback & { generation: string };
}

export type CurrentUtilityBindingResult =
  | { status: "MATCH"; binding: CurrentUtilityBinding }
  | { status: "BLOCKED"; reason: UtilityBindingFailureReason; diagnostics?: Record<string, unknown> };

const entity = (value: unknown): UtilityEntityRef | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return Number.isInteger(candidate.index) && Number.isInteger(candidate.version)
    ? { index: Number(candidate.index), version: Number(candidate.version) }
    : null;
};

const point = (value: unknown): SpatialPoint2 | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return Number.isFinite(Number(candidate.x)) && Number.isFinite(Number(candidate.z))
    ? { x: Number(candidate.x), z: Number(candidate.z) }
    : null;
};

export function resolveCurrentUtilityBinding(input: {
  planned?: PlannedUtilityFacility;
  currentFacility?: UtilityPlacementReceipt;
  utility: UtilityRecoveryKind;
  buildings: unknown[] | null;
  connectors: unknown[] | null;
  generation: string;
  /**
   * Caller attestation that `buildings`/`connectors` are a complete observation
   * of the searched world set. Required so a caller cannot silently skip the
   * guard and let an incomplete read resolve a binding.
   */
  observationComplete: boolean;
  /**
   * Caller attestation that `connectors` were read FROM the facility entity
   * above — i.e. the query was "what connectors does this building have", not a
   * wider scan that happened to include it.
   *
   * When that holds, membership is settled by provenance and proximity is
   * evidence of nothing. It has to be said out loud because the proximity rule
   * it replaces is only valid for the geometry it was written against: an
   * electricity connector sits on the building's origin, while a
   * `GroundwaterPumpingStation01`'s water connector sits on its footprint, 16 m
   * away. A fixed 2 m radius therefore binds every WindTurbine and refuses every
   * pumping station — a prefab-shaped assumption wearing the clothes of a safety
   * check.
   *
   * Defaults to false, so a caller that forgets it keeps the strict rule and
   * loses authority rather than gaining it.
   */
  connectorsScopedToFacilityEntity?: boolean;
}): CurrentUtilityBindingResult {
  if (!input.observationComplete || !input.buildings || !input.connectors) {
    return { status: "BLOCKED", reason: "UTILITY_FACILITY_OBSERVATION_INCOMPLETE" };
  }

  const facilityMatches = input.buildings.filter((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const candidate = raw as Record<string, unknown>;
    const position = point(candidate.position);
    if (candidate.isSubBuilding === true || position === null) return false;
    if (input.currentFacility) {
      const candidateEntity = entity(candidate.entity);
      return candidateEntity?.index === input.currentFacility.entity.index && candidateEntity.version === input.currentFacility.entity.version;
    }
    return input.planned !== undefined && candidate.prefab === input.planned.prefab &&
      Math.hypot(position.x - input.planned.position.x, position.z - input.planned.position.z) <= 1.5;
  });
  if (facilityMatches.length === 0) return { status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND" };
  if (facilityMatches.length > 1) return { status: "BLOCKED", reason: "UTILITY_FACILITY_AMBIGUOUS", diagnostics: { count: facilityMatches.length } };

  const facility = facilityMatches[0] as Record<string, unknown>;
  const facilityEntity = entity(facility.entity);
  const facilityPosition = point(facility.position);
  if (!facilityEntity || !facilityPosition) return { status: "BLOCKED", reason: "UTILITY_FACILITY_ENTITY_INVALID" };

  const connectorMatches = input.connectors.filter((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const candidate = raw as Record<string, unknown>;
    const position = point(candidate.worldPosition);
    const utilityEligible = input.utility === "electricity"
      ? candidate.type === "electricity"
      : candidate.type === "waterPipe" && (input.utility === "water"
        ? Number((candidate.capacity as Record<string, unknown> | undefined)?.fresh ?? 0) > 0
        : Number((candidate.capacity as Record<string, unknown> | undefined)?.sewage ?? 0) > 0);
    if (!utilityEligible || position === null) return false;
    if (input.connectorsScopedToFacilityEntity === true) return true;
    return Math.hypot(position.x - facilityPosition.x, position.z - facilityPosition.z) <= 2;
  });
  if (connectorMatches.length === 0) return { status: "BLOCKED", reason: "UTILITY_CONNECTOR_NOT_FOUND" };
  if (connectorMatches.length > 1) return { status: "BLOCKED", reason: "UTILITY_CONNECTOR_AMBIGUOUS", diagnostics: { count: connectorMatches.length } };

  const connector = connectorMatches[0] as Record<string, unknown>;
  const connectorEntity = entity(connector.node);
  const connectorPosition = point(connector.worldPosition);
  if (!connectorEntity || !connectorPosition) return { status: "BLOCKED", reason: "UTILITY_CONNECTOR_ENTITY_INVALID" };

  return {
    status: "MATCH",
    binding: {
      currentFacility: {
        entity: facilityEntity,
        prefab: String(facility.prefab),
        position: facilityPosition,
        generation: input.generation,
      },
      currentConnector: {
        type: connector.type === "electricity" ? "electricity" : "waterPipe",
        node: connectorEntity,
        worldPosition: connectorPosition,
        attached: connector.attached === true,
        orphan: connector.orphan === true,
        capacity: (connector.capacity as UtilityConnectorReadback["capacity"]) ?? {},
        connectedEdges: Array.isArray(connector.connectedEdges) ? connector.connectedEdges as UtilityConnectorReadback["connectedEdges"] : [],
        generation: input.generation,
      },
    },
  };
}
