import { createHash } from "node:crypto";
import type { GrowableZoneCategory } from "../growth-mode";
import type { SpatialSiteDetail, SpatialPoint2, SpatialTile, SpatialWorldModel, SpatialZoningCell } from "../spatial/types";
import { pointInTile } from "../spatial/world-scanner";
import { MAX_PLANNING_ROAD_GRADE_PERCENT } from "./road-connection-resolver";
import { buildRoadGridCandidates } from "./road-grid-generator";
import type { RoadCandidate } from "./road-connection-resolver";
import { deriveExactZoningActionRadius, nativeZoningMarqueeFootprint } from "./foundation";
import type { CircleScope } from "./gate1";

/**
 * The native zoning category a census may require for this land use, if any.
 *
 * Office has no dedicated native zoning category in this product, so it is
 * admitted without one — which is exactly what makes it weaker proof than the
 * other three, and why it is spelled here rather than at each call site.
 */
export function requestedZoneCategory(category: GrowableZoneCategory): GrowableZoneCategory {
  // The category the Goal asked for, unchanged. This used to answer `undefined`
  // for office, which silently dropped the Goal's own requirement: the marquee
  // then treated every categorized cell as a conflict and the census could never
  // say whether office land was takeable. The scan has always carried `office`
  // in `SpatialZoningCell["zoneCategory"]`, so the narrowing was this adapter's,
  // not the world's.
  return category;
}

export type Gate1SiteRejectionReason =
  | "NOT_OWNED"
  /**
   * The point lies outside this anchor's own observation circle
   * (`localScope = { center: detail.center, radius: detail.radius }`), so the
   * anchor never saw that land in the first place.
   *
   * Distinct from `NOT_OWNED` (the land is observed but not ours) and from
   * `OUTSIDE_PROJECT_SCOPE` (the ANCHOR itself was filtered out by the project's
   * scope, before any point was considered). Measured live 2026-10-01: the two
   * causes used to share one counter, and the scope side dominated — 36 anchors
   * all testing the SAME point gave 31 rejections while `owned(point)` is
   * constant for a fixed point, and the point was verified to be owned. Splitting
   * them is what lets the histogram answer which constraint is actually binding.
   */
  | "OUTSIDE_ANCHOR_OBSERVATION"
  | "NOT_BUILDABLE"
  | "NO_ACCESS"
  | "NO_ROUTE"
  | "WATER"
  | "TERRAIN"
  | "PROTECTION_RESERVATION"
  | "ZONEABLE_FRONTAGE"
  | "OUTSIDE_PROJECT_SCOPE"
  | "TARGET_NOT_ADVANCED"
  | "UNKNOWN"
  | "OTHER";

export interface Gate1BoundedSiteSelectionInput {
  world: SpatialWorldModel;
  details: ReadonlyArray<{ anchor: SpatialPoint2; detail: SpatialSiteDetail }>;
  availableRoadPrefabs?: ReadonlyArray<string>;
  projectScope?: CircleScope;
  protections?: ReadonlyArray<{ ref: string; scope: CircleScope }>;
  /** Revalidate one persisted reservation during durable Road-step replay. */
  replayTarget?: CircleScope;
  maxCandidates?: number;
}

const starterRoadCompatible = (prefab: string): boolean =>
  prefab.trim().length > 0 && !/highway|motorway|expressway|divided/i.test(prefab);

/**
 * The exact zoning radius of one bounded starter site candidate.
 *
 * Exported because it is the only part of a candidate's geometry that is *not*
 * recorded anywhere in the durable state: `project.utilityReservation.center` is
 * the candidate's own center (the admission bootstrap copies it), so a recovery
 * that has the admitted reservation but not this radius would otherwise have to
 * restate the number.
 */
export const STARTER_SITE_TARGET_RADIUS_METERS = 28;

/**
 * Candidate score tiers for a target-directed search.
 *
 * Within a tier, a smaller distance to the target wins. Across tiers, a reachable
 * site always beats an unreachable one: a site the bounded road resolver could
 * not reach is a site the native boundary will refuse, so it must never outrank
 * one that can actually be built. The tiers are far apart compared with any real
 * distance term (the map is a few kilometres across), so distance can never
 * cross them.
 */
const REACHABLE_SITE_TIER = 1_000_000_000;
const UNREACHABLE_SITE_TIER = 0;

/**
 * How far along the target direction a corridor step may reach, as offsets from
 * its anchor.
 *
 * A goal-directed Road work order is one segment of a corridor toward a resource,
 * so its step has to be as long as the evidence allows rather than as short as
 * possible: a resource a few hundred metres outside the network needs a handful
 * of steps, and every step that stops short spends another admission, another
 * reservation and another bounded prerequisite slot. The largest offset stays
 * INSIDE the observed radius — a candidate further out than the region admission
 * actually looked at would be a site nobody observed.
 */
const TARGET_DIRECTED_OFFSETS_METERS = [32, 48, 64, 88] as const;

export function selectAvailableStarterRoadPrefab(input: {
  availableRoadPrefabs: ReadonlyArray<string>;
  preferred?: string;
}): string {
  const available = [...new Set(input.availableRoadPrefabs.filter((prefab) => starterRoadCompatible(prefab)))].sort((a, b) => a.localeCompare(b));
  if (available.length === 0) throw new Error("NO_UNLOCKED_COMPATIBLE_ROAD_PREFAB");
  if (input.preferred && available.includes(input.preferred)) return input.preferred;
  const localRoad = available.find((prefab) => /\broad\b/i.test(prefab));
  return localRoad ?? available[0];
}

export interface Gate1BoundedSiteCandidate {
  id: string;
  target: CircleScope;
  score: number;
  blocked: false;
  direction: SpatialPoint2;
  roadCandidates: RoadCandidate[];
  evidence: {
    sourceAnchor: SpatialPoint2;
    openResidentialCells: number;
    owned: true;
    buildable: true;
    access: "BOUNDED_ROAD_FEASIBLE" | "TARGET_DIRECTED_ROAD_FALLBACK" | "EXISTING_ROAD_FRONTAGE";
    /**
     * Whether this exact reservation carries land the project can zone.
     *
     * Always set by `evaluateBoundedStarterSites`. Optional only because a
     * caller that restates one already-admitted candidate — the current-branch
     * replan — has the reservation but not the census behind it, and an unknown
     * census must not be recorded as a verdict either way.
     */
    frontage?: boolean;
    /**
     * Whether the ZONING step could actually take this exact reservation.
     *
     * `frontage` is the weaker fact — "some free cell lies inside the box".
     * The zoning step needs the stronger one, because native Zone Apply is an
     * axis-aligned marquee that selects every visible cell centre inside a
     * square, and the authorization has to span all of them. A reservation whose
     * centre sits next to a blocked cell can carry frontage and still be
     * unzoneable at every radius the step tries.
     *
     * Optional for the same reason `frontage` is, and `undefined` is unproven
     * rather than disproven.
     */
    zoningFootprint?: boolean;
  };
}

export interface Gate1BoundedSiteSelectionResult {
  candidates: Gate1BoundedSiteCandidate[];
  rejections: Record<Gate1SiteRejectionReason, number>;
  inspectedRegions: number;
}

export interface Gate1StarterSiteAnchor {
  node: SpatialWorldModel["roadGraph"]["nodes"][number];
  sourceEdges: SpatialWorldModel["roadGraph"]["edges"];
  direction: SpatialPoint2;
  derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" | "OWNED_START_CONNECTION_TOPOLOGY";
}

const emptyRejections = (): Record<Gate1SiteRejectionReason, number> => ({
  NOT_OWNED: 0,
  OUTSIDE_ANCHOR_OBSERVATION: 0,
  NOT_BUILDABLE: 0,
  NO_ACCESS: 0,
  NO_ROUTE: 0,
  WATER: 0,
  TERRAIN: 0,
  PROTECTION_RESERVATION: 0,
  ZONEABLE_FRONTAGE: 0,
  OUTSIDE_PROJECT_SCOPE: 0,
  TARGET_NOT_ADVANCED: 0,
  UNKNOWN: 0,
  OTHER: 0,
});

const distance = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);
const key = (point: SpatialPoint2) => `${point.x.toFixed(3)}:${point.z.toFixed(3)}`;
export const pointWithinCircleScope = (point: SpatialPoint2, scope: CircleScope) => distance(point, scope.center) <= scope.radius;
const finitePoint = (point: SpatialPoint2 | null | undefined): point is SpatialPoint2 => !!point && Number.isFinite(point.x) && Number.isFinite(point.z);

function terrainIndex(detail: SpatialSiteDetail, point: SpatialPoint2): number | null {
  const bounds = detail.terrain.bounds;
  if (detail.terrain.resolution <= 0 || point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) return null;
  const col = Math.min(detail.terrain.resolution - 1, Math.max(0, Math.floor(((point.x - bounds.minX) / (bounds.maxX - bounds.minX)) * detail.terrain.resolution)));
  const row = Math.min(detail.terrain.resolution - 1, Math.max(0, Math.floor(((point.z - bounds.minZ) / (bounds.maxZ - bounds.minZ)) * detail.terrain.resolution)));
  return row * detail.terrain.resolution + col;
}

function owned(point: SpatialPoint2, tiles: SpatialTile[]): boolean {
  return tiles.some((tile) => tile.owned && pointInTile(point, tile));
}

export function isOwnedSpatialPoint(point: SpatialPoint2, world: SpatialWorldModel): boolean {
  return owned(point, world.ownedTiles);
}

function directionFor(detail: SpatialSiteDetail, target: SpatialPoint2): SpatialPoint2 | null {
  const nearest = detail.roadGraph.edges
    .filter((edge) => edge.native && finitePoint(edge.start) && finitePoint(edge.end))
    .map((edge) => {
      const dx = edge.end.x - edge.start.x;
      const dz = edge.end.z - edge.start.z;
      const length = Math.hypot(dx, dz);
      const projection = length > 0 ? Math.max(0, Math.min(1, ((target.x - edge.start.x) * dx + (target.z - edge.start.z) * dz) / (length * length))) : 0;
      const point = { x: edge.start.x + dx * projection, z: edge.start.z + dz * projection };
      return { distance: distance(point, target), vector: { x: dx / length, z: dz / length } };
    })
    .sort((a, b) => a.distance - b.distance || a.vector.x - b.vector.x || a.vector.z - b.vector.z)[0];
  if (!nearest || !Number.isFinite(nearest.distance)) return null;
  return nearest.vector;
}

function hasBuildingConflict(detail: SpatialSiteDetail, target: CircleScope): boolean {
  return detail.buildings.some((building) => distance(building.position, target.center) <= target.radius + (building.footprint ? Math.max(building.footprint.size.x, building.footprint.size.z) * 0.5 : 8));
}

/**
 * The bounded cell set the ZONING step would actually take at this target, or
 * `null` when it would take none.
 *
 * This is the zoning step's own decision in one place, so site selection and
 * zoning cannot end up asking different questions about the same land.
 *
 * Native Zone Apply is an axis-aligned marquee: it selects every visible cell
 * centre inside a square, and the authorization has to span all of them. So a
 * reservation is zoneable only when some candidate radius yields a square that
 * contains at least one free cell of this land use's category and contains no
 * occupied, blocked, overridden, or already-differently-categorised cell.
 *
 * The weaker test this replaces asked only "does a free cell lie somewhere
 * inside the box", and that is not the same question. A candidate's reservation
 * is placed at an offset from the road anchor it fronts, and when the anchor's
 * cell is itself blocked the reservation's CENTRE sits on that blocked cell
 * while the only free cells sit out near its rim — every marquee radius then
 * contains the blocked cell, and the tranche pays for its road and dies at
 * `GATE1_ZONING_NO_BOUNDED_<LANDUSE>_CELL_SET`. Measured live (2026-09-29) at
 * the electricity Goal's admitted target: five free cells, all in the 21-28 m
 * ring, and the nearest cell to the centre was `none, blocked` at 3.34 m.
 *
 * An observation that returned no zoning census at all is a different case and
 * keeps its previous answer: the site is unproven, not disproven. A cell whose
 * category the observation could not classify is also not a verdict about the
 * land — but note the zoning resolver only ever takes `none`, so counting an
 * `unknown` cell as usable here would promise an executability the next step
 * cannot deliver.
 */
export function boundedZoningCellSetInNativeMarquee(
  detail: SpatialSiteDetail,
  target: CircleScope,
  requestedZoneCategory?: GrowableZoneCategory,
  /**
   * Whether the marquee must already contain a cell carrying road frontage.
   *
   * True for every caller that is deciding what the ZONING step may take now:
   * a footprint with no frontage witness is one the Growable Fast Path will not
   * select, so promising it would promise an executability the next step cannot
   * deliver.
   *
   * False for the one question that is about a road this city has not built
   * yet — "would this land be a footprint if a Road reached it?" There the
   * witness is the thing being asked for, so requiring it would make the
   * question unanswerable by construction.
   */
  options?: { requireRoadsideWitness?: boolean },
): { cells: SpatialZoningCell[]; exactRadius: number } | null {
  // An empty census is unproven. It cannot establish an executable footprint.
  if (detail.zoningCells.length === 0) return null;
  const candidateRadii = [1, 0.75, 0.5, 0.25, 0.125]
    .map((fraction) => target.radius * fraction)
    .filter((radius) => radius > 0);
  for (const radius of candidateRadii) {
    const cells = detail.zoningCells.filter((cell) => {
      const dx = cell.position.x - target.center.x;
      const dz = cell.position.z - target.center.z;
      return dx * dx + dz * dz <= radius * radius && cell.visible && !cell.occupied &&
        !cell.blocked && !cell.overridden && cell.zoneCategory === "none";
    });
    if (cells.length === 0 || cells.length > 4096) continue;
    const exactRadius = deriveExactZoningActionRadius(target.center, cells);
    // The marquee the native step will apply, at the radius it will derive from
    // these very cells. Every cell it selects that is not already in the
    // requested category must be free and clean, or the step cannot authorize it.
    const footprint = nativeZoningMarqueeFootprint(detail, target.center, exactRadius);
    // Admission and K04 must agree on the complete set a native marquee will
    // change. Cells already carrying this Goal's category are idempotent and
    // remain outside the mutable footprint; an admission without a requested
    // category treats every categorized cell as a conflict, as before.
    const mutableCells = requestedZoneCategory
      ? footprint.filter((cell) => cell.zoneCategory !== requestedZoneCategory)
      : footprint;
    if (
      mutableCells.length === 0 ||
      mutableCells.length > 4096 ||
      mutableCells.some((cell) => cell.zoneCategory !== "none" || cell.occupied || cell.blocked || cell.overridden) ||
      !hasContiguousZoningCells(mutableCells) ||
      ((options?.requireRoadsideWitness ?? true) && !mutableCells.some(hasGrowableRoadsideWitness))
    ) continue;
    return { cells: mutableCells, exactRadius };
  }
  return null;
}

/**
 * Owned local (non-highway) road edges, the network a growable district hangs off.
 *
 * `native` is origin metadata, NOT the authority for "is this a road the city
 * has". The product's own delivered roads come back without the flag — measured
 * live (2026-10-02) on `cs2-session:d8413e4f…`: of 50 owned local edges, 8 are
 * the map's own and **42 are the Mayor's**, carrying 38 owned nodes. Requiring
 * `native` here hid every one of them from the growth selector, so a Road the
 * product built could never become the place it looked next, and the loop
 * "no frontage → build a road → new frontage → build again" could not close.
 *
 * Same rule as the three call sites in `gate1-progression-boundary.ts`
 * (`buildableRoadEdge`: a native edge, or one whose prefab the catalogue can
 * build). `divided` is kept as a local-road narrowing — frontage on a divided
 * road is not what a district hangs off — and says nothing about authorization.
 */
function ownedLocalRoadEdges(
  world: SpatialWorldModel,
  availableRoadPrefabs?: readonly string[],
): SpatialWorldModel["roadGraph"]["edges"] {
  return world.roadGraph.edges.filter((edge) => !edge.deleted && !edge.temp &&
    !/divided/i.test(edge.prefab) && buildableRoadEdge(edge, availableRoadPrefabs));
}

/**
 * The bounded, ordered set of census centres a growable admission reads.
 *
 * The previous growable fast path read exactly ONE region, centred on the
 * centroid of every owned local road node. That centre is a deterministic
 * function of the road graph, so a region the land had already disproved was
 * re-derived identically on every later cycle: the same target, the same
 * refusal, until the whole domain was parked — and the Brain then reported no
 * goal while buildable land was still on the map. `FRONTAGE_EXISTS_BUT_NO_VALID_
 * GROWABLE_FOOTPRINT` at one centroid is a finding about one region, and turning
 * it into a finding about the domain was the bug.
 *
 * Reading a bounded ring of anchors is what makes it a finding about one region.
 * Anchors are ordered by how much expansion each one actually offers:
 *
 * 1. The Goal's own `targetPoint`, when a directed Goal named one. A Goal that
 *    named its ground is answered about that ground first.
 * 2. **Road tips** — nodes with exactly one owned local road edge. These are the
 *    ends of the built network, which is where undeveloped frontage is, and
 *    ordering by them makes the search expand outward instead of oscillating
 *    inside the finished city.
 * 3. Interior road nodes, in a stable index order.
 *
 * Anchors closer together than one census radius are collapsed, so each read
 * covers ground no earlier read covered and the bound on the list is a bound on
 * distinct geography rather than on repeated samples of one place.
 */
export function selectGrowableSearchAnchors(input: {
  world: SpatialWorldModel;
  targetPoint?: SpatialPoint2;
  maxAnchors: number;
  /** Minimum separation between two anchors, in metres. */
  separationMeters: number;
  /**
   * The project's unlocked road prefabs. A delivered road comes back without the
   * `native` flag, so this is what makes the product's own network visible to
   * its own growth selector. Omitted keeps the pre-existing (native-only)
   * behaviour, so an unconfigured caller cannot change meaning by accident.
   */
  availableRoadPrefabs?: readonly string[];
}): { anchors: SpatialPoint2[]; ownedLocalRoadNodes: number } {
  const limit = Math.max(1, Math.min(64, Math.trunc(input.maxAnchors)));
  const separation = Math.max(0, input.separationMeters);
  const localEdges = ownedLocalRoadEdges(input.world, input.availableRoadPrefabs);
  const incident = new Map<string, number>();
  for (const edge of localEdges) {
    for (const ref of [edge.startNode, edge.endNode]) {
      const key = entityKey(ref);
      incident.set(key, (incident.get(key) ?? 0) + 1);
    }
  }
  // No `node.native` gate: a node can only enter through `incident`, which is
  // built entirely from the edges this function already filtered, so dropping it
  // cannot admit a node whose edge was refused — it admits exactly the endpoints
  // of the roads the product built. A delivered road's far end is a node the
  // scan reports as non-native, and that end IS the frontier.
  const owned = input.world.roadGraph.nodes
    .filter((node) => incident.has(entityKey(node.entity)) &&
      isOwnedSpatialPoint({ x: node.position.x, z: node.position.z }, input.world))
    .map((node) => ({
      position: { x: node.position.x, z: node.position.z },
      // Fewer incident edges is further out; a tip is a network end.
      degree: incident.get(entityKey(node.entity)) ?? 0,
      order: node.entity.index,
    }))
    .sort((left, right) => left.degree - right.degree || left.order - right.order);
  const anchors: SpatialPoint2[] = [];
  const farEnough = (point: SpatialPoint2) =>
    anchors.every((anchor) => Math.hypot(anchor.x - point.x, anchor.z - point.z) >= separation);
  const offer = (point: SpatialPoint2) => {
    if (anchors.length >= limit || !farEnough(point)) return;
    anchors.push(point);
  };
  if (input.targetPoint) offer({ x: input.targetPoint.x, z: input.targetPoint.z });
  for (const node of owned) offer(node.position);
  // An empty ring means the world owns no local road to hang a district off, and
  // the caller refuses by name rather than being handed a fabricated centre.
  return { anchors, ownedLocalRoadNodes: owned.length };
}

/** Native zoning cells use an 8 m grid. Adjacent orthogonal cell centres are
 * 8 m apart (including rotated blocks); the small tolerance absorbs native
 * float rounding while excluding diagonal-only contact. */
const MAX_CONTIGUOUS_ZONE_CELL_GAP_METERS = 8.25;

/** Zone Block side bits remain authoritative before the aggregate roadside
 * flag becomes true on unzoned growable cells. */
export function hasGrowableRoadsideWitness(cell: SpatialZoningCell): boolean {
  return cell.roadside || cell.roadLeft === true || cell.roadRight === true || cell.roadBack === true;
}

function distanceToRoadGeometry(point: SpatialPoint2, detail: SpatialSiteDetail): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const edge of detail.roadGraph.edges) {
    if (edge.deleted) continue;
    const dx = edge.end.x - edge.start.x;
    const dz = edge.end.z - edge.start.z;
    const length2 = dx * dx + dz * dz;
    if (length2 <= 0) continue;
    const t = Math.max(0, Math.min(1, ((point.x - edge.start.x) * dx + (point.z - edge.start.z) * dz) / length2));
    nearest = Math.min(nearest, Math.hypot(point.x - (edge.start.x + t * dx), point.z - (edge.start.z + t * dz)));
  }
  return nearest;
}

/** The census cells the Growable Fast Path may seed a zoning reservation from:
 *  free, unzoned, and carrying road frontage the project can build on. */
export function growableFrontageCells(detail: SpatialSiteDetail): SpatialZoningCell[] {
  return detail.zoningCells.filter((cell) => cell.visible && !cell.occupied && !cell.blocked &&
    !cell.overridden && cell.zoneCategory === "none" && hasGrowableRoadsideWitness(cell) &&
    (detail.roadGraph.edges.length === 0 ||
      distanceToRoadGeometry({ x: cell.position.x, z: cell.position.z }, detail) <= 18));
}

/** Select a normal small development band directly from a bounded native Zone
 * Block census. The square target is subsequently revalidated by Gate1's
 * existing marquee resolver before authorization. */
/** The fewest cells a growable footprint may have. A smaller gap is still ground native will zone. */
export const MINIMUM_GROWABLE_FOOTPRINT_CELLS = 4;
// Was 6. Measured live (2026-10-03): at (1100,500) and (1300,700) native showed 17 and 7 free roadside cells, the
// product refused both as `NO_VALID_GROWABLE_FOOTPRINT`, and the candidates native would take were 4 cells (2 each).
// Four is the smallest residential lot (2x2), so a 1x2 incidental fragment is still not a site.

export function selectGrowableFrontageFootprint(input: {
  detail: SpatialSiteDetail;
  zoneCategory: GrowableZoneCategory;
  protections?: ReadonlyArray<{ ref: string; scope: CircleScope }>;
  maxCandidates?: number;
  minimumCells?: number;
}): Gate1BoundedSiteCandidate[] {
  const minimumCells = input.minimumCells ?? MINIMUM_GROWABLE_FOOTPRINT_CELLS;
  const candidates: Gate1BoundedSiteCandidate[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, Math.min(8, input.maxCandidates ?? 4));
  const front = growableFrontageCells(input.detail);
  for (const frontage of front) {
    const roadEdge = input.detail.roadGraph.edges.filter((edge) => !edge.deleted)
      .map((edge) => ({ edge, distance: distanceToRoadGeometry(
        { x: frontage.position.x, z: frontage.position.z }, { ...input.detail,
          roadGraph: { ...input.detail.roadGraph, edges: [edge] } }) }))
      .sort((a, b) => a.distance - b.distance)[0]?.edge;
    const edgeLength = roadEdge ? Math.hypot(roadEdge.end.x - roadEdge.start.x, roadEdge.end.z - roadEdge.start.z) || 1 : 1;
    const roadDirection = roadEdge
      ? { x: (roadEdge.end.x - roadEdge.start.x) / edgeLength, z: (roadEdge.end.z - roadEdge.start.z) / edgeLength }
      : { x: 1, z: 0 };
    for (const radius of [24, 32, 40, 48]) {
      const target = { center: { x: frontage.position.x, z: frontage.position.z }, radius };
      if (input.protections?.some((p) => Math.hypot(p.scope.center.x - target.center.x,
        p.scope.center.z - target.center.z) < p.scope.radius + target.radius)) continue;
      const footprint = boundedZoningCellSetInNativeMarquee(input.detail, target,
        requestedZoneCategory(input.zoneCategory));
      if (!footprint || footprint.cells.length < minimumCells || footprint.cells.length > 96 ||
        !footprint.cells.some(hasGrowableRoadsideWitness)) continue;
      const ids = footprint.cells.map((cell) => `${cell.block.index}:${cell.block.version}:${cell.index}`).sort();
      const fingerprint = ids.join("|");
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      candidates.push({
        id: `growable-frontage:${frontage.block.index}:${frontage.block.version}:${frontage.index}:${radius}`,
        target, score: footprint.cells.length * 100 - radius, blocked: false,
        direction: roadDirection, roadCandidates: [],
        evidence: { sourceAnchor: target.center, openResidentialCells: footprint.cells.length,
          owned: true, buildable: true, access: "EXISTING_ROAD_FRONTAGE", frontage: true, zoningFootprint: true },
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Why the Growable Fast Path found no zoning footprint.
 *
 * Four different worlds produce the same empty candidate list, and only the
 * first of them is a Road problem:
 *
 * - `MISSING_FRONTAGE` — the frontage a zoning footprint needs is not there. A
 *   Road is exactly what produces one, so the existing `ROAD_FRONTAGE`
 *   prerequisite is the right answer. "Not there" covers two shapes, and the
 *   second is the one that used to be misread as unfixable: no free unzoned cell
 *   carries frontage at all, **or** the free owned unzoned land that WOULD take
 *   the zoning has no frontage yet. The Fast Path may only seed a marquee on a
 *   frontage cell (`selectGrowableFrontageFootprint`), so an unfronted block is
 *   invisible to it no matter how much land it holds — and a Road is what makes
 *   it visible. Measured live (2026-10-01): a 48-cell owned unzoned block 30 m
 *   from the nearest road, in band and unselectable, which is why the city went
 *   idle while buildable land stood on the map.
 * - `FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT` — frontage cells exist and
 *   no marquee anywhere reaches the size band, fronted or not (too few, too
 *   fragmented). Native zoning only recolours existing cells; a Road cannot add
 *   one, so asking for a Road here spends a real build on land it cannot fix.
 * - `GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES` — footprints exist and are
 *   executable, but the land is not the project's. Ownership is not a Road
 *   question either.
 * - `GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION` — footprints exist and
 *   are owned, but every one lies inside a reservation another Goal still
 *   claims. The land is already zoneable; what is missing is free land, and no
 *   Road can free it.
 *
 * Callers that only need "there is nothing here" keep using
 * `selectGrowableFrontageFootprint`; this answers the different question of what
 * to do about it.
 */
export type GrowableFrontageAbsence =
  | "MISSING_FRONTAGE"
  | "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT"
  | "GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES"
  | "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION";

export interface GrowableFrontageAbsenceReport {
  reason: GrowableFrontageAbsence;
  /** Free unzoned census cells carrying road frontage. */
  frontageCells: number;
  /** Executable footprints in the Fast Path's size band before ownership and claims. */
  unprotectedFootprints: number;
  /** The subset of those on land the project owns. */
  ownedFootprints: number;
  /**
   * For `MISSING_FRONTAGE`: the owned free unzoned land whose frontage is what
   * is missing, and how big the marquee there would be once a Road supplies it.
   * A Road belongs at `center`, not at the centroid of every clean cell the
   * anchor happens to hold — measured 32 m to 152 m apart on the same ring.
   */
  missingFrontage?: { center: SpatialPoint2; cells: number; radius: number };
}

/**
 * The best marquee the Fast Path would accept if the land under it had frontage.
 *
 * Only owned, free, unzoned cells that carry NO roadside witness are considered:
 * land that already has frontage is what `selectGrowableFrontageFootprint` reads,
 * and it has already answered for itself by the time this runs.
 *
 * The footprint is resolved by the same native marquee resolver the ZONING step
 * uses and scored on the same 6..96 band, with the one difference that the
 * roadside witness precondition is lifted. That precondition is a statement
 * about the road this land does not have yet, so keeping it would make the
 * question unanswerable by construction: what is being measured here is whether
 * the LAND would be executable, not whether a road is already there.
 */
function unfrontagedOwnedInBandFootprint(input: {
  detail: SpatialSiteDetail;
  zoneCategory: GrowableZoneCategory;
  isOwned?: (point: SpatialPoint2) => boolean;
}): { center: SpatialPoint2; cells: number; radius: number } | null {
  const candidates = input.detail.zoningCells.filter((cell) => cell.visible && !cell.occupied && !cell.blocked &&
    !cell.overridden && cell.zoneCategory === "none" && !hasGrowableRoadsideWitness(cell) &&
    (input.isOwned?.({ x: cell.position.x, z: cell.position.z }) ?? true));
  let best: { center: SpatialPoint2; cells: number; radius: number } | null = null;
  for (const cell of candidates) {
    const center = { x: cell.position.x, z: cell.position.z };
    for (const radius of [24, 32, 40, 48]) {
      const footprint = boundedZoningCellSetInNativeMarquee(input.detail, { center, radius },
        requestedZoneCategory(input.zoneCategory), { requireRoadsideWitness: false });
      if (!footprint || footprint.cells.length < MINIMUM_GROWABLE_FOOTPRINT_CELLS || footprint.cells.length > 96) continue;
      // Ownership is a fact about every cell the marquee would recolour, exactly
      // as the caller reads it.
      if (!footprint.cells.every((candidate) =>
        input.isOwned?.({ x: candidate.position.x, z: candidate.position.z }) ?? true)) continue;
      if (!best || footprint.cells.length > best.cells) best = { center, cells: footprint.cells.length, radius };
    }
  }
  return best;
}

/**
 * Name the reason `selectGrowableFrontageFootprint` produced nothing, reading
 * the same census and the same protections the caller passed it. The ladder is
 * ordered by what would have to change for the answer to be different, so the
 * first step that fails is the finding.
 */
export function classifyGrowableFrontageAbsence(input: {
  detail: SpatialSiteDetail;
  zoneCategory: GrowableZoneCategory;
  protections?: ReadonlyArray<{ ref: string; scope: CircleScope }>;
  isOwned?: (point: SpatialPoint2) => boolean;
  maxCandidates?: number;
}): GrowableFrontageAbsenceReport {
  const frontageCells = growableFrontageCells(input.detail).length;
  if (frontageCells === 0) {
    return { reason: "MISSING_FRONTAGE", frontageCells, unprotectedFootprints: 0, ownedFootprints: 0 };
  }
  // The unprotected search is the same call the caller made, minus the claims,
  // so the two answers differ only by what the claims removed.
  const unprotected = selectGrowableFrontageFootprint({ detail: input.detail,
    zoneCategory: input.zoneCategory, maxCandidates: input.maxCandidates });
  if (unprotected.length === 0) {
    // Before calling this land unzoneable, ask whether a Road would make it
    // zoneable. The Fast Path seeds marquees from frontage cells only, so owned
    // free unzoned land with no road near it is land it cannot see — and that is
    // a frontage problem, which is the one thing a Road solves. Only when no
    // such land reaches the band either is the honest answer that a Road cannot
    // help.
    const missingFrontage = unfrontagedOwnedInBandFootprint({
      detail: input.detail, zoneCategory: input.zoneCategory, ...(input.isOwned ? { isOwned: input.isOwned } : {}),
    });
    if (missingFrontage) {
      return { reason: "MISSING_FRONTAGE", frontageCells, unprotectedFootprints: 0, ownedFootprints: 0,
        missingFrontage };
    }
    return { reason: "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT", frontageCells,
      unprotectedFootprints: 0, ownedFootprints: 0 };
  }
  // Ownership is a fact about every cell the marquee would recolor, not only
  // about its centre, so it is read the same way the caller read it.
  const owned = unprotected.filter((candidate) => {
    if (!input.isOwned) return true;
    const footprint = boundedZoningCellSetInNativeMarquee(input.detail, candidate.target,
      requestedZoneCategory(input.zoneCategory));
    return !!footprint && input.isOwned(candidate.target.center) &&
      footprint.cells.every((cell) => input.isOwned!({ x: cell.position.x, z: cell.position.z }));
  });
  if (owned.length === 0) {
    return { reason: "GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES", frontageCells,
      unprotectedFootprints: unprotected.length, ownedFootprints: 0 };
  }
  return { reason: "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION", frontageCells,
    unprotectedFootprints: unprotected.length, ownedFootprints: owned.length };
}

/**
 * What a whole census ring answered, collapsed into one report.
 *
 * Counts sum, because they are counts of ground the ring actually covered. The
 * reason is the one most anchors agreed on, tie-broken by the order of the
 * absence ladder — the ladder is already ordered by what would have to change
 * for the answer to be different, so its earlier rungs are the more specific
 * finding.
 */
export function mergeGrowableAbsenceReports(
  reports: readonly GrowableFrontageAbsenceReport[],
): GrowableFrontageAbsenceReport {
  if (reports.length === 0) {
    return { reason: "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT", frontageCells: 0, unprotectedFootprints: 0, ownedFootprints: 0 };
  }
  const ladder: readonly GrowableFrontageAbsence[] = [
    "MISSING_FRONTAGE",
    "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT",
    "GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES",
    "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION",
  ];
  const groups = new Map<GrowableFrontageAbsence, number>();
  for (const report of reports) groups.set(report.reason, (groups.get(report.reason) ?? 0) + 1);
  const reason = [...groups.entries()]
    .sort((left, right) => right[1] - left[1] || ladder.indexOf(left[0]) - ladder.indexOf(right[0]))[0]![0];
  return {
    reason,
    frontageCells: reports.reduce((sum, report) => sum + report.frontageCells, 0),
    unprotectedFootprints: reports.reduce((sum, report) => sum + report.unprotectedFootprints, 0),
    ownedFootprints: reports.reduce((sum, report) => sum + report.ownedFootprints, 0),
  };
}

/**
 * Identity for one disproved census ring.
 *
 * Derived from the anchors the search actually read, so the Mayor's own next
 * Road — which adds owned local road nodes and therefore changes the ring —
 * changes this key. That is what releases the park: a region parked because a
 * bounded search disproved it is reopened by the act of building into it, and no
 * other component has to remember to release it.
 */
export function growableSearchSubjectKey(
  anchors: readonly SpatialPoint2[],
  landUse: string,
  unprovenAnchors = 0,
): string {
  const ring = anchors
    .map((anchor) => `${anchor.x.toFixed(1)},${anchor.z.toFixed(1)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(`${landUse}:${unprovenAnchors}:${ring}`).digest("hex").slice(0, 16);
}

/** The centre of a census ring, for the target a refusal is reported against. */
export function ringCenter(anchors: readonly SpatialPoint2[]): SpatialPoint2 {
  if (anchors.length === 0) return { x: 0, z: 0 };
  return {
    x: anchors.reduce((sum, anchor) => sum + anchor.x, 0) / anchors.length,
    z: anchors.reduce((sum, anchor) => sum + anchor.z, 0) / anchors.length,
  };
}

/** A radius that encloses every anchor in the ring, including its census reach. */
export function ringRadius(anchors: readonly SpatialPoint2[], censusRadius: number): number {
  if (anchors.length === 0) return censusRadius;
  const center = ringCenter(anchors);
  return Math.max(...anchors.map((anchor) => Math.hypot(anchor.x - center.x, anchor.z - center.z))) + censusRadius;
}

/**
 * Stable identity for a proven-unserviceable growth target.
 *
 * Built from the target's own position and the local land facts that decide
 * whether it can be zoned — never from population, treasury, demand or utility
 * risk. A key containing those drifts every simulated tick, so a park keyed on
 * it releases on the next tick and the same dead target is retried forever.
 * This one moves only when the land does: a cell is zoned, a building appears,
 * a road is delivered, ownership changes, or an anchor's candidate set changes.
 */
export function growableTargetKey(target: { center: SpatialPoint2; radius: number }): string {
  return `${target.center.x.toFixed(1)},${target.center.z.toFixed(1)},${target.radius.toFixed(1)}`;
}

function hasContiguousZoningCells(cells: readonly SpatialZoningCell[]): boolean {
  if (cells.length === 0) return false;
  const visited = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const currentIndex = queue.shift()!;
    const current = cells[currentIndex]!;
    for (let index = 0; index < cells.length; index += 1) {
      if (visited.has(index)) continue;
      const candidate = cells[index]!;
      if (Math.hypot(candidate.position.x - current.position.x, candidate.position.z - current.position.z) <=
        MAX_CONTIGUOUS_ZONE_CELL_GAP_METERS) {
        visited.add(index);
        queue.push(index);
      }
    }
  }
  return visited.size === cells.length;
}

export function hasZoneableCellInNativeMarquee(detail: SpatialSiteDetail, target: CircleScope): boolean {
  // Deliberately a different question from `boundedZoningCellSetInNativeMarquee`
  // below, and both are needed. This one asks whether the reservation's marquee
  // touches free land at all — a square test, because the native marquee selects
  // by |dx| <= r and |dz| <= r and a rectangle's corners reach cells its
  // inscribed circle does not. The other asks whether the ZONING step could
  // actually take such a cell set, which seeds from a circle and then has to
  // authorize the whole square. A site can answer yes to this and no to that,
  // and that difference is exactly what the ranking below resolves.
  if (detail.zoningCells.length === 0) return false;
  return detail.zoningCells.some((cell) => cell.zoneCategory === "none" &&
    cell.visible && !cell.occupied && !cell.blocked && !cell.overridden &&
    Math.abs(cell.position.x - target.center.x) <= target.radius &&
    Math.abs(cell.position.z - target.center.z) <= target.radius);
}


const highway = (prefab: string) => /highway|motorway|expressway/i.test(prefab);

/**
 * Whether an observed road graph edge is a road this project may build from.
 *
 * The scan's `native` flag marks the MAP's own network, not the player's: the
 * roads this product itself delivered come back with `native: false` alongside a
 * live entity, real geometry, and the same prefab the unlocked road catalogue
 * offers. Requiring `native` therefore hid the entire delivered network from site
 * selection — every player node dropped out of the anchor classes, a
 * goal-directed search was left with a handful of anchors, and its remaining
 * candidates were then decided by buildability and reservation conflicts rather
 * than by where the city actually is.
 *
 * So an edge qualifies when it is map-native, or when it is a prefab the unlocked
 * road catalogue names. That catalogue is the authoritative statement of "a road
 * this project can build", so a waterway, railway or utility net — which appears
 * in neither — is still never an anchor. Callers that pass no catalogue keep the
 * previous map-native-only behaviour exactly.
 *
 * Exported because site selection is not the only question this answers. The
 * water/sewage access corridor asks the same thing — "where is the front of the
 * network this project may build from" — and answered it with `native` alone,
 * which pinned every corridor's start to the map's original roads while the
 * Mayor built hundreds of metres away from them. One rule, one place.
 */
export const buildableRoadEdge = (edge: { prefab: string; native: boolean }, availableRoadPrefabs?: readonly string[]): boolean =>
  !highway(edge.prefab) && !/seaway/i.test(edge.prefab) &&
  (edge.native || (availableRoadPrefabs?.includes(edge.prefab) ?? false));
const entityKey = (entity: { index: number; version: number }) => `${entity.index}:${entity.version}`;

export type Gate1StarterAnchorClass = "OWNED_LOCAL_ROAD_TOPOLOGY" | "OWNED_START_CONNECTION_TOPOLOGY";

/**
 * Owned, native, NON-highway road frontage — the preferred starter anchor class.
 *
 * These are the only nodes the policy treats as local frontage, so they are
 * always evaluated first.
 */
export function selectLocalStarterSiteAnchors(
  world: SpatialWorldModel,
  maxAnchors = 48,
  availableRoadPrefabs?: readonly string[],
): Gate1StarterSiteAnchor[] {
  const limit = Math.max(1, Math.min(48, maxAnchors));
  const edgesByNode = new Map<string, SpatialWorldModel["roadGraph"]["edges"]>();
  for (const edge of world.roadGraph.edges) {
    if (!buildableRoadEdge(edge, availableRoadPrefabs)) continue;
    for (const ref of [edge.startNode, edge.endNode]) {
      const list = edgesByNode.get(entityKey(ref)) ?? [];
      list.push(edge);
      edgesByNode.set(entityKey(ref), list);
    }
  }
  const localRoadAnchors = world.roadGraph.nodes
    .filter((node) => edgesByNode.has(entityKey(node.entity)) &&
      world.ownedTiles.some((tile) => tile.owned && pointInTile({ x: node.position.x, z: node.position.z }, tile)))
    .map((node): Gate1StarterSiteAnchor | null => {
      const sourceEdges = (edgesByNode.get(entityKey(node.entity)) ?? []).sort((a, b) => a.entity.index - b.entity.index);
      const edge = sourceEdges[0];
      if (!edge) return null;
      const atStart = entityKey(edge.startNode) === entityKey(node.entity);
      const other = atStart ? edge.end : edge.start;
      const dx = other.x - node.position.x;
      const dz = other.z - node.position.z;
      const length = Math.hypot(dx, dz);
      if (length <= 0) return null;
      return { node, sourceEdges, direction: { x: dx / length, z: dz / length }, derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" };
    })
    .filter((value): value is Gate1StarterSiteAnchor => value !== null)
    .sort((a, b) => a.node.entity.index - b.node.entity.index || a.node.entity.version - b.node.entity.version);
  return localRoadAnchors.slice(0, limit);
}

/**
 * Goal-scoped projects search the full owned local-road topology. The starter
 * selector above intentionally limits itself to the original starter frontage
 * class; that omitted ordinary divided streets in other owned tiles, including
 * valid utility sites. Sample those tiles evenly so a service Goal can inspect
 * resource evidence without turning admission into an unbounded map sweep.
 */
export function selectGoalWorkOrderSiteAnchors(world: SpatialWorldModel, maxAnchors = 48,
  targetPoint?: SpatialPoint2, availableRoadPrefabs?: readonly string[]): Gate1StarterSiteAnchor[] {
  const limit = Math.max(1, Math.min(48, maxAnchors));
  const edgesByNode = new Map<string, SpatialWorldModel["roadGraph"]["edges"]>();
  for (const edge of world.roadGraph.edges) {
    if (!buildableRoadEdge(edge, availableRoadPrefabs)) continue;
    for (const ref of [edge.startNode, edge.endNode]) {
      const list = edgesByNode.get(entityKey(ref)) ?? [];
      list.push(edge);
      edgesByNode.set(entityKey(ref), list);
    }
  }
  const perTile = new Map<number, Array<{ anchor: Gate1StarterSiteAnchor; distanceToCenter: number; distanceToTarget: number }>>();
  for (const node of world.roadGraph.nodes) {
    if (!edgesByNode.has(entityKey(node.entity))) continue;
    const tileIndex = world.ownedTiles.findIndex((tile) => tile.owned &&
      pointInTile({ x: node.position.x, z: node.position.z }, tile));
    if (tileIndex < 0) continue;
    const sourceEdges = (edgesByNode.get(entityKey(node.entity)) ?? [])
      .sort((a, b) => a.entity.index - b.entity.index || a.entity.version - b.entity.version);
    const edge = sourceEdges[0];
    if (!edge) continue;
    const atStart = entityKey(edge.startNode) === entityKey(node.entity);
    const other = atStart ? edge.end : edge.start;
    const dx = other.x - node.position.x;
    const dz = other.z - node.position.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length <= 0) continue;
    const tile = world.ownedTiles[tileIndex];
    const center = tile.center;
    const distanceToCenter = center ? distance({ x: node.position.x, z: node.position.z }, center) : 0;
    const anchors = perTile.get(tileIndex) ?? [];
    anchors.push({ anchor: { node, sourceEdges, direction: { x: dx / length, z: dz / length },
      derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" }, distanceToCenter,
      distanceToTarget: targetPoint ? distance({ x: node.position.x, z: node.position.z }, targetPoint) : 0 });
    perTile.set(tileIndex, anchors);
  }
  for (const anchors of perTile.values()) {
    anchors.sort((a, b) => targetPoint
      ? a.distanceToTarget - b.distanceToTarget || a.distanceToCenter - b.distanceToCenter ||
        a.anchor.node.entity.index - b.anchor.node.entity.index || a.anchor.node.entity.version - b.anchor.node.entity.version
      : a.distanceToCenter - b.distanceToCenter ||
      a.anchor.node.entity.index - b.anchor.node.entity.index || a.anchor.node.entity.version - b.anchor.node.entity.version);
  }
  const selected: Gate1StarterSiteAnchor[] = [];
  const tileIndexes = [...perTile.keys()].sort((a, b) => {
    if (targetPoint) {
      const left = perTile.get(a)?.[0]?.distanceToTarget ?? Number.POSITIVE_INFINITY;
      const right = perTile.get(b)?.[0]?.distanceToTarget ?? Number.POSITIVE_INFINITY;
      return left - right || a - b;
    }
    return a - b;
  });
  for (let rank = 0; selected.length < limit; rank += 1) {
    let added = false;
    for (const tileIndex of tileIndexes) {
      const anchor = perTile.get(tileIndex)?.[rank];
      if (!anchor) continue;
      selected.push(anchor.anchor);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

/**
 * Owned native map-highway ingress nodes — the bounded connection-seed class.
 *
 * A greenfield starter may own only the map's highway ingress. That network is
 * legal only as a bounded connection seed; it is never local frontage, never
 * ordinary site frontage, and no facility may be placed on it. It is reachable
 * only through the project-constraint escalation in `searchBoundedStarterSites`,
 * and the site it produces must still be reached by a NEW local road through the
 * existing bounded road resolver, admission, and reservation boundary.
 */
export function selectIngressStarterSiteAnchors(world: SpatialWorldModel, maxAnchors = 24): Gate1StarterSiteAnchor[] {
  const limit = Math.max(1, Math.min(24, maxAnchors));
  const nodeByKey = new Map(world.roadGraph.nodes.map((node) => [entityKey(node.entity), node]));
  const allEdgesByNode = new Map<string, SpatialWorldModel["roadGraph"]["edges"]>();
  for (const edge of world.roadGraph.edges) {
    if (!edge.native) continue;
    for (const ref of [edge.startNode, edge.endNode]) {
      const list = allEdgesByNode.get(entityKey(ref)) ?? [];
      list.push(edge);
      allEdgesByNode.set(entityKey(ref), list);
    }
  }
  const seenNodes = new Set<string>();
  const connectionAnchors: Gate1StarterSiteAnchor[] = [];
  for (const connection of world.connectionCandidates) {
    const nodeKey = entityKey(connection.node.entity);
    if (seenNodes.has(nodeKey)) continue;
    seenNodes.add(nodeKey);
    const node = nodeByKey.get(nodeKey);
    if (!node?.native || !owned({ x: node.position.x, z: node.position.z }, world.ownedTiles)) continue;
    const sourceEdges = (allEdgesByNode.get(nodeKey) ?? [])
      .filter((edge) => edge.native)
      .sort((a, b) => a.entity.index - b.entity.index || a.entity.version - b.entity.version);
    if (sourceEdges.length === 0 || (!node.outsideConnection && !sourceEdges.some((edge) => highway(edge.prefab)))) continue;
    const incoming = connection.incomingEdge
      ? sourceEdges.find((edge) => entityKey(edge.entity) === entityKey(connection.incomingEdge!))
      : undefined;
    const edge = incoming ?? sourceEdges[0];
    let direction: SpatialPoint2;
    if (finitePoint(connection.forward)) {
      // evaluateBoundedStarterSites rotates this tangent to obtain its first
      // lateral target; make that target equal the topology-ranked ingress direction.
      direction = { x: connection.forward.z, z: -connection.forward.x };
    } else {
      const atStart = entityKey(edge.startNode) === nodeKey;
      const other = atStart ? edge.end : edge.start;
      const dx = other.x - node.position.x;
      const dz = other.z - node.position.z;
      const length = Math.hypot(dx, dz);
      if (length <= 0) continue;
      direction = { x: dx / length, z: dz / length };
    }
    connectionAnchors.push({ node, sourceEdges, direction, derivation: "OWNED_START_CONNECTION_TOPOLOGY" });
    if (connectionAnchors.length === limit) break;
  }
  return connectionAnchors;
}

/**
 * Local frontage when the world has any, otherwise the ingress seed.
 *
 * This is the pre-existing composite and it deliberately does NOT consult the
 * current project's constraints — callers that must escalate on project
 * constraints use `searchBoundedStarterSites` instead.
 */
export function selectBoundedStarterSiteAnchors(world: SpatialWorldModel, maxAnchors = 48): Gate1StarterSiteAnchor[] {
  const local = selectLocalStarterSiteAnchors(world, maxAnchors);
  return local.length > 0 ? local : selectIngressStarterSiteAnchors(world, maxAnchors);
}

/**
 * A directed target the network already reaches directs nothing.
 *
 * "Advance toward the target" is measured against the network's own reach, so a target that sits ON the network
 * (a standalone Road Goal aims at the previous road's terminal) leaves a reach of ~0 m and no step can ever be
 * closer. Measured live (2026-10-02): every one of 860 candidates was rejected `TARGET_NOT_ADVANCED`, the road
 * Goal that opens new frontage never produced a site, and the Mayor sat idle on a fully built island.
 */
export const REACHED_TARGET_METERS = 12;
export function dropReachedTarget<T extends { anchors: ReadonlyArray<Gate1StarterSiteAnchor>; targetPoint?: SpatialPoint2 }>(
  input: T,
): T {
  const target = input.targetPoint;
  if (!target) return input;
  const reach = input.anchors
    .filter((anchor) => anchor.sourceEdges.length > 0)
    .reduce((nearest, anchor) => Math.min(nearest, distance({ x: anchor.node.position.x, z: anchor.node.position.z }, target)),
      Number.POSITIVE_INFINITY);
  if (reach > REACHED_TARGET_METERS) return input;
  const { targetPoint: _reached, ...undirected } = input;
  return undirected as T;
}

export function evaluateBoundedStarterSites(rawInput: {
  world: SpatialWorldModel;
  /** Activated authoritative epoch; omitted only for pure fixtures that must remain fail-closed at Admission. */
  worldEpoch?: string;
  /** Raw generation from the same activated authoritative world, for Bridge endpoint bindings. */
  bridgeGeneration?: string;
  availableRoadPrefabs?: ReadonlyArray<string>;
  anchors: ReadonlyArray<Gate1StarterSiteAnchor>;
  details: ReadonlyArray<{ anchor: SpatialPoint2; detail: SpatialSiteDetail }>;
  protections?: ReadonlyArray<{ ref: string; scope: CircleScope }>;
  replayTarget?: CircleScope;
  /** Prefer legal tranche sites that advance a prerequisite toward this point. */
  targetPoint?: SpatialPoint2;
  /** Admit a Road-only scope whose mutations use the generic Road executor. */
  allowGenericRoadFallback?: boolean;
  /**
   * The target is a grid-frame REFERENCE (a standalone Road Goal's previous terminal or grid origin), not a
   * destination: it orders the anchors but no step is required to get closer to it. Measured live (2026-10-02):
   * 849 of 849 island candidates were refused `TARGET_NOT_ADVANCED` against a reference point in the main city.
   */
  targetIsReferenceOnly?: boolean;
  /** Keep bounded alternatives available until authoritative native preview accepts one. */
  roadDelivery?: boolean;
  maxCandidates?: number;
}): Gate1BoundedSiteSelectionResult {
  const input = dropReachedTarget(rawInput);
  const rejections = emptyRejections();
  const candidates: Gate1BoundedSiteCandidate[] = [];
  const maxCandidates = Math.max(1, Math.min(8, input.maxCandidates ?? 4));
  // ONE-STEP BOUNDED CANDIDATES ONLY — not a corridor's segments.
  //
  // This bar belongs to the legacy bounded single-step primitive
  // (`resolveBoundedRoadCandidates`), and it exists because that primitive has no
  // cost over the whole route: it can only ask "is this step legal", so it went
  // away from its target as often as toward it. A long-distance corridor is the
  // opposite — `planRoadCorridor` is A* whose whole point is that a leg may
  // sidestep or briefly recede from the target to clear terrain, water or an
  // existing road, and its progress is stated at ROUTE level (`remaining`,
  // bounded by `maximumDetourRatio`). Applying a per-segment "must be closer than
  // the frontier" rule to compiled corridor segments would forbid exactly the
  // detour that makes the corridor reachable, and would re-impose the limit P4
  // was written to remove. So a corridor's own status and `remaining` are the
  // authority for its progress; this guard is only for candidates that come from
  // the bounded primitive with no corridor plan behind them.
  //
  // A directed step has to beat the network's reach, not merely its own anchor.
  //
  // The per-anchor guard below was satisfiable from an anchor hundreds of metres
  // away — a point 690 m out "advances" from an anchor 700 m out — so a
  // prerequisite could be admitted anywhere along the direction and spend a real
  // road there. Measured live 2026-10-01: three ROAD_FRONTAGE prerequisites for
  // one target at (-516.8,-166.1) were admitted 265 m, 274 m and 710 m away, all
  // three built real roads, and the frontage census at the anchor went 7 -> 7,
  // 18 -> 19, 7 -> 7. The target never gained frontage, so the parent Goal
  // re-derived and minted another prerequisite. A step that does not close the
  // distance is not progress toward the target; it is construction somewhere
  // else, and the honest answer is to admit nothing and let the prerequisite
  // fail closed.
  //
  // Only anchors with a source edge are the network's reach. A node with no road
  // edge is not somewhere a road can be built from — it is a place the search
  // happens to look at — and counting it would let an unreachable point define
  // the frontier and veto the one site that could actually advance.
  const networkFrontierDistance = input.targetPoint
    ? input.anchors
        .filter((anchor) => anchor.sourceEdges.length > 0)
        .reduce((nearest, anchor) =>
          Math.min(nearest, distance({ x: anchor.node.position.x, z: anchor.node.position.z }, input.targetPoint!)),
          Number.POSITIVE_INFINITY)
    : undefined;
  for (const anchor of input.anchors) {
    const detailEntry = input.details.find((entry) => entry.anchor.x === anchor.node.position.x && entry.anchor.z === anchor.node.position.z);
    if (!detailEntry) { rejections.OTHER += 1; continue; }
    const detail = detailEntry.detail;
    const localScope = { center: detail.center, radius: detail.radius };
    const normal = { x: -anchor.direction.z, z: anchor.direction.x };
    // The near offsets come first on purpose: a site must overlap the road it
    // fronts for its reservation to contain any zoneable cell at all. An offset
    // larger than the reservation radius puts that road outside the reservation,
    // so the tranche pays for its road and then has nothing to zone.
    const targetPoints = input.replayTarget ? [{ ...input.replayTarget.center }] : [0, 8, 16, 24, 32, 48, 64].flatMap((offset) => [1, -1].map((side) => ({
      x: anchor.node.position.x + normal.x * offset * side,
      z: anchor.node.position.z + normal.z * offset * side,
    })));
    if (input.targetPoint) {
      const dx = input.targetPoint.x - anchor.node.position.x;
      const dz = input.targetPoint.z - anchor.node.position.z;
      const length = Math.hypot(dx, dz);
      if (length > 0) for (const offset of TARGET_DIRECTED_OFFSETS_METERS) targetPoints.push({
        x: anchor.node.position.x + dx / length * offset,
        z: anchor.node.position.z + dz / length * offset,
      });
    }
    targetPoints.sort((a, b) => input.targetPoint
      ? distance(a, input.targetPoint) - distance(b, input.targetPoint)
      : 0);
    let accepted: Gate1BoundedSiteCandidate | null = null;
    // The tiers below this one, kept separately rather than merged: a site the
    // zoning step can actually take must outrank one that merely has frontage,
    // and that must outrank one with neither. Ordered fallbacks, not a score.
    let acceptedFrontageOnly: Gate1BoundedSiteCandidate | null = null;
    let acceptedWithoutFrontage: Gate1BoundedSiteCandidate | null = null;
    // How close a candidate must come to the target to count as being on the way
    // to it.
    //
    // A Road-only scope — the `ROAD_FRONTAGE` prerequisite — exists to serve ONE
    // piece of ground, so for it the bar is the whole network's reach: a step
    // that leaves the frontier no closer has not served the target and must not
    // be admitted (see `networkFrontierDistance`).
    //
    // Every other Goal is a site search, not a directed delivery. There a site
    // the project can actually zone legitimately outranks a nearer one it cannot,
    // so the original per-anchor bar stands unchanged.
    const advanceLimit = input.targetPoint && !input.targetIsReferenceOnly
      ? (input.roadDelivery && networkFrontierDistance !== undefined
          ? networkFrontierDistance
          : distance({ x: anchor.node.position.x, z: anchor.node.position.z }, input.targetPoint))
      : undefined;
    for (const point of targetPoints) {
      if (advanceLimit !== undefined && distance(point, input.targetPoint!) >= advanceLimit) {
        rejections.TARGET_NOT_ADVANCED += 1;
        continue;
      }
      const target = input.replayTarget ?? { center: point, radius: STARTER_SITE_TARGET_RADIUS_METERS };
      // Two different facts, two counters. This used to be one `||` reported as
      // `NOT_OWNED`, which made the histogram unable to answer "is the land ours":
      // "outside this anchor's observation circle" and "not in our owned tiles"
      // are independent, and only the second is about ownership.
      //
      // The observation circle is checked first because it is the tighter, more
      // local gate — a point the anchor never observed is not a claim about
      // ownership at all — so a point failing both counts against the scope
      // constraint, which is the constraint whose worth is being measured.
      if (!pointWithinCircleScope(point, localScope)) { rejections.OUTSIDE_ANCHOR_OBSERVATION += 1; continue; }
      if (!owned(point, input.world.ownedTiles)) { rejections.NOT_OWNED += 1; continue; }
      const terrainCell = terrainIndex(detail, point);
      if (terrainCell === null || detail.terrain.heights[terrainCell] === undefined) { rejections.TERRAIN += 1; continue; }
      if ((detail.terrain.waterDepths[terrainCell] ?? 0) > 0.05) { rejections.WATER += 1; continue; }
      if (hasBuildingConflict(detail, target)) { rejections.NOT_BUILDABLE += 1; continue; }
      if (input.protections?.some((protection) => distance(protection.scope.center, point) < protection.scope.radius + target.radius)) { rejections.PROTECTION_RESERVATION += 1; continue; }
      // The site's access course is asked of the same grid family the Road step
      // builds from: "can a road reach this site" is answered with the courses
      // that would actually be submitted, axis-aligned, rather than with a
      // heading cone the world then refuses.
      const road = buildRoadGridCandidates({
        siteTarget: point,
        sourceEdges: input.world.roadGraph.edges,
        sourceNodes: input.world.roadGraph.nodes,
        ...(input.availableRoadPrefabs ? { availableRoadPrefabs: input.availableRoadPrefabs } : {}),
        worldEpoch: input.worldEpoch,
        bridgeGeneration: input.bridgeGeneration,
        maxSourceDistance: 150,
        ownedTiles: input.world.ownedTiles,
        terrain: detail.terrain,
        buildings: detail.buildings,
        ...(input.availableRoadPrefabs
          ? (() => {
              const preferred = anchor.sourceEdges[0]?.prefab ?? "Medium Road";
              return { prefab: selectAvailableStarterRoadPrefab({ availableRoadPrefabs: input.availableRoadPrefabs, preferred }) };
            })()
          : anchor.derivation === "OWNED_START_CONNECTION_TOPOLOGY" ? { prefab: "Medium Road" } : { prefab: "Medium Road" }),
      });
      // A reservation this project could not zone is a poorer site, not an
      // unusable one: the tranche would fail closed in its zoning step with no
      // cell to authorize after paying for the road. So the points on this anchor
      // are tiered — one the zoning step can actually take beats one that merely
      // has frontage, which beats one with neither — and the weakest tier is kept
      // only as a bounded fallback, so a search that has nothing better still
      // admits a site instead of stripping the Goal of every candidate.
      const carriesZoneableCells = hasZoneableCellInNativeMarquee(detail, target);
      if (!carriesZoneableCells) rejections.ZONEABLE_FRONTAGE += 1;
      const carriesFrontage = carriesZoneableCells &&
        boundedZoningCellSetInNativeMarquee(detail, target) !== null;
      const carriesZoningFootprint = carriesFrontage;
      if (road.length === 0) {
        rejections.NO_ROUTE += 1;
        if (!input.allowGenericRoadFallback || !input.targetPoint) continue;
        const corridor: Gate1BoundedSiteCandidate = {
          id: `gate1-road-corridor-${anchor.node.entity.index}:${anchor.node.entity.version}:${point.x.toFixed(3)}:${point.z.toFixed(3)}`,
          target,
          // A site with no road at all is a last resort, not a competitor. It
          // sits in its own lower tier so that EVERY reachable candidate beats
          // it — including one that is farther from the target. Scoring both
          // families on raw distance to the target let an unreachable site
          // outrank a reachable one by two orders of magnitude, which is how a
          // target-directed corridor kept choosing the one site it could not
          // build and then failing at the native boundary.
          score: UNREACHABLE_SITE_TIER + 100_000 - distance(point, input.targetPoint) * 100,
          blocked: false,
          direction: anchor.direction,
          roadCandidates: [],
          evidence: { sourceAnchor: { x: anchor.node.position.x, z: anchor.node.position.z }, openResidentialCells: detail.zoningCells.length,
            owned: true, buildable: true, access: "TARGET_DIRECTED_ROAD_FALLBACK", frontage: carriesFrontage,
            zoningFootprint: carriesZoningFootprint },
        };
        if (carriesZoningFootprint) { accepted = corridor; break; }
        if (carriesZoneableCells) { acceptedFrontageOnly ??= corridor; continue; }
        acceptedWithoutFrontage ??= corridor;
        continue;
      }
      const reachable: Gate1BoundedSiteCandidate = {
        id: `gate1-site-${anchor.node.entity.index}:${anchor.node.entity.version}:${point.x.toFixed(3)}:${point.z.toFixed(3)}`,
        target,
        score: input.targetPoint
          ? REACHABLE_SITE_TIER + 100_000 - distance(point, input.targetPoint) * 100 - road[0].finalSegmentLength
          : 10_000 - distance(point, { x: anchor.node.position.x, z: anchor.node.position.z }) - road[0].finalSegmentLength,
        blocked: false,
        direction: anchor.direction,
        roadCandidates: road,
        evidence: { sourceAnchor: { x: anchor.node.position.x, z: anchor.node.position.z }, openResidentialCells: detail.zoningCells.length, owned: true, buildable: true, access: "BOUNDED_ROAD_FEASIBLE", frontage: carriesFrontage,
          zoningFootprint: carriesZoningFootprint },
      };
      if (input.roadDelivery) {
        candidates.push(reachable);
        continue;
      }
      if (carriesZoningFootprint) { accepted = reachable; break; }
      if (carriesZoneableCells) { acceptedFrontageOnly ??= reachable; continue; }
      acceptedWithoutFrontage ??= reachable;
    }
    const selected = accepted ?? acceptedFrontageOnly ?? acceptedWithoutFrontage;
    if (selected) candidates.push(selected);
    // During replay every anchor is testing the same persisted reservation.
    // Prefer the nearest authoritative anchor that still satisfies the exact
    // current geometry constraints, and keep this a single deterministic match.
    if (input.replayTarget && candidates.length > 0) break;
  }
  // Whether the zoning step can take the land is a ranking key, not a score
  // term. Preferring it inside one anchor was not enough: a reservation carrying
  // no zoneable land is a site this project pays a road for and then cannot use,
  // and letting it win on distance against an anchor that DOES carry zoneable
  // land is how a tranche ends its Road at ROAD_DELIVERED with nothing to zone.
  // The marquee verdict ranks above frontage because it is the strictly stronger
  // fact, and candidates that fail both stay in the list, under every candidate
  // that passes either, so a world that offers nothing better still admits its
  // best remaining site.
  candidates.sort((a, b) => (input.roadDelivery
    ? Number(b.roadCandidates[0]?.family === "ORTHOGONAL_GRID") - Number(a.roadCandidates[0]?.family === "ORTHOGONAL_GRID") ||
      b.score - a.score || a.id.localeCompare(b.id)
    : Number(b.evidence.zoningFootprint === true) - Number(a.evidence.zoningFootprint === true) ||
      Number(b.evidence.frontage === true) - Number(a.evidence.frontage === true) ||
      b.score - a.score || a.id.localeCompare(b.id)));
  return { candidates: candidates.slice(0, maxCandidates), rejections, inspectedRegions: input.details.length };
}

export function selectBoundedGate1Sites(input: Gate1BoundedSiteSelectionInput): Gate1BoundedSiteSelectionResult {
  const anchors = selectBoundedStarterSiteAnchors(input.world, input.details.length);
  const scopedAnchors = input.projectScope ? anchors.filter((anchor) => pointWithinCircleScope({ x: anchor.node.position.x, z: anchor.node.position.z }, input.projectScope!)) : anchors;
  const result = evaluateBoundedStarterSites({ world: input.world, anchors: scopedAnchors, details: input.details, protections: input.protections, maxCandidates: input.maxCandidates, availableRoadPrefabs: input.availableRoadPrefabs });
  if (input.projectScope) result.rejections.OUTSIDE_PROJECT_SCOPE += anchors.length - scopedAnchors.length;
  return result;
}

/** One anchor class's bounded observation of the world. */
export interface Gate1StarterSiteClassReport {
  anchors: number;
  observations: number;
  candidates: number;
  /** Candidates the current project's constraint admitted. */
  accepted: number;
}

export type Gate1StarterSiteFallbackReason =
  /** The world owns no local non-highway frontage at all. */
  | "NO_LOCAL_ANCHOR"
  /** Local frontage exists but no local site satisfies the current project. */
  | "NO_LOCAL_CANDIDATE_SATISFIES_PROJECT_CONSTRAINT";

export interface Gate1StarterSiteSearchInput {
  world: SpatialWorldModel;
  worldEpoch?: string;
  bridgeGeneration?: string;
  availableRoadPrefabs?: ReadonlyArray<string>;
  protections?: ReadonlyArray<{ ref: string; scope: CircleScope }>;
  /** Optional deterministic target for a prerequisite corridor work order. */
  targetPoint?: SpatialPoint2;
  /** Road prerequisite scopes can defer route construction to the shared provider. */
  allowGenericRoadFallback?: boolean;
  /** `targetPoint` only orders anchors; no candidate has to advance toward it. */
  targetIsReferenceOnly?: boolean;
  /** Keep alternate bounded Road candidates until native preview accepts one. */
  roadDelivery?: boolean;
  maxCandidates?: number;
  /** Full owned-road sampling for a later Goal; omitted for initial starter admission. */
  goalWorkOrderAnchors?: ReadonlyArray<Gate1StarterSiteAnchor>;
  /** Skip the starter-only ingress fallback when goal anchors already cover owned roads. */
  includeIngressFallback?: boolean;
  maxAnchors?: number;
  /**
   * Bounded per-anchor detail capture. A null detail or UNKNOWN coherence means
   * that anchor is not evidence and is skipped rather than substituted.
   */
  captureDetail(
    anchor: Gate1StarterSiteAnchor,
    signal?: AbortSignal,
  ): Promise<{ detail: SpatialSiteDetail | null; coherence: string }>;
  /**
   * The CURRENT PROJECT's own requirement on a candidate site.
   *
   * Absent means every candidate the evaluator produces satisfies it, which is
   * the pre-existing behaviour: the local class wins whenever it yields anything,
   * and the ingress seed is used only when the world owns no local frontage.
   */
  accepts?(candidate: Gate1BoundedSiteCandidate, signal?: AbortSignal): Promise<boolean>;
  /** Re-evaluate this exact persisted scope instead of regenerating a nearby offset. */
  replayTarget?: CircleScope;
  signal?: AbortSignal;
}

export interface Gate1StarterSiteSearchResult {
  /** Which anchor class produced `selection`. */
  anchorClass: Gate1StarterAnchorClass;
  /** Why the ingress seed was used; null when the local class was used. */
  fallbackReason: Gate1StarterSiteFallbackReason | null;
  selection: Gate1BoundedSiteSelectionResult;
  local: Gate1StarterSiteClassReport;
  /** Present only when the ingress class was actually evaluated. */
  ingress: Gate1StarterSiteClassReport | null;
}

/**
 * Bounded starter-site search with project-constraint escalation.
 *
 * The anchor policy is conservative on purpose: local non-highway frontage is
 * evaluated first and wins outright whenever it yields a candidate that
 * satisfies the current project. The owned map-highway ingress class is a
 * FALLBACK, entered only when local frontage cannot produce such a site — either
 * because the world owns none, or because every local candidate fails the
 * current project's own constraint. Ingress is never a peer competitor to local
 * frontage, and whatever it produces still has to clear the same bounded road
 * resolver, admission and reservation boundary as any other starter site.
 *
 * When `accepts` is absent this is exactly the pre-existing composite: local
 * anchors when the world has them, ingress only when it does not.
 */
export async function searchBoundedStarterSites(
  input: Gate1StarterSiteSearchInput,
): Promise<Gate1StarterSiteSearchResult> {
  const maxAnchors = input.maxAnchors ?? 24;
  const evaluateClass = async (
    anchors: Gate1StarterSiteAnchor[],
    replayTarget?: CircleScope,
  ): Promise<{ report: Gate1StarterSiteClassReport; selection: Gate1BoundedSiteSelectionResult }> => {
    const details: Array<{ anchor: SpatialPoint2; detail: SpatialSiteDetail }> = [];
    for (const anchor of anchors) {
      const captured = await input.captureDetail(anchor, input.signal);
      if (captured.coherence === "UNKNOWN" || captured.detail === null) continue;
      details.push({ anchor: { x: anchor.node.position.x, z: anchor.node.position.z }, detail: captured.detail });
    }
    const observedAnchors = anchors.filter((anchor) =>
      details.some((entry) => entry.anchor.x === anchor.node.position.x && entry.anchor.z === anchor.node.position.z),
    );
    const orderedAnchors = replayTarget
      ? [...observedAnchors].sort((left, right) =>
        distance({ x: left.node.position.x, z: left.node.position.z }, replayTarget.center) -
        distance({ x: right.node.position.x, z: right.node.position.z }, replayTarget.center) ||
        left.node.entity.index - right.node.entity.index || left.node.entity.version - right.node.entity.version)
      : observedAnchors;
    const evaluated = evaluateBoundedStarterSites({
      world: input.world,
      worldEpoch: input.worldEpoch,
      bridgeGeneration: input.bridgeGeneration,
      availableRoadPrefabs: input.availableRoadPrefabs,
      anchors: orderedAnchors,
      details,
      protections: input.protections,
      replayTarget,
      targetPoint: input.targetPoint,
      allowGenericRoadFallback: input.allowGenericRoadFallback,
      targetIsReferenceOnly: input.targetIsReferenceOnly,
      roadDelivery: input.roadDelivery,
      maxCandidates: replayTarget ? 1 : input.maxCandidates,
    });
    const accepted: Gate1BoundedSiteCandidate[] = [];
    for (const candidate of evaluated.candidates) {
      if (!input.accepts || (await input.accepts(candidate, input.signal))) accepted.push(candidate);
    }
    return {
      report: { anchors: anchors.length, observations: details.length, candidates: evaluated.candidates.length, accepted: accepted.length },
      selection: { ...evaluated, candidates: accepted },
    };
  };

  const localAnchors = input.goalWorkOrderAnchors
    ? [...input.goalWorkOrderAnchors]
    : selectLocalStarterSiteAnchors(input.world, maxAnchors, input.availableRoadPrefabs);
  const localReplayTarget = input.replayTarget && input.goalWorkOrderAnchors ? input.replayTarget : undefined;
  const local = await evaluateClass(localAnchors, localReplayTarget);
  if (local.report.accepted > 0) {
    return { anchorClass: "OWNED_LOCAL_ROAD_TOPOLOGY", fallbackReason: null, selection: local.selection, local: local.report, ingress: null };
  }

  const ingressAnchors = input.includeIngressFallback === false
    ? [] : selectIngressStarterSiteAnchors(input.world, maxAnchors);
  if (ingressAnchors.length === 0) {
    return { anchorClass: "OWNED_LOCAL_ROAD_TOPOLOGY", fallbackReason: null,
      selection: local.selection, local: local.report, ingress: null };
  }
  // Replay the exact persisted reservation only in the anchor class the
  // original deterministic search falls back to. Otherwise adding today's
  // exact center as a fresh local offset could change the originally admitted
  // ingress frontage/source class.
  const ingress = await evaluateClass(ingressAnchors, input.replayTarget);
  if (ingress.report.anchors === 0) {
    // Nothing to escalate to: report the local evaluation, so the caller's
    // "no eligible site" is the same failure it would have been without a
    // fallback at all.
    return { anchorClass: "OWNED_LOCAL_ROAD_TOPOLOGY", fallbackReason: null, selection: local.selection, local: local.report, ingress: null };
  }
  return {
    anchorClass: "OWNED_START_CONNECTION_TOPOLOGY",
    fallbackReason: localAnchors.length > 0 ? "NO_LOCAL_CANDIDATE_SATISFIES_PROJECT_CONSTRAINT" : "NO_LOCAL_ANCHOR",
    selection: ingress.selection,
    local: local.report,
    ingress: ingress.report,
  };
}
