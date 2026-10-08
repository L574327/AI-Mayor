import { normalizeNativeRoadDiagnostics } from "../../src/main/services/ai-mayor/v2/runtime-road-caller";

describe("ROAD proposal-scoped native diagnostics", () => {
  const layered = (realizedStartEntity: unknown, attachmentMatch: boolean) => ({
    validation: { status: "REJECTED", detailAvailable: false, diagnosticStatus: "DIAGNOSTIC_ERRORDATA_READ_FAILED" },
    structural: { generatedEdge: true, generatedEdgeCount: 1, generatedNodeCount: 2, essentialTempValid: true },
    diagnostics: {
      request: { requestedStartEntity: { index: 76996, version: 3 }, requestedEndKind: "NEW_FREE_ENDPOINT" },
      realization: { realizedStartEntity, attachmentMatch, generatedEdgeCount: 1, generatedNodeCount: 2, generatedTempEntities: [{ kind: "EDGE", startNodeEntity: realizedStartEntity }] },
      validation: { allowApply: false, detailAvailable: false, diagnosticStatus: "DIAGNOSTIC_ERRORDATA_READ_FAILED" },
    },
  });

  test("preserves requested/realized identity and match", () => {
    const result = normalizeNativeRoadDiagnostics(layered({ index: 76996, version: 3 }, true));
    expect(result?.request?.requestedStartEntity).toEqual({ index: 76996, version: 3 });
    expect(result?.realization?.realizedStartEntity).toEqual({ index: 76996, version: 3 });
    expect(result?.realization?.attachmentMatch).toBe(true);
    expect(result?.structural?.generatedEdge).toBe(true);
  });

  test("reports mismatch including Entity.Null without coordinate fallback", () => {
    const result = normalizeNativeRoadDiagnostics(layered(null, false));
    expect(result?.realization?.attachmentMatch).toBe(false);
    expect(result?.errorDataStatus).toBe("DIAGNOSTIC_ERRORDATA_READ_FAILED");
    expect(result?.validation?.errors).toBeUndefined();
  });

  test("serializes bounded native errors when ErrorData is available", () => {
    const result = normalizeNativeRoadDiagnostics({ validation: { status: "REJECTED", detailAvailable: true, errors: [
      { errorType: "OverlapExisting", severity: "Error", toolError: "ToolError" },
      { errorType: 4, severity: 2 },
    ] } });
    expect(result?.classification).toBe("REJECTED_WITH_NATIVE_ERRORS");
    expect(result?.validation?.errors).toHaveLength(2);
  });
});
