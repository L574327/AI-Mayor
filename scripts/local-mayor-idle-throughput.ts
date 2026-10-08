import { buildLocalMayorSnapshotFixture } from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { MayorRuntime } from "../src/main/services/ai-mayor/runtime";
import type { MayorRuntimePorts } from "../src/main/services/ai-mayor/types";

const snapshot = buildLocalMayorSnapshotFixture({
  demand: { residential: 0, commercial: 0, industrial: 60 },
  developmentCapacity: { pendingZoningCells: 0, pendingFrontageCapacity: 0 },
  actionablePlanning: { candidates: [], status: "available", note: "no safe actionability" },
});
const balance = {
  isAvailable: true,
  currency: "CNY" as const,
  totalBalance: 100_000,
  grantedBalance: 0,
  toppedUpBalance: 100_000,
  fetchedAt: "2026-09-11T00:00:00.000Z",
};

const ports: MayorRuntimePorts = {
  getBalance: async () => balance,
  getSnapshot: async () => snapshot,
  refreshActionableCandidates: async () => {
    metrics.refreshes += 1;
    return snapshot;
  },
  decide: async () => {
    metrics.providerCalls += 1;
    throw new Error("local idle run must not call a provider");
  },
  executeActions: async () => ({ ok: false, requested: 1, executed: 0, failedAt: 0, results: [] }),
  runSimulation: async () => undefined,
  pause: async () => undefined,
  save: async () => undefined,
};

const metrics = {
  refreshes: 0,
  providerCalls: 0,
  transitions: 0,
  blockedEpisodes: 0,
  observingEpisodes: 0,
  fakePlanning: 0,
  waits: 0,
  replans: 0,
  simulations: 0,
  previousActivity: null as string | null,
};

async function main() {
  const runtime = new MayorRuntime(ports);
  runtime.start({
    goal: "Observe stable industrial demand safely",
    maxSessionSpend: 10,
    minimumBalance: 0,
    decisionMode: "local",
    tickDelayMs: 0,
  });

  for (let episode = 0; episode < 50; episode += 1) {
    const state = await runtime.singleTick();
    const activity = state.localMayorActivity?.activityKind ?? "missing";
    if (activity !== metrics.previousActivity) {
      metrics.previousActivity = activity;
      metrics.transitions += 1;
    }
    if (activity === "blocked") metrics.blockedEpisodes += 1;
    if (activity === "observing") metrics.observingEpisodes += 1;
    if (activity === "planning") metrics.fakePlanning += 1;
    const actionKind = (state.localMayorTrace as { chosen?: { action?: { kind?: string } } } | undefined)?.chosen
      ?.action?.kind;
    if (actionKind === "wait") metrics.waits += 1;
    if (actionKind === "replan") metrics.replans += 1;
    if (actionKind === "simulate") metrics.simulations += 1;
  }
  await runtime.stop("idle synthetic validation complete");

  console.log(
    JSON.stringify({
      episodes: 50,
      activityTransitionCount: metrics.transitions,
      plannerRefreshCount: metrics.refreshes,
      blockedEpisodes: metrics.blockedEpisodes,
      observingEpisodes: metrics.observingEpisodes,
      fakePlanningCount: metrics.fakePlanning,
      wait: metrics.waits,
      replan: metrics.replans,
      simulations: metrics.simulations,
      eventualBoundedRetry: metrics.refreshes > 1,
      providerCalls: metrics.providerCalls,
      noInfiniteBlockedState: metrics.refreshes > 1,
    }),
  );
}

void main();
