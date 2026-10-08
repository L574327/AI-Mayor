import {
  absorbableCells, ABSORPTION_LOOKAHEAD_DAYS, batchConstraint, capitalAreaCap, capitalReserve, chooseResidentialDensity, DEVIATION_RESERVE, FinanceWatch,
  decideGrowthAfterSearch, FRAMES_PER_GAME_DAY, gameMonthKey, growthAdmission, growthDecaying, growthStage, LOW_DENSITY_QUOTA_SHARE, netGrowthPerDay, NEGATIVE_MONTHS_FREEZE,
  SMALLEST_DISTRICT_SQUARE_METERS, type DensityState, type ResidentialDensityKey,
} from "../../src/main/services/ai-mayor/v2/growth-policy";
import { immediateWithoutAnswer, notificationTier, triageNotifications } from "../../src/main/services/ai-mayor/v2/notification-tiers";
import { decideLoan, GROWTH_BORROW_SHARE, loanTier, type LoanReading } from "../../src/main/services/ai-mayor/v2/loan-policy";
import { classifyBottleneck, neededLandUses, plausibleLaborReading } from "../../src/main/services/ai-mayor/v2/growth-bottleneck";
import { districtUtilityShortfall, rankPowerSources, type PowerAsset } from "../../src/main/services/ai-mayor/v2/district-utilities";
import { landPurchaseAffordable, marginalTileUpkeep } from "../../src/main/services/ai-mayor/v2/solvency";
import { emptyMix, type ZoningMixSignals } from "../../src/main/services/ai-mayor/v2/zoning-mix";
import { DistrictBuilder, UNFILLED_STOCK_CELL_LIMIT, UNFILLED_STOCK_ESCAPE_CYCLES, type DistrictBuilderPort, type ProgressReading } from "../../src/main/services/ai-mayor/v2/district-builder";

const state = (unlocked: boolean, vacancyShare: number | null, demand: number | null): DensityState => ({ unlocked, vacancyShare, demand });
const ladder = (low: DensityState, medium: DensityState, high: DensityState): Record<ResidentialDensityKey, DensityState> => ({ low, medium, high });

describe("V2 P1: the stage follows the milestone, not the population", () => {
  const base = { population: 12_000, densities: { low: true, medium: true, high: false }, officeUnlocked: false };
  test("the milestone decides when the game reports it", () => {
    expect(growthStage({ ...base, milestone: 1 }).stage).toBe("S0");
    expect(growthStage({ ...base, milestone: 2 }).stage).toBe("S1");
    expect(growthStage({ ...base, milestone: 4 }).stage).toBe("S2");
    expect(growthStage({ ...base, milestone: 8 }).stage).toBe("S3");
    expect(growthStage({ ...base, milestone: 8, population: 60_000 }).stage).toBe("S4");
  });
  test("a 12k city is not S3 by size, and a small city at M8 is", () => {
    expect(growthStage({ ...base, milestone: 3, population: 90_000 }).stage).toBe("S1");
    expect(growthStage({ ...base, milestone: 8, population: 3_000 }).stage).toBe("S3");
  });
  test("without a milestone the stage is read from what the milestones unlocked", () => {
    expect(growthStage({ ...base, milestone: null, densities: { low: true, medium: false, high: false } }).stage).toBe("S0");
    expect(growthStage({ ...base, milestone: null }).stage).toBe("S1");
    expect(growthStage({ ...base, milestone: null, officeUnlocked: true })).toMatchObject({ stage: "S2", source: "unlocks" });
    expect(growthStage({ ...base, milestone: null, densities: { low: true, medium: true, high: true } }).stage).toBe("S3");
  });
});

describe("V2 P3: density by unlock and vacancy, low density on a quota", () => {
  test("the densest unlocked density is the default", () => {
    const choice = chooseResidentialDensity({ stage: "S3", lowDensityShareSoFar: null,
      densities: ladder(state(true, 0.05, 80), state(true, 0.1, 60), state(true, 0.1, 90)) });
    expect(choice.density).toBe("high");
  });
  test("a tall low-density bar never beats an open denser density", () => {
    const choice = chooseResidentialDensity({ stage: "S1", lowDensityShareSoFar: null,
      densities: ladder(state(true, 0.02, 100), state(true, 0.1, 30), state(false, null, null)) });
    expect(choice.density).toBe("medium");
  });
  test("a density that stands empty or has nil demand is left out, and low density is the case of a nearly full low density that is asked for", () => {
    // The live save (2026-10-04): medium 62% empty with demand 0, high locked, low 3.6% empty with demand 100.
    const live = chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: null,
      densities: ladder(state(true, 1_589 / 43_585, 100), state(true, 5_460 / 8_760, 0), state(false, null, null)) });
    expect(live.density).toBe("low");
    expect(live.reason).toMatch(/medium: 62% of its zoning stands empty/);
  });
  test("low density that is not nearly full, or not asked for, is not used to fill the gap (S1 and later)", () => {
    const stocked = chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: null,
      densities: ladder(state(true, 0.3, 100), state(true, 0.7, 0), state(false, null, null)) });
    expect(stocked.density).toBeNull();
    const quiet = chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: null,
      densities: ladder(state(true, 0.02, 10), state(true, 0.7, 0), state(false, null, null)) });
    expect(quiet.density).toBeNull();
    const unread = chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: null,
      densities: ladder(state(true, null, null), state(true, 0.7, 0), state(false, null, null)) });
    expect(unread.density).toBeNull();
  });
  test("the quota yields to low density once it has held the homes back for hours with nothing denser open (live 2026-10-06: 133 cycles of deadlock)", () => {
    const free = { low: { unlocked: true, vacancyShare: 0, demand: 40 }, medium: { unlocked: true, vacancyShare: 0, demand: 0 }, high: { unlocked: false, vacancyShare: null, demand: null } };
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.6, densities: free })).toMatchObject({ density: null, quotaBlocked: true });
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.6, densities: free, quotaYields: true })).toMatchObject({ density: "low", reason: expect.stringMatching(/quota yields/) });
    // It never yields while a denser density is open: that one is chosen first.
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.6, densities: { ...free, medium: { unlocked: true, vacancyShare: 0, demand: 20 } }, quotaYields: true })).toMatchObject({ density: "medium" });
  });

  test("the opening stage builds low density, and from S1 (medium rows open) low density is over quota once it holds its share of the residential zoning", () => {
    expect(chooseResidentialDensity({ stage: "S0", lowDensityShareSoFar: null,
      densities: ladder(state(true, 0.1, 50), state(false, null, null), state(false, null, null)) }).density).toBe("low");
    const free = ladder(state(true, 0.02, 100), state(true, 0.7, 0), state(true, 0.6, 0));
    // A low density the game asks for (bar at 100) is built over the quota when nothing denser is open (the player's ruling, 2026-10-08: live 2026-10-07 the
    // quota held the homes back for 286 cycles beside a full low-density bar).
    expect(chooseResidentialDensity({ stage: "S3", lowDensityShareSoFar: 0.1, densities: free }).density).toBe("low");
    expect(chooseResidentialDensity({ stage: "S3", lowDensityShareSoFar: LOW_DENSITY_QUOTA_SHARE, densities: free })).toMatchObject({ density: "low", reason: expect.stringMatching(/quota yields/) });
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.9, densities: free })).toMatchObject({ density: "low", reason: expect.stringMatching(/asks for low density/) });
    // Asked for only a little: the quota still holds from S1 on (live 2026-10-05: 90% of 4,324 homes were low density at 13,558 people), never in the opening S0.
    const mild = ladder(state(true, 0.02, 30), state(true, 0.7, 0), state(true, 0.6, 0));
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.9, densities: mild })).toMatchObject({ density: null, reason: expect.stringMatching(/quota/) });
    expect(chooseResidentialDensity({ stage: "S1", lowDensityShareSoFar: 0.9, densities: mild })).toMatchObject({ density: null, reason: expect.stringMatching(/quota/) });
    // Snowball: any demand at all is enough.
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.9, densities: mild, eager: true }).density).toBe("low");
    expect(chooseResidentialDensity({ stage: "S0", lowDensityShareSoFar: 0.9, densities: ladder(state(true, 0.1, 50), state(false, null, null), state(false, null, null)) }).density).toBe("low");
    expect(chooseResidentialDensity({ stage: "S2", lowDensityShareSoFar: 0.1, densities: free }).density).toBe("low");
  });
});

describe("V2 P2: the batch is the smaller of the cash cap and the absorption cap", () => {
  const series = (perDay: number, days = 4, start = 10_000) => {
    const frames: number[] = []; const values: number[] = [];
    for (let index = 0; index <= days * 8; index += 1) { frames.push(index * (FRAMES_PER_GAME_DAY / 8)); values.push(start + (perDay * index) / 8); }
    return { frames, values };
  };
  test("net growth per game day is the current flow, read from the frames, and too short a span is no reading", () => {
    expect(netGrowthPerDay(series(25))).toBeCloseTo(25, 5);
    expect(netGrowthPerDay({ frames: [0, 1000], values: [1, 2] })).toBeNull();
    expect(netGrowthPerDay({ frames: [0, 1000, 2000], values: [1, 2, 3] })).toBeNull();
    expect(netGrowthPerDay(null)).toBeNull();
  });
  // The population of the live save (2026-10-04), every fourth sample of the 128 the Bridge returned: 5.7k -> 10.76k in four days, flat at the end.
  const LIVE_POPULATION = [5701, 5970, 6279, 6598, 6953, 7267, 7354, 7548, 7737, 7914, 8065, 8207, 8375, 8550, 8684, 8800, 9003, 9131, 9254, 9471, 9695, 9858, 9982, 10088,
    10204, 10332, 10387, 10467, 10599, 10638, 10689, 10730, 10746];
  const liveSeries = { frames: LIVE_POPULATION.map((_, index) => Math.round((index * 3.97 * FRAMES_PER_GAME_DAY) / (LIVE_POPULATION.length - 1))), values: LIVE_POPULATION };
  test("the current flow, not the four-day average: a city that grew fast and has flattened is not priced at its past", () => {
    const current = netGrowthPerDay(liveSeries)!;
    const overall = (LIVE_POPULATION.at(-1)! - LIVE_POPULATION[0]!) / 3.97;
    expect(overall).toBeGreaterThan(1_200);
    expect(current).toBeLessThan(overall * 0.4);
    expect(current).toBeGreaterThan(0);
    expect(growthDecaying(liveSeries)).toBe(true);
  });
  test("growth that is falling away is detected, steady growth is not", () => {
    expect(growthDecaying(series(25))).toBe(false);
    expect(growthDecaying({ frames: [0], values: [1] })).toBeNull();
    expect(growthDecaying(series(0))).toBeNull();
  });
  test("cells the city can take up = rate x window / people per built cell - what already stands empty", () => {
    const result = absorbableCells({ growthPerDay: 200, population: 10_000, builtResidentialCells: 5_000, emptyCellsOfDensity: 100, zonedCellsOfDensity: 2_000, demand: 50 });
    // 200 x 3 / (10000/5000 = 2 people per cell) = 300 cells, minus 100 empty.
    expect(result.cells).toBe(200);
    expect(ABSORPTION_LOOKAHEAD_DAYS).toBe(3);
  });
  test("a density with more empty cells than the city can fill in the window gets nothing", () => {
    expect(absorbableCells({ growthPerDay: 50, population: 10_000, builtResidentialCells: 5_000, emptyCellsOfDensity: 5_460, zonedCellsOfDensity: 8_760, demand: 0 }).cells).toBe(0);
  });
  test("a full city cannot show a rate above its supply: one smallest district is allowed while the game still asks for homes", () => {
    const full = absorbableCells({ growthPerDay: 0, population: 10_000, builtResidentialCells: 5_000, emptyCellsOfDensity: 0, zonedCellsOfDensity: 5_000, demand: 80 });
    expect(full.cells).toBe(SMALLEST_DISTRICT_SQUARE_METERS / 64);
    expect(absorbableCells({ growthPerDay: 0, population: 10_000, builtResidentialCells: 5_000, emptyCellsOfDensity: 0, zonedCellsOfDensity: 5_000, demand: 0 }).cells).toBe(0);
  });
  test("no readable rate is no cap, and says so", () => {
    expect(absorbableCells({ growthPerDay: null, population: 10_000, builtResidentialCells: 5_000, emptyCellsOfDensity: 0, zonedCellsOfDensity: 0, demand: 10 }))
      .toMatchObject({ cells: null, detail: expect.stringMatching(/no readable/) });
  });
  test("the batch is whichever limit is smaller, and the decision records which one binds", () => {
    const capital = capitalAreaCap({ treasury: 400_000, monthlyBalance: 90_000, monthlyMaintenance: 800_000 });
    expect(batchConstraint({ capitalArea: capital, absorptionCells: 50 })).toMatchObject({ binding: "absorption" });
    expect(batchConstraint({ capitalArea: capital, absorptionCells: 1_000_000 })).toMatchObject({ binding: "capital", limit: capital });
    expect(batchConstraint({ capitalArea: capital, absorptionCells: null })).toMatchObject({ binding: "capital", absorptionArea: null });
    expect(batchConstraint({ capitalArea: 1_000_000, absorptionCells: 0 }).limit).toBe(0);
  });
  test("the cash cap leaves the reserve (never below the study's) and counts a month of the surplus", () => {
    expect(capitalReserve(null)).toBe(DEVIATION_RESERVE);
    expect(capitalReserve(10_000_000)).toBeGreaterThan(DEVIATION_RESERVE);
    expect(capitalAreaCap({ treasury: 100_000, monthlyBalance: 0, monthlyMaintenance: null })).toBe(0);
    expect(capitalAreaCap({ treasury: 100_000, monthlyBalance: 60_000, monthlyMaintenance: null })).toBeGreaterThan(0);
    expect(capitalAreaCap({ treasury: 100_000, monthlyBalance: -60_000, monthlyMaintenance: null })).toBe(0);
  });
});

describe("V2 P5: land follows the batch realization report", () => {
  const evidence = { targetAreaSquareMeters: 200_000, deliveredAreaSquareMeters: 0,
    geometricCandidateAreaSquareMeters: 1_740_000, searchComplete: true, unreadSites: 0, rejectedSites: 2 };
  test("raw free area cannot overrule complete evidence that no site can be realized", () => {
    expect(decideGrowthAfterSearch(evidence).action).toBe("BUY_LAND");
  });
  test("incomplete search and incomplete readback cannot authorize a land purchase", () => {
    expect(decideGrowthAfterSearch({ ...evidence, searchComplete: false }).action).toBe("REPLAN");
    expect(decideGrowthAfterSearch({ ...evidence, unreadSites: 1 }).action).toBe("SAFETY_WAIT");
  });
  test("no remaining batch is no reason to buy land", () => {
    expect(decideGrowthAfterSearch({ ...evidence, deliveredAreaSquareMeters: 200_000 }).action).toBe("WAIT_FOR_NEXT_BATCH");
    expect(decideGrowthAfterSearch({ ...evidence, deliveredAreaSquareMeters: 174_400 }).reason).toMatch(/25600 m2 remains/);
    expect(growthAdmission({ population: 100_000, targetPopulation: 100_000, utilityReadComplete: true }).reason).toBe("TARGET_REACHED");
  });
  test("what the last tile really added is the marginal cost, and it can only raise the estimate", () => {
    const average = marginalTileUpkeep({ ownedTiles: 19, tileUpkeep: 200_000 });
    expect(marginalTileUpkeep({ ownedTiles: 19, tileUpkeep: 200_000, observedMarginalUpkeep: 40_000 })).toBeGreaterThan(average);
    expect(marginalTileUpkeep({ ownedTiles: 19, tileUpkeep: 200_000, observedMarginalUpkeep: 1 })).toBe(average);
    const surplus = 30_000;
    expect(landPurchaseAffordable({ treasury: 500_000, monthlyBalance: surplus, ownedTiles: 19, tileUpkeep: 190_000 })).toBe(true);
    expect(landPurchaseAffordable({ treasury: 500_000, monthlyBalance: surplus, ownedTiles: 19, tileUpkeep: 190_000, observedMarginalUpkeep: 40_000 })).toBe(false);
  });
});

describe("V2 P8: the finance constraint and the borrowing tiers", () => {
  test("growth freezes after K negative months in a row, and one good month ends it", () => {
    const watch = new FinanceWatch();
    for (const [month, balance] of [["2027-01", -5], ["2027-02", -5], ["2027-03", 10]] as const) watch.observe(month, balance);
    expect(watch.frozen).toBe(false);
    for (let index = 0; index < NEGATIVE_MONTHS_FREEZE; index += 1) watch.observe(`2027-0${4 + index}`, -1);
    expect(watch.frozen).toBe(true);
    watch.observe("2027-07", 1);
    expect(watch.frozen).toBe(false);
  });
  test("several readings in one game month are one month", () => {
    const watch = new FinanceWatch();
    for (let index = 0; index < 10; index += 1) watch.observe("2027-01", -1);
    expect(watch.negativeStreak).toBe(1);
    expect(gameMonthKey("2027-01-02 12:30")).toBe("2027-01");
    expect(gameMonthKey(null)).toBeNull();
  });
  const loan = (amount: number, creditworthiness = 1_000_000): LoanReading => ({ amount, dailyInterestRate: 0, dailyPayment: 0, creditworthiness });
  const ask = { treasury: 60_000, monthlyBalance: 80_000, bottleneck: "HOUSING" as const, absorbing: true, cycle: 10, blockedUntilCycle: 0 };
  test("the borrowed share of the credit line picks the tier", () => {
    expect(loanTier(0, 1_000_000)).toBe("GROWTH");
    expect(loanTier(299_999, 1_000_000)).toBe("GROWTH");
    expect(loanTier(300_000, 1_000_000)).toBe("REPAIR_ONLY");
    expect(loanTier(700_000, 1_000_000)).toBe("REPAIR_ONLY");
    expect(loanTier(700_001, 1_000_000)).toBe("CUT_SPENDING");
    expect(loanTier(0, 0)).toBe("CUT_SPENDING");
  });
  test("a growth loan is taken below the growth tier, and never past it", () => {
    expect(decideLoan({ ...ask, loan: loan(0) }).action).toBe("BORROW");
    const borrow = decideLoan({ ...ask, loan: loan(100_000) });
    expect(borrow.action === "BORROW" && borrow.amount <= 1_000_000 * GROWTH_BORROW_SHARE - 100_000).toBe(true);
    expect(decideLoan({ ...ask, loan: loan(350_000) })).toMatchObject({ action: "NONE", reason: expect.stringMatching(/repairs only/) });
  });
  test("above the top tier the Mayor repays what the treasury allows and cuts outward spending", () => {
    expect(decideLoan({ ...ask, treasury: 600_000, loan: loan(800_000) })).toMatchObject({ action: "REPAY", cutSpending: true });
    expect(decideLoan({ ...ask, treasury: 20_000, loan: loan(800_000) })).toMatchObject({ action: "NONE", cutSpending: true });
  });
  test("cash is only borrowed when cash is what limits the batch", () => {
    expect(decideLoan({ ...ask, loan: loan(0), capitalBound: false })).toMatchObject({ action: "NONE", reason: expect.stringMatching(/take up/) });
    expect(decideLoan({ ...ask, loan: loan(0), capitalBound: true }).action).toBe("BORROW");
  });
});

describe("V2 P7: notifications in three tiers", () => {
  test("the live icon names land in the tiers the candidate gives them", () => {
    for (const type of ["Electricity Notification", "Water Notification", "Sewage Notification", "No Road Access", "Garbage Notification", "Ambulance Notification",
      "Burned Down", "Condemned", "Water Destroyed", "Powerline Not Connected", "Powerline Not Connected - Low"]) expect(notificationTier(type)).toBe("IMMEDIATE");
    for (const type of ["MissingEducatedWorkers", "MissingUneducatedWorkers", "Noise Pollution"]) expect(notificationTier(type)).toBe("DEFERRED");
    for (const type of ["No Customers", "Leveling Building"]) expect(notificationTier(type)).toBe("NO_REACTION");
    expect(notificationTier("Traffic Bottleneck Notification")).toBe("READ_FIRST");
    expect(notificationTier("Some New Icon")).toBe("UNCLASSIFIED");
  });
  test("triage counts every tier and reports the immediate types with no local answer", () => {
    const triage = triageNotifications({ counts: { "Noise Pollution": 68, "Leveling Building": 22, "Water Destroyed": 9, "Hearse Notification": 4, "No Road Access": 5, "Garbage Notification": 7,
      "Traffic Bottleneck Notification": 6, "No Customers": 3, "Mystery": 2, Zero: 0 } });
    expect(triage.totals).toMatchObject({ IMMEDIATE: 25, DEFERRED: 68, NO_REACTION: 25, READ_FIRST: 6, UNCLASSIFIED: 2 });
    const gaps = immediateWithoutAnswer(triage).map((entry) => entry.type);
    // A type with no local answer is a reported gap; "No Road Access" has one (a road from where the game puts the notice to the nearest street), and since
    // 2026-10-07 garbage has one too (a landfill, essential when icons pile up). An immediate type nothing answers still shows as a gap.
    expect(gaps).not.toContain("Garbage Notification");
    expect(immediateWithoutAnswer(triageNotifications({ counts: { "Transformer Overload": 3 } })).map((entry) => entry.type)).toContain("Transformer Overload");
    expect(gaps).not.toContain("No Road Access");
    expect(gaps).not.toContain("Hearse Notification");
    expect(gaps).not.toContain("Water Destroyed");
  });
});

describe("V2 P4: jobs and housing without an unemployment target, and no office demand bar", () => {
  test("jobs wait for residents whenever open jobs are a healthy margin and cover the unemployed — not only below a near-zero unemployment", () => {
    expect(classifyBottleneck({ employed: 9_000, unemploymentRate: 0.08, jobsTotal: 10_000, jobsFree: 1_000 }).bottleneck).toBe("HOUSING");
    expect(classifyBottleneck({ employed: 9_000, unemploymentRate: 0.1, jobsTotal: 10_000, jobsFree: 1_200 }).bottleneck).toBe("HOUSING");
  });
  test("fewer open jobs than people out of work is a jobs problem even at moderate unemployment", () => {
    expect(classifyBottleneck({ employed: 9_000, unemploymentRate: 0.08, jobsTotal: 9_100, jobsFree: 100 }).bottleneck).toBe("JOBS");
  });
  test("open jobs beside high unemployment is a skills/reach mismatch, more of the same fixes nothing", () => {
    expect(classifyBottleneck({ employed: 5_000, unemploymentRate: 0.2, jobsTotal: 8_000, jobsFree: 3_000 }).bottleneck).toBe("MATCH");
  });
  test("no jobs at all margin and no unemployed: nothing is decided by labour alone", () => {
    expect(classifyBottleneck({ employed: 9_000, unemploymentRate: 0.01, jobsTotal: 9_000, jobsFree: 5 }).bottleneck).toBe("NONE");
  });
  test("homes that are not being asked for, with people out of work, turn the bottleneck to jobs", () => {
    expect(classifyBottleneck({ employed: 9_000, unemploymentRate: 0.02, jobsTotal: 9_050, jobsFree: 5 }, 0).bottleneck).toBe("JOBS");
  });
  test("a labour reading that contradicts the city's head count is not believed", () => {
    // Live 2026-10-04: rate 0.85 beside 6,206 employed in a city of 10,765 would be a workforce of 40,000.
    expect(plausibleLaborReading({ employed: 6_206, unemploymentRate: 0.8468, jobsTotal: 6_775, jobsFree: 527 }, 10_765)).toBe(false);
    expect(plausibleLaborReading({ employed: 6_206, unemploymentRate: 0.01, jobsTotal: 6_775, jobsFree: 527 }, 10_765)).toBe(true);
    expect(plausibleLaborReading({ employed: 6_206, unemploymentRate: 85, jobsTotal: 6_775, jobsFree: 527 }, 10_765)).toBe(false);
    // Without a head count nothing can be disproved; a rate of nil or total is judged on its own.
    expect(plausibleLaborReading({ employed: 6_206, unemploymentRate: 0.8468, jobsTotal: 1, jobsFree: 1 }, null)).toBe(true);
    expect(plausibleLaborReading({ employed: 6_206, unemploymentRate: 0, jobsTotal: 1, jobsFree: 1 }, 10_765)).toBe(true);
  });
  test("a tall office demand bar adds no office supply; jobs do, from S2", () => {
    const demand = { residential: 0, commercial: 0, industrial: 0, office: 100 };
    const all = ["residential", "commercial", "office", "industrial"] as const;
    expect(neededLandUses("NONE", demand, all)).toEqual([]);
    expect(neededLandUses("JOBS", demand, all, "S1")).not.toContain("office");
    expect(neededLandUses("JOBS", demand, all, "S2")).toContain("office");
  });
});

describe("V2 P7: capacity keeps a margin over the peak, and every generator is a candidate", () => {
  const reading = { headroom: 30_000, consumption: 200_000 };
  test("with a margin the shortfall includes it; without one the bare load decides", () => {
    expect(districtUtilityShortfall(reading, 25_000)).toBe(0);
    // capacity 230k must stand >= (200k + 25k) x 1.25 = 281,250: 51,250 short (25k load + a 56,250 margin, less the 30k spare).
    expect(districtUtilityShortfall(reading, 25_000, 1.25)).toBeCloseTo(51_250, 0);
    expect(districtUtilityShortfall({ headroom: null, consumption: 1 }, 25_000, 1.25)).toBe(0);
  });
  const assets: PowerAsset[] = [
    { prefab: "WindTurbine01", locked: false, production: 60_000, constructionCost: 25_000, needsFuel: false },
    { prefab: "WindTurbine03", locked: false, production: 20_000, constructionCost: 8_500, needsFuel: false },
    { prefab: "SmallCoalPowerPlant01", locked: false, production: 200_000, constructionCost: 100_000, needsFuel: true },
    { prefab: "CoalPowerPlant01", locked: true, production: 3_000_000, constructionCost: 1_000_000, needsFuel: true },
    { prefab: "HydroelectricPowerPlant01", locked: false, production: 0, constructionCost: 1_575_000, needsFuel: false },
    { prefab: "SolarPowerStation01 Backup Battery", locked: false, production: 0, constructionCost: 1, needsFuel: false },
    { prefab: "GasPowerPlant01 Fuel Storage Extension", locked: false, production: 0, constructionCost: 1, needsFuel: false },
  ];
  test("locked sources and add-ons are not offered, an unrankable source is kept last, not dropped", () => {
    const names = rankPowerSources(assets).map((asset) => asset.prefab);
    expect(names).not.toContain("CoalPowerPlant01");
    expect(names).not.toContain("SolarPowerStation01 Backup Battery");
    expect(names).not.toContain("GasPowerPlant01 Fuel Storage Extension");
    expect(names.at(-1)).toBe("HydroelectricPowerPlant01");
  });
  test("by nameplate wind ranks first; at what the wind really gives (0.79 measured) the small coal plant is the better answer", () => {
    expect(rankPowerSources(assets)[0]!.prefab).toBe("WindTurbine01");
    expect(rankPowerSources(assets, { windCapacityFactor: 0.79 })[0]!.prefab).toBe("SmallCoalPowerPlant01");
  });
  test("a source that covers the shortage in one placement comes before any that cannot (live: a 20k turbine against a 69k shortage)", () => {
    // Wind at 0.85 of nameplate: 01 gives 51k, 03 17k — neither covers 69k; the small coal plant's 200k does.
    const names = rankPowerSources(assets, { windCapacityFactor: 0.85, neededOutput: 69_000 }).map((asset) => asset.prefab);
    expect(names.slice(0, 3)).toEqual(["SmallCoalPowerPlant01", "WindTurbine01", "WindTurbine03"]);
    expect(names.at(-1)).toBe("HydroelectricPowerPlant01");
    // A small need goes to the cheapest per output, which is wind.
    expect(rankPowerSources(assets, { windCapacityFactor: 0.85, neededOutput: 10_000 })[0]!.prefab).toBe("WindTurbine01");
    // No need named: the order is by cost per output alone.
    expect(rankPowerSources(assets, { windCapacityFactor: 0.85 })[0]!.prefab).toBe("WindTurbine01");
  });
  test("a source shown not to deliver is not offered first again", () => {
    expect(rankPowerSources(assets, { windCapacityFactor: 0.79, undelivering: new Set(["SmallCoalPowerPlant01"]) })[0]!.prefab).not.toBe("SmallCoalPowerPlant01");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The builder, end to end on a fake world.

let nextId = 1;
const node = (x: number, z: number) => ({ entity: { index: nextId++, version: 1 }, position: { x, y: 0, z }, native: false, outsideConnection: false, roadDegree: 2 });
type TestNode = ReturnType<typeof node>;
const edge = (a: TestNode, b: TestNode) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
  startNode: a.entity, endNode: b.entity, start: { x: a.position.x, y: 0, z: a.position.z }, end: { x: b.position.x, y: 0, z: b.position.z } });
function servedWorld(tileBounds = { min: { x: -100, z: -100 }, max: { x: 1100, z: 900 } }) {
  const nodes: TestNode[] = []; const edges: ReturnType<typeof edge>[] = [];
  for (let index = 0; index <= 22; index += 1) nodes.push(node(2.5 + index * 40, -62.5));
  for (let index = 0; index < 22; index += 1) edges.push(edge(nodes[index]!, nodes[index + 1]!));
  const tile = { entity: { index: 1, version: 1 }, owned: true, bounds: tileBounds, center: { x: 500, z: 400 },
    polygon: [tileBounds.min, { x: tileBounds.max.x, z: tileBounds.min.z }, tileBounds.max, { x: tileBounds.min.x, z: tileBounds.max.z }] };
  return { roadGraph: { nodes, edges }, ownedTiles: [tile] } as never;
}
const dry = { resolution: 2, bounds: { minX: -9000, minZ: -9000, maxX: 9000, maxZ: 9000 }, cellSize: { x: 9000, z: 9000 }, heights: [0, 0, 0, 0],
  waterDepths: [0, 0, 0, 0], groundWater: [], groundWaterPollution: [], windSpeed: [] };

function mixWith(byDensity: ZoningMixSignals["residentialByDensity"]): ZoningMixSignals {
  const mix = emptyMix();
  if (byDensity) {
    mix.residentialByDensity = byDensity;
    mix.cells.residential = { zoned: Object.values(byDensity).reduce((sum, row) => sum + row.zoned, 0), empty: Object.values(byDensity).reduce((sum, row) => sum + row.empty, 0) };
  }
  mix.demand = { residential: 100, commercial: 0, office: 0, industrial: 0 };
  return mix;
}
const growingSeries = (perDay: number) => {
  const frames: number[] = []; const values: number[] = [];
  for (let index = 0; index <= 32; index += 1) { frames.push(index * (FRAMES_PER_GAME_DAY / 8)); values.push(10_000 + (perDay * index) / 8); }
  return { frames, values };
};

function harness(options: { mix: ZoningMixSignals; progress?: () => ProgressReading; series?: ReturnType<typeof growingSeries> | null; world?: unknown; refuseRoads?: boolean;
  purchase?: string[]; zones?: string[]; roads?: string[];
  /** Buildings that exist in the world but that the city-wide list does not show (the Bridge lists the first 500 of thousands). */
  hiddenBuildings?: Array<{ x: number; z: number }>; noTerrain?: boolean; zoneCalls?: Array<{ zone: string; x: number; z: number; radius: number }> }) {
  // A street the world accepted stands in the next read of the world (the builder reads each street back before laying the next on it).
  const standing: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
  const port: DistrictBuilderPort = {
    scanWorld: async () => (options.world ?? servedWorld()) as never,
    listBuildings: async () => [],
    siteDetail: async (center, radius) => ({ center, radius: 1, terrain: options.noTerrain ? undefined : dry, zoningCells: [],
      buildings: (options.hiddenBuildings ?? []).filter((point) => Math.hypot(point.x - center.x, point.z - center.z) <= radius).map((point, index) => ({
        entity: { index: 900_000 + index, version: 1 }, prefab: "EU_ResidentialLow01_L1_3x4", native: false, position: { x: point.x, y: 0, z: point.z },
        rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: { size: { x: 20, y: 8, z: 20 }, bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 8, z: 10 } } } })),
      roadGraph: { nodes: [], edges: standing.map((course) => ({ entity: { index: nextId++, version: 1 }, prefab: "Medium Road", native: false,
        startNode: { index: nextId++, version: 1 }, endNode: { index: nextId++, version: 1 },
        start: { x: course.start.x, y: 0, z: course.start.z }, end: { x: course.end.x, y: 0, z: course.end.z } })) } }) as never,
    buildRoad: async (course) => {
      options.roads?.push(`${course.start.x},${course.start.z}`);
      if (options.refuseRoads) return { ok: false, detail: "refused" };
      standing.push({ start: course.start, end: course.end });
      return { ok: true, detail: "ok" };
    },
    zone: async (zone, center, radius) => { options.zones?.push(zone); options.zoneCalls?.push({ zone, x: center.x, z: center.z, radius }); return { ok: true, detail: "ok" }; },
    readZoningMix: async () => options.mix,
    readProgress: async () => (options.progress ? options.progress() : { milestone: 4, xp: 100, nextMilestoneXp: 500, gameDateTime: "2027-01-02 12:30" }),
    readPopulationSeries: async () => (options.series === undefined ? growingSeries(40) : options.series),
    readLandCosts: async () => ({ tileUpkeep: 0, monthlyExpenses: 500_000 }),
    ...(options.purchase ? { purchaseTile: async (point: { x: number; z: number }) => { options.purchase!.push(`${point.x},${point.z}`); return { ok: true, detail: "purchased" }; } } : {}),
  };
  return port;
}
const cycleInput = (overrides: Record<string, unknown> = {}) => ({
  demand: { residential: 80, commercial: 0, industrial: 0 },
  zoneFor: (category: string, density?: string) => `${category}:${density ?? "default"}`,
  pipelined: true, population: 10_000, mayPurchaseLand: true,
  finance: { treasury: 400_000, monthlyBalance: 100_000 },
  unlocked: { densities: { low: true, medium: true, high: false }, office: true },
  ...overrides,
}) as never;
const byDensity = (low: [number, number, number | null], medium: [number, number, number | null], high: [number, number, number | null] = [0, 0, null]) => ({
  low: { zoned: low[0], empty: low[1], demand: low[2] }, medium: { zoned: medium[0], empty: medium[1], demand: medium[2] }, high: { zoned: high[0], empty: high[1], demand: high[2] } });

describe("V2 in the district builder", () => {
  test("homes are laid at the densest open density: medium when it is open, and the notes say why", async () => {
    const zones: string[] = [];
    const result = await new DistrictBuilder(harness({ zones, series: growingSeries(200), mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    expect(result.status).toBe("BUILT");
    expect(zones.some((zone) => zone === "residential:MEDIUM")).toBe(true);
    expect(zones.some((zone) => zone === "residential:LOW")).toBe(false);
    expect(result.notes.join(" | ")).toMatch(/stage S2 \(milestone 4\)/);
    expect(result.notes.join(" | ")).toMatch(/density: medium/);
    expect(result.notes.join(" | ")).toMatch(/batch: capital .* -> (capital|absorption)-bound/);
  });

  test("an unavailable chosen density blocks before roads instead of silently zoning a default", async () => {
    const roads: string[] = [];
    const zones: string[] = [];
    const result = await new DistrictBuilder(harness({ roads, zones, series: growingSeries(200),
      mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ zoneFor: (category: string, density?: string) => density === "MEDIUM" ? null : `${category}:default` }));
    expect(result.outcome).toBe("REPLAN_REQUIRED");
    expect(result.feasibility).toEqual({ reason: "DENSITY_UNAVAILABLE", density: "MEDIUM", role: "residential" });
    expect(roads).toHaveLength(0);
    expect(zones).toHaveLength(0);
  });

  test("the live save: medium stands 62% empty with nil demand and low density already holds 75% of the zoning: the game still asks for low density, so it is laid (the quota yields; the city does not wait for medium)", async () => {
    const zones: string[] = [];
    const result = await new DistrictBuilder(harness({ zones, mix: mixWith(byDensity([43_585, 1_589, 100], [14_512, 10_059, 0])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    expect(zones.some((zone) => zone === "residential:LOW")).toBe(true);
    expect(zones.some((zone) => zone === "residential:MEDIUM")).toBe(false);
    expect(result.notes.join(" | ")).toMatch(/quota yields/);
    // Asked for only a little (bar at 30): the quota still holds and the city waits for medium to fill.
    const mild: string[] = [];
    const held = await new DistrictBuilder(harness({ zones: mild, mix: mixWith(byDensity([43_585, 1_589, 30], [14_512, 10_059, 0])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    expect(mild.some((zone) => zone === "residential:LOW")).toBe(false);
    expect(held.notes.join(" | ")).toMatch(/quota/);
    // Snowball (the player's mode switch): any demand builds, and the batch is what the cash pays for, not a seed.
    const before = process.env.AI_MAYOR_GROWTH_STYLE;
    process.env.AI_MAYOR_GROWTH_STYLE = "SNOWBALL";
    try {
      const eager: string[] = [];
      const snow = await new DistrictBuilder(harness({ zones: eager, mix: mixWith(byDensity([43_585, 1_589, 30], [14_512, 10_059, 0])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
      expect(eager.some((zone) => zone === "residential:LOW")).toBe(true);
      expect(snow.notes.join(" | ")).not.toMatch(/seed batch/);
    } finally { if (before === undefined) delete process.env.AI_MAYOR_GROWTH_STYLE; else process.env.AI_MAYOR_GROWTH_STYLE = before; }
    // A city whose low density is small (10% of the zoning) and nearly full, with medium 30% empty, still gets its low density.
    const small: string[] = [];
    await new DistrictBuilder(harness({ zones: small, mix: mixWith(byDensity([1_000, 20, 100], [3_000, 900, 0], [6_000, 0, 0])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    expect(small.some((zone) => zone === "residential:LOW")).toBe(true);
  });

  test("a city that cannot take up more homes lays no residential district and spends nothing on it", async () => {
    const roads: string[] = [];
    // Growth 1 person a day; 2,000 medium cells (20%: below the vacancy exclusion) already stand empty, far more than the city fills in the window.
    const result = await new DistrictBuilder(harness({ roads, series: growingSeries(1), mix: mixWith(byDensity([1_000, 20, 0], [10_000, 2_000, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ unlocked: { densities: { low: false, medium: true, high: false }, office: true } }));
    expect(result.status).toBe("NO_SITE");
    expect(roads).toHaveLength(0);
    expect(result.notes.join(" | ")).toMatch(/absorption \(medium\)/);
    expect(result.notes.join(" | ")).toMatch(/residential district is held/);
  });

  test("a rate that cannot be read does not cap the batch, and the notes say so", async () => {
    const result = await new DistrictBuilder(harness({ series: null, mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
    expect(result.status).toBe("BUILT");
    expect(result.notes.join(" | ")).toMatch(/the batch is not capped by absorption/);
  });

  test("a city of a few people with a seed batch of homes already standing empty lays no further residential district; it goes on after the wait (live 2026-10-05: 12 districts at 0 people)", async () => {
    const roads: string[] = [];
    const empty = byDensity([40_000, UNFILLED_STOCK_CELL_LIMIT + 100, 30], [0, 0, null]);
    const builder = new DistrictBuilder(harness({ roads, series: null, mix: mixWith(empty) }), { maximumSitesPerCycle: 1 });
    const zones: string[] = [];
    const first = await new DistrictBuilder(harness({ roads, zones, series: null, mix: mixWith(empty) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ population: 20 }));
    expect(first.notes.join(" | ")).toMatch(/unfilled stock: \d+ zoned homes stand empty .* other uses go on/);
    // Residential is held out of the role choice, so the city does not stand still: another use is laid, and no home is zoned.
    expect(first.notes.join(" | ")).not.toMatch(/policy chose residential/);
    expect(zones.some((zone) => zone.startsWith("residential"))).toBe(false);
    let released = false;
    for (let cycle = 0; cycle < UNFILLED_STOCK_ESCAPE_CYCLES + 2 && !released; cycle += 1) {
      const next = await builder.runCycle(cycleInput({ population: 20 }));
      released = /one more residential district is laid/.test(next.notes.join(" | "));
    }
    expect(released).toBe(true);
  });

  test("control: the same stock in a city of real size, or a small stock in a small city, is not held", async () => {
    const stocked = byDensity([40_000, UNFILLED_STOCK_CELL_LIMIT + 100, 30], [0, 0, null]);
    const big = await new DistrictBuilder(harness({ series: null, mix: mixWith(stocked) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ population: 10_000 }));
    expect(big.notes.join(" | ")).not.toMatch(/unfilled stock/);
    const small = await new DistrictBuilder(harness({ series: null, mix: mixWith(byDensity([40_000, 100, 30], [0, 0, null])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ population: 20 }));
    expect(small.notes.join(" | ")).not.toMatch(/unfilled stock/);
  });

  test("a batch with room for more than one district sends the next one at once, at the same density", async () => {
    const zones: string[] = [];
    // The owned ground holds one 560 x 400 district at a time; the batch (about 630,000 m2) holds several.
    const result = await new DistrictBuilder(harness({ zones, series: growingSeries(420), world: servedWorld({ min: { x: -100, z: -100 }, max: { x: 700, z: 500 } }),
      mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 3_000_000, monthlyBalance: 100_000 } }));
    expect(result.status).toBe("BUILT");
    expect(result.notes.join(" | ")).toMatch(/district 2 of the same batch/);
    expect(result.batch?.deliveredAreaSquareMeters).toBeGreaterThan(0);
    expect(result.batch?.targetAreaSquareMeters).toBeGreaterThan(result.batch?.deliveredAreaSquareMeters ?? 0);
    expect(result.batch?.remainingAreaSquareMeters).toBeGreaterThan(0);
    expect(zones.filter((zone) => zone === "residential:MEDIUM").length).toBeGreaterThan(1);
  });

  test("a batch the size of one template district is one district", async () => {
    // (220,000 - 150,000 reserve) x 0.8 / 0.3 = about 187,000 m2: one 400 x 400 template, and less than a district left over.
    const result = await new DistrictBuilder(harness({ series: growingSeries(200), mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 220_000, monthlyBalance: 0 } }));
    expect(result.status).toBe("BUILT");
    expect(result.notes.join(" | ")).not.toMatch(/district 2 of the same batch/);
  });

  test("the policy's own districts are template-sized: a batch for two is laid as two copies, not one big grid (the player's ruling, 2026-10-08)", async () => {
    const result = await new DistrictBuilder(harness({ series: growingSeries(200), mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 260_000, monthlyBalance: 0 } }));
    const sizes = [...result.notes.join(" | ").matchAll(/district \([-\d.]+,[-\d.]+\) (\d+)x(\d+) residential/g)].map((match) => [Number(match[1]), Number(match[2])]);
    expect(sizes.length).toBeGreaterThan(0);
    for (const [width, height] of sizes) { expect(width).toBeLessThanOrEqual(400); expect(height).toBeLessThanOrEqual(400); }
  });

  test("snowball: the next district follows the empty zoning of the density being laid, never the stock of a density left out", async () => {
    const before = process.env.AI_MAYOR_GROWTH_STYLE;
    process.env.AI_MAYOR_GROWTH_STYLE = "SNOWBALL";
    try {
      // Low density (laid) has 4,000 of its cells empty: more than the two template districts the city may hold ahead, so nothing is laid.
      const roads: string[] = [];
      const full = await new DistrictBuilder(harness({ roads, mix: mixWith(byDensity([43_585, 4_000, 60], [14_512, 10_059, 0])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput());
      expect(roads).toHaveLength(0);
      expect(full.notes.join(" | ")).toMatch(/pipeline \(residential\): 4000 homes' cells stand empty/);
    } finally { if (before === undefined) delete process.env.AI_MAYOR_GROWTH_STYLE; else process.env.AI_MAYOR_GROWTH_STYLE = before; }
  });

  test("growth freezes after K negative months in a row; repairs are not a growth and the cycle builds nothing", async () => {
    const roads: string[] = [];
    let month = 0;
    const builder = new DistrictBuilder(harness({ roads, mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])),
      progress: () => ({ milestone: 4, xp: 1, nextMilestoneXp: 2, gameDateTime: `2027-0${(month += 1)}-02 12:30` }) }), { maximumSitesPerCycle: 1 });
    const negative = cycleInput({ finance: { treasury: 400_000, monthlyBalance: -20_000 } });
    const outcomes = [];
    for (let index = 0; index < NEGATIVE_MONTHS_FREEZE; index += 1) outcomes.push(await builder.runCycle(negative));
    expect(outcomes.at(-1)!.notes.join(" | ")).toMatch(/growth frozen \(P8\)/);
    expect(outcomes.at(-1)!.status).toBe("NO_SITE");
    // The surplus returns for a month: growth goes on.
    const recovered = await builder.runCycle(cycleInput());
    expect(recovered.notes.join(" | ")).not.toMatch(/growth frozen/);
  });

  test("land follows realizable search evidence rather than raw owned area", async () => {
    const tiny = { min: { x: 0, z: 0 }, max: { x: 200, z: 200 } };
    const bought: string[] = [];
    // Land is bought only once high density is open (新攻略补充): milestone 8.
    const small = await new DistrictBuilder(harness({ progress: () => ({ milestone: 8, xp: 100, nextMilestoneXp: 500, gameDateTime: "2027-01-02 12:30" }), purchase: bought, series: growingSeries(200), mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])), world: servedWorld(tiny) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 1_500_000, monthlyBalance: 100_000 } }));
    expect(small.status).toBe("LAND_PURCHASED");
    expect(small.feasibility).toMatchObject({ coverage: { complete: true }, survey: { offered: 0 } });
    // Plentiful cash and almost no free land: the tile is bought ahead of need, before the search even has to fail.
    expect(small.notes.join(" | ")).toMatch(/land ahead \(P5\)/);
    // A deliberately capped search cannot prove that the large owned ground has no realizable site.
    bought.length = 0;
    const covered = await new DistrictBuilder(harness({ progress: () => ({ milestone: 8, xp: 100, nextMilestoneXp: 500, gameDateTime: "2027-01-02 12:30" }), purchase: bought, refuseRoads: true, series: growingSeries(200), mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 250_000, monthlyBalance: 0 } }));
    expect(bought).toHaveLength(0);
    expect(covered.outcome).toBe("REPLAN_REQUIRED");
    expect(covered.feasibility).toMatchObject({ coverage: { complete: false } });
    expect(covered.notes.join(" | ")).toMatch(/land \(P5\): search coverage is incomplete/);
  });

  test("a land purchase held by monthly finances is a policy wait, not an exhausted site search", async () => {
    const bought: string[] = [];
    const result = await new DistrictBuilder(harness({ progress: () => ({ milestone: 8, xp: 100, nextMilestoneXp: 500, gameDateTime: "2027-01-02 12:30" }), purchase: bought, series: growingSeries(200),
      mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])),
      world: servedWorld({ min: { x: 0, z: 0 }, max: { x: 200, z: 200 } }) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 250_000, monthlyBalance: 0 } }));
    expect(result.outcome).toBe("WAIT");
    expect(result.waitReason).toBe("LAND_FINANCE_HELD");
    expect(result.feasibility).toMatchObject({ coverage: { complete: true } });
    expect(bought).toHaveLength(0);
  });

  test("while only low density is unlocked (the city out of land, cash plentiful) no tile is bought: the city waits, it does not stop (新攻略补充); medium rows from M2 are dense housing and may have land", async () => {
    const bought: string[] = [];
    const result = await new DistrictBuilder(harness({ purchase: bought, series: growingSeries(200), mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])),
      world: servedWorld({ min: { x: 0, z: 0 }, max: { x: 200, z: 200 } }) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ finance: { treasury: 1_500_000, monthlyBalance: 100_000 }, unlocked: { densities: { low: true, medium: false, high: false }, office: true } }));
    expect(bought).toHaveLength(0);
    expect(result.outcome).toBe("WAIT");
    // (With only low density open the density policy holds homes before the land step is reached; either way nothing is bought and the city waits.)
    expect(["HOUSING_HELD", "LAND_HELD_UNTIL_HIGH_DENSITY"]).toContain(result.waitReason);
  });

  test("no land is bought for a batch that is not there (the city cannot take up homes)", async () => {
    const tiny = { min: { x: 0, z: 0 }, max: { x: 200, z: 200 } };
    const bought: string[] = [];
    const result = await new DistrictBuilder(harness({ purchase: bought, series: growingSeries(1), world: servedWorld(tiny), mix: mixWith(byDensity([1_000, 20, 0], [10_000, 2_000, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ unlocked: { densities: { low: false, medium: true, high: false }, office: true } }));
    expect(result.status).toBe("NO_SITE");
    expect(bought).toHaveLength(0);
  });

  test("without the catalogue's unlocked densities the density policy stands down and says so; other modes are unchanged", async () => {
    const zones: string[] = [];
    const result = await new DistrictBuilder(harness({ zones, mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ unlocked: undefined }));
    expect(result.notes.join(" | ")).toMatch(/density policy stands down/);
    expect(zones.some((zone) => zone === "residential:default")).toBe(true);
    const plainZones: string[] = [];
    const plain = await new DistrictBuilder(harness({ zones: plainZones, mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])) }), { maximumSitesPerCycle: 1 }).runCycle(cycleInput({ pipelined: undefined }));
    expect(plain.notes.join(" | ")).not.toMatch(/growth V2/);
    expect(plainZones.every((zone) => !/:MEDIUM|:LOW|:HIGH/.test(zone))).toBe(true);
  });

  // A built-up block in the middle of the owned ground that the city-wide list does not show: 14 x 11 houses, 20 m apart.
  const hiddenBlock = Array.from({ length: 14 * 11 }, (_, index) => ({ x: 300 + (index % 14) * 20, z: 150 + Math.floor(index / 14) * 20 }));
  const touchesBlock = (call: { x: number; z: number; radius: number }) => hiddenBlock.some((house) => Math.hypot(house.x - call.x, house.z - call.z) <= call.radius);

  test("a district is never laid over buildings the city-wide list does not show, and no zoning brush reaches them (ground read)", async () => {
    const zoneCalls: Array<{ zone: string; x: number; z: number; radius: number }> = [];
    const result = await new DistrictBuilder(harness({ zoneCalls, hiddenBuildings: hiddenBlock, series: growingSeries(420), mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) }),
      { maximumSitesPerCycle: 3 }).runCycle(cycleInput({ finance: { treasury: 3_000_000, monthlyBalance: 100_000 } }));
    expect(zoneCalls.length).toBeGreaterThan(0);
    expect(zoneCalls.filter(touchesBlock)).toEqual([]);
    expect(result.notes.join(" | ")).toMatch(/land: \d+ free lattice cells/);
  });

  test("with no terrain read the site's own window still refuses a rectangle with buildings in it, and remembers them", async () => {
    const zoneCalls: Array<{ zone: string; x: number; z: number; radius: number }> = [];
    const builder = new DistrictBuilder(harness({ zoneCalls, noTerrain: true, hiddenBuildings: hiddenBlock, series: growingSeries(420),
      mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) }), { maximumSitesPerCycle: 6 });
    const first = await builder.runCycle(cycleInput({ finance: { treasury: 3_000_000, monthlyBalance: 100_000 } }));
    expect(first.notes.join(" | ")).toMatch(/existing building\(s\) stand in it/);
    expect(zoneCalls.filter(touchesBlock)).toEqual([]);
  });

  test("a window that cannot be read proves nothing: the site is not built on", async () => {
    const roads: string[] = [];
    const port = harness({ roads, mix: mixWith(byDensity([40_000, 100, 30], [8_000, 100, 80])) });
    port.siteDetail = async () => null;
    const result = await new DistrictBuilder(port, { maximumSitesPerCycle: 3 }).runCycle(cycleInput());
    expect(roads).toHaveLength(0);
    expect(result.status).toBe("NO_SITE");
    expect(result.outcome).toBe("SAFETY_BLOCKED");
    expect(result.feasibility).toMatchObject({ reason: "SITE_READ_UNAVAILABLE", siteChecks: { unread: expect.any(Number) } });
  });

  test("a player's asked density rules over the policy", async () => {
    const zones: string[] = [];
    await new DistrictBuilder(harness({ zones, mix: mixWith(byDensity([40_000, 800, 30], [8_000, 600, 80])) }), { maximumSitesPerCycle: 1 })
      .runCycle(cycleInput({ intent: { role: "residential", region: "ANY", density: "LOW", acquireLand: false, target: null } }));
    expect(zones.some((zone) => zone === "residential:LOW")).toBe(true);
    expect(zones.some((zone) => zone === "residential:MEDIUM")).toBe(false);
  });
});
