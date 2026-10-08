import { describeDistrictOutcome } from "../../src/main/services/ai-mayor/v2/district-status";

describe("the status line of a district cycle", () => {
  const longNotes = [
    "V2 S0 | seed-bound batch 115200 m2",
    `orphan network of 7 streets is 1261 m from the main network, not joined; ${"x".repeat(300)}`,
    "no site fits and no tile is bought this cycle",
  ];

  test("the reason comes first, so a cut line still shows it", () => {
    const line = describeDistrictOutcome({ status: "NO_SITE", outcome: "NO_FEASIBLE_SITE", role: "industrial", notes: longNotes,
      feasibility: { reason: "NO_SITE_IN_BOUNDED_SEARCH", survey: { considered: 50, noGateway: 50, eligible: 0, offered: 0, existingRoad: 0 }, siteChecks: { examined: 0, unread: 0 } } });
    expect(line.startsWith("V2 district builder: NO_FEASIBLE_SITE NO_SITE_IN_BOUNDED_SEARCH [noGateway=50] | role=industrial")).toBe(true);
    expect(line.slice(0, 120)).toContain("noGateway=50");
    expect(line.length).toBeLessThanOrEqual(300);
  });

  test("a wait names its reason; a missing reason or role never prints 'undefined'", () => {
    const line = describeDistrictOutcome({ status: "NO_SITE", outcome: "WAIT", waitReason: "HOUSING_HELD", notes: ["held"] });
    expect(line).toBe("V2 district builder: WAIT HOUSING_HELD | role=? | held");
    expect(describeDistrictOutcome({ status: "BUILT", notes: [] })).not.toContain("undefined");
  });

  test("control: a cycle that built reads as built, with no gate list", () => {
    const line = describeDistrictOutcome({ status: "BUILT", outcome: "BUILD", role: "residential", notes: ["district (1,2) 160x720 residential: roads 12/12 landed"] });
    expect(line).toBe("V2 district builder: BUILD | role=residential | district (1,2) 160x720 residential: roads 12/12 landed");
  });

  test("an unmet player request is marked first", () => {
    expect(describeDistrictOutcome({ status: "NO_SITE", intentUnmet: true, notes: [] }).startsWith("INTENT_UNMET V2 district builder")).toBe(true);
  });
});
