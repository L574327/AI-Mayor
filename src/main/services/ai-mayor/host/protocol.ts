/**
 * The product's three layers talk through these messages only:
 *
 *   engine (child process, `mayor-engine.ts`)  --EngineMessage-->  supervisor (main process, `mayor-supervisor.ts`)  --ConsoleState-->  console UI
 *   engine                                      <--HostMessage---  supervisor                                         <--IPC calls---   console UI
 *
 * The engine is the proven live recipe (the continuous-growth run that was measured for days), run as a child so a stuck call can be killed and the
 * city keeps its Mayor whatever the window does. The supervisor only watches, restarts and relays; the UI only shows and asks.
 */

/** Permissions the player granted at takeover. Read by the engine from its environment at start; a change restarts the engine. */
export interface TakeoverPermissions {
  /** Buy map tiles. */
  allowLand: boolean;
  /** Adjust taxes, service budgets and loans when the books need it. */
  allowEconomy: boolean;
  /** Never take down or rezone what the player built: ruins of the player's buildings stay, over-supplied zoning is not withdrawn. */
  preservePlayerAssets: boolean;
}

export const DEFAULT_PERMISSIONS: TakeoverPermissions = { allowLand: true, allowEconomy: true, preservePlayerAssets: false };

export type EnginePhase = "STARTING" | "WAITING_FOR_GAME" | "BACKING_UP" | "RUNNING" | "PAUSING" | "PAUSED" | "STOPPED" | "FAILED";

export interface CitySnapshot {
  readAt: string;
  cityName: string | null;
  worldId: string | null;
  gameDateTime: string | null;
  gamePaused: boolean | null;
  gameSpeed: number | null;
  population: number | null;
  treasury: number | null;
  monthlyBalance: number | null;
  milestone: number | null;
  xp: number | null;
  nextMilestoneXp: number | null;
  electricity: { production: number | null; consumption: number | null } | null;
  water: { capacity: number | null; consumption: number | null } | null;
  /** The game's own road-panel figures (Bridge /city/traffic): volume-weighted city flow and the worst edges. Null: an older Bridge without the reader. */
  traffic: { flowPercent: number; worst: Array<{ position: { x: number; z: number }; prefab: string | null; flowPercent: number; volume: number; wear: number }> } | null;
  /** Problem icons by type, as the game reports them (the Bridge reads up to 500, in priority order). */
  icons: Record<string, number>;
  iconsTruncated: boolean;
}

export interface CycleReport {
  at: string;
  status: string | null;
  outcome: string | null;
  waitReason: string | null;
  elapsedMs: number | null;
  notes: string[];
}

export type EngineMessage =
  | { k: "call"; name: string; ok: boolean; answer?: string }
  | { k: "cycle" }
  | { k: "phase"; phase: EnginePhase; detail?: string }
  | { k: "status"; text: string; tick: number }
  | { k: "commentary"; text: string; tone?: string }
  | { k: "snapshot"; data: CitySnapshot }
  | { k: "decision"; data: CycleReport }
  | { k: "backup"; ok: boolean; name: string; detail: string }
  | { k: "command-result"; id: string; ok: boolean; detail: string; notes?: string[] }
  /** What the player's instructions protect and allow now (the compiled revision): shown by the console. */
  | { k: "limits"; protectedAreas: string[]; permissions: TakeoverPermissions; keepZoning: boolean; keepRoads: boolean;
      /** The player's word on growth, as the engine holds it now: "autonomy, no outward expansion" and the population at which growth stops (null: the default). */
      expansionHeld?: boolean; targetPopulation?: number | null };

export type HostMessage =
  | { k: "pause" }
  | { k: "resume" }
  | { k: "stop" }
  | { k: "command"; id: string; text: string; lang: "zh" | "en"; instruction: import("./intent-lowering").Instruction }
  /** The player lifts every spoken limit for this city (protected districts, forbids); the Settings permissions stay. */
  | { k: "clear-limits" };

/** Environment keys the supervisor passes to the engine. */
export const ENGINE_ENV = {
  serverPath: "AI_MAYOR_MCP_SERVER",
  dataDir: "AI_MAYOR_DATA_DIR",
  permissions: "AI_MAYOR_PERMISSIONS",
  backupFirst: "AI_MAYOR_BACKUP_FIRST",
  startPaused: "AI_MAYOR_START_PAUSED",
  /** "1" when the player just changed the takeover permissions in Settings: that is their latest word, so earlier spoken permission limits are dropped. */
  permissionsChanged: "AI_MAYOR_PERMISSIONS_CHANGED",
} as const;

export function readPermissions(raw: string | undefined): TakeoverPermissions {
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<TakeoverPermissions>;
    return {
      allowLand: parsed.allowLand ?? DEFAULT_PERMISSIONS.allowLand,
      allowEconomy: parsed.allowEconomy ?? DEFAULT_PERMISSIONS.allowEconomy,
      preservePlayerAssets: parsed.preservePlayerAssets ?? DEFAULT_PERMISSIONS.preservePlayerAssets,
    };
  } catch {
    return { ...DEFAULT_PERMISSIONS };
  }
}
