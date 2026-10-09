/**
 * LOANS AS A STEP OF THE GROWTH CAPITAL LOOP — the conservative rule of the study (FAST_EXPANSION_100K_Optimization_Study_V1, "债务与短期亏损";
 * Bible S06 / K33) and the borrowing tiers of the V2 candidate (P8).
 *
 * The rate climbs with borrowed amount over creditworthiness, so the decision looks at that ratio, not at whether any debt exists:
 *   - below ⟨30%⟩   growth with a stated return may borrow (a bottleneck the world proves, supply that is being taken up);
 *   - ⟨30–70%⟩      repairs only: no growth borrowing, the marginal cost has risen;
 *   - above ⟨70%⟩   a structural-deficit signal: repay what the treasury allows and cut spending (land purchases stop).
 * A loan is never a way to carry a structural deficit and its proceeds are not operating income: the Mayor borrows only while the city earns
 * more than it spends, only the gap to one more build, in steps, and undoes a step whose payments the game's own figures say do not fit.
 * Every figure is a starting value to read against live interest rates (no live loan data yet), not a rule.
 */
import type { GrowthBottleneck } from "./growth-bottleneck";
import { stampElapsed, type GameStamp } from "./game-clock";
import { EXPANSION_DEVIATION_RESERVE, expansionCashRequired } from "./solvency";

export interface LoanReading {
  /** Principal outstanding. */
  amount: number;
  dailyInterestRate: number;
  /** What the loan takes out each day. */
  dailyPayment: number;
  /** The most the city can owe (the game's own credit line). */
  creditworthiness: number;
}

/** A build is a few tens of thousands; the loan covers the gap to one more of them. */
export const PLANNED_BUILD_COST = 50_000;
export const BORROW_STEP = 50_000;
/** ⟨待标定⟩ Borrowed / credit line: below this a growth loan is allowed; up to `REPAIR_ONLY_BORROW_SHARE` only repairs; beyond it, cut. */
export const GROWTH_BORROW_SHARE = 0.3;
export const REPAIR_ONLY_BORROW_SHARE = 0.7;
/** The loan's payments may take at most this share of what the city earns above its spending. */
export const MAXIMUM_PAYMENT_SHARE_OF_BALANCE = 0.5;
/** Repay when the treasury stands this many reserves high, keeping `KEEP_RESERVES_AFTER_REPAYING` of them. */
export const REPAY_WHEN_RESERVES_ABOVE = 3;
export const KEEP_RESERVES_AFTER_REPAYING = 2;
export const LOAN_COOLDOWN_CYCLES = 3;
/** A refused or undone step blocks the next one this long. */
export const LOAN_REFUSED_BLOCK_CYCLES = 10;
/**
 * The same waits in game hours (`game-clock.ts`): a loan's effect shows in the books by the hour and a cycle is no longer a game hour, so the
 * cycle counts above are only the fallback when the game clock cannot be read.
 */
export const LOAN_COOLDOWN_HOURS = 3;
export const LOAN_REFUSED_BLOCK_HOURS = 10;

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step;

export type LoanTier = "GROWTH" | "REPAIR_ONLY" | "CUT_SPENDING";

/** The tier of a borrowed amount over the credit line. A credit line that is not positive is the strictest tier. */
export function loanTier(amount: number, creditworthiness: number): LoanTier {
  if (!(creditworthiness > 0)) return "CUT_SPENDING";
  const share = amount / creditworthiness;
  if (share < GROWTH_BORROW_SHARE) return "GROWTH";
  return share <= REPAIR_ONLY_BORROW_SHARE ? "REPAIR_ONLY" : "CUT_SPENDING";
}

export type LoanDecision =
  | { action: "BORROW"; amount: number; reason: string }
  | { action: "REPAY"; amount: number; reason: string; cutSpending?: boolean }
  | { action: "NONE"; reason: string; cutSpending?: boolean };

export function decideLoan(input: {
  loan: LoanReading;
  treasury: number;
  /** Net of everything the city earns and spends each month, loan payments included. */
  monthlyBalance: number;
  bottleneck: GrowthBottleneck;
  /** Whether the supply the city needs is being taken up (see `neededStockAbsorbing`). */
  absorbing: boolean;
  /**
   * V2: the batch is limited by cash rather than by what the city can take up. False means more cash would buy nothing, so a loan would
   * not either. Absent: the earlier test (`absorbing`) alone decides.
   */
  capitalBound?: boolean;
  cycle: number;
  /** Cycle before which no new loan step is taken (used when no game-time block is given). */
  blockedUntilCycle: number;
  /**
   * The block in game time: no new step until `hours` of game time (or, with no readable clock, `cycles` cycles) have passed since `since`.
   * Wins over `blockedUntilCycle` when given.
   */
  block?: { since: GameStamp; hours: number; cycles: number } | null;
  /** The city's time now; read with `block`. */
  now?: GameStamp;
}): LoanDecision {
  const { loan, treasury, monthlyBalance } = input;
  const tier = loanTier(loan.amount, loan.creditworthiness);
  // Beyond the top tier the debt is a structural signal: pay it down as far as the treasury allows and stop spending outward.
  if (tier === "CUT_SPENDING" && loan.amount > 0) {
    const amount = Math.min(loan.amount, Math.max(0, treasury - EXPANSION_DEVIATION_RESERVE));
    if (amount >= BORROW_STEP / 2) return { action: "REPAY", amount: Math.floor(amount / 1_000) * 1_000, cutSpending: true,
      reason: `borrowed ${Math.round((loan.amount / Math.max(1, loan.creditworthiness)) * 100)}% of the credit line: repaying and cutting outward spending` };
    return { action: "NONE", cutSpending: true, reason: `borrowed ${Math.round((loan.amount / Math.max(1, loan.creditworthiness)) * 100)}% of the credit line: cutting outward spending, nothing to repay with` };
  }
  // Repay first: idle money beyond the cushion is not worth the interest.
  if (loan.amount > 0 && treasury > REPAY_WHEN_RESERVES_ABOVE * EXPANSION_DEVIATION_RESERVE) {
    const amount = Math.min(loan.amount, treasury - KEEP_RESERVES_AFTER_REPAYING * EXPANSION_DEVIATION_RESERVE);
    if (amount >= BORROW_STEP / 2) return { action: "REPAY", amount: Math.floor(amount / 1_000) * 1_000, reason: "the treasury stands well above the reserve" };
  }
  // The loan rules keep their own yardstick — "comfortable cash" (`EXPANSION_DEVIATION_RESERVE`), deliberately apart from the land rule, which no longer
  // holds a fixed reserve at all: a city one build short still borrows for it, which is the point of the credit line (the guides: loans are the fastest lump
  // sum, taken for what the city cannot yet pay for out of earnings).
  const required = EXPANSION_DEVIATION_RESERVE + expansionCashRequired(monthlyBalance) + PLANNED_BUILD_COST;
  if (treasury >= required) return { action: "NONE", reason: "the cash already covers the next build" };
  const blocked = input.block && input.now
    ? !stampElapsed(input.block.since, input.now, input.block.hours, input.block.cycles)
    : input.cycle < input.blockedUntilCycle;
  if (blocked) return { action: "NONE", reason: "a recent loan step is still being judged" };
  if (!(monthlyBalance > 0)) return { action: "NONE", reason: "the city does not earn more than it spends: a loan would carry a deficit (K33)" };
  if (input.bottleneck !== "HOUSING" && input.bottleneck !== "JOBS") return { action: "NONE", reason: "no proven bottleneck for the money to relieve" };
  if (!input.absorbing) return { action: "NONE", reason: "the supply the city needs is not being taken up, so more of it would not pay" };
  if (input.capitalBound === false) return { action: "NONE", reason: "the batch is limited by what the city can take up, not by cash" };
  if (tier !== "GROWTH") return { action: "NONE", reason: `${Math.round((loan.amount / Math.max(1, loan.creditworthiness)) * 100)}% of the credit line is already borrowed: from ${Math.round(GROWTH_BORROW_SHARE * 100)}% the marginal cost is for repairs only` };
  // Room is what keeps the borrowed share below the growth tier AFTER this step.
  const room = loan.creditworthiness * GROWTH_BORROW_SHARE - loan.amount;
  if (room < BORROW_STEP) return { action: "NONE", reason: `the debt already stands at ${Math.round(GROWTH_BORROW_SHARE * 100)}% of the credit line, the top of the growth tier` };
  const amount = Math.min(room, roundUp(required - treasury, BORROW_STEP));
  return { action: "BORROW", amount, reason: `${input.bottleneck} is the bottleneck and its supply is being taken up; the cash is ${Math.round(required - treasury)} short of the next build` };
}

/** After a step: do the payments fit what the city earns? The game's own figures decide, not the plan. */
export function paymentsFit(loan: LoanReading, monthlyBalanceBeforeLoan: number): boolean {
  return loan.dailyPayment * 30 <= monthlyBalanceBeforeLoan * MAXIMUM_PAYMENT_SHARE_OF_BALANCE;
}
