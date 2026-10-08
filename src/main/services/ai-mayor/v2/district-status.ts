/**
 * The one line a reader of a run sees for a district cycle, with the REASON first.
 *
 * Measured live (2026-10-04): the status was the cycle's notes joined and cut at 240 characters, and a notes list opens with the policy's own
 * line (`V2 S0 | seed-bound batch ...`, then the orphan-network note), so the reason the cycle built nothing, which comes last, was cut off.
 * Four ticks in a row read `DISTRICT_BUILDER_NOTHING_TO_BUILD:V2 district builder: V2 S0 | seed-bound batch 115200 m2; orphan network ...`
 * and nothing in the evidence said why until the full ledger text was read by hand.
 */
export interface DistrictOutcomeLike {
  status: string;
  outcome?: string;
  waitReason?: string;
  role?: string | null;
  intentUnmet?: boolean;
  notes: readonly string[];
  feasibility?: { reason?: string; survey?: object; siteChecks?: object };
}

/** Counters of a survey / site-check object that are above zero, as `name=count`: the gate that removed the candidates. */
function activeGates(counters: object | undefined): string {
  if (!counters) return "";
  return Object.entries(counters as Record<string, unknown>)
    .filter(([name, value]) => typeof value === "number" && value > 0 && !["considered", "offered", "examined", "eligible"].includes(name))
    .map(([name, value]) => `${name}=${value}`).join(",");
}

export function describeDistrictOutcome(outcome: DistrictOutcomeLike, maximumLength = 300): string {
  const gates = [activeGates(outcome.feasibility?.survey), activeGates(outcome.feasibility?.siteChecks)].filter(Boolean).join(",");
  const head = [
    `${outcome.intentUnmet ? "INTENT_UNMET " : ""}V2 district builder: ${outcome.outcome ?? outcome.status}`,
    outcome.waitReason, outcome.feasibility?.reason, gates ? `[${gates}]` : null,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  const tail = outcome.notes.slice(-2).filter((note) => note.length > 0).join(" | ");
  return `${head} | role=${outcome.role ?? "?"}${tail ? ` | ${tail}` : ""}`.slice(0, maximumLength);
}
