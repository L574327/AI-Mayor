import { projectLocalMayorActivity } from "../../src/main/services/ai-mayor/local-mayor/activity";
import {
  corridorCandidateMatches,
  createLocalGrowthIntent,
  growthCorridorBudget,
  nextLocalGrowthIntent,
  rebaseLocalGrowthIntentFromSnapshot,
  zoningCandidateMatches,
} from "../../src/main/services/ai-mayor/local-mayor/corridor";
import {
  classifyLocalDistrictLifecycle,
  decideLocalMayorEpisode,
} from "../../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  roadCandidate,
  zoningCandidate,
} from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

const road = (id: string, index: number, heading = 0) => ({
  ...roadCandidate(id, index),
  approximateDirection: "east",
  roadHeadingDegrees: heading,
  growthDomain: "residential",
});

const stateFor = (overrides: Record<string, unknown> = {}) =>
  compileLocalMayorState(
    buildLocalMayorSnapshotFixture({
      demand: { residential: 95, commercial: 0, industrial: 50 },
      developmentCapacity: {
        reserveStatus: "empty",
        reserveDeficit: true,
        frontierAnchorCount: 1,
        typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
        zonedUnoccupiedByType: { residential: 0, commercial: 30, industrial: 20, office: 0, unknown: 0 },
      },
      actionablePlanning: { candidates: [road("road-a", 1), road("road-b", 2, 180)] },
      ...overrides,
    }),
  );

describe("Local Mayor bounded growth corridor pacing", () => {
  test("high demand and low typed reserve selects an upper-bounded corridor budget", () => {
    const budget = growthCorridorBudget(stateFor());
    expect(budget).toMatchObject({ maxSegments: 8, targetCorridorLength: 640, maxZoningPatches: 8 });
    expect(budget.targetCorridorLength).toBeLessThanOrEqual(640);
  });

  test("continuation keeps the same heading and bounded segment count", () => {
    const state = stateFor();
    const first = state.candidates.roadExpansion[0];
    const intent = createLocalGrowthIntent(state, first, "residential");
    expect(intent).toMatchObject({ phase: "corridor", maxSegments: 8, remainingSegments: 7 });
    expect(corridorCandidateMatches(intent, state.candidates.roadExpansion[0])).toBe(true);
    expect(corridorCandidateMatches(intent, state.candidates.roadExpansion[1])).toBe(false);
    const next = nextLocalGrowthIntent(intent, first, state);
    expect(next.completedCorridorLength).toBe(160);
    expect(next.remainingSegments).toBe(6);
  });

  test("unsafe or off-heading next segment stops being part of the corridor", () => {
    const state = stateFor();
    const intent = createLocalGrowthIntent(state, state.candidates.roadExpansion[0], "residential");
    const unsafe = { ...state.candidates.roadExpansion[1], roadHeadingDegrees: 180 };
    expect(corridorCandidateMatches(intent, unsafe)).toBe(false);
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        localGrowthIntent: intent,
        actionablePlanning: { candidates: [unsafe] },
      }),
    );
    expect(episode.chosen.action).toMatchObject({ kind: "wait", reasonCode: "corridor_no_continuation_candidate" });
    expect(projectLocalMayorActivity({ episode })).toMatchObject({
      activityKind: "blocked",
      waitingReason: "corridor_no_continuation_candidate",
    });
  });

  test("starved active corridor transitions to district takeover even when actionability is blocked", () => {
    const base = stateFor();
    const intent = createLocalGrowthIntent(base, base.candidates.roadExpansion[0], "residential");
    const snapshot = buildLocalMayorSnapshotFixture({
        demand: { residential: 95, commercial: 0, industrial: 0, office: 0 },
        localGrowthIntent: intent,
        localMayorActionability: {
          status: "blocked",
          reasonCode: "no_safe_growth_opportunity_after_frontier_search",
          reason: "the current corridor has no valid continuation",
          refreshAttempted: true,
        },
        developmentCapacity: {
          reserveStatus: "empty",
          reserveDeficit: true,
          frontierAnchorCount: 1,
          availableFrontageCells: 96,
          candidateFrontageCapacity: 96,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
          zonedUnoccupiedByType: { residential: 0, commercial: 30, industrial: 20, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates: [] },
      });
    const state = compileLocalMayorState(snapshot);

    expect(classifyLocalDistrictLifecycle(state)).toBe("selecting_next_district");
    expect(decideLocalMayorEpisode(snapshot).chosen.action).toMatchObject({
      kind: "wait",
      reasonCode: "select_next_district",
    });
  });

  test("fresh readback rebases continuation on the canonical new road source", () => {
    const state = stateFor();
    const intent = createLocalGrowthIntent(state, state.candidates.roadExpansion[0], "residential");
    const fresh = stateFor({
      actionablePlanning: {
        candidates: [{ ...road("fresh-endpoint", 9, 15), roadHeadingDeltaDegrees: 15 }],
      },
    });
    const rebased = rebaseLocalGrowthIntentFromSnapshot(intent, fresh);
    expect(rebased).toMatchObject({ sourceRoad: { index: 9, version: 1 }, preferredHeadingDegrees: 15 });
    expect(corridorCandidateMatches(rebased, fresh.candidates.roadExpansion[0])).toBe(true);
  });

  test("bounded alternatives accept a small heading adjustment and shorter segment", () => {
    const state = stateFor();
    const intent = createLocalGrowthIntent(state, state.candidates.roadExpansion[0], "residential");
    const alternative = {
      ...state.candidates.roadExpansion[0],
      approximateLength: 60,
      roadHeadingDegrees: 15,
      roadHeadingDeltaDegrees: 15,
    };
    expect(corridorCandidateMatches(intent, alternative)).toBe(true);
  });

  test("safe truncation selects zoning after continuation is unavailable", () => {
    const state = stateFor();
    const intent = createLocalGrowthIntent(state, state.candidates.roadExpansion[0], "residential");
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        localGrowthIntent: intent,
        actionablePlanning: {
          candidates: [
            { ...state.candidates.roadExpansion[0], roadHeadingDegrees: 180 },
            zoningCandidate("zone-after-truncate", "Residential"),
          ],
        },
      }),
    );
    expect(episode.chosen.action).toMatchObject({
      kind: "choose_candidate",
      candidateId: "zone-after-truncate",
      reasonCode: "corridor_safe_truncated",
    });
  });

  test("finance and utility pressure shorten the corridor", () => {
    const base = stateFor();
    const pressured = {
      ...base,
      financeRunwayMonths: 2,
      utilities: {
        ...base.utilities,
        electricity: { ...base.utilities.electricity, risk: "tight" as const },
      },
    };
    expect(growthCorridorBudget(pressured, "residential")).toMatchObject({ maxSegments: 1, maxZoningPatches: 1 });
  });

  test("typed reserve sufficiency ends the corridor early and enters digest", () => {
    const state = stateFor();
    const intent = createLocalGrowthIntent(state, state.candidates.roadExpansion[0], "residential");
    const zoningIntent = { ...intent, phase: "zoning" as const, remainingZoningPatches: 2 };
    const zoning = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        actionablePlanning: { candidates: [zoningCandidate("zone-r", "Residential")] },
      }),
    ).candidates.zoning[0];
    const after = nextLocalGrowthIntent(zoningIntent, zoning, {
      ...state,
      developmentCapacity: {
        ...state.developmentCapacity,
        typedReserveDeficit: { ...state.developmentCapacity.typedReserveDeficit, residential: false },
      },
    });
    expect(after.phase).toBe("digest");
    expect(zoningCandidateMatches(zoningIntent, zoning)).toBe(true);
  });

  test("active corridor prioritizes the same-domain next road", () => {
    const base = stateFor();
    const intent = createLocalGrowthIntent(base, base.candidates.roadExpansion[0], "residential");
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 95, commercial: 0, industrial: 0 },
        localGrowthIntent: intent,
        actionablePlanning: { candidates: [road("road-a", 1), road("road-b", 2, 180)] },
      }),
    );
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "road-a" });
  });

  test("zoning phase limits candidates to the intended domain", () => {
    const base = stateFor();
    const intent = {
      ...createLocalGrowthIntent(base, base.candidates.roadExpansion[0], "residential"),
      phase: "zoning" as const,
    };
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: 95, commercial: 0, industrial: 0 },
      localGrowthIntent: intent,
      actionablePlanning: {
        candidates: [zoningCandidate("res-a", "Residential"), zoningCandidate("ind-a", "Industrial")],
      },
    });
    const episode = decideLocalMayorEpisode(snapshot);
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "res-a" });
  });

  test("digest phase produces wait rather than another construction action", () => {
    const base = stateFor();
    const intent = {
      ...createLocalGrowthIntent(base, base.candidates.roadExpansion[0], "residential"),
      phase: "digest" as const,
    };
    const episode = decideLocalMayorEpisode(buildLocalMayorSnapshotFixture({ localGrowthIntent: intent }));
    expect(["wait", "simulate"]).toContain(episode.chosen.action.kind);
  });

  test("activity exposes bounded corridor progress without a new UI contract", () => {
    const base = stateFor();
    const intent = createLocalGrowthIntent(base, base.candidates.roadExpansion[0], "residential");
    const episode = decideLocalMayorEpisode(buildLocalMayorSnapshotFixture({ localGrowthIntent: intent }));
    expect(projectLocalMayorActivity({ episode })).toMatchObject({
      growthProgress: { domain: "residential", phase: "corridor", current: 1, total: 8 },
    });
  });
});
