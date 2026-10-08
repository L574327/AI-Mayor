import {
  chooseRecoveryAction,
  diagnoseDeficit,
  FinanceRecoveryLoop,
  judgeAction,
  newRecoveryMemory,
  readingOf,
  recoveryCandidates,
  recoveryStatus,
  serviceLineOfPrefab,
  type FinanceFacts,
  type FinanceRecoveryPort,
  type RecoveryCandidate,
} from "../../src/main/services/ai-mayor/v2/finance-recovery";
import { profileAllowsExpansion } from "../../src/main/services/ai-mayor/v2/objective-profile";

const facts = (overrides: Partial<FinanceFacts> = {}): FinanceFacts => ({
  treasury: 600_000, monthlyIncome: 13_000, monthlyExpenses: 100_000, monthlyBalance: -87_000,
  incomeByTaxArea: { Residential: 7_000, Commercial: 5_000, Industrial: 300, Office: 0 },
  serviceLines: [
    { name: "Health & Deathcare", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 50_000 },
    { name: "Water & Sewage", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 38_000 },
    { name: "Roads", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 11_000 },
    { name: "Parks & Recreation", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 0 },
  ],
  taxRates: { Residential: 10, Commercial: 10, Industrial: 10, Office: 10 },
  taxDemandPenalty: { Residential: -8, Commercial: 0, Industrial: -300, Office: 0 },
  loanPrincipal: 0, population: 178, happiness: 36,
  unserved: { electricity: 0, water: 0, sewage: 0 }, unservedConfirmed: true, unattachedFacilities: [], assetLossIcons: 0, buildingCount: 300,
  facilitiesByServiceLine: { "Health & Deathcare": [{ entity: { index: 1, version: 1 }, prefab: "MedicalClinic01" }] },
  ...overrides,
});
const loose = { entity: { index: 7, version: 1 }, prefab: "WindTurbine03", utility: "electricity", position: { x: 0, z: 0 } };

describe("objective profile seam", () => {
  test("only FINANCIAL_RECOVERY holds the Mayor back from expanding, and only until it has recovered", () => {
    expect(profileAllowsExpansion("FINANCIAL_RECOVERY", false)).toBe(false);
    expect(profileAllowsExpansion("FINANCIAL_RECOVERY", true)).toBe(true);
    for (const profile of ["AUTONOMOUS", "BALANCED"] as const) expect(profileAllowsExpansion(profile, false)).toBe(true);
  });
});

describe("finance recovery: reading the causes", () => {
  test("ranks the fixed costs and names an unserved tax base and a disconnected facility when the world proves them", () => {
    const causes = diagnoseDeficit(facts({ unserved: { electricity: 128, water: 68, sewage: 61 }, unattachedFacilities: [loose] }));
    expect(causes[0]!.cause).toMatch(/FIXED_COST:Health/);
    expect(causes.some((cause) => cause.cause === "TAX_BASE_UNSERVED")).toBe(true);
    expect(causes.some((cause) => cause.cause === "FACILITY_NOT_CONNECTED")).toBe(true);
  });

  test("an unserved count the world did not confirm is not claimed", () => {
    const causes = diagnoseDeficit(facts({ unserved: { electricity: 128, water: 0, sewage: 0 }, unservedConfirmed: false }));
    expect(causes.some((cause) => cause.cause === "TAX_BASE_UNSERVED")).toBe(false);
  });

  test("prefabs map to the service line their upkeep is booked to", () => {
    expect(serviceLineOfPrefab("MedicalClinic01")).toBe("Health & Deathcare");
    expect(serviceLineOfPrefab("GroundwaterPumpingStation01")).toBe("Water & Sewage");
    expect(serviceLineOfPrefab("WindTurbine03")).toBe("Electricity");
    expect(serviceLineOfPrefab("EU_ResidentialLow01_L1_4x6")).toBeNull();
  });
});

describe("finance recovery: choosing the action", () => {
  test("a disconnected facility is repaired before anything is cut", () => {
    const f = facts({ unserved: { electricity: 128, water: 0, sewage: 0 }, unattachedFacilities: [loose] });
    const choice = chooseRecoveryAction(f, recoveryCandidates(f, newRecoveryMemory()));
    expect(choice?.kind).toBe("CONNECT_FACILITY");
  });

  test("a service that is failing to deliver is not cut around", () => {
    const f = facts({ unserved: { electricity: 0, water: 30, sewage: 0 } });
    const trims = recoveryCandidates(f, newRecoveryMemory()).filter((candidate) => candidate.kind === "TRIM_SERVICE_BUDGET");
    expect(trims.some((candidate) => (candidate.params as { service: string }).service === "Water & Sewage")).toBe(false);
    expect(trims.some((candidate) => (candidate.params as { service: string }).service === "Health & Deathcare")).toBe(true);
  });

  test("electricity made at 2.4x the load is cut to keep 1.6x in one step, even while a few buildings are merely unconnected", () => {
    const base = facts();
    const f = facts({ electricityHeadroom: 2.4, unserved: { electricity: 3, water: 0, sewage: 0 }, unservedConfirmed: true,
      serviceLines: [...base.serviceLines, { name: "Electricity", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 520_000 }] });
    const trim = recoveryCandidates(f, newRecoveryMemory()).find((candidate) => (candidate.params as { service: string }).service === "Electricity");
    expect((trim?.params as { to: number }).to).toBe(70);
    // Cut too far (live 2026-10-07: 67 dark at 1.3x): the budget goes back up first, and that repair is never undone.
    const dark = facts({ electricityHeadroom: 1.1, unserved: { electricity: 67, water: 0, sewage: 0 }, unservedConfirmed: true,
      serviceLines: [...base.serviceLines, { name: "Electricity", budgetPercent: 55, efficiencyPercent: 36, estimatedUpkeep: 290_000 }] });
    const restore = chooseRecoveryAction(dark, recoveryCandidates(dark, newRecoveryMemory()));
    expect(restore).toMatchObject({ id: "restore:Electricity:70", params: { from: 55, to: 70 } });
    const reading = readingOf(dark);
    expect(judgeAction(restore!, reading, { ...reading, population: 1 }).verdict).toBe("KEEP");
    // A line with its own icons piling up is not cut.
    const garbage = facts({ serviceIcons: { garbage: 45, health: 0, deathcare: 0 }, serviceLines: [{ name: "Garbage Management", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 105_000 }] });
    expect(recoveryCandidates(garbage, newRecoveryMemory()).some((candidate) => (candidate.params as { service?: string }).service === "Garbage Management")).toBe(false);
    const short = facts({ electricityHeadroom: 1.05, unserved: { electricity: 3, water: 0, sewage: 0 }, unservedConfirmed: true,
      serviceLines: [...base.serviceLines, { name: "Electricity", budgetPercent: 100, efficiencyPercent: 100, estimatedUpkeep: 520_000 }] });
    expect(recoveryCandidates(short, newRecoveryMemory()).some((candidate) => (candidate.params as { service: string }).service === "Electricity")).toBe(false);
  });
  test("the reversible lever comes first; demolition is offered only once the budget lever on that line is exhausted", () => {
    const f = facts();
    const first = recoveryCandidates(f, newRecoveryMemory());
    expect(first.some((candidate) => candidate.kind === "DEMOLISH_FACILITY")).toBe(false);
    expect(chooseRecoveryAction(f, first)?.reversible).toBe(true);
    const cut = facts({ serviceLines: facts().serviceLines.map((line) => line.name === "Health & Deathcare" ? { ...line, budgetPercent: 50, estimatedUpkeep: 29_000 } : line) });
    const later = recoveryCandidates(cut, newRecoveryMemory());
    const demolition = later.find((candidate) => candidate.kind === "DEMOLISH_FACILITY");
    expect(demolition).toBeDefined();
    expect(demolition!.reversible).toBe(false);
  });

  test("a tax is raised only where the game reports no demand penalty from it", () => {
    const taxes = recoveryCandidates(facts(), newRecoveryMemory()).filter((candidate) => candidate.kind === "RAISE_TAX")
      .map((candidate) => (candidate.params as { area: string }).area);
    expect(taxes).toEqual(["Commercial"]);
  });

  test("an irreversible action dominates only when it is far larger than every reversible one and large against the deficit", () => {
    const f = facts({ monthlyBalance: -40_000 });
    const small: RecoveryCandidate = { id: "budget:x", kind: "TRIM_SERVICE_BUDGET", reversible: true, params: {}, expectedMonthlyGain: 5_000, riskWeight: 2, rationale: "" };
    const big: RecoveryCandidate = { id: "demolish:1", kind: "DEMOLISH_FACILITY", reversible: false, params: {}, expectedMonthlyGain: 20_000, riskWeight: 4, rationale: "" };
    expect(chooseRecoveryAction(f, [small, big])?.id).toBe("demolish:1");
    expect(chooseRecoveryAction(f, [small, { ...big, expectedMonthlyGain: 12_000 }])?.id).toBe("budget:x");
    expect(chooseRecoveryAction(facts({ monthlyBalance: -200_000 }), [small, { ...big, expectedMonthlyGain: 20_000 }])?.id).toBe("budget:x");
  });
});

describe("finance recovery: judging an action by what the world shows", () => {
  const trim: RecoveryCandidate = { id: "budget:a:90", kind: "TRIM_SERVICE_BUDGET", reversible: true, params: { service: "a" }, expectedMonthlyGain: 1, riskWeight: 1, rationale: "" };
  const reading = (partial: Partial<ReturnType<typeof readingOf>> = {}) => ({ lineUpkeep: { a: 1_000 }, incomeByTaxArea: {}, monthlyBalance: -80_000, population: 200, happiness: 40, assetLossIcons: 0, unservedTotal: 0, buildingCount: 100, ...partial });

  test("keeps what measurably helped, undoes what did not or hurt", () => {
    // A budget step is credited only with its own line: a city-wide balance gain from something else is not its doing.
    expect(judgeAction(trim, reading(), reading({ monthlyBalance: -70_000, lineUpkeep: { a: 900 } })).verdict).toBe("KEEP");
    expect(judgeAction(trim, reading(), reading({ monthlyBalance: -30_000 })).verdict).toBe("UNDO");
    expect(judgeAction(trim, reading(), reading({ monthlyBalance: -70_000, lineUpkeep: { a: 900 }, population: 180 })).verdict).toBe("UNDO");
    expect(judgeAction(trim, reading(), reading({ monthlyBalance: -70_000, lineUpkeep: { a: 900 }, happiness: 35 })).verdict).toBe("UNDO");
    expect(judgeAction(trim, reading(), reading({ monthlyBalance: -70_000, lineUpkeep: { a: 900 }, assetLossIcons: 4 })).verdict).toBe("UNDO");
    expect(judgeAction(trim, reading(), reading({ monthlyBalance: -70_000, lineUpkeep: { a: 900 }, unservedTotal: 10 })).verdict).toBe("UNDO");
    // A city that grew has more unserved buildings; the SHARE is what says it got worse.
    expect(judgeAction(trim, reading({ unservedTotal: 10, buildingCount: 100 }), reading({ monthlyBalance: -70_000, lineUpkeep: { a: 900 }, unservedTotal: 30, buildingCount: 400 })).verdict).toBe("KEEP");
  });

  test("a harmful irreversible action is reported as harm, not pretended undone", () => {
    const demolish: RecoveryCandidate = { ...trim, id: "demolish:1", kind: "DEMOLISH_FACILITY", reversible: false };
    expect(judgeAction(demolish, reading(), reading({ monthlyBalance: -30_000, population: 150 })).verdict).toBe("HARM");
  });

  test("a repair is judged by what it served", () => {
    const repair: RecoveryCandidate = { ...trim, id: "connect:7", kind: "CONNECT_FACILITY", reversible: false };
    expect(judgeAction(repair, reading({ unservedTotal: 100 }), reading({ unservedTotal: 20 })).verdict).toBe("KEEP");
    expect(judgeAction(repair, reading({ unservedTotal: 100 }), reading({ unservedTotal: 100 })).verdict).toBe("NEUTRAL");
  });
});

describe("finance recovery: knowing when to stop", () => {
  test("a small deficit against years of cash and a large income is sustainable, a large one is not", () => {
    const memory = newRecoveryMemory();
    memory.balanceReads.push(-6_000, -6_000);
    const candidates = recoveryCandidates(facts(), newRecoveryMemory());
    expect(candidates.length).toBeGreaterThan(0);
    expect(recoveryStatus(facts({ monthlyBalance: -6_000, monthlyIncome: 138_000, treasury: 683_000 }), memory, candidates)).toBe("RECOVERED");
    expect(recoveryStatus(facts({ monthlyBalance: -30_000, monthlyIncome: 138_000, treasury: 683_000 }), memory, candidates)).toBe("RECOVERING");
    expect(recoveryStatus(facts({ monthlyBalance: -6_000, monthlyIncome: 138_000, treasury: 90_000 }), memory, candidates)).toBe("RECOVERING");
  });

  test("recovered after enough consecutive non-negative reads, exhausted when negative with nothing left to do", () => {
    const memory = newRecoveryMemory();
    memory.balanceReads.push(-5_000, -1_000);
    expect(recoveryStatus(facts({ monthlyBalance: -1_000, treasury: 10_000 }), memory, [])).toBe("EXHAUSTED");
    memory.balanceReads.push(2_000);
    memory.balanceReads.push(3_000);
    expect(recoveryStatus(facts({ monthlyBalance: 3_000 }), memory, [])).toBe("RECOVERED");
    const empty = newRecoveryMemory();
    expect(recoveryStatus(facts({ monthlyBalance: -87_000 }), empty, [])).toBe("EXHAUSTED");
    expect(recoveryStatus(facts({ monthlyBalance: -1_000, treasury: 900_000 }), empty, [])).toBe("RECOVERED");
  });
});

describe("finance recovery: the loop over a port", () => {
  /** A world in which a facility is disconnected and a budget step really does save money (and one harms nothing). */
  function world() {
    const state = { connected: false, healthBudget: 100, balance: -87_000, unserved: 128, log: [] as string[] };
    const port: FinanceRecoveryPort = {
      readFacts: async () => facts({
        monthlyBalance: state.balance, unserved: { electricity: state.unserved, water: 0, sewage: 0 },
        unattachedFacilities: state.connected ? [] : [loose],
        serviceLines: facts().serviceLines.map((line) => line.name === "Health & Deathcare" ? { ...line, budgetPercent: state.healthBudget } : line),
      }),
      setServiceBudget: async (_service, percent) => { state.log.push(`budget ${percent}`); state.healthBudget = percent; state.balance += 4_000; return true; },
      setTax: async () => true,
      connectFacility: async () => { state.log.push("connect"); state.connected = true; state.unserved = 0; state.balance += 30_000; return { ok: true, detail: "attached" }; },
      demolish: async () => { state.log.push("demolish"); return true; },
    };
    return { state, port };
  }

  test("repairs first, reads the result, then takes one reversible step at a time and stops acting when done", async () => {
    const { state, port } = world();
    const loop = new FinanceRecoveryLoop(port);
    const first = await loop.step();
    expect(first.acted).toBe(true);
    expect(state.log).toEqual(["connect"]);
    const second = await loop.step();
    expect(second.notes.join(" ")).toMatch(/CONNECT_FACILITY connect:7: KEEP/);
    expect(second.acted).toBe(true);
    expect(state.log).toEqual(["connect", "budget 90"]);
    // Drive the books non-negative: Recovery reports done and does nothing more.
    state.balance = 1_000;
    await loop.step();
    state.balance = 2_000;
    const done = await loop.step();
    expect(done.status).toBe("RECOVERED");
    expect(done.acted).toBe(false);
    const actions = state.log.length;
    await loop.step();
    expect(state.log.length).toBe(actions);
  });

  test("an action with no measurable effect is undone, and the same step is not repeated forever", async () => {
    const { state, port } = world();
    state.connected = true; state.unserved = 0;
    port.setServiceBudget = async (_service, percent) => { state.log.push(`budget ${percent}`); state.healthBudget = percent; return true; };
    const loop = new FinanceRecoveryLoop(port);
    await loop.step();
    const next = await loop.step();
    expect(next.notes.join(" ")).toMatch(/UNDO/);
    expect(state.log).toContain("budget 100");
  });
});
