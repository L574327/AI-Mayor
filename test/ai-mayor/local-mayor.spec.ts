import { projectLocalMayorActivity } from "../../src/main/services/ai-mayor/local-mayor/activity";
import {
  advanceLocalMayorObservation,
  classifyLocalDistrictLifecycle,
  compareMayorWorldForEpisode,
  decideLocalMayorEpisode,
  generateLocalMayorGoals,
  growthGoalUrgency,
  invalidateLocalMayorEpisode,
  isAbsorbing,
  localMayorActionabilityKey,
  recordLocalMayorOutcome,
  shouldEnsureGrowthOpportunity,
  shouldHarvestZoning,
  shouldRefreshLocalMayorSupply,
} from "../../src/main/services/ai-mayor/local-mayor/decision";
import {
  buildLocalMayorSnapshotFixture,
  LOCAL_MAYOR_REPLAY_SCENARIOS,
  roadCandidate,
  zoningCandidate,
} from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

describe("Local Mayor Engine v0 replay", () => {
  test("provides at least thirty reusable scenarios", () => {
    expect(LOCAL_MAYOR_REPLAY_SCENARIOS.length).toBeGreaterThanOrEqual(30);
  });

  test.each(
    LOCAL_MAYOR_REPLAY_SCENARIOS.map((scenario) => [scenario.name, scenario]),
  )("is deterministic: %s", (_name, scenario) => {
    const first = decideLocalMayorEpisode(scenario.snapshot, undefined, "replay-seed");
    const second = decideLocalMayorEpisode(scenario.snapshot, undefined, "replay-seed");
    expect(first.chosen).toEqual(second.chosen);
    expect(first.trace).toEqual(second.trace);
  });

  test("wait is preferred for healthy low-demand cities", () => {
    expect(decideLocalMayorEpisode(buildLocalMayorSnapshotFixture()).chosen.action.kind).toBe("wait");
  });

  test("healthy early city produces a bounded district burst instead of one micro action", () => {
    const candidates = [
      ...Array.from({ length: 4 }, (_, index) => ({
        ...roadCandidate(`district-road-${index}`, 200 + index),
        growthDomain: "residential",
        roadHeadingDegrees: 0,
      })),
      ...Array.from({ length: 4 }, (_, index) => zoningCandidate(`district-zone-${index}`)),
    ];
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        population: { current: 125 },
        demand: { residential: 100, commercial: 0, industrial: 0, office: 0 },
        developmentCapacity: {
          reserveStatus: "empty",
          reserveDeficit: true,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
          zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates },
      }),
    );
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "district-zone-0" });
    const burst = episode.chosen.action.kind === "choose_candidate" ? (episode.chosen.action.candidateIds ?? []) : [];
    expect(burst.length).toBeGreaterThanOrEqual(4);
    expect(burst.length).toBeLessThanOrEqual(8);
  });

  test("digesting district capacity waits for absorption instead of becoming blocked", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      population: { current: 125 },
      demand: { residential: 100, commercial: 0, industrial: 0, office: 0 },
      developmentCapacity: {
        reserveStatus: "digesting",
        developmentDigesting: true,
        reserveDeficit: true,
        typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
        zonedUnoccupiedByType: { residential: 8, commercial: 0, industrial: 0, office: 0, unknown: 0 },
      },
      actionablePlanning: { candidates: [] },
    });
    const episode = decideLocalMayorEpisode(snapshot);
    expect(episode.chosen.action).toMatchObject({ kind: "wait", reasonCode: "waiting_for_absorption" });
    expect(projectLocalMayorActivity({ episode })).toMatchObject({ activityKind: "waiting_for_absorption" });
  });

  test("digesting district capacity with pressure builds the next district when a safe candidate exists", () => {
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        population: { current: 135 },
        demand: { residential: 100, commercial: 0, industrial: 0, office: 100 },
        developmentCapacity: {
          reserveStatus: "digesting",
          developmentDigesting: true,
          reserveDeficit: true,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: true },
          zonedUnoccupiedByType: { residential: 8, commercial: 0, industrial: 0, office: 8, unknown: 0 },
        },
        actionablePlanning: { candidates: [zoningCandidate("next-district-zone")] },
      }),
    );
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "next-district-zone" });
    expect(projectLocalMayorActivity({ episode })).toMatchObject({ activityKind: "building" });
  });

  test("healthy early build is bounded to two consecutive district bursts", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      population: { current: 135 },
      demand: { residential: 100, commercial: 0, industrial: 0, office: 0 },
      actionablePlanning: { candidates: [zoningCandidate("bounded-zone")] },
    });
    const episode = decideLocalMayorEpisode(snapshot, {
      recentActions: [
        { key: "candidate:old-1", kind: "choose_candidate", outcome: "success", reason: "built" },
        { key: "candidate:old-2", kind: "choose_candidate", outcome: "success", reason: "built" },
      ],
    });
    expect(episode.chosen.action.kind).toBe("wait");
  });

  test("guard skips do not reset the mandatory absorb boundary", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      population: { current: 135 },
      demand: { residential: 100, commercial: 0, industrial: 0, office: 0 },
      actionablePlanning: { candidates: [zoningCandidate("bounded-zone")] },
    });
    const episode = decideLocalMayorEpisode(snapshot, {
      recentActions: [
        { key: "candidate:old-1", kind: "choose_candidate", outcome: "success", reason: "built" },
        {
          key: "candidate:guard-skip",
          kind: "choose_candidate",
          outcome: "failure",
          reason: "road_attempt_guard_skipped",
        },
        { key: "candidate:old-2", kind: "choose_candidate", outcome: "success", reason: "built" },
      ],
    });
    expect(episode.chosen.action.kind).toBe("wait");
  });

  test("empty local registry selects the next district when global opportunity remains", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 100, commercial: 0, industrial: 0, office: 100 },
        developmentCapacity: {
          reserveStatus: "empty",
          reserveDeficit: true,
          frontierAnchorCount: 2,
          candidateFrontageCapacity: 32,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: true },
          zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates: [] },
      }),
    );
    expect(classifyLocalDistrictLifecycle(state)).toBe("selecting_next_district");
  });

  test("empty global registry is a real blocker only when no safe opportunity remains", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 100, commercial: 0, industrial: 0, office: 0 },
        developmentCapacity: {
          reserveStatus: "empty",
          reserveDeficit: true,
          frontierAnchorCount: 0,
          candidateFrontageCapacity: 0,
          availableFrontageCells: 0,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
          zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates: [] },
      }),
    );
    expect(classifyLocalDistrictLifecycle(state)).toBe("blocked");
  });

  test("raw demand jitter within the same band does not change actionability context", () => {
    const low = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({ demand: { residential: 0, commercial: 0, industrial: 58 } }),
    );
    const high = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({ demand: { residential: 0, commercial: 0, industrial: 62 } }),
    );
    expect(localMayorActionabilityKey(low)).toBe(localMayorActionabilityKey(high));
  });

  test("industrial demand with empty supply requests one bounded planner refresh", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 0, commercial: 0, industrial: 75 },
        developmentCapacity: { pendingZoningCells: 0, pendingFrontageCapacity: 0 },
        actionablePlanning: { candidates: [], status: "available", note: "no safe candidate" },
      }),
    );
    expect(shouldRefreshLocalMayorSupply(state, null)).toBe(true);
    expect(shouldRefreshLocalMayorSupply(state, localMayorActionabilityKey(state))).toBe(false);
    expect(
      decideLocalMayorEpisode({
        ...buildLocalMayorSnapshotFixture({ demand: { residential: 0, commercial: 0, industrial: 75 } }),
        localMayorActionability: {
          status: "blocked",
          reasonCode: "no_safe_actionability_after_refresh",
          reason: "no industrial frontage is safe",
          refreshAttempted: true,
        },
      }).chosen.action,
    ).toMatchObject({ kind: "wait", reasonCode: "no_safe_actionability" });
  });

  test("pending capacity suppresses an unnecessary planner refresh", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 0, commercial: 0, industrial: 80 },
        developmentCapacity: { pendingZoningCells: 64, pendingFrontageCapacity: 160 },
        actionablePlanning: { candidates: [] },
      }),
    );
    expect(state.actionability.capacityStatus).toBe("sufficient");
    expect(shouldRefreshLocalMayorSupply(state, null)).toBe(false);
    expect(
      decideLocalMayorEpisode(
        buildLocalMayorSnapshotFixture({
          demand: { residential: 0, commercial: 0, industrial: 80 },
          developmentCapacity: { pendingZoningCells: 64, pendingFrontageCapacity: 160 },
          actionablePlanning: { candidates: [] },
        }),
      ).chosen.action,
    ).toMatchObject({ kind: "wait", reasonCode: "digest_existing_capacity" });
  });

  test("typed industrial deficit is not masked by aggregate residential reserve", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 0, commercial: 0, industrial: 49 },
        developmentCapacity: {
          existingZonedUnoccupiedCells: 512,
          availableDevelopmentCells: 512,
          frontierAnchorCount: 1,
          reserveStatus: "digesting",
          reserveDeficit: false,
          zonedUnoccupiedByType: { residential: 512, commercial: 0, industrial: 0, office: 0, unknown: 0 },
          typedReserveDeficit: { residential: false, commercial: true, industrial: true, office: true },
        },
        actionablePlanning: { candidates: [] },
      }),
    );
    expect(state.developmentCapacity.zonedUnoccupiedByType?.industrial).toBe(0);
    expect(shouldRefreshLocalMayorSupply(state, null)).toBe(true);
    expect(shouldEnsureGrowthOpportunity(state)).toBe(true);
    const goals = generateLocalMayorGoals(state);
    expect(goals).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "maintain_development_reserve", domain: "industrial" })]),
    );
    // The typed industrial deficit must outrank an aggregate residential reserve.
    // Under the default policy residential is no longer withheld outright — it is
    // a candidate — so "not masked" is now an ordering claim rather than an
    // absence claim, which is the stronger of the two.
    const industrial = goals.find((goal) => goal.domain === "industrial" && goal.kind === "grow_industrial");
    const residential = goals.find((goal) => goal.kind === "grow_residential");
    expect(industrial).toBeDefined();
    if (residential) expect(industrial!.urgency).toBeGreaterThan(residential.urgency);
    // The superseded policy still masks it by absence.
    expect(generateLocalMayorGoals(state, "ABSORPTION_CONTROL"))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "grow_residential" })]));
  });

  test("office high demand and zero office reserve creates a first-class office growth goal", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      population: { current: 120 },
      demand: { residential: 100, commercial: 0, industrial: 38, office: 100 },
      developmentCapacity: {
        targetZoningCells: 24,
        reserveStatus: "digesting",
        zonedUnoccupiedByType: { residential: 157, commercial: 495, industrial: 50, office: 0, unknown: 0 },
        typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: true },
      },
      actionablePlanning: { candidates: [zoningCandidate("office-1", "Office")] },
    });
    const state = compileLocalMayorState(snapshot);
    expect(state.actionability.capacityStatus).toBe("insufficient");
    const episode = decideLocalMayorEpisode(snapshot);
    expect(episode.goals).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "grow_office", domain: "office" })]),
    );
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "office-1" });
  });

  /**
   * Every demand at its maximum is the state a city starts in, and it is the one
   * state where demand cannot order the domains at all: all four read 100, so all
   * four goals come out at the same urgency. The alphabetical fallback then put
   * `grow_commercial` first — and because the demand that would break the tie is
   * produced by the housing the ranking never picked, the city could not leave
   * the equilibrium. Measured live (2026-10-01, fresh city): eight consecutive
   * `EXPAND_COMMERCIAL` Goals, zero residential, population 0 after fifteen
   * minutes of autonomy, on a map with 0 water and 0 sewage before the utility
   * branch proof was fixed and with both built afterwards.
   */
  test("every demand at its maximum ranks the expansion domains in the policy's own order", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        population: { current: 0 },
        demand: { residential: 100, commercial: 100, industrial: 100, office: 100 },
        developmentCapacity: { targetZoningCells: 24, reserveStatus: "empty" },
        actionablePlanning: { candidates: [] },
      }),
    );
    expect(generateLocalMayorGoals(state)
      .filter((goal) => goal.kind.startsWith("grow_"))
      .map((goal) => goal.kind))
      .toEqual(["grow_residential", "grow_commercial", "grow_industrial", "grow_office"]);
  });

  test("zero demand does not consume another type's reserve", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 0, commercial: 0, industrial: 0 },
        developmentCapacity: {
          existingZonedUnoccupiedCells: 512,
          availableDevelopmentCells: 512,
          reserveStatus: "digesting",
          reserveDeficit: false,
          zonedUnoccupiedByType: { residential: 512, commercial: 0, industrial: 0, office: 0, unknown: 0 },
          typedReserveDeficit: { residential: false, commercial: true, industrial: true, office: true },
        },
        actionablePlanning: { candidates: [] },
      }),
    );
    expect(shouldRefreshLocalMayorSupply(state, null)).toBe(false);
    expect(shouldEnsureGrowthOpportunity(state)).toBe(false);
  });

  test("a healthy tiny city can maintain a reserve even when raw demand is low", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: 0, commercial: 0, industrial: 35 },
        developmentCapacity: {
          reserveStatus: "empty",
          reserveDeficit: true,
          frontierAnchorCount: 1,
          targetZoningCells: 32,
          availableDevelopmentCells: 0,
        },
      }),
    );
    expect(state.developmentCapacity.reserveDeficit).toBe(true);
    expect(state.developmentCapacity.frontierAnchorCount).toBe(1);
    expect(shouldEnsureGrowthOpportunity(state)).toBe(true);
    expect(
      decideLocalMayorEpisode({
        ...buildLocalMayorSnapshotFixture({
          demand: { residential: 0, commercial: 0, industrial: 35 },
          developmentCapacity: {
            reserveStatus: "empty",
            reserveDeficit: true,
            frontierAnchorCount: 1,
            targetZoningCells: 32,
            availableDevelopmentCells: 0,
          },
        }),
        localMayorActionability: { status: "blocked", reasonCode: "no_safe_actionability_after_refresh" },
      }).trace.goals,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "maintain_development_reserve" })]));
  });

  test("activity projection is bounded and distinguishes planning, building, waiting, and blocked", () => {
    const buildingEpisode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        demand: { residential: { high: 90 } },
        actionablePlanning: { candidates: [zoningCandidate("focus-me")] },
      }),
    );
    const building = projectLocalMayorActivity({ episode: buildingEpisode });
    expect(building).toMatchObject({ activityKind: "building", focusTarget: { candidateId: "focus-me" } });
    expect(JSON.stringify(building)).not.toMatch(/coordinates|geometry|vertices/);
    expect(
      projectLocalMayorActivity({
        episode: buildingEpisode,
        impact: {
          kind: "no_material_change",
          worldChanged: false,
          capacityAdded: false,
          roadAdded: false,
          zoningAdded: false,
          summary: "unchanged readback",
        },
      }),
    ).toMatchObject({ activityKind: "observing", reasonCode: "no_material_change" });

    const waiting = projectLocalMayorActivity({
      episode: decideLocalMayorEpisode(
        buildLocalMayorSnapshotFixture({
          developmentCapacity: { pendingZoningCells: 64, pendingFrontageCapacity: 160 },
          actionablePlanning: { candidates: [] },
        }),
      ),
    });
    expect(waiting.activityKind).toBe("waiting_for_absorption");

    const blocked = projectLocalMayorActivity({
      episode: decideLocalMayorEpisode({
        ...buildLocalMayorSnapshotFixture({
          demand: { residential: { high: 90 } },
          actionablePlanning: { candidates: [] },
        }),
        localMayorActionability: {
          status: "blocked",
          reasonCode: "no_safe_actionability_after_refresh",
          reason: "no safe candidate",
          refreshAttempted: true,
        },
      }),
    });
    expect(blocked).toMatchObject({ activityKind: "blocked", reasonCode: "no_safe_actionability_after_refresh" });

    const malformed = projectLocalMayorActivity({
      episode: {
        ...buildingEpisode,
        state: {
          ...buildingEpisode.state,
          candidates: { ...buildingEpisode.state.candidates, zoning: [], roadExpansion: [] },
        },
      },
    });
    expect(malformed).toMatchObject({ activityKind: "blocked", reasonCode: "candidate_not_executable" });

    const observing = projectLocalMayorActivity({
      episode: decideLocalMayorEpisode(
        buildLocalMayorSnapshotFixture({
          demand: { residential: 0, commercial: 0, industrial: 75 },
          actionablePlanning: { candidates: [] },
        }),
        { consecutiveWaits: 2 },
      ),
    });
    expect(observing).toMatchObject({ activityKind: "observing", displayKey: "local_mayor.observing" });
  });

  test("uses validated residential frontage under strong demand", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [zoningCandidate("res-1")] },
    });
    expect(decideLocalMayorEpisode(snapshot).chosen.action).toMatchObject({
      kind: "choose_candidate",
      candidateId: "res-1",
      candidateKind: "zoning",
    });
  });

  test("chooses bounded road expansion when frontage is unavailable", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [roadCandidate("frontier-1")] },
    });
    expect(decideLocalMayorEpisode(snapshot).chosen.action).toMatchObject({
      kind: "choose_candidate",
      candidateId: "frontier-1",
      candidateKind: "road_expansion",
    });
  });

  test("harvests actionable zoning before road expansion after frontage exists", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        population: { current: 268 },
        demand: { residential: { high: 95 }, commercial: 0, industrial: 0, office: 0 },
        developmentCapacity: {
          availableFrontageCells: 32,
          reserveStatus: "low",
          reserveDeficit: true,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
          zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates: [roadCandidate("new-road"), zoningCandidate("frontage-zone")] },
      }),
    );
    expect(shouldHarvestZoning(state)).toBe(true);
    expect(decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        population: { current: 268 },
        demand: { residential: { high: 95 }, commercial: 0, industrial: 0, office: 0 },
        developmentCapacity: {
          availableFrontageCells: 32,
          reserveStatus: "low",
          reserveDeficit: true,
          typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
          zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
        },
        actionablePlanning: { candidates: [roadCandidate("new-road"), zoningCandidate("frontage-zone")] },
      }),
      state.history,
    ).chosen.action).toMatchObject({
      kind: "choose_candidate",
      candidateId: "frontage-zone",
      candidateKind: "zoning",
    });
  });

  test("keeps typed domain selection when harvesting multiple demand deficits", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      population: { current: 268 },
      demand: { residential: 0, commercial: 0, industrial: 80, office: 100 },
      developmentCapacity: {
        availableFrontageCells: 48,
        reserveStatus: "low",
        reserveDeficit: true,
        typedReserveDeficit: { residential: false, commercial: false, industrial: true, office: true },
        zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 },
      },
      actionablePlanning: {
        candidates: [zoningCandidate("industrial-zone", "Industrial"), zoningCandidate("office-zone", "Office"), roadCandidate("frontier-road")],
      },
    });
    expect(decideLocalMayorEpisode(snapshot).chosen.action).toMatchObject({
      kind: "choose_candidate",
      candidateId: "industrial-zone",
      candidateKind: "zoning",
    });
  });

  test("meaningful zoning capacity beats a tiny safe zoning patch under strong demand", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
        actionablePlanning: {
          candidates: [
            { ...zoningCandidate("tiny", "Residential"), approximateCells: 2, approximateNewFrontage: 8 },
            { ...zoningCandidate("meaningful", "Residential"), approximateCells: 32, approximateNewFrontage: 96 },
          ],
        },
      }),
    );
    const meaningful = state.candidates.zoning.find((candidate) => candidate.id === "meaningful");
    const tiny = state.candidates.zoning.find((candidate) => candidate.id === "tiny");
    expect(meaningful?.approximateCells).toBe(32);
    expect(meaningful && tiny).toBeTruthy();
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
        actionablePlanning: {
          candidates: [
            { ...zoningCandidate("tiny", "Residential"), approximateCells: 2, approximateNewFrontage: 8 },
            { ...zoningCandidate("meaningful", "Residential"), approximateCells: 32, approximateNewFrontage: 96 },
          ],
        },
      }),
    );
    expect(episode.chosen.action).toMatchObject({ candidateId: "meaningful" });
    expect(episode.chosen.score.actionImpact).toBeGreaterThan(
      episode.trace.candidates.find((x) => x.action.kind === "choose_candidate" && x.action.candidateId === "tiny")
        ?.score.actionImpact ?? 0,
    );
  });

  test("recent nominal success without world impact reduces repeated action preference", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [zoningCandidate("same-target")] },
    });
    const base = compileLocalMayorState(snapshot);
    const history = recordLocalMayorOutcome(base.history, {
      action: {
        kind: "choose_candidate",
        candidateId: "same-target",
        candidateKind: "zoning",
        reasonCode: "use_residential_frontage",
      },
      outcome: "success",
      reason: "native executeActions returned ok",
      impact: {
        kind: "no_material_change",
        worldChanged: false,
        capacityAdded: false,
        roadAdded: false,
        zoningAdded: false,
        summary: "unchanged readback",
      },
    });
    expect(decideLocalMayorEpisode(snapshot, history).chosen.action.kind).not.toBe("choose_candidate");
  });

  test("critical utility risk outranks growth with the shared recovery action", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      utilities: { electricity: { status: "available", production: 20, consumption: 20, fulfilledConsumption: 10 } },
      demand: { residential: { high: 100 } },
      actionablePlanning: { candidates: [zoningCandidate("res-utility")] },
    });
    const episode = decideLocalMayorEpisode(snapshot);
    expect(episode.chosen.action).toMatchObject({ kind: "recover_utility", utility: "electricity" });
    expect(
      episode.actions.every((action) => action.kind !== "choose_candidate" || action.candidateKind !== "utility"),
    ).toBe(true);
  });

  test("negative balance is not an absolute stop when runway and demand are strong", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      economy: { treasury: 100000, monthlyBalance: -1000 },
      demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [zoningCandidate("deficit-growth")] },
    });
    expect(decideLocalMayorEpisode(snapshot).chosen.action.kind).toBe("choose_candidate");
  });

  test("severe finance pressure selects a bounded non-building action", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      economy: { treasury: 500, monthlyBalance: -1000 },
      demand: { residential: { high: 100 } },
      actionablePlanning: { candidates: [zoningCandidate("danger-growth")] },
    });
    expect(["wait", "replan"]).toContain(decideLocalMayorEpisode(snapshot).chosen.action.kind);
  });

  test("failed target receives cooldown and alternative remains selectable", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        demand: { residential: { high: 95 } },
        actionablePlanning: { candidates: [roadCandidate("road-a"), roadCandidate("road-b", 11)] },
      }),
    );
    const nextHistory = recordLocalMayorOutcome(state.history, {
      action: {
        kind: "choose_candidate",
        candidateId: "road-a",
        candidateKind: "road_expansion",
        reasonCode: "expand_frontier",
      },
      outcome: "failure",
      reason: "road no_valid_road_candidate",
    });
    const episode = decideLocalMayorEpisode(stateToSnapshot(state), nextHistory);
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "road-b" });
  });

  test("all failed frontiers fall back without retry loops", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 95 } },
      actionablePlanning: { candidates: [roadCandidate("road-a"), roadCandidate("road-b"), roadCandidate("road-c")] },
    });
    const base = compileLocalMayorState(snapshot);
    const failed = ["road-a", "road-b", "road-c"].reduce(
      (current, candidateId) =>
        recordLocalMayorOutcome(current, {
          action: {
            kind: "choose_candidate",
            candidateId,
            candidateKind: "road_expansion",
            reasonCode: "expand_frontier",
          },
          outcome: "failure",
          reason: "road no_valid_road_candidate",
        }),
      base.history,
    );
    expect(["wait", "replan"]).toContain(decideLocalMayorEpisode(snapshot, failed).chosen.action.kind);
  });

  test("external world changes invalidate a pending episode, observation-only changes do not", () => {
    const first = compileLocalMayorState(buildLocalMayorSnapshotFixture());
    const unchanged = compileLocalMayorState(buildLocalMayorSnapshotFixture(), first.history);
    const changed = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({ population: { current: 1001 } }),
      first.history,
    );
    expect(compareMayorWorldForEpisode(first, unchanged).status).toBe("unchanged");
    expect(compareMayorWorldForEpisode(first, changed).status).toBe("external_world_change");
    expect(invalidateLocalMayorEpisode(first, changed).status).toBe("yielding");
  });

  test("cooldowns expire only through bounded observations", () => {
    const state = compileLocalMayorState(buildLocalMayorSnapshotFixture());
    const failed = recordLocalMayorOutcome(state.history, {
      action: {
        kind: "choose_candidate",
        candidateId: "road-x",
        candidateKind: "road_expansion",
        reasonCode: "expand_frontier",
      },
      outcome: "failure",
      reason: "road no_valid_road_candidate",
    });
    expect(advanceLocalMayorObservation(failed).cooldowns[0]?.remainingObservations).toBe(1);
    expect(advanceLocalMayorObservation(advanceLocalMayorObservation(failed)).cooldowns).toEqual([]);
  });

  test("candidate output contains no arbitrary coordinates or tool names", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 95 } },
      actionablePlanning: { candidates: [zoningCandidate("safe-id")] },
    });
    const episode = decideLocalMayorEpisode(snapshot);
    expect(JSON.stringify(episode)).not.toMatch(/toolName|coordinates|"x"|"z"/);
  });

  test("state, trace, and history stay bounded", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      actionablePlanning: { candidates: Array.from({ length: 50 }, (_, index) => zoningCandidate(`z-${index}`)) },
    });
    const state = compileLocalMayorState(snapshot, {
      recentActions: Array.from({ length: 50 }, () => ({ key: "x", kind: "wait", outcome: "failure", reason: "x" })),
      cooldowns: Array.from({ length: 50 }, (_, index) => ({
        key: `c-${index}`,
        remainingObservations: 2,
        reason: "x",
      })),
      consecutiveWaits: 50,
    });
    const episode = decideLocalMayorEpisode(snapshot, state.history);
    expect(state.candidates.zoning.length).toBeLessThanOrEqual(6);
    expect(state.history.recentActions.length).toBeLessThanOrEqual(8);
    expect(state.history.cooldowns.length).toBeLessThanOrEqual(12);
    expect(episode.trace.candidates.length).toBeLessThanOrEqual(8);
  });
});

function stateToSnapshot(state: ReturnType<typeof compileLocalMayorState>) {
  return buildLocalMayorSnapshotFixture({
    snapshotRevision: state.snapshotRevision,
    demand: { residential: { high: 95 } },
    actionablePlanning: { candidates: [roadCandidate("road-a"), roadCandidate("road-b", 11)] },
  });
}

describe("Growth doctrine: absorption reorders the domains, it does not stop the city", () => {
  const unabsorbedResidential = {
    targetZoningCells: 24,
    zonedUnoccupiedByType: { residential: 40, commercial: 0, industrial: 0, office: 0 },
    typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: false },
  };

  // The product's default. A domain whose last tranche has not been absorbed is
  // a worse next package than one whose has — never a reason for the Mayor to
  // build nothing, which is what the superseded doctrine below encoded.
  test("elevated demand over unabsorbed inventory still opens a tranche, demoted", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: 100, commercial: 0, industrial: 0 },
      developmentCapacity: unabsorbedResidential,
      actionablePlanning: { candidates: [zoningCandidate("res-absorbing")] },
    });
    const state = compileLocalMayorState(snapshot);
    expect(isAbsorbing(state, "residential")).toBe(true);
    const goal = generateLocalMayorGoals(state).find((candidate) => candidate.kind === "grow_residential");
    expect(goal).toBeDefined();
    // Demoted below every non-absorbing domain of the same demand, still above
    // doing nothing at all.
    expect(goal!.urgency).toBeLessThan(growthGoalUrgency(state, "residential", false));
    expect(goal!.urgency).toBeGreaterThan(0);
    // The goal says which situation it is in, so the reason travels with it.
    expect(goal!.evidence.join(" ")).toContain("absorbing");
  });

  // The superseded pacing policy, kept selectable and still covered: under it,
  // and only under it, an unabsorbed domain is held back.
  test("the absorption-controlled policy still holds the tranche back", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: 100, commercial: 0, industrial: 0 },
      developmentCapacity: unabsorbedResidential,
      actionablePlanning: { candidates: [zoningCandidate("res-absorbing")] },
    });
    expect(isAbsorbing(compileLocalMayorState(snapshot), "residential")).toBe(true);
    expect(generateLocalMayorGoals(compileLocalMayorState(snapshot), "ABSORPTION_CONTROL")
      .some((goal) => goal.kind === "grow_residential")).toBe(false);
  });

  test("a declared deficit for the domain reopens the tranche", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: 100, commercial: 0, industrial: 0 },
      developmentCapacity: { ...unabsorbedResidential,
        typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false } },
    });
    expect(isAbsorbing(compileLocalMayorState(snapshot), "residential")).toBe(false);
    expect(generateLocalMayorGoals(compileLocalMayorState(snapshot))
      .some((goal) => goal.kind === "grow_residential")).toBe(true);
  });

  test("with no reserve facts at all growth is exactly what it was", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: 100, commercial: 0, industrial: 0 },
    });
    expect(isAbsorbing(compileLocalMayorState(snapshot), "residential")).toBe(false);
    expect(generateLocalMayorGoals(compileLocalMayorState(snapshot))
      .some((goal) => goal.kind === "grow_residential")).toBe(true);
  });

  test("a city digesting below its target is still a deficit, not absorption", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      developmentCapacity: { targetZoningCells: 24, reserveStatus: "digesting",
        zonedUnoccupiedByType: { residential: 6, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: false } },
    });
    // The state model derives the deficit from the domain's own reserve, so
    // "digesting" cannot be read as "the demand is already answered".
    expect(isAbsorbing(compileLocalMayorState(snapshot), "residential")).toBe(false);
  });
});

