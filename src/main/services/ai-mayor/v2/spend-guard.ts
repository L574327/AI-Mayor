import { GAME_HOUR_FRAMES } from "./game-clock";

/**
 * THE SPENDING FUSE — one rule over every call that costs the city money, whatever the category (roads, buildings, land, upgrades, transit).
 *
 * Why it exists: on 2026-10-06 one placement routine bought seven tiles in three minutes and took the treasury from 744k to 55k. Each routine had its
 * own politeness rule; none of them saw the others. This sits at the one place every write passes (the engine's tool call) and knows only money.
 *
 * It protects a CUSHION, so it applies only where there is one, and is never a dead rule (player, 2026-10-06: a bankrupt save must not be frozen by it):
 *
 *   FLOOR   a call that could leave the treasury under `floorFraction` of the funds the Mayor took the city over with is refused. The call's price is
 *           not known beforehand, so a `marginFraction` of that reference is kept in hand: below floor + margin nothing spends.
 *   HOURLY  the money spent in one game hour is capped at `hourlyFraction` of the same reference; once the cap is reached nothing more is spent until
 *           the next game hour. A call's price is what the treasury lost across it (read before and after).
 *
 *   STANDS DOWN (the fuse still counts, but refuses nothing) when
 *     - the player turned it off (`mode: "OFF"`), or
 *     - the city was poor when it was taken over (funds under one month of its expenses, or negative): there is no cushion to protect and the city
 *       has to be able to act to climb out, or
 *     - the treasury is under the floor AND the city is bleeding (monthly balance negative): waiting for income to rebuild the cushion would never end.
 *   A city under the floor whose balance is positive refuses: it refills by itself (measured live: +16k per game hour), and that is when a runaway
 *   routine does its harm.
 *
 * A refused call throws `SPEND_GUARD_REFUSED:<why>`: callers already treat a failed write as "the game said no" and move on. Reads, previews and
 * preflights spend nothing and never pass through here.
 */
export interface Funds {
  money: number;
  frame: number | null;
  /** Income minus expenses per game month, when the budget could be read. */
  monthlyBalance?: number | null;
  /** Expenses per game month (a positive figure), when the budget could be read. */
  monthlyExpenses?: number | null;
}

export interface SpendGuardConfig {
  /** "ADAPTIVE": the rules above. "OFF": the player turned the fuse off (calls are still counted). */
  mode: "ADAPTIVE" | "OFF";
  /** Share of the reference funds that is never spent (0.3 = the treasury does not fall below 30% of what it was at takeover). */
  floorFraction: number;
  /** Share of the reference funds that may be spent in one game hour, all categories together. */
  hourlyFraction: number;
  /** Share of the reference kept above the floor for the price of the call itself, which is not known beforehand. */
  marginFraction: number;
}

/**
 * The floor was 30% of the takeover funds until 2026-10-08: on a new 1,000,000 city it kept 330,000 idle for good, and a two-hour run spent its second half
 * mostly waiting at it while every district it laid filled (the player: "too conservative early; loans are fine"). The runaway it was made against is
 * held by the hourly cap; the floor only keeps a cushion.
 */
export const DEFAULT_SPEND_GUARD: SpendGuardConfig = { mode: "ADAPTIVE", floorFraction: 0.1, hourlyFraction: 0.15, marginFraction: 0.02 };

/** The tools that spend the city's money. */
export const SPENDING_TOOLS: ReadonlySet<string> = new Set([
  "cs2_build_road", "cs2_place_building", "cs2_purchase_tile", "cs2_replace_road", "cs2_upgrade_road", "cs2_transit_line_create", "cs2_transit_stop_place", "cs2_mayor_execute_actions",
]);

/** Whether this call can spend: a spending tool that is not a preview or a dry run. */
export function spends(tool: string, args: Record<string, unknown>): boolean {
  if (!SPENDING_TOOLS.has(tool)) return false;
  return !(args.previewOnly === true || args.preview === true || args.dryRun === true);
}

/** The player's settings (a JSON object, or null) over the defaults; a value out of range is ignored, never trusted. */
export function spendGuardConfigFrom(settings: Record<string, unknown> | null, env: Record<string, string | undefined> = {}): SpendGuardConfig {
  const fraction = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback);
  const fromEnv = (key: string): number | undefined => { const value = Number(env[key]); return env[key] !== undefined && Number.isFinite(value) ? value : undefined; };
  const modeValue = settings?.mode ?? env.AI_MAYOR_SPEND_GUARD;
  return {
    mode: String(modeValue ?? "").toUpperCase() === "OFF" ? "OFF" : "ADAPTIVE",
    floorFraction: fraction(settings?.floorFraction ?? fromEnv("AI_MAYOR_SPEND_FLOOR_FRACTION"), DEFAULT_SPEND_GUARD.floorFraction),
    hourlyFraction: fraction(settings?.hourlyFraction ?? fromEnv("AI_MAYOR_SPEND_HOURLY_FRACTION"), DEFAULT_SPEND_GUARD.hourlyFraction),
    marginFraction: fraction(settings?.marginFraction ?? fromEnv("AI_MAYOR_SPEND_MARGIN_FRACTION"), DEFAULT_SPEND_GUARD.marginFraction),
  };
}

/** Whether a city is poor at takeover: no funds, or under one month of its own expenses. Relative to the city, never a fixed sum. */
export function poorAtTakeover(funds: Pick<Funds, "money" | "monthlyExpenses">): boolean {
  if (funds.money <= 0) return true;
  const expenses = funds.monthlyExpenses;
  return typeof expenses === "number" && expenses > 0 && funds.money < expenses;
}

/**
 * What the fuse lets the planners see (set by the engine once the fuse is armed): the treasury below which it refuses (its floor plus the margin), and the
 * spend it allows per game hour. A planner that sizes its work by the cash alone builds into the fuse: the batch is cut off half-way, the refused street's
 * preview flickers every cycle, and the repairs that follow are refused too (live 2026-10-08).
 */
export const SPEND_FLOOR_ENV = "AI_MAYOR_SPEND_FLOOR";
export const SPEND_HOURLY_CAP_ENV = "AI_MAYOR_SPEND_HOURLY_CAP";

/** The treasury below which the fuse refuses now; null when there is no fuse, or it stands down (it would refuse nothing). */
export function plannerSpendFloor(funds: { treasury: number; monthlyBalance: number } | null | undefined, env: Record<string, string | undefined> = process.env): number | null {
  const floor = Number(env[SPEND_FLOOR_ENV]);
  if (!env[SPEND_FLOOR_ENV] || !Number.isFinite(floor) || floor <= 0) return null;
  // The same stand-down as the fuse: under the floor while the city loses money every month, it refuses nothing.
  if (funds && funds.treasury < floor && funds.monthlyBalance < 0) return null;
  return floor;
}

/** The fuse's spend allowed per game hour, null when there is none. */
export function plannerHourlyCap(env: Record<string, string | undefined> = process.env): number | null {
  const cap = Number(env[SPEND_HOURLY_CAP_ENV]);
  return env[SPEND_HOURLY_CAP_ENV] && Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** A write the fuse refused (the detail the ports pass on). */
export const isSpendRefusal = (detail: string | null | undefined): boolean => typeof detail === "string" && detail.includes("SPEND_GUARD_REFUSED");

export class SpendGuardRefusal extends Error {
  constructor(readonly why: string) { super(`SPEND_GUARD_REFUSED:${why}`); this.name = "SpendGuardRefusal"; }
}

export class SpendGuard {
  #window: { key: number; spent: number } = { key: Number.NaN, spent: 0 };
  #refusals = 0;
  #standDowns = 0;

  /**
   * `reference`: the funds the Mayor took the city over with; `poor`: the city was poor then (see `poorAtTakeover`). `readFunds`: the treasury, the game
   * frame and the monthly budget now, or null when the treasury cannot be read — a fuse that cannot see the money refuses, it does not guess (unless it
   * stands down anyway).
   */
  constructor(readonly reference: number, readonly poor: boolean, private readonly readFunds: () => Promise<Funds | null>, readonly config: SpendGuardConfig = DEFAULT_SPEND_GUARD) {}

  get floor(): number { return Math.max(0, this.reference) * this.config.floorFraction; }
  get hourlyCap(): number { return Math.max(0, this.reference) * this.config.hourlyFraction; }
  get margin(): number { return Math.max(0, this.reference) * this.config.marginFraction; }
  get refusals(): number { return this.#refusals; }
  get standDowns(): number { return this.#standDowns; }
  /** Money spent so far in the game hour the last call fell in. */
  get spentThisHour(): number { return this.#window.spent; }

  #hourKey(frame: number | null): number {
    // Without a game clock a minute of wall time stands in for the game hour (a game hour at 4x is about 40 s): never wider than the real one.
    return frame !== null ? Math.floor(frame / GAME_HOUR_FRAMES) : Math.floor(Date.now() / 60_000);
  }

  #refuse(why: string): never { this.#refusals += 1; throw new SpendGuardRefusal(why); }

  /** Why the fuse does not refuse right now, or null when it applies. */
  standsDownBecause(funds: Funds | null): string | null {
    if (this.config.mode === "OFF") return "the player turned the fuse off";
    if (this.poor) return "the city was poor when it was taken over: no cushion to protect, it must be free to act";
    if (funds && funds.money - this.margin < this.floor && typeof funds.monthlyBalance === "number" && funds.monthlyBalance < 0) {
      return "the treasury is under the floor and the city is losing money every month: waiting for income would never end";
    }
    return null;
  }

  /** Run `execute` only if the money rules allow it; the price is learned from the treasury across the call. */
  async run<T>(tool: string, execute: () => Promise<T>): Promise<T> {
    const before = await this.readFunds();
    const standDown = this.standsDownBecause(before);
    if (standDown) this.#standDowns += 1;
    else {
      if (!before) this.#refuse(`${tool}: the treasury could not be read`);
      if (before.money - this.margin < this.floor) {
        this.#refuse(`${tool}: treasury ${Math.round(before.money)} is within the margin of the floor ${Math.round(this.floor)} (${Math.round(this.config.floorFraction * 100)}% of the ${Math.round(this.reference)} taken over with); the city is earning, so it refills`);
      }
      const key = this.#hourKey(before.frame);
      if (key !== this.#window.key) this.#window = { key, spent: 0 };
      if (this.#window.spent >= this.hourlyCap) {
        this.#refuse(`${tool}: ${Math.round(this.#window.spent)} already spent this game hour, cap ${Math.round(this.hourlyCap)} (${Math.round(this.config.hourlyFraction * 100)}% of the ${Math.round(this.reference)} taken over with)`);
      }
    }
    try {
      return await execute();
    } finally {
      const after = before ? await this.readFunds().catch(() => null) : null;
      if (before && after) {
        const key = this.#hourKey(before.frame);
        if (key !== this.#window.key) this.#window = { key, spent: 0 };
        // The call may have crossed into the next game hour: its price counts where it began.
        this.#window.spent += Math.max(0, before.money - after.money);
      }
    }
  }
}
