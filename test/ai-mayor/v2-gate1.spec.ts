import { normalizeNativeRoadDiagnostics, classifyNativeRoadDiagnosticFailure, RoadQuoteContractError } from "../../src/main/services/ai-mayor/v2/runtime-road-caller";
import { createMemoryDurableStateStorage, V2DurabilityCoordinator } from "../../src/main/services/ai-mayor/v2/durability";
import {
  admitGate1Proposal,
  createDurableGate1StateStorage,
  createGate1FoundationBoundary,
  createGate1VerticalSlice,
  createMemoryGate1StateStorage,
  ensureUtilityServiceRoadGoal,
  Gate1BoundedRoadSiteDeadEndError,
  Gate1BoundedZoningDeadEndError,
  type Gate1AdmittedProposal,
  type Gate1Observation,
  type Gate1SkillProposal,
  type Gate1State,
  type Gate1WorldBoundary,
  planStarterResidentialIntent,
  ROAD_CANDIDATE_FAMILY_REVISION,
  type StarterResidentialIntentInput,
} from "../../src/main/services/ai-mayor/v2/gate1";
import { createMemoryCommandJournal, type V2CommandRecord } from "../../src/main/services/ai-mayor/v2/foundation";
import { createDurableGreenfieldUtilityState } from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import type { V2UtilityBudgetAmendmentRecord } from "../../src/main/services/ai-mayor/v2/durability";
import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";

describe("native ROAD diagnostics", () => {
  test("preserves typed native errors and structural evidence without heuristics", () => {
    const diagnostics = normalizeNativeRoadDiagnostics({
      status: 409,
      commandId: "road-7",
      validation: { status: "REJECTED", detailAvailable: true, errors: [{ errorType: "Overlap", severity: "Error", toolError: "ToolError.RoadOverlap" }] },
      structural: { generatedEdge: false, essentialTempValid: true, originalDeleted: false },
    });
    expect(diagnostics).toEqual({
      classification: "REJECTED_WITH_NATIVE_ERRORS",
      validation: { status: "REJECTED", detailAvailable: true, errors: [{ errorType: "Overlap", severity: "Error", toolError: "ToolError.RoadOverlap" }] },
      structural: { generatedEdge: false, essentialTempValid: true, originalDeleted: false },
    });
  });

  test("classifies no detail and transport separately", () => {
    expect(normalizeNativeRoadDiagnostics({ status: 409, validation: { status: "REJECTED", detailAvailable: false } })?.classification).toBe("REJECTED_NO_DETAIL");
    expect(classifyNativeRoadDiagnosticFailure(new Error("HTTP 409 operation blocked by game validation"))).toBe("REJECTED_NO_DETAIL");
    expect(classifyNativeRoadDiagnosticFailure(Object.assign(new Error("operation blocked by game validation"), {
      status: 409,
      nativeToolErrors: [{ errorType: "SteepSlope" }],
      bridgeHttpErrorDiagnostics: { source: "bridge-http-error" },
    }))).toBe("REJECTED_NO_DETAIL");
    expect(classifyNativeRoadDiagnosticFailure(Object.assign(new Error("operation blocked by game validation"), { status: 409 })))
      .toBe("UNKNOWN");
    expect(classifyNativeRoadDiagnosticFailure(new Error("transport timeout"))).toBe("UNKNOWN");
    expect(classifyNativeRoadDiagnosticFailure(new Error("ROAD_ENDPOINT_WORLD_EPOCH_MISMATCH"))).toBe("REJECTED_NO_DETAIL");
  });
});

describe("Gate1 concrete utility Road child Admission", () => {
  const fixture = () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tranche.stage = "SITE_SELECTED";
    state.tasks[0].status = "SUCCEEDED";
    const task = state.tasks.find((entry) => entry.kind === "ROAD_CONNECTION")!;
    task.status = "DISPATCHED";
    const input = { prefab: "Small Road", x1: -20, z1: 10, x2: 20, z2: 10 };
    const fingerprint = stableRoadInput(input);
    const amendment: V2UtilityBudgetAmendmentRecord = {
      schemaVersion: "ai-mayor-v2-utility-budget-amendment/1",
      amendmentId: "UTILITY_SERVICE_ROAD_CHILD_OPERATION:fixture",
      projectId: state.project.id,
      intentId: state.intent.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      originalProjectBudget: state.project.maximumBudget,
      requiredUtilityBudget: state.project.maximumBudget,
      amendedEffectiveBudget: state.project.maximumBudget,
      reason: "UTILITY_SERVICE_ROAD_CHILD_OPERATION",
      detail: "fixture",
      amendedAt: instant.toISOString(),
      status: "ACTIVE",
      planRevision: "project-replan:current-branch",
      courseFingerprint: fingerprint,
      exactRoadInput: input,
      authorizationWorldId: "world-a",
      authorizationCheckpointId: "save-a",
      authorizationGeneration: "generation-a",
      executionUseLimit: 1,
      executionUseStatus: "UNUSED",
    };
    task.childOperationAmendmentId = amendment.amendmentId;
    const proposal: Gate1SkillProposal = {
      id: `${task.id}:attempt:1`, attempt: 1, skill: "RoadConnection", taskId: task.id,
      projectId: state.project.id, districtId: state.district.id, trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef, requiredStage: "SITE_SELECTED", kind: "WORLD_WRITE",
      actionFamily: "ROAD", operation: "BUILD_ROAD", target: structuredClone(state.tranche.target),
      boundedFallback: null, methodVariant: "PRIMARY",
      concreteChildOperation: { amendmentId: amendment.amendmentId, planRevision: amendment.planRevision!, input, courseFingerprint: fingerprint },
    };
    const context = {
      getAmendment: (id: string) => id === amendment.amendmentId ? amendment : null,
      current: { worldId: "world-a", checkpointId: "save-a", generation: "generation-a", planRevision: amendment.planRevision! },
      hasRoadOperation: () => false,
    };
    return { state, task, input, amendment, proposal, context };
  };

  test("three ordered Road children advance only after authoritative access and reset attempts per child", async () => {
    const { state, task, amendment, context } = fixture();
    task.status = "PENDING";
    const children = [0, 1, 2].map((index) => ({
      ...structuredClone(amendment),
      amendmentId: `${amendment.amendmentId}:${index}`,
      exactRoadInput: { ...amendment.exactRoadInput!, x1: -20 + index * 10, x2: -10 + index * 10 },
    }));
    for (const child of children) child.courseFingerprint = stableRoadInput(child.exactRoadInput);
    task.childOperationAmendmentIds = children.map((child) => child.amendmentId);
    task.childOperationAmendmentId = children[0].amendmentId;
    const executed: string[] = [];
    let accessChecks = 0;
    const workflow = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: {
        execute: async (proposal) => {
          executed.push(proposal.concreteChildOperation!.amendmentId);
          const child = children.find((entry) => entry.amendmentId === proposal.concreteChildOperation!.amendmentId)!;
          child.status = "CONSUMED";
          child.executionUseStatus = "CONSUMED";
          return { status: "DELIVERED", commandId: `road-${executed.length}`, observedMatch: true, reason: "observed" };
        },
        roadAccessConnected: async () => ++accessChecks === 3,
      },
      utilityServiceRoadChildOperation: (id) => children.find((child) => child.amendmentId === id) ?? null,
      concreteChildOperationAdmissionContext: () => ({ ...context, getAmendment: (id) => children.find((child) => child.amendmentId === id) ?? null }),
      now: () => instant,
    });
    const first = await workflow.tick(observation(state));
    expect(first.state.tranche.stage).toBe("SITE_SELECTED");
    expect(first.task).toMatchObject({ status: "PENDING", attempts: 0, childOperationAmendmentId: children[1].amendmentId });
    const second = await workflow.tick(observation(state));
    expect(second.state.tranche.stage).toBe("SITE_SELECTED");
    expect(second.task).toMatchObject({ status: "PENDING", attempts: 0, childOperationAmendmentId: children[2].amendmentId });
    const third = await workflow.tick(observation(state));
    expect(third.state.tranche.stage).toBe("ROAD_DELIVERED");
    expect(executed).toEqual(children.map((child) => child.amendmentId));
  });

  test("all delivered route children cannot complete without authoritative access", async () => {
    const { state, task, amendment, context } = fixture();
    task.status = "PENDING";
    task.childOperationAmendmentIds = [amendment.amendmentId];
    const workflow = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: {
        execute: async () => ({ status: "DELIVERED", commandId: "road", observedMatch: true, reason: "observed" }),
        roadAccessConnected: async () => false,
      },
      utilityServiceRoadChildOperation: () => amendment,
      concreteChildOperationAdmissionContext: () => context,
      now: () => instant,
    });
    const result = await workflow.tick(observation(state));
    expect(result.state.tranche.stage).toBe("SITE_SELECTED");
    expect(result.task?.status).toBe("BLOCKED");
  });

  test("a later child cannot be admitted before its predecessor is consumed", () => {
    const { state, task, amendment, proposal, context } = fixture();
    task.childOperationAmendmentIds = ["prior-child", amendment.amendmentId];
    const rejected = admitGate1Proposal(state, task, proposal, instant, {
      ...context,
      getAmendment: (id) => id === amendment.amendmentId ? amendment :
        id === "prior-child" ? { ...amendment, amendmentId: id } : null,
    });
    expect(rejected).toMatchObject({ admission: { decision: "REJECTED", reason: "utility service-road child sequence is out of order" } });
  });

  test("unknown access read holds the delivered command without dispatching another child", async () => {
    const { state, task, amendment, context } = fixture();
    task.status = "PENDING";
    task.childOperationAmendmentIds = [amendment.amendmentId, "next-child"];
    const workflow = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: {
        execute: async () => ({ status: "DELIVERED", commandId: "road-command", observedMatch: true, reason: "observed" }),
        roadAccessConnected: async () => { throw new Error("world changed"); },
      },
      utilityServiceRoadChildOperation: () => amendment,
      concreteChildOperationAdmissionContext: () => context,
      now: () => instant,
    });
    const result = await workflow.tick(observation(state));
    expect(result.task).toMatchObject({ status: "WAITING", activeCommandId: "road-command",
      childOperationAmendmentId: amendment.amendmentId });
    expect(result.state.tranche.stage).toBe("SITE_SELECTED");
  });

  test("admits the owned, current, exact child course inside the utility reservation", () => {
    const { state, task, proposal, context } = fixture();
    expect(admitGate1Proposal(state, task, proposal, instant, context)).toMatchObject({ admission: { decision: "ADMITTED" } });
  });

  test("rehydrates proposal geometry from the durable amendment instead of the task or planner", async () => {
    const { state, task, amendment, input, context } = fixture();
    task.status = "PENDING";
    const execute = jest.fn(async (proposal: Gate1AdmittedProposal) => ({
      status: "DELIVERED" as const,
      commandId: "road-child-command",
      observedMatch: true,
      reason: "fixture delivered",
    }));
    const workflow = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: { execute },
      utilityServiceRoadChildOperation: (id) => id === amendment.amendmentId ? amendment : null,
      concreteChildOperationAdmissionContext: () => context,
      now: () => instant,
    });
    const result = await workflow.tick(observation(state));
    expect(result.proposal?.concreteChildOperation).toEqual({
      amendmentId: amendment.amendmentId,
      planRevision: amendment.planRevision,
      input,
      courseFingerprint: amendment.courseFingerprint,
    });
    expect(execute.mock.calls[0][0].concreteChildOperation?.input).toEqual(amendment.exactRoadInput);
  });

  test("dispatches the durable successor task and binds only its corrected child input", async () => {
    const { state, task: oldTask, amendment, context } = fixture();
    const corrected = { prefab: "Small Road", x1: -20, z1: 10, x2: 30, z2: 10 };
    const successor = {
      ...oldTask,
      id: "gate1-task-successor:test",
      status: "PENDING" as const,
      attempts: 0,
      terminalOutcomeId: null,
      supersedesTaskId: oldTask.id,
      supersessionReason: "PLANNER_INPUT_CHANGED" as const,
      replacementKey: "replacement:test",
      childOperationAmendmentId: amendment.amendmentId,
    };
    oldTask.status = "BLOCKED";
    oldTask.attempts = 2;
    oldTask.maximumAttempts = 2;
    oldTask.terminalOutcomeId = `${oldTask.id}:outcome:terminal`;
    state.tasks.push(successor);
    state.tranche.taskIds.push(successor.id);
    state.tranche.currentTaskIds = { ROAD_CONNECTION: successor.id };
    state.project.status = "ACTIVE";
    state.intent.status = "ACTIVE";
    amendment.exactRoadInput = corrected;
    amendment.courseFingerprint = stableRoadInput(corrected);
    amendment.planRevision = context.current.planRevision;
    const execute = jest.fn(async (proposal: Gate1AdmittedProposal) => ({
      status: "WAITING" as const, commandId: null, observedMatch: false, reason: "native slot busy",
    }));
    const workflow = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state),
      boundary: { execute },
      utilityServiceRoadChildOperation: (id) => id === amendment.amendmentId ? amendment : null,
      concreteChildOperationAdmissionContext: () => context,
      now: () => instant,
    });
    const result = await workflow.tick(observation(state));
    expect(result.task?.id).toBe(successor.id);
    expect(result.proposal?.taskId).toBe(successor.id);
    expect(result.proposal?.concreteChildOperation?.input).toEqual(corrected);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(workflow.snapshot().tasks.find((candidate) => candidate.id === oldTask.id)).toMatchObject({ status: "BLOCKED", attempts: 2,
      terminalOutcomeId: oldTask.terminalOutcomeId });
  });

  test.each(["planRevision", "authorizationWorldId", "authorizationCheckpointId", "authorizationGeneration"] as const)(
    "rejects a stale child %s",
    (field) => {
      const { state, task, proposal, amendment, context } = fixture();
      if (field === "planRevision") context.current.planRevision = "project-replan:other-branch";
      else amendment[field] = `stale-${field}`;
      expect(admitGate1Proposal(state, task, proposal, instant, context)).toMatchObject({ admission: { decision: "REJECTED" } });
    },
  );

  test("rejects consumed, duplicate, changed-input, and out-of-reservation child courses", () => {
    const consumed = fixture();
    consumed.amendment.status = "CONSUMED";
    consumed.amendment.executionUseStatus = "CONSUMED";
    expect(admitGate1Proposal(consumed.state, consumed.task, consumed.proposal, instant, consumed.context)).toMatchObject({ admission: { decision: "REJECTED" } });

    const duplicate = fixture();
    duplicate.context.hasRoadOperation = () => true;
    expect(admitGate1Proposal(duplicate.state, duplicate.task, duplicate.proposal, instant, duplicate.context)).toMatchObject({ admission: { decision: "REJECTED" } });

    const changed = fixture();
    changed.proposal.concreteChildOperation!.input = { ...changed.input, x2: 21 };
    expect(admitGate1Proposal(changed.state, changed.task, changed.proposal, instant, changed.context)).toMatchObject({ admission: { decision: "REJECTED" } });

    const outside = fixture();
    const input = { ...outside.input, x1: 300, x2: 340 };
    const fingerprint = stableRoadInput(input);
    outside.amendment.exactRoadInput = input;
    outside.amendment.courseFingerprint = fingerprint;
    outside.proposal.concreteChildOperation = { ...outside.proposal.concreteChildOperation!, input, courseFingerprint: fingerprint };
    expect(admitGate1Proposal(outside.state, outside.task, outside.proposal, instant, outside.context)).toMatchObject({ admission: { decision: "REJECTED" } });
  });
});

describe("Gate1 utility service-road subgoal", () => {
  test("adds one bounded Road goal after certified starter Road and preserves both task identities", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    const parent = state.tasks.find((entry) => entry.kind === "ROAD_CONNECTION")!;
    state.tranche.stage = "ROAD_DELIVERED";
    state.tranche.delivery_progress.completed = 2;
    parent.status = "SUCCEEDED";
    parent.terminalOutcomeId = `${parent.id}:outcome:2`;
    state.journal.push({
      id: parent.terminalOutcomeId, taskId: parent.id, skill: "RoadConnection", proposalId: `${parent.id}:attempt:2`,
      recordedAt: instant.toISOString(), admission: "ADMITTED", execution: "DELIVERED", commandId: "command:starter-road",
      observationId: "observation:starter-road", observedEffect: "NOT_APPLICABLE", failureClassification: "NONE",
      reason: "authoritative Road effect certified",
    });

    expect({ schemaVersion: state.schemaVersion, stage: state.tranche.stage, project: state.project.status, intent: state.intent.status,
      parent: { status: parent.status, terminalOutcomeId: parent.terminalOutcomeId }, journal: state.journal.at(-1) }).toMatchObject({
      schemaVersion: "ai-mayor-v2-gate1-state/2", stage: "ROAD_DELIVERED", project: "ACTIVE", intent: "ACTIVE",
      parent: { status: "SUCCEEDED", terminalOutcomeId: parent.terminalOutcomeId }, journal: { execution: "DELIVERED", commandId: "command:starter-road" },
    });

    const first = ensureUtilityServiceRoadGoal(state, "utility-plan:1", ["child:1", "child:2"]);
    const second = ensureUtilityServiceRoadGoal(state, "utility-plan:1", ["child:1", "child:2"]);

    expect(first).toMatchObject({ kind: "ROAD_CONNECTION", legalStage: "ROAD_DELIVERED", status: "PENDING", utilityRoadParentTaskId: parent.id });
    expect(second.id).toBe(first.id);
    expect(state.tasks.filter((entry) => entry.utilityRoadParentTaskId === parent.id)).toHaveLength(1);
    expect(state.tranche.currentTaskIds?.ROAD_CONNECTION).toBe(first.id);
    expect(state.tranche.delivery_progress).toMatchObject({ completed: 2, total: 5, ratio: 0.4 });
    expect(parent.status).toBe("SUCCEEDED");
  });

  test("does not generate a utility Road subgoal from an uncertified Road outcome", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tranche.stage = "ROAD_DELIVERED";
    const parent = state.tasks.find((entry) => entry.kind === "ROAD_CONNECTION")!;
    parent.status = "SUCCEEDED";
    parent.terminalOutcomeId = `${parent.id}:outcome:2`;
    state.journal.push({
      id: parent.terminalOutcomeId, taskId: parent.id, skill: "RoadConnection", proposalId: null,
      recordedAt: instant.toISOString(), admission: "ADMITTED", execution: "UNKNOWN", commandId: null,
      observationId: null, observedEffect: "UNKNOWN", failureClassification: "EXECUTION_UNKNOWN", reason: "unknown",
    });
    expect(() => ensureUtilityServiceRoadGoal(state, "utility-plan:1", ["child:1"])).toThrow("UTILITY_SERVICE_ROAD_SUBGOAL_PARENT_EFFECT_NOT_CERTIFIED");
  });
});
const instant = new Date("2026-09-13T20:00:00.000Z");
const starterBuilding = { index: 42, version: 7 };
const initial = (overrides: Partial<StarterResidentialIntentInput> = {}): StarterResidentialIntentInput => ({
  intentId: "intent:first-residents",
  targetResidents: 24,
  maximumBudget: 25_000,
  planningEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
  siteCandidates: [
    { id: "legal-low", target: { center: { x: -40, z: 0 }, radius: 30 }, score: 5, blocked: false },
    { id: "legal-high", target: { center: { x: 40, z: 0 }, radius: 30 }, score: 10, blocked: false },
  ],
  maximumWaitObservations: 2,
  ...overrides,
});

const observation = (state: Gate1State, overrides: Partial<Gate1Observation> = {}): Gate1Observation => ({
  observationId: `observation:${state.stateVersion}`,
  runtimeEpoch: "runtime:gate1-test",
  coherence: "STABLE_FRAME",
  capturedAt: instant.toISOString(),
  trancheId: state.tranche.id,
  access: { value: "PASS", provenance: "DERIVED" },
  productiveFrontage: { value: "PASS", provenance: "DERIVED" },
  utilities: {
    value: "PASS",
    provenance: "DERIVED",
    evidenceKind: "ACTUAL_CONSUMER_SERVICE",
    buildingRefs: [starterBuilding],
  },
  residentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
  actualResidents: { value: 0, provenance: "OBSERVED" },
  occupiedResidentialBuildings: { value: [], provenance: "OBSERVED" },
  ...overrides,
});

function harness(
  options: { storage?: ReturnType<typeof createMemoryGate1StateStorage>; boundary?: Gate1WorldBoundary } = {},
) {
  const calls: Gate1AdmittedProposal[] = [];
  const boundary = options.boundary ?? {
    execute: jest.fn(async (proposal: Gate1AdmittedProposal) => {
      calls.push(proposal);
      return {
        status: "DELIVERED" as const,
        commandId: `command:${proposal.id}`,
        observedMatch: proposal.actionFamily === "ZONING",
        reason: "foundation kernel completed",
      };
    }),
  };
  const storage = options.storage ?? createMemoryGate1StateStorage();
  const rawRuntime = createGate1VerticalSlice({ storage, initial: initial(), boundary, now: () => instant });
  const runtime = {
    snapshot: () => rawRuntime.snapshot(),
    recordUtilityExecution: rawRuntime.recordUtilityExecution,
    async tick(...args: Parameters<typeof rawRuntime.tick>) {
      const result = await rawRuntime.tick(...args);
      const state = rawRuntime.snapshot();
      if (state.tranche.stage === "ROAD_DELIVERED" && !state.tranche.utilityExecution) {
        const utility = createDurableGreenfieldUtilityState({
          intentId: state.intent.id, projectId: state.project.id, trancheId: state.tranche.id,
          reservationRef: state.tranche.reservationRef, worldId: "world", worldEpochId: "epoch",
          generation: "generation", topologyRevision: "topology", certifiedRoadRefs: [{ index: 1, version: 1 }],
          targetServiceEntry: { road: { index: 1, version: 1 }, position: state.tranche.target.center },
          spatialEnvelope: state.project.utilityReservation, maximumSpend: 1, treasury: 1, treasurySafetyReserve: 0,
        });
        for (const value of Object.values(utility.utilities)) {
          value.stage = "SERVICE_CERTIFIED";
          value.serviceEvidence = {
            status: "AVAILABLE", revision: "generation:10", capacity: 100, consumption: 10,
            fulfilledConsumption: 10, issueActive: false, supplyExists: true, networkConnected: true,
            cityCapacityAvailable: true, targetNetworkReachable: true,
            facility: { entity: { index: 100, version: 1 }, prefab: "starter", position: { x: 0, z: 0 } },
            connector: { type: value.kind === "electricity" ? "electricity" : "waterPipe", node: { index: 200, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: true, capacity: {} },
            targetRoad: { index: 1, version: 1 }, evidenceGeneration: "generation", topologyRevision: "topology",
          };
        }
        rawRuntime.recordUtilityExecution(utility);
      }
      return result;
    },
  } as typeof rawRuntime;
  return { runtime, storage, boundary, calls };
}

async function driveToWaiting(runtime: ReturnType<typeof harness>["runtime"]) {
  await runtime.tick();
  await runtime.tick();
  await runtime.tick(observation(runtime.snapshot()));
  await runtime.tick(observation(runtime.snapshot()));
  return runtime.tick(observation(runtime.snapshot()));
}

describe("V2 Gate 1 minimum executable vertical slice", () => {
  test("Intent decomposes into one bounded starter project with one owned district/tranche", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    expect(state.intent).toMatchObject({ kind: "ESTABLISH_FIRST_RESIDENTIAL_POPULATION", targetResidents: 24 });
    expect(state.project).toMatchObject({
      intentId: state.intent.id,
      districtId: state.district.id,
      trancheIds: [state.tranche.id],
    });
    expect(state.district).toMatchObject({ projectId: state.project.id, reservationRef: state.tranche.reservationRef });
    expect(state.districtPlan).toMatchObject({ districtId: state.district.id, starterTrancheId: state.tranche.id });
    expect(state.project.trancheIds).toHaveLength(1);
  });

  test("constrained site planning rejects blocked, protected, and out-of-envelope candidates", () => {
    const protectedScope = { center: { x: 40, z: 0 }, radius: 20 };
    const state = planStarterResidentialIntent(
      initial({
        protections: [{ ref: "player:protected", scope: protectedScope }],
        siteCandidates: [
          { id: "outside", target: { center: { x: 195, z: 0 }, radius: 20 }, score: 100, blocked: false },
          { id: "blocked", target: { center: { x: 0, z: 0 }, radius: 20 }, score: 90, blocked: true },
          { id: "protected", target: { center: { x: 40, z: 0 }, radius: 15 }, score: 80, blocked: false },
          { id: "legal", target: { center: { x: -40, z: 0 }, radius: 25 }, score: 1, blocked: false },
        ],
      }),
      instant,
    );
    expect(state.district.boundary.center).toEqual({ x: -40, z: 0 });
    expect(state.district.protectionRefs).toEqual(["player:protected"]);
  });

  test("Tranche proposal cannot escape reservation", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tasks[0].status = "DISPATCHED";
    const proposal: Gate1SkillProposal = {
      id: "proposal:escape",
      attempt: 1,
      skill: "SiteSelection",
      taskId: state.tasks[0].id,
      projectId: state.project.id,
      districtId: state.district.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      requiredStage: "PLANNED",
      kind: "STATE",
      actionFamily: null,
      operation: "SELECT_SITE",
      target: { center: { x: 500, z: 500 }, radius: 5 },
      boundedFallback: null,
      methodVariant: "PRIMARY",
    };
    expect(admitGate1Proposal(state, state.tasks[0], proposal, instant)).toEqual({
      admission: { decision: "REJECTED", reason: "proposal target escapes tranche reservation" },
    });
  });

  test("Executive dispatches only the legal current-stage task", async () => {
    const { runtime, boundary } = harness();
    const first = await runtime.tick();
    expect(first.task?.kind).toBe("SITE_SELECTION");
    expect(first.state.tranche.stage).toBe("SITE_SELECTED");
    expect(boundary.execute).not.toHaveBeenCalled();
    const second = await runtime.tick();
    expect(second.task?.kind).toBe("ROAD_CONNECTION");
    expect(boundary.execute).toHaveBeenCalledTimes(1);
  });

  test("ROAD candidates rejected in preflight do not admit a proposal or consume an attempt", async () => {
    const preflightRoad = jest.fn(async () => ({
      status: "NO_FEASIBLE_CANDIDATE" as const,
      reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:2 bounded previews rejected",
    }));
    const execute = jest.fn(async () => ({
      status: "DELIVERED" as const, commandId: "must-not-run", observedMatch: true, reason: "unexpected",
    }));
    const { runtime } = harness({ boundary: { preflightRoad, execute } });
    await runtime.tick();
    const rejected = await runtime.tick();
    expect(preflightRoad).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(rejected.proposal).toBeNull();
    expect(rejected.task).toMatchObject({ kind: "ROAD_CONNECTION", status: "BLOCKED", attempts: 0 });
    expect(rejected.outcome).toMatchObject({
      admission: "NOT_REQUIRED",
      execution: "NOT_REQUIRED",
      commandId: null,
      failureClassification: "ROAD_PREFLIGHT_REJECTED",
    });
  });

  test("rechecks a restored candidate-only Road rejection once without resetting attempts or dropping evidence", async () => {
    const storage = createMemoryGate1StateStorage();
    const commands = createMemoryCommandJournal();
    const preflightRoad = jest.fn(async () => ({
      status: "NO_FEASIBLE_CANDIDATE" as const,
      reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:bounded previews rejected",
    }));
    const first = createGate1VerticalSlice({
      storage,
      initial: initial(),
      boundary: { preflightRoad, execute: jest.fn() },
      commandJournal: commands,
      now: () => instant,
    });
    await first.tick();
    const rejected = await first.tick();
    const originalOutcomeId = rejected.outcome!.id;
    expect(rejected.task).toMatchObject({ status: "BLOCKED", attempts: 0, terminalOutcomeId: originalOutcomeId });

    const restored = createGate1VerticalSlice({
      storage,
      boundary: { preflightRoad, execute: jest.fn() },
      commandJournal: commands,
      now: () => instant,
    });
    expect(restored.snapshot().tasks[1]).toMatchObject({ status: "PENDING", attempts: 0, terminalOutcomeId: null });
    expect(restored.snapshot().journal.find((entry) => entry.id === originalOutcomeId)?.failureClassification)
      .toBe("ROAD_PREFLIGHT_REJECTED");
    // The marker names the candidate family revision it was recorded against, so a
    // rejection cannot suppress a later, widened family forever.
    expect(restored.snapshot().tranche.executionRecoveryMarkers)
      .toContain(`ROAD_CANDIDATE_PREFLIGHT_REEVALUATION:${ROAD_CANDIDATE_FAMILY_REVISION}`);
    expect(restored.snapshot().journal.at(-1)?.reason)
      .toContain("attempts and the original rejection evidence are retained");

    const restoredAgain = createGate1VerticalSlice({
      storage,
      boundary: { preflightRoad, execute: jest.fn() },
      commandJournal: commands,
      now: () => instant,
    });
    expect(restoredAgain.snapshot().journal.filter((entry) => entry.reason.includes("bounded candidate-only preflight rejection")))
      .toHaveLength(1);
  });

  test("native build slot busy waits without consuming the RoadConnection attempt and resumes the same task", async () => {
    let calls = 0;
    const boundary: Gate1WorldBoundary = {
      execute: jest.fn(async () => {
        calls += 1;
        return calls === 1
          ? { status: "WAITING" as const, commandId: null, observedMatch: false, reason: "WAITING_FOR_NATIVE_BUILD_SLOT" }
          : { status: "DELIVERED" as const, commandId: "road-committed", observedMatch: true, reason: "road delivered" };
      }),
    };
    const { runtime } = harness({ boundary });
    await runtime.tick();
    const waiting = await runtime.tick();
    expect(waiting.outcome).toMatchObject({ execution: "WAITING", reason: "WAITING_FOR_NATIVE_BUILD_SLOT", commandId: null });
    expect(waiting.state.tasks.find((task) => task.kind === "ROAD_CONNECTION")).toMatchObject({ attempts: 0, activeCommandId: null });
    const resumed = await runtime.tick();
    expect(resumed.outcome).toMatchObject({ execution: "DELIVERED", reason: "road delivered" });
    expect(resumed.state.tranche.stage).toBe("ROAD_DELIVERED");
    expect((boundary.execute as jest.Mock).mock.calls).toHaveLength(2);
  });

  test("uncertain command remains a reconciliation path and never retries Apply", async () => {
    const reconcile = jest.fn(async () => ({ status: "WAITING" as const, commandId: "road-uncertain", observedMatch: false, reason: "still reconciling" }));
    const boundary: Gate1WorldBoundary = {
      execute: jest.fn(async () => ({ status: "WAITING" as const, commandId: "road-uncertain", observedMatch: false, reason: "submitted command pending" })),
      reconcile,
    };
    const { runtime } = harness({ boundary });
    await runtime.tick();
    const submitted = await runtime.tick();
    expect(submitted.task).toMatchObject({ kind: "ROAD_CONNECTION", activeCommandId: "road-uncertain" });
    const observed = await runtime.tick();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((boundary.execute as jest.Mock).mock.calls).toHaveLength(1);
    expect(observed.task?.activeCommandId).toBe("road-uncertain");
  });

  test("Skill proposal cannot bypass Gate 1 Admission or Foundation Kernel boundary", async () => {
    const road = { execute: jest.fn() };
    const zoning = { execute: jest.fn(), reconcile: jest.fn() };
    const boundary = createGate1FoundationBoundary({ road, zoning } as never, {
      road: jest.fn(),
      zoning: jest.fn(),
    });
    const result = await boundary.execute({ operation: "BUILD_ROAD" } as Gate1AdmittedProposal);
    expect(result.status).toBe("REJECTED");
    expect(road.execute).not.toHaveBeenCalled();
    expect(zoning.execute).not.toHaveBeenCalled();
  });

  test("successful delivery advances delivery_progress but not effect_progress", async () => {
    const { runtime } = harness();
    await runtime.tick();
    const result = await runtime.tick();
    expect(result.state.tranche.delivery_progress).toMatchObject({ completed: 2, ratio: 0.5 });
    expect(result.state.tranche.effect_progress).toMatchObject({ status: "NOT_OBSERVED", actualResidents: null });
  });

  test("empty tranche can zone before a building consumer exists", async () => {
    const { runtime, calls } = harness();
    await runtime.tick();
    await runtime.tick();
    const zoned = await runtime.tick(observation(runtime.snapshot()));
    expect(zoned.task?.kind).toBe("ZONING");
    expect(zoned.state.tranche.stage).toBe("ZONED_WAITING_FOR_BUILDING");
    expect(zoned.state.tranche.delivery_progress).toMatchObject({ completed: 3, ratio: 0.75 });
    expect(zoned.state.tranche.effect_progress).toMatchObject({ status: "WAITING", actualResidents: null });
    expect(calls.map((proposal) => proposal.operation)).toEqual(["BUILD_ROAD", "ZONE_RESIDENTIAL"]);
  });

  test("zoning is not blocked by absent scoped utility certification", async () => {
    const storage = createMemoryGate1StateStorage();
    const runtime = createGate1VerticalSlice({
      storage,
      initial: initial(),
      boundary: { execute: async (proposal) => ({ status: "DELIVERED", commandId: `command:${proposal.id}`, observedMatch: true, reason: "fixture" }) },
      now: () => instant,
    });
    await runtime.tick();
    await runtime.tick();
    const zoned = await runtime.tick(observation(runtime.snapshot()));
    expect(zoned.state.tranche.stage).toBe("ZONED_WAITING_FOR_BUILDING");
    expect(zoned.task?.kind).toBe("ZONING");
    expect(zoned.proposal?.operation).toBe("ZONE_RESIDENTIAL");
  });

  test("zoning frontage uncertainty remains a planner signal and does not wait before Apply", async () => {
    const { runtime, calls } = harness();
    await runtime.tick();
    await runtime.tick();
    const zoned = await runtime.tick(observation(runtime.snapshot(), {
      productiveFrontage: { value: "UNKNOWN", provenance: "OBSERVED" },
      utilities: { ...observation(runtime.snapshot()).utilities, value: "UNKNOWN", evidenceKind: "UNKNOWN", provenance: "UNKNOWN" },
    }));
    expect(zoned.task?.kind).toBe("ZONING");
    expect(calls.map((proposal) => proposal.operation)).toEqual(["BUILD_ROAD", "ZONE_RESIDENTIAL"]);
  });

  test("restores poisoned zoning wait counters once without replacing the logical task", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tasks[0].status = "SUCCEEDED";
    state.tasks[0].attempts = 1;
    state.tasks[1].status = "SUCCEEDED";
    state.tasks[1].attempts = 1;
    state.tranche.stage = "ROAD_DELIVERED";
    state.tranche.delivery_progress = { completed: 2, total: 4, ratio: 0.5, lastOutcomeId: "road:delivered" };
    const zoning = state.tasks.find((task) => task.kind === "ZONING")!;
    zoning.attempts = 447;
    state.journal = Array.from({ length: 447 }, (_, index) => ({
      id: `${zoning.id}:outcome:${index + 1}`,
      taskId: zoning.id,
      skill: "Zoning" as const,
      proposalId: `${zoning.id}:attempt:${index + 1}`,
      recordedAt: instant.toISOString(),
      admission: "ADMITTED" as const,
      execution: "NOT_REQUIRED" as const,
      commandId: null,
      observationId: `observation:${index + 1}`,
      observedEffect: "UNKNOWN" as const,
      failureClassification: "OBSERVATION_UNKNOWN" as const,
      reason: "post-road authoritative productive-frontage observation is required before zoning",
    }));
    const storage = createMemoryGate1StateStorage(state);
    const restored = createGate1VerticalSlice({ storage, boundary: { execute: jest.fn() }, now: () => instant });
    const snapshot = restored.snapshot();
    expect(snapshot.tasks.filter((task) => task.kind === "ZONING")).toHaveLength(1);
    expect(snapshot.tasks.find((task) => task.kind === "ZONING")).toMatchObject({
      id: zoning.id,
      status: "PENDING",
      attempts: 0,
    });
    expect(snapshot.tranche.executionRecoveryMarkers).toContain("ZONING_PREREQUISITE_WAIT_ATTEMPT_ACCOUNTING");
    expect(snapshot.journal.at(-1)?.reason).toContain("447 non-execution attempts");

    const restoredAgain = createGate1VerticalSlice({ storage, boundary: { execute: jest.fn() }, now: () => instant });
    expect(restoredAgain.snapshot().journal).toHaveLength(snapshot.journal.length);
  });

  test("pre-zoning serviceability cannot satisfy actual consumer service", async () => {
    const { runtime } = harness();
    await runtime.tick();
    await runtime.tick();
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const result = await runtime.tick(
      observation(runtime.snapshot(), {
        utilities: {
          value: "PASS",
          provenance: "DERIVED",
          evidenceKind: "PRE_ZONING_SERVICEABILITY",
          buildingRefs: [],
        },
      }),
    );
    expect(result.state.tranche.stage).toBe("BUILDING_OBSERVED");
    expect(result.state.project.status).toBe("BLOCKED");
    expect(result.outcome?.failureClassification).toBe("OBSERVATION_UNKNOWN");
  });

  test.each([
    ["global surplus", "ESTIMATED" as const],
    ["road proximity", "PLANNED_RESERVED" as const],
  ])("%s cannot satisfy local utility evidence", async (_label, provenance) => {
    const { runtime } = harness();
    await runtime.tick();
    await runtime.tick();
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const result = await runtime.tick(
      observation(runtime.snapshot(), {
        utilities: { value: "PASS", provenance, evidenceKind: "UNKNOWN", buildingRefs: [] },
      }),
    );
    expect(result.state.tranche.stage).toBe("BUILDING_OBSERVED");
    expect(result.outcome?.failureClassification).toBe("OBSERVATION_UNKNOWN");
  });

  // Facts the simulation produces on its own schedule. Each of them is named,
  // and each of them is a bounded wait — not the single terminal refusal the
  // gate used to emit for all of them at once.
  const boundedUtilityProvisionWaits: Array<[string, Partial<Gate1Observation>, string]> = [
    [
      "an UNKNOWN consumer-service read",
      {
        utilities: {
          value: "UNKNOWN",
          provenance: "OBSERVED",
          evidenceKind: "ACTUAL_CONSUMER_SERVICE",
          buildingRefs: [starterBuilding],
        },
      },
      "CONSUMER_SERVICE_UNKNOWN",
    ],
    [
      "a tranche with no attributed building yet",
      {
        residentialBuildings: { value: [], provenance: "OBSERVED" },
        actualResidents: { value: 0, provenance: "OBSERVED" },
        occupiedResidentialBuildings: { value: [], provenance: "OBSERVED" },
        access: { value: "UNKNOWN", provenance: "OBSERVED" },
        productiveFrontage: { value: "UNKNOWN", provenance: "OBSERVED" },
        utilities: {
          value: "UNKNOWN",
          provenance: "OBSERVED",
          evidenceKind: "ACTUAL_CONSUMER_SERVICE",
          buildingRefs: [],
        },
      },
      "NO_ATTRIBUTED_BUILDING",
    ],
    [
      "an UNKNOWN building-local access read",
      { access: { value: "UNKNOWN", provenance: "OBSERVED" } },
      "ACCESS_UNKNOWN",
    ],
  ];

  test.each(boundedUtilityProvisionWaits)(
    "%s keeps the Goal and its project alive on a bounded wait",
    async (_label, overrides, fact) => {
      const { runtime } = harness();
      await runtime.tick();
      await runtime.tick();
      await runtime.tick(observation(runtime.snapshot()));
      await runtime.tick(observation(runtime.snapshot()));
      const waiting = await runtime.tick(observation(runtime.snapshot(), overrides));
      expect(waiting.state.tranche.stage).toBe("BUILDING_OBSERVED");
      expect(waiting.state.project.status).toBe("ACTIVE");
      expect(waiting.task).toMatchObject({ kind: "UTILITY_PROVISION", status: "PENDING", attempts: 1 });
      expect(waiting.outcome?.failureClassification).toBe("NONE");
      expect(waiting.outcome?.reason).toBe(`UTILITY_PROVISION_PENDING:${fact}`);
      // The wait is bounded, and its end is DIAGNOSING rather than a success.
      const exhausted = await runtime.tick(observation(runtime.snapshot(), overrides));
      expect(exhausted.state.tranche.stage).toBe("DIAGNOSING");
      expect(exhausted.outcome?.failureClassification).toBe("BOUNDED_WAIT_EXHAUSTED");
      expect(exhausted.outcome?.reason).toBe(
        `UTILITY_PROVISION_PENDING:${fact}:bounded consumer-service wait exhausted`,
      );
    },
  );

  test("an authoritative consumer-service read still certifies the tranche", async () => {
    const { runtime } = harness();
    await runtime.tick();
    await runtime.tick();
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const certified = await runtime.tick(observation(runtime.snapshot()));
    expect(certified.state.tranche.stage).toBe("WAITING_FOR_OCCUPANCY");
    expect(certified.outcome?.failureClassification).toBe("NONE");
    expect(certified.state.tranche.effect_progress.attributedResidentialBuildings).toEqual([starterBuilding]);
  });

  test("occupied consumers plus served utilities satisfy UNKNOWN access and absorb the tranche", async () => {
    const { runtime } = harness();
    await runtime.tick();
    await runtime.tick();
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const certified = await runtime.tick(observation(runtime.snapshot(), {
      access: { value: "UNKNOWN", provenance: "OBSERVED" },
      actualResidents: { value: 1, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
    }));
    expect(certified.state.tranche.stage).toBe("WAITING_FOR_OCCUPANCY");
    expect(certified.outcome?.observedEffect).toBe("NOT_APPLICABLE");
    const absorbed = await runtime.tick(observation(runtime.snapshot(), {
      access: { value: "UNKNOWN", provenance: "OBSERVED" },
      actualResidents: { value: 1, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
    }));
    expect(absorbed.state.tranche.stage).toBe("OCCUPIED");
    expect(absorbed.state.project.status).toBe("OCCUPIED");
    expect(absorbed.state.intent.status).toBe("SATISFIED");
  });

  test("a base utility Goal certifies its own utility and never enters the residential growth ladder", async () => {
    // The live defect (2026-09-30): a sewage Goal placed its outfall, then its
    // tranche zoned, and leaving `ROAD_DELIVERED` closed the only stage
    // `buildUtilityPreparationInput` admits supply-side utility execution at —
    // so the connection could never be admitted again and the Goal ended at
    // `ZONED_WAITING_FOR_BUILDING` reporting "no attributed building yet" about
    // land a sewage Goal was never waiting on.
    const { runtime } = harness();
    // The Goal's kind is stated, not inferred from the milestone: a growth Goal
    // is complete at WAITING_FOR_OCCUPANCY too now, so the stage alone no longer
    // says which ladder this tranche runs.
    const utilityGoal = { goalCompletionStage: "WAITING_FOR_OCCUPANCY" as const, servesBaseUtilityGoal: true };
    await runtime.tick(undefined, undefined, utilityGoal);
    await runtime.tick(undefined, undefined, utilityGoal);
    const certified = await runtime.tick(observation(runtime.snapshot()), undefined, utilityGoal);

    // The Goal's own utility is what closed the tranche, one tick after the
    // road was delivered — no zoning, no building wait, no occupancy ladder.
    expect(certified.state.tranche.stage).toBe("WAITING_FOR_OCCUPANCY");
    expect(certified.task).toMatchObject({ kind: "UTILITY_PROVISION" });
    expect(certified.outcome?.observedEffect).toBe("UTILITY_DELIVERED");
    expect(certified.state.tasks.find((entry) => entry.kind === "ZONING")?.status).toBe("PENDING");
    expect(certified.state.tasks.find((entry) => entry.kind === "WAIT_FOR_BUILDING")?.status).toBe("PENDING");
  });

  test("a base utility Goal waits at ROAD_DELIVERED for its own utility instead of diagnosing occupancy", async () => {
    // The wait is not this task failing: the connection is made by the
    // production utility execution on its own schedule. Moving the tranche on
    // would close the admission gate, and diagnosing an unabsorbed tranche
    // would answer an occupancy question a utility Goal never asked.
    const state = planStarterResidentialIntent(initial(), instant);
    state.tranche.stage = "ROAD_DELIVERED";
    const utility = createDurableGreenfieldUtilityState({
      intentId: state.intent.id, projectId: state.project.id, trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef, worldId: "world", worldEpochId: "epoch",
      generation: "generation", topologyRevision: "topology", certifiedRoadRefs: [{ index: 1, version: 1 }],
      targetServiceEntry: { road: { index: 1, version: 1 }, position: state.tranche.target.center },
      spatialEnvelope: state.project.utilityReservation, maximumSpend: 1, treasury: 1, treasurySafetyReserve: 0,
    });
    utility.utilities.sewage.stage = "PLACED";
    state.tranche.utilityExecution = utility;
    const storage = createMemoryGate1StateStorage(state);
    const { runtime } = harness({ storage });
    // The Goal's kind is stated, not inferred from the milestone: a growth Goal
    // is complete at WAITING_FOR_OCCUPANCY too now, so the stage alone no longer
    // says which ladder this tranche runs.
    const utilityGoal = { goalCompletionStage: "WAITING_FOR_OCCUPANCY" as const, servesBaseUtilityGoal: true };
    // The world has not answered yet: no building is attributed to this tranche,
    // so there is no consumer service to certify and the wait is real.
    const waiting = () => observation(runtime.snapshot(), {
      residentialBuildings: { value: [], provenance: "OBSERVED" },
      actualResidents: { value: 0, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [], provenance: "OBSERVED" },
      access: { value: "UNKNOWN", provenance: "OBSERVED" },
      productiveFrontage: { value: "UNKNOWN", provenance: "OBSERVED" },
      utilities: { value: "UNKNOWN", provenance: "OBSERVED",
        evidenceKind: "ACTUAL_CONSUMER_SERVICE", buildingRefs: [] },
    });

    // Four waits against a task budget of two: it neither diagnoses nor moves.
    let waited = await runtime.tick(waiting(), undefined, utilityGoal);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(waited.task).toMatchObject({ kind: "UTILITY_PROVISION", status: "PENDING" });
      expect(waited.outcome?.observedEffect).toBe("UNKNOWN");
      waited = await runtime.tick(waiting(), undefined, utilityGoal);
    }
    expect(waited.state.tranche.stage).toBe("ROAD_DELIVERED");
    expect(waited.state.tranche.effect_progress.status).not.toBe("DIAGNOSING");
    expect(waited.state.tasks.some((entry) => entry.kind === "OCCUPANCY_DIAGNOSIS")).toBe(false);
    expect(waited.state.tasks.find((entry) => entry.kind === "ZONING")?.status).toBe("PENDING");
    expect(waited.state.project.status).toBe("ACTIVE");
  });

  test("serviceability alone cannot mark a tranche occupied", async () => {
    const { runtime } = harness();
    await runtime.tick();
    await runtime.tick();
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const result = await runtime.tick(
      observation(runtime.snapshot(), {
        utilities: {
          value: "PASS",
          provenance: "DERIVED",
          evidenceKind: "PRE_ZONING_SERVICEABILITY",
          buildingRefs: [],
        },
        actualResidents: { value: 4, provenance: "OBSERVED" },
        occupiedResidentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
      }),
    );
    expect(result.state.tranche.stage).not.toBe("OCCUPIED");
    expect(result.state.intent.status).not.toBe("SATISFIED");
  });

  test("definite ROAD rejection permits exactly one in-scope bounded fallback", async () => {
    const proposals: Gate1AdmittedProposal[] = [];
    const boundary = {
      execute: jest.fn(async (proposal: Gate1AdmittedProposal) => {
        proposals.push(proposal);
        return proposal.methodVariant === "PRIMARY"
          ? { status: "REJECTED" as const, commandId: "road-primary", observedMatch: false, reason: "native rejected" }
          : {
              status: "DELIVERED" as const,
              commandId: "road-fallback",
              observedMatch: false,
              reason: "fallback delivered",
            };
      }),
    };
    const { runtime } = harness({ boundary });
    await runtime.tick();
    const primary = await runtime.tick();
    expect(primary.state.tranche.stage).toBe("SITE_SELECTED");
    expect(primary.task).toMatchObject({ status: "PENDING", attempts: 1 });
    const fallback = await runtime.tick();
    expect(fallback.state.tranche.stage).toBe("ROAD_DELIVERED");
    expect(proposals.map((proposal) => proposal.methodVariant)).toEqual(["PRIMARY", "BOUNDED_FALLBACK"]);
    expect(proposals.every((proposal) => proposal.target.center.x === fallback.state.tranche.target.center.x)).toBe(
      true,
    );
  });

  /**
   * The Road step replays the bounded search that admitted the tranche and
   * matches the persisted site target. When that replay can no longer produce
   * the target there is no candidate to preflight and no second candidate to
   * fall back to. Left to propagate, the exception ended the whole progression
   * and left a tranche the durable state could not resolve, so its Goal never
   * closed and the Brain had nothing to re-plan from.
   */
  test("an unreproducible site target closes the ROAD task durably instead of escaping", async () => {
    const storage = createMemoryGate1StateStorage();
    const { runtime } = harness({
      storage,
      boundary: {
        execute: jest.fn(),
        preflightRoad: jest.fn(async () => {
          throw new Gate1BoundedRoadSiteDeadEndError("GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED");
        }),
      },
    });
    await runtime.tick();
    const result = await runtime.tick(observation(runtime.snapshot()));

    expect(result.task).toMatchObject({ kind: "ROAD_CONNECTION", status: "BLOCKED" });
    expect(result.outcome).toMatchObject({
      failureClassification: "ROAD_SITE_TARGET_NOT_REPRODUCED",
      commandId: null,
      execution: "NOT_REQUIRED",
      reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED",
    });
    expect(result.state.project.status).toBe("BLOCKED");
    expect(result.state.intent.status).toBe("BLOCKED");
    // Terminal on the first refusal, and durable, so the Goal can close and a
    // successor can be admitted from current facts.
    const persisted = storage.load() as Gate1State;
    expect(persisted.tasks.find((task) => task.kind === "ROAD_CONNECTION")?.terminalOutcomeId)
      .toBe(result.outcome?.id);
  });

  test("a Road failure that is not the bounded dead end still propagates", async () => {
    const { runtime } = harness({
      boundary: {
        execute: jest.fn(),
        preflightRoad: jest.fn(async () => { throw new Error("ROAD_PREFLIGHT_TRANSPORT_UNKNOWN"); }),
      },
    });
    await runtime.tick();
    await expect(runtime.tick(observation(runtime.snapshot())))
      .rejects.toThrow("ROAD_PREFLIGHT_TRANSPORT_UNKNOWN");
    expect(runtime.snapshot().project.status).toBe("ACTIVE");
  });

  test("a zoning reservation with no bounded cell set closes the ZONING task durably instead of escaping", async () => {
    const storage = createMemoryGate1StateStorage();
    const { runtime, calls } = harness({
      storage,
      boundary: {
        execute: jest.fn(async (proposal: Gate1AdmittedProposal) => {
          calls.push(proposal);
          if (proposal.actionFamily === "ZONING") throw new Gate1BoundedZoningDeadEndError("RESIDENTIAL");
          return {
            status: "DELIVERED" as const,
            commandId: `command:${proposal.id}`,
            observedMatch: false,
            reason: "foundation kernel completed",
          };
        }),
      },
    });
    await runtime.tick();
    await runtime.tick();
    const result = await runtime.tick(observation(runtime.snapshot()));

    // The tranche keeps the Road it actually delivered; what changes is that the
    // ZONING step is now a recorded, terminal outcome of THIS task.
    expect(result.state.tranche.stage).toBe("ROAD_DELIVERED");
    expect(result.task).toMatchObject({ kind: "ZONING", status: "BLOCKED" });
    expect(result.outcome).toMatchObject({
      failureClassification: "ZONING_RESERVATION_DEAD_END",
      commandId: null,
      execution: "NOT_REQUIRED",
      reason: "GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
    });
    expect(result.state.project.status).toBe("BLOCKED");
    expect(result.state.intent.status).toBe("BLOCKED");

    // Terminal on the first refusal: no native command exists, nothing is in
    // flight, and re-running the same bounded search cannot answer differently.
    const zoning = result.state.tasks.find((task) => task.kind === "ZONING")!;
    expect(zoning.terminalOutcomeId).toBe(result.outcome?.id);
    expect(zoning.attempts).toBe(1);
    expect(result.state.journal.filter((entry) => entry.taskId === zoning.id)).toHaveLength(1);

    // Durable, so the successor is derived from a fact and not from a throw.
    const persisted = storage.load() as Gate1State;
    expect(persisted.project.status).toBe("BLOCKED");
    expect(persisted.tasks.find((task) => task.kind === "ZONING")?.terminalOutcomeId).toBe(result.outcome?.id);
  });

  test("only the typed bounded zoning dead end is absorbed; other zoning failures still propagate", async () => {
    const { runtime } = harness({
      boundary: {
        execute: jest.fn(async (proposal: Gate1AdmittedProposal) => {
          if (proposal.actionFamily === "ZONING") throw new Error("ZONING_NATIVE_EFFECT_UNKNOWN");
          return { status: "DELIVERED" as const, commandId: `command:${proposal.id}`, observedMatch: false, reason: "built" };
        }),
      },
    });
    await runtime.tick();
    await runtime.tick();
    await expect(runtime.tick(observation(runtime.snapshot()))).rejects.toThrow("ZONING_NATIVE_EFFECT_UNKNOWN");
    expect(runtime.snapshot().project.status).toBe("ACTIVE");
  });

  test("exact zoning, attributed building, and actual consumer service enter WAITING_FOR_OCCUPANCY", async () => {
    const { runtime, calls } = harness();
    const result = await driveToWaiting(runtime);
    expect(result.state.tranche.stage).toBe("WAITING_FOR_OCCUPANCY");
    expect(result.state.tranche.delivery_progress).toMatchObject({ completed: 4, ratio: 1 });
    expect(result.state.tranche.effect_progress.status).toBe("WAITING");
    expect(calls.map((proposal) => proposal.operation)).toEqual(["BUILD_ROAD", "ZONE_RESIDENTIAL"]);
  });

  test("observed occupied residential building and actual residents advance effect to OCCUPIED", async () => {
    const { runtime } = harness();
    await driveToWaiting(runtime);
    const result = await runtime.tick(
      observation(runtime.snapshot(), {
        actualResidents: { value: 3, provenance: "OBSERVED" },
        occupiedResidentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
      }),
    );
    expect(result.state.tranche.stage).toBe("OCCUPIED");
    expect(result.state.tranche.effect_progress).toMatchObject({ status: "OCCUPIED", actualResidents: 3 });
    expect(result.state.intent.status).toBe("SATISFIED");
    expect(result.state.project.status).toBe("OCCUPIED");
  });

  test("known zero occupancy after bounded waits enters DIAGNOSING", async () => {
    const { runtime } = harness();
    await driveToWaiting(runtime);
    await runtime.tick(observation(runtime.snapshot()));
    const result = await runtime.tick(observation(runtime.snapshot()));
    expect(result.state.tranche.stage).toBe("DIAGNOSING");
    expect(result.state.tranche.effect_progress).toMatchObject({ status: "DIAGNOSING", boundedWaitsCompleted: 2 });
    expect(result.outcome?.failureClassification).toBe("BOUNDED_WAIT_EXHAUSTED");
  });

  test("bounded recovery runs only through a boundary that declares one, and recertifies consumer service", async () => {
    const recoveries: Gate1AdmittedProposal[] = [];
    const { runtime } = harness({
      boundary: {
        execute: jest.fn(async (proposal: Gate1AdmittedProposal) => ({
          status: "DELIVERED" as const,
          commandId: `command:${proposal.id}`,
          observedMatch: proposal.actionFamily === "ZONING",
          reason: "foundation kernel completed",
        })),
        recover: jest.fn(async (proposal: Gate1AdmittedProposal) => {
          recoveries.push(proposal);
          return {
            status: "DELIVERED" as const,
            commandId: `recovery:${proposal.id}`,
            observedMatch: true,
            reason: "bounded recovery completed",
          };
        }),
      },
    });
    await driveToWaiting(runtime);
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const diagnosed = await runtime.tick(observation(runtime.snapshot(), { diagnosis: "ACCESS_FAILURE" }));
    expect(diagnosed.state.tranche.stage).toBe("RECOVERING");
    const recovered = await runtime.tick(observation(runtime.snapshot(), { diagnosis: "ACCESS_FAILURE" }));
    expect(recovered.state.tranche).toMatchObject({ stage: "BUILDING_OBSERVED", recoveryAttempts: 1 });
    const proposal = recoveries.at(-1);
    expect(proposal).toBeDefined();
    if (!proposal) throw new Error("recovery proposal missing");
    expect(proposal.operation).toBe("RECOVER");
    expect(proposal.target).toEqual(recovered.state.tranche.target);
    expect(proposal.reservationRef).toBe(recovered.state.tranche.reservationRef);
    expect(recovered.state.project.id).toBe(`${initial().intentId}:project:starter-residential`);
    const recertified = await runtime.tick(observation(runtime.snapshot()));
    expect(recertified.state.tranche.stage).toBe("WAITING_FOR_OCCUPANCY");
  });

  test.each([
    // Each diagnosis still names what it saw, and the name is still journaled —
    // but it is TELEMETRY now, not a terminal. The tranche's deliverable is its
    // delivered frontage and its rezoned land; whether anybody has moved in, and
    // whether the utilities have reached them yet, is the simulation's own
    // schedule and cannot be the reason a city stops building.
    ["ACCESS_FAILURE", "OCCUPANCY_ACCESS_UNRESOLVED"],
    ["UTILITY_FAILURE", "OCCUPANCY_UTILITY_UNRESOLVED"],
    ["ZONING_OR_DEMAND_DELAY", "OCCUPANCY_DEMAND_DELAY"],
  ] as const)(
    "%s is journaled as the Goal's own named telemetry, and does not close the tranche",
    async (diagnosis, classification) => {
      const { runtime } = harness();
      await driveToWaiting(runtime);
      await runtime.tick(observation(runtime.snapshot()));
      await runtime.tick(observation(runtime.snapshot()));
      const diagnosed = await runtime.tick(observation(runtime.snapshot(), { diagnosis }));
      expect(diagnosed.outcome?.failureClassification).toBe(classification);
      expect(diagnosed.outcome?.reason).toContain(`OCCUPANCY_UNRESOLVED:${diagnosis}`);
      expect(diagnosed.outcome?.reason).toContain("recorded as telemetry");
      // Telemetry cannot block: the Goal closes on its own deliverable.
      expect(diagnosed.state.project.status).not.toBe("BLOCKED");
      // Nothing was dispatched to a repair, because there is none to dispatch to.
      expect(runtime.snapshot().tasks.some((task) => task.kind === "RECOVERY")).toBe(false);
    },
  );

  /**
   * A diagnosis is a claim about this tranche's OWN buildings, so it may only be
   * drawn from facts that resolved. `ZONING_OR_DEMAND_DELAY` says the land is
   * fine and nobody moved in; reading it off a consumer-service read that came
   * back UNKNOWN would be passing UNKNOWN off as PASS.
   *
   * Refusing the diagnosis is still right. What changed is what the refusal
   * DOES: it is recorded as telemetry and the tranche closes on its own
   * deliverable, instead of the unknown read closing the Goal and stalling every
   * later expansion.
   */
  test("a diagnosis is refused while a fact it speaks about is incoherent", async () => {
    const { runtime } = harness();
    await driveToWaiting(runtime);
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const diagnosed = await runtime.tick(observation(runtime.snapshot(), {
      diagnosis: undefined,
      factCoherence: { access: "STABLE_FRAME", utilities: "UNKNOWN", incoherentRefs: ["utility:7:1"] },
    }));
    expect(diagnosed.outcome?.failureClassification).toBe("OBSERVATION_UNKNOWN");
    expect(diagnosed.outcome?.reason).toContain("occupancy diagnosis recorded as telemetry");
    expect(diagnosed.state.project.status).not.toBe("BLOCKED");
  });

  test("fresh in-scope occupancy discovered at diagnosis completes when the earlier attribution set is empty", async () => {
    const { runtime, storage, boundary } = harness();
    await driveToWaiting(runtime);
    await runtime.tick(observation(runtime.snapshot()));
    await runtime.tick(observation(runtime.snapshot()));
    const stateAfterEmptyWait = runtime.snapshot();
    // The live failure had already exhausted the bounded wait while the
    // building was absent. A later fresh diagnosis must accept the current
    // in-scope native building without requiring a stale, pre-wait ID list.
    stateAfterEmptyWait.tranche.effect_progress.attributedResidentialBuildings = [];
    storage.save(stateAfterEmptyWait);
    const resumed = createGate1VerticalSlice({ storage, boundary, now: () => instant });
    const diagnosed = await resumed.tick(observation(resumed.snapshot(), {
      diagnosis: "ZONING_OR_DEMAND_DELAY",
      residentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
      actualResidents: { value: 1, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [starterBuilding], provenance: "OBSERVED" },
    }));
    expect(diagnosed.state.tranche.stage).toBe("OCCUPIED");
    expect(diagnosed.state.project.status).toBe("OCCUPIED");
    expect(diagnosed.state.intent.status).toBe("SATISFIED");
    expect(diagnosed.outcome?.observedEffect).toBe("OCCUPIED");
    expect(diagnosed.outcome?.reason).toBe("actual tranche residents observed during diagnosis");
    expect(diagnosed.state.tranche.effect_progress.attributedResidentialBuildings).toEqual([starterBuilding]);
  });

  test("UNKNOWN occupancy observation waits without terminally blocking the project", async () => {
    const { runtime } = harness();
    await driveToWaiting(runtime);
    const before = runtime.snapshot();
    const result = await runtime.tick(
      observation(before, {
        coherence: "UNKNOWN",
        residentialBuildings: { value: null, provenance: "OBSERVED" },
        actualResidents: { value: null, provenance: "OBSERVED" },
        occupiedResidentialBuildings: { value: null, provenance: "OBSERVED" },
      }),
    );
    expect(result.state.tranche.stage).toBe("WAITING_FOR_OCCUPANCY");
    expect(result.state.tranche.effect_progress.boundedWaitsCompleted).toBe(
      before.tranche.effect_progress.boundedWaitsCompleted + 1,
    );
    expect(result.state.project.status).not.toBe("BLOCKED");
    expect(result.outcome?.execution).toBe("WAITING");
    expect(result.outcome?.failureClassification).toBe("NONE");
  });

  test("terminal task is durably restored and not blindly replayed", async () => {
    const storage = createMemoryGate1StateStorage();
    const first = harness({ storage });
    await first.runtime.tick();
    expect(first.runtime.snapshot().tasks[0].status).toBe("SUCCEEDED");
    const secondBoundary = {
      execute: jest.fn(async () => ({
        status: "DELIVERED" as const,
        commandId: "road-after-restart",
        observedMatch: false,
        reason: "road delivered",
      })),
    };
    const restored = createGate1VerticalSlice({ storage, boundary: secondBoundary, now: () => instant });
    const result = await restored.tick();
    expect(result.task?.kind).toBe("ROAD_CONNECTION");
    expect(result.task?.kind).not.toBe("SITE_SELECTION");
    expect(secondBoundary.execute).toHaveBeenCalledTimes(1);
  });

  test("restores a pre-submit endpoint epoch rejection as the existing retryable RoadConnection task", async () => {
    const storage = createMemoryGate1StateStorage();
    const first = harness({
      storage,
      boundary: {
        execute: jest.fn(async () => ({
          status: "UNKNOWN" as const,
          commandId: null,
          observedMatch: false,
          reason: "ROAD_ENDPOINT_WORLD_EPOCH_MISMATCH",
        })),
      },
    });
    await first.runtime.tick();
    const rejected = await first.runtime.tick();
    expect(rejected.state.tasks[1]).toMatchObject({ status: "BLOCKED", attempts: 1 });

    const execute = jest.fn(async () => ({
      status: "DELIVERED" as const,
      commandId: "road-after-epoch-fix",
      observedMatch: false,
      reason: "road delivered",
    }));
    const restored = createGate1VerticalSlice({ storage, boundary: { execute }, now: () => instant });
    const snapshot = restored.snapshot();
    expect(snapshot.project.status).toBe("ACTIVE");
    expect(snapshot.tasks.filter((task) => task.kind === "ROAD_CONNECTION")).toHaveLength(1);
    expect(snapshot.tasks[1]).toMatchObject({ status: "PENDING", attempts: 1, terminalOutcomeId: null });
    expect(snapshot.journal.find((entry) => entry.reason === "ROAD_ENDPOINT_WORLD_EPOCH_MISMATCH")).toMatchObject({
      failureClassification: "EXECUTION_UNKNOWN",
      commandId: null,
      reason: "ROAD_ENDPOINT_WORLD_EPOCH_MISMATCH",
    });
    const retried = await restored.tick();
    expect(retried.task).toMatchObject({ kind: "ROAD_CONNECTION", status: "SUCCEEDED", attempts: 2 });
    expect(retried.proposal?.methodVariant).toBe("BOUNDED_FALLBACK");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("reopens the same Road task once after a confirmed pre-Apply quote-correlation failure", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tasks[0].status = "SUCCEEDED";
    state.tranche.stage = "SITE_SELECTED";
    const road = state.tasks[1];
    road.status = "BLOCKED";
    road.attempts = 1;
    road.maximumAttempts = 2;
    road.terminalOutcomeId = `${road.id}:outcome:quote-failure`;
    state.project.status = "BLOCKED";
    state.intent.status = "BLOCKED";
    state.journal.push({
      id: road.terminalOutcomeId,
      taskId: road.id,
      skill: "RoadConnection",
      proposalId: `${road.id}:attempt:1`,
      admission: "ADMITTED",
      execution: "UNKNOWN",
      commandId: null,
      observationId: "quote-observation",
      observedEffect: "UNKNOWN",
      failureClassification: "EXECUTION_UNKNOWN",
      recordedAt: instant.toISOString(),
      roadPreApplyFailure: {
        schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1",
        phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
        taskId: road.id,
        childId: null,
        exactInput: { prefab: "Medium Road", x1: 0, z1: 0, x2: 16, z2: 0 },
        firstFailedQuoteRequirement: "VALID_TRUE",
        previewOnly: true,
        applyCalled: false,
      },
      reason: "native ROAD preview did not return a correlated authoritative quote [ROAD_QUOTE_DIAGNOSTICS={...}]",
    });
    const storage = createMemoryGate1StateStorage(state);
    const commands = createMemoryCommandJournal();
    const recovered = createGate1VerticalSlice({ storage, boundary: { execute: jest.fn() }, commandJournal: commands, now: () => instant });
    const snapshot = recovered.snapshot();
    expect(snapshot.project.status).toBe("ACTIVE");
    expect(snapshot.intent.status).toBe("ACTIVE");
    expect(snapshot.tasks[1]).toMatchObject({ id: road.id, status: "PENDING", attempts: 1, maximumAttempts: 2, terminalOutcomeId: null });
    expect(snapshot.journal.find((entry) => entry.id === road.terminalOutcomeId)?.reason)
      .toContain("native ROAD preview did not return a correlated authoritative quote [ROAD_QUOTE_DIAGNOSTICS=");
    expect(snapshot.tranche.executionRecoveryMarkers).toContain("ROAD_PRE_APPLY_QUOTE_CORRELATION_FAILURE");

    const restoredAgain = createGate1VerticalSlice({ storage, boundary: { execute: jest.fn() }, commandJournal: commands, now: () => instant });
    expect(restoredAgain.snapshot().journal.filter((entry) => entry.reason.includes("one-shot recovery reopened the same RoadConnection task"))).toHaveLength(1);
    expect(restoredAgain.snapshot().tasks[1]).toMatchObject({ id: road.id, status: "PENDING", attempts: 1, maximumAttempts: 2 });
  });

  test("does not recover quote-correlation failure when dispatch budget is exhausted or a command is unresolved", () => {
    const blockedQuoteState = (attempts: number) => {
      const state = planStarterResidentialIntent(initial(), instant);
      state.tasks[0].status = "SUCCEEDED";
      state.tranche.stage = "SITE_SELECTED";
      const road = state.tasks[1];
      road.status = "BLOCKED";
      road.attempts = attempts;
      road.maximumAttempts = 2;
      road.terminalOutcomeId = `${road.id}:outcome:quote-failure`;
      state.project.status = "BLOCKED";
      state.intent.status = "BLOCKED";
      state.journal.push({
        id: road.terminalOutcomeId,
        taskId: road.id,
        skill: "RoadConnection",
        proposalId: `${road.id}:attempt:${attempts}`,
        admission: "ADMITTED",
        execution: "UNKNOWN",
        commandId: null,
        observationId: null,
        observedEffect: "UNKNOWN",
        failureClassification: "EXECUTION_UNKNOWN",
        recordedAt: instant.toISOString(),
        reason: "native ROAD preview did not return a correlated authoritative quote",
      });
      return state;
    };
    const exhausted = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(blockedQuoteState(2)), boundary: { execute: jest.fn() },
      commandJournal: createMemoryCommandJournal(), now: () => instant,
    }).snapshot();
    expect(exhausted.tasks[1]).toMatchObject({ status: "BLOCKED", attempts: 2, maximumAttempts: 2 });

    const state = blockedQuoteState(1);
    const road = state.tasks[1];
    const commands = createMemoryCommandJournal();
    commands.create({
      schemaVersion: "ai-mayor-v2-command/1", commandId: "unresolved-road-command", actionFamily: "ROAD", actionType: "build_road",
      authorizedScope: { owner: { ownerType: "TASK", ownerId: road.id }, actionFamily: "ROAD", proposalId: "p", quoteId: "q",
        fingerprint: "f", exactInput: "i", budget: { authorizedMaxSpend: 1, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        observationPrecondition: { runtimeEpoch: "epoch", frame: 1 }, expiresAt: instant.toISOString() },
      bridgeCommandId: "bridge-pending", createdAt: instant.toISOString(), submittedAt: instant.toISOString(), nativeResultSummary: null,
      status: "SUBMITTED", statusHistory: [], reconciliationStatus: "NOT_STARTED", observationEvidence: [],
      failureOrUnknownReason: null, effectAbsenceProven: false,
    });
    const held = createGate1VerticalSlice({
      storage: createMemoryGate1StateStorage(state), boundary: { execute: jest.fn() }, commandJournal: commands, now: () => instant,
    }).snapshot();
    expect(held.tasks[1]).toMatchObject({ status: "BLOCKED", attempts: 1, maximumAttempts: 2 });
  });

  test("does not reopen terminal or ambiguous ROAD failures on restore", async () => {
    for (const failure of [
      { reason: "transport timeout", commandId: null },
      { reason: "ROAD_ENDPOINT_WORLD_EPOCH_MISMATCH", commandId: "possibly-submitted-command" },
    ]) {
      const state = planStarterResidentialIntent(initial(), instant);
      state.tasks[0].status = "SUCCEEDED";
      state.tranche.stage = "SITE_SELECTED";
      state.tasks[1].status = "BLOCKED";
      state.tasks[1].attempts = 1;
      state.tasks[1].terminalOutcomeId = `${state.tasks[1].id}:outcome:terminal`;
      state.project.status = "BLOCKED";
      state.intent.status = "BLOCKED";
      state.journal.push({
        id: state.tasks[1].terminalOutcomeId,
        taskId: state.tasks[1].id,
        skill: "RoadConnection",
        proposalId: `${state.tasks[1].id}:attempt:1`,
        admission: "ADMITTED",
        execution: "UNKNOWN",
        commandId: failure.commandId,
        observationId: null,
        observedEffect: "UNKNOWN",
        failureClassification: "EXECUTION_UNKNOWN",
        recordedAt: instant.toISOString(),
        reason: failure.reason,
      });
      const restored = createGate1VerticalSlice({
        storage: createMemoryGate1StateStorage(state),
        boundary: { execute: jest.fn() },
        now: () => instant,
      }).snapshot();
      expect(restored.project.status).toBe("BLOCKED");
      expect(restored.tasks[1].status).toBe("BLOCKED");
    }
  });

  test("reopens the same task once after a confirmed pre-submit proposal construction failure", async () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tasks[0].status = "SUCCEEDED";
    state.tranche.stage = "SITE_SELECTED";
    state.tasks[1].status = "BLOCKED";
    state.tasks[1].attempts = 3;
    state.tasks[1].terminalOutcomeId = `${state.tasks[1].id}:outcome:latest`;
    state.project.status = "BLOCKED";
    state.intent.status = "BLOCKED";
    state.tranche.executionRecoveryMarkers = ["ROAD_ENDPOINT_GENERATION_SEMANTICS_MISMATCH"];
    state.journal.push({
      id: `${state.tasks[1].id}:outcome:latest`,
      taskId: state.tasks[1].id,
      skill: "RoadConnection",
      proposalId: `${state.tasks[1].id}:attempt:3`,
      admission: "ADMITTED",
      execution: "UNKNOWN",
      commandId: null,
      observationId: null,
      observedEffect: "UNKNOWN",
      failureClassification: "EXECUTION_UNKNOWN",
      recordedAt: instant.toISOString(),
      reason: "(0 , import_foundation.stableRoadInput) is not a function",
    });
    const storage = createMemoryGate1StateStorage(state);
    const restored = createGate1VerticalSlice({ storage, boundary: { execute: jest.fn() }, now: () => instant });
    expect(restored.snapshot().project.status).toBe("ACTIVE");
    expect(restored.snapshot().tasks[1]).toMatchObject({ status: "PENDING", attempts: 3 });
    expect(restored.snapshot().tranche.executionRecoveryMarkers).toEqual([
      "ROAD_ENDPOINT_GENERATION_SEMANTICS_MISMATCH",
      "ROAD_PROPOSAL_CONSTRUCTION_IMPORT_MISMATCH",
    ]);
  });

  test("Gate 1 project state persists through the Batch 5 world-bound durability coordinator", async () => {
    const durableStorage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(durableStorage, () => instant);
    const world = {
      gameMode: "Game",
      isLoading: false,
      cityLoaded: true,
      world: {
        identityStatus: "AVAILABLE",
        worldReady: true,
        worldId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nativeSessionGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loadPurpose: "LoadGame",
        loadAssetGuid: "meta-a",
        saveDataAssetGuid: "data-a",
        mapAssetGuid: "map-a",
        checkpointId: "save:meta-a:data-a",
        bridgeRuntimeEpoch: "bridge-a",
        generation: "generation-a",
        generationSequence: 1,
        generationOrigin: "LOAD_COMPLETED",
      },
    };
    coordinator.activate(world);
    const first = createGate1VerticalSlice({
      storage: createDurableGate1StateStorage(coordinator),
      initial: initial(),
      boundary: { execute: jest.fn() },
      now: () => instant,
    });
    await first.tick();

    const restartedCoordinator = new V2DurabilityCoordinator(durableStorage, () => instant);
    restartedCoordinator.activate({ ...world, world: { ...world.world, bridgeRuntimeEpoch: "bridge-b" } });
    const boundary = {
      execute: jest.fn(async () => ({
        status: "DELIVERED" as const,
        commandId: "road-restored",
        observedMatch: false,
        reason: "done",
      })),
    };
    const restored = createGate1VerticalSlice({
      storage: createDurableGate1StateStorage(restartedCoordinator),
      boundary,
      now: () => instant,
    });
    expect(restored.snapshot().tasks[0]).toMatchObject({ kind: "SITE_SELECTION", status: "SUCCEEDED" });
    expect((await restored.tick()).task?.kind).toBe("ROAD_CONNECTION");
    expect(boundary.execute).toHaveBeenCalledTimes(1);
  });

  test("Foundation boundary maps ROAD and exact observed zoning through existing kernels", async () => {
    const road = {
      execute: jest.fn(async () => ({
        command: {
          status: "COMMIT_ACK",
          commandId: "road-command",
          failureOrUnknownReason: null,
          nativeResultSummary: "road built",
        },
      })),
      reconcile: jest.fn(),
    };
    const zoning = {
      execute: jest.fn(async () => ({
        command: { status: "OBSERVED_MATCH", commandId: "zone-command", failureOrUnknownReason: null },
        effectReport: { matcherResult: "MATCH", reason: "exact cells matched" },
      })),
      reconcile: jest.fn(),
    };
    const resolvers = {
      road: jest.fn(async () => ({ request: "road" })),
      zoning: jest.fn(async () => ({ intent: { intent: "zone" }, baseline: { observationId: "baseline" } })),
    };
    const boundary = createGate1FoundationBoundary({ road, zoning } as never, resolvers as never);
    const admitted = {
      admission: { decision: "ADMITTED", admittedAt: instant.toISOString(), scopeFingerprint: "scope" },
    } as Gate1AdmittedProposal;
    expect(await boundary.execute({ ...admitted, operation: "BUILD_ROAD" })).toMatchObject({
      status: "WAITING",
      commandId: "road-command",
    });
    expect(await boundary.execute({ ...admitted, operation: "ZONE_RESIDENTIAL" })).toMatchObject({
      status: "DELIVERED",
      commandId: "zone-command",
      observedMatch: true,
    });
    expect(road.execute).toHaveBeenCalledTimes(1);
    expect(zoning.execute).toHaveBeenCalledTimes(1);
  });

  test("records typed pre-Apply evidence only when the Road resolver rejects a preview", async () => {
    const exactInput = { prefab: "Small Road", x1: 0, z1: 0, x2: 10, z2: 0 };
    const road = { execute: jest.fn(), reconcile: jest.fn() };
    const quoteError = new RoadQuoteContractError({
      firstFailedQuoteRequirement: "VALID_TRUE", allEvaluatedFailedRequirements: ["VALID_TRUE"],
      predicateStatus: { VALID_TRUE: "FAIL" }, roadTaskId: "road-task", roadChildId: null, atomicOperationId: null,
      productionPreviewRequest: { prefab: exactInput.prefab, geometry: exactInput, stableInput: JSON.stringify(exactInput) },
      actual: { previewOnly: true, valid: false },
      failedComparison: { expected: true, actual: false },
    });
    const boundary = createGate1FoundationBoundary({ road, zoning: {} } as never, {
      road: jest.fn(async () => { throw quoteError; }),
    } as never);
    const result = await boundary.execute({
      taskId: "road-task", concreteChildOperation: undefined, operation: "BUILD_ROAD",
      admission: { decision: "ADMITTED", admittedAt: instant.toISOString(), scopeFingerprint: "scope" },
    } as unknown as Gate1AdmittedProposal, new AbortController().signal);

    expect(result).toMatchObject({ status: "UNKNOWN", commandId: null, roadPreApplyFailure: {
      schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1", taskId: "road-task", childId: null,
      exactInput, firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false,
    } });
    expect(road.execute).not.toHaveBeenCalled();
  });

  test("ROAD native completion waits on the same command and reconciliation consumes no new attempt", async () => {
    const boundary: Gate1WorldBoundary = {
      execute: jest.fn(async () => ({
        status: "WAITING",
        commandId: "road-command-waiting",
        observedMatch: false,
        reason: "native complete; topology observation pending",
      })),
      reconcile: jest.fn(async () => ({
        status: "DELIVERED",
        commandId: "road-command-waiting",
        observedMatch: true,
        reason: "authoritative road effect certified",
      })),
    };
    const { runtime } = harness({ boundary });
    await runtime.tick(observation(runtime.snapshot()));
    const submitted = await runtime.tick(observation(runtime.snapshot()));
    expect(submitted.state.tasks.find((task) => task.kind === "ROAD_CONNECTION")).toMatchObject({
      status: "WAITING",
      attempts: 1,
      activeCommandId: "road-command-waiting",
    });
    const reconciled = await runtime.tick(observation(runtime.snapshot()));
    expect(reconciled.state.tranche.stage).toBe("ROAD_DELIVERED");
    expect(reconciled.state.tasks.find((task) => task.kind === "ROAD_CONNECTION")).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      activeCommandId: null,
    });
    expect(boundary.execute).toHaveBeenCalledTimes(1);
    expect(boundary.reconcile).toHaveBeenCalledTimes(1);
  });

  test("authoritatively absent legacy ACK reopens the same ROAD task once without replanning", async () => {
    const { runtime, storage, boundary } = harness();
    await runtime.tick(observation(runtime.snapshot()));
    const delivered = await runtime.tick(observation(runtime.snapshot()));
    const roadTask = delivered.state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
    const roadOutcome = delivered.state.journal.find((entry) => entry.id === roadTask.terminalOutcomeId)!;
    const commands = createMemoryCommandJournal();
    const record: V2CommandRecord = {
      schemaVersion: "ai-mayor-v2-command/1",
      commandId: roadOutcome.commandId!,
      actionFamily: "ROAD",
      actionType: "build_road",
      authorizedScope: {
        owner: { ownerType: "TASK", ownerId: roadTask.id },
        actionFamily: "ROAD",
        proposalId: "road-proposal",
        quoteId: "road-quote",
        fingerprint: "road-input",
        exactInput: "road-input",
        budget: { authorizedMaxSpend: 1, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
        observationPrecondition: { runtimeEpoch: "bridge:1", frame: 1 },
        expiresAt: instant.toISOString(),
      },
      createdAt: instant.toISOString(),
      submittedAt: instant.toISOString(),
      nativeResultSummary: "legacy ACK",
      status: "OBSERVED_MISMATCH",
      statusHistory: [],
      reconciliationStatus: "MISMATCH",
      observationEvidence: [{
        phase: "RECONCILIATION",
        observationId: "absence-proof",
        coherence: "STABLE_FRAME",
        recordedAt: instant.toISOString(),
        summary: "complete topology has no effect",
      }],
      failureOrUnknownReason: "complete topology has no effect",
      effectAbsenceProven: true,
    };
    commands.create(record);
    const restored = createGate1VerticalSlice({
      storage,
      boundary,
      commandJournal: commands,
      now: () => instant,
    });
    expect(restored.snapshot()).toMatchObject({
      intent: { id: delivered.state.intent.id },
      tranche: { stage: "SITE_SELECTED", delivery_progress: { completed: 1 } },
    });
    expect(restored.snapshot().tasks.find((task) => task.kind === "ROAD_CONNECTION")).toMatchObject({
      id: roadTask.id,
      status: "PENDING",
      attempts: 1,
      terminalOutcomeId: null,
    });
    const restoredAgain = createGate1VerticalSlice({ storage, boundary, commandJournal: commands, now: () => instant });
    expect(restoredAgain.snapshot().journal.filter((entry) => entry.reason.includes("prior ACK produced no road effect"))).toHaveLength(1);
  });

  test("malformed restored ownership fails closed", () => {
    const state = planStarterResidentialIntent(initial(), instant);
    state.tranche.districtId = "another-district";
    expect(() =>
      createGate1VerticalSlice({
        storage: createMemoryGate1StateStorage(state),
        boundary: { execute: jest.fn() },
        now: () => instant,
      }),
    ).toThrow("ownership or reservation state is inconsistent");
  });
});
