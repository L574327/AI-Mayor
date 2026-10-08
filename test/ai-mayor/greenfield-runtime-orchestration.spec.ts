import { hasGreenfieldUtilityProof, simulationStageBudgetMs } from "@/main/services/ai-mayor/runtime";
import {
  SIMULATION_STAGE_TIMEOUT_MARGIN_MS,
  simulationAbsoluteBudgetMs,
  simulationNoProgressBudgetMs,
} from "@/main/services/ai-mayor/v2/simulation-wait-contract";

describe("greenfield runtime orchestration", () => {
  it("keeps the stage watchdog outside the adapter's own simulation budget", () => {
    // The defect this contract exists for: a watchdog authorizing less than the
    // adapter's own bound cancels a run the adapter still considers in flight.
    // For one game hour the stage watchdog used to authorize 150 s while the
    // adapter floored itself at 300 s, and the tick reported the cancellation
    // as `CS2 simulation did not auto-pause before timeout` (5 of 6 live runs).
    for (const [hours, speed] of [[1, 4], [2, 4], [4, 4], [24, 0.5]] as const) {
      const adapterAbsolute = simulationAbsoluteBudgetMs(hours, speed);
      // A run may always stall before it reaches its absolute ceiling, and never
      // the other way round. The two coincide only where the ceiling clamps a
      // long run's estimate, which is bounded by design.
      expect(simulationNoProgressBudgetMs(hours, speed)).toBeLessThanOrEqual(adapterAbsolute);
      expect(simulationStageBudgetMs(hours, speed, 90_000))
        .toBe(adapterAbsolute + SIMULATION_STAGE_TIMEOUT_MARGIN_MS);
    }
    // The bounded cases the cancelled live runs were in: the stall budget is the
    // adapter's five-minute floor, and the absolute one leaves it room to finish.
    expect(simulationNoProgressBudgetMs(1, 4)).toBe(5 * 60_000);
    expect(simulationAbsoluteBudgetMs(1, 4)).toBe(10 * 60_000);
  });

  it("lets an operator widen the stage bound but never narrow it below the adapter", () => {
    // A configured stage timeout smaller than the wait it bounds is exactly the
    // configuration that produced the cancelled runs, so it can only widen.
    expect(simulationStageBudgetMs(1, 4, 1_000))
      .toBe(simulationAbsoluteBudgetMs(1, 4) + SIMULATION_STAGE_TIMEOUT_MARGIN_MS);
    expect(simulationStageBudgetMs(1, 4, 20 * 60_000)).toBe(20 * 60_000);
  });

  it("requires real utility consumer proof before bootstrap becomes LIVE", () => {
    const base = {
      population: { current: 6 },
      utilities: {
        electricity: { production: 100, consumption: 20, fulfilledConsumption: 20 },
        water: { capacity: 100 },
        sewage: { capacity: 100 },
      },
    };
    expect(hasGreenfieldUtilityProof(base)).toBe(true);
    expect(hasGreenfieldUtilityProof({ ...base, utilities: { ...base.utilities, water: { capacity: 0 } } })).toBe(false);
    expect(hasGreenfieldUtilityProof({ ...base, population: { current: 0 } })).toBe(false);
  });
});
