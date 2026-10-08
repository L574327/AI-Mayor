import { classifyBottleneck, neededLandUses, neededStockAbsorbing, pausedLandUses, unemployedCount, unemploymentShare } from "../../src/main/services/ai-mayor/v2/growth-bottleneck";
import { emptyMix, type ZoningMixSignals } from "../../src/main/services/ai-mayor/v2/zoning-mix";

const ALL = ["residential", "commercial", "office", "industrial"] as const;
const mix = (cells: Partial<Record<(typeof ALL)[number], { zoned: number; empty: number }>>): ZoningMixSignals => {
  const base = emptyMix();
  return { ...base, cells: { ...base.cells, ...cells } };
};

describe("FAST_EXPANSION: which supply to stop adding", () => {
  test("rates arrive as a fraction or a percent", () => {
    expect(unemploymentShare(0.35)).toBeCloseTo(0.35);
    expect(unemploymentShare(35)).toBeCloseTo(0.35);
    expect(unemploymentShare(-1)).toBe(0);
  });

  test("the measured jobless city (758 people, 35% unemployed, 9 jobs open) is short of jobs, not homes", () => {
    const labor = { employed: 267, unemploymentRate: 0.35, jobsTotal: 267, jobsFree: 9 };
    expect(unemployedCount(labor)).toBe(144);
    expect(classifyBottleneck(labor).bottleneck).toBe("JOBS");
  });

  test("open jobs beside many unemployed is a mismatch, and still no more homes", () => {
    const labor = { employed: 1000, unemploymentRate: 0.2, jobsTotal: 1400, jobsFree: 400 };
    expect(classifyBottleneck(labor).bottleneck).toBe("MATCH");
    expect(pausedLandUses(mix({}), "MATCH", ALL)).toContain("residential");
  });

  test("homes are the bottleneck only when jobs stand open and almost no one is out of work", () => {
    expect(classifyBottleneck({ employed: 1000, unemploymentRate: 0.02, jobsTotal: 1300, jobsFree: 300 }).bottleneck).toBe("HOUSING");
    expect(classifyBottleneck({ employed: 1000, unemploymentRate: 0.02, jobsTotal: 1000, jobsFree: 0 }).bottleneck).toBe("NONE");
    expect(classifyBottleneck(null).bottleneck).toBe("NONE");
  });

  test("a land use whose zoning stands mostly empty is stock: no more of it, whatever the bottleneck", () => {
    const signals = mix({ commercial: { zoned: 4_304, empty: 3_117 }, industrial: { zoned: 100, empty: 10 } });
    const paused = pausedLandUses(signals, "NONE", ALL);
    expect(paused).toEqual(["commercial"]);
  });

  test("the supply the city needs is named by the bottleneck and by the game's own demand", () => {
    const none = { residential: 0, commercial: 0, office: 0, industrial: 0 };
    expect(neededLandUses("HOUSING", none, ALL)).toEqual(["residential"]);
    expect(neededLandUses("JOBS", none, ["residential", "commercial", "industrial"]).sort()).toEqual(["commercial", "industrial"]);
    expect(neededLandUses("NONE", { ...none, residential: 100, industrial: 51 }, ALL).sort()).toEqual(["industrial", "residential"]);
    expect(neededLandUses("NONE", { ...none, office: 100 }, ["residential", "commercial"])).toEqual([]);
  });

  test("land is prepared when the needed use's unbuilt zoning is falling, not when it stands still or grows; stock of an unneeded use never holds it back", () => {
    const cells = (empty: number, zoned = 11_000) => ({ ...emptyMix().cells, residential: { zoned, empty }, commercial: { zoned: 4_000, empty: 3_500 } });
    const now = (empty: number): ZoningMixSignals => ({ ...emptyMix(), cells: cells(empty) });
    const falling = [cells(7_000), cells(6_800), cells(6_600)];
    expect(neededStockAbsorbing(falling, now(6_400), ["residential"]).absorbing).toBe(true);
    const standing = [cells(7_000), cells(7_050), cells(7_000)];
    expect(neededStockAbsorbing(standing, now(7_000), ["residential"]).absorbing).toBe(false);
    const growing = [cells(6_000), cells(6_500), cells(7_000)];
    expect(neededStockAbsorbing(growing, now(7_400), ["residential"]).absorbing).toBe(false);
    // No history yet: a small stock is absorbing, a big one is not.
    expect(neededStockAbsorbing([], now(2_000), ["residential"]).absorbing).toBe(true);
    expect(neededStockAbsorbing([], now(7_000), ["residential"]).absorbing).toBe(false);
    // Commercial stands 87% empty, but the city needs homes: that does not hold land back.
    expect(neededStockAbsorbing(falling, now(6_400), ["residential"]).absorbing).toBe(true);
    expect(neededStockAbsorbing(falling, now(6_400), []).absorbing).toBe(false);
  });

  test("only land uses the game offers can be paused; homes are held while jobs are short", () => {
    expect(pausedLandUses(mix({}), "JOBS", ["residential", "commercial"])).toEqual(["residential"]);
    expect(pausedLandUses(mix({ office: { zoned: 10, empty: 10 } }), "NONE", ["residential", "commercial"])).toEqual([]);
  });
});
