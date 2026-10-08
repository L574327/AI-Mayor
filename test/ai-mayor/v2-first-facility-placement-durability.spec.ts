import {
  createSkillRegistry,
  executeProductionSkillIntent,
  K05CommissionUtilitiesWorkflowAdapter,
} from "../../src/main/services/ai-mayor/skills";
import type { SkillResult } from "../../src/main/services/ai-mayor/skills/schemas/result";
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
import {
  createMemoryDurableStateStorage,
  V2DurabilityCoordinator,
  type V2DurableStateStorage,
} from "../../src/main/services/ai-mayor/v2/durability";
import type { V2CommandRecord, V2CommandStatus } from "../../src/main/services/ai-mayor/v2/foundation";
import { type Gate1State, planStarterResidentialIntent } from "../../src/main/services/ai-mayor/v2/gate1";
import {
  createDurableGreenfieldUtilityState,
  type GreenfieldUtilityExecutionScope,
  type GreenfieldUtilityServiceEvidence,
  runScopedGreenfieldUtilityBootstrap,
  type ScopedGreenfieldUtilityPorts,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import type { V2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import {
  AUTHORITATIVE_UTILITY_KIND,
  type AuthoritativeUtilityAdmissionContext,
  buildUtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-admission-context";
import {
  prepareScopedUtilityExecution,
  type UtilityExecutionPlannerPorts,
  type UtilityPreparationInput,
} from "../../src/main/services/ai-mayor/v2/utility-execution-planner";
import {
  type FirstFacilityPlacementDurability,
  firstFacilityPlacementDurability,
  firstFacilityPlacementPermitted,
} from "../../src/main/services/ai-mayor/v2/utility-placement-durability";

/**
 * The crash window: a first facility reaches native, the facility really exists
 * in the world, and the process dies before the utility durable completion is
 * written. On restart the observation may be incomplete, so "the facility is
 * not visible" is not evidence that none was built.
 *
 * Everything below runs the real `V2DurabilityCoordinator`, the real admission
 * builder, the real planner, the real `runScopedGreenfieldUtilityBootstrap` and
 * the real `executeSharedUtilityRecovery`. Only the MCP-shaped ports are fakes,
 * and the native submission boundary applies the same durable rule production
 * applies before it would place anything.
 */

const WORLD_SESSION = "cd0d8ea80e624df4abd692fc89df5cc4";
const SAVE_A = "save:load-asset-a:save-data-a";
const GENERATION_1 = "generation-1";
const GENERATION_2 = "generation-2";
const DELIVERED_ROAD: SpatialEntityRef = { index: 177757, version: 15 };
const CONNECTION_ROAD: SpatialEntityRef = { index: 30, version: 1 };
const FACILITY_ENTITY: SpatialEntityRef = { index: 100, version: 1 };

function rawWorld(generation: string) {
  return {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: `cs2-session:${WORLD_SESSION}`,
      nativeSessionGuid: WORLD_SESSION,
      loadPurpose: "LoadGame",
      loadAssetGuid: "load-asset-a",
      saveDataAssetGuid: "save-data-a",
      mapAssetGuid: "map-a",
      checkpointId: SAVE_A,
      bridgeRuntimeEpoch: `bridge-${generation}`,
      generation,
      generationSequence: 1,
      generationOrigin: generation === GENERATION_1 ? "LOAD_COMPLETED" : "ATTACHED_EXISTING_WORLD",
    },
  };
}

function admittedState(intentSuffix = ""): Gate1State {
  const state = planStarterResidentialIntent({
    intentId: `intent:gate1-starter:test${intentSuffix}`,
    targetResidents: 12,
    maximumBudget: 25_000,
    planningEnvelope: { center: { x: 0, z: 0 }, radius: 180 },
    siteCandidates: [{ id: "site-1", target: { center: { x: 0, z: 0 }, radius: 32 }, score: 1, blocked: false }],
  });
  state.tranche.stage = "ROAD_DELIVERED";
  return state;
}

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

const placedReceipt: UtilityPlacementReceipt = {
  entity: FACILITY_ENTITY,
  prefab: "WindTurbine01",
  position: { x: 4, z: 0 },
};

/** A durable UTILITY command carrying a facility placement, as production writes it. */
function utilityPlacementCommand(input: {
  commandId: string;
  state: Gate1State;
  worldEpochId: string;
  generation: string;
  status: V2CommandStatus;
  effectAbsenceProven?: boolean;
  placementScopeId?: string;
  position?: { x: number; z: number };
}): V2CommandRecord {
  const actions: MayorAction[] = [{ type: "place_building", prefab: "WindTurbine01", x: input.position?.x ?? 4, z: input.position?.z ?? 0, rotation: 0 }];
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: input.commandId,
    actionFamily: "UTILITY",
    actionType: "place_building",
    authorizedScope: {
      owner: { ownerType: "TRANCHE", ownerId: input.state.tranche.id },
      actionFamily: "UTILITY",
      utilityKind: AUTHORITATIVE_UTILITY_KIND,
      projectId: input.state.project.id,
      trancheId: input.state.tranche.id,
      reservationRef: input.state.tranche.reservationRef,
      ...(input.placementScopeId ? { placementScopeId: input.placementScopeId } : {}),
      worldEpochId: input.worldEpochId,
      generation: input.generation,
      topologyRevision: `${input.generation}:production`,
      certifiedRoadRefs: [DELIVERED_ROAD],
      exactInput: JSON.stringify(actions),
      spatialEnvelope: input.state.project.utilityReservation,
      budget: { authorizedMaxSpend: 25_000, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
    },
    createdAt: "2026-09-21T00:00:00.000Z",
    submittedAt: input.status === "CREATED" ? null : "2026-09-21T00:00:01.000Z",
    nativeResultSummary: null,
    status: input.status,
    statusHistory: [{ status: input.status, at: "2026-09-21T00:00:01.000Z" }],
    reconciliationStatus: input.status === "OBSERVED_MISMATCH" ? "MISMATCH" : "NOT_STARTED",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: input.effectAbsenceProven ?? false,
  };
}

/**
 * A production-shaped K05 boundary over a real durable store.
 *
 * MCP transport is faked; durability, admission, planning, the bounded
 * bootstrap, and utility recovery are the real production modules.
 */
function harness(options: { storage?: V2DurableStateStorage; state?: Gate1State; seedRootPlacement?: boolean } = {}) {
  const storage = options.storage ?? createMemoryDurableStateStorage();
  let coordinator = new V2DurabilityCoordinator(storage);
  let activation = coordinator.activate(rawWorld(GENERATION_1));

  const state = options.state ?? admittedState();
  if (options.seedRootPlacement) {
    const prior = utilityPlacementCommand({ commandId: "site-a-placement", state, worldEpochId: activation.world.worldEpochId,
      generation: activation.world.generation, status: "CREATED", position: { x: -40, z: -40 } });
    coordinator.commandJournal.create(prior);
    coordinator.commandJournal.update(prior.commandId, (current) => ({ ...current, status: "OBSERVED_MATCH" }));
  }
  const placementBatches: MayorAction[][] = [];
  const networkBatches: MayorAction[][] = [];
  const preparedDurability: FirstFacilityPlacementDurability[] = [];
  const preparedStatuses: string[] = [];
  /** The world's facility, as the native side knows it. Survives a restart. */
  let worldFacility: UtilityPlacementReceipt | null = null;
  /** The utility durable state, which a crash can fail to receive. */
  let durableUtilityState: Awaited<ReturnType<ScopedGreenfieldUtilityPorts["load"]>> = null;
  /** When set, the next `save` throws — modelling a crash before completion lands. */
  let crashOnSaveAfterPlacement = false;
  let sequence = 0;

  const scopeOf = (scope: GreenfieldUtilityExecutionScope) => ({
    projectId: scope.projectId,
    trancheId: scope.trancheId,
    reservationRef: scope.reservationRef,
    utilityKind: AUTHORITATIVE_UTILITY_KIND,
    placementScopeId: scope.placementScopeId ?? "utility-placement:legacy",
  });

  const placementDurability = (scope: GreenfieldUtilityExecutionScope) =>
    firstFacilityPlacementDurability(coordinator.utilityPlacementOperations(scopeOf(scope)));

  const admissionContext = (): AuthoritativeUtilityAdmissionContext => ({
    state,
    world: activation.world,
    treasury: 999_912,
    certifiedRoad: { entity: DELIVERED_ROAD, position: { x: -541.6216, z: -47.279007 }, prefab: "Medium Road" },
    certifiedRoadRefs: [DELIVERED_ROAD],
    firstFacilityPlacement: firstFacilityPlacementDurability(
      coordinator.utilityPlacementOperations({
        projectId: state.project.id,
        trancheId: state.tranche.id,
          reservationRef: state.tranche.reservationRef,
          utilityKind: AUTHORITATIVE_UTILITY_KIND,
          placementScopeId: state.tranche.utilityExecution?.utilities[AUTHORITATIVE_UTILITY_KIND]?.placementScopeId ?? "utility-placement:legacy",
      }),
    ),
  });

  const plannerPorts = (scope: GreenfieldUtilityExecutionScope): UtilityExecutionPlannerPorts => ({
    plan: async (_kind, context) =>
      context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? {
            status: "candidate",
            connection: {
              mode: "EXISTING_FACILITY_CONNECTION" as const,
              kind: AUTHORITATIVE_UTILITY_KIND,
              facility: placedReceipt,
              connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 4, z: 0 }, end: { x: 10, z: 0 } },
            },
            reason: "fixture",
          }
        : { status: "candidate", facility: facilityPlan, reason: "fixture" },
    preflight: async () => true,
    readConnectors: async () => [connector],
    readCapacity: async () => ({
      revision: GENERATION_1,
      capacity: 0,
      consumption: 0,
      fulfilledConsumption: 0,
      issueActive: true,
    }),
    currentRevision: async () => GENERATION_1,
    findCurrentUtilityBinding: async () =>
      worldFacility
        ? { status: "MATCH" as const, binding: { facility: worldFacility, connector } }
        : { status: "BLOCKED" as const, reason: "UTILITY_FACILITY_NOT_FOUND" },
    // The observer knows a facility only when the world really has one. After a
    // crash that can be false even though the native placement happened — which
    // is exactly why the durable journal, not this read, is the authority.
    findExistingFacility: async () => worldFacility ?? undefined,
    roadEdges: async () => [connectionRoadEdge],
    ...(scope ? {} : {}),
  });

  const recoveryPorts = (
    scope: GreenfieldUtilityExecutionScope,
    connectionOnly: boolean,
  ): SharedUtilityRecoveryPorts => ({
    plan: async (_kind, context) =>
      context?.mode === "EXISTING_FACILITY_CONNECTION"
        ? {
            status: "candidate",
            connection: {
              mode: "EXISTING_FACILITY_CONNECTION" as const,
              kind: AUTHORITATIVE_UTILITY_KIND,
              facility: worldFacility ?? placedReceipt,
              connection: { prefab: "Low-voltage Ground Cable" as const, start: { x: 4, z: 0 }, end: { x: 10, z: 0 } },
            },
            reason: "fixture",
          }
        : { status: "candidate", facility: facilityPlan, reason: "fixture" },
    preflight: async () => true,
    execute: async (batch) => {
      const facilityBatch = batch.some((action) => action.type === "place_building");
      const networkBatch = batch.length > 0 && batch.every((action) => action.type === "build_road");
      if (facilityBatch) {
        // The production rule, evaluated against the real durable journal at the
        // moment of submission.
        const placement = placementDurability(scope);
        if (!firstFacilityPlacementPermitted(placement)) {
          throw new Error(`UTILITY_FACILITY_PLACEMENT_UNRESOLVED:${placement.status}`);
        }
      }
      if (facilityBatch || networkBatch) {
        // Write-ahead command identity: durable before the native call.
        sequence += 1;
        const commandId = `utility-command-${sequence}`;
        const template = utilityPlacementCommand({
          commandId,
          state,
          worldEpochId: scope.worldEpochId,
          generation: scope.generation,
          status: "CREATED",
          placementScopeId: scope.placementScopeId,
        });
        const record: V2CommandRecord = {
          ...template,
          actionType: batch.map((action) => action.type).join("+"),
          // The exact authorized actions are the command's identity, so the
          // placement batch and the cable batch must not share one.
          authorizedScope: { ...template.authorizedScope, exactInput: JSON.stringify(batch) },
        };
        coordinator.commandJournal.create(record);
        coordinator.commandJournal.update(commandId, (current) => ({ ...current, status: "AUTHORIZED" }));
        coordinator.commandJournal.update(commandId, (current) => ({
          ...current,
          status: "SUBMITTED",
          submittedAt: "2026-09-21T00:00:01.000Z",
        }));
      }
      if (facilityBatch) {
        placementBatches.push(batch);
        worldFacility = placedReceipt;
        if (crashOnSaveAfterPlacement) crashOnSaveAfterPlacement = "consumed";
      }
      if (networkBatch) networkBatches.push(batch);
      return {
        ok: true,
        requested: batch.length,
        executed: batch.length,
        results: batch.map((action, index) => ({
          index,
          type: action.type,
          ok: true,
          summary: "ok",
          ...(action.type === "place_building" ? { receipt: placedReceipt } : {}),
        })),
      } as unknown as MayorBatchResult;
    },
    readConnectors: async () => [{ ...connector, attached: worldFacility !== null }],
    readCapacity: async () => ({
      revision: GENERATION_1,
      capacity: worldFacility ? 150 : 50,
      consumption: 100,
      fulfilledConsumption: worldFacility ? 100 : 50,
      issueActive: worldFacility === null,
    }),
    settle: async () => undefined,
    currentRevision: async () => GENERATION_1,
    findCurrentUtilityBinding: async () =>
      connectionOnly && worldFacility
        ? { status: "MATCH" as const, binding: { facility: worldFacility, connector } }
        : { status: "BLOCKED" as const, reason: "UTILITY_FACILITY_NOT_FOUND" },
    findExistingFacility: async () => worldFacility ?? undefined,
  });

  const runPorts = (scope: GreenfieldUtilityExecutionScope): ScopedGreenfieldUtilityPorts => ({
    load: async () => durableUtilityState,
    save: async (value) => {
      if (crashOnSaveAfterPlacement === "consumed") {
        crashOnSaveAfterPlacement = false;
        throw new Error("SIMULATED_PROCESS_CRASH_BEFORE_DURABLE_COMPLETION");
      }
      durableUtilityState = structuredClone(value);
    },
    observe: async (_kind, currentScope): Promise<GreenfieldUtilityServiceEvidence> => ({
      status: "AVAILABLE",
      revision: GENERATION_1,
      capacity: 0,
      consumption: 0,
      fulfilledConsumption: 0,
      issueActive: true,
      supplyExists: worldFacility !== null,
      networkConnected: false,
      cityCapacityAvailable: false,
      targetNetworkReachable: "UNKNOWN",
      facility: worldFacility,
      connector: worldFacility ? connector : null,
      targetRoad: currentScope.targetServiceEntry.road,
      evidenceGeneration: GENERATION_1,
      topologyRevision: currentScope.topologyRevision,
    }),
    rebind: async () =>
      worldFacility
        ? { status: "MATCH" as const, facility: worldFacility, connector }
        : { status: "UNKNOWN" as const, reason: "UTILITY_REBIND_NOT_APPLICABLE" },
    plan: async () => facilityPlan,
    execute: async (request) => {
      const connectionOnly = !!request.state.facility;
      const recovery = await executeSharedUtilityRecovery({
        kind: request.state.kind,
        expectedRevision: null,
        treasury: scope.treasury,
        runwayMonths: 0,
        connectionOnly,
        selectedPrimitive: request.selectedPrimitive,
        signal: new AbortController().signal,
        ports: recoveryPorts(scope, connectionOnly),
      });
      return {
        state: {
          ...request.state,
          facility: recovery.facility ?? request.state.facility,
          connector: recovery.connector ?? request.state.connector,
          stage: recovery.facility ? ("PLACED" as const) : ("BLOCKED" as const),
        },
        facilityConstructionAttempted: recovery.facility !== undefined && request.state.facility === null,
        networkSubmissionAttempted: networkBatches.length > 0,
        failedBeforeNetworkSubmission: false,
        executionSucceeded: recovery.ok,
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
        const scope = input as unknown as GreenfieldUtilityExecutionScope;
        preparedDurability.push(placementDurability(scope));
        const prepared = await prepareScopedUtilityExecution(input, plannerPorts(scope));
        preparedStatuses.push(
          prepared.status === "READY" ? (prepared.mode ?? "EXISTING_FACILITY") : `BLOCKED:${prepared.reason}`,
        );
        return prepared;
      },
      run: async (scope: GreenfieldUtilityExecutionScope) =>
        runScopedGreenfieldUtilityBootstrap({ scope, ports: runPorts(scope) }),
    },
  } satisfies Pick<V2FoundationPorts, "greenfieldUtilityBootstrap">;

  return {
    foundation,
    placementBatches,
    preparedDurability,
    preparedStatuses,
    world: () => activation.world,
    coordinator: () => coordinator,
    /** Simulate the process dying between the native placement and the completion. */
    armCrashBeforeCompletionSave: () => {
      crashOnSaveAfterPlacement = true;
    },
    /** Kill and reopen the process over the same durable store. */
    restart: (generation = GENERATION_2) => {
      coordinator = new V2DurabilityCoordinator(storage);
      activation = coordinator.activate(rawWorld(generation));
      // The native world keeps its facility; the utility durable state and the
      // observation do not necessarily know about it.
      durableUtilityState = null;
    },
    /** After a restart the observation is incomplete: nothing is visible. */
    forgetObservedFacility: () => {
      worldFacility = null;
    },
    dispatch: (): Promise<SkillResult> =>
      executeProductionSkillIntent({
        registry: createSkillRegistry(),
        foundation,
        intent: { skillId: "skill.K05" },
        authoritativeContext: admissionContext(),
        workflows: [new K05CommissionUtilitiesWorkflowAdapter(foundation)],
      }),
  };
}

const ROAD_CONNECTION_TASK = admittedState().tasks.find((task) => task.kind === "ROAD_CONNECTION")!;

describe("first-facility placement durability", () => {
  describe("durable decision", () => {
    test("no operation, proven-clear failure, placed, unresolved, unproven", () => {
      expect(firstFacilityPlacementDurability([])).toEqual({ status: "NONE" });
      expect(firstFacilityPlacementDurability(null)).toMatchObject({ status: "UNPROVEN" });
      expect(
        firstFacilityPlacementDurability([
          {
            commandId: "c1",
            position: 1,
            outcome: "FAILED",
            status: "FAILED_BEFORE_SUBMIT",
            effectAbsenceProven: false,
            failedBeforeSubmit: true,
          },
        ]),
      ).toEqual({ status: "TERMINAL_NO_MUTATION", commandId: "c1" });
      expect(
        firstFacilityPlacementDurability([
          {
            commandId: "c1",
            position: 1,
            outcome: "OBSERVED_MATCH",
            status: "OBSERVED_MATCH",
            effectAbsenceProven: false,
            failedBeforeSubmit: false,
          },
        ]),
      ).toEqual({ status: "PLACED", commandId: "c1" });
      expect(
        firstFacilityPlacementDurability([
          {
            commandId: "c1",
            position: 1,
            outcome: "SUBMITTED",
            status: "SUBMITTED",
            effectAbsenceProven: false,
            failedBeforeSubmit: false,
          },
        ]),
      ).toEqual({ status: "UNRESOLVED", commandId: "c1", outcome: "SUBMITTED" });
      // A failure that does not prove absence is still unresolved.
      expect(
        firstFacilityPlacementDurability([
          {
            commandId: "c1",
            position: 1,
            outcome: "FAILED",
            status: "REJECTED",
            effectAbsenceProven: false,
            failedBeforeSubmit: false,
          },
        ]),
      ).toMatchObject({ status: "UNRESOLVED" });
    });

    test("a durable success outranks every other operation", () => {
      expect(
        firstFacilityPlacementDurability([
          {
            commandId: "c1",
            position: 1,
            outcome: "SUBMITTED",
            status: "SUBMITTED",
            effectAbsenceProven: false,
            failedBeforeSubmit: false,
          },
          {
            commandId: "c2",
            position: 2,
            outcome: "OBSERVED_MATCH",
            status: "OBSERVED_MATCH",
            effectAbsenceProven: false,
            failedBeforeSubmit: false,
          },
        ]),
      ).toEqual({ status: "PLACED", commandId: "c2" });
    });
  });

  test("a placement survives a restart and blocks a second one even when nothing is visible", async () => {
    const h = harness();
    const first = await h.dispatch();
    expect(h.placementBatches).toHaveLength(1);
    expect(first.status).toBe("WAITING");

    h.restart(GENERATION_2);
    h.forgetObservedFacility();
    const second = await h.dispatch();

    // The durable write-ahead command is the only thing that knows a facility
    // may exist, and it is enough.
    expect(h.placementBatches).toHaveLength(1);
    expect(h.preparedStatuses[0]).toBe("GREENFIELD_FIRST_PLACEMENT");
    expect(h.preparedStatuses[1]).toBe("BLOCKED:UTILITY_FACILITY_PLACEMENT_UNRESOLVED");
    expect(second.status).toBe("WAITING");
    expect(second.error).toBe("K05_PREPARE_HELD:UTILITY_FACILITY_PLACEMENT_UNRESOLVED:UTILITY_FACILITY_NOT_FOUND");
  });

  test("a crash after the native placement before the durable completion still yields exactly one placement", async () => {
    const h = harness();
    h.armCrashBeforeCompletionSave();
    await expect(h.dispatch()).rejects.toThrow("SIMULATED_PROCESS_CRASH_BEFORE_DURABLE_COMPLETION");
    expect(h.placementBatches).toHaveLength(1);

    // Restart with an incomplete observation: the facility is gone from the
    // observer's view, and the utility durable state never received it.
    h.restart(GENERATION_2);
    h.forgetObservedFacility();
    const after = await h.dispatch();

    expect(h.placementBatches).toHaveLength(1);
    expect(after.status).toBe("WAITING");
  });

  test("an UNKNOWN submission holds the scope instead of resubmitting", async () => {
    const h = harness();
    await h.dispatch();
    expect(h.placementBatches).toHaveLength(1);

    // The native call never confirmed. Mark the durable command UNKNOWN, as the
    // transport-uncertainty path does.
    const coordinator = h.coordinator();
    const commandId = coordinator.commandJournal.list()[0].commandId;
    coordinator.commandJournal.update(commandId, (current) => ({
      ...current,
      status: "NATIVE_COMPLETION_UNKNOWN",
      failureOrUnknownReason: "transport timeout",
    }));

    h.restart(GENERATION_2);
    h.forgetObservedFacility();
    const after = await h.dispatch();

    expect(h.placementBatches).toHaveLength(1);
    expect(after.status).toBe("WAITING");
  });

  test("a proven terminal failure with no mutation permits a new attempt", async () => {
    const h = harness();
    await h.dispatch();
    expect(h.placementBatches).toHaveLength(1);

    const coordinator = h.coordinator();
    const commandId = coordinator.commandJournal.list()[0].commandId;
    coordinator.commandJournal.update(commandId, (current) => ({
      ...current,
      status: "OBSERVED_MISMATCH",
      reconciliationStatus: "MISMATCH",
      effectAbsenceProven: true,
      failureOrUnknownReason: "authoritative topology contains no matching facility",
    }));

    h.restart(GENERATION_2);
    h.forgetObservedFacility();
    await h.dispatch();

    // The previous attempt is proven to have left nothing, so one more attempt
    // is legitimate.
    expect(h.placementBatches).toHaveLength(2);
  });


  test("an existing facility is rebound, never replaced", async () => {
    const h = harness();
    await h.dispatch();
    expect(h.placementBatches).toHaveLength(1);

    // The facility is visible again after the restart: claim it.
    h.restart(GENERATION_2);
    await h.dispatch();

    expect(h.placementBatches).toHaveLength(1);
    // The second admission took the existing-facility branch, not a first placement.
    expect(h.preparedStatuses[1]).toBe("EXISTING_FACILITY");
  });

  test("a successor scope stays site-specific through first-placement admission and native submission", async () => {
    const state = admittedState(":successor-placement");
    const placementScopeId = "utility-placement:site-b";
    const executionScope: GreenfieldUtilityExecutionScope = {
      intentId: state.intent.id, projectId: state.project.id, trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef, placementScopeId,
      worldId: `cs2-session:${WORLD_SESSION}`, worldEpochId: `cs2-session:${WORLD_SESSION}:generation:${GENERATION_1}`,
      generation: GENERATION_1, topologyRevision: `${GENERATION_1}:production`,
      executionMechanismRevision: "localconnect-membership-production-v2", certifiedRoadRefs: [DELIVERED_ROAD],
      targetServiceEntry: { road: DELIVERED_ROAD, position: { x: 0, z: 0 }, prefab: "Medium Road" },
      spatialEnvelope: state.project.utilityReservation, maximumSpend: 25_000, treasury: 25_000, treasurySafetyReserve: 0,
    };
    state.tranche.utilityExecution = createDurableGreenfieldUtilityState(executionScope);
    state.tranche.utilityExecution.utilities.electricity.placementScopeId = placementScopeId;
    const h = harness({ state, seedRootPlacement: true });

    await h.dispatch();

    expect(h.preparedDurability[0]).toEqual({ status: "NONE" });
    expect(h.placementBatches).toHaveLength(1);
    expect(h.coordinator().utilityPlacementOperations({
      projectId: state.project.id, trancheId: state.tranche.id, reservationRef: state.tranche.reservationRef,
      utilityKind: AUTHORITATIVE_UTILITY_KIND, placementScopeId,
    })?.map((operation) => operation.status)).toEqual(["SUBMITTED"]);
    expect(h.coordinator().utilityPlacementOperations({
      projectId: state.project.id, trancheId: state.tranche.id, reservationRef: state.tranche.reservationRef,
      utilityKind: AUTHORITATIVE_UTILITY_KIND,
    })?.map((operation) => operation.commandId)).toEqual(["site-a-placement"]);
  });

  test("proves the durable connection course separately from the placement operation", async () => {
    const h = harness();
    await h.dispatch();
    const coordinator = h.coordinator();
    const state = admittedState();
    const scope = { projectId: state.project.id, trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef, utilityKind: AUTHORITATIVE_UTILITY_KIND };
    const placements = coordinator.utilityPlacementOperations(scope);
    const networks = coordinator.utilityNetworkOperations(scope);
    // Each durable command carries exactly one kind of authority.
    expect(placements).toHaveLength(1);
    expect(networks?.map((operation) => operation.status)).toEqual(["SUBMITTED"]);
    expect(JSON.parse(networks![0].exactInput)).toEqual([expect.objectContaining({ type: "build_road" })]);
    expect(networks![0].exactInput).not.toContain("place_building");
    expect(placements![0].commandId).not.toBe(networks![0].commandId);
  });

  test("another project or tranche inherits no placement operation", async () => {
    const h = harness();
    await h.dispatch();
    expect(h.placementBatches).toHaveLength(1);

    const other = admittedState(":other");
    const coordinator = h.coordinator();
    const operations = coordinator.utilityPlacementOperations({
      projectId: other.project.id,
      trancheId: other.tranche.id,
      reservationRef: other.tranche.reservationRef,
      utilityKind: AUTHORITATIVE_UTILITY_KIND,
    });
    expect(operations).toEqual([]);
    expect(firstFacilityPlacementDurability(operations)).toEqual({ status: "NONE" });
  });

  test("a durable placement command is written before any native placement", async () => {
    const h = harness();
    await h.dispatch();
    const commands = h.coordinator().commandJournal.list();
    const placement = commands[0];
    expect(placement.actionType).toBe("place_building");
    expect(placement.status).toBe("SUBMITTED");
    expect(placement.authorizedScope.actionFamily).toBe("UTILITY");
    if (placement.authorizedScope.actionFamily !== "UTILITY") return;
    expect(JSON.parse(placement.authorizedScope.exactInput)).toEqual([
      expect.objectContaining({ type: "place_building" }),
    ]);
    expect(placement.authorizedScope.owner.ownerId).toBe(ROAD_CONNECTION_TASK.trancheId);
    expect(placement.authorizedScope.trancheId).toBe(ROAD_CONNECTION_TASK.trancheId);
  });

  test("the admission refuses to authorize a placement without durable proof", async () => {
    const h = harness();
    const input = buildUtilityPreparationInput({
      state: admittedState(),
      world: h.world(),
      treasury: 999_912,
      certifiedRoad: { entity: DELIVERED_ROAD, position: { x: -541.6216, z: -47.279007 }, prefab: "Medium Road" },
      certifiedRoadRefs: [DELIVERED_ROAD],
    });
    // No durable placement state supplied at all: preparation must hold, not place.
    const prepared = await prepareScopedUtilityExecution(input, {
      plan: async () => ({ status: "candidate", facility: facilityPlan, reason: "fixture" }),
      preflight: async () => true,
      readConnectors: async () => [connector],
      readCapacity: async () => ({
        revision: GENERATION_1,
        capacity: 0,
        consumption: 0,
        fulfilledConsumption: 0,
        issueActive: true,
      }),
      currentRevision: async () => GENERATION_1,
      findCurrentUtilityBinding: async () => ({ status: "BLOCKED" as const, reason: "UTILITY_FACILITY_NOT_FOUND" }),
      findExistingFacility: async () => undefined,
      roadEdges: async () => [],
    });
    expect(prepared).toMatchObject({
      status: "BLOCKED",
      reason: "UTILITY_FACILITY_PLACEMENT_UNRESOLVED",
      nativeActionsSubmitted: 0,
    });
  });
});
