import type { SpatialPoint2, SpatialRoadEdge } from "../spatial/types";
import { civicSiteCandidates } from "./civic-service";

/**
 * SELLING THE SURPLUS POWER (speedrun "energy export"; 新攻略补充: export is a mechanism, not an exploit).
 *
 * The map ships its own high-voltage line from the map edge into the starting land; the city's turbines feed the low-voltage network the streets
 * carry, and nothing joins the two, so the surplus is simply lost. Measured live 2026-10-05 (萨利克斯, M2-M3, production 98k against consumption
 * 57-69k, export 0): a `TransformerStation01` beside the line end, its high-voltage marker joined to the line's own end node by a buried
 * `High-voltage Ground Cable` (start -16 m, end on the surface at the node's exact coordinates), and one low-voltage marker joined to a real street
 * NODE by a buried `Low-voltage Ground Cable` (-8 m) — export 35,577 and an `ExportElectricity` income of 8,789 a month two game hours later.
 * What did not work, and is why the order and depths below are what they are: a cable ending on a street point that is not a node (no street there,
 * or mid-edge) joined nothing; the low-voltage cable crossing the high-voltage one at the same depth was refused (lay low voltage first at -8,
 * high voltage under it at -16); an overhead line from the marker at the back of the lot crosses the transformer itself and is refused.
 *
 * The world decides every step (object preflight, the native build, the connector read-back); a transformer that does not read back joined on
 * both sides is taken down with the cables laid for it.
 */

/** Power is sold only out of headroom: production above consumption by this factor (the P7 headroom stays with the city). */
export const EXPORT_HEADROOM_FACTOR = 1.25;
/** A line end farther than this from a served street is not reached for (the cables would cross the city). */
export const LINE_END_MAXIMUM_DISTANCE_METERS = 420;
/** Transformer lots tried around the line end (object preflights). */
export const TRANSFORMER_MAXIMUM_PREFLIGHTS = 24;
/** Transformers placed (and taken down again) in one attempt before the next lot is left to a later look. */
export const TRANSFORMER_MAXIMUM_PLACEMENTS = 3;
/** Street nodes tried for the low-voltage side, nearest the marker first. */
export const LOW_VOLTAGE_TARGETS_TRIED = 4;
export const LOW_VOLTAGE_CABLE = "Low-voltage Ground Cable";
export const HIGH_VOLTAGE_CABLE = "High-voltage Ground Cable";
export const LOW_VOLTAGE_DEPTH_METERS = -8;
export const HIGH_VOLTAGE_DEPTHS_METERS: readonly number[] = [-16, -8];
const TRANSFORMER_SETBACKS_METERS: readonly number[] = [16, 22, 30, 40];

export interface PowerTrade { production: number; consumption: number; exported: number }

/** Is there a surplus that is not being sold? */
export function exportOpportunity(trade: PowerTrade | null): { sell: boolean; reason: string } {
  if (!trade) return { sell: false, reason: "the power trade could not be read" };
  if (trade.exported > 0) return { sell: false, reason: `power is already exported (${Math.round(trade.exported)})` };
  const spare = trade.production - trade.consumption * EXPORT_HEADROOM_FACTOR;
  return spare > 0 ? { sell: true, reason: `production ${Math.round(trade.production)} exceeds ${EXPORT_HEADROOM_FACTOR}x consumption ${Math.round(trade.consumption)} and nothing is exported` }
    : { sell: false, reason: `no surplus beyond the ${EXPORT_HEADROOM_FACTOR}x headroom` };
}

const key = (point: SpatialPoint2) => `${point.x.toFixed(1)},${point.z.toFixed(1)}`;

/**
 * Where the map's high-voltage line can be joined: its free ends (a node only one line edge reaches) on owned land, nearest a served street first;
 * failing a free end there, any of its nodes on owned land. Coordinates are the line's own, exactly: a cable must end ON the node.
 */
export function highVoltageLineEnds(lines: ReadonlyArray<{ start: SpatialPoint2; end: SpatialPoint2 }>, isOwned: (point: SpatialPoint2) => boolean,
  servedNodes: readonly SpatialPoint2[]): Array<{ point: SpatialPoint2; free: boolean; streetMeters: number }> {
  const degree = new Map<string, { point: SpatialPoint2; count: number }>();
  for (const line of lines) for (const point of [line.start, line.end]) {
    const entry = degree.get(key(point)) ?? { point, count: 0 };
    entry.count += 1;
    degree.set(key(point), entry);
  }
  const nearestStreet = (point: SpatialPoint2) => servedNodes.reduce((best, node) => Math.min(best, Math.hypot(node.x - point.x, node.z - point.z)), Infinity);
  return [...degree.values()].filter((entry) => isOwned(entry.point))
    .map((entry) => ({ point: entry.point, free: entry.count === 1, streetMeters: nearestStreet(entry.point) }))
    .filter((entry) => entry.streetMeters <= LINE_END_MAXIMUM_DISTANCE_METERS)
    .sort((left, right) => Number(right.free) - Number(left.free) || left.streetMeters - right.streetMeters);
}

export interface PowerExportPort {
  readTrade(signal?: AbortSignal): Promise<PowerTrade | null>;
  /** The high-voltage line edges standing in the world (the map's own and any laid since). */
  highVoltageLines(signal?: AbortSignal): Promise<Array<{ start: SpatialPoint2; end: SpatialPoint2 }>>;
  /** Unlocked transformer prefabs, best first. */
  transformerPrefabs(signal?: AbortSignal): Promise<string[]>;
  listFacilities(prefab: string, signal?: AbortSignal): Promise<Array<{ entity: { index: number; version: number }; position: SpatialPoint2 }>>;
  preflight(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<boolean | null>;
  place(prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** The facility's electricity markers: where each is, its voltage, and whether a net has joined it. */
  markers(entity: { index: number; version: number }, signal?: AbortSignal): Promise<Array<{ voltage: "High" | "Low"; position: SpatialPoint2; attached: boolean }> | null>;
  /** Lay a buried cable; `created` is what this call added, so a failed link takes exactly that down. */
  lay(prefab: string, from: SpatialPoint2, to: SpatialPoint2, startElevation: number, endElevation: number, signal?: AbortSignal):
    Promise<{ ok: boolean; detail: string; created?: Array<{ index: number; version: number }> }>;
  remove(entity: { index: number; version: number }, signal?: AbortSignal): Promise<boolean>;
}

export interface PowerExportInput {
  servedNodes: readonly SpatialPoint2[];
  servedEdges: readonly SpatialRoadEdge[];
  isOwned(point: SpatialPoint2): boolean;
  signal?: AbortSignal;
}

export type PowerExportOutcome =
  | { status: "LINKED"; prefab: string; entity: { index: number; version: number }; at: SpatialPoint2 }
  | { status: "STANDING" | "NOT_NEEDED" | "NO_LINE" | "NO_PREFAB" | "NO_SITE" | "LINK_FAILED" };

/** One attempt to join the city's low-voltage network to the map's high-voltage line through one transformer. */
export async function linkPowerExport(port: PowerExportPort, input: PowerExportInput, notes: string[]): Promise<PowerExportOutcome> {
  const signal = input.signal;
  const opportunity = exportOpportunity(await port.readTrade(signal));
  if (!opportunity.sell) { notes.push(`power export: ${opportunity.reason}`); return { status: "NOT_NEEDED" }; }
  const prefabs = await port.transformerPrefabs(signal);
  if (prefabs.length === 0) { notes.push("power export: no unlocked transformer"); return { status: "NO_PREFAB" }; }
  for (const prefab of prefabs) {
    if ((await port.listFacilities(prefab, signal)).length > 0) { notes.push(`power export: a ${prefab} already stands; its link is the world's answer`); return { status: "STANDING" }; }
  }
  const ends = highVoltageLineEnds(await port.highVoltageLines(signal), input.isOwned, input.servedNodes);
  if (ends.length === 0) { notes.push(`power export: ${opportunity.reason}, but no high-voltage line reaches owned land within ${LINE_END_MAXIMUM_DISTANCE_METERS} m of a street`); return { status: "NO_LINE" }; }
  const end = ends[0]!;
  const prefab = prefabs[0]!;
  const sites = civicSiteCandidates({ target: end.point, edges: input.servedEdges, setbacksMeters: TRANSFORMER_SETBACKS_METERS, maximumDistanceMeters: 300, maximumCandidates: 60 })
    .filter((site) => input.isOwned(site.position));
  let preflights = 0;
  let placements = 0;
  for (const site of sites) {
    if (signal?.aborted || preflights >= TRANSFORMER_MAXIMUM_PREFLIGHTS) break;
    preflights += 1;
    if (await port.preflight(prefab, site.position, site.rotation, signal) !== true) continue;
    const placed = await port.place(prefab, site.position, site.rotation, signal);
    if (!placed.ok) continue;
    const standing = (await port.listFacilities(prefab, signal)).find((item) => Math.hypot(item.position.x - site.position.x, item.position.z - site.position.z) < 6);
    if (!standing) { notes.push(`power export: ${prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) did not read back`); return { status: "LINK_FAILED" }; }
    const created: Array<{ index: number; version: number }> = [];
    const takeDown = async (why: string) => {
      for (const net of created) await port.remove(net, signal);
      const removed = await port.remove(standing.entity, signal);
      notes.push(`power export: ${prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) ${why}; ${removed ? "taken down" : "could not be taken down"} with ${created.length} cable(s)`);
    };
    const markers = await port.markers(standing.entity, signal);
    const high = markers?.find((marker) => marker.voltage === "High");
    const lows = markers?.filter((marker) => marker.voltage === "Low") ?? [];
    // A lot whose link fails is taken down and the next lot is tried (the cables of another lot take another path), a bounded number of times.
    const failed = async (why: string) => { await takeDown(why); placements += 1; return placements >= TRANSFORMER_MAXIMUM_PLACEMENTS; };
    if (!high || lows.length === 0) { if (await failed("has no readable high- and low-voltage markers")) return { status: "LINK_FAILED" }; continue; }
    // Low voltage first, at -8, to a real street node (a cable ending mid-street or on empty ground joins nothing).
    let lowJoined = false;
    for (const low of lows) {
      const targets = [...input.servedNodes].sort((left, right) => Math.hypot(left.x - low.position.x, left.z - low.position.z) - Math.hypot(right.x - low.position.x, right.z - low.position.z))
        .slice(0, LOW_VOLTAGE_TARGETS_TRIED);
      for (const target of targets) {
        const laid = await port.lay(LOW_VOLTAGE_CABLE, low.position, target, LOW_VOLTAGE_DEPTH_METERS, LOW_VOLTAGE_DEPTH_METERS, signal);
        created.push(...(laid.created ?? []));
        if (laid.ok) { lowJoined = true; break; }
      }
      if (lowJoined) break;
    }
    if (!lowJoined) { if (await failed("could not be joined to a street node on its low-voltage side")) return { status: "LINK_FAILED" }; continue; }
    // High voltage under it, onto the line's own end node, surfacing there.
    let highJoined = false;
    for (const depth of HIGH_VOLTAGE_DEPTHS_METERS) {
      const laid = await port.lay(HIGH_VOLTAGE_CABLE, high.position, end.point, depth, 0, signal);
      created.push(...(laid.created ?? []));
      if (laid.ok) { highJoined = true; break; }
    }
    if (!highJoined) { if (await failed(`could not be joined to the line end (${end.point.x.toFixed(0)},${end.point.z.toFixed(0)})`)) return { status: "LINK_FAILED" }; continue; }
    const after = await port.markers(standing.entity, signal);
    const joined = after !== null && after.some((marker) => marker.voltage === "High" && marker.attached) && after.some((marker) => marker.voltage === "Low" && marker.attached);
    if (!joined) { if (await failed("read back unjoined after its cables were laid")) return { status: "LINK_FAILED" }; continue; }
    notes.push(`power export: ${prefab} at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}) joins the streets to the map's high-voltage line at ` +
      `(${end.point.x.toFixed(0)},${end.point.z.toFixed(0)}) — ${opportunity.reason}; the export is read back on the next cycles`);
    return { status: "LINKED", prefab, entity: standing.entity, at: site.position };
  }
  if (placements > 0) return { status: "LINK_FAILED" };
  notes.push(`power export: no legal ${prefab} lot near the line end (${end.point.x.toFixed(0)},${end.point.z.toFixed(0)}); ${preflights} lots tried`);
  return { status: "NO_SITE" };
}
