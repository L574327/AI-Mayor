/**
 * STALL SUPERVISION — the decision logic of the process that watches the Mayor's run (scripts/ai-mayor-supervisor.ts).
 *
 * Live 2026-10-05: the run process stayed alive for 13 minutes without doing anything, because the Bridge's build operation sat in its `Finish`
 * stage (the game's active tool had been switched away mid-operation) and every wait in the run was queued behind it. Nothing noticed: no timeout
 * covered the whole wait, the run wrote its log only after a cycle ended, and no one watched from outside. This module is the "is it stuck, and
 * what is the one thing to do about it" part, pure and in memory (no files, no history: the only state is the time of the last real progress).
 *
 * What counts as progress: a tool call that completed with a real answer (done or refused by the game; NOT a busy answer, NOT a poll), a cycle
 * that ended, or the game's frame moving. Retrying a busy Bridge, polling the state or printing again does NOT renew the clock — a process that is
 * alive and retrying the same wait is exactly the stuck one.
 */

/** Tool calls that only look at the world while waiting; they never count as progress. */
export const POLL_TOOLS: ReadonlySet<string> = new Set(["cs2_game_state", "cs2_read_blocking_modal", "cs2_native_tool_observe", "cs2_ping", "cs2_city_overview"]);
/** A Bridge answer that only says "try again": not progress. */
export const BUSY_ANSWER = /in progress|busy|retry shortly|BRIDGE_BUSY/i;

/** No progress for this long is a stall (the Bridge's own orphan clear runs inside it, from the first state read). */
export const STALL_AFTER_MS = 12_000;
/** The Bridge still reports busy this long after the stall began: it did not clear itself; the run is restarted. */
export const BUSY_RESTART_AFTER_MS = 20_000;
/** Paused and idle with no progress: reported at once, restarted only if the owner allows it (a player's pause is not ours to lift). */
export const PAUSED_IDLE_RESTART_AFTER_MS = 180_000;
/** More restarts than this inside the window stop automatic restarting: a loop of restarts is worse than a stopped run. */
export const MAXIMUM_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface WorldProbe {
  /** The Bridge answered. */
  reachable: boolean;
  paused: boolean | null;
  frame: number | null;
  busy: boolean | null;
  stage: string | null;
  /** The game says the city is loaded and ready. */
  ready: boolean | null;
}

export interface ProgressSignal {
  /** A completed tool call (the run reports each one). */
  call?: { name: string; ok: boolean; answer?: string };
  /** A cycle ended. */
  cycle?: boolean;
}

export type StallState = "PROGRESSING" | "WATCHING" | "PAUSED_IDLE" | "STALLED_BUSY" | "STALLED_RUNNING" | "BRIDGE_UNREACHABLE" | "CHILD_EXITED" | "GAVE_UP";

export interface StallDecision {
  state: StallState;
  /** What to do now: nothing, restart the run process, or only report. */
  action: "NONE" | "RESTART" | "REPORT";
  /** A short reason, in the words an operator (and the language layer) can use. */
  reason: string;
  stalledForMs: number;
}

/** Does this signal renew the progress clock? */
export function isProgress(signal: ProgressSignal): boolean {
  if (signal.cycle) return true;
  const call = signal.call;
  if (!call || POLL_TOOLS.has(call.name)) return false;
  if (!call.ok && call.answer !== undefined && BUSY_ANSWER.test(call.answer)) return false;
  return true;
}

export class StallWatch {
  #lastProgressAt: number;
  #lastFrame: number | null = null;
  readonly #restarts: number[] = [];
  #gaveUp = false;

  constructor(now: number) { this.#lastProgressAt = now; }

  /** The run process (re)started: the clock starts over. */
  started(now: number): void { this.#lastProgressAt = now; this.#lastFrame = null; }

  note(signal: ProgressSignal, now: number): void { if (isProgress(signal)) this.#lastProgressAt = now; }

  restarted(now: number): void {
    this.#restarts.push(now);
    while (this.#restarts.length > 0 && now - this.#restarts[0]! > RESTART_WINDOW_MS) this.#restarts.shift();
  }

  get restartsInWindow(): number { return this.#restarts.length; }

  /**
   * One look at the world and the clock. The frame moving renews the clock here (a window the game runs is progress); a paused or unmoving world
   * does not.
   */
  decide(now: number, probe: WorldProbe, options: { childAlive: boolean; restartOnPausedIdle?: boolean }): StallDecision {
    if (this.#gaveUp) return { state: "GAVE_UP", action: "NONE", reason: "automatic restarts stopped: too many in a short time", stalledForMs: now - this.#lastProgressAt };
    if (probe.reachable && probe.frame !== null) {
      if (this.#lastFrame !== null && probe.frame !== this.#lastFrame) this.#lastProgressAt = now;
      this.#lastFrame = probe.frame;
    }
    const stalledForMs = now - this.#lastProgressAt;
    if (!options.childAlive) return this.#restartOrGiveUp(now, "CHILD_EXITED", "the run process is gone", stalledForMs);
    if (stalledForMs < STALL_AFTER_MS) return { state: "PROGRESSING", action: "NONE", reason: "progress within the last " + Math.round(STALL_AFTER_MS / 1000) + " s", stalledForMs };
    if (!probe.reachable) return { state: "BRIDGE_UNREACHABLE", action: "REPORT", reason: "the game's Bridge does not answer: restarting the run cannot help", stalledForMs };
    if (probe.busy === true) {
      if (stalledForMs < BUSY_RESTART_AFTER_MS) return { state: "WATCHING", action: "NONE", reason: `the Bridge reports a build operation in stage ${probe.stage ?? "?"}; it clears orphaned ones by itself`, stalledForMs };
      return this.#restartOrGiveUp(now, "STALLED_BUSY", `the Bridge still reports a build operation in stage ${probe.stage ?? "?"} and nothing has moved for ${Math.round(stalledForMs / 1000)} s`, stalledForMs);
    }
    if (probe.paused === true) {
      if (options.restartOnPausedIdle === true && stalledForMs >= PAUSED_IDLE_RESTART_AFTER_MS) return this.#restartOrGiveUp(now, "PAUSED_IDLE", "the world has stood paused and idle with no progress", stalledForMs);
      return { state: "PAUSED_IDLE", action: "REPORT", reason: "the world is paused and idle and the run made no progress (a player's pause is not lifted)", stalledForMs };
    }
    return this.#restartOrGiveUp(now, "STALLED_RUNNING", `the world runs but the run made no progress for ${Math.round(stalledForMs / 1000)} s`, stalledForMs);
  }

  #restartOrGiveUp(now: number, state: StallState, reason: string, stalledForMs: number): StallDecision {
    const recent = this.#restarts.filter((at) => now - at <= RESTART_WINDOW_MS).length;
    if (recent >= MAXIMUM_RESTARTS) {
      this.#gaveUp = true;
      return { state: "GAVE_UP", action: "REPORT", reason: `${reason}; ${recent} restarts in ${Math.round(RESTART_WINDOW_MS / 60000)} min already: automatic restarting stops`, stalledForMs };
    }
    return { state, action: "RESTART", reason, stalledForMs };
  }
}

/** May a new run process start? The city is ready and the Bridge takes new operations; a running world is taken over as it is (the run's start gate asks the same). */
export function mayStartRun(probe: WorldProbe): { ok: boolean; reason: string } {
  if (!probe.reachable) return { ok: false, reason: "the Bridge does not answer" };
  if (probe.ready !== true) return { ok: false, reason: "the world is not ready" };
  if (probe.busy !== false) return { ok: false, reason: `the Bridge is busy (stage ${probe.stage ?? "?"})` };
  return { ok: true, reason: "ready" };
}
