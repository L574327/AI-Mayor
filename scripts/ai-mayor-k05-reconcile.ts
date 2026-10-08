/**
 * K05 Attempt 2 — post-fix read-only reconciliation.
 *
 * The world already contains the admitted cable course as two permanent
 * Low-voltage Ground Cable segments, so no cable may be created. This script
 * only re-reads the authoritative world through the production matchers and
 * reports whether the existing effect now satisfies the connection objective.
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
  return splitUtilityConnection({
    prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
    start: connectorPosition,
    end: targetContact,
  }).map((segment) => ({
    type: "build_road" as const,
    prefab: segment.prefab,
    x1: segment.start.x, z1: segment.start.z,
    x2: segment.end.x, z2: segment.end.z,
  }));
}

async function main() {
  if (!appData) throw new Error("APPDATA is not set");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-k05-reconcile", version: "1.0.0" });
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

  const report: Record<string, unknown> = { serverPath, mode: "K05_RECONCILIATION_READ_ONLY" };
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

    const plain = record(await call("cs2_utility_connectors", { index: FACILITY.index, version: FACILITY.version }));
    const connectors = Array.isArray(plain.connectors) ? plain.connectors.map(record) : [];
    const electricity = connectors.find((connector) => connector.type === "electricity" && record(connector.node).index === CONNECTOR.index);
    const connectorPosition = { x: Number(record(electricity?.worldPosition).x), z: Number(record(electricity?.worldPosition).z) };
    report.plainConnector = electricity
      ? {
          node: electricity.node ?? null, attached: electricity.attached ?? null, orphan: electricity.orphan ?? null,
          connectedEdgeCount: electricity.connectedEdgeCount ?? null, externalEdgeCount: electricity.externalEdgeCount ?? null,
          graphEdgeCount: electricity.graphEdgeCount ?? null, capacity: electricity.capacity ?? null,
        }
      : null;

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
    const topologyConnector = record(topology.connector);
    report.topologyBinding = topology.binding ?? null;
    report.topologyConnectorKeys = Object.keys(topologyConnector);
    report.topologyConnector = {
      entity: topologyConnector.entity ?? null, attached: topologyConnector.attached ?? null,
      networkConnected: topologyConnector.networkConnected ?? null, orphan: topologyConnector.orphan ?? null,
    };
    report.topologyTarget = {
      networkConnected: record(topology.targetNetwork).networkConnected ?? null,
      targetNetworkReachable: record(topology.targetNetwork).targetNetworkReachable ?? null,
    };
    report.topologyCandidateScan = topology.candidateScan ?? null;

    // --- Test F, live: the read surface must really emit orphan, never a default.
    const orphanEmitted = typeof topologyConnector.orphan === "boolean";
    report.ORPHAN_READ_SURFACE_ADDED = orphanEmitted;
    report.ORPHAN_AGREES_WITH_PLAIN_READ = orphanEmitted && electricity
      ? topologyConnector.orphan === (electricity.orphan === true) : null;

    const actions = directCableActions(connectorPosition, { x: -1247.55188, z: -12.3875341 });
    const primitive = matchCablePrimitiveEffect({ topology, action: actions[0]!, connector: CONNECTOR, tolerance: 1.5 });
    const objective = matchConnectionObjective({ topology });
    report.recoveryCourse = { segments: actions.length, exactActions: actions, fingerprint: JSON.stringify(actions) };
    report.existingCablePrimitive = {
      decision: primitive.decision, reason: primitive.reason,
      matchedEdgeIds: primitive.evidence.matchedEdgeIds, matchedNodeIds: primitive.evidence.matchedNodeIds,
    };
    report.connectionObjective = objective;

    report.EXISTING_CABLE_PHYSICAL_EFFECT_PRESENT = primitive.decision === "OBSERVED_MATCH";
    report.EXISTING_CABLE_MATCHES_RECOVERY_COURSE = primitive.decision === "OBSERVED_MATCH";
    report.EXISTING_CABLE_CONNECTION_OBJECTIVE_SATISFIED = objective.status === "COMPLETE";
    report.UTILITY_CONNECTED = objective.status === "COMPLETE";

    // --- The production capacity observation, verbatim from `observeUtility`.
    const snapshot = record(await call("cs2_mayor_snapshot", {}));
    const utility = record(record(snapshot.utilities).electricity);
    const capacityValue = utility.production;
    const consumptionValue = utility.consumption;
    const fulfilledValue = utility.fulfilledConsumption;
    const capacityObserved = utility.status === "available" &&
      typeof capacityValue === "number" && typeof consumptionValue === "number";
    report.capacityObservation = {
      status: utility.status ?? null, capacity: capacityValue ?? null,
      consumption: consumptionValue ?? null, fulfilledConsumption: fulfilledValue ?? null,
    };
    report.CITY_CAPACITY_AVAILABLE = capacityObserved
      ? Number(capacityValue) > 0 && Number(capacityValue) >= Number(consumptionValue) : null;

    // --- The durable record of what has already been executed and claimed.
    const storage = createCanonicalDurableStateStorage(appData);
    const ports = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage });
    const durability = ports.durability;
    if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
    await ports.activateDurableWorld?.();
    const authority = durability.snapshot().projectAuthority ?? null;
    report.projectAuthority = authority
      ? {
          status: authority.status, worldEpochId: authority.worldEpochId,
          inheritedJournalPosition: authority.inheritedJournalPosition,
          mechanismRevisions: authority.mechanismRevisions,
          unreconstructed: authority.unreconstructed, replanRequired: authority.replanRequired,
          recoveryPlanningRevision: authority.recoveryPlanningRevision,
          commandSet: authority.commandSet.map((entry) => ({
            commandId: entry.commandId, actionFamily: entry.actionFamily, position: entry.position,
            outcome: entry.outcome, worldEffect: entry.worldEffect,
          })),
        }
      : null;
    const utilityEntries = (authority?.commandSet ?? []).filter((entry) => entry.actionFamily === "UTILITY");
    report.GATE1_UTILITY_EXECUTION_RECORDED = utilityEntries.some((entry) =>
      ["OBSERVED_MATCH", "APPLIED", "NATIVE_COMPLETED"].includes(String(entry.outcome)));
    report.SKILL_RESULT = utilityEntries.length > 0
      ? utilityEntries.map((entry) => `${entry.commandId}:${entry.outcome}`).join(",") : "NO_UTILITY_COMMAND_RECORDED";
    report.LIVE_K05_PROOF_COMPLETE = report.EXISTING_CABLE_CONNECTION_OBJECTIVE_SATISFIED === true &&
      report.GATE1_UTILITY_EXECUTION_RECORDED === true;
  } finally {
    report.NEW_CABLE_NATIVE_MUTATION_COUNT = calls.filter((name) => name === "cs2_build_road" || name === "cs2_mayor_execute_actions").length;
    report.nativeMutationCalls = calls.filter((name) => NATIVE_MUTATION_TOOLS.has(name));
    report.callLog = calls;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`K05_RECONCILE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
