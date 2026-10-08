import type {
  PlannedUtilityConnection,
  SpatialBootstrapAsset,
  SpatialRoadEdge,
  SpatialSiteDetail,
  SpatialWorldModel,
} from "../../src/main/services/ai-mayor/spatial/types";
import type { Gate1BoundedSiteCandidate } from "../../src/main/services/ai-mayor/v2/site-selection";
import {
  createWaterSiteConstraint,
  type WaterFacilityPlacement,
  type WaterSiteConstraintEvidence,
} from "../../src/main/services/ai-mayor/v2/water-site-constraint";

const resolution = 16;
const values = (value: number) => Array(resolution * resolution).fill(value);

const model: SpatialWorldModel = {
  worldBounds: { min: -1000, max: 1000, size: 2000 },
  ownedTiles: [
    {
      entity: { index: 1, version: 1 },
      owned: true,
      bounds: { min: { x: -200, z: -100 }, max: { x: 400, z: 500 } },
      center: { x: 100, z: 200 },
      polygon: [],
    },
  ],
  outsideConnections: [],
  connectionCandidates: [],
  roadGraph: { nodes: [], edges: [], truncated: false },
};

const roadEdge: SpatialRoadEdge = {
  entity: { index: 30, version: 1 },
  prefab: "Medium Road",
  native: true,
  startNode: { index: 31, version: 1 },
  endNode: { index: 32, version: 1 },
  start: { x: 0, z: 300 },
  end: { x: 300, z: 300 },
  length: 300,
};

/** Same permanent road, laid along the bottom edge of the square read below. */
const bottomRoad: SpatialRoadEdge = { ...roadEdge, start: { x: -75, z: -75 }, end: { x: 75, z: -75 } };

const waterAsset: SpatialBootstrapAsset = {
  prefab: "GroundwaterPumpingStation01",
  locked: false,
  constructionCost: 500,
  lotSize: { x: 4, z: 4 },
  size: { x: 32, y: 20, z: 32 },
  capabilities: {
    electricityProduction: 0,
    windMaximum: 0,
    windProduction: 0,
    groundWaterProduction: 100,
    groundWaterMaximum: 1000,
    freshWaterCapacity: 100,
    allowedWaterTypes: "GroundWater",
    sewageCapacity: 0,
    sewagePurification: 0,
  },
};

/**
 * A reservation that can host a water source: flat dry owned land with clean
 * groundwater under it and one permanent player road to connect to.
 */
function reservation(overrides: Partial<SpatialSiteDetail["terrain"]> = {}): SpatialSiteDetail {
  return {
    center: { x: 100, z: 200 },
    radius: 400,
    terrain: {
      resolution,
      bounds: { minX: -200, minZ: -100, maxX: 400, maxZ: 500 },
      cellSize: { x: 37.5, z: 37.5 },
      heights: values(10),
      waterDepths: values(0),
      groundWater: values(500),
      groundWaterPollution: values(0),
      windSpeed: values(5),
      ...overrides,
    },
    buildings: [],
    zoningCells: [],
    roadGraph: { nodes: [], edges: [roadEdge] },
  };
}

const candidate = (id: string, center = { x: 100, z: 200 }): Gate1BoundedSiteCandidate => ({
  id,
  target: { center, radius: 180 },
  score: 1,
  blocked: false,
  direction: { x: 0, z: 1 },
  roadCandidates: [],
  evidence: { sourceAnchor: center, openResidentialCells: 4, owned: true, buildable: true, access: "BOUNDED_ROAD_FEASIBLE" },
});

/**
 * Clean groundwater everywhere the read reaches EXCEPT within `sourceWithin` of
 * the centre.
 *
 * The terrain read is a square: at `readRadius` its corners reach
 * sqrt(2)*readRadius from the centre. So this fixture is the exact shape of the
 * false accept the envelope bound exists to stop — a source the read can see but
 * placement, confined to a circle, cannot use.
 */
function ringSourceReservation(readRadius: number, sourceWithin: number): SpatialSiteDetail {
  const bounds = { minX: -80, minZ: -80, maxX: 80, maxZ: 80 };
  const cellSize = 10;
  const groundWater: number[] = [];
  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const x = bounds.minX + (col + 0.5) * cellSize;
      const z = bounds.minZ + (row + 0.5) * cellSize;
      groundWater.push(Math.hypot(x, z) > sourceWithin ? 500 : 0);
    }
  }
  return {
    center: { x: 0, z: 0 },
    radius: readRadius,
    terrain: {
      resolution,
      bounds,
      cellSize: { x: cellSize, z: cellSize },
      heights: values(10),
      waterDepths: values(0),
      groundWater,
      groundWaterPollution: values(0),
      windSpeed: values(5),
    },
    buildings: [],
    zoningCells: [],
    roadGraph: { nodes: [], edges: [bottomRoad] },
  };
}

/**
 * The water domain's site requirement, as admission sees it.
 *
 * The point of this seam is that admission is domain-neutral, so the water
 * domain has to state its own precondition — "a water source must fit inside the
 * reservation this candidate would create" — without restating the planner's
 * predicate. These cases pin that the decision really is the planner's: the
 * constraint accepts exactly when `planBootstrapUtilities(..., "water")` returns
 * a facility, refuses on an unobserved region rather than assuming one, and
 * plans against the admission scope's road authority rather than whatever roads
 * the bounded read happened to contain.
 */
describe("water site constraint", () => {
  test("accepts a candidate whose reservation can host a water source", async () => {
    const evidence: WaterSiteConstraintEvidence[] = [];
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [roadEdge],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => reservation(),
      onEvaluated: (entry) => evidence.push(entry),
    });

    expect(constraint.kind).toBe("water-source-within-utility-reservation");
    await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(true);
    expect(evidence).toEqual([{ candidateId: "c1", accepted: true, reason: null }]);
  });

  test("refuses an unobserved reservation instead of assuming it", async () => {
    const evidence: WaterSiteConstraintEvidence[] = [];
    // An empty catalogue would make the planner throw if it ran at all, so the
    // recorded reason proves the refusal happened before planning.
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [],
      roads: [roadEdge],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => null,
      onEvaluated: (entry) => evidence.push(entry),
    });

    await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
    expect(evidence).toEqual([
      { candidateId: "c1", accepted: false, reason: "WATER_RESERVATION_NOT_OBSERVED" },
    ]);
  });

  test("refuses a reservation whose read failed, without aborting the search", async () => {
    const evidence: WaterSiteConstraintEvidence[] = [];
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [roadEdge],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => {
        throw new Error("spatial site detail is incomplete");
      },
      onEvaluated: (entry) => evidence.push(entry),
    });

    // The read runs inside the site search, so an escaping throw would take down
    // admission for every candidate rather than refusing this one.
    await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
    expect(evidence).toEqual([
      {
        candidateId: "c1",
        accepted: false,
        reason: "WATER_RESERVATION_READ_FAILED: spatial site detail is incomplete",
      },
    ]);
  });

  test("refuses a reservation with no clean groundwater", async () => {
    const evidence: WaterSiteConstraintEvidence[] = [];
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [roadEdge],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => reservation({ groundWaterPollution: values(1) }),
      onEvaluated: (entry) => evidence.push(entry),
    });

    await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
    // The water branch reports its own refusal: no groundwater source exists
    // inside the reservation, so it never reaches the sewage section.
    expect(evidence).toHaveLength(1);
    expect(evidence[0].accepted).toBe(false);
    expect(evidence[0].reason).toMatch(/no groundwater water site is available/);
  });

  test("refuses a source the square read can see but the reservation cannot hold", async () => {
    const evidence: WaterSiteConstraintEvidence[] = [];
    // Sources start at 43m out; the reservation is 40m. The read is a square of
    // half-width 40, so it sees those sources in its corners (up to 56.6m).
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [bottomRoad],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => ringSourceReservation(40, 40),
      onEvaluated: (entry) => evidence.push(entry),
    });

    await expect(constraint.accepts(candidate("c1", { x: 0, z: 0 }), 40)).resolves.toBe(false);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].reason).toMatch(/groundWaterInEnvelope=0/);
    // The nearest source is real and just outside: the refusal is the envelope's,
    // not a missing source.
    const nearest = Number(/nearestGroundWaterAnywhere=(\d+(?:\.\d+)?)m/.exec(evidence[0].reason ?? "")?.[1]);
    expect(nearest).toBeGreaterThan(40);
    expect(nearest).toBeLessThan(46);
  });

  test("accepts that same source once the reservation actually reaches it", async () => {
    // The paired case: identical source field, only the reservation radius moves.
    // So the refusal above is attributable to the envelope, not to the fixture
    // being unplannable.
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [bottomRoad],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => ringSourceReservation(80, 40),
    });

    await expect(constraint.accepts(candidate("c1", { x: 0, z: 0 }), 80)).resolves.toBe(true);
  });

  test("plans against the admission scope's roads, not the bounded read's", async () => {
    const withoutRoads = reservation();
    withoutRoads.roadGraph = { nodes: [], edges: [] };
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [roadEdge],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => withoutRoads,
    });

    // The bounded read carried no road, but the admission scope authorizes one.
    await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(true);
  });

  test("fails closed when the admission scope authorizes no road", async () => {
    const evidence: WaterSiteConstraintEvidence[] = [];
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async () => reservation(),
      onEvaluated: (entry) => evidence.push(entry),
    });

    // A reservation's own road is not authority: only the scope's is.
    await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].reason).toMatch(/no authoritative player road/i);
  });

  test("reads the reservation at the candidate's own centre and forwards the signal", async () => {
    const seen: { point: { x: number; z: number }; radius: number; signal: AbortSignal | undefined }[] = [];
    const controller = new AbortController();
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [roadEdge],
      quoteConnectionCost: async () => 0,
      probePlacement: async () => true,
      readReservation: async (point, radius, signal) => {
        seen.push({ point, radius, signal });
        return reservation();
      },
    });

    await constraint.accepts(candidate("c1", { x: 12.5, z: -40 }), 240, controller.signal);

    expect(seen).toHaveLength(1);
    expect(seen[0].point).toEqual({ x: 12.5, z: -40 });
    // The radius reaches the read: admission searches it, so a constraint that
    // read at its own fixed radius would answer a question nobody asked.
    expect(seen[0].radius).toBe(240);
    expect(seen[0].signal).toBe(controller.signal);
  });

  /**
   * The budget half of the constraint.
   *
   * A site that can host a water source is not the same fact as a project that
   * can afford one. The facility's cost is the plan's own authoritative asset
   * cost; the pipe's has no plan figure at all and comes from the native
   * spending contract. Both halves are reported, because the native boundary
   * that refuses an over-budget execution sums them against one limit.
   */
  describe("minimum feasible budget", () => {
    test("prices the accepted plan as facility asset cost plus the native pipe quote", async () => {
      const quoted: PlannedUtilityConnection[] = [];
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async (value) => {
          quoted.push(value);
          return 136;
        },
        probePlacement: async () => true,
        readReservation: async () => reservation(),
      });

      await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(true);
      const requirement = await constraint.minimumFeasibleBudget?.(candidate("c1"), 180);

      expect(requirement).toEqual({
        kind: "water",
        facilityPrefab: "GroundwaterPumpingStation01",
        facilityCost: 500,
        facilityCostSource: "PLAN_ASSET_COST",
        connectionPrefab: "Small Water Pipe",
        connectionCost: 136,
        connectionCostSource: "NATIVE_SPENDING_CONTRACT",
        requiredSpend: 636,
      });
      // The quote is asked about the plan's OWN connection, once: pricing a pipe
      // between other endpoints, or pricing two of them, would price something
      // nobody builds.
      expect(quoted).toHaveLength(1);
      expect(quoted[0].prefab).toBe("Small Water Pipe");
      expect(quoted[0].start).not.toEqual(quoted[0].end);
    });

    test("fails closed when the accepted plan's connection cannot be quoted", async () => {
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => {
          throw new Error("native preflight rejected");
        },
        probePlacement: async () => true,
        readReservation: async () => reservation(),
      });

      await constraint.accepts(candidate("c1"), 180);
      await expect(constraint.minimumFeasibleBudget?.(candidate("c1"), 180)).rejects.toThrow(
        "native preflight rejected",
      );
    });

    test("refuses to price a candidate and radius it never accepted", async () => {
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => 136,
        probePlacement: async () => true,
        readReservation: async () => reservation(),
      });

      await constraint.accepts(candidate("c1"), 180);

      // A different radius is a different reservation, hence a different plan.
      // An unproven figure is not zero: authorizing a spend nobody read is the
      // failure this refusal exists to prevent.
      await expect(constraint.minimumFeasibleBudget?.(candidate("c1"), 240)).rejects.toThrow(
        "WATER_UTILITY_BUDGET_REQUIREMENT_UNPROVEN",
      );
    });
  });

  /**
   * The native placement half of the constraint.
   *
   * A reservation the planner is satisfied with is not the same fact as a
   * reservation the game will let the station be built in. The live world has
   * already produced the difference: a 200 m reservation full of clean, dry,
   * owned, flat groundwater where the game refuses the pumping station at every
   * position and rotation inside it. These cases pin that the second fact is read
   * from the game rather than inferred from the first, and that a verdict that
   * could not be read refuses instead of passing.
   */
  describe("native facility placeability", () => {
    test("refuses a reservation whose source the game accepts nowhere", async () => {
      const evidence: WaterSiteConstraintEvidence[] = [];
      const probes: WaterFacilityPlacement[] = [];
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => 0,
        // The planner is satisfied — there IS clean groundwater inside the
        // envelope. The game is not, at any rotation. Nothing in the terrain
        // read distinguishes this fixture from the accepting one below.
        probePlacement: async (placement) => {
          probes.push(placement);
          return false;
        },
        readReservation: async () => reservation(),
        onEvaluated: (entry) => evidence.push(entry),
      });

      await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
      expect(evidence).toEqual([
        {
          candidateId: "c1",
          accepted: false,
          reason: "WATER_FACILITY_NOT_PLACEABLE:prefab=GroundwaterPumpingStation01:placements=4",
        },
      ]);
      // Every rotation the plan would accept was tried, and only those: the
      // search is bounded by the plan rather than open.
      expect(probes.map((placement) => placement.rotation)).toEqual([0, 90, 180, 270]);
      expect(probes.every((placement) => placement.prefab === "GroundwaterPumpingStation01")).toBe(true);
      // A refused plan is not a plan, so it cannot be priced either. Otherwise a
      // caller could budget for a facility admission had just rejected.
      await expect(constraint.minimumFeasibleBudget?.(candidate("c1"), 180)).rejects.toThrow(
        "WATER_UTILITY_BUDGET_REQUIREMENT_UNPROVEN",
      );
    });

    test("accepts that same plan once one rotation is placeable", async () => {
      const evidence: WaterSiteConstraintEvidence[] = [];
      const probes: WaterFacilityPlacement[] = [];
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => 0,
        // Identical fixture to the refusal above; only the game's answer moves.
        probePlacement: async (placement) => {
          probes.push(placement);
          return placement.rotation === 180;
        },
        readReservation: async () => reservation(),
        onEvaluated: (entry) => evidence.push(entry),
      });

      await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(true);
      expect(evidence).toEqual([{ candidateId: "c1", accepted: true, reason: null }]);
      // The question is whether a placement EXISTS, so the search stops at the
      // first yes instead of spending the rest of the rotations.
      expect(probes.map((placement) => placement.rotation)).toEqual([0, 90, 180]);
    });

    test("refuses a placement the game never answered for, without aborting the search", async () => {
      const evidence: WaterSiteConstraintEvidence[] = [];
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => 0,
        probePlacement: async () => {
          throw new Error("bridge unreachable");
        },
        readReservation: async () => reservation(),
        onEvaluated: (entry) => evidence.push(entry),
      });

      // An unobserved placement is not a refused one, and treating it as
      // placeable is exactly the gap this gate closes. It refuses this candidate
      // rather than escaping, because this runs inside the site search.
      await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
      expect(evidence).toEqual([
        {
          candidateId: "c1",
          accepted: false,
          reason: "WATER_FACILITY_PLACEMENT_UNOBSERVED: bridge unreachable",
        },
      ]);
    });

    test("probes the plan's own site, inside the reservation that was asked about", async () => {
      const probes: WaterFacilityPlacement[] = [];
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => 0,
        probePlacement: async (placement) => {
          probes.push(placement);
          return false;
        },
        readReservation: async () => reservation(),
      });

      await constraint.accepts(candidate("c1"), 180);

      // One site, four rotations — not four sites. A station the game accepts
      // somewhere else is not this plan being placeable, and admission must not
      // be able to claim a reservation on the strength of a placement the plan
      // does not propose.
      expect(new Set(probes.map((placement) => `${placement.position.x},${placement.position.z}`)).size).toBe(1);
      for (const placement of probes) {
        expect(Math.hypot(placement.position.x - 100, placement.position.z - 200)).toBeLessThanOrEqual(180);
      }
    });

    test("takes no native verdict when the planner never proposed a source", async () => {
      const probes: WaterFacilityPlacement[] = [];
      const constraint = createWaterSiteConstraint({
        world: model,
        assets: [waterAsset],
        roads: [roadEdge],
        quoteConnectionCost: async () => 0,
        probePlacement: async (placement) => {
          probes.push(placement);
          return true;
        },
        // Polluted everywhere: the planner refuses before there is anything to
        // place, so the native call is never spent.
        readReservation: async () => reservation({ groundWaterPollution: values(1) }),
      });

      await expect(constraint.accepts(candidate("c1"), 180)).resolves.toBe(false);
      expect(probes).toEqual([]);
    });
  });
});

describe("sewage site constraint", () => {
  const sewageAsset: SpatialBootstrapAsset = {
    ...waterAsset,
    prefab: "SewageOutlet01",
    capabilities: { ...waterAsset.capabilities, freshWaterCapacity: 0, allowedWaterTypes: undefined,
      groundWaterProduction: 0, groundWaterMaximum: 0, sewageCapacity: 100 },
  };

  test("a reservation whose read contains no shoreline is refused before it is admitted", async () => {
    // The live failure this exists for: a sewage Goal reserved land whose
    // observed terrain had no water edge at all (`rawShore=0`), so every K05
    // attempt inside it was guaranteed to fail. Admission, not the planner, is
    // where that has to be caught — the planner cannot pick different land.
    const evidence: WaterSiteConstraintEvidence[] = [];
    const constraint = createWaterSiteConstraint({
      utilityKind: "sewage",
      world: model,
      assets: [sewageAsset],
      roads: [roadEdge],
      readReservation: async () => reservation(),
      quoteConnectionCost: async () => 10,
      probePlacement: async () => true,
      onEvaluated: (entry) => evidence.push(entry),
    });
    expect(constraint.kind).toBe("sewage-outlet-within-utility-reservation");
    expect(await constraint.accepts(candidate("no-shore"), 180)).toBe(false);
    expect(evidence[0]?.reason).toMatch(/no low-slope shoreline sewage site/);
  });

  test("a sewage constraint declares no water-source road prerequisite", async () => {
    const constraint = createWaterSiteConstraint({
      utilityKind: "sewage",
      world: model,
      assets: [sewageAsset],
      roads: [roadEdge],
      readReservation: async () => reservation(),
      quoteConnectionCost: async () => 10,
      probePlacement: async () => true,
    });
    expect(await constraint.derivePrerequisite?.()).toBeNull();
  });

  test("a water constraint is untouched by the sewage kind", async () => {
    const constraint = createWaterSiteConstraint({
      world: model,
      assets: [waterAsset],
      roads: [roadEdge],
      readReservation: async () => reservation(),
      quoteConnectionCost: async () => 10,
      probePlacement: async () => true,
    });
    expect(constraint.kind).toBe("water-source-within-utility-reservation");
  });
});

