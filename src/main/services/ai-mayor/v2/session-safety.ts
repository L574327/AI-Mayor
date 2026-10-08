/**
 * SESSION SAFETY: what keeps the player's game alive and the Mayor honest across crashes and disconnects.
 *
 * Measured 2026-10-04: the game process vanished twice (18:22 and 21:13). Neither was a kill. The game's own log ends in
 * `Could not allocate memory: System out of memory! (134217728B NativeArray)` inside `SaveGameSystem 鈫?TerrainSystem.SerializeHeightmap`,
 * Windows' resource-exhaustion detector had named `Cities2.exe` (12-18 GB) the largest user of virtual memory seconds before each, and
 * the process is parented by explorer.exe, outside every MCP / harness / Claude process tree. The game's save (its autosave, or ours)
 * needs hundreds of megabytes of NEW contiguous memory at the moment the machine's commit limit is nearly spent.
 *
 * So the product does three small things, none of which makes a save or a plan the authority over the world:
 *  1. Before it asks for a checkpoint save it looks at the machine's free commit memory, and does not ask when it is short (the save is
 *     what fails). That is the only thing memory ever holds back: the Mayor never stops building because of it — the game's size is the
 *     game's own, not something this product should fence.
 *  2. It takes a checkpoint save after a meaningful batch (a district built and read back, land bought), at most every few minutes, in a
 *     small ring of named slots: crash protection only. A save is never read back as a source of truth about the world.
 *  3. It notices when the connection to the game was lost or the world changed (a different save loaded, the game restarted, the clock
 *     went backwards) and re-reads everything: nothing planned before is applied to the new world.
 *
 * The thresholds are starting values from one machine (31.8 GB RAM, 52.6 GB commit limit, a game that grows to 15-18 GB), not rules.
 */
export const CHECKPOINT_MIN_INTERVAL_MS = 10 * 60_000;
/** A save needs several hundred MB of new memory at once; do not ask for one with less than this free. */
export const CHECKPOINT_MIN_FREE_COMMIT_GB = 6;
/** Checkpoints rotate through this many named slots, so the disk does not fill with 50 MB saves. */
export const CHECKPOINT_SLOTS = 3;

export type MemoryVerdict = "OK" | "NO_CHECKPOINT";

/** Unknown headroom decides nothing: the guard never stops a Mayor it cannot measure. */
export function memoryVerdict(freeCommitGb: number | null): MemoryVerdict {
  if (freeCommitGb === null || !Number.isFinite(freeCommitGb)) return "OK";
  if (freeCommitGb < CHECKPOINT_MIN_FREE_COMMIT_GB) return "NO_CHECKPOINT";
  return "OK";
}

export function checkpointSlotName(slot: number): string {
  return `AI Mayor Checkpoint ${(Math.abs(Math.trunc(slot)) % CHECKPOINT_SLOTS) + 1}`;
}

/**
 * Whether to save now. A batch counts only after the world was read back (the caller says so), saves are spaced out, and
 * a low-memory machine is never asked to save. Unknown memory does not block (see `memoryVerdict`).
 */
export function decideCheckpoint(input: { nowMs: number; lastCheckpointMs: number | null; freeCommitGb: number | null; batchConfirmed: boolean }):
  { save: boolean; reason: string } {
  if (!input.batchConfirmed) return { save: false, reason: "no confirmed batch" };
  if (input.lastCheckpointMs !== null && input.nowMs - input.lastCheckpointMs < CHECKPOINT_MIN_INTERVAL_MS) return { save: false, reason: "a checkpoint was taken recently" };
  if (memoryVerdict(input.freeCommitGb) !== "OK") return { save: false, reason: `free commit memory is ${input.freeCommitGb?.toFixed(1)} GB; a save could crash the game` };
  return { save: true, reason: "confirmed batch, memory allows" };
}

export interface WorldIdentity {
  /** Game session + world generation: changes when the game restarts or another world is loaded. */
  id: string;
  /** The simulation frame: going backwards means an older save was loaded into the same session. */
  frame: number | null;
}

export type WorldWatchVerdict = "SAME" | "UNREACHABLE" | "REBASELINE";

/**
 * Tracks the world the Mayor is looking at. While the game cannot be reached the Mayor writes nothing; the first answer after that, or
 * any change of world, is a REBASELINE: everything the Mayor remembered about the old world is dropped and the world is read afresh.
 * What the player did meanwhile is simply what the world now is.
 */
export class WorldWatch {
  #id: string | null = null;
  #frame: number | null = null;
  #lost = false;

  observe(identity: WorldIdentity | null): WorldWatchVerdict {
    if (identity === null) { this.#lost = true; return "UNREACHABLE"; }
    const changed = this.#id !== null && (identity.id !== this.#id || (this.#frame !== null && identity.frame !== null && identity.frame < this.#frame));
    const reconnected = this.#lost;
    this.#lost = false;
    this.#id = identity.id;
    this.#frame = identity.frame;
    return changed || reconnected ? "REBASELINE" : "SAME";
  }
}

