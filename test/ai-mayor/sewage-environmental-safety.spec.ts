import {
  parseWaterFlowObservation,
  traceWaterDownstream,
  connectedWaterRegion,
  nearestWaterCell,
  unavailableWaterFlowObservation,
  type WaterFlowObservation,
} from "../../src/main/services/ai-mayor/spatial/water-flow";
import {
  certifySewageOutfallEnvironmentalSafety,
  SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION,
  SEWAGE_INTAKE_RISK_RADIUS,
  type SewageIntakeCensus,
} from "../../src/main/services/ai-mayor/v2/sewage-environmental-safety";
import { planBootstrapUtilities, MAX_COMPLETE_UTILITY_PROPOSALS } from "../../src/main/services/ai-mayor/spatial/utility-planner";
import { admitScopedGreenfieldUtilityPlan, type GreenfieldUtilityExecutionScope } from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { createWaterSiteConstraint,
  SEWAGE_OUTFALL_CORRIDOR_STEP_METERS } from "../../src/main/services/ai-mayor/v2/water-site-constraint";
import type {
  BootstrapSiteEvaluation,
  PlannedUtilityFacility,
  SpatialBootstrapAsset,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "../../src/main/services/ai-mayor/spatial/types";

/**
 * A grid built from explicit per-cell facts, so every assertion below is about a
 * stated world rather than about a recipe's arithmetic.
 */
function grid(input: {
  resolution: number;
  cellSize: number;
  worldMin: number;
  depth: (col: number, row: number) => number;
  velocity?: (col: number, row: number) => { x: number; z: number };
  pollution?: (col: number, row: number) => number;
}): WaterFlowObservation {
  const depths: number[] = [];
  const pollutions: number[] = [];
  const velocities: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < input.resolution; row += 1) {
    for (let col = 0; col < input.resolution; col += 1) {
      depths.push(input.depth(col, row));
      pollutions.push(input.pollution ? input.pollution(col, row) : 0);
      const velocity = input.velocity ? input.velocity(col, row) : { x: 0, z: 0 };
      velocities.push({ x: velocity.x, y: velocity.z });
    }
  }
  return parseWaterFlowObservation({
    resolution: input.resolution, cellSize: input.cellSize,
    worldMin: input.worldMin, worldMax: input.worldMin + input.resolution * input.cellSize,
    waterDepths: depths, waterPollutions: pollutions, waterVelocities: velocities,
  });
}

const noIntakes: SewageIntakeCensus = { available: true, intakes: [] };

describe("water-flow observation", () => {
  it("keeps both velocity components and the raw pollution sample", () => {
    const observation = grid({ resolution: 4, cellSize: 10, worldMin: 0,
      depth: () => 5, velocity: () => ({ x: 3, z: -4 }), pollution: () => 0.25 });
    const sample = observation.sampleAt(5, 5);
    expect(sample).not.toBeNull();
    expect(sample!.velocity).toEqual({ x: 3, z: -4 });
    expect(sample!.pollution).toBeCloseTo(0.25, 10);
    expect(sample!.depth).toBe(5);
    // Magnitude is derived, never stored: the direction is the authoritative part.
    expect(Math.hypot(sample!.velocity.x, sample!.velocity.z)).toBeCloseTo(5, 10);
  });

  it("answers nothing when any of the three arrays is missing or mis-sized", () => {
    const complete = { resolution: 2, cellSize: 10, worldMin: 0, worldMax: 20,
      waterDepths: [1, 1, 1, 1], waterPollutions: [0, 0, 0, 0],
      waterVelocities: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] };
    expect(parseWaterFlowObservation(complete).available).toBe(true);
    // A partial read is worse than no read: a trace that stops early on missing
    // data would report a bounded reach where the truth is "nobody looked".
    expect(parseWaterFlowObservation({ ...complete, waterVelocities: [{ x: 0, y: 0 }] }).available).toBe(false);
    expect(parseWaterFlowObservation({ ...complete, waterPollutions: undefined }).available).toBe(false);
    expect(parseWaterFlowObservation({ ...complete, resolution: 3 }).available).toBe(false);
    expect(parseWaterFlowObservation(null).available).toBe(false);
    expect(unavailableWaterFlowObservation().available).toBe(false);
    expect(unavailableWaterFlowObservation().sampleAt(0, 0)).toBeNull();
  });

  it("traces downstream along the reported velocity, not along a guessed bearing", () => {
    // A channel moving +x at 5 m/s, one cell of land at the far end.
    const observation = grid({ resolution: 10, cellSize: 10, worldMin: 0,
      depth: (col) => (col < 8 ? 4 : 0), velocity: () => ({ x: 5, z: 0 }) });
    const trace = traceWaterDownstream(observation, { x: 5, z: 55 }, { maximumDistance: 200 });
    expect(trace.termination).toBe("LEFT_WATER");
    expect(trace.cells[0].col).toBe(0);
    expect(trace.cells.at(-1)!.col).toBeGreaterThanOrEqual(7);
    // Every visited cell travelled along +x; nothing moved in z.
    expect(new Set(trace.cells.map((cell) => cell.row))).toEqual(new Set([5]));
  });

  it("reports stagnation, distance exhaustion and an unobserved exit as different facts", () => {
    const still = grid({ resolution: 8, cellSize: 10, worldMin: 0, depth: () => 3 });
    expect(traceWaterDownstream(still, { x: 5, z: 5 }, { maximumDistance: 100 }).termination).toBe("STAGNANT");

    const fast = grid({ resolution: 40, cellSize: 10, worldMin: 0, depth: () => 3,
      velocity: () => ({ x: 4, z: 3 }) });
    expect(traceWaterDownstream(fast, { x: 5, z: 5 }, { maximumDistance: 50 }).termination)
      .toBe("DISTANCE_EXHAUSTED");

    // Starting on the edge of the sampled square walks straight off it. That is
    // "not observed", never "the plume stopped".
    const edge = grid({ resolution: 8, cellSize: 10, worldMin: 0, depth: () => 3,
      velocity: () => ({ x: 5, z: 0 }) });
    expect(traceWaterDownstream(edge, { x: 75, z: 5 }, { maximumDistance: 200 }).termination)
      .toBe("LEFT_OBSERVATION");
  });

  it("finds the connected water body by connectivity, and calls an unbounded walk unbounded", () => {
    const split = grid({ resolution: 8, cellSize: 10, worldMin: 0,
      depth: (col) => (col === 4 ? 0 : 3) });
    const left = connectedWaterRegion(split, 1 * 8 + 1, 64);
    expect(left.bounded).toBe(true);
    // The two halves are metres apart and are still not one body.
    expect(left.cells.every((index) => index % 8 < 4)).toBe(true);
    expect(connectedWaterRegion(split, 1 * 8 + 1, 4).bounded).toBe(false);
  });

  it("finds the receiving water nearest the outfall within the bounded search", () => {
    const observation = grid({ resolution: 8, cellSize: 10, worldMin: 0,
      depth: (col) => (col >= 4 ? 6 : 0) });
    const cell = nearestWaterCell(observation, { x: 38, z: 38 }, 3);
    expect(cell).not.toBeNull();
    expect(cell!.col).toBeGreaterThanOrEqual(4);
    expect(nearestWaterCell(observation, { x: 5, z: 5 }, 1)).toBeNull();
  });
});

describe("certified conservative sewage outfall recipe", () => {
  const outfall = { x: 25, z: 25 };

  it("refuses to certify without the flow observation or without an intake census", () => {
    const withoutFlow = certifySewageOutfallEnvironmentalSafety({
      outfall, observation: unavailableWaterFlowObservation(), intakeCensus: noIntakes,
    });
    expect(withoutFlow.certified).toBe(false);
    expect(withoutFlow.certified === false && withoutFlow.reason).toBe("SEWAGE_WATER_FLOW_OBSERVATION_UNAVAILABLE");

    const observation = grid({ resolution: 20, cellSize: 10, worldMin: 0, depth: () => 5 });
    const withoutCensus = certifySewageOutfallEnvironmentalSafety({
      outfall, observation, intakeCensus: { available: false, intakes: [] } });
    expect(withoutCensus.certified).toBe(false);
    // "This world has no intake" and "nobody counted the intakes" must not be
    // the same answer.
    expect(withoutCensus.certified === false && withoutCensus.reason).toBe("SEWAGE_INTAKE_CENSUS_UNAVAILABLE");
    expect(withoutCensus.certified === false && withoutCensus.missingObservation)
      .toBe(SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  });

  it("refuses an outfall that does not discharge into real water", () => {
    const observation = grid({ resolution: 20, cellSize: 10, worldMin: 0, depth: () => 0 });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall, observation, intakeCensus: noIntakes });
    expect(verdict.certified).toBe(false);
    expect(verdict.certified === false && verdict.reason.startsWith("SEWAGE_RECEIVING_WATER_TOO_SHALLOW")).toBe(true);
  });

  it("certifies when the receiving body contains no intake, and says so with evidence", () => {
    const observation = grid({ resolution: 20, cellSize: 10, worldMin: 0, depth: () => 6,
      velocity: () => ({ x: 2, z: 1 }), pollution: () => 0.125 });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall, observation, intakeCensus: noIntakes });
    expect(verdict.certified).toBe(true);
    if (!verdict.certified) return;
    expect(verdict.evidence.intakeCount).toBe(0);
    expect(verdict.evidence.intakesInSameWaterBody).toBe(0);
    expect(verdict.evidence.receivingWater.depth).toBe(6);
    expect(verdict.evidence.receivingWater.velocity).toEqual({ x: 2, z: 1 });
    expect(verdict.evidence.receivingWater.pollution).toBeCloseTo(0.125, 10);
  });

  it("refuses a candidate whose discharge reaches an intake downstream", () => {
    // A 200 m wide channel flowing +x at 4 m/s, an intake 120 m downstream in
    // the same body. The read has to span the whole certification distance, or
    // the trace would legitimately stop for lack of observation rather than
    // lack of risk.
    const observation = grid({ resolution: 220, cellSize: 10, worldMin: 0,
      depth: (_col, row) => (row >= 10 && row < 30 ? 5 : 0), velocity: () => ({ x: 4, z: 0 }) });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 25, z: 150 }, observation,
      intakeCensus: { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 145, z: 150 } }] } });
    expect(verdict.certified).toBe(false);
    expect(verdict.certified === false && verdict.reason.startsWith("SEWAGE_DISCHARGE_REACHES_WATER_INTAKE")).toBe(true);
  });

  it("certifies only when the trace is fully observed: leaving the read is not a bounded reach", () => {
    // The flow runs off the sampled square before the intakes are resolved.
    const observation = grid({ resolution: 20, cellSize: 10, worldMin: 0, depth: () => 5,
      velocity: () => ({ x: 6, z: 0 }) });
    const atRisk = { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 195, z: 25 } }] };
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 185, z: 25 }, observation,
      intakeCensus: atRisk });
    expect(verdict.certified).toBe(false);
    expect(verdict.certified === false && verdict.reason)
      .toBe("SEWAGE_DOWNSTREAM_REACH_LEAVES_OBSERVATION");
  });

  it("separates the two water bodies by connectivity: a near intake across a spit is not this outfall's", () => {
    const observation = grid({ resolution: 40, cellSize: 10, worldMin: 0,
      depth: (col) => (col === 20 ? 0 : 5), velocity: () => ({ x: 4, z: 0 }) });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 25, z: 25 }, observation,
      intakeCensus: { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 205, z: 25 } }] } });
    expect(verdict.certified).toBe(true);
    if (!verdict.certified) return;
    expect(verdict.evidence.intakeCount).toBe(1);
    expect(verdict.evidence.intakesInSameWaterBody).toBe(0);
  });

  it("treats a still body as a computed reach and still refuses an adjacent intake", () => {
    const still = grid({ resolution: 20, cellSize: 10, worldMin: 0, depth: () => 4 });
    const far = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 25, z: 25 }, observation: still,
      intakeCensus: { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 175, z: 25 } }] } });
    expect(far.certified).toBe(true);
    if (far.certified) expect(far.evidence.downstreamTermination).toBe("STAGNANT_AT_OUTFALL");

    const near = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 25, z: 25 }, observation: still,
      intakeCensus: { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 45, z: 25 } }] } });
    expect(near.certified).toBe(false);
  });

  it("fails closed when the connected body cannot be bounded and an intake is in the water", () => {
    // All water, so every intake below is water-borne and the walk is required.
    const observation = grid({ resolution: 128, cellSize: 10, worldMin: 0, depth: () => 5 });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 25, z: 25 }, observation,
      intakeCensus: { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 60, z: 60 } }] } });
    expect(verdict.certified).toBe(false);
    expect(verdict.certified === false && verdict.reason).toBe("SEWAGE_RECEIVING_WATER_CONNECTIVITY_UNBOUNDED");
    expect(verdict.certified === false && verdict.missingObservation).toBe(SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  });

  it("judges an intake standing on land without walking the body it is not in", () => {
    // The whole map is sea except a strip of land the intake stands on. The sea
    // is far too large to bound, and the intake is provably not in it.
    const observation = grid({ resolution: 256, cellSize: 10, worldMin: 0,
      depth: (_col, row) => (row < 10 ? 0 : 5) });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 100, z: 150 }, observation,
      intakeCensus: { available: true,
        intakes: [{ prefab: "WaterPumpingStation01", position: { x: 100, z: 50 } }] } });
    expect(verdict.certified).toBe(true);
    if (!verdict.certified) return;
    expect(verdict.evidence.intakeCount).toBe(1);
    expect(verdict.evidence.intakesInSameWaterBody).toBe(0);
    // No walk was needed, so none was spent.
    expect(verdict.evidence.connectedWaterCells).toBe(0);
  });

  it("refuses when an intake lies outside the observation altogether", () => {
    const observation = grid({ resolution: 16, cellSize: 10, worldMin: 0, depth: () => 5 });
    const verdict = certifySewageOutfallEnvironmentalSafety({ outfall: { x: 25, z: 25 }, observation,
      intakeCensus: { available: true,
        intakes: [{ prefab: "WaterPumpingStation01", position: { x: 5000, z: 5000 } }] } });
    expect(verdict.certified).toBe(false);
    expect(verdict.certified === false && verdict.reason).toBe("SEWAGE_INTAKE_OUTSIDE_OBSERVATION");
  });
});

/** A shoreline strip along the eastern edge of a 400 m owned square. */
const PLAN_RESOLUTION = 16;
const planValues = (value: number) => Array(PLAN_RESOLUTION * PLAN_RESOLUTION).fill(value);
const planModel: SpatialWorldModel = {
  worldBounds: { min: -1000, max: 1000, size: 2000 },
  ownedTiles: [{ entity: { index: 1, version: 1 }, owned: true,
    bounds: { min: { x: -200, z: -100 }, max: { x: 400, z: 500 } }, center: { x: 100, z: 200 }, polygon: [] }],
  outsideConnections: [], connectionCandidates: [],
  roadGraph: { nodes: [], edges: [], truncated: false },
};
const planSelectedSite = { valid: true, layout: { segments: [] } } as unknown as BootstrapSiteEvaluation;
const planSewageAsset: SpatialBootstrapAsset = {
  prefab: "SewageOutlet01", locked: false, constructionCost: 500, lotSize: { x: 4, z: 4 },
  size: { x: 32, y: 20, z: 32 },
  capabilities: { electricityProduction: 0, windMaximum: 0, windProduction: 0, groundWaterProduction: 0,
    groundWaterMaximum: 0, freshWaterCapacity: 0, allowedWaterTypes: null, sewageCapacity: 100, sewagePurification: 0 },
};
function planShoreDetail(): SpatialSiteDetail {
  const waterDepths = planValues(0);
  for (let row = 0; row < PLAN_RESOLUTION; row += 1) waterDepths[row * PLAN_RESOLUTION + PLAN_RESOLUTION - 1] = 4;
  return {
    center: { x: 100, z: 200 }, radius: 400,
    terrain: { resolution: PLAN_RESOLUTION, bounds: { minX: -200, minZ: -100, maxX: 400, maxZ: 500 },
      cellSize: { x: 37.5, z: 37.5 }, heights: planValues(10), waterDepths,
      groundWater: planValues(0), groundWaterPollution: planValues(0), windSpeed: planValues(5) },
    buildings: [], zoningCells: [],
    roadGraph: { nodes: [], edges: [{ entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true,
      startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 },
      start: { x: 0, z: 300 }, end: { x: 300, z: 300 }, length: 300 }] },
  };
}
/** A flat, still body over the whole plan square: certifiable, and no intake. */
const planWaterObservation = grid({ resolution: 32, cellSize: 50, worldMin: -300, depth: () => 6 });
const noIntakeCensus: SewageIntakeCensus = { available: true, intakes: [] };

describe("the certified recipe inside the sewage planner", () => {
  it("attaches the certification to the proposal and keeps the raw pool wider than the proposals", () => {
    const plan = planBootstrapUtilities(planModel, planSelectedSite, planShoreDetail(), [planSewageAsset], {
      utilityKind: "sewage", networkSource: "EXISTING_PLAYER_ROADS_ONLY",
      sewageEnvironmentalSafety: { observation: planWaterObservation, intakeCensus: noIntakeCensus },
    });
    const sewage = plan.facilities.find((facility) => facility.kind === "sewage");
    expect(sewage?.environmentalCertification).toBeDefined();
    expect(sewage?.environmentalCertification?.recipe).toBe("basic-sewage-provision");
    expect(sewage?.environmentalCertification?.receivingWater.depth).toBeGreaterThan(0.5);
    // Complete proposals are capped; the sites they were chosen from are the
    // planner's own wider ranking.
    expect(plan.candidateFacilities?.length).toBeGreaterThan(0);
    expect(plan.candidateFacilities!.length).toBeLessThanOrEqual(MAX_COMPLETE_UTILITY_PROPOSALS);
    expect(plan.candidateFacilities!.every((proposal) => proposal.environmentalCertification !== undefined)).toBe(true);
  });

  it("leaves a plan uncertified when no observation was supplied, rather than certifying by default", () => {
    const plan = planBootstrapUtilities(planModel, planSelectedSite, planShoreDetail(), [planSewageAsset], {
      utilityKind: "sewage", networkSource: "EXISTING_PLAYER_ROADS_ONLY",
    });
    expect(plan.facilities.find((facility) => facility.kind === "sewage")?.environmentalCertification).toBeUndefined();
    expect(plan.candidateFacilities).toBeUndefined();
  });

  it("fails closed when no shoreline site satisfies the recipe, instead of widening the search", () => {
    // An observation that cannot judge refuses every site, including the ones
    // whose placement would be perfectly legal. The honest answer is a named
    // dead end, not a facility returned without its evidence.
    expect(() => planBootstrapUtilities(planModel, planSelectedSite, planShoreDetail(), [planSewageAsset], {
      utilityKind: "sewage", networkSource: "EXISTING_PLAYER_ROADS_ONLY",
      sewageEnvironmentalSafety: {
        observation: unavailableWaterFlowObservation(),
        intakeCensus: noIntakeCensus,
      },
    })).toThrow(/satisfies the certified recipe/);
    // And when an intake really is reachable, the sites it reaches are dropped
    // while the body's other shorelines stay available — the criterion refuses
    // candidates, it does not disable the family.
    const observation = grid({ resolution: 32, cellSize: 50, worldMin: -300, depth: () => 6 });
    const plan = planBootstrapUtilities(planModel, planSelectedSite, planShoreDetail(), [planSewageAsset], {
      utilityKind: "sewage", networkSource: "EXISTING_PLAYER_ROADS_ONLY",
      sewageEnvironmentalSafety: { observation,
        intakeCensus: { available: true, intakes: [{ prefab: "WaterPumpingStation01", position: { x: 325, z: 25 } }] } },
    });
    const certified = plan.candidateFacilities ?? [];
    expect(certified.length).toBeGreaterThan(0);
    // Every surviving proposal is one the criterion actually judged: it saw the
    // intake and measured a clear approach.
    expect(certified.every((proposal) => proposal.environmentalCertification?.intakeCount === 1)).toBe(true);
    expect(certified.every((proposal) =>
      (proposal.environmentalCertification?.closestIntakeApproach ?? 0) > SEWAGE_INTAKE_RISK_RADIUS)).toBe(true);
  });
});

describe("the bounded sewage access corridor", () => {
  const roads = [{ entity: { index: 30, version: 1 }, prefab: "Medium Road", native: true,
    startNode: { index: 31, version: 1 }, endNode: { index: 32, version: 1 },
    start: { x: 0, z: 0 }, end: { x: 20, z: 0 }, length: 20 }];
  const constraintFor = (detailFor: (center: { x: number; z: number }) => SpatialSiteDetail | null) =>
    createWaterSiteConstraint({
      utilityKind: "sewage",
      world: { ...planModel,
        ownedTiles: [{ entity: { index: 1, version: 1 }, owned: true,
          bounds: { min: { x: -300, z: -300 }, max: { x: 900, z: 900 } }, center: { x: 300, z: 300 }, polygon: [] }] },
      assets: [planSewageAsset],
      roads,
      readReservation: async (point) => detailFor({ x: point.x, z: point.z }),
      quoteConnectionCost: async () => 10,
      probePlacement: async () => true,
      sewageEnvironmentalSafety: { observation: planWaterObservation, intakeCensus: noIntakeCensus },
    });

  it("proposes a corridor to a certified outfall the road does not reach", async () => {
    const prerequisite = await constraintFor(() => planShoreDetail()).derivePrerequisite();
    expect(prerequisite).not.toBeNull();
    expect(prerequisite!.kind).toBe("ROAD_ACCESS");
    expect(prerequisite!.completionStage).toBe("ROAD_DELIVERED");
    // The target is a real corridor, not the site itself: it sits far out on
    // owned land and short of the outfall, so the next pass drives a road to it
    // and the planner then finds the outfall with its own service road.
    // The target is ONE bounded corridor hop, not the far destination: the Road
    // step is asked for a segment it can actually commit, and each delivery
    // shortens what the next pass has to plan.
    const distanceToRoadGraph = Math.hypot(prerequisite!.targetPoint.x, prerequisite!.targetPoint.z);
    expect(distanceToRoadGraph).toBeGreaterThan(100);
    expect(distanceToRoadGraph).toBeLessThan(250);
    expect(prerequisite!.evidence).toContain("owned shoreline");
    expect(prerequisite!.evidence).toContain("corridor PLANNED");
    expect(prerequisite!.evidence).toContain("remaining=");
  });

  /**
   * A road this product delivered: `native: false`, a live entity, and a prefab
   * the unlocked catalogue names — exactly what the scan returns for a road the
   * Mayor built.
   */
  const deliveredRoad = { entity: { index: 40, version: 1 }, prefab: "Small Road", native: false,
    startNode: { index: 41, version: 1 }, endNode: { index: 42, version: 1 },
    start: { x: 100, z: 100 }, end: { x: 150, z: 100 }, length: 50 };

  const roadDistanceOf = (evidence: string): number => {
    const match = /shoreline ([\d.]+)m from the authoritative road graph/.exec(evidence);
    expect(match).not.toBeNull();
    return Number(match![1]);
  };

  const corridorConstraint = (roads_ : unknown[], availableRoadPrefabs?: readonly string[]) =>
    createWaterSiteConstraint({
      utilityKind: "sewage",
      world: { ...planModel,
        ownedTiles: [{ entity: { index: 1, version: 1 }, owned: true,
          bounds: { min: { x: -300, z: -300 }, max: { x: 900, z: 900 } }, center: { x: 300, z: 300 }, polygon: [] }] },
      assets: [planSewageAsset],
      roads: roads_ as typeof roads,
      ...(availableRoadPrefabs ? { availableRoadPrefabs } : {}),
      readReservation: async () => planShoreDetail(),
      quoteConnectionCost: async () => 10,
      probePlacement: async () => true,
      sewageEnvironmentalSafety: { observation: planWaterObservation, intakeCensus: noIntakeCensus },
    });

  it("measures the road front against the roads this project delivered, not only the map's own", async () => {
    // The live defect this exists for: 247 delivered edges stood between the
    // certified outfall and the map's original roads, and the corridor measured
    // its front against `native` alone. So every pass re-planned from the same
    // point, its first hop landed on the same ground, and once the Road step had
    // built that hop the directed course it was handed collapsed to zero length
    // (`targetPoint` 0.0 m from the front) and the bounded heading family took
    // over with courses native kept refusing.
    const mapRoadsOnly = await corridorConstraint(roads).derivePrerequisite();
    const withDelivered = await corridorConstraint([...roads, deliveredRoad],
      ["Small Road", "Medium Road"]).derivePrerequisite();
    expect(mapRoadsOnly).not.toBeNull();
    expect(withDelivered).not.toBeNull();
    // The delivered road is the nearer front, so the corridor's own measurement
    // of how far the road graph is moved onto it. Measuring against the map's
    // roads alone cannot produce this difference.
    expect(roadDistanceOf(withDelivered!.evidence)).toBeLessThan(roadDistanceOf(mapRoadsOnly!.evidence));
    // And the hop it asks for is one bounded segment ahead of THAT front — not
    // the far destination, and not a point the front has already reached.
    const deliveredFront = { x: 150, z: 100 };
    const hop = Math.hypot(withDelivered!.targetPoint.x - deliveredFront.x,
      withDelivered!.targetPoint.z - deliveredFront.z);
    expect(hop).toBeGreaterThan(8);
    expect(hop).toBeLessThanOrEqual(SEWAGE_OUTFALL_CORRIDOR_STEP_METERS + 1);
    // The map's own road front is not what it is a hop from, which is the whole
    // difference between a corridor that advances and one that stands still.
    const mapFront = { x: 20, z: 0 };
    expect(Math.hypot(withDelivered!.targetPoint.x - mapFront.x,
      withDelivered!.targetPoint.z - mapFront.z)).toBeGreaterThan(SEWAGE_OUTFALL_CORRIDOR_STEP_METERS + 1);
  });

  it("hands the site back once the delivered network actually reaches it", async () => {
    // The corridor exists to make the outfall reachable. Once the road this
    // project built stands within the service-road offset of it, asking for
    // another hop is asking for a road nobody needs, and the ordinary
    // reservation search is the step that should run instead.
    const reachesOutfall = { ...deliveredRoad, entity: { index: 50, version: 1 },
      startNode: { index: 51, version: 1 }, endNode: { index: 52, version: 1 },
      start: { x: 250, z: 180 }, end: { x: 300, z: 180 } };
    const reachable = await corridorConstraint([...roads, reachesOutfall],
      ["Small Road", "Medium Road"]).derivePrerequisite();
    expect(reachable).toBeNull();
    // The same world without the catalogue keeps planning the corridor, which is
    // exactly the stall: the front never moves, so the plan never changes.
    expect(await corridorConstraint([...roads, reachesOutfall]).derivePrerequisite()).not.toBeNull();
  });

  it("proposes nothing when the T20 observation is missing, or when no tile yields an outfall", async () => {
    const withoutObservation = createWaterSiteConstraint({
      utilityKind: "sewage",
      world: { ...planModel,
        ownedTiles: [{ entity: { index: 1, version: 1 }, owned: true,
          bounds: { min: { x: -300, z: -300 }, max: { x: 900, z: 900 } }, center: { x: 300, z: 300 }, polygon: [] }] },
      assets: [planSewageAsset],
      roads,
      readReservation: async () => planShoreDetail(),
      quoteConnectionCost: async () => 10,
      probePlacement: async () => true,
    });
    // A corridor to a site nobody could judge is the guess the recipe forbids.
    expect(await withoutObservation.derivePrerequisite()).toBeNull();
    // And an unreadable owned region is skipped, never treated as shoreline.
    expect(await constraintFor(() => null).derivePrerequisite()).toBeNull();
  });
});

describe("the durable admission refuses an uncertified sewage plan", () => {
  const scope: GreenfieldUtilityExecutionScope = {
    intentId: "intent-1", projectId: "project-1", trancheId: "tranche-1", reservationRef: "reservation-1",
    worldId: "world-1", worldEpochId: "world-1:generation:1", generation: "generation-1",
    topologyRevision: "generation-1:production",
    certifiedRoadRefs: [{ index: 1, version: 1 }],
    targetServiceEntry: { road: { index: 1, version: 1 }, position: { x: 0, z: 0 } },
    spatialEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
    maximumSpend: 2000, treasury: 10000, treasurySafetyReserve: 0,
  };
  const plan: PlannedUtilityFacility = {
    kind: "sewage", prefab: "SewageOutlet01", position: { x: 0, z: 0 }, rotationCandidates: [0],
    constructionCost: 500, expectedCapacity: 100, siteEvidence: {},
    connection: { prefab: "Small Sewage Pipe", start: { x: 0, z: 0 }, end: { x: 0, z: 0 } },
  };

  it("refuses a plan whose site fits but whose discharge was never judged", () => {
    expect(() => admitScopedGreenfieldUtilityPlan({ kind: "sewage", scope, plan }))
      .toThrow("SEWAGE_ENVIRONMENTAL_SAFETY_NOT_CERTIFIED");
  });

  it("admits the same plan once the criterion's evidence rides on it", () => {
    expect(() => admitScopedGreenfieldUtilityPlan({
      kind: "sewage", scope,
      plan: { ...plan, environmentalCertification: {
        recipe: "basic-sewage-provision",
        receivingWater: { x: 10, z: 10, depth: 4, pollution: 0, velocity: { x: 0, z: 0 }, speed: 0 },
        connectedWaterCells: 10, downstreamDistance: 0, downstreamTermination: "STAGNANT_AT_OUTFALL",
        downstreamCells: 1, intakeCount: 0, intakesInSameWaterBody: 0, closestIntakeApproach: null,
      } },
    })).not.toThrow();
  });

  it("leaves the other families alone: an uncertified water plan is still admissible", () => {
    expect(() => admitScopedGreenfieldUtilityPlan({
      kind: "water", scope,
      plan: { ...plan, kind: "water", prefab: "WaterPump01",
        connection: { prefab: "Small Water Pipe", start: { x: 0, z: 0 }, end: { x: 0, z: 0 } } },
    })).not.toThrow();
  });
});

