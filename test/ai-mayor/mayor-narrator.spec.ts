import { facilityName, narrateCycle, narrateFinance, narrateNote, narrateSituation } from "../../src/main/services/ai-mayor/host/mayor-narrator";

const NOTES = [
  "ruins: 6 of 6 abandoned collapsed building(s) taken down at the notice (6 stand); the zoned lots grow new ones",
  "road access: Medium Road 42 m laid to (-2757,2091) (nearest street)",
  "power: 3 dark homes near (-347,1387): 1 generator(s) placed beside them; the icons are read again after 6 game hours",
  "road access: no frontage road the game accepts to (-2757,2091) (6 course(s) dry-run; the game said: REJECT:operation blocked by game validation (overlap, wat x6)",
  "road access: WaterPumpingStation01 at (-271,767) got no road after 4 tries; it was placed by this Mayor and is taken down",
  "service garbage: icons: 45, but the runway does not carry another building",
  "utility link: Low-voltage Ground Cable 84 m laid from (-445,-878) to the street for \"Powerline Not Connected\" on Low-voltage Ground Cable",
  'traffic trial: flow 8% → 8% after "two heavy streams cross uncontrolled (486 and 260/day, both ": no worse, kept',
  "noise: 5 noise icon(s) on homes; the nearest industry, EU_IndustrialManufacturing03 at (120,-40) 150 m from them, was taken down and its lot dezoned",
  "big service Landfill01: 3 of 3 building(s) taken down at (10,20) to make a 80 x 96 m room; it is placed once the ground reads free",
];

describe("the language expressor: few words, first person, the facts and their figures, never more", () => {
  test("what was done is said as done, with its figures", () => {
    expect(narrateNote(NOTES[0]!, "zh")?.text).toMatch(/拆掉了 6 栋/);
    expect(narrateNote(NOTES[1]!, "zh")?.text).toMatch(/42 米路/);
    expect(narrateNote(NOTES[2]!, "zh")?.tone).toBe("done");
    expect(narrateNote(NOTES[8]!, "zh")?.text).toMatch(/150 米的工厂.*拆了/);
    expect(narrateNote(NOTES[9]!, "zh")?.text).toMatch(/垃圾填埋场.*拆了 3 栋/);
  });
  test("no map coordinates and no internal building names ever reach the player", () => {
    for (const note of NOTES) for (const lang of ["zh", "en"] as const) {
      const text = narrateNote(note, lang)?.text ?? "";
      expect(text).not.toMatch(/\(-?\d+, ?-?\d+\)/);
      expect(text).not.toMatch(/WaterPumpingStation01|Landfill01|EU_Industrial/);
    }
    expect(narrateNote(NOTES[4]!, "zh")!.text).toMatch(/水泵站.*4 次/);
    expect(facilityName("WindTurbine01", "zh")).toBe("风力发电机");
    expect(facilityName("SomethingNew01", "zh")).toBe("设施");
  });
  test("a change and its effect are different facts: a trial reports the measured flow and the verdict, never 'solved'", () => {
    const kept = narrateNote(NOTES[7]!, "zh")!;
    expect(kept.text).toMatch(/8% → 8%.*没变差，留着/);
    expect(kept.text).not.toMatch(/解决/);
    expect(narrateNote('traffic trial: flow 9% → 5% after "x": worse, reverted', "zh")!.text).toMatch(/已撤回/);
  });
  test("what is blocked says why", () => {
    expect(narrateNote(NOTES[5]!, "zh")!.text).toMatch(/垃圾.*45.*养不起/);
    expect(narrateNote(NOTES[3]!, "zh")!.text).toMatch(/接不上路.*压到别的东西/);
  });
  test("bookkeeping is not said", () => {
    expect(narrateNote("pipeline: bottleneck NONE (no usable labour reading)", "zh")).toBeNull();
    expect(narrateNote("telemetry: ROAD 0 ok/1 refused", "zh")).toBeNull();
    expect(narrateNote("pipeline: policy chose industrial for JOBS", "zh")).toBeNull();
  });
  test("several things of one kind in a cycle are one sentence with the count", () => {
    const lines = narrateCycle({ notes: [NOTES[1]!, "road access: Small Road 12 m laid to (5,6) (nearest street)", "road access: Small Road 30 m laid to (7,8) (nearest street)"] }, "zh");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toMatch(/给 3 栋没通路的建筑接上了路/);
  });
  test("a cycle: done first, then blocked; two lines at most; a wait is one kind of line whatever its reason", () => {
    const lines = narrateCycle({ notes: [NOTES[5]!, "ruins: 2 of 2 abandoned building(s) taken down at the notice (2 stand); the zoned lots grow new ones"], waitReason: "EXPANSION_HELD_BY_PLAYER" }, "zh");
    expect(lines.map((line) => line.tone)).toEqual(["done", "blocked"]);
    const waiting = narrateCycle({ notes: [], waitReason: "EXPANSION_HELD_BY_PLAYER" }, "zh");
    expect(waiting[0]!.text).toMatch(/按你说的/);
    expect(waiting[0]!.key).toBe(narrateCycle({ notes: [], waitReason: "NO_USABLE_JOBS_SUPPLY" }, "zh")[0]!.key);
    expect(narrateCycle({ notes: [], waitReason: "NO_USABLE_JOBS_SUPPLY" }, "zh")[0]!.text).toMatch(/缺岗位/);
  });
  test("a built district says its size and its use, not a fixed sentence", () => {
    const built = narrateCycle({ notes: ["V2 S0 medium | capital-bound batch 1751792 m2", "district (-819.5,-1111.4) 360x160 residential: roads 7/7 landed, 0 refused; zones 38/42"], status: "BUILT" }, "zh")[0]!.text;
    expect(built).toMatch(/约 175 公顷的住宅区/);
  });
  test("the gap the growth policy read is said with its numbers; a narrower distance is said once with both figures", () => {
    expect(narrateNote("pipeline: bottleneck JOBS (unemployment 48% (350 people), 5 of 137 jobs open (3.6%): fewer open jobs than people out of work); paused: residential", "zh")!.text).toMatch(/350 人.*48%/);
    expect(narrateNote("industry: no site 400 m from every home; the next search keeps 260 m", "zh")!.text).toMatch(/400.*260/);
    expect(narrateNote("homes: no site 320 m from every polluter; the next search keeps 240 m", "zh")!.text).toMatch(/320.*240/);
  });
  test("a finance step: the action in words and its judged verdict", () => {
    expect(narrateFinance("V2 finance recovery RECOVERING: TRIM_SERVICE_BUDGET budget:Electricity:55: KEEP (Electricity upkeep -227370/month) | balance -168256/month", "zh")!.text)
      .toMatch(/电力预算降到 55%.*留着/);
    expect(narrateFinance("V2 finance recovery RECOVERING: RAISE_TAX tax:Industrial:11: UNDO (asset-loss icons 32→35) | undone", "zh")!.text).toMatch(/工业税调到 11%.*撤回/);
  });
  test("the situation lines carry the figures of the moment, so they differ whenever the city does", () => {
    const base = { population: 459, targetPopulation: 100000, previousPopulation: null, treasury: 629252, monthlyBalance: -73699, unemploymentPct: 47.7, jobsFree: 5, jobsTotal: 137, demand: { residential: 8, commercial: 0, industrial: 100 } };
    const first = narrateSituation(base, "zh");
    const later = narrateSituation({ ...base, population: 470, previousPopulation: 459 }, "zh");
    expect(first.map((line) => line.text).join("|")).toMatch(/失业 48%.*工业需求拉满/);
    expect(later[0]!.text).not.toBe(first[0]!.text);
    expect(later[0]!.text).toMatch(/多了 11/);
    expect(first.find((line) => line.key === "sit-books")!.text).toMatch(/能撑 8 个月/);
  });
});
