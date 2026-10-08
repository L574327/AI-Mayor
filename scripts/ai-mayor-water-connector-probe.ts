/**
 * Read-only: which placed building in the CURRENT world carries a water-pipe
 * connector or a WaterConsumer. The water slice needs a target that is
 * verifiable *now*; this decides whether such a target already exists, or
 * whether the slice must create its own.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

const serverPath =
  process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-water-connector-probe", version: "1.0.0" });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown>) =>
    parseV2McpJson(await client.callTool({ name, arguments: args }));

  const report: Record<string, unknown> = { serverPath, mode: "WATER_CONNECTOR_PROBE_READ_ONLY" };
  try {
    const buildings = record(await call("cs2_list_buildings", { limit: 500 }));
    const rows: unknown[] = [];
    for (const entry of list(buildings.buildings)) {
      const b = record(entry);
      const entity = record(b.entity);
      const index = Number(entity.index);
      const version = Number(entity.version);
      let connectors: Record<string, unknown>;
      try {
        connectors = record(await call("cs2_utility_connectors", { index, version }));
      } catch (error) {
        rows.push({ index, version, prefab: b.prefab, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const kinds = list(connectors.connectors).map((c) => record(c).type);
      const waterConnectors = list(connectors.connectors).filter((c) => record(c).type === "waterPipe");
      const consumer = record(record(connectors.consumerService).water);
      rows.push({
        index, version, prefab: b.prefab,
        connectorKinds: kinds,
        waterPipeConnectorCount: waterConnectors.length,
        waterPipeConnectors: waterConnectors,
        buildingWaterPipeConnection: connectors.buildingWaterPipeConnection ?? null,
        waterConsumer: Object.keys(consumer).length > 0 ? consumer : null,
      });
    }
    report.buildings = rows;
    report.anyWaterPipeConnector = rows.some((r) => Number(record(r).waterPipeConnectorCount ?? 0) > 0);
    report.anyWaterConsumer = rows.some((r) => record(r).waterConsumer !== null);
  } finally {
    const outPath = process.env.WATER_CONNECTOR_OUT ?? "evidence/water-connector-probe-2026-09-22.json";
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`WATER_CONNECTOR_PROBE_WRITTEN: ${outPath}\n`);
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`WATER_CONNECTOR_PROBE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
