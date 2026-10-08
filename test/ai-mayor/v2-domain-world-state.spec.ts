import { DomainWorldStateCache, matchUtilityConnectionEffect, recomputeOnUtilityRevision, type UtilityWorldState } from "../../src/main/services/ai-mayor/v2/domain-world-state";
import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB } from "../../src/main/services/ai-mayor/spatial/types";
import type { ImmutableElectricityTargetSemantics } from "../../src/main/services/ai-mayor/v2/utility-target-binding";

const identity = { worldId: "world-1", checkpointId: "save-1", generation: "gen-1" };
const connector = { index: 21, version: 2 };
const action = { type: "build_road" as const, prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
  x1: 1, z1: 2, x2: 5, z2: 6 };
const semantic = {
  schemaVersion: "ai-mayor-v2-electricity-target/1",
  approvedContact: { x: 5, z: 6 },
  targetRoad: { prefab: "Medium Road", endpointRole: "start", anchor: { x: 5, z: 6 } },
} as ImmutableElectricityTargetSemantics;
const baseWorld = (): UtilityWorldState => ({ identity, readbackComplete: true,
  facility: { entity: { index: 20, version: 1 }, prefab: "WindTurbine03", position: { x: 0, z: 0 } },
  connector: { entity: connector, attached: true, orphan: false }, targetResolutionComplete: true,
  resolvedEndpoint: { road: { index: 30, version: 1 }, node: { index: 31, version: 1 }, flowNode: null,
    prefab: "Medium Road", role: "start", position: { x: 5, y: 0, z: 6 } },
  topology: { binding: { bindingStatus: "VALID", complete: true, truncated: false },
    targetNetwork: { complete: true, truncated: false, targetNetworkReachable: true },
    connector: { physicalEdges: [{ entity: { index: 40, version: 1 }, incidentNode: connector }] },
    candidateScan: { complete: true, truncated: false, edges: [{ entity: { index: 40, version: 1 }, prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
      permanent: true, temp: false, deleted: false, start: { x: 1, z: 2 }, end: { x: 5, z: 6 } }] } },
});

describe("domain WorldState and utility effect matcher", () => {
  it("turns a complete exact authoritative effect into OBSERVED_MATCH", () => {
    expect(matchUtilityConnectionEffect({ action, expectedConnector: connector, semantic, world: baseWorld() }).verdict)
      .toBe("OBSERVED_MATCH");
  });

  it("matches the physical cable independently of network reachability and node geometry", () => {
    const world = baseWorld();
    const targetNetwork = world.topology!.targetNetwork as Record<string, unknown>;
    targetNetwork.targetNetworkReachable = false;
    world.resolvedEndpoint!.position.x += 12;
    world.resolvedEndpoint!.position.z += 12;
    expect(matchUtilityConnectionEffect({ action, expectedConnector: connector, semantic, world }))
      .toMatchObject({ verdict: "OBSERVED_MATCH" });
  });

  it("proves OBSERVED_ABSENT only from complete road and connector readback", () => {
    const world = baseWorld(); world.resolvedEndpoint = null; world.topology = null;
    expect(matchUtilityConnectionEffect({ action, expectedConnector: connector, semantic, world }).verdict).toBe("OBSERVED_ABSENT");
    world.readbackComplete = false;
    expect(matchUtilityConnectionEffect({ action, expectedConnector: connector, semantic, world }).verdict).toBe("UNKNOWN");
  });

  it("keeps incomplete or stale connector evidence UNKNOWN", () => {
    const world = baseWorld(); world.connector = null;
    expect(matchUtilityConnectionEffect({ action, expectedConnector: connector, semantic, world }).verdict).toBe("UNKNOWN");
    const rebound = baseWorld(); rebound.connector = { entity: { index: 99, version: 1 }, attached: true, orphan: false };
    expect(matchUtilityConnectionEffect({ action, expectedConnector: connector, semantic, world: rebound }).verdict).toBe("UNKNOWN");
  });

  it("advances utility revision only when an authoritative utility snapshot changes", () => {
    const cache = new DomainWorldStateCache();
    expect(cache.refresh("UTILITY", { identity, observedAt: "t1", complete: true, value: { connector: 1 } })).toBe(1);
    expect(cache.refresh("UTILITY", { identity, observedAt: "t2", complete: true, value: { connector: 1 } })).toBe(1);
    expect(cache.refresh("UTILITY", { identity, observedAt: "t3", complete: true, value: { connector: 2 } })).toBe(2);
  });

  it("invalidates cached domains on world/checkpoint/generation switch", () => {
    const cache = new DomainWorldStateCache();
    cache.refresh("UTILITY", { identity, observedAt: "t1", complete: true, value: { connector: 1 } });
    cache.refresh("ROAD", { identity, observedAt: "t1", complete: true, value: { roads: 1 } });
    const nextIdentity = { ...identity, generation: "gen-2" };
    expect(cache.refresh("UTILITY", { identity: nextIdentity, observedAt: "t2", complete: true, value: { connector: 1 } })).toBe(2);
    expect(cache.get("ROAD")).toBeNull();
  });

  it("recomputes stale derived plans on use and preserves fresh plans", async () => {
    const recompute = jest.fn(async () => ({ plan: "new" }));
    const stale = await recomputeOnUtilityRevision({ currentRevision: 2, basedOnRevision: 1,
      value: { plan: "old" }, recompute });
    expect(stale).toMatchObject({ value: { plan: "new" }, basedOnRevision: 2, recomputed: true });
    const fresh = await recomputeOnUtilityRevision({ currentRevision: 2, basedOnRevision: 2,
      value: { plan: "new" }, recompute });
    expect(fresh.recomputed).toBe(false);
    expect(recompute).toHaveBeenCalledTimes(1);
    const unversioned = await recomputeOnUtilityRevision({ currentRevision: 2, basedOnRevision: undefined,
      value: { plan: "legacy" }, recompute });
    expect(unversioned.recomputed).toBe(true);
    expect(unversioned.value).toEqual({ plan: "new" });
    expect(recompute).toHaveBeenCalledTimes(2);
  });
});
