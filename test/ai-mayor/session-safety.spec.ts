import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import {
  checkpointSlotName, CHECKPOINT_MIN_INTERVAL_MS, decideCheckpoint, memoryVerdict, WorldWatch,
} from "../../src/main/services/ai-mayor/v2/session-safety";

describe("session safety: the game stays alive and the Mayor re-reads after a disconnect", () => {
  test("short free commit memory holds back only our own checkpoint save; unknown memory holds back nothing", () => {
    expect(memoryVerdict(12)).toBe("OK");
    expect(memoryVerdict(4.3)).toBe("NO_CHECKPOINT");
    expect(memoryVerdict(2.5)).toBe("NO_CHECKPOINT");
    expect(memoryVerdict(null)).toBe("OK");
  });

  test("a checkpoint follows a confirmed batch, not every primitive, not too often, and never on a memory-starved machine", () => {
    const base = { nowMs: 1_000_000, lastCheckpointMs: null, freeCommitGb: 20, batchConfirmed: true };
    expect(decideCheckpoint(base).save).toBe(true);
    expect(decideCheckpoint({ ...base, batchConfirmed: false }).save).toBe(false);
    expect(decideCheckpoint({ ...base, lastCheckpointMs: base.nowMs - 60_000 }).save).toBe(false);
    expect(decideCheckpoint({ ...base, lastCheckpointMs: base.nowMs - CHECKPOINT_MIN_INTERVAL_MS - 1 }).save).toBe(true);
    expect(decideCheckpoint({ ...base, freeCommitGb: 4.3 }).save).toBe(false);
  });

  test("checkpoints rotate through a few named slots", () => {
    expect([0, 1, 2, 3, 4].map(checkpointSlotName)).toEqual(["AI Mayor Checkpoint 1", "AI Mayor Checkpoint 2", "AI Mayor Checkpoint 3", "AI Mayor Checkpoint 1", "AI Mayor Checkpoint 2"]);
  });

  test("an unreachable game is UNREACHABLE; its return, a different world, or a clock that went backwards is a REBASELINE", () => {
    const watch = new WorldWatch();
    expect(watch.observe({ id: "epoch:a:1", frame: 1_000 })).toBe("SAME");
    expect(watch.observe({ id: "epoch:a:1", frame: 2_000 })).toBe("SAME");
    expect(watch.observe(null)).toBe("UNREACHABLE");
    expect(watch.observe(null)).toBe("UNREACHABLE");
    // Back after a disconnect, same world: everything is re-read anyway.
    expect(watch.observe({ id: "epoch:a:1", frame: 2_500 })).toBe("REBASELINE");
    expect(watch.observe({ id: "epoch:a:1", frame: 3_000 })).toBe("SAME");
    // The player loaded another save, or an older one into the same session.
    expect(watch.observe({ id: "epoch:a:2", frame: 3_100 })).toBe("REBASELINE");
    expect(watch.observe({ id: "epoch:a:2", frame: 500 })).toBe("REBASELINE");
    // A game restart changes the epoch.
    expect(watch.observe({ id: "epoch:b:2", frame: 600 })).toBe("REBASELINE");
  });

  test("a rebaseline makes the builder forget which streets it laid, so nothing is bulldozed in a world it has not read", async () => {
    // Same fixture as the cleanup tests: a stub street joined to nothing, laid by this Mayor — removable until the world changes.
    const node = (x: number, z: number, index: number) => ({ entity: { index, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
    const a = node(0, 600, 9001), b = node(120, 600, 9002);
    const nodes = Array.from({ length: 25 }, (_, i) => node(i * 40, 0, 9100 + i));
    const edges = nodes.slice(0, -1).map((n, i) => ({ entity: { index: 9200 + i, version: 1 }, prefab: "Medium Road", native: false, startNode: n.entity, endNode: nodes[i + 1]!.entity,
      start: { x: n.position.x, y: 0, z: 0 }, end: { x: nodes[i + 1]!.position.x, y: 0, z: 0 } }));
    edges.push({ entity: { index: 9300, version: 1 }, prefab: "Medium Road", native: false, startNode: a.entity, endNode: b.entity, start: { x: 0, y: 0, z: 600 }, end: { x: 120, y: 0, z: 600 } });
    const world = { roadGraph: { nodes: [...nodes, a, b], edges }, ownedTiles: [] } as never;
    const gone: number[] = [];
    const port: DistrictBuilderPort = { scanWorld: async () => world, listBuildings: async () => [], siteDetail: async () => null,
      buildRoad: async () => ({ ok: true, detail: "" }), zone: async () => ({ ok: true, detail: "" }), demolishRoad: async (entity) => { gone.push(entity.index); return true; } };
    const builder = new DistrictBuilder(port);
    builder.markOwn({ start: { x: 0, z: 600 }, end: { x: 120, z: 600 } });
    builder.rebaseline();
    expect(await builder.removeOrphanStubs(world, [], [])).toBe(0);
    expect(gone).toEqual([]);
    // Control: without the rebaseline the same street is ours and is removed.
    const control = new DistrictBuilder(port);
    control.markOwn({ start: { x: 0, z: 600 }, end: { x: 120, z: 600 } });
    expect(await control.removeOrphanStubs(world, [], [])).toBe(1);
  });
});

