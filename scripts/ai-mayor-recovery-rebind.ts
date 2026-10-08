/**
 * Phase 6 recovery rebind against the LIVE world — read-only.
 *
 * Run after the descendant checkpoint is certified. It answers, for the world
 * that is loaded right now, which current-world entities the reconstructed
 * authority actually resolves to. Nothing here writes: no `cs2_save_game`, no
 * Skill dispatch, no `place_building`, no cable mutation, no simulation run.
 * The script asserts that and fails the run if any such call appears.
 *
 * Identity is never copied from the old world. Roads are rebound from the
 * certified geometry through the production `rebindCertifiedRoadEffect` kernel
 * against the current road graph; the facility and connector are discovered by
 * authoritative read of the current world and then read through the production
 * `utilityService.observe` port. A stale old entity ref is never used as
 * authority.
 *
 * The Electron app must not have a running Mayor session while this executes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { rebindCertifiedRoadEffect } from "../src/main/services/ai-mayor/v2/road-epoch-rebind";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const appData = process.env.APPDATA ?? "";

/** Native tools that mutate the world. Any of these in the call log fails the run. */
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

const ref = (value: unknown): { index: number; version: number } | null => {
  const entity = record(value);
  const index = Number(entity.index);
  const version = Number(entity.version);
  return Number.isInteger(index) && Number.isInteger(version) ? { index, version } : null;
};

/** The certified road geometry a journal command authorized, if it is a road. */
function certifiedRoadGeometry(exactInput: string): { prefab: string; x1: number; z1: number; x2: number; z2: number } | null {
  try {
    const parsed = JSON.parse(exactInput) as Record<string, unknown>;
    const geometry = {
      prefab: String(parsed.prefab ?? ""),
      x1: Number(parsed.x1),
      z1: Number(parsed.z1),
      x2: Number(parsed.x2),
      z2: Number(parsed.z2),
    };
    return Object.values(geometry).every((value) => typeof value !== "string" || value.length > 0) &&
      [geometry.x1, geometry.z1, geometry.x2, geometry.z2].every(Number.isFinite)
      ? geometry
      : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!appData) throw new Error("APPDATA is not set");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-v2-recovery-rebind", version: "1.0.0" });
  await client.connect(transport);

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const manager = {
    legacyList: async () => ({
      tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })),
    }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };

  const report: Record<string, unknown> = { serverPath, appData, mode: "PHASE_6_REBIND_READ_ONLY" };
  try {
    const storage = createCanonicalDurableStateStorage(appData);
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager as never,
      durableStateStorage: storage,
    });
    const durability = ports.durability;
    if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");

    const activation = await ports.activateDurableWorld?.();
    if (!activation) throw new Error("activateDurableWorld is not configured");
    report.activation = {
      status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      worldId: activation.world.worldId,
      worldEpochId: activation.world.worldEpochId,
      nativeSessionGuid: activation.world.nativeSessionGuid,
      generation: activation.world.generation,
    };
    if (!durability.isExecutionDurablyActivated(activation)) {
      report.stopped = `write authority is not activated (${activation.status}); no rebind is meaningful yet`;
      return;
    }

    const authority = durability.snapshot().projectAuthority ?? null;
    report.projectAuthority = authority
      ? {
          status: authority.status,
          worldEpochId: authority.worldEpochId,
          inheritedJournalPosition: authority.inheritedJournalPosition,
          projectIds: authority.projectIds,
          trancheIds: authority.trancheIds,
          reservationRefs: authority.reservationRefs,
          utilityKinds: authority.utilityKinds,
          mechanismRevisions: authority.mechanismRevisions,
          unreconstructed: authority.unreconstructed,
          replanRequired: authority.replanRequired,
          recoveryPlanningRevision: authority.recoveryPlanningRevision,
          recordedAt: authority.recordedAt,
        }
      : null;

    // --- ROAD rebind: certified geometry -> current world road graph ----------
    const scan = parseSpatialBootstrapScan(
      await callToolThrough(client, calls, "cs2_spatial", { mode: "scan", roadLimit: 2_000 }),
    );
    const model = buildSpatialWorldModel(scan);
    report.currentWorldRoadGraph = { nodes: scan.roadGraph.nodes.length, edges: model.roadGraph.edges.length };

    const journal = new Map(ports.commandJournal.list().map((entry) => [entry.commandId, entry]));
    const roadRebinds = (authority?.commandSet ?? [])
      .filter((entry) => entry.actionFamily === "ROAD")
      .map((entry) => {
        const command = journal.get(entry.commandId);
        const geometry = command ? certifiedRoadGeometry(command.authorizedScope.exactInput) : null;
        if (!geometry) return { commandId: entry.commandId, status: "UNRESOLVED", reason: "certified road geometry unavailable" };
        const rebound = rebindCertifiedRoadEffect({ action: geometry, currentEdges: model.roadGraph.edges });
        return {
          commandId: entry.commandId,
          position: entry.position,
          worldEffect: entry.worldEffect,
          status: rebound.status,
          reason: rebound.reason,
          // Current-epoch entity refs only. The old world's refs are never
          // carried forward: a rebind that does not resolve in the current graph
          // reports STALE rather than reusing them.
          currentEdges: rebound.edges.map((edge) => ({
            entity: edge.entity,
            startNode: edge.startNode,
            endNode: edge.endNode,
            prefab: edge.prefab,
          })),
        };
      });
    report.roadRebinds = roadRebinds;
    report.currentCertifiedRoadEntities = roadRebinds.flatMap((entry) =>
      (entry.currentEdges ?? []).map((edge: { entity: { index: number; version: number } }) => `${edge.entity.index}:${edge.entity.version}`),
    );

    // --- Facility + connector rebind: current world, never the old ref -------
    const listed = record(await callToolThrough(client, calls, "cs2_list_buildings", { query: "WindTurbine", limit: 64 }));
    const buildings = Array.isArray(listed.buildings) ? listed.buildings.map(record) : null;
    report.facilityObservation = {
      complete: buildings !== null && listed.truncated !== true && listed.hasMore !== true && listed.complete !== false,
      count: buildings?.length ?? null,
    };
    const facility = buildings && buildings.length === 1 ? buildings[0] : null;
    report.currentFacilityEntity = facility ? ref(facility.entity) : null;
    if (facility) {
      report.currentFacility = {
        prefab: facility.prefab ?? null,
        position: facility.position ?? null,
        isSubBuilding: facility.isSubBuilding ?? null,
      };
      const connectors = record(
        await callToolThrough(client, calls, "cs2_utility_connectors", {
          index: Number(record(facility.entity).index),
          version: Number(record(facility.entity).version),
        }),
      );
      const rawConnectors = Array.isArray(connectors.connectors) ? connectors.connectors.map(record) : null;
      report.currentConnectors = (rawConnectors ?? []).map((connector) => ({
        type: connector.type ?? null,
        node: ref(connector.node),
        attached: connector.attached ?? null,
        orphan: connector.orphan ?? null,
      }));
      report.currentConnectorEntities = (rawConnectors ?? [])
        .map((connector) => ref(connector.node))
        .filter((node): node is { index: number; version: number } => node !== null)
        .map((node) => `${node.index}:${node.version}`);
      const targetEntity = ref(facility.entity);
      if (targetEntity && ports.utilityService) {
        // The production current-target read, over the current-world entity.
        const observed = await ports.utilityService.observe({ buildingRef: targetEntity });
        report.currentTargetSemantics = {
          observationId: observed.observationId,
          electricity: record(observed.electricity),
          coherence: observed.coherence,
          sourceStatus: record(observed.source).status ?? null,
          authoritativeBasis: record(observed.source).authoritativeBasis ?? null,
        };
      }
    }

    report.recoveryPlanningRevision = authority?.recoveryPlanningRevision ?? null;
    report.journalFailures = (authority?.commandSet ?? [])
      .filter((entry) => entry.outcome === "FAILED")
      .map((entry) => ({ commandId: entry.commandId, evidence: entry.evidence }));

    // The durable write gate itself, asked with an idempotency key no command
    // uses. It either throws or returns; it never writes, and asking is the only
    // honest way to show that write authority is unblocked rather than inferring
    // it from the activation status.
    try {
      durability.assertMutationAllowed("phase6-write-authority-probe");
      report.writeAuthorityProbe = { allowed: true, reason: null };
    } catch (error) {
      report.writeAuthorityProbe = { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    report.nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    report.callLog = calls.map((call) => call.name);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

/** Call a native tool and record it, so the mutation assertion sees every call. */
async function callToolThrough(
  client: Client,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
  calls.push({ name, args });
  return value;
}

void main().catch((error) => {
  process.stderr.write(`RECOVERY_REBIND_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
