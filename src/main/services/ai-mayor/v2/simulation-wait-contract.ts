/**
 * One wall-clock contract for a bounded `cs2_run_simulation` call.
 *
 * The runtime's stage watchdog and the adapter's own poll loop both bound the
 * same simulation run, and they used to derive their budgets independently: the
 * adapter floored itself at five minutes while the stage watchdog could
 * authorize only 150 s for a one-hour run. The watchdog then cancelled work the
 * adapter still considered in flight, and a tick that should have ended on an
 * authoritative readback ended on
 * `CS2 simulation did not auto-pause before timeout` instead — 5 of 6 runs in
 * the 2026-09-30 live evidence.
 *
 * Two budgets, both bounded, both derived from the same estimate:
 *
 * - `simulationNoProgressBudgetMs` — how long a run may advance neither the
 *   frame index nor the game clock before it is a stall. This is the timeout
 *   that means something. A city that is still running is not stuck, however
 *   slow it is, so wall-clock alone must never be what ends a progressing run.
 * - `simulationAbsoluteBudgetMs` — the hard ceiling for the whole run. A run
 *   that is still progressing may spend this much and no more, so a Bridge that
 *   reports a target frame it never reaches cannot hold a tick open forever.
 *
 * The stage watchdog is the OUTER bound and is always strictly larger than the
 * absolute budget, so the adapter's own bounded result — not a cancellation of
 * it — is what a tick normally sees.
 */

const MINUTE_MS = 60_000;

/** Shortest a run may stand still before it is a stall, at any city size. */
export const SIMULATION_NO_PROGRESS_FLOOR_MS = 5 * MINUTE_MS;

/** No wait may exceed this, progressing or not. */
export const SIMULATION_ABSOLUTE_CEILING_MS = 15 * MINUTE_MS;

/**
 * How far past the adapter's absolute budget the runtime's watchdog sits. The
 * watchdog exists to bound the stage, not to pre-empt the adapter's own
 * bounded result, so it only fires if the adapter somehow fails to return.
 */
export const SIMULATION_STAGE_TIMEOUT_MARGIN_MS = 30_000;

/** The wall clock one run of `hours` at `speed` is expected to take. */
export function estimatedSimulationWallClockMs(hours: number, speed: number): number {
  const safeSpeed = Number.isFinite(speed) ? Math.min(8, Math.max(0.5, speed)) : 4;
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
  return safeHours * 2 * MINUTE_MS * (4 / safeSpeed);
}

/**
 * How long a run may make no frame/clock progress before it is a stall.
 *
 * `overrideMs` is the adapter's explicit `simulationTimeoutMs` option, which is
 * how tests drive the wait to its bounds in milliseconds; it replaces the
 * estimate rather than scaling it so a caller can still bound the loop tightly.
 */
export function simulationNoProgressBudgetMs(hours: number, speed: number, overrideMs?: number): number {
  if (overrideMs !== undefined) return Math.max(1, overrideMs);
  return Math.min(
    SIMULATION_ABSOLUTE_CEILING_MS,
    Math.max(SIMULATION_NO_PROGRESS_FLOOR_MS, estimatedSimulationWallClockMs(hours, speed)),
  );
}

/** The hard ceiling for the whole run, progressing or not. */
export function simulationAbsoluteBudgetMs(hours: number, speed: number, overrideMs?: number): number {
  return Math.min(SIMULATION_ABSOLUTE_CEILING_MS, 2 * simulationNoProgressBudgetMs(hours, speed, overrideMs));
}

/**
 * The runtime stage watchdog's budget for one simulation run.
 *
 * `baseMs` is the operator's configured stage timeout. It can only widen the
 * contract, never narrow it below the adapter's own bound — a configuration
 * smaller than the wait it bounds is what produced the cancelled runs.
 */
export function simulationStageBudgetMs(hours: number, speed: number, baseMs: number): number {
  return Math.max(baseMs, simulationAbsoluteBudgetMs(hours, speed) + SIMULATION_STAGE_TIMEOUT_MARGIN_MS);
}
