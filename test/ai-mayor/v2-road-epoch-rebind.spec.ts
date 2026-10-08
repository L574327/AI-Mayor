import { rebindCertifiedRoadEffect } from "../../src/main/services/ai-mayor/v2/road-epoch-rebind";
import type { SpatialRoadEdge } from "../../src/main/services/ai-mayor/spatial/types";

const edge = (index: number, start: { x: number; z: number }, end: { x: number; z: number }): SpatialRoadEdge => ({
  entity: { index, version: 7 }, prefab: "Small Road", native: false,
  startNode: { index: index * 2, version: 7 }, endNode: { index: index * 2 + 1, version: 7 },
  start, end, length: Math.hypot(end.x - start.x, end.z - start.z),
});

describe("current-epoch certified road rebind", () => {
  const action = { prefab: "Small Road", x1: 0, z1: 0, x2: 100, z2: 0 };
  test.each([
    [[edge(1, { x: 0, z: 0 }, { x: 100, z: 0 })], 1],
    [[edge(2, { x: 0, z: 0 }, { x: 40, z: 0 }), edge(3, { x: 40, z: 0 }, { x: 100, z: 0 })], 2],
  ])("binds %i current edge(s) without using historical identity", (edges, count) => {
    const result = rebindCertifiedRoadEffect({ action, currentEdges: edges as SpatialRoadEdge[] });
    expect(result.status).toBe("BOUND");
    expect(result.edges).toHaveLength(count);
    expect(result.edges.some((candidate) => candidate.entity.index === 999)).toBe(false);
  });

  test("does not choose an arbitrary first edge", () => {
    const result = rebindCertifiedRoadEffect({ action, currentEdges: [edge(4, { x: 200, z: 0 }, { x: 300, z: 0 })] });
    expect(result.status).toBe("STALE");
    expect(result.edges).toHaveLength(0);
  });

  test("keeps the same binding when the current road label changes", () => {
    const renamed = { ...edge(5, { x: 0, z: 0 }, { x: 100, z: 0 }), prefab: "Gravel Road" };
    const result = rebindCertifiedRoadEffect({ action, currentEdges: [renamed] });
    expect(result.status).toBe("BOUND");
    expect(result.edges.map((candidate) => candidate.entity.index)).toEqual([5]);
  });
});
