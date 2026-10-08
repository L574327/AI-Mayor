export interface SpatialEntityRef {
  index: number;
  version: number;
}

export interface SpatialPoint2 {
  x: number;
  z: number;
}

export interface SpatialPoint3 extends SpatialPoint2 {
  y: number;
}

export interface SpatialBounds2 {
  min: SpatialPoint2;
  max: SpatialPoint2;
}

export interface SpatialTile {
  entity: SpatialEntityRef;
  owned: boolean;
  bounds: SpatialBounds2 | null;
  center: SpatialPoint2 | null;
  polygon: SpatialPoint2[];
}

export interface SpatialRoadNode {
  entity: SpatialEntityRef;
  position: SpatialPoint3;
  native: boolean;
  outsideConnection: boolean;
  roadDegree: number;
}

export interface SpatialNativeCurve {
  a: SpatialPoint3;
  b: SpatialPoint3;
  c: SpatialPoint3;
  d: SpatialPoint3;
  length: number;
}

export interface SpatialRoadEdge {
  entity: SpatialEntityRef;
  prefab: string;
  native: boolean;
  /** PlacedRoadQuery lifecycle/ownership metadata; Native is only origin metadata. */
  temp?: boolean;
  deleted?: boolean;
  owner?: SpatialEntityRef | null;
  startNode: SpatialEntityRef;
  endNode: SpatialEntityRef;
  start: SpatialPoint2;
  end: SpatialPoint2;
  length: number;
  nativeCurve?: SpatialNativeCurve;
}

export interface SpatialOutsideConnection {
  entity: SpatialEntityRef;
  position: SpatialPoint3;
  connectedRoadEdges: SpatialEntityRef[];
}

export interface SpatialBootstrapScan {
  world: { min: number; max: number; size: number };
  tiles: SpatialTile[];
  outsideConnections: SpatialOutsideConnection[];
  bootstrapAssets: SpatialBootstrapAsset[];
  roadGraph: {
    nodes: SpatialRoadNode[];
    edges: SpatialRoadEdge[];
    truncated: boolean;
  };
}

export interface SpatialBootstrapAsset {
  prefab: string;
  locked: boolean;
  constructionCost: number;
  lotSize: { x: number; z: number };
  size: SpatialPoint3;
  capabilities: {
    electricityProduction: number;
    windMaximum: number;
    windProduction: number;
    groundWaterProduction: number;
    groundWaterMaximum: number;
    freshWaterCapacity: number;
    allowedWaterTypes: string | null;
    sewageCapacity: number;
    sewagePurification: number;
  };
}

export interface SpatialConnectionCandidate {
  node: SpatialRoadNode;
  reason: "native_terminal_in_owned_area" | "ingress_gateway_in_owned_area";
  incomingEdge?: SpatialEntityRef;
  forward?: SpatialPoint2;
  graphDistanceFromOutside?: number;
  orientationRank?: number;
}

export interface SpatialWorldModel {
  worldBounds: { min: number; max: number; size: number };
  ownedTiles: SpatialTile[];
  roadGraph: SpatialBootstrapScan["roadGraph"];
  outsideConnections: SpatialOutsideConnection[];
  connectionCandidates: SpatialConnectionCandidate[];
}

export interface SpatialScanPort {
  scan(): Promise<unknown>;
}

export interface SpatialLocalTerrain {
  resolution: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  cellSize: SpatialPoint2;
  heights: number[];
  waterDepths: number[];
  groundWater: number[];
  groundWaterPollution: number[];
  windSpeed: number[];
  /** The wind vector per cell (the Bridge exports it since 2026-10-04; absent on an older Bridge): its direction decides what is downwind. */
  windX?: number[];
  windZ?: number[];
}

export interface SpatialBuilding {
  entity: SpatialEntityRef;
  prefab: string;
  native: boolean;
  position: SpatialPoint3;
  rotation: { x: number; y: number; z: number; w: number };
  footprint: {
    size: SpatialPoint3;
    bounds: { min: SpatialPoint3; max: SpatialPoint3 };
  } | null;
}

export interface SpatialZoningCell {
  block: SpatialEntityRef;
  index: number;
  position: SpatialPoint3;
  visible: boolean;
  roadside: boolean;
  roadLeft?: boolean;
  roadRight?: boolean;
  roadBack?: boolean;
  occupied: boolean;
  blocked: boolean;
  overridden: boolean;
  zoneType: number;
  zoneCategory?: "none" | "residential" | "commercial" | "industrial" | "office" | "unknown";
}

export interface SpatialSiteDetail {
  center: SpatialPoint2;
  radius: number;
  terrain: SpatialLocalTerrain;
  roadGraph: { nodes: SpatialRoadNode[]; edges: SpatialRoadEdge[] };
  buildings: SpatialBuilding[];
  zoningCells: SpatialZoningCell[];
}

export interface PlannedRoadSegment {
  id: string;
  role: "main" | "cross" | "side";
  start: SpatialPoint2;
  end: SpatialPoint2;
}

export interface StarterRoadLayout {
  style: "starter_grid";
  entryNode: SpatialEntityRef;
  incomingEdge: SpatialEntityRef;
  forward: SpatialPoint2;
  right: SpatialPoint2;
  segments: PlannedRoadSegment[];
  futureExpansionPoint: SpatialPoint2;
}

export interface BootstrapSiteEvaluation {
  connection: SpatialConnectionCandidate;
  layout: StarterRoadLayout;
  valid: boolean;
  score: number;
  rejectionReasons: string[];
  metrics: {
    sampledPoints: number;
    meanGradePercent: number;
    maxGradePercent: number;
    wetSamples: number;
    outsideOwnedSamples: number;
    buildingConflicts: number;
    usableExistingZoningCells: number;
  };
}

export interface PlannedUtilityConnection {
  prefab: "Low-voltage Ground Cable" | "Small Water Pipe" | "Small Sewage Pipe";
  start: SpatialPoint2;
  end: SpatialPoint2;
}

/** Native UI semantic/tool prefab used for an Electricity direct-cable definition. */
export const ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB = "Low-voltage Ground Cable" as const;

/**
 * The evidence a facility's recipe was applicable to THIS site.
 *
 * A native placement verdict says a facility fits. It says nothing about
 * whether the recipe's own applicability conditions hold where the facility
 * goes. A plan that carries this object is one whose conditions were checked
 * against authoritative observations and passed; a plan without it has only
 * been observed to fit, which for the sewage recipe is not the same claim.
 */
export interface UtilityEnvironmentalCertification {
  recipe: string;
  /** The water body the outfall discharges into, as the game reported it. */
  receivingWater: {
    x: number; z: number; depth: number; pollution: number;
    velocity: { x: number; z: number }; speed: number;
  };
  connectedWaterCells: number;
  downstreamDistance: number;
  downstreamTermination: string;
  downstreamCells: number;
  intakeCount: number;
  intakesInSameWaterBody: number;
  closestIntakeApproach: number | null;
}

export interface PlannedUtilityFacility {
  kind: "power" | "water" | "sewage";
  prefab: string;
  position: SpatialPoint2;
  rotationCandidates: number[];
  constructionCost: number;
  expectedCapacity: number;
  siteEvidence: Record<string, number | string>;
  connection: PlannedUtilityConnection;
  serviceRoads?: PlannedRoadSegment[];
  /**
   * The recipe-applicability evidence for this exact site, when the plan was
   * produced by a recipe that has applicability conditions. Absent means the
   * conditions were never checked — which is not the same as "they hold".
   */
  environmentalCertification?: UtilityEnvironmentalCertification;
  /**
   * Exact, ID-free endpoints for extending an already connected electricity
   * cable to this plan's target. Native IDs are rebound immediately before
   * preview; these descriptors are planner output, not authorization.
   */
  connectionEndpointBindings?: {
    start: {
      mode: "EXISTING_NET_NODE"; role: "START"; utility: "ELECTRICITY"; prefab: string;
      expectedPosition: { x: number; y: number; z: number }; bindingRule: string; topologyRole: string;
      topologyLookup: { networkEdgePrefab: string; edgeGeometry: { x1: number; z1: number; x2: number; z2: number };
        edgeEndpointRole: "START" | "END"; sourceAnchor: { buildingPrefab: string; position: { x: number; y: number; z: number }; connectorUtility: "ELECTRICITY" };
        requireSourceReachability: boolean };
    };
    end: {
      mode: "EXISTING_NET_NODE"; role: "END"; utility: "ELECTRICITY"; prefab: string;
      expectedPosition: { x: number; y: number; z: number }; bindingRule: string; topologyRole: string;
      topologyLookup: { networkEdgePrefab: string; edgeGeometry: { x1: number; z1: number; x2: number; z2: number };
        edgeEndpointRole: "START" | "END"; sourceAnchor: { buildingPrefab: string; position: { x: number; y: number; z: number }; connectorUtility: "ELECTRICITY" };
        requireSourceReachability: boolean };
    };
  };
}

export interface BootstrapUtilityPlan {
  facilities: PlannedUtilityFacility[];
  totalFacilityCost: number;
  /** Bounded ranked alternatives are planning evidence; callers still own placement authority. */
  candidateFacilities?: PlannedUtilityFacility[];
  roadAuthorityDiagnostics?: {
    roadCountBoundedDetail: number;
    roadCountAfterAuthorityFilter: number;
    roadCountVisibleToPlanner: number;
    roadCountVisibleToCandidateBuilder: number;
  };
}
