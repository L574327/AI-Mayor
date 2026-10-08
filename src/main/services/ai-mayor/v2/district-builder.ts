import type { SpatialLocalTerrain, SpatialPoint2, SpatialRoadEdge, SpatialRoadNode, SpatialSiteDetail, SpatialWorldModel } from "../spatial/types";
import { pointInTile } from "../spatial/world-scanner";
import { filterGridSegmentsByTerrain, GRID_LATTICE_SPACING_METERS, planRectangularGrid } from "./road-grid-generator";
import { roadComponents, SERVED_COMPONENT_MIN_STREETS, type RoadComponent } from "./road-components";
import { cashCoversExpansion, civicIsAffordable, EXPANSION_DEVIATION_RESERVE, expansionCashRequired, LAND_ESCAPE_RUNWAY_MONTHS, LAND_PURCHASE_CASH_RESERVE, landPurchaseAffordable, landPurchaseRunwayAffordable } from "./solvency";
import { corridorCandidates, deadEndClosures } from "./district-corridors";
import { instrumentDistrictPort, refusalReason, roadContext, type ExecutionOutcomeRecorder } from "./execution-telemetry";
import { isStraightContinuationOfDeadEnd, roadAttemptFeatures, streetSegments } from "./road-attempt-features";
import { describeStanding, IssueLedger } from "./issue-ledger";
import { AssistBudget } from "./assist-budget";
import { guardDistrictPort, protection, type ProtectionRegistry } from "./protection";
import { RoadCare, type RoadCareMemory, type RoadCarePort } from "./road-care";
import { type CareFocus, SERVICE_FOCUS } from "./care-focus";
import { civicRotationToward, civicSiteCandidates, CIVIC_SETBACKS_METERS } from "./civic-service";
import {
  densestIcon, iconClusters, iconCount, RefusedPlacements, reservedLotOf, reserveSpotIndices, serviceCap, serviceLimit, servicePrefabs, servicesWanted, SERVICE_COOLDOWN_CYCLES, SERVICE_COOLDOWN_HOURS, SERVICE_EVIDENCE_ICON,
  SERVICE_MINIMUM_ICONS, SERVICE_NEEDS, SERVICE_PREFAB_QUERIES, garbageBuildingCap, SERVICE_UNLOCK_PREFABS, splitOutsideOwnedLand, withWornRoads, SERVICE_STUCK_CYCLES, SERVICE_STUCK_HOURS, SERVICE_STUCK_MAXIMUM_MULTIPLE, SERVICE_STUCK_REFUSAL_HOURS,
  type IconReading, type ServiceNeed,
} from "./district-services";
import { classifyBottleneck, neededLandUses, neededStockAbsorbing, pausedLandUses, pruneStockHistory, type GrowthBottleneck, type LaborReading, type StockSample } from "./growth-bottleneck";
import { decideLoan, LOAN_COOLDOWN_CYCLES, LOAN_COOLDOWN_HOURS, LOAN_REFUSED_BLOCK_CYCLES, LOAN_REFUSED_BLOCK_HOURS, paymentsFit, type LoanReading } from "./loan-policy";
import { stampElapsed, type GameStamp } from "./game-clock";
import { HighValueGuard, highValueKind, isHighValueFacility } from "./high-value-guard";
import { BRIDGES_PER_BATCH, findWaterCrossings, selectBridgeBatch } from "./water-crossing";
import { linkPowerExport, type PowerExportPort } from "./power-export";
import { signatureCandidates, signaturesToPlace, SIGNATURE_MAXIMUM_PREFLIGHTS } from "./signature-rush";
import { boundedMemory, type BuilderMemoryStore } from "./builder-memory";
import { unlockPrefabs, unlockRailway, type TechTreePort } from "./tech-tree";
import { frontageCourses } from "./frontage-road";
import { BIG_SERVICE_MINIMUM_SIDE_METERS, BIG_SERVICE_STREET_REACH_METERS, footprintOf, placeBigBuilding } from "./big-building-site";

/** Signature buildings: road dry runs per prefab, the gap to a street that counts as adjacent, and the margin kept between the road end and the building front. */
const SIGNATURE_ROAD_CHECKS_PER_PREFAB = 12;
const SIGNATURE_ADJACENT_METERS = 8;
const SIGNATURE_FRONT_MARGIN_METERS = 4;
/** The frontage road (`frontage-road.ts`): courses dry-run per try, the terrain read around the notice, and how far the building centre may lie from its notice. */
const FRONTAGE_COURSES_PER_TRY = 6;
const FRONTAGE_ATTEMPTS_PER_SPOT = 3;
const FRONTAGE_TERRAIN_RADIUS_METERS = 120;
const FRONTAGE_BUILDING_REACH_METERS = 150;
const PEDESTRIAN_TRIAL_HOURS = 3;
const PEDESTRIAN_TRIAL_CYCLES = 4;
const PEDESTRIAN_TRIAL_REACH_METERS = 150;
const PEDESTRIAN_TRIAL_CAR_NOTICES = 4;
/** Whether the building a footpath notice is about also lacks a car road (a notice of its own kind that says "car" or "road" within a big building's reach). */
const needsCarRoad = (spot: { x: number; z: number; prefab?: string }, all: ReadonlyArray<{ type: string; x: number; z: number; prefab?: string }>): boolean =>
  all.some((other) => /Car Access|Road Access/i.test(other.type) && other.prefab === spot.prefab && Math.hypot(other.x - spot.x, other.z - spot.z) <= 130);
/** The notices of the same building as `spot` (same prefab, same entity when the icon names one, within a big building's reach): its entrances. */
const SIBLING_NOTICE_REACH_METERS = 130;
/** The end of a street (a point where an edge stops, the only place a new road can join) nearest the notice, within reach of the stub course. */
const nearestStreetEnd = (point: SpatialPoint2, edges: ReadonlyArray<{ start: SpatialPoint2; end: SpatialPoint2 }>): SpatialPoint2 | null => {
  let best: SpatialPoint2 | null = null; let bestDistance = 45;
  for (const edge of edges) for (const end of [edge.start, edge.end]) { const distance = Math.hypot(end.x - point.x, end.z - point.z); if (distance < bestDistance) { bestDistance = distance; best = { x: end.x, z: end.z }; } }
  return best;
};
const siblingNotices = (spot: { x: number; z: number; prefab?: string; entity?: { index: number; version: number } }, all: ReadonlyArray<{ x: number; z: number; prefab?: string; entity?: { index: number; version: number } }>): SpatialPoint2[] =>
  all.filter((other) => other !== spot && other.prefab === spot.prefab && (!spot.entity || !other.entity || (other.entity.index === spot.entity.index && other.entity.version === spot.entity.version)) &&
    Math.hypot(other.x - spot.x, other.z - spot.z) <= SIBLING_NOTICE_REACH_METERS).map((other) => ({ x: other.x, z: other.z }));
/** One tile of land for a big service at most per this many game hours (cycles when the clock cannot be read). */
const BIG_SERVICE_LAND_COOLDOWN_HOURS = 72;
const BIG_SERVICE_LAND_COOLDOWN_CYCLES = 60;
/** A landfill stands at least this far from any home (its noise and ground pollution; the game's own pollution radius is measured, not guessed, by the readback of the icons). */
const GARBAGE_HOME_BUFFER_METERS = 250;
/** A burning plant or a recycling centre stands at least this far from homes (both make air pollution: live 2026-10-07, two recycling centres 160 m from homes brought 57 air-pollution icons and the population fell 29,000 -> 23,000). */
const INCINERATOR_HOME_BUFFER_METERS = 250;
/** The distances from homes a landfill is looked for at, farthest first. */
const GARBAGE_HOME_BUFFERS_METERS: readonly number[] = [GARBAGE_HOME_BUFFER_METERS, 160];
/** Placement checks a big service may ask beside streets in one call (each shows a ghost building in the game). */
const BIG_SERVICE_BESIDE_PREFLIGHTS = 8;
/** A street whose end lies this near a big service building (half its diagonal plus clearance) is its access road, never a dead-end spur to take up. */
const BIG_SERVICE_ACCESS_PROTECT_METERS = 100;
/** Service buildings too big for the 30 m building clearance of the spur rule (the others are covered by what this builder placed itself). */
const BIG_SERVICE_PROTECTED_PREFABS = ["RoadMaintenanceDepot01", "Cemetery01", "Cemetery02", "PoliceStation01", "Hospital01"];

/** Dark homes (`#lightDarkHomes`): wait this long between generators, give a cluster at most this many, and read each home's wanted load as this many units. */
const DARK_HOMES_COOLDOWN_HOURS = 6;
const DARK_HOMES_COOLDOWN_CYCLES = 6;
const DARK_CLUSTER_MAXIMUM_PLACEMENTS = 3;
const DARK_HOME_WANTED_UNITS = 12;
const darkKey = (point: SpatialPoint2): string => `${Math.round(point.x / 400)},${Math.round(point.z / 400)}`;
import { linkTrainStation, railAnchor, TRAIN_LINK_MAXIMUM_ATTEMPTS, type TrainLinkPort } from "./train-link";
import { ensureTrainLoop, type TransitPort } from "./transit-lines";
import {
  absorbableCells, batchConstraint, capitalAreaCap, chooseGrowthRole, chooseResidentialDensity, decideGrowthAfterSearch, FinanceWatch, gameMonthKey, growthAdmission, growthDecaying, growthStage, netGrowthPerDay,
  MINIMUM_POPULATION_FOR_RATES, MINIMUM_REALIZATION_AREA_SQUARE_METERS, POLICY_GAME_VERSION, QUOTA_YIELD_CYCLES, QUOTA_YIELD_HOURS, SEED_BATCH_SQUARE_METERS, SMALLEST_DISTRICT_SQUARE_METERS, type Constraint, type DensityState, type GrowthStage, type PopulationSeries, type ResidentialDensityKey,
} from "./growth-policy";
import { DEFERRED_REVIEW_EVERY_CYCLES, DEFERRED_REVIEW_EVERY_HOURS, immediateWithoutAnswer, triageNotifications } from "./notification-tiers";
import { type ClearingBuilding, planClearing } from "./big-building-site";
import { distanceBand, type ExperienceBook, optionFamily } from "./experience-book";
import { FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX, FACILITY_ACCESS_ROAD_PREFAB, facilityAccessRoadCourseCandidates, selectFacilityAccessRoadCourse, shortAccessRoadCourseCandidates } from "./facility-access-road";
import {
  buildLandMask, composeBlocks, keepAwayBlocks, DISTRICT_ROAD_GRADE_PERCENT, GATEWAY_ROAD_GRADE_PERCENT, maximalRectangles, rectangleIsFree, shrunkVariants,
  slopePercentAround, ZONING_SLOPE_PERCENT, sampleTerrain, usableLandShare, MINIMUM_RECTANGLE_SIDE_METERS, type LandRectangle,
} from "./district-land";
import {
  allocateByDeficit, assignDistrictSpots, emptyMix, mixDeficits, targetShares, unrealizedShare, ZONE_CATEGORIES, type ZoneCategory, type ZoningMixSignals,
} from "./zoning-mix";
import {
  centreMatchesIntent, centreOf, intentNamesAPlace, intentOrder, INTENT_WATERFRONT_MINIMUM_WATER_SHARE,
  type DistrictDensity, type DistrictIntent,
} from "./district-intent";
import {
  DISTRICT_UTILITY_CONNECTION_PREFAB, DISTRICT_UTILITY_KINDS, REAL_CAPACITY_SHORTFALL, mayDemolishFacility, DISTRICT_WATER_REACH_METERS, districtUtilityShortfall, districtZonedCells, nearestStreetPoint, PREFLIGHT_NO_ANSWER_LIMIT, projectDistrictLoad,
  realizeUtilityShortfall,
  UTILITY_HEADROOM_FACTOR,
  type DistrictUtilitiesPort, type DistrictUtilityKind, type DistrictUtilityPlacement, type DistrictUtilityReading,
} from "./district-utilities";

/**
 * THE DISTRICT BUILDER — how a player builds a city, as the product's decision layer.
 *
 * A player does not decide street by street. They look at the map, pick the next piece of open land next to the
 * network, lay the whole grid in one go, zone it, and move on to the next piece. That is one decision per DISTRICT,
 * not ten admissions per street. Measured live (2026-10-03, run-mvp60): the Goal/Gate1 path spent 324 admissions and
 * 10,922 Bridge calls on 33 writes — 17 streets in 52 minutes — and never left the ground beside its own road nodes.
 *
 * The world is the only authority (user principle, 2026-10-02): every cycle re-reads it, a district already built is
 * simply land that is no longer empty, and a refused write is recorded and skipped. Nothing here is durable, so a
 * restart or a player Load re-derives the next district from the world as it is.
 *
 * Three rules keep it honest:
 *  - a street is only ever laid touching a street that is already connected, so a district can never leave an orphan;
 *  - the gateway is built first from a node of the SERVED network (≥ `SERVED_COMPONENT_MIN_STREETS`), so the district
 *    shares the main network's water, power and sewage (services travel along the connected component);
 *  - a district never covers an existing road, building, foreign land or water.
 */

/**
 * The waits below are game time (see `game-clock.ts`): each was written as "N cycles" when a cycle was about a game hour, and a cycle is now
 * 1-25 s. The `_CYCLES` / `_CALLS` constants stay as the fallback when the game clock cannot be read.
 */
export const UTILITY_REPAIR_COOLDOWN_HOURS = 3;
export const ROAD_ACCESS_SETTLE_HOURS = 3;
export const UTILITY_ZONING_HOLD_MAXIMUM_HOURS = 4;
/**
 * P2/S0, measured live 2026-10-05: with no immigration rate to price a batch against, every cycle laid another seed district (12 districts, 124 ha,
 * 20,820 zoned cells for 700 to 1,000 people) while the homes already zoned stood empty and the game's EmptyBuildings factor held demand at 0.
 * While the city has fewer people than `MINIMUM_POPULATION_FOR_RATES`, a new residential district waits while this many zoned homes stand empty — two seed batches' worth of cells (60% of the area is lots), so the first loop and its neighbour are laid — and
 * goes on after `UNFILLED_STOCK_ESCAPE_HOURS` of game time so a stock that never fills cannot stop the city for ever.
 */
export const UNFILLED_STOCK_CELL_LIMIT = 2 * Math.round(SEED_BATCH_SQUARE_METERS * 0.6 / 64);
export const UNFILLED_STOCK_ESCAPE_HOURS = 6;
export const UNFILLED_STOCK_ESCAPE_CYCLES = 12;
/** Rolling land: below this much free owned land (hectares) a tile is bought ahead of need while the cash is plentiful (see `#buyLandAhead`). */
export const LAND_AHEAD_FREE_HECTARES = 120;
/** The game's refusal to sell a tile is asked again after this much game time (cycles when no clock). */
export const LAND_AHEAD_RETRY_HOURS = 1;
export const LAND_AHEAD_RETRY_CYCLES = 3;
/** A bridge needs cash for the road (11,268 for 370 m measured live) and what the new district then costs. */
export const BRIDGE_MINIMUM_TREASURY = 150_000;
export const BRIDGE_MAXIMUM_ATTEMPTS = 3;
/** Crossings put to the game's dry run in one cycle (the batch stops earlier once enough stand). */
export const BRIDGE_TRIES_PER_CYCLE = 8;
/** The power export (`#sellPower`) is looked at this often; a transformer and its cables cost about this much reserve. */
export const POWER_EXPORT_REVIEW_HOURS = 6;
export const POWER_EXPORT_REVIEW_CYCLES = 6;
/** A transformer and two cables cost little and earn every month: sold also while the city saves (live 2026-10-07: Hartley made 2.4x its load and sold none). */
export const POWER_EXPORT_MINIMUM_TREASURY = 40_000;
/** A signature building with no accepted lot is offered lots again after this long. */
export const SIGNATURE_RETRY_HOURS = 2;
export const SIGNATURE_RETRY_CYCLES = 3;
/** A facility taken down for want of a road: nothing of the kind is offered a site within this distance of it again (live 2026-10-05: one water pump placed and taken down at the same spot five times in 13 minutes, the city short of water the whole time). */
export const ACCESS_FAILED_EXCLUSION_METERS = 90;
/** Stale zoning (`#withdrawStaleZoning`): a use this empty is over-supplied; the passes are this far apart, this large, and dezone only wholly empty free spots. */
export const STALE_EMPTY_SHARE = 0.5;
/** Medium and mixed homes are over-supplied at this share (their own vacancy exclusion in P3 is 25%; the withdrawal waits until it is clearly stuck). */
export const STALE_MEDIUM_EMPTY_SHARE = 0.4;
export const STALE_MINIMUM_EMPTY_CELLS = 400;
export const STALE_REVIEW_HOURS = 2;
export const STALE_REVIEW_CYCLES = 4;
export const STALE_SPOTS_READ_PER_PASS = 40;
export const STALE_BRUSHES_PER_PASS = 12;
export const STALE_SPOT_OFFSET_METERS = 24;
export const STALE_READ_RADIUS_METERS = 20;
export const STALE_BRUSH_RADIUS_METERS = 16;
export const STALE_MINIMUM_EMPTY_IN_DISK = 6;
/** Notices of a building that stands as a ruin, the ruins taken down per cycle, and what is never taken down this way. */
/** "Weather Destroyed" is a building a storm wrecked (30 stood for hours uncleared, live 2026-10-07); "Water Destroyed" is a pipe and is not a ruin. */
export const RUIN_NOTICE = /^(Burned Down|Collapsed|Weather Destroyed|Destroyed|Condemned|Abandoned)/i;
export const RUINS_PER_CYCLE = 8;
export const RUIN_RETRY_HOURS = 4;
export const RUIN_RETRY_CYCLES = 20;
export const RUIN_MAXIMUM_ATTEMPTS = 3;
export const RUIN_KEEP_PREFAB = /Signature|Hospital|Clinic|School|College|University|Police|Fire|Cemetery|Crematorium|Pump|Tower|Power|Wind|Solar|Transformer|Outlet|Sewage|Landfill|Station|Park|CityHall/i;
/** The unlocked signatures are looked at this often (one catalogue read). */
export const SIGNATURE_LOOK_HOURS = 1;
export const SIGNATURE_LOOK_CYCLES = 2;
/** The train link (`#linkTrain`): looked at this often, and only with this much cash (a station is about 94k, plus tracks, a road and maybe a tile). */
export const TRAIN_LINK_REVIEW_HOURS = 6;
export const TRAIN_LINK_REVIEW_CYCLES = 6;
export const TRAIN_LINK_MINIMUM_TREASURY = 400_000;
/** The development tree is looked at this often while the railway is locked. */
export const TECH_REVIEW_HOURS = 2;
export const TECH_REVIEW_CYCLES = 3;
/** The rail yard is looked at this often (a placement is tried only on land that holds it, each site once). */
export const RAIL_YARD_REVIEW_HOURS = 3;
export const RAIL_YARD_REVIEW_CYCLES = 4;
export const BRIDGE_RETRY_HOURS = 1;
export const BRIDGE_RETRY_CYCLES = 3;
/** A land use whose survey found no site after a complete search is held out of the choice this long (cycles with no readable clock). */
export const ROLE_NO_SITE_BLOCK_HOURS = 3;
export const ROLE_NO_SITE_BLOCK_CYCLES = 3;
/** A gap in a district's grid refused by the dry run is tried again after this long (game hours; cycles with no readable clock), this many times at most. */
export const DEAD_END_CLOSURE_RETRY_HOURS = 1;
export const DEAD_END_CLOSURE_RETRY_CYCLES = 2;
export const DEAD_END_CLOSURE_MAX_ATTEMPTS = 4;
/** Any dead end (not only our grid's) is joined to a node at most this far away. */
export const DEAD_END_CONNECT_MAXIMUM_METERS = 160;
/** Only a spur of our own at most this long is taken down (a broken stub of a failed build); a longer dead end is joined to the network instead. */
export const SPUR_REMOVAL_MAXIMUM_METERS = 40;
/**
 * A city that could build nothing for this long (game hours; cycles when the clock is unreadable) may buy a tile on its cash reserve. Measured live
 * (2026-10-05) with 3 hours: 23 idle cycles, close to two minutes of standing still; a cycle that builds nothing is only 0.1-0.2 game hours long.
 */
export const LAND_FINANCE_ESCAPE_HOURS = 1;
export const LAND_FINANCE_ESCAPE_CYCLES = 3;/** Repair calls to wait, after trying a utility, for the city to run and the reading to change. */
export const UTILITY_REPAIR_COOLDOWN_CALLS = 3;
/** A district is refused when the ground takes away more than this share of its planned street length. */
export const MAXIMUM_TERRAIN_LOSS_SHARE = 0.25;
/** The terrain read must cover the whole district: a founding district's half-diagonal is ~660 m (MCP allows 2048). */
export const DISTRICT_TERRAIN_WINDOW_MAXIMUM_METERS = 1_100;
export const GATEWAY_ALTERNATIVES = 16;
/** Other ways in put to the dry run when the first is refused (each is one read-only Bridge call). */
export const GATEWAY_DRY_RUN_RETRIES = 6;
/**
 * A component of at most this many streets that joins nothing and has no building beside it is a stub: a street that
 * serves nobody, carries no water or power, and takes land a district could use. Measured live (2026-10-03): the Goal
 * path left 40-120 m stubs of 1 street each beside the districts it was asked to serve.
 */
export const ORPHAN_STUB_MAXIMUM_STREETS = 2;
export const ORPHAN_STUB_BUILDING_CLEARANCE_METERS = 30;
/** A dead-end chain no longer than this, ending at a junction, with nothing built beside it, is a spur. */
export const SPUR_MAXIMUM_METERS = 130;
/** What a service need counts: notices for most, worn stretches of jammed roads for road maintenance (the game shows wear on the road panel, not as an icon). */
const evidence = (need: ServiceNeed, count: number): string => (need === "roads" ? `worn road stretch(es): ${count}` : `icons: ${count}`);
/** A street counts as laid by this Mayor when both its ends lie within this distance of one of the courses it submitted. */
export const OWN_COURSE_TOLERANCE_METERS = 3;
/** A district with less than this share of its planned streets standing is a failed fragment: not zoned, and its dead ends are pruned. */
export const MINIMUM_LANDED_SHARE = 0.6;
/** Land is bought only while no more than this share of the zoning on hand stands empty. */
export const CAPACITY_USED_MAXIMUM_UNREALIZED = 0.35;
/** A zoning brush stops this far short of the nearest building, and a spot that would need a smaller brush than the minimum is left alone. */
export const BRUSH_BUILDING_MARGIN_METERS = 8;
export const MINIMUM_BRUSH_RADIUS_METERS = 10;
/** Rezoning empty housing: only while this share of the housing zoning stands empty, never more than this share of the empty spots at once. */
export const REZONE_MINIMUM_UNREALIZED_SHARE = 0.4;
export const REZONE_MAXIMUM_SHARE_OF_EMPTY_HOMES = 0.5;
/** A brush spot covers about this many zoning cells; turns a share of the city into a number of spots. */
export const REZONE_CELLS_PER_SPOT = 30;
/** After rezoning, the empty housing must have fallen below this fraction of what it was, or the repaint is judged not to work. */
export const REZONE_PROGRESS_FLOOR = 0.98;
export const UNZONED_SCAN_WINDOW_METERS = 400;
/** Roads laid for buildings the game says have no road access, per cycle; and the cycles before the same spot is tried again. */
export const ROAD_ACCESS_REPAIRS_PER_CYCLE = 3;
/** "Not Connected" (power line, pipe) notices answered per cycle, tries per spot, courses per try, and how far a street may be for a buried link. */
export const UTILITY_LINK_REPAIRS_PER_CYCLE = 3;
export const UTILITY_LINK_ATTEMPTS_PER_SPOT = 4;
export const UTILITY_LINK_COURSES_PER_SPOT = 6;
export const UTILITY_LINK_MAXIMUM_METERS = 250;
/** A "Not Connected" notice must have stood this long before a link is laid (a fresh building shows it until the street's power reaches it). */
export const UTILITY_LINK_SETTLE_HOURS = 2;
export const UTILITY_LINK_SETTLE_CYCLES = 3;
/** An essential service (garbage, healthcare, deathcare) with at least this many icons is built when the treasury holds this much, whatever the runway. */
/** The ground of homes per resident, a starting figure (a mid-density district of 115,200 m2 holds about 3,000 people): the taper near the player's population target. */
export const NEAR_TARGET_SQUARE_METERS_PER_PERSON = 38;
/** The service buildings that serve nobody without a road, and may be taken down when none can ever reach them. */
const UNREACHABLE_FACILITY = /Landfill|Incinerat|Recycl|PowerPlant|Signature|Depot|Cemetery|Crematorium|PoliceStation|FireStation|FireHouse|Clinic|Hospital|Pump|Outlet|WastewaterTreatment|WaterTower|School|Library/i;
export const UNREACHABLE_DEMOLITIONS_PER_CYCLE = 1;
/** A big building's centre may stand at most this far beyond its own half-size from the nearest street: the access road is then short enough for the repair to lay. */
export const SITE_STREET_SLACK_METERS = 60;
export const BIG_SERVICE_CLEAR_COOLDOWN_HOURS = 12;
export const BIG_SERVICE_CLEAR_COOLDOWN_CYCLES = 12;
/** What is never taken down to make room: services, utilities, signature and civic buildings. */
const SERVICE_OR_SIGNATURE = /Signature|Hospital|Clinic|School|University|Police|Fire|Cemetery|Crematorium|Depot|Landfill|Incinerat|Recycl|Pump|Outlet|Tower|Plant|Transformer|Station|Park|Plaza|Library/i;
/** The land uses that may make room: low-density homes, shops and small workplaces. */
const LOW_DENSITY_LAND_USE = /ResidentialLow|CommercialLow|OfficeLow|Industrial.*Small/i;
export const ESSENTIAL_SERVICE_ICON_FLOOR = 10;
/**
 * A burning plant or a recycling centre costs about a million each (live 2026-10-07: two of them placed, left with no road and taken down again, took the
 * treasury from 2.7 million to 0.1). A garbage building that big is only started with this much in hand, whatever the icons say; small ones keep the old floor.
 */
export const ESSENTIAL_SERVICE_MINIMUM_TREASURY = 1_500_000;
/** Cycles a notice is left alone after a road was laid to it (the city has to run over the road before the notice can go). */
export const ROAD_ACCESS_SETTLE_CYCLES = 3;
/** Attempts of one ladder run (the plain road, then 12 m to each side); each is dry-run before it is built. */
export const ROAD_ACCESS_ATTEMPTS_PER_RUN = 3;
/** An icon standing this long past the repairs is reported as stuck (game hours; cycles when no clock). */
export const ISSUE_STUCK_HOURS = 6;
export const ISSUE_STUCK_CYCLES = 30;
/** The notices that say no street reaches a building: no road, no car, no pedestrian access. */
/** The net laid to a building that has no pedestrian access (the cheapest footpath the game offers that carries utilities). */
export const PEDESTRIAN_ACCESS_PREFAB = "Pedestrian Street Small";
export const ACCESS_NOTICE = /^No (Road|Car|Pedestrian) Access/i;
/** The "No Road Access" notice hangs in front of the lot; live 2026-10-05 it stood 24 m from the cemetery it belonged to. */
export const OWN_FACILITY_NOTICE_REACH_METERS = 45;
/** Points over a zoned district's footprint, at most this far apart: the isolation rule measures from points, so the gaps between them are land it cannot see. */
export const DISTRICT_FOOTPRINT_POINT_SPACING_METERS = 60;
/**
 * The points a zoned district stands for in the isolation rule (industry from homes, homes from polluters). Live 2026-10-05: a 160 x 720 m housing district was
 * known only by its four corners and its centre, so industry was laid 320 m from its long side where the rule asks for 400 m (the corner points were 400 m away).
 */
export function districtFootprintPoints(rect: { minX: number; minZ: number; maxX: number; maxZ: number }): SpatialPoint2[] {
  const across = (from: number, to: number) => {
    const steps = Math.max(1, Math.ceil((to - from) / DISTRICT_FOOTPRINT_POINT_SPACING_METERS));
    return Array.from({ length: steps + 1 }, (_, index) => from + ((to - from) * index) / steps);
  };
  const points: SpatialPoint2[] = [];
  for (const x of across(rect.minX, rect.maxX)) for (const z of across(rect.minZ, rect.maxZ)) points.push({ x, z });
  return points;
}
/** What one try at a facility's road looked like and how it ended (see `DistrictBuilderPort.recordAccessAttempt`). */
export interface AccessAttemptRecord {
  kind: "FACILITY_ACCESS_ROAD";
  frame: number | null;
  noticeAt: SpatialPoint2;
  distanceToStreetMeters: number;
  candidatesTried: number;
  /** The rung that was accepted (its reason string), or null. */
  acceptedReason: string | null;
  /** The game's dry-run answers, in order. */
  verdicts: string[];
  outcome: "BUILT" | "BUILD_REFUSED" | "NO_ACCEPTED_ROAD";
}
/** The size of an unknown facility as the ladder sees it: the smallest, so the first sideways rung is 12 m. */
export const ROAD_ACCESS_FACILITY_HALF_EXTENT_METERS = 6;
/** Cycles in a row the district's zoning waits for a missing water, power or sewage network before it goes on without it. */
export const UTILITY_ZONING_HOLD_MAXIMUM_CYCLES = 4;
/** Zoning brushes written between two fresh reads of the ground (a run is a few seconds; a district's brushes are a minute). */
export const ZONING_WRITE_RUN = 80;
/** The longest side of one district: inside the game's single-street range (1500 m) with room for the block rounding. */
export const MAXIMUM_DISTRICT_SIDE_METERS = 1200;
/** Calls the whole-ground planning read is kept for (about one a decision); a purchase of land or a load makes a new read at once. */
export const GROUND_READ_MAXIMUM_AGE_CALLS = 6;
/** Cycles between two sweeps of the owned ground for unzoned frontage when nothing was built meanwhile (64 window reads, ~15 s each sweep). */
export const UNZONED_SPOTS_PER_CYCLE = 450;
export const DISTRICT_ROAD_PREFAB = "Medium Road";
/** Largest first: the builder takes the biggest district the land holds. Every size is a whole number of lattice steps. */
export const DISTRICT_SHAPES: ReadonlyArray<{ columnWidths: number[]; rowHeights: number[] }> = [
  // Founding districts: about 3.4x and 2.5x the old largest, on the SAME block spacing (120/160 m) so every block still
  // fills with buildings. They are for a treasury that can pay for them (see `maximumAreaSquareMeters`) and for land that
  // holds them; where the ground or the border is tighter the ladder falls through to the smaller districts below.
  { columnWidths: [120, 160, 120, 160, 120, 160, 120, 160], rowHeights: [120, 160, 120, 160, 120] },
  { columnWidths: [120, 160, 120, 160, 120, 160], rowHeights: [120, 160, 120, 160, 120] },
  { columnWidths: [120, 160, 120, 160], rowHeights: [120, 160, 120] },
  { columnWidths: [120, 160, 120], rowHeights: [120, 160] },
  { columnWidths: [120, 120], rowHeights: [120, 120] },
];
/** Existing roads and buildings must stay this far outside the district's ring. */
export const DISTRICT_CLEARANCE_METERS = 12;
/** The longest gateway a district may need to reach the served network. */
export const MAXIMUM_GATEWAY_METERS = 320;
/** A tile with less buildable land than this share is not worth its upkeep (water and mountain do not hold a district). */
export const MINIMUM_TILE_USABLE_SHARE = 0.4;
/** Zoning brush: centred this far inside a block from its street, this wide, every `ZONE_SPOT_SPACING` along it. */
export const ZONE_SPOT_INSET_METERS = 28;
export const ZONE_SPOT_RADIUS_METERS = 36;
export const ZONE_SPOT_SPACING_METERS = 40;

export type DistrictRole = "residential" | "commercial" | "industrial";

/** Items ordered nearest `target` first (a stable sort: equal distances keep their order). */
export function nearestFirst<T>(items: readonly T[], target: SpatialPoint2, at: (item: T) => SpatialPoint2): T[] {
  return items.map((item, index) => ({ item, index, distance: Math.hypot(at(item).x - target.x, at(item).z - target.z) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index).map((entry) => entry.item);
}

/**
 * Pollution and noise isolation, the way a player keeps industry away from homes: housing never goes within
 * `RESIDENTIAL_POLLUTER_BUFFER_METERS` of industry or a polluting facility, and an industrial district never within
 * `INDUSTRIAL_RESIDENTIAL_BUFFER_METERS` of housing. Measured live: the existing city mixes the two and the game
 * raises noise warnings across several neighbourhoods.
 */
export const RESIDENTIAL_POLLUTER_BUFFER_METERS = 320;
export const INDUSTRIAL_RESIDENTIAL_BUFFER_METERS = 400;
/**
 * The distances industry keeps from homes, widest first. A city whose districts already cover its owned ground has no site 400 m from every home, and
 * with the jobs short that left the Mayor waiting for ever (live 2026-10-07: unemployment 48%, the game's industrial demand bar full, no industrial
 * district laid). Each complete search that finds no site moves one step down; a district laid resets to the widest.
 */
export const INDUSTRIAL_BUFFER_STEPS_METERS: readonly number[] = [INDUSTRIAL_RESIDENTIAL_BUFFER_METERS, 260, 180];

export interface DistrictLandUse {
  /** Homes, schools, clinics: what pollution and noise must stay away from. */
  sensitive: SpatialPoint2[];
  /** Industry, power plants, sewage, landfill: what housing must stay away from. */
  polluters: SpatialPoint2[];
  /** Railway and highway, sampled along their length: noise that homes keep `RESIDENTIAL_LOUD_BUFFER_METERS` from (measured live 2026-10-07: 39 noise icons in one housing district beside a double railway). */
  loud?: SpatialPoint2[];
}
export const RESIDENTIAL_LOUD_BUFFER_METERS = 100;
const LOUD_ROAD = /train|rail|highway|motorway|subway/i;
/** Points every ~50 m along the railways and highways of the world. */
export function loudPoints(edges: ReadonlyArray<{ prefab: string; start: SpatialPoint2; end: SpatialPoint2 }>): SpatialPoint2[] {
  const points: SpatialPoint2[] = [];
  for (const edge of edges) {
    if (!LOUD_ROAD.test(edge.prefab)) continue;
    const length = Math.hypot(edge.end.x - edge.start.x, edge.end.z - edge.start.z);
    const steps = Math.max(1, Math.ceil(length / 50));
    for (let step = 0; step <= steps; step += 1) points.push({ x: edge.start.x + ((edge.end.x - edge.start.x) * step) / steps, z: edge.start.z + ((edge.end.z - edge.start.z) * step) / steps });
  }
  return points;
}

export type BuildingClass = "sensitive" | "polluter" | "neutral";
const POLLUTER = /industr|manufactur|warehouse|extractor|factory|\boil\b|ore|forestry|agricultur|farm|coal|gas ?power|power ?plant|sewage|wastewater|landfill|incinerat|recycl|cargo|harbor|harbour|airport/i;
const SENSITIVE = /residential|school|university|college|clinic|hospital|park|elementary|high ?school/i;
/** What a building is to its neighbours, read from its prefab name. */
export function classifyBuilding(prefab: string): BuildingClass {
  if (POLLUTER.test(prefab)) return "polluter";
  if (SENSITIVE.test(prefab)) return "sensitive";
  return "neutral";
}

const rectDistance = (point: SpatialPoint2, rect: { minX: number; minZ: number; maxX: number; maxZ: number }) =>
  Math.hypot(Math.max(rect.minX - point.x, 0, point.x - rect.maxX), Math.max(rect.minZ - point.z, 0, point.z - rect.maxZ));

export interface DistrictSite {
  anchor: SpatialPoint2;
  columnWidths: number[];
  rowHeights: number[];
  widthMeters: number;
  heightMeters: number;
  /** From a served-network node to the district's ring. */
  gateway: { from: SpatialPoint2; to: SpatialPoint2; lengthMeters: number };
  /** Other entrances, shortest first, tried when the ground refuses `gateway`. */
  alternativeGateways?: Array<{ from: SpatialPoint2; to: SpatialPoint2; lengthMeters: number }>;
  score: number;
}

export interface DistrictCourse {
  id: string;
  kind: "GATEWAY" | "RING" | "LOCAL";
  start: SpatialPoint2;
  end: SpatialPoint2;
  lengthMeters: number;
}

export interface DistrictZoneSpot {
  center: SpatialPoint2;
  radius: number;
  /** True for the outer face of a block that faces the district's ring street. */
  onRing: boolean;
}

export interface DistrictPlan {
  site: DistrictSite;
  courses: DistrictCourse[];
  zoneSpots: DistrictZoneSpot[];
}

const key = (ref: { index: number; version: number }) => `${ref.index}:${ref.version}`;
/** Highways, ramps and cables are not city streets: no district joins one, and none of them carries a facility's service. */
const NOT_A_CITY_STREET = /highway|motorway|ramp|expressway|pipe|cable|sewer/i;
/**
 * The city's main street network: the city streets of the largest connected component of the WHOLE road graph. A
 * highway joins parts of the city (ramps are real connections), so connectivity is judged with it; but a district never
 * joins a highway itself and a facility never attaches to one, so only the streets are returned. A component the main
 * network does not reach — a highway piece on the map border, a district whose gateway the world refused — is not main.
 */
export function mainStreetNetwork(graph: { nodes: readonly SpatialRoadNode[]; edges: readonly SpatialRoadEdge[] }): {
  nodes: SpatialRoadNode[]; edges: SpatialRoadEdge[]; components: RoadComponent[]; main: RoadComponent | null;
} {
  const components = roadComponents(graph);
  const main = components[0] ?? null;
  if (!main) return { nodes: [], edges: [], components, main };
  const edges = main.edges.filter((edge) => !NOT_A_CITY_STREET.test(edge.prefab));
  const used = new Set(edges.flatMap((edge) => [key(edge.startNode), key(edge.endNode)]));
  return { nodes: main.nodes.filter((node) => used.has(key(node.entity))), edges, components, main };
}
/** A site's identity: whole metres, because the lattice origin is a mean over buildings and moves by float noise between reads. */
const anchorKey = (anchor: SpatialPoint2, size?: { widthMeters: number; heightMeters: number }) =>
  `${Math.round(anchor.x)},${Math.round(anchor.z)}${size ? `,${size.widthMeters}x${size.heightMeters}` : ""}`;
const length = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(b.x - a.x, b.z - a.z);

function pointSegmentDistance(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
}

function segmentsCross(a1: SpatialPoint2, a2: SpatialPoint2, b1: SpatialPoint2, b2: SpatialPoint2): boolean {
  const cross = (o: SpatialPoint2, p: SpatialPoint2, q: SpatialPoint2) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

interface Rect { minX: number; minZ: number; maxX: number; maxZ: number }
const inRect = (point: SpatialPoint2, rect: Rect) =>
  point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ;
function segmentTouchesRect(start: SpatialPoint2, end: SpatialPoint2, rect: Rect): boolean {
  if (inRect(start, rect) || inRect(end, rect)) return true;
  const corners = [{ x: rect.minX, z: rect.minZ }, { x: rect.maxX, z: rect.minZ }, { x: rect.maxX, z: rect.maxZ }, { x: rect.minX, z: rect.maxZ }];
  return corners.some((corner, index) => segmentsCross(start, end, corner, corners[(index + 1) % 4]!));
}

/**
 * The lattice the city's own axis-aligned streets already sit on, so a new district continues the grid instead of
 * starting a second one beside it. The most common (x mod 40, z mod 40) over the nodes of axis-aligned edges; the world
 * origin when the city has none.
 */
export function districtLatticeOrigin(world: Pick<SpatialWorldModel, "roadGraph">): SpatialPoint2 {
  const spacing = GRID_LATTICE_SPACING_METERS;
  const nodeByKey = new Map(world.roadGraph.nodes.map((node) => [key(node.entity), node]));
  // Votes are bucketed by whole metre but the answer is the bucket's MEAN, not its key: measured live, the product's
  // grid sits at (2.5, 17.5) mod 40, and a rounded origin puts every new line half a metre off the old ones.
  const votes = new Map<string, { sumX: number; sumZ: number; count: number }>();
  const modulo = (value: number) => ((value % spacing) + spacing) % spacing;
  for (const edge of world.roadGraph.edges) {
    if (edge.deleted || edge.temp) continue;
    const a = nodeByKey.get(key(edge.startNode))?.position;
    const b = nodeByKey.get(key(edge.endNode))?.position;
    if (!a || !b) continue;
    const dx = Math.abs(b.x - a.x);
    const dz = Math.abs(b.z - a.z);
    if (Math.min(dx, dz) > 0.5 || Math.max(dx, dz) < 20) continue;
    for (const point of [a, b]) {
      const x = modulo(point.x);
      const z = modulo(point.z);
      const bucket = `${Math.round(x) % spacing},${Math.round(z) % spacing}`;
      const vote = votes.get(bucket) ?? { sumX: 0, sumZ: 0, count: 0 };
      vote.sumX += x;
      vote.sumZ += z;
      vote.count += 1;
      votes.set(bucket, vote);
    }
  }
  const best = [...votes.values()].sort((left, right) => right.count - left.count)[0];
  return best ? { x: best.sumX / best.count, z: best.sumZ / best.count } : { x: 0, z: 0 };
}

/**
 * Every district the owned, empty land can hold, best first. Pure: the world, the buildings and the land are inputs.
 *
 * Best = biggest, then shortest gateway to the served network, then closest to the city. A player grows the city
 * outward from what is already there; a short gateway is what "outward from" means on the ground.
 */
export interface DistrictSurveyDiagnostics {
  noOwnedTiles: boolean;
  noServedRoadNetwork: boolean;
  considered: number;
  excluded: number;
  outsideOwnedLand: number;
  buildingClearance: number;
  landUseIsolation: number;
  /** Sites (or every way into them) reaching an area the player asked to keep. */
  protectedArea?: number;
  existingRoad: number;
  noGateway: number;
  blockedGateway: number;
  eligible: number;
  limitReached: boolean;
  offered: number;
}

function emptySurveyDiagnostics(): DistrictSurveyDiagnostics {
  return { noOwnedTiles: false, noServedRoadNetwork: false, considered: 0, excluded: 0, outsideOwnedLand: 0,
    buildingClearance: 0, landUseIsolation: 0, existingRoad: 0, noGateway: 0, blockedGateway: 0, eligible: 0, limitReached: false, offered: 0 };
}

export function surveyDistrictSites(input: {
  world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">;
  buildings: readonly SpatialPoint2[];
  /** Anchors already tried and refused this session, as `x,z` keys. */
  excludedAnchors?: ReadonlySet<string>;
  limit?: number;
  /** The district's role and what it must keep away from. Omitted: no isolation is applied. */
  role?: DistrictRole;
  landUse?: DistrictLandUse;
  /** How far industry keeps from homes this time (default `INDUSTRIAL_RESIDENTIAL_BUFFER_METERS`; see `INDUSTRIAL_BUFFER_STEPS_METERS`). */
  industrialBufferMeters?: number;
  /** The largest district the treasury should pay for now; bigger shapes are not offered. */
  maximumAreaSquareMeters?: number;
  /** The land's maximal rectangles (see `district-land.ts`). Present: districts are laid on these instead of the shape ladder. */
  rectangles?: readonly LandRectangle[];
  /** Optional counts of the exact filters that removed candidates. */
  diagnostics?: DistrictSurveyDiagnostics;
  /** Areas the player asked to keep (`protection.ts`): a site or a way in that reaches one is not offered. */
  protection?: Pick<ProtectionRegistry, "rect" | "segment">;
}): DistrictSite[] {
  const spacing = GRID_LATTICE_SPACING_METERS;
  const origin = districtLatticeOrigin(input.world);
  const tiles = input.world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
  if (tiles.length === 0) { if (input.diagnostics) input.diagnostics.noOwnedTiles = true; return []; }
  const isOwned = (point: SpatialPoint2) => tiles.some((tile) => pointInTile(point, tile));
  const liveEdges = input.world.roadGraph.edges.filter((edge) => !edge.deleted && !edge.temp);
  const nodeByKey = new Map(input.world.roadGraph.nodes.map((node) => [key(node.entity), node]));
  const servedNodes = mainStreetNetwork(input.world.roadGraph).nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
  if (servedNodes.length === 0) { if (input.diagnostics) input.diagnostics.noServedRoadNetwork = true; return []; }
  const centroid = {
    x: servedNodes.reduce((sum, point) => sum + point.x, 0) / servedNodes.length,
    z: servedNodes.reduce((sum, point) => sum + point.z, 0) / servedNodes.length,
  };
  const edgeEnds = (edge: SpatialRoadEdge) => {
    const a = nodeByKey.get(key(edge.startNode))?.position ?? edge.start;
    const b = nodeByKey.get(key(edge.endNode))?.position ?? edge.end;
    return [{ x: a.x, z: a.z }, { x: b.x, z: b.z }] as const;
  };
  const degree = new Map<string, number>();
  for (const edge of liveEdges) {
    for (const ref of [edge.startNode, edge.endNode]) degree.set(key(ref), (degree.get(key(ref)) ?? 0) + 1);
  }
  const edgeLines = liveEdges.map((edge) => {
    const [a, b] = edgeEnds(edge);
    // The free end of a dead-end street: where an earlier gateway stopped on a district's ring.
    const freeEnd = degree.get(key(edge.endNode)) === 1 ? b : degree.get(key(edge.startNode)) === 1 ? a : null;
    return { a, b, freeEnd };
  });
  const onRing = (point: SpatialPoint2, rect: Rect) =>
    (Math.abs(point.x - rect.minX) < 1.5 || Math.abs(point.x - rect.maxX) < 1.5) && point.z >= rect.minZ - 1.5 && point.z <= rect.maxZ + 1.5 ||
    (Math.abs(point.z - rect.minZ) < 1.5 || Math.abs(point.z - rect.maxZ) < 1.5) && point.x >= rect.minX - 1.5 && point.x <= rect.maxX + 1.5;

  const bounds = tiles.reduce((acc, tile) => ({
    minX: Math.min(acc.minX, tile.bounds!.min.x), minZ: Math.min(acc.minZ, tile.bounds!.min.z),
    maxX: Math.max(acc.maxX, tile.bounds!.max.x), maxZ: Math.max(acc.maxZ, tile.bounds!.max.z),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  const snap = (value: number, offset: number) => Math.ceil((value - offset) / spacing) * spacing + offset;

  // The isolation this role keeps (industry from homes, homes from polluters), read once for every placement.
  const keepAway = input.landUse && input.role
    ? input.role === "industrial"
      ? { points: input.landUse.sensitive, meters: input.industrialBufferMeters ?? INDUSTRIAL_RESIDENTIAL_BUFFER_METERS }
      : { points: input.landUse.polluters, meters: RESIDENTIAL_POLLUTER_BUFFER_METERS, also: [{ points: input.landUse.loud ?? [], meters: RESIDENTIAL_LOUD_BUFFER_METERS }] }
    : null;
  // A buffer is land the zoning keeps clear, not land a street may not cross. With the gateway capped below the buffer, an industrial district
  // could never be joined while the only served streets were those of the housing it must stay 400 m from (measured live 2026-10-04, clean
  // start: noGateway on 50 of 50 industrial candidates beside 131 ha of free land, and the city stopped after its first district). So a role
  // that keeps a buffer reaches past it: the buffer plus two lattice steps. Without anything to keep away from, the short cap stands.
  const gatewayReach = keepAway && keepAway.points.length > 0
    ? Math.max(MAXIMUM_GATEWAY_METERS, keepAway.meters + 2 * spacing) : MAXIMUM_GATEWAY_METERS;

  const sites: DistrictSite[] = [];
  // Where a district could stand: the land's own maximal rectangles when the caller has read the ground, otherwise the
  // fixed ladder of shapes at every lattice offset (tests, tools, and a host that cannot read terrain).
  const placements: Array<{ x: number; z: number; widthMeters: number; heightMeters: number; columnWidths: number[]; rowHeights: number[]; shapeIndex: number }> = [];
  if (input.rectangles) {
    for (const rectangle of input.rectangles) {
      // A rectangle bigger than the treasury should pay for is built smaller INSIDE, from its corner, not skipped: the size follows the
      // cash (study: build scale grows with what the city can carry). Measured live (2026-10-04): with a tight treasury every free
      // rectangle of the owned ground was bigger than the cap, the survey found 0 sites, and the Mayor idled beside 237 ha of free land.
      // A district's side stays inside what the game can lay as one street (8-1500 m): a whole empty map is built district by district, from the
      // corner, not as one 1840 m grid (measured live 2026-10-04, clean start: the grid refused, the builder threw, and nothing was built).
      let fitWidth = Math.min(rectangle.widthMeters, MAXIMUM_DISTRICT_SIDE_METERS);
      let fitHeight = Math.min(rectangle.heightMeters, MAXIMUM_DISTRICT_SIDE_METERS);
      let columnWidths = composeBlocks(fitWidth);
      let rowHeights = composeBlocks(fitHeight);
      if (input.maximumAreaSquareMeters !== undefined) {
        const cap = input.maximumAreaSquareMeters;
        while (fitWidth >= MINIMUM_RECTANGLE_SIDE_METERS && fitHeight >= MINIMUM_RECTANGLE_SIDE_METERS) {
          columnWidths = composeBlocks(fitWidth);
          rowHeights = composeBlocks(fitHeight);
          const area = (columnWidths ? columnWidths.reduce((sum, value) => sum + value, 0) : fitWidth) * (rowHeights ? rowHeights.reduce((sum, value) => sum + value, 0) : fitHeight);
          if (columnWidths && rowHeights && area <= cap) break;
          if (fitWidth >= fitHeight) fitWidth -= spacing; else fitHeight -= spacing;
          columnWidths = null;
          rowHeights = null;
        }
      }
      if (!columnWidths || !rowHeights) continue;
      const widthMeters = columnWidths.reduce((sum, value) => sum + value, 0);
      const heightMeters = rowHeights.reduce((sum, value) => sum + value, 0);
      if (input.maximumAreaSquareMeters !== undefined && widthMeters * heightMeters > input.maximumAreaSquareMeters) continue;
      // A district smaller than its rectangle (the batch, or the side cap) can stand in any corner of it; the corner beside the served street is
      // the one with a gateway. Always taking the lower-left corner left every shrunk district further than the gateway reach from the network
      // (measured live 2026-10-04: noGateway on 16 of 16 rectangles for ten decisions, while the same rectangles at full size had a 40 m gateway).
      // The corners overlap when the district fills the rectangle; the survey keeps the best of overlapping candidates.
      const xs = [...new Set([rectangle.minX, rectangle.minX + rectangle.widthMeters - widthMeters])];
      const zs = [...new Set([rectangle.minZ, rectangle.minZ + rectangle.heightMeters - heightMeters])];
      for (const cornerX of xs) for (const cornerZ of zs) {
        placements.push({ x: cornerX, z: cornerZ, widthMeters, heightMeters, columnWidths, rowHeights, shapeIndex: 0 });
      }
    }
  } else {
    for (const [shapeIndex, shape] of DISTRICT_SHAPES.entries()) {
      const widthMeters = shape.columnWidths.reduce((sum, value) => sum + value, 0);
      const heightMeters = shape.rowHeights.reduce((sum, value) => sum + value, 0);
      if (input.maximumAreaSquareMeters !== undefined && widthMeters * heightMeters > input.maximumAreaSquareMeters) continue;
      for (let x = snap(bounds.minX, origin.x); x + widthMeters <= bounds.maxX; x += spacing) {
        for (let z = snap(bounds.minZ, origin.z); z + heightMeters <= bounds.maxZ; z += spacing) {
          placements.push({ x, z, widthMeters, heightMeters, columnWidths: shape.columnWidths, rowHeights: shape.rowHeights, shapeIndex });
        }
      }
    }
  }
  for (const placement of placements) {
      {
        if (input.diagnostics) input.diagnostics.considered += 1;
        const { x, z, widthMeters, heightMeters, shapeIndex } = placement;
        // A refusal belongs to the shape that was refused: the same corner may still hold a smaller district.
        if (input.excludedAnchors?.has(anchorKey({ x, z }, { widthMeters, heightMeters }))) {
          if (input.diagnostics) input.diagnostics.excluded += 1;
          continue;
        }
        const rect = { minX: x, minZ: z, maxX: x + widthMeters, maxZ: z + heightMeters };
        // Every sample of the ring and the interior must be on owned land.
        let ownedEverywhere = true;
        for (let sx = rect.minX; sx <= rect.maxX && ownedEverywhere; sx += spacing) {
          for (let sz = rect.minZ; sz <= rect.maxZ; sz += spacing) {
            if (!isOwned({ x: sx, z: sz })) { ownedEverywhere = false; break; }
          }
        }
        if (!ownedEverywhere) { if (input.diagnostics) input.diagnostics.outsideOwnedLand += 1; continue; }
        const clear = {
          minX: rect.minX - DISTRICT_CLEARANCE_METERS, minZ: rect.minZ - DISTRICT_CLEARANCE_METERS,
          maxX: rect.maxX + DISTRICT_CLEARANCE_METERS, maxZ: rect.maxZ + DISTRICT_CLEARANCE_METERS,
        };
        if (input.buildings.some((point) => inRect(point, clear))) {
          if (input.diagnostics) input.diagnostics.buildingClearance += 1;
          continue;
        }
        if (keepAway && keepAwayBlocks(keepAway, (point) => rectDistance(point, rect))) {
          if (input.diagnostics) input.diagnostics.landUseIsolation += 1;
          continue;
        }
        // The zoning brushes reach past the ring by the clearance, so the kept area is held that far off.
        if (input.protection?.rect(rect.minX, rect.minZ, rect.maxX, rect.maxZ, DISTRICT_CLEARANCE_METERS)) {
          if (input.diagnostics) input.diagnostics.protectedArea = (input.diagnostics.protectedArea ?? 0) + 1;
          continue;
        }
        // A dead-end street that stops ON this ring is this district's own gateway from an earlier cycle, not an
        // obstacle; anything else near the district is.
        const strictInterior = { minX: rect.minX + 1.5, minZ: rect.minZ + 1.5, maxX: rect.maxX - 1.5, maxZ: rect.maxZ - 1.5 };
        if (edgeLines.some(({ a, b, freeEnd }) => freeEnd && onRing(freeEnd, rect)
          ? segmentTouchesRect(a, b, strictInterior) && !onRing(a, rect) && !onRing(b, rect)
          : segmentTouchesRect(a, b, clear))) {
          if (input.diagnostics) input.diagnostics.existingRoad += 1;
          continue;
        }
        // The gateway: the served node nearest any 40 m station of the ring.
        let gateway: DistrictSite["gateway"] | null = null;
        const stations: SpatialPoint2[] = [];
        for (let sx = rect.minX; sx <= rect.maxX; sx += spacing) stations.push({ x: sx, z: rect.minZ }, { x: sx, z: rect.maxZ });
        for (let sz = rect.minZ + spacing; sz < rect.maxZ; sz += spacing) stations.push({ x: rect.minX, z: sz }, { x: rect.maxX, z: sz });
        // An earlier gateway already reaching a station: the district is joined there and needs no new gateway.
        for (const node of servedNodes) {
          const station = stations.find((candidate) => length(node, candidate) < 1.5);
          if (station) { gateway = { from: node, to: node, lengthMeters: 0 }; break; }
        }
        const gatewayOptions: DistrictSite["gateway"][] = [];
        for (const node of gateway ? [] : servedNodes) {
          if (Math.abs(node.x - (rect.minX + rect.maxX) / 2) > widthMeters / 2 + gatewayReach ||
            Math.abs(node.z - (rect.minZ + rect.maxZ) / 2) > heightMeters / 2 + gatewayReach) continue;
          for (const station of stations) {
            const meters = length(node, station);
            if (meters < 12 || meters > gatewayReach) continue;
            if (input.protection?.segment(node, station)) continue;
            gatewayOptions.push({ from: node, to: station, lengthMeters: meters });
            if (!gateway || meters < gateway.lengthMeters) gateway = { from: node, to: station, lengthMeters: meters };
          }
        }
        if (!gateway) { if (input.diagnostics) input.diagnostics.noGateway += 1; continue; }
        // The gateway itself must not run through a building. The shortest entrance is not the only one: the next-shortest that runs clear of
        // buildings is taken (measured live 2026-10-04: the shortest was blocked for all 4 usable rectangles, the survey found 0 sites and the
        // Mayor idled beside 174 ha of free land, though a clear entrance existed for each).
        let usableGateways = gatewayOptions.sort((left, right) => left.lengthMeters - right.lengthMeters);
        if (gateway.lengthMeters > 0) {
          usableGateways = usableGateways.filter((option) => !input.buildings.some((point) => pointSegmentDistance(point, option.from, option.to) < 10));
          if (usableGateways.length === 0) { if (input.diagnostics) input.diagnostics.blockedGateway += 1; continue; }
          gateway = usableGateways[0]!;
        }
        // The next-shortest entrances, for when the ground refuses the shortest (a short gateway up a 18% slope).
        const alternativeGateways = usableGateways.slice(0, GATEWAY_ALTERNATIVES);
        const area = widthMeters * heightMeters;
        const score = area / 1_000 - gateway.lengthMeters * 0.4 - length(centroid, { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 }) * 0.02
          - shapeIndex * 50;
        sites.push({ anchor: { x, z }, columnWidths: [...placement.columnWidths], rowHeights: [...placement.rowHeights],
          widthMeters, heightMeters, gateway, score, alternativeGateways });
      }
  }
  sites.sort((left, right) => right.score - left.score);
  if (input.diagnostics) input.diagnostics.eligible = sites.length;
  // Overlapping candidates are the same piece of land; keep the best of each.
  const kept: DistrictSite[] = [];
  for (const site of sites) {
    const overlaps = kept.some((other) =>
      site.anchor.x < other.anchor.x + other.widthMeters && other.anchor.x < site.anchor.x + site.widthMeters &&
      site.anchor.z < other.anchor.z + other.heightMeters && other.anchor.z < site.anchor.z + site.heightMeters);
    if (!overlaps) kept.push(site);
    if (kept.length >= (input.limit ?? 8)) break;
  }
  if (input.diagnostics) input.diagnostics.offered = kept.length;
  if (input.diagnostics) input.diagnostics.limitReached = kept.length >= (input.limit ?? 8) && sites.some((site) =>
    !kept.some((other) => site.anchor.x < other.anchor.x + other.widthMeters && other.anchor.x < site.anchor.x + site.widthMeters &&
      site.anchor.z < other.anchor.z + other.heightMeters && other.anchor.z < site.anchor.z + site.heightMeters));
  return kept;
}

/** The ground this district needs to read before it is planned: its rectangle plus the gateway. */
export function districtTerrainWindow(site: DistrictSite): { center: SpatialPoint2; radius: number } {
  const minX = Math.min(site.anchor.x, site.gateway.from.x);
  const minZ = Math.min(site.anchor.z, site.gateway.from.z);
  const maxX = Math.max(site.anchor.x + site.widthMeters, site.gateway.from.x);
  const maxZ = Math.max(site.anchor.z + site.heightMeters, site.gateway.from.z);
  return { center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    radius: Math.max(64, Math.min(DISTRICT_TERRAIN_WINDOW_MAXIMUM_METERS, Math.hypot(maxX - minX, maxZ - minZ) / 2 + 24)) };
}

/**
 * The whole district as courses and zoning spots. Returns null when the ground refuses any grid line or the gateway:
 * a district with a hole in its ring is a different district, and the survey offers the next one.
 */
export function compileDistrict(site: DistrictSite, terrain?: SpatialLocalTerrain, why?: { reason?: "GRID_UNPLANNABLE" | "TERRAIN_LOSS" | "GATEWAY_GROUND" }): DistrictPlan | null {
  // A grid the game cannot lay (a line outside its single-street range) is a district the ground refuses, not a failure of the whole cycle.
  let planned: ReturnType<typeof planRectangularGrid>;
  try {
    planned = planRectangularGrid({ anchor: site.anchor, columnWidths: site.columnWidths, rowHeights: site.rowHeights });
  } catch {
    if (why) why.reason = "GRID_UNPLANNABLE";
    return null;
  }
  const lastColumn = site.columnWidths.length;
  const lastRow = site.rowHeights.length;
  // A grid line is kept whole when the ground allows it; a line the ground refuses is cut back to the blocks it does
  // allow (a street stops at a lake and carries on after it), so one bad stretch no longer costs the whole district.
  // The district is still refused when too much of its street length is lost to the ground.
  const lines: Array<{ segment: (typeof planned)[number]; piece: number | null }> = planned.map((segment) => ({ segment, piece: null }));
  if (terrain) {
    const filtered = filterGridSegmentsByTerrain({ segments: planned, terrain, maxGradePercent: DISTRICT_ROAD_GRADE_PERCENT });
    if (filtered.rejected.length > 0) {
      const columnCuts = [site.anchor.x]; for (const width of site.columnWidths) columnCuts.push(columnCuts[columnCuts.length - 1]! + width);
      const rowCuts = [site.anchor.z]; for (const height of site.rowHeights) rowCuts.push(rowCuts[rowCuts.length - 1]! + height);
      const keptWhole = new Set(filtered.kept);
      const pieces: Array<{ segment: (typeof planned)[number]; piece: number | null }> = lines.filter((entry) => keptWhole.has(entry.segment));
      let droppedMeters = 0;
      for (const { segment } of filtered.rejected) {
        const vertical = segment.orientation === "VERTICAL";
        const cuts = vertical ? rowCuts : columnCuts;
        const blocks = cuts.slice(0, -1).map((from, index) => {
          const to = cuts[index + 1]!;
          const start = vertical ? { x: segment.start.x, z: from } : { x: from, z: segment.start.z };
          const end = vertical ? { x: segment.start.x, z: to } : { x: to, z: segment.start.z };
          return { ...segment, start, end, lengthMeters: to - from, cutIndex: index };
        });
        const sub = filterGridSegmentsByTerrain({ segments: blocks, terrain, maxGradePercent: DISTRICT_ROAD_GRADE_PERCENT });
        droppedMeters += sub.rejected.reduce((sum, entry) => sum + entry.segment.lengthMeters, 0);
        pieces.push(...sub.kept.map((kept) => ({ segment: kept, piece: kept.cutIndex })));
      }
      const totalMeters = planned.reduce((sum, segment) => sum + segment.lengthMeters, 0);
      if (droppedMeters > totalMeters * MAXIMUM_TERRAIN_LOSS_SHARE) { if (why) why.reason = "TERRAIN_LOSS"; return null; }
      lines.length = 0;
      lines.push(...pieces);
    }
    if (site.gateway.lengthMeters >= 1) {
      const passes = (gateway: DistrictSite["gateway"]) => filterGridSegmentsByTerrain({ segments: [{ ...planned[0]!,
        start: gateway.from, end: gateway.to, lengthMeters: gateway.lengthMeters }], terrain, maxGradePercent: GATEWAY_ROAD_GRADE_PERCENT }).rejected.length === 0;
      if (!passes(site.gateway)) {
        const open = (site.alternativeGateways ?? []).find(passes);
        if (!open) { if (why) why.reason = "GATEWAY_GROUND"; return null; }
        site = { ...site, gateway: open };
      }
    }
  }
  // A gateway an earlier cycle already built has no course of its own; its node is where the ring starts.
  const courses: DistrictCourse[] = site.gateway.lengthMeters < 1 ? [] : [{ id: "gateway", kind: "GATEWAY",
    start: site.gateway.from, end: site.gateway.to, lengthMeters: site.gateway.lengthMeters }];
  for (const { segment: line, piece } of lines) {
    const ring = line.orientation === "VERTICAL"
      ? line.lineIndex === 0 || line.lineIndex === lastColumn
      : line.lineIndex === 0 || line.lineIndex === lastRow;
    const id = `${line.orientation === "VERTICAL" ? "v" : "h"}${line.lineIndex}${piece === null ? "" : `p${piece}`}`;
    const entry = site.gateway.to;
    // The line the gateway lands on is split there, so both halves start on the gateway's own node.
    const onLine = pointSegmentDistance(entry, line.start, line.end) < 1.5 && length(entry, line.start) > 1.5 && length(entry, line.end) > 1.5;
    if (onLine) {
      courses.push({ id: `${id}a`, kind: ring ? "RING" : "LOCAL", start: entry, end: line.start, lengthMeters: length(entry, line.start) });
      courses.push({ id: `${id}b`, kind: ring ? "RING" : "LOCAL", start: entry, end: line.end, lengthMeters: length(entry, line.end) });
    } else {
      courses.push({ id, kind: ring ? "RING" : "LOCAL", start: line.start, end: line.end, lengthMeters: line.lengthMeters });
    }
  }
  // The outer frame first, then the streets inside it: the district's extent is claimed before its interior is filled.
  const order = { GATEWAY: 0, RING: 1, LOCAL: 2 } as const;
  courses.sort((left, right) => order[left.kind] - order[right.kind]);
  // Nothing is zoned on water or on a mountain: a brush there grows no building, and the attempt is not repeated.
  const zoneSpots = districtZoneSpots(site).filter((spot) => {
    if (!terrain) return true;
    const reading = sampleTerrain(terrain, spot.center);
    if (!reading || reading.waterDepth > 0.05) return false;
    const slope = slopePercentAround(terrain, spot.center, spot.radius / 2);
    return slope === null || slope <= ZONING_SLOPE_PERCENT;
  });
  return { site, courses, zoneSpots };
}

/** Zoning brush spots along every block face, inset into the block so the brush never reaches across a street. */
export function districtZoneSpots(site: DistrictSite): DistrictZoneSpot[] {
  const spots: DistrictZoneSpot[] = [];
  const xs = [site.anchor.x];
  for (const width of site.columnWidths) xs.push(xs[xs.length - 1]! + width);
  const zs = [site.anchor.z];
  for (const height of site.rowHeights) zs.push(zs[zs.length - 1]! + height);
  const inset = ZONE_SPOT_INSET_METERS;
  for (let column = 0; column < site.columnWidths.length; column += 1) {
    for (let row = 0; row < site.rowHeights.length; row += 1) {
      const minX = xs[column]!;
      const maxX = xs[column + 1]!;
      const minZ = zs[row]!;
      const maxZ = zs[row + 1]!;
      const along = (from: number, to: number) => {
        const values: number[] = [];
        for (let value = from + ZONE_SPOT_SPACING_METERS / 2; value < to; value += ZONE_SPOT_SPACING_METERS) values.push(value);
        return values;
      };
      for (const x of along(minX, maxX)) {
        spots.push({ center: { x, z: minZ + inset }, radius: ZONE_SPOT_RADIUS_METERS, onRing: row === 0 });
        spots.push({ center: { x, z: maxZ - inset }, radius: ZONE_SPOT_RADIUS_METERS, onRing: row === site.rowHeights.length - 1 });
      }
      for (const z of along(minZ, maxZ)) {
        spots.push({ center: { x: minX + inset, z }, radius: ZONE_SPOT_RADIUS_METERS, onRing: column === 0 });
        spots.push({ center: { x: maxX - inset, z }, radius: ZONE_SPOT_RADIUS_METERS, onRing: column === site.columnWidths.length - 1 });
      }
    }
  }
  return spots;
}

/**
 * The next course to lay: the first planned course that touches what is already connected. Starting from the
 * gateway's served node, this never lays a street that joins nothing, whatever the world refuses along the way.
 */
export function nextConnectedCourse(
  courses: readonly DistrictCourse[],
  connected: ReadonlyArray<{ start: SpatialPoint2; end: SpatialPoint2 }>,
  settled: ReadonlySet<string>,
): DistrictCourse | null {
  const touches = (course: DistrictCourse, other: { start: SpatialPoint2; end: SpatialPoint2 }) =>
    pointSegmentDistance(course.start, other.start, other.end) < 1.5 ||
    pointSegmentDistance(course.end, other.start, other.end) < 1.5 ||
    pointSegmentDistance(other.start, course.start, course.end) < 1.5 ||
    pointSegmentDistance(other.end, course.start, course.end) < 1.5 ||
    segmentsCross(course.start, course.end, other.start, other.end);
  return courses.find((course) => !settled.has(course.id) && connected.some((other) => touches(course, other))) ?? null;
}

/** Two halves of a refused course, cut at the lattice point nearest its middle; none below two lattice steps. */
export function splitCourse(course: DistrictCourse): DistrictCourse[] {
  const steps = Math.round(course.lengthMeters / GRID_LATTICE_SPACING_METERS);
  if (steps < 2) return [];
  const ratio = Math.floor(steps / 2) / steps;
  const cut = { x: course.start.x + (course.end.x - course.start.x) * ratio, z: course.start.z + (course.end.z - course.start.z) * ratio };
  return [
    { id: `${course.id}.1`, kind: course.kind, start: course.start, end: cut, lengthMeters: length(course.start, cut) },
    { id: `${course.id}.2`, kind: course.kind, start: cut, end: course.end, lengthMeters: length(cut, course.end) },
  ];
}

export function zoneRoleForSpot(spot: DistrictZoneSpot, districtRole: DistrictRole, demand: { commercial: number }): DistrictRole {
  if (districtRole !== "residential") return districtRole;
  // Shops line the district's ring street, the way a player puts commercial on the busier road.
  return spot.onRing && demand.commercial >= 20 ? "commercial" : "residential";
}

/** Industry gets its own district when the city wants it most; otherwise the district is housing with a shop ring. */
export function districtRoleForDemand(demand: { residential: number; commercial: number; industrial: number }): DistrictRole {
  return demand.industrial > demand.residential + 15 && demand.industrial >= 40 ? "industrial" : "residential";
}

// --------------------------------------------------------------------------------------------------------------------
// Execution

export interface DistrictBuilderPort {
  scanWorld(signal?: AbortSignal): Promise<SpatialWorldModel>;
  /**
   * The simulation frame now, from the game's own state (not the mayor snapshot, whose `game.frameIndex` is null on this Bridge). Null when it
   * cannot be read. Absent: the cooldowns count cycles (see `game-clock.ts`).
   */
  readGameFrame?(signal?: AbortSignal): Promise<number | null>;
  /**
   * Write-only experience log (nothing reads it back yet): one row per attempt to give a facility a road, with what was tried and what the game
   * answered, so that a later cache of what worked can be built from real data. Best effort; a failure here never touches the city.
   */
  recordAccessAttempt?(row: AccessAttemptRecord): void;
  listBuildings(signal?: AbortSignal): Promise<Array<{ position: SpatialPoint2; prefab: string }>>;
  siteDetail(center: SpatialPoint2, radius: number, resolution: number, signal?: AbortSignal): Promise<SpatialSiteDetail | null>;
  /** Coarse, city-wide terrain for candidate search only. Every chosen site still gets a fresh detail read. */
  readPlanningTerrain?(signal?: AbortSignal): Promise<SpatialLocalTerrain | null>;
  buildRoad(course: { start: SpatialPoint2; end: SpatialPoint2 }, prefab: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  zone(zone: string, center: SpatialPoint2, radius: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /**
   * The game's own read-only dry run of a street (nothing is built): "OK" or "REJECT:<why>". Diagnostics only — when present,
   * execution telemetry records the verdict beside the real build's result; no decision reads it. Absent in production.
   */
  preflightRoad?(course: { start: SpatialPoint2; end: SpatialPoint2 }, prefab: string, signal?: AbortSignal): Promise<string>;
  /** Buy the map tile containing this point through the game's own purchase rules. Absent: no land purchase. */
  purchaseTile?(point: SpatialPoint2, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** Places the water, power and sewage facilities a new district needs. Absent: no utility provisioning. */
  utilities?: DistrictUtilitiesPort;
  /** The in-world warning icons: counts by type and where they hang. Absent: no icon-driven services. */
  readIcons?(signal?: AbortSignal): Promise<IconReading | null>;
  /** The city's loan and its credit line, and the one action on it: set the principal (borrow more, repay). Absent: no loans. */
  loan?: { read(signal?: AbortSignal): Promise<LoanReading | null>; set(amount: number, signal?: AbortSignal): Promise<boolean> };
  /** Unlocked-or-not prefabs whose name contains `query`. Absent: no icon-driven services. */
  findPrefabs?(query: string, signal?: AbortSignal): Promise<Array<{ name: string; locked: boolean }>>;
  /** The map-tile upkeep and total monthly spending, for the land-purchase and expansion-cash tests. Absent: constants. */
  readLandCosts?(signal?: AbortSignal): Promise<{ tileUpkeep: number; monthlyExpenses: number } | null>;
  /** The zoning mix and the game's demand per land use. Absent: the prior, corrected by `input.demand` alone. */
  readZoningMix?(signal?: AbortSignal): Promise<ZoningMixSignals | null>;
  /** Employment, open jobs and unemployment, for FAST_EXPANSION's choice of what supply to add. Absent: no labour reading. */
  readLabor?(signal?: AbortSignal): Promise<LaborReading | null>;
  /** Bulldoze one street by its entity. Absent: orphan stubs are reported, not removed. */
  demolishRoad?(entity: { index: number; version: number }, signal?: AbortSignal): Promise<boolean>;
  /** The game's progression: achieved milestone, XP, XP the next milestone asks for, and the game date. Absent: stage is read from the unlocks. */
  readProgress?(signal?: AbortSignal): Promise<ProgressReading | null>;
  /** The population over recent game days (frames + values), to read the net immigration rate. Absent: the batch is not capped by absorption. */
  readPopulationSeries?(signal?: AbortSignal): Promise<PopulationSeries | null>;
  /** The zoning inside a disk, by zone name: cells, occupied cells, empty cells. Null: not readable. Absent: stale zoning is not withdrawn (`#withdrawStaleZoning`). */
  readZoningAround?(center: SpatialPoint2, radius: number, signal?: AbortSignal): Promise<Array<{ zone: string; cells: number; occupied: number; empty: number }> | null>;
  /** Join the city's surplus power to the map's own high-voltage line (`power-export.ts`). Absent: power is not sold. */
  powerExport?: PowerExportPort;
  /** The development tree: read it, and buy the nodes the railway needs with the points the milestones grant (`tech-tree.ts`). Absent: nothing is bought. */
  techTree?: TechTreePort;
  /** Put a passenger station on the map's own railway and join it (`train-link.ts`). Absent: no train link. */
  trainLink?: TrainLinkPort;
  /** Public transport lines (`transit-lines.ts`): the passenger train loop platform -> outside connection -> platform. Absent: no line is made. */
  transit?: TransitPort;
  /** The road network's own tools (`road-care.ts`): traffic figures, intersections, in-place replacement, road upgrades. Absent: no traffic or noise work. */
  roads?: RoadCarePort;
}

export interface ProgressReading {
  milestone: number | null;
  xp: number | null;
  nextMilestoneXp: number | null;
  gameDateTime: string | null;
}

/**
 * The tiles a player would buy next: unowned neighbours of owned land, nearest the served network first. The scan
 * reports only owned tiles, so neighbours are found by stepping one tile size from each owned tile.
 */
export function nextTileCandidates(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">): SpatialPoint2[] {
  const owned = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
  if (owned.length === 0) return [];
  const size = Math.min(...owned.map((tile) => tile.bounds!.max.x - tile.bounds!.min.x));
  const served = mainStreetNetwork(world.roadGraph).nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
  const isOwned = (point: SpatialPoint2) => owned.some((tile) => pointInTile(point, tile));
  const candidates = new Map<string, SpatialPoint2>();
  for (const tile of owned) {
    const center = { x: (tile.bounds!.min.x + tile.bounds!.max.x) / 2, z: (tile.bounds!.min.z + tile.bounds!.max.z) / 2 };
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const point = { x: center.x + dx * size, z: center.z + dz * size };
      if (isOwned(point)) continue;
      candidates.set(`${Math.round(point.x)},${Math.round(point.z)}`, point);
    }
  }
  const reach = (point: SpatialPoint2) => served.length === 0 ? 0 : Math.min(...served.map((node) => length(node, point)));
  return [...candidates.values()].sort((left, right) => reach(left) - reach(right));
}

/** Building points from several readings, each place once (to the metre). */
export function mergeBuildingPoints(...lists: ReadonlyArray<readonly SpatialPoint2[]>): SpatialPoint2[] {
  const seen = new Map<string, SpatialPoint2>();
  for (const list of lists) for (const point of list) seen.set(`${Math.round(point.x)},${Math.round(point.z)}`, point);
  return [...seen.values()];
}

/** The buildings a read of a district's own window finds inside its rectangle plus the clearance every district keeps from them. */
export function buildingsInDistrict(detail: Pick<SpatialSiteDetail, "buildings"> | null, site: Pick<DistrictSite, "anchor" | "widthMeters" | "heightMeters">,
  clearanceMeters = DISTRICT_CLEARANCE_METERS): SpatialPoint2[] {
  return (detail?.buildings ?? []).map((building) => ({ x: building.position.x, z: building.position.z }))
    .filter((point) => point.x >= site.anchor.x - clearanceMeters && point.x <= site.anchor.x + site.widthMeters + clearanceMeters &&
      point.z >= site.anchor.z - clearanceMeters && point.z <= site.anchor.z + site.heightMeters + clearanceMeters);
}

/** Share of a terrain read under water; a tile mostly in water is not land a district can use. */
export function waterShare(terrain: SpatialLocalTerrain | undefined): number {
  if (!terrain || terrain.waterDepths.length === 0) return 1;
  return terrain.waterDepths.filter((depth) => depth > 0).length / terrain.waterDepths.length;
}

export interface DistrictCycleInput {
  demand: { residential: number; commercial: number; industrial: number };
  zoneFor(role: ZoneCategory, density?: DistrictDensity): string | null;
  /** What the player asked for, when they asked: land use, region or map point, density, and leave to buy land. */
  intent?: DistrictIntent;
  /** The city problems the player asked the Mayor to see to (`care-focus.ts`): they go first and past the usual waits this cycle. */
  care?: { focus: readonly CareFocus[]; fresh?: boolean };
  /** Whether the treasury can carry a tile purchase this cycle. The game still enforces cost and availability. */
  mayPurchaseLand?: boolean;
  /** The largest district (m²) the treasury should pay for now; bigger shapes are not offered. Absent: no cap. */
  maximumAreaSquareMeters?: number;
  /** Treasury and monthly balance, for the land-purchase affordability test (K34). Absent: `mayPurchaseLand` alone decides. */
  finance?: { treasury: number; monthlyBalance: number };
  /** A utility is short and could not be repaired this cycle: lay roads, hold the zoning (see `zonesDeferred`). */
  zoningHeld?: boolean;
  /**
   * Nothing is built outward this cycle (the player held expansion, the city is in financial recovery, the target population is reached): the
   * upkeep of what stands still runs — broken links, dead ends, orphan streets and the care round (problem icons) — and the cycle ends with this reason.
   */
  careOnly?: string;
  /**
   * The city is close to the population the player set as its target: the districts that follow are cut down to what the people still to come would fill
   * (`NEAR_TARGET_SQUARE_METERS_PER_PERSON`), and none is opened when less than the smallest district remains — so the city lands near the target instead of
   * one whole district past it. Absent: far from the target, or no target.
   */
  nearTarget?: { population: number; target: number };
  /**
   * FAST_EXPANSION: choose what supply to add from the world's labour and stock readings, and stop adding the kind the
   * city cannot use yet (the builder keeps going on whatever else is short). Absent: every profile builds as before.
   */
  pipelined?: boolean;
  /** The city's utility readings. A district that would leave a utility short gets a facility on its own network the same cycle. */
  utilities?: Record<DistrictUtilityKind, DistrictUtilityReading>;
  /** The city's population: how many public service buildings its size justifies. */
  population?: number | null;
  targetPopulation?: number | null;
  utilityReadComplete?: boolean;
  criticalUtilityShortfalls?: Partial<Record<DistrictUtilityKind, number>>;
  /** What the zone catalogue has unlocked (growable residential densities, an office zone). Absent: the density policy stands down. */
  unlocked?: { densities: Record<ResidentialDensityKey, boolean>; office: boolean };
  signal?: AbortSignal;
}

export interface DistrictCycleResult {
  status: "BUILT" | "NO_SITE" | "LAND_PURCHASED" | "UTILITY_REPAIRED";
  site: DistrictSite | null;
  role: DistrictRole | null;
  roadsBuilt: number;
  roadsRefused: number;
  roadsLanded: number;
  zonesPainted: number;
  zonesRefused: number;
  /** Planned streets of the district, to read how much of it stands. */
  plannedCourses?: number;
  /** Brush spots held back because a utility was short; painted on a later cycle. */
  zonesDeferred?: number;
  notes: string[];
  /** Utility facilities placed for this district, with the connection each read back. */
  facilities?: DistrictUtilityPlacement[];
  /** The district's way in was refused (dry run, build or read-back), so nothing of it was laid. */
  gatewayRefused?: boolean;
  /** The player named a place and no district could be laid or land bought there this cycle. */
  intentUnmet?: boolean;
  /**
   * What the cycle was, for the reader of a run: BUILD (a district or land was laid), WAIT (the policy decided not to build now — `waitReason`
   * says why; no site search was made for it), NO_FEASIBLE_SITE (building was called for and the ground offered no legal site).
   */
  outcome?: "BUILD" | "WAIT" | "NO_FEASIBLE_SITE" | "REPLAN_REQUIRED" | "SAFETY_BLOCKED";
  waitReason?: string;
  /** Requested batch and what actually landed, including any unfinished remainder. */
  batch?: { targetAreaSquareMeters: number; deliveredAreaSquareMeters: number; remainingAreaSquareMeters: number };
  /** Policy's next action after the planner could not deliver the remainder of a partially built batch. */
  nextDecision?: "LAND_PURCHASED" | "WAIT" | "REPLAN_REQUIRED" | "NO_FEASIBLE_SITE" | "SAFETY_BLOCKED";
  /** The failed realization boundary, without guessing that a different strategy should be chosen. */
  feasibility?: { reason: "DENSITY_UNAVAILABLE"; density: DistrictDensity; role: DistrictRole } |
    { reason: "NO_SITE_IN_BOUNDED_SEARCH" | "SITE_READ_UNAVAILABLE"; survey: DistrictSurveyDiagnostics;
      siteChecks: { unread: number; buildingCollision: number; invalidGrid: number; roadFailure: number; examined: number };
      coverage: { rectanglesConsidered: number; rectanglesTotal: number | null; sitesUnexamined: number; complete: boolean };
      targetAreaSquareMeters: number | null; geometricCandidateAreaSquareMeters: number };
}

/** Whether a street now lies along this course, read from the world around its midpoint. */
function courseLanded(detail: SpatialSiteDetail | null, course: { start: SpatialPoint2; end: SpatialPoint2 }): boolean {
  if (!detail) return false;
  const nodeByKey = new Map(detail.roadGraph.nodes.map((node) => [key(node.entity), node.position]));
  const mid = { x: (course.start.x + course.end.x) / 2, z: (course.start.z + course.end.z) / 2 };
  return detail.roadGraph.edges.some((edge) => {
    if (edge.deleted || edge.temp) return false;
    const a = nodeByKey.get(key(edge.startNode)) ?? edge.start;
    const b = nodeByKey.get(key(edge.endNode)) ?? edge.end;
    return pointSegmentDistance(mid, a, b) < 3 &&
      pointSegmentDistance(a, course.start, course.end) < 3 && pointSegmentDistance(b, course.start, course.end) < 3;
  });
}

/**
 * The largest brush radius that reaches no occupied cell, up to the standard radius; null when even the smallest useful
 * brush would. The zoning brush repaints every cell inside its disk, buildings included, and a building whose zone changes
 * under it is condemned and lost.
 */
export function safeBrushRadius(point: SpatialPoint2, occupied: readonly SpatialPoint2[], standard = ZONE_SPOT_RADIUS_METERS): number | null {
  let nearest = Infinity;
  for (const other of occupied) { const meters = Math.hypot(other.x - point.x, other.z - point.z); if (meters < nearest) nearest = meters; }
  const radius = Math.min(standard, nearest - BRUSH_BUILDING_MARGIN_METERS);
  return radius >= MINIMUM_BRUSH_RADIUS_METERS ? radius : null;
}

export interface ZoningBrush { zone: string; center: SpatialPoint2; radius: number }

/**
 * The admission of zoning brushes against the world as it stands at the moment of writing: each brush is cut back to clear every
 * building and every occupied zoning cell of a FRESH read, and dropped where no useful brush fits. A planned or queued brush is a wish,
 * not an authorization: a brush queued while the city ran at 4x can find houses grown under it (measured 2026-10-04: a replayed queue of
 * mixed brushes repainted grown houses and condemned them).
 */
export function admitZoningBrushes(brushes: readonly ZoningBrush[], occupied: readonly SpatialPoint2[]): { admitted: ZoningBrush[]; shrunk: number; dropped: ZoningBrush[] } {
  const admitted: ZoningBrush[] = [];
  const dropped: ZoningBrush[] = [];
  let shrunk = 0;
  for (const brush of brushes) {
    const radius = safeBrushRadius(brush.center, occupied, brush.radius);
    if (radius === null) { dropped.push(brush); continue; }
    if (radius < brush.radius) shrunk += 1;
    admitted.push({ ...brush, radius });
  }
  return { admitted, shrunk, dropped };
}

/** Brushes grouped so one read covers each group (a read reaches at most 2,048 m; groups stay well inside it). */
export function groupBrushesForReading(brushes: readonly ZoningBrush[], spanMeters = 600): ZoningBrush[][] {
  const groups: Array<{ anchor: SpatialPoint2; members: ZoningBrush[] }> = [];
  for (const brush of brushes) {
    const group = groups.find((entry) => Math.hypot(entry.anchor.x - brush.center.x, entry.anchor.z - brush.center.z) <= spanMeters);
    if (group) group.members.push(brush);
    else groups.push({ anchor: brush.center, members: [brush] });
  }
  return groups.map((group) => group.members);
}

/** Where a facility lot must not go: any zoned cell and any building in the read. */
function lotsToAvoid(detail: SpatialSiteDetail | null): SpatialPoint2[] {
  if (!detail) return [];
  return [
    ...detail.zoningCells.filter((cell) => cell.zoneCategory !== undefined && cell.zoneCategory !== "none").map((cell) => ({ x: cell.position.x, z: cell.position.z })),
    ...detail.buildings.map((building) => ({ x: building.position.x, z: building.position.z })),
  ];
}

export class DistrictBuilder {
  /** Districts whose gateway or first ring street the world refused, so the next cycle takes the next site. */
  readonly #refused = new Set<string>();
  /**
   * Districts zoned this session, by role. Zoned land has no buildings yet, so without this a freshly zoned
   * housing district would look empty to the isolation rule and industry could be laid beside it.
   */
  readonly #zoned: Array<{ role: DistrictRole; rect: { minX: number; minZ: number; maxX: number; maxZ: number } }> = [];
  /** Zoning spots a busy Bridge refused; repainted first next cycle (a brush only paints cells that exist). */
  #pendingZoning: Array<{ zone: string; center: SpatialPoint2; radius: number }> = [];
  #repairCalls = 0;
  /**
   * Streets THIS Mayor laid in this process. Cleanup of leftovers is limited to these: the world's own roads (the map's,
   * the player's, an earlier session's) are never bulldozed because they look like a stub. Held in memory only; after a
   * restart nothing is recognised as ours, which means nothing is removed.
   */
  readonly #ownCourses: Array<{ start: SpatialPoint2; end: SpatialPoint2 }> = [];
  /** Rectangles the ground or the world refused; retried a little smaller on later passes and cycles. */
  readonly #refusedRectangles = new Map<string, LandRectangle>();
  /** The mix of land uses as the world showed it at the start of this cycle. */
  #mix: ZoningMixSignals = emptyMix();
  /** The land uses the game lets this city zone now (an unlocked zone type exists for them). */
  #available: ZoneCategory[] = [...ZONE_CATEGORIES];
  /** Land uses this cycle adds none of (pipelined mode): the jobs-or-homes bottleneck and zoning that stands mostly empty. */
  #paused: ZoneCategory[] = [];
  /** The bottleneck this cycle read (pipelined mode) and the zoning stock of the last cycles, to see whether supply is being absorbed. */
  #bottleneck: GrowthBottleneck = "NONE";
  /** A tile was bought and no district has been laid since: another purchase would only add upkeep (memory only; a restart forgets it). */
  #boughtTileUnused = false;
  #stockHistory: StockSample[] = [];
  #rezoneBefore: { empty: number; painted: number } | null = null;
  #rezoneUnsupported = false;
  readonly #repairedAt = new Map<DistrictUtilityKind, GameStamp>();
  /** Land uses a complete survey found no site for, and when: held out of the choice for `ROLE_NO_SITE_BLOCK_HOURS` (cycles with no clock). */
  readonly #roleNoSiteSince = new Map<DistrictRole, GameStamp>();
  /** The land use the current cycle chose by the pipeline policy (null: not a policy choice, e.g. the player named one). */
  #cycleRole: DistrictRole | null = null;
  /** When the city began to stand still for want of land it could not afford (null: it is not). See `LAND_FINANCE_ESCAPE_HOURS`. */
  #landHeldSince: GameStamp | null = null;
  /** Which step of `INDUSTRIAL_BUFFER_STEPS_METERS` industry is searched at (memory only; a restart starts at the widest). */
  #industrialStep = 0;
  #industrialBuffer(): number { return INDUSTRIAL_BUFFER_STEPS_METERS[Math.min(this.#industrialStep, INDUSTRIAL_BUFFER_STEPS_METERS.length - 1)]!; }
  #blockedRoles(): DistrictRole[] {
    const now = this.#stamp(this.#cycles);
    return [...this.#roleNoSiteSince].filter(([, since]) => !stampElapsed(since, now, ROLE_NO_SITE_BLOCK_HOURS, ROLE_NO_SITE_BLOCK_CYCLES)).map(([role]) => role);
  }
  /** Whether a utility repair may be tried again: never tried, or `UTILITY_REPAIR_COOLDOWN_HOURS` of game time (calls, with no clock) passed. */
  #repairCooledDown(kind: DistrictUtilityKind, now: GameStamp): boolean {
    const at = this.#repairedAt.get(kind);
    // `+ 1` calls: the repair was held while `calls - at <= COOLDOWN_CALLS`.
    return !at || stampElapsed(at, now, UTILITY_REPAIR_COOLDOWN_HOURS, UTILITY_REPAIR_COOLDOWN_CALLS + 1);
  }
  /** When zoning began to wait for a missing network (null: it is not waiting). A wait is game time, see `game-clock.ts`. */
  #utilityHoldSince: GameStamp | null = null;
  /** The game time the cycle that last ran a deferred-notification review was at (null: none yet). */
  #deferredReviewAt: GameStamp | null = null;
  // ---- FAST_EXPANSION V2 (growth-policy.ts) — memory of this process only; a rebaseline forgets it and the world is read afresh ----
  /** Stage and density this cycle chose (pipelined mode), and the batch it may build. */
  #stage: GrowthStage = "S0";
  #chosenDensity: DistrictDensity | null = null;
  #batch: Constraint | null = null;
  /** Residential area laid in this process: low density against all, for the low-density quota from S3 on. */
  #laidResidential = { low: 0, other: 0 };
  readonly #financeWatch = new FinanceWatch();
  /** The borrowed share of the credit line is past the top tier: outward spending (land) is cut this cycle. */
  #cutSpending = false;
  /** Owned tiles and tile upkeep at the last reading, to measure what the next tile really added (it rises with the count, retroactively). */
  #tileReading: { owned: number; upkeep: number } | null = null;
  #observedMarginalTileUpkeep: number | null = null;
  #notifiedGaps = false;
  /** Buildings a district's own window showed that the city-wide list did not (memory of this process; the world is read again after a rebaseline). */
  #seenBuildings: SpatialPoint2[] = [];
  /** Every building known for the cycle's ground, for the zoning brushes of the district being laid. */
  #siteBuildings: SpatialPoint2[] = [];

  readonly port: DistrictBuilderPort;

  /**
   * Forget everything this builder remembered about the world it was looking at. Called when the connection to the game was lost and
   * came back, or the world changed under it (another save loaded, the game restarted): the next cycle reads the world afresh and
   * nothing planned or tried before is applied to it. The streets this builder laid (`#ownCourses`) are forgotten too — that memory is
   * what permits a demolition, and in a different world the same coordinates may hold the player's own street.
   */
  rebaseline(): void {
    this.#refused.clear();
    this.#refusedRectangles.clear();
    this.#zoned.length = 0;
    this.#pendingZoning = [];
    this.#unfilledSince = null;
    this.#utilityExhausted.clear();
    this.#ownCourses.length = 0;
    this.#stockHistory.length = 0;
    this.#repairedAt.clear();
    this.#repairCalls = 0;
    this.#rezoneBefore = null;
    this.#rezoneUnsupported = false;
    this.#reservedLots.length = 0;
    this.#serviceRest.clear();
    this.#refusedPlacements.clear();
    this.#serviceCycle = 0;
    this.#cycles = 0;
    this.#loanBlockedUntil = 0;
    this.#loanBlockedSince = null;
    this.#frame = null;
    this.#clockNoted = false;
    this.#utilityHoldSince = null;
    this.#deferredReviewAt = null;
    this.#stockHistory = [];
    this.#roleNoSiteSince.clear();
    this.#cycleRole = null;
    this.#landHeldSince = null;
    this.#closureAttempts.clear();
    this.#paused = [];
    this.#bottleneck = "NONE";
    this.#boughtTileUnused = false;
    this.#mix = emptyMix();
    this.#stage = "S0";
    this.#chosenDensity = null;
    this.#batch = null;
    this.#laidResidential = { low: 0, other: 0 };
    this.#financeWatch.reset();
    this.#cutSpending = false;
    this.#tileReading = null;
    this.#observedMarginalTileUpkeep = null;
    this.#notifiedGaps = false;
    this.#seenBuildings = [];
    this.#roadAccessFailures.clear();
    this.#roadAccessBuiltAt.clear();
    this.#ownFacilities.clear();
    this.#ground = null;
    this.#frontageDirty = true;
    this.#frontageInitialScan = true;
    this.#frontageCourseCursor = 0;
  }

  /**
   * `outcomes`, when given, records every street, brush, purchase and demolition this builder attempts (see
   * `execution-telemetry.ts`). It records only: nothing in the builder reads it back.
   */
  /** Lots left unzoned for public services, in this process only: the world, not this list, says what stands there. */
  readonly #reservedLots: Array<{ center: SpatialPoint2; radius: number }> = [];
  #serviceCycle = 0;
  /** A site the game refused is not asked again for 72 game hours (or 60 cycles), nor any site within 24 m of it. */
  readonly #refusedPlacements = new RefusedPlacements(60, 24);
  #cycles = 0;
  /** No new loan step before this cycle: the last one is being judged, or was undone. */
  #loanBlockedUntil = 0;
  /** The frame the last loan step was taken or refused at (with its cycle): the wait on it is game time, see `game-clock.ts`. */
  #loanBlockedSince: { since: GameStamp; hours: number; cycles: number } | null = null;
  /** No new loan step for `hours` of game time (`cycles` cycles when the clock is unreadable) from now. */
  #blockLoan(hours: number, cycles: number): void {
    this.#loanBlockedUntil = this.#cycles + cycles;
    this.#loanBlockedSince = { since: this.#stamp(this.#cycles), hours, cycles };
  }
  /** The game frame read at the start of this cycle; null when the clock cannot be read (the waits then count cycles). */
  #frame: number | null = null;
  #clockNoted = false;
  #stamp(cycle: number): GameStamp { return { frame: this.#frame, cycle }; }
  async #readClock(signal?: AbortSignal): Promise<void> {
    try { this.#frame = (await this.port.readGameFrame?.(signal)) ?? null; } catch { this.#frame = null; }
  }
  readonly #serviceRest = new Map<ServiceNeed, GameStamp>();
  /** Homes bulldozed for a service in this process (the experiment is limited to one). */
  #serviceDemolitions = 0;

  /**
   * `serviceDemolitionExperiment`: when a service the icons ask for has no legal lot anywhere near them, bulldoze one low-density home and
   * place the service on its lot (once per process). Off unless the host turns it on.
   */
  constructor(port: DistrictBuilderPort, private readonly options: { maximumSitesPerCycle?: number; outcomes?: ExecutionOutcomeRecorder; serviceDemolitionExperiment?: boolean;
    decisionLog?: (row: string) => void;
    /** What survives a restart of the run process (`builder-memory.ts`): the facilities this builder placed, the districts it zoned, the sites that got no road. */
    memory?: BuilderMemoryStore; memoryKey?: string;
    /** The recorder's experience (`experience-book.ts`): orders the candidates of a repair by what passed and helped before; decides nothing itself. */
    experience?: ExperienceBook } = {}) {
    // The protection filter first (areas the player asked to keep), then the telemetry, so a protected refusal is recorded like any other.
    const guarded = guardDistrictPort(port);
    const instrumented = options.outcomes ? instrumentDistrictPort(guarded, options.outcomes) : guarded;
    const remembered = options.memory?.load() ?? null;
    this.#highValue = new HighValueGuard(remembered?.highValue ?? null);
    // Every facility placement passes the costly-facility guard (`high-value-guard.ts`): one costly facility a game day, none of a kind while one of it is stranded.
    const viaGuard = (place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => Promise<{ ok: boolean; detail: string }>) =>
      async (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => {
        const now = this.#stamp(this.#cycles);
        const why = this.#highValue.blocked(prefab, now);
        if (why) { this.#highValueRefusals.add(`${prefab}: ${why}`); return { ok: false, detail: why }; }
        const outcome = await place(prefab, point, rotation, signal);
        if (outcome.ok) this.#highValue.placed(prefab, now);
        return outcome;
      };
    // A station placed, its tracks found not to join and taken down again is the same loop (`train-link.ts`): one costly placement a game day there too.
    const withTrain = instrumented.trainLink ? { ...instrumented, trainLink: { ...instrumented.trainLink, place: viaGuard(instrumented.trainLink.place.bind(instrumented.trainLink)) } } : instrumented;
    this.port = withTrain.utilities ? { ...withTrain, utilities: { ...withTrain.utilities,
      place: viaGuard(withTrain.utilities.place.bind(withTrain.utilities)),
      // A blocked costly prefab is not offered at all (no site is searched for it): the realizer takes the next one, or the cheap default.
      ...(withTrain.utilities.rankPrefabs ? { rankPrefabs: async (...args: Parameters<NonNullable<DistrictUtilitiesPort["rankPrefabs"]>>) => {
        const ranked = (await withTrain.utilities!.rankPrefabs!(...args)) ?? [];
        const now = this.#stamp(this.#cycles);
        return ranked.filter((prefab) => { const why = this.#highValue.blocked(prefab, now); if (why) this.#highValueRefusals.add(`${prefab}: ${why}`); return !why; });
      } } : {}) } } : instrumented;
    if (remembered) {
      for (const facility of remembered.ownFacilities) this.#ownFacilities.set(`${facility.index}:${facility.version}`, facility);
      for (const district of remembered.zoned) this.#zoned.push({ role: district.role as DistrictRole, rect: district.rect });
      this.#accessFailedSites.push(...remembered.accessFailed);
      for (const name of remembered.signaturesStanding) this.#signaturesStanding.add(name);
      this.#bigRefused.push(...(remembered.bigRefused ?? []));
      this.#bigRefusedOwned = remembered.bigRefusedOwnedTiles ?? null;
      this.#roadCareMemory = remembered.roadCare ?? null;
      // A stamp whose frame was unreadable starts counting cycles again from this process.
      if (remembered.bigLandBoughtAt) this.#bigLandBoughtAt = remembered.bigLandBoughtAt.frame === null ? { frame: null, cycle: 0 } : remembered.bigLandBoughtAt;
    }
  }
  /** The road-care record a restart keeps (`road-care.ts`): loaded with the builder's memory, handed back whole after each change. */
  #roadCareMemory: RoadCareMemory | null = null;
  /** Costly facilities: never placed in a loop, never taken down by the Mayor (`high-value-guard.ts`). */
  readonly #highValue: HighValueGuard;
  /** Placements the guard refused this cycle, reported once in the notes. */
  readonly #highValueRefusals = new Set<string>();
  /** Costly facilities already reported as left for the player (once each). */
  readonly #costlyReported = new Set<string>();

  #savedMemory = "";
  /** The bookkeeping that a restart would lose, written whole (and only when it changed) after each cycle. */
  #saveMemory(): void {
    const store = this.options.memory;
    if (!store || !this.options.memoryKey) return;
    const memory = boundedMemory({ key: this.options.memoryKey, ownFacilities: [...this.#ownFacilities.values()], zoned: this.#zoned.map((district) => ({ role: district.role, rect: district.rect })),
      accessFailed: this.#accessFailedSites, signaturesStanding: [...this.#signaturesStanding], bigRefused: this.#bigRefused,
      ...(this.#bigRefusedOwned !== null ? { bigRefusedOwnedTiles: this.#bigRefusedOwned } : {}),
      ...(this.#bigLandBoughtAt ? { bigLandBoughtAt: this.#bigLandBoughtAt } : {}),
      highValue: this.#highValue.snapshot(),
      ...(this.#roadCareMemory ? { roadCare: this.#roadCareMemory } : {}) });
    const text = JSON.stringify(memory);
    if (text === this.#savedMemory) return;
    this.#savedMemory = text;
    store.save(memory);
  }

  async runCycle(input: DistrictCycleInput): Promise<DistrictCycleResult> {
    try { return await this.#cycleBody(input); } finally { this.#saveMemory(); }
  }

  async #cycleBody(input: DistrictCycleInput): Promise<DistrictCycleResult> {
    const outcomes = this.options.outcomes;
    const from = outcomes?.length ?? 0;
    const cycleStartedAt = Date.now();
    const immediate = (result: DistrictCycleResult): DistrictCycleResult => {
      try { this.options.decisionLog?.(JSON.stringify({ at: Date.now(), elapsedMs: Date.now() - cycleStartedAt,
        status: result.status, outcome: result.outcome, waitReason: result.waitReason, facilities: result.facilities?.length ?? 0,
        notes: result.notes })); } catch { /* diagnostics never disturb a cycle */ }
      return result;
    };
    // The city's time for this cycle's waits (`game-clock.ts`); one cheap read, shared by the whole cycle and its follow-up districts.
    await this.#readClock(input.signal);
    const admission = growthAdmission({ population: input.population ?? null, targetPopulation: input.targetPopulation ?? null,
      utilityReadComplete: input.utilityReadComplete !== false });
    // The target population reached stops the growth, not the care of the city that stands (live 2026-10-07: problem icons went untended).
    if (!admission.build && !input.careOnly) input = { ...input, careOnly: admission.reason ?? "POLICY_WAIT" };
    const critical = Object.entries(input.criticalUtilityShortfalls ?? {}).filter((entry): entry is [DistrictUtilityKind, number] => typeof entry[1] === "number");
    let holdNote: string | null = null;
    let repairNotes: string[] = [];
    if (critical.length > 0) {
      const repair = await this.repairUtilities({ kinds: critical.map(([kind]) => kind), shortfalls: Object.fromEntries(critical), signal: input.signal });
      // What the repair tried and why it did not stand is the player's to read too (live 2026-10-07: 718 sewage icons and no word of why nothing was built).
      repairNotes = repair.notes.slice(0, 8);
      if (repair.placed.length > 0) {
        this.#utilityHoldCycles = 0;
        this.#utilityHoldSince = null;
        return immediate({ status: "UTILITY_REPAIRED", site: null, role: null, roadsBuilt: 0, roadsRefused: 0,
          roadsLanded: 0, zonesPainted: 0, zonesRefused: 0, facilities: repair.placed, notes: repair.notes, outcome: "BUILD" });
      }
      // P7: the three networks are not blocked by the zoning itself — zoning waits until they stand, so the lots they need are still free. The wait is
      // bounded: a facility that finds no lot for a few cycles in a row does not hold the whole city's zoning for good.
      // The wait is game time (`UTILITY_ZONING_HOLD_MAXIMUM_HOURS`); with no readable clock it counts cycles as before.
      // A utility whose every candidate was searched and none can stand (live 2026-10-05: the sewage outlet needs open water, no lot offered had any) is not
      // waited for: nothing the wait lets happen would place it, and the zoning it holds is what makes the homes grow. Only the kinds still placeable hold it.
      const waiting = critical.filter(([kind]) => !this.#utilityExhausted.has(kind));
      if (this.#utilityHoldCycles === 0 || !this.#utilityHoldSince) this.#utilityHoldSince = this.#stamp(0);
      this.#utilityHoldCycles += 1;
      const holdOver = waiting.length === 0 ||
        stampElapsed(this.#utilityHoldSince, this.#stamp(this.#utilityHoldCycles - 1), UTILITY_ZONING_HOLD_MAXIMUM_HOURS, UTILITY_ZONING_HOLD_MAXIMUM_CYCLES);
      if (waiting.length === 0) holdNote = `utilities: ${critical.map(([kind]) => kind).join("/")} cannot be placed anywhere the world offers (every candidate tried); zoning goes on without waiting for ${critical.length > 1 ? "them" : "it"}`;
      else if (!holdOver) input = { ...input, zoningHeld: true };
      else holdNote = `utilities: ${critical.map(([kind]) => kind).join("/")} still not placed after ${this.#frame !== null ? `${UTILITY_ZONING_HOLD_MAXIMUM_HOURS} game hours` : `${UTILITY_ZONING_HOLD_MAXIMUM_CYCLES} cycles`}; zoning goes on without waiting for them`;
    } else { this.#utilityHoldCycles = 0; this.#utilityHoldSince = null; }
    this.#cycleRole = null;
    let result = await this.#runCycle(input, null);
    if (holdNote) result.notes.push(holdNote);
    for (const line of repairNotes) result.notes.push(`repair: ${line}`);
    // One land use without land must not stop the city: hold it out of the next choices for a few game hours so the cycle that follows takes
    // the next use that answers the bottleneck. Only a COMPLETE search counts (an unread or cut-short one proves nothing), and only a use the
    // policy chose (a named request is never silently swapped for another).
    if (input.pipelined && !input.intent?.role && this.#cycleRole && result.status === "NO_SITE" && result.feasibility && "survey" in result.feasibility &&
      result.feasibility.reason === "NO_SITE_IN_BOUNDED_SEARCH" && result.feasibility.coverage.complete) {
      this.#roleNoSiteSince.set(this.#cycleRole, this.#stamp(this.#cycles));
      result.notes.push(`role ${this.#cycleRole} has no site; held out for ${this.#frame !== null ? `${ROLE_NO_SITE_BLOCK_HOURS} game hours` : `${ROLE_NO_SITE_BLOCK_CYCLES} cycles`}, the next use is tried`);
      if (this.#cycleRole === "industrial" && this.#industrialStep < INDUSTRIAL_BUFFER_STEPS_METERS.length - 1) {
        this.#industrialStep += 1;
        result.notes.push(`industry: no site ${INDUSTRIAL_BUFFER_STEPS_METERS[this.#industrialStep - 1]} m from every home; the next search keeps ${this.#industrialBuffer()} m`);
      }
    } else if (result.status === "BUILT" && result.role) {
      this.#roleNoSiteSince.delete(result.role);
      if (result.role === "industrial") this.#industrialStep = 0;
    }
    // A district stood or a tile was bought: the city is not standing still any more.
    if (result.status === "BUILT" || result.status === "LAND_PURCHASED") this.#landHeldSince = null;
    // P2 of the V2 candidate: a large batch goes out in one go. While the batch (the smaller of what the cash pays for and what the city can
    // take up) has room for another district, the next one follows at once, on a fresh reading of the world.
    const batchRole = result.role;
    if (result.status === "BUILT" && input.pipelined && batchRole && this.#batch) {
      const target = this.#batch.limit;
      let delivered = result.site ? result.site.widthMeters * result.site.heightMeters : 0;
      let remaining = target - delivered;
      for (let extra = 0; remaining >= MINIMUM_REALIZATION_AREA_SQUARE_METERS && !input.signal?.aborted; extra += 1) {
        const next = await this.#runCycle(input, { role: batchRole, remainingArea: remaining });
        if (next.status !== "BUILT") {
          result.notes.push(`batch: ${Math.round(remaining)} m2 undelivered; ${next.notes.at(-1) ?? "no site"}`);
          if (next.feasibility) result.feasibility = next.feasibility;
          result.nextDecision = next.status === "LAND_PURCHASED" ? "LAND_PURCHASED" : next.outcome === "WAIT" ? "WAIT" :
            next.outcome === "REPLAN_REQUIRED" ? "REPLAN_REQUIRED" : next.outcome === "SAFETY_BLOCKED" ? "SAFETY_BLOCKED" : "NO_FEASIBLE_SITE";
          break;
        }
        const area = next.site ? next.site.widthMeters * next.site.heightMeters : 0;
        delivered += area;
        remaining -= area;
        result = {
          ...result, roadsBuilt: result.roadsBuilt + next.roadsBuilt, roadsRefused: result.roadsRefused + next.roadsRefused, roadsLanded: result.roadsLanded + next.roadsLanded,
          zonesPainted: result.zonesPainted + next.zonesPainted, zonesRefused: result.zonesRefused + next.zonesRefused, zonesDeferred: (result.zonesDeferred ?? 0) + (next.zonesDeferred ?? 0),
          plannedCourses: (result.plannedCourses ?? 0) + (next.plannedCourses ?? 0), facilities: [...(result.facilities ?? []), ...(next.facilities ?? [])],
          notes: [...result.notes, `batch: district ${extra + 2} of the same batch`, ...next.notes],
        };
      }
      if (remaining > 0 && remaining < MINIMUM_REALIZATION_AREA_SQUARE_METERS && !result.nextDecision) {
        const decision = decideGrowthAfterSearch({ targetAreaSquareMeters: target, deliveredAreaSquareMeters: delivered,
          geometricCandidateAreaSquareMeters: 0, searchComplete: true, unreadSites: 0, rejectedSites: 0 });
        result.nextDecision = "WAIT";
        result.notes.push(`batch: ${decision.reason}`);
      }
      result.batch = { targetAreaSquareMeters: target, deliveredAreaSquareMeters: delivered, remainingAreaSquareMeters: Math.max(0, remaining) };
    } else if (input.pipelined && this.#batch) {
      result.batch = { targetAreaSquareMeters: this.#batch.limit, deliveredAreaSquareMeters: 0, remainingAreaSquareMeters: this.#batch.limit };
    }
    const summary = outcomes?.summary(from);
    if (summary) result.notes.push(summary);
    if (input.pipelined) {
      // One line first, so a status cut to its first characters still shows what the V2 policy decided.
      result.notes.unshift(`V2 ${this.#stage}${this.#chosenDensity ? ` ${this.#chosenDensity.toLowerCase()}` : ""}${this.#batch ? ` | ${this.#batch.binding}-bound batch ${Math.round(this.#batch.limit)} m2` : ""}`);
    }
    result.outcome ??= result.status === "NO_SITE" ? "NO_FEASIBLE_SITE" : "BUILD";
    // Diagnostics only (a live run's decision file): the whole reasoning of the cycle, written and never read back.
    try {
      this.options.decisionLog?.(JSON.stringify({ at: Date.now(), elapsedMs: Date.now() - cycleStartedAt, status: result.status, outcome: result.outcome,
        ...(result.waitReason ? { waitReason: result.waitReason } : {}),
        ...(result.feasibility ? { feasibility: result.feasibility } : {}), ...(result.batch ? { batch: result.batch } : {}),
        ...(result.nextDecision ? { nextDecision: result.nextDecision } : {}), role: result.role, notes: result.notes }));
    } catch { /* diagnostics never disturb a cycle */ }
    return result;
  }

  /** The costs the land and finance tests read, once per cycle (the follow-up districts of a batch reuse them). */
  #costs: { tileUpkeep: number; monthlyExpenses: number } | null = null;

  /**
   * One district cycle. `follow` is set for the second and later districts of one batch: the maintenance of the cycle (orphans, services,
   * unzoned frontage, the finance gates, the land purchase) has run already, so only a fresh reading of the world, the survey and the build repeat.
   */
  async #runCycle(input: DistrictCycleInput, follow: { role: DistrictRole; remainingArea: number } | null): Promise<DistrictCycleResult> {
    const signal = input.signal;
    const notes: string[] = [];
    if (!follow && this.port.readGameFrame && this.#frame === null && !this.#clockNoted) {
      this.#clockNoted = true;
      notes.push("game clock unreadable; cooldowns count cycles");
    }
    const empty = (): DistrictCycleResult => ({ status: "NO_SITE", site: null, role: null, roadsBuilt: 0, roadsRefused: 0,
      roadsLanded: 0, zonesPainted: 0, zonesRefused: 0, notes });
    // The policy decided not to build now: no site was searched for, and the reader of a run should not read it as a site failure.
    const wait = (reason: string): DistrictCycleResult => ({ ...empty(), outcome: "WAIT", waitReason: reason });
    if (follow) input = { ...input, maximumAreaSquareMeters: follow.remainingArea };
    if (!follow && this.#pendingZoning.length > 0 && !input.zoningHeld) {
      const retry = this.#pendingZoning;
      this.#pendingZoning = [];
      // A queued brush is replayed only through the admission of the world as it is now (the city ran since it was queued).
      const admission = await this.#admitAndWrite(retry, signal);
      this.#pendingZoning.push(...admission.unread, ...admission.failed.map((entry) => entry.brush));
      notes.push(`repainted ${admission.written.length}/${retry.length} zoning spots queued earlier (admission now: ${admission.shrunk} cut back, ` +
        `${admission.dropped.length} dropped — buildings stand under them, ${admission.unread.length} kept: ground unread)`);
    }
    let world = await this.port.scanWorld(signal);
    const listed = await this.port.listBuildings(signal);
    const buildings = listed.map((building) => building.position);
    if (!follow) {
      if (await this.removeOrphanStubs(world, buildings, notes, signal) > 0) world = await this.port.scanWorld(signal);
      if (await this.reconnectOrphans(world, buildings, notes, signal) > 0) world = await this.port.scanWorld(signal);
      // Close a gap in the grid BEFORE spurs are judged: a dead end a block from the node it was meant to reach is joined, not deleted.
      if (await this.closeDeadEnds(world, buildings, notes, signal) > 0) world = await this.port.scanWorld(signal);
      if (await this.removeDeadEndSpurs(world, buildings, notes, signal) > 0) world = await this.port.scanWorld(signal);
      if (await this.linkDistricts(world, buildings, notes, signal) > 0) world = await this.port.scanWorld(signal);
    }
    const landUse: DistrictLandUse = { sensitive: [], polluters: [], loud: loudPoints(world.roadGraph.edges) };
    for (const building of listed) {
      const kind = classifyBuilding(building.prefab);
      if (kind === "sensitive") landUse.sensitive.push(building.position);
      if (kind === "polluter") landUse.polluters.push(building.position);
    }
    // A zoned district counts by points over its whole footprint: its buildings are still to come.
    for (const district of this.#zoned) (district.role === "industrial" ? landUse.polluters : landUse.sensitive).push(...districtFootprintPoints(district.rect));
    const intent = input.intent ?? null;
    let role: DistrictRole = follow?.role ?? intent?.role ?? (input.pipelined ? "residential" : districtRoleForDemand(input.demand));
    const cityCentre = centreOf(buildings);
    if (!follow && input.careOnly) {
      try { await this.provideServices(world, input, notes); } catch (error) { notes.push(`services: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
      try { await this.#sellPower(world, input, notes); } catch (error) { notes.push(`power export: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
      notes.push(`no outward building this cycle (${input.careOnly}); upkeep and the care round only`);
      return wait(input.careOnly);
    }
    if (!follow) {
    // The mix of land uses as the world shows it now; without a reading, the prior corrected by the demand the caller has.
    this.#mix = (await this.port.readZoningMix?.(signal)) ?? (() => {
      const fallback = emptyMix();
      fallback.demand = { residential: input.demand.residential, commercial: input.demand.commercial, office: 0, industrial: input.demand.industrial };
      return fallback;
    })();
    this.#available = ZONE_CATEGORIES.filter((category) => input.zoneFor(category) !== null);
    if (this.#available.length === 0) this.#available = ["residential"];
    this.#paused = [];
    // What the next tile really added (its price rises with the count, on the tiles already owned): measured from the two readings.
    this.#costs = (await this.port.readLandCosts?.(signal)) ?? null;
    const ownedNow = world.ownedTiles.filter((tile) => tile.owned).length;
    if (this.#costs && ownedNow > 0) {
      if (this.#tileReading && ownedNow > this.#tileReading.owned && this.#costs.tileUpkeep > this.#tileReading.upkeep) {
        this.#observedMarginalTileUpkeep = (this.#costs.tileUpkeep - this.#tileReading.upkeep) / (ownedNow - this.#tileReading.owned);
      }
      this.#tileReading = { owned: ownedNow, upkeep: this.#costs.tileUpkeep };
    }
    if (input.pipelined) {
      const stamp = this.#stamp(this.#serviceCycle);
      this.#stockHistory = pruneStockHistory([...this.#stockHistory,
        { cells: JSON.parse(JSON.stringify(this.#mix.cells)) as ZoningMixSignals["cells"], stamp }], stamp);
      const labor = (await this.port.readLabor?.(signal)) ?? null;
      const knownDemand = (["low", "medium", "high"] as const).filter((key) => input.unlocked?.densities[key])
        .map((key) => this.#mix.residentialByDensity?.[key].demand).filter((value): value is number => typeof value === "number");
      const focus = classifyBottleneck(labor, knownDemand.length > 0 ? Math.max(...knownDemand) : null);
      this.#bottleneck = focus.bottleneck;
      this.#paused = pausedLandUses(this.#mix, focus.bottleneck, this.#available);
      if (this.#unfilledStockHolds(input, notes) && !this.#paused.includes("residential")) this.#paused.push("residential");
      notes.push(`pipeline: bottleneck ${focus.bottleneck} (${focus.reason}); paused: ${this.#paused.join("/") || "none"}`);
      if (!intent?.role) {
        let blocked = this.#blockedRoles();
        const pick = (held: readonly string[]) => chooseGrowthRole({ bottleneck: focus.bottleneck, demand: input.demand, available: this.#available, paused: this.#paused, blocked: held });
        let chosen = pick(blocked);
        // Every use that answers the bottleneck is held out: the blocks are ignored this cycle, so the search runs again and the land policy
        // (buying a tile) still gets its turn. A held-out use must never also stop the purchase that would give it land.
        if (!chosen && blocked.length > 0) { chosen = pick([]); blocked = []; }
        if (!chosen) {
          // Growth has nothing usable to build, but the city still needs its care round (services, power, garbage, roads): a wait that skipped it left a
          // city with 3,000 unemployed and 14 garbage notices with no care at all (live 2026-10-06).
          try { await this.provideServices(world, input, notes); } catch (error) { notes.push(`services: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
          return wait(`NO_USABLE_${focus.bottleneck}_SUPPLY`);
        }
        role = chosen;
        this.#cycleRole = role;
        notes.push(`pipeline: policy chose ${role} for ${focus.bottleneck}${blocked.length > 0 ? ` (no site for ${blocked.join("/")} for now)` : ""}` +
          `${role === "commercial" && focus.bottleneck === "JOBS" ? "; commercial fallback: shop inventory not read (P4 precondition unverified)" : ""}`);
      }
    }
    // V2: the stage, the density, the batch and the finance constraint are decided from the readings above, before anything is zoned.
    const plan = input.pipelined ? await this.#planGrowth(input, notes, role) : null;
    for (const category of plan?.paused ?? []) if (!this.#paused.includes(category)) this.#paused.push(category);
    if (!input.zoningHeld && !plan?.frozen) await this.zoneUnzonedFrontage(world, role, landUse, input, notes);
    // The hearse and ambulance icons over the districts: a cemetery or a clinic where they hang.
    try { await this.provideServices(world, input, notes); } catch (error) { notes.push(`services: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
    try { await this.#sellPower(world, input, notes); } catch (error) { notes.push(`power export: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
    if (!plan?.frozen) { try { await this.#withdrawStaleZoning(world, input, notes); } catch (error) { notes.push(`stale zoning: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); } }
    if (!plan?.frozen) { try { await this.#linkTrain(world, input, notes); } catch (error) { notes.push(`train: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); } }
    if (!plan?.frozen) { try { await this.#placeSignatures(world, input, notes); } catch (error) { notes.push(`signature: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); } }
    // P8: after K negative months the growth stops and only repairs go on (the services above and the utility repairs of the Brain).
    if (plan?.frozen) return wait("FINANCE_FROZEN");
    // Homes the city cannot use yet are not laid on new ground; the cycle ends here and the city runs, instead of waiting on it.
    if (role === "residential" && !intent?.role && this.#paused.includes("residential")) {
      notes.push("pipeline: a residential district is held (homes are not the bottleneck, the stock stands empty or jobless, or the city cannot take up more homes now)");
      return wait("HOUSING_HELD");
    }
    const requiredDensity = this.#densityOf(role, input);
    if (requiredDensity && !input.zoneFor(role, requiredDensity)) {
      notes.push(`density: ${requiredDensity} ${role} is unavailable in the current catalogue; no other density is substituted`);
      return { ...empty(), outcome: "REPLAN_REQUIRED", feasibility: { reason: "DENSITY_UNAVAILABLE", density: requiredDensity, role } };
    }
    this.#cycles += 1;
    input = await this.#loanStep(input, notes);
    // Building outward needs cash for months of spending; a positive balance alone does not say the city can afford a district.
    const costs = this.#costs;
    if (input.pipelined) {
      // The batch is recomputed on the treasury as it stands after the loan step (P2).
      const sized = this.#withBatch(input, notes, role);
      input = sized.input;
      if (sized.held && !intent?.role) { notes.push("batch: smaller than one district; nothing is laid and no land is bought for it"); return wait("BATCH_BELOW_ONE_DISTRICT"); }
    }
    // BALANCED follows the study: cash >= the build + the net outflow until it pays + a reserve (`expansionCashRequired`), not months of total spending.
    if (!input.pipelined && input.finance && !cashCoversExpansion({ treasury: input.finance.treasury, monthlyExpenses: costs?.monthlyExpenses ?? null })) {
      notes.push(`expansion held: the treasury (${Math.round(input.finance.treasury)}) covers fewer than the months of spending (${Math.round(costs?.monthlyExpenses ?? 0)}/month) that building outward needs`);
      return wait("TREASURY_COVER");
    }
    }
    const centreOfSite = (site: DistrictSite) => ({ x: site.anchor.x + site.widthMeters / 2, z: site.anchor.z + site.heightMeters / 2 });
    const costs = this.#costs;
    // The ground refuses a big district for one bad line; the same corner may still hold a smaller one. A refusal is
    // remembered per shape, so the next pass of the survey offers the next size down instead of giving the land up.
    // The owned ground, read once: where is it free land, and what are its biggest rectangles? Without a terrain read
    // the ladder of fixed shapes is used instead.
    const landMask = await this.#readLandMask(world, buildings, role, landUse, signal);
    const allRectangles = landMask ? maximalRectangles(landMask.mask, Number.POSITIVE_INFINITY) : null;
    const baseRectangles = allRectangles?.slice(0, 60) ?? null;
    if (landMask && baseRectangles) {
      const free = landMask.mask.free.reduce((sum, cell) => sum + cell, 0);
      const freeHectares = free * landMask.mask.spacing * landMask.mask.spacing / 10_000;
      notes.push(`land: ${free} free lattice cells (${freeHectares.toFixed(0)} ha), ${baseRectangles.length} maximal rectangles` +
        (baseRectangles[0] ? `, biggest ${baseRectangles[0].widthMeters}x${baseRectangles[0].heightMeters}` : ""));
      if (!follow) {
        // Land ahead of need: first the owned land the water cuts off (a bridge costs a road, a tile costs upkeep for ever), then a tile. Only the free land the
        // served streets can reach counts as land in hand: the free land across the water is not.
        const mask = landMask.mask;
        const servedNodes = mainStreetNetwork(world.roadGraph).nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
        const cellCentre = (index: number) => ({ x: mask.origin.x + ((index % mask.columns) + 0.5) * mask.spacing, z: mask.origin.z + (Math.floor(index / mask.columns) + 0.5) * mask.spacing });
        let reachableCells = 0;
        for (let index = 0; index < mask.free.length; index += 1) {
          if (!mask.free[index]) continue;
          const centre = cellCentre(index);
          if (servedNodes.some((node) => Math.hypot(node.x - centre.x, node.z - centre.z) <= MAXIMUM_GATEWAY_METERS)) reachableCells += 1;
        }
        const reachableHectares = reachableCells * mask.spacing * mask.spacing / 10_000;
        this.#boughtAheadThisCycle = false;
        const bridged = await this.#bridgeToStrandedLand(world, input, landMask, servedNodes, reachableHectares, notes, signal);
        if (bridged) this.#boughtAheadThisCycle = true;
        else await this.#buyLandAhead(world, input, reachableHectares, notes, signal);
      }
    }
    const rectangleKey = (rectangle: LandRectangle) => `${Math.round(rectangle.minX)},${Math.round(rectangle.minZ)},${rectangle.widthMeters}x${rectangle.heightMeters}`;
    let surveyDiagnostics = emptySurveyDiagnostics();
    const siteChecks = { unread: 0, buildingCollision: 0, invalidGrid: 0, roadFailure: 0, examined: 0 };
    let sitesUnexamined = 0;
    let geometricCandidateAreaSquareMeters = 0;
    let rectanglesConsidered = 0;
    let passBudgetExhausted = false;
    const searchPasses = landMask ? 6 : 3;
    for (let pass = 0; pass < searchPasses; pass += 1) {
    let rectangles: LandRectangle[] | undefined;
    if (landMask && baseRectangles) {
      const source = pass === 0 ? baseRectangles : allRectangles!;
      rectanglesConsidered = source.length;
      const pool = new Map<string, LandRectangle>(source.map((rectangle) => [rectangleKey(rectangle), rectangle]));
      for (const refused of this.#refusedRectangles.values()) {
        for (const variant of shrunkVariants(refused, landMask.mask.spacing)) {
          if (rectangleIsFree(landMask.mask, variant)) pool.set(rectangleKey(variant), variant);
        }
      }
      rectangles = [...pool.values()].sort((left, right) => right.widthMeters * right.heightMeters - left.widthMeters * left.heightMeters);
    }
    // Every building the owned ground holds, not the Bridge's first 500 (see `#readLandMask`); without a ground read, the list plus what was seen.
    const knownBuildings = landMask ? landMask.buildings : mergeBuildingPoints(buildings, this.#seenBuildings);
    this.#siteBuildings = knownBuildings;
    surveyDiagnostics = emptySurveyDiagnostics();
    const surveyed = surveyDistrictSites({ world, buildings: knownBuildings, excludedAnchors: this.#refused,
      limit: pass === 0 ? (intent ? 14 : 6) : (intent ? 40 : 24), role, landUse,
      diagnostics: surveyDiagnostics, protection, industrialBufferMeters: this.#industrialBuffer(),
      ...(input.maximumAreaSquareMeters !== undefined ? { maximumAreaSquareMeters: input.maximumAreaSquareMeters } : {}),
      ...(rectangles ? { rectangles } : {}) });
    // 攻略 (user-approved 2026-10-05): once high density is unlocked, new homes are laid around the passenger station, where the train sets the
    // newcomers down. Only the ORDER of the surveyed sites changes (nearest the station first); the grid, its shape and every check stay as they are.
    const station = role === "residential" ? this.#highDensityStation(input) : null;
    const sites = intent
      ? surveyed.filter((site) => centreMatchesIntent(centreOfSite(site), intent, cityCentre))
        .sort((left, right) => intentOrder(intent, cityCentre)(centreOfSite(left), centreOfSite(right)))
      : station ? nearestFirst(surveyed, station, centreOfSite) : surveyed;
    if (station && !intent && pass === 0 && sites[0]) notes.push(`high density around the station (${station.x.toFixed(0)},${station.z.toFixed(0)}): nearest site first, ${length(centreOfSite(sites[0]), station).toFixed(0)} m away`);
    geometricCandidateAreaSquareMeters = sites.reduce((sum, site) => sum + site.widthMeters * site.heightMeters, 0);
    notes.push(`survey${pass > 0 ? ` (pass ${pass + 1})` : ""}: ${sites.length} ${role} district sites${intent ? ` of ${surveyed.length} matching the asked ${intent.region}${intent.target ? " point" : ""}` : ""} ` +
      `(${landUse.sensitive.length} sensitive, ${landUse.polluters.length} polluting and ${landUse.loud?.length ?? 0} railway/highway points kept clear` +
      `${surveyDiagnostics.protectedArea ? `; ${surveyDiagnostics.protectedArea} candidate(s) inside the areas the player asked to keep` : ""})`);
    if (sites.length === 0 && mainStreetNetwork(world.roadGraph).nodes.length === 0) {
      notes.push("no city street is joined to the outside: a district needs a street to join, and the first street from an outside connection is not laid by the district builder");
    }
    let refusedThisPass = 0;
    const groundBefore = siteChecks.invalidGrid;
    // A site the ground refuses costs one terrain read, so every surveyed site is looked at before land is bought.
    const inspectedSites = sites.slice(0, this.options.maximumSitesPerCycle ?? (pass === 0 ? (intent ? 10 : 6) : (intent ? 40 : 24)));
    sitesUnexamined = sites.length - inspectedSites.length;
    for (const site of inspectedSites) {
      siteChecks.examined += 1;
      const window = districtTerrainWindow(site);
      const detail = await this.port.siteDetail(window.center, window.radius, window.radius > 512 ? 128 : 64, signal);
      // Waterfront is judged on a terrain read; with no read there is no water to point at.
      if (intent?.region === "WATERFRONT" && (!detail?.terrain || waterShare(detail.terrain) < INTENT_WATERFRONT_MINIMUM_WATER_SHARE)) {
        notes.push(`site ${anchorKey(site.anchor)}: no water at its edge, not the waterfront asked for`);
        continue;
      }
      const siteKey = anchorKey(site.anchor, site);
      // The window's own read names every building in it. A district is never laid over one (its zoning brushes reach up to 16 m past its edge, past
      // the 12 m clearance, so each brush is also cut back to clear known buildings). (Correction, 2026-10-04: the 56 homes first thought to have been under the first live district had GROWN there after it was zoned;
      // the ground was empty when it was laid. This check is hygiene against a list that shows 500 of thousands of buildings, not the cause of those condemnations.
      // The cause measured later: overlapping brushes of different land uses painted while the world runs, so houses grown on the first brush's cells are repainted by the next.)
      // A window that could not be read proves nothing, so the site is not built on this pass.
      const present = buildingsInDistrict(detail, site);
      if (!detail) {
        siteChecks.unread += 1;
        notes.push(`site ${siteKey}: its window could not be read, so it is not proven free of buildings`);
        continue;
      }
      if (present.length > 0) {
        siteChecks.buildingCollision += 1;
        this.#seenBuildings = mergeBuildingPoints(this.#seenBuildings, present).slice(-5_000);
        this.#refused.add(siteKey);
        this.#refusedRectangles.set(siteKey, { minX: site.anchor.x, minZ: site.anchor.z, widthMeters: site.widthMeters, heightMeters: site.heightMeters });
        refusedThisPass += 1;
        notes.push(`site ${siteKey}: ${present.length} existing building(s) stand in it or within ${DISTRICT_CLEARANCE_METERS} m of it — not laid over them`);
        continue;
      }
      const why: { reason?: "GRID_UNPLANNABLE" | "TERRAIN_LOSS" | "GATEWAY_GROUND" } = {};
      let plan = compileDistrict(site, detail?.terrain, why);
      if (!plan) {
        siteChecks.invalidGrid += 1;
        // The way in (the gateway from the served streets) crosses water or a cliff: the land is there, the road to it is not — a bridge's case.
        if (why.reason === "GATEWAY_GROUND") this.#gatewayGroundRefused = true;
        this.#refused.add(siteKey);
        this.#refusedRectangles.set(siteKey, { minX: site.anchor.x, minZ: site.anchor.z, widthMeters: site.widthMeters, heightMeters: site.heightMeters });
        refusedThisPass += 1;
        notes.push(`site ${siteKey}: ground refuses the grid (${why.reason ?? "unknown"})`);
        continue;
      }
      let result = await this.#buildDistrict(plan, role, input, notes, world);
      // The way in was refused before anything was laid: the site keeps its other ways in (the next-shortest entrances the survey found). Each is
      // put to the game's dry run, and the first it certifies is laid with the district re-planned around it. Measured live 2026-10-06 (13.9k city):
      // four sites in a row were lost to an "overlap" refusal of the shortest entrance alone.
      if (result.roadsLanded === 0 && result.gatewayRefused && result.roadsBuilt === 0) {
        const retried = await this.#retryWithAnotherGateway(plan, detail?.terrain, role, input, notes, world);
        if (retried) { plan = retried.plan; result = retried.result; }
      }
      if (result.zonesPainted > 0 || (result.zonesDeferred ?? 0) > 0) {
        this.#zoned.push({ role, rect: { minX: site.anchor.x, minZ: site.anchor.z,
          maxX: site.anchor.x + site.widthMeters, maxZ: site.anchor.z + site.heightMeters } });
      }
      const landedShare = result.roadsLanded / Math.max(1, result.plannedCourses ?? 1);
      if (result.roadsLanded > 0 && landedShare < MINIMUM_LANDED_SHARE) {
        siteChecks.roadFailure += 1;
        // Too little of it stands to be a district. Its leftovers — streets this Mayor laid, now dead ends — are pruned back.
        const pruned = await this.pruneOwnFragments({ minX: site.anchor.x - 12, minZ: site.anchor.z - 12, maxX: site.anchor.x + site.widthMeters + 12, maxZ: site.anchor.z + site.heightMeters + 12 }, notes, signal);
        this.#refused.add(siteKey);
        this.#refusedRectangles.set(siteKey, { minX: site.anchor.x, minZ: site.anchor.z, widthMeters: site.widthMeters, heightMeters: site.heightMeters });
        refusedThisPass += 1;
        notes.push(`site ${siteKey}: only ${(landedShare * 100).toFixed(0)}% of its streets stood; ${pruned} leftover street(s) pruned`);
        continue;
      }
      if (result.roadsLanded === 0) {
        siteChecks.roadFailure += 1;
        this.#refused.add(siteKey);
        this.#refusedRectangles.set(siteKey, { minX: site.anchor.x, minZ: site.anchor.z, widthMeters: site.widthMeters, heightMeters: site.heightMeters });
        refusedThisPass += 1;
        notes.push(`site ${siteKey}: the world built none of it`);
        continue;
      }
      const facilities = await this.#provideUtilities(site, input, listed.length, notes);
      this.#boughtTileUnused = false;
      if (role === "residential" && input.pipelined) {
        const area = site.widthMeters * site.heightMeters;
        if (this.#chosenDensity === "LOW") this.#laidResidential.low += area; else this.#laidResidential.other += area;
      }
      return facilities.length > 0 ? { ...result, facilities } : result;
    }
    // The first 60 rectangles and six sites keep the usual path fast; a failure expands the search once.
    // A last pass whose every refusal was the ground's (water, a cliff, the way in) has its answer: the shrunk variants were offered on the passes
    // before, and the next cycle would offer the same ground again. Live 2026-10-05: 68 of 127 cycles ended REPLAN_REQUIRED on exactly that, building
    // nothing and buying nothing. Only refusals that may change (a building that may go, a street the world did not build) keep the search open.
    if (refusedThisPass > 0 && pass === searchPasses - 1 && siteChecks.invalidGrid - groundBefore < refusedThisPass) passBudgetExhausted = true;
    if (refusedThisPass === 0 && (!landMask || pass > 0)) break;
    }
    // A second district of a batch that finds no ground ends the batch; land is bought only by the cycle that opened it.
    const coverage = { rectanglesConsidered, rectanglesTotal: allRectangles?.length ?? null, sitesUnexamined,
      complete: landMask !== null && rectanglesConsidered === allRectangles?.length && !surveyDiagnostics.limitReached &&
        sitesUnexamined === 0 && !passBudgetExhausted };
    const feasibility = { reason: siteChecks.unread > 0 ? "SITE_READ_UNAVAILABLE" as const : "NO_SITE_IN_BOUNDED_SEARCH" as const,
      survey: surveyDiagnostics, siteChecks, coverage, targetAreaSquareMeters: follow?.remainingArea ?? this.#batch?.limit ?? input.maximumAreaSquareMeters ?? null,
      geometricCandidateAreaSquareMeters };
    notes.push(`survey gates: ${JSON.stringify({ ...surveyDiagnostics, ...siteChecks })}`);
    if (siteChecks.unread > 0) return { ...empty(), outcome: "SAFETY_BLOCKED", feasibility };
    if (follow) notes.push("batch: no further site on the ground already owned; policy is deciding the remaining batch");
    // A player who named a place does not get a district somewhere else: with no land there and no leave to buy it,
    // the answer is that the intent cannot be met yet.
    const namedPlace = intent !== null && intentNamesAPlace(intent);
    if (namedPlace && !intent.acquireLand) {
      notes.push(`intent: no owned land ${intent.target ? "near the point" : `in the ${intent.region} region`} holds a district; buying land was not asked for`);
      return { ...empty(), intentUnmet: true, feasibility };
    }
    // No owned land holds a district: buy the next tile, the way a player expands when the map runs out. A named
    // place narrows the tiles to the ones that are there, nearest the place first.
    // K34: land is paid for out of earnings. Without a finance reading the caller's own permission stands (tests, tools);
    // with one, the recurring upkeep a tile adds must fit the monthly surplus. A player who asked for land by name
    // overrides the surplus test, never the cash reserve that the district on that land needs.
    // A tile bought ahead of need in this very cycle (`#buyLandAhead`) is this cycle's answer to "no site": the new land shows in the next world read.
    if (this.#boughtAheadThisCycle && !namedPlace) return { ...empty(), status: "LAND_PURCHASED", feasibility };
    const owned = world.ownedTiles.filter((tile) => tile.owned).length;
    let landAllowed = input.finance
      ? (intent?.acquireLand
        ? input.finance.treasury >= LAND_PURCHASE_CASH_RESERVE
        // LIVE_REVALIDATION_PENDING: the purchase protections (reach, buildable share, one unused tile at a time) and this cash rule were
        // added after the 2026-10-04 over-buying incident and have only been exercised on that already-damaged world.
        : landPurchaseAffordable({ ...input.finance, ownedTiles: owned, tileUpkeep: costs?.tileUpkeep ?? null, monthlyExpenses: costs?.monthlyExpenses ?? null,
          observedMarginalUpkeep: this.#observedMarginalTileUpkeep,
          ...(input.pipelined ? { requiredCash: expansionCashRequired(input.finance.monthlyBalance) } : {}) }))
      : true;
    // Land is bought when the land already owned is used, not when there is money: while the zoning on hand stands mostly
    // empty, the city has capacity it has not filled.
    const zonedAll = ZONE_CATEGORIES.reduce((sum, category) => sum + this.#mix.cells[category].zoned, 0);
    const emptyAll = ZONE_CATEGORIES.reduce((sum, category) => sum + this.#mix.cells[category].empty, 0);
    // FAST_EXPANSION asks whether the supply the city NEEDS is being taken up (its own unbuilt zoning, falling over recent
    // cycles), not what share of all the zoning stands empty: stock of a use the city does not need must not hold land back.
    let capacityUsed = zonedAll === 0 || emptyAll / zonedAll <= CAPACITY_USED_MAXIMUM_UNREALIZED;
    if (input.pipelined) {
      // P5 uses the planner evidence for this batch; raw owned area does not prove that a district can be laid.
      const decision = decideGrowthAfterSearch({ targetAreaSquareMeters: feasibility.targetAreaSquareMeters,
        deliveredAreaSquareMeters: 0, geometricCandidateAreaSquareMeters, searchComplete: coverage.complete,
        unreadSites: siteChecks.unread, rejectedSites: siteChecks.buildingCollision + siteChecks.invalidGrid + siteChecks.roadFailure +
          surveyDiagnostics.buildingClearance + surveyDiagnostics.landUseIsolation + surveyDiagnostics.existingRoad + surveyDiagnostics.blockedGateway });
      notes.push(`land (P5): ${decision.reason}`);
      if (decision.action === "REPLAN") return { ...empty(), outcome: "REPLAN_REQUIRED", feasibility };
      capacityUsed = decision.action === "BUY_LAND";
    }
    else if (!capacityUsed && !intent?.acquireLand) notes.push(`land: not bought — ${Math.round((emptyAll / zonedAll) * 100)}% of the zoning on hand still stands empty`);
    // The way out of a dead end (`landPurchaseRunwayAffordable`): the owned land holds no district, K34 refuses the tile, and so nothing is built.
    // Only after the city has stood still for a few game hours (a refusal that lifts by itself is not a dead end), only for the policy's own growth (a
    // player's named request keeps its own rule), never while outward spending is cut, and one tile at a time (`#boughtTileUnused`, below).
    if (!landAllowed && capacityUsed && input.finance && input.pipelined && !intent?.acquireLand && !this.#cutSpending) {
      this.#landHeldSince ??= this.#stamp(this.#cycles);
      if (stampElapsed(this.#landHeldSince, this.#stamp(this.#cycles), LAND_FINANCE_ESCAPE_HOURS, LAND_FINANCE_ESCAPE_CYCLES) &&
        landPurchaseRunwayAffordable({ ...input.finance, ownedTiles: owned, tileUpkeep: costs?.tileUpkeep ?? null, monthlyExpenses: costs?.monthlyExpenses ?? null,
          observedMarginalUpkeep: this.#observedMarginalTileUpkeep, requiredCash: expansionCashRequired(input.finance.monthlyBalance) })) {
        landAllowed = true;
        notes.push(`land: nothing could be built for ${LAND_FINANCE_ESCAPE_HOURS}+ game hours; the cash (${Math.round(input.finance.treasury)}) carries the tile's deficit for ${LAND_ESCAPE_RUNWAY_MONTHS} months, so one tile is bought on it (P8: reserve, not surplus)`);
      }
    } else if (landAllowed || !capacityUsed) this.#landHeldSince = null;
    if (!landAllowed) notes.push(`land: not bought — treasury ${input.finance?.treasury ?? "?"}, monthly balance ${input.finance?.monthlyBalance ?? "?"}, ${owned} tiles owned (K34)`);
    if (this.#cutSpending && !intent?.acquireLand) notes.push("land: not bought — the loan stands past the top tier, outward spending is cut (P8)");
    // 新攻略补充 (the user's ruling, 2026-10-05): before the milestones unlock high density, land is not bought to spread low density. The city waits on
    // its own land (and the bridges to it) instead of buying; a player's named request keeps its own rule.
    if (input.pipelined && !intent?.acquireLand && capacityUsed && this.port.purchaseTile && input.mayPurchaseLand && !this.#landForHighDensity(input)) {
      notes.push("land: not bought — high density is not unlocked yet, and land is bought only for high-density districts (新攻略补充)");
      return namedPlace ? { ...empty(), intentUnmet: true, feasibility } : { ...wait("LAND_HELD_UNTIL_HIGH_DENSITY"), feasibility };
    }
    if (this.port.purchaseTile && input.mayPurchaseLand && landAllowed && !(this.#cutSpending && !intent?.acquireLand) && (capacityUsed || intent?.acquireLand)) {
      const tiles = nextTileCandidates(world);
      const candidates = namedPlace
        ? tiles.filter((tile) => centreMatchesIntent(tile, intent, cityCentre)).sort(intentOrder(intent, cityCentre))
        : tiles;
      if (namedPlace && candidates.length === 0) notes.push("intent: no neighbouring tile lies in the asked place");
      // A tile is worth its upkeep only if a district can then be laid on it: within a gateway's reach of the served network,
      // and land a street grid can stand on. Measured live (2026-10-04): six tiles bought on one run took the tile upkeep from
      // 0 to 99k a month; the later ones were flat, open and 600 m from any street, so no district could ever reach them.
      const tileSide = Math.min(...world.ownedTiles.filter((tile) => tile.owned && tile.bounds).map((tile) => tile.bounds!.max.x - tile.bounds!.min.x));
      const served = mainStreetNetwork(world.roadGraph).nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
      if (this.#boughtTileUnused && !intent?.acquireLand) {
        notes.push("land: not bought — the tile bought last has not yet held a district");
        return namedPlace ? { ...empty(), intentUnmet: true, feasibility } : { ...wait("TILE_BOUGHT_UNUSED"), feasibility };
      }
      const purchase = await this.#purchaseNextTile(candidates, tileSide, served, notes, signal);
      if (purchase === "BOUGHT") return { ...empty(), status: "LAND_PURCHASED", feasibility };
      // The game's refusal (no tile available yet, funds) is the same for every tile this cycle.
      if (purchase === "REFUSED") this.#purchaseRefusedByGame = true;
    }
    else notes.push(this.port.purchaseTile ? "no site fits and no tile is bought this cycle (the treasury, the runway or the land policy does not call for one)" : "no site fits and this host cannot purchase tiles");
    if (!namedPlace && !intent?.acquireLand && capacityUsed && (!landAllowed || this.#cutSpending)) return { ...wait("LAND_FINANCE_HELD"), feasibility };
    // The game itself will not sell a tile yet ("reach the next milestone"): live 2026-10-05 this was reported as NO_FEASIBLE_SITE, three of them in a row
    // halted the whole run at 3 minutes with the world paused. It lifts by itself when the city grows: the city waits, it does not stop.
    if (this.#purchaseRefusedByGame) { this.#purchaseRefusedByGame = false; if (!namedPlace && !intent?.acquireLand) return { ...wait("LAND_PURCHASE_UNAVAILABLE"), feasibility }; }
    return namedPlace ? { ...empty(), intentUnmet: true, feasibility } : { ...empty(), feasibility };
  }

  /** The first of the candidate tiles worth its upkeep (within a gateway's reach, mostly buildable) is bought; the game's own refusal ends the try. */
  async #purchaseNextTile(candidates: readonly SpatialPoint2[], tileSide: number, served: readonly SpatialPoint2[], notes: string[], signal?: AbortSignal):
    Promise<"BOUGHT" | "REFUSED" | "NONE"> {
    if (!this.port.purchaseTile) return "NONE";
    for (const point of candidates.slice(0, 4)) {
      const reach = served.length === 0 ? 0 : Math.min(...served.map((node) => length(node, point))) - tileSide / 2;
      if (reach > MAXIMUM_GATEWAY_METERS) {
        notes.push(`tile (${point.x.toFixed(0)},${point.z.toFixed(0)}): ${reach.toFixed(0)} m from the served network, beyond a gateway's reach, not bought`);
        continue;
      }
      const detail = await this.port.siteDetail(point, tileSide / 2, 32, signal);
      const land = usableLandShare(detail?.terrain, point, tileSide);
      if (land.covered < 0.8 || land.usable < MINIMUM_TILE_USABLE_SHARE) {
        notes.push(`tile (${point.x.toFixed(0)},${point.z.toFixed(0)}): ${(land.usable * 100).toFixed(0)}% of it buildable (${(land.covered * 100).toFixed(0)}% read), not bought`);
        continue;
      }
      const bought = await this.port.purchaseTile(point, signal);
      notes.push(`tile (${point.x.toFixed(0)},${point.z.toFixed(0)}): ${bought.ok ? "bought" : "refused"} ${bought.detail.slice(0, 160)}`);
      if (bought.ok) { this.#boughtTileUnused = true; return "BOUGHT"; }
      return "REFUSED";
    }
    return "NONE";
  }

  /**
   * Owned land the water cuts off from the served streets: one road over the water to the far bank (see `water-crossing.ts`), then the district search
   * finds the far bank like any other ground. Only when the land the streets reach is running low (`LAND_AHEAD_FREE_HECTARES`), with cash for the road,
   * and never while outward spending is cut. The game's own dry run decides first; a crossing it refuses, or that does not read back, is tried at most
   * `BRIDGE_MAXIMUM_ATTEMPTS` times. A batch of up to BRIDGES_PER_BATCH bridges per cycle. Returns whether any bridge was built.
   */
  async #bridgeToStrandedLand(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput,
    landMask: { mask: ReturnType<typeof buildLandMask> }, servedNodes: readonly SpatialPoint2[], reachableHectares: number, notes: string[], signal?: AbortSignal): Promise<boolean> {
    // The free land "within reach" counts ground across water too; a site refused because its way in crosses water says that land is not reached.
    const wayInRefused = this.#gatewayGroundRefused;
    this.#gatewayGroundRefused = false;
    if (!input.pipelined || input.intent || this.#cutSpending || (reachableHectares >= LAND_AHEAD_FREE_HECTARES && !wayInRefused)) return false;
    if (input.finance && input.finance.treasury < BRIDGE_MINIMUM_TREASURY) return false;
    const terrain = this.#ground?.terrain;
    if (!terrain || servedNodes.length === 0) return false;
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    const mask = landMask.mask;
    const crossings = findWaterCrossings({ terrain, servedNodes, isOwned: (point) => tiles.some((tile) => pointInTile(point, tile)),
      freeCellsAround: (point, radius) => {
        let count = 0;
        for (let index = 0; index < mask.free.length; index += 1) {
          if (!mask.free[index]) continue;
          const x = mask.origin.x + ((index % mask.columns) + 0.5) * mask.spacing;
          const z = mask.origin.z + (Math.floor(index / mask.columns) + 0.5) * mask.spacing;
          if (Math.hypot(x - point.x, z - point.z) <= radius) count += 1;
        }
        return count;
      } });
    if (crossings.length === 0) return false;
    const stamp = this.#stamp(this.#cycles);
    const eligible = crossings.filter((crossing) => {
      const tried = this.#bridgeAttempts.get(this.#bridgeKey(crossing));
      return !(tried && (tried.count >= BRIDGE_MAXIMUM_ATTEMPTS || !stampElapsed(tried.at, stamp, BRIDGE_RETRY_HOURS, BRIDGE_RETRY_CYCLES)));
    });
    // A batch, like a street grid: the best non-duplicate crossings in turn, until BRIDGES_PER_BATCH stand or BRIDGE_TRIES_PER_CYCLE were asked of the game.
    let built = 0;
    let tries = 0;
    for (const crossing of selectBridgeBatch(eligible, BRIDGE_TRIES_PER_CYCLE)) {
      if (signal?.aborted || built >= BRIDGES_PER_BATCH) break;
      tries += 1;
      const key = this.#bridgeKey(crossing);
      const tried = this.#bridgeAttempts.get(key);
      const course = { start: crossing.from, end: crossing.to };
      let verdict = "OK";
      if (this.port.preflightRoad) { try { verdict = await this.port.preflightRoad(course, DISTRICT_ROAD_PREFAB, signal); } catch { /* fail open: the build is its own answer */ } }
      const attempt = { count: (tried?.count ?? 0) + 1, at: stamp };
      this.#bridgeAttempts.set(key, attempt);
      const what = `bridge (${crossing.from.x.toFixed(0)},${crossing.from.z.toFixed(0)}) to (${crossing.to.x.toFixed(0)},${crossing.to.z.toFixed(0)}): ${crossing.waterMeters.toFixed(0)} m of water, ${crossing.farFreeCells} free cells on the far bank`;
      if (verdict.startsWith("REJECT")) { notes.push(`${what}: refused by the dry run (${verdict.replace(/^REJECT:/, "").slice(0, 70)}); attempt ${attempt.count} of ${BRIDGE_MAXIMUM_ATTEMPTS}`); continue; }
      const outcome = await this.#buildOwned(course, DISTRICT_ROAD_PREFAB, signal);
      notes.push(`${what}: ${outcome.ok ? "built; the far bank joins the served network" : `refused ${outcome.detail.slice(0, 80)}; attempt ${attempt.count} of ${BRIDGE_MAXIMUM_ATTEMPTS}`}`);
      if (outcome.ok) { this.#bridgeAttempts.delete(key); this.#frontageDirty = true; built += 1; }
    }
    if (tries > 0) notes.push(`bridges: ${built} built of ${tries} asked this cycle (a batch is up to ${BRIDGES_PER_BATCH})`);
    return built > 0;
  }

  /**
   * The surplus power is sold (`power-export.ts`): looked at every POWER_EXPORT_REVIEW_HOURS of game time, never while outward spending is cut or the
   * cash is below the reserve a transformer and its cables need. What the world answered is the whole state: a transformer that stands is not placed again.
   */
  async #sellPower(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput, notes: string[]): Promise<void> {
    // Selling earns: it runs while outward spending is cut and in the care-only cycles (financial recovery, expansion held) too.
    if (!this.port.powerExport) return;
    if (input.finance && input.finance.treasury < POWER_EXPORT_MINIMUM_TREASURY) return;
    const stamp = this.#stamp(this.#cycles);
    if (this.#powerExportAt && !stampElapsed(this.#powerExportAt, stamp, POWER_EXPORT_REVIEW_HOURS, POWER_EXPORT_REVIEW_CYCLES)) return;
    this.#powerExportAt = stamp;
    const network = mainStreetNetwork(world.roadGraph);
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    await linkPowerExport(this.port.powerExport, { servedNodes: network.nodes.map((node) => ({ x: node.position.x, z: node.position.z })), servedEdges: network.edges,
      isOwned: (point) => tiles.some((tile) => pointInTile(point, tile)), ...(input.signal ? { signal: input.signal } : {}) }, notes);
  }

  /**
   * Land may be bought for expansion only once a dense housing type is unlocked (medium rows from M2 or high from M8, read from the catalogue, or the S3 stage the milestone gives): before that,
   * every tile would carry low density and its upkeep for ever (live 2026-10-05: at M3 with the owned land full and cash in hand, 31 of 105 cycles waited on high density that M8 brings; medium rows are what the speedrun builds before it) (Economy 2.0 tile upkeep). Unreadable: not bought (the rule fails closed).
   */
  /**
   * Passenger trains from outside (`train-link.ts`; 新攻略补充: the first priority once trains unlock). Looked at every TRAIN_LINK_REVIEW_HOURS while the
   * station and track are unlocked and none stands; at most TRAIN_LINK_MAXIMUM_ATTEMPTS placements that fail. Land the link needs is bought as a strategic
   * channel (P5 reason 1: not held back by the high-density land rule), one tile at a time and only on the same cash runway the rolling purchase uses.
   */
  async #linkTrain(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput, notes: string[]): Promise<void> {
    const port = this.port.trainLink;
    // A station carries nobody without a line: once one stands, the passenger loop platform -> outside connection -> platform is made (and only read
    // back afterwards: the world shows it stands). Looked at on the train cadence; a refused line is tried again on the next look.
    if (this.#trainLinked && this.port.transit && !this.#trainLoopStands) {
      const stamp = this.#stamp(this.#cycles);
      if (!this.#trainLoopLookedAt || stampElapsed(this.#trainLoopLookedAt, stamp, TRAIN_LINK_REVIEW_HOURS, TRAIN_LINK_REVIEW_CYCLES)) {
        this.#trainLoopLookedAt = stamp;
        const loop = await ensureTrainLoop(this.port.transit, notes, input.signal);
        if (loop.status === "EXISTS" || loop.status === "CREATED") { this.#trainLoopStands = true; this.#stationAt = loop.platformAt; }
      }
    }
    if (!port || !input.pipelined || this.#cutSpending || this.#trainLinked || this.#trainAttempts >= TRAIN_LINK_MAXIMUM_ATTEMPTS) return;
    // The stations and tracks are locked until their development-tree nodes are bought (points, not money): looked at on its own, shorter, cadence and
    // not held by the treasury. Only when the railway is unlocked does the build below start.
    const techStamp = this.#stamp(this.#cycles);
    if (this.port.techTree && !this.#railwayUnlocked && (!this.#techLookedAt || stampElapsed(this.#techLookedAt, techStamp, TECH_REVIEW_HOURS, TECH_REVIEW_CYCLES))) {
      this.#techLookedAt = techStamp;
      const tech = await unlockRailway(this.port.techTree, notes, input.signal);
      if (tech.status === "NOTHING_TO_BUY") this.#railwayUnlocked = true;
      if (tech.status === "BOUGHT") this.#techLookedAt = null;
    }
    // The railway is unlocked by its nodes, then by BUILDING a rail yard (the game's "Rail Yard Built Req"): placed by geometry, never searched blind.
    if (this.port.techTree && this.#railwayUnlocked && !this.#yardDone && (!this.#yardLookedAt || stampElapsed(this.#yardLookedAt, techStamp, RAIL_YARD_REVIEW_HOURS, RAIL_YARD_REVIEW_CYCLES))) {
      this.#yardLookedAt = techStamp;
      await this.#buildRailYard(world, input, notes);
    }
    if (input.finance && input.finance.treasury < TRAIN_LINK_MINIMUM_TREASURY) return;
    const stamp = this.#stamp(this.#cycles);
    if (this.#trainLookedAt && !stampElapsed(this.#trainLookedAt, stamp, TRAIN_LINK_REVIEW_HOURS, TRAIN_LINK_REVIEW_CYCLES)) return;
    this.#trainLookedAt = stamp;
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    const bought: SpatialPoint2[] = [];
    const isOwned = (point: SpatialPoint2) => tiles.some((tile) => pointInTile(point, tile)) || bought.some((tile) => Math.hypot(tile.x - point.x, tile.z - point.z) < 250);
    const costs = this.#costs;
    const acquire = async (point: SpatialPoint2) => {
      if (!this.port.purchaseTile || !input.mayPurchaseLand || !input.finance || bought.length >= 2) return false;
      const owned = world.ownedTiles.filter((tile) => tile.owned).length + bought.length;
      if (!landPurchaseRunwayAffordable({ ...input.finance, ownedTiles: owned, tileUpkeep: costs?.tileUpkeep ?? null, monthlyExpenses: costs?.monthlyExpenses ?? null,
        observedMarginalUpkeep: this.#observedMarginalTileUpkeep, requiredCash: expansionCashRequired(input.finance.monthlyBalance) })) {
        notes.push(`train: the tile at (${point.x.toFixed(0)},${point.z.toFixed(0)}) is needed for the railway, but the cash does not carry its upkeep (P8)`);
        return false;
      }
      const result = await this.port.purchaseTile(point, input.signal);
      notes.push(`train: the tile at (${point.x.toFixed(0)},${point.z.toFixed(0)}) ${result.ok ? "bought for the railway (P5 reason 1: strategic channel)" : `not sold (${result.detail.slice(0, 60)})`}`);
      if (result.ok) bought.push(point);
      return result.ok;
    };
    const network = mainStreetNetwork(world.roadGraph);
    const outcome = await linkTrainStation(port, { servedNodes: network.nodes.map((node) => ({ x: node.position.x, z: node.position.z })), isOwned, acquire,
      ...(input.signal ? { signal: input.signal } : {}) }, notes);
    if (outcome.status === "LINKED" || outcome.status === "STANDING") this.#trainLinked = true;
    else if (outcome.status === "LINK_FAILED" || outcome.status === "NO_SITE" || outcome.status === "NO_TRACK_READ") this.#trainAttempts += 1;
    if (bought.length > 0) this.#frontageDirty = true;
  }

  /**
   * A building the game marks burned down, collapsed or condemned stands as a ruin on its lot, and the lot grows nothing while it stands. The notice
   * names the building, so it is taken down exactly (the zoning under it stays, and the lot grows a new building by itself; a cell that lost its zoning
   * is painted again by the next zoning pass). A few per cycle, each building tried once; never a public service, a utility or anything this Mayor
   * placed (those have their own repair).
   */
  async #clearRuins(reading: IconReading, notes: string[], signal?: AbortSignal): Promise<void> {
    const remove = this.port.utilities?.remove;
    if (!remove) return;
    const ruins = reading.items.filter((item) => item.entity && RUIN_NOTICE.test(item.type) && !(item.prefab && RUIN_KEEP_PREFAB.test(item.prefab)) &&
      !this.#ownFacilities.has(`${item.entity.index}:${item.entity.version}`) && !this.#ruinRefused(`${item.entity.index}:${item.entity.version}`) &&
      // A ruin is not an asset: the game itself says to bulldoze a burned-down, collapsed or abandoned building, and its zoned lot grows a new one.
      // So "preserve the player's buildings" does not keep ruins (decided by the player, 2026-10-06: "坍塌直接拆了重建"); only an area the player
      // named does (removals carry no place, so the check is made here).
      protection.circle({ x: item.x, z: item.z }) === null);
    if (ruins.length === 0) return;
    let cleared = 0;
    for (const ruin of ruins.slice(0, RUINS_PER_CYCLE)) {
      if (signal?.aborted || this.#assist?.exhausted()) break;
      const ruinKey = `${ruin.entity!.index}:${ruin.entity!.version}`;
      const attempts = (this.#ruinsTried.get(ruinKey)?.attempts ?? 0) + 1;
      this.#ruinsTried.set(ruinKey, { attempts, at: this.#stamp(this.#serviceCycle) });
      this.#assist?.noteWrite();
      if (await remove(ruin.entity!, signal)) cleared += 1;
    }
    notes.push(`ruins: ${cleared} of ${Math.min(ruins.length, RUINS_PER_CYCLE)} ${ruins[0]!.type.toLowerCase()} building(s) taken down at the notice (${ruins.length} stand); the zoned lots grow new ones`);
  }

  /**
   * P3: "zoning that stays undeveloped is withdrawn" (EmptyZones is its own suppression of demand). Live 2026-10-05: commercial 51%, office 60% and mixed
   * old town 71% of their zoning stood empty, the game's EmptyBuildings factor held the demand of those uses and of medium density at nil, and the
   * city could not grow homes for it. When a use (commercial, office) stands at least STALE_EMPTY_SHARE empty, a few free spots beside our streets are
   * dezoned each pass: only a spot whose empty zoning (at least STALE_MINIMUM_EMPTY_IN_DISK cells) is that use and nothing else, written through the
   * usual fresh-read admission, which cuts the brush back clear of every building and occupied cell. Never a use that is not over-supplied; never homes.
   */
  async #withdrawStaleZoning(world: Pick<SpatialWorldModel, "roadGraph">, input: DistrictCycleInput, notes: string[]): Promise<void> {
    const read = this.port.readZoningAround;
    if (!read || !input.pipelined) return;
    const signal = input.signal;
    const stamp = this.#stamp(this.#cycles);
    if (this.#staleReviewAt && !stampElapsed(this.#staleReviewAt, stamp, STALE_REVIEW_HOURS, STALE_REVIEW_CYCLES)) return;
    const over: string[] = (["commercial", "office"] as const).filter((category) => {
      const { zoned, empty } = this.#mix.cells[category];
      return zoned > 0 && empty >= STALE_MINIMUM_EMPTY_CELLS && empty / zoned >= STALE_EMPTY_SHARE;
    });
    // Medium and mixed homes too, once their own zoning stands this empty: it is what holds the game's demand for them at nil (EmptyBuildings), and with
    // low density over its quota and high density locked, the city has no other home to lay. Low-density zoning is never withdrawn.
    const medium = this.#mix.residentialByDensity?.medium;
    const mediumStale = !!medium && medium.zoned > 0 && medium.empty >= STALE_MINIMUM_EMPTY_CELLS && medium.empty / medium.zoned >= STALE_MEDIUM_EMPTY_SHARE;
    if (mediumStale) over.push("medium homes");
    // High density too (live 2026-10-05, M8: 3,795 high-density cells zoned the moment it unlocked, 90% of them empty, the game's demand for it held at nil by
    // EmptyBuildings -617 while it asked for low density): a batch priced by the city's people-per-cell, which is a low-density figure, is several times too large.
    const high = this.#mix.residentialByDensity?.high;
    if (!!high && high.zoned > 0 && high.empty >= STALE_MINIMUM_EMPTY_CELLS && high.empty / high.zoned >= STALE_EMPTY_SHARE) over.push("high homes");
    if (over.length === 0) return;
    this.#staleReviewAt = stamp;
    const pattern = new RegExp(over.map((category) => (category === "commercial" ? "Commercial" : category === "office" ? "Office" : category === "high homes" ? "High" : "Medium|Mixed")).join("|"), "i");
    const spots: SpatialPoint2[] = [];
    for (const edge of mainStreetNetwork(world.roadGraph).edges) {
      // Any street of the city (zoning lines every one of them; which streets this process built is forgotten at a restart).
      if (edge.native === true || length(edge.start, edge.end) < 30) continue;
      const mid = { x: (edge.start.x + edge.end.x) / 2, z: (edge.start.z + edge.end.z) / 2 };
      const dx = edge.end.x - edge.start.x; const dz = edge.end.z - edge.start.z; const span = Math.hypot(dx, dz);
      for (const side of [1, -1]) spots.push({ x: mid.x + (-dz / span) * STALE_SPOT_OFFSET_METERS * side, z: mid.z + (dx / span) * STALE_SPOT_OFFSET_METERS * side });
    }
    if (spots.length === 0) return;
    const brushes: ZoningBrush[] = [];
    let looked = 0;
    for (let step = 0; step < Math.min(spots.length, STALE_SPOTS_READ_PER_PASS) && brushes.length < STALE_BRUSHES_PER_PASS; step += 1) {
      if (signal?.aborted) break;
      const spot = spots[(this.#staleCursor + step) % spots.length]!;
      looked += 1;
      const rows = await read(spot, STALE_READ_RADIUS_METERS, signal);
      if (!rows || rows.length === 0) continue;
      const occupiedCells = rows.reduce((sum, row) => sum + row.occupied, 0);
      const staleEmpty = rows.filter((row) => pattern.test(row.zone)).reduce((sum, row) => sum + row.empty, 0);
      const otherEmpty = rows.filter((row) => !pattern.test(row.zone)).reduce((sum, row) => sum + row.empty, 0);
      // Buildings in the disk do not stop it: the admission below reads the ground afresh and cuts the brush back clear of every building and occupied cell
      // (and drops it where nothing useful fits), the same protection every zoning write has. What stops it here is a disk whose empty zoning is not that use.
      void occupiedCells;
      if (staleEmpty >= STALE_MINIMUM_EMPTY_IN_DISK && otherEmpty === 0) brushes.push({ zone: "None", center: spot, radius: STALE_BRUSH_RADIUS_METERS });
    }
    this.#staleCursor = (this.#staleCursor + looked) % Math.max(1, spots.length);
    if (brushes.length === 0) { notes.push(`stale zoning (P3): ${over.join(" and ")} stand over their empty share; ${looked} spots looked at, none is a free, wholly empty spot of that use`); return; }
    const outcome = await this.#admitAndWrite(brushes, signal);
    notes.push(`stale zoning (P3): ${over.join(", ")} stand over their empty share: ` +
      `${outcome.written.length} free spot(s) dezoned (${outcome.dropped.length} dropped by the fresh-read admission, ${outcome.failed.length} refused)`);
    if (outcome.written.length > 0) this.#frontageDirty = true;
  }

  /**
   * The rail yard the railway's unlock asks to be built (`big-building-site.ts`): its footprint is read from the Bridge before anything is placed, the
   * free land (the product's own mask) is searched for a rectangle that holds it, each site is asked of the game once at most, the refusals are
   * remembered across restarts, and when no free land holds it a tile is bought toward the railway. No sweep of preflights.
   */
  async #buildRailYard(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput, notes: string[]): Promise<void> {
    const trainLink = this.port.trainLink; const tech = this.port.techTree;
    if (!trainLink || !tech || !this.port.findPrefabs) return;
    const signal = input.signal;
    // Only while the stations are still locked and a yard is unlocked but not built.
    if ((await trainLink.stationPrefabs(signal)).length > 0) { this.#yardDone = true; return; }
    const yards = (await this.port.findPrefabs("RailYard", signal)).filter((entry) => /^RailYard\d+$/.test(entry.name));
    const prefab = yards.find((entry) => !entry.locked)?.name;
    if (!prefab) return;
    if ((await trainLink.listStations(prefab, signal)).length > 0) { this.#yardDone = true; notes.push(`train: a ${prefab} stands; the stations unlock with it`); return; }
    const network = mainStreetNetwork(world.roadGraph);
    const servedNodes = network.nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
    const anchor = railAnchor(await trainLink.railEdges(signal), servedNodes);
    if (!anchor) { notes.push("train: a rail yard is asked for, but no native railway lies within reach of the streets"); return; }
    const locks = await tech.prefabLocks([{ prefab, category: "building" }], signal);
    const footprint = footprintOf(locks?.find((lock) => lock.prefab === prefab));
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    // A refusal is about the ground as it was: when the owned land changes (a tile bought) the old refusals are forgotten and the sites are judged again.
    // A busy game or a blocking popup never reaches this list (no answer is not a refusal).
    if (this.#bigRefusedOwned !== null && this.#bigRefusedOwned !== tiles.length) { this.#bigRefused.length = 0; notes.push("train: the owned land changed; the sites refused before are judged again"); }
    this.#bigRefusedOwned = tiles.length;
    const outcome = await placeBigBuilding({
      footprint: async () => footprint,
      freeRectangles: async () => {
        const mask = await this.#readLandMask(world, [], "commercial", { sensitive: [], polluters: [] }, signal);
        return mask ? maximalRectangles(mask.mask, 120) : null;
      },
      preflight: (name, point, rotation) => trainLink.preflight(name, point, rotation, signal),
      place: (name, point, rotation) => trainLink.place(name, point, rotation, signal),
      acquireToward: async (target) => {
        if (!this.port.purchaseTile || !input.mayPurchaseLand || !input.finance) return false;
        const owned = world.ownedTiles.filter((tile) => tile.owned).length;
        if (!landPurchaseRunwayAffordable({ ...input.finance, ownedTiles: owned, tileUpkeep: this.#costs?.tileUpkeep ?? null, monthlyExpenses: this.#costs?.monthlyExpenses ?? null,
          observedMarginalUpkeep: this.#observedMarginalTileUpkeep, requiredCash: expansionCashRequired(input.finance.monthlyBalance) })) { notes.push("train: land toward the railway is needed for the yard, but the cash does not carry its upkeep (P8)"); return false; }
        const next = nextTileCandidates(world).sort((left, right) => length(left, target) - length(right, target))[0];
        if (!next || tiles.length === 0) return false;
        const result = await this.port.purchaseTile(next, signal);
        notes.push(`train: the tile at (${next.x.toFixed(0)},${next.z.toFixed(0)}) ${result.ok ? "bought toward the railway (a rail yard needs room)" : `not sold (${result.detail.slice(0, 60)})`}`);
        if (result.ok) this.#frontageDirty = true;
        return result.ok;
      },
    }, { prefab, target: anchor.node, refusedSites: this.#bigRefused }, notes, signal);
    if (this.#bigRefused.length > 200) this.#bigRefused.splice(0, this.#bigRefused.length - 200);
    if (outcome.status === "PLACED") this.#yardLookedAt = null;
  }

  #landForHighDensity(input: DistrictCycleInput): boolean {
    return input.unlocked?.densities.high === true || input.unlocked?.densities.medium === true || this.#stage === "S3";
  }

  /** The passenger station new high-density homes are laid around (攻略): known once a platform stands, and only after high density unlocks. */
  #highDensityStation(input: DistrictCycleInput): SpatialPoint2 | null {
    return this.#stationAt && input.unlocked?.densities.high === true ? this.#stationAt : null;
  }

  /**
   * Signature buildings for XP (`signature-rush.ts`): each one the milestones and the city's own growth unlock is placed once, as soon as it is
   * unlocked, on a lot the game accepts — facing a street first, free ground beside one after. The XP it gave is read back and noted. A signature with
   * no lot this cycle is looked at again after SIGNATURE_RETRY_HOURS; never while outward spending is cut.
   */
  async #placeSignatures(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput, notes: string[]): Promise<void> {
    const utilities = this.port.utilities;
    if (!input.pipelined || this.#cutSpending || !this.port.findPrefabs || !utilities) return;
    const signal = input.signal;
    // Speed: one catalogue read per SIGNATURE_LOOK_HOURS of game time (an unlock is rare and raises its own popup), and a signature once seen
    // standing is never listed again — the cycle pays nothing for this step between unlocks.
    const stamp = this.#stamp(this.#cycles);
    if (this.#signatureLookedAt && !stampElapsed(this.#signatureLookedAt, stamp, SIGNATURE_LOOK_HOURS, SIGNATURE_LOOK_CYCLES)) return;
    this.#signatureLookedAt = stamp;
    const offered = await this.port.findPrefabs("Signature", signal);
    const unlocked = offered.filter((entry) => !entry.locked && /Signature/.test(entry.name) && !this.#signaturesStanding.has(entry.name));
    if (unlocked.length === 0) return;
    const standing = new Set<string>();
    for (const entry of unlocked) {
      const tried = this.#signatureTriedAt.get(entry.name);
      if (tried && !stampElapsed(tried, stamp, SIGNATURE_RETRY_HOURS, SIGNATURE_RETRY_CYCLES)) { standing.add(entry.name); continue; }
      if ((await utilities.listFacilities(entry.name, signal)).length > 0) { standing.add(entry.name); this.#signaturesStanding.add(entry.name); }
    }
    const wanted = signaturesToPlace(unlocked, standing);
    if (wanted.length === 0) return;
    const network = mainStreetNetwork(world.roadGraph);
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    const nodes = network.nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
    const centre = nodes.length > 0 ? { x: nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length, z: nodes.reduce((sum, node) => sum + node.z, 0) / nodes.length } : { x: 0, z: 0 };
    const candidates = signatureCandidates({ edges: network.edges, nodes, isOwned: (point) => tiles.some((tile) => pointInTile(point, tile)), centre });
    for (const prefab of wanted) {
      if (signal?.aborted) break;
      this.#signatureTriedAt.set(prefab, stamp);
      const before = (await this.port.readProgress?.(signal)) ?? null;
      let preflights = 0;
      let placedAt: (typeof candidates)[number] | null = null;
      // How deep the building is decides where its front stands, and so whether a road can reach it (live 2026-10-06: two signature offices stood with
      // no road, no water and no power, the road to them refused for steep ground and for overlapping the building itself).
      const locks = await this.port.techTree?.prefabLocks([{ prefab, category: "building" }], signal).catch(() => null);
      const halfDepth = Math.max(8, (() => { const size = footprintOf(locks?.find((lock) => lock.prefab === prefab)); return size ? Math.max(size.widthMeters, size.depthMeters) / 2 : 24; })());
      let unreachable = 0;
      for (const candidate of candidates) {
        if (signal?.aborted || preflights >= SIGNATURE_MAXIMUM_PREFLIGHTS) break;
        if (this.#refusedPlacements.refused(prefab, candidate.position, stamp)) continue;
        preflights += 1;
        const legal = await utilities.preflight(prefab, candidate.position, candidate.rotation, signal);
        if (legal === null) continue;
        if (!legal) { this.#refusedPlacements.remember(prefab, candidate.position, stamp); continue; }
        // The way in is confirmed BEFORE the building is placed: a lot whose road the game would refuse is not used.
        if (!(await this.#roadReaches(candidate.position, halfDepth, network.edges, signal))) {
          unreachable += 1;
          this.#refusedPlacements.remember(prefab, candidate.position, stamp);
          // Every dry run shows a ghost road in the game: a city whose lots are all out of reach is not swept.
          if (unreachable >= SIGNATURE_ROAD_CHECKS_PER_PREFAB) break;
          continue;
        }
        const placed = await utilities.place(prefab, candidate.position, candidate.rotation, signal);
        if (placed.ok) { placedAt = candidate; break; }
        this.#refusedPlacements.remember(prefab, candidate.position, stamp);
      }
      if (!placedAt) { notes.push(`signature ${prefab}: unlocked, but no lot the game accepts with a road to it (${preflights} tried, ${unreachable} refused because no road could reach them); looked at again in ${SIGNATURE_RETRY_HOURS} game hours`); continue; }
      const standing = (await utilities.listFacilities(prefab, signal)).find((item) => Math.hypot(item.position.x - placedAt!.position.x, item.position.z - placedAt!.position.z) < 8);
      const stands = standing !== undefined;
      if (stands) this.#signaturesStanding.add(prefab);
      // Its XP is banked the moment it stands; a signature that then gets no road is this Mayor's own to take down like any facility it placed (a building with
      // no road, water or power is only a notice that never clears).
      if (standing) this.#ownFacilities.set(`${standing.entity.index}:${standing.entity.version}`, { ...standing.entity, position: standing.position, prefab });
      const after = (await this.port.readProgress?.(signal)) ?? null;
      const gained = before?.xp !== null && before?.xp !== undefined && after?.xp !== null && after?.xp !== undefined ? after.xp - before.xp : null;
      notes.push(`signature ${prefab}: placed at (${placedAt.position.x.toFixed(0)},${placedAt.position.z.toFixed(0)})${placedAt.facesStreet ? " facing a street" : " on free ground (no frontage)"}` +
        ` — ${stands ? "stands (read back)" : "NOT read back"}; XP ${gained !== null ? `${gained >= 0 ? "+" : ""}${gained}` : "unread"} (P1 XP action)`);
    }
  }

  /**
   * Whether a building at `position` can have a road: its front (half its depth toward the nearest street) is already at a street, or the game's own
   * dry run accepts a road from the street to that front. Not asked when the host cannot dry-run roads (then the lot is judged as before).
   */
  async #roadReaches(position: SpatialPoint2, halfDepth: number, edges: readonly SpatialRoadEdge[], signal?: AbortSignal): Promise<boolean> {
    if (!this.port.preflightRoad) return true;
    const contact = nearestStreetPoint(position, edges);
    if (!contact) return false;
    const gap = Math.max(0, contact.distance - halfDepth);
    if (gap <= SIGNATURE_ADJACENT_METERS) return true;
    // The road ends at the building's front edge, at the middle of the side that faces the street, set back by half the road width plus a margin.
    const length = contact.distance || 1;
    const unit = { x: (contact.point.x - position.x) / length, z: (contact.point.z - position.z) / length };
    const front = { x: position.x + unit.x * (halfDepth + SIGNATURE_FRONT_MARGIN_METERS), z: position.z + unit.z * (halfDepth + SIGNATURE_FRONT_MARGIN_METERS) };
    if (Math.hypot(contact.point.x - front.x, contact.point.z - front.z) < 8) return true;
    try { return (await this.port.preflightRoad({ start: contact.point, end: front }, FACILITY_ACCESS_ROAD_PREFAB, signal)) === "OK"; } catch { return false; }
  }

  #bridgeKey(crossing: { from: SpatialPoint2; to: SpatialPoint2 }): string {
    return `${Math.round(crossing.from.x)},${Math.round(crossing.from.z)}>${Math.round(crossing.to.x)},${Math.round(crossing.to.z)}`;
  }

  /**
   * Rolling land (P5, "按交付提前量购买"): land is bought AHEAD of need while the cash is plentiful, not when the last district has been laid. Land is where
   * the people come from, and the first nine tiles cost nothing, so the only thing that holds a tile back is the safety line: the cash left after the
   * district reserve must carry the deficit the new tile adds (`landPurchaseRunwayAffordable`) for LAND_ESCAPE_RUNWAY_MONTHS, outward spending must not be
   * cut (P8), and the tile bought last must already hold a district. One tile per cycle. The game's own refusal (it sells no tile before a milestone says so)
   * is asked again only after LAND_AHEAD_RETRY_HOURS of game time. Returns whether a tile was bought.
   */
  async #buyLandAhead(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput, freeHectares: number, notes: string[], signal?: AbortSignal): Promise<boolean> {
    this.#boughtAheadThisCycle = false;
    if (!input.pipelined || !input.finance || !input.mayPurchaseLand || !this.port.purchaseTile || input.intent || this.#cutSpending || this.#boughtTileUnused) return false;
    if (freeHectares >= LAND_AHEAD_FREE_HECTARES) return false;
    if (!this.#landForHighDensity(input)) return false;
    const stamp = this.#stamp(this.#cycles);
    if (this.#landAheadRefusedAt && !stampElapsed(this.#landAheadRefusedAt, stamp, LAND_AHEAD_RETRY_HOURS, LAND_AHEAD_RETRY_CYCLES)) return false;
    const owned = world.ownedTiles.filter((tile) => tile.owned).length;
    const costs = this.#costs;
    const affordable = input.finance.treasury >= LAND_PURCHASE_CASH_RESERVE && landPurchaseRunwayAffordable({ ...input.finance, ownedTiles: owned, tileUpkeep: costs?.tileUpkeep ?? null,
      monthlyExpenses: costs?.monthlyExpenses ?? null, observedMarginalUpkeep: this.#observedMarginalTileUpkeep, requiredCash: expansionCashRequired(input.finance.monthlyBalance) });
    if (!affordable) return false;
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    if (tiles.length === 0) return false;
    const tileSide = Math.min(...tiles.map((tile) => tile.bounds!.max.x - tile.bounds!.min.x));
    const served = mainStreetNetwork(world.roadGraph).nodes.map((node) => ({ x: node.position.x, z: node.position.z }));
    notes.push(`land ahead (P5): ${Math.round(freeHectares)} ha of owned land stand free (below ${LAND_AHEAD_FREE_HECTARES}) and the cash (${Math.round(input.finance.treasury)}) carries the new tile's upkeep for ${LAND_ESCAPE_RUNWAY_MONTHS} months: a tile is bought ahead of need`);
    // With high density laid around the station, land is bought toward it too.
    const station = this.#highDensityStation(input);
    const candidates = station ? nearestFirst(nextTileCandidates(world), station, (point) => point) : nextTileCandidates(world);
    const purchase = await this.#purchaseNextTile(candidates, tileSide, served, notes, signal);
    if (purchase === "REFUSED") this.#landAheadRefusedAt = stamp;
    else if (purchase === "BOUGHT") this.#landAheadRefusedAt = null;
    this.#boughtAheadThisCycle = purchase === "BOUGHT";
    return purchase === "BOUGHT";
  }

  /** Where the big service buildings stand (depots, and every facility this builder placed): the streets that end near them are their access. */
  async #bigServicePoints(signal?: AbortSignal): Promise<SpatialPoint2[]> {
    const points: SpatialPoint2[] = [];
    for (const facility of this.#ownFacilities.values()) if (facility.position) points.push(facility.position);
    const utilities = this.port.utilities;
    if (utilities) {
      for (const prefab of BIG_SERVICE_PROTECTED_PREFABS) {
        try { for (const facility of await utilities.listFacilities(prefab, signal)) points.push(facility.position); } catch { /* the protection is only wider without it */ }
      }
    }
    return points;
  }

  /**
   * Dead-end spurs: a short street (or chain of streets) that runs out of the network and ends in nothing, with no
   * building beside it. A player bulldozes these; left alone they are the "broken roads" the camera shows. Longer dead
   * ends are left (a street that stops at a lake is a street).
   */
  async removeDeadEndSpurs(world: Pick<SpatialWorldModel, "roadGraph">, buildings: readonly SpatialPoint2[], notes: string[], signal?: AbortSignal): Promise<number> {
    if (!this.port.demolishRoad) return 0;
    const network = mainStreetNetwork(world.roadGraph);
    const live = network.edges.filter((edge) => !edge.deleted && !edge.temp);
    const degree = new Map<string, number>();
    const byNode = new Map<string, SpatialRoadEdge[]>();
    for (const edge of live) {
      for (const ref of [edge.startNode, edge.endNode]) {
        degree.set(key(ref), (degree.get(key(ref)) ?? 0) + 1);
        byNode.set(key(ref), [...(byNode.get(key(ref)) ?? []), edge]);
      }
    }
    // Highway ramps and junction nodes count as connections even though the highway edge itself is not a street.
    for (const edge of network.main?.edges ?? []) {
      if (!NOT_A_CITY_STREET.test(edge.prefab)) continue;
      for (const ref of [edge.startNode, edge.endNode]) degree.set(key(ref), (degree.get(key(ref)) ?? 0) + 2);
    }
    // A street that ends at a big service building is that building's way in, not a spur: the building's centre lies far from the road's end (live 2026-10-06:
    // a depot 80 x 96 m, its access road laid and taken up again every ~170 s until the building was taken down for "no road" and another placed).
    const bigPoints = await this.#bigServicePoints(signal);
    const removedEdges = new Set<SpatialRoadEdge>();
    let removed = 0;
    for (const [nodeKey, nodeDegree] of degree) {
      if (nodeDegree !== 1 || signal?.aborted) continue;
      const chain: SpatialRoadEdge[] = [];
      let at = nodeKey;
      let meters = 0;
      let reachedJunction = false;
      while (meters <= SPUR_MAXIMUM_METERS) {
        const next = (byNode.get(at) ?? []).find((edge) => !chain.includes(edge));
        if (!next) break;
        chain.push(next);
        meters += length(next.start, next.end);
        at = key(next.startNode) === at ? key(next.endNode) : key(next.startNode);
        if ((degree.get(at) ?? 0) >= 3) { reachedJunction = true; break; }
        if ((degree.get(at) ?? 0) !== 2) break;
      }
      if (!reachedJunction || meters > SPUR_REMOVAL_MAXIMUM_METERS || chain.some((edge) => removedEdges.has(edge))) continue;
      if (!chain.every((edge) => this.#isOwn(edge))) continue;
      if (chain.some((edge) => buildings.some((point) => pointSegmentDistance(point, edge.start, edge.end) < ORPHAN_STUB_BUILDING_CLEARANCE_METERS))) continue;
      if (chain.some((edge) => bigPoints.some((point) => pointSegmentDistance(point, edge.start, edge.end) < BIG_SERVICE_ACCESS_PROTECT_METERS))) continue;
      for (const edge of chain) {
        if (await this.port.demolishRoad(edge.entity, signal)) { removed += 1; removedEdges.add(edge); }
      }
    }
    if (removed > 0) notes.push(`removed ${removed} dead-end spur street(s)`);
    return removed;
  }

  /**
   * Through streets between neighbouring districts: a straight street from a joint of one to a joint of the next, wherever
   * the network route between them is much longer than the straight line (see `district-corridors.ts`). A few per cycle.
   */
  async linkDistricts(world: Pick<SpatialWorldModel, "roadGraph">, buildings: readonly SpatialPoint2[], notes: string[], signal?: AbortSignal): Promise<number> {
    const network = mainStreetNetwork(world.roadGraph);
    let built = 0;
    for (const corridor of corridorCandidates({ nodes: network.nodes, edges: network.edges, buildings })) {
      if (signal?.aborted) break;
      const outcome = await this.#buildOwned({ start: corridor.from, end: corridor.to }, DISTRICT_ROAD_PREFAB, signal);
      notes.push(`through street ${corridor.straightMeters.toFixed(0)} m joint to joint (the network route was ${corridor.networkMeters.toFixed(0)} m): ${outcome.ok ? "built" : `refused ${outcome.detail.slice(0, 80)}`}`);
      if (outcome.ok) built += 1;
    }
    return built;
  }

  /** Closing attempts per gap (the pair of points), with the time of the last one: a refusal that was only the moment's is tried again later. */
  readonly #closureAttempts = new Map<string, { count: number; at: GameStamp }>();

  /**
   * Gaps in the grid: a street of ours that ends in nothing a block from the node it was meant to reach (see `deadEndClosures`). The street across the
   * gap is first put to the game's own dry run; a refusal is not the end of it: the world is read again and the gap is tried again after
   * `DEAD_END_CLOSURE_RETRY_HOURS` of game time, up to `DEAD_END_CLOSURE_MAX_ATTEMPTS` times, because what refused it is usually the district's own
   * neighbouring streets that had not settled yet.
   */
  async closeDeadEnds(world: Pick<SpatialWorldModel, "roadGraph">, buildings: readonly SpatialPoint2[], notes: string[], signal?: AbortSignal): Promise<number> {
    const network = mainStreetNetwork(world.roadGraph);
    await this.#readClock(signal);
    const now = this.#stamp(this.#serviceCycle);
    let closed = 0;
    // Our own grid gaps on their lattice line first; then every other dead end (the player's too: a street is only added, nothing of theirs is taken
    // down) joined to the nearest node the network reaches only the long way round, at any heading, within DEAD_END_CONNECT_MAXIMUM_METERS.
    const own = deadEndClosures({ nodes: network.nodes, edges: network.edges, buildings, isOwn: (edge) => this.#isOwn(edge) });
    const any = process.env.AI_MAYOR_KEEP_ROADS === "1" ? [] : deadEndClosures({ nodes: network.nodes, edges: network.edges, buildings, isOwn: () => true, anyHeading: true,
      maximumMeters: DEAD_END_CONNECT_MAXIMUM_METERS, limit: 2 }).filter((gap) => !own.some((mine) => Math.hypot(mine.from.x - gap.from.x, mine.from.z - gap.from.z) < 1));
    for (const gap of [...own, ...any]) {
      if (signal?.aborted) break;
      const gapKey = `${Math.round(gap.from.x)},${Math.round(gap.from.z)}>${Math.round(gap.to.x)},${Math.round(gap.to.z)}`;
      const tried = this.#closureAttempts.get(gapKey);
      if (tried && (tried.count >= DEAD_END_CLOSURE_MAX_ATTEMPTS || !stampElapsed(tried.at, now, DEAD_END_CLOSURE_RETRY_HOURS, DEAD_END_CLOSURE_RETRY_CYCLES))) continue;
      const course = { start: gap.from, end: gap.to };
      let verdict = "OK";
      if (this.port.preflightRoad) { try { verdict = await this.port.preflightRoad(course, DISTRICT_ROAD_PREFAB, signal); } catch { /* fail open: the build is its own answer */ } }
      const attempt = { count: (tried?.count ?? 0) + 1, at: now };
      this.#closureAttempts.set(gapKey, attempt);
      if (verdict.startsWith("REJECT")) {
        notes.push(`dead end (${gap.from.x.toFixed(0)},${gap.from.z.toFixed(0)}): the ${gap.straightMeters.toFixed(0)} m street to the node beside it was refused by the dry run (${verdict.replace(/^REJECT:/, "").slice(0, 70)}); attempt ${attempt.count} of ${DEAD_END_CLOSURE_MAX_ATTEMPTS}, tried again later`);
        continue;
      }
      const outcome = await this.#buildOwned(course, DISTRICT_ROAD_PREFAB, signal);
      notes.push(`dead end (${gap.from.x.toFixed(0)},${gap.from.z.toFixed(0)}) closed by a ${gap.straightMeters.toFixed(0)} m street (the way round was ${Number.isFinite(gap.networkMeters) ? `${gap.networkMeters.toFixed(0)} m` : "none"}): ${outcome.ok ? "built" : `refused ${outcome.detail.slice(0, 80)}; attempt ${attempt.count} of ${DEAD_END_CLOSURE_MAX_ATTEMPTS}`}`);
      if (outcome.ok) { closed += 1; this.#closureAttempts.delete(gapKey); }
    }
    return closed;
  }

  /** Failed ladder runs per notice cell (20 m), the cycle a road was last laid there, and the facilities this builder itself placed. */
  readonly #roadAccessFailures = new Map<string, number>();
  readonly #roadAccessBuiltAt = new Map<string, GameStamp>();
  /** When room for a big building was last made by taking buildings down (one look per cooldown). */
  #bigClearedAt: GameStamp | null = null;
  /** Unreachable facilities taken down in the current assist round. */
  #unreachableDemolished = 0;
  /** The burning and recycling plants were looked for in the development tree once this process (a node bought resets nothing: the unlocked list is read again). */
  #garbagePlantsAsked = false;
  #treatmentPlantAsked = false;
  /** "Powerline/Pipe Not Connected" notices: tries per spot and when a link was last laid there (the city needs a while to read it). */
  readonly #linkAttempts = new Map<string, number>();
  readonly #linkLaidAt = new Map<string, GameStamp>();
  /** When each "Not Connected" spot was first seen: a building just grown shows it until the street's power reaches it, which is not a fault. */
  readonly #linkSeenAt = new Map<string, GameStamp>();
  /** Frontage-road tries made for a notice that stays after the usual ladder is spent (per notice cell, this process). */
  readonly #frontageAttempts = new Map<string, number>();
  readonly #ownFacilities = new Map<string, { index: number; version: number; position?: SpatialPoint2; prefab?: string }>();
  /** Ruins taken down (or refused) once each (see `#clearRuins`). */
  /** A ruin the game refused to take down is asked again after RUIN_RETRY_HOURS, at most RUIN_MAXIMUM_ATTEMPTS times (live 2026-10-06: six burned factories stood for hours after one try each). */
  readonly #ruinsTried = new Map<string, { attempts: number; at: GameStamp }>();
  #ruinRefused(key: string): boolean {
    const tried = this.#ruinsTried.get(key);
    if (!tried) return false;
    return tried.attempts >= RUIN_MAXIMUM_ATTEMPTS || !stampElapsed(tried.at, this.#stamp(this.#serviceCycle), RUIN_RETRY_HOURS, RUIN_RETRY_CYCLES);
  }
  /** Where an own facility was taken down because no road the game accepts reached it (see `ACCESS_FAILED_EXCLUSION_METERS`). */
  readonly #accessFailedSites: Array<{ position: SpatialPoint2; radius: number }> = [];
  /** Since when the low-density quota has held the homes back with nothing denser open (null: not held). */
  #quotaBlockedSince: GameStamp | null = null;
  /** How long each problem icon has stood (`issue-ledger.ts`). */
  readonly #issues = new IssueLedger();
  /** When each service need's icons first stood (cleared when they go): see `SERVICE_STUCK_HOURS`. */
  readonly #iconsUpSince = new Map<ServiceNeed, GameStamp>();

  /**
   * "No Road Access": the game puts the notice where the building looks for a road — in front of its lot. The answer is the product's existing
   * facility-access-road repair (`facility-access-road.ts`), run on the world's own notice so it answers every building that lacks a road, whichever
   * code path placed it: the plain road first (the zero rung, the road a player draws by hand from the street to that spot), and only if the game's own
   * dry run refuses it the same road moved 12 m to each side — at most three attempts, each dry-run before anything is built. A building THIS builder
   * placed whose road the ladder could never get (its ceiling is `FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX` runs) is taken down: a facility
   * nobody can reach delivers nothing and costs upkeep. A building it did not place is never touched.
   * Bounded per cycle; the outcome of every road goes through the recorded port like any other street.
   */
  async #repairRoadAccess(reading: IconReading, world: Pick<SpatialWorldModel, "roadGraph">, signal: AbortSignal | undefined, notes: string[]): Promise<number> {
    // Live 2026-10-06: the one cemetery stood with 7 "No Pedestrian Access" and 2 "No Car Access" notices for 11 game hours while 22 hearse icons hung over
    // the city; those two notices say the same thing as "No Road Access" (a building no street reaches) and a street with its footpaths answers all three.
    const spots = reading.items.filter((item) => ACCESS_NOTICE.test(item.type));
    // A stranded costly kind whose notices are all gone (its road or link arrived) may be placed again.
    const unjoined = new Set(reading.items.filter((item) => ACCESS_NOTICE.test(item.type) || /Not Connected/i.test(item.type)).map((item) => highValueKind(item.prefab ?? "")));
    for (const kind of this.#highValue.strandedKinds()) if (!unjoined.has(kind)) this.#highValue.joined(kind);
    await this.#judgePedestrianStreets(spots, world, signal, notes);
    if (spots.length === 0) return 0;
    const edges = mainStreetNetwork(world.roadGraph).edges;
    let laid = 0;
    let tried = 0;
    this.#unreachableDemolished = 0;
    // What is looked at, in order, and by what kind: so a notice that is never reached is never a mystery (live 2026-10-07: 8 medium-row homes with no footpath
    // were never tried while the same few facilities used the attempts of every cycle).
    notes.push(`road access: ${spots.length} notice(s) — ${[...new Set(spots.map((spot) => `${spot.prefab ?? "?"}:${spot.type.replace(/^No /, "")}`))].slice(0, 6).join(", ")}`);
    // The notices tried least go first: a few stubborn ones (a plant behind water) must not use up every cycle's attempts while other buildings never get one.
    const effort = (spot: { x: number; z: number }) => { const key = `${Math.round(spot.x / 20)},${Math.round(spot.z / 20)}`; return (this.#roadAccessFailures.get(key) ?? 0) + (this.#frontageAttempts.get(key) ?? 0); };
    spots.sort((left, right) => effort(left) - effort(right));
    for (const spot of spots) {
      if (signal?.aborted || tried >= ROAD_ACCESS_REPAIRS_PER_CYCLE || this.#assist?.exhausted()) { if (tried >= ROAD_ACCESS_REPAIRS_PER_CYCLE) notes.push("road access: this cycle's attempts are used; the rest wait for the next"); break; }
      const cell = `${Math.round(spot.x / 20)},${Math.round(spot.z / 20)}`;
      // A footpath-only street is never laid for a building that also lacks a car road: its driveway then meets the footpath, and every parking place reads "No Car
      // Access" (live 2026-10-07: a signature mall with 2 car notices got a Pedestrian Street and had 54; taking it away brought it back to 2). The road comes first —
      // a Small Road carries footpaths too — and the pedestrian notices wait.
      if (/Pedestrian/i.test(spot.type) && needsCarRoad(spot, spots)) { this.#pedestrianWaited += 1; continue; }
      // A road laid here a moment ago has not had the city run over it yet: the notice is still up, and that is not a failure.
      // (`ROAD_ACCESS_SETTLE_CYCLES + 1`: the notice was left alone for that many cycles AFTER the one that built the road.)
      const builtAt = this.#roadAccessBuiltAt.get(cell);
      if (builtAt && !stampElapsed(builtAt, this.#stamp(this.#serviceCycle), ROAD_ACCESS_SETTLE_HOURS, ROAD_ACCESS_SETTLE_CYCLES + 1)) continue;
      if ((this.#roadAccessFailures.get(cell) ?? 0) >= FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX) {
        // The notice stands where the building looks for a road (in front of its lot), not at its entity or centre: the facility is found by
        // its entity when the icon carries one, else as the nearest one this builder placed within OWN_FACILITY_NOTICE_REACH_METERS.
        let own = spot.entity ? this.#ownFacilities.get(`${spot.entity.index}:${spot.entity.version}`) : undefined;
        if (!own) {
          let nearest = OWN_FACILITY_NOTICE_REACH_METERS;
          for (const candidate of this.#ownFacilities.values()) {
            // A notice that names another building than the one this builder placed is not about it.
            if (spot.prefab && candidate.prefab && spot.prefab !== candidate.prefab) continue;
            const distance = candidate.position ? Math.hypot(candidate.position.x - spot.x, candidate.position.z - spot.z) : Infinity;
            if (distance <= nearest) { nearest = distance; own = candidate; }
          }
        }
        const costly = isHighValueFacility(own?.prefab ?? spot.prefab);
        if (costly) this.#highValue.stranded(own?.prefab ?? spot.prefab ?? "", this.#stamp(this.#cycles));
        if (costly && (this.#frontageAttempts.get(cell) ?? 0) >= FRONTAGE_ATTEMPTS_PER_SPOT) {
          // A costly facility without a road is left standing (taking it down refunds nothing, and the next one placed elsewhere cost as much again: the
          // player's rule of 2026-10-07): its frontage road was tried too, the notice is now reported, not answered, and no other of its kind is placed
          // while it stands so (`high-value-guard.ts`).
          if (!this.#costlyReported.has(cell)) { this.#costlyReported.add(cell); notes.push(`road access: ${own?.prefab ?? spot.prefab ?? "a costly facility"} at (${Math.round(spot.x)},${Math.round(spot.z)}) got no road; a costly facility is never taken down, it is left for the player`); }
        } else if (own && !costly && mayDemolishFacility(own.prefab ?? spot.prefab) && this.port.utilities?.remove && await this.port.utilities.remove(own, signal)) {
          this.#ownFacilities.delete(`${own.index}:${own.version}`);
          // Taken down for want of a road: that site is not offered again, nor the ground around it. The next try takes the shore elsewhere, another pump, a tower.
          if (own.position) { this.#accessFailedSites.push({ position: own.position, radius: ACCESS_FAILED_EXCLUSION_METERS }); if (this.#accessFailedSites.length > 60) this.#accessFailedSites.shift(); }
          this.#roadAccessFailures.delete(cell);
          notes.push(`road access: ${spot.prefab ?? "a facility"} at (${Math.round(spot.x)},${Math.round(spot.z)}) got no road after ${FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX} tries; it was placed by this Mayor and is taken down`);
        } else if ((this.#frontageAttempts.get(cell) ?? 0) >= FRONTAGE_ATTEMPTS_PER_SPOT && !/Pedestrian/i.test(spot.type) && spot.entity && process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS === "0" &&
          UNREACHABLE_FACILITY.test(spot.prefab ?? "") && !isHighValueFacility(spot.prefab) && !/RailYard/i.test(spot.prefab ?? "") && !protection.circle({ x: spot.x, z: spot.z }, 10) && this.port.utilities?.remove && this.#unreachableDemolished < UNREACHABLE_DEMOLITIONS_PER_CYCLE) {
          // A service building no street can ever reach (every road and every frontage course refused: far from any street, a slope, a railway between) serves nobody and
          // costs upkeep and an icon for ever. Taken down, like any facility of the player's city, when the takeover allows demolition (live 2026-10-07: a coal plant
          // 600 m from any street, a landfill and two signature offices that no course could reach).
          this.#unreachableDemolished += 1;
          const gone = await this.port.utilities.remove(spot.entity, signal);
          notes.push(`road access: ${spot.prefab ?? "a facility"} at (${Math.round(spot.x)},${Math.round(spot.z)}) cannot be reached by any road the game accepts; ${gone ? "taken down" : "the game would not take it down"}`);
          this.options.experience?.record("unreachable-facility", (spot.prefab ?? "?").replace(/\d+$/, ""), "taken-down", gone ? "OK" : "REFUSED");
          if (gone) this.#frontageDirty = true;
        } else if ((this.#frontageAttempts.get(cell) ?? 0) < FRONTAGE_ATTEMPTS_PER_SPOT && !/Pedestrian/i.test(spot.type)) {
          // A building that stays (not this Mayor's own to take down: a signature building, a native one) keeps being a notice for ever. The usual ladder is spent,
          // so the frontage road is tried for it, a few times at most.
          this.#frontageAttempts.set(cell, (this.#frontageAttempts.get(cell) ?? 0) + 1);
          // One try is a try for the whole building (a big one hangs a notice at every entrance, and each would otherwise spend its own three tries on the same run).
          for (const sibling of siblingNotices(spot, spots)) {
            const siblingCell = `${Math.round(sibling.x / 20)},${Math.round(sibling.z / 20)}`;
            if (siblingCell !== cell) this.#frontageAttempts.set(siblingCell, Math.max(this.#frontageAttempts.get(siblingCell) ?? 0, this.#frontageAttempts.get(cell) ?? 0));
          }
          tried += 1;
          const contact = nearestStreetPoint({ x: spot.x, z: spot.z }, edges);
          if (contact && await this.#frontageAccess(spot, { x: spot.x, z: spot.z }, contact.point, FACILITY_ACCESS_ROAD_PREFAB, notes, signal, siblingNotices(spot, spots), nearestStreetEnd({ x: spot.x, z: spot.z }, edges))) {
            laid += 1;
            this.#roadAccessFailures.delete(cell);
            this.#roadAccessBuiltAt.set(cell, this.#stamp(this.#serviceCycle));
            this.#frontageDirty = true;
          }
        }
        continue;
      }
      tried += 1;
      const point = { x: spot.x, z: spot.z };
      // "No Pedestrian Access" is answered with a footpath (live 2026-10-06: a player's plant kept its icon after the road until a Pedestrian Street was laid
      // to it, and the plant's low-voltage connectors attached to that street); a missing road or car access keeps the road.
      const accessPrefab = /Pedestrian/i.test(spot.type) ? PEDESTRIAN_ACCESS_PREFAB : FACILITY_ACCESS_ROAD_PREFAB;
      const contact = nearestStreetPoint(point, edges);
      if (!contact) { notes.push(`road access: no street to reach from (${Math.round(point.x)},${Math.round(point.z)})`); continue; }
      const ladderRequest = {
        objective: { start: contact.point, end: point },
        // The pipe or cable of a facility is underground and shares no surface with the road, so there is no course to keep clear of.
        admittedCourse: { prefab: "", start: point, end: point },
        facility: { position: point, halfExtent: ROAD_ACCESS_FACILITY_HALF_EXTENT_METERS },
        facilityServicePoint: point,
        envelope: { center: point, radius: contact.distance + 60 },
        prefab: accessPrefab,
        maximumCandidates: 64,
      };
      // The ladder first (a road ending on the notice point); the short roads that stop before it only after it, so what worked before still comes first.
      const experience = this.options.experience;
      const condition = distanceBand(contact.distance);
      const builtIn = [...facilityAccessRoadCourseCandidates(ladderRequest).filter((candidate) => /:reach:1$/.test(candidate.reason)).slice(0, ROAD_ACCESS_ATTEMPTS_PER_RUN),
        ...shortAccessRoadCourseCandidates(ladderRequest)];
      // The recorder: the kinds of course that passed here before go first, those the game kept refusing go last (`experience-book.ts`).
      const candidates = experience ? experience.rank("access-road", condition, builtIn, (candidate) => optionFamily(candidate.reason)) : builtIn;
      const verdicts: string[] = [];
      const record = (acceptedReason: string | null, outcome: AccessAttemptRecord["outcome"]) => {
        try { this.port.recordAccessAttempt?.({ kind: "FACILITY_ACCESS_ROAD", frame: this.#frame, noticeAt: point, distanceToStreetMeters: Math.round(contact.distance),
          candidatesTried: candidates.length, acceptedReason, verdicts, outcome }); } catch { /* learning never stops the city */ }
      };
      const selection = await selectFacilityAccessRoadCourse({
        candidates, facilityServicePoint: point, worldEdges: world.roadGraph.edges,
        preflight: async (candidate) => {
          const action = candidate.actions[0];
          if (!action || action.type !== "build_road" || !this.port.preflightRoad) return { accepted: true, quote: 0 };
          let verdict = "OK";
          try { verdict = await this.port.preflightRoad({ start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 } }, accessPrefab, signal); } catch { /* fail open, as the district streets do */ }
          verdicts.push(verdict.slice(0, 120));
          // A refusal by the game is evidence about this kind of course; no answer (busy, error) says nothing and is not recorded.
          if (verdict !== "OK" && /^REJECT/.test(verdict)) experience?.record("access-road", condition, optionFamily(candidate.reason), "REFUSED");
          return verdict === "OK" ? { accepted: true, quote: 0 } : { accepted: false, quote: null, reason: verdict };
        },
      });
      if (selection.status === "SELECTED") {
        const action = selection.candidate.actions[0] as { x1: number; z1: number; x2: number; z2: number };
        const outcome = await this.#buildOwned({ start: { x: action.x1, z: action.z1 }, end: { x: action.x2, z: action.z2 } }, accessPrefab, signal);
        record(selection.candidate.reason, outcome.ok ? "BUILT" : "BUILD_REFUSED");
        experience?.record("access-road", condition, optionFamily(selection.candidate.reason), outcome.ok ? "OK" : "REFUSED");
        if (outcome.ok) {
          laid += 1;
          this.#roadAccessBuiltAt.set(cell, this.#stamp(this.#serviceCycle));
          this.#frontageDirty = true;
          if (accessPrefab === PEDESTRIAN_ACCESS_PREFAB) this.#pedestrianTrials.push({ prefab: spot.prefab ?? "", at: point, stamp: this.#stamp(this.#serviceCycle) });
          notes.push(`road access: ${accessPrefab} ${Math.round(Math.hypot(action.x2 - action.x1, action.z2 - action.z1))} m laid to (${Math.round(point.x)},${Math.round(point.z)}) (${selection.candidate.reason})`);
          continue;
        }
        notes.push(`road access: the game refused the road to (${Math.round(point.x)},${Math.round(point.z)}): ${outcome.detail.slice(0, 80)}`);
      } else {
        record(null, "NO_ACCEPTED_ROAD");
        // The ladder found nothing the game accepts: the way a player does it, a road along the front of the building (ending at the middle of its front
        // edge, parallel to it), approached around steep ground if need be. Every piece is dry-run first.
        if (await this.#frontageAccess(spot, point, contact.point, accessPrefab, notes, signal, siblingNotices(spot, spots), nearestStreetEnd({ x: spot.x, z: spot.z }, edges))) {
          laid += 1;
          this.#roadAccessBuiltAt.set(cell, this.#stamp(this.#serviceCycle));
          this.#frontageDirty = true;
          continue;
        }
        notes.push(`road access: no road the game accepts to (${Math.round(point.x)},${Math.round(point.z)}) yet (${selection.reasons[0]?.slice(0, 90) ?? "no candidate"})`);
      }
      this.#roadAccessFailures.set(cell, (this.#roadAccessFailures.get(cell) ?? 0) + 1);
    }
    return laid;
  }
  /** Pedestrian streets laid for a building, each judged once its notices have had time to change (`#judgePedestrianStreets`). */
  readonly #pedestrianTrials: Array<{ prefab: string; at: SpatialPoint2; stamp: GameStamp }> = [];
  #pedestrianWaited = 0;
  /**
   * A footpath-only street can take a building's driveway away from the car road (the game attaches the building to the nearest street): every parking place then
   * reads "No Car Access". After `PEDESTRIAN_TRIAL_HOURS` the building's car notices are counted; four or more of them and the Mayor's own pedestrian streets
   * near it are taken away again. The footpath icons stay for a player to answer.
   */
  async #judgePedestrianStreets(spots: ReadonlyArray<{ type: string; x: number; z: number; prefab?: string }>, world: Pick<SpatialWorldModel, "roadGraph">, signal: AbortSignal | undefined, notes: string[]): Promise<void> {
    if (this.#pedestrianTrials.length === 0 || !this.port.demolishRoad) return;
    const now = this.#stamp(this.#serviceCycle);
    for (let index = this.#pedestrianTrials.length - 1; index >= 0; index -= 1) {
      const trial = this.#pedestrianTrials[index]!;
      if (!stampElapsed(trial.stamp, now, PEDESTRIAN_TRIAL_HOURS, PEDESTRIAN_TRIAL_CYCLES)) continue;
      this.#pedestrianTrials.splice(index, 1);
      const carNotices = spots.filter((spot) => /Car|Road/i.test(spot.type) && spot.prefab === trial.prefab && Math.hypot(spot.x - trial.at.x, spot.z - trial.at.z) <= PEDESTRIAN_TRIAL_REACH_METERS).length;
      if (carNotices < PEDESTRIAN_TRIAL_CAR_NOTICES) continue;
      let removed = 0;
      for (const edge of world.roadGraph.edges) {
        if (signal?.aborted) break;
        if (edge.native || edge.prefab !== PEDESTRIAN_ACCESS_PREFAB || edge.length > 60) continue;
        if (Math.min(Math.hypot(edge.start.x - trial.at.x, edge.start.z - trial.at.z), Math.hypot(edge.end.x - trial.at.x, edge.end.z - trial.at.z)) > PEDESTRIAN_TRIAL_REACH_METERS) continue;
        if (await this.port.demolishRoad(edge.entity, signal)) removed += 1;
      }
      notes.push(`road access: after the footpath street, ${carNotices} "No Car Access" notice(s) hang on ${trial.prefab || "the building"} (the driveway met the footpath); ${removed} pedestrian street(s) taken away again`);
      if (removed > 0) this.#frontageDirty = true;
    }
  }

  /**
   * "Powerline Not Connected" / "... Pipe Not Connected": the building stands but no cable or pipe reaches it. The answer is the one a player draws: a buried
   * cable or pipe from the building's connector (or its centre) to the nearest street of the main network, which carries the utility. Several courses are
   * offered (three nearest streets, the contact point and 10 m to each side of it, so the last stretch never runs along an existing road's ray), each
   * laid through the same connect primitive facilities use; the game refuses what cannot stand. Bounded per cycle and per spot.
   */
  async #reconnectUtilities(reading: IconReading, world: Pick<SpatialWorldModel, "roadGraph">, signal: AbortSignal | undefined, notes: string[]): Promise<number> {
    const utilities = this.port.utilities;
    if (!utilities?.connect) return 0;
    const kindOf = (type: string): DistrictUtilityKind | null => /^Powerline Not Connected/i.test(type) ? "electricity"
      : /Sewage.*Not Connected/i.test(type) ? "sewage" : /(Water|Pipe).*Not Connected/i.test(type) ? "water" : null;
    const spots = reading.items.filter((item) => kindOf(item.type) !== null);
    // A spot whose notice is gone is forgotten (it is first-seen again if it comes back).
    const standing = new Set(spots.map((spot) => `${kindOf(spot.type)}:${Math.round(spot.x / 20)},${Math.round(spot.z / 20)}`));
    for (const key of [...this.#linkSeenAt.keys()]) if (!standing.has(key)) this.#linkSeenAt.delete(key);
    if (spots.length === 0) return 0;
    const edges = mainStreetNetwork(world.roadGraph).edges;
    if (edges.length === 0) return 0;
    let laid = 0;
    let tried = 0;
    for (const spot of spots) {
      if (signal?.aborted || tried >= UTILITY_LINK_REPAIRS_PER_CYCLE || this.#assist?.exhausted()) break;
      const kind = kindOf(spot.type)!;
      const cell = `${kind}:${Math.round(spot.x / 20)},${Math.round(spot.z / 20)}`;
      const seenAt = this.#linkSeenAt.get(cell);
      if (!seenAt) { this.#linkSeenAt.set(cell, this.#stamp(this.#serviceCycle)); continue; }
      if (!stampElapsed(seenAt, this.#stamp(this.#serviceCycle), UTILITY_LINK_SETTLE_HOURS, UTILITY_LINK_SETTLE_CYCLES)) continue;
      const laidAt = this.#linkLaidAt.get(cell);
      if (laidAt && !stampElapsed(laidAt, this.#stamp(this.#serviceCycle), ROAD_ACCESS_SETTLE_HOURS, ROAD_ACCESS_SETTLE_CYCLES + 1)) continue;
      if ((this.#linkAttempts.get(cell) ?? 0) >= UTILITY_LINK_ATTEMPTS_PER_SPOT) continue;
      this.#linkAttempts.set(cell, (this.#linkAttempts.get(cell) ?? 0) + 1);
      tried += 1;
      let from: SpatialPoint2 = { x: spot.x, z: spot.z };
      if (spot.entity && utilities.connectorFront) {
        try { const front = await utilities.connectorFront(spot.entity, signal, kind); if (front) from = front.position; } catch { /* the notice point then */ }
      }
      // The three nearest streets, each at its closest point and 10 m to either side along it.
      const contacts = edges.map((edge) => ({ edge, contact: nearestStreetPoint(from, [edge]) }))
        .filter((entry): entry is { edge: typeof entry.edge; contact: NonNullable<typeof entry.contact> } => entry.contact !== null)
        .sort((left, right) => left.contact.distance - right.contact.distance).slice(0, 3);
      const offered: Array<{ point: SpatialPoint2; option: string }> = [];
      contacts.forEach(({ edge, contact }, rank) => {
        if (contact.distance > UTILITY_LINK_MAXIMUM_METERS) return;
        const dx = edge.end.x - edge.start.x; const dz = edge.end.z - edge.start.z;
        const length = Math.hypot(dx, dz) || 1;
        offered.push({ point: contact.point, option: `street${rank}:square` });
        for (const side of [10, -10]) offered.push({ point: { x: contact.point.x + (dx / length) * side, z: contact.point.z + (dz / length) * side }, option: `street${rank}:skew` });
      });
      const linkCondition = `${kind}:${distanceBand(contacts[0]?.contact.distance)}`;
      const ranked = this.options.experience ? this.options.experience.rank("utility-link", linkCondition, offered, (entry) => entry.option) : offered;
      const targets = ranked.map((entry) => entry.point);
      const prefab = DISTRICT_UTILITY_CONNECTION_PREFAB[kind];
      const refusals: string[] = [];
      let done = false;
      for (const target of targets.slice(0, UTILITY_LINK_COURSES_PER_SPOT)) {
        if (signal?.aborted || this.#assist?.exhausted()) break;
        const meters = Math.hypot(target.x - from.x, target.z - from.z);
        if (meters < 2) continue;
        this.#assist?.noteWrite();
        const outcome = await utilities.connect(prefab, from, target, signal).catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
        const option = ranked.find((entry) => entry.point === target)?.option ?? "street?";
        // A refusal by the game is evidence; an error or a busy Bridge says nothing about the course.
        if (outcome.ok || /refus|reject|invalid|overlap/i.test(outcome.detail)) this.options.experience?.record("utility-link", linkCondition, option, outcome.ok ? "OK" : "REFUSED");
        if (outcome.ok) {
          done = true;
          laid += 1;
          this.#linkLaidAt.set(cell, this.#stamp(this.#serviceCycle));
          notes.push(`utility link: ${prefab} ${Math.round(meters)} m laid from (${Math.round(from.x)},${Math.round(from.z)}) to the street for "${spot.type}"${spot.prefab ? ` on ${spot.prefab}` : ""}`);
          break;
        }
        refusals.push(outcome.detail.slice(0, 50));
      }
      if (!done) notes.push(`utility link: no ${prefab} the game accepts from (${Math.round(from.x)},${Math.round(from.z)}) for "${spot.type}" (${targets.length === 0 ? "no street within reach" : `${Math.min(targets.length, UTILITY_LINK_COURSES_PER_SPOT)} course(s) refused: ${[...new Set(refusals)].slice(0, 2).join("; ")}`})`);
    }
    return laid;
  }

  /** The utilities port with the access-road dry run of this builder's own road preflight (`accessRoadVerdict`), when both exist. */
  #utilitiesWithAccessCheck(): DistrictUtilitiesPort | undefined {
    const utilities = this.port.utilities;
    const preflight = this.port.preflightRoad?.bind(this.port);
    if (!utilities || !preflight || utilities.accessRoadVerdict) return utilities;
    return Object.assign(Object.create(utilities) as DistrictUtilitiesPort, {
      accessRoadVerdict: (street: SpatialPoint2, front: SpatialPoint2, signal?: AbortSignal) => preflight({ start: street, end: front }, FACILITY_ACCESS_ROAD_PREFAB, signal),
    });
  }

  /** The centre of the building a notice is about: the facility of that prefab nearest the notice, else the nearest listed building of it. */
  async #buildingCentreFor(spot: { x: number; z: number; prefab?: string }, signal?: AbortSignal): Promise<SpatialPoint2 | null> {
    const near = (points: ReadonlyArray<SpatialPoint2>): SpatialPoint2 | null => {
      let best: SpatialPoint2 | null = null; let bestDistance = FRONTAGE_BUILDING_REACH_METERS;
      for (const point of points) { const distance = Math.hypot(point.x - spot.x, point.z - spot.z); if (distance < bestDistance) { bestDistance = distance; best = point; } }
      return best;
    };
    if (spot.prefab && this.port.utilities) {
      try { const found = near((await this.port.utilities.listFacilities(spot.prefab, signal)).map((facility) => facility.position)); if (found) return found; } catch { /* try the building list */ }
    }
    try { return near((await this.port.listBuildings(signal)).filter((building) => !spot.prefab || building.prefab === spot.prefab).map((building) => building.position)); } catch { return null; }
  }

  /**
   * A road along the front of a building the game says has no road (`frontage-road.ts`): ends at the middle of the front edge, parallel to it, reached
   * from the street by a straight, contour or switchback approach chosen on the terrain read. Each piece is dry-run; all pieces of a course must be
   * accepted before any is laid. Returns whether a course was laid.
   */
  async #frontageAccess(spot: { x: number; z: number; prefab?: string }, notice: SpatialPoint2, street: SpatialPoint2, prefab: string, notes: string[], signal?: AbortSignal,
    siblings: readonly SpatialPoint2[] = [], streetEnd: SpatialPoint2 | null = null): Promise<boolean> {
    if (!this.port.preflightRoad) return false;
    const centre = await this.#buildingCentreFor(spot, signal);
    if (!centre) return false;
    const detail = await this.port.siteDetail(notice, FRONTAGE_TERRAIN_RADIUS_METERS, 64, signal).catch(() => null);
    const experience = this.options.experience;
    const condition = distanceBand(Math.hypot(street.x - notice.x, street.z - notice.z));
    const designed = frontageCourses({ centre, notice, street, siblings, ...(detail?.terrain ? { terrain: detail.terrain } : {}), maximumGradePercent: DISTRICT_ROAD_GRADE_PERCENT });
    // Roads laid onto a street must end on a NODE (a free end on the middle of an edge does not join): the courses that reach the street's own end come first.
    const viaEnd = streetEnd ? frontageCourses({ centre, notice, street: streetEnd, siblings, ...(detail?.terrain ? { terrain: detail.terrain } : {}), maximumGradePercent: DISTRICT_ROAD_GRADE_PERCENT })
      .filter((course) => /^frontage:(anchored|stub)/.test(course.reason)) : [];
    const merged = [...viaEnd, ...designed.filter((course) => !viaEnd.some((other) => other.reason === course.reason))];
    const courses = experience ? experience.rank("frontage-road", condition, merged, (course) => optionFamily(course.reason)) : merged;
    let tried = 0;
    const refusals = new Map<string, number>();
    for (const course of courses) {
      if (signal?.aborted || tried >= FRONTAGE_COURSES_PER_TRY || this.#assist?.exhausted()) break;
      tried += 1;
      let accepted = true;
      for (const segment of course.segments) {
        let verdict = "ERROR";
        try { verdict = await this.port.preflightRoad({ start: segment.start, end: segment.end }, prefab, signal); } catch { /* undecided */ }
        // The dry run failing to identify its own new road (it meets an existing road end) is not the game refusing it: for a short course the real build
        // is the judge (it refuses by itself, and nothing is lost when it does).
        const undecided = verdict === "REJECT:NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" && course.segments.length <= 2;
        if (verdict !== "OK" && !undecided) {
          accepted = false; refusals.set(verdict.slice(0, 60), (refusals.get(verdict.slice(0, 60)) ?? 0) + 1);
          if (/^REJECT/.test(verdict)) experience?.record("frontage-road", condition, optionFamily(course.reason), "REFUSED");
          break;
        }
      }
      if (!accepted) continue;
      let laidAll = true;
      let refusedBecause = "";
      for (const segment of course.segments) {
        const outcome = await this.#buildOwned({ start: segment.start, end: segment.end }, prefab, signal);
        if (!outcome.ok) { laidAll = false; refusedBecause = outcome.detail.replace(/\s+/g, " ").slice(0, 110); break; }
      }
      experience?.record("frontage-road", condition, optionFamily(course.reason), laidAll ? "OK" : "REFUSED");
      notes.push(`road access: frontage road to (${Math.round(notice.x)},${Math.round(notice.z)}) — ${course.reason}, ${course.segments.length} piece(s)` +
        `${course.maxGradePercent !== null ? `, steepest ${course.maxGradePercent.toFixed(0)}%` : ", slope unread"} — ${laidAll ? "laid" : `a piece was refused when laid (${refusedBecause})`}`);
      if (laidAll) return true;
    }
    if (tried > 0) notes.push(`road access: no frontage road the game accepts to (${Math.round(notice.x)},${Math.round(notice.z)}) (${tried} course(s) dry-run; the game said: ${[...refusals].map(([why, count]) => `${why} x${count}`).join(", ")})`);
    return false;
  }

  /**
   * Public services where the icons are (see `district-services.ts`): a cemetery where hearse icons hang, a clinic where ambulance icons
   * hang. One building per wanted kind per pass, spaced by a cooldown so the icons can fall, never more than the city's size justifies.
   * The lot is a reserved patch of a district if one is near, else any legal lot beside a street; the game's object preflight decides,
   * and the building is read back. Returns how many buildings were placed.
   */
  async provideServices(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput, notes: string[]): Promise<number> {
    const signal = input.signal;
    const utilities = this.port.utilities;
    if (!utilities || !this.port.readIcons || !this.port.findPrefabs) return 0;
    const rawReading = await this.port.readIcons(signal);
    if (!rawReading) return 0;
    // Icons beyond the owned land are left out unless the player named the problem and land may be bought (a far fire is then chased, cash permitting).
    const ownedTiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    const chaseFar = input.mayPurchaseLand === true && (input.care?.focus ?? []).length > 0;
    const split = ownedTiles.length > 0 && !chaseFar ? splitOutsideOwnedLand(rawReading, (point) => ownedTiles.some((tile) => pointInTile(point, tile))) : null;
    const reading = split ? split.inside : rawReading;
    if (split && Object.keys(split.outside).length > 0) {
      notes.push(`icons outside the owned land are not built for (reaching them means buying tiles; say the problem by name and allow land to chase it): ${Object.entries(split.outside).map(([type, count]) => `${type} ${count}`).join(", ")}`);
    }
    this.#serviceCycle += 1;
    // P7: the notifications in three tiers. The immediate ones are answered this cycle (below, and by the utility repairs of the Brain);
    // the deferred ones are looked at in a batch on a period; the rest are not answered by an icon — and an immediate type this Mayor has
    // no local answer to is reported as a gap, not built for blindly.
    const triage = triageNotifications(reading);
    const brief = (tier: keyof typeof triage.byTier, take = 4) => triage.byTier[tier].slice(0, take).map((entry) => `${entry.type} ${entry.count}`).join(", ") || "none";
    // The deferred tier is reviewed on a game-time period (the first cycle, then every DEFERRED_REVIEW_EVERY_HOURS; cycles when no clock).
    const cycleStamp = this.#stamp(this.#serviceCycle);
    const reviewDeferred = !this.#deferredReviewAt || stampElapsed(this.#deferredReviewAt, cycleStamp, DEFERRED_REVIEW_EVERY_HOURS, DEFERRED_REVIEW_EVERY_CYCLES);
    if (reviewDeferred) this.#deferredReviewAt = cycleStamp;
    notes.push(`notifications (P7): immediate ${triage.totals.IMMEDIATE} [${brief("IMMEDIATE")}]; deferred ${triage.totals.DEFERRED}${reviewDeferred ? ` [${brief("DEFERRED")}] reviewed now` : " (batched)"}; ` +
      `no reaction ${triage.totals.NO_REACTION}; congestion icons ${triage.totals.READ_FIRST} (answered by the traffic pass from the road readings); unclassified ${triage.totals.UNCLASSIFIED}`);
    const unanswered = immediateWithoutAnswer(triage);
    if (unanswered.length > 0 && !this.#notifiedGaps) {
      this.#notifiedGaps = true;
      notes.push(`capability gaps (immediate, no local answer yet): ${unanswered.map((entry) => `${entry.type} ${entry.count}`).join(", ")}`);
    }
    // The issue desk: how long every icon has stood. One line in the notes when any has stood past ISSUE_STUCK_HOURS, so the escalation below and the
    // player read the same number (live 2026-10-06: 22 hearse icons for 11 game hours were only visible in a hand-made tracker).
    this.#issues.observe(reading.items, cycleStamp);
    const stuckLine = describeStanding(this.#issues.stuck(cycleStamp, ISSUE_STUCK_HOURS, ISSUE_STUCK_CYCLES));
    if (stuckLine) notes.push(stuckLine);
    // One budget for the whole assist round (`assist-budget.ts`): once spent it starts nothing new (no race, no abandoned task that writes later).
    const budget = new AssistBudget();
    this.#assist = budget;
    let placedTotal = 0;
    // What the player asked to be seen to (`care-focus.ts`): a named problem goes first and past the usual waits.
    const focus = new Set(input.care?.focus ?? []);
    const spend = () => { if (budget.exhausted()) return false; budget.noteWrite(); return true; };
    const roadCare = this.#roadCare;
    const trafficStage = () => budget.stage("traffic", async () => {
      if (!roadCare) { if (focus.has("TRAFFIC")) notes.push("traffic: no road-care port in this build (the game connector lacks the traffic tools)"); return; }
      const hotspots = reading.items.filter((item) => /Traffic Bottleneck|Traffic Jam|Congestion/i.test(item.type)).map((item) => ({ x: item.x, z: item.z }));
      await roadCare.traffic(cycleStamp, notes, { force: focus.has("TRAFFIC") && input.care?.fresh !== false, spend, mayWiden: process.env.AI_MAYOR_KEEP_ROADS !== "1", hotspots, ...(signal ? { signal } : {}) });
    });
    try {
    if (focus.has("TRAFFIC")) await trafficStage();
    await budget.stage("access", () => this.#repairRoadAccess(reading, world, signal, notes));
    await budget.stage("links", () => this.#reconnectUtilities(reading, world, signal, notes));
    await budget.stage("ruins", () => this.#clearRuins(reading, notes, signal));
    await budget.stage("services", async () => {
    // How long each need's icons have been up: the evidence that outranks the population figure (`SERVICE_STUCK_HOURS`).
    // A need the player named counts from its first icon, and before the others.
    // Road maintenance's evidence is the worn stretches of jammed corridors, not an icon (`road-care.ts`).
    const careReading = withWornRoads(reading, roadCare?.wornPlaces ?? []);
    const wantedNow = servicesWanted(careReading);
    for (const need of SERVICE_NEEDS) {
      if (!focus.has(SERVICE_FOCUS[need]) || wantedNow.some((entry) => entry.need === need)) continue;
      const icons = iconCount(careReading, need);
      if (icons > 0) wantedNow.push({ need, icons });
    }
    wantedNow.sort((left, right) => Number(focus.has(SERVICE_FOCUS[right.need])) - Number(focus.has(SERVICE_FOCUS[left.need])) || right.icons - left.icons);
    for (const need of SERVICE_NEEDS) if (!wantedNow.some((entry) => entry.need === need)) this.#iconsUpSince.delete(need);
    for (const { need } of wantedNow) if (!this.#iconsUpSince.has(need)) this.#iconsUpSince.set(need, cycleStamp);
    for (const { need, icons } of wantedNow) {
      if (signal?.aborted) break;
      if (budget.exhausted()) { notes.push(`service ${need}: ${evidence(need, icons)}; the assist budget is spent, this waits for the next cycle`); break; }
      const restedAt = this.#serviceRest.get(need);
      const named = focus.has(SERVICE_FOCUS[need]);
      if (!named && restedAt && !stampElapsed(restedAt, cycleStamp, SERVICE_COOLDOWN_HOURS, SERVICE_COOLDOWN_CYCLES)) continue;
      // Public buildings are recurring upkeep: the same affordability the civic path used.
      // An essential service whose icons pile up (garbage, sick, dead) drives the city down faster than the upkeep of one more building: it is built when the
      // treasury can pay for it outright, whatever the runway (live 2026-10-07: 45 garbage icons stood for a game year behind this gate while people left).
      const essential = (need === "garbage" || need === "healthcare" || need === "deathcare") && icons >= ESSENTIAL_SERVICE_ICON_FLOOR &&
        input.finance !== undefined && input.finance.treasury >= ESSENTIAL_SERVICE_MINIMUM_TREASURY;
      if (input.finance && !essential && !civicIsAffordable(input.finance.treasury, input.finance.monthlyBalance)) { notes.push(`service ${need}: ${evidence(need, icons)}, but the runway does not carry another building`); continue; }
      if (essential && input.finance && !civicIsAffordable(input.finance.treasury, input.finance.monthlyBalance)) notes.push(`service ${need}: ${evidence(need, icons)} — essential, built although the runway is short`);
      const queries = SERVICE_PREFAB_QUERIES[need];
      const offeredNow = async () => (await Promise.all(queries.map((query) => this.port.findPrefabs!(query, signal)))).flat().filter((entry) => !entry.locked).map((entry) => entry.name);
      let prefabs = servicePrefabs(need, await offeredNow());
      // None unlocked: the development points the milestones granted may buy the node it needs (live 2026-10-06: 35 points lay unspent while every
      // arterial stood at full wear and the road maintenance depot was one point away). One node per cycle, only a node the building names.
      const unlockable = SERVICE_UNLOCK_PREFABS[need];
      // Garbage piling up while only landfills stand (they fill): the burning and recycling plants are bought with development points, once per look.
      const wantsBetterGarbagePlants = need === "garbage" && icons >= 8 && !prefabs.some((name) => /Recycl/i.test(name)) && !this.#garbagePlantsAsked;
      if (wantsBetterGarbagePlants) this.#garbagePlantsAsked = true;
      if ((prefabs.length === 0 || wantsBetterGarbagePlants) && unlockable && this.port.techTree) {
        const bought = await unlockPrefabs(this.port.techTree, unlockable.map((prefab) => ({ prefab, category: "building" as const })), `the ${need} service`, notes, undefined, signal);
        if (bought.status === "BOUGHT") prefabs = servicePrefabs(need, await offeredNow());
      }
      if (prefabs.length === 0) { notes.push(`service ${need}: ${evidence(need, icons)}, but no unlocked building offers it`); continue; }
      let standing = 0;
      // A landfill only stores (and fills up): once a burning or recycling plant is on offer, the landfills standing do not count against how many the city
      // justifies (live 2026-10-07: 6 landfills stood = the ceiling, so the plant that would have emptied them was never tried while 28 icons stood).
      const betterGarbageOnOffer = need === "garbage" && prefabs.some((name) => /Incinerat|Recycl/i.test(name));
      for (const prefab of prefabs) if (!(betterGarbageOnOffer && /Landfill/i.test(prefab))) standing += (await utilities.listFacilities(prefab, signal)).length;
      // Garbage: each kind has its own ceiling (`garbageBuildingCap`); only the kinds still under theirs are offered, and the general figure below does not apply.
      if (need === "garbage") {
        const open: string[] = [];
        for (const prefab of prefabs) if ((await utilities.listFacilities(prefab, signal)).length < garbageBuildingCap(prefab, input.population ?? null)) open.push(prefab);
        if (open.length === 0) { notes.push(`service ${need}: ${evidence(need, icons)}; every kind of garbage building stands at the number this city justifies (the icons then wait for the trucks, the roads and the plants to work)`); continue; }
        prefabs = open;
      }
      const cap = serviceCap(need, input.population ?? null);
      const upSince = this.#iconsUpSince.get(need);
      // The player naming the problem is evidence enough that the buildings the population justifies are not.
      const stuck = named || (need === "garbage" && icons >= 10) || (upSince !== undefined && stampElapsed(upSince, cycleStamp, SERVICE_STUCK_HOURS, SERVICE_STUCK_CYCLES));
      if (need !== "garbage" && (standing >= serviceLimit(cap, standing, stuck) || (stuck && standing >= cap * SERVICE_STUCK_MAXIMUM_MULTIPLE))) { notes.push(`service ${need}: ${evidence(need, icons)}; ${standing} building(s) already stand, as many as ${input.population ?? "?"} people justify (${cap})${stuck ? ", and the evidence has stood for hours" : ""}`); continue; }
      if (stuck) notes.push(`service ${need}: (${evidence(need, icons)}) have stood for ${SERVICE_STUCK_HOURS}+ game hours beside ${standing} building(s) the population justifies (${cap}): one more is wanted`);
      const wanted = careReading.items.filter((item) => SERVICE_EVIDENCE_ICON[need].test(item.type));
      // The thickest cluster of icons first; when a try there found no lot, the next cluster (400 m apart) is looked at the next time — never a new
      // building per cluster, only where the one wanted is looked for.
      const clusters = iconClusters(wanted.length > 0 ? wanted : reading.items);
      const misses = this.#serviceMisses.get(need) ?? 0;
      const target = clusters.length > 0 ? clusters[misses % clusters.length]!.center : densestIcon(wanted.length > 0 ? wanted : reading.items);
      if (!target) continue;
      const network = mainStreetNetwork(world.roadGraph);
      const nearestStreet = (point: SpatialPoint2) => {
        let best: SpatialPoint2 | null = null;
        let bestDistance = Infinity;
        for (const edge of network.edges) {
          const dx = edge.end.x - edge.start.x; const dz = edge.end.z - edge.start.z; const lengthSquared = dx * dx + dz * dz;
          const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - edge.start.x) * dx + (point.z - edge.start.z) * dz) / lengthSquared)) : 0;
          const foot = { x: edge.start.x + ratio * dx, z: edge.start.z + ratio * dz };
          const distance = Math.hypot(foot.x - point.x, foot.z - point.z);
          if (distance < bestDistance) { bestDistance = distance; best = foot; }
        }
        return best;
      };
      // Reserved lots first (nearest the icons), then any lot beside a street near them.
      const candidates: Array<{ position: SpatialPoint2; rotation: number; lot: number | null }> = [];
      const lotsByDistance = this.#reservedLots.map((lot, index) => ({ lot, index, distance: Math.hypot(lot.center.x - target.x, lot.center.z - target.z) }))
        .filter((entry) => entry.distance < 900).sort((left, right) => left.distance - right.distance);
      for (const { lot, index } of lotsByDistance) {
        for (const [dx, dz] of [[0, 0], [-16, 0], [16, 0], [0, -16], [0, 16]] as const) {
          const position = { x: lot.center.x + dx, z: lot.center.z + dz };
          const street = nearestStreet(position);
          if (street) candidates.push({ position, rotation: civicRotationToward(position, street), lot: index });
        }
      }
      for (const site of civicSiteCandidates({ target, edges: network.edges, setbacksMeters: CIVIC_SETBACKS_METERS, maximumDistanceMeters: 600, maximumCandidates: 40 })) {
        candidates.push({ position: site.position, rotation: site.rotation, lot: null });
      }
      // A landfill is never put on a street lot among the icons: its site is `#placeBigService`'s, away from homes.
      if (need === "garbage") candidates.length = 0;
      let placed = false;
      let preflights = 0;
      let skippedKnown = 0;
      let noAnswers = 0;
      for (const prefab of prefabs) {
        if (placed || noAnswers >= PREFLIGHT_NO_ANSWER_LIMIT) break;
        const held = this.#highValue.blocked(prefab, cycleStamp);
        if (held) { this.#highValueRefusals.add(`${prefab}: ${held}`); continue; }
        for (const candidate of candidates) {
          if (signal?.aborted || preflights >= 30) break;
          if (budget.exhausted()) { notes.push(`service ${need}: the assist budget ran out while looking for a lot; it continues next cycle`); break; }
          // A spot the game already refused is not offered to it again this while.
          if (this.#refusedPlacements.refused(prefab, candidate.position, cycleStamp, stuck ? SERVICE_STUCK_REFUSAL_HOURS : undefined)) { skippedKnown += 1; continue; }
          if (this.#accessFailedSites.some((zone) => Math.hypot(zone.position.x - candidate.position.x, zone.position.z - candidate.position.z) < zone.radius)) { skippedKnown += 1; continue; }
          if (this.#unconfirmedPlacements.refused(prefab, candidate.position, cycleStamp)) { skippedKnown += 1; continue; }
          preflights += 1;
          budget.noteCheck();
          const legal = await utilities.preflight(prefab, candidate.position, candidate.rotation, signal);
          // No answer (the Bridge stayed busy) is not a refusal: it is not remembered as one, and a Bridge that answers nothing three times running
          // ends the search for this need (the same wall would be hit by every remaining spot, at seconds apiece).
          if (legal === null) {
            noAnswers += 1;
            if (noAnswers >= PREFLIGHT_NO_ANSWER_LIMIT) { notes.push(`service ${need}: the Bridge gave no answer to ${noAnswers} placement checks in a row (BRIDGE_BUSY); not searching further this cycle`); break; }
            continue;
          }
          noAnswers = 0;
          if (!legal) { this.#refusedPlacements.remember(prefab, candidate.position, cycleStamp); continue; }
          // Checked once more right before the commit: a spent budget or an abort commits nothing.
          if (signal?.aborted || budget.exhausted()) break;
          budget.noteWrite();
          const verdict = await this.#placeService(utilities, prefab, candidate.position, candidate.rotation, standing, signal);
          // The game refusing the placement is a refusal; a placement it accepted that cannot be found is UNCONFIRMED (not a fact about the lot): remembered for a few
          // hours only, and counted by the next cycle's standing count if it does appear.
          if (verdict === "FAILED") this.#refusedPlacements.remember(prefab, candidate.position, cycleStamp);
          else if (verdict === "UNCONFIRMED") this.#unconfirmedPlacements.remember(prefab, candidate.position, cycleStamp);
          const result = verdict === "STANDS";
          notes.push(`service ${need}: ${prefab} at (${candidate.position.x.toFixed(0)},${candidate.position.z.toFixed(0)}) for ${evidence(need, icons)} — ${verdict === "STANDS" ? "stands (read back)" : verdict === "UNCONFIRMED" ? "accepted by the game but not found after a second read (unconfirmed, not a refusal)" : "refused when placed"}`);
          if (result) {
            placed = true;
            if (candidate.lot !== null) this.#reservedLots.splice(candidate.lot, 1);
            break;
          }
        }
      }
      // A building too big for any lot beside a street (the road maintenance depot, 80 x 96 m: live 2026-10-06 "no legal lot") is fitted to free land by
      // geometry (`big-building-site.ts`) instead of probed lot by lot.
      if (!placed && need === "garbage") {
          // Far from homes first; when the grown city leaves no such lot (live 2026-10-07: 27,000 people, 23 garbage icons, "0 sites tried"), a nearer one is
          // taken in steps — garbage piling up hurts the homes more than a landfill 100 m away does.
          for (const buffer of GARBAGE_HOME_BUFFERS_METERS) {
            if (signal?.aborted) break;
            // A burning plant makes air pollution (live 2026-10-07: two of them 100-250 m from homes put 55 air-pollution icons on the homes round them): it never
            // goes closer than INCINERATOR_HOME_BUFFER_METERS, whatever the other garbage buildings are allowed.
            const bigPlantsAffordable = (input.finance?.treasury ?? 0) >= ESSENTIAL_SERVICE_MINIMUM_TREASURY;
            const offered = prefabs.filter((name) => !(/Incinerat|Recycl/i.test(name) && (buffer < INCINERATOR_HOME_BUFFER_METERS || !bigPlantsAffordable)));
            if (offered.length === 0) continue;
            placed = await this.#placeBigService(utilities, world, input, offered, target, standing, notes, signal, buffer);
            if (placed) break;
          }
        } else if (!placed) placed = await this.#placeBigService(utilities, world, input, prefabs, target, standing, notes, signal, null);
      if (!placed && this.options.serviceDemolitionExperiment && this.#serviceDemolitions < 1) {
        placed = await this.#demolishHomeForService(utilities, need, prefabs, target, nearestStreet, standing, notes, signal);
      } else if (!placed) {
        notes.push(`service ${need}: ${evidence(need, icons)}, but no legal lot near them (${preflights} sites tried${skippedKnown > 0 ? `, ${skippedKnown} not tried again: refused earlier` : ""})`);
      }
      if (placed) { placedTotal += 1; this.#serviceRest.set(need, cycleStamp); this.#iconsUpSince.set(need, cycleStamp); this.#serviceMisses.set(need, 0); }
      else this.#serviceMisses.set(need, misses + 1);
    }
    });
    await budget.stage("power", () => this.#lightDarkHomes(reading, input, cycleStamp, notes, spend));
    await budget.stage("noise", async () => { if (roadCare) await roadCare.noise(reading.items, notes, spend, signal); });
    if (!focus.has("TRAFFIC")) await trafficStage();
    } finally {
      notes.push(budget.describe());
      for (const refusal of this.#highValueRefusals) notes.push(`costly facility held: ${refusal}`);
      this.#highValueRefusals.clear();
      this.#assist = null;
    }
    return placedTotal;
  }

  /**
   * Homes the game reports with no electricity (live 2026-10-06: ~400 homes in one far cluster at 0 of 9 wanted while the city's total production stood
   * above its total consumption — a supply gap of one sub-grid, which the city-wide headroom never sees). A generator is placed at the thickest cluster
   * of those icons, joined to the street beside it, and the game is the judge: the icons are read again after the cooldown, and a cluster that stays dark
   * after `DARK_CLUSTER_MAXIMUM_PLACEMENTS` generators is left alone (the cause is then not supply).
   */
  async #lightDarkHomes(reading: IconReading, input: DistrictCycleInput, stamp: GameStamp, notes: string[], spend: () => boolean): Promise<void> {
    const port = this.#utilitiesWithAccessCheck();
    if (!port || input.signal?.aborted) return;
    const dark = reading.items.filter((item) => /^Electricity Notification/i.test(item.type));
    if (dark.length < SERVICE_MINIMUM_ICONS) return;
    const restedAt = this.#darkRest;
    if (restedAt && !stampElapsed(restedAt, stamp, DARK_HOMES_COOLDOWN_HOURS, DARK_HOMES_COOLDOWN_CYCLES)) return;
    const cluster = iconClusters(dark).find((entry) => (this.#darkPlacements.get(darkKey(entry.center)) ?? 0) < DARK_CLUSTER_MAXIMUM_PLACEMENTS);
    if (!cluster) { notes.push(`power: ${dark.length} homes have no electricity, but every cluster of them already got ${DARK_CLUSTER_MAXIMUM_PLACEMENTS} generators and stays dark: the cause is not supply, not building more`); return; }
    if (!spend()) return;
    this.#darkRest = stamp;
    try {
      const world = await this.port.scanWorld(input.signal);
      const component = mainStreetNetwork(world.roadGraph);
      if (component.edges.length === 0) return;
      const detail = await this.port.siteDetail(cluster.center, DISTRICT_WATER_REACH_METERS, 128, input.signal);
      const homes = (await this.port.listBuildings(input.signal)).filter((building) => classifyBuilding(building.prefab) === "sensitive").map((building) => building.position);
      const realization = await realizeUtilityShortfall(port, { kind: "electricity", shortfall: cluster.size * DARK_HOME_WANTED_UNITS, target: cluster.center,
        edges: component.edges, ...(detail?.terrain ? { terrain: detail.terrain } : {}), avoid: lotsToAvoid(detail), siting: { city: centreOf(homes) ?? cluster.center, homes },
        placementMemory: { refused: this.#refusedPlacements, cycle: stamp }, excludedAround: this.#accessFailedSites, ...(input.signal ? { signal: input.signal } : {}) }, notes);
      this.#rememberOwn(realization.placements);
      const key = darkKey(cluster.center);
      this.#darkPlacements.set(key, (this.#darkPlacements.get(key) ?? 0) + realization.placements.length);
      notes.push(`power: ${cluster.size} dark homes near (${cluster.center.x.toFixed(0)},${cluster.center.z.toFixed(0)}): ${realization.placements.length} generator(s) placed beside them; the icons are read again after ${DARK_HOMES_COOLDOWN_HOURS} game hours`);
    } catch (error) {
      notes.push(`power: ${error instanceof Error ? error.message.slice(0, 160) : "failed"}`);
    }
  }
  #darkRest: GameStamp | null = null;
  /** When land was last bought for a big service building (`BIG_SERVICE_LAND_COOLDOWN_HOURS`). */
  #bigLandBoughtAt: GameStamp | null = null;
  readonly #darkPlacements = new Map<string, number>();

  /** The road tools plus the one that makes a larger road usable: the development node it needs is bought when it is locked (`tech-tree.ts`). */
  #roadsWithUnlock(roads: RoadCarePort): RoadCarePort {
    const tech = this.port.techTree;
    if (!tech) return roads;
    return { ...roads, unlockRoad: async (prefab, signal) => {
      const locks = await tech.prefabLocks([{ prefab, category: "net" }], signal);
      if (locks && !locks.some((lock) => lock.prefab === prefab && lock.locked)) return true;
      const outcome = await unlockPrefabs(tech, [{ prefab, category: "net" }], `the ${prefab} road`, [], undefined, signal);
      return outcome.status === "BOUGHT";
    } };
  }

  /** The assist round's budget while it runs (null between rounds). */
  #assist: AssistBudget | null = null;
  /** Traffic and road noise (`road-care.ts`), when the port reaches the road tools. */
  #roadCareInstance: RoadCare | null | undefined;
  get #roadCare(): RoadCare | null {
    if (this.#roadCareInstance === undefined) {
      this.#roadCareInstance = this.port.roads ? new RoadCare(this.#roadsWithUnlock(this.port.roads), this.#roadCareMemory, (memory) => { this.#roadCareMemory = memory; this.#saveMemory(); }, this.options.experience) : null;
    }
    return this.#roadCareInstance;
  }
  /** Placements the game accepted that could not be found afterwards: remembered for a short while only. */
  readonly #unconfirmedPlacements = new RefusedPlacements(6, 24, 4);
  /** Cycles in a row a service need found no lot at its current icon cluster (the next cluster is tried next). */
  readonly #serviceMisses = new Map<ServiceNeed, number>();

  /** Residential cells the city can take up beyond what stands empty (null: no readable rate), from this cycle's plan. */
  #absorptionCells: number | null = null;
  /** Cycles in a row zoning has waited for a network that could not be placed (see `UTILITY_ZONING_HOLD_MAXIMUM_CYCLES`). */
  #utilityHoldCycles = 0;
  /** The batch has no sample to be priced against this cycle (see `SEED_BATCH_SQUARE_METERS`). */
  #seedBatch = false;
  /** The opening stage: the seed is the ceiling of the batch whatever the absorption reading says. */
  #seedAlways = false;
  /** Utilities whose last repair searched every candidate and found none that can stand. */
  readonly #utilityExhausted = new Set<DistrictUtilityKind>();
  /** A site was refused because its way in (the gateway) crosses water or a cliff: the next cycle looks for bridges whatever the reachable land reads. */
  #gatewayGroundRefused = false;
  /** Stale zoning (see `#withdrawStaleZoning`): when last reviewed and where the walk along the streets stands. */
  #staleReviewAt: GameStamp | null = null;
  #staleCursor = 0;
  /** The train link (see `#linkTrain`): done, failed attempts, when last looked at. */
  #trainLinked = false;
  /** The railway prefabs are unlocked (every development-tree node they need is bought), and when the tree was last looked at. */
  #railwayUnlocked = false;
  #yardDone = false;
  #yardLookedAt: GameStamp | null = null;
  /** Sites of big buildings the game refused: never asked again (kept across restarts). */
  readonly #bigRefused: SpatialPoint2[] = [];
  #bigRefusedOwned: number | null = null;
  #techLookedAt: GameStamp | null = null;
  #trainAttempts = 0;
  #trainLookedAt: GameStamp | null = null;
  /** The passenger train loop (see `#linkTrain`): stands, when last looked at. */
  #trainLoopStands = false;
  #trainLoopLookedAt: GameStamp | null = null;
  /** Where the passenger platform stands (read back from the world with the train loop): high density is laid around it. */
  #stationAt: SpatialPoint2 | null = null;
  /** When each signature building was last offered a lot (see `#placeSignatures`). */
  readonly #signatureTriedAt = new Map<string, GameStamp>();
  /** Signatures seen standing (each stands once): never listed again. */
  readonly #signaturesStanding = new Set<string>();
  #signatureLookedAt: GameStamp | null = null;
  /** When the power export was last looked at (see `#sellPower`). */
  #powerExportAt: GameStamp | null = null;
  /** Bridges tried per crossing (see `#bridgeToStrandedLand`). */
  readonly #bridgeAttempts = new Map<string, { count: number; at: GameStamp }>();
  /** A tile was bought ahead of need in this cycle's land step: a cycle with no site then ends as LAND_PURCHASED, not as a wait. */
  #boughtAheadThisCycle = false;
  /** When the game last refused the rolling land purchase (see `#buyLandAhead`). */
  #landAheadRefusedAt: GameStamp | null = null;
  /** The game refused to sell a tile in this cycle's land step (see the end of the land step). */
  #purchaseRefusedByGame = false;
  /** When the unfilled-stock wait began (see `UNFILLED_STOCK_CELL_LIMIT`). */
  #unfilledSince: { stamp: GameStamp; held: number } | null = null;

  /**
   * FAST_EXPANSION V2 (docs/FAST_EXPANSION_V2 Gameplay Policy Candidate.md): stage by milestone (P1), density by unlock and vacancy (P3), the
   * batch as the smaller of the cash cap and the absorption cap (P2), and the hard finance constraint (P8). Reads only; decides, in `growth-policy.ts`,
   * from numbers the world gave. A reading the host cannot give is named in the notes and that rule stands down — nothing is guessed in its place.
   */
  async #planGrowth(input: DistrictCycleInput, notes: string[], role: DistrictRole): Promise<{ frozen: boolean; paused: ZoneCategory[] }> {
    const signal = input.signal;
    const paused: ZoneCategory[] = [];
    const progress = (await this.port.readProgress?.(signal)) ?? null;
    const series = (await this.port.readPopulationSeries?.(signal)) ?? null;
    const densities = input.unlocked?.densities ?? { low: true, medium: false, high: false };
    const verdict = growthStage({ milestone: progress?.milestone ?? null, population: input.population ?? null, densities,
      officeUnlocked: input.unlocked?.office ?? false, immigrationDecaying: growthDecaying(series) });
    this.#stage = verdict.stage;
    const xpGap = progress && progress.xp !== null && progress.nextMilestoneXp !== null ? progress.nextMilestoneXp - progress.xp : null;
    notes.push(`growth V2 (game ${POLICY_GAME_VERSION}): stage ${verdict.stage} (${verdict.detail})${xpGap !== null ? `; ${Math.max(0, xpGap)} XP to the next milestone` : ""}`);
    // P8: a hard constraint. The rolling monthly balance negative for K months in a row stops growth; repairs go on.
    if (input.finance) this.#financeWatch.observe(gameMonthKey(progress?.gameDateTime), input.finance.monthlyBalance);
    if (this.#financeWatch.frozen) {
      notes.push(`growth frozen (P8): the monthly balance has been negative for ${this.#financeWatch.negativeStreak} months running; only repairs go on`);
      return { frozen: true, paused };
    }
    // P3: density by unlock and vacancy.
    this.#chosenDensity = null;
    const by = this.#mix.residentialByDensity;
    if (!input.unlocked) notes.push("density: the catalogue's unlocked densities are not read, so the density policy stands down");
    else {
      const stateOf = (key: ResidentialDensityKey): DensityState => ({ unlocked: input.unlocked!.densities[key],
        vacancyShare: by ? (by[key].zoned > 0 ? by[key].empty / by[key].zoned : 0) : null, demand: by ? by[key].demand : null });
      const laid = this.#laidResidential.low + this.#laidResidential.other;
      // The low-density share is the world's: the residential zoning the game reports by density (a restart of this process forgets what it laid).
      const zonedByDensity = by ? by.low.zoned + by.medium.zoned + by.high.zoned : 0;
      const lowShare = zonedByDensity > 0 ? by!.low.zoned / zonedByDensity : laid > 0 ? this.#laidResidential.low / laid : null;
      const densities = { low: stateOf("low"), medium: stateOf("medium"), high: stateOf("high") };
      let choice = chooseResidentialDensity({ stage: verdict.stage, densities, lowDensityShareSoFar: lowShare });
      // The quota is a preference, not a wall: held for hours with nothing denser open, it yields (see `chooseResidentialDensity`).
      const quotaStamp = this.#stamp(this.#cycles);
      if (choice.quotaBlocked && role === "residential") {
        this.#quotaBlockedSince ??= quotaStamp;
        if (stampElapsed(this.#quotaBlockedSince, quotaStamp, QUOTA_YIELD_HOURS, QUOTA_YIELD_CYCLES)) choice = chooseResidentialDensity({ stage: verdict.stage, densities, lowDensityShareSoFar: lowShare, quotaYields: true });
      } else this.#quotaBlockedSince = null;
      this.#chosenDensity = choice.density ? (choice.density.toUpperCase() as DistrictDensity) : null;
      notes.push(`density: ${choice.density ?? "none"} — ${choice.reason}${by ? "" : " (vacancy by density not read)"}`);
      if (role === "residential" && !choice.density) paused.push("residential");
    }
    // P2: what the city can take up. Only homes are capped by absorption; the other uses are held by their own stock and the labour reading.
    let absorptionCells: number | null = null;
    // What the player asked for by name is built whether or not the city is filling its stock: the ask overrides the absorption cap, never the cash.
    if (role === "residential" && this.#chosenDensity && by && !input.intent?.role) {
      const key = this.#chosenDensity.toLowerCase() as ResidentialDensityKey;
      const built = (["low", "medium", "high"] as const).reduce((sum, density) => sum + by[density].zoned - by[density].empty, 0);
      const result = absorbableCells({ growthPerDay: netGrowthPerDay(series), population: input.population ?? null, builtResidentialCells: built,
        emptyCellsOfDensity: by[key].empty, zonedCellsOfDensity: by[key].zoned, demand: by[key].demand });
      absorptionCells = result.cells;
      notes.push(`absorption (${key}): ${result.detail}${result.cells === null ? "; the batch is not capped by absorption" : ` -> ${Math.round(result.cells)} cells`}`);
      if (result.cells !== null && result.cells <= 0) paused.push("residential");
    }
    this.#absorptionCells = absorptionCells;
    // P2 and S0 ("a small, complete first loop"): with nothing to price the batch against — the opening stage, or homes whose immigration rate cannot be
    // read — the batch is a seed, not the cash cap. A player's named request is sized by the cash alone, as before.
    this.#seedBatch = !input.intent?.role && (verdict.stage === "S0" || (role === "residential" && absorptionCells === null));
    this.#seedAlways = !input.intent?.role && verdict.stage === "S0";
    if (input.finance) {
      this.#batch = batchConstraint({ absorptionCells, seed: this.#seedBatch, seedAlways: this.#seedAlways, capitalArea: capitalAreaCap({ treasury: input.finance.treasury, monthlyBalance: input.finance.monthlyBalance,
        monthlyMaintenance: this.#costs?.monthlyExpenses ?? null }) });
      notes.push(`batch: ${this.#batch.detail}`);
    } else this.#batch = null;
    return { frozen: false, paused };
  }

  /**
   * The unfilled stock: homes already zoned that nobody lives in. Laying more of them does not make the people come. Only while the city is too
   * small for an immigration rate (the absorption cap of P2 stands down then and nothing else prices the batch). Returns true when residential is
   * held out; it is held out BEFORE the role is chosen, so the other uses (jobs, shops) are laid meanwhile instead of the city standing still.
   */
  #unfilledStockHolds(input: DistrictCycleInput, notes: string[]): boolean {
    const by = this.#mix.residentialByDensity;
    const population = input.population;
    if (!by || input.intent?.role || population === null || population === undefined || population >= MINIMUM_POPULATION_FOR_RATES) { this.#unfilledSince = null; return false; }
    // Zoning held back until the utilities answer is not in the game's reading yet: the districts this builder laid count too (almost nobody lives there).
    const empty = Math.max(by.low.empty + by.medium.empty + by.high.empty, Math.round((this.#laidResidential.low + this.#laidResidential.other) * 0.6 / 64));
    if (empty < UNFILLED_STOCK_CELL_LIMIT) { this.#unfilledSince = null; return false; }
    // A held cycle does not advance the build-cycle counter, so the wait counts its own cycles.
    this.#unfilledSince ??= { stamp: this.#stamp(0), held: 0 };
    this.#unfilledSince.held += 1;
    if (stampElapsed(this.#unfilledSince.stamp, this.#stamp(this.#unfilledSince.held), UNFILLED_STOCK_ESCAPE_HOURS, UNFILLED_STOCK_ESCAPE_CYCLES)) {
      this.#unfilledSince = null;
      notes.push(`unfilled stock: ${empty} zoned homes stood empty for ${UNFILLED_STOCK_ESCAPE_HOURS} game hours; one more residential district is laid so the city never stands still`);
      return false;
    }
    notes.push(`unfilled stock: ${empty} zoned homes stand empty (limit ${UNFILLED_STOCK_CELL_LIMIT}); no new residential district until they fill, other uses go on`);
    return true;
  }

  /** The batch on the treasury as it stands after the loan step; `held` when it is smaller than one district. */
  #withBatch(input: DistrictCycleInput, notes: string[], role: DistrictRole): { input: DistrictCycleInput; held: boolean } {
    if (!input.finance) return { input, held: false };
    const batch = batchConstraint({ absorptionCells: role === "residential" && !input.intent?.role ? this.#absorptionCells : null, seed: this.#seedBatch, seedAlways: this.#seedAlways,
      capitalArea: capitalAreaCap({ treasury: input.finance.treasury, monthlyBalance: input.finance.monthlyBalance, monthlyMaintenance: this.#costs?.monthlyExpenses ?? null }) });
    this.#batch = batch;
    notes.push(`batch (after financing): ${batch.detail}`);
    let limit = batch.limit;
    if (input.nearTarget && role === "residential") {
      const remaining = Math.max(0, input.nearTarget.target - input.nearTarget.population);
      const room = remaining * NEAR_TARGET_SQUARE_METERS_PER_PERSON;
      if (room < limit) {
        limit = room;
        notes.push(`growth: near the target population (${Math.round(input.nearTarget.population)} of ${Math.round(input.nearTarget.target)}): a new district is cut to ${Math.round(room)} m2, what the ${Math.round(remaining)} people still to come would fill${room < SMALLEST_DISTRICT_SQUARE_METERS ? "; that is less than the smallest district, so none is opened" : ""}`);
      }
    }
    return { input: { ...input, maximumAreaSquareMeters: limit }, held: limit < SMALLEST_DISTRICT_SQUARE_METERS };
  }

  /** The density a zone is laid at: the player's asked density rules; otherwise, for homes in FAST_EXPANSION, the density this cycle chose. */
  #densityOf(category: ZoneCategory, input: DistrictCycleInput): DistrictDensity | undefined {
    if (input.intent?.density) return input.intent.density;
    return input.pipelined && category === "residential" && this.#chosenDensity ? this.#chosenDensity : undefined;
  }

  /**
   * The loan step of the growth capital loop (see `loan-policy.ts`): borrow the gap to one more build when the world proves the bottleneck
   * and the city can carry the payments, undo the step if the game's own figures say it cannot, repay when the treasury is comfortable.
   * Returns the input with the treasury (and the district size the cash allows) as it stands afterwards.
   */
  async #loanStep(input: DistrictCycleInput, notes: string[]): Promise<DistrictCycleInput> {
    const port = this.port.loan;
    // The player's takeover permission (`host/protocol.ts`): loans are the player's unless they allowed economic adjustments.
    if (!input.pipelined || !input.finance || !port || process.env.AI_MAYOR_ALLOW_ECONOMY === "0") return input;
    const signal = input.signal;
    const before = await port.read(signal);
    if (!before) return input;
    const needed = neededLandUses(this.#bottleneck, this.#mix.demand, this.#available);
    const absorbing = neededStockAbsorbing(this.#stockHistory.slice(0, -1), this.#mix, needed, this.#stockHistory.at(-1)?.stamp).absorbing;
    // P2/P8: more cash only helps when cash is what limits the batch; and the borrowed share of the credit line sets the tier.
    // A seed batch is not limited by cash either: borrowing more would not make it bigger.
    const capitalBound = this.#batch ? this.#batch.binding !== "absorption" && this.#batch.binding !== "seed" : undefined;
    const decision = decideLoan({ loan: before, treasury: input.finance.treasury, monthlyBalance: input.finance.monthlyBalance, bottleneck: this.#bottleneck, absorbing,
      ...(capitalBound !== undefined ? { capitalBound } : {}), cycle: this.#cycles, blockedUntilCycle: this.#loanBlockedUntil,
      block: this.#loanBlockedSince, now: this.#stamp(this.#cycles) });
    this.#cutSpending = "cutSpending" in decision && decision.cutSpending === true;
    if (this.#cutSpending) notes.push(`loan: ${decision.reason}; land is not bought this cycle`);
    if (decision.action === "NONE") { if (before.amount > 0 && !this.#cutSpending) notes.push(`loan: ${Math.round(before.amount)} owed; no step (${decision.reason})`); return input; }
    const target = decision.action === "BORROW" ? before.amount + decision.amount : before.amount - decision.amount;
    if (!(await port.set(target, signal))) { notes.push(`loan: ${decision.action.toLowerCase()} ${Math.round(decision.amount)} was refused by the game`); this.#blockLoan(LOAN_REFUSED_BLOCK_HOURS, LOAN_REFUSED_BLOCK_CYCLES); return input; }
    const after = await port.read(signal);
    const delta = target - before.amount;
    if (decision.action === "BORROW" && after && !paymentsFit(after, input.finance.monthlyBalance + before.dailyPayment * 30)) {
      // The game's own payment figure does not fit what the city earns: the step is undone, and not tried again for a while.
      await port.set(before.amount, signal);
      this.#blockLoan(LOAN_REFUSED_BLOCK_HOURS, LOAN_REFUSED_BLOCK_CYCLES);
      notes.push(`loan: borrowed ${Math.round(delta)} and gave it back — the payments (${Math.round(after.dailyPayment * 30)} a month) would take more than half of what the city earns`);
      return input;
    }
    this.#blockLoan(LOAN_COOLDOWN_HOURS, LOAN_COOLDOWN_CYCLES);
    notes.push(`loan: ${decision.action === "BORROW" ? "borrowed" : "repaid"} ${Math.round(Math.abs(delta))} — ${decision.reason}${after ? `; now ${Math.round(after.amount)} owed, ${Math.round(after.dailyPayment * 30)} a month` : ""}`);
    const treasury = input.finance.treasury + delta;
    return { ...input, finance: { ...input.finance, treasury },
      ...(input.maximumAreaSquareMeters !== undefined ? { maximumAreaSquareMeters: Math.max(input.maximumAreaSquareMeters, (treasury - EXPANSION_DEVIATION_RESERVE) / 0.3) } : {}) };
  }

  /**
   * A service whose building is bigger than a street lot (`BIG_SERVICE_MINIMUM_SIDE_METERS`): its footprint is read from the Bridge, a rectangle of the
   * product's own free-land mask that holds it is asked of the game (each site once, ever), and with no such rectangle a tile is bought toward the icons.
   * The building is read back like any service, so it joins the facilities whose road access is repaired.
   */
  async #placeBigService(utilities: DistrictUtilitiesPort, world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, input: DistrictCycleInput,
    prefabs: readonly string[], target: SpatialPoint2, standing: number, notes: string[], signal?: AbortSignal, keepAwayFromHomesMeters: number | null = null): Promise<boolean> {
    const tech = this.port.techTree;
    if (!tech || signal?.aborted) return false;
    // A landfill stands away from homes (noise, ground pollution): the homes are read once, and no site nearer one is offered.
    const homes = keepAwayFromHomesMeters === null ? [] : (await this.port.listBuildings(signal)).filter((building) => classifyBuilding(building.prefab) === "sensitive").map((building) => building.position);
    const clearOfHomes = (point: SpatialPoint2): boolean => keepAwayFromHomesMeters === null || homes.every((home) => Math.hypot(home.x - point.x, home.z - point.z) >= keepAwayFromHomesMeters);
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    if (this.#bigRefusedOwned !== null && this.#bigRefusedOwned !== tiles.length) this.#bigRefused.length = 0;
    this.#bigRefusedOwned = tiles.length;
    for (const prefab of prefabs) {
      const held = this.#highValue.blocked(prefab, this.#stamp(this.#cycles));
      if (held) { this.#highValueRefusals.add(`${prefab}: ${held}`); continue; }
      const locks = await tech.prefabLocks([{ prefab, category: "building" }], signal);
      const footprint = footprintOf(locks?.find((lock) => lock.prefab === prefab));
      if (!footprint || (keepAwayFromHomesMeters === null && Math.max(footprint.widthMeters, footprint.depthMeters) < BIG_SERVICE_MINIMUM_SIDE_METERS)) continue;
      // Beside a street first, front to it, set back by half its own depth: the way every service reaches its road with no road of its own laid (the street
      // lot setbacks, 18-46 m, are too small for a building 80-96 m deep; live 2026-10-06: depots on free land 50-150 m from a street never got a road).
      const half = Math.max(footprint.widthMeters, footprint.depthMeters) / 2;
      const beside = civicSiteCandidates({ target, edges: mainStreetNetwork(world.roadGraph).edges, setbacksMeters: [half + 6, half + 12, half + 20, half + 30], maximumDistanceMeters: keepAwayFromHomesMeters === null ? 700 : 1_800, maximumCandidates: keepAwayFromHomesMeters === null ? 24 : 120 })
        .filter((site) => clearOfHomes(site.position));
      let sideAsked = 0;
      for (const site of beside) {
        if (signal?.aborted || sideAsked >= BIG_SERVICE_BESIDE_PREFLIGHTS || this.#assist?.exhausted()) break;
        if (this.#refusedPlacements.refused(prefab, site.position, this.#stamp(this.#cycles))) continue;
        sideAsked += 1;
        const legal = await utilities.preflight(prefab, site.position, site.rotation, signal);
        if (legal === null) break;
        if (!legal) { this.#refusedPlacements.remember(prefab, site.position, this.#stamp(this.#cycles)); continue; }
        const verdict = await this.#placeService(utilities, prefab, site.position, site.rotation, standing, signal);
        notes.push(`big service ${prefab}: beside the street at (${site.position.x.toFixed(0)},${site.position.z.toFixed(0)}), set back ${Math.round(half + 6)}+ m — ${verdict === "STANDS" ? "stands (read back)" : verdict === "UNCONFIRMED" ? "accepted but not read back" : "refused when placed"}`);
        if (verdict === "FAILED") { this.#refusedPlacements.remember(prefab, site.position, this.#stamp(this.#cycles)); continue; }
        return true;
      }
      // A building with no road is taken down again by the access repair (live 2026-10-06: a depot 580 m from any street read "No Road Access"): it goes
      // on free land beside a street, toward the street point nearest the icons, and only free land within BIG_SERVICE_STREET_REACH_METERS of it counts.
      const street = nearestStreetPoint(target, mainStreetNetwork(world.roadGraph).edges)?.point ?? target;
      const outcome = await placeBigBuilding({
        footprint: async () => footprint,
        freeRectangles: async () => {
          const mask = await this.#readLandMask(world, [], "commercial", { sensitive: [], polluters: [] }, signal);
          if (!mask) return null;
          // Free ground anywhere in the owned land that a street reaches (within BIG_SERVICE_STREET_REACH_METERS of ANY street of the network, not of one point
          // near the icons: live 2026-10-07 the icons cluster in the dense centre, where nothing within 90 m of one street point is free, while forests and meadows
          // lay empty beside streets all round). Nearest the icons first is the fitter's job (`fitSites` sorts by distance to the target).
          const all = maximalRectangles(mask.mask, 120);
          const streetEdges = mainStreetNetwork(world.roadGraph).edges;
          const nearStreet = (rectangle: { minX: number; minZ: number; widthMeters: number; heightMeters: number }) => {
            const centre = { x: rectangle.minX + rectangle.widthMeters / 2, z: rectangle.minZ + rectangle.heightMeters / 2 };
            // The street's distance to the rectangle's own edge (a long rectangle may touch a street at its end).
            const probes = [centre, { x: rectangle.minX, z: rectangle.minZ }, { x: rectangle.minX + rectangle.widthMeters, z: rectangle.minZ }, { x: rectangle.minX, z: rectangle.minZ + rectangle.heightMeters }, { x: rectangle.minX + rectangle.widthMeters, z: rectangle.minZ + rectangle.heightMeters }];
            return Math.min(...probes.map((probe) => nearestStreetPoint(probe, streetEdges)?.distance ?? Infinity)) <= BIG_SERVICE_STREET_REACH_METERS + Math.max(rectangle.widthMeters, rectangle.heightMeters) / 2;
          };
          const afterHomes = all.filter((rectangle) => clearOfHomes({ x: rectangle.minX + rectangle.widthMeters / 2, z: rectangle.minZ + rectangle.heightMeters / 2 }));
          const kept = afterHomes.filter(nearStreet);
          notes.push(`big service ${prefab}: free ground read — ${all.length} rectangle(s) in the owned land, ${afterHomes.length} at least ${keepAwayFromHomesMeters ?? 0} m from homes, ${kept.length} of those beside a street`);
          return kept;
        },
        preflight: (name, point, rotation) => utilities.preflight(name, point, rotation, signal),
        place: async (name, point, rotation) => {
          const verdict = await this.#placeService(utilities, name, point, rotation, standing, signal);
          return { ok: verdict !== "FAILED", detail: verdict };
        },
        siteReachable: (centre, needed) => {
          const reach = nearestStreetPoint(centre, mainStreetNetwork(world.roadGraph).edges)?.distance ?? Infinity;
          return reach - Math.max(needed.widthMeters, needed.depthMeters) / 2 <= SITE_STREET_SLACK_METERS;
        },
        clearRoom: async (needed, where) => {
          // Taking buildings down to make room: only what the player's takeover allows (their own buildings stay while "protect my buildings" is on: then only
          // ruins and abandoned ones are eligible), never a map-native building, a service, a signature building or a protected district, and at most once
          // per BIG_SERVICE_CLEAR_COOLDOWN_HOURS (live 2026-10-07: "no site" every cycle for hours, a flicker of preflights and nothing built).
          if (!utilities.remove) return 0;
          const clearedStamp = this.#stamp(this.#cycles);
          if (this.#bigClearedAt && !stampElapsed(this.#bigClearedAt, clearedStamp, BIG_SERVICE_CLEAR_COOLDOWN_HOURS, BIG_SERVICE_CLEAR_COOLDOWN_CYCLES)) {
            notes.push(`big service ${prefab}: room was made lately; waiting for the ground to read free`); return 0;
          }
          const mayTakeHomes = process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS === "0";
          const detail = await this.port.siteDetail(where, 420, 24, signal).catch(() => null);
          const known = (detail?.buildings ?? []).filter((building) => Number.isFinite(building.position.x));
          const eligible = (entry: ClearingBuilding): boolean => {
            const building = known.find((candidate) => `${candidate.entity.index}:${candidate.entity.version}` === entry.id);
            if (!building || building.native || protection.circle({ x: building.position.x, z: building.position.z }, 10)) return false;
            if (SERVICE_OR_SIGNATURE.test(building.prefab)) return false;
            return mayTakeHomes ? LOW_DENSITY_LAND_USE.test(building.prefab) : false;
          };
          const places = beside.map((site) => ({ center: site.position, rotation: site.rotation }));
          const plan = planClearing({ footprint: needed, places, target: where, eligible,
            buildings: known.map((building) => ({ id: `${building.entity.index}:${building.entity.version}`, position: { x: building.position.x, z: building.position.z },
              bounds: building.footprint ? { minX: building.footprint.bounds.min.x, minZ: building.footprint.bounds.min.z, maxX: building.footprint.bounds.max.x, maxZ: building.footprint.bounds.max.z } : null })) });
          if (!plan) {
            // Why: what was looked at, so a refusal is never a mystery (the places, the buildings read, how many of them may go, the fewest a place holds).
            const stats = places.map((place) => { const half = Math.max(needed.widthMeters, needed.depthMeters) / 2 + 4; const inside = known.filter((building) => Math.abs(building.position.x - place.center.x) < half && Math.abs(building.position.z - place.center.z) < half);
              return { count: inside.length, eligible: inside.filter((building) => eligible({ id: `${building.entity.index}:${building.entity.version}`, position: { x: building.position.x, z: building.position.z } })).length }; });
            const fewest = stats.filter((entry) => entry.count > 0).sort((left, right) => left.count - right.count)[0];
            notes.push(`big service ${prefab}: room check — ${places.length} street-side place(s), ${known.length} building(s) read, ${known.filter((building) => eligible({ id: `${building.entity.index}:${building.entity.version}`, position: { x: building.position.x, z: building.position.z } })).length} may go, the emptiest place holds ${fewest ? `${fewest.count} (${fewest.eligible} may go)` : "none"}`);
            notes.push(`big service ${prefab}: nothing can be taken down to make the ${Math.round(needed.widthMeters)} x ${Math.round(needed.depthMeters)} m room${mayTakeHomes ? "" : " (the takeover keeps the player's buildings: only ruins may go)"}`);
            return 0;
          }
          let down = 0;
          for (const blocker of plan.blockers) {
            const building = known.find((candidate) => `${candidate.entity.index}:${candidate.entity.version}` === blocker.id);
            if (building && await utilities.remove(building.entity, signal)) down += 1;
          }
          this.#bigClearedAt = clearedStamp;
          this.#frontageDirty = true;
          notes.push(`big service ${prefab}: ${down} of ${plan.blockers.length} building(s) taken down at (${plan.center.x.toFixed(0)},${plan.center.z.toFixed(0)}) to make a ${Math.round(needed.widthMeters)} x ${Math.round(needed.depthMeters)} m room; it is placed once the ground reads free`);
          this.options.experience?.record("big-room", prefab.replace(/\d+$/, ""), `cleared:${Math.min(plan.blockers.length, 8)}`, down > 0 ? "OK" : "REFUSED");
          return down;
        },
        acquireToward: async (where) => {
          if (!this.port.purchaseTile || !input.mayPurchaseLand || !input.finance) return false;
          // Land for a service building is bought rarely: one tile per BIG_SERVICE_LAND_COOLDOWN_HOURS, and never for a landfill (its notices hang all over the
          // city, so "toward the icons" means nothing, and it only needs a lot away from homes). Live 2026-10-06: 7 tiles in 3 minutes, 690k of 744k gone.
          // Land is the first answer when there is none free (the cash is there): a garbage plant needs a lot away from homes, so the land comes first, and only not
          // while the player holds expansion (autonomy, no growth: no land is bought then). The cooldown below keeps it to one tile per spell (live 2026-10-06: 7 in 3 minutes).
          if (input.careOnly) { notes.push(`big service ${prefab}: no site away from homes, and land is not bought while expansion is held`); return false; }
          const boughtStamp = this.#stamp(this.#cycles);
          if (this.#bigLandBoughtAt && !stampElapsed(this.#bigLandBoughtAt, boughtStamp, BIG_SERVICE_LAND_COOLDOWN_HOURS, BIG_SERVICE_LAND_COOLDOWN_CYCLES)) {
            notes.push(`big service ${prefab}: land for a service was bought lately; waiting before another tile`); return false;
          }
          const owned = world.ownedTiles.filter((tile) => tile.owned).length;
          if (!landPurchaseRunwayAffordable({ ...input.finance, ownedTiles: owned, tileUpkeep: this.#costs?.tileUpkeep ?? null, monthlyExpenses: this.#costs?.monthlyExpenses ?? null,
            observedMarginalUpkeep: this.#observedMarginalTileUpkeep, requiredCash: expansionCashRequired(input.finance.monthlyBalance) })) { notes.push(`big service ${prefab}: land is needed, but the cash does not carry its upkeep (P8)`); return false; }
          this.#bigLandBoughtAt = boughtStamp;
          const next = nextTileCandidates(world).sort((left, right) => length(left, where) - length(right, where))[0];
          if (!next || tiles.length === 0) return false;
          const result = await this.port.purchaseTile(next, signal);
          notes.push(`big service ${prefab}: the tile at (${next.x.toFixed(0)},${next.z.toFixed(0)}) ${result.ok ? "bought toward the icons (the building needs room)" : `not sold (${result.detail.slice(0, 60)})`}`);
          if (result.ok) this.#frontageDirty = true;
          return result.ok;
        },
      }, { prefab, target: street, refusedSites: this.#bigRefused }, notes, signal);
      if (this.#bigRefused.length > 200) this.#bigRefused.splice(0, this.#bigRefused.length - 200);
      if (outcome.status === "PLACED") return true;
    }
    return false;
  }

  /** Place a service building and read it back: one more of that prefab must stand than before. */
  async #placeService(utilities: DistrictUtilitiesPort, prefab: string, position: SpatialPoint2, rotation: number, standingBefore: number, signal?: AbortSignal): Promise<"STANDS" | "UNCONFIRMED" | "FAILED"> {
    const outcome = await utilities.place(prefab, position, rotation, signal);
    if (!outcome.ok) return "FAILED";
    let after = await utilities.listFacilities(prefab, signal);
    let placed = after.find((facility) => Math.hypot(facility.position.x - position.x, facility.position.z - position.z) < 12);
    // A building the game accepted may take a moment to be listed: one more read before it is called missing (live 2026-10-06: "placed but not read back").
    if (!placed && after.length <= standingBefore && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      after = await utilities.listFacilities(prefab, signal);
      placed = after.find((facility) => Math.hypot(facility.position.x - position.x, facility.position.z - position.z) < 12);
    }
    // Remember it as this builder's own, so a service that never gets a road (every road refused by the game) can be taken down again.
    if (placed) this.#ownFacilities.set(`${placed.entity.index}:${placed.entity.version}`, { ...placed.entity, position: placed.position, prefab });
    return placed !== undefined || after.length > standingBefore ? "STANDS" : "UNCONFIRMED";
  }

  /**
   * THE EXPERIMENT (the user allowed it on 2026-10-04): no legal lot for a wanted service, so bulldoze ONE low-density home near the
   * icons and place the service on its lot. Never a service, park or anything but a low-density home; once per process; every step is
   * reported, and the lot is read back to be free before the service is placed.
   */
  async #demolishHomeForService(utilities: DistrictUtilitiesPort, need: ServiceNeed, prefabs: readonly string[], target: SpatialPoint2,
    nearestStreet: (point: SpatialPoint2) => SpatialPoint2 | null, standingBefore: number, notes: string[], signal?: AbortSignal): Promise<boolean> {
    if (!utilities.remove) { notes.push(`service ${need}: no legal lot, and this host cannot demolish`); return false; }
    const detail = await this.port.siteDetail(target, 240, 32, signal);
    const homes = (detail?.buildings ?? []).filter((building) => /Residential.*Low|ResidentialLow/i.test(building.prefab) && !/Medium|High|Mixed/i.test(building.prefab))
      .map((building) => ({ building, distance: Math.hypot(building.position.x - target.x, building.position.z - target.z) }))
      .sort((left, right) => left.distance - right.distance);
    const chosen = homes.find((entry) => protection.circle({ x: entry.building.position.x, z: entry.building.position.z }) === null)?.building;
    if (!chosen) { notes.push(`service ${need}: no legal lot, and no low-density home near the icons to clear`); return false; }
    this.#serviceDemolitions += 1;
    const at = { x: chosen.position.x, z: chosen.position.z };
    const removed = await utilities.remove(chosen.entity, signal);
    notes.push(`EXPERIMENT service ${need}: bulldozed ${chosen.prefab} at (${at.x.toFixed(0)},${at.z.toFixed(0)}) ${removed ? "— gone" : "— refused"}`);
    if (!removed) return false;
    const street = nearestStreet(at);
    const rotation = street ? civicRotationToward(at, street) : 0;
    for (const prefab of prefabs) {
      for (const [dx, dz] of [[0, 0], [-10, 0], [10, 0], [0, -10], [0, 10]] as const) {
        const position = { x: at.x + dx, z: at.z + dz };
        if ((await utilities.preflight(prefab, position, rotation, signal)) !== true) continue;
        const stands = await this.#placeService(utilities, prefab, position, rotation, standingBefore, signal);
        notes.push(`EXPERIMENT service ${need}: ${prefab} on the cleared lot — ${stands ? "stands (read back)" : "placed but not read back"}`);
        if (stands) return true;
      }
    }
    notes.push(`EXPERIMENT service ${need}: the lot was cleared but no service could be placed on it`);
    return false;
  }

  /**
   * A neighbourhood of city streets that joins the main network nowhere (a district whose gateway landed on a highway, or
   * whose gateway the world refused) is a broken road: no water, no power, no way in. Join it to the nearest street of the
   * main network by a short road, or report that it could not be joined.
   */
  async reconnectOrphans(world: Pick<SpatialWorldModel, "roadGraph">, buildings: readonly SpatialPoint2[], notes: string[], signal?: AbortSignal): Promise<number> {
    const network = mainStreetNetwork(world.roadGraph);
    let joined = 0;
    for (const orphan of network.components.filter((component) => component !== network.main)) {
      if (signal?.aborted) break;
      const streets = orphan.edges.filter((edge) => !NOT_A_CITY_STREET.test(edge.prefab));
      if (streets.length < ORPHAN_STUB_MAXIMUM_STREETS + 1) continue; // stubs are removed, not joined
      const orphanNodes = new Set(streets.flatMap((edge) => [key(edge.startNode), key(edge.endNode)]));
      let best: { from: SpatialPoint2; to: SpatialPoint2; meters: number } | null = null;
      for (const node of orphan.nodes.filter((candidate) => orphanNodes.has(key(candidate.entity)))) {
        for (const target of network.nodes) {
          const meters = length(node.position, target.position);
          if (!best || meters < best.meters) best = { from: { x: target.position.x, z: target.position.z }, to: { x: node.position.x, z: node.position.z }, meters };
        }
      }
      if (!best) continue;
      if (best.meters < 12 || best.meters > MAXIMUM_GATEWAY_METERS) {
        notes.push(`orphan network of ${streets.length} streets is ${best.meters.toFixed(0)} m from the main network, not joined`);
        continue;
      }
      if (buildings.some((point) => pointSegmentDistance(point, best!.from, best!.to) < 10)) { notes.push("orphan network: the joining road would cross a building, not joined"); continue; }
      const outcome = await this.#buildOwned({ start: best.from, end: best.to }, DISTRICT_ROAD_PREFAB, signal);
      notes.push(`orphan network of ${streets.length} streets joined to the main network by ${best.meters.toFixed(0)} m: ${outcome.ok ? "built" : `refused ${outcome.detail.slice(0, 80)}`}`);
      if (outcome.ok) joined += 1;
    }
    return joined;
  }

  /**
   * Corrects the mix of land uses from what the world shows, without demolishing anything:
   *  - frontage beside a street that nobody has zoned is zoned by the world-corrected target (shops and offices where the
   *    game asks for them and the city has few, homes otherwise), commercial nearest the junctions where customers pass;
   *  - zoning that was painted as homes and still stands EMPTY is repainted as shops or offices when the city is short of
   *    those and long on unrealised housing. Empty zoning costs nothing and holds no one, so changing it destroys nothing.
   * Discover existing streets once, then scan new Mayor streets; paint in bounded batches.
   */
  async zoneUnzonedFrontage(world: Pick<SpatialWorldModel, "ownedTiles" | "roadGraph">, role: DistrictRole, landUse: DistrictLandUse, input: DistrictCycleInput, notes: string[]): Promise<number> {
    const signal = input.signal;
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    if (tiles.length === 0) return 0;
    // Discover existing city streets on the first pass. Later passes only read windows near new Mayor roads or unfinished frontage.
    const frontageCourses = this.#frontageInitialScan
      ? world.roadGraph.edges.filter((edge) => !edge.deleted && !edge.temp).map((edge) => ({ start: edge.start, end: edge.end }))
      : this.#ownCourses.slice(this.#frontageCourseCursor);
    if (!this.#frontageDirty || frontageCourses.length === 0) {
      notes.push("unzoned frontage: not swept (no new Mayor road frontage)");
      return 0;
    }
    this.#frontageDirty = false;
    const bounds = tiles.reduce((acc, tile) => ({
      minX: Math.min(acc.minX, tile.bounds!.min.x), minZ: Math.min(acc.minZ, tile.bounds!.min.z),
      maxX: Math.max(acc.maxX, tile.bounds!.max.x), maxZ: Math.max(acc.maxZ, tile.bounds!.max.z),
    }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
    const fresh = new Map<string, { x: number; z: number; count: number }>();
    const emptyHomes = new Map<string, { x: number; z: number; count: number }>();
    // Every cell that holds a building, of any land use: a brush must never reach one (see `safeBrushRadius`).
    const occupiedPoints: SpatialPoint2[] = [];
    const bin = (map: Map<string, { x: number; z: number; count: number }>, position: SpatialPoint2) => {
      const keyOf = `${Math.floor(position.x / ZONE_SPOT_SPACING_METERS)},${Math.floor(position.z / ZONE_SPOT_SPACING_METERS)}`;
      const entry = map.get(keyOf) ?? { x: 0, z: 0, count: 0 };
      entry.x += position.x; entry.z += position.z; entry.count += 1;
      map.set(keyOf, entry);
    };
    const step = UNZONED_SCAN_WINDOW_METERS * 1.4;
    for (let cx = bounds.minX + UNZONED_SCAN_WINDOW_METERS / 2; cx < bounds.maxX + step / 2; cx += step) {
      for (let cz = bounds.minZ + UNZONED_SCAN_WINDOW_METERS / 2; cz < bounds.maxZ + step / 2; cz += step) {
        if (signal?.aborted) return 0;
        // No road in this window means no roadside frontage to sweep. The local read before every brush write remains fresh.
        const window = { minX: cx - UNZONED_SCAN_WINDOW_METERS, minZ: cz - UNZONED_SCAN_WINDOW_METERS,
          maxX: cx + UNZONED_SCAN_WINDOW_METERS, maxZ: cz + UNZONED_SCAN_WINDOW_METERS };
        if (!frontageCourses.some((course) => segmentTouchesRect(course.start, course.end, window))) continue;
        const detail = await this.port.siteDetail({ x: cx, z: cz }, UNZONED_SCAN_WINDOW_METERS, 16, signal);
        for (const cell of detail?.zoningCells ?? []) {
          if (cell.occupied) occupiedPoints.push({ x: cell.position.x, z: cell.position.z });
          if (!cell.visible || !cell.roadside || cell.occupied || cell.blocked) continue;
          if (!tiles.some((tile) => pointInTile(cell.position, tile))) continue;
          if (cell.zoneCategory === undefined || cell.zoneCategory === "none") bin(fresh, cell.position);
          else if (cell.zoneCategory === "residential") bin(emptyHomes, cell.position);
        }
      }
    }
    const mix = this.#mix;
    const deficits = mixDeficits(mix, this.#available);
    // Shops go nearest the junctions, where customers and traffic meet; homes take what is left inside.
    const junctions = mainStreetNetwork(world.roadGraph).nodes
      .filter((node) => node.roadDegree >= 3).map((node) => ({ x: node.position.x, z: node.position.z }));
    const junctionDistance = (point: SpatialPoint2) => junctions.length === 0 ? 0 : Math.min(...junctions.map((junction) => length(junction, point)));
    const toSpots = (map: Map<string, { x: number; z: number; count: number }>) => [...map.values()].map((entry) => ({ x: entry.x / entry.count, z: entry.z / entry.count }))
      .map((point) => ({ point, junction: junctionDistance(point) })).sort((left, right) => left.junction - right.junction);
    // Isolation does not depend on the district's own role: a commercial or office sweep zones homes too, and a home is never zoned within
    // RESIDENTIAL_POLLUTER_BUFFER_METERS of industry (live 2026-10-05: about 310 homes grew within 320 m of industry on frontage zoned under another role,
    // and 250 more inside commercial districts; 127 noise notices). Industry keeps INDUSTRIAL_RESIDENTIAL_BUFFER_METERS from homes as before.
    const homesAway = { points: landUse.polluters, meters: RESIDENTIAL_POLLUTER_BUFFER_METERS, also: [{ points: landUse.loud ?? [], meters: RESIDENTIAL_LOUD_BUFFER_METERS }] };
    const industryAway = { points: landUse.sensitive, meters: INDUSTRIAL_RESIDENTIAL_BUFFER_METERS };
    // A lot kept open for a public service is not "unzoned frontage" to be filled in.
    const freshSpots = toSpots(fresh).filter((spot) => !this.#reservedLots.some((lot) => Math.hypot(spot.point.x - lot.center.x, spot.point.z - lot.center.z) < lot.radius));
    const painted: Record<string, number> = {};
    // `total` is the spot budget spent (brushes planned); `written` is what the world accepted.
    let total = 0;
    let written = 0;
    let skippedNearBuildings = 0;
    const queued: Array<{ category: ZoneCategory; brush: ZoningBrush }> = [];
    const paint = async (category: ZoneCategory, spots: Array<{ point: SpatialPoint2 }>) => {
      const zone = input.zoneFor(category, this.#densityOf(category, input));
      if (!zone || spots.length === 0) return;
      for (const spot of spots) {
        if (signal?.aborted || total >= UNZONED_SPOTS_PER_CYCLE) break;
        // The brush paints every cell in its disk, occupied or not, and a building whose zone changes is condemned. Measured
        // live (2026-10-03): repainting empty housing with the full brush condemned 194 buildings beside it.
        const radius = safeBrushRadius(spot.point, occupiedPoints);
        if (radius === null) { skippedNearBuildings += 1; continue; }
        queued.push({ category, brush: { zone, center: spot.point, radius } });
        total += 1;
      }
    };
    // The sweep read the ground window by window, and the world runs while the Mayor works (a house can grow between the read and the write: measured
    // live 2026-10-04, an office brush 16 m from a house that was not in the sweep's list condemned it). So nothing is written from the sweep's own
    // list: each group of brushes is admitted against a fresh read of the ground just before it is written (`#admitAgainstWorld`).
    const flush = async () => {
      if (queued.length === 0) return;
      const batch = queued.splice(0, queued.length);
      const admission = await this.#admitAndWrite(batch.map((entry) => entry.brush), signal);
      skippedNearBuildings += admission.dropped.length;
      // The admitted brushes keep their zone and centre; they are matched back to their category by those.
      const categoryOf = new Map(batch.map((entry) => [`${entry.brush.zone}@${entry.brush.center.x},${entry.brush.center.z}`, entry.category]));
      for (const brush of admission.written) {
        const category = categoryOf.get(`${brush.zone}@${brush.center.x},${brush.center.z}`) ?? "residential";
        painted[category] = (painted[category] ?? 0) + 1;
        written += 1;
      }
      if (admission.unread.length > 0) this.#frontageDirty = true;
    };
    // 1. Fresh frontage: split by the world-corrected deficits; the nearest-to-junction spots become shops, then offices.
    const allowedFresh: ZoneCategory[] = (role === "industrial" ? ["industrial"] as ZoneCategory[] : ["residential", "commercial", "office"] as ZoneCategory[]).filter((category) => this.#available.includes(category) && !this.#paused.includes(category));
    const freshAlloc = allocateByDeficit(freshSpots.length, deficits, allowedFresh);
    let cursor = 0;
    for (const category of ["commercial", "office", "residential", "industrial"] as const) {
      const slice = freshSpots.slice(cursor, cursor + freshAlloc[category]).filter((spot) => category === "industrial"
        ? !industryAway.points.some((other) => length(other, spot.point) < industryAway.meters)
        : category !== "residential" || !keepAwayBlocks(homesAway, (other) => length(other, spot.point)));
      cursor += freshAlloc[category];
      await paint(category, slice);
    }
    await flush();
    // 2. Empty housing zoning repainted as shops/offices while the city is short of them and long on unrealised homes.
    const rezoneStalled = this.#rezoneBefore !== null && mix.cells.residential.empty >= this.#rezoneBefore.empty * REZONE_PROGRESS_FLOOR && this.#rezoneBefore.painted > 0;
    if (rezoneStalled) { this.#rezoneUnsupported = true; notes.push("rezoning empty housing did not reduce it; not repeated"); }
    this.#rezoneBefore = null;
    const zonedTotal = ZONE_CATEGORIES.reduce((sum, category) => sum + mix.cells[category].zoned, 0);
    if (!this.#rezoneUnsupported && !input.intent?.role && unrealizedShare(mix, "residential") >= REZONE_MINIMUM_UNREALIZED_SHARE && emptyHomes.size > 0) {
      const caps = { commercial: Math.max(0, Math.ceil((deficits.commercial * zonedTotal) / REZONE_CELLS_PER_SPOT)), office: Math.max(0, Math.ceil((deficits.office * zonedTotal) / REZONE_CELLS_PER_SPOT)) };
      const spots = toSpots(emptyHomes).filter((spot) => !freshSpots.some((other) => length(other.point, spot.point) < 1));
      const room = Math.max(0, Math.min(spots.length, UNZONED_SPOTS_PER_CYCLE - total, caps.commercial + caps.office, Math.floor(spots.length * REZONE_MAXIMUM_SHARE_OF_EMPTY_HOMES)));
      const rezoneTo = (["commercial", "office"] as ZoneCategory[]).filter((category) => this.#available.includes(category) && !this.#paused.includes(category));
      const alloc = allocateByDeficit(rezoneTo.length === 0 ? 0 : room, deficits, rezoneTo.length === 0 ? ["commercial"] : rezoneTo);
      const counts = { commercial: Math.min(alloc.commercial, caps.commercial), office: Math.min(alloc.office, caps.office) };
      let at = 0;
      const before = (painted.commercial ?? 0) + (painted.office ?? 0);
      for (const category of ["commercial", "office"] as const) { await paint(category, spots.slice(at, at + counts[category])); at += counts[category]; }
      await flush();
      const rezoned = (painted.commercial ?? 0) + (painted.office ?? 0) - before;
      if (rezoned > 0) this.#rezoneBefore = { empty: mix.cells.residential.empty, painted: rezoned };
      if (rezoned > 0) notes.push(`rezoned ${rezoned} empty housing spots (${counts.commercial} commercial, ${counts.office} office)`);
    }
    if (skippedNearBuildings > 0) notes.push(`${skippedNearBuildings} spots left alone: a building stood within the brush`);
    if (written > 0) notes.push(`zoned ${written} spots: ${Object.entries(painted).map(([category, count]) => `${count} ${category}`).join(", ")}; mix target ${ZONE_CATEGORIES.map((category) => `${category[0]}${Math.round(targetShares(mix, this.#available)[category] * 100)}`).join("/")}`);
    // The spot budget ran out, or a brush was refused: more may be left for the next cycle.
    if (total >= UNZONED_SPOTS_PER_CYCLE || this.#pendingZoning.length > 0) this.#frontageDirty = true;
    if (!this.#frontageDirty) {
      this.#frontageCourseCursor = this.#ownCourses.length;
      this.#frontageInitialScan = false;
    }
    return written;
  }

  /**
   * Write brushes in short runs of `ZONING_WRITE_RUN`, a fresh read of the ground before each run (`#admitAgainstWorld`), neighbours in row order.
   * One read before a whole district is not enough: its brushes take a minute to write while the city runs, and a house that grows on the first
   * brushes' cells is repainted by the next brush of another land use (measured live 2026-10-04: a Medium Row house condemned 9 m from its own brush,
   * with a commercial brush 26 m away from the same district).
   */
  async #admitAndWrite(brushes: readonly ZoningBrush[], signal?: AbortSignal): Promise<{
    written: ZoningBrush[]; failed: Array<{ brush: ZoningBrush; detail: string }>; dropped: ZoningBrush[]; shrunk: number; unread: ZoningBrush[] }> {
    const result = { written: [] as ZoningBrush[], failed: [] as Array<{ brush: ZoningBrush; detail: string }>, dropped: [] as ZoningBrush[], shrunk: 0, unread: [] as ZoningBrush[] };
    const ordered = [...brushes].sort((left, right) => left.center.z - right.center.z || left.center.x - right.center.x);
    for (let at = 0; at < ordered.length; at += ZONING_WRITE_RUN) {
      if (signal?.aborted) { result.unread.push(...ordered.slice(at)); break; }
      const admission = await this.#admitAgainstWorld(ordered.slice(at, at + ZONING_WRITE_RUN), signal);
      result.dropped.push(...admission.dropped);
      result.unread.push(...admission.unread);
      result.shrunk += admission.shrunk;
      for (const brush of admission.admitted) {
        if (signal?.aborted) { result.unread.push(brush); continue; }
        const outcome = await this.port.zone(brush.zone, brush.center, brush.radius, signal);
        if (outcome.ok) result.written.push(brush); else result.failed.push({ brush, detail: outcome.detail });
      }
    }
    return result;
  }

  /**
   * Read the ground under these brushes now and admit only what clears it (`admitZoningBrushes`). A group whose read fails is not
   * written blind: it comes back as `unread`, for the caller to keep for later.
   */
  async #admitAgainstWorld(brushes: readonly ZoningBrush[], signal?: AbortSignal):
    Promise<{ admitted: ZoningBrush[]; shrunk: number; dropped: ZoningBrush[]; unread: ZoningBrush[] }> {
    const result = { admitted: [] as ZoningBrush[], shrunk: 0, dropped: [] as ZoningBrush[], unread: [] as ZoningBrush[] };
    for (const group of groupBrushesForReading(brushes)) {
      if (signal?.aborted) { result.unread.push(...group); continue; }
      const xs = group.map((brush) => brush.center.x);
      const zs = group.map((brush) => brush.center.z);
      const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
      const reach = Math.max(...group.map((brush) => Math.hypot(brush.center.x - center.x, brush.center.z - center.z) + brush.radius));
      // The MCP detail read takes radius 64-2048 and resolution 16-128; a building just outside a brush still counts (its lot reaches in).
      const detail = await this.port.siteDetail(center, Math.max(64, Math.min(2_048, reach + 32)), 16, signal).catch(() => null);
      if (!detail) { result.unread.push(...group); continue; }
      // "Don't rezone": a cell that already carries a zone counts like a building, so a brush shrinks away from it and only paints bare cells.
      const keepZoning = process.env.AI_MAYOR_KEEP_ZONING === "1";
      const occupied = mergeBuildingPoints(detail.buildings.map((building) => ({ x: building.position.x, z: building.position.z })),
        detail.zoningCells.filter((cell) => cell.occupied || (keepZoning && cell.zoneCategory !== undefined && cell.zoneCategory !== "none"))
          .map((cell) => ({ x: cell.position.x, z: cell.position.z })), this.#siteBuildings);
      const admission = admitZoningBrushes(group, occupied);
      result.admitted.push(...admission.admitted);
      result.dropped.push(...admission.dropped);
      result.shrunk += admission.shrunk;
    }
    return result;
  }

  /** The owned ground as a mask of free lattice cells, from one terrain read (kept for a few calls). Null when the ground cannot be read. */
  async #readLandMask(world: Pick<SpatialWorldModel, "roadGraph" | "ownedTiles">, buildings: readonly SpatialPoint2[], role: DistrictRole,
    landUse: DistrictLandUse, signal?: AbortSignal): Promise<{ mask: ReturnType<typeof buildLandMask>; buildings: SpatialPoint2[] } | null> {
    const tiles = world.ownedTiles.filter((tile) => tile.owned && tile.bounds);
    if (tiles.length === 0) return null;
    const bounds = tiles.reduce((acc, tile) => ({
      minX: Math.min(acc.minX, tile.bounds!.min.x), minZ: Math.min(acc.minZ, tile.bounds!.min.z),
      maxX: Math.max(acc.maxX, tile.bounds!.max.x), maxZ: Math.max(acc.maxZ, tile.bounds!.max.z),
    }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
    const centre = { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
    const radius = Math.min(2_048, Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 24);
    // The Bridge's 2048 m detail enumerates every zoning cell and took 57-60 s per tick in the contract live. Production
    // reads the small city-wide terrain grid for candidate search instead; the chosen site and every zoning brush still
    // get fresh local detail before writing. Terrain is static until a world change, which rebaseline clears.
    const groundKey = this.port.readPlanningTerrain ? "city-planning-terrain" : `${tiles.length}:${bounds.minX},${bounds.minZ},${bounds.maxX},${bounds.maxZ}`;
    this.#groundCalls += 1;
    let ground = this.#ground;
    if (!ground || ground.key !== groundKey || this.#groundCalls - ground.atCall > GROUND_READ_MAXIMUM_AGE_CALLS) {
      if (this.port.readPlanningTerrain) {
        const terrain = await this.port.readPlanningTerrain(signal);
        if (!terrain) return null;
        ground = { key: groundKey, atCall: this.#groundCalls, terrain, buildings: [] };
      } else {
        const detail = await this.port.siteDetail(centre, radius, 128, signal);
        if (!detail?.terrain) return null;
        ground = { key: groundKey, atCall: this.#groundCalls, terrain: detail.terrain,
          buildings: detail.buildings.map((building) => ({ x: building.position.x, z: building.position.z })) };
      }
      this.#ground = ground;
    }
    // Every role but industry may zone homes (a commercial district does), so every role but industry keeps clear of the polluters.
    const keepAway = role === "industrial" ? { points: landUse.sensitive, meters: this.#industrialBuffer() }
      : { points: landUse.polluters, meters: RESIDENTIAL_POLLUTER_BUFFER_METERS, also: [{ points: landUse.loud ?? [], meters: RESIDENTIAL_LOUD_BUFFER_METERS }] };
    // The Bridge lists at most 500 of a city's buildings (2,988-3,168 in the live saves), so a ground that is free by that list is not proven free.
    // This read of the owned ground names EVERY building in it.
    const known = mergeBuildingPoints(buildings, ground.buildings, this.#seenBuildings);
    return { buildings: known, mask: buildLandMask({ origin: districtLatticeOrigin(world), bounds, isOwned: (point) => tiles.some((tile) => pointInTile(point, tile)),
      terrain: ground.terrain, edges: world.roadGraph.edges, buildings: known, clearanceMeters: DISTRICT_CLEARANCE_METERS, keepAway }) };
  }

  /** Whether something that can leave frontage unzoned happened since the last sweep (see `zoneUnzonedFrontage`). Starts dirty. */
  #frontageDirty = true;
  #frontageInitialScan = true;
  #frontageCourseCursor = 0;
  /** The last whole-ground read kept for planning (see `#readLandMask`); forgotten when the world is loaded again. */
  #ground: { key: string; atCall: number; terrain: SpatialSiteDetail["terrain"]; buildings: SpatialPoint2[] } | null = null;
  #groundCalls = 0;

  /**
   * Streets that join nothing and serve nothing, removed the way a player bulldozes a dead stub. Highways, anything
   * with a building beside it, and any component large enough to be a neighbourhood are left alone.
   */
  /**
   * Prunes back the leftovers of a district that did not stand: streets THIS Mayor laid inside its area that now end in
   * nothing, one layer at a time (each round reads the world again). Streets of the world, the player or an earlier session
   * are never touched.
   */
  async pruneOwnFragments(area: { minX: number; minZ: number; maxX: number; maxZ: number }, notes: string[], signal?: AbortSignal): Promise<number> {
    if (!this.port.demolishRoad) return 0;
    let removed = 0;
    for (let round = 0; round < 8; round += 1) {
      if (signal?.aborted) break;
      const world = await this.port.scanWorld(signal);
      const live = world.roadGraph.edges.filter((edge) => !edge.deleted && !edge.temp);
      const degree = new Map<string, number>();
      for (const edge of live) for (const ref of [edge.startNode, edge.endNode]) degree.set(key(ref), (degree.get(key(ref)) ?? 0) + 1);
      const inside = (point: SpatialPoint2) => point.x >= area.minX && point.x <= area.maxX && point.z >= area.minZ && point.z <= area.maxZ;
      // A leaf is an own street with a free end inside the area; its other end may be a junction of the main network outside it.
      const leaves = live.filter((edge) => {
        if (NOT_A_CITY_STREET.test(edge.prefab) || !this.#isOwn(edge)) return false;
        const freeEnd = degree.get(key(edge.startNode)) === 1 ? edge.start : degree.get(key(edge.endNode)) === 1 ? edge.end : null;
        return freeEnd !== null && inside(freeEnd);
      });
      if (leaves.length === 0) break;
      for (const edge of leaves) if (await this.port.demolishRoad(edge.entity, signal)) removed += 1;
    }
    return removed;
  }

  /** The facilities this builder itself placed: the only buildings it may take down again. */
  #rememberOwn(placements: readonly DistrictUtilityPlacement[]): void {
    for (const placement of placements) {
      if (placement.entity) this.#ownFacilities.set(`${placement.entity.index}:${placement.entity.version}`, { ...placement.entity, position: placement.position, prefab: placement.prefab });
      // A costly plant left standing unattached (it is never taken down): its kind waits until it is joined.
      if (placement.attached === false) this.#highValue.stranded(placement.prefab, this.#stamp(this.#cycles));
    }
  }

  async #buildOwned(course: { start: SpatialPoint2; end: SpatialPoint2 }, prefab: string, signal?: AbortSignal) {
    const outcome = await this.port.buildRoad(course, prefab, signal);
    if (outcome.ok) this.markOwn(course);
    return outcome;
  }

  /** Record a street as laid by this Mayor (used by the builder itself and by tests). */
  markOwn(course: { start: SpatialPoint2; end: SpatialPoint2 }): void {
    this.#ownCourses.push({ start: { ...course.start }, end: { ...course.end } });
    this.#frontageDirty = true;
  }

  /** Whether a point stands beside a street this Mayor laid (a lot of a district it built). */
  #nearOwnStreet(point: SpatialPoint2, meters = 60): boolean {
    return this.#ownCourses.some((course) => pointSegmentDistance(point, course.start, course.end) <= meters);
  }

  /** Whether a street lies along one this Mayor laid: both its ends on one of those courses. */
  #isOwn(edge: Pick<SpatialRoadEdge, "start" | "end">): boolean {
    return this.#ownCourses.some((course) => pointSegmentDistance(edge.start, course.start, course.end) < OWN_COURSE_TOLERANCE_METERS &&
      pointSegmentDistance(edge.end, course.start, course.end) < OWN_COURSE_TOLERANCE_METERS);
  }

  async removeOrphanStubs(world: Pick<SpatialWorldModel, "roadGraph">, buildings: readonly SpatialPoint2[], notes: string[], signal?: AbortSignal): Promise<number> {
    if (!this.port.demolishRoad) return 0;
    let removed = 0;
    for (const component of roadComponents(world.roadGraph)) {
      if (component.streets > ORPHAN_STUB_MAXIMUM_STREETS) continue;
      if (component.edges.some((edge) => /highway|motorway|ramp|pipe|cable|sewer/i.test(edge.prefab))) continue;
      // Only what this Mayor laid: a stub-shaped road of the map, the player or an earlier session is a world asset.
      if (!component.edges.every((edge) => this.#isOwn(edge))) continue;
      if (component.edges.some((edge) => buildings.some((point) => pointSegmentDistance(point, edge.start, edge.end) < ORPHAN_STUB_BUILDING_CLEARANCE_METERS))) continue;
      for (const edge of component.edges) {
        if (signal?.aborted) return removed;
        if (await this.port.demolishRoad(edge.entity, signal)) removed += 1;
      }
    }
    if (removed > 0) notes.push(`removed ${removed} orphan stub street(s)`);
    return removed;
  }

  /**
   * A utility the city is already short of (not one a new district would leave short): one facility beside the served
   * network, nearest the homes, read back for its connection. This is what a player does the moment the utility panel
   * turns red, and it needs no district — the Goal path used to be the only way, and it waits on durable matchers.
   */
  async repairUtilities(input: { kinds: readonly DistrictUtilityKind[]; shortfalls: Partial<Record<DistrictUtilityKind, number>>; signal?: AbortSignal }):
    Promise<{ placed: DistrictUtilityPlacement[]; notes: string[] }> {
    const notes: string[] = [];
    const port = this.#utilitiesWithAccessCheck();
    this.#repairCalls += 1;
    // Called alone (not through `runCycle`) the clock may not have been read this cycle: read it, it is one cheap call.
    await this.#readClock(input.signal);
    const repairStamp = this.#stamp(this.#repairCalls);
    // A facility placed now shows in the utility reading only after the city has run, so the same shortage is read again
    // next cycle. One attempt per utility, then wait for the world to answer (measured: 3 outlets in 3 cycles). The wait is game time
    // (`UTILITY_REPAIR_COOLDOWN_HOURS`): a cycle is no longer a game hour, so 3 calls would be minutes of the city's time.
    const kinds = input.kinds.filter((kind) => this.#repairCooledDown(kind, repairStamp));
    if (kinds.length < input.kinds.length) notes.push(`utility repair: ${input.kinds.filter((kind) => !kinds.includes(kind)).join(", ")} already attempted, waiting for the city to answer`);
    if (!port || kinds.length === 0) return { placed: [], notes };
    for (const kind of kinds) this.#repairedAt.set(kind, repairStamp);
    try {
      const world = await this.port.scanWorld(input.signal);
      const listed = await this.port.listBuildings(input.signal);
      const homes = listed.filter((building) => classifyBuilding(building.prefab) === "sensitive").map((building) => building.position);
      const component = mainStreetNetwork(world.roadGraph);
      if (component.edges.length === 0) { notes.push("utility repair: no served network to carry a facility"); return { placed: [], notes }; }
      const target = centreOf(homes) ?? centreOf(component.nodes.map((node) => ({ x: node.position.x, z: node.position.z })))!;
      const detail = await this.port.siteDetail(target, DISTRICT_WATER_REACH_METERS, 128, input.signal);
      const avoid = lotsToAvoid(detail);
      const placed: DistrictUtilityPlacement[] = [];
      for (const kind of kinds) {
        if (input.signal?.aborted) break;
        // The shortage is an effect to realize, searched across every candidate the world offers (not the first few), with several
        // facilities if one is not enough (`realizeUtilityShortfall`).
        const realization = await realizeUtilityShortfall(port, { kind, shortfall: input.shortfalls[kind] ?? 1, target,
          edges: component.edges, ...(detail?.terrain ? { terrain: detail.terrain } : {}), avoid, siting: { city: target, homes },
          placementMemory: { refused: this.#refusedPlacements, cycle: this.#stamp(this.#cycles) }, ...(input.signal ? { signal: input.signal } : {}) }, notes);
        this.#rememberOwn(realization.placements);
        placed.push(...realization.placements);
        // Every candidate was searched and none can stand: waiting for it would only hold the city's zoning for nothing (see the zoning hold).
        // No outlet can stand and the sewage is a real shortage (572 overflow icons at 27,000 people, 2026-10-07): the treatment plant is bought with development
        // points, and the next look offers it (once per process: a refused purchase is not asked every cycle).
        if (kind === "sewage" && realization.exhausted && realization.placements.length === 0 && REAL_CAPACITY_SHORTFALL(input.shortfalls[kind] ?? 1) && this.port.techTree && !this.#treatmentPlantAsked) {
          this.#treatmentPlantAsked = true;
          const bought = await unlockPrefabs(this.port.techTree, [{ prefab: "WastewaterTreatmentPlant01", category: "building" as const }], "sewage treatment", notes, undefined, input.signal);
          if (bought.status === "BOUGHT") { this.#treatmentPlantAsked = false; this.#repairedAt.delete(kind); }
        }
        if (realization.exhausted && realization.placements.length === 0) this.#utilityExhausted.add(kind); else this.#utilityExhausted.delete(kind);
      }
      return { placed, notes };
    } catch (error) {
      notes.push(`utility repair: ${error instanceof Error ? error.message.slice(0, 160) : "failed"}`);
      return { placed: [], notes };
    }
  }

  /**
   * Water, power and sewage for the district just laid. The projected load is the city's own consumption per building
   * scaled to the district's zoned lots; a utility that load would leave short gets one facility beside a street of the
   * component the district joined, and its connector is read back. A failure here never undoes the district.
   */
  async #provideUtilities(site: DistrictSite, input: DistrictCycleInput, buildingCount: number, notes: string[]): Promise<DistrictUtilityPlacement[]> {
    const port = this.#utilitiesWithAccessCheck();
    const readings = input.utilities;
    if (!port || !readings || buildingCount <= 0) return [];
    this.#repairCalls += 1;
    const repairStamp = this.#stamp(this.#repairCalls);
    const zonedCells = districtZonedCells(site.widthMeters, site.heightMeters);
    const shortfalls = DISTRICT_UTILITY_KINDS.map((kind) => {
      const projected = projectDistrictLoad({ zonedCells, buildingCount, consumption: readings[kind].consumption });
      // A city with no load yet has nothing to scale from, but a utility with no spare capacity at all cannot carry a
      // district either: provision one facility rather than read "no consumption" as "no need".
      const bootstrap = projected === 0 && readings[kind].headroom !== null && readings[kind].headroom! <= 0 ? 1 : 0;
      // P7: FAST_EXPANSION keeps capacity at a margin over the peak (a shortage hits companies and residents; a surplus is cheap).
      return { kind, shortfall: Math.max(bootstrap, districtUtilityShortfall(readings[kind], projected, input.pipelined ? UTILITY_HEADROOM_FACTOR : 1)) };
    }).filter((entry) => entry.shortfall > 0)
      // A facility placed by a repair (or the previous district) has not shown in the reading yet: do not place it twice.
      .filter((entry) => this.#repairCooledDown(entry.kind, repairStamp));
    if (shortfalls.length === 0) {
      notes.push("utilities: the district's projected load fits the headroom the city has");
      return [];
    }
    const center = { x: site.anchor.x + site.widthMeters / 2, z: site.anchor.z + site.heightMeters / 2 };
    try {
      // The district's streets exist now; read them back to find the component it joined.
      const world = await this.port.scanWorld(input.signal);
      const component = mainStreetNetwork(world.roadGraph);
      if (component.edges.length === 0) { notes.push("utilities: no served network near the district to carry a facility"); return []; }
      const detail = await this.port.siteDetail(center, DISTRICT_WATER_REACH_METERS, 128, input.signal);
      const avoid = lotsToAvoid(detail);
      // Where people live: a thermal plant is sited against it (downwind, away from homes).
      const homes = (await this.port.listBuildings(input.signal)).filter((building) => classifyBuilding(building.prefab) === "sensitive").map((building) => building.position);
      const placed: DistrictUtilityPlacement[] = [];
      for (const entry of shortfalls) {
        if (input.signal?.aborted) break;
        const realization = await realizeUtilityShortfall(port, { kind: entry.kind, shortfall: entry.shortfall, target: center,
          edges: component.edges, ...(detail?.terrain ? { terrain: detail.terrain } : {}), avoid, siting: { city: centreOf(homes) ?? center, homes },
          placementMemory: { refused: this.#refusedPlacements, cycle: this.#stamp(this.#cycles) }, excludedAround: this.#accessFailedSites, ...(input.signal ? { signal: input.signal } : {}) }, notes);
        this.#repairedAt.set(entry.kind, repairStamp);
        this.#rememberOwn(realization.placements);
        placed.push(...realization.placements);
      }
      return placed;
    } catch (error) {
      notes.push(`utilities: ${error instanceof Error ? error.message.slice(0, 160) : "failed"}`);
      return [];
    }
  }

  async #retryWithAnotherGateway(plan: DistrictPlan, terrain: SpatialLocalTerrain | undefined, role: DistrictRole, input: DistrictCycleInput, notes: string[],
    world: Pick<SpatialWorldModel, "roadGraph">): Promise<{ plan: DistrictPlan; result: DistrictCycleResult } | null> {
    if (!input.pipelined || !this.port.preflightRoad) return null;
    const refused = plan.site.gateway;
    const same = (a: DistrictSite["gateway"]) => length(a.from, refused.from) < 1 && length(a.to, refused.to) < 1;
    const options = (plan.site.alternativeGateways ?? []).filter((option) => !same(option) && option.lengthMeters >= 1);
    let asked = 0;
    for (const option of options) {
      if (asked >= GATEWAY_DRY_RUN_RETRIES || input.signal?.aborted) break;
      asked += 1;
      let verdict = "ERROR";
      try { verdict = await this.port.preflightRoad({ start: option.from, end: option.to }, DISTRICT_ROAD_PREFAB, input.signal); } catch { /* undecided */ }
      if (verdict !== "OK") continue;
      const next = compileDistrict({ ...plan.site, gateway: option, alternativeGateways: [] }, terrain);
      if (!next) continue;
      notes.push(`gateway: the shortest way in was refused; another (${option.from.x.toFixed(0)},${option.from.z.toFixed(0)})→(${option.to.x.toFixed(0)},${option.to.z.toFixed(0)}), ` +
        `${option.lengthMeters.toFixed(0)} m, certified by the dry run after ${asked} tr${asked === 1 ? "y" : "ies"}`);
      return { plan: next, result: await this.#buildDistrict(next, role, input, notes, world) };
    }
    notes.push(`gateway: ${asked} other way(s) in put to the dry run, none certified`);
    return null;
  }

  async #buildDistrict(plan: DistrictPlan, role: DistrictRole, input: DistrictCycleInput, notes: string[], world: Pick<SpatialWorldModel, "roadGraph">): Promise<DistrictCycleResult> {
    const signal = input.signal;
    const connected: Array<{ start: SpatialPoint2; end: SpatialPoint2 }> = [{ start: plan.site.gateway.from, end: plan.site.gateway.from }];
    const settled = new Set<string>();
    const pending: DistrictCourse[] = [...plan.courses];
    let roadsBuilt = 0;
    let roadsRefused = 0;
    let roadsLanded = 0;
    let gatewayRefused = false;
    // The road pipeline, stage by stage (proposed → eligible → submitted → accepted → landed), measured in streets AND metres:
    // a refused street is halved and the halves are submitted on their own, so counts of landed pieces are not a share of the
    // planned streets. Completeness is landed metres over planned metres.
    const pipeline = { proposed: plan.courses.length, proposedMeters: plan.courses.reduce((sum, course) => sum + course.lengthMeters, 0),
      submitted: 0, prefiltered: 0, gated: 0, accepted: 0, landed: 0, landedMeters: 0, refused: 0, reasons: new Map<string, number>() };
    const streets = streetSegments(world.roadGraph);
    // Go or no-go before the first street: the game's dry run of every planned street (a refused one halved once, as the build would), read as
    // the share of street length that would stand. Below the share a district needs, nothing is laid. Measured live 2026-10-06 (13.9k city, a wet
    // stretch): four cycles each laid 2-3 streets there and pruned them again (33-50% stood) — roads that appear and vanish. Each street is still
    // asked again just before it is built (the ring laid first changes what the next one meets).
    if (input.pipelined && this.port.preflightRoad) {
      const ask = async (course: { start: SpatialPoint2; end: SpatialPoint2 }) => {
        try { return await this.port.preflightRoad!(course, DISTRICT_ROAD_PREFAB, signal); } catch { return "ERROR"; }
      };
      let asked = 0;
      let gatewayVerdict: string | null = null;
      const certifiedPieces: DistrictCourse[] = [];
      for (const course of plan.courses) {
        if (signal?.aborted) break;
        const verdict = await ask(course);
        asked += 1;
        if (course.kind === "GATEWAY") gatewayVerdict = verdict;
        if (!verdict.startsWith("REJECT")) { certifiedPieces.push(course); continue; }
        if (course.kind === "GATEWAY") break;
        for (const half of splitCourse(course)) {
          asked += 1;
          if (!(await ask(half)).startsWith("REJECT")) certifiedPieces.push(half);
        }
      }
      // Only what joins up counts: the build lays a street once it touches what already stands, so a certified piece cut off by refused ones
      // never gets laid (measured live: a site certified piece by piece still stood at 33%). The same walk as the build, over the certified pieces.
      const reached: Array<{ start: SpatialPoint2; end: SpatialPoint2 }> = [{ start: plan.site.gateway.from, end: plan.site.gateway.from }];
      const walked = new Set<string>();
      let certifiedMeters = 0;
      for (let piece = nextConnectedCourse(certifiedPieces, reached, walked); piece; piece = nextConnectedCourse(certifiedPieces, reached, walked)) {
        walked.add(piece.id);
        reached.push({ start: piece.start, end: piece.end });
        certifiedMeters += piece.lengthMeters;
      }
      const share = certifiedMeters / Math.max(1, pipeline.proposedMeters);
      if (gatewayVerdict?.startsWith("REJECT") || share < MINIMUM_LANDED_SHARE) {
        const gateway = gatewayVerdict?.startsWith("REJECT") === true;
        notes.push(gateway
          ? `gateway refused by the dry run: ${gatewayVerdict!.replace(/^REJECT:/, "").slice(0, 80)}`
          : `district (${plan.site.anchor.x.toFixed(0)},${plan.site.anchor.z.toFixed(0)}): the dry run certifies ${Math.round(share * 100)}% of its street length ` +
            `(${asked} asked), below the ${Math.round(MINIMUM_LANDED_SHARE * 100)}% a district needs — nothing laid`);
        notes.push(`road pipeline: ${pipeline.proposed} streets proposed (${Math.round(pipeline.proposedMeters)} m) → 0 submitted (the dry run certified ` +
          `${Math.round(share * 100)}% of the length before any build${gateway ? ", not the gateway" : ""}) → 0 accepted → 0 landed`);
        return { status: "BUILT", site: plan.site, role, roadsBuilt: 0, roadsRefused: 0, roadsLanded: 0, zonesPainted: 0, zonesRefused: 0, zonesDeferred: 0,
          plannedCourses: plan.courses.length, notes, ...(gateway ? { gatewayRefused: true } : {}) };
      }
    }
    for (let course = nextConnectedCourse(pending, connected, settled); course;
      course = nextConnectedCourse(pending, connected, settled)) {
      if (signal?.aborted) break;
      settled.add(course.id);
      const features = roadAttemptFeatures(course, streets);
      this.options.outcomes?.annotate({ district: anchorKey(plan.site.anchor), course: course.id, kind: course.kind, splitDepth: course.id.split(".").length - 1, ...features });
      // FAST_EXPANSION asks the game first: its own read-only dry run of this street (nothing is built). Measured live
      // (2026-10-04, 40 streets): the dry run and the real build agreed 40 of 40, with the same refusal reason. Only a street the
      // dry run certifies is submitted; a refused one is halved exactly as a refused build would be. A dry run that errors or is
      // busy decides nothing: the street is submitted as before. LIVE_REVALIDATION_PENDING (one world, one session).
      if (input.pipelined && this.port.preflightRoad) {
        const startedAt = Date.now();
        let verdict = "ERROR";
        try { verdict = await this.port.preflightRoad(course, DISTRICT_ROAD_PREFAB, signal); } catch { /* fail open */ }
        this.options.outcomes?.annotate({ preflight: verdict });
        if (verdict.startsWith("REJECT")) {
          pipeline.gated += 1;
          roadsRefused += 1;
          pipeline.refused += 1;
          const why = verdict.replace(/^REJECT:/, "");
          pipeline.reasons.set(`dry run: ${why}`, (pipeline.reasons.get(`dry run: ${why}`) ?? 0) + 1);
          this.options.outcomes?.record({ primitive: "ROAD", context: roadContext(course, DISTRICT_ROAD_PREFAB), ok: false, detail: `GATED ${why}`, latencyMs: Date.now() - startedAt });
          notes.push(`${course.id} refused by the dry run: ${why.slice(0, 80)}`);
          if (course.kind === "GATEWAY") { gatewayRefused = true; break; }
          pending.push(...splitCourse(course));
          continue;
        }
      } else if (isStraightContinuationOfDeadEnd(features)) {
        // Without a dry run: a street the game is certain to refuse is not submitted (the player would see an attempt that cannot succeed).
        pipeline.prefiltered += 1;
        if (this.options.outcomes) {
          if (this.port.preflightRoad) { try { this.options.outcomes.annotate({ preflight: await this.port.preflightRoad(course, DISTRICT_ROAD_PREFAB, signal) }); } catch { /* diagnostics */ } }
          this.options.outcomes.record({ primitive: "ROAD", context: roadContext(course, DISTRICT_ROAD_PREFAB), ok: false, detail: "PREFILTERED_STRAIGHT_CONTINUATION", latencyMs: 0 });
        }
        notes.push(`${course.id} not submitted: one block straight on from a dead end (the game folds it back)`);
        continue;
      }
      pipeline.submitted += 1;
      const outcome = await this.#buildOwned(course, DISTRICT_ROAD_PREFAB, signal);
      if (outcome.ok) { pipeline.accepted += 1; streets.push({ start: course.start, end: course.end }); }
      if (!outcome.ok) {
        roadsRefused += 1;
        pipeline.refused += 1;
        const reason = refusalReason(outcome.detail);
        pipeline.reasons.set(reason, (pipeline.reasons.get(reason) ?? 0) + 1);
        notes.push(`${course.id} refused: ${outcome.detail.match(/"errorType":"([A-Za-z]+)"/g)?.slice(-1)[0] ?? outcome.detail.slice(0, 120)}`);
        // Without its gateway the district joins nothing; stop before laying anything.
        if (course.kind === "GATEWAY") { gatewayRefused = true; break; }
        // A street stops where the ground does. Measured live: a ring line refused `InWater` for a narrow stream the
        // terrain read missed, while its first 200 m certified. Halve a refused line at a lattice point and lay the
        // halves that still touch the network, down to one block.
        pending.push(...splitCourse(course));
        continue;
      }
      roadsBuilt += 1;
      // Read the street back before the next one is laid on it.
      const mid = { x: (course.start.x + course.end.x) / 2, z: (course.start.z + course.end.z) / 2 };
      // The MCP detail read takes radius 64-2048 and resolution 16-128; anything smaller is refused, not shrunk.
      const readback = await this.port.siteDetail(mid, Math.max(64, Math.min(400, course.lengthMeters / 2 + 24)), 16, signal);
      if (courseLanded(readback, course)) {
        roadsLanded += 1;
        pipeline.landed += 1;
        pipeline.landedMeters += course.lengthMeters;
        connected.push({ start: course.start, end: course.end });
      } else {
        notes.push(`${course.id}: built but not read back along its course`);
        if (course.kind === "GATEWAY") { gatewayRefused = true; break; }
      }
    }
    let zonesPainted = 0;
    let zonesRefused = 0;
    let zonesDeferred = 0;
    let zonesSkippedNearBuildings = 0;
    // A district whose streets mostly did not stand is a fragment: nothing is zoned on it.
    if (roadsLanded > 1 && roadsLanded / Math.max(1, plan.courses.length) >= MINIMUM_LANDED_SHARE) {
      // The land use of each spot comes from the world-corrected mix (shops and offices on the outer faces, homes inside);
      // a player who asked for one land use gets that land use throughout.
      const categories = input.intent?.role ? plan.zoneSpots.map(() => input.intent!.role as ZoneCategory)
        : assignDistrictSpots(plan.zoneSpots, role === "industrial", this.#mix, this.#available.filter((category) => !this.#paused.includes(category)));
      // One small block of the district stays unzoned: the lot a hearse or ambulance service can stand on later (see `district-services.ts`).
      const reserved = new Set(role === "industrial" ? [] : reserveSpotIndices(plan.zoneSpots));
      const lot = reservedLotOf(plan.zoneSpots, [...reserved]);
      if (lot) { this.#reservedLots.push(lot); notes.push(`a lot is left unzoned at (${lot.center.x.toFixed(0)},${lot.center.z.toFixed(0)}) for a public service`); }
      const wanted: ZoningBrush[] = [];
      for (const [spotIndex, spot] of plan.zoneSpots.entries()) {
        if (signal?.aborted) break;
        if (reserved.has(spotIndex)) continue;
        // A brush only paints cells that exist, so a spot beside a street the world refused simply paints nothing.
        const spotRole = categories[spotIndex]!;
        const zone = input.zoneFor(spotRole, this.#densityOf(spotRole, input));
        if (!zone) { zonesRefused += 1; continue; }
        // A district laid while water or sewage is short is roads only: homes zoned now would stand without service.
        // Its brush spots wait and are painted by the first cycle that finds the utilities answering.
        if (input.zoningHeld) {
          this.#pendingZoning.push({ zone, center: spot.center, radius: spot.radius });
          zonesDeferred += 1;
          continue;
        }
        wanted.push({ zone, center: spot.center, radius: spot.radius });
      }
      // The brush repaints every cell in its disk, buildings included (a building whose zone changes is condemned). A spot's disk reaches up to 16 m
      // past the district's edge, beyond the 12 m the site keeps from buildings, and the streets took minutes to lay while the city ran: each brush
      // is admitted against a fresh read of the ground (buildings and occupied cells), cut back to clear them, and not painted where no useful brush fits.
      const admission = wanted.length > 0 ? await this.#admitAndWrite(wanted, signal)
        : { written: [] as ZoningBrush[], failed: [] as Array<{ brush: ZoningBrush; detail: string }>, dropped: [] as ZoningBrush[], shrunk: 0, unread: [] as ZoningBrush[] };
      zonesSkippedNearBuildings += admission.dropped.length;
      zonesPainted += admission.written.length;
      if (admission.shrunk > 0) notes.push(`${admission.shrunk} zoning brushes cut back to clear what stands there now`);
      if (admission.unread.length > 0) {
        notes.push(`${admission.unread.length} zoning spots not painted: the ground could not be read just before writing (queued for the next cycle)`);
        for (const brush of admission.unread) if (this.#pendingZoning.length < 400) this.#pendingZoning.push(brush);
      }
      for (const { brush, detail } of admission.failed) {
        if (zonesRefused === 0) notes.push(`zone ${brush.zone} refused: ${detail.slice(0, 200)}`);
        zonesRefused += 1;
        if (this.#pendingZoning.length < 400) this.#pendingZoning.push(brush);
      }
    }
    if (zonesSkippedNearBuildings > 0) notes.push(`${zonesSkippedNearBuildings} zoning spots left unpainted: an existing building stood within the brush`);
    const neverEligible = pending.filter((course) => !settled.has(course.id));
    notes.push(`road pipeline: ${pipeline.proposed} streets proposed (${Math.round(pipeline.proposedMeters)} m) → ${pipeline.submitted} submitted (halves included${pipeline.gated > 0 ? `; ${pipeline.gated} more refused by the dry run before any build` : ""}${pipeline.prefiltered > 0 ? `; ${pipeline.prefiltered} held back as certain refusals` : ""}) → ` +
      `${pipeline.accepted} accepted → ${pipeline.landed} landed (${Math.round(pipeline.landedMeters)} m = ${Math.round(100 * Math.min(1, pipeline.landedMeters / Math.max(1, pipeline.proposedMeters)))}% of the planned length); ` +
      `${pipeline.refused} refused${pipeline.refused > 0 ? ` (${[...pipeline.reasons].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([reason, count]) => `${reason.slice(0, 40)} x${count}`).join(", ")})` : ""}; ` +
      `${neverEligible.length} never reached the network (${Math.round(neverEligible.reduce((sum, course) => sum + course.lengthMeters, 0))} m)`);
    notes.push(`district (${plan.site.anchor.x},${plan.site.anchor.z}) ${plan.site.widthMeters}x${plan.site.heightMeters} ${role}: ` +
      `roads ${roadsLanded}/${plan.courses.length} landed, ${roadsRefused} refused; zones ${zonesPainted}/${plan.zoneSpots.length}` +
      (zonesDeferred > 0 ? ` (${zonesDeferred} held back until the utilities answer)` : ""));
    // Streets were laid and brushes painted, refused or queued: some frontage may stand unzoned, so the next cycle sweeps for it.
    if (roadsBuilt > 0 || zonesPainted > 0 || zonesRefused > 0 || zonesDeferred > 0) this.#frontageDirty = true;
    return { status: "BUILT", site: plan.site, role, roadsBuilt, roadsRefused, roadsLanded, zonesPainted, zonesRefused, zonesDeferred, plannedCourses: plan.courses.length, notes, ...(gatewayRefused ? { gatewayRefused } : {}) };
  }
}
