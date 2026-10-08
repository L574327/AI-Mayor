import * as fs from "node:fs";
import * as path from "node:path";
import { GAME_HOUR_FRAMES, stampElapsed, stampHoursBetween, type GameStamp } from "./game-clock";

/**
 * THE GROWTH GOVERNOR — the macro control and feedback layer over the district builder (the player's question, 2026-10-08: "is there no macro control layer
 * and feedback layer? what happens at the next dead loop?").
 *
 * Each rule of the builder acts on its own input — a labour reading, a planning margin, a land-use prior, the cash — and nothing checked whether what it did
 * had the effect it was for. Live 2026-10-08 every stall was of that kind: offices zoned on a prior stood 96% empty; fourteen districts laid as bare streets
 * while zoning waited on a planning margin; housing frontage zoned industrial on a labour reading while the game asked for no industry; medium rows zoned
 * while the game's own demand for them fell to nil. The governor looks only at OUTCOMES and at the game's own demand, and every builder rule answers to it:
 *
 *  1. OPEN or CLOSED, per use (low/medium/high homes, shops, industry, offices). The game grows a zoned cell only while it has building demand for that use
 *     (community wiki, Zoning: "buildings will be built there automatically over time as long as there is demand"; the demand panel's factors say why).
 *     No building demand: closed for new supply, whatever any other reading says. A use whose own zoning stands empty and does not fill for STUCK_HOURS is
 *     closed too — the measured fill outranks a demand bar that flickers or homes that are built but unlet.
 *  2. PROGRESS. Within PROGRESS_WINDOW_HOURS one of population, built cells, monthly balance must rise or the problem icons fall. When none does the city is
 *     STALLED, and the stall is one of two dead loops:
 *       - BUSY: the Mayor kept doing things with no effect. The action family it did most in the window is suspended (the pause doubles on each repeat).
 *       - IDLE: the Mayor did nothing — every rule was waiting for something that does not come. One supply action is forced past the waits (`forceOne`).
 *     Either way a stall report is written, so the cause is read and fixed at its root afterwards.
 *  3. OUTCOME SCORES. Each supply action (lay a district of a use, zone a use) is judged after JUDGE_HOURS: did the cells it added start to fill? The share of
 *     effective actions per family is kept across sessions (the store is the caller's) — the recorder feeding back into the decisions. A family whose score
 *     falls under SCORE_FLOOR after MINIMUM_JUDGED judgements is suspended like a busy stall.
 *
 * It never guarantees that the city never stalls; it guarantees a stall is seen within a bounded game time, something different is done, and it is recorded.
 * Pure apart from the clock values given to it.
 */

export const GOVERNED_USES = ["low", "medium", "high", "commercial", "industrial", "office"] as const;
export type GovernedUse = typeof GOVERNED_USES[number];
export const isHomes = (use: GovernedUse): boolean => use === "low" || use === "medium" || use === "high";

/** A use is open only while the game's building demand for it averages at least this (0–100) over DEMAND_SMOOTH_HOURS / the last DEMAND_SMOOTH_SAMPLES readings. */
export const DEMAND_OPEN_MINIMUM = 10;
export const DEMAND_SMOOTH_HOURS = 1;
export const DEMAND_SMOOTH_SAMPLES = 4;
/** Homes' demand is averaged over this long (game hours): see `#smoothedDemand`. */
export const HOMES_DEMAND_HOURS = 6;
/** A use whose own empty zoning has not filled for this long (game hours) is closed for new supply. */
export const STUCK_HOURS = 6;
/** Empty cells below this are no stock to judge (a few lots waiting are normal). */
export const STUCK_MINIMUM_EMPTY = 300;
/** Built cells the use must gain in STUCK_HOURS, as a share of its empty cells, to count as filling (at least STUCK_MINIMUM_FILL cells). */
export const STUCK_FILL_SHARE = 0.03;
export const STUCK_MINIMUM_FILL = 20;
/** The city-level progress window (game hours) and what counts as a rise or a fall in it. */
export const PROGRESS_WINDOW_HOURS = 8;
export const PROGRESS_POPULATION = 10;
export const PROGRESS_BUILT_CELLS = 20;
export const PROGRESS_ICONS = 3;
/** A supply action is judged this long after it (game hours); its cells must have begun to fill: this share of them, at least JUDGE_MINIMUM_FILL cells. */
export const JUDGE_HOURS = 6;
export const JUDGE_FILL_SHARE = 0.05;
export const JUDGE_MINIMUM_FILL = 10;
/** A family is suspended once at least MINIMUM_JUDGED of its actions were judged and fewer than SCORE_FLOOR of them were effective. */
export const MINIMUM_JUDGED = 3;
export const SCORE_FLOOR = 0.25;
/** A suspension lasts this long (game hours), doubling on each repeat, at most SUSPEND_MAXIMUM_HOURS. */
export const SUSPEND_BASE_HOURS = 6;
export const SUSPEND_MAXIMUM_HOURS = 48;
/** With no readable game clock, one game hour is counted as this many cycles. */
export const CYCLES_PER_HOUR = 2;
/** Samples kept (a sample a cycle; the oldest are dropped). */
export const MAXIMUM_SAMPLES = 600;

export interface GovernorSample {
  stamp: GameStamp;
  population: number | null;
  monthlyBalance: number | null;
  /** Problem icons over the city (level-up notices excluded), null when unread. */
  problemIcons: number | null;
  /** Zoned and built (occupied) cells, and the game's building demand (0–100, null unread), per use. */
  zoned: Partial<Record<GovernedUse, number>>;
  built: Partial<Record<GovernedUse, number>>;
  demand: Partial<Record<GovernedUse, number | null>>;
}

export interface UseVerdict { open: boolean; reason: string; empty: number; filledInWindow: number | null; /** The averaged building demand the verdict was made on. */ demand?: number | null }
export interface Suspension { family: string; sinceFrame: number | null; sinceCycle: number; hours: number; why: string }
export interface GovernorVerdict {
  uses: Record<GovernedUse, UseVerdict>;
  /** The city made no progress in the window. BUSY: it acted to no effect; IDLE: it did nothing. */
  stall: null | { kind: "BUSY" | "IDLE"; hours: number; detail: string };
  /** One supply action may go past the builder's own waits this cycle (an IDLE stall). */
  forceOne: boolean;
  suspended: Suspension[];
  /** One line for the decision log. */
  summary: string;
}

/** What is kept across sessions: per action family, how many actions were judged and how many were effective. */
export interface GovernorMemory { scores: Record<string, { judged: number; effective: number }> }
export const emptyGovernorMemory = (): GovernorMemory => ({ scores: {} });

/** The family name of a supply action: "LAY:low", "ZONE:commercial", ... */
export const supplyFamily = (kind: "LAY" | "ZONE", use: GovernedUse): string => `${kind}:${use}`;

const hoursOrCycles = (since: GameStamp, now: GameStamp): number => stampHoursBetween(since, now) ?? (now.cycle - since.cycle) / CYCLES_PER_HOUR;
const elapsed = (since: GameStamp, now: GameStamp, hours: number) => stampElapsed(since, now, hours, Math.ceil(hours * CYCLES_PER_HOUR));
const sum = (values: Partial<Record<GovernedUse, number>>) => GOVERNED_USES.reduce((total, use) => total + (values[use] ?? 0), 0);

export class GrowthGovernor {
  readonly #samples: GovernorSample[] = [];
  readonly #actions: Array<{ family: string; use: GovernedUse; cells: number; stamp: GameStamp; builtBefore: number }> = [];
  readonly #pending: Array<{ family: string; use: GovernedUse; cells: number; stamp: GameStamp; builtBefore: number }> = [];
  readonly #suspended = new Map<string, Suspension>();
  readonly #repeats = new Map<string, number>();
  #lastStallAt: GameStamp | null = null;
  #forcedAt: GameStamp | null = null;
  readonly memory: GovernorMemory;

  constructor(memory: GovernorMemory | null = null) { this.memory = memory ?? emptyGovernorMemory(); }

  /** Forget the world (another save loaded): the samples, pending judgements and suspensions; the learned scores stay. */
  rebaseline(): void {
    this.#samples.length = 0; this.#actions.length = 0; this.#pending.length = 0; this.#suspended.clear(); this.#repeats.clear();
    this.#lastStallAt = null; this.#forcedAt = null;
  }

  /** A supply action the builder took: `cells` it added for `use`. Judged after JUDGE_HOURS against the use's built cells. */
  noteAction(kind: "LAY" | "ZONE", use: GovernedUse, cells: number, stamp: GameStamp): void {
    if (!(cells > 0)) return;
    const builtBefore = this.#samples.at(-1)?.built[use] ?? 0;
    const entry = { family: supplyFamily(kind, use), use, cells, stamp, builtBefore };
    this.#actions.push(entry);
    this.#pending.push(entry);
    if (this.#actions.length > 2_000) this.#actions.splice(0, this.#actions.length - 2_000);
  }

  isSuspended(family: string, now: GameStamp): boolean {
    const entry = this.#suspended.get(family);
    if (!entry) return false;
    if (elapsed({ frame: entry.sinceFrame, cycle: entry.sinceCycle }, now, entry.hours)) { this.#suspended.delete(family); return false; }
    return true;
  }

  /** The forced action of an IDLE stall was taken: no other is forced until the window has passed again. */
  forced(now: GameStamp): void { this.#forcedAt = now; }

  /** Take this cycle's reading and say what may be done. */
  observe(sample: GovernorSample): GovernorVerdict {
    this.#samples.push(sample);
    if (this.#samples.length > MAXIMUM_SAMPLES) this.#samples.splice(0, this.#samples.length - MAXIMUM_SAMPLES);
    const now = sample.stamp;
    this.#judge(sample);
    const uses = Object.fromEntries(GOVERNED_USES.map((use) => [use, this.#useVerdict(use, sample)])) as Record<GovernedUse, UseVerdict>;
    const stall = this.#stall(sample);
    let forceOne = false;
    if (stall && (!this.#lastStallAt || elapsed(this.#lastStallAt, now, PROGRESS_WINDOW_HOURS))) {
      this.#lastStallAt = now;
      if (stall.kind === "BUSY") {
        const family = this.#busiestFamily(now);
        if (family) this.#suspend(family, now, `the city made no progress for ${stall.hours.toFixed(1)} game hours while it was done most`);
      }
    }
    if (stall?.kind === "IDLE" && (!this.#forcedAt || elapsed(this.#forcedAt, now, PROGRESS_WINDOW_HOURS))) forceOne = true;
    for (const family of [...this.#suspended.keys()]) this.isSuspended(family, now);
    const suspended = [...this.#suspended.values()];
    // The objective (the player's, 2026-10-08: the most income and the most people, the icons tended, never stuck): its rates over the last game hours.
    const rate = this.#rates(sample);
    const summary = `governor: ${rate ? `people ${rate.people >= 0 ? "+" : ""}${Math.round(rate.people)}/h, monthly balance ${rate.balance >= 0 ? "+" : ""}${Math.round(rate.balance)}/h over ${rate.hours.toFixed(1)} h | ` : ""}${GOVERNED_USES.filter((use) => (sample.zoned[use] ?? 0) > 0 || (sample.demand[use] ?? 0) > 0)
      .map((use) => `${use} ${uses[use].open ? "open" : "closed"} (${uses[use].reason})`).join("; ")}` +
      `${stall ? ` | STALL ${stall.kind}: ${stall.detail}` : " | progressing"}${forceOne ? " | one supply action forced past the waits" : ""}` +
      `${suspended.length > 0 ? ` | suspended: ${suspended.map((entry) => `${entry.family} for ${entry.hours} h (${entry.why})`).join("; ")}` : ""}`;
    return { uses, stall, forceOne, suspended, summary };
  }

  /** The use's gain in built cells since the first sample at least `hours` old, and over how long; null when the history is not that long yet. */
  #gainOver(use: GovernedUse, hours: number, now: GovernorSample): { gain: number; hours: number } | null {
    for (let index = this.#samples.length - 1; index >= 0; index -= 1) {
      const old = this.#samples[index]!;
      if (elapsed(old.stamp, now.stamp, hours)) return { gain: (now.built[use] ?? 0) - (old.built[use] ?? 0), hours: hoursOrCycles(old.stamp, now.stamp) };
    }
    return null;
  }

  /**
   * The use's building demand averaged over the last DEMAND_SMOOTH_HOURS (at least the last DEMAND_SMOOTH_SAMPLES readings): the game's figure jumps cycle to
   * cycle (live 2026-10-08: 0 → 29 → 100 → 0 in four cycles), and a decision on one reading opened and closed the use every cycle — a tile was bought in one of
   * the open moments. Null when no reading has the figure.
   */
  #smoothedDemand(use: GovernedUse, now: GovernorSample): number | null {
    const values: number[] = [];
    // Homes over the longer window: their demand is 0 every time new houses stand empty and 100 again as people move in (live 2026-10-08: 0 and 100 in turn,
    // runs of 0 for half an hour), so an hour's average closed homes in the very moments the next houses were needed, and the city waited with no stock.
    const hours = isHomes(use) ? HOMES_DEMAND_HOURS : DEMAND_SMOOTH_HOURS;
    for (let index = this.#samples.length - 1; index >= 0; index -= 1) {
      const sample = this.#samples[index]!;
      if (values.length >= DEMAND_SMOOTH_SAMPLES && elapsed(sample.stamp, now.stamp, hours)) break;
      const value = sample.demand[use];
      if (typeof value === "number") values.push(value);
    }
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
  }

  #useVerdict(use: GovernedUse, sample: GovernorSample): UseVerdict {
    const empty = Math.max(0, (sample.zoned[use] ?? 0) - (sample.built[use] ?? 0));
    const demand = this.#smoothedDemand(use, sample);
    const window = this.#gainOver(use, STUCK_HOURS, sample);
    const filledInWindow = window ? window.gain : null;
    if (demand !== null && demand < DEMAND_OPEN_MINIMUM) return { open: false, reason: `the game has no building demand for it (${Math.round(demand)} on average)`, empty, filledInWindow, demand };
    if (empty >= STUCK_MINIMUM_EMPTY && window && window.gain < Math.max(STUCK_MINIMUM_FILL, empty * STUCK_FILL_SHARE)) {
      return { open: false, reason: `${empty} cells stand empty and ${Math.max(0, window.gain)} filled in ${window.hours.toFixed(1)} game hours`, empty, filledInWindow, demand };
    }
    if (this.isSuspended(supplyFamily("ZONE", use), sample.stamp) && this.isSuspended(supplyFamily("LAY", use), sample.stamp)) {
      return { open: false, reason: "its supply is suspended (no effect measured)", empty, filledInWindow, demand };
    }
    return { open: true, reason: `demand ${demand === null ? "?" : Math.round(demand)}, ${empty} empty${filledInWindow !== null ? `, +${filledInWindow} built in ${STUCK_HOURS} h` : ""}`, empty, filledInWindow, demand };
  }

  /** Population and monthly balance gained per game hour since the oldest sample of the progress window (null with too short a history). */
  #rates(sample: GovernorSample): { people: number; balance: number; hours: number } | null {
    const old = this.#samples.find((candidate) => !elapsed(candidate.stamp, sample.stamp, PROGRESS_WINDOW_HOURS) && candidate !== sample);
    if (!old || old.population === null || sample.population === null) return null;
    const hours = hoursOrCycles(old.stamp, sample.stamp);
    if (!(hours >= 0.5)) return null;
    return { people: (sample.population - old.population) / hours, balance: ((sample.monthlyBalance ?? 0) - (old.monthlyBalance ?? 0)) / hours, hours };
  }

  #stall(sample: GovernorSample): GovernorVerdict["stall"] {
    let old: GovernorSample | null = null;
    for (let index = this.#samples.length - 1; index >= 0; index -= 1) {
      if (elapsed(this.#samples[index]!.stamp, sample.stamp, PROGRESS_WINDOW_HOURS)) { old = this.#samples[index]!; break; }
    }
    if (!old) return null;
    const people = sample.population !== null && old.population !== null ? sample.population - old.population : null;
    const built = sum(sample.built) - sum(old.built);
    const balance = sample.monthlyBalance !== null && old.monthlyBalance !== null ? sample.monthlyBalance - old.monthlyBalance : null;
    const icons = sample.problemIcons !== null && old.problemIcons !== null ? old.problemIcons - sample.problemIcons : null;
    const progressed = (people !== null && people >= PROGRESS_POPULATION) || built >= PROGRESS_BUILT_CELLS ||
      (balance !== null && old.monthlyBalance !== null && balance > Math.max(1, Math.abs(old.monthlyBalance) * 0.01)) || (icons !== null && icons >= PROGRESS_ICONS);
    if (progressed) return null;
    const hours = hoursOrCycles(old.stamp, sample.stamp);
    const acted = this.#actions.some((action) => !elapsed(action.stamp, sample.stamp, PROGRESS_WINDOW_HOURS));
    const detail = `in ${hours.toFixed(1)} game hours population ${people ?? "?"}, built cells ${built}, balance ${balance === null ? "?" : Math.round(balance)}, icons ${icons === null ? "?" : -icons}`;
    return { kind: acted ? "BUSY" : "IDLE", hours, detail };
  }

  #busiestFamily(now: GameStamp): string | null {
    const counts = new Map<string, number>();
    for (const action of this.#actions) if (!elapsed(action.stamp, now, PROGRESS_WINDOW_HOURS)) counts.set(action.family, (counts.get(action.family) ?? 0) + action.cells);
    return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }

  #suspend(family: string, now: GameStamp, why: string): void {
    const repeats = this.#repeats.get(family) ?? 0;
    this.#repeats.set(family, repeats + 1);
    const hours = Math.min(SUSPEND_MAXIMUM_HOURS, SUSPEND_BASE_HOURS * 2 ** repeats);
    this.#suspended.set(family, { family, sinceFrame: now.frame, sinceCycle: now.cycle, hours, why });
  }

  /** Judge the supply actions old enough: did the use's built cells grow by a share of what they added? Scores are kept; a poor family is suspended. */
  #judge(sample: GovernorSample): void {
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const action = this.#pending[index]!;
      if (!elapsed(action.stamp, sample.stamp, JUDGE_HOURS)) continue;
      this.#pending.splice(index, 1);
      const gain = (sample.built[action.use] ?? 0) - action.builtBefore;
      const effective = gain >= Math.max(JUDGE_MINIMUM_FILL, action.cells * JUDGE_FILL_SHARE);
      const score = this.memory.scores[action.family] ?? { judged: 0, effective: 0 };
      score.judged += 1;
      if (effective) score.effective += 1;
      // Recent outcomes weigh most: the count is held to the last 20 judgements.
      if (score.judged > 20) { score.effective = Math.round((score.effective / score.judged) * 20); score.judged = 20; }
      this.memory.scores[action.family] = score;
      if (score.judged >= MINIMUM_JUDGED && score.effective / score.judged < SCORE_FLOOR && !this.isSuspended(action.family, sample.stamp)) {
        this.#suspend(action.family, sample.stamp, `${score.effective} of its last ${score.judged} judged actions filled`);
      }
    }
  }
}

/** Where the learned scores live between sessions (one per player, like the experience book). */
export interface GovernorStore { load(): GovernorMemory | null; save(memory: GovernorMemory): void }
export function fileGovernorStore(file: string): GovernorStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GovernorMemory>;
        return parsed && typeof parsed.scores === "object" && parsed.scores ? { scores: parsed.scores } : null;
      } catch { return null; }
    },
    save(memory) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(memory), "utf8"); } catch { /* bookkeeping only */ } },
  };
}

/** A game stamp a test or a caller can build from a frame and a cycle. */
export const governorStamp = (frame: number | null, cycle: number): GameStamp => ({ frame, cycle });
export const HOUR = GAME_HOUR_FRAMES;
