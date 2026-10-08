import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMainMayorPorts, parseMcpJson } from "../src/main/services/ai-mayor/main-adapters";
import { MayorRuntime } from "../src/main/services/ai-mayor/runtime";
import type { MayorPlanAction } from "../src/main/services/ai-mayor/types";
import {
  accountLocalMayorBatchExecution,
  countLocalMayorLiveExecutions,
  type LocalMayorLiveCandidateMetadata,
  localMayorGrowthInvariantViolation,
  missingLocalMayorLiveTools,
} from "./local-mayor-live-accounting";

type JsonObject = Record<string, unknown>;
const record = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function gameTime(snapshot: unknown): string | null {
  const game = record(record(snapshot).game);
  const value = game.gameDateTime ?? game.gameTime ?? game.time ?? game.date;
  return value === undefined || value === null ? null : String(value);
}

function compactWorld(snapshot: unknown, observation: Record<string, unknown>) {
  const root = record(snapshot);
  const overview = record(root.overview);
  const economy = record(root.economy);
  const utilities = record(root.utilities);
  const capacity = record(root.developmentCapacity);
  return {
    gameTime: observation.gameTime ?? null,
    paused: observation.paused ?? null,
    speed: observation.speed ?? null,
    population: overview.population ?? root.population ?? null,
    buildings: overview.buildings ?? root.buildings ?? null,
    roads: overview.roads ?? root.roads ?? null,
    treasury: economy.treasury ?? root.treasury ?? null,
    monthlyBalance: economy.monthlyBalance ?? root.monthlyBalance ?? null,
    financeRunwayMonths: root.financeRunwayMonths ?? null,
    utilities: {
      electricity: utilities.electricity ?? null,
      water: utilities.water ?? null,
      sewage: utilities.sewage ?? null,
    },
    typedReserve: capacity.zonedUnoccupiedByType ?? null,
    reserveStatus: capacity.reserveStatus ?? null,
  };
}

function numericPopulation(snapshot: unknown): number | null {
  const root = record(snapshot);
  const overview = record(root.overview);
  const population = overview.population ?? root.population;
  if (typeof population === "number") return population;
  const current = record(population).current;
  return typeof current === "number" ? current : null;
}

function numericBuildings(snapshot: unknown): number | null {
  const root = record(snapshot);
  const overview = record(root.overview);
  const buildings = overview.buildings ?? root.buildings;
  return typeof buildings === "number" ? buildings : null;
}

function hasGlobalGrowthOpportunity(snapshot: unknown): boolean {
  const root = record(snapshot);
  const planning = record(root.actionablePlanning);
  const capacity = record(root.developmentCapacity);
  const candidates = Array.isArray(planning.candidates) ? planning.candidates.length : 0;
  return (
    candidates > 0 ||
    Number(capacity.frontierAnchorCount ?? 0) > 0 ||
    Number(capacity.availableFrontageCells ?? 0) > 0 ||
    Number(capacity.candidateFrontageCapacity ?? 0) > 0
  );
}

async function main() {
  process.stdout.write("LIVE HARNESS: LOCAL MAYOR\ndecisionMode=local\nproviderAccess=disabled\n");
  const serverPath =
    process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
  const evidenceDirectory =
    process.env.AI_MAYOR_EVIDENCE_DIR ??
    path.join(process.cwd(), "docs/ai-mayor/evidence/local-mayor-runner-resume-live-2026-09-11");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const events: Array<Record<string, unknown>> = [];
  const decisionMode = "local" as const;
  const hardening = process.env.AI_MAYOR_HARDENING === "1";
  const durationMs = Number(process.env.AI_MAYOR_HARDENING_DURATION_MS ?? (hardening ? 20 * 60_000 : 120_000));
  let providerInvocations = 0;
  const metrics = {
    episodes: 0,
    observations: 0,
    ticks: 0,
    activityCounts: {} as Record<string, number>,
    roadActions: 0,
    zoningActions: 0,
    utilityRecoveryActions: 0,
    facilityActions: 0,
    connectorActions: 0,
    failedActions: 0,
    structuredFailures: 0,
    issueEvents: 0,
    cooldownEvents: 0,
    improvingEvents: 0,
    resolvedEvents: 0,
    automaticPauseCount: 0,
    automaticResumeCount: 0,
    financeGuardActivations: 0,
    staleCandidateFailures: 0,
    zeroProgressLoops: 0,
    repeatedActionFailures: 0,
  };
  const watchdogEvents: Array<Record<string, unknown>> = [];
  let watchdogBlocker: string | null = null;
  let stopReason = "duration_cap_reached";
  let blockedSince: number | null = null;
  let firstZoningAt: number | null = null;
  let startPopulation: number | null = null;
  const log = (event: string, data: unknown) => {
    const item = { at: new Date().toISOString(), event, data };
    events.push(item);
    process.stdout.write(`${JSON.stringify(item)}\n`);
  };

  const client = new Client({ name: "5ire-local-mayor-live", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  await client.connect(transport);
  let runtime: MayorRuntime | null = null;
  try {
    const listed = await client.listTools();
    const missing = missingLocalMayorLiveTools(listed.tools.map((tool) => tool.name));
    if (missing.length > 0) throw new Error(`Missing Local Mayor live tools: ${missing.join(", ")}`);
    const manager = {
      legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `t_live--${tool.name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) =>
        client.callTool({ name, arguments: args }),
    };

    const listedBuildings = record(
      parseMcpJson(await client.callTool({ name: "cs2_list_buildings", arguments: { limit: 50 } })),
    );
    const buildingRows = Array.isArray(listedBuildings.buildings) ? listedBuildings.buildings : [];
    const connectorKinds = new Set<string>();
    let connectorReadbacks = 0;
    for (const row of buildingRows) {
      const building = record(row);
      const entity = record(building.entity);
      if (!Number.isInteger(entity.index) || !Number.isInteger(entity.version)) continue;
      const connectorResult = record(
        parseMcpJson(
          await client.callTool({
            name: "cs2_utility_connectors",
            arguments: { index: entity.index, version: entity.version },
          }),
        ),
      );
      const connectors = Array.isArray(connectorResult.connectors) ? connectorResult.connectors : [];
      connectorReadbacks += 1;
      for (const connector of connectors) {
        const kind = record(connector).type;
        if (typeof kind === "string") connectorKinds.add(kind);
      }
      if (connectorKinds.size > 0) break;
    }
    const contractSanity = {
      batchToolPresent: listed.tools.some((tool) => tool.name === "cs2_mayor_execute_actions"),
      placeBuildingReceiptContract: "bounded batch receipt; mutation not attempted during read-only sanity",
      utilityConnectorToolPresent: listed.tools.some((tool) => tool.name === "cs2_utility_connectors"),
      connectorReadbacks,
      connectorKinds: [...connectorKinds].sort(),
      authoritativeIdentityShape: "entity.index+entity.version",
    };
    log("contract_sanity", contractSanity);

    const ports = createMainMayorPorts({
      getProvider: () => {
        providerInvocations += 1;
        throw new Error("LOCAL_MODE_PROVIDER_VIOLATION: Local Mayor live harness attempted a provider invocation");
      },
      getToolsManager: () => manager,
      emit: (event, state) => {
        if (event === "tick" || event === "status")
          log("runtime", {
            event,
            status: state.status,
            tickCount: state.tickCount,
            activityKind: state.localMayorActivity?.activityKind ?? null,
            localMayorStatus: state.localMayorStatus ?? null,
            gameTimeAdvanced: state.localMayorProgress?.gameTimeAdvanced ?? null,
          });
        if (event === "tick") {
          metrics.ticks = Math.max(metrics.ticks, state.tickCount ?? 0);
          const activity = state.localMayorActivity?.activityKind ?? "none";
          metrics.activityCounts[activity] = (metrics.activityCounts[activity] ?? 0) + 1;
        }
      },
    });
    // The local decision mode has no provider spend. Keep the production cost guard satisfied without a provider call.
    ports.getBalance = async () => ({
      isAvailable: true,
      currency: "CNY",
      totalBalance: 1_000,
      grantedBalance: 1_000,
      toppedUpBalance: 0,
      fetchedAt: new Date().toISOString(),
    });

    const baseUtilityRecovery = ports.ensureUtilityCapacity;
    if (baseUtilityRecovery) {
      ports.ensureUtilityCapacity = async (input) => {
        const result = await baseUtilityRecovery(input);
        metrics.utilityRecoveryActions += result.executedActions > 0 ? 1 : 0;
        metrics.facilityActions += result.trace.includes("facility_placed") ? 1 : 0;
        metrics.connectorActions += result.trace.includes("connector_connected") ? 1 : 0;
        if (result.reason === "finance_guard") metrics.financeGuardActivations += 1;
        if (result.reason.includes("stale")) metrics.staleCandidateFailures += 1;
        if (result.stage === "improving") metrics.improvingEvents += 1;
        if (result.stage === "resolved") metrics.resolvedEvents += 1;
        if (!result.ok) metrics.structuredFailures += 1;
        log("utility_recovery", { input, result });
        return result;
      };
    }

    let candidateCatalog: LocalMayorLiveCandidateMetadata[] = [];
    let roadExecutions = 0;
    let zoningExecutions = 0;
    let districtBurstCount = 0;
    let consecutiveSuccessfulBursts = 0;
    let maxConsecutiveDistrictBursts = 0;
    let absorbCyclesReached = 0;
    let constructionSeen = false;
    let constructionEnded = false;
    let gameTimeBeforeResume: string | null = null;
    let gameTimeAfterResume: string | null = null;
    const baseSnapshot = ports.getSnapshot;
    ports.getSnapshot = async () => {
      const snapshot = await baseSnapshot();
      const planning = record(record(snapshot).actionablePlanning);
      candidateCatalog = (Array.isArray(planning.candidates) ? planning.candidates : [])
        .map((candidate) => record(candidate))
        .filter(
          (candidate): candidate is JsonObject & { id: string; actionType: "build_road" | "zone" } =>
            typeof candidate.id === "string" &&
            (candidate.actionType === "build_road" || candidate.actionType === "zone"),
        )
        .map((candidate) => ({ id: candidate.id, actionType: candidate.actionType }));
      return snapshot;
    };
    const baseExecute = ports.executeActions;
    ports.executeActions = async (actions: MayorPlanAction[]) => {
      const selected = actions.find((action) => action.type === "choose_candidate");
      const batch = await baseExecute(actions);
      const accounting = accountLocalMayorBatchExecution({
        selectedCandidateId: selected?.type === "choose_candidate" ? selected.candidateId : null,
        candidates: candidateCatalog,
        batch,
      });
      const counts = countLocalMayorLiveExecutions(accounting);
      roadExecutions += counts.roadExecutions;
      zoningExecutions += counts.zoningExecutions;
      if (counts.zoningExecutions > 0 && firstZoningAt === null) firstZoningAt = Date.now();
      if (counts.roadExecutions + counts.zoningExecutions > 0) constructionSeen = true;
      metrics.roadActions += counts.roadExecutions;
      metrics.zoningActions += counts.zoningExecutions;
      if (batch.ok && counts.roadExecutions + counts.zoningExecutions > 0) {
        districtBurstCount += 1;
        consecutiveSuccessfulBursts += 1;
        maxConsecutiveDistrictBursts = Math.max(maxConsecutiveDistrictBursts, consecutiveSuccessfulBursts);
      }
      if (!batch.ok) {
        metrics.failedActions += 1;
        metrics.structuredFailures += 1;
      }
      if (batch.results.some((result) => result.error?.includes("stale"))) metrics.staleCandidateFailures += 1;
      const invariantViolation = localMayorGrowthInvariantViolation({
        batchActionCount: actions.filter((action) => action.type === "choose_candidate").length,
        roadsInBurst: counts.roadExecutions,
        zoningInBurst: counts.zoningExecutions,
        consecutiveSuccessfulBursts,
      });
      if (invariantViolation) watchdogBlocker = invariantViolation;
      log("construction_batch", {
        actions,
        batch,
        accounting,
        roadExecutions,
        zoningExecutions,
        districtBurstCount,
        consecutiveSuccessfulBursts,
        invariantViolation,
      });
      return batch;
    };

    const baseRunSimulation = ports.runSimulation;
    ports.runSimulation = async (simulation, signal) => {
      await baseRunSimulation(simulation, signal);
      absorbCyclesReached += 1;
      consecutiveSuccessfulBursts = 0;
      log("absorb_cycle", { absorbCyclesReached, simulation });
    };

    const readWorld = async () => {
      const [snapshotValue, gameValue] = await Promise.all([
        ports.getSnapshot(),
        client.callTool({ name: "cs2_game_state", arguments: {} }),
      ]);
      const game = record(parseMcpJson(gameValue));
      const simulation = record(game.simulation);
      return {
        snapshot: snapshotValue,
        gameTime: gameTime(snapshotValue),
        paused: game.simulationPaused === true || simulation.paused === true,
        speed: simulation.speed ?? game.speed ?? null,
        activityKind: runtime?.getState()?.localMayorActivity?.activityKind ?? null,
      };
    };

    const before = await readWorld();
    startPopulation = numericPopulation(before.snapshot);
    log("precheck", { gameTime: before.gameTime, paused: before.paused, speed: before.speed, hardening, durationMs });
    fs.writeFileSync(
      path.join(evidenceDirectory, "start-snapshot.json"),
      JSON.stringify(compactWorld(before.snapshot, before), null, 2),
    );
    runtime = new MayorRuntime(ports);
    if (decisionMode !== "local") throw new Error("HARNESS_MODE_FAILURE: live proof must use decisionMode=local");
    runtime.start({
      goal: "Continue the current city autonomously and safely.",
      maxSessionSpend: 0.01,
      minimumBalance: 1,
      tickDelayMs: 0,
      speed: "normal",
      decisionMode,
      stageTrace: hardening,
      continuous: true,
    });
    log("mode_guard", { decisionMode, providerFailFast: true, providerInvocations });

    const deadline = Date.now() + durationMs;
    let lastGameTime = before.gameTime;
    let lastProgressAt = Date.now();
    let lastPaused = before.paused;
    let lastIssueSignature: string | null = null;
    let activeStateSince = Date.now();
    let activeState = "none";
    const runStartedAt = Date.now();
    while (Date.now() < deadline) {
      await wait(2_000);
      const state = runtime.getState();
      const observation = await readWorld();
      const activity = state?.localMayorActivity?.activityKind ?? null;
      metrics.observations += 1;
      metrics.episodes = Math.max(metrics.episodes, state?.tickCount ?? 0);
      if (observation.gameTime !== lastGameTime) {
        lastGameTime = observation.gameTime;
        lastProgressAt = Date.now();
      } else if (state?.localMayorProgress?.gameTimeAdvanced === true) {
        lastProgressAt = Date.now();
      } else {
        metrics.zeroProgressLoops += 1;
      }
      if (lastPaused && !observation.paused) metrics.automaticResumeCount += 1;
      if (!lastPaused && observation.paused) metrics.automaticPauseCount += 1;
      lastPaused = observation.paused;
      if (activity !== activeState) {
        activeState = activity ?? "none";
        activeStateSince = Date.now();
      }
      const activeConstruction = ["planning", "building", "building_district", "selecting_next_district"].includes(
        activity ?? "",
      );
      const activeForMs = Date.now() - activeStateSince;
      if (activeState === "planning" && activeForMs > 90_000) watchdogBlocker = "planning_stall";
      if (activeState === "building" && activeForMs > 90_000) watchdogBlocker = "building_stall";
      if (!activeConstruction && observation.paused && Date.now() - lastProgressAt > 90_000)
        watchdogBlocker = "paused_stall";
      if (
        !activeConstruction &&
        Date.now() - lastProgressAt > 90_000 &&
        !["blocked", "waiting_for_growth"].includes(activity ?? "")
      )
        watchdogBlocker = "zero_progress_stall";
      const now = Date.now();
      if (activity === "blocked" && hasGlobalGrowthOpportunity(observation.snapshot)) {
        blockedSince ??= now;
        if (now - blockedSince >= 5 * 60_000) watchdogBlocker = "district_rollover_blocker";
      } else if (activity !== "blocked") {
        blockedSince = null;
      }
      if (
        roadExecutions + zoningExecutions === 0 &&
        now - runStartedAt >= 5 * 60_000 &&
        hasGlobalGrowthOpportunity(observation.snapshot)
      )
        watchdogBlocker = "growth_stagnation";
      const observedPopulation = numericPopulation(observation.snapshot);
      if (observedPopulation !== null && observedPopulation >= 500) {
        stopReason = "population_target_reached";
        log("population_target_reached", { population: observedPopulation, activity, observation });
        break;
      }
      if (
        firstZoningAt !== null &&
        now - firstZoningAt >= 10 * 60_000 &&
        startPopulation !== null &&
        observedPopulation !== null &&
        observedPopulation <= startPopulation
      )
        watchdogBlocker = "absorption_blocker";
      const issue = state?.localMayorActivity?.topIssue;
      const issueSignature = issue ? `${issue.kind}:${issue.severity}` : null;
      if (issueSignature && issueSignature !== lastIssueSignature) metrics.issueEvents += 1;
      lastIssueSignature = issueSignature;
      if (watchdogBlocker) {
        const event = { blocker: watchdogBlocker, activity, observation, tickCount: state?.tickCount ?? null };
        watchdogEvents.push(event);
        log("watchdog_blocker", event);
        stopReason = watchdogBlocker;
        break;
      }
      if (activity === "planning" || activity === "building" || activity === "building_district")
        constructionSeen = true;
      if (constructionSeen && !constructionEnded && !activeConstruction) {
        constructionEnded = true;
        gameTimeBeforeResume = observation.gameTime;
        log("construction_ended", {
          activity,
          gameTimeBeforeResume,
          paused: observation.paused,
          speed: observation.speed,
        });
      }
      if (constructionEnded && !gameTimeAfterResume && observation.gameTime !== gameTimeBeforeResume) {
        gameTimeAfterResume = observation.gameTime;
        log("simulation_resumed", {
          gameTimeBeforeResume,
          gameTimeAfterResume,
          activity,
          paused: observation.paused,
          speed: observation.speed,
        });
        if (!hardening) break;
      }
      if (state?.status === "stopped") break;
    }
    const finalBeforeStop = await readWorld();
    if (constructionSeen && !constructionEnded) log("resume_not_reached", { activity: finalBeforeStop.activityKind });
    if (constructionEnded && !gameTimeAfterResume)
      log("post_construction_simulation_resume_blocker", { gameTimeBeforeResume, final: finalBeforeStop });
    await runtime.stop(stopReason);
    const after = await readWorld();
    fs.writeFileSync(
      path.join(evidenceDirectory, "end-snapshot.json"),
      JSON.stringify(compactWorld(after.snapshot, after), null, 2),
    );
    const summary = {
      roads: roadExecutions,
      zoning: zoningExecutions,
      startPopulation,
      endPopulation: numericPopulation(after.snapshot),
      startBuildings: numericBuildings(before.snapshot),
      endBuildings: numericBuildings(after.snapshot),
      stopReason,
      constructionSeen,
      constructionEnded,
      gameTimeBefore: before.gameTime,
      gameTimeBeforeResume,
      gameTimeAfterResume,
      gameTimeAfter: after.gameTime,
      pausedAfterStop: after.paused,
      speedAfterStop: after.speed,
      providerCalls: 0,
      cost: 0,
      providerInvocations,
      contractSanity,
      hardening,
      durationMs,
      watchdogEvents,
      firstBlocker: watchdogBlocker,
      districtBurstCount,
      maxConsecutiveDistrictBursts,
      absorbCyclesReached,
      metrics,
      runtimeState: runtime.getState(),
    };
    fs.writeFileSync(path.join(evidenceDirectory, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(evidenceDirectory, "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    log("complete", summary);
  } finally {
    if (runtime?.getState()?.status === "running") await runtime.stop("runner finally");
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
