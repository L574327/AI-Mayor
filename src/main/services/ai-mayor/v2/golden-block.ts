/**
 * THE GOLDEN BLOCK (玩家 2026-10-08): a district that is not zoned wall to wall, but leaves the lots its services will need, and gaps that are filled.
 *
 * Grid (guide: steamah "Practical Engineering: Efficient Grids"): the zoned share of a square block of side x with roads W wide is 192(x - W + 48) / x²,
 * best at x = 2W + 96 — 112 m for Small Roads (~86%). Cells deeper than 96 m from a road never grow, so a block's middle is free anyway: that is where a
 * small service stands. Service sizes and reach are read from the game (`cs2_prefab_lock`: lotSize in 8 m cells, coverage.range), never guessed here.
 *
 * Pure functions only; the builder wires them in (`HANDOFF-2026-10-08-GOLDEN-BLOCK.md` §3.4).
 */
export interface Rect { minX: number; minZ: number; maxX: number; maxZ: number }
export interface GridCell { rect: Rect; column: number; row: number }
export interface ServiceSpec { prefab: string; lotCells: { x: number; z: number }; rangeMeters: number | null }

export const ROAD_WIDTH_METERS = { small: 8, medium: 16, large: 24 } as const;
/** The guide's optimum: x = 2W + 96. */
export const optimalSpacing = (roadWidthMeters: number): number => 2 * roadWidthMeters + 96;
/**
 * Share of a block (road centre to road centre, side `spacing`) that is zoned: the ground inside the roads, side s = spacing - W, grows only within 48 m of
 * a road, so the zoned part is s² - max(0, s - 96)². Checked against the guide's figures: 112/8 → 85.7%, 128/16 → 75%, 144/24 → 66.7%, 160/32 → 60%.
 */
export const zonedShare = (spacing: number, roadWidthMeters: number): number => {
  const side = spacing - roadWidthMeters;
  const dead = Math.max(0, side - 96);
  return (side * side - dead * dead) / (spacing * spacing);
};
export const GOLDEN_SPACING_METERS = optimalSpacing(ROAD_WIDTH_METERS.small);
/** A lot this many cells or more on BOTH sides is a big service (cemetery, hospital, high school, depot): it takes a whole grid cell. */
export const BIG_SERVICE_LOT_CELLS = 10;
/** Blocks of the district's own grid a piece of leftover land must hold to be worth a (mini) district: 2 x 1 and up. */
export const MINIMUM_DISTRICT_BLOCKS = 2;
/** Whether a piece of free land holds a district of its own: `MINIMUM_DISTRICT_BLOCKS` whole cells of the district's grid, 2 x 1 and up. */
export const holdsMiniDistrict = (widthMeters: number, depthMeters: number, spacing = GOLDEN_SPACING_METERS): boolean =>
  Math.floor(widthMeters / spacing) * Math.floor(depthMeters / spacing) >= MINIMUM_DISTRICT_BLOCKS;
/** All the ground a cell has between its streets. */
export const cellInteriorMeters = (spacing: number, roadWidthMeters: number): number => spacing - roadWidthMeters;
/** The longer side of a lot, in metres (a lot cell is 8 m). */
export const serviceLotSideMeters = (service: ServiceSpec): number => Math.max(service.lotCells.x, service.lotCells.z) * 8;
/**
 * Whether a service needs a whole grid cell rather than the free middle of one: a lot at least `BIG_SERVICE_LOT_CELLS` on both sides (cemetery, hospital,
 * high school, road depot), or one longer than a cell's free middle (the elementary school and the bus depot are 144 m — the game's own lots, 2026-10-08).
 */
export const serviceNeedsWholeCell = (service: ServiceSpec, spacing = GOLDEN_SPACING_METERS, roadWidthMeters = ROAD_WIDTH_METERS.small): boolean =>
  Math.min(service.lotCells.x, service.lotCells.z) >= BIG_SERVICE_LOT_CELLS || serviceLotSideMeters(service) > cellInteriorMeters(spacing, roadWidthMeters);
/** The side the free middle of a cell must have: the largest small lot that fits one, in metres (0 when none does — then nothing is kept). */
export function smallServiceLotSideMeters(services: readonly ServiceSpec[], spacing = GOLDEN_SPACING_METERS, roadWidthMeters = ROAD_WIDTH_METERS.small): number {
  const interior = cellInteriorMeters(spacing, roadWidthMeters);
  const fitting = services.filter((service) => !serviceNeedsWholeCell(service, spacing, roadWidthMeters) && serviceLotSideMeters(service) <= interior);
  return fitting.length === 0 ? 0 : Math.max(...fitting.map(serviceLotSideMeters));
}
/** Narrowest strip worth one road with homes on both sides, and the widest such strip (both sides grow up to 48 m deep). */
export const STRIP_MINIMUM_METERS = 40;
export const STRIP_MAXIMUM_METERS = 96;

/** The grid cells (road centre to road centre) inside a rectangle; the remainder at the far edges is left to `fillGaps`. */
export function gridCells(area: Rect, spacing = GOLDEN_SPACING_METERS): GridCell[] {
  const columns = Math.floor((area.maxX - area.minX) / spacing);
  const rows = Math.floor((area.maxZ - area.minZ) / spacing);
  const cells: GridCell[] = [];
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const minX = area.minX + column * spacing; const minZ = area.minZ + row * spacing;
      cells.push({ column, row, rect: { minX, minZ, maxX: minX + spacing, maxZ: minZ + spacing } });
    }
  }
  return cells;
}

const centre = (rect: Rect) => ({ x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 });

/**
 * Which cells are zoned and which are kept for services.
 * - Small services: the free middle of every cell holds one; the largest small lot is kept at each cell's centre (`reservedSmall`, one per cell that a
 *   small service's reach calls for: every ceil(range / spacing) cells along each axis, so the reaches touch).
 * - Big services: one whole cell every ceil(range / spacing) cells each way, at the crossing of those blocks (`reservedBig`), never on the area's edge row
 *   when an inner one exists (the big lot then has streets on all four sides).
 */
export function reserveCells(cells: readonly GridCell[], services: readonly ServiceSpec[], spacing = GOLDEN_SPACING_METERS): {
  zoned: GridCell[]; reservedBig: GridCell[]; reservedSmall: Array<{ cell: GridCell; centre: { x: number; z: number }; sideMeters: number }>;
} {
  const big = services.filter((service) => serviceNeedsWholeCell(service, spacing));
  const small = services.filter((service) => !serviceNeedsWholeCell(service, spacing));
  const step = (specs: readonly ServiceSpec[]) => {
    const ranges = specs.map((spec) => spec.rangeMeters).filter((range): range is number => range !== null && range > 0);
    return ranges.length === 0 ? 3 : Math.max(1, Math.ceil(Math.min(...ranges) / spacing));
  };
  const columns = cells.reduce((most, cell) => Math.max(most, cell.column + 1), 0);
  const rows = cells.reduce((most, cell) => Math.max(most, cell.row + 1), 0);
  const bigStep = step(big);
  const offset = (count: number, every: number) => Math.min(count - 1, Math.max(0, Math.floor(Math.min(every, count) / 2)));
  const bigColumn0 = offset(columns, bigStep); const bigRow0 = offset(rows, bigStep);
  const isBig = (cell: GridCell) => big.length > 0 && (cell.column - bigColumn0) % bigStep === 0 && (cell.row - bigRow0) % bigStep === 0 && cell.column >= bigColumn0 && cell.row >= bigRow0;
  const reservedBig = cells.filter(isBig);
  const smallStep = step(small);
  const smallSide = smallServiceLotSideMeters(small, spacing);
  // A lot larger than a cell's free middle is not kept there: it is a whole-cell service (see `serviceNeedsWholeCell`).
  const fits = smallSide > 0;
  const reservedSmall = fits ? cells.filter((cell) => !isBig(cell) && cell.column % smallStep === 0 && cell.row % smallStep === 0)
    .map((cell) => ({ cell, centre: centre(cell.rect), sideMeters: smallSide })) : [];
  return { zoned: cells.filter((cell) => !isBig(cell)), reservedBig, reservedSmall };
}

/**
 * The land left over (free rectangles, e.g. `maximalRectangles` of the land mask): a rectangle that holds at least two grid cells gets a mini district
 * (same grid, fewer cells); a long strip 40-96 m wide gets one Small Road down its middle with homes on both sides; anything else is left.
 */
export function fillGaps(free: readonly Rect[], spacing = GOLDEN_SPACING_METERS): {
  miniDistricts: Rect[]; stripRoads: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }>; left: Rect[];
} {
  const miniDistricts: Rect[] = []; const stripRoads: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = []; const left: Rect[] = [];
  for (const rect of free) {
    const width = rect.maxX - rect.minX; const depth = rect.maxZ - rect.minZ;
    const short = Math.min(width, depth); const long = Math.max(width, depth);
    if (Math.floor(width / spacing) * Math.floor(depth / spacing) >= 2) { miniDistricts.push(rect); continue; }
    if (short >= STRIP_MINIMUM_METERS && short <= STRIP_MAXIMUM_METERS && long >= spacing) {
      const mid = centre(rect);
      stripRoads.push(width >= depth ? { start: { x: rect.minX, z: mid.z }, end: { x: rect.maxX, z: mid.z } } : { start: { x: mid.x, z: rect.minZ }, end: { x: mid.x, z: rect.maxZ } });
      continue;
    }
    left.push(rect);
  }
  return { miniDistricts, stripRoads, left };
}
