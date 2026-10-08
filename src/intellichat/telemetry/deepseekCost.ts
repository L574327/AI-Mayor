import type { IChatUsage } from "intellichat/types";

export type DeepSeekPricingPeriod = "peak" | "offPeak";
export type DeepSeekCurrency = "CNY" | "USD";

type DeepSeekModelPrice = Record<
  DeepSeekPricingPeriod,
  {
    cachedInputPerMillion: number;
    uncachedInputPerMillion: number;
    outputPerMillion: number;
  }
>;

export const DEEPSEEK_PRICING = {
  unitTokens: 1_000_000,
  peakWindowsBeijing: [
    { startHour: 9, endHour: 12 },
    { startHour: 14, endHour: 18 },
  ],
  currencies: {
    CNY: {
      effectiveFrom: "2026-08-17T00:00:00+08:00",
      source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
      models: {
        "deepseek-v4-flash": {
          offPeak: {
            cachedInputPerMillion: 0.05,
            uncachedInputPerMillion: 1.5,
            outputPerMillion: 4.5,
          },
          peak: {
            cachedInputPerMillion: 0.1,
            uncachedInputPerMillion: 3,
            outputPerMillion: 9,
          },
        },
        "deepseek-v4-pro": {
          offPeak: {
            cachedInputPerMillion: 0.15,
            uncachedInputPerMillion: 4.5,
            outputPerMillion: 13.5,
          },
          peak: {
            cachedInputPerMillion: 0.3,
            uncachedInputPerMillion: 9,
            outputPerMillion: 27,
          },
        },
      },
    },
    USD: {
      effectiveFrom: "2026-08-16T16:00:00Z",
      source: "https://api-docs.deepseek.com/quick_start/pricing/",
      models: {
        "deepseek-v4-flash": {
          offPeak: {
            cachedInputPerMillion: 0.007,
            uncachedInputPerMillion: 0.22,
            outputPerMillion: 0.66,
          },
          peak: {
            cachedInputPerMillion: 0.014,
            uncachedInputPerMillion: 0.44,
            outputPerMillion: 1.32,
          },
        },
        "deepseek-v4-pro": {
          offPeak: {
            cachedInputPerMillion: 0.022,
            uncachedInputPerMillion: 0.66,
            outputPerMillion: 1.98,
          },
          peak: {
            cachedInputPerMillion: 0.044,
            uncachedInputPerMillion: 1.32,
            outputPerMillion: 3.96,
          },
        },
      },
    },
  } satisfies Record<
    DeepSeekCurrency,
    {
      effectiveFrom: string;
      source: string;
      models: Record<string, DeepSeekModelPrice>;
    }
  >,
} as const;

type DeepSeekPricingModel = keyof (typeof DEEPSEEK_PRICING.currencies)["CNY"]["models"];

const MODEL_ALIASES: Record<string, DeepSeekPricingModel> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-flash",
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4-pro-0813": "deepseek-v4-pro",
};

export interface DeepSeekEstimatedCost {
  currency: DeepSeekCurrency;
  pricingModel: DeepSeekPricingModel;
  pricingPeriod: DeepSeekPricingPeriod;
  cachedInput: number;
  uncachedInput: number;
  output: number;
  total: number;
  isEstimate: true;
}

export interface DeepSeekApiRequestTelemetry {
  sequence: number;
  requestId: string;
  transportRequestId?: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  isMcpToolContinuation: boolean;
  messageCount: number;
  usage?: IChatUsage;
  estimatedCost?: DeepSeekEstimatedCost;
  error?: string;
}

export interface DeepSeekChatTurnTelemetry {
  turnId: string;
  chatId: string;
  startedAt: string;
  endedAt?: string;
  requests: DeepSeekApiRequestTelemetry[];
}

export function getDeepSeekPricingPeriod(at: Date): DeepSeekPricingPeriod {
  const beijingTime = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  const day = beijingTime.getUTCDay();
  const isWeekday = day >= 1 && day <= 5;
  const hour = beijingTime.getUTCHours();
  const isPeakHour = DEEPSEEK_PRICING.peakWindowsBeijing.some(
    ({ startHour, endHour }) => hour >= startHour && hour < endHour,
  );
  return isWeekday && isPeakHour ? "peak" : "offPeak";
}

function resolvePricingModel(model: string): DeepSeekPricingModel | undefined {
  const normalized = model.toLowerCase();
  if (normalized in DEEPSEEK_PRICING.currencies.CNY.models) {
    return normalized as DeepSeekPricingModel;
  }
  return MODEL_ALIASES[normalized];
}

export function calculateDeepSeekCost(
  model: string,
  usage: IChatUsage,
  at: Date,
  currency: DeepSeekCurrency = "USD",
): DeepSeekEstimatedCost | undefined {
  const pricingModel = resolvePricingModel(model);
  if (!pricingModel) return undefined;

  const pricingPeriod = getDeepSeekPricingPeriod(at);
  const prices = DEEPSEEK_PRICING.currencies[currency].models[pricingModel][pricingPeriod];
  const divisor = DEEPSEEK_PRICING.unitTokens;
  const cachedInput = (usage.promptCacheHitTokens * prices.cachedInputPerMillion) / divisor;
  const uncachedInput = (usage.promptCacheMissTokens * prices.uncachedInputPerMillion) / divisor;
  const output = (usage.completionTokens * prices.outputPerMillion) / divisor;

  return {
    currency,
    pricingModel,
    pricingPeriod,
    cachedInput,
    uncachedInput,
    output,
    total: cachedInput + uncachedInput + output,
    isEstimate: true,
  };
}

export function summarizeDeepSeekTurn(turn: DeepSeekChatTurnTelemetry) {
  const usage = turn.requests.reduce<IChatUsage>(
    (total, request) => ({
      promptTokens: total.promptTokens + (request.usage?.promptTokens ?? 0),
      promptCacheHitTokens: total.promptCacheHitTokens + (request.usage?.promptCacheHitTokens ?? 0),
      promptCacheMissTokens: total.promptCacheMissTokens + (request.usage?.promptCacheMissTokens ?? 0),
      completionTokens: total.completionTokens + (request.usage?.completionTokens ?? 0),
      reasoningTokens: total.reasoningTokens + (request.usage?.reasoningTokens ?? 0),
      totalTokens: total.totalTokens + (request.usage?.totalTokens ?? 0),
    }),
    {
      promptTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  );
  const estimatedCost = turn.requests.reduce(
    (total, request) => ({
      cachedInput: total.cachedInput + (request.estimatedCost?.cachedInput ?? 0),
      uncachedInput: total.uncachedInput + (request.estimatedCost?.uncachedInput ?? 0),
      output: total.output + (request.estimatedCost?.output ?? 0),
      total: total.total + (request.estimatedCost?.total ?? 0),
    }),
    { cachedInput: 0, uncachedInput: 0, output: 0, total: 0 },
  );
  const currency = turn.requests.find((request) => request.estimatedCost)?.estimatedCost?.currency ?? "USD";

  return {
    turnId: turn.turnId,
    chatId: turn.chatId,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    apiRequestCount: turn.requests.length,
    ...usage,
    cacheHitRatio: usage.promptTokens > 0 ? usage.promptCacheHitTokens / usage.promptTokens : 0,
    estimatedCost: {
      currency,
      ...estimatedCost,
      isEstimate: true as const,
    },
  };
}
