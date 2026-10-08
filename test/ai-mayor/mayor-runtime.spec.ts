import type { DeepSeekEstimatedCost } from "../../src/intellichat/telemetry/deepseekCost";
import {
  GROWTH_TARGET_PARK_STRIKE_LIMIT,
  WORK_ORDER_STALL_CYCLES,
  goalOrderUnservableRoadTarget,
  growthFootprintTargetFingerprint,
  growthGoalFactFingerprint,
  MayorRuntime,
} from "../../src/main/services/ai-mayor/runtime";
import { V2GrowableFootprintUnserviceableError } from "../../src/main/services/ai-mayor/v2/project-admission";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";
import type { MayorRuntimePorts } from "../../src/main/services/ai-mayor/types";
import type { LocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/types";
import { planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";

const usage = {
  promptTokens: 800,
  promptCacheHitTokens: 600,
  promptCacheMissTokens: 200,
  completionTokens: 100,
  reasoningTokens: 40,
  totalTokens: 900,
};

const cost: DeepSeekEstimatedCost = {
  currency: "CNY",
  pricingModel: "deepseek-v4-flash",
  pricingPeriod: "offPeak",
  cachedInput: 0.00003,
  uncachedInput: 0.0003,
  output: 0.00045,
  total: 0.00078,
  isEstimate: true,
};

const plan = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "City is stable; wait for measured demand.",
    objective: "Keep the city stable while gathering fresh evidence.",
    rationale: "Current data does not justify a safe construction action.",
    blockingReason: "No validated construction opportunity is available.",
    actions: [],
    simulation: { run: false },
    memoryUpdate: { phase: "stable", nextGoal: "Review demand after simulation" },
    stop: { requested: false },
    ...overrides,
  });

describe("growth Goal lineage facts", () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    worldFingerprint: "snapshot-a",
    population: 1200,
    treasury: 10000,
    monthlyBalance: 250,
    financeRunwayMonths: 10,
    demands: { residential: 72, commercial: 10, industrial: 5, office: 0 },
    actionability: { capacityStatus: "insufficient" },
    developmentCapacity: { reserveStatus: "low", safeUnzonedCells: 2, availableDevelopmentCells: 8,
      zonedUnoccupiedByType: { residential: 3 }, typedReserveDeficit: { residential: true } },
    candidates: { zoning: [{ id: "candidate-a", kind: "zoning", areaType: "residential" }], roadExpansion: [] },
    utilities: {
      electricity: { available: true, risk: "healthy", uncommissioned: false },
      water: { available: true, risk: "healthy", uncommissioned: false },
      sewage: { available: true, risk: "healthy", uncommissioned: false },
    },
    ...overrides,
  }) as unknown as LocalMayorState;

  test("ignores ordinary snapshot churn but changes when growth facts change", () => {
    const initial = growthGoalFactFingerprint("EXPAND_RESIDENTIAL:residential", "RESIDENTIAL", state());
    expect(growthGoalFactFingerprint("EXPAND_RESIDENTIAL:residential", "RESIDENTIAL", state({
      worldFingerprint: "snapshot-b", monthlyBalance: 300,
    }))).toBe(initial);
    expect(growthGoalFactFingerprint("EXPAND_RESIDENTIAL:residential", "RESIDENTIAL", state({ population: 1210 })))
      .not.toBe(initial);
    expect(growthGoalFactFingerprint("EXPAND_RESIDENTIAL:residential", "RESIDENTIAL", state({
      candidates: { zoning: [{ id: "candidate-b", kind: "zoning", areaType: "residential" }], roadExpansion: [] },
    }))).not.toBe(initial);
  });
});

/**
 * A target the land itself disproved is held back by the land, not by the
 * growth policy. Keying it on the same projection as the family park is what
 * made the park useless: the Brain's observation step moves population, demand
 * and the treasury every cycle, so `currentFacts === parkedFacts` never held,
 * the park released on the next tick, and the dead target was re-derived
 * forever — measured live (2026-09-30) as eight ticks, a fresh
 * `ROAD_FRONTAGE` child each one, and a journal that never moved.
 */
describe("growth footprint target facts", () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    population: 1200,
    treasury: 10000,
    financeRunwayMonths: 10,
    demands: { residential: 72, commercial: 10, industrial: 5, office: 0 },
    actionability: { capacityStatus: "insufficient" },
    developmentCapacity: { reserveStatus: "low", safeUnzonedCells: 12, safeUnzonedRoadsideCells: 4,
      existingZonedCells: 131, existingZonedUnoccupiedCells: 20, availableDevelopmentCells: 8,
      developmentDigesting: false },
    candidates: { zoning: [{ id: "candidate-a", kind: "zoning", areaType: "residential" }], roadExpansion: [] },
    utilities: {},
    ...overrides,
  }) as unknown as LocalMayorState;

  test("ignores the global churn that made the family park release every tick", () => {
    const targetKey = "-601.9,-162.0,192.0";
    const initial = growthFootprintTargetFingerprint(targetKey, state());
    expect(growthFootprintTargetFingerprint(targetKey, state({
      population: 1210, treasury: 13000, financeRunwayMonths: 2,
      demands: { residential: 91, commercial: 40, industrial: 30, office: 5 },
      utilities: { sewage: { available: false, risk: "critical", uncommissioned: true } },
    }))).toBe(initial);
  });

  test("changes when the local land facts a zoning decision reads change", () => {
    const targetKey = "-601.9,-162.0,192.0";
    const initial = growthFootprintTargetFingerprint(targetKey, state());
    expect(growthFootprintTargetFingerprint("-580.0,-317.3,192.0", state())).not.toBe(initial);
    expect(growthFootprintTargetFingerprint(targetKey, state({
      developmentCapacity: { reserveStatus: "low", safeUnzonedCells: 3, safeUnzonedRoadsideCells: 4,
        existingZonedCells: 131, existingZonedUnoccupiedCells: 20, availableDevelopmentCells: 8,
        developmentDigesting: false },
    }))).not.toBe(initial);
    expect(growthFootprintTargetFingerprint(targetKey, state({
      candidates: { zoning: [], roadExpansion: [] },
    }))).not.toBe(initial);
  });
});

function createPorts(overrides: Partial<MayorRuntimePorts> = {}) {
  const calls = { decide: 0, snapshot: 0, execute: 0, simulation: 0, pause: 0, save: 0 };
  const ports: MayorRuntimePorts = {
    getBalance: async () => ({
      isAvailable: true,
      currency: "CNY",
      totalBalance: 50,
      grantedBalance: 0,
      toppedUpBalance: 50,
      fetchedAt: new Date().toISOString(),
    }),
    getSnapshot: async () => {
      calls.snapshot++;
      return {
        schemaVersion: "1.1",
        economy: { treasury: 100_000 },
        sample: calls.snapshot,
        planningCatalog: {
          roadPrefabs: ["Small Road"],
          zoneTypes: [{ name: "ResidentialLow" }],
          buildingPrefabs: {},
          roadAnchors: [],
        },
      };
    },
    decide: async () => {
      calls.decide++;
      return { content: plan(), model: "deepseek-chat", usage, estimatedCost: cost };
    },
    executeActions: async (actions) => {
      calls.execute++;
      return { ok: true, requested: actions.length, executed: actions.length, results: [] };
    },
    runSimulation: async () => {
      calls.simulation++;
    },
    pause: async () => {
      calls.pause++;
    },
    save: async () => {
      calls.save++;
    },
    delay: async () => undefined,
    id: () => "session-test",
    ...overrides,
  };
  return { ports, calls };
}

describe("MayorRuntime", () => {
  test("starts and exposes deterministic production runtime without an LLM provider", async () => {
    const readinessContext = {
      state: planStarterResidentialIntent({
        intentId: "no-provider-intent",
        targetResidents: 12,
        maximumBudget: 25_000,
        planningEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
        siteCandidates: [{ id: "site", target: { center: { x: 0, z: 0 }, radius: 30 }, score: 1, blocked: false }],
      }),
      world: {
        worldId: "world:no-provider",
        nativeSessionGuid: "session:no-provider",
        loadPurpose: "LoadGame" as const,
        loadAssetGuid: null,
        saveDataAssetGuid: null,
        mapAssetGuid: null,
        checkpointId: "checkpoint:no-provider",
        bridgeRuntimeEpoch: "bridge:no-provider",
        generation: "generation:no-provider",
        generationSequence: 1,
        generationOrigin: "ATTACHED_EXISTING_WORLD" as const,
        worldEpochId: "epoch:no-provider",
        worldReady: true as const,
      },
      treasury: 25_000,
      certifiedRoad: { entity: { index: 1, version: 1 }, position: { x: 0, z: 0 }, prefab: "Medium Road" },
    };
    readinessContext.state.tranche.stage = "ROAD_DELIVERED";
    let runtime: MayorRuntime | undefined;
    let statusDuringStart: string | undefined;
    const productionRuntime = {
      initialize: jest.fn(() => {
        statusDuringStart = runtime?.getSessionStatus().status;
      }),
      dispose: jest.fn(),
      isInitialized: () => true,
      readiness: jest.fn().mockResolvedValue(readinessContext),
      invalidateReadiness: jest.fn(),
      ensureProjectAdmission: jest.fn(),
      dispatch: jest.fn().mockResolvedValue({ status: "SUCCESS", evidence: [] }),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({
      getBalance: async () => {
        throw new Error("PROVIDER_NOT_CONFIGURED");
      },
      v2ProductionSkillRuntime: productionRuntime,
    });
    runtime = new MayorRuntime(ports);

    expect(runtime.getSessionStatus()).toMatchObject({ status: "OFFLINE", lastError: null, startCallCount: 0, startInFlight: false });

    const started = runtime.start({
      goal: "Run deterministic production readiness",
      maxSessionSpend: 1,
      minimumBalance: 0,
      continuous: false,
    });

    expect(started.status).toBe("running");
    expect(statusDuringStart).toBe("STARTING");
    expect(runtime.getSessionStatus()).toMatchObject({ status: "RUNNING", lastError: null, startCallCount: 1, lastStartResult: "RUNNING" });
    await expect(runtime.productionRuntimeReadiness()).resolves.toMatchObject({ state: readinessContext.state });
    await expect(runtime.productionK05Preflight()).resolves.toMatchObject({ admitted: true });
    // The read-only preflight must carry the same first-placement authority the
    // Skill dispatch path receives. A projection down to state/world/treasury
    // withheld it, so production K05 looked unauthorized at ROAD_DELIVERED.
    const preflight = (await runtime.productionK05Preflight()) as {
      preparation?: { facilityPlacementAuthorization?: unknown };
    };
    expect(preflight.preparation?.facilityPlacementAuthorization).toMatchObject({
      kind: "electricity",
      recipe: "basic-electricity-provision",
      maximumPlacements: 1,
      certifiedRoadRefs: [{ index: 1, version: 1 }],
    });
    await expect(runtime.dispatchProductionSkillIntent({ skillId: "skill.K05" })).resolves.toMatchObject({
      status: "SUCCESS",
    });
    expect(productionRuntime.initialize).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionStatus()).toMatchObject({ status: "RUNNING", lastError: null, startCallCount: 1 });
    expect(runtime.getSessionStatus()).toMatchObject({ status: "RUNNING", lastError: null, startCallCount: 1 });
    await runtime.stop("status test complete");
    expect(runtime.getSessionStatus()).toMatchObject({ status: "STOPPED", lastError: null, startCallCount: 1 });
  });

  describe("a milestone popup pauses the game: every construction cycle looks for it (live 2026-10-04: it stayed up, the game stood paused, the run ledger stopped the session)", () => {
    const builtDistrict = { status: "BUILT", site: null, role: "residential", roadsBuilt: 8, roadsRefused: 0, roadsLanded: 8, zonesPainted: 80, zonesRefused: 0, notes: ["district built"], outcome: "BUILD" };
    const balancedRuntime = (extra: Partial<MayorRuntimePorts>) => {
      const productionRuntime = {
        initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true, invalidateReadiness: jest.fn(),
        ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }), readiness: jest.fn().mockResolvedValue({ state: null }), dispatch: jest.fn(),
      } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
      const runCycle = jest.fn().mockResolvedValue(builtDistrict);
      const order: string[] = [];
      const { ports } = createPorts({
        v2ProductionSkillRuntime: productionRuntime,
        districtBuilder: { runCycle: (...args: unknown[]) => { order.push("district"); return runCycle(...args); } } as unknown as MayorRuntimePorts["districtBuilder"],
        resume: async () => { order.push("resume"); },
        ...extra,
      });
      const runtime = new MayorRuntime(ports);
      runtime.setObjectiveProfile("BALANCED");
      runtime.start({ goal: "Grow", maxSessionSpend: 1, minimumBalance: 0, continuous: false });
      return { runtime, runCycle, order };
    };

    test("a cycle that builds a district (no simulation window follows it any more) still looks for the popup first, every cycle", async () => {
      const order: string[] = [];
      const check = jest.fn(async () => { order.push("modal"); return { allowedToContinue: true, modalClass: "NO_MODAL" }; });
      const { runtime, runCycle, order: builderOrder } = balancedRuntime({ checkBlockingModal: check });
      builderOrder.push = ((...items: string[]) => order.push(...items)) as never;
      await runtime.runAutonomousConstructionCycle();
      await runtime.runAutonomousConstructionCycle();
      expect(check).toHaveBeenCalledTimes(2);
      expect(runCycle).toHaveBeenCalledTimes(2);
      // The popup is dealt with BEFORE the district is laid, each cycle.
      expect(order.filter((step) => step !== "resume")).toEqual(["modal", "district", "modal", "district"]);
    });

    test("a popup the Mayor may not close ends the cycle as BLOCKED and lays nothing", async () => {
      const check = jest.fn(async () => ({ allowedToContinue: false, modalClass: "UNKNOWN_BLOCKING_MODAL" }));
      const { runtime, runCycle } = balancedRuntime({ checkBlockingModal: check });
      await expect(runtime.runAutonomousConstructionCycle()).resolves.toMatchObject({ status: "BLOCKED", stage: "BLOCKING_MODAL", reason: "blocking_modal_guard:UNKNOWN_BLOCKING_MODAL" });
      expect(runCycle).not.toHaveBeenCalled();
    });

    test("control: a look that fails never stops the cycle, and a host with no popup guard builds as before", async () => {
      const failing = balancedRuntime({ checkBlockingModal: async () => { throw new Error("bridge unreachable"); } });
      await failing.runtime.runAutonomousConstructionCycle();
      expect(failing.runCycle).toHaveBeenCalledTimes(1);
      const bare = balancedRuntime({});
      await bare.runtime.runAutonomousConstructionCycle();
      expect(bare.runCycle).toHaveBeenCalledTimes(1);
    });
  });

  test("keeps the standalone construction cycle observing after WAITING until the Brain reaches its milestone", async () => {
    const progression = {
      advanceToStage: jest.fn()
        .mockResolvedValueOnce({ status: "WAITING", stage: "ROAD_DELIVERED", reason: "WAITING_FOR_SERVICE_UPDATE" })
        .mockResolvedValueOnce({ status: "MILESTONE_REACHED", stage: "OCCUPIED", reason: "resident observed" }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(),
      dispose: jest.fn(),
      isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      readiness: jest.fn().mockResolvedValue({ state: null }),
      invalidateReadiness: jest.fn(),
      dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const wait = jest.fn().mockResolvedValue(undefined);
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime, delay: wait });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await expect(runtime.runAutonomousConstructionCycle()).resolves.toMatchObject({ status: "MILESTONE_REACHED", stage: "OCCUPIED" });

    expect(progression.advanceToStage).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    await runtime.stop("test complete");
  });

  /**
   * The burst's own claim is that re-entering progression is BUILDING. That
   * claim is readable from the tranche's position — its stage and each task's
   * kind, status and command id — and when a re-entry leaves that position
   * exactly where it was, the claim is false and the cycle is paying for the
   * same simulation again.
   *
   * Modelled on the live greenfield bootstrap (2026-10-01): the active
   * electricity Goal held a `PENDING` ZONING task whose commission step could
   * only answer `UTILITY_SERVICE_PROGRESS_PENDING` — the turbine it placed never
   * connected — so three burst entries each spent twelve simulation windows
   * (the whole tick, eight minutes) and moved the tranche nowhere, on a map with
   * demand at 100 in every domain and no water or sewage at all.
   *
   * The position deliberately excludes the Gate1 journal: every decision appends
   * to it, so twelve `SIMULATION_PROGRESS` wakes would read as twelve steps.
   */
  const waitingElectricityGoal = (options: {
    commandId: () => string | null;
    journalLength: () => number;
  }) => () => ({
    workOrderId: "goal-work-order:electricity",
    goalId: "PROVIDE_SERVICE:electricity:facts:1",
    status: "ACTIVE",
    completionStage: "WAITING_FOR_OCCUPANCY",
    state: {
      tranche: { stage: "ROAD_DELIVERED" },
      journal: Array.from({ length: options.journalLength() }, (_, index) => ({ id: `journal-${index}` })),
      tasks: [
        { kind: "SITE_SELECTION", status: "SUCCEEDED", activeCommandId: null },
        { kind: "ROAD_CONNECTION", status: "SUCCEEDED", activeCommandId: null },
        { kind: "ZONING", status: "PENDING", activeCommandId: options.commandId() },
      ],
    },
  });

  /**
   * Run one Brain cycle and report which progression entries happened while the
   * cycle believed it was building.
   *
   * Counted from inside `advanceToStage` rather than from the `status` events,
   * because the stalled-work-order branch re-emits `status` without changing
   * `lastStatus`, so one burst entry is announced twice and the event stream
   * cannot tell that from a genuine second entry.
   */
  const runOneCycle = async (
    makeProgression: (building: () => boolean) => NonNullable<MayorRuntimePorts["v2Gate1Progression"]>,
    activeGoalWorkOrder: () => unknown,
  ) => {
    let buildingNow = false;
    const productionRuntime = {
      initialize: jest.fn(),
      dispose: jest.fn(),
      isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockRejectedValue(new Error("NO_OTHER_GOAL_ADMITTED")),
      activeGoalWorkOrder,
      goalWorkOrders: () => [],
      invalidateReadiness: jest.fn(),
      dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({
      v2Gate1Progression: makeProgression(() => buildingNow),
      v2ProductionSkillRuntime: productionRuntime,
      emit: (event, state) => {
        if (event !== "status") return;
        buildingNow = String((state as { lastStatus?: string }).lastStatus ?? "").startsWith("V2 Brain building:");
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });
    try {
      await runtime.runAutonomousConstructionCycle();
    } finally {
      await runtime.stop("test complete");
    }
  };

  test("a build burst that leaves the tranche where it was stops re-entering progression", async () => {
    let decisions = 0;
    const entries: boolean[] = [];
    await runOneCycle((building) => ({
      advanceToStage: jest.fn().mockImplementation(async () => {
        decisions += 1;
        entries.push(building());
        // Every decision appends a journal entry, so the journal grows on every
        // burst entry while nothing the tranche actually IS changes.
        return { status: "EXHAUSTED", stage: "ROAD_DELIVERED",
          reason: "Gate 1 progression exceeded 12 decisions without reaching WAITING_FOR_OCCUPANCY" };
      }),
      snapshot: () => null,
    }), waitingElectricityGoal({ commandId: () => null, journalLength: () => decisions }));

    expect(entries.filter(Boolean)).toHaveLength(1);
  });

  test("a build burst keeps re-entering progression while the tranche is still moving", async () => {
    let decisions = 0;
    const entries: boolean[] = [];
    await runOneCycle((building) => ({
      advanceToStage: jest.fn().mockImplementation(async () => {
        decisions += 1;
        entries.push(building());
        return { status: "EXHAUSTED", stage: "ROAD_DELIVERED", reason: "still taking steps" };
      }),
      snapshot: () => null,
    }), waitingElectricityGoal({ commandId: () => `command-${decisions}`, journalLength: () => decisions }));

    expect(entries.filter(Boolean)).toHaveLength(3);
  });

  /**
   * A wait another operation's construction answers must not spend the city's
   * simulation windows.
   *
   * Measured live (2026-10-01): a base `PROVIDE_SERVICE:electricity` Goal held
   * the Brain for the whole run — 4/4 ticks blocked, 48/48 simulation windows
   * burned, zero mutations — waiting for `NO_ATTRIBUTED_BUILDING`. That wake now
   * says the fact comes from another tranche's construction, so the cycle's
   * outer wait loop must end the cycle rather than run the world for an answer
   * the clock does not hold. `AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS` (4) used to
   * be spent here on every cycle, for this one Goal.
   */
  test("a wait on another operation's construction spends no simulation windows", async () => {
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({
        status: "WAITING",
        stage: "ROAD_DELIVERED",
        reason: "GATE1_WAITING_ON_DEPENDENT_WORK:UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING",
        wake: { condition: "DEPENDENT_CONSTRUCTION", detail: "wait for another tranche's attributable building" },
      }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(),
      dispose: jest.fn(),
      isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockRejectedValue(new Error("NO_OTHER_GOAL_ADMITTED")),
      activeGoalWorkOrder: waitingElectricityGoal({ commandId: () => null, journalLength: () => 0 }),
      goalWorkOrders: () => [],
      invalidateReadiness: jest.fn(),
      dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });
    let result: { reason?: string } | undefined;
    try {
      result = await runtime.runAutonomousConstructionCycle() as { reason?: string };
    } finally {
      await runtime.stop("test complete");
    }

    // At most the growth policy's own single bounded observation — the wait loop
    // contributes ZERO. It used to spend `AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS`
    // (4) here on every cycle for this one Goal.
    expect(calls.simulation).toBeLessThanOrEqual(1);
    // Named for what it is: a local wait, not an exhausted simulation budget.
    expect(result?.reason ?? "").toContain("AUTONOMOUS_CONSTRUCTION_LOCAL_WAIT:");
    expect(result?.reason ?? "").toContain("GATE1_WAITING_ON_DEPENDENT_WORK:");
    expect(result?.reason ?? "").not.toContain("AUTONOMOUS_CONSTRUCTION_WAIT_BUDGET_EXHAUSTED:");
  });

  test("completes a Road prerequisite at ROAD_DELIVERED and resumes its parent Goal", async () => {
    const progression = {
      advanceToStage: jest.fn()
        .mockResolvedValueOnce({ status: "MILESTONE_REACHED", stage: "ROAD_DELIVERED", reason: "road read back" })
        .mockResolvedValueOnce({ status: "MILESTONE_REACHED", stage: "OCCUPIED", reason: "parent reached its milestone" }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const prerequisite = { goalId: "water:road-prerequisite:1", parentGoalId: "water:site:1",
      completionStage: "ROAD_DELIVERED", state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } } };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValueOnce(prerequisite).mockReturnValueOnce(prerequisite).mockReturnValueOnce(null),
      completeGoalWorkOrder: jest.fn(),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await expect(runtime.runAutonomousConstructionCycle()).resolves.toMatchObject({ status: "MILESTONE_REACHED", stage: "OCCUPIED" });
    expect(progression.advanceToStage).toHaveBeenNthCalledWith(1, "ROAD_DELIVERED", expect.any(AbortSignal));
    expect(progression.advanceToStage).toHaveBeenNthCalledWith(2, "OCCUPIED", expect.any(AbortSignal));
    expect(productionRuntime.completeGoalWorkOrder).toHaveBeenCalledWith(prerequisite.goalId);
    expect(productionRuntime.ensureGoalWorkOrder).toHaveBeenCalledWith(
      { goalId: prerequisite.parentGoalId }, expect.any(AbortSignal),
    );
    await runtime.stop("test complete");
  });

  test.each([
    { landUse: "RESIDENTIAL" as const, source: "durable parent" },
    { landUse: "COMMERCIAL" as const, source: "child handoff metadata" },
    { landUse: "RESIDENTIAL" as const, source: "canonical parent Goal id" },
    { landUse: "COMMERCIAL" as const, source: "canonical parent Goal id" },
  ])("resumes a $landUse parent from $source after ROAD_FRONTAGE", async ({ landUse, source }) => {
    const progression = {
      advanceToStage: jest.fn()
        .mockResolvedValueOnce({ status: "MILESTONE_REACHED", stage: "ROAD_DELIVERED", reason: "road read back" })
        .mockResolvedValueOnce({ status: "MILESTONE_REACHED", stage: "OCCUPIED", reason: "parent reached its milestone" }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const parentGoalId = landUse === "RESIDENTIAL"
      ? "EXPAND_RESIDENTIAL:residential:facts:parent"
      : "EXPAND_COMMERCIAL:commercial:facts:parent";
    const child = { goalId: `${parentGoalId}:prerequisite:ROAD_FRONTAGE:1:child`, parentGoalId,
      ...(source === "child handoff metadata" ? { parentLandUse: landUse } : {}),
      completionStage: "ROAD_DELIVERED", status: "ACTIVE",
      state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } } };
    const parent = { goalId: parentGoalId, state: { districtPlan: { landUse } } };
    const root = { goalId: parentGoalId, completionStage: "OCCUPIED",
      state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } } };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      activeGoalWorkOrder: jest.fn()
        .mockReturnValueOnce(child).mockReturnValueOnce(child).mockReturnValueOnce(root).mockReturnValueOnce(null),
      goalWorkOrders: jest.fn().mockReturnValue(source === "durable parent" ? [parent, child] : [child]),
      completeGoalWorkOrder: jest.fn(),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await expect(runtime.runAutonomousConstructionCycle()).resolves.toMatchObject({
      status: "MILESTONE_REACHED", stage: "OCCUPIED",
    });

    expect(productionRuntime.completeGoalWorkOrder).toHaveBeenCalledWith(child.goalId);
    expect(productionRuntime.ensureGoalWorkOrder).toHaveBeenCalledWith(
      { goalId: parentGoalId, landUse }, expect.any(AbortSignal),
    );
    await runtime.stop("test complete");
  });

  test("closes a root Road Goal at ROAD_DELIVERED so a fixed command can admit the next Goal", async () => {
    const progression = {
      advanceToStage: jest.fn()
        .mockResolvedValueOnce({ status: "MILESTONE_REACHED", stage: "ROAD_DELIVERED", reason: "road read back" })
        .mockResolvedValue({ status: "WAITING", stage: "SITE_SELECTED", reason: "next Goal is bounded" }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const roadGoal = { goalId: "ESTABLISH_ROAD_NETWORK:facts:before", completionStage: "ROAD_DELIVERED",
      state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } } };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValueOnce(roadGoal).mockReturnValueOnce(roadGoal).mockReturnValue(null),
      completeGoalWorkOrder: jest.fn(),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const commentary: Array<{ text: string }> = [];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime,
      emitMayorCommentary: (line) => commentary.push(line) });
    ports.decide = jest.fn(async () => ({ content: plan(), model: "never-called", usage, estimatedCost: cost }));
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });
    runtime.setPendingUserCommand({ text: "Grid roads", source: "text",
      structuredIntent: { kind: "GOAL", type: "ESTABLISH_ROAD_NETWORK", priority: "NORMAL" } });

    await runtime.runAutonomousConstructionCycle();

    expect(productionRuntime.completeGoalWorkOrder).toHaveBeenCalledWith(roadGoal.goalId);
    expect(productionRuntime.ensureGoalWorkOrder).toHaveBeenCalledWith(
      { goalId: expect.stringMatching(/^ESTABLISH_ROAD_NETWORK:facts:/), landUse: "RESIDENTIAL", completionStage: "ROAD_DELIVERED" },
      expect.any(AbortSignal),
    );
    expect(ports.decide).not.toHaveBeenCalled();
    expect(commentary.map((line) => line.text)).not.toContain("按网格往外接。");
    await runtime.stop("test complete");
  });

  test("does not advance a parent while its child work order is RECONCILING", async () => {
    const progressionResult = { status: "BLOCKED", stage: "SITE_SELECTED", reason: "terminal outcome not proven",
      state: { project: { status: "ACTIVE" }, intent: { id: "road-child" } } };
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue(progressionResult),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const reconciliation = jest.fn();
    const child = { goalId: "water:road-prerequisite:1", parentGoalId: "water:site:1",
      completionStage: "ROAD_DELIVERED", status: "RECONCILING",
      state: { project: { status: "ACTIVE" }, tranche: { stage: "SITE_SELECTED" } } };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(child),
      completeGoalWorkOrder: jest.fn(),
      recordGate1ProgressionOutcome: reconciliation,
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await expect(runtime.runAutonomousConstructionCycle()).resolves.toMatchObject({ status: "BLOCKED", reason: "terminal outcome not proven" });

    expect(reconciliation).toHaveBeenCalledWith(progressionResult);
    expect(productionRuntime.ensureGoalWorkOrder).not.toHaveBeenCalled();
    expect(productionRuntime.completeGoalWorkOrder).not.toHaveBeenCalled();
    await runtime.stop("test complete");
  });

  test("a terminally closed root Goal does not stop the city", async () => {
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({ status: "BLOCKED", stage: "SITE_SELECTED", reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED" }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const closedGoal = { goalId: "UTILITY_SERVICE:water:city:site_scope:2", status: "BLOCKED",
      completionStage: "ROAD_DELIVERED", state: { project: { status: "ACTIVE" }, tranche: { stage: "SITE_SELECTED" } } };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(closedGoal),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });

    await runtime.singleTick();

    // The closed Goal is not where the Brain stops. It hands the decision to the
    // growth policy, which — with no demand yet in this fixture — answers
    // "observe", so the city is run rather than abandoned. Without this the
    // closed Goal stays the active work order and every later cycle advances
    // nothing at all.
    expect(calls.simulation).toBeGreaterThanOrEqual(1);
    await runtime.stop("test complete");
  });

  test("a completed Goal hands the Brain to the growth policy instead of owning it", async () => {
    // The first project reaching OCCUPIED closes its work order, but that work
    // order stays the ACTIVE one by identity until a successor replaces it.
    // Treating its presence as "a live Goal owns the Brain" would end the city
    // at exactly the moment it became worth growing further.
    const completedState = { project: { status: "COMPLETE" }, intent: { id: "completed-goal", status: "SATISFIED" },
      tranche: { stage: "OCCUPIED" } };
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({
        status: "BLOCKED", stage: "OCCUPIED", reason: "project completed; next decision ready", state: completedState,
      }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const completedGoal = { goalId: "EXPAND_RESIDENTIAL:residential:facts:fp", workOrderId: "goal-work-order:done",
      status: "COMPLETE", state: completedState };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(completedGoal),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await runtime.runAutonomousConstructionCycle();

    expect(calls.simulation).toBeGreaterThanOrEqual(1);
    expect(progression.advanceToStage.mock.calls.length).toBeGreaterThanOrEqual(2);
    await runtime.stop("test complete");
  });

  /**
   * The commissioning pass used to be reachable only from a tranche whose
   * milestone was at or beyond ZONED_WAITING_FOR_BUILDING, which a bounded
   * prerequisite step — stopping at ROAD_DELIVERED, with that as its own
   * milestone — can never reach. The Goal whose prerequisite had just run out
   * therefore never learned its service work was spent, and every cycle
   * re-derived the same doomed corridor.
   */
  test("a spent prerequisite asks the service Goals before the policy answers again", async () => {
    const blockedChild = { goalId: "UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa",
      workOrderId: "goal-work-order:spent-step", status: "BLOCKED", parentGoalId: "UTILITY_SERVICE:water:city:site_scope:1",
      completionStage: "ROAD_DELIVERED", releasedReservationAt: "2026-01-01T00:00:00.000Z",
      state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } } };
    const serviceWorkOrder = { goalId: "PROVIDE_SERVICE:electricity:facts:fp", workOrderId: "goal-work-order:service",
      status: "ACTIVE", state: { project: { status: "ACTIVE" }, tranche: { stage: "PLANNED" } } };
    let active: unknown = blockedChild;
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({
        status: "BLOCKED", stage: "ROAD_DELIVERED",
        reason: "GOAL_PREREQUISITE_ALREADY_SPENT:UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa",
        state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } },
      }),
      settleUtilityGoals: jest.fn(async () => {
        // The pass took the service Goal's bounded turn and admitted a work
        // order for it, which is now the Brain's.
        active = serviceWorkOrder;
        return { status: "PLANNING_HANDOFF", reason: "GOAL_WORK_ORDER_ACTIVATED:PROVIDE_SERVICE:electricity:facts:fp" };
      }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockRejectedValue(
        new Error("GOAL_PREREQUISITE_ALREADY_SPENT:UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa")),
      activeGoalWorkOrder: jest.fn(() => active),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await runtime.runAutonomousConstructionCycle();

    expect(progression.settleUtilityGoals).toHaveBeenCalledTimes(1);
    // The service work order the pass admitted is advanced, not handed back to
    // the policy that would have re-derived the spent corridor.
    expect(progression.advanceToStage).toHaveBeenNthCalledWith(2, "OCCUPIED", expect.any(AbortSignal));
    await runtime.stop("test complete");
  });

  test("a project that closed for planning does not veto the Goal that replaces it", async () => {
    // The exact shape the live blocker left: Gate1 recorded the ZONING step as a
    // bounded terminal, so the durable project is BLOCKED and the work order is
    // closed — but it is still the ACTIVE work order until its successor
    // replaces it. Reading mere presence as "a live Goal owns the Brain" made
    // one un-zoneable reservation veto the admission of its own successor, and
    // the city sat behind it forever.
    const blockedState = { project: { status: "BLOCKED" }, intent: { id: "closed-goal" },
      tranche: { stage: "ROAD_DELIVERED" } };
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({
        status: "BLOCKED", stage: "ROAD_DELIVERED",
        reason: "Gate 1 blocked by ZONING_RESERVATION_DEAD_END: GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET",
        state: blockedState,
      }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const closedGoal = { goalId: "EXPAND_RESIDENTIAL:residential:facts:fp", workOrderId: "goal-work-order:closed",
      status: "BLOCKED", releasedReservationAt: "2026-01-01T00:00:00.000Z", state: blockedState };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(closedGoal),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await runtime.runAutonomousConstructionCycle();

    // The growth policy was consulted from fresh facts instead of being refused
    // by the closed Goal, which means the city was let run — the facts the next
    // Goal is derived from only move while the simulation does.
    expect(calls.simulation).toBeGreaterThanOrEqual(1);
    // And the closed chain handed off rather than ending the cycle: progression
    // is re-entered for whatever the policy admits next.
    expect(progression.advanceToStage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runtime.getState()?.status).toBe("running");
    await runtime.stop("test complete");
  });

  test("a proven missing Road target parks its unchanged growable Goal before a successor is admitted", async () => {
    const growthSnapshot = { schemaVersion: "1.1", economy: { treasury: 100_000 }, sample: 1,
      planningCatalog: { roadPrefabs: ["Small Road"], zoneTypes: [{ name: "ResidentialLow" }], buildingPrefabs: {}, roadAnchors: [] } };
    const fingerprint = growthGoalFactFingerprint("EXPAND_RESIDENTIAL:residential", "RESIDENTIAL",
      compileLocalMayorState(growthSnapshot));
    const blockedState = { project: { status: "BLOCKED" }, intent: { id: "closed-road-goal" },
      tranche: { stage: "SITE_SELECTED" }, journal: [{
        failureClassification: "ROAD_SITE_TARGET_NOT_REPRODUCED",
        reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED:CANDIDATE_COUNT:0",
      }] };
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({ status: "BLOCKED", stage: "SITE_SELECTED",
        reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED:CANDIDATE_COUNT:0", state: blockedState }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const blockedGoal = { goalId: `EXPAND_RESIDENTIAL:residential:facts:${fingerprint}`, workOrderId: "goal-work-order:target-blocked",
      status: "BLOCKED", releasedReservationAt: "2026-09-30T00:00:00.000Z", state: blockedState };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(blockedGoal),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });

    await runtime.runAutonomousConstructionCycle();

    const admittedGoals = (productionRuntime.ensureGoalWorkOrder as jest.Mock).mock.calls.map(([input]) => input.goalId as string);
    expect(admittedGoals.every((goalId) => !goalId.startsWith("EXPAND_RESIDENTIAL:residential"))).toBe(true);
    // The parked domain is not retried; the Brain either lets the city run or opens the frontier (the survey for
    // open owned land no road reaches), and never idles on a refused domain.
    expect(calls.simulation > 0 || admittedGoals.some((goalId) => goalId.startsWith("ESTABLISH_ROAD_NETWORK"))).toBe(true);
    await runtime.stop("test complete");
  });

  /**
   * When the land itself is the finding, the family is not what should be held
   * back — the region is. This is the live shape: a growth Goal whose census
   * holds valid, owned, in-band footprints that another Goal's reservation
   * covers, so the admission refuses by name and raises no Road prerequisite.
   * The park must hold across the next cycle (a global facts key would release
   * immediately, which is the loop) and must not stop the Brain from asking for
   * the same family somewhere else later.
   */
  test("a target the land disproved parks its admission instead of re-deriving it every cycle", async () => {
    // The world facts the growth policy reads: a city that needs residential
    // land and has too little of it. Without them the local Brain answers
    // ADVANCE_SIMULATION and no growable Goal is ever derived, which is what
    // made the older cycle-level park test assert on an empty admission list.
    const growthSnapshot = { schemaVersion: "1.1",
      game: { paused: true },
      population: { current: 1_200 },
      economy: { treasury: 100_000, monthlyBalance: 500 },
      demand: { residential: 72, commercial: 10, industrial: 5, office: 0 },
      utilities: {
        electricity: { production: 100, consumption: 50 },
        water: { capacity: 100, consumption: 50 },
        sewage: { capacity: 100, consumption: 50 },
      },
      actionablePlanning: { status: "available", candidates: [] },
      developmentCapacity: { reserveStatus: "low", pendingZoningCells: 0, pendingFrontageCapacity: 0 },
      planningCatalog: { roadPrefabs: ["Small Road"], zoneTypes: [{ name: "ResidentialLow" }], buildingPrefabs: {}, roadAnchors: [] } };
    const blockedState = { project: { status: "BLOCKED" }, intent: { id: "closed-growth-goal" },
      tranche: { stage: "SITE_SELECTED" }, journal: [] };
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({ status: "BLOCKED", stage: "SITE_SELECTED",
        reason: "PROJECT_ADMISSION_GROWABLE_FOOTPRINT_UNSERVICEABLE", state: blockedState }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const closedGoal = { goalId: "goal-work-order:closed-growth", status: "BLOCKED",
      releasedReservationAt: "2026-09-30T00:00:00.000Z", state: blockedState };
    const target = { center: { x: -601.9, z: -162.0 }, radius: 192 };
    const subjectKey = "-601.9,-162.0,192.0";
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockRejectedValue(new V2GrowableFootprintUnserviceableError({
        reason: "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION",
        evidence: { reason: "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION", frontageCells: 119,
          unprotectedFootprints: 4, ownedFootprints: 4 },
        target, subjectKey,
      })),
      activeGoalWorkOrder: jest.fn().mockReturnValue(closedGoal),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const snapshotter = ports.getSnapshot;
    ports.getSnapshot = async (signal?: AbortSignal) => ({ ...(await snapshotter(signal)) as object, ...growthSnapshot });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });

    await runtime.runAutonomousConstructionCycle();
    const attempted = (productionRuntime.ensureGoalWorkOrder as jest.Mock).mock.calls
      .map(([input]) => input.goalId as string)
      .filter((goalId) => goalId.startsWith("EXPAND_"));
    expect(attempted).toHaveLength(1);
    const [goalId] = attempted;
    expect(goalId).toMatch(/^EXPAND_RESIDENTIAL:residential:facts:[a-f0-9]{12}$/);

    const attempts = () => (productionRuntime.ensureGoalWorkOrder as jest.Mock).mock.calls
      .map(([input]) => input.goalId as string)
      .filter((candidate) => candidate.startsWith("EXPAND_"));

    // A second cycle reads the same unchanged land. One dead target is not
    // proof that the whole domain is unavailable, and it must never leave the
    // Brain with nothing to do while a legitimate growth opportunity exists, so
    // the family is released to try another candidate or site.
    await runtime.runAutonomousConstructionCycle();
    expect(attempts()).toHaveLength(2);
    expect(attempts()[1]).toBe(goalId);

    // Bounded all the same: once GROWTH_TARGET_PARK_STRIKE_LIMIT admissions
    // have died on exactly this ground, the domain rather than one target is
    // the finding, and the family is held back on the land facts.
    for (let cycle = 0; cycle < GROWTH_TARGET_PARK_STRIKE_LIMIT; cycle += 1) {
      await runtime.runAutonomousConstructionCycle();
    }
    const settledAttempts = attempts().length;
    expect(settledAttempts).toBeGreaterThanOrEqual(GROWTH_TARGET_PARK_STRIKE_LIMIT);
    // A parked family stops being re-derived: another unchanged cycle adds no
    // attempt at all.
    await runtime.runAutonomousConstructionCycle();
    expect(attempts()).toHaveLength(settledAttempts);

    // The park is a memory about land, so land changing releases it. A zoning
    // candidate appearing in the census is exactly that — and it is the only
    // thing here that is: population, demand and the treasury already moved
    // between the earlier cycles and did not release the park.
    ports.getSnapshot = async (signal?: AbortSignal) => ({ ...(await snapshotter(signal)) as object, ...growthSnapshot,
      actionablePlanning: { status: "available", candidates: [
        { id: "candidate-land-changed", actionType: "zone", areaType: "Residential", approximateCells: 12 }] } });
    await runtime.runAutonomousConstructionCycle();
    const attemptedAfterChange = attempts().slice(settledAttempts);
    // The cycle resumes the parked family, and — because buildable room now
    // exists for every domain — does not stop at the first domain whose
    // admission refuses. It walks the other expansion domains in the same cycle.
    // That fallback is the product's answer to "one dead target used to mean an
    // idle Mayor": the refusal is a finding about one domain, so the city tries
    // the next instead of yielding.
    expect(attemptedAfterChange[0]).toMatch(/^EXPAND_RESIDENTIAL:residential:facts:/);
    expect(attemptedAfterChange.length).toBeGreaterThan(1);
    expect(new Set(attemptedAfterChange.map((candidate) => candidate.split(":")[0])).size).toBeGreaterThan(1);
    expect(attemptedAfterChange.at(-1)).not.toBe(goalId);

    expect(runtime.getState()?.status).toBe("running");
    await runtime.stop("test complete");
  });

  /**
   * The measured live freeze (2026-09-30): a commercial work order carried over
   * from an earlier session sat at `ROAD_DELIVERED` with its journal frozen,
   * returning EXHAUSTED to the wait loop every cycle. It never reached its
   * milestone, so it never closed; and because it never closed, the whole
   * goal-pursuit path was skipped and no other expansion domain was ever asked
   * for. Two independent runs, eight Brain cycles each, zero native mutations —
   * while residential, industrial and office all had land.
   *
   * A work order is a bounded attempt, not a veto over the city. One that
   * produces no durable progress at all stops owning the Brain.
   */
  test("a work order that stops moving stops owning the Brain", async () => {
    const growthSnapshot = { schemaVersion: "1.1",
      game: { paused: true },
      population: { current: 1_200 },
      economy: { treasury: 100_000, monthlyBalance: 500 },
      demand: { residential: 72, commercial: 64, industrial: 0, office: 0 },
      utilities: {
        electricity: { production: 100, consumption: 50 },
        water: { capacity: 100, consumption: 50 },
        sewage: { capacity: 100, consumption: 50 },
      },
      actionablePlanning: { status: "available", candidates: [] },
      developmentCapacity: { reserveStatus: "low", pendingZoningCells: 0, pendingFrontageCapacity: 0 },
      planningCatalog: { roadPrefabs: ["Small Road"], zoneTypes: [{ name: "ResidentialLow" }], buildingPrefabs: {}, roadAnchors: [] } };
    // ACTIVE, unreleased, milestone unreached — the shape that made the work
    // order un-closable and therefore un-displaceable.
    const stalledState = { project: { status: "ACTIVE" }, intent: { id: "stalled-goal" },
      tranche: { stage: "ROAD_DELIVERED" }, journal: [], tasks: [] };
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({ status: "EXHAUSTED", stage: "ROAD_DELIVERED",
        reason: "GATE1_PROGRESSION_DECISION_BUDGET_EXHAUSTED", state: stalledState }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const stalledWorkOrder = { workOrderId: "goal-work-order:stalled",
      goalId: "EXPAND_RESIDENTIAL:residential:facts:aaaa11112222", status: "ACTIVE",
      releasedReservationAt: null, completionStage: "WAITING_FOR_OCCUPANCY", state: stalledState };
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ALREADY_ADMITTED" }),
      ensureGoalWorkOrder: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(stalledWorkOrder),
      completeGoalWorkOrder: jest.fn(),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const snapshotter = ports.getSnapshot;
    ports.getSnapshot = async (signal?: AbortSignal) => ({ ...(await snapshotter(signal)) as object, ...growthSnapshot });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });
    const attempted = () => (productionRuntime.ensureGoalWorkOrder as jest.Mock).mock.calls
      .map(([input]) => input.goalId as string);

    // While the work order is merely slow, it still owns the Brain: nothing else
    // is admitted, which is the correct behaviour for a Goal that is progressing.
    // The first cycle establishes the baseline it is compared against, so the
    // bound is reached on the cycle after that many unchanged observations.
    for (let cycle = 0; cycle < WORK_ORDER_STALL_CYCLES; cycle += 1) {
      await runtime.runAutonomousConstructionCycle();
    }
    expect(attempted()).toEqual([]);

    // Past the bound it stops owning the Brain, and the city carries on without
    // it — at another domain, because the stalled Goal is suppressed for exactly
    // as long as it is stalled.
    await runtime.runAutonomousConstructionCycle();
    expect(attempted().length).toBeGreaterThan(0);
    expect(attempted().every((goalId) => !goalId.startsWith("EXPAND_RESIDENTIAL"))).toBe(true);

    await runtime.stop("test complete");
  });

  test("a Road prerequisite child speaks for its parent's family when its courses are exhausted", () => {
    // Live 2026-09-30: the parent Goal's admission was answered by a ROAD_FRONTAGE
    // prerequisite, so no parent work order ever existed and the family was
    // re-derived every tick — four parents, two blocked children each, no Apply.
    const parentGoalId = "EXPAND_RESIDENTIAL:residential:facts:81f86e2c3d75";
    const child = { goalId: `${parentGoalId}:prerequisite:ROAD_FRONTAGE:1:29de24844ac5772d`,
      parentGoalId, status: "BLOCKED", state: { journal: [{
        failureClassification: "ROAD_PREFLIGHT_REJECTED",
        reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:341536:757:end:NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED",
      }] } };
    expect(goalOrderUnservableRoadTarget(child)).toEqual({
      goalFamily: "EXPAND_RESIDENTIAL", factsFingerprint: "81f86e2c3d75" });
  });

  test("a Road dead end is still read from the parent Goal's own step", () => {
    const root = { goalId: "EXPAND_RESIDENTIAL:residential:facts:7496938ba4bb", status: "BLOCKED",
      state: { journal: [{ failureClassification: "ROAD_SITE_TARGET_NOT_REPRODUCED",
        reason: "GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED:CANDIDATE_COUNT:0" }] } };
    expect(goalOrderUnservableRoadTarget(root)).toEqual({
      goalFamily: "EXPAND_RESIDENTIAL", factsFingerprint: "7496938ba4bb" });
  });

  test("a service Goal's Road dead end is remembered under its own Goal id", () => {
    const root = { goalId: "PROVIDE_SERVICE:electricity:facts:f18115fceac9", status: "BLOCKED",
      state: { journal: [{ failureClassification: "ROAD_PREFLIGHT_REJECTED",
        reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:233538:1:end:NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" }] } };
    expect(goalOrderUnservableRoadTarget(root)).toEqual({
      goalFamily: "PROVIDE_SERVICE:electricity", factsFingerprint: "f18115fceac9" });
    const child = { goalId: `${root.goalId}:prerequisite:ROAD_ACCESS:1:29de24844ac5772d`, parentGoalId: root.goalId,
      status: "BLOCKED", state: root.state };
    expect(goalOrderUnservableRoadTarget(child)?.goalFamily).toBe("PROVIDE_SERVICE:electricity");
  });

  test("a prerequisite child blocked on anything but a Road dead end parks nothing", () => {
    const parentGoalId = "EXPAND_RESIDENTIAL:residential:facts:81f86e2c3d75";
    const child = { goalId: `${parentGoalId}:prerequisite:ROAD_FRONTAGE:1:29de24844ac5772d`,
      parentGoalId, status: "BLOCKED", state: { journal: [{
        failureClassification: "ADMISSION_REJECTED", reason: "PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN" }] } };
    expect(goalOrderUnservableRoadTarget(child)).toBeNull();
  });

  test("an unrelated blocked order and an unblocked Road dead end park nothing", () => {
    expect(goalOrderUnservableRoadTarget({ goalId: "ESTABLISH_ROAD_NETWORK:facts:abc", status: "BLOCKED",
      state: { journal: [{ reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE" }] } })).toBeNull();
    expect(goalOrderUnservableRoadTarget({
      goalId: "EXPAND_RESIDENTIAL:residential:facts:81f86e2c3d75", status: "COMPLETE",
      state: { journal: [{ reason: "NO_FEASIBLE_GATE1_ROAD_CANDIDATE" }] } })).toBeNull();
  });

  test("a Brain session is not stopped by an unavailable model-provider balance", async () => {
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({ status: "BLOCKED", stage: "SITE_SELECTED", reason: "no legal candidate" }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(null),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({
      v2Gate1Progression: progression,
      v2ProductionSkillRuntime: productionRuntime,
      getBalance: async () => { throw new Error("DeepSeek balance request failed (HTTP 401)"); },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });

    await runtime.singleTick();

    // The Brain spends nothing on a model provider, so a missing provider
    // credential is not a reason for the city's mayor to stop working.
    expect(runtime.getState()?.status).toBe("running");
    await runtime.stop("test complete");
  });

  test("observes the city instead of idling when there is nothing left to advance", async () => {
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({
        status: "MILESTONE_REACHED", stage: "OCCUPIED",
        state: { project: { status: "COMPLETE" }, tranche: { stage: "OCCUPIED" } },
      }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(null),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await runtime.runAutonomousConstructionCycle();

    // With no Goal left open, the Brain's action is to let the city run: the
    // facts the next Goal is derived from (occupancy, demand, service load) only
    // move while the simulation does. Idling silently is what freezes a city.
    expect(calls.simulation).toBe(1);
    await runtime.stop("test complete");
  });

  test("an orphaned ROAD_DELIVERED project with no work order is a finished plan, so the growth policy is asked", async () => {
    const progression = {
      advanceToStage: jest.fn().mockResolvedValue({
        status: "BLOCKED", stage: "ROAD_DELIVERED",
        reason: "Gate 1 liveness invariant violated: ROAD_DELIVERED has no executable task",
        state: { project: { status: "ACTIVE" }, tranche: { stage: "ROAD_DELIVERED" } },
      }),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      activeGoalWorkOrder: jest.fn().mockReturnValue(null),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports, calls } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false });

    await runtime.runAutonomousConstructionCycle();

    // Before the fix the cycle ended on the invariant and never reached the policy, which is what lets the city run.
    expect(calls.simulation).toBe(1);
    await runtime.stop("test complete");
  });

  test("an ordinary Brain failure is reported and the session keeps running", async () => {
    const progression = {
      advanceToStage: jest.fn().mockRejectedValue(new Error("GOAL_PREREQUISITE_STEP_BUDGET_EXHAUSTED:water")),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });

    await runtime.singleTick();
    const state = runtime.getState();
    expect(state?.status).toBe("running");
    expect(state?.lastStatus).toContain("V2 Brain failure (1/6)");
    await runtime.stop("test complete");
  });

  test("stops the session when the same Brain failure repeats unchanged", async () => {
    const progression = {
      advanceToStage: jest.fn().mockRejectedValue(new Error("PROJECT_ADMISSION_NO_ELIGIBLE_SITE")),
      snapshot: () => null,
    } as unknown as MayorRuntimePorts["v2Gate1Progression"];
    const productionRuntime = {
      initialize: jest.fn(), dispose: jest.fn(), isInitialized: () => true,
      ensureProjectAdmission: jest.fn().mockResolvedValue({ status: "ADMITTED" }),
      readiness: jest.fn().mockResolvedValue({ state: null }), invalidateReadiness: jest.fn(), dispatch: jest.fn(),
    } as unknown as MayorRuntimePorts["v2ProductionSkillRuntime"];
    const { ports } = createPorts({ v2Gate1Progression: progression, v2ProductionSkillRuntime: productionRuntime });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Continue construction", maxSessionSpend: 1, minimumBalance: 0, continuous: false, decisionMode: "local" });

    for (let cycle = 0; cycle < 6; cycle += 1) await runtime.singleTick();

    const state = runtime.getState();
    expect(state?.status).toBe("stopped");
    expect(state?.stopReason).toContain("6 identical failures");
  });

  test("reports FAILED with an authoritative error when start fails", () => {
    const { ports } = createPorts();
    const runtime = new MayorRuntime(ports);

    expect(() =>
      runtime.start({ goal: "", maxSessionSpend: 1, minimumBalance: 0, continuous: false }),
    ).toThrow("Mayor goal is required");
    expect(runtime.getSessionStatus()).toMatchObject({ status: "FAILED", lastError: "Mayor goal is required", startCallCount: 1, lastStartResult: "FAILED" });
  });

  test("runs ten bounded ticks with one decision request each and no history growth", async () => {
    const { ports, calls } = createPorts();
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2, tickDelayMs: 0 });
    for (let index = 0; index < 10; index++) await runtime.singleTick();

    const state = runtime.getState();
    expect(state).not.toBeNull();
    if (!state) throw new Error("expected Mayor state");
    expect(state.tickCount).toBe(10);
    expect(calls.decide).toBe(10);
    expect(state.telemetryTotals.apiRequestCount).toBe(10);
    expect(state.recentTickTelemetry.every((tick) => tick.apiRequestCount === 1)).toBe(true);
    const promptSizes = state.recentTickTelemetry.map((tick) => tick.promptBytes);
    expect(Math.max(...promptSizes) - Math.min(...promptSizes)).toBeLessThan(400);
    expect(state.recentTickTelemetry.every((tick) => tick.mayorMemoryBytes <= 4_096)).toBe(true);
  });

  test("carries persistent demand and prior no-op into the next bounded prompt", async () => {
    const prompts: string[] = [];
    const { ports, calls } = createPorts({
      getSnapshot: async () => {
        calls.snapshot++;
        return {
          schemaVersion: "1.2",
          population: { current: 5 },
          economy: { treasury: 100_000 - calls.snapshot * 100 },
          demand: { residential: { low: 0, medium: 0, high: 0 }, commercial: 100, industrial: 100, office: 0 },
          planningCatalog: { roadPrefabs: [], zoneTypes: [], buildingPrefabs: {}, roadAnchors: [] },
          actionablePlanning: { status: "available", candidates: [] },
        };
      },
      decide: async (input) => {
        calls.decide++;
        prompts.push(input.userPrompt);
        return { content: plan(), model: "deepseek-chat", usage, estimatedCost: cost };
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Manage independently", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.singleTick();
    await runtime.singleTick();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"commercial":2');
    expect(prompts[1]).toContain('"industrial":2');
    expect(prompts[1]).toContain('"consecutiveNoConstructionTicks":1');
    expect(prompts[1]).toContain('"populationStagnationTicks":1');
    expect(prompts[1]).toContain("City is stable; wait for measured demand.");
  });

  test("stops before snapshot and model request when minimum balance fails", async () => {
    const { ports, calls } = createPorts({
      getBalance: async () => ({
        isAvailable: true,
        currency: "CNY",
        totalBalance: 1,
        grantedBalance: 0,
        toppedUpBalance: 1,
        fetchedAt: new Date().toISOString(),
      }),
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.singleTick();
    expect(runtime.getState()?.status).toBe("stopped");
    expect(calls.snapshot).toBe(0);
    expect(calls.decide).toBe(0);
    expect(calls.pause).toBe(1);
    expect(calls.save).toBe(0);
  });

  test("stops after the request that reaches maxSessionSpend", async () => {
    const { ports, calls } = createPorts();
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: cost.total / 2, minimumBalance: 2 });
    await runtime.singleTick();
    expect(runtime.getState()?.status).toBe("stopped");
    expect(runtime.getState()?.stopReason).toBe("Maximum session spend reached");
    expect(calls.decide).toBe(1);
    expect(calls.pause).toBe(1);
    expect(calls.save).toBe(0);
  });

  test("stops after three consecutive Bridge snapshot failures", async () => {
    const { ports, calls } = createPorts({
      getSnapshot: async () => {
        calls.snapshot++;
        throw new Error("Bridge offline");
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.singleTick();
    await runtime.singleTick();
    await runtime.singleTick();
    expect(runtime.getState()?.status).toBe("stopped");
    expect(runtime.getState()?.stopReason).toContain("3 consecutive bridge failures");
    expect(calls.snapshot).toBe(3);
    expect(calls.decide).toBe(0);
    expect(calls.pause).toBe(1);
    expect(calls.save).toBe(0);
  });

  test("emits exactly one tick event for a completed tick", async () => {
    let tickEvents = 0;
    const { ports } = createPorts({
      emit: (event) => {
        if (event === "tick") tickEvents++;
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.singleTick();
    expect(tickEvents).toBe(1);
  });

  test("stops after two consecutive model validation failures", async () => {
    const { ports, calls } = createPorts({
      decide: async () => {
        calls.decide++;
        return { content: "not json", model: "deepseek-chat", usage, estimatedCost: cost };
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.singleTick();
    await runtime.singleTick();
    expect(runtime.getState()?.status).toBe("stopped");
    expect(runtime.getState()?.stopReason).toContain("2 consecutive validation failures");
    expect(calls.decide).toBe(2);
  });

  test("does not retry a failed batch in the same tick and stops after three related failures", async () => {
    const action = { type: "build_road" as const, prefab: "Small Road", x1: 0, z1: 0, x2: 100, z2: 0 };
    const { ports, calls } = createPorts({
      decide: async () => {
        calls.decide++;
        return { content: plan({ actions: [action] }), model: "deepseek-chat", usage, estimatedCost: cost };
      },
      executeActions: async () => {
        calls.execute++;
        return {
          ok: false,
          requested: 1,
          executed: 1,
          failedAt: 0,
          results: [{ index: 0, type: "build_road", ok: false, summary: "stopped", error: "area unavailable" }],
        };
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.singleTick();
    expect(calls.execute).toBe(1);
    await runtime.singleTick();
    await runtime.singleTick();
    expect(calls.execute).toBe(3);
    expect(runtime.getState()?.status).toBe("stopped");
  });

  test("continuousRun proceeds without user messages until the plan requests stop", async () => {
    const { ports, calls } = createPorts({
      decide: async () => {
        calls.decide++;
        const stop = calls.decide === 3 ? { requested: true, reason: "Goal reached" } : { requested: false };
        return { content: plan({ stop }), model: "deepseek-chat", usage, estimatedCost: cost };
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2, tickDelayMs: 0 });
    const state = await runtime.continuousRun();
    expect(state.status).toBe("stopped");
    expect(state.tickCount).toBe(3);
    expect(calls.decide).toBe(3);
    expect(calls.save).toBe(0);
  });

  test("Fast mode records source format and normalization while simulating once after a multi-candidate phase", async () => {
    const calls = createPorts({
      getSnapshot: async () => ({
        schemaVersion: "1.2",
        economy: { treasury: 100_000 },
        actionablePlanning: {
          candidates: [
            { id: "A", validationStatus: "validated", conflictGroup: "a" },
            { id: "B", validationStatus: "validated", conflictGroup: "b" },
          ],
        },
      }),
      decide: async () => ({
        content: plan({
          actions: [
            { type: "choose_candidate", candidateId: "A", reason: "A" },
            { type: "choose_candidate", candidateId: "B", reason: "B" },
          ],
          simulation: { run: true, hours: 2, speed: 4 },
        }),
        model: "deepseek-chat",
        usage,
        estimatedCost: cost,
      }),
    });
    const executed: unknown[] = [];
    calls.ports.executeActions = async (actions) => {
      executed.push(actions);
      return { ok: true, requested: actions.length, executed: actions.length, results: [] };
    };
    const runtime = new MayorRuntime(calls.ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2, speed: "fast" });
    await runtime.singleTick();
    const telemetry = runtime.getState()?.recentTickTelemetry[0];
    expect(executed[0]).toHaveLength(2);
    expect(calls.calls.simulation).toBe(1);
    expect(telemetry?.modelPlanFormat).toBe("actions");
    expect(telemetry?.normalizedToConstructionPhase).toBe(true);
    expect(telemetry?.selectedCandidateCount).toBe(2);
  });

  test("stop during a model request prevents all later game mutations", async () => {
    let releaseDecision: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const { ports, calls } = createPorts({
      decide: async () => {
        calls.decide++;
        markStarted?.();
        await gate;
        return {
          content: plan({
            actions: [{ type: "build_road", prefab: "Small Road", x1: 0, z1: 0, x2: 100, z2: 0 }],
            simulation: { run: true, hours: 2, speed: 2 },
          }),
          model: "deepseek-chat",
          usage,
          estimatedCost: cost,
        };
      },
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    const tick = runtime.singleTick();
    await started;
    await runtime.stop("Safety stop during request");
    releaseDecision?.();
    await tick;

    expect(runtime.getState()?.status).toBe("stopped");
    expect(calls.execute).toBe(0);
    expect(calls.simulation).toBe(0);
    expect(calls.pause).toBe(1);
    expect(calls.save).toBe(0);
  });

  test("validates future command input at the runtime boundary", () => {
    const { ports } = createPorts();
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    expect(() => runtime.setPendingUserCommand({ text: "", source: "text" })).toThrow("text is required");
    expect(() =>
      runtime.setPendingUserCommand({ text: "build here", source: "map", target: { x: 20_000, z: 0 } }),
    ).toThrow("outside the supported map bounds");
  });

  test("reuses the existing pause path when final confirmation still reports running", async () => {
    let confirmations = 0;
    const { ports, calls } = createPorts({
      confirmPaused: async () => ++confirmations > 1,
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    await runtime.stop("pause confirmation regression");
    expect(calls.pause).toBe(2);
    expect(calls.save).toBe(0);
    expect(confirmations).toBe(2);
  });
});
