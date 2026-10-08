import { MINIMUM_RECTANGLE_AREA_SQUARE_METERS } from "./district-land";

/**
 * FAST_EXPANSION V2 — the growth decisions of the policy candidate (docs/FAST_EXPANSION_V2 Gameplay Policy Candidate.md), as pure functions.
 *
 *   P1 stage by milestone, not population      P2 batch = min(capital cap, absorption cap)     P3 densest unlocked density, low density on quota
 *   P5 land bought for delivery lead time      P8 hard finance constraint (reserve; K negative months freeze growth)
 *
 * Everything here reads numbers the caller took from the world; nothing is a fact about one save. Every figure marked ⟨待标定⟩ in the
 * candidate is a conservative PLACEHOLDER below (named, exported, and logged with the decision it shaped), to be calibrated by the live
 * experiments E1–E10 — not a verified number. The world's reading always outranks a placeholder.
 *
 * Version binding (P9): the rules below were written against Cities: Skylines II 1.6.2f1. A later version puts them back under review.
 */

export const POLICY_GAME_VERSION = "1.6.2f1";

// --------------------------------------------------------------------------------------------------------------------
// P1 — stages

export type GrowthStage = "S0" | "S1" | "S2" | "S3" | "S4";
export type ResidentialDensityKey = "low" | "medium" | "high";

/** ⟨待标定⟩ S4 starts at about this population (or when the observed net immigration has started to fall away). */
export const STAGE_S4_POPULATION = 50_000;

export interface UnlockedDensities {
  /** A growable (unlocked, spawnable) residential zone exists at this density. */
  low: boolean;
  medium: boolean;
  high: boolean;
}

export interface StageInput {
  /** The game's achieved milestone (0-based as the game numbers them), when the Bridge reports it. */
  milestone: number | null;
  population: number | null;
  densities: UnlockedDensities;
  /** The unlocked zones include low-density office (a milestone-4 unlock in 1.6.2). */
  officeUnlocked: boolean;
  /** Net immigration observed to be falling away (P1/S4). Null: not observable. */
  immigrationDecaying?: boolean | null;
}

export interface StageVerdict { stage: GrowthStage; source: "milestone" | "unlocks"; detail: string }

/**
 * The stage. The milestone level decides when the world reports it (M0–1 S0, M2–3 S1, M4–7 S2, M8+ S3); when it does not, the stage is
 * read from what the milestones unlocked, which is the same fact seen from the other side (high density = M8+, office = M4+, medium = M2+).
 */
export function growthStage(input: StageInput): StageVerdict {
  const tail = (input.population !== null && input.population >= STAGE_S4_POPULATION) || input.immigrationDecaying === true;
  let stage: GrowthStage;
  let source: StageVerdict["source"];
  if (input.milestone !== null && Number.isFinite(input.milestone)) {
    source = "milestone";
    stage = input.milestone >= 8 ? "S3" : input.milestone >= 4 ? "S2" : input.milestone >= 2 ? "S1" : "S0";
  } else {
    source = "unlocks";
    stage = input.densities.high ? "S3" : input.officeUnlocked ? "S2" : input.densities.medium ? "S1" : "S0";
  }
  if (tail && stage === "S3") stage = "S4";
  // A city past ⟨~50k⟩ whose milestone is still below S3 is a data problem, not an S4: S4 follows the high-density stage only.
  return { stage, source, detail: `${source === "milestone" ? `milestone ${input.milestone}` : `unlocks: medium ${input.densities.medium}, office ${input.officeUnlocked}, high ${input.densities.high}`}` };
}

/** Rank of a stage, for "at least S2" tests. */
export const stageRank = (stage: GrowthStage): number => Number(stage.slice(1));

// --------------------------------------------------------------------------------------------------------------------
// P3 — density

/** ⟨待标定⟩ A density with this share of its zoned cells standing empty gets no new supply. */
export const DENSITY_VACANCY_EXCLUDE_SHARE = 0.25;
/** ⟨待标定⟩ Low density is still wanted when its own vacancy is below this and its demand is at least `LOW_DENSITY_DEMAND_HIGH`. */
export const LOW_DENSITY_VACANCY_MAXIMUM_SHARE = 0.15;
export const LOW_DENSITY_DEMAND_HIGH = 50;
/**
 * ⟨待标定⟩ From the stage medium density opens (S1, M2), low density is capped at this share of the city's residential zoning (E4 sets the real size).
 * The policy text caps it from M8; the speedrun does not wait for M8 (Gemini: "skip low density once medium rows open"), and low density is a fiscal poison
 * (tile upkeep, long roads, a thin tax base). Live 2026-10-05, 13,558 people: 90% of the residential buildings were low density, and the share is read
 * from the zoning the WORLD reports, not from what this process laid, so a restart does not forget it.
 */
export const LOW_DENSITY_QUOTA_SHARE = 0.25;
export const LOW_DENSITY_QUOTA_FROM_STAGE = "S1" as const;
/** Game hours the quota may hold homes back with no denser density open before it yields to low density. */
export const QUOTA_YIELD_HOURS = 6;
export const QUOTA_YIELD_CYCLES = 30;

export interface DensityState {
  /** A growable zone at this density is unlocked. */
  unlocked: boolean;
  /** Empty zoned cells over zoned cells at this density; null when the world did not report it. */
  vacancyShare: number | null;
  /** The game's building demand for this density, 0–100; null when unknown. */
  demand: number | null;
}

export interface DensityChoice {
  /** The density to zone next, or null when no residential density should be added this cycle. */
  density: ResidentialDensityKey | null;
  reason: string;
  /** No density was chosen because low density is over its quota (and nothing denser is open). */
  quotaBlocked?: boolean;
}

/**
 * Density by unlock and vacancy, not by the height of a demand bar. The default is the densest unlocked density. A density is left
 * out only when it stands empty (vacancy) or its demand is exactly nil; the demand bar never picks low density by being taller.
 * Low density is used in three cases only: the opening (S0), a low density that is nearly full while the city asks for it, and — from S3 —
 * within a quota. (A lot too small or oddly shaped for a denser building is the fourth case of the candidate; the builder does not yet
 * read lot shape, so it is not used here.)
 */
export function chooseResidentialDensity(input: {
  stage: GrowthStage;
  densities: Record<ResidentialDensityKey, DensityState>;
  /** Share of the city's residential zoning that is low density (from the world), else of the area laid in this session; 0–1; null when unknown. */
  lowDensityShareSoFar: number | null;
  /**
   * The quota has held the city's homes back for hours with no denser density open (live 2026-10-06: 133 cycles in a row "low density over its 25% quota,
   * medium: its demand is nil", jobs waiting for residents, no district laid for 40 minutes). A quota is a preference for denser homes while they can be built;
   * with none open it yields to low density, which the world still asks for. Set by the caller after QUOTA_YIELD_HOURS of that deadlock.
   */
  quotaYields?: boolean;
}): DensityChoice {
  const { stage, densities } = input;
  const left = (key: ResidentialDensityKey) => {
    const state = densities[key];
    if (!state.unlocked) return "locked";
    if (state.vacancyShare !== null && state.vacancyShare >= DENSITY_VACANCY_EXCLUDE_SHARE) return `${Math.round(state.vacancyShare * 100)}% of its zoning stands empty`;
    if (state.demand !== null && state.demand <= 0) return "its demand is nil";
    return null;
  };
  const excluded: string[] = [];
  // S0 is "a small patch of low density" (P1 table; P3 lists the opening stage first among the cases low density is for): a denser density that
  // happens to be unlocked does not change what the opening builds. When low density is not open (locked, empty, no demand) the default applies.
  if (stage === "S0" && densities.low.unlocked && left("low") === null) return { density: "low", reason: "the opening stage builds low density" };
  for (const key of ["high", "medium"] as const) {
    const why = left(key);
    if (why === null) return { density: key, reason: `the densest density left is ${key}${excluded.length > 0 ? ` (${excluded.join("; ")})` : ""}` };
    if (why !== "locked") excluded.push(`${key}: ${why}`);
  }
  const low = densities.low;
  if (!low.unlocked) return { density: null, reason: `no density is open for new supply (${excluded.join("; ") || "none unlocked"})` };
  const lowWhy = left("low");
  if (lowWhy !== null) return { density: null, reason: `no density is open for new supply (${[...excluded, `low: ${lowWhy}`].join("; ")})` };
  const quotaUsed = stageRank(stage) >= stageRank(LOW_DENSITY_QUOTA_FROM_STAGE) && input.lowDensityShareSoFar !== null && input.lowDensityShareSoFar >= LOW_DENSITY_QUOTA_SHARE;
  if (quotaUsed && input.quotaYields) return { density: "low", reason: `low density is over its ${Math.round(LOW_DENSITY_QUOTA_SHARE * 100)}% quota (${Math.round((input.lowDensityShareSoFar ?? 0) * 100)}%), but no denser density has been open for ${QUOTA_YIELD_HOURS}+ game hours and low density is asked for: the quota yields (${excluded.join("; ")})` };
  if (quotaUsed) return { quotaBlocked: true, density: null, reason: `low density is over its ${Math.round(LOW_DENSITY_QUOTA_SHARE * 100)}% quota (${Math.round((input.lowDensityShareSoFar ?? 0) * 100)}% of the residential zoning) from ${LOW_DENSITY_QUOTA_FROM_STAGE} on (${excluded.join("; ")})` };
  const nearlyFull = low.vacancyShare !== null && low.vacancyShare < LOW_DENSITY_VACANCY_MAXIMUM_SHARE;
  const asked = low.demand !== null && low.demand >= LOW_DENSITY_DEMAND_HIGH;
  if (nearlyFull && asked) return { density: "low", reason: `low density is nearly full (${Math.round((low.vacancyShare ?? 0) * 100)}% empty) and asked for (${low.demand}); ${excluded.join("; ")}` };
  // A density whose vacancy or demand is not reported cannot be judged: it is not used to fill the gap.
  return { density: null, reason: `low density is not an open case (vacancy ${low.vacancyShare === null ? "unknown" : `${Math.round(low.vacancyShare * 100)}%`}, demand ${low.demand ?? "unknown"}); ${excluded.join("; ")}` };
}

// --------------------------------------------------------------------------------------------------------------------
// P2 — batch size

/**
 * One game day is 262,144 simulation frames (the statistics endpoint states it; measured live 2026-10-04: 3,304 frames moved the clock 18
 * minutes, i.e. 262,144 frames = one 24-hour calendar day). Growth in this game is fast in game days — a city went 5.7k -> 10.7k in four.
 */
export const FRAMES_PER_GAME_DAY = 262_144;
/**
 * ⟨待标定⟩ How far ahead (game days) the absorption cap looks: about the delivery lead time of one batch (roads, zoning, the buildings
 * growing). A month of days would price the batch against a city 70% larger than the one that exists.
 */
export const ABSORPTION_LOOKAHEAD_DAYS = 3;
/**
 * The immigration rate is the CURRENT flow: the least-squares slope over the most recent half game day. A longer average carries the
 * fast growth of days ago into a city whose growth has since flattened (measured live: 1,274 people/day over four days, ~250 now).
 */
export const RATE_WINDOW_DAYS = 0.5;
/** A rate is read over at least this much game time (and three samples), or it is noise. */
export const MINIMUM_RATE_SPAN_DAYS = 0.25;
/** ⟨待标定⟩ Share of cash above the reserve that one batch may spend. */
export const CAPITAL_SHARE_OF_CASH = 0.8;
/**
 * ⟨待标定⟩ Share of one month's surplus a batch may also count on: the surplus that arrives while the batch is built (about the absorption
 * look-ahead, 3 of ~30 days). The candidate says "monthly surplus x months"; counting a whole month spent today priced a batch at
 * 1,000,000+ m2 against a treasury of 80,000 in the first live run (2026-10-04).
 */
export const CAPITAL_SURPLUS_MONTHS = 0.1;
/** ⟨待标定⟩ Reserve = this share of one month's maintenance (the candidate says ⟨N months⟩), never below the study's deviation reserve. */
export const RESERVE_SHARE_OF_MONTHLY_MAINTENANCE = 0.1;
export const DEVIATION_RESERVE = 150_000;
/** Measured in the districts built so far: roads and zoning cost about this much per square metre (see runtime). */
export const COST_PER_SQUARE_METER = 0.3;
/** The smallest district the survey offers (240 × 240). */
export const SMALLEST_DISTRICT_SQUARE_METERS = 57_600;

export interface PopulationSeries { frames: readonly number[]; values: readonly number[] }

/**
 * Net population change per game day: the least-squares slope over the most recent `windowDays` of the series (noise in single samples
 * is a few dozen people; a slope over many samples is steady where the difference of two is not). Null when the window holds fewer than
 * three samples or spans less than `MINIMUM_RATE_SPAN_DAYS`.
 */
export function netGrowthPerDay(series: PopulationSeries | null, windowDays = RATE_WINDOW_DAYS): number | null {
  if (!series || series.frames.length < 3 || series.frames.length !== series.values.length) return null;
  const last = series.frames[series.frames.length - 1]!;
  const points: Array<{ day: number; value: number }> = [];
  for (let index = 0; index < series.frames.length; index += 1) {
    if (series.frames[index]! >= last - windowDays * FRAMES_PER_GAME_DAY) points.push({ day: series.frames[index]! / FRAMES_PER_GAME_DAY, value: series.values[index]! });
  }
  if (points.length < 3 || !(points[points.length - 1]!.day - points[0]!.day >= MINIMUM_RATE_SPAN_DAYS)) return null;
  const meanDay = points.reduce((sum, point) => sum + point.day, 0) / points.length;
  const meanValue = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point.day - meanDay) ** 2, 0);
  if (!(variance > 0)) return null;
  return points.reduce((sum, point) => sum + (point.day - meanDay) * (point.value - meanValue), 0) / variance;
}

/**
 * Whether the net growth is falling away: the current flow is under half of the flow over the whole series. Null when either is unreadable
 * or the city was not growing over the series to begin with.
 */
export function growthDecaying(series: PopulationSeries | null): boolean | null {
  if (!series || series.frames.length < 8) return null;
  const spanDays = (series.frames[series.frames.length - 1]! - series.frames[0]!) / FRAMES_PER_GAME_DAY;
  const overall = netGrowthPerDay(series, spanDays + 1);
  const current = netGrowthPerDay(series);
  if (overall === null || current === null || !(overall > 0)) return null;
  return current < overall * 0.5;
}

/**
 * ⟨待标定⟩ S0 and P2: "a small, complete first growth loop". While the city has no immigration sample to price a batch against (a new game, or too
 * few people for a rate to mean anything) the batch is NOT the cash cap — that is a steady-state estimate with nothing under it (measured live
 * 2026-10-04, clean start: a 2,266,667 m2 "capital-bound" batch for a city of 14 people). It is a seed: two of the smallest districts, enough for
 * homes and jobs and the three networks to close once, small enough that the treasury stays whole (S0's aim is "cash flow does not break").
 */
export const SEED_BATCH_SQUARE_METERS = 2 * SMALLEST_DISTRICT_SQUARE_METERS;
/**
 * A rate needs people to be a rate: with fewer residents than this, the population series is a handful of heads moving by one or two and its
 * slope says nothing (it read 9, 14, 13, 9, 9, 14 on a clean start). Below it the absorption cap is "no readable rate", and the seed batch stands.
 */
export const MINIMUM_POPULATION_FOR_RATES = 100;

export interface Constraint { limit: number; binding: "capital" | "absorption" | "seed" | "none"; capitalArea: number; absorptionArea: number | null; detail: string }

/** The reserve a batch must leave in the treasury. */
export function capitalReserve(monthlyMaintenance: number | null): number {
  return Math.max(DEVIATION_RESERVE, (monthlyMaintenance ?? 0) * RESERVE_SHARE_OF_MONTHLY_MAINTENANCE);
}

/** Square metres of district the cash can pay for: cash above the reserve, plus a month of surplus, at the measured cost per square metre. */
export function capitalAreaCap(input: { treasury: number; monthlyBalance: number; monthlyMaintenance: number | null }): number {
  const budget = Math.max(0, input.treasury - capitalReserve(input.monthlyMaintenance)) * CAPITAL_SHARE_OF_CASH
    + Math.max(0, input.monthlyBalance) * CAPITAL_SURPLUS_MONTHS;
  return Math.max(0, budget / COST_PER_SQUARE_METER);
}

/**
 * How many residential cells the city can take up in the look-ahead window beyond what already stands empty:
 * (net immigration per day × days) / people per built cell − empty zoned cells of the density.
 * People per built cell is calibrated from the city itself (residents over built residential cells), not assumed.
 * Returns null when the rate or the calibration cannot be read (the caller then does not cap by absorption, and says so).
 */
export function absorbableCells(input: {
  growthPerDay: number | null;
  population: number | null;
  builtResidentialCells: number | null;
  emptyCellsOfDensity: number;
  zonedCellsOfDensity: number;
  /** The game reports demand for this density (0–100), when it does. */
  demand: number | null;
}): { cells: number | null; detail: string } {
  const { growthPerDay, population, builtResidentialCells } = input;
  if (growthPerDay === null || population === null || builtResidentialCells === null || !(builtResidentialCells > 0) || !(population > 0)) {
    return { cells: null, detail: "no readable immigration rate" };
  }
  if (population < MINIMUM_POPULATION_FOR_RATES) {
    return { cells: null, detail: `only ${population} residents: too few for an immigration rate to mean anything` };
  }
  const perCell = population / builtResidentialCells;
  const wanted = (Math.max(0, growthPerDay) * ABSORPTION_LOOKAHEAD_DAYS) / perCell;
  const raw = wanted - input.emptyCellsOfDensity;
  // A city with no empty supply cannot show a rate above the supply it had: a rate read off a full city understates demand. While the
  // density is nearly full and the game still asks for it, one smallest district is always allowed.
  const supplyBound = input.zonedCellsOfDensity > 0 ? input.emptyCellsOfDensity / input.zonedCellsOfDensity < 0.05 : true;
  const supplyFloor = supplyBound && input.demand !== null && input.demand > 0 ? SMALLEST_DISTRICT_SQUARE_METERS / 64 : 0;
  const cells = Math.max(0, raw, supplyFloor);
  return { cells, detail: `${growthPerDay.toFixed(1)} people/day x ${ABSORPTION_LOOKAHEAD_DAYS} days / ${perCell.toFixed(2)} per cell = ${wanted.toFixed(0)} cells, ${input.emptyCellsOfDensity} already empty${supplyFloor > 0 && cells === supplyFloor ? ", supply-bound floor" : ""}` };
}

/** The batch: the smaller of what the cash pays for and what the city can take up. Records which one binds. */
export function batchConstraint(input: { capitalArea: number; absorptionCells: number | null; cellAreaSquareMeters?: number; districtAreaPerZonedCell?: number;
  /** True while there is no sample to price the batch against (no readable rate): the seed caps it instead of the cash alone. */
  seed?: boolean;
  /**
   * The opening stage (S0) is "a small patch": the seed is its ceiling whatever the readings say. A young city's immigration is a burst
   * (747 people/day at 300 residents, measured live 2026-10-04) and a steady-state window on it prices a batch at 2,600,000 m2.
   */
  seedAlways?: boolean }): Constraint {
  const cell = input.cellAreaSquareMeters ?? 64;
  // A district's roads and verges take part of its area, so a zoned cell stands for more than its own 64 m².
  const perCell = input.districtAreaPerZonedCell ?? cell / 0.6;
  const absorptionArea = input.absorptionCells === null ? null : input.absorptionCells * perCell;
  if (input.seedAlways === true) {
    const other = absorptionArea === null ? input.capitalArea : Math.min(input.capitalArea, absorptionArea);
    const limit = Math.min(other, SEED_BATCH_SQUARE_METERS);
    const binding: Constraint["binding"] = SEED_BATCH_SQUARE_METERS <= other ? "seed" : absorptionArea !== null && absorptionArea < input.capitalArea ? "absorption" : "capital";
    return { limit, binding, capitalArea: input.capitalArea, absorptionArea,
      detail: `capital ${Math.round(input.capitalArea)} m2, absorption ${absorptionArea === null ? "unknown" : `${Math.round(absorptionArea)} m2`} -> ${binding === "seed" ? "opening-stage seed batch" : `${binding}-bound`} ${Math.round(limit)} m2` };
  }
  if (absorptionArea === null && input.seed === true) {
    const limit = Math.min(input.capitalArea, SEED_BATCH_SQUARE_METERS);
    const binding: Constraint["binding"] = input.capitalArea < SEED_BATCH_SQUARE_METERS ? "capital" : "seed";
    return { limit, binding, capitalArea: input.capitalArea, absorptionArea,
      detail: `capital ${Math.round(input.capitalArea)} m2, absorption unknown (no sample) -> ${binding === "seed" ? "seed batch" : "capital-bound"} ${Math.round(limit)} m2` };
  }
  const limit = absorptionArea === null ? input.capitalArea : Math.min(input.capitalArea, absorptionArea);
  const binding: Constraint["binding"] = absorptionArea === null ? "capital" : absorptionArea < input.capitalArea ? "absorption" : "capital";
  return { limit, binding, capitalArea: input.capitalArea, absorptionArea,
    detail: `capital ${Math.round(input.capitalArea)} m2, absorption ${absorptionArea === null ? "unknown" : `${Math.round(absorptionArea)} m2`} -> ${binding}-bound ${Math.round(limit)} m2` };
}

// --------------------------------------------------------------------------------------------------------------------
// P5 — land

/** Planner evidence for the batch the policy requested. Geometric area is only a candidate, never delivered capacity. */
export interface GrowthFeasibility {
  targetAreaSquareMeters: number | null;
  deliveredAreaSquareMeters: number;
  geometricCandidateAreaSquareMeters: number;
  searchComplete: boolean;
  unreadSites: number;
  rejectedSites: number;
}

/** Smallest geometric district the current planner offers after fitting blocks. */
export const MINIMUM_REALIZATION_AREA_SQUARE_METERS = MINIMUM_RECTANGLE_AREA_SQUARE_METERS;

export function growthAdmission(input: { population: number | null; targetPopulation: number | null; utilityReadComplete: boolean }):
  { build: boolean; reason: string | null } {
  if (input.targetPopulation !== null && input.population !== null && input.population >= input.targetPopulation)
    return { build: false, reason: "TARGET_REACHED" };
  if (!input.utilityReadComplete) return { build: false, reason: "UTILITY_READ_UNAVAILABLE" };
  return { build: true, reason: null };
}

/** The one policy choice of which district supply to add; the builder only searches for the chosen role. */
export function chooseGrowthRole(input: { bottleneck: "HOUSING" | "JOBS" | "MATCH" | "NONE";
  demand: { residential: number; commercial: number; industrial: number };
  available: readonly string[]; paused: readonly string[];
  /**
   * Land uses whose survey found no site after a complete search, held out for a few game hours. They are not "paused" (their stock is not the
   * reason): the cycle moves on to the next use that also answers the bottleneck, so one use without land does not stop the whole city
   * (measured live 2026-10-04: nine cycles idle beside 131 ha of free land because only industry was asked for).
   */
  blocked?: readonly string[] }): "residential" | "commercial" | "industrial" | null {
  const blocked = input.blocked ?? [];
  const roles = (["residential", "industrial", "commercial"] as const)
    .filter((role) => input.available.includes(role) && !input.paused.includes(role) && !blocked.includes(role));
  // Homes are never stood in for by another use.
  if (input.bottleneck === "HOUSING") return roles.includes("residential") ? "residential" : null;
  if (input.bottleneck === "JOBS") {
    if (roles.includes("industrial")) return "industrial";
    // Commercial is a job-bearing use too (V2 candidate P4), but only stands in for industry that has no LAND: locked or oversupplied industry
    // still means no district. P4 also wants the shops' stock read first; that reading does not exist yet, so this fallback is unverified against it.
    return blocked.includes("industrial") && roles.includes("commercial") ? "commercial" : null;
  }
  if (input.bottleneck === "MATCH") return null;
  return [...roles].sort((left, right) => input.demand[right] - input.demand[left])[0] ?? null;
}

export function decideGrowthAfterSearch(evidence: GrowthFeasibility):
  { action: "BUY_LAND" | "REPLAN" | "SAFETY_WAIT" | "WAIT_FOR_NEXT_BATCH"; reason: string } {
  if (evidence.targetAreaSquareMeters === null) return { action: "REPLAN", reason: "batch target cannot be read from current finance" };
  const remaining = Math.max(0, evidence.targetAreaSquareMeters - evidence.deliveredAreaSquareMeters);
  if (remaining === 0) return { action: "WAIT_FOR_NEXT_BATCH", reason: "batch target delivered; the next world read will set a new batch" };
  if (remaining < MINIMUM_REALIZATION_AREA_SQUARE_METERS) return { action: "WAIT_FOR_NEXT_BATCH",
    reason: `${Math.round(remaining)} m2 remains, below one realizable district; the next world read will set a new batch` };
  if (evidence.unreadSites > 0) return { action: "SAFETY_WAIT", reason: `${evidence.unreadSites} candidate site reads were incomplete` };
  if (!evidence.searchComplete) return { action: "REPLAN", reason: `search coverage is incomplete; ${Math.round(evidence.geometricCandidateAreaSquareMeters)} m2 is only geometric candidate area` };
  return { action: "BUY_LAND", reason: `no realizable site remained after complete search for ${Math.round(remaining)} m2; ${evidence.rejectedSites} sites were refused` };
}

// --------------------------------------------------------------------------------------------------------------------
// P8 — the hard finance constraint

/** ⟨待标定⟩ Growth freezes (repairs go on) once the rolling monthly surplus has been negative this many months in a row. */
export const NEGATIVE_MONTHS_FREEZE = 3;

/** Monthly balances, one per game month (the caller dedupes by month), newest last. */
export class FinanceWatch {
  readonly #months: Array<{ month: string; balance: number }> = [];
  observe(month: string | null, balance: number | null): void {
    if (balance === null || !Number.isFinite(balance)) return;
    const key = month ?? `n${this.#months.length}`;
    const last = this.#months[this.#months.length - 1];
    if (last && last.month === key) last.balance = balance;
    else this.#months.push({ month: key, balance });
    while (this.#months.length > 12) this.#months.shift();
  }
  /** Consecutive most-recent negative months. */
  get negativeStreak(): number {
    let streak = 0;
    for (let index = this.#months.length - 1; index >= 0 && this.#months[index]!.balance < 0; index -= 1) streak += 1;
    return streak;
  }
  get frozen(): boolean { return this.negativeStreak >= NEGATIVE_MONTHS_FREEZE; }
  reset(): void { this.#months.length = 0; }
}

/** The game month of a "YYYY-MM-DD ..." date, or null. */
export function gameMonthKey(gameDateTime: string | null | undefined): string | null {
  const match = typeof gameDateTime === "string" ? /^(\d{4})-(\d{2})/.exec(gameDateTime) : null;
  return match ? `${match[1]}-${match[2]}` : null;
}
