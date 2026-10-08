import {
  BUSY_RESTART_AFTER_MS, isProgress, mayStartRun, MAXIMUM_RESTARTS, PAUSED_IDLE_RESTART_AFTER_MS, STALL_AFTER_MS, StallWatch, type WorldProbe,
} from "../../src/main/services/ai-mayor/v2/stall-supervisor";

const probe = (overrides: Partial<WorldProbe> = {}): WorldProbe => ({ reachable: true, paused: false, frame: 1_000, busy: false, stage: "Idle", ready: true, ...overrides });
const alive = { childAlive: true };

describe("what counts as progress", () => {
  test("a finished cycle, a real answer from a mutation (done or refused by the game) are progress", () => {
    expect(isProgress({ cycle: true })).toBe(true);
    expect(isProgress({ call: { name: "cs2_build_road", ok: true } })).toBe(true);
    expect(isProgress({ call: { name: "cs2_spatial", ok: false, answer: "operation blocked by game validation (overlap)" } })).toBe(true);
  });
  test("polls and 'busy, retry' answers are not: a process alive and retrying the same wait is the stuck one", () => {
    expect(isProgress({ call: { name: "cs2_game_state", ok: true } })).toBe(false);
    expect(isProgress({ call: { name: "cs2_read_blocking_modal", ok: true } })).toBe(false);
    expect(isProgress({ call: { name: "cs2_build_road", ok: false, answer: "another build operation is in progress, retry shortly" } })).toBe(false);
  });
});

describe("the one decision per look", () => {
  test("recent progress, or a game frame that moves, is not a stall", () => {
    const watch = new StallWatch(0);
    expect(watch.decide(5_000, probe(), alive).state).toBe("PROGRESSING");
    // 30 s later nothing was reported, but the game ran a window (frames moved): progress.
    expect(watch.decide(30_000, probe({ frame: 2_000 }), alive).state).toBe("PROGRESSING");
  });

  test("the live incident: nothing moves, the Bridge is busy in Finish, the world paused: watched while the Bridge clears itself, then the run is restarted", () => {
    const watch = new StallWatch(0);
    const stuck = probe({ paused: true, busy: true, stage: "Finish", frame: 1_000 });
    watch.decide(1_000, stuck, alive);
    expect(watch.decide(STALL_AFTER_MS + 1_000, stuck, alive)).toMatchObject({ state: "WATCHING", action: "NONE" });
    const later = watch.decide(BUSY_RESTART_AFTER_MS + 1_000, stuck, alive);
    expect(later).toMatchObject({ state: "STALLED_BUSY", action: "RESTART" });
    expect(later.reason).toMatch(/stage Finish/);
  });

  test("control: busy for a moment while calls keep completing is never a stall (a normal long operation)", () => {
    const watch = new StallWatch(0);
    for (let now = 3_000; now < 60_000; now += 3_000) {
      watch.note({ call: { name: "cs2_build_road", ok: true } }, now);
      expect(watch.decide(now, probe({ busy: true, stage: "Apply", frame: 1_000 }), alive).action).toBe("NONE");
    }
  });

  test("control: a player's pause (paused, idle, no progress) is reported but not lifted, and not restarted unless the owner allows it", () => {
    const watch = new StallWatch(0);
    const paused = probe({ paused: true, frame: 1_000 });
    watch.decide(1_000, paused, alive);
    expect(watch.decide(STALL_AFTER_MS + 1_000, paused, alive)).toMatchObject({ state: "PAUSED_IDLE", action: "REPORT" });
    expect(watch.decide(PAUSED_IDLE_RESTART_AFTER_MS + 5_000, paused, alive).action).toBe("REPORT");
    expect(watch.decide(PAUSED_IDLE_RESTART_AFTER_MS + 6_000, paused, { ...alive, restartOnPausedIdle: true }).action).toBe("RESTART");
  });

  test("the world runs, the Bridge is idle, but the run made no progress: restarted", () => {
    const watch = new StallWatch(0);
    watch.decide(1_000, probe({ frame: 1_000 }), alive);
    // The game paused itself at the window's target and nothing followed: frames stand still, not paused-flagged by a player.
    expect(watch.decide(STALL_AFTER_MS + 2_000, probe({ frame: 1_000, paused: false }), alive)).toMatchObject({ state: "STALLED_RUNNING", action: "RESTART" });
  });

  test("a Bridge that does not answer is reported, never 'fixed' by restarting the run", () => {
    const watch = new StallWatch(0);
    expect(watch.decide(STALL_AFTER_MS + 1_000, probe({ reachable: false, frame: null, busy: null, paused: null }), alive)).toMatchObject({ state: "BRIDGE_UNREACHABLE", action: "REPORT" });
  });

  test("the run process is gone: restarted at once", () => {
    expect(new StallWatch(0).decide(500, probe(), { childAlive: false })).toMatchObject({ state: "CHILD_EXITED", action: "RESTART" });
  });
});

describe("restarts are bounded, and a new run starts only on a Bridge that can take work", () => {
  test("more than MAXIMUM_RESTARTS in the window: automatic restarting stops and says so", () => {
    const watch = new StallWatch(0);
    for (let index = 0; index < MAXIMUM_RESTARTS; index += 1) { watch.restarted(1_000 * (index + 1)); watch.started(1_000 * (index + 1)); }
    const decision = watch.decide(30_000, probe(), { childAlive: false });
    expect(decision).toMatchObject({ state: "GAVE_UP", action: "REPORT" });
    expect(decision.reason).toMatch(/automatic restarting stops/);
    // And it stays given up.
    expect(watch.decide(40_000, probe(), { childAlive: false }).action).toBe("NONE");
  });

  test("restarts outside the window are forgotten", () => {
    const watch = new StallWatch(0);
    for (let index = 0; index < MAXIMUM_RESTARTS; index += 1) watch.restarted(1_000 + index);
    expect(watch.decide(11 * 60_000, probe(), { childAlive: false }).action).toBe("RESTART");
  });

  test("mayStartRun: ready and idle; a running world is taken over as it is", () => {
    expect(mayStartRun(probe({ paused: true }))).toEqual({ ok: true, reason: "ready" });
    expect(mayStartRun(probe({ paused: true, busy: true, stage: "Finish" })).ok).toBe(false);
    expect(mayStartRun(probe({ paused: false })).ok).toBe(true);
    expect(mayStartRun(probe({ reachable: false })).ok).toBe(false);
    expect(mayStartRun(probe({ paused: true, ready: false })).ok).toBe(false);
  });
});
