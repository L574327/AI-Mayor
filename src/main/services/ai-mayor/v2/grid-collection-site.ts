import {
  filterGridSegmentsByTerrain,
  planGridCollections,
  type GridCollectionSpec,
} from "./road-grid-generator";
import type {
  SpatialLocalTerrain,
  SpatialPoint2,
  SpatialRoadNode,
  SpatialTile,
} from "../spatial/types";

/**
 * Whether a 集合 may be placed HERE: it reaches the existing network, it sits on
 * owned land, and the whole collection clears the ground.
 *
 * WHY THE TERRAIN READ IS BOUNDED, NOT JUST CHECKED. A water patch is narrow.
 * The first acceptance run on 2026-10-02 read terrain at 64 m cells and reported
 * a plot as dry that a finer read showed was not — the documented failure mode
 * is "never use a fixed coarse grid to prove there is no water". So this refuses
 * to certify a site from a read too coarse to see the patch it is certifying:
 * a coarse read is a VIOLATION, not a pass.
 */
export const MAX_COLLECTION_TERRAIN_CELL_METERS = 16;

export type CollectionSiteViolation =
  | "NO_ANCHOR_IN_REACH"
  | "ANCHOR_NOT_ON_MAIN_COMPONENT"
  | "OUTSIDE_OWNED"
  | "WATER"
  | "STEEP_GRADE"
  | "OFF_TERRAIN"
  | "TERRAIN_READ_TOO_COARSE";

export interface CollectionSiteInput {
  /** The collection's corner, as `planGridCollections` would take it. */
  anchor: SpatialPoint2;
  collection: GridCollectionSpec;
  terrain: SpatialLocalTerrain;
  ownedTiles: readonly SpatialTile[];
  roadNodes: readonly SpatialRoadNode[];
  /**
   * The streets, so the anchor's COMPONENT can be checked, not just its distance.
   *
   * "A node within 150 m" is what the 2026-10-02 district passed — and it came
   * out an island: the node it anchored to was on a 62-street component with no
   * facility on it, 63.6 m from the main net but not joined to it. A site whose
   * anchor is on a different component is served by nothing, and closing that
   * gap is a separate road-building step, so it is refused here instead.
   */
  roadEdges?: ReadonlyArray<{ startNode: SpatialRoadNode["entity"]; endNode: SpatialRoadNode["entity"] }>;
  /**
   * Which component counts. Required together with `roadEdges`; the caller knows
   * which one carries the three nets, this module only knows legality.
   */
  mainComponentRoot?: SpatialRoadNode["entity"];
  /** How far an existing road node may sit from the collection and still anchor it. */
  maxAnchorDistanceMeters?: number;
  maxGradePercent?: number;
  maxTerrainCellMeters?: number;
  samplesPerSegment?: number;
}

export interface CollectionSiteVerdict {
  ok: boolean;
  anchor: { entity: SpatialRoadNode["entity"]; position: SpatialPoint2; distanceMeters: number } | null;
  terrain: { cells: number; cellMeters: number; kept: number; water: number; steep: number; offTerrain: number };
  violations: CollectionSiteViolation[];
  detail: string;
}

const pointInTile = (point: SpatialPoint2, tile: SpatialTile): boolean =>
  tile.bounds !== null &&
  point.x >= tile.bounds.min.x && point.x <= tile.bounds.max.x &&
  point.z >= tile.bounds.min.z && point.z <= tile.bounds.max.z;

/** Distance from a point to a rectangle: 0 when it is inside. */
const distanceToRect = (point: SpatialPoint2, rect: { minX: number; minZ: number; maxX: number; maxZ: number }): number => {
  const dx = Math.max(rect.minX - point.x, 0, point.x - rect.maxX);
  const dz = Math.max(rect.minZ - point.z, 0, point.z - rect.maxZ);
  return Math.hypot(dx, dz);
};

export const terrainCellMeters = (terrain: SpatialLocalTerrain): number =>
  Math.max(terrain.cellSize?.x ?? Number.POSITIVE_INFINITY, terrain.cellSize?.z ?? Number.POSITIVE_INFINITY);

export function selectCollectionSite(input: CollectionSiteInput): CollectionSiteVerdict {
  const maxAnchorDistanceMeters = input.maxAnchorDistanceMeters ?? 150;
  const maxTerrainCellMeters = input.maxTerrainCellMeters ?? MAX_COLLECTION_TERRAIN_CELL_METERS;
  const violations: CollectionSiteViolation[] = [];

  const plan = planGridCollections({ anchor: input.anchor, collections: [input.collection] });
  const collection = plan.collections[0]!;
  const rect = {
    minX: collection.anchor.x,
    minZ: collection.anchor.z,
    maxX: collection.anchor.x + collection.widthMeters,
    maxZ: collection.anchor.z + collection.heightMeters,
  };

  // 1. Ownership: the whole collection has to sit on land the city owns.
  const corners: SpatialPoint2[] = [
    { x: rect.minX, z: rect.minZ }, { x: rect.maxX, z: rect.minZ },
    { x: rect.minX, z: rect.maxZ }, { x: rect.maxX, z: rect.maxZ },
    { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 },
  ];
  const ownedTiles = input.ownedTiles.filter((tile) => tile.owned && tile.bounds !== null);
  if (!corners.every((corner) => ownedTiles.some((tile) => pointInTile(corner, tile)))) {
    violations.push("OUTSIDE_OWNED");
  }

  // 2. Connectivity: a node of the EXISTING graph within reach, so the ring can
  //    be attached instead of drawn as an island.
  let anchor: CollectionSiteVerdict["anchor"] = null;
  for (const node of input.roadNodes) {
    if (node.outsideConnection) continue;
    const distanceMeters = distanceToRect(node.position, rect);
    if (distanceMeters > maxAnchorDistanceMeters) continue;
    if (!anchor || distanceMeters < anchor.distanceMeters) {
      anchor = { entity: node.entity, position: node.position, distanceMeters };
    }
  }
  if (!anchor) violations.push("NO_ANCHOR_IN_REACH");

  // 2b. Which component that anchor is on. Being near a road is not being
  //     connected to it; the district has to join the net that carries the
  //     utilities, and that is a different question from distance.
  if (anchor && input.roadEdges && input.mainComponentRoot) {
    const nodeKey = (ref: SpatialRoadNode["entity"]) => `${ref.index}:${ref.version}`;
    const parent = new Map<string, string>();
    const find = (value: string): string => {
      let root = value;
      while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    for (const edge of input.roadEdges) {
      const left = nodeKey(edge.startNode); const right = nodeKey(edge.endNode);
      for (const value of [left, right]) if (!parent.has(value)) parent.set(value, value);
      const leftRoot = find(left); const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
    }
    const anchorNode = input.roadNodes.find((node) => nodeKey(node.entity) === nodeKey(anchor.entity));
    const onMain = anchorNode !== undefined
      && find(nodeKey(anchorNode.entity)) === find(nodeKey(input.mainComponentRoot));
    if (!onMain) violations.push("ANCHOR_NOT_ON_MAIN_COMPONENT");
  }

  // 3. Ground. A read too coarse to see a patch cannot certify the absence of one.
  const cellMeters = terrainCellMeters(input.terrain);
  if (!(cellMeters <= maxTerrainCellMeters)) violations.push("TERRAIN_READ_TOO_COARSE");
  const filtered = filterGridSegmentsByTerrain({
    segments: collection.segments,
    terrain: input.terrain,
    ...(input.maxGradePercent === undefined ? {} : { maxGradePercent: input.maxGradePercent }),
    ...(input.samplesPerSegment === undefined ? {} : { samplesPerSegment: input.samplesPerSegment }),
  });
  const water = filtered.rejected.filter((entry) => entry.reason === "WATER").length;
  const steep = filtered.rejected.filter((entry) => entry.reason === "STEEP_GRADE").length;
  const offTerrain = filtered.rejected.filter((entry) => entry.reason === "OFF_TERRAIN").length;
  if (water > 0) violations.push("WATER");
  if (steep > 0) violations.push("STEEP_GRADE");
  if (offTerrain > 0) violations.push("OFF_TERRAIN");

  const detail = `anchor=${anchor ? `${anchor.entity.index}:${anchor.entity.version}@${anchor.distanceMeters.toFixed(1)}m` : "none"}`
    + `, ground cells=${cellMeters.toFixed(1)}m kept=${filtered.kept.length}/${collection.segments.length}`
    + ` water=${water} steep=${steep} offTerrain=${offTerrain}`
    + (violations.includes("ANCHOR_NOT_ON_MAIN_COMPONENT") ? " anchor-not-on-main-component" : "");

  return {
    ok: violations.length === 0,
    anchor,
    terrain: { cells: input.terrain.resolution, cellMeters, kept: filtered.kept.length, water, steep, offTerrain },
    violations,
    detail,
  };
}

/**
 * The first candidate that passes, in the caller's order.
 *
 * Order is the caller's because "best" is a product judgement (nearest the city,
 * flattest, largest) and this module only knows legality. Returning the verdict
 * even on failure lets a caller report WHY every candidate was refused instead
 * of "no site found".
 */
export function pickCollectionSite<T extends CollectionSiteInput>(
  candidates: readonly T[],
): { index: number; input: T; verdict: CollectionSiteVerdict } | null {
  for (const [index, candidate] of candidates.entries()) {
    const verdict = selectCollectionSite(candidate);
    if (verdict.ok) return { index, input: candidate, verdict };
  }
  return null;
}
