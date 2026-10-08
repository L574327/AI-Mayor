// Quality baseline collector (read-only): samples the city through the game Bridge while the Mayor runs, until N game days have passed.
//   node scripts/ai-mayor-dev/baseline.mjs --days 90 --every 30 --out baseline-new-save.csv
// Start the Mayor separately (scripts/ai-mayor-dev/stress-host.ts); this script only reads.
import fs from "node:fs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const days = Number(arg("days", "90"));
const every = Number(arg("every", "30")) * 1000;
const out = arg("out", `baseline-${new Date().toISOString().slice(0, 10)}.csv`);
const base = process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642";
const get = async (path) => { const response = await fetch(`${base}${path}`); return response.json(); };
const dayNumber = (text) => { const m = /^(\d+)-(\d+)-(\d+)/.exec(text ?? ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 : null; };

const header = ["wallTime", "gameDateTime", "gameDays", "population", "money", "monthlyBalance", "cityFlowPercent", "iconsTotal", "topIcons", "electricityProduction", "electricityConsumption", "waterCapacity", "waterConsumption", "refusals"];
fs.writeFileSync(out, header.join(",") + "\n");
let startDay = null;
for (;;) {
  try {
    const overview = await get("/city/overview");
    const budget = await get("/city/budget");
    const traffic = await get("/city/traffic");
    const services = await get("/city/services");
    const notes = await get("/city/notifications?limit=1");
    const day = dayNumber(overview.gameDateTime);
    if (startDay === null && day !== null) startDay = day;
    const counts = Object.entries(notes.countsByType ?? {}).filter(([type]) => !/Leveling|Level Up/.test(type));
    const total = counts.reduce((sum, [, count]) => sum + Number(count), 0);
    const top = counts.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([type, count]) => `${type}=${count}`).join(";");
    let refusals = 0;
    try { refusals = fs.readFileSync(process.env.AI_MAYOR_REFUSALS_LOG ?? "", "utf8").split("\n").filter(Boolean).length; } catch { /* no log */ }
    const row = [new Date().toISOString(), overview.gameDateTime, day === null ? "" : (day - startDay).toFixed(2), overview.population, overview.money, budget.balance, traffic.cityFlowPercent?.toFixed(1),
      total, `"${top}"`, services.electricity?.production, services.electricity?.consumption, services.water?.freshCapacity, services.water?.freshConsumption, refusals];
    fs.appendFileSync(out, row.join(",") + "\n");
    if (day !== null && day - startDay >= days) break;
  } catch (error) { fs.appendFileSync(out, `# ${new Date().toISOString()} read failed: ${String(error).slice(0, 80)}\n`); }
  await new Promise((resolve) => setTimeout(resolve, every));
}
console.log(`done: ${out}`);