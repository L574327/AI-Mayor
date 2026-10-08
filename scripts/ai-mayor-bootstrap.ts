import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseMcpJson } from "../src/main/services/ai-mayor/main-adapters";
import { evaluateBootstrapSites } from "../src/main/services/ai-mayor/spatial/site-finder";
import type { PlannedRoadSegment, SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import { planBootstrapUtilities } from "../src/main/services/ai-mayor/spatial/utility-planner";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import { executeSharedUtilityRecovery, type UtilityRecoveryKind } from "../src/main/services/ai-mayor/utility-recovery";

type JsonObject = Record<string, unknown>;

const bridgeBase = process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642";
const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidenceDirectory = path.resolve(
  process.env.AI_MAYOR_BOOTSTRAP_EVIDENCE ?? "docs/ai-mayor/evidence/bootstrap-live",
);
const saveLabel = process.env.AI_MAYOR_BOOTSTRAP_SAVE_LABEL ?? "2026-09-10";

const record = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

async function bridgeJson(route: string): Promise<unknown> {
  const response = await fetch(`${bridgeBase}${route}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`Bridge ${response.status}: ${body}`);
  return JSON.parse(body);
}

function parseSiteDetail(value: unknown): SpatialSiteDetail {
  const detail = record(value) as Partial<SpatialSiteDetail>;
  if (!detail.center || !detail.terrain || !detail.roadGraph || !detail.buildings || !detail.zoningCells) {
    throw new Error("spatial site detail is incomplete");
  }
  return detail as SpatialSiteDetail;
}

function roadAction(segment: PlannedRoadSegment, prefab = "Small Road") {
  return {
    type: "build_road",
    prefab,
    x1: segment.start.x,
    z1: segment.start.z,
    x2: segment.end.x,
    z2: segment.end.z,
  };
}

function add(origin: SpatialPoint2, direction: SpatialPoint2, distance: number): SpatialPoint2 {
  return { x: origin.x + direction.x * distance, z: origin.z + direction.z * distance };
}

async function main(): Promise<void> {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const logPath = path.join(evidenceDirectory, "bootstrap-events.jsonl");
  const log = (event: string, data: unknown) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, data });
    fs.appendFileSync(logPath, `${line}\n`);
    process.stdout.write(`${line}\n`);
  };

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-bootstrap-city", version: "1.0.0" });
  await client.connect(transport);
  try {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const required of [
      "cs2_mayor_execute_actions",
      "cs2_run_simulation",
      "cs2_game_state",
      "cs2_set_camera",
      "cs2_screenshot",
      "cs2_save_game",
      "cs2_spatial",
      "cs2_utility_connectors",
    ]) {
      if (!names.has(required)) throw new Error(`MCP server is missing ${required}`);
    }

    const callJson = async (name: string, arguments_: JsonObject = {}) =>
      parseMcpJson(await client.callTool({ name, arguments: arguments_ }));
    const execute = async (phase: string, actions: JsonObject[]) => {
      const result = record(await callJson("cs2_mayor_execute_actions", { actions }));
      log(phase, result);
      if (result.ok !== true) throw new Error(`${phase} failed: ${JSON.stringify(result)}`);
      return result;
    };
    const capture = async (label: string, center: SpatialPoint2, zoom: number) => {
      await callJson("cs2_set_camera", { x: center.x, z: center.z, angleX: 25, angleY: 68, zoom });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const screenshot = await client.callTool({ name: "cs2_screenshot", arguments: { width: 1600 } });
      const content = Array.isArray(record(screenshot).content) ? (record(screenshot).content as unknown[]) : [];
      const image = content.find(
        (item): item is { type: "image"; data: string; mimeType: string } => record(item).type === "image",
      );
      if (!image) throw new Error("screenshot returned no image");
      const filename = path.join(evidenceDirectory, `${label}.png`);
      fs.writeFileSync(filename, Buffer.from(image.data, "base64"));
      log("screenshot", { label, filename });
    };
    const runHours = async (hours: number) => {
      const start = record(await callJson("cs2_game_state"));
      const startFrame = Number(record(start.simulation).frameIndex ?? 0);
      const run = record(await callJson("cs2_run_simulation", { hours, speed: 8 }));
      const targetFrame = Number(run.targetFrame ?? 0);
      log("simulation_start", { hours, startFrame, targetFrame, run });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const state = record(await callJson("cs2_game_state"));
        const simulation = record(state.simulation);
        if (simulation.paused === true || Number(simulation.frameIndex ?? 0) >= targetFrame) {
          log("simulation_complete", state);
          return;
        }
      }
      await callJson("cs2_run_simulation", { cancel: true });
      throw new Error(`simulation did not complete ${hours} in-game hours within 120 seconds`);
    };

    const state = record(await callJson("cs2_game_state"));
    const overview = record(await bridgeJson("/city/overview"));
    const baselineScan = parseSpatialBootstrapScan(await bridgeJson("/spatial/bootstrap-scan?roadLimit=2000"));
    const baselinePlayerRoads = baselineScan.roadGraph.edges.filter((edge) => !edge.native).length;
    const baselineZoning = record(await bridgeJson("/city/zoning"));
    if (record(state.simulation).paused !== true) throw new Error("bootstrap requires a paused simulation");
    if (
      Number(overview.population ?? -1) !== 0 ||
      baselinePlayerRoads !== 0 ||
      Number(baselineZoning.zonedCells ?? -1) !== 0
    ) {
      throw new Error("bootstrap safety baseline failed: expected population 0, no player roads and no zoning");
    }
    log("baseline", { state, overview, playerRoadEdges: baselinePlayerRoads, zoning: baselineZoning });

    const model = buildSpatialWorldModel(baselineScan);
    const candidates = model.connectionCandidates.slice(0, 12);
    const details = new Map<string, SpatialSiteDetail>();
    for (const candidate of candidates) {
      const { x, z } = candidate.node.position;
      const key = `${candidate.node.entity.index}:${candidate.node.entity.version}`;
      if (!details.has(key)) {
        details.set(
          key,
          parseSiteDetail(await bridgeJson(`/spatial/site-detail?x=${x}&z=${z}&radius=512&resolution=128`)),
        );
      }
    }
    const selected = evaluateBootstrapSites(model, details).find((candidate) => candidate.valid);
    if (!selected)
      throw new Error(`no valid bootstrap site among ${candidates.length} deterministic ingress candidates`);
    const bounds = model.ownedTiles.flatMap((tile) => (tile.bounds ? [tile.bounds] : []));
    const minX = Math.min(...bounds.map((item) => item.min.x));
    const minZ = Math.min(...bounds.map((item) => item.min.z));
    const maxX = Math.max(...bounds.map((item) => item.max.x));
    const maxZ = Math.max(...bounds.map((item) => item.max.z));
    const areaCenter = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const areaRadius = Math.min(2048, Math.ceil(Math.max(maxX - minX, maxZ - minZ) / 2 + 64));
    const areaDetail = parseSiteDetail(
      await bridgeJson(`/spatial/site-detail?x=${areaCenter.x}&z=${areaCenter.z}&radius=${areaRadius}&resolution=128`),
    );
    const utilities = planBootstrapUtilities(model, selected, areaDetail, baselineScan.bootstrapAssets);
    log("plan", { selected, utilities });

    const preflightObject = async (prefab: string, position: SpatialPoint2, rotation: number): Promise<boolean> => {
      try {
        const result = record(
          await callJson("cs2_spatial", {
            mode: "preflight",
            kind: "object",
            prefab,
            x: position.x,
            z: position.z,
            rotation,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        return result.valid === true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return false;
      }
    };
    const preflightNet = async (prefab: string, start: SpatialPoint2, end: SpatialPoint2): Promise<boolean> => {
      try {
        const result = record(
          await callJson("cs2_spatial", {
            mode: "preflight",
            kind: "net",
            prefab,
            x1: start.x,
            z1: start.z,
            x2: end.x,
            z2: end.z,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        return result.valid === true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return false;
      }
    };
    for (const segment of selected.layout.segments) {
      if (!(await preflightNet("Small Road", segment.start, segment.end))) {
        throw new Error(`native preflight rejected starter road ${segment.id}`);
      }
    }

    log("utility_shared_plan_ready", {
      facilities: utilities.facilities.map((facility) => ({
        prefab: facility.prefab,
        position: facility.position,
        rotations: facility.rotationCandidates,
        connectionMode: (facility.serviceRoads?.length ?? 0) > 0 ? "road_network" : "dedicated_net",
      })),
    });

    await callJson("cs2_save_game", { name: `AI Mayor Pre-Bootstrap ${saveLabel}` });
    await capture("00-before", selected.connection.node.position, 650);

    await execute(
      "roads",
      selected.layout.segments.map((segment) => roadAction(segment)),
    );
    const roadScan = parseSpatialBootstrapScan(await bridgeJson("/spatial/bootstrap-scan?roadLimit=2000"));
    const playerRoads = roadScan.roadGraph.edges.filter((edge) => !edge.native);
    if (playerRoads.length < selected.layout.segments.length) {
      throw new Error(
        `road readback failed: expected at least ${selected.layout.segments.length}, got ${playerRoads.length}`,
      );
    }
    log("roads_verified", { playerRoadEdges: playerRoads.length });
    await capture("01-roads", selected.connection.node.position, 650);

    const readCapacity = async (kind: UtilityRecoveryKind) => {
      const services = record(await bridgeJson("/city/services"));
      const electricity = record(services.electricity);
      const water = record(services.water);
      const capacity = Number(
        kind === "electricity"
          ? (electricity.production ?? 0)
          : kind === "water"
            ? (water.freshCapacity ?? 0)
            : (water.sewageCapacity ?? 0),
      );
      const consumption = Number(
        kind === "electricity"
          ? (electricity.consumption ?? 0)
          : kind === "water"
            ? (water.freshConsumption ?? 0)
            : (water.sewageConsumption ?? 0),
      );
      const fulfilledConsumption = Number(
        kind === "electricity"
          ? (electricity.fulfilledConsumption ?? 0)
          : kind === "water"
            ? (water.freshFulfilledConsumption ?? consumption)
            : (water.sewageFulfilledConsumption ?? consumption),
      );
      return {
        revision: "bootstrap",
        capacity,
        consumption,
        fulfilledConsumption,
        issueActive: capacity <= consumption || fulfilledConsumption < consumption,
      };
    };
    const recoveryResults = [];
    for (const facility of utilities.facilities) {
      const kind: UtilityRecoveryKind = facility.kind === "power" ? "electricity" : facility.kind;
      const result = await executeSharedUtilityRecovery({
        kind,
        expectedRevision: "bootstrap",
        treasury: Number.POSITIVE_INFINITY,
        runwayMonths: Number.POSITIVE_INFINITY,
        signal: new AbortController().signal,
        ports: {
          plan: async () => ({ status: "candidate", facility, reason: "bootstrap_shared_plan" }),
          preflight: async (action) =>
            action.type === "place_building"
              ? preflightObject(action.prefab, { x: action.x, z: action.z }, action.rotation ?? 0)
              : action.type === "build_road"
                ? preflightNet(action.prefab, { x: action.x1, z: action.z1 }, { x: action.x2, z: action.z2 })
                : false,
          execute: async (actions) =>
            (await execute(
              `utility_${kind}`,
              actions as unknown as JsonObject[],
            )) as unknown as import("../src/main/services/ai-mayor/types").MayorBatchResult,
          readConnectors: async (entity) => {
            const value = record(
              await callJson("cs2_utility_connectors", { index: entity.index, version: entity.version }),
            );
            return (Array.isArray(value.connectors) ? value.connectors : []).map((item) => {
              const connector = record(item);
              const node = record(connector.node);
              const position = record(connector.worldPosition);
              const capacity = record(connector.capacity);
              return {
                type: connector.type === "electricity" ? ("electricity" as const) : ("waterPipe" as const),
                node: { index: Number(node.index), version: Number(node.version) },
                worldPosition: { x: Number(position.x), z: Number(position.z) },
                attached: connector.attached === true,
                capacity: {
                  ...(typeof capacity.electricity === "number" ? { electricity: capacity.electricity } : {}),
                  ...(typeof capacity.fresh === "number" ? { fresh: capacity.fresh } : {}),
                  ...(typeof capacity.sewage === "number" ? { sewage: capacity.sewage } : {}),
                },
              };
            });
          },
          readCapacity,
          settle: () => runHours(0.5),
          currentRevision: async () => "bootstrap",
        },
      });
      if (!result.ok) throw new Error(`shared ${kind} recovery failed: ${result.reason}`);
      recoveryResults.push(result);
    }
    log("utilities_verified", { recoveryResults, notifications: await bridgeJson("/city/notifications?limit=100") });
    const utilityNotifications = record(await bridgeJson("/city/notifications?limit=100"));
    const countsByType = record(utilityNotifications.countsByType);
    if (
      Number(countsByType["Pipeline Not Connected"] ?? 0) > 0 ||
      Number(countsByType["Powerline Not Connected - Low"] ?? 0) > 0
    ) {
      throw new Error(`utility network readback has disconnected local networks: ${JSON.stringify(countsByType)}`);
    }
    await capture("02-utilities", selected.connection.node.position, 900);

    const entry = { x: selected.connection.node.position.x, z: selected.connection.node.position.z };
    const blockAxis = add(entry, selected.layout.forward, 128);
    const zoneCenters = [add(blockAxis, selected.layout.right, -40), add(blockAxis, selected.layout.right, 40)];
    const zoneCatalog = record(await bridgeJson("/zones"));
    const zoneEntries = Array.isArray(zoneCatalog.zones) ? zoneCatalog.zones.map(record) : [];
    const residentialZones = zoneEntries
      .filter((zone) => zone.areaType === "Residential" && zone.office !== true && zone.locked !== true)
      .filter((zone) => Number(zone.spawnableBuildingCount ?? 0) > 0)
      .sort((a, b) => Number(b.spawnableBuildingCount ?? 0) - Number(a.spawnableBuildingCount ?? 0));
    const residentialZone = residentialZones.find((zone) => zone.name === "Residential Low") ?? residentialZones[0];
    if (!residentialZone || typeof residentialZone.name !== "string") {
      throw new Error(`no unlocked residential zone has spawnable building prefabs: ${JSON.stringify(zoneEntries)}`);
    }
    log("residential_zone_selected", {
      name: residentialZone.name,
      spawnableBuildingCount: residentialZone.spawnableBuildingCount,
      candidates: residentialZones.map((zone) => ({
        name: zone.name,
        spawnableBuildingCount: zone.spawnableBuildingCount,
      })),
    });
    await execute(
      "residential_zoning",
      zoneCenters.map((center) => ({ type: "zone", zone: residentialZone.name, x: center.x, z: center.z, radius: 44 })),
    );
    const zoning = record(await bridgeJson(`/city/zoning?x=${blockAxis.x}&z=${blockAxis.z}&radius=150`));
    if (Number(zoning.zonedCells ?? 0) <= 0) throw new Error("zoning readback found zero painted cells");
    log("zoning_verified", zoning);
    await capture("03-zoning", selected.connection.node.position, 650);

    const deadline = Date.now() + 10 * 60_000;
    let success = false;
    let finalEvidence: JsonObject = {};
    for (let chunk = 1; chunk <= 12 && Date.now() < deadline; chunk++) {
      await runHours(2);
      const [currentOverview, buildings, residentialBuildings, services, notifications, currentZoning] =
        await Promise.all([
          bridgeJson("/city/overview"),
          bridgeJson("/city/buildings?limit=500"),
          bridgeJson("/city/buildings?query=Residential&limit=500"),
          bridgeJson("/city/services"),
          bridgeJson("/city/notifications?limit=200"),
          bridgeJson(`/city/zoning?x=${blockAxis.x}&z=${blockAxis.z}&radius=180`),
        ]);
      finalEvidence = {
        chunk,
        overview: currentOverview,
        buildings,
        residentialBuildings,
        services,
        notifications,
        zoning: currentZoning,
      };
      log("growth_check", finalEvidence);
      const population = Number(record(currentOverview).population ?? 0);
      const totalResidentialBuildings = Number(record(residentialBuildings).totalMatches ?? 0);
      if (population > 0 && totalResidentialBuildings > 0) {
        success = true;
        break;
      }
    }
    await callJson("cs2_run_simulation", { cancel: true });
    await capture(success ? "04-success" : "04-no-growth", selected.connection.node.position, 650);
    if (!success) throw new Error(`bootstrap did not reach population > 0: ${JSON.stringify(finalEvidence)}`);
    await callJson("cs2_save_game", { name: `AI Mayor Bootstrap Success ${saveLabel}` });
    log("bootstrap_success", finalEvidence);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
