import {
  ABSORPTION_CONTROL_DEMAND_FLOOR,
  AUTONOMY_STABILIZATION_POPULATION,
  DEFAULT_MAYOR_GROWTH_MODE,
  DEFAULT_MAYOR_GROWTH_SETTINGS,
  FULL_PACE,
  MAXIMUM_STABILIZATION_POPULATION,
  MINIMUM_STABILIZATION_POPULATION,
  SUSTAINED_PACE,
  absorptionGatesExpansion,
  growthModeDemandFloor,
  growthPaceForPopulation,
  growthPacePolicy,
  resolveGrowthSettings,
} from "../../src/main/services/ai-mayor/growth-mode";

const policy = {
  targetResidents: 12,
  planningEnvelopeRadiusMeters: 180,
  maximumPlanningEnvelopeRadiusMeters: 360,
  absoluteBudgetCeiling: 25_000,
  maximumSiteCandidates: 4,
  maximumGrowableSearchAnchors: 4,
};

describe("growth mode", () => {
  it("defaults to full-speed expansion", () => {
    expect(DEFAULT_MAYOR_GROWTH_MODE).toBe("FULL_SPEED_EXPANSION");
  });

  it("never lets absorption gate expansion under the default mode", () => {
    expect(absorptionGatesExpansion()).toBe(false);
    expect(absorptionGatesExpansion("ABSORPTION_CONTROL")).toBe(true);
  });

  it("lowers the demand floor to zero under full-speed expansion", () => {
    expect(growthModeDemandFloor()).toBe(0);
    expect(growthModeDemandFloor("ABSORPTION_CONTROL")).toBe(ABSORPTION_CONTROL_DEMAND_FLOOR);
  });
});

describe("growth pace", () => {
  it("reads an unread population as not yet at the stabilization node", () => {
    expect(growthPaceForPopulation(null).paceId).toBe("FULL");
    expect(growthPaceForPopulation(undefined).paceId).toBe("FULL");
    expect(growthPaceForPopulation(Number.NaN).paceId).toBe("FULL");
  });

  it("runs full pace below the stabilization node and sustained at or above it", () => {
    expect(growthPaceForPopulation(0).paceId).toBe("FULL");
    expect(growthPaceForPopulation(AUTONOMY_STABILIZATION_POPULATION - 1).paceId).toBe("FULL");
    expect(growthPaceForPopulation(AUTONOMY_STABILIZATION_POPULATION).paceId).toBe("SUSTAINED");
    expect(growthPaceForPopulation(AUTONOMY_STABILIZATION_POPULATION * 4).paceId).toBe("SUSTAINED");
  });

  // The product rule this module exists to protect: slowing down is a dial on
  // package size and cadence, never a switch that removes the ability to expand.
  it("keeps every pace able to build, and only reduces cost", () => {
    for (const pace of [FULL_PACE, SUSTAINED_PACE]) {
      expect(pace.maximumSiteAnchors).toBeGreaterThan(0);
      expect(pace.maximumPackageItems).toBeGreaterThan(0);
      expect(pace.programmeMultiplier).toBeGreaterThanOrEqual(1);
      expect(pace.interPackageObservationHours).toBeGreaterThan(0);
    }
    expect(SUSTAINED_PACE.programmeMultiplier).toBeLessThan(FULL_PACE.programmeMultiplier);
    expect(SUSTAINED_PACE.maximumSiteAnchors).toBeLessThan(FULL_PACE.maximumSiteAnchors);
    expect(SUSTAINED_PACE.maximumPackageItems).toBeLessThan(FULL_PACE.maximumPackageItems);
    expect(SUSTAINED_PACE.interPackageObservationHours).toBeGreaterThan(FULL_PACE.interPackageObservationHours);
  });

  it("scales the programme without touching any legality rule", () => {
    const full = growthPacePolicy(policy, FULL_PACE);
    expect(full.targetResidents).toBe(policy.targetResidents * FULL_PACE.programmeMultiplier);
    expect(full.absoluteBudgetCeiling).toBe(policy.absoluteBudgetCeiling * FULL_PACE.programmeMultiplier);
    expect(full.maximumSiteCandidates).toBe(policy.maximumSiteCandidates * FULL_PACE.programmeMultiplier);
    expect(full.maximumGrowableSearchAnchors).toBe(FULL_PACE.maximumSiteAnchors);
  });

  /**
   * The reservation has to stay inside the region admission actually observed.
   * The envelope ceiling is sized to the bounded detail read for exactly that
   * reason, so a pace that scaled it would hand a large city a claim on ground
   * nobody censused — the failure the ceiling exists to prevent.
   */
  it("never scales the planning envelope", () => {
    for (const pace of [FULL_PACE, SUSTAINED_PACE]) {
      const paced = growthPacePolicy(policy, pace);
      expect(paced.planningEnvelopeRadiusMeters).toBe(policy.planningEnvelopeRadiusMeters);
      expect(paced.maximumPlanningEnvelopeRadiusMeters).toBe(policy.maximumPlanningEnvelopeRadiusMeters);
    }
  });

  it("keeps 100,000 as the frozen default brake node", () => {
    expect(DEFAULT_MAYOR_GROWTH_SETTINGS.stabilizationPopulation).toBe(100_000);
    expect(AUTONOMY_STABILIZATION_POPULATION).toBe(100_000);
    expect(DEFAULT_MAYOR_GROWTH_SETTINGS.pinnedPace).toBeNull();
    // A build with no settings source at all runs the default policy exactly.
    expect(growthPaceForPopulation(99_999, resolveGrowthSettings(null)).paceId).toBe("FULL");
    expect(growthPaceForPopulation(100_000, resolveGrowthSettings(undefined)).paceId).toBe("SUSTAINED");
  });

  // The player may aim lower or higher, and that moves the brake — but absence of
  // configuration must never move it.
  it("moves the brake to a player-chosen target population", () => {
    expect(growthPaceForPopulation(50_000, resolveGrowthSettings({ stabilizationPopulation: 50_000 })).paceId)
      .toBe("SUSTAINED");
    expect(growthPaceForPopulation(500_000, resolveGrowthSettings({ stabilizationPopulation: 1_000_000 })).paceId)
      .toBe("FULL");
  });

  it("bounds an unusable target population instead of failing", () => {
    // A value that is not a number at all is a missing input, and the frozen
    // default stands. A number outside the range is an instruction that is out
    // of bounds, and it is clamped to the nearest bound so the player gets the
    // closest thing they asked for rather than a silent reset.
    for (const target of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(resolveGrowthSettings({ stabilizationPopulation: target }).stabilizationPopulation)
        .toBe(AUTONOMY_STABILIZATION_POPULATION);
    }
    for (const target of [-5, 0, 10]) {
      expect(resolveGrowthSettings({ stabilizationPopulation: target }).stabilizationPopulation)
        .toBe(MINIMUM_STABILIZATION_POPULATION);
    }
    expect(resolveGrowthSettings({ stabilizationPopulation: 10_000_000 }).stabilizationPopulation)
      .toBe(MAXIMUM_STABILIZATION_POPULATION);
    // An empty input box reads as "not yet set", not as zero.
    const empty = { stabilizationPopulation: undefined } as Partial<{ stabilizationPopulation: number }>;
    expect(resolveGrowthSettings(empty).stabilizationPopulation).toBe(AUTONOMY_STABILIZATION_POPULATION);
  });

  // The mode switch has to work at any population, in both directions.
  it("lets the player pin a pace at any population, both ways", () => {
    const tiny = 10;
    const huge = 10_000_000;
    expect(growthPaceForPopulation(tiny, resolveGrowthSettings({ pinnedPace: "SUSTAINED" })).paceId).toBe("SUSTAINED");
    expect(growthPaceForPopulation(huge, resolveGrowthSettings({ pinnedPace: "FULL" })).paceId).toBe("FULL");
    // Unpinning returns the city to automatic control at its own population.
    expect(growthPaceForPopulation(tiny, resolveGrowthSettings({ pinnedPace: null })).paceId).toBe("FULL");
    expect(growthPaceForPopulation(huge, resolveGrowthSettings({ pinnedPace: null })).paceId).toBe("SUSTAINED");
  });

  it("falls back to the default mode for an unrecognised one", () => {
    expect(resolveGrowthSettings({ mode: "NONSENSE" as never }).mode).toBe(DEFAULT_MAYOR_GROWTH_MODE);
  });

  it("leaves the base programme's numbers alone at the baseline multiplier", () => {
    const sustained = growthPacePolicy(policy, SUSTAINED_PACE);
    expect(sustained.targetResidents).toBe(policy.targetResidents);
    expect(sustained.absoluteBudgetCeiling).toBe(policy.absoluteBudgetCeiling);
    expect(sustained.maximumSiteCandidates).toBe(policy.maximumSiteCandidates);
  });

  it("keeps the sustained package bounded rather than district sized", () => {
    const full = growthPacePolicy(policy, FULL_PACE);
    const sustained = growthPacePolicy(policy, SUSTAINED_PACE);
    expect(sustained.absoluteBudgetCeiling).toBeLessThan(full.absoluteBudgetCeiling);
    expect(sustained.targetResidents).toBeLessThan(full.targetResidents);
    expect(sustained.maximumGrowableSearchAnchors).toBeLessThan(full.maximumGrowableSearchAnchors);
  });
});
