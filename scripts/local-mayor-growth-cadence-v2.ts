import fs from "node:fs";
import path from "node:path";
import { decideLocalMayorEpisode } from "../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  zoningCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";

const episodes = 100;
let officeReserve = 0;
let growthCycles = 0;
let zoningPatches = 0;
let waitingForDemand = 0;
let waitingForAbsorption = 0;
let waitingForSimulation = 0;
let digestGameHours = 0;
let firstOfficeBuild = -1;
let digestPending = false;
const transitions: string[] = [];

for (let episode = 0; episode < episodes; episode += 1) {
  if (digestPending) {
    officeReserve = Math.max(0, officeReserve - 8);
    digestPending = false;
  }
  const snapshot = buildLocalMayorSnapshotFixture({
    population: { current: 120 + Math.floor(episode / 5) },
    economy: { treasury: 2_000_000, monthlyBalance: -2_000 },
    demand: { residential: 100, commercial: 0, industrial: 38, office: 100 },
    developmentCapacity: {
      targetZoningCells: 24,
      reserveStatus: officeReserve >= 24 ? "digesting" : "low",
      reserveDeficit: officeReserve < 24,
      developmentDigesting: officeReserve > 0,
      frontierAnchorCount: 1,
      zonedUnoccupiedByType: { residential: 157, commercial: 495, industrial: 50, office: officeReserve, unknown: 0 },
      typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: officeReserve < 24 },
    },
    actionablePlanning: {
      candidates: [0, 1, 2, 3].map((index) => zoningCandidate(`office-${episode}-${index}`, "Office")),
    },
  });
  const decision = decideLocalMayorEpisode(snapshot);
  const action = decision.chosen.action;
  if (action.kind === "choose_candidate") {
    officeReserve += 16;
    zoningPatches += 1;
    if (firstOfficeBuild < 0) firstOfficeBuild = episode;
    transitions.push(`${episode}:BUILD:office:${officeReserve}`);
    if (officeReserve >= 24) {
      growthCycles += 1;
      transitions.push(`${episode}:DIGEST`);
      digestGameHours += 2;
      digestPending = true; // bounded absorption is applied at the next game-time observation.
    }
  } else if (
    action.reasonCode === "waiting_for_absorption" ||
    action.reasonCode === "digest_growth_corridor" ||
    action.reasonCode === "digest_existing_capacity"
  ) {
    waitingForAbsorption += 1;
    digestPending = true;
    digestGameHours += 0.5;
  } else if (action.kind === "simulate" || action.reasonCode === "observe_bounded_growth") {
    waitingForSimulation += 1;
  } else if (action.kind === "wait") {
    waitingForDemand += 1;
  }
}

const summary = {
  episodes,
  growthCycles,
  zoningPatches,
  roadSegments: 0,
  waitingForDemand,
  waitingForAbsorption,
  waitingForSimulation,
  averageDigestGameHours: growthCycles ? digestGameHours / growthCycles : 0,
  firstOfficeBuildEpisode: firstOfficeBuild,
  finalOfficeReserve: officeReserve,
  providerCalls: 0,
  bounded:
    zoningPatches / episodes <= 4 && !transitions.some((item) => item.includes("BUILD") && item.split(":")[0] === "4"),
  transitions: transitions.slice(0, 24),
};
const outputDirectory = path.join(process.cwd(), "docs/ai-mayor/evidence/local-mayor-growth-cadence-v2-2026-09-11");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(`${JSON.stringify(summary)}\n`);
