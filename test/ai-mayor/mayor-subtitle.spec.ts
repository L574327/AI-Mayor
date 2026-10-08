import { mayorSubtitle, type MayorSubtitleState } from "../../src/main/services/ai-mayor/v2/mayor-subtitle";

const state = (decision: Record<string, unknown>, overrides: Partial<MayorSubtitleState> = {}): MayorSubtitleState => ({
  status: "running",
  lastStatus: "V2 Brain working",
  runLedger: { entries: [{ reason: "window", decision }] },
  ...overrides,
});

describe("mayor subtitle", () => {
  it("reports what was just delivered, which is what the player can see", () => {
    expect(mayorSubtitle(state({ applied: { road: 3, zoning: 6, facility: 0 } })))
      .toBe("刚完成：3 段道路 / 6 格分区");
    expect(mayorSubtitle(state({ applied: { road: 0, zoning: 0, facility: 1 } })))
      .toBe("刚完成：1 个设施");
  });

  it("explains a park as a re-site rather than looking stopped", () => {
    expect(mayorSubtitle(state({
      parkedFamily: "EXPAND_RESIDENTIAL:residential", parkedReason: "held back on TARGET facts",
    }))).toContain("正在换址");
  });

  it("names the land use and the stage while work is under way", () => {
    expect(mayorSubtitle(state({ goalId: "EXPAND_RESIDENTIAL:residential:facts:ab", workOrderStage: "ZONED_WAITING_FOR_BUILDING" })))
      .toBe("正在扩建住宅片区：分区已交付，等待建筑生成");
    expect(mayorSubtitle(state({ goalId: "EXPAND_INDUSTRIAL:industrial:facts:ab", workOrderStage: "DIAGNOSING" })))
      .toBe("工业片区正在诊断停滞原因…");
  });

  it("says why nothing is happening when the policy has no goal", () => {
    expect(mayorSubtitle(state({ policyAnswer: "GROWTH_POLICY_HAS_NO_GOAL" })))
      .toBe("当前没有可执行的增长目标，继续观察城市变化");
    expect(mayorSubtitle(state({ policyAnswer: "GROWTH_POLICY_TARGET_RETRY:-601.9,-162.0,192.0" })))
      .toContain("正在换一处候选地块");
  });

  // The fallback is the moment a watcher is most likely to read the Mayor as
  // idle, because the direction it first named has gone quiet.
  it("says when the Mayor changed direction because the first had nowhere to build", () => {
    expect(mayorSubtitle(state({
      policyAnswer: "GROWTH_POLICY_DOMAIN_SWITCH:EXPAND_RESIDENTIAL:residential->EXPAND_COMMERCIAL:commercial:facts:ab",
    }))).toBe("上一个方向暂时没有可用地块，已改扩建商业片区");
    expect(mayorSubtitle(state({
      policyAnswer: "GROWTH_POLICY_ALL_DOMAINS_REFUSED:GROWTH_POLICY_GOAL_SKIPPED:EXPAND_OFFICE:office:facts:ab:PARKED",
    }))).toBe("各建设方向当前都没有可用地块，先让城市继续运行");
  });

  it("names an office district like any other land use", () => {
    expect(mayorSubtitle(state({ goalId: "EXPAND_OFFICE:office:facts:ab", workOrderStage: "ROAD_DELIVERED" })))
      .toBe("正在扩建办公片区：道路已交付，准备分区");
  });

  it("reports a stop with its reason ahead of any window detail", () => {
    expect(mayorSubtitle({ status: "stopped", stopReason: "RUN_STALLED_NO_WORLD_EFFECT" }))
      .toBe("已停止：RUN_STALLED_NO_WORLD_EFFECT");
    expect(mayorSubtitle(state({ haltReason: "GOAL_SUCCESSOR_BUDGET_EXHAUSTED" })))
      .toBe("已停止：GOAL_SUCCESSOR_BUDGET_EXHAUSTED");
  });

  it("falls back to the Brain's own status rather than inventing a claim", () => {
    expect(mayorSubtitle(state({}))).toBe("V2 Brain working");
    expect(mayorSubtitle({ status: "running", lastStatus: "V2 Brain observing: pending" }))
      .toBe("V2 Brain observing: pending");
    expect(mayorSubtitle(null)).toBeNull();
    expect(mayorSubtitle({ status: "running" })).toBeNull();
  });
});
