import type { MayorStructuredGoalIntent } from "../../src/main/services/ai-mayor/types";
import { growthGoalFromStructuredIntent } from "../../src/main/services/ai-mayor/v2/autonomous-brain";
import { isStructuredIntentInVocabulary, planStructuredIntent } from "../../src/main/services/ai-mayor/v2/intent-primitive-map";

const goal = (type: MayorStructuredGoalIntent["type"], scope?: MayorStructuredGoalIntent["scope"]): MayorStructuredGoalIntent =>
  ({ kind: "GOAL", type, ...(scope ? { scope } : {}), priority: "NORMAL" });

// The 16 intent samples of docs/ai-mayor/INTENT-COVERAGE-GAP-MAP-2026-10-02.md, with the gaps each one must name.
const SAMPLES: Array<[string, MayorStructuredGoalIntent, string[]]> = [
  ["1 tidy town", goal("EXPAND_RESIDENTIAL", { region: "NEAR_EXISTING" }), []],
  ["2 coastal housing", goal("EXPAND_RESIDENTIAL", { region: "WATERFRONT" }), ["SITE_REGION:WATERFRONT"]],
  ["3 clear and rebuild", goal("REDEVELOP_AREA"), ["DEMOLISH"]],
  ["4 community with school and park", goal("PROVIDE_SERVICE", { serviceKind: "EDUCATION" }), ["SERVICE_BUILDING"]],
  ["5 industry away from housing", goal("EXPAND_INDUSTRIAL", { region: "FAR" }), ["SITE_REGION:FAR"]],
  ["6 infill", goal("EXPAND_RESIDENTIAL", { region: "INFILL" }), ["SITE_REGION:INFILL"]],
  ["7 edge expansion", goal("EXPAND_RESIDENTIAL", { region: "EDGE" }), ["SITE_REGION:EDGE"]],
  ["8 distant new town", goal("ESTABLISH_ROAD_NETWORK", { region: "FAR" }), ["SITE_REGION:FAR"]],
  ["9 bridge across river", goal("CONNECT_ACROSS_OBSTACLE"), ["BRIDGE"]],
  ["10 arterial and local tiers", goal("IMPROVE_TRAFFIC"), ["ROAD_UPGRADE"]],
  ["11 roundabout landmark", goal("ESTABLISH_ROAD_NETWORK", { roadCharacter: "ROUNDABOUT" }), ["ROUNDABOUT"]],
  ["12 organic streets", goal("EXPAND_RESIDENTIAL", { roadCharacter: "ORGANIC" }), ["CURVED_ROAD"]],
  ["13 dense business centre", goal("EXPAND_COMMERCIAL", { density: "HIGH" }), ["ZONE_DENSITY"]],
  ["14 buy land then expand", goal("EXPAND_RESIDENTIAL", { acquireLand: true }), ["LAND_PURCHASE"]],
  ["15 relieve congestion", goal("IMPROVE_TRAFFIC", { region: "ANY" }), ["ROAD_UPGRADE"]],
  ["16 close water/power/sewage gap", goal("PROVIDE_SERVICE", { serviceKind: "WATER" }), []],
];

describe("intent -> primitive table", () => {
  test.each(SAMPLES)("%s names exactly its missing primitives", (_name, intent, gaps) => {
    expect(isStructuredIntentInVocabulary(intent)).toBe(true);
    const plan = planStructuredIntent(intent);
    expect([...plan.gaps].sort()).toEqual([...gaps].sort());
    expect(plan.executable).toBe(gaps.length === 0);
  });

  test("an executable intent still becomes a Brain Goal, an intent with a gap names none", () => {
    expect(growthGoalFromStructuredIntent(goal("PROVIDE_SERVICE", { serviceKind: "WATER" }))?.goalId).toBe("PROVIDE_SERVICE:water");
    expect(growthGoalFromStructuredIntent(goal("EXPAND_RESIDENTIAL", { region: "NEAR_EXISTING" }))?.goalId).toBe("EXPAND_RESIDENTIAL");
    expect(growthGoalFromStructuredIntent(goal("EXPAND_RESIDENTIAL", { region: "WATERFRONT" }))).toBeNull();
  });

  test("malformed intents are outside the vocabulary rather than gaps", () => {
    expect(isStructuredIntentInVocabulary(goal("PROVIDE_SERVICE"))).toBe(false);
    expect(isStructuredIntentInVocabulary({ ...goal("EXPAND_RESIDENTIAL"), priority: "URGENT" as never })).toBe(false);
    expect(isStructuredIntentInVocabulary(goal("EXPAND_RESIDENTIAL", { region: "MOON" as never }))).toBe(false);
  });
});
