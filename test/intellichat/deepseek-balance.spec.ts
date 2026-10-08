import { describe, expect, test } from "@jest/globals";
import { buildDeepSeekBalanceUrl, shouldRefreshDeepSeekBalance } from "../../src/main/services/deepseek-balance";

describe("DeepSeek balance refresh policy", () => {
  test("uses the official balance path instead of the chat /v1 path", () => {
    expect(buildDeepSeekBalanceUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/user/balance");
  });

  test("refreshes at session boundaries and manually, but throttles periodic checks", () => {
    const lastFetchedAt = new Date("2026-09-09T00:00:00Z");
    expect(shouldRefreshDeepSeekBalance("sessionStart", lastFetchedAt, new Date("2026-09-09T00:01:00Z"))).toBe(true);
    expect(shouldRefreshDeepSeekBalance("sessionEnd", lastFetchedAt, new Date("2026-09-09T00:01:00Z"))).toBe(true);
    expect(shouldRefreshDeepSeekBalance("manual", lastFetchedAt, new Date("2026-09-09T00:01:00Z"))).toBe(true);
    expect(shouldRefreshDeepSeekBalance("periodic", lastFetchedAt, new Date("2026-09-09T00:04:59Z"))).toBe(false);
    expect(shouldRefreshDeepSeekBalance("periodic", lastFetchedAt, new Date("2026-09-09T00:05:00Z"))).toBe(true);
  });
});
