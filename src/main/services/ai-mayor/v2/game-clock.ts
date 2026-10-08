import { FRAMES_PER_GAME_DAY } from "./growth-policy";

/** The frames of one game hour: the Bridge's own conversion (`kFramesPerHour = 262144 / 24`). */
export const GAME_HOUR_FRAMES = FRAMES_PER_GAME_DAY / 24;

/**
 * A point in the city's time. `frame` is the simulation frame when the game clock could be read, `cycle` the owner's own cycle counter.
 *
 * Why both: the waits of the district builder, the loan step and the services were written as "N cycles", when a cycle was 25-40 s and about
 * a game hour. A cycle is now 1-25 s (the pauses between districts are gone), so a count of cycles no longer says how much city time passed:
 * a cooldown of 3 cycles became three or four game minutes, and the city was judged before anything could have changed. Time is measured in
 * game hours whenever the clock is readable, and only falls back to cycles when it is not.
 */
export interface GameStamp {
  frame: number | null;
  cycle: number;
}

/**
 * Whether `hours` of game time (or, with no readable clock on either side, `cycles` cycles) have passed since `since`.
 * A stamp whose frame is not readable cannot be compared by time, so the cycle count decides: a wait is never forever and never zero.
 */
export function stampElapsed(since: GameStamp, now: GameStamp, hours: number, cycles: number): boolean {
  if (since.frame !== null && now.frame !== null) return now.frame - since.frame >= hours * GAME_HOUR_FRAMES;
  return now.cycle - since.cycle >= cycles;
}

/** Game hours between two stamps, or null when either clock is unreadable. */
export function stampHoursBetween(since: GameStamp, now: GameStamp): number | null {
  if (since.frame === null || now.frame === null) return null;
  return (now.frame - since.frame) / GAME_HOUR_FRAMES;
}
