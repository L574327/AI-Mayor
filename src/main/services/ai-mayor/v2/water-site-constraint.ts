import type {
  BootstrapSiteEvaluation,
  PlannedUtilityConnection,
  PlannedUtilityFacility,
  SpatialBootstrapAsset,
  SpatialPoint2,
  SpatialRoadEdge,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "../spatial/types";
import { MAX_UTILITY_SERVICE_ROAD_LENGTH, planBootstrapUtilities } from "../spatial/utility-planner";
import { ROAD_CORRIDOR_MAXIMUM_GRADE_PERCENT, planRoadCorridor } from "../spatial/road-corridor";
import { buildableRoadEdge } from "./site-selection";
import type { WaterFlowObservation } from "../spatial/water-flow";
import type { V2ProjectSiteConstraint } from "./project-admission";
import type { SewageIntakeCensus } from "./sewage-environmental-safety";
import { minimumFeasibleUtilityBudget, type UtilityPlanBudgetRequirement } from "./utility-budget";

/**
 * The bounded read the constraint issues per candidate: the authoritative
 * groundwater / terrain / road detail over the reservation the candidate would
 * create. A null result means the region was not observed and the candidate is
 * refused rather than assumed.
 */
export type WaterReservationRead = (
  point: SpatialPoint2,
  radius: number,
  signal?: AbortSignal,
  /**
   * Override the grid this read is taken at.
   *
   * The reservation read and a shoreline search want different grids from the
   * same square. A reservation is a region, so the admission policy's coarse
   * grid is right for it and cheap. A shoreline is a FEATURE: at the policy's
   * grid over a ~311 m tile the cells are ~39 m, and the strip where a land cell
   * has a water neighbour inside one cell simply is not there any more — every
   * tile then reports no legal shoreline at all, which is what the live world
   * showed. Omitted means the caller's policy resolution, so every existing
   * caller is unchanged.
   */
  resolution?: number,
) => Promise<SpatialSiteDetail | null>;

export interface WaterSiteConstraintEvidence {
  candidateId: string;
  accepted: boolean;
  /** Why the candidate was refused; null when it was accepted. */
  reason: string | null;
}

/** One concrete facility placement, in the shape the game's own preflight takes. */
export interface WaterFacilityPlacement {
  prefab: string;
  position: SpatialPoint2;
  rotation: number;
}

/**
 * The game's own verdict on one concrete facility placement.
 *
 * Where the groundwater is and where the station fits are two different facts.
 * The terrain read answers the first; nothing in it answers the second. The game
 * refuses a pumping station on ground the read calls dry, owned, flat and rich 鈥? * for reasons it does not itemize 鈥?so a plan built only on the read is a plan
 * that can be unexecutable while every planner filter passes.
 *
 * A probe that cannot be taken must throw. An unobserved placement is not a
 * refused one, and treating it as placeable would re-open exactly the gap this
 * port closes.
 */
export type WaterFacilityPlacementProbe = (
  placement: WaterFacilityPlacement,
  signal?: AbortSignal,
) => Promise<boolean>;

/**
 * What planning and pricing a water facility for a reservation needs.
 *
 * Deliberately narrower than `WaterSiteConstraintInput`: re-deriving the cost of
 * a plan that already exists is not an admission, so it takes no placement
 * probe. A caller asking "what does the current plan cost" must not have to
 * pretend it can also answer "may this plan be admitted".
 */
export interface WaterPlanInput {
  world: SpatialWorldModel;
  /** Bootstrap asset catalogue from the same authoritative scan as `world`. */
  assets: readonly SpatialBootstrapAsset[];
  /**
   * Which piped utility this constraint is for.
   *
   * Water and sewage are the two kinds whose source is a *place* rather than a
   * capacity, and they need the same admission gate: the reservation has to be
   * able to host a facility the execution planner will actually plan and the
   * game will actually accept. Sewage was admitted with no such gate, so a
   * reservation whose observed terrain contains no shoreline at all could be
   * reserved for a sewage Goal, and every K05 attempt inside it was guaranteed
   * to fail.
   *
   * Sewage differs in what the reservation must contain, not in whether it must
   * contain anything, so both kinds run through this one constraint and this one
   * planner call. Defaults to water, so every existing caller is unchanged.
   */
  utilityKind?: "water" | "sewage";
  /**
   * The roads this admission may plan a service road against. Must be the
   * authoritative set for the admission scope 鈥?for a project that does not
   * exist yet that is the whole current-world road set, exactly what
   * `scopeRoadAuthority` returns for empty `certifiedRoadRefs`.
   */
  roads: readonly SpatialRoadEdge[];
  /**
   * The unlocked road catalogue, so "a road this project may build from" is
   * answered the same way site selection answers it.
   *
   * The scan's `native` flag marks the MAP's own network, not the player's: every
   * road this product delivered comes back `native: false` with a live entity, a
   * real prefab, and the same prefab the catalogue names. Measuring the road
   * front against `native` alone therefore pinned the corridor's start to the
   * map's original roads for the whole run — the plan was re-derived from the
   * same point every pass, its first hop landed on the same ground every pass,
   * and once the Road step had built that hop the directed course it was handed
   * collapsed to zero length and the bounded heading family took over. Measured
   * live: the certified outfall read `668.5m` from the road graph with 247
   * delivered edges standing between the two.
   *
   * Omitted, the previous map-native-only behaviour is kept exactly, so callers
   * that never had a catalogue are unchanged.
   */
  availableRoadPrefabs?: readonly string[];
  /**
   * The bounded terrain read for a candidate at a given reservation radius.
   *
   * The radius is passed in because admission searches over it: the reservation
   * that can host a source is not always the policy's base radius, and this
   * constraint is what decides which radii can. The read must cover the SQUARE of
   * half-width `radius`, exactly as the execution path reads it.
   */
  readReservation: WaterReservationRead;
  /**
   * The existing native spending contract's quote for one connection primitive.
   *
   * The plan carries the connection's prefab and endpoints but no cost 鈥?nothing
   * in the spatial catalogue prices a net 鈥?so the only authoritative figure is
   * the one the same native preflight that guards the execution would return.
   * Asking that contract here, rather than pricing the pipe in this module, is
   * what keeps admission's budget and execution's refusal limit the same number.
   *
   * A quote that cannot be obtained must throw. An unquoted connection is not a
   * free one, and a requirement built on a guess would authorize a spend the
   * native boundary would later refuse.
   */
  quoteConnectionCost(connection: PlannedUtilityConnection, signal?: AbortSignal): Promise<number>;
  /**
   * The observations the sewage recipe's applicability is judged against.
   *
   * For a sewage reservation this is the whole point of the gate: the planner
   * would otherwise accept any low-slope shoreline inside the reservation, and a
   * shoreline is not a discharge path. Supplied, only a site whose discharge the
   * criterion could certify is admitted. Omitted for water, whose own source
   * filter is its applicability condition and needs no second one.
   */
  sewageEnvironmentalSafety?: {
    observation: WaterFlowObservation;
    intakeCensus: SewageIntakeCensus;
  };
  onEvaluated?(evidence: WaterSiteConstraintEvidence): void;
  /**
   * Per-candidate diagnostics for the bounded sewage outfall search.
   *
   * The search walks owned tiles and hands each one to the ordinary planner and
   * the ordinary certified criterion. When it finds nothing, the only thing that
   * can be honestly reported is *which predicate refused*, per tile — otherwise
   * "no corridor" is indistinguishable from "the world has no shoreline" and the
   * next reader has to guess. Purely observational: nothing here feeds back into
   * the decision.
   */
  onSewageOutfallCandidate?(evidence: SewageOutfallCandidateEvidence): void;
}

/** What one owned tile produced, and at which predicate it stopped. */
export interface SewageOutfallCandidateEvidence {
  tileIndex: number;
  center: SpatialPoint2;
  radius: number;
  /** The predicate this tile stopped at, or `ACCEPTED` when it became a candidate. */
  disposition:
    | "ACCEPTED"
    | "TILE_GEOMETRY_INVALID"
    | "RESERVATION_READ_FAILED"
    | "RESERVATION_NOT_OBSERVED"
    | "PLAN_REFUSED"
    | "PLAN_KIND_MISMATCH"
    | "ROAD_ALREADY_REACHES_SITE";
  /** The planner's or criterion's own message when a predicate refused. */
  reason?: string;
  facilityPosition?: SpatialPoint2;
  roadDistance?: number;
  /** The whole path, so a reader can see how far each tile got. */
  reached: {
    siteLegality: boolean;
    buildability: boolean;
    route: boolean;
    environmentalCertification: boolean;
    completeProposal: boolean;
  };
}

/**
 * How far one corridor hop advances, and how many hops one plan may contain.
 *
 * Both bounded, and both deliberately modest: the hop is what the Road step is
 * asked to commit, so it has to be a length the bounded heading family can
 * actually produce on real ground, and the step budget is what keeps a target no
 * corridor can reach from becoming an unbounded search.
 */
export const SEWAGE_OUTFALL_CORRIDOR_STEP_METERS = 150;
export const MAXIMUM_SEWAGE_OUTFALL_CORRIDOR_STEPS = 16;

/**
 * Bounds on the corridor route search.
 *
 * Every one is a hard ceiling, and reaching any of them ends the search with a
 * named reason rather than letting it run: the route may be at most 2.5x the
 * straight line, expand at most this many cells, and read at most this much
 * world. Ground reads are cached per ~25 m cell, so the read budget counts
 * distinct places the search looked, not how often it looked.
 */
export const MAXIMUM_CORRIDOR_GROUND_READS = 24;
export const MAXIMUM_CORRIDOR_EXPANDED_CELLS = 20_000;
/** Cells the search may inspect, all answered from the read mosaic. */
export const MAXIMUM_CORRIDOR_SAMPLED_CELLS = 20_000;
export const MAXIMUM_CORRIDOR_DETOUR_RATIO = 2.5;
const CORRIDOR_READ_CELL_METERS = 25;
const CORRIDOR_READ_RADIUS_METERS = 400;
const CORRIDOR_READ_RESOLUTION = 64;

/** One bounded authoritative ground read along the corridor, or null. */
async function readCorridorGround(
  input: WaterPlanInput,
  point: SpatialPoint2,
): Promise<SpatialSiteDetail | null> {
  try {
    return await input.readReservation(point, CORRIDOR_READ_RADIUS_METERS, undefined, CORRIDOR_READ_RESOLUTION);
  } catch {
    return null;
  }
}

/**
 * What one bounded read says about a position.
 *
 * `null` is "not observed" and is never read as buildable — the corridor is only
 * ever planned across ground somebody actually looked at.
 */
function readCorridorGroundFrom(
  detail: SpatialSiteDetail | null,
  point: SpatialPoint2,
): { height: number; waterDepth: number; gradePercent: number } | null {
  if (!detail) return null;
  const { resolution, bounds, cellSize } = detail.terrain;
  if (!(resolution > 0) || !(cellSize.x > 0) || !(cellSize.z > 0)) return null;
  if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) return null;
  const col = Math.min(resolution - 1, Math.max(0, Math.floor((point.x - bounds.minX) / cellSize.x)));
  const row = Math.min(resolution - 1, Math.max(0, Math.floor((point.z - bounds.minZ) / cellSize.z)));
  const index = row * resolution + col;
  const height = detail.terrain.heights[index];
  if (!Number.isFinite(height)) return null;
  // The worst gradient to an orthogonal neighbour, which is what a road crosses.
  const neighbours = [
    col > 0 ? index - 1 : -1,
    col + 1 < resolution ? index + 1 : -1,
    row > 0 ? index - resolution : -1,
    row + 1 < resolution ? index + resolution : -1,
  ].filter((neighbour) => neighbour >= 0);
  const spacing = Math.min(cellSize.x, cellSize.z);
  const gradePercent = neighbours.reduce((worst, neighbour) => {
    const neighbourHeight = detail.terrain.heights[neighbour];
    if (!Number.isFinite(neighbourHeight)) return worst;
    return Math.max(worst, (Math.abs(height - neighbourHeight) / spacing) * 100);
  }, 0);
  return { height, waterDepth: detail.terrain.waterDepths[index] ?? 0, gradePercent };
}

/** How a tile that never reached a candidate is reported. */
const unreached = () => ({
  siteLegality: false, buildability: false, route: false,
  environmentalCertification: false, completeProposal: false,
});

/**
 * The admission-time input: a plan plus the game's verdict on whether it can be
 * built.
 *
 * The probe is required rather than optional on purpose. A constraint that
 * cannot observe placement is a constraint that admits on the planner's word
 * alone, and the planner's word is what the live world has already been shown to
 * be wrong about 鈥?a 200 m reservation full of clean dry groundwater where the
 * station fits nowhere. Omitting the port is therefore not a smaller constraint,
 * it is the unguarded one, so the type does not let it be omitted.
 */
export interface WaterSiteConstraintInput extends WaterPlanInput {
  /**
   * The game's verdict on a placement the plan proposes.
   *
   * Asked about the plan's OWN site at the rotations the plan would accept, and
   * no further: `planWaterFacility` already decided where the source goes, and a
   * station the game accepts somewhere else is not this plan being placeable.
   * The execution path's wider offset search is a runtime recovery on top of the
   * plan, not evidence that the plan itself can be built.
   */
  probePlacement: WaterFacilityPlacementProbe;
}

/**
 * The water domain's own site requirement, expressed as an admission constraint.
 *
 * A starter site is admissible for water only when BOTH hold inside the
 * reservation that site would create:
 *
 * 1. the production water planner can actually place a water source there, and
 * 2. the game accepts the source it proposed, at the place and rotation the plan
 *    would build it.
 *
 * The first predicate is NOT restated here: this calls the same
 * `planBootstrapUtilities(..., { utilityKind: "water" })` the execution path
 * calls, over the same bounded detail read, and requires it to return a water
 * facility.
 *
 * That matters because the planner is the only thing that knows the source
 * filter (`!locked && freshWaterCapacity > 0 && allowedWaterTypes ~ /ground/`)
 * and the road-distance window. A re-implementation here would be a second
 * source of truth for product semantics, and the two would drift.
 *
 * The second is not derivable from the first at any price. The planner reads
 * terrain, and the game refuses placements the terrain calls perfect 鈥?so a
 * reservation can satisfy every planner filter and still be a project that can
 * never be built, which is a project admission must not mint. `probePlacement`
 * is where that verdict is observed, and it is the ONLY thing here that reads
 * the game rather than the plan.
 *
 * The reservation radius is an argument, not a constant, because both answers
 * depend on it: a source 226 m from the candidate is out of reach from a 180 m
 * reservation and in reach from a 240 m one, and ground that refuses the station
 * at one envelope may accept it at a wider one. This constraint answers "can
 * water be served FROM THIS RESERVATION"; admission is what searches the radii
 * and reserves the smallest that works.
 *
 * Without this constraint admission prefers owned local frontage and never
 * considers the ingress seed, which is how the electricity slice stays
 * byte-identical: it supplies no constraint.
 */
export function createWaterSiteConstraint(input: WaterSiteConstraintInput): V2ProjectSiteConstraint {
  // The plan an accepted (candidate, radius) produced. Kept because the budget
  // question is asked about the SAME plan the acceptance was decided on, and
  // re-planning would be a second read of a world that has already been
  // observed 鈥?two answers to one question, which is how they drift.
  const acceptedPlans = new Map<string, PlannedUtilityFacility>();
  const planKey = (candidateId: string, radius: number) => `${candidateId}@${radius}`;
  /**
   * The nearest point of the network this project may build from, and how far it
   * is.
   *
   * This is the corridor's START and the "does the road already reach the site"
   * measure, so it has to be the front of the whole delivered network — the map's
   * roads and the product's own alike. See `availableRoadPrefabs` above for what
   * asking `native` alone did.
   */
  const nearestRoad = (point: SpatialPoint2, edges: readonly SpatialRoadEdge[]): { point: SpatialPoint2 | null; distance: number } => {
    let nearestPoint: SpatialPoint2 | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const edge of edges) {
      if (edge.deleted || edge.temp || !buildableRoadEdge(edge, input.availableRoadPrefabs)) continue;
      const dx = edge.end.x - edge.start.x;
      const dz = edge.end.z - edge.start.z;
      const lengthSquared = dx * dx + dz * dz;
      const ratio = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((point.x - edge.start.x) * dx + (point.z - edge.start.z) * dz) / lengthSquared))
        : 0;
      const projected = { x: edge.start.x + ratio * dx, z: edge.start.z + ratio * dz };
      const distance = Math.hypot(point.x - projected.x, point.z - projected.z);
      if (distance < nearest) { nearest = distance; nearestPoint = projected; }
    }
    return { point: nearestPoint, distance: nearest };
  };
  const utilityKind = input.utilityKind ?? "water";
  return {
    kind: utilityKind === "sewage" ? "sewage-outlet-within-utility-reservation" : "water-source-within-utility-reservation",
    async derivePrerequisite() {
      // The bounded access-road prerequisite is a corridor: it finds a place the
      // domain's own planner would accept a facility at, and asks the Road child
      // to drive a road to it so the planner can reach it on the next pass.
      //
      // Sewage needs the same corridor for the same reason water does, and it is
      // the SAME corridor primitive rather than a second siting rule: the site is
      // still chosen by `planBootstrapUtilities`, over the same bounded owned-tile
      // reads, under the same site envelope — the prerequisite only changes where
      // the road ends. That is what lets an outfall sit outside the development
      // block on land the city owns, served by the planner's own service road,
      // without widening one metre of the placement authority.
      if (utilityKind === "sewage") return sewageAccessPrerequisite(input, nearestRoad);
      if (utilityKind !== "water") return null;
      // A truncated road graph cannot prove that a source lacks road access.
      // A missing/incoherent tile detail is skipped, never treated as dry land.
      if (input.world.roadGraph.truncated || !input.assets.some((asset) => !asset.locked && asset.capabilities.freshWaterCapacity > 0 &&
        ((asset.capabilities.allowedWaterTypes?.toLowerCase() ?? "").includes("ground") || asset.capabilities.groundWaterMaximum > 0))) return null;
      const groundAssets = input.assets.filter((asset) => !asset.locked && asset.capabilities.freshWaterCapacity > 0 &&
        ((asset.capabilities.allowedWaterTypes?.toLowerCase() ?? "").includes("ground") || asset.capabilities.groundWaterMaximum > 0))
        .sort((a, b) => a.constructionCost - b.constructionCost || a.prefab.localeCompare(b.prefab));
      const asset = groundAssets[0];
      if (!asset) return null;
      // Mirror waterFacilityCandidateSet's minimum road frontage, with a small
      // deterministic margin so the Road child stops in a position the existing
      // Water planner can use instead of running the road onto the source.
      const serviceRoadOffset = Math.max(asset.size.x, asset.size.z) * 0.5 + 28;
      const resourcePoints: Array<{ point: SpatialPoint2; groundwater: number; roadPoint: SpatialPoint2 | null; roadDistance: number }> = [];
      for (const tile of input.world.ownedTiles.filter((item) => item.owned)) {
        const width = tile.bounds.max.x - tile.bounds.min.x;
        const depth = tile.bounds.max.z - tile.bounds.min.z;
        const radius = Math.max(width, depth) / 2;
        if (!Number.isFinite(radius) || radius <= 0) continue;
        let detail: SpatialSiteDetail | null;
        try { detail = await input.readReservation(tile.center, radius); }
        catch { continue; }
        if (!detail || detail.terrain.resolution <= 0) continue;
        const terrain = detail.terrain;
        const spacing = Math.min(terrain.cellSize.x, terrain.cellSize.z);
        if (!Number.isFinite(spacing) || spacing <= 0) continue;
        for (let row = 0; row < terrain.resolution; row += 1) for (let col = 0; col < terrain.resolution; col += 1) {
          const index = row * terrain.resolution + col;
          const groundWater = terrain.groundWater[index] ?? 0;
          if (groundWater <= 0 || (terrain.groundWaterPollution[index] ?? 0) > 0 || (terrain.waterDepths[index] ?? 0) > 0.05) continue;
          const neighbors = [col > 0 ? index - 1 : index, col + 1 < terrain.resolution ? index + 1 : index,
            row > 0 ? index - terrain.resolution : index, row + 1 < terrain.resolution ? index + terrain.resolution : index];
          const height = terrain.heights[index];
          const neighborHeights = neighbors.map((neighbor) => terrain.heights[neighbor]);
          if (!Number.isFinite(height) || neighborHeights.some((value) => !Number.isFinite(value)) ||
            Math.max(...neighborHeights.map((value) => Math.abs(height - value))) / spacing * 100 > 8) continue;
          const point = { x: terrain.bounds.minX + (col + 0.5) * terrain.cellSize.x,
            z: terrain.bounds.minZ + (row + 0.5) * terrain.cellSize.z };
          if (!input.world.ownedTiles.some((owned) => owned.owned &&
            point.x >= owned.bounds.min.x && point.x <= owned.bounds.max.x &&
            point.z >= owned.bounds.min.z && point.z <= owned.bounds.max.z)) continue;
        const nearest = nearestRoad(point, input.roads);
        resourcePoints.push({ point, groundwater: groundWater, roadPoint: nearest.point, roadDistance: nearest.distance });
        }
      }
      // A Goal prerequisite may need several bounded Road work orders. Continue
      // the corridor until the source enters the planner's usable frontage band;
      // 320 m is the Water planner's upper reach, not the point where corridor
      // construction should stop. The child target is offset from the source so
      // its final Road can serve the source without placing Road through it.
      const targets = resourcePoints.filter((item) => item.roadDistance > serviceRoadOffset + 24)
        .sort((a, b) => a.roadDistance - b.roadDistance || b.groundwater - a.groundwater ||
          a.point.x - b.point.x || a.point.z - b.point.z).slice(0, 8);
      if (targets.length === 0) return null;
      // This is a Road prerequisite, so the site is chosen from authoritative
      // resource/buildability facts. A building preview here would conflate
      // "not placeable before the access prerequisite" with a permanent site
      // refusal. The resumed Water admission performs its own exact native
      // placement preflight after Road readback.
      for (const source of targets) {
        const target = source.roadPoint && source.roadDistance > 0
          ? { x: source.point.x + ((source.roadPoint.x - source.point.x) / source.roadDistance) * serviceRoadOffset,
              z: source.point.z + ((source.roadPoint.z - source.point.z) / source.roadDistance) * serviceRoadOffset }
          : source.point;
        return { kind: "ROAD_ACCESS" as const, targetPoint: target, completionStage: "ROAD_DELIVERED" as const,
          evidence: `native-placeable owned clean groundwater at (${source.point.x.toFixed(1)},${source.point.z.toFixed(1)}) is ${source.roadDistance.toFixed(1)}m from the authoritative road graph; corridor target is ${serviceRoadOffset.toFixed(1)}m from the source` };
      }
      return null;
    },
    async accepts(candidate, reservationRadius, signal) {
      let reservation: SpatialSiteDetail | null;
      try {
        reservation = await input.readReservation(candidate.target.center, reservationRadius, signal);
      } catch (error) {
        // A read that failed is a region that was not observed. It must refuse
        // the candidate rather than escape: this runs inside the site search, so
        // throwing here would abort admission for every candidate at once and
        // hide which one was unreadable behind a single opaque failure.
        input.onEvaluated?.({
          candidateId: candidate.id,
          accepted: false,
          reason: `WATER_RESERVATION_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        });
        return false;
      }
      if (!reservation) {
        input.onEvaluated?.({ candidateId: candidate.id, accepted: false, reason: "WATER_RESERVATION_NOT_OBSERVED" });
        return false;
      }
      let water: PlannedUtilityFacility;
      try {
        water = planWaterFacility(input, reservation, candidate.target.center, reservationRadius);
      } catch (error) {
        // A refusal is the planner's, not ours: the water branch reports its own
        // reason when no groundwater source exists inside the reservation.
        input.onEvaluated?.({
          candidateId: candidate.id,
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      // The plan is only an admission candidate once the game agrees it can be
      // built. Order matters: the probe is a native call, so it is issued only
      // after the planner has proposed somewhere to put it.
      const placement = await probeWaterFacilityPlacement(input, water, signal);
      if (!placement.accepted) {
        input.onEvaluated?.({ candidateId: candidate.id, accepted: false, reason: placement.reason });
        return false;
      }
      // Recorded only for a candidate that survived both gates, so the budget
      // question can never be asked about a plan admission refused.
      acceptedPlans.set(planKey(candidate.id, reservationRadius), water);
      input.onEvaluated?.({ candidateId: candidate.id, accepted: true, reason: null });
      return true;
    },
    /**
     * What the accepted plan costs: the facility at its authoritative asset
     * cost, plus the connection primitive at the native spending contract's own
     * quote.
     *
     * Both halves are needed, because the native boundary that refuses an
     * over-budget execution sums the facility and every connection primitive
     * against the same limit. A budget covering only the facility would admit a
     * run that places the pumping station and then has its pipe refused, which
     * leaves a placed facility that serves nothing.
     */
    async minimumFeasibleBudget(candidate, reservationRadius, signal): Promise<UtilityPlanBudgetRequirement | null> {
      const water = acceptedPlans.get(planKey(candidate.id, reservationRadius));
      // Admission asks this only about a candidate and radius it accepted, so a
      // miss means the acceptance and the budget question are not about the same
      // plan. That is unprovable, not zero: refuse rather than authorize a spend
      // whose figure nobody read.
      if (!water) throw new Error("WATER_UTILITY_BUDGET_REQUIREMENT_UNPROVEN");
      return waterRequirement(input, water, signal);
    },
  };
}

/** Owned tiles one sewage corridor search may read. Bounded, like every search. */
export const MAXIMUM_SEWAGE_OUTFALL_TILE_READS = 12;

/**
 * How fine a grid the sewage outfall search reads at, in metres per cell.
 *
 * The search hands its read to the ordinary planner, and the planner validates
 * everything it proposes INSIDE that read — including the service road, which by
 * definition runs from the outfall to the road network. So the read has to cover
 * the corridor and not merely the tile, and it has to resolve the shoreline at
 * the same time. ~10 m cells do both; the resolution is derived from the square
 * the corridor needs rather than fixed, so a longer corridor gets a bigger read
 * instead of a coarser one.
 */
export const SEWAGE_OUTFALL_SEARCH_CELL_METERS = 10;
/**
 * Hard ceiling on the grid one owned tile's outfall search may ask for.
 *
 * 128 is the Bridge's own ceiling for a bounded detail read — asking for more
 * does not return a finer grid, it returns a refusal, and a refusal here reads
 * as "the region was not observed". A corridor longer than 128 cells can span
 * therefore gets a coarser grid rather than a failed read.
 */
export const MAXIMUM_SEWAGE_OUTFALL_SEARCH_RESOLUTION = 128;

/**
 * The corridor that makes an owned shoreline reachable, or null.
 *
 * The site is not chosen here. Each owned tile is handed to the SAME
 * `planBootstrapUtilities` call the execution path uses, with the same
 * environmental criterion, and only a tile whose planner actually returns a
 * certified outfall contributes a candidate. So this cannot invent a site the
 * planner would refuse, and it cannot certify one the criterion would refuse —
 * it only decides where the access road should stop.
 *
 * Null means no owned tile the search was allowed to read produced an outfall
 * the planner accepted: a bounded, honest "not this world, not this budget",
 * never an unbounded search.
 */
async function sewageAccessPrerequisite(
  input: WaterPlanInput,
  nearestRoad: (point: SpatialPoint2, edges: readonly SpatialRoadEdge[]) => { point: SpatialPoint2 | null; distance: number },
): Promise<{ kind: "ROAD_ACCESS"; targetPoint: SpatialPoint2; completionStage: "ROAD_DELIVERED"; evidence: string } | null> {
  // Without the environmental observation there is nothing to judge an outfall
  // with, and proposing a corridor to a site nobody could certify would be
  // exactly the guess the recipe forbids.
  const refusal = (reason: string) => {
    input.onSewageOutfallCandidate?.({ tileIndex: -1,
      center: { x: Number.NaN, z: Number.NaN }, radius: 0, disposition: "PLAN_REFUSED", reason, reached: unreached() });
    return null;
  };
  if (!input.sewageEnvironmentalSafety) return refusal("no T20 observation was supplied to the search");
  // A truncated road graph cannot prove that a shoreline lacks road access.
  if (input.world.roadGraph.truncated) return refusal("the authoritative road graph is truncated");
  const asset = input.assets
    .filter((candidate) => !candidate.locked && candidate.capabilities.sewageCapacity > 0)
    .sort((left, right) => left.constructionCost - right.constructionCost || left.prefab.localeCompare(right.prefab))[0];
  if (!asset) return refusal("no unlocked sewage asset with capacity is available");
  // Mirror the sewage plan's own frontage rule: stop the road short enough that
  // the planner still wants a service road, instead of running the road onto the
  // outfall and putting the site outside the planner's frontage band.
  const serviceRoadOffset = Math.max(asset.size.x, asset.size.z) * 0.5 + 28;
  const candidates: Array<{ point: SpatialPoint2; roadPoint: SpatialPoint2 | null; roadDistance: number; detail: SpatialSiteDetail }> = [];
  const tiles = input.world.ownedTiles.filter((tile) => tile.owned).slice(0, MAXIMUM_SEWAGE_OUTFALL_TILE_READS);
  const report = input.onSewageOutfallCandidate;
  for (const [tileIndex, tile] of tiles.entries()) {
    const evidence = (entry: Omit<SewageOutfallCandidateEvidence, "tileIndex" | "center" | "radius">) =>
      report?.({ tileIndex, center: tile.center, radius: Math.max(tile.bounds.max.x - tile.bounds.min.x,
        tile.bounds.max.z - tile.bounds.min.z) / 2, ...entry });
    const width = tile.bounds.max.x - tile.bounds.min.x;
    const depth = tile.bounds.max.z - tile.bounds.min.z;
    const radius = Math.max(width, depth) / 2;
    if (!Number.isFinite(radius) || radius <= 0) {
      evidence({ disposition: "TILE_GEOMETRY_INVALID", reason: `radius=${radius}`, reached: unreached() });
      continue;
    }
    let detail: SpatialSiteDetail | null;
    // The read must cover the corridor this tile's outfall would need, not just
    // the tile: the planner validates the service road inside the read it is
    // given, and the road has to reach the road network, which on the live world
    // is 587 m from the nearest owned shoreline — twice the tile's own half
    // width. Handing it the tile square alone made every single candidate fail
    // with the corridor's far samples "unaddressed", which is a refusal about
    // the read rather than about the site.
    //
    // It stays bounded: the corridor cannot legally exceed
    // MAX_UTILITY_SERVICE_ROAD_LENGTH, so neither can the square, and the grid
    // is derived from that square so a longer corridor buys a bigger read rather
    // than a coarser one.
    const roadFromTileCenter = nearestRoad(tile.center, input.roads).distance;
    const needed = Number.isFinite(roadFromTileCenter)
      ? Math.min(MAX_UTILITY_SERVICE_ROAD_LENGTH, roadFromTileCenter + radius)
      : radius;
    const readRadius = Math.max(radius, needed);
    const readResolution = Math.min(MAXIMUM_SEWAGE_OUTFALL_SEARCH_RESOLUTION,
      Math.max(16, Math.ceil((readRadius * 2) / SEWAGE_OUTFALL_SEARCH_CELL_METERS)));
    try { detail = await input.readReservation(tile.center, readRadius, undefined, readResolution); }
    catch (error) {
      evidence({ disposition: "RESERVATION_READ_FAILED",
        reason: error instanceof Error ? error.message : String(error), reached: unreached() });
      continue;
    }
    if (!detail || detail.terrain.resolution <= 0) {
      evidence({ disposition: "RESERVATION_NOT_OBSERVED",
        reason: `resolution=${detail?.terrain.resolution ?? "none"}`, reached: unreached() });
      continue;
    }
    // Site legality and buildability are the planner's, and the environmental
    // criterion is the planner's too: `planWaterFacility` runs the same
    // `planBootstrapUtilities` call the execution path runs, so a refusal here
    // is the planner's own named refusal rather than a second opinion.
    let facility: PlannedUtilityFacility;
    try { facility = planWaterFacility(input, detail, tile.center, radius); }
    catch (error) {
      evidence({ disposition: "PLAN_REFUSED",
        reason: error instanceof Error ? error.message : String(error), reached: unreached() });
      continue;
    }
    const reached = { siteLegality: true, buildability: true, route: false,
      environmentalCertification: facility.environmentalCertification !== undefined, completeProposal: false };
    if (facility.kind !== "sewage") {
      evidence({ disposition: "PLAN_KIND_MISMATCH", reason: facility.kind, facilityPosition: facility.position, reached });
      continue;
    }
    const nearest = nearestRoad(facility.position, input.roads);
    reached.route = Number.isFinite(nearest.distance);
    // A site the road already reaches needs no corridor; that is what the
    // ordinary reservation search is for.
    if (!Number.isFinite(nearest.distance) || nearest.distance <= serviceRoadOffset + 24) {
      evidence({ disposition: "ROAD_ALREADY_REACHES_SITE",
        reason: `roadDistance=${Number.isFinite(nearest.distance) ? nearest.distance.toFixed(1) : "none"}m <= ` +
          `${(serviceRoadOffset + 24).toFixed(1)}m`,
        facilityPosition: facility.position,
        ...(Number.isFinite(nearest.distance) ? { roadDistance: nearest.distance } : {}), reached });
      continue;
    }
    reached.completeProposal = true;
    evidence({ disposition: "ACCEPTED", facilityPosition: facility.position,
      roadDistance: nearest.distance, reached });
    candidates.push({ point: facility.position, roadPoint: nearest.point, roadDistance: nearest.distance, detail });
  }
  const target = candidates.sort((left, right) =>
    left.roadDistance - right.roadDistance ||
    left.point.x - right.point.x || left.point.z - right.point.z)[0];
  if (!target) return null;
  const roadPoint = target.roadPoint ?? target.point;
  // The corridor is planned to the OUTFALL, over the whole remaining distance.
  //
  // It used to be planned to a point `serviceRoadOffset` (≈44 m) short of the
  // outfall, measured from the CURRENT road front. That made the planner's span
  // shorter than one step on every pass, so it answered `ALREADY_REACHED` and
  // produced a short stub beside the front — which is exactly the live
  // trajectory: eight segments wandering around (-590..-657, -502..-560) with
  // the planned target pinned at 474.9m from the outfall and never closing.
  // The shortfall belongs at the END of the corridor, not at the start of every
  // hop, so the planner is given the real destination and the approach is
  // stopped below.
  const corridorTarget = target.point;
  // P4 — plan the corridor before asking the Road step for anything.
  //
  // The Road step is a bounded mutation step; handing it a target 600 m away
  // made it sweep headings blind until its family ran out. Planning the route
  // first turns that into a sequence of short, terrain-checked hops, and the
  // prerequisite asks for the FIRST hop only. Each delivery shortens the
  // remaining distance, so the next pass re-plans from the world it actually
  // produced rather than from the plan it hoped for.
  // Ground is read ON DEMAND along whatever route the search is considering,
  // not from a mosaic fixed around the site: the live route walked out of such a
  // mosaic and refused for "not observed" instead of navigating. Every read is
  // still bounded and cached, and the search carries a hard sample budget.
  const mosaic: SpatialSiteDetail[] = candidates.map((candidate) => candidate.detail);
  const readCache = new Map<string, Awaited<ReturnType<typeof readCorridorGround>>>();
  const sampleGround = async (point: SpatialPoint2) => {
    // Keyed by READ TILE, not by search cell: one bounded 800 m read answers
    // every sample inside it, so the native budget counts squares of world
    // rather than how many cells the search happened to look at. Keying by cell
    // spent the whole read budget on the first 24 cells and the search never
    // saw the corridor.
    const id = `${Math.round(point.x / CORRIDOR_READ_RADIUS_METERS)},${Math.round(point.z / CORRIDOR_READ_RADIUS_METERS)}`;
    const cached = readCache.get(id);
    if (cached !== undefined) return cached;
    if (readCache.size >= MAXIMUM_CORRIDOR_GROUND_READS) return null;
    let detail = mosaic.find((entry) => point.x >= entry.terrain.bounds.minX && point.x <= entry.terrain.bounds.maxX &&
      point.z >= entry.terrain.bounds.minZ && point.z <= entry.terrain.bounds.maxZ) ?? null;
    if (!detail) {
      detail = await readCorridorGround(input, point);
      if (detail) mosaic.push(detail);
    }
    const ground = readCorridorGroundFrom(detail, point);
    readCache.set(id, ground);
    return ground;
  };
  const corridor = await planRoadCorridor({
    start: roadPoint,
    target: corridorTarget,
    sampleGround,
    maximumLength: MAX_UTILITY_SERVICE_ROAD_LENGTH,
    // Compiled at the HOP length, not the corridor ceiling: the prerequisite
    // asks the Road step for one committed segment at a time, and a single
    // 677 m course is not something the bounded Road step can deliver. Each hop
    // shortens the next pass's plan, so the chain advances deterministically.
    maximumSegmentLength: SEWAGE_OUTFALL_CORRIDOR_STEP_METERS,
    maximumGradePercent: ROAD_CORRIDOR_MAXIMUM_GRADE_PERCENT,
    maximumDetourRatio: MAXIMUM_CORRIDOR_DETOUR_RATIO,
    maximumExpandedCells: MAXIMUM_CORRIDOR_EXPANDED_CELLS,
    // Two different budgets, and conflating them is what kept the search blind:
    // the number of CELLS it may inspect is answered from the read mosaic and can
    // be large, while the number of NATIVE reads that build that mosaic is what
    // the caller caps.
    maximumSamples: MAXIMUM_CORRIDOR_SAMPLED_CELLS,
    // The existing network, so the corridor leaves it instead of running along
    // it — the one condition native actually refuses.
    existingRoads: input.roads.map((edge) => ({ start: edge.start, end: edge.end })),
    isOwned: (point) => input.world.ownedTiles.some((tile) => {
      const bounds = tile.bounds;
      return tile.owned && bounds !== null && point.x >= bounds.min.x && point.x <= bounds.max.x &&
        point.z >= bounds.min.z && point.z <= bounds.max.z;
    }),
  });
  // The corridor is only "already there" when the road front is ON the site —
  // one cell away at most, which the search reports as `ALREADY_REACHED`. A
  // corridor whose PLAN reaches the outfall is not a built road: returning here
  // on `remaining <= serviceRoadOffset` would hand over to the ordinary
  // reservation search while the access road still had ~670 m left to build,
  // which is what the previous live run's stalled chain looked like.
  if (corridor.status === "ALREADY_REACHED") {
    input.onSewageOutfallCandidate?.({ tileIndex: -2, center: target.point, radius: serviceRoadOffset,
      disposition: "ROAD_ALREADY_REACHES_SITE",
      reason: `corridor remaining ${corridor.remaining.toFixed(1)}m <= serviceRoadOffset ` +
        `${serviceRoadOffset.toFixed(1)}m`,
      facilityPosition: target.point, roadDistance: target.roadDistance,
      reached: { siteLegality: true, buildability: true, route: true,
        environmentalCertification: true, completeProposal: true } });
    return null;
  }
  const firstHop = corridor.segments[0]?.end ?? corridorTarget;
  const planEvidence = `corridor ${corridor.status}: ${corridor.reason}; ` +
    `waypoints=${corridor.waypoints.length}, segments=${corridor.segments.length}, ` +
    `routeLength=${corridor.evidence.routeLength}m, detourRatio=${corridor.evidence.detourRatio}, ` +
    `samples=${corridor.evidence.samples}, remaining=${corridor.remaining.toFixed(1)}m`;
  input.onSewageOutfallCandidate?.({ tileIndex: -2, center: target.point, radius: serviceRoadOffset,
    disposition: "ACCEPTED", facilityPosition: target.point, roadDistance: target.roadDistance,
    reason: `corridor planned: ${corridor.status}`, reached: { siteLegality: true, buildability: true,
      route: true, environmentalCertification: true, completeProposal: true } });
  return {
    kind: "ROAD_ACCESS" as const,
    // The first bounded hop, never the far target: one legal segment the Road
    // step can actually commit.
    targetPoint: firstHop,
    completionStage: "ROAD_DELIVERED" as const,
    evidence:
      `the certified sewage planner accepts an outfall at ` +
      `(${target.point.x.toFixed(1)},${target.point.z.toFixed(1)}) on owned shoreline ` +
      `${target.roadDistance.toFixed(1)}m from the authoritative road graph; ` +
      `${planEvidence} ` +
      `(ownedTilesRead=${tiles.length}, candidates=${candidates.length})`,
  };
}

/**
 * The bounded placement search: the plan's own site, at each rotation the plan
 * would accept, until the game agrees to one.
 *
 * Bounded by the plan's own rotation list, so the cost of admitting one
 * (candidate, radius) is at most four native verdicts and the ladder above it
 * stays a bounded search. The first acceptance short-circuits, because the
 * question is whether a placement EXISTS, not which one.
 *
 * A probe that throws observed nothing. That is refused the same way an
 * unobserved reservation is, and for the same reason: it refuses this candidate
 * rather than escaping, because this runs inside the site search and an escaping
 * throw would take down admission for every candidate at once.
 */
async function probeWaterFacilityPlacement(
  input: WaterSiteConstraintInput,
  water: PlannedUtilityFacility,
  signal?: AbortSignal,
): Promise<{ accepted: boolean; reason: string | null }> {
  // A plan that declares no rotation has exactly one placement to try: the one
  // it was planned at. Probing nothing would accept the plan on its own word.
  const rotations = water.rotationCandidates.length > 0 ? water.rotationCandidates : [0];
  for (const rotation of rotations) {
    let placeable: boolean;
    try {
      placeable = await input.probePlacement({ prefab: water.prefab, position: water.position, rotation }, signal);
    } catch (error) {
      return {
        accepted: false,
        reason: `WATER_FACILITY_PLACEMENT_UNOBSERVED: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (placeable) return { accepted: true, reason: null };
  }
  return {
    accepted: false,
    reason: `WATER_FACILITY_NOT_PLACEABLE:prefab=${water.prefab}:placements=${rotations.length}`,
  };
}

/**
 * The one place a water facility is planned for a reservation.
 *
 * Both the constraint's acceptance and the requirement it declares come through
 * here, because they are two questions about one plan: asking them of two
 * differently-assembled planner calls is how the site a project reserved and the
 * cost it budgeted for stop describing the same thing.
 */
function planWaterFacility(
  input: WaterPlanInput,
  reservation: SpatialSiteDetail,
  center: SpatialPoint2,
  radius: number,
): PlannedUtilityFacility {
  // The planner reads the roads it may connect to out of the detail it is
  // given, so the admission scope's road authority is applied here rather than
  // assumed from the bounded read.
  const scopedDetail: SpatialSiteDetail = {
    ...reservation,
    roadGraph: { ...reservation.roadGraph, edges: [...input.roads] },
  };
  // `planBootstrapUtilities` only reads `valid` and `layout.segments`, and
  // `EXISTING_PLAYER_ROADS_ONLY` never uses the layout. This mirrors the
  // production call site in `planScopedUtility` exactly.
  const selected = { valid: true, layout: { segments: [] } } as unknown as BootstrapSiteEvaluation;
  const kind = input.utilityKind ?? "water";
  const plan = planBootstrapUtilities(input.world, selected, scopedDetail, [...input.assets], {
    networkSource: "EXISTING_PLAYER_ROADS_ONLY",
    utilityKind: kind,
    // The reservation, not the read square: a source in the read's corner is
    // not placeable, so it is not evidence that this candidate can be served.
    siteEnvelope: { center, radius },
    ...(kind === "sewage" && input.sewageEnvironmentalSafety
      ? { sewageEnvironmentalSafety: input.sewageEnvironmentalSafety }
      : {}),
  });
  // The planner returns this kind's facility or throws. Returning is not enough
  // on its own: `facilities` is the whole plan 鈥?a sewage request also carries
  // the power and water facilities the planner ranks 鈥?so the facility this
  // constraint is about is looked up by kind rather than assumed to be the only
  // entry.
  const planned = plan.facilities.find((facility) => facility.kind === kind);
  if (!planned) throw new Error(`UTILITY_FACILITY_NOT_PLANNED:${kind}`);
  return planned;
}

/** Price one planned water facility through the existing spending contract. */
async function waterRequirement(
  input: WaterPlanInput,
  water: PlannedUtilityFacility,
  signal?: AbortSignal,
): Promise<UtilityPlanBudgetRequirement> {
  return minimumFeasibleUtilityBudget({
    kind: input.utilityKind ?? "water",
    facilityPrefab: water.prefab,
    facilityCost: water.constructionCost,
    connectionPrefab: water.connection.prefab,
    connectionCost: await input.quoteConnectionCost(water.connection, signal),
  });
}

/**
 * What the CURRENT authoritative water plan for a reservation costs.
 *
 * The same derivation admission runs, exposed for the case where the plan is
 * being re-derived rather than admitted: a project already in the world whose
 * admitted budget predates its plan. The caller supplies the same road authority
 * the execution path will use, so the plan priced here is the plan that will be
 * executed 鈥?a requirement computed against a different road set would budget
 * for a pipe to somewhere else.
 *
 * Takes no placement probe, because this is not an admission: the plan being
 * priced already exists, and whether the game accepts its site is the question
 * that produced the project 鈥?or, for a project admitted before this gate
 * existed, the debt it already carries. Re-asking it here would refuse to price
 * a project that is already durable.
 */
export async function readWaterUtilityRequirement(
  input: WaterPlanInput,
  envelope: { center: SpatialPoint2; radius: number },
  signal?: AbortSignal,
): Promise<UtilityPlanBudgetRequirement> {
  const reservation = await input.readReservation(envelope.center, envelope.radius, signal);
  if (!reservation) throw new Error("WATER_UTILITY_BUDGET_RESERVATION_NOT_OBSERVED");
  return waterRequirement(input, planWaterFacility(input, reservation, envelope.center, envelope.radius), signal);
}
