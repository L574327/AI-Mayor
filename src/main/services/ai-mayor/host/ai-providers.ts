/**
 * AI service routing for the semantic frontend: which wire format a key/endpoint speaks, how to send one prompt, and where (if anywhere) the
 * service tells its balance. Two formats cover the market: OpenAI chat-completions (OpenAI, DeepSeek, Gemini's OpenAI endpoint, OpenRouter and
 * nearly every third-party relay) and Anthropic messages (Claude, and the relays that mirror it). Nothing here is ever on the Mayor's critical
 * path: a failure is reported as text and the local reader answers instead.
 */
import type { UsageMeter } from "./ai-usage";
export type ProviderPreset = "auto" | "deepseek" | "openai" | "claude" | "gemini" | "openrouter" | "custom-openai" | "custom-claude";
export type WireFormat = "openai" | "anthropic";

export interface ProviderConfig { preset: ProviderPreset; baseUrl: string; apiKey: string; model: string }

interface PresetInfo { format: WireFormat; baseUrl: string; model: string; balance: "deepseek" | "openrouter" | "openai-billing" | "none" }
export const PRESETS: Record<Exclude<ProviderPreset, "auto">, PresetInfo> = {
  deepseek: { format: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", balance: "deepseek" },
  openai: { format: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", balance: "none" },
  claude: { format: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5-20251001", balance: "none" },
  gemini: { format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", balance: "none" },
  openrouter: { format: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", balance: "openrouter" },
  // Third-party relays: whatever base URL and model the player enters; one-api / new-api relays answer the legacy OpenAI billing endpoints.
  "custom-openai": { format: "openai", baseUrl: "", model: "", balance: "openai-billing" },
  "custom-claude": { format: "anthropic", baseUrl: "", model: "", balance: "none" },
};

/**
 * Which service a key and base URL belong to. The key's own prefix decides when it is unambiguous (sk-ant- Claude, AIza Gemini, sk-or- OpenRouter);
 * a plain sk- key is told apart by the base URL, and without one it stays "auto" (the player picks: OpenAI, DeepSeek and most relays share it).
 */
export function detectPreset(apiKey: string, baseUrl: string): Exclude<ProviderPreset, "auto"> | null {
  const key = apiKey.trim();
  const url = baseUrl.trim().toLowerCase();
  if (url.includes("api.anthropic.com")) return "claude";
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("generativelanguage.googleapis.com")) return "gemini";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (/^sk-ant-/.test(key)) return url ? "custom-claude" : "claude";
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) return "gemini";
  if (/^sk-or-/.test(key)) return "openrouter";
  if (url) return "custom-openai";
  return null;
}

/** The concrete endpoint, format and model for a stored config (preset defaults fill what the player left empty). */
export function resolveProvider(config: ProviderConfig): { preset: Exclude<ProviderPreset, "auto">; format: WireFormat; baseUrl: string; model: string; balance: PresetInfo["balance"] } | null {
  const preset = config.preset === "auto" ? detectPreset(config.apiKey, config.baseUrl) : config.preset;
  if (!preset) return null;
  const info = PRESETS[preset];
  const baseUrl = (config.baseUrl.trim() || info.baseUrl).replace(/\/+$/, "");
  const model = config.model.trim() || info.model;
  if (!baseUrl || !model) return null;
  return { preset, format: info.format, baseUrl, model, balance: info.balance };
}

export interface ChatResult { ok: boolean; text: string; detail: string }

let usageMeter: UsageMeter | null = null;
/** The meter every call to the player's AI service is counted by and held to (`ai-usage.ts`); none = uncounted (tests, tools). */
export function setUsageMeter(meter: UsageMeter | null): void { usageMeter = meter; }
/** The service's own token count when it gives one, else about three characters a token. */
const tokensUsed = (counted: number | undefined, prompt: string, answer: string): number => (typeof counted === "number" && Number.isFinite(counted) && counted >= 0 ? counted : Math.ceil((prompt.length + answer.length) / 3));

/** One prompt, one answer: temperature 0, short output, bounded time. */
export async function sendPrompt(config: ProviderConfig, prompt: string, fetchImpl: typeof fetch = fetch, timeoutMs = 25_000): Promise<ChatResult> {
  const provider = resolveProvider(config);
  if (!provider) return { ok: false, text: "", detail: "choose the service (or enter its address) first" };
  const allowed = usageMeter?.check();
  if (allowed && !allowed.ok) return { ok: false, text: "", detail: allowed.detail };
  try {
    if (provider.format === "anthropic") {
      const response = await fetchImpl(`${provider.baseUrl}/messages`, {
        method: "POST", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", "x-api-key": config.apiKey.trim(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: provider.model, max_tokens: 200, temperature: 0, messages: [{ role: "user", content: prompt }] }),
      });
      const body = await response.json().catch(() => ({})) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
      if (!response.ok) return { ok: false, text: "", detail: `${response.status} ${body.error?.message ?? ""}`.trim().slice(0, 200) };
      const answer = (body.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      usageMeter?.record(tokensUsed(body.usage ? (body.usage.input_tokens ?? 0) + (body.usage.output_tokens ?? 0) : undefined, prompt, answer));
      return { ok: true, text: answer, detail: "" };
    }
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey.trim()}` },
      body: JSON.stringify({ model: provider.model, temperature: 0, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number }; error?: { message?: string } | string };
    if (!response.ok) return { ok: false, text: "", detail: `${response.status} ${typeof body.error === "string" ? body.error : body.error?.message ?? ""}`.trim().slice(0, 200) };
    const answer = String(body.choices?.[0]?.message?.content ?? "");
    usageMeter?.record(tokensUsed(body.usage?.total_tokens, prompt, answer));
    return { ok: true, text: answer, detail: "" };
  } catch (error) {
    return { ok: false, text: "", detail: `could not reach the service (${error instanceof Error ? error.message : String(error)})`.slice(0, 200) };
  }
}

export interface Balance { supported: boolean; amount: number | null; currency: string | null; detail: string }

/** The balance, where the service publishes one. Services that do not (OpenAI, Anthropic with a plain key) are said to not support it — never guessed. */
export async function queryBalance(config: ProviderConfig, fetchImpl: typeof fetch = fetch): Promise<Balance> {
  const provider = resolveProvider(config);
  if (!provider) return { supported: false, amount: null, currency: null, detail: "no service configured" };
  const get = async (url: string) => {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${config.apiKey.trim()}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(String(response.status));
    return response.json() as Promise<Record<string, any>>;
  };
  try {
    if (provider.balance === "deepseek") {
      const origin = new URL(provider.baseUrl).origin;
      const body = await get(`${origin}/user/balance`);
      const info = (Array.isArray(body.balance_infos) ? body.balance_infos : [])[0] ?? {};
      return { supported: true, amount: Number(info.total_balance ?? NaN), currency: String(info.currency ?? "CNY"), detail: "" };
    }
    if (provider.balance === "openrouter") {
      const body = await get(`${provider.baseUrl}/credits`);
      const data = body.data ?? {};
      return { supported: true, amount: Number(data.total_credits ?? 0) - Number(data.total_usage ?? 0), currency: "USD", detail: "" };
    }
    if (provider.balance === "openai-billing") {
      // one-api / new-api relays: the legacy subscription (hard limit) minus this month's usage (cents).
      const subscription = await get(`${provider.baseUrl.replace(/\/v1$/, "")}/v1/dashboard/billing/subscription`);
      const limit = Number(subscription.hard_limit_usd ?? subscription.system_hard_limit_usd ?? NaN);
      let used = 0;
      try { used = Number((await get(`${provider.baseUrl.replace(/\/v1$/, "")}/v1/dashboard/billing/usage`)).total_usage ?? 0) / 100; } catch { /* limit alone */ }
      if (!Number.isFinite(limit)) return { supported: false, amount: null, currency: null, detail: "this relay does not publish a balance" };
      return { supported: true, amount: limit - used, currency: "USD", detail: "" };
    }
    return { supported: false, amount: null, currency: null, detail: "this service does not publish a balance for an API key" };
  } catch (error) {
    return { supported: false, amount: null, currency: null, detail: `balance not available (${error instanceof Error ? error.message : String(error)})` };
  }
}
