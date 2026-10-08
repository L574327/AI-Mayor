import type { SpatialPoint2, SpatialSiteDetail } from "../spatial/types";

/**
 * Where the city could grow when the ground around its own roads has run out.
 *
 * The growth search is anchored on road nodes and looks a few dozen metres around each of them, so a city whose
 * network is fully built can never see open land that no road reaches yet. Measured live (2026-10-02,
 * `斯奈德维尔`): 9 owned tiles, three of them flat (0-1% steep, 0% water) and completely empty, ~1.16 km² in all,
 * while the Mayor sat idle for 30 ticks with every expansion domain refused. A frontier survey reads each owned
 * tile once and names the flat, dry, building-free ground in it; the existing corridor planner then walks a
 * road there. It decides nothing about HOW to build — it only answers "is there room, and where".
 */
export const FRONTIER_PATCH_CELLS = 5;
export const FRONTIER_MAX_GRADE_PERCENT = 8;
export const FRONTIER_MAX_WATER_DEPTH = 0.05;
/** A building closer than this to a patch's cell makes that cell not free. */
export const FRONTIER_BUILDING_CLEARANCE_METERS = 24;
/** An existing road this close to a patch cell makes the patch "served ground", not frontier. */
export const FRONTIER_ROAD_CLEARANCE_METERS = 24;

export interface FrontierPatch {
  center: SpatialPoint2;
  /** Side of the square flat patch, in metres. */
  sideMeters: number;
}

function distanceToSegment(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
}

/**
 * The flat, dry, building-free, road-free, OWNED square patches one site read contains.
 *
 * A patch is `FRONTIER_PATCH_CELLS` cells on a side and every one of its cells must pass; one wet or steep or
 * built cell rejects the whole patch (a district needs ground, not a sliver). Patches are returned in the read's
 * own scan order — ranking by distance to the network is the caller's, because only it knows the network.
 */
export function flatFreePatches(input: {
  detail: SpatialSiteDetail;
  isOwned(point: SpatialPoint2): boolean;
  patchCells?: number;
  maxGradePercent?: number;
}): FrontierPatch[] {
  const { terrain } = input.detail;
  const resolution = terrain.resolution;
  if (!(resolution > 0) || !(terrain.cellSize.x > 0) || !(terrain.cellSize.z > 0)) return [];
  const patchCells = input.patchCells ?? FRONTIER_PATCH_CELLS;
  const maxGrade = input.maxGradePercent ?? FRONTIER_MAX_GRADE_PERCENT;
  const spacing = Math.min(terrain.cellSize.x, terrain.cellSize.z);
  const centreOf = (col: number, row: number): SpatialPoint2 => ({
    x: terrain.bounds.minX + (col + 0.5) * terrain.cellSize.x,
    z: terrain.bounds.minZ + (row + 0.5) * terrain.cellSize.z,
  });
  const edges = input.detail.roadGraph.edges.filter((edge) => !edge.deleted);
  const ok: boolean[] = new Array(resolution * resolution).fill(false);
  for (let row = 0; row < resolution; row += 1) {
    for (let col = 0; col < resolution; col += 1) {
      const index = row * resolution + col;
      const height = terrain.heights[index];
      if (!Number.isFinite(height) || (terrain.waterDepths[index] ?? 0) > FRONTIER_MAX_WATER_DEPTH) continue;
      const neighbours = [col > 0 ? index - 1 : -1, col + 1 < resolution ? index + 1 : -1,
        row > 0 ? index - resolution : -1, row + 1 < resolution ? index + resolution : -1].filter((n) => n >= 0);
      const grade = neighbours.reduce((worst, n) => {
        const other = terrain.heights[n];
        return Number.isFinite(other) ? Math.max(worst, (Math.abs(height! - other!) / spacing) * 100) : worst;
      }, 0);
      if (grade > maxGrade) continue;
      const centre = centreOf(col, row);
      if (!input.isOwned(centre)) continue;
      if (input.detail.buildings.some((building) =>
        Math.hypot(building.position.x - centre.x, building.position.z - centre.z) < FRONTIER_BUILDING_CLEARANCE_METERS)) continue;
      if (edges.some((edge) => distanceToSegment(centre, edge.start, edge.end) < FRONTIER_ROAD_CLEARANCE_METERS)) continue;
      ok[index] = true;
    }
  }
  const patches: FrontierPatch[] = [];
  for (let row = 0; row + patchCells <= resolution; row += 1) {
    for (let col = 0; col + patchCells <= resolution; col += 1) {
      let whole = true;
      for (let dr = 0; dr < patchCells && whole; dr += 1) {
        for (let dc = 0; dc < patchCells; dc += 1) {
          if (!ok[(row + dr) * resolution + col + dc]) { whole = false; break; }
        }
      }
      if (!whole) continue;
      const first = centreOf(col, row);
      const last = centreOf(col + patchCells - 1, row + patchCells - 1);
      patches.push({ center: { x: (first.x + last.x) / 2, z: (first.z + last.z) / 2 },
        sideMeters: patchCells * Math.max(terrain.cellSize.x, terrain.cellSize.z) });
    }
  }
  return patches;
}

/**
 * Frontier patches ranked nearest-the-network first, thinned so no two are within `separationMeters`.
 *
 * Nearest first is edge expansion; the next ones are the farther land the same ranking reaches when the near
 * ground is gone. Nothing here picks a prefab, a course or a district size.
 */
export function rankFrontierPatches(input: {
  patches: readonly FrontierPatch[];
  network: readonly SpatialPoint2[];
  separationMeters?: number;
  limit?: number;
}): Array<FrontierPatch & { distanceToNetwork: number; from: SpatialPoint2 }> {
  if (input.network.length === 0) return [];
  const separation = input.separationMeters ?? 200;
  const scored = input.patches.map((patch) => {
    let nearest = input.network[0]!;
    let best = Number.POSITIVE_INFINITY;
    for (const node of input.network) {
      const distance = Math.hypot(node.x - patch.center.x, node.z - patch.center.z);
      if (distance < best) { best = distance; nearest = node; }
    }
    return { ...patch, distanceToNetwork: best, from: nearest };
  }).sort((a, b) => a.distanceToNetwork - b.distanceToNetwork || a.center.x - b.center.x || a.center.z - b.center.z);
  const picked: typeof scored = [];
  for (const entry of scored) {
    if (picked.some((other) => Math.hypot(other.center.x - entry.center.x, other.center.z - entry.center.z) < separation)) continue;
    picked.push(entry);
    if (picked.length >= (input.limit ?? 3)) break;
  }
  return picked;
}
