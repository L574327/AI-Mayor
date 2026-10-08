import { DistrictBuilder, mainStreetNetwork, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { provisionDistrictUtility } from "../../src/main/services/ai-mayor/v2/district-utilities";

let nextId = 1000;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
type N = ReturnType<typeof node>;
const edge = (a: N, b: N, prefab = "Medium Road") => ({ entity: { index: nextId++, version: 1 }, prefab, native: false, startNode: a.entity, endNode: b.entity,
  start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });

/** A 24-street main network along z = 0 plus whatever else the test adds. */
function city(extra: (nodes: N[], edges: ReturnType<typeof edge>[]) => void = () => undefined) {
  const nodes: N[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  for (let index = 0; index <= 24; index += 1) nodes.push(node(index * 40, 0));
  for (let index = 0; index < 24; index += 1) edges.push(edge(nodes[index]!, nodes[index + 1]!));
  extra(nodes, edges);
  return { roadGraph: { nodes, edges }, ownedTiles: [] } as never;
}

const port = (demolished: number[] = [], built: Array<{ x: number; z: number }> = []): DistrictBuilderPort => ({
  scanWorld: async () => city(), listBuildings: async () => [],
  siteDetail: async (center) => ({ center, radius: 1, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [], terrain: undefined }) as never,
  buildRoad: async (course) => { built.push({ ...course.start }); return { ok: true, detail: "" }; },
  zone: async () => ({ ok: true, detail: "" }),
  demolishRoad: async (entity) => { demolished.push(entity.index); return true; },
});

describe("the main street network", () => {
  test("is the largest connected component with highways left out as streets", () => {
    const world = city((nodes, edges) => {
      const ramp = node(960, 0);
      const highway = node(1000, 0);
      nodes.push(ramp, highway);
      edges.push(edge(nodes[24]!, ramp), edge(ramp, highway, "Highway Twoway - 2 lanes"));
      // A separate 2-street piece is not main.
      const a = node(0, 500); const b = node(40, 500); const c = node(80, 500);
      nodes.push(a, b, c);
      edges.push(edge(a, b), edge(b, c));
    });
    const network = mainStreetNetwork((world as unknown as { roadGraph: never }).roadGraph);
    expect(network.edges.every((candidate) => !/Highway/.test(candidate.prefab))).toBe(true);
    expect(network.edges).toHaveLength(25);
    expect(network.components).toHaveLength(2);
  });
});

describe("broken roads are bugs, not features", () => {
  test("a single street that joins nothing is bulldozed, unless a building stands beside it", async () => {
    const world = city((nodes, edges) => { const a = node(0, 600); const b = node(120, 600); nodes.push(a, b); edges.push(edge(a, b)); });
    const gone: number[] = [];
    const builder = new DistrictBuilder(port(gone));
    const notes: string[] = [];
    // A stub-shaped road the Mayor did not lay is a world asset: untouched.
    expect(await builder.removeOrphanStubs(world as never, [], notes)).toBe(0);
    expect(gone).toEqual([]);
    builder.markOwn({ start: { x: 0, z: 600 }, end: { x: 120, z: 600 } });
    expect(await builder.removeOrphanStubs(world as never, [], notes)).toBe(1);
    expect(gone).toHaveLength(1);
    const kept: number[] = [];
    const ownBuilder = new DistrictBuilder(port(kept));
    ownBuilder.markOwn({ start: { x: 0, z: 600 }, end: { x: 120, z: 600 } });
    expect(await ownBuilder.removeOrphanStubs(world as never, [{ x: 60, z: 610 }], [])).toBe(0);
    expect(kept).toEqual([]);
  });

  test("only a broken stub of our own is removed; a real dead end (80 m) stays to be joined to the network, as does one with a building beside it", async () => {
    // 2026-10-07 (player): a dead end is not simply bulldozed; it is joined to the nearby network (closeDeadEnds). Only a stub of a failed build goes.
    const stub = city((nodes, edges) => { const tip = node(400, 30); nodes.push(tip); edges.push(edge(nodes[10]!, tip)); });
    const gone: number[] = [];
    const spurBuilder = new DistrictBuilder(port(gone));
    expect(await spurBuilder.removeDeadEndSpurs(stub as never, [], [])).toBe(0);
    spurBuilder.markOwn({ start: { x: 400, z: 0 }, end: { x: 400, z: 30 } });
    expect(await spurBuilder.removeDeadEndSpurs(stub as never, [], [])).toBe(1);
    const short = city((nodes, edges) => { const tip = node(400, 80); nodes.push(tip); edges.push(edge(nodes[10]!, tip)); });
    const keepBuilder = new DistrictBuilder(port([]));
    keepBuilder.markOwn({ start: { x: 400, z: 0 }, end: { x: 400, z: 80 } });
    expect(await keepBuilder.removeDeadEndSpurs(short as never, [], [])).toBe(0);
    const long = city((nodes, edges) => { const tip = node(400, 400); nodes.push(tip); edges.push(edge(nodes[10]!, tip)); });
    const longBuilder = new DistrictBuilder(port([]));
    longBuilder.markOwn({ start: { x: 400, z: 0 }, end: { x: 400, z: 400 } });
    expect(await longBuilder.removeDeadEndSpurs(long as never, [], [])).toBe(0);
    const built = city((nodes, edges) => { const tip = node(400, 30); nodes.push(tip); edges.push(edge(nodes[10]!, tip)); });
    const builtBuilder = new DistrictBuilder(port([]));
    builtBuilder.markOwn({ start: { x: 400, z: 0 }, end: { x: 400, z: 30 } });
    expect(await builtBuilder.removeDeadEndSpurs(built as never, [{ x: 410, z: 20 }], [])).toBe(0);
    // The ends of the main street are not spurs: they run to nothing but are not off a junction.
    expect(await new DistrictBuilder(port([])).removeDeadEndSpurs(city() as never, [], [])).toBe(0);
  });

  test("a neighbourhood that joins the main network nowhere is joined to it by a short road", async () => {
    const world = city((nodes, edges) => {
      const a = node(100, 160); const b = node(220, 160); const c = node(220, 280); const d = node(100, 280);
      nodes.push(a, b, c, d);
      edges.push(edge(a, b), edge(b, c), edge(c, d), edge(d, a));
    });
    const built: Array<{ x: number; z: number }> = [];
    const notes: string[] = [];
    expect(await new DistrictBuilder(port([], built)).reconnectOrphans(world as never, [], notes)).toBe(1);
    expect(built).toHaveLength(1);
    expect(notes.join(" ")).toMatch(/joined to the main network by 16\d m/);
    // Too far to join: reported, not built.
    const far = city((nodes, edges) => {
      const a = node(100, 900); const b = node(220, 900); const c = node(220, 1020); const d = node(100, 1020);
      nodes.push(a, b, c, d);
      edges.push(edge(a, b), edge(b, c), edge(c, d), edge(d, a));
    });
    const none: Array<{ x: number; z: number }> = [];
    expect(await new DistrictBuilder(port([], none)).reconnectOrphans(far as never, [], [])).toBe(0);
    expect(none).toEqual([]);
  });
});

describe("a district that did not stand is pruned back — only the Mayor's own streets", () => {
  test("leftover dead ends of the Mayor's own streets inside the area go, layer by layer; the world's own streets stay", async () => {
    // Main street along z = 0; the Mayor laid a gateway north from a junction and a ring piece off its end; a map street also dead-ends nearby.
    const world = city((nodes, edges) => {
      const g1 = node(400, 60); const g2 = node(400, 120); const g3 = node(520, 120);
      const m1 = node(800, 60);
      nodes.push(g1, g2, g3, m1);
      edges.push(edge(nodes[10]!, g1), edge(g1, g2), edge(g2, g3), edge(nodes[20]!, m1));
    });
    const gone: number[] = [];
    let remaining = (world as unknown as { roadGraph: { edges: Array<{ entity: { index: number } }> } }).roadGraph.edges;
    const base = port(gone);
    const builder = new DistrictBuilder({ ...base,
      scanWorld: async () => ({ roadGraph: { nodes: (world as never as { roadGraph: { nodes: never[] } }).roadGraph.nodes, edges: remaining }, ownedTiles: [] }) as never,
      demolishRoad: async (entity) => { gone.push(entity.index); remaining = remaining.filter((e) => e.entity.index !== entity.index); return true; } });
    builder.markOwn({ start: { x: 400, z: 0 }, end: { x: 400, z: 120 } });
    builder.markOwn({ start: { x: 400, z: 120 }, end: { x: 520, z: 120 } });
    const removed = await builder.pruneOwnFragments({ minX: 380, minZ: 10, maxX: 560, maxZ: 140 }, []);
    expect(removed).toBe(3);
    // The map's own stub at x = 800 is not ours and outside the area.
    expect(remaining.some((e) => e.entity.index === ((world as never as { roadGraph: { edges: Array<{ entity: { index: number } }> } }).roadGraph.edges.at(-1)!.entity.index))).toBe(true);
  });
});

describe("utilities that need only one facility", () => {
  test("a second sewage outlet is never placed while an attached one exists", async () => {
    let placed = 0;
    const notes: string[] = [];
    const result = await provisionDistrictUtility({
      listFacilities: async () => [{ entity: { index: 5, version: 1 }, position: { x: 0, z: 0 } }],
      preflight: async () => true, place: async () => { placed += 1; return { ok: true, detail: "" }; },
      attached: async () => true,
    }, { kind: "sewage", shortfall: 10, target: { x: 0, z: 0 }, edges: [edge(node(0, 0), node(100, 0))] as never }, notes);
    expect(result).toBeNull();
    expect(placed).toBe(0);
    expect(notes.join(" ")).toMatch(/another would only add upkeep/);
  });
});
