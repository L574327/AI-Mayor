import type { SpatialPoint2 } from "../spatial/types";
import type { MayorStructuredGoalIntent } from "../types";
import type { DistrictRole } from "./district-builder";
import type { ZoneCategory } from "./zoning-mix";

/**
 * What the player asked for, as the district builder's inputs.
 *
 * The cloud model only translates the player's words into a {@link MayorStructuredGoalIntent}; deciding where and
 * how the district goes is local. A stated region, density, map point or land purchase narrows the builder's choice
 * of site, zone and purchase — it never invents a primitive the builder lacks. An intent that is not district work
 * (a service, a traffic fix) maps to null and stays on the Goal path.
 */
export type DistrictRegion = NonNullable<NonNullable<MayorStructuredGoalIntent["scope"]>["region"]>;
export type DistrictDensity = NonNullable<NonNullable<MayorStructuredGoalIntent["scope"]>["density"]>;

export interface DistrictIntent {
  /** The land use asked for; null leaves it to the city's demand. */
  role: DistrictRole | null;
  region: DistrictRegion;
  density: DistrictDensity | null;
  acquireLand: boolean;
  /** A map point the player named or clicked: the district goes near it. */
  target: SpatialPoint2 | null;
  /** The side of the city asked for ("the west side"): a bearing from the city's centre. */
  direction: DistrictDirection | null;
}

export type DistrictDirection = NonNullable<NonNullable<MayorStructuredGoalIntent["scope"]>["direction"]>;
/** x is east and z is north on the map. */
const BEARING: Record<DistrictDirection, SpatialPoint2> = {
  N: { x: 0, z: 1 }, NE: { x: Math.SQRT1_2, z: Math.SQRT1_2 }, E: { x: 1, z: 0 }, SE: { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
  S: { x: 0, z: -1 }, SW: { x: -Math.SQRT1_2, z: -Math.SQRT1_2 }, W: { x: -1, z: 0 }, NW: { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
};
/** A district is "on that side" when its centre lies within this angle of the bearing (a 135 degree sector) and at least this far from the centre. */
export const INTENT_DIRECTION_HALF_ANGLE_DEGREES = 67.5;
export const INTENT_DIRECTION_MINIMUM_METERS = 150;

/** A district counts as "at" the target when its centre is within this distance of it. */
export const INTENT_TARGET_RADIUS_METERS = 700;
/** Distance from the city's centre of mass: infill is inside it, an edge district outside it, a far district well outside. */
export const INTENT_INFILL_MAXIMUM_METERS = 500;
export const INTENT_EDGE_MINIMUM_METERS = 600;
export const INTENT_FAR_MINIMUM_METERS = 1_000;
/** Share of a district's terrain window under water at which it counts as waterfront. */
export const INTENT_WATERFRONT_MINIMUM_WATER_SHARE = 0.02;

const ROLE_OF_TYPE: Partial<Record<MayorStructuredGoalIntent["type"], DistrictRole>> = {
  GROW_POPULATION: "residential",
  EXPAND_RESIDENTIAL: "residential",
  EXPAND_COMMERCIAL: "commercial",
  EXPAND_OFFICE: "commercial",
  EXPAND_INDUSTRIAL: "industrial",
};

/** The builder's view of a structured intent, or null when the intent is not district work. */
export function districtIntentFrom(intent: MayorStructuredGoalIntent | null | undefined, target?: SpatialPoint2 | null): DistrictIntent | null {
  if (!intent || !(intent.type in ROLE_OF_TYPE)) return null;
  const scope = intent.scope ?? {};
  return {
    role: ROLE_OF_TYPE[intent.type] ?? null,
    region: scope.region ?? "ANY",
    density: scope.density ?? null,
    acquireLand: scope.acquireLand === true,
    target: target && Number.isFinite(target.x) && Number.isFinite(target.z) ? { x: target.x, z: target.z } : null,
    direction: scope.direction ?? null,
  };
}

/** Whether the intent names a place at all: a point, or a region other than "wherever the network reaches". */
export function intentNamesAPlace(intent: DistrictIntent): boolean {
  return intent.target !== null || Boolean(intent.direction) || !["ANY", "NEAR_EXISTING"].includes(intent.region);
}

const distance = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Whether a district centred here is where the player asked, judged without a terrain read. Waterfront needs the
 * terrain and is judged by the caller with {@link INTENT_WATERFRONT_MINIMUM_WATER_SHARE}.
 */
export function centreMatchesIntent(centre: SpatialPoint2, intent: DistrictIntent, cityCentre: SpatialPoint2 | null): boolean {
  if (intent.target && distance(centre, intent.target) > INTENT_TARGET_RADIUS_METERS) return false;
  if (!cityCentre) return true;
  const fromCentre = distance(centre, cityCentre);
  if (intent.direction) {
    const bearing = BEARING[intent.direction];
    if (fromCentre < INTENT_DIRECTION_MINIMUM_METERS) return false;
    const cosine = ((centre.x - cityCentre.x) * bearing.x + (centre.z - cityCentre.z) * bearing.z) / fromCentre;
    if (cosine < Math.cos((INTENT_DIRECTION_HALF_ANGLE_DEGREES * Math.PI) / 180)) return false;
  }
  switch (intent.region) {
    case "INFILL": return fromCentre <= INTENT_INFILL_MAXIMUM_METERS;
    case "EDGE": return fromCentre >= INTENT_EDGE_MINIMUM_METERS;
    case "FAR": return fromCentre >= INTENT_FAR_MINIMUM_METERS;
    default: return true;
  }
}

/** Orders candidate centres the way the intent prefers them: nearest the point, else outermost for edge/far, innermost for infill. */
export function intentOrder(intent: DistrictIntent, cityCentre: SpatialPoint2 | null): (a: SpatialPoint2, b: SpatialPoint2) => number {
  if (intent.target) return (a, b) => distance(a, intent.target!) - distance(b, intent.target!);
  if (cityCentre && intent.direction) {
    const bearing = BEARING[intent.direction];
    const along = (point: SpatialPoint2) => (point.x - cityCentre.x) * bearing.x + (point.z - cityCentre.z) * bearing.z;
    return (a, b) => along(b) - along(a);
  }
  if (cityCentre && (intent.region === "EDGE" || intent.region === "FAR")) return (a, b) => distance(b, cityCentre) - distance(a, cityCentre);
  if (cityCentre && intent.region === "INFILL") return (a, b) => distance(a, cityCentre) - distance(b, cityCentre);
  return () => 0;
}

export function centreOf(points: readonly SpatialPoint2[]): SpatialPoint2 | null {
  if (points.length === 0) return null;
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, z: points.reduce((sum, p) => sum + p.z, 0) / points.length };
}

const DENSITY_WORD: Record<DistrictDensity, RegExp> = { LOW: /\blow\b/i, MEDIUM: /\b(medium|row)\b/i, HIGH: /\bhigh\b/i };

/**
 * The unlocked zone of this land use at the asked density, from the planning catalogue's zone types. Null when the
 * catalogue holds none at that density. The caller must report that the requested density is unavailable.
 */
export function zoneForDensity(zoneTypes: unknown, role: ZoneCategory, density: DistrictDensity): string | null {
  if (!Array.isArray(zoneTypes)) return null;
  const area = role === "residential" ? "Residential" : role === "commercial" ? "Commercial" : "Industrial";
  const match = zoneTypes.filter((zone): zone is Record<string, unknown> => !!zone && typeof zone === "object")
    .filter((zone) => zone.areaType === area && (role === "office" ? zone.office === true : zone.office !== true) && zone.locked !== true && typeof zone.name === "string" &&
      !(typeof zone.spawnableBuildingCount === "number" && zone.spawnableBuildingCount <= 0) &&
      DENSITY_WORD[density].test(String(zone.name)));
  // The city's own regional style first (EU zones in this save), then anything unlocked.
  return (match.find((zone) => /^EU /.test(String(zone.name))) ?? match[0])?.name as string | undefined ?? null;
}
