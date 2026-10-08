/**
 * Where a thermal power plant belongs: downwind of the city, far from homes — read from the world.
 *
 * A coal plant fouls the air, and the game's air pollution is carried by its wind (the same field the Bridge reads for turbines). A player
 * puts it on the outskirts on the side the wind blows TOWARD, away from where people live, near enough to a street to be joined to the
 * network. So: the wind is read from the terrain around the city (its mean vector), a site is scored by how far downwind of the city it
 * lies and how far it is from the nearest home, and homes within the polluter buffer rule a site out. Legality stays the game's object
 * preflight. Without a wind reading (an older Bridge) the score is distance from homes alone.
 */
import type { SpatialLocalTerrain, SpatialPoint2 } from "../spatial/types";

/** Homes this close to a plant are what the noise and pollution fall on: no site is offered within it. */
export const PLANT_MINIMUM_HOME_DISTANCE_METERS = 320;
/** How far from the city centre a plant site may lie and still be joined to the network by the planner. */
export const PLANT_REACH_METERS = 1_400;

export interface Wind { x: number; z: number; speed: number }

/** The mean wind over a terrain read: the direction the air moves TOWARD. Null when the read carries no vector or the air is still. */
export function prevailingWind(terrain: SpatialLocalTerrain | undefined): Wind | null {
  if (!terrain?.windX || !terrain.windZ || terrain.windX.length === 0 || terrain.windX.length !== terrain.windZ.length) return null;
  const x = terrain.windX.reduce((sum, value) => sum + value, 0) / terrain.windX.length;
  const z = terrain.windZ.reduce((sum, value) => sum + value, 0) / terrain.windZ.length;
  const speed = Math.hypot(x, z);
  return speed > 1e-3 ? { x: x / speed, z: z / speed, speed } : null;
}

export function distanceToNearest(point: SpatialPoint2, points: readonly SpatialPoint2[]): number {
  let best = Infinity;
  for (const other of points) { const meters = Math.hypot(other.x - point.x, other.z - point.z); if (meters < best) best = meters; }
  return best;
}

/**
 * Higher is better. Downwind first (cosine of the angle between "city to site" and the wind, -1..1), then distance from homes. A site
 * upwind of the city scores negative on the first term whatever its distance, so it is only chosen when nothing downwind is legal.
 */
export function plantSiteScore(site: SpatialPoint2, input: { city: SpatialPoint2; homes: readonly SpatialPoint2[]; wind: Wind | null }): number {
  const toSite = { x: site.x - input.city.x, z: site.z - input.city.z };
  const length = Math.hypot(toSite.x, toSite.z);
  const downwind = input.wind && length > 0 ? (toSite.x * input.wind.x + toSite.z * input.wind.z) / length : 0;
  const away = Math.min(distanceToNearest(site, input.homes), 1_500) / 1_500;
  return downwind * 2 + away;
}

export function plantSiteAllowed(site: SpatialPoint2, input: { city: SpatialPoint2; homes: readonly SpatialPoint2[] }): boolean {
  return distanceToNearest(site, input.homes) >= PLANT_MINIMUM_HOME_DISTANCE_METERS && Math.hypot(site.x - input.city.x, site.z - input.city.z) <= PLANT_REACH_METERS;
}
