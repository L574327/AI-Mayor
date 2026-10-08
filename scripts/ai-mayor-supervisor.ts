/**
 * Watches the Mayor's live run from outside and restarts it when it is stuck (decision logic: v2/stall-supervisor.ts).
 *
 *   $env:AI_MAYOR_PROFILE='BALANCED'; $env:AI_MAYOR_LIVE_MINUTES='120'
 *   npx tsx scripts/ai-mayor-supervisor.ts
 *
 * The run process is a child with an IPC channel: it reports each finished tool call and each finished cycle (a few bytes, in memory; nothing is
 * written). This process reads the Bridge's /state directly over HTTP every second, so looking at the world never queues behind a stuck build
 * operation. One executor: the old run process is killed and confirmed gone before a new one starts, and a new one starts only on a Bridge that
 * reports ready and idle (a running world is taken over as it is). It never restarts the game, never lifts a player's pause, and stops restarting after 3 restarts in 10 minutes.
 * Each event is one JSON line (tmp/supervisor-events.jsonl) and one console line; the language layer can read them, the recovery does not depend on it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import {
  mayStartRun, StallWatch, type StallDecision, type WorldProbe,
} from "../src/main/services/ai-mayor/v2/stall-supervisor";

const BRIDGE_URL = (process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
const LOOK_EVERY_MS = 1_000;
const STOP_WAIT_MS = 10_000;
const READY_WAIT_MS = 60_000;
const totalMinutes = Number(process.env.AI_MAYOR_LIVE_MINUTES ?? 120);
const restartOnPausedIdle = process.env.AI_MAYOR_SUPERVISOR_RESTART_ON_PAUSED_IDLE === "1";
const eventsFile = process.env.AI_MAYOR_SUPERVISOR_EVENTS ?? "tmp/supervisor-events.jsonl";
const logFile = process.env.AI_MAYOR_SUPERVISOR_LOG ?? `tmp/run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
const startedAt = Date.now();

fs.mkdirSync("tmp", { recursive: true });
fs.writeFileSync("tmp/current-run.txt", logFile);

function event(type: string, detail: Record<string, unknown> = {}): void {
  const row = { at: new Date().toISOString(), type, ...detail };
  console.log(`[supervisor] ${type} ${JSON.stringify(detail)}`);
  try { fs.appendFileSync(eventsFile, `${JSON.stringify(row)}\n`, "utf8"); } catch { /* a failed event line never stops the watch */ }
}

async function probe(): Promise<WorldProbe> {
  try {
    const response = await fetch(`${BRIDGE_URL}/state`, { signal: AbortSignal.timeout(3_000) });
    const body = await response.json() as Record<string, any>;
    const world = (body.world ?? {}) as Record<string, any>;
    const sim = (body.simulation ?? {}) as Record<string, any>;
    return { reachable: true, paused: typeof sim.paused === "boolean" ? sim.paused : null, frame: typeof sim.frameIndex === "number" ? sim.frameIndex : null,
      busy: typeof world.nativeOperationBusy === "boolean" ? world.nativeOperationBusy : null, stage: typeof world.nativeOperationStage === "string" ? world.nativeOperationStage : null,
      ready: typeof world.worldReady === "boolean" ? world.worldReady && body.cityLoaded === true && body.isLoading === false : null };
  } catch {
    return { reachable: false, paused: null, frame: null, busy: null, stage: null, ready: null };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const watch = new StallWatch(Date.now());
let child: ChildProcess | null = null;
let childExited = true;
let runs = 0;
/** The run process ended by itself with exit code 0 (its minutes are up, or it stopped itself): not a drop, not restarted. */
let cleanExit = false;
const runScript = process.env.AI_MAYOR_SUPERVISED_SCRIPT ?? "scripts/ai-mayor-continuous-growth-live.ts";

function launch(): void {
  const remaining = Math.max(1, Math.round(totalMinutes - (Date.now() - startedAt) / 60_000));
  runs += 1;
  const log = fs.openSync(logFile, "a");
  // Every start is the run's own first-run path on the loaded world (the in-memory ledger): the world is the authority, so a restart re-reads it.
  child = spawn(process.execPath, ["--import", "tsx", runScript], {
    stdio: ["ignore", log, log, "ipc"],
    env: { ...process.env, AI_MAYOR_FRESH_LEDGER: "1", AI_MAYOR_LIVE_MINUTES: String(remaining), AI_MAYOR_MODAL_BACKGROUND_WATCH: "1" },
  });
  childExited = false;
  cleanExit = false;
  child.on("exit", (code, signal) => { childExited = true; cleanExit = code === 0 && signal === null; event("RUN_PROCESS_EXITED", { code, signal }); });
  child.on("message", (message: { k?: string; name?: string; ok?: boolean; answer?: string }) => {
    const now = Date.now();
    if (message.k === "cycle") watch.note({ cycle: true }, now);
    else if (message.k === "call" && message.name) watch.note({ call: { name: message.name, ok: message.ok === true, ...(message.answer !== undefined ? { answer: message.answer } : {}) } }, now);
  });
  watch.started(Date.now());
  event("RUN_STARTED", { pid: child.pid, run: runs, minutesLeft: remaining });
}

function stopChild(): void {
  if (!child || childExited || !child.pid) return;
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

async function waitUntilGone(): Promise<boolean> {
  const deadline = Date.now() + STOP_WAIT_MS;
  while (!childExited && Date.now() < deadline) await sleep(200);
  return childExited;
}

/** The Bridge must be ready and idle before the next run starts; a busy one clears itself. A running world is taken over as it is (not paused, not cancelled). */
async function waitUntilReady(): Promise<boolean> {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (mayStartRun(await probe()).ok) return true;
    await sleep(1_000);
  }
  return false;
}

async function recover(decision: StallDecision): Promise<void> {
  event("RESTARTING", { state: decision.state, reason: decision.reason, stalledMs: decision.stalledForMs });
  stopChild();
  if (!(await waitUntilGone())) { event("RESTART_BLOCKED", { reason: "the old run process did not exit; no second run is started beside it" }); return; }
  if (!(await waitUntilReady())) { event("RESTART_BLOCKED", { reason: "the Bridge did not become ready, idle and paused in time; looked at again next second" }); return; }
  watch.restarted(Date.now());
  launch();
}

async function main(): Promise<void> {
  event("SUPERVISOR_STARTED", { minutes: totalMinutes, restartOnPausedIdle });
  if (!(await waitUntilReady())) event("START_WAITING", { reason: "the Bridge is not ready, idle and paused; starting anyway when it is" });
  while (!(await waitUntilReady())) await sleep(2_000);
  launch();
  let lastReportedState = "";
  while (Date.now() - startedAt < totalMinutes * 60_000 + 60_000) {
    await sleep(LOOK_EVERY_MS);
    if (childExited && cleanExit) { event("RUN_ENDED", { reason: "the run process ended on its own with exit code 0 (its minutes are up, or it stopped itself); not restarted" }); break; }
    const decision = watch.decide(Date.now(), await probe(), { childAlive: !childExited, restartOnPausedIdle });
    if (decision.action === "RESTART") { await recover(decision); continue; }
    if (decision.action === "REPORT" && decision.state !== lastReportedState) event(decision.state, { reason: decision.reason, stalledMs: decision.stalledForMs });
    if (decision.state === "PROGRESSING" && lastReportedState !== "PROGRESSING" && lastReportedState !== "") event("RESUMED", { after: lastReportedState });
    lastReportedState = decision.state;
  }
  stopChild();
  event("SUPERVISOR_STOPPED");
}

main().catch((error) => { event("SUPERVISOR_FAILED", { error: String(error) }); process.exit(1); });
