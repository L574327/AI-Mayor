import type { DeepSeekCurrency, DeepSeekEstimatedCost } from "./deepseekCost";

export type DeepSeekBalanceStatus = "available" | "unavailable" | "error";

export interface DeepSeekSessionCostState {
  sessionStartBalance: number | null;
  currentBalance: number | null;
  estimatedSessionCost: number;
  requestCount: number;
  currency: DeepSeekCurrency;
  maxSessionSpend?: number;
  minimumBalance?: number;
  startedAt: string;
  balanceStatus: DeepSeekBalanceStatus;
  isBalanceAvailable: boolean;
}

export interface CreateDeepSeekSessionCostStateOptions {
  currentBalance?: number | null;
  currency: DeepSeekCurrency;
  maxSessionSpend?: number;
  minimumBalance?: number;
  startedAt?: Date;
  balanceStatus?: DeepSeekBalanceStatus;
  isBalanceAvailable?: boolean;
}

export interface DeepSeekSessionBalanceUpdate {
  isAvailable: boolean;
  currency: DeepSeekCurrency;
  totalBalance: number;
}

export function createDeepSeekSessionCostState(
  options: CreateDeepSeekSessionCostStateOptions,
): DeepSeekSessionCostState {
  const currentBalance = options.currentBalance ?? null;
  return {
    sessionStartBalance: currentBalance,
    currentBalance,
    estimatedSessionCost: 0,
    requestCount: 0,
    currency: options.currency,
    maxSessionSpend: options.maxSessionSpend,
    minimumBalance: options.minimumBalance,
    startedAt: (options.startedAt ?? new Date()).toISOString(),
    balanceStatus: options.balanceStatus ?? (currentBalance === null ? "unavailable" : "available"),
    isBalanceAvailable: options.isBalanceAvailable ?? currentBalance !== null,
  };
}

export function addEstimatedRequestCost(
  state: DeepSeekSessionCostState,
  cost: DeepSeekEstimatedCost,
): DeepSeekSessionCostState {
  if (cost.currency !== state.currency) {
    throw new Error(`cost currency ${cost.currency} does not match session currency ${state.currency}`);
  }
  return {
    ...state,
    estimatedSessionCost: state.estimatedSessionCost + cost.total,
    requestCount: state.requestCount + 1,
  };
}

export function updateSessionBalance(
  state: DeepSeekSessionCostState,
  balance: DeepSeekSessionBalanceUpdate,
): DeepSeekSessionCostState {
  if (balance.currency !== state.currency) {
    throw new Error(`balance currency ${balance.currency} does not match session currency ${state.currency}`);
  }
  return {
    ...state,
    sessionStartBalance: state.sessionStartBalance ?? balance.totalBalance,
    currentBalance: balance.totalBalance,
    balanceStatus: "available",
    isBalanceAvailable: balance.isAvailable,
  };
}

export function markSessionBalanceFailure(
  state: DeepSeekSessionCostState,
  balanceStatus: "unavailable" | "error",
): DeepSeekSessionCostState {
  return {
    ...state,
    currentBalance: null,
    balanceStatus,
    isBalanceAvailable: false,
  };
}

export function remainingSessionBudget(state: DeepSeekSessionCostState): number | null {
  if (state.maxSessionSpend === undefined) return null;
  return Math.max(0, state.maxSessionSpend - state.estimatedSessionCost);
}

export function shouldStopForBudget(state: DeepSeekSessionCostState): boolean {
  return state.maxSessionSpend !== undefined && state.estimatedSessionCost >= state.maxSessionSpend;
}

export function shouldStopForBalance(state: DeepSeekSessionCostState): boolean {
  if (state.balanceStatus !== "available" || !state.isBalanceAvailable || state.currentBalance === null) {
    return true;
  }
  return state.minimumBalance !== undefined && state.currentBalance <= state.minimumBalance;
}

export function canContinue(state: DeepSeekSessionCostState): boolean {
  return !shouldStopForBudget(state) && !shouldStopForBalance(state);
}
