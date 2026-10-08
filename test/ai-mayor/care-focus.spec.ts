import { careFocusFrom, describeCarePlan, CARE_ISSUES } from "../../src/main/services/ai-mayor/v2/care-focus";
import { isStructuredIntentInVocabulary, planStructuredIntent, CARE_PRIMITIVES } from "../../src/main/services/ai-mayor/v2/intent-primitive-map";
import { checkReply } from "../../src/main/services/ai-mayor/host/semantic-frontend";

describe("care focus: a sentence about the city's problems becomes work the care round does", () => {
  test("goals map to the problems they name; growth and utilities are not care", () => {
    expect(careFocusFrom({ kind: "GOAL", type: "IMPROVE_TRAFFIC", priority: "NORMAL" })).toEqual(["TRAFFIC"]);
    expect(careFocusFrom({ kind: "GOAL", type: "PROVIDE_SERVICE", priority: "NORMAL", scope: { serviceKind: "POLICE" } })).toEqual(["CRIME"]);
    expect(careFocusFrom({ kind: "GOAL", type: "RESOLVE_ISSUES", priority: "NORMAL", scope: { issues: ["NOISE", "RUINS", "NOISE"] } })).toEqual(["NOISE", "RUINS"]);
    expect(careFocusFrom({ kind: "GOAL", type: "RESOLVE_ISSUES", priority: "NORMAL" })).toEqual(CARE_ISSUES.filter((issue) => issue !== "FINANCE"));
    expect(careFocusFrom({ kind: "GOAL", type: "PROVIDE_SERVICE", priority: "NORMAL", scope: { serviceKind: "ELECTRICITY" } })).toBeNull();
    expect(careFocusFrom({ kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: "NORMAL" })).toBeNull();
  });

  test("a care goal is executable through the care round, no longer a capability gap; education still is one", () => {
    const traffic = { kind: "GOAL" as const, type: "IMPROVE_TRAFFIC" as const, priority: "NORMAL" as const };
    expect(planStructuredIntent(traffic).executable).toBe(false);
    expect(planStructuredIntent(traffic, CARE_PRIMITIVES).executable).toBe(true);
    const all = { kind: "GOAL" as const, type: "RESOLVE_ISSUES" as const, priority: "NORMAL" as const };
    expect(isStructuredIntentInVocabulary(all)).toBe(true);
    expect(planStructuredIntent(all, CARE_PRIMITIVES).executable).toBe(true);
    expect(isStructuredIntentInVocabulary({ ...all, scope: { issues: ["NOT_A_THING" as never] } })).toBe(false);
    const school = { kind: "GOAL" as const, type: "PROVIDE_SERVICE" as const, priority: "NORMAL" as const, scope: { serviceKind: "EDUCATION" as const } };
    expect(careFocusFrom(school)).toBeNull();
  });

  test("the player reads what the Mayor will do about each named problem, garbage included", () => {
    expect(describeCarePlan(["TRAFFIC"], "zh")[0]).toMatch(/源头路口.*撤回/);
    expect(describeCarePlan(["NOISE"], "en")[0]).toMatch(/trees/);
    expect(describeCarePlan(["GARBAGE"], "zh")[0]).toMatch(/远离住宅.*垃圾填埋场/);
  });

  test("an AI reply with RESOLVE_ISSUES is checked like any other: known issues only, only with that goal", () => {
    expect(checkReply('MAYOR-AB12 {"goal":{"type":"RESOLVE_ISSUES","scope":{"issues":["NOISE","RUINS"]}},"forbid":[],"preserve":[],"unsupported":[]}', "AB12"))
      .toMatchObject({ ok: true, intent: { type: "RESOLVE_ISSUES", scope: { issues: ["NOISE", "RUINS"] } } });
    expect(checkReply('MAYOR-AB12 {"goal":{"type":"RESOLVE_ISSUES","scope":{"issues":["UFO"]}},"forbid":[],"preserve":[],"unsupported":[]}', "AB12")).toMatchObject({ ok: false });
    expect(checkReply('MAYOR-AB12 {"goal":{"type":"GROW_POPULATION","scope":{"issues":["NOISE"]}},"forbid":[],"preserve":[],"unsupported":[]}', "AB12")).toMatchObject({ ok: false });
  });
});
