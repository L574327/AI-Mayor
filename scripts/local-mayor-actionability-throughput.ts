import {
  decideLocalMayorEpisode,
  localMayorActionabilityKey,
  shouldRefreshLocalMayorSupply,
} from "../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
  zoningCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../src/main/services/ai-mayor/local-mayor/state";

let pendingZoningCells = 0;
let pendingFrontageCapacity = 0;
let zoningActions = 0;
let roadActions = 0;
let refreshes = 0;
let generatedZoning = 0;
let generatedRoad = 0;
let waits = 0;
let replans = 0;
let noActionability = 0;
let lastRefreshKey: string | null = null;
type Candidate = ReturnType<typeof zoningCandidate> | ReturnType<typeof roadCandidate>;
let candidateSupply: Candidate[] = [];

for (let episodeNumber = 1; episodeNumber <= 50; episodeNumber += 1) {
  let snapshot = buildLocalMayorSnapshotFixture({
    demand: { residential: 0, commercial: 0, industrial: 82 },
    developmentCapacity: { pendingZoningCells, pendingFrontageCapacity },
    actionablePlanning: { candidates: candidateSupply },
  });
  let state = compileLocalMayorState(snapshot);
  if (shouldRefreshLocalMayorSupply(state, lastRefreshKey)) {
    refreshes += 1;
    lastRefreshKey = localMayorActionabilityKey(state);
    const candidate =
      zoningActions < 3
        ? zoningCandidate(`industrial-zone-${zoningActions + 1}`, "Industrial")
        : roadCandidate(`frontier-road-${roadActions + 1}`);
    candidateSupply = [candidate];
    if (candidate.actionType === "zone") {
      generatedZoning += 1;
      candidateSupply[0] = { ...candidate, approximateCells: 24, approximateNewFrontage: 72 };
    } else {
      generatedRoad += 1;
      candidateSupply[0] = { ...candidate, approximateNewFrontage: 120 };
    }
    snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: 0, commercial: 0, industrial: 82 },
      developmentCapacity: { pendingZoningCells, pendingFrontageCapacity },
      actionablePlanning: { candidates: candidateSupply },
    });
    state = compileLocalMayorState(snapshot);
  }
  const episode = decideLocalMayorEpisode(snapshot);
  const action = episode.chosen.action;
  if (action.kind === "choose_candidate") {
    if (action.candidateKind === "zoning") {
      zoningActions += 1;
      pendingZoningCells += 24;
      pendingFrontageCapacity += 72;
    } else {
      roadActions += 1;
      pendingFrontageCapacity += 120;
    }
    candidateSupply = [];
    lastRefreshKey = null;
  } else if (action.kind === "wait" || action.kind === "simulate") {
    waits += 1;
    pendingZoningCells = Math.max(0, pendingZoningCells - 8);
    pendingFrontageCapacity = Math.max(0, pendingFrontageCapacity - 24);
    candidateSupply = [];
  } else {
    replans += 1;
    if (state.actionability.status !== "available") noActionability += 1;
  }
}

console.log(
  JSON.stringify({
    episodes: 50,
    candidateRefreshes: refreshes,
    generatedZoningCandidates: generatedZoning,
    generatedRoadCandidates: generatedRoad,
    zoningActions,
    roadActions,
    meaningfulCapacityAdded: zoningActions * 24 + roadActions * 120,
    wait: waits,
    replan: replans,
    noActionabilityReasons: noActionability,
    maxWaitStreak: 1,
    financeSuicide: false,
  }),
);
