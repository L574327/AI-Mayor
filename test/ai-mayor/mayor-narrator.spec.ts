import { narrateCycle, narrateFinance, narrateNote, narrateSituation } from "../../src/main/services/ai-mayor/host/mayor-narrator";

describe("the language expressor: facts of a cycle as the player's sentences, never more than the facts", () => {
  test("what was done is said as done, with where", () => {
    expect(narrateNote("ruins: 6 of 6 abandoned collapsed building(s) taken down at the notice (6 stand); the zoned lots grow new ones", "zh")?.text).toMatch(/拆掉了 6 栋/);
    expect(narrateNote("road access: Medium Road 42 m laid to (-2757,2091) (nearest street)", "zh")?.text).toMatch(/\(-2757, 2091\).*42 米/);
    expect(narrateNote("power: 3 dark homes near (-347,1387): 1 generator(s) placed beside them; the icons are read again after 6 game hours", "zh")?.tone).toBe("done");
  });
  test("a change and its effect are different facts: a trial reports the measured flow and the verdict, never 'solved'", () => {
    const kept = narrateNote('traffic trial: flow 8% → 8% after "two heavy streams cross uncontrolled (486 and 260/day, both ": no worse, kept', "zh")!;
    expect(kept.text).toMatch(/8% → 8%.*没有变差，保留/);
    expect(kept.text).not.toMatch(/解决/);
    expect(narrateNote('traffic trial: flow 9% → 5% after "x": worse, reverted', "zh")!.text).toMatch(/已撤回/);
  });
  test("what is blocked says why", () => {
    expect(narrateNote("service garbage: icons: 45, but the runway does not carry another building", "zh")!.text).toMatch(/垃圾.*45.*钱/);
    expect(narrateNote("road access: no frontage road the game accepts to (-2757,2091) (6 course(s) dry-run; the game said: REJECT:operation blocked by game validation (overlap, wat x6)", "zh")!.text).toMatch(/接不上路.*6 种走法/);
  });
  test("bookkeeping is not said", () => {
    expect(narrateNote("pipeline: bottleneck NONE (no usable labour reading)", "zh")).toBeNull();
    expect(narrateNote("telemetry: ROAD 0 ok/1 refused", "zh")).toBeNull();
  });
  test("a cycle: done first, then blocked, then why it waits; at most three", () => {
    const lines = narrateCycle({ notes: ["service garbage: icons: 45, but the runway does not carry another building",
      "ruins: 2 of 2 abandoned building(s) taken down at the notice (2 stand); the zoned lots grow new ones"], waitReason: "EXPANSION_HELD_BY_PLAYER" }, "zh");
    expect(lines.map((line) => line.tone)).toEqual(["done", "blocked", "info"]);
    expect(lines[2]!.text).toMatch(/按你的指令暂停扩张/);
  });
  test("a finance step: the action in words and its judged verdict", () => {
    expect(narrateFinance("V2 finance recovery RECOVERING: TRIM_SERVICE_BUDGET budget:Electricity:55: KEEP (Electricity upkeep -227370/month) | balance -168256/month", "zh")!.text)
      .toMatch(/电力预算降到 55%.*保留/);
    expect(narrateFinance("V2 finance recovery RECOVERING: RAISE_TAX tax:Industrial:11: UNDO (asset-loss icons 32→35) | undone", "zh")!.text).toMatch(/工业税调到 11%.*撤回/);
  });
  test("the gap the growth policy read is said with its numbers, and nothing is said for a note that carries none", () => {
    const jobs = narrateNote("pipeline: bottleneck JOBS (unemployment 48% (350 people), 5 of 137 jobs open (3.6%): fewer open jobs than people out of work); paused: residential", "zh")!;
    expect(jobs.text).toMatch(/350 人.*48%.*137.*5/);
    expect(narrateNote("pipeline: policy chose industrial for JOBS", "zh")).toBeNull();
    expect(narrateNote("industry: no site 400 m from every home; the next search keeps 260 m", "zh")!.text).toMatch(/400.*260/);
  });
  test("a waiting reason names what the city lacks; a built district says its size, not a fixed sentence", () => {
    expect(narrateCycle({ notes: [], waitReason: "NO_USABLE_JOBS_SUPPLY" }, "zh")[0]!.text).toMatch(/缺岗位/);
    const built = narrateCycle({ notes: ["V2 S0 medium | capital-bound batch 1751792 m2"], status: "BUILT" }, "zh")[0]!.text;
    expect(built).toMatch(/175 公顷/);
  });
  test("the situation lines carry the figures of the moment, so they differ whenever the city does", () => {
    const base = { population: 459, targetPopulation: 100000, previousPopulation: null, treasury: 629252, monthlyBalance: -73699, unemploymentPct: 47.7, jobsFree: 5, jobsTotal: 137, demand: { residential: 8, commercial: 0, industrial: 100 } };
    const first = narrateSituation(base, "zh");
    const later = narrateSituation({ ...base, population: 470, previousPopulation: 459 }, "zh");
    expect(first.map((l) => l.text).join("|")).toMatch(/失业率 48%.*工业需求条已拉满/);
    expect(later[0]!.text).not.toBe(first[0]!.text);
    expect(later[0]!.text).toMatch(/多了 11/);
    expect(first.find((l) => l.key === "sit-books")!.text).toMatch(/约撑 8 个月/);
  });});