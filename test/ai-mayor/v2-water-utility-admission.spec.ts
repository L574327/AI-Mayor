import {
  K05CommissionUtilitiesWorkflowAdapter,
  K05_ELECTRICITY_RECIPE,
  type K05UtilityAdmission,
} from "../../src/main/services/ai-mayor/skills";
import { planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";
import {
  AUTHORITATIVE_UTILITY_KIND,
  buildUtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import {
  prepareScopedUtilityExecution,
  UTILITY_FACILITY_RECIPES,
  type UtilityExecutionPlannerPorts,
  utilityFacilityRecipe,
} from "../../src/main/services/ai-mayor/v2/utility-execution-planner";
import type { PlannedUtilityFacility } from "../../src/main/services/ai-mayor/spatial/types";

const WORLD = {
  worldId: "world", nativeSessionGuid: "session", loadPurpose: "LoadGame", loadAssetGuid: null,
  saveDataAssetGuid: null, mapAssetGuid: null, checkpointId: "checkpoint", bridgeRuntimeEpoch: "bridge",
  generation: "generation", generationSequence: 1, generationOrigin: "ATTACHED_EXISTING_WORLD",
  worldEpochId: "world:epoch", worldReady: true as const,
};

const CERTIFIED_ROAD = {
  entity: { index: 187602, version: 1 },
  position: { x: 10, z: 20 },
  prefab: "Medium Road",
};

function deliveredState() {
  const state = planStarterResidentialIntent({
    intentId: "authoritative-intent",
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: 10, z: 20 }, radius: 180 },
    siteCandidates: [{ id: "site-1", target: { center: { x: 10, z: 20 }, radius: 64 }, score: 1, blocked: false }],
  });
  // Gate 1 admits supply-side utility execution at ROAD_DELIVERED.
  state.tranche.stage = "ROAD_DELIVERED";
  return state;
}

const waterPlan: PlannedUtilityFacility = {
  kind: "water", prefab: "WaterTower01", position: { x: 10, z: 20 }, rotationCandidates: [0], constructionCost: 600,
  expectedCapacity: 30_000, siteEvidence: { source: "fixture" },
  connection: { prefab: "Small Water Pipe", start: { x: 10, z: 20 }, end: { x: 10, z: 24 } },
};

function placementPorts(): UtilityExecutionPlannerPorts {
  return {
    plan: async () => ({ status: "candidate", facility: waterPlan, reason: "fixture", diagnostics: { waterCandidateCount: 8, supportedWaterCandidateCount: 2 } }),
    preflight: async () => true,
    readConnectors: async () => [],
    readCapacity: async () => ({ revision: "generation:1", capacity: 30_000, consumption: 0, fulfilledConsumption: 0, issueActive: false }),
    currentRevision: async () => "generation:1",
    findCurrentUtilityBinding: async () => ({ status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND" }),
    findExistingFacility: async () => undefined,
    roadEdges: async () => [],
  };
}

describe("Water utility admission", () => {
  it("carries the water kind and water recipe through authoritative admission", () => {
    const state = deliveredState();
    const preparation = buildUtilityPreparationInput({
      state, world: WORLD, treasury: 20_000, kind: "water", certifiedRoad: CERTIFIED_ROAD,
    });

    expect(preparation.kind).toBe("water");
    expect(preparation.facilityPlacementAuthorization).toMatchObject({
      recipe: "basic-water-provision",
      kind: "water",
      intentId: state.intent.id,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      maximumPlacements: 1,
      targetRoad: { prefab: "Medium Road" },
    });
    expect(preparation.facilityPlacementAuthorization?.certifiedRoadRefs).toEqual([CERTIFIED_ROAD.entity]);
  });

  it("keeps the default admission byte-identical to the sealed electricity contract", () => {
    const state = deliveredState();
    const implicit = buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, certifiedRoad: CERTIFIED_ROAD });
    const explicit = buildUtilityPreparationInput({
      state, world: WORLD, treasury: 20_000, kind: AUTHORITATIVE_UTILITY_KIND, certifiedRoad: CERTIFIED_ROAD,
    });

    expect(implicit).toEqual(explicit);
    expect(implicit.kind).toBe("electricity");
    expect(implicit.facilityPlacementAuthorization?.recipe).toBe(K05_ELECTRICITY_RECIPE);
    expect(implicit.facilityPlacementAuthorization?.kind).toBe("electricity");
  });

  it("derives one recipe per utility family, with electricity unchanged", () => {
    expect(UTILITY_FACILITY_RECIPES.electricity).toBe("basic-electricity-provision");
    expect(utilityFacilityRecipe("water")).toBe("basic-water-provision");
    expect(utilityFacilityRecipe("sewage")).toBe("basic-sewage-provision");
  });

  it("admits a first water placement authorized by the water recipe", async () => {
    const state = deliveredState();
    const preparation = {
      ...buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water", certifiedRoad: CERTIFIED_ROAD }),
      firstFacilityPlacement: { status: "NONE" as const },
    };
    const prepared = await prepareScopedUtilityExecution(preparation, placementPorts());

    expect(prepared.status).toBe("READY");
    if (prepared.status !== "READY" || prepared.mode !== "GREENFIELD_FIRST_PLACEMENT") throw new Error("expected a first placement");
    expect(prepared.plan.kind).toBe("water");
    expect(prepared.targetServiceEntry.road).toEqual(CERTIFIED_ROAD.entity);
    // Water has no electricity target semantics; the scope must not carry one.
    expect(prepared.targetSemantics).toBeUndefined();
    expect(prepared.executionScope.targetSemantics).toBeUndefined();
    expect(prepared.diagnostics).toMatchObject({ waterCandidateCount: 8, supportedWaterCandidateCount: 2 });
  });

  it("admits a Stage A placement from SITE_SELECTED with no Road authority and keeps it water-only", async () => {
    const state = deliveredState();
    state.tranche.stage = "SITE_SELECTED";
    const preparation = {
      ...buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water", facilityPlacementOnly: true }),
      firstFacilityPlacement: { status: "NONE" as const },
    };
    const prepared = await prepareScopedUtilityExecution(preparation, placementPorts());

    expect(prepared.status).toBe("READY");
    if (prepared.status !== "READY" || prepared.mode !== "GREENFIELD_FIRST_PLACEMENT") throw new Error("expected Stage A placement");
    expect(preparation.facilityPlacementAuthorization).toMatchObject({ facilityPlacementOnly: true, certifiedRoadRefs: [] });
    expect(prepared.executionScope).toMatchObject({ facilityPlacementOnly: true, commissionedKinds: ["water"], certifiedRoadRefs: [] });
    expect(prepared.executionScope.targetServiceEntry.road).toEqual({ index: -1, version: -1 });
  });

  it("does not admit SITE_SELECTED utility planning without explicit Stage A placement-only scope", () => {
    const state = deliveredState();
    state.tranche.stage = "SITE_SELECTED";
    expect(() => buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water" }))
      .toThrow("UTILITY_ADMISSION_STAGE_NOT_ROAD_DELIVERED");
  });

  it("admits Stage A while the only blocked Gate1 task is RoadConnection", () => {
    const state = deliveredState();
    state.tranche.stage = "SITE_SELECTED";
    state.project.status = "BLOCKED";
    const roadTask = state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!;
    roadTask.status = "BLOCKED";
    expect(buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water", facilityPlacementOnly: true }))
      .toMatchObject({ facilityPlacementOnly: true, facilityPlacementAuthorization: { facilityPlacementOnly: true, certifiedRoadRefs: [] } });
  });

  it("does not use Stage A admission to bypass another blocked Gate1 task", () => {
    const state = deliveredState();
    state.tranche.stage = "SITE_SELECTED";
    state.project.status = "BLOCKED";
    state.tasks.find((task) => task.kind === "ROAD_CONNECTION")!.status = "BLOCKED";
    state.tasks.find((task) => task.kind === "SITE_SELECTION")!.status = "BLOCKED";
    expect(() => buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water", facilityPlacementOnly: true }))
      .toThrow("UTILITY_ADMISSION_PROJECT_NOT_ACTIVE");
  });

  it("refuses to serve a water preparation with an electricity placement authorization", async () => {
    const state = deliveredState();
    const admitted = buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water", certifiedRoad: CERTIFIED_ROAD });
    const authorization = admitted.facilityPlacementAuthorization!;
    const forged = {
      ...admitted,
      // The pairing a kind-blind admission would have produced: the water scope
      // carrying the electricity family's recipe.
      facilityPlacementAuthorization: { ...authorization, recipe: K05_ELECTRICITY_RECIPE as never },
      firstFacilityPlacement: { status: "NONE" as const },
    };
    const prepared = await prepareScopedUtilityExecution(forged, placementPorts());

    expect(prepared.status).toBe("BLOCKED");
    expect(prepared.reason).toBe("UTILITY_FACILITY_NOT_FOUND");
  });

  it("refuses a placement whose kind is not the preparation's kind", async () => {
    const state = deliveredState();
    const admitted = buildUtilityPreparationInput({ state, world: WORLD, treasury: 20_000, kind: "water", certifiedRoad: CERTIFIED_ROAD });
    const forged = {
      ...admitted,
      facilityPlacementAuthorization: { ...admitted.facilityPlacementAuthorization!, kind: "electricity" as never },
      firstFacilityPlacement: { status: "NONE" as const },
    };
    const prepared = await prepareScopedUtilityExecution(forged, placementPorts());

    expect(prepared.status).toBe("BLOCKED");
  });

  it("routes a water admission through the K05 workflow's existing prepare/run boundary", async () => {
    const state = deliveredState();
    const preparation = buildUtilityPreparationInput({
      state, world: WORLD, treasury: 20_000, kind: "water", certifiedRoad: CERTIFIED_ROAD,
    });
    const scope = { ...preparation, certifiedRoadRefs: [CERTIFIED_ROAD.entity], targetServiceEntry: { road: CERTIFIED_ROAD.entity, position: CERTIFIED_ROAD.position } };
    const calls: string[] = [];
    const foundation = {
      greenfieldUtilityBootstrap: {
        async prepare(input: unknown) { calls.push("prepare"); return { status: "READY", executionScope: scope } as never; },
        async run(input: unknown) { calls.push("run"); expect(input).toBe(scope); return { serviceCertified: true, waiting: false, reason: "SERVICE_CERTIFIED", state }; },
      },
    };
    const admission: K05UtilityAdmission = { recipeFamily: utilityFacilityRecipe("water"), preparation };

    const result = await new K05CommissionUtilitiesWorkflowAdapter(foundation).execute(admission);

    expect(calls).toEqual(["prepare", "run"]);
    expect(result.status).toBe("SUCCESS");
  });

  it("refuses a recipe family that does not belong to the preparation's kind", async () => {
    const state = deliveredState();
    const preparation = buildUtilityPreparationInput({
      state, world: WORLD, treasury: 20_000, kind: "water", certifiedRoad: CERTIFIED_ROAD,
    });
    const mismatched = await new K05CommissionUtilitiesWorkflowAdapter({
      greenfieldUtilityBootstrap: {
        async prepare() { throw new Error("must not prepare a mismatched recipe"); },
        async run() { throw new Error("must not run a mismatched recipe"); },
      },
    }).execute({ recipeFamily: K05_ELECTRICITY_RECIPE, preparation });

    expect(mismatched).toMatchObject({ status: "FAILED", error: "K05_RECIPE_KIND_MISMATCH" });
  });

  it("still admits the sealed electricity admission unchanged", async () => {
    const state = deliveredState();
    const preparation = buildUtilityPreparationInput({
      state, world: WORLD, treasury: 20_000, certifiedRoad: CERTIFIED_ROAD,
    });
    const scope = { ...preparation, certifiedRoadRefs: [CERTIFIED_ROAD.entity], targetServiceEntry: { road: CERTIFIED_ROAD.entity, position: CERTIFIED_ROAD.position } };
    const result = await new K05CommissionUtilitiesWorkflowAdapter({
      greenfieldUtilityBootstrap: {
        async prepare() { return { status: "READY", executionScope: scope } as never; },
        async run() { return { serviceCertified: true, waiting: false, reason: "SERVICE_CERTIFIED", state }; },
      },
    }).execute({ recipeFamily: K05_ELECTRICITY_RECIPE, preparation });

    expect(result.status).toBe("SUCCESS");
  });
});
