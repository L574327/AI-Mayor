/**
 * COSTLY FACILITIES ARE NEVER PLACED AND TAKEN DOWN IN A LOOP (the player's rule, 2026-10-07).
 *
 * Live 2026-10-07 (Hartley): a recycling centre and a burning plant, about a million each, were placed where no road the game accepts could reach them,
 * taken down after four failed roads (nothing is refunded) and placed again elsewhere the next cycle: the treasury went from 2.7 million to 0.1 in two
 * rounds. The same loop existed for plants read back "unattached" right after placement. The rule now, for every facility in `HIGH_VALUE_FACILITY`:
 *  - it is never taken down by the Mayor (no road, no link, unreachable): it stays, and the notice is left to the player;
 *  - one costly placement per `HIGH_VALUE_PLACEMENT_COOLDOWN_HOURS` across the city, whatever the kind;
 *  - while one of a kind stands stranded (no road / no link), no other of that kind is placed for `HIGH_VALUE_STRANDED_BLOCK_HOURS`.
 * Kept across a restart of the run process (`builder-memory.ts`); a world that went back in time (an older save loaded) clears the clocks.
 */
import { stampElapsed, type GameStamp } from "./game-clock";

/** Facilities that cost hundreds of thousands to over a million: never placed in a loop, never taken down by the Mayor. */
export const HIGH_VALUE_FACILITY = /Incinerat|Recycl|PowerPlant|WastewaterTreatment|WaterTreatment|Hospital|Landfill|University|College|TrainStation|CargoStation|Airport|Harbor|Crematorium|Cemetery|Geothermal|SolarPower|Nuclear|Hydroelectric|Depot/i;
export const isHighValueFacility = (prefab: string | null | undefined): boolean => HIGH_VALUE_FACILITY.test(prefab ?? "");

export const HIGH_VALUE_PLACEMENT_COOLDOWN_HOURS = 24;
export const HIGH_VALUE_PLACEMENT_COOLDOWN_CYCLES = 24;
export const HIGH_VALUE_STRANDED_BLOCK_HOURS = 7 * 24;
export const HIGH_VALUE_STRANDED_BLOCK_CYCLES = 120;

export interface HighValueMemory {
  lastPlacedAt: GameStamp | null;
  lastPrefab?: string;
  stranded: Array<{ kind: string; at: GameStamp }>;
}

/** The kind of a prefab ("RecyclingCenter01" -> "RecyclingCenter"): a stranded one blocks its kind, not only its exact prefab. */
export const highValueKind = (prefab: string): string => prefab.replace(/\d+$/, "");

/** Elapsed, or the world went back in time (an older save was loaded: its clock is earlier than the stamp). */
const elapsed = (since: GameStamp, now: GameStamp, hours: number, cycles: number): boolean =>
  (since.frame !== null && now.frame !== null && now.frame < since.frame) || stampElapsed(since, now, hours, cycles);

export class HighValueGuard {
  #lastPlacedAt: GameStamp | null;
  #lastPrefab: string | undefined;
  readonly #stranded: Array<{ kind: string; at: GameStamp }>;

  constructor(memory?: HighValueMemory | null) {
    // A remembered stamp without a frame counts cycles of a process that is gone: it starts again from this one's first cycle.
    const fresh = (stamp: GameStamp): GameStamp => (stamp.frame === null ? { frame: null, cycle: 0 } : stamp);
    this.#lastPlacedAt = memory?.lastPlacedAt ? fresh(memory.lastPlacedAt) : null;
    this.#lastPrefab = memory?.lastPrefab;
    this.#stranded = (memory?.stranded ?? []).map((entry) => ({ kind: entry.kind, at: fresh(entry.at) }));
  }

  /** Why this prefab may not be placed now (null: it may). Cheap facilities always may. */
  blocked(prefab: string, now: GameStamp): string | null {
    if (!isHighValueFacility(prefab)) return null;
    const kind = highValueKind(prefab);
    const stranded = this.#stranded.find((entry) => entry.kind === kind && !elapsed(entry.at, now, HIGH_VALUE_STRANDED_BLOCK_HOURS, HIGH_VALUE_STRANDED_BLOCK_CYCLES));
    if (stranded) return `HIGH_VALUE_STRANDED: a ${kind} placed earlier still has no road or link; no other is placed until it is joined (or ${HIGH_VALUE_STRANDED_BLOCK_HOURS / 24} game days pass)`;
    if (this.#lastPlacedAt && !elapsed(this.#lastPlacedAt, now, HIGH_VALUE_PLACEMENT_COOLDOWN_HOURS, HIGH_VALUE_PLACEMENT_COOLDOWN_CYCLES)) {
      return `HIGH_VALUE_COOLDOWN: one costly facility per ${HIGH_VALUE_PLACEMENT_COOLDOWN_HOURS} game hours (the last: ${this.#lastPrefab ?? "?"})`;
    }
    return null;
  }

  /** A costly facility the game accepted. */
  placed(prefab: string, now: GameStamp): void {
    if (!isHighValueFacility(prefab)) return;
    this.#lastPlacedAt = now;
    this.#lastPrefab = prefab;
  }

  /** A costly facility of the Mayor's stands with no road or no link: it stays, and its kind waits. */
  stranded(prefab: string, now: GameStamp): void {
    if (!isHighValueFacility(prefab)) return;
    const kind = highValueKind(prefab);
    const index = this.#stranded.findIndex((entry) => entry.kind === kind);
    if (index >= 0) this.#stranded.splice(index, 1);
    this.#stranded.push({ kind, at: now });
    if (this.#stranded.length > 40) this.#stranded.shift();
  }

  /** Its road or link arrived (the notice went): the kind may be placed again. */
  joined(prefab: string): void {
    const kind = highValueKind(prefab);
    const index = this.#stranded.findIndex((entry) => entry.kind === kind);
    if (index >= 0) this.#stranded.splice(index, 1);
  }

  strandedKinds(): string[] { return this.#stranded.map((entry) => entry.kind); }

  snapshot(): HighValueMemory {
    return { lastPlacedAt: this.#lastPlacedAt, ...(this.#lastPrefab ? { lastPrefab: this.#lastPrefab } : {}), stranded: [...this.#stranded] };
  }
}
