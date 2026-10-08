import type { SpatialPoint2 } from "../spatial/types";
import { nearestWaterCell, type WaterFlowObservation } from "../spatial/water-flow";
import {
  certifySewageOutfallEnvironmentalSafety, MINIMUM_OUTFALL_WATER_DEPTH, type SewageEnvironmentalVerdict,
} from "./sewage-environmental-safety";

/**
 * Where a sewage outlet and a surface water pump may stand TOGETHER.
 *
 * The gameplay Bible (K39, HARD_INVARIANT) says an outlet "far from the pump" is less reliable than "the pollution does not reach the pump", and
 * POL-UTILITY says water and sewage decisions need the water's flow or a previously certified recipe: distance alone is not safety evidence. The
 * district builder had dropped that for the outlet (it took the nearest free lot beside a street, on dry land, and let only the game's own
 * preflight say yes). This module puts it back, for BOTH facilities, because they constrain each other:
 *
 *  - an outlet is placed only where its discharge, followed by the water's own velocity, does not reach a surface-water intake;
 *  - a pump is placed only where no existing outlet's discharge reaches it, AND (while no outlet stands) where at least one certified outlet site
 *    would still remain once the pump stands. Without the second rule the pump could take the only river reach an outlet could use, the outlet
 *    could then never be placed, and nothing the Mayor does would resolve it: the pump looks reasonable, so it stays, and the outlet waits for
 *    ever. A pump that would cause that is simply not placed there.
 *
 * Everything unreadable fails closed for the outlet (no discharge is placed on a guess) and open for the pump (water is the need that cannot
 * wait, and with no observation the outlet is not being placed either, so there is nothing to conflict with).
 */
export interface WaterSafety {
  observation: WaterFlowObservation;
  /** The water intakes that stand now (fresh each cycle: a pump placed a moment ago must be in it). */
  intakes: ReadonlyArray<{ prefab: string; position: SpatialPoint2 }>;
  /** The listing was complete. An incomplete one is not "these are all the intakes". */
  intakesComplete: boolean;
}

/** The reason prefix of a verdict that says the discharge definitely reaches an intake. */
export const DISCHARGE_REACHES_INTAKE = "SEWAGE_DISCHARGE_REACHES_WATER_INTAKE";

/** Open water within these offsets (metres, eight directions at each) of a lot makes it a place an outlet could discharge from. */
export const OUTFALL_WATER_PROBE_METERS: readonly number[] = [30, 60];
/** Outfall sites certified per search, and sites looked at before giving up (each certification may walk a water body). */
export const MAXIMUM_CERTIFIED_OUTFALL_SITES = 24;
export const MAXIMUM_OUTFALL_SITES_EXAMINED = 160;

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];

/** Whether the lot is on dry land with open water (deeper than an outfall needs) close by. `waterDepthAt` is null off the terrain read. */
export function nearOpenWater(point: SpatialPoint2, waterDepthAt: (point: SpatialPoint2) => number | null): boolean {
  const here = waterDepthAt(point);
  if (here === null || here > 0.05) return false;
  for (const meters of OUTFALL_WATER_PROBE_METERS) {
    for (const [dx, dz] of DIRECTIONS) {
      if ((waterDepthAt({ x: point.x + dx * meters, z: point.z + dz * meters }) ?? 0) >= MINIMUM_OUTFALL_WATER_DEPTH) return true;
    }
  }
  return false;
}

/** How far (grid cells) a surface pump's lot may stand from the water it draws on. */
const PUMP_WATER_SEARCH_CELLS = 3;

/**
 * Where an intake takes its water from. A surface pump's LOT is on the bank, and the flow grid is coarse: the cell under the lot is often land, and
 * the certification (which counts an intake standing on land as outside every water body) would call it safe from every discharge. So a surface
 * pump is judged at the nearest water cell. A groundwater pump draws on the ground, not the river, and stays where it stands.
 */
function intakeInWater(intake: { prefab: string; position: SpatialPoint2 }, observation: WaterFlowObservation): { prefab: string; position: SpatialPoint2 } {
  if (/Ground/i.test(intake.prefab)) return intake;
  const water = nearestWaterCell(observation, intake.position, PUMP_WATER_SEARCH_CELLS);
  return water ? { prefab: intake.prefab, position: { x: water.x, z: water.z } } : intake;
}

/** The verdict on an outfall at `site` against the intakes that stand, plus any more (a pump about to be placed). */
export function outfallVerdict(site: SpatialPoint2, safety: WaterSafety, extraIntakes: ReadonlyArray<{ prefab: string; position: SpatialPoint2 }> = []): SewageEnvironmentalVerdict {
  return certifySewageOutfallEnvironmentalSafety({ outfall: site, observation: safety.observation,
    intakeCensus: { available: safety.intakesComplete, intakes: [...safety.intakes, ...extraIntakes].map((intake) => intakeInWater(intake, safety.observation)) } });
}

export interface OutfallSelection<T> {
  sites: T[];
  /** Why candidates were refused, by reason (a count each), for the cycle's notes. */
  refusals: Record<string, number>;
  examined: number;
}

/**
 * The first candidates (in the order given: nearest the district first) that stand by open water AND whose discharge is certified not to reach an
 * intake. Fails closed: with no usable observation or census nothing is selected, and the reason says so.
 */
export function selectCertifiedOutfalls<T extends { position: SpatialPoint2 }>(candidates: readonly T[], safety: WaterSafety | null,
  waterDepthAt: (point: SpatialPoint2) => number | null, limit = MAXIMUM_CERTIFIED_OUTFALL_SITES, maximumExamined = MAXIMUM_OUTFALL_SITES_EXAMINED): OutfallSelection<T> {
  const refusals: Record<string, number> = {};
  const refuse = (reason: string) => { refusals[reason] = (refusals[reason] ?? 0) + 1; };
  if (!safety || !safety.observation.available) { refuse("SEWAGE_WATER_FLOW_OBSERVATION_UNAVAILABLE"); return { sites: [], refusals, examined: 0 }; }
  if (!safety.intakesComplete) { refuse("SEWAGE_INTAKE_CENSUS_UNAVAILABLE"); return { sites: [], refusals, examined: 0 }; }
  const sites: T[] = [];
  let examined = 0;
  for (const candidate of candidates) {
    if (sites.length >= limit || examined >= maximumExamined) break;
    if (!nearOpenWater(candidate.position, waterDepthAt)) { refuse("NO_OPEN_WATER_NEAR_LOT"); continue; }
    examined += 1;
    const verdict = outfallVerdict(candidate.position, safety);
    if (verdict.certified) sites.push(candidate); else refuse(verdict.reason.replace(/:[\d.]+m?$/, ""));
  }
  return { sites, refusals, examined };
}

export interface PumpGuard {
  safety: WaterSafety;
  /** Outlets that stand now (attached or not: each can foul the water). */
  existingOutlets: ReadonlyArray<SpatialPoint2>;
  /** Certified outlet sites that exist BEFORE this pump; null when none stands to be placed (an outlet already stands, or none could be). */
  outletOptions: ReadonlyArray<SpatialPoint2> | null;
}

/**
 * May a surface pump stand at `pump`? Only a DEFINITE reach blocks it: an unreadable or unbounded plume is not a reason to leave a city without
 * water for good.
 */
export function pumpSiteSafe(pump: SpatialPoint2, guard: PumpGuard): { ok: boolean; reason: string | null } {
  if (!guard.safety.observation.available) return { ok: true, reason: null };
  const candidate = { prefab: "pump-candidate", position: pump };
  for (const outlet of guard.existingOutlets) {
    const verdict = outfallVerdict(outlet, { ...guard.safety, intakes: [], intakesComplete: true }, [candidate]);
    if (!verdict.certified && verdict.reason.startsWith(DISCHARGE_REACHES_INTAKE)) return { ok: false, reason: `an outlet's discharge would reach it (${verdict.reason})` };
  }
  if (guard.existingOutlets.length === 0 && guard.outletOptions && guard.outletOptions.length > 0) {
    // Without this, the pump could take the only reach an outlet could use. One certified site that survives it is enough.
    const survives = guard.outletOptions.some((site) => outfallVerdict(site, guard.safety, [candidate]).certified);
    if (!survives) return { ok: false, reason: "no certified outlet site would remain once it stands" };
  }
  return { ok: true, reason: null };
}
