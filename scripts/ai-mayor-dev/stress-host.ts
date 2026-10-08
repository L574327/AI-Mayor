/**
 * Stress host: the product's own supervisor running the PACKAGED engine + connector on the live city, driven by a control file.
 *   control.jsonl lines: {"op":"command","text":"..."} | {"op":"clear"} | {"op":"pause"} | {"op":"resume"} | {"op":"permissions", ...} | {"op":"stop"}
 *   events.jsonl: every decision (all notes), phase, command result, limits, supervision change, snapshot summary.
 */
import fs from "node:fs";
import path from "node:path";
import { MayorSupervisor } from "../../src/main/services/ai-mayor/host/mayor-supervisor";
import { parseInstruction } from "../../src/main/services/ai-mayor/host/intent-parser";

const dir = __dirname;
const out = path.join(dir, "stress");
fs.mkdirSync(out, { recursive: true });
const control = path.join(out, "control.jsonl");
const events = path.join(out, "events.jsonl");
if (!fs.existsSync(control)) fs.writeFileSync(control, "");
const t0 = Date.now();
const write = (kind: string, data: unknown) => fs.appendFileSync(events, `${JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString(), kind, data })}\n`);

// The repository root is two levels above this file.
const root = path.resolve(__dirname, "../..");
const release = path.join(root, "release", "win-unpacked");
// STRESS_SOURCE=1: the engine from source (node + tsx), the connector bundle staged for the installer; otherwise everything packaged.
const source = process.env.STRESS_SOURCE === "1";
const supervisor = new MayorSupervisor({
  execPath: source ? process.execPath : path.join(release, "AI Mayor.exe"),
  enginePath: source ? path.join(root, "src/main/services/ai-mayor/host/mayor-engine.ts") : path.join(release, "resources/app/mayor-engine.cjs"),
  serverPath: source ? path.join(root, "mayor-bundle/mcp-server/dist/index.js") : path.join(release, "resources/mayor/mcp-server/dist/index.js"), dataDir: path.join(out, "data"),
  log: (line, detail) => write("log", { line, detail }),
});

let last = { phase: "", cycleAt: "", supervision: "", limits: "", activity: 0, snapshotAt: 0, status: "", commentaryAt: "" };
supervisor.on("state", (state) => {
  if (state.phase !== last.phase) { last.phase = state.phase; write("phase", { phase: state.phase, detail: state.phaseDetail }); }
  if (state.status && state.status.text !== last.status) { last.status = state.status.text; write("status", state.status); }
  const sup = `${state.supervision.state}|${state.supervision.reason}|${state.supervision.restarts}`;
  if (sup !== last.supervision) { last.supervision = sup; write("supervision", state.supervision); }
  if (state.lastCycle && state.lastCycle.at !== last.cycleAt) { last.cycleAt = state.lastCycle.at; write("decision", state.lastCycle); }
  const limits = JSON.stringify({ p: state.protectedAreas, e: state.effectivePermissions, k: state.keep });
  if (limits !== last.limits) { last.limits = limits; write("limits", JSON.parse(limits)); }
  for (const event of state.activity.slice(last.activity)) write("activity", event);
  // The subtitle lines (the language expressor), as the console and the bar over the game show them.
  for (const line of state.commentary) if (line.at > (last.commentaryAt ?? "")) { write("commentary", line); last.commentaryAt = line.at; }
  last.activity = state.activity.length;
  if (state.snapshot && Date.now() - last.snapshotAt > 60_000) {
    last.snapshotAt = Date.now();
    const s = state.snapshot;
    write("snapshot", { date: s.gameDateTime, pop: s.population, money: s.treasury, balance: s.monthlyBalance, speed: s.gameSpeed, paused: s.gamePaused, traffic: s.traffic?.flowPercent });
  }
});

const langOf = (text: string): "zh" | "en" => (/[\u3400-\u9fff]/.test(text) ? "zh" : "en");
let consumed = 0;
let stopping = false;
const tick = async () => {
  const lines = fs.readFileSync(control, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(consumed)) {
    consumed += 1;
    let op: Record<string, unknown>;
    try { op = JSON.parse(line); } catch { write("control-error", line); continue; }
    write("control", op);
    if (op.op === "command") {
      const text = String(op.text ?? "");
      const parsed = parseInstruction(text);
      write("parsed", { text, understood: parsed.understood, summary: parsed.summary, instruction: parsed.instruction });
      if (!parsed.understood) continue;
      // Not awaited: several commands may be in flight at once (the stress case).
      void supervisor.command(text, parsed.instruction, langOf(text)).then((result) => write("command-result", { text, ...result }));
    } else if (op.op === "raw") {
      void supervisor.command(String(op.text ?? "raw"), op.instruction as never, "en").then((result) => write("command-result", { text: "raw", ...result }));
    } else if (op.op === "clear") write("clear", supervisor.clearLimits().protectedAreas);
    else if (op.op === "pause") supervisor.pause();
    else if (op.op === "resume") await supervisor.resumeOrStart();
    else if (op.op === "permissions") await supervisor.setPermissions({ allowLand: op.allowLand !== false, allowEconomy: op.allowEconomy !== false, preservePlayerAssets: op.preservePlayerAssets !== false });
    else if (op.op === "stop") { stopping = true; await supervisor.stop(); write("stopped", {}); process.exit(0); }
  }
};
setInterval(() => { if (!stopping) void tick().catch((error) => write("host-error", String(error))); }, 1_000);
write("start", { out });
void supervisor.takeOver({ allowLand: true, allowEconomy: true, preservePlayerAssets: false }).then(() => write("takeover-called", {}));
