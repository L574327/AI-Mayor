/**
 * THE MAYOR SUPERVISOR — runs in the desktop app's main process. It starts the engine (`mayor-engine.ts`) as a child process, watches it with the
 * stall rules measured live (`v2/stall-supervisor.ts`: progress = a finished call or cycle or the game's frame moving; a stuck run is killed and
 * started again, at most 3 times in 10 minutes), relays its messages to the console, and carries the player's commands to it.
 *
 * It holds no city state of its own beyond the latest message of each kind (what the console shows). It never restarts the game, never loads a save,
 * never lifts a pause the player made: a world that is paused is reported, not resumed.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mayStartRun, StallWatch, type WorldProbe } from "../v2/stall-supervisor";
import {
  type CitySnapshot, type CycleReport, DEFAULT_PERMISSIONS, ENGINE_ENV, type EngineMessage, type EnginePhase, type HostMessage, type TakeoverPermissions,
} from "./protocol";

const BRIDGE_URL = (process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
const LOOK_EVERY_MS = 1_000;
const STOP_WAIT_MS = 10_000;
const KEPT_EVENTS = 200;
const KEPT_COMMENTARY = 30;

export interface SupervisorOptions {
  /** The executable that runs the engine (Electron in node mode when packaged, node in development). */
  execPath: string;
  /** The compiled engine script, or a .ts file run through tsx in development. */
  enginePath: string;
  /** The game connector (MCP server) entry. */
  serverPath: string;
  /** Where the engine keeps its small per-world memory. */
  dataDir: string;
  log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface ActivityEvent { at: string; kind: "phase" | "recovery" | "backup" | "command" | "decision" | "game"; text: string; detail?: string }

export interface ConsoleState {
  phase: EnginePhase | "IDLE";
  phaseDetail: string | null;
  gameConnection: "CONNECTED" | "NOT_RUNNING" | "UNKNOWN";
  gamePaused: boolean | null;
  supervision: { state: string; reason: string; restarts: number };
  permissions: TakeoverPermissions;
  /** Districts the player's instructions protect (names), from the compiled revision. */
  protectedAreas: string[];
  /** The permissions the Mayor actually works under: the settings, narrowed by the player's spoken limits ("no loans"). */
  effectivePermissions: TakeoverPermissions | null;
  /** Spoken "don't rezone" / "don't change the roads". */
  keep: { zoning: boolean; roads: boolean };
  /** Autonomy without outward expansion ("keep the city running, add no districts") and the population target, as the engine holds them. */
  growth: { held: boolean; targetPopulation: number | null };
  takenOverWorldId: string | null;
  backup: { ok: boolean; name: string; detail: string; at: string } | null;
  status: { text: string; tick: number; at: string } | null;
  snapshot: CitySnapshot | null;
  lastCycle: CycleReport | null;
  commentary: Array<{ at: string; text: string; tone?: string }>;
  activity: ActivityEvent[];
}

export class MayorSupervisor extends EventEmitter {
  readonly #options: SupervisorOptions;
  #child: ChildProcess | null = null;
  #childExited = true;
  #cleanExit = false;
  #watch = new StallWatch(Date.now());
  #timer: NodeJS.Timeout | null = null;
  #wanted = false;
  #recovering = false;
  #pendingCommands = new Map<string, (result: { ok: boolean; detail: string; notes?: string[] }) => void>();
  #state: ConsoleState = {
    phase: "IDLE", phaseDetail: null, gameConnection: "UNKNOWN", gamePaused: null,
    supervision: { state: "IDLE", reason: "", restarts: 0 }, permissions: { ...DEFAULT_PERMISSIONS }, protectedAreas: [], effectivePermissions: null, keep: { zoning: false, roads: false }, growth: { held: false, targetPopulation: null }, takenOverWorldId: null,
    backup: null, status: null, snapshot: null, lastCycle: null, commentary: [], activity: [],
  };
  #lastReported = "";
  #backupDone = false;

  constructor(options: SupervisorOptions) {
    super();
    this.#options = options;
    // The game connection is shown from the first second, before any takeover (looking never starts or restarts anything by itself).
    this.#ensureWatching();
  }

  get state(): ConsoleState { return this.#state; }

  /** Take over the loaded city with these permissions: a confirmed backup first, then the Mayor runs. */
  async takeOver(permissions: TakeoverPermissions): Promise<ConsoleState> {
    this.#state.permissions = { ...permissions };
    this.#wanted = true;
    this.#backupDone = false;
    this.#event("phase", "takeover requested");
    await this.#restartEngine({ backupFirst: true });
    this.#ensureWatching();
    return this.#publish();
  }

  /** Start (or keep) the Mayor on the loaded city without a new backup (the city was already taken over in this app session). */
  async resumeOrStart(): Promise<ConsoleState> {
    if (this.#child && !this.#childExited) { this.#send({ k: "resume" }); return this.#publish(); }
    this.#wanted = true;
    await this.#restartEngine({ backupFirst: !this.#backupDone });
    this.#ensureWatching();
    return this.#publish();
  }

  /** Pause the Mayor (not the game): no new cycle starts; the one in flight finishes first. */
  pause(): ConsoleState { this.#send({ k: "pause" }); this.#state.phase = "PAUSING"; return this.#publish(); }

  async stop(): Promise<ConsoleState> {
    this.#wanted = false;
    this.#send({ k: "stop" });
    const deadline = Date.now() + STOP_WAIT_MS;
    while (!this.#childExited && Date.now() < deadline) await sleep(200);
    this.#kill();
    // The city is handed back RUNNING at normal speed, whether the engine got to do it itself or was cut short (a stopped Mayor must not leave a frozen game).
    try { await fetch(`${BRIDGE_URL}/sim/control?paused=false&speed=1`, { method: "POST", signal: AbortSignal.timeout(5_000) }); } catch { /* no game: nothing to hand back */ }
    this.#state.phase = "STOPPED";
    this.#event("phase", "stopped by the player");
    return this.#publish();
  }

  /** Change the permissions: the engine reads them at start, so it is restarted (on the same city, no new backup). */
  async setPermissions(permissions: TakeoverPermissions): Promise<ConsoleState> {
    this.#state.permissions = { ...permissions };
    if (this.#child && !this.#childExited) await this.#restartEngine({ backupFirst: false, permissionsChanged: true });
    return this.#publish();
  }

  clearLimits(): ConsoleState {
    if (this.#child && !this.#childExited) this.#send({ k: "clear-limits" });
    this.#event("command", "limits cleared");
    return this.#publish();
  }

  command(text: string, instruction: import("./intent-lowering").Instruction, lang: "zh" | "en" = "zh"): Promise<{ ok: boolean; detail: string; notes?: string[] }> {
    if (!this.#child || this.#childExited) return Promise.resolve({ ok: false, detail: "the Mayor is not running" });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.#event("command", text);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#pendingCommands.delete(id); resolve({ ok: false, detail: "the Mayor did not answer in time (it takes the instruction at the start of its next cycle)" }); }, 60_000);
      this.#pendingCommands.set(id, (result) => { clearTimeout(timer); resolve(result); });
      this.#send({ k: "command", id, text, lang, instruction });
    });
  }

  dispose(): void {
    this.#wanted = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#kill();
  }

  // ------------------------------------------------------------------------------------------------

  #ensureWatching(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#look(), LOOK_EVERY_MS);
  }

  async #look(): Promise<void> {
    const probe = await probeBridge();
    this.#state.gameConnection = probe.reachable ? "CONNECTED" : "NOT_RUNNING";
    this.#state.gamePaused = probe.paused;
    if (!this.#wanted || this.#recovering) { this.#publishThrottled(); return; }
    if (this.#childExited && this.#cleanExit) { this.#publishThrottled(); return; }
    // Waiting for the game or for a takeover backup is not a stall: the engine reports progress only once the city is there.
    const waitingPhase = this.#state.phase === "WAITING_FOR_GAME" || this.#state.phase === "BACKING_UP" || this.#state.phase === "STARTING";
    if (waitingPhase && !this.#childExited) { this.#watch.started(Date.now()); this.#publishThrottled(); return; }
    const decision = this.#watch.decide(Date.now(), probe, { childAlive: !this.#childExited });
    this.#state.supervision = { state: decision.state, reason: decision.reason, restarts: this.#watch.restartsInWindow };
    if (decision.action === "RESTART") {
      this.#recovering = true;
      this.#event("recovery", "restarting the Mayor", decision.reason);
      try { await this.#restartEngine({ backupFirst: false, afterStall: true }); } finally { this.#recovering = false; }
    } else if (decision.action === "REPORT" && decision.state !== this.#lastReported) {
      this.#event("recovery", decision.state, decision.reason);
    }
    this.#lastReported = decision.state;
    this.#publishThrottled();
  }

  async #restartEngine(options: { backupFirst: boolean; afterStall?: boolean; permissionsChanged?: boolean }): Promise<void> {
    this.#kill();
    const deadline = Date.now() + STOP_WAIT_MS;
    while (!this.#childExited && Date.now() < deadline) await sleep(200);
    if (!this.#childExited) { this.#event("recovery", "the old Mayor process did not exit; no second one is started beside it"); return; }
    if (options.afterStall) {
      // A new engine starts only on a Bridge that is ready and idle (a busy one clears its own orphaned operation).
      const readyBy = Date.now() + 60_000;
      while (Date.now() < readyBy && !mayStartRun(await probeBridge()).ok) await sleep(1_000);
      this.#watch.restarted(Date.now());
    }
    this.#launch(options.backupFirst, options.permissionsChanged === true);
  }

  #launch(backupFirst: boolean, permissionsChanged = false): void {
    const { execPath, enginePath, serverPath, dataDir } = this.#options;
    const args = enginePath.endsWith(".ts") ? ["--import", "tsx", enginePath] : [enginePath];
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1",
      [ENGINE_ENV.serverPath]: serverPath, [ENGINE_ENV.dataDir]: dataDir, [ENGINE_ENV.permissions]: JSON.stringify(this.#state.permissions),
      [ENGINE_ENV.backupFirst]: backupFirst ? "1" : "0", [ENGINE_ENV.permissionsChanged]: permissionsChanged ? "1" : "0" };
    const child = spawn(execPath, args, { stdio: ["ignore", "pipe", "pipe", "ipc"], env, windowsHide: true });
    this.#child = child;
    this.#childExited = false;
    this.#cleanExit = false;
    child.stdout?.on("data", (chunk) => this.#options.log?.(`engine: ${String(chunk).trim().slice(0, 400)}`));
    child.stderr?.on("data", (chunk) => this.#options.log?.(`engine stderr: ${String(chunk).trim().slice(0, 400)}`));
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#childExited = true;
      this.#cleanExit = code === 0 && signal === null;
      this.#event("phase", `the Mayor process ended (${code ?? signal})`);
    });
    child.on("message", (raw) => this.#onMessage(raw as EngineMessage));
    this.#watch.started(Date.now());
    this.#event("phase", backupFirst ? "Mayor starting (backup first)" : "Mayor starting");
  }

  #kill(): void {
    const child = this.#child;
    if (!child || this.#childExited || !child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
  }

  #send(message: HostMessage): void {
    try { this.#child?.send(message); } catch { /* the engine is gone; the watch restarts it */ }
  }

  #onMessage(message: EngineMessage): void {
    const now = Date.now();
    switch (message.k) {
      case "call": this.#watch.note({ call: { name: message.name, ok: message.ok, ...(message.answer !== undefined ? { answer: message.answer } : {}) } }, now); return;
      case "cycle": this.#watch.note({ cycle: true }, now); return;
      case "phase":
        if (message.phase !== this.#state.phase || message.detail !== this.#state.phaseDetail) this.#event("phase", message.phase, message.detail);
        this.#state.phase = message.phase;
        this.#state.phaseDetail = message.detail ?? null;
        if (message.phase === "RUNNING" && this.#state.snapshot?.worldId) this.#state.takenOverWorldId = this.#state.snapshot.worldId;
        break;
      case "status": this.#state.status = { text: message.text, tick: message.tick, at: new Date().toISOString() }; break;
      case "commentary":
        if (message.text) this.#state.commentary = [...this.#state.commentary, { at: new Date().toISOString(), text: message.text, ...(message.tone ? { tone: message.tone } : {}) }].slice(-KEPT_COMMENTARY);
        break;
      case "snapshot": this.#state.snapshot = message.data; break;
      case "decision":
        this.#state.lastCycle = message.data;
        if (message.data.outcome === "BUILD" || message.data.status === "UTILITY_REPAIRED" || message.data.status === "LAND_PURCHASED") {
          this.#event("decision", `${message.data.status ?? message.data.outcome}`, message.data.notes.slice(0, 3).join(" | "));
        }
        break;
      case "backup":
        this.#state.backup = { ...message, at: new Date().toISOString() };
        if (message.ok) this.#backupDone = true;
        this.#event("backup", message.ok ? `backup saved: ${message.name}` : "backup failed", message.detail);
        break;
      case "command-result": { const resolve = this.#pendingCommands.get(message.id); this.#pendingCommands.delete(message.id); resolve?.({ ok: message.ok, detail: message.detail, ...(message.notes ? { notes: message.notes } : {}) }); break; }
      case "limits":
        // The settings keep the player's chosen permissions; what the spoken limits narrow them to is shown beside them.
        this.#state.protectedAreas = message.protectedAreas;
        this.#state.effectivePermissions = message.permissions;
        this.#state.keep = { zoning: message.keepZoning, roads: message.keepRoads };
        this.#state.growth = { held: message.expansionHeld === true, targetPopulation: message.targetPopulation ?? null };
        break;
    }
    this.#publishThrottled();
  }

  #event(kind: ActivityEvent["kind"], text: string, detail?: string): void {
    this.#state.activity = [...this.#state.activity, { at: new Date().toISOString(), kind, text, ...(detail ? { detail: detail.slice(0, 400) } : {}) }].slice(-KEPT_EVENTS);
    this.#options.log?.(`mayor ${kind}: ${text}`, detail ? { detail } : undefined);
  }

  #lastPublishAt = 0;
  #publishThrottled(): void { if (Date.now() - this.#lastPublishAt >= 500) this.#publish(); }
  #publish(): ConsoleState { this.#lastPublishAt = Date.now(); this.emit("state", this.#state); return this.#state; }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function probeBridge(): Promise<WorldProbe> {
  try {
    const response = await fetch(`${BRIDGE_URL}/state`, { signal: AbortSignal.timeout(3_000) });
    const body = (await response.json()) as Record<string, any>;
    const world = (body.world ?? {}) as Record<string, any>;
    const sim = (body.simulation ?? {}) as Record<string, any>;
    return { reachable: true, paused: typeof sim.paused === "boolean" ? sim.paused : null, frame: typeof sim.frameIndex === "number" ? sim.frameIndex : null,
      busy: typeof world.nativeOperationBusy === "boolean" ? world.nativeOperationBusy : null, stage: typeof world.nativeOperationStage === "string" ? world.nativeOperationStage : null,
      ready: typeof world.worldReady === "boolean" ? world.worldReady && body.cityLoaded === true && body.isLoading === false : null };
  } catch {
    return { reachable: false, paused: null, frame: null, busy: null, stage: null, ready: null };
  }
}
