import { describe, expect, test } from "@jest/globals";
import type { DeepSeekEstimatedCost } from "../../src/intellichat/telemetry/deepseekCost";
import {
  addEstimatedRequestCost,
  canContinue,
  createDeepSeekSessionCostState,
  markSessionBalanceFailure,
  remainingSessionBudget,
  shouldStopForBalance,
  shouldStopForBudget,
  updateSessionBalance,
} from "../../src/intellichat/telemetry/deepseekCostGuard";

const estimatedCost = (total: number): DeepSeekEstimatedCost => ({
  currency: "CNY",
  pricingModel: "deepseek-v4-flash",
  pricingPeriod: "offPeak",
  cachedInput: 0,
  uncachedInput: total,
  output: 0,
  total,
  isEstimate: true,
});

describe("DeepSeek session cost guard", () => {
  test("stops before the request after max session spend is reached", () => {
    const initial = createDeepSeekSessionCostState({
      currentBalance: 20,
      currency: "CNY",
      maxSessionSpend: 3,
    });
    const belowLimit = addEstimatedRequestCost(initial, estimatedCost(2.99));
    const atLimit = addEstimatedRequestCost(belowLimit, estimatedCost(0.01));

    expect(canContinue(belowLimit)).toBe(true);
    expect(remainingSessionBudget(belowLimit)).toBeCloseTo(0.01);
    expect(shouldStopForBudget(atLimit)).toBe(true);
    expect(remainingSessionBudget(atLimit)).toBe(0);
    expect(canContinue(atLimit)).toBe(false);
    expect(atLimit.requestCount).toBe(2);
  });

  test("stops when real balance is at or below the configured minimum", () => {
    const state = createDeepSeekSessionCostState({
      currentBalance: 2,
      currency: "CNY",
      minimumBalance: 2,
    });

    expect(shouldStopForBalance(state)).toBe(true);
    expect(canContinue(state)).toBe(false);
  });

  test.each(["unavailable", "error"] as const)("fails closed when balance is %s", (balanceStatus) => {
    const initial = createDeepSeekSessionCostState({ currentBalance: 10, currency: "CNY" });
    const state = markSessionBalanceFailure(initial, balanceStatus);

    expect(shouldStopForBalance(state)).toBe(true);
    expect(canContinue(state)).toBe(false);
  });

  test("keeps the initial balance while applying later real balance refreshes", () => {
    const initial = createDeepSeekSessionCostState({ currency: "CNY" });
    const started = updateSessionBalance(initial, { isAvailable: true, currency: "CNY", totalBalance: 8.76 });
    const refreshed = updateSessionBalance(started, { isAvailable: true, currency: "CNY", totalBalance: 8.5 });

    expect(refreshed.sessionStartBalance).toBe(8.76);
    expect(refreshed.currentBalance).toBe(8.5);
    expect(canContinue(refreshed)).toBe(true);
  });

  test("stops when the balance API reports the account unavailable", () => {
    const state = createDeepSeekSessionCostState({
      currentBalance: 100,
      currency: "CNY",
      balanceStatus: "available",
      isBalanceAvailable: false,
    });

    expect(shouldStopForBalance(state)).toBe(true);
  });

  test("rejects mixing USD request costs into a CNY session", () => {
    const state = createDeepSeekSessionCostState({ currentBalance: 10, currency: "CNY" });
    expect(() => addEstimatedRequestCost(state, { ...estimatedCost(1), currency: "USD" })).toThrow(
      "cost currency USD does not match session currency CNY",
    );
  });
});
