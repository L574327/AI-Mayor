/**
 * T20 — the game's own surface-water observation, as the world reports it.
 *
 * The Bridge samples `WaterUtils.SampleDepth`, `SamplePolluted` and
 * `SampleVelocity` over one grid, in one request, at one set of positions, and
 * returns them together. Those three arrays are authoritative game state, not a
 * derived product: the depth says where water is, the two velocity components
 * say which way it is going and how fast, and the pollution value is the raw
 * reading the water simulation itself carries.
 *
 * Nothing here interprets them. In particular:
 *
 *  - the velocity keeps BOTH components. Collapsing them to a magnitude would
 *    throw away the only thing that answers "which way does the discharge go",
 *    and collapsing them to a bearing would lose the speed that says whether
 *    the water is moving at all.
 *  - depth is never read as flow, and flow is never inferred from geometry. A
 *    deep still cell and a shallow fast cell are different facts and stay
 *    different here.
 *  - pollution is carried through as the raw sample. It is evidence about the
 *    water body, not a verdict about a facility.
 *
 * The module is pure: it parses a payload and answers positional questions. The
 * transport that fetched the payload stays in the adapter, so every rule below
 * is testable against a fixture without a running game.
 */

import type { SpatialPoint2 } from "./types";

/** Water below this depth is land for the purposes of this observation. */
export const WATER_DEPTH_EPSILON = 0.05;
/** A sample at or below this speed is not moving; it is not a flow direction. */
export const WATER_STAGNANT_SPEED = 1e-3;

export interface WaterFlowSample {
  /** Raw authoritative depth in metres. */
  depth: number;
  /** Raw authoritative pollution value carried by the water simulation. */
  pollution: number;
  /** Authoritative velocity, both components kept. */
  velocity: { x: number; z: number };
}

export interface WaterFlowCell extends WaterFlowSample {
  col: number;
  row: number;
  index: number;
  /** Cell centre in world coordinates. */
  x: number;
  z: number;
}

export interface WaterFlowObservation {
  resolution: number;
  cellSize: number;
  worldMin: number;
  worldMax: number;
  /** Whether a world position lies inside the sampled square. */
  covers(x: number, z: number): boolean;
  /** The sample at a world position, or null when the position is not covered. */
  sampleAt(x: number, z: number): WaterFlowSample | null;
  /** The grid cell containing a world position, or null when it is not covered. */
  cellAt(x: number, z: number): WaterFlowCell | null;
  /** The cell by grid index, or null when the index is outside the grid. */
  cellByIndex(index: number): WaterFlowCell | null;
  /** The four orthogonal neighbours that are inside the grid. */
  neighboursOf(index: number): number[];
  /** Whether the observation is usable at all: an unread grid answers nothing. */
  readonly available: boolean;
}

const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const numberArray = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const parsed: number[] = [];
  for (const item of value) {
    const number = finite(item);
    if (number === null) return null;
    parsed.push(number);
  }
  return parsed;
};

const velocityArray = (value: unknown): Array<{ x: number; z: number }> | null => {
  if (!Array.isArray(value)) return null;
  const parsed: Array<{ x: number; z: number }> = [];
  for (const item of value) {
    const entry = record(item);
    const x = finite(entry.x);
    const z = finite(entry.y);
    if (x === null || z === null) return null;
    parsed.push({ x, z });
  }
  return parsed;
};

/**
 * An observation that answers nothing.
 *
 * Used when the read failed, was truncated, or did not carry the three arrays
 * at a consistent resolution. It is deliberately indistinguishable from a read
 * that was never attempted: a caller that cannot obtain the observation must
 * not be able to tell "the world has no water here" from "nobody looked", so it
 * cannot accidentally certify on the second.
 */
export function unavailableWaterFlowObservation(): WaterFlowObservation {
  return {
    resolution: 0, cellSize: 0, worldMin: 0, worldMax: 0, available: false,
    covers: () => false, sampleAt: () => null, cellAt: () => null, cellByIndex: () => null, neighboursOf: () => [],
  };
}

/**
 * Parse the authoritative `/city/terrain` payload.
 *
 * Every array is required and must agree with `resolution`, because a partially
 * read grid is worse than no grid: it would let a trace stop early and report
 * "bounded reach" where the truth is "the next sample was missing".
 */
export function parseWaterFlowObservation(payload: unknown): WaterFlowObservation {
  const root = record(payload);
  const resolution = finite(root.resolution);
  const cellSize = finite(root.cellSize);
  const worldMin = finite(root.worldMin);
  const worldMax = finite(root.worldMax);
  const depths = numberArray(root.waterDepths);
  const pollutions = numberArray(root.waterPollutions);
  const velocities = velocityArray(root.waterVelocities);
  const cells = resolution !== null && resolution > 0 ? resolution * resolution : 0;
  if (resolution === null || cellSize === null || cellSize <= 0 || worldMin === null || worldMax === null ||
    !Number.isInteger(resolution) || cells === 0 ||
    depths === null || depths.length !== cells ||
    pollutions === null || pollutions.length !== cells ||
    velocities === null || velocities.length !== cells) {
    return unavailableWaterFlowObservation();
  }
  const colOf = (x: number) => Math.max(0, Math.min(resolution - 1, Math.floor((x - worldMin) / cellSize)));
  const rowOf = (z: number) => Math.max(0, Math.min(resolution - 1, Math.floor((z - worldMin) / cellSize)));
  const centerOf = (col: number, row: number) => ({
    x: worldMin + (col + 0.5) * cellSize,
    z: worldMin + (row + 0.5) * cellSize,
  });
  const cellByIndex = (index: number): WaterFlowCell | null => {
    if (!Number.isInteger(index) || index < 0 || index >= cells) return null;
    const col = index % resolution;
    const row = Math.floor(index / resolution);
    const center = centerOf(col, row);
    return { index, col, row, x: center.x, z: center.z, depth: depths[index],
      pollution: pollutions[index], velocity: velocities[index] };
  };
  const cellAt = (x: number, z: number): WaterFlowCell | null =>
    covers(x, z) ? cellByIndex(rowOf(z) * resolution + colOf(x)) : null;
  const covers = (x: number, z: number) =>
    Number.isFinite(x) && Number.isFinite(z) && x >= worldMin && x <= worldMax && z >= worldMin && z <= worldMax;
  const neighboursOf = (index: number): number[] => {
    const cell = cellByIndex(index);
    if (!cell) return [];
    return [
      cell.col > 0 ? index - 1 : -1,
      cell.col + 1 < resolution ? index + 1 : -1,
      cell.row > 0 ? index - resolution : -1,
      cell.row + 1 < resolution ? index + resolution : -1,
    ].filter((neighbour) => neighbour >= 0);
  };
  return { resolution, cellSize, worldMin, worldMax, available: true,
    covers, sampleAt: (x, z) => cellAt(x, z), cellAt, cellByIndex, neighboursOf };
}

export type WaterTraceTermination =
  | "STAGNANT"
  | "LEFT_WATER"
  | "DISTANCE_EXHAUSTED"
  | "LEFT_OBSERVATION"
  | "CYCLE";

export interface WaterDownstreamTrace {
  cells: WaterFlowCell[];
  /** How the trace stopped, or why it could not be computed at all. */
  termination: WaterTraceTermination;
  /** Travelled distance in metres, counted in cell steps. */
  distance: number;
}

/**
 * Follow the authoritative velocity field downstream from a water cell.
 *
 * The step is a fraction of a cell, and it is taken along the velocity the game
 * itself reports — no bearing is guessed, no visual cue is used, and the
 * pollution array is not consulted to decide where the water goes. The trace
 * stops for one of four honest reasons:
 *
 *  - `STAGNANT`: the reported speed is zero, so the discharge does not travel.
 *    Its reach is the cell it is in.
 *  - `LEFT_WATER`: the next position is not water, so the plume has reached a
 *    bank. Its reach is the last water cell.
 *  - `DISTANCE_EXHAUSTED`: the bounded trace distance was used up.
 *  - `LEFT_OBSERVATION`: the next position is outside the sampled square. This
 *    is NOT a bounded reach — nothing was observed beyond it, and the caller
 *    must treat it as unproven rather than as a stopping point.
 *
 * `CYCLE` means the field returned to a visited cell; the reach is still fully
 * observed, so it is a valid terminal like `DISTANCE_EXHAUSTED`.
 */
export function traceWaterDownstream(
  observation: WaterFlowObservation,
  start: { x: number; z: number },
  options: { maximumDistance: number; stepFraction?: number; maximumCells?: number },
): WaterDownstreamTrace {
  const empty: WaterDownstreamTrace = { cells: [], termination: "LEFT_OBSERVATION", distance: 0 };
  if (!observation.available) return empty;
  const startCell = observation.cellAt(start.x, start.z);
  if (!startCell) return empty;
  const stepLength = observation.cellSize * (options.stepFraction ?? 0.5);
  const maximumSteps = Math.max(1, Math.ceil(options.maximumDistance / stepLength));
  const maximumCells = options.maximumCells ?? maximumSteps;
  const cells: WaterFlowCell[] = [startCell];
  const seen = new Set<number>([startCell.index]);
  let position = { x: startCell.x, z: startCell.z };
  let travelled = 0;
  for (let step = 0; step < maximumSteps; step += 1) {
    const current = observation.cellAt(position.x, position.z);
    if (!current) return { cells, termination: "LEFT_OBSERVATION", distance: travelled };
    const speed = Math.hypot(current.velocity.x, current.velocity.z);
    if (speed <= WATER_STAGNANT_SPEED) return { cells, termination: "STAGNANT", distance: travelled };
    const next = {
      x: position.x + (current.velocity.x / speed) * stepLength,
      z: position.z + (current.velocity.z / speed) * stepLength,
    };
    if (!observation.covers(next.x, next.z)) return { cells, termination: "LEFT_OBSERVATION", distance: travelled };
    const nextCell = observation.cellAt(next.x, next.z);
    if (!nextCell) return { cells, termination: "LEFT_OBSERVATION", distance: travelled };
    position = next;
    travelled += stepLength;
    if (nextCell.depth <= WATER_DEPTH_EPSILON) return { cells, termination: "LEFT_WATER", distance: travelled };
    if (nextCell.index === current.index) continue;
    if (seen.has(nextCell.index)) {
      if (cells.length >= maximumCells) return { cells, termination: "DISTANCE_EXHAUSTED", distance: travelled };
      cells.push(nextCell);
      return { cells, termination: "CYCLE", distance: travelled };
    }
    if (cells.length >= maximumCells) return { cells, termination: "DISTANCE_EXHAUSTED", distance: travelled };
    seen.add(nextCell.index);
    cells.push(nextCell);
  }
  return { cells, termination: "DISTANCE_EXHAUSTED", distance: travelled };
}

export interface WaterRegion {
  cells: number[];
  /** False when the fill ran out of budget while still growing. */
  bounded: boolean;
}

/**
 * The connected water body around a cell, by connectivity rather than distance.
 *
 * Two points on the same lake but at opposite ends are the same body no matter
 * how far apart they are; two points metres apart across a spit are not. Only
 * the first question may be answered by proximity, and it may not be answered
 * by proximity at all — so membership comes from walking water cells.
 *
 * When the budget runs out the region is reported UNBOUNDED, which is a
 * missing observation, not a large body.
 */
export function connectedWaterRegion(
  observation: WaterFlowObservation,
  startIndex: number,
  maximumCells: number,
): WaterRegion {
  if (!observation.available || !observation.cellByIndex(startIndex)) return { cells: [], bounded: false };
  const cells: number[] = [];
  const visited = new Set<number>();
  const queue: number[] = [startIndex];
  visited.add(startIndex);
  while (queue.length > 0) {
    const index = queue.shift() as number;
    const cell = observation.cellByIndex(index);
    if (!cell || cell.depth <= WATER_DEPTH_EPSILON) continue;
    cells.push(index);
    if (cells.length > maximumCells) return { cells, bounded: false };
    for (const neighbour of observation.neighboursOf(index)) {
      if (visited.has(neighbour)) continue;
      const neighbourCell = observation.cellByIndex(neighbour);
      if (!neighbourCell || neighbourCell.depth <= WATER_DEPTH_EPSILON) continue;
      visited.add(neighbour);
      queue.push(neighbour);
    }
  }
  // A fill that consumed its whole budget with cells still queued, or that
  // landed exactly on the budget, cannot claim the body ends where it stopped.
  return { cells, bounded: queue.length === 0 && cells.length < maximumCells };
}

/** The nearest water cell to a world position, searched outward on the grid. */
export function nearestWaterCell(
  observation: WaterFlowObservation,
  point: SpatialPoint2,
  searchRadiusCells: number,
): WaterFlowCell | null {
  if (!observation.available) return null;
  const origin = observation.cellAt(point.x, point.z);
  if (!origin) return null;
  let best: WaterFlowCell | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = origin.row - searchRadiusCells; row <= origin.row + searchRadiusCells; row += 1) {
    for (let col = origin.col - searchRadiusCells; col <= origin.col + searchRadiusCells; col += 1) {
      if (col < 0 || row < 0 || col >= observation.resolution || row >= observation.resolution) continue;
      const cell = observation.cellByIndex(row * observation.resolution + col);
      if (!cell || cell.depth <= WATER_DEPTH_EPSILON) continue;
      const distance = Math.hypot(cell.x - point.x, cell.z - point.z);
      if (distance < bestDistance) { bestDistance = distance; best = cell; }
    }
  }
  return best;
}
