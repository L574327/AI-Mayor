import {
  isAuthoritativeStarterUtilityService,
  isAuthoritativeStarterUtilityReady,
  starterUtilityReadinessKind,
  assertGreenfieldUtilityScope,
  createDurableGreenfieldUtilityState,
  markFacilityAwaitingProductDecision,
  isScopedUtilityServiceCertified,
  runGreenfieldUtilityBootstrap,
  runScopedGreenfieldUtilityBootstrap,
  utilityConnectionCandidateContextFingerprint,
  materializeLegacyDirectCableSemanticFingerprint,
  type DurableGreenfieldUtilityState,
  type GreenfieldUtilityExecutionScope,
  type GreenfieldUtilityServiceEvidence,
  type ScopedGreenfieldUtilityPorts,
  type GreenfieldUtilityKind,
  type GreenfieldUtilityMethodPorts,
  type GreenfieldUtilityObservation,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { electricityTargetSemantics } from "../../src/main/services/ai-mayor/v2/utility-target-binding";
import { buildUtilityConnectionCandidates, type UtilityRecoveryResult } from "../../src/main/services/ai-mayor/utility-recovery";
import type { PlannedUtilityFacility } from "../../src/main/services/ai-mayor/spatial/types";
import { matchUtilityCableTopology, nativeCompletionTelemetryForUtilityBatch, normalizeUtilityTopologyPayload, readNativeUtilityQuote } from "../../src/main/services/ai-mayor/v2/main-adapter";
import { matchCablePrimitiveEffect, matchConnectionObjective } from "../../src/main/services/ai-mayor/v2/utility-topology-matchers";

const missing = (revision = "r1"): GreenfieldUtilityObservation => ({
  status: "AVAILABLE",
  revision,
  capacity: 0,
  consumption: 0,
  fulfilledConsumption: 0,
  issueActive: true,
});

const served = (revision = "r2"): GreenfieldUtilityObservation => ({
  status: "AVAILABLE",
  revision,
  capacity: 100,
  consumption: 10,
  fulfilledConsumption: 10,
  issueActive: false,
});

const recovery = (kind: GreenfieldUtilityKind): UtilityRecoveryResult => ({
  ok: true,
  kind,
  stage: "resolved",
  reason: "resolved",
  facility: { entity: { index: 100, version: 1 }, prefab: `${kind}-facility`, position: { x: 0, z: 0 } },
  connector: {
    type: kind === "electricity" ? "electricity" : "waterPipe",
    node: { index: 200, version: 1 },
    worldPosition: { x: 0, z: 0 },
    attached: true,
    capacity: kind === "electricity" ? { electricity: 100 } : kind === "water" ? { fresh: 100 } : { sewage: 100 },
  },
  before: missing(),
  after: served(),
  executedActions: 2,
  trace: ["planning", "facility_placed", "connector_discovered", "connector_connected", "verifying", "resolved"],
});

function ports(options: {
  unknown?: GreenfieldUtilityKind;
  zeroAfter?: GreenfieldUtilityKind;
  disconnected?: GreenfieldUtilityKind;
  initiallyServed?: Set<GreenfieldUtilityKind>;
} = {}) {
  const reads = new Map<GreenfieldUtilityKind, number>();
  const executions: GreenfieldUtilityKind[] = [];
  const implementation: GreenfieldUtilityMethodPorts = {
    observe: async (kind) => {
      const count = (reads.get(kind) ?? 0) + 1;
      reads.set(kind, count);
      if (options.unknown === kind) return { ...missing(), status: "UNKNOWN" };
      if (options.initiallyServed?.has(kind)) return served();
      return count === 1 || options.zeroAfter === kind ? missing() : served();
    },
    execute: async (proposal) => {
      executions.push(proposal.kind);
      const result = recovery(proposal.kind);
      return options.disconnected === proposal.kind
        ? { ...result, connector: { ...result.connector!, attached: false } }
        : result;
    },
  };
  return { implementation, executions };
}

describe("minimum Local V2 greenfield utility bootstrap", () => {
  test("zero electricity, water and sewage each produce one bounded UtilityProvision proposal", async () => {
    const fixture = ports();
    const result = await runGreenfieldUtilityBootstrap({ ownerId: "project:1", ports: fixture.implementation });
    expect(result.serviceCertified).toBe(true);
    expect(fixture.executions).toEqual(["electricity", "water", "sewage"]);
    expect(result.results.map((item) => item.proposal?.maximumAttempts)).toEqual([1, 1, 1]);
    expect(result.results.every((item) => item.stage === "SERVICE_CERTIFIED")).toBe(true);
    expect(result.providerInvocations).toBe(0);
    expect(result.legacyBrainInvocations).toBe(0);
  });

  test("facility placement with zero service cannot pass", async () => {
    const fixture = ports({ zeroAfter: "electricity" });
    const result = await runGreenfieldUtilityBootstrap({ ownerId: "project:1", ports: fixture.implementation });
    expect(result.serviceCertified).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ kind: "electricity", stage: "CONNECTED" });
  });

  test("connector attachment is required before service certification", async () => {
    const fixture = ports({ disconnected: "water" });
    const result = await runGreenfieldUtilityBootstrap({ ownerId: "project:1", ports: fixture.implementation });
    expect(result.serviceCertified).toBe(false);
    expect(result.results.at(-1)).toMatchObject({ kind: "water", stage: "PLACED", reason: "PLACEMENT_OR_CONNECTION_NOT_CERTIFIED" });
  });

  test("UNKNOWN fails closed without executing that utility", async () => {
    const fixture = ports({ unknown: "electricity" });
    const result = await runGreenfieldUtilityBootstrap({ ownerId: "project:1", ports: fixture.implementation });
    expect(result.serviceCertified).toBe(false);
    expect(fixture.executions).toEqual([]);
    expect(result.results[0]).toMatchObject({ stage: "BLOCKED", reason: "UTILITY_OBSERVATION_UNKNOWN" });
  });

  test("already certified service does not duplicate a facility", async () => {
    const fixture = ports({ initiallyServed: new Set(["electricity", "water", "sewage"]) });
    const result = await runGreenfieldUtilityBootstrap({ ownerId: "project:1", ports: fixture.implementation });
    expect(result.serviceCertified).toBe(true);
    expect(fixture.executions).toEqual([]);
    expect(result.results.every((item) => item.proposal === null)).toBe(true);
  });

  test("capacity, headroom, issue state and fulfilled demand are authoritative gates", () => {
    expect(isAuthoritativeStarterUtilityService(served())).toBe(true);
    expect(isAuthoritativeStarterUtilityService({ ...served(), capacity: 0 })).toBe(false);
    expect(isAuthoritativeStarterUtilityService({ ...served(), capacity: 5 })).toBe(false);
    expect(isAuthoritativeStarterUtilityService({ ...served(), issueActive: true })).toBe(false);
    expect(isAuthoritativeStarterUtilityService({ ...served(), fulfilledConsumption: 9 })).toBe(false);
    expect(isAuthoritativeStarterUtilityService({ ...served(), status: "UNKNOWN" })).toBe(false);
    expect(isAuthoritativeStarterUtilityService({ ...served(), fulfilledConsumption: null })).toBe(false);
    expect(isAuthoritativeStarterUtilityService({ ...served(), freshness: "UNKNOWN" })).toBe(false);
  });

  test("zero-consumer infrastructure readiness is explicit and is not service delivery", () => {
    const emptyNetwork = { ...served(), consumption: 0, fulfilledConsumption: null };
    expect(starterUtilityReadinessKind(emptyNetwork)).toBe("PRE_CONSUMER_INFRASTRUCTURE");
    expect(isAuthoritativeStarterUtilityReady(emptyNetwork)).toBe(true);
    expect(isAuthoritativeStarterUtilityService(emptyNetwork)).toBe(false);
    expect(isAuthoritativeStarterUtilityReady({ ...served(), fulfilledConsumption: null })).toBe(false);
  });

});

describe("legacy direct-cable semantic fingerprint materialization", () => {
  const semantic = electricityTargetSemantics({
    contact: { x: 20, z: 0 },
    targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 20, z: 0 } },
    approvedPlanRevision: "topology:1",
  });
  const actions = [{ type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 }];
  const candidate = (overrides: Partial<DurableGreenfieldUtilityState["utilities"]["electricity"]["candidateLedger"][number]> = {}) => ({
    candidateId: "candidate:cable", objectiveId: "objective:1", kind: "direct-cable" as const, ordinal: 1,
    exactActions: structuredClone(actions), actionFingerprint: JSON.stringify(actions), approvedPlanRevision: "topology:1",
    spatialScope: { center: { x: 0, z: 0 }, radius: 100 }, budgetCeiling: 10_000,
    ledgerState: "NOT_ATTEMPTED" as const, commandId: null, primitiveEffect: "NOT_OBSERVED" as const, ...overrides,
  });

  test("materializes only the missing field from durable semantic authority", () => {
    const result = materializeLegacyDirectCableSemanticFingerprint({ candidate: candidate(), approvedExactActions: actions, approvedCablePrefab: "Low-voltage Ground Cable", semantic });
    expect(result).toEqual({ status: "PASS", targetSemanticFingerprint: JSON.stringify(semantic) });
  });

  test.each([
    ["prefab", { approvedCablePrefab: "High-voltage Cable" }],
    ["contact", { approvedExactActions: [{ ...actions[0], x2: 20.000001 }] }],
    ["revision", { candidate: candidate({ approvedPlanRevision: "topology:2" }) }],
    ["actions", { candidate: candidate({ exactActions: [{ ...actions[0], x1: 0.000001 }] }) }],
    ["fingerprint", { candidate: candidate({ actionFingerprint: "[]" }) }],
  ] as const)("rejects %s mismatch without mutation", (name, input) => {
    const original = candidate();
    const result = materializeLegacyDirectCableSemanticFingerprint({
      candidate: input.candidate ?? original, approvedExactActions: input.approvedExactActions ?? actions,
      approvedCablePrefab: input.approvedCablePrefab ?? "Low-voltage Ground Cable", semantic,
    });
    expect(result.status).toBe("FAIL");
    expect(original.targetSemanticFingerprint).toBeUndefined();
    expect(name).toBeTruthy();
  });

  test("rejects an incomplete durable semantic scope", () => {
    const result = materializeLegacyDirectCableSemanticFingerprint({ candidate: candidate(), approvedExactActions: actions, approvedCablePrefab: "Low-voltage Ground Cable", semantic: undefined });
    expect(result).toEqual({ status: "FAIL", reason: "DURABLE_TARGET_SEMANTICS_INCOMPLETE" });
  });

  test.each(["AUTHORIZED", "SUBMITTED", "RECONCILING", "OBSERVED_MATCH", "FAILED_DETERMINISTIC", "UNKNOWN"] as const)("blocks attempted %s candidate", (ledgerState) => {
    const result = materializeLegacyDirectCableSemanticFingerprint({ candidate: candidate({ ledgerState, commandId: ledgerState === "AUTHORIZED" ? "cmd:1" : null }), approvedExactActions: actions, approvedCablePrefab: "Low-voltage Ground Cable", semantic });
    expect(result).toMatchObject({ status: "FAIL", reason: "CANDIDATE_ALREADY_ATTEMPTED" });
  });

  test("keeps immutable candidate identity unchanged", () => {
    const value = candidate();
    const before = { candidateId: value.candidateId, exactActions: JSON.stringify(value.exactActions), actionFingerprint: value.actionFingerprint, approvedPlanRevision: value.approvedPlanRevision };
    const result = materializeLegacyDirectCableSemanticFingerprint({ candidate: value, approvedExactActions: actions, approvedCablePrefab: "Low-voltage Ground Cable", semantic });
    expect(result.status).toBe("PASS");
    expect({ candidateId: value.candidateId, exactActions: JSON.stringify(value.exactActions), actionFingerprint: value.actionFingerprint, approvedPlanRevision: value.approvedPlanRevision }).toEqual(before);
  });
});

const scopedScope = (): GreenfieldUtilityExecutionScope => ({
  intentId: "intent:1", projectId: "project:1", trancheId: "tranche:1", reservationRef: "reservation:1",
  worldId: "world:1", worldEpochId: "epoch:1", generation: "generation:1", topologyRevision: "topology:1",
  certifiedRoadRefs: [{ index: 10, version: 2 }],
  targetServiceEntry: { road: { index: 10, version: 2 }, position: { x: 20, z: 0 } },
  spatialEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
  maximumSpend: 10_000, treasury: 20_000, treasurySafetyReserve: 5_000,
});

/** The evidence the certified sewage recipe attaches to a judged site. */
const certifiedSewageSite = () => ({
  recipe: "basic-sewage-provision",
  receivingWater: { x: 10, z: 0, depth: 4, pollution: 0, velocity: { x: 0, z: 0 }, speed: 0 },
  connectedWaterCells: 8, downstreamDistance: 0, downstreamTermination: "STAGNANT_AT_OUTFALL",
  downstreamCells: 1, intakeCount: 0, intakesInSameWaterBody: 0, closestIntakeApproach: null,
});

const scopedPlan = (kind: GreenfieldUtilityKind): PlannedUtilityFacility => ({
  kind: kind === "electricity" ? "power" : kind,
  prefab: `${kind}-starter`, position: { x: 0, z: 0 }, rotationCandidates: [0],
  constructionCost: 100, expectedCapacity: 100,
  siteEvidence: { scoped: 1 },
  connection: { prefab: kind === "electricity" ? "Low-voltage Ground Cable" : kind === "water" ? "Small Water Pipe" : "Small Sewage Pipe", start: { x: 0, z: 0 }, end: { x: 20, z: 0 } },
  serviceRoads: [{ id: `${kind}-service-road`, role: "side", start: { x: 20, z: 0 }, end: { x: 8, z: 0 } }],
  // A plan the production planner produced for sewage always carries the
  // recipe's applicability evidence; a fixture without it models a plan the
  // durable admission must refuse, which is a different test.
  ...(kind === "sewage" ? { environmentalCertification: certifiedSewageSite() } : {}),
});

const scopedEvidence = (
  kind: GreenfieldUtilityKind,
  scope: GreenfieldUtilityExecutionScope,
  reachable: boolean,
): GreenfieldUtilityServiceEvidence => ({
  status: "AVAILABLE", revision: `${scope.generation}:10`, capacity: 100, consumption: 10,
  fulfilledConsumption: 10, issueActive: false, supplyExists: true, networkConnected: true,
  cityCapacityAvailable: true, targetNetworkReachable: reachable,
  facility: { entity: { index: kind === "electricity" ? 101 : kind === "water" ? 102 : 103, version: 1 }, prefab: `${kind}-starter`, position: { x: 0, z: 0 } },
  connector: { type: kind === "electricity" ? "electricity" : "waterPipe", node: { index: 200, version: 1 }, worldPosition: { x: 0, z: 0 }, attached: true, capacity: {} },
  targetRoad: scope.targetServiceEntry.road, evidenceGeneration: scope.generation, topologyRevision: scope.topologyRevision,
});

function scopedPorts(options: {
  disconnected?: boolean;
  reachableFromStart?: boolean;
  serviceIncomplete?: boolean;
  unknown?: boolean;
  uncertain?: boolean;
  uncertainExistingNetwork?: boolean;
  preflightOnlyFailure?: boolean;
  crashAfterAuthorized?: boolean;
  historicalRoadMatch?: boolean;
  crashBeforeExecute?: boolean;
  fingerprintMismatch?: boolean;
  preconditionPreflightRejection?: "once" | "always";
} = {}) {
  let durable: DurableGreenfieldUtilityState | null = null;
  let executeCount = 0;
  let planCount = 0;
  let progressCount = 0;
  const plannedKinds: GreenfieldUtilityKind[] = [];
  const implementation: ScopedGreenfieldUtilityPorts = {
    load: async () => durable ? structuredClone(durable) : null,
    save: async (state) => { durable = structuredClone(state); },
    observe: async (kind, scope) => {
      const hasFacility = !!durable?.utilities[kind].facility;
      const evidence = scopedEvidence(kind, scope, (options.reachableFromStart === true && hasFacility) ||
        (!options.disconnected && progressCount > 0 && hasFacility));
      if (options.serviceIncomplete && hasFacility) {
        evidence.fulfilledConsumption = 0;
        evidence.issueActive = true;
      }
      const disconnectedEvidence = options.disconnected ? {
        ...evidence,
        networkConnected: false,
        targetNetworkReachable: false,
        connector: evidence.connector ? { ...evidence.connector, attached: false, connectedEdges: [] } : null,
      } : evidence;
      return options.unknown
        ? { ...evidence, status: "UNKNOWN" }
        : hasFacility ? disconnectedEvidence : { ...evidence, supplyExists: false, networkConnected: false,
          targetNetworkReachable: false, facility: null, connector: null };
    },
    plan: async (kind) => { planCount += 1; plannedKinds.push(kind); return scopedPlan(kind); },
    execute: async ({ state, plan, selectedPrimitive, onAuthorized }) => {
      executeCount += 1;
      if (options.crashBeforeExecute) throw new Error("SIMULATED_CRASH_BEFORE_EXECUTE");
      if (options.preconditionPreflightRejection && (options.preconditionPreflightRejection === "always" || executeCount === 1)) {
        // A live-binding precondition gate rejects the course without ever
        // reaching native validation, so this is not a verdict on the course.
        const connectionDiagnostics = [{ valid: false, reason: "binding_stale", rejectionKind: "PRECONDITION" as const,
          candidate: "direct-cable" as const, actionCount: 1, actionIndex: 0 }];
        return {
          facilityConstructionAttempted: false, networkSubmissionAttempted: false, failedBeforeNetworkSubmission: true,
          executionSucceeded: false, reason: "DIRECT_CABLE_PREFLIGHT_REJECTED", connectionDiagnostics,
          preflightDiagnostics: [{ candidate: "direct-cable" as const, actionCount: 1, projectedGeometricContactResidual: null,
            preflightResult: { valid: false, reason: "binding_stale" } }],
          state: { ...state, plan, connectionDiagnostics, stage: "PLACED", commandOutcome: "OBSERVED_MISMATCH" },
        };
      }
      if (options.preflightOnlyFailure) {
        return {
          facilityConstructionAttempted: false,
          networkSubmissionAttempted: false,
          failedBeforeNetworkSubmission: true,
          executionSucceeded: false,
          reason: "NO_VALID_UTILITY_CONNECTION_PRIMITIVE",
          state: { ...state, plan, stage: "BLOCKED", commandOutcome: "OBSERVED_MISMATCH" },
        };
      }
      const existingFacility = !!state.facility;
      const commandId = `${state.kind}:network:1`;
      const candidate = buildUtilityConnectionCandidates(plan, scopedEvidence(state.kind, scopedScope(), false).connector!)
        .find((entry) => entry.primitive === selectedPrimitive);
      await onAuthorized?.({ commandId, actionFingerprint: options.fingerprintMismatch ? "[]" : JSON.stringify(candidate?.actions ?? []) });
      if (options.crashAfterAuthorized) throw new Error("SIMULATED_CRASH_AFTER_AUTHORIZED");
      return {
        facilityConstructionAttempted: !existingFacility,
        networkSubmissionAttempted: true,
        failedBeforeNetworkSubmission: false,
        executionSucceeded: true,
        reason: "resolved",
        networkCommandIds: [commandId],
        selectedConnectionPrimitive: "direct-cable" as const,
        preflightDiagnostics: [{ candidate: "direct-cable" as const, actionCount: 1,
          projectedGeometricContactResidual: 0.12,
          native: { diagnostics: { targetBinding: { xzResidual: 0.12 } } } }],
        nativeTelemetry: {
          nativeCompletionEvidence: {
            endpointContract: { postApply: {
              applyOrdering: { beforeApply: true, afterApply: true, observerPhase: "ApplyTool" },
              physicalRelations: { connectedNodeObserved: true, connectedEdgeObserved: true },
              electricityGraph: { targetFlowNode: { index: 210, version: 1 }, targetNetworkReachable: false,
                targetNetworkReachableFailureReason: "NO_GRAPH_PATH" },
            } },
            courseSplitDiagnostics: {
              findNodeConnectionsDiagnostics: { acquisition: { targetRoadFirstExclusionStage: "UPDATED_NODE_SOURCE_QUERY", candidateEnumerationCount: 0,
                rawHitIdentities: [{ index: 400, version: 1 }] } },
              generateEdgesCaptureRuntime: { captureAttempted: true, captureSucceeded: true, earlyReturnReason: "CAPTURED" },
            },
          },
          nativeCompletionTelemetryTrace: { durableTelemetryPresent: true },
          topologyEvidence: { targetNetworkReachable: false, targetNetworkReachableFailureReason: "NO_GRAPH_PATH" },
        },
        state: { ...state, plan, facility: scopedEvidence(state.kind, scopedScope(), false).facility,
          connector: scopedEvidence(state.kind, scopedScope(), false).connector,
          networkCommandIds: [commandId], stage: "CONNECTED",
          commandOutcome: options.uncertain ? "UNKNOWN" : "OBSERVED_MATCH" },
      };
    },
    inspectNetworkCommands: async ({ state }) => ({
      commandIds: options.uncertainExistingNetwork ? ["existing-network-command"] : state.networkCommandIds,
      uncertain: options.uncertainExistingNetwork === true || state.commandOutcome === "UNKNOWN" ||
        state.commandOutcome === "SUBMITTED",
      authoritativeEffect: options.historicalRoadMatch === true,
    }),
    progress: async ({ prior }) => {
      progressCount += 1;
      return prior
        ? { status: "TARGET_REACHED", ...prior, currentFrame: prior.targetFrame, paused: true, reason: "reached" }
        : { status: "WAITING_FOR_SERVICE_UPDATE", startFrame: 10, targetFrame: 20, currentFrame: 10, paused: false, reason: "submitted" };
    },
  };
  return { implementation, get state() { return durable; }, get executeCount() { return executeCount; },
    get planCount() { return planCount; }, get progressCount() { return progressCount; },
    get plannedKinds() { return plannedKinds; },
    setState(value: DurableGreenfieldUtilityState) { durable = structuredClone(value); },
    setCrashAfterAuthorized(value: boolean) { options.crashAfterAuthorized = value; },
  };
}

function exhaustedConnectionOnlyState(): DurableGreenfieldUtilityState {
  const state = createDurableGreenfieldUtilityState(scopedScope());
  const electricity = state.utilities.electricity;
  const evidence = scopedEvidence("electricity", scopedScope(), false);
  electricity.stage = "WAITING_FOR_SERVICE_UPDATE";
  electricity.constructionAttempts = 2;
  electricity.plan = scopedPlan("electricity");
  electricity.planBinding = { projectId: state.scope.projectId, worldEpochId: state.scope.worldEpochId,
    topologyRevision: state.scope.topologyRevision };
  electricity.facility = evidence.facility;
  electricity.connector = evidence.connector ? { ...evidence.connector, attached: false, connectedEdges: [] } : null;
  electricity.commandOutcome = "OBSERVED_MISMATCH";
  electricity.lastFailureBoundary = "PRE_NATIVE_NETWORK_SUBMISSION";
  electricity.networkCommandIds = [];
  return state;
}

describe("scoped durable greenfield utility execution contract", () => {
  const cableAction = { type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 30, z2: 0 };
  const cableEdge = (index: number, start: number, end: number, startNode: number, endNode: number, prefab = cableAction.prefab) => ({
    entity: { index, version: 1 }, prefab, permanent: true, temp: false, deleted: false,
    start: { x: start, z: 0 }, end: { x: end, z: 0 }, startNode: { index: startNode, version: 1 }, endNode: { index: endNode, version: 1 },
  });
  const topologyFor = (edges: Record<string, unknown>[], physicalEdges = edges.slice(0, 1).map((edge) => ({ ...edge, incidentNode: { index: 200, version: 1 } }))) => ({
    binding: { bindingStatus: "VALID", complete: true, truncated: false, worldId: "world", generation: "generation", frameIndex: 7, topologyRevision: "generation:10:1" },
    connector: { entity: { index: 200, version: 1 }, orphan: true, attached: true, networkConnected: true, physicalEdges },
    targetNetwork: { complete: true, truncated: false, networkConnected: true, targetNetworkReachable: false },
    candidateScan: { complete: true, truncated: false, edges },
  });

  test("Stage A placement remains waiting with an open service objective", async () => {
    const scope: GreenfieldUtilityExecutionScope = { ...scopedScope(), facilityPlacementOnly: true,
      commissionedKinds: ["water"], certifiedRoadRefs: [] };
    const fixture = scopedPorts();
    const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports: {
      ...fixture.implementation,
      execute: async (input) => {
        const executed = await fixture.implementation.execute(input);
        return { ...executed, facilityCommandId: "stage-a:placement" };
      },
    } });
    expect(result).toMatchObject({ serviceCertified: false, waiting: true, reason: "FACILITY_PLACED_STAGE_B_READBACK_REQUIRED" });
    expect(result.state.utilities.water.stage).toBe("PLACED");
    expect(result.state.utilities.water.facilityCommandId).toBe("stage-a:placement");
    expect(fixture.executeCount).toBe(1);
    expect(fixture.progressCount).toBe(0);
  });

  test("a placed facility awaiting product decision cannot start a second placement", async () => {
    const scope = { ...scopedScope(), facilityPlacementOnly: true, certifiedRoadRefs: [],
      targetServiceEntry: { road: { index: 0, version: 0 }, position: { x: 0, z: 0 } }, commissionedKinds: ["water"] as GreenfieldUtilityKind[] };
    const state = createDurableGreenfieldUtilityState(scope);
    state.utilities.water.stage = "PLACED";
    state.utilities.water.facility = { entity: { index: 400, version: 1 }, prefab: "water-facility", position: { x: 0, z: 0 } };
    state.utilities.water.facilityCommandId = "placement:terminal";
    const awaiting = markFacilityAwaitingProductDecision({ state, kind: "water", reason: "STAGE_B_UNSUPPORTED" });
    let placements = 0;
    const fixture = scopedPorts();
    fixture.setState(awaiting);
    const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports: {
      ...fixture.implementation,
      execute: async (...args) => { placements += 1; return fixture.implementation.execute(...args); },
    } });
    expect(result).toMatchObject({ waiting: true, reason: "PLACED_FACILITY_AWAITS_PRODUCT_DECISION" });
    expect(result.state.utilities.water.facility).toEqual(state.utilities.water.facility);
    expect(result.state.utilities.water.stage).toBe("PLACED_AWAITING_PRODUCT_DECISION");
    expect(placements).toBe(0);
  });

  test("normalizes the real Bridge facility envelope before matching", () => {
    const edge = cableEdge(30, 0, 30, 200, 210);
    const outer = { facility: { entity: { index: 500, version: 1 } }, topology: topologyFor([edge]) };
    expect(normalizeUtilityTopologyPayload(outer)).toMatchObject({ binding: { bindingStatus: "VALID" } });
    expect(matchUtilityCableTopology({ topology: outer, action: cableAction, target: { index: 210, version: 1 } })).toMatchObject({ result: "MATCH" });
  });

  test("matches run5's one-command three-segment permanent cable chain", () => {
    const edges = [cableEdge(30, 0, 10, 300, 301), cableEdge(31, 10, 20, 301, 302), cableEdge(32, 20, 30, 302, 303)];
    const result = matchCablePrimitiveEffect({ topology: topologyFor(edges, [{ ...edges[0], incidentNode: { index: 200, version: 1 } }]), action: cableAction, connector: { index: 200, version: 1 } });
    expect(result).toMatchObject({ decision: "OBSERVED_MATCH" });
    expect(result.evidence.matchedEdgeIds).toEqual(["30:1", "31:1", "32:1"]);
    expect(result.evidence.matchedNodeIds).toEqual(["300:1", "301:1", "302:1", "303:1"]);
  });

  test("matches a typed END chain by authoritative node identity when its Transform differs from the approved contact", () => {
    const edges = [
      cableEdge(30, 0, 10, 300, 301),
      { ...cableEdge(31, 10, 30, 301, 324244), end: { x: 30.08, z: -11.65 } },
    ];
    const result = matchCablePrimitiveEffect({
      topology: topologyFor(edges, [{ ...edges[0], incidentNode: { index: 200, version: 1 } }]),
      action: cableAction,
      connector: { index: 200, version: 1 },
      targetNode: { index: 324244, version: 1 },
    });
    expect(result).toMatchObject({ decision: "OBSERVED_MATCH" });
    expect(result.evidence.matchedEdgeIds).toEqual(["30:1", "31:1"]);
    expect(result.evidence.matchedNodeIds).toEqual(["300:1", "301:1", "324244:1"]);
  });

  test("fails closed when a typed END chain terminates at a different node", () => {
    const edges = [cableEdge(30, 0, 10, 300, 301), cableEdge(31, 10, 30, 301, 303)];
    expect(matchCablePrimitiveEffect({
      topology: topologyFor(edges, [{ ...edges[0], incidentNode: { index: 200, version: 1 } }]),
      action: cableAction,
      connector: { index: 200, version: 1 },
      targetNode: { index: 324244, version: 1 },
    }).decision).toBe("PROVEN_MISMATCH");
  });

  test.each([
    ["chain gap", [cableEdge(30, 0, 10, 300, 301), cableEdge(31, 12, 30, 301, 303)], "PROVEN_MISMATCH"],
    ["mixed prefab", [cableEdge(30, 0, 10, 300, 301), cableEdge(31, 10, 30, 301, 303, "Small Road")], "PROVEN_MISMATCH"],
  ])("fails closed for %s", (_label, edges, expected) => {
    expect(matchCablePrimitiveEffect({ topology: topologyFor(edges as Record<string, unknown>[]), action: cableAction, connector: { index: 200, version: 1 } }).decision).toBe(expected);
  });

  test("matches the unique exact physical chain despite an unrelated cable branch", () => {
    const edges = [cableEdge(30, 0, 10, 300, 301), cableEdge(31, 10, 30, 301, 303), cableEdge(32, 10, 15, 301, 304)];
    const result = matchCablePrimitiveEffect({ topology: topologyFor(edges), action: cableAction, connector: { index: 200, version: 1 } });
    expect(result.decision).toBe("OBSERVED_MATCH");
    expect(result.evidence.matchedEdgeIds).toEqual(["30:1", "31:1"]);
  });

  test("keeps UNKNOWN when multiple distinct permanent chains reach the command endpoint", () => {
    const edges = [
      cableEdge(30, 0, 10, 300, 301), cableEdge(31, 10, 30, 301, 303),
      cableEdge(32, 10, 15, 301, 304), cableEdge(33, 15, 30, 304, 305),
    ];
    expect(matchCablePrimitiveEffect({ topology: topologyFor(edges), action: cableAction, connector: { index: 200, version: 1 } }).decision).toBe("UNKNOWN");
  });

  test.each([
    ["exact topology", "MATCH"],
    ["empty complete scan", "MISMATCH"],
    ["truncated scan", "INCONCLUSIVE"],
    ["ambiguous residual", "INCONCLUSIVE"],
  ])("cable topology matcher classifies %s fail-closed", (_label, expected) => {
    const action = { type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 };
    const edge = { entity: { index: 30, version: 1 }, prefab: action.prefab, permanent: true,
      start: { x: 0, z: 0 }, end: { x: 20, z: 0 }, startNode: { index: 200, version: 1 }, endNode: { index: 10, version: 2 } };
    const base = { binding: { bindingStatus: "VALID", complete: true, truncated: false },
      connector: { entity: { index: 200, version: 1 }, physicalEdges: [{ ...edge, incidentNode: { index: 200, version: 1 } }] },
      targetNetwork: { target: { startNode: { index: 10, version: 2 }, endNode: { index: 11, version: 2 } } },
      candidateScan: { complete: true, truncated: false, edges: [edge], matchingEdges: [edge] } };
    const topology = _label === "exact topology" ? base : _label === "empty complete scan"
      ? { ...base, candidateScan: { complete: true, truncated: false, edges: [], matchingEdges: [] } }
      : _label === "truncated scan" ? { ...base, binding: { ...base.binding, truncated: true }, candidateScan: { ...base.candidateScan, truncated: true } }
        : { ...base, candidateScan: { ...base.candidateScan, matchingEdges: [edge, { ...edge, entity: { index: 31, version: 1 } }] } };
    expect(matchUtilityCableTopology({ topology, action, target: { index: 10, version: 2 } }).result).toBe(expected);
  });

  test("reads authoritative native network quotes from the nested finance receipt", () => {
    expect(readNativeUtilityQuote({ valid: true, finance: { signedAmount: 88 } }, Number.NaN)).toBe(88);
  });

  test("splits primitive cable effect from a disconnected objective", () => {
    const action = { type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 };
    const edge = { entity: { index: 30, version: 1 }, prefab: action.prefab, permanent: true, temp: false, deleted: false,
      start: { x: 0, z: 0 }, end: { x: 20, z: 0 }, incidentNode: { index: 200, version: 1 } };
    const topology = { binding: { bindingStatus: "VALID", complete: true, truncated: false },
      connector: { entity: { index: 200, version: 1 }, orphan: true, attached: true,
        physicalEdges: [{ ...edge, incidentNode: { index: 200, version: 1 } }] },
      targetNetwork: { complete: true, truncated: false, networkConnected: false, targetNetworkReachable: false },
      candidateScan: { complete: true, truncated: false, edges: [edge] } };
    expect(matchCablePrimitiveEffect({ topology, action, connector: { index: 200, version: 1 } }).decision).toBe("OBSERVED_MATCH");
    // This connector carries no networkConnected read, and orphan no longer implies
    // disconnection (a building's connector node is normally orphaned in the engine's
    // own building graph), so connectivity stays UNKNOWN. The unreachable target is
    // what makes the objective INCOMPLETE.
    expect(matchConnectionObjective({ topology })).toMatchObject({ status: "INCOMPLETE", networkConnected: "UNKNOWN", targetNetworkReachable: false });
  });

  test("keeps a physical primitive match separate from an unreachable target objective", () => {
    const edge = cableEdge(30, 0, 30, 200, 210);
    const topology = topologyFor([edge], [{ ...edge, incidentNode: { index: 200, version: 1 } }]);
    expect(matchCablePrimitiveEffect({ topology, action: cableAction, connector: { index: 200, version: 1 } }).decision).toBe("OBSERVED_MATCH");
    expect(matchConnectionObjective({ topology })).toMatchObject({ status: "INCOMPLETE", networkConnected: true, targetNetworkReachable: false });
  });

  test("does not compare cable identity to Small Road identity and preserves reachability semantics", () => {
    const action = { type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 };
    const edge = { entity: { index: 30, version: 1 }, prefab: action.prefab, permanent: true, start: { x: 0, z: 0 }, end: { x: 20, z: 0 }, incidentNode: { index: 200, version: 1 } };
    const topology = { binding: { bindingStatus: "VALID", complete: true, truncated: false }, connector: { entity: { index: 200, version: 1 }, orphan: false, attached: true, networkConnected: true, physicalEdges: [edge] },
      targetNetwork: { complete: true, truncated: false, networkConnected: true, targetNetworkReachable: true }, candidateScan: { complete: true, truncated: false, edges: [edge] } };
    expect(matchCablePrimitiveEffect({ topology, action, connector: { index: 200, version: 1 } }).decision).toBe("OBSERVED_MATCH");
    expect(matchConnectionObjective({ topology })).toMatchObject({ status: "COMPLETE", networkConnected: true, targetNetworkReachable: true });
  });

  test.each([
    ["incomplete", { binding: { bindingStatus: "VALID", complete: false, truncated: false } }],
    ["unknown binding", { binding: { bindingStatus: "UNKNOWN", complete: false, truncated: false } }],
  ])("preserves UNKNOWN for %s topology", (_label, topology) => {
    const action = { type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 };
    expect(matchCablePrimitiveEffect({ topology: { ...topology, connector: { entity: { index: 1, version: 1 } }, candidateScan: { complete: false, truncated: false } }, action, connector: { index: 1, version: 1 } }).decision).toBe("UNKNOWN");
    expect(matchConnectionObjective({ topology })).toMatchObject({ status: "UNKNOWN", targetNetworkReachable: "UNKNOWN" });
  });

  test("complete geometry mismatch is PROVEN_MISMATCH and multiple exact edges are UNKNOWN", () => {
    const action = { type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 };
    const edge = { entity: { index: 30, version: 1 }, prefab: action.prefab, permanent: true, start: { x: 40, z: 0 }, end: { x: 60, z: 0 }, incidentNode: { index: 200, version: 1 } };
    const base = { binding: { bindingStatus: "VALID", complete: true, truncated: false }, connector: { entity: { index: 200, version: 1 }, physicalEdges: [edge] }, candidateScan: { complete: true, truncated: false, edges: [edge] } };
    expect(matchCablePrimitiveEffect({ topology: base, action, connector: { index: 200, version: 1 } }).decision).toBe("PROVEN_MISMATCH");
    const exact = { ...edge, start: { x: 0, z: 0 }, end: { x: 20, z: 0 } };
    expect(matchCablePrimitiveEffect({ topology: { ...base, connector: { ...base.connector, physicalEdges: [exact, { ...exact, entity: { index: 31, version: 1 } }] }, candidateScan: { complete: true, truncated: false, edges: [exact, { ...exact, entity: { index: 31, version: 1 } }] } }, action, connector: { index: 200, version: 1 } }).decision).toBe("UNKNOWN");
  });
  test("binds plans to current Project/Tranche/road/epoch/topology and rejects stale topology", async () => {
    const scope = scopedScope();
    const fixture = scopedPorts({ disconnected: true });
    await runScopedGreenfieldUtilityBootstrap({ scope, ports: fixture.implementation });
    expect(fixture.state?.scope).toMatchObject({ projectId: scope.projectId, trancheId: scope.trancheId, worldEpochId: scope.worldEpochId });
    expect(fixture.state?.utilities.electricity.planBinding).toEqual({ projectId: scope.projectId, worldEpochId: scope.worldEpochId, topologyRevision: scope.topologyRevision });
    const stale = structuredClone(fixture.state!);
    stale.utilities.electricity.progression = null;
    stale.utilities.electricity.planBinding!.topologyRevision = "old-topology";
    fixture.setState(stale);
    await expect(runScopedGreenfieldUtilityBootstrap({ scope, ports: fixture.implementation })).rejects.toThrow("STALE_UTILITY_TOPOLOGY_PLAN");
  });

  test("persists full runtime telemetry and projected contact residual in durable evidence", async () => {
    const fixture = scopedPorts();
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    const electricity = result.state.utilities.electricity;
    expect(electricity.preflightDiagnostics?.[0].projectedGeometricContactResidual).toBe(0.12);
    expect(electricity.nativeTelemetry?.nativeCompletionEvidence).toMatchObject({
      endpointContract: { postApply: { applyOrdering: { beforeApply: true, afterApply: true },
        physicalRelations: { connectedNodeObserved: true, connectedEdgeObserved: true },
        electricityGraph: { targetNetworkReachable: false } } },
      courseSplitDiagnostics: { findNodeConnectionsDiagnostics: { acquisition: { targetRoadFirstExclusionStage: "UPDATED_NODE_SOURCE_QUERY" } },
        generateEdgesCaptureRuntime: { earlyReturnReason: "CAPTURED" } },
    });
    expect(electricity.nativeTelemetry?.topologyEvidence).toMatchObject({ targetNetworkReachableFailureReason: "NO_GRAPH_PATH" });
  });

  test("preserves the full Bridge completion envelope at the utility adapter boundary", () => {
    const value = nativeCompletionTelemetryForUtilityBatch({ results: [{ type: "build_road", nativeCompletion: {
      commandId: "bridge-1",
      endpointContract: { postApply: { applyOrdering: { beforeApply: true, afterApply: true },
        physicalRelations: { connectedNodeObserved: true, connectedEdgeObserved: true },
        electricityGraph: { targetFlowNode: { index: 1, version: 1 }, targetNetworkReachable: false } } },
      courseSplitDiagnostics: { generateEdgesCaptureRuntime: { captureAttempted: true, captureSucceeded: true },
        findNodeConnectionsDiagnostics: { acquisition: { targetRoadFirstExclusionStage: "UPDATED_NODE_SOURCE_QUERY" } } },
      endRealizationTelemetry: { commandId: "bridge-1", status: "OBSERVED" },
    } }] }, "bridge-1") as Record<string, any>;
    expect(value.endpointContract.postApply.applyOrdering.afterApply).toBe(true);
    expect(value.endpointContract.postApply.physicalRelations.connectedEdgeObserved).toBe(true);
    expect(value.endpointContract.postApply.electricityGraph.targetFlowNode.index).toBe(1);
    expect(value.courseSplitDiagnostics.generateEdgesCaptureRuntime.captureSucceeded).toBe(true);
    expect(value.courseSplitDiagnostics.findNodeConnectionsDiagnostics.acquisition.targetRoadFirstExclusionStage).toBe("UPDATED_NODE_SOURCE_QUERY");
  });

  test("explicit current-epoch rebind may refresh topology when no plan continuation exists", async () => {
    const fixture = scopedPorts({ disconnected: true });
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    const rebound = structuredClone(fixture.state!);
    rebound.scope.topologyRevision = "old-rebound-topology";
    for (const kind of ["electricity", "water", "sewage"] as const) {
      rebound.utilities[kind].plan = null;
      rebound.utilities[kind].planBinding = null;
    }
    fixture.setState(rebound);
    await expect(runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation })).resolves.toBeDefined();
    expect(fixture.state?.scope.topologyRevision).toBe(scopedScope().topologyRevision);
  });

  // The durable scope is a snapshot of the AUTHORIZATION, and an append-only
  // budget amendment can raise that authorization afterwards. A same-generation
  // resume therefore has to read the effective budget, not the snapshot: a
  // stale ceiling under-funds a slice that is, durably, funded.
  describe("a same-generation resume raises a stale spend ceiling to the effective authorization", () => {
    test("a lower recorded ceiling is raised to the live one, and persisted", async () => {
      const fixture = scopedPorts({ disconnected: true });
      const recorded = exhaustedConnectionOnlyState();
      recorded.scope.maximumSpend = 9_000;
      fixture.setState(recorded);

      const scope = { ...scopedScope(), maximumSpend: 12_000 };
      const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports: fixture.implementation });
      expect(result.state.scope.maximumSpend).toBe(12_000);
      expect(fixture.state?.scope.maximumSpend).toBe(12_000);
      // Nothing else about the recorded scope moves.
      expect(result.state.scope).toMatchObject({
        projectId: scope.projectId, trancheId: scope.trancheId, reservationRef: scope.reservationRef,
        worldEpochId: scope.worldEpochId, generation: scope.generation, topologyRevision: scope.topologyRevision,
        spatialEnvelope: scope.spatialEnvelope,
      });
    });

    test("a recorded ceiling at or above the live one is left exactly as it was", async () => {
      const fixture = scopedPorts({ disconnected: true });
      const recorded = exhaustedConnectionOnlyState();
      recorded.scope.maximumSpend = 15_000;
      fixture.setState(recorded);

      const result = await runScopedGreenfieldUtilityBootstrap({
        scope: { ...scopedScope(), maximumSpend: 12_000 }, ports: fixture.implementation,
      });
      expect(result.state.scope.maximumSpend).toBe(15_000);
    });
  });

  test("run-simulation submission is a typed wait and does not certify before targetFrame", async () => {
    const fixture = scopedPorts();
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result).toMatchObject({ serviceCertified: false, waiting: true, reason: "WAITING_FOR_SERVICE_UPDATE" });
    expect(result.state.utilities.electricity).toMatchObject({ stage: "WAITING_FOR_SERVICE_UPDATE", progression: { startFrame: 10, targetFrame: 20 } });
  });

  test("reachable but uncertified service advances simulation before retrying construction", async () => {
    const fixture = scopedPorts({ reachableFromStart: true, serviceIncomplete: true });
    const state = exhaustedConnectionOnlyState();
    const electricity = state.utilities.electricity;
    electricity.stage = "CONNECTED";
    electricity.connector = { ...electricity.connector!, attached: true };
    electricity.serviceEvidence = { ...scopedEvidence("electricity", scopedScope(), true), fulfilledConsumption: 0, issueActive: true };
    fixture.setState(state);

    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result).toMatchObject({ serviceCertified: false, waiting: true, reason: "WAITING_FOR_SERVICE_UPDATE" });
    expect(result.state.utilities.electricity).toMatchObject({
      stage: "WAITING_FOR_SERVICE_UPDATE", progression: { startFrame: 10, targetFrame: 20 },
    });
    expect(fixture.progressCount).toBe(1);
    expect(fixture.executeCount).toBe(0);
  });

  test("targetFrame completion reobserves; city capacity without target reachability cannot certify", async () => {
    const fixture = scopedPorts({ disconnected: true });
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result.serviceCertified).toBe(false);
    expect(result.state.utilities.electricity.serviceEvidence).toMatchObject({ cityCapacityAvailable: true, targetNetworkReachable: false });
    expect(isScopedUtilityServiceCertified(result.state.utilities.electricity.serviceEvidence!, scopedScope())).toBe(false);
  });

  test("authoritative target reachability certifies serial utilities without duplicate construction", async () => {
    const fixture = scopedPorts();
    let result;
    for (let index = 0; index < 4; index += 1) result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result).toMatchObject({ serviceCertified: true, providerInvocations: 0, legacyBrainInvocations: 0 });
    expect(fixture.executeCount).toBe(3);
    expect(fixture.planCount).toBe(3);
  });

  test("UNKNOWN observation waits without consuming a construction attempt", async () => {
    const fixture = scopedPorts({ unknown: true });
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result).toMatchObject({ waiting: true, reason: "UTILITY_OBSERVATION_UNKNOWN" });
    expect(result.state.utilities.electricity.constructionAttempts).toBe(0);
    expect(fixture.executeCount).toBe(0);
  });

  test("uncertain Apply is quarantined and reload does not duplicate the write", async () => {
    const fixture = scopedPorts({ uncertain: true });
    const first = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(first.reason).toBe("UTILITY_RECONCILIATION_REQUIRED");
    const reloaded = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(reloaded.reason).toBe("UTILITY_RECONCILIATION_REQUIRED");
    expect(fixture.executeCount).toBe(1);
    expect(reloaded.state.utilities.electricity.constructionAttempts).toBe(1);
  });

  test("2/2 with an authoritative facility and no network command consumes one connection-only recovery", async () => {
    const fixture = scopedPorts({ disconnected: true });
    fixture.setState(exhaustedConnectionOnlyState());
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result).toMatchObject({ serviceCertified: false, waiting: false,
      providerInvocations: 0, legacyBrainInvocations: 0 });
    expect(result.state.utilities.electricity).toMatchObject({
      constructionAttempts: 2,
      facility: { entity: { index: 101, version: 1 } },
      connectionRecovery: { consumed: true, consumptionCount: 1 },
      selectedConnectionPrimitive: "direct-cable",
    });
    expect(result.state.utilities.electricity.connectionRecovery.journal).toHaveLength(1);
    expect(fixture.executeCount).toBe(1);
  });

  test("connection-only recovery preserves the facility and is consumed once across reload", async () => {
    const fixture = scopedPorts({ disconnected: true });
    fixture.setState(exhaustedConnectionOnlyState());
    const first = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    const facility = first.state.utilities.electricity.facility;
    const reloadedState = structuredClone(first.state);
    reloadedState.utilities.electricity.progression = null;
    fixture.setState(reloadedState);
    const second = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    // The facility is already in the world, so the execution boundary continues
    // connection-only and can offer the direct cable alone. The placement-phase
    // primitive is never selected, so the reload never resubmits the connection
    // and the objective stops honestly instead of asking for work the boundary
    // cannot perform.
    expect(second.reason).toBe("UTILITY_CONNECTION_CANDIDATES_EXHAUSTED");
    expect(second.state.utilities.electricity.facility).toEqual(facility);
    expect(second.state.utilities.electricity.connectionRecovery.journal).toHaveLength(1);
    expect(fixture.executeCount).toBe(1);
  });

  test("authoritative connection rebind replaces only unspent candidates derived from the prior placement plan", async () => {
    const fixture = scopedPorts({ disconnected: true });
    const scope: GreenfieldUtilityExecutionScope = {
      ...scopedScope(),
      targetServiceEntry: { road: { index: 10, version: 2 }, position: { x: 40, z: 0 }, prefab: "Small Road" },
      targetSemantics: electricityTargetSemantics({
        contact: { x: 40, z: 0 },
        targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 40, z: 0 } },
        approvedPlanRevision: "topology:1",
      }),
    };
    const state = exhaustedConnectionOnlyState();
    const electricity = state.utilities.electricity;
    state.scope = structuredClone(scope);
    electricity.plan!.connection!.end = { x: 20, z: 0 };
    electricity.connectionCandidateContextFingerprint = utilityConnectionCandidateContextFingerprint({
      binding: { facility: electricity.facility!, connector: electricity.connector! }, scope,
    });
    const staleCandidates = buildUtilityConnectionCandidates(electricity.plan!, electricity.connector!);
    electricity.candidateLedger = staleCandidates.map((candidate, ordinal) => ({
      candidateId: `stale:${candidate.primitive}`, objectiveId: "stale-objective", kind: candidate.primitive,
      ordinal, exactActions: structuredClone(candidate.actions), actionFingerprint: JSON.stringify(candidate.actions),
      approvedPlanRevision: "topology:1", spatialScope: structuredClone(state.scope.spatialEnvelope),
      budgetCeiling: state.scope.maximumSpend, ledgerState: "NOT_ATTEMPTED", commandId: null,
      primitiveEffect: "NOT_OBSERVED",
    }));
    fixture.setState(state);
    let currentPlanCalls = 0;
    const currentPlan = scopedPlan("electricity");
    currentPlan.connection.end = { x: 40, z: 0 };
    currentPlan.serviceRoads = [{ id: "current-service-road", role: "side", start: { x: 40, z: 0 }, end: { x: 36, z: 0 } }];
    const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports: {
      ...fixture.implementation,
      planCurrentConnection: async () => { currentPlanCalls += 1; return currentPlan; },
    } });
    const ledger = result.state.utilities.electricity.candidateLedger;
    const directCable = ledger.find((candidate) => candidate.kind === "direct-cable" && candidate.ledgerState === "OBSERVED_MATCH");
    expect(directCable?.exactActions[0]).toMatchObject({ type: "build_road", x2: 40, z2: 0 });
    expect(ledger.some((candidate) => candidate.candidateId === "stale:direct-cable")).toBe(false);
    expect(currentPlanCalls).toBe(1);
    expect(result.state.utilities.electricity.connectionCandidateContextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.state.utilities.electricity.connectionReplan.journal.at(-1)).toMatchObject({
      event: "CONNECTION_CONTEXT_REBOUND",
      reason: "AUTHORITATIVE_FACILITY_CONNECTOR_OR_TARGET_TOPOLOGY_CHANGED",
    });
    expect(fixture.executeCount).toBe(1);
  });

  test("unreachable electricity refreshes an unchanged target plan to a typed network extension", async () => {
    const scope: GreenfieldUtilityExecutionScope = {
      ...scopedScope(),
      targetSemantics: electricityTargetSemantics({
        contact: { x: 20, z: 0 },
        targetRoad: { prefab: "Small Road", endpointRole: "start", anchor: { x: 20, z: 0 } },
        approvedPlanRevision: "topology:1",
      }),
    };
    const fixture = scopedPorts({ disconnected: true });
    const state = exhaustedConnectionOnlyState();
    state.scope = structuredClone(scope);
    const electricity = state.utilities.electricity;
    electricity.serviceEvidence = scopedEvidence("electricity", scope, false);
    electricity.plan = scopedPlan("electricity");
    electricity.connectionCandidateContextFingerprint = utilityConnectionCandidateContextFingerprint({
      binding: { facility: electricity.facility!, connector: electricity.connector! }, scope,
    });
    fixture.setState(state);
    let refreshes = 0;
    const refreshedPlan = scopedPlan("electricity");
    refreshedPlan.connectionEndpointBindings = {
      start: { mode: "EXISTING_NET_NODE", role: "START", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
        expectedPosition: { x: 10, y: 0, z: 0 }, bindingRule: "CURRENT_REACHABLE_CABLE_TERMINAL", topologyRole: "CONNECTED_UTILITY_CABLE_TERMINAL",
        topologyLookup: { networkEdgePrefab: "Low-voltage Ground Cable", edgeGeometry: { x1: 0, z1: 0, x2: 10, z2: 0 },
          edgeEndpointRole: "END", sourceAnchor: { buildingPrefab: "electricity-starter", position: { x: 0, y: 0, z: 0 }, connectorUtility: "ELECTRICITY" },
          requireSourceReachability: true } },
      end: { mode: "EXISTING_NET_NODE", role: "END", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
        expectedPosition: { x: 20, y: 0, z: 0 }, bindingRule: "CERTIFIED_TARGET_ROAD_ELECTRICITY_NODE", topologyRole: "LOCAL_ROAD_ELECTRICITY_NODE",
        topologyLookup: { networkEdgePrefab: "Small Road", edgeGeometry: { x1: 20, z1: 0, x2: 30, z2: 0 },
          edgeEndpointRole: "START", sourceAnchor: { buildingPrefab: "electricity-starter", position: { x: 0, y: 0, z: 0 }, connectorUtility: "ELECTRICITY" },
          requireSourceReachability: false } },
    };
    refreshedPlan.connection = { prefab: "Low-voltage Ground Cable", start: { x: 10, z: 0 }, end: { x: 20, z: 0 } };
    const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports: {
      ...fixture.implementation,
      planCurrentConnection: async () => { refreshes += 1; return refreshedPlan; },
    } });
    expect(refreshes).toBe(1);
    expect(result.state.utilities.electricity.candidateLedger.find((candidate) => candidate.kind === "direct-cable")?.exactActions[0])
      .toMatchObject({ x1: 10, x2: 20, utilityEndpoints: { start: { bindingRule: "CURRENT_REACHABLE_CABLE_TERMINAL" } } });
  });

  test("an uncertain network command forbids fallback pending reconciliation", async () => {
    const fixture = scopedPorts({ disconnected: true, uncertainExistingNetwork: true });
    fixture.setState(exhaustedConnectionOnlyState());
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result).toMatchObject({ waiting: true, reason: "UTILITY_RECONCILIATION_REQUIRED" });
    expect(result.state.utilities.electricity.connectionRecovery.consumed).toBe(false);
    expect(fixture.executeCount).toBe(0);
  });

  test("preflight-only rejection does not consume a facility construction attempt or reset facility state", async () => {
    const fixture = scopedPorts({ preflightOnlyFailure: true });
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result.state.utilities.electricity.constructionAttempts).toBe(0);
    expect(result.state.utilities.electricity.facility).toBeNull();
    expect(result.state.utilities.electricity.lastFailureBoundary).toBe("PRE_NATIVE_NETWORK_SUBMISSION");
  });

  test("successful cable submission is journaled in durable utility state exactly once", async () => {
    const fixture = scopedPorts({ disconnected: true });
    fixture.setState(exhaustedConnectionOnlyState());
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result.state.utilities.electricity.networkCommandIds).toEqual(["electricity:network:1"]);
    expect(new Set(result.state.utilities.electricity.networkCommandIds).size).toBe(1);
  });

  test.each([
    { name: "reload", epoch: "epoch:1", generation: "generation:1" },
    { name: "epoch rebind", epoch: "epoch:2", generation: "generation:2" },
  ])("$name preserves consumed observation budget", async ({ epoch, generation }) => {
    const fixture = scopedPorts({ disconnected: true });
    const initial = exhaustedConnectionOnlyState();
    initial.utilities.electricity.observationWaits = 2;
    fixture.setState(initial);
    const scope = { ...scopedScope(), worldEpochId: epoch, generation };
    const result = await runScopedGreenfieldUtilityBootstrap({ scope, ports: fixture.implementation });
    expect(result.state.utilities.electricity.observationWaits).toBeGreaterThanOrEqual(2);
  });

  test("persists exact command binding and AUTHORIZED before execute can cross native boundary", async () => {
    const fixture = scopedPorts({ disconnected: true });
    fixture.setState(exhaustedConnectionOnlyState());
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    const candidate = result.state.utilities.electricity.candidateLedger.find((entry) => entry.commandId === "electricity:network:1");
    expect(candidate).toMatchObject({ commandId: "electricity:network:1", ledgerState: "OBSERVED_MATCH" });
    expect(candidate?.actionFingerprint).toBe(JSON.stringify(candidate?.exactActions));
  });

  test("fingerprint mismatch fails closed before native submission", async () => {
    const fixture = scopedPorts({ disconnected: true, fingerprintMismatch: true });
    fixture.setState(exhaustedConnectionOnlyState());
    await expect(runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation })).rejects.toThrow("UTILITY_AUTHORIZED_CANDIDATE_FINGERPRINT_MISMATCH");
    expect(fixture.state?.utilities.electricity.candidateLedger.some((entry) => entry.ledgerState === "AUTHORIZED")).toBe(false);
  });

  test("crash after AUTHORIZED persist reloads without inventing a duplicate submission", async () => {
    const fixture = scopedPorts({ disconnected: true, crashAfterAuthorized: true });
    fixture.setState(exhaustedConnectionOnlyState());
    await expect(runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation })).rejects.toThrow("SIMULATED_CRASH_AFTER_AUTHORIZED");
    const authorized = fixture.state!.utilities.electricity.candidateLedger.find((entry) => entry.commandId === "electricity:network:1");
    expect(authorized).toMatchObject({ commandId: "electricity:network:1", ledgerState: "AUTHORIZED" });
    fixture.setCrashAfterAuthorized(false);
    const reloaded = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(reloaded.reason).toBe("UTILITY_RECONCILIATION_REQUIRED");
    expect(fixture.executeCount).toBe(1);
  });

  test("historical run8 durable state migrates road effect while leaving cable NOT_ATTEMPTED", async () => {
    const fixture = scopedPorts({ historicalRoadMatch: true, crashBeforeExecute: true });
    const state = exhaustedConnectionOnlyState();
    const electricity = state.utilities.electricity;
    electricity.commandOutcome = "OBSERVED_MATCH";
    electricity.networkCommandIds = ["ad5c081f-d20e-4c43-956b-57a215b89a83"];
    electricity.authorizedSpend = 8668;
    electricity.connectionRecovery = { ...electricity.connectionRecovery, consumed: true, consumptionCount: 1 };
    electricity.candidateLedger = [];
    fixture.setState(state);
    await expect(runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation })).rejects.toThrow("SIMULATED_CRASH_BEFORE_EXECUTE");
    const migrated = fixture.state!.utilities.electricity;
    expect(migrated.candidateLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "service-road", ledgerState: "OBSERVED_MATCH", commandId: "ad5c081f-d20e-4c43-956b-57a215b89a83" }),
      expect.objectContaining({ kind: "direct-cable", ledgerState: "NOT_ATTEMPTED", commandId: null }),
    ]));
    expect(migrated.constructionAttempts).toBe(2);
    expect(migrated.connectionRecovery.consumptionCount).toBe(1);
    expect(migrated.authorizedSpend).toBe(8668);
  });

  test.each(["SUBMITTED", "UNKNOWN", "RECONCILING"] as const)("%s candidate forbids a new native write", async (ledgerState) => {
    const fixture = scopedPorts({ disconnected: true });
    const state = exhaustedConnectionOnlyState();
    state.utilities.electricity.plan = scopedPlan("electricity");
    state.utilities.electricity.candidateLedger = [{
      candidateId: "candidate:road", objectiveId: "objective:1", kind: "service-road", ordinal: 0,
      exactActions: state.utilities.electricity.plan.serviceRoads!.map((road) => ({ type: "build_road" as const, prefab: "Small Road", x1: road.start.x, z1: road.start.z, x2: road.end.x, z2: road.end.z })),
      approvedPlanRevision: "topology:1", spatialScope: scopedScope().spatialEnvelope, budgetCeiling: 10_000,
      ledgerState, commandId: "candidate:command", primitiveEffect: ledgerState === "UNKNOWN" ? "UNKNOWN" : "NOT_OBSERVED",
    }, {
      candidateId: "candidate:cable", objectiveId: "objective:1", kind: "direct-cable", ordinal: 1,
      exactActions: [], approvedPlanRevision: "topology:1", spatialScope: scopedScope().spatialEnvelope, budgetCeiling: 10_000,
      ledgerState: "NOT_ATTEMPTED", commandId: null, primitiveEffect: "NOT_OBSERVED",
    }];
    fixture.setState(state);
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result.reason).toBe("UTILITY_RECONCILIATION_REQUIRED");
    expect(fixture.executeCount).toBe(0);
  });

  const connectionOnlyStateWithRejectedCable = (overrides: Partial<
    DurableGreenfieldUtilityState["utilities"]["electricity"]["candidateLedger"][number]> = {}) => {
    const state = exhaustedConnectionOnlyState();
    const electricity = state.utilities.electricity;
    electricity.plan = scopedPlan("electricity");
    const actions = [{ type: "build_road" as const, prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 }];
    electricity.candidateLedger = [{
      candidateId: "candidate:cable", objectiveId: "objective:1", kind: "direct-cable", ordinal: 1,
      exactActions: actions, actionFingerprint: JSON.stringify(actions), approvedPlanRevision: "topology:1",
      spatialScope: scopedScope().spatialEnvelope, budgetCeiling: 10_000,
      ledgerState: "PREFLIGHT_REJECTED", commandId: null, primitiveEffect: "NOT_OBSERVED", ...overrides,
    }];
    return state;
  };

  test("re-validates a preflight rejection that carries no native verdict", async () => {
    const fixture = scopedPorts({ disconnected: true, preconditionPreflightRejection: "always" });
    fixture.setState(connectionOnlyStateWithRejectedCable());
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(fixture.executeCount).toBe(1);
    expect(result.reason).toBe("DIRECT_CABLE_PREFLIGHT_REJECTED");
    const electricity = result.state.utilities.electricity;
    expect(electricity.candidateLedger).toEqual([
      expect.objectContaining({ kind: "direct-cable", ledgerState: "NOT_ATTEMPTED", commandId: null }),
    ]);
    // The rejection stays observable even though it never became a verdict.
    expect(electricity.connectionDiagnostics).toEqual([
      expect.objectContaining({ reason: "binding_stale", rejectionKind: "PRECONDITION" }),
    ]);
    expect(electricity.lastRecoveryReason).toBe("DIRECT_CABLE_PREFLIGHT_REJECTED");
  });

  test("keeps a native preflight verdict spent across resumes", async () => {
    const fixture = scopedPorts({ disconnected: true, preconditionPreflightRejection: "always" });
    fixture.setState(connectionOnlyStateWithRejectedCable({ preflightVerdict: "NATIVE_REJECTED" }));
    const result = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(result.reason).toBe("UTILITY_CONNECTION_CANDIDATES_EXHAUSTED");
    expect(fixture.executeCount).toBe(0);
  });

  test("a precondition rejection re-enters once and never places the facility twice", async () => {
    const fixture = scopedPorts({ disconnected: true, preconditionPreflightRejection: "once" });
    fixture.setState(connectionOnlyStateWithRejectedCable());
    const first = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(first.reason).toBe("DIRECT_CABLE_PREFLIGHT_REJECTED");
    expect(fixture.executeCount).toBe(1);
    const reloaded = structuredClone(first.state);
    reloaded.utilities.electricity.progression = null;
    fixture.setState(reloaded);
    const second = await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    expect(fixture.executeCount).toBe(2);
    expect(second.reason).toBe("UTILITY_CONNECTION_OBJECTIVE_INCOMPLETE");
    const electricity = second.state.utilities.electricity;
    expect(electricity.candidateLedger).toEqual([
      expect.objectContaining({ ledgerState: "OBSERVED_MATCH", commandId: "electricity:network:1" }),
    ]);
    // The existing facility is rebound, never re-placed.
    expect(electricity.facility).toMatchObject({ entity: { index: 101, version: 1 } });
    expect(electricity.constructionAttempts).toBe(2);
  });
});

describe("scoped commissioning mandate", () => {
  test("commissions every family when the scope declares no mandate", async () => {
    const fixture = scopedPorts();
    await runScopedGreenfieldUtilityBootstrap({ scope: scopedScope(), ports: fixture.implementation });
    // The bootstrap returns at the first family that is not certified, so the
    // un-narrowed scope's first act is still electricity. That ordering is the
    // existing product behavior this field must not disturb.
    expect(fixture.plannedKinds).toEqual(["electricity"]);
  });

  test("commissions only the families the scope declares", async () => {
    const fixture = scopedPorts();
    const result = await runScopedGreenfieldUtilityBootstrap({
      scope: { ...scopedScope(), commissionedKinds: ["water"] },
      ports: fixture.implementation,
    });
    expect(fixture.plannedKinds).toEqual(["water"]);
    expect(result.state.utilities.water.plan?.prefab).toBe("water-starter");
    // The families outside the mandate were never planned, so nothing in their
    // durable state can have moved.
    expect(result.state.utilities.electricity.plan).toBeNull();
    expect(result.state.utilities.sewage.plan).toBeNull();
    expect(result.state.utilities.electricity.stage).toBe("MISSING");
    expect(result.state.utilities.sewage.stage).toBe("MISSING");
  });

  test("does not rewrite the durable state of families outside its mandate", async () => {
    const certifiedElectricity = () => {
      const seeded = createDurableGreenfieldUtilityState(scopedScope());
      seeded.utilities.electricity.stage = "SERVICE_CERTIFIED";
      seeded.utilities.electricity.plan = scopedPlan("electricity");
      seeded.utilities.electricity.planBinding = {
        projectId: "project:1", worldEpochId: "epoch:1", topologyRevision: "topology:1",
      };
      seeded.utilities.electricity.constructionAttempts = 1;
      return seeded;
    };
    // A reload that changes the topology revision refuses to rebind a family
    // still holding a plan continuation. The narrowed scope commissions water
    // alone, so electricity's continuation is not the narrowed scope's to
    // invalidate, and it survives the reload intact.
    const narrowed = scopedPorts();
    narrowed.setState(certifiedElectricity());
    const result = await runScopedGreenfieldUtilityBootstrap({
      scope: { ...scopedScope(), topologyRevision: "topology:2", commissionedKinds: ["water"] },
      ports: narrowed.implementation,
    });
    expect(result.state.utilities.electricity).toMatchObject({
      stage: "SERVICE_CERTIFIED", constructionAttempts: 1,
    });
    expect(result.state.utilities.electricity.plan).not.toBeNull();
    // The control: the same reload without a mandate does rebind electricity,
    // and refuses rather than silently discarding its continuation. That refusal
    // is the rewrite the mandate exists to withhold.
    const unmetered = scopedPorts();
    unmetered.setState(certifiedElectricity());
    await expect(runScopedGreenfieldUtilityBootstrap({
      scope: { ...scopedScope(), topologyRevision: "topology:2" },
      ports: unmetered.implementation,
    })).rejects.toThrow("STALE_UTILITY_TOPOLOGY_PLAN");
  });

  test("refuses a mandate that is empty, unknown, or duplicated", () => {
    const mandate = (commissionedKinds: GreenfieldUtilityKind[] | readonly string[]) =>
      () => assertGreenfieldUtilityScope({ ...scopedScope(), commissionedKinds } as GreenfieldUtilityExecutionScope);
    expect(mandate([])).toThrow("utility execution scope declares an invalid commissioning mandate");
    expect(mandate(["water", "water"])).toThrow("utility execution scope declares an invalid commissioning mandate");
    expect(mandate(["steam"])).toThrow("utility execution scope declares an invalid commissioning mandate");
    expect(mandate(["water"])).not.toThrow();
    expect(mandate(["sewage", "water"])).not.toThrow();
  });
});
