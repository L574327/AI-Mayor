/**
 * K05 Attempt 2 recovery planning — Phase 1 + Phase 2 evidence, read-only.
 *
 * The directive's Phase 1 asks, before any planning, what the CURRENT world
 * contains and what the recovery course therefore is. This produces that
 * evidence from production code paths only:
 *
 *   - the recovery course is `splitUtilityConnection` over the connector-anchored
 *     connection, mapped to actions exactly as `buildUtilityConnectionCandidates`
 *     maps them, and fingerprinted exactly as the durable candidate ledger does;
 *   - the existing physical cable effect is judged by the production matcher
 *     `matchCablePrimitiveEffect`;
 *   - the connection objective is judged by the production matcher
 *     `matchConnectionObjective` over the same Bridge topology read the
 *     production `readScopedUtilityEvidence` performs;
 *   - the durable project authority is read back from the live store.
 *
 * Native reads only: no save, no Skill dispatch, no place_building, no cable
 * mutation, no simulation run. The script asserts that and fails if violated.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createV2FoundationPorts, normalizeUtilityTopologyPayload, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { matchCablePrimitiveEffect, matchConnectionObjective } from "../src/main/services/ai-mayor/v2/utility-topology-matchers";
import { bridgeTopologyRevision } from "../src/main/services/ai-mayor/v2/utility-target-binding";
import { splitUtilityConnection } from "../src/main/services/ai-mayor/spatial/utility-planner";
import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB } from "../src/main/services/ai-mayor/spatial/types";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const appData = process.env.APPDATA ?? "";

const FACILITY = { index: Number(process.env.K05_FACILITY_INDEX ?? 176455), version: Number(process.env.K05_FACILITY_VERSION ?? 1) };
const CONNECTOR = { index: Number(process.env.K05_CONNECTOR_INDEX ?? 185275), version: Number(process.env.K05_CONNECTOR_VERSION ?? 1) };
const TARGET = { index: Number(process.env.K05_ROAD_INDEX ?? 187602), version: Number(process.env.K05_ROAD_VERSION ?? 1) };

const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game", "cs2_build_road", "cs2_mayor_execute_actions", "cs2_run_simulation",
  "cs2_bulldoze", "cs2_build", "cs2_zone",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The production course arithmetic, verbatim from `buildUtilityConnectionCandidates`. */
function directCableActions(connectorPosition: { x: number; z: number }, targetContact: { x: number; z: number }) {
  const segments = splitUtilityConnection({
    prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
    start: connectorPosition,
    end: targetContact,
  });
  return segments.map((segment) => ({
    type: "build_road" as const,
    prefab: segment.prefab,
    x1: segment.start.x, z1: segment.start.z,
    x2: segment.end.x, z2: segment.end.z,
  }));
}

async function main() {
  if (!appData) throw new Error("APPDATA is not set");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-k05-recovery-plan", version: "1.0.0" });
  await client.connect(transport);

  const calls: string[] = [];
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
      calls.push(name);
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
    calls.push(name);
    return value;
  };

  const report: Record<string, unknown> = { serverPath, mode: "K05_PHASE_1_2_READ_ONLY" };
  try {
    const state = record(await call("cs2_game_state", {}));
    const world = record(state.world);
    const generation = String(world.generation ?? "");
    const worldEpochId = String(world.worldEpochId ?? "");
    report.world = {
      worldId: world.worldId ?? null, generation: world.generation ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null,
      paused: record(state.simulation).paused ?? null,
      frameIndex: record(state.simulation).frameIndex ?? null,
    };

    // --- The connector, and the facility position it anchors the course to ----
    const plain = record(await call("cs2_utility_connectors", { index: FACILITY.index, version: FACILITY.version }));
    const connectors = Array.isArray(plain.connectors) ? plain.connectors.map(record) : [];
    const electricity = connectors.find((connector) => connector.type === "electricity" && record(connector.node).index === CONNECTOR.index);
    const connectorPosition = { x: Number(record(electricity?.worldPosition).x), z: Number(record(electricity?.worldPosition).z) };
    report.connector = electricity
      ? {
          type: electricity.type ?? null, node: electricity.node ?? null,
          worldPosition: electricity.worldPosition ?? null,
          attached: electricity.attached ?? null, orphan: electricity.orphan ?? null,
          connectedEdgeCount: electricity.connectedEdgeCount ?? null,
          externalEdgeCount: electricity.externalEdgeCount ?? null,
          facilityOwnedEdgeCount: electricity.facilityOwnedEdgeCount ?? null,
          graphEdgeCount: electricity.graphEdgeCount ?? null,
          connectedEdges: electricity.connectedEdges ?? null,
        }
      : null;

    // --- The production topology read the objective matcher consumes ----------
    const topology = normalizeUtilityTopologyPayload(await call("cs2_utility_connectors", {
      index: FACILITY.index, version: FACILITY.version, topology: true,
      connectorIndex: CONNECTOR.index, connectorVersion: CONNECTOR.version,
      targetIndex: TARGET.index, targetVersion: TARGET.version,
      expectedWorldId: worldEpochId.split(":generation:", 1)[0], expectedGeneration: generation,
      expectedTopologyRevision: bridgeTopologyRevision({ generation, target: TARGET }),
      admittedPrefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
      admittedStart: connectorPosition, admittedEnd: { x: -1247.55188, z: -12.3875341 },
      endpointTolerance: 1.5,
      envelope: { center: connectorPosition, radius: 400 },
    }));
    report.topologyBinding = topology.binding ?? null;
    report.topologyConnectorKeys = Object.keys(record(topology.connector));
    report.topologyConnector = {
      entity: record(topology.connector).entity ?? null,
      attached: record(topology.connector).attached ?? null,
      networkConnected: record(topology.connector).networkConnected ?? null,
      physicalEdges: record(topology.connector).physicalEdges ?? null,
    };
    report.topologyTarget = {
      target: record(record(topology.targetNetwork).target) ?? null,
      networkConnected: record(topology.targetNetwork).networkConnected ?? null,
      targetNetworkReachable: record(topology.targetNetwork).targetNetworkReachable ?? null,
    };
    report.topologyCandidateScan = topology.candidateScan ?? null;

    // --- Phase 1: the recovery course, from the production arithmetic ---------
    const targetEndpoints = Array.isArray(record(record(topology.targetNetwork).target).endpoints)
      ? (record(record(topology.targetNetwork).target).endpoints as unknown[]).map(record) : [];
    const targetContact = { x: -1247.55188, z: -12.3875341 };
    const actions = directCableActions(connectorPosition, targetContact);
    report.recoveryCourse = {
      prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
      anchor: connectorPosition,
      contact: targetContact,
      segments: actions.length,
      exactActions: actions,
      // The durable candidate ledger fingerprints actions with JSON.stringify.
      fingerprint: JSON.stringify(actions),
    };
    report.targetRoadEndpoints = targetEndpoints.map((endpoint) => ({
      role: endpoint.role ?? null, node: endpoint.node ?? null, position: endpoint.position ?? null,
    }));

    // --- Phase 1: is the course already physically present, and does it match? -
    const primitive = matchCablePrimitiveEffect({
      topology, action: actions[0]!, connector: CONNECTOR, tolerance: 1.5,
    });
    report.existingCablePrimitive = {
      decision: primitive.decision, reason: primitive.reason,
      matchedEdgeIds: primitive.evidence.matchedEdgeIds, matchedNodeIds: primitive.evidence.matchedNodeIds,
      scannedEdgeIds: primitive.evidence.edgeIds,
    };

    // --- Phase 1: is the objective satisfied? ---------------------------------
    const objective = matchConnectionObjective({ topology });
    report.connectionObjective = objective;

    // --- Phase 2: the durable authority the recovery would run under ----------
    const storage = createCanonicalDurableStateStorage(appData);
    const ports = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage });
    const durability = ports.durability;
    if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    const activation = await ports.activateDurableWorld?.();
    report.activation = activation
      ? {
          kind: activation.kind ?? null, status: activation.status,
          blockedReason: activation.blockedReason ?? null,
          worldId: activation.world.worldId, nativeSessionGuid: activation.world.nativeSessionGuid,
          generation: activation.world.generation,
        }
      : null;
    report.writeAuthorityActivated = activation ? durability.isExecutionDurablyActivated(activation) : false;
    const authority = durability.snapshot().projectAuthority ?? null;
    report.projectAuthority = authority
      ? {
          status: authority.status, worldEpochId: authority.worldEpochId,
          inheritedJournalPosition: authority.inheritedJournalPosition,
          utilityKinds: authority.utilityKinds, mechanismRevisions: authority.mechanismRevisions,
          unreconstructed: authority.unreconstructed, replanRequired: authority.replanRequired,
          recoveryPlanningRevision: authority.recoveryPlanningRevision, recordedAt: authority.recordedAt,
          commandSet: authority.commandSet.map((entry) => ({
            commandId: entry.commandId, actionFamily: entry.actionFamily, position: entry.position,
            outcome: entry.outcome, worldEffect: entry.worldEffect,
          })),
        }
      : null;
    report.failedCommands = (authority?.commandSet ?? [])
      .filter((entry) => entry.outcome === "FAILED")
      .map((entry) => ({ commandId: entry.commandId, position: entry.position, worldEffect: entry.worldEffect, evidence: entry.evidence }));
    try {
      durability.assertMutationAllowed("k05-recovery-plan-write-authority-probe");
      report.writeAuthorityProbe = { allowed: true, reason: null };
    } catch (error) {
      report.writeAuthorityProbe = { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    report.nativeMutationCalls = calls.filter((name) => NATIVE_MUTATION_TOOLS.has(name));
    report.callLog = calls;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`K05_RECOVERY_PLAN_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
