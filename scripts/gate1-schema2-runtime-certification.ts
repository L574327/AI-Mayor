import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts } from "../src/main/services/ai-mayor/main-adapters";
import { parseV2McpJson, createV2FoundationPorts } from "../src/main/services/ai-mayor/v2/main-adapter";
import {
  createGate1FoundationBoundary,
  createGate1VerticalSlice,
  createMemoryGate1StateStorage,
  type Gate1Observation,
  type Gate1State,
  planStarterResidentialIntent,
} from "../src/main/services/ai-mayor/v2/gate1";
import { classifyNativeRoadPreviewFailure, nativeRoadQuoteFromPreview } from "../src/main/services/ai-mayor/v2/runtime-road-caller";
import { resolveBoundedRoadCandidates, type RoadCandidate } from "../src/main/services/ai-mayor/v2/road-connection-resolver";
import { stableRoadInput } from "../src/main/services/ai-mayor/v2/finance";
import type { ZoningIntent } from "../src/main/services/ai-mayor/v2/foundation";
import type { SpatialEntityRef, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = "docs/ai-mayor/evidence/gate1-schema2-runtime-certification-2026-09-13.json";
const record = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : {};
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const pointInside = (point: { x: number; z: number }, scope: { center: { x: number; z: number }; radius: number }) =>
  distance(point, scope.center) <= scope.radius;
const entityKey = (entity: SpatialEntityRef) => `${entity.index}:${entity.version}`;

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-v2-gate1-schema2-certification", version: "1.0.0" });
  await client.connect(transport);
  const calls: Array<{ name: string; args: Record<string, unknown>; response?: unknown }> = [];
  const direct = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const value = parseV2McpJson(response);
    calls.push({ name, args, response: value });
    return value;
  };
  const manager = {
    legacyList: async () => {
      const listed = await client.listTools();
      return { tools: listed.tools.map((tool) => ({ name: `live--${tool.name}` })) };
    },
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const response = await client.callTool({ name, arguments: args });
      const value = parseV2McpJson(response);
      calls.push({ name, args, response: value });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };
  const report: Record<string, unknown> = { serverPath, calls, gameplayMutations: [] };
  try {
    const game = record(await direct("cs2_game_state"));
    const simulation = record(game.simulation);
    report.preflight = {
      gameMode: game.gameMode,
      cityLoaded: game.cityLoaded,
      isLoading: game.isLoading,
      worldReady: record(game.world).worldReady,
      paused: simulation.paused,
      worldId: record(game.world).worldId,
      generation: record(game.world).generation,
    };
    if (
      game.gameMode !== "Game" ||
      game.cityLoaded !== true ||
      game.isLoading !== false ||
      record(game.world).worldReady !== true ||
      simulation.paused !== true
    ) throw new Error("RUNTIME_PREFLIGHT_NOT_READY");
    const aggregateBefore = record(await direct("cs2_save_status"));
    report.initialSaveStatus = aggregateBefore;
    if (aggregateBefore.state !== "IDLE") throw new Error(`SAVE_NOT_IDLE:${String(aggregateBefore.state)}`);

    const saveStore = new Map<string, unknown>();
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
      durableStateStorage: {
        load: () => saveStore.get("durable"),
        save: (value) => saveStore.set("durable", structuredClone(value)),
      },
    });
    const checkpointName = `AI Mayor V2 Gate1 Schema2 Runtime Certification ${new Date().toISOString()}`;
    await ports.save(checkpointName);
    const saveCall = calls.find((call) => call.name === "cs2_save_game");
    const aggregateAfterSave = record(await direct("cs2_save_status"));
    report.disposableCheckpoint = {
      name: checkpointName,
      requestId: record(saveCall?.response).saveRequestId ?? null,
      submission: saveCall?.response ?? null,
      durableState: saveStore.get("durable") ?? null,
      finalAggregate: aggregateAfterSave,
    };
    if (aggregateAfterSave.state !== "IDLE") throw new Error("SAVE_DID_NOT_RETURN_IDLE");

    const spatialScan = record(await direct("cs2_spatial", { mode: "scan", roadLimit: 2000 }));
    const roadGraph = record(spatialScan.roadGraph);
    const edges = Array.isArray(roadGraph.edges) ? roadGraph.edges : [];
    const nodes = Array.isArray(roadGraph.nodes) ? roadGraph.nodes : [];
    const ownedTiles = Array.isArray(spatialScan.tiles) ? spatialScan.tiles : [];
    const detail = record(await direct("cs2_spatial", { mode: "detail", x: -562, z: -151, radius: 96, resolution: 16 })) as SpatialSiteDetail;
    const legalCells = detail.zoningCells.filter(
      (cell) => cell.visible && cell.roadside && !cell.occupied && !cell.blocked && !cell.overridden && cell.zoneCategory === "none",
    );
    if (legalCells.length === 0) throw new Error("NO_LEGAL_STARTER_SITE");
    const selectedCell = legalCells[0];
    const target = { center: { x: selectedCell.position.x, z: selectedCell.position.z }, radius: 28 };
    const roadResolution = resolveBoundedRoadCandidates({
      siteTarget: target.center,
      reservation: target,
      planningEnvelope: { center: target.center, radius: 180 },
      sourceEdges: edges as unknown as import("../src/main/services/ai-mayor/spatial/types").SpatialRoadEdge[],
      sourceNodes: nodes as unknown as import("../src/main/services/ai-mayor/spatial/types").SpatialRoadNode[],
      sourceGraphTruncated: roadGraph.truncated === true,
      worldEpoch: typeof spatialScan.worldEpoch === "string" ? spatialScan.worldEpoch : undefined,
      bridgeGeneration: typeof spatialScan.worldEpoch === "string" ? spatialScan.worldEpoch : undefined,
      ownedTiles: ownedTiles as unknown as import("../src/main/services/ai-mayor/spatial/types").SpatialTile[],
      terrain: detail.terrain,
      buildings: detail.buildings,
      maxSourceDistance: 150,
    });
    if (roadResolution.candidates.length === 0) throw new Error("NO_LEGAL_ROAD_GEOMETRY");
    const roadEvidence: Array<Record<string, unknown>> = [];
    let activeRoadCandidate: RoadCandidate = roadResolution.candidates[0];
    const siteCandidates = [{ id: "runtime-cell", target, score: 1, blocked: false }];
    const initial = {
      intentId: `intent:gate1-schema2:${Date.now()}`,
      targetResidents: 12,
      maximumBudget: 25000,
      planningEnvelope: { center: target.center, radius: 180 },
      siteCandidates,
      maximumWaitObservations: 3,
    };
    const state = planStarterResidentialIntent(initial);
    const foundation = createV2FoundationPorts({ getToolsManager: () => manager, durableStateStorage: undefined });
    const boundary = createGate1FoundationBoundary(foundation, {
      road: async (proposal) => {
        const candidate = roadResolution.candidates[proposal.methodVariant === "PRIMARY" ? 0 : 1];
        if (!candidate) throw new Error("NO_BOUNDED_ROAD_FALLBACK");
        activeRoadCandidate = candidate;
        const roadInput = candidate.input;
        const evidence: Record<string, unknown> = {
          variant: candidate.variant,
          candidateIndex: proposal.methodVariant === "PRIMARY" ? 0 : 1,
          sourceEdge: candidate.sourceEdge.entity,
          sourceRole: candidate.sourceRole,
          sourceNode: candidate.sourceNode.entity,
          sourceAnchor: candidate.sourceAnchor,
          siteTarget: candidate.siteTarget,
          initialRoadContactTarget: candidate.initialRoadContactTarget,
          roadContactTarget: candidate.roadContactTarget,
          contactDerivation: candidate.contactDerivation,
          initialSegmentLength: candidate.initialSegmentLength,
          finalSegmentLength: candidate.finalSegmentLength,
          lengthContract: candidate.lengthContract,
          adjustmentReason: candidate.adjustmentReason,
          incidentEdgeRefs: candidate.incidentEdgeRefs,
          sourceAnchorEvidence: candidate.sourceAnchorEvidence,
          geometryFilterResults: candidate.geometryFilterResults,
          geometry: roadInput,
        };
        roadEvidence.push(evidence);
        let preview: unknown;
        try {
          preview = await direct("cs2_spatial", { mode: "preflight", kind: "net", ...roadInput });
          evidence.nativePreview = { status: "VALID", response: preview };
        } catch (error) {
          evidence.nativePreview = {
            status: classifyNativeRoadPreviewFailure(error),
            error: error instanceof Error ? error.message : String(error),
          };
          throw error;
        }
        const quote = nativeRoadQuoteFromPreview(preview, roadInput, new Date());
        return {
          proposal: {
            identity: {
              proposalId: quote.proposalId,
              actionFamily: "ROAD",
              exactInput: stableRoadInput(roadInput),
              runtimeEpoch: quote.runtimeEpoch,
              frame: quote.frame,
              validationState: "VALID",
            },
            quoteId: quote.quoteId,
            fingerprint: stableRoadInput(roadInput),
            input: roadInput,
            owner: { ownerType: "TASK", ownerId: proposal.taskId },
          },
          quote,
          authorizedMaxSpend: Math.max(quote.signedAmount, 1) * 1.25,
          treasurySafetyReserve: 0,
        };
      },
      zoning: async (proposal) => {
        const envelope = await foundation.observation.capture({ spatialDetail: { ...target, resolution: 16 } });
        const currentDetail = record(envelope.sources.spatialDetail.data) as SpatialSiteDetail;
        const authorizedCells = currentDetail.zoningCells
          .filter((cell) => pointInside(cell.position, target) && cell.visible && cell.roadside && !cell.occupied && !cell.blocked && !cell.overridden && cell.zoneCategory === "none")
          .map((cell) => ({
            block: cell.block,
            cellIndex: cell.index,
            expected: {
              zoneType: cell.zoneType,
              zoneCategory: cell.zoneCategory,
              visible: cell.visible,
              roadside: cell.roadside,
              occupied: cell.occupied,
              blocked: cell.blocked,
              overridden: cell.overridden,
            },
          }));
        if (authorizedCells.length === 0) throw new Error("NO_EXACT_RESIDENTIAL_CELLS_AFTER_ROAD");
        const zoning: ZoningIntent = {
          intentId: proposal.id,
          scope: {
            owner: { ownerType: "TASK", ownerId: proposal.taskId },
            actionFamily: "ZONING",
            allowedCells: authorizedCells,
            spatialEnvelope: target,
            maximumAffectedArea: { maxCellCount: authorizedCells.length, maxRadiusMeters: target.radius },
            budget: { maximumCost: null, currency: "GAME_MONEY", status: "PLACEHOLDER" },
            observationPrecondition: { observationId: envelope.observationId, runtimeEpoch: envelope.runtimeEpoch, coherence: envelope.coherence },
            intendedEffect: { zoneCategory: "residential" },
            expiresAt: new Date(Date.now() + 2000).toISOString(),
          },
          zoneCategory: "residential",
          nativeZone: "EU Residential Low",
          authorizedCells,
          spatialEnvelope: { ...target, resolution: 16 },
        };
        return { intent: zoning, baseline: envelope };
      },
    });
    const runtime = createGate1VerticalSlice({ storage: createMemoryGate1StateStorage(state), boundary });
    const events: unknown[] = [];
    const tick = async (observation?: Gate1Observation) => {
      const result = await runtime.tick(observation);
      events.push({ task: result.task, proposal: result.proposal, outcome: result.outcome, state: result.state });
      return result;
    };
    const observationFor = async (current: Gate1State): Promise<Gate1Observation> => {
      const envelope = await foundation.observation.capture({ spatialDetail: { ...target, radius: 96, resolution: 16 } });
      const site = record(envelope.sources.spatialDetail.data) as SpatialSiteDetail;
      const buildings = site.buildings.filter(
        (building) => building.prefab.toLowerCase().includes("residential") && pointInside(building.position, current.tranche.target),
      );
      const refs = buildings.map((building) => building.entity);
      const utilityResults = [];
      const accessResults = [];
      const residents: SpatialEntityRef[] = [];
      let actualResidents = 0;
      for (const building of buildings) {
        const utility = await foundation.utilityService.observe({ buildingRef: building.entity });
        utilityResults.push({ ref: building.entity, result: utility });
        const access = await foundation.targetAccess.observe({ buildingRef: building.entity });
        accessResults.push({ ref: building.entity, result: access });
        const route = await foundation.routeQuery.submit({
          queryId: `${current.tranche.id}:route:${entityKey(building.entity)}`,
          buildingRef: building.entity,
          targetAnchor: { lane: activeRoadCandidate.sourceEdge.entity, delta: 0.5 },
        });
        if (route.state !== "ROUTABLE") accessResults[accessResults.length - 1].route = route;
        else accessResults[accessResults.length - 1].route = route;
        const inspected = record(await direct("cs2_inspect", building.entity));
        const renters = Array.isArray(inspected.renters) ? inspected.renters : [];
        const count = renters.reduce((sum: number, renter: any) => sum + Number(renter.citizens ?? renter.citizenCount ?? 0), 0);
        if (count > 0) residents.push(building.entity);
        actualResidents += count;
      }
      const utilityPass = refs.length > 0 && utilityResults.every((item: any) => item.result.electricity.status === "SERVED" && item.result.water.status === "SERVED" && item.result.sewage.status === "SERVED");
      const accessPass = refs.length > 0 && accessResults.every((item: any) => item.route?.state === "ROUTABLE");
      return {
        observationId: envelope.observationId,
        runtimeEpoch: envelope.runtimeEpoch,
        coherence: envelope.coherence,
        capturedAt: envelope.readEndedAt,
        trancheId: current.tranche.id,
        access: { value: accessPass ? "PASS" : refs.length > 0 ? "FAIL" : "UNKNOWN", provenance: "DERIVED" },
        productiveFrontage: { value: refs.length > 0 && site.zoningCells.some((cell) => pointInside(cell.position, current.tranche.target) && cell.roadside) ? "PASS" : "UNKNOWN", provenance: "DERIVED" },
        utilities: { value: utilityPass ? "PASS" : refs.length > 0 ? "FAIL" : "UNKNOWN", provenance: "DERIVED", evidenceKind: "ACTUAL_CONSUMER_SERVICE", buildingRefs: refs },
        residentialBuildings: { value: refs, provenance: "OBSERVED" },
        actualResidents: { value: actualResidents, provenance: "OBSERVED" },
        occupiedResidentialBuildings: { value: residents, provenance: "OBSERVED" },
      } satisfies Gate1Observation;
    };
    await tick();
    await tick();
    await tick();
    let current = runtime.snapshot();
    const windows: unknown[] = [];
    for (let iteration = 0; iteration < 3 && current.tranche.stage === "ZONED_WAITING_FOR_BUILDING"; iteration += 1) {
      const before = record(await direct("cs2_game_state"));
      await tick(await observationFor(current));
      current = runtime.snapshot();
      if (current.tranche.stage === "ZONED_WAITING_FOR_BUILDING") {
        await direct("cs2_run_simulation", { hours: 2, speed: 4 });
        let after = record(await direct("cs2_game_state"));
        for (let poll = 0; poll < 60 && Number(record(after.simulation).frameIndex) <= Number(record(before.simulation).frameIndex); poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          after = record(await direct("cs2_game_state"));
        }
        windows.push({ iteration: iteration + 1, start: record(before.simulation).gameDateTime, end: record(after.simulation).gameDateTime, speed: 4, hours: 2, startFrame: record(before.simulation).frameIndex, endFrame: record(after.simulation).frameIndex });
        current = runtime.snapshot();
        await tick(await observationFor(current));
        current = runtime.snapshot();
      }
      if (current.tranche.stage === "BUILDING_OBSERVED") {
        await tick(await observationFor(current));
        current = runtime.snapshot();
      }
    }
    report.intent = current.intent;
    report.project = current.project;
    report.district = current.district;
    report.tranche = current.tranche;
    report.events = events;
    report.roadResolution = {
      candidates: roadResolution.candidates,
      rejectedSources: roadResolution.rejectedSources,
    };
    report.roadEvidence = roadEvidence;
    report.simulationWindows = windows;
    report.finalState = current;
    report.finalSaveStatus = await direct("cs2_save_status");
    await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
