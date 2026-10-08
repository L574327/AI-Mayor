import { dropReachedTarget, REACHED_TARGET_METERS } from "../../src/main/services/ai-mayor/v2/site-selection";

const anchor = (x: number, z: number, edges = 1) => ({
  node: { position: { x, y: 0, z }, entity: { index: 1, version: 1 } },
  sourceEdges: Array.from({ length: edges }, () => ({})),
  direction: { x: 1, z: 0 },
  derivation: "OWNED_LOCAL_ROAD_TOPOLOGY",
}) as never;

describe("a directed target the network already reaches", () => {
  test("is dropped, so the site search is no longer asked to get closer than 0 m (860 TARGET_NOT_ADVANCED, live)", () => {
    const input = { anchors: [anchor(100, 100), anchor(400, 400)], targetPoint: { x: 100, z: 100 } };
    expect(dropReachedTarget(input).targetPoint).toBeUndefined();
    const near = { anchors: [anchor(100, 100)], targetPoint: { x: 100 + REACHED_TARGET_METERS, z: 100 } };
    expect(dropReachedTarget(near).targetPoint).toBeUndefined();
  });

  test("a target the network has not reached keeps directing the search", () => {
    const input = { anchors: [anchor(100, 100)], targetPoint: { x: 300, z: 100 } };
    expect(dropReachedTarget(input)).toBe(input);
  });

  test("an anchor with no road edge is not the network's reach", () => {
    const input = { anchors: [anchor(100, 100, 0)], targetPoint: { x: 100, z: 100 } };
    expect(dropReachedTarget(input)).toBe(input);
  });

  test("an undirected search is untouched", () => {
    const input = { anchors: [anchor(100, 100)] };
    expect(dropReachedTarget(input)).toBe(input);
  });
});
