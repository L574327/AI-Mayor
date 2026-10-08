import { BORROW_STEP, decideLoan, paymentsFit, type LoanReading } from "../../src/main/services/ai-mayor/v2/loan-policy";
import { EXPANSION_DEVIATION_RESERVE } from "../../src/main/services/ai-mayor/v2/solvency";

const none: LoanReading = { amount: 0, dailyInterestRate: 0, dailyPayment: 0, creditworthiness: 1_600_000 };
const base = { loan: none, treasury: 104_000, monthlyBalance: 123_000, bottleneck: "HOUSING" as const, absorbing: true, cycle: 10, blockedUntilCycle: 0 };

describe("loans as a step of the growth capital loop (the study's conservative rule)", () => {
  test("borrows the gap to one more build, in steps, when the bottleneck is proven, the supply is being taken up and the city earns more than it spends", () => {
    const decision = decideLoan(base);
    expect(decision.action).toBe("BORROW");
    if (decision.action === "BORROW") {
      expect(decision.amount % BORROW_STEP).toBe(0);
      expect(decision.amount).toBeGreaterThan(0);
      expect(decision.amount).toBeLessThan(none.creditworthiness * 0.5);
    }
  });

  test("never carries a deficit, never without a proven bottleneck or absorption, never when the cash already covers the build", () => {
    expect(decideLoan({ ...base, monthlyBalance: -1 }).action).toBe("NONE");
    expect(decideLoan({ ...base, monthlyBalance: 0 }).action).toBe("NONE");
    expect(decideLoan({ ...base, bottleneck: "NONE" }).action).toBe("NONE");
    expect(decideLoan({ ...base, bottleneck: "MATCH" }).action).toBe("NONE");
    expect(decideLoan({ ...base, absorbing: false }).action).toBe("NONE");
    expect(decideLoan({ ...base, treasury: EXPANSION_DEVIATION_RESERVE + 200_000 }).action).toBe("NONE");
  });

  test("debt stays within its share of the credit line, and a step just taken (or undone) is not followed at once by another", () => {
    expect(decideLoan({ ...base, loan: { ...none, amount: 780_000 } }).action).toBe("NONE");
    expect(decideLoan({ ...base, cycle: 2, blockedUntilCycle: 5 }).action).toBe("NONE");
  });

  test("repays when the treasury stands well above the reserve, keeping a cushion", () => {
    const decision = decideLoan({ ...base, loan: { ...none, amount: 200_000 }, treasury: 700_000 });
    expect(decision.action).toBe("REPAY");
    if (decision.action === "REPAY") {
      expect(decision.amount).toBeLessThanOrEqual(200_000);
      expect(700_000 - decision.amount).toBeGreaterThanOrEqual(2 * EXPANSION_DEVIATION_RESERVE);
    }
    expect(decideLoan({ ...base, loan: { ...none, amount: 200_000 }, treasury: 300_000 }).action).not.toBe("REPAY");
  });

  test("the payments the game reports must fit inside half of what the city earns, else the step is undone", () => {
    expect(paymentsFit({ ...none, amount: 100_000, dailyPayment: 1_000 }, 123_000)).toBe(true);
    expect(paymentsFit({ ...none, amount: 100_000, dailyPayment: 3_000 }, 123_000)).toBe(false);
  });
});
