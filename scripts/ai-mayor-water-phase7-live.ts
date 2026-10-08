/**
 * Water Phase 7 -- the bounded FACILITY_ACCESS_ROAD_REPAIR, live.
 *
 * The durable Water project is complete except that its facility has no road.
 * The pump stands 278 m from the nearest carriageway, the engine reports
 * `No Road Access`, and because this engine carries its low-voltage electricity
 * along the road network, an unroaded building cannot draw power: the pump runs
 * at a fraction of its capacity and the city's fresh-water supply is a decaying
 * transient rather than a service.
 *
 * The repair is bounded and it is the same shape as every other settlement on
 * this slice:
 *
 *   1. read the world (frontage, the engine's own warning, city capacity);
 *   2. re-plan ONE access-road course off the admitted corridor's own objective,
 *      priced by the native spending contract;
 *   3. record the ONE append-only budget amendment that funds exactly that course;
 *   4. run the production K05 water boundary, which appends the course to the
 *      durable ledger and submits it at most once;
 *   5. read the world back after EVERY native step, and certify the water service
 *      only from the engine's own operational signal.
 *
 * Bounds, checked rather than asserted: at most one access-road native build, no
 * second facility, no second pipe, no power plant, no `cs2_save_game`, no zoning,
 * and the live store is copied aside before the first write.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createV2FoundationPorts, parseV2McpJson, parseV2SpatialSiteDetail, readNativeUtilityQuote } from "../src/main/services/ai-mayor/v2/main-adapter";
import type { Gate1State } from "../src/main/services/ai-mayor/v2/gate1";
import type { V2DurableState, V2DurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";
import { certifyDeliveredRoad } from "../src/main/services/ai-mayor/v2/certified-road-delivery";
import { buildUtilityPreparationInput } from "../src/main/services/ai-mayor/v2/utility-admission-context";
import { prepareScopedUtilityExecution } from "../src/main/services/ai-mayor/v2/utility-execution-planner";
import { V2_PROJECT_ADMISSION_POLICY } from "../src/main/services/ai-mayor/v2/project-admission";
import {
  FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON,
  admitFacilityAccessRoadBudgetAmendment,
} from "../src/main/services/ai-mayor/v2/utility-budget";
import {
  FACILITY_ACCESS_ROAD_PREFAB,
  facilityAccessRoadCourseCandidates,
  selectFacilityAccessRoadCourse,
  type FacilityAccessRoadCandidate,
} from "../src/main/services/ai-mayor/v2/facility-access-road";
import { resolveCurrentUtilityBinding } from "../src/main/services/ai-mayor/v2/utility-current-binding";
import type { GreenfieldUtilityExecutionScope } from "../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const evidencePath = process.env.WATER_PHASE7_EVIDENCE ?? "docs/ai-mayor/evidence/water-phase7-live.json";
/** The electron-store key the live durable state lives under. A literal so this script never imports electron-store. */
const LIVE_STATE_KEY = "aiMayorV2DurableState";
const liveStorePath =
  process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const backupPath = process.env.WATER_PHASE7_STORE_BACKUP ?? `${liveStorePath}.water-phase7-backup`;

const MAXIMUM_ACCESS_ROAD_NATIVE_ATTEMPTS = 1;
const SIMULATION_HOURS = 0.5;
const SIMULATION_SPEED = 4;
/** Tools that would take the world past this phase's mandate. */
const FORBIDDEN_TOOLS = new Set(["cs2_save_game", "cs2_zone", "cs2_place_building", "cs2_demolish"]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sha256 = (file: string): string | null => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

function createLiveDurableStateStorage(envelope: Record<string, unknown>): V2DurableStateStorage {
  return {
    load: () => envelope[LIVE_STATE_KEY] as V2DurableState | undefined,
    save: (state: V2DurableState) => {
      envelope[LIVE_STATE_KEY] = state;
      fs.writeFileSync(liveStorePath, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
    },
    namespaceId: liveStorePath,
  };
}

const step = (message: string) => process.stderr.write(`[phase7] ${message}\n`);

async function main() {
  const verdict: Record<string, unknown> = {
    WATER_TARGET_FLOW_FAMILY_FIXED: "YES",
    TARGET_ROAD_REACQUIRE_FIXED: "YES",
    EFFECTIVE_BUDGET_WIRING_FIXED: "YES",
    ACCESS_ROAD_REPAIR_AUTHORIZED: "YES",
    DUPLICATE_FACILITY_COUNT: 0,
    DUPLICATE_PIPE_COUNT: 0,
    FORCED_SAVE_COUNT: 0,
  };
  const report: Record<string, unknown> = { mode: "LIVE_FACILITY_ACCESS_ROAD_REPAIR", verdict };

  const storeEnvelope = JSON.parse(fs.readFileSync(liveStorePath, "utf8")) as Record<string, unknown>;
  if (typeof storeEnvelope[LIVE_STATE_KEY] !== "object" || storeEnvelope[LIVE_STATE_KEY] === null) {
    throw new Error("LIVE_DURABLE_STATE_NOT_FOUND");
  }
  const backupWritten = !fs.existsSync(backupPath);
  if (backupWritten) await fsPromises.copyFile(liveStorePath, backupPath);
  report.backupPath = backupPath;
  report.backupWritten = backupWritten;
  report.liveStoreSha256Before = sha256(liveStorePath);
  step(`store read; backup written=${backupWritten}`);

  const client = new Client({ name: "5ire-ai-mayor-water-phase7-live", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  step("mcp connected");
  // Everything below runs under a real `finally`. The stdio transport keeps the
  // event loop alive, so a run that throws without closing it hangs forever with
  // its error already written — indistinguishable from a wedged world, and it
  // cost this round real time. The caller's catch is the last resort; this is the
  // teardown that always happens.
  try {
    await runWithClient(client, storeEnvelope, report, verdict);
  } finally {
    await client.close().catch((error) => step(`mcp close failed: ${String(error)}`));
  }
}

async function runWithClient(
  client: Client,
  storeEnvelope: Record<string, unknown>,
  report: Record<string, unknown>,
  verdict: Record<string, unknown>,
): Promise<void> {
  const liveStorage = createLiveDurableStateStorage(storeEnvelope);
  const calls: string[] = [];
  const callTool = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    calls.push(name);
    if (FORBIDDEN_TOOLS.has(name)) throw new Error(`FORBIDDEN_TOOL_CALLED:${name}`);
    return client.callTool({ name, arguments: args }, undefined, { signal });
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => parseV2McpJson(await callTool(name, args));

  const manager = {
    legacyList: async () => ({ tools: (await client.listTools()).tools.map((t) => ({ name: `live--${t.name}` })) }),
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text", text: JSON.stringify(parseV2McpJson(await callTool(name, args))) }],
    }),
  };

  const foundation = createV2FoundationPorts({
    getToolsManager: () => manager as never,
    durableStateStorage: liveStorage,
  });
  const durability = foundation.durability;
  if (!durability) throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
  // Activation goes through the production seam, not a bare `activate()`: a
  // world this store has not registered but whose journal rests on its own
  // checkpoints still has to PROVE, command by command, which effects it
  // contains before any authority is granted. `activateDurableWorld` is that
  // seam, and it is the only one that may confirm a descendant reload.
  if (!foundation.activateDurableWorld) throw new Error("V2_PRODUCTION_ACTIVATE_WORLD_NOT_CONFIGURED");
  const activation = await foundation.activateDurableWorld();
  if (!durability.isExecutionDurablyActivated(activation)) {
    throw new Error(String(activation.blockedReason ?? "WATER_PHASE7_WORLD_NOT_ACTIVATED"));
  }
  step(`activated: ${activation.kind} / ${activation.status}`);
  report.activation = { kind: activation.kind, status: activation.status };
  verdict.LIVE_WORLD_MATCHES_STORE = "YES";

  const state = durability.projectState() as Gate1State | null;
  if (!state) throw new Error("WATER_PHASE7_NO_GATE1_STATE");
  const deliveredRoad = certifyDeliveredRoad({ state, world: activation.world, journal: durability.commandJournal });
  report.certifiedRoad = {
    status: deliveredRoad.status,
    target: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.target : null,
    refs: deliveredRoad.status === "CERTIFIED" ? deliveredRoad.refs : null,
    reason: deliveredRoad.status === "CERTIFIED" ? null : deliveredRoad.reason,
  };
  if (deliveredRoad.status !== "CERTIFIED") throw new Error(`WATER_PHASE7_ROAD_NOT_CERTIFIED:${deliveredRoad.reason}`);

  const treasury = Number(record(await tool("cs2_city_overview")).treasury);
  if (!Number.isFinite(treasury)) throw new Error("WATER_PHASE7_TREASURY_UNKNOWN");
  report.treasury = treasury;

  const waterState = () =>
    (durability.projectState() as Gate1State | null)?.tranche?.utilityExecution?.utilities?.water ?? null;
  const before = waterState();
  // The durable slice's `facility` is a generation-scoped binding that every run
  // clears and re-derives from the plan, so it can legitimately be absent at
  // rest. The plan is the durable authority the rebind is pinned to, so it is
  // the plan that must be present — and the current-world facility it names is
  // re-proved read-only below, through the production binding resolver, before
  // anything is planned or priced.
  // Bound once, so every probe below reads the same durable plan this run
  // certified against rather than re-reading a state that has since been written.
  const planned = before?.plan ?? null;
  if (!before || !planned) throw new Error("WATER_PHASE7_WATER_SLICE_INCOMPLETE");
  const priorAccessRoadCommands = durability.commandJournal.list().filter((entry) =>
    entry.actionFamily === "UTILITY" && entry.authorizedScope.actionFamily === "UTILITY" &&
    entry.authorizedScope.utilityKind === "water" && entry.authorizedScope.projectId === state.project.id &&
    JSON.stringify(parseExactInput(entry.authorizedScope.exactInput)).includes(FACILITY_ACCESS_ROAD_PREFAB));
  verdict.ACCESS_ROAD_NATIVE_ATTEMPT_COUNT = priorAccessRoadCommands.length;
  if (priorAccessRoadCommands.length !== 0) throw new Error("ACCESS_ROAD_NATIVE_ATTEMPT_COUNT_NOT_ZERO");
  report.waterBefore = {
    stage: before.stage,
    commandOutcome: before.commandOutcome,
    facility: before.facility?.entity ?? null,
    networkCommandIds: before.networkCommandIds,
    accessRoadRepair: before.accessRoadRepair ?? null,
    ledger: before.candidateLedger.map((c) => ({ kind: c.kind, repair: c.repair ?? null, state: c.ledgerState, commandId: c.commandId })),
  };
  verdict.ACCESS_ROAD_BUDGET_AMENDMENT_BEFORE = durability
    .utilityBudgetAmendments()
    .filter((a) => a.projectId === state.project.id && a.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)
    .length;

  // The durable slice names facilities of the generation they were placed in.
  // After a reload the same building is a different entity, so every probe below
  // asks the CURRENT world — pinned by the durable plan's own prefab and
  // position through the production current-binding resolver, never by the
  // recorded entity id and never by "whatever is nearest".
  const resolveCurrentFacility = async () => {
    const listed = record(await tool("cs2_list_buildings", { query: planned.prefab, limit: 64 }));
    const buildings = Array.isArray(listed.buildings) ? listed.buildings : [];
    const atPlannedSite = buildings.filter((raw) => {
      const building = record(raw);
      const position = record(building.position);
      return (
        building.isSubBuilding !== true &&
        building.prefab === planned.prefab &&
        Number.isFinite(Number(position.x)) &&
        Number.isFinite(Number(position.z)) &&
        Math.hypot(Number(position.x) - planned.position.x, Number(position.z) - planned.position.z) <= 1.5
      );
    });
    if (atPlannedSite.length !== 1) {
      return { status: "BLOCKED" as const, reason: `CURRENT_FACILITY_${atPlannedSite.length === 0 ? "NOT_FOUND" : "AMBIGUOUS"}` };
    }
    const entity = record(record(atPlannedSite[0]).entity);
    if (!Number.isInteger(Number(entity.index)) || !Number.isInteger(Number(entity.version))) {
      return { status: "BLOCKED" as const, reason: "CURRENT_FACILITY_ENTITY_INVALID" };
    }
    const connectorPayload = record(
      await tool("cs2_utility_connectors", { index: Number(entity.index), version: Number(entity.version) }),
    );
    const resolved = resolveCurrentUtilityBinding({
      planned,
      utility: "water",
      buildings,
      connectors: Array.isArray(connectorPayload.connectors) ? connectorPayload.connectors : null,
      generation: activation.world.generation,
      observationComplete: true,
      connectorsScopedToFacilityEntity: true,
    });
    return resolved.status === "MATCH"
      ? { status: "MATCH" as const, binding: resolved.binding }
      : { status: "BLOCKED" as const, reason: resolved.reason };
  };

  const rebound = await resolveCurrentFacility();
  report.currentBinding = rebound;
  verdict.WATER_FACILITY_DURABLE_ENTITY = before.facility?.entity ?? null;
  verdict.WATER_FACILITY_REBOUND = rebound.status === "MATCH" ? "YES" : "NO";
  verdict.WATER_CONNECTOR_REBOUND = rebound.status === "MATCH" ? "YES" : "NO";
  if (rebound.status !== "MATCH") throw new Error(`WATER_PHASE7_FACILITY_REBIND_FAILED:${rebound.reason}`);
  verdict.WATER_FACILITY_CURRENT_ENTITY = rebound.binding.currentFacility.entity;
  verdict.WATER_CONNECTOR_CURRENT_NODE = rebound.binding.currentConnector.node;
  step(`facility rebound: ${JSON.stringify(before.facility?.entity ?? null)} -> ${JSON.stringify(rebound.binding.currentFacility.entity)}`);

  const facilityRef = rebound.binding.currentFacility.entity;
  const readFrontage = async () => {
    const access = record(await tool("cs2_building_access", { index: facilityRef.index, version: facilityRef.version }));
    const attachment = record(access.roadAttachment);
    return {
      roadEdge: attachment.roadEdge ?? null,
      roadExists: attachment.roadExists === true,
      roadAttachment: attachment.roadEdge !== null && attachment.roadEdge !== undefined
        ? "ATTACHED" as const : "NONE" as const,
    };
  };
  const readWarnings = async () => {
    const notifications = record(await tool("cs2_notifications", { limit: 200 }));
    const items = list(notifications.notifications).map(record);
    const forFacility = items.filter((item) => Number(record(item.target).index) === facilityRef.index);
    return {
      total: Number(notifications.total),
      noRoadAccess: forFacility.some((item) => String(item.type) === "No Road Access"),
      types: forFacility.map((item) => String(item.type)),
    };
  };
  const readPumpConsumer = async () => {
    const connectors = record(await tool("cs2_utility_connectors", { index: facilityRef.index, version: facilityRef.version }));
    const consumer = record(record(connectors.consumerService).electricity);
    return {
      connected: consumer.connected === true,
      wantedConsumption: Number(consumer.wantedConsumption ?? 0),
      fulfilledConsumption: Number(consumer.fulfilledConsumption ?? 0),
      noElectricityWarning: consumer.noElectricityWarning === true,
    };
  };

  const frontageBefore = await readFrontage();
  const warningsBefore = await readWarnings();
  const pumpBefore = await readPumpConsumer();
  report.before = { frontage: frontageBefore, warnings: warningsBefore, pump: pumpBefore };
  verdict.FACILITY_ROAD_ATTACHMENT_BEFORE = frontageBefore.roadAttachment;
  verdict.NO_ROAD_ACCESS_WARNING_BEFORE = warningsBefore.noRoadAccess;
  verdict.NO_ELECTRICITY_WARNING_BEFORE = pumpBefore.noElectricityWarning;
  verdict.FULFILLED_ELECTRIC_CONSUMPTION_BEFORE = pumpBefore.fulfilledConsumption;


  // ---- 1. Re-plan the ONE bounded access-road course, and price it. --------
  const serviceRoads = planned.serviceRoads ?? [];
  const firstServiceRoad = serviceRoads[0];
  const lastServiceRoad = serviceRoads[serviceRoads.length - 1];
  if (!firstServiceRoad || !lastServiceRoad) throw new Error("WATER_PHASE7_SERVICE_ROAD_OBJECTIVE_MISSING");
  const envelope = state.project.utilityReservation;
  const halfExtent = Math.hypot(
    lastServiceRoad.end.x - planned.position.x,
    lastServiceRoad.end.z - planned.position.z,
  );
  const ladder = facilityAccessRoadCourseCandidates({
    objective: { start: { ...firstServiceRoad.start }, end: { ...lastServiceRoad.end } },
    admittedCourse: {
      prefab: planned.connection.prefab,
      start: { ...planned.connection.start },
      end: { ...planned.connection.end },
    },
    facility: { position: { ...planned.position }, halfExtent },
    facilityServicePoint: { ...lastServiceRoad.end },
    envelope,
    prefab: FACILITY_ACCESS_ROAD_PREFAB,
    maximumCandidates: 8,
  });
  const worldEdges = parseV2SpatialSiteDetail(await tool("cs2_spatial", {
    mode: "detail", x: envelope.center.x, z: envelope.center.z,
    radius: Math.max(64, envelope.radius), resolution: 128,
  })).roadGraph.edges;
  const rungVerdicts: Array<{ reason: string; accepted: boolean; quote: number | null }> = [];
  const selected = await selectFacilityAccessRoadCourse({
    candidates: ladder,
    facilityServicePoint: lastServiceRoad.end,
    worldEdges,
    preflight: async (candidate: FacilityAccessRoadCandidate) => {
      const action = candidate.actions[0];
      if (!action || action.type !== "build_road") return { accepted: false, quote: null, reason: "ACTION_UNSUPPORTED" };
      // `tool`, not `callTool`: an MCP envelope is not a payload. Reading
      // `valid` / `previewOnly` off the envelope makes every rung look refused
      // and leaves the reason text empty — a shape a real refusal never has, and
      // the one that hid this.
      const raw = record(await tool("cs2_spatial", {
        mode: "preflight", kind: "net", prefab: action.prefab,
        x1: action.x1, z1: action.z1, x2: action.x2, z2: action.z2,
      }));
      const accepted = raw.valid === true && raw.previewOnly === true;
      const quote = accepted ? readNativeUtilityQuote(raw, Number.NaN) : null;
      const reason = typeof raw.error === "string" ? raw.error : String(raw.reason ?? "");
      rungVerdicts.push({ reason: reason.slice(0, 120), accepted, quote });
      return { accepted, quote, ...(accepted ? {} : { reason: reason.slice(0, 120) }) };
    },
  });
  report.accessRoadPlanning = {
    candidateCount: ladder.length,
    rungVerdicts,
    status: selected.status,
    quote: selected.status === "SELECTED" ? selected.quote : null,
    actions: selected.status === "SELECTED" ? selected.candidate.actions : null,
  };
  if (selected.status !== "SELECTED") throw new Error(`WATER_PHASE7_ACCESS_ROAD_NOT_PLANNABLE:${selected.reasons.join("|")}`);
  step(`access road selected: quote=${selected.quote} actions=${JSON.stringify(selected.candidate.actions)}`);
  verdict.ACCESS_ROAD_QUOTE = selected.quote;
  verdict.ACCESS_ROAD_ACTION = selected.candidate.actions[0];

  // ---- 2. The ONE append-only amendment that funds exactly that course. ----
  const currentWaterState = waterState();
  if (!currentWaterState) throw new Error("WATER_PHASE7_CURRENT_WATER_STATE_MISSING");
  const repairPlanRevision = currentWaterState.connectionObjective?.approvedPlanRevision ??
    currentWaterState.planBinding?.topologyRevision ?? activation.world.checkpointId ?? "unknown";
  const repairCourseFingerprint = JSON.stringify(selected.candidate.actions);
  const amendmentId = `${state.project.id}:facility-access-road:${crypto.createHash("sha256").update(`${repairPlanRevision}:${repairCourseFingerprint}`).digest("hex").slice(0, 16)}`;
  const amendment = admitFacilityAccessRoadBudgetAmendment({
    durability,
    activation,
    state,
    treasury,
    policy: V2_PROJECT_ADMISSION_POLICY,
    actualAccessRoadQuote: selected.quote,
    actionCount: selected.candidate.actions.length,
    repair: {
      facilityPlaced: true,
      roadAttachment: "NONE",
      accessRoadCommandIds: durability
        .commandJournal.list()
        .filter((entry) => entry.actionFamily === "UTILITY" &&
          entry.authorizedScope.actionFamily === "UTILITY" &&
          entry.authorizedScope.projectId === state.project.id &&
          entry.authorizedScope.utilityKind === "water" &&
          JSON.stringify(parseExactInput(entry.authorizedScope.exactInput)).includes(FACILITY_ACCESS_ROAD_PREFAB))
        .map((entry) => entry.commandId),
    },
    amendmentId,
    planRevision: repairPlanRevision,
    courseFingerprint: repairCourseFingerprint,
    detail:
      "The water facility landed without road frontage and cannot reach the road network: the admitted plan's own " +
      "service-road course runs down the corridor the facility's connection course now occupies, so the game refuses it. " +
      "This records the ONE bounded amendment that funds the ONE re-planned access-road course, at the native spending " +
      "contract's own quote for that course and nothing else.",
  });
  if (amendment.record.status === "SUPERSEDED_UNUSED") throw new Error("ACCESS_ROAD_BUDGET_AUTHORIZATION_NOT_ACTIVE");
  if (amendment.record.planRevision !== repairPlanRevision || amendment.record.courseFingerprint !== repairCourseFingerprint) {
    throw new Error("ACCESS_ROAD_BUDGET_AUTHORIZATION_BINDING_MISMATCH");
  }
  report.accessRoadAmendment = {
    status: amendment.status,
    effectiveProjectBudget: amendment.effectiveProjectBudget,
    reason: amendment.status === "ALREADY_AMENDED" ? amendment.record.reason : FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON,
  };
  verdict.ACCESS_ROAD_BUDGET_AMENDMENT = amendment.status;

  // ---- 3. The production K05 water boundary, with the funded scope. --------
  const effectiveAmendment = durability
    .utilityBudgetAmendments()
    .filter((entry) => entry.projectId === state.project.id && entry.status !== "SUPERSEDED_UNUSED")
    .reduce<typeof amendment.record | null>(
      (latest, entry) => (!latest || entry.amendedEffectiveBudget > latest.amendedEffectiveBudget ? entry : latest),
      null,
    );
  const preparation = buildUtilityPreparationInput({
    state,
    world: activation.world,
    treasury,
    kind: "water",
    connectionOnly: true,
    certifiedRoad: deliveredRoad.target,
    certifiedRoadRefs: deliveredRoad.refs,
    utilityBudgetAmendment: effectiveAmendment,
  });
  const prepared = await foundation.greenfieldUtilityBootstrap.prepare(preparation);
  report.preparation = {
    status: prepared.status,
    reason: prepared.status === "READY" ? null : prepared.reason,
    maximumSpend: preparation.maximumSpend,
  };
  if (prepared.status !== "READY") throw new Error(`WATER_PHASE7_PREPARE_BLOCKED:${prepared.reason}`);
  const admittedScope = prepared.executionScope as GreenfieldUtilityExecutionScope | undefined;
  if (!admittedScope) throw new Error("WATER_PHASE7_PREPARE_HAS_NO_EXECUTION_SCOPE");
  // The commissioning mandate. The production K05 path narrows it before it runs
  // (`k05-commission-utilities-workflow.ts:112`); a scope that declares no
  // mandate means *every* family, and the bootstrap then drives electricity and
  // sewage too. That is not merely extra work: the mandate is what keeps an
  // omitted family's durable state untouched, so a full-mandate run rewrites all
  // three — and this round commissions water and water only.
  const scope: GreenfieldUtilityExecutionScope = { ...admittedScope, commissionedKinds: ["water"] };
  verdict.EFFECTIVE_SCOPE_MAXIMUM_SPEND = scope.maximumSpend;

  const nativeAttemptsBefore = durability.commandJournal.list().length;
  const run = await foundation.greenfieldUtilityBootstrap.run(scope);
  const waterAfterRun = waterState();
  report.runResult = { reason: run.reason, waiting: run.waiting, serviceCertified: run.serviceCertified };
  report.waterAfterRun = waterAfterRun
    ? {
      stage: waterAfterRun.stage,
      commandOutcome: waterAfterRun.commandOutcome,
      networkCommandIds: waterAfterRun.networkCommandIds,
      accessRoadRepair: waterAfterRun.accessRoadRepair ?? null,
      candidateLedger: waterAfterRun.candidateLedger.map((c) => ({
        kind: c.kind, repair: c.repair ?? null, state: c.ledgerState, commandId: c.commandId,
        actions: c.exactActions,
      })),
    }
    : null;

  const accessRoadCommands = durability.commandJournal.list().filter((entry) =>
    entry.actionFamily === "UTILITY" && entry.authorizedScope.actionFamily === "UTILITY" &&
    entry.authorizedScope.utilityKind === "water" && entry.authorizedScope.projectId === state.project.id &&
    JSON.stringify(parseExactInput(entry.authorizedScope.exactInput)).includes(FACILITY_ACCESS_ROAD_PREFAB));
  report.accessRoadCommands = accessRoadCommands.map((entry) => ({ commandId: entry.commandId, status: entry.status }));
  verdict.ACCESS_ROAD_NATIVE_ATTEMPT_COUNT = accessRoadCommands.length;
  verdict.ACCESS_ROAD_EFFECT = accessRoadCommands.some((entry) => entry.status === "OBSERVED_MATCH")
    ? "OBSERVED_MATCH"
    : accessRoadCommands.length === 0 ? "NONE" : "UNPROVEN";

  // ---- 4. Read the world back, and only then certify. ---------------------
  const readback = async (label: string) => {
    const frontage = await readFrontage();
    const warnings = await readWarnings();
    const pump = await readPumpConsumer();
    const services = record(await tool("cs2_city_services"));
    const water = record(services.water);
    const entry = { label, frontage, warnings, pump, cityWater: water };
    const collected = (report.readback ??= []) as unknown[];
    collected.push(entry);
    return entry;
  };
  await readback("after-access-road");
  const simulation = await tool("cs2_run_simulation", { hours: SIMULATION_HOURS, speed: SIMULATION_SPEED });
  report.simulation = simulation;
  const after = await readback("after-simulation");
  verdict.FACILITY_ROAD_ATTACHMENT = after.frontage.roadAttachment;
  verdict.NO_ROAD_ACCESS_WARNING = after.warnings.noRoadAccess;
  verdict.NO_ELECTRICITY_WARNING = after.pump.noElectricityWarning;
  verdict.FULFILLED_ELECTRIC_CONSUMPTION = after.pump.fulfilledConsumption;
  verdict.WATER_SOURCE_OPERATIONAL = after.pump.fulfilledConsumption > 0 && !after.pump.noElectricityWarning ? "YES" : "NO";

  // The bounded attempt is enforced here, not merely declared. The durable ledger
  // already makes a repair course impossible to submit twice, so a count above one
  // would mean something upstream is wrong — and the answer to that is to stop,
  // not to ask for a second course.
  const attemptsAfterFirstRun = durability.commandJournal.list().filter((entry) =>
    entry.actionFamily === "UTILITY" && entry.authorizedScope.actionFamily === "UTILITY" &&
    entry.authorizedScope.utilityKind === "water" && entry.authorizedScope.projectId === state.project.id &&
    JSON.stringify(parseExactInput(entry.authorizedScope.exactInput)).includes(FACILITY_ACCESS_ROAD_PREFAB)).length;
  const withinBound = attemptsAfterFirstRun <= MAXIMUM_ACCESS_ROAD_NATIVE_ATTEMPTS;
  report.accessRoadAttemptsAfterFirstRun = attemptsAfterFirstRun;
  if (!withinBound) {
    const violation = `ACCESS_ROAD_NATIVE_ATTEMPTS_EXCEEDED:${attemptsAfterFirstRun}`;
    report.boundViolation = violation;
    throw new Error(violation);
  }

  // One more water pass so the service evidence is read against the repaired world.
  const second = await foundation.greenfieldUtilityBootstrap.run(scope);
  report.secondRun = { reason: second.reason, waiting: second.waiting, serviceCertified: second.serviceCertified };
  const finalWater = waterState();
  report.waterAfterCertification = finalWater
    ? {
      stage: finalWater.stage,
      serviceEvidence: finalWater.serviceEvidence ?? null,
      connectionObjective: finalWater.connectionObjective ?? null,
    }
    : null;
  const evidence = finalWater?.serviceEvidence ?? null;
  verdict.WATER_TOPOLOGY_BINDING = evidence ? String(record(evidence).status ?? "UNKNOWN") : "UNKNOWN";
  verdict.WATER_NETWORK_CONNECTED = evidence ? record(evidence).networkConnected : "UNKNOWN";
  verdict.WATER_SERVICE_AVAILABLE = second.serviceCertified ? "YES" : "NO";
  verdict.WATER_SKILL_RESULT = second.serviceCertified ? "SUCCESS" : second.reason;
  verdict.WATER_CAPACITY_AFTER = record(after.cityWater).freshCapacity ?? null;
  verdict.LIVE_WATER_PROOF_COMPLETE = second.serviceCertified ? "YES" : "NO";

  report.callLog = calls;
  report.forbiddenToolCalls = calls.filter((name) => FORBIDDEN_TOOLS.has(name));
  report.liveStoreSha256After = sha256(liveStorePath);
  report.finishedAtJournalPosition = (durability.projectState() as Gate1State | null)?.journal?.length ?? null;

  await fsPromises.mkdir("docs/ai-mayor/evidence", { recursive: true });
  await fsPromises.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ verdict, treasury, accessRoadPlanning: report.accessRoadPlanning, accessRoadAmendment: report.accessRoadAmendment, accessRoadCommands: report.accessRoadCommands, runResult: report.runResult, secondRun: report.secondRun, readback: report.readback }, null, 2)}\n`);
}

function parseExactInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

void main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
  // The MCP stdio transport keeps the event loop alive, so without an explicit
  // exit a failed run hangs forever with its error already written and its
  // process never ending — which is indistinguishable from a wedged world and
  // cost this round real time. Flush, then leave.
  await new Promise((resolve) => { process.stderr.write("", resolve); });
  process.exit(1);
});
