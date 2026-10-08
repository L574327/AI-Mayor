/**
 * The sewage recipe's environmental applicability contract.
 *
 * `UTILITY_FACILITY_RECIPES.sewage` used to be an authorization marker and
 * nothing else: placing an outlet on a legal shoreline proved that a facility
 * fits and proved nothing about where its discharge goes. The contract this
 * module implements is the one the Skill manifest states: discharge/treatment
 * capacity and environmental risk are judged TOGETHER, and without water-flow
 * data the claim "pollution will not reach the intake" cannot be made — the one
 * thing a sewage plan may not do is guess a flow direction.
 *
 * With T20 the water-flow data exists. What this module will NOT do is turn
 * that data into a simulation. It answers exactly one question, from
 * authoritative samples only:
 *
 *   following the water's OWN reported velocity from this outfall, bounded —
 *   does the discharge reach a water intake?
 *
 * Everything that cannot be answered is named as a missing observation and
 * fails closed. A candidate that fails the test is refused; the planner moves
 * to the next candidate. A candidate that passes carries the evidence that
 * certified it, so the certification can be re-read rather than trusted.
 */

import type { SpatialPoint2, UtilityEnvironmentalCertification } from "../spatial/types";
import {
  WATER_DEPTH_EPSILON,
  type WaterFlowObservation,
  connectedWaterRegion,
  nearestWaterCell,
  traceWaterDownstream,
} from "../spatial/water-flow";

/** An outfall must discharge into water this deep to be an outfall at all. */
export const MINIMUM_OUTFALL_WATER_DEPTH = 0.5;

/**
 * How far the discharge is followed before the reach is called bounded.
 *
 * Chosen to match the scale the world's own water bodies actually present: the
 * longest live trace ran 1176 m before reaching a bank, and the utility
 * planner's own service-road reach is 2048 m. A trace that uses this distance
 * up is a bounded reach, not an unknown one.
 */
export const SEWAGE_DOWNSTREAM_CERTIFICATION_DISTANCE = 2048;

/** Any intake within this radius of the traced plume is at risk. */
export const SEWAGE_INTAKE_RISK_RADIUS = 64;

/** Budget for the connectivity walk; exceeding it is a missing observation. */
export const MAXIMUM_CONNECTED_WATER_CELLS = 8192;

/** How far from the outfall the receiving water may be found, in cells. */
export const RECEIVING_WATER_SEARCH_CELLS = 3;

/**
 * The authoritative water-intake census.
 *
 * `available` is separate from an empty list on purpose. "This world has no
 * water intake" and "nobody counted the water intakes" are different facts, and
 * only the first may certify a discharge.
 */
export interface SewageIntakeCensus {
  available: boolean;
  intakes: Array<{ prefab: string; position: SpatialPoint2 }>;
}

export interface SewageEnvironmentalEvidence extends UtilityEnvironmentalCertification {
  outfall: SpatialPoint2;
}

/** The one recipe family this criterion certifies. */
export const CERTIFIED_SEWAGE_RECIPE = "basic-sewage-provision" as const;

export type SewageEnvironmentalVerdict =
  | { certified: true; evidence: SewageEnvironmentalEvidence }
  | { certified: false; reason: string; missingObservation: string | null };

/** The missing observation the gate names when it cannot judge at all. */
export const SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION =
  "T20 water-body flow/connectivity: which water body an outfall discharges into, " +
  "and whether that body feeds a water intake";

const refuse = (reason: string, missingObservation: string | null = null): SewageEnvironmentalVerdict =>
  ({ certified: false, reason, missingObservation });

/**
 * Judge one concrete outfall site.
 *
 * The order of the checks is the order of the questions: is this really an
 * outfall, do we know where the intakes are, is the body bounded, and only
 * then does the water's own velocity get asked whether it carries the discharge
 * to one of them.
 */
export function certifySewageOutfallEnvironmentalSafety(input: {
  outfall: SpatialPoint2;
  observation: WaterFlowObservation;
  intakeCensus: SewageIntakeCensus;
}): SewageEnvironmentalVerdict {
  if (!input.observation.available) {
    return refuse("SEWAGE_WATER_FLOW_OBSERVATION_UNAVAILABLE", SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  }
  if (!input.intakeCensus.available) {
    return refuse("SEWAGE_INTAKE_CENSUS_UNAVAILABLE", SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  }
  const receiving = nearestWaterCell(input.observation, input.outfall, RECEIVING_WATER_SEARCH_CELLS);
  if (!receiving || receiving.depth < MINIMUM_OUTFALL_WATER_DEPTH) {
    return refuse(`SEWAGE_RECEIVING_WATER_TOO_SHALLOW:${receiving ? receiving.depth.toFixed(2) : "none"}`);
  }
  const speed = Math.hypot(receiving.velocity.x, receiving.velocity.z);
  const evidence: SewageEnvironmentalEvidence = {
    recipe: CERTIFIED_SEWAGE_RECIPE,
    outfall: { x: input.outfall.x, z: input.outfall.z },
    receivingWater: { x: receiving.x, z: receiving.z, depth: receiving.depth,
      pollution: receiving.pollution, velocity: receiving.velocity, speed },
    connectedWaterCells: 0,
    downstreamDistance: 0,
    downstreamTermination: "NOT_TRACED",
    downstreamCells: 0,
    intakeCount: input.intakeCensus.intakes.length,
    intakesInSameWaterBody: 0,
    closestIntakeApproach: null,
  };
  if (input.intakeCensus.intakes.length === 0) {
    // The census is complete and holds no intake, so no discharge path from this
    // outfall to one exists in this world. This is a real answer to the
    // contract's question, and it is falsifiable: the same check starts
    // refusing the site the moment an intake appears.
    return { certified: true, evidence };
  }
  // Only an intake the water could actually carry this discharge to is a risk,
  // and that intake has to be IN the water: a water body is made of water cells,
  // so an intake standing on land is outside every body by construction. That is
  // read per intake rather than assumed, because a surface pump sits on water
  // and a groundwater one does not.
  //
  // It matters because it is the difference between a missing observation and an
  // absent one. A body too large to walk is unproven FOR THE INTAKES IN IT; it
  // says nothing about an intake that is not in any water at all, and refusing
  // the whole shoreline of an ocean on account of a pump standing inland would
  // be a refusal about nothing.
  const intakeCells = new Map<string, number | "LAND" | "UNREAD">();
  for (const intake of input.intakeCensus.intakes) {
    const cell = input.observation.cellAt(intake.position.x, intake.position.z);
    intakeCells.set(intake.prefab + "|" + intake.position.x + "|" + intake.position.z,
      cell === null ? "UNREAD" : cell.depth > WATER_DEPTH_EPSILON ? cell.index : "LAND");
  }
  const classifications = [...intakeCells.values()];
  if (classifications.includes("UNREAD")) {
    // An intake outside the read cannot be said to be out of this body.
    return refuse("SEWAGE_INTAKE_OUTSIDE_OBSERVATION", SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  }
  const waterBorne = classifications.filter((value): value is number => typeof value === "number");
  if (waterBorne.length === 0) {
    // Every intake the world has stands on land, so none of them is in any water
    // body and no discharge path from this outfall reaches one.
    return { certified: true, evidence };
  }
  // Only an intake in the SAME water body can be reached. The membership is
  // connectivity, not proximity: an intake across a spit is in another body
  // however close it is.
  const region = connectedWaterRegion(input.observation, receiving.index, MAXIMUM_CONNECTED_WATER_CELLS);
  if (!region.bounded) {
    return refuse("SEWAGE_RECEIVING_WATER_CONNECTIVITY_UNBOUNDED", SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  }
  const regionCells = new Set(region.cells);
  const sameBody = input.intakeCensus.intakes.filter((intake) => {
    const classification = intakeCells.get(intake.prefab + "|" + intake.position.x + "|" + intake.position.z);
    return typeof classification === "number" && regionCells.has(classification);
  });
  evidence.connectedWaterCells = region.cells.length;
  evidence.intakesInSameWaterBody = sameBody.length;
  if (sameBody.length === 0) {
    // Every water-borne intake the world has is in another body, so none of them
    // can be reached by this outfall's discharge.
    return { certified: true, evidence };
  }
  const trace = traceWaterDownstream(input.observation, { x: receiving.x, z: receiving.z }, {
    maximumDistance: SEWAGE_DOWNSTREAM_CERTIFICATION_DISTANCE,
  });
  if (trace.termination === "LEFT_OBSERVATION") {
    // The plume left the sampled square. Nothing was observed beyond it, so its
    // reach is unknown — not short.
    return refuse("SEWAGE_DOWNSTREAM_REACH_LEAVES_OBSERVATION", SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  }
  if (trace.termination === "STAGNANT" && trace.cells.length === 0) {
    return refuse("SEWAGE_RECEIVING_WATER_FLOW_UNOBSERVED", SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  }
  let closest: number | null = null;
  for (const cell of trace.cells) {
    for (const intake of sameBody) {
      const distance = Math.hypot(cell.x - intake.position.x, cell.z - intake.position.z);
      if (closest === null || distance < closest) closest = distance;
    }
  }
  evidence.downstreamDistance = trace.distance;
  evidence.downstreamTermination = trace.termination;
  evidence.downstreamCells = trace.cells.length;
  evidence.closestIntakeApproach = closest;
  // The outfall itself is the start of the plume; a body that is stagnant at the
  // outfall still has the outfall within reach of anything in the same cell.
  for (const intake of sameBody) {
    const distance = Math.hypot(receiving.x - intake.position.x, receiving.z - intake.position.z);
    if (closest === null || distance < closest) closest = distance;
  }
  evidence.closestIntakeApproach = closest;
  if (closest !== null && closest <= SEWAGE_INTAKE_RISK_RADIUS) {
    return refuse(`SEWAGE_DISCHARGE_REACHES_WATER_INTAKE:${closest.toFixed(1)}m`);
  }
  if (trace.termination === "STAGNANT" && trace.cells.length <= 1) {
    // A truly still body: the discharge stays where it is put. It still counts
    // as a computed reach, and it is the one case where "the water does not
    // carry it anywhere" is itself the authoritative reading.
    evidence.downstreamTermination = "STAGNANT_AT_OUTFALL";
  }
  return { certified: true, evidence };
}

export { WATER_DEPTH_EPSILON };
