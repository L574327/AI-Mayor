import type { SpatialLocalTerrain, SpatialPoint2, SpatialRoadEdge } from "../spatial/types";

/**
 * THE LAND A DISTRICT CAN TAKE — the owned ground as a player reads it from the map.
 *
 * A player does not choose from a menu of district sizes. They look at the flat land they own, put the biggest
 * rectangle of streets on it that fits, then the next biggest on what is left, and fill the corners with small ones.
 * This module is that reading: a mask of the lattice cells that are free land, and the maximal rectangles inside it.
 *
 * Mountains are not avoided as road ground — a road may climb, like a real mountain road — but nothing is zoned on
 * them, and a rectangle never claims them: steep ground is crossed by a gateway, not built up (see
 * {@link MOUNTAIN_SLOPE_PERCENT}). The world stays the authority: every cycle the mask is read again, so land a
 * district took is simply no longer free.
 */

export const LAND_CELL_METERS = 40;
/** Ground steeper than this is mountain: no district claims it and no zoning is attempted on it. */
export const MOUNTAIN_SLOPE_PERCENT = 30;
/** Zoning is attempted only where the ground is gentler than this (a brush on a slope grows nothing). */
export const ZONING_SLOPE_PERCENT = 25;
/** Roads of a district's grid may climb this steeply; the game's own validation decides beyond it. */
export const DISTRICT_ROAD_GRADE_PERCENT = 20;
/** A gateway may cross a mountain: one road over a pass, as a real mountain road does. */
export const GATEWAY_ROAD_GRADE_PERCENT = 35;
/** Water deeper than this is not land. */
export const LAND_WATER_DEPTH_METERS = 0.05;
/** Smallest rectangle worth a street grid: two blocks each way. */
export const MINIMUM_RECTANGLE_SIDE_METERS = 160;
export const MINIMUM_RECTANGLE_AREA_SQUARE_METERS = 40_000;

export interface TerrainReading { height: number; waterDepth: number }

/** Terrain at a point; `null` outside the read. Nearest-cell, the way the grid filter reads it. */
export function sampleTerrain(terrain: SpatialLocalTerrain | undefined, point: SpatialPoint2): TerrainReading | null {
  if (!terrain || !(terrain.resolution > 0) || !(terrain.cellSize.x > 0) || !(terrain.cellSize.z > 0)) return null;
  const { bounds, resolution, cellSize } = terrain;
  if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) return null;
  const col = Math.min(resolution - 1, Math.max(0, Math.floor((point.x - bounds.minX) / cellSize.x)));
  const row = Math.min(resolution - 1, Math.max(0, Math.floor((point.z - bounds.minZ) / cellSize.z)));
  const index = row * resolution + col;
  const height = terrain.heights[index];
  if (height === undefined || !Number.isFinite(height)) return null;
  return { height, waterDepth: terrain.waterDepths[index] ?? 0 };
}

/** Steepest rise per metre (as a percentage) among the points around `centre`, or null when unreadable. */
export function slopePercentAround(terrain: SpatialLocalTerrain | undefined, centre: SpatialPoint2, halfMeters = LAND_CELL_METERS / 2): number | null {
  const offsets = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]] as const;
  const heights: number[] = [];
  for (const [dx, dz] of offsets) {
    const reading = sampleTerrain(terrain, { x: centre.x + dx * halfMeters, z: centre.z + dz * halfMeters });
    if (!reading) return null;
    heights.push(reading.height);
  }
  return ((Math.max(...heights) - Math.min(...heights)) / (halfMeters * 2)) * 100;
}

/**
 * The share of a square of land (centre, side) that is dry and gentle enough to build on, from a terrain read that covers it.
 * Points the read does not cover are not counted as usable; `covered` says how much of the square the read reached, so a
 * caller can tell "mountain or lake" from "not looked at". Measured live: tiles bought on a 320 m look at their middle
 * turned out to be mostly water or slope, and each one raised the upkeep of every tile owned.
 */
export function usableLandShare(terrain: SpatialLocalTerrain | undefined, centre: SpatialPoint2, sideMeters: number, stepMeters = 2 * LAND_CELL_METERS):
  { usable: number; covered: number } {
  let total = 0;
  let covered = 0;
  let usable = 0;
  for (let dx = -sideMeters / 2 + stepMeters / 2; dx < sideMeters / 2; dx += stepMeters) {
    for (let dz = -sideMeters / 2 + stepMeters / 2; dz < sideMeters / 2; dz += stepMeters) {
      total += 1;
      const point = { x: centre.x + dx, z: centre.z + dz };
      const reading = sampleTerrain(terrain, point);
      if (!reading) continue;
      covered += 1;
      if (reading.waterDepth > LAND_WATER_DEPTH_METERS) continue;
      const slope = slopePercentAround(terrain, point);
      if (slope !== null && slope <= ZONING_SLOPE_PERCENT) usable += 1;
    }
  }
  return { usable: covered > 0 ? usable / covered : 0, covered: total > 0 ? covered / total : 0 };
}

export interface LandMask {
  origin: SpatialPoint2;
  spacing: number;
  columns: number;
  rows: number;
  /** 1 where the lattice cell is free land, 0 elsewhere. Row-major: `free[row * columns + column]`. */
  free: Uint8Array;
}

export interface LandMaskInput {
  /** A lattice node: cell (0,0) has its lower corner here. Every rectangle then lands on the city's own lattice. */
  origin: SpatialPoint2;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  isOwned(point: SpatialPoint2): boolean;
  terrain: SpatialLocalTerrain | undefined;
  edges: readonly Pick<SpatialRoadEdge, "start" | "end" | "deleted" | "temp">[];
  buildings: readonly SpatialPoint2[];
  /** Cells nearer than this to a road or building are not free (the same clearance a district keeps). */
  clearanceMeters: number;
  /** Points a cell must keep `meters` away from (industry from homes, homes from industry). */
  keepAway?: KeepAway | null;
  spacing?: number;
}

/** Points a cell must keep `meters` away from, and further groups with their own distance (homes keep 320 m from industry but only ~100 m from a railway or a highway). */
export interface KeepAway { points: readonly SpatialPoint2[]; meters: number; also?: ReadonlyArray<{ points: readonly SpatialPoint2[]; meters: number }> }
/** Whether anything in the groups stands closer than its distance, by the caller's own measure of distance to a point. */
export const keepAwayBlocks = (keep: KeepAway, distanceTo: (point: SpatialPoint2) => number): boolean =>
  keep.points.some((point) => distanceTo(point) < keep.meters) || (keep.also ?? []).some((group) => group.points.some((point) => distanceTo(point) < group.meters));

const rectPointDistance = (point: SpatialPoint2, rect: { minX: number; minZ: number; maxX: number; maxZ: number }) =>
  Math.hypot(Math.max(rect.minX - point.x, 0, point.x - rect.maxX), Math.max(rect.minZ - point.z, 0, point.z - rect.maxZ));

function segmentTouchesRect(a: SpatialPoint2, b: SpatialPoint2, rect: { minX: number; minZ: number; maxX: number; maxZ: number }): boolean {
  // Liang–Barsky clip of the segment against the rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - rect.minX], [dx, rect.maxX - a.x], [-dz, a.z - rect.minZ], [dz, rect.maxZ - a.z]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** The lattice cells that are free land: owned, dry, not mountain, clear of roads and buildings, outside isolation. */
export function buildLandMask(input: LandMaskInput): LandMask {
  const spacing = input.spacing ?? LAND_CELL_METERS;
  const firstColumn = Math.ceil((input.bounds.minX - input.origin.x) / spacing);
  const firstRow = Math.ceil((input.bounds.minZ - input.origin.z) / spacing);
  const lastColumn = Math.floor((input.bounds.maxX - input.origin.x) / spacing);
  const lastRow = Math.floor((input.bounds.maxZ - input.origin.z) / spacing);
  const columns = Math.max(0, lastColumn - firstColumn);
  const rows = Math.max(0, lastRow - firstRow);
  const origin = { x: input.origin.x + firstColumn * spacing, z: input.origin.z + firstRow * spacing };
  const free = new Uint8Array(columns * rows);
  const live = input.edges.filter((edge) => !edge.deleted && !edge.temp);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const rect = { minX: origin.x + column * spacing, minZ: origin.z + row * spacing,
        maxX: origin.x + (column + 1) * spacing, maxZ: origin.z + (row + 1) * spacing };
      const corners = [{ x: rect.minX, z: rect.minZ }, { x: rect.maxX, z: rect.minZ }, { x: rect.minX, z: rect.maxZ }, { x: rect.maxX, z: rect.maxZ }];
      if (!corners.every((corner) => input.isOwned(corner))) continue;
      const centre = { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 };
      if (input.terrain) {
        const samples = [...corners, centre].map((point) => sampleTerrain(input.terrain, point));
        // Unreadable ground is not assumed to be land.
        if (samples.some((sample) => sample === null || sample.waterDepth > LAND_WATER_DEPTH_METERS)) continue;
        const slope = slopePercentAround(input.terrain, centre, spacing / 2);
        if (slope === null || slope > MOUNTAIN_SLOPE_PERCENT) continue;
      }
      const clear = { minX: rect.minX - input.clearanceMeters, minZ: rect.minZ - input.clearanceMeters,
        maxX: rect.maxX + input.clearanceMeters, maxZ: rect.maxZ + input.clearanceMeters };
      if (input.buildings.some((point) => point.x >= clear.minX && point.x <= clear.maxX && point.z >= clear.minZ && point.z <= clear.maxZ)) continue;
      if (live.some((edge) => segmentTouchesRect(edge.start, edge.end, clear))) continue;
      if (input.keepAway && keepAwayBlocks(input.keepAway, (point) => rectPointDistance(point, rect))) continue;
      free[row * columns + column] = 1;
    }
  }
  return { origin, spacing, columns, rows, free };
}

export interface LandRectangle {
  minX: number;
  minZ: number;
  widthMeters: number;
  heightMeters: number;
}

/**
 * The maximal rectangles of free cells, biggest first: every rectangle that cannot grow in any direction without
 * leaving the free land. Rectangles smaller than a two-block grid are not returned. Rectangles overlap; the caller
 * takes the biggest, and the next cycle's mask (with that district's streets in it) yields the next.
 */
export function maximalRectangles(mask: LandMask, limit = 40, minimumSideMeters = MINIMUM_RECTANGLE_SIDE_METERS, minimumAreaSquareMeters = MINIMUM_RECTANGLE_AREA_SQUARE_METERS): LandRectangle[] {
  const { columns, rows, free, spacing, origin } = mask;
  const minCells = Math.ceil(minimumSideMeters / spacing);
  const found = new Map<string, { column: number; row: number; width: number; height: number }>();
  const heights = new Array<number>(columns).fill(0);
  const isFree = (column: number, row: number) => row >= 0 && row < rows && column >= 0 && column < columns && free[row * columns + column] === 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) heights[column] = isFree(column, row) ? heights[column]! + 1 : 0;
    // Rectangles whose bottom edge is this row: the largest-rectangle-in-histogram sweep, keeping each stack pop.
    const stack: Array<{ start: number; height: number }> = [];
    for (let column = 0; column <= columns; column += 1) {
      const height = column === columns ? 0 : heights[column]!;
      let start = column;
      while (stack.length > 0 && stack[stack.length - 1]!.height > height) {
        const top = stack.pop()!;
        const width = column - top.start;
        // Maximal downward as well: the next row must not be free all along the rectangle.
        const canGrowDown = (() => { for (let c = top.start; c < column; c += 1) if (!isFree(c, row + 1)) return false; return true; })();
        if (!canGrowDown && width >= minCells && top.height >= minCells) {
          found.set(`${top.start},${row - top.height + 1},${width},${top.height}`,
            { column: top.start, row: row - top.height + 1, width, height: top.height });
        }
        start = top.start;
      }
      if (stack.length === 0 || stack[stack.length - 1]!.height < height) stack.push({ start, height });
    }
  }
  return [...found.values()]
    .map((cells) => ({ minX: origin.x + cells.column * spacing, minZ: origin.z + cells.row * spacing,
      widthMeters: cells.width * spacing, heightMeters: cells.height * spacing }))
    .filter((rectangle) => rectangle.widthMeters * rectangle.heightMeters >= minimumAreaSquareMeters)
    .sort((left, right) => right.widthMeters * right.heightMeters - left.widthMeters * left.heightMeters ||
      left.minX - right.minX || left.minZ - right.minZ)
    .slice(0, limit);
}

/**
 * Block widths that sum to at most `totalMeters`, from the product's 120 m and 160 m blocks (the spacing that fills
 * with buildings), as balanced as the total allows. A total no mix of the two reaches (40, 80, 200) is shortened to the
 * next one that is. Null when even 120 m does not fit.
 *
 * `uniformBlockMeters` overrides both: every block is that wide, and the total is shortened to the whole number of them that fits (the guide's own
 * spacing — `TEMPLATE_DISTRICT_STREET_SPACING_METERS`; the remainder is what `fillGaps` fills). Null when not even one fits.
 */
export function composeBlocks(totalMeters: number, uniformBlockMeters = 0): number[] | null {
  if (uniformBlockMeters > 0) {
    const count = Math.floor(totalMeters / uniformBlockMeters);
    return count >= 1 ? new Array<number>(count).fill(uniformBlockMeters) : null;
  }
  for (let total = Math.floor(totalMeters / 40) * 40; total >= 120; total -= 40) {
    let best: { small: number; large: number } | null = null;
    for (let large = 0; large * 160 <= total; large += 1) {
      const rest = total - large * 160;
      if (rest % 120 !== 0) continue;
      const small = rest / 120;
      if (!best || Math.abs(small - large) < Math.abs(best.small - best.large)) best = { small, large };
    }
    if (!best) continue;
    // Alternate the two sizes, the commoner at both ends, so the blocks read as a regular grid.
    const major = best.small >= best.large ? 120 : 160;
    const minor = major === 120 ? 160 : 120;
    let majorCount = Math.max(best.small, best.large);
    let minorCount = Math.min(best.small, best.large);
    const widths: number[] = [];
    while (majorCount > 0 || minorCount > 0) {
      if (majorCount > 0) { widths.push(major); majorCount -= 1; }
      if (minorCount > 0) { widths.push(minor); minorCount -= 1; }
    }
    return widths;
  }
  return null;
}

/** Whether every cell of the rectangle is free land in this mask. */
export function rectangleIsFree(mask: LandMask, rectangle: LandRectangle): boolean {
  const column0 = Math.round((rectangle.minX - mask.origin.x) / mask.spacing);
  const row0 = Math.round((rectangle.minZ - mask.origin.z) / mask.spacing);
  const columns = Math.round(rectangle.widthMeters / mask.spacing);
  const rows = Math.round(rectangle.heightMeters / mask.spacing);
  if (column0 < 0 || row0 < 0 || column0 + columns > mask.columns || row0 + rows > mask.rows) return false;
  for (let row = row0; row < row0 + rows; row += 1) {
    for (let column = column0; column < column0 + columns; column += 1) if (mask.free[row * mask.columns + column] !== 1) return false;
  }
  return true;
}

/** Share of a side given up by each reduced variant of a rectangle the ground or the world refused. */
export const RECTANGLE_SHRINK_SHARE = 0.25;

/**
 * The same land taken a little smaller: a quarter off one side, each side in turn. A rectangle refused for one bad line
 * or one blocked corner is retried without that stretch instead of being given up whole.
 */
export function shrunkVariants(rectangle: LandRectangle, spacing = LAND_CELL_METERS): LandRectangle[] {
  const trimWidth = Math.max(spacing, Math.floor((rectangle.widthMeters * RECTANGLE_SHRINK_SHARE) / spacing) * spacing);
  const trimHeight = Math.max(spacing, Math.floor((rectangle.heightMeters * RECTANGLE_SHRINK_SHARE) / spacing) * spacing);
  const variants: LandRectangle[] = [
    { ...rectangle, widthMeters: rectangle.widthMeters - trimWidth },
    { ...rectangle, minX: rectangle.minX + trimWidth, widthMeters: rectangle.widthMeters - trimWidth },
    { ...rectangle, heightMeters: rectangle.heightMeters - trimHeight },
    { ...rectangle, minZ: rectangle.minZ + trimHeight, heightMeters: rectangle.heightMeters - trimHeight },
  ];
  return variants.filter((variant) => variant.widthMeters >= MINIMUM_RECTANGLE_SIDE_METERS && variant.heightMeters >= MINIMUM_RECTANGLE_SIDE_METERS &&
    variant.widthMeters * variant.heightMeters >= MINIMUM_RECTANGLE_AREA_SQUARE_METERS);
}
