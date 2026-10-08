import { planStarterGrid } from "./starter-layout";
import type {
  BootstrapSiteEvaluation,
  PlannedRoadSegment,
  SpatialBuilding,
  SpatialLocalTerrain,
  SpatialPoint2,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "./types";
import { pointInTile } from "./world-scanner";

function sampleLine(segment: PlannedRoadSegment, spacing = 8): SpatialPoint2[] {
  const length = Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z);
  const steps = Math.max(1, Math.ceil(length / spacing));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const ratio = index / steps;
    return {
      x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
      z: segment.start.z + (segment.end.z - segment.start.z) * ratio,
    };
  });
}

function terrainIndex(terrain: SpatialLocalTerrain, point: SpatialPoint2): number | null {
  const { minX, minZ, maxX, maxZ } = terrain.bounds;
  if (point.x < minX || point.x > maxX || point.z < minZ || point.z > maxZ) return null;
  const col = Math.min(
    terrain.resolution - 1,
    Math.max(0, Math.floor(((point.x - minX) / (maxX - minX)) * terrain.resolution)),
  );
  const row = Math.min(
    terrain.resolution - 1,
    Math.max(0, Math.floor(((point.z - minZ) / (maxZ - minZ)) * terrain.resolution)),
  );
  return row * terrain.resolution + col;
}

function buildingRadius(building: SpatialBuilding): number {
  if (!building.footprint) return 8;
  return Math.hypot(building.footprint.size.x, building.footprint.size.z) * 0.5;
}

function pointToSegmentDistance(point: SpatialPoint2, segment: PlannedRoadSegment): number {
  const dx = segment.end.x - segment.start.x;
  const dz = segment.end.z - segment.start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point.x - segment.start.x, point.z - segment.start.z);
  const ratio = Math.max(
    0,
    Math.min(1, ((point.x - segment.start.x) * dx + (point.z - segment.start.z) * dz) / lengthSquared),
  );
  return Math.hypot(point.x - (segment.start.x + ratio * dx), point.z - (segment.start.z + ratio * dz));
}

export function evaluateBootstrapSites(
  model: SpatialWorldModel,
  detailsByNode: ReadonlyMap<string, SpatialSiteDetail>,
): BootstrapSiteEvaluation[] {
  const evaluations: BootstrapSiteEvaluation[] = [];
  const orderedConnections = model.connectionCandidates.filter((connection) =>
    detailsByNode.has(`${connection.node.entity.index}:${connection.node.entity.version}`),
  );
  for (const connection of orderedConnections) {
    const key = `${connection.node.entity.index}:${connection.node.entity.version}`;
    const detail = detailsByNode.get(key);
    if (!detail) throw new Error(`missing site detail for connection ${key}`);
    const layout = planStarterGrid(model, connection);
    const rejectionReasons: string[] = [];
    let wetSamples = 0;
    let outsideOwnedSamples = 0;
    let missingTerrainSamples = 0;
    const grades: number[] = [];
    let sampledPoints = 0;

    for (const segment of layout.segments) {
      const points = sampleLine(segment);
      sampledPoints += points.length;
      let previousHeight: number | null = null;
      let previousPoint: SpatialPoint2 | null = null;
      for (const point of points) {
        if (!model.ownedTiles.some((tile) => pointInTile(point, tile))) outsideOwnedSamples++;
        const index = terrainIndex(detail.terrain, point);
        if (index === null || detail.terrain.heights[index] === undefined) {
          missingTerrainSamples++;
          continue;
        }
        if ((detail.terrain.waterDepths[index] ?? 0) > 0.05) wetSamples++;
        const height = detail.terrain.heights[index];
        if (previousHeight !== null && previousPoint) {
          const distance = Math.hypot(point.x - previousPoint.x, point.z - previousPoint.z);
          if (distance > 0) grades.push((Math.abs(height - previousHeight) / distance) * 100);
        }
        previousHeight = height;
        previousPoint = point;
      }
    }

    const buildingConflicts = detail.buildings.filter((building) =>
      layout.segments.some(
        (segment) => pointToSegmentDistance(building.position, segment) < buildingRadius(building) + 8,
      ),
    ).length;
    const usableExistingZoningCells = detail.zoningCells.filter(
      (cell) => cell.visible && !cell.blocked && !cell.overridden && !cell.occupied,
    ).length;
    const meanGradePercent = grades.length ? grades.reduce((sum, grade) => sum + grade, 0) / grades.length : 0;
    const maxGradePercent = grades.length ? Math.max(...grades) : 0;

    if (missingTerrainSamples > 0) rejectionReasons.push(`${missingTerrainSamples} layout samples lack terrain data`);
    if (outsideOwnedSamples > 0)
      rejectionReasons.push(`${outsideOwnedSamples} layout samples fall outside owned tiles`);
    if (wetSamples > 0) rejectionReasons.push(`${wetSamples} layout samples intersect water`);
    if (maxGradePercent > 12)
      rejectionReasons.push(`maximum sampled road grade ${maxGradePercent.toFixed(1)}% exceeds 12%`);
    if (buildingConflicts > 0) rejectionReasons.push(`${buildingConflicts} existing building footprints conflict`);

    const valid = rejectionReasons.length === 0;
    const score = valid
      ? 100 -
        meanGradePercent * 2 -
        maxGradePercent * 3 +
        Math.min(usableExistingZoningCells, 200) * 0.05 -
        (connection.graphDistanceFromOutside ?? 0) * 0.00001 -
        (connection.orientationRank ?? 0) * 0.000001
      : Number.NEGATIVE_INFINITY;
    evaluations.push({
      connection,
      layout,
      valid,
      score,
      rejectionReasons,
      metrics: {
        sampledPoints,
        meanGradePercent,
        maxGradePercent,
        wetSamples,
        outsideOwnedSamples,
        buildingConflicts,
        usableExistingZoningCells,
      },
    });
  }
  return evaluations.sort(
    (a, b) =>
      b.score - a.score ||
      a.connection.node.entity.index - b.connection.node.entity.index ||
      (a.connection.orientationRank ?? 0) - (b.connection.orientationRank ?? 0),
  );
}
