import type { SpatialPoint2 } from "../spatial/types";

/**
 * PASSENGER TRAINS FROM OUTSIDE (speedrun "train move-in"; 新攻略补充: an engine mechanism — once trains unlock, the first priority is a station
 * on the outside railway).
 *
 * Measured live 2026-10-05 (萨利克斯): the map ships its own railway (92 native track edges crossing the map from z=-7172 to z=+7172), about 430 m
 * beyond the owned land's east edge; the stations and tracks are locked at milestones 2-3. A station's own tracks are sub-nets the building owns
 * (excluded from the plain road listing), so the Bridge was given `ownerIndex/ownerVersion` on `/city/roads` to read them, with node degrees (1 = a
 * free end). NOT YET RUN LIVE: the Bridge read loads only after a game restart, and trains were locked on the test save. Every geometric guess below
 * (which way a station's tracks run, how far it stands from the line) is checked against the world after placement, and undone if it is wrong.
 *
 * Steps: the native railway's node nearest the served streets; the station between that node and the city, its front (the road side) facing the
 * city; its own track ends read back; each side's end joined by a new track to a native rail node ahead along the line (a shallow merge); the
 * station's front joined to the nearest street. Land a piece needs and the city does not own is bought as a strategic channel (P5 reason 1).
 */

/** Distances (station centre to the rail line) tried, in turn. */
export const STATION_RAIL_OFFSETS_METERS: readonly number[] = [55, 75, 100];
/** A merge joins the main line at a native node at least this far along the line beyond the station's end (keeps the junction angle shallow). */
export const MERGE_MINIMUM_ALONG_METERS = 120;
export const MERGE_MAXIMUM_ALONG_METERS = 600;
/** A rail node farther than this from every served street is not reached for. */
export const RAIL_MAXIMUM_DISTANCE_METERS = 1_400;
export const TRAIN_LINK_MAXIMUM_ATTEMPTS = 3;
export const STATION_ROAD_PREFAB = "Medium Road";

export interface RailEdge { start: SpatialPoint2; end: SpatialPoint2; native?: boolean }

const keyOf = (point: SpatialPoint2) => `${Math.round(point.x * 10)},${Math.round(point.z * 10)}`;
const distance = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);
const unit = (from: SpatialPoint2, to: SpatialPoint2) => { const length = distance(from, to) || 1; return { x: (to.x - from.x) / length, z: (to.z - from.z) / length }; };

export interface RailAnchor {
  /** The native rail node nearest the served streets. */
  node: SpatialPoint2;
  /** The line's direction there (unit). */
  along: SpatialPoint2;
  /** Unit vector from the line toward the city. */
  toCity: SpatialPoint2;
  /** The served street node nearest it, and how far. */
  street: SpatialPoint2;
  streetMeters: number;
  /** Every node of the native line (for the merges). */
  railNodes: SpatialPoint2[];
}

/** Where the city meets the map's railway: the native rail node nearest a served street node. Null: no native railway within reach. */
export function railAnchor(edges: readonly RailEdge[], servedNodes: readonly SpatialPoint2[]): RailAnchor | null {
  const native = edges.filter((edge) => edge.native !== false);
  if (native.length === 0 || servedNodes.length === 0) return null;
  const nodes = new Map<string, { point: SpatialPoint2; neighbours: SpatialPoint2[] }>();
  for (const edge of native) {
    for (const [here, there] of [[edge.start, edge.end], [edge.end, edge.start]] as const) {
      const entry = nodes.get(keyOf(here)) ?? { point: here, neighbours: [] };
      entry.neighbours.push(there);
      nodes.set(keyOf(here), entry);
    }
  }
  let best: { entry: { point: SpatialPoint2; neighbours: SpatialPoint2[] }; street: SpatialPoint2; meters: number } | null = null;
  for (const entry of nodes.values()) {
    for (const street of servedNodes) {
      const meters = distance(entry.point, street);
      if (!best || meters < best.meters) best = { entry, street, meters };
    }
  }
  if (!best || best.meters > RAIL_MAXIMUM_DISTANCE_METERS) return null;
  const [first, second] = best.entry.neighbours;
  const along = second ? unit(first!, second) : unit(best.entry.point, first!);
  // The perpendicular that points toward the city.
  let toCity = { x: -along.z, z: along.x };
  if ((best.street.x - best.entry.point.x) * toCity.x + (best.street.z - best.entry.point.z) * toCity.z < 0) toCity = { x: -toCity.x, z: -toCity.z };
  return { node: best.entry.point, along, toCity, street: best.street, streetMeters: best.meters, railNodes: [...nodes.values()].map((entry) => entry.point) };
}

/** CS2 yaw (degrees, 0 faces +Z, positive toward +X) for a building whose front faces `direction`. */
export function yawFacing(direction: SpatialPoint2): number {
  return ((Math.atan2(direction.x, direction.z) * 180) / Math.PI + 360) % 360;
}

/** Station sites beside the anchor: on the city side of the line, front toward the city, then the same turned a quarter (tracks the other way). */
export function stationSites(anchor: RailAnchor): Array<{ position: SpatialPoint2; rotation: number }> {
  const facing = yawFacing(anchor.toCity);
  const sites: Array<{ position: SpatialPoint2; rotation: number }> = [];
  for (const offset of STATION_RAIL_OFFSETS_METERS) {
    sites.push({ position: { x: anchor.node.x + anchor.toCity.x * offset, z: anchor.node.z + anchor.toCity.z * offset }, rotation: facing });
  }
  return sites;
}

export interface OwnedTrack { start: SpatialPoint2; end: SpatialPoint2; startDegree: number; endDegree: number; prefab: string }

/** The station's free track ends (a node only its own track reaches), split by which way along the line they lie from the station's centre. */
export function stationTrackEnds(tracks: readonly OwnedTrack[], centre: SpatialPoint2, along: SpatialPoint2): { ahead: SpatialPoint2[]; behind: SpatialPoint2[]; parallel: boolean } {
  const free: SpatialPoint2[] = [];
  for (const track of tracks.filter((entry) => /Train Track/i.test(entry.prefab))) {
    if (track.startDegree === 1) free.push(track.start);
    if (track.endDegree === 1) free.push(track.end);
  }
  const project = (point: SpatialPoint2) => (point.x - centre.x) * along.x + (point.z - centre.z) * along.z;
  const ahead = free.filter((point) => project(point) > 0);
  const behind = free.filter((point) => project(point) < 0);
  // The station's tracks run with the line when its free ends spread along it more than across it.
  const spread = (axis: SpatialPoint2) => free.length < 2 ? 0 : Math.max(...free.map((point) => (point.x - centre.x) * axis.x + (point.z - centre.z) * axis.z)) -
    Math.min(...free.map((point) => (point.x - centre.x) * axis.x + (point.z - centre.z) * axis.z));
  const parallel = spread(along) > spread({ x: -along.z, z: along.x });
  return { ahead, behind, parallel };
}

/** Native rail nodes a merge from `end` may join: beyond it along the line by MERGE_MINIMUM..MAXIMUM, nearest first. */
export function mergeTargets(end: SpatialPoint2, sign: 1 | -1, anchor: RailAnchor): SpatialPoint2[] {
  return anchor.railNodes
    .map((node) => ({ node, along: ((node.x - end.x) * anchor.along.x + (node.z - end.z) * anchor.along.z) * sign }))
    .filter((entry) => entry.along >= MERGE_MINIMUM_ALONG_METERS && entry.along <= MERGE_MAXIMUM_ALONG_METERS)
    .sort((left, right) => left.along - right.along)
    .map((entry) => entry.node);
}

export interface TrainLinkPort {
  railEdges(signal?: AbortSignal): Promise<RailEdge[]>;
  /** Unlocked passenger station prefabs (through stations first) and the unlocked track prefab; empty / null while locked. */
  stationPrefabs(signal?: AbortSignal): Promise<string[]>;
  trackPrefab(signal?: AbortSignal): Promise<string | null>;
  listStations(prefab: string, signal?: AbortSignal): Promise<Array<{ entity: { index: number; version: number }; position: SpatialPoint2 }>>;
  preflight(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<boolean | null>;
  place(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** The track (and other net) edges the building owns, with node degrees. Null: the Bridge cannot read them (an older Bridge). */
  ownedTracks(entity: { index: number; version: number }, signal?: AbortSignal): Promise<OwnedTrack[] | null>;
  /** Where the building's front meets the street side (the game's own frontage point). */
  frontage(entity: { index: number; version: number }, signal?: AbortSignal): Promise<SpatialPoint2 | null>;
  lay(prefab: string, from: SpatialPoint2, to: SpatialPoint2, signal?: AbortSignal): Promise<{ ok: boolean; detail: string; created?: Array<{ index: number; version: number }> }>;
  remove(entity: { index: number; version: number }, signal?: AbortSignal): Promise<boolean>;
}

export interface TrainLinkInput {
  servedNodes: readonly SpatialPoint2[];
  isOwned(point: SpatialPoint2): boolean;
  /** Buy the tile under this point as a strategic channel (the caller applies the cash rules). True: owned now. */
  acquire(point: SpatialPoint2): Promise<boolean>;
  signal?: AbortSignal;
}

export type TrainLinkOutcome = { status: "LINKED"; station: { index: number; version: number }; at: SpatialPoint2 }
  | { status: "LOCKED" | "STANDING" | "NO_RAILWAY" | "NO_LAND" | "NO_SITE" | "NO_TRACK_READ" | "LINK_FAILED" };

/** One attempt to put a passenger station on the map's railway and join it to the city. */
export async function linkTrainStation(port: TrainLinkPort, input: TrainLinkInput, notes: string[]): Promise<TrainLinkOutcome> {
  const signal = input.signal;
  const stations = await port.stationPrefabs(signal);
  const track = await port.trackPrefab(signal);
  if (stations.length === 0 || !track) return { status: "LOCKED" };
  for (const prefab of stations) {
    if ((await port.listStations(prefab, signal)).length > 0) { notes.push(`train: a ${prefab} already stands`); return { status: "STANDING" }; }
  }
  const anchor = railAnchor(await port.railEdges(signal), input.servedNodes);
  if (!anchor) { notes.push(`train: unlocked, but no native railway within ${RAIL_MAXIMUM_DISTANCE_METERS} m of a served street`); return { status: "NO_RAILWAY" }; }
  const prefab = stations[0]!;
  const ensureOwned = async (points: readonly SpatialPoint2[]) => {
    for (const point of points) if (!input.isOwned(point) && !(await input.acquire(point))) return false;
    return true;
  };
  for (const site of stationSites(anchor)) {
    if (signal?.aborted) break;
    // The station, the line beside it and the way to the street all stand on land the city must own.
    if (!(await ensureOwned([site.position, anchor.node, anchor.street]))) { notes.push(`train: the land at the railway (${anchor.node.x.toFixed(0)},${anchor.node.z.toFixed(0)}) is not owned and was not bought`); return { status: "NO_LAND" }; }
    for (const rotation of [site.rotation, (site.rotation + 90) % 360]) {
      if (await port.preflight(prefab, site.position, rotation, signal) !== true) continue;
      if (!(await port.place(prefab, site.position, rotation, signal)).ok) continue;
      const standing = (await port.listStations(prefab, signal)).find((item) => distance(item.position, site.position) < 8);
      if (!standing) { notes.push(`train: ${prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) did not read back`); return { status: "LINK_FAILED" }; }
      const created: Array<{ index: number; version: number }> = [];
      const takeDown = async (why: string) => {
        for (const net of created) await port.remove(net, signal);
        const removed = await port.remove(standing.entity, signal);
        notes.push(`train: ${prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) rot ${rotation.toFixed(0)} ${why}; ${removed ? "taken down" : "could not be taken down"} with ${created.length} piece(s)`);
      };
      const tracks = await port.ownedTracks(standing.entity, signal);
      if (tracks === null) { await takeDown("— its own tracks cannot be read (the Bridge needs the owner read; restart the game after the Bridge build)"); return { status: "NO_TRACK_READ" }; }
      const ends = stationTrackEnds(tracks, site.position, anchor.along);
      if (!ends.parallel || ends.ahead.length === 0 || ends.behind.length === 0) { await takeDown(`— its tracks do not run with the line (${ends.ahead.length} ahead, ${ends.behind.length} behind)`); continue; }
      let joined = 0;
      for (const [side, sign] of [[ends.ahead, 1], [ends.behind, -1]] as const) {
        const end = side[0]!;
        for (const target of mergeTargets(end, sign, anchor).slice(0, 3)) {
          if (!(await ensureOwned([target]))) break;
          const laid = await port.lay(track, end, target, signal);
          created.push(...(laid.created ?? []));
          if (laid.ok) { joined += 1; break; }
        }
      }
      if (joined < 2) { await takeDown(`— joined the main line on ${joined} of 2 sides`); return { status: "LINK_FAILED" }; }
      const after = await port.ownedTracks(standing.entity, signal);
      const stillFree = after ? stationTrackEnds(after, site.position, anchor.along) : null;
      if (!stillFree || (stillFree.ahead.length >= ends.ahead.length && stillFree.behind.length >= ends.behind.length)) {
        await takeDown("— its track ends read back unjoined after the merges were laid");
        return { status: "LINK_FAILED" };
      }
      // Passengers walk and drive in from the street.
      const front = await port.frontage(standing.entity, signal);
      const street = [...input.servedNodes].sort((left, right) => distance(left, front ?? site.position) - distance(right, front ?? site.position))[0];
      let road = "no frontage read: the road access is left to the No Road Access repair";
      if (front && street) {
        const laid = await port.lay(STATION_ROAD_PREFAB, front, street, signal);
        created.push(...(laid.created ?? []));
        road = laid.ok ? `a road joins its front to the street at (${street.x.toFixed(0)},${street.z.toFixed(0)})` : `the road to its front was refused (${laid.detail.slice(0, 60)}); left to the No Road Access repair`;
      }
      notes.push(`train: ${prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) joined to the map's railway on both sides (P6 outside connection); ${road}`);
      return { status: "LINKED", station: standing.entity, at: site.position };
    }
  }
  notes.push(`train: no legal ${prefab} lot beside the railway at (${anchor.node.x.toFixed(0)},${anchor.node.z.toFixed(0)})`);
  return { status: "NO_SITE" };
}
