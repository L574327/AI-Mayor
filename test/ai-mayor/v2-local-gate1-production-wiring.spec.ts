import fs from "node:fs";
import path from "node:path";
import { createGate1ObservationProjector } from "../../src/main/services/ai-mayor/v2/gate1-observation";
import {
  createMemoryDurableStateStorage,
  V2DurabilityCoordinator,
  commandIdempotencyKey,
  type V2DurableStateStorage,
} from "../../src/main/services/ai-mayor/v2/durability";
import type { V2ObservationEnvelope, V2SourcePayload } from "../../src/main/services/ai-mayor/v2/foundation";
import {
  V2LocalGate1ProductionRunner,
  type V2LocalGate1DurabilityPort,
} from "../../src/main/services/ai-mayor/v2/local-gate1-runner";
import { createV2LocalGate1FoundationRunner } from "../../src/main/services/ai-mayor/v2/local-gate1-foundation-runner";
import type { V2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import type { Gate1Observation, Gate1State, StarterResidentialIntentInput } from "../../src/main/services/ai-mayor/v2/gate1";
import type { SpatialSiteDetail } from "../../src/main/services/ai-mayor/spatial/types";
import type { V2CommandRecord, V2CommandStatus } from "../../src/main/services/ai-mayor/v2/foundation";

const instant = new Date("2026-09-14T00:00:00.000Z");

describe("Phase B acceptance runner wiring", () => {
  const source = () => fs.readFileSync(path.join(process.cwd(), "scripts/local-v2-gate1-battlefield.ts"), "utf8");
  const launcher = () => fs.readFileSync(path.join(process.cwd(), "scripts/run-phase-b-electricity-acceptance.cjs"), "utf8");

  test("run8b consumes the production preparation seam instead of constructing target scope", () => {
    const text = source();
    expect(text).toContain("foundation.greenfieldUtilityBootstrap.prepare");
    expect(text).not.toContain("targetServiceEntry:");
    expect(text).not.toContain("approvedNetworkContact");
  });

  test("generic V2 runner is not Phase B mode", () => {
    expect(source()).toContain('process.env.AI_MAYOR_V2_PHASE_B_ELECTRICITY_ONLY === "1"');
    expect(launcher()).toContain('AI_MAYOR_V2_PHASE_B_ELECTRICITY_ONLY: "1"');
  });

  test("Phase B launcher creates a unique run-scoped namespace", () => {
    expect(launcher()).toContain("crypto.randomBytes");
    expect(launcher()).toContain("phase-b-electricity-${runId}");
    expect(launcher()).not.toContain("evidence/local-v2-gate1-battlefield");
  });

  test("Phase B rejects the fixed generic namespace and non-empty child before activation", () => {
    expect(source()).toContain("PHASE_B_UNIQUE_EVIDENCE_NAMESPACE_REQUIRED");
    expect(source()).toContain("PHASE_B_CHILD_NAMESPACE_NOT_EMPTY");
    expect(source()).toContain("createContinuationFromCheckpoint");
  });

  test("child report and activation require durable provenance and restored utility state", () => {
    const text = source();
    expect(text).toContain("child.continuation?.continuationId");
    expect(text).toContain("child.continuation.parentJournalPosition !== 3");
    expect(text).toContain("PHASE_B_CONTINUATION_PROVENANCE_VERIFICATION_FAILED");
    expect(text).toContain("PHASE_B_RESTORED_UTILITY_EXECUTION_MISSING");
    expect(text).toContain("report.continuation = continuationProvenance");
  });

  test("generic ROAD_DELIVERED does not enter the utility-specific handoff", () => {
    expect(source()).toContain("(phaseBElectricityOnly || phaseAOnly) && current.tranche.stage === \"ROAD_DELIVERED\"");
  });

  test("a failed K05 preparation returns to the durable utility service-road child planner", () => {
    const adapters = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/main-adapters.ts"), "utf8");
    const replanSignal = adapters.indexOf("SERVICE_ROAD_REPLAN_SIGNAL:");
    expect(replanSignal).toBeGreaterThan(-1);
    const window = adapters.slice(Math.max(0, replanSignal - 2_000), replanSignal + 250);
    expect(window).toContain("latest.tranche.stage === \"ROAD_DELIVERED\"");
    expect(window).toContain("latestUtilityPlan && !hasPendingRoadChild");
    expect(window).toContain("await prepareUtilityServiceRoadChild(latest, signal)");
  });

  test("only complete bounded contact exhaustion stops K05 retry as a planner blocker", () => {
    const adapters = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/main-adapters.ts"), "utf8");
    const progression = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/gate1-progression.ts"), "utf8");
    expect(adapters).toContain("utility.connectionReplan.replanCount >= utility.connectionReplan.maximumReplans");
    expect(adapters).toContain('entry.event === "UTILITY_SITE_CONTEXT_EXHAUSTED"');
    expect(adapters).toContain('activeBrainStrategy !== "FACILITY_REPLACEMENT_LAST_RESORT"');
    expect(adapters).toContain('status: "REPLAN", reason: `BRAIN_UTILITY_STRATEGY_EXHAUSTED:');
    expect(adapters).toContain('status: "PLANNING_HANDOFF", reason: `K05_UTILITY_SITE_CONTACT_OPTIONS_EXHAUSTED:');
    expect(progression).toContain('if (utilityResult.status === "BLOCKED")');
  });

  test("direct-cable fallback is checked against a certified road endpoint and does not revive an old road child", () => {
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const recovery = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/utility-recovery.ts"), "utf8");
    const materializer = adapter.slice(adapter.indexOf("const preparedConnectionPlan"), adapter.indexOf("if (serviceRoads.length > 4", adapter.indexOf("const preparedConnectionPlan")));
    expect(adapter).toContain("DIRECT_CABLE_CONTACT_IS_NOT_A_CERTIFIED_ROAD_ENDPOINT");
    expect(adapter).toContain("resolveCurrentElectricityTarget({");
    expect(adapter).toContain("constructionPreflightPreview(action, signal");
    expect(adapter).toContain("directCableNativePreflighted: true");
    expect(adapter).toContain('task.trancheId === scope.trancheId && !!task.utilityRoadParentTaskId');
    expect(adapter).toContain('command.status !== "OBSERVED_MATCH" || command.reconciliationStatus !== "MATCH"');
    expect(adapter).toContain('currentRoadRefs.get(key)');
    expect(adapter).toContain("authoritativeRoadRefs: [target.roadRef]");
    expect(materializer).toMatch(/prepared\.selected\?\.primitive\s*===\s*"service-road"/);
    expect(materializer).toMatch(/prepared\.selected\.actions/);
    expect(materializer).toMatch(/prepared\.selected\?\.primitive\s*===\s*"direct-cable"/);
    expect(materializer).toMatch(/selectedDirectCable\s*\?\s*\[\]\s*:\s*preparedConnectionPlan/);
    expect(materializer).toMatch(/input\.connectionOnly\s*\?\s*\[\]\s*:/);
    expect(materializer).not.toContain("preparedServiceRoads?.length");
    expect(recovery).toContain("bounded_utility_direct_cable_native_preflight_already_accepted");
  });

  test("current connection planning combines its direct connection result with the authoritative rebound facility", () => {
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const plannerPort = adapter.slice(adapter.indexOf("planCurrentConnection: async"), adapter.indexOf("plan: async (kind, currentScope)", adapter.indexOf("planCurrentConnection: async")));
    expect(plannerPort).toContain('mode: "EXISTING_FACILITY_CONNECTION", binding');
    expect(plannerPort).toContain("if (!planned.connection)");
    expect(plannerPort).toContain("const currentPlan = currentConnectionFacilityPlan(kind, currentScope, binding, planned.connection)");
    expect(plannerPort).toContain("return currentPlan");
    expect(plannerPort).not.toContain("planned.facility");
    expect(adapter).toContain("connectionPlan: UtilityConnectionPlan");
    expect(adapter).toContain("connection: structuredClone(connectionPlan.connection)");
  });

  test("current-facility planning switches to the certified-target cable after an unproductive service-road child", () => {
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const scopedPlanner = adapter.slice(adapter.indexOf("const planScopedUtility ="), adapter.indexOf("const resolveAdmittedCourseTerminal", adapter.indexOf("const planScopedUtility =")));
    const childPreparation = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/main-adapters.ts"), "utf8");
    const preparePort = childPreparation.slice(childPreparation.indexOf("const prepareUtilityServiceRoadChild"), childPreparation.indexOf("const planAlternateUtilitySite", childPreparation.indexOf("const prepareUtilityServiceRoadChild")));
    expect(scopedPlanner).toContain("UTILITY_CURRENT_TARGET_ROAD_NOT_AUTHORITATIVE");
    expect(scopedPlanner).toContain('selectedTopology: "authoritative-direct-cable-after-unproductive-road-child"');
    expect(scopedPlanner).toContain('currentRoadOutcome.reason.includes("NO_PRODUCTIVE_ROAD_EFFECT")');
    expect(scopedPlanner).toContain("serviceRoads: []");
    expect(preparePort).toContain('prepared.selected?.primitive === "direct-cable"');
    expect(preparePort).toContain("return false");
    const bootstrap = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/greenfield-utility-bootstrap.ts"), "utf8");
    expect(bootstrap).toContain("directCableTargetsCertifiedRoad");
    expect(bootstrap).toContain("!input.plan.serviceRoads?.length && !directCableTargetsCertifiedRoad");
  });

  test("exhausted utility-road child returns to its certified parent even after facility placement", () => {
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const childReplan = adapter.slice(adapter.indexOf('if (["BLOCKED", "FAILED"].includes(roadTask.status)'),
      adapter.indexOf("// A native INVALID preview", adapter.indexOf('if (["BLOCKED", "FAILED"].includes(roadTask.status)')));
    expect(childReplan).toContain("roadTask.utilityRoadParentTaskId");
    expect(childReplan).toContain("rejection?.execution === \"NOT_REQUIRED\"");
    expect(childReplan).toContain("amendment.executionUseStatus === \"UNUSED\"");
    expect(childReplan).toContain("currentTaskIds = { ...durableProject.tranche.currentTaskIds, ROAD_CONNECTION: parent.id }");
    expect(childReplan).not.toContain("placementState.status !== \"PLACED\"");
  });

  test("typed Electricity END resolution precedes native preflight and preserves endpoint authority", () => {
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const resolveAt = adapter.indexOf("const resolved = resolveCurrentElectricityTarget({");
    const endpointAt = adapter.indexOf("endEndpoint = electricityTargetEndpoint(resolved.binding)", resolveAt);
    const previewAt = adapter.indexOf('await callTool("cs2_spatial", { mode: "preflight", kind: "net"', endpointAt);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(endpointAt).toBeGreaterThan(resolveAt);
    expect(previewAt).toBeGreaterThan(endpointAt);
    expect(adapter.slice(endpointAt, previewAt + 300)).toContain("{ endEndpoint }");
    expect(adapter).toContain("worldEpoch: scope.generation");
  });

  test("restart reconciliation binds cable effects through the shared current-authoritative course", () => {
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    // One binding path, not two: the definition plus the two callers — the
    // current-world observer and the restart reconciler — so the two cannot
    // drift into answering the same question differently.
    expect(adapter.split("observeAdmittedCableCourse").length - 1).toBe(3);
    // The match is never pinned to a target node. The engine creates a fresh
    // free node at the far end of an admitted course, so a node-pinned match
    // could never succeed; the target's authority is the topology revision the
    // Bridge certifies for the reacquired current road.
    expect(adapter).not.toContain("targetNode, tolerance: 1.5");
    expect(adapter).toContain("expectedTopologyRevision: bridgeTopologyRevision({ generation, target: target.entity })");
  });
});

const worldA = {
  gameMode: "Game",
  isLoading: false,
  cityLoaded: true,
  world: {
    identityStatus: "AVAILABLE",
    worldReady: true,
    worldId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    nativeSessionGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    loadPurpose: "LoadGame",
    loadAssetGuid: "meta-a",
    saveDataAssetGuid: "data-a",
    mapAssetGuid: "map-a",
    checkpointId: "save:meta-a:data-a",
    bridgeRuntimeEpoch: "bridge-a",
    generation: "generation-a",
    generationSequence: 1,
    generationOrigin: "LOAD_COMPLETED",
  },
};
const worldB = {
  ...worldA,
  world: {
    ...worldA.world,
    worldId: "cs2-session:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    nativeSessionGuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    generation: "generation-b",
    bridgeRuntimeEpoch: "bridge-b",
  },
};

const initial = (): StarterResidentialIntentInput => ({
  intentId: "intent:production-wiring",
  targetResidents: 12,
  maximumBudget: 25_000,
  planningEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
  siteCandidates: [{ id: "site-a", target: { center: { x: 0, z: 0 }, radius: 30 }, score: 10, blocked: false }],
});

const detail = (): SpatialSiteDetail => ({
  center: { x: 0, z: 0 },
  radius: 64,
  terrain: {
    resolution: 2,
    bounds: { minX: -64, minZ: -64, maxX: 64, maxZ: 64 },
    cellSize: { x: 64, z: 64 },
    heights: [0, 0, 0, 0],
    waterDepths: [0, 0, 0, 0],
    groundWater: [0, 0, 0, 0],
    groundWaterPollution: [0, 0, 0, 0],
    windSpeed: [0, 0, 0, 0],
  },
  roadGraph: {
    nodes: [],
    edges: [{
      entity: { index: 20, version: 1 },
      prefab: "Small Road",
      native: true,
      startNode: { index: 21, version: 1 },
      endNode: { index: 22, version: 1 },
      start: { x: -30, z: 0 },
      end: { x: 30, z: 0 },
      length: 60,
    }],
  },
  buildings: [{
    entity: { index: 7, version: 1 },
    prefab: "ResidentialLow01",
    native: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    footprint: null,
  }],
  zoningCells: [{
    block: { index: 8, version: 1 },
    index: 0,
    position: { x: 0, y: 0, z: 0 },
    visible: true,
    roadside: true,
    occupied: true,
    blocked: false,
    overridden: false,
    zoneType: 1,
    zoneCategory: "residential",
  }],
});

function source<T>(data: T): V2SourcePayload<T> {
  return { status: "AVAILABLE", data };
}

function foundationEnvelope(coherence: "STABLE_FRAME" | "UNKNOWN" = "STABLE_FRAME"): V2ObservationEnvelope {
  const data = detail();
  const sourceValue = <T>(value: T) => ({
    ...source(value),
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 },
  });
  return {
    schemaVersion: "ai-mayor-v2-observation/1",
    observationId: "observation:foundation-wiring",
    runtimeEpoch: "runtime:foundation-wiring",
    worldEpoch: { kind: "RUNTIME_SESSION", value: "runtime:foundation-wiring", durableAcrossSaveLoad: false },
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    gameTimeStart: "2026-01-01 08:00",
    gameTimeEnd: "2026-01-01 08:00",
    pausedBefore: true,
    pausedAfter: true,
    coherence,
    sourceFreshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", maximumAgeMs: 0, allRequiredSourcesAvailable: true },
    revision: { authoritativeWorldRevision: null },
    sources: {
      gameStateBefore: sourceValue({}),
      snapshot: sourceValue({}),
      spatialScan: sourceValue({}),
      spatialDetail: sourceValue(data),
      gameStateAfter: sourceValue({}),
    },
  };
}

const worldIdentity = {
  worldId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  nativeSessionGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  loadPurpose: "NewGame" as const,
  loadAssetGuid: null,
  saveDataAssetGuid: null,
  mapAssetGuid: "map-a",
  checkpointId: null,
  bridgeRuntimeEpoch: "bridge-a",
  generation: "generation-a",
  generationSequence: 1,
  generationOrigin: "LOAD_COMPLETED",
  worldEpochId: "cs2-session:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:generation:generation-a",
  worldReady: true as const,
};

function access(ref: { index: number; version: number }) {
  return {
    buildingRef: ref,
    runtimeEpoch: "runtime:foundation-wiring",
    observationId: "access:1",
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    pausedBefore: true,
    pausedAfter: true,
    coherence: "STABLE_FRAME" as const,
    source: { status: "AVAILABLE" as const, reason: null, readStartedAt: instant.toISOString(), readEndedAt: instant.toISOString(), authoritativeBasis: "native" },
    status: "ATTACHED_ONLY" as const,
    statusProvenance: "DERIVED_WITH_EXPLICIT_RULE" as const,
    roadAttachment: null,
    entrances: [],
    networkEvidence: { status: "ENTRANCE_LANE_ATTACHED" as const, qualifyingEntranceCount: 1, reason: "fixture" },
    routeEvidence: { status: "UNAVAILABLE" as const, nativePathQueryExecuted: false as const, targetAnchor: null, reason: "fixture" },
    reason: "fixture",
    confidence: "HIGH_FOR_ATTACHMENT_ONLY" as const,
    derivation: null,
    nonAuthority: { geometricNearbyRoad: "NOT_USED" as const, undirectedRoadTopology: "NOT_USED" as const },
  };
}

function utility(ref: { index: number; version: number }) {
  const facts = { status: "SERVED" as const, statusProvenance: "DERIVED_WITH_EXPLICIT_RULE" as const, observed: null, rule: "fixture", assumptions: [], invalidityConditions: [], reason: "fixture" };
  return {
    schemaVersion: "ai-mayor-v2-target-utility/1" as const,
    buildingRef: ref,
    runtimeEpoch: "runtime:foundation-wiring",
    observationId: "utility:1",
    readStartedAt: instant.toISOString(),
    readEndedAt: instant.toISOString(),
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    pausedBefore: true,
    pausedAfter: true,
    coherence: "STABLE_FRAME" as const,
    source: { status: "AVAILABLE" as const, reason: null, readStartedAt: instant.toISOString(), readEndedAt: instant.toISOString(), authoritativeBasis: "Game.Buildings.ElectricityConsumer+Game.Buildings.WaterConsumer" as const },
    electricity: facts,
    water: facts,
    sewage: facts,
    globalCapacityPolicy: "SUPPORTING_CONTEXT_ONLY_NOT_USED_FOR_TARGET_STATUS" as const,
    facilityConnectorPolicy: "ABSENCE_DOES_NOT_IMPLY_CONSUMER_UNSERVED" as const,
  };
}

function foundationFor(envelope: V2ObservationEnvelope) {
  return {
    observation: { capture: async () => envelope },
    targetAccess: { observe: async ({ buildingRef }: { buildingRef: { index: number; version: number } }) => access(buildingRef) },
    routeQuery: { submit: async () => ({ state: "ROUTABLE" as const }) as never },
    utilityService: { observe: async ({ buildingRef }: { buildingRef: { index: number; version: number } }) => utility(buildingRef) },
    readBuildingResidents: async () => source({ residentCount: 3, occupied: true, provenance: "OBSERVED_NATIVE_COMPONENT" as const }),
  };
}

describe("V2 Local Gate 1 production wiring", () => {
  test("production adapter exposes an inert acceptance execute seam before command allocation", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const hook = source.indexOf("beforeUtilityNativeExecute?.");
    const commandAllocation = source.indexOf("const commandId =", hook);
    expect(hook).toBeGreaterThan(0);
    expect(commandAllocation).toBeGreaterThan(hook);
    expect(source).toContain("candidateId: candidate?.candidateId ?? null");
    expect(source).toContain("candidateKind: candidate?.kind ?? null");
    expect(source).toContain("if (error instanceof PhaseAAcceptanceStopError) throw error");
  });

  test("normal production wiring has no acceptance interceptor by default", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    expect(source).toContain("beforeUtilityNativeExecute?:");
    expect(source).toContain("await options.beforeUtilityNativeExecute?.({");
    expect(source).not.toContain("beforeUtilityNativeExecute: true");
  });

  test("typed Bridge endpoint uses bare current generation, not composite durable epoch", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    expect(source).toContain("worldEpoch: scope.generation, generation: scope.generation");
    expect(source).not.toContain("worldEpoch: scope.worldEpochId");
  });

  test("Phase B boundary is injected only as an optional post-certification seam", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/main-adapter.ts"), "utf8");
    const coordinator = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/v2/greenfield-utility-bootstrap.ts"), "utf8");
    expect(source).toContain("afterUtilityKindCertified?:");
    expect(source).toContain("afterKindCertified: options.afterUtilityKindCertified");
    expect(coordinator).toContain("await input.ports.afterKindCertified?.({ kind, state });");
    expect(source).not.toContain("if (PhaseB)");
  });

  test("Phase B road handoff uses the certified Utility service-road action", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "scripts/local-v2-gate1-battlefield.ts"), "utf8");
    expect(source).toContain("candidate.kind === \"service-road\"");
    expect(source).toContain("serviceRoadCandidate?.commandId");
    expect(source).toContain("serviceRoadCandidate?.exactActions[0]");
    expect(source).toContain("utilityRoadCommand.status !== \"OBSERVED_MATCH\"");
  });

  test("projects Foundation observation into scoped Gate1 evidence", async () => {
    const state = {
      intent: { id: "intent:production-wiring" },
      project: { id: "project" },
      district: { id: "district" },
      districtPlan: { id: "plan" },
      tranche: { id: "tranche", target: { center: { x: 0, z: 0 }, radius: 30 } },
    } as Gate1State;
    const projector = createGate1ObservationProjector({ foundation: foundationFor(foundationEnvelope()), world: worldIdentity, resolveRouteAnchor: () => ({ lane: { index: 20, version: 1 }, delta: 0.5 }) });
    const result = await projector.observe(state);
    expect(result).toMatchObject({
      coherence: "STABLE_FRAME",
      access: { value: "PASS", provenance: "DERIVED" },
      productiveFrontage: { value: "PASS", provenance: "DERIVED" },
      utilities: { value: "PASS", provenance: "DERIVED", evidenceKind: "ACTUAL_CONSUMER_SERVICE" },
      actualResidents: { value: 3, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [{ index: 7, version: 1 }] },
      world: { worldId: worldIdentity.worldId, worldEpochId: worldIdentity.worldEpochId },
    });
  });

  test("a tranche attributes only its own land use's buildings", async () => {
    // The very same world, read for a COMMERCIAL tranche. The residential
    // building standing inside it is not this Goal's building: counting it
    // would satisfy the post-zoning wait with a building this tranche's own
    // zoning can never produce, and the Goal would then certify consumer
    // service for a commercial district out of a residential neighbour.
    const projectState = (landUse: "RESIDENTIAL" | "COMMERCIAL") => ({
      intent: { id: "intent:production-wiring" },
      project: { id: "project" },
      district: { id: "district" },
      districtPlan: { id: "plan", landUse },
      tranche: { id: "tranche", target: { center: { x: 0, z: 0 }, radius: 30 } },
    } as Gate1State);
    const projector = createGate1ObservationProjector({
      foundation: foundationFor(foundationEnvelope()),
      world: worldIdentity,
      resolveRouteAnchor: () => ({ lane: { index: 20, version: 1 }, delta: 0.5 }),
    });

    const commercial = await projector.observe(projectState("COMMERCIAL"));
    expect(commercial.residentialBuildings.value).toEqual([]);
    expect(commercial.utilities.buildingRefs).toEqual([]);
    // With no building of this land use in scope, no frontage verdict exists
    // yet — the cell already zoned residential is not commercial frontage.
    expect(commercial.productiveFrontage.value).toBe("UNKNOWN");
    expect(commercial.access.value).toBe("UNKNOWN");

    // The residential reading is unchanged.
    const residential = await projector.observe(projectState("RESIDENTIAL"));
    expect(residential.residentialBuildings.value).toEqual([{ index: 7, version: 1 }]);
    expect(residential.productiveFrontage.value).toBe("PASS");
  });

  test("a state restored without a plan resumes as residential, as the zoning resolver does", async () => {
    const state = {
      tranche: { id: "tranche", target: { center: { x: 0, z: 0 }, radius: 30 } },
    } as Gate1State;
    const projector = createGate1ObservationProjector({
      foundation: foundationFor(foundationEnvelope()),
      world: worldIdentity,
      resolveRouteAnchor: () => ({ lane: { index: 20, version: 1 }, delta: 0.5 }),
    });
    const result = await projector.observe(state);
    expect(result.coherence).toBe("STABLE_FRAME");
    expect(result.residentialBuildings.value).toEqual([{ index: 7, version: 1 }]);
  });

  test("production factory binds Foundation activation, projector, and durable runner", async () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage, () => instant);
    const activation = coordinator.activate(worldA);
    const foundation = {
      ...foundationFor(foundationEnvelope()),
      durability: coordinator,
      activateDurableWorld: async () => activation,
    } as unknown as V2FoundationPorts;
    const runner = await createV2LocalGate1FoundationRunner({
      foundation,
      boundary: { execute: async () => ({ status: "DELIVERED" as const, commandId: "command:factory", observedMatch: true, reason: "delivered" }) },
      initial: initial(),
      resolveRouteAnchor: () => ({ lane: { index: 20, version: 1 }, delta: 0.5 }),
    });
    expect(runner.snapshot().project.id).toBe("intent:production-wiring:project:starter-residential");
  });

  test("preserves UNKNOWN coherence and evidence instead of producing PASS", async () => {
    const state = { tranche: { id: "tranche", target: { center: { x: 0, z: 0 }, radius: 30 } } } as Gate1State;
    const projector = createGate1ObservationProjector({ foundation: foundationFor(foundationEnvelope("UNKNOWN")), world: worldIdentity });
    const result = await projector.observe(state);
    expect(result.coherence).toBe("UNKNOWN");
    expect(result.access.value).toBe("UNKNOWN");
    expect(result.utilities.value).toBe("UNKNOWN");
    expect(result.residentialBuildings.value).toBeNull();
  });

  test("activates durable world before runner creation and resumes the next Task after restart", async () => {
    const storage = createMemoryDurableStateStorage();
    let currentWorld: unknown = worldA;
    const createDurability = () => {
      const coordinator = new V2DurabilityCoordinator(storage, () => instant);
      const port: V2LocalGate1DurabilityPort = {
        coordinator,
        activate: async () => coordinator.activate(currentWorld),
      };
      return port;
    };
    const observation = async (state: Gate1State): Promise<Gate1Observation> => ({
      observationId: `observation:${state.stateVersion}`,
      runtimeEpoch: "runtime:durable-runner",
      coherence: "STABLE_FRAME",
      capturedAt: instant.toISOString(),
      trancheId: state.tranche.id,
      access: { value: "PASS", provenance: "DERIVED" },
      productiveFrontage: { value: "PASS", provenance: "DERIVED" },
      utilities: { value: "PASS", provenance: "DERIVED", evidenceKind: "ACTUAL_CONSUMER_SERVICE", buildingRefs: [{ index: 7, version: 1 }] },
      residentialBuildings: { value: [{ index: 7, version: 1 }], provenance: "OBSERVED" },
      actualResidents: { value: 1, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [{ index: 7, version: 1 }], provenance: "OBSERVED" },
    });
    const boundary = { execute: async () => ({ status: "DELIVERED" as const, commandId: "command:1", observedMatch: true, reason: "delivered" }) };
    const first = await V2LocalGate1ProductionRunner.create({ durability: createDurability(), initial: initial(), boundary, observe: observation });
    await first.tick();
    const restarted = await V2LocalGate1ProductionRunner.create({ durability: createDurability(), initial: initial(), boundary, observe: observation });
    expect(restarted.snapshot().tasks[0].status).toBe("SUCCEEDED");
    expect((await restarted.tick()).proposal?.skill).toBe("RoadConnection");
  });

  test("stops on a changed world epoch and reconciles uncertain commands before a new write", async () => {
    const storage = createMemoryDurableStateStorage();
    const coordinator = new V2DurabilityCoordinator(storage, () => instant);
    let currentWorld: unknown = worldA;
    const port: V2LocalGate1DurabilityPort = { coordinator, activate: async () => coordinator.activate(currentWorld) };
    const observe = async (state: Gate1State): Promise<Gate1Observation> => ({
      observationId: "observation:world-change",
      runtimeEpoch: "runtime:world-change",
      coherence: "STABLE_FRAME",
      capturedAt: instant.toISOString(),
      trancheId: state.tranche.id,
      access: { value: "PASS", provenance: "DERIVED" },
      productiveFrontage: { value: "PASS", provenance: "DERIVED" },
      utilities: { value: "PASS", provenance: "DERIVED", evidenceKind: "ACTUAL_CONSUMER_SERVICE", buildingRefs: [] },
      residentialBuildings: { value: [], provenance: "OBSERVED" },
      actualResidents: { value: 0, provenance: "OBSERVED" },
      occupiedResidentialBuildings: { value: [], provenance: "OBSERVED" },
    });
    const boundaryCalls: string[] = [];
    const runner = await V2LocalGate1ProductionRunner.create({ durability: port, initial: initial(), boundary: { execute: async (proposal) => { boundaryCalls.push(proposal.skill); return { status: "DELIVERED" as const, commandId: "command:write", observedMatch: true, reason: "delivered" }; } }, observe });
    await runner.tick();
    currentWorld = worldB;
    const changed = await runner.tick();
    expect(changed.kind).toBe("LOCAL_WORLD_CHANGED");
    expect(changed.reason).toContain("world epoch changed");
    expect(boundaryCalls).toHaveLength(0);

    const pendingStorage = createMemoryDurableStateStorage();
    const pendingCoordinator = new V2DurabilityCoordinator(pendingStorage, () => instant);
    pendingCoordinator.activate(worldA);
    const pending = {
      schemaVersion: "ai-mayor-v2-command/1" as const,
      commandId: "command:uncertain",
      actionFamily: "ROAD" as const,
      actionType: "build_road",
      authorizedScope: { owner: { ownerType: "TASK" as const, ownerId: "task" }, actionFamily: "ROAD" as const, proposalId: "p", quoteId: "q", fingerprint: "f", exactInput: "{\"prefab\":\"Road\",\"x1\":1,\"z1\":1,\"x2\":2,\"z2\":2}", budget: { authorizedMaxSpend: 10, treasurySafetyReserve: 0, currency: "GAME_MONEY" }, observationPrecondition: { runtimeEpoch: "r", frame: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" },
      createdAt: instant.toISOString(), submittedAt: instant.toISOString(), nativeResultSummary: null, status: "UNKNOWN_TRANSPORT" as V2CommandStatus, statusHistory: [], reconciliationStatus: "NOT_STARTED" as const, observationEvidence: [], failureOrUnknownReason: null, effectAbsenceProven: false,
    } satisfies V2CommandRecord;
    pendingCoordinator.commandJournal.create(pending);
    let reconciled = false;
    const restartPort: V2LocalGate1DurabilityPort = { coordinator: pendingCoordinator, activate: async () => { const activation = pendingCoordinator.activate(worldA); for (const entry of pendingCoordinator.reconciliationRequired()) { pendingCoordinator.reconcile(entry.record.commandId, { result: "MATCH", reason: "exact effect observed" }); reconciled = true; } return activation; } };
    const restarted = await V2LocalGate1ProductionRunner.create({ durability: restartPort, initial: initial(), boundary: { execute: async () => ({ status: "DELIVERED" as const, commandId: "unused", observedMatch: true, reason: "unused" }) }, observe });
    expect(reconciled).toBe(true);
    expect(pendingCoordinator.reconciliationRequired()).toEqual([]);
    expect(restarted.snapshot().intent.id).toBe(initial().intentId);
  });
});
