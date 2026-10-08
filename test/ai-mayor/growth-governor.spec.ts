import { GAME_HOUR_FRAMES } from "../../src/main/services/ai-mayor/v2/game-clock";
import {
  GrowthGovernor, JUDGE_HOURS, MINIMUM_JUDGED, PROGRESS_WINDOW_HOURS, STUCK_HOURS, SUSPEND_BASE_HOURS, SUSPEND_MAXIMUM_HOURS, supplyFamily, type GovernorSample,
} from "../../src/main/services/ai-mayor/v2/growth-governor";

/** A sample at game hour `hour` (cycle = hour); every figure can be overridden. */
const at = (hour: number, over: Partial<GovernorSample> = {}): GovernorSample => ({
  stamp: { frame: Math.round(hour * GAME_HOUR_FRAMES), cycle: hour },
  population: 10_000, monthlyBalance: 300_000, problemIcons: 10,
  zoned: { low: 30_000, medium: 2_000, commercial: 10_000, industrial: 5_000, office: 5_000 },
  built: { low: 29_000, medium: 1_900, commercial: 9_000, industrial: 4_000, office: 1_000 },
  demand: { low: 100, medium: 50, high: 0, commercial: 40, industrial: 0, office: 0 },
  ...over,
});

describe("the growth governor: what may be supplied is what the game asks for and what fills", () => {
  test("a use the game has no building demand for is closed, whatever else is said (community wiki: zoned cells grow only while there is demand)", () => {
    const verdict = new GrowthGovernor().observe(at(0));
    expect(verdict.uses.industrial.open).toBe(false);
    expect(verdict.uses.office.open).toBe(false);
    expect(verdict.uses.low.open).toBe(true);
    expect(verdict.uses.industrial.reason).toMatch(/no building demand/);
  });

  test("live 2026-10-08: medium rows standing empty and not filling are closed even while the demand bar shows them wanted; filling homes stay open", () => {
    const governor = new GrowthGovernor();
    for (let hour = 0; hour <= STUCK_HOURS + 1; hour += 1) {
      // Medium: 14,000 empty, no gain. Low: 1,000 empty, filling 300 cells an hour.
      governor.observe(at(hour, { zoned: { low: 40_000, medium: 22_000 }, built: { low: 39_000 + hour * 300, medium: 8_000 }, demand: { low: 100, medium: 100 } }));
    }
    const verdict = governor.observe(at(STUCK_HOURS + 2, { zoned: { low: 40_000, medium: 22_000 }, built: { low: 39_000 + (STUCK_HOURS + 2) * 300, medium: 8_000 }, demand: { low: 100, medium: 100 } }));
    expect(verdict.uses.medium.open).toBe(false);
    expect(verdict.uses.medium.reason).toMatch(/stand empty/);
    expect(verdict.uses.low.open).toBe(true);
  });
});

describe("the growth governor: a flickering demand reading does not open and close a use every cycle", () => {
  test("live 2026-10-08: 0, 29, 100, 0 in four cycles — the average decides, not one reading", () => {
    const governor = new GrowthGovernor();
    const readings = [0, 0, 0, 0, 29, 0, 0];
    let verdict = governor.observe(at(0, { demand: { low: 0 } }));
    readings.forEach((low, index) => { verdict = governor.observe(at(0.1 * (index + 1), { demand: { low } })); });
    expect(verdict.uses.low.open).toBe(false);
    // A demand that holds is acted on.
    for (let step = 1; step <= 12; step += 1) verdict = governor.observe(at(1 + 0.1 * step, { demand: { low: 100 } }));
    expect(verdict.uses.low.open).toBe(true);
  });
});

describe("the growth governor: homes' demand is read over hours", () => {
  test("live 2026-10-08: the homes' bar at 0 for an hour after new houses, then 100 — homes stay open and the stock is kept ready; shops judged on the hour", () => {
    const governor = new GrowthGovernor();
    let verdict = governor.observe(at(0, { demand: { low: 100, commercial: 100 } }));
    for (let step = 1; step <= 30; step += 1) {
      const hour = step * 0.2;
      // 4 game hours at 100, then 2 at 0 (the new houses stand empty).
      const value = hour <= 4 ? 100 : 0;
      verdict = governor.observe(at(hour, { demand: { low: value, commercial: value }, built: { low: 29_000 + step * 40 } }));
    }
    expect(verdict.uses.low.open).toBe(true);
    expect(verdict.uses.low.demand).toBeGreaterThan(10);
    expect(verdict.uses.commercial.open).toBe(false);
  });
});

describe("the growth governor: the next dead loop is seen and broken, whatever its cause", () => {
  test("BUSY: districts laid for a whole window with no progress — the busiest supply is suspended, and the suspension ends", () => {
    const governor = new GrowthGovernor();
    let verdict = governor.observe(at(0));
    for (let hour = 1; hour <= PROGRESS_WINDOW_HOURS + 1; hour += 1) {
      governor.noteAction("LAY", "low", 1_500, { frame: Math.round(hour * GAME_HOUR_FRAMES), cycle: hour });
      verdict = governor.observe(at(hour));
    }
    expect(verdict.stall?.kind).toBe("BUSY");
    expect(governor.isSuspended(supplyFamily("LAY", "low"), at(PROGRESS_WINDOW_HOURS + 1).stamp)).toBe(true);
    expect(verdict.summary).toMatch(/STALL BUSY/);
    // Its judged outcomes (no cell filled) suspend it again, twice as long: the pause still ends, and nothing is suspended for ever.
    expect(governor.isSuspended(supplyFamily("LAY", "low"), at(PROGRESS_WINDOW_HOURS + 2 + SUSPEND_BASE_HOURS).stamp)).toBe(true);
    expect(governor.isSuspended(supplyFamily("LAY", "low"), at(PROGRESS_WINDOW_HOURS + 2 + SUSPEND_MAXIMUM_HOURS).stamp)).toBe(false);
  });

  test("IDLE: nothing done and nothing moving for a whole window — one supply action is forced past the waits, then not again until another window", () => {
    const governor = new GrowthGovernor();
    let verdict = governor.observe(at(0));
    for (let hour = 1; hour <= PROGRESS_WINDOW_HOURS + 1; hour += 1) verdict = governor.observe(at(hour));
    expect(verdict.stall?.kind).toBe("IDLE");
    expect(verdict.forceOne).toBe(true);
    governor.forced(at(PROGRESS_WINDOW_HOURS + 1).stamp);
    expect(governor.observe(at(PROGRESS_WINDOW_HOURS + 2)).forceOne).toBe(false);
  });

  test("control: a city whose population rises is progressing, whatever was done", () => {
    const governor = new GrowthGovernor();
    let verdict = governor.observe(at(0));
    for (let hour = 1; hour <= PROGRESS_WINDOW_HOURS + 1; hour += 1) verdict = governor.observe(at(hour, { population: 10_000 + hour * 50 }));
    expect(verdict.stall).toBeNull();
    expect(verdict.forceOne).toBe(false);
  });
});

describe("the growth governor: outcome scores (the recorder feeding back)", () => {
  test("supply whose cells never fill is scored down and suspended after enough judgements; the scores are kept for the next session", () => {
    const governor = new GrowthGovernor();
    governor.observe(at(0));
    for (let index = 0; index < MINIMUM_JUDGED; index += 1) governor.noteAction("ZONE", "office", 900, at(index).stamp);
    // The city progresses (people come) but offices never fill.
    let verdict = governor.observe(at(1, { population: 10_100 }));
    for (let hour = 2; hour <= MINIMUM_JUDGED + JUDGE_HOURS + 1; hour += 1) verdict = governor.observe(at(hour, { population: 10_000 + hour * 100 }));
    expect(governor.memory.scores[supplyFamily("ZONE", "office")]).toEqual({ judged: MINIMUM_JUDGED, effective: 0 });
    expect(verdict.suspended.some((entry) => entry.family === "ZONE:office")).toBe(true);
    const next = new GrowthGovernor(JSON.parse(JSON.stringify(governor.memory)));
    expect(next.memory.scores["ZONE:office"]?.judged).toBe(MINIMUM_JUDGED);
  });

  test("supply whose cells fill is scored effective and never suspended", () => {
    const governor = new GrowthGovernor();
    governor.observe(at(0));
    for (let index = 0; index < MINIMUM_JUDGED; index += 1) governor.noteAction("LAY", "low", 1_500, at(index).stamp);
    for (let hour = 1; hour <= MINIMUM_JUDGED + JUDGE_HOURS + 1; hour += 1) governor.observe(at(hour, { population: 10_000 + hour * 100, built: { low: 29_000 + hour * 400 } }));
    expect(governor.memory.scores["LAY:low"]).toEqual({ judged: MINIMUM_JUDGED, effective: MINIMUM_JUDGED });
    expect(governor.isSuspended("LAY:low", at(MINIMUM_JUDGED + JUDGE_HOURS + 1).stamp)).toBe(false);
  });
});
