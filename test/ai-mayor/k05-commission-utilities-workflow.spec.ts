import {
  K05CommissionUtilitiesWorkflowAdapter,
  K05_ELECTRICITY_RECIPE,
  type K05ElectricityAdmission,
  createSkillRegistry,
  executeProductionSkillIntent,
} from "../../src/main/services/ai-mayor/skills";
import { planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";

const preparation = {
  kind: "electricity",
  intentId: "admitted-intent",
  projectId: "admitted-project",
  trancheId: "admitted-tranche",
  reservationRef: "admitted-reservation",
  worldId: "world",
  worldEpochId: "epoch",
  generation: "generation",
  topologyRevision: "topology",
  spatialEnvelope: { center: { x: 10, z: 20 }, radius: 128 },
  maximumSpend: 1000,
  treasury: 1000,
  treasurySafetyReserve: 100,
} as const;

const scope = { ...preparation, certifiedRoadRefs: [], targetServiceEntry: { road: { index: 1, version: 1 }, position: { x: 10, z: 20 } } };
const state = { scope, utilities: {} };

const admission: K05ElectricityAdmission = {
  recipeFamily: K05_ELECTRICITY_RECIPE,
  preparation,
};

describe("K05 CommissionUtilities workflow binding", () => {
  it("builds admission from authoritative V2 state/world and reaches prepare/run", async () => {
    const state = planStarterResidentialIntent({
      intentId: "authoritative-intent",
      targetResidents: 12,
      maximumBudget: 25_000,
      planningEnvelope: { center: { x: 10, z: 20 }, radius: 128 },
      siteCandidates: [{ id: "site-1", target: { center: { x: 10, z: 20 }, radius: 64 }, score: 1, blocked: false }],
    });
    // Gate 1 admits supply-side utility execution at ROAD_DELIVERED — the stage
    // where `recordUtilityExecution` is legal and the ZONING gate is armed.
    state.tranche.stage = "ROAD_DELIVERED";
    const world = {
      worldId: "world", nativeSessionGuid: "session", loadPurpose: "LoadGame", loadAssetGuid: null,
      saveDataAssetGuid: null, mapAssetGuid: null, checkpointId: "checkpoint", bridgeRuntimeEpoch: "bridge",
      generation: "generation", generationSequence: 1, generationOrigin: "ATTACHED_EXISTING_WORLD",
      worldEpochId: "world:epoch", worldReady: true as const,
    };
    let preparedInput: unknown;
    const foundation = {
      greenfieldUtilityBootstrap: {
        async prepare(input: unknown) { preparedInput = input; return { status: "READY", executionScope: scope } as never; },
        async run() { return { serviceCertified: true, waiting: false, reason: "SERVICE_CERTIFIED", state }; },
      },
    };
    const result = await executeProductionSkillIntent({
      registry: createSkillRegistry(),
      foundation,
      intent: { skillId: "skill.K05" },
      authoritativeContext: { state, world, treasury: 20_000 },
      workflows: [new K05CommissionUtilitiesWorkflowAdapter(foundation)],
    });

    expect(result.status).toBe("SUCCESS");
    expect(preparedInput).toMatchObject({
      kind: "electricity",
      intentId: state.intent.id,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      worldId: world.worldId,
      worldEpochId: world.worldEpochId,
      generation: world.generation,
      topologyRevision: "generation:production",
      maximumSpend: 20_000,
    });
  });

  it("delegates admitted K05 execution to the existing V2 prepare/run boundary", async () => {
    const calls: string[] = [];
    const foundation = {
      greenfieldUtilityBootstrap: {
        async prepare(input: unknown) {
          calls.push("prepare");
          expect(input).toBe(preparation);
          return { status: "READY", executionScope: scope } as never;
        },
        async run(input: unknown) {
          calls.push("run");
          expect(input).toBe(scope);
          return { serviceCertified: true, waiting: false, reason: "SERVICE_CERTIFIED", state };
        },
      },
    };

    const result = await new K05CommissionUtilitiesWorkflowAdapter(foundation).execute(admission);

    expect(calls).toEqual(["prepare", "run"]);
    expect(result.status).toBe("SUCCESS");
    expect(result.durableOutcome?.state).toBe(state);
  });

  it("narrows the execution scope to the families a bounded mandate names", async () => {
    const scopes: unknown[] = [];
    const foundation = {
      greenfieldUtilityBootstrap: {
        async prepare() { return { status: "READY", executionScope: scope } as never; },
        async run(input: unknown) {
          scopes.push(input);
          return { serviceCertified: false, waiting: false, reason: "UTILITY_CONNECTION_OBJECTIVE_INCOMPLETE", state };
        },
      },
    };
    const adapter = new K05CommissionUtilitiesWorkflowAdapter(foundation);
    // No mandate is the full commissioning request, so the scope the caller
    // built is handed to `run` untouched — the existing production behavior.
    await adapter.execute(admission);
    expect(scopes[0]).toBe(scope);
    // The mandate is a separate axis from the recipe family: it says which
    // families this invocation is authorized to commission, not which family
    // the admission was built for.
    await adapter.execute(admission, undefined, ["water"]);
    expect(scopes[1]).toEqual({ ...scope, commissionedKinds: ["water"] });
    expect(scopes[1]).not.toBe(scope);
  });

  it("routes a native candidate rejection into bounded durable utility planning", async () => {
    const calls: string[] = [];
    const blocked = new K05CommissionUtilitiesWorkflowAdapter({
      greenfieldUtilityBootstrap: {
        async prepare() {
          return {
            status: "BLOCKED", reason: "DIRECT_CABLE_PREFLIGHT_REJECTED", nativeActionsSubmitted: 0,
            diagnostics: {
              preparationReason: "DIRECT_CABLE_PREFLIGHT_REJECTED",
              connectionDiagnostics: [{
                valid: false, reason: "utility_finance_preflight_rejected",
                candidate: "direct-cable", actionCount: 1, actionIndex: 0,
              }],
            },
          };
        },
        async run(input: unknown) { calls.push("run"); expect(input).toMatchObject({ projectId: preparation.projectId, trancheId: preparation.trancheId });
          return { serviceCertified: false, waiting: true, reason: "UTILITY_RECONCILIATION_REQUIRED", state }; },
      },
    }).execute(admission);
    await expect(blocked).resolves.toMatchObject({
      status: "WAITING",
      durableOutcome: { reason: "UTILITY_RECONCILIATION_REQUIRED" },
    });
    expect(calls).toEqual(["run"]);
  });

  it("maps blocked and unknown durable outcomes without declaring success", async () => {
    const blocked = new K05CommissionUtilitiesWorkflowAdapter({
      greenfieldUtilityBootstrap: {
        async prepare() { return { status: "BLOCKED", reason: "UTILITY_PLAN_UNAVAILABLE", nativeActionsSubmitted: 0 }; },
        async run() { throw new Error("must not run after blocked prepare"); },
      },
    }).execute(admission);
    await expect(blocked).resolves.toMatchObject({ status: "FAILED", error: "K05_PREPARE_BLOCKED:UTILITY_PLAN_UNAVAILABLE" });

    const unknown = new K05CommissionUtilitiesWorkflowAdapter({
      greenfieldUtilityBootstrap: {
        async prepare() { return { status: "READY", executionScope: scope } as never; },
        async run() { return { serviceCertified: false, waiting: true, reason: "UTILITY_RECONCILIATION_REQUIRED", state }; },
      },
    }).execute(admission);
    await expect(unknown).resolves.toMatchObject({ status: "WAITING" });
  });
});
