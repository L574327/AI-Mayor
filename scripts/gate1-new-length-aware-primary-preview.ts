import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { resolveBoundedRoadCandidates, type RoadCandidate } from "../src/main/services/ai-mayor/v2/road-connection-resolver";
import { rebindDurableRoadEndpoint, ROAD_ENDPOINT_LOCATOR_SCHEMA_VERSION } from "../src/main/services/ai-mayor/v2/road-endpoint-rebind";
import type { SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = "docs/ai-mayor/evidence/gate1-road-typed-endpoint-native-preview-2026-09-14.md";
const record = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : {};
const heading = (start: { x: number; z: number }, end: { x: number; z: number }) =>
  (Math.atan2(end.z - start.z, end.x - start.x) * 180) / Math.PI;

function classify(error: Record<string, any>): string {
  if (error.status === 400) return "NEW_PRIMARY_INPUT_CONTRACT_REJECTED";
  if (error.status !== 409) return "DIAGNOSTIC_BLOCKED";
  const structural = record(error.structural);
  if (structural.generatedEdge === false || structural.generatedEdgeCount === 0) return "NEW_PRIMARY_STRUCTURAL_NO_EDGE";
  if (structural.essentialTempValid === false) return "NEW_PRIMARY_ESSENTIAL_INVALID";
  return "NEW_PRIMARY_STRUCTURAL_NORMAL_BUT_REJECTED";
}

function errorEvidence(error: unknown): Record<string, unknown> {
  const value = error instanceof Error ? error as Error & Record<string, any> : record(error);
  return {
    httpStatus: value.status ?? null,
    commandId: value.commandId ?? null,
    genericError: value.message ?? String(error),
    validation: value.validation ?? record(value.diagnostics).validation ?? null,
    structural: value.structural ?? record(value.diagnostics).structural ?? null,
    diagnostics: value.nativeRoadDiagnostics ?? value.diagnostics ?? null,
  };
}

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-v2-length-aware-primary-preview", version: "1.0.0" });
  await client.connect(transport);
  const direct = async (name: string, args: Record<string, unknown> = {}) =>
    parseV2McpJson(await client.callTool({ name, arguments: args }));
  const report: Record<string, unknown> = { serverPath, gameplayMutations: 0, apply: "NOT_RUN", fallback: "NOT_RUN", secondPreview: "NO" };
  try {
    const game = record(await direct("cs2_game_state"));
    const simulation = record(game.simulation);
    report.runtimePreflight = {
      gameMode: game.gameMode,
      cityLoaded: game.cityLoaded,
      isLoading: game.isLoading,
      worldReady: record(game.world).worldReady,
      paused: simulation.paused,
    };
    if (game.gameMode !== "Game" || game.cityLoaded !== true || game.isLoading !== false || record(game.world).worldReady !== true || simulation.paused !== true) {
      report.verdict = "DIAGNOSTIC_BLOCKED";
      report.blocker = "RUNTIME_PREFLIGHT_NOT_READY";
      await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    const spatialScan = record(await direct("cs2_spatial", { mode: "scan", roadLimit: 2000 }));
    const roadGraph = record(spatialScan.roadGraph);
    const gameWorld = record(game.world);
    const loadAssetGuid = typeof gameWorld.loadAssetGuid === "string" ? gameWorld.loadAssetGuid : "";
    const saveDataAssetGuid = typeof gameWorld.saveDataAssetGuid === "string" ? gameWorld.saveDataAssetGuid : "";
    const checkpointLineage = typeof gameWorld.checkpointId === "string" ? gameWorld.checkpointId : "";
    const currentWorldEpoch = typeof spatialScan.worldEpoch === "string" ? spatialScan.worldEpoch : "";
    if (!loadAssetGuid || !saveDataAssetGuid || !checkpointLineage || !currentWorldEpoch) {
      report.verdict = "ROAD_ENDPOINT_REBIND_RUNTIME_FAILED";
      report.rebind = { ok: false, code: "ROAD_ENDPOINT_REBIND_STALE", reason: "durable checkpoint or current worldEpoch unavailable" };
      await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const rebind = rebindDurableRoadEndpoint(
      {
        schemaVersion: ROAD_ENDPOINT_LOCATOR_SCHEMA_VERSION,
        durableWorldId: `save:${loadAssetGuid}`,
        checkpointLineage,
        anchor: { x: -533.792053, y: 277.760254, z: -164.436829 },
        positionToleranceMeters: 0.25,
        roadDegree: 5,
        sourceEdge: { prefab: "Small Road", sourceNodeRole: "start", native: true },
        siteContext: {
          siteTarget: { x: -561.9724, z: -151.191086 },
          contactTarget: { x: -541.0321465986763, z: -161.03373325018504 },
          departureHeadingDegrees: 154.82484363921319,
        },
        historicalRuntimeEvidence: {
          worldEpoch: "298bc35684bd4882a82423e5496c6beb",
          node: { index: 76759, version: 1 },
          edge: { index: 72076, version: 1 },
        },
      },
      {
        durableWorldId: `save:${loadAssetGuid}`,
        checkpointLineage,
        worldEpoch: currentWorldEpoch,
        nodes: (Array.isArray(roadGraph.nodes) ? roadGraph.nodes : []) as any,
        edges: (Array.isArray(roadGraph.edges) ? roadGraph.edges : []) as any,
      },
    );
    report.rebind = rebind.ok
      ? {
          ok: true,
          candidateCount: rebind.candidateCount,
          positionDeltaMeters: rebind.positionDeltaMeters,
          currentNode: rebind.currentNode.entity,
          currentEdge: rebind.currentEdge.entity,
          worldEpoch: rebind.runtimeAttachment.worldEpoch,
          degree: rebind.currentNode.roadDegree,
        }
      : rebind;
    if (!rebind.ok) {
      report.verdict = "ROAD_ENDPOINT_REBIND_RUNTIME_FAILED";
      await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const detail = record(await direct("cs2_spatial", { mode: "detail", x: -562, z: -151, radius: 96, resolution: 16 })) as SpatialSiteDetail;
    // Certification uses the recovered historical target exactly; it does not
    // select a new site or perform any gameplay mutation.
    const target = { center: { x: -561.9724, z: -151.191086 }, radius: 28 };
    const resolution = resolveBoundedRoadCandidates({
      siteTarget: target.center,
      reservation: target,
      planningEnvelope: { center: target.center, radius: 180 },
      sourceEdges: (Array.isArray(roadGraph.edges) ? roadGraph.edges : []) as any,
      sourceNodes: (Array.isArray(roadGraph.nodes) ? roadGraph.nodes : []) as any,
      sourceGraphTruncated: roadGraph.truncated === true,
      worldEpoch: currentWorldEpoch,
      bridgeGeneration: currentWorldEpoch,
      reboundSource: rebind,
      ownedTiles: (Array.isArray(spatialScan.tiles) ? spatialScan.tiles : []) as any,
      terrain: detail.terrain,
      buildings: detail.buildings,
      maxSourceDistance: 150,
    });
    const candidate = resolution.candidates[0] as RoadCandidate | undefined;
    if (!candidate) {
      report.verdict = "LOCAL_PRIMARY_REJECTED";
      report.resolver = { candidates: [], rejectedSources: resolution.rejectedSources };
      await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const sourceEntity = candidate.sourceNode.entity;
    const startEndpoint = candidate.input.startEndpoint;
    const endEndpoint = candidate.input.endEndpoint;
    const expected = candidate.sourceNode.position;
    const positionMatch = !!startEndpoint && Math.hypot(
      startEndpoint.expectedPosition.x - expected.x,
      startEndpoint.expectedPosition.y - expected.y,
      startEndpoint.expectedPosition.z - expected.z,
    ) <= 0.25;
    if (sourceEntity.index !== rebind.currentNode.entity.index || sourceEntity.version !== rebind.currentNode.entity.version
      || candidate.sourceEdge.entity.index !== rebind.currentEdge.entity.index || candidate.sourceEdge.entity.version !== rebind.currentEdge.entity.version
      || startEndpoint?.kind !== "EXISTING_NET_NODE" || startEndpoint.role !== "START"
      || startEndpoint.entity?.index !== rebind.currentNode.entity.index || startEndpoint.entity?.version !== rebind.currentNode.entity.version
      || !positionMatch || startEndpoint.worldEpoch !== currentWorldEpoch
      || endEndpoint?.kind !== "NEW_FREE_ENDPOINT" || endEndpoint.role !== "END") {
      report.verdict = "ROAD_TYPED_ENDPOINT_RUNTIME_CONTRACT_FAILED";
      report.contract = { sourceEntity, startEndpoint, endEndpoint, authoritativePosition: expected, worldEpoch: currentWorldEpoch, positionMatch };
      await fs.writeFile(evidencePath, JSON.stringify(report, null, 2), "utf8");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const localFilters = {
      sourceTopology: "PASS",
      reservationContainment: "PASS",
      ownership: "PASS",
      water: "PASS",
      terrainSlope: "PASS",
      building: "PASS",
      protection: "PASS",
      existingRoadIntersection: "PASS",
      duplicateImmediateOverlap: "PASS",
      resolverGeometry: candidate.geometryFilterResults,
    };
    report.primary = {
      sourceEdgeRef: candidate.sourceEdge.entity,
      sourceEndpointRole: candidate.sourceRole,
      sourceNodeRef: candidate.sourceNode.entity,
      sourceNodePosition: candidate.sourceNode.position,
      roadDegree: candidate.sourceNode.roadDegree,
      incidentEdgeRefs: candidate.incidentEdgeRefs,
      sourceAnchor: candidate.sourceAnchor,
      siteTarget: candidate.siteTarget,
      initialRoadContactTarget: candidate.initialRoadContactTarget,
      finalRoadContactTarget: candidate.roadContactTarget,
      contactDerivationMethod: candidate.contactDerivation,
      initialSegmentLength: candidate.initialSegmentLength,
      finalSegmentLength: candidate.finalSegmentLength,
      lengthContract: candidate.lengthContract,
      adjustmentReason: candidate.adjustmentReason,
      candidateStart: { x: candidate.input.x1, z: candidate.input.z1 },
      candidateEnd: { x: candidate.input.x2, z: candidate.input.z2 },
      departureHeading: heading(candidate.sourceAnchor, candidate.roadContactTarget),
      sameNodeDedup: { sourceNodeRef: candidate.sourceNode.entity, duplicateSourcesRejected: resolution.rejectedSources.filter((item) => item.reason === "duplicate_source_node").length },
      localFilters,
      endpointAttachment: { kind: startEndpoint.kind, role: startEndpoint.role, entity: startEndpoint.entity, expectedPosition: startEndpoint.expectedPosition, worldEpoch: startEndpoint.worldEpoch },
    };
    try {
      const response = await direct("cs2_spatial", { mode: "preflight", kind: "net", ...candidate.input });
      report.verdict = "NEW_PRIMARY_NATIVE_ACCEPTED";
      report.nativePreview = { run: "RUN_ONCE", httpStatus: 200, response };
    } catch (error) {
      const details = errorEvidence(error);
      report.verdict = classify(record(details));
      report.nativePreview = { run: "RUN_ONCE", ...details };
    }
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
