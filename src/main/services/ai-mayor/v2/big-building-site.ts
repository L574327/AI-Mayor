import type { SpatialPoint2 } from "../spatial/types";
import type { LandRectangle } from "./district-land";

/**
 * A BIG BUILDING IS FITTED TO FREE LAND BY GEOMETRY, NOT TRIED SPOT BY SPOT.
 *
 * Every object preflight shows a ghost building in the game for an instant, so sweeping a map with them (a rail yard: 320 preflights, 0 legal, found live
 * 2026-10-05) is a flicker the player sees, and it was blind: the product did not know how big the building was. The Bridge now reports the lot (grid
 * cells of 8 m) and the bounding size of a prefab before anything is placed; the free land is the product's own mask (water, slope, roads, buildings,
 * clearance already out). A rectangle of free land that holds the footprint with a margin is a candidate; the nearest to the target comes first; each
 * site is asked of the game at most once, ever (a refusal is remembered); at most `BIG_BUILDING_PREFLIGHTS_PER_CALL` are asked per call; and when no
 * free rectangle holds the building, the land is bought toward the target instead of searching the land already owned again.
 */

export const LOT_CELL_METERS = 8;
/** Free land kept round the footprint (the lattice cells are already clear of roads and buildings by the district clearance). */
export const BIG_BUILDING_MARGIN_METERS = 16;
export const BIG_BUILDING_PREFLIGHTS_PER_CALL = 3;
/** A service building with a side this long (m) does not fit a street lot and is fitted to free land instead. */
export const BIG_SERVICE_MINIMUM_SIDE_METERS = 56;
/** Free land farther than this from a street is not offered to a big service: it could not be reached by the short access road the repair lays. */
export const BIG_SERVICE_STREET_REACH_METERS = 90;
/** A site this near a refused one is not offered either (the same ground refuses the same way). */
export const REFUSED_SITE_RADIUS_METERS = 40;

export interface Footprint { widthMeters: number; depthMeters: number }

export interface SizeReading {
  lotSize?: { x: number; z: number } | null;
  size?: { x: number; y?: number; z: number } | null;
}

/** The ground the building covers: its lot in grid cells when the game gives one, else the bounding size of the object. Null: unknown (never guessed). */
export function footprintOf(reading: SizeReading | null | undefined): Footprint | null {
  if (!reading) return null;
  const lot = reading.lotSize;
  if (lot && lot.x > 0 && lot.z > 0) return { widthMeters: lot.x * LOT_CELL_METERS, depthMeters: lot.z * LOT_CELL_METERS };
  const size = reading.size;
  if (size && size.x > 0 && size.z > 0) return { widthMeters: size.x, depthMeters: size.z };
  return null;
}

export interface SiteCandidate { center: SpatialPoint2; rotation: number; distanceToTarget: number; rectangle: LandRectangle }

/** CS2 yaw (degrees, 0 faces +Z, positive toward +X), rounded to the nearest quarter turn. */
function quarterYawToward(from: SpatialPoint2, to: SpatialPoint2): number {
  const yaw = (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
  return ((Math.round(yaw / 90) * 90) % 360 + 360) % 360;
}

/**
 * Where the footprint fits inside free rectangles, nearest the target first. A quarter turn that swaps width and depth is tried too; among the turns that
 * fit, the one facing the target is kept. Sites near a refused one are left out.
 */
export function fitSites(rectangles: readonly LandRectangle[], footprint: Footprint, target: SpatialPoint2, refused: readonly SpatialPoint2[]): SiteCandidate[] {
  const margin = BIG_BUILDING_MARGIN_METERS;
  const sites: SiteCandidate[] = [];
  for (const rectangle of rectangles) {
    const fits = (rotation: number) => {
      const swapped = rotation % 180 !== 0;
      const width = (swapped ? footprint.depthMeters : footprint.widthMeters) + 2 * margin;
      const depth = (swapped ? footprint.widthMeters : footprint.depthMeters) + 2 * margin;
      return rectangle.widthMeters >= width && rectangle.heightMeters >= depth ? { width, depth } : null;
    };
    const centreOf = (rotation: number): SpatialPoint2 | null => {
      const box = fits(rotation);
      if (!box) return null;
      return { x: Math.min(Math.max(target.x, rectangle.minX + box.width / 2), rectangle.minX + rectangle.widthMeters - box.width / 2),
        z: Math.min(Math.max(target.z, rectangle.minZ + box.depth / 2), rectangle.minZ + rectangle.heightMeters - box.depth / 2) };
    };
    // The turn facing the target when it fits, else any that does.
    const roughCentre = { x: rectangle.minX + rectangle.widthMeters / 2, z: rectangle.minZ + rectangle.heightMeters / 2 };
    const facing = quarterYawToward(roughCentre, target);
    const turns = [facing, (facing + 90) % 360, (facing + 180) % 360, (facing + 270) % 360];
    const turn = turns.find((rotation) => fits(rotation) !== null);
    if (turn === undefined) continue;
    const center = centreOf(turn)!;
    if (refused.some((point) => Math.hypot(point.x - center.x, point.z - center.z) < REFUSED_SITE_RADIUS_METERS)) continue;
    sites.push({ center, rotation: quarterYawToward(center, target) % 180 === turn % 180 ? quarterYawToward(center, target) : turn, distanceToTarget: Math.hypot(center.x - target.x, center.z - target.z), rectangle });
  }
  // Maximal rectangles overlap, so several give the same ground: one site per place (a place is asked of the game once).
  const distinct: SiteCandidate[] = [];
  for (const site of sites.sort((left, right) => left.distanceToTarget - right.distanceToTarget)) {
    if (!distinct.some((other) => Math.hypot(other.center.x - site.center.x, other.center.z - site.center.z) < REFUSED_SITE_RADIUS_METERS)) distinct.push(site);
  }
  return distinct;
}

export interface BigBuildingPort {
  footprint(prefab: string, signal?: AbortSignal): Promise<Footprint | null>;
  /** The free rectangles of owned land (water, slope, roads, buildings and clearance already out). Null: the ground cannot be read. */
  freeRectangles(signal?: AbortSignal): Promise<LandRectangle[] | null>;
  preflight(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<boolean | null>;
  place(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** Buy the land toward the target (the neighbouring tile nearest it); true when a tile was bought. The caller applies the cash rules. */
  acquireToward(target: SpatialPoint2, signal?: AbortSignal): Promise<boolean>;
  /**
   * Make room by taking buildings down (`planClearing`): returns how many came down. The caller decides what may be taken down and how often; the building
   * is placed on a later look, once the ground is read free (a place is never asked of the game while buildings still stand on it).
   */
  clearRoom?(footprint: Footprint, target: SpatialPoint2, signal?: AbortSignal): Promise<number>;
  /** Whether a fitted site is where a street can reach it (the access road is short): a site the road repair could never reach is not asked of the game. */
  siteReachable?(center: SpatialPoint2, footprint: Footprint): boolean;
}

export type BigBuildingOutcome =
  | { status: "PLACED"; at: SpatialPoint2; rotation: number }
  | { status: "NO_FOOTPRINT" | "GROUND_UNREAD" | "NO_ROOM_BOUGHT_LAND" | "NO_ROOM" | "ROOM_CLEARED" | "REFUSED" | "BUSY" };

/**
 * One go at putting a big building down: fit, ask the game at most `BIG_BUILDING_PREFLIGHTS_PER_CALL` times (each site once, ever), place the first it
 * accepts; with no free rectangle that holds it, buy land toward the target. `refusedSites` is the caller's memory and is added to here.
 */
export async function placeBigBuilding(port: BigBuildingPort, request: { prefab: string; target: SpatialPoint2; refusedSites: SpatialPoint2[] }, notes: string[], signal?: AbortSignal): Promise<BigBuildingOutcome> {
  const { prefab, target, refusedSites } = request;
  const footprint = await port.footprint(prefab, signal);
  if (!footprint) { notes.push(`big building: the size of ${prefab} is not known (the Bridge reports a prefab's lot only after its restart); nothing is tried blind`); return { status: "NO_FOOTPRINT" }; }
  const rectangles = await port.freeRectangles(signal);
  if (!rectangles) { notes.push(`big building: the free land cannot be read, so ${prefab} is not tried`); return { status: "GROUND_UNREAD" }; }
  const sites = fitSites(rectangles, footprint, target, refusedSites).filter((site) => port.siteReachable?.(site.center, footprint) !== false);
  if (sites.length === 0) {
    notes.push(`big building: no free land holds ${prefab}: ${describeRoom(rectangles, footprint)}`);
    // Land first when it can be had; failing that, buildings come down to make the room (never both in one look).
    const bought = await port.acquireToward(target, signal);
    if (!bought && port.clearRoom) {
      const cleared = await port.clearRoom(footprint, target, signal);
      if (cleared > 0) return { status: "ROOM_CLEARED" };
    }
    notes.push(`big building: no free land holds ${prefab} (${Math.round(footprint.widthMeters)} x ${Math.round(footprint.depthMeters)} m with ${BIG_BUILDING_MARGIN_METERS} m round it); ${bought ? "a tile was bought toward the target" : "no tile could be bought this cycle"}`);
    return { status: bought ? "NO_ROOM_BOUGHT_LAND" : "NO_ROOM" };
  }
  let asked = 0;
  for (const site of sites) {
    if (signal?.aborted || asked >= BIG_BUILDING_PREFLIGHTS_PER_CALL) break;
    asked += 1;
    const legal = await port.preflight(prefab, site.center, site.rotation, signal);
    if (legal === null) return { status: "BUSY" };
    if (!legal) { refusedSites.push(site.center); continue; }
    if ((await port.place(prefab, site.center, site.rotation, signal)).ok) {
      notes.push(`big building: ${prefab} placed at (${site.center.x.toFixed(0)},${site.center.z.toFixed(0)}) on a free ${Math.round(site.rectangle.widthMeters)} x ${Math.round(site.rectangle.heightMeters)} m rectangle, ${Math.round(site.distanceToTarget)} m from the target`);
      return { status: "PLACED", at: site.center, rotation: site.rotation };
    }
    refusedSites.push(site.center);
  }
  notes.push(`big building: ${asked} fitted site(s) for ${prefab} were refused by the game and are not asked again; ${sites.length - asked} fitted site(s) remain for later`);
  return { status: "REFUSED" };
}

/**
 * NO FREE LAND HOLDS THE BUILDING: WHAT WOULD HAVE TO COME DOWN (mid and late game, when the streets are lined with buildings and nothing free is big
 * enough). From the places beside a street where the footprint (with its margin) would stand, count the buildings inside each; a place is usable only
 * when EVERY building in it may be taken down (`eligible`) and there are few of them. The place with the fewest, then nearest the target, wins. Pure
 * geometry: the caller takes the buildings down and the game's own preflight still decides the placement afterwards.
 */
export interface ClearingBuilding { id: string; position: SpatialPoint2; bounds?: { minX: number; minZ: number; maxX: number; maxZ: number } | null }
export interface ClearingPlan { center: SpatialPoint2; rotation: number; blockers: ClearingBuilding[]; areaSquareMeters: number }
export const CLEARING_MAXIMUM_BUILDINGS = 8;
export const CLEARING_EDGE_MARGIN_METERS = 4;

export function planClearing(input: { footprint: Footprint; places: ReadonlyArray<{ center: SpatialPoint2; rotation: number }>; target: SpatialPoint2;
  buildings: readonly ClearingBuilding[]; eligible: (building: ClearingBuilding) => boolean; maximumBuildings?: number }): ClearingPlan | null {
  const limit = input.maximumBuildings ?? CLEARING_MAXIMUM_BUILDINGS;
  let best: (ClearingPlan & { distance: number }) | null = null;
  for (const place of input.places) {
    const swapped = place.rotation % 180 !== 0;
    const half = { x: ((swapped ? input.footprint.depthMeters : input.footprint.widthMeters) + 2 * CLEARING_EDGE_MARGIN_METERS) / 2,
      z: ((swapped ? input.footprint.widthMeters : input.footprint.depthMeters) + 2 * CLEARING_EDGE_MARGIN_METERS) / 2 };
    const inside = (building: ClearingBuilding) => {
      const b = building.bounds;
      if (b) return b.maxX > place.center.x - half.x && b.minX < place.center.x + half.x && b.maxZ > place.center.z - half.z && b.minZ < place.center.z + half.z;
      return Math.abs(building.position.x - place.center.x) < half.x && Math.abs(building.position.z - place.center.z) < half.z;
    };
    const blockers = input.buildings.filter(inside);
    if (blockers.length === 0 || blockers.length > limit || !blockers.every(input.eligible)) continue;
    const distance = Math.hypot(place.center.x - input.target.x, place.center.z - input.target.z);
    if (!best || blockers.length < best.blockers.length || (blockers.length === best.blockers.length && distance < best.distance)) {
      best = { center: place.center, rotation: place.rotation, blockers, areaSquareMeters: half.x * half.z * 4, distance };
    }
  }
  return best ? { center: best.center, rotation: best.rotation, blockers: best.blockers, areaSquareMeters: best.areaSquareMeters } : null;
}

/** The largest free rectangle, said in numbers: what the player reads when nothing holds the building. */
export function describeRoom(rectangles: readonly LandRectangle[], footprint: Footprint): string {
  const largest = [...rectangles].sort((left, right) => right.widthMeters * right.heightMeters - left.widthMeters * left.heightMeters)[0];
  const need = `${Math.round(footprint.widthMeters)} x ${Math.round(footprint.depthMeters)} m (+${BIG_BUILDING_MARGIN_METERS} m round it)`;
  return largest ? `needs ${need}; the largest free ground in reach is ${Math.round(largest.widthMeters)} x ${Math.round(largest.heightMeters)} m` : `needs ${need}; no free ground in reach`;
}