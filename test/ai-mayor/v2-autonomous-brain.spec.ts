import {
  capabilitiesForGap,
  chooseGate1CapabilityTask,
  chooseUtilityCapability,
  deriveUtilityGap,
  facilityGapOptions,
  ledgerEpoch,
  meaningfulProgress,
  nextUtilityStrategy,
  utilityStrategiesForGap,
  utilityFactsFromEvidence,
  utilityGapIsWaitOnly,
  utilityGapSatisfied,
  utilityActionMadeGapProgress,
  nextGrowthGoal,
  rankedGrowthGoals,
  utilityKindFromServiceGoalId,
  ZONING_LAYOUT_SKILL,
} from "../../src/main/services/ai-mayor/v2/autonomous-brain";

const growthState = (overrides: Record<string, unknown> = {}) => ({
  version: 1, snapshotRevision: "revision-a", worldFingerprint: "world-a", status: "available",
  game: { available: true, paused: true, gameDateTime: null }, population: 0, treasury: 100_000,
  monthlyBalance: 1_000, financeRunwayMonths: 12,
  // A catalogue that CAN zone every growable domain. The capability is a fact
  // about the bridge, not about the land, so a fixture that leaves it out is
  // modelling a catalogue nobody read — which suppresses nothing.
  availableZoneDomains: ["residential", "commercial", "industrial", "office"],
  demands: { residential: 0, commercial: 0, industrial: 0, office: 0 },
  developmentCapacity: { targetZoningCells: 24, zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
    typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: false },
    reserveDeficit: false, reserveStatus: "sufficient", frontierAnchorCount: 2 },
  utilities: { electricity: { available: true, headroom: 100, risk: "healthy" },
    water: { available: true, headroom: 100, risk: "healthy" }, sewage: { available: true, headroom: 100, risk: "healthy" } },
  candidates: { zoning: [], roadExpansion: [], usefulFrontierCount: 2, currentDevelopmentCapacity: 0,
    pendingZoningCells: 0, pendingFrontageCapacity: 0 },
  actionability: { status: "available", reasonCode: "OK", reason: "ok", refreshAttempted: false,
    backoffRemaining: 0, capacityStatus: "insufficient" },
  issues: { current: [], history: [], highest: null },
  history: { recentActions: [], cooldowns: [], episodes: [], observations: [] },
  ...overrides,
} as never);

describe("deterministic autonomous decision brain", () => {
  test("maps fixed Goal intents directly to the existing Brain goal vocabulary", () => {
    expect(nextGrowthGoal(growthState(), {
      kind: "GOAL", type: "EXPAND_COMMERCIAL", priority: "HIGH",
    }).goalId).toBe("EXPAND_COMMERCIAL");
    expect(nextGrowthGoal(growthState(), {
      kind: "GOAL", type: "PROVIDE_SERVICE", scope: { serviceKind: "WATER" }, priority: "NORMAL",
    }).goalId).toBe("PROVIDE_SERVICE:water");
    expect(nextGrowthGoal(growthState(), {
      kind: "GOAL", type: "ESTABLISH_ROAD_NETWORK", priority: "NORMAL",
    }).type).toBe("ESTABLISH_ROAD_NETWORK");
  });

  /**
   * The expansion domains' order is the policy provider's, not this list's. It
   * used to be re-sorted here on urgency, then demand, then the domain's NAME,
   * which put `EXPAND_OFFICE` ahead of `EXPAND_RESIDENTIAL` whenever the two
   * tied on both. Measured live (2026-10-01, fresh city) the list came out
   * `PROVIDE_SERVICE, EXPAND_OFFICE, EXPAND_RESIDENTIAL, EXPAND_INDUSTRIAL,
   * EXPAND_COMMERCIAL` — and since this runtime has no Office zone prefab at
   * all, the city spent its turns on that capability gap while the housing that
   * would produce the population it has none of waited behind it.
   */
  test("keeps the policy's own order between expansion domains that tie on urgency", () => {
    const ranked = rankedGrowthGoals(growthState({
      demands: { residential: 100, commercial: 0, industrial: 0, office: 100 },
      developmentCapacity: { targetZoningCells: 24, reserveStatus: "empty",
        zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: true, commercial: true, industrial: true, office: true },
        reserveDeficit: true, frontierAnchorCount: 2 },
    }), "FULL_SPEED_EXPANSION", null, new Set());
    const domains = ranked.filter((goal) => goal.type.startsWith("EXPAND_")).map((goal) => goal.type);
    expect(domains.indexOf("EXPAND_RESIDENTIAL")).toBeGreaterThanOrEqual(0);
    expect(domains.indexOf("EXPAND_RESIDENTIAL")).toBeLessThan(domains.indexOf("EXPAND_OFFICE"));
  });

  /**
   * The capability that actually cost half a live run's ticks. Measured live
   * (2026-10-01): the map's catalogue exposes no `office: true` Industrial zone,
   * so every Office Goal was admitted, built its access road, and refused its
   * own ZONING step by name. Filtering the domain here means the Goal is never
   * generated in the first place — and because the answer is a fact about the
   * catalogue, which is re-read every cycle, the domain returns by itself the
   * moment the category unlocks. No park, no strike budget, nothing to remember.
   */
  test("a domain the catalogue cannot zone is never turned into work", () => {
    const withoutOffice = rankedGrowthGoals(growthState({
      availableZoneDomains: ["residential", "commercial", "industrial"],
      demands: { residential: 100, commercial: 100, industrial: 100, office: 100 },
      developmentCapacity: { targetZoningCells: 24, reserveStatus: "empty",
        zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: true, commercial: true, industrial: true, office: true },
        reserveDeficit: true, frontierAnchorCount: 2 },
    }), "FULL_SPEED_EXPANSION", null, new Set());
    const domains = withoutOffice.filter((goal) => goal.type.startsWith("EXPAND_")).map((goal) => goal.type);
    expect(domains).not.toContain("EXPAND_OFFICE");
    // The domains the catalogue CAN zone are untouched — this drops one domain,
    // it does not stand the city down.
    expect(domains).toContain("EXPAND_RESIDENTIAL");
  });

  test("an unread catalogue suppresses nothing", () => {
    const unread = rankedGrowthGoals(growthState({
      availableZoneDomains: null,
      demands: { residential: 100, commercial: 0, industrial: 0, office: 100 },
      developmentCapacity: { targetZoningCells: 24, reserveStatus: "empty",
        zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: true, commercial: true, industrial: true, office: true },
        reserveDeficit: true, frontierAnchorCount: 2 },
    }), "FULL_SPEED_EXPANSION", null, new Set());
    expect(unread.filter((goal) => goal.type.startsWith("EXPAND_")).map((goal) => goal.type))
      .toContain("EXPAND_OFFICE");
  });

  test("keeps service Goals scoped to the utility they name", () => {
    expect(utilityKindFromServiceGoalId("PROVIDE_SERVICE:electricity:facts:abc")).toBe("electricity");
    expect(utilityKindFromServiceGoalId("UTILITY_SERVICE:water:city:site_scope:1")).toBe("water");
    expect(utilityKindFromServiceGoalId("EXPAND_RESIDENTIAL:residential:facts:abc")).toBeUndefined();
    expect(utilityKindFromServiceGoalId("PROVIDE_SERVICE:garbage:facts:abc")).toBeUndefined();
  });

  test("existing facility and physical cable with unreachable target selects a network capability", () => {
    const gap = deriveUtilityGap("electricity:city", "electricity", {
      facilityAvailable: true,
      facilityAccessible: true,
      physicalConnection: true,
      networkReachable: false,
      capacitySufficient: false,
      serviceDelivered: false,
      existingUsableCapacity: false,
      existingInfrastructureIncomplete: false,
      scopedConsumerCount: null,
    });
    expect(gap?.gap).toBe("NETWORK_REACHABLE");
    expect(capabilitiesForGap("NETWORK_REACHABLE").map((capability) => capability.capabilityId))
      .not.toContain("PLACE_FACILITY");
    expect(chooseUtilityCapability("NETWORK_REACHABLE")?.capabilityId).toBe("REPAIR_UTILITY_NETWORK");
    expect(utilityStrategiesForGap("NETWORK_REACHABLE")).toEqual([
      "REUSE_REACHABLE_NETWORK", "REPAIR_MISSING_FLOW_PATH", "EXTEND_EXISTING_NETWORK",
      "RECONNECT_TARGET", "FACILITY_REPLACEMENT_LAST_RESORT",
    ]);
  });

  test("first unmet fact advances as authoritative prerequisites change", () => {
    const base = { facilityAvailable: true, facilityAccessible: true, physicalConnection: true,
      networkReachable: false, capacitySufficient: false, serviceDelivered: false, existingUsableCapacity: false, existingInfrastructureIncomplete: false, scopedConsumerCount: 1 };
    expect(deriveUtilityGap("e", "electricity", base)?.gap).toBe("NETWORK_REACHABLE");
    expect(deriveUtilityGap("e", "electricity", { ...base, networkReachable: true })?.gap).toBe("CAPACITY_SUFFICIENT");
    expect(deriveUtilityGap("e", "electricity", { ...base, networkReachable: true, capacitySufficient: true })?.gap)
      .toBe("SERVICE_DELIVERED");
    expect(deriveUtilityGap("e", "electricity", { ...base, networkReachable: true, capacitySufficient: true, serviceDelivered: true }))
      .toBeNull();
  });

  test("city and supply aggregates cannot certify tranche consumer delivery", () => {
    const facts = utilityFactsFromEvidence({
      evidence: {
        status: "AVAILABLE", capacity: 100, consumption: 0, fulfilledConsumption: null, issueActive: false,
        supplyExists: true, networkConnected: true, cityCapacityAvailable: true, targetNetworkReachable: true,
        facility: null, connector: null, targetRoad: { index: 1, version: 1 }, evidenceGeneration: "g", topologyRevision: "t",
      } as never,
      facilityExists: true,
      facilityAccessible: true,
      physicalConnection: true,
      scopedConsumerCount: 1,
    });
    expect(facts.capacitySufficient).toBe(true);
    expect(facts.serviceDelivered).toBe(false);
  });

  test("a placed facility satisfies FACILITY_AVAILABLE even before any supply readback", () => {
    // The capability that solves FACILITY_AVAILABLE produces a facility, not a
    // supply. Requiring the supply readback here made the Gap unreachable by its
    // own capability, so a successful placement was recorded as no progress and
    // the single strategy exhausted.
    const placedNoSupply = utilityFactsFromEvidence({
      evidence: {
        status: "AVAILABLE", capacity: 1, consumption: 0, fulfilledConsumption: 0, issueActive: true,
        supplyExists: false, networkConnected: "UNKNOWN", cityCapacityAvailable: true,
        targetNetworkReachable: "UNKNOWN", facility: null, connector: null, targetRoad: null,
        evidenceGeneration: "g", topologyRevision: "t",
      } as never,
      facilityExists: true,
      facilityAccessible: true,
      physicalConnection: false,
      scopedConsumerCount: 0,
    });
    expect(placedNoSupply.facilityAvailable).toBe(true);
    expect(placedNoSupply.physicalConnection).toBe(false);
    expect(deriveUtilityGap("electricity:city", "electricity", placedNoSupply)?.gap).toBe("PHYSICAL_CONNECTION");
    // No facility at all still derives the placement Gap.
    expect(utilityFactsFromEvidence({
      evidence: null, facilityExists: false, facilityAccessible: false, physicalConnection: false,
      scopedConsumerCount: 0,
    }).facilityAvailable).toBe(false);
  });

  test("known empty residential scope treats complete topology as pre-consumer readiness only", () => {
    const base = { facilityAvailable: true, facilityAccessible: true, physicalConnection: true,
      networkReachable: true, capacitySufficient: true, serviceDelivered: false, existingUsableCapacity: false, existingInfrastructureIncomplete: false, scopedConsumerCount: 0 };
    expect(deriveUtilityGap("e", "electricity", base)).toBeNull();
    expect(utilityGapSatisfied("SERVICE_DELIVERED", base)).toBe(false);
    expect(deriveUtilityGap("e", "electricity", { ...base, scopedConsumerCount: 1 })?.gap).toBe("SERVICE_DELIVERED");
    expect(deriveUtilityGap("e", "electricity", { ...base, scopedConsumerCount: null })?.gap).toBe("SERVICE_DELIVERED");
  });

  test("service delivery gap keeps selecting the existing simulation capability while it waits", () => {
    expect(chooseUtilityCapability("SERVICE_DELIVERED")?.capabilityId).toBe("ADVANCE_SIMULATION");
    expect(nextUtilityStrategy("SERVICE_DELIVERED", [])).toBe("ADVANCE_SIMULATION");
    expect(nextUtilityStrategy("SERVICE_DELIVERED", [{ goalId: "e", gap: "SERVICE_DELIVERED",
      strategy: "ADVANCE_SIMULATION", planningEpoch: "epoch", noProgressCount: 1, exhausted: false,
      lastOutcome: "WAITING_FOR_SERVICE_UPDATE" }])).toBe("ADVANCE_SIMULATION");
  });

  /**
   * Only the Gap that no capability of its own can ever satisfy is a pure wait.
   * Every other Gap has real work behind it and must keep blocking a tranche —
   * that is what keeps a commissioning pass from parking capacity, connection,
   * reachability or an explicit service failure as if it were nothing to do.
   *
   * `SERVICE_DELIVERED` is the exception for a reason worth naming: its
   * predicate is `serviceDelivered`, which `utilityFactsFromEvidence` sets false
   * by construction for a city-scoped read because Gate1's per-building
   * consumer readback owns it — and that readback runs after zoning.
   */
  test("only a Gap no capability can satisfy is a wait the world alone can answer", () => {
    expect(utilityGapIsWaitOnly("SERVICE_DELIVERED")).toBe(true);
    for (const gap of ["FACILITY_AVAILABLE", "FACILITY_ACCESSIBLE", "PHYSICAL_CONNECTION",
      "NETWORK_REACHABLE", "CAPACITY_SUFFICIENT", "ROAD_ACCESS"] as const) {
      expect(utilityGapIsWaitOnly(gap)).toBe(false);
    }
    // And the wait cannot be discharged from a city read: the fact it waits on
    // is not carried by city-scoped evidence at all.
    expect(utilityFactsFromEvidence({
      evidence: { cityCapacityAvailable: true } as never, facilityExists: false,
      facilityAccessible: false, physicalConnection: false, scopedConsumerCount: 1,
      existingUsableCapacity: true,
    })).toMatchObject({ serviceDelivered: false });
  });

  test("missing facilities select an initial placement strategy instead of a replacement", () => {
    expect(utilityStrategiesForGap("FACILITY_AVAILABLE")).toEqual(["INITIAL_FACILITY_PLACEMENT"]);
  });

  test("Growth provider follows the reused typed demand policy as demand changes", () => {
    const commercial = growthState({ demands: { residential: 0, commercial: 85, industrial: 5, office: 0 },
      developmentCapacity: { targetZoningCells: 24, zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: false, commercial: true, industrial: false, office: false },
        reserveDeficit: true, reserveStatus: "empty", frontierAnchorCount: 2 } });
    const industry = growthState({ demands: { residential: 0, commercial: 5, industrial: 90, office: 0 },
      developmentCapacity: { targetZoningCells: 24, zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: false, commercial: false, industrial: true, office: false },
        reserveDeficit: true, reserveStatus: "empty", frontierAnchorCount: 2 } });
    expect(nextGrowthGoal(commercial)?.type).toBe("EXPAND_COMMERCIAL");
    expect(nextGrowthGoal(industry)?.type).toBe("EXPAND_INDUSTRIAL");
  });

  test("a parked residential family yields to a different actionable Goal", () => {
    const state = growthState({
      demands: { residential: 75, commercial: 15, industrial: 5, office: 0 },
      developmentCapacity: { targetZoningCells: 24, zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
        reserveDeficit: true, reserveStatus: "empty", frontierAnchorCount: 2 },
      utilities: { electricity: { available: true, headroom: 100, risk: "healthy" },
        water: { available: true, headroom: 100, risk: "healthy" },
        sewage: { available: true, headroom: 100, risk: "healthy", uncommissioned: false } },
    });
    expect(nextGrowthGoal(state)?.type).toBe("EXPAND_RESIDENTIAL");
    expect(nextGrowthGoal(state, null, new Set(["EXPAND_RESIDENTIAL:residential"]))?.type)
      .not.toBe("EXPAND_RESIDENTIAL");
  });

  test("prepares one bounded grid expansion in a quiet city with an empty reserve", () => {
    const quietWithFrontier = growthState({
      developmentCapacity: { targetZoningCells: 24, reserveDeficit: false, reserveStatus: "empty", frontierAnchorCount: 2 },
      candidates: { zoning: [], roadExpansion: [], usefulFrontierCount: 2, currentDevelopmentCapacity: 0,
        pendingZoningCells: 0, pendingFrontageCapacity: 0 },
    });
    expect(nextGrowthGoal(quietWithFrontier)?.type).toBe("ESTABLISH_ROAD_NETWORK");
  });

  test("an actionable city issue pauses expansion before a quiet reserve Goal", () => {
    const blocked = growthState({
      developmentCapacity: { targetZoningCells: 24, reserveDeficit: true, reserveStatus: "empty", frontierAnchorCount: 2 },
      issues: { current: [], history: [], highest: { actionable: true, urgency: 95, kind: "traffic_issue", message: "traffic" } },
    });
    expect(nextGrowthGoal(blocked)?.type).toBe("PAUSE_FOR_ISSUE");
  });

  test("a runway shortfall with months left ranks below growth; only an exhausted runway pauses the Brain", () => {
    const demanded = { demands: { residential: 75, commercial: 15, industrial: 5, office: 0 },
      developmentCapacity: { targetZoningCells: 24, zonedUnoccupiedByType: { residential: 0, commercial: 0, industrial: 0, office: 0 },
        typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
        reserveDeficit: true, reserveStatus: "empty", frontierAnchorCount: 2 } };
    // Measured live (run-v3, runway 2.7 months): PAUSE_FOR_ISSUE answered 31 of 39 policy asks and nothing was built.
    expect(nextGrowthGoal(growthState({ ...demanded, financeRunwayMonths: 2.7, monthlyBalance: -60_000 }))?.type)
      .toBe("EXPAND_RESIDENTIAL");
    expect(nextGrowthGoal(growthState({ ...demanded, financeRunwayMonths: 1, monthlyBalance: -60_000 }))?.type)
      .toBe("PAUSE_FOR_ISSUE");
  });

  test("R/C/I layouts share legal cells but rank by distinct placement policy", () => {
    const cells = [
      { index: 0, position: { x: 20, z: 0 }, roadside: true, distanceFromResidentialMeters: 5 },
      { index: 1, position: { x: 80, z: 0 }, roadside: true, distanceFromResidentialMeters: 120 },
    ];
    expect(ZONING_LAYOUT_SKILL.rankCells(cells, { x: 0, z: 0 }, "commercial")[0].index).toBe(0);
    expect(ZONING_LAYOUT_SKILL.rankCells(cells, { x: 0, z: 0 }, "industrial")[0].index).toBe(1);
    expect(ZONING_LAYOUT_SKILL.rankCells(cells, { x: 0, z: 0 }, "residential")[0].index).toBe(0);
    expect(capabilitiesForGap("COMMERCIAL_ZONING")[0]?.capabilityId).toBe("ZONE_COMMERCIAL");
    expect(capabilitiesForGap("INDUSTRIAL_ZONING")[0]?.capabilityId).toBe("ZONE_INDUSTRIAL");
  });

  test("effect confirmation without goal progress is not meaningful progress", () => {
    expect(meaningfulProgress({ before: [true, false], after: [true, false] })).toBe(false);
    expect(meaningfulProgress({ before: [true, false], after: [true, true] })).toBe(true);
    expect(meaningfulProgress({ before: [true], after: [true], measureBefore: 5, measureAfter: 4 })).toBe(true);
  });

  test("later utility facts do not count as progress for an unsatisfied network reachability gap", () => {
    const facts = { facilityAvailable: true, facilityAccessible: true, physicalConnection: true,
      networkReachable: false, capacitySufficient: true, serviceDelivered: false, existingUsableCapacity: false, existingInfrastructureIncomplete: false, scopedConsumerCount: 1 };
    expect(utilityGapSatisfied("NETWORK_REACHABLE", facts)).toBe(false);
    expect(meaningfulProgress({ before: [false], after: [utilityGapSatisfied("NETWORK_REACHABLE", facts)] })).toBe(false);
    expect(meaningfulProgress({ before: [false], after: [utilityGapSatisfied("NETWORK_REACHABLE", { ...facts, networkReachable: true })] }))
      .toBe(true);
    expect(utilityActionMadeGapProgress("NETWORK_REACHABLE", { ...facts, networkReachable: true }, false)).toBe(false);
    expect(utilityActionMadeGapProgress("NETWORK_REACHABLE", { ...facts, networkReachable: true }, true)).toBe(true);
  });

  test("no meaningful progress advances to the next bounded utility strategy", () => {
    expect(nextUtilityStrategy("NETWORK_REACHABLE", [])).toBe("REUSE_REACHABLE_NETWORK");
    expect(nextUtilityStrategy("NETWORK_REACHABLE", [{ goalId: "e", gap: "NETWORK_REACHABLE",
      strategy: "REUSE_REACHABLE_NETWORK", planningEpoch: "epoch", noProgressCount: 1, exhausted: false,
      lastOutcome: "EFFECT_CONFIRMED" }])).toBe("REPAIR_MISSING_FLOW_PATH");
  });

  test("ledger planning epoch changes with branch and domain revision", () => {
    const base = { worldId: "w", checkpointId: "c", generation: "g", branchId: "b", domainRevision: 4 };
    expect(ledgerEpoch(base)).not.toBe(ledgerEpoch({ ...base, branchId: "other" }));
    expect(ledgerEpoch(base)).not.toBe(ledgerEpoch({ ...base, domainRevision: 5 }));
    expect(ledgerEpoch(base)).toContain("journal-proven-placement-claim/15");
  });

  test("project task scheduling is Brain-owned and does not fall back to insertion order", () => {
    const zoning = { id: "z", kind: "ZONING", status: "PENDING", legalStage: "ROAD_DELIVERED" } as const;
    const recovery = { id: "r", kind: "RECOVERY", status: "PENDING", legalStage: "ROAD_DELIVERED" } as const;
    expect(chooseGate1CapabilityTask("ROAD_DELIVERED", [recovery, zoning])?.id).toBe("z");
    expect(chooseGate1CapabilityTask("SITE_SELECTED", [recovery])).toBeNull();
  });
});

describe("Gameplay doctrine: the utility strategy admission compares before it places", () => {
  const noFacility = { facilityAvailable: false, facilityAccessible: false, physicalConnection: false,
    networkReachable: false, capacitySufficient: false, serviceDelivered: false,
    existingInfrastructureIncomplete: false, scopedConsumerCount: 1 };

  test("capacity that already serves removes the facility Gap instead of replacing it", () => {
    const served = deriveUtilityGap("e", "electricity", { ...noFacility, existingUsableCapacity: true });
    expect(served?.gap).toBe("SERVICE_DELIVERED");
    expect(served?.satisfiedPrerequisites).toEqual(["existingUsableCapacity"]);
  });

  test("a city with no usable capacity still derives the facility Gap", () => {
    expect(deriveUtilityGap("e", "electricity", { ...noFacility, existingUsableCapacity: false })?.gap)
      .toBe("FACILITY_AVAILABLE");
  });

  test("the outside connection is named, never offered", () => {
    const options = facilityGapOptions({ ...noFacility, existingUsableCapacity: false });
    expect(options.map((option) => option.tier)).toEqual([
      "existing-infrastructure-incomplete", "outside-connection", "local-generation",
    ]);
    expect(options.find((option) => option.tier === "outside-connection")).toMatchObject({ availability: "UNSUPPORTED" });
    expect(utilityStrategiesForGap("FACILITY_AVAILABLE", { ...noFacility, existingUsableCapacity: false }))
      .toEqual(["INITIAL_FACILITY_PLACEMENT"]);
  });

  test("an incomplete in-scope supply is reconnected before a new one is built", () => {
    const facts = { ...noFacility, facilityAvailable: true, facilityAccessible: false,
      existingUsableCapacity: false, existingInfrastructureIncomplete: true };
    expect(utilityStrategiesForGap("FACILITY_AVAILABLE", facts)[0]).toBe("RECONNECT_TARGET");
    expect(nextUtilityStrategy("FACILITY_AVAILABLE", [], facts)).toBe("RECONNECT_TARGET");
    // The placed-but-unconnected case, as utilityFactsFromEvidence derives it.
    const derived = utilityFactsFromEvidence({ evidence: null, facilityExists: true, facilityAccessible: false,
      physicalConnection: false, scopedConsumerCount: 1, existingUsableCapacity: false });
    expect(derived.existingInfrastructureIncomplete).toBe(true);
    expect(utilityStrategiesForGap("FACILITY_AVAILABLE", derived)[0]).toBe("RECONNECT_TARGET");
  });

  test("an unproven capacity read is never assumed to be usable capacity", () => {
    expect(utilityFactsFromEvidence({ evidence: null, facilityExists: false, facilityAccessible: false,
      physicalConnection: false }).existingUsableCapacity).toBe(false);
    expect(utilityFactsFromEvidence({ evidence: null, facilityExists: false, facilityAccessible: false,
      physicalConnection: false, existingUsableCapacity: true }).existingUsableCapacity).toBe(true);
  });
});

describe("Gate 1 task scheduling", () => {
  const task = (kind: string, id: string, status = "PENDING") => ({ kind, id, status } as never);

  /**
   * The measured live deadlock (2026-09-30). `UTILITY_PROVISION` held the
   * tranche's sticky current-task pointer and waited for a building to be
   * attributed to it; `ZONING` — the stage's first priority, and the only task
   * that can create such a building — sat at `attempts: 0`. 102 journaled
   * `UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING` entries, a tranche that
   * could neither advance nor close, and two live runs with zero mutations.
   */
  test("a waiting task never outranks the stage's building task", () => {
    const utility = task("UTILITY_PROVISION", "utility-1", "WAITING");
    const zoning = task("ZONING", "zoning-1");
    const chosen = chooseGate1CapabilityTask("ROAD_DELIVERED", [utility, zoning],
      { UTILITY_PROVISION: "utility-1" });
    expect(chosen?.id).toBe("zoning-1");
  });

  // A utility service Road child is a ROAD_CONNECTION running at ROAD_DELIVERED,
  // where the stage names only ZONING and UTILITY_PROVISION. It is work in
  // flight and must still be continued ahead of the stage's own order.
  test("a world-writing current task still continues ahead of the stage order", () => {
    const roadChild = task("ROAD_CONNECTION", "utility-road-1");
    const zoning = task("ZONING", "zoning-1");
    const chosen = chooseGate1CapabilityTask("ROAD_DELIVERED", [roadChild, zoning],
      { ROAD_CONNECTION: "utility-road-1" });
    expect(chosen?.id).toBe("utility-road-1");
  });

  test("falls back to the current task only when the stage names nothing eligible", () => {
    const waiting = task("WAIT_OBSERVE", "wait-1", "WAITING");
    expect(chooseGate1CapabilityTask("ROAD_DELIVERED", [waiting], { WAIT_OBSERVE: "wait-1" })?.id).toBe("wait-1");
    expect(chooseGate1CapabilityTask("ROAD_DELIVERED", [waiting], {})).toBeNull();
  });

  test("takes the stage's first eligible priority with no current task", () => {
    expect(chooseGate1CapabilityTask("ROAD_DELIVERED",
      [task("UTILITY_PROVISION", "utility-1"), task("ZONING", "zoning-1")], {})?.id).toBe("zoning-1");
  });
});
