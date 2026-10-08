import type {
  SpatialBuilding,
  SpatialLocalTerrain,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialRoadNode,
  SpatialTile,
} from "../spatial/types";
import {
  MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
  MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
} from "./road-contract";
import type { RoadGeometryInput } from "./road-kernel";

/**
 * The grid the whole city is laid out on, and the anchor every grid course is
 * measured from.
 *
 * This lives here, not in the bounded corridor resolver, because it is the
 * shared coordinate frame rather than a property of one candidate family:
 * `sharedRoadGridReference` is the single deterministic origin the grid courses,
 * the alignment error and the frontage measure all read.
 */
export interface SharedRoadGridReference {
  origin: SpatialPoint2;
  orientationRadians: number;
  spacingMeters: number;
  sourceEdgeRef: SpatialRoadEdge["entity"];
}

/**
 * The lattice every grid course endpoint has to land on.
 *
 * The cadence is 40/80/120 and their greatest common divisor is 40, so 40 is the
 * only spacing on which every planned course can sit at once: a 120 m course
 * measured from a lattice point lands on another lattice point, and so does a
 * 40. The previous value was 64, which divides none of them — no planned course
 * could ever rest on it, and the measured 落格 offsets were 16-42 m because of
 * exactly that. A rectangular plan also needs the block spacings to be whole
 * multiples of this, so the block corners are lattice points too.
 */
export const GRID_LATTICE_SPACING_METERS = 40;

export const EPSILON = 1e-6;
/** Existing local road siting policy rejects courses steeper than this. */
export const MAX_PLANNING_ROAD_GRADE_PERCENT = 12;

export const finitePoint = (point: SpatialPoint2): boolean => Number.isFinite(point.x) && Number.isFinite(point.z);
export const entityKey = (entity: { index: number; version: number }): string => `${entity.index}:${entity.version}`;
export const distance = (left: SpatialPoint2, right: SpatialPoint2): number =>
  Math.hypot(left.x - right.x, left.z - right.z);

/**
 * Establish one deterministic city grid from the earliest ordinary road in the
 * authoritative graph. Since native entity indices are monotonic, adjacent
 * Goals keep the same reference as construction adds later roads.
 */
export function sharedRoadGridReference(edges: readonly SpatialRoadEdge[]): SharedRoadGridReference | null {
  const seed = [...edges]
    .filter((edge) => !/highway|motorway|expressway|divided|service road|cable|pipe|sewer/i.test(edge.prefab) &&
      finitePoint(edge.start) && finitePoint(edge.end) && distance(edge.start, edge.end) >= 8)
    .sort((left, right) => left.entity.index - right.entity.index || left.entity.version - right.entity.version)[0];
  if (!seed) return null;
  let dx = seed.end.x - seed.start.x;
  let dz = seed.end.z - seed.start.z;
  if (dx < 0 || (Math.abs(dx) <= EPSILON && dz < 0)) { dx *= -1; dz *= -1; }
  return {
    origin: { x: seed.start.x, z: seed.start.z },
    orientationRadians: Math.atan2(dz, dx),
    spacingMeters: GRID_LATTICE_SPACING_METERS,
    sourceEdgeRef: seed.entity,
  };
}

/**
 * The world axes a grid course may run along.
 *
 * The requirement is 横平: streets run on world 0/90 degrees. `sharedRoadGridReference`
 * derives its orientation from the earliest ordinary road, which on a map whose
 * seed road is diagonal is itself diagonal — a grid built on that axis is the
 * skew the grid exists to remove. So the reference supplies the ORIGIN and the
 * SPACING, and the orientation is snapped to the nearest quarter turn: the grid
 * stays a single deterministic frame anchored on the reference while its axes
 * remain the world's.
 */
export function gridAxisRadians(reference: SharedRoadGridReference | null): [number, number] {
  const raw = reference?.orientationRadians ?? 0;
  const quarter = Math.PI / 2;
  const snapped = Math.round(raw / quarter) * quarter;
  return [snapped, snapped + quarter];
}

/**
 * How far a point sits from the grid's own lattice: the nearest point of
 * `origin + (i,j) * spacingMeters` in the world-axis frame.
 *
 * This is the acceptance number for 落格 ("does the endpoint land on a grid
 * point?"). It is measured in the grid's frame rather than against the seed
 * road's bearing, because the courses themselves are snapped to the world axes
 * (`gridAxisRadians`) — only the ORIGIN is inherited from the seed, so the
 * residual is what the caller has to know to say whether a course's endpoints
 * fall on the lattice, and whether the `40/80/120` cadence is commensurate with
 * the `spacingMeters` it is supposed to step along.
 */
export function gridLatticeOffsetMeters(point: SpatialPoint2, reference: SharedRoadGridReference): number {
  const { origin, spacingMeters } = reference;
  if (!(spacingMeters > 0)) return Number.NaN;
  const residual = (value: number, base: number): number => {
    const wrapped = Math.abs(value - base) % spacingMeters;
    return Math.min(wrapped, spacingMeters - wrapped);
  };
  return Math.hypot(residual(point.x, origin.x), residual(point.z, origin.z));
}

export type RoadCandidateVariant = "PRIMARY" | "BOUNDED_FALLBACK" | "COURSE_SWEEP" | "GRID" | "DIRECTED_CORRIDOR";

export interface RoadSourceAnchorEvidence {
  sourceEdgeRef: SpatialRoadEdge["entity"];
  sourceEndpointRole: "start" | "end";
  sourceNodeRef: SpatialRoadNode["entity"];
  sourceNodePosition: SpatialPoint2;
  incidentEdgeRefs: SpatialRoadEdge["entity"][];
  roadDegree: number;
  derivation: "AUTHORITATIVE_GRAPH_NODE";
}

export interface RoadCandidate {
  family: "ORTHOGONAL_GRID" | "FREE_CORRIDOR";
  gridReference: SharedRoadGridReference | null;
  gridAlignmentErrorMeters?: number;
  variant: RoadCandidateVariant;
  sourceEdge: SpatialRoadEdge;
  sourceRole: "start" | "end";
  sourceNode: SpatialRoadNode;
  sourceAnchor: SpatialPoint2;
  siteTarget: SpatialPoint2;
  initialRoadContactTarget: SpatialPoint2;
  roadContactTarget: SpatialPoint2;
  contactDerivation:
    | "RESERVATION_NEAR_BOUNDARY"
    | "RESERVATION_MIN_LENGTH_CONTACT"
    | "RESERVATION_INTERIOR_CONTACT"
    | "RESERVATION_LATERAL_CONTACT"
    | "OUTWARD_TERMINAL_TANGENT"
    | "COURSE_SWEEP_HEADING"
    | "GRID_AXIS_NODE";
  initialSegmentLength: number;
  finalSegmentLength: number;
  lengthContract: {
    minMeters: number;
    maxMeters: number;
    pass: true;
  };
  adjustmentReason: "NONE" | "MIN_LENGTH_CONSTRAINT" | "PRODUCTIVE_CONTACT_INSET" | "LATERAL_OFFSET" | "COURSE_SWEEP";
  incidentEdgeRefs: SpatialRoadEdge["entity"][];
  sourceAnchorEvidence: RoadSourceAnchorEvidence;
  geometryFilterResults: "PASS";
  input: RoadGeometryInput;
}

export interface RoadCandidateResolution {
  candidates: RoadCandidate[];
  rejectedSources: Array<{ edge: SpatialRoadEdge; reason: string }>;
}

/**
 * The block ladder one 集合 is laid out from: two blocks per axis, small then
 * large, drawn from the golden ratio and rounded to whole 40 m lattice steps.
 *
 * WHY THE SIZE IS A CONSTANT AND NOT A PARAMETER. `mixedGridDimensions` takes
 * the ratios from its caller, so the choice has to live somewhere; it lives here
 * because a collection is not free to be any size. Its ground is judged by
 * `filterGridSegmentsByTerrain` against the terrain read the SITE carries, and
 * that read covers `siteObservationRadiusMeters` in every direction — a 192 m
 * square at the product's 96 m. A collection larger than the window it is judged
 * in is not a bigger district: every line that leaves the read comes back
 * `OFF_TERRAIN`, so the plan is refused for a reason that is about the read and
 * not about the ground. 40 + 80 = 120 m on each axis sits inside that window
 * with room for the lattice snap, and gives the two block sizes the product
 * asked for without inventing a per-site size rule.
 */
export const COLLECTION_BLOCKS_PER_AXIS = 2;
export const COLLECTION_GOLDEN_RATIO_LEVELS = 2;
export const COLLECTION_UNIT_STEPS = 1;

/** The 集合 the product lays: mixed block sizes on the world's 40 m lattice. */
export function collectionBlockDimensions(): MixedGridDimensions {
  return mixedGridDimensions({
    columns: COLLECTION_BLOCKS_PER_AXIS,
    rows: COLLECTION_BLOCKS_PER_AXIS,
    ratios: goldenRatioLadder(COLLECTION_GOLDEN_RATIO_LEVELS),
    unitSteps: COLLECTION_UNIT_STEPS,
  });
}

/** Cap on the whole family; the selector previews in order and stops at the first accepted. */
export const MAXIMUM_GRID_ROAD_CANDIDATES = 24;

/**
 * How many existing road nodes may contribute an access course.
 *
 * A district joins the network where one of its own lattice corners is reached
 * from a node the city already has. The nearest node is the product's answer;
 * the second is there because a node whose own courses native refuses would
 * otherwise strand the whole collection, and one bounded alternative is a
 * different entrance rather than a second plan.
 */
export const MAXIMUM_GRID_ACCESS_NODES = 2;

/** A course shorter than the native net contract is not a road at all. */
const MINIMUM_ACCESS_LEG_METERS = 8;

/** How close an endpoint may sit to an existing road before the course is that road. */
const EXISTING_ROAD_CLEARANCE_METERS = 12;

export interface RoadGridInput {
  siteTarget: SpatialPoint2;
  sourceEdges: readonly SpatialRoadEdge[];
  sourceNodes?: readonly SpatialRoadNode[];
  availableRoadPrefabs?: readonly string[];
  ownedTiles: readonly SpatialTile[];
  terrain?: SpatialLocalTerrain;
  buildings?: readonly SpatialBuilding[];
  prefab: string;
  /** Cap on the whole family; the selector previews in order and stops at the first accepted. */
  maxCandidates?: number;
  /** Raw Bridge generation token, echoed into evidence only. */
  worldEpoch?: string;
  /**
   * How far a road node may sit from the site and still be a legal anchor.
   *
   * A site no road reaches has NO route, and the callers tier such a site below
   * every reachable one. Without this bound the grid family seeds from every node
   * in the world, so an unreachable site would still come back "with road
   * candidates" and the tiering would be meaningless.
   */
  maxSourceDistance?: number;
  /**
   * The activated Bridge generation, bound onto both endpoints the way the
   * bounded corridor family binds it. A durable road command carries this epoch
   * so a restart can tell whether the node the course left is still the node it
   * observed; dropping it silently would drop that check.
   */
  bridgeGeneration?: string;
}

const catalogueRoadEdge = (edge: SpatialRoadEdge, availableRoadPrefabs?: readonly string[]): boolean =>
  availableRoadPrefabs?.includes(edge.prefab) ?? false;

const pointInTile = (point: SpatialPoint2, tile: SpatialTile): boolean =>
  tile.bounds !== null &&
  point.x >= tile.bounds.min.x && point.x <= tile.bounds.max.x &&
  point.z >= tile.bounds.min.z && point.z <= tile.bounds.max.z;

const isOwned = (point: SpatialPoint2, ownedTiles: readonly SpatialTile[]): boolean =>
  ownedTiles.some((tile) => tile.owned && pointInTile(point, tile));

function terrainSampleAt(point: SpatialPoint2, terrain: SpatialLocalTerrain) {
  const { resolution, bounds, cellSize } = terrain;
  if (!(resolution > 0) || !(cellSize.x > 0) || !(cellSize.z > 0)) return { height: Number.NaN, waterDepth: 0 };
  if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) {
    return { height: Number.NaN, waterDepth: Number.POSITIVE_INFINITY };
  }
  const col = Math.min(resolution - 1, Math.max(0, Math.floor((point.x - bounds.minX) / cellSize.x)));
  const row = Math.min(resolution - 1, Math.max(0, Math.floor((point.z - bounds.minZ) / cellSize.z)));
  const index = row * resolution + col;
  return { height: terrain.heights[index] ?? Number.NaN, waterDepth: terrain.waterDepths[index] ?? 0 };
}

function pointToSegmentDistance(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;

/** The smallest angle between two headings, in degrees, always in [0,180]. */
export function headingSeparationDegrees(leftDegrees: number, rightDegrees: number): number {
  const raw = Math.abs(((leftDegrees - rightDegrees) % 360 + 360) % 360);
  return raw > 180 ? 360 - raw : raw;
}

/**
 * The grid family: ONE STREET = ONE LINE = ONE SUBMISSION, laid as a 集合.
 *
 * WHY THIS REPLACES THE PER-COURSE FAMILY. The family that used to stand here
 * grew one short course at a time from the node nearest the target, on the
 * 40/80/120 cadence, and preferred the perpendicular turn. Every course then
 * left the previous course's endpoint, and since a perpendicular turn is
 * preferred the result was a staircase that happened to be axis-aligned — a
 * ribbon, not a district. It also could not lay a straight street at all: a
 * course whose heading matches the ray of the street already leaving its start
 * node is folded back onto it (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, or a
 * bare 409) at 40 m exactly as at 600 m, which is precisely what the second and
 * third course of one cut line are.
 *
 * `planRectangularGrid` plans one course per LINE and `planGridCollections`
 * arranges those lines into a 集合 (perimeter = ring, interior = the blocks). A
 * line submitted once has no predecessor to be folded onto, and the junctions
 * where it crosses the other lines are made by the world when those lines
 * arrive. Measured live (2026-10-02): 7/7 lines of a 280x200 m collection built,
 * 14 junctions, worst off-axis 0.0002 degrees, worst 落格 0.000 m.
 *
 * BOTH ENDPOINTS ARE FREE. A line of a planned collection has no existing node
 * at either end, and writing `kind:"NEW_FREE_ENDPOINT"` for START is refused
 * outright (`ROAD_ENDPOINT_ATTACHMENT_UNSUPPORTED`). Omitting `startEndpoint`
 * entirely is what the world answers CERTIFIED to, and the world still junctions
 * a free course where it meets a road — so the district joins the existing
 * network through the access course below, not through a declared attachment.
 *
 * It is a pure function of the world: same world, same courses, so a restarted
 * state machine re-derives the course it admitted instead of minting a new one.
 * The collection's corner is the lattice point nearest the site target's own
 * top-left and the lattice is `sharedRoadGridReference`'s 40 m frame, so every
 * endpoint lands on a lattice point by construction.
 */
export function buildRoadGridCandidates(input: RoadGridInput): RoadCandidate[] {
  const reference = sharedRoadGridReference(input.sourceEdges);
  const spacing = GRID_LATTICE_SPACING_METERS;
  const dimensions = collectionBlockDimensions();
  const widthMeters = dimensions.columnWidths.reduce((sum, value) => sum + value, 0);
  const heightMeters = dimensions.rowHeights.reduce((sum, value) => sum + value, 0);
  const cap = input.maxCandidates ?? MAXIMUM_GRID_ROAD_CANDIDATES;

  const buildable = (edge: SpatialRoadEdge): boolean =>
    (edge.native || catalogueRoadEdge(edge, input.availableRoadPrefabs)) &&
    finitePoint(edge.start) && finitePoint(edge.end) && !edge.deleted && !edge.temp;

  const nodeByKey = new Map<string, SpatialRoadNode>(
    (input.sourceNodes ?? []).map((node) => [entityKey(node.entity), node]),
  );
  for (const edge of input.sourceEdges) {
    if (!buildable(edge)) continue;
    for (const [ref, position] of [[edge.startNode, edge.start], [edge.endNode, edge.end]] as const) {
      const key = entityKey(ref);
      if (!nodeByKey.has(key)) nodeByKey.set(key, { entity: ref, position } as SpatialRoadNode);
    }
  }

  // The existing nodes the district may be joined from: the resolver's own
  // eligible nodes, nearest the site first. A node the city does not own cannot
  // carry a course, and one further than `maxSourceDistance` from the site is
  // not this site's entrance — the same reach the bounded families use, so a
  // site no road reaches still comes back with no candidates at all, which is
  // what the site search's `NO_ROUTE` tier reads.
  const maxSourceDistance = input.maxSourceDistance ?? 150;
  const accessNodes = [...nodeByKey.values()]
    .filter((node) => finitePoint(node.position) && isOwned(node.position, input.ownedTiles) &&
      distance(node.position, input.siteTarget) <= maxSourceDistance)
    .sort((left, right) =>
      distance(left.position, input.siteTarget) - distance(right.position, input.siteTarget) ||
      left.entity.index - right.entity.index || left.entity.version - right.entity.version)
    .slice(0, MAXIMUM_GRID_ACCESS_NODES);
  if (accessNodes.length === 0) return [];

  const incidentOf = (node: SpatialRoadNode): SpatialRoadEdge[] => input.sourceEdges.filter((edge) =>
    buildable(edge) &&
    (entityKey(edge.startNode) === entityKey(node.entity) || entityKey(edge.endNode) === entityKey(node.entity)));

  const headingOf = (from: SpatialPoint2, to: SpatialPoint2): number => degrees(Math.atan2(to.z - from.z, to.x - from.x));

  // The directions a node's own streets leave it on. The FAR END is read from
  // its own node, not from `edge.start`/`edge.end`: those are the curve's
  // endpoints, which native trims back at a junction, so on this map they
  // disagree with the node they belong to by up to ~31 m and would bend a
  // straight street by tens of degrees.
  const incidentHeadingsOf = (node: SpatialRoadNode): number[] => incidentOf(node).map((edge) => {
    const farRef = entityKey(edge.startNode) === entityKey(node.entity) ? edge.endNode : edge.startNode;
    const far = nodeByKey.get(entityKey(farRef));
    const other = far?.position ?? (entityKey(edge.startNode) === entityKey(node.entity) ? edge.end : edge.start);
    return headingOf(node.position, other);
  });

  // Measured against the incident street's AXIS, not its ray: laying a course
  // straight on from a junction is the same line the street already runs on
  // whether it leaves forward or backward, and the world measured that collinear
  // case at 6% while the perpendicular turn is 56%.
  const turnRankOf = (headings: readonly number[], from: SpatialPoint2, to: SpatialPoint2): number => {
    const heading = headingOf(from, to);
    const nearestAxis = headings.length === 0 ? 90
      : Math.min(...headings.map((value) => {
          const separation = headingSeparationDegrees(heading, value);
          return Math.min(separation, 180 - separation);
        }));
    return nearestAxis >= 45 ? 0 : 1;
  };

  const origin = reference?.origin ?? { x: 0, z: 0 };
  const lattice = (point: SpatialPoint2): SpatialPoint2 => ({
    x: origin.x + Math.round((point.x - origin.x) / spacing) * spacing,
    z: origin.z + Math.round((point.z - origin.z) / spacing) * spacing,
  });
  const anchor = lattice({ x: input.siteTarget.x - widthMeters / 2, z: input.siteTarget.z - heightMeters / 2 });
  const plan = planGridCollections({ anchor, collections: [dimensions] });
  const corners: SpatialPoint2[] = [
    { x: anchor.x, z: anchor.z },
    { x: anchor.x + widthMeters, z: anchor.z },
    { x: anchor.x, z: anchor.z + heightMeters },
    { x: anchor.x + widthMeters, z: anchor.z + heightMeters },
  ];

  const groundHeightAt = (point: SpatialPoint2): number => {
    if (!input.terrain) return 0;
    const sample = terrainSampleAt(point, input.terrain);
    return Number.isFinite(sample.height) ? sample.height : 0;
  };
  const onOwnedLand = (point: SpatialPoint2): boolean => isOwned(point, input.ownedTiles);

  // Only the roads the collection's own rectangle could touch, read once. The
  // along-road test below is O(edges) per line, and the whole world's graph is
  // several thousand edges wide.
  const nearbyEdges = input.sourceEdges.filter((edge) => {
    if (!buildable(edge)) return false;
    const pad = EXISTING_ROAD_CLEARANCE_METERS;
    return Math.max(edge.start.x, edge.end.x) >= anchor.x - pad &&
      Math.min(edge.start.x, edge.end.x) <= anchor.x + widthMeters + pad &&
      Math.max(edge.start.z, edge.end.z) >= anchor.z - pad &&
      Math.min(edge.start.z, edge.end.z) <= anchor.z + heightMeters + pad;
  });

  /**
   * A course that runs ALONG an existing road is that road being rebuilt, and
   * native answers `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` to it. A course that
   * CROSSES one is not: the crossing is a junction, and making junctions is what
   * the world does with a free course.
   *
   * Measured live (2026-10-02): an endpoint-proximity test — "no endpoint within
   * 12 m of any road" — emptied 5 of a collection's 6 lines at every site beside
   * the existing network, which is every site a district is actually laid on:
   * the collection's near corner is by construction adjacent to the node it
   * joins. The test is on the HEADING, not on the distance alone.
   */
  const clearOfExistingRoads = (from: SpatialPoint2, to: SpatialPoint2, edges: readonly SpatialRoadEdge[] = nearbyEdges): boolean => {
    if (edges.length === 0) return true;
    const heading = headingOf(from, to);
    const samples = [0, 0.5, 1].map((ratio) => ({
      x: from.x + (to.x - from.x) * ratio,
      z: from.z + (to.z - from.z) * ratio,
    }));
    return !edges.some((edge) => {
      const separation = headingSeparationDegrees(heading, headingOf(edge.start, edge.end));
      if (Math.min(separation, 180 - separation) > 15) return false;
      return samples.some((point) => pointToSegmentDistance(point, edge.start, edge.end) < EXISTING_ROAD_CLEARANCE_METERS);
    });
  };
  /** A course is the unit: one building anywhere on it rejects the whole course. */
  const clearOfBuildings = (from: SpatialPoint2, to: SpatialPoint2): boolean => {
    const buildings = input.buildings ?? [];
    if (buildings.length === 0) return true;
    return ![0, 0.25, 0.5, 0.75, 1].some((ratio) => {
      const x = from.x + (to.x - from.x) * ratio;
      const z = from.z + (to.z - from.z) * ratio;
      return buildings.some((building) => Math.hypot(building.position.x - x, building.position.z - z) < 16);
    });
  };

  const source = accessNodes[0]!;
  const incident = incidentOf(source);
  const sourceEdge = incident[0];
  // A source node with no buildable street of its own names no course, and the
  // evidence below would describe an edge that is not there.
  if (!sourceEdge) return [];
  const sourceRole: "start" | "end" = entityKey(sourceEdge.startNode) === entityKey(source.entity) ? "start" : "end";

  const freeCourse = (from: SpatialPoint2, to: SpatialPoint2): RoadGeometryInput => ({
    prefab: input.prefab,
    x1: from.x, z1: from.z, x2: to.x, z2: to.z,
    endEndpoint: {
      kind: "NEW_FREE_ENDPOINT",
      role: "END",
      expectedPosition: { x: to.x, y: groundHeightAt(to), z: to.z },
      worldEpoch: input.bridgeGeneration ?? "UNVERIFIED",
    },
  });

  const candidateFor = (from: SpatialPoint2, to: SpatialPoint2): RoadCandidate => ({
    family: "ORTHOGONAL_GRID",
    gridReference: reference,
    // The worse of the two endpoints' distances to the nearest grid point: the
    // number that says whether this course 落格 at all. A collection line is
    // planned ON the lattice, so it is 0 — and the access course leaves an
    // existing node, which the world placed wherever it is.
    gridAlignmentErrorMeters: reference
      ? Math.max(gridLatticeOffsetMeters(from, reference), gridLatticeOffsetMeters(to, reference))
      : undefined,
    variant: "GRID",
    sourceEdge, sourceRole,
    sourceNode: source,
    sourceAnchor: source.position,
    siteTarget: input.siteTarget,
    initialRoadContactTarget: to,
    roadContactTarget: to,
    contactDerivation: "GRID_AXIS_NODE",
    initialSegmentLength: distance(from, to),
    finalSegmentLength: distance(from, to),
    lengthContract: {
      minMeters: MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
      maxMeters: MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS,
      pass: true,
    },
    adjustmentReason: "NONE",
    incidentEdgeRefs: incident.map((edge) => edge.entity),
    sourceAnchorEvidence: {
      sourceEdgeRef: sourceEdge.entity,
      sourceEndpointRole: sourceRole,
      sourceNodeRef: source.entity,
      sourceNodePosition: source.position,
      incidentEdgeRefs: incident.map((edge) => edge.entity),
      roadDegree: incident.length,
      derivation: "AUTHORITATIVE_GRAPH_NODE",
    },
    geometryFilterResults: "PASS",
    input: freeCourse(from, to),
  });

  interface GridEntry { candidate: RoadCandidate; stage: number; ring: number; order: number }
  const entries: GridEntry[] = [];
  let ringOrigin = anchor;
  let order = 0;

  // 1. THE ACCESS COURSE. A collection is a lattice rectangle, so its corner is
  //    near an existing node but not on it: a course has to join the two or the
  //    district is an island. Two axis-aligned legs keep the spur 横平 instead
  //    of cutting a diagonal across the collection, and the elbow is chosen so
  //    the leg leaving the NODE — the only one with a ray to fold against — is
  //    the one perpendicular to the node's own streets.
  for (const [nodeOrder, node] of accessNodes.entries()) {
    const headings = incidentHeadingsOf(node);
    const corner = [...corners].sort((left, right) =>
      distance(left, node.position) - distance(right, node.position) ||
      left.x - right.x || left.z - right.z)[0]!;
    if (nodeOrder === 0) ringOrigin = corner;
    if (distance(corner, node.position) <= 2) continue;
    const elbow = [
      { at: { x: corner.x, z: node.position.z }, rank: turnRankOf(headings, node.position, { x: corner.x, z: node.position.z }) },
      { at: { x: node.position.x, z: corner.z }, rank: turnRankOf(headings, node.position, { x: node.position.x, z: corner.z }) },
    ]
      .filter((entry) => distance(entry.at, node.position) >= MINIMUM_ACCESS_LEG_METERS)
      .sort((left, right) => left.rank - right.rank || left.at.x - right.at.x || left.at.z - right.at.z)[0];
    if (!elbow) continue;
    const legs = [{ from: node.position, to: elbow.at }, { from: elbow.at, to: corner }]
      .filter((leg) => distance(leg.from, leg.to) >= MINIMUM_ACCESS_LEG_METERS);
    // The access course is one connected spur: a leg that survives without the leg before it starts at the elbow, a
    // point on no street, and is built as an island (measured live 2026-10-02: a 44 m stub, its own road component,
    // no service). All legs pass or the node offers no access course.
    const legPasses = (leg: { from: SpatialPoint2; to: SpatialPoint2 }): boolean => {
      if (!onOwnedLand(leg.from) || !onOwnedLand(leg.to)) return false;
      if (!clearOfBuildings(leg.from, leg.to)) return false;
      // An access leg that runs ALONG an existing street is that street being rebuilt, which native folds back
      // (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`). Measured live (2026-10-02): the only course a stuck standalone
      // Road Goal offered was a 53 m leg lying on a street at z=505.8, refused every tick for 20 ticks while the
      // admission, which never looked at the heading, kept admitting its site. The collection's lines were already
      // judged this way; the access legs, which leave from the network itself, were not.
      const legPad = EXISTING_ROAD_CLEARANCE_METERS;
      const roadsAlongLeg = input.sourceEdges.filter((edge) => buildable(edge) &&
        Math.max(edge.start.x, edge.end.x) >= Math.min(leg.from.x, leg.to.x) - legPad &&
        Math.min(edge.start.x, edge.end.x) <= Math.max(leg.from.x, leg.to.x) + legPad &&
        Math.max(edge.start.z, edge.end.z) >= Math.min(leg.from.z, leg.to.z) - legPad &&
        Math.min(edge.start.z, edge.end.z) <= Math.max(leg.from.z, leg.to.z) + legPad);
      return clearOfExistingRoads(leg.from, leg.to, roadsAlongLeg);
    };
    if (legs.length === 0 || !legs.every(legPasses)) continue;
    for (const leg of legs) {
      // `ring: 0` keeps the elbow's own order: the leg leaving the NODE is the
      // one that has to be built first, and it is not the leg nearest the
      // corner.
      entries.push({ candidate: candidateFor(leg.from, leg.to), stage: 0, ring: 0, order: order++ });
    }
  }

  // 2. THE COLLECTION: the ring first, then growing outward from the corner the
  //    access course reached — the order the live run laid its lines in. A line
  //    whose ground the city does not own, whose endpoint sits on an existing
  //    road (a rebuild of that road, which native folds back rather than
  //    certifying), or which runs through a building is not a course this site
  //    can offer, and dropping it here costs no native call.
  const kept = input.terrain
    ? filterGridSegmentsByTerrain({ segments: plan.segments, terrain: input.terrain }).kept
    : plan.segments;
  for (const segment of kept) {
    if (!onOwnedLand(segment.start) || !onOwnedLand(segment.end)) continue;
    if (!clearOfExistingRoads(segment.start, segment.end)) continue;
    if (!clearOfBuildings(segment.start, segment.end)) continue;
    entries.push({
      candidate: candidateFor(segment.start, segment.end),
      stage: 1,
      ring: Math.abs(segment.start.x - ringOrigin.x) + Math.abs(segment.start.z - ringOrigin.z),
      order: order++,
    });
  }

  return entries
    .sort((left, right) => left.stage - right.stage || left.ring - right.ring || left.order - right.order)
    .slice(0, cap)
    .map((entry) => entry.candidate);
}

export interface RectangularGridPlanInput {
  /** One lattice corner; every line is measured from it. */
  anchor: SpatialPoint2;
  /** Block size along x, left to right. Each a whole number of lattice spacings. */
  columnWidths: readonly number[];
  /** Block size along z. Each a whole number of lattice spacings. */
  rowHeights: readonly number[];
  /**
   * The unit every block size must be a whole multiple of, in metres. Defaults to the 40 m planning lattice. A district lays its own streets at the
   * guide's optimum for the road it uses (`TEMPLATE_DISTRICT_STREET_SPACING_METERS`, 112 m for a Small Road) — which is NOT a multiple of 40, so the
   * plan carries its own unit: the lattice is only what the plan measures itself in.
   */
  spacingMeters?: number;
}

/**
 * The hierarchy a grid line carries. RESERVED: nothing builds a different road
 * prefab by level yet — the field exists so a collection can say which of its
 * lines form the ring (干线) and which are interior (支路) before a level-to-
 * prefab ladder is chosen. Every consumer that ignores it keeps working.
 */
export type RoadLevel = "ARTERIAL" | "LOCAL";

export interface RectangularGridSegment {
  orientation: "VERTICAL" | "HORIZONTAL";
  /** Which grid line this segment IS (0..columns vertical, 0..rows horizontal). */
  lineIndex: number;
  /**
   * The line's block position it starts at. A line is one course, so this is
   * always 0 — kept so a caller can still ask "which block does this start at".
   */
  spanIndex: number;
  cutIndex: number;
  start: SpatialPoint2;
  end: SpatialPoint2;
  lengthMeters: number;
  /** Endpoint lattice coordinates, in the plan's own spacing steps from the anchor (`spacingMeters`, 40 m unless the plan says otherwise). */
  latticeStart: { i: number; j: number };
  latticeEnd: { i: number; j: number };
  /** Reserved hierarchy. `planRectangularGrid` emits LOCAL; a collection's ring promotes to ARTERIAL. */
  level: RoadLevel;
}

/**
 * ONE STREET = ONE COURSE = ONE SUBMISSION.
 *
 * WHY THIS REPLACES THE PER-COURSE FAMILY. `buildRoadGridCandidates` grows one
 * course at a time from the node nearest the target. Every course therefore
 * leaves the previous course's endpoint, and because a perpendicular turn is
 * preferred, the result is a staircase that happens to be axis-aligned — the
 * measured 2026-10-02 acceptance (23 courses, all at exactly 0.0000°) is a
 * ribbon, not a district.
 *
 * WHY A LINE IS NOT CUT AT ITS BLOCKS. A grid line crosses its perpendiculars
 * at the block corners, and cutting the line there produces courses that are
 * COLLINEAR with each other. Measured read-only on this world (2026-10-02): a
 * course whose heading matches the ray of the street already leaving its start
 * node is folded back onto it and refused — `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`,
 * or a bare 409 — at 40 m as much as at 600 m. So the second, third, … course of
 * a cut line is exactly the course the world refuses, and cutting is what makes a
 * straight street impossible to lay. A whole line submitted once has no
 * predecessor to be folded onto; the junctions where it crosses the other lines
 * are made by the world when those lines arrive.
 *
 * The block size is what keeps the course inside the native net contract: a line
 * is 8-1500 m (`MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS`), and a plan whose lines
 * fall outside that is refused here rather than emitted as a course the Bridge
 * answers 400 to.
 *
 * The plan is a pure function of its input: same rectangle, same courses. It
 * knows nothing about the world, so it can be printed and diffed before a single
 * course is submitted.
 */
export function planRectangularGrid(input: RectangularGridPlanInput): RectangularGridSegment[] {
  const spacing = input.spacingMeters ?? GRID_LATTICE_SPACING_METERS;
  const { anchor } = input;
  if (input.columnWidths.length === 0 || input.rowHeights.length === 0) {
    throw new Error("a rectangular grid needs at least one column and one row");
  }
  for (const [index, width] of input.columnWidths.entries()) {
    if (!(width >= spacing) || width % spacing !== 0) {
      throw new Error(`column ${index} width must be a whole number of ${spacing} m lattice spacings`);
    }
  }
  for (const [index, height] of input.rowHeights.entries()) {
    if (!(height >= spacing) || height % spacing !== 0) {
      throw new Error(`row ${index} height must be a whole number of ${spacing} m lattice spacings`);
    }
  }
  // Line positions are prefix sums of the block sizes, so an uneven grid (a wide
  // boulevard block next to a narrow one) still puts every line on a lattice
  // point; only the spacing between lines varies.
  const xLines: number[] = [0];
  for (const width of input.columnWidths) xLines.push(xLines[xLines.length - 1]! + width);
  const zLines: number[] = [0];
  for (const height of input.rowHeights) zLines.push(zLines[zLines.length - 1]! + height);
  const widthMeters = xLines[xLines.length - 1]!;
  const heightMeters = zLines[zLines.length - 1]!;
  for (const [axis, total] of [["column", widthMeters], ["row", heightMeters]] as const) {
    if (!(total >= MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS) || total > MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS) {
      throw new Error(
        `the grid's ${axis} extent ${total} m is outside the native `
        + `${MIN_SUPPORTED_NET_SEGMENT_LENGTH_METERS}-${MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS} m single-segment range`
        + ` — a grid line is one course, so shorten ${axis === "column" ? "the columns" : "the rows"}`,
      );
    }
  }

  const lattice = (point: SpatialPoint2) => ({
    i: Math.round((point.x - anchor.x) / spacing),
    j: Math.round((point.z - anchor.z) / spacing),
  });
  const segments: RectangularGridSegment[] = [];
  // Vertical lines: constant x, the whole z extent, one course each.
  for (let i = 0; i < xLines.length; i += 1) {
    const start = { x: anchor.x + xLines[i]!, z: anchor.z };
    const end = { x: start.x, z: anchor.z + heightMeters };
    segments.push({
      orientation: "VERTICAL", lineIndex: i, spanIndex: 0, cutIndex: 0,
      start, end, lengthMeters: heightMeters,
      latticeStart: lattice(start), latticeEnd: lattice(end), level: "LOCAL",
    });
  }
  // Horizontal lines: constant z, the whole x extent, one course each.
  for (let j = 0; j < zLines.length; j += 1) {
    const start = { x: anchor.x, z: anchor.z + zLines[j]! };
    const end = { x: anchor.x + widthMeters, z: start.z };
    segments.push({
      orientation: "HORIZONTAL", lineIndex: j, spanIndex: 0, cutIndex: 0,
      start, end, lengthMeters: widthMeters,
      latticeStart: lattice(start), latticeEnd: lattice(end), level: "LOCAL",
    });
  }
  return segments;
}

export interface MixedGridDimensionInput {
  columns: number;
  rows: number;
  /**
   * The block size ladder, as ratios of the smallest block (e.g. `[1, 1.5, 2]`
   * for small/medium/large). Repeated cyclically across the grid. THE RATIOS ARE
   * THE PARAMETER — nothing here picks a ladder for the caller.
   */
  ratios?: readonly number[];
  /** Lattice steps the smallest ratio maps to. 2 puts the smallest block at 80 m. */
  unitSteps?: number;
  /** Longest block edge over the shortest, over the WHOLE grid. Default 3 (1:3). */
  maxAspect?: number;
  /** Rotates the ladder between columns and rows so neighbours are not all alike. */
  phaseOffset?: number;
}

export interface MixedGridDimensions {
  columnWidths: number[];
  rowHeights: number[];
}

/**
 * A mixed-size block grid: widths and heights drawn from one ratio ladder.
 *
 * WHY ONE LADDER. The aspect bound (1:1 to 1:3) is a statement about a BLOCK, so
 * it is not enough to bound each axis separately — a 240 m wide row against an
 * 80 m tall column is 1:3, and a 240 against 240 is 1:1. Taking every size from
 * the same ladder makes the bound exactly `max(ratio) / min(ratio)`, which is
 * checked here rather than hoped for. Sizes are emitted as whole lattice steps,
 * so every line lands on a lattice point by construction.
 */
export function mixedGridDimensions(input: MixedGridDimensionInput): MixedGridDimensions {
  const spacing = GRID_LATTICE_SPACING_METERS;
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const ratios = (input.ratios ?? [1, 1.5, 2]).map((ratio) => {
    if (!(ratio > 0) || !Number.isFinite(ratio)) throw new Error("block ratios must be finite and positive");
    return ratio;
  });
  if (ratios.length === 0) throw new Error("block ratios must not be empty");
  const unitSteps = Math.max(1, Math.floor(input.unitSteps ?? 2));
  const maxAspect = input.maxAspect ?? 3;
  const ladder = [...ratios].sort((left, right) => left - right);
  if (ladder[ladder.length - 1]! / ladder[0]! > maxAspect + 1e-9) {
    throw new Error(`block ratios span ${(ladder[ladder.length - 1]! / ladder[0]!).toFixed(2)}:1, over the ${maxAspect}:1 bound`);
  }
  const steps = ratios.map((ratio) => Math.max(1, Math.round((ratio / ladder[0]!) * unitSteps)));
  const phase = Math.max(0, Math.floor(input.phaseOffset ?? 0));
  const columnWidths = Array.from({ length: columns }, (_, index) => steps[index % steps.length]! * spacing);
  const rowHeights = Array.from({ length: rows }, (_, index) => steps[(index + phase) % steps.length]! * spacing);
  return { columnWidths, rowHeights };
}

/**
 * The golden-ratio ladder `[1, φ, φ², …]`.
 *
 * The ratios are still the parameter — this is one ladder a caller may pass to
 * `mixedGridDimensions`, which rounds it to whole lattice steps. Past three
 * levels φ³ ≈ 4.24 exceeds the default 3:1 block bound and the dimension helper
 * refuses it, which is the intended outcome rather than a silent clamp.
 */
export function goldenRatioLadder(levels: number): number[] {
  const count = Math.max(1, Math.floor(levels));
  const golden = (1 + Math.sqrt(5)) / 2;
  return Array.from({ length: count }, (_, index) => golden ** index);
}

export interface GridCollectionSpec {
  columnWidths: readonly number[];
  rowHeights: readonly number[];
}

export interface GridCollection {
  anchor: SpatialPoint2;
  widthMeters: number;
  heightMeters: number;
  segments: RectangularGridSegment[];
}

export interface GridCollectionsPlan {
  collections: GridCollection[];
  /** Every collection's courses, collection by collection, in placement order. */
  segments: RectangularGridSegment[];
}

/**
 * A 集合: one rectangular grid whose PERIMETER lines are its ring (环路) and
 * whose interior lines subdivide it into the mixed-size blocks.
 *
 * WHY A RING AT ALL. The per-course family always grew outward from one node and
 * could not close anything; a collection is the smallest unit that HAS a shape —
 * a closed ring with a subdivided inside — so "lay this district" becomes "place
 * these collections and build each one", and the ring is what makes the district
 * an object rather than a smear.
 *
 * The ring is not a separate geometry: it is the outermost grid lines, promoted
 * to ARTERIAL. Nothing reads the level yet (see `RoadLevel`).
 */
export function planGridCollections(input: {
  anchor: SpatialPoint2;
  collections: readonly GridCollectionSpec[];
  /** 0 shares the boundary line between neighbours; >0 leaves a street-width gap. */
  gapMeters?: number;
  direction?: "ROW" | "COLUMN";
}): GridCollectionsPlan {
  const spacing = GRID_LATTICE_SPACING_METERS;
  const gap = Math.max(0, input.gapMeters ?? 0);
  if (gap % spacing !== 0) throw new Error(`collection gap must be a whole number of ${spacing} m lattice spacings`);
  const direction = input.direction ?? "ROW";
  const collections: GridCollection[] = [];
  const all: RectangularGridSegment[] = [];
  let cursor = { ...input.anchor };

  for (const spec of input.collections) {
    const segments = planRectangularGrid({
      anchor: { ...cursor },
      columnWidths: spec.columnWidths,
      rowHeights: spec.rowHeights,
    });
    // Lines, not blocks: N columns give N+1 vertical lines, so the far ring line
    // is index N, not N-1.
    const lastRow = spec.rowHeights.length;
    const lastColumn = spec.columnWidths.length;
    for (const segment of segments) {
      // The perimeter: the first and last line on each axis.
      const onRing = segment.orientation === "VERTICAL"
        ? segment.lineIndex === 0 || segment.lineIndex === lastColumn
        : segment.lineIndex === 0 || segment.lineIndex === lastRow;
      if (onRing) segment.level = "ARTERIAL";
    }
    const widthMeters = spec.columnWidths.reduce((sum, value) => sum + value, 0);
    const heightMeters = spec.rowHeights.reduce((sum, value) => sum + value, 0);
    collections.push({ anchor: { ...cursor }, widthMeters, heightMeters, segments });
    all.push(...segments);
    cursor = direction === "ROW"
      ? { x: cursor.x + widthMeters + gap, z: cursor.z }
      : { x: cursor.x, z: cursor.z + heightMeters + gap };
  }
  return { collections, segments: all };
}

export type GridTerrainRejectionReason = "WATER" | "STEEP_GRADE" | "OFF_TERRAIN";

export interface GridSegmentRejection {
  segment: RectangularGridSegment;
  reason: GridTerrainRejectionReason;
  detail: string;
}

export interface GridTerrainFilterResult {
  kept: RectangularGridSegment[];
  rejected: GridSegmentRejection[];
}

/**
 * Drop every course the ground cannot carry: water anywhere on it, or a grade
 * over the planning bound.
 *
 * A course is the unit, not a sample: a straight 120 m course that clips a
 * narrow water patch is a road standing in the sea, so one wet sample rejects the
 * whole course. The caller then either drops it (a gap in the block) or moves the
 * collection; this function only reports.
 */
export function filterGridSegmentsByTerrain(input: {
  segments: readonly RectangularGridSegment[];
  terrain: SpatialLocalTerrain;
  maxGradePercent?: number;
  /** Samples per course; more catches a narrow patch a straight line clips. */
  samplesPerSegment?: number;
}): GridTerrainFilterResult {
  const maxGradePercent = input.maxGradePercent ?? MAX_PLANNING_ROAD_GRADE_PERCENT;
  const samplesPerSegment = Math.max(2, Math.floor(input.samplesPerSegment ?? 9));
  const kept: RectangularGridSegment[] = [];
  const rejected: GridSegmentRejection[] = [];

  for (const segment of input.segments) {
    const samples = Array.from({ length: samplesPerSegment }, (_, index) => {
      const ratio = index / (samplesPerSegment - 1);
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        z: segment.start.z + (segment.end.z - segment.start.z) * ratio,
      };
    });
    const readings = samples.map((point) => terrainSampleAt(point, input.terrain));
    const offTerrain = readings.findIndex((reading) => !Number.isFinite(reading.height));
    if (offTerrain >= 0) {
      rejected.push({ segment, reason: "OFF_TERRAIN", detail: `sample ${offTerrain} is outside the terrain read` });
      continue;
    }
    const wet = readings.findIndex((reading) => reading.waterDepth > 0);
    if (wet >= 0) {
      rejected.push({ segment, reason: "WATER", detail: `sample ${wet} waterDepth=${readings[wet]!.waterDepth.toFixed(2)}` });
      continue;
    }
    const stepMeters = Math.max(1, Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z) / (samplesPerSegment - 1));
    let worstGrade = 0;
    for (let index = 1; index < readings.length; index += 1) {
      const rise = Math.abs(readings[index]!.height - readings[index - 1]!.height);
      worstGrade = Math.max(worstGrade, (rise / stepMeters) * 100);
    }
    if (worstGrade > maxGradePercent) {
      rejected.push({ segment, reason: "STEEP_GRADE", detail: `worst grade ${worstGrade.toFixed(1)}% > ${maxGradePercent}%` });
      continue;
    }
    kept.push(segment);
  }
  return { kept, rejected };
}

export interface GridCollectionTerrainReport {
  collectionIndex: number;
  segments: number;
  kept: number;
  waterRejected: number;
  steepRejected: number;
  offTerrainRejected: number;
  /** True only when the whole collection clears the ground. */
  placeable: boolean;
}

/** Per-collection terrain verdict: "can this collection be laid here at all?" */
export function reportGridCollectionsOnTerrain(input: {
  plan: GridCollectionsPlan;
  terrain: SpatialLocalTerrain;
  maxGradePercent?: number;
  samplesPerSegment?: number;
}): GridCollectionTerrainReport[] {
  return input.plan.collections.map((collection, collectionIndex) => {
    const result = filterGridSegmentsByTerrain({
      segments: collection.segments,
      terrain: input.terrain,
      ...(input.maxGradePercent === undefined ? {} : { maxGradePercent: input.maxGradePercent }),
      ...(input.samplesPerSegment === undefined ? {} : { samplesPerSegment: input.samplesPerSegment }),
    });
    return {
      collectionIndex,
      segments: collection.segments.length,
      kept: result.kept.length,
      waterRejected: result.rejected.filter((entry) => entry.reason === "WATER").length,
      steepRejected: result.rejected.filter((entry) => entry.reason === "STEEP_GRADE").length,
      offTerrainRejected: result.rejected.filter((entry) => entry.reason === "OFF_TERRAIN").length,
      placeable: result.rejected.length === 0,
    };
  });
}
