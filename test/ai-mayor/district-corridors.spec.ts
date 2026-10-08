import { corridorCandidates } from "../../src/main/services/ai-mayor/v2/district-corridors";

let id = 1;
const node = (x: number, z: number) => ({ entity: { index: id++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 3 });
type N = ReturnType<typeof node>;
const edge = (a: N, b: N) => ({ entity: { index: id++, version: 1 }, prefab: "Medium Road", native: false, startNode: a.entity, endNode: b.entity,
  start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });

/**
 * Two districts side by side, each a ring with a middle street (so its ring has joints), 200 m apart, joined only by a
 * long road around the south: their facing joints are close in a line and far by the network.
 */
function twoDistricts() {
  const nodes: N[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  const district = (x0: number) => {
    const grid: N[][] = [];
    for (let column = 0; column <= 2; column += 1) { grid.push([]); for (let row = 0; row <= 4; row += 1) { const n = node(x0 + column * 120, row * 120); nodes.push(n); grid[column]!.push(n); } }
    for (let column = 0; column <= 2; column += 1) for (let row = 0; row < 4; row += 1) edges.push(edge(grid[column]![row]!, grid[column]![row + 1]!));
    for (let row = 0; row <= 4; row += 1) for (let column = 0; column < 2; column += 1) edges.push(edge(grid[column]![row]!, grid[column + 1]![row]!));
    return grid;
  };
  const west = district(0);
  const east = district(440);
  // The long way round: from the west district's south-east corner to the east district's south-west corner via a far loop.
  const loop = [node(240, -500), node(440, -500)];
  loop.forEach((n) => nodes.push(n));
  edges.push(edge(west[2]![0]!, loop[0]!), edge(loop[0]!, loop[1]!), edge(loop[1]!, east[0]![0]!));
  return { nodes, edges, west, east };
}

describe("through streets between neighbouring districts", () => {
  test("a joint-to-joint, axis-aligned street is chosen where the network route is much longer than the straight line", () => {
    const { nodes, edges } = twoDistricts();
    const chosen = corridorCandidates({ nodes: nodes as never, edges: edges as never, buildings: [] });
    expect(chosen.length).toBeGreaterThan(0);
    for (const corridor of chosen) {
      expect(corridor.networkMeters).toBeGreaterThanOrEqual(corridor.straightMeters * 2.5);
      expect(Math.abs(corridor.from.x - corridor.to.x) < 2 || Math.abs(corridor.from.z - corridor.to.z) < 2).toBe(true);
      expect(corridor.straightMeters).toBeGreaterThanOrEqual(200 - 1);
    }
  });

  test("a district laid one block (40 m) from its neighbour is joined by one short street, even when the scan's edge ends sit centimetres off their nodes", () => {
    // Measured live: the two joints facing each other across a 40 m gap were never joined — the gap is under the old 60 m
    // minimum, and the edge ending at each joint read as crossing the new street because its end was 3 cm off the node.
    const westTop = node(0, 0), westMid = node(0, 120), westBottom = node(0, 240), eastTop = node(40, 0), eastMid = node(40, 120), eastBottom = node(40, 240);
    const around = [node(-300, 600), node(340, 600)];
    const off = (e: ReturnType<typeof edge>) => ({ ...e, end: { ...e.end, z: e.end.z + 0.03 } });
    const edges = [off(edge(westTop, westMid)), off(edge(westMid, westBottom)), off(edge(eastTop, eastMid)), off(edge(eastMid, eastBottom)),
      edge(westMid, node(-120, 120)), edge(eastMid, node(160, 120)),
      edge(westBottom, around[0]!), edge(around[0]!, around[1]!), edge(around[1]!, eastBottom)];
    // Give each joint a third street so it counts as one.
    const extraWest = node(-120, 120), extraEast = node(160, 120);
    const joined = corridorCandidates({ nodes: [westTop, westMid, westBottom, eastTop, eastMid, eastBottom, ...around, extraWest, extraEast] as never,
      edges: [...edges, edge(westTop, extraWest), edge(eastTop, extraEast)] as never, buildings: [] });
    expect(joined.some((corridor) => Math.abs(corridor.straightMeters - 40) < 1)).toBe(true);
  });

  test("it is sparse: streets keep their distance, not one per joint", () => {
    const { nodes, edges } = twoDistricts();
    const chosen = corridorCandidates({ nodes: nodes as never, edges: edges as never, buildings: [], limit: 10 });
    for (let i = 0; i < chosen.length; i += 1) for (let j = i + 1; j < chosen.length; j += 1) {
      const mi = { x: (chosen[i]!.from.x + chosen[i]!.to.x) / 2, z: (chosen[i]!.from.z + chosen[i]!.to.z) / 2 };
      const mj = { x: (chosen[j]!.from.x + chosen[j]!.to.x) / 2, z: (chosen[j]!.from.z + chosen[j]!.to.z) / 2 };
      expect(Math.hypot(mi.x - mj.x, mi.z - mj.z)).toBeGreaterThanOrEqual(200);
    }
    expect(chosen.length).toBeLessThan(5);
  });

  test("a street the player already built makes the detour disappear, and nothing is laid", () => {
    const { nodes, edges, west, east } = twoDistricts();
    edges.push(edge(west[2]![2]!, east[0]![2]!));
    const chosen = corridorCandidates({ nodes: nodes as never, edges: edges as never, buildings: [] });
    // The joined row is no longer a candidate; others may remain, but none duplicates the existing street.
    expect(chosen.some((corridor) => corridor.from.z === 240 && corridor.to.z === 240)).toBe(false);
  });

  test("a building on the line blocks it, and so does a street across it", () => {
    const { nodes, edges } = twoDistricts();
    const blockedEverywhere = corridorCandidates({ nodes: nodes as never, edges: edges as never, buildings: [240, 120, 360, 0, 480].map((z) => ({ x: 340, z })) });
    expect(blockedEverywhere).toEqual([]);
    const crossing = twoDistricts();
    const a = node(340, -50); const b = node(340, 600);
    crossing.nodes.push(a, b); crossing.edges.push(edge(a, b));
    expect(corridorCandidates({ nodes: crossing.nodes as never, edges: crossing.edges as never, buildings: [] })).toEqual([]);
  });

  test("districts that are already close by the network get no street", () => {
    const { nodes, edges, west, east } = twoDistricts();
    for (let row = 0; row <= 4; row += 1) edges.push(edge(west[2]![row]!, east[0]![row]!));
    expect(corridorCandidates({ nodes: nodes as never, edges: edges as never, buildings: [] })).toEqual([]);
  });
});
