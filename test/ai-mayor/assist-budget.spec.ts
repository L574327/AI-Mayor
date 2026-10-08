import { AssistBudget } from "../../src/main/services/ai-mayor/v2/assist-budget";
import { iconClusters } from "../../src/main/services/ai-mayor/v2/district-services";

describe("assist budget", () => {
  it("starts nothing new once any limit is spent, and does not start a skipped stage at all", async () => {
    let clock = 0;
    const budget = new AssistBudget({ milliseconds: 1000, checks: 3, writes: 2 }, () => clock);
    const ran: string[] = [];
    await budget.stage("access", async () => { ran.push("access"); budget.noteCheck(); clock += 400; });
    await budget.stage("ruins", async () => { ran.push("ruins"); clock += 700; });
    expect(budget.exhausted()).toBe(true);
    const skipped = await budget.stage("services", async () => { ran.push("services"); return 1; });
    expect(skipped).toBeUndefined();
    expect(ran).toEqual(["access", "ruins"]);
    expect(budget.describe()).toContain("services skipped (budget spent)");
  });

  it("counts a placement check like a write and stops at the check limit", () => {
    const budget = new AssistBudget({ milliseconds: 99_999, checks: 2, writes: 9 }, () => 0);
    budget.noteCheck(); expect(budget.exhausted()).toBe(false);
    budget.noteCheck(); expect(budget.exhausted()).toBe(true);
  });

  it("a slow step cannot write after the budget is spent: the caller asks before it commits", async () => {
    let clock = 0;
    const budget = new AssistBudget({ milliseconds: 500, checks: 9, writes: 9 }, () => clock);
    const writes: number[] = [];
    await budget.stage("services", async () => {
      clock += 600; // the preflight took too long
      if (!budget.exhausted()) writes.push(1); // the commit-time check
    });
    expect(writes).toEqual([]);
  });
});

describe("icon clusters", () => {
  it("groups scattered icons, biggest first, and never merges clusters farther apart than the radius", () => {
    const south = [{ x: 100, z: -900 }, { x: 150, z: -950 }, { x: 120, z: -920 }];
    const west = [{ x: -900, z: 100 }, { x: -950, z: 130 }];
    const clusters = iconClusters([...west, ...south]);
    expect(clusters.map((cluster) => cluster.size)).toEqual([3, 2]);
    expect(Math.round(clusters[0]!.center.z)).toBe(-923);
  });
  it("one icon is one cluster; none is none", () => {
    expect(iconClusters([{ x: 1, z: 2 }])).toHaveLength(1);
    expect(iconClusters([])).toEqual([]);
  });
});
