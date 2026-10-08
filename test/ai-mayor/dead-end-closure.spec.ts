import { deadEndClosures } from "../../src/main/services/ai-mayor/v2/district-corridors";
import { DistrictBuilder, DEAD_END_CLOSURE_MAX_ATTEMPTS, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";

const HOUR = 262_144 / 24;
let id = 1;
type P = { x: number; z: number };
const node = (p: P, extra: Record<string, unknown> = {}) => ({ entity: { index: id++, version: 1 }, position: { x: p.x, y: 0, z: p.z }, native: false, outsideConnection: false, roadDegree: 2, ...extra });
type N = ReturnType<typeof node>;
const edge = (a: N, b: N, native = false) => ({ entity: { index: id++, version: 1 }, prefab: "Medium Road", native, startNode: a.entity, endNode: b.entity,
  start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });

/**
 * The live gap (2026-10-05, first district): a block whose west side (A-B, 40 m) was refused for a moment while the district was laid. B is the end of a
 * 160 m street B-C that now ends in nothing, 40 m from A; the way round is B-C-D-A = 360 m.
 */
function gapWorld(overrides: { gap?: number; skew?: number; closed?: boolean; extra?: Array<[P, P]> } = {}) {
  const gap = overrides.gap ?? 40;
  const A = node({ x: -509 + (overrides.skew ?? 0), z: -102 + gap }); const B = node({ x: -509, z: -102 });
  const C = node({ x: -349, z: -102 }); const D = node({ x: -349, z: -102 + gap }); const F = node({ x: -509 + (overrides.skew ?? 0), z: 18 + gap });
  const G = node({ x: -349, z: 18 + gap });
  const edges = [edge(B, C), edge(C, D), edge(D, A), edge(A, F), edge(D, G), edge(F, G), ...(overrides.closed ? [edge(A, B)] : [])];
  const extras = (overrides.extra ?? []).map(([s, e]) => edge(node(s), node(e)));
  return { nodes: [A, B, C, D, F, G], edges: [...edges, ...extras], A, B };
}
const own = () => true;

describe("a gap in a district's own grid is closed (live 2026-10-05: a 160 m street ended in nothing 34 m from the road it should have joined)", () => {
  describe("deadEndClosures", () => {
    test("a dead end of our street, one block from a node on its own line, with a long way round, is closed by a street to that node", () => {
      const world = gapWorld();
      const closures = deadEndClosures({ nodes: world.nodes, edges: world.edges, buildings: [], isOwn: own });
      expect(closures).toHaveLength(1);
      expect(closures[0]!.from).toEqual({ x: -509, z: -102 });
      expect(closures[0]!.to.x).toBeCloseTo(-509);
      expect(closures[0]!.straightMeters).toBeCloseTo(40);
      expect(closures[0]!.networkMeters).toBeGreaterThanOrEqual(360 - 1);
    });
    test("control: once the gap is closed there is no dead end and nothing is proposed", () => {
      const world = gapWorld({ closed: true });
      expect(deadEndClosures({ nodes: world.nodes, edges: world.edges, buildings: [], isOwn: own })).toHaveLength(0);
    });
    test("control: a street that was not laid by this builder is never joined to anything", () => {
      const world = gapWorld();
      expect(deadEndClosures({ nodes: world.nodes, edges: world.edges, buildings: [], isOwn: () => false })).toHaveLength(0);
    });
    test("control: a building on the line, a street across it, a gap too far, a line off the lattice, or an outside connection are not closed", () => {
      const base = gapWorld();
      expect(deadEndClosures({ nodes: base.nodes, edges: base.edges, buildings: [{ x: -509, z: -82 }], isOwn: own })).toHaveLength(0);
      const crossed = gapWorld({ extra: [[{ x: -529, z: -82 }, { x: -489, z: -82 }]] });
      expect(deadEndClosures({ nodes: crossed.nodes, edges: crossed.edges, buildings: [], isOwn: own })).toHaveLength(0);
      const far = gapWorld({ gap: 200 });
      expect(deadEndClosures({ nodes: far.nodes, edges: far.edges, buildings: [], isOwn: own })).toHaveLength(0);
      const skewed = gapWorld({ skew: 20 });
      expect(deadEndClosures({ nodes: skewed.nodes, edges: skewed.edges, buildings: [], isOwn: own })).toHaveLength(0);
      const outside = gapWorld();
      (outside.B as { outsideConnection: boolean }).outsideConnection = true;
      expect(deadEndClosures({ nodes: outside.nodes, edges: outside.edges, buildings: [], isOwn: own })).toHaveLength(0);
    });
    test("control: a dead end whose other node is already near by the network (a short loop) is not 'closed'", () => {
      // A short cul-de-sac stub beside a junction: the way round is about as short as the straight line, so no street is worth laying.
      const a = node({ x: 0, z: 0 }); const b = node({ x: 0, z: 40 }); const c = node({ x: 40, z: 40 });
      const edges = [edge(a, b), edge(b, c)];
      expect(deadEndClosures({ nodes: [a, b, c], edges, buildings: [], isOwn: own })).toHaveLength(0);
    });
  });

  describe("through the district builder: a refusal of the moment is tried again, and a street the game keeps refusing is given up on", () => {
    const run = () => {
      const state = { frame: 5_000_000, verdict: "REJECT:operation blocked by game validation (overlap)" as string };
      const built: string[] = [];
      const world = gapWorld();
      const port: DistrictBuilderPort = {
        scanWorld: async () => ({ roadGraph: { nodes: world.nodes, edges: world.edges }, ownedTiles: [] }) as never,
        listBuildings: async () => [],
        siteDetail: async () => null,
        buildRoad: async (course) => { built.push(`${course.start.x},${course.start.z}>${course.end.x},${course.end.z}`); return { ok: true, detail: "ok" }; },
        zone: async () => ({ ok: true, detail: "" }),
        preflightRoad: async () => state.verdict,
        readGameFrame: async () => state.frame,
      };
      const builder = new DistrictBuilder(port);
      // The streets of this district were laid by this builder.
      for (const e of world.edges) builder.markOwn({ start: e.start, end: e.end });
      const close = async () => { const notes: string[] = []; const count = await builder.closeDeadEnds({ roadGraph: { nodes: world.nodes, edges: world.edges } } as never, [], notes); return { count, notes }; };
      return { builder, state, built, close };
    };

    test("refused by the dry run at first, nothing is built; an hour of game time later the game accepts it and the gap is closed", async () => {
      const { state, built, close } = run();
      const first = await close();
      expect(first.count).toBe(0);
      expect(built).toHaveLength(0);
      expect(first.notes.join(" ")).toMatch(/refused by the dry run.*attempt 1 of 4, tried again later/);
      // Still inside the hour: not asked again.
      state.frame += HOUR / 4;
      expect((await close()).notes).toHaveLength(0);
      // The refusal was the moment's: later the game accepts the same street.
      state.verdict = "OK";
      state.frame += HOUR;
      const later = await close();
      expect(later.count).toBe(1);
      expect(built).toEqual(["-509,-102>-509,-62"]);
    });

    test("control: with no obstacle the gap is closed at once, with a clock or without one", async () => {
      const { state, built, close } = run();
      state.verdict = "OK";
      expect((await close()).count).toBe(1);
      expect(built).toHaveLength(1);
    });

    test("control: a street the game keeps refusing is tried a bounded number of times and then left alone", async () => {
      const { state, close } = run();
      let attempts = 0;
      for (let round = 0; round < DEAD_END_CLOSURE_MAX_ATTEMPTS + 3; round += 1) {
        const result = await close();
        attempts += result.notes.filter((note) => /refused by the dry run/.test(note)).length;
        state.frame += 2 * HOUR;
      }
      expect(attempts).toBe(DEAD_END_CLOSURE_MAX_ATTEMPTS);
    });
  });
});
