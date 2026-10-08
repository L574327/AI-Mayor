import { mayorControlOf, parseInstruction } from "../../src/main/services/ai-mayor/host/intent-parser";

// Paired Chinese / English instructions must give the same structured goal (the minimum bilingual acceptance of the UI handoff).
const pairs: Array<[string, string, Record<string, unknown>]> = [
  ["帮我发展人口", "Grow the population", { type: "GROW_POPULATION" }],
  ["扩建一些高密度住宅", "Build more high-density housing", { type: "EXPAND_RESIDENTIAL", scope: { density: "HIGH" } }],
  ["城市缺电了，马上解决供电", "We have a blackout, fix the power immediately", { type: "PROVIDE_SERVICE", scope: { serviceKind: "ELECTRICITY" }, priority: "HIGH" }],
  ["解决堵车问题", "Fix the traffic congestion", { type: "IMPROVE_TRAFFIC" }],
  ["在水边扩建商业区", "Expand commercial by the river", { type: "EXPAND_COMMERCIAL", scope: { region: "WATERFRONT" } }],
  ["扩建工业，不要买地", "Expand industry but don't buy land", { type: "EXPAND_INDUSTRIAL" }],
  ["保障医疗，有救护车问题", "Provide healthcare, ambulances are late", { type: "PROVIDE_SERVICE", scope: { serviceKind: "HEALTHCARE" } }],
  ["修一下路网", "Extend the road grid", { type: "ESTABLISH_ROAD_NETWORK" }],
  ["建一座过河的桥", "Build a bridge across the river", { type: "CONNECT_ACROSS_OBSTACLE" }],
  ["扩建住宅，可以买地", "Expand residential, buy more land if needed", { type: "EXPAND_RESIDENTIAL", scope: { acquireLand: true } }],
  ["有空的时候扩建办公", "Expand offices when you can, no rush", { type: "EXPAND_OFFICE", priority: "LOW" }],
  ["改造旧区", "Redevelop the old area", { type: "REDEVELOP_AREA" }],
];

describe("instruction reader (zh / en)", () => {
  it.each(pairs)("%s == %s", (zh, en, expected) => {
    const a = parseInstruction(zh);
    const b = parseInstruction(en);
    expect(a.understood).toBe(true);
    expect(b.understood).toBe(true);
    expect(a.intent).toMatchObject(expected);
    expect(b.intent).toMatchObject(expected);
    expect(a.intent).toEqual(b.intent);
  });

  it("hears growth however the player says it (说一就是一): expand, stop idling, buy land — never a hold, never traffic", () => {
    for (const said of ["直接扩展，不要发呆了", "给我动起来，别发呆", "不能建就买地，那么多空地", "把城市面积搞大", "给我扩张行吗？"]) {
      const read = parseInstruction(said);
      expect(read.understood).toBe(true);
      expect(read.confident).toBe(true);
      expect(read.intent?.type).toBe("GROW_POPULATION");
      expect(read.instruction.growth).toBe("RESUME");
    }
    expect(parseInstruction("不能建就买地，那么多空地").intent?.scope?.acquireLand).toBe(true);
  });

  it("the player can always halt the Mayor by voice, and set it going again; growth words and 'don't stop' are not a halt", () => {
    for (const said of ["市长停一下", "先停下", "停", "暂停", "别动了", "住手！", "mayor, stop", "pause"]) expect(mayorControlOf(said)).toBe("PAUSE");
    for (const said of ["继续", "继续干活吧", "开工", "resume", "carry on"]) expect(mayorControlOf(said)).toBe("RESUME");
    for (const said of ["先别扩张了", "不要停", "给我全力扩张建设，不要停", "停止扩张", "继续扩张", "把问题图标都解决掉", "don't stop"]) expect(mayorControlOf(said)).toBeNull();
  });

  it("'不要停止扩张' is go on, not a hold; '先别扩张了' still is a hold", () => {
    expect(parseInstruction("不要停止扩张").instruction.growth).toBe("RESUME");
    expect(parseInstruction("别停下，继续扩张").instruction.growth).toBe("RESUME");
    expect(parseInstruction("先别扩张了").instruction.growth).toBe("PAUSE");
  });

  it("the growth mode is said in words: all-out is snowball, saving is steady", () => {
    const allOut = parseInstruction("给我全力扩张建设，不要停");
    expect(allOut).toMatchObject({ understood: true, confident: true });
    expect(allOut.instruction).toMatchObject({ style: "SNOWBALL", growth: "RESUME" });
    expect(parseInstruction("有钱就建，滚雪球").instruction.style).toBe("SNOWBALL");
    expect(parseInstruction("稳健一点，边扩张边攒钱").instruction.style).toBe("STEADY");
    expect(parseInstruction("先别扩张了").instruction.style).toBeUndefined();
    expect(parseInstruction("Expand all out, don't stop").instruction.style).toBe("SNOWBALL");
  });

  it("does not guess: an instruction it cannot map says so in the player's language", () => {
    expect(parseInstruction("今天天气不错")).toMatchObject({ understood: false, intent: null });
    expect(parseInstruction("nice weather today").summary).toMatch(/could not map/);
  });

  it("names what it recognised but cannot do, instead of turning it into another task", () => {
    const parsed = parseInstruction("Add a metro line and fix traffic");
    expect(parsed.intent?.type).toBe("IMPROVE_TRAFFIC");
    expect(parsed.unsupported.join(" ")).toMatch(/metro/);
  });

  it("reads limits: what is forbidden and which district to keep, in both languages, without mistaking them for goals", () => {
    const zh = parseInstruction("解决堵车，别动老城区，不要拆房子");
    const en = parseInstruction("Fix the traffic, leave the Old Town alone and don't demolish anything");
    expect(zh.intent?.type).toBe("IMPROVE_TRAFFIC");
    expect(en.intent?.type).toBe("IMPROVE_TRAFFIC");
    expect(zh.instruction).toMatchObject({ forbid: ["demolition"], preserve: ["老城区"] });
    expect(en.instruction).toMatchObject({ forbid: ["demolition"], preserve: ["Old Town"] });
    // "Don't tear down the houses" is a limit, not "build houses".
    expect(parseInstruction("不要拆房子").intent).toBeNull();
    expect(parseInstruction("不要拆房子")).toMatchObject({ understood: true, instruction: { forbid: ["demolition"] } });
    // A pure limit is understood on its own.
    expect(parseInstruction("保护东岸区")).toMatchObject({ understood: true, intent: null, instruction: { preserve: ["东岸区"] } });
    expect(parseInstruction("no loans, don't change the roads")).toMatchObject({ understood: true, instruction: { forbid: ["loan", "road_rebuild"] } });
  });

  it("reads several districts in one breath, names written first, and names in another script (live stress, 2026-10-06)", () => {
    expect(parseInstruction("别动报春花丘陵和麋鹿树林，扩建住宅")).toMatchObject({ intent: { type: "EXPAND_RESIDENTIAL" }, instruction: { preserve: ["报春花丘陵", "麋鹿树林"] } });
    expect(parseInstruction("别动报春花丘陵、麋鹿树林").instruction.preserve).toEqual(["报春花丘陵", "麋鹿树林"]);
    expect(parseInstruction("麋鹿树林别动")).toMatchObject({ understood: true, instruction: { preserve: ["麋鹿树林"] } });
    expect(parseInstruction("Expand residential but leave 麋鹿树林 alone")).toMatchObject({ intent: { type: "EXPAND_RESIDENTIAL" }, instruction: { preserve: ["麋鹿树林"] } });
    expect(parseInstruction("Leave the Old Town and the Docks alone").instruction.preserve.sort()).toEqual(["Docks", "Old Town"]);
    // A name that holds 和 is one name, not two.
    expect(parseInstruction("别动和平区").instruction.preserve).toEqual(["和平区"]);
    expect(parseInstruction("保护人和镇").instruction.preserve).toEqual(["人和镇"]);
    // "keep the roads and expand housing" names no district.
    expect(parseInstruction("keep the roads and expand housing").instruction.preserve).toEqual([]);
  });

  it("reads the city's problems as a player describes them, in both languages (abstract requests, 2026-10-06)", () => {
    const issuesOf = (text: string) => parseInstruction(text).intent;
    expect(issuesOf("城市太吵了")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["NOISE"] } });
    // The player says the city loses money: one finance issue (the mature recovery loop takes the lead).
    expect(issuesOf("城市一直在亏钱，帮我止血")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["FINANCE"] } });
    expect(issuesOf("We are losing money, cut the spending")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["FINANCE"] } });
    expect(issuesOf("The city is too noisy")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["NOISE"] } });
    expect(issuesOf("到处都是烧毁和坍塌的废墟，拆了重建吧")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["RUINS"] } });
    expect(parseInstruction("到处都是烧毁和坍塌的废墟，拆了重建吧").unsupported).toEqual([]);
    expect(issuesOf("Collapsed buildings everywhere")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["RUINS"] } });
    expect(issuesOf("交通堵死了，而且好吵")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["TRAFFIC", "NOISE"] } });
    expect(issuesOf("有些建筑连不上路")).toMatchObject({ type: "RESOLVE_ISSUES", scope: { issues: ["ACCESS"] } });
    // "Make it livable" names every problem: no list.
    expect(issuesOf("让城市更宜居一点，把这些问题图标处理掉")).toEqual({ kind: "GOAL", type: "RESOLVE_ISSUES", priority: "NORMAL" });
    expect(issuesOf("Make the city livable, fix all the problems")).toEqual({ kind: "GOAL", type: "RESOLVE_ISSUES", priority: "NORMAL" });
    // One service problem keeps its service goal, named or only described.
    expect(issuesOf("治安太差了")).toMatchObject({ type: "PROVIDE_SERVICE", scope: { serviceKind: "POLICE" } });
    expect(issuesOf("Buildings keep burning")).toMatchObject({ type: "PROVIDE_SERVICE", scope: { serviceKind: "FIRE" } });
    expect(issuesOf("交通太堵了")).toMatchObject({ type: "IMPROVE_TRAFFIC" });
    // "dead end" is a road, not deathcare.
    expect(issuesOf("fix the dead end roads")?.type).not.toBe("RESOLVE_ISSUES");
  });

  it("'don't buy land' is never read as permission to buy land", () => {
    expect(parseInstruction("Expand industry but don't buy land").intent?.scope?.acquireLand).toBeUndefined();
    expect(parseInstruction("扩建工业，不要买地").intent?.scope?.acquireLand).toBeUndefined();
  });
});
