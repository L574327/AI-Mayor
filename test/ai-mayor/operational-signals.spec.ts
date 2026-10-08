import {
  emptyMayorOperationalSignals,
  updateMayorOperationalSignals,
} from "../../src/main/services/ai-mayor/operational-signals";

const snapshot = (treasury: number, population = 5) => ({
  population: { current: population },
  economy: { treasury },
  demand: {
    residential: { low: 0, medium: 0, high: 0 },
    commercial: 100,
    industrial: 100,
    office: 100,
  },
});

describe("Mayor bounded operational signals", () => {
  test("reports persistent demand and repeated no-op without forcing an action", () => {
    const firstSnapshot = snapshot(100_000);
    const first = updateMayorOperationalSignals({
      current: emptyMayorOperationalSignals(),
      snapshot: firstSnapshot,
      previousSnapshot: null,
      previousBatch: null,
      previousStatus: "started",
    });
    const second = updateMayorOperationalSignals({
      current: first,
      snapshot: snapshot(99_000),
      previousSnapshot: firstSnapshot,
      previousBatch: { ok: true, requested: 0, executed: 0, results: [] },
      previousStatus: "Waited for more evidence",
    });
    expect(second.demandPersistenceTicks).toEqual({ residential: 0, commercial: 2, industrial: 2, office: 2 });
    expect(second.consecutiveNoConstructionTicks).toBe(1);
    expect(second.populationStagnationTicks).toBe(1);
    expect(second.treasury).toEqual({ sessionStart: 100_000, current: 99_000, change: -1_000 });
    expect(second.previousNoOpStatus).toBe("Waited for more evidence");
    expect(JSON.stringify(second).length).toBeLessThan(1_000);
  });

  test("resets persistence after the signal or no-op condition ends", () => {
    const current = {
      ...emptyMayorOperationalSignals(),
      demandPersistenceTicks: { residential: 3, commercial: 3, industrial: 3, office: 3 },
      consecutiveNoConstructionTicks: 3,
    };
    const next = updateMayorOperationalSignals({
      current,
      snapshot: {
        population: { current: 6 },
        economy: { treasury: 101_000 },
        demand: { residential: { low: 0, medium: 0, high: 0 }, commercial: 0, industrial: 0, office: 0 },
      },
      previousSnapshot: snapshot(100_000),
      previousBatch: { ok: true, requested: 1, executed: 1, results: [] },
      previousStatus: "Built",
    });
    expect(next.demandPersistenceTicks).toEqual({ residential: 0, commercial: 0, industrial: 0, office: 0 });
    expect(next.consecutiveNoConstructionTicks).toBe(0);
    expect(next.populationStagnationTicks).toBe(0);
  });
});
