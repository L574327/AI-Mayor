import {
  RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD,
  appendRunLedgerEntry,
  classifyRunProgress,
  emptyRunLedgerState,
  type RunLedgerDecision,
  type RunLedgerFacts,
} from "../../src/main/services/ai-mayor/v2/run-ledger";

const facts = (overrides: Partial<RunLedgerFacts> = {}): RunLedgerFacts => ({
  simulationFrame: 1_000,
  gameDateTime: "2027-01-02 03:00",
  population: 74,
  serviceBuildingCount: 0,
  builtButVacantByType: null,
  treasury: 862_408,
  monthlyBalance: -40_054,
  runwayMonths: 21.5,
  utilities: {
    electricity: { supply: 6_916, demand: 4_126 },
    water: { supply: 33_000, demand: 123 },
    sewage: { supply: 100_000, demand: 123 },
  },
  labor: { employed: 26, unemploymentRate: 13.33, jobsTotal: 33, jobsFree: 7, freeByEducation: { uneducated: 4 } },
  ...overrides,
});

const decision = (overrides: Partial<RunLedgerDecision> = {}): RunLedgerDecision => ({
  goalId: null,
  goalType: null,
  policyAnswer: null,
  workOrderGoalId: null,
  workOrderStatus: null,
  workOrderStage: null,
  applied: { zoning: 0, road: 0, facility: 0 },
  parkedFamily: null,
  parkedReason: null,
  haltReason: null,
  simulation: { outcome: "completed", elapsedMs: 1_000, framesAdvanced: 240, reason: null },
  ...overrides,
});

describe("run ledger classification", () => {
  it("reports a city that changed as progressing", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts({ population: 80, simulationFrame: 1_240 }),
      decision: decision(),
      priorNoEffect: 0,
    });
    expect(outcome.status).toBe("WORLD_PROGRESSING");
    expect(outcome.consecutiveNoEffect).toBe(0);
  });

  it("counts an applied native effect as progress even with a frozen city", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts(),
      decision: decision({ applied: { zoning: 0, road: 3, facility: 0 } }),
      priorNoEffect: 4,
    });
    expect(outcome.status).toBe("WORLD_PROGRESSING");
    expect(outcome.consecutiveNoEffect).toBe(0);
  });

  // The message below says "no population, building, applied-effect or
  // progression change" and the predicate implemented only the first three.
  // Measured live 2026-10-02 (`tmp/expansion-vertical2.json`): eleven windows,
  // 9 roads, 14 zoning actions, a fresh Goal almost every window, halted on
  // window 11 anyway — because the V2 Brain path fills none of the telemetry
  // counters `applied` is read from, so it read `{0,0,0}` while population sat
  // at 46 and every other term stayed pinned.
  it("counts a durable plan that advanced as progress, even with a frozen city and no telemetry", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts(),
      decision: decision({ applied: { zoning: 0, road: 0, facility: 0 },
        workOrderGoalId: "EXPAND_INDUSTRIAL:industrial:facts:aaa", workOrderStatus: "ACTIVE",
        workOrderStage: "ROAD_DELIVERED" }),
      previousDecision: decision({ workOrderGoalId: "EXPAND_RESIDENTIAL:residential:facts:bbb",
        workOrderStatus: "COMPLETE", workOrderStage: "ZONED_WAITING_FOR_BUILDING" }),
      priorNoEffect: 9,
    });
    expect(outcome.status).toBe("WORLD_PROGRESSING");
    expect(outcome.consecutiveNoEffect).toBe(0);
  });

  it("still counts a window whose plan did not move, so the watchdog stays armed", () => {
    const stalled = decision({ workOrderGoalId: "EXPAND_INDUSTRIAL:industrial:facts:aaa",
      workOrderStatus: "BLOCKED", workOrderStage: "SITE_SELECTED" });
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts(),
      decision: stalled,
      previousDecision: { ...stalled },
      priorNoEffect: RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD - 1,
    });
    expect(outcome.status).toBe("REPEATED_NO_EFFECT");
    expect(outcome.consecutiveNoEffect).toBe(RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD);
    expect(outcome.stallReason).toContain("RUN_STALLED_NO_WORLD_EFFECT");
  });

  it("does not shed the stall watchdog over a live run's eleven productive windows", () => {
    // The exact live shape: a flat city, no telemetry, and a durable plan that
    // keeps reaching new work. Appended window by window through the real
    // entry point, this must never raise a stall reason.
    let state = emptyRunLedgerState();
    for (let tick = 1; tick <= 11; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick, at: "2027-01-02T03:00:00.000Z", facts: facts(),
        decision: decision({ workOrderGoalId: `EXPAND_INDUSTRIAL:industrial:facts:${String(tick)}`,
          workOrderStatus: "ACTIVE", workOrderStage: tick % 2 === 0 ? "ROAD_DELIVERED" : "ZONED_WAITING_FOR_BUILDING" }),
      });
    }
    expect(state.stallReason).toBeNull();
    expect(state.consecutiveNoEffect).toBe(0);
  });

  it("honours a declared wait while the world is still moving", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts({ simulationFrame: 1_240, gameDateTime: "2027-01-02 03:15" }),
      decision: decision({ policyAnswer: "GROWTH_POLICY_OBSERVES:ADVANCE_SIMULATION" }),
      priorNoEffect: 2,
    });
    expect(outcome.status).toBe("WAITING_FOR_EFFECT");
    expect(outcome.stallReason).toBeNull();
  });

  it("reports a parked family with the reason that parked it", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts(),
      decision: decision({ parkedFamily: "EXPAND_COMMERCIAL:commercial", parkedReason: "no eligible site" }),
      priorNoEffect: 3,
    });
    expect(outcome.status).toBe("PARKED_WITH_REASON");
    expect(outcome.reason).toContain("EXPAND_COMMERCIAL:commercial");
    // A park is a reason, not progress: it carries the no-effect run forward
    // instead of clearing it.
    expect(outcome.consecutiveNoEffect).toBe(4);
  });

  it("lets a window the city moved in outrank a parked family", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts({ population: 90, simulationFrame: 1_240 }),
      decision: decision({ parkedFamily: "EXPAND_COMMERCIAL:commercial", parkedReason: "no eligible site" }),
      priorNoEffect: 5,
    });
    expect(outcome.status).toBe("WORLD_PROGRESSING");
    expect(outcome.consecutiveNoEffect).toBe(0);
  });

  it("keeps the stall watchdog armed while a family is parked", () => {
    let state = emptyRunLedgerState();
    for (let tick = 1; tick <= RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD + 1; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick,
        at: `t${tick}`,
        facts: facts(),
        decision: decision({ parkedFamily: "EXPAND_COMMERCIAL:commercial", parkedReason: "no eligible site" }),
      });
    }
    expect(state.entries.at(-1)?.status).toBe("PARKED_WITH_REASON");
    // A park on a world that is not moving waits for facts that cannot arrive.
    expect(state.stallReason).toContain("RUN_STALLED_NO_WORLD_EFFECT");
  });

  it("reports a simulation that could not advance as stalled, not as a park", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts(),
      decision: decision({
        parkedReason: null,
        simulation: { outcome: "stalled", elapsedMs: 300_000, framesAdvanced: 0, reason: "no frame progress" },
      }),
      priorNoEffect: 1,
    });
    expect(outcome.status).toBe("SIMULATION_STALLED");
    expect(outcome.reason).toBe("no frame progress");
  });

  it("stops calling a frozen city a wait once the windows run out", () => {
    let state = emptyRunLedgerState();
    // One extra window: the first entry has no previous read to compare against,
    // so it cannot yet claim that nothing changed.
    for (let tick = 1; tick <= RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD + 1; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick,
        at: `t${tick}`,
        facts: facts(),
        decision: decision({ policyAnswer: "GROWTH_POLICY_OBSERVES:ADVANCE_SIMULATION" }),
      });
    }
    expect(state.entries.at(-1)?.status).toBe("REPEATED_NO_EFFECT");
    expect(state.entries.at(-1)?.reason).toContain("the world did not advance");
    expect(state.stallReason).toContain("RUN_STALLED_NO_WORLD_EFFECT");
  });

  it("never calls an unreadable world clock a stall", () => {
    let state = emptyRunLedgerState();
    for (let tick = 1; tick <= RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD + 2; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick,
        at: `t${tick}`,
        // The Bridge read resolved no clock at all: the ledger cannot say the
        // world froze, only that it cannot see it.
        facts: facts({ simulationFrame: null, gameDateTime: null }),
        decision: decision(),
      });
    }
    expect(state.stallReason).toBeNull();
    expect(state.entries.at(-1)?.status).toBe("REPEATED_NO_EFFECT");
  });

  it("reports a running world around an unchanged city without stopping the run", () => {
    let state = emptyRunLedgerState();
    for (let tick = 1; tick <= RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD + 2; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick,
        at: `t${tick}`,
        // The clock moves every window; population and buildings do not.
        facts: facts({ simulationFrame: 1_000 + tick * 240 }),
        decision: decision(),
      });
    }
    expect(state.entries.at(-1)?.status).toBe("REPEATED_NO_EFFECT");
    expect(state.entries.at(-1)?.reason).toContain("the world advanced");
    expect(state.stallReason).toBeNull();
  });

  it("does not raise a stall while the city keeps changing", () => {
    let state = emptyRunLedgerState();
    for (let tick = 1; tick <= RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD * 2; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick,
        at: `t${tick}`,
        facts: facts({ population: 74 + tick, simulationFrame: 1_000 + tick * 240 }),
        decision: decision(),
      });
    }
    expect(state.stallReason).toBeNull();
    expect(state.consecutiveNoEffect).toBe(0);
  });

  it("reports a stopped session as halted ahead of anything else", () => {
    const outcome = classifyRunProgress({
      previous: facts(),
      current: facts({ population: 900 }),
      decision: decision({ haltReason: "V2 Brain stopped after 6 identical failures: boom" }),
      priorNoEffect: 0,
    });
    expect(outcome.status).toBe("RUNTIME_HALTED");
    expect(outcome.reason).toContain("boom");
  });

  it("keeps a bounded window and never infers an unread fact", () => {
    let state = emptyRunLedgerState();
    for (let tick = 1; tick <= 100; tick += 1) {
      state = appendRunLedgerEntry(state, {
        tick,
        at: `t${tick}`,
        facts: facts({ population: null, treasury: null, labor: null }),
        decision: decision({ applied: { zoning: 1, road: 0, facility: 0 } }),
      });
    }
    expect(state.entries.length).toBeLessThanOrEqual(64);
    expect(state.entries.at(-1)?.facts.population).toBeNull();
    expect(state.entries.at(-1)?.facts.labor).toBeNull();
  });
});
