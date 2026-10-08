/**
 * One budget for the whole assist round of a cycle (the icon repairs: access roads, ruins, services): wall time, placement checks (a preflight shows a
 * ghost in the game and holds the tool, so it counts like a write) and writes. It never cancels anything by racing a timer — a `Promise.race` leaves the
 * slow call running and writing. Instead every step asks `exhausted()` BEFORE it starts the next query, check or write (and once more right before a write
 * is committed), so an exhausted budget simply starts nothing new; calls already in flight carry the run's own abort signal.
 *
 * It also keeps the stage clock: what each step spent, so a long cycle can be read as "access 1.2 s, ruins 0.3 s, service 9.8 s (14 checks, 1 write)".
 */
export interface AssistBudgetLimits { milliseconds: number; checks: number; writes: number }

/** Starting figures, to be tuned from the stage clock the notes now carry (measured live: the assist round took 0.0-0.6 s on a quiet cycle, 2.4 s with six ruins; the six ruin removals alone used a limit of 6 writes and starved the services). */
export const ASSIST_BUDGET: AssistBudgetLimits = { milliseconds: 12_000, checks: 40, writes: 14 };

interface Stage { name: string; milliseconds: number; checks: number; writes: number; skipped: boolean }

export class AssistBudget {
  readonly #startedAt: number;
  #checks = 0;
  #writes = 0;
  #current: { name: string; startedAt: number; checks: number; writes: number } | null = null;
  readonly #stages: Stage[] = [];

  constructor(private readonly limits: AssistBudgetLimits = ASSIST_BUDGET, private readonly now: () => number = Date.now) {
    this.#startedAt = this.now();
  }

  get spentMilliseconds(): number { return this.now() - this.#startedAt; }
  /** True once any limit is reached: start nothing new. */
  exhausted(): boolean { return this.spentMilliseconds >= this.limits.milliseconds || this.#checks >= this.limits.checks || this.#writes >= this.limits.writes; }
  noteCheck(): void { this.#checks += 1; if (this.#current) this.#current.checks += 1; }
  noteWrite(): void { this.#writes += 1; if (this.#current) this.#current.writes += 1; }
  get writes(): number { return this.#writes; }
  get checks(): number { return this.#checks; }

  /** Run one named step; it is not started at all when the budget is already spent. */
  async stage<T>(name: string, step: () => Promise<T>): Promise<T | undefined> {
    if (this.exhausted()) { this.#stages.push({ name, milliseconds: 0, checks: 0, writes: 0, skipped: true }); return undefined; }
    this.#current = { name, startedAt: this.now(), checks: 0, writes: 0 };
    try {
      return await step();
    } finally {
      const done = this.#current;
      this.#current = null;
      this.#stages.push({ name, milliseconds: this.now() - done.startedAt, checks: done.checks, writes: done.writes, skipped: false });
    }
  }

  /** One line for the cycle's notes. */
  describe(): string {
    const parts = this.#stages.map((stage) => stage.skipped ? `${stage.name} skipped (budget spent)`
      : `${stage.name} ${(stage.milliseconds / 1000).toFixed(1)} s${stage.checks + stage.writes > 0 ? ` (${stage.checks} checks, ${stage.writes} writes)` : ""}`);
    return `assist round ${(this.spentMilliseconds / 1000).toFixed(1)} s of ${(this.limits.milliseconds / 1000).toFixed(0)} s: ${parts.join(", ") || "nothing to do"}${this.exhausted() ? " — budget spent, the rest waits for the next cycle" : ""}`;
  }
}
