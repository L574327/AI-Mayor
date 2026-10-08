import { decideLocalMayorEpisode } from "../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
  zoningCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../src/main/services/ai-mayor/local-mayor/state";

let population = 135;
let districtCycles = 0;
let roads = 0;
let zoning = 0;
let waitingTicks = 0;
let blockedTicks = 0;
let buildSelections = 0;
let simulateSelections = 0;
let absorbCount = 0;
let consecutiveBuildBursts = 0;
let maxConsecutiveBuildBursts = 0;
const history: {
  recentActions: Array<{
    key: string;
    kind: "choose_candidate" | "wait" | "simulate";
    outcome: "success";
    reason: string;
  }>;
} = {
  recentActions: [],
};
const trajectory = [{ cycle: 0, population }];

while (population < 500 && districtCycles < 100) {
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => ({
      ...roadCandidate(`district-${districtCycles}-road-${index}`, 10000 + districtCycles * 10 + index),
      growthDomain: "residential",
      roadHeadingDegrees: 0,
      roadHeadingDeltaDegrees: index === 0 ? 0 : 15,
    })),
    ...Array.from({ length: 4 }, (_, index) => zoningCandidate(`district-${districtCycles}-zone-${index}`)),
  ];
  const snapshot = buildLocalMayorSnapshotFixture({
    population: { current: population },
    demand: { residential: 100, commercial: 0, industrial: 0, office: 0 },
    developmentCapacity: {
      reserveStatus: "empty",
      reserveDeficit: true,
      typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
      zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
    },
    actionablePlanning: { candidates },
  });
  const state = compileLocalMayorState(snapshot);
  const episode = decideLocalMayorEpisode(snapshot, history);
  const action = episode.chosen.action;
  if (action.kind === "choose_candidate" && action.candidateIds?.length) {
    buildSelections += 1;
    consecutiveBuildBursts += 1;
    maxConsecutiveBuildBursts = Math.max(maxConsecutiveBuildBursts, consecutiveBuildBursts);
    history.recentActions.push({
      key: `burst:${districtCycles}`,
      kind: "choose_candidate",
      outcome: "success",
      reason: "built",
    });
    history.recentActions = history.recentActions.slice(-8);
    districtCycles += 1;
    roads += action.candidateIds.filter((id) => id.includes("road")).length;
    zoning += action.candidateIds.filter((id) => id.includes("zone")).length;
    population += Math.max(12, action.candidateIds.filter((id) => id.includes("zone")).length * 4);
    trajectory.push({ cycle: districtCycles, population });
    continue;
  }
  if (action.kind === "simulate") {
    simulateSelections += 1;
    absorbCount += 1;
    consecutiveBuildBursts = 0;
    history.recentActions.push({
      key: `absorb:${districtCycles}`,
      kind: "simulate",
      outcome: "success",
      reason: "absorbed",
    });
    history.recentActions = history.recentActions.slice(-8);
  }
  if (action.kind === "wait") {
    waitingTicks += 1;
    absorbCount += 1;
    consecutiveBuildBursts = 0;
    history.recentActions.push({
      key: `absorb:${districtCycles}`,
      kind: "wait",
      outcome: "success",
      reason: "absorbed",
    });
    history.recentActions = history.recentActions.slice(-8);
  }
  if (action.kind === "simulate") waitingTicks += 1;
  if (state.actionability.status === "blocked") blockedTicks += 1;
  districtCycles += 1;
}

console.log(
  JSON.stringify(
    {
      startingPopulation: 135,
      finalPopulation: population,
      wallClockEquivalentDecisionSteps: districtCycles,
      districtGrowthCycles: districtCycles,
      districtBursts: buildSelections,
      consecutiveBuildBurstsMax: maxConsecutiveBuildBursts,
      fastAbsorbCount: absorbCount,
      absorbQuantumGameHours: 0.25,
      buildSelections,
      simulateSelections,
      roads,
      zoning,
      waitingTicks,
      blockedTicks,
      waitingPercentage: Number(((waitingTicks / Math.max(1, districtCycles)) * 100).toFixed(1)),
      blockedPercentage: Number(((blockedTicks / Math.max(1, districtCycles)) * 100).toFixed(1)),
      trajectory,
      providerCalls: 0,
      bounded: roads <= districtCycles * 8 && zoning <= districtCycles * 8,
    },
    null,
    2,
  ),
);
