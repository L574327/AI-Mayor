import { availableSource } from "../../src/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { createTargetAccessPorts, projectTargetAccess } from "../../src/main/services/ai-mayor/v2/route-access";

const buildingRef = { index: 45264, version: 5 };
const attachedPayload = {
  roadAttachment: {
    roadEdge: { index: 100, version: 3 },
    roadExists: true,
    roadIsEdge: true,
    curvePosition: 0.42,
  },
  entrances: [
    {
      entity: { index: 200, version: 4 },
      exists: true,
      type: "SpawnLocation",
      roadConnectionType: "Road",
      roadTypes: "Road",
      hasAccessRestriction: false,
      hasSpawnLocation: true,
      allowEnter: false,
      allowExit: false,
      connectedLane1: {
        entity: { index: 300, version: 2 },
        exists: true,
        isLane: true,
        isCarLane: true,
        isConnectionLane: false,
        carLaneFlags: "SideConnection, AllowEnter",
        connectionLaneFlags: null,
        connectionLaneRoadTypes: null,
        fromRoadEdgeSubLane: true,
        pathMethods: "Road",
        isRoadPath: true,
      },
      connectedLane2: null,
    },
  ],
};

describe("V2 target-building route/access evidence", () => {
  test("returns only ATTACHED_ONLY for native road and entrance-to-car-lane evidence", () => {
    const result = projectTargetAccess(buildingRef, attachedPayload);
    expect(result.status).toBe("ATTACHED_ONLY");
    expect(result.statusProvenance).toBe("DERIVED_WITH_EXPLICIT_RULE");
    expect(result.roadAttachment?.provenance).toBe("OBSERVED_NATIVE_COMPONENT");
    expect(result.entrances[0].provenance).toBe("OBSERVED_NATIVE_COMPONENT");
    expect(result.networkEvidence.status).toBe("ENTRANCE_LANE_ATTACHED");
    expect(result.routeEvidence.status).toBe("UNAVAILABLE");
  });

  test("accepts a native ConnectionLane road path without access flags", () => {
    const result = projectTargetAccess(buildingRef, {
      roadAttachment: attachedPayload.roadAttachment,
      entrances: [
        {
          ...attachedPayload.entrances[0],
          allowEnter: false,
          allowExit: false,
          connectedLane1: {
            ...attachedPayload.entrances[0].connectedLane1,
            isCarLane: false,
            isConnectionLane: true,
            carLaneFlags: null,
            connectionLaneFlags: "Road",
            connectionLaneRoadTypes: "Road",
          },
        },
      ],
    });
    expect(result.status).toBe("ATTACHED_ONLY");
  });

  test("requires restriction flags only when an access restriction exists", () => {
    const result = projectTargetAccess(buildingRef, {
      roadAttachment: attachedPayload.roadAttachment,
      entrances: [{ ...attachedPayload.entrances[0], hasAccessRestriction: true, allowEnter: false, allowExit: false }],
    });
    expect(result.status).toBe("UNKNOWN");
  });

  test("rejects an arbitrary ConnectionLane without authoritative SubLane relation", () => {
    const result = projectTargetAccess(buildingRef, {
      roadAttachment: attachedPayload.roadAttachment,
      entrances: [
        {
          ...attachedPayload.entrances[0],
          connectedLane1: { ...attachedPayload.entrances[0].connectedLane1, isCarLane: false, isConnectionLane: true, fromRoadEdgeSubLane: false },
        },
      ],
    });
    expect(result.status).toBe("UNKNOWN");
  });

  test("explicit negative source is the only DISCONNECTED path", () => {
    const result = projectTargetAccess(buildingRef, { authoritativeNegative: "DISCONNECTED", entrances: [] });
    expect(result.status).toBe("DISCONNECTED");
    expect(result.statusProvenance).toBe("DERIVED_WITH_EXPLICIT_RULE");
  });

  test("nearby road geometry without native attachment remains UNKNOWN", () => {
    const result = projectTargetAccess(buildingRef, {
      nearbyRoads: [{ distance: 0.1 }],
      roadAttachment: null,
      entrances: [],
    } as never);
    expect(result.status).toBe("UNKNOWN");
    expect(result.nonAuthority.geometricNearbyRoad).toBe("NOT_USED");
  });

  test("undirected endpoint topology alone cannot return routable or attached", () => {
    const result = projectTargetAccess(buildingRef, {
      roadGraph: { nodes: [{ index: 1 }], edges: [{ startNode: 1, endNode: 2 }] },
    } as never);
    expect(result.status).toBe("UNKNOWN");
    expect(result.nonAuthority.undirectedRoadTopology).toBe("NOT_USED");
    expect(JSON.stringify(result)).not.toContain('"ROUTABLE"');
  });

  test("road edge without authoritative entrance lane remains UNKNOWN", () => {
    const result = projectTargetAccess(buildingRef, {
      roadAttachment: attachedPayload.roadAttachment,
      entrances: [],
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.routeEvidence.status).toBe("UNAVAILABLE");
  });

  test("a missing connected lane cannot establish attachment", () => {
    const result = projectTargetAccess(buildingRef, {
      ...attachedPayload,
      entrances: [
        {
          ...attachedPayload.entrances[0],
          connectedLane1: { ...attachedPayload.entrances[0].connectedLane1, exists: false },
        },
      ],
    });
    expect(result.status).toBe("UNKNOWN");
  });

  test("stale building entity is UNAVAILABLE and never upgraded to route truth", async () => {
    const ports = createTargetAccessPorts({
      runtimeEpoch: "runtime:test",
      readGameState: async () => availableSource({ simulation: { frameIndex: 10, paused: true } }),
      readTarget: async () => {
        throw new Error("entity 45264:5 does not exist");
      },
      createId: () => "access-observation",
    });
    const result = await ports.observe({ buildingRef });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.coherence).toBe("UNKNOWN");
    expect(result.reason).toContain("does not exist");
  });

  test("derived result retains inputs, assumptions, and invalidity conditions", () => {
    const result = projectTargetAccess(buildingRef, attachedPayload);
    expect(result.derivation?.inputs).toContain("Game.Buildings.Building.m_RoadEdge");
    expect(result.derivation?.assumptions.length).toBeGreaterThan(0);
    expect(result.derivation?.invalidityConditions).toContain("observation frame drifts");
  });

  test("captures stable frame around one exact building read", async () => {
    const ports = createTargetAccessPorts({
      runtimeEpoch: "runtime:test",
      readGameState: async () => availableSource({ simulation: { frameIndex: 20, paused: true } }),
      readTarget: async () => availableSource(attachedPayload),
      createId: () => "access-observation",
    });
    const result = await ports.observe({ buildingRef });
    expect(result.status).toBe("ATTACHED_ONLY");
    expect(result.coherence).toBe("STABLE_FRAME");
    expect(result.simulationFrameStart).toBe(20);
    expect(result.simulationFrameEnd).toBe(20);
  });

  test("does not certify attachment across frame drift", async () => {
    let frame = 40;
    const ports = createTargetAccessPorts({
      runtimeEpoch: "runtime:test",
      readGameState: async () => availableSource({ simulation: { frameIndex: frame++, paused: false } }),
      readTarget: async () => availableSource(attachedPayload),
      createId: () => "access-observation",
    });
    const result = await ports.observe({ buildingRef });
    expect(result.coherence).toBe("BOUNDED_DRIFT");
    expect(result.status).toBe("UNKNOWN");
    expect(result.confidence).toBe("NONE");
  });

  test("production adapter uses exact access read and no legacy planner dependency", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_game_state", "cs2_building_access"].map((name) => ({ name: `bridge--${name}` })),
      }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls.push({ name, args });
        return name === "cs2_game_state"
          ? { structuredContent: { simulation: { frameIndex: 30, paused: true } } }
          : { structuredContent: attachedPayload };
      },
    };
    const ports = createV2FoundationPorts({ getToolsManager: () => manager });
    const result = await ports.targetAccess.observe({ buildingRef });
    expect(result.status).toBe("ATTACHED_ONLY");
    expect(calls).toEqual([
      { name: "cs2_game_state", args: {} },
      { name: "cs2_building_access", args: buildingRef },
      { name: "cs2_game_state", args: {} },
    ]);
    expect(calls.map((call) => call.name).join(" ")).not.toMatch(
      /candidate|choose_candidate|growthOpportunity|roadExpansion|preflight/,
    );
  });
});
