import fs from "node:fs";
import path from "node:path";
import {
  MAX_ROAD_FEASIBILITY_CANDIDATES,
  roadCandidatePreviewFailureVerdict,
  rawRoadCandidatePreviewVerdict,
  selectFeasibleRoadCandidate,
} from "../../src/main/services/ai-mayor/v2/road-candidate-feasibility";
import { V2DurabilityCoordinator, createMemoryDurableStateStorage } from "../../src/main/services/ai-mayor/v2/durability";
import { planStarterResidentialIntent, type Gate1RoadPreApplyFailureEvidence } from "../../src/main/services/ai-mayor/v2/gate1";
import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { buildUtilityPreparationInput } from "../../src/main/services/ai-mayor/v2/utility-admission-context";

const validPreview = () => ({
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

const invalidPreview = () => ({
  valid: false,
  previewOnly: true,
  validNewRoadProposal: false,
  toolAllowApply: true,
  courseIntegrity: {
    operationKind: "NEW_ROAD_PROPOSAL_EDGE",
    postHandoffGeometryPreserved: true,
    proposalEdgeCount: 0,
    firstFailure: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED",
  },
  get finance() { throw new Error("candidate feasibility must not inspect finance"); },
});

describe("V2 raw Road candidate feasibility", () => {
  test("rejects A, selects B, and leaves attempts and child creation untouched during preview", async () => {
    const candidates = [{ id: "A" }, { id: "B" }];
    const events: string[] = [];
    const attempts = 1;
    const recordChild = jest.fn((id: string) => events.push(`child:${id}`));
    const selected = await selectFeasibleRoadCandidate({
      candidates,
      candidateId: (candidate) => candidate.id,
      probe: async (candidate) => {
        events.push(`preview:${candidate.id}`);
        const verdict = rawRoadCandidatePreviewVerdict(candidate.id === "A" ? invalidPreview() : validPreview());
        if (verdict.status === "UNKNOWN") throw new Error(verdict.reason);
        return verdict.status === "INVALID" ? verdict : { status: "FEASIBLE" as const };
      },
    });

    expect(selected).toMatchObject({ status: "SELECTED", candidate: { id: "B" }, candidateIndex: 1,
      rejections: [{ candidateId: "A", reason: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" }] });
    expect(events).toEqual(["preview:A", "preview:B"]);
    expect(attempts).toBe(1);
    expect(recordChild).not.toHaveBeenCalled();

    if (selected.status === "SELECTED") recordChild(selected.candidate.id);
    expect(events.at(-1)).toBe("child:B");
    expect(recordChild).toHaveBeenCalledTimes(1);
  });

  test("a utility road family falls back from native-rejected GRID to the existing free corridor", async () => {
    const candidates = [
      { id: "grid", family: "ORTHOGONAL_GRID" },
      { id: "free", family: "FREE_CORRIDOR" },
    ];
    const probed: string[] = [];
    const selected = await selectFeasibleRoadCandidate({
      candidates,
      candidateId: (candidate) => candidate.id,
      probe: async (candidate) => {
        probed.push(candidate.family);
        return candidate.family === "ORTHOGONAL_GRID"
          ? { status: "INVALID", reason: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" }
          : { status: "FEASIBLE" };
      },
    });
    expect(probed).toEqual(["ORTHOGONAL_GRID", "FREE_CORRIDOR"]);
    expect(selected).toMatchObject({ status: "SELECTED", candidate: { family: "FREE_CORRIDOR" }, candidateIndex: 1 });
  });

  test("all invalid candidates return a bounded NO_FEASIBLE result", async () => {
    const candidates = Array.from({ length: MAX_ROAD_FEASIBILITY_CANDIDATES + 3 }, (_, index) => ({ id: `candidate-${index}` }));
    const probed: string[] = [];
    const selected = await selectFeasibleRoadCandidate({
      candidates,
      candidateId: (candidate) => candidate.id,
      probe: async (candidate) => {
        probed.push(candidate.id);
        return { status: "INVALID", reason: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" };
      },
    });

    expect(selected.status).toBe("NO_FEASIBLE_ROAD_CANDIDATE");
    expect(probed).toHaveLength(MAX_ROAD_FEASIBILITY_CANDIDATES);
    expect(selected.rejections).toHaveLength(MAX_ROAD_FEASIBILITY_CANDIDATES);
  });

  test("a caller can add one bounded family without raising other planners' default budget", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => index);
    const probed: number[] = [];
    const selected = await selectFeasibleRoadCandidate({
      candidates, maximumCandidates: 9, candidateId: String,
      probe: async (candidate) => { probed.push(candidate); return { status: "INVALID", reason: "native-invalid" }; },
    });
    expect(selected.status).toBe("NO_FEASIBLE_ROAD_CANDIDATE");
    expect(probed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("classifies only structured no-command native preview rejection as an invalid route", () => {
    expect(roadCandidatePreviewFailureVerdict(Object.assign(new Error("native route rejected"), {
      status: 409,
      validation: { status: "REJECTED" },
      rejectionDiagnostics: { stage: "APPLY_GUARD", allowApply: false, nativeCommandCreated: false },
    }))).toMatchObject({ status: "INVALID", reason: "native route rejected" });
    expect(roadCandidatePreviewFailureVerdict(Object.assign(new Error("bridge unavailable"), { status: 503 })))
      .toMatchObject({ status: "UNKNOWN", reason: "bridge unavailable" });
  });

  test("candidate probes are strictly serial", async () => {
    let active = 0;
    let maximumActive = 0;
    const selected = await selectFeasibleRoadCandidate({
      candidates: [{ id: "A" }, { id: "B" }],
      candidateId: (candidate) => candidate.id,
      probe: async (candidate) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return candidate.id === "A" ? { status: "INVALID", reason: "fixture rejection" } : { status: "FEASIBLE" };
      },
    });
    expect(selected.status).toBe("SELECTED");
    expect(maximumActive).toBe(1);
  });

  test("production service-road selection precedes durable child creation and uses raw preview evidence", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const progression = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/gate1-progression.ts"), "utf8");
    const selection = source.indexOf("const selection = await selectFeasibleRoadCandidate");
    const selectionComplete = source.indexOf("if (selection.status !== \"SELECTED\")", selection);
    const rawVerdict = source.indexOf("rawRoadCandidatePreviewVerdict(preview)", selection);
    const durableChild = source.indexOf("recordUtilityServiceRoadChildOperation({", selection);
    expect(selection).toBeGreaterThan(0);
    expect(selectionComplete).toBeGreaterThan(selection);
    expect(rawVerdict).toBeGreaterThan(selection);
    expect(durableChild).toBeGreaterThan(rawVerdict);
    expect(source.slice(selection, durableChild)).toContain("await waitForNativeIdle(signal)");
    expect(source.slice(selection, durableChild)).toContain("new NoFeasibleRoadCandidateError(rejected, {");
    expect(source.slice(selection, durableChild)).toContain("allContactOptionsExhausted: true");
    expect(source.slice(selection, selectionComplete)).toContain("roadCandidatePreviewFailureVerdict(error)");
    expect(source.slice(selection, selectionComplete)).not.toContain("nativeRoadQuoteFromPreview");
    const prepare = progression.indexOf("await options.prepareUtilityServiceRoadChild");
    const dispatchTick = progression.indexOf("tick = await current.tick", prepare);
    expect(prepare).toBeGreaterThan(0);
    expect(dispatchTick).toBeGreaterThan(prepare);
  });

  test("production utility preparation replans through planScopedUtility and selects a feasible Road route", async () => {
    const identity = {
      gameMode: "Game", isLoading: false, cityLoaded: true,
      world: { identityStatus: "AVAILABLE", worldReady: true, worldId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nativeSessionGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", loadPurpose: "LoadGame", loadAssetGuid: "meta-a",
        saveDataAssetGuid: "data-a", mapAssetGuid: "map-a", checkpointId: "save:meta-a:data-a",
        bridgeRuntimeEpoch: "bridge-a", generation: "generation-a", generationSequence: 1, generationOrigin: "LOAD_COMPLETED",
        nativeOperationBusy: false, nativeOperationStage: "Idle" },
    };
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage);
    const activation = coordinator.activate(identity);
    let state = planStarterResidentialIntent({ intentId: "intent:selector-integration", targetResidents: 12,
      maximumBudget: 100_000, planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }] });
    state.tranche.stage = "SITE_SELECTED";
    state.project.status = "ACTIVE"; state.intent.status = "ACTIVE";
    const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
    roadTask.status = "BLOCKED"; roadTask.attempts = 1; roadTask.maximumAttempts = 1;
    roadTask.terminalOutcomeId = `${roadTask.id}:outcome:1`;
    const oldInput = { prefab: "Small Road", x1: 20, z1: 0, x2: 0, z2: 0 };
    coordinator.saveProjectState(state);
    const child = coordinator.recordUtilityServiceRoadChildOperation({ state, planRevision: "old-plan", exactRoadInput: oldInput,
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...oldInput }), authorizationWorldId: activation.world.worldId,
      authorizationCheckpointId: activation.world.checkpointId!, authorizationGeneration: activation.world.generation, detail: "predecessor child" });
    coordinator.consumeUtilityServiceRoadChildOperation(child.amendmentId, child.courseFingerprint!);
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    roadTask.childOperationAmendmentId = child.amendmentId;
    state.tranche.currentTaskIds = { ROAD_CONNECTION: roadTask.id };
    const evidence: Gate1RoadPreApplyFailureEvidence = { schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1",
      phase: "ROAD_PREVIEW_QUOTE_VALIDATION", taskId: roadTask.id, childId: child.amendmentId, exactInput: oldInput,
      firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false };
    state.journal.push({ id: roadTask.terminalOutcomeId, taskId: roadTask.id, skill: "RoadConnection",
      proposalId: `${roadTask.id}:attempt:1`, recordedAt: "2026-09-26T00:00:00.000Z", admission: "ADMITTED",
      execution: "UNKNOWN", commandId: null, observationId: null, observedEffect: "UNKNOWN",
      failureClassification: "EXECUTION_UNKNOWN", roadPreApplyFailure: evidence, reason: "preview-only failure" });
    coordinator.saveProjectState(state);
    const oldBranchId = coordinator.executionBranchId();
    const oldIntentId = state.intent.id;
    const historicalLoad = structuredClone(identity) as typeof identity;
    historicalLoad.world.generation = "generation-historical-2";
    historicalLoad.world.bridgeRuntimeEpoch = "bridge-historical-2";
    historicalLoad.world.generationSequence = 2;
    const newBranchActivation = coordinator.activate(historicalLoad);
    identity.world = structuredClone(historicalLoad.world);
    expect(newBranchActivation.blockedReason).toBeNull();
    expect(coordinator.executionBranchId()).not.toBe(oldBranchId);
    coordinator.markExecutionBranchWorldVerified({
      worldId: newBranchActivation.world.worldId,
      generation: newBranchActivation.world.generation,
      worldEpochId: newBranchActivation.world.worldEpochId,
      checkpointId: newBranchActivation.world.checkpointId!,
    });
    coordinator.recordCheckpoint({ status: "COMPLETED", durable: true,
      worldId: newBranchActivation.world.worldId, worldGeneration: newBranchActivation.world.generation,
      checkpoint: { checkpointId: newBranchActivation.world.checkpointId!, saveMetadataAssetGuid: "meta-a",
        saveDataAssetGuid: "data-a", nativeSessionGuid: newBranchActivation.world.nativeSessionGuid! },
    }, coordinator.currentJournalPosition());
    state = planStarterResidentialIntent({ intentId: `intent:selector-integration:branch:${coordinator.executionBranchId()}`, targetResidents: 12,
      maximumBudget: 100_000, planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
      siteCandidates: [{ id: "site-current-world", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 1, blocked: false }] });
    state.tranche.stage = "SITE_SELECTED";
    state.project.status = "ACTIVE"; state.intent.status = "ACTIVE";
    coordinator.saveProjectState(state);
    expect(state.intent.id).not.toBe(oldIntentId);

    const roads = [{ entity: { index: 20, version: 1 }, prefab: "Small Road", native: true,
      startNode: { index: 21, version: 1 }, endNode: { index: 22, version: 1 },
      start: { x: 100, z: -100 }, end: { x: 100, z: 100 }, length: 200 }];
    const asset = { prefab: "GroundwaterPumpingStation01", locked: false, constructionCost: 50_000,
      lotSize: { x: 48, z: 48 }, size: { x: 48, y: 20, z: 48 },
      capabilities: { electricityProduction: 0, windMaximum: 0, windProduction: 0, groundWaterProduction: 0,
        groundWaterMaximum: 75_000, freshWaterCapacity: 75_000, allowedWaterTypes: "Groundwater", sewageCapacity: 0, sewagePurification: 0 } };
    const scan = { world: { min: -1000, max: 1000, size: 2000 }, tiles: [{ id: "owned", owned: true,
      polygon: [], bounds: { min: { x: -200, z: -200 }, max: { x: 200, z: 200 } } }], outsideConnections: [],
      bootstrapAssets: [asset], roadGraph: { nodes: [], edges: roads, truncated: false } };
    const detail = { center: { x: 0, z: 0 }, radius: 180,
      terrain: { resolution: 1, bounds: { minX: -180, minZ: -180, maxX: 180, maxZ: 180 }, cellSize: { x: 360, z: 360 },
        heights: [0], waterDepths: [0], groundWater: [0], groundWaterPollution: [0], windSpeed: [0] },
      roadGraph: { nodes: [], edges: roads }, buildings: [{ entity: { index: 40, version: 1 }, prefab: asset.prefab,
        native: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null }], zoningCells: [] };
    const preflights: Record<string, unknown>[] = [];
    const previewVerdicts: boolean[] = [];
    const manager = {
      legacyList: async () => ({ tools: ["cs2_game_state", "cs2_spatial", "cs2_list_buildings", "cs2_utility_connectors", "cs2_mayor_snapshot"]
        .map((name) => ({ name: `bridge--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: Record<string, unknown> = {};
        if (name === "cs2_game_state") payload = { ...identity, simulation: { frameIndex: 10 }, world: {
          ...identity.world, nativeOperationBusy: false, nativeOperationStage: "Idle", simulationHasTickedSinceLoad: true } };
        if (name === "cs2_spatial" && args.mode === "scan") payload = scan;
        if (name === "cs2_spatial" && args.mode === "detail") payload = detail;
        if (name === "cs2_spatial" && args.mode === "preflight") {
          preflights.push(args);
          previewVerdicts.push(preflights.length !== 1);
          payload = preflights.length === 1
            ? { valid: false, previewOnly: true, validNewRoadProposal: false, roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
                courseIntegrity: { operationKind: "NEW_ROAD_PROPOSAL_EDGE", postHandoffGeometryPreserved: true,
                  proposalEdgeCount: 0, firstFailure: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" } }
            : { valid: true, previewOnly: true, validNewRoadProposal: true, roadOperationKind: "NEW_ROAD_PROPOSAL_EDGE",
                courseIntegrity: { operationKind: "NEW_ROAD_PROPOSAL_EDGE", postHandoffGeometryPreserved: true,
                  proposalEdgeCount: 1, firstFailure: null } };
        }
        if (name === "cs2_list_buildings") payload = { buildings: [{ entity: { index: 40, version: 1 },
          prefab: asset.prefab, isSubBuilding: false, position: { x: 0, z: 0 } }] };
        if (name === "cs2_utility_connectors") payload = { connectors: [{ type: "waterPipe", node: { index: 41, version: 1 },
          worldPosition: { x: 100, z: 0 }, attached: true, orphan: false, capacity: { fresh: 75_000 } }] };
        if (name === "cs2_mayor_snapshot") payload = { utilities: { water: { status: "available", capacity: 75_000,
          consumption: 1, fulfilledConsumption: 1 } } };
        return { structuredContent: payload };
      },
    };
    const ports = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage });
    const preparedInput = buildUtilityPreparationInput({ state, world: newBranchActivation.world, treasury: 100_000,
      kind: "water", connectionOnly: true, stageBReadOnly: true });
    await ports.greenfieldUtilityBootstrap.prepare(preparedInput);

    expect(preflights.length).toBeGreaterThan(1);
    expect(coordinator.executionBranchId()).not.toBe(oldBranchId);
    expect(previewVerdicts.slice(0, 2)).toEqual([false, true]);
    expect(preflights.slice(0, 2).every((request) => request.kind === "net" && request.prefab === "Small Road")).toBe(true);
    expect(preflights[0]).toMatchObject({ x1: expect.any(Number), z1: expect.any(Number), x2: expect.any(Number), z2: expect.any(Number) });
    expect(preflights[1]).toMatchObject({ x1: expect.any(Number), z1: expect.any(Number), x2: expect.any(Number), z2: expect.any(Number) });
    expect(preflights[1]).not.toMatchObject({ x1: preflights[0].x1, z1: preflights[0].z1, x2: preflights[0].x2, z2: preflights[0].z2 });
  });
});
