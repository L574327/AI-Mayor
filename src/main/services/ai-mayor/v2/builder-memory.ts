import * as fs from "node:fs";
import * as path from "node:path";
import type { SpatialPoint2 } from "../spatial/types";

/**
 * WHAT THE DISTRICT BUILDER REMEMBERS ACROSS A RESTART OF THE RUN PROCESS (the supervisor restarts it when it is stuck).
 *
 * The world is the authority and nothing here is trusted over it; this is only the builder's own bookkeeping that the world cannot give back:
 * which facilities it placed (a pump that never got a road is taken down only if it is known to be its own: after a restart the pump stood with its
 * notice for ever), which districts it zoned for industry (a zoned-empty industrial district has no buildings yet for the isolation rule to see), and
 * where a facility could not get a road. Bounded (each list is cut to its newest entries) and overwritten whole, never appended, so it cannot grow.
 * Keyed by the world's identity: a memory of another save is ignored.
 */
export interface BuilderMemory {
  key: string;
  ownFacilities: Array<{ index: number; version: number; position?: SpatialPoint2; prefab?: string }>;
  zoned: Array<{ role: string; rect: { minX: number; minZ: number; maxX: number; maxZ: number } }>;
  accessFailed: Array<{ position: SpatialPoint2; radius: number }>;
  signaturesStanding: string[];
  /** Sites of big buildings the game refused (`big-building-site.ts`): never asked again. */
  bigRefused?: SpatialPoint2[];
  /** The number of owned tiles when those refusals were made: more land (or less) is a changed condition, and the refusals are forgotten. */
  bigRefusedOwnedTiles?: number;
  /** The road-care pass's running trials and what it already did (`road-care.ts`): a trial still gets judged, and taken back if worse, after a restart. */
  roadCare?: import("./road-care").RoadCareMemory;
  /** When land was last bought for a big service building: the cooldown holds across a restart (a restart must not reopen the purse). */
  bigLandBoughtAt?: { frame: number | null; cycle: number };
  /** The costly-facility guard (`high-value-guard.ts`): a restart must not reopen the purse either. */
  highValue?: import("./high-value-guard").HighValueMemory;
}

export const MEMORY_LIMITS = { ownFacilities: 300, zoned: 400, accessFailed: 60, signaturesStanding: 100, bigRefused: 200 } as const;

export interface BuilderMemoryStore {
  load(): BuilderMemory | null;
  save(memory: BuilderMemory): void;
}

/** A store in one JSON file. A missing, unreadable or foreign-world file is "no memory"; a failed write never disturbs the city. */
export function fileBuilderMemory(file: string, key: string): BuilderMemoryStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BuilderMemory;
        return parsed && parsed.key === key ? parsed : null;
      } catch { return null; }
    },
    save(memory) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(memory), "utf8");
      } catch { /* bookkeeping only */ }
    },
  };
}

/** The newest entries of each list, within the limits. */
export function boundedMemory(memory: BuilderMemory): BuilderMemory {
  return {
    key: memory.key,
    ownFacilities: memory.ownFacilities.slice(-MEMORY_LIMITS.ownFacilities),
    zoned: memory.zoned.slice(-MEMORY_LIMITS.zoned),
    accessFailed: memory.accessFailed.slice(-MEMORY_LIMITS.accessFailed),
    signaturesStanding: memory.signaturesStanding.slice(-MEMORY_LIMITS.signaturesStanding),
    bigRefused: (memory.bigRefused ?? []).slice(-MEMORY_LIMITS.bigRefused),
    ...(memory.bigRefusedOwnedTiles !== undefined ? { bigRefusedOwnedTiles: memory.bigRefusedOwnedTiles } : {}),
    ...(memory.bigLandBoughtAt ? { bigLandBoughtAt: memory.bigLandBoughtAt } : {}),
    ...(memory.highValue ? { highValue: { ...memory.highValue, stranded: memory.highValue.stranded.slice(-40) } } : {}),
    ...(memory.roadCare ? { roadCare: {
      trials: memory.roadCare.trials.slice(-40), tried: memory.roadCare.tried.slice(-400), planted: memory.roadCare.planted.slice(-800),
    } } : {}),
  };
}
