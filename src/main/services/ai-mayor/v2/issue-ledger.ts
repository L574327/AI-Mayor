/**
 * The issue desk's memory: how long each problem icon has been standing (the world is the authority — an icon that is gone is gone; nothing here is
 * remembered across a restart). An icon is identified by its type, the building it hangs on and a 24 m cell, so a citizen who walks on is the same
 * icon only while they stand still, and a building's notice is the same notice for as long as it stands.
 *
 * What it is for: the repairs (`provideServices`, the access roads, the ruins) each judge ONE cycle; an icon that survives them for hours is the
 * evidence that the answer is wrong or not enough, and the desk says so (`describeStanding`) so the escalation and the player's eyes read one number.
 */
import { stampElapsed, type GameStamp } from "./game-clock";

export interface LedgerIcon { type: string; x: number; z: number; prefab?: string }
export interface StandingIcon { key: string; type: string; prefab: string | null; x: number; z: number; since: GameStamp }

export const ISSUE_CELL_METERS = 24;
/** Types that are not problems the desk answers by itself: a level-up is progress, a bottleneck needs a traffic reading. Never reported as stuck. */
const NOT_STUCK_REPORTED = /Leveling|Level Up|Sad Face|Traffic Bottleneck|Building Level/i;

export function issueKey(icon: LedgerIcon): string {
  return `${icon.type}|${icon.prefab ?? ""}|${Math.round(icon.x / ISSUE_CELL_METERS)},${Math.round(icon.z / ISSUE_CELL_METERS)}`;
}

export class IssueLedger {
  readonly #since = new Map<string, StandingIcon>();

  /** Read the icons now: new ones start their clock, gone ones are forgotten. Returns every icon standing. */
  observe(icons: readonly LedgerIcon[], now: GameStamp): StandingIcon[] {
    const live = new Set<string>();
    for (const icon of icons) {
      const key = issueKey(icon);
      live.add(key);
      if (!this.#since.has(key)) this.#since.set(key, { key, type: icon.type, prefab: icon.prefab ?? null, x: icon.x, z: icon.z, since: now });
    }
    for (const key of [...this.#since.keys()]) if (!live.has(key)) this.#since.delete(key);
    return [...this.#since.values()];
  }

  /** Icons standing for at least `hours` game hours (or `cycles` cycles without a clock), oldest first. */
  stuck(now: GameStamp, hours: number, cycles: number): StandingIcon[] {
    return [...this.#since.values()].filter((icon) => !NOT_STUCK_REPORTED.test(icon.type) && stampElapsed(icon.since, now, hours, cycles))
      .sort((left, right) => (left.since.frame ?? Infinity) - (right.since.frame ?? Infinity) || left.since.cycle - right.since.cycle);
  }

  clear(): void { this.#since.clear(); }
  get size(): number { return this.#since.size; }
}

/** One line for the cycle's notes: the stuck types, the most numerous first, each with its count and the place of the oldest. */
export function describeStanding(stuck: readonly StandingIcon[]): string | null {
  if (stuck.length === 0) return null;
  const byType = new Map<string, StandingIcon[]>();
  for (const icon of stuck) byType.set(icon.type, [...(byType.get(icon.type) ?? []), icon]);
  const parts = [...byType].sort((left, right) => right[1].length - left[1].length).slice(0, 5)
    .map(([type, icons]) => `${type} x${icons.length} (oldest at ${icons[0]!.x.toFixed(0)},${icons[0]!.z.toFixed(0)}${icons[0]!.prefab ? ` on ${icons[0]!.prefab}` : ""})`);
  return `issue desk: standing past the limit: ${parts.join("; ")}`;
}
