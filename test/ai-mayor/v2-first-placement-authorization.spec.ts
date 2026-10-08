import {
  createSkillRegistry,
  executeProductionSkillIntent,
  K05CommissionUtilitiesWorkflowAdapter,
} from "../../src/main/services/ai-mayor/skills";
import type {
  PlannedUtilityFacility,
  SpatialEntityRef,
  SpatialRoadEdge,
} from "../../src/main/services/ai-mayor/spatial/types";
import type { MayorAction, MayorBatchResult } from "../../src/main/services/ai-mayor/types";
import {
  executeSharedUtilityRecovery,
  type SharedUtilityRecoveryPorts,
  type UtilityPlacementReceipt,
} from "../../src/main/services/ai-mayor/utility-recovery";
import type { NativeWorldIdentity } from "../../src/main/services/ai-mayor/v2/durability";
import { type Gate1State, planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";
import {
  type DurableGreenfieldUtilityState,
  type GreenfieldUtilityExecutionScope,
  type GreenfieldUtilityServiceEvidence,
  runScopedGreenfieldUtilityBootstrap,
  type ScopedGreenfieldUtilityPorts,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import type { V2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import {
  type AuthoritativeUtilityAdmissionContext,
  buildUtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import {
  prepareScopedUtilityExecution,
  type UtilityExecutionPlannerPorts,
  type UtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-execution-planner";

const GENERATION = "generation-a";
/** The road Gate 1 delivered and certified: durable evidence, not a search. */
const DELIVERED_ROAD: SpatialEntityRef = { index: 177757, version: 15 };
const DELIVERED_ROAD_GEOMETRY = { prefab: "Medium Road", x1: -541.6216, z1: -47.279007, x2: -543.18, z2: -22.33 };
/** The road an existing-facility connection reconnects to. */
const CONNECTION_ROAD: SpatialEntityRef = { index: 30, version: 1 };
const FACILITY_ENTITY: SpatialEntityRef = { index: 100, version: 1 };

const world: NativeWorldIdentity = {
  worldId: "cs2-session:test",
  nativeSessionGuid: "session",
  loadPurpose: "LoadGame",
  loadAssetGuid: null,
  saveDataAssetGuid: null,
  mapAssetGuid: null,
  checkpointId: "checkpoint",
  bridgeRuntimeEpoch: "bridge",
  generation: GENERATION,
  generationSequence: 1,
  generationOrigin: "ATTACHED_EXISTING_WORLD",
  worldEpochId: "cs2-session:test:epoch",
  worldReady: true,
};

function admittedState(): Gate1State {
  const state = planStarterResidentialIntent({
    intentId: "intent:gate1-starter:test",
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
    siteCandidates: [{ id: "site-1", target: { center: { x: 0, z: 0 }, radius: 32 }, score: 1, blocked: false }],
  });
  state.tranche.stage = "ROAD_DELIVERED";
  return state;
}

/**
 * The certified road exactly as `main-adapters.authoritativeContext()` supplies
 * it: read from the ROAD_CONNECTION terminal outcome's durable command.
 */
const certifiedRoad = {
  entity: DELIVERED_ROAD,
  position: { x: DELIVERED_ROAD_GEOMETRY.x1, z: DELIVERED_ROAD_GEOMETRY.z1 },
  prefab: DELIVERED_ROAD_GEOMETRY.prefab,
};

const admissionContext = (
  overrides: Partial<AuthoritativeUtilityAdmissionContext> = {},
): AuthoritativeUtilityAdmissionContext => ({
  state: admittedState(),
  world,
  treasury: 999_912,
  certifiedRoad,
  certifiedRoadRefs: [DELIVERED_ROAD],
  // No durable placement operation exists yet. Placement durability is proven
  // in its own suite; here it is the precondition that lets admission proceed.
  firstFacilityPlacement: { status: "NONE" },
  ...overrides,
});

const facilityPlan: PlannedUtilityFacility = {
  kind: "power",
  prefab: "WindTurbine01",
  position: { x: 4, z: 0 },
  rotationCandidates: [0],
  constructionCost: 4_000,
  expectedCapacity: 100,
  siteEvidence: { source: "fixture" },
  serviceRoads: [{ start: { x: 10, z: -1 }, end: { x: 10, z: 1 } }],
  connection: { prefab: "Low-voltage Ground Cable", start: { x: 4, z: 0 }, end: { x: 10, z: 0 } },
};

const existingFacility: UtilityPlacementReceipt = {
  entity: FACILITY_ENTITY,
  prefab: "WindTurbine01",
  position: { x: 4, z: 0 },
};

const connector = {
  type: "electricity" as const,
  node: { index: 20, version: 1 },
  worldPosition: { x: 4, z: 0 },
  attached: false,
  capacity: { electricity: 100 },
};

const connectionRoadEdge: SpatialRoadEdge = {
  entity: CONNECTION_ROAD,
  prefab: "Low-voltage Ground Cable",
  native: true,
  startNode: { index: 31, version: 1 },
  endNode: { index: 32, version: 1 },
  start: { x: 10, z: -1 },
  end: { x: 10, z: 1 },
  length: 2,
};

/**
 * Planner ports in the shape production supplies. `findExistingFacility` and
 * `findCurrentUtilityBinding` are the only world-facing reads; neither can
 * place anything because the preparation ports deliberately carry no `execute`.
 */
function plannerPorts(
  options: {
    facilityExists?: boolean;
    plan?: PlannedUtilityFacility;
    onPreflight?: () => void;
    onRoadEdges?: () => void;
  } = {},
): UtilityExecutionPlannerPorts {
  const facilityExists = options.facilityExists ?? false;
  return {
    plan: async (_kind, context) =>
      context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? {
            status: "candidate",
            connection: {
              mode: "EXISTING_FACILITY_CONNECTION" as const,
              kind: "electricity" as const,
              facility: existingFacility,
              connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 4, z: 0 }, end: { x: 10, z: 0 } },
            },
            reason: "fixture",
          }
        : { status: "candidate", facility: options.plan ?? facilityPlan, reason: "fixture" },
    preflight: async () => {
      options.onPreflight?.();
      return true;
    },
    readConnectors: async () => [connector],
    readCapacity: async () => ({
      revision: GENERATION,
      capacity: 0,
      consumption: 0,
      fulfilledConsumption: 0,
      issueActive: true,
    }),
    currentRevision: async () => GENERATION,
    findCurrentUtilityBinding: async () =>
      facilityExists
        ? { status: "MATCH" as const, binding: { facility: existingFacility, connector } }
        : { status: "BLOCKED" as const, reason: "UTILITY_FACILITY_NOT_FOUND" },
    findExistingFacility: async () => (facilityExists ? existingFacility : undefined),
    roadEdges: async () => {
      options.onRoadEdges?.();
      return [connectionRoadEdge];
    },
  };
}

/** Every planning input a production admission may produce, with no native authority attached. */
function admissionInput(context: AuthoritativeUtilityAdmissionContext): UtilityPreparationInput {
  return buildUtilityPreparationInput(context);
}

describe("first-facility placement authorization", () => {
  test("authorized K05 first facility admits a bounded placement scope and sends nothing", async () => {
    const input = admissionInput(admissionContext());
    expect(input.facilityPlacementAuthorization).toBeDefined();

    let preflightCalls = 0;
    let roadEdgeReads = 0;
    const result = await prepareScopedUtilityExecution(
      input,
      plannerPorts({
        onPreflight: () => {
          preflightCalls += 1;
        },
        onRoadEdges: () => {
          roadEdgeReads += 1;
        },
      }),
    );

    expect(result).toMatchObject({ status: "READY", mode: "GREENFIELD_FIRST_PLACEMENT" });
    if (result.status !== "READY") return;
    // The certified road is the only road authority; nothing was searched for.
    expect(result.executionScope.certifiedRoadRefs).toEqual([DELIVERED_ROAD]);
    expect(result.executionScope.targetServiceEntry.road).toEqual(DELIVERED_ROAD);
    expect(result.targetSemantics?.targetRoad.prefab).toBe("Medium Road");
    expect(preflightCalls).toBe(0);
    expect(roadEdgeReads).toBe(0);
  });

  test("unauthorized placement still fails closed with no native submission", async () => {
    // No certified road: the composition root could not read durable ROAD evidence.
    const input = admissionInput(admissionContext({ certifiedRoad: undefined, certifiedRoadRefs: undefined }));
    expect(input.facilityPlacementAuthorization).toBeUndefined();

    const result = await prepareScopedUtilityExecution(input, plannerPorts());
    expect(result).toEqual(
      expect.objectContaining({
        status: "BLOCKED",
        reason: "UTILITY_FACILITY_NOT_FOUND",
        nativeActionsSubmitted: 0,
      }),
    );
  });

  test("an admitted scope is never a placement when the facility already exists", async () => {
    const input = admissionInput(admissionContext());
    // Authorization is present, but the world already has its facility.
    const result = await prepareScopedUtilityExecution(input, plannerPorts({ facilityExists: true }));

    expect(result.status).toBe("READY");
    if (result.status !== "READY") return;
    // Rebinding an existing facility, not admitting a first placement.
    expect(result).not.toHaveProperty("mode");
    expect(result).toHaveProperty("currentFacility", existingFacility);
  });

  test.each([
    [
      "an unresolved placement operation",
      { status: "UNRESOLVED" as const, commandId: "placement-1", outcome: "SUBMITTED" as const },
    ],
    ["a durably placed facility that is not visible", { status: "PLACED" as const, commandId: "placement-1" }],
    ["no durable proof at all", undefined],
  ])("withholds placement authority for %s", async (_name, durable) => {
    const input = admissionInput(admissionContext({ firstFacilityPlacement: durable }));
    const result = await prepareScopedUtilityExecution(input, plannerPorts());
    expect(result).toEqual(
      expect.objectContaining({
        status: "BLOCKED",
        reason: "UTILITY_FACILITY_PLACEMENT_UNRESOLVED",
        nativeActionsSubmitted: 0,
      }),
    );
  });

  test("a connection-only request never receives placement authority", () => {
    const input = admissionInput(admissionContext({ connectionOnly: true }));
    expect(input.connectionOnly).toBe(true);
    expect(input.facilityPlacementAuthorization).toBeUndefined();
  });

  test.each([
    [
      "a different tranche",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.trancheId = "other-tranche";
      },
    ],
    [
      "a different reservation",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.reservationRef = "other-reservation";
      },
    ],
    [
      "a different reservation envelope",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.spatialEnvelope = { center: { x: 99, z: 99 }, radius: 10 };
      },
    ],
    [
      "a spend ceiling above the admitted maximum",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.maximumSpend = 10_000_000;
      },
    ],
    [
      "an empty certified road set",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.certifiedRoadRefs = [];
      },
    ],
    [
      "a target road outside the certified road set",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.certifiedRoadRefs = [{ index: 999, version: 1 }];
      },
    ],
    [
      "a mismatched recipe kind",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.kind = "water";
      },
    ],
    [
      "a zero placement cap",
      (authorization: NonNullable<UtilityPreparationInput["facilityPlacementAuthorization"]>) => {
        authorization.maximumPlacements = 0;
      },
    ],
  ])("discards an authorization with %s and fails closed", async (_name, mutate) => {
    const input = admissionInput(admissionContext());
    mutate(input.facilityPlacementAuthorization!);
    const result = await prepareScopedUtilityExecution(input, plannerPorts());
    expect(result).toEqual(
      expect.objectContaining({
        status: "BLOCKED",
        reason: "UTILITY_FACILITY_NOT_FOUND",
        nativeActionsSubmitted: 0,
      }),
    );
  });

  test.each([
    [
      "exceeds the authorized budget",
      { ...facilityPlan, constructionCost: 10_000_000 },
      "placement_exceeds_authorized_budget",
    ],
    [
      "sits outside the admitted reservation",
      { ...facilityPlan, position: { x: 900, z: 900 } },
      "placement_outside_authorized_reservation",
    ],
  ])("refuses a placement that %s without submitting anything", async (_name, plan, placementReason) => {
    const input = admissionInput(admissionContext());
    let preflightCalls = 0;
    const result = await prepareScopedUtilityExecution(
      input,
      plannerPorts({
        plan: plan as PlannedUtilityFacility,
        onPreflight: () => {
          preflightCalls += 1;
        },
      }),
    );
    expect(result).toMatchObject({
      status: "BLOCKED",
      reason: "UTILITY_FACILITY_NOT_FOUND",
      nativeActionsSubmitted: 0,
    });
    expect(result.status === "BLOCKED" ? result.diagnostics : undefined).toEqual(
      expect.objectContaining({ preparationReason: placementReason }),
    );
    expect(preflightCalls).toBe(0);
  });

  test("a blocked preparation never reaches run(), so no native submission follows", async () => {
    const context = admissionContext();
    // Over-budget placement: admitted, then refused inside the planner.
    const foundation = {
      greenfieldUtilityBootstrap: {
        prepare: async (input: UtilityPreparationInput) =>
          prepareScopedUtilityExecution(
            input,
            plannerPorts({
              plan: { ...facilityPlan, constructionCost: 10_000_000 },
            }),
          ),
        run: async () => {
          throw new Error("run must not be reached after a blocked prepare");
        },
      },
    } satisfies Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">;

    const result = await executeProductionSkillIntent({
      registry: createSkillRegistry(),
      foundation,
      intent: { skillId: "skill.K05" },
      authoritativeContext: context,
      workflows: [new K05CommissionUtilitiesWorkflowAdapter(foundation)],
    });

    expect(result).toMatchObject({ status: "FAILED", error: expect.stringContaining("K05_PREPARE_BLOCKED:UTILITY_FACILITY_NOT_FOUND:placement_exceeds_authorized_budget") });
  });
});

/**
 * A durable, production-shaped utility boundary used for the two-dispatch
 * idempotence proof. Only the MCP-facing ports are fakes; `run()` delegates to
 * the real `runScopedGreenfieldUtilityBootstrap`, `plan()` to the real planner,
 * and every `execute` to the real `executeSharedUtilityRecovery` with the same
 * `connectionOnly: !!state.facility` rule the production adapter uses.
 */
function productionUtilityFoundation() {
  let durable: DurableGreenfieldUtilityState | null = null;
  const placementBatches: MayorAction[][] = [];
  const preparedModes: Array<string | undefined> = [];
  const recoveryConnectionOnly: boolean[] = [];
  let placedFacility: UtilityPlacementReceipt | null = null;

  const recoveryPorts = (connectionOnly: boolean): SharedUtilityRecoveryPorts => ({
    plan: async (_kind, planningContext) =>
      planningContext?.mode === "EXISTING_FACILITY_CONNECTION"
        ? {
            status: "candidate",
            connection: {
              mode: "EXISTING_FACILITY_CONNECTION" as const,
              kind: "electricity" as const,
              facility: placedFacility ?? existingFacility,
              connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 4, z: 0 }, end: { x: 10, z: 0 } },
            },
            reason: "fixture",
          }
        : { status: "candidate", facility: facilityPlan, reason: "fixture" },
    preflight: async () => true,
    execute: async (batch) => {
      if (batch.some((action) => action.type === "place_building")) placementBatches.push(batch);
      return {
        ok: true,
        requested: batch.length,
        executed: batch.length,
        results: batch.map((action, index) => ({
          index,
          type: action.type,
          ok: true,
          summary: "ok",
          ...(action.type === "place_building"
            ? { receipt: { entity: FACILITY_ENTITY, prefab: "WindTurbine01", position: { x: 4, z: 0 } } }
            : {}),
        })),
      } as unknown as MayorBatchResult;
    },
    readConnectors: async () => [connector],
    readCapacity: async () => ({
      revision: GENERATION,
      capacity: 0,
      consumption: 0,
      fulfilledConsumption: 0,
      issueActive: true,
    }),
    settle: async () => undefined,
    currentRevision: async () => GENERATION,
    findCurrentUtilityBinding: async () =>
      connectionOnly
        ? { status: "MATCH" as const, binding: { facility: placedFacility ?? existingFacility, connector } }
        : { status: "BLOCKED" as const, reason: "UTILITY_FACILITY_NOT_FOUND" },
    findExistingFacility: async () => placedFacility ?? undefined,
  });

  const evidence = (scope: GreenfieldUtilityExecutionScope): GreenfieldUtilityServiceEvidence => ({
    status: "AVAILABLE",
    revision: GENERATION,
    capacity: 0,
    consumption: 0,
    fulfilledConsumption: 0,
    issueActive: true,
    supplyExists: placedFacility !== null,
    networkConnected: false,
    cityCapacityAvailable: false,
    targetNetworkReachable: "UNKNOWN",
    facility: placedFacility,
    connector: placedFacility ? connector : null,
    targetRoad: scope.targetServiceEntry.road,
    evidenceGeneration: GENERATION,
    topologyRevision: scope.topologyRevision,
  });

  const runPorts = (scope: GreenfieldUtilityExecutionScope): ScopedGreenfieldUtilityPorts => ({
    load: async () => durable,
    save: async (state) => {
      durable = structuredClone(state);
    },
    observe: async (_kind, currentScope) => evidence(currentScope),
    rebind: async () =>
      placedFacility
        ? { status: "MATCH" as const, facility: placedFacility, connector }
        : { status: "UNKNOWN" as const, reason: "UTILITY_REBIND_NOT_APPLICABLE" },
    plan: async () => facilityPlan,
    execute: async (request) => {
      // Mirrors the production adapter: an existing facility means a
      // connection-only recovery, which structurally cannot place another one.
      const connectionOnly = !!request.state.facility;
      recoveryConnectionOnly.push(connectionOnly);
      const recovery = await executeSharedUtilityRecovery({
        kind: request.state.kind,
        expectedRevision: null,
        treasury: scope.treasury,
        runwayMonths: 0,
        connectionOnly,
        selectedPrimitive: request.selectedPrimitive,
        signal: new AbortController().signal,
        ports: recoveryPorts(!!request.state.facility),
      });
      if (recovery.facility) placedFacility = recovery.facility;
      return {
        state: {
          ...request.state,
          facility: recovery.facility ?? request.state.facility,
          connector: recovery.connector ?? request.state.connector,
          stage: recovery.connector?.attached
            ? ("CONNECTED" as const)
            : recovery.facility
              ? ("PLACED" as const)
              : ("BLOCKED" as const),
        },
        facilityConstructionAttempted: recovery.facility !== undefined && request.state.facility === null,
        networkSubmissionAttempted: false,
        failedBeforeNetworkSubmission: true,
        executionSucceeded: false,
        reason: recovery.reason,
      };
    },
    progress: async () => ({
      status: "TARGET_REACHED" as const,
      startFrame: 0,
      targetFrame: 0,
      currentFrame: 0,
      paused: null,
      reason: "fixture",
    }),
  });

  const foundation = {
    greenfieldUtilityBootstrap: {
      prepare: async (input: UtilityPreparationInput) => {
        const prepared = await prepareScopedUtilityExecution(
          input,
          plannerPorts({
            facilityExists: placedFacility !== null,
            plan: facilityPlan,
          }),
        );
        preparedModes.push(prepared.status === "READY" ? prepared.mode : undefined);
        return prepared;
      },
      run: async (scope: GreenfieldUtilityExecutionScope) =>
        runScopedGreenfieldUtilityBootstrap({ scope, ports: runPorts(scope) }),
    },
  } satisfies Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">;

  return { foundation, placementBatches, preparedModes, recoveryConnectionOnly };
}

describe("K05 production first-placement wiring", () => {
  test("dispatches through the production Skill dispatcher and places exactly one facility across a duplicate dispatch", async () => {
    const boundary = productionUtilityFoundation();
    const dispatch = () =>
      executeProductionSkillIntent({
        registry: createSkillRegistry(),
        foundation: boundary.foundation,
        intent: { skillId: "skill.K05" },
        authoritativeContext: admissionContext(),
        workflows: [new K05CommissionUtilitiesWorkflowAdapter(boundary.foundation)],
      });

    await dispatch();
    expect(boundary.preparedModes[0]).toBe("GREENFIELD_FIRST_PLACEMENT");
    expect(boundary.placementBatches).toHaveLength(1);
    expect(boundary.recoveryConnectionOnly).toEqual([false]);

    // A duplicate production execution sees the durable facility and rebinds
    // instead of admitting a second first placement.
    await dispatch();
    expect(boundary.preparedModes[1]).toBeUndefined();
    // The second run really did reach recovery — as a connection, not a placement.
    expect(boundary.recoveryConnectionOnly).toEqual([false, true]);
    expect(boundary.placementBatches).toHaveLength(1);
  });

  test("an unauthorized production dispatch never reaches a placement", async () => {
    const boundary = productionUtilityFoundation();
    const result = await executeProductionSkillIntent({
      registry: createSkillRegistry(),
      foundation: boundary.foundation,
      intent: { skillId: "skill.K05" },
      authoritativeContext: admissionContext({ certifiedRoad: undefined, certifiedRoadRefs: undefined }),
      workflows: [new K05CommissionUtilitiesWorkflowAdapter(boundary.foundation)],
    });

    expect(result).toMatchObject({ status: "FAILED", error: expect.stringContaining("K05_PREPARE_BLOCKED:UTILITY_FACILITY_NOT_FOUND") });
    expect(boundary.preparedModes).toEqual([undefined]);
    expect(boundary.placementBatches).toHaveLength(0);
  });
});
