import { aggregateV2RoadBatchResult } from "../../src/main/services/ai-mayor/main-adapters";
import {
  buildUtilityTopologyEvidence,
  nativeCompletionTelemetryForUtilityBatch,
  withUtilityNativeCompletionEvidence,
  parseV2McpJson,
} from "../../src/main/services/ai-mayor/v2/main-adapter";

const telemetry = {
  schemaVersion: "cs2mcp-road-end-realization/1",
  commandId: "bridge-end-123",
  requestedEntity: { index: 324302, version: 13 },
  expectedPosition: { x: -797.2348, y: 617.6969, z: -1138.24731 },
  preGeneration: { requestedEntity: { index: 324302, version: 13 }, netCourseEndEntity: { index: 324302, version: 13 } },
  generated: {
    status: "OBSERVED",
    tempEntity: { index: 322631, version: 25 },
    originalEntity: { index: 324302, version: 13 },
    nodeEntity: { index: 322631, version: 25 },
    edgeEntity: { index: 322717, version: 35 },
    tempFlags: "Essential",
  },
  postApply: {
    status: "OBSERVED",
    tempOrGeneratedEntity: { index: 322631, version: 25 },
    originalEntity: { index: 324302, version: 13 },
    finalPermanentNode: { index: 324302, version: 13 },
    finalMatchesRequested: true,
  },
};

const batch = (results: unknown[]) => ({ ok: true, requested: results.length, executed: results.length, results });

const topologyFixture = (overrides: Record<string, unknown> = {}) => ({
  topology: {
    binding: { bindingStatus: "VALID", complete: true, truncated: false },
    connector: {
      entity: { index: 328081, version: 1 },
      physicalEdges: [{ entity: { index: 321509, version: 7 }, startNode: { index: 328081, version: 1 }, endNode: { index: 321492, version: 7 }, start: { x: 0, z: 0 }, end: { x: 1, z: 0 } }],
      connectedFlowEdges: [{ entity: { index: 321520, version: 1 }, start: { index: 1, version: 1 }, end: { index: 2, version: 1 }, disconnected: false }],
    },
    targetNetwork: {
      targetEndpoints: [{ role: "start", node: { index: 324244, version: 1 }, position: { x: 2, z: 0 } }],
      reachablePath: [{ entity: { index: 321530, version: 1 }, start: { index: 1, version: 1 }, end: { index: 2, version: 1 }, disconnected: false }],
      complete: true,
      truncated: false,
    },
    candidateScan: {
      complete: true,
      truncated: false,
      edges: [{ entity: { index: 321509, version: 7 }, startNode: { index: 328081, version: 1 }, endNode: { index: 321492, version: 7 } }],
    },
    admittedAction: { prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 2, z: 0 } },
    ...overrides,
  },
});

describe("utility native completion telemetry persistence wiring", () => {
  test("preserves Bridge HTTP diagnostics through MCP parsing and final aggregation", () => {
    const diagnostics = { source: "bridge-http-error", httpStatus: 409, rawResponseBody: "{...}", truncated: false };
    const provenance = { stage: "HTTP_NON_2XX", errorName: "BridgeError", isBridgeError: true };
    const parsed = parseV2McpJson({ content: [{ type: "text", text: JSON.stringify({ ok: false, results: [{ bridgeHttpErrorDiagnostics: diagnostics, mcpBridgeFailureDiagnostics: provenance }] }) }] }) as any;
    expect(parsed.results[0].bridgeHttpErrorDiagnostics).toEqual(diagnostics);
    expect(parsed.results[0].mcpBridgeFailureDiagnostics).toEqual(provenance);
    const aggregated = aggregateV2RoadBatchResult(0, {
      command: { commandId: "execution-1", status: "REJECTED", failureOrUnknownReason: "rejected", evidence: { bridgeHttpErrorDiagnostics: diagnostics, mcpBridgeFailureDiagnostics: provenance, bridgeCommandId: "bridge-409" } },
      admission: { proposalId: "proposal-1", quoteId: "quote-1", reason: "rejected" },
    } as any);
    expect((aggregated as any).bridgeHttpErrorDiagnostics).toEqual(diagnostics);
    expect((aggregated as any).bridgeCommandId).toBe("bridge-409");
    expect((aggregated as any).mcpBridgeFailureDiagnostics).toEqual(provenance);
  });
  test("preserves a Bridge-like completion through aggregation, adapter, and durable record", () => {
    const bridgeLikeCompletion = {
      status: "COMPLETED",
      operation: "ROAD_APPLY",
      commandId: "bridge-end-123",
      proposalId: "proposal-1",
      quoteId: "quote-1",
      endRealizationTelemetry: telemetry,
    };
    const execution = {
      command: {
        commandId: "execution-1",
        bridgeCommandId: "bridge-end-123",
        status: "REJECTED",
        failureOrUnknownReason: "observed mismatch",
        authorizedScope: { actionFamily: "ROAD", fingerprint: "fp" },
      },
      admission: { proposalId: "proposal-1", quoteId: "quote-1", reason: "rejected" },
      nativeCompletion: { raw: bridgeLikeCompletion },
    } as any;
    const aggregated = aggregateV2RoadBatchResult(0, execution);
    const durable = withUtilityNativeCompletionEvidence(
      { nativeCompletionEvidence: null } as any,
      { ok: false, requested: 1, executed: 1, results: [aggregated] },
      "bridge-end-123",
    );
    expect(durable.nativeCompletionEvidence).toEqual(telemetry);
    expect((aggregated as any).nativeCompletionEvidence).toEqual(bridgeLikeCompletion);
  });

  test("missing completion remains explicit UNKNOWN/unavailable", () => {
    const aggregated = aggregateV2RoadBatchResult(0, {
      command: { commandId: "execution-1", status: "REJECTED", failureOrUnknownReason: "missing" },
      admission: { proposalId: "proposal-1", quoteId: "quote-1", reason: "rejected" },
    } as any);
    expect(withUtilityNativeCompletionEvidence({} as any, { results: [aggregated] }, "bridge-end-123")
      .nativeCompletionEvidence).toEqual({ status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" });
  });

  test("multi-command batches correlate and do not cross-contaminate", () => {
    const first = { ...telemetry, commandId: "bridge-first" };
    const second = { ...telemetry, commandId: "bridge-second" };
    const results = [
      { index: 0, type: "build_road", nativeCompletionEvidence: { endRealizationTelemetry: first } },
      { index: 1, type: "build_road", nativeCompletionEvidence: { endRealizationTelemetry: second } },
    ];
    expect(nativeCompletionTelemetryForUtilityBatch({ results }, "bridge-second")).toEqual(second);
    expect(nativeCompletionTelemetryForUtilityBatch({ results }, "bridge-missing"))
      .toEqual({ status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" });
  });

  test("aggregation preserves exactly-once counters and unrelated command semantics", () => {
    const action = { type: "build_road", prefab: "Low-voltage Ground Cable" };
    const execution = {
      command: { commandId: "execution-1", status: "REJECTED", failureOrUnknownReason: "mismatch" },
      admission: { proposalId: "proposal-1", quoteId: "quote-1", reason: "rejected" },
      nativeCompletion: { raw: { commandId: "bridge-end-123", endRealizationTelemetry: telemetry } },
    } as any;
    const aggregated = aggregateV2RoadBatchResult(0, execution);
    expect({ ok: false, requested: 1, executed: 1, results: [aggregated] }).toMatchObject({ requested: 1, executed: 1 });
    expect(action).toEqual({ type: "build_road", prefab: "Low-voltage Ground Cable" });
  });

  test("preserves the complete raw END telemetry payload", () => {
    const result = nativeCompletionTelemetryForUtilityBatch(
      batch([{ index: 0, type: "build_road", nativeCompletion: { endRealizationTelemetry: telemetry } }]),
      "bridge-end-123",
    );
    expect(result).toEqual(telemetry);
    expect(result).not.toBe(telemetry);
  });

  test("preserves CourseSplit diagnostics when NEW_FREE_ENDPOINT has no END realization telemetry", () => {
    const diagnostics = { generateEdgesCaptureRuntime: { captureAttempted: true, earlyReturnReason: "CAPTURED" } };
    const result = nativeCompletionTelemetryForUtilityBatch(
      batch([{ index: 0, type: "build_road", nativeCompletion: { commandId: "bridge-free-1", courseSplitDiagnostics: diagnostics } }]),
      "bridge-free-1",
    ) as Record<string, any>;
    expect(result.status).toBe("UNKNOWN");
    expect(result.unavailable).toBe("END_REALIZATION_TELEMETRY_NOT_APPLICABLE");
    expect(result.courseSplitDiagnostics).toEqual(diagnostics);
  });

  test("correlates telemetry to the expected Bridge command ID", () => {
    expect(nativeCompletionTelemetryForUtilityBatch(
      batch([{ index: 0, type: "build_road", nativeCompletion: { endRealizationTelemetry: telemetry } }]),
      "bridge-other",
    )).toEqual({ status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" });
  });

  test("missing telemetry fails safe as unavailable", () => {
    expect(nativeCompletionTelemetryForUtilityBatch(batch([{ index: 0, type: "build_road" }]), "bridge-end-123"))
      .toEqual({ status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" });
  });

  test("unrelated action results cannot contaminate the selected command", () => {
    expect(nativeCompletionTelemetryForUtilityBatch(batch([
      { index: 0, type: "zone", nativeCompletion: { endRealizationTelemetry: telemetry } },
      { index: 1, type: "build_road", nativeCompletion: { endRealizationTelemetry: { ...telemetry, commandId: "unrelated" } } },
    ]), "bridge-end-123")).toEqual({ status: "UNKNOWN", unavailable: "NATIVE_COMPLETION_TELEMETRY_UNAVAILABLE" });
  });

  test("bounded extraction is side-effect free and does not duplicate writes", () => {
    const input = batch([{ index: 0, type: "build_road", nativeCompletion: { endRealizationTelemetry: telemetry } }]);
    const first = nativeCompletionTelemetryForUtilityBatch(input, "bridge-end-123");
    const second = nativeCompletionTelemetryForUtilityBatch(input, "bridge-end-123");
    expect(first).toEqual(second);
    expect(input).toEqual(batch([{ index: 0, type: "build_road", nativeCompletion: { endRealizationTelemetry: telemetry } }]));
  });
});

describe("bounded utility topology evidence persistence", () => {
  const action = { type: "build_road", prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 2, z2: 0 };
  const capture = (topology: unknown = topologyFixture()) => buildUtilityTopologyEvidence({
    topology, commandId: "outer-command", bridgeCommandId: "bridge-local", action, capturedAt: "2026-09-16T00:00:00.000Z",
  });

  test("captures a two-segment continuous physical cable chain", () => {
    const result = capture(topologyFixture({ candidateScan: { complete: true, truncated: false, edges: [
      { entity: { index: 321509, version: 7 }, startNode: { index: 328081, version: 1 }, endNode: { index: 321492, version: 7 } },
      { entity: { index: 321510, version: 7 }, startNode: { index: 321492, version: 7 }, endNode: { index: 324244, version: 1 } },
    ] } }));
    expect((result.topology as any).candidateScan.edges).toHaveLength(2);
    expect((result.topology as any).candidateScan.edges[1].endNode).toEqual({ index: 324244, version: 1 });
  });

  test("preserves a broken physical intermediate node", () => {
    const result = capture(topologyFixture({ candidateScan: { complete: true, truncated: false, edges: [
      { entity: { index: 321509, version: 7 }, startNode: { index: 328081, version: 1 }, endNode: { index: 321492, version: 7 } },
      { entity: { index: 321510, version: 7 }, startNode: { index: 321493, version: 7 }, endNode: { index: 324244, version: 1 } },
    ] } }));
    expect((result.topology as any).candidateScan.edges[1].startNode).toEqual({ index: 321493, version: 7 });
  });

  test("preserves target node missing cable edge evidence", () => {
    const result = capture(topologyFixture({ targetNetwork: { targetEndpoints: [{ node: { index: 324244, version: 1 } }], reachablePath: [], complete: true, truncated: false } }));
    expect((result.topology as any).targetNetwork.reachablePath).toEqual([]);
    expect((result.topology as any).targetNetwork.targetEndpoints[0].node).toEqual({ index: 324244, version: 1 });
  });

  test("preserves disconnected ElectricityFlowEdge state", () => {
    const result = capture(topologyFixture({ connector: { connectedFlowEdges: [{ entity: { index: 321520, version: 1 }, start: { index: 1, version: 1 }, end: { index: 2, version: 1 }, disconnected: true }] } }));
    expect((result.topology as any).connector.connectedFlowEdges[0].disconnected).toBe(true);
  });

  test("preserves continuous physical and flow evidence without deriving a match", () => {
    const result = capture();
    expect((result.topology as any).binding.complete).toBe(true);
    expect((result.topology as any).targetNetwork.reachablePath[0].disconnected).toBe(false);
  });

  test("persists bounded records only", () => {
    const result = capture({ ...topologyFixture(), unrelatedWorldDump: { entities: 999999 } });
    expect(result.topology).not.toHaveProperty("unrelatedWorldDump");
    expect(result.topology).toHaveProperty("candidateScan");
  });

  test("keeps outer command and Bridge-local correlation distinct", () => {
    const result = capture();
    expect(result.commandId).toBe("outer-command");
    expect(result.bridgeCommandId).toBe("bridge-local");
  });

  test("does not alter existing END telemetry persistence", () => {
    const current = { nativeCompletionEvidence: null } as any;
    const updated = withUtilityNativeCompletionEvidence(current, batch([{ type: "build_road", nativeCompletion: { endRealizationTelemetry: telemetry } }]), "bridge-end-123");
    expect(updated.nativeCompletionEvidence).toEqual(telemetry);
  });

  test("evidence construction is side-effect free and carries no native execution", () => {
    const input = topologyFixture();
    const result = capture(input);
    expect(result).not.toHaveProperty("executed");
    expect(input).toHaveProperty("topology");
  });
});
