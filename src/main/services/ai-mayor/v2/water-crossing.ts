import type { SpatialLocalTerrain, SpatialPoint2 } from "../spatial/types";
import { sampleTerrain } from "./district-land";

/**
 * A BRIDGE TO LAND ACROSS THE WATER — what a player does when the map's water cuts the owned ground in two: draw one road over the water from the
 * served bank to the far bank, and go on building there.
 *
 * Measured live 2026-10-05 (a map whose river, 256 to 370 m wide and about 20 m deep, split the starting tiles): the game accepts and builds an
 * ordinary `Medium Road` straight across the river at elevation 0 (370 m, 11,268, six edges, completed), and the product's own district search never
 * offered the far bank because a street grid does not stand on water and no gateway reaches over it. This module finds where such a road would go.
 * It is pure: terrain, the served network and the free land in, a ranked list of crossings out. The game's own dry run and the world read-back decide.
 */

/** Longest stretch of open water one road is asked to cross. The measured river was 256 m; the game's own validation decides beyond what is known. */
export const MAXIMUM_BRIDGE_WATER_SPAN_METERS = 420;
/** A crossing's total length, bank anchor to far end, is bounded by the game's own segment limit (1,500 m) and by cost. */
export const MAXIMUM_BRIDGE_TOTAL_METERS = 700;
/** The road goes this far onto the far bank, so that its end stands on dry land the district search can reach. */
export const BRIDGE_FAR_BANK_RUN_METERS = 60;
/** Water deeper than this is open water (a puddle or a wet cell is not a river). */
export const BRIDGE_OPEN_WATER_DEPTH_METERS = 0.5;
/** The far bank must hold at least this many free lattice cells within `BRIDGE_FAR_LAND_RADIUS_METERS`, or it is not worth the road. */
export const MINIMUM_FAR_BANK_FREE_CELLS = 24;
export const BRIDGE_FAR_LAND_RADIUS_METERS = 240;
/** A far end with a served street this close is not stranded: the network reaches it without a bridge. */
export const BRIDGE_STRANDED_DISTANCE_METERS = 160;
const SAMPLE_STEP_METERS = 20;
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export interface WaterCrossing {
  /** The served bank: an existing street node. */
  from: SpatialPoint2;
  /** The far bank, on dry land. */
  to: SpatialPoint2;
  waterMeters: number;
  totalMeters: number;
  /** Free lattice cells around the far end: what the road opens. */
  farFreeCells: number;
}

export interface WaterCrossingInput {
  terrain: SpatialLocalTerrain | undefined;
  /** Nodes of the served street network: a bridge starts from one and nowhere else. */
  servedNodes: readonly SpatialPoint2[];
  isOwned(point: SpatialPoint2): boolean;
  /** Free lattice cells (district land) within `radius` of the point. */
  freeCellsAround(point: SpatialPoint2, radius: number): number;
  maximumSpanMeters?: number;
  limit?: number;
}

const wet = (terrain: SpatialLocalTerrain | undefined, point: SpatialPoint2): boolean | null => {
  const reading = sampleTerrain(terrain, point);
  return reading === null ? null : reading.waterDepth > BRIDGE_OPEN_WATER_DEPTH_METERS;
};

/**
 * Crossings from the served streets over open water to owned, free, stranded land, shortest water span first. Each direction from each served node is
 * walked in 20 m steps: dry, then water, then dry again for three steps. The whole line must be owned (a road cannot be laid on land nobody owns) and
 * must be read (a point outside the terrain read is not guessed).
 */
export function findWaterCrossings(input: WaterCrossingInput): WaterCrossing[] {
  const maximumSpan = input.maximumSpanMeters ?? MAXIMUM_BRIDGE_WATER_SPAN_METERS;
  const crossings: WaterCrossing[] = [];
  const seenAnchors = new Set<string>();
  for (const node of input.servedNodes) {
    const key = `${Math.round(node.x / 20)},${Math.round(node.z / 20)}`;
    if (seenAnchors.has(key)) continue;
    seenAnchors.add(key);
    for (const [dx, dz] of DIRECTIONS) {
      let waterStart: number | null = null;
      let waterEnd: number | null = null;
      let ok = true;
      for (let t = SAMPLE_STEP_METERS; t <= MAXIMUM_BRIDGE_TOTAL_METERS; t += SAMPLE_STEP_METERS) {
        const point = { x: node.x + dx * t, z: node.z + dz * t };
        const isWet = wet(input.terrain, point);
        if (isWet === null || !input.isOwned(point)) { ok = false; break; }
        if (waterStart === null) { if (isWet) waterStart = t; continue; }
        if (isWet) { if (t - waterStart > maximumSpan) { ok = false; break; } continue; }
        // Dry again: the far bank, once three steps in a row are dry (a sandbar or a gap in the read is not a bank).
        const ahead = [1, 2].every((step) => wet(input.terrain, { x: node.x + dx * (t + step * SAMPLE_STEP_METERS), z: node.z + dz * (t + step * SAMPLE_STEP_METERS) }) === false);
        if (!ahead) continue;
        waterEnd = t;
        break;
      }
      if (!ok || waterStart === null || waterEnd === null) continue;
      const total = waterEnd + BRIDGE_FAR_BANK_RUN_METERS;
      if (total > MAXIMUM_BRIDGE_TOTAL_METERS) continue;
      const to = { x: node.x + dx * total, z: node.z + dz * total };
      // The run onto the far bank is dry, read and owned too.
      if (wet(input.terrain, to) !== false || !input.isOwned(to)) continue;
      // Stranded: no served street already stands at the far end.
      if (input.servedNodes.some((other) => Math.hypot(other.x - to.x, other.z - to.z) < BRIDGE_STRANDED_DISTANCE_METERS)) continue;
      const farFreeCells = input.freeCellsAround(to, BRIDGE_FAR_LAND_RADIUS_METERS);
      if (farFreeCells < MINIMUM_FAR_BANK_FREE_CELLS) continue;
      crossings.push({ from: { x: node.x, z: node.z }, to, waterMeters: waterEnd - waterStart, totalMeters: total, farFreeCells });
    }
  }
  // The far bank that opens the most land first (the narrowest water leads to a remote strip as often as to a district's worth of ground); of equal
  // land, the shorter water span, then the shorter road.
  crossings.sort((left, right) => right.farFreeCells - left.farFreeCells ||
    Math.round(left.waterMeters / SAMPLE_STEP_METERS) - Math.round(right.waterMeters / SAMPLE_STEP_METERS) || left.totalMeters - right.totalMeters);
  return crossings.slice(0, input.limit ?? 40);
}

/** Bridges built in one go, like a street grid: three to five, not one at a time. */
export const BRIDGES_PER_BATCH = 4;
/** Two bridges of one batch keep their midpoints at least this far apart (they would be the same bridge, or cross). */
export const BRIDGE_MINIMUM_SEPARATION_METERS = 120;

/** The best crossings that do not duplicate each other, in the order given, at most `count`. */
export function selectBridgeBatch(crossings: readonly WaterCrossing[], count = BRIDGES_PER_BATCH): WaterCrossing[] {
  const chosen: WaterCrossing[] = [];
  const middle = (crossing: WaterCrossing) => ({ x: (crossing.from.x + crossing.to.x) / 2, z: (crossing.from.z + crossing.to.z) / 2 });
  for (const crossing of crossings) {
    if (chosen.length >= count) break;
    const here = middle(crossing);
    if (chosen.some((other) => { const there = middle(other); return Math.hypot(here.x - there.x, here.z - there.z) < BRIDGE_MINIMUM_SEPARATION_METERS; })) continue;
    chosen.push(crossing);
  }
  return chosen;
}
