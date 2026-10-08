import * as fs from "node:fs";
import * as path from "node:path";

/**
 * THE RECORDER'S MEMORY THAT TUNES CHOICES (docs/补充信息.txt §5): attempts and their effect, summarised as conditional recipes — "for this kind of
 * problem, under this condition, this kind of answer passed / was refused / changed nothing / helped / made it worse" — and used to ORDER the next
 * candidates of the same kind. Never coordinates of one save, so it holds across saves for this player.
 *
 * What it may change: the order candidates are tried in (fewer refused dry runs, fewer repeated writes, the answer that worked tried first). What it may
 * not: it widens no permission, spends nothing, and decides nothing on its own — every candidate is still judged by the game's dry run and the world.
 * Outcomes that say nothing about the answer (the game busy, a popup, a write not yet confirmed) are not recorded at all.
 */
export type ExperienceOutcome = "OK" | "REFUSED" | "NO_EFFECT" | "IMPROVED" | "WORSE";

export interface Tally { tries: number; ok: number; refused: number; noEffect: number; improved: number; worse: number; last: number }

export interface ExperienceStore { load(): Record<string, Tally> | null; save(data: Record<string, Tally>): void }

/** At most this many recipes are kept (the least recently used go first). */
export const EXPERIENCE_MAXIMUM_ENTRIES = 600;
/** An option is moved only on this much evidence: fewer tries leave the built-in order as it is. */
export const EXPERIENCE_MINIMUM_TRIES = 2;

const emptyTally = (): Tally => ({ tries: 0, ok: 0, refused: 0, noEffect: 0, improved: 0, worse: 0, last: 0 });

/** A reason or course label as a family: numbers and coordinates out, so "short:42m" and "short:17m" are one kind of answer. */
export const optionFamily = (label: string): string => label.replace(/-?\d+(\.\d+)?/g, "#").replace(/#(\s*[,x]\s*#)+/g, "#").slice(0, 60);

/** A distance as a coarse condition (the same answer works differently 15 m and 150 m from a street). */
export const distanceBand = (meters: number | null | undefined): string =>
  meters === null || meters === undefined || !Number.isFinite(meters) ? "d?" : meters < 30 ? "d<30" : meters < 80 ? "d<80" : meters < 160 ? "d<160" : "d>=160";

export class ExperienceBook {
  #data: Record<string, Tally>;
  #clock = 0;

  constructor(private readonly store: ExperienceStore | null = null) {
    this.#data = store?.load() ?? {};
    this.#clock = Math.max(0, ...Object.values(this.#data).map((tally) => tally.last));
  }

  /** One judged attempt. */
  record(kind: string, condition: string, option: string, outcome: ExperienceOutcome): void {
    const key = `${kind}|${condition}|${option}`;
    const tally = this.#data[key] ?? emptyTally();
    tally.tries += 1;
    tally.last = ++this.#clock;
    if (outcome === "OK") tally.ok += 1;
    else if (outcome === "REFUSED") tally.refused += 1;
    else if (outcome === "NO_EFFECT") tally.noEffect += 1;
    else if (outcome === "IMPROVED") tally.improved += 1;
    else tally.worse += 1;
    this.#data[key] = tally;
    const keys = Object.keys(this.#data);
    if (keys.length > EXPERIENCE_MAXIMUM_ENTRIES) {
      for (const old of keys.sort((left, right) => this.#data[left]!.last - this.#data[right]!.last).slice(0, keys.length - EXPERIENCE_MAXIMUM_ENTRIES)) delete this.#data[old];
    }
    try { this.store?.save(this.#data); } catch { /* learning never stops the city */ }
  }

  /** The tally of one option under one condition, falling back to the option under any condition. */
  tally(kind: string, condition: string, option: string): Tally | null {
    const exact = this.#data[`${kind}|${condition}|${option}`];
    if (exact && exact.tries >= EXPERIENCE_MINIMUM_TRIES) return exact;
    const any = emptyTally();
    for (const [key, tally] of Object.entries(this.#data)) {
      const [k, , o] = key.split("|");
      if (k !== kind || o !== option) continue;
      any.tries += tally.tries; any.ok += tally.ok; any.refused += tally.refused; any.noEffect += tally.noEffect; any.improved += tally.improved; any.worse += tally.worse;
    }
    return any.tries >= EXPERIENCE_MINIMUM_TRIES ? any : exact ?? null;
  }

  /**
   * How promising an option is: the smoothed share of attempts that passed (OK) or helped (IMPROVED counts double), less those that made things worse.
   * Null when there is not enough evidence: the caller's own order stands.
   */
  score(kind: string, condition: string, option: string): number | null {
    const tally = this.tally(kind, condition, option);
    if (!tally || tally.tries < EXPERIENCE_MINIMUM_TRIES) return null;
    return (tally.ok + 2 * tally.improved - tally.worse + 1) / (tally.tries + tally.improved + 2);
  }

  /**
   * The items in the order to try them: options with evidence by score (best first), interleaved so that an option WITHOUT evidence keeps its built-in
   * place relative to the others (it is not punished for being new). Stable: equal scores keep the caller's order.
   */
  rank<T>(kind: string, condition: string, items: readonly T[], optionOf: (item: T) => string): T[] {
    const scored = items.map((item, index) => ({ item, index, score: this.score(kind, condition, optionOf(item)) }));
    if (scored.every((entry) => entry.score === null)) return [...items];
    // Unknown options are treated as the prior (0.5): a known-good answer goes ahead of them, a known-bad one behind.
    return scored.sort((left, right) => (right.score ?? 0.5) - (left.score ?? 0.5) || left.index - right.index).map((entry) => entry.item);
  }

  /** What has been learnt for one kind, in one line (the notes and the player's diagnostics). */
  summary(kind: string): string | null {
    const rows = Object.entries(this.#data).filter(([key]) => key.startsWith(`${kind}|`)).sort((left, right) => right[1].tries - left[1].tries).slice(0, 4);
    if (rows.length === 0) return null;
    return `experience ${kind}: ` + rows.map(([key, tally]) => `${key.split("|").slice(1).join(" / ")} ${tally.ok + tally.improved}/${tally.tries} ok`).join("; ");
  }

  snapshot(): Record<string, Tally> { return JSON.parse(JSON.stringify(this.#data)) as Record<string, Tally>; }
}

/** A store in one JSON file (per player, not per save). Unreadable = no experience yet; a failed write never disturbs the city. */
export function fileExperienceStore(file: string): ExperienceStore {
  return {
    load() { try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Tally>; } catch { return null; } },
    save(data) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), "utf8"); } catch { /* bookkeeping only */ } },
  };
}
