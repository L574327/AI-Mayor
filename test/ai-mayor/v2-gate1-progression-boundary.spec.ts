import { parseSpatialBootstrapScan, buildSpatialWorldModel } from "../../src/main/services/ai-mayor/spatial/world-scanner";
import type { SpatialSiteDetail, SpatialWorldModel } from "../../src/main/services/ai-mayor/spatial/types";
import type { Gate1AdmittedProposal, Gate1WorldBoundary } from "../../src/main/services/ai-mayor/v2/gate1";
import { createV2Gate1ProgressionBoundary, roadCourseKey } from "../../src/main/services/ai-mayor/v2/gate1-progression-boundary";
import { ROAD_EXECUTION_TRUTH_CONTRACT } from "../../src/main/services/ai-mayor/v2/runtime-road-caller";
import {
  evaluateBoundedStarterSites,
  selectBoundedStarterSiteAnchors,
  selectGoalWorkOrderSiteAnchors,
  selectIngressStarterSiteAnchors,
  selectLocalStarterSiteAnchors,
  type Gate1StarterSiteAnchor,
} from "../../src/main/services/ai-mayor/v2/site-selection";
import type { V2ObservationEnvelope } from "../../src/main/services/ai-mayor/v2/foundation";
import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import type { RoadGeometryInput } from "../../src/main/services/ai-mayor/v2/road-kernel";
import { ROAD_COURSE_SWEEP_LENGTHS_METERS } from "../../src/main/services/ai-mayor/v2/road-course-sweep";

const instant = new Date("2026-01-02T03:04:05.000Z");
const WORLD_EPOCH = "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:generation:generation-a";
const GENERATION = "generation-a";

// The same bounded scan/detail payloads the native Bridge returns.
const scanPayload = {
  world: { min: -200, max: 200, size: 400 },
  tiles: [
    {
      entity: { index: 1, version: 1 },
      owned: true,
      bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } },
      center: { x: 0, z: 0 },
      polygon: [],
    },
  ],
  outsideConnections: [],
  bootstrapAssets: [],
  roadGraph: {
    truncated: false,
    nodes: [
      { entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
      { entity: { index: 11, version: 1 }, position: { x: 30, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
    ],
    edges: [
      {
        entity: { index: 20, version: 1 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 10, version: 1 },
        endNode: { index: 11, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: 30, z: 0 },
        length: 30,
      },
    ],
  },
};

const siteDetail: SpatialSiteDetail = {
  center: { x: 20, z: 0 },
  radius: 96,
  terrain: {
    resolution: 2,
    bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
    cellSize: { x: 100, z: 100 },
    heights: [0, 0, 0, 0],
    waterDepths: [0, 0, 0, 0],
    groundWater: [0, 0, 0, 0],
    groundWaterPollution: [0, 0, 0, 0],
    windSpeed: [0, 0, 0, 0],
  },
  roadGraph: { nodes: [], edges: [] },
  buildings: [],
  zoningCells: [{
    block: { index: 30, version: 1 }, index: 0, position: { x: 32, y: 0, z: 0 },
    visible: true, roadside: true, occupied: false, blocked: false, overridden: false,
    zoneType: 0, zoneCategory: "none",
  }],
};

/**
 * A world that owns local non-highway frontage AND an owned map-highway ingress.
 *
 * This is the shape the water slice admitted into: local frontage exists, so the
 * composite selector returns local anchors and never looks at the ingress seed,
 * yet the admitted target came from the ingress seed because every local
 * candidate failed the project's own constraint.
 */
const ingressScanPayload = {
  world: { min: -200, max: 200, size: 400 },
  tiles: [
    {
      entity: { index: 1, version: 1 },
      owned: true,
      bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } },
      center: { x: 0, z: 0 },
      polygon: [],
    },
  ],
  outsideConnections: [],
  bootstrapAssets: [],
  roadGraph: {
    truncated: false,
    nodes: [
      // Owned local non-highway frontage: two dead-end nodes on a Small Road.
      { entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
      { entity: { index: 11, version: 1 }, position: { x: 30, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
      // The owned map-highway ingress, reachable only through its own highway edge.
      { entity: { index: 12, version: 1 }, position: { x: -90, y: 0, z: 0 }, native: true, outsideConnection: true, roadDegree: 1 },
      { entity: { index: 13, version: 1 }, position: { x: -190, y: 0, z: 0 }, native: true, outsideConnection: true, roadDegree: 1 },
    ],
    edges: [
      {
        entity: { index: 20, version: 1 },
        prefab: "Small Road",
        native: true,
        startNode: { index: 10, version: 1 },
        endNode: { index: 11, version: 1 },
        start: { x: 0, z: 0 },
        end: { x: 30, z: 0 },
        length: 30,
      },
      {
        entity: { index: 21, version: 1 },
        prefab: "Highway",
        native: true,
        startNode: { index: 13, version: 1 },
        endNode: { index: 12, version: 1 },
        start: { x: -190, z: 0 },
        end: { x: -90, z: 0 },
        length: 100,
      },
    ],
  },
};

const AVAILABLE_ROAD_PREFABS = ["Small Road", "Medium Road"];

const timed = <T>(value: T) => ({
  readStartedAt: instant.toISOString(),
  readEndedAt: instant.toISOString(),
  simulationFrameStart: 10,
  simulationFrameEnd: 10,
  freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 },
});

const sourceValue = <T>(data: T) => ({ status: "AVAILABLE" as const, data, ...timed(null) });
const unavailableValue = () => ({ status: "UNAVAILABLE" as const, reason: "fixture", ...timed(null) });

/**
 * The native detail read is centred on the requested position, exactly like the
 * production observation reader.
 */
const detailAt = (x: number, z: number): SpatialSiteDetail => ({ ...siteDetail, center: { x, z } });

function envelope(scan: unknown, detail: SpatialSiteDetail | null): V2ObservationEnvelope {
  return {
    schemaVersion: "ai-mayor-v2-observation/1",
    observationId: "observation:boundary",
    runtimeEpoch: "runtime:boundary",
    worldEpoch: { kind: "RUNTIME_SESSION", value: "runtime:boundary", durableAcrossSaveLoad: false },
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    gameTimeStart: "2026-01-01 08:00",
    gameTimeEnd: "2026-01-01 08:00",
    pausedBefore: true,
    pausedAfter: true,
    coherence: detail === null ? "UNKNOWN" : "STABLE_FRAME",
    sourceFreshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", maximumAgeMs: 0, allRequiredSourcesAvailable: detail !== null },
    revision: { authoritativeWorldRevision: null },
    sources: {
      gameStateBefore: sourceValue({}),
      snapshot: sourceValue({}),
      spatialScan: scan === null ? unavailableValue() : sourceValue(scan),
      spatialDetail: detail === null ? unavailableValue() : sourceValue(detail),
      gameStateAfter: sourceValue({}),
    },
  } as V2ObservationEnvelope;
}

function productivePreview(input: { x1: number; z1: number; x2: number; z2: number }) {
  const proposalId = `proposal:${input.x1.toFixed(3)}:${input.z1.toFixed(3)}:${input.x2.toFixed(3)}:${input.z2.toFixed(3)}`;
  const quoteId = `quote:${proposalId}`;
  return {
    valid: true,
    validNewRoadProposal: true,
    previewOnly: true,
    roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
    roadExecutionContract: ROAD_EXECUTION_TRUTH_CONTRACT,
    courseIntegrity: {
      operationKind: "NEW_ROAD_PROPOSAL_EDGE",
      firstFailure: null,
      postHandoffGeometryPreserved: true,
      proposalEdgeCount: 1,
    },
    proposalId,
    quoteId,
    diagnostics: {
      realization: { generatedTempEntities: [{ kind: "EDGE", original: null }, { kind: "NODE", original: null }] },
    },
    finance: {
      state: "VALID",
      proposalId,
      quoteId,
      provenance: "OBSERVED_NATIVE",
      sourceKind: "NATIVE_TOOL_TEMP_COST",
      signedAmount: 120,
      eligibleTempEntityCount: 2,
      runtimeEpoch: "runtime:boundary",
      frame: 10,
    },
  };
}

interface BoundaryHarnessOptions {
  scan?: unknown;
  detail?: SpatialSiteDetail | null;
  preview?: (input: RoadGeometryInput) => unknown;
  targetPoint?: { x: number; z: number };
  /** The course a mature planner compiled for the active work order, when it carried one. */
  roadCourse?: { start: { x: number; z: number }; end: { x: number; z: number } };
  /** Road courses the durable journal already proved the world does not contain. */
  absentCourses?: Array<{ prefab: string; x1: number; z1: number; x2: number; z2: number }>;
  /** The Goal the active work order was admitted for. */
  activeGoalId?: string;
  /** The land use the durable scope declares, so a ZONING step can read its own category. */
  landUse?: string;
  /** The native zone prefab reader, recorded so the category it is asked for can be asserted. */
  readZoneCategory?: (zone: string) => Promise<string>;
}

function boundaryHarness(options: BoundaryHarnessOptions = {}) {
  const scan = options.scan === undefined ? scanPayload : options.scan;
  const withDetail = options.detail === undefined ? true : options.detail !== null;
  const roadRequests: Array<{ proposal: { input: unknown; owner: { ownerId: string } } }> = [];
  const previewInputs: unknown[] = [];
  const consumedChildOperations: Array<{ amendmentId: string; courseFingerprint: string }> = [];

  const foundation = {
    observation: {
      capture: async ({ spatialDetail }: { spatialDetail: { x: number; z: number } }) =>
        envelope(scan, withDetail ? detailAt(spatialDetail.x, spatialDetail.z) : null),
    },
    road: {
      execute: async (request: { proposal: { input: unknown; owner: { ownerId: string } } }) => {
        roadRequests.push(request);
        return {
          command: { status: "OBSERVED_MATCH", commandId: "command:road-1", actionFamily: "ROAD" },
          effectReport: { matcherResult: "MATCH", reason: "fixture match" },
          bridgeCalled: true,
          authorizationConsumed: true,
        };
      },
    },
    zoning: { execute: jest.fn(async () => ({ command: { status: "OBSERVED_MATCH", commandId: "command:zone-1" }, effectReport: { matcherResult: "MATCH" } })) },
    durability: {
      snapshot: () => ({
        ...(options.targetPoint || options.roadCourse || options.activeGoalId ? { activeGoalWorkOrderId: "work-order:targeted-road", goalWorkOrders: [
          { workOrderId: "work-order:targeted-road", projectId: "project:1",
            goalId: options.activeGoalId ?? "ESTABLISH_ROAD_NETWORK:facts:fixture",
            ...(options.targetPoint ? { targetPoint: options.targetPoint } : {}),
            ...(options.roadCourse ? { roadCourse: options.roadCourse } : {}),
            completionStage: "ROAD_DELIVERED" },
        ] } : {}),
        commands: (options.absentCourses ?? []).map((course, index) => ({
          position: index + 1,
          record: {
            actionFamily: "ROAD",
            effectAbsenceProven: true,
            authorizedScope: { actionFamily: "ROAD", exactInput: stableRoadInput(course) },
          },
        })),
      }),
      consumeUtilityServiceRoadChildOperation: (amendmentId: string, courseFingerprint: string) => {
        consumedChildOperations.push({ amendmentId, courseFingerprint });
      },
      ...(options.landUse
        ? {
          projectState: () => ({
            schemaVersion: "ai-mayor-v2-gate1-state/2",
            districtPlan: { landUse: options.landUse },
          }),
        }
        : {}),
    },
  };

  const boundary: Gate1WorldBoundary = createV2Gate1ProgressionBoundary({
    foundation: foundation as never,
    world: { worldEpochId: WORLD_EPOCH, generation: GENERATION },
    previewRoad: async (input) => {
      previewInputs.push(input);
      return options.preview ? options.preview(input) : productivePreview(input);
    },
    readAvailableRoadPrefabs: async () => AVAILABLE_ROAD_PREFABS,
    readResidentialZone: async () => "Residential Low",
    ...(options.readZoneCategory
      ? { readZoneCategory: (zone: string, _signal?: AbortSignal) => options.readZoneCategory!(zone) }
      : {}),
  });

  return { boundary, roadRequests, previewInputs, consumedChildOperations };
}

/**
 * The deterministic evaluation project admission ran, replayed in the test. The
 * resolver must reproduce the same bounded candidates for the persisted target
 * without inventing geometry.
 */
function selectionFor(
  scan: unknown,
  selectAnchors: (world: SpatialWorldModel, maxAnchors: number) => Gate1StarterSiteAnchor[],
  targetPoint?: { x: number; z: number },
) {
  const world = buildSpatialWorldModel(parseSpatialBootstrapScan(scan));
  const anchors = selectAnchors(world, 24);
  const details = anchors.map((anchor) => ({
    anchor: { x: anchor.node.position.x, z: anchor.node.position.z },
    detail: detailAt(anchor.node.position.x, anchor.node.position.z),
  }));
  return evaluateBoundedStarterSites({
    world,
    worldEpoch: WORLD_EPOCH,
    bridgeGeneration: GENERATION,
    availableRoadPrefabs: AVAILABLE_ROAD_PREFABS,
    anchors,
    details,
    ...(targetPoint ? { targetPoint } : {}),
    maxCandidates: 4,
  });
}

const admissionSelection = () => selectionFor(scanPayload, selectBoundedStarterSiteAnchors);
const ingressSelection = () => selectionFor(ingressScanPayload, selectIngressStarterSiteAnchors);

/**
 * The search a TARGET-DIRECTED Road prerequisite admission runs.
 *
 * It is not the ordinary starter search with a bias added: a goal-directed
 * admission samples the Goal's own owned-road anchors, allows the generic Road
 * fallback, and skips the ingress class entirely. The resolver replays exactly
 * this, so a fixture that models admission as anything else would be testing a
 * search the product never ran.
 */
function goalDirectedSelection(scan: unknown, targetPoint: { x: number; z: number }) {
  const world = buildSpatialWorldModel(parseSpatialBootstrapScan(scan));
  const anchors = selectGoalWorkOrderSiteAnchors(world, 24, targetPoint, AVAILABLE_ROAD_PREFABS);
  return evaluateBoundedStarterSites({
    world,
    worldEpoch: WORLD_EPOCH,
    bridgeGeneration: GENERATION,
    availableRoadPrefabs: AVAILABLE_ROAD_PREFABS,
    anchors,
    details: anchors.map((anchor) => ({
      anchor: { x: anchor.node.position.x, z: anchor.node.position.z },
      detail: detailAt(anchor.node.position.x, anchor.node.position.z),
    })),
    targetPoint,
    allowGenericRoadFallback: true,
    maxCandidates: 4,
  });
}

function admittedProposal(overrides: Partial<Gate1AdmittedProposal> & { target: { center: { x: number; z: number }; radius: number } }): Gate1AdmittedProposal {
  return {
    id: "proposal:road:attempt:1",
    attempt: 1,
    skill: "RoadConnection",
    taskId: "tranche:1:task:road_connection",
    projectId: "project:1",
    districtId: "district:1",
    trancheId: "tranche:1",
    reservationRef: "tranche:1:reservation",
    requiredStage: "SITE_SELECTED",
    kind: "WORLD_WRITE",
    actionFamily: "ROAD",
    operation: "BUILD_ROAD",
    boundedFallback: null,
    methodVariant: "PRIMARY",
    admission: { decision: "ADMITTED", admittedAt: instant.toISOString(), scopeFingerprint: "fixture" },
    ...overrides,
  } as Gate1AdmittedProposal;
}

describe("V2 Gate 1 production progression boundary", () => {
  test("reproduces the admitted site target and returns the exact bounded ROAD request", async () => {
    const selection = admissionSelection();
    expect(selection.candidates.length).toBeGreaterThan(0);
    const expected = selection.candidates[0];
    const expectedRoad = expected.roadCandidates[0];
    expect(expectedRoad).toBeDefined();

    const { boundary, roadRequests, previewInputs } = boundaryHarness();
    const outcome = await boundary.execute(admittedProposal({ target: expected.target }));

    expect(outcome.status).toBe("DELIVERED");
    expect(outcome.observedMatch).toBe(true);
    expect(roadRequests).toHaveLength(1);
    // The resolver submitted exactly the bounded candidate the deterministic
    // evaluation produces for the persisted target.
    expect(roadRequests[0].proposal.input).toEqual(expectedRoad.input);
    expect(roadRequests[0].proposal.owner).toEqual({ ownerType: "TASK", ownerId: "tranche:1:task:road_connection" });
    expect(previewInputs).toEqual([expectedRoad.input]);
  });

  test("an expansion reservation that already carries road is not asked to build one", async () => {
    // The live blocker (2026-09-30): a residential expansion site of radius 28 m
    // with a degree-5 junction 8.1 m from its centre. Every bounded course the
    // resolver offered, and every heading of a local fan at 30 m, is a rebuild of
    // a road already there — which native folds back rather than certifying — so
    // the Road step failed forever and the Goal re-derived itself every tick.
    const target = admissionSelection().candidates[0].target;
    const expansion = boundaryHarness({ activeGoalId: "EXPAND_RESIDENTIAL:residential:facts:fixture" });
    const result = await expansion.boundary.preflightRoad(admittedProposal({ target }));
    expect(result.status).toBe("ALREADY_CONNECTED");
    if (result.status === "ALREADY_CONNECTED") expect(result.reason).toContain("already carries existing");
    // Nothing was previewed, so nothing would have been admitted or submitted:
    // the task completes on the world's own fact, without a command.
    expect(expansion.previewInputs).toHaveLength(0);
    expect(expansion.roadRequests).toHaveLength(0);

    // A Road Goal is asked for a course, not for frontage, and is untouched: it
    // still previews and returns the bounded family's first course.
    const roadGoal = boundaryHarness({ activeGoalId: "ESTABLISH_ROAD_NETWORK:facts:fixture" });
    await roadGoal.boundary.preflightRoad(admittedProposal({ target }));
    expect(roadGoal.previewInputs.length).toBeGreaterThan(0);

    // A ROAD_FRONTAGE prerequisite exists BECAUSE this land has no productive
    // frontage. A road passing through it satisfies ACCESS, which is a different
    // fact about different things (Zone Block cells), so the child must go and
    // try to build one rather than report itself served. Measured live
    // (2026-09-30): twenty such children completed `ROAD_ALREADY_CONNECTED` at
    // one unchanged target, sixteen of them in a single tick.
    const frontageChild = boundaryHarness({
      activeGoalId: "EXPAND_RESIDENTIAL:residential:facts:fixture:prerequisite:ROAD_FRONTAGE:1:abcdef0123456789",
    });
    const childResult = await frontageChild.boundary.preflightRoad(admittedProposal({ target }));
    expect(childResult.status).not.toBe("ALREADY_CONNECTED");
    expect(frontageChild.previewInputs.length).toBeGreaterThan(0);
  });

  test("never offers a course the world has already been shown not to contain", async () => {
    // The live loop: one real `OBSERVED_MISMATCH` followed by sixteen
    // `FAILED_BEFORE_SUBMIT` commands of one unchanged 33.9 m course, across nine
    // successive Goal work orders. `foundation.ts` already says the next attempt
    // after a proven-absent readback is a NEW command — and a new command over
    // the SAME course is not a new attempt, it is the same question asked again.
    const target = admissionSelection().candidates[0].target;
    const first = boundaryHarness();
    await first.boundary.preflightRoad(admittedProposal({ target }));
    const offered = first.previewInputs[0] as { prefab: string; x1: number; z1: number; x2: number; z2: number };
    expect(offered).toBeDefined();

    const replay = boundaryHarness({ absentCourses: [offered] });
    const result = await replay.boundary.preflightRoad(admittedProposal({ target }));
    const absentKey = roadCourseKey(stableRoadInput(offered));
    expect(absentKey).not.toBeNull();
    // It is not previewed and, above all, not submitted: no attempt means no
    // durable FAILED command for a road the world has already answered.
    expect(replay.previewInputs.map((input) => roadCourseKey(stableRoadInput(input as never))))
      .not.toContain(absentKey);
    expect(replay.roadRequests).toHaveLength(0);
    if (result.status === "NO_FEASIBLE_CANDIDATE") {
      expect(result.reason).toContain("proved absent");
    }
  });

  test("preflights the bounded fallback before Gate1 admission and reuses its selected quote", async () => {
    let previews = 0;
    const { boundary, roadRequests, previewInputs } = boundaryHarness({
      preview: (input) => {
        previews += 1;
        if (previews === 1) {
          throw Object.assign(new Error("operation blocked by game validation"), {
            status: 409,
            nativeToolErrors: [{ errorType: "SteepSlope" }],
            bridgeHttpErrorDiagnostics: { source: "bridge-http-error" },
          });
        }
        return productivePreview(input);
      },
    });
    const proposal = admittedProposal({ target: admissionSelection().candidates[0].target });
    const preflight = await boundary.preflightRoad!(proposal);
    expect(preflight).toEqual({ status: "FEASIBLE" });
    const outcome = await boundary.execute(proposal);
    expect(outcome.status).toBe("DELIVERED");
    expect(previewInputs).toHaveLength(2);
    expect(roadRequests).toHaveLength(1);
    expect(roadRequests[0].proposal.input).toEqual(previewInputs[1]);
    expect(previews).toBe(2);
  });

  /**
   * THREE FAMILY NAIL TESTS REMOVED WITH THE FAMILIES THEY PINNED (2026-10-02).
   *
   * The Gate1 course family is now `[...directed, ...grid]`. The three families
   * these tests existed for are gone from it, so the tests were asserting
   * behaviour nothing produces any more:
   *
   *   - "switches to Local Mayor generic road candidates after every starter
   *     candidate fails native preflight" — the generic endpoint fan.
   *   - "falls through to the measured heading × length sweep when every bounded
   *     course is refused" — the swept heading x length family. Its successor is
   *     `buildRoadGridCandidates`, whose "another length, then the next grid node"
   *     fall-through is asserted in `v2-road-grid-generator.spec.ts` ("uses only
   *     the 40/80/120 cadence", "offers perpendicular turns ahead of collinear
   *     continuation").
   *   - "aims generic Road fallback candidates toward the durable prerequisite
   *     target" — the same generic fan. The grid family is deliberately NOT
   *     target-aimed: it may only run on world axes, which is the property
   *     `v2-road-grid-generator.spec.ts` asserts instead ("lays every course on a
   *     world axis, whatever the seed road's bearing").
   *
   * `road-course-sweep.ts` itself is retained: `road-intent.ts` (ROAD{from,to})
   * still uses it. Only its membership in the Gate1 family was removed.
   */

  /**
   * A work order that carries the course a planner compiled must submit THAT
   * course, and must bind it at its own START.
   *
   * Resolving the source node from the far end instead is how the planned
   * segment stopped being the segment that got built: the course then runs from
   * whichever node happens to sit nearest the target, at a different heading and
   * a different reach. The fixture's two nodes are 30 m apart with the planned
   * start on one and the planned end nearest the other, so the two answers are
   * different courses and only one of them is the plan.
   */
  test("submits a work order's planned course from the node nearest its own start", async () => {
    const roadCourse = { start: { x: 0, z: 0 }, end: { x: 30, z: 20 } };
    const targetPoint = roadCourse.end;
    const target = goalDirectedSelection(scanPayload, targetPoint).candidates[0].target;

    const planned = boundaryHarness({ targetPoint, roadCourse });
    expect((await planned.boundary.preflightRoad!(admittedProposal({ target }))).status).toBe("FEASIBLE");
    const first = planned.previewInputs[0] as RoadGeometryInput;
    expect(first.x1).toBeCloseTo(0, 6);
    expect(first.z1).toBeCloseTo(0, 6);
    expect(first.x2).toBeCloseTo(30, 6);
    expect(first.z2).toBeCloseTo(20, 6);

    // Without a planned course the same work order still resolves from the far
    // end — which is the behaviour this replaced, and the reason the course was
    // never the planned one.
    const unplanned = boundaryHarness({ targetPoint });
    expect((await unplanned.boundary.preflightRoad!(admittedProposal({ target }))).status).toBe("FEASIBLE");
    expect((unplanned.previewInputs[0] as RoadGeometryInput).x1).toBeCloseTo(30, 6);
  });

  /**
   * REMOVED WITH THE GENERIC FAMILY (2026-10-02): "rebinds a locked source road
   * to an available compatible prefab for expansion" asserted that the generic
   * endpoint fan offered only catalogue prefabs. The grid family carries that
   * property by construction — `buildRoadGridCandidates` takes a single
   * caller-supplied `prefab` and stamps every course with it, so no course it
   * emits can name a locked one. The starter family's own prefab binding is still
   * covered by "preflights the bounded fallback before Gate1 admission and reuses
   * its selected quote" above.
   */


  test("reproduces an ingress-seed target even though the world owns local frontage", async () => {
    // The regression this pins: the replay used the composite selector, which
    // returns LOCAL anchors whenever the world has any, so a target the admission
    // produced from the ingress fallback could never be reproduced and ROAD
    // stalled at SITE_SELECTED with GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED.
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan(ingressScanPayload));
    expect(selectLocalStarterSiteAnchors(world, 24).length).toBeGreaterThan(0);
    expect(selectBoundedStarterSiteAnchors(world, 24)).toEqual(selectLocalStarterSiteAnchors(world, 24));

    const ingress = ingressSelection();
    expect(ingress.candidates).toHaveLength(1);
    const expected = ingress.candidates[0];
    const expectedRoad = expected.roadCandidates[0];
    expect(expectedRoad).toBeDefined();
    // The local class cannot produce this target, so only the escalation can.
    const localTargets = selectionFor(ingressScanPayload, selectLocalStarterSiteAnchors).candidates.map(
      (candidate) => `${candidate.target.center.x}:${candidate.target.center.z}`,
    );
    expect(localTargets).not.toContain(`${expected.target.center.x}:${expected.target.center.z}`);

    const { boundary, roadRequests } = boundaryHarness({ scan: ingressScanPayload });
    const outcome = await boundary.execute(admittedProposal({ target: expected.target }));

    expect(outcome.status).toBe("DELIVERED");
    expect(outcome.observedMatch).toBe(true);
    expect(roadRequests).toHaveLength(1);
    expect(roadRequests[0].proposal.input).toEqual(expectedRoad.input);
  });

  test("previews and submits the durable concrete child input without replaying target candidate search", async () => {
    const input = { prefab: "Small Road", x1: 30, z1: -10, x2: -40, z2: -35 };
    const courseFingerprint = stableRoadInput(input);
    const proposal = admittedProposal({
      target: { center: { x: 0, z: 0 }, radius: 28 },
      concreteChildOperation: {
        amendmentId: "utility-service-road-child-1",
        planRevision: "project-replan:branch-a",
        input,
        courseFingerprint,
      },
    });
    const { boundary, roadRequests, previewInputs, consumedChildOperations } = boundaryHarness({ scan: null, detail: null });
    const outcome = await boundary.execute(proposal);
    expect(outcome.status).toBe("DELIVERED");
    expect(previewInputs).toEqual([input]);
    expect(roadRequests[0].proposal.input).toEqual(input);
    expect(consumedChildOperations).toEqual([{ amendmentId: proposal.concreteChildOperation!.amendmentId, courseFingerprint }]);
  });

  test("a target that the bounded evaluation cannot reproduce fails closed", async () => {
    const { boundary, roadRequests } = boundaryHarness();
    const outcome = await boundary.execute(
      admittedProposal({ target: { center: { x: 9_000, z: 9_000 }, radius: 28 } }),
    );

    expect(outcome.status).not.toBe("DELIVERED");
    expect(outcome.observedMatch).toBe(false);
    expect(outcome.reason).toContain("GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED");
    expect(roadRequests).toHaveLength(0);
  });

  test("an unavailable spatial scan fails closed instead of guessing geometry", async () => {
    const selection = admissionSelection();
    const { boundary, roadRequests } = boundaryHarness({ scan: null });
    const outcome = await boundary.execute(admittedProposal({ target: selection.candidates[0].target }));

    expect(outcome.status).not.toBe("DELIVERED");
    expect(outcome.reason).toContain("GATE1_PROGRESSION");
    expect(roadRequests).toHaveLength(0);
  });

  test("ZONING resolves exact residential cells through the durable native kernel", async () => {
    const { boundary } = boundaryHarness();
    const proposal = admittedProposal({
      target: { center: { x: 32, z: 0 }, radius: 28 },
      skill: "Zoning",
      actionFamily: "ZONING",
      operation: "ZONE_RESIDENTIAL",
      requiredStage: "ROAD_DELIVERED",
    });

    const outcome = await boundary.execute(proposal);
    expect(outcome).toMatchObject({ status: "DELIVERED", observedMatch: true, commandId: "command:zone-1" });
  });

  /**
   * An OFFICE scope's ZONING step asks for the office zone.
   *
   * The category used to be produced by `landUse.toLowerCase() as
   * "residential" | "commercial" | "industrial"` — a cast that re-labelled an
   * office scope with a narrower union — and the zone reader's surface named
   * only R/C/I with a catch-all that answered "Industrial" for everything else.
   * Together they authorized cells as `office` and applied an industrial prefab,
   * which the authoritative readback proved never happened. Measured live
   * (2026-10-01): `OBSERVED_MISMATCH` / `effectAbsenceProven` over nine cells
   * that were free and roadside.
   */
  test("a ZONING step asks for the scope's own zone category, office included", async () => {
    const asked: string[] = [];
    const { boundary } = boundaryHarness({
      landUse: "OFFICE",
      readZoneCategory: async (zone) => { asked.push(zone); return "EU Office Low"; },
    });
    const outcome = await boundary.execute(admittedProposal({
      target: { center: { x: 32, z: 0 }, radius: 28 },
      skill: "Zoning", actionFamily: "ZONING", operation: "ZONE_RESIDENTIAL", requiredStage: "ROAD_DELIVERED",
    }));
    expect(outcome.status).toBe("DELIVERED");
    expect(asked).toEqual(["office"]);
  });

  test("an unadmitted proposal is rejected before any resolver runs", async () => {
    const { boundary, roadRequests, previewInputs } = boundaryHarness();
    const proposal = { ...admittedProposal({ target: { center: { x: 32, z: 0 }, radius: 28 } }), admission: undefined };

    const outcome = await boundary.execute(proposal as unknown as Gate1AdmittedProposal);

    expect(outcome).toMatchObject({ status: "REJECTED", commandId: null, observedMatch: false });
    expect(roadRequests).toHaveLength(0);
    expect(previewInputs).toHaveLength(0);
  });

  // `Gate1WorldBoundary.recover` is the declaration that lets a tranche enter
  // RECOVERING. This boundary performs no scope-local repair, so declaring none
  // is exactly what makes every occupancy diagnosis the Goal's own named
  // terminal instead of a dispatch to a resolver that does not exist. Asserted
  // here because adding one later silently moves where a diagnosis goes.
  test("declares no recovery resolver, so an occupancy diagnosis settles the Goal instead", () => {
    const { boundary } = boundaryHarness();
    expect(boundary.recover).toBeUndefined();
  });

  test("a RECOVER proposal has no resolver on the generic execution port", async () => {
    const { boundary, roadRequests } = boundaryHarness();
    const proposal = admittedProposal({ target: { center: { x: 32, z: 0 }, radius: 28 } });

    const outcome = await boundary.execute({
      ...proposal,
      skill: "BoundedRecovery",
      actionFamily: "ROAD",
      operation: "RECOVER",
    } as Gate1AdmittedProposal);

    expect(outcome).toMatchObject({ status: "REJECTED", reason: "no bounded Foundation resolver for proposal" });
    expect(roadRequests).toHaveLength(0);
  });
});
