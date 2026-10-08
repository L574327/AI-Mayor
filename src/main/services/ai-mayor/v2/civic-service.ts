import type { SpatialPoint2, SpatialRoadEdge } from "../spatial/types";

/**
 * Civic services: the public buildings a city needs beyond water, power and sewage.
 *
 * A civic placement is executed and reconciled exactly like a utility facility placement — one durable
 * `place_building` command under `actionFamily: "UTILITY"`, `utilityKind: "civic"`, read back by the same
 * prefab-at-position building listing — so nothing here touches the journal, authorization or readback. This
 * module only answers WHICH service is owed and WHERE a building could stand facing a street.
 */
export const CIVIC_SERVICE_KINDS = ["healthcare", "education", "garbage", "fire", "police"] as const;
export type CivicServiceKind = (typeof CIVIC_SERVICE_KINDS)[number];

/**
 * The population at which a city first owes each service. Population is only a stand-in for evidence (the Bible says to
 * place a service from a measured deficit, and this product has no coverage read yet), so the thresholds are set where a
 * building stops being pure upkeep: measured live, one clinic cost 51k a month in a city of 145 people. One building of
 * each kind, no earlier than that. Coverage beyond the first building is a later
 * question that needs a coverage read this product does not have yet.
 */
export const CIVIC_FIRST_BUILDING_POPULATION: Readonly<Record<CivicServiceKind, number>> = {
  healthcare: 1_500,
  education: 1_000,
  garbage: 400,
  fire: 1_500,
  police: 2_000,
};

/**
 * The world's own sign that a service is wanted: an in-game warning icon of a matching type. Population says a city could
 * use a building, an icon says a citizen is waiting for one (Bible POL-SERVICE: never place a service from a population
 * threshold alone). Measured live: a fire station is 75.9k a month and a school 35k in a city of 2,500 earning 290k.
 */
export const CIVIC_EVIDENCE_ICON: Readonly<Record<CivicServiceKind, RegExp>> = {
  healthcare: /Medical|Sick|Health|Disease|Ambulance/i,
  education: /Education|School|Student/i,
  garbage: /Garbage|Trash|Landfill/i,
  fire: /Fire/i,
  police: /Crime|Police/i,
};

/** The services among `owed` that an active icon asks for. */
export function civicServicesWithEvidence(owed: readonly CivicServiceKind[], iconCounts: Readonly<Record<string, number>>): CivicServiceKind[] {
  return owed.filter((kind) => Object.entries(iconCounts).some(([type, count]) => count > 0 && CIVIC_EVIDENCE_ICON[kind].test(type)));
}

/** Prefab-name patterns that identify an existing building of each kind (sub-buildings and extensions excluded). */
const CIVIC_PREFAB_PATTERN: Readonly<Record<CivicServiceKind, RegExp>> = {
  healthcare: /^(MedicalClinic\d+|Hospital\d+)$/,
  education: /^(ElementarySchool\d+|HighSchool\d+)$/,
  garbage: /^(Landfill\d+|RecyclingCenter\d+|Incinerator\w*)$/,
  fire: /^(FireHouse\d+|FireStation\d+)$/,
  police: /^(PoliceStation\d+)$/,
};

/** Preferred unlocked prefab per kind: the smallest first-tier building of the kind. */
const CIVIC_PREFAB_PREFERENCE: Readonly<Record<CivicServiceKind, readonly RegExp[]>> = {
  healthcare: [/^MedicalClinic01$/, /^MedicalClinic\d+$/],
  education: [/^ElementarySchool01$/, /^ElementarySchool\d+$/],
  garbage: [/^Landfill01$/, /^Landfill\d+$/],
  fire: [/^FireHouse01$/, /^FireHouse\d+$/],
  police: [/^PoliceStation01$/, /^PoliceStation\d+$/],
};

export function civicKindOfPrefab(prefab: string): CivicServiceKind | null {
  return CIVIC_SERVICE_KINDS.find((kind) => CIVIC_PREFAB_PATTERN[kind].test(prefab)) ?? null;
}

/** The unlocked prefab this city would place for a kind, or null when none of its patterns is offered. */
export function civicPrefabFor(kind: CivicServiceKind, unlockedPrefabs: readonly string[]): string | null {
  for (const pattern of CIVIC_PREFAB_PREFERENCE[kind]) {
    const found = unlockedPrefabs.find((name) => pattern.test(name));
    if (found) return found;
  }
  return null;
}

/** The services this city owes now, in order: population has reached the threshold and none exists. */
export function civicServicesOwed(input: {
  population: number | null;
  existingPrefabs: readonly string[];
}): CivicServiceKind[] {
  if (input.population === null) return [];
  const present = new Set(input.existingPrefabs.map(civicKindOfPrefab).filter((kind): kind is CivicServiceKind => kind !== null));
  return CIVIC_SERVICE_KINDS.filter((kind) =>
    !present.has(kind) && input.population! >= CIVIC_FIRST_BUILDING_POPULATION[kind]);
}

/**
 * How far from a street's centreline a civic building's centre is tried. The object preflight decides which are
 * legal; the spread covers small (clinic, fire house) to larger (school, landfill) lots.
 */
export const CIVIC_SETBACKS_METERS: readonly number[] = [18, 22, 28, 36, 46];

/** How many times native may refuse a preflight-valid site in one call before the call gives up for this cycle. */
export const CIVIC_MAXIMUM_NATIVE_REJECTIONS = 3;

export type CivicServiceOutcome =
  | { status: "SKIPPED"; reason: string; population?: number | null }
  | { status: "NOTHING_OWED"; population: number | null }
  | { status: "NO_PLACEMENT"; population: number | null; refusals: string[] }
  | {
    status: "PLACED"; kind: CivicServiceKind; prefab: string; position: SpatialPoint2; rotation: number;
    setbackMeters: number; commandId: string; verdict: string; population: number | null; refusals: string[];
  };

export interface CivicSiteCandidate {
  position: SpatialPoint2;
  /** CS2 yaw in degrees: 0 faces world +Z, positive turns toward +X. The building faces the street. */
  rotation: number;
  /** The street point the building's front faces. */
  street: SpatialPoint2;
  setbackMeters: number;
}

/** Yaw that makes a building at `from` face `to` (same convention as the utility planner). */
export function civicRotationToward(from: SpatialPoint2, to: SpatialPoint2): number {
  const degrees = (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/**
 * Where a civic building could stand facing a street: on both sides of each straight street near the target, set
 * back from the centreline by each of `setbacksMeters`, facing the street. Nearest the target first. Legality is
 * NOT decided here — every candidate still goes through the native object preflight before anything is placed.
 */
export function civicSiteCandidates(input: {
  target: SpatialPoint2;
  edges: readonly SpatialRoadEdge[];
  setbacksMeters: readonly number[];
  maximumDistanceMeters?: number;
  maximumCandidates?: number;
}): CivicSiteCandidate[] {
  const reach = input.maximumDistanceMeters ?? 400;
  const candidates: Array<CivicSiteCandidate & { distance: number }> = [];
  for (const edge of input.edges) {
    if (edge.deleted || edge.temp || /highway|pipe|cable|sewer|power/i.test(edge.prefab)) continue;
    const dx = edge.end.x - edge.start.x;
    const dz = edge.end.z - edge.start.z;
    const length = Math.hypot(dx, dz);
    if (!(length >= 30)) continue;
    const normal = { x: -dz / length, z: dx / length };
    // Along the street, away from both ends: the door faces the street's side, never its end or a junction.
    for (const along of [0.5, 0.3, 0.7]) {
      const street = { x: edge.start.x + dx * along, z: edge.start.z + dz * along };
      if (Math.hypot(street.x - input.target.x, street.z - input.target.z) > reach) continue;
      for (const side of [1, -1]) {
        for (const setback of input.setbacksMeters) {
          const position = { x: street.x + normal.x * side * setback, z: street.z + normal.z * side * setback };
          candidates.push({ position, street, setbackMeters: setback, rotation: civicRotationToward(position, street),
            distance: Math.hypot(position.x - input.target.x, position.z - input.target.z) });
        }
      }
    }
  }
  return candidates
    .sort((left, right) => left.distance - right.distance || left.setbackMeters - right.setbackMeters ||
      left.position.x - right.position.x || left.position.z - right.position.z)
    .slice(0, input.maximumCandidates ?? 48)
    .map(({ distance: _distance, ...candidate }) => candidate);
}
