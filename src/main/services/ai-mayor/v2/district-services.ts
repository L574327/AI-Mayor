/**
 * Public services where the icons are: a cemetery where the hearse icons stand, a clinic where the ambulance icons stand.
 *
 * Measured live (2026-10-04, a city of 8,200): 57 hearse icons and 6 ambulance icons hung over the districts, one clinic and no cemetery
 * in the whole city. The old civic path placed one building of each kind ever, read only the first 500 buildings, ran through the
 * durable pipeline, and had no death care at all. This is the local replacement, built the way a player does it: read the icons, put
 * the building near them on a legal lot, read it back. The world is the only authority — nothing here is remembered across a restart,
 * and the game's own object preflight decides what is legal.
 *
 * Space: districts are zoned out to the street, so a service has no lot. Each district therefore leaves one small block unzoned
 * (`reserveSpotIndices`), and the service goes there. If a service is still wanted and no lot is legal anywhere near its icons,
 * the one experiment the user allowed (2026-10-04) is to bulldoze a single low-density home and place the service on its lot —
 * opt-in, once per process, never a building of a service or a park.
 */
import type { SpatialPoint2 } from "../spatial/types";
import { stampElapsed, type GameStamp } from "./game-clock";

export type ServiceNeed = "deathcare" | "healthcare" | "police" | "fire" | "roads" | "garbage" | "education";
export const SERVICE_NEEDS: readonly ServiceNeed[] = ["deathcare", "healthcare", "police", "fire", "roads", "garbage", "education"];

/**
 * Education has no icon: its evidence is the labour market. Jobs for well- and highly-educated workers that stand open while the people who could fill
 * them are not schooled that far (`cs2_labor` jobs.freeByEducation; community guides: "build colleges and universities when high-skill labour is short",
 * and a university before the offices exist only makes unemployed graduates). The count of such open jobs is handed to the care round as notices of this type,
 * one notice for each `EDUCATION_JOBS_PER_NOTICE` open jobs, standing at the heart of the city.
 */
export const EDUCATION_GAP_NOTICE = "Education Gap (labour market)";
export const EDUCATION_JOBS_PER_NOTICE = 10;
/** Open jobs for the educated at which a college is unlocked with development points (and a university once a college stands, at twice this). */
export const EDUCATION_COLLEGE_OPEN_JOBS = 150;
export interface EducationGap {
  /** Open jobs that need a well- or highly-educated worker. */
  openHigh: number;
  /** Open jobs that need a poorly-educated or educated worker. */
  openMiddle: number;
}
export function withEducationGap(reading: IconReading, gap: EducationGap | null, centre: SpatialPoint2 | null): IconReading {
  if (!gap || !centre) return reading;
  const open = gap.openHigh + gap.openMiddle;
  const notices = Math.floor(open / EDUCATION_JOBS_PER_NOTICE);
  if (notices <= 0) return reading;
  return { counts: { ...reading.counts, [EDUCATION_GAP_NOTICE]: notices }, items: [...reading.items, { type: EDUCATION_GAP_NOTICE, x: centre.x, z: centre.z }] };
}

/**
 * Road maintenance has no icon of its own: a worn road is slow (NetCondition wear 0..10; maintenance trucks restore it). Its evidence is the worn
 * stretches the traffic pass finds on jammed corridors (`road-care.ts`), handed to the care round as notices of this type.
 */
export const WORN_ROAD_NOTICE = "Worn Road (traffic pass)";

/**
 * The world's own sign that a citizen is waiting for the service. Police: a crime scene stands where no patrol came in time (cs2 wiki: crime is
 * answered by police coverage). Fire: a burned-down building is where a fire spread unanswered, a burning one is a fire now.
 */
export const SERVICE_EVIDENCE_ICON: Readonly<Record<ServiceNeed, RegExp>> = {
  deathcare: /Hearse/i,
  healthcare: /Ambulance|Sick/i,
  police: /Crime/i,
  fire: /Burned Down|On Fire|Fire Hazard|Building Fire/i,
  roads: /^Worn Road/i,
  garbage: /^Garbage Notification/i,
  education: /^Education Gap/i,
};

/** A building to unlock through the development tree when no building of the need is unlocked (`tech-tree.ts` unlockPrefabs). */
export const SERVICE_UNLOCK_PREFABS: Readonly<Partial<Record<ServiceNeed, readonly string[]>>> = {
  garbage: ["IncinerationPlant01", "RecyclingCenter01"],
  roads: ["RoadMaintenanceDepot01"],
  police: ["PoliceStation01"],
  fire: ["FireHouse01"],
};

/** Unlocked prefabs to try, best first: whole names only (an extension or chapel is not a building of its own). */
export const SERVICE_PREFAB_PREFERENCE: Readonly<Record<ServiceNeed, readonly RegExp[]>> = {
  deathcare: [/^Cemetery01$/, /^Cemetery02$/, /^Crematorium\d+$/],
  healthcare: [/^MedicalClinic02$/, /^MedicalClinic01$/, /^Hospital\d+$/],
  police: [/^PoliceStation01$/, /^PoliceStation02$/, /^PoliceStation03$/, /^PoliceHeadquarters01$/],
  fire: [/^FireStation01$/, /^FireHouse01$/, /^FireHouse02$/],
  roads: [/^RoadMaintenanceDepot01$/],
  // Guides (2026-10-07): a landfill only STORES and fills up; the burn/recycle rate has to stay above what the city makes. Burning and recycling come first,
  // the landfill is the fallback when neither is unlocked.
  // Community guides: a mid-size city runs a MIX (about 2 landfills, 2 recycling centres, 1 incinerator at 37,000 people); the recycling centre is the cheaper
  // and greener one, the incinerator needs to be away from homes (air pollution) but makes power; landfills fill up and are the fallback.
  garbage: [/^RecyclingCenter01$/, /^IncinerationPlant01$/, /^Landfill01$/],
  // The schooling ladder: high school first (the step the first jobs for the educated ask), elementary where none stands, then the college and the university
  // (locked until development points buy them: `#provideServices` buys them only while jobs for the educated stand open).
  education: [/^HighSchool\d+$/, /^ElementarySchool\d+$/, /^College\d+$/, /^University\d+$/],
};

/** The prefab-name searches that find the buildings of a need (the unlocked ones are then picked by `SERVICE_PREFAB_PREFERENCE`). */
export const SERVICE_PREFAB_QUERIES: Readonly<Record<ServiceNeed, readonly string[]>> = {
  deathcare: ["Cemetery", "Crematorium"],
  healthcare: ["MedicalClinic", "Hospital"],
  police: ["PoliceStation", "PoliceHeadquarters"],
  fire: ["FireStation", "FireHouse"],
  roads: ["RoadMaintenance"],
  garbage: ["Incinerat", "Recycl", "Landfill"],
  education: ["HighSchool", "ElementarySchool", "College", "University"],
};

/**
 * Starting figures, not rules: people per building of each kind, so a city is never given a dozen of them for one stubborn icon.
 * The icons themselves decide whether another is wanted (they must still be there after the last one has had time to work).
 */
export const SERVICE_POPULATION_PER_BUILDING: Readonly<Record<ServiceNeed, number>> = { deathcare: 4_000, healthcare: 2_500, police: 4_000, fire: 4_000, roads: 8_000, garbage: 10_000, education: 5_000 };
/** Cycles to wait after placing one before judging whether the icons went. */
export const SERVICE_COOLDOWN_CYCLES = 3;
/** The same cooldown in game hours (`game-clock.ts`); the cycle count is the fallback when the game clock cannot be read. */
export const SERVICE_COOLDOWN_HOURS = 3;
/** How long a refused placement is remembered, in game hours (the cycle count `ttlCycles` is the fallback). */
export const REFUSED_PLACEMENT_TTL_HOURS = 72;
/** Icon count at or below which a service is not worth a building (a stray icon). */
export const SERVICE_MINIMUM_ICONS = 3;
/**
 * Icons that stay up this long after the building the population justified stand are the world saying that building is not enough (or does not
 * work): live 2026-10-06, 22 hearse icons for 11 game hours beside "1 building, as many as 3,160 people justify". The evidence outranks the figure.
 */
export const SERVICE_STUCK_HOURS = 8;
export const SERVICE_STUCK_CYCLES = 40;
/** While stuck, a refused spot is asked again after this many game hours, and at most this many times the justified buildings stand. */
export const SERVICE_STUCK_REFUSAL_HOURS = 12;
export const SERVICE_STUCK_MAXIMUM_MULTIPLE = 3;

/** How many buildings of a kind may stand: the figure the city's size justifies, one more at a time while the icons are stuck, never past a multiple of it. */
export function serviceLimit(cap: number, standing: number, stuck: boolean): number {
  return stuck ? Math.min(cap * SERVICE_STUCK_MAXIMUM_MULTIPLE, Math.max(cap, standing + 1)) : cap;
}

export interface IconReading {
  counts: Record<string, number>;
  /** Each notice, where the game hangs it and, when it names one, the building it is about. */
  items: Array<{ type: string; x: number; z: number; entity?: { index: number; version: number }; prefab?: string }>;
}

/**
 * Icons that hang outside the land the city owns (live 2026-10-06: ~2200 "Fire Notification" icons on wild trees 4.7 km past the last owned tile) are not
 * the city's problem to build for: nothing can be placed there without buying a chain of tiles first. They are taken out of the reading and counted
 * apart; the player naming the problem (and the cash carrying it) keeps them in, so the choice is never hard-wired. A reading lists only the first
 * notices of a type, so a type whose listed notices ALL lie outside is taken out whole, otherwise by the share of its listed notices that do.
 */
export function splitOutsideOwnedLand(reading: IconReading, isOwned: (point: SpatialPoint2) => boolean): { inside: IconReading; outside: Record<string, number> } {
  const listed = new Map<string, { all: number; outside: number }>();
  const keep: IconReading["items"] = [];
  for (const item of reading.items) {
    const entry = listed.get(item.type) ?? { all: 0, outside: 0 };
    entry.all += 1;
    if (!isOwned({ x: item.x, z: item.z })) entry.outside += 1; else keep.push(item);
    listed.set(item.type, entry);
  }
  const counts: Record<string, number> = { ...reading.counts };
  const outside: Record<string, number> = {};
  for (const [type, entry] of listed) {
    if (entry.outside === 0) continue;
    const total = Number(reading.counts[type]) || entry.all;
    const away = entry.outside === entry.all ? total : Math.min(total, Math.round(total * (entry.outside / entry.all)));
    outside[type] = away;
    counts[type] = Math.max(0, total - away);
  }
  return { inside: { counts, items: keep }, outside };
}

/** The icon reading with the worn stretches the traffic pass found added as notices of their own (road maintenance's evidence). */
export function withWornRoads(reading: IconReading, worn: readonly SpatialPoint2[]): IconReading {
  if (worn.length === 0) return reading;
  return { counts: { ...reading.counts, [WORN_ROAD_NOTICE]: worn.length }, items: [...reading.items, ...worn.map((point) => ({ type: WORN_ROAD_NOTICE, x: point.x, z: point.z }))] };
}

export function iconCount(reading: IconReading, need: ServiceNeed): number {
  return Object.entries(reading.counts).reduce((sum, [type, count]) => sum + (SERVICE_EVIDENCE_ICON[need].test(type) ? Number(count) || 0 : 0), 0);
}

/** How many buildings of a kind the city's size justifies. */
export function serviceCap(need: ServiceNeed, population: number | null): number {
  return Math.max(1, Math.ceil((population ?? 0) / SERVICE_POPULATION_PER_BUILDING[need]));
}

/** The services whose icons are up, most icons first. */
export function servicesWanted(reading: IconReading): Array<{ need: ServiceNeed; icons: number }> {
  return SERVICE_NEEDS.map((need) => ({ need, icons: iconCount(reading, need) })).filter((entry) => entry.icons >= SERVICE_MINIMUM_ICONS)
    .sort((left, right) => right.icons - left.icons);
}

/** Where the icons are thickest: the icon with the most others within `radius`, so the building serves a crowd, not one corner. */
export function densestIcon(items: ReadonlyArray<{ x: number; z: number }>, radius = 300): SpatialPoint2 | null {
  let best: { point: SpatialPoint2; near: number } | null = null;
  for (const item of items) {
    const near = items.filter((other) => Math.hypot(other.x - item.x, other.z - item.z) <= radius).length;
    if (!best || near > best.near) best = { point: { x: item.x, z: item.z }, near };
  }
  return best?.point ?? null;
}

/**
 * Where the icons gather: greedy clusters of icons within `radius` of a cluster's first (thickest-first) member, biggest first. Used only to choose WHERE the
 * one wanted building is looked for — a miss at one cluster moves the next look to the next cluster; it never makes a building per cluster.
 */
export function iconClusters(items: ReadonlyArray<{ x: number; z: number }>, radius = 400): Array<{ center: SpatialPoint2; size: number }> {
  const left = items.map((item) => ({ x: item.x, z: item.z }));
  const clusters: Array<{ center: SpatialPoint2; size: number }> = [];
  while (left.length > 0) {
    let best = 0; let bestSize = -1;
    for (let index = 0; index < left.length; index += 1) {
      const size = left.filter((other) => Math.hypot(other.x - left[index]!.x, other.z - left[index]!.z) <= radius).length;
      if (size > bestSize) { best = index; bestSize = size; }
    }
    const seed = left[best]!;
    const members = left.filter((other) => Math.hypot(other.x - seed.x, other.z - seed.z) <= radius);
    clusters.push({ center: { x: members.reduce((sum, m) => sum + m.x, 0) / members.length, z: members.reduce((sum, m) => sum + m.z, 0) / members.length }, size: members.length });
    for (let index = left.length - 1; index >= 0; index -= 1) if (Math.hypot(left[index]!.x - seed.x, left[index]!.z - seed.z) <= radius) left.splice(index, 1);
  }
  return clusters;
}

export interface ReservableSpot { center: SpatialPoint2; onRing: boolean }

/** A district this small holds no reserved lot: its homes and shops are the point of it. */
export const MINIMUM_SPOTS_FOR_RESERVED_LOT = 24;

/**
 * Indices of the zoning spots to leave unpainted: a 2×2 block (four spots 40 m apart leave about a 48 m open patch once their
 * neighbours' brushes are counted), chosen on the ring street so the lot has a street to face. None for a small district.
 */
export function reserveSpotIndices(spots: readonly ReservableSpot[]): number[] {
  if (spots.length < MINIMUM_SPOTS_FOR_RESERVED_LOT) return [];
  const start = spots.findIndex((spot) => spot.onRing);
  if (start < 0) return [];
  const anchor = spots[start]!.center;
  const nearest = spots.map((spot, index) => ({ index, distance: Math.hypot(spot.center.x - anchor.x, spot.center.z - anchor.z) }))
    .filter((entry) => entry.distance < 70).sort((left, right) => left.distance - right.distance).slice(0, 4);
  return nearest.length === 4 ? nearest.map((entry) => entry.index) : [];
}

/** The centre and clear radius of a reserved lot, from the spots left unpainted. */
export function reservedLotOf(spots: readonly ReservableSpot[], indices: readonly number[]): { center: SpatialPoint2; radius: number } | null {
  if (indices.length === 0) return null;
  const points = indices.map((index) => spots[index]!.center);
  return { center: { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, z: points.reduce((sum, p) => sum + p.z, 0) / points.length }, radius: 52 };
}

/**
 * Placements the game refused, remembered for a while so the next pass does not try the same spot again (the player would see it
 * flash every cycle). It only SKIPS candidates that were already refused: it never allows one, never reads as a fact about the world
 * beyond `ttlCycles` (buildings spawn, lots change), and is dropped on a rebaseline. This is the placement side of the Adaptive
 * Execution Memory seam (`execution-telemetry.ts`).
 */
export class RefusedPlacements {
  readonly #refusedAt = new Map<string, GameStamp>();
  constructor(private readonly ttlCycles = 20, private readonly cellMeters = 8, private readonly ttlHours = REFUSED_PLACEMENT_TTL_HOURS) {}
  #key(prefab: string, point: SpatialPoint2): string { return `${prefab}@${Math.round(point.x / this.cellMeters)},${Math.round(point.z / this.cellMeters)}`; }
  /**
   * `when` is the city's time (`game-clock.ts`); a bare number is a cycle count with no readable clock. A refusal stands for `ttlHours` game hours,
   * or `ttlCycles` cycles when either side has no frame.
   */
  refused(prefab: string, point: SpatialPoint2, when: GameStamp | number, shorterHours?: number): boolean {
    const at = this.#refusedAt.get(this.#key(prefab, point));
    if (!at) return false;
    // `ttlCycles + 1`: it was refused while `cycle <= remembered + ttl`, so it is free again the cycle after.
    // `shorterHours`: a service whose icons have stood for hours asks again sooner (buildings spawn and lots change; 72 h was held against it for 100 spots).
    return !stampElapsed(at, typeof when === "number" ? { frame: null, cycle: when } : when, shorterHours === undefined ? this.ttlHours : Math.min(this.ttlHours, shorterHours), this.ttlCycles + 1);
  }
  remember(prefab: string, point: SpatialPoint2, when: GameStamp | number): void {
    this.#refusedAt.set(this.#key(prefab, point), typeof when === "number" ? { frame: null, cycle: when } : when);
  }
  clear(): void { this.#refusedAt.clear(); }
  get size(): number { return this.#refusedAt.size; }
}

/** The unlocked prefabs to try for a need, in preference order, from the names the world offers. */
export function servicePrefabs(need: ServiceNeed, unlocked: readonly string[]): string[] {
  const found: string[] = [];
  for (const pattern of SERVICE_PREFAB_PREFERENCE[need]) for (const name of unlocked) if (pattern.test(name) && !found.includes(name)) found.push(name);
  return found;
}

/**
 * How many of each garbage building a city of this size justifies (community guides: a 37,000-person city ran 2 landfills, 2 recycling centres, 1 incinerator).
 * A burning plant is huge and costs a fortune: one per 25,000; a recycling centre one per 15,000 (the guide's city ran 1 + 2 at 37,000 beside its landfills, which fill and then count for nothing); a landfill fills up and is a stopgap: two at most.
 */
export function garbageBuildingCap(prefab: string, population: number | null): number {
  const people = population ?? 0;
  if (/Incinerat/i.test(prefab)) return Math.max(1, Math.ceil(people / 25_000));
  if (/Recycl/i.test(prefab)) return Math.max(1, Math.ceil(people / 15_000));
  return 2;
}