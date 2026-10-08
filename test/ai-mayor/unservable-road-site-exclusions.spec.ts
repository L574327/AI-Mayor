import {
  MAXIMUM_UNSERVABLE_ROAD_SITE_EXCLUSIONS,
  unservableRoadSiteExclusions,
} from "../../src/main/services/ai-mayor/v2/project-admission";

const order = (id: string, goalId: string, status: string, reason: string, center = { x: 1, z: 2 }) => ({
  workOrderId: id, goalId, status,
  state: { project: { utilityReservation: { center, radius: 28 } }, journal: [{ failureClassification: null, reason }] },
});
const REFUSED = "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:55896:1:start:NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED";

describe("refused Road sites are excluded from the next standalone Road search", () => {
  test("a blocked Road Goal whose own journal proves its site unservable becomes an exclusion circle", () => {
    expect(unservableRoadSiteExclusions([order("w1", "ESTABLISH_ROAD_NETWORK:facts:aaaaaaaaaaaa", "BLOCKED", REFUSED)]))
      .toEqual([{ ref: "unservable-road-site:w1", scope: { center: { x: 1, z: 2 }, radius: 28 } }]);
  });

  test("other Goals, unfinished Goals, prerequisites and unrelated refusals exclude nothing", () => {
    expect(unservableRoadSiteExclusions([
      order("a", "EXPAND_RESIDENTIAL:residential:facts:aaaaaaaaaaaa", "BLOCKED", REFUSED),
      order("b", "ESTABLISH_ROAD_NETWORK:facts:aaaaaaaaaaaa", "ACTIVE", REFUSED),
      order("c", "ESTABLISH_ROAD_NETWORK:facts:aaaaaaaaaaaa:prerequisite:ROAD_FRONTAGE:1:abc", "BLOCKED", REFUSED),
      order("d", "ESTABLISH_ROAD_NETWORK:facts:aaaaaaaaaaaa", "BLOCKED", "PROJECT_ADMISSION_TREASURY_UNKNOWN"),
    ])).toEqual([]);
  });

  test("only the most recent refusals are remembered, so old ground is eventually retried", () => {
    const many = Array.from({ length: MAXIMUM_UNSERVABLE_ROAD_SITE_EXCLUSIONS + 5 }, (_, index) =>
      order(`w${index}`, `ESTABLISH_ROAD_NETWORK:facts:${String(index).padStart(12, "0")}`, "BLOCKED", REFUSED, { x: index, z: 0 }));
    const exclusions = unservableRoadSiteExclusions(many);
    expect(exclusions).toHaveLength(MAXIMUM_UNSERVABLE_ROAD_SITE_EXCLUSIONS);
    expect(exclusions[0]!.scope.center.x).toBe(5);
  });
});
