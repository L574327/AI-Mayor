import { z } from "zod";
import type {
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialSiteDetail,
  SpatialTile,
  SpatialWorldModel,
} from "../spatial/types";
import { pointInTile } from "../spatial/world-scanner";

export const URBAN_SITE_CONTEXT_VERSION = 1 as const;
export const URBAN_SITE_CONTEXT_MAX_ANCHOR_SEEDS = 24;
export const URBAN_SITE_CONTEXT_MAX_CONSTRAINTS = 12;
export const URBAN_SITE_CONTEXT_MAX_UNAVAILABLE = 12;
export const URBAN_SITE_CONTEXT_MAX_TERRAIN_SAMPLES = 256;
export const URBAN_PLANNING_ANCHOR_MAX_COUNT = 8;

const boundedText = z.string().trim().min(1).max(160);
const entityRefSchema = z
  .object({ index: z.number().int().nonnegative(), version: z.number().int().nonnegative() })
  .strict();
const band = z.enum(["none", "small", "medium", "large"]);
const orientation = z.enum([
  "north_south",
  "northeast_southwest",
  "east_west",
  "southeast_northwest",
  "mixed",
  "unknown",
]);

const siteAreaSchema = z
  .object({
    tileCount: z.number().int().min(0).max(128),
    areaBand: band,
    boundaryBand: z.enum(["simple", "moderate", "complex", "unknown"]),
    buildableCoverage: z.number().finite().min(0).max(1).nullable(),
    availableFrontageCells: z.number().int().min(0).max(512).nullable(),
  })
  .strict();

const terrainSchema = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    sampleCount: z.number().int().min(0).max(URBAN_SITE_CONTEXT_MAX_TERRAIN_SAMPLES),
    slopeProfile: z.enum(["flat", "rolling", "steep", "mixed", "unknown"]),
    roughness: z.enum(["smooth", "varied", "rough", "unknown"]),
    meanSlopePercent: z.number().finite().min(0).max(100).nullable(),
    maxSlopePercent: z.number().finite().min(0).max(100).nullable(),
  })
  .strict();

const waterSchema = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    relationship: z.enum(["none", "river_edge", "coastline", "unknown"]),
    opportunity: z.boolean(),
    waterSampleBand: band,
  })
  .strict();

const roadSchema = z
  .object({
    edgeCount: z.number().int().min(0).max(2_000),
    nodeCount: z.number().int().min(0).max(4_000),
    endpointCount: z.number().int().min(0).max(512),
    gatewayCount: z.number().int().min(0).max(128),
    highwayEvidence: z.enum(["present", "absent", "unknown"]),
    dominantOrientation: orientation,
    orientationSpread: z.enum(["narrow", "moderate", "broad", "unknown"]),
    geometry: z.enum(["grid_like", "curved", "mixed", "sparse", "unknown"]),
    hierarchyEvidence: z.array(boundedText).max(6),
  })
  .strict();

const developmentSchema = z
  .object({
    buildingCount: z.number().int().min(0).max(2_000),
    occupiedZoningCells: z.number().int().min(0).max(10_000),
    developedClusterCount: z.number().int().min(0).max(64),
    extentBand: band,
  })
  .strict();

const frontageSchema = z
  .object({
    visibleRoadsideCells: z.number().int().min(0).max(10_000),
    availableRoadsideCells: z.number().int().min(0).max(512),
    opportunityBand: band,
    source: z.literal("spatial_zoning_cells"),
  })
  .strict();

const anchorSeedSchema = z
  .object({
    sourceId: boundedText,
    kind: z.enum(["gateway", "road_endpoint", "central_node", "undeveloped_edge", "waterfront_opportunity"]),
    sourceEntity: entityRefSchema,
    orientation,
    degree: z.number().int().min(0).max(64),
    waterfrontEligible: z.boolean(),
    availableFrontageCells: z.number().int().min(0).max(512),
    canonicalSource: z
      .object({
        kind: z.literal("road_node"),
        node: entityRefSchema,
        incidentRoads: z
          .array(
            z
              .object({
                edge: entityRefSchema,
                endpointRole: z.enum(["start", "end"]),
              })
              .strict(),
          )
          .min(1)
          .max(8),
        preferredRoad: z
          .object({
            edge: entityRefSchema,
            endpointRole: z.enum(["start", "end"]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const UrbanSiteContextSchema = z
  .object({
    version: z.literal(URBAN_SITE_CONTEXT_VERSION),
    siteId: boundedText,
    snapshotRevision: boundedText,
    areaClass: z.enum(["infill", "edge", "waterfront", "gateway", "isolated_pocket"]),
    buildableAreaBand: band,
    ownedLand: siteAreaSchema,
    terrain: terrainSchema,
    water: waterSchema,
    roadContext: roadSchema,
    development: developmentSchema,
    frontage: frontageSchema,
    adjacency: z
      .object({
        residential: z.enum(["present", "absent", "unavailable"]),
        commercial: z.enum(["present", "absent", "unavailable"]),
        industrial: z.enum(["present", "absent", "unavailable"]),
        source: z.enum(["snapshot_catalog", "spatial_zoning_cells", "unavailable"]),
      })
      .strict(),
    pollution: z
      .object({
        availability: z.literal("unavailable"),
        note: boundedText,
      })
      .strict(),
    constraints: z.array(boundedText).max(URBAN_SITE_CONTEXT_MAX_CONSTRAINTS),
    opportunities: z.array(boundedText).max(URBAN_SITE_CONTEXT_MAX_CONSTRAINTS),
    unavailableSignals: z.array(boundedText).max(URBAN_SITE_CONTEXT_MAX_UNAVAILABLE),
    anchorSeeds: z.array(anchorSeedSchema).max(URBAN_SITE_CONTEXT_MAX_ANCHOR_SEEDS),
  })
  .strict();

export type UrbanSiteContext = z.infer<typeof UrbanSiteContextSchema>;
export type UrbanAnchorSeed = z.infer<typeof anchorSeedSchema>;

export const PlanningAnchorSchema = z
  .object({
    id: boundedText,
    kind: z.enum(["gateway", "road_endpoint", "central_node", "undeveloped_edge", "waterfront_opportunity"]),
    sourceId: boundedText,
    sourceEntity: entityRefSchema,
    canonicalSource: anchorSeedSchema.shape.canonicalSource,
    rank: z
      .number()
      .int()
      .min(0)
      .max(URBAN_PLANNING_ANCHOR_MAX_COUNT - 1),
    orientation,
    areaClass: z.enum(["infill", "edge", "waterfront", "gateway", "isolated_pocket"]),
    terrainProfile: z.enum(["flat", "rolling", "steep", "mixed", "unknown"]),
    waterfrontEligible: z.boolean(),
    availableFrontageCells: z.number().int().min(0).max(512),
    adaptationHints: z.array(boundedText).max(6),
  })
  .strict();

export type UrbanPlanningAnchor = z.infer<typeof PlanningAnchorSchema>;
export type UrbanCanonicalSource = NonNullable<UrbanPlanningAnchor["canonicalSource"]>;

export interface UrbanSiteContextInput {
  world: SpatialWorldModel;
  detail?: SpatialSiteDetail;
  snapshot?: unknown;
  siteId?: string;
  snapshotRevision?: string;
}

function entityKey(entity: { index: number; version: number }): string {
  return `${entity.index}:${entity.version}`;
}

function canonicalSourceForNode(
  node: { entity: { index: number; version: number } },
  edges: readonly SpatialRoadEdge[],
  preferredEdge?: { index: number; version: number },
): UrbanCanonicalSource | undefined {
  const allIncidentRoads: UrbanCanonicalSource["incidentRoads"] = edges
    .flatMap((edge): UrbanCanonicalSource["incidentRoads"] => {
      if (entityKey(edge.startNode) === entityKey(node.entity)) {
        return [{ edge: edge.entity, endpointRole: "start" as const }];
      }
      if (entityKey(edge.endNode) === entityKey(node.entity)) {
        return [{ edge: edge.entity, endpointRole: "end" as const }];
      }
      return [];
    })
    .sort((left, right) => entityKey(left.edge).localeCompare(entityKey(right.edge)));
  if (allIncidentRoads.length === 0) return undefined;
  const preferredIncidentRoad = preferredEdge
    ? allIncidentRoads.find((relation) => entityKey(relation.edge) === entityKey(preferredEdge))
    : undefined;
  const incidentRoads = [
    ...(preferredIncidentRoad ? [preferredIncidentRoad] : []),
    ...allIncidentRoads.filter((relation) => relation !== preferredIncidentRoad),
  ].slice(0, 8);
  const preferredRoad = preferredEdge
    ? incidentRoads.find((relation) => entityKey(relation.edge) === entityKey(preferredEdge))
    : undefined;
  return {
    kind: "road_node",
    node: node.entity,
    incidentRoads,
    ...(preferredRoad ? { preferredRoad } : {}),
  };
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

function quantize(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bandForCount(value: number, medium: number, large: number): "none" | "small" | "medium" | "large" {
  if (value <= 0) return "none";
  if (value < medium) return "small";
  if (value < large) return "medium";
  return "large";
}

function orientationForVector(x: number, z: number): z.infer<typeof orientation> {
  const angle = ((Math.atan2(z, x) * 180) / Math.PI + 360) % 180;
  if (angle < 11.25 || angle >= 168.75) return "east_west";
  if (angle < 33.75) return "northeast_southwest";
  if (angle < 56.25) return "northeast_southwest";
  if (angle < 78.75) return "north_south";
  if (angle < 101.25) return "north_south";
  if (angle < 123.75) return "southeast_northwest";
  if (angle < 146.25) return "southeast_northwest";
  return "east_west";
}

function orientationHistogram(edges: readonly SpatialRoadEdge[]): {
  dominantOrientation: z.infer<typeof orientation>;
  orientationSpread: "narrow" | "moderate" | "broad" | "unknown";
} {
  if (edges.length === 0) return { dominantOrientation: "unknown", orientationSpread: "unknown" };
  const counts = new Map<z.infer<typeof orientation>, number>();
  for (const edge of edges) {
    const value = orientationForVector(edge.end.x - edge.start.x, edge.end.z - edge.start.z);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const share = ordered[0][1] / edges.length;
  return {
    dominantOrientation: ordered[0][0],
    orientationSpread: share >= 0.7 ? "narrow" : share >= 0.45 ? "moderate" : "broad",
  };
}

function roadGeometry(
  edges: readonly SpatialRoadEdge[],
  orientationSpread: string,
): "grid_like" | "curved" | "mixed" | "sparse" {
  if (edges.length < 3) return "sparse";
  if (orientationSpread === "narrow") return "grid_like";
  const prefabs = new Set(edges.map((edge) => edge.prefab));
  if (prefabs.size >= 3 && orientationSpread === "broad") return "mixed";
  return orientationSpread === "broad" ? "curved" : "mixed";
}

function tileArea(tile: SpatialTile): number {
  if (tile.polygon.length >= 3) {
    let area = 0;
    for (let index = 0; index < tile.polygon.length; index += 1) {
      const current = tile.polygon[index];
      const next = tile.polygon[(index + 1) % tile.polygon.length];
      area += current.x * next.z - next.x * current.z;
    }
    return Math.abs(area) / 2;
  }
  if (!tile.bounds) return 0;
  return Math.abs(tile.bounds.max.x - tile.bounds.min.x) * Math.abs(tile.bounds.max.z - tile.bounds.min.z);
}

function pointIsOwned(point: SpatialPoint2, tiles: readonly SpatialTile[]): boolean {
  return tiles.some((tile) => pointInTile(point, tile));
}

function terrainSummary(detail: SpatialSiteDetail | undefined) {
  if (!detail || detail.terrain.resolution <= 0 || detail.terrain.heights.length === 0) {
    return {
      availability: "unavailable" as const,
      sampleCount: 0,
      slopeProfile: "unknown" as const,
      roughness: "unknown" as const,
      meanSlopePercent: null,
      maxSlopePercent: null,
      waterSamples: 0,
      waterRatio: 0,
      waterTouchesBoundary: false,
    };
  }
  const resolution = detail.terrain.resolution;
  const count = Math.min(
    URBAN_SITE_CONTEXT_MAX_TERRAIN_SAMPLES,
    detail.terrain.heights.length,
    detail.terrain.waterDepths.length || detail.terrain.heights.length,
  );
  const step = Math.max(1, Math.floor(detail.terrain.heights.length / count));
  let samples = 0;
  let waterSamples = 0;
  let waterTouchesBoundary = false;
  let slopeTotal = 0;
  let maxSlope = 0;
  for (let index = 0; index < detail.terrain.heights.length && samples < count; index += step) {
    const height = detail.terrain.heights[index];
    if (!Number.isFinite(height)) continue;
    const row = Math.floor(index / resolution);
    const column = index % resolution;
    const water = detail.terrain.waterDepths[index] ?? 0;
    if (Number.isFinite(water) && water > 0) {
      waterSamples += 1;
      waterTouchesBoundary ||= row === 0 || column === 0 || row === resolution - 1 || column === resolution - 1;
    }
    const right = detail.terrain.heights[index + 1];
    const down = detail.terrain.heights[index + resolution];
    const horizontal = detail.terrain.cellSize.x || 1;
    const vertical = detail.terrain.cellSize.z || 1;
    const localSlope = Math.max(
      Number.isFinite(right) ? (Math.abs(right - height) / horizontal) * 100 : 0,
      Number.isFinite(down) ? (Math.abs(down - height) / vertical) * 100 : 0,
    );
    slopeTotal += localSlope;
    maxSlope = Math.max(maxSlope, localSlope);
    samples += 1;
  }
  const meanSlope = samples > 0 ? slopeTotal / samples : 0;
  const slopeProfile: z.infer<typeof terrainSchema>["slopeProfile"] =
    maxSlope <= 5 ? "flat" : meanSlope <= 8 ? "rolling" : meanSlope >= 18 ? "steep" : "mixed";
  const roughness: z.infer<typeof terrainSchema>["roughness"] =
    maxSlope <= 5 ? "smooth" : maxSlope <= 18 ? "varied" : "rough";
  return {
    availability: "available" as const,
    sampleCount: samples,
    slopeProfile,
    roughness,
    meanSlopePercent: quantize(meanSlope),
    maxSlopePercent: quantize(Math.min(100, maxSlope)),
    waterSamples,
    waterRatio: samples > 0 ? waterSamples / samples : 0,
    waterTouchesBoundary,
  };
}

function developedClusters(detail: SpatialSiteDetail | undefined): number {
  if (!detail || detail.buildings.length === 0) return 0;
  const bucketSize = Math.max(32, detail.radius / 4);
  const buckets = new Set<string>();
  for (const building of [...detail.buildings].sort((left, right) => left.entity.index - right.entity.index)) {
    if (!Number.isFinite(building.position.x) || !Number.isFinite(building.position.z)) continue;
    const bucketX = Math.floor((building.position.x - detail.center.x) / bucketSize);
    const bucketZ = Math.floor((building.position.z - detail.center.z) / bucketSize);
    buckets.add(`${bucketX}:${bucketZ}`);
  }
  return Math.min(64, buckets.size);
}

function availableFrontage(detail: SpatialSiteDetail | undefined, ownedTiles: readonly SpatialTile[]) {
  if (!detail) return { visibleRoadsideCells: 0, availableRoadsideCells: 0 };
  const visibleRoadsideCells = detail.zoningCells.filter((cell) => cell.visible && cell.roadside).length;
  const availableRoadsideCells = Math.min(
    512,
    detail.zoningCells.filter(
      (cell) =>
        cell.visible &&
        cell.roadside &&
        !cell.occupied &&
        !cell.blocked &&
        !cell.overridden &&
        cell.zoneType === 0 &&
        pointIsOwned(cell.position, ownedTiles),
    ).length,
  );
  return { visibleRoadsideCells, availableRoadsideCells };
}

function areaClass(input: {
  waterOpportunity: boolean;
  gatewayCount: number;
  availableFrontage: number;
  buildingCount: number;
}): z.infer<typeof UrbanSiteContextSchema>["areaClass"] {
  if (input.waterOpportunity) return "waterfront";
  if (input.gatewayCount > 0) return "gateway";
  if (input.availableFrontage > 0 && input.buildingCount > 0) return "infill";
  if (input.buildingCount > 0) return "edge";
  return "isolated_pocket";
}

function snapshotSignal(value: unknown): {
  available: boolean;
  residential: boolean;
  commercial: boolean;
  industrial: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { available: false, residential: false, commercial: false, industrial: false };
  const root = value as { planningCatalog?: { zoneTypes?: unknown } };
  const zoneTypes = Array.isArray(root.planningCatalog?.zoneTypes) ? root.planningCatalog.zoneTypes : [];
  const names = zoneTypes
    .filter((item): item is { areaType?: unknown; office?: unknown } => typeof item === "object" && item !== null)
    .map((item) => `${String(item.areaType ?? "")} ${String(item.office ?? "")}`.toLowerCase());
  return {
    available: Array.isArray(root.planningCatalog?.zoneTypes),
    residential: names.some((name) => name.includes("residential")),
    commercial: names.some((name) => name.includes("commercial")),
    industrial: names.some((name) => name.includes("industrial") && !name.includes("true")),
  };
}

export function buildUrbanSiteContext(input: UrbanSiteContextInput): UrbanSiteContext {
  const ownedTiles = [...input.world.ownedTiles].sort((left, right) =>
    entityKey(left.entity).localeCompare(entityKey(right.entity)),
  );
  const edges = [...input.world.roadGraph.edges]
    .filter((edge) => Number.isFinite(edge.length) && edge.length > 0)
    .sort((left, right) => entityKey(left.entity).localeCompare(entityKey(right.entity)));
  const nodes = [...input.world.roadGraph.nodes].sort((left, right) =>
    entityKey(left.entity).localeCompare(entityKey(right.entity)),
  );
  const terrain = terrainSummary(input.detail);
  const frontage = availableFrontage(input.detail, ownedTiles);
  const orientationFacts = orientationHistogram(edges);
  const endpointNodes = nodes.filter((node) => node.roadDegree <= 1 && pointIsOwned(node.position, ownedTiles));
  const gatewaySources = [...input.world.connectionCandidates]
    .sort(
      (left, right) =>
        (left.graphDistanceFromOutside ?? Infinity) - (right.graphDistanceFromOutside ?? Infinity) ||
        entityKey(left.node.entity).localeCompare(entityKey(right.node.entity)) ||
        (left.orientationRank ?? 0) - (right.orientationRank ?? 0),
    )
    .slice(0, 8);
  const highwayEvidence = edges.some((edge) => /highway|freeway|expressway/i.test(edge.prefab))
    ? "present"
    : edges.length > 0
      ? "absent"
      : "unknown";
  const waterOpportunity =
    terrain.availability === "available" && terrain.waterSamples > 0 && terrain.waterSamples < terrain.sampleCount;
  const waterRelationship = waterOpportunity ? (terrain.waterTouchesBoundary ? "coastline" : "river_edge") : "none";
  const buildingCount = Math.min(2_000, input.detail?.buildings.length ?? 0);
  const occupiedZoningCells = Math.min(10_000, input.detail?.zoningCells.filter((cell) => cell.occupied).length ?? 0);
  const developedClusterCount = developedClusters(input.detail);
  const snapshotZones = snapshotSignal(input.snapshot);
  const anchorSeeds: UrbanAnchorSeed[] = [];
  for (const candidate of gatewaySources) {
    const canonicalSource = canonicalSourceForNode(candidate.node, edges, candidate.incomingEdge);
    if (!canonicalSource) continue;
    anchorSeeds.push({
      sourceId: `road-${entityKey(candidate.node.entity)}`,
      kind: "gateway",
      sourceEntity: candidate.node.entity,
      orientation: candidate.forward ? orientationForVector(candidate.forward.x, candidate.forward.z) : "unknown",
      degree: candidate.node.roadDegree,
      waterfrontEligible: waterOpportunity,
      availableFrontageCells: frontage.availableRoadsideCells,
      canonicalSource,
    });
  }
  for (const node of endpointNodes.slice(0, 12)) {
    const canonicalSource = canonicalSourceForNode(node, edges);
    if (!canonicalSource) continue;
    anchorSeeds.push({
      sourceId: `road-${entityKey(node.entity)}`,
      kind: frontage.availableRoadsideCells > 0 ? "undeveloped_edge" : "road_endpoint",
      sourceEntity: node.entity,
      orientation: "unknown",
      degree: node.roadDegree,
      waterfrontEligible: waterOpportunity,
      availableFrontageCells: frontage.availableRoadsideCells,
      canonicalSource,
    });
  }
  const centralNode = nodes
    .filter((node) => node.roadDegree >= 3 && pointIsOwned(node.position, ownedTiles))
    .sort(
      (left, right) =>
        right.roadDegree - left.roadDegree || entityKey(left.entity).localeCompare(entityKey(right.entity)),
    )[0];
  if (centralNode) {
    const canonicalSource = canonicalSourceForNode(centralNode, edges);
    if (canonicalSource) {
      anchorSeeds.push({
        sourceId: `road-${entityKey(centralNode.entity)}`,
        kind: "central_node",
        sourceEntity: centralNode.entity,
        orientation: "unknown",
        degree: centralNode.roadDegree,
        waterfrontEligible: waterOpportunity,
        availableFrontageCells: frontage.availableRoadsideCells,
        canonicalSource,
      });
    }
  }
  const dedupedAnchorSeeds = [...new Map(anchorSeeds.map((seed) => [`${seed.kind}:${seed.sourceId}`, seed])).values()]
    .reduce((unique, seed) => unique.set(`${seed.kind}:${seed.sourceId}`, seed), new Map<string, UrbanAnchorSeed>())
    .values();
  const stableAnchorSeeds = [...dedupedAnchorSeeds]
    .sort((left, right) => `${left.kind}:${left.sourceId}`.localeCompare(`${right.kind}:${right.sourceId}`))
    .slice(0, URBAN_SITE_CONTEXT_MAX_ANCHOR_SEEDS);
  const siteId =
    input.siteId?.trim() ||
    `site-${stableHash(`${input.world.worldBounds.size}|${ownedTiles.map((tile) => entityKey(tile.entity)).join(",")}`)}`;
  const contextFacts = [
    siteId,
    edges.map((edge) => `${entityKey(edge.entity)}:${quantize(edge.length, 2)}`).join(","),
    nodes.map((node) => `${entityKey(node.entity)}:${node.roadDegree}`).join(","),
    ownedTiles.map((tile) => `${entityKey(tile.entity)}:${quantize(tileArea(tile), 1)}`).join(","),
    `${terrain.sampleCount}:${terrain.slopeProfile}:${terrain.waterSamples}:${frontage.availableRoadsideCells}`,
  ].join("|");
  const snapshotRevision = input.snapshotRevision?.trim() || `site-${stableHash(contextFacts)}`;
  const context = {
    version: URBAN_SITE_CONTEXT_VERSION,
    siteId,
    snapshotRevision,
    areaClass: areaClass({
      waterOpportunity,
      gatewayCount: gatewaySources.length,
      availableFrontage: frontage.availableRoadsideCells,
      buildingCount,
    }),
    buildableAreaBand: bandForCount(frontage.availableRoadsideCells, 24, 160),
    ownedLand: {
      tileCount: Math.min(128, ownedTiles.length),
      areaBand: bandForCount(
        ownedTiles.reduce((sum, tile) => sum + tileArea(tile), 0),
        10_000,
        100_000,
      ),
      boundaryBand:
        ownedTiles.reduce((sum, tile) => sum + tile.polygon.length, 0) > 48
          ? "complex"
          : ownedTiles.length > 4
            ? "moderate"
            : "simple",
      buildableCoverage:
        input.detail && input.detail.zoningCells.length > 0
          ? quantize(frontage.availableRoadsideCells / Math.max(1, input.detail.zoningCells.length), 3)
          : null,
      availableFrontageCells: input.detail ? frontage.availableRoadsideCells : null,
    },
    terrain: {
      availability: terrain.availability,
      sampleCount: terrain.sampleCount,
      slopeProfile: terrain.slopeProfile,
      roughness: terrain.roughness,
      meanSlopePercent: terrain.meanSlopePercent,
      maxSlopePercent: terrain.maxSlopePercent,
    },
    water: {
      availability: terrain.availability,
      relationship: waterRelationship,
      opportunity: waterOpportunity,
      waterSampleBand: bandForCount(terrain.waterSamples, 8, 64),
    },
    roadContext: {
      edgeCount: Math.min(2_000, edges.length),
      nodeCount: Math.min(4_000, nodes.length),
      endpointCount: Math.min(512, endpointNodes.length),
      gatewayCount: Math.min(128, gatewaySources.length),
      highwayEvidence,
      dominantOrientation: orientationFacts.dominantOrientation,
      orientationSpread: orientationFacts.orientationSpread,
      geometry: roadGeometry(edges, orientationFacts.orientationSpread),
      hierarchyEvidence: [
        ...new Set(
          edges.map((edge) =>
            /highway|freeway|expressway/i.test(edge.prefab)
              ? "highway"
              : /avenue|boulevard/i.test(edge.prefab)
                ? "arterial"
                : "local",
          ),
        ),
      ].sort(),
    },
    development: {
      buildingCount,
      occupiedZoningCells,
      developedClusterCount,
      extentBand: bandForCount(buildingCount + occupiedZoningCells, 20, 200),
    },
    frontage: {
      visibleRoadsideCells: Math.min(10_000, frontage.visibleRoadsideCells),
      availableRoadsideCells: frontage.availableRoadsideCells,
      opportunityBand: bandForCount(frontage.availableRoadsideCells, 24, 160),
      source: "spatial_zoning_cells",
    },
    adjacency: {
      residential: snapshotZones.residential ? "present" : snapshotZones.available ? "absent" : "unavailable",
      commercial: snapshotZones.commercial ? "present" : snapshotZones.available ? "absent" : "unavailable",
      industrial: snapshotZones.industrial ? "present" : snapshotZones.available ? "absent" : "unavailable",
      source: snapshotZones.available ? "snapshot_catalog" : "unavailable",
    },
    pollution: {
      availability: "unavailable",
      note: "pollution fields are not exposed by the current spatial scan",
    },
    constraints: [
      ...(ownedTiles.length === 0 ? ["no_owned_land"] : []),
      ...(input.detail ? [] : ["terrain_buildings_and_frontage_unavailable"]),
      ...(terrain.slopeProfile === "steep" ? ["steep_terrain_requires_adaptation"] : []),
      ...(waterOpportunity ? [] : ["no_verified_waterfront_opportunity"]),
    ].slice(0, URBAN_SITE_CONTEXT_MAX_CONSTRAINTS),
    opportunities: [
      ...(frontage.availableRoadsideCells > 0 ? ["existing_roadside_frontage"] : []),
      ...(gatewaySources.length > 0 ? ["connected_ingress_or_gateway"] : []),
      ...(waterOpportunity ? ["verified_waterfront_opportunity"] : []),
      ...(centralNode ? ["central_road_node"] : []),
    ].slice(0, URBAN_SITE_CONTEXT_MAX_CONSTRAINTS),
    unavailableSignals: [
      ...(input.detail ? [] : ["terrain_detail", "building_clusters", "zoning_frontage"]),
      "pollution",
      "authoritative_district_types",
    ].slice(0, URBAN_SITE_CONTEXT_MAX_UNAVAILABLE),
    anchorSeeds: stableAnchorSeeds,
  } satisfies UrbanSiteContext;
  return freezeDeep(UrbanSiteContextSchema.parse(context));
}

export function buildUrbanPlanningAnchors(context: UrbanSiteContext): readonly UrbanPlanningAnchor[] {
  const parsed = UrbanSiteContextSchema.parse(context);
  const priority: Record<UrbanAnchorSeed["kind"], number> = {
    waterfront_opportunity: 5,
    gateway: 4,
    central_node: 3,
    undeveloped_edge: 2,
    road_endpoint: 1,
  };
  const seeds = [
    ...new Map(
      [...parsed.anchorSeeds]
        .filter((seed) => seed.kind !== "waterfront_opportunity" || parsed.water.opportunity)
        .flatMap((seed) => {
          const base = {
            sourceId: seed.sourceId,
            sourceEntity: seed.sourceEntity,
            ...(seed.canonicalSource ? { canonicalSource: seed.canonicalSource } : {}),
            orientation: seed.orientation,
            degree: seed.degree,
            waterfrontEligible: seed.waterfrontEligible,
            availableFrontageCells: seed.availableFrontageCells,
          };
          const values: UrbanAnchorSeed[] = [{ ...seed, ...base }];
          if (seed.waterfrontEligible && parsed.water.opportunity && seed.kind !== "waterfront_opportunity") {
            values.push({ ...seed, ...base, kind: "waterfront_opportunity" });
          }
          return values;
        })
        .map((seed) => [`${seed.kind}:${seed.sourceId}`, seed] as const),
    ).values(),
  ]
    .sort(
      (left, right) =>
        priority[right.kind] - priority[left.kind] ||
        `${left.kind}:${left.sourceId}`.localeCompare(`${right.kind}:${right.sourceId}`),
    )
    .slice(0, URBAN_PLANNING_ANCHOR_MAX_COUNT);
  return freezeDeep(
    seeds.map(
      (seed, rank) =>
        ({
          id: `anchor-${seed.kind}-${seed.sourceId}`,
          kind: seed.kind,
          sourceId: seed.sourceId,
          sourceEntity: seed.sourceEntity,
          ...(seed.canonicalSource ? { canonicalSource: seed.canonicalSource } : {}),
          rank,
          orientation: seed.orientation,
          areaClass: parsed.areaClass,
          terrainProfile: parsed.terrain.slopeProfile,
          waterfrontEligible: seed.waterfrontEligible && parsed.water.opportunity,
          availableFrontageCells: seed.availableFrontageCells,
          adaptationHints: [
            ...(seed.kind === "gateway" ? ["gateway_aligned"] : []),
            ...(seed.kind === "central_node" ? ["node_centered"] : []),
            ...(seed.kind === "undeveloped_edge" ? ["edge_expansion"] : []),
            ...(seed.kind === "waterfront_opportunity" ? ["shoreline_following"] : []),
            ...(parsed.terrain.slopeProfile !== "flat" ? ["terrain_adapted"] : []),
          ],
        }) satisfies UrbanPlanningAnchor,
    ),
  );
}

export function stableUrbanDesignHash(value: string): string {
  return stableHash(value);
}
