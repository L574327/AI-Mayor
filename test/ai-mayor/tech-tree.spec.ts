import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import {
  nextPurchase, planPath, railNodeFallback, requiredNodeNames, unlockRailway, type PrefabLock, type TechNode, type TechTree, type TechTreePort,
} from "../../src/main/services/ai-mayor/v2/tech-tree";

/** The shape of the game's tree (Game.City.DevTreeSystem): points per milestone; a node needs ONE unlocked previous node; its service must be unlocked. */
const node = (name: string, cost: number, locked: boolean, requirements: Array<[string, boolean]> = [], overrides: Partial<TechNode> = {}): TechNode => {
  const prerequisiteOpen = requirements.length === 0 || requirements.some(([, lockedRequirement]) => !lockedRequirement);
  const refusals = locked ? [...(prerequisiteOpen ? [] : ["PREVIOUS_NODE_LOCKED: none of the required nodes is unlocked yet"])] : ["NODE_ALREADY_UNLOCKED"];
  return { name, service: "Public Transport", serviceLocked: false, cost, locked, requirements: requirements.map(([required, lockedRequirement]) => ({ name: required, locked: lockedRequirement })),
    purchasable: locked && prerequisiteOpen, refusals, ...overrides };
};
const tree = (points: number, nodes: TechNode[]): TechTree => ({ points, nodes });
const lock = (prefab: string, nodes: string[]): PrefabLock => ({ prefab, locked: true, requirements: nodes.map((name) => ({ name, kind: "devTreeNode", locked: true, cost: 3, flags: "RequireAny" })) });

describe("the development tree: what to buy for the railway, and in what order", () => {
  const nodes = [node("Buses", 1, false), node("Trams", 2, true, [["Buses", false]]), node("TrainStations", 4, true, [["Trams", true]]), node("TrainTracks", 3, true, [["TrainStations", true]])];

  test("the railway prefabs name the nodes they need; the chain of previous nodes under each is bought previous-first, one unlocked previous node being enough", () => {
    const plan = planPath(tree(10, nodes), requiredNodeNames([lock("TrainStation01", ["TrainStations"]), lock("Double Train Track", ["TrainTracks"])]));
    expect(plan.steps.map((step) => step.name)).toEqual(["Trams", "TrainStations", "TrainTracks"]);
    expect(plan.totalCost).toBe(9);
    expect(plan.reachable).toBe(true);
  });

  test("the next purchase is the first step the game lets us buy now; with too few points nothing is bought and the wait is reported", () => {
    const plan = planPath(tree(10, nodes), ["TrainStations"]);
    expect(nextPurchase(plan, 10)?.name).toBe("Trams");
    expect(nextPurchase(plan, 1)).toBeNull();
    // Trams bought: TrainStations opens.
    const later = planPath(tree(10, [node("Buses", 1, false), node("Trams", 2, false, [["Buses", false]]), node("TrainStations", 4, true, [["Trams", false]])]), ["TrainStations"]);
    expect(later.steps.map((step) => step.name)).toEqual(["TrainStations"]);
    expect(nextPurchase(later, 4)?.name).toBe("TrainStations");
  });

  test("two previous nodes: the cheaper chain is taken; a node whose previous node is unlocked needs nothing under it; an unlocked target needs nothing", () => {
    const two = [node("A", 5, true), node("B", 1, true), node("T", 2, true, [["A", true], ["B", true]])];
    expect(planPath(tree(9, two), ["T"]).steps.map((step) => step.name)).toEqual(["B", "T"]);
    expect(planPath(tree(9, [node("T", 2, false)]), ["T"])).toMatchObject({ steps: [], reachable: true });
  });

  test("control: a node the tree does not list, or a cycle, is unreachable and says so — nothing is bought on a guess", () => {
    expect(planPath(tree(9, nodes), ["Nope"])).toMatchObject({ reachable: false });
    const cycle = [node("X", 1, true, [["Y", true]]), node("Y", 1, true, [["X", true]])];
    expect(planPath(tree(9, cycle), ["X"]).reachable).toBe(false);
  });

  test("when the prefabs list no node requirement, the nodes named like the railway are the targets (last resort)", () => {
    expect(railNodeFallback(tree(0, [node("Buses", 1, true), node("Train Stations", 2, true), node("Metro", 2, true, [], { service: "Train Service" })]))).toEqual(["Train Stations", "Metro"]);
  });
});

describe("unlockRailway: one look, at most one purchase, the reasons in the notes", () => {
  const port = (treeValue: TechTree | null, locks: PrefabLock[] | null, bought: string[] = [], refuse = false): TechTreePort => ({
    read: async () => treeValue, prefabLocks: async () => locks,
    purchase: async (name) => { bought.push(name); return refuse ? { ok: false, detail: "NOT_ENOUGH_POINTS" } : { ok: true, detail: "requested" }; },
  });
  const full = tree(6, [node("Buses", 1, false), node("Trams", 2, true, [["Buses", false]]), node("TrainStations", 4, true, [["Trams", true]])]);

  test("buys the first step the points allow, and says what is left", async () => {
    const bought: string[] = []; const notes: string[] = [];
    const outcome = await unlockRailway(port(full, [lock("TrainStation01", ["TrainStations"])], bought), notes);
    expect(outcome).toMatchObject({ status: "BOUGHT", node: "Trams", pointsLeft: 4 });
    expect(bought).toEqual(["Trams"]);
    expect(notes.join(" ")).toMatch(/tech: bought Trams \(cost 2, 4 points left\)/);
  });

  test("control: too few points: nothing is bought, the chain and the points are reported; unreadable tree and unreachable node are reported, not guessed", async () => {
    const bought: string[] = []; const notes: string[] = [];
    expect((await unlockRailway(port(tree(1, full.nodes), [lock("TrainStation01", ["TrainStations"])], bought), notes)).status).toBe("WAITING_POINTS");
    expect(bought).toEqual([]);
    expect(notes.join(" ")).toMatch(/Trams \(2\) -> TrainStations \(4\) = 6 points; 1 available.*waiting for the next milestone/);
    const unreadable: string[] = [];
    expect((await unlockRailway(port(null, null), unreadable)).status).toBe("UNREADABLE");
    expect(unreadable.join(" ")).toMatch(/cannot be read/);
    expect((await unlockRailway(port(full, [lock("TrainStation01", ["Missing"])]), [])).status).toBe("UNREACHABLE");
  });

  test("control: the railway prefabs not locked: nothing to buy; the game refusing the purchase is reported", async () => {
    expect((await unlockRailway(port(full, [{ prefab: "TrainStation01", locked: false, requirements: [] }]), [])).status).toBe("NOTHING_TO_BUY");
    const notes: string[] = [];
    expect((await unlockRailway(port(full, [lock("TrainStation01", ["TrainStations"])], [], true), notes)).status).toBe("REFUSED");
    expect(notes.join(" ")).toMatch(/the game refused Trams: NOT_ENOUGH_POINTS/);
  });
});

describe("through the district builder: a locked railway is worked toward with development points, not waited for as a milestone reward", () => {
  const nodeAt = (x: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 });
  const streets = (() => {
    const a = nodeAt(0, 1); const b = nodeAt(300, 2);
    return { roadGraph: { nodes: [a, b], edges: [{ entity: { index: 3, version: 1 }, prefab: "Medium Road", native: false, startNode: a.entity, endNode: b.entity, start: { x: 0, y: 0, z: 0 }, end: { x: 300, y: 0, z: 0 } }] }, ownedTiles: [] } as never;
  })();

  test("the stations are locked: the tree is read, the first affordable node is bought, and the note says so; once bought the build can start on a later look", async () => {
    const bought: string[] = [];
    let trams = false;
    const port: DistrictBuilderPort = {
      scanWorld: async () => streets, listBuildings: async () => [], siteDetail: async () => null, buildRoad: async () => ({ ok: true, detail: "ok" }), zone: async () => ({ ok: true, detail: "ok" }),
      trainLink: { railEdges: async () => [], stationPrefabs: async () => [], trackPrefab: async () => null, listStations: async () => [], preflight: async () => true, place: async () => ({ ok: false, detail: "" }),
        ownedTracks: async () => null, frontage: async () => null, lay: async () => ({ ok: false, detail: "" }), remove: async () => true },
      techTree: { read: async () => ({ points: 6, nodes: [node("Buses", 1, false), node("Trams", 2, !trams, [["Buses", false]]), node("TrainStations", 4, true, [["Trams", !trams]])] }),
        prefabLocks: async () => [lock("TrainStation01", ["TrainStations"])], purchase: async (name) => { bought.push(name); if (name === "Trams") trams = true; return { ok: true, detail: "requested" }; } },
    };
    const builder = new DistrictBuilder(port, { maximumSitesPerCycle: 1 });
    const result = await builder.runCycle({ demand: { residential: 0, commercial: 0, industrial: 0 }, zoneFor: () => null, pipelined: true, mayPurchaseLand: false, population: 16_000,
      finance: { treasury: 600_000, monthlyBalance: 500_000 } } as never);
    expect(bought).toEqual(["Trams"]);
    expect(result.notes.join(" | ")).toMatch(/tech: bought Trams \(cost 2, 4 points left\)/);
  });
});