/**
 * THE MAYOR ENGINE — the product's own run process (a child of the desktop app, started and watched by `mayor-supervisor.ts`).
 *
 * It is the recipe that was measured live for days (`scripts/ai-mayor-continuous-growth-live.ts`), without the acceptance run's budgets and evidence
 * files: the game's MCP server over stdio, the in-memory durable ledger (the world is the authority, a restart re-reads it), the BALANCED profile, the
 * real Brain through `singleTick`, one tick after another. It reports progress (each finished call, each cycle) so the supervisor can tell a working
 * Mayor from a stuck one, and the city's readings so the console can show them. It never loads or rolls back a save.
 *
 * Pause means: no new tick starts (the game itself keeps running). A tick in flight finishes first; the phase says PAUSING until it has.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts, setDecisionListener } from "../main-adapters";
import { MayorRuntime } from "../runtime";
import { createMemoryDurableStateStorage } from "../v2/durability";
import { parseV2McpJson } from "../v2/main-adapter";
import { parseObjectiveProfile } from "../v2/objective-profile";
import type { AcceptedRevision } from "../semantic-compiler/types";
import { type ProtectedArea, protection } from "../v2/protection";
import { type Funds, poorAtTakeover, SpendGuard, SpendGuardRefusal, spendGuardConfigFrom, spends } from "../v2/spend-guard";
import { type Line as NarratedLine, narrateCycle, narrateFinance, type NarratorLang } from "./mayor-narrator";
import { type CityDistrict, FORBID_KINDS, type ForbidKind, type Instruction, type Lowered, lowerInstruction, mergeProtectedAreas } from "./intent-lowering";
import { type CitySnapshot, type EngineMessage, ENGINE_ENV, type HostMessage, readPermissions } from "./protocol";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const send = (message: EngineMessage) => { try { process.send?.(message); } catch { /* the supervisor is gone: nothing to tell */ } };

const serverPath = process.env[ENGINE_ENV.serverPath];
const dataDir = process.env[ENGINE_ENV.dataDir] ?? path.join(process.cwd(), "ai-mayor-data");
const permissions = readPermissions(process.env[ENGINE_ENV.permissions]);
const SNAPSHOT_EVERY_MS = 5_000;
/** How long the Mayor rests after a cycle that decided to wait, before it looks again. */
const WAIT_CYCLE_REST_MS = 10_000;
const WAIT_FOR_GAME_EVERY_MS = 3_000;

// The permissions are read where they apply (runtime and district builder), from the environment of this process.
process.env.AI_MAYOR_ALLOW_LAND = permissions.allowLand ? "1" : "0";
process.env.AI_MAYOR_ALLOW_ECONOMY = permissions.allowEconomy ? "1" : "0";
process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS = permissions.preservePlayerAssets ? "1" : "0";
// The milestone popup is watched for the whole session (the live recipe).
process.env.AI_MAYOR_MODAL_BACKGROUND_WATCH = "1";

let paused = process.env[ENGINE_ENV.startPaused] === "1";
let stopping = false;
let runtime: MayorRuntime | null = null;
const queuedCommands: Array<Extract<HostMessage, { k: "command" }>> = [];
let drainCommands: () => Promise<void> = async () => undefined;
let clearLimits: () => void = () => undefined;
/** The last cycle's outcome (BUILD / WAIT / ...), from the decision row, and how many player instructions were handled. */
let lastOutcome: string | null = null;
let commandsHandled = 0;

process.on("message", (raw: unknown) => {
  const message = raw as HostMessage;
  if (message.k === "pause") { paused = true; send({ k: "phase", phase: "PAUSING" }); }
  else if (message.k === "resume") { paused = false; send({ k: "phase", phase: "RUNNING" }); }
  else if (message.k === "stop") { stopping = true; }
  else if (message.k === "command") { queuedCommands.push(message); void drainCommands(); }
  else if (message.k === "clear-limits") clearLimits();
});

async function main(): Promise<void> {
  if (!serverPath || !fs.existsSync(serverPath)) {
    send({ k: "phase", phase: "FAILED", detail: `the game connector (MCP server) is missing: ${serverPath ?? "(not set)"}` });
    process.exit(2);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  send({ k: "phase", phase: "STARTING" });
  const client = new Client({ name: "ai-mayor-engine", version: "1.0.0" });
  // The server runs on this same executable (Electron in node mode in the packaged app, node in development).
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1" } }));

  const forbidden = new Set(["cs2_load_game", "cs2_rollback"]);
  // The spending fuse (`v2/spend-guard.ts`): set once the city is known; every call that costs money passes through it, whoever makes it.
  let fuse: SpendGuard | null = null;
  let ensureFuse: () => Promise<void> = async () => undefined;
  const invoke = async (name: string, args: Obj, signal?: AbortSignal): Promise<Obj> => {
    try {
      const result = obj(parseV2McpJson(await client.callTool({ name, arguments: args }, undefined, { signal })));
      send({ k: "call", name, ok: true });
      return result;
    } catch (error) {
      send({ k: "call", name, ok: false, answer: String(error instanceof Error ? error.message : error).slice(0, 200) });
      throw error;
    }
  };
  const call = async (name: string, args: Obj = {}, signal?: AbortSignal): Promise<Obj> => {
    if (forbidden.has(name)) throw new Error(`FORBIDDEN_TOOL:${name}`);
    if (spends(name, args)) {
      if (!fuse) await ensureFuse();
      // No reference yet (the treasury cannot be read): nothing is spent blind.
      if (!fuse) { const refusal = new SpendGuardRefusal(`${name}: the treasury could not be read, so no reference for the fuse yet`); send({ k: "call", name, ok: false, answer: refusal.message.slice(0, 200) }); throw refusal; }
      try { return await fuse.run(name, () => invoke(name, args, signal)); } catch (error) {
        if (error instanceof SpendGuardRefusal) {
          send({ k: "call", name, ok: false, answer: error.message.slice(0, 200) });
          // The player can read what the fuse stopped (and why) beside the Mayor's other files.
          try { fs.appendFileSync(path.join(dataDir, "spend-guard-refusals.log"), `${new Date().toISOString()} ${error.message}\n`, "utf8"); } catch { /* the refusal stands without the log */ }
        }
        throw error;
      }
    }
    return invoke(name, args, signal);
  };
  const look = async (name: string, args: Obj = {}): Promise<Obj> => { try { return await call(name, args); } catch { return {}; } };
  // The treasury, the game frame and the monthly budget (the budget is hourly-updated by the game: read at most once a minute).
  let budgetRead: { at: number; balance: number | null; expenses: number | null } = { at: 0, balance: null, expenses: null };
  const readFunds = async (): Promise<Funds | null> => {
    try {
      const overview = await invoke("cs2_city_overview", {});
      const money = num(overview.treasury) ?? num(overview.money);
      if (money === null) return null;
      if (Date.now() - budgetRead.at > 60_000) {
        const budget = await invoke("cs2_budget", {}).catch(() => ({} as Obj));
        const expenses = num(budget.totalExpenses);
        budgetRead = { at: Date.now(), balance: num(budget.balance), expenses: expenses === null ? null : Math.abs(expenses) };
      }
      return { money, frame: num(overview.treasuryFrame), monthlyBalance: budgetRead.balance, monthlyExpenses: budgetRead.expenses };
    } catch { return null; }
  };

  // The first seconds are never silent: before any event exists the subtitle already says where the Mayor is and what it is about to do.
  const openingZh = process.env.AI_MAYOR_LANG !== "en";
  const sayNow = (zh: string, en: string) => send({ k: "commentary", text: openingZh ? zh : en, tone: "info" });
  sayNow("先确认游戏里的城市加载完、没在忙，再读国库、人口和地图上的问题图标，看哪类最多就先动哪类。", "First checking the city is loaded and idle, then reading the treasury, the population and the problem icons: the biggest group gets handled first.");
  // The city must be loaded, ready and idle before the Mayor touches it. Until then the engine only looks, every few seconds.
  let worldId = "";
  let waitedSaid = false;
  for (;;) {
    if (stopping) process.exit(0);
    const game = await look("cs2_game_state");
    const world = obj(game.world);
    if (game.gameMode === "Game" && game.cityLoaded === true && game.isLoading === false && world.worldReady === true && world.nativeOperationBusy === false) {
      worldId = String(world.worldId ?? "");
      break;
    }
    if (!waitedSaid) { waitedSaid = true; sayNow("游戏里还没有加载好的城市，没东西可读，等它加载完再开始。", "No city is loaded yet, so there is nothing to read; waiting for it to finish loading."); }
    send({ k: "phase", phase: "WAITING_FOR_GAME", detail: game.gameMode ? "waiting for a city to finish loading" : "waiting for Cities: Skylines II and the AI Mayor mod" });
    await sleep(WAIT_FOR_GAME_EVERY_MS);
  }

  {
    const overview = await look("cs2_city_overview");
    const people = num(overview.population); const cash = num(overview.money) ?? num(overview.treasury);
    const counts = Object.entries(obj(obj(await look("cs2_notifications", { limit: 1 })).countsByType)).map(([type, count]) => [type, Number(count)] as const)
      .filter(([type, count]) => Number.isFinite(count) && count > 0 && !/^(Fire Notification|Leveling Building|Building Level Up)$/.test(type)).sort((x, y) => y[1] - x[1]).slice(0, 3);
    const ICON_ZH: Record<string, string> = { "Noise Pollution": "噪音", "Garbage Notification": "垃圾", "No Customers": "没客人", "Air Pollution": "空气污染", "Ground Pollution": "地面污染", Abandoned: "废弃建筑",
      "No Road Access": "没接上路", "No Car Access": "车进不去", "No Pedestrian Access": "人行不通", "Dead End": "断头路", "Traffic Bottleneck Notification": "交通瓶颈", "Electricity Notification": "没电",
      "Water Notification": "没水", "Sewage Notification": "污水", "Powerline Not Connected": "电线没接", "Pipeline Not Connected": "水管没接", "Fire Notification": "火灾", "Hearse Notification": "灵车", "Ambulance Notification": "救护车",
      MissingEducatedWorkers: "缺高学历工人", MissingUneducatedWorkers: "缺普通工人", "No Train Access": "火车通道" };
    const top = counts.map(([type, count]) => `${openingZh ? (ICON_ZH[type] ?? type) : type} ${count}`).join("、");
    sayNow(`“${String(overview.cityName ?? "")}”：${people !== null ? `人口 ${people.toLocaleString("zh-CN")}，` : ""}${cash !== null ? `国库 ${Math.round(cash).toLocaleString("zh-CN")}，` : ""}${top ? `图标最多的是 ${top}，` : "地图上暂时没读到问题图标，"}先备份存档，再从最多的那类开始。`,
      `"${String(overview.cityName ?? "")}": ${people !== null ? `population ${people.toLocaleString("en-US")}, ` : ""}${cash !== null ? `treasury ${Math.round(cash).toLocaleString("en-US")}, ` : ""}${top ? `most common icons: ${top}; ` : "no problem icons read yet; "}backing up the save, then starting with the biggest group.`);
  }
  // A takeover starts with the player's own backup: a separate save, confirmed written, never one of the rotating checkpoints.
  // The backup runs at every takeover, and also for any city this app has no backup of yet (an engine started some other way never touches a city unbacked).
  const backupsFile = path.join(dataDir, "backups.json");
  let backups: Obj = {};
  try { backups = obj(JSON.parse(fs.readFileSync(backupsFile, "utf8"))); } catch { /* none yet */ }
  if (process.env[ENGINE_ENV.backupFirst] === "1" || !obj(backups[worldId]).name) {
    send({ k: "phase", phase: "BACKING_UP" });
    const name = `AI Mayor backup ${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    let ok = false;
    let detail = "";
    try {
      // The same native save protocol the checkpoints use (main-adapters `checkpointSave`): submitted, then polled by its request id to a terminal state.
      const submitted = await call("cs2_save_game", { name });
      if (typeof submitted.saveRequestId !== "string" || submitted.status !== "SUBMITTED") detail = `not accepted: ${String(submitted.status ?? submitted.error ?? "UNKNOWN")}`;
      else {
        for (let attempt = 0; attempt < 90; attempt += 1) {
          await sleep(1_000);
          const status = await look("cs2_save_status", { requestId: submitted.saveRequestId });
          if (status.status === "COMPLETED") { ok = true; detail = "saved"; break; }
          if (status.status === "FAILED" || status.status === "UNKNOWN") { detail = String(status.error ?? status.status); break; }
        }
        if (!ok && !detail) detail = "the save did not finish within 90 s";
      }
    } catch (error) { detail = error instanceof Error ? error.message : String(error); }
    if (ok) { backups[worldId] = { name, at: new Date().toISOString() }; try { fs.writeFileSync(backupsFile, JSON.stringify(backups, null, 2), "utf8"); } catch { /* the save itself is the backup */ } }
    send({ k: "backup", ok, name, detail });
    if (ok) sayNow("备份写好了，接下来读道路和建筑的细节，找出具体是哪几栋、卡在哪。", "Backup written; next I read the roads and buildings to find which ones are stuck and why.");
    if (!ok) {
      send({ k: "phase", phase: "FAILED", detail: `the backup save could not be confirmed (${detail.slice(0, 120)}); the Mayor does not take over without it` });
      process.exit(3);
    }
  }

  // The spending fuse. The reference is the funds the Mayor took this city over with (set at a takeover, kept across restarts of this process);
  // the player's own settings (`spend-guard.json`: mode OFF, fractions) are read from the same file and win over the defaults. When the treasury cannot
  // be read yet, spending is refused and the fuse is set up again at the next spending call (see `call`).
  ensureFuse = async (): Promise<void> => {
    if (fuse) return;
    const guardFile = path.join(dataDir, "spend-guard.json");
    let store: Obj = {};
    try { store = obj(JSON.parse(fs.readFileSync(guardFile, "utf8"))); } catch { /* first run */ }
    const references = obj(store.references);
    const funds = await readFunds();
    const known = obj(references[worldId]);
    if (funds && (process.env[ENGINE_ENV.backupFirst] === "1" || num(known.money) === null)) {
      references[worldId] = { money: funds.money, poor: poorAtTakeover(funds), at: new Date().toISOString() };
      try { fs.writeFileSync(guardFile, JSON.stringify({ ...store, references }, null, 2), "utf8"); } catch { /* the fuse still runs from memory */ }
    }
    const reference = obj(references[worldId]);
    const config = spendGuardConfigFrom(obj(store.settings), process.env);
    if (num(reference.money) !== null) {
      fuse = new SpendGuard(num(reference.money)!, reference.poor === true, readFunds, config);
      send({ k: "phase", phase: "STARTING", detail: `spending fuse: ${config.mode}, floor ${Math.round(fuse.floor)}, ${Math.round(fuse.hourlyCap)} per game hour${fuse.poor ? " (poor city: stands down)" : ""}` });
    }
  };
  await ensureFuse();
  // What survives a restart of this process (facilities it placed, districts it zoned), only for the same world.
  process.env.AI_MAYOR_BUILDER_MEMORY_FILE = path.join(dataDir, "builder-memory.json");
  process.env.AI_MAYOR_BUILDER_MEMORY_KEY = worldId;
  // The recorders (write-only: they never decide anything) keep what each construction call and each facility-road try came to, per install, so the experience that
  // a later ranking could learn from accumulates from the first run. Capped in size by the adapters.
  process.env.AI_MAYOR_TELEMETRY_FILE ??= path.join(dataDir, "execution-telemetry.jsonl");
  process.env.AI_MAYOR_EXPERIENCE_FILE ??= path.join(dataDir, "access-experience.jsonl");
  // The experience that tunes the order of repair candidates (`v2/experience-book.ts`): one per player, kept across saves.
  process.env.AI_MAYOR_EXPERIENCE_BOOK ??= path.join(dataDir, "experience-book.json");
  // The subtitle: facts of each cycle as sentences (`mayor-narrator.ts`), in the language the player last spoke; a line is not repeated within 10 minutes.
  let narrationLang: NarratorLang = process.env.AI_MAYOR_LANG === "en" ? "en" : "zh";
  const saidAt = new Map<string, number>();
  let lastSpokeAt = 0;
  let surveyLines = 0;
  const speak = (lines: readonly NarratedLine[]) => {
    const now = Date.now();
    for (const line of lines) {
      const said = saidAt.get(`${line.key}|${line.text}`);
      if (said !== undefined && now - said < 10 * 60_000) continue;
      saidAt.set(`${line.key}|${line.text}`, now);
      lastSpokeAt = now;
      send({ k: "commentary", text: line.text, tone: line.tone });
    }
    if (saidAt.size > 500) for (const [key, at] of saidAt) if (now - at > 10 * 60_000) saidAt.delete(key);
  };
  setDecisionListener((row) => {
    try {
      const parsed = obj(JSON.parse(row));
      speak(narrateCycle({ notes: Array.isArray(parsed.notes) ? (parsed.notes as unknown[]).map(String) : [],
        waitReason: typeof parsed.waitReason === "string" ? parsed.waitReason : null, status: typeof parsed.status === "string" ? parsed.status : null }, narrationLang));
      if (typeof parsed.outcome === "string") lastOutcome = parsed.outcome;
      send({ k: "decision", data: { at: new Date().toISOString(), status: typeof parsed.status === "string" ? parsed.status : null,
        outcome: typeof parsed.outcome === "string" ? parsed.outcome : null, waitReason: typeof parsed.waitReason === "string" ? parsed.waitReason : null,
        elapsedMs: num(parsed.elapsedMs), notes: Array.isArray(parsed.notes) ? (parsed.notes as unknown[]).map(String).slice(0, 120) : [] } });
    } catch { /* not a row this host reads */ }
  });

  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `engine--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Obj }) => ({ content: [{ type: "text", text: JSON.stringify(await call(name, args)) }] }),
  };
  const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager as never,
    durableStateStorage: createMemoryDurableStateStorage(),
    emit: (event, state) => {
      if (event !== "status") return;
      const text = String(state.lastStatus ?? "");
      send({ k: "status", text, tick: Number(state.tickCount ?? 0) });
      const finance = narrateFinance(text, narrationLang);
      if (finance) speak([finance]);
      // A survey takes tens of seconds with no event: say what it is doing at the start and again while it goes on, so the subtitle never goes quiet.
      if (/surveying the next district/i.test(text)) {
        speak([{ key: "survey", tone: "info", text: narrationLang === "zh" ? "在量下一片地：读路网、找空地、看哪里接得上，这一步要几十秒。" : "Surveying the next stretch: reading the roads, finding free ground, checking what can be joined; this takes tens of seconds." }]);
        const mark = lastSpokeAt;
        setTimeout(() => { if (lastSpokeAt !== mark || stopping) return; const more = narrationLang === "zh"
            ? ["还在读：逐块试这些空地能不能通路、离住宅够不够远。", "游戏对每块地都要先预检一遍，慢但不会白花钱。", "路网和空地对完了就动手，这轮没有符合条件的会直接说为什么。"]
            : ["Still reading: trying each free spot for road access and distance from homes.", "The game pre-checks every spot first: slow, but nothing is spent for nothing.", "Once roads and free ground are matched I act; if nothing qualifies I will say why."];
          send({ k: "commentary", text: more[surveyLines++ % more.length]!, tone: "info" }); }, 12_000);
      }
    },
    emitMayorCommentary: (line) => send({ k: "commentary", text: String((line as { text?: unknown }).text ?? ""), tone: String((line as { tone?: unknown }).tone ?? "") }) });
  // The Brain spends nothing on a model provider: balance is not a gate.
  ports.getBalance = async () => ({ isAvailable: true, currency: "CNY", totalBalance: 10_000, grantedBalance: 0, toppedUpBalance: 10_000, fetchedAt: new Date().toISOString() });
  // A stop of this process must not write a save of its own (the rotating checkpoints and the takeover backup are the saves).
  ports.save = async () => { throw new Error("ENGINE_STOP_DOES_NOT_SAVE"); };

  // The player's limits (protected districts, forbidden operations) for this world, kept across restarts of the engine and of the app.
  const limitsFile = path.join(dataDir, "instructions.json");
  type Limits = { revision: AcceptedRevision | null; protectedAreas: ProtectedArea[]; overrides: Lowered["permissions"]; expansionHeld?: boolean; targetPopulation?: number | null };
  let limits: Limits = { revision: null, protectedAreas: [], overrides: {} };
  let generation = 0;
  try {
    const stored = obj(obj(JSON.parse(fs.readFileSync(limitsFile, "utf8")))[worldId]);
    if (Array.isArray(stored.protectedAreas)) limits = { revision: (stored.revision as AcceptedRevision | null) ?? null,
      protectedAreas: stored.protectedAreas as ProtectedArea[], overrides: obj(stored.overrides) as Lowered["permissions"],
      expansionHeld: stored.expansionHeld === true, targetPopulation: num(stored.targetPopulation) };
  } catch { /* no limits recorded yet */ }
  // A change in Settings is the player's latest word on the three permissions Settings shows; the districts they asked to keep and the spoken
  // "don't rezone / don't change the roads" (no switch in Settings) stay.
  const permissionsChanged = process.env[ENGINE_ENV.permissionsChanged] === "1";
  if (permissionsChanged) {
    const { keepZoning, keepRoads } = limits.overrides;
    limits = { ...limits, overrides: { ...(keepZoning ? { keepZoning } : {}), ...(keepRoads ? { keepRoads } : {}) } };
  }
  const saveLimits = () => {
    try {
      let all: Obj = {};
      try { all = obj(JSON.parse(fs.readFileSync(limitsFile, "utf8"))); } catch { /* first write */ }
      all[worldId] = { ...limits, savedAt: new Date().toISOString() };
      fs.writeFileSync(limitsFile, JSON.stringify(all, null, 2));
    } catch { /* the limits still apply for this session */ }
  };
  // A player's limit only ever narrows the takeover permissions: "no loans" switches economy off, it never switches anything on.
  const applyLimits = () => {
    protection.set(limits.protectedAreas);
    const effective = { ...permissions };
    if (limits.overrides.allowLand === false) effective.allowLand = false;
    if (limits.overrides.allowEconomy === false) effective.allowEconomy = false;
    if (limits.overrides.preservePlayerAssets === true) effective.preservePlayerAssets = true;
    process.env.AI_MAYOR_ALLOW_LAND = effective.allowLand ? "1" : "0";
    process.env.AI_MAYOR_ALLOW_ECONOMY = effective.allowEconomy ? "1" : "0";
    process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS = effective.preservePlayerAssets ? "1" : "0";
    process.env.AI_MAYOR_KEEP_ZONING = limits.overrides.keepZoning === true ? "1" : "0";
    process.env.AI_MAYOR_KEEP_ROADS = limits.overrides.keepRoads === true ? "1" : "0";
    send({ k: "limits", protectedAreas: limits.protectedAreas.map((area) => area.name), permissions: effective,
      keepZoning: limits.overrides.keepZoning === true, keepRoads: limits.overrides.keepRoads === true,
      expansionHeld: limits.expansionHeld === true, targetPopulation: limits.targetPopulation ?? null });
  };
  const readDistricts = async (): Promise<CityDistrict[]> => {
    const listed = await look("cs2_list_districts");
    return (Array.isArray(listed.districts) ? (listed.districts as unknown[]) : []).map(obj).flatMap((row) => {
      const entity = obj(row.entity);
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (num(entity.index) === null || !name) return [];
      const outline = (Array.isArray(row.outline) ? (row.outline as unknown[]) : []).map(obj)
        .flatMap((point) => (num(point.x) === null || num(point.z) === null ? [] : [{ x: num(point.x)!, z: num(point.z)! }]));
      return [{ key: `district:${num(entity.index)}`, name, outline }];
    });
  };
  applyLimits();
  if (permissionsChanged) saveLimits();
  clearLimits = () => { limits = { revision: null, protectedAreas: [], overrides: {}, expansionHeld: limits.expansionHeld, targetPopulation: limits.targetPopulation }; applyLimits(); saveLimits(); };

  runtime = new MayorRuntime(ports);
  runtime.setObjectiveProfile(parseObjectiveProfile(process.env.AI_MAYOR_PROFILE ?? "BALANCED") ?? parseObjectiveProfile("BALANCED")!);
  // What the player said about growth (held, a target population) outlives a restart of the engine, like their limits.
  if (limits.expansionHeld) runtime.holdExpansion(true);
  if (limits.targetPopulation) runtime.setGrowthSettings({ stabilizationPopulation: limits.targetPopulation });
  runtime.start({ goal: "Autonomous mayor", maxSessionSpend: 10, minimumBalance: 0, decisionMode: "local", continuous: false, speed: "fast", tickDelayMs: 0,
    localMayorStageTimeoutMs: 6 * 60_000 });
  send({ k: "phase", phase: paused ? "PAUSED" : "RUNNING" });

  let lastSnapshotAt = 0;
  const snapshot = async () => {
    lastSnapshotAt = Date.now();
    const game = await look("cs2_game_state");
    const overview = await look("cs2_city_overview");
    const services = await look("cs2_city_services");
    const icons = await look("cs2_notifications", { limit: 500 });
    const budget = await look("cs2_budget");
    const traffic = await look("cs2_traffic", { limit: 5, minVolume: 50 });
    const sim = obj(game.simulation);
    const electricity = obj(services.electricity);
    const water = obj(services.water);
    const counts = obj(icons.countsByType);
    const data: CitySnapshot = {
      readAt: new Date().toISOString(),
      cityName: typeof game.cityName === "string" ? game.cityName : null,
      worldId: typeof obj(game.world).worldId === "string" ? String(obj(game.world).worldId) : worldId || null,
      gameDateTime: typeof sim.gameDateTime === "string" ? sim.gameDateTime : null,
      gamePaused: typeof sim.paused === "boolean" ? sim.paused : null,
      gameSpeed: num(sim.selectedSpeed),
      population: num(overview.population),
      treasury: num(overview.treasury),
      monthlyBalance: num(budget.balance) ?? num(overview.monthlyBalance),
      milestone: num(overview.milestoneLevel),
      xp: num(overview.xp),
      nextMilestoneXp: num(overview.nextMilestoneXp),
      electricity: Object.keys(electricity).length > 0 ? { production: num(electricity.production), consumption: num(electricity.consumption) } : null,
      water: Object.keys(water).length > 0 ? { capacity: num(water.freshCapacity), consumption: num(water.freshConsumption) } : null,
      traffic: num(traffic.cityFlowPercent) === null ? null : { flowPercent: num(traffic.cityFlowPercent)!,
        worst: (Array.isArray(traffic.worst) ? (traffic.worst as unknown[]) : []).map(obj).map((row) => ({ position: { x: num(obj(row.position).x) ?? 0, z: num(obj(row.position).z) ?? 0 },
          prefab: typeof row.prefab === "string" ? row.prefab : null, flowPercent: num(row.flowPercent) ?? 0, volume: num(row.volume) ?? 0, wear: num(row.wear) ?? 0 })) },
      icons: Object.fromEntries(Object.entries(counts).map(([type, count]) => [type, Number(count) || 0])),
      iconsTruncated: Array.isArray(icons.notifications) && (icons.notifications as unknown[]).length >= 500,
    };
    send({ k: "snapshot", data });
  };

  // Instructions are answered as they arrive, not after the tick in flight (a tick can run for minutes): the limits apply at once, the goal is
  // pending until the Mayor's next decision. One at a time, in order.
  let draining = false;
  drainCommands = async () => {
    if (draining || !runtime) return;
    draining = true;
    try { for (let command = queuedCommands.shift(); command; command = queuedCommands.shift()) await handleCommand(runtime, command); }
    finally { draining = false; }
  };
  const handleCommand = async (runtime: MayorRuntime, command: Extract<HostMessage, { k: "command" }>) => {
    commandsHandled += 1;
    if (command.lang === "zh" || command.lang === "en") narrationLang = command.lang;
    try {
      // The host builds the instruction from the local reader or a checked AI reply; it is still checked here, field by field, so a malformed one
      // (an older console, a bug) is refused or trimmed instead of reaching the compiler.
      const raw = obj(command.instruction);
      const isGoal = (value: unknown) => !!value && typeof value === "object" && typeof obj(value).type === "string";
      const instruction: Instruction = {
        goal: (isGoal(raw.goal) ? raw.goal : null) as Instruction["goal"],
        goals: (Array.isArray(raw.goals) ? raw.goals : []).filter(isGoal).slice(0, 3) as NonNullable<Instruction["goals"]>,
        ...(raw.growth === "PAUSE" || raw.growth === "RESUME" ? { growth: raw.growth } : {}),
        ...(num(raw.targetPopulation) !== null ? { targetPopulation: num(raw.targetPopulation)! } : {}),
        forbid: (Array.isArray(raw.forbid) ? raw.forbid : []).filter((kind): kind is ForbidKind => (FORBID_KINDS as readonly unknown[]).includes(kind)),
        preserve: (Array.isArray(raw.preserve) ? raw.preserve : []).filter((name): name is string => typeof name === "string" && name.trim().length > 0).map((name) => name.trim().slice(0, 60)).slice(0, 12),
        unsupported: (Array.isArray(raw.unsupported) ? raw.unsupported : []).filter((item): item is string => typeof item === "string").slice(0, 12),
      };
      if (!instruction.goal && !instruction.goals?.length && !instruction.growth && instruction.targetPopulation === undefined && instruction.forbid.length === 0 && instruction.preserve.length === 0) {
        send({ k: "command-result", id: command.id, ok: false, detail: "nothing in this instruction the Mayor can act on", notes: instruction.unsupported });
        return;
      }
      const hasLimits = instruction.forbid.length > 0 || instruction.preserve.length > 0;
      // Districts are read only when the player named one (the read is the world's current outlines, never a cached copy).
      const districts = instruction.preserve.length > 0 ? await readDistricts() : [];
      const overview = hasLimits ? await look("cs2_city_overview") : {};
      const lower = (previous: AcceptedRevision | null) => lowerInstruction({ instruction, districts, session: worldId, generation: generation += 1,
        population: num(overview.population), cash: num(overview.treasury), previous, updateId: command.id, lang: command.lang });
      let lowered = lower(limits.revision);
      // A revision from an earlier load can name district entities the game has since renumbered: start a fresh revision.
      if (!lowered.accepted && limits.revision) {
        const fresh = lower(null);
        if (fresh.accepted) lowered = fresh;
      }
      if (hasLimits && lowered.accepted) {
        // Measured live 2026-10-06: "keep A and B" followed by "no loans" left NO area protected before areas were merged.
        const areas = mergeProtectedAreas(limits.protectedAreas, lowered.protectedAreas);
        limits = { revision: lowered.revision, protectedAreas: areas, overrides: { ...limits.overrides, ...lowered.permissions } };
        applyLimits();
        saveLimits();
      }
      // Growth first (a "stop expanding" holds before anything else of the sentence runs), then the city problems, then the one building goal:
      // the care goal sets the care focus and clears the pending goal, so the building goal goes last to stay pending.
      if (lowered.accepted && (lowered.growth || lowered.targetPopulation !== null)) {
        if (lowered.growth) { runtime.holdExpansion(lowered.growth === "PAUSE"); limits = { ...limits, expansionHeld: lowered.growth === "PAUSE" }; }
        if (lowered.targetPopulation !== null) { runtime.setGrowthSettings({ stabilizationPopulation: lowered.targetPopulation }); limits = { ...limits, targetPopulation: lowered.targetPopulation }; }
        saveLimits();
        applyLimits();
      }
      if (lowered.careGoal) runtime.setPendingUserCommand({ text: command.text, source: "text", structuredIntent: lowered.careGoal });
      if (lowered.buildGoal) runtime.setPendingUserCommand({ text: command.text, source: "text", structuredIntent: lowered.buildGoal });
      const acted = lowered.careGoal !== null || lowered.buildGoal !== null;
      const detail = acted ? (runtime.getState()?.lastStatus ?? "accepted") : lowered.growth || lowered.targetPopulation !== null ? "growth setting recorded" : lowered.accepted ? "limits recorded" : "not accepted";
      send({ k: "command-result", id: command.id, ok: lowered.accepted || acted, detail, notes: lowered.notes });
      if (lowered.accepted || acted) speak([{ key: `command:${command.id}`, tone: "info", text: narrationLang === "zh"
        ? `收到指令“${command.text.slice(0, 40)}”${lowered.notes[0] ? `：${lowered.notes[0].slice(0, 80)}` : ""}` : `Instruction received: "${command.text.slice(0, 40)}"${lowered.notes[0] ? ` — ${lowered.notes[0].slice(0, 80)}` : ""}` }]);
    } catch (error) {
      send({ k: "command-result", id: command.id, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  let wasPaused = paused;
  while (!stopping) {
    await drainCommands();
    if (Date.now() - lastSnapshotAt >= SNAPSHOT_EVERY_MS) await snapshot();
    if (paused) {
      if (!wasPaused) send({ k: "phase", phase: "PAUSED" });
      wasPaused = true;
      send({ k: "cycle" }); // paused on purpose is not a stall
      await sleep(1_000);
      continue;
    }
    if (wasPaused) { wasPaused = false; send({ k: "phase", phase: "RUNNING" }); }
    lastOutcome = null;
    const handledBefore = commandsHandled;
    const state = await runtime.singleTick();
    send({ k: "cycle" });
    if (state.status !== "running") {
      send({ k: "phase", phase: "STOPPED", detail: state.stopReason ?? state.lastStatus ?? "the session ended" });
      break;
    }
    // A cycle that decided to wait (nothing to build now, no land to buy) is not repeated at once: measured live 2026-10-06, a city out of land
    // ran a full world read every 7 s for nothing. The pause ends early for a player instruction, a pause or a stop.
    if (lastOutcome === "WAIT") {
      const until = Date.now() + WAIT_CYCLE_REST_MS;
      while (Date.now() < until && !stopping && !paused && queuedCommands.length === 0 && commandsHandled === handledBefore) {
        if (Date.now() - lastSnapshotAt >= SNAPSHOT_EVERY_MS) await snapshot();
        send({ k: "cycle" }); // resting on purpose is not a stall
        await sleep(1_000);
      }
    }
  }
  try { await runtime.stop("Engine stopping"); } catch { /* already stopped */ }
  // Stopped by the player: the city is handed back running at normal speed (the runtime's stop leaves the world paused, which looked like a frozen game).
  if (stopping) await look("cs2_set_simulation", { paused: false, speed: 1 });
  await client.close().catch(() => undefined);
  send({ k: "phase", phase: "STOPPED", detail: stopping ? "stopped by the player" : "the session ended" });
  process.exit(0);
}

main().catch((error) => {
  send({ k: "phase", phase: "FAILED", detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
