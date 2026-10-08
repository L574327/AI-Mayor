/**
 * Bus lines (公交). What the guides agree on, and what this module does with it:
 *  - a bus line needs a bus depot: the depot's buses run every line, and building one is what unlocks the Bus Line tool (the game's "object built"
 *    requirement; the depot itself is placed by the care round, `district-services.ts` BUS_GAP_NOTICE);
 *  - lines run where people live to where they work and shop, and meet at a hub (the train station once one stands, else the city's heart): here,
 *    "spokes" from the hub out to the far edge of the street network in each direction, the direction with the most traffic icons first;
 *  - stops every few blocks (~400-500 m), not at every corner; a short line (a handful of stops each way) keeps the buses on time;
 *  - a stop serves the lane on its own side: the outbound stops stand on the right of the way out, the inbound ones on the right of the way back
 *    (right-hand traffic, the game's default), so the bus never detours to reach a stop.
 * The world is the authority: a direction an existing bus line already reaches is not served twice, an existing stop near a wanted one is used as it is,
 * and the game's own tools judge every stop and the line. A direction refused BUS_SECTOR_FAILURE_LIMIT times rests BUS_SECTOR_REST_HOURS.
 */
import type { SpatialPoint2 } from "../spatial/types";
import { stampElapsed, type GameStamp } from "./game-clock";
import type { EntityRef, TransitPort, TransitStop } from "./transit-lines";

/** People at which buses start to pay (guides: the first line once the town has a few thousand people and its first jams). */
export const BUS_MINIMUM_POPULATION = 2_000;
/** One more line for every this many people. */
export const BUS_PEOPLE_PER_LINE = 4_000;
/** Directions (spokes) round the hub. */
export const BUS_SECTORS = 6;
/** A spoke shorter than this is walked, not bused. */
export const BUS_MINIMUM_REACH_METERS = 600;
/** A spoke longer than this is cut (one line, not a cross-country trip). */
export const BUS_MAXIMUM_REACH_METERS = 3_000;
export const BUS_STOP_SPACING_METERS = 450;
/** Stops each way at most. */
export const BUS_STOPS_EACH_WAY = 4;
/** A street this far from a wanted stop point is not the stop's street. */
export const BUS_STOP_STREET_REACH_METERS = 80;
/** An existing bus stop this near a wanted one is used instead of placing another. */
export const BUS_STOP_REUSE_METERS = 40;
/** A direction counts as served when a bus line already stops this near its far end. */
export const BUS_SECTOR_SERVED_METERS = 350;
/** How far beside the street centre the wanted point is put, so the game snaps the stop to that side's sidewalk. */
export const BUS_STOP_SIDE_OFFSET_METERS = 6;
/** How far from the hub and from the far end the end stops stand (clear of the crossing). */
export const BUS_STOP_CLEAR_OF_CROSSING_METERS = 40;
export const BUS_REVIEW_HOURS = 4;
export const BUS_REVIEW_CYCLES = 8;
export const BUS_SECTOR_FAILURE_LIMIT = 2;
export const BUS_SECTOR_REST_HOURS = 48;
export const BUS_SECTOR_REST_CYCLES = 96;

export interface StreetEdge { start: SpatialPoint2; end: SpatialPoint2 }

export interface BusStopPlan { point: SpatialPoint2; outbound: boolean }
export interface BusSpoke { sector: number; far: SpatialPoint2; reach: number; stops: BusStopPlan[]; hotspots: number }

export interface BusPort extends TransitPort {
  stopPrefabs(type: string, signal?: AbortSignal): Promise<Array<{ name: string; locked: boolean }> | null>;
  placeStop(prefab: string, point: SpatialPoint2, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}

export function busLinesWanted(population: number | null): number {
  if (population === null || population < BUS_MINIMUM_POPULATION) return 0;
  return Math.min(BUS_SECTORS, Math.max(1, Math.floor(population / BUS_PEOPLE_PER_LINE)));
}

const distance = (left: SpatialPoint2, right: SpatialPoint2) => Math.hypot(left.x - right.x, left.z - right.z);

/** The nearest point of the streets to `point`, with the street's direction there; null when no street is within `reach`. */
export function streetFoot(point: SpatialPoint2, edges: readonly StreetEdge[], reach = BUS_STOP_STREET_REACH_METERS, travel?: SpatialPoint2): { foot: SpatialPoint2; direction: SpatialPoint2 } | null {
  let best: { foot: SpatialPoint2; direction: SpatialPoint2; score: number } | null = null;
  for (const edge of edges) {
    const dx = edge.end.x - edge.start.x; const dz = edge.end.z - edge.start.z; const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= 0) continue;
    const ratio = Math.max(0, Math.min(1, ((point.x - edge.start.x) * dx + (point.z - edge.start.z) * dz) / lengthSquared));
    const foot = { x: edge.start.x + ratio * dx, z: edge.start.z + ratio * dz };
    const away = distance(foot, point);
    if (away > reach) continue;
    const length = Math.sqrt(lengthSquared);
    const direction = { x: dx / length, z: dz / length };
    // At a crossing every street is as near: the one the bus runs along wins (a stop on the cross street would send the bus round the corner).
    const across = travel ? 1 - Math.abs(direction.x * travel.x + direction.z * travel.z) : 0;
    const score = away + across * 40;
    if (!best || score < best.score) best = { foot, direction, score };
  }
  return best ? { foot: best.foot, direction: best.direction } : null;
}

/** The point beside the street on the right of travelling `travel` (right-hand traffic: x right, z forward seen from above, right = (z, -x)). */
export function rightSideOf(foot: SpatialPoint2, streetDirection: SpatialPoint2, travel: SpatialPoint2, offset = BUS_STOP_SIDE_OFFSET_METERS): SpatialPoint2 {
  const sign = streetDirection.x * travel.x + streetDirection.z * travel.z >= 0 ? 1 : -1;
  const along = { x: streetDirection.x * sign, z: streetDirection.z * sign };
  return { x: foot.x + along.z * offset, z: foot.z - along.x * offset };
}

/**
 * The spokes from `hub`: in each of BUS_SECTORS directions the street node farthest from the hub (within BUS_MAXIMUM_REACH_METERS), and the stops along
 * the way there and back. Directions with more traffic icons (`hotspots`) first, then the longer ones.
 */
export function planBusSpokes(hub: SpatialPoint2, nodes: readonly SpatialPoint2[], edges: readonly StreetEdge[], hotspots: readonly SpatialPoint2[] = []): BusSpoke[] {
  const sectorOf = (point: SpatialPoint2) => {
    const angle = Math.atan2(point.z - hub.z, point.x - hub.x);
    return Math.floor(((angle + Math.PI) / (2 * Math.PI)) * BUS_SECTORS) % BUS_SECTORS;
  };
  const farthest = new Map<number, { point: SpatialPoint2; reach: number }>();
  for (const node of nodes) {
    const reach = distance(node, hub);
    if (reach > BUS_MAXIMUM_REACH_METERS) continue;
    const sector = sectorOf(node);
    const known = farthest.get(sector);
    if (!known || reach > known.reach) farthest.set(sector, { point: node, reach });
  }
  const spokes: BusSpoke[] = [];
  for (const [sector, { point: far, reach }] of farthest) {
    if (reach < BUS_MINIMUM_REACH_METERS) continue;
    const count = Math.min(BUS_STOPS_EACH_WAY, Math.max(2, Math.round(reach / BUS_STOP_SPACING_METERS) + 1));
    const out = { x: (far.x - hub.x) / reach, z: (far.z - hub.z) / reach };
    const back = { x: -out.x, z: -out.z };
    const stops: BusStopPlan[] = [];
    // The end stops stand BUS_STOP_CLEAR_OF_CROSSING_METERS inside the spoke: a stop on a crossing is refused or snaps to the cross street.
    const inner = Math.min(BUS_STOP_CLEAR_OF_CROSSING_METERS, reach / 4);
    const along = (fraction: number) => {
      const metres = inner + (reach - 2 * inner) * fraction;
      return { x: hub.x + out.x * metres, z: hub.z + out.z * metres };
    };
    for (let index = 0; index < count; index += 1) {
      const street = streetFoot(along(index / (count - 1)), edges, BUS_STOP_STREET_REACH_METERS, out);
      if (street) stops.push({ point: rightSideOf(street.foot, street.direction, out), outbound: true });
    }
    for (let index = count - 1; index >= 0; index -= 1) {
      const street = streetFoot(along(index / (count - 1)), edges, BUS_STOP_STREET_REACH_METERS, back);
      if (street) stops.push({ point: rightSideOf(street.foot, street.direction, back), outbound: false });
    }
    // Two stops that landed on the same spot (two wanted points with one street between them) are one stop.
    const distinct = stops.filter((stop, index) => !stops.slice(0, index).some((earlier) => earlier.outbound === stop.outbound && distance(earlier.point, stop.point) < 60));
    const hot = hotspots.filter((spot) => sectorOf(spot) === sector && distance(spot, hub) <= reach + 200).length;
    if (distinct.length >= 2) spokes.push({ sector, far, reach, stops: distinct, hotspots: hot });
  }
  return spokes.sort((left, right) => right.hotspots - left.hotspots || right.reach - left.reach);
}

export interface BusMemory { failures: Map<number, { count: number; at: GameStamp }> }
export const newBusMemory = (): BusMemory => ({ failures: new Map() });

export type BusOutcome =
  | { status: "TOO_SMALL" | "UNREADABLE" | "LINE_LOCKED" | "NO_STOP_PREFAB" | "ENOUGH" | "NO_SPOKE" | "STOPS_REFUSED" | "REFUSED" }
  | { status: "CREATED"; sector: number; stops: number };

const refOf = (entity: EntityRef) => `${entity.index}:${entity.version}`;

/**
 * The plain roadside stop: "EU_BusStop01" / "NA_BusStop01" ... (live 2026-10-08 the list also holds the road outside connections, placeholders and the
 * stop built into a station, none of which is placed on a sidewalk). Unlocked only; the plain stop before the one with a bicycle rack.
 */
export function roadsideBusStop(prefabs: ReadonlyArray<{ name: string; locked: boolean }> | null): string | null {
  const plain = (prefabs ?? []).filter((entry) => !entry.locked && /^(EU|NA)_BusStop(Bicycle)?\d+$/.test(entry.name));
  return plain.sort((left, right) => Number(/Bicycle/.test(left.name)) - Number(/Bicycle/.test(right.name)) || left.name.localeCompare(right.name))[0]?.name ?? null;
}

/** One bus line more, when the city is big enough for another and a direction is still unserved. */
export async function ensureBusLine(port: BusPort, context: {
  population: number | null; hub: SpatialPoint2; nodes: readonly SpatialPoint2[]; edges: readonly StreetEdge[]; hotspots?: readonly SpatialPoint2[];
  stamp: GameStamp; memory: BusMemory; mayWrite: () => boolean; signal?: AbortSignal;
}, notes: string[]): Promise<BusOutcome> {
  const { signal } = context;
  const wanted = busLinesWanted(context.population);
  if (wanted === 0) return { status: "TOO_SMALL" };
  const read = await port.lines(signal);
  const stops = await port.stops("Bus", signal);
  if (!read || !stops) { notes.push("bus: the Bridge cannot read lines or stops"); return { status: "UNREADABLE" }; }
  const busLines = read.lines.filter((line) => line.transportType === "Bus");
  const riders = busLines.reduce((sum, line) => sum + line.passengersOnBoard, 0);
  const linePrefab = (lines: typeof read.prefabs) => lines.find((entry) => entry.transportType === "Bus" && entry.passenger && !entry.locked)?.name ?? null;
  let prefab = linePrefab(read.prefabs);
  if (busLines.length >= wanted) {
    notes.push(`bus: ${busLines.length} line(s) run (${riders} riding now), as many as ${context.population ?? "?"} people want`);
    return { status: "ENOUGH" };
  }
  const served = (far: SpatialPoint2) => busLines.some((line) => line.stops.some((stop) => distance(stop.position, far) < BUS_SECTOR_SERVED_METERS));
  const resting = (sector: number) => {
    const failure = context.memory.failures.get(sector);
    return failure !== undefined && failure.count >= BUS_SECTOR_FAILURE_LIMIT && !stampElapsed(failure.at, context.stamp, BUS_SECTOR_REST_HOURS, BUS_SECTOR_REST_CYCLES);
  };
  const spoke = planBusSpokes(context.hub, context.nodes, context.edges, context.hotspots ?? []).find((candidate) => !served(candidate.far) && !resting(candidate.sector));
  if (!spoke) { notes.push(`bus: ${busLines.length} of ${wanted} line(s) run; every direction from the hub is served, too short, or resting after refusals`); return { status: "NO_SPOKE" }; }
  // The game's chain (read live 2026-10-08 from the unlock requirements): a bus depot built unlocks the stops; a stop built unlocks the Bus Line.
  // So a locked line with the stops unlocked goes ahead: placing this line's stops is what unlocks it.
  const stopPrefab = roadsideBusStop(await port.stopPrefabs("Bus", signal));
  if (!stopPrefab) {
    notes.push(prefab ? "bus: no unlocked bus stop object" : `bus: ${context.population ?? "?"} people want ${wanted} line(s), but the bus stops are locked (a bus depot unlocks them: the care round places one)`);
    return { status: prefab ? "NO_STOP_PREFAB" : "LINE_LOCKED" };
  }
  const fail = (why: string): BusOutcome => {
    const known = context.memory.failures.get(spoke.sector);
    const count = (known && !stampElapsed(known.at, context.stamp, BUS_SECTOR_REST_HOURS, BUS_SECTOR_REST_CYCLES) ? known.count : 0) + 1;
    context.memory.failures.set(spoke.sector, { count, at: context.stamp });
    notes.push(`bus: line toward (${spoke.far.x.toFixed(0)},${spoke.far.z.toFixed(0)}) ${why}; refusal ${count} of ${BUS_SECTOR_FAILURE_LIMIT} for this direction`);
    return { status: why.startsWith("stops") ? "STOPS_REFUSED" : "REFUSED" };
  };
  // Each wanted stop: an existing bus stop near it, else one placed there (the game snaps it to the sidewalk and judges it).
  const used = new Set<string>();
  const pick = (pool: readonly TransitStop[], point: SpatialPoint2, reach: number) => pool
    .filter((stop) => !used.has(refOf(stop.entity)) && distance(stop.position, point) <= reach)
    .sort((left, right) => distance(left.position, point) - distance(right.position, point))[0] ?? null;
  const waypoints: string[] = [];
  let placed = 0; let refused = 0;
  let known = stops;
  for (const plan of spoke.stops) {
    if (signal?.aborted) break;
    let stop = pick(known, plan.point, BUS_STOP_REUSE_METERS);
    if (!stop) {
      if (!context.mayWrite()) { notes.push("bus: the cycle's write budget or the money ran out while placing stops; the line waits"); return { status: "STOPS_REFUSED" }; }
      const result = await port.placeStop(stopPrefab, plan.point, signal);
      if (!result.ok) { refused += 1; continue; }
      placed += 1;
      known = (await port.stops("Bus", signal)) ?? known;
      stop = pick(known, plan.point, BUS_STOP_STREET_REACH_METERS);
      if (!stop) { refused += 1; continue; }
    }
    used.add(refOf(stop.entity));
    waypoints.push(refOf(stop.entity));
  }
  if (waypoints.length < 2) return fail(`stops refused (${refused} of ${spoke.stops.length} refused by the game)`);
  if (!prefab) {
    // The stops just built unlock the line (at the end of the frame): read again, and when it is still locked the stops stand and are used next look.
    prefab = linePrefab((await port.lines(signal))?.prefabs ?? []);
    if (!prefab) { notes.push(`bus: ${placed} stop(s) placed toward (${spoke.far.x.toFixed(0)},${spoke.far.z.toFixed(0)}); the Bus Line is not unlocked yet, the line is drawn next look`); return { status: "LINE_LOCKED" }; }
  }
  if (!context.mayWrite()) { notes.push(`bus: ${placed} stop(s) placed; the line waits for the next cycle's budget`); return { status: "STOPS_REFUSED" }; }
  let result = await port.createLine(prefab, waypoints, signal);
  if (!result.ok && /ROUTE_PATH_PENDING/.test(result.detail)) {
    // The pathfinder only finishes while the simulation runs: one short run, one retry.
    await port.runBriefly(signal);
    result = await port.createLine(prefab, waypoints, signal);
  }
  if (!result.ok) return fail(`refused by the game (${result.detail.replace(/\s+/g, " ").slice(0, 120)})`);
  context.memory.failures.delete(spoke.sector);
  notes.push(`bus: line ${busLines.length + 1} of ${wanted} created, hub (${context.hub.x.toFixed(0)},${context.hub.z.toFixed(0)}) -> (${spoke.far.x.toFixed(0)},${spoke.far.z.toFixed(0)}) and back, ` +
    `${waypoints.length} stops (${placed} new${refused > 0 ? `, ${refused} refused` : ""})${spoke.hotspots > 0 ? `, through ${spoke.hotspots} traffic icon(s)` : ""}`);
  return { status: "CREATED", sector: spoke.sector, stops: waypoints.length };
}
