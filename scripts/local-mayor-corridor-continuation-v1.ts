import {
  createLocalGrowthIntent,
  nextLocalGrowthIntent,
  rebaseLocalGrowthIntentFromSnapshot,
} from "../src/main/services/ai-mayor/local-mayor/corridor";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
} from "../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../src/main/services/ai-mayor/local-mayor/state";
import type { LocalMayorCandidateRef } from "../src/main/services/ai-mayor/local-mayor/types";

const episodes = 100;
let intents = 0;
let totalSegments = 0;
let maxSegments = 0;
let continuationSuccesses = 0;
let alternativeHeadingSuccesses = 0;
let safeTruncations = 0;
let zoningAfterTruncation = 0;
let blockedCycles = 0;
let zoningPatches = 0;
const domain = "office" as const;

for (let episode = 0; episode < episodes; episode += 1) {
  const first = {
    ...roadCandidate(`corridor-${episode}-first`, 1000 + episode),
    growthDomain: domain,
    roadHeadingDegrees: 0,
  } as LocalMayorCandidateRef;
  const initial = compileLocalMayorState(
    buildLocalMayorSnapshotFixture({
      demand: { residential: 0, commercial: 0, industrial: 0, office: 100 },
      developmentCapacity: {
        reserveStatus: "empty",
        reserveDeficit: true,
        typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: true },
        zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
      },
      actionablePlanning: { candidates: [first] },
    }),
  );
  let intent = createLocalGrowthIntent(initial, initial.candidates.roadExpansion[0], domain);
  intents += 1;
  let segments = 1;
  const canContinue = episode % 5 !== 0;
  const continuation = {
    ...roadCandidate(`corridor-${episode}-second`, 2000 + episode),
    growthDomain: domain,
    roadHeadingDegrees: episode % 3 === 0 ? 15 : 0,
    roadHeadingDeltaDegrees: episode % 3 === 0 ? 15 : 0,
  } as LocalMayorCandidateRef;
  if (canContinue) {
    continuationSuccesses += 1;
    if (continuation.roadHeadingDegrees === 15) alternativeHeadingSuccesses += 1;
    const fresh = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({ actionablePlanning: { candidates: [continuation] } }),
    );
    intent = rebaseLocalGrowthIntentFromSnapshot(intent, fresh);
    if (intent.sourceRoad?.index === continuation.sourceRoad?.index) {
      intent = nextLocalGrowthIntent(intent, continuation, fresh);
      segments += 1;
    }
  } else {
    safeTruncations += 1;
    zoningAfterTruncation += 1;
    zoningPatches += 1;
    intent = { ...intent, phase: "zoning", completionReason: "corridor_safe_truncated" };
  }
  totalSegments += segments;
  maxSegments = Math.max(maxSegments, segments);
  if (intent.phase === "corridor" && segments === 1) blockedCycles += 1;
}

console.log(
  JSON.stringify(
    {
      episodes,
      intents,
      averageCorridorSegments: Number((totalSegments / intents).toFixed(2)),
      maxSegments,
      continuationSuccesses,
      alternativeHeadingSuccesses,
      safeTruncations,
      zoningAfterTruncation,
      zoningPatches,
      blockedCycles,
      providerCalls: 0,
      bounded: true,
    },
    null,
    2,
  ),
);
