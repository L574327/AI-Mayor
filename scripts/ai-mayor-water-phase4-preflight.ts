/**
 * Water Phase 4 — the scoped-utility preflight, READ-ONLY.
 *
 * The water project identity and its ROAD are already admitted and delivered
 * (Phase 2). This re-proves, against the running game and the real durable
 * store, everything Phase 5 needs before the first native water command:
 *
 *   1. the durable world is activated for the current native session;
 *   2. the admitted tranche is at ROAD_DELIVERED and the ROAD it delivered is
 *      still certified AND still present in the CURRENT world (rebound);
 *   3. the water first-placement admission reaches `prepare()` — the same
 *      production boundary K05 uses — and admits a bounded execution scope for
 *      a `GroundwaterPumpingStation01` connected by `Small Water Pipe`;
 *   4. nothing in the reservation already is that facility or that pipe.
 *
 * Nothing here is a new code path: it is `createV2FoundationPorts`,
 * `projectAdmission.ensureFirstProject()`, `certifyDeliveredRoad`,
 * `firstFacilityPlacementDurability`, `buildUtilityPreparationInput`,
 * `greenfieldUtilityBootstrap.prepare` and `assertGreenfieldUtilityScope`.
 *
 * Safety:
 *   - the durable store handed to the foundation ports is an in-memory copy of
 *     the live store, so the live electron-store file is never written;
 *   - the live store file is hashed before and after and must be byte-identical;
 *   - the MCP call log is checked afterwards for native action tools, so a
 *     `prepare` that quietly reached a mutation fails the run;
 *   - the durable command journal must still hold exactly the commands it
 *     started with.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { createMemoryDurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { V2_GATE1_STATE_SCHEMA_VERSION } from "../src/main/services/ai-mayor/v2/gate1";
import { assertGreenfieldUtilityScope } from "../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { firstFacilityPlacementDurability } from "../src/main/services/ai-mayor/v2/utility-placement-durability";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_PHASE4_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase4-preflight.json";
/** The electron-store key the live durable state lives under. Kept as a literal so this script never imports electron-store. */
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");

/** The facility and pipe this slice is allowed to place. Nothing else is admitted. */
const WATER_FACILITY_PREFAB = "GroundwaterPumpingStation01";
const WATER_PIPE_PREFAB = "Small Water Pipe";

/** Native tools that mutate the world. Any of these appearing in the call log fails the run. */
const NATIVE_MUTATION_TOOLS = new Set([
  "cs2_save_game",
  "cs2_build_road",
  "cs2_mayor_execute_actions",
  "cs2_run_simulation",
  "cs2_bulldoze",
  "cs2_build",
  "cs2_zone",
  "cs2_place_building",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const sha256 = (file: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const sameRef = (left: { index: number; version: number }, right: { index: number; version: number }) =>
  left.index === right.index && left.version === right.version;

async function main() {
  const storeHashBefore = sha256(liveStorePath);
  const envelope = JSON.parse(fs.readFileSync(liveStorePath, "utf8")) as Record<string, unknown>;
  const liveState = envelope[LIVE_STATE_KEY];
  if (typeof liveState !== "object" || liveState === null) throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  const liveCommands = Array.isArray(record(liveState).commands) ? (record(liveState).commands as unknown[]).length : -1;

  const client = new Client({ name: "5ire-ai-mayor-water-phase4-preflight", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

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

  const report: Record<string, unknown> = {
    serverPath,
    liveStorePath,
    startedAt: new Date().toISOString(),
    mode: "READ_ONLY",
    facilityPrefab: WATER_FACILITY_PREFAB,
    pipePrefab: WATER_PIPE_PREFAB,
  };
  const verdict: Record<string, unknown> = {};
  report.verdict = verdict;
  let failed = false;
  try {
    // --- Authoritative world preflight (read only) --------------------------
    const gameState = parseV2McpJson(await client.callTool({ name: "cs2_game_state", arguments: {} }));
    const game = record(gameState);
    const world = record(game.world);
    const simulation = record(game.simulation);
    report.livePreflight = {
      gameMode: game.gameMode ?? null,
      cityLoaded: game.cityLoaded ?? null,
      isLoading: game.isLoading ?? null,
      worldReady: world.worldReady ?? null,
      paused: simulation.paused ?? null,
      nativeOperationBusy: world.nativeOperationBusy ?? null,
      worldId: world.worldId ?? null,
      generation: world.generation ?? null,
      checkpointId: world.checkpointId ?? null,
    };
    if (
      game.gameMode !== "Game" ||
      game.cityLoaded !== true ||
      game.isLoading !== false ||
      world.worldReady !== true ||
      simulation.paused !== true
    ) {
      throw new Error("LIVE_PREFLIGHT_NOT_READY");
    }

    // --- In-memory durability seeded from the live store ---------------------
    const durableStorage = createMemoryDurableStateStorage(liveState);
    const ports = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: durableStorage });
    const durability = ports.durability;
    const projectAdmission = ports.projectAdmission;
    if (!durability || !projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");

    const activation = durability.activate(gameState);
    const durablyActivated = durability.isExecutionDurablyActivated(activation);
    report.liveActivation = {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      durablyActivated,
      worldId: activation.world.worldId,
      generation: activation.world.generation,
      checkpointId: activation.world.checkpointId,
      worldEpochId: activation.world.worldEpochId,
    };
    verdict.DURABLE_WORLD_ACTIVATED = durablyActivated ? "YES" : "NO";

    // --- The admitted water identity, resumed not re-minted ------------------
    const admission = await projectAdmission.ensureFirstProject();
    const state = admission.state;
    report.admission = {
      status: admission.status,
      gate1SchemaVersion: state.schemaVersion,
      stage: state.tranche.stage,
      intentId: state.intent.id,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      reservationRef: state.tranche.reservationRef,
      utilityReservation: state.project.utilityReservation,
      target: state.tranche.target,
      maximumBudget: state.project.maximumBudget,
      utilityExecution: state.tranche.utilityExecution ?? null,
      taskStates: state.tasks.map((task) => ({ kind: task.kind, status: task.status, attempts: task.attempts })),
    };
    if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) throw new Error("WATER_PHASE4_GATE1_STATE_UNAVAILABLE");
    verdict.WATER_PROJECT_ADMITTED = admission.status === "ALREADY_ADMITTED" ? "YES" : admission.status;
    verdict.ROAD_DELIVERED = state.tranche.stage === "ROAD_DELIVERED" ? "YES" : "NO";

    // --- The certified ROAD, re-proved against the CURRENT world -------------
    const deliveredRoad = certifyDeliveredRoad({ state, world: activation.world, journal: durability.commandJournal });
    report.certifiedRoad = {
      status: deliveredRoad.status,
      target: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.target : null,
      refs: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.refs : null,
      reason: deliveredRoad.status === "CERTIFIED" ? null : deliveredRoad.reason,
    };

    // The current world's roads, read straight from the Bridge. An entity id is
    // not an identity: the certified ref must still be a road in THIS world.
    const listed = record(parseV2McpJson(await client.callTool({ name: "cs2_list_roads", arguments: { limit: 500 } })));
    const currentRoads = (Array.isArray(listed.roads) ? listed.roads : []).map(record);
    report.currentWorldRoads = { returned: currentRoads.length, totalMatches: listed.totalMatches ?? null, truncated: listed.truncated ?? null };
    const rebound = deliveredRoad.status === "CERTIFIED"
      ? currentRoads.find((road) => {
          const entity = record(road.entity);
          return sameRef(
            { index: Number(entity.index), version: Number(entity.version) },
            deliveredRoad.target.entity,
          );
        })
      : undefined;
    report.currentRoadRebind = rebound
      ? { found: true, prefab: rebound.prefab ?? null, position: rebound.position ?? null }
      : { found: false };
    verdict.CURRENT_ROAD_REBOUND = deliveredRoad.status === "CERTIFIED" && rebound ? "YES" : "NO";

    // --- The water first-placement admission ---------------------------------
    const overview = record(parseV2McpJson(await client.callTool({ name: "cs2_city_overview", arguments: {} })));
    const treasury = Number(overview.treasury);
    report.treasury = Number.isFinite(treasury) ? treasury : null;

    if (deliveredRoad.status === "CERTIFIED" && Number.isFinite(treasury)) {
      const firstFacilityPlacement = firstFacilityPlacementDurability(
        durability.utilityPlacementOperations({
          projectId: state.project.id,
          trancheId: state.tranche.id,
          reservationRef: state.tranche.reservationRef,
          utilityKind: "water",
        }),
      );
      report.firstFacilityPlacement = firstFacilityPlacement;
      const preparation = buildUtilityPreparationInput({
        state,
        world: activation.world,
        treasury,
        kind: "water",
        certifiedRoad: deliveredRoad.target,
        certifiedRoadRefs: deliveredRoad.refs,
        firstFacilityPlacement,
      });
      report.waterAdmission = {
        kind: preparation.kind,
        recipe: preparation.facilityPlacementAuthorization?.recipe ?? null,
        maximumPlacements: preparation.facilityPlacementAuthorization?.maximumPlacements ?? null,
        targetRoad: preparation.facilityPlacementAuthorization?.targetRoad ?? null,
        certifiedRoadRefs: preparation.facilityPlacementAuthorization?.certifiedRoadRefs ?? null,
        spatialEnvelope: preparation.spatialEnvelope,
        maximumSpend: preparation.maximumSpend,
        topologyRevision: preparation.topologyRevision,
      };
      verdict.WATER_ADMISSION_PASS = preparation.facilityPlacementAuthorization ? "YES" : "NO";

      const prepared = await ports.greenfieldUtilityBootstrap.prepare(preparation);
      report.waterPrepare = {
        status: prepared.status,
        reason: "reason" in prepared ? prepared.reason : null,
        mode: "mode" in prepared ? prepared.mode : null,
        planKind: "plan" in prepared && prepared.plan ? prepared.plan.kind : null,
        planPrefab: "plan" in prepared && prepared.plan ? prepared.plan.prefab : null,
        planPosition: "plan" in prepared && prepared.plan ? prepared.plan.position : null,
        constructionCost: "plan" in prepared && prepared.plan ? prepared.plan.constructionCost : null,
        expectedCapacity: "plan" in prepared && prepared.plan ? prepared.plan.expectedCapacity : null,
        siteEvidence: "plan" in prepared && prepared.plan ? prepared.plan.siteEvidence : null,
        connectionPrefab: "plan" in prepared && prepared.plan && prepared.plan.connection ? prepared.plan.connection.prefab : null,
        connection: "plan" in prepared && prepared.plan ? prepared.plan.connection : null,
        serviceRoads: "plan" in prepared && prepared.plan ? (prepared.plan.serviceRoads ?? []) : [],
        targetServiceEntry: "targetServiceEntry" in prepared ? prepared.targetServiceEntry : null,
      };
      report.waterPrepareRaw = prepared;
      verdict.WATER_PREPARE_STATUS = prepared.status;

      if (prepared.status === "READY" && prepared.mode === "GREENFIELD_FIRST_PLACEMENT") {
        const scope = prepared.executionScope;
        let scopeValid = true;
        let scopeError: string | null = null;
        try {
          assertGreenfieldUtilityScope(scope);
        } catch (error) {
          scopeValid = false;
          scopeError = error instanceof Error ? error.message : String(error);
        }
        report.executionScope = {
          projectId: scope.projectId,
          trancheId: scope.trancheId,
          worldId: scope.worldId,
          worldEpochId: scope.worldEpochId,
          generation: scope.generation,
          topologyRevision: scope.topologyRevision,
          executionMechanismRevision: scope.executionMechanismRevision ?? null,
          certifiedRoadRefs: scope.certifiedRoadRefs,
          targetServiceEntry: scope.targetServiceEntry,
          spatialEnvelope: scope.spatialEnvelope,
          maximumSpend: scope.maximumSpend,
          treasury: scope.treasury,
          scopeValid,
          scopeError,
        };
        verdict.WATER_SCOPE_VALID = scopeValid ? "YES" : "NO";
        verdict.WATER_FACILITY_PREFAB_MATCH = prepared.plan.prefab === WATER_FACILITY_PREFAB ? "YES" : "NO";
        verdict.WATER_PIPE_PREFAB_MATCH =
          prepared.plan.connection.prefab === WATER_PIPE_PREFAB ? "YES" : "NO";

        // --- The groundwater source, read from the current terrain -----------
        const planPosition = prepared.plan.position;
        const detail = record(
          parseV2McpJson(
            await client.callTool({
              name: "cs2_spatial",
              arguments: {
                mode: "detail",
                x: planPosition.x,
                z: planPosition.z,
                radius: 64,
                resolution: 16,
              },
            }),
          ),
        );
        const terrain = record(detail.terrain);
        const groundWater = Array.isArray(terrain.groundWater) ? terrain.groundWater.map(Number) : [];
        const groundWaterPollution = Array.isArray(terrain.groundWaterPollution)
          ? terrain.groundWaterPollution.map(Number)
          : [];
        const maxGroundWater = groundWater.length ? Math.max(...groundWater) : null;
        const maxPollution = groundWaterPollution.length ? Math.max(...groundWaterPollution) : null;
        report.groundwaterSource = {
          sampleCount: groundWater.length,
          maximumGroundWater: maxGroundWater,
          maximumPollution: maxPollution,
          centreGroundWater: groundWater[0] ?? null,
          centrePollution: groundWaterPollution[0] ?? null,
        };
        verdict.GROUNDWATER_SOURCE_VALID =
          maxGroundWater !== null && maxGroundWater > 0 && maxPollution === 0 ? "YES" : "NO";

        // --- Duplicate risk, read from the current world ---------------------
        const buildings = record(
          parseV2McpJson(await client.callTool({ name: "cs2_list_buildings", arguments: { limit: 500 } })),
        );
        const listedBuildings = (Array.isArray(buildings.buildings) ? buildings.buildings : []).map(record);
        report.currentWorldBuildings = {
          returned: listedBuildings.length,
          totalMatches: buildings.totalMatches ?? null,
          truncated: buildings.truncated ?? null,
        };
        const envelope = scope.spatialEnvelope;
        const inEnvelope = (x: number, z: number) =>
          Math.hypot(x - envelope.center.x, z - envelope.center.z) <= envelope.radius;
        const duplicateFacilities = listedBuildings.filter((building) => {
          if (building.prefab !== WATER_FACILITY_PREFAB) return false;
          const position = record(building.position);
          return inEnvelope(Number(position.x), Number(position.z));
        });
        report.duplicateFacilities = duplicateFacilities.map((building) => ({
          prefab: building.prefab,
          entity: building.entity ?? null,
          position: building.position ?? null,
        }));
        verdict.DUPLICATE_FACILITY_RISK = duplicateFacilities.length === 0 ? "NO" : "YES";

        // A duplicate pipe would be a water-pipe prefab edge already inside the
        // reservation. The reservation holds no facility yet, so any such edge is
        // an unexplained one this slice must not build beside.
        const reservationDetail = record(
          parseV2McpJson(
            await client.callTool({
              name: "cs2_spatial",
              arguments: {
                mode: "detail",
                x: envelope.center.x,
                z: envelope.center.z,
                radius: Math.max(64, envelope.radius),
                resolution: 128,
              },
            }),
          ),
        );
        const reservationEdges = (Array.isArray(record(reservationDetail.roadGraph).edges)
          ? (record(reservationDetail.roadGraph).edges as unknown[])
          : []
        ).map(record);
        const duplicatePipes = reservationEdges.filter((edge) => edge.prefab === WATER_PIPE_PREFAB);
        report.reservationEdges = {
          count: reservationEdges.length,
          prefabs: [...new Set(reservationEdges.map((edge) => String(edge.prefab ?? "")))].sort(),
        };
        report.duplicatePipes = duplicatePipes.map((edge) => ({ prefab: edge.prefab, entity: edge.entity ?? null }));
        verdict.DUPLICATE_PIPE_RISK = duplicatePipes.length === 0 ? "NO" : "YES";

        // The water service itself must not already be certified: this slice is
        // the FIRST water native attempt, not a continuation.
        const snapshot = record(parseV2McpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} })));
        const water = record(record(snapshot.utilities).water);
        report.observedWaterUtility = water;
        verdict.WATER_CAPACITY_BEFORE = typeof water.capacity === "number" ? water.capacity : null;
        verdict.WATER_SERVICE_ALREADY_CERTIFIED = (Number(water.capacity) > 0) ? "YES" : "NO";
      } else {
        verdict.WATER_SCOPE_VALID = "NOT_REACHED";
      }
    } else {
      verdict.WATER_ADMISSION_PASS = "NO";
    }

    // --- Read-only proof ----------------------------------------------------
    const nativeMutationCalls = calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name));
    const storeHashAfter = sha256(liveStorePath);
    report.nativeMutationCalls = nativeMutationCalls.map((call) => call.name);
    report.liveStoreUnchanged = storeHashBefore !== null && storeHashBefore === storeHashAfter;
    report.liveStoreSha256 = storeHashBefore;
    report.durableStoreAfter = {
      commands: durability.snapshot().commands.length,
      journalPosition: durability.snapshot().journalPosition,
      commandsUnchanged: durability.snapshot().commands.length === liveCommands,
    };
    if (nativeMutationCalls.length > 0) throw new Error("WATER_PHASE4_EXECUTED_A_NATIVE_MUTATION");
    if (!report.liveStoreUnchanged) throw new Error("WATER_PHASE4_WROTE_TO_THE_LIVE_STORE");
    if (!(report.durableStoreAfter as { commandsUnchanged: boolean }).commandsUnchanged) {
      throw new Error("WATER_PHASE4_ADDED_A_DURABLE_COMMAND");
    }
    verdict.NATIVE_MUTATIONS = nativeMutationCalls.length;
    verdict.LIVE_STORE_UNCHANGED = report.liveStoreUnchanged ? "YES" : "NO";
    verdict.FORCED_SAVE_COUNT = calls.filter((call) => call.name === "cs2_save_game").length;
  } catch (error) {
    failed = true;
    report.failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      nativeMutationCalls: calls.filter((call) => NATIVE_MUTATION_TOOLS.has(call.name)).map((call) => call.name),
    };
  } finally {
    report.callLog = calls.map((call) => `${call.name}${record(call.args).mode ? `:${record(call.args).mode}` : ""}`);
    report.finishedAt = new Date().toISOString();
    await fsPromises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fsPromises.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
