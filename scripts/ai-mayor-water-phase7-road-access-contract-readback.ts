/**
 * READ-ONLY Water Phase 7 road-attachment contract comparison.
 * Calls only game-state/list/detail/attachment tools; no simulation, preview,
 * build, save, path submission, admission, or durable V2 write is performed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const liveStorePath = process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const pump = { index: 180004, version: 1 };
const pumpPoint = { x: -226.909, z: 1283.57007 };
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const distance2 = (p: Record<string, unknown>) => Math.hypot(Number(p.x) - pumpPoint.x, Number(p.z) - pumpPoint.z);

async function main() {
  const before = crypto.createHash("sha256").update(fs.readFileSync(liveStorePath)).digest("hex");
  const client = new Client({ name: "water-phase7-road-access-readback", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const calls: string[] = [];
  const tool = async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    const result = record(await client.callTool({ name, arguments: args }));
    const blocks = list(result.content).map(record);
    const body = blocks.find((block) => typeof block.text === "string")?.text;
    if (typeof body !== "string") return {};
    try { return JSON.parse(body) as Record<string, unknown>; }
    catch { return { raw: body }; }
  };

  const game = await tool("cs2_game_state", {});
  const world = record(game.world);
  const buildingsRead = await tool("cs2_list_buildings", { limit: 500 });
  const buildings = list(buildingsRead.buildings).map(record);
  const nearbyCandidates = buildings
    .filter((building) => building.isSubBuilding !== true && Number.isInteger(Number(record(building.entity).index)))
    .map((building) => ({
      entity: record(building.entity), prefab: String(building.prefab ?? ""),
      position: record(building.position), distanceToPump: distance2(record(building.position)),
    }))
    .filter((building) => Number.isFinite(building.distanceToPump))
    .sort((a, b) => a.distanceToPump - b.distanceToPump)
    .slice(0, 100);
  const targets = [{ entity: pump, prefab: "GroundwaterPumpingStation01", distanceToPump: 0 }, ...nearbyCandidates
    .filter((item) => Number(record(item.entity).index) !== pump.index)];
  const accesses = [];
  for (const target of targets) {
    const entity = record(target.entity);
    if (!Number.isInteger(Number(entity.index)) || !Number.isInteger(Number(entity.version))) continue;
    const access = await tool("cs2_building_access", { index: Number(entity.index), version: Number(entity.version) });
    accesses.push({ ...target, access });
  }
  const spatial = await tool("cs2_spatial", { mode: "detail", x: pumpPoint.x, z: pumpPoint.z, radius: 160, resolution: 32 });
  const roads = await tool("cs2_list_roads", { query: "Small Road", limit: 500 });
  const nativeEntityInspections = await Promise.all([
    { label: "pump-road-spawn-location", entity: { index: 52845, version: 1 } },
    { label: "pump-road-spawn-lane", entity: { index: 180967, version: 1 } },
    { label: "pump-prefab", entity: { index: 12424, version: 1 } },
    { label: "first-access-road-edge", entity: { index: 186480, version: 19 } },
    { label: "second-access-road-edge", entity: { index: 186481, version: 19 } },
  ].map(async (item) => ({
    label: item.label,
    entity: item.entity,
    inspection: await tool("cs2_inspect", item.entity),
  })));
  const after = crypto.createHash("sha256").update(fs.readFileSync(liveStorePath)).digest("hex");
  const report = {
    mode: "READ_ONLY_WATER_PHASE7_ROAD_ACCESS_CONTRACT",
    world: { worldId: world.worldId ?? null, generation: world.generation ?? null, frameIndex: record(game.simulation).frameIndex ?? null },
    pump,
    buildingList: { totalMatches: buildingsRead.totalMatches ?? null, returned: buildings.length, complete: buildingsRead.complete ?? null, truncated: buildingsRead.truncated ?? null, hasMore: buildingsRead.hasMore ?? null },
    candidatesRead: nearbyCandidates,
    accessReadbacks: accesses,
    spatialDetail: spatial,
    smallRoadList: roads,
    nativeEntityInspections,
    calls,
    liveStoreUnchanged: before === after,
    nativeMutationCount: 0,
    forcedSaveCount: 0,
  };
  await fs.promises.writeFile("docs/ai-mayor/evidence/water-phase7-road-access-contract-readback.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await client.close();
  process.stdout.write(`${JSON.stringify({
    world: report.world,
    buildingList: report.buildingList,
    nearbyCandidateCount: nearbyCandidates.length,
    attachedServiceControls: accesses.filter((item) => {
      const attachment = record(record(item.access).roadAttachment);
      return attachment.roadExists === true && attachment.roadIsEdge === true;
    }).map((item) => ({ entity: item.entity, prefab: item.prefab, distanceToPump: item.distanceToPump, access: item.access })),
    pumpAccess: accesses[0]?.access,
    smallRoadList: { totalMatches: roads.totalMatches ?? null, returned: list(roads.roads).length, complete: roads.complete ?? null },
    calls,
    liveStoreUnchanged: report.liveStoreUnchanged,
    nativeMutationCount: 0,
    forcedSaveCount: 0,
  }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
