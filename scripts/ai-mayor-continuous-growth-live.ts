/**
 * Live acceptance for the continuous city-growth Brain.
 *
 * Unlike `ai-mayor-continuous-utility-zoning-live.ts`, which drives
 * `v2Gate1Progression.advanceToStage` directly, this runner drives the REAL
 * Brain: `MayorRuntime.runAutonomousConstructionCycle` through `singleTick`.
 * That difference is the whole point. Only the Brain records the progression
 * outcome on the active work order, closes a Goal whose chain has ended, admits
 * the successor a closed Goal requires, and re-derives the next Goal from fresh
 * world facts. A direct `advanceToStage` call does none of that, and it also
 * ignores the work order's own `completionStage`, so it can ask a Road-only
 * prerequisite tranche to zone — a failure the product path never produces.
 *
 * Bounded on purpose: a tick count, per-tool native budgets, and a hard refusal
 * of save / load / rollback. Nothing here authors a durable write itself; every
 * mutation is the product's own admission and execution path.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts } from "../src/main/services/ai-mayor/main-adapters";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { parseObjectiveProfile } from "../src/main/services/ai-mayor/v2/objective-profile";
import { MayorRuntime } from "../src/main/services/ai-mayor/runtime";

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Obj : {};

/** Native calls that change the world a player can see. */
const MUTATION_TOOLS = new Set([
  "cs2_build_road",
  "cs2_zone_area",
  "cs2_zoning",
  "cs2_place_building",
  "cs2_mayor_execute_actions",
  "cs2_purchase_tile",
]);

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-reconstruction\\mcp-server\\dist\\index.js";
const reportPath = process.env.AI_MAYOR_CONTINUOUS_EVIDENCE ?? "docs/ai-mayor/evidence/continuous-growth-loop-live.json";
const appData = process.env.APPDATA ?? "C:\\Users\\鏉庢坊妗俓\AppData\\Roaming";
// `AI_MAYOR_LIVE_MINUTES` bounds the run by the wall clock instead of by tick count: a tick is 1-25 s now, so a tick count says nothing about
// how long the run is. When set it wins over `AI_MAYOR_LIVE_TICKS` (kept as a large safety cap) and the action budgets scale with the minutes.
const liveMinutes = Number(process.env.AI_MAYOR_LIVE_MINUTES ?? 0);
const timedRun = Number.isFinite(liveMinutes) && liveMinutes > 0;
const TIMED_RUN_TICKS_PER_MINUTE = 30;
const tickBudget = timedRun ? 100_000 : Number(process.env.AI_MAYOR_LIVE_TICKS ?? 3);
const budgetTicks = timedRun ? Math.ceil(liveMinutes * TIMED_RUN_TICKS_PER_MINUTE) : tickBudget;
const REPORT_WRITE_INTERVAL_MS = 60_000;
const REPORT_NATIVE_CALLS_KEPT = 2_000;
const decisionBudget = Number(process.env.AI_MAYOR_LIVE_DECISION_BUDGET ?? 12);
const runSpeed = process.env.AI_MAYOR_LIVE_SPEED === "normal" ? "normal" as const : "fast" as const;
const reconcileOnly = process.env.AI_MAYOR_RECONCILE_ONLY === "1";

async function main() {
  // `AI_MAYOR_FRESH_LEDGER=1` starts a NEW durable lineage on the world that is
  // loaded right now, instead of inheriting the on-disk one.
  //
  // WHY A HOST SWITCH AND NOT A PRODUCT CHANGE. A save the store never
  // registered puts it in `DESCENDANT_CONFIRMATION_REQUIRED`: authority is
  // granted only by proving, per journal command, that the loaded world still
  // contains that command's effect (`main-adapter.ts:2851`, `durability.ts:1994`).
  // That is correct when the two agree and a hard refusal when they do not —
  // measured 2026-10-02 on this city: the loaded save has cell `75357:5#1` as
  // residential while the ledger's command `2b9e0719` zoned it industrial on
  // 2026-10-01, so all 222 inherited commands are unprovable and every write is
  // refused forever. Deliberately left alone: the quarantine is a durable public
  // invariant, and whether "player Loads an older save, product re-reads the
  // world and continues" should override it is a product ruling, not a
  // harness's to make.
  //
  // What this switch uses instead is the product's OWN first-run path: no
  // ledger for this world means `BASELINE_CHECKPOINT_REQUIRED`, the product
  // saves its own baseline tree and proceeds. The world stays the authority.
  const freshLedger = process.env.AI_MAYOR_FRESH_LEDGER === "1";
  const storage = freshLedger ? createMemoryDurableStateStorage() : createCanonicalDurableStateStorage(appData);
  const initial = storage.load();
  if (!initial && !freshLedger) throw new Error("ACTIVE_BRANCH_DURABLE_STATE_MISSING");
  const branchId = initial?.executionBranch?.branchId ?? null;
  if (freshLedger) console.warn("FRESH_LEDGER: starting a new durable lineage on the loaded world");

  const client = new Client({ name: "5ire-ai-mayor-continuous-growth", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  // Name, arguments and timing only. The result of every call used to be kept for the whole run (scans of 2,000 roads, terrain reads):
  // nothing reads it back, and the harness process grew to ~3 GB of the machine's commit memory, beside a game that needs it.
  const calls: Array<{ name: string; args: Obj; startedAtMs: number; elapsedMs: number }> = [];
  const counts: Record<string, number> = {};
  const commentary: Array<{ text: string; tone: string; emittedAt: string }> = [];
  // The road bound is the run's own budget, not a product limit, and a remote
  // access corridor spends several of them by itself: a 450 m corridor is four
  // to six bounded hops. At eight the previous acceptance run ended on
  // `LIVE_NATIVE_ACTION_BUDGET_EXCEEDED:cs2_build_road:8` rather than on a
  // refusal, so the scenario it was measuring was cut off, not answered.
  // The throughput question needs a run long enough to hold several mutations,
  // and the simulation budget is what bounds that: the Brain spends three
  // `cs2_run_simulation` calls per unresolved cycle. These are the run's own
  // bounds, not product limits, so they scale with `AI_MAYOR_LIVE_TICKS`.
  const tickBudgetForBudgets = budgetTicks;
  // The simulation bound is the one that actually caps a growth measurement:
  // every construction step that has to wait for the city spends simulated time,
  // and a city that is still bootstrapping spends far more of it than a running
  // one. `AI_MAYOR_LIVE_SIMULATION_BUDGET` overrides it alone, so a run can be
  // long enough to watch the pipeline move without also raising the tick count —
  // and a run that ends on this bound says so rather than looking idle.
  const simulationBudget = Number(process.env.AI_MAYOR_LIVE_SIMULATION_BUDGET ?? "") ||
    24 + 6 * tickBudgetForBudgets;
  // A district cycle lays ~10 streets and paints ~164 zoning brush spots in one tick (district builder,
  // 2026-10-03). The old per-tick bounds (8 + 2/tick zoning) cut the first district off at its 20th spot and the
  // run read as "zoning refused", so the bounds now scale with a whole district per tick.
  const max: Record<string, number> = {
    cs2_build_road: 24 + 90 * tickBudgetForBudgets, cs2_place_building: 6 + 2 * tickBudgetForBudgets,
    cs2_zone_area: 20 + 700 * tickBudgetForBudgets, cs2_zoning: 8 + 2 * tickBudgetForBudgets,
    cs2_mayor_execute_actions: 32 + 6 * tickBudgetForBudgets,
    cs2_purchase_tile: 2 * tickBudgetForBudgets,
    cs2_run_simulation: simulationBudget,
    // A BALANCED cycle resumes the city before and after each wait (three `paused:false` calls a tick), so 2 per tick no longer holds.
    cs2_set_simulation: timedRun ? 60 * liveMinutes + 40 : 8 + 2 * tickBudgetForBudgets,
    // The product establishes its own recovery and baseline boundaries, so
    // producing them is part of the path under test. Bounded like every other
    // native action, and each one writes a uniquely named Mayor save rather than
    // a player's.
    // A checkpoint is taken at most every 10 minutes (`CHECKPOINT_MIN_INTERVAL_MS`), plus the baseline.
    cs2_save_game: timedRun ? 4 + Math.ceil(liveMinutes / 10) + 4 : 8,
  };
  // Loading and rolling back still change the world underneath the run, which is
  // what an acceptance run must never do to itself. Saving does not.
  const forbidden = new Set(["cs2_load_game", "cs2_rollback"]);
  // Timing is part of the evidence: the acceptance question is what the wall
  // clock between two mutations was spent on, and that cannot be answered from
  // a call sequence alone. `startedAtMs` is relative to the run's own start so
  // the report is self-contained.
  const runStartedAtMs = Date.now();
  const call = async (name: string, args: Obj = {}, signal?: AbortSignal) => {
    if (forbidden.has(name)) throw new Error(`FORBIDDEN_LIVE_TOOL:${name}`);
    if (name in max) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (counts[name] > max[name]) throw new Error(`LIVE_NATIVE_ACTION_BUDGET_EXCEEDED:${name}:${max[name]}`);
    }
    const startedAtMs = Date.now() - runStartedAtMs;
    // Progress for the supervisor (scripts/ai-mayor-supervisor.ts): one small message per finished call, in memory on both sides, nothing written.
    // A busy answer is reported as such so that retrying a busy Bridge never counts as progress.
    let result: Obj;
    try { result = parseV2McpJson(await client.callTool({ name, arguments: args }, undefined, { signal })); }
    catch (error) { process.send?.({ k: "call", name, ok: false, answer: String(error instanceof Error ? error.message : error).slice(0, 200) }); throw error; }
    process.send?.({ k: "call", name, ok: true });
    calls.push({ name, args, startedAtMs, elapsedMs: Date.now() - runStartedAtMs - startedAtMs });
    return result;
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((t) => ({ name: `live--${t.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Obj }) => ({
      content: [{ type: "text", text: JSON.stringify(await call(name, args)) }],
    }),
  };

  /** What the durable store says about the Goal the Brain is working on. */
  const durableSummary = () => {
    const state = storage.load();
    if (!state) return { missing: true };
    const projectState: Obj = obj(state.projectState);
    const tranche: Obj = obj(projectState.tranche);
    const activeId = state.activeGoalWorkOrderId ?? null;
    const orders = (Array.isArray(state.goalWorkOrders) ? state.goalWorkOrders : []).map(obj);
    const active = orders.find((order) => order.workOrderId === activeId) ?? null;
    const activeState: Obj = obj(active?.state);
    const activeTranche: Obj = obj(activeState.tranche);
    return {
      journalPosition: state.journalPosition,
      activeGoalWorkOrderId: activeId,
      projectState: {
        schemaVersion: projectState.schemaVersion, status: obj(projectState.project).status,
        intentStatus: obj(projectState.intent).status, stage: tranche.stage,
        projectId: obj(projectState.project).id,
      },
      activeWorkOrder: active ? {
        goalId: active.goalId, status: active.status, parentGoalId: active.parentGoalId ?? null,
        completionStage: active.completionStage ?? null, releasedReservationAt: active.releasedReservationAt ?? null,
        projectStatus: obj(activeState.project).status, stage: activeTranche.stage,
      } : null,
      workOrderCount: orders.length,
      workOrders: orders.map((order) => ({
        goalId: order.goalId, status: order.status, projectId: order.projectId,
        releasedReservationAt: order.releasedReservationAt ?? null,
        stage: obj(obj(order.state).tranche).stage,
      })),
      tasks: (Array.isArray(projectState.tasks) ? projectState.tasks : []).map(obj).map((task) => ({
        kind: task.kind, status: task.status, attempts: task.attempts, activeCommandId: task.activeCommandId ?? null,
      })),
    };
  };

  const report: Obj = { mode: "PRODUCTION_CONTINUOUS_GROWTH_BRAIN", serverPath, branchId, actionBudgets: max,
    tickBudget, liveMinutes: timedRun ? liveMinutes : null, decisionBudget, runSpeed, startedAt: new Date().toISOString() };
  let ports: ReturnType<typeof createMainMayorPorts> | undefined;
  try {
    const beforeGame = obj(await call("cs2_game_state"));
    const beforeWorld = obj(beforeGame.world);
    const beforeSim = obj(beforeGame.simulation);
    report.worldBefore = { gameMode: beforeGame.gameMode, cityLoaded: beforeGame.cityLoaded, isLoading: beforeGame.isLoading,
      worldId: beforeWorld.worldId, generation: beforeWorld.generation, checkpointId: beforeWorld.checkpointId,
      worldReady: beforeWorld.worldReady, nativeOperationBusy: beforeWorld.nativeOperationBusy,
      nativeOperationStage: beforeWorld.nativeOperationStage, paused: beforeSim.paused, frameIndex: beforeSim.frameIndex };
    if (beforeGame.gameMode !== "Game" || beforeGame.cityLoaded !== true || beforeGame.isLoading !== false ||
      beforeWorld.worldReady !== true || beforeWorld.nativeOperationBusy !== false ||
      beforeWorld.nativeOperationStage !== "Idle") {
      // (2026-10-05) A running world is taken over as it is: the product reads the world it finds, it does not need the player to pause first.
      throw new Error("LIVE_WORLD_NOT_READY_AND_IDLE");
    }
    // The builder's bookkeeping that a restart of this process would lose (facilities it placed, districts it zoned, sites that got no road) is kept in one small
    // file, overwritten whole, and only used for the same world: a different save has a different identity and starts clean.
    if (!process.env.AI_MAYOR_BUILDER_MEMORY_FILE) process.env.AI_MAYOR_BUILDER_MEMORY_FILE = "tmp/builder-memory.json";
    process.env.AI_MAYOR_BUILDER_MEMORY_KEY = String(beforeWorld.worldId ?? "");
    report.namespaceId = storage.namespaceId;
    report.durableBefore = durableSummary();

    // The Brain announces its own reason for every phase change on `status`
    // ("V2 Brain building:" when a construction task it can execute is pending,
    // "Autonomous Brain letting the city run:" when only the world can produce
    // the next fact). That is the product's own answer to "was there executable
    // work right now", so the run records it with a timestamp instead of
    // inferring it afterwards.
    const statusTimeline: Array<{ atMs: number; status: string }> = [];
    report.statusTimeline = statusTimeline;
    // The builder's whole reasoning for every cycle (waitReason, feasibility, survey gates, notes), one JSON row each. Read by the ports at creation,
    // so it is set first. Evidence only: nothing reads it back.
    if (!process.env.AI_MAYOR_DECISION_FILE) {
      process.env.AI_MAYOR_DECISION_FILE = `tmp/decisions-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    }
    fs.mkdirSync(path.dirname(process.env.AI_MAYOR_DECISION_FILE), { recursive: true });
    report.decisionFile = process.env.AI_MAYOR_DECISION_FILE;
    ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager as never,
      durableStateStorage: storage,
      emit: (event, state) => {
        if (event !== "status") return;
        statusTimeline.push({ atMs: Date.now() - runStartedAtMs, status: String(state.lastStatus ?? "") });
      },
      emitMayorCommentary: (line) => commentary.push(line),
      gate1MaximumDecisions: decisionBudget });
    if (!ports.v2Gate1Progression || !ports.v2ProductionSkillRuntime) throw new Error("PRODUCTION_V2_PORTS_UNAVAILABLE");
    // The Brain spends nothing on a model provider, so balance is not a gate here.
    ports.getBalance = async () => ({ isAvailable: true, currency: "CNY", totalBalance: 10_000,
      grantedBalance: 0, toppedUpBalance: 10_000, fetchedAt: new Date().toISOString() });
    if (process.env.AI_MAYOR_DISABLE_SIMULATION === "1") {
      report.simulationDisabled = true;
      ports.runSimulation = async () => { throw new Error("SHORT_LIVE_SIMULATION_DISABLED"); };
      ports.observeRunningSimulation = ports.runSimulation;
    }
    // A live acceptance run must not save, and `#finalize` saves. Refuse it here
    // so an accidental stop reports a refusal instead of writing a save.
    ports.save = async () => { throw new Error("LIVE_GROWTH_RUN_FORBIDS_SAVE"); };

    if (reconcileOnly) {
      // Activation is the product's existing restart-reconciliation primitive.
      // Ask the already-reached ROAD_DELIVERED milestone so this path activates
      // and reconciles durable commands without starting a new construction tick.
      const reconciliation = await ports.v2Gate1Progression.advanceToStage("ROAD_DELIVERED");
      report.reconciliationOnly = true;
      report.reconciliation = reconciliation;
      report.durableAfter = durableSummary();
      const reconciledState = storage.load();
      report.commandsAfter = (reconciledState?.commands ?? []).slice(-8).map((entry) => ({
        commandId: entry.record.commandId,
        actionFamily: entry.record.actionFamily,
        actionType: entry.record.actionType,
        exactInput: (entry.record.authorizedScope as unknown as { exactInput?: string }).exactInput ?? null,
        status: entry.record.status,
        reconciliationStatus: entry.record.reconciliationStatus,
        latestEvidence: entry.record.observationEvidence.at(-1) ?? null,
      }));
      report.authoritativeGameState = await call("cs2_game_state");
      report.nativeCallCounts = counts;
      report.nativeCalls = calls.map(({ name, args, startedAtMs, elapsedMs }) => ({ name, args, startedAtMs, elapsedMs }));
      report.finishedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ reportPath, reconciliation: {
        status: reconciliation.status, stage: reconciliation.stage, reason: reconciliation.reason,
      }, nativeCallCounts: counts, durableAfter: obj(report.durableAfter).activeWorkOrder }));
      return;
    }

    const runtime = new MayorRuntime(ports);
  // Which gameplay objective this run pursues (see v2/objective-profile.ts). Unset: the Mayor as it always was.
  { const profile = parseObjectiveProfile(process.env.AI_MAYOR_PROFILE); if (profile) runtime.setObjectiveProfile(profile); }
    runtime.start({ goal: "Continuous city growth", maxSessionSpend: 10, minimumBalance: 0,
      decisionMode: "local", continuous: false, speed: runSpeed, tickDelayMs: 0,
      // The acceptance question is what the wall clock between two mutations was
      // spent on, so the runtime publishes its own per-stage trace into the tick
      // state. Evidence only: it changes no control flow.
      stageTrace: true,
      // The live adapter gives one simulated hour a minimum five-minute
      // operation budget. Keep the Brain's outer stage watchdog above that
      // bound, or the runtime cancels a still-authorized simulation at 150 s
      // before the adapter can return its own bounded result.
      localMayorStageTimeoutMs: 6 * 60_000 });

    const ticks: Obj[] = [];
    report.ticks = ticks;
    // The whole report used to be rewritten after EVERY tick, with every native call (a `cs2_game_state` poll a second) and every tick so far:
    // quadratic in the run's length, and a 120-minute run would spend more and more of its wall clock (and memory, beside the game) on it.
    // Now each tick is appended as one NDJSON row (the full record, written once), the whole report is written at most once a minute, and the
    // report carries the newest calls and per-tick records without their bulky lists.
    const ticksPath = `${reportPath}.ticks.ndjson`;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(ticksPath, "", "utf8");
    report.ticksFile = ticksPath;
    let lastReportWriteAt = 0;
    const writeReport = (finished: boolean, force = false) => {
      if (!finished && !force && Date.now() - lastReportWriteAt < REPORT_WRITE_INTERVAL_MS) return;
      lastReportWriteAt = Date.now();
      report.finishedAt = finished ? new Date().toISOString() : null;
      report.nativeCallCounts = counts;
      const aggregate: Record<string, { calls: number; ms: number }> = {};
      for (const { name, elapsedMs } of calls) {
        const entry = aggregate[name] ?? (aggregate[name] = { calls: 0, ms: 0 });
        entry.calls += 1;
        entry.ms += elapsedMs;
      }
      report.nativeCallAggregate = aggregate;
      report.nativeCallsTotal = calls.length;
      report.nativeCalls = calls.slice(-REPORT_NATIVE_CALLS_KEPT).map(({ name, args, startedAtMs, elapsedMs }) => ({ name, args, startedAtMs, elapsedMs }));
      report.ticks = ticks.map(({ nativeCalls: _names, stageTrace: _trace, ...rest }) => rest);
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    };
    const runStartedWall = Date.now();
    let commentarySeen = 0;
    for (let tick = 1; tick <= tickBudget; tick += 1) {
      if (timedRun && Date.now() - runStartedWall >= liveMinutes * 60_000) { report.stoppedBy = `LIVE_MINUTES_REACHED:${liveMinutes}`; break; }
      const before = durableSummary();
      const startedAt = Date.now();
      const callsBefore = calls.length;
      const state = await runtime.singleTick();
      const after = durableSummary();
      ticks.push({ tick, elapsedMs: Date.now() - startedAt,
        status: state.status, localMayorStatus: state.localMayorStatus ?? null, lastStatus: state.lastStatus ?? null,
        projectBefore: before.projectState, projectAfter: after.projectState,
        activeBefore: before.activeWorkOrder, activeAfter: after.activeWorkOrder,
        workOrderCountBefore: before.workOrderCount, workOrderCountAfter: after.workOrderCount,
        tasksAfter: after.tasks, journalPositionBefore: before.journalPosition, journalPositionAfter: after.journalPosition });
      // Evidence only. The machine froze several times beside this run; memory is one thing that can be read (the game once died of exhausted
      // commit memory, and a harness once grew to 3 GB). This script's own footprint and the system's free memory, once a tick.
      (ticks[ticks.length - 1] as Obj).memory = { harnessRssMb: Math.round(process.memoryUsage().rss / 1048576),
        harnessHeapMb: Math.round(process.memoryUsage().heapUsed / 1048576), systemFreeMb: Math.round(os.freemem() / 1048576), wallSeconds: Math.round((Date.now() - runStartedWall) / 1000) };
      (ticks[ticks.length - 1] as Obj).fastExpansionMetrics = state.fastExpansionMetrics ?? null;
      // The run ledger is the run's own answer to "why did the city not keep
      // growing", so a live acceptance has to carry it, not just the durable
      // work-order counters.
      // The ledger's entries are the run's whole history so far, so a copy per tick is quadratic; the tick carries its own (newest) entry, which is
      // all the tempo summary reads (first and last facts).
      const ledger = obj(state.runLedger);
      (ticks[ticks.length - 1] as Obj).runLedger = state.runLedger
        ? { ...ledger, entries: Array.isArray(ledger.entries) ? (ledger.entries as Obj[]).slice(-1) : [] } : null;
      // Which native calls this tick actually made, so the tempo report can say
      // when the first visible change landed rather than only that some did.
      (ticks[ticks.length - 1] as Obj).nativeCalls = calls.slice(callsBefore).map(({ name }) => name);
      // Names alone cannot say what a generic executor DID. `cs2_mayor_execute_actions`
      // carries zone, road and building work alike, so the per-tick record keeps
      // the arguments too and the tempo report reads the effect from the action.
      // Only the mutation calls, and only the fields a product metric needs: the
      // whole call list with its arguments is already in `report.nativeCalls`,
      // and duplicating it per tick made the evidence file unusable (244 MB).
      (ticks[ticks.length - 1] as Obj).nativeCallDetails = calls.slice(callsBefore)
        .filter((entry) => MUTATION_TOOLS.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          elapsedMs: entry.elapsedMs,
          actions: (Array.isArray(obj(entry.args).actions) ? (obj(entry.args).actions as Obj[]) : [])
            .map((action) => ({ type: action.type ?? null, radius: action.radius ?? null })),
        }));
      // The runtime's own stage trace is the only record of what it was doing
      // while the wall clock passed, so the tick carries it whole.
      (ticks[ticks.length - 1] as Obj).stageTrace = state.localMayorStageTrace ?? null;
      (ticks[ticks.length - 1] as Obj).llmDecisionCalls = state.telemetryTotals.apiRequestCount;
      (ticks[ticks.length - 1] as Obj).commentary = commentary.slice(commentarySeen);
      commentarySeen = commentary.length;
      // Appended after every tick (one row, written once): a long cycle that has to be stopped still leaves the evidence of what it did before it
      // was stopped. The whole report follows at most once a minute (see `writeReport`).
      fs.appendFileSync(ticksPath, `${JSON.stringify(ticks[ticks.length - 1])}\n`, "utf8");
      process.send?.({ k: "cycle" });
      writeReport(false);
      // Keep going while the Brain is still moving the city; a session that has
      // halted itself for a repeated identical failure has nothing more to show.
      if (state.status !== "running") break;
    }
    report.sessionStatus = { status: runtime.getSessionStatus().status, lastError: runtime.getSessionStatus().lastError ?? null };
    report.durableAfter = durableSummary();
    report.authoritativeGameState = await call("cs2_game_state");
    report.cityOverview = await call("cs2_city_overview");
    report.mayorSnapshot = await call("cs2_mayor_snapshot");
    // The product outcome a player would judge the run by, read once at the end
    // from the city itself rather than from what the Brain believed it did.
    // "Served" is operationalised the only way the game states it: a building
    // carrying no consumer-service warning.
    {
      const snapshot = obj(report.mayorSnapshot);
      const warnings = obj(snapshot.warnings);
      const topTypes = Array.isArray(warnings.topTypes) ? (warnings.topTypes as Obj[]) : [];
      const countOf = (needle: string) =>
        Number(topTypes.find((entry) => String(entry.type ?? "").includes(needle))?.count ?? 0);
      const overview = obj(report.cityOverview);
      report.productOutcome = {
        population: overview.population ?? null,
        populationWithMoveIn: overview.populationWithMoveIn ?? null,
        unservedElectricityBuildings: countOf("Electricity Notification"),
        unservedWaterBuildings: countOf("Water Notification"),
        unservedSewageBuildings: countOf("Sewage Notification"),
        totalWarnings: Number(warnings.total ?? 0),
        utilities: obj(snapshot.utilities),
      };
    }
    report.commentary = commentary;
    report.llmDecisionCalls = ticks.reduce((sum, tick) => sum + Number(tick.llmDecisionCalls ?? 0), 0);
    // Product tempo. "Tests green" cannot speak for what a player sees, so the
    // run reports the things a player would judge it by: when the first visible
    // change landed, how many there were and of what kind, and how long the city
    // stood still.
    {
      const perTick = ticks.map((tick) => ({
        names: (tick.nativeCalls as string[] | undefined) ?? [],
        details: (tick.nativeCallDetails as Array<{ name?: string; args?: unknown; elapsedMs?: number }> | undefined) ?? [],
        elapsedMs: Number(tick.elapsedMs ?? 0),
      }));
      const mutates = (tick: (typeof perTick)[number]) => tick.names.some((name) => MUTATION_TOOLS.has(name));
      const byType: Record<string, number> = {};
      for (const tick of perTick) {
        for (const name of tick.names) if (MUTATION_TOOLS.has(name)) byType[name] = (byType[name] ?? 0) + 1;
      }
      // What a mutation call ACTUALLY changed, read from the action it carried.
      //
      // `cs2_mayor_execute_actions` is a generic executor: it carries zone, road
      // and building work alike. Counting the whole call as "facility" is how a
      // measured run reported `zoningApplies=0, facilityApplies=1` while its own
      // action read `type:"zone"` — a metric that cannot tell zoning from a
      // building cannot answer "is this city zoning", so every product number
      // below is derived from the action rather than the tool name.
      const effectKinds = (call: { name?: string; actions?: Array<{ type?: unknown }> }): string[] => {
        const name = call.name ?? "";
        if (name === "cs2_build_road") return ["road"];
        if (name === "cs2_zone_area" || name === "cs2_zoning") return ["zoning"];
        if (name === "cs2_place_building") return ["facility"];
        if (name === "cs2_mayor_execute_actions") {
          const actions = Array.isArray(call.actions) ? call.actions : [];
          if (actions.length === 0) return ["facility"];
          return actions.map((action) =>
            action.type === "zone" ? "zoning"
              : action.type === "build_road" ? "road"
                : action.type === "place_building" ? "facility" : "other");
        }
        return [];
      };
      const mutationCalls = perTick.flatMap((tick) => tick.details)
        .filter((call) => MUTATION_TOOLS.has(call.name ?? ""));
      const effects: Record<string, number> = {};
      for (const call of mutationCalls) {
        for (const kind of effectKinds(call)) effects[kind] = (effects[kind] ?? 0) + 1;
      }
      // The requested zoning footprint: a zone action carries its own bounding
      // circle, so the cells asked for are pi*r^2. It is the REQUEST, not a
      // readback of what the game accepted, and it is labelled as such.
      const zoningCellsRequested = mutationCalls
        .flatMap((call) => (Array.isArray(call.actions) ? call.actions : []))
        .filter((action) => action.type === "zone")
        .reduce((sum, action) => sum + Math.PI * Number(action.radius ?? 0) ** 2, 0);
      const constructionCallMs = mutationCalls.reduce((sum, call) => sum + Number(call.elapsedMs ?? 0), 0);
      const allCallMs = perTick.flatMap((tick) => tick.details)
        .reduce((sum, call) => sum + Number(call.elapsedMs ?? 0), 0);
      const callsByTool: Record<string, { calls: number; ms: number }> = {};
      for (const call of perTick.flatMap((tick) => tick.details)) {
        const name = call.name ?? "(unnamed)";
        const entry = callsByTool[name] ?? (callsByTool[name] = { calls: 0, ms: 0 });
        entry.calls += 1;
        entry.ms += Number(call.elapsedMs ?? 0);
      }
      const mutatedTicks = perTick.filter(mutates);
      const totalMs = perTick.reduce((sum, tick) => sum + tick.elapsedMs, 0);
      let elapsedToFirst = 0;
      for (const tick of perTick) {
        elapsedToFirst += tick.elapsedMs;
        if (mutates(tick)) break;
      }
      const ledgerEntries = ticks.flatMap((tick) => {
        const ledger = obj(tick.runLedger);
        return Array.isArray(ledger.entries) ? (ledger.entries as Obj[]) : [];
      });
      const factsAt = (index: number) => obj(obj(ledgerEntries.at(index)).facts);
      const firstFacts = ledgerEntries.length > 0 ? factsAt(0) : {};
      const lastFacts = ledgerEntries.length > 0 ? factsAt(-1) : {};
      report.tempo = {
        wallclockMs: totalMs,
        ticks: perTick.length,
        timeToFirstVisibleMutationMs: mutatedTicks.length > 0 ? elapsedToFirst : null,
        visibleMutationCount: Object.values(byType).reduce((sum, count) => sum + count, 0),
        visibleMutationsByType: byType,
        // With no mutation at all the entire run was idle; otherwise it is the
        // longest tick that delivered nothing, which is the visible stall.
        longestVisibleIdleMs: mutatedTicks.length === 0
          ? totalMs
          : perTick.reduce((worst, tick) => (mutates(tick) ? worst : Math.max(worst, tick.elapsedMs)), 0),
        simulationRunCalls: calls.filter(({ name }) => name === "cs2_run_simulation").length,
        // The four product metrics, read from the action each call carried rather
        // than from the tool name. See `effectKinds` above for why the tool name
        // is not the effect: `cs2_mayor_execute_actions` is generic.
        roadSegments: effects.road ?? 0,
        zoningActions: effects.zoning ?? 0,
        zoningCellsRequested: Math.round(zoningCellsRequested),
        facilityActions: effects.facility ?? 0,
        otherMutationActions: effects.other ?? 0,
        mutationsByTool: byType,
        constructionCallMs: Math.round(constructionCallMs),
        allCallMs: Math.round(allCallMs),
        constructionShareOfCallTime: allCallMs > 0 ? Number((constructionCallMs / allCallMs).toFixed(4)) : 0,
        constructionShareOfWallclock: totalMs > 0 ? Number((constructionCallMs / totalMs).toFixed(4)) : 0,
        callsByTool,
        populationBefore: firstFacts.population ?? null,
        populationAfter: lastFacts.population ?? null,
        treasuryBefore: firstFacts.treasury ?? null,
        treasuryAfter: lastFacts.treasury ?? null,
        sessionStatus: report.sessionStatus,
      };
    }
    writeReport(true);
    // The tick list is in the report and the NDJSON file; the console gets a one-line summary per tick, not the records.
    console.log(JSON.stringify({ reportPath, ticksFile: ticksPath, stoppedBy: report.stoppedBy ?? null,
      ticks: ticks.map((entry) => ({ tick: entry.tick, elapsedMs: entry.elapsedMs, status: entry.status, lastStatus: String(entry.lastStatus ?? "").slice(0, 160) })).slice(-20),
      durableAfter: obj(report.durableAfter).projectState, nativeCallCounts: counts }));
  } finally {
    // No `runtime.stop()`: it finalizes, and finalizing saves. The city is left
    // paused exactly where the run left it.
    await client.close().catch(() => {});
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
