import type { SpatialLocalTerrain, SpatialPoint2, SpatialRoadEdge } from "../spatial/types";
import { CIVIC_MAXIMUM_NATIVE_REJECTIONS, civicSiteCandidates, type CivicSiteCandidate } from "./civic-service";
import { RefusedPlacements } from "./district-services";
import type { GameStamp } from "./game-clock";
import { isHighValueFacility } from "./high-value-guard";
import { pumpSiteSafe, selectCertifiedOutfalls, type PumpGuard, type WaterSafety } from "./water-safety-siting";
import { facilityPlacementClearance } from "./facility-placement-clearance";
import { PLANT_MINIMUM_HOME_DISTANCE_METERS, PLANT_REACH_METERS, plantSiteAllowed, plantSiteScore, prevailingWind } from "./power-siting";

/**
 * Water, power and sewage for a district, decided where the district is built — the way a player does it.
 *
 * A player lays a district, looks at the utility panel, and drops a pump or a turbine beside a street of the connected
 * network when the new homes would not be carried. Services travel along a connected street component (the facility's
 * Marker attaches to the street beside it), so the facility goes on the SAME component the district joined.
 *
 * The world is the authority: the load comes from the city's own consumption per building, the legal site from the
 * game's own object preflight, and the result is read back from the facility's connectors (an `orphan` facility
 * carries nothing and is reported, not counted). Nothing here is durable.
 */
export type DistrictUtilityKind = "electricity" | "water" | "sewage";

export const DISTRICT_UTILITY_KINDS: readonly DistrictUtilityKind[] = ["electricity", "water", "sewage"];

/** Thermal power plants (fuel-burning), as opposed to turbines. */
export const THERMAL_PLANT = /^(Small)?(Coal|Gas)PowerPlant\d+$/;
export const PLANT_FOOTPRINT_RADIUS_METERS = 60;
/** What a thermal plant draws from the water network (live 2026-10-08: SmallCoalPowerPlant01 put the city's use from 51,000 to 66,000 when placed). */
export const THERMAL_PLANT_WATER_UNITS = 16_000;
/** The sewage treatment plant: sited like a plant, not like an outlet. */
export const TREATMENT_PLANT = /^WastewaterTreatmentPlant\d+$/;
/**
 * A plant is wide: its centre stands back from the street, and a cable closes the rest. The closest setbacks come first so the plant's front meets the
 * street (live 2026-10-07: a coal plant set 90 m back had its front 30 m off the street, its own road was blocked by water, and it stood without a road);
 * the game's object preflight refuses the ones that overlap the street, and a far one has its access road dry-run before it is placed.
 */
/**
 * The player's rule (2026-10-08, seen in the game): a plant's door either touches the street, or stands a whole road's corridor off it — never between
 * (live: a coal plant 90 m back had its doors 30 m off a Medium Road: too far to touch, too near for a road along its front, and the only road the Mayor
 * could lay was an 18 m spike). With the plant's half depth ~60 m (SmallCoalPowerPlant01's doors 59.8 m from its centre): "touching" is half depth + the
 * street's half width + a little (68-78 m), "a corridor" leaves room for a Small Road beside the street (100 m and on). 80-99 m is never offered.
 */
export const PLANT_SETBACKS_METERS: readonly number[] = [68, 71, 74, 78, 100, 108, 130, 160];

export const DISTRICT_UTILITY_FACILITY: Record<DistrictUtilityKind, { prefab: string; footprintRadiusMeters: number }> = {
  electricity: { prefab: "WindTurbine03", footprintRadiusMeters: 14 },
  water: { prefab: "GroundwaterPumpingStation01", footprintRadiusMeters: 22 },
  sewage: { prefab: "SewageOutlet01", footprintRadiusMeters: 20 },
};

/** A zoned lot is about this many 8 m cells (4x3 to 5x6); a district's roads and verges take the rest of its area. */
export const DISTRICT_CELLS_PER_BUILDING = 18;
export const DISTRICT_ZONED_AREA_SHARE = 0.6;
export const DISTRICT_ZONE_CELL_AREA_SQUARE_METERS = 64;
/**
 * Setback from the street's centreline, nearest first. A facility's Marker attaches only to a net edge beside it:
 * measured live (2026-10-03) a turbine 50 m from a street read `attached:false` with 0 edges, and the same turbine read
 * `attached:true, edges:1` after a 50 m Low-voltage Ground Cable was laid from it to the street. So the lot is as close
 * to the street as its footprint allows, and whatever distance is left is closed with a connection of the kind's net.
 */
export const DISTRICT_UTILITY_SETBACKS_METERS: Record<DistrictUtilityKind, readonly number[]> = {
  electricity: [12, 16, 20, 26, 36, 50],
  water: [22, 26, 30, 36, 50],
  sewage: [20, 24, 30, 36, 50],
};
/**
 * Which of a facility's connectors the connection is laid FROM. A coal plant lists a High-voltage Marker FIRST and two Low-voltage Markers after it; the
 * product laid its Low-voltage Ground Cable from the first electricity connector, i.e. from the high-voltage one, which no low-voltage cable can join: the
 * cable read back unattached three times in a row and each plant was taken down (live 2026-10-06, run #21 and 2026-10-04). The cable is low voltage, so a
 * low-voltage connector is the one it starts from; the high-voltage marker is only chosen when the plant has no other electricity connector.
 */
export function connectorForNet(connectors: ReadonlyArray<Record<string, unknown>>, kind: DistrictUtilityKind): Record<string, unknown> | undefined {
  if (kind !== "electricity") return connectors[0];
  const electric = connectors.filter((entry) => /electric/i.test(String(entry.type)));
  return electric.find((entry) => /^low$/i.test(String(entry.voltage)) || /Low-voltage/i.test(String(entry.prefab))) ?? electric[0] ?? connectors[0];
}

/** The net a connection from the facility to its street is laid with. */
/**
 * Pipes and cables are laid UNDERGROUND (a negative course elevation), as the game's own underground mode does. At elevation 0 the Bridge lays
 * them on the surface and the terrain rises over them — measured live 2026-10-04 (terrain across the line, metres: 511.95, 513.92, 517.45, 513.31,
 * 511.95 for a pipe; 511.49, 513.87, 518.90, 512.81, 511.10 for a cable; flat at -8) — which then keeps a road from being built on the same line.
 * Laid at -8 the water tower beside it joined the network (fresh capacity +10,000).
 */
export const BURIED_NET_ELEVATION_METERS = -8;

export const DISTRICT_UTILITY_CONNECTION_PREFAB: Record<DistrictUtilityKind, string> = {
  electricity: "Low-voltage Ground Cable",
  water: "Small Water Pipe",
  sewage: "Small Sewage Pipe",
};
/** Placements tried per utility before the call gives up: each one that reads back unattached is removed. */
export const DISTRICT_UTILITY_MAXIMUM_PLACEMENTS = 3;
/** Preflights one facility search may ask (each shows a ghost building in the game): 30, not 60 — a site the game refused is remembered for 72 game hours. */
export const DISTRICT_UTILITY_MAXIMUM_PREFLIGHTS = 30;
/** Prefabs tried, best first, before a utility is reported as having no legal site. */
export const DISTRICT_UTILITY_MAXIMUM_PREFABS = 3;
/** Placement checks in a row the Bridge may leave unanswered (busy) before a search for a site stops: the next spot would meet the same wall. */
export const PREFLIGHT_NO_ANSWER_LIMIT = 3;
/** Surface-pump lots kept after the water-safety rules, and lots looked at to find them (each test walks the plume of every outlet). */
export const PUMP_SAFE_SITES_KEPT = 60;
export const PUMP_SITES_EXAMINED = 200;
/** Offsets (m) probed around a surface-pump site for open water: eight directions at two distances. */
export const SHORE_PROBES: ReadonlyArray<readonly [number, number]> = [30, 60].flatMap((meters) => [[meters, 0], [-meters, 0], [0, meters], [0, -meters],
  [meters * 0.7, meters * 0.7], [-meters * 0.7, meters * 0.7], [meters * 0.7, -meters * 0.7], [-meters * 0.7, -meters * 0.7]] as Array<readonly [number, number]>);
/** A facility lot keeps this far past its own footprint from any zoned cell or building. */
export const AVOID_MARGIN_METERS = 6;

/**
 * The point of the nearest street to a place, and how far it is: the road contact of an access road. The road itself, and its bounded ladder of
 * attempts, are the product's existing `facility-access-road.ts` (the zero rung is the plain road, the other rungs are the same road moved sideways);
 * the district builder asks it for courses when the game puts "No Road Access" in front of a building.
 */
export function nearestStreetPoint(from: SpatialPoint2, edges: readonly SpatialRoadEdge[]): { point: SpatialPoint2; distance: number } | null {
  let best: { point: SpatialPoint2; distance: number } | null = null;
  for (const edge of edges) {
    if (edge.deleted || edge.temp) continue;
    const dx = edge.end.x - edge.start.x;
    const dz = edge.end.z - edge.start.z;
    const lengthSquared = dx * dx + dz * dz;
    const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((from.x - edge.start.x) * dx + (from.z - edge.start.z) * dz) / lengthSquared)) : 0;
    const point = { x: edge.start.x + dx * ratio, z: edge.start.z + dz * ratio };
    const distance = Math.hypot(point.x - from.x, point.z - from.z);
    if (!best || distance < best.distance) best = { point, distance };
  }
  return best;
}

/** Distance from a point to the nearest water in the terrain read (open water deeper than 0.3 m); null when no terrain or no water in it. */
export function distanceToWater(terrain: SpatialLocalTerrain | undefined, point: SpatialPoint2): number | null {
  if (!terrain || terrain.resolution <= 0) return null;
  const width = terrain.bounds.maxX - terrain.bounds.minX;
  const depth = terrain.bounds.maxZ - terrain.bounds.minZ;
  if (!(width > 0) || !(depth > 0)) return null;
  let nearest = Infinity;
  const halfCellX = width / terrain.resolution / 2;
  const halfCellZ = depth / terrain.resolution / 2;
  for (let row = 0; row < terrain.resolution; row += 1) {
    for (let column = 0; column < terrain.resolution; column += 1) {
      if ((terrain.waterDepths[row * terrain.resolution + column] ?? 0) <= 0.3) continue;
      const centreX = terrain.bounds.minX + ((column + 0.5) / terrain.resolution) * width;
      const centreZ = terrain.bounds.minZ + ((row + 0.5) / terrain.resolution) * depth;
      // To the edge of the water cell, not its centre: a coarse grid would otherwise put the shore half a cell away.
      const distance = Math.hypot(Math.max(Math.abs(centreX - point.x) - halfCellX, 0), Math.max(Math.abs(centreZ - point.z) - halfCellZ, 0));
      if (distance < nearest) nearest = distance;
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
}
export const DISTRICT_UTILITY_REACH_METERS = 520;
/**
 * An outlet stands by open water, and the water is seldom within 60 m of a street: the lots 20-50 m from a street were all inland on maps whose streets
 * run a block or two from the shore (live 2026-10-05: no lot in 30 had water near it, the city got no sewage outlet at all). With the flow read, the outlet
 * is also offered on shore lots this far from a street (only the ones beside open water survive `selectCertifiedOutfalls`); the pipe is laid to the street
 * afterwards, as it is for a plant, and a lot whose pipe does not read back attached is taken down again.
 */
export const SEWAGE_SHORE_SETBACKS_METERS: readonly number[] = [70, 100, 140, 190, 250, 320];
/** Terrain window for the groundwater read, which also bounds how far a pump may stand from the district. */
export const DISTRICT_WATER_REACH_METERS = 1_000;

export interface DistrictUtilityReading {
  /** Capacity minus consumption, as the city reports it. Null when the city did not report. */
  headroom: number | null;
  /** Consumption that is not being delivered although supply exists (stranded load, e.g. an unconnected pump). */
  undelivered?: number;
  consumption: number | null;
}

export type DistrictUtilityReadings = Record<DistrictUtilityKind, DistrictUtilityReading>;

/** Zoned cells a district of this size holds once its streets are laid. */
export function districtZonedCells(widthMeters: number, heightMeters: number): number {
  return Math.round((widthMeters * heightMeters * DISTRICT_ZONED_AREA_SHARE) / DISTRICT_ZONE_CELL_AREA_SQUARE_METERS);
}

/**
 * The load a district adds once it is built, from what the city's own buildings consume today. Zero when the city has
 * no consumption or no buildings to scale from: nothing is invented.
 */
export function projectDistrictLoad(input: { zonedCells: number; buildingCount: number; consumption: number | null }): number {
  if (!input.consumption || input.consumption <= 0 || input.buildingCount <= 0) return 0;
  return (input.consumption / input.buildingCount) * (input.zonedCells / DISTRICT_CELLS_PER_BUILDING);
}

/**
 * P7 of the V2 candidate: capacity should stand at least this multiple of the peak load ⟨1.2–1.3⟩, because a shortage hits companies and
 * keeps residents away while a surplus is cheap to absorb. FAST_EXPANSION passes it; the other modes keep the bare load (factor 1).
 */
export const UTILITY_HEADROOM_FACTOR = 1.25;

/**
 * What a utility is short by if the district's projected load arrives: the load beyond the headroom the city really has. With a
 * `headroomFactor` above 1 the target is capacity >= (consumption + projected load) x factor, so the margin is part of the shortfall.
 */
export function districtUtilityShortfall(reading: DistrictUtilityReading, projectedLoad: number, headroomFactor = 1): number {
  if (reading.headroom === null) return 0;
  const spare = Math.max(0, reading.headroom + (reading.undelivered ?? 0));
  const margin = headroomFactor > 1 && reading.consumption !== null && reading.consumption > 0
    ? (headroomFactor - 1) * (reading.consumption + projectedLoad) : 0;
  return Math.max(0, projectedLoad + margin - spare);
}

/** A generator the world offers, from the spatial scan's `bootstrapAssets` (what each produces, costs, and whether it is unlocked). */
export interface PowerAsset {
  prefab: string;
  locked: boolean;
  /** Output (the game's unit) for a dispatchable plant, or the nameplate output of a wind turbine; 0 for neither. */
  production: number;
  constructionCost: number;
  /** Burns fuel that has to be trucked in: its output is not certain until read back. */
  needsFuel: boolean;
}

/** Add-ons and storage that are not generators in their own right. */
export const NOT_A_GENERATOR = /Extension|Extra|Storage|Backup Battery|Transformer|Additional|Diesel Generator|EmergencyBattery/i;

/**
 * Every unlocked generator, best first: output per unit of construction cost. This replaces a wind-only list (P7): coal, gas, hydro,
 * solar, geothermal and nuclear are candidates the moment the game unlocks them. The candidate ranks by monthly cost per MW including
 * export income; the Bridge reports neither maintenance nor export price yet (experiment E6), so construction cost is the stand-in and
 * the fuel flag is carried so a plant that burns trucked fuel is not trusted before its output is read back. A source with no readable
 * output (hydro, solar here) is kept at the end, not dropped: it is a capability, ranked on nothing.
 */
export function rankPowerSources(assets: readonly PowerAsset[], options: {
  /** Measured output of the city's wind turbines over their nameplate (0–1); null: not measured, nameplate is used. */
  windCapacityFactor?: number | null;
  /** Sources already shown not to deliver (a fuel plant whose output never appeared): kept last, not offered first again. */
  undelivering?: ReadonlySet<string>;
  /**
   * The output the city is short of (with its margin). A source whose real output covers it in ONE placement comes before any that does
   * not: measured live (2026-10-04), the three wind sizes held the three places the placement tries, the largest found no site, and a
   * 20,000-output turbine was put against a 69,000 shortage — then waited three cycles to be judged. Among sources that cover it, cheapest
   * per output first; among those that do not, the biggest first (fewest placements).
   */
  neededOutput?: number | null;
} = {}): PowerAsset[] {
  const wind = options.windCapacityFactor !== undefined && options.windCapacityFactor !== null && options.windCapacityFactor > 0
    ? Math.min(1, options.windCapacityFactor) : 1;
  const generators = assets.filter((asset) => !asset.locked && !NOT_A_GENERATOR.test(asset.prefab));
  // A wind turbine delivers what the wind gives, not its nameplate: a measured factor derates it, which is what makes a plant that
  // burns fuel the better answer to a city whose turbines are already running short.
  const effective = (asset: PowerAsset) => asset.production * (/WindTurbine/i.test(asset.prefab) ? wind : 1);
  const score = (asset: PowerAsset) => asset.production > 0 ? effective(asset) / Math.max(1, asset.constructionCost) : -1;
  const needed = typeof options.neededOutput === "number" && options.neededOutput > 0 ? options.neededOutput : null;
  // 0 covers the need in one placement (or no need was named), 1 does not, 2 is shown not to deliver.
  const tier = (asset: PowerAsset) => options.undelivering?.has(asset.prefab) ? 2 : needed === null || effective(asset) >= needed ? 0 : 1;
  return [...generators].sort((left, right) => tier(left) - tier(right)
    || (tier(left) === 1 ? effective(right) - effective(left) : 0) || score(right) - score(left) || left.prefab.localeCompare(right.prefab));
}

/** Terrain values at a point, or null outside the read. */
export function terrainSampleAt(terrain: SpatialLocalTerrain | undefined, point: SpatialPoint2):
  { groundWater: number; groundWaterPollution: number; waterDepth: number } | null {
  if (!terrain || terrain.resolution <= 0) return null;
  const width = terrain.bounds.maxX - terrain.bounds.minX;
  const depth = terrain.bounds.maxZ - terrain.bounds.minZ;
  if (!(width > 0) || !(depth > 0)) return null;
  const column = Math.floor(((point.x - terrain.bounds.minX) / width) * terrain.resolution);
  const row = Math.floor(((point.z - terrain.bounds.minZ) / depth) * terrain.resolution);
  if (column < 0 || row < 0 || column >= terrain.resolution || row >= terrain.resolution) return null;
  const index = row * terrain.resolution + column;
  return { groundWater: terrain.groundWater[index] ?? 0, groundWaterPollution: terrain.groundWaterPollution[index] ?? 0,
    waterDepth: terrain.waterDepths[index] ?? 0 };
}

export interface DistrictUtilitySiteInput {
  kind: DistrictUtilityKind;
  /** Where the district is: sites nearest it come first, so the facility sits close to the load it carries. */
  target: SpatialPoint2;
  /** Streets of the connected component the district joined. Only these carry a facility's service. */
  edges: readonly SpatialRoadEdge[];
  existingFacilities: ReadonlyArray<{ position: SpatialPoint2; footprintRadiusMeters: number }>;
  terrain?: SpatialLocalTerrain;
  /** Which water a pumping prefab draws on: `ground` needs clean groundwater under it, `surface` needs a shore beside it. */
  waterSource?: "ground" | "surface" | "none";
  /** A thermal power plant, not a turbine: sited downwind of the city and away from homes (see `power-siting.ts`) instead of nearest the load. */
  plant?: { city: SpatialPoint2; homes: readonly SpatialPoint2[] };
  /** Zoned cells and buildings: a facility lot is left on free land. The game refuses a lot that overlaps a zoning block (measured: every site beside a fully zoned district was refused). */
  avoid?: readonly SpatialPoint2[];
  /**
   * An outlet is sited by the water's flow (`water-safety-siting.ts`): only beside open water, and only where its discharge is certified not to
   * reach an intake. Present with `safety: null` the flow could not be read and no outlet is offered (fail closed). Absent: the earlier siting
   * (nearest lot beside a street), kept for hosts that cannot read the water.
   */
  sewageSafety?: { safety: WaterSafety | null };
  /** A surface pump is kept out of every outlet's discharge, and must leave an outlet site standing (`pumpSiteSafe`). */
  pumpGuard?: PumpGuard;
  /** Receives one line of the siting's reasoning (what the water-safety rules refused), for the cycle's notes. */
  diagnostics?: string[];
  /** Places where a facility was taken down for want of a road the game would accept: no candidate within `radius` of one is offered again (a site that cannot get a road cannot get one by trying it again). */
  excludedAround?: ReadonlyArray<{ position: SpatialPoint2; radius: number }>;
}

/**
 * Sites worth sending to the game's object preflight: beside a street of the district's component, clear of other
 * facilities, and — for a pumping station — over clean groundwater. Legality stays the preflight's call.
 */
export function districtUtilitySites(input: DistrictUtilitySiteInput): CivicSiteCandidate[] {
  const facility = DISTRICT_UTILITY_FACILITY[input.kind];
  const roads = input.edges.map((edge) => ({ start: edge.start, end: edge.end }));
  // Water only exists where the ground holds it, so a pump may stand much farther from the district than a turbine;
  // the nearest-first cut is applied AFTER the groundwater filter, not before it.
  // An outlet sited by the water's flow may stand as far as a pump (the shore is where the water is, not where the district is).
  const reach = input.plant ? PLANT_REACH_METERS : input.kind === "water" || (input.kind === "sewage" && input.sewageSafety) ? DISTRICT_WATER_REACH_METERS : DISTRICT_UTILITY_REACH_METERS;
  const wind = input.plant ? prevailingWind(input.terrain) : null;
  const plantTarget = input.plant?.city ?? input.target;
  const setbacks = input.plant ? PLANT_SETBACKS_METERS : input.kind === "sewage" && input.sewageSafety?.safety
    ? [...DISTRICT_UTILITY_SETBACKS_METERS.sewage, ...SEWAGE_SHORE_SETBACKS_METERS] : DISTRICT_UTILITY_SETBACKS_METERS[input.kind];
  const ranked = civicSiteCandidates({ target: plantTarget, edges: input.edges, setbacksMeters: setbacks,
    maximumDistanceMeters: reach, maximumCandidates: 20_000 })
    .filter((candidate) => {
      if (input.kind !== "water" || input.waterSource === "none") return true;
      const sample = terrainSampleAt(input.terrain, candidate.position);
      if (input.waterSource === "surface") {
        // A surface pump stands on dry land with open water close by: some point within the shore distance is under water.
        if (sample === null || sample.waterDepth > 0.05) return false;
        return SHORE_PROBES.some(([dx, dz]) => (terrainSampleAt(input.terrain, { x: candidate.position.x + dx, z: candidate.position.z + dz })?.waterDepth ?? 0) > 0.3);
      }
      return sample !== null && sample.groundWater > 0 && sample.groundWaterPollution <= 0 && sample.waterDepth <= 0.05;
    })
    .filter((candidate) => !input.plant || plantSiteAllowed(candidate.position, input.plant))
    .filter((candidate) => !(input.excludedAround ?? []).some((zone) => Math.hypot(zone.position.x - candidate.position.x, zone.position.z - candidate.position.z) < zone.radius))
    .filter((candidate) => !input.avoid || input.avoid.length === 0 || !input.avoid.some((point) => Math.hypot(point.x - candidate.position.x, point.z - candidate.position.z) < facility.footprintRadiusMeters + AVOID_MARGIN_METERS))
    .filter((candidate) => facilityPlacementClearance({ position: candidate.position, roads,
      existingFacilities: input.existingFacilities, footprintRadiusMeters: facility.footprintRadiusMeters,
      maxRoadAccessMeters: candidate.setbackMeters + 12 }).ok);
  // A surface pump delivers what the water within its reach gives it (measured live 2026-10-04: two pumps of the same prefab, one at about 2% of its
  // capacity, one far above it), so it goes as close to the shore as the ground allows, in 10 m steps, and nearest the district within a step.
  // The road it needs is built to it afterwards (the game's No Road Access notice); the shore is not given up to stay beside a street.
  const shore = new Map<CivicSiteCandidate, number>();
  if (!input.plant && input.kind === "water" && input.waterSource === "surface" && input.terrain) {
    for (const candidate of ranked) shore.set(candidate, Math.floor((distanceToWater(input.terrain, candidate.position) ?? Infinity) / 10));
  }
  ranked.sort((left, right) => input.plant
    ? plantSiteScore(right.position, { ...input.plant, wind }) - plantSiteScore(left.position, { ...input.plant, wind })
    : ((shore.get(left) ?? 0) - (shore.get(right) ?? 0)) ||
      Math.hypot(left.position.x - input.target.x, left.position.z - input.target.z) - Math.hypot(right.position.x - input.target.x, right.position.z - input.target.z));
  // Attachment beats nearness to the district, but the nearest lots to a street are usually the zoned frontage the game
  // refuses (measured: 24 of 24 preflights at the closest setback refused). Offer the setbacks in turn — one lot of each,
  // nearest the load first — so the first preflights already sample every distance instead of exhausting one.
  // Water safety (`water-safety-siting.ts`), applied to the candidates in the order they would be tried, and only as far as the search can use.
  let pool: CivicSiteCandidate[] = ranked;
  const depthAt = (point: SpatialPoint2) => terrainSampleAt(input.terrain, point)?.waterDepth ?? null;
  if (input.kind === "sewage" && input.sewageSafety) {
    const selection = selectCertifiedOutfalls(ranked, input.sewageSafety.safety, depthAt);
    pool = selection.sites;
    input.diagnostics?.push(`sewage outfall: ${selection.sites.length} certified of ${selection.examined} examined, ${ranked.length} lots offered; refused ${JSON.stringify(selection.refusals)}`);
  } else if (input.kind === "water" && input.waterSource === "surface" && input.pumpGuard) {
    const safe: CivicSiteCandidate[] = [];
    const refused: Record<string, number> = {};
    let examined = 0;
    for (const candidate of ranked) {
      if (safe.length >= PUMP_SAFE_SITES_KEPT || examined >= PUMP_SITES_EXAMINED) break;
      examined += 1;
      const verdict = pumpSiteSafe(candidate.position, input.pumpGuard);
      if (verdict.ok) safe.push(candidate); else refused[verdict.reason ?? "unsafe"] = (refused[verdict.reason ?? "unsafe"] ?? 0) + 1;
    }
    pool = safe;
    if (examined > safe.length) input.diagnostics?.push(`water pump: ${safe.length} safe of ${examined} examined; refused ${JSON.stringify(refused)}`);
  }
  const bySetback = setbacks.map((setback) => pool.filter((candidate) => candidate.setbackMeters === setback));
  const interleaved: CivicSiteCandidate[] = [];
  for (let index = 0; interleaved.length < pool.length; index += 1) {
    for (const group of bySetback) if (group[index]) interleaved.push(group[index]!);
    if (index > pool.length) break;
  }
  return interleaved.slice(0, 160);
}

export interface DistrictUtilitiesPort {
  listFacilities(prefab: string, signal?: AbortSignal): Promise<Array<{ entity: { index: number; version: number }; position: SpatialPoint2 }>>;
  /**
   * The game's own object preflight: may this prefab stand here? `null` is NO ANSWER (the Bridge stayed busy): it says nothing about the site, so
   * it is neither a refusal to remember nor a placement to make.
   */
  preflight(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<boolean | null>;
  /**
   * The water the outlet and pump rules read (`water-safety-siting.ts`): the flow grid and the intakes standing NOW (never a cached census: a pump
   * placed a moment ago must be in it). Null: it could not be read. Absent: the host cannot read the water, and the earlier siting stands.
   */
  readWaterSafety?(signal?: AbortSignal): Promise<WaterSafety | null>;
  place(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** Whether the facility's connector is attached to a street (true), orphaned (false), or unreadable (null). */
  attached(entity: { index: number; version: number }, signal?: AbortSignal): Promise<boolean | null>;
  /** Lay `prefab` (a cable or pipe) from the facility's Marker to the street point it faces. */
  connect?(prefab: string, from: SpatialPoint2, to: SpatialPoint2, signal?: AbortSignal):
    Promise<{ ok: boolean; detail: string; /** The net edges this call created (read as before/after), so a failed facility can take them with it. */ created?: Array<{ index: number; version: number }> }>;
  /** Where the facility's connector is and which way it faces (the front of its lot): the cable or pipe starts there. */
  connectorFront?(entity: { index: number; version: number }, signal?: AbortSignal, kind?: DistrictUtilityKind): Promise<{ position: SpatialPoint2; direction: SpatialPoint2 } | null>;
  /** The prefabs the world offers for a utility, best capacity per cost first. Absent: the default prefab only. */
  /** `neededOutput`: what the city is short of, so a source that covers it in one placement can be offered before one that cannot. */
  rankPrefabs?(kind: DistrictUtilityKind, signal?: AbortSignal, neededOutput?: number): Promise<string[]>;
  /**
   * The game's dry run of the access road a facility set back from the street will need (from the street toward the facility's front): "OK", or the
   * refusal. Read BEFORE a far-set facility is bought (live 2026-10-07: a coal plant 90 m from the street, its road blocked by water, was placed and then
   * taken down after four failed roads). Absent: no check, as before.
   */
  accessRoadVerdict?(street: SpatialPoint2, front: SpatialPoint2, signal?: AbortSignal): Promise<string>;
  /** Bulldoze a facility this call placed that read back unattached: it carries nothing and only costs upkeep. */
  remove?(entity: { index: number; version: number }, signal?: AbortSignal): Promise<boolean>;
  /**
   * What one more of this prefab is expected to add (output for power, capacity for water and sewage), from the world's own catalogue as last
   * ranked — a wind turbine at its measured share of nameplate. Null: unknown (one placement is then taken as the whole answer).
   */
  expectedOutput?(kind: DistrictUtilityKind, prefab: string): number | null;
}

/** Facilities one search may place for one shortage (spend stays bounded; the next cycle continues if still short). */
export const REALIZATION_MAXIMUM_PLACEMENTS = 6;

export interface UtilityRealization {
  placements: DistrictUtilityPlacement[];
  /** Output (or capacity) the attached placements are expected to add. */
  covered: number;
  /** The shortage was not covered and every candidate was searched (or remembered as having no site): no feasible realization now. */
  exhausted: boolean;
  /** Candidates searched in this call. */
  searched: string[];
}

/**
 * Realize a utility shortage, not "place one facility". The decision layer names an effect (this much more power, water or sewage);
 * this searches every prefab the world offers for it, best first, until the attached placements cover the shortage — several of the same
 * prefab if one is not enough — or every candidate has been tried. Sites the game refused are remembered per site (`placementMemory`), so an
 * impossible plant is not offered to the game again every cycle. Only when every candidate was searched and the shortage still stands is
 * the answer "no feasible realization": a first, or a third, failure is not that answer.
 *
 * Measured live (2026-10-04): the ranking put a small coal plant and the two larger turbines first, the placement tried only those three,
 * none had a legal site, and the one turbine that would have stood — ranked fourth — was never tried, while 400-570 buildings had no power.
 */
export async function realizeUtilityShortfall(port: DistrictUtilitiesPort, input: ProvisionDistrictUtilityInput, notes: string[]): Promise<UtilityRealization> {
  const ranked = (await port.rankPrefabs?.(input.kind, input.signal, input.shortfall)) ?? [];
  const candidates = ranked.length > 0 ? ranked : [DISTRICT_UTILITY_FACILITY[input.kind].prefab];
  if (ranked.length === 0) notes.push(`${input.kind} realization: the world offered no ranking; only the default ${candidates[0]} is tried`);
  const placements: DistrictUtilityPlacement[] = [];
  const searched: string[] = [];
  let covered = 0;
  let unknownOutputPlaced = false;
  let outletStands = false;
  for (const prefab of candidates) {
    if (input.signal?.aborted || covered >= input.shortfall || unknownOutputPlaced || outletStands || placements.length >= REALIZATION_MAXIMUM_PLACEMENTS) break;
    searched.push(prefab);
    // An attached sewage outlet takes any amount: the shortage is the network's (pipes), not a missing outlet. Not a siting failure.
    if (input.kind === "sewage" && !REAL_CAPACITY_SHORTFALL(input.shortfall) && await anyAttached(port, await port.listFacilities(prefab, input.signal), input.signal)) {
      notes.push("sewage: an attached outlet already exists and takes any amount; another would only add upkeep");
      outletStands = true;
      break;
    }
    const output = port.expectedOutput?.(input.kind, prefab) ?? null;
    // The same prefab again while it keeps finding sites and the shortage stands.
    while (covered < input.shortfall && placements.length < REALIZATION_MAXIMUM_PLACEMENTS && !input.signal?.aborted) {
      const placement = await provisionWithPrefab(port, { ...input, shortfall: input.shortfall - covered }, notes, prefab);
      if (!placement) break;
      placements.push(placement);
      // Only an attached facility delivers; one whose connection could not be read is not counted (and not repeated blindly).
      if (placement.attached === null) { unknownOutputPlaced = true; break; }
      if (placement.attached !== true) break;
      if (output === null || !(output > 0)) { unknownOutputPlaced = true; break; }
      covered += output;
    }
  }
  // A thermal plant drinks (the player's rule, 2026-10-08: "if power needs a coal plant, add the pumping station with it"): live, a SmallCoalPowerPlant01
  // joined to the streets put 600-940 buildings around it without water although the city-wide capacity stood far above use; one WaterTower03 placed beside
  // the plant cleared every one within a reading, and one placed 400 m off among the dry homes did not. So the water goes beside the plant, at once.
  if (input.kind === "electricity") {
    for (const plant of placements.filter((placement) => THERMAL_PLANT.test(placement.prefab) && placement.attached === true)) {
      if (input.signal?.aborted) break;
      notes.push(`water for ${plant.prefab} at (${plant.position.x.toFixed(0)},${plant.position.z.toFixed(0)}): a thermal plant draws about ${THERMAL_PLANT_WATER_UNITS}; water is placed beside it`);
      const water = await realizeUtilityShortfall(port, { ...input, kind: "water", shortfall: THERMAL_PLANT_WATER_UNITS, target: plant.position,
        avoid: [...(input.avoid ?? []), plant.position], siting: undefined }, notes);
      placements.push(...water.placements);
    }
  }
  const exhausted = covered < input.shortfall && !unknownOutputPlaced && !outletStands && placements.length < REALIZATION_MAXIMUM_PLACEMENTS &&
    searched.length === candidates.length;
  notes.push(`${input.kind} realization: short ${Math.round(input.shortfall)}, ${placements.length} placed (${placements.filter((placement) => placement.attached === true).length} attached), ` +
    `expected +${Math.round(covered)}${unknownOutputPlaced ? " (+unknown)" : ""}; searched ${searched.join(" > ") || "none"}` +
    `${exhausted ? "; every candidate tried: NO_FEASIBLE_REALIZATION now" : ""}`);
  return { placements, covered, exhausted, searched };
}

export interface DistrictUtilityPlacement {
  kind: DistrictUtilityKind;
  prefab: string;
  position: SpatialPoint2;
  attached: boolean | null;
  /** The facility that now stands, so the builder that placed it can take it down again if it turns out unreachable. */
  entity?: { index: number; version: number };
}

export interface ProvisionDistrictUtilityInput {
  kind: DistrictUtilityKind;
  shortfall: number;
  target: SpatialPoint2;
  edges: readonly SpatialRoadEdge[];
  terrain?: SpatialLocalTerrain;
  /** Zoned cells and buildings the lot must keep clear of. */
  avoid?: readonly SpatialPoint2[];
  /** Homes and the city centre: what a thermal plant is sited against. Absent: a thermal plant is sited like any facility. */
  siting?: { city: SpatialPoint2; homes: readonly SpatialPoint2[] };
  /** The sites the game already refused (`RefusedPlacements`, the product's own placement memory): not offered to the game again for a while. */
  placementMemory?: { refused: RefusedPlacements; cycle: number | GameStamp };
  /** See `DistrictUtilitySiteInput.excludedAround`. */
  excludedAround?: ReadonlyArray<{ position: SpatialPoint2; radius: number }>;
  signal?: AbortSignal;
}

/**
 * Place one facility for a utility the district would leave short, and read its connection back. The facility is chosen
 * from what the world offers (`rankPrefabs`, best capacity per cost first); the first that finds a legal site and
 * attaches wins. Without a ranking the product's default prefab for the utility is the only candidate.
 */
/**
 * Cheap facilities (a turbine, a pump, an outlet) may be taken down when they serve nobody. A costly one never is (the player's rule, 2026-10-07: a recycling
 * centre and a burning plant, about a million each, placed, taken down for want of a road and placed again elsewhere took the treasury from 2.7 million
 * to 0.1): it stays, and the notice is left to the player (`high-value-guard.ts`).
 */
export const mayDemolishFacility = (prefab: string | null | undefined): boolean => !isHighValueFacility(prefab);

/**
 * A shortfall of this many units or more is a measured lack of capacity (live 2026-10-07: sewage capacity 100,000 against 108,158 used, 572 overflow icons
 * at 27,000 people): another outlet IS the answer then. Below it the figure is the "at least one" placeholder, and an outlet that stands takes any amount.
 */
export const REAL_CAPACITY_SHORTFALL = (shortfall: number): boolean => shortfall >= 100;

/** Facilities set at least this far back from the street get their access road dry-run before they are placed. */
export const ACCESS_CHECK_MINIMUM_SETBACK_METERS = 30;

export async function provisionDistrictUtility(port: DistrictUtilitiesPort, input: ProvisionDistrictUtilityInput,
  notes: string[]): Promise<DistrictUtilityPlacement | null> {
  const ranked = (await port.rankPrefabs?.(input.kind, input.signal, input.shortfall)) ?? [];
  const prefabs = ranked.length > 0 ? ranked.slice(0, DISTRICT_UTILITY_MAXIMUM_PREFABS) : [DISTRICT_UTILITY_FACILITY[input.kind].prefab];
  for (const prefab of prefabs) {
    const placement = await provisionWithPrefab(port, input, notes, prefab);
    if (placement) return placement;
  }
  return null;
}

async function anyAttached(port: DistrictUtilitiesPort, facilities: ReadonlyArray<{ entity: { index: number; version: number } }>,
  signal?: AbortSignal): Promise<boolean> {
  for (const facility of facilities) if (await port.attached(facility.entity, signal) === true) return true;
  return false;
}

async function provisionWithPrefab(port: DistrictUtilitiesPort, input: ProvisionDistrictUtilityInput,
  notes: string[], prefab: string): Promise<DistrictUtilityPlacement | null> {
  // A power plant is big, burns fuel and fouls the air: it gets its own footprint and its own siting (downwind, away from homes).
  // A sewage TREATMENT plant is a plant like a power plant, not an outlet: it needs no open water, only room by a street, and its sites are not the outlet's
  // "certified receiving water" ones (live 2026-10-07: 0 of 155 outlet lots certified in a city of 28,000, and the plant, offered the same rules, had 0 sites).
  const isTreatmentPlant = input.kind === "sewage" && TREATMENT_PLANT.test(prefab);
  const isPlant = (input.kind === "electricity" && THERMAL_PLANT.test(prefab)) || isTreatmentPlant;
  const facility = { ...DISTRICT_UTILITY_FACILITY[input.kind], prefab, ...(isPlant ? { footprintRadiusMeters: PLANT_FOOTPRINT_RADIUS_METERS } : {}) };
  const existing = await port.listFacilities(facility.prefab, input.signal);
  // A sewage outlet takes any amount of sewage (its capacity reads as ~1e9), so a second one only adds upkeep: measured
  // live, five outlets cost 65k a month for a city of 321 people. One attached outlet is the whole answer.
  if (input.kind === "sewage" && !REAL_CAPACITY_SHORTFALL(input.shortfall) && await anyAttached(port, existing, input.signal)) {
    notes.push("sewage: an attached outlet already exists and takes any amount; another would only add upkeep");
    return null;
  }
  // A pump named for groundwater draws on the ground; any other water pump is a surface pump and needs a shore.
  // A water tower needs no water under or beside it: it adds its stated capacity wherever it stands.
  const waterSource = input.kind === "water" ? (/Tower/i.test(prefab) ? "none" as const : /Ground/i.test(prefab) ? "ground" as const : "surface" as const) : undefined;
  // The water rules (`water-safety-siting.ts`): an outlet only where its discharge is certified not to reach an intake, and a surface pump only where
  // no outlet's discharge reaches it AND an outlet site still stands once it does. A host that cannot read the water keeps the earlier siting.
  const siteBase = { target: input.target, edges: input.edges, existingFacilities: existing.map((item) => ({ position: item.position, footprintRadiusMeters: facility.footprintRadiusMeters })),
    ...(input.terrain ? { terrain: input.terrain } : {}), ...(input.avoid ? { avoid: input.avoid } : {}), ...(input.excludedAround ? { excludedAround: input.excludedAround } : {}) };
  const siteNotes: string[] = [];
  let sewageSafety: { safety: WaterSafety | null } | undefined;
  let pumpGuard: PumpGuard | undefined;
  if (port.readWaterSafety && !isTreatmentPlant && (input.kind === "sewage" || waterSource === "surface")) {
    const safety = await port.readWaterSafety(input.signal).catch(() => null);
    if (input.kind === "sewage") sewageSafety = { safety };
    else if (safety) {
      const outlets = (await port.listFacilities(DISTRICT_UTILITY_FACILITY.sewage.prefab, input.signal)).map((item) => item.position);
      // With no outlet standing, the certified outlet sites that exist BEFORE this pump: the pump may not take the last of them.
      const options = outlets.length === 0
        ? districtUtilitySites({ ...siteBase, kind: "sewage", existingFacilities: [], sewageSafety: { safety } }).map((site) => site.position) : null;
      pumpGuard = { safety, existingOutlets: outlets, outletOptions: options };
    }
  }
  const sites = districtUtilitySites({ ...siteBase, kind: input.kind, ...(waterSource ? { waterSource } : {}),
    ...(isPlant && input.siting ? { plant: input.siting } : {}), ...(sewageSafety ? { sewageSafety } : {}), ...(pumpGuard ? { pumpGuard } : {}), diagnostics: siteNotes });
  for (const line of siteNotes) notes.push(line);
  let preflights = 0;
  let nativeRejections = 0;
  let placements = 0;
  let noAnswers = 0;
  let lastUnattached: DistrictUtilityPlacement | null = null;
  for (const site of sites) {
    if (input.signal?.aborted || preflights >= DISTRICT_UTILITY_MAXIMUM_PREFLIGHTS || nativeRejections >= CIVIC_MAXIMUM_NATIVE_REJECTIONS ||
      placements >= DISTRICT_UTILITY_MAXIMUM_PLACEMENTS) break;
    if (input.placementMemory?.refused.refused(facility.prefab, site.position, input.placementMemory.cycle)) continue;
    preflights += 1;
    const legal = await port.preflight(facility.prefab, site.position, site.rotation, input.signal);
    if (legal === null) {
      // The Bridge stayed busy: no answer about this site. It is not remembered as refused (that would hold the site out for hours for a busy Bridge),
      // and a Bridge that answers nothing three times running ends the search: every remaining site meets the same wall, at seconds apiece.
      noAnswers += 1;
      if (noAnswers >= PREFLIGHT_NO_ANSWER_LIMIT) { notes.push(`${input.kind}: the Bridge gave no answer to ${noAnswers} placement checks in a row (BRIDGE_BUSY); not searching further this cycle`); break; }
      continue;
    }
    noAnswers = 0;
    if (!legal) {
      input.placementMemory?.refused.remember(facility.prefab, site.position, input.placementMemory.cycle);
      continue;
    }
    // A facility set far back needs a road that long to its front: dry-run that road first, and leave a site whose road the game refuses (water, overlap).
    // An answer that only fails to identify the new road (it meets an existing road end) is not a refusal; no answer is no check.
    if (port.accessRoadVerdict && site.setbackMeters >= ACCESS_CHECK_MINIMUM_SETBACK_METERS) {
      const toward = Math.hypot(site.position.x - site.street.x, site.position.z - site.street.z) || 1;
      const reach = Math.max(8, site.setbackMeters - (facility.footprintRadiusMeters ?? 10));
      const front = { x: site.street.x + ((site.position.x - site.street.x) / toward) * reach, z: site.street.z + ((site.position.z - site.street.z) / toward) * reach };
      const verdict = await port.accessRoadVerdict(site.street, front, input.signal).catch(() => "ERROR");
      if (/^REJECT/.test(verdict) && !/NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED/.test(verdict)) {
        input.placementMemory?.refused.remember(facility.prefab, site.position, input.placementMemory.cycle);
        notes.push(`${input.kind}: ${facility.prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) left: its ${Math.round(reach)} m access road is refused (${verdict.slice(0, 60)})`);
        continue;
      }
    }
    const placed = await port.place(facility.prefab, site.position, site.rotation, input.signal);
    if (!placed.ok) {
      nativeRejections += 1;
      continue;
    }
    placements += 1;
    // The world is the readback: find the facility that now stands at the site and read its connector.
    const after = await port.listFacilities(facility.prefab, input.signal);
    const standing = after.find((item) => Math.hypot(item.position.x - site.position.x, item.position.z - site.position.z) < 6);
    let attached = standing ? await port.attached(standing.entity, input.signal) : null;
    let connection = "";
    let createdNets: Array<{ index: number; version: number }> = [];
    // A facility that is taken down takes the pipe or cable laid for it: left behind they are lines that join nothing (each failed plant left two).
    const takeDownNets = async () => { for (const net of createdNets) await port.remove?.(net, input.signal); createdNets = []; };
    if (attached === false && standing && port.connect) {
      // The net starts at the facility's own connector, where the game attaches it — not at the centre of the building: for a big plant the connector
      // is tens of metres from the centre, and a cable laid from the centre never touches it (measured live 2026-10-04: a coal plant 160 m off the street,
      // two cables read back unattached; a turbine or a pump, whose connector is a few metres from the centre, attached).
      const connector = port.connectorFront ? await port.connectorFront(standing.entity, input.signal, input.kind) : null;
      const laid = await port.connect(DISTRICT_UTILITY_CONNECTION_PREFAB[input.kind], connector?.position ?? site.position, site.street, input.signal);
      createdNets = laid.created ?? [];
      connection = laid.ok ? `, ${DISTRICT_UTILITY_CONNECTION_PREFAB[input.kind]} laid to the street` : `, connection refused (${laid.detail.slice(0, 80)})`;
      attached = await port.attached(standing.entity, input.signal);
    }
    const where = `${facility.prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) setback ${site.setbackMeters} m${connection}`;
    if (attached === false && standing && !mayDemolishFacility(facility.prefab)) {
      // A costly plant is not taken down and another placed (each costs as much again): it stays, unattached, for the link repair or the player.
      notes.push(`${input.kind}: ${where} read back unattached; a costly facility is not taken down — left for the link repair (no other of its kind is placed meanwhile)`);
      return { kind: input.kind, prefab: facility.prefab, position: site.position, attached, entity: standing.entity };
    }
    if (attached === false && standing && port.remove) {
      // An unattached facility serves nobody and still costs upkeep (measured live: 2 of 3 pumps and a turbine sit so).
      const removed = await port.remove(standing.entity, input.signal);
      await takeDownNets();
      notes.push(`${input.kind}: ${where} read back unattached, ${removed ? "removed" : "could not be removed"}`);
      lastUnattached = { kind: input.kind, prefab: facility.prefab, position: site.position, attached };
      continue;
    }
    notes.push(`${input.kind}: ${where} ${attached === true ? "attached to the network" : attached === false ? "NOT attached (orphan)" : "connection unread"}`);
    return { kind: input.kind, prefab: facility.prefab, position: site.position, attached, ...(standing ? { entity: standing.entity } : {}) };
  }
  if (!lastUnattached && noAnswers < PREFLIGHT_NO_ANSWER_LIMIT) {
    notes.push(`${input.kind}: short by ${Math.round(input.shortfall)} but no legal site (${sites.length} candidates, ${preflights} preflights, ${nativeRejections} refused)`);
  }
  return null;
}