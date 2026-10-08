import {
  V2LocalGate1ProductionRunner,
  isBoundedUtilityRoadPlannerRejection,
  wakeForTask,
  type V2LocalGate1ProductionRunnerOptions,
} from "../../src/main/services/ai-mayor/v2/local-gate1-runner";
import {
  createMemoryGate1StateStorage,
  planStarterResidentialIntent,
  type Gate1AdmittedProposal,
  type Gate1Observation,
  type Gate1State,
  type StarterResidentialIntentInput,
} from "../../src/main/services/ai-mayor/v2/gate1";

const initial = (overrides: Partial<StarterResidentialIntentInput> = {}): StarterResidentialIntentInput => ({
  intentId: "intent:local-v2-runner",
  targetResidents: 12,
  maximumBudget: 25_000,
  planningEnvelope: { center: { x: 0, z: 0 }, radius: 200 },
  siteCandidates: [{ id: "starter", target: { center: { x: 0, z: 0 }, radius: 30 }, score: 1, blocked: false }],
  maximumWaitObservations: 2,
  ...overrides,
});

const observationFor = (state: Gate1State, overrides: Partial<Gate1Observation> = {}): Gate1Observation => ({
  observationId: `observation:${state.stateVersion}`,
  runtimeEpoch: "runtime:local-v2-test",
  coherence: "STABLE_FRAME",
  capturedAt: "2026-09-14T00:00:00.000Z",
  trancheId: state.tranche.id,
  access: { value: "PASS", provenance: "DERIVED" },
  productiveFrontage: { value: "PASS", provenance: "DERIVED" },
  utilities: {
    value: "PASS",
    provenance: "DERIVED",
    evidenceKind: "ACTUAL_CONSUMER_SERVICE",
    buildingRefs: [{ index: 7, version: 1 }],
  },
  residentialBuildings: { value: [{ index: 7, version: 1 }], provenance: "OBSERVED" },
  actualResidents: { value: 1, provenance: "OBSERVED" },
  occupiedResidentialBuildings: { value: [{ index: 7, version: 1 }], provenance: "OBSERVED" },
  ...overrides,
});

const occupiedState = (): Gate1State => {
  const state = planStarterResidentialIntent(initial(), new Date("2026-09-15T00:00:00.000Z"));
  state.intent.status = "SATISFIED";
  state.project.status = "OCCUPIED";
  state.tranche.stage = "OCCUPIED";
  state.tranche.effect_progress.status = "OCCUPIED";
  for (const task of state.tasks) task.status = "SUCCEEDED";
  state.journal.push({
    id: `${state.tranche.id}:occupied`, taskId: state.tasks.at(-1)!.id, skill: "WaitObserve", proposalId: null,
    admission: "NOT_REQUIRED", execution: "NOT_REQUIRED", commandId: null, observationId: "observation:occupied",
    observedEffect: "OCCUPIED", failureClassification: "NONE", recordedAt: "2026-09-15T00:00:00.000Z",
    reason: "authoritative residents observed",
  });
  return state;
};

function createRunner(
  overrides: Partial<V2LocalGate1ProductionRunnerOptions> = {},
) {
  const storage = overrides.storage ?? createMemoryGate1StateStorage();
  const calls: Gate1AdmittedProposal[] = [];
  const runner = new V2LocalGate1ProductionRunner({
    storage,
    initial: initial(),
    observe: async (state) => observationFor(state),
    boundary: {
      execute: jest.fn(async (proposal: Gate1AdmittedProposal) => {
        calls.push(proposal);
        return {
          status: "DELIVERED" as const,
          commandId: `command:${proposal.id}`,
          observedMatch: proposal.operation !== "ZONE_RESIDENTIAL" || true,
          reason: "V2 Foundation Kernel delivered the bounded proposal",
        };
      }),
    },
    ...overrides,
  });
  return { runner, storage, calls };
}

describe("V2 Local Gate 1 production runner", () => {
  /**
   * "coherence is UNKNOWN" cannot be acted on. Measured live (2026-09-30): eight
   * consecutive ticks refused here with that sentence and nothing in the
   * evidence to say whether a Bridge read had failed, a frame was unreadable, or
   * one building's own read had come back unknown — which is a different
   * subsystem and a different answer.
   */
  test("names the fact that made an observation incoherent instead of only saying UNKNOWN", async () => {
    const { runner } = createRunner({
      observe: async (state) => observationFor(state, { coherence: "UNKNOWN",
        incoherence: { unavailableSources: ["access:339614:555"], frameBefore: 9_519_674, frameAfter: 9_519_674 } }),
    });
    expect((await runner.tick()).reason).toBe("V2 observation coherence is UNKNOWN; task progression is blocked"
      + ": frames 9519674->9519674: incoherent access:339614:555");

    // Carried, never invented: an observation that cannot name the fact keeps
    // the original sentence rather than claiming one.
    const { runner: unnamed } = createRunner({
      observe: async (state) => observationFor(state, { coherence: "UNKNOWN" }),
    });
    expect((await unnamed.tick()).reason).toBe("V2 observation coherence is UNKNOWN; task progression is blocked");
  });

  /**
   * The runner's coherence refusal is a refusal about the SNAPSHOT. A fact that
   * could not be read is a refusal about that fact, and only the tasks that
   * read it are refused. Conflating the two is what stopped a whole tranche at
   * `PLANNED` — where the pending task is SITE_SELECTION, which reads no
   * building — behind one building's optional access endpoint.
   */
  test("a fact-level incoherence does not block a step that reads no such fact", async () => {
    const envelopeIncoherent = createRunner({
      observe: async (state) => observationFor(state, { coherence: "UNKNOWN" }),
    });
    const envelopeResult = await envelopeIncoherent.runner.tick();
    expect(envelopeResult.kind).toBe("LOCAL_RECOVERABLE_FAILURE");
    expect(envelopeResult.reason).toContain("coherence is UNKNOWN");
    expect(envelopeIncoherent.calls).toHaveLength(0);

    const factIncoherent = createRunner({
      observe: async (state) => observationFor(state, { coherence: "STABLE_FRAME",
        access: { value: "UNKNOWN", provenance: "OBSERVED" },
        factCoherence: { access: "UNKNOWN", utilities: "STABLE_FRAME", incoherentRefs: ["access:339614:555"] } }),
    });
    const factResult = await factIncoherent.runner.tick();
    // The pending step took its bounded turn instead of being refused. It is
    // SITE_SELECTION: it reads the census, not the building whose access the
    // world could not answer for.
    expect(factResult.kind).toBe("LOCAL_SUCCESS");
    expect(factResult.reason ?? "").not.toContain("coherence is UNKNOWN");
  });

  /**
   * The wake a wait declares is the answer to "what will supply this fact", and
   * for a base utility Goal the answer is NOT the clock.
   *
   * Measured live (2026-10-01): `PROVIDE_SERVICE:electricity` waited on
   * `NO_ATTRIBUTED_BUILDING` for the whole run — 4/4 ticks blocked, 48/48
   * simulation windows burned, zero mutations. `ZONING` is deliberately not an
   * eligible task for a base utility Goal (`gate1.ts:1820`), so the building it
   * waits for can only arrive from another tranche. `SIMULATION_PROGRESS` there
   * was a lie that cost the tick every window it had.
   *
   * Both sides are pinned: the growth Goal's identical task still waits on the
   * world, because its consumers really do initialize on the simulation's
   * schedule. Getting that wrong in the other direction would make a growth
   * tranche wait forever for a fact nobody owes it.
   */
  test("a base utility Goal waits on another operation's construction, not on the clock", () => {
    const utilityTask = { kind: "UTILITY_PROVISION", status: "PENDING" } as Gate1State["tasks"][number];
    expect(wakeForTask(utilityTask, true)).toMatchObject({ condition: "DEPENDENT_CONSTRUCTION" });
    // A growth Goal's own UTILITY_PROVISION keeps the world as its answer.
    expect(wakeForTask(utilityTask, false)).toMatchObject({ condition: "SIMULATION_PROGRESS" });
    expect(wakeForTask(utilityTask)).toMatchObject({ condition: "SIMULATION_PROGRESS" });
    // The remaining vocabulary is untouched.
    expect(wakeForTask({ kind: "WAIT_FOR_BUILDING", status: "PENDING" } as Gate1State["tasks"][number], true))
      .toMatchObject({ condition: "SIMULATION_PROGRESS" });
    expect(wakeForTask({ kind: "ROAD_CONNECTION", status: "PENDING" } as Gate1State["tasks"][number], true))
      .toMatchObject({ condition: "WORLD_WRITE_IDLE" });
  });

  test("routes a bounded native-invalid utility child back to the planner", () => {
    const task = { id: "utility-road-child", kind: "ROAD_CONNECTION", utilityRoadParentTaskId: "delivered-road-parent" } as Gate1State["tasks"][number];
    const outcome = { execution: "NOT_REQUIRED", commandId: null, failureClassification: "ROAD_PREFLIGHT_REJECTED" } as Gate1State["journal"][number];
    expect(isBoundedUtilityRoadPlannerRejection(task, outcome, "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:all bounded routes invalid")).toBe(true);
    expect(isBoundedUtilityRoadPlannerRejection({ ...task, utilityRoadParentTaskId: undefined }, outcome,
      "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:all bounded routes invalid")).toBe(false);
    expect(isBoundedUtilityRoadPlannerRejection(task, { ...outcome, execution: "DELIVERED" },
      "NO_FEASIBLE_GATE1_ROAD_CANDIDATE:all bounded routes invalid")).toBe(false);
  });

  test("fresh typed input is planned exactly once by the production lifecycle owner", async () => {
    let planningCalls = 0;
    const { runner } = createRunner({
      planIntent: (input, now) => {
        planningCalls += 1;
        return planStarterResidentialIntent(input, now);
      },
    });
    expect(planningCalls).toBe(1);
    expect(runner.snapshot().intent.id).toBe("intent:local-v2-runner");
    await runner.tick();
    expect(planningCalls).toBe(1);
  });

  test("runs Task to Skill to Proposal to Admission to Kernel without provider or legacy imports", async () => {
    let providerInvocations = 0;
    let legacyInvocations = 0;
    const { runner, calls } = createRunner({
      observe: async (state) => {
        providerInvocations += 0;
        legacyInvocations += 0;
        return observationFor(state);
      },
    });

    const first = await runner.tick();
    const second = await runner.tick();
    const third = await runner.tick();

    expect(first.kind).toBe("LOCAL_SUCCESS");
    expect(second.kind).toBe("LOCAL_SUCCESS");
    expect(third.kind).toBe("LOCAL_SUCCESS");
    expect(calls.map((proposal) => proposal.skill)).toEqual(["RoadConnection", "Zoning"]);
    expect(providerInvocations).toBe(0);
    expect(legacyInvocations).toBe(0);
  });

  test("returns typed WAITING with a wake condition and never treats UNKNOWN as PASS", async () => {
    const { runner } = createRunner({
      observe: async (state) =>
        observationFor(state, {
          residentialBuildings: { value: [], provenance: "OBSERVED" },
          actualResidents: { value: 0, provenance: "OBSERVED" },
          occupiedResidentialBuildings: { value: [], provenance: "OBSERVED" },
        }),
    });

    await runner.tick();
    await runner.tick();
    await runner.tick();
    const waiting = await runner.tick();
    expect(waiting.kind).toBe("LOCAL_WAITING");
    expect(waiting.wake?.condition).toBe("SIMULATION_PROGRESS");

    const unknownRunner = createRunner({
      observe: async (state) => observationFor(state, { coherence: "UNKNOWN" }),
    }).runner;
    const unknown = await unknownRunner.tick();
    expect(unknown.kind).toBe("LOCAL_RECOVERABLE_FAILURE");
    expect(unknown.outcome).toBeNull();
    expect(unknown.reason).toContain("UNKNOWN");
    expect(unknown.kind).not.toBe("LOCAL_SUCCESS");
  });

  test("post-road frontage certification is not a general ZONING hard gate", async () => {
    const { runner, calls } = createRunner({
      observe: async (state) => observationFor(state, {
        productiveFrontage: { value: "UNKNOWN", provenance: "OBSERVED" },
        residentialBuildings: { value: [], provenance: "OBSERVED" },
      }),
    });
    await runner.tick();
    await runner.tick();
    const zoning = await runner.tick();
    expect(zoning.kind).toBe("LOCAL_SUCCESS");
    expect(zoning.proposal?.operation).toBe("ZONE_RESIDENTIAL");
    expect(zoning.task).toMatchObject({ kind: "ZONING", status: "SUCCEEDED", attempts: 1 });
    expect(calls.map((proposal) => proposal.operation)).toEqual(["BUILD_ROAD", "ZONE_RESIDENTIAL"]);
  });

  test("returns an explicit capability gap without Cloud fallback", async () => {
    const { runner } = createRunner({
      boundary: {
        execute: async () => ({
          status: "REJECTED" as const,
          commandId: null,
          observedMatch: false,
          reason: "no bounded Foundation resolver for proposal",
        }),
      },
    });
    await runner.tick();
    const result = await runner.tick();
    expect(result.kind).toBe("LOCAL_NO_APPLICABLE_SKILL");
    expect(result.capabilityGap?.reason).toContain("no bounded Foundation resolver");
  });

  test("restarts from durable Project/Tranche state instead of replaying the first task", async () => {
    const storage = createMemoryGate1StateStorage();
    let planningCalls = 0;
    const planIntent = (input: StarterResidentialIntentInput, now?: Date) => {
      planningCalls += 1;
      return planStarterResidentialIntent(input, now);
    };
    const first = createRunner({ storage, planIntent });
    await first.runner.tick();

    const restarted = createRunner({ storage, planIntent });
    expect(planningCalls).toBe(1);
    expect(restarted.runner.snapshot().tasks[0].status).toBe("SUCCEEDED");
    const result = await restarted.runner.tick();
    expect(result.proposal?.skill).toBe("RoadConnection");
    expect(restarted.runner.snapshot().tasks[0].attempts).toBe(1);
  });

  test("returns a typed liveness failure for a nonterminal stage with no executable task", async () => {
    const state = planStarterResidentialIntent(initial());
    state.tasks[0].status = "SUCCEEDED";
    const { runner } = createRunner({ storage: createMemoryGate1StateStorage(state) });
    const result = await runner.tick();
    expect(result.kind).toBe("LOCAL_RECOVERABLE_FAILURE");
    expect(result.reason).toContain("liveness invariant violated");
    expect(result.reason).not.toBe("no executable V2 task remains");
  });

  test("OCCUPIED project completes exactly once and repeated ticks return handoff, not LOCAL_SUCCESS", async () => {
    const storage = createMemoryGate1StateStorage(occupiedState());
    const first = createRunner({ storage });
    const completed = await first.runner.tick();
    expect(completed.kind).toBe("PROJECT_COMPLETED_NEXT_DECISION_READY");
    expect(completed.state.project.status).toBe("COMPLETE");
    expect(completed.state.completion).toMatchObject({
      handoffStatus: "NEXT_DECISION_READY",
      releasedReservationRefs: [completed.state.tranche.reservationRef],
    });
    const completionId = completed.state.completion?.completionId;
    const version = completed.state.stateVersion;

    const restarted = createRunner({ storage });
    const repeated = await restarted.runner.tick();
    expect(repeated.kind).toBe("PROJECT_COMPLETED_NEXT_DECISION_READY");
    expect(repeated.kind).not.toBe("LOCAL_SUCCESS");
    expect(repeated.state.completion?.completionId).toBe(completionId);
    expect(repeated.state.stateVersion).toBe(version);
  });

  test("next scheduler decision consumes handoff and creates new Intent and Project identities", async () => {
    const storage = createMemoryGate1StateStorage(occupiedState());
    const next = initial({ intentId: "intent:local-v2-runner:decision:2" });
    const { runner } = createRunner({ storage, nextDecision: async () => next });
    const completed = await runner.tick();
    const created = await runner.tick();
    expect(completed.kind).toBe("PROJECT_COMPLETED_NEXT_DECISION_READY");
    expect(created.kind).toBe("LOCAL_NEXT_DECISION_CREATED");
    expect(created.state.intent.id).toBe(next.intentId);
    expect(created.state.project.id).not.toBe(completed.state.project.id);
    expect(created.state.predecessorCompletionId).toBe(completed.state.completion?.completionId);
    expect(created.task).toMatchObject({ kind: "SITE_SELECTION", status: "PENDING" });
  });
});
