import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { routeBSpatialEnvelope, runRouteBProofOnly, type RouteBProvenance } from "../src/main/services/ai-mayor/v2/route-b-thin-harness";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const record = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};

async function main() {
  const client = new Client({ name: "5ire-route-b-thin-differential", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  const required = ["cs2_game_state", "cs2_list_buildings", "cs2_mayor_snapshot", "cs2_city_overview", "cs2_utility_connectors", "cs2_spatial"];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`ROUTE_B_REQUIRED_TOOLS_MISSING:${missing.join(",")}`);
  const direct = async (name: string, args: Record<string, unknown> = {}) => parseV2McpJson(await client.callTool({ name, arguments: args }));
  const game = record(await direct("cs2_game_state"));
  const world = record(game.world);
  const snapshot = record(await direct("cs2_mayor_snapshot"));
  const buildings = record(await direct("cs2_list_buildings", { query: "WindTurbine", limit: 32 }));
  const turbines = Array.isArray(buildings.buildings) ? buildings.buildings.map(record).filter((item) => item.prefab === "WindTurbine01" && item.isSubBuilding !== true) : [];
  if (turbines.length !== 1) throw new Error(turbines.length === 0 ? "ROUTE_B_FIXTURE_FACILITY_NOT_FOUND" : "ROUTE_B_FIXTURE_FACILITY_AMBIGUOUS");
  const anchor = record(turbines[0].position);
  const facilityEntity = record(turbines[0].entity);
  const connectorPayload = record(await direct("cs2_utility_connectors", { index: facilityEntity.index, version: facilityEntity.version }));
  const connectors = Array.isArray(connectorPayload.connectors) ? connectorPayload.connectors.map(record) : [];
  const clean = connectors.length === 1 && connectors[0].attached !== true &&
    (!Array.isArray(connectors[0].connectedEdges) || connectors[0].connectedEdges.length === 0);
  const provenance: RouteBProvenance = {
    worldId: String(world.worldId ?? ""), worldEpochId: String(world.worldEpochId ?? world.generation ?? ""),
    generation: String(world.generation ?? ""), loaded: world.loaded !== false, ready: world.worldReady !== false,
    clean, evidence: { gameMode: world.gameMode ?? null, snapshotStatus: snapshot.status ?? null, facilityEntity },
  };
  const overview = record(await direct("cs2_city_overview"));
  const foundation = createV2FoundationPorts({ getToolsManager: () => ({
    legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `route-b--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { client: string; name: string; arguments: Record<string, unknown> }) => client.callTool({ name, arguments: args }),
  }) });
  const result = await runRouteBProofOnly({
    kind: "electricity", intentId: `route-b:${provenance.worldId}`, projectId: "route-b-differential",
    trancheId: "route-b-proof-only", reservationRef: "route-b-current-world", worldId: provenance.worldId,
    worldEpochId: provenance.worldEpochId, generation: provenance.generation, topologyRevision: `${provenance.generation}:route-b`,
    spatialEnvelope: routeBSpatialEnvelope({ x: Number(anchor.x), z: Number(anchor.z) }),
    maximumSpend: Number(overview.treasury ?? 0), treasury: Number(overview.treasury ?? 0), treasurySafetyReserve: 0,
    connectionOnly: true, selectedPrimitive: "direct-cable",
  }, {
    provenance: async () => provenance,
    prepare: (input) => foundation.greenfieldUtilityBootstrap.prepare(input),
  });
  process.stdout.write(`${JSON.stringify({ mode: "PROOF_ONLY", routeBProvenance: provenance, result }, null, 2)}\n`);
  await client.close();
}

if (process.argv[1]?.endsWith("local-v2-route-b-differential.ts")) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
