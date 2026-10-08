import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  boundedValidationSimulationHours,
  createMainMayorPorts,
  parseMcpJson,
} from "../src/main/services/ai-mayor/main-adapters";
import { MayorRuntime } from "../src/main/services/ai-mayor/runtime";
import { parseMayorPlan, validateMayorPlanAgainstSnapshot } from "../src/main/services/ai-mayor/schema";
import type { MayorPlan } from "../src/main/services/ai-mayor/types";
import {
  decideUrbanDesignEpisode,
  executeUrbanDesignRealizationGroup,
} from "../src/main/services/ai-mayor/urban-design/decision-flow";

type JsonObject = Record<string, unknown>;

const record = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

function summarizeSnapshot(snapshot: unknown) {
  const value = record(snapshot);
  const catalog = record(value.planningCatalog);
  const actionablePlanning = record(value.actionablePlanning);
  const buildingPrefabs = record(catalog.buildingPrefabs);
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    game: value.game,
    population: value.population,
    economy: value.economy,
    demand: value.demand,
    utilities: value.utilities,
    cityServices: value.cityServices,
    warnings: value.warnings,
    map: value.map,
    planningCatalog: {
      roadPrefabs: Array.isArray(catalog.roadPrefabs) ? catalog.roadPrefabs : [],
      zoneTypes: Array.isArray(catalog.zoneTypes) ? catalog.zoneTypes : [],
      buildingPrefabCounts: Object.fromEntries(
        Object.entries(buildingPrefabs).map(([kind, names]) => [kind, Array.isArray(names) ? names.length : 0]),
      ),
      roadAnchors: Array.isArray(catalog.roadAnchors) ? catalog.roadAnchors : [],
      cameraPivot: catalog.cameraPivot,
    },
    actionablePlanning: {
      status: actionablePlanning.status,
      candidates: Array.isArray(actionablePlanning.candidates) ? actionablePlanning.candidates : [],
      note: actionablePlanning.note,
    },
    bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  };
}

function requireLiveBaseline(snapshot: unknown, allowGreenfield = false) {
  const value = record(snapshot);
  const game = record(value.game);
  const population = record(value.population);
  const utilities = record(value.utilities);
  const electricity = record(utilities.electricity);
  const water = record(utilities.water);
  const sewage = record(utilities.sewage);
  if (game.status !== "available" || game.paused !== true) throw new Error("live acceptance requires a paused city");
  if (!(Number(population.current ?? 0) > 0) && !allowGreenfield) throw new Error("live acceptance requires population > 0");
  // Greenfield remains exempt from LIVE utility invariants until its
  // bootstrap certificate (consumer utilities + residents) is observed.
  if (allowGreenfield && Number(population.current ?? 0) <= 10) return;
  if (
    !(Number(electricity.production ?? 0) > 0) ||
    Number(electricity.fulfilledConsumption ?? 0) < Number(electricity.consumption ?? 0)
  ) {
    throw new Error("live acceptance requires working electricity");
  }
  if (!(Number(water.capacity ?? 0) > 0) || !(Number(sewage.capacity ?? 0) > 0)) {
    throw new Error("live acceptance requires working water and sewage capacity");
  }
}

async function main() {
  process.stdout.write("LIVE HARNESS: DEEPSEEK MAYOR\ndecisionMode=deepseek\n");
  const preflightOnly = process.argv.includes("--preflight-only");
  const pauseOnly = process.argv.includes("--pause-only");
  const shortReadback = process.argv.includes("--udl-phase5b");
  const fastMode = process.argv.includes("--fast");
  const ticksArgument = process.argv.find((argument) => argument.startsWith("--ticks="));
  const ticks = Number(ticksArgument?.split("=")[1] ?? 1);
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 20) throw new Error("--ticks must be an integer from 1 to 20");

  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is unavailable");
  const configPath = process.env.AI_MAYOR_PROVIDER_CONFIG ?? path.join(appData, "AI Mayor", "config.json");
  const serverPath =
    process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
  const goal =
    process.env.AI_MAYOR_GOAL ??
    "Manage the current city autonomously and safely. Base each decision on the current Snapshot, bounded operational signals, and the Mayor Skill.";
  const evidenceDirectory = process.env.AI_MAYOR_EVIDENCE_DIR;
  const logPath = evidenceDirectory ? path.join(evidenceDirectory, "mayor-events.jsonl") : null;
  if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
  const log = (event: string, data: unknown) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, data });
    if (logPath) fs.appendFileSync(logPath, `${line}\n`);
    process.stdout.write(`${line}\n`);
  };

  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    providers?: Array<{ name?: string; apiBase?: string; apiKey?: string; proxy?: string }>;
  };
  const provider = config.providers?.find((candidate) => candidate.name === "DeepSeek");
  if (!preflightOnly && !pauseOnly && !provider?.apiKey)
    throw new Error("DeepSeek provider is not configured in the selected config");

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "ai-mayor-live", version: "1.0.0" });

  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    const runtimeTools = [
      "cs2_mayor_snapshot",
      "cs2_spatial",
      ...(evidenceDirectory ? ["cs2_screenshot", "cs2_list_roads", "cs2_list_buildings"] : []),
    ];
    const requiredTools = pauseOnly
      ? ["cs2_mayor_snapshot", "cs2_run_simulation", "cs2_game_state", "cs2_save_game"]
      : preflightOnly
        ? runtimeTools
        : [...runtimeTools, "cs2_mayor_execute_actions", "cs2_run_simulation", "cs2_game_state", "cs2_save_game"];
    for (const required of requiredTools) {
      if (!names.has(required)) throw new Error(`Live MCP server is missing ${required}`);
    }

    const manager = {
      legacyList: async () => ({ tools: listed.tools.map((tool) => ({ name: `t_live--${tool.name}` })) }),
      legacyCall: async ({ name, arguments: input }: { name: string; arguments: Record<string, unknown> }) =>
        client.callTool({ name, arguments: input }),
    };
    const ports = createMainMayorPorts({
      getProvider: () => provider,
      getToolsManager: () => manager,
      emit: (event, state) => {
        if (event === "balance") {
          log("cost_guard", {
            currentBalance: state.currentBalance,
            minimumBalance: state.minimumBalance,
            estimatedSessionSpend: state.estimatedSessionSpend,
            maxSessionSpend: state.maxSessionSpend,
          });
        }
      },
    });

    let decisionSnapshot: unknown = null;
    const decisionAudit: { plan: MayorPlan | null } = { plan: null };
    let decisionCount = 0;
    const realizationAudit: { intents: unknown[]; results: unknown[] } = { intents: [], results: [] };
    const noveltyBeforeValue = record(ports.getUrbanDesignNoveltyMemory?.() ?? {}).entries;
    const noveltyBefore = Array.isArray(noveltyBeforeValue) ? noveltyBeforeValue.length : 0;
    const getSnapshot = ports.getSnapshot;
    ports.getSnapshot = async () => {
      const snapshot = await getSnapshot();
      decisionSnapshot = snapshot;
      log("snapshot_input", summarizeSnapshot(snapshot));
      return snapshot;
    };
    const decideUrbanDesign = ports.decideUrbanDesign;
    ports.decideUrbanDesign = async (input) => {
      decisionCount += 1;
      if (decisionCount > 2) throw new Error("Phase 5B decision bound exceeded");
      if (!decideUrbanDesign) throw new Error("Phase 5B dedicated decision port is unavailable");
      const decision = await decideUrbanDesign(input);
      log("urban_design_decision", {
        requestSucceeded: true,
        requestId: decision.requestId,
        model: decision.model,
        usage: decision.usage,
        estimatedCost: decision.estimatedCost,
      });
      return decision;
    };
    if (!shortReadback) {
      const decide = ports.decide;
      ports.decide = async (input) => {
        const decision = await decide(input);
        let plan: unknown = decision.content;
        let validation: { ok: boolean; error?: string } = { ok: false };
        try {
          decisionAudit.plan = validateMayorPlanAgainstSnapshot(parseMayorPlan(decision.content), decisionSnapshot, {
            maxCandidateCount: fastMode ? 3 : 20,
          });
          plan = decisionAudit.plan;
          validation = { ok: true };
        } catch (error) {
          validation = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        log("decision", {
          requestSucceeded: true,
          requestId: decision.requestId,
          model: decision.model,
          plan,
          validation,
          usage: decision.usage,
          estimatedCost: decision.estimatedCost,
        });
        return decision;
      };
    }
    const realizeUrbanDesignIntent = ports.realizeUrbanDesignIntent;
    if (!realizeUrbanDesignIntent) throw new Error("Phase 5B realization port is unavailable");
    ports.realizeUrbanDesignIntent = async (intent) => {
      const serialized = JSON.stringify(intent);
      if (/["'](?:x|z|x1|z1|x2|z2|spline|geometry)\s*["']\s*:/.test(serialized))
        throw new Error("UrbanDesignIntent contained forbidden geometry fields");
      realizationAudit.intents.push(intent);
      const result = await realizeUrbanDesignIntent(intent);
      realizationAudit.results.push(result);
      log("urban_design_realization", { intent, result });
      return result;
    };

    const captureEvidence = async (label: string) => {
      if (!evidenceDirectory) return;
      const [screenshot, roads, buildings] = await Promise.all([
        client.callTool({ name: "cs2_screenshot", arguments: { width: 1600 } }),
        client.callTool({ name: "cs2_list_roads", arguments: { limit: 500 } }),
        client.callTool({ name: "cs2_list_buildings", arguments: { limit: 500 } }),
      ]);
      const screenshotContent = Array.isArray(record(screenshot).content)
        ? (record(screenshot).content as unknown[])
        : [];
      const image = screenshotContent.find(
        (item): item is { type: "image"; data: string; mimeType: string } => record(item).type === "image",
      );
      const screenshotPath = image ? path.join(evidenceDirectory, `${label}.png`) : null;
      if (image && screenshotPath) fs.writeFileSync(screenshotPath, Buffer.from(image.data, "base64"));
      const roadData = record(parseMcpJson(roads));
      const buildingData = record(parseMcpJson(buildings));
      log("evidence", {
        label,
        screenshotPath,
        roads: { totalMatches: roadData.totalMatches, returned: roadData.returned },
        buildings: { totalMatches: buildingData.totalMatches, returned: buildingData.returned },
      });
    };

    const worldCounts = async () => {
      const [roads, buildings] = await Promise.all([
        client.callTool({ name: "cs2_list_roads", arguments: { limit: 500 } }),
        client.callTool({ name: "cs2_list_buildings", arguments: { limit: 500 } }),
      ]);
      const roadData = record(parseMcpJson(roads));
      const buildingData = record(parseMcpJson(buildings));
      return {
        roads: Number(roadData.totalMatches ?? roadData.returned ?? 0),
        buildings: Number(buildingData.totalMatches ?? buildingData.returned ?? 0),
      };
    };

    const before = parseMcpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} }));
    const gameStateBefore = record(parseMcpJson(await client.callTool({ name: "cs2_game_state", arguments: {} })));
    const lifecyclePath = process.env.AI_MAYOR_LIFECYCLE_STATE ?? path.join(evidenceDirectory ?? process.cwd(), "greenfield-lifecycle-state.json");
    let durableLifecycle: { mode: "GREENFIELD_BOOTSTRAP" | "LIVE"; certificate: boolean } | null = null;
    try {
      const persisted = record(JSON.parse(fs.readFileSync(lifecyclePath, "utf8")));
      if (persisted.mode === "GREENFIELD_BOOTSTRAP" || persisted.mode === "LIVE") {
        durableLifecycle = { mode: persisted.mode, certificate: persisted.certificate === true };
      }
    } catch { /* first adoption of a world */ }
    const populationBefore = Number(record(before).population?.current ?? 0);
    const utilityBaselineReady = (() => {
      const utilities = record(before).utilities ?? {};
      const electricity = utilities.electricity ?? {};
      const water = utilities.water ?? {};
      const sewage = utilities.sewage ?? {};
      return Number(electricity.production ?? 0) > 0
        && Number(electricity.fulfilledConsumption ?? 0) >= Number(electricity.consumption ?? 0)
        && Number(water.capacity ?? 0) > 0 && Number(sewage.capacity ?? 0) > 0;
    })();
    // A saved NewGame can report LoadGame after reload. Preserve the
    // greenfield lifecycle for the tiny, utility-less bootstrap footprint;
    // populated, serviced cities continue through LIVE validation.
    const zeroUtilityBootstrap = !utilityBaselineReady
      && Number(record(before).population?.current ?? 0) <= 50;
    const greenfield = record(gameStateBefore.world).loadPurpose === "NewGame"
      || populationBefore === 0
      || zeroUtilityBootstrap;
    if (!durableLifecycle && greenfield) {
      durableLifecycle = { mode: "GREENFIELD_BOOTSTRAP", certificate: false };
      fs.mkdirSync(path.dirname(lifecyclePath), { recursive: true });
      fs.writeFileSync(lifecyclePath, JSON.stringify(durableLifecycle, null, 2));
    }
    const resolvedLifecycleMode = durableLifecycle?.mode ?? (greenfield ? "GREENFIELD_BOOTSTRAP" : "LIVE");
    if (pauseOnly) {
      log("pause_recovery_started", { snapshot: summarizeSnapshot(before) });
      await ports.pause();
      const paused = parseMcpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} }));
      requireLiveBaseline(paused);
      parseMcpJson(
        await client.callTool({
          name: "cs2_save_game",
          arguments: { name: `AI Mayor Safety Pause ${new Date().toISOString().replace(/[:.]/g, "-")}` },
        }),
      );
      log("pause_recovery_complete", { snapshot: summarizeSnapshot(paused) });
      return;
    }
    if (resolvedLifecycleMode !== "GREENFIELD_BOOTSTRAP") requireLiveBaseline(before);
    const worldBefore = await worldCounts();
    log("preflight", { ticks, preflightOnly, snapshot: summarizeSnapshot(before) });
    await captureEvidence("00-preflight");
    if (preflightOnly) {
      const actionableSnapshot = await ports.getSnapshot();
      if (resolvedLifecycleMode !== "GREENFIELD_BOOTSTRAP") requireLiveBaseline(actionableSnapshot);
      log("actionability_preflight", summarizeSnapshot(actionableSnapshot));
      return;
    }
    parseMcpJson(
      await client.callTool({
        name: "cs2_save_game",
        arguments: { name: `AI Mayor Preflight ${new Date().toISOString().replace(/[:.]/g, "-")}` },
      }),
    );

    if (shortReadback) {
      const runSimulation = ports.runSimulation;
      ports.runSimulation = (simulation, signal) =>
        runSimulation({ ...simulation, hours: boundedValidationSimulationHours(simulation.hours) }, signal);
    }

    if (shortReadback) {
      const dedicatedSnapshot = await ports.getSnapshot();
      const dedicated = await decideUrbanDesignEpisode({
        ports,
        snapshot: dedicatedSnapshot,
        goal,
        tick: 1,
        playerDirection: process.env.AI_MAYOR_PLAYER_DIRECTION ?? null,
        strategicContext: {
          goal,
          phase: "urban_design",
          strategy: "plan one bounded spatial design episode",
          operationalNote: "Phase 5B dedicated validation path",
        },
        model: process.env.AI_MAYOR_MODEL ?? "deepseek-chat",
      });
      log("urban_design_episode", {
        decision: dedicated.decision,
        proposal: dedicated.resolution?.proposal ?? null,
        realization: dedicated.realization,
      });
      if (dedicated.decision.status === "wait") {
        await ports.pause();
        await ports.save(`AI Mayor UDL Wait ${new Date().toISOString().replace(/[:.]/g, "-")}`);
        return;
      }
      const execution = await executeUrbanDesignRealizationGroup({ ports, realization: dedicated.realization });
      const after = parseMcpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} }));
      const worldAfter = await worldCounts();
      log("urban_design_execution", {
        proposalId: dedicated.resolution?.proposal?.proposalId ?? null,
        realizationGroupId: Array.isArray(record(dedicated.realization).candidateMetadata)
          ? record(dedicated.realization).candidateMetadata[0]?.realizationGroupId
          : null,
        requested: execution.candidateIds,
        batch: execution.batch,
        snapshotAfter: summarizeSnapshot(after),
        worldBefore,
        worldAfter,
        noveltyBefore,
        noveltyAfter: record(ports.getUrbanDesignNoveltyMemory?.() ?? {}).entries,
      });
      await captureEvidence("tick-01");
      await ports.pause();
      await ports.save(`AI Mayor UDL Complete ${new Date().toISOString().replace(/[:.]/g, "-")}`);
      if (execution.batch.ok !== true || execution.batch.executed < 1)
        throw new Error("Phase 5B realization group execution failed");
      if (worldAfter.roads === worldBefore.roads && worldAfter.buildings === worldBefore.buildings)
        throw new Error("Phase 5B execution produced no verified CS2 readback change");
      return;
    }

    const runtime = new MayorRuntime(ports);
    const started = runtime.start({
      goal,
      maxSessionSpend: Number(process.env.AI_MAYOR_MAX_SPEND ?? 0.2),
      minimumBalance: Number(process.env.AI_MAYOR_MIN_BALANCE ?? 1),
      tickDelayMs: 0,
      speed: fastMode ? "fast" : "normal",
      lifecycleMode: resolvedLifecycleMode,
      noProgressGuard: true,
    });
    log("session_started", {
      sessionId: started.sessionId,
      goal: started.goal,
      speed: fastMode ? "fast" : "normal",
      estimatedSessionSpend: started.estimatedSessionSpend,
      telemetryTotals: started.telemetryTotals,
    });

    try {
      for (let index = 0; index < ticks; index++) {
        decisionAudit.plan = null;
        const first = runtime.singleTick();
        const second = index === 0 ? runtime.singleTick() : first;
        log("single_flight", { tick: index + 1, sharedPromise: first === second });
        const state = await first;
        const after = parseMcpJson(await client.callTool({ name: "cs2_mayor_snapshot", arguments: {} }));
        log("snapshot_after", { tick: index + 1, snapshot: summarizeSnapshot(after) });
        const acceptedPlan = decisionAudit.plan as MayorPlan | null;
        log("tick", {
          requestedTick: index + 1,
          tickCount: state.tickCount,
          status: state.lastStatus,
          sessionStatus: state.status,
          approvedActions: acceptedPlan?.actions ?? null,
          constructionPhase: acceptedPlan?.constructionPhase ?? null,
          selectedCandidateCount:
            acceptedPlan?.actions.filter((action) => action.type === "choose_candidate").length ?? 0,
          rejectedActions: acceptedPlan ? [] : "plan validation did not pass",
          simulation: acceptedPlan?.simulation ?? null,
          batch: state.lastBatchResult,
          memory: state.compactMayorMemory,
          memoryBytes: Buffer.byteLength(JSON.stringify(state.compactMayorMemory), "utf8"),
          operationalSignals: state.operationalSignals,
          telemetry: state.recentTickTelemetry.at(-1),
          telemetryTotals: state.telemetryTotals,
          currentBalance: state.currentBalance,
          estimatedSessionSpend: state.estimatedSessionSpend,
        });
        await captureEvidence(`tick-${String(index + 1).padStart(2, "0")}`);

        const telemetry = state.recentTickTelemetry.at(-1);
        if (!acceptedPlan) throw new Error(`tick ${index + 1} did not produce a valid MayorPlan`);
        if (state.tickCount !== index + 1 || telemetry?.outcome !== "success") {
          throw new Error(`tick ${index + 1} did not complete successfully`);
        }
        if (state.lastBatchResult?.ok !== true) throw new Error(`tick ${index + 1} Batch did not succeed`);
        if (acceptedPlan.simulation.run !== true)
          throw new Error(`tick ${index + 1} did not request simulation progress`);
        const beforeGame = record(record(decisionSnapshot).game);
        const afterGame = record(record(after).game);
        if (afterGame.paused !== true || afterGame.gameDateTime === beforeGame.gameDateTime) {
          throw new Error(`tick ${index + 1} did not advance and auto-pause the simulation`);
        }
        if (state.lifecycleMode !== "GREENFIELD_BOOTSTRAP") requireLiveBaseline(after);
        if (durableLifecycle && state.lifecycleMode !== durableLifecycle.mode) {
          durableLifecycle = { mode: state.lifecycleMode, certificate: state.lifecycleMode === "LIVE" };
          fs.writeFileSync(lifecyclePath, JSON.stringify(durableLifecycle, null, 2));
        }
        if (state.status !== "running") throw new Error(`tick ${index + 1} stopped the Mayor session unexpectedly`);
      }

      const state = await runtime.stop("Live harness completed requested ticks");
      const noveltyAfterValue = record(ports.getUrbanDesignNoveltyMemory?.() ?? {}).entries;
      const noveltyAfter = Array.isArray(noveltyAfterValue) ? noveltyAfterValue.length : 0;
      const realizedResult = realizationAudit.results.find((result) => record(result).status === "realized");
      if (decisionCount !== 2) throw new Error(`Phase 5B expected exactly 2 DeepSeek decisions, got ${decisionCount}`);
      if (realizationAudit.intents.length !== 1 || !realizedResult)
        throw new Error("Phase 5B did not produce exactly one realized Urban Design proposal");
      if (noveltyAfter !== noveltyBefore + 1)
        throw new Error(`Phase 5B novelty lifecycle expected ${noveltyBefore + 1}, got ${noveltyAfter}`);
      const worldAfter = await worldCounts();
      if (worldAfter.roads === worldBefore.roads && worldAfter.buildings === worldBefore.buildings)
        throw new Error("Phase 5B produced no verified CS2 readback change");
      log("complete", {
        tickCount: state.tickCount,
        stopReason: state.stopReason,
        finalBalance: state.currentBalance,
        finalMemory: state.compactMayorMemory,
        telemetryTotals: state.telemetryTotals,
        estimatedSessionSpend: state.estimatedSessionSpend,
        deepSeekRequests: decisionCount,
        noveltyBefore,
        noveltyAfter,
        worldBefore,
        worldAfter,
        realizationCount: realizationAudit.results.length,
      });
    } catch (error) {
      const reason = `Live harness failed: ${error instanceof Error ? error.message : String(error)}`;
      const state = await runtime.stop(reason);
      log("aborted", {
        tickCount: state.tickCount,
        stopReason: state.stopReason,
        telemetryTotals: state.telemetryTotals,
        estimatedSessionSpend: state.estimatedSessionSpend,
      });
      throw error;
    }
  } finally {
    await transport.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
