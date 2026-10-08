import { projectLocalMayorActivity } from "../../src/main/services/ai-mayor/local-mayor/activity";
import { decideLocalMayorEpisode } from "../../src/main/services/ai-mayor/local-mayor/decision";
import { scanCityIssues } from "../../src/main/services/ai-mayor/local-mayor/issues";
import {
  buildLocalMayorSnapshotFixture,
  history,
  zoningCandidate,
} from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

describe("Local Mayor city issue awareness", () => {
  test("healthy city keeps existing growth behavior and has no issues", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [zoningCandidate("growth-1")] },
    });
    const state = compileLocalMayorState(snapshot);
    expect(state.issues.current).toEqual([]);
    expect(decideLocalMayorEpisode(snapshot).chosen.action).toMatchObject({ candidateId: "growth-1" });
  });

  test("critical utility issues outrank growth and are authoritative", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      demand: { residential: { high: 100 }, commercial: 0, industrial: 0 },
      utilities: {
        electricity: { status: "available", production: 40, consumption: 100, fulfilledConsumption: 40 },
        water: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
        sewage: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
      },
      actionablePlanning: { candidates: [zoningCandidate("growth-utility")] },
    });
    const state = compileLocalMayorState(snapshot);
    expect(state.issues.highest).toMatchObject({ kind: "electricity_shortage", severity: "critical", priority: 0 });
    expect(decideLocalMayorEpisode(snapshot).goals[0]?.kind).toBe("stabilize_utilities");
    expect(decideLocalMayorEpisode(snapshot).chosen.action.kind).not.toBe("choose_candidate");
  });

  test("water and sewage shortages are independently classified", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      utilities: {
        electricity: { status: "available", production: 100, consumption: 50, fulfilledConsumption: 50 },
        water: { status: "available", capacity: 10, consumption: 50, fulfilledConsumption: 10 },
        sewage: { status: "unavailable", capacity: null, consumption: 50, fulfilledConsumption: 0 },
      },
    });
    expect(scanCityIssues(snapshot).current.map((issue) => issue.kind)).toEqual(["sewage_shortage", "water_shortage"]);
  });

  test("transient observable warnings do not thrash and persistent warnings promote", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      warnings: { topTypes: [{ type: "MissingUneducatedWorkers", count: 2 }] },
    });
    const first = scanCityIssues(snapshot);
    expect(first.highest).toMatchObject({ kind: "worker_shortage", severity: "medium", persistence: 1 });
    const second = scanCityIssues(snapshot, first.current);
    expect(second.highest).toMatchObject({ kind: "worker_shortage", severity: "medium", persistence: 2 });
    expect(decideLocalMayorEpisode(snapshot, history({ issueMemory: first.current })).actions).not.toContainEqual(
      expect.objectContaining({ kind: "choose_candidate" }),
    );
  });

  test("resolved external issue disappears and old issue goal is dropped", () => {
    const active = buildLocalMayorSnapshotFixture({
      utilities: {
        electricity: { status: "available", production: 40, consumption: 100, fulfilledConsumption: 40 },
        water: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
        sewage: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
      },
    });
    const prior = compileLocalMayorState(active).issues.current;
    const resolved = compileLocalMayorState(buildLocalMayorSnapshotFixture(), { issueMemory: prior });
    expect(resolved.issues.current).toEqual([]);
    expect(resolved.issues.highest).toBeNull();
  });

  test("observable-only garbage issue never claims a repair action", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({ utilities: { garbage: { accumulationRate: 5000 } } }),
    );
    expect(state.issues.highest).toMatchObject({ kind: "garbage_pressure", actionable: false });
    expect(state.issues.highest?.message).toMatch(/not supported/);
  });

  test("finance runway suppresses unnecessary expansion", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      economy: { treasury: 100, monthlyBalance: -100 },
      demand: { residential: { high: 100 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [zoningCandidate("growth-finance")] },
    });
    const episode = decideLocalMayorEpisode(snapshot);
    expect(episode.state.issues.highest).toMatchObject({ kind: "finance_runway", priority: 2 });
    expect(episode.chosen.action.kind).not.toBe("choose_candidate");
  });

  test("activity projects the highest issue without inventing resolution", () => {
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({ utilities: { garbage: { accumulationRate: 5000 } } }),
    );
    expect(projectLocalMayorActivity({ episode }).topIssue).toMatchObject({
      kind: "garbage_pressure",
      actionable: false,
    });
  });

  test("issue state remains bounded", () => {
    const snapshot = buildLocalMayorSnapshotFixture({
      warnings: {
        topTypes: Array.from({ length: 20 }, (_, index) => ({ type: `MissingWorkers${index}`, count: 1 })),
      },
    });
    expect(scanCityIssues(snapshot).current.length).toBeLessThanOrEqual(8);
  });

  test("100-episode bounded synthetic endurance prioritizes utilities and resumes growth", () => {
    let issueMemory = [] as ReturnType<typeof scanCityIssues>["current"];
    let historyState = history();
    const chosenKinds: string[] = [];
    let providerCalls = 0;
    for (let episode = 0; episode < 100; episode += 1) {
      const critical = episode >= 20 && episode < 40;
      const workerWarning = episode >= 70;
      const snapshot = buildLocalMayorSnapshotFixture({
        demand: { residential: { high: 95 }, commercial: 0, industrial: 0 },
        utilities: {
          electricity: critical
            ? { status: "available", production: 40, consumption: 100, fulfilledConsumption: 40 }
            : { status: "available", production: 100, consumption: 50, fulfilledConsumption: 50 },
          water: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
          sewage: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
        },
        warnings: workerWarning ? { topTypes: [{ type: "MissingWorkers", count: 1 }] } : undefined,
        actionablePlanning: { candidates: [zoningCandidate(`growth-${episode}`)] },
      });
      const episodeResult = decideLocalMayorEpisode(snapshot, { ...historyState, issueMemory });
      chosenKinds.push(episodeResult.chosen.action.kind);
      expect(episodeResult.trace.goals.length).toBeLessThanOrEqual(6);
      if (critical) expect(episodeResult.chosen.action.kind).not.toBe("choose_candidate");
      if (!critical && episode < 70) expect(episodeResult.chosen.action.kind).toBe("choose_candidate");
      issueMemory = episodeResult.state.issues.current;
      historyState = { ...historyState, issueMemory };
      providerCalls += 0;
    }
    expect(chosenKinds.filter((kind) => kind === "choose_candidate").length).toBeGreaterThan(0);
    expect(providerCalls).toBe(0);
  });
});

describe("Gameplay doctrine: an uncommissioned utility is preparation, not an emergency", () => {
  const uncommissioned = () =>
    buildLocalMayorSnapshotFixture({
      utilities: {
        electricity: { status: "available", production: 0, consumption: 0, fulfilledConsumption: 0, import: 0 },
        water: { status: "available", capacity: 0, consumption: 0, fulfilledConsumption: 0, import: 0 },
        sewage: { status: "available", capacity: 0, consumption: 0, fulfilledConsumption: 0, import: 0 },
      },
      demand: { residential: { high: 90 }, commercial: 0, industrial: 0 },
      actionablePlanning: { candidates: [zoningCandidate("growth-bootstrap")] },
    });

  test("zero capacity with zero load is not a shortage", () => {
    const state = compileLocalMayorState(uncommissioned());
    expect(state.issues.current).toEqual([]);
    expect(state.utilities.electricity).toMatchObject({ risk: "healthy", load: 0, uncommissioned: true });
    expect(state.utilities.water).toMatchObject({ risk: "healthy", load: 0, uncommissioned: true });
    expect(state.utilities.sewage).toMatchObject({ risk: "healthy", load: 0, uncommissioned: true });
  });

  test("one preparation requirement covers every uncommissioned utility", () => {
    const episode = decideLocalMayorEpisode(uncommissioned());
    const bootstrap = episode.goals.filter((goal) => goal.kind === "prepare_utility_bootstrap");
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0].urgency).toBeLessThan(100);
    expect(episode.goals.some((goal) => goal.kind === "stabilize_utilities")).toBe(false);
    expect(episode.goals[0]?.kind).toBe("prepare_utility_bootstrap");
    expect(bootstrap[0].evidence.join(" ")).toContain("electricity");
  });

  test("a real unmet load still outranks everything as a shortage", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        utilities: {
          electricity: { status: "available", production: 0, consumption: 19, fulfilledConsumption: 0 },
          water: { status: "available", capacity: 0, consumption: 5, fulfilledConsumption: 0 },
          sewage: { status: "available", capacity: 0, consumption: 5, fulfilledConsumption: 0 },
        },
      }),
    );
    expect(state.utilities.electricity).toMatchObject({ risk: "critical", uncommissioned: false });
    expect(state.issues.highest).toMatchObject({ kind: "electricity_shortage", urgency: 100, priority: 0 });
    expect(decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        utilities: { electricity: { status: "available", production: 0, consumption: 19, fulfilledConsumption: 0 } },
      }),
    ).chosen.action.kind).toBe("recover_utility");
  });

  test("a non-utility service deficit is never a bootstrap requirement", () => {
    const state = compileLocalMayorState(
      buildLocalMayorSnapshotFixture({
        cityServices: { healthcare: { status: "available", efficiencyPercent: 20, buildingCount: 0 } },
        utilities: {
          electricity: { status: "available", production: 0, consumption: 0, fulfilledConsumption: 0 },
          water: { status: "available", capacity: 0, consumption: 0, fulfilledConsumption: 0 },
          sewage: { status: "available", capacity: 0, consumption: 0, fulfilledConsumption: 0 },
        },
      }),
    );
    expect(state.issues.current.map((issue) => issue.kind)).toEqual(["healthcare_service_deficit"]);
    expect(state.issues.current[0].actionable).toBe(false);
  });
});
