import type { SpatialSiteDetail } from "../../src/main/services/ai-mayor/spatial/types";
import type { V2ObservationEnvelope, V2SourcePayload } from "../../src/main/services/ai-mayor/v2/foundation";
import {
  type Gate1AdmittedProposal,
  type Gate1State,
  type Gate1WorldBoundary,
  planStarterResidentialIntent,
  type StarterResidentialIntentInput,
  V2_GATE1_STATE_SCHEMA_VERSION,
} from "../../src/main/services/ai-mayor/v2/gate1";
import { createGate1ObservationProjector } from "../../src/main/services/ai-mayor/v2/gate1-observation";
import { createV2Gate1Progression } from "../../src/main/services/ai-mayor/v2/gate1-progression";
import type { V2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { buildUtilityPreparationInput } from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import {
  createMemoryDurableStateStorage,
  parseNativeWorldIdentity,
  V2DurabilityCoordinator,
} from "../../src/main/services/ai-mayor/v2/durability";

const instant = new Date("2026-01-02T03:04:05.000Z");
const TREASURY = 40_000;

// A LoadGame world that already carries a native checkpoint identity, so
// activation is an in-place ACTIVATED world rather than a first-enable
// onboarding candidate.
const worldA = {
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

const worldB = {
  ...worldA,
  world: {
    ...worldA.world,
    worldId: "cs2-session:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    nativeSessionGuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    loadAssetGuid: "meta-b",
    saveDataAssetGuid: "data-b",
    checkpointId: "save:meta-b:data-b",
    bridgeRuntimeEpoch: "bridge-b",
    generation: "generation-b",
  },
};

const intentInput = (): StarterResidentialIntentInput => ({
  intentId: "intent:gate1-progression-test",
  targetResidents: 12,
  maximumBudget: 25_000,
  planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
  siteCandidates: [{ id: "site-a", target: { center: { x: 32, z: 0 }, radius: 28 }, score: 10, blocked: false }],
  starterDirection: { x: 1, z: 0 },
  maximumWaitObservations: 3,
});

const detail = (): SpatialSiteDetail => ({
  center: { x: 0, z: 0 },
  radius: 96,
  terrain: {
    resolution: 2,
    bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
    cellSize: { x: 100, z: 100 },
    heights: [0, 0, 0, 0],
    waterDepths: [0, 0, 0, 0],
    groundWater: [0, 0, 0, 0],
    groundWaterPollution: [0, 0, 0, 0],
    windSpeed: [0, 0, 0, 0],
  },
  roadGraph: { nodes: [], edges: [] },
  buildings: [],
  zoningCells: [
    {
      block: { index: 30, version: 1 },
      index: 0,
      position: { x: 32, y: 0, z: 0 },
      visible: true,
      roadside: true,
      occupied: false,
      blocked: false,
      overridden: false,
      zoneType: 0,
      zoneCategory: "none",
    },
  ],
});

function sourceValue<T>(value: T) {
  return {
    status: "AVAILABLE" as const,
    data: value,
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 },
  };
}

function observationEnvelope(
  data: SpatialSiteDetail = detail(),
  coherence: V2ObservationEnvelope["coherence"] = "STABLE_FRAME",
): V2ObservationEnvelope {
  return {
    schemaVersion: "ai-mayor-v2-observation/1",
    observationId: "observation:progression",
    runtimeEpoch: "runtime:progression",
    worldEpoch: { kind: "RUNTIME_SESSION", value: "runtime:progression", durableAcrossSaveLoad: false },
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    gameTimeStart: "2026-01-01 08:00",
    gameTimeEnd: "2026-01-01 08:00",
    pausedBefore: true,
    pausedAfter: true,
    coherence,
    sourceFreshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", maximumAgeMs: 0, allRequiredSourcesAvailable: true },
    revision: { authoritativeWorldRevision: null },
    sources: {
      gameStateBefore: sourceValue({}),
      snapshot: sourceValue({}),
      spatialScan: sourceValue({}),
      spatialDetail: sourceValue(data),
      gameStateAfter: sourceValue({}),
    },
  };
}

interface HarnessOptions {
  boundary?: Gate1WorldBoundary;
  maximumDecisions?: number;
  maximumWakeIterations?: number;
  /** Counts the bounded simulation windows this progression buys. */
  runBoundedSimulation?: (signal: AbortSignal) => Promise<void>;
  prepareUtilityServiceRoadChild?: (state: Gate1State, signal: AbortSignal) => Promise<boolean>;
  commissionZoningUtilities?: (state: Gate1State, signal: AbortSignal) => Promise<{ status: "READY" | "WAITING" | "REPLAN" | "PLANNING_HANDOFF" | "BLOCKED" | "PARKED"; reason?: string }>;
}

function harness(options: HarnessOptions = {}) {
  const storage = createMemoryDurableStateStorage();
  const coordinator = new V2DurabilityCoordinator(storage, () => instant);
  let currentWorld: unknown = worldA;
  const calls: Gate1AdmittedProposal[] = [];

  const boundary: Gate1WorldBoundary =
    options.boundary ??
    ({
      execute: async (proposal) => {
        calls.push(proposal);
        return {
          status: "DELIVERED",
          commandId: `command:${proposal.id}`,
          observedMatch: true,
          reason: "fixture boundary delivered",
        };
      },
    } satisfies Gate1WorldBoundary);

  const foundation = {
    observation: { capture: async () => observationEnvelope() },
    targetAccess: { observe: async () => ({ status: "ATTACHED_ONLY", coherence: "STABLE_FRAME" }) },
    routeQuery: { submit: async () => ({ state: "ROUTABLE" }) },
    utilityService: { observe: async () => ({ coherence: "STABLE_FRAME" }) },
    readBuildingResidents: async () => ({ status: "AVAILABLE", data: { residentCount: 0, occupied: false } }),
    commandJournal: coordinator.commandJournal,
    durability: coordinator,
    activateDurableWorld: async () => coordinator.activate(currentWorld),
  } as unknown as V2FoundationPorts;

  const progression = createV2Gate1Progression({
    foundation,
    boundaryForWorld: () => boundary,
    waitForNativeIdle: async () => undefined,
    runBoundedSimulation: options.runBoundedSimulation ?? (async () => undefined),
    ...(options.prepareUtilityServiceRoadChild ? { prepareUtilityServiceRoadChild: options.prepareUtilityServiceRoadChild } : {}),
    ...(options.commissionZoningUtilities ? { commissionZoningUtilities: options.commissionZoningUtilities } : {}),
    ...(options.maximumDecisions === undefined ? {} : { maximumDecisions: options.maximumDecisions }),
    ...(options.maximumWakeIterations === undefined ? {} : { maximumWakeIterations: options.maximumWakeIterations }),
  });

  return {
    storage,
    coordinator,
    foundation,
    progression,
    calls,
    setWorld: (next: unknown) => {
      currentWorld = next;
    },
  };
}

/** Persist the state project admission would have written, then return it. */
function seedAdmitted(coordinator: V2DurabilityCoordinator): Gate1State {
  coordinator.activate(worldA);
  const state = planStarterResidentialIntent(intentInput(), instant);
  coordinator.saveProjectState(state);
  return state;
}

const identityOf = (state: Gate1State) => ({
  intentId: state.intent.id,
  projectId: state.project.id,
  districtId: state.district.id,
  trancheId: state.tranche.id,
  reservationRef: state.tranche.reservationRef,
  districtReservationRef: state.district.reservationRef,
});

describe("V2 Gate 1 production progression", () => {
  test("returns a nonblocking planning handoff without retrying the same utility context", async () => {
    const events: string[] = [];
    const { coordinator, progression } = harness({
      commissionZoningUtilities: async () => { events.push("K05_HANDOFF"); return { status: "PLANNING_HANDOFF", reason: "alternate facility site selected" }; },
      boundary: { execute: async (proposal) => {
        events.push(proposal.operation);
        return { status: "DELIVERED", commandId: `command:${proposal.id}`, observedMatch: true, reason: "authoritative fixture match" };
      } },
    });
    seedAdmitted(coordinator);
    const result = await progression.advanceToStage("OCCUPIED");
    expect(result.status).toBe("EXHAUSTED");
    expect(result.stage).toBe("ROAD_DELIVERED");
    expect(result.decisions).toBeGreaterThan(0);
    expect(events.filter((event) => event === "K05_HANDOFF")).toHaveLength(1);
    expect(events.at(-1)).toBe("K05_HANDOFF");
    expect(progression.snapshot()?.project.status).toBe("ACTIVE");
  });

  test("commissions scoped utilities before production zoning, then returns to the zoning task", async () => {
    const events: string[] = [];
    const { coordinator, progression } = harness({
      commissionZoningUtilities: async (state) => {
        events.push(`K05:${state.tranche.stage}`);
        return { status: "READY" };
      },
      boundary: {
        execute: async (proposal) => {
          events.push(proposal.operation);
          return { status: "DELIVERED", commandId: `command:${proposal.id}`, observedMatch: true, reason: "authoritative fixture match" };
        },
      },
    });
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("ZONED_WAITING_FOR_BUILDING");

    expect(result.status).toBe("MILESTONE_REACHED");
    expect(result.stage).toBe("ZONED_WAITING_FOR_BUILDING");
    expect(events).toEqual(["BUILD_ROAD", "K05:ROAD_DELIVERED", "ZONE_RESIDENTIAL"]);
  });

  /**
   * A simulation wake advances the WORLD, not the tranche, so it is one of the
   * "woke up and did not progress" wakes `maximumWakeIterations` counts. It used
   * to clear that counter, which left `maximumDecisions` as the only bound on one
   * `advanceToStage` call: measured live (2026-10-01, fresh city) that was twelve
   * windows — three in-game hours — per call, and 79 windows for one Brain cycle
   * that produced a single road.
   */
  test("a call that can only wait on the world buys its bounded simulation windows and stops", async () => {
    const simulations: number[] = [];
    const { coordinator, progression } = harness({
      maximumWakeIterations: 2,
      runBoundedSimulation: async () => { simulations.push(simulations.length + 1); },
    });
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("OCCUPIED");

    expect(simulations).toHaveLength(2);
    expect(result.status).toBe("WAITING");
    expect(result.reason).toContain("GATE1_WAITING_FOR_WORLD_AFTER_2_SIMULATION_WINDOWS");
    // Waiting, not blocked: the Goal is not spent and the next cycle re-enters it.
    expect(progression.snapshot()?.project.status).toBe("ACTIVE");
  });

  /**
   * A wait whose fact another operation's construction supplies must buy no
   * window AND must not be reported BLOCKED.
   *
   * The retry tail under `LOCAL_WAITING` belongs to `NEXT_OBSERVATION` wakes: it
   * re-observes up to `maximumWakeIterations` times and then reports BLOCKED —
   * which would make a waiting tranche a blocked one. It must not catch
   * `DEPENDENT_CONSTRUCTION`.
   */
  test("a wait on another operation's construction buys no window and is not reported BLOCKED", async () => {
    const simulations: number[] = [];
    const { coordinator, progression } = harness({
      maximumWakeIterations: 2,
      runBoundedSimulation: async () => { simulations.push(simulations.length + 1); },
    });
    const seed = seedAdmitted(coordinator);
    // A base utility Goal: the Goal's own id is what `baseUtilityGoalForTranche`
    // reads, and it is what makes the utility wait depend on another operation.
    // The ladder walks itself there — the fixture's spatial detail carries no
    // buildings, so the utility wait reports `NO_ATTRIBUTED_BUILDING`.
    coordinator.activateGoalWorkOrder({ goalId: "PROVIDE_SERVICE:electricity:facts:1", state: seed });

    const result = await progression.advanceToStage("WAITING_FOR_OCCUPANCY");

    expect(simulations).toHaveLength(0);
    expect(result.status).toBe("WAITING");
    expect(result.reason).toContain("GATE1_WAITING_ON_DEPENDENT_WORK:");
    expect(progression.snapshot()?.project.status).toBe("ACTIVE");
  });

  /**
   * The commissioning pass answers a city-level question, but it used to be
   * reachable only from a tranche whose milestone was at or beyond
   * ZONED_WAITING_FOR_BUILDING. A bounded prerequisite step stops at
   * ROAD_DELIVERED and its own milestone IS ROAD_DELIVERED, so the Goal whose
   * prerequisite had just run out could never learn its service work was spent.
   */
  describe("service Goal settlement outside the tranche milestone ladder", () => {
    const prerequisiteState = (coordinator: V2DurabilityCoordinator) => {
      const state = seedAdmitted(coordinator);
      state.tranche.stage = "ROAD_DELIVERED";
      coordinator.saveProjectState(state);
      coordinator.activateGoalWorkOrder({
        goalId: "UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa",
        state, parentGoalId: "UTILITY_SERVICE:water:city:site_scope:1",
        targetPoint: { x: 80, z: 90 }, completionStage: "ROAD_DELIVERED",
      });
      return state;
    };

    test("asks the pass without moving the step's milestone, and reports what it said", async () => {
      const observed: string[] = [];
      const { coordinator, progression } = harness({
        commissionZoningUtilities: async (state) => { observed.push(state.tranche.stage); return { status: "PARKED", reason: "WATER_GOAL_SITE_SCOPE_BUDGET_EXHAUSTED" }; },
      });
      const before = prerequisiteState(coordinator);

      const settled = await progression.settleUtilityGoals();

      expect(settled).toMatchObject({ status: "PARKED", reason: "WATER_GOAL_SITE_SCOPE_BUDGET_EXHAUSTED" });
      // The pass saw the step exactly as it is: the milestone a Road-only
      // prerequisite stops at, never a raised or faked one.
      expect(observed).toEqual(["ROAD_DELIVERED"]);
      expect(coordinator.projectState()).toMatchObject({
        tranche: { stage: "ROAD_DELIVERED" },
        project: { id: before.project.id },
      });
      // And asking did not itself become a stage transition.
      expect(progression.snapshot()?.tranche.stage ?? "ROAD_DELIVERED").toBe("ROAD_DELIVERED");
    });

    test("never reports a bounded planner retry as a settled Goal", async () => {
      const { coordinator, progression } = harness({
        commissionZoningUtilities: async () => ({ status: "REPLAN", reason: "K05_PREPARE_BLOCKED:NO_SUPPORTED_WATER_TOPOLOGY" }),
      });
      prerequisiteState(coordinator);

      await expect(progression.settleUtilityGoals()).resolves.toMatchObject({
        status: "UNAVAILABLE", reason: "K05_PREPARE_BLOCKED:NO_SUPPORTED_WATER_TOPOLOGY",
      });
    });

    test("an unasked question is never reported as a parked Goal", async () => {
      const { coordinator, progression } = harness();
      prerequisiteState(coordinator);
      await expect(progression.settleUtilityGoals()).resolves.toMatchObject({
        status: "UNAVAILABLE", reason: "UTILITY_COMMISSIONING_NOT_CONFIGURED",
      });
    });
  });

  /**
   * One commissioning pass is the most expensive operation in the system: it
   * plans, probes natively and may place a facility, per service. The outer
   * decision budget is sized for cheap state transitions, so letting a failing
   * pass retry within it meant a single advanceToStage call could repeat it tens
   * of times. Observed live: over twenty minutes inside one call.
   */
  test("a failing utility pass is retried once, then the tranche takes its own step", async () => {
    let passes = 0;
    const { coordinator, progression } = harness({
      commissionZoningUtilities: async () => { passes += 1; throw new Error("K05_PREPARE_BLOCKED:NO_SUPPORTED_WATER_TOPOLOGY"); },
      boundary: { execute: async (proposal) => ({
        status: "DELIVERED", commandId: `command:${proposal.id}`, observedMatch: true, reason: "fixture",
      }) },
    });
    const state = seedAdmitted(coordinator);
    state.tranche.stage = "ROAD_DELIVERED";
    state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.status = "SUCCEEDED";
    state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.terminalOutcomeId = "road-outcome";
    state.journal.push({
      id: "road-outcome", taskId: state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.id,
      skill: "RoadConnection", proposalId: "road-attempt", recordedAt: instant.toISOString(),
      admission: "ADMITTED", execution: "DELIVERED", commandId: "command:road",
      observationId: "observation:road", observedEffect: "NOT_APPLICABLE", failureClassification: "NONE", reason: "certified",
    });
    coordinator.saveProjectState(state);

    const result = await progression.advanceToStage("OCCUPIED");

    expect(passes).toBe(2);
    // And the tranche was not left waiting on the pass: it took the zoning step
    // it was admitted for, in the same call that exhausted the retry.
    const zoning = result.state?.tasks.find((task) => task.kind === "ZONING");
    expect(zoning?.attempts ?? 0).toBeGreaterThan(0);
  });

  /**
   * A waiting service must not gate zoning, for the same reason a failing one
   * must not — and the cost of getting that wrong is the whole city.
   *
   * This used to `return` a WAITING result from `advanceToStage`, leaving the
   * tranche at `ROAD_DELIVERED` with its ZONING task PENDING. Measured live
   * (2026-09-30) on an admitted commercial Goal: eight Brain cycles, a journal
   * frozen at position 93, zero native mutations, and 2527 of 2823 native calls
   * spent polling for a simulation auto-pause that the tranche was not going to
   * produce. The tranche takes its own next step now, and the wait is reported
   * rather than obeyed.
   */
  test("takes the zoning step while a utility pass is waiting, instead of returning the wait", async () => {
    let utilityCalls = 0;
    const { coordinator, progression } = harness({
      commissionZoningUtilities: async () => {
        utilityCalls += 1;
        return { status: "WAITING", reason: "WAITING_FOR_SERVICE_UPDATE" };
      },
    });
    seedAdmitted(coordinator);
    const road = await progression.advanceToStage("ROAD_DELIVERED");
    expect(road.status).toBe("MILESTONE_REACHED");

    const result = await progression.advanceToStage("OCCUPIED");

    // The pass is not retried after a wait: it has said what it is waiting for,
    // and repeating the most expensive operation in the system answers nothing.
    expect(utilityCalls).toBe(1);
    // The tranche did not stay at the stage it was admitted to leave.
    expect(result.state?.tranche.stage).not.toBe("ROAD_DELIVERED");
    const zoning = result.state?.tasks.find((task) => task.kind === "ZONING");
    expect(zoning?.attempts ?? 0).toBeGreaterThan(0);
  });

  test("executes a newly-created utility Road goal before retrying K05", async () => {
    const events: string[] = [];
    const { coordinator, progression } = harness({
      commissionZoningUtilities: async () => { events.push("K05"); return { status: "READY" }; },
      boundary: {
        execute: async (proposal) => {
          events.push(proposal.operation);
          return { status: "DELIVERED", commandId: `command:${proposal.id}`, observedMatch: true, reason: "authoritative fixture match" };
        },
      },
    });
    const state = seedAdmitted(coordinator);
    state.tranche.stage = "ROAD_DELIVERED";
    state.tranche.delivery_progress.completed = 2;
    const starterRoad = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
    starterRoad.status = "SUCCEEDED";
    starterRoad.terminalOutcomeId = `${starterRoad.id}:outcome:2`;
    state.journal.push({
      id: starterRoad.terminalOutcomeId, taskId: starterRoad.id, skill: "RoadConnection", proposalId: `${starterRoad.id}:attempt:2`,
      recordedAt: instant.toISOString(), admission: "ADMITTED", execution: "DELIVERED", commandId: "command:starter-road",
      observationId: "observation:starter-road", observedEffect: "NOT_APPLICABLE", failureClassification: "NONE", reason: "certified",
    });
    const utilityRoad = {
      ...starterRoad,
      id: `${starterRoad.id}:utility-service:1`,
      legalStage: "ROAD_DELIVERED" as const,
      status: "PENDING" as const,
      attempts: 0,
      terminalOutcomeId: null,
      utilityRoadParentTaskId: starterRoad.id,
      utilityRoadPlanRevision: "utility-plan:1",
    };
    state.tasks.push(utilityRoad);
    state.tranche.taskIds.push(utilityRoad.id);
    state.tranche.currentTaskIds = { ...state.tranche.currentTaskIds, ROAD_CONNECTION: utilityRoad.id };
    state.tranche.delivery_progress.total += 1;
    state.tranche.delivery_progress.ratio = 0.4;
    coordinator.saveProjectState(state);

    const result = await progression.advanceToStage("ZONED_WAITING_FOR_BUILDING");

    expect(result.status).toBe("MILESTONE_REACHED");
    expect(events).toEqual(["BUILD_ROAD", "K05", "ZONE_RESIDENTIAL"]);
    expect(result.state?.tranche.delivery_progress).toMatchObject({ completed: 4, total: 5, ratio: 0.8 });
  });

  test("prepares an existing utility child plan after SITE_SELECTED and before the Road task", async () => {
    const events: string[] = [];
    const { coordinator, progression } = harness({
      prepareUtilityServiceRoadChild: async (state) => {
        events.push(`prepare:${state.tranche.stage}`);
        return false;
      },
      boundary: {
        execute: async () => {
          events.push("road");
          return { status: "DELIVERED", commandId: "command:road", observedMatch: true, reason: "fixture" };
        },
      },
    });
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("ROAD_DELIVERED");

    expect(result.status).toBe("MILESTONE_REACHED");
    expect(events).toEqual(["prepare:SITE_SELECTED", "road"]);
  });

  test("routes an eligible exhausted Road predecessor with an unused child back through durable planning", async () => {
    const events: string[] = [];
    const { coordinator, progression } = harness({
      prepareUtilityServiceRoadChild: async () => { events.push("replan"); return false; },
      boundary: { execute: async () => { events.push("dispatch"); return { status: "DELIVERED", commandId: null, observedMatch: true, reason: "unused" }; } },
    });
    const state = seedAdmitted(coordinator);
    state.tranche.stage = "SITE_SELECTED";
    const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
    const exactRoadInput = { prefab: "Small Road", x1: 0, z1: 0, x2: 10, z2: 0 };
    const activation = coordinator.snapshot().active!;
    const child = coordinator.recordUtilityServiceRoadChildOperation({
      state, planRevision: "plan:old", exactRoadInput,
      courseFingerprint: JSON.stringify({ actionFamily: "ROAD", ...exactRoadInput }),
      authorizationWorldId: activation.worldId, authorizationCheckpointId: activation.loadedCheckpointId,
      authorizationGeneration: activation.generation, detail: "predecessor child",
    });
    roadTask.childOperationAmendmentId = child.amendmentId;
    roadTask.childOperationAmendmentIds = [child.amendmentId];
    roadTask.status = "BLOCKED"; roadTask.maximumAttempts = 1; roadTask.attempts = 1;
    roadTask.terminalOutcomeId = `${roadTask.id}:outcome:1`;
    state.project.status = "BLOCKED"; state.intent.status = "BLOCKED";
    state.journal.push({
      id: roadTask.terminalOutcomeId, taskId: roadTask.id, skill: "RoadConnection", proposalId: `${roadTask.id}:attempt:1`,
      recordedAt: instant.toISOString(), admission: "ADMITTED", execution: "UNKNOWN", commandId: null, observationId: null,
      observedEffect: "UNKNOWN", failureClassification: "EXECUTION_UNKNOWN",
      roadPreApplyFailure: { schemaVersion: "ai-mayor-v2-road-pre-apply-failure/1", phase: "ROAD_PREVIEW_QUOTE_VALIDATION",
        taskId: roadTask.id, childId: child.amendmentId, exactInput: exactRoadInput,
        firstFailedQuoteRequirement: "VALID_TRUE", previewOnly: true, applyCalled: false },
      reason: "native preview rejected before Apply",
    });
    coordinator.saveProjectState(state);
    expect(coordinator.isRoadPlannerInputReplacementEligible(coordinator.projectState(), roadTask.id)).toBe(true);

    await progression.advanceToStage("ROAD_DELIVERED");

    expect(events[0]).toBe("replan");
    expect(events).not.toContain("dispatch");
  });

  test("advances a persisted PLANNED state through the existing transitions to ROAD_DELIVERED", async () => {
    const { coordinator, progression, calls } = harness();
    const seeded = seedAdmitted(coordinator);
    expect(seeded.tranche.stage).toBe("PLANNED");
    expect(coordinator.projectState().schemaVersion).toBe(V2_GATE1_STATE_SCHEMA_VERSION);

    const result = await progression.advanceToStage("ROAD_DELIVERED");

    expect(result.status).toBe("MILESTONE_REACHED");
    expect(result.stage).toBe("ROAD_DELIVERED");
    expect(result.state?.tranche.stage).toBe("ROAD_DELIVERED");
    expect(result.state?.tranche.delivery_progress.completed).toBe(2);
    // Only the road connection is a world write; site selection is a STATE proposal.
    expect(calls.map((proposal) => proposal.operation)).toEqual(["BUILD_ROAD"]);
    // The fixture boundary performs no journaled native submission.
    expect(result.roadCommandCount).toBe(0);
    // The durable store holds the advanced stage, not just the in-memory copy.
    expect(coordinator.projectState()).toMatchObject({ tranche: { stage: "ROAD_DELIVERED" } });
  });

  test("every stage change comes from the Gate 1 state machine, never a direct write", async () => {
    const { coordinator, progression } = harness();
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("ROAD_DELIVERED");
    const state = result.state as Gate1State;
    const siteTask = state.tasks.find((task) => task.kind === "SITE_SELECTION");
    const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION");

    expect(siteTask).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    expect(siteTask?.terminalOutcomeId).not.toBeNull();
    expect(roadTask).toMatchObject({ status: "SUCCEEDED" });
    expect(roadTask?.terminalOutcomeId).not.toBeNull();
    expect(state.journal).toHaveLength(2);

    const [site, road] = state.journal;
    expect(site).toMatchObject({ execution: "NOT_REQUIRED", observedEffect: "NOT_APPLICABLE" });
    expect(road).toMatchObject({ admission: "ADMITTED", execution: "DELIVERED" });
    expect(road.commandId).not.toBeNull();
    expect(road.id).toBe(roadTask?.terminalOutcomeId);
  });

  test("ROAD_DELIVERED requires delivered road evidence", async () => {
    const { coordinator, progression } = harness({
      boundary: {
        execute: async () => ({ status: "WAITING", commandId: null, observedMatch: false, reason: "native build slot busy" }),
      },
      maximumDecisions: 4,
    });
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("ROAD_DELIVERED");

    expect(result.status).not.toBe("MILESTONE_REACHED");
    expect(result.stage).toBe("SITE_SELECTED");
    expect(coordinator.projectState()).toMatchObject({ tranche: { stage: "SITE_SELECTED" } });
  });

  test("an UNKNOWN road outcome never masquerades as a delivered stage", async () => {
    const { coordinator, progression } = harness({
      boundary: {
        execute: async () => ({ status: "UNKNOWN", commandId: "command:unknown", observedMatch: false, reason: "transport unknown" }),
      },
      maximumDecisions: 6,
    });
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("ROAD_DELIVERED");

    expect(result.status).not.toBe("MILESTONE_REACHED");
    expect(result.state?.tranche.stage).toBe("SITE_SELECTED");
    expect(result.state?.project.status).not.toBe("ACTIVE");
  });

  test("restart resumes from the persisted stage without replaying the project", async () => {
    const first = harness();
    const seeded = seedAdmitted(first.coordinator);

    const partial = await first.progression.advanceToStage("SITE_SELECTED");
    expect(partial.status).toBe("MILESTONE_REACHED");
    expect(partial.stage).toBe("SITE_SELECTED");
    expect(partial.decisions).toBe(1);

    // A second owner over the same durable store must pick up the persisted
    // SITE_SELECTED state rather than re-planning a project.
    const restarted = createV2Gate1Progression({
      foundation: first.foundation,
      boundaryForWorld: () =>
        ({
          execute: async (proposal) => {
            first.calls.push(proposal);
            return {
              status: "DELIVERED",
              commandId: `command:${proposal.id}`,
              observedMatch: true,
              reason: "restarted boundary delivered",
            };
          },
        }) satisfies Gate1WorldBoundary,
      waitForNativeIdle: async () => undefined,
      runBoundedSimulation: async () => undefined,
    });

    const result = await restarted.advanceToStage("ROAD_DELIVERED");

    expect(result.status).toBe("MILESTONE_REACHED");
    expect(result.decisions).toBe(1);
    const state = result.state as Gate1State;
    expect(identityOf(state)).toEqual(identityOf(seeded));
    expect(state.tasks.find((task) => task.kind === "SITE_SELECTION")).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
    });
    expect(state.journal).toHaveLength(2);
  });

  test("duplicate progression repeats no road mutation", async () => {
    const { coordinator, progression, calls } = harness();
    seedAdmitted(coordinator);

    const first = await progression.advanceToStage("ROAD_DELIVERED");
    const boundaryCallsAfterFirst = calls.length;
    const journalAfterFirst = (first.state as Gate1State).journal.length;
    const stateVersionAfterFirst = (first.state as Gate1State).stateVersion;

    const repeated = await progression.advanceToStage("ROAD_DELIVERED");

    expect(repeated.status).toBe("MILESTONE_REACHED");
    expect(repeated.decisions).toBe(0);
    expect(calls.length).toBe(boundaryCallsAfterFirst);
    expect((repeated.state as Gate1State).journal).toHaveLength(journalAfterFirst);
    expect((repeated.state as Gate1State).stateVersion).toBe(stateVersionAfterFirst);
  });

  test("recreates the cached Gate1 runner when the active durable work order changes", async () => {
    const { coordinator, progression, calls } = harness();
    const first = seedAdmitted(coordinator);
    await progression.advanceToStage("ROAD_DELIVERED");
    const child = planStarterResidentialIntent({
      ...intentInput(), intentId: "intent:goal-prerequisite-road",
      planningEnvelope: { center: { x: 400, z: 200 }, radius: 180 },
      siteCandidates: [{ id: "child-road-site", target: { center: { x: 432, z: 200 }, radius: 28 }, score: 10, blocked: false }],
    }, instant);
    coordinator.activateGoalWorkOrder({ goalId: "water:prerequisite:road:1", state: child,
      parentGoalId: "water:site:1", targetPoint: { x: 900, z: 500 }, completionStage: "ROAD_DELIVERED" });

    const result = await progression.advanceToStage("ROAD_DELIVERED");
    expect(result.status).toBe("MILESTONE_REACHED");
    expect(result.state?.intent.id).toBe(child.intent.id);
    expect(result.state?.project.id).not.toBe(first.project.id);
    expect(calls.filter((proposal) => proposal.projectId === child.project.id)).toHaveLength(1);
  });

  test("project, tranche and reservation identity are unchanged end to end", async () => {
    const { coordinator, progression } = harness();
    const seeded = seedAdmitted(coordinator);

    const result = await progression.advanceToStage("ROAD_DELIVERED");

    expect(identityOf(result.state as Gate1State)).toEqual(identityOf(seeded));
    expect(identityOf(coordinator.projectState() as Gate1State)).toEqual(identityOf(seeded));
  });

  test("a different world inherits no progression state", async () => {
    const { coordinator, progression, calls, setWorld } = harness();
    seedAdmitted(coordinator);
    const before = coordinator.projectState();

    setWorld(worldB);
    const result = await progression.advanceToStage("ROAD_DELIVERED");

    expect(result.status).toBe("NOT_ADMITTED");
    expect(result.state).toBeNull();
    expect(calls).toHaveLength(0);
    // A different native world receives no inherited project authority and
    // cannot resume the old Gate 1 progression: the state is a bare placeholder
    // with no Goal plan left standing on it. `projectAuthority()` was removed —
    // the loaded world is the authority, so there is no separate authority
    // object to inspect.
    expect(coordinator.projectState()).toMatchObject({ status: "PLACEHOLDER" });
    expect(coordinator.snapshot().goalWorkOrders).toEqual([]);
    expect(coordinator.snapshot().activeGoalWorkOrderId).toBeNull();
    expect(before.schemaVersion).toBe(V2_GATE1_STATE_SCHEMA_VERSION);
  });

  test("K05 stage admission only passes at ROAD_DELIVERED", async () => {
    const { coordinator, progression } = harness();
    seedAdmitted(coordinator);
    const world = parseNativeWorldIdentity(worldA);

    const siteOnly = await progression.advanceToStage("SITE_SELECTED");
    expect(siteOnly.stage).toBe("SITE_SELECTED");
    expect(() =>
      buildUtilityPreparationInput({ state: siteOnly.state as Gate1State, world, treasury: TREASURY }),
    ).toThrow("UTILITY_ADMISSION_STAGE_NOT_ROAD_DELIVERED");

    const delivered = await progression.advanceToStage("ROAD_DELIVERED");
    expect(delivered.stage).toBe("ROAD_DELIVERED");
    const preparation = buildUtilityPreparationInput({
      state: delivered.state as Gate1State,
      world,
      treasury: TREASURY,
    });
    expect(preparation.intentId).toBe("intent:gate1-progression-test");
  });

  test("a milestone that is not a linear stage is refused without touching the world", async () => {
    const { coordinator, progression, calls } = harness();
    seedAdmitted(coordinator);

    const result = await progression.advanceToStage("DIAGNOSING");

    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("GATE1_PROGRESSION_MILESTONE_NOT_A_LINEAR_STAGE");
    expect(calls).toHaveLength(0);
    expect(coordinator.projectState()).toMatchObject({ tranche: { stage: "PLANNED" } });
  });
});

/**
 * The envelope and a fact are two different coherence questions, and merging
 * them is what stopped a whole tranche on one building's optional access
 * endpoint. Measured live (2026-09-30): every successor of a residential Goal
 * sat at `PLANNED` with `coherence is UNKNOWN` and no task could advance —
 * including `SITE_SELECTION`, which reads no building at all — because the
 * tranche's target happened to contain a building whose access read came back
 * UNAVAILABLE.
 */
describe("observation coherence keeps the envelope and a fact apart", () => {
  const building = { entity: { index: 339_614, version: 555 }, prefab: "EU_ResidentialLow02_L2_3x2",
    position: { x: 32, y: 0, z: 0 } };

  const project = async (input: {
    envelope: V2ObservationEnvelope["coherence"];
    access: { status: string; coherence: string };
    buildings?: readonly unknown[];
  }) => {
    const state = planStarterResidentialIntent(intentInput(), instant);
    const projector = createGate1ObservationProjector({
      foundation: {
        observation: { capture: async () => observationEnvelope(
          { ...detail(), buildings: [...(input.buildings ?? [building])] as SpatialSiteDetail["buildings"] }, input.envelope) },
        targetAccess: { observe: async () => ({
          schemaVersion: "ai-mayor-v2-target-access/1", status: input.access.status,
          statusProvenance: input.access.status === "ATTACHED_ONLY" ? "DERIVED_WITH_EXPLICIT_RULE" : "UNKNOWN",
          coherence: input.access.coherence, entrances: [], roadAttachment: null,
          networkEvidence: { status: "UNKNOWN", qualifyingEntranceCount: 0, reason: "fixture" },
          routeEvidence: { status: "UNAVAILABLE", nativePathQueryExecuted: false, targetAnchor: null, reason: "fixture" },
          reason: "fixture", confidence: "NONE", derivation: null,
          nonAuthority: { geometricNearbyRoad: "NOT_USED", undirectedRoadTopology: "NOT_USED" },
        }) },
        utilityService: { observe: async () => ({ coherence: "STABLE_FRAME",
          electricity: { status: "SERVED" }, water: { status: "SERVED" }, sewage: { status: "SERVED" } }) },
        readBuildingResidents: async () => ({ status: "AVAILABLE", data: { residentCount: 2, occupied: true } }),
      } as unknown as V2FoundationPorts,
      world: parseNativeWorldIdentity(worldA),
    });
    return projector.observe(state);
  };

  test("one building's unreadable access stays a fact and does not fail the observation", async () => {
    const observation = await project({ envelope: "STABLE_FRAME", access: { status: "UNAVAILABLE", coherence: "UNKNOWN" } });

    // The envelope was captured inside one frame with every source available,
    // so nothing about the snapshot as a whole is in doubt.
    expect(observation.coherence).toBe("STABLE_FRAME");
    // The fact that could not be read says so, and names itself.
    expect(observation.factCoherence).toMatchObject({ access: "UNKNOWN", utilities: "STABLE_FRAME",
      incoherentRefs: ["access:339614:555"] });
    // And its value stays UNKNOWN — never filled in, never treated as PASS.
    expect(observation.access.value).toBe("UNKNOWN");
  });

  test("an incoherent envelope still fails the whole observation closed", async () => {
    const observation = await project({ envelope: "UNKNOWN", access: { status: "ATTACHED_ONLY", coherence: "STABLE_FRAME" } });
    expect(observation.coherence).toBe("UNKNOWN");
    expect(observation.access.value).toBe("UNKNOWN");
    expect(observation.incoherence).toMatchObject({ unavailableSources: [] });
  });

  test("a readable access is still reported as the fact it is", async () => {
    const observation = await project({ envelope: "STABLE_FRAME", access: { status: "ATTACHED_ONLY", coherence: "STABLE_FRAME" } });
    expect(observation.coherence).toBe("STABLE_FRAME");
    expect(observation.factCoherence).toMatchObject({ access: "STABLE_FRAME", utilities: "STABLE_FRAME" });
    expect(observation.factCoherence?.incoherentRefs).toBeUndefined();
  });
});
