import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson, createV2FoundationPorts } from "../src/main/services/ai-mayor/v2/main-adapter";
import { createV2LocalGate1FoundationRunner } from "../src/main/services/ai-mayor/v2/local-gate1-foundation-runner";
import { createGate1FoundationBoundary, recoverRoadConnectionForContinuationDirection, recoverRoadConnectionForStarterFrontage, recoverZoningForPreSubmitRadiusRejection, V2_GATE1_STATE_SCHEMA_VERSION } from "../src/main/services/ai-mayor/v2/gate1";
import { previewProductiveStarterRoad, classifyNativeRoadPreviewFailure } from "../src/main/services/ai-mayor/v2/runtime-road-caller";
import { resolveBoundedRoadCandidates } from "../src/main/services/ai-mayor/v2/road-connection-resolver";
import { stableRoadInput } from "../src/main/services/ai-mayor/v2/finance";
import { deriveExactZoningActionRadius, nativeZoningMarqueeFootprint } from "../src/main/services/ai-mayor/v2/foundation";
import type { ZoningIntent } from "../src/main/services/ai-mayor/v2/foundation";
import { parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import { buildSpatialWorldModel } from "../src/main/services/ai-mayor/spatial/world-scanner";
import { evaluateBoundedStarterSites, selectBoundedStarterSiteAnchors } from "../src/main/services/ai-mayor/v2/site-selection";
import type { SpatialSiteDetail, SpatialEntityRef } from "../src/main/services/ai-mayor/spatial/types";
import { V2DurabilityCoordinator, parseNativeWorldIdentity, type V2DurableStateStorage, type V2DurableState, type SaveCompletionReceipt } from "../src/main/services/ai-mayor/v2/durability";
import { interceptPhaseADirectCableExecution, PhaseAAcceptanceStopError, shouldStopBeforeDirectCableExecution } from "../src/main/services/ai-mayor/v2/phase-a-acceptance-boundary";
import { interceptPhaseBElectricityCertification, PhaseBElectricityAcceptanceStopError } from "../src/main/services/ai-mayor/v2/phase-b-acceptance-boundary";
import { inspectDurableCleanElectricityBaseline, inspectUtilityConnectorResidue, selectCurrentGenerationElectricityConnector, selectCurrentGenerationFacility } from "../src/main/services/ai-mayor/v2/durable-clean-baseline";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const durationMs = Number(process.env.AI_MAYOR_V2_DURATION_MS ?? 5 * 60_000);
const phaseAOnly = process.env.AI_MAYOR_V2_PHASE_A_ONLY === "1";
const phaseBElectricityOnly = process.env.AI_MAYOR_V2_PHASE_B_ELECTRICITY_ONLY === "1";
const directCableOnly = process.env.AI_MAYOR_V2_DIRECT_CABLE_ONLY === "1";
const defaultEvidenceDir = path.join(process.cwd(), "docs/ai-mayor/evidence/local-v2-gate1-battlefield");
const record = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
const key = (entity: SpatialEntityRef) => `${entity.index}:${entity.version}`;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

function fileStorage(file: string): V2DurableStateStorage {
  return {
    namespaceId: path.resolve(file),
    load: () => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")) as V2DurableState; } catch { return undefined; }
    },
    save: (state) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    },
  };
}

async function main() {
  const evidenceDir = process.env.AI_MAYOR_EVIDENCE_DIR ?? defaultEvidenceDir;
  if (phaseBElectricityOnly && (!process.env.AI_MAYOR_EVIDENCE_DIR || path.resolve(evidenceDir) === path.resolve(defaultEvidenceDir))) {
    throw new Error("PHASE_B_UNIQUE_EVIDENCE_NAMESPACE_REQUIRED");
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, `run-${new Date().toISOString().replaceAll(":", "-")}.json`);
  const client = new Client({ name: "5ire-local-v2-gate1-battlefield", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const events: Record<string, unknown>[] = [];
  const calls: Record<string, number> = {};
  const direct = async (name: string, args: Record<string, unknown> = {}) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return parseV2McpJson(await client.callTool({ name, arguments: args }));
  };
  const log = (event: string, data: unknown) => {
    const item = { at: new Date().toISOString(), event, data };
    events.push(item);
    process.stdout.write(`${JSON.stringify(item)}\n`);
  };
  let providerInvocations = 0;
  let legacyBrainInvocations = 0;
  let report: Record<string, unknown> = {
    harness: "V2_LOCAL_GATE1_PRODUCTION_RUNNER",
    serverPath,
    providerInvocations,
    legacyBrainInvocations,
    cloudUsed: false,
    legacyBrainUsed: false,
  };
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const required = [
      "cs2_game_state", "cs2_spatial", "cs2_mayor_snapshot", "cs2_build_road", "cs2_mayor_execute_actions",
      "cs2_building_access", "cs2_submit_building_route_query", "cs2_building_route_query_status", "cs2_utility_connectors",
      "cs2_inspect", "cs2_list_roads", "cs2_run_simulation",
      "cs2_list_buildings", "cs2_save_game", "cs2_save_status",
    ];
    const names = new Set(listed.tools.map((tool) => tool.name));
    const missing = required.filter((name) => !names.has(name));
    if (missing.length > 0) throw new Error(`HARNESS_WIRING_MISSING_TOOLS:${missing.join(",")}`);
    const manager = {
      legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `battlefield--${tool.name}` })) }),
      legacyCall: async ({ name, arguments: args }: { client: string; name: string; arguments: Record<string, unknown> }) =>
        client.callTool({ name, arguments: args }),
    };
    const game = record(await direct("cs2_game_state"));
    const simulation = record(game.simulation);
    const world = record(game.world);
    report.preflight = { gameMode: game.gameMode, cityLoaded: game.cityLoaded, isLoading: game.isLoading, worldReady: world.worldReady, paused: simulation.paused, worldId: world.worldId, generation: world.generation, loadPurpose: world.loadPurpose, checkpointId: world.checkpointId ?? null };
    if (game.gameMode !== "Game" || game.cityLoaded !== true || game.isLoading !== false || world.worldReady !== true || simulation.paused !== true) {
      throw new Error("RUNTIME_PREFLIGHT_NOT_READY_MANUALLY_LOAD_DISPOSABLE_SAVE");
    }
    const storageFile = path.join(evidenceDir, "v2-durable-state.json");
    let durabilityStorage = fileStorage(storageFile);
    let continuationProvenance: ReturnType<V2DurabilityCoordinator["createContinuationFromCheckpoint"]> | null = null;
    if (phaseBElectricityOnly) {
      const requestedParent = process.env.AI_MAYOR_PARENT_DURABLE_STATE_FILE;
      if (!requestedParent) throw new Error("PHASE_B_PARENT_DURABLE_STATE_REQUIRED");
      const parentFile = path.resolve(requestedParent);
      report.actualParentDurableStateFile = parentFile;
      const parentStorage = fileStorage(parentFile);
      const parentDurability = new V2DurabilityCoordinator(parentStorage);
      if (durabilityStorage.load() !== undefined && durabilityStorage.load() !== null) {
        throw new Error("PHASE_B_CHILD_NAMESPACE_NOT_EMPTY");
      }
      const parentNamespaceId = path.resolve(parentFile);
      // Safety guard: inspect the parent before creating any child namespace or
      // reaching the utility execution path. This is evidence/safety only.
      const cleanBaseline = inspectDurableCleanElectricityBaseline(parentStorage.load());
      if (!cleanBaseline.pass) {
        throw new Error(`DURABLE_CLEAN_BASELINE_REQUIRED:${JSON.stringify(cleanBaseline.diagnostics)}`);
      }
      // Safety-only current-world guard: durable candidate state cannot prove that
      // the reloaded facility connector has no local cable/topology residue.
      const parentState = record(parentStorage.load());
      const parentElectricity = record(record(record(record(parentState.projectState).tranche).utilityExecution).utilities).electricity;
      const parentPlan = record(parentElectricity.plan);
      const parentPosition = record(parentPlan.position);
      const buildingList = record(await direct("cs2_list_buildings", { query: "WindTurbine", limit: 32 }));
      const facilityRebind = selectCurrentGenerationFacility({
        buildings: Array.isArray(buildingList.buildings) ? buildingList.buildings : [],
        prefab: String(parentPlan.prefab),
        position: { x: Number(parentPosition.x), z: Number(parentPosition.z) },
      });
      if (facilityRebind.status !== "MATCH") throw new Error(facilityRebind.status);
      const connectorPayload = record(await direct("cs2_utility_connectors", {
        index: facilityRebind.facility.entity.index, version: facilityRebind.facility.entity.version,
      }));
      const connectorRebind = selectCurrentGenerationElectricityConnector({
        connectors: Array.isArray(connectorPayload.connectors) ? connectorPayload.connectors : [],
        facilityPosition: facilityRebind.facility.position,
      });
      if (connectorRebind.status !== "MATCH") throw new Error(connectorRebind.status);
      const electricityConnector = connectorRebind.connector;
      const connectorResidue = inspectUtilityConnectorResidue(electricityConnector, String(world.generation ?? "UNKNOWN"));
      report.currentConnectorRebind = {
        durableConnectorEntity: record(parentElectricity.connector).node ?? null,
        currentGeneration: String(world.generation ?? "UNKNOWN"),
        reboundConnectorEntity: record(electricityConnector.node),
        rebindEvidence: { facility: facilityRebind.evidence, connector: connectorRebind.evidence },
        attached: connectorResidue.diagnostics.attached,
        connectedEdges: connectorResidue.diagnostics.connectedEdges,
        residueStatus: connectorResidue.status,
      };
      if (connectorResidue.status === "RESIDUE") {
        throw new Error(`UTILITY_CONNECTOR_RESIDUE_PRESENT:${JSON.stringify(connectorResidue.diagnostics)}`);
      }
      if (connectorResidue.status !== "CLEAN") throw new Error(`UTILITY_CONNECTOR_CLEAN_CHECK_UNKNOWN:${JSON.stringify(connectorResidue.diagnostics)}`);
      continuationProvenance = parentDurability.createContinuationFromCheckpoint({
        continuationId: path.basename(evidenceDir),
        parentNamespaceId,
        checkpointId: "save:6df74663f913ed084d06fe9bca543203:b1827c7e5662e89cf47bd9c13b14ec3d",
        saveMetadataAssetGuid: "6df74663f913ed084d06fe9bca543203",
        saveDataAssetGuid: "b1827c7e5662e89cf47bd9c13b14ec3d",
        expectedWorld: parseNativeWorldIdentity(game),
        journalPosition: 3,
        childStorage: durabilityStorage,
      });
      const child = durabilityStorage.load();
      if (!child || child.continuation?.continuationId !== continuationProvenance.continuationId ||
        child.continuation.parentNamespaceId !== continuationProvenance.parentNamespaceId ||
        child.continuation.parentCheckpointId !== "save:6df74663f913ed084d06fe9bca543203:b1827c7e5662e89cf47bd9c13b14ec3d" ||
        child.continuation.parentJournalPosition !== 3 || child.journalPosition !== 3 ||
        child.active?.loadedCheckpointId !== "save:6df74663f913ed084d06fe9bca543203:b1827c7e5662e89cf47bd9c13b14ec3d") {
        throw new Error("PHASE_B_CONTINUATION_PROVENANCE_VERIFICATION_FAILED");
      }
    }
    const foundation = createV2FoundationPorts({
      getToolsManager: () => manager,
      durableStateStorage: durabilityStorage,
      beforeUtilityNativeExecute: phaseAOnly ? async (input) => {
        interceptPhaseADirectCableExecution(input);
      } : undefined,
      afterUtilityKindCertified: phaseBElectricityOnly ? async (input) => {
        interceptPhaseBElectricityCertification(input);
      } : undefined,
    });
    const durability = foundation.durability;
    if (!durability) throw new Error("V2 durability coordinator unavailable");
    const activation = await foundation.activateDurableWorld?.();
    if (!activation || activation.blockedReason) throw new Error(`DURABILITY_ACTIVATION_FAILED:${activation?.blockedReason ?? "missing"}`);
    if (!["ACTIVATED", "ACTIVATED_IN_PLACE"].includes(activation.status)) throw new Error(`DURABILITY_ACTIVATION_${activation.status}`);
    report.worldIdentity = activation.world;
    if (phaseBElectricityOnly) {
      const restored = durability.projectState();
      if (restored.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION || !restored.tranche.utilityExecution) {
        throw new Error("PHASE_B_RESTORED_UTILITY_EXECUTION_MISSING");
      }
      report.continuation = continuationProvenance;
      report.continuationNamespace = path.resolve(evidenceDir);
    }

    const scan = parseSpatialBootstrapScan(await direct("cs2_spatial", { mode: "scan", roadLimit: 2000 }));
    const spatialWorld = buildSpatialWorldModel(scan);
    const mayorSnapshot = record(await direct("cs2_mayor_snapshot"));
    const availableRoadPrefabs = Array.isArray(record(mayorSnapshot.planningCatalog).roadPrefabs)
      ? record(mayorSnapshot.planningCatalog).roadPrefabs.filter((value): value is string => typeof value === "string")
      : [];
    const anchors = selectBoundedStarterSiteAnchors(spatialWorld, 24);
    const details: Array<{ anchor: { x: number; z: number }; detail: SpatialSiteDetail }> = [];
    for (const anchor of anchors) {
      const candidate = await direct("cs2_spatial", { mode: "detail", x: anchor.node.position.x, z: anchor.node.position.z, radius: 96, resolution: 16 }) as SpatialSiteDetail;
      details.push({ anchor: { x: anchor.node.position.x, z: anchor.node.position.z }, detail: candidate });
    }
    const selection = evaluateBoundedStarterSites({
      world: spatialWorld,
      worldEpoch: activation.world.worldEpochId,
      bridgeGeneration: activation.world.generation,
      availableRoadPrefabs,
      anchors,
      details,
      maxCandidates: 4,
    });
    report.siteSelection = {
      inspectedRegions: selection.inspectedRegions,
      eligibleStarterAnchors: anchors.map((anchor) => ({ entity: anchor.node.entity, position: anchor.node.position, direction: anchor.direction, derivation: anchor.derivation, sourceEdges: anchor.sourceEdges.map((edge) => ({ entity: edge.entity, prefab: edge.prefab })) })),
      rawZoningCells: details.reduce((count, entry) => count + entry.detail.zoningCells.length, 0),
      candidates: selection.candidates.map((candidate) => ({ id: candidate.id, target: candidate.target, score: candidate.score, direction: candidate.direction, evidence: candidate.evidence })),
      rejections: selection.rejections,
      candidateEndpointEpochs: selection.candidates.map((candidate) => ({
        id: candidate.id,
        start: candidate.roadCandidates[0]?.input.startEndpoint?.worldEpoch ?? null,
        end: candidate.roadCandidates[0]?.input.endEndpoint?.worldEpoch ?? null,
      })),
    };
    report.epochPropagation = {
      authoritativeActiveEpoch: activation.world.worldEpochId,
      candidateEpochs: selection.candidates.flatMap((candidate) => candidate.roadCandidates.slice(0, 1).map((road) => ({
        candidateId: candidate.id,
        start: road.input.startEndpoint?.worldEpoch ?? null,
        end: road.input.endEndpoint?.worldEpoch ?? null,
      }))),
    };
    const selected = selection.candidates[0];
    if (!selected) throw new Error("LOCAL_NO_APPLICABLE_SITE: bounded owned/buildable/access-feasible Gate1 site unavailable");
    const selectedRegion = details.find((region) => region.anchor.x === selected.evidence.sourceAnchor.x && region.anchor.z === selected.evidence.sourceAnchor.z);
    const detail = selectedRegion?.detail;
    let target = selected.target;
    if (!detail) throw new Error("LOCAL_NO_APPLICABLE_SITE: selected site observation region unavailable");
    let roadResolution = { candidates: selected.roadCandidates };
    const roadEvidence: unknown[] = [];
    const durableProjectState = durability.projectState();
    const durableState = durableProjectState?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION ? durableProjectState : null;
    const durableRoadTask = durableState?.tasks.find((task) => task.kind === "ROAD_CONNECTION");
    const durableLatestRoadOutcome = durableRoadTask ? [...durableState!.journal].reverse().find((entry) => entry.taskId === durableRoadTask.id) : undefined;
    const continuationRecoveryNeeded = durableState && (
      durableState.tranche.stage === "ROAD_DELIVERED" ||
      (durableState.tranche.stage === "SITE_SELECTED" && durableRoadTask?.status === "BLOCKED" && durableLatestRoadOutcome?.reason === "NO_PRODUCTIVE_ROAD_EFFECT")
    );
    if (continuationRecoveryNeeded) {
      target = durableState.tranche.target;
      const postRoadEnvelope = await foundation.observation.capture({
        spatialDetail: { x: target.center.x, z: target.center.z, radius: 64, resolution: 16 },
      });
      const postRoadDetail = postRoadEnvelope.sources.spatialDetail.data;
      const productiveCells = postRoadDetail?.zoningCells.filter((cell) =>
        distance(cell.position, target.center) <= target.radius &&
        cell.visible && cell.roadside && !cell.blocked && !cell.overridden &&
        (cell.zoneCategory === "none" || cell.zoneCategory === "residential"),
      ) ?? [];
      if (!postRoadDetail || postRoadEnvelope.coherence === "UNKNOWN") {
        throw new Error("STARTER_FRONTAGE_RECOVERY_NOT_APPLICABLE");
      }
      // A previous continuation may already have produced authoritative
      // frontage. In that case the durable ROAD_DELIVERED state is valid and
      // must flow into the formal runner; recovery is only for the zero-cell
      // case.
      if (productiveCells.length > 0) {
        // no recovery required
      } else {
      const currentRoad = spatialWorld.roadGraph.edges.find((edge) =>
        edge.entity.index === 177757 && edge.entity.version === 15 && edge.prefab === "Medium Road",
      );
      const currentEndNode = currentRoad
        ? spatialWorld.roadGraph.nodes.find((node) => node.entity.index === currentRoad.endNode.index && node.entity.version === currentRoad.endNode.version)
        : undefined;
      if (!currentRoad || !currentEndNode) throw new Error("STARTER_FRONTAGE_RECOVERY_ENDPOINT_NOT_AUTHORITATIVE");
      const continuation = resolveBoundedRoadCandidates({
        siteTarget: target.center,
        reservation: target,
        planningEnvelope: { center: target.center, radius: 180 },
        sourceEdges: [currentRoad],
        sourceNodes: spatialWorld.roadGraph.nodes,
        allowedSourceNodeRefs: [currentEndNode.entity],
        ownedTiles: spatialWorld.ownedTiles,
        terrain: postRoadDetail.terrain,
        buildings: postRoadDetail.buildings,
        prefab: "Medium Road",
        bridgeGeneration: activation.world.generation,
        worldEpoch: activation.world.worldEpochId,
        certifiedContinuationSource: { edge: currentRoad, node: currentEndNode, role: "end" },
      });
      if (continuation.candidates.length === 0) throw new Error("STARTER_FRONTAGE_RECOVERY_NO_BOUNDED_CONTINUATION");
      const recovered = durableState.tranche.stage === "ROAD_DELIVERED"
        ? recoverRoadConnectionForStarterFrontage(durableState, foundation.commandJournal, {
          observationId: postRoadEnvelope.observationId,
          reason: "one-shot continuation recovery after authoritative road effect matched but all bounded road-local frontage cells remained junction/transition blocked",
        })
        : recoverRoadConnectionForContinuationDirection(durableState, {
          observationId: postRoadEnvelope.observationId,
          reason: "one-shot continuation recovery after bounded Preview proved reservation near-boundary reversed the authoritative terminal tangent",
        });
      if (!recovered) throw new Error("STARTER_FRONTAGE_RECOVERY_NOT_ALLOWED");
      durability.saveProjectState(durableState);
      roadResolution = continuation;
      }
    }
    const initial = {
      intentId: `intent:local-v2-gate1:${Date.now()}`,
      targetResidents: 12,
      maximumBudget: 25_000,
      planningEnvelope: { center: target.center, radius: 180 },
      siteCandidates: [{ id: selected.id, target, score: selected.score, blocked: false }],
      starterDirection: selected.direction,
      maximumWaitObservations: 3,
    };
    if (durableState && durableState.tranche.stage === "ROAD_DELIVERED") {
      const zoningTask = durableState.tasks.find((task) => task.kind === "ZONING");
      const latestZoning = zoningTask ? [...durableState.journal].reverse().find((entry) => entry.taskId === zoningTask.id) : undefined;
      if (latestZoning?.reason === "zoning delivery lacked exact observed effect") {
        const recovered = recoverZoningForPreSubmitRadiusRejection(durableState, foundation.commandJournal, {
          observationId: latestZoning.observationId ?? "zoning-radius-recovery",
          reason: "one-shot recovery after pre-submit native radius proved broader than the exact authorized zoning cell set",
        });
        if (recovered) durability.saveProjectState(durableState);
      }
    }
    const boundary = createGate1FoundationBoundary(foundation, {
      road: async (proposal, signal) => {
        const candidate = roadResolution.candidates[proposal.methodVariant === "PRIMARY" ? 0 : 1] ?? roadResolution.candidates[0];
        const productive = await previewProductiveStarterRoad({
          input: candidate.input,
          preview: async (roadInput) => {
            try { return await direct("cs2_spatial", { mode: "preflight", kind: "net", ...roadInput }); }
            catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { previewFailure: classifyNativeRoadPreviewFailure(error) }); }
          },
          signal,
        });
        const roadInput = productive.input;
        const evidence: Record<string, unknown> = {
          candidate: candidate.sourceAnchorEvidence,
          geometry: roadInput,
          attemptedLengthsMeters: productive.attemptedLengthsMeters,
          selectedLengthMeters: productive.selectedLengthMeters,
          preview: "PRODUCTIVE_VALID",
        };
        roadEvidence.push(evidence);
        const quote = productive.quote;
        return {
          proposal: { identity: { proposalId: quote.proposalId, actionFamily: "ROAD", exactInput: stableRoadInput(roadInput), runtimeEpoch: quote.runtimeEpoch, frame: quote.frame, validationState: "VALID" }, quoteId: quote.quoteId, fingerprint: stableRoadInput(roadInput), input: roadInput, owner: { ownerType: "TASK", ownerId: proposal.taskId } },
          quote, authorizedMaxSpend: Math.max(quote.signedAmount, 1) * 1.25, treasurySafetyReserve: 0,
        };
      },
      zoning: async (proposal) => {
        const envelope = await foundation.observation.capture({ spatialDetail: { x: target!.center.x, z: target!.center.z, radius: Math.max(64, target!.radius * Math.SQRT2), resolution: 16 } });
        if (envelope.coherence === "UNKNOWN" || envelope.sources.spatialDetail.status !== "AVAILABLE" || !envelope.sources.spatialDetail.data) throw new Error("zoning observation coherence UNKNOWN");
        const site = envelope.sources.spatialDetail.data;
        const seedCells = site.zoningCells.filter((cell) => distance(cell.position, target!.center) <= target!.radius && cell.visible && !cell.occupied && !cell.blocked && !cell.overridden && cell.zoneCategory === "none");
        if (seedCells.length === 0) throw new Error("LOCAL_NO_APPLICABLE_SKILL:no exact residential cells");
        const exactRadius = deriveExactZoningActionRadius(target!.center, seedCells);
        if (!(exactRadius > 0 && exactRadius <= target!.radius)) throw new Error("LOCAL_NO_APPLICABLE_SKILL:exact zoning radius unavailable");
        const nativeFootprint = nativeZoningMarqueeFootprint(site, target!.center, exactRadius);
        const mutableCells = nativeFootprint.filter((cell) => cell.zoneCategory !== "residential");
        if (mutableCells.length === 0 || mutableCells.some((cell) => cell.zoneCategory !== "none" || cell.occupied || cell.blocked || cell.overridden)) {
          throw new Error("LOCAL_NO_APPLICABLE_SKILL:native marquee footprint contains an unsafe zoning cell");
        }
        const authorizedCells = mutableCells.map((cell) => ({ block: cell.block, cellIndex: cell.index, expected: { zoneType: cell.zoneType, zoneCategory: cell.zoneCategory, visible: cell.visible, roadside: cell.roadside, occupied: cell.occupied, blocked: cell.blocked, overridden: cell.overridden } }));
        const exactEnvelope = { ...target!, radius: exactRadius };
        const zoning: ZoningIntent = { intentId: proposal.id, scope: { owner: { ownerType: "TASK", ownerId: proposal.taskId }, actionFamily: "ZONING", allowedCells: authorizedCells, spatialEnvelope: exactEnvelope, maximumAffectedArea: { maxCellCount: authorizedCells.length, maxRadiusMeters: exactRadius }, budget: { maximumCost: null, currency: "GAME_MONEY", status: "PLACEHOLDER" }, observationPrecondition: { observationId: envelope.observationId, runtimeEpoch: envelope.runtimeEpoch, coherence: envelope.coherence }, intendedEffect: { zoneCategory: "residential" }, expiresAt: new Date(Date.now() + 2000).toISOString() }, zoneCategory: "residential", nativeZone: "EU Residential Low", authorizedCells, spatialEnvelope: { ...exactEnvelope, resolution: 16 } };
        return { intent: zoning, baseline: envelope };
      },
    });
    const runner = await createV2LocalGate1FoundationRunner({ foundation, boundary, initial });
    report.staticAcceptance = { authoritativeRouteAnchor: "NATIVE_BUILDING_ACCESS_LANE", durableActivation: "PASS", providerInvocations: 0, legacyV1BrainInvocations: 0, cloudFallback: 0 };

    const beforeSnapshot = record(await direct("cs2_mayor_snapshot"));
    const startedAt = Date.now();
    let blocker: { class: string; reason: string } | null = null;
    let decisions = 0;
    let roadActions = 0;
    let zoningActions = 0;
    let waitingLoops = 0;
    let observationPolls = 0;
    let utilityBootstrap: Awaited<ReturnType<typeof foundation.greenfieldUtilityBootstrap.run>> | null = null;
    let utilityWaitingLoops = 0;
    let phaseAStop: Record<string, unknown> | null = null;
    let phaseBStop: Record<string, unknown> | null = null;
    let canonicalSave: Record<string, unknown> | null = null;
    let postElectricitySave: Record<string, unknown> | null = null;
    const maximumWaitingLoops = 3;
    while (Date.now() - startedAt < durationMs) {
      const current = runner.snapshot();
      if ((phaseBElectricityOnly || phaseAOnly) && current.tranche.stage === "ROAD_DELIVERED") {
        const roadTask = current.tasks.find((task) => task.kind === "ROAD_CONNECTION");
        const roadCommandId = roadTask?.terminalOutcomeId
          ? current.journal.find((entry) => entry.id === roadTask.terminalOutcomeId)?.commandId
          : null;
        const roadCommand = roadCommandId ? foundation.commandJournal.get(roadCommandId) : undefined;
        const durableUtility = durability.projectState().schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
          ? durability.projectState().tranche.utilityExecution : null;
        const serviceRoadCandidate = durableUtility?.utilities.electricity.candidateLedger.find((candidate) => candidate.kind === "service-road");
        const utilityRoadCommand = serviceRoadCandidate?.commandId ? foundation.commandJournal.get(serviceRoadCandidate.commandId) : undefined;
        const serviceRoadAction = serviceRoadCandidate?.exactActions[0];
        const certifiedTopologyRoad = serviceRoadAction as { type?: string; prefab: string; x1: number; z1: number; x2: number; z2: number } | undefined;
        if (!certifiedTopologyRoad || certifiedTopologyRoad.type !== "build_road") throw new Error("STALE_UTILITY_CERTIFIED_ROAD_ACTION");
        const utilityRoadCommandIsValid = utilityRoadCommand?.authorizedScope.actionFamily === "UTILITY";
        if (!roadCommand || roadCommand.status !== "OBSERVED_MATCH" ||
          (!directCableOnly && (!utilityRoadCommand || utilityRoadCommand.status !== "OBSERVED_MATCH")) ||
          (directCableOnly && (!serviceRoadCandidate?.commandId || !utilityRoadCommand || utilityRoadCommand.status !== "OBSERVED_MATCH")) ||
          !utilityRoadCommandIsValid) {
          throw new Error("UTILITY_SCOPE_REQUIRES_CURRENT_CERTIFIED_ROAD");
        }
        if (phaseAOnly && utilityBootstrap && shouldStopBeforeDirectCableExecution(
          utilityBootstrap.state.utilities.electricity,
          utilityBootstrap.state.utilities.electricity.commandOutcome === "SUBMITTED" ||
          utilityBootstrap.state.utilities.electricity.commandOutcome === "UNKNOWN",
        )) {
          const saveName = `AI市长V2-电缆前标准存档-0915-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
          let saveStatus = record(await direct("cs2_save_status"));
          let requestId = typeof saveStatus.saveRequestId === "string" ? saveStatus.saveRequestId : null;
          if (saveStatus.state === undefined || saveStatus.state === "IDLE" || saveStatus.status === "COMPLETED") {
            const submitted = record(await direct("cs2_save_game", { name: saveName }));
            if (submitted.status !== "SUBMITTED" || typeof submitted.saveRequestId !== "string") {
              throw new Error(`CANONICAL_PRE_CABLE_SAVE_SUBMISSION_FAILED:${String(submitted.status ?? "UNKNOWN")}`);
            }
            requestId = submitted.saveRequestId;
          }
          let completed = false;
          for (let check = 0; check < 120; check += 1) {
            saveStatus = record(await direct("cs2_save_status", requestId ? { requestId } : {}));
            if (saveStatus.status === "COMPLETED" && saveStatus.durable === true &&
              saveStatus.worldId === activation.world.worldId &&
              saveStatus.worldGeneration === activation.world.generation) {
              completed = true;
              break;
            }
            if (saveStatus.status === "FAILED" || saveStatus.status === "UNKNOWN") break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (!completed) throw new Error("CANONICAL_PRE_CABLE_SAVE_DURABILITY_UNKNOWN");
          const verifiedWorld = record(await direct("cs2_game_state"));
          const verifiedStatus = record(await direct("cs2_save_status", requestId ? { requestId } : {}));
          const verifiedNativeWorld = record(verifiedWorld.world);
          const verifiedCheckpoint = record(verifiedStatus.checkpoint);
          if (
            verifiedStatus.status !== "COMPLETED" || verifiedStatus.durable !== true ||
            verifiedStatus.worldId !== activation.world.worldId ||
            verifiedStatus.worldGeneration !== activation.world.generation ||
            verifiedNativeWorld.worldId !== activation.world.worldId ||
            verifiedNativeWorld.generation !== activation.world.generation ||
            verifiedCheckpoint.nativeSessionGuid !== activation.world.nativeSessionGuid ||
            typeof verifiedCheckpoint.checkpointId !== "string" ||
            typeof verifiedCheckpoint.saveMetadataAssetGuid !== "string" ||
            typeof verifiedCheckpoint.saveDataAssetGuid !== "string"
          ) {
            throw new Error("CANONICAL_PRE_CABLE_SAVE_CHECKPOINT_READBACK_MISMATCH");
          }
          const checkpointJournalPosition = durability.currentJournalPosition();
          const registeredCheckpoint = durability.recordCheckpoint(
            verifiedStatus as unknown as SaveCompletionReceipt,
            checkpointJournalPosition,
          );
          const registeredState = durability.snapshot();
          const persistedCheckpoint = registeredState.checkpoints.find((checkpoint) =>
            checkpoint.worldId === registeredCheckpoint.worldId && checkpoint.checkpointId === registeredCheckpoint.checkpointId,
          );
          if (!persistedCheckpoint ||
            persistedCheckpoint.journalPosition !== checkpointJournalPosition ||
            persistedCheckpoint.saveMetadataAssetGuid !== verifiedCheckpoint.saveMetadataAssetGuid ||
            persistedCheckpoint.saveDataAssetGuid !== verifiedCheckpoint.saveDataAssetGuid ||
            registeredState.active?.rollbackBoundaryId !== registeredCheckpoint.checkpointId ||
            registeredState.certifiedRollbackAnchor?.checkpointId === registeredCheckpoint.checkpointId
          ) {
            throw new Error("CANONICAL_PRE_CABLE_CHECKPOINT_REGISTRATION_NOT_DURABLE");
          }
          canonicalSave = { name: saveName, requestId, status: verifiedStatus, verifiedWorld, registeredCheckpoint, checkpointJournalPosition };
          phaseAStop = { reason: "ACCEPTANCE_HARNESS_STOP_BEFORE_DIRECT_CABLE_NATIVE_BOUNDARY", utilityState: utilityBootstrap.state.utilities.electricity, saveName, registeredCheckpointId: registeredCheckpoint.checkpointId, checkpointJournalPosition };
          break;
        }
        const overview = record(await direct("cs2_city_overview"));
        const treasury = Number(overview.treasury);
        if (!Number.isFinite(treasury)) throw new Error("UTILITY_SCOPE_FINANCE_UNKNOWN");
        const prepared = await foundation.greenfieldUtilityBootstrap.prepare(buildUtilityPreparationInput({
          state: current,
          world: activation.world,
          treasury: Math.max(0, treasury),
          connectionOnly: directCableOnly,
          selectedPrimitive: directCableOnly ? "direct-cable" : undefined,
        }));
        if (prepared.status !== "READY") throw new Error(`${prepared.reason}`);
        try {
          utilityBootstrap = await foundation.greenfieldUtilityBootstrap.run(prepared.executionScope);
        } catch (error) {
          if (error instanceof PhaseBElectricityAcceptanceStopError) {
            const project = durability.projectState();
            const durableUtility = project.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
              ? project.tranche.utilityExecution : null;
            const electricity = durableUtility?.utilities.electricity;
            if (!electricity || electricity.stage !== "SERVICE_CERTIFIED" ||
              electricity.connectionObjective?.status !== "COMPLETE" ||
              electricity.candidateLedger.some((candidate) => ["AUTHORIZED", "SUBMITTED", "RECONCILING", "UNKNOWN"].includes(candidate.ledgerState)) ||
              electricity.commandOutcome === "SUBMITTED" || electricity.commandOutcome === "UNKNOWN") {
              throw new Error("PHASE_B_ACCEPTANCE_STOP_DURABLE_INVARIANT_FAILED");
            }
            utilityBootstrap = { state: durableUtility, serviceCertified: true, waiting: false,
              reason: error.message, providerInvocations: 0, legacyBrainInvocations: 0 };
            phaseBStop = { reason: error.message, utilityState: electricity };
            log("phase_b_electricity_acceptance_intercepted", { candidate: error.input, durableUtility });
            break;
          }
          if (!(error instanceof PhaseAAcceptanceStopError)) throw error;
          const project = durability.projectState();
          const durableUtility = project.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
            ? project.tranche.utilityExecution : null;
          if (!durableUtility || !shouldStopBeforeDirectCableExecution(durableUtility.utilities.electricity)) {
            throw new Error(`${error.message}: durable pre-cable acceptance invariant is not satisfied`);
          }
          utilityBootstrap = {
            state: durableUtility,
            serviceCertified: false,
            waiting: false,
            reason: error.message,
            providerInvocations: 0,
            legacyBrainInvocations: 0,
          };
          log("phase_a_acceptance_intercepted", { candidate: error.input, durableUtility });
          continue;
        }
        runner.recordUtilityExecution(utilityBootstrap.state);
        log("local_v2_greenfield_utility_bootstrap", utilityBootstrap);
        if (!utilityBootstrap.serviceCertified) {
          if (utilityBootstrap.waiting && utilityWaitingLoops < 60) {
            utilityWaitingLoops += 1;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          blocker = {
            class: "GREENFIELD_UTILITY_BOOTSTRAP",
            reason: utilityBootstrap.reason,
          };
          break;
        }
      }
      const result = await runner.tick();
      decisions += 1;
      if (result.proposal?.operation === "BUILD_ROAD") roadActions += 1;
      if (result.proposal?.operation === "ZONE_RESIDENTIAL") zoningActions += 1;
      log("local_v2_decision", { kind: result.kind, task: result.task?.kind ?? null, proposal: result.proposal?.operation ?? null, reason: result.reason, wake: result.wake ?? null, tranche: result.state.tranche.stage, progress: result.state.tranche.delivery_progress });
      if (result.kind === "LOCAL_SUCCESS") continue;
      if (result.kind === "LOCAL_WAITING") {
        waitingLoops += 1;
        if (waitingLoops > maximumWaitingLoops) {
          blocker = { class: "OBSERVATION_CAPABILITY_GAP", reason: `bounded waiting exhausted: ${result.reason}` };
          break;
        }
        if (result.wake?.condition === "WORLD_WRITE_IDLE") {
          const deadline = Date.now() + 30_000;
          let idle = false;
          while (Date.now() < deadline) {
            const state = record(await direct("cs2_game_state"));
            const nativeWorld = record(state.world);
            if (nativeWorld.nativeOperationBusy !== true && nativeWorld.nativeOperationStage === "Idle") {
              idle = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (!idle) {
            blocker = { class: "NATIVE_BUILD_SLOT_TIMEOUT", reason: "native build slot remained busy for 30 seconds" };
            break;
          }
          continue;
        }
        if (result.wake?.condition !== "SIMULATION_PROGRESS") {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const run = record(await direct("cs2_run_simulation", { hours: 2, speed: 4 }));
        const targetFrame = Number(run.targetFrame);
        const deadline = Date.now() + 120_000;
        let completed = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const state = record(await direct("cs2_game_state"));
          const simulation = record(state.simulation);
          const reachedTarget = Number.isFinite(targetFrame) && Number(simulation.frameIndex) >= targetFrame;
          if (simulation.paused === true || reachedTarget) {
            if (simulation.paused !== true) await direct("cs2_run_simulation", { cancel: true });
            completed = true;
            break;
          }
        }
        if (!completed) {
          await direct("cs2_run_simulation", { cancel: true });
          blocker = { class: "SIMULATION_PROGRESS_TIMEOUT", reason: "bounded simulation progression did not reach its target frame within 120 seconds" };
          break;
        }
        continue;
      }
      if (result.kind === "LOCAL_RECOVERABLE_FAILURE" && result.wake?.condition === "NEXT_OBSERVATION") {
        observationPolls += 1;
        if (observationPolls <= maximumWaitingLoops) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }
      blocker = { class: result.kind === "LOCAL_NO_APPLICABLE_SKILL" ? "METHOD_CAPABILITY_GAP" : result.kind === "LOCAL_WORLD_CHANGED" ? "DURABILITY" : result.kind === "LOCAL_RECOVERABLE_FAILURE" ? "OBSERVATION" : "OTHER", reason: result.reason };
      break;
    }
    if (phaseBStop) {
      const saveName = `AI市长V2-通电后标准存档-0915-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
      let saveStatus = record(await direct("cs2_save_status"));
      let requestId = typeof saveStatus.saveRequestId === "string" ? saveStatus.saveRequestId : null;
      if (saveStatus.state === undefined || saveStatus.state === "IDLE" || saveStatus.status === "COMPLETED") {
        const submitted = record(await direct("cs2_save_game", { name: saveName }));
        if (submitted.status !== "SUBMITTED" || typeof submitted.saveRequestId !== "string") {
          throw new Error(`POST_ELECTRICITY_SAVE_SUBMISSION_FAILED:${String(submitted.status ?? "UNKNOWN")}`);
        }
        requestId = submitted.saveRequestId;
      }
      let completed = false;
      for (let check = 0; check < 120; check += 1) {
        saveStatus = record(await direct("cs2_save_status", requestId ? { requestId } : {}));
        if (saveStatus.status === "COMPLETED" && saveStatus.durable === true &&
          saveStatus.worldId === activation.world.worldId && saveStatus.worldGeneration === activation.world.generation) {
          completed = true;
          break;
        }
        if (saveStatus.status === "FAILED" || saveStatus.status === "UNKNOWN") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!completed) throw new Error("POST_ELECTRICITY_SAVE_DURABILITY_UNKNOWN");
      const verifiedWorld = record(await direct("cs2_game_state"));
      const verifiedStatus = record(await direct("cs2_save_status", requestId ? { requestId } : {}));
      const verifiedNativeWorld = record(verifiedWorld.world);
      const verifiedCheckpoint = record(verifiedStatus.checkpoint);
      if (verifiedStatus.status !== "COMPLETED" || verifiedStatus.durable !== true ||
        verifiedNativeWorld.worldId !== activation.world.worldId || verifiedNativeWorld.generation !== activation.world.generation ||
        verifiedCheckpoint.nativeSessionGuid !== activation.world.nativeSessionGuid ||
        typeof verifiedCheckpoint.checkpointId !== "string" || typeof verifiedCheckpoint.saveMetadataAssetGuid !== "string" ||
        typeof verifiedCheckpoint.saveDataAssetGuid !== "string") {
        throw new Error("POST_ELECTRICITY_SAVE_CHECKPOINT_READBACK_MISMATCH");
      }
      const checkpointJournalPosition = durability.currentJournalPosition();
      const registeredCheckpoint = durability.recordCheckpoint(
        verifiedStatus as unknown as SaveCompletionReceipt, checkpointJournalPosition,
      );
      const registeredState = durability.snapshot();
      const persistedCheckpoint = registeredState.checkpoints.find((checkpoint) =>
        checkpoint.worldId === registeredCheckpoint.worldId && checkpoint.checkpointId === registeredCheckpoint.checkpointId);
      if (!persistedCheckpoint || persistedCheckpoint.journalPosition !== checkpointJournalPosition ||
        persistedCheckpoint.saveMetadataAssetGuid !== verifiedCheckpoint.saveMetadataAssetGuid ||
        persistedCheckpoint.saveDataAssetGuid !== verifiedCheckpoint.saveDataAssetGuid ||
        registeredState.active?.rollbackBoundaryId !== registeredCheckpoint.checkpointId ||
        registeredState.certifiedRollbackAnchor?.checkpointId === registeredCheckpoint.checkpointId) {
        throw new Error("POST_ELECTRICITY_CHECKPOINT_REGISTRATION_NOT_DURABLE");
      }
      postElectricitySave = { name: saveName, requestId, status: verifiedStatus, verifiedWorld,
        registeredCheckpoint, checkpointJournalPosition };
    }
    const afterSnapshot = record(await direct("cs2_mayor_snapshot"));
    const reportData = { ...report, battlefieldActuallyRan: true, runtimeMs: Date.now() - startedAt, simulationSpeed: 4, decisionsCompleted: decisions, roadActions, zoningActions, utilityBootstrap, utilityWaitingLoops, waitingLoops, observationPolls, phaseAStop, canonicalSave, phaseBStop, postElectricitySave, buildingsAdded: null, populationChange: null, trancheProgress: runner.snapshot().tranche.delivery_progress, visibleCityExpansion: roadActions + zoningActions > 0, firstBlocker: blocker, events, roadEvidence, calls, providerInvocations, legacyBrainInvocations, beforeSnapshot, afterSnapshot, verdict: phaseAStop ? "CANONICAL_PRE_CABLE_SAVED" : postElectricitySave ? "POST_ELECTRICITY_CANONICAL_SAVED" : blocker ? "FIRST_TRUE_BLOCKER" : "LOCAL_V2_BATTLEFIELD_PROGRESSING" };
    fs.writeFileSync(evidenceFile, JSON.stringify(reportData, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(reportData, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blockerClass = /durab|checkpoint|world identity|reconcil/i.test(message) ? "DURABILITY" : /tool|runner|harness/i.test(message) ? "RUNNER_WIRING" : "OTHER";
    const failure = { ...report, battlefieldActuallyRan: false, firstBlocker: message, blockerClass, exactUserActionRequired: message.includes("RELOAD_REQUIRED") ? "RELOAD the baseline checkpoint created by Local V2; its loaded checkpoint identity must then be confirmed before execution" : null, verdict: "FIRST_TRUE_BLOCKER", events, calls, providerInvocations, legacyBrainInvocations };
    fs.writeFileSync(evidenceFile, JSON.stringify(failure, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    throw error;
  } finally { await transport.close(); }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
