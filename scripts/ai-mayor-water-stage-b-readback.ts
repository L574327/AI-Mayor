import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const liveStorePath = process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const row = (value: unknown): Record<string, any> => typeof value === "object" && value !== null ? value as Record<string, any> : {};

async function main() {
  const envelope = JSON.parse(fs.readFileSync(liveStorePath, "utf8"));
  const durable = row(row(envelope).aiMayorV2DurableState);
  const state = row(durable.projectState);
  const utility = row(row(state.tranche).utilityExecution);
  const water = row(row(utility.utilities).water);
  const facility = row(water.facility);
  const entity = row(facility.entity);
  if (!Number.isInteger(entity.index) || !Number.isInteger(entity.version)) throw new Error("CURRENT_WATER_FACILITY_ENTITY_UNAVAILABLE");

  const client = new Client({ name: "5ire-water-stage-b-readback", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  const call = async (name: string, args: Record<string, unknown> = {}) => parseV2McpJson(await client.callTool({ name, arguments: args }));
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const game = row(await call("cs2_game_state"));
    const world = row(game.world);
    const buildings = row(await call("cs2_list_buildings", { limit: 500 }));
    const inventory = Array.isArray(buildings.buildings) ? buildings.buildings.map(row) : [];
    const match = inventory.filter((item) => item.prefab === "GroundwaterPumpingStation01" &&
      row(item.entity).index === entity.index && row(item.entity).version === entity.version);
    const connectors = row(await call("cs2_utility_connectors", { index: entity.index, version: entity.version, topology: true }));
    const snapshot = row(await call("cs2_mayor_snapshot"));
    const utilities = row(snapshot.utilities);
    const access = tools.includes("cs2_building_access")
      ? await call("cs2_building_access", { index: entity.index, version: entity.version })
      : null;
    const manager = {
      legacyList: async () => ({ tools: tools.map((name) => ({ name: `live--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => ({
        content: [{ type: "text" as const, text: JSON.stringify(await call(name.replace(/^live--/, ""), args)) }],
      }),
    };
    const ports = createV2FoundationPorts({ getToolsManager: () => manager as never,
      durableStateStorage: createCanonicalDurableStateStorage(path.join(os.homedir(), "AppData", "Roaming")) });
    if (!ports.durability || !ports.greenfieldUtilityBootstrap) throw new Error("STAGE_B_PRODUCTION_PORTS_UNAVAILABLE");
    const activation = ports.durability.activate(game);
    if (!ports.durability.isExecutionDurablyActivated(activation) || world.checkpointId !== durable.active?.loadedCheckpointId) {
      throw new Error("STAGE_B_CURRENT_WORLD_BINDING_FAILED");
    }
    const current = ports.durability.projectState();
    const currentState = row(current);
    const currentUtility = row(row(row(currentState.tranche).utilityExecution));
    const waterState = row(row(currentUtility.utilities).water);
    const placementCommandId = typeof waterState.facilityCommandId === "string" ? waterState.facilityCommandId : null;
    let placementTerminal = false;
    if (match.length === 1 && placementCommandId) {
      const observed = ports.durability.reconcile(placementCommandId, {
        result: "MATCH",
        reason: `authoritative building inventory contains exact ${entity.index}:${entity.version} GroundwaterPumpingStation01 entity`,
      });
      placementTerminal = observed.outcome === "OBSERVED_MATCH";
    }
    const overview = row(await call("cs2_city_overview"));
    const treasury = Number(overview.treasury);
    const checks: Record<string, unknown> = {};
    if (current.schemaVersion === "ai-mayor-v2-gate1-state/2" && Number.isFinite(treasury)) {
      for (const kind of ["electricity", "water"] as const) {
        try {
          const input = buildUtilityPreparationInput({ state: current, world: activation.world, treasury,
            kind, connectionOnly: true, stageBReadOnly: true });
          const result = await ports.greenfieldUtilityBootstrap.prepare(input);
          checks[kind] = { status: result.status, reason: "reason" in result ? result.reason : null,
            diagnostics: result.diagnostics ?? null, plan: "plan" in result ? result.plan : null };
        } catch (error) {
          checks[kind] = { status: "BLOCKED", reason: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    const electricityReady = row(checks.electricity).status === "READY";
    const waterReady = row(checks.water).status === "READY";
    const accessReady = access !== null && row(access).valid === true && row(access).roadAttachment !== null;
    let waitingRecorded = false;
    if (match.length === 1 && placementTerminal && ports.greenfieldUtilityBootstrap.markAwaitingProductDecision &&
      !(accessReady && electricityReady && waterReady) && currentUtility.scope) {
      await ports.greenfieldUtilityBootstrap.markAwaitingProductDecision(currentUtility.scope, "water",
        !tools.includes("cs2_building_access") ? "STAGE_B_BUILDING_ACCESS_READBACK_TOOL_UNAVAILABLE" :
          String(row(checks.electricity).reason ?? row(checks.water).reason ?? "STAGE_B_CLOSURE_NOT_PROVEN"));
      waitingRecorded = true;
    }
    process.stdout.write(`${JSON.stringify({
      loadedCheckpointId: world.checkpointId ?? null,
      generation: world.generation ?? null,
      worldReady: world.worldReady ?? null,
      nativeOperationBusy: world.nativeOperationBusy ?? null,
      authoritativeBuildingEntityPresent: match.length === 1,
      matchingFacility: match[0] ?? null,
      buildingInventoryComplete: buildings.truncated !== true && buildings.hasMore !== true &&
        (!Number.isFinite(Number(buildings.totalMatches)) || Number(buildings.returned) === Number(buildings.totalMatches)),
      buildingAccessToolAvailable: tools.includes("cs2_building_access"),
      buildingAccess: access,
      stageBRoadAccessFeasible: accessReady ? "YES" : tools.includes("cs2_building_access") ? "NO" : "UNKNOWN",
      placementCommandId,
      placementCommandTerminal: placementTerminal,
      stageBElectricity: checks.electricity ?? null,
      stageBWaterConnection: checks.water ?? null,
      stageBExistingPrimitivesSufficient: accessReady && electricityReady && waterReady,
      placedFacilityAwaitingProductDecision: waitingRecorded,
      waterObjective: waitingRecorded ? "OPEN" : waterState.stage ?? null,
      utilityConnectors: connectors,
      electricityReadback: utilities.electricity ?? null,
      waterReadback: utilities.water ?? null,
      projectWater: water,
      availableReadbackTools: tools.filter((name) => /building|utility|snapshot/i.test(name)),
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
