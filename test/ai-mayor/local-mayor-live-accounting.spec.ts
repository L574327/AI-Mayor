import {
  accountLocalMayorBatchExecution,
  countLocalMayorLiveExecutions,
  localMayorGrowthInvariantViolation,
  missingLocalMayorLiveTools,
} from "../../scripts/local-mayor-live-accounting";
import type { MayorBatchResult } from "../../src/main/services/ai-mayor/types";

const batch = (result: MayorBatchResult["results"][number]): MayorBatchResult => ({
  ok: result.ok,
  requested: 1,
  executed: result.ok ? 1 : 0,
  results: [result],
});

describe("Local Mayor live harness accounting", () => {
  test("counts choose_candidate -> build_road from the successful batch result", () => {
    const accounting = accountLocalMayorBatchExecution({
      selectedCandidateId: "road-1",
      candidates: [{ id: "road-1", actionType: "build_road" }],
      batch: batch({ index: 0, type: "build_road", ok: true, summary: "road committed" }),
    });
    expect(accounting[0]).toMatchObject({
      selectedActionType: "build_road",
      executedActionType: "build_road",
      executionSucceeded: true,
    });
    expect(countLocalMayorLiveExecutions(accounting)).toEqual({ roadExecutions: 1, zoningExecutions: 0 });
  });

  test("counts choose_candidate -> zone from the successful batch result", () => {
    const accounting = accountLocalMayorBatchExecution({
      selectedCandidateId: "zone-1",
      candidates: [{ id: "zone-1", actionType: "zone" }],
      batch: batch({ index: 0, type: "zone", ok: true, summary: "zoning committed" }),
    });
    expect(accounting[0]).toMatchObject({
      selectedActionType: "zone",
      executedActionType: "zone",
      executionSucceeded: true,
    });
    expect(countLocalMayorLiveExecutions(accounting)).toEqual({ roadExecutions: 0, zoningExecutions: 1 });
  });

  test("records failed candidates without counting an execution", () => {
    const accounting = accountLocalMayorBatchExecution({
      selectedCandidateId: "road-1",
      candidates: [{ id: "road-1", actionType: "build_road" }],
      batch: batch({ index: 0, type: "build_road", ok: false, summary: "rejected", error: "collision" }),
    });
    expect(accounting[0].executionSucceeded).toBe(false);
    expect(countLocalMayorLiveExecutions(accounting)).toEqual({ roadExecutions: 0, zoningExecutions: 0 });
  });

  test("keeps unknown candidate metadata explicit", () => {
    const accounting = accountLocalMayorBatchExecution({
      selectedCandidateId: "missing",
      candidates: [],
      batch: batch({ index: 0, type: "place_building", ok: true, summary: "other" }),
    });
    expect(accounting[0]).toMatchObject({ selectedActionType: "unknown", executedActionType: "other" });
  });

  test("accepts fast bounded growth without a wall-clock action-rate threshold", () => {
    expect(
      localMayorGrowthInvariantViolation({
        batchActionCount: 8,
        roadsInBurst: 8,
        zoningInBurst: 8,
        consecutiveSuccessfulBursts: 2,
      }),
    ).toBeNull();
  });

  test.each([
    ["runaway_batch_bound", { batchActionCount: 9, roadsInBurst: 0, zoningInBurst: 0, consecutiveSuccessfulBursts: 0 }],
    [
      "runaway_burst_road_bound",
      { batchActionCount: 8, roadsInBurst: 9, zoningInBurst: 0, consecutiveSuccessfulBursts: 0 },
    ],
    [
      "runaway_burst_zoning_bound",
      { batchActionCount: 8, roadsInBurst: 0, zoningInBurst: 9, consecutiveSuccessfulBursts: 0 },
    ],
    [
      "runaway_unbounded_district_bursts",
      { batchActionCount: 8, roadsInBurst: 1, zoningInBurst: 1, consecutiveSuccessfulBursts: 3 },
    ],
  ])("classifies bounded-product invariant %s", (expected, input) => {
    expect(localMayorGrowthInvariantViolation(input)).toBe(expected);
  });

  test("requires the complete Local Mayor live tool set", () => {
    expect(missingLocalMayorLiveTools(["cs2_mayor_snapshot"])).toEqual([
      "cs2_spatial",
      "cs2_mayor_execute_actions",
      "cs2_utility_connectors",
      "cs2_city_services",
      "cs2_run_simulation",
      "cs2_game_state",
      "cs2_save_game",
    ]);
    expect(
      missingLocalMayorLiveTools([
        "cs2_mayor_snapshot",
        "cs2_spatial",
        "cs2_mayor_execute_actions",
        "cs2_utility_connectors",
        "cs2_city_services",
        "cs2_run_simulation",
        "cs2_game_state",
        "cs2_save_game",
      ]),
    ).toEqual([]);
  });
});
