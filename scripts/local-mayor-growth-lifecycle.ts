import {
  decideLocalMayorEpisode,
  shouldEnsureGrowthOpportunity,
} from "../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
  zoningCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../src/main/services/ai-mayor/local-mayor/state";

const episodes = 60;
let phase: "reserve" | "road" | "zone" | "digest" = "reserve";
let pendingCells = 0;
let refreshes = 0;
let roads = 0;
let zonings = 0;
let waits = 0;
let replans = 0;
let meaningfulCapacity = 0;
let financeSuicide = false;
const activity = new Set<string>();

function snapshot() {
  const candidates =
    phase === "road"
      ? [roadCandidate(`frontier-road-${roads + 1}`)]
      : phase === "zone"
        ? [{ ...zoningCandidate(`industrial-zone-${zonings + 1}`, "Industrial"), approximateCells: 48 }]
        : [];
  const reserveDeficit = pendingCells < 32;
  return buildLocalMayorSnapshotFixture({
    population: { current: 80 + zonings * 6 },
    economy: { treasury: 2_000_000 - roads * 2_000 - zonings * 500, monthlyBalance: -11_500 },
    demand: { residential: 0, commercial: 0, industrial: 80 },
    developmentCapacity: {
      reserveStatus: reserveDeficit ? (pendingCells === 0 ? "empty" : "low") : "digesting",
      reserveDeficit,
      frontierAnchorCount: 1,
      availableFrontageCells: reserveDeficit ? 0 : 48,
      existingZonedUnoccupiedCells: pendingCells,
      existingZonedCells: pendingCells,
      safeUnzonedRoadsideCells: reserveDeficit ? 0 : 48,
      safeUnzonedCells: reserveDeficit ? 0 : 48,
      targetZoningCells: 32,
      targetFrontageCapacity: 80,
      availableDevelopmentCells: pendingCells,
    },
    actionablePlanning: { candidates },
  });
}

for (let episode = 1; episode <= episodes; episode += 1) {
  let current = snapshot();
  let state = compileLocalMayorState(current);
  if (phase === "reserve" && shouldEnsureGrowthOpportunity(state)) {
    refreshes += 1;
    phase = "road";
    current = snapshot();
    state = compileLocalMayorState(current);
  }
  const decision = decideLocalMayorEpisode(current, undefined, `growth-lifecycle-${episode}`);
  activity.add(decision.chosen.action.kind === "choose_candidate" ? "building" : decision.chosen.action.kind);
  if (decision.chosen.action.kind === "choose_candidate") {
    if (decision.chosen.action.candidateKind === "road_expansion") {
      roads += 1;
      phase = "zone";
    } else {
      zonings += 1;
      meaningfulCapacity += 48;
      pendingCells += 48;
      phase = "digest";
    }
    continue;
  }
  if (decision.chosen.action.kind === "wait" || decision.chosen.action.kind === "simulate") {
    waits += 1;
    if (phase === "digest") {
      pendingCells = Math.max(0, pendingCells - 16);
      if (pendingCells < 32) phase = "reserve";
    }
  } else if (decision.chosen.action.kind === "replan") {
    replans += 1;
  }
  financeSuicide = financeSuicide || (state.financeRunwayMonths !== null && state.financeRunwayMonths < 3);
}

console.log(
  JSON.stringify(
    {
      episodes,
      candidateRefreshes: refreshes,
      roadActions: roads,
      zoningActions: zonings,
      meaningfulCapacity,
      waitActions: waits,
      replanActions: replans,
      activityKinds: [...activity],
      financeSuicide,
      providerCalls: 0,
      finalPendingCells: pendingCells,
    },
    null,
    2,
  ),
);
