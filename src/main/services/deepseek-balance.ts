import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";

export type DeepSeekBalanceCurrency = "CNY" | "USD";

export interface DeepSeekBalance {
  isAvailable: boolean;
  currency: DeepSeekBalanceCurrency;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
  fetchedAt: string;
}

export interface DeepSeekBalanceRequest {
  apiBase: string;
  apiKey: string;
  proxy?: string;
}

interface DeepSeekBalancePayload {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: string;
    granted_balance?: string;
    topped_up_balance?: string;
  }>;
}

export const DEEPSEEK_BALANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export type DeepSeekBalanceRefreshReason = "sessionStart" | "periodic" | "sessionEnd" | "manual";

export function shouldRefreshDeepSeekBalance(
  reason: DeepSeekBalanceRefreshReason,
  lastFetchedAt?: Date,
  now = new Date(),
): boolean {
  if (reason !== "periodic" || !lastFetchedAt) return true;
  return now.getTime() - lastFetchedAt.getTime() >= DEEPSEEK_BALANCE_REFRESH_INTERVAL_MS;
}

export function buildDeepSeekBalanceUrl(apiBase: string): string {
  const url = new URL(apiBase.trim());
  url.pathname = `${url.pathname.replace(/\/?v1\/?$/i, "").replace(/\/$/, "")}/user/balance`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function fetchDeepSeekBalance(request: DeepSeekBalanceRequest): Promise<DeepSeekBalance> {
  const apiKey = request.apiKey.trim();
  if (!apiKey) throw new Error("DeepSeek API key is not configured");

  const agent = request.proxy ? new HttpsProxyAgent(request.proxy) : undefined;
  const response = await fetch(buildDeepSeekBalanceUrl(request.apiBase), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(agent ? { agent } : {}),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek balance request failed (HTTP ${response.status})`);
  }

  const payload = (await response.json()) as DeepSeekBalancePayload;
  const info = payload.balance_infos?.[0];
  if (!info || (info.currency !== "CNY" && info.currency !== "USD")) {
    throw new Error("DeepSeek balance response did not contain a supported currency");
  }

  const parseAmount = (value: string | undefined, field: string) => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new Error(`DeepSeek balance response contained invalid ${field}`);
    return amount;
  };

  return {
    isAvailable: payload.is_available === true,
    currency: info.currency,
    totalBalance: parseAmount(info.total_balance, "total_balance"),
    grantedBalance: parseAmount(info.granted_balance, "granted_balance"),
    toppedUpBalance: parseAmount(info.topped_up_balance, "topped_up_balance"),
    fetchedAt: new Date().toISOString(),
  };
}
