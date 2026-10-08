import type { MayorAction, MayorBatchResult } from "../../src/main/services/ai-mayor/types";
import { cityElectricityCapacityVerdict } from "../../src/main/services/ai-mayor/v2/facility-access-road";
import {
  nativeBatchActionEvidence,
  requiresSequentialRoadExecution,
} from "../../src/main/services/ai-mayor/v2/native-batch-evidence";

const road = (x1: number, z1: number, x2: number, z2: number): MayorAction => ({
  type: "build_road",
  prefab: "Small Road",
  x1,
  z1,
  x2,
  z2,
});

describe("Water Phase 7 native batch and electricity freshness contracts", () => {
  test("reload transient 0/0 remains UNKNOWN until the loaded simulation has ticked", () => {
    expect(cityElectricityCapacityVerdict({ freshness: "UNSETTLED", production: 0, consumption: 0 })).toBe("UNKNOWN");
    expect(cityElectricityCapacityVerdict({ freshness: "UNKNOWN", production: 0, consumption: 0 })).toBe("UNKNOWN");
  });

  test("settled true-zero fails closed while settled positive sufficient capacity passes", () => {
    expect(cityElectricityCapacityVerdict({ freshness: "SETTLED", production: 0, consumption: 0 })).toBe(false);
    expect(cityElectricityCapacityVerdict({ freshness: "SETTLED", production: 4389, consumption: 3147 })).toBe(true);
    expect(cityElectricityCapacityVerdict({ freshness: "SETTLED", production: 10, consumption: 11 })).toBe(false);
  });

  test("independent previews do not authorize a multi-road sequential batch", () => {
    const allPreBatchPreviewsPass = [true, true];
    const batchActions = [road(0, 0, 1, 1), road(1, 1, 2, 2)];
    // Even two PASS results share one pre-effect world; a preceding edge may
    // alter the geometry the later preview will meet at execution time.
    expect(allPreBatchPreviewsPass.every(Boolean)).toBe(true);
    expect(requiresSequentialRoadExecution(batchActions)).toBe(true);
    expect(requiresSequentialRoadExecution([road(0, 0, 1, 1)])).toBe(false);
  });

  test("preserves attempted per-action results without claiming native acceptance or world effect", () => {
    const actions = [road(0, 0, 1, 1), road(1, 1, 2, 2)];
    const batch: MayorBatchResult = {
      ok: false,
      requested: 2,
      executed: 2,
      failedAt: 1,
      results: [
        { index: 0, type: "build_road", ok: true, summary: "handler returned", bridgeCommandId: "bridge-1" },
        {
          index: 1,
          type: "build_road",
          ok: false,
          summary: "rejected by validation",
          error: "NATIVE_REJECTED",
          rejectionDiagnostics: { reason: "overlap" },
        },
      ],
    };
    const evidence = nativeBatchActionEvidence({ actions, quotes: [210, 160], batch, operationId: "operation-1" });
    expect(evidence.batchSemantics).toMatchObject({
      atomic: false,
      executionOrder: "INPUT_ORDER",
      attemptedActionCount: 2,
      worldEffectConfirmedCount: 0,
    });
    expect(evidence.actions).toMatchObject([
      {
        actionIndex: 0,
        quote: 210,
        submitted: true,
        attempted: true,
        bridgeRequestOutcome: "RETURNED",
        nativeAcceptance: "UNKNOWN",
        authoritativeEffectStatus: "UNOBSERVED",
        operationId: "bridge-1",
      },
      {
        actionIndex: 1,
        quote: 160,
        submitted: true,
        attempted: true,
        bridgeRequestOutcome: "ERROR",
        nativeAcceptance: "UNKNOWN",
        errorCode: "NATIVE_REJECTED",
        rejectionDiagnostics: { reason: "overlap" },
        authoritativeEffectStatus: "UNOBSERVED",
      },
    ]);
  });

  test("does not fabricate result rows for actions after a sequential failure", () => {
    const evidence = nativeBatchActionEvidence({
      actions: [road(0, 0, 1, 1), road(1, 1, 2, 2), road(2, 2, 3, 3)],
      quotes: [1, 2, 3],
      operationId: "op",
      batch: {
        ok: false,
        requested: 3,
        executed: 2,
        failedAt: 1,
        results: [
          { index: 0, type: "build_road", ok: true, summary: "returned" },
          { index: 1, type: "build_road", ok: false, summary: "failed" },
        ],
      },
    });
    expect(evidence.actions[2]).toMatchObject({
      submitted: false,
      attempted: false,
      bridgeRequestOutcome: "NOT_REACHED",
      failureStage: "NOT_REACHED",
    });
  });
});
