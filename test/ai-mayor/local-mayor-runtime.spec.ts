import { buildLocalMayorSnapshotFixture } from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { MayorRuntime } from "../../src/main/services/ai-mayor/runtime";
import type { MayorRuntimePorts } from "../../src/main/services/ai-mayor/types";

const balance = {
  isAvailable: true,
  currency: "CNY" as const,
  totalBalance: 100_000,
  grantedBalance: 0,
  toppedUpBalance: 100_000,
  fetchedAt: "2026-09-30T00:00:00.000Z",
};

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function createPorts(withProductionRuntime = false) {
  const calls = { provider: 0, snapshot: 0, execute: 0, simulation: 0, pause: 0, save: 0 };
  const runtimeCalls = { initialize: 0, dispose: 0 };
  const v2ProductionSkillRuntime = withProductionRuntime
    ? {
        initialize: () => { runtimeCalls.initialize += 1; },
        dispose: () => { runtimeCalls.dispose += 1; },
        isInitialized: () => true,
      } as unknown as NonNullable<MayorRuntimePorts["v2ProductionSkillRuntime"]>
    : undefined;
  const ports: MayorRuntimePorts = {
    getBalance: async () => balance,
    getSnapshot: async () => {
      calls.snapshot += 1;
      return buildLocalMayorSnapshotFixture();
    },
    decide: async () => {
      calls.provider += 1;
      throw new Error("local mode must not call provider");
    },
    executeActions: async () => {
      calls.execute += 1;
      throw new Error("V2 Gate1 owns production execution");
    },
    runSimulation: async () => { calls.simulation += 1; },
    pause: async () => { calls.pause += 1; },
    save: async () => { calls.save += 1; },
    delay: async () => undefined,
    id: () => "local-runtime-test",
    v2ProductionSkillRuntime,
  };
  return { ports, calls, runtimeCalls };
}

function start(runtime: MayorRuntime, stageTimeoutMs = 1_000) {
  runtime.start({
    goal: "routine local management",
    maxSessionSpend: 10,
    minimumBalance: 0,
    decisionMode: "local",
    tickDelayMs: 0,
    localMayorStageTimeoutMs: stageTimeoutMs,
  });
}

describe("Local Mayor Runtime V2 integration", () => {
  test("a local tick delegates to the V2 Brain without provider or legacy executor calls", async () => {
    const { ports, calls, runtimeCalls } = createPorts(true);
    const runtime = new MayorRuntime(ports);
    const brainCycle = jest.spyOn(runtime, "runAutonomousConstructionCycle").mockResolvedValue({
      status: "MILESTONE_REACHED",
      stage: "OCCUPIED",
    });
    start(runtime);

    const state = await runtime.singleTick();

    expect(runtimeCalls.initialize).toBe(1);
    expect(brainCycle).toHaveBeenCalledTimes(1);
    expect(calls).toMatchObject({ provider: 0, snapshot: 1, execute: 0 });
    expect(state.localMayorStatus).toBe("waiting");
    await runtime.stop();
    expect(runtimeCalls.dispose).toBe(1);
  });

  test("a missing V2 production runtime fails closed without provider or direct execution", async () => {
    const { ports, calls } = createPorts(false);
    const runtime = new MayorRuntime(ports);
    start(runtime);

    const state = await runtime.singleTick();

    expect(calls).toMatchObject({ provider: 0, snapshot: 1, execute: 0 });
    expect(state.localMayorStatus).toBe("blocked");
    expect(state.lastStatus).toContain("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    await runtime.stop();
  });

  test("an unavailable Bridge snapshot becomes a bounded blocked state", async () => {
    const { ports } = createPorts(true);
    ports.getSnapshot = async () => { throw new Error("Bridge unavailable"); };
    const runtime = new MayorRuntime(ports);
    start(runtime);

    const state = await runtime.singleTick();

    expect(state.localMayorStatus).toBe("blocked");
    expect(state.lastStatus).toContain("Bridge unavailable");
    await runtime.stop();
  });

  test("snapshot hangs time out and the same runtime can recover on the next tick", async () => {
    const { ports, calls } = createPorts(true);
    let hanging = true;
    ports.getSnapshot = async () => {
      if (hanging) return never();
      return buildLocalMayorSnapshotFixture();
    };
    const runtime = new MayorRuntime(ports);
    jest.spyOn(runtime, "runAutonomousConstructionCycle").mockResolvedValue({ status: "WAITING" });
    start(runtime, 20);

    const first = await runtime.singleTick();
    hanging = false;
    const second = await runtime.singleTick();

    expect(first.lastStatus).toContain("runtime_stage_timeout:snapshot:getSnapshot");
    expect(second.tickCount).toBe(2);
    expect(calls.provider).toBe(0);
    await runtime.stop();
  });

  test("concurrent ticks share one in-flight Brain cycle", async () => {
    const { ports } = createPorts(true);
    const runtime = new MayorRuntime(ports);
    let release!: () => void;
    let entered!: () => void;
    const cycleEntered = new Promise<void>((resolve) => { entered = resolve; });
    jest.spyOn(runtime, "runAutonomousConstructionCycle").mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ status: "WAITING" });
        entered();
      }),
    );
    start(runtime);

    const first = runtime.singleTick();
    const second = runtime.singleTick();
    expect(first).toBe(second);
    await cycleEntered;
    release();
    await first;
    await runtime.stop();
  });

  test("stop retains pause finalization and never forces a save", async () => {
    const { ports, calls } = createPorts(true);
    const runtime = new MayorRuntime(ports);
    jest.spyOn(runtime, "runAutonomousConstructionCycle").mockResolvedValue({ status: "WAITING" });
    start(runtime);
    await runtime.singleTick();

    await runtime.stop("cooperative stop");

    expect(calls.pause).toBe(1);
    expect(calls.save).toBe(0);
  });
});
