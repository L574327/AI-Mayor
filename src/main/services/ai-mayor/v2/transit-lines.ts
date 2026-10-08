/**
 * Public transport lines (攻略: a station without a line carries nobody; the line that brings people in from outside is the closed loop
 * "station platform -> outside connection -> back to the platform"). The world is the authority: a line that already joins one of our platforms to an
 * outside connection is never made twice, and the game's own route pipeline validates the line (Bridge `/transit/line/create`).
 */
import type { SpatialPoint2 } from "../spatial/types";

export interface EntityRef { index: number; version: number }

export interface TransitStop {
  entity: EntityRef;
  prefab: string | null;
  transportType: string | null;
  /** The stop belongs to an outside connection (the map-edge end of the railway). */
  outsideConnection: boolean;
  ownerPrefab: string | null;
  position: SpatialPoint2;
  waitingPassengers: number;
}

export interface TransitLine {
  entity: EntityRef;
  transportType: string | null;
  stops: Array<{ stop: EntityRef | null; position: SpatialPoint2; waitingPassengers: number }>;
  vehicleCount: number;
  passengersOnBoard: number;
  passengersWaiting: number;
}

export interface TransitLinePrefab { name: string; transportType: string; passenger: boolean; locked: boolean }

export interface TransitPort {
  stops(type: string, signal?: AbortSignal): Promise<TransitStop[] | null>;
  lines(signal?: AbortSignal): Promise<{ lines: TransitLine[]; prefabs: TransitLinePrefab[] } | null>;
  /** `ok` false with the Bridge's code in `detail` (ROUTE_PATH_PENDING, ROUTE_REJECTED_BY_GAME_VALIDATION ...). */
  createLine(prefab: string, stops: string[], signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** Let the simulation run a moment: the game's pathfinder (which finishes a new line) only works while it runs. */
  runBriefly(signal?: AbortSignal): Promise<void>;
}

export type TrainLoopOutcome =
  | { status: "EXISTS"; line: EntityRef; passengersOnBoard: number; passengersWaiting: number; platformAt: SpatialPoint2 }
  | { status: "CREATED"; platform: EntityRef; outside: EntityRef; platformAt: SpatialPoint2 }
  | { status: "UNREADABLE" | "NO_PLATFORM" | "NO_OUTSIDE_STOP" | "NO_PREFAB" | "REFUSED" };

const ref = (entity: EntityRef) => `${entity.index}:${entity.version}`;
const same = (left: EntityRef | null, right: EntityRef) => left !== null && left.index === right.index && left.version === right.version;

/** The passenger train line prefab the game lets us draw (unlocked, passenger, Train). */
export function trainLinePrefab(prefabs: readonly TransitLinePrefab[]): string | null {
  return prefabs.find((prefab) => prefab.transportType === "Train" && prefab.passenger && !prefab.locked)?.name ?? null;
}

/** Our platform and the outside-connection stop nearest to it; null when either side is missing. */
export function trainLoopStops(stops: readonly TransitStop[]): { platform: TransitStop | null; outside: TransitStop | null } {
  const platforms = stops.filter((stop) => !stop.outsideConnection);
  const outsides = stops.filter((stop) => stop.outsideConnection);
  let best: { platform: TransitStop; outside: TransitStop; distance: number } | null = null;
  for (const platform of platforms) {
    for (const outside of outsides) {
      const distance = Math.hypot(platform.position.x - outside.position.x, platform.position.z - outside.position.z);
      if (!best || distance < best.distance) best = { platform, outside, distance };
    }
  }
  return best ? { platform: best.platform, outside: best.outside } : { platform: platforms[0] ?? null, outside: null };
}

/** Make sure one passenger train line runs platform -> outside connection -> platform. */
export async function ensureTrainLoop(port: TransitPort, notes: string[], signal?: AbortSignal): Promise<TrainLoopOutcome> {
  const stops = await port.stops("Train", signal);
  const read = await port.lines(signal);
  if (!stops || !read) { notes.push("train line: the Bridge cannot read stops or lines (needs the transit Bridge build)"); return { status: "UNREADABLE" }; }
  const outsideStops = stops.filter((stop) => stop.outsideConnection);
  const platformStops = stops.filter((stop) => !stop.outsideConnection);
  const existing = read.lines.find((line) => line.transportType === "Train"
    && line.stops.some((stop) => platformStops.some((platform) => same(stop.stop, platform.entity)))
    && line.stops.some((stop) => outsideStops.some((outside) => same(stop.stop, outside.entity))));
  if (existing) {
    const platformAt = platformStops.find((platform) => existing.stops.some((stop) => same(stop.stop, platform.entity)))!.position;
    notes.push(`train line: stands (${existing.vehicleCount} trains, ${existing.passengersOnBoard} on board, ${existing.passengersWaiting} waiting)`);
    return { status: "EXISTS", line: existing.entity, passengersOnBoard: existing.passengersOnBoard, passengersWaiting: existing.passengersWaiting, platformAt };
  }
  const { platform, outside } = trainLoopStops(stops);
  if (!platform) { notes.push("train line: no passenger train platform stands yet"); return { status: "NO_PLATFORM" }; }
  if (!outside) { notes.push("train line: the platform stands, but the game shows no outside-connection train stop"); return { status: "NO_OUTSIDE_STOP" }; }
  const prefab = trainLinePrefab(read.prefabs);
  if (!prefab) { notes.push("train line: no unlocked passenger train line"); return { status: "NO_PREFAB" }; }
  const waypoints = [ref(platform.entity), ref(outside.entity)];
  let result = await port.createLine(prefab, waypoints, signal);
  if (!result.ok && /ROUTE_PATH_PENDING/.test(result.detail)) {
    // The pathfinder only finishes while the simulation runs: one short run, one retry.
    await port.runBriefly(signal);
    result = await port.createLine(prefab, waypoints, signal);
  }
  if (!result.ok) { notes.push(`train line: refused (${result.detail.slice(0, 140)})`); return { status: "REFUSED" }; }
  notes.push(`train line: created platform (${platform.position.x.toFixed(0)},${platform.position.z.toFixed(0)}) -> outside connection (${outside.position.x.toFixed(0)},${outside.position.z.toFixed(0)}) -> platform`);
  return { status: "CREATED", platform: platform.entity, outside: outside.entity, platformAt: platform.position };
}
