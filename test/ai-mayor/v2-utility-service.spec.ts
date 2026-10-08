import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import {
  createTargetUtilityServicePorts,
  projectTargetUtilityService,
} from "../../src/main/services/ai-mayor/v2/utility-service";
import { availableSource } from "../../src/main/services/ai-mayor/v2/foundation";

const buildingRef = { index: 42, version: 7 };

const servedPayload = {
  connectorCount: 0,
  connectors: [],
  consumerService: {
    electricity: {
      connected: true,
      wantedConsumption: 120,
      fulfilledConsumption: 120,
      noElectricityWarning: false,
      bottleneckWarning: false,
      flags: "Connected",
    },
    water: {
      waterConnected: true,
      sewageConnected: true,
      wantedConsumption: 80,
      fulfilledFresh: 80,
      fulfilledSewage: 80,
      pollution: 0,
      flags: "WaterConnected, SewageConnected",
    },
  },
};

describe("V2 target-building utility service", () => {
  test("classifies an ordinary consumer as served from direct component fulfillment", () => {
    const result = projectTargetUtilityService(buildingRef, servedPayload);
    expect(result.electricity.status).toBe("SERVED");
    expect(result.water.status).toBe("SERVED");
    expect(result.sewage.status).toBe("SERVED");
    expect(result.electricity.statusProvenance).toBe("DERIVED_WITH_EXPLICIT_RULE");
    expect(result.electricity.observed?.provenance).toBe("OBSERVED_NATIVE_COMPONENT");
  });

  test("reports absent consumer components as unavailable", () => {
    const result = projectTargetUtilityService(buildingRef, { consumerService: {} });
    expect(result.electricity.status).toBe("UNAVAILABLE");
    expect(result.water.status).toBe("UNAVAILABLE");
    expect(result.sewage.status).toBe("UNAVAILABLE");
  });

  test("global surplus does not convert unavailable target evidence into served", () => {
    const result = projectTargetUtilityService(buildingRef, {
      consumerService: {},
      globalUtilities: { electricity: { production: 1_000, consumption: 1 } },
    } as never);
    expect(result.electricity.status).toBe("UNAVAILABLE");
  });

  test("global deficit does not convert a fulfilled target into unserved", () => {
    const result = projectTargetUtilityService(buildingRef, {
      ...servedPayload,
      globalUtilities: { electricity: { production: 1, consumption: 1_000 } },
    } as never);
    expect(result.electricity.status).toBe("SERVED");
  });

  test("missing facility connectors do not imply consumer service failure", () => {
    const result = projectTargetUtilityService(buildingRef, servedPayload);
    expect(servedPayload.connectorCount).toBe(0);
    expect(result.electricity.status).toBe("SERVED");
    expect(result.water.status).toBe("SERVED");
    expect(result.sewage.status).toBe("SERVED");
  });

  test("distinguishes disconnected and connected-but-unfulfilled consumers", () => {
    const result = projectTargetUtilityService(buildingRef, {
      consumerService: {
        electricity: {
          ...servedPayload.consumerService.electricity,
          connected: false,
          fulfilledConsumption: 0,
        },
        water: {
          ...servedPayload.consumerService.water,
          fulfilledFresh: 20,
          sewageConnected: false,
          fulfilledSewage: 0,
        },
      },
    });
    expect(result.electricity.status).toBe("UNSERVED");
    expect(result.water.status).toBe("CONNECTED_BUT_UNFULFILLED");
    expect(result.sewage.status).toBe("UNSERVED");
  });

  test("preserves conflict and zero-demand uncertainty instead of guessing", () => {
    const conflict = projectTargetUtilityService(buildingRef, {
      consumerService: {
        electricity: {
          ...servedPayload.consumerService.electricity,
          noElectricityWarning: true,
        },
        water: {
          ...servedPayload.consumerService.water,
          wantedConsumption: 0,
          fulfilledFresh: 0,
          fulfilledSewage: 0,
        },
      },
    });
    expect(conflict.electricity.status).toBe("CONFLICT");
    expect(conflict.water.status).toBe("UNKNOWN");
    expect(conflict.sewage.status).toBe("UNKNOWN");
  });

  test("stale or missing entity becomes unavailable without fabricating service", async () => {
    const ports = createTargetUtilityServicePorts({
      runtimeEpoch: "runtime:test",
      readGameState: async () => availableSource({ frameIndex: 10, paused: true }),
      readTarget: async () => {
        throw new Error("entity 42:7 does not exist");
      },
      createId: () => "utility-observation",
    });
    const result = await ports.observe({ buildingRef });
    expect(result.coherence).toBe("UNKNOWN");
    expect(result.source.status).toBe("UNAVAILABLE");
    expect(result.electricity.status).toBe("UNAVAILABLE");
    expect(result.electricity.reason).toContain("does not exist");
  });

  test("captures stable frame bounds around one exact target read", async () => {
    const ports = createTargetUtilityServicePorts({
      runtimeEpoch: "runtime:test",
      readGameState: async () => availableSource({ simulation: { frameIndex: 20, paused: true } }),
      readTarget: async () => availableSource(servedPayload),
      createId: () => "utility-observation",
    });
    const result = await ports.observe({ buildingRef });
    expect(result.coherence).toBe("STABLE_FRAME");
    expect(result.simulationFrameStart).toBe(20);
    expect(result.simulationFrameEnd).toBe(20);
    expect(result.globalCapacityPolicy).toBe("SUPPORTING_CONTEXT_ONLY_NOT_USED_FOR_TARGET_STATUS");
  });

  test("production adapter remains isolated from legacy candidate planning", async () => {
    const calls: string[] = [];
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_game_state", "cs2_utility_connectors"].map((name) => ({ name: `bridge--${name}` })),
      }),
      legacyCall: async ({ name }: { name: string }) => {
        calls.push(name);
        if (name === "cs2_game_state") {
          return { structuredContent: { simulation: { frameIndex: 30, paused: true } } };
        }
        return { structuredContent: servedPayload };
      },
    };
    const ports = createV2FoundationPorts({ getToolsManager: () => manager });
    const result = await ports.utilityService.observe({ buildingRef });
    expect(result.electricity.status).toBe("SERVED");
    expect(calls).toEqual(["cs2_game_state", "cs2_utility_connectors", "cs2_game_state"]);
    expect(calls.join(" ")).not.toMatch(/candidate|choose_candidate|growthOpportunity|preflight/);
  });
});
