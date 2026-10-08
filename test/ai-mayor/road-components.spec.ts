import {
  orphanReconnections,
  roadComponents,
  servedComponents,
  withoutOrphanComponents,
} from "../../src/main/services/ai-mayor/v2/road-components";

let nextNode = 1;
const node = (x: number, z: number) => ({ entity: { index: nextNode++, version: 1 }, position: { x, y: 0, z }, native: false,
  outsideConnection: false, roadDegree: 1 }) as never;
const edge = (a: ReturnType<typeof node>, b: ReturnType<typeof node>, index: number) => ({
  entity: { index: 1000 + index, version: 1 }, prefab: "Medium Road", native: false,
  startNode: (a as any).entity, endNode: (b as any).entity, start: (a as any).position, end: (b as any).position, length: 40,
}) as never;

/** A chain of `streets` streets starting at x0. */
const chain = (x0: number, streets: number, base: number) => {
  const nodes = Array.from({ length: streets + 1 }, (_, i) => node(x0 + i * 40, 0));
  const edges = nodes.slice(1).map((n, i) => edge(nodes[i]!, n, base + i));
  return { nodes, edges };
};

describe("road components", () => {
  const main = chain(0, 25, 0);
  const stub = chain(2000, 2, 100);
  const graph = { nodes: [...main.nodes, ...stub.nodes], edges: [...main.edges, ...stub.edges] };

  test("a street that shares no node with the network is its own component", () => {
    expect(roadComponents(graph).map((component) => component.streets)).toEqual([25, 2]);
  });

  test("only components of district size are sources for new streets", () => {
    expect(servedComponents(graph)).toHaveLength(1);
    const world = withoutOrphanComponents({ roadGraph: { truncated: false, ...graph } } as never) as any;
    expect(world.roadGraph.edges).toHaveLength(25);
    expect(world.roadGraph.nodes).toHaveLength(26);
  });

  test("a new city with no served component is left as it is", () => {
    const tiny = { roadGraph: { truncated: false, ...stub } } as never;
    expect(withoutOrphanComponents(tiny)).toBe(tiny);
  });

  test("an orphan is re-joined at the closest pair of nodes", () => {
    const [gap] = orphanReconnections(graph);
    expect(gap!.from).toEqual({ x: 25 * 40, z: 0 });
    expect(gap!.to).toEqual({ x: 2000, z: 0 });
    expect(gap!.distanceMeters).toBeCloseTo(2000 - 1000, 6);
  });
});
