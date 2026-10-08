/**
 * Read-only: what does the PRODUCTION connection-objective matcher decide about
 * the current world, right now?
 *
 * K05 reconnaissance proved the Low-voltage Ground Cable the plan's direct-cable
 * course describes already exists physically (192398:1 + 192399:1, facility
 * connector -> target road start). The plain connector read still reports
 * `orphan: true`, which the objective contract treats as a hard blocker.
 *
 * So the question this answers is not "is there a cable" but "which read surface
 * does the production objective actually consume, and what does that surface
 * report". It calls the same Bridge endpoint, with the same parameters, that
 * `readScopedUtilityEvidence` calls, then runs the real `matchConnectionObjective`
 * over the normalized payload.
 *
 * Native reads only: no save, no Skill dispatch, no place_building, no cable
 * mutation, no simulation run. The script asserts that and fails if violated.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeUtilityTopologyPayload, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { matchCablePrimitiveEffect, matchConnectionObjective } from "../src/main/services/ai-mayor/v2/utility-topology-matchers";
import { bridgeTopologyRevision } from "../src/main/services/ai-mayor/v2/utility-target-binding";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";

const FACILITY = { index: Number(process.env.K05_FACILITY_INDEX ?? 176455), version: Number(process.env.K05_FACILITY_VERSION ?? 1) };
const CONNECTOR = { index: Number(process.env.K05_CONNECTOR_INDEX ?? 185275), version: Number(process.env.K05_CONNECTOR_VERSION ?? 1) };
const TARGET = { index: Number(process.env.K05_ROAD_INDEX ?? 187602), version: Number(process.env.K05_ROAD_VERSION ?? 1) };

/** The admitted course the plan describes, verbatim from the K05 plan revision. */
const ADMITTED = {
  prefab: "Low-voltage Ground Cable",
  start: { x: -1117.83313, z: -11.0255737 },
  end: { x: -1247.55188, z: -12.3875341 },
};

const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game",
  "cs2_build_road",
  "cs2_mayor_execute_actions",
  "cs2_run_simulation",
  "cs2_bulldoze",
  "cs2_build",
  "cs2_zone",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-k05-objective-probe", version: "1.0.0" });
  await client.connect(transport);

  const calls: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
    calls.push(name);
    return value;
  };

  const report: Record<string, unknown> = { serverPath, mode: "K05_OBJECTIVE_READ_ONLY" };
  try {
    const state = record(await call("cs2_game_state", {}));
    const world = record(state.world);
    const generation = String(world.generation ?? "");
    const worldEpochId = String(world.worldEpochId ?? "");
    report.world = {
      worldId: world.worldId ?? null,
      worldEpochId: world.worldEpochId ?? null,
      nativeSessionGuid: world.nativeSessionGuid ?? null,
      generation: world.generation ?? null,
      paused: record(state.simulation).paused ?? null,
    };

    // The plain read: this is what the facility/connector binding is built from.
    const plain = record(await call("cs2_utility_connectors", { index: FACILITY.index, version: FACILITY.version }));
    const plainConnectors = Array.isArray(plain.connectors) ? plain.connectors.map(record) : [];
    report.plainRead = {
      connectorCount: plainConnectors.length,
      connectors: plainConnectors.map((connector) => ({
        type: connector.type ?? null,
        node: connector.node ?? null,
        attached: connector.attached ?? null,
        orphan: connector.orphan ?? null,
        connectedEdgeCount: connector.connectedEdgeCount ?? null,
        externalEdgeCount: connector.externalEdgeCount ?? null,
        facilityOwnedEdgeCount: connector.facilityOwnedEdgeCount ?? null,
        graphEdgeCount: connector.graphEdgeCount ?? null,
        capacity: connector.capacity ?? null,
        voltage: connector.voltage ?? null,
        connectedEdges: connector.connectedEdges ?? null,
      })),
    };
    report.consumerService = plain.consumerService ?? null;
    report.buildingElectricityConnection = plain.buildingElectricityConnection ?? null;

    // The topology read: the surface `readScopedUtilityEvidence` actually consumes.
    const rawTopology = await call("cs2_utility_connectors", {
      index: FACILITY.index, version: FACILITY.version, topology: true,
      connectorIndex: CONNECTOR.index, connectorVersion: CONNECTOR.version,
      targetIndex: TARGET.index, targetVersion: TARGET.version,
      expectedWorldId: worldEpochId.split(":generation:", 1)[0],
      expectedGeneration: generation,
      expectedTopologyRevision: bridgeTopologyRevision({ generation, target: TARGET }),
      admittedPrefab: ADMITTED.prefab,
      admittedStart: ADMITTED.start,
      admittedEnd: ADMITTED.end,
      endpointTolerance: 1.5,
      envelope: { center: { x: ADMITTED.start.x, z: ADMITTED.start.z }, radius: 400 },
    });
    const topology = normalizeUtilityTopologyPayload(rawTopology);
    report.topologyBinding = topology.binding ?? null;
    report.topologyConnector = topology.connector ?? null;
    report.topologyTargetNetwork = topology.targetNetwork ?? null;
    report.topologyAdmittedAction = topology.admittedAction ?? null;
    report.topologyCandidateScan = topology.candidateScan ?? null;
    report.topologyConnectorKeys = Object.keys(record(topology.connector));

    // The production decision, over the production payload.
    report.objective = matchConnectionObjective({ topology });

    // The other production matcher: does the permanent physical cable effect the
    // plan's direct-cable course describes already exist in this world? It is
    // deliberately blind to orphan/network/reachability, so it answers "is the
    // cable there" independently of "is the objective satisfied".
    const action = {
      type: "build_road" as const,
      prefab: ADMITTED.prefab,
      x1: ADMITTED.start.x, z1: ADMITTED.start.z,
      x2: ADMITTED.end.x, z2: ADMITTED.end.z,
    };
    const connectorRef = { index: CONNECTOR.index, version: CONNECTOR.version };
    const endpoints = Array.isArray(record(topology.targetNetwork).targetEndpoints)
      ? (record(topology.targetNetwork).targetEndpoints as unknown[]).map(record) : [];
    report.cablePrimitiveByTargetRole = Object.fromEntries(endpoints.map((endpoint) => [
      String(endpoint.role),
      {
        targetNode: endpoint.node ?? null,
        match: matchCablePrimitiveEffect({
          topology, action, connector: connectorRef,
          targetNode: record(endpoint.node) as unknown as { index: number; version: number },
          tolerance: 1.5,
        }),
      },
    ]));
    report.cablePrimitiveNoTarget = matchCablePrimitiveEffect({ topology, action, connector: connectorRef, tolerance: 1.5 });

    // Counterfactual, computed locally with no native call: the objective is
    // otherwise satisfied (VALID binding, attached, networkConnected, reachable),
    // so this isolates `orphan` as the sole discriminator.
    const withOrphan = (value: unknown) => {
      const connector = { ...record(topology.connector) };
      if (value === "ABSENT") delete connector.orphan; else connector.orphan = value;
      return { ...topology, connector };
    };
    report.objectiveCounterfactual = Object.fromEntries(["ABSENT", false, true].map((variant) => [
      String(variant),
      matchConnectionObjective({ topology: withOrphan(variant) }),
    ]));
  } finally {
    report.nativeMutationCalls = calls.filter((name) => NATIVE_MUTATION_TOOLS.has(name));
    report.callLog = calls;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`K05_OBJECTIVE_PROBE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
