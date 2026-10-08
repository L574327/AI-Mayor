import { describe, expect, test } from "@jest/globals";
import {
  calculateDeepSeekCost,
  getDeepSeekPricingPeriod,
  summarizeDeepSeekTurn,
} from "../../src/intellichat/telemetry/deepseekCost";

const usage = {
  promptTokens: 1_000_000,
  promptCacheHitTokens: 250_000,
  promptCacheMissTokens: 750_000,
  completionTokens: 100_000,
  reasoningTokens: 40_000,
  totalTokens: 1_100_000,
};

describe("DeepSeek cost telemetry", () => {
  test("uses the configured weekday peak windows", () => {
    expect(getDeepSeekPricingPeriod(new Date("2026-09-09T01:00:00Z"))).toBe("peak");
    expect(getDeepSeekPricingPeriod(new Date("2026-09-09T04:00:00Z"))).toBe("offPeak");
    expect(getDeepSeekPricingPeriod(new Date("2026-09-09T06:00:00Z"))).toBe("peak");
    expect(getDeepSeekPricingPeriod(new Date("2026-09-09T10:00:00Z"))).toBe("offPeak");
    expect(getDeepSeekPricingPeriod(new Date("2026-09-12T02:00:00Z"))).toBe("offPeak");
  });

  test("separates cached input, uncached input, and output estimates", () => {
    const cost = calculateDeepSeekCost("deepseek-v4-flash", usage, new Date("2026-09-09T02:00:00Z"), "USD");

    expect(cost).toMatchObject({ currency: "USD", pricingPeriod: "peak", isEstimate: true });
    expect(cost?.cachedInput).toBeCloseTo(0.0035);
    expect(cost?.uncachedInput).toBeCloseTo(0.33);
    expect(cost?.output).toBeCloseTo(0.132);
    expect(cost?.total).toBeCloseTo(0.4655);
  });

  test("calculates CNY Flash off-peak and peak prices", () => {
    const offPeak = calculateDeepSeekCost("deepseek-v4-flash", usage, new Date("2026-09-09T14:59:00Z"), "CNY");
    const peak = calculateDeepSeekCost("deepseek-v4-flash", usage, new Date("2026-09-09T02:00:00Z"), "CNY");

    expect(offPeak).toMatchObject({ currency: "CNY", pricingPeriod: "offPeak" });
    expect(offPeak?.cachedInput).toBeCloseTo(0.0125);
    expect(offPeak?.uncachedInput).toBeCloseTo(1.125);
    expect(offPeak?.output).toBeCloseTo(0.45);
    expect(offPeak?.total).toBeCloseTo(1.5875);
    expect(peak?.total).toBeCloseTo(3.175);
  });

  test("calculates CNY Pro cache hit, miss and output separately", () => {
    const cost = calculateDeepSeekCost("deepseek-v4-pro", usage, new Date("2026-09-09T14:59:00Z"), "CNY");

    expect(cost).toMatchObject({ currency: "CNY", pricingModel: "deepseek-v4-pro", pricingPeriod: "offPeak" });
    expect(cost?.cachedInput).toBeCloseTo(0.0375);
    expect(cost?.uncachedInput).toBeCloseTo(3.375);
    expect(cost?.output).toBeCloseTo(1.35);
    expect(cost?.total).toBeCloseTo(4.7625);
  });

  test("recalculates the observed telemetry turn in CNY", () => {
    const observedUsage = {
      promptTokens: 33_913,
      promptCacheHitTokens: 31_104,
      promptCacheMissTokens: 2_809,
      completionTokens: 588,
      reasoningTokens: 89,
      totalTokens: 34_501,
    };
    const cost = calculateDeepSeekCost("deepseek-v4-flash", observedUsage, new Date("2026-09-09T14:59:00Z"), "CNY");

    expect(cost?.pricingPeriod).toBe("offPeak");
    expect(cost?.cachedInput).toBeCloseTo(0.0015552);
    expect(cost?.uncachedInput).toBeCloseTo(0.0042135);
    expect(cost?.output).toBeCloseTo(0.002646);
    expect(cost?.total).toBeCloseTo(0.0084147);
  });

  test("aggregates a complete tool-call turn without double billing reasoning tokens", () => {
    const summary = summarizeDeepSeekTurn({
      turnId: "turn-1",
      chatId: "chat-1",
      startedAt: "2026-09-09T00:00:00Z",
      requests: [
        {
          sequence: 1,
          requestId: "request-1",
          model: "deepseek-v4-pro",
          startedAt: "2026-09-09T00:00:00Z",
          isMcpToolContinuation: false,
          messageCount: 1,
          usage,
        },
        {
          sequence: 2,
          requestId: "request-2",
          model: "deepseek-v4-pro",
          startedAt: "2026-09-09T00:00:01Z",
          isMcpToolContinuation: true,
          messageCount: 3,
          usage,
        },
      ],
    });

    expect(summary).toMatchObject({
      apiRequestCount: 2,
      promptTokens: 2_000_000,
      promptCacheHitTokens: 500_000,
      promptCacheMissTokens: 1_500_000,
      completionTokens: 200_000,
      reasoningTokens: 80_000,
      totalTokens: 2_200_000,
      cacheHitRatio: 0.25,
    });
  });
});
