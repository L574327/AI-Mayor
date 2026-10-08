import fs from "node:fs";
import path from "node:path";

/**
 * TOKEN USE AND A DAILY CAP for the player's own AI service (host/ai-providers.ts is the one place that calls it).
 *
 * The Mayor itself costs nothing: the external AI only turns a sentence into a goal, a few hundred tokens each time. The cap exists so a stuck loop or a
 * very chatty service can never spend the player's money unnoticed: once the day's tokens reach the limit the AI is not called any more (the local reader
 * and the assisted mode keep working) until the next local day. 0 means no cap. The count is kept per local calendar day in one small file.
 */
export const DEFAULT_DAILY_TOKEN_LIMIT = 200_000;

export interface UsageSnapshot { date: string; tokens: number; calls: number; limit: number }

export interface UsageMeter {
  /** Whether one more call may be made now. */
  check(): { ok: true } | { ok: false; detail: string };
  /** What a finished call used (the service's own count, else an estimate). */
  record(tokens: number): void;
  snapshot(): UsageSnapshot;
}

const localDate = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export function createFileUsageMeter(options: { file: string; limit: () => number; now?: () => Date }): UsageMeter {
  const now = options.now ?? (() => new Date());
  const read = (): { date: string; tokens: number; calls: number } => {
    const today = localDate(now());
    try {
      const parsed = JSON.parse(fs.readFileSync(options.file, "utf8")) as { date?: unknown; tokens?: unknown; calls?: unknown };
      if (parsed.date === today && typeof parsed.tokens === "number" && typeof parsed.calls === "number") return { date: today, tokens: parsed.tokens, calls: parsed.calls };
    } catch { /* no file yet, or a damaged one: a new day's count starts at zero */ }
    return { date: today, tokens: 0, calls: 0 };
  };
  const limit = (): number => { const value = options.limit(); return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; };
  return {
    check() {
      const used = read();
      const cap = limit();
      if (cap > 0 && used.tokens >= cap) {
        return { ok: false, detail: `daily AI limit reached (${used.tokens} of ${cap} tokens used today); it resets tomorrow, or raise it in Settings. The local reader still works.` };
      }
      return { ok: true };
    },
    record(tokens) {
      const used = read();
      const next = { date: used.date, tokens: used.tokens + Math.max(0, Math.round(tokens)), calls: used.calls + 1 };
      try { fs.mkdirSync(path.dirname(options.file), { recursive: true }); fs.writeFileSync(options.file, JSON.stringify(next), "utf8"); } catch { /* the count is a safety net; a failed write never stops the Mayor */ }
    },
    snapshot() { const used = read(); return { ...used, limit: limit() }; },
  };
}