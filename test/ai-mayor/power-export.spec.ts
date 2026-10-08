import {
  exportOpportunity, highVoltageLineEnds, linkPowerExport, HIGH_VOLTAGE_CABLE, LOW_VOLTAGE_CABLE, type PowerExportPort,
} from "../../src/main/services/ai-mayor/v2/power-export";

/**
 * The live case (萨利克斯 2026-10-05): the map's high-voltage line runs in from the map edge and ends at (-896.1,-23.5) inside the owned land; the
 * streets nearby are a block whose corner nodes are (-920,-39), (-800,-39), (-920,-199), (-800,-199). A transformer beside them, low voltage to a
 * street node at -8, high voltage under it at -16 onto the line's own end node — and the export flowed.
 */
const LINE = [
  { start: { x: -1105, z: -44 }, end: { x: -1002, z: -21 } },
  { start: { x: -1002, z: -21 }, end: { x: -896.1182, z: -23.4798 } },
];
const nodes = [{ x: -920, z: -39 }, { x: -800, z: -39 }, { x: -920, z: -199 }, { x: -800, z: -199 }];
const edge = (index: number, a: { x: number; z: number }, b: { x: number; z: number }) => ({ entity: { index, version: 1 }, prefab: "Medium Road", native: false,
  startNode: { index: 100 + index, version: 1 }, endNode: { index: 200 + index, version: 1 }, start: { x: a.x, y: 0, z: a.z }, end: { x: b.x, y: 0, z: b.z } });
const edges = [edge(1, nodes[0]!, nodes[2]!), edge(2, nodes[1]!, nodes[3]!), edge(3, nodes[2]!, nodes[3]!)] as never;
const owned = (point: { x: number }) => point.x >= -935;

function world(overrides: Partial<{ trade: { production: number; consumption: number; exported: number } | null; refuse: (prefab: string, from: { x: number; z: number }, to: { x: number; z: number }, e1: number) => boolean;
  standing: boolean; joins: boolean }> = {}) {
  const laid: Array<{ prefab: string; from: { x: number; z: number }; to: { x: number; z: number }; e1: number; e2: number }> = [];
  const removed: number[] = [];
  let placed: { x: number; z: number } | null = overrides.standing ? { x: -880, z: -72 } : null;
  let nextNet = 500;
  const port: PowerExportPort = {
    readTrade: async () => (overrides.trade === undefined ? { production: 98_000, consumption: 57_000, exported: 0 } : overrides.trade),
    highVoltageLines: async () => LINE,
    transformerPrefabs: async () => ["TransformerStation01"],
    listFacilities: async () => (placed ? [{ entity: { index: 9, version: 1 }, position: placed }] : []),
    preflight: async () => true,
    place: async (_prefab, point) => { placed = point; return { ok: true, detail: "placed" }; },
    markers: async () => {
      const lowDone = laid.some((entry) => entry.prefab === LOW_VOLTAGE_CABLE);
      const highDone = laid.some((entry) => entry.prefab === HIGH_VOLTAGE_CABLE);
      const joins = overrides.joins ?? true;
      return [{ voltage: "High", position: { x: placed!.x - 8, z: placed!.z - 28 }, attached: joins && highDone },
        { voltage: "Low", position: { x: placed!.x - 4, z: placed!.z + 23 }, attached: joins && lowDone }];
    },
    lay: async (prefab, from, to, e1, e2) => {
      if (overrides.refuse?.(prefab, from, to, e1)) return { ok: false, detail: "blocked by game validation" };
      laid.push({ prefab, from, to, e1, e2 });
      nextNet += 1;
      return { ok: true, detail: "accepted", created: [{ index: nextNet, version: 1 }] };
    },
    remove: async (entity) => { removed.push(entity.index); if (entity.index === 9) placed = null; return true; },
  };
  return { port, laid, removed };
}
const input = { servedNodes: nodes, servedEdges: edges, isOwned: owned };

describe("selling the surplus power: a transformer between the streets and the map's own high-voltage line (live 2026-10-05: export 0 -> 35,577)", () => {
  test("a surplus beyond the headroom that nothing exports is worth selling; one already sold, or no surplus, is not", () => {
    expect(exportOpportunity({ production: 98_000, consumption: 57_000, exported: 0 }).sell).toBe(true);
    expect(exportOpportunity({ production: 98_000, consumption: 57_000, exported: 30_000 }).sell).toBe(false);
    expect(exportOpportunity({ production: 70_000, consumption: 57_000, exported: 0 }).sell).toBe(false);
    expect(exportOpportunity(null).sell).toBe(false);
  });

  test("the line's free end on owned land is found at its exact coordinates; the other end (off owned land) is not", () => {
    const ends = highVoltageLineEnds(LINE, owned, nodes);
    expect(ends[0]).toMatchObject({ free: true, point: { x: -896.1182, z: -23.4798 } });
    expect(ends.some((end) => end.point.x === -1105)).toBe(false);
  });

  test("the live recipe: the transformer stands, low voltage first to a street NODE at -8, then high voltage at -16 onto the line end, both read back joined", async () => {
    const { port, laid } = world();
    const notes: string[] = [];
    const outcome = await linkPowerExport(port, input, notes);
    expect(outcome.status).toBe("LINKED");
    expect(laid.map((entry) => entry.prefab)).toEqual([LOW_VOLTAGE_CABLE, HIGH_VOLTAGE_CABLE]);
    expect(nodes).toContainEqual(laid[0]!.to);
    expect(laid[0]).toMatchObject({ e1: -8, e2: -8 });
    expect(laid[1]).toMatchObject({ e1: -16, e2: 0, to: { x: -896.1182, z: -23.4798 } });
    expect(notes.join(" | ")).toMatch(/joins the streets to the map's high-voltage line/);
  });

  test("the nearest street node refuses the low-voltage cable: the next node is tried", async () => {
    let refusals = 0;
    const { port, laid } = world({ refuse: (prefab) => prefab === LOW_VOLTAGE_CABLE && refusals++ === 0 });
    expect((await linkPowerExport(port, input, [])).status).toBe("LINKED");
    expect(laid.filter((entry) => entry.prefab === LOW_VOLTAGE_CABLE)).toHaveLength(1);
  });

  test("control: the high voltage cannot be joined at either depth: each transformer is taken down with the cable laid for it, the next lot is tried, at most 3", async () => {
    const { port, removed } = world({ refuse: (prefab) => prefab === HIGH_VOLTAGE_CABLE });
    const notes: string[] = [];
    expect((await linkPowerExport(port, input, notes)).status).toBe("LINK_FAILED");
    expect(removed.filter((index) => index === 9)).toHaveLength(3);
    expect(removed.length).toBe(6);
    expect(notes.filter((note) => /taken down with 1 cable/.test(note))).toHaveLength(3);
  });

  test("the first lot cannot reach the line end but the next can: the first is taken down, the second links", async () => {
    let highTries = 0;
    const { port, removed } = world({ refuse: (prefab) => prefab === HIGH_VOLTAGE_CABLE && highTries++ < 2 });
    expect((await linkPowerExport(port, input, [])).status).toBe("LINKED");
    expect(removed.filter((index) => index === 9)).toHaveLength(1);
  });

  test("control: cables laid but the markers read back unjoined: taken down, nothing left behind", async () => {
    const { port, removed } = world({ joins: false });
    expect((await linkPowerExport(port, input, [])).status).toBe("LINK_FAILED");
    expect(removed.filter((index) => index === 9)).toHaveLength(3);
    expect(removed.length).toBe(9);
  });

  test("control: power already sold, a transformer already standing, or no line on owned land: nothing is placed", async () => {
    expect((await linkPowerExport(world({ trade: { production: 98_000, consumption: 57_000, exported: 35_000 } }).port, input, [])).status).toBe("NOT_NEEDED");
    expect((await linkPowerExport(world({ standing: true }).port, input, [])).status).toBe("STANDING");
    expect((await linkPowerExport(world().port, { ...input, isOwned: () => false }, [])).status).toBe("NO_LINE");
  });
});
