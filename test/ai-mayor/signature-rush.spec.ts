import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { signatureCandidates, signaturesToPlace } from "../../src/main/services/ai-mayor/v2/signature-rush";

/** Live 2026-10-05 (萨利克斯, M3): one unlocked signature building placed gave +250 XP at once, cost nothing and added no service upkeep. */
const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
const nodes = Array.from({ length: 8 }, (_, i) => node(-280 + i * 80, 0, 100 + i));
const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
  start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -900, z: -900 }, max: { x: 900, z: 900 } }, center: { x: 0, z: 0 },
  polygon: [{ x: -900, z: -900 }, { x: 900, z: -900 }, { x: 900, z: 900 }, { x: -900, z: 900 }] };

describe("signature buildings for XP: placed once each, as soon as unlocked", () => {
  test("only unlocked signatures that do not stand yet are wanted", () => {
    expect(signaturesToPlace([{ name: "EU_ResidentialLowSignature01", locked: false }, { name: "EU_ResidentialMediumRowSignature01", locked: false },
      { name: "OfficeHighSignature01", locked: true }, { name: "Hospital01", locked: false }], new Set(["EU_ResidentialMediumRowSignature01"]))).toEqual(["EU_ResidentialLowSignature01"]);
  });

  test("lots facing a street come first, then free ground beside street nodes; only owned land", () => {
    const candidates = signatureCandidates({ edges: edges as never, nodes: nodes.map((n) => ({ x: n.position.x, z: 0 })), isOwned: (point) => point.z > -1000, centre: { x: 0, z: 0 } });
    const firstOff = candidates.findIndex((candidate) => !candidate.facesStreet);
    expect(firstOff).toBeGreaterThan(0);
    expect(candidates.slice(firstOff).every((candidate) => !candidate.facesStreet)).toBe(true);
    expect(signatureCandidates({ edges: edges as never, nodes: [], isOwned: () => false, centre: { x: 0, z: 0 } })).toHaveLength(0);
  });

  function run(options: { legal: (point: { x: number; z: number }) => boolean; locked?: boolean; standing?: boolean }) {
    let xp = 6_400;
    const placed: Array<{ prefab: string; x: number; z: number }> = [];
    const port: DistrictBuilderPort = {
      scanWorld: async () => ({ roadGraph: { nodes, edges }, ownedTiles: [tile] }) as never, listBuildings: async () => [],
      siteDetail: async (center, radius) => ({ center, radius, roadGraph: { nodes: [], edges: [] }, buildings: [], zoningCells: [] }) as never,
      buildRoad: async () => ({ ok: true, detail: "ok" }), zone: async () => ({ ok: true, detail: "ok" }),
      findPrefabs: async (query) => (query === "Signature" ? [{ name: "EU_ResidentialLowSignature01", locked: options.locked ?? false }, { name: "OfficeHighSignature01", locked: true }] : []),
      readProgress: async () => ({ milestone: 3, xp, nextMilestoneXp: 8_300, gameDateTime: "2026-01-07 16:00" }),
      utilities: {
        listFacilities: async (prefab) => [...(options.standing && prefab === "EU_ResidentialLowSignature01" ? [{ entity: { index: 7, version: 1 }, position: { x: 5, z: 5 } }] : []),
          ...placed.filter((entry) => entry.prefab === prefab).map((entry) => ({ entity: { index: 9, version: 1 }, position: { x: entry.x, z: entry.z } }))],
        preflight: async (_prefab, point) => options.legal(point),
        place: async (prefab, point) => { placed.push({ prefab, x: point.x, z: point.z }); xp += 250; return { ok: true, detail: "placed" }; },
        attached: async () => true,
      },
    };
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    const cycle = () => builder.runCycle({ demand: { residential: 80, commercial: 0, industrial: 0 }, zoneFor: () => "EU Zone", pipelined: true, mayPurchaseLand: false,
      population: 2_234, finance: { treasury: 960_000, monthlyBalance: 290_000 } } as never);
    return { cycle, placed };
  }

  test("an unlocked signature is placed on the first lot the game accepts, and the XP it gave is read back into the notes", async () => {
    const { cycle, placed } = run({ legal: () => true });
    const result = await cycle();
    expect(placed).toEqual([expect.objectContaining({ prefab: "EU_ResidentialLowSignature01" })]);
    expect(result.notes.join(" | ")).toMatch(/signature EU_ResidentialLowSignature01: placed at .* facing a street — stands \(read back\); XP \+250 \(P1 XP action\)/);
  });

  test("the street frontage is all taken: free ground beside a street is used, and the note says it has no frontage", async () => {
    const { cycle, placed } = run({ legal: (point) => Math.abs(point.z) >= 40 });
    const result = await cycle();
    expect(placed).toHaveLength(1);
    expect(result.notes.join(" | ")).toMatch(/on free ground \(no frontage\)/);
  });

  test("control: placed once only; a locked one or one already standing is never placed", async () => {
    const once = run({ legal: () => true });
    await once.cycle();
    await once.cycle();
    expect(once.placed).toHaveLength(1);
    const locked = run({ legal: () => true, locked: true });
    await locked.cycle();
    expect(locked.placed).toHaveLength(0);
    const standing = run({ legal: () => true, standing: true });
    await standing.cycle();
    expect(standing.placed).toHaveLength(0);
  });

  test("control: no lot accepted: nothing placed, the note says so, and it is not asked again in the same game hours", async () => {
    const { cycle, placed } = run({ legal: () => false });
    const result = await cycle();
    expect(placed).toHaveLength(0);
    expect(result.notes.join(" | ")).toMatch(/unlocked, but no lot the game accepts/);
    const again = await cycle();
    expect(again.notes.join(" | ")).not.toMatch(/signature EU_ResidentialLowSignature01/);
  });
});
