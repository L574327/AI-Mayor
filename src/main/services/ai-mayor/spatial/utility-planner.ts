import type {
  BootstrapSiteEvaluation,
  BootstrapUtilityPlan,
  PlannedRoadSegment,
  PlannedUtilityFacility,
  SpatialBootstrapAsset,
  SpatialLocalTerrain,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "./types";
import type { WaterFlowObservation } from "./water-flow";
import { pointInTile } from "./world-scanner";
import { isBridgeDomainNetSegmentLengthValid } from "../v2/road-contract";
import {
  certifySewageOutfallEnvironmentalSafety,
  type SewageEnvironmentalEvidence,
  type SewageIntakeCensus,
} from "../v2/sewage-environmental-safety";

interface GridSample {
  index: number;
  point: SpatialPoint2;
  height: number;
  waterDepth: number;
  groundWater: number;
  groundWaterPollution: number;
  windSpeed: number;
  localGradePercent: number;
}

export const MAX_UTILITY_SERVICE_ROAD_LENGTH = 2048;
const MAX_UTILITY_SERVICE_ROAD_SEGMENT_LENGTH = 1400;
export const MAX_UTILITY_CONNECTION_SEGMENT_LENGTH = 1400;
const SERVICE_ROAD_SAMPLE_SPACING = 8;
const SERVICE_ROAD_GRADE_LIMITS = [12, 18, 25, 35, 50, 75, 100] as const;
const MAX_SHORELINE_FACILITY_GRADE_PERCENT = 25;
const MIN_SERVICE_ROAD_SEGMENT_LENGTH = 24;
const MIN_SERVICE_ROAD_TURN_COSINE = -0.1;
export const MAX_WATER_PLANNING_CANDIDATES = 8;
/**
 * How many *complete* utility service proposals one plan may carry.
 *
 * A raw candidate is a facility site and a prefab; a complete proposal is that
 * plan after the native construction preflight has accepted it, connection
 * course included. The raw pool stays as wide as the planner's own bound,
 * because filtering is cheap and finding enough legal sites is the hard part —
 * but three whole plans is the contract's ceiling, and a fourth would decide
 * nothing: the planner takes the highest-ranked supported proposal and the rest
 * are alternatives it does not act on. Bounding it here also bounds the native
 * calls each plan costs, because the preflight is what makes a proposal whole.
 */
export const MAX_COMPLETE_UTILITY_PROPOSALS = 3;
// Each contact is only a planner option. The previous seven-contact cutoff
// prematurely handed off viable utility construction in dense road areas.
// Keep the search bounded while allowing the native validator to assess more
// distinct current road contacts before escalating.
export const MAX_UTILITY_CONTACT_CANDIDATES = 24;
export const MAX_POWER_UTILITY_SITE_CANDIDATES = 8;

export interface UtilitySiteQualityEvidence {
  windSpeed: number;
  roadDistance: number;
  connectionDistance: number;
  corridorReuse?: number;
  futureService?: number;
}

/** A soft site rank: legality and placement authority remain with the existing boundaries. */
export function scoreUtilitySiteQuality(evidence: UtilitySiteQualityEvidence): number {
  const wind = Number.isFinite(evidence.windSpeed) ? evidence.windSpeed : 0;
  const road = Number.isFinite(evidence.roadDistance) ? evidence.roadDistance : 1_000;
  const connection = Number.isFinite(evidence.connectionDistance) ? evidence.connectionDistance : 1_000;
  return wind * 12 - road * 0.18 - connection * 0.08 +
    (evidence.corridorReuse ?? 0) * 2 + (evidence.futureService ?? 0);
}

export function rankUtilitySiteCandidates<T extends { siteEvidence: UtilitySiteQualityEvidence }>(
  candidates: readonly T[], maximum = MAX_POWER_UTILITY_SITE_CANDIDATES,
): T[] {
  return candidates.map((candidate, index) => ({ candidate, index, score: scoreUtilitySiteQuality(candidate.siteEvidence) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Math.min(MAX_POWER_UTILITY_SITE_CANDIDATES, Math.floor(maximum))))
    .map((entry) => entry.candidate);
}

export class UtilityPlanningError extends Error {
  readonly code = "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY" as const;

  constructor(readonly diagnostics: Record<string, number>) {
    super("no authoritative player road is available for utility connection");
    this.name = "UtilityPlanningError";
  }
}

export class NoSupportedWaterTopologyError extends Error {
  readonly code = "NO_SUPPORTED_WATER_TOPOLOGY" as const;
  constructor(readonly candidateCount: number, readonly supportedCandidateCount: 0, readonly rejections: readonly string[],
    readonly funnel?: WaterStageAFunnel) {
    super("NO_SUPPORTED_WATER_TOPOLOGY");
    this.name = "NoSupportedWaterTopologyError";
  }
}

export interface WaterStageAFunnel {
  rawTerrainSampleCount: number;
  inCurrentScopeCount: number;
  ownedDryBuildableCount: number;
  groundwaterEligibleCount: number;
  withinExistingRoadReachCount: number;
  eligibleGroundwaterAssetCount: number;
  placementInputCandidateCount: number;
  finalStageACandidateCount: number;
  firstZeroingFilter: string | null;
}

export function isPermanentPlacedRoad(edge: SpatialRoadEdge): boolean {
  return Number.isInteger(edge.entity.index) && Number.isInteger(edge.entity.version) &&
    Number.isInteger(edge.startNode.index) && Number.isInteger(edge.startNode.version) &&
    Number.isInteger(edge.endNode.index) && Number.isInteger(edge.endNode.version) &&
    typeof edge.prefab === "string" && edge.prefab.trim().length > 0 &&
    Number.isFinite(edge.start.x) && Number.isFinite(edge.start.z) &&
    Number.isFinite(edge.end.x) && Number.isFinite(edge.end.z) &&
    Number.isFinite(edge.length) && edge.length > 0 &&
    edge.temp !== true && edge.deleted !== true && edge.owner == null;
}

export function nearestPermanentRoadPoint(point: SpatialPoint2, edges: SpatialRoadEdge[]): { point: SpatialPoint2; distance: number } {
  return nearestNetworkPoint(point, [], edges.filter(isPermanentPlacedRoad));
}

/** Rank distinct contacts on the caller's already-authorized permanent roads. */
export function rankedPermanentRoadContacts(
  point: SpatialPoint2,
  edges: readonly SpatialRoadEdge[],
  excludedContacts: readonly SpatialPoint2[] = [],
  maximum = MAX_UTILITY_CONTACT_CANDIDATES,
): Array<{ point: SpatialPoint2; distance: number; roadRef: SpatialRoadEdge["entity"] }> {
  const ranked = edges.filter(isPermanentPlacedRoad).flatMap((edge) => {
    const projected = nearestPermanentRoadPoint(point, [edge]);
    return [
      { ...projected, roadRef: edge.entity },
      { point: { x: edge.start.x, z: edge.start.z }, distance: Math.hypot(point.x - edge.start.x, point.z - edge.start.z), roadRef: edge.entity },
      { point: { x: edge.end.x, z: edge.end.z }, distance: Math.hypot(point.x - edge.end.x, point.z - edge.end.z), roadRef: edge.entity },
    ];
  }).filter((candidate) => Number.isFinite(candidate.distance))
    .sort((left, right) => left.distance - right.distance);
  const distinct: Array<{ point: SpatialPoint2; distance: number; roadRef: SpatialRoadEdge["entity"] }> = [];
  for (const candidate of ranked) {
    if (excludedContacts.some((excluded) => Math.hypot(candidate.point.x - excluded.x, candidate.point.z - excluded.z) <= 2)) continue;
    if (distinct.some((existing) => Math.hypot(candidate.point.x - existing.point.x, candidate.point.z - existing.point.z) <= 2)) continue;
    distinct.push(candidate);
    if (distinct.length >= Math.max(1, Math.floor(maximum))) break;
  }
  return distinct;
}

export interface PlannedUtilityConnectionSegment {
  prefab: PlannedUtilityFacility["connection"]["prefab"];
  start: SpatialPoint2;
  end: SpatialPoint2;
}

export function splitUtilityConnection(
  connection: PlannedUtilityFacility["connection"],
  maximumLength = MAX_UTILITY_CONNECTION_SEGMENT_LENGTH,
): PlannedUtilityConnectionSegment[] {
  const dx = connection.end.x - connection.start.x;
  const dz = connection.end.z - connection.start.z;
  const length = Math.hypot(dx, dz);
  const count = Math.max(1, Math.ceil(length / maximumLength));
  const segments = Array.from({ length: count }, (_, index) => ({
    prefab: connection.prefab,
    start: {
      x: connection.start.x + (dx * index) / count,
      z: connection.start.z + (dz * index) / count,
    },
    end: {
      x: connection.start.x + (dx * (index + 1)) / count,
      z: connection.start.z + (dz * (index + 1)) / count,
    },
  }));
  return segments.every((segment) => isBridgeDomainNetSegmentLengthValid(segment.start, segment.end)) ? segments : [];
}

function selectCheapest(
  assets: SpatialBootstrapAsset[],
  predicate: (asset: SpatialBootstrapAsset) => boolean,
  label: string,
): SpatialBootstrapAsset {
  const candidates = assets.filter((asset) => !asset.locked && predicate(asset));
  if (candidates.length === 0) throw new Error(`no unlocked ${label} bootstrap asset is available`);
  return candidates.sort((a, b) => a.constructionCost - b.constructionCost)[0];
}

function gridSamples(terrain: SpatialLocalTerrain): GridSample[] {
  const samples: GridSample[] = [];
  const { resolution } = terrain;
  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const index = row * resolution + col;
      const point = {
        x: terrain.bounds.minX + (col + 0.5) * terrain.cellSize.x,
        z: terrain.bounds.minZ + (row + 0.5) * terrain.cellSize.z,
      };
      const neighborIndexes = [
        col > 0 ? index - 1 : index,
        col + 1 < resolution ? index + 1 : index,
        row > 0 ? index - resolution : index,
        row + 1 < resolution ? index + resolution : index,
      ];
      const maxRise = Math.max(
        ...neighborIndexes.map((neighbor) => Math.abs(terrain.heights[index] - terrain.heights[neighbor])),
      );
      const spacing = Math.min(terrain.cellSize.x, terrain.cellSize.z);
      samples.push({
        index,
        point,
        height: terrain.heights[index],
        waterDepth: terrain.waterDepths[index] ?? 0,
        groundWater: terrain.groundWater[index] ?? 0,
        groundWaterPollution: terrain.groundWaterPollution[index] ?? 0,
        windSpeed: terrain.windSpeed[index] ?? 0,
        localGradePercent: spacing > 0 ? (maxRise / spacing) * 100 : Number.POSITIVE_INFINITY,
      });
    }
  }
  return samples;
}

function closestPointOnSegment(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): SpatialPoint2 {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return start;
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return { x: start.x + ratio * dx, z: start.z + ratio * dz };
}

function nearestNetworkPoint(
  point: SpatialPoint2,
  planned: PlannedRoadSegment[],
  existing: SpatialRoadEdge[],
): { point: SpatialPoint2; distance: number } {
  let best = { point, distance: Number.POSITIVE_INFINITY };
  for (const segment of planned) {
    const candidate = closestPointOnSegment(point, segment.start, segment.end);
    const distance = Math.hypot(point.x - candidate.x, point.z - candidate.z);
    if (distance < best.distance) best = { point: candidate, distance };
  }
  for (const edge of existing) {
    const candidate = closestPointOnSegment(point, edge.start, edge.end);
    const distance = Math.hypot(point.x - candidate.x, point.z - candidate.z);
    if (distance < best.distance) best = { point: candidate, distance };
  }
  return best;
}

function onOwnedDryBuildableLand(sample: GridSample, model: SpatialWorldModel): boolean {
  return (
    sample.waterDepth <= 0.05 &&
    sample.localGradePercent <= 8 &&
    model.ownedTiles.some((tile) => pointInTile(sample.point, tile))
  );
}

function rotationToward(from: SpatialPoint2, to: SpatialPoint2): number {
  const degrees = (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

const CS2_BUILDING_LOT_CELL_METERS = 4;
const GROUNDWATER_PUMP_WITNESS_ROAD_CLEARANCE_METERS = 8.92993;

function buildingForwardFromRotation(rotationDegrees: number): SpatialPoint2 {
  // Match rotationToward's CS2 yaw convention: 0 degrees faces world +Z;
  // positive yaw turns toward +X.
  const radians = (rotationDegrees * Math.PI) / 180;
  return { x: Math.sin(radians), z: Math.cos(radians) };
}

export function groundwaterPumpFacilityRoadTarget(input: {
  center: SpatialPoint2;
  lotSizeAlongForward: number;
  rotationDegrees: number;
}): { forward: SpatialPoint2; frontage: SpatialPoint2; clearanceMeters: number; facilityEndpoint: SpatialPoint2 } {
  const forward = buildingForwardFromRotation(input.rotationDegrees);
  const frontageDistance = input.lotSizeAlongForward * CS2_BUILDING_LOT_CELL_METERS;
  const frontage = {
    x: input.center.x + forward.x * frontageDistance,
    z: input.center.z + forward.z * frontageDistance,
  };
  return {
    forward,
    frontage,
    clearanceMeters: GROUNDWATER_PUMP_WITNESS_ROAD_CLEARANCE_METERS,
    facilityEndpoint: {
      x: frontage.x + forward.x * GROUNDWATER_PUMP_WITNESS_ROAD_CLEARANCE_METERS,
      z: frontage.z + forward.z * GROUNDWATER_PUMP_WITNESS_ROAD_CLEARANCE_METERS,
    },
  };
}

export function serviceRoadFor(
  kind: PlannedUtilityFacility["kind"],
  asset: SpatialBootstrapAsset,
  facilityPoint: SpatialPoint2,
  roadNetworkPoint: SpatialPoint2,
  rotationDegrees = 0,
): PlannedRoadSegment | undefined {
  const distance = Math.hypot(facilityPoint.x - roadNetworkPoint.x, facilityPoint.z - roadNetworkPoint.z);
  if (asset.prefab === "GroundwaterPumpingStation01") {
    // Native BuildingUtils.CalculateFrontPosition uses lotSizeY along local +Z.
    // Spatial asset lotSize.z carries that forward-axis lot dimension.
    const geometry = groundwaterPumpFacilityRoadTarget({
      center: facilityPoint,
      lotSizeAlongForward: asset.lotSize.z,
      rotationDegrees,
    });
    // 8.92993m is the clearance from the historical successful Pump witness
    // (frontage to attached Road endpoint). It is certified only for this
    // GroundwaterPumpingStation01 scenario, not as a generic building rule.
    if (Math.hypot(geometry.facilityEndpoint.x - roadNetworkPoint.x, geometry.facilityEndpoint.z - roadNetworkPoint.z) <= 8) return undefined;
    return { id: `${kind}-service-road`, role: "side", start: roadNetworkPoint, end: geometry.facilityEndpoint };
  }
  const frontageOffset = Math.max(asset.size.x, asset.size.z) * 0.5 + 12;
  if (distance <= frontageOffset + 8) return undefined;
  const towardNetwork = {
    x: (roadNetworkPoint.x - facilityPoint.x) / distance,
    z: (roadNetworkPoint.z - facilityPoint.z) / distance,
  };
  return {
    id: `${kind}-service-road`,
    role: "side",
    start: roadNetworkPoint,
    end: {
      x: facilityPoint.x + towardNetwork.x * frontageOffset,
      z: facilityPoint.z + towardNetwork.z * frontageOffset,
    },
  };
}

/**
 * Bounded first-leg headings, in degrees, relative to the direct source→destination
 * bearing.
 *
 * Every other family leaves the source point on a heading close to the direct one:
 * the straight route sits on it, and the lateral doglegs stay within about 50
 * degrees of it because their offset is a fixed fraction of the direct length.
 * Live differential evidence shows that is not enough. Native treats a course that
 * runs along an existing road as a rebuild of that road, so it emits no new
 * proposal edge at all and the preview fails with
 * `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` -- for every heading inside the occupied
 * corridor. When the destination happens to lie along the road the source point
 * sits on, the whole near-direct fan is inside that corridor and the bounded
 * family has no legal member left, even though headings well outside it certify.
 *
 * These offsets are the bounded complement: a first leg that leaves the source in
 * a genuinely different direction and a second leg that still arrives at the
 * destination. They pass through exactly the same length, ownership, terrain and
 * native preview filters as every other candidate.
 */
const SERVICE_ROAD_FAN_OFFSETS_DEGREES = [60, -60, 90, -90, 120, -120] as const;
/** First-leg length of a fan route: long enough to leave the junction, capped so the second leg stays a road. */
const SERVICE_ROAD_FAN_FIRST_LEG_METERS = { minimum: 12, maximum: 40, fractionOfDirect: 0.4 } as const;

/** Bounded straight-segment access corridors, ordered by construction count. */
export function serviceRoadRouteCandidates(
  direct: PlannedRoadSegment,
  options: { targetRoadDirection?: SpatialPoint2; includeHeadingFan?: boolean } = {},
): PlannedRoadSegment[][] {
  const dx = direct.end.x - direct.start.x;
  const dz = direct.end.z - direct.start.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 8) return [];
  const lateral = Math.min(24, Math.max(8, length / 4));
  const normal = { x: -dz / length, z: dx / length };
  const route = (count: number, side: number): PlannedRoadSegment[] => {
    const points = [direct.start];
    for (let index = 1; index < count; index += 1) {
      const fraction = index / count;
      points.push({
        x: direct.start.x + dx * fraction + normal.x * lateral * side,
        z: direct.start.z + dz * fraction + normal.z * lateral * side,
      });
    }
    points.push(direct.end);
    return points.slice(0, -1).map((point, index) => ({
      id: `${direct.id}:segment:${index + 1}`,
      role: direct.role,
      start: { ...point },
      end: { ...points[index + 1] },
    }));
  };
  const candidates = [route(1, 0), ...[2, 3, 4].flatMap((count) => [route(count, 1), route(count, -1)])];
  if (options.includeHeadingFan !== false) {
    const directBearing = Math.atan2(dz, dx);
    const firstLeg = Math.min(
      SERVICE_ROAD_FAN_FIRST_LEG_METERS.maximum,
      Math.max(SERVICE_ROAD_FAN_FIRST_LEG_METERS.minimum, length * SERVICE_ROAD_FAN_FIRST_LEG_METERS.fractionOfDirect),
    );
    for (const offset of SERVICE_ROAD_FAN_OFFSETS_DEGREES) {
      const bearing = directBearing + (offset * Math.PI) / 180;
      const waypoint = {
        x: direct.start.x + Math.cos(bearing) * firstLeg,
        z: direct.start.z + Math.sin(bearing) * firstLeg,
      };
      candidates.push([
        { id: `${direct.id}:heading-fan:${offset}:out`, role: direct.role, start: { ...direct.start }, end: waypoint },
        { id: `${direct.id}:heading-fan:${offset}:in`, role: direct.role, start: waypoint, end: { ...direct.end } },
      ]);
    }
  }
  const targetDirection = options.targetRoadDirection;
  if (targetDirection) {
    const targetLength = Math.hypot(targetDirection.x, targetDirection.z);
    if (Number.isFinite(targetLength) && targetLength > 0) {
      const nx = -targetDirection.z / targetLength;
      const nz = targetDirection.x / targetLength;
      const approach = Math.min(36, Math.max(24, length * 0.2));
      for (const side of [-1, 1]) {
        const waypoint = { x: direct.start.x - nx * approach * side, z: direct.start.z - nz * approach * side };
        candidates.push([
          { id: `${direct.id}:junction-branch:${side}:approach`, role: direct.role, start: { ...direct.start }, end: waypoint },
          { id: `${direct.id}:junction-branch:${side}:entry`, role: direct.role, start: waypoint, end: { ...direct.end } },
        ]);
      }
    }
  }
  return candidates;
}

/**
 * Degrees a route's first leg may differ from an existing corridor's direction and
 * still be considered a restatement of it. A first leg inside this cone produces no
 * new road: native folds it back into the corridor it follows.
 */
export const SERVICE_ROAD_CORRIDOR_DUPLICATION_TOLERANCE_DEGREES = 25;

/**
 * Degrees of divergence from a road's own bearing below which native folds a
 * course back into that road instead of certifying a new one.
 *
 * Measured live at the end node of a just-built road: a course on the road's
 * bearing, and one half a degree off it, both certify NO new proposal edge
 * (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, `proposalEdgeCount` 0), while one
 * degree off certifies — at 114 m and at 300 m alike. Two degrees is that
 * boundary with headroom.
 *
 * Deliberately NOT `SERVICE_ROAD_CORRIDOR_DUPLICATION_TOLERANCE_DEGREES`. That
 * twenty-five degree cone is the bounded heading family's dedup rule — wide on
 * purpose, because that whole family leaves within roughly fifty degrees of the
 * direct bearing. Judging the DIRECTED course by it discards the very course the
 * corridor planned: a corridor that runs straight has hops a few degrees off the
 * road each one continues, native certifies every one of them, and the wider cone
 * refuses all of them as duplicates.
 */
export const ROAD_NATIVE_COLLINEAR_FOLD_DEGREES = 2;

/** Unit direction of a route's first leg, or undefined when the route is degenerate. */
export function routeFirstLegDirection(route: readonly PlannedRoadSegment[]): SpatialPoint2 | undefined {
  const first = route[0];
  if (!first) return undefined;
  const dx = first.end.x - first.start.x;
  const dz = first.end.z - first.start.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= 0) return undefined;
  return { x: dx / length, z: dz / length };
}

/**
 * Whether a route leaves its source along `corridor`, in either direction.
 *
 * The source point of a service road lies on the road it connects to, so a first
 * leg that follows that road is not a new road, it is a rebuild of that one --
 * and native answers it with no new proposal edge. Excluding the cone keeps the
 * bounded family on headings that can actually produce the connection.
 */
export function routeFirstLegDuplicatesCorridor(
  route: readonly PlannedRoadSegment[],
  corridor: SpatialPoint2,
  toleranceDegrees = SERVICE_ROAD_CORRIDOR_DUPLICATION_TOLERANCE_DEGREES,
): boolean {
  const direction = routeFirstLegDirection(route);
  const corridorLength = Math.hypot(corridor.x, corridor.z);
  if (!direction || !Number.isFinite(corridorLength) || corridorLength <= 0) return false;
  const unit = { x: corridor.x / corridorLength, z: corridor.z / corridorLength };
  const cosine = Math.abs(direction.x * unit.x + direction.z * unit.z);
  return cosine >= Math.cos((toleranceDegrees * Math.PI) / 180);
}


function serviceRoadLength(segment: PlannedRoadSegment | undefined): number {
  return segment ? Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z) : 0;
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

function terrainCellCenter(terrain: SpatialLocalTerrain, index: number): SpatialPoint2 {
  const col = index % terrain.resolution;
  const row = Math.floor(index / terrain.resolution);
  return {
    x: terrain.bounds.minX + (col + 0.5) * terrain.cellSize.x,
    z: terrain.bounds.minZ + (row + 0.5) * terrain.cellSize.z,
  };
}

function buildingRadius(building: SpatialSiteDetail["buildings"][number]): number {
  if (!building.footprint) return 8;
  return Math.hypot(building.footprint.size.x, building.footprint.size.z) * 0.5;
}

function pointToSegmentDistance(point: SpatialPoint2, segment: PlannedRoadSegment): number {
  const closest = closestPointOnSegment(point, segment.start, segment.end);
  return Math.hypot(point.x - closest.x, point.z - closest.z);
}

type ServiceRoadIssue = "too_long" | "building" | "outside_owned" |
  "terrain" | "terrain_unaddressed" | "terrain_height_missing" | "water" | "slope";

function serviceRoadIssue(
  segment: PlannedRoadSegment | undefined,
  model: SpatialWorldModel,
  detail: SpatialSiteDetail,
  maximumGradePercent = SERVICE_ROAD_GRADE_LIMITS[SERVICE_ROAD_GRADE_LIMITS.length - 1],
): ServiceRoadIssue | null {
  if (!segment) return null;
  const length = serviceRoadLength(segment);
  if (length > MAX_UTILITY_SERVICE_ROAD_SEGMENT_LENGTH) return "too_long";
  if (
    detail.buildings.some(
      (building) => pointToSegmentDistance(building.position, segment) < buildingRadius(building) + 8,
    )
  ) {
    return "building";
  }
  const steps = Math.max(1, Math.ceil(length / SERVICE_ROAD_SAMPLE_SPACING));
  let previousTerrainIndex: number | undefined;
  for (let index = 0; index <= steps; index++) {
    const ratio = index / steps;
    const point = {
      x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
      z: segment.start.z + (segment.end.z - segment.start.z) * ratio,
    };
    if (!model.ownedTiles.some((tile) => pointInTile(point, tile))) return "outside_owned";
    const terrainSampleIndex = terrainIndex(detail.terrain, point);
    // Two different facts, named apart: the point could not be addressed in the
    // read at all, or it addressed a cell the read did not carry a height for.
    // Collapsing them hid which of the two a corridor actually hit.
    if (terrainSampleIndex === null) return "terrain_unaddressed";
    if (detail.terrain.heights[terrainSampleIndex] === undefined) return "terrain_height_missing";
    if ((detail.terrain.waterDepths[terrainSampleIndex] ?? 0) > 0.05) return "water";
    if (previousTerrainIndex !== undefined && terrainSampleIndex !== previousTerrainIndex) {
      const previousCenter = terrainCellCenter(detail.terrain, previousTerrainIndex);
      const currentCenter = terrainCellCenter(detail.terrain, terrainSampleIndex);
      const sampleDistance = Math.hypot(currentCenter.x - previousCenter.x, currentCenter.z - previousCenter.z);
      if (
        sampleDistance > 0 &&
        (Math.abs(detail.terrain.heights[terrainSampleIndex] - detail.terrain.heights[previousTerrainIndex]) /
          sampleDistance) *
          100 >
          maximumGradePercent
      ) {
        return "slope";
      }
    }
    previousTerrainIndex = terrainSampleIndex;
  }
  return null;
}

interface ServiceRoadPath {
  segments: PlannedRoadSegment[];
  length: number;
  gradeLimit: number;
}

function orientation(a: SpatialPoint2, b: SpatialPoint2, c: SpatialPoint2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function segmentsCross(a: PlannedRoadSegment, b: PlannedRoadSegment): boolean {
  const ab1 = orientation(a.start, a.end, b.start);
  const ab2 = orientation(a.start, a.end, b.end);
  const ba1 = orientation(b.start, b.end, a.start);
  const ba2 = orientation(b.start, b.end, a.end);
  return ab1 * ab2 < 0 && ba1 * ba2 < 0;
}

function serviceRoadTopologyIsBuildable(segments: PlannedRoadSegment[]): boolean {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (serviceRoadLength(segment) < MIN_SERVICE_ROAD_SEGMENT_LENGTH) return false;
    const previous = segments[index - 1];
    if (previous) {
      const previousLength = serviceRoadLength(previous);
      const currentLength = serviceRoadLength(segment);
      const cosine =
        ((previous.end.x - previous.start.x) * (segment.end.x - segment.start.x) +
          (previous.end.z - previous.start.z) * (segment.end.z - segment.start.z)) /
        (previousLength * currentLength);
      if (cosine < MIN_SERVICE_ROAD_TURN_COSINE) return false;
    }
    for (let otherIndex = 0; otherIndex < index - 1; otherIndex++) {
      if (segmentsCross(segment, segments[otherIndex])) return false;
    }
  }
  return true;
}

interface QueueEntry {
  index: number;
  cost: number;
}

class MinQueue {
  private readonly entries: QueueEntry[] = [];

  push(entry: QueueEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentEntry = this.entries[parent];
      if (parentEntry.cost < entry.cost || (parentEntry.cost === entry.cost && parentEntry.index <= entry.index)) break;
      this.entries[index] = parentEntry;
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): QueueEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!first || !last || this.entries.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      let child = left;
      if (
        right < this.entries.length &&
        (this.entries[right].cost < this.entries[left].cost ||
          (this.entries[right].cost === this.entries[left].cost &&
            this.entries[right].index < this.entries[left].index))
      ) {
        child = right;
      }
      const childEntry = this.entries[child];
      if (last.cost < childEntry.cost || (last.cost === childEntry.cost && last.index <= childEntry.index)) break;
      this.entries[index] = childEntry;
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

function serviceRoadPath(
  kind: PlannedUtilityFacility["kind"],
  asset: SpatialBootstrapAsset,
  facilityPoint: SpatialPoint2,
  roads: PlannedRoadSegment[],
  existingRoads: SpatialRoadEdge[],
  model: SpatialWorldModel,
  detail: SpatialSiteDetail,
  maximumGradePercent: number,
): ServiceRoadPath | undefined {
  const terrain = detail.terrain;
  const startIndex = terrainIndex(terrain, facilityPoint);
  if (startIndex === null) return undefined;
  const cellIsBuildable = (index: number): boolean => {
    const point = terrainCellCenter(terrain, index);
    return (
      model.ownedTiles.some((tile) => pointInTile(point, tile)) &&
      (terrain.waterDepths[index] ?? 0) <= 0.05 &&
      !detail.buildings.some(
        (building) =>
          Math.hypot(point.x - building.position.x, point.z - building.position.z) < buildingRadius(building) + 8,
      )
    );
  };
  if (!cellIsBuildable(startIndex)) return undefined;

  const roadAnchors = new Map<number, SpatialPoint2>();
  const anchorSpacing = Math.max(8, Math.min(terrain.cellSize.x, terrain.cellSize.z) * 0.5);
  for (const road of [...roads, ...existingRoads]) {
    const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    const steps = Math.max(1, Math.ceil(length / anchorSpacing));
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps;
      const point = {
        x: road.start.x + (road.end.x - road.start.x) * ratio,
        z: road.start.z + (road.end.z - road.start.z) * ratio,
      };
      if (!model.ownedTiles.some((tile) => pointInTile(point, tile))) continue;
      const index = terrainIndex(terrain, point);
      if (index !== null && cellIsBuildable(index) && !roadAnchors.has(index)) roadAnchors.set(index, point);
    }
  }
  if (roadAnchors.size === 0) return undefined;

  const nodeCount = terrain.resolution * terrain.resolution;
  const costs = new Float64Array(nodeCount);
  costs.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(nodeCount);
  previous.fill(-1);
  const queue = new MinQueue();
  costs[startIndex] = 0;
  queue.push({ index: startIndex, cost: 0 });
  const neighborOffsets = [
    [-1, 0],
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as const;
  let goalIndex: number | undefined;
  while (true) {
    const current = queue.pop();
    if (!current || current.cost > MAX_UTILITY_SERVICE_ROAD_LENGTH) break;
    if (current.cost !== costs[current.index]) continue;
    if (roadAnchors.has(current.index)) {
      goalIndex = current.index;
      break;
    }
    const col = current.index % terrain.resolution;
    const row = Math.floor(current.index / terrain.resolution);
    const currentCenter = terrainCellCenter(terrain, current.index);
    for (const [colOffset, rowOffset] of neighborOffsets) {
      const nextCol = col + colOffset;
      const nextRow = row + rowOffset;
      if (nextCol < 0 || nextCol >= terrain.resolution || nextRow < 0 || nextRow >= terrain.resolution) continue;
      const nextIndex = nextRow * terrain.resolution + nextCol;
      if (!cellIsBuildable(nextIndex)) continue;
      const nextCenter = terrainCellCenter(terrain, nextIndex);
      const distance = Math.hypot(nextCenter.x - currentCenter.x, nextCenter.z - currentCenter.z);
      const grade = (Math.abs(terrain.heights[nextIndex] - terrain.heights[current.index]) / distance) * 100;
      if (grade > maximumGradePercent) continue;
      const nextCost = current.cost + distance;
      if (nextCost >= costs[nextIndex] || nextCost > MAX_UTILITY_SERVICE_ROAD_LENGTH) continue;
      costs[nextIndex] = nextCost;
      previous[nextIndex] = current.index;
      queue.push({ index: nextIndex, cost: nextCost });
    }
  }
  if (goalIndex === undefined) return undefined;

  const points: SpatialPoint2[] = [roadAnchors.get(goalIndex) as SpatialPoint2];
  let cursor = goalIndex;
  while (cursor !== startIndex) {
    points.push(terrainCellCenter(terrain, cursor));
    cursor = previous[cursor];
    if (cursor < 0) return undefined;
  }
  const frontageOffset = Math.max(asset.size.x, asset.size.z) * 0.5 + 12;
  while (points.length > 1) {
    const finalPoint = points[points.length - 1];
    if (Math.hypot(finalPoint.x - facilityPoint.x, finalPoint.z - facilityPoint.z) >= frontageOffset) break;
    points.pop();
  }
  const approach = points.at(-1);
  if (!approach) return undefined;
  const approachDistance = Math.hypot(approach.x - facilityPoint.x, approach.z - facilityPoint.z);
  if (approachDistance === 0) return undefined;
  points.push({
    x: facilityPoint.x + ((approach.x - facilityPoint.x) / approachDistance) * frontageOffset,
    z: facilityPoint.z + ((approach.z - facilityPoint.z) / approachDistance) * frontageOffset,
  });

  const simplified: SpatialPoint2[] = [points[0]];
  let fromIndex = 0;
  while (fromIndex < points.length - 1) {
    let toIndex = points.length - 1;
    while (toIndex > fromIndex + 1) {
      const segment: PlannedRoadSegment = {
        id: `${kind}-service-road-check`,
        role: "side",
        start: points[fromIndex],
        end: points[toIndex],
      };
      if (serviceRoadIssue(segment, model, detail, maximumGradePercent) === null) break;
      toIndex--;
    }
    simplified.push(points[toIndex]);
    fromIndex = toIndex;
  }
  const segments = simplified.slice(0, -1).map((start, index) => ({
    id: `${kind}-service-road-${index + 1}`,
    role: "side" as const,
    start,
    end: simplified[index + 1],
  }));
  const length = segments.reduce((total, segment) => total + serviceRoadLength(segment), 0);
  if (
    length > MAX_UTILITY_SERVICE_ROAD_LENGTH ||
    segments.some((segment) => serviceRoadIssue(segment, model, detail, maximumGradePercent) !== null) ||
    !serviceRoadTopologyIsBuildable(segments)
  ) {
    return undefined;
  }
  return { segments, length, gradeLimit: maximumGradePercent };
}

function facility(
  kind: PlannedUtilityFacility["kind"],
  asset: SpatialBootstrapAsset,
  sample: GridSample,
  utilityNetworkPoint: SpatialPoint2,
  roadNetworkPoint: SpatialPoint2,
  connectionPrefab: PlannedUtilityFacility["connection"]["prefab"],
  expectedCapacity: number,
  evidence: Record<string, number | string>,
  rotationCandidates = [0, 90, 180, 270],
  plannedServiceRoads?: PlannedRoadSegment[],
): PlannedUtilityFacility {
  // Keep the service-road endpoint outside the native building footprint. The game
  // rejects roads that merely touch the footprint even when the planner's nominal
  // frontage offset is satisfied; retain a small deterministic clearance margin.
  const directServiceRoad = serviceRoadFor(kind, asset, sample.point, roadNetworkPoint, rotationCandidates[0] ?? 0);
  return {
    kind,
    prefab: asset.prefab,
    position: sample.point,
    rotationCandidates,
    constructionCost: asset.constructionCost,
    expectedCapacity,
    siteEvidence: evidence,
    connection: { prefab: connectionPrefab, start: sample.point, end: utilityNetworkPoint },
    serviceRoads: plannedServiceRoads ?? (directServiceRoad ? [directServiceRoad] : undefined),
  };
}

function waterFacilityCandidates(input: {
  assets: SpatialBootstrapAsset[];
  groundWaterSites: Array<{ sample: GridSample; utility: { point: SpatialPoint2; distance: number }; road: { point: SpatialPoint2; distance: number } }>;
}): PlannedUtilityFacility[] {
  return waterFacilityCandidateSet(input).candidates;
}

function waterFacilityCandidateSet(input: {
  assets: SpatialBootstrapAsset[];
  groundWaterSites: Array<{ sample: GridSample; utility: { point: SpatialPoint2; distance: number }; road: { point: SpatialPoint2; distance: number } }>;
}): { candidates: PlannedUtilityFacility[]; eligibleGroundwaterAssetCount: number; placementInputCandidateCount: number } {
  const groundAssets = input.assets
    .filter((asset) => !asset.locked && asset.capabilities.freshWaterCapacity > 0 &&
      ((asset.capabilities.allowedWaterTypes?.toLowerCase() ?? "").includes("ground") || asset.capabilities.groundWaterMaximum > 0))
    .sort((a, b) => a.constructionCost - b.constructionCost || a.prefab.localeCompare(b.prefab));
  const rankedByAsset: PlannedUtilityFacility[][] = [];
  let placementInputCandidateCount = 0;
  // Asset order and site order are the planner's existing ranking: cheapest
  // eligible facility first, then the existing groundwater/distance score.
  for (const asset of groundAssets) {
    const frontage = Math.max(asset.size.x, asset.size.z) * 0.5 + 8;
    const assetCandidates: PlannedUtilityFacility[] = [];
    for (const site of input.groundWaterSites) {
      if (site.utility.distance < frontage + 12) continue;
      assetCandidates.push(facility("water", asset, site.sample, site.utility.point, site.road.point, "Small Water Pipe",
        asset.capabilities.freshWaterCapacity,
        { source: "groundwater", groundWater: site.sample.groundWater, groundWaterPollution: site.sample.groundWaterPollution,
          roadDistance: site.road.distance, connectionDistance: site.utility.distance }, [0, 90, 180, 270]));
      placementInputCandidateCount += 1;
    }
    if (assetCandidates.length > 0) rankedByAsset.push(assetCandidates);
  }
  // Reserve one highest-ranked site for each eligible facility class before
  // spending the rest of the bounded pool on site alternatives. This prevents
  // one prefab's many sites from starving every alternative facility candidate.
  const candidates = rankedByAsset.slice(0, MAX_WATER_PLANNING_CANDIDATES).map((items) => items[0]);
  const reserved = new Set(candidates);
  for (const items of rankedByAsset) {
    for (const candidate of items) {
      if (candidates.length >= MAX_WATER_PLANNING_CANDIDATES) break;
      if (!reserved.has(candidate)) candidates.push(candidate);
    }
  }
  return { candidates: candidates.sort((a, b) => a.constructionCost - b.constructionCost || a.prefab.localeCompare(b.prefab) ||
    Number(b.siteEvidence.groundWater) - Number(a.siteEvidence.groundWater) ||
    Number(a.siteEvidence.connectionDistance) - Number(b.siteEvidence.connectionDistance)),
  eligibleGroundwaterAssetCount: groundAssets.length, placementInputCandidateCount };
}

export interface WaterConstructionPreflightResult {
  supported: boolean;
  reason?: string;
}

export interface SupportedWaterPlanResult {
  facility: PlannedUtilityFacility;
  candidateCount: number;
  supportedCandidateCount: number;
  selectedRank: number;
}

/** Stage A uses the ordinary bounded Water ranking and only the existing
 * read-only facility placement preview. Downstream primitives are evaluated
 * after an authoritative facility entity exists. */
export async function selectStageAWaterPlan(input: {
  model: SpatialWorldModel;
  selectedSite: BootstrapSiteEvaluation;
  areaDetail: SpatialSiteDetail;
  assets: SpatialBootstrapAsset[];
  options?: { networkSource?: "PLANNED_STARTER_ROADS" | "EXISTING_PLAYER_ROADS_ONLY"; siteEnvelope?: { center: SpatialPoint2; radius: number };
    excludedSiteAreas?: Array<{ center: SpatialPoint2; radius: number }> };
  preflight(candidate: PlannedUtilityFacility): Promise<{ valid: boolean; previewOnly: boolean; reason?: string }>;
}): Promise<{ facility: PlannedUtilityFacility; candidateCount: number; validCandidateCount: number; selectedRank: number; funnel: WaterStageAFunnel }> {
  const base = waterPlanningInputs(input.model, input.selectedSite, input.areaDetail, input.options);
  const candidateSet = waterFacilityCandidateSet({ assets: input.assets, groundWaterSites: base.groundWaterSites });
  const candidates = candidateSet.candidates;
  const funnel: WaterStageAFunnel = {
    ...base.funnel,
    eligibleGroundwaterAssetCount: candidateSet.eligibleGroundwaterAssetCount,
    placementInputCandidateCount: candidateSet.placementInputCandidateCount,
    finalStageACandidateCount: candidates.length,
    firstZeroingFilter: firstZeroingFilter({
      raw: base.funnel.rawTerrainSampleCount, scope: base.funnel.inCurrentScopeCount,
      land: base.funnel.ownedDryBuildableCount, groundwater: base.funnel.groundwaterEligibleCount,
      reach: base.funnel.withinExistingRoadReachCount, assets: candidateSet.eligibleGroundwaterAssetCount,
      placement: candidateSet.placementInputCandidateCount, final: candidates.length,
    }),
  };
  const valid: PlannedUtilityFacility[] = [];
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const preview = await input.preflight(candidate);
    if (preview.valid && preview.previewOnly) valid.push(candidate);
    else reasons.push(preview.reason ?? "FACILITY_PREFLIGHT_REJECTED");
  }
  if (valid.length === 0) throw new NoSupportedWaterTopologyError(candidates.length, 0, reasons.slice(0, MAX_WATER_PLANNING_CANDIDATES), funnel);
  const facility = valid[0];
  return { facility, candidateCount: candidates.length, validCandidateCount: valid.length,
    selectedRank: candidates.indexOf(facility) + 1, funnel };
}

/**
 * Re-ranks the existing bounded Water candidate list through the existing
 * read-only construction preflight. Preflight is only a feasibility filter;
 * the first supported item retains the planner's original deterministic rank.
 */
export async function selectSupportedWaterPlan(input: {
  model: SpatialWorldModel;
  selectedSite: BootstrapSiteEvaluation;
  areaDetail: SpatialSiteDetail;
  assets: SpatialBootstrapAsset[];
  options?: { networkSource?: "PLANNED_STARTER_ROADS" | "EXISTING_PLAYER_ROADS_ONLY"; siteEnvelope?: { center: SpatialPoint2; radius: number };
    excludedSiteAreas?: Array<{ center: SpatialPoint2; radius: number }> };
  preflight(candidate: PlannedUtilityFacility): Promise<WaterConstructionPreflightResult>;
}): Promise<SupportedWaterPlanResult> {
  const base = waterPlanningInputs(input.model, input.selectedSite, input.areaDetail, input.options);
  const candidates = waterFacilityCandidates({ assets: input.assets, groundWaterSites: base.groundWaterSites });
  const supported: PlannedUtilityFacility[] = [];
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const result = await input.preflight(candidate);
    if (result.supported) supported.push(candidate);
    else reasons.push(result.reason ?? "CONSTRUCTION_PREFLIGHT_REJECTED");
    // Three whole plans is enough to choose between, and each one costs native
    // calls that a fourth would not change the answer to. Stopping here keeps
    // the candidate pool wide and the *proposal* count bounded, which is the
    // split the contract asks for.
    if (supported.length >= MAX_COMPLETE_UTILITY_PROPOSALS) break;
  }
  if (supported.length === 0) throw new NoSupportedWaterTopologyError(candidates.length, 0, reasons.slice(0, MAX_WATER_PLANNING_CANDIDATES));
  const facility = supported[0];
  return { facility, candidateCount: candidates.length, supportedCandidateCount: supported.length, selectedRank: candidates.indexOf(facility) + 1 };
}

function waterPlanningInputs(model: SpatialWorldModel, selectedSite: BootstrapSiteEvaluation, areaDetail: SpatialSiteDetail, options?: {
  networkSource?: "PLANNED_STARTER_ROADS" | "EXISTING_PLAYER_ROADS_ONLY";
  siteEnvelope?: { center: SpatialPoint2; radius: number };
  excludedSiteAreas?: Array<{ center: SpatialPoint2; radius: number }>;
}) {
  const samples = gridSamples(areaDetail.terrain);
  const envelope = options?.siteEnvelope;
  const withinEnvelope = (sample: GridSample) => envelope === undefined ||
    Math.hypot(sample.point.x - envelope.center.x, sample.point.z - envelope.center.z) <= envelope.radius;
  const outsideExcludedSites = (sample: GridSample) => (options?.excludedSiteAreas ?? []).every((area) =>
    Math.hypot(sample.point.x - area.center.x, sample.point.z - area.center.z) > area.radius);
  const roads = options?.networkSource === "EXISTING_PLAYER_ROADS_ONLY"
    ? areaDetail.roadGraph.edges.filter(isPermanentPlacedRoad)
    : areaDetail.roadGraph.edges;
  const plannedRoads = options?.networkSource === "EXISTING_PLAYER_ROADS_ONLY" ? [] : selectedSite.layout.segments;
  const nearest = (point: SpatialPoint2) => nearestNetworkPoint(point, plannedRoads, roads);
  const inScope = samples.filter(withinEnvelope);
  const ownedDryBuildable = inScope.filter((sample) => onOwnedDryBuildableLand(sample, model) && outsideExcludedSites(sample));
  const groundwaterEligible = ownedDryBuildable.filter((sample) => sample.groundWater > 0 && sample.groundWaterPollution === 0);
  const withinExistingRoadReach = groundwaterEligible
    .map((sample) => ({ sample, utility: nearest(sample.point), road: nearest(sample.point) }))
    .filter((candidate) => candidate.utility.distance <= 320)
    .sort((a, b) => b.sample.groundWater - a.sample.groundWater || a.utility.distance - b.utility.distance);
  return { groundWaterSites: withinExistingRoadReach, funnel: {
    rawTerrainSampleCount: samples.length,
    inCurrentScopeCount: inScope.length,
    ownedDryBuildableCount: ownedDryBuildable.length,
    groundwaterEligibleCount: groundwaterEligible.length,
    withinExistingRoadReachCount: withinExistingRoadReach.length,
  } };
}

function firstZeroingFilter(counts: { raw: number; scope: number; land: number; groundwater: number; reach: number; assets: number; placement: number; final: number }): string | null {
  if (counts.raw > 0 && counts.scope === 0) return "CURRENT_SCOPE_ENVELOPE";
  if (counts.scope > 0 && counts.land === 0) return "OWNED_DRY_BUILDABLE_LAND";
  if (counts.land > 0 && counts.groundwater === 0) return "GROUNDWATER_SUITABILITY";
  if (counts.groundwater > 0 && counts.reach === 0) return "EXISTING_ROAD_REACH_320M";
  if (counts.reach > 0 && counts.assets === 0) return "ELIGIBLE_GROUNDWATER_FACILITY_ASSET";
  if (counts.assets > 0 && counts.placement === 0) return "MINIMUM_FACILITY_FRONTAGE_FROM_NETWORK";
  if (counts.placement > 0 && counts.final === 0) return "BOUNDED_STAGE_A_ENUMERATION";
  return null;
}

export function planBootstrapUtilities(
  model: SpatialWorldModel,
  selectedSite: BootstrapSiteEvaluation,
  areaDetail: SpatialSiteDetail,
  assets: SpatialBootstrapAsset[],
  options: {
    networkSource?: "PLANNED_STARTER_ROADS" | "EXISTING_PLAYER_ROADS_ONLY";
    utilityKind?: "power" | "water" | "sewage";
    /**
     * Reservation every site this planning scope proposes must lie inside.
     *
     * Placement is confined to the admitted reservation, so a site outside it can
     * only ever be refused by the placement admission. The terrain read is a
     * square, though, so its corner samples sit up to sqrt(2)*radius from the
     * centre — inside the read, outside a circular reservation. Without this
     * bound the planner ranks those corners by their own evidence (groundwater,
     * wind) and proposes a facility that admission must reject.
     *
     * Absent means unbounded, exactly as the planner behaved before this option.
     */
    siteEnvelope?: { center: SpatialPoint2; radius: number };
    /** Previously failed utility service-road terminal sites in this durable branch. */
    excludedSiteAreas?: Array<{ center: SpatialPoint2; radius: number }>;
    /**
     * The authoritative observations a sewage outfall's recipe applicability is
     * judged against: the game's own surface-water flow/pollution grid, and the
     * world's water-intake census.
     *
     * Supplied, the sewage branch stops ranking on site legality alone. A site
     * is only a *complete proposal* once the environmental criterion has been
     * evaluated against these observations and passed, and the evidence rides on
     * the facility so the claim can be re-read rather than trusted. The raw
     * candidate list stays as wide as ever, because a candidate is not a
     * proposal; the cap is on complete proposals, exactly as the contract says.
     *
     * Omitted, the branch behaves as it always has and produces uncertified
     * plans — which the durable admission then refuses for sewage. Nothing is
     * certified by default.
     */
    sewageEnvironmentalSafety?: {
      observation: WaterFlowObservation;
      intakeCensus: SewageIntakeCensus;
    };
  } = {},
): BootstrapUtilityPlan {
  if (!selectedSite.valid) throw new Error("cannot plan utilities for an invalid bootstrap site");
  const envelope = options.siteEnvelope;
  const samples = gridSamples(areaDetail.terrain);
  // `samples` stays dense: its index is the grid coordinate that the shoreline
  // diagnostics address neighbours by. Only the derived site lists are bounded.
  const withinEnvelope = (sample: GridSample) =>
    envelope === undefined ||
    Math.hypot(sample.point.x - envelope.center.x, sample.point.z - envelope.center.z) <= envelope.radius;
  const outsideExcludedSites = (sample: GridSample) =>
    (options.excludedSiteAreas ?? []).every((area) =>
      Math.hypot(sample.point.x - area.center.x, sample.point.z - area.center.z) > area.radius);
  const existingRoads = options.networkSource === "EXISTING_PLAYER_ROADS_ONLY"
    ? areaDetail.roadGraph.edges.filter(isPermanentPlacedRoad)
    : areaDetail.roadGraph.edges;
  const roadAuthorityDiagnostics = options.networkSource === "EXISTING_PLAYER_ROADS_ONLY" ? {
    roadCountBoundedDetail: areaDetail.roadGraph.edges.length,
    roadCountAfterAuthorityFilter: existingRoads.length,
    roadCountVisibleToPlanner: existingRoads.length,
    roadCountVisibleToCandidateBuilder: existingRoads.length,
  } : undefined;
  if (options.networkSource === "EXISTING_PLAYER_ROADS_ONLY" && existingRoads.length === 0) {
    throw new UtilityPlanningError(roadAuthorityDiagnostics as Record<string, number>);
  }
  const plannedRoads = options.networkSource === "EXISTING_PLAYER_ROADS_ONLY" ? [] : selectedSite.layout.segments;
  const utilityConnection = (point: SpatialPoint2) => nearestNetworkPoint(point, plannedRoads, existingRoads);
  const roadAccess = (point: SpatialPoint2) => nearestNetworkPoint(point, plannedRoads, existingRoads);
  const landSamples = samples.filter((sample) =>
    onOwnedDryBuildableLand(sample, model) && withinEnvelope(sample) && outsideExcludedSites(sample));
  if (landSamples.length === 0) throw new Error("no dry, owned, low-slope utility sites found");

  let powerFacility: PlannedUtilityFacility | null = null;
  if (!options.utilityKind || options.utilityKind === "power") {
    const powerAsset = selectCheapest(
      assets,
      (asset) => asset.capabilities.electricityProduction > 0 || asset.capabilities.windProduction > 0,
      "electricity producer",
    );
    const powerFrontage = Math.max(powerAsset.size.x, powerAsset.size.z) * 0.5 + 8;
    const powerSites = rankUtilitySiteCandidates(landSamples
      .map((sample) => ({ sample, utility: utilityConnection(sample.point), road: roadAccess(sample.point) }))
      .filter((candidate) => candidate.utility.distance >= powerFrontage + 12 && candidate.utility.distance <= 160)
      .map((candidate) => ({ ...candidate, siteEvidence: { windSpeed: candidate.sample.windSpeed,
        roadDistance: candidate.road.distance, connectionDistance: candidate.utility.distance } })));
    const powerCandidates = powerSites.map((powerSite) => facility(
      "power", powerAsset, powerSite.sample, powerSite.utility.point, powerSite.road.point,
      "Low-voltage Ground Cable", Math.max(powerAsset.capabilities.electricityProduction, powerAsset.capabilities.windProduction),
      { ...powerSite.siteEvidence },
    ));
    powerFacility = powerCandidates[0] ?? null;
    if (!powerFacility) throw new Error("no power site within 160m of the road network");
    if (options.utilityKind === "power") return { facilities: [powerFacility], candidateFacilities: powerCandidates,
      totalFacilityCost: powerFacility.constructionCost, roadAuthorityDiagnostics };
  }

  const groundWaterInEnvelope = landSamples.filter((sample) => sample.groundWater > 0 && sample.groundWaterPollution === 0);
  const groundWaterSites = groundWaterInEnvelope
    .map((sample) => ({ sample, utility: utilityConnection(sample.point), road: roadAccess(sample.point) }))
    .filter((candidate) => candidate.utility.distance <= 320)
    .sort((a, b) => b.sample.groundWater - a.sample.groundWater || a.utility.distance - b.utility.distance);

  if (options.utilityKind === "water") {
    const groundAssets = assets
      .filter((asset) => !asset.locked && asset.capabilities.freshWaterCapacity > 0 &&
        ((asset.capabilities.allowedWaterTypes?.toLowerCase() ?? "").includes("ground") || asset.capabilities.groundWaterMaximum > 0))
      .sort((a, b) => a.constructionCost - b.constructionCost || a.prefab.localeCompare(b.prefab));
    const waterCandidates = waterFacilityCandidates({ assets: groundAssets, groundWaterSites });
    const planned = waterCandidates[0];
    if (planned) return { facilities: [planned], totalFacilityCost: planned.constructionCost, roadAuthorityDiagnostics };
    // A water request that cannot be sited must say so here. Falling through would
    // hand the caller a sewage plan for a water kind — the caller only catches that
    // downstream — and would lose the one fact that matters: no groundwater source
    // exists inside the envelope placement is confined to.
    const nearestAnywhere = envelope === undefined
      ? undefined
      : samples
          .filter((sample) => sample.groundWater > 0 && sample.groundWaterPollution === 0)
          .map((sample) => ({ sample, distance: Math.hypot(sample.point.x - envelope.center.x, sample.point.z - envelope.center.z) }))
          .sort((a, b) => a.distance - b.distance)[0];
    throw new Error(
      `no groundwater water site is available for placement ` +
        `(land=${landSamples.length}, groundWaterInEnvelope=${groundWaterInEnvelope.length}, ` +
        `withinRoadReach=${groundWaterSites.length}, assets=${groundAssets.length}` +
        (envelope === undefined
          ? ")"
          : `, envelopeRadius=${envelope.radius}, ` +
            `nearestGroundWaterAnywhere=${nearestAnywhere ? `${nearestAnywhere.distance.toFixed(1)}m` : "none"})`),
    );
  }

  const sewageAsset = selectCheapest(assets, (asset) => asset.capabilities.sewageCapacity > 0, "sewage outlet");
  const { resolution } = areaDetail.terrain;
  const shorelineLandSamples = samples.filter(
    (sample) =>
      withinEnvelope(sample) &&
      outsideExcludedSites(sample) &&
      sample.waterDepth <= 0.05 &&
      sample.localGradePercent <= MAX_SHORELINE_FACILITY_GRADE_PERCENT &&
      model.ownedTiles.some((tile) => pointInTile(sample.point, tile)),
  );
  const shorelineCandidates = shorelineLandSamples
    .map((sample) => {
      const col = sample.index % resolution;
      const row = Math.floor(sample.index / resolution);
      const neighbors = [
        col > 0 ? sample.index - 1 : -1,
        col + 1 < resolution ? sample.index + 1 : -1,
        row > 0 ? sample.index - resolution : -1,
        row + 1 < resolution ? sample.index + resolution : -1,
      ].filter((index) => index >= 0 && (areaDetail.terrain.waterDepths[index] ?? 0) > 0.5);
      if (neighbors.length === 0) return null;
      const waterIndex = neighbors[0];
      const waterCol = waterIndex % resolution;
      const waterRow = Math.floor(waterIndex / resolution);
      const waterPoint = {
        x: areaDetail.terrain.bounds.minX + (waterCol + 0.5) * areaDetail.terrain.cellSize.x,
        z: areaDetail.terrain.bounds.minZ + (waterRow + 0.5) * areaDetail.terrain.cellSize.z,
      };
      return {
        sample,
        waterPoint,
        utility: utilityConnection(sample.point),
        road: roadAccess(sample.point),
        serviceRoad: undefined as ServiceRoadPath | undefined,
        serviceRoadLength: 0,
        serviceRoadIssue: null as ServiceRoadIssue | "no_path" | null,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .map((candidate) => {
      const directServiceRoad = serviceRoadFor("sewage", sewageAsset, candidate.sample.point, candidate.road.point);
      const directIssue = serviceRoadIssue(directServiceRoad, model, areaDetail);
      let serviceRoad: ServiceRoadPath | undefined;
      for (const gradeLimit of SERVICE_ROAD_GRADE_LIMITS) {
        if (serviceRoadIssue(directServiceRoad, model, areaDetail, gradeLimit) === null) {
          serviceRoad = {
            segments: directServiceRoad ? [directServiceRoad] : [],
            length: serviceRoadLength(directServiceRoad),
            gradeLimit,
          };
        } else {
          serviceRoad = serviceRoadPath(
            "sewage",
            sewageAsset,
            candidate.sample.point,
            plannedRoads,
            existingRoads,
            model,
            areaDetail,
            gradeLimit,
          );
        }
        if (serviceRoad) break;
      }
      return {
        ...candidate,
        serviceRoad,
        serviceRoadLength: serviceRoad?.length ?? Number.POSITIVE_INFINITY,
        serviceRoadIssue: serviceRoad ? null : (directIssue ?? "no_path"),
      };
    });
  const shorelineSites = shorelineCandidates
    .filter(
      (candidate) =>
        candidate.utility.distance <= 2048 &&
        candidate.serviceRoadLength <= MAX_UTILITY_SERVICE_ROAD_LENGTH &&
        candidate.serviceRoadIssue === null &&
        candidate.serviceRoad !== undefined && candidate.serviceRoad.segments.length > 0,
    )
    .sort(
      (a, b) =>
        (a.serviceRoad?.gradeLimit ?? Number.POSITIVE_INFINITY) -
          (b.serviceRoad?.gradeLimit ?? Number.POSITIVE_INFINITY) ||
        a.sample.localGradePercent - b.sample.localGradePercent ||
        a.serviceRoadLength - b.serviceRoadLength ||
        a.utility.distance - b.utility.distance ||
        a.sample.index - b.sample.index,
    );
  type SewageSiteCandidate = (typeof shorelineSites)[number];
  // The raw pool is every legal shoreline site; a *complete* proposal is one of
  // those whose discharge the environmental criterion could actually certify.
  // The pool stays wide because a candidate is cheap and a legal shoreline is
  // scarce; the proposals are capped because each one is a whole plan and the
  // planner acts on the first.
  const certifiedSites: Array<{ site: SewageSiteCandidate; certification: SewageEnvironmentalEvidence }> = [];
  const certificationRefusals: string[] = [];
  if (options.sewageEnvironmentalSafety) {
    for (const site of shorelineSites) {
      if (certifiedSites.length >= MAX_COMPLETE_UTILITY_PROPOSALS) break;
      const verdict = certifySewageOutfallEnvironmentalSafety({
        outfall: site.sample.point,
        observation: options.sewageEnvironmentalSafety.observation,
        intakeCensus: options.sewageEnvironmentalSafety.intakeCensus,
      });
      if (verdict.certified) certifiedSites.push({ site, certification: verdict.evidence });
      else certificationRefusals.push(verdict.reason);
    }
  }
  const sewageSite: SewageSiteCandidate | undefined = certifiedSites[0]?.site ?? shorelineSites[0];
  const sewageSiteEvidence = certifiedSites[0]?.certification;
  if (!sewageSite) {
    const rawShoreline = samples.filter((sample) => {
      const col = sample.index % resolution;
      const row = Math.floor(sample.index / resolution);
      const neighbors = [
        col > 0 ? sample.index - 1 : -1,
        col + 1 < resolution ? sample.index + 1 : -1,
        row > 0 ? sample.index - resolution : -1,
        row + 1 < resolution ? sample.index + resolution : -1,
      ];
      return sample.waterDepth <= 0.05 && neighbors.some((index) => index >= 0 && samples[index].waterDepth > 0.5);
    });
    const ownedShoreline = rawShoreline.filter((sample) =>
      model.ownedTiles.some((tile) => pointInTile(sample.point, tile)),
    );
    const minimumOwnedShoreGrade = ownedShoreline.reduce(
      (minimum, sample) => Math.min(minimum, sample.localGradePercent),
      Number.POSITIVE_INFINITY,
    );
    const closestRoad = shorelineCandidates.reduce(
      (minimum, candidate) => Math.min(minimum, candidate.road.distance),
      Number.POSITIVE_INFINITY,
    );
    const withinServiceRoadLimit = shorelineCandidates.filter(
      (candidate) => candidate.serviceRoadLength <= MAX_UTILITY_SERVICE_ROAD_LENGTH,
    ).length;
    const issueCounts = shorelineCandidates.reduce<Record<string, number>>((counts, candidate) => {
      const issue = candidate.serviceRoadIssue ?? "none";
      counts[issue] = (counts[issue] ?? 0) + 1;
      return counts;
    }, {});
    throw new Error(
      `no low-slope shoreline sewage site has a legal service road ` +
        `(land=${landSamples.length}, rawShore=${rawShoreline.length}, ownedShore=${ownedShoreline.length}, ` +
        `minOwnedGrade=${Number.isFinite(minimumOwnedShoreGrade) ? minimumOwnedShoreGrade.toFixed(1) : "n/a"}%, ` +
        `ownedGrade8=${ownedShoreline.filter((sample) => sample.localGradePercent <= 8).length}, ` +
        `shoreline=${shorelineCandidates.length}, ` +
        `closestRoad=${Number.isFinite(closestRoad) ? closestRoad.toFixed(1) : "n/a"}m, ` +
        `within${MAX_UTILITY_SERVICE_ROAD_LENGTH}m=${withinServiceRoadLimit}, ` +
        `serviceRoadIssues=${JSON.stringify(issueCounts)})`,
    );
  }
  // Legal shoreline sites exist, but none is a *complete* proposal: the recipe's
  // environmental criterion refused every one. This is a different fact from the
  // refusal above — there, no shoreline could carry a service road at all; here,
  // the road is legal and the discharge is what could not be judged — so it is
  // reported separately and never falls back to an uncertified site.
  if (options.sewageEnvironmentalSafety && certifiedSites.length === 0) {
    throw new Error(
      `no shoreline sewage site satisfies the certified recipe ` +
        `(legalShorelineSites=${shorelineSites.length}, certified=0, ` +
        `refusals=${JSON.stringify(certificationRefusals.slice(0, MAX_WATER_PLANNING_CANDIDATES))})`,
    );
  }
  const waterPlans: Array<{
    asset: SpatialBootstrapAsset;
    sample: GridSample;
    utility: { point: SpatialPoint2; distance: number };
    road: { point: SpatialPoint2; distance: number };
    rotationCandidates: number[];
    evidence: Record<string, number | string>;
  }> = [];
  for (const asset of assets.filter((item) => !item.locked && item.capabilities.freshWaterCapacity > 0)) {
    const sourceType = asset.capabilities.allowedWaterTypes?.toLowerCase() ?? "";
    if (sourceType.includes("ground") || asset.capabilities.groundWaterMaximum > 0) {
      const frontage = Math.max(asset.size.x, asset.size.z) * 0.5 + 8;
      const groundWaterSite = groundWaterSites.find((candidate) => candidate.utility.distance >= frontage + 12);
      if (!groundWaterSite) continue;
      waterPlans.push({
        asset,
        sample: groundWaterSite.sample,
        utility: groundWaterSite.utility,
        road: groundWaterSite.road,
        rotationCandidates: [0, 90, 180, 270],
        evidence: {
          source: "groundwater",
          groundWater: groundWaterSite.sample.groundWater,
          groundWaterPollution: groundWaterSite.sample.groundWaterPollution,
          roadDistance: groundWaterSite.road.distance,
          connectionDistance: groundWaterSite.utility.distance,
        },
      });
    } else if (sourceType.includes("surface") && shorelineSites[0]) {
      const site = shorelineSites[0];
      const rotation = rotationToward(site.sample.point, site.waterPoint);
      waterPlans.push({
        asset,
        sample: site.sample,
        utility: site.utility,
        road: site.road,
        rotationCandidates: [rotation, (rotation + 90) % 360, (rotation + 180) % 360, (rotation + 270) % 360],
        evidence: {
          source: "surface_water",
          shorelineDistance: 0,
          roadDistance: site.road.distance,
          connectionDistance: site.utility.distance,
        },
      });
    } else if (sourceType === "none" && asset.capabilities.groundWaterMaximum === 0) {
      const frontage = Math.max(asset.size.x, asset.size.z) * 0.5 + 8;
      const site = landSamples
        .map((sample) => ({ sample, utility: utilityConnection(sample.point), road: roadAccess(sample.point) }))
        .filter((candidate) => candidate.utility.distance >= frontage + 12 && candidate.utility.distance <= 160)
        .sort((a, b) => a.utility.distance - b.utility.distance)[0];
      if (site) {
        waterPlans.push({
          asset,
          sample: site.sample,
          utility: site.utility,
          road: site.road,
          rotationCandidates: [0, 90, 180, 270],
          evidence: {
            source: "unconstrained",
            roadDistance: site.road.distance,
            connectionDistance: site.utility.distance,
          },
        });
      }
    }
  }
  waterPlans.sort(
    (a, b) => a.asset.constructionCost + a.utility.distance * 20 - (b.asset.constructionCost + b.utility.distance * 20),
  );
  const waterPlan = waterPlans[0];
  if (!options.utilityKind && !waterPlan) throw new Error("no valid unlocked water-source plan was found");

  const waterFacility = waterPlan ? facility(
    "water", waterPlan.asset, waterPlan.sample, waterPlan.utility.point, waterPlan.road.point,
    "Small Water Pipe", waterPlan.asset.capabilities.freshWaterCapacity, waterPlan.evidence, waterPlan.rotationCandidates,
  ) : null;

  const sewageFacilityFor = (
    site: SewageSiteCandidate,
    certification: SewageEnvironmentalEvidence | undefined,
  ): PlannedUtilityFacility => {
    const rotation = rotationToward(site.sample.point, site.waterPoint);
    const built = facility(
      "sewage",
      sewageAsset,
      site.sample,
      site.utility.point,
      site.road.point,
      "Small Sewage Pipe",
      sewageAsset.capabilities.sewageCapacity,
      {
        shorelineDistance: 0,
        roadDistance: site.road.distance,
        serviceRoadLength: site.serviceRoadLength,
        serviceRoadLimit: MAX_UTILITY_SERVICE_ROAD_LENGTH,
        serviceRoadGradeLimit: site.serviceRoad.gradeLimit,
        connectionDistance: site.utility.distance,
      },
      [
        rotation,
        (rotation + 90) % 360,
        (rotation + 180) % 360,
        (rotation + 270) % 360,
      ],
      site.serviceRoad.segments,
    );
    // Only a site the criterion actually judged carries the evidence. An
    // uncertified plan is left without it, so the durable admission can refuse
    // it rather than read a placement verdict as a recipe certification.
    return certification === undefined ? built : { ...built, environmentalCertification: certification };
  };
  const sewageFacility = sewageFacilityFor(sewageSite, sewageSiteEvidence);
  const sewageProposals = certifiedSites.map((entry) => sewageFacilityFor(entry.site, entry.certification));
  const facilities = [
    ...(powerFacility ? [powerFacility] : []),
    ...(waterFacility ? [waterFacility] : []),
    sewageFacility,
  ];
  return {
    facilities,
    // The certified proposals, widest-first on the planner's existing ranking.
    // Present only when the criterion ran; an uncertified run has no proposals
    // to offer, which is a different fact from "it offered none".
    ...(sewageProposals.length > 0 ? { candidateFacilities: sewageProposals } : {}),
    totalFacilityCost: facilities.reduce((sum, item) => sum + item.constructionCost, 0),
    roadAuthorityDiagnostics,
  };
}
