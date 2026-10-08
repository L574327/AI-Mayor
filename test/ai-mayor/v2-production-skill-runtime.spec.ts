import { createV2ProductionSkillRuntime } from "../../src/main/services/ai-mayor/v2/production-skill-runtime";
import { K05CommissionUtilitiesWorkflowAdapter } from "../../src/main/services/ai-mayor/skills";
import { planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";

function authoritativeContext() {
  const state = planStarterResidentialIntent({
    intentId: "runtime-intent",
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
    siteCandidates: [{ id: "site", target: { center: { x: 0, z: 0 }, radius: 30 }, score: 1, blocked: false }],
  });
  state.tranche.stage = "ROAD_DELIVERED";
  return {
    state,
    world: {
      worldId: "world:runtime",
      nativeSessionGuid: "session:runtime",
      loadPurpose: "LoadGame" as const,
      loadAssetGuid: null,
      saveDataAssetGuid: null,
      mapAssetGuid: null,
      checkpointId: "checkpoint:runtime",
      bridgeRuntimeEpoch: "bridge:runtime",
      generation: "generation:runtime",
      generationSequence: 1,
      generationOrigin: "ATTACHED_EXISTING_WORLD" as const,
      worldEpochId: "epoch:runtime",
      worldReady: true as const,
    },
    treasury: 25_000,
  };
}

describe("V2 production skill runtime", () => {
  test("preserves a standalone Road Goal's ROAD_DELIVERED milestone through admission", async () => {
    const ensureGoalWorkOrder = jest.fn().mockResolvedValue({ status: "ADMITTED" });
    const runtime = createV2ProductionSkillRuntime({
      foundation: { greenfieldUtilityBootstrap: {}, projectAdmission: {
        ensureFirstProject: jest.fn(), ensureGoalWorkOrder,
        activeGoalWorkOrder: jest.fn().mockReturnValue(null),
        completeGoalWorkOrder: jest.fn(), recordGate1ProgressionOutcome: jest.fn(),
      } as never },
      context: { currentWorldIdentity: async () => "[]", authoritativeContext: async () => ({}) },
      workflows: [],
    });
    runtime.initialize();
    const signal = new AbortController().signal;
    await runtime.ensureGoalWorkOrder({ goalId: "ESTABLISH_ROAD_NETWORK:facts:test", landUse: "RESIDENTIAL",
      completionStage: "ROAD_DELIVERED" }, signal);
    expect(ensureGoalWorkOrder).toHaveBeenCalledWith({ goalId: "ESTABLISH_ROAD_NETWORK:facts:test",
      landUse: "RESIDENTIAL", completionStage: "ROAD_DELIVERED" }, signal);
    runtime.dispose();
  });

  test("owns one registry, initializes cleanly, and dispatches through the registered workflow", async () => {
    let contextReads = 0;
    const scope = { certifiedRoadRefs: [], targetServiceEntry: { road: { index: 1, version: 1 }, position: { x: 0, z: 0 } } };
    const foundation = {
      greenfieldUtilityBootstrap: {
        async prepare(input: unknown) { return { status: "READY", executionScope: { ...input as object, ...scope } } as never; },
        async run() { return { serviceCertified: true, waiting: false, reason: "SERVICE_CERTIFIED", state: {} }; },
      },
    };
    const workflow = new K05CommissionUtilitiesWorkflowAdapter(foundation);
    const runtime = createV2ProductionSkillRuntime({
      foundation,
      context: {
        currentWorldIdentity: async () => JSON.stringify(["world:runtime", "generation:runtime", "epoch:runtime"]),
        authoritativeContext: async () => { contextReads++; return authoritativeContext(); },
      },
      workflows: [workflow],
    });

    expect(runtime.registry).toBeDefined();
    expect(runtime.registry.list()).toHaveLength(1);
    expect(runtime.registry.has("skill.K05")).toBe(true);
    expect(runtime.isInitialized()).toBe(false);
    runtime.initialize();
    runtime.initialize();
    const result = await runtime.dispatch({ skillId: "skill.K05" });
    expect(result.status).toBe("SUCCESS");
    const repeatedResult = await runtime.dispatch({ skillId: "skill.K05" });
    expect(repeatedResult.status).toBe("SUCCESS");
    expect(contextReads).toBe(1);
    runtime.dispose();
    expect(runtime.isInitialized()).toBe(false);
  });

  test("rejects unknown skills before workflow/native dispatch and supports clean reinitialization", async () => {
    const nativeCalls: string[] = [];
    const foundation = {
      greenfieldUtilityBootstrap: {
        async prepare() { nativeCalls.push("prepare"); return { status: "READY", executionScope: {} } as never; },
        async run() { nativeCalls.push("run"); return { serviceCertified: true, waiting: false, reason: "SERVICE_CERTIFIED", state: {} }; },
      },
    };
    const runtime = createV2ProductionSkillRuntime({
      foundation,
      context: {
        currentWorldIdentity: async () => JSON.stringify(["world:runtime", "generation:runtime", "epoch:runtime"]),
        authoritativeContext: async () => authoritativeContext(),
      },
      workflows: [],
    });
    runtime.initialize();
    await expect(runtime.dispatch({ skillId: "skill.unknown" })).rejects.toThrow("unregistered production skill");
    expect(nativeCalls).toEqual([]);
    runtime.dispose();
    runtime.initialize();
    expect(runtime.registry.list()).toHaveLength(1);
  });

  test("resolves K05 admission context for the requested utility family", async () => {
    const kinds: string[] = [];
    const runtime = createV2ProductionSkillRuntime({
      foundation: { greenfieldUtilityBootstrap: {} },
      context: {
        currentWorldIdentity: async () => JSON.stringify(["world:runtime", "generation:runtime", "epoch:runtime"]),
        authoritativeContext: async (intent) => {
          const kind = (intent as { utilityKind?: string } | undefined)?.utilityKind ?? "electricity";
          kinds.push(kind);
          return { ...authoritativeContext(), kind };
        },
      },
      workflows: [{
        skillId: "skill.K05",
        async executeProduction(_intent: unknown, context: unknown) {
          return { skillId: "skill.K05", sequenceId: "test", status: "SUCCESS", evidence: [context] };
        },
      } as never],
    });
    runtime.initialize();
    const result = await runtime.dispatch({ skillId: "skill.K05", utilityKind: "water", strategyId: "INITIAL_FACILITY_PLACEMENT" });
    expect(kinds.at(-1)).toBe("water");
    expect(result.evidence).toEqual([expect.objectContaining({ kind: "water" })]);
    runtime.dispose();
  });

  test("rebuilds bootstrap context after a world change and then reuses the new world's cache", async () => {
    let currentWorld = "A";
    const bootstrappedWorlds: string[] = [];
    const taskIdsByWorld: Record<string, string> = {};
    const currentWorldIdentity = async () => JSON.stringify([`world:${currentWorld}`, currentWorld, currentWorld]);
    const runtime = createV2ProductionSkillRuntime({
      foundation: { greenfieldUtilityBootstrap: {} },
      context: {
        currentWorldIdentity,
        authoritativeContext: async () => {
          const world = currentWorld;
          bootstrappedWorlds.push(world);
          // Models the existing authoritative bootstrap: activation followed by
          // ensureFirstProject creates state for the world that was just read.
          taskIdsByWorld[world] = `task:${world}`;
          return {
            world: {
              worldId: `world:${world}`,
              generation: world,
              worldEpochId: world,
            },
            taskId: taskIdsByWorld[world],
            childId: `child:${world}`,
            authorizationId: `authorization:${world}`,
          };
        },
      },
      workflows: [],
    });

    runtime.initialize();
    expect((await runtime.readiness() as { taskId: string }).taskId).toBe("task:A");
    expect(bootstrappedWorlds).toEqual(["A"]);

    currentWorld = "B";
    const bContext = await runtime.readiness() as { taskId: string; childId: string; authorizationId: string };
    expect(bContext.taskId).toBe("task:B");
    expect(bootstrappedWorlds).toEqual(["A", "B"]);
    expect(taskIdsByWorld.B).not.toBe(taskIdsByWorld.A);
    expect(bContext.childId).toBe("child:B");
    expect(bContext.authorizationId).toBe("authorization:B");

    const reusedBContext = await runtime.readiness() as { taskId: string };
    expect(reusedBContext).toBe(bContext);
    expect(bootstrappedWorlds).toEqual(["A", "B"]);
    runtime.dispose();
  });
});
