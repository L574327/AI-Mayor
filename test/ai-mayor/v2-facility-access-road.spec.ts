import {
  FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX,
  FACILITY_ACCESS_ROAD_PREFAB,
  FACILITY_ACCESS_ROAD_REPAIR,
  facilityAccessRoadCourseCandidates,
  facilityAccessRoadRepairAttemptIndexFromLineage,
  facilityAccessRoadRepairLineage,
  facilityAccessRoadRepairVerdict,
  isDuplicateAccessRoad,
  nextFacilityAccessRoadRepairAttemptIndex,
  segmentDistance,
  selectFacilityAccessRoadCourse,
  type FacilityAccessRoadCandidate,
  type FacilityAccessRoadCourseRequest,
} from "../../src/main/services/ai-mayor/v2/facility-access-road";
import {
  createDurableGreenfieldUtilityState,
  runScopedGreenfieldUtilityBootstrap,
  type DurableGreenfieldUtilityState,
  type GreenfieldUtilityExecutionScope,
  type GreenfieldUtilityKind,
  type GreenfieldUtilityServiceEvidence,
  type ScopedGreenfieldUtilityPorts,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  type SaveCompletionReceipt,
  type V2DurableStateStorage,
} from "../../src/main/services/ai-mayor/v2/durability";
import {
  planStarterResidentialIntent,
  type Gate1State,
} from "../../src/main/services/ai-mayor/v2/gate1";
import { V2_PROJECT_ADMISSION_POLICY } from "../../src/main/services/ai-mayor/v2/project-admission";
import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import { roadCourseGeometry } from "../../src/main/services/ai-mayor/v2/road-kernel";
import {
  FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON,
  admitFacilityAccessRoadBudgetAmendment,
  type UtilityAccessRoadRepairProof,
} from "../../src/main/services/ai-mayor/v2/utility-budget";
import {
  buildUtilityConnectionCandidates,
  prepareSharedUtilityRecovery,
  type UtilityConnectorReadback,
} from "../../src/main/services/ai-mayor/utility-recovery";
import type { PlannedUtilityFacility, SpatialPoint2, SpatialRoadEdge } from "../../src/main/services/ai-mayor/spatial/types";
import type { MayorAction } from "../../src/main/services/ai-mayor/types";

const point = (x: number, z: number): SpatialPoint2 => ({ x, z });

// ---------------------------------------------------------------------------
// The pure ladder
// ---------------------------------------------------------------------------

/**
 * An orthogonal objective on the +z bearing and an admitted course down the very
 * same corridor, which is the case the repair exists for: the plan's road is
 * refused because the pipe already occupies the corridor it was planned down.
 *
 * The arithmetic is chosen so every property can be read off by hand: the
 * lateral axis is -x, the clearance is `halfExtent + 4` = 24, and the three
 * non-zero rungs are 26, 32 and 40.
 */
const HALF_EXTENT = 20;
const SPAN = 150;
const CLEARANCE = HALF_EXTENT + 4;
const FACILITY = { position: point(0, SPAN), halfExtent: HALF_EXTENT };

function courseRequest(overrides: Partial<FacilityAccessRoadCourseRequest> = {}): FacilityAccessRoadCourseRequest {
  return {
    objective: { start: point(0, 0), end: point(0, SPAN) },
    admittedCourse: { prefab: "Small Water Pipe", start: point(0, SPAN), end: point(0, 0) },
    facility: { position: { ...FACILITY.position }, halfExtent: FACILITY.halfExtent },
    facilityServicePoint: point(0, SPAN - HALF_EXTENT - 1),
    envelope: { center: point(0, SPAN / 2), radius: 200 },
    prefab: "Small Road",
    maximumCandidates: 8,
    ...overrides,
  };
}

const endpointsOf = (candidate: FacilityAccessRoadCandidate) => {
  const action = candidate.actions[0];
  if (action.type !== "build_road") throw new Error("an access course is a road");
  return { start: point(action.x1, action.z1), end: point(action.x2, action.z2) };
};

const length = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(a.x - b.x, a.z - b.z);

describe("bounded facility access road courses", () => {
  test("every course clears the admitted corridor, stays in the envelope and avoids the footprint", () => {
    const request = courseRequest();
    const candidates = facilityAccessRoadCourseCandidates(request);
    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      const { start, end } = endpointsOf(candidate);
      // The whole course, not just its far end: a course that hugs the pipe is
      // the course the world already refused.
      expect(segmentDistance(start, end, request.admittedCourse.start, request.admittedCourse.end))
        .toBe(candidate.offsetFromAdmittedCourse);
      expect(candidate.offsetFromAdmittedCourse).toBeGreaterThanOrEqual(0);
      for (const endpoint of [start, end]) {
        expect(length(endpoint, request.envelope.center)).toBeLessThanOrEqual(request.envelope.radius);
        expect(length(endpoint, request.facility.position)).toBeGreaterThan(request.facility.halfExtent);
      }
      expect(candidate.actions).toHaveLength(1);
      expect(candidate.actions[0]).toMatchObject({ type: "build_road", prefab: request.prefab });
    }
  });

  test("is deterministic and compares pipe clearance after service validity", () => {
    const request = courseRequest();
    const first = facilityAccessRoadCourseCandidates(request);
    const second = facilityAccessRoadCourseCandidates(courseRequest());
    expect(second).toEqual(first);

    const offsets = first.map((candidate) => candidate.offsetFromAdmittedCourse);
    expect(offsets).toEqual([...offsets].sort((left, right) => right - left));
    expect(offsets[0]).toBeGreaterThanOrEqual(offsets[offsets.length - 1]);
  });

  test("never offers the objective's own refused course", () => {
    const request = courseRequest();
    const refusedCourse = JSON.stringify([
      { type: "build_road", prefab: request.prefab, x1: 0, z1: 0, x2: 0, z2: SPAN },
    ]);
    for (const candidate of facilityAccessRoadCourseCandidates(request)) {
      expect(JSON.stringify(candidate.actions)).not.toBe(refusedCourse);
      // Candidates terminate at the plan's service point.
      const { start, end } = endpointsOf(candidate);
      expect(length(request.facilityServicePoint, start) >= 0).toBe(true);
      expect(end).toEqual(request.facilityServicePoint);
    }
  });

  test("is bounded by maximumCandidates and by the ladder itself", () => {
    expect(facilityAccessRoadCourseCandidates(courseRequest({ maximumCandidates: 1 }))).toHaveLength(1);
    expect(facilityAccessRoadCourseCandidates(courseRequest({ maximumCandidates: 2 }))).toHaveLength(2);
    expect(facilityAccessRoadCourseCandidates(courseRequest({ maximumCandidates: 0 }))).toEqual([]);
    expect(facilityAccessRoadCourseCandidates(courseRequest({ maximumCandidates: -5 }))).toEqual([]);
    // The ladder has four bounded offsets, each with three contractions.
    const bounded = facilityAccessRoadCourseCandidates(courseRequest({ maximumCandidates: 1_000 }));
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.length).toBeLessThanOrEqual(24);
  });

  test("keeps a course out of the facility footprint", () => {
    // The starting end is kept outside the facility footprint; the other end is
    // the facility service point and is allowed to touch its footprint boundary.
    const request = courseRequest({ facility: { position: point(HALF_EXTENT + 6, SPAN), halfExtent: HALF_EXTENT } });
    const candidates = facilityAccessRoadCourseCandidates(request);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const { start, end } = endpointsOf(candidate);
      expect(length(start, request.facility.position)).toBeGreaterThan(HALF_EXTENT);
      expect(end).toEqual(request.facilityServicePoint);
    }
    expect(candidates.every((candidate) => length(endpointsOf(candidate).start, request.facility.position) > HALF_EXTENT)).toBe(true);
  });

  test("returns nothing when the envelope cannot hold a course or the request is degenerate", () => {
    expect(facilityAccessRoadCourseCandidates(courseRequest({ envelope: { center: point(0, 0), radius: 1 } }))).toEqual([]);
    expect(facilityAccessRoadCourseCandidates(courseRequest({ envelope: { center: point(0, 0), radius: 0 } }))).toEqual([]);
    expect(facilityAccessRoadCourseCandidates(courseRequest({ objective: { start: point(0, 0), end: point(0, 0) } }))).toEqual([]);
    expect(facilityAccessRoadCourseCandidates(courseRequest({ facility: { position: point(0, SPAN), halfExtent: -1 } }))).toEqual([]);
  });

  test("measures a proper crossing as zero distance, which endpoint gaps cannot see", () => {
    // The four endpoint-to-segment distances are all 5, yet the segments cross.
    expect(segmentDistance(point(0, 0), point(10, 0), point(5, -5), point(5, 5))).toBe(0);
    expect(segmentDistance(point(0, 0), point(10, 0), point(10, 0), point(20, 0))).toBe(0);
    expect(segmentDistance(point(0, 0), point(10, 0), point(0, 5), point(10, 5))).toBe(5);
    expect(segmentDistance(point(0, 0), point(10, 0), point(20, 0), point(30, 0))).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const LADDER = facilityAccessRoadCourseCandidates(courseRequest({ maximumCandidates: 4 }));

const worldEdge = (start: SpatialPoint2, end: SpatialPoint2, prefab = "Small Road", deleted = false): SpatialRoadEdge => ({
  entity: { index: 900, version: 1 },
  prefab,
  native: true,
  deleted,
  startNode: { index: 901, version: 1 },
  endNode: { index: 902, version: 1 },
  start: { ...start },
  end: { ...end },
  length: length(start, end),
});

describe("selecting one facility access road course", () => {
  test("rejects a short high-clearance contraction that never reaches the service point", async () => {
    const bad: FacilityAccessRoadCandidate = {
      actions: [{ type: "build_road", prefab: "Small Road", x1: 80, z1: 20, x2: 80, z2: 70 }],
      offsetFromAdmittedCourse: 500,
      reason: "short-clearance-rich",
    };
    const valid = LADDER[0];
    const preflighted: FacilityAccessRoadCandidate[] = [];
    const selected = await selectFacilityAccessRoadCourse({
      candidates: [bad, valid], facilityServicePoint: courseRequest().facilityServicePoint,
      preflight: async (candidate) => { preflighted.push(candidate); return { accepted: true, quote: 10 }; },
    });
    expect(selected).toMatchObject({ status: "SELECTED", candidate: valid });
    expect(preflighted).toEqual([valid]);
  });

  test("fails closed when every candidate misses the facility service point", async () => {
    const misses = LADDER.map((candidate) => ({
      ...candidate,
      actions: [{ type: "build_road" as const, prefab: "Small Road", x1: 500, z1: 500, x2: 501, z2: 501 }],
    }));
    const selected = await selectFacilityAccessRoadCourse({
      candidates: misses, facilityServicePoint: courseRequest().facilityServicePoint,
      preflight: async () => { throw new Error("invalid candidate reached preflight"); },
    });
    expect(selected).toMatchObject({ status: "REFUSED" });
    if (selected.status === "REFUSED") {
      expect(selected.reasons.every((reason) => reason.startsWith("INVALID_ACCESS_ROAD_COURSE:"))).toBe(true);
    }
  });

  test("selects deterministically from multiple functional candidates with valid native previews", async () => {
    const preflighted: FacilityAccessRoadCandidate[] = [];
    const selected = await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0], LADDER[1]], facilityServicePoint: courseRequest().facilityServicePoint,
      preflight: async (candidate) => { preflighted.push(candidate); return { accepted: true, quote: 321 }; },
    });
    expect(selected).toEqual({ status: "SELECTED", candidate: LADDER[0], quote: 321 });
    expect(preflighted).toEqual([LADDER[0]]);
  });

  test("takes the first course the world accepts and quotes", async () => {
    const preflighted: FacilityAccessRoadCandidate[] = [];
    const selection = await selectFacilityAccessRoadCourse({
      candidates: LADDER,
      preflight: async (candidate) => {
        preflighted.push(candidate);
        return { accepted: true, quote: 1_234 };
      },
    });
    expect(selection).toEqual({ status: "SELECTED", candidate: LADDER[0], quote: 1_234 });
    expect(preflighted).toEqual([LADDER[0]]);
  });

  test("moves down the ladder and keeps every refusal reason", async () => {
    const selection = await selectFacilityAccessRoadCourse({
      candidates: LADDER,
      preflight: async (candidate) => {
        if (candidate === LADDER[0]) return { accepted: false, quote: null, reason: "native_refused_near_pipe" };
        if (candidate === LADDER[1]) return { accepted: true, quote: null };
        return { accepted: true, quote: 7 };
      },
    });
    if (selection.status !== "SELECTED") throw new Error(`expected a selection, received ${selection.status}`);
    expect(selection.candidate).toBe(LADDER[2]);
    expect(selection.quote).toBe(7);
  });

  test("refuses when every course is refused, with one reason per rung", async () => {
    const selection = await selectFacilityAccessRoadCourse({
      candidates: LADDER,
      preflight: async () => ({ accepted: false, quote: null, reason: "native_refused" }),
    });
    expect(selection.status).toBe("REFUSED");
    if (selection.status !== "REFUSED") return;
    expect(selection.reasons).toEqual(LADDER.map(() => "native_refused"));
  });

  test("skips a course the world already carries instead of re-validating it", async () => {
    const { start, end } = endpointsOf(LADDER[0]);
    const preflighted: FacilityAccessRoadCandidate[] = [];
    const selection = await selectFacilityAccessRoadCourse({
      candidates: LADDER,
      worldEdges: [worldEdge(start, end)],
      preflight: async (candidate) => {
        preflighted.push(candidate);
        return { accepted: true, quote: 42 };
      },
    });
    if (selection.status !== "SELECTED") throw new Error(`expected a selection, received ${selection.status}`);
    expect(selection.candidate).toBe(LADDER[1]);
    expect(preflighted).toEqual([LADDER[1]]);
  });

  test("a duplicate is orientation-independent and prefab-specific", async () => {
    const { start, end } = endpointsOf(LADDER[0]);
    const refused = await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]],
      // The native edge stores node order, not the order the course was submitted in.
      worldEdges: [worldEdge(end, start)],
      preflight: async () => ({ accepted: true, quote: 5 }),
    });
    expect(refused.status).toBe("REFUSED");
    if (refused.status === "REFUSED") expect(refused.reasons[0]).toContain("DUPLICATE_ACCESS_ROAD_COURSE");

    const otherPrefab = await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]],
      worldEdges: [worldEdge(start, end, "Medium Road")],
      preflight: async () => ({ accepted: true, quote: 5 }),
    });
    expect(otherPrefab.status).toBe("SELECTED");

    const deleted = await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]],
      worldEdges: [worldEdge(start, end, "Small Road", true)],
      preflight: async () => ({ accepted: true, quote: 5 }),
    });
    expect(deleted.status).toBe("SELECTED");

    // Within tolerance is the same course; outside it, it is not.
    const nearEdge = worldEdge(start, point(end.x + 0.5, end.z));
    expect(await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]], worldEdges: [nearEdge], tolerance: 0.25,
      preflight: async () => ({ accepted: true, quote: 5 }),
    })).toMatchObject({ status: "SELECTED" });
    expect(await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]], worldEdges: [nearEdge], tolerance: 1,
      preflight: async () => ({ accepted: true, quote: 5 }),
    })).toMatchObject({ status: "REFUSED" });
  });

  test("an unreadable or negative quote cannot fund the course it is attached to", async () => {
    expect(await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]], preflight: async () => ({ accepted: true, quote: Number.NaN }),
    })).toMatchObject({ status: "REFUSED", reasons: [expect.stringContaining("ACCESS_ROAD_QUOTE_UNKNOWN")] });
    expect(await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]], preflight: async () => ({ accepted: true, quote: -1 }),
    })).toMatchObject({ status: "REFUSED" });
    // A free course is still a course.
    expect(await selectFacilityAccessRoadCourse({
      candidates: [LADDER[0]], preflight: async () => ({ accepted: true, quote: 0 }),
    })).toMatchObject({ status: "SELECTED", quote: 0 });
  });

  test("a non-road action is never treated as a duplicate of a road edge", () => {
    const zone: MayorAction = { type: "zone", zone: "residential", x: 0, z: 0, radius: 10 };
    expect(isDuplicateAccessRoad({ action: zone, worldEdges: [worldEdge(point(0, 0), point(10, 10))], tolerance: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The precondition verdict
// ---------------------------------------------------------------------------

describe("facility access road repair verdict", () => {
  const permitted = {
    kind: "water",
    facilityPlacement: "PLACED",
    connectionEffect: "OBSERVED_MATCH",
    roadAttachment: "NONE",
    noRoadAccessWarning: true,
    cityElectricityCapacitySufficient: true,
    planServiceRoadCount: 1,
    priorRepairCommandCount: 0,
    duplicateRoadRisk: false,
  } as const;

  const expected = (reason: string) => ({ status: "REFUSED", reason });

  test("permits the repair for a placed, connected, road-less water facility only", () => {
    expect(facilityAccessRoadRepairVerdict({ ...permitted })).toEqual({ status: "PERMITTED" });
  });

  test("refuses every family that is not adjudicated in this round", () => {
    for (const kind of ["electricity", "sewage"] as const) {
      expect(facilityAccessRoadRepairVerdict({ ...permitted, kind }))
        .toEqual(expected(`ACCESS_ROAD_REPAIR_KIND_NOT_ADJUDICATED:${kind}`));
    }
  });

  test("refuses every facility placement that is not a proven placement", () => {
    for (const placement of ["MISSING", "UNRESOLVED", "UNPROVEN", "NONE"] as const) {
      expect(facilityAccessRoadRepairVerdict({ ...permitted, facilityPlacement: placement }))
        .toEqual(expected(`ACCESS_ROAD_REPAIR_FACILITY_NOT_PLACED:${placement}`));
    }
  });

  test("refuses a connection that is not an observed match", () => {
    for (const effect of ["NONE", "OBSERVED_MISMATCH", "SUBMITTED", "UNKNOWN"]) {
      expect(facilityAccessRoadRepairVerdict({ ...permitted, connectionEffect: effect }))
        .toEqual(expected(effect === "UNKNOWN"
          ? "ACCESS_ROAD_REPAIR_CONNECTION_NOT_OBSERVED_MATCH_UNKNOWN"
          : `ACCESS_ROAD_REPAIR_CONNECTION_NOT_OBSERVED_MATCH:${effect}`));
    }
  });

  test("refuses an unreadable frontage and a frontage that is already there", () => {
    expect(facilityAccessRoadRepairVerdict({ ...permitted, roadAttachment: "UNKNOWN" }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_ROAD_ATTACHMENT_UNKNOWN"));
    expect(facilityAccessRoadRepairVerdict({ ...permitted, roadAttachment: "ATTACHED" }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_ROAD_ALREADY_ATTACHED:ATTACHED"));
  });

  test("refuses an absent or unreadable road-access warning", () => {
    expect(facilityAccessRoadRepairVerdict({ ...permitted, noRoadAccessWarning: false }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_NO_ROAD_ACCESS_WARNING_ABSENT:false"));
    expect(facilityAccessRoadRepairVerdict({ ...permitted, noRoadAccessWarning: "UNKNOWN" }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_NO_ROAD_ACCESS_WARNING_ABSENT_UNKNOWN"));
  });

  test("refuses a city that cannot already supply the power, because generation is forbidden", () => {
    expect(facilityAccessRoadRepairVerdict({ ...permitted, cityElectricityCapacitySufficient: false }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_CITY_ELECTRICITY_CAPACITY_INSUFFICIENT:false"));
    expect(facilityAccessRoadRepairVerdict({ ...permitted, cityElectricityCapacitySufficient: "UNKNOWN" }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_CITY_ELECTRICITY_CAPACITY_INSUFFICIENT_UNKNOWN"));
  });

  test("refuses a plan that never carried a service road, and any number of them", () => {
    expect(facilityAccessRoadRepairVerdict({ ...permitted, planServiceRoadCount: 0 }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_PLAN_SERVICE_ROAD_MISSING:0"));
    expect(facilityAccessRoadRepairVerdict({ ...permitted, planServiceRoadCount: Number.NaN }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_PLAN_SERVICE_ROAD_MISSING:NaN"));
  });

  test("admits the bounded sequence of repair attempts and closes the lineage at its ceiling", () => {
    // The product ruling this pins down is bounded sequential amendments, not
    // one repair ever: a prior attempt spends one ordinal of the lineage, and
    // every ordinal below the ceiling is admitted on the same terms as the
    // first. What is refused is the attempt past the ceiling, which is what
    // keeps "the lineage may try again" from being "forever".
    for (let priorRepairCommandCount = 0;
      priorRepairCommandCount < FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX;
      priorRepairCommandCount += 1) {
      expect(facilityAccessRoadRepairVerdict({ ...permitted, priorRepairCommandCount }))
        .toEqual({ status: "PERMITTED" });
    }
    for (const priorRepairCommandCount of [
      FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX,
      FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX + 1,
    ]) {
      expect(facilityAccessRoadRepairVerdict({ ...permitted, priorRepairCommandCount }))
        .toEqual(expected(`ACCESS_ROAD_REPAIR_PRIOR_REPAIR_ALREADY_COMMANDED:${priorRepairCommandCount}`));
    }
  });

  test("refuses an unreadable duplicate-road risk and a real one", () => {
    expect(facilityAccessRoadRepairVerdict({ ...permitted, duplicateRoadRisk: "UNKNOWN" }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_DUPLICATE_ROAD_RISK_UNKNOWN"));
    expect(facilityAccessRoadRepairVerdict({ ...permitted, duplicateRoadRisk: true }))
      .toEqual(expected("ACCESS_ROAD_REPAIR_DUPLICATE_ROAD_RISK:true"));
  });
});

// ---------------------------------------------------------------------------
// The one budget amendment
// ---------------------------------------------------------------------------

const INSTANT = new Date("2026-01-02T03:04:05.000Z");
const SESSION_A = "11111111111111111111111111111111";
const SAVE_A = "save:meta-a:data-a";
const TREASURY = 957_298;
const ADMITTED_BUDGET = 25_000;
const ACCESS_ROAD_QUOTE = 168;

function world() {
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${SESSION_A}`,
      nativeSessionGuid: SESSION_A,
      loadPurpose: "NewGame" as const,
      loadAssetGuid: null,
      saveDataAssetGuid: null,
      mapAssetGuid: "map-a",
      checkpointId: null,
      bridgeRuntimeEpoch: "bridge-a",
      generation: "generation-a",
      generationSequence: 1,
      generationOrigin: "LOAD_COMPLETED",
    },
  };
}

function receipt(checkpointId: string): SaveCompletionReceipt {
  const [, metadata, data] = checkpointId.split(":");
  return {
    status: "COMPLETED",
    durable: true,
    worldId: `cs2-session:${SESSION_A}`,
    worldGeneration: "generation-a",
    checkpoint: {
      checkpointId,
      saveMetadataAssetGuid: metadata,
      saveDataAssetGuid: data,
      nativeSessionGuid: SESSION_A,
    },
  };
}

function activatedWorld(storage: V2DurableStateStorage = createMemoryDurableStateStorage()) {
  const first = new V2DurabilityCoordinator(storage);
  first.activate(world());
  first.recordBaselineCheckpoint(receipt(SAVE_A));
  const coordinator = new V2DurabilityCoordinator(storage);
  const activation = coordinator.activate(world());
  if (!coordinator.isExecutionDurablyActivated(activation)) throw new Error("fixture world is not durably activated");
  return { coordinator, activation };
}

function roadDeliveredState(): Gate1State {
  const state = planStarterResidentialIntent({
    intentId: "intent:access-road",
    targetResidents: 12,
    maximumBudget: ADMITTED_BUDGET,
    planningEnvelope: { center: point(6.638, 1388.618), radius: 200 },
    siteCandidates: [{ id: "site-1", target: { center: point(6.638, 1388.618), radius: 200 }, score: 1, blocked: false }],
  }, INSTANT);
  state.tranche.stage = "ROAD_DELIVERED";
  return state;
}

/** The facility landed, its connection is observed, and it still has no frontage. */
const REPAIR_PROOF: UtilityAccessRoadRepairProof = {
  facilityPlaced: true,
  roadAttachment: "NONE",
  accessRoadCommandIds: [],
};

function amendAccessRoad(
  coordinator: V2DurabilityCoordinator,
  activation: ReturnType<typeof activatedWorld>["activation"],
  state: Gate1State,
  options: {
    treasury?: number;
    actualAccessRoadQuote?: number;
    repair?: UtilityAccessRoadRepairProof;
    planRevision?: string;
    courseFingerprint?: string;
    segmentQuotes?: number[];
    actionCount?: number;
    purpose?: string;
    repairLineage?: string;
    repairAttemptIndex?: number;
  } = {},
) {
  return admitFacilityAccessRoadBudgetAmendment({
    durability: coordinator,
    activation,
    state,
    treasury: options.treasury ?? TREASURY,
    policy: V2_PROJECT_ADMISSION_POLICY,
    actualAccessRoadQuote: options.actualAccessRoadQuote ?? ACCESS_ROAD_QUOTE,
    segmentQuotes: options.segmentQuotes,
    actionCount: options.actionCount ?? 1,
    repair: options.repair ?? { ...REPAIR_PROOF },
    amendmentId: `${state.project.id}:utility-access-road-budget-amendment:${options.planRevision ?? "topology:current"}:${options.courseFingerprint ?? "course:repair"}`,
    planRevision: options.planRevision ?? "topology:current",
    courseFingerprint: options.courseFingerprint ?? "course:repair",
    purpose: options.purpose,
    repairLineage: options.repairLineage,
    repairAttemptIndex: options.repairAttemptIndex,
    detail: "test",
  });
}

describe("facility access road budget amendment", () => {
  test("authorizes exactly the repair quote on top of the effective budget", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const stateBefore = structuredClone(state);

    const outcome = amendAccessRoad(coordinator, activation, state);
    if (outcome.status !== "AMENDED") throw new Error(`expected an amendment, received ${outcome.status}`);

    expect(outcome.actualAccessRoadQuote).toBe(ACCESS_ROAD_QUOTE);
    expect(outcome.effectiveProjectBudget).toBe(ADMITTED_BUDGET + ACCESS_ROAD_QUOTE);
    expect(outcome.record.reason).toBe(FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON);
    expect(outcome.record.originalProjectBudget).toBe(ADMITTED_BUDGET);
    expect(outcome.record.requiredUtilityBudget).toBe(ADMITTED_BUDGET + ACCESS_ROAD_QUOTE);
    expect(outcome.record.amendedEffectiveBudget).toBe(ADMITTED_BUDGET + ACCESS_ROAD_QUOTE);
    // Identity is copied verbatim from the project it names.
    expect(outcome.record.projectId).toBe(stateBefore.project.id);
    expect(outcome.record.trancheId).toBe(stateBefore.tranche.id);
    expect(outcome.record.reservationRef).toBe(stateBefore.tranche.reservationRef);
    // The admitted budget is corrected, never rewritten.
    expect(state).toEqual(stateBefore);
  });

  test("is idempotent on resume and refuses a quote that moved", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();

    const first = amendAccessRoad(coordinator, activation, state);
    expect(first.status).toBe("AMENDED");
    const recordsAfterFirst = coordinator.utilityBudgetAmendments().length;
    expect(recordsAfterFirst).toBe(1);

    const second = amendAccessRoad(coordinator, activation, state);
    expect(second.status).toBe("ALREADY_AMENDED");
    if (second.status !== "ALREADY_AMENDED") return;
    expect(second.actualAccessRoadQuote).toBe(ACCESS_ROAD_QUOTE);
    expect(second.effectiveProjectBudget).toBe(ADMITTED_BUDGET + ACCESS_ROAD_QUOTE);
    // One record per (project, reason): a resume appends nothing.
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(recordsAfterFirst);
    expect(coordinator.utilityBudgetAmendments()
      .filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)).toHaveLength(1);

    // A moved course is a new authoritative conflict, not a second amendment.
    expect(() => amendAccessRoad(coordinator, activation, state, { actualAccessRoadQuote: ACCESS_ROAD_QUOTE + 1 }))
      .toThrow("FACILITY_ACCESS_ROAD_BUDGET_AMENDMENT_QUOTE_CHANGED");
  });

  test("repair authorization mint is lineage-idempotent and never reopens a consumed grant", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const args = {
      actualAccessRoadQuote: 468,
      segmentQuotes: [468],
      actionCount: 1,
      planRevision: "plan:repair:3",
      courseFingerprint: "exact-single-road-action",
      repairLineage: "lineage:repair:3",
      purpose: "Pump native road attachment repair",
    };
    const first = amendAccessRoad(coordinator, activation, state, args);
    expect(first.status).toBe("AMENDED");
    const resumed = amendAccessRoad(coordinator, activation, state, args);
    expect(resumed.status).toBe("ALREADY_AMENDED");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);

    expect(() => amendAccessRoad(coordinator, activation, state, { ...args, actionCount: 2 }))
      .toThrow("FACILITY_REPAIR_MULTI_ACTION_NOT_CERTIFIED");
    // Amendment admission retains its established unused-supersession policy;
    // the production repair entry rejects conflicting active records before
    // reaching this primitive. Same-lineage exact retries remain idempotent.

    const consumed = coordinator.consumeAccessRoadBudgetAmendment(first.record.amendmentId, args.courseFingerprint);
    expect(consumed.executionUseStatus).toBe("CONSUMED");
    expect(() => amendAccessRoad(coordinator, activation, state, args))
      .toThrow("FACILITY_ACCESS_ROAD_AUTHORIZATION_MINT_ALREADY_FINALIZED");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(1);
  });

  test("supersedes an unused authorization and funds only the new course quote", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const first = amendAccessRoad(coordinator, activation, state);
    expect(first.status).toBe("AMENDED");
    const second = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: ACCESS_ROAD_QUOTE + 17,
      planRevision: "topology:revised",
      courseFingerprint: "course:revised",
    });
    expect(second.status).toBe("AMENDED");
    expect(second.effectiveProjectBudget).toBe(ADMITTED_BUDGET + ACCESS_ROAD_QUOTE + 17);
    const records = coordinator.utilityBudgetAmendments();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ status: "SUPERSEDED_UNUSED" });
    expect(records[1]).toMatchObject({
      status: "ACTIVE", planRevision: "topology:revised", courseFingerprint: "course:revised",
      supersedesAmendmentId: records[0].amendmentId,
    });
    const resumed = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: ACCESS_ROAD_QUOTE + 17,
      planRevision: "topology:revised",
      courseFingerprint: "course:revised",
    });
    expect(resumed.status).toBe("ALREADY_AMENDED");
    expect(coordinator.utilityBudgetAmendments()).toHaveLength(2);
  });

  test("replaces a spent observed authorization without losing prior spend, and binds the next exact one-shot course", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const old = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 974,
      planRevision: "plan:r7",
      courseFingerprint: "first-road-course",
    });
    expect(old.status).toBe("AMENDED");
    const previousAttempt = {
      commandId: "road-command-1",
      courseFingerprint: "first-road-course",
      effectObserved: true as const,
      authorizationSpent: true as const,
    };
    const next = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 370,
      segmentQuotes: [370],
      planRevision: "plan:r7",
      courseFingerprint: "corrected-single-action-course",
      repairLineage: "repair:r7:3",
      purpose: "Pump native road attachment repair",
      repair: { ...REPAIR_PROOF, accessRoadCommandIds: [previousAttempt.commandId], previousAttempt },
    });
    expect(next.status).toBe("AMENDED");
    expect(next.effectiveProjectBudget).toBe(ADMITTED_BUDGET + 974 + 370);
    expect(next.record).toMatchObject({
      nativeQuote: 370,
      segmentQuotes: [370],
      roadPrefab: "Small Road",
      purpose: "Pump native road attachment repair",
      repairLineage: "repair:r7:3",
      authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId,
      authorizationGeneration: activation.world.generation,
      executionUseLimit: 1,
      executionUseStatus: "UNUSED",
      supersedesAmendmentId: old.record.amendmentId,
    });
    const amendments = coordinator.utilityBudgetAmendments();
    expect(amendments.find((entry) => entry.amendmentId === old.record.amendmentId)?.status).toBe("CONSUMED");
    expect(amendments.filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON && entry.status === "ACTIVE"))
      .toHaveLength(1);
    const consumed = coordinator.consumeAccessRoadBudgetAmendment(next.record.amendmentId, "corrected-single-action-course");
    expect(consumed.executionUseStatus).toBe("CONSUMED");
    expect(() => coordinator.consumeAccessRoadBudgetAmendment(next.record.amendmentId, "corrected-single-action-course"))
      .toThrow("FACILITY_ACCESS_ROAD_AUTHORIZATION_NOT_CONSUMABLE");
  });

  test("is idempotent for a corrected-course resume and cannot expand the exact quote", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const proof = { ...REPAIR_PROOF, accessRoadCommandIds: ["first"], previousAttempt: {
      commandId: "first", courseFingerprint: "first-course", effectObserved: true as const, authorizationSpent: true as const,
    } };
    const args = { actualAccessRoadQuote: 370, segmentQuotes: [370], planRevision: "r7", courseFingerprint: "spur", repairLineage: "repair:r7:3", repair: proof };
    const first = amendAccessRoad(coordinator, activation, state, args);
    expect(first.status).toBe("AMENDED");
    expect(amendAccessRoad(coordinator, activation, state, args).status).toBe("ALREADY_AMENDED");
    expect(coordinator.utilityBudgetAmendments().filter((entry) => entry.status === "ACTIVE" &&
      entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)).toHaveLength(1);
    expect(() => amendAccessRoad(coordinator, activation, state, { ...args, segmentQuotes: [371] }))
      .toThrow("FACILITY_ACCESS_ROAD_BUDGET_AMENDMENT_QUOTE_CHANGED");
  });

  test("rejects an attempted replan without exact prior-attempt proof and rejects mismatched segment totals", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    amendAccessRoad(coordinator, activation, state, { actualAccessRoadQuote: 974, planRevision: "r7", courseFingerprint: "first" });
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 370, planRevision: "r7", courseFingerprint: "spur",
      repair: { ...REPAIR_PROOF, accessRoadCommandIds: ["submitted"] },
    })).toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_ACCESS_ROAD_ALREADY_SUBMITTED");
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 370, segmentQuotes: [210, 161], planRevision: "r7", courseFingerprint: "spur",
    })).toThrow("UTILITY_ACCESS_ROAD_SEGMENT_QUOTES_MISMATCH");
  });

  test("refuses a facility that has not landed, or one that already has frontage", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();

    expect(() => amendAccessRoad(coordinator, activation, state, {
      repair: { ...REPAIR_PROOF, facilityPlaced: false },
    })).toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_FACILITY_NOT_PLACED");
    for (const roadAttachment of ["ATTACHED", "UNKNOWN"] as const) {
      expect(() => amendAccessRoad(coordinator, activation, state, {
        repair: { ...REPAIR_PROOF, roadAttachment },
      })).toThrow(`UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_ROAD_ALREADY_ATTACHED:${roadAttachment}`);
    }
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("refuses a repair whose course already reached the world", () => {
    const { coordinator, activation } = activatedWorld();
    expect(() => amendAccessRoad(coordinator, activation, roadDeliveredState(), {
      repair: { ...REPAIR_PROOF, accessRoadCommandIds: ["water:access-road:1"] },
    })).toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_ACCESS_ROAD_ALREADY_SUBMITTED");
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("refuses an unreadable quote rather than rounding one", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    for (const quote of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => amendAccessRoad(coordinator, activation, state, { actualAccessRoadQuote: quote }))
        .toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_QUOTE_UNKNOWN");
    }
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("refuses a spend the treasury cannot carry", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    // The same share bound every other funding path applies.
    const tightTreasury = Math.floor((ADMITTED_BUDGET + ACCESS_ROAD_QUOTE - 1) / V2_PROJECT_ADMISSION_POLICY.maximumTreasuryShare);
    expect(() => amendAccessRoad(coordinator, activation, state, { treasury: tightTreasury }))
      .toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_TREASURY_INSUFFICIENT");
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("refuses before ROAD_DELIVERED, outside an active project and outside an activated world", () => {
    const { coordinator, activation } = activatedWorld();
    for (const stage of ["PLANNED", "SITE_SELECTED", "ZONED_WAITING_FOR_BUILDING"] as const) {
      const state = roadDeliveredState();
      state.tranche.stage = stage;
      expect(() => amendAccessRoad(coordinator, activation, state))
        .toThrow(`UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_STAGE_NOT_ROAD_DELIVERED:${stage}`);
    }
    const inactive = roadDeliveredState();
    inactive.project.status = "PLACEHOLDER";
    expect(() => amendAccessRoad(coordinator, activation, inactive))
      .toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_PROJECT_NOT_ACTIVE");
    const stranger = new V2DurabilityCoordinator(createMemoryDurableStateStorage());
    expect(() => amendAccessRoad(stranger, activation, roadDeliveredState()))
      .toThrow("UTILITY_ACCESS_ROAD_BUDGET_AMENDMENT_WORLD_NOT_ACTIVATED");
    expect(coordinator.utilityBudgetAmendments()).toEqual([]);
  });

  test("atomically consumes the exact one-action repair authorization with its ROAD command", () => {
    const storage = createMemoryDurableStateStorage();
    const { coordinator, activation } = activatedWorld(storage);
    const state = roadDeliveredState();
    const actionFingerprint = JSON.stringify([{ type: "build_road", prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 }]);
    const roadInputFingerprint = JSON.stringify({ actionFamily: "ROAD", prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 });
    const amendment = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 468,
      segmentQuotes: [468],
      planRevision: "generation-a:production",
      courseFingerprint: actionFingerprint,
      repairLineage: "water-access-road-repair:3",
    });
    expect(amendment.status).toBe("AMENDED");
    const record = {
      schemaVersion: "ai-mayor-v2-command/1" as const,
      commandId: "road-repair-command-3",
      actionFamily: "ROAD" as const,
      actionType: "build_road",
      authorizedScope: {
        owner: { ownerType: "PROJECT" as const, ownerId: state.project.id },
        actionFamily: "ROAD" as const,
        proposalId: "proposal-repair-3", quoteId: "quote-repair-3",
        fingerprint: roadInputFingerprint, exactInput: roadInputFingerprint,
        budget: { authorizedMaxSpend: 468, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        observationPrecondition: { runtimeEpoch: "bridge:1", frame: 1 }, expiresAt: "2099-01-01T00:00:00.000Z",
        facilityAccessRoadRepair: {
          amendmentId: amendment.record.amendmentId, repairLineage: "water-access-road-repair:3",
          planRevision: "generation-a:production", actionFingerprint, actionCount: 1 as const,
          purpose: "Pump native road attachment repair", prefab: "Small Road",
        },
      },
      createdAt: INSTANT.toISOString(), submittedAt: null, nativeResultSummary: null, status: "CREATED" as const,
      statusHistory: [{ status: "CREATED" as const, at: INSTANT.toISOString() }],
      reconciliationStatus: "NOT_STARTED" as const, observationEvidence: [], failureOrUnknownReason: null,
      effectAbsenceProven: false,
    };
    const input = {
      amendmentId: amendment.record.amendmentId,
      expectedJournalPosition: coordinator.snapshot().journalPosition,
      expectedWorldId: activation.world.worldId,
      expectedCheckpointId: activation.world.checkpointId,
      expectedGeneration: activation.world.generation,
      repairLineage: "water-access-road-repair:3", planRevision: "generation-a:production", actionFingerprint,
      command: record,
    };
    const committed = coordinator.commitFacilityAccessRoadRepairCommand(input);
    expect(committed.commandId).toBe(record.commandId);
    expect(coordinator.utilityBudgetAmendments().find((entry) => entry.amendmentId === input.amendmentId))
      .toMatchObject({ status: "CONSUMED", executionUseStatus: "CONSUMED" });
    expect(coordinator.commandJournal.get(record.commandId)).toMatchObject({ status: "CREATED", actionFamily: "ROAD" });
    expect(coordinator.snapshot().journalPosition).toBe(input.expectedJournalPosition + 1);

    const duplicate = coordinator.commitFacilityAccessRoadRepairCommand({
      ...input, command: { ...record, commandId: "unused-duplicate-id" },
    });
    expect(duplicate.commandId).toBe(record.commandId);
    expect(coordinator.snapshot().journalPosition).toBe(input.expectedJournalPosition + 1);
    expect(coordinator.commandJournal.list()).toHaveLength(1);

    // Process restart after the atomic commit restores the same pending command
    // and spent authorization; it cannot mint or consume a second command.
    const restarted = new V2DurabilityCoordinator(storage);
    expect(restarted.utilityBudgetAmendments().find((entry) => entry.amendmentId === input.amendmentId))
      .toMatchObject({ status: "CONSUMED", executionUseStatus: "CONSUMED" });
    expect(restarted.commandJournal.get(record.commandId)).toMatchObject({ status: "CREATED", actionFamily: "ROAD" });
    expect(restarted.commandJournal.list()).toHaveLength(1);
  });

  test("failed atomic snapshot write leaves authorization UNUSED and command absent", () => {
    let value: unknown;
    let failNextSave = false;
    const storage: V2DurableStateStorage = {
      load: () => structuredClone(value),
      save: (state) => {
        if (failNextSave) { failNextSave = false; throw new Error("simulated atomic store failure"); }
        value = structuredClone(state);
      },
    };
    const { coordinator, activation } = activatedWorld(storage);
    const state = roadDeliveredState();
    const actionFingerprint = JSON.stringify([{ type: "build_road", prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 }]);
    const amendment = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 468, segmentQuotes: [468], planRevision: "generation-a:production",
      courseFingerprint: actionFingerprint, repairLineage: "water-access-road-repair:3",
    });
    const roadInputFingerprint = JSON.stringify({ actionFamily: "ROAD", prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 });
    const command = {
      schemaVersion: "ai-mayor-v2-command/1" as const, commandId: "failed-commit-command", actionFamily: "ROAD" as const,
      actionType: "build_road", authorizedScope: {
        owner: { ownerType: "PROJECT" as const, ownerId: state.project.id }, actionFamily: "ROAD" as const,
        proposalId: "p", quoteId: "q", fingerprint: roadInputFingerprint, exactInput: roadInputFingerprint,
        budget: { authorizedMaxSpend: 468, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        observationPrecondition: { runtimeEpoch: "bridge:1", frame: 1 }, expiresAt: "2099-01-01T00:00:00.000Z",
        facilityAccessRoadRepair: { amendmentId: amendment.record.amendmentId, repairLineage: "water-access-road-repair:3",
          planRevision: "generation-a:production", actionFingerprint, actionCount: 1 as const,
          purpose: "Pump native road attachment repair", prefab: "Small Road" },
      },
      createdAt: INSTANT.toISOString(), submittedAt: null, nativeResultSummary: null, status: "CREATED" as const,
      statusHistory: [{ status: "CREATED" as const, at: INSTANT.toISOString() }], reconciliationStatus: "NOT_STARTED" as const,
      observationEvidence: [], failureOrUnknownReason: null, effectAbsenceProven: false,
    };
    const input = { amendmentId: amendment.record.amendmentId, expectedJournalPosition: coordinator.snapshot().journalPosition,
      expectedWorldId: activation.world.worldId, expectedCheckpointId: activation.world.checkpointId,
      expectedGeneration: activation.world.generation, repairLineage: "water-access-road-repair:3",
      planRevision: "generation-a:production", actionFingerprint, command };
    failNextSave = true;
    expect(() => coordinator.commitFacilityAccessRoadRepairCommand(input)).toThrow("simulated atomic store failure");
    expect(coordinator.utilityBudgetAmendments().find((entry) => entry.amendmentId === input.amendmentId))
      .toMatchObject({ status: "ACTIVE", executionUseStatus: "UNUSED" });
    expect(coordinator.commandJournal.get(command.commandId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The workflow hook
// ---------------------------------------------------------------------------

const scopedScope = (): GreenfieldUtilityExecutionScope => ({
  intentId: "intent:1", projectId: "project:1", trancheId: "tranche:1", reservationRef: "reservation:1",
  worldId: "world:1", worldEpochId: "epoch:1", generation: "generation:1", topologyRevision: "topology:1",
  certifiedRoadRefs: [{ index: 10, version: 2 }],
  targetServiceEntry: { road: { index: 10, version: 2 }, position: point(20, 0) },
  spatialEnvelope: { center: point(0, 0), radius: 200 },
  maximumSpend: 10_000, treasury: 20_000, treasurySafetyReserve: 5_000,
  // The repair is a water capability, so the fixture commissions water alone: a
  // narrowed mandate is what keeps the other families' durable state untouched.
  commissionedKinds: ["water"],
});

const scopedPlan = (kind: GreenfieldUtilityKind): PlannedUtilityFacility => ({
  kind: kind === "electricity" ? "power" : kind,
  prefab: `${kind}-starter`, position: point(0, 0), rotationCandidates: [0],
  constructionCost: 100, expectedCapacity: 100,
  siteEvidence: { scoped: 1 },
  connection: { prefab: kind === "water" ? "Small Water Pipe" : "Low-voltage Ground Cable", start: point(0, 0), end: point(20, 0) },
  serviceRoads: [{ id: `${kind}-service-road`, role: "side", start: point(20, 0), end: point(8, 0) }],
  // The production planner attaches this to every sewage site it proposes; a
  // fixture that omits it is modelling a plan the durable admission refuses.
  ...(kind === "sewage" ? { environmentalCertification: certifiedSewageSite() } : {}),
});

/** The evidence the certified sewage recipe attaches to a judged site. */
const certifiedSewageSite = () => ({
  recipe: "basic-sewage-provision",
  receivingWater: { x: 10, z: 0, depth: 4, pollution: 0, velocity: { x: 0, z: 0 }, speed: 0 },
  connectedWaterCells: 8, downstreamDistance: 0, downstreamTermination: "STAGNANT_AT_OUTFALL",
  downstreamCells: 1, intakeCount: 0, intakesInSameWaterBody: 0, closestIntakeApproach: null,
});

const scopedFacility = { entity: { index: 102, version: 1 }, prefab: "water-starter", position: point(0, 0) };
const scopedConnector: UtilityConnectorReadback = {
  type: "waterPipe", node: { index: 200, version: 1 }, worldPosition: point(0, 0), attached: true, capacity: {},
};

const scopedEvidence = (kind: GreenfieldUtilityKind, scope: GreenfieldUtilityExecutionScope, hasFacility: boolean): GreenfieldUtilityServiceEvidence => ({
  status: "AVAILABLE", revision: `${scope.generation}:10`, capacity: 100, consumption: 10,
  fulfilledConsumption: 0, issueActive: false, supplyExists: hasFacility, networkConnected: hasFacility,
  cityCapacityAvailable: true, targetNetworkReachable: false,
  facility: hasFacility ? { ...scopedFacility } : null,
  connector: hasFacility ? { ...scopedConnector } : null,
  targetRoad: scope.targetServiceEntry.road, evidenceGeneration: scope.generation, topologyRevision: scope.topologyRevision,
});

const SERVICE_ROAD_ACTIONS: MayorAction[] = [{ type: "build_road", prefab: "Small Road", x1: 20, z1: 0, x2: 8, z2: 0 }];
const DIRECT_CABLE_ACTIONS: MayorAction[] = [{ type: "build_road", prefab: "Small Water Pipe", x1: 0, z1: 0, x2: 20, z2: 0 }];
const PLANNED_REPAIR_ACTIONS: MayorAction[] = [{ type: "build_road", prefab: "Small Road", x1: 26, z1: 0, x2: 8, z2: 0 }];
const REPAIR_QUOTE = 168;

/**
 * The durable water state the repair exists for: the facility landed, the pipe is
 * an observed match, and the plan's own service road was refused by the native
 * preflight — refused, not merely unverified, so it stays spent.
 */
function waterRepairState(options: { directCable: "OBSERVED_MATCH" | "NOT_ATTEMPTED" } = { directCable: "OBSERVED_MATCH" }): DurableGreenfieldUtilityState {
  const scope = scopedScope();
  const state = createDurableGreenfieldUtilityState(scope);
  const water = state.utilities.water;
  water.stage = "PLACED";
  water.constructionAttempts = 1;
  water.plan = scopedPlan("water");
  water.planBinding = { projectId: scope.projectId, worldEpochId: scope.worldEpochId, topologyRevision: scope.topologyRevision };
  water.facility = { ...scopedFacility };
  water.connector = { ...scopedConnector, attached: false };
  water.commandOutcome = "OBSERVED_MATCH";
  water.networkCommandIds = options.directCable === "OBSERVED_MATCH" ? ["water:network:1"] : [];
  water.candidateLedger = [
    {
      candidateId: `${scope.projectId}:${scope.trancheId}:water:topology:1:102:200:service-road`,
      objectiveId: `${scope.projectId}:${scope.trancheId}:water:topology:1:102:200`,
      kind: "service-road", ordinal: 0, exactActions: structuredClone(SERVICE_ROAD_ACTIONS),
      actionFingerprint: JSON.stringify(SERVICE_ROAD_ACTIONS), approvedPlanRevision: "topology:1",
      spatialScope: { ...scope.spatialEnvelope }, budgetCeiling: scope.maximumSpend,
      ledgerState: "PREFLIGHT_REJECTED", commandId: null, primitiveEffect: "NOT_OBSERVED", preflightVerdict: "NATIVE_REJECTED",
    },
    {
      candidateId: `${scope.projectId}:${scope.trancheId}:water:topology:1:102:200:direct-cable`,
      objectiveId: `${scope.projectId}:${scope.trancheId}:water:topology:1:102:200`,
      kind: "direct-cable", ordinal: 1, exactActions: structuredClone(DIRECT_CABLE_ACTIONS),
      actionFingerprint: JSON.stringify(DIRECT_CABLE_ACTIONS), approvedPlanRevision: "topology:1",
      spatialScope: { ...scope.spatialEnvelope }, budgetCeiling: scope.maximumSpend,
      ledgerState: options.directCable, commandId: options.directCable === "OBSERVED_MATCH" ? "water:network:1" : null,
      primitiveEffect: options.directCable === "OBSERVED_MATCH" ? "OBSERVED_MATCH" : "NOT_OBSERVED",
    },
  ];
  return state;
}

interface AccessRoadPortInput {
  kind: GreenfieldUtilityKind;
  scope: GreenfieldUtilityExecutionScope;
  objective: { start: SpatialPoint2; end: SpatialPoint2 };
  admittedCourse: { prefab: string; start: SpatialPoint2; end: SpatialPoint2 };
  plan: PlannedUtilityFacility;
}

function repairPorts(options: {
  evidence?: { roadAttachment: "ATTACHED" | "NONE" | "UNKNOWN"; noRoadAccessWarning: boolean | "UNKNOWN"; cityElectricityCapacitySufficient: boolean | "UNKNOWN" } | null;
  planned?: { status: "PLANNED"; actions: MayorAction[]; quote: number; offsetFromAdmittedCourse: number } | { status: "REFUSED"; reasons: string[] } | { status: "UNKNOWN"; reason: string };
  accessRoadPorts?: boolean;
  execute?: "SUBMITTED" | "PREFLIGHT_ONLY_FAILURE";
  /**
   * How the progression port answers. The default — the workflow's own wait — is
   * what every pre-existing case expects; `TARGET_REACHED` is what a case needs
   * when it has to drive the workflow past the wait and into the observation
   * budget below it.
   */
  progress?: "ALWAYS_WAITING" | "TARGET_REACHED";
  /** Whether the fixture answers the current-world facility rebind at all. */
  rebind?: boolean;
  nativeRoadCommand?: { commandId: string; status: string; exactInput: string };
} = {}) {
  let durable: DurableGreenfieldUtilityState | null = null;
  const evidenceCalls: AccessRoadPortInput[] = [];
  const planCalls: AccessRoadPortInput[] = [];
  const executeCalls: Array<{ primitive?: string; candidateId?: string; fingerprint?: string }> = [];
  const progressCalls: number[] = [];
  let bootstrapPlanCalls = 0;
  let rebindCalls = 0;
  const implementation: ScopedGreenfieldUtilityPorts = {
    load: async () => (durable ? structuredClone(durable) : null),
    save: async (state) => { durable = structuredClone(state); },
    observe: async (kind, scope) => scopedEvidence(kind, scope, !!durable?.utilities[kind].facility),
    plan: async (kind) => { bootstrapPlanCalls += 1; return scopedPlan(kind); },
    execute: async ({ state, plan, selectedPrimitive, selectedCandidateId, onAuthorized }) => {
      const candidate = state.candidateLedger.find((entry) => entry.candidateId === selectedCandidateId);
      executeCalls.push({
        primitive: selectedPrimitive, candidateId: selectedCandidateId,
        fingerprint: JSON.stringify(candidate?.exactActions ?? []),
      });
      if (options.execute === "PREFLIGHT_ONLY_FAILURE") {
        // A live-binding precondition rejection is not a verdict on the course, so
        // the primitive stays attemptable — which lets the repair be observed in
        // its PLANNED state beside a pre-existing primitive that is still preferred.
        return {
          facilityConstructionAttempted: false, networkSubmissionAttempted: false, failedBeforeNetworkSubmission: true,
          executionSucceeded: false, reason: "DIRECT_CABLE_PREFLIGHT_REJECTED",
          connectionDiagnostics: [{ valid: false, reason: "binding_stale", rejectionKind: "PRECONDITION" as const, candidate: "direct-cable" as const, actionCount: 1, actionIndex: 0 }],
          state: { ...state, plan },
        };
      }
      const commandId = `${state.kind}:network:2`;
      await onAuthorized?.({ commandId, actionFingerprint: JSON.stringify(candidate?.exactActions ?? []) });
      return {
        facilityConstructionAttempted: false, networkSubmissionAttempted: true, failedBeforeNetworkSubmission: false,
        executionSucceeded: true, reason: "resolved", networkCommandIds: [commandId],
        selectedConnectionPrimitive: selectedPrimitive,
        state: { ...state, plan, stage: "CONNECTED", commandOutcome: "OBSERVED_MATCH" },
      };
    },
    inspectNetworkCommands: async ({ state }) => ({
      commandIds: state.networkCommandIds, uncertain: false, authoritativeEffect: true,
      ...(options.nativeRoadCommand ? { commands: [options.nativeRoadCommand] } : {}),
    }),
    progress: async ({ prior }) => {
      progressCalls.push(prior?.checks ?? -1);
      return options.progress === "TARGET_REACHED"
        ? { status: "TARGET_REACHED", startFrame: 10, targetFrame: 20, currentFrame: 20, paused: true, reason: "reached" }
        : { status: "WAITING_FOR_SERVICE_UPDATE", startFrame: 10, targetFrame: 20, currentFrame: 10, paused: false, reason: "submitted" };
    },
  };
  if (options.rebind) {
    implementation.rebind = async () => {
      rebindCalls += 1;
      if (!durable) return { status: "PROVEN_MISSING", reason: "REBIND_FIXTURE_NO_STATE" };
      // The generation-scoped bindings the reload cleared, re-established from
      // the current world exactly as the production port does.
      return { status: "MATCH", facility: { ...scopedFacility }, connector: { ...scopedConnector } };
    };
  }
  if (options.accessRoadPorts !== false) {
    implementation.facilityAccessRoadEvidence = async (input) => {
      evidenceCalls.push(input as AccessRoadPortInput);
      return options.evidence === undefined
        ? { roadAttachment: "NONE", noRoadAccessWarning: true, cityElectricityCapacitySufficient: true }
        : options.evidence;
    };
    implementation.planFacilityAccessRoad = async (input) => {
      planCalls.push(input as AccessRoadPortInput);
      return options.planned ?? {
        status: "PLANNED", actions: structuredClone(PLANNED_REPAIR_ACTIONS),
        quote: REPAIR_QUOTE, offsetFromAdmittedCourse: 26,
      };
    };
  }
  return {
    implementation, evidenceCalls, planCalls, executeCalls, progressCalls,
    get bootstrapPlanCalls() { return bootstrapPlanCalls; },
    get rebindCalls() { return rebindCalls; },
    get state() { return durable; },
    setState(value: DurableGreenfieldUtilityState) { durable = structuredClone(value); },
  };
}

const repairEntries = (state: DurableGreenfieldUtilityState) =>
  state.utilities.water.candidateLedger.filter((entry) => entry.repair === FACILITY_ACCESS_ROAD_REPAIR);

describe("durable facility access road repair planning", () => {
  test("plans exactly one course, priced from the plan's own corridor, without displacing the existing primitive", async () => {
    const ports = repairPorts({ execute: "PREFLIGHT_ONLY_FAILURE" });
    ports.setState(waterRepairState({ directCable: "NOT_ATTEMPTED" }));
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const state = ports.state!;
    const repairs = repairEntries(state);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      kind: "facility-access-road",
      repair: FACILITY_ACCESS_ROAD_REPAIR,
      candidateId: "project:1:tranche:1:water:topology:1:access-road:1:facility-access-road",
      approvedPlanRevision: "topology:1",
      ledgerState: "NOT_ATTEMPTED",
      commandId: null,
      primitiveEffect: "NOT_OBSERVED",
      budgetCeiling: 10_000,
      exactActions: PLANNED_REPAIR_ACTIONS,
      actionFingerprint: JSON.stringify(PLANNED_REPAIR_ACTIONS),
    });
    expect(state.utilities.water.accessRoadRepair).toEqual({
      status: "PLANNED", quote: REPAIR_QUOTE, offsetFromAdmittedCourse: 26, plannedAtJournalPosition: null,
    });
    expect(ports.planCalls).toHaveLength(1);
    // The objective is the plan's service-road corridor and the admitted course is
    // the plan's own connection, so the ladder is derived, never restated.
    expect(ports.planCalls[0].objective).toEqual({ start: point(20, 0), end: point(8, 0) });
    expect(ports.planCalls[0].admittedCourse).toEqual({ prefab: "Small Water Pipe", start: point(0, 0), end: point(20, 0) });
    // The pre-existing primitive is still preferred while it is attemptable.
    expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["direct-cable"]);
  });

  test("a resume appends no second course and re-prices nothing", async () => {
    const ports = repairPorts({ execute: "PREFLIGHT_ONLY_FAILURE" });
    ports.setState(waterRepairState({ directCable: "NOT_ATTEMPTED" }));
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
    const afterFirst = structuredClone(repairEntries(ports.state!));

    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const repairs = repairEntries(ports.state!);
    expect(repairs).toEqual(afterFirst);
    expect(ports.planCalls).toHaveLength(1);
    expect(ports.state!.utilities.water.accessRoadRepair?.quote).toBe(REPAIR_QUOTE);
  });

  test("a stale unused repair is retired and the current plan derives distinct geometry", async () => {
    const replacementActions: MayorAction[] = [{
      type: "build_road", prefab: "Small Road", x1: 32, z1: 0, x2: 32, z2: 8,
    }];
    const ports = repairPorts({ planned: {
      status: "PLANNED", actions: replacementActions, quote: REPAIR_QUOTE + 1, offsetFromAdmittedCourse: 32,
    }, execute: "PREFLIGHT_ONLY_FAILURE" });
    const state = waterPendingRepairState();
    state.utilities.water.connectionObjective = {
      objectiveId: "water-objective", approvedPlanRevision: "topology:2", candidateOrder: [],
      status: "INCOMPLETE", observationBudget: 6, candidateBudget: 2,
    };
    ports.setState(state);

    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const repairs = repairEntries(ports.state!);
    expect(repairs).toHaveLength(2);
    expect(repairs[0].ledgerState).toBe("FAILED_DETERMINISTIC");
    expect(repairs[0].exactActions).toEqual(PLANNED_REPAIR_ACTIONS);
    expect(repairs[1]).toMatchObject({
      repairPlanRevision: "topology:2", exactActions: replacementActions,
      ledgerState: "NOT_ATTEMPTED", commandId: null,
    });
    expect(repairs[1].actionFingerprint).not.toBe(repairs[0].actionFingerprint);
    expect(ports.executeCalls[0].fingerprint).toBe(JSON.stringify(replacementActions));
  });

  test("a stale repair after any native attempt fails closed without replacement", async () => {
    const ports = repairPorts();
    const state = waterPendingRepairState();
    state.utilities.water.connectionObjective = {
      objectiveId: "water-objective", approvedPlanRevision: "topology:2", candidateOrder: [],
      status: "INCOMPLETE", observationBudget: 6, candidateBudget: 2,
    };
    state.utilities.water.accessRoadRepair!.status = "ATTEMPTED";
    const oldRepair = repairEntries(state)[0];
    oldRepair.commandId = "water:access-road:already-attempted";
    oldRepair.ledgerState = "FAILED_DETERMINISTIC";
    ports.setState(state);
    await expect(runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation }))
      .rejects.toThrow("ACCESS_ROAD_REPLAN_AFTER_NATIVE_ATTEMPT_FORBIDDEN");
    expect(ports.planCalls).toEqual([]);
    expect(repairEntries(ports.state!)).toHaveLength(1);
  });

  test("a native road command remains attempt-spent even when its candidate lost the command link", async () => {
    const ports = repairPorts({ nativeRoadCommand: {
      commandId: "water:native-road:1", status: "OBSERVED_MATCH",
      exactInput: JSON.stringify(PLANNED_REPAIR_ACTIONS),
    } });
    ports.setState(waterPendingRepairState());

    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const repairs = repairEntries(ports.state!);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      commandId: "water:native-road:1", ledgerState: "FAILED_DETERMINISTIC", primitiveEffect: "OBSERVED_MISMATCH",
    });
    expect(ports.planCalls).toEqual([]);
    expect(ports.executeCalls).toEqual([]);
  });

  test("the repair course is selected and submitted once no plan course is attemptable", async () => {
    const ports = repairPorts();
    ports.setState(waterRepairState());
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const state = ports.state!;
    const repairs = repairEntries(state);
    expect(repairs).toHaveLength(1);
    // The adapter resolves the course by candidate id, so the id it would be given
    // is the one the ledger holds, and the fingerprint it would submit is the one
    // the ledger authorized.
    expect(ports.executeCalls).toEqual([{
      primitive: "facility-access-road",
      candidateId: repairs[0].candidateId,
      fingerprint: repairs[0].actionFingerprint,
    }]);
    expect(repairs[0].ledgerState).toBe("OBSERVED_MATCH");
    expect(repairs[0].commandId).toBe("water:network:2");
    // The bounded repair is spent the moment its course reaches the engine.
    expect(state.utilities.water.accessRoadRepair?.status).toBe("ATTEMPTED");
    expect(state.utilities.water.selectedConnectionPrimitive).toBe("facility-access-road");

    // And a further resume neither re-plans nor re-prices it.
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
    expect(repairEntries(ports.state!)).toHaveLength(1);
    expect(ports.planCalls).toHaveLength(1);
  });

  test("a refused verdict appends nothing and blocks nothing", async () => {
    const ports = repairPorts({
      evidence: { roadAttachment: "NONE", noRoadAccessWarning: true, cityElectricityCapacitySufficient: false },
    });
    ports.setState(waterRepairState({ directCable: "NOT_ATTEMPTED" }));
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    expect(repairEntries(ports.state!)).toEqual([]);
    expect(ports.state!.utilities.water.accessRoadRepair).toBeNull();
    expect(ports.planCalls).toEqual([]);
    // The existing course still runs: a repair that could not be proven is not a
    // reason to stop a workflow that has other courses.
    expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["direct-cable"]);
    expect(result.serviceCertified).toBe(false);
  });

  test("an unreadable frontage is a refusal, not a default", async () => {
    const absent = repairPorts({ accessRoadPorts: false });
    absent.setState(waterRepairState({ directCable: "NOT_ATTEMPTED" }));
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: absent.implementation });
    expect(repairEntries(absent.state!)).toEqual([]);
    expect(absent.state!.utilities.water.accessRoadRepair).toBeNull();
    expect(absent.executeCalls.map((call) => call.primitive)).toEqual(["direct-cable"]);

    const unreadable = repairPorts({ evidence: null });
    unreadable.setState(waterRepairState({ directCable: "NOT_ATTEMPTED" }));
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: unreadable.implementation });
    expect(repairEntries(unreadable.state!)).toEqual([]);
    expect(unreadable.state!.utilities.water.accessRoadRepair).toBeNull();
    expect(unreadable.planCalls).toEqual([]);
    expect(unreadable.executeCalls.map((call) => call.primitive)).toEqual(["direct-cable"]);
  });

  test("a refused or unpriced plan contributes no candidate", async () => {
    for (const planned of [
      { status: "REFUSED" as const, reasons: ["no_clearance"] },
      { status: "UNKNOWN" as const, reason: "unreadable_quote" },
      { status: "PLANNED" as const, actions: structuredClone(PLANNED_REPAIR_ACTIONS), quote: Number.NaN, offsetFromAdmittedCourse: 26 },
      { status: "PLANNED" as const, actions: structuredClone(PLANNED_REPAIR_ACTIONS), quote: -1, offsetFromAdmittedCourse: 26 },
      { status: "PLANNED" as const, actions: [], quote: REPAIR_QUOTE, offsetFromAdmittedCourse: 26 },
      { status: "PLANNED" as const, actions: structuredClone(PLANNED_REPAIR_ACTIONS), quote: REPAIR_QUOTE, offsetFromAdmittedCourse: Number.NaN },
    ]) {
      const ports = repairPorts({ planned: planned as never, execute: "PREFLIGHT_ONLY_FAILURE" });
      ports.setState(waterRepairState({ directCable: "NOT_ATTEMPTED" }));
      await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
      expect(repairEntries(ports.state!)).toEqual([]);
      expect(ports.state!.utilities.water.accessRoadRepair).toBeNull();
      expect(ports.planCalls).toHaveLength(1);
    }
  });

  test("a service road already in the world is a duplicate risk, so no repair is planned", async () => {
    const ports = repairPorts({ execute: "PREFLIGHT_ONLY_FAILURE" });
    const state = waterRepairState({ directCable: "NOT_ATTEMPTED" });
    state.utilities.water.candidateLedger[0].commandId = "water:service-road:1";
    ports.setState(state);
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    expect(repairEntries(ports.state!)).toEqual([]);
    expect(ports.state!.utilities.water.accessRoadRepair).toBeNull();
    expect(ports.planCalls).toEqual([]);
    // The corridor already carries a road, so the plan's own course is left exactly
    // as the durable record left it.
    expect(ports.state!.utilities.water.candidateLedger[0].ledgerState).toBe("PREFLIGHT_REJECTED");
  });

  test("leaves the other families and the untouched state exactly as they were", async () => {
    const ports = repairPorts({ execute: "PREFLIGHT_ONLY_FAILURE" });
    const initial = waterRepairState({ directCable: "NOT_ATTEMPTED" });
    ports.setState(initial);
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const state = ports.state!;
    // Only water was adjudicated; the other families are byte-for-byte untouched.
    expect(state.utilities.electricity).toEqual(createDurableGreenfieldUtilityState(scopedScope()).utilities.electricity);
    expect(state.utilities.sewage).toEqual(createDurableGreenfieldUtilityState(scopedScope()).utilities.sewage);
    // The plan's own refused course is not re-minted into an attemptable one.
    const serviceRoad = state.utilities.water.candidateLedger.find((entry) => entry.kind === "service-road");
    expect(serviceRoad).toMatchObject({ ledgerState: "PREFLIGHT_REJECTED", commandId: null, preflightVerdict: "NATIVE_REJECTED" });
  });
});

// ---------------------------------------------------------------------------
// ACTIONABLE REPAIR outranks PASSIVE SERVICE WAIT
// ---------------------------------------------------------------------------

const pendingRepairCandidate = (
  scope: GreenfieldUtilityExecutionScope,
): DurableGreenfieldUtilityState["utilities"]["water"]["candidateLedger"][number] => ({
  candidateId: `${scope.projectId}:${scope.trancheId}:water:topology:1:access-road:1:facility-access-road`,
  objectiveId: `${scope.projectId}:${scope.trancheId}:water:topology:1:access-road:1`,
  kind: "facility-access-road", repair: FACILITY_ACCESS_ROAD_REPAIR, ordinal: 2,
  exactActions: structuredClone(PLANNED_REPAIR_ACTIONS),
  actionFingerprint: JSON.stringify(PLANNED_REPAIR_ACTIONS),
  approvedPlanRevision: "topology:1",
  spatialScope: { ...scope.spatialEnvelope }, budgetCeiling: scope.maximumSpend,
  ledgerState: "NOT_ATTEMPTED", commandId: null, primitiveEffect: "NOT_OBSERVED",
});

/**
 * The state a resume finds once the repair has been planned: the course is
 * durable and unspent, the slice has already burned its observation waits
 * waiting for a service that cannot arrive without it, and the workflow is
 * parked with a live progression window.
 */
function waterPendingRepairState(): DurableGreenfieldUtilityState {
  const scope = scopedScope();
  const state = waterRepairState();
  const water = state.utilities.water;
  water.accessRoadRepair = {
    status: "PLANNED", quote: REPAIR_QUOTE, offsetFromAdmittedCourse: 26, plannedAtJournalPosition: null,
  };
  water.candidateLedger.push(pendingRepairCandidate(scope));
  water.observationWaits = 6;
  water.progression = { startFrame: 1, targetFrame: 2, checks: 1, maximumChecks: 60 };
  return state;
}

describe("an actionable repair outranks the passive service wait", () => {
  test("rehydrates one exact authorized repair after a terminal rejected attempt without repricing", async () => {
    const ports = repairPorts({ nativeRoadCommand: {
      commandId: "attempt-2-command", status: "REJECTED",
      exactInput: JSON.stringify([{ type: "build_road", prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 }]),
    } });
    ports.setState(waterRepairState());
    const scope = scopedScope();
    const actions = [
      { type: "build_road" as const, prefab: "Small Road", x1: 10, z1: 20, x2: 30, z2: 40 },
    ];
    ports.implementation.authorizedFacilityAccessRoadRepair = async () => ({
      amendmentId: "repair-auth-3", repairLineage: "water-repair-lineage-3", attemptIndex: 3,
      planRevision: "topology:1", courseFingerprint: JSON.stringify(actions),
      actions, quote: 468, segmentQuotes: [468], worldId: scope.worldId, generation: scope.generation,
    });

    await runScopedGreenfieldUtilityBootstrap({ scope, ports: ports.implementation });

    const candidate = ports.state!.utilities.water.candidateLedger.find((entry) => entry.repairAttemptIndex === 3);
    expect(candidate).toMatchObject({
      authorizationAmendmentId: "repair-auth-3", repairAttemptIndex: 3, actionFingerprint: JSON.stringify(actions),
      approvedPlanRevision: "topology:1", ledgerState: "OBSERVED_MATCH", commandId: "water:network:2",
    });
    expect(ports.executeCalls).toHaveLength(1);
    expect(ports.executeCalls[0]).toMatchObject({ primitive: "facility-access-road", fingerprint: JSON.stringify(actions) });
    expect(ports.planCalls).toEqual([]);
  });

  test("rejects a two-action facility repair under the single-action contract", async () => {
    const ports = repairPorts();
    const scope = scopedScope();
    ports.implementation.authorizedFacilityAccessRoadRepair = async () => {
      const actions = [
        { type: "build_road" as const, prefab: "Small Road", x1: 1, z1: 2, x2: 3, z2: 4 },
        { type: "build_road" as const, prefab: "Small Road", x1: 3, z1: 4, x2: 5, z2: 6 },
      ];
      return { amendmentId: "two-action-auth", repairLineage: "lineage", attemptIndex: 4, planRevision: "topology:1",
        courseFingerprint: JSON.stringify(actions), actions, quote: 3, segmentQuotes: [1, 2],
        worldId: scope.worldId, generation: scope.generation };
    };
    ports.setState(waterRepairState());
    await expect(runScopedGreenfieldUtilityBootstrap({ scope, ports: ports.implementation }))
      .rejects.toThrow("AUTHORIZED_ACCESS_ROAD_REPAIR_BINDING_OR_ATTEMPT_INDEX_MISMATCH");
    expect(ports.executeCalls).toEqual([]);
  });

  test("selects and submits the pending course instead of parking in WAITING_FOR_SERVICE_UPDATE", async () => {
    const ports = repairPorts();
    ports.setState(waterPendingRepairState());

    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    // The wait never ran. Its port would have reported the wait the workflow
    // parks in, and its budget would have been consumed.
    expect(ports.progressCalls).toEqual([]);
    expect(result.reason).not.toBe("WAITING_FOR_SERVICE_UPDATE");
    expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["facility-access-road"]);
    expect(ports.state!.utilities.water.observationWaits).toBe(6);
    expect(ports.state!.utilities.water.candidateLedger.filter((entry) => entry.repair === FACILITY_ACCESS_ROAD_REPAIR))
      .toHaveLength(1);
  });

  test("a water repair remains attemptable under the direct-cable-only override", async () => {
    const prior = process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY;
    process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY = "1";
    try {
      const ports = repairPorts();
      ports.setState(waterPendingRepairState());
      await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
      expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["facility-access-road"]);
    } finally {
      if (prior === undefined) delete process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY;
      else process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY = prior;
    }
  });

  test("without an actionable course the original passive wait is unchanged", async () => {
    const ports = repairPorts({ accessRoadPorts: false });
    const state = waterRepairState();
    state.utilities.water.progression = { startFrame: 1, targetFrame: 2, checks: 1, maximumChecks: 60 };
    ports.setState(state);

    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    expect(result).toMatchObject({ waiting: true, reason: "WAITING_FOR_SERVICE_UPDATE" });
    expect(ports.executeCalls).toEqual([]);
    expect(ports.progressCalls).toHaveLength(1);
  });

  test("an exhausted observation budget neither clears the plan nor re-enters greenfield planning", async () => {
    // The world still says the frontage is missing, so the repair is skipped into
    // the wait — and the wait's budget is already spent. The plan is what the
    // pending course was derived from, so it survives; the control below, with no
    // pending course, keeps the original disposal exactly as it was.
    const ports = repairPorts({ progress: "TARGET_REACHED" });
    ports.setState(waterPendingRepairState());
    const boundPlan = JSON.stringify(ports.state!.utilities.water.plan);

    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    expect(ports.state!.utilities.water.plan).toEqual(JSON.parse(boundPlan));
    expect(ports.state!.utilities.water.planBinding).not.toBeNull();
    expect(ports.state!.utilities.water.candidateLedger.filter((entry) => entry.repair === FACILITY_ACCESS_ROAD_REPAIR))
      .toHaveLength(1);
    // The one actionable answer this slice holds is still executable.
    expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["facility-access-road"]);
    expect(result).toBeDefined();
  });

  test("the same exhausted budget without a pending course still discards the plan, as before", async () => {
    const ports = repairPorts({ accessRoadPorts: false, progress: "TARGET_REACHED" });
    const state = waterRepairState();
    state.utilities.water.observationWaits = 6;
    state.utilities.water.progression = { startFrame: 1, targetFrame: 2, checks: 1, maximumChecks: 60 };
    ports.setState(state);

    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    // The plan is discarded and re-derived in the same invocation, which is what
    // the budget running out has always meant and still means: the plan step now
    // runs before the wait, so the discard has to re-derive rather than rely on
    // the ordering it used to have.
    expect(ports.bootstrapPlanCalls).toBe(1);
    expect(ports.state!.utilities.water.planBinding).toEqual({
      projectId: "project:1", worldEpochId: "epoch:1", topologyRevision: "topology:1",
    });
  });

  test("a generation change rebinds the current facility and continues into the repair without placing a second one", async () => {
    const ports = repairPorts({ rebind: true });
    ports.setState(waterPendingRepairState());

    const result = await runScopedGreenfieldUtilityBootstrap({
      scope: { ...scopedScope(), worldEpochId: "epoch:2", generation: "generation:2", topologyRevision: "topology:2" },
      ports: ports.implementation,
    });

    // The generation-scoped bindings were cleared and re-established, and the
    // repair path ran against the rebound facility rather than a second one.
    expect(ports.rebindCalls).toBe(1);
    expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["facility-access-road"]);
    expect(ports.state!.utilities.water.facility).toEqual(scopedFacility);
    expect(ports.state!.utilities.water.constructionAttempts).toBe(1);
    expect(ports.planCalls).toHaveLength(0);
    expect(result).toBeDefined();
  });

  test("a resume keeps the same unspent course and never claims an attempt it did not make", async () => {
    // A live-binding precondition refusal submits nothing and mints no command, so
    // the course is still the one the slice holds.
    const ports = repairPorts({ execute: "PREFLIGHT_ONLY_FAILURE" });
    ports.setState(waterPendingRepairState());
    const before = structuredClone(ports.state!.utilities.water);

    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
    const afterFirst = structuredClone(ports.state!.utilities.water);
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: ports.implementation });

    const repairs = ports.state!.utilities.water.candidateLedger
      .filter((entry) => entry.repair === FACILITY_ACCESS_ROAD_REPAIR);
    // The same course, byte for byte: no re-mint, no second budget, no re-price.
    expect(repairs).toEqual(waterPendingRepairState().utilities.water.candidateLedger
      .filter((entry) => entry.repair === FACILITY_ACCESS_ROAD_REPAIR));
    expect(repairs).toHaveLength(1);
    expect(ports.planCalls).toHaveLength(0);
    expect(afterFirst.accessRoadRepair).toEqual(before.accessRoadRepair);
    // Nothing reached the engine, so the durable record does not say it did — the
    // journal can prove the attempt never happened, and the record must agree.
    expect(ports.state!.utilities.water.accessRoadRepair?.status).toBe("PLANNED");
    expect(ports.state!.utilities.water.accessRoadRepair?.quote).toBe(REPAIR_QUOTE);
    expect(ports.executeCalls.every((call) => call.primitive === "facility-access-road")).toBe(true);
  });

  test("a course the world already carries, or one already commanded, is never re-attempted", async () => {
    // The facility already has its frontage: there is no repair to make.
    const covered = repairPorts({
      evidence: { roadAttachment: "ATTACHED", noRoadAccessWarning: false, cityElectricityCapacitySufficient: true },
    });
    covered.setState(waterPendingRepairState());
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: covered.implementation });
    expect(covered.planCalls).toEqual([]);
    expect(covered.executeCalls.every((call) => call.primitive !== "facility-access-road")).toBe(true);

    // The repair course already reached the world: the ledger says so, so it is
    // not actionable and the workflow does not act on it again.
    const commanded = repairPorts();
    const commandedState = waterPendingRepairState();
    commandedState.utilities.water.accessRoadRepair = {
      status: "ATTEMPTED", quote: REPAIR_QUOTE, offsetFromAdmittedCourse: 26, plannedAtJournalPosition: null,
    };
    const commandedCourse = commandedState.utilities.water.candidateLedger
      .find((entry) => entry.repair === FACILITY_ACCESS_ROAD_REPAIR)!;
    commandedCourse.ledgerState = "OBSERVED_MATCH";
    commandedCourse.commandId = "water:access-road:1";
    commandedCourse.primitiveEffect = "OBSERVED_MATCH";
    commanded.setState(commandedState);

    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: commanded.implementation });
    expect(commanded.executeCalls).toEqual([]);
    expect(commanded.planCalls).toEqual([]);
    expect(result).toMatchObject({ waiting: true, reason: "WAITING_FOR_SERVICE_UPDATE" });
  });

  test("a water-only mandate runs exactly the water work and rewrites no other family", async () => {
    const ports = repairPorts();
    ports.setState(waterPendingRepairState());

    // `scopedScope()` already declares `commissionedKinds: ["water"]`, which is
    // the mandate the live driver narrows to. The scope the bootstrap is handed
    // is the only thing that decides which families run, so a full-mandate run
    // would rewrite all three and this one must not.
    const result = await runScopedGreenfieldUtilityBootstrap({
      scope: { ...scopedScope(), commissionedKinds: ["water"] }, ports: ports.implementation,
    });

    expect(ports.executeCalls.map((call) => call.primitive)).toEqual(["facility-access-road"]);
    const fresh = createDurableGreenfieldUtilityState(scopedScope()).utilities;
    expect(result.state.utilities.electricity).toEqual(fresh.electricity);
    expect(result.state.utilities.sewage).toEqual(fresh.sewage);
  });

  test("the bounded repair is adjudicated for water alone", async () => {
    // The same world reads and the same durable shape, commissioned for another
    // family: the bounded repair has no authority outside water, so its world is
    // never read and no course is ever derived from it.
    const ports = repairPorts();
    ports.setState(waterPendingRepairState());

    await runScopedGreenfieldUtilityBootstrap({
      scope: { ...scopedScope(), commissionedKinds: ["sewage"] }, ports: ports.implementation,
    });

    expect(ports.evidenceCalls).toEqual([]);
    expect(ports.planCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The connection primitive
// ---------------------------------------------------------------------------

describe("facility access road connection primitive", () => {
  const plan = scopedPlan("water");
  const connector: UtilityConnectorReadback = { ...scopedConnector, worldPosition: point(3, 0) };
  const connectionOnlyPlan = {
    mode: "EXISTING_FACILITY_CONNECTION" as const,
    kind: "water" as const,
    facility: { entity: { index: 102, version: 1 }, prefab: "water-starter", position: point(0, 0) },
    connection: { prefab: "Small Water Pipe" as const, start: point(0, 0), end: point(20, 0) },
  };
  const accessRoad: MayorAction[] = [{ type: "build_road", prefab: "Small Road", x1: 26, z1: 0, x2: 26, z2: 8 }];

  test("is offered beside the plan's own courses, before the direct cable, and only when supplied", () => {
    expect(buildUtilityConnectionCandidates(plan, connector).map((candidate) => candidate.primitive))
      .toEqual(["service-road", "direct-cable"]);
    expect(buildUtilityConnectionCandidates(plan, connector, accessRoad).map((candidate) => candidate.primitive))
      .toEqual(["service-road", "facility-access-road", "direct-cable"]);
    // An empty course is no course, and is byte-identical to supplying none.
    expect(buildUtilityConnectionCandidates(plan, connector, []))
      .toEqual(buildUtilityConnectionCandidates(plan, connector));
  });

  test("is the only plan-free course a facility that already exists can be offered", () => {
    expect(buildUtilityConnectionCandidates(connectionOnlyPlan, connector).map((candidate) => candidate.primitive))
      .toEqual(["direct-cable"]);
    const withRepair = buildUtilityConnectionCandidates(connectionOnlyPlan, connector, accessRoad);
    expect(withRepair).toEqual([
      { primitive: "facility-access-road", actions: accessRoad },
      { primitive: "direct-cable", actions: [{ type: "build_road", prefab: "Small Water Pipe", x1: 3, z1: 0, x2: 20, z2: 0 }] },
    ]);
  });

  test("returns a bounded planned service road to the durable child materializer in connection-only replans", () => {
    const replanned = {
      ...connectionOnlyPlan,
      serviceRoads: [{ id: "alternate-contact-road", role: "side" as const, start: point(20, 0), end: point(8, 0) }],
    };
    expect(buildUtilityConnectionCandidates(replanned, connector).map((candidate) => candidate.primitive))
      .toEqual(["service-road", "direct-cable"]);
    expect(buildUtilityConnectionCandidates(replanned, connector)[0].actions).toEqual([
      { type: "build_road", prefab: "Small Road", x1: 20, z1: 0, x2: 11, z2: 0 },
    ]);
  });

  test("does not re-preflight a service-road route already accepted by the scoped native planner", async () => {
    let preflightCalls = 0;
    const replanned = {
      ...connectionOnlyPlan,
      serviceRoadsNativePreflighted: true,
      serviceRoads: [{ id: "accepted-alternate-contact-road", role: "side" as const, start: point(20, 0), end: point(8, 0) }],
    };
    const prepared = await prepareSharedUtilityRecovery({
      kind: "water", expectedRevision: null, connectionOnly: true, selectedPrimitive: "service-road",
      signal: new AbortController().signal,
      ports: {
        plan: async () => ({ status: "candidate", connection: replanned, reason: "bounded native route accepted" }),
        preflight: async () => { preflightCalls += 1; return false; },
        readConnectors: async () => [connector],
        readCapacity: async () => ({ revision: "r1", capacity: 100, consumption: 10, fulfilledConsumption: 0, issueActive: false }),
        currentRevision: async () => null,
        findCurrentUtilityBinding: async () => ({
          status: "MATCH",
          binding: { facility: connectionOnlyPlan.facility, connector },
        }),
      },
    });
    expect(prepared.status).toBe("READY");
    expect(prepared.selected?.primitive).toBe("service-road");
    expect(preflightCalls).toBe(0);
  });

  test("reaches the prepared recovery as its own primitive, with its own empty reason reserved", async () => {
    const prepared = await prepareSharedUtilityRecovery({
      kind: "water", expectedRevision: null, connectionOnly: true, selectedPrimitive: "facility-access-road",
      accessRoad, signal: new AbortController().signal,
      ports: {
        plan: async () => ({ status: "candidate", connection: connectionOnlyPlan, reason: "planned" }),
        preflight: async () => true,
        readConnectors: async () => [connector],
        readCapacity: async () => ({ revision: "r1", capacity: 100, consumption: 10, fulfilledConsumption: 0, issueActive: false }),
        currentRevision: async () => null,
        findCurrentUtilityBinding: async () => ({
          status: "MATCH",
          binding: { facility: { entity: { index: 102, version: 1 }, prefab: "water-starter", position: point(0, 0) }, connector },
        }),
      },
    });
    expect(prepared.status).toBe("READY");
    expect(prepared.selected).toEqual({ primitive: "facility-access-road", actions: accessRoad });
    expect(prepared.selectedCandidatePrimitive).toBe("facility-access-road");

    // Without the course the same request is blocked exactly as it always was: the
    // direct cable remains the only connection-only primitive.
    const withoutRepair = await prepareSharedUtilityRecovery({
      kind: "water", expectedRevision: null, connectionOnly: true, selectedPrimitive: "facility-access-road",
      signal: new AbortController().signal,
      ports: {
        plan: async () => ({ status: "candidate", connection: connectionOnlyPlan, reason: "planned" }),
        preflight: async () => true,
        readConnectors: async () => [connector],
        readCapacity: async () => ({ revision: "r1", capacity: 100, consumption: 10, fulfilledConsumption: 0, issueActive: false }),
        currentRevision: async () => null,
        findCurrentUtilityBinding: async () => ({
          status: "MATCH",
          binding: { facility: { entity: { index: 102, version: 1 }, prefab: "water-starter", position: point(0, 0) }, connector },
        }),
      },
    });
    expect(withoutRepair).toMatchObject({ status: "BLOCKED", reason: "UTILITY_CONNECTION_CANDIDATE_MISSING" });
  });
});

// ---------------------------------------------------------------------------
// The bounded sequence of repair amendments
// ---------------------------------------------------------------------------

/**
 * The certified course of the water access-road repair lineage: a native
 * quadratic Bezier whose control vertex sits about 12 m off the chord, so the
 * curved course and its chord are two different native courses that native
 * prices and attaches differently (378 curved, 468 on the chord).
 */
const REPAIR_CURVE = {
  type: "build_road" as const, prefab: FACILITY_ACCESS_ROAD_PREFAB,
  x1: -226.909, z1: 1316.5, x2: -156.6602929, z2: 1312.469691,
  cx: -191.09731268615568, cz: 1326.4651448408797,
};
const REPAIR_CHORD = {
  type: "build_road" as const, prefab: FACILITY_ACCESS_ROAD_PREFAB,
  x1: -226.909, z1: 1316.5, x2: -156.6602929, z2: 1312.469691,
};

/**
 * An attempt the lineage already spent, and the course it was bound to. The
 * ordinal is immutable once the record exists, so a later attempt is a
 * continuation of a real sequence rather than a first entry that skips over
 * the attempts whose outcomes nobody read. Production reaches the same state
 * by minting one attempt, spending it, and reading its outcome before the next
 * is admitted; the earlier entries here only exist to be history.
 */
function spendRepairAttempt(
  coordinator: V2DurabilityCoordinator,
  activation: ReturnType<typeof activatedWorld>["activation"],
  state: Gate1State,
  attemptIndex: number,
  courseFingerprint: string,
): void {
  const spent = amendAccessRoad(coordinator, activation, state, {
    actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
    courseFingerprint, repairLineage: `water-access-road-repair:${attemptIndex}`, repairAttemptIndex: attemptIndex,
  });
  if (spent.status !== "AMENDED") throw new Error(`attempt ${attemptIndex} was not admitted: ${spent.status}`);
  coordinator.consumeAccessRoadBudgetAmendment(spent.record.amendmentId, courseFingerprint);
}

/** The course fingerprint of an attempt that exists only as spent history. */
function spentCourseFingerprint(attemptIndex: number): string {
  return `water-access-road-repair:spent:${attemptIndex}`;
}

describe("the bounded sequence of repair amendments", () => {
  test("the curved course and its chord are two different authorized courses", () => {
    // The control vertex travels when the action carries one, and it is not
    // invented when the action carries none: the chord has no control point at
    // all, rather than a chord-shaped stand-in for one.
    expect(roadCourseGeometry(REPAIR_CURVE)).toEqual({
      prefab: FACILITY_ACCESS_ROAD_PREFAB,
      x1: -226.909, z1: 1316.5, x2: -156.6602929, z2: 1312.469691,
      cx: -191.09731268615568, cz: 1326.4651448408797,
    });
    expect(roadCourseGeometry(REPAIR_CHORD)).toEqual({
      prefab: FACILITY_ACCESS_ROAD_PREFAB,
      x1: -226.909, z1: 1316.5, x2: -156.6602929, z2: 1312.469691,
    });
    expect(Object.keys(roadCourseGeometry(REPAIR_CHORD))).not.toContain("cx");
    // The authorization fingerprint binds the whole course, so two courses that
    // share both endpoints are still two courses.
    expect(JSON.parse(stableRoadInput(roadCourseGeometry(REPAIR_CURVE)))).toEqual({
      actionFamily: "ROAD", prefab: FACILITY_ACCESS_ROAD_PREFAB,
      x1: -226.909, z1: 1316.5, x2: -156.6602929, z2: 1312.469691,
      cx: -191.09731268615568, cz: 1326.4651448408797,
    });
    expect(stableRoadInput(roadCourseGeometry(REPAIR_CURVE)))
      .not.toBe(stableRoadInput(roadCourseGeometry(REPAIR_CHORD)));
  });

  test("a half-specified or non-finite control point is refused, never dropped", () => {
    expect(() => roadCourseGeometry({ ...REPAIR_CHORD, cx: 1 })).toThrow("ROAD_COURSE_CONTROL_POINT_UNPAIRED");
    expect(() => roadCourseGeometry({ ...REPAIR_CHORD, cz: 1 })).toThrow("ROAD_COURSE_CONTROL_POINT_UNPAIRED");
    expect(() => roadCourseGeometry({ ...REPAIR_CHORD, cx: 1, cz: Number.NaN }))
      .toThrow("ROAD_COURSE_CONTROL_POINT_NOT_FINITE");
    expect(() => roadCourseGeometry({ ...REPAIR_CHORD, cx: 1, cz: Number.POSITIVE_INFINITY }))
      .toThrow("ROAD_COURSE_CONTROL_POINT_NOT_FINITE");
  });

  test("the next ordinal is one past the highest the lineage already carries", () => {
    expect(nextFacilityAccessRoadRepairAttemptIndex([])).toBe(1);
    expect(nextFacilityAccessRoadRepairAttemptIndex([3])).toBe(4);
    expect(nextFacilityAccessRoadRepairAttemptIndex([1, 2, 3])).toBe(4);
    // A lineage that has spent its last attempt is closed, not extended: nothing
    // derives a fifth ordinal, so no production path opens an attempt five.
    expect(() => nextFacilityAccessRoadRepairAttemptIndex([FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX]))
      .toThrow("FACILITY_ACCESS_ROAD_REPAIR_ATTEMPTS_EXHAUSTED");
    expect(() => nextFacilityAccessRoadRepairAttemptIndex([1, 2, 3, FACILITY_ACCESS_ROAD_MAX_REPAIR_ATTEMPT_INDEX]))
      .toThrow("FACILITY_ACCESS_ROAD_REPAIR_ATTEMPTS_EXHAUSTED");
    // An ordinal recorded before the field existed is read from the lineage
    // suffix, which is deterministic and immutable.
    expect(facilityAccessRoadRepairAttemptIndexFromLineage("p:r:facility-access-road:3")).toBe(3);
    expect(facilityAccessRoadRepairAttemptIndexFromLineage("p:r:facility-access-road:12")).toBe(12);
    expect(facilityAccessRoadRepairAttemptIndexFromLineage(undefined)).toBeNull();
    expect(facilityAccessRoadRepairAttemptIndexFromLineage("p:r:facility-access-road")).toBeNull();
    expect(facilityAccessRoadRepairAttemptIndexFromLineage("p:r:facility-access-road:0")).toBeNull();
    expect(facilityAccessRoadRepairLineage({ projectId: "p", planRevision: "r", attemptIndex: 4 }))
      .toBe("p:r:facility-access-road:4");
  });

  test("attempt four continues the lineage by one, and attempt three stays byte-identical", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const chordFingerprint = JSON.stringify([REPAIR_CHORD]);
    const curveFingerprint = JSON.stringify([REPAIR_CURVE]);

    // The attempts before it are already spent, so this is the third step of a
    // sequence, not an entry that skipped the first two.
    spendRepairAttempt(coordinator, activation, state, 1, spentCourseFingerprint(1));
    spendRepairAttempt(coordinator, activation, state, 2, spentCourseFingerprint(2));

    // The durable history attempt three left behind: minted, native-attempted,
    // consumed.
    const third = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 468, segmentQuotes: [468], planRevision: "generation-a:production",
      courseFingerprint: chordFingerprint, repairLineage: "water-access-road-repair:3", repairAttemptIndex: 3,
    });
    expect(third.status).toBe("AMENDED");
    coordinator.consumeAccessRoadBudgetAmendment(third.record.amendmentId, chordFingerprint);
    const attemptThree = structuredClone(coordinator.utilityBudgetAmendments()
      .find((entry) => entry.amendmentId === third.record.amendmentId));

    // The same lineage, one ordinal further, on a DIFFERENT course: attempt four
    // is a new amendment, not a replay of attempt three.
    const fourth = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:4", repairAttemptIndex: 4,
      repair: {
        facilityPlaced: true, roadAttachment: "NONE", accessRoadCommandIds: ["attempt-three-command"],
        previousAttempt: {
          commandId: "attempt-three-command", courseFingerprint: chordFingerprint,
          authorizationSpent: true, terminalStatus: "REJECTED",
          currentWorldEffect: "ABSENT_DUE_TO_USER_ROLLBACK", reconciliationComplete: true,
        },
      },
    });
    expect(fourth.status).toBe("AMENDED");
    if (fourth.status !== "AMENDED") return;
    expect(fourth.record.repairAttemptIndex).toBe(4);
    expect(fourth.record.courseFingerprint).toBe(curveFingerprint);
    expect(fourth.record.status).toBe("ACTIVE");
    expect(fourth.record.executionUseStatus).toBe("UNUSED");
    expect(fourth.record.executionUseLimit).toBe(1);
    // Attempt three is history: recording attempt four did not touch it.
    expect(coordinator.utilityBudgetAmendments().find((entry) => entry.amendmentId === attemptThree!.amendmentId))
      .toEqual(attemptThree);
    // Both ordinals are durable, in order, each bound to its own course.
    expect(coordinator.utilityBudgetAmendments()
      .filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)
      .map((entry) => [entry.repairAttemptIndex, entry.courseFingerprint, entry.status]))
      .toEqual([
        [1, spentCourseFingerprint(1), "CONSUMED"],
        [2, spentCourseFingerprint(2), "CONSUMED"],
        [3, chordFingerprint, "CONSUMED"],
        [4, curveFingerprint, "ACTIVE"],
      ]);
  });

  test("a spent attempt cannot be minted again, and no ordinal beyond the ceiling can be minted at all", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const chordFingerprint = JSON.stringify([REPAIR_CHORD]);
    const curveFingerprint = JSON.stringify([REPAIR_CURVE]);
    spendRepairAttempt(coordinator, activation, state, 1, spentCourseFingerprint(1));
    spendRepairAttempt(coordinator, activation, state, 2, spentCourseFingerprint(2));
    const third = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 468, segmentQuotes: [468], planRevision: "generation-a:production",
      courseFingerprint: chordFingerprint, repairLineage: "water-access-road-repair:3", repairAttemptIndex: 3,
    });
    coordinator.consumeAccessRoadBudgetAmendment(third.record.amendmentId, chordFingerprint);

    // Attempt five is beyond the ceiling even though it is the next number: the
    // ceiling belongs to the capability, not to the arithmetic.
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:5", repairAttemptIndex: 5,
    })).toThrow("FACILITY_ACCESS_ROAD_REPAIR_ATTEMPT_INDEX_BEYOND_CEILING:5");

    // An ordinal that is not the next one is refused too: the sequence may not
    // skip the attempt whose outcome nobody read.
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:2", repairAttemptIndex: 2,
    })).toThrow("FACILITY_ACCESS_ROAD_REPAIR_ATTEMPT_INDEX_NOT_NEXT:2");

    const fourth = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:4", repairAttemptIndex: 4,
      repair: {
        facilityPlaced: true, roadAttachment: "NONE", accessRoadCommandIds: ["attempt-three-command"],
        previousAttempt: {
          commandId: "attempt-three-command", courseFingerprint: chordFingerprint,
          authorizationSpent: true, terminalStatus: "REJECTED",
          currentWorldEffect: "ABSENT_DUE_TO_USER_ROLLBACK", reconciliationComplete: true,
        },
      },
    });
    expect(fourth.status).toBe("AMENDED");
    coordinator.consumeAccessRoadBudgetAmendment(fourth.record.amendmentId, curveFingerprint);
    // Once attempt four is spent, neither it nor attempt five can be minted
    // again: the lineage is closed, not rewound and not extended.
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:4", repairAttemptIndex: 4,
    })).toThrow("FACILITY_ACCESS_ROAD_AUTHORIZATION_MINT_ALREADY_FINALIZED");
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: JSON.stringify([{ ...REPAIR_CURVE, cx: -191.0973126861557 }]),
      repairLineage: "water-access-road-repair:5", repairAttemptIndex: 5,
    })).toThrow("FACILITY_ACCESS_ROAD_REPAIR_ATTEMPT_INDEX_BEYOND_CEILING:5");
    expect(coordinator.utilityBudgetAmendments()
      .filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON))
      .toHaveLength(4);
  });

  test("an attempt in flight is retired before it is continued, never overlapped", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const chordFingerprint = JSON.stringify([REPAIR_CHORD]);
    const curveFingerprint = JSON.stringify([REPAIR_CURVE]);
    spendRepairAttempt(coordinator, activation, state, 1, spentCourseFingerprint(1));
    spendRepairAttempt(coordinator, activation, state, 2, spentCourseFingerprint(2));
    const third = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 468, segmentQuotes: [468], planRevision: "generation-a:production",
      courseFingerprint: chordFingerprint, repairLineage: "water-access-road-repair:3", repairAttemptIndex: 3,
    });
    expect(third.status).toBe("AMENDED");

    // Attempt three is ACTIVE and unspent. Attempt four does not run beside it:
    // the unspent authorization is retired as the next attempt is recorded, so
    // the lineage never holds two live repair authorizations at once, and the
    // retired attempt is still never replayable.
    const fourth = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:4", repairAttemptIndex: 4,
    });
    expect(fourth.status).toBe("AMENDED");
    expect(coordinator.utilityBudgetAmendments()
      .filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)
      .map((entry) => [entry.repairAttemptIndex, entry.status]))
      .toEqual([[1, "CONSUMED"], [2, "CONSUMED"], [3, "SUPERSEDED_UNUSED"], [4, "ACTIVE"]]);
    expect(coordinator.utilityBudgetAmendments().filter((entry) => entry.status === "ACTIVE")).toHaveLength(1);
  });

  test("a continuation whose predecessor outcome was never read is refused", () => {
    const { coordinator, activation } = activatedWorld();
    const state = roadDeliveredState();
    const chordFingerprint = JSON.stringify([REPAIR_CHORD]);
    const curveFingerprint = JSON.stringify([REPAIR_CURVE]);
    spendRepairAttempt(coordinator, activation, state, 1, spentCourseFingerprint(1));
    spendRepairAttempt(coordinator, activation, state, 2, spentCourseFingerprint(2));
    const third = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 468, segmentQuotes: [468], planRevision: "generation-a:production",
      courseFingerprint: chordFingerprint, repairLineage: "water-access-road-repair:3", repairAttemptIndex: 3,
    });
    expect(third.status).toBe("AMENDED");
    coordinator.consumeAccessRoadBudgetAmendment(third.record.amendmentId, chordFingerprint);

    // The predecessor is neither an observed effect nor a reconciled rollback,
    // so attempt four is refused on the unread outcome instead of being
    // admitted beside it.
    expect(() => amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:4", repairAttemptIndex: 4,
      repair: {
        facilityPlaced: true, roadAttachment: "NONE", accessRoadCommandIds: ["attempt-three-command"],
        previousAttempt: { commandId: "attempt-three-command", courseFingerprint: chordFingerprint, authorizationSpent: true },
      },
    })).toThrow("ACCESS_ROAD_PREVIOUS_ATTEMPT_NOT_TERMINAL_OR_ROLLBACK_RECONCILED");
    // The refused mint wrote nothing.
    expect(coordinator.utilityBudgetAmendments()
      .filter((entry) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON))
      .toHaveLength(3);
  });

  test("the curved repair commits atomically and refuses its chord as a different course", () => {
    const storage = createMemoryDurableStateStorage();
    const { coordinator, activation } = activatedWorld(storage);
    const state = roadDeliveredState();
    const curveFingerprint = JSON.stringify([REPAIR_CURVE]);
    spendRepairAttempt(coordinator, activation, state, 1, spentCourseFingerprint(1));
    spendRepairAttempt(coordinator, activation, state, 2, spentCourseFingerprint(2));
    spendRepairAttempt(coordinator, activation, state, 3, JSON.stringify([REPAIR_CHORD]));
    const curveInput = stableRoadInput(roadCourseGeometry(REPAIR_CURVE));
    const chordInput = stableRoadInput(roadCourseGeometry(REPAIR_CHORD));
    const amendment = amendAccessRoad(coordinator, activation, state, {
      actualAccessRoadQuote: 378, segmentQuotes: [378], planRevision: "generation-a:production",
      courseFingerprint: curveFingerprint, repairLineage: "water-access-road-repair:4", repairAttemptIndex: 4,
      repair: {
        facilityPlaced: true, roadAttachment: "NONE", accessRoadCommandIds: ["attempt-three-command"],
        previousAttempt: {
          commandId: "attempt-three-command", courseFingerprint: JSON.stringify([REPAIR_CHORD]),
          authorizationSpent: true, terminalStatus: "REJECTED",
          currentWorldEffect: "ABSENT_DUE_TO_USER_ROLLBACK", reconciliationComplete: true,
        },
      },
    });
    expect(amendment.status).toBe("AMENDED");
    if (amendment.status !== "AMENDED") return;
    const record = {
      schemaVersion: "ai-mayor-v2-command/1" as const,
      commandId: "curved-repair-command-4",
      actionFamily: "ROAD" as const,
      actionType: "build_road",
      authorizedScope: {
        owner: { ownerType: "PROJECT" as const, ownerId: state.project.id },
        actionFamily: "ROAD" as const,
        proposalId: "proposal-curved-4", quoteId: "quote-curved-4",
        fingerprint: curveInput, exactInput: curveInput,
        budget: { authorizedMaxSpend: 378, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        observationPrecondition: { runtimeEpoch: "bridge:1", frame: 1 }, expiresAt: "2099-01-01T00:00:00.000Z",
        facilityAccessRoadRepair: {
          amendmentId: amendment.record.amendmentId, repairLineage: "water-access-road-repair:4",
          planRevision: "generation-a:production", actionFingerprint: curveFingerprint, actionCount: 1 as const,
          purpose: "Pump native road attachment repair", prefab: FACILITY_ACCESS_ROAD_PREFAB,
        },
      },
      createdAt: INSTANT.toISOString(), submittedAt: null, nativeResultSummary: null, status: "CREATED" as const,
      statusHistory: [{ status: "CREATED" as const, at: INSTANT.toISOString() }],
      reconciliationStatus: "NOT_STARTED" as const, observationEvidence: [], failureOrUnknownReason: null,
      effectAbsenceProven: false,
    };
    const input = {
      amendmentId: amendment.record.amendmentId,
      expectedJournalPosition: coordinator.snapshot().journalPosition,
      expectedWorldId: activation.world.worldId,
      expectedCheckpointId: activation.world.checkpointId,
      expectedGeneration: activation.world.generation,
      repairLineage: "water-access-road-repair:4", planRevision: "generation-a:production",
      actionFingerprint: curveFingerprint, command: record,
    };
    // The chord is not this course. A scope that names it while the authorized
    // action is the curve is refused, so the fingerprint cannot be satisfied by
    // an endpoint pair both courses share.
    expect(() => coordinator.commitFacilityAccessRoadRepairCommand({
      ...input,
      command: { ...record, authorizedScope: { ...record.authorizedScope, exactInput: chordInput, fingerprint: chordInput } },
    })).toThrow("FACILITY_ACCESS_ROAD_COMMIT_COMMAND_BINDING_MISMATCH");
    expect(coordinator.utilityBudgetAmendments().find((entry) => entry.amendmentId === input.amendmentId))
      .toMatchObject({ status: "ACTIVE", executionUseStatus: "UNUSED" });

    // The curved course commits, consuming the authorization exactly once.
    const committed = coordinator.commitFacilityAccessRoadRepairCommand(input);
    expect(committed.commandId).toBe(record.commandId);
    expect(JSON.parse(committed.authorizedScope.exactInput)).toMatchObject({
      cx: REPAIR_CURVE.cx, cz: REPAIR_CURVE.cz, x1: REPAIR_CURVE.x1, z1: REPAIR_CURVE.z1,
    });
    expect(coordinator.utilityBudgetAmendments().find((entry) => entry.amendmentId === input.amendmentId))
      .toMatchObject({ status: "CONSUMED", executionUseStatus: "CONSUMED" });
    expect(coordinator.snapshot().journalPosition).toBe(input.expectedJournalPosition + 1);

    // The authorization is single-use: a replay restores the same command and
    // cannot create a second one.
    const replay = coordinator.commitFacilityAccessRoadRepairCommand({
      ...input, command: { ...record, commandId: "unused-duplicate-id" },
    });
    expect(replay.commandId).toBe(record.commandId);
    expect(coordinator.commandJournal.list()).toHaveLength(1);
    expect(coordinator.snapshot().journalPosition).toBe(input.expectedJournalPosition + 1);
  });
});
