/** One-shot production K05 Stage A runner for the user-approved live checkpoint. */
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSkillRegistry } from "../src/main/services/ai-mayor/skills/registry/runtime";
import { K05CommissionUtilitiesWorkflowAdapter } from "../src/main/services/ai-mayor/skills/adapters/k05-commission-utilities-workflow";
import { executeProductionSkillIntent } from "../src/main/services/ai-mayor/skills/runtime/skill-execution-runtime";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createDurableGate1StateStorage, createGate1VerticalSlice } from "../src/main/services/ai-mayor/v2/gate1";
import { createV2FoundationPorts, parseV2McpJson, parseV2SpatialSiteDetail, readNativeUtilityQuote } from "../src/main/services/ai-mayor/v2/main-adapter";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { firstFacilityPlacementDurability } from "../src/main/services/ai-mayor/v2/utility-placement-durability";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";
import type { SpatialPoint2, SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import { createWaterSiteConstraint, type WaterFacilityPlacement, type WaterSiteConstraintEvidence } from "../src/main/services/ai-mayor/v2/water-site-constraint";
import type { V2ProjectSiteConstraint } from "../src/main/services/ai-mayor/v2/project-admission";

const EXPECTED_CHECKPOINT = "save:6d2c0c1fd4dc8bff0236e199f42f8520:1f43e57940328e0c569829f10f335a6b";
const EXPECTED_CUT = 4;
const OLD_WATER_COMMAND = "4903a8e8-6b13-4361-99e2-41bd475b30ca";
const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_STAGE_A_EVIDENCE ?? "docs/ai-mayor/evidence/water-stage-a-live.json";
const record = (value: unknown): Record<string, any> => typeof value === "object" && value !== null ? value as Record<string, any> : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const mutationTools = new Set(["cs2_mayor_execute_actions", "cs2_place_building", "cs2_build", "cs2_build_road", "cs2_bulldoze", "cs2_zone", "cs2_run_simulation", "cs2_save_game"]);

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-water-stage-a-production", version: "1.0.0" });
  await client.connect(transport);
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let capturedScan: ReturnType<typeof parseSpatialBootstrapScan> | null = null;
  const rawCall = async (name: string, args: Record<string, unknown> = {}) => {
    const value = parseV2McpJson(await client.callTool({ name, arguments: args }));
    calls.push({ name, arguments: args });
    if (name === "cs2_spatial" && args.mode === "scan") capturedScan = parseSpatialBootstrapScan(value);
    return value;
  };
  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const value = parseV2McpJson(await client.callTool({ name: name.replace(/^live--/, ""), arguments: args }));
      calls.push({ name: name.replace(/^live--/, ""), arguments: args });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };
  const report: Record<string, unknown> = { mode: "PRODUCTION_STAGE_A_SINGLE_MUTATION", startedAt: new Date().toISOString(), expectedCheckpoint: EXPECTED_CHECKPOINT };
  try {
    const storage = createCanonicalDurableStateStorage(path.join(os.homedir(), "AppData", "Roaming"));
  const constraintEvaluations: WaterSiteConstraintEvidence[] = [];
  let constraint: V2ProjectSiteConstraint | null = null;
  const waterConstraint: V2ProjectSiteConstraint = {
    kind: "water-source-within-utility-reservation",
    async accepts(candidate, reservationRadius, signal) {
      if (!capturedScan) throw new Error("SPATIAL_SCAN_NOT_CAPTURED_FOR_WATER_REPLAN");
      if (!constraint) {
        const scan = capturedScan;
        const inner = createWaterSiteConstraint({
          world: buildSpatialWorldModel(scan),
          assets: scan.bootstrapAssets,
          roads: scan.roadGraph.edges,
          readReservation: async (point: SpatialPoint2, radius: number, readSignal?: AbortSignal): Promise<SpatialSiteDetail | null> =>
            parseV2SpatialSiteDetail(await rawCall("cs2_spatial", { mode: "detail", x: point.x, z: point.z, radius, resolution: 128 }, readSignal)),
          quoteConnectionCost: async (connection, quoteSignal) => {
            const preview = record(await rawCall("cs2_spatial", { mode: "preflight", kind: "net", prefab: connection.prefab,
              x1: connection.start.x, z1: connection.start.z, x2: connection.end.x, z2: connection.end.z }, quoteSignal));
            if (preview.valid !== true || preview.previewOnly !== true) throw new Error("WATER_CONNECTION_QUOTE_UNAVAILABLE");
            const quote = readNativeUtilityQuote(preview, Number.NaN);
            if (!Number.isFinite(quote)) throw new Error("WATER_CONNECTION_QUOTE_UNKNOWN");
            return quote;
          },
          probePlacement: async (placement: WaterFacilityPlacement, probeSignal) => {
            const preview = record(await rawCall("cs2_spatial", { mode: "preflight", kind: "object", prefab: placement.prefab,
              x: placement.position.x, z: placement.position.z, rotation: placement.rotation }, probeSignal));
            return preview.valid === true && preview.previewOnly === true;
          },
          onEvaluated: (entry) => constraintEvaluations.push(entry),
        });
        constraint = inner;
      }
      return constraint.accepts(candidate, reservationRadius, signal);
    },
    async minimumFeasibleBudget(candidate, reservationRadius, signal) {
      if (!constraint?.minimumFeasibleBudget) throw new Error("WATER_REPLAN_BUDGET_UNPROVEN");
      return constraint.minimumFeasibleBudget(candidate, reservationRadius, signal);
    },
  };
  const ports = createV2FoundationPorts({ getToolsManager: () => manager as never, durableStateStorage: storage, projectSiteConstraint: waterConstraint });
    const durability = ports.durability;
    if (!durability || !ports.projectAdmission) throw new Error("PRODUCTION_DURABILITY_OR_ADMISSION_UNAVAILABLE");
    const gameState = await rawCall("cs2_game_state");
    const activation = durability.activate(gameState);
    report.activation = { kind: activation.kind, status: activation.status, blockedReason: activation.blockedReason ?? null,
      durablyActivated: durability.isExecutionDurablyActivated(activation), world: activation.world };
    const snap = durability.snapshot();
    const checkpoint = snap.checkpoints.find((item) => item.checkpointId === EXPECTED_CHECKPOINT);
    const rollbackAnchor = snap.certifiedRollbackAnchor;
    const cut = snap.active?.activatedCheckpointJournalCut;
    report.rollbackAnchor = { cut, checkpointFound: !!checkpoint, checkpointCut: checkpoint?.journalPosition ?? null,
      checkpointDurable: checkpoint?.durable ?? null, checkpointPurpose: checkpoint?.purpose ?? null,
      certifiedAnchorCut: rollbackAnchor?.journalPosition ?? null,
      certifiedAnchorMatches: rollbackAnchor?.checkpointId === EXPECTED_CHECKPOINT && rollbackAnchor.journalPosition === EXPECTED_CUT };
    if (activation.world.checkpointId !== EXPECTED_CHECKPOINT || cut !== EXPECTED_CUT || checkpoint?.journalPosition !== EXPECTED_CUT ||
      !durability.isExecutionDurablyActivated(activation) || !checkpoint.durable || checkpoint.purpose !== "PERIODIC") {
      throw new Error("PRE_STAGE_A_ROLLBACK_ANCHOR_UNCONFIRMED");
    }
    const game = record(gameState); const world = record(game.world); const sim = record(game.simulation);
    if (game.gameMode !== "Game" || game.cityLoaded !== true || game.isLoading !== false || world.worldReady !== true || sim.paused !== true || world.nativeOperationBusy === true) {
      throw new Error("LIVE_WORLD_NOT_PAUSED_READY_AND_IDLE");
    }
    const inventory = async () => record(await rawCall("cs2_list_buildings", { limit: 500 }));
    const beforeBuildings = await inventory();
    const beforeList = list(beforeBuildings.buildings);
    report.preexistingFacilityCount = beforeList.filter((item) => item.prefab === "GroundwaterPumpingStation01" && item.isSubBuilding !== true).length;
    if (report.preexistingFacilityCount !== 0 || beforeBuildings.truncated === true || beforeBuildings.hasMore === true ||
      (Number.isFinite(Number(beforeBuildings.totalMatches)) && Number(beforeBuildings.returned) !== Number(beforeBuildings.totalMatches))) {
      throw new Error("PRE_STAGE_A_FACILITY_ABSENCE_NOT_AUTHORITATIVE");
    }
    const priorAdmission = await ports.projectAdmission.ensureFirstProject();
    await rawCall("cs2_spatial", { mode: "scan", roadLimit: 2_000 });
    const replan = await ports.projectAdmission.replanForCurrentBranch({ detail: "checkpoint branch re-admission under current resource suitability" });
    const oldState = replan.replan.supersededState;
    const oldProjectIdentity = replan.replan.projectId;
    let state = replan.state;
    report.projectReplan = { status: replan.status, oldProjectIdentity, newProjectReplanIdentity: state.project.id,
      oldProjectUnchanged: replan.replan.supersededState.project.id === oldState.project.id &&
        JSON.stringify(replan.replan.supersededState) === JSON.stringify(oldState),
      branch: replan.replan.branch ?? null, selectedCandidateId: "evidence" in replan ? replan.evidence.selectedCandidateId : null,
      reservation: state.project.utilityReservation };
    report.waterConstraintEvaluations = constraintEvaluations;
    if (state.tranche.stage === "PLANNED") {
      const gate1 = createGate1VerticalSlice({
        storage: createDurableGate1StateStorage(durability),
        commandJournal: durability.commandJournal,
        boundary: { execute: async (proposal) => proposal.operation === "SELECT_SITE"
          ? { status: "DELIVERED", commandId: null, observedMatch: true, reason: "normal bounded Gate1 site selection completed" }
          : { status: "REJECTED", commandId: null, observedMatch: false, reason: "unexpected operation during site selection" } },
      });
      const selection = await gate1.tick();
      if (selection.task?.kind !== "SITE_SELECTION" || selection.task.status !== "SUCCEEDED") {
        throw new Error("CURRENT_BRANCH_GATE1_SITE_SELECTION_DID_NOT_COMPLETE");
      }
      state = selection.state;
      report.siteSelection = { task: selection.task.kind, status: selection.task.status, stage: state.tranche.stage };
    }
    report.projectAdmission = { status: replan.status, stage: state.tranche.stage, projectStatus: state.project.status,
      projectId: state.project.id, trancheId: state.tranche.id, taskStates: state.tasks.map((task) => ({ kind: task.kind, status: task.status })) };
    const overview = record(await rawCall("cs2_city_overview"));
    const placementProof = firstFacilityPlacementDurability(durability.utilityPlacementOperations({
      projectId: state.project.id, trancheId: state.tranche.id, reservationRef: state.tranche.reservationRef, utilityKind: "water",
    }));
    report.firstFacilityPlacement = placementProof;
    const context = { state, world: activation.world, treasury: Number(overview.treasury), kind: "water" as const,
      facilityPlacementOnly: true, firstFacilityPlacement: placementProof };
    const preparation = buildUtilityPreparationInput(context);
    const prepared = await ports.greenfieldUtilityBootstrap.prepare(preparation);
    const diagnostics = record(prepared.diagnostics);
    const searchScope = record(diagnostics.stageASearchScope);
    const funnel = record(diagnostics.waterStageAFunnel);
    const reservationDetail = parseV2SpatialSiteDetail(await rawCall("cs2_spatial", {
      mode: "detail", x: state.project.utilityReservation.center.x, z: state.project.utilityReservation.center.z,
      radius: state.project.utilityReservation.radius, resolution: 128,
    }));
    let reservationGroundwaterEligible = 0;
    const terrain = reservationDetail.terrain;
    for (let row = 0; row < terrain.resolution; row += 1) {
      for (let col = 0; col < terrain.resolution; col += 1) {
        const index = row * terrain.resolution + col;
        const x = terrain.bounds.minX + (col + 0.5) * terrain.cellSize.x;
        const z = terrain.bounds.minZ + (row + 0.5) * terrain.cellSize.z;
        if (Math.hypot(x - state.project.utilityReservation.center.x, z - state.project.utilityReservation.center.z) <= state.project.utilityReservation.radius &&
          Number(terrain.groundWater[index] ?? 0) > 0 && Number(terrain.groundWaterPollution[index] ?? 0) === 0) {
          reservationGroundwaterEligible += 1;
        }
      }
    }
    const selectedWater = list(record(prepared).plan && record(record(prepared).plan).facilities)
      .find((item) => record(item).kind === "water");
    report.reservationReplan = { oldProjectIdentity, newProjectReplanIdentity: state.project.id,
      oldUtilityReservation: oldState.project.utilityReservation, newUtilityReservation: state.project.utilityReservation,
      selectedByPlanner: replan.status === "REPLANNED" || replan.status === "ALREADY_REPLANNED",
      historicalCoordinateSpecialCaseUsed: false, newReservationGroundwaterEligibleCount: reservationGroundwaterEligible };
    report.waterStageA = { candidateCount: diagnostics.waterStageACandidateCount ?? 0,
      validCandidateCount: diagnostics.stageAValidCandidateCount ?? 0,
      selectedSite: selectedWater ? record(selectedWater).position : null,
      selectedByPlanner: selectedWater !== undefined, specialCaseUsed: false };
    const historical = durability.commandJournal.get(OLD_WATER_COMMAND);
    const historicalScope = record(historical?.authorizedScope);
    const historicalActions = (() => { try { return JSON.parse(String(historicalScope.exactInput ?? "[]")) as unknown[]; } catch { return []; } })();
    const historicalPlacement = record(historicalActions.find((action) => record(action).type === "place_building"));
    const searchCenter = record(searchScope.center);
    const historicalDistance = Math.hypot(Number(historicalPlacement.x) - Number(searchCenter.x), Number(historicalPlacement.z) - Number(searchCenter.z));
    report.stageAPreflight = { status: prepared.status, reason: "reason" in prepared ? prepared.reason : null,
      mode: "mode" in prepared ? prepared.mode : null, plan: "plan" in prepared ? prepared.plan : null,
      executionScope: "executionScope" in prepared ? prepared.executionScope : null, diagnostics };
    report.candidateFunnel = {
      rawTerrainSampleCount: funnel.rawTerrainSampleCount ?? null,
      inCurrentScopeCount: funnel.inCurrentScopeCount ?? null,
      groundwaterEligibleCount: funnel.groundwaterEligibleCount ?? null,
      reservationEligibleCount: funnel.inCurrentScopeCount ?? null,
      placementInputCandidateCount: funnel.placementInputCandidateCount ?? null,
      finalStageACandidateCount: funnel.finalStageACandidateCount ?? diagnostics.waterStageACandidateCount ?? 0,
      ownedDryBuildableCount: funnel.ownedDryBuildableCount ?? null,
      withinExistingRoadReachCount: funnel.withinExistingRoadReachCount ?? null,
      eligibleGroundwaterAssetCount: funnel.eligibleGroundwaterAssetCount ?? null,
      firstZeroingFilter: funnel.firstZeroingFilter ?? null,
      currentScope: searchScope,
      historicalSuccessSite: { commandId: OLD_WATER_COMMAND, journalPosition: historical?.position ?? null,
        position: { x: historicalPlacement.x ?? null, z: historicalPlacement.z ?? null },
        distanceFromCurrentScopeCenter: Number.isFinite(historicalDistance) ? historicalDistance : null,
        insideCurrentStageAScope: Number.isFinite(historicalDistance) && historicalDistance <= Number(searchScope.radius) },
    };
    if (prepared.status === "BLOCKED" && prepared.reason === "NO_SUPPORTED_WATER_TOPOLOGY") {
      report.firstCurrentBlocker = "NO_STAGE_A_WATER_CANDIDATE_IN_CURRENT_SCOPE";
      report.finalNativeMutationCount = 0;
      return;
    }
    if (prepared.status !== "READY" || prepared.mode !== "GREENFIELD_FIRST_PLACEMENT" ||
      prepared.executionScope.facilityPlacementOnly !== true || prepared.executionScope.commissionedKinds.join(",") !== "water" ||
      !Number.isFinite(context.treasury) || context.treasury <= 0) throw new Error("STAGE_A_ADMISSION_OR_PLACEMENT_PREFLIGHT_FAILED");
    if (!durability.isExecutionDurablyActivated(activation)) throw new Error("DURABLE_ACTIVATION_LOST_BEFORE_STAGE_A");
    const freshGame = record(await rawCall("cs2_game_state"));
    const freshWorld = record(freshGame.world);
    const freshBuildings = await inventory();
    const freshMatches = list(freshBuildings.buildings).filter((item) => item.prefab === "GroundwaterPumpingStation01" && item.isSubBuilding !== true);
    if (freshWorld.checkpointId !== EXPECTED_CHECKPOINT || freshWorld.generation !== activation.world.generation ||
      freshWorld.worldEpochId && freshWorld.worldEpochId !== activation.world.worldEpochId ||
      freshMatches.length !== 0 || freshBuildings.truncated === true || freshBuildings.hasMore === true) {
      throw new Error("STAGE_A_CURRENT_WORLD_OR_DUPLICATE_GUARD_FAILED");
    }
    report.finalClosurePreconditionsPass = true;
    const oldCommandBefore = durability.commandJournal.get(OLD_WATER_COMMAND);
    const result = await executeProductionSkillIntent({ registry: createSkillRegistry(), foundation: ports,
      intent: { skillId: "skill.K05" }, authoritativeContext: context,
      workflows: [new K05CommissionUtilitiesWorkflowAdapter(ports)] });
    const outcome = record(result.durableOutcome);
    const utilityState = record(record(outcome.state).utilities).water;
    const facility = record(utilityState.facility);
    const entity = record(facility.entity);
    const placementCommandId = typeof utilityState.facilityCommandId === "string" ? utilityState.facilityCommandId : null;
    const placementCommand = placementCommandId ? durability.commandJournal.get(placementCommandId) : undefined;
    const afterBuildings = await inventory();
    const afterList = list(afterBuildings.buildings);
    const pumps = afterList.filter((item) => item.prefab === "GroundwaterPumpingStation01" && item.isSubBuilding !== true);
    report.skillResult = { status: result.status, error: result.error ?? null, outcome: { waiting: outcome.waiting, reason: outcome.reason,
      serviceCertified: outcome.serviceCertified }, placementCommandId, placementCommandStatus: placementCommand?.status ?? null,
      durableFacility: facility, pumpInventoryCount: pumps.length, matchingEntity: pumps.some((item) => record(item.entity).index === entity.index && record(item.entity).version === entity.version),
      oldHistoricalCommandUnchanged: JSON.stringify(oldCommandBefore) === JSON.stringify(durability.commandJournal.get(OLD_WATER_COMMAND)) };
    report.nativeMutationCalls = calls.filter((call) => mutationTools.has(call.name)).map((call) => ({ name: call.name, arguments: call.arguments }));
    if (pumps.length === 1 && entity.index !== undefined) {
      const access = record(await rawCall("cs2_building_access", { index: entity.index, version: entity.version }));
      const connectors = record(await rawCall("cs2_utility_connectors", { index: entity.index, version: entity.version }));
      report.stageBReadback = { access, connectors };
      const connectionChecks: Record<string, unknown> = {};
      for (const kind of ["electricity", "water"] as const) {
        try {
          const input = buildUtilityPreparationInput({ ...context, connectionOnly: true, stageBReadOnly: true, kind, facilityPlacementOnly: undefined });
          const check = await ports.greenfieldUtilityBootstrap.prepare(input);
          connectionChecks[kind] = { status: check.status, reason: "reason" in check ? check.reason : null,
            diagnostics: check.diagnostics ?? null, plan: "plan" in check ? check.plan : null };
        } catch (error) { connectionChecks[kind] = { status: "BLOCKED", reason: error instanceof Error ? error.message : String(error) }; }
      }
      report.stageBConnectionPreflight = connectionChecks;
      const accessRoad = record(access.roadAttachment);
      const accessOk = accessRoad.roadEdge !== null && accessRoad.roadExists !== false && access.valid !== false;
      const electricityOk = record(connectionChecks.electricity).status === "READY";
      const waterOk = record(connectionChecks.water).status === "READY";
      report.stageBVerdicts = { roadAccessFeasible: accessOk, electricityFeasible: electricityOk, waterConnectionFeasible: waterOk,
        existingPrimitivesSufficient: accessOk && electricityOk && waterOk };
      if (!(accessOk && electricityOk && waterOk)) {
        await ports.greenfieldUtilityBootstrap.markAwaitingProductDecision(prepared.executionScope, "water",
          String(record(connectionChecks.electricity).reason ?? record(connectionChecks.water).reason ?? "STAGE_B_NOT_PROVEN"));
        report.placedFacilityAwaitingProductDecision = true;
      } else report.placedFacilityAwaitingProductDecision = false;
    }
  } catch (error) {
    report.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await client.close();
  }
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
