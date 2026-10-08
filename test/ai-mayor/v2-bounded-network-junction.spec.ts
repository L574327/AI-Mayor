import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import {
  createPumpSegment2JunctionContract,
  validateBoundedNetworkJunctionInsert,
  validateBoundedJunctionAdmission,
  junctionIdentityFingerprint,
  junctionReplacementFingerprint,
  validateSegment2SuccessorLineage,
  reconcileBoundedJunctionPostApply,
} from "../../src/main/services/ai-mayor/v2/bounded-network-junction";

const classes = [
  "PUMP_ACCESS_ROAD",
  "SEGMENT_2_TERMINAL_CABLE_EDGE",
  "PUMP_INTERNAL_CAR_PATH",
  "PUMP_INTERNAL_ROAD_PATH",
] as const;
const observations = classes.map((semanticClass, index) => ({
  entity: { index: 100 + index, version: 1 }, semanticClass,
}));
const course = { x1: -215.4844512939453, z1: 1319.075439453125, x2: -214.08384704589844, z2: 1310.9451904296875 };

describe("bounded native network junction insert", () => {
  test("durable semantic carries stable roles and geometry without generation-local IDs", () => {
    const contract = createPumpSegment2JunctionContract();
    const exact = stableRoadInput({
      prefab: "Medium Road", x1: -215.4844512939453, z1: 1319.075439453125,
      x2: -214.08384704589844, z2: 1310.9451904296875, networkJunctionInsert: contract,
    });
    expect(exact).toContain('"kind":"BOUNDED_NETWORK_JUNCTION_INSERT"');
    expect(exact).toContain('"lineage":"SEGMENT_2_TERMINAL"');
    expect(exact).not.toMatch(/"(?:index|version)"\s*:/);
  });

  test("allows only the certified local successor replacement classes", () => {
    const result = validateBoundedNetworkJunctionInsert({
      contract: createPumpSegment2JunctionContract(), prefab: "Medium Road", lengthMeters: 9.174525,
      course,
      observations,
    });
    expect(result.valid).toBe(true);
    expect(result.observedClasses).toHaveLength(4);
  });

  test.each(["SEGMENT_1", "WATER_PIPE", "PUMP_BUILDING", "UNEXPECTED"] as const)(
    "fails closed when replacement set contains %s",
    (semanticClass) => {
      const result = validateBoundedNetworkJunctionInsert({
        contract: createPumpSegment2JunctionContract(), prefab: "Medium Road", lengthMeters: 9.174525,
        course,
        observations: [...observations, { entity: { index: 999, version: 1 }, semanticClass }],
      });
      expect(result.valid).toBe(false);
    },
  );

  test("rejects full Segment 2 rebuild by requiring exactly the local terminal edge successor class", () => {
    const result = validateBoundedNetworkJunctionInsert({
        contract: createPumpSegment2JunctionContract(), prefab: "Medium Road", lengthMeters: 792,
        course,
      observations,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("JUNCTION_COURSE_OUT_OF_BOUNDS");
  });

  test("admits only the exact typed replacement operation without a greenfield proposal edge", () => {
    const contract = createPumpSegment2JunctionContract();
    const evidence = {
      operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT" as const,
      identityFingerprint: junctionIdentityFingerprint(contract),
      replacementFingerprint: junctionReplacementFingerprint(observations),
      nativeAllowApply: true,
      replacementObservations: observations,
      duplicateRisk: "NO" as const,
      segment1Touched: false, waterPipeTouched: false, pumpBuildingTouched: false,
      fullSegment2Rebuild: false, segment2TerminalLocalReplacementOnly: true,
      expectedSuccessorLineage: true, localConnectCompatibleMediumRoad: true,
      segment2SourceContinuity: true, pumpRoadFlowComponentContinuous: true,
      quote: 0, quoteSource: "NATIVE_TOOL_TEMP_COST" as const, nativeTempCount: 98,
    };
    expect(validateBoundedJunctionAdmission({ contract, evidence })).toMatchObject({ valid: true });
    expect(validateBoundedJunctionAdmission({ contract, evidence: { ...evidence, replacementObservations: [...observations, { entity: { index: 999, version: 1 }, semanticClass: "UNEXPECTED" as const }] } }).valid).toBe(false);
  });

  test.each([
    ["allowApply", { nativeAllowApply: false }],
    ["duplicate", { duplicateRisk: "UNKNOWN" }],
    ["segment 1", { segment1Touched: true }],
    ["water pipe", { waterPipeTouched: true }],
    ["Pump building", { pumpBuildingTouched: true }],
    ["full rebuild", { fullSegment2Rebuild: true }],
    ["local terminal replacement", { segment2TerminalLocalReplacementOnly: false }],
    ["successor lineage", { expectedSuccessorLineage: false }],
    ["source continuity", { segment2SourceContinuity: false }],
    ["Pump flow continuity", { pumpRoadFlowComponentContinuous: false }],
    ["LocalConnect compatibility", { localConnectCompatibleMediumRoad: false }],
    ["native cost source", { quoteSource: "UNKNOWN" }],
  ])("fails admission when %s evidence fails", (_name, change) => {
    const contract = createPumpSegment2JunctionContract();
    const base = {
      operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT" as const,
      identityFingerprint: junctionIdentityFingerprint(contract),
      replacementFingerprint: junctionReplacementFingerprint(observations), nativeAllowApply: true,
      replacementObservations: observations, duplicateRisk: "NO" as const,
      segment1Touched: false, waterPipeTouched: false, pumpBuildingTouched: false,
      fullSegment2Rebuild: false, segment2TerminalLocalReplacementOnly: true,
      expectedSuccessorLineage: true, localConnectCompatibleMediumRoad: true,
      segment2SourceContinuity: true, pumpRoadFlowComponentContinuous: true,
      quote: 0, quoteSource: "NATIVE_TOOL_TEMP_COST" as const, nativeTempCount: 98,
    };
    expect(validateBoundedJunctionAdmission({ contract, evidence: { ...base, ...change } as typeof base }).valid).toBe(false);
  });

  test("requires old terminal replacement, single successor and both reachability legs", () => {
    expect(validateSegment2SuccessorLineage({
      oldEdgePresent: false, successorEdgeCount: 1, sourceToSuccessorReachable: true, successorToPumpRoadReachable: true,
    })).toBe(true);
    expect(validateSegment2SuccessorLineage({
      oldEdgePresent: false, successorEdgeCount: 1, sourceToSuccessorReachable: false, successorToPumpRoadReachable: true,
    })).toBe(false);
    expect(validateSegment2SuccessorLineage({
      oldEdgePresent: true, successorEdgeCount: 1, sourceToSuccessorReachable: true, successorToPumpRoadReachable: true,
    })).toBe(false);
  });

  test("post-apply proof follows cable and road successors after the old terminal is gone", () => {
    const evidence = {
      oldSegment2TerminalPresent: false,
      successorCableEdges: [{ index: 10, version: 1 }],
      successorRoadEdges: [{ index: 11, version: 1 }],
      newJunctionNode: { index: 12, version: 1 },
      localConnectCompatibleNode: true,
      sourceToSegment2SuccessorReachable: true,
      segment2SuccessorToPumpRoadReachable: true,
      pumpRoadFlowComponentContinuous: true,
    };
    expect(reconcileBoundedJunctionPostApply(evidence)).toMatchObject({ valid: true, segment2SuccessorLineage: true, segment2SourceContinuity: true });
    expect(reconcileBoundedJunctionPostApply({ ...evidence, sourceToSegment2SuccessorReachable: false }).valid).toBe(false);
    expect(reconcileBoundedJunctionPostApply({ ...evidence, pumpRoadFlowComponentContinuous: false }).valid).toBe(false);
  });
});
