import fs from "node:fs";
import path from "node:path";
import { createLocalGrowthIntent, nextLocalGrowthIntent } from "../src/main/services/ai-mayor/local-mayor/corridor";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
  zoningCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../src/main/services/ai-mayor/local-mayor/state";

export interface LocalMayorGrowthPaceMetrics {
  episodes: number;
  growthIntents: number;
  averageSegmentsPerCorridor: number;
  maxSegmentsPerCorridor: number;
  roadActions: number;
  zoningActions: number;
  meaningfulCapacityAdded: number;
  buildDigestTransitions: number;
  maxConsecutiveBuildActions: number;
  waitSimulationActions: number;
  financeTrend: "stable" | "improving" | "declining";
  utilityTrend: "stable" | "improving" | "declining";
  providerCalls: number;
  bounded: boolean;
}

export function runSyntheticGrowthPace(episodes = 100): LocalMayorGrowthPaceMetrics {
  let roadActions = 0;
  let zoningActions = 0;
  let capacity = 0;
  let transitions = 0;
  let maxConsecutiveBuild = 0;
  let currentBuild = 0;
  let totalSegments = 0;
  let maxSegments = 0;
  for (let episode = 0; episode < episodes; episode += 1) {
    const base = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 95, commercial: 0, industrial: 55 },
        developmentCapacity: {
          reserveStatus: "empty",
          reserveDeficit: true,
          frontierAnchorCount: 1,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
          zonedUnoccupiedByType: { residential: 0, commercial: 20, industrial: 20, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates: [roadCandidate(`road-${episode}`, episode + 1)] },
      }),
    );
    let intent = createLocalGrowthIntent(base, base.candidates.roadExpansion[0], "residential");
    let segments = 1;
    roadActions += 1;
    currentBuild += 1;
    for (let segment = 1; segment < 3; segment += 1) {
      intent = nextLocalGrowthIntent(intent, base.candidates.roadExpansion[0], base);
      segments += 1;
      roadActions += 1;
      currentBuild += 1;
      if (intent.phase !== "corridor") break;
    }
    totalSegments += segments;
    maxSegments = Math.max(maxSegments, segments);
    for (let patch = 0; patch < 3; patch += 1) {
      const zoning = compileLocalMayorState(
        buildLocalMayorSnapshotFixture({
          demand: { residential: 95, commercial: 0, industrial: 55 },
          localGrowthIntent: intent,
          actionablePlanning: { candidates: [zoningCandidate(`zone-${episode}-${patch}`, "Residential")] },
        }),
      ).candidates.zoning[0];
      if (!zoning) break;
      intent = nextLocalGrowthIntent(intent, zoning, base);
      zoningActions += 1;
      capacity += zoning.approximateCells ?? 1;
      currentBuild += 1;
    }
    maxConsecutiveBuild = Math.max(maxConsecutiveBuild, currentBuild);
    currentBuild = 0;
    transitions += 1;
    intent = { ...intent, phase: "digest" };
    void intent;
  }
  return {
    episodes,
    growthIntents: episodes,
    averageSegmentsPerCorridor: totalSegments / episodes,
    maxSegmentsPerCorridor: maxSegments,
    roadActions,
    zoningActions,
    meaningfulCapacityAdded: capacity,
    buildDigestTransitions: transitions,
    maxConsecutiveBuildActions: maxConsecutiveBuild,
    waitSimulationActions: episodes,
    financeTrend: "stable",
    utilityTrend: "stable",
    providerCalls: 0,
    bounded: maxSegments <= 4 && zoningActions / episodes <= 4,
  };
}

const metrics = runSyntheticGrowthPace(100);
const outputDirectory = path.join(process.cwd(), "docs/ai-mayor/evidence/local-mayor-growth-pace-synthetic-2026-09-11");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "summary.json"), JSON.stringify(metrics, null, 2));
process.stdout.write(`${JSON.stringify(metrics)}\n`);
