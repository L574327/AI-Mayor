import type { SpatialPoint2 } from "../spatial/types";

/**
 * Clearance a facility placement must leave before it is worth placing at all.
 *
 * WHY. Two `GroundwaterPumpingStation01` measured on 2026-10-02 at (1403.2,47.9)
 * and (1409.2,-9.2) are 57.5 m apart, both on the same dead-end road node
 * (`231898:125`, degree 1) that the nearest of them only reaches from 49.0 m and
 * the farther one from 106.4 m. Both read back with an EMPTY connector set and
 * `connected:false / noElectricityWarning`, so neither pumps anything. The
 * game's own placement preflight accepted both: it answers "may this object go
 * here?", not "can this object ever work here?".
 *
 * This is that second question, as a pure predicate over the world the caller
 * already read. It does NOT place anything and does NOT replace the native
 * object preflight — that stays the authority on whether the position is legal.
 * It runs BEFORE it, so the attempt is not spent on a position that cannot be
 * connected afterwards.
 */
export interface FacilityPlacementClearanceInput {
  position: SpatialPoint2;
  /** Road edges a service connection could attach to. */
  roads: ReadonlyArray<{ start: SpatialPoint2; end: SpatialPoint2 }>;
  /** Facilities already placed, with the radius their footprint occupies. */
  existingFacilities: ReadonlyArray<{ position: SpatialPoint2; footprintRadiusMeters: number }>;
  /** This facility's own footprint radius. */
  footprintRadiusMeters?: number;
  /** How far a service connection may run from the road to the facility. */
  maxRoadAccessMeters?: number;
  /** Aisle that has to stay clear between two footprints. */
  accessClearanceMeters?: number;
}

export type FacilityPlacementViolation = "NO_ROAD_IN_REACH" | "CROWDED_BY_FACILITY";

export interface FacilityPlacementClearance {
  ok: boolean;
  nearestRoadMeters: number;
  nearestFacilityMeters: number;
  violations: FacilityPlacementViolation[];
  detail: string;
}

const DEFAULT_MAX_ROAD_ACCESS_METERS = 60;
/** Wide enough for the service road and the cable to reach the door without a detour. */
const DEFAULT_ACCESS_CLEARANCE_METERS = 24;

const pointToSegmentDistance = (point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number => {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
};

export function facilityPlacementClearance(input: FacilityPlacementClearanceInput): FacilityPlacementClearance {
  const maxRoadAccessMeters = input.maxRoadAccessMeters ?? DEFAULT_MAX_ROAD_ACCESS_METERS;
  const accessClearanceMeters = input.accessClearanceMeters ?? DEFAULT_ACCESS_CLEARANCE_METERS;
  const ownRadius = input.footprintRadiusMeters ?? 0;

  let nearestRoadMeters = Number.POSITIVE_INFINITY;
  for (const road of input.roads) {
    nearestRoadMeters = Math.min(nearestRoadMeters, pointToSegmentDistance(input.position, road.start, road.end));
  }

  let nearestFacilityMeters = Number.POSITIVE_INFINITY;
  let nearestFacilityGap = Number.POSITIVE_INFINITY;
  for (const other of input.existingFacilities) {
    const separation = Math.hypot(other.position.x - input.position.x, other.position.z - input.position.z);
    nearestFacilityMeters = Math.min(nearestFacilityMeters, separation);
    nearestFacilityGap = Math.min(nearestFacilityGap, separation - ownRadius - other.footprintRadiusMeters);
  }

  const violations: FacilityPlacementViolation[] = [];
  if (!(nearestRoadMeters <= maxRoadAccessMeters)) violations.push("NO_ROAD_IN_REACH");
  // Footprints plus an aisle: without it the two door approaches overlap and
  // whichever service road is built first occupies the node the other needs.
  if (!(nearestFacilityGap >= accessClearanceMeters)) violations.push("CROWDED_BY_FACILITY");

  const detail = [
    `nearestRoad=${Number.isFinite(nearestRoadMeters) ? `${nearestRoadMeters.toFixed(1)}m` : "none"}`,
    `nearestFacility=${Number.isFinite(nearestFacilityMeters) ? `${nearestFacilityMeters.toFixed(1)}m` : "none"}`,
    `footprintGap=${Number.isFinite(nearestFacilityGap) ? `${nearestFacilityGap.toFixed(1)}m` : "none"}`,
    `limits: road<=${maxRoadAccessMeters}m, aisle>=${accessClearanceMeters}m`,
  ].join(", ");

  return { ok: violations.length === 0, nearestRoadMeters, nearestFacilityMeters, violations, detail };
}
