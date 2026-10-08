/**
 * Why the city did or did not keep growing.
 *
 * This is a diagnosis record, not a telemetry platform and not a controller: it
 * observes what a bounded tick already read, names what it means, and — when
 * the city has genuinely stopped moving — says so explicitly instead of
 * leaving a "running" session that is doing nothing.
 *
 * It never decides anything about the city and never invents a recovery. Its
 * only output is a status and, at the end of a run of them, an explicit stall
 * reason. Every fact it records is optional because a Bridge read can fail; an
 * unread value is recorded as `null` and never inferred.
 */

/** What one bounded observation window can say about the run. */
export type RunProgressStatus =
  /** The world advanced and the city changed with it. */
  | "WORLD_PROGRESSING"
  /** Something was committed and the world is being given its bounded chance. */
  | "WAITING_FOR_EFFECT"
  /** A Goal family or target is deliberately held back, with its reason. */
  | "PARKED_WITH_REASON"
  /** Several windows in a row changed nothing measurable. */
  | "REPEATED_NO_EFFECT"
  /** The simulation wait itself could not advance the world. */
  | "SIMULATION_STALLED"
  /** The session stopped. */
  | "RUNTIME_HALTED";

/** Authoritative facts, as read. A failed read stays `null`; nothing is inferred. */
export interface RunLedgerFacts {
  simulationFrame: number | null;
  gameDateTime: string | null;
  population: number | null;
  /**
   * Service buildings the city-services readback counts — and only those.
   *
   * The mayor snapshot's own tally, kept under a name that says so: a city with
   * none of them reports 0 while demonstrably owning homes, industry and
   * utilities, so this is not a building census and must never be read as one.
   */
  serviceBuildingCount: number | null;
  /**
   * The third growth stock, by land use: buildings the city has built whose
   * land use has not absorbed them. Null when no durable tranche has observed
   * occupancy, which is not the same as zero and is never reported as it.
   */
  builtButVacantByType: Record<string, number> | null;
  treasury: number | null;
  monthlyBalance: number | null;
  runwayMonths: number | null;
  /** Utility supply against demand, in the units the existing readback uses. */
  utilities: {
    electricity: { supply: number | null; demand: number | null };
    water: { supply: number | null; demand: number | null };
    sewage: { supply: number | null; demand: number | null };
  };
  /**
   * Read-only labour view. The education split is the same jobs, broken down by
   * the education the workplace asks for; nothing acts on it.
   */
  labor: {
    employed: number | null;
    unemploymentRate: number | null;
    jobsTotal: number | null;
    jobsFree: number | null;
    freeByEducation: Record<string, number> | null;
  } | null;
}

/** What the Brain decided and what the world was told to do about it. */
export interface RunLedgerDecision {
  goalId: string | null;
  goalType: string | null;
  /** The growth policy's own answer for this cycle. */
  policyAnswer: string | null;
  workOrderGoalId: string | null;
  workOrderStatus: string | null;
  workOrderStage: string | null;
  /** Native effects this window: the only proof the world was actually written. */
  applied: { zoning: number; road: number; facility: number };
  parkedFamily: string | null;
  parkedReason: string | null;
  haltReason: string | null;
  /** How the simulation wait ended, and whether the frame actually moved. */
  simulation: {
    outcome: "completed" | "stalled" | "absolute_budget" | "aborted" | "not_run" | "errored";
    elapsedMs: number;
    framesAdvanced: number | null;
    reason: string | null;
  };
}

export interface RunLedgerEntry {
  tick: number;
  at: string;
  status: RunProgressStatus;
  reason: string;
  /** Consecutive windows, ending here, that changed nothing measurable. */
  consecutiveNoEffect: number;
  facts: RunLedgerFacts;
  decision: RunLedgerDecision;
}

/**
 * How many consecutive no-effect windows make the stall explicit.
 *
 * The city is allowed several bounded chances: a zoned lot needs time to be
 * built on, a placed facility needs time to become operational, and both are
 * watched through windows that legitimately change nothing. Six is well past
 * that, and a run that reaches it has stopped being slow and started being
 * stuck.
 */
export const RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD = 6;

/** How many entries the ledger keeps. It is a diagnostic window, not a history. */
export const RUN_LEDGER_CAPACITY = 64;

const sameNumber = (left: number | null, right: number | null) => left === right;

/**
 * Whether this window's world clock was actually readable.
 *
 * A stall is a claim about the world, so it needs a world clock to make it. A
 * read that never resolved leaves the ledger unable to say whether the world is
 * frozen or merely unread — and an unread fact is never turned into a finding.
 */
export function worldClockReadable(facts: RunLedgerFacts | null): boolean {
  return Boolean(facts && (facts.simulationFrame !== null || facts.gameDateTime !== null));
}

/** Whether the world itself moved: the clock, the population, or the buildings. */
export function worldAdvanced(previous: RunLedgerFacts | null, current: RunLedgerFacts): boolean {
  if (!previous) return true;
  if (previous.simulationFrame !== null && current.simulationFrame !== null &&
      current.simulationFrame > previous.simulationFrame) return true;
  if (previous.gameDateTime !== null && current.gameDateTime !== null &&
      current.gameDateTime !== previous.gameDateTime) return true;
  return false;
}

/**
 * Whether the durable plan moved.
 *
 * The stall message below has always claimed "no population, building,
 * applied-effect **or progression** change", but the predicate underneath it
 * implemented only the first three. Progression — the plan reaching a new Goal,
 * a new work order, or a new tranche stage — was promised in the sentence and
 * never checked.
 *
 * That gap stops a working Mayor. Measured live 2026-10-02
 * (`tmp/expansion-vertical2.json`): an eleven-window run landed 9 roads and 14
 * zoning actions, admitted a fresh Goal almost every window, and was halted
 * anyway on window 11. The reason is that the V2 Brain path fills none of the
 * `telemetry` effect counters the `applied` term is read from (`runtime.ts`
 * `#runTick`'s local branch returns through `#finishTick` with the metrics it
 * was constructed with), so `applied` read `{0,0,0}` on every window while the
 * city's own population sat still at 46. The ledger could not see the writing
 * it exists to watch for.
 *
 * Reading the durable plan is not a substitute for seeing the world change, and
 * it is not treated as one: it is the fourth term the message names, measured
 * where the runtime already reads it.
 */
export function planAdvanced(previous: RunLedgerDecision | null, current: RunLedgerDecision): boolean {
  if (!previous) return false;
  return previous.workOrderGoalId !== current.workOrderGoalId ||
    previous.workOrderStatus !== current.workOrderStatus ||
    previous.workOrderStage !== current.workOrderStage;
}

/**
 * Whether anything about the city changed that a run can be judged by.
 *
 * A moving frame is deliberately NOT this: a simulation that runs while the
 * city is unchanged is exactly the case worth reporting, so the frame belongs
 * to `worldAdvanced` and not here.
 */
export function cityChanged(
  previous: RunLedgerFacts | null,
  current: RunLedgerFacts,
  decision: RunLedgerDecision,
  /** The window before this one, for the progression term. */
  previousDecision: RunLedgerDecision | null = null,
): boolean {
  if (decision.applied.zoning > 0 || decision.applied.road > 0 || decision.applied.facility > 0) return true;
  if (planAdvanced(previousDecision, decision)) return true;
  if (!previous) return true;
  if (previous.population !== null && current.population !== null &&
      !sameNumber(previous.population, current.population)) return true;
  if (previous.serviceBuildingCount !== null && current.serviceBuildingCount !== null &&
      !sameNumber(previous.serviceBuildingCount, current.serviceBuildingCount)) return true;
  return false;
}

/**
 * Whether the Brain has declared that it is waiting for an effect.
 *
 * Only an explicit declaration counts. Letting the simulation run is not one:
 * it is the ordinary way a tick lets the world move, and if the city does not
 * answer across window after window, that silence is the finding rather than
 * its own excuse.
 */
export function legitimateWait(decision: RunLedgerDecision): boolean {
  return Boolean(decision.parkedReason) ||
    /WAIT|OBSERVE|ADVANCE_SIMULATION|PAUSED_FOR_BLOCKER/.test(decision.policyAnswer ?? "");
}

export interface RunLedgerOutcome {
  status: RunProgressStatus;
  reason: string;
  consecutiveNoEffect: number;
  /** Set once the run of no-effect windows reaches the threshold. */
  stallReason: string | null;
}

/**
 * Name what this window was.
 *
 * Ordered so the most specific, most actionable finding wins: a stopped session
 * outranks everything, a simulation that could not advance outranks a park, and
 * only when none of those apply does "nothing changed" get counted.
 */
export function classifyRunProgress(input: {
  previous: RunLedgerFacts | null;
  current: RunLedgerFacts;
  decision: RunLedgerDecision;
  /** The window before this one, so the progression term has something to compare against. */
  previousDecision?: RunLedgerDecision | null;
  /** No-effect windows before this one. */
  priorNoEffect: number;
}): RunLedgerOutcome {
  const { previous, current, decision } = input;

  if (decision.haltReason) {
    return { status: "RUNTIME_HALTED", reason: decision.haltReason, consecutiveNoEffect: 0, stallReason: null };
  }

  if (decision.simulation.outcome === "stalled" || decision.simulation.outcome === "absolute_budget") {
    const advanced = decision.simulation.framesAdvanced ?? 0;
    return {
      status: "SIMULATION_STALLED",
      reason: decision.simulation.reason ??
        `simulation wait ended as ${decision.simulation.outcome} after ${decision.simulation.elapsedMs}ms (${advanced} frames)`,
      consecutiveNoEffect: 0,
      stallReason: null,
    };
  }

  const plan = planAdvanced(input.previousDecision ?? null, decision);
  if (cityChanged(previous, current, decision, input.previousDecision ?? null)) {
    const applied = decision.applied;
    return {
      status: "WORLD_PROGRESSING",
      reason: `city changed: population=${current.population ?? "UNKNOWN"} ` +
        `serviceBuildings=${current.serviceBuildingCount ?? "UNKNOWN"} ` +
        `applied(zoning=${applied.zoning} road=${applied.road} facility=${applied.facility})` +
        ` plan=${decision.workOrderGoalId ?? "NONE"}:${decision.workOrderStatus ?? "NONE"}` +
        `${decision.workOrderStage ? `:${decision.workOrderStage}` : ""}${plan ? " (advanced)" : ""}`,
      consecutiveNoEffect: 0,
      stallReason: null,
    };
  }

  const consecutiveNoEffect = input.priorNoEffect + 1;
  // Only a world that was readable and did not move can be called stuck. A
  // world that is still running around an unchanged city is a finding to
  // report, not a reason to stop: the city may simply not have answered yet.
  const worldRan = worldAdvanced(previous, current);
  const stalled = consecutiveNoEffect >= RUN_LEDGER_NO_EFFECT_STALL_THRESHOLD &&
    worldClockReadable(previous) && worldClockReadable(current) && !worldRan;

  // Whether the simulation clock itself moved separates the two ways a city can
  // stand still: a world still running around an unchanged city, and a world
  // that has stopped being advanced at all.
  const detail =
    `no population, building, applied-effect or progression change for ${consecutiveNoEffect} bounded windows ` +
    `(${worldRan ? "the world advanced" : "the world did not advance"}; goal=${decision.goalId ?? "NONE"} ` +
    `policy=${decision.policyAnswer ?? "NONE"} ` +
    `workOrder=${decision.workOrderGoalId ?? "NONE"}:${decision.workOrderStatus ?? "NONE"}` +
    `${decision.workOrderStage ? `:${decision.workOrderStage}` : ""})`;
  // The stall reason is the ledger's only escalation: it says the run should
  // stop, and deliberately says nothing about what to do next.
  const stallReason = stalled ? `RUN_STALLED_NO_WORLD_EFFECT: ${detail}` : null;

  // A park is a reason, not progress, so it is read only once this window is
  // known to have changed nothing. Ordering it first made a single held-back
  // Goal family outrank every window the city did move — WORLD_PROGRESSING
  // became unreachable while anything was parked, and the counter it reset to
  // zero each time meant a parked family also switched the stall watchdog off.
  if (decision.parkedReason) {
    return {
      status: "PARKED_WITH_REASON",
      reason: decision.parkedFamily ? `${decision.parkedFamily}: ${decision.parkedReason}` : decision.parkedReason,
      consecutiveNoEffect,
      // A park that outlives the threshold on a world that is not moving is
      // stuck rather than patient: the facts it waits for cannot arrive.
      stallReason,
    };
  }

  if (legitimateWait(decision) && !stalled) {
    return { status: "WAITING_FOR_EFFECT", reason: decision.policyAnswer ?? detail, consecutiveNoEffect, stallReason: null };
  }

  return { status: "REPEATED_NO_EFFECT", reason: detail, consecutiveNoEffect, stallReason };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const numeric = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The labour facts a `/city/labor`-shaped read carries, or null if it did not resolve. */
export function runLedgerLaborFromRead(labor: unknown): RunLedgerFacts["labor"] {
  const root = record(labor);
  const jobs = record(root.jobs);
  const freeByEducation = record(jobs.freeByEducation);
  const breakdown: Record<string, number> = {};
  for (const [education, count] of Object.entries(freeByEducation)) {
    const parsed = numeric(count);
    if (parsed !== null) breakdown[education] = parsed;
  }
  const employed = numeric(root.employed);
  const unemploymentRate = numeric(root.unemploymentRate);
  const jobsTotal = numeric(jobs.total);
  const jobsFree = numeric(jobs.free);
  if (employed === null && unemploymentRate === null && jobsTotal === null && jobsFree === null &&
      Object.keys(breakdown).length === 0) return null;
  return { employed, unemploymentRate, jobsTotal, jobsFree,
    freeByEducation: Object.keys(breakdown).length > 0 ? breakdown : null };
}

/**
 * Read the ledger's facts out of the mayor snapshot the tick already holds.
 *
 * Every field is read defensively and left null when absent: an unread fact is
 * recorded as unread, never as zero. `buildingCount` comes from the snapshot's
 * own city-services summary, which counts service buildings only — it is what
 * the existing readback offers, and the ledger labels it for what it is rather
 * than inventing a census.
 */
export function runLedgerFactsFromSnapshot(
  snapshot: unknown,
  labor: unknown,
  builtButVacantByType: Record<string, number> | null = null,
): RunLedgerFacts {
  const root = record(snapshot);
  const game = record(root.game);
  const population = record(root.population);
  const economy = record(root.economy);
  const utilities = record(root.utilities);
  const utilityPair = (kind: string, supplyKey: string, demandKey: string) => {
    const utility = record(utilities[kind]);
    return { supply: numeric(utility[supplyKey]), demand: numeric(utility[demandKey]) };
  };
  const treasury = numeric(economy.treasury);
  const monthlyBalance = numeric(economy.monthlyBalance);
  const serviceBuildings = record(root.cityServices);
  let serviceBuildingCount: number | null = null;
  for (const service of Object.values(serviceBuildings)) {
    const count = numeric(record(service).buildingCount);
    if (count !== null) serviceBuildingCount = (serviceBuildingCount ?? 0) + count;
  }
  return {
    simulationFrame: numeric(game.frameIndex),
    gameDateTime: typeof game.gameDateTime === "string" ? game.gameDateTime : null,
    population: numeric(population.current),
    serviceBuildingCount,
    builtButVacantByType,
    treasury,
    monthlyBalance,
    // The same runway the growth policy derives: months of treasury at the
    // current deficit. A positive balance is unlimited runway, not a number.
    runwayMonths: treasury !== null && monthlyBalance !== null && monthlyBalance < 0 && treasury >= 0
      ? treasury / Math.abs(monthlyBalance)
      : treasury !== null && monthlyBalance !== null ? Number.POSITIVE_INFINITY : null,
    utilities: {
      electricity: utilityPair("electricity", "production", "consumption"),
      water: utilityPair("water", "capacity", "consumption"),
      sewage: utilityPair("sewage", "capacity", "consumption"),
    },
    labor: runLedgerLaborFromRead(labor),
  };
}

/** An all-null decision record, so a tick always has one to fill in. */
export const emptyRunLedgerDecision = (): RunLedgerDecision => ({
  goalId: null,
  goalType: null,
  policyAnswer: null,
  workOrderGoalId: null,
  workOrderStatus: null,
  workOrderStage: null,
  applied: { zoning: 0, road: 0, facility: 0 },
  parkedFamily: null,
  parkedReason: null,
  haltReason: null,
  simulation: { outcome: "not_run", elapsedMs: 0, framesAdvanced: null, reason: null },
});

/** The ledger as it lives on the session: a bounded window plus its counters. */
export interface RunLedgerState {
  entries: RunLedgerEntry[];
  consecutiveNoEffect: number;
  stallReason: string | null;
}

export const emptyRunLedgerState = (): RunLedgerState => ({
  entries: [],
  consecutiveNoEffect: 0,
  stallReason: null,
});

/**
 * Append one window and return the ledger's new state.
 *
 * Pure so the classification can be tested against fixed facts, and so the
 * runtime only has to hand it what it already read.
 */
export function appendRunLedgerEntry(
  state: RunLedgerState,
  input: { tick: number; at: string; facts: RunLedgerFacts; decision: RunLedgerDecision },
): RunLedgerState {
  const previousEntry = state.entries.at(-1) ?? null;
  const previous = previousEntry?.facts ?? null;
  const outcome = classifyRunProgress({
    previous,
    current: input.facts,
    decision: input.decision,
    previousDecision: previousEntry?.decision ?? null,
    priorNoEffect: state.consecutiveNoEffect,
  });
  const entry: RunLedgerEntry = {
    tick: input.tick,
    at: input.at,
    status: outcome.status,
    reason: outcome.reason,
    consecutiveNoEffect: outcome.consecutiveNoEffect,
    facts: input.facts,
    decision: input.decision,
  };
  return {
    entries: [...state.entries, entry].slice(-RUN_LEDGER_CAPACITY),
    consecutiveNoEffect: outcome.consecutiveNoEffect,
    stallReason: outcome.stallReason ?? state.stallReason,
  };
}
