import { GAME_HOUR_FRAMES, stampElapsed, stampHoursBetween } from "../../src/main/services/ai-mayor/v2/game-clock";
import { decideLoan, LOAN_COOLDOWN_HOURS, LOAN_COOLDOWN_CYCLES } from "../../src/main/services/ai-mayor/v2/loan-policy";
import { RefusedPlacements } from "../../src/main/services/ai-mayor/v2/district-services";
import { neededStockAbsorbing, pruneStockHistory, STOCK_HISTORY_HOURS, type StockSample } from "../../src/main/services/ai-mayor/v2/growth-bottleneck";

const at = (hours: number | null, cycle: number) => ({ frame: hours === null ? null : 5_000_000 + hours * GAME_HOUR_FRAMES, cycle });

describe("game-time waits (a cycle is no longer a game hour)", () => {
  describe("stampElapsed", () => {
    test("with a readable clock the game hours decide, whatever the cycle count says", () => {
      expect(stampElapsed(at(0, 0), at(2.9, 50), 3, 3)).toBe(false);
      expect(stampElapsed(at(0, 0), at(3, 1), 3, 3)).toBe(true);
    });
    test("control: with no readable clock on either side the cycles decide", () => {
      expect(stampElapsed(at(null, 0), at(null, 2), 3, 3)).toBe(false);
      expect(stampElapsed(at(null, 0), at(null, 3), 3, 3)).toBe(true);
      expect(stampElapsed(at(0, 0), at(null, 3), 3, 3)).toBe(true);
    });
    test("hours between two stamps, or null without a clock", () => {
      expect(stampHoursBetween(at(1, 0), at(4, 9))).toBeCloseTo(3);
      expect(stampHoursBetween(at(null, 0), at(4, 9))).toBeNull();
    });
  });

  describe("the loan cooldown", () => {
    const base = { loan: { amount: 0, dailyInterestRate: 0.01, dailyPayment: 0, creditworthiness: 1_000_000 }, treasury: 0, monthlyBalance: 100_000,
      bottleneck: "HOUSING" as const, absorbing: true, cycle: 10, blockedUntilCycle: 0 };
    const block = { since: at(0, 10), hours: LOAN_COOLDOWN_HOURS, cycles: LOAN_COOLDOWN_CYCLES };

    test("a step taken 3 cycles but a few game minutes ago is still being judged", () => {
      const decision = decideLoan({ ...base, cycle: 13, block, now: at(0.1, 13) });
      expect(decision.action).toBe("NONE");
      expect(decision.reason).toMatch(/still being judged/);
    });
    test("control: 3 game hours later the next step is allowed", () => {
      expect(decideLoan({ ...base, cycle: 11, block, now: at(3, 11) }).action).toBe("BORROW");
    });
    test("control: with no block given the cycle counters decide as before", () => {
      expect(decideLoan({ ...base, cycle: 12, blockedUntilCycle: 13 }).reason).toMatch(/still being judged/);
      expect(decideLoan({ ...base, cycle: 13, blockedUntilCycle: 13 }).action).toBe("BORROW");
    });
  });

  describe("refused placements", () => {
    const spot = { x: 100, z: 200 };
    test("a refusal stands for game time: many cycles later but the same few hours, it is still remembered", () => {
      const memory = new RefusedPlacements();
      memory.remember("Plant", spot, at(0, 0));
      expect(memory.refused("Plant", spot, at(5, 100))).toBe(true);
      // A refusal stands for REFUSED_PLACEMENT_TTL_HOURS (72 game hours since 2026-10-05: every preflight shows a ghost building in the game).
      expect(memory.refused("Plant", spot, at(71, 101))).toBe(true);
      expect(memory.refused("Plant", spot, at(73, 102))).toBe(false);
    });
    test("control: a bare cycle number (no clock) keeps the 20-cycle memory", () => {
      const memory = new RefusedPlacements();
      memory.remember("Plant", spot, 5);
      expect(memory.refused("Plant", spot, 25)).toBe(true);
      expect(memory.refused("Plant", spot, 26)).toBe(false);
    });
    test("control: another prefab or spot was never refused", () => {
      const memory = new RefusedPlacements();
      memory.remember("Plant", spot, at(0, 0));
      expect(memory.refused("Tower", spot, at(1, 1))).toBe(false);
      expect(memory.refused("Plant", { x: 900, z: 900 }, at(1, 1))).toBe(false);
    });
  });

  describe("is the needed supply being taken up (the unbuilt zoning history)", () => {
    const cells = (empty: number) => ({
      residential: { zoned: 100, empty }, commercial: { zoned: 0, empty: 0 }, industrial: { zoned: 0, empty: 0 }, office: { zoned: 0, empty: 0 },
    }) as never;
    const mix = (empty: number) => ({ cells: cells(empty), demand: { residential: 60, commercial: 0, industrial: 0, office: 0 } }) as never;
    const sample = (hours: number, empty: number): StockSample => ({ cells: cells(empty), stamp: at(hours, 0) });

    test("a fall seen only over minutes is not called 'falling'", () => {
      // 60 unbuilt of 100 zoned is not a small stock; it fell from 80 to 60 within 0.5 game hours: not a window long enough to judge.
      const verdict = neededStockAbsorbing([sample(0, 80), sample(0.25, 78)], mix(60), ["residential"], at(0.5, 0));
      expect(verdict.absorbing).toBe(false);
    });
    test("control: the same fall against a reading a full window old is 'falling'", () => {
      const verdict = neededStockAbsorbing([sample(0, 80), sample(STOCK_HISTORY_HOURS - 0.1, 62)], mix(60), ["residential"], at(STOCK_HISTORY_HOURS + 0.5, 0));
      expect(verdict.absorbing).toBe(true);
    });
    test("control: legacy readings with no time keep the old behaviour (oldest of the last cycles)", () => {
      expect(neededStockAbsorbing([cells(80), cells(70)], mix(60), ["residential"]).absorbing).toBe(true);
    });
  });

  describe("pruning the history", () => {
    const sample = (hours: number): StockSample => ({ cells: {} as never, stamp: at(hours, 0) });
    test("with a clock, seconds-long cycles do not push out the reading a window back", () => {
      const history = Array.from({ length: 100 }, (_, index) => sample(index * 0.1));
      const pruned = pruneStockHistory(history, at(9.9, 0));
      expect(pruned.length).toBeGreaterThan(5);
      expect(pruned.some((entry) => 9.9 - (entry.stamp.frame! - 5_000_000) / GAME_HOUR_FRAMES >= STOCK_HISTORY_HOURS)).toBe(true);
    });
    test("control: without a clock it keeps the last 5 readings", () => {
      const history = Array.from({ length: 12 }, () => ({ cells: {} as never, stamp: at(null, 0) }));
      expect(pruneStockHistory(history, at(null, 12))).toHaveLength(5);
    });
  });
});
