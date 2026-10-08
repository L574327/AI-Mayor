import { createMemoryCommandJournal } from "../../src/main/services/ai-mayor/v2/foundation";
import { quoteNativeTempCost, stableRoadInput, type FinanceObservation, type ProposalIdentity } from "../../src/main/services/ai-mayor/v2/finance";
import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { canonicalRoadOperation, createV2RoadKernel, roadCourseGeometry, type RoadExecutionRequest, type RoadGeometryInput, type RoadKernelNativeBuildRequest } from "../../src/main/services/ai-mayor/v2/road-kernel";
import { plannedRoadSegmentToMayorAction } from "../../src/main/services/ai-mayor/utility-recovery";
import { createMainMayorPorts } from "../../src/main/services/ai-mayor/main-adapters";
import { V2DurabilityCoordinator, createMemoryDurableStateStorage } from "../../src/main/services/ai-mayor/v2/durability";
import { createV2RuntimeRoadCaller, nativeRoadQuoteFromPreview, previewProductiveStarterRoad, RoadQuoteContractError, starterRoadGeometryCandidates } from "../../src/main/services/ai-mayor/v2/runtime-road-caller";
import { createPumpSegment2JunctionContract, junctionIdentityFingerprint, junctionReplacementFingerprint, type BoundedJunctionAdmissionEvidence } from "../../src/main/services/ai-mayor/v2/bounded-network-junction";

const instant = new Date("2026-09-13T00:00:00.000Z");
const geometry: RoadGeometryInput = { prefab: "Small Road", x1: -696, z1: -560, x2: -656, z2: -560 };
const fingerprint = stableRoadInput(geometry);

const financeObservation = (overrides: Partial<FinanceObservation> = {}): FinanceObservation => ({
  schemaVersion: "ai-mayor-v2-finance/1",
  treasuryAmount: 2_205_263,
  unlimitedMoney: false,
  runtimeEpoch: "bridge:10",
  frame: 10,
  observedAt: instant.toISOString(),
  freshness: "FRESH",
  provenance: "OBSERVED_NATIVE",
  ...overrides,
});

const request = (overrides: Partial<RoadExecutionRequest> = {}): RoadExecutionRequest => {
  const identity: ProposalIdentity = {
    proposalId: "road:Small Road:-696,-560:-656,-560",
    actionFamily: "ROAD",
    exactInput: fingerprint,
    runtimeEpoch: "bridge:10",
    frame: 10,
    validationState: "VALID",
  };
  const quote = quoteNativeTempCost(
    identity,
    "quote-road-1",
    [{ tempId: "temp-1", ownerProposalId: identity.proposalId, signedCost: 160, cancelled: false }],
    instant,
  );
  return {
    proposal: {
      identity,
      quoteId: quote.quoteId,
      fingerprint,
      input: geometry,
      owner: { ownerType: "TASK", ownerId: "task-road-1" },
    },
    quote,
    authorizedMaxSpend: 160,
    treasurySafetyReserve: 50,
    ...overrides,
  };
};

const success = (input = request()) => ({
  placed: true,
  commandId: "bridge-0123456789abcdef0123456789abcdef",
  proposalId: input.proposal.identity.proposalId,
  quoteId: input.proposal.quoteId,
  finance: {
    proposalId: input.proposal.identity.proposalId,
    quoteId: input.proposal.quoteId,
    signedAmount: 160,
    eligibleTempEntityCount: 29,
    sourceKind: "NATIVE_TOOL_TEMP_COST",
    provenance: "OBSERVED_NATIVE",
    frame: 11,
    state: "VALID",
    apply: true,
    attribution: "BOUNDED_ATTRIBUTION",
  },
});

const nativeCompleted = (input = request()) => ({
  ...success(input),
  accepted: true,
  nativeCompletion: {
    schemaVersion: "cs2mcp-road-native-completion/1",
    status: "COMPLETED",
    operation: "ROAD_APPLY",
    commandId: "bridge-0123456789abcdef0123456789abcdef",
    proposalId: input.proposal.identity.proposalId,
    quoteId: input.proposal.quoteId,
    worldGeneration: "generation-a",
    applyRequestedFrame: 11,
    completedFrame: 12,
    generatedEdgeCount: 1,
    generatedNodeCount: 2,
    remainingTempEntityCount: 0,
    resultingPermanentEntities: [],
  },
  worldEffect: { status: "REQUIRES_AUTHORITATIVE_OBSERVATION", certified: false },
});

function harness(input: {
  observation?: FinanceObservation;
  submit?: jest.Mock;
  ids?: string[];
} = {}) {
  const submit = input.submit ?? jest.fn(async () => success());
  const ids = input.ids ?? ["road-command-1", "road-command-2"];
  let index = 0;
  const kernel = createV2RoadKernel({
    journal: createMemoryCommandJournal(),
    observeFinance: async () => input.observation ?? financeObservation(),
    submit,
    now: () => instant,
    createId: () => ids[index++] ?? `road-command-${index}`,
  });
  return { kernel, submit };
}

describe("V2 ROAD Admission -> Kernel -> Bridge", () => {
  const productivePreview = (input: RoadGeometryInput, signedAmount: number) => ({
    valid: true,
    validNewRoadProposal: true,
    previewOnly: true,
    roadExecutionContract: "cs2mcp-road-execution-truth/1",
    proposalId: `road:${input.prefab}:${input.x1},${input.z1}:${input.x2},${input.z2}`,
    quoteId: `road:${input.prefab}:${input.x1},${input.z1}:${input.x2},${input.z2}`,
    finance: {
      state: "VALID",
      proposalId: `road:${input.prefab}:${input.x1},${input.z1}:${input.x2},${input.z2}`,
      quoteId: `road:${input.prefab}:${input.x1},${input.z1}:${input.x2},${input.z2}`,
      signedAmount,
      eligibleTempEntityCount: 3,
      provenance: "OBSERVED_NATIVE",
      sourceKind: "NATIVE_TOOL_TEMP_COST",
      runtimeEpoch: "bridge:10",
      frame: 10,
    },
    diagnostics: {
      realization: {
        generatedTempEntities: [
          { kind: "EDGE", original: { index: 1, version: 1 } },
          { kind: "EDGE", original: null },
          { kind: "NODE", original: null },
        ],
      },
    },
  });

  test("rejects an accepted but nonproductive 8m Preview and selects bounded productive geometry", async () => {
    const previews: RoadGeometryInput[] = [];
    const base = { prefab: "Medium Road", x1: 0, z1: 0, x2: 8, z2: 0 };
    const result = await previewProductiveStarterRoad({
      input: base,
      now: () => instant,
      preview: async (input) => {
        previews.push(input);
        const length = Math.hypot(input.x2 - input.x1, input.z2 - input.z1);
        return length <= 8.01
          ? { ...productivePreview(input, 5), diagnostics: { realization: { generatedTempEntities: [{ kind: "EDGE", original: { index: 1, version: 1 } }, { kind: "NODE", original: { index: 2, version: 1 } }] } } }
          : productivePreview(input, length === 16 ? 88 : 132);
      },
    });
    expect(previews.map((input) => Math.hypot(input.x2 - input.x1, input.z2 - input.z1))).toEqual([8, 16]);
    expect(result.selectedLengthMeters).toBe(16);
    expect(result.quote.signedAmount).toBe(88);
    expect(starterRoadGeometryCandidates(base).map((input) => Math.hypot(input.x2 - input.x1, input.z2 - input.z1))).toEqual([8, 16, 25]);
  });

  test("preserves a planned utility service-road segment through the existing ROAD preview contract", async () => {
    const segment = {
      id: "utility-service-road",
      role: "side" as const,
      start: { x: 38.5, z: 140.25 },
      end: { x: -91.75, z: 77.5 },
    };
    const waterPlanInput = roadCourseGeometry(plannedRoadSegmentToMayorAction(segment));
    const previewInputs: RoadGeometryInput[] = [];
    const length = Math.hypot(waterPlanInput.x2 - waterPlanInput.x1, waterPlanInput.z2 - waterPlanInput.z1);
    const previewed = await previewProductiveStarterRoad({
      input: waterPlanInput,
      lengthsMeters: [length],
      now: () => instant,
      preview: async (input) => {
        previewInputs.push(input);
        return productivePreview(input, 321);
      },
    });
    expect(previewInputs).toEqual([waterPlanInput]);
    expect(previewed.input).toEqual(waterPlanInput);
    expect(stableRoadInput(waterPlanInput)).toBe(stableRoadInput(previewed.input));
    expect(previewed.quote.exactInput).toBe(stableRoadInput(waterPlanInput));
  });

  test.each([16, 25])("keeps scaled %sm endpoint metadata exact", (length) => {
    const baseWithEndpoints: RoadGeometryInput = {
      prefab: "Small Road", x1: 10, z1: -20, x2: 18, z2: -20,
      endEndpoint: { kind: "NEW_FREE_ENDPOINT", role: "END", expectedPosition: { x: 18, y: 3, z: -20 }, worldEpoch: "epoch-1" },
    };
    const variant = starterRoadGeometryCandidates(baseWithEndpoints).find((input) => Math.hypot(input.x2 - input.x1, input.z2 - input.z1) === length);
    expect(variant).toBeDefined();
    expect(variant!.endEndpoint!.expectedPosition).toEqual({ x: variant!.x2, y: 3, z: variant!.z2 });
    expect(variant!.x2).toBe(variant!.endEndpoint!.expectedPosition.x);
    expect(variant!.z2).toBe(variant!.endEndpoint!.expectedPosition.z);
  });

  test("does not classify a structurally nonproductive Preview as executable", async () => {
    await expect(previewProductiveStarterRoad({
      input: { prefab: "Medium Road", x1: 0, z1: 0, x2: 8, z2: 0 },
      now: () => instant,
      lengthsMeters: [],
      preview: async (input) => ({ ...productivePreview(input, 5), diagnostics: { realization: { generatedTempEntities: [{ kind: "EDGE", original: { index: 1, version: 1 } }, { kind: "NODE", original: { index: 2, version: 1 } }] } } }),
    })).rejects.toMatchObject({ code: "NO_PRODUCTIVE_ROAD_EFFECT" });
  });

  /**
   * The window and the set are different things, and the live growth corridor
   * stalled on the difference. `generatedTempEntities` is capped at 32 entries
   * by the Bridge while `generatedEdgeCount`/`generatedNodeCount` are the true
   * totals, so at a busy junction the genuinely new endpoint node falls outside
   * the window and a course native certified and priced was reported to the
   * Brain as NO_PRODUCTIVE_ROAD_EFFECT — eight ticks in a row, journal flat.
   */
  test("reads a truncated realization window as evidence of nothing, and a complete one as evidence of absence", async () => {
    const course: RoadGeometryInput = { prefab: "Medium Road", x1: 0, z1: 0, x2: 30, z2: 0 };
    const certified = { courseIntegrity: { operationKind: "NEW_ROAD_PROPOSAL_EDGE", proposalEdgeCount: 1 } };

    // 18 edges + 33 nodes behind a 32-entry window: what the window did not hold
    // is not evidence, and native's own new-proposal answer is the authority.
    const truncated = await previewProductiveStarterRoad({
      input: course, now: () => instant, lengthsMeters: [],
      preview: async (input) => ({ ...productivePreview(input, 220), ...certified, diagnostics: { realization: {
        generatedEdgeCount: 18, generatedNodeCount: 33,
        generatedTempEntities: [
          { kind: "NODE", original: { index: 334456, version: 1 } },
          { kind: "EDGE", original: null },
        ],
      } } }),
    });
    expect(truncated.selectedLengthMeters).toBeCloseTo(30, 6);
    expect(truncated.quote.signedAmount).toBe(220);

    // The same window reporting the whole set is a finding: only replacements.
    await expect(previewProductiveStarterRoad({
      input: course, now: () => instant, lengthsMeters: [],
      preview: async (input) => ({ ...productivePreview(input, 220), ...certified, diagnostics: { realization: {
        generatedEdgeCount: 1, generatedNodeCount: 1,
        generatedTempEntities: [
          { kind: "EDGE", original: { index: 1, version: 1 } },
          { kind: "NODE", original: { index: 2, version: 1 } },
        ],
      } } }),
    })).rejects.toMatchObject({ code: "NO_PRODUCTIVE_ROAD_EFFECT" });

    // A truncated window without native's own new-proposal answer is still refused.
    await expect(previewProductiveStarterRoad({
      input: course, now: () => instant, lengthsMeters: [],
      preview: async (input) => ({ ...productivePreview(input, 220), courseIntegrity: { operationKind: "NEW_ROAD_PROPOSAL_EDGE", proposalEdgeCount: 0 }, diagnostics: { realization: {
        generatedEdgeCount: 18, generatedNodeCount: 33,
        generatedTempEntities: [{ kind: "EDGE", original: { index: 1, version: 1 } }],
      } } }),
    })).rejects.toMatchObject({ code: "NO_PRODUCTIVE_ROAD_EFFECT" });
  });

  test("a complete window holding a new edge is new topology even when it holds no new node", async () => {
    // Measured live 2026-10-01 at node 75948:215: the one certifiable course
    // returned HTTP 200 with validNewRoadProposal true and proposalEdgeCount 1,
    // and a COMPLETE ten-entry window with one new edge and five regenerated
    // nodes. A road joining nodes that already exist adds an edge and no node,
    // so demanding both read a certified, priced road as nonproductive.
    const course: RoadGeometryInput = { prefab: "Medium Road", x1: 1347.93689, z1: 420.6495, x2: 1330.9663, z2: 403.6789 };
    const accepted = await previewProductiveStarterRoad({
      input: course, now: () => instant, lengthsMeters: [],
      preview: async (input) => ({ ...productivePreview(input, 132), courseIntegrity: { operationKind: "NEW_ROAD_PROPOSAL_EDGE", proposalEdgeCount: 1 }, diagnostics: { realization: {
        generatedEdgeCount: 5, generatedNodeCount: 5,
        generatedTempEntities: [
          { kind: "NODE", original: { index: 75948, version: 215 } },
          { kind: "NODE", original: { index: 76615, version: 57 } },
          { kind: "NODE", original: { index: 77160, version: 241 } },
          { kind: "NODE", original: { index: 75476, version: 37 } },
          { kind: "NODE", original: { index: 76842, version: 299 } },
          { kind: "EDGE", original: { index: 76848, version: 305 } },
          { kind: "EDGE", original: { index: 76617, version: 57 } },
          { kind: "EDGE", original: { index: 77162, version: 239 } },
          { kind: "EDGE", original: { index: 75950, version: 215 } },
          { kind: "EDGE", original: null },
        ],
      } } }),
    });
    expect(accepted.quote.signedAmount).toBe(132);
  });

  test("rejects a native ROAD preview from a Bridge without the execution-truth contract", () => {
    const preview = {
      valid: true,
      previewOnly: true,
      proposalId: request().proposal.identity.proposalId,
      quoteId: "quote-road-1",
      finance: {
        state: "VALID",
        proposalId: request().proposal.identity.proposalId,
        quoteId: "quote-road-1",
        signedAmount: 160,
        eligibleTempEntityCount: 29,
        provenance: "OBSERVED_NATIVE",
        sourceKind: "NATIVE_TOOL_TEMP_COST",
        runtimeEpoch: "bridge:10",
        frame: 10,
      },
    };
    expect(() => nativeRoadQuoteFromPreview(preview, geometry, instant)).toThrow(
      "native ROAD preview did not return a correlated authoritative quote",
    );
  });

  test("junction previews accept a native replacement operation without a greenfield proposal edge", () => {
    const contract = createPumpSegment2JunctionContract();
    const input: RoadGeometryInput = { prefab: "Medium Road", ...contract.road.course, networkJunctionInsert: contract };
    const replacements = ["PUMP_ACCESS_ROAD", "SEGMENT_2_TERMINAL_CABLE_EDGE", "PUMP_INTERNAL_CAR_PATH", "PUMP_INTERNAL_ROAD_PATH"] as const;
    const replacementObservations = replacements.map((semanticClass, index) => ({ entity: { index: index + 10, version: 1 }, semanticClass }));
    const replacementFingerprint = junctionReplacementFingerprint(replacementObservations);
    const identityFingerprint = junctionIdentityFingerprint(contract);
    const proposalId = `junction:${identityFingerprint}`;
    const preview = {
      valid: true, validNewRoadProposal: false, roadOperationKind: "BOUNDED_NETWORK_JUNCTION_INSERT",
      previewOnly: true, roadExecutionContract: "cs2mcp-road-execution-truth/1", proposalId, quoteId: proposalId,
      toolAllowApply: true,
      junctionOperation: { identityFingerprint, replacementFingerprint, nativeAllowApply: true,
        nativeCostSource: "NATIVE_TOOL_TEMP_COST", nativeTempCount: 98 },
      finance: { state: "VALID", proposalId, quoteId: proposalId, signedAmount: 0, eligibleTempEntityCount: 98,
        provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST", runtimeEpoch: "bridge:10", frame: 10 },
    };
    expect(nativeRoadQuoteFromPreview(preview, input, instant)).toMatchObject({ signedAmount: 0, eligibleTempEntityCount: 98, state: "VALID" });
    expect(() => nativeRoadQuoteFromPreview({ ...preview, roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE" }, input, instant)).toThrow(
      "native ROAD preview did not return a correlated authoritative quote",
    );
  });

  test("ordinary ROAD previews still require the original new proposal edge contract", () => {
    const raw = productivePreview(geometry, 160);
    const { diagnostics: _diagnostics, ...withoutGeneratedEvidence } = raw;
    expect(() => nativeRoadQuoteFromPreview({ ...withoutGeneratedEvidence, validNewRoadProposal: false }, geometry, instant)).toThrow(
      "native ROAD preview did not return a correlated authoritative quote",
    );
    expect(nativeRoadQuoteFromPreview({ ...raw, validNewRoadProposal: true }, geometry, instant).signedAmount).toBe(160);
  });

  test("quote diagnostics preserve the accepted response and expose the first rejection without evaluating later predicates", () => {
    const raw = productivePreview(geometry, 160);
    expect(nativeRoadQuoteFromPreview(raw, geometry, instant)).toMatchObject({ state: "VALID", signedAmount: 160 });

    const missingContract = { ...raw } as Record<string, unknown>;
    delete missingContract.roadExecutionContract;
    try {
      nativeRoadQuoteFromPreview(missingContract, geometry, instant, {
        roadTaskId: "road-task-current", roadChildId: "child-current", atomicOperationId: "child-current",
      });
      throw new Error("expected quote rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RoadQuoteContractError);
      const quoteError = error as RoadQuoteContractError;
      expect(quoteError.message).toBe("native ROAD preview did not return a correlated authoritative quote");
      expect(quoteError.diagnostics).toMatchObject({
        firstFailedQuoteRequirement: "ROAD_EXECUTION_CONTRACT_MATCH",
        allEvaluatedFailedRequirements: ["ROAD_EXECUTION_CONTRACT_MATCH"],
        roadTaskId: "road-task-current", roadChildId: "child-current", atomicOperationId: "child-current",
        failedComparison: { expected: "cs2mcp-road-execution-truth/1", actual: "<unavailable>" },
        actual: { proposalId: expect.any(String), quoteId: expect.any(String), financeSignedAmount: 160 },
      });
      expect(quoteError.diagnostics.predicateStatus.VALID_TRUE).toBe("PASS");
      expect(quoteError.diagnostics.predicateStatus.ROAD_EXECUTION_CONTRACT_MATCH).toBe("FAIL");
      expect(quoteError.diagnostics.predicateStatus.VALID_NEW_ROAD_PROPOSAL_TRUE).toBe("NOT_EVALUATED");
      expect(quoteError.diagnostics.predicateStatus.FINANCE_STATE_VALID).toBe("NOT_EVALUATED");
    }
  });

  test("missing finance container reports its first failure and leaves dependent predicates unevaluated", () => {
    const raw = productivePreview(geometry, 160) as Record<string, unknown>;
    delete raw.finance;
    expect(() => nativeRoadQuoteFromPreview(raw, geometry, instant)).toThrow(RoadQuoteContractError);
    try {
      nativeRoadQuoteFromPreview(raw, geometry, instant);
    } catch (error) {
      const quoteError = error as RoadQuoteContractError;
      expect(quoteError.diagnostics.firstFailedQuoteRequirement).toBe("FINANCE_STATE_VALID");
      expect(quoteError.diagnostics.predicateStatus.FINANCE_STATE_VALID).toBe("FAIL");
      expect(quoteError.diagnostics.predicateStatus.FINANCE_PROPOSAL_ID_MATCH).toBe("NOT_EVALUATED");
      expect(quoteError.diagnostics.predicateStatus.SIGNED_AMOUNT_FINITE_NUMBER).toBe("NOT_EVALUATED");
      expect(quoteError.diagnostics.failedComparison.actual).toBe("<unavailable>");
    }
  });

  test("diagnostic Junction preview uses shared ROAD serialization and never executes or authorizes", async () => {
    const contract = createPumpSegment2JunctionContract();
    const input: RoadGeometryInput = { prefab: contract.road.prefab, ...contract.road.course, networkJunctionInsert: contract };
    const classes = ["PUMP_ACCESS_ROAD", "SEGMENT_2_TERMINAL_CABLE_EDGE", "PUMP_INTERNAL_CAR_PATH", "PUMP_INTERNAL_ROAD_PATH"] as const;
    const replacementObservations = classes.map((semanticClass, index) => ({ entity: { index: index + 70, version: 1 }, semanticClass }));
    const replacementFingerprint = junctionReplacementFingerprint(replacementObservations);
    const identityFingerprint = junctionIdentityFingerprint(contract);
    const proposalId = `junction:${identityFingerprint}`;
    const evidence: BoundedJunctionAdmissionEvidence = {
      operationKind: contract.kind, identityFingerprint, replacementFingerprint, nativeAllowApply: true,
      replacementObservations,
      nativeRoadContact: { roadEdge: replacementObservations[0].entity, roadNode: { index: 501, version: 1 },
        position: { x: contract.road.contact.x, y: 12, z: contract.road.contact.z }, endpointRole: "START" },
      duplicateRisk: "NO", segment1Touched: false, waterPipeTouched: false, pumpBuildingTouched: false,
      fullSegment2Rebuild: false, segment2TerminalLocalReplacementOnly: true, expectedSuccessorLineage: true,
      segment2SourceContinuity: true, pumpRoadFlowComponentContinuous: true, localConnectCompatibleMediumRoad: true,
      quote: 0, quoteSource: "NATIVE_TOOL_TEMP_COST", nativeTempCount: 98,
    };
    const preflight = {
      valid: true, previewOnly: true, toolAllowApply: true, validNewRoadProposal: false,
      roadExecutionContract: "cs2mcp-road-execution-truth/1", roadOperationKind: contract.kind,
      proposalId, quoteId: proposalId,
      junctionOperation: { identityFingerprint, replacementFingerprint, nativeAllowApply: true,
        nativeCostSource: "NATIVE_TOOL_TEMP_COST", nativeTempCount: 98 },
      finance: { state: "VALID", proposalId, quoteId: proposalId, signedAmount: 0, eligibleTempEntityCount: 98,
        provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST", runtimeEpoch: "bridge:10", frame: 10 },
    };
    const road = { execute: jest.fn(), reconcile: jest.fn() };
    const authorize = jest.fn(() => ({ authorizedMaxSpend: 0, treasurySafetyReserve: 0 }));
    const previewBuild = jest.fn(async (_request: RoadKernelNativeBuildRequest) => preflight);
    const preflightGeometry = jest.fn(async () => { throw new Error("JUNCTION_PREVIEW_MUST_USE_NATIVE_BUILD_PATH"); });
    const resolveJunctionContact = jest.fn(async () => ({ generation: "generation-a", contact: evidence.nativeRoadContact! }));
    const caller = createV2RuntimeRoadCaller({
      road: road as never,
      preview: preflightGeometry,
      previewBuild,
      resolveJunctionContact,
      certifyJunctionPreview: async () => ({ generation: "generation-a", evidence }),
      authorize,
      now: () => instant,
    });
    const result = await caller.previewJunctionNative({ input, owner: { ownerType: "TASK", ownerId: "diagnostic-only" } });
    expect(result.quote.proposalId).toBe(proposalId);
    expect(previewBuild).toHaveBeenCalledWith(expect.objectContaining({
      prefab: "Medium Road", previewOnly: true, roadOperationKind: contract.kind,
      startEndpoint: expect.objectContaining({
        kind: "NEW_FREE_ENDPOINT", role: "START", worldEpoch: "generation-a",
        geometricContact: expect.objectContaining({ roadEdge: replacementObservations[0].entity, endpointRole: "START" }),
      }),
    }), undefined);
    const sent = previewBuild.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(sent.networkJunctionInsert).toBeUndefined();
    expect(resolveJunctionContact).toHaveBeenCalledTimes(1);
    expect(preflightGeometry).not.toHaveBeenCalled();
    expect(road.execute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  test("a durable junction command becomes terminal and cannot be replayed", async () => {
    const contract = createPumpSegment2JunctionContract();
    const input: RoadGeometryInput = { prefab: contract.road.prefab, ...contract.road.course, networkJunctionInsert: contract };
    const exactInput = stableRoadInput(input);
    const proposalId = `junction:${junctionIdentityFingerprint(contract)}`;
    const identity: ProposalIdentity = { proposalId, actionFamily: "ROAD", exactInput, runtimeEpoch: "bridge:10", frame: 10, validationState: "VALID" };
    const quote = quoteNativeTempCost(identity, proposalId, [{ tempId: "native-temp-set", ownerProposalId: proposalId, signedCost: 0, cancelled: false }], instant);
    const classes = ["PUMP_ACCESS_ROAD", "SEGMENT_2_TERMINAL_CABLE_EDGE", "PUMP_INTERNAL_CAR_PATH", "PUMP_INTERNAL_ROAD_PATH"] as const;
    const replacementObservations = classes.map((semanticClass, index) => ({ entity: { index: index + 70, version: 1 }, semanticClass }));
    const evidence: BoundedJunctionAdmissionEvidence = {
      operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT", identityFingerprint: junctionIdentityFingerprint(contract),
      replacementFingerprint: junctionReplacementFingerprint(replacementObservations), nativeAllowApply: true,
      replacementObservations, duplicateRisk: "NO", segment1Touched: false, waterPipeTouched: false,
      nativeRoadContact: { roadEdge: replacementObservations[0].entity, roadNode: { index: 501, version: 1 },
        position: { x: contract.road.contact.x, y: 12, z: contract.road.contact.z }, endpointRole: "START" },
      pumpBuildingTouched: false, fullSegment2Rebuild: false, segment2TerminalLocalReplacementOnly: true,
      expectedSuccessorLineage: true, segment2SourceContinuity: true, pumpRoadFlowComponentContinuous: true,
      localConnectCompatibleMediumRoad: true, quote: 0, quoteSource: "NATIVE_TOOL_TEMP_COST", nativeTempCount: 98,
    };
    const request: RoadExecutionRequest = {
      proposal: { identity, quoteId: proposalId, fingerprint: exactInput, input, owner: { ownerType: "TASK", ownerId: "water-phase7-junction" } },
      quote, authorizedMaxSpend: 0, treasurySafetyReserve: 50_000,
      worldGeneration: "generation-a",
      networkJunctionPreview: { generation: "generation-a", evidence },
    };
    const journal = createMemoryCommandJournal();
    let nativeCount = 0;
    const submit = jest.fn(async (native: RoadKernelNativeBuildRequest) => {
      nativeCount += 1;
      return {
      accepted: true, commandId: `bridge-${String(nativeCount).padStart(32, "0")}`, proposalId: native.proposalId, quoteId: native.quoteId,
      finance: { proposalId: native.proposalId, quoteId: native.quoteId, signedAmount: 0, eligibleTempEntityCount: 98, sourceKind: "NATIVE_TOOL_TEMP_COST",
        provenance: "OBSERVED_NATIVE", frame: 11, state: "VALID", apply: true, attribution: "BOUNDED_ATTRIBUTION" },
      nativeCompletion: { operation: "ROAD_APPLY", status: "COMPLETED", commandId: `bridge-${String(nativeCount).padStart(32, "0")}`,
        proposalId: native.proposalId, quoteId: native.quoteId, worldGeneration: nativeCount === 1 ? "generation-a" : "generation-b", applyRequestedFrame: 11, completedFrame: 12,
        generatedEdgeCount: 4, generatedNodeCount: 8, remainingTempEntityCount: 0, resultingPermanentEntities: [] },
      };
    });
    let commandIndex = 0;
    const kernel = createV2RoadKernel({
      journal, observeFinance: async () => financeObservation(), submit, now: () => instant,
      createId: () => `junction-command-${++commandIndex}`,
      persistCreatedCommand: (record) => { journal.create(record); return journal.get(record.commandId)!; },
    });
    const staleContact = await kernel.execute({
      ...request,
      networkJunctionPreview: { generation: "generation-a", evidence: {
        ...evidence, nativeRoadContact: { ...evidence.nativeRoadContact!, roadEdge: { index: 999, version: 1 } },
      } },
    });
    expect(staleContact).toMatchObject({ bridgeCalled: false, authorizationConsumed: false,
      admission: { decision: "REJECTED", reason: "BOUNDED_JUNCTION_NATIVE_CONTACT_WITNESS_INVALID" } });
    expect(journal.list()).toHaveLength(0);
    const first = await kernel.execute(request);
    expect(first.admission.decision).toBe("AUTHORIZED");
    expect(first.bridgeCalled).toBe(true);
    expect(first.command.status).toBe("NATIVE_COMPLETED");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      startEndpoint: {
        kind: "NEW_FREE_ENDPOINT", role: "START", expectedPosition: { x: contract.road.contact.x, y: 12, z: contract.road.contact.z },
        worldEpoch: "generation-a",
        geometricContact: { roadEdge: replacementObservations[0].entity, roadNode: { index: 501, version: 1 },
          position: { x: contract.road.contact.x, y: 12, z: contract.road.contact.z }, endpointRole: "START" },
      },
      junctionIdentityFingerprint: junctionIdentityFingerprint(contract),
      roadOperationKind: "BOUNDED_NETWORK_JUNCTION_INSERT",
    }), undefined);
    expect((submit.mock.calls[0]?.[0] as unknown as Record<string, unknown>).networkJunctionInsert).toBeUndefined();
    const replay = await kernel.execute(request);
    expect(replay.command.commandId).toBe(first.command.commandId);
    expect(replay.command.status).toBe("NATIVE_COMPLETED");
    expect(replay.admission).toMatchObject({ decision: "REJECTED", reason: "bounded_junction_operation_already_recorded" });
    expect(replay.bridgeCalled).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(journal.list()).toHaveLength(1);

    const generationBIdentity: ProposalIdentity = { ...identity };
    const generationBQuote = quoteNativeTempCost(generationBIdentity, proposalId, [
      { tempId: "native-temp-set-b", ownerProposalId: generationBIdentity.proposalId, signedCost: 0, cancelled: false },
    ], instant);
    const generationB: RoadExecutionRequest = {
      ...request,
      proposal: { ...request.proposal, identity: generationBIdentity, quoteId: generationBQuote.quoteId, fingerprint: exactInput },
      quote: generationBQuote,
      worldGeneration: "generation-b",
      networkJunctionPreview: { generation: "generation-b", evidence: {
        ...evidence,
        nativeRoadContact: { ...evidence.nativeRoadContact!, worldEpoch: "generation-b" },
      } },
    };
    const kernelB = createV2RoadKernel({
      journal, observeFinance: async () => financeObservation(), submit, now: () => instant,
      createId: () => "junction-command-generation-b",
      persistCreatedCommand: (record) => { journal.create(record); return journal.get(record.commandId)!; },
    });
    const newWorld = await kernelB.execute(generationB);
    expect(newWorld.bridgeCalled).toBe(true);
    expect(newWorld.admission.decision).toBe("AUTHORIZED");
    expect(journal.list()).toHaveLength(2);
    expect(journal.get(first.command.commandId)?.authorizedScope).toMatchObject({ worldGeneration: "generation-a" });
  });

  test("valid native quote and sufficient authorization invoke Bridge exactly once and reconcile one receipt", async () => {
    const { kernel, submit } = harness();
    const result = await kernel.execute(request());
    expect(result.admission.decision).toBe("AUTHORIZED");
    expect(result.authorizationConsumed).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ ...geometry, proposalId: request().proposal.identity.proposalId, quoteId: "quote-road-1" }, undefined);
    expect(result.command).toMatchObject({ status: "COMMIT_ACK", bridgeCommandId: "bridge-0123456789abcdef0123456789abcdef", reconciliationStatus: "NOT_STARTED" });
    expect(result.receipt).toMatchObject({ commandId: "bridge-0123456789abcdef0123456789abcdef", proposalId: request().proposal.identity.proposalId, quoteId: "quote-road-1", signedAppliedAmount: 160, applySetCount: 29, attribution: "BOUNDED_ATTRIBUTION", completionState: "UNKNOWN" });
  });

  test("facility repair commits its exact durable command after Admission and before ROAD submission", async () => {
    const journal = createMemoryCommandJournal();
    const events: string[] = [];
    const input = request({
      facilityAccessRoadRepair: {
        amendmentId: "amendment-1", repairLineage: "repair-lineage-1", planRevision: "plan-7",
        actionFingerprint: JSON.stringify([{ type: "build_road", prefab: "Small Road", x1: -696, z1: -560, x2: -656, z2: -560 }]),
        actionCount: 1, purpose: "Pump native road attachment repair", prefab: "Small Road",
        expectedJournalPosition: 9, expectedWorldId: "world-1", expectedCheckpointId: "save-1", expectedGeneration: "generation-1",
      },
    });
    const kernel = createV2RoadKernel({
      journal,
      observeFinance: async () => financeObservation(),
      submit: async () => { events.push("submit"); return nativeCompleted(input); },
      now: () => instant,
      createId: () => "repair-command-1",
      persistCreatedCommand: (record) => {
        events.push("atomic-commit");
        journal.create(record);
        return record;
      },
    });
    const result = await kernel.execute(input);
    expect(events).toEqual(["atomic-commit", "submit"]);
    expect(journal.get(result.command.commandId)).toMatchObject({ actionFamily: "ROAD", status: "NATIVE_COMPLETED" });
    expect(result.bridgeCalled).toBe(true);
    expect(result.effectReport).toBeUndefined();
    expect(result.command.status).not.toBe("OBSERVED_MATCH");
  });

  test("facility repair rejected by Admission does not consume authorization or create a durable command", async () => {
    const journal = createMemoryCommandJournal();
    const persistCreatedCommand = jest.fn((record) => record);
    const submit = jest.fn(async () => success());
    const input = request({
      authorizedMaxSpend: 159,
      facilityAccessRoadRepair: {
        amendmentId: "amendment-1", repairLineage: "repair-lineage-1", planRevision: "plan-7",
        actionFingerprint: JSON.stringify([{ type: "build_road", prefab: "Small Road", x1: -696, z1: -560, x2: -656, z2: -560 }]),
        actionCount: 1, purpose: "Pump native road attachment repair", prefab: "Small Road",
        expectedJournalPosition: 9, expectedWorldId: "world-1", expectedCheckpointId: "save-1", expectedGeneration: "generation-1",
      },
    });
    const kernel = createV2RoadKernel({ journal, observeFinance: async () => financeObservation(), submit, now: () => instant,
      createId: () => "repair-command-rejected", persistCreatedCommand });
    const result = await kernel.execute(input);
    expect(result.admission.decision).toBe("REJECTED");
    expect(persistCreatedCommand).not.toHaveBeenCalled();
    expect(journal.list()).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  test("insufficient AUTHORIZED_MAX_SPEND rejects before Bridge", async () => {
    const { kernel, submit } = harness();
    const result = await kernel.execute(request({ authorizedMaxSpend: 159 }));
    expect(result.admission).toMatchObject({ decision: "REJECTED", reason: "required_spend_exceeds_authorized_maximum" });
    expect(result.command.status).toBe("FAILED_BEFORE_SUBMIT");
    expect(submit).not.toHaveBeenCalled();
  });

  test("separates receipt ACK, native completion, and authoritative effect certification", async () => {
    const journal = createMemoryCommandJournal();
    const kernel = createV2RoadKernel({
      journal,
      observeFinance: async () => financeObservation(),
      submit: async () => nativeCompleted(),
      now: () => instant,
      createId: () => "road-native-completed",
    });
    const result = await kernel.execute(request());
    expect(result.command).toMatchObject({ status: "NATIVE_COMPLETED", reconciliationStatus: "NOT_STARTED" });
    expect(result.nativeCompletion).toMatchObject({ status: "COMPLETED", operation: "ROAD_APPLY" });
    expect(result.receipt).toMatchObject({ completionState: "COMPLETED" });
    expect(result.command.statusHistory.map((entry) => entry.status)).toEqual([
      "CREATED",
      "AUTHORIZED",
      "SUBMITTED",
      "COMMIT_ACK",
      "NATIVE_COMPLETED",
    ]);
    expect(result.command.status).not.toBe("OBSERVED_MATCH");
  });

  test("stale quote rejects before Bridge", async () => {
    const { kernel, submit } = harness({ observation: financeObservation({ frame: 11, runtimeEpoch: "bridge:11" }) });
    expect((await kernel.execute(request())).admission.decision).toBe("REJECTED");
    expect(submit).not.toHaveBeenCalled();
  });

  test("proposalId mismatch rejects before Bridge", async () => {
    const changed = request();
    changed.proposal.identity = { ...changed.proposal.identity, proposalId: "other-proposal" };
    const { kernel, submit } = harness();
    expect((await kernel.execute(changed)).admission.reason).toBe("proposal_id_mismatch");
    expect(submit).not.toHaveBeenCalled();
  });

  test("quoteId mismatch rejects before Bridge", async () => {
    const changed = request();
    changed.proposal = { ...changed.proposal, quoteId: "other-quote" };
    const { kernel, submit } = harness();
    expect((await kernel.execute(changed)).admission.reason).toBe("quote_id_mismatch");
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([
    ["proposal", (value: RoadExecutionRequest) => { value.proposal = { ...value.proposal, fingerprint: "wrong" }; }],
    ["quote", (value: RoadExecutionRequest) => { value.quote = { ...value.quote!, exactInput: "wrong" }; }],
  ])("%s fingerprint mismatch rejects before Bridge", async (_label, mutate) => {
    const changed = request();
    mutate(changed);
    const { kernel, submit } = harness();
    expect((await kernel.execute(changed)).admission.reason).toMatch(/fingerprint_mismatch/);
    expect(submit).not.toHaveBeenCalled();
  });

  test.each([
    ["unknown", undefined],
    ["stale", financeObservation({ freshness: "STALE" })],
  ])("%s treasury rejects before Bridge", async (_label, observation) => {
    const submit = jest.fn();
    const kernel = createV2RoadKernel({
      journal: createMemoryCommandJournal(),
      observeFinance: async () => observation,
      submit,
      now: () => instant,
      createId: () => `road-${_label}`,
    });
    expect((await kernel.execute(request())).admission.decision).toBe("REJECTED");
    expect(submit).not.toHaveBeenCalled();
  });

  test("authorization is consumed once and replay cannot invoke a second Bridge Apply", async () => {
    const { kernel, submit } = harness();
    expect((await kernel.execute(request())).authorizationConsumed).toBe(true);
    const replay = await kernel.execute(request());
    expect(replay).toMatchObject({ authorizationConsumed: false, bridgeCalled: false, admission: { decision: "REJECTED", reason: "authorization_already_consumed" } });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("native failure never becomes successful outcome", async () => {
    const submit = jest.fn(async () => ({ placed: false, error: "native validation rejected" }));
    const { kernel } = harness({ submit });
    const result = await kernel.execute(request());
    expect(result.command).toMatchObject({ status: "REJECTED", failureOrUnknownReason: "native validation rejected" });
    expect(result.receipt).toBeUndefined();
  });

  test("quote/receipt mismatch never becomes successful outcome", async () => {
    const response = success();
    response.finance.signedAmount = 159;
    const { kernel } = harness({ submit: jest.fn(async () => response) });
    const result = await kernel.execute(request());
    expect(result.command).toMatchObject({ status: "REJECTED", failureOrUnknownReason: "native receipt did not match the authorized quote" });
    expect(result.receipt).toBeUndefined();
  });

  test("production adapter reaches cs2_build_road only through authorized ROAD kernel", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const manager = {
      legacyList: async () => ({ tools: ["cs2_city_overview", "cs2_build_road"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, args });
        const payload = name === "cs2_city_overview"
          ? { treasury: 2_205_263, unlimitedMoney: false, treasuryFrame: 10, treasuryProvenance: "OBSERVED_NATIVE" }
          : success();
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({ getToolsManager: () => manager, now: () => instant, createId: () => "road-production-command" });
    const result = await ports.road.execute(request());
    expect(result.command.status).toBe("COMMIT_ACK");
    expect(calls.map((call) => call.name)).toEqual(["cs2_city_overview", "cs2_build_road"]);
    expect(calls[1].args).toEqual({ ...geometry, proposalId: request().proposal.identity.proposalId, quoteId: "quote-road-1" });
  });

  test("canonical curved ROAD input is frozen once and the same course reaches native Apply", async () => {
    const input: RoadGeometryInput = { prefab: "Small Road", x1: 0, z1: 0, cx: 12, cz: 4, x2: 20, z2: 20 };
    const operation = canonicalRoadOperation(input);
    expect(Object.isFrozen(operation.input)).toBe(true);
    expect(operation.exactInput).toBe(stableRoadInput(operation.input));
    const identity: ProposalIdentity = { ...request().proposal.identity, proposalId: "road:curved", exactInput: operation.exactInput };
    const quote = quoteNativeTempCost(identity, "quote-curved", [{ tempId: "temp-curved", ownerProposalId: identity.proposalId,
      signedCost: 160, cancelled: false }], instant);
    const bound = request({ proposal: { identity, quoteId: quote.quoteId, fingerprint: operation.exactInput,
      input: operation.input, owner: { ownerType: "TASK", ownerId: "curved-road" } }, quote });
    const submit = jest.fn(async () => success(bound));
    const { kernel } = harness({ submit });
    const result = await kernel.execute(bound);
    expect(result.admission.decision).toBe("AUTHORIZED");
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      x1: 0, z1: 0, cx: 12, cz: 4, x2: 20, z2: 20,
      proposalId: bound.proposal.identity.proposalId,
    });
  });

  test.each([
    ["straight", { prefab: "Small Road", x1: 2, z1: 3, x2: 29, z2: 31 } as RoadGeometryInput],
    ["curved", { prefab: "Small Road", x1: 2, z1: 3, cx: 11, cz: 17, x2: 29, z2: 31 } as RoadGeometryInput],
  ])("%s Road preview and Apply consume the same frozen canonical course", async (_kind, input) => {
    const previewInputs: RoadGeometryInput[] = [];
    const submit = jest.fn(async (native: RoadKernelNativeBuildRequest) => ({
      ...success(), commandId: "bridge-curve-preview-apply-00000000000001",
      proposalId: native.proposalId, quoteId: native.quoteId,
      finance: { ...success().finance, proposalId: native.proposalId, quoteId: native.quoteId },
    }));
    const { kernel } = harness({ submit });
    const caller = createV2RuntimeRoadCaller({
      road: kernel,
      preview: async (candidate) => {
        previewInputs.push(candidate);
        expect(Object.isFrozen(candidate)).toBe(true);
        return productivePreview(candidate, 160);
      },
      readWorldGeneration: async () => "generation-a",
      now: () => instant,
    });
    const result = await caller.execute({ input, owner: { ownerType: "TASK", ownerId: "curved-canonical" } });
    expect(result.admission.decision).toBe("AUTHORIZED");
    expect(previewInputs).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ ...input,
      proposalId: productivePreview(previewInputs[0]!, 160).proposalId });
  });

  test("a real post-freeze Road input change still fails the exact operation guard", async () => {
    const canonical = canonicalRoadOperation(geometry);
    const changed = request({ proposal: { ...request().proposal, input: { ...canonical.input, x2: -655 },
      identity: { ...request().proposal.identity, exactInput: canonical.exactInput }, fingerprint: canonical.exactInput } });
    const { kernel, submit } = harness();
    const result = await kernel.execute(changed);
    expect(result.admission).toMatchObject({ decision: "REJECTED", reason: "OPERATION_DEFINITION_COURSE_MISMATCH" });
    expect(submit).not.toHaveBeenCalled();
  });

  test("production adapter Admission rejection makes zero cs2_build_road calls", async () => {
    const calls: string[] = [];
    const manager = {
      legacyList: async () => ({ tools: ["cs2_city_overview", "cs2_build_road"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name }: { name: string }) => {
        calls.push(name);
        return { structuredContent: { treasury: 2_205_263, unlimitedMoney: false, treasuryFrame: 10, treasuryProvenance: "OBSERVED_NATIVE" } };
      },
    };
    const ports = createV2FoundationPorts({ getToolsManager: () => manager, now: () => instant, createId: () => "road-rejected-command" });
    expect((await ports.road.execute(request({ authorizedMaxSpend: 159 }))).admission.decision).toBe("REJECTED");
    expect(calls).toEqual(["cs2_city_overview"]);
  });

  test("restart reconciliation proves an old ACK absent without dispatching a duplicate Apply", async () => {
    const storage = createMemoryDurableStateStorage();
    const seed = new V2DurabilityCoordinator(storage, () => instant);
    const worldState = {
      gameMode: "Game",
      isLoading: false,
      cityLoaded: true,
      simulation: { frameIndex: 12, paused: true },
      world: {
        identityStatus: "AVAILABLE",
        worldReady: true,
        worldId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nativeSessionGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loadPurpose: "LoadGame",
        loadAssetGuid: "meta-a",
        saveDataAssetGuid: "data-a",
        checkpointId: "save:meta-a:data-a",
        bridgeRuntimeEpoch: "bridge-a",
        generation: "generation-a",
        generationSequence: 1,
        generationOrigin: "LOAD_COMPLETED",
        nativeOperationBusy: false,
      },
    };
    seed.activate(worldState);
    const pending = request().proposal.input;
    const exactInput = stableRoadInput(pending);
    seed.commandJournal.create({
      schemaVersion: "ai-mayor-v2-command/1",
      commandId: "legacy-road-ack",
      actionFamily: "ROAD",
      actionType: "build_road",
      authorizedScope: {
        owner: { ownerType: "TASK", ownerId: "task-road-1" },
        actionFamily: "ROAD",
        proposalId: "legacy-proposal",
        quoteId: "legacy-quote",
        fingerprint: exactInput,
        exactInput,
        budget: { authorizedMaxSpend: 160, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        observationPrecondition: { runtimeEpoch: "bridge:10", frame: 10 },
        expiresAt: instant.toISOString(),
      },
      bridgeCommandId: "bridge-0123456789abcdef0123456789abcdef",
      createdAt: instant.toISOString(),
      submittedAt: instant.toISOString(),
      nativeResultSummary: "legacy receipt ACK",
      status: "COMMIT_ACK",
      statusHistory: [],
      reconciliationStatus: "MATCH",
      observationEvidence: [],
      failureOrUnknownReason: null,
      effectAbsenceProven: false,
    });
    const poisoned = seed.snapshot();
    poisoned.commands[0].outcome = "APPLIED";
    storage.save(poisoned);
    const calls: string[] = [];
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_mayor_snapshot", "cs2_spatial", "cs2_build_road"].map((name) => ({ name: `cs2--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(name);
        const payload = name === "cs2_game_state"
          ? worldState
          : name === "cs2_mayor_snapshot"
            ? {}
            : args.mode === "scan"
              ? { worldEpoch: "generation-a", roadGraph: { nodes: [], edges: [], truncated: false } }
              : {
                  center: { x: args.x, z: args.z }, radius: args.radius,
                  terrain: { resolution: 16, bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }, cellSize: { x: 1, z: 1 }, heights: [], waterDepths: [], groundWater: [], groundWaterPollution: [], windSpeed: [] },
                  roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [],
                };
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: storage,
      now: () => instant,
      createId: () => "reconcile-observation",
    });
    await ports.activateDurableWorld!();
    expect(ports.commandJournal.get("legacy-road-ack")).toMatchObject({
      status: "OBSERVED_MISMATCH",
      reconciliationStatus: "MISMATCH",
      effectAbsenceProven: true,
    });
    expect(calls).not.toContain("cs2_build_road");
  });

  function runtimeManager(options: { signedAmount?: number; commandId?: string | null } = {}) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const proposalId = "road:Small Road:-696,-560:-656,-560";
    const signedAmount = options.signedAmount ?? 160;
    const commandId = options.commandId === undefined
      ? "bridge-0123456789abcdef0123456789abcdef"
      : options.commandId;
    // A ROAD effect can only be certified against a durable world lineage, so a
    // run that expects the caller to reach a terminal ROAD result has to load a
    // world this store can name: the native world and the session guid of its
    // save. The runtime generation is present because the bridge always reports
    // one, but nothing in the lineage is judged by it.
    const worldState = {
      gameMode: "Game",
      isLoading: false,
      cityLoaded: true,
      simulation: { frameIndex: 12, paused: true },
      world: {
        identityStatus: "AVAILABLE",
        worldReady: true,
        worldId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nativeSessionGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loadPurpose: "LoadGame",
        loadAssetGuid: "meta-a",
        saveDataAssetGuid: "data-a",
        checkpointId: "save:meta-a:data-a",
        bridgeRuntimeEpoch: "bridge-a",
        generation: "generation-a",
        generationSequence: 1,
        generationOrigin: "LOAD_COMPLETED",
        nativeOperationBusy: false,
      },
    };
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_spatial", "cs2_game_state", "cs2_mayor_snapshot", "cs2_city_overview", "cs2_build_road", "cs2_mayor_execute_actions"].map((name) => ({ name: `cs2--${name}` })),
      }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, args });
        let payload: unknown;
        if (name === "cs2_spatial" && args.mode === "preflight") {
          payload = {
            valid: true,
            validNewRoadProposal: true,
            previewOnly: true,
            roadExecutionContract: "cs2mcp-road-execution-truth/1",
            proposalId,
            quoteId: "quote-runtime-road-1",
            finance: {
              state: "VALID",
              proposalId,
              quoteId: "quote-runtime-road-1",
              signedAmount,
              eligibleTempEntityCount: 29,
              provenance: "OBSERVED_NATIVE",
              sourceKind: "NATIVE_TOOL_TEMP_COST",
              runtimeEpoch: "bridge:10",
              frame: 10,
            },
          };
        } else if (name === "cs2_spatial" && args.mode === "scan") {
          payload = {
            worldEpoch: "generation-a",
            roadGraph: {
              truncated: false,
              nodes: [],
              edges: [{
                entity: { index: 88, version: 1 },
                prefab: geometry.prefab,
                native: false,
                startNode: { index: 80, version: 1 },
                endNode: { index: 81, version: 1 },
                start: { x: geometry.x1, z: geometry.z1 },
                end: { x: geometry.x2, z: geometry.z2 },
                length: 40,
              }],
            },
          };
        } else if (name === "cs2_spatial" && args.mode === "detail") {
          payload = {
            center: { x: args.x, z: args.z },
            radius: args.radius,
            terrain: { resolution: 16, bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }, cellSize: { x: 1, z: 1 }, heights: [], waterDepths: [], groundWater: [], groundWaterPollution: [], windSpeed: [] },
            roadGraph: { nodes: [], edges: [] },
            buildings: [],
            zoningCells: [],
          };
        } else if (name === "cs2_game_state") {
          payload = worldState;
        } else if (name === "cs2_mayor_snapshot") {
          payload = {};
        } else if (name === "cs2_city_overview") {
          payload = { treasury: 2_205_263, unlimitedMoney: false, treasuryFrame: 10, treasuryProvenance: "OBSERVED_NATIVE" };
        } else if (name === "cs2_build_road") {
          payload = {
            accepted: true,
            ...(commandId === null ? {} : { commandId }),
            proposalId: args.proposalId,
            quoteId: args.quoteId,
            finance: {
              proposalId: args.proposalId,
              quoteId: args.quoteId,
              signedAmount,
              eligibleTempEntityCount: 29,
              sourceKind: "NATIVE_TOOL_TEMP_COST",
              provenance: "OBSERVED_NATIVE",
              frame: 11,
              state: "VALID",
              apply: true,
              attribution: "BOUNDED_ATTRIBUTION",
            },
            ...(commandId === null ? {} : {
              nativeCompletion: {
                schemaVersion: "cs2mcp-road-native-completion/1",
                status: "COMPLETED",
                operation: "ROAD_APPLY",
                commandId,
                proposalId: args.proposalId,
                quoteId: args.quoteId,
                worldGeneration: "generation-a",
                applyRequestedFrame: 11,
                completedFrame: 12,
                generatedEdgeCount: 1,
                generatedNodeCount: 2,
                remainingTempEntityCount: 0,
                resultingPermanentEntities: [],
              },
            }),
          };
        } else {
          payload = { ok: false, requested: 1, executed: 0, results: [] };
        }
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    return { manager, calls, proposalId };
  }

  test("actual MayorRuntime ROAD caller reaches V2FoundationPorts.road.execute and preserves identity", async () => {
    const { manager, calls, proposalId } = runtimeManager();
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    const batch = await ports.executeActions([{ type: "build_road", ...geometry }]);
    expect(batch).toMatchObject({
      ok: true,
      executed: 1,
      results: [{
        type: "build_road",
        ok: true,
        v2Road: {
          bridgeCommandId: "bridge-0123456789abcdef0123456789abcdef",
          proposalId,
          quoteId: "quote-runtime-road-1",
          fingerprint,
          financeReceipt: {
            commandId: "bridge-0123456789abcdef0123456789abcdef",
            proposalId,
            quoteId: "quote-runtime-road-1",
            signedAppliedAmount: 160,
          },
        },
      }],
    });
    expect(calls.filter((call) => call.name === "cs2_build_road")).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ ...geometry, proposalId, quoteId: "quote-runtime-road-1" }),
      }),
    ]);
    expect(calls.filter((call) => call.name === "cs2_spatial").map((call) => call.args.mode)).toEqual([
      "preflight",
      "scan",
      "detail",
    ]);
    expect(calls.some((call) => call.name === "cs2_mayor_execute_actions")).toBe(false);
  });

  test("actual MayorRuntime ROAD caller rejects insufficient authorization before Bridge", async () => {
    const { manager, calls } = runtimeManager();
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
      roadAuthorizationPolicy: () => ({ authorizedMaxSpend: 159, treasurySafetyReserve: 0 }),
    });
    const batch = await ports.executeActions([{ type: "build_road", ...geometry }]);
    expect(batch).toMatchObject({ ok: false, executed: 0, results: [{ type: "build_road", ok: false }] });
    expect(calls.filter((call) => call.name === "cs2_build_road")).toHaveLength(0);
    expect(calls.some((call) => call.name === "cs2_mayor_execute_actions")).toBe(false);
  });

  test("V2 MCP normalization preserves text from an MCP error response", async () => {
    const { manager } = runtimeManager();
    manager.legacyCall = async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === "cs2_spatial") {
        return {
          isError: true,
          content: [{ type: "text", text: "another build operation is in progress, retry shortly" }],
        };
      }
      if (name === "cs2_game_state") return { structuredContent: { world: { generation: "generation-a" } } };
      return { structuredContent: { args } };
    };
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
    });
    const batch = await ports.executeActions([{ type: "build_road", ...geometry }]);
    expect(batch).toMatchObject({
      ok: false,
      executed: 0,
      results: [{ error: "road_executor_blocker:another build operation is in progress, retry shortly" }],
    });
  });

  test("actual MayorRuntime ROAD caller preserves explicit zero bound and rejects a zero quote before Bridge", async () => {
    const { manager, calls } = runtimeManager({ signedAmount: 0 });
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
      roadAuthorizationPolicy: () => ({ authorizedMaxSpend: 0, treasurySafetyReserve: 0 }),
    });
    const batch = await ports.executeActions([{ type: "build_road", ...geometry }]);
    expect(batch).toMatchObject({
      ok: false,
      executed: 0,
      results: [{ error: "road_executor_blocker:native ROAD preview did not return a correlated authoritative quote" }],
    });
    expect(calls.filter((call) => call.name === "cs2_build_road")).toHaveLength(0);
    expect(calls.some((call) => call.name === "cs2_mayor_execute_actions")).toBe(false);
  });

  test("MCP text-result normalization preserves the exact Bridge commandId through the runtime caller", async () => {
    const commandId = "bridge-abcdefabcdefabcdefabcdefabcdefab";
    const { manager } = runtimeManager({ commandId });
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    const batch = await ports.executeActions([{ type: "build_road", ...geometry }]);
    expect(batch.results[0].v2Road).toMatchObject({
      bridgeCommandId: commandId,
      financeReceipt: { commandId },
    });
  });

  test("successful Bridge result without commandId fails closed after MCP text-result normalization", async () => {
    const { manager } = runtimeManager({ commandId: null });
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
    });
    const batch = await ports.executeActions([{ type: "build_road", ...geometry }]);
    expect(batch).toMatchObject({
      ok: false,
      executed: 0,
      results: [{ error: "successful ROAD response omitted a valid Bridge commandId" }],
    });
  });

  test("actual MayorRuntime ROAD caller replays one terminal result without a second execution", async () => {
    const { manager, calls } = runtimeManager();
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test" }),
      getToolsManager: () => manager,
      durableStateStorage: createMemoryDurableStateStorage(),
    });
    const action = { type: "build_road" as const, ...geometry };
    expect((await ports.executeActions([action])).ok).toBe(true);
    expect((await ports.executeActions([action])).ok).toBe(true);
    expect(calls.filter((call) => call.name === "cs2_build_road")).toHaveLength(1);
  });
});
