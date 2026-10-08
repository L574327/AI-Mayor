import { matchNetworkLinkCourseEffect } from "../../src/main/services/ai-mayor/v2/network-link-course-effect";

const route = { prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 10, z: 0 } };
const edge = (index: number, x1: number, x2: number, z = 0) => ({ prefab: route.prefab,
  entity: { index, version: 1 }, start: { x: x1, z }, end: { x: x2, z } });

describe("authoritative split network-link course effect", () => {
  test("matches one native course listed as a single edge", () => {
    const result = matchNetworkLinkCourseEffect({ ...route, roads: [edge(1, 0, 10)] });
    expect(result).toMatchObject({ status: "MATCH", edges: [{ entity: { index: 1 } }] });
  });

  test("matches the complete ordered chain produced by native course splitting", () => {
    const result = matchNetworkLinkCourseEffect({ ...route, roads: [edge(3, 6, 10), edge(1, 0, 3), edge(2, 3, 6)] });
    expect(result).toMatchObject({ status: "MATCH", edges: [
      { entity: { index: 1 } }, { entity: { index: 2 } }, { entity: { index: 3 } },
    ] });
  });

  test("rejects a gap instead of treating partial construction as a world effect", () => {
    expect(matchNetworkLinkCourseEffect({ ...route, roads: [edge(1, 0, 4), edge(2, 5, 10)] }))
      .toMatchObject({ status: "MISSING", reason: "REALIZED_COURSE_CHAIN_GAP" });
  });

  test("rejects duplicate/ambiguous parallel course chains", () => {
    expect(matchNetworkLinkCourseEffect({ ...route, roads: [edge(1, 0, 10), edge(2, 0, 10)] }))
      .toMatchObject({ status: "AMBIGUOUS", reason: "REALIZED_COURSE_CHAIN_NOT_UNIQUE" });
  });

  test("does not count an unrelated parallel cable as the admitted route", () => {
    expect(matchNetworkLinkCourseEffect({ ...route, roads: [edge(1, 0, 10, 2)] }))
      .toMatchObject({ status: "MISSING" });
  });
});
