import { decideLocalMayorEpisode } from "../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
  zoningCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import type { LocalMayorHistory } from "../src/main/services/ai-mayor/local-mayor/types";

const episodes = 50;
let history: LocalMayorHistory = { recentActions: [], cooldowns: [], consecutiveWaits: 0 };
let frontage = 3;
let roadOpportunities = 2;
let pendingCapacity = 0;
let finance = 100_000;
let meaningfulCapacityAdded = 0;
let zoningActions = 0;
let roadActions = 0;
let waits = 0;
let replans = 0;
let maxWaitStreak = 0;
let financeSuicide = false;

for (let episode = 1; episode <= episodes; episode++) {
  const candidates =
    pendingCapacity < 20 && frontage > 0
      ? [
          zoningCandidate(`zone-${episode}-tiny`, "Residential", 250),
          {
            ...zoningCandidate(`zone-${episode}-meaningful`, "Residential", 900),
            approximateCells: 24,
            approximateNewFrontage: 80,
          },
        ]
      : pendingCapacity === 0 && frontage <= 0 && roadOpportunities > 0
        ? [{ ...roadCandidate(`road-${episode}`, episode), approximateNewFrontage: 120 }]
        : [];
  const snapshot = buildLocalMayorSnapshotFixture({
    population: { current: 100 + Math.max(0, 24 - pendingCapacity) },
    economy: { treasury: finance, monthlyBalance: -500 },
    demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
    actionablePlanning: { candidates },
  });
  const episodeResult = decideLocalMayorEpisode(snapshot, history, `throughput-${episode}`);
  const action = episodeResult.chosen.action;
  if (action.kind === "choose_candidate") {
    if (action.candidateKind === "zoning") {
      zoningActions++;
      const selected = candidates.find((candidate) => candidate.id === action.candidateId);
      const cells = Number(selected?.approximateCells ?? 1);
      pendingCapacity += cells;
      frontage = Math.max(0, frontage - (cells >= 20 ? 1 : 0));
      meaningfulCapacityAdded += cells >= 20 ? cells : 0;
      finance -= Number(selected?.estimatedCost ?? 0);
    } else {
      roadActions++;
      roadOpportunities--;
      frontage += 2;
      finance -= 2_000;
    }
    history = {
      ...history,
      recentActions: [
        ...history.recentActions,
        {
          key: `candidate:${action.candidateId}`,
          kind: action.kind,
          outcome: "success" as const,
          reason: "synthetic safe execution",
          impact: "capacity_added" as const,
        },
      ].slice(-8),
      consecutiveWaits: 0,
    };
  } else if (action.kind === "wait") {
    waits++;
    pendingCapacity = Math.max(0, pendingCapacity - 12);
    maxWaitStreak = Math.max(maxWaitStreak, history.consecutiveWaits + 1);
    history = { ...history, consecutiveWaits: Math.min(3, history.consecutiveWaits + 1) };
  } else {
    replans++;
    history = { ...history, consecutiveWaits: 0 };
  }
  financeSuicide ||= finance < 0;
}

console.log(
  JSON.stringify({
    scenario: "high-growth-bounded-throughput",
    episodes,
    meaningfulCapacityAdded,
    zoningActions,
    roadActions,
    waits,
    replans,
    maxWaitStreak,
    remainingFrontage: frontage,
    remainingRoadOpportunities: roadOpportunities,
    pendingCapacity,
    finalTreasury: finance,
    financeSuicide,
  }),
);
