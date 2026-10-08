/**
 * ROAD CARE — the Mayor's answers that work on the road network itself: traffic and road noise. Built the way the game works, not by "wider is
 * better" (the player, 2026-10-06: "路再宽也没用，游戏机制最重要"):
 *
 *   TRAFFIC  A queue grows back from its head, so the slow road is rarely the cause; the head is (cs2 traffic guides: "trace your worst jams
 *            upstream"). Each pass: the jammed corridors (named roads) from the game's own road-panel figures, walked to the intersection where the
 *            jam starts, and that intersection diagnosed, mechanism first:
 *              - an arterial stopped by traffic lights that serve only small side streets: the lights come off (the side streets yield);
 *              - a crossing where both directions carry heavy traffic and nothing controls it: traffic lights;
 *              - only when a two-lane road carries arterial traffic: the segment is re-laid in place one size up — and only when the game's own
 *                preview says no building is lost.
 *            Worn roads (maintenance), a jammed highway entrance (a second connection) are named as causes the Mayor cannot answer by a write.
 *            Every change is a TRIAL: the corridor's flow before it is kept, read again after a few game hours, and a change that made it worse is
 *            taken back (an intersection's control is restored).
 *   NOISE    The noise icons of a city like this hang on homes beside busy roads (measured live 2026-10-06: 14 of 14 within 36 m of a Medium Road,
 *            no industry within 250 m). In the game, trees on a road's sides cut the noise it makes, and sound barriers do on a highway (cs2 wiki,
 *            Pollution). The road beside each noisy home gets them, once. The root cause — the traffic — is the traffic pass's.
 *
 * Writes never reach into an area the player asked to keep (`protection.ts`). The world is the authority; what a restart of the run process would lose
 * (the running trials, what was already tried) is kept per world in the builder's memory (`RoadCareMemory`) so a trial is still judged and taken back.
 */
import type { SpatialPoint2 } from "../spatial/types";
import { stampElapsed, type GameStamp } from "./game-clock";
import { protection } from "./protection";
import type { ExperienceBook } from "./experience-book";

/** A trial's key as a kind of remedy ("control:nolights", "widen", "feed"), without the entity it was tried on. */
export const remedyFamily = (key: string): string => key.startsWith("control:") ? `control:${key.split(":").at(-1)}` : key.split(":")[0]!;

type Ref = { index: number; version: number };
const refKey = (ref: Ref) => `${ref.index}:${ref.version}`;

export interface TrafficEdge {
  entity: Ref; prefab: string | null; aggregate: Ref | null; startNode: Ref; endNode: Ref; position: SpatialPoint2;
  length: number; volume: number; flowPercent: number; wear: number;
}
export interface TrafficReading { cityFlowPercent: number | null; worst: TrafficEdge[] }
export interface NodeLeg {
  entity: Ref; prefab: string | null; road: boolean; startsHere: boolean; otherNode: Ref; length: number;
  flowA: number; flowB: number; volumeA: number; volumeB: number; wear: number;
}
export interface NodeReading { node: Ref; position: SpatialPoint2; trafficLights: boolean; roundabout: boolean; allWayStop: boolean; legs: NodeLeg[] }
export interface NearRoad { entity: Ref; prefab: string; start: SpatialPoint2; end: SpatialPoint2 }

/**
 * An intersection's control, as the game's node upgrades set it. `roundabout` makes the node a roundabout (the game derives the ring and its radius from
 * the node composition, as it does traffic lights; Bridge `/build/node?set=roundabout`, 2026-10-07): the guides' answer where two heavy streams meet and
 * at a highway ramp that ends in a street — traffic slows instead of stopping.
 */
export type NodeControl = "lights" | "nolights" | "stop" | "roundabout" | "default";

export interface RoadCarePort {
  near(point: SpatialPoint2, radius: number, signal?: AbortSignal): Promise<NearRoad[]>;
  upgrade(entity: Ref, upgrades: "trees" | "soundBarrier", signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  traffic(options: { limit?: number; minVolume?: number; aggregate?: number }, signal?: AbortSignal): Promise<TrafficReading | null>;
  /** Null when the Bridge has no intersection read (an older mod): the traffic pass then names the gap and acts on nothing. */
  node(node: Ref, signal?: AbortSignal): Promise<NodeReading | null>;
  replace(edge: Ref, prefab: string, preview: boolean, signal?: AbortSignal): Promise<{ ok: boolean; detail: string; buildingsDeleted: number | null }>;
  control(node: Ref, set: NodeControl, preview: boolean, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /**
   * Make a road prefab usable: true when it already is, or when the development points bought the node it needs (`tech-tree.ts`). Absent: nothing is unlocked,
   * and only prefabs the game already offers are used.
   */
  unlockRoad?(prefab: string, signal?: AbortSignal): Promise<boolean>;
}

/** A road counts as jammed below this share of its free speed, when it carries at least this daily volume. */
export const JAM_FLOW_PERCENT = 35;
export const JAM_MINIMUM_VOLUME = 150;
/** The corridor beyond the head moves at least this freely. */
export const FREE_FLOW_PERCENT = 60;
/** Lights on an arterial whose side streets carry less than this share of its volume hold the arterial for nothing. */
export const MINOR_CROSS_SHARE = 0.25;
/** A crossing whose other road carries at least this share of the arterial's volume, both jammed, needs control. */
export const MAJOR_CROSS_SHARE = 0.5;
/**
 * The arterial a jammed highway feeds is re-laid one size up in place, where the game's preview says no building is lost (live 2026-10-07: every jammed corridor
 * of a 14k city was a highway ending in a two-lane Medium Road; the Mayor named it "a planning task" and did nothing while 43 development points lay unspent and
 * the Large Roads node cost 2). The game judges it afterwards like any change.
 */
export const ARTERIAL_UP: ReadonlyArray<[RegExp, string]> = [[/^Medium Road$/i, "Large Road"], [/^Medium Road Divided$/i, "Large Road Divided"]];

/** Wear at or above this (0..10, NetCondition) makes the road itself slow: a maintenance cause. */
export const WORN_ROAD = 8;
/** Game hours a trial runs before its corridor is read again; how much worse (flow points) counts as worse. */
export const TRIAL_HOURS = 4;
export const TRIAL_CYCLES = 20;
export const TRIAL_WORSE_POINTS = 5;
/** Game hours between traffic passes (cycles when the clock cannot be read). */
export const TRAFFIC_PASS_HOURS = 2;
export const TRAFFIC_PASS_CYCLES = 10;
/** Nodes read along a jammed corridor per pass, and the intersections (3+ roads) among them that are enough. */
export const MAXIMUM_NODE_READS = 12;
export const MAXIMUM_JUNCTIONS = 6;
/** Pieces of one jammed corridor re-laid in a single trial. */
export const CORRIDOR_PIECES_PER_TRIAL = 8;
/** Roads planted per pass against noise. */
export const NOISE_ROADS_PER_PASS = 6;
export const NOISE_ROAD_REACH_METERS = 45;

const HIGHWAY = /Highway/i;
const NOT_A_STREET = /Cable|Pipe|Power ?line|Track|Tram|Train|Subway|Pedestrian|Path|Bicycle|Gravel|Quay/i;
/** Two-lane roads one size up: the in-place replacement the game's Replace mode makes. Only these are widened. */
export const ONE_SIZE_UP: ReadonlyArray<[RegExp, string]> = [[/^Small Road$/i, "Medium Road"], [/^Alley$/i, "Small Road"]];

const legVolume = (leg: NodeLeg) => leg.volumeA + leg.volumeB;
const legFlow = (leg: NodeLeg) => {
  const total = legVolume(leg);
  return total > 0 ? (leg.flowA * leg.volumeA + leg.flowB * leg.volumeB) / total : Math.min(leg.flowA, leg.flowB);
};

/** Bottleneck icons answered per pass, and how near an edge must be to an icon to be the road it is about. */
export const MAXIMUM_HOTSPOTS = 2;
export const HOTSPOT_REACH_METERS = 60;

/** The roads around each bottleneck icon, as corridors (the named road of the nearest edge, every read edge of it within reach). */
export function hotspotCorridors(reading: TrafficReading, hotspots: readonly SpatialPoint2[]): Array<{ aggregate: Ref | null; edges: TrafficEdge[]; lost: number; highway: boolean }> {
  const out: Array<{ aggregate: Ref | null; edges: TrafficEdge[]; lost: number; highway: boolean }> = [];
  for (const spot of hotspots) {
    const near = reading.worst.filter((edge) => Math.hypot(edge.position.x - spot.x, edge.position.z - spot.z) <= HOTSPOT_REACH_METERS)
      .sort((left, right) => Math.hypot(left.position.x - spot.x, left.position.z - spot.z) - Math.hypot(right.position.x - spot.x, right.position.z - spot.z));
    if (near.length === 0) continue;
    const key = near[0]!.aggregate ? refKey(near[0]!.aggregate) : null;
    if (key && out.some((corridor) => corridor.aggregate && refKey(corridor.aggregate) === key)) continue;
    out.push({ aggregate: near[0]!.aggregate, edges: near, lost: near.reduce((sum, edge) => sum + (100 - edge.flowPercent) * edge.volume, 0), highway: near.every((edge) => HIGHWAY.test(edge.prefab ?? "")) });
  }
  return out;
}

/** Jammed corridors: the worst edges grouped by their named road, the heaviest lost flow first. */
export function jammedCorridors(reading: TrafficReading): Array<{ aggregate: Ref | null; edges: TrafficEdge[]; lost: number; highway: boolean }> {
  const groups = new Map<string, { aggregate: Ref | null; edges: TrafficEdge[]; lost: number; highway: boolean }>();
  for (const edge of reading.worst) {
    if (edge.flowPercent >= JAM_FLOW_PERCENT || edge.volume < JAM_MINIMUM_VOLUME) continue;
    const key = edge.aggregate ? refKey(edge.aggregate) : `edge:${refKey(edge.entity)}`;
    const group = groups.get(key) ?? { aggregate: edge.aggregate, edges: [], lost: 0, highway: false };
    group.edges.push(edge);
    group.lost += (100 - edge.flowPercent) * edge.volume;
    group.highway ||= HIGHWAY.test(edge.prefab ?? "");
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.lost - left.lost);
}

/**
 * The intersections where a corridor's jam starts: nodes of its jammed edges where three or more roads meet, those at the boundary between a
 * jammed and a freely moving piece of the same road first (the head of the queue), then by the jammed volume they touch.
 */
export function headCandidates(corridor: readonly TrafficEdge[], allOfRoad: readonly TrafficEdge[]): Ref[] {
  const jammed = new Set(corridor.map((edge) => refKey(edge.entity)));
  const score = new Map<string, { ref: Ref; touchJam: number; touchFree: boolean }>();
  for (const edge of allOfRoad.length > 0 ? allOfRoad : corridor) {
    for (const node of [edge.startNode, edge.endNode]) {
      const entry = score.get(refKey(node)) ?? { ref: node, touchJam: 0, touchFree: false };
      if (jammed.has(refKey(edge.entity))) entry.touchJam += edge.volume;
      else if (edge.flowPercent >= FREE_FLOW_PERCENT) entry.touchFree = true;
      score.set(refKey(node), entry);
    }
  }
  return [...score.values()].filter((entry) => entry.touchJam > 0)
    .sort((left, right) => Number(right.touchFree) - Number(left.touchFree) || right.touchJam - left.touchJam)
    .map((entry) => entry.ref);
}

export type JunctionRemedy =
  | { kind: "CONTROL"; node: Ref; set: NodeControl; was: NodeControl; why: string }
  | { kind: "WIDEN"; edge: Ref; from: string; to: string; why: string }
  | { kind: "CAUSE"; why: string };

/**
 * What to do at one intersection of a jammed corridor, mechanism first. `corridor` are the entity keys of the corridor's own edges (the arterial);
 * the other legs are the crossing roads.
 */
export function diagnoseJunction(node: NodeReading, corridor: ReadonlySet<string>): JunctionRemedy[] {
  const roads = node.legs.filter((leg) => leg.road);
  const remedies: JunctionRemedy[] = [];
  if (roads.length < 2) return remedies;
  const main = roads.filter((leg) => corridor.has(refKey(leg.entity)));
  const cross = roads.filter((leg) => !corridor.has(refKey(leg.entity)));
  const mainVolume = Math.max(0, ...main.map(legVolume));
  const crossVolume = Math.max(0, ...cross.map(legVolume));
  const mainJammed = main.some((leg) => legFlow(leg) < JAM_FLOW_PERCENT && legVolume(leg) >= JAM_MINIMUM_VOLUME);
  const was: NodeControl = node.roundabout ? "roundabout" : node.allWayStop ? "stop" : node.trafficLights ? "lights" : "default";
  if (main.some((leg) => leg.wear >= WORN_ROAD)) {
    remedies.push({ kind: "CAUSE", why: `worn road (wear ${Math.max(...main.map((leg) => leg.wear)).toFixed(0)}/10): a worn road is slow — road maintenance (a depot) is the answer` });
  }
  if (node.roundabout) return remedies;
  if (roads.length >= 3 && mainJammed && cross.length > 0) {
    if ((node.trafficLights || node.allWayStop) && crossVolume < mainVolume * MINOR_CROSS_SHARE) {
      remedies.push({ kind: "CONTROL", node: node.node, set: "nolights", was,
        why: `${node.allWayStop ? "an all-way stop" : "traffic lights"} hold the arterial (${Math.round(mainVolume)}/day) for side streets of ${Math.round(crossVolume)}/day: removed, the side streets yield` });
    }
    // Two heavy streams meet (the cross street carries a real share of the arterial's traffic): a roundabout keeps both moving where lights stop one.
    if (crossVolume >= mainVolume * MINOR_CROSS_SHARE && cross.some((leg) => legFlow(leg) < JAM_FLOW_PERCENT)) {
      remedies.push({ kind: "CONTROL", node: node.node, set: "roundabout", was,
        why: `two heavy streams meet (${Math.round(mainVolume)} and ${Math.round(crossVolume)}/day): the junction becomes a roundabout, traffic slows instead of stopping` });
    }
    if (!node.trafficLights && !node.allWayStop && crossVolume >= mainVolume * MAJOR_CROSS_SHARE &&
      cross.some((leg) => legFlow(leg) < JAM_FLOW_PERCENT)) {
      remedies.push({ kind: "CONTROL", node: node.node, set: "lights", was,
        why: `two heavy streams cross uncontrolled (${Math.round(mainVolume)} and ${Math.round(crossVolume)}/day, both jammed): traffic lights` });
    }
  }
  for (const leg of main) {
    const up = ONE_SIZE_UP.find(([pattern]) => pattern.test(leg.prefab ?? ""));
    if (!up || legFlow(leg) >= JAM_FLOW_PERCENT || legVolume(leg) < JAM_MINIMUM_VOLUME) continue;
    remedies.push({ kind: "WIDEN", edge: leg.entity, from: leg.prefab ?? "?", to: up[1],
      why: `a two-lane ${leg.prefab} carries arterial traffic (${Math.round(legVolume(leg))}/day at ${Math.round(legFlow(leg))}%): re-laid in place as ${up[1]}` });
  }
  return remedies;
}

/** The roads beside noisy homes, each once: trees on a street, a sound barrier on a highway. */
export function noiseRoads(roadsNear: ReadonlyArray<{ icon: SpatialPoint2; roads: readonly NearRoad[] }>,
  done: ReadonlySet<string>): Array<{ road: NearRoad; upgrade: "trees" | "soundBarrier"; distance: number }> {
  const chosen = new Map<string, { road: NearRoad; upgrade: "trees" | "soundBarrier"; distance: number }>();
  for (const { icon, roads } of roadsNear) {
    for (const road of roads) {
      if (NOT_A_STREET.test(road.prefab) || done.has(roadPlaceKey(road))) continue;
      const distance = pointSegment(icon, road.start, road.end);
      if (distance > NOISE_ROAD_REACH_METERS) continue;
      const key = roadPlaceKey(road);
      const previous = chosen.get(key);
      if (!previous || distance < previous.distance) chosen.set(key, { road, upgrade: HIGHWAY.test(road.prefab) ? "soundBarrier" : "trees", distance });
    }
  }
  return [...chosen.values()].sort((left, right) => left.distance - right.distance);
}

/** A road segment by its place (a replaced or upgraded segment may come back as a new entity). */
export const roadPlaceKey = (road: { start: SpatialPoint2; end: SpatialPoint2 }) => {
  const [a, b] = [road.start, road.end].map((p) => `${Math.round(p.x)},${Math.round(p.z)}`).sort();
  return `${a}|${b}`;
};

function pointSegment(point: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2): number {
  const dx = b.x - a.x; const dz = b.z - a.z; const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.z - (a.z + t * dz));
}

const meanFlow = (edges: readonly TrafficEdge[]) => {
  const volume = edges.reduce((sum, edge) => sum + edge.volume, 0);
  return volume > 0 ? edges.reduce((sum, edge) => sum + edge.flowPercent * edge.volume, 0) / volume : null;
};

/** `watch`: the jammed edges the trial is judged on — the same edges before and after (the free part of the road would flatter any change). */
interface Trial { what: string; aggregate: Ref | null; watch: ReadonlySet<string>; before: number; at: GameStamp; revert: TrialRevert | null; key: string }
/** How a trial is taken back: an intersection's control is set back to what it was (the only revert a trial has; a widening is kept or judged by the game's preview). */
export interface TrialRevert { node: Ref; set: NodeControl }

/**
 * What a restart of the run process would lose, saved per world (`builder-memory.ts` carries it): the running trials with everything needed to judge and
 * undo them, the changes already tried (never repeated), the roads already planted against noise. A trial is judged from the game's own figures, so
 * the record only has to say what was done, where, and what the corridor read before.
 */
export interface RoadCareMemory {
  trials: Array<{ what: string; aggregate: Ref | null; watch: string[]; before: number; at: GameStamp; revert: TrialRevert | null; key: string }>;
  tried: string[];
  planted: string[];
}
export const ROAD_CARE_MEMORY_LIMITS = { trials: 40, tried: 400, planted: 800 } as const;

/**
 * The road-care pass of a cycle: noise first (cheap, never destructive), then traffic on its own period. The driver holds the trials and what
 * it already did; the decisions are the pure functions above.
 */
export class RoadCare {
  readonly #planted = new Set<string>();
  readonly #trials: Trial[] = [];
  readonly #tried = new Set<string>();
  #trafficAt: GameStamp | null = null;
  #nodeReadMissing = false;
  #worn: SpatialPoint2[] = [];

  /**
   * `memory` is what the run process wrote before it was restarted (null: nothing); `onChange` is called with the whole record after each change.
   * A trial whose game clock was unreadable restarts its cycle count from now (cycle counters begin again with the process).
   */
  constructor(private readonly port: RoadCarePort, memory: RoadCareMemory | null = null, private readonly onChange?: (memory: RoadCareMemory) => void,
    private readonly experience?: ExperienceBook) {
    if (!memory) return;
    for (const entry of memory.trials) {
      this.#trials.push({ ...entry, watch: new Set(entry.watch), at: entry.at.frame === null ? { frame: null, cycle: 0 } : entry.at });
    }
    for (const key of memory.tried) this.#tried.add(key);
    for (const key of memory.planted) this.#planted.add(key);
  }

  get trialsRunning(): number { return this.#trials.length; }
  /** The record a restart would need (also what `onChange` receives). */
  snapshot(): RoadCareMemory {
    return {
      trials: this.#trials.slice(-ROAD_CARE_MEMORY_LIMITS.trials).map((trial) => ({ what: trial.what, aggregate: trial.aggregate, watch: [...trial.watch], before: trial.before, at: trial.at, revert: trial.revert, key: trial.key })),
      tried: [...this.#tried].slice(-ROAD_CARE_MEMORY_LIMITS.tried),
      planted: [...this.#planted].slice(-ROAD_CARE_MEMORY_LIMITS.planted),
    };
  }
  #changed(): void { try { this.onChange?.(this.snapshot()); } catch { /* bookkeeping never stops the city */ } }
  /** Worn stretches of the jammed corridors the last traffic pass read: where road maintenance is wanted (the care round places a depot). */
  get wornPlaces(): readonly SpatialPoint2[] { return this.#worn; }

  async noise(icons: ReadonlyArray<{ type: string; x: number; z: number }>, notes: string[], spend: () => boolean, signal?: AbortSignal): Promise<number> {
    const noisy = icons.filter((icon) => /Noise/i.test(icon.type));
    if (noisy.length === 0) return 0;
    const reads: Array<{ icon: SpatialPoint2; roads: NearRoad[] }> = [];
    for (const icon of noisy.slice(0, 24)) {
      if (signal?.aborted) break;
      reads.push({ icon, roads: await this.port.near(icon, NOISE_ROAD_REACH_METERS + 30, signal).catch(() => []) });
    }
    const plan = noiseRoads(reads, this.#planted).slice(0, NOISE_ROADS_PER_PASS);
    let done = 0;
    for (const { road, upgrade } of plan) {
      if (signal?.aborted || !spend()) break;
      this.#planted.add(roadPlaceKey(road));
      if (protection.segment(road.start, road.end)) continue;
      const outcome = await this.port.upgrade(road.entity, upgrade, signal);
      if (outcome.ok) done += 1;
    }
    if (plan.length > 0) this.#changed();
    notes.push(`noise: ${noisy.length} noise icon(s) on homes; ${done} of ${plan.length} road(s) beside them given ${plan.some((entry) => entry.upgrade === "soundBarrier") ? "trees / sound barriers" : "trees"} ` +
      `(the game's own noise cut for a road); the traffic itself is the traffic pass's`);
    return done;
  }

  /** One traffic pass: evaluate the running trials, then at most one change per jammed corridor (two corridors at most). */
  async traffic(now: GameStamp, notes: string[], options: { force?: boolean; spend: () => boolean; mayWiden: boolean; signal?: AbortSignal; hotspots?: readonly SpatialPoint2[] }): Promise<number> {
    const { signal } = options;
    await this.#evaluate(now, notes, signal);
    if (!options.force && this.#trafficAt && !stampElapsed(this.#trafficAt, now, TRAFFIC_PASS_HOURS, TRAFFIC_PASS_CYCLES)) return 0;
    this.#trafficAt = now;
    const hotspots = (options.hotspots ?? []).filter((point) => !protection.circle(point, 30)).slice(0, MAXIMUM_HOTSPOTS);
    const reading = await this.port.traffic({ limit: hotspots.length > 0 ? 200 : 40, minVolume: 50 }, signal).catch(() => null);
    if (!reading) { notes.push("traffic: the road-panel figures could not be read"); return 0; }
    // The game's own "Traffic Bottleneck" icons name where the player sees the jam: the edges around each go first, as a corridor of their own.
    const atIcons = hotspotCorridors(reading, hotspots);
    const corridors = [...atIcons, ...jammedCorridors(reading).filter((corridor) => !atIcons.some((spot) => spot.aggregate && corridor.aggregate && refKey(spot.aggregate) === refKey(corridor.aggregate)))];
    if (atIcons.length > 0) notes.push(`traffic: ${atIcons.length} of ${hotspots.length} bottleneck icon(s) matched to the roads around them; their junctions are looked at first`);
    if (corridors.length === 0) {
      notes.push(`traffic: city flow ${reading.cityFlowPercent?.toFixed(0) ?? "?"}%; no corridor below ${JAM_FLOW_PERCENT}% with real volume`);
      return 0;
    }
    let changes = 0;
    const causes: string[] = [];
    this.#worn = corridors.flatMap((corridor) => corridor.edges).filter((edge) => edge.wear >= WORN_ROAD).map((edge) => edge.position);
    // A jammed highway can only be named (an interchange is a planning task, not a write): it does not use up one of the two places, or a city whose two
    // worst corridors are highways would never have its streets looked at (live 2026-10-06: every pass said "highway jammed" and wrote nothing).
    let looked = 0;
    for (const corridor of corridors) {
      if (signal?.aborted || looked >= 2 + Math.min(atIcons.length, 1)) break;
      const where = `${corridor.edges[0]!.prefab ?? "road"} at (${corridor.edges[0]!.position.x.toFixed(0)},${corridor.edges[0]!.position.z.toFixed(0)})`;
      const flowNow = meanFlow(corridor.edges) ?? 0;
      if (corridor.highway) {
        causes.push(`${where}: a highway jammed at ${flowNow.toFixed(0)}% — its exit/merge into the city is the head`);
        if (options.mayWiden && !this.#trials.some((trial) => trial.aggregate && corridor.aggregate && refKey(trial.aggregate) === refKey(corridor.aggregate))) {
          if (await this.#feedArterial(corridor, flowNow, where, now, options.spend, notes, causes, signal)) changes += 1;
        } else if (!options.mayWiden) causes.push(`${where}: the arterial it feeds could be widened — not done: widening needs the player's leave to change roads`);
        continue;
      }
      looked += 1;
      const changesAtStart = changes;
      if (this.#trials.some((trial) => trial.aggregate && corridor.aggregate && refKey(trial.aggregate) === refKey(corridor.aggregate))) {
        causes.push(`${where}: a change on this road is still being judged`);
        continue;
      }
      const allOfRoad = corridor.aggregate ? (await this.port.traffic({ aggregate: corridor.aggregate.index }, signal).catch(() => null))?.worst ?? [] : [];
      const corridorKeys = new Set((allOfRoad.length > 0 ? allOfRoad : corridor.edges).map((edge) => refKey(edge.entity)));
      // Every intersection along the jam is looked at (a stretch between two junctions is only a road), the remedies gathered, and the one the
      // mechanism ranks first is tried: lights off where they hold the arterial, then lights where two heavy streams cross, then widening.
      // Measured live 2026-10-06: looking at the first four nodes only, all plain bends, missed every over-lit junction of a corridor.
      const found: Array<Exclude<JunctionRemedy, { kind: "CAUSE" }>> = [];
      let junctions = 0;
      for (const head of headCandidates(corridor.edges, allOfRoad).slice(0, MAXIMUM_NODE_READS)) {
        if (signal?.aborted || junctions >= MAXIMUM_JUNCTIONS) break;
        const node = await this.port.node(head, signal).catch(() => null);
        if (!node) { this.#nodeReadMissing = true; break; }
        if (node.legs.filter((leg) => leg.road).length >= 3) junctions += 1;
        if (protection.circle(node.position, 30)) continue;
        for (const remedy of diagnoseJunction(node, corridorKeys)) {
          // A cause is said once per corridor (every worn stretch of one road is the same cause).
          if (remedy.kind === "CAUSE") { const kind = remedy.why.split(" (")[0]!; if (!causes.some((cause) => cause.startsWith(`${where}: ${kind}`))) causes.push(`${where}: ${remedy.why}`); continue; }
          found.push(remedy);
        }
      }
      // The mechanism's order (lights off where they hold the arterial, then lights where streams cross, then widening), and the recorder's: a kind of change
      // that has been tried enough and never helped goes behind the others (`experience-book.ts`).
      const family = (remedy: Exclude<JunctionRemedy, { kind: "CAUSE" }>) => remedy.kind === "CONTROL" ? `control:${remedy.set}` : "widen";
      const learnt = (remedy: Exclude<JunctionRemedy, { kind: "CAUSE" }>) => { const score = this.experience?.score("traffic", corridor.highway ? "highway" : "street", family(remedy)) ?? null; return score !== null && score < 0.25 ? 10 : 0; };
      const rank = (remedy: Exclude<JunctionRemedy, { kind: "CAUSE" }>) => (remedy.kind === "CONTROL" ? (remedy.set === "nolights" ? 0 : remedy.set === "roundabout" ? 1 : 2) : 3) + learnt(remedy);
      for (const remedy of found.sort((left, right) => rank(left) - rank(right))) {
        if (signal?.aborted) break;
        const key = remedy.kind === "CONTROL" ? `control:${refKey(remedy.node)}:${remedy.set}` : `widen:${refKey(remedy.edge)}`;
        if (this.#tried.has(key)) continue;
        if (remedy.kind === "WIDEN" && !options.mayWiden) { causes.push(`${where}: ${remedy.why} — not done: widening needs the player's leave to change roads`); continue; }
        if (!options.spend()) break;
        this.#tried.add(key);
        const outcome = remedy.kind === "CONTROL" ? await this.#control(remedy, signal) : await this.#widen(remedy, signal);
        notes.push(`traffic: ${where} (${flowNow.toFixed(0)}%): ${remedy.why} — ${outcome.ok ? "done, judged again in a few game hours" : `the game refused: ${outcome.detail.slice(0, 90)}`}`);
        if (!outcome.ok) { this.experience?.record("traffic", corridor.highway ? "highway" : "street", family(remedy), "REFUSED"); continue; }
        changes += 1;
        this.#trials.push({ what: remedy.why, aggregate: corridor.aggregate, watch: new Set(corridor.edges.map((entry) => refKey(entry.entity))), before: flowNow, at: now, key,
          revert: remedy.kind === "CONTROL" ? { node: remedy.node, set: remedy.was } : null });
        this.#changed();
        break;
      }
      // Nothing at the junctions answered it: the whole corridor is the problem (live 2026-10-07: a Medium Road ring at 9% on 450 cars a day; a roundabout
      // at one junction moved it 9% -> 11%). The whole run is re-laid one size up in place, as ONE trial.
      if (changes === changesAtStart && options.mayWiden && !this.#nodeReadMissing) {
        if (await this.#widenCorridor(corridor, allOfRoad, flowNow, where, now, options.spend, notes, causes, signal)) changes += 1;
      }
    }
    if (this.#nodeReadMissing) notes.push("traffic: the game mod in use has no intersection read (cs2_traffic_node); install the current mod and restart the game to let the Mayor work on junctions");
    for (const cause of causes.slice(0, 3)) notes.push(`traffic: ${cause}`);
    if (changes === 0 && causes.length === 0 && !this.#nodeReadMissing) notes.push(`traffic: ${corridors.length} jammed corridor(s); no intersection change the rules back at their heads`);
    return changes;
  }

  /**
   * A jammed street corridor re-laid one size up along its whole length (`ARTERIAL_UP`: Medium Road -> Large Road, Divided -> Divided), once per named
   * road, after the larger road is unlocked. Only pieces that carry real volume (`JAM_MINIMUM_VOLUME`) and move badly; each is previewed and laid only when
   * the preview says 0 buildings are lost. One trial for the run: the corridor flow is read again after the trial hours and the verdict goes to the
   * experience book either way. Returns whether anything was changed.
   */
  async #widenCorridor(corridor: { aggregate: Ref | null; edges: TrafficEdge[] }, allOfRoad: readonly TrafficEdge[], flowNow: number, where: string, now: GameStamp,
    spend: () => boolean, notes: string[], causes: string[], signal?: AbortSignal): Promise<boolean> {
    const runKey = `corridor:${corridor.aggregate ? refKey(corridor.aggregate) : refKey(corridor.edges[0]!.entity)}`;
    if (this.#tried.has(runKey)) return false;
    const pieces = (allOfRoad.length > 0 ? allOfRoad : corridor.edges)
      .filter((edge) => ARTERIAL_UP.some(([from]) => from.test(edge.prefab ?? "")) && edge.flowPercent < JAM_FLOW_PERCENT && edge.volume >= JAM_MINIMUM_VOLUME && !protection.circle(edge.position, 30))
      .sort((left, right) => (left.flowPercent * 1000 - left.volume) - (right.flowPercent * 1000 - right.volume))
      .slice(0, CORRIDOR_PIECES_PER_TRIAL);
    if (pieces.length < 2) return false;
    if (!spend()) return false;
    this.#tried.add(runKey);
    this.#changed();
    const target = ARTERIAL_UP.find(([from]) => from.test(pieces[0]!.prefab ?? ""))![1];
    if (this.port.unlockRoad && !(await this.port.unlockRoad(target, signal))) { causes.push(`${where}: ${target} is not unlocked and the development points do not buy it`); return false; }
    let done = 0;
    let refused = 0;
    for (const piece of pieces) {
      if (signal?.aborted) break;
      const to = ARTERIAL_UP.find(([from]) => from.test(piece.prefab ?? ""))?.[1];
      if (!to) continue;
      const outcome = await this.#widen({ kind: "WIDEN", edge: piece.entity, from: piece.prefab ?? "?", to, why: "" }, signal);
      if (outcome.ok) done += 1; else refused += 1;
    }
    const why = `the ${pieces[0]!.prefab} corridor is slow from end to end (${Math.round(flowNow)}%): ${done} of ${pieces.length} pieces re-laid as ${target}${refused > 0 ? ` (${refused} refused: a building or the rules of the game)` : ""}`;
    notes.push(`traffic: ${where} (${flowNow.toFixed(0)}%): ${why} — ${done > 0 ? "done, judged again in a few game hours" : "nothing could be laid"}`);
    if (done === 0) { this.experience?.record("traffic", "street", "corridor", "REFUSED"); return false; }
    this.#trials.push({ what: why, aggregate: corridor.aggregate, watch: new Set(pieces.map((entry) => refKey(entry.entity))), before: flowNow, at: now, key: runKey, revert: null });
    this.#changed();
    return true;
  }
  /**
   * The roads where a jammed highway meets the city: the first not-yet-tried one of a size ARTERIAL_UP has a larger road for is re-laid in place (Replace
   * mode: the preview must say 0 buildings lost), after the larger road has been made usable. One change per pass; the corridor's flow is judged after
   * the trial hours like every other change. Returns whether a road was changed.
   */
  async #feedArterial(corridor: { aggregate: Ref | null; edges: TrafficEdge[] }, flowNow: number, where: string, now: GameStamp, spend: () => boolean, notes: string[], causes: string[], signal?: AbortSignal): Promise<boolean> {
    const nodes = new Map<string, Ref>();
    for (const edge of corridor.edges) { nodes.set(refKey(edge.startNode), edge.startNode); nodes.set(refKey(edge.endNode), edge.endNode); }
    let reads = 0;
    for (const ref of nodes.values()) {
      if (reads >= MAXIMUM_NODE_READS || signal?.aborted) break;
      reads += 1;
      const node = await this.port.node(ref, signal).catch(() => null);
      if (!node || protection.circle(node.position, 30)) continue;
      if (!node.legs.some((leg) => leg.road && HIGHWAY.test(leg.prefab ?? ""))) continue;
      // Where a ramp ends in the city's streets (the T the guides warn about): a roundabout first, the wider street after.
      const roundaboutKey = `control:${refKey(node.node)}:roundabout`;
      if (!node.roundabout && node.legs.filter((leg) => leg.road).length >= 3 && !this.#tried.has(roundaboutKey) && !protection.circle(node.position, 60)) {
        if (!spend()) return false;
        this.#tried.add(roundaboutKey);
        this.#changed();
        const was: NodeControl = node.allWayStop ? "stop" : node.trafficLights ? "lights" : "default";
        const outcome = await this.#control({ kind: "CONTROL", node: node.node, set: "roundabout", was, why: "" }, signal);
        const why = "the junction where a jammed highway ramp meets the streets becomes a roundabout";
        notes.push(`traffic: ${where} (${flowNow.toFixed(0)}%): ${why} — ${outcome.ok ? "done, judged again in a few game hours" : `the game refused: ${outcome.detail.slice(0, 90)}`}`);
        if (outcome.ok) {
          this.#trials.push({ what: why, aggregate: corridor.aggregate, watch: new Set(corridor.edges.map((entry) => refKey(entry.entity))), before: flowNow, at: now, key: roundaboutKey,
            revert: { node: node.node, set: was } });
          this.#changed();
          return true;
        }
        this.experience?.record("traffic", "highway", "control:roundabout", "REFUSED");
      }
      const fed = node.legs.filter((leg) => leg.road && !HIGHWAY.test(leg.prefab ?? "") && !NOT_A_STREET.test(leg.prefab ?? "")).sort((a, b) => legVolume(b) - legVolume(a));
      for (const leg of fed) {
        const target = ARTERIAL_UP.find(([from]) => from.test(leg.prefab ?? ""))?.[1];
        const key = `feed:${refKey(leg.entity)}`;
        if (!target || this.#tried.has(key)) continue;
        if (!spend()) return false;
        this.#tried.add(key);
        this.#changed();
        if (this.port.unlockRoad && !(await this.port.unlockRoad(target, signal))) { causes.push(`${where}: ${target} is not unlocked and the development points do not buy it`); continue; }
        const outcome = await this.#widen({ kind: "WIDEN", edge: leg.entity, from: leg.prefab ?? "?", to: target, why: "" }, signal);
        const why = `the ${leg.prefab} that a jammed highway ends in (${Math.round(legVolume(leg))}/day) re-laid as ${target}`;
        notes.push(`traffic: ${where} (${flowNow.toFixed(0)}%): ${why} — ${outcome.ok ? "done, judged again in a few game hours" : `the game refused: ${outcome.detail.slice(0, 90)}`}`);
        if (!outcome.ok) continue;
        this.#trials.push({ what: why, aggregate: corridor.aggregate, watch: new Set(corridor.edges.map((entry) => refKey(entry.entity))), before: flowNow, at: now, key, revert: null });
        this.#changed();
        return true;
      }
    }
    return false;
  }

  async #control(remedy: Extract<JunctionRemedy, { kind: "CONTROL" }>, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const preview = await this.port.control(remedy.node, remedy.set, true, signal);
    if (!preview.ok) return preview;
    return this.port.control(remedy.node, remedy.set, false, signal);
  }

  async #widen(remedy: Extract<JunctionRemedy, { kind: "WIDEN" }>, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const preview = await this.port.replace(remedy.edge, remedy.to, true, signal);
    if (!preview.ok) return preview;
    if (preview.buildingsDeleted === null || preview.buildingsDeleted > 0) {
      return { ok: false, detail: preview.buildingsDeleted === null ? "the preview did not say what it would delete" : `it would take down ${preview.buildingsDeleted} building(s)` };
    }
    return this.port.replace(remedy.edge, remedy.to, false, signal);
  }

  /** Trials whose time is up: read the corridor again; worse by more than TRIAL_WORSE_POINTS is taken back, the rest stays. */
  async #evaluate(now: GameStamp, notes: string[], signal?: AbortSignal): Promise<void> {
    for (const trial of [...this.#trials]) {
      if (!stampElapsed(trial.at, now, TRIAL_HOURS, TRIAL_CYCLES)) continue;
      this.#trials.splice(this.#trials.indexOf(trial), 1);
      this.#changed();
      const read = trial.aggregate ? await this.port.traffic({ aggregate: trial.aggregate.index }, signal).catch(() => null) : null;
      // A replaced segment comes back as a new entity: when none of the watched edges is found, the road's busy edges stand in.
      const watched = read ? read.worst.filter((edge) => trial.watch.has(refKey(edge.entity))) : [];
      const after = read ? meanFlow(watched.length > 0 ? watched : read.worst.filter((edge) => edge.volume >= JAM_MINIMUM_VOLUME)) : null;
      if (after === null) { notes.push(`traffic trial: "${trial.what.slice(0, 60)}" — its road could not be read again; kept`); continue; }
      const delta = after - trial.before;
      // The recorder: what this kind of change did to the flow it was meant to help (better / no change / worse).
      this.experience?.record("traffic", trial.key.startsWith("feed:") ? "highway" : "street", remedyFamily(trial.key),
        delta < -TRIAL_WORSE_POINTS ? "WORSE" : delta >= 3 ? "IMPROVED" : "NO_EFFECT");
      if (delta < -TRIAL_WORSE_POINTS && trial.revert) {
        const undone = await this.port.control(trial.revert.node, trial.revert.set, false, signal);
        this.#tried.add(trial.key);
        this.#changed();
        notes.push(`traffic trial: flow ${trial.before.toFixed(0)}% → ${after.toFixed(0)}% after "${trial.what.slice(0, 60)}": worse, ${undone.ok ? "taken back" : "could not be taken back"}`);
      } else {
        notes.push(`traffic trial: flow ${trial.before.toFixed(0)}% → ${after.toFixed(0)}% after "${trial.what.slice(0, 60)}": ${delta >= 3 ? "better, kept" : "no worse, kept"}`);
      }
    }
  }
}
