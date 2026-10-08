import { checkReply, buildPrompt } from "../../src/main/services/ai-mayor/host/semantic-frontend";
import { combineGoals, lowerInstruction } from "../../src/main/services/ai-mayor/host/intent-lowering";
import { parseInstruction } from "../../src/main/services/ai-mayor/host/intent-parser";

const lower = (instruction: Parameters<typeof lowerInstruction>[0]["instruction"]) =>
  lowerInstruction({ instruction, districts: [], session: "w", generation: 1, population: 1000, cash: 1000, previous: null, updateId: "u1", lang: "zh" });

describe("the filter: the AI translates the player's words into the instruction the compiler takes", () => {
  test("the prompt carries the whole vocabulary, the icon words and worked examples with this request's code", () => {
    const prompt = buildPrompt("垃圾太多了", "AB12");
    expect(prompt).toMatch(/No Road Access/);
    expect(prompt).toMatch(/growth/);
    expect(prompt).toMatch(/targetPopulation/);
    expect((prompt.match(/MAYOR-AB12/g) ?? []).length).toBeGreaterThan(6);
    expect(prompt).toMatch(/REQUEST: 垃圾太多了$/);
  });

  test("several goals, a growth hold and a population target are read and checked", () => {
    const reply = 'MAYOR-AB12 {"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":["GARBAGE","ACCESS"]}},{"type":"EXPAND_RESIDENTIAL","scope":{"density":"HIGH"}}],"growth":null,"targetPopulation":50000,"forbid":["loan"],"preserve":[],"unsupported":[]}';
    const checked = checkReply(reply, "AB12");
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.instruction.goal?.type).toBe("RESOLVE_ISSUES");
    expect(checked.instruction.goals?.[0]?.type).toBe("EXPAND_RESIDENTIAL");
    expect(checked.instruction.targetPopulation).toBe(50000);
    expect(checkReply('MAYOR-AB12 {"goals":[],"growth":"PAUSE","forbid":[],"preserve":[],"unsupported":[]}', "AB12")).toMatchObject({ ok: true, instruction: { growth: "PAUSE" } });
    expect(checkReply('MAYOR-AB12 {"goals":[],"growth":"STOP","forbid":[]}', "AB12")).toMatchObject({ ok: false, error: "INVALID" });
    expect(checkReply('MAYOR-AB12 {"goals":[],"targetPopulation":5,"forbid":[]}', "AB12")).toMatchObject({ ok: false, error: "INVALID" });
    // The older one-goal line is still read.
    expect(checkReply('MAYOR-AB12 {"goal":{"type":"IMPROVE_TRAFFIC"},"forbid":[],"preserve":[],"unsupported":[]}', "AB12")).toMatchObject({ ok: true, intent: { type: "IMPROVE_TRAFFIC" } });
  });

  test("the problems of every goal become ONE care goal, and one building goal runs at a time", () => {
    const combined = combineGoals([
      { kind: "GOAL", type: "IMPROVE_TRAFFIC", priority: "NORMAL" },
      { kind: "GOAL", type: "RESOLVE_ISSUES", priority: "HIGH", scope: { issues: ["GARBAGE"] } },
      { kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: "NORMAL" },
      { kind: "GOAL", type: "EXPAND_COMMERCIAL", priority: "NORMAL" },
    ]);
    expect(combined.care).toEqual({ kind: "GOAL", type: "RESOLVE_ISSUES", priority: "HIGH", scope: { issues: ["TRAFFIC", "GARBAGE"] } });
    expect(combined.build?.type).toBe("EXPAND_RESIDENTIAL");
    expect(combined.dropped.map((goal) => goal.type)).toEqual(["EXPAND_COMMERCIAL"]);
  });

  test("a growth hold wins over a building goal of the same sentence, and is reported", () => {
    const lowered = lower({ goal: { kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: "NORMAL" }, growth: "PAUSE", forbid: [], preserve: [], unsupported: [] });
    expect(lowered.growth).toBe("PAUSE");
    expect(lowered.buildGoal).toBeNull();
    expect(lowered.notes.join("\n")).toMatch(/暂停扩张/);
    expect(lower({ goal: null, targetPopulation: 50, forbid: [], preserve: [], unsupported: [] }).targetPopulation).toBe(1000);
  });
});

describe("the offline reader (no AI): what players actually say", () => {
  test.each([
    ["先别扩张了", { growth: "PAUSE" }],
    ["暂停扩张", { growth: "PAUSE" }],
    ["继续扩张", { growth: "RESUME" }],
    ["人口目标5万", { targetPopulation: 50000 }],
    ["发展到10万人", { targetPopulation: 100000 }],
  ])("%s", (text, expected) => {
    const parsed = parseInstruction(text);
    expect(parsed.understood).toBe(true);
    expect(parsed.instruction).toMatchObject(expected);
    expect(parsed.intent).toBeNull();
  });

  test.each([
    ["城市好堵", "IMPROVE_TRAFFIC"],
    ["没水了", "PROVIDE_SERVICE"],
    ["钱不够了", "RESOLVE_ISSUES"],
    ["电线没接上", "RESOLVE_ISSUES"],
    ["建筑没有车辆通行", "RESOLVE_ISSUES"],
    ["失业太多", "EXPAND_INDUSTRIAL"],
    ["把问题都解决了", "RESOLVE_ISSUES"],
    ["把城市做大", "GROW_POPULATION"],
  ])("%s -> %s", (text, type) => {
    expect(parseInstruction(text).intent?.type).toBe(type);
  });

  test("two requests in one sentence are two goals, in order", () => {
    const parsed = parseInstruction("清理废墟然后扩建住宅");
    expect(parsed.instruction.goal?.type).toBe("RESOLVE_ISSUES");
    expect(parsed.instruction.goals?.[0]?.type).toBe("EXPAND_RESIDENTIAL");
  });

  test("politeness and filler are not a part of the sentence that was not understood; a real unread wish is", () => {
    expect(parseInstruction("垃圾太多了，还有交通堵塞，都处理一下")).toMatchObject({ understood: true, confident: true });
    expect(parseInstruction("帮我把交通搞好一点")).toMatchObject({ understood: true, confident: true });
    expect(parseInstruction("交通搞好一点，然后在北边沿着湖修个漂亮的高档社区").confident).toBe(false);
  });
  test("two wishes joined by 和 are two goals when each side is a wish of its own", () => {
    const parsed = parseInstruction("污水倒灌和垃圾堆积先处理掉");
    const types = [parsed.instruction.goal, ...(parsed.instruction.goals ?? [])].map((goal) => goal?.type);
    expect(types).toEqual(["RESOLVE_ISSUES", "PROVIDE_SERVICE"]);
    expect(parseInstruction("建一些高密度住宅在河边").instruction.goals).toBeUndefined();
  });
  test("a connection problem is not a request for more power", () => {
    expect(parseInstruction("电线没接上").intent?.scope?.issues).toEqual(["ACCESS"]);
  });
});
describe("the offline reader: negations and numerals that once read as the opposite (live natural-language run 2026-10-07)", () => {
  test.each(["暂停发展", "不要发展人口了", "城市先别变大", "现在就停止一切扩张，只修问题，马上", "please stop all expansion and only fix issues"])("%s holds expansion, never grows it", (said) => {
    const parsed = parseInstruction(said);
    expect(parsed.instruction.growth).toBe("PAUSE");
    expect(parsed.instruction.goal?.type).not.toBe("GROW_POPULATION");
  });
  test("Chinese numerals give the target population", () => {
    expect(parseInstruction("把人口做到十五万").instruction.targetPopulation).toBe(150_000);
    expect(parseInstruction("人口到两百万").instruction.targetPopulation).toBe(2_000_000);
    expect(parseInstruction("人口发展到一百二十万").instruction.targetPopulation).toBe(1_200_000);
  });
  test("\"别再拆了，修路\" forbids demolition and still reads the road wish", () => {
    const parsed = parseInstruction("别再拆了，修路");
    expect(parsed.instruction.forbid).toContain("demolition");
    expect(parsed.instruction.goal?.type).toBe("ESTABLISH_ROAD_NETWORK");
  });
  test("a connector word or an adverb is not part of the district's name", () => {
    expect(parseInstruction("噪音大的地方处理一下，另外老城区别动").instruction.preserve).toEqual(["老城区"]);
    expect(parseInstruction("老城区千万别动").instruction.preserve).toEqual(["老城区"]);
  });
});

describe("a compass side of the city for a new district", () => {
  test("the offline reader and the filter both carry it; other goals report it as unsupported", () => {
    expect(parseInstruction("在城市西边建一片商业区").instruction.goal?.scope?.direction).toBe("W");
    expect(parseInstruction("城北建工业").instruction.goal?.scope?.direction).toBe("N");
    expect(parseInstruction("expand housing to the north-east").instruction.goal?.scope?.direction).toBe("NE");
    expect(parseInstruction("去北京玩").instruction.goal).toBeNull();
    const redevelop = parseInstruction("把西边的旧工业区推倒重建成商业区");
    expect(redevelop.confident).toBe(false);
    expect(redevelop.unsupported.join(" ")).toMatch(/方位/);
    const ok = checkReply('MAYOR-AB12 {"goals":[{"type":"EXPAND_COMMERCIAL","scope":{"direction":"W"}}],"forbid":[],"preserve":[],"unsupported":[]}', "AB12");
    expect(ok.ok && ok.instruction.goal?.scope?.direction).toBe("W");
    const bad = checkReply('MAYOR-AB12 {"goals":[{"type":"RESOLVE_ISSUES","scope":{"direction":"W","issues":["GARBAGE"]}}],"forbid":[],"preserve":[],"unsupported":[]}', "AB12");
    expect(bad.ok).toBe(false);
    expect(checkReply('MAYOR-AB12 {"goals":[{"type":"EXPAND_COMMERCIAL","scope":{"direction":"UP"}}]}', "AB12").ok).toBe(false);
  });
});

describe("the reply is shown back in words", () => {
  test("describeInstruction states goals, limits and what is held in both languages", () => {
    const reply = checkReply('MAYOR-AB12 {"goals":[{"type":"RESOLVE_ISSUES","scope":{"issues":["GARBAGE","ACCESS"]}},{"type":"EXPAND_COMMERCIAL","scope":{"direction":"W"}}],"growth":"PAUSE","targetPopulation":150000,"forbid":["demolition"],"preserve":["老城区"],"unsupported":["metro"]}', "AB12");
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.summary.zh).toBe("处理问题：垃圾、道路连通；扩建商业（城市西侧）；暂停扩张；目标人口 150,000；不拆除；保护“老城区”；不支持：metro");
    expect(reply.summary.en).toContain("hold expansion");
    expect(reply.summary.en).toContain("west side");
  });
});

describe("vague wishes that an empty answer would waste", () => {
  test("a beautiful city with skyscrapers = clean up the problems, then tall housing", () => {
    for (const said of ["给我建设一个漂亮的城市，要高楼大厦", "make me a beautiful city with skyscrapers"]) {
      const parsed = parseInstruction(said);
      expect(parsed.confident).toBe(true);
      expect(parsed.instruction.goal?.type).toBe("RESOLVE_ISSUES");
      expect(parsed.instruction.goal?.scope?.density).toBeUndefined();
      expect(parsed.instruction.goals?.[0]).toMatchObject({ type: "EXPAND_RESIDENTIAL", scope: { density: "HIGH" } });
    }
    expect(parseInstruction("要摩天大楼").instruction.goal).toMatchObject({ type: "EXPAND_RESIDENTIAL", scope: { density: "HIGH" } });
  });
  test("the filter prompt tells the AI not to answer with nothing for such wishes", () => {
    const prompt = buildPrompt("给我建设一个漂亮的城市，要高楼大厦", "AB12");
    expect(prompt).toMatch(/never answer with nothing/);
    expect(prompt).toMatch(/高楼大厦/);
  });
});
