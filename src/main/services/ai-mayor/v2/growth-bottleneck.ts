/**
 * FAST_EXPANSION: which supply the city should stop adding, read from the world.
 *
 * "Stop adding" is not "wait". An unrealised stock of one land use, or homes the jobs cannot carry, means more of that
 * supply buys nothing yet; the cycle keeps building whatever else the world says is short (utilities, services, other
 * land uses, land) and the city runs. Nothing here is a threshold from one save: the cut-offs are the shape of the
 * rule (homes need jobs; unrealised stock is not a reason to add more of the same), and every input is a reading.
 */
import type { ZoneCategory, ZoningMixSignals } from "./zoning-mix";
import { unrealizedShare } from "./zoning-mix";
import type { GrowthStage } from "./growth-policy";
import { stageRank } from "./growth-policy";
import { GAME_HOUR_FRAMES, stampElapsed, type GameStamp } from "./game-clock";

/** What the game's labour reading says. Rates may arrive as a fraction or as a percent; both are accepted. */
export interface LaborReading {
  employed: number;
  unemploymentRate: number;
  jobsTotal: number;
  jobsFree: number;
}

export type GrowthBottleneck = "HOUSING" | "JOBS" | "MATCH" | "NONE";

/** A workforce smaller than this (employed plus looking for work) is too few people for any share of it to be a bottleneck. */
export const LABOR_SAMPLE_MINIMUM = 100;
/** Unemployment above this share of the workforce is a jobs problem, not noise. */
export const UNEMPLOYMENT_PROBLEM_SHARE = 0.12;
/**
 * P4 of the V2 candidate: the aim is "somewhat more jobs than people looking", not zero unemployment (Economy 2.0 expects some). Open jobs
 * at or above this share of all jobs ⟨待标定⟩ are a healthy margin, and homes — not jobs — are then what the city lacks.
 */
export const JOB_VACANCY_TARGET_SHARE = 0.03;
/** A land use whose zoned cells stand this empty is stock, not a shortage: no more of it until it fills. */
export const STOCK_PAUSE_UNREALIZED_SHARE = 0.35;

export function unemploymentShare(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.min(1, rate > 1 ? rate / 100 : rate);
}

/**
 * Whether a labour reading agrees with the city's own head count: the workforce it implies (employed / (1 - rate)) cannot exceed every
 * citizen there is. Measured live (2026-10-04): the rate read 0.85 beside 6,206 employed in a city of 10,765 — a workforce of 40,000. That is
 * a bad reading, not a labour market, and it must not turn into "the city needs jobs". An unknown head count cannot disprove a reading.
 */
export function plausibleLaborReading(labor: LaborReading, citizens: number | null): boolean {
  if (citizens === null || !Number.isFinite(citizens) || !(citizens > 0)) return true;
  const share = unemploymentShare(labor.unemploymentRate);
  if (!(share > 0) || share >= 1) return share < 1;
  return labor.employed / (1 - share) <= citizens;
}

/** People looking for work: the workforce implied by the employed count and the rate, less those employed. */
export function unemployedCount(labor: LaborReading): number {
  const share = unemploymentShare(labor.unemploymentRate);
  return share >= 1 ? 0 : Math.round((labor.employed / (1 - share)) * share);
}

/**
 * Where the growth bottleneck is. Homes are short only when jobs stand open and almost nobody is out of work; jobs are short
 * when many people are out of work and few jobs are open; plenty of open jobs beside plenty of unemployed is a mismatch
 * (education, reach) that more of the same does not fix. Anything else is not decided by labour alone.
 */
export function classifyBottleneck(labor: LaborReading | null, residentialDemand?: number | null): { bottleneck: GrowthBottleneck; reason: string } {
  if (!labor) return { bottleneck: "NONE", reason: "no usable labour reading (absent, or it contradicts the city's head count)" };
  const share = unemploymentShare(labor.unemploymentRate);
  const unemployed = unemployedCount(labor);
  const vacancy = labor.jobsTotal > 0 ? labor.jobsFree / labor.jobsTotal : 0;
  const detail = `unemployment ${(share * 100).toFixed(0)}% (${unemployed} people), ${labor.jobsFree} of ${labor.jobsTotal} jobs open (${(vacancy * 100).toFixed(1)}%)`;
  // A labour market needs people in it. In the first days of a new city three people out of work beside seventeen open jobs read "75% unemployed,
  // a skills mismatch" and paused all housing for good — measured live (2026-10-04, clean start): 22 decisions, nothing built. Shares of a handful of
  // people are noise, not a bottleneck; a young city simply builds (homes and jobs both), and the rule below speaks once there is a workforce.
  if (labor.employed + unemployed < LABOR_SAMPLE_MINIMUM) {
    return { bottleneck: "NONE", reason: `${detail}: only ${labor.employed + unemployed} people in the workforce, too few for a labour reading to mean anything` };
  }
  // Open jobs cover the people out of work, yet many stay out of work: skills or reach are the limit, and more of the same fixes nothing.
  if (share >= UNEMPLOYMENT_PROBLEM_SHARE && labor.jobsFree >= unemployed) {
    return { bottleneck: "MATCH", reason: `${detail}: jobs stand open for the unemployed, so skills or reach are the limit` };
  }
  // Fewer open jobs than people looking: jobs are short. This is read from the gap, not from an unemployment target of zero.
  if (labor.jobsFree < unemployed && (share >= UNEMPLOYMENT_PROBLEM_SHARE / 2 || (residentialDemand !== null && residentialDemand !== undefined && residentialDemand <= 0 && share > 0))) {
    return { bottleneck: "JOBS", reason: `${detail}: fewer open jobs than people out of work${residentialDemand !== undefined && residentialDemand !== null && residentialDemand <= 0 ? ", and homes are not being asked for" : ""}` };
  }
  // A healthy job margin (open jobs at least the target share of all jobs, and enough of them for the unemployed): homes are what is missing.
  if (labor.jobsFree > 0 && vacancy >= JOB_VACANCY_TARGET_SHARE && labor.jobsFree >= unemployed) return { bottleneck: "HOUSING", reason: `${detail}: jobs wait for residents` };
  return { bottleneck: "NONE", reason: detail };
}

/** Unbuilt zoning at or below this share of a use's zoning is a small stock: the use is plainly being filled. */
export const SMALL_STOCK_SHARE = 0.35;
/** The game's own demand scale is 0–100; a use at or above this is one the city is asking for. */
export const DEMANDED_USE_MINIMUM = 50;
/** Cycles of stock readings kept to see which way the unbuilt zoning is moving. */
export const STOCK_HISTORY_CYCLES = 5;
/**
 * The same window in game hours (`game-clock.ts`). Five cycles was about five game hours; a cycle is now 1-25 s, so five cycles is minutes of
 * game time and the fall of the unbuilt zoning cannot be seen in it. The cycle count is the fallback when the game clock cannot be read.
 */
export const STOCK_HISTORY_HOURS = 5;
/** Memory bound for the timed history (a cycle can be a few seconds). */
export const STOCK_HISTORY_MAXIMUM_SAMPLES = 400;
/** Empty zoning that fell by this share since the oldest reading in the window counts as being absorbed. */
export const STOCK_FALL_SHARE = 0.03;

/** A reading of the unbuilt zoning with the city's time it was taken at. */
export interface StockSample { cells: ZoningMixSignals["cells"]; stamp: GameStamp }

/**
 * The history after adding a sample at `now`. With a readable clock it keeps every sample younger than twice the window and the newest one
 * older than that, so a reference reading about `STOCK_HISTORY_HOURS` back is still there however long the cycles are; without a clock it
 * keeps the last `STOCK_HISTORY_CYCLES` samples, as before.
 */
export function pruneStockHistory(history: readonly StockSample[], now: GameStamp): StockSample[] {
  if (now.frame === null) return history.slice(-STOCK_HISTORY_CYCLES);
  const limit = 2 * STOCK_HISTORY_HOURS * GAME_HOUR_FRAMES;
  const kept = history.filter((sample) => sample.stamp.frame === null || now.frame! - sample.stamp.frame <= limit);
  const older = history.filter((sample) => sample.stamp.frame !== null && now.frame! - sample.stamp.frame > limit).at(-1);
  return [...(older ? [older] : []), ...kept].slice(-STOCK_HISTORY_MAXIMUM_SAMPLES);
}

/**
 * The land uses the city needs more of right now: the bottleneck names them (homes when jobs wait for residents; the
 * job-bearing uses when people are out of work), and any use the game's own demand asks for counts as well.
 */
export function neededLandUses(bottleneck: GrowthBottleneck, demand: Record<ZoneCategory, number>, available: readonly ZoneCategory[],
  stage?: GrowthStage): ZoneCategory[] {
  const needed = new Set<ZoneCategory>();
  if (bottleneck === "HOUSING") needed.add("residential");
  // P4: jobs come from industry first; office jobs are added from S2 on (the candidate's stages), and only where the unemployment says so.
  // Without a known stage the old behaviour (all job-bearing uses) stands.
  if (bottleneck === "JOBS") for (const category of ["industrial", "commercial", "office"] as const) {
    if (category === "office" && stage !== undefined && stageRank(stage) < stageRank("S2")) continue;
    needed.add(category);
  }
  // The office demand bar is NOT a signal (P4: it is unreliable in 1.6.2): office is needed when jobs are, never because its bar is tall.
  for (const category of available) if (category !== "office" && demand[category] >= DEMANDED_USE_MINIMUM) needed.add(category);
  return [...needed].filter((category) => available.includes(category));
}

/**
 * Whether the supply the city needs is being taken up, read from the zoning's own history rather than one static share
 * of the whole city: a needed use whose unbuilt zoning is small, or has been falling over the last cycles, is absorbing,
 * and the next capacity (land) may be prepared. A needed use whose unbuilt zoning stands still or grows is over-supplied:
 * more of the same would only add to the stock. Unneeded uses never hold land back, whatever stands empty of them.
 */
export function neededStockAbsorbing(history: ReadonlyArray<ZoningMixSignals["cells"] | StockSample>, now: ZoningMixSignals, needed: readonly ZoneCategory[],
  nowStamp?: GameStamp): { absorbing: boolean; reason: string } {
  if (needed.length === 0) return { absorbing: false, reason: "the city is asking for no more supply" };
  const parts: string[] = [];
  let absorbing = false;
  // The reference reading. With a readable clock: the newest one at least `STOCK_HISTORY_HOURS` old (none yet = no reference, so nothing is
  // called "falling" on less than the window). Without one (or with legacy readings that carry no time): the oldest of the last cycles.
  const sampleCells = (sample: ZoningMixSignals["cells"] | StockSample) => ("stamp" in sample ? sample.cells : sample);
  let reference: ZoningMixSignals["cells"] | null = null;
  const timed = nowStamp !== undefined && nowStamp.frame !== null && history.length > 0 && history.every((sample) => "stamp" in sample && sample.stamp.frame !== null);
  if (timed) {
    const aged = (history as readonly StockSample[]).filter((sample) => stampElapsed(sample.stamp, nowStamp!, STOCK_HISTORY_HOURS, STOCK_HISTORY_CYCLES));
    reference = aged.length > 0 ? aged[aged.length - 1]!.cells : null;
  } else if (history.length >= 2) reference = sampleCells(history[0]!);
  for (const category of needed) {
    const { zoned, empty } = now.cells[category];
    const share = zoned > 0 ? empty / zoned : 0;
    const oldest = reference ? reference[category].empty : null;
    const falling = oldest !== null && oldest > 0 && empty <= oldest * (1 - STOCK_FALL_SHARE);
    const small = share <= SMALL_STOCK_SHARE;
    parts.push(`${category} ${empty}/${zoned} unbuilt${oldest !== null ? ` (was ${oldest})` : ""}`);
    if (zoned === 0 || small || falling) absorbing = true;
  }
  return { absorbing, reason: parts.join(", ") };
}

/**
 * The land uses this cycle should not add to: homes while jobs (or their fit) are the limit, and any use whose zoning
 * already stands mostly empty. Pausing every use is allowed: the zoning then adds nothing this cycle and the city runs while
 * the other work (utilities, services, land) goes on.
 */
export function pausedLandUses(signals: ZoningMixSignals, bottleneck: GrowthBottleneck, available: readonly ZoneCategory[]): ZoneCategory[] {
  const paused = new Set<ZoneCategory>();
  if (bottleneck === "JOBS" || bottleneck === "MATCH") paused.add("residential");
  for (const category of available) {
    if (signals.cells[category].zoned > 0 && unrealizedShare(signals, category) >= STOCK_PAUSE_UNREALIZED_SHARE) paused.add(category);
  }
  return [...paused].filter((category) => available.includes(category));
}
