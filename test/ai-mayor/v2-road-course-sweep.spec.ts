import {
  classifyRoadCoursePreview,
  createRoadCourseCertificationCache,
  isRoadCourseProbeContention,
  planRoadCourseSweep,
  ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET,
  sweepCertifiableRoadCourse,
} from "../../src/main/services/ai-mayor/v2/road-course-sweep";
import type { RoadGeometryInput } from "../../src/main/services/ai-mayor/v2/road-kernel";

const certifiable = () => ({
  valid: true,
  previewOnly: true,
  validNewRoadProposal: true,
  roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
  courseIntegrity: {
    operationKind: "NEW_ROAD_PROPOSAL_EDGE",
    postHandoffGeometryPreserved: true,
    proposalEdgeCount: 1,
    firstFailure: null,
  },
});

/** The measured sparse answer: no proposal edge forms at this heading at all. */
const noProposalEdge = () => ({
  valid: false,
  previewOnly: true,
  validNewRoadProposal: false,
  roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
  courseIntegrity: {
    operationKind: "NEW_ROAD_PROPOSAL_EDGE",
    postHandoffGeometryPreserved: true,
    proposalEdgeCount: 0,
    firstFailure: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED",
  },
});

/** The other measured answer: an edge formed, and the game refused to place it. */
const placementRefused = () => ({
  valid: false,
  previewOnly: true,
  validNewRoadProposal: false,
  courseIntegrity: {
    operationKind: "NEW_ROAD_PROPOSAL_EDGE",
    postHandoffGeometryPreserved: true,
    proposalEdgeCount: 1,
    firstFailure: "operation blocked by game validation (water, steep terrain)",
  },
});

/**
 * The exact HTTP 409 body the live Bridge returned on 2026-10-01 for a course
 * from `75948:215` whose start endpoint bound correctly and whose far end landed
 * on a slope. Copied from the response, not paraphrased: this shape is the whole
 * reason the sweep has to read `rejectionDiagnostics` and `nativeToolErrors`
 * rather than `valid`/`courseIntegrity`.
 */
const livePlacementRefusal = () => ({
  validation: { status: "REJECTED", allowApply: false, detailAvailable: false, diagnosticStatus: "DIAGNOSTIC_ERRORDATA_READ_FAILED" },
  structural: { generatedEdge: true, generatedEdgeCount: 5, generatedNodeCount: 6, essentialTempValid: true },
  nativeToolErrors: [{
    ownerEntity: { index: 49837, version: 673 },
    errorPrefab: { entity: { index: 14246, version: 1 }, name: "Steep Slope" },
    errorType: "SteepSlope",
    position: { x: 1387.8406982421875, y: 413.2880859375, z: 420.64950561523438 },
    priority: "Error",
  }],
  rejectionDiagnostics: {
    schemaVersion: "rejection-diagnostics-v1",
    stage: "APPLY_GUARD",
    sourceFunction: "BridgeToolSystem.BuildRejectedResponse",
    errorType: "UNKNOWN",
    message: "operation blocked by game validation (overlap, water, steep terrain, protected entity...); try a different position or target",
    allowApply: false,
    nativeCommandCreated: false,
    commandId: "bridge-029393b19fb44134aa1244a539019452",
  },
  error: "operation blocked by game validation (overlap, water, steep terrain, protected entity...); try a different position or target",
});

/** The other measured refusal: rejected while DEFINING the endpoint, so no course was ever judged. */
const liveEndpointMismatch = () => ({
  endpoint: "START",
  rejectionDiagnostics: {
    schemaVersion: "rejection-diagnostics-v1",
    stage: "DEFINITION",
    sourceFunction: "BridgeToolSystem.CreateRoadDefinitions",
    errorType: "ROAD_ENDPOINT_POSITION_MISMATCH",
    message: "ROAD_ENDPOINT_POSITION_MISMATCH",
    allowApply: "UNKNOWN",
    nativeCommandCreated: false,
    commandId: "bridge-2e7f2a0493fb4daf88fabffbd07d3eb5",
  },
  error: "ROAD_ENDPOINT_POSITION_MISMATCH",
});

const contention = () =>
  Object.assign(new Error("HTTP 409: another build operation is in progress, retry shortly"), { status: 409 });

const ORIGIN = { x: 0, z: 0 };
const TARGET = { x: 40, z: 0 };
const instantRetry = { attempts: 3, sleep: async () => {} };

const sweep = (probe: (input: RoadGeometryInput) => Promise<unknown>, extra: Record<string, unknown> = {}) =>
  sweepCertifiableRoadCourse({
    from: ORIGIN,
    to: TARGET,
    prefab: "Medium Road",
    probe,
    retry: instantRetry,
    ...extra,
  });

describe("V2 road course preview verdicts", () => {
  test("keeps the two native refusals apart instead of collapsing them into one INVALID", () => {
    expect(classifyRoadCoursePreview(certifiable())).toEqual({ status: "CERTIFIABLE", proposalEdgeCount: 1 });
    expect(classifyRoadCoursePreview(noProposalEdge())).toMatchObject({
      status: "NO_PROPOSAL_EDGE",
      reason: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED",
    });
    expect(classifyRoadCoursePreview(placementRefused())).toMatchObject({ status: "PLACEMENT_REFUSED" });
    expect(classifyRoadCoursePreview({
      valid: false,
      previewOnly: true,
      courseIntegrity: { firstFailure: "NO_PRODUCTIVE_ROAD_EFFECT", proposalEdgeCount: 1 },
    })).toMatchObject({ status: "NO_PRODUCTIVE_EFFECT" });
  });

  test("reads the live 409 rejection body, which carries no valid/previewOnly/courseIntegrity at all", () => {
    const verdict = classifyRoadCoursePreview(livePlacementRefusal());
    expect(verdict).toMatchObject({ status: "PLACEMENT_REFUSED" });
    if (verdict.status !== "PLACEMENT_REFUSED") throw new Error("unreachable");
    // The game's own reason, which is the only thing a planner can route around.
    expect(verdict.nativeErrorTypes).toEqual(["SteepSlope"]);
  });

  test("rejection bodies reach the classifier whether they were returned or thrown", () => {
    // The product's tool call raises the refusal as an error whose own fields
    // carry the body; a plain fetch hands over the same JSON under `body`.
    expect(classifyRoadCoursePreview(livePlacementRefusal())).toMatchObject({ status: "PLACEMENT_REFUSED" });
    expect(classifyRoadCoursePreview({ status: 409, body: livePlacementRefusal() })).toMatchObject({ status: "PLACEMENT_REFUSED" });
  });

  test("a DEFINE-stage endpoint rejection is not a verdict on the course", () => {
    expect(classifyRoadCoursePreview(liveEndpointMismatch())).toMatchObject({
      status: "ENDPOINT_UNBOUND",
      reason: "ROAD_ENDPOINT_POSITION_MISMATCH",
    });
  });

  test("an unconfirmed dry run is UNKNOWN, never a rejection", () => {
    expect(classifyRoadCoursePreview({ valid: true })).toMatchObject({
      status: "UNKNOWN",
      reason: "ROAD_COURSE_PREVIEW_ONLY_NOT_CONFIRMED",
    });
  });

  test("a course whose geometry did not survive the handoff is refused, not certified", () => {
    const answer = certifiable();
    answer.courseIntegrity.postHandoffGeometryPreserved = false;
    expect(classifyRoadCoursePreview(answer)).toMatchObject({ status: "PLACEMENT_REFUSED" });
  });

  test("only the Bridge's single-flight contention counts as contention", () => {
    expect(isRoadCourseProbeContention(contention())).toBe(true);
    expect(isRoadCourseProbeContention(new Error("bridge unavailable"))).toBe(false);
    // The other 409 — a structured validation rejection with no command — is a
    // verdict on the course and must never be retried as if it were contention.
    expect(isRoadCourseProbeContention(Object.assign(new Error("native route rejected"), {
      status: 409,
      validation: { status: "REJECTED" },
      rejectionDiagnostics: { stage: "APPLY_GUARD", allowApply: false, nativeCommandCreated: false },
    }))).toBe(false);
  });
});

describe("V2 road course sweep plan", () => {
  test("offers the intent's own course first, then the measured 8 × 3 family", () => {
    const plan = planRoadCourseSweep({ from: ORIGIN, to: TARGET });
    expect(plan.courses[0]).toMatchObject({ ordinal: 0, direct: true, endpoint: { x: 40, z: 0 } });
    expect(plan.courses).toHaveLength(ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET);
    expect(plan.courses.map((course) => course.ordinal)).toEqual(
      plan.courses.map((_, index) => index),
    );
  });

  test("headings are offsets from the intent's own bearing, so the sweep stays aimed", () => {
    // A target due north: the same family, rotated. Offset 0 is still the target.
    const plan = planRoadCourseSweep({ from: ORIGIN, to: { x: 0, z: 40 } });
    expect(plan.bearingDegrees).toBeCloseTo(90, 6);
    const dueEast = plan.courses.find((course) => course.offsetDegrees === 270 && course.lengthMeters === 16);
    expect(dueEast?.endpoint.x).toBeCloseTo(16, 6);
    expect(dueEast?.endpoint.z).toBeCloseTo(0, 6);
    expect(dueEast?.headingDegrees).toBeCloseTo(0, 6);
  });

  test("courses outside the Bridge segment-length contract are not offered at all", () => {
    const plan = planRoadCourseSweep({ from: ORIGIN, bearingDegrees: 0, offsets: [0], lengths: [4, 24] });
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].lengthMeters).toBe(24);
  });

  test("the plan is a pure function of its inputs", () => {
    expect(planRoadCourseSweep({ from: ORIGIN, to: TARGET })).toEqual(planRoadCourseSweep({ from: ORIGIN, to: TARGET }));
  });
});

describe("V2 road course sweep", () => {
  test("probes strictly serially", async () => {
    // Native's build slot is single-flight, so overlapping probes would
    // manufacture the very contention the sweep is here to absorb.
    let active = 0;
    let maximumActive = 0;
    const outcome = await sweep(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return noProposalEdge();
    });
    expect(maximumActive).toBe(1);
    expect(outcome.status).toBe("EXHAUSTED");
  });

  test("a refused direct course falls through to a swept heading and reports the ordinal it certified", async () => {
    const probed: RoadGeometryInput[] = [];
    const outcome = await sweep(async (input) => {
      probed.push(input);
      // Refuse the direct course and every course until the sixth: this is the
      // sparse world the sweep exists for.
      return probed.length < 6 ? noProposalEdge() : certifiable();
    });
    expect(outcome.status).toBe("CERTIFIED");
    if (outcome.status !== "CERTIFIED") throw new Error("unreachable");
    expect(outcome.probes).toBe(6);
    expect(outcome.course.ordinal).toBe(5);
    expect(outcome.cacheHit).toBe(false);
    expect(probed[0]).toMatchObject({ x1: 0, z1: 0, x2: 40, z2: 0 });
    expect(probed[5]).toMatchObject({ x1: 0, z1: 0, x2: outcome.course.endpoint.x, z2: outcome.course.endpoint.z });
  });

  test("records each refusal under the ordinal that produced it, keeping the two kinds apart", async () => {
    let call = 0;
    const outcome = await sweep(async () => (call += 1) === 1 ? noProposalEdge() : call === 2 ? placementRefused() : certifiable());
    expect(outcome.status).toBe("CERTIFIED");
    if (outcome.status !== "CERTIFIED") throw new Error("unreachable");
    expect(outcome.course.ordinal).toBe(2);
  });

  test("every course refused is EXHAUSTED, with the full rejection list", async () => {
    const outcome = await sweep(async () => noProposalEdge());
    expect(outcome.status).toBe("EXHAUSTED");
    if (outcome.status !== "EXHAUSTED") throw new Error("unreachable");
    expect(outcome.rejections).toHaveLength(ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET);
    expect(outcome.rejections.every((rejection) => rejection.verdict === "NO_PROPOSAL_EDGE")).toBe(true);
    expect(outcome.probes).toBe(ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET);
  });

  test("single-flight contention is retried, not recorded as a course that cannot be built", async () => {
    let call = 0;
    const outcome = await sweep(async () => {
      call += 1;
      if (call <= 2) throw contention();
      return certifiable();
    });
    expect(outcome.status).toBe("CERTIFIED");
    if (outcome.status !== "CERTIFIED") throw new Error("unreachable");
    expect(call).toBe(3);
    expect(outcome.course.ordinal).toBe(0);
  });

  test("contention that outlives its retries stops the sweep instead of spending the budget", async () => {
    let call = 0;
    const outcome = await sweep(async () => {
      call += 1;
      throw contention();
    });
    expect(outcome.status).toBe("UNRESOLVED_CONTENTION");
    expect(call).toBe(3);
    if (outcome.status !== "UNRESOLVED_CONTENTION") throw new Error("unreachable");
    expect(outcome.rejections).toHaveLength(0);
  });

  test("a refusal thrown by the transport is consumed as a verdict, not as a transport failure", async () => {
    let call = 0;
    const outcome = await sweep(async () => {
      call += 1;
      // The product's tool call raises the 409 this way.
      throw Object.assign(new Error(livePlacementRefusal().error), livePlacementRefusal());
    });
    expect(outcome.status).toBe("EXHAUSTED");
    if (outcome.status !== "EXHAUSTED") throw new Error("unreachable");
    expect(call).toBe(ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET);
    expect(outcome.rejections.every((rejection) => rejection.verdict === "PLACEMENT_REFUSED")).toBe(true);
  });

  test("a mis-bound endpoint stops the sweep on the first probe instead of blaming every course", async () => {
    let call = 0;
    const outcome = await sweep(async () => {
      call += 1;
      throw Object.assign(new Error("HTTP 409"), { status: 409, body: liveEndpointMismatch() });
    });
    expect(outcome.status).toBe("ENDPOINT_BINDING_FAILED");
    expect(call).toBe(1);
    if (outcome.status !== "ENDPOINT_BINDING_FAILED") throw new Error("unreachable");
    expect(outcome.reason).toBe("ROAD_ENDPOINT_POSITION_MISMATCH");
    expect(outcome.probes).toBe(1);
  });

  test("a transport failure is not a verdict and propagates", async () => {
    await expect(sweep(async () => {
      throw new Error("bridge unavailable");
    })).rejects.toThrow("bridge unavailable");
  });

  test("a certification cache removes the probes, but only for the graph it was certified against", async () => {
    const world = { worldId: "cs2-session:aaaa", topologyRevision: "rev-1" };
    const cache = createRoadCourseCertificationCache(world);
    const first = await sweep(async () => certifiable(), { cache });
    expect(first.status).toBe("CERTIFIED");
    if (first.status !== "CERTIFIED") throw new Error("unreachable");

    let calls = 0;
    const cached = await sweep(async () => {
      calls += 1;
      return certifiable();
    }, { cache });
    expect(cached.status).toBe("CERTIFIED");
    if (cached.status !== "CERTIFIED") throw new Error("unreachable");
    expect(calls).toBe(0);
    expect(cached.cacheHit).toBe(true);
    expect(cached.course.ordinal).toBe(first.course.ordinal);
  });

  test("refusals are cached too, so the next sweep from the same source costs no probes at all", async () => {
    // The measured shape: the one certifiable course sits deep in the family, so
    // caching only the hit still re-pays every refusal before it, every tick.
    const cache = createRoadCourseCertificationCache({ worldId: "cs2-session:aaaa", topologyRevision: "rev-1" });
    let call = 0;
    const first = await sweep(async () => {
      call += 1;
      return call === ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET ? certifiable() : noProposalEdge();
    }, { cache });
    expect(first.status).toBe("CERTIFIED");
    expect(call).toBe(ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET);

    let second = 0;
    const cached = await sweep(async () => {
      second += 1;
      return certifiable();
    }, { cache });
    expect(second).toBe(0);
    expect(cached.status).toBe("CERTIFIED");
    if (cached.status !== "CERTIFIED") throw new Error("unreachable");
    expect(cached.probes).toBe(0);
    expect(cached.course.ordinal).toBe(ROAD_COURSE_SWEEP_STANDARD_PROBE_BUDGET - 1);
  });

  test("an endpoint binding failure is never cached, so a corrected binding can still be swept", async () => {
    const cache = createRoadCourseCertificationCache({ worldId: "cs2-session:aaaa", topologyRevision: "rev-1" });
    const broken = await sweep(async () => {
      throw Object.assign(new Error("HTTP 409"), { status: 409, body: liveEndpointMismatch() });
    }, { cache });
    expect(broken.status).toBe("ENDPOINT_BINDING_FAILED");

    let calls = 0;
    const repaired = await sweep(async () => {
      calls += 1;
      return certifiable();
    }, { cache });
    expect(repaired.status).toBe("CERTIFIED");
    expect(calls).toBe(1);
    expect(cache.size).toBe(1);
  });

  test("a cache from another graph revision is not consulted at all", async () => {
    const fresh = createRoadCourseCertificationCache({ worldId: "cs2-session:aaaa", topologyRevision: "rev-2" });
    const stale = createRoadCourseCertificationCache({ worldId: "cs2-session:aaaa", topologyRevision: "rev-1" });
    stale.put("0.000:0.000", "0.000:0.000|40.000:0.000", { verdict: { status: "CERTIFIABLE", proposalEdgeCount: 1 }, preview: {} });
    let calls = 0;
    const outcome = await sweep(async () => {
      calls += 1;
      return certifiable();
    }, { cache: fresh });
    expect(calls).toBe(1);
    expect(outcome.status).toBe("CERTIFIED");
    if (outcome.status !== "CERTIFIED") throw new Error("unreachable");
    expect(outcome.cacheHit).toBe(false);
  });
});
