/** Read-only reconciliation of the single Water Phase 7 access-road command. */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const liveStorePath = process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const evidencePath = "docs/ai-mayor/evidence/water-phase7-post-submit-readback.json";
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
function exactCourseCoverage(action: Record<string, unknown>, roads: Record<string, unknown>[], tolerance = 1) {
  const start = { x: Number(action.x1), z: Number(action.z1) };
  const end = { x: Number(action.x2), z: Number(action.z2) };
  const dx = end.x - start.x; const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const along = (p: { x: number; z: number }) => ((p.x - start.x) * dx + (p.z - start.z) * dz) / length;
  const pointAt = (t: number) => ({ x: start.x + dx * t / length, z: start.z + dz * t / length });
  const matches = roads.filter((edge) => {
    if (edge.prefab !== action.prefab) return false;
    const a = record(edge.start); const b = record(edge.end);
    const p = { x: Number(a.x), z: Number(a.z) }; const q = { x: Number(b.x), z: Number(b.z) };
    const ta = along(p); const tb = along(q);
    return ta >= -tolerance && tb >= -tolerance && ta <= length + tolerance && tb <= length + tolerance &&
      distance(p, pointAt(Math.max(0, Math.min(length, ta)))) <= tolerance &&
      distance(q, pointAt(Math.max(0, Math.min(length, tb)))) <= tolerance;
  }).map((edge) => {
    const a = record(edge.start); const b = record(edge.end);
    const ta = along({ x: Number(a.x), z: Number(a.z) }); const tb = along({ x: Number(b.x), z: Number(b.z) });
    return { edge, low: Math.min(ta, tb), high: Math.max(ta, tb) };
  }).sort((a, b) => a.low - b.low || a.high - b.high);
  let cursor = 0;
  const chosen: Record<string, unknown>[] = [];
  for (const candidate of matches) {
    if (candidate.low > cursor + tolerance || candidate.high <= cursor + tolerance / 10) continue;
    chosen.push(candidate.edge);
    cursor = candidate.high;
    if (cursor >= length - tolerance) break;
  }
  return {
    matched: length > 0 && cursor >= length - tolerance && chosen.length > 0,
    tolerance,
    matchedEdges: chosen.map((edge) => ({ entity: edge.entity ?? null, prefab: edge.prefab, start: edge.start, end: edge.end })),
  };
}

async function main() {
  const hashBefore = hash(liveStorePath);
  const envelope = JSON.parse(fs.readFileSync(liveStorePath, "utf8")) as Record<string, unknown>;
  const durable = record(envelope.aiMayorV2DurableState);
  const commands: Record<string, unknown>[] = Array.isArray(durable.commands) ? durable.commands.map(record) : [];
  const projectState = record(durable.projectState);
  const state = record(record(projectState.tranche).utilityExecution);
  const water = record(record(state.utilities).water);
  const repair = (Array.isArray(water.candidateLedger) ? water.candidateLedger.map(record) : [])
    .find((candidate) => candidate.repair === "FACILITY_ACCESS_ROAD");
  const command = commands.find((entry) => {
    const scope = record(record(entry.record).authorizedScope);
    const input = String(scope.exactInput ?? "");
    return scope.utilityKind === "water" && input.includes("Small Road");
  });
  if (!repair || !command) throw new Error("WATER_PHASE7_REPAIR_OR_COMMAND_MISSING_FROM_DURABLE_STORE");
  const actions = JSON.parse(String(record(command.record).authorizedScope && record(record(command.record).authorizedScope).exactInput)) as Array<Record<string, unknown>>;
  const action = actions.find((item) => item.type === "build_road" && item.prefab === "Small Road");
  if (!action) throw new Error("WATER_PHASE7_SUBMITTED_ROAD_ACTION_MISSING");
  const authorizedScope = record(record(command.record).authorizedScope);
  const nativeCompletionEvidence = record(record(command.record).nativeCompletionEvidence);
  const courseSplitDiagnostics = record(nativeCompletionEvidence.courseSplitDiagnostics);
  const facility = record(water.facility);
  const entity = record(facility.entity);
  const envelopeScope = record(water.scope);
  const spatial = record(envelopeScope.spatialEnvelope);
  const center = record(spatial.center);

  const client = new Client({ name: "5ire-water-phase7-post-submit-readback", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: string[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push(name);
    const response = record(await client.callTool({ name, arguments: args }));
    const content = Array.isArray(response.content) ? response.content.map(record) : [];
    const text = content.find((item) => typeof item.text === "string")?.text;
    try { return typeof text === "string" ? JSON.parse(text) : {}; } catch { return { raw: text }; }
  };
  try {
    const spatialDetail = record(await tool("cs2_spatial", {
      mode: "detail", x: Number(center.x), z: Number(center.z), radius: Math.max(64, Number(spatial.radius)), resolution: 128,
    }));
    const allRoads = record(await tool("cs2_list_roads", { query: "Small Road", limit: 500 }));
    const allListedRoads = Array.isArray(allRoads.roads) ? allRoads.roads.map(record) : [];
    const exactSmallRoadCoverage = exactCourseCoverage(action, allListedRoads);
    const rawEdges = record(spatialDetail.roadGraph).edges;
    const edges: Record<string, unknown>[] = Array.isArray(rawEdges) ? rawEdges.map(record) : [];
    const matchedEntityKeys = new Set(exactSmallRoadCoverage.matchedEdges.map((edge) => {
      const ref = record(edge.entity); return `${String(ref.index)}:${String(ref.version)}`;
    }));
    const roadGraphCourseEdges = edges.filter((edge) => {
      const ref = record(edge.entity); return matchedEntityKeys.has(`${String(ref.index)}:${String(ref.version)}`);
    });
    const courseNodeKeys = new Set(roadGraphCourseEdges.flatMap((edge) => [edge.startNode, edge.endNode]
      .map(record).filter((node) => Number.isInteger(node.index) && Number.isInteger(node.version))
      .map((node) => `${String(node.index)}:${String(node.version)}`)));
    const incidentRoadGraphEdges = edges.filter((edge) => {
      const startNode = record(edge.startNode); const endNode = record(edge.endNode);
      return courseNodeKeys.has(`${String(startNode.index)}:${String(startNode.version)}`) ||
        courseNodeKeys.has(`${String(endNode.index)}:${String(endNode.version)}`);
    });
    const start = { x: Number(action.x1), z: Number(action.z1) };
    const end = { x: Number(action.x2), z: Number(action.z2) };
    const matchingEdges = edges.filter((edge) => {
      if (edge.prefab !== "Small Road" || edge.deleted === true) return false;
      const a = record(edge.start); const b = record(edge.end);
      return (distance(start, { x: Number(a.x), z: Number(a.z) }) <= 0.5 && distance(end, { x: Number(b.x), z: Number(b.z) }) <= 0.5) ||
        (distance(start, { x: Number(b.x), z: Number(b.z) }) <= 0.5 && distance(end, { x: Number(a.x), z: Number(a.z) }) <= 0.5);
    });
    const access = record(await tool("cs2_building_access", { index: Number(entity.index), version: Number(entity.version) }));
    const notifications = record(await tool("cs2_notifications", { limit: 200 }));
    const notificationItems = Array.isArray(notifications.notifications) ? notifications.notifications.map(record) : [];
    const facilityWarnings = notificationItems.filter((item) => Number(record(item.target).index) === Number(entity.index));
    const connectors = record(await tool("cs2_utility_connectors", { index: Number(entity.index), version: Number(entity.version) }));
    const electricity = record(record(connectors.consumerService).electricity);
    const city = record(await tool("cs2_city_services", {}));
    const waterService = record(city.water);
    const report = {
      mode: "READ_ONLY_WATER_PHASE7_POST_SUBMIT_RECONCILIATION",
      nativeAttemptCount: commands.filter((entry) => {
        const scope = record(record(entry.record).authorizedScope);
        return scope.utilityKind === "water" && String(scope.exactInput ?? "").includes("Small Road");
      }).length,
      nativeMutationCount: 0,
      forcedSaveCount: 0,
      commandId: record(command.record).commandId ?? null,
      commandStatus: record(command.record).status ?? null,
      commandHistory: record(command.record).statusHistory ?? [],
      exactInput: authorizedScope.exactInput ?? null,
      authorizedPlanRevision: authorizedScope.topologyRevision ?? null,
      nativeResultSummary: record(command.record).nativeResultSummary ?? null,
      nativeCompletionSummary: {
        status: nativeCompletionEvidence.status ?? null,
        postSplitCourses: courseSplitDiagnostics.postSplitCourses ?? null,
        postSplitCoursesTruncated: courseSplitDiagnostics.postSplitCoursesTruncated ?? null,
        ticketLifecycle: courseSplitDiagnostics.ticketLifecycle ?? null,
        generateEdgesDiagnosticRuntime: courseSplitDiagnostics.generateEdgesDiagnosticRuntime ?? null,
        generateEdgesCaptureRuntime: courseSplitDiagnostics.generateEdgesCaptureRuntime ?? null,
        creation: courseSplitDiagnostics.creation ?? null,
        preSplitEnd: courseSplitDiagnostics.preSplitEnd ?? null,
        predicateTrace: courseSplitDiagnostics.predicateTrace ?? null,
      },
      candidateStatus: repair.ledgerState ?? null,
      candidateCommandId: repair.commandId ?? null,
      action,
      singleEdgeMatchingWholeCourse: matchingEdges.map((edge) => ({ entity: edge.entity, prefab: edge.prefab, start: edge.start, end: edge.end })),
      matchingSmallRoadEffects: exactSmallRoadCoverage.matchedEdges,
      exactCourseCoverage: exactSmallRoadCoverage,
      roadGraphCourseEdges: roadGraphCourseEdges.map((edge) => ({
        entity: edge.entity ?? null, prefab: edge.prefab ?? null, start: edge.start ?? null, end: edge.end ?? null,
        startNode: edge.startNode ?? null, endNode: edge.endNode ?? null,
      })),
      roadGraphEdgesIncidentToCourseNodes: incidentRoadGraphEdges.map((edge) => ({
        entity: edge.entity ?? null, prefab: edge.prefab ?? null, start: edge.start ?? null, end: edge.end ?? null,
        startNode: edge.startNode ?? null, endNode: edge.endNode ?? null,
      })),
      authoritativeSmallRoadEntityList: {
        source: "cs2_list_roads",
        query: "Small Road",
        totalMatches: allRoads.totalMatches ?? null,
        returned: allRoads.returned ?? null,
        complete: Number.isInteger(allRoads.totalMatches) && Number(allRoads.totalMatches) === allListedRoads.length &&
          Number(allRoads.returned) === allListedRoads.length && allRoads.truncated !== true && allRoads.hasMore !== true,
        matchingPrefabEntities: allListedRoads.filter((edge) => edge.prefab === "Small Road").map((edge) => ({
          entity: edge.entity ?? null, prefab: edge.prefab ?? null, start: edge.start ?? null, end: edge.end ?? null,
        })),
      },
      facilityRoadAttachment: record(access.roadAttachment),
      facilityWarnings: facilityWarnings.map((item) => item.type),
      electricity: { connected: electricity.connected ?? null, fulfilledConsumption: electricity.fulfilledConsumption ?? null, wantedConsumption: electricity.wantedConsumption ?? null },
      waterService: { freshCapacity: waterService.freshCapacity ?? null, freshConsumption: waterService.freshConsumption ?? null },
      liveStoreUnchanged: false,
      callLog: calls,
    };
    const hashAfter = hash(liveStorePath);
    report.liveStoreUnchanged = hashBefore === hashAfter;
    await fsPromises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fsPromises.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
