import { resolveBoundedRoadCandidates } from "../../src/main/services/ai-mayor/v2/road-connection-resolver";
import type { RoadGeometryInput } from "../../src/main/services/ai-mayor/v2/road-kernel";

describe("ROAD typed endpoint attachment contract", () => {
  it("keeps the historical source entity/version and explicit free END through JSON", () => {
    const input: RoadGeometryInput = {
      prefab: "Basic Road",
      x1: -533.792053,
      z1: -164.436829,
      x2: -541.0321465986763,
      z2: -161.03373325018504,
      startEndpoint: {
        kind: "EXISTING_NET_NODE",
        role: "START",
        entity: { index: 76759, version: 1 },
        expectedPosition: { x: -533.792053, y: 0, z: -164.436829 },
        worldEpoch: "world-1",
      },
      endEndpoint: {
        kind: "NEW_FREE_ENDPOINT",
        role: "END",
        expectedPosition: { x: -541.0321465986763, y: 0, z: -161.03373325018504 },
        worldEpoch: "world-1",
      },
    };
    const roundTrip = JSON.parse(JSON.stringify(input)) as RoadGeometryInput;
    expect(roundTrip.startEndpoint?.kind).toBe("EXISTING_NET_NODE");
    expect(roundTrip.startEndpoint?.entity).toEqual({ index: 76759, version: 1 });
    expect(roundTrip.endEndpoint?.kind).toBe("NEW_FREE_ENDPOINT");
  });

  it("resolver emits an existing-node START attachment rather than coordinate-only semantics", () => {
    const node = { entity: { index: 76759, version: 1 }, position: { x: 0, y: 2, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 };
    const edge = { entity: { index: 72076, version: 1 }, prefab: "Basic Road", native: true, startNode: node.entity, endNode: { index: 2, version: 1 }, start: { x: 0, z: 0 }, end: { x: 10, z: 0 }, length: 10 };
    const result = resolveBoundedRoadCandidates({
      siteTarget: { x: 10, z: 0 }, reservation: { center: { x: 10, z: 0 }, radius: 20 }, planningEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
      sourceEdges: [edge], sourceNodes: [node], ownedTiles: [{ entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } }, center: { x: 0, z: 0 }, polygon: [] }], worldEpoch: "world-1", bridgeGeneration: "world-1",
    });
    expect(result.candidates[0]?.input.startEndpoint).toMatchObject({ kind: "EXISTING_NET_NODE", role: "START", entity: node.entity, worldEpoch: "world-1" });
  });
});
