import { detectPreset, queryBalance, resolveProvider, sendPrompt } from "../../src/main/services/ai-mayor/host/ai-providers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AI provider routing", () => {
  it("tells services apart by the key's prefix, and a plain sk- key by its address", () => {
    expect(detectPreset("sk-ant-api03-abc", "")).toBe("claude");
    expect(detectPreset("AIzaSyA1234567890abcdefghijk", "")).toBe("gemini");
    expect(detectPreset("sk-or-v1-abc", "")).toBe("openrouter");
    expect(detectPreset("sk-1234", "https://api.deepseek.com/v1")).toBe("deepseek");
    expect(detectPreset("sk-1234", "https://my-relay.example.com/v1")).toBe("custom-openai");
    expect(detectPreset("sk-ant-api03-abc", "https://claude-relay.example.com/v1")).toBe("custom-claude");
    expect(detectPreset("sk-1234", "")).toBeNull();
  });

  it("fills defaults the player left empty, and keeps what they typed", () => {
    expect(resolveProvider({ preset: "deepseek", baseUrl: "", apiKey: "k", model: "" })).toMatchObject({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", format: "openai" });
    expect(resolveProvider({ preset: "custom-openai", baseUrl: "https://relay.example.com/v1/", apiKey: "k", model: "gpt-x" })).toMatchObject({ baseUrl: "https://relay.example.com/v1", model: "gpt-x" });
    expect(resolveProvider({ preset: "custom-openai", baseUrl: "https://relay.example.com/v1", apiKey: "k", model: "" })).toBeNull();
  });

  it("speaks the Anthropic format to Claude and the OpenAI format to the rest", async () => {
    const seen: string[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${Object.keys(init.headers as Record<string, string>).join(",")}`);
      return url.endsWith("/messages") ? json({ content: [{ type: "text", text: "MAYOR-AAAA {}" }] }) : json({ choices: [{ message: { content: "MAYOR-BBBB {}" } }] });
    }) as unknown as typeof fetch;
    expect(await sendPrompt({ preset: "auto", baseUrl: "", apiKey: "sk-ant-x", model: "" }, "p", fake)).toMatchObject({ ok: true, text: "MAYOR-AAAA {}" });
    expect(await sendPrompt({ preset: "deepseek", baseUrl: "", apiKey: "sk-x", model: "" }, "p", fake)).toMatchObject({ ok: true, text: "MAYOR-BBBB {}" });
    expect(seen[0]).toMatch(/anthropic\.com\/v1\/messages .*x-api-key/);
    expect(seen[1]).toMatch(/deepseek\.com\/v1\/chat\/completions .*authorization/);
  });

  it("shows the service's own error, never a stack", async () => {
    const bad = (async () => json({ error: { message: "Invalid API key" } }, 401)) as unknown as typeof fetch;
    expect(await sendPrompt({ preset: "openai", baseUrl: "", apiKey: "sk-x", model: "" }, "p", bad)).toEqual({ ok: false, text: "", detail: "401 Invalid API key" });
  });

  it("reads balances where they exist and says so where they do not", async () => {
    const deepseek = (async () => json({ balance_infos: [{ currency: "CNY", total_balance: "12.50" }] })) as unknown as typeof fetch;
    expect(await queryBalance({ preset: "deepseek", baseUrl: "", apiKey: "k", model: "" }, deepseek)).toMatchObject({ supported: true, amount: 12.5, currency: "CNY" });
    const relay = (async (url: string) => url.endsWith("subscription") ? json({ hard_limit_usd: 20 }) : json({ total_usage: 350 })) as unknown as typeof fetch;
    expect(await queryBalance({ preset: "custom-openai", baseUrl: "https://relay.example.com/v1", apiKey: "k", model: "m" }, relay)).toMatchObject({ supported: true, amount: 16.5, currency: "USD" });
    expect(await queryBalance({ preset: "claude", baseUrl: "", apiKey: "sk-ant-x", model: "" })).toMatchObject({ supported: false });
  });
});
