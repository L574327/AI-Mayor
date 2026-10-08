import { resolveBoundedRoadCandidates } from "../../src/main/services/ai-mayor/v2/road-connection-resolver";
import {
  type DurableRoadEndpointLocator,
  ROAD_ENDPOINT_LOCATOR_SCHEMA_VERSION,
  type RoadEndpointRebindWorld,
  rebindDurableRoadEndpoint,
} from "../../src/main/services/ai-mayor/v2/road-endpoint-rebind";

const oldNode = { index: 76759, version: 1 };
const oldEdge = { index: 72076, version: 1 };
const currentNode = { index: 76996, version: 3 };
const currentEdge = { index: 72313, version: 3 };
const anchor = { x: -533.792053, y: 277.760254, z: -164.436829 };

const locator: DurableRoadEndpointLocator = {
  schemaVersion: ROAD_ENDPOINT_LOCATOR_SCHEMA_VERSION,
  durableWorldId: "save:648947b571afa1a3239203966ffae585",
  checkpointLineage: "save:648947b571afa1a3239203966ffae585:568c5b9493ad3ac07208d1d576d5726c",
  anchor,
  positionToleranceMeters: 0.25,
  roadDegree: 5,
  sourceEdge: { prefab: "Small Road", sourceNodeRole: "start", native: true },
  siteContext: {
    siteTarget: { x: -561.9724, z: -151.191086 },
    contactTarget: { x: -541.0321465986763, z: -161.03373325018504 },
    departureHeadingDegrees: 154.82484363921319,
  },
  historicalRuntimeEvidence: { worldEpoch: "old-epoch", node: oldNode, edge: oldEdge },
};

const node = (entity = currentNode, position = anchor, roadDegree = 5) => ({
  entity,
  position,
  native: true,
  outsideConnection: false,
  roadDegree,
});
const edge = (
  entity = currentEdge,
  prefab = "Small Road",
  startNode = currentNode,
  endNode = { index: 71370, version: 3 },
) => ({
  entity,
  prefab,
  native: true,
  startNode,
  endNode,
  start: { x: anchor.x, z: anchor.z },
  end: { x: -662.5355, z: -156.764984 },
  length: 112.0679,
});

const world = (overrides: Partial<RoadEndpointRebindWorld> = {}): RoadEndpointRebindWorld => ({
  durableWorldId: locator.durableWorldId,
  checkpointLineage: locator.checkpointLineage,
  worldEpoch: "current-epoch",
  nodes: [node()],
  edges: [
    edge(),
    edge({ index: 1, version: 3 }, "Medium Road", currentNode, { index: 2, version: 3 }),
    edge({ index: 3, version: 3 }, "Medium Road", { index: 4, version: 3 }, currentNode),
    edge({ index: 5, version: 3 }, "Medium Road", { index: 6, version: 3 }, currentNode),
    edge({ index: 7, version: 3 }, "Medium Road", { index: 8, version: 3 }, currentNode),
  ],
  ...overrides,
});

describe("ROAD durable endpoint locator and current-epoch rebind", () => {
  test("same logical topology with different Entity IDs uniquely rebinds", () => {
    const result = rebindDurableRoadEndpoint(locator, world());
    expect(result).toMatchObject({ ok: true, candidateCount: 1, positionDeltaMeters: 0 });
    if (!result.ok) throw new Error(result.code);
    expect(result.currentNode.entity).toEqual(currentNode);
    expect(result.currentEdge.entity).toEqual(currentEdge);
  });

  test("same position with mismatching topology fails closed", () => {
    const result = rebindDurableRoadEndpoint(locator, world({ nodes: [node(currentNode, anchor, 4)] }));
    expect(result).toMatchObject({ ok: false, code: "ROAD_ENDPOINT_TOPOLOGY_MISMATCH" });
  });

  test("two equally matching node/edge pairs fail closed as ambiguous", () => {
    const secondNode = { index: 90000, version: 3 };
    const result = rebindDurableRoadEndpoint(
      locator,
      world({
        nodes: [node(), node(secondNode)],
        edges: [
          ...world().edges,
          edge({ index: 90001, version: 3 }, "Small Road", secondNode, { index: 90002, version: 3 }),
          edge({ index: 90003, version: 3 }, "Medium Road", secondNode, { index: 90004, version: 3 }),
          edge({ index: 90005, version: 3 }, "Medium Road", { index: 90006, version: 3 }, secondNode),
          edge({ index: 90007, version: 3 }, "Medium Road", { index: 90008, version: 3 }, secondNode),
          edge({ index: 90009, version: 3 }, "Medium Road", { index: 90010, version: 3 }, secondNode),
        ],
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "ROAD_ENDPOINT_REBIND_AMBIGUOUS", candidateCount: 2 });
  });

  test("no bounded coordinate candidate fails closed", () => {
    const result = rebindDurableRoadEndpoint(locator, world({ nodes: [] }));
    expect(result).toMatchObject({ ok: false, code: "ROAD_ENDPOINT_REBIND_NOT_FOUND", candidateCount: 0 });
  });

  test("rebound attachment carries current Entity and current WorldEpoch, never historical authority", () => {
    const result = rebindDurableRoadEndpoint(locator, world());
    if (!result.ok) throw new Error(result.code);
    expect(result.runtimeAttachment).toEqual({
      kind: "EXISTING_NET_NODE",
      role: "START",
      entity: currentNode,
      expectedPosition: anchor,
      worldEpoch: "current-epoch",
    });
    expect(result.runtimeAttachment.entity).not.toEqual(oldNode);
    expect(result.runtimeAttachment.worldEpoch).not.toBe(locator.historicalRuntimeEvidence?.worldEpoch);
  });

  test("world/checkpoint mismatch is stale and never falls back to coordinates", () => {
    const result = rebindDurableRoadEndpoint(locator, world({ checkpointLineage: "different-checkpoint" }));
    expect(result).toMatchObject({ ok: false, code: "ROAD_ENDPOINT_REBIND_STALE" });
    expect("runtimeAttachment" in result).toBe(false);
  });

  test("resolver consumes the rebound source and preserves its current runtime attachment", () => {
    const rebound = rebindDurableRoadEndpoint(locator, world());
    if (!rebound.ok) throw new Error(rebound.code);
    const result = resolveBoundedRoadCandidates({
      siteTarget: { x: -561.9724, z: -151.191086 },
      reservation: { center: { x: -561.9724, z: -151.191086 }, radius: 21.1 },
      planningEnvelope: { center: { x: anchor.x, z: anchor.z }, radius: 200 },
      sourceEdges: world().edges,
      sourceNodes: world().nodes,
      ownedTiles: [
        {
          entity: { index: 10, version: 1 },
          owned: true,
          bounds: { min: { x: -1000, z: -1000 }, max: { x: 1000, z: 1000 } },
          center: { x: 0, z: 0 },
          polygon: [],
        },
      ],
      worldEpoch: "current-epoch",
      reboundSource: rebound,
    });
    expect(result.candidates[0]?.sourceEdge.entity).toEqual(currentEdge);
    expect(result.candidates[0]?.input.startEndpoint).toMatchObject({
      kind: "EXISTING_NET_NODE",
      entity: currentNode,
      worldEpoch: "current-epoch",
    });
  });
});
