import {
  diagnoseJunction, headCandidates, jammedCorridors, noiseRoads, RoadCare,
  type NodeReading, type RoadCarePort, type TrafficEdge, type TrafficReading,
} from "../../src/main/services/ai-mayor/v2/road-care";
import { protection } from "../../src/main/services/ai-mayor/v2/protection";

const ref = (index: number) => ({ index, version: 1 });
const edge = (index: number, from: number, to: number, flow: number, volume: number, prefab = "Medium Road", aggregate = 900): TrafficEdge => ({
  entity: ref(index), prefab, aggregate: ref(aggregate), startNode: ref(from), endNode: ref(to), position: { x: index * 10, z: 0 }, length: 100,
  volume, flowPercent: flow, wear: 0,
});
const leg = (index: number, prefab: string, flow: number, volume: number, wear = 0) =>
  ({ entity: ref(index), prefab, road: true, startsHere: true, otherNode: ref(index + 1000), length: 100, flowA: flow, flowB: flow, volumeA: volume / 2, volumeB: volume / 2, wear });
const stamp = (frame: number, cycle: number) => ({ frame, cycle });
const HOUR = 262_144 / 24;

describe("road care: traffic at the head of the jam, mechanism first", () => {
  test("jammed corridors are the busy-and-slow edges grouped by their named road, the heaviest loss first; a highway is marked", () => {
    const reading: TrafficReading = { cityFlowPercent: 56, worst: [
      edge(1, 10, 11, 9, 450), edge(2, 11, 12, 10, 440), edge(3, 20, 21, 7, 420, "Highway Oneway - 2 lanes", 800), edge(4, 30, 31, 80, 900), edge(5, 40, 41, 10, 40),
    ] };
    const corridors = jammedCorridors(reading);
    expect(corridors.map((corridor) => corridor.edges.map((entry) => entry.entity.index))).toEqual([[1, 2], [3]]);
    expect(corridors[1]!.highway).toBe(true);
  });

  test("the head is the node where the jammed road meets its free-moving part", () => {
    const jammed = [edge(1, 10, 11, 9, 450), edge(2, 11, 12, 10, 440)];
    const whole = [...jammed, edge(3, 12, 13, 85, 430), edge(0, 9, 10, 12, 300)];
    expect(headCandidates(jammed, whole)[0]).toEqual(ref(12));
  });

  test("lights holding an arterial for small side streets come off; an uncontrolled crossing of two heavy jammed streams gets lights", () => {
    const corridor = new Set(["1:1", "2:1"]);
    const lit: NodeReading = { node: ref(12), position: { x: 0, z: 0 }, trafficLights: true, roundabout: false, allWayStop: false,
      legs: [leg(1, "Medium Road", 10, 450), leg(2, "Medium Road", 12, 440), leg(50, "Small Road", 70, 60)] };
    expect(diagnoseJunction(lit, corridor)).toEqual([expect.objectContaining({ kind: "CONTROL", set: "nolights", was: "lights" })]);
    const open: NodeReading = { ...lit, trafficLights: false, legs: [leg(1, "Medium Road", 10, 450), leg(2, "Medium Road", 12, 440), leg(50, "Medium Road", 15, 400)] };
    // Two heavy jammed streams: a roundabout (the guides' first answer) and lights are both offered; the roundabout ranks first in the pass.
    expect(diagnoseJunction(open, corridor)).toEqual([expect.objectContaining({ kind: "CONTROL", set: "roundabout", was: "default" }),
      expect.objectContaining({ kind: "CONTROL", set: "lights", was: "default" })]);
    // A busy crossing that moves is left alone; a roundabout is never touched.
    expect(diagnoseJunction({ ...open, legs: [leg(1, "Medium Road", 10, 450), leg(2, "Medium Road", 12, 440), leg(50, "Medium Road", 80, 400)] }, corridor)).toEqual([]);
    expect(diagnoseJunction({ ...lit, roundabout: true }, corridor)).toEqual([]);
  });

  test("only a two-lane road carrying arterial traffic is widened, one size; a worn road is named as a maintenance cause", () => {
    const corridor = new Set(["1:1"]);
    const node: NodeReading = { node: ref(12), position: { x: 0, z: 0 }, trafficLights: false, roundabout: false, allWayStop: false,
      legs: [leg(1, "Small Road", 12, 400, 9), leg(50, "Small Road", 80, 30)] };
    const remedies = diagnoseJunction(node, corridor);
    expect(remedies).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "WIDEN", from: "Small Road", to: "Medium Road" }),
      expect.objectContaining({ kind: "CAUSE", why: expect.stringMatching(/road maintenance/) })]));
    // A Medium Road jam is not "solved" by width.
    expect(diagnoseJunction({ ...node, legs: [leg(1, "Medium Road", 12, 400), leg(50, "Small Road", 80, 30)] }, corridor)
      .some((remedy) => remedy.kind === "WIDEN")).toBe(false);
  });

  function fakePort(over: Partial<RoadCarePort> = {}) {
    const calls: string[] = [];
    let corridorFlow = 9;
    const corridor = () => [edge(1, 10, 11, corridorFlow, 450), edge(2, 11, 12, corridorFlow, 440), edge(3, 12, 13, 85, 430)];
    const port: RoadCarePort = {
      near: async () => [],
      upgrade: async () => ({ ok: true, detail: "ok" }),
      traffic: async (options) => options.aggregate !== undefined ? { cityFlowPercent: null, worst: corridor() } : { cityFlowPercent: 56, worst: corridor() },
      node: async (node) => node.index === 12 ? { node, position: { x: 500, z: 500 }, trafficLights: true, roundabout: false, allWayStop: false,
        legs: [leg(2, "Medium Road", corridorFlow, 440), leg(3, "Medium Road", 85, 430), leg(50, "Small Road", 70, 50)] } : null,
      replace: async () => ({ ok: true, detail: "ok", buildingsDeleted: 0 }),
      control: async (node, set, preview) => { calls.push(`${set}${preview ? "?" : ""}@${node.index}`); return { ok: true, detail: "ok" }; },
      ...over,
    };
    return { port, calls, setFlow: (flow: number) => { corridorFlow = flow; } };
  }

  test("a change is a trial: previewed, applied, read again after the trial hours, and taken back when the corridor got worse", async () => {
    const { port, calls, setFlow } = fakePort();
    const care = new RoadCare(port);
    const notes: string[] = [];
    const changes = await care.traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true });
    expect(changes).toBe(1);
    expect(calls).toEqual(["nolights?@12", "nolights@12"]);
    expect(notes.join(" | ")).toMatch(/traffic lights hold the arterial .* removed, the side streets yield — done/);
    // Too early: nothing judged. After the trial hours, worse: the lights go back.
    setFlow(2);
    await care.traffic(stamp(HOUR, 2), notes, { spend: () => true, mayWiden: true });
    expect(calls).toHaveLength(2);
    await care.traffic(stamp(5 * HOUR, 3), notes, { spend: () => true, mayWiden: true });
    expect(calls).toContain("lights@12");
    expect(notes.join(" | ")).toMatch(/flow 9% → 2% .* worse, taken back/);
  });

  test("a trial survives a restart of the run process: it is judged afterwards, taken back when worse, and the change is not repeated", async () => {
    const first = fakePort();
    let saved: ReturnType<RoadCare["snapshot"]> | null = null;
    const care = new RoadCare(first.port, null, (memory) => { saved = JSON.parse(JSON.stringify(memory)); });
    await care.traffic(stamp(0, 1), [], { force: true, spend: () => true, mayWiden: true });
    expect(saved).not.toBeNull();
    expect(saved!.trials).toHaveLength(1);
    expect(saved!.trials[0]!.revert).toEqual({ node: ref(12), set: "lights" });
    // The process is gone (the first RoadCare with it); a new one starts from the saved record, the corridor is worse after the trial hours.
    const second = fakePort();
    second.setFlow(2);
    const reborn = new RoadCare(second.port, saved, (memory) => { saved = JSON.parse(JSON.stringify(memory)); });
    expect(reborn.trialsRunning).toBe(1);
    const notes: string[] = [];
    await reborn.traffic(stamp(5 * HOUR, 1), notes, { spend: () => true, mayWiden: true });
    expect(second.calls).toContain("lights@12");
    expect(notes.join(" | ")).toMatch(/flow 9% → 2% .* worse, taken back/);
    // (the junction change is judged and gone; with nothing left to change at its junctions the corridor itself is then re-laid, as its own trial)
    expect(saved!.trials.filter((trial) => !trial.key.startsWith("corridor:"))).toHaveLength(0);
    // The change that was taken back is remembered as tried: a third process does not make it again.
    const third = fakePort();
    const again = new RoadCare(third.port, saved);
    await again.traffic(stamp(9 * HOUR, 1), [], { force: true, spend: () => true, mayWiden: true });
    expect(third.calls.filter((call) => call === "nolights@12")).toHaveLength(0);
  });

  test("a jammed highway is answered where its ramp meets the streets: a roundabout first, then the arterial re-laid one size up (unlocked first), each once and judged", async () => {
    const highway = [edge(1, 10, 11, 8, 440, "Highway Oneway - 2 lanes", 900), edge(2, 11, 12, 9, 430, "Highway Oneway - 2 lanes", 900)];
    const calls: string[] = [];
    const unlocked: string[] = [];
    const port: RoadCarePort = {
      near: async () => [], upgrade: async () => ({ ok: true, detail: "ok" }),
      traffic: async () => ({ cityFlowPercent: 60, worst: highway }),
      node: async (node) => node.index === 12 ? { node, position: { x: 900, z: 900 }, trafficLights: true, roundabout: false, allWayStop: false,
        legs: [leg(2, "Highway Oneway - 2 lanes", 9, 430), leg(60, "Medium Road", 7, 300), leg(61, "Small Road", 50, 20)] } : null,
      replace: async (target, prefab, preview) => { calls.push(`${prefab}${preview ? "?" : ""}@${target.index}`); return { ok: true, detail: "ok", buildingsDeleted: 0 }; },
      control: async (node, set, preview) => { calls.push(`${set}${preview ? "?" : ""}@${node.index}`); return { ok: true, detail: "ok" }; },
      unlockRoad: async (prefab) => { unlocked.push(prefab); return true; },
    };
    const care = new RoadCare(port);
    const notes: string[] = [];
    expect(await care.traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true })).toBe(1);
    expect(calls).toEqual(["roundabout?@12", "roundabout@12"]);
    expect(notes.join(" | ")).toMatch(/ramp meets the streets becomes a roundabout — done/);
    // The next pass (the roundabout judged) goes on to the arterial the ramp feeds.
    const later: string[] = [];
    expect(await care.traffic(stamp(HOUR * 9, 2), later, { force: true, spend: () => true, mayWiden: true })).toBe(1);
    expect(unlocked).toEqual(["Large Road"]);
    expect(calls.slice(2)).toEqual(["Large Road?@60", "Large Road@60"]);
    expect(later.join(" | ")).toMatch(/Medium Road that a jammed highway ends in .* re-laid as Large Road — done/);
    // Nothing is done twice, and without the player's leave to change roads nothing is written.
    expect(await care.traffic(stamp(HOUR * 18, 3), [], { force: true, spend: () => true, mayWiden: true })).toBe(0);
    expect(calls).toHaveLength(4);
    const closed = new RoadCare(port);
    expect(await closed.traffic(stamp(0, 1), [], { force: true, spend: () => true, mayWiden: false })).toBe(0);
    expect(calls).toHaveLength(4);
  });
  test("a street corridor slow from end to end, with nothing to change at its junctions, is re-laid one size up as one trial (0 buildings lost each piece), once", async () => {
    const run = [edge(1, 10, 11, 9, 450), edge(2, 11, 12, 8, 440), edge(3, 12, 13, 10, 430), edge(4, 13, 14, 9, 420)];
    const calls: string[] = [];
    const unlocked: string[] = [];
    const plain = (node: { index: number; version: number }): NodeReading => ({ node, position: { x: 0, z: 0 }, trafficLights: false, roundabout: false, allWayStop: false,
      legs: [leg(1, "Medium Road", 9, 450, 2), leg(2, "Medium Road", 8, 440, 2)] });
    const port: RoadCarePort = {
      near: async () => [], upgrade: async () => ({ ok: true, detail: "ok" }),
      traffic: async () => ({ cityFlowPercent: 56, worst: run }),
      node: async (node) => plain(node),
      replace: async (target, prefab, preview) => { calls.push(`${prefab}${preview ? "?" : ""}@${target.index}`); return { ok: true, detail: "ok", buildingsDeleted: 0 }; },
      control: async () => ({ ok: true, detail: "ok" }),
      unlockRoad: async (prefab) => { unlocked.push(prefab); return true; },
    };
    const care = new RoadCare(port);
    const notes: string[] = [];
    expect(await care.traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true })).toBe(1);
    expect(unlocked).toEqual(["Large Road"]);
    expect(calls.filter((call) => !call.includes("?"))).toHaveLength(4);
    expect(notes.join(" | ")).toMatch(/corridor is slow from end to end .* 4 of 4 pieces re-laid as Large Road — done/);
    // Once per road; and never without the player's leave to change roads.
    expect(await care.traffic(stamp(HOUR * 9, 2), [], { force: true, spend: () => true, mayWiden: true })).toBe(0);
    const closed = new RoadCare(port);
    const before = calls.length;
    expect(await closed.traffic(stamp(0, 1), [], { force: true, spend: () => true, mayWiden: false })).toBe(0);
    expect(calls).toHaveLength(before);
  });
  test("a better corridor keeps the change; a junction never gets the same change twice", async () => {
    const { port, calls, setFlow } = fakePort();
    const care = new RoadCare(port);
    const notes: string[] = [];
    await care.traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true });
    setFlow(40);
    await care.traffic(stamp(5 * HOUR, 2), notes, { force: true, spend: () => true, mayWiden: true });
    expect(notes.join(" | ")).toMatch(/flow 9% → .* better, kept/);
    expect(calls.filter((call) => call === "nolights@12")).toHaveLength(1);
  });

  test("plain bends along the jam do not use up the look: the over-lit junction further on is found and its lights come off first", async () => {
    const calls: string[] = [];
    const corridor = [edge(1, 10, 11, 8, 440), edge(2, 11, 12, 8, 440), edge(4, 12, 14, 8, 440), edge(5, 14, 15, 8, 440), edge(3, 15, 16, 85, 430)];
    const bend = (node: { index: number; version: number }): NodeReading => ({ node, position: { x: 0, z: 0 }, trafficLights: false, roundabout: false, allWayStop: false,
      legs: [leg(1, "Medium Road", 8, 440, 10), leg(2, "Medium Road", 8, 440, 10)] });
    const care = new RoadCare({
      near: async () => [], upgrade: async () => ({ ok: true, detail: "" }),
      traffic: async () => ({ cityFlowPercent: 50, worst: corridor }),
      node: async (node) => node.index !== 14 ? bend(node) : { node, position: { x: 900, z: 900 }, trafficLights: true, roundabout: false, allWayStop: false,
        legs: [leg(4, "Medium Road", 8, 440), leg(5, "Medium Road", 8, 440), leg(60, "Medium Road", 70, 50)] },
      replace: async () => ({ ok: false, detail: "", buildingsDeleted: null }),
      control: async (node, set, preview) => { calls.push(`${set}${preview ? "?" : ""}@${node.index}`); return { ok: true, detail: "ok" }; },
    });
    const notes: string[] = [];
    await care.traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true });
    expect(calls).toEqual(["nolights?@14", "nolights@14"]);
    expect(notes.filter((note) => /worn road/.test(note))).toHaveLength(1);
  });

  test("an older game mod without the intersection read is named, and nothing is written", async () => {
    const { port, calls } = fakePort({ node: async () => null });
    const notes: string[] = [];
    expect(await new RoadCare(port).traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true })).toBe(0);
    expect(calls).toEqual([]);
    expect(notes.join(" | ")).toMatch(/no intersection read/);
  });

  test("widening is refused when the game's preview would take a building down, and never inside a kept area", async () => {
    const replaced: string[] = [];
    const smallRoad = () => [edge(1, 10, 11, 12, 400, "Small Road"), edge(3, 11, 13, 85, 300, "Small Road")];
    const base = {
      near: async () => [], upgrade: async () => ({ ok: true, detail: "ok" }),
      traffic: async () => ({ cityFlowPercent: 50, worst: smallRoad() }),
      node: async (node: { index: number; version: number }) => ({ node, position: { x: 0, z: 0 }, trafficLights: false, roundabout: false, allWayStop: false,
        legs: [leg(1, "Small Road", 12, 400), leg(3, "Small Road", 85, 300), leg(50, "Small Road", 80, 20)] }),
      control: async () => ({ ok: true, detail: "ok" }),
    };
    const notes: string[] = [];
    await new RoadCare({ ...base, replace: async (_edge, prefab, preview) => { replaced.push(`${prefab}${preview ? "?" : ""}`); return { ok: true, detail: "ok", buildingsDeleted: preview ? 2 : 0 }; } })
      .traffic(stamp(0, 1), notes, { force: true, spend: () => true, mayWiden: true });
    expect(replaced).toEqual(["Medium Road?"]);
    expect(notes.join(" | ")).toMatch(/would take down 2 building/);
    protection.set([{ name: "Old Town", source: "test", polygon: [{ x: -50, z: -50 }, { x: 50, z: -50 }, { x: 50, z: 50 }, { x: -50, z: 50 }] }]);
    try {
      replaced.length = 0;
      await new RoadCare({ ...base, replace: async (_edge, prefab) => { replaced.push(prefab); return { ok: true, detail: "ok", buildingsDeleted: 0 }; } })
        .traffic(stamp(0, 1), [], { force: true, spend: () => true, mayWiden: true });
      expect(replaced).toEqual([]);
    } finally { protection.clear(); }
  });
});

describe("road care: road noise", () => {
  test("the street beside a noisy home gets trees, a highway a sound barrier; cables, pipes and roads done before are skipped", () => {
    const home = { x: 0, z: 0 };
    const roads = [
      { entity: ref(1), prefab: "Medium Road", start: { x: -100, z: 20 }, end: { x: 100, z: 20 } },
      { entity: ref(2), prefab: "Highway Oneway - 2 lanes", start: { x: -100, z: -40 }, end: { x: 100, z: -40 } },
      { entity: ref(3), prefab: "Low-voltage Ground Cable", start: { x: -100, z: 5 }, end: { x: 100, z: 5 } },
      { entity: ref(4), prefab: "Small Road", start: { x: -100, z: 200 }, end: { x: 100, z: 200 } },
    ];
    const plan = noiseRoads([{ icon: home, roads }], new Set());
    expect(plan.map((entry) => [entry.road.entity.index, entry.upgrade])).toEqual([[1, "trees"], [2, "soundBarrier"]]);
    expect(noiseRoads([{ icon: home, roads }], new Set(["-100,20|100,20"])).map((entry) => entry.road.entity.index)).toEqual([2]);
  });

  test("the pass upgrades each road once and says the traffic is the root", async () => {
    const upgraded: string[] = [];
    const care = new RoadCare({
      near: async () => [{ entity: ref(1), prefab: "Medium Road", start: { x: -100, z: 20 }, end: { x: 100, z: 20 } }],
      upgrade: async (entity, upgrade) => { upgraded.push(`${entity.index}:${upgrade}`); return { ok: true, detail: "ok" }; },
      traffic: async () => null, node: async () => null, replace: async () => ({ ok: false, detail: "", buildingsDeleted: null }), control: async () => ({ ok: false, detail: "" }),
    });
    const notes: string[] = [];
    const icons = [{ type: "Noise Pollution", x: 0, z: 0 }, { type: "Noise Pollution", x: 10, z: 0 }];
    await care.noise(icons, notes, () => true);
    await care.noise(icons, notes, () => true);
    expect(upgraded).toEqual(["1:trees"]);
    expect(notes[0]).toMatch(/2 noise icon\(s\) on homes; 1 of 1 road\(s\) beside them given trees/);
  });
});
