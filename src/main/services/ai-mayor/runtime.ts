import { createHash } from "node:crypto";
import {
  addEstimatedRequestCost,
  canContinue,
  createDeepSeekSessionCostState,
  type DeepSeekSessionCostState,
  markSessionBalanceFailure,
  shouldStopForBudget,
  updateSessionBalance,
} from "@/intellichat/telemetry/deepseekCostGuard";
import { projectLocalMayorActivity } from "./local-mayor/activity";
import {
  createLocalGrowthIntent,
  nextLocalGrowthIntent,
  rebaseLocalGrowthIntentFromSnapshot,
} from "./local-mayor/corridor";
import {
  advanceLocalMayorObservation,
  classifyLocalDistrictLifecycle,
  classifyLocalMayorOutcomeImpact,
  decideLocalMayorEpisode,
  invalidateLocalMayorEpisode,
  localMayorActionabilityKey,
  localMayorGrowthDomain,
  recordLocalMayorOutcome,
  shouldEnsureGrowthOpportunity,
  shouldRefreshLocalMayorSupply,
} from "./local-mayor/decision";
import { evaluateServiceRecoveryReadback, recordServiceRecoveryAttempt } from "./local-mayor/service-recovery";
import { compileLocalMayorState } from "./local-mayor/state";
import { unlockedZoneCapabilities, zonePrefabForDomain } from "./action-candidates";
import { mayorUiSettings, type MayorUiSettings } from "./ui-settings";
import {
  DEFAULT_MAYOR_GROWTH_SETTINGS,
  GROWABLE_ZONE_CATEGORY_FOR_LAND_USE,
  growthPaceForPopulation,
  resolveGrowthSettings,
  type GrowableLandUse,
  type GrowthPace,
  type MayorGrowthMode,
  type MayorGrowthSettings,
  NEAR_TARGET_START_SHARE,
} from "./growth-mode";
import { rankedGrowthGoals } from "./v2/autonomous-brain";
import { districtIntentFrom, zoneForDensity } from "./v2/district-intent";
import { DEFAULT_OBJECTIVE_PROFILE, profileAllowsExpansion, profileUsesPipeline, type ObjectiveProfile } from "./v2/objective-profile";
import { stampElapsed, type GameStamp } from "./v2/game-clock";
import { describeDistrictOutcome } from "./v2/district-status";
import { checkpointSlotName, decideCheckpoint, memoryVerdict, WorldWatch } from "./v2/session-safety";
import type { DistrictUtilityReadings } from "./v2/district-utilities";
import { CARE_PRIMITIVES, DISTRICT_BUILDER_PRIMITIVES, isStructuredIntentInVocabulary, planStructuredIntent } from "./v2/intent-primitive-map";
import { type CareFocus, careFocusFrom } from "./v2/care-focus";
import { goalCompletionStageForGoalId, V2GrowableFootprintUnserviceableError } from "./v2/project-admission";
import {
  goalWorkOrderChainClosed,
  goalWorkOrderJournalProvesUnservableRoadTarget,
  type V2GoalWorkOrderRecord,
} from "./v2/durability";
import {
  appendRunLedgerEntry,
  emptyRunLedgerDecision,
  emptyRunLedgerState,
  runLedgerFactsFromSnapshot,
  type RunLedgerDecision,
} from "./v2/run-ledger";
import { simulationStageBudgetMs } from "./v2/simulation-wait-contract";
import {
  type LocalGrowthIntent,
  type LocalMayorGrowthDomain,
  type LocalMayorHistory,
  type LocalMayorState,
  type LocalTypedDevelopmentReserve,
  toMayorPlanActions,
} from "./local-mayor/types";
import { emptyMayorOperationalSignals, updateMayorOperationalSignals } from "./operational-signals";
import { buildMayorPrompt } from "./prompt";
import {
  emptyMayorMemory,
  MAYOR_BATCH_RESULT_MAX_BYTES,
  MAYOR_FAST_MAX_CANDIDATES,
  MAYOR_MEMORY_MAX_BYTES,
  MAYOR_SNAPSHOT_MAX_BYTES,
  mergeMayorMemory,
  normalizeMayorPlanForSpeed,
  parseMayorPlan,
  validateMayorPlanAgainstSnapshot,
} from "./schema";
import { MAYOR_SKILL } from "./skill";
import type {
  MayorBatchResult,
  MayorCommand,
  MayorRuntimePorts,
  MayorSessionState,
  MayorStageName,
  MayorStageTraceEntry,
  MayorStructuredGoalIntent,
  MayorTelemetryTotals,
  MayorTickTelemetry,
  StartMayorSessionOptions,
} from "./types";
import { readUrbanDesignSnapshot } from "./urban-design/prompt-context";
import { buildUtilityPreparationInput, type AuthoritativeUtilityAdmissionContext } from "./v2/utility-admission-context";
import { renderMayorEvent, type MayorEvent, type MayorSubject } from "./mayor-commentary";

const MAX_RECENT_TELEMETRY = 20;
const MAX_BRIDGE_FAILURES = 3;
const MAX_MODEL_FAILURES = 3;
const MAX_VALIDATION_FAILURES = 2;
const MAX_BATCH_FAILURES = 3;
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TICK_DELAY_MS = 1_000;
const LOCAL_MAYOR_ACTIONABILITY_BACKOFF = 3;
const LOCAL_MAYOR_ZERO_PROGRESS_DELAY_MS = 250;
const LOCAL_MAYOR_EXECUTION_TIMEOUT_MS = 30_000;
const LOCAL_MAYOR_STAGE_TIMEOUT_MS = 90_000;
const AUTONOMOUS_CONSTRUCTION_WAIT_DELAY_MS = 500;
/**
 * How much simulated time one growth-observation step covers, when the pace does
 * not name its own.
 *
 * The Brain's growth policy is a pure function of authoritative world facts, so
 * "nothing to build yet" is answered by letting the city run and reading again —
 * occupancy, demand and service load only move while the simulation does.
 */
const AUTONOMOUS_GROWTH_OBSERVATION_HOURS = 1;

/**
 * Identity facts for one growth Goal. `worldFingerprint` deliberately includes
 * volatile snapshot fields, so it is useful for detecting changes but too broad
 * to be a Goal lineage key: a treasury tick or an unrelated service update must
 * not mint another full successor budget for the same target. This projection
 * carries the inputs that can materially change whether this growth family is
 * still warranted or admissible.
 */
export function growthGoalFactFingerprint(goalId: string, landUse: GrowableLandUse,
  state: LocalMayorState): string {
  const demand = GROWABLE_ZONE_CATEGORY_FOR_LAND_USE[landUse];
  const financeBand = state.financeRunwayMonths === null ? "unknown"
    : state.financeRunwayMonths < 3 ? "critical"
      : state.financeRunwayMonths < 8 ? "constrained" : "healthy";
  const facts = {
    goalId,
    landUse,
    population: state.population,
    demand: state.demands[demand],
    capacity: {
      status: state.actionability.capacityStatus,
      reserveStatus: state.developmentCapacity.reserveStatus,
      safeUnzonedCells: state.developmentCapacity.safeUnzonedCells,
      availableDevelopmentCells: state.developmentCapacity.availableDevelopmentCells,
      typedReserve: state.developmentCapacity.zonedUnoccupiedByType?.[demand] ?? null,
      typedDeficit: state.developmentCapacity.typedReserveDeficit?.[demand] ?? null,
    },
    candidateSupply: [...state.candidates.zoning, ...state.candidates.roadExpansion]
      .map(({ id, kind, areaType }) => [id, kind, areaType]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    utilities: Object.fromEntries(Object.entries(state.utilities).map(([kind, utility]) => [kind, {
      available: utility.available, risk: utility.risk, uncommissioned: utility.uncommissioned,
    }])),
    financeBand,
    treasuryAdmissionBand: state.treasury === null ? "unknown" : Math.floor(Math.max(0, state.treasury) / 2500),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 12);
}

/**
 * Identity facts for one proven-unserviceable growth TARGET.
 *
 * The same projection as above is the wrong key for a target that a bounded
 * search has already disproven: it carries population, demand, candidate supply
 * and a treasury band, all of which the Brain's own observation step moves every
 * cycle, so a park keyed on it releases on the next tick and the dead target is
 * retried forever. Measured live (2026-09-30): eight ticks, a new parent facts
 * hash each one, a fresh `ROAD_FRONTAGE` child each one, and a journal that
 * never moved.
 *
 * This projection carries only the local land facts that decide whether the
 * target can be zoned — the geography does not change because a treasury ticked
 * or the population grew, and it does change when a cell is zoned, a building
 * appears, a road is delivered, or the anchor's candidate set is re-read. So the
 * park holds across an unchanged city and releases the moment the land is not.
 */
export function growthFootprintTargetFingerprint(targetKey: string, state: LocalMayorState): string {
  const facts = {
    targetKey,
    capacity: {
      reserveStatus: state.developmentCapacity.reserveStatus,
      safeUnzonedCells: state.developmentCapacity.safeUnzonedCells,
      safeUnzonedRoadsideCells: state.developmentCapacity.safeUnzonedRoadsideCells,
      existingZonedCells: state.developmentCapacity.existingZonedCells,
      existingZonedUnoccupiedCells: state.developmentCapacity.existingZonedUnoccupiedCells,
      availableDevelopmentCells: state.developmentCapacity.availableDevelopmentCells,
      developmentDigesting: state.developmentCapacity.developmentDigesting,
    },
    candidates: [...state.candidates.zoning, ...state.candidates.roadExpansion]
      .map(({ id, kind, areaType }) => [id, kind, areaType]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 12);
}

/**
 * What one suppressed growth family is being held back by.
 *
 * `FACTS` is the original park: the whole family, while the growth-relevant
 * world facts that justified its failed search still hold. `TARGET` is the one
 * a bounded search disproved by name: one region, while that region's own land
 * is unchanged. Two key spaces on purpose — "the city still needs this" and
 * "this land still cannot take it" are different questions, and collapsing them
 * is what let one dead target veto every later Goal of its family.
 */
type GrowthGoalPark =
  | { kind: "FACTS"; fingerprint: string }
  | {
      kind: "TARGET";
      subjectKey: string;
      /** The family this target was being pursued for, so it can be escalated. */
      family: string;
      landUse: GrowableLandUse;
      fingerprint: string;
      /** How many admissions have been disproved on exactly this ground. */
      strikes: number;
      /**
       * Released for one cycle so the family can try another site.
       *
       * A one-shot flag rather than a deletion: the strike count is what bounds
       * the ladder, and a park that erased itself on release could never count
       * its own second failure.
       */
      released: boolean;
    };

/**
 * How many admissions may be disproved on the same ground before the domain
 * itself, rather than one target, is treated as the finding.
 *
 * One dead target is not proof that a whole growth domain is unavailable — the
 * land search has other candidates, and it is the search's job to find them.
 * Three attempts on the same ground, however, is no longer bad luck, and the
 * family is then held back on the ordinary facts fingerprint, which releases
 * the moment the land actually changes.
 */
export const GROWTH_TARGET_PARK_STRIKE_LIMIT = 3;
/**
 * How many consecutive Brain cycles one work order may produce no durable
 * progress at all before it stops owning the Brain.
 *
 * Three, matching the target-park strike limit, because it is the same kind of
 * judgement: two empty cycles are a slow read, three is a work order that is not
 * going to move on its own. The cost of being wrong in one direction is three
 * wasted cycles; in the other it is a whole city that never builds again.
 */
export const WORK_ORDER_STALL_CYCLES = 3;
/**
 * Task kinds that are construction the Brain can execute without the world
 * having to move first. `SITE_SELECTION` is planning, the other three write.
 */
const EXECUTABLE_CONSTRUCTION_TASK_KINDS: ReadonlySet<string> =
  new Set(["SITE_SELECTION", "ROAD_CONNECTION", "ZONING", "RECOVERY"]);

/**
 * Whether running the city can produce the fact a WAITING operation needs.
 *
 * Only `DEPENDENT_CONSTRUCTION` says no: that wait is satisfied by another
 * operation's construction — a base utility Goal's `NO_ATTRIBUTED_BUILDING`,
 * for instance — and no amount of simulated time will supply it. Measured live
 * (2026-10-01): one such wait held the whole tick and every simulation window
 * in it while the other expansion domains were never reached.
 *
 * An absent wake keeps the pre-existing behaviour (advance the world), so this
 * narrows exactly one case and nothing else.
 */
const wakeNeedsTheWorldToRun = (wake?: { condition?: string } | null): boolean =>
  wake?.condition !== "DEPENDENT_CONSTRUCTION";
/**
 * How many times one cycle may re-enter progression on executable work before
 * it yields the world a turn.
 *
 * A burst, not a spin: the first re-entry is the package the tranche is holding.
 * A tranche whose own task keeps refusing without changing anything would
 * otherwise re-run the same refusal forever, and the world advance is what lets
 * a bounded fallback find a different answer.
 */
export const AUTONOMOUS_BUILD_BURST_ATTEMPTS = 3;

/**
 * Whether an admission refusal is a finding about the Goal's own domain rather
 * than about the world.
 *
 * The distinction decides whether the Brain moves to the next domain inside the
 * same cycle or yields the city to a wait. A refusal about this Goal's land, or
 * about this Goal's own bounded work being spent, says nothing about any other
 * domain — and letting the city run cannot change either, because the search
 * already read that land. A refusal about the *world* — an unreadable census,
 * an unusable observation — is the opposite: re-reading is exactly what can
 * change it, so the cycle stops and observes.
 *
 * "Unproven" is deliberately on the domain side and parks nothing. A native read
 * that did not resolve has disproved nothing, and treating it as a verdict about
 * the family is how a Bridge hiccup used to suppress a whole land use.
 */
function isDomainScopedRefusal(failure: string): boolean {
  // `GOAL_SUCCESSOR_BUDGET_EXHAUSTED` is the name admission actually throws; the
  // walk's cap was whitelisted here under `GOAL_SUCCESSOR_STEPS_EXHAUSTED`, a
  // string nothing throws, so reaching the cap was classified as a WORLD refusal
  // and the cycle waited on the simulation instead of asking the next domain.
  // Both spellings are matched so a durable history written either way reads the
  // same.
  return /PROJECT_ADMISSION_GROWABLE_FOOTPRINT_UNSERVICEABLE|PROJECT_ADMISSION_NO_ELIGIBLE_SITE|PROJECT_ADMISSION_NO_VALID_SITE|PROJECT_ADMISSION_NO_STARTER_ANCHOR|GOAL_PREREQUISITE_STEP_BUDGET_EXHAUSTED|GOAL_PREREQUISITE_ALREADY_SPENT|GOAL_WORK_ORDER_RELEASED_SCOPE_SUCCESSOR_REQUIRED|GOAL_SUCCESSOR_BUDGET_EXHAUSTED|GOAL_SUCCESSOR_STEPS_EXHAUSTED|GOAL_SUCCESSOR_UNSERVABLE_ROAD_TARGET|PROJECT_ADMISSION_ZONING_CENSUS_UNPROVEN|GROWABLE_FAST_PATH_ZONE_BLOCK_CENSUS_UNPROVEN|GROWABLE_FAST_PATH_NO_OWNED_LOCAL_ROAD|PROJECT_ADMISSION_SITE_OBSERVATION_UNKNOWN/.test(failure);
}

/**
 * A refusal that names a native capability the runtime does not have.
 *
 * Distinct from a refusal about the world, the land, or this Goal's own bounded
 * work: the zone prefab a Goal's deliverable needs is not exposed by the
 * catalogue at all, so it is re-read every cycle rather than remembered.
 */
const ZONE_CAPABILITY_GAP = /GATE1_[A-Z]+_ZONE_PREFAB_UNAVAILABLE/;

/** The most expansion tranches one cycle may settle, whatever the treasury says. */
const GROWTH_BATCH_MAXIMUM_ITEMS = 6;

/**
 * How many expansion tranches one cycle settles.
 *
 * A capacity dial, not a cadence: every tranche in a batch repeats the same
 * fixed costs — a ring census, a corridor plan, native previews, an admission, an
 * Apply and a readback — so the more the city can pay for, the more of that cost
 * one cycle spreads. Read off the finance runway rather than the treasury
 * balance because a runway is what says whether the NEXT tranche is affordable,
 * and clamped so a cycle cannot run away with the tick.
 *
 * Deliberately not the pace dial: pace is the posture the player chose, this is
 * what the city can actually settle right now.
 */
const growthBatchSize = (state: { financeRunwayMonths: number | null }): number => {
  const runway = state.financeRunwayMonths;
  if (runway === null) return GROWTH_BATCH_MAXIMUM_ITEMS;
  if (runway >= 36) return GROWTH_BATCH_MAXIMUM_ITEMS;
  if (runway >= 18) return 4;
  if (runway >= 9) return 3;
  if (runway >= 4) return 2;
  return 1;
};

/** The family key a park or Goal id belongs to, from its land use. */
const growthFamilyKey = (landUse: GrowableLandUse) => `EXPAND_${landUse}:${landUse.toLowerCase()}`;

/**
 * The land use a growth Goal id or family key names.
 *
 * Read from the land-use table rather than a chain of comparisons, so a land use
 * added to the product is recognized by every reader at once. An id that names
 * none of them reads as residential, which is the pre-office behaviour and the
 * only land use a legacy Goal id can have meant.
 */
const landUseOfExpansionGoalId = (goalIdOrFamily: string): GrowableLandUse => {
  const match = /^EXPAND_([A-Z]+)\b/.exec(goalIdOrFamily);
  const landUse = match?.[1] as GrowableLandUse | undefined;
  return landUse && GROWABLE_ZONE_CATEGORY_FOR_LAND_USE[landUse] ? landUse : "RESIDENTIAL";
};

const growthLandUseOfFamilyKey = (family: string): GrowableLandUse => {
  const suffix = family.slice(family.lastIndexOf(":") + 1);
  const match = (Object.keys(GROWABLE_ZONE_CATEGORY_FOR_LAND_USE) as GrowableLandUse[])
    .find((landUse) => landUse.toLowerCase() === suffix);
  return match ?? "RESIDENTIAL";
};
/**
 * How many times one unchanged Brain failure may repeat inside a continuous
 * session before the session stops and reports it.
 *
 * A Goal running out of legal candidates is ordinary working life and the next
 * cycle re-observes; an invariant that fails identically every cycle is not
 * going to fix itself, and reporting it is more useful than retrying it forever.
 */
const MAX_BRAIN_REPEATED_FAILURES = 6;
/**
 * How many "let the city run" steps one Brain cycle takes while Gate1 reports
 * WAITING, and how much simulated time each covers.
 *
 * WAITING means the world has not produced the fact the next decision depends
 * on — a placed facility that is not operational yet, a zoned lot nothing has
 * moved into yet. Re-reading a paused world cannot produce it; simulated time
 * can. The bound keeps a genuinely stuck wait from running the city clock away.
 */
const AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS = 4;
/** How long the civic path rests after a cycle that placed nothing: 3 game hours (3 ticks, with no readable game clock). */
const CIVIC_REST_HOURS = 3;
const CIVIC_REST_TICKS = 3;
const AUTONOMOUS_WAIT_SIMULATION_HOURS = 0.5;
/**
 * The wait when the builder finds nothing to build. Measured live (2026-10-04): the full 0.5 h window was 23.7 s of wall clock in which the Mayor
 * wrote nothing and only polled `cs2_game_state` once a second. After a district there is no window at all (see `#buildNextDistrict`). Here the
 * city is genuinely idle and the window passes the blocking-modal guard, so it stays, only as long as the next reading needs to differ: 0.1 h,
 * about 4.7 s at 4x (0.5 h = 23.7 s measured). 0.1 h is also the shortest run `cs2_run_simulation` accepts (`hours` min 0.1): a shorter one
 * was refused, its cleanup cancel paused the city every cycle, and the run ledger stopped the session within a minute (measured live 2026-10-04).
 */
const AUTONOMOUS_BRIEF_WINDOW_HOURS = 0.1;
/** The books update by the hour and a service or a tax needs days to show in them, so a recovery step lets the city run this long (measured: a game day is over an hour of wall clock at 4x on this city). */
const RECOVERY_WINDOW_HOURS = 3;
/** A Goal id whose bounded work is a service Goal's, including its prerequisites. */
const SERVICE_GOAL_ID = /(?:UTILITY_SERVICE|PROVIDE_SERVICE):(?:electricity|water|sewage)\b/;
const MAX_STAGE_TRACE = 64;
function canonicalGrowableLandUseForGoalId(goalId: string): GrowableLandUse | undefined {
  // This is the parent's own stable Goal identity, not the ROAD_FRONTAGE child's
  // kind. It also lets a pre-existing durable child resume after upgrade when it
  // predates the explicit parentLandUse metadata below.
  // Read from the land-use table rather than three hand-written patterns, so a
  // land use added to the product cannot be recognized by the Brain and missed
  // by the parent-resume path.
  const match = /^EXPAND_([A-Z]+):([a-z]+):facts:/.exec(goalId);
  if (!match) return undefined;
  const landUse = match[1] as GrowableLandUse;
  return GROWABLE_ZONE_CATEGORY_FOR_LAND_USE[landUse] === match[2] ? landUse : undefined;
}
export const hasGreenfieldUtilityProof = (snapshot: unknown) => {
  const root = typeof snapshot === "object" && snapshot !== null ? snapshot as Record<string, any> : {};
  const population = Number(root.population?.current ?? 0);
  const utilities = root.utilities ?? {};
  const electricity = utilities.electricity ?? {};
  const water = utilities.water ?? {};
  const sewage = utilities.sewage ?? {};
  return population > 0 && Number(electricity.production ?? 0) > 0
    && Number(electricity.fulfilledConsumption ?? 0) >= Number(electricity.consumption ?? 0)
    && Number(water.capacity ?? 0) > 0 && Number(sewage.capacity ?? 0) > 0;
};
/**
 * The stage watchdog's budget for one simulation run, re-exported from the
 * shared wait contract so a tick's outer bound and the adapter's own bound are
 * always derived from the same estimate.
 */
export { simulationStageBudgetMs };

const totals = (): MayorTelemetryTotals => ({
  apiRequestCount: 0,
  promptTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedCnyCost: 0,
});

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const annotateLocalMayorActionability = (snapshot: unknown, actionability: Record<string, unknown>) => ({
  ...(typeof snapshot === "object" && snapshot !== null ? snapshot : {}),
  localMayorActionability: actionability,
});
const annotateLocalGrowthIntent = (snapshot: unknown, domain: LocalMayorGrowthDomain | undefined) => {
  if (!domain || typeof snapshot !== "object" || snapshot === null) return snapshot;
  const root = snapshot as Record<string, any>;
  const planning = root.actionablePlanning;
  if (!planning || !Array.isArray(planning.candidates)) return snapshot;
  const candidates = planning.candidates
    .map((candidate: any) => ({
      ...candidate,
      growthDomain: domain,
    }))
    .sort(
      (left: any, right: any) =>
        Number(right.areaType?.toLowerCase() === domain) - Number(left.areaType?.toLowerCase() === domain) ||
        String(left.id).localeCompare(String(right.id)),
    );
  return { ...root, actionablePlanning: { ...planning, candidates } };
};
const annotateLocalMayorCorridor = (snapshot: unknown, intent: LocalGrowthIntent | undefined) => {
  if (!intent || typeof snapshot !== "object" || snapshot === null) return snapshot;
  return { ...(snapshot as Record<string, unknown>), localGrowthIntent: intent };
};
const annotateLocalDistrictTakeover = (
  snapshot: unknown,
  takeover: { previousSiteId: string | null; searchRevision: string | null; checkedSources: string[]; outcome: string },
) => ({
  ...(typeof snapshot === "object" && snapshot !== null ? snapshot : {}),
  districtTakeover: takeover,
});

function defaultDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

async function boundedLocalExecution<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
  const watchdog = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("candidate_execution_timeout")), LOCAL_MAYOR_EXECUTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, abort, watchdog]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class MayorRuntimeStageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly operation: string,
    readonly elapsedMs: number,
  ) {
    super(`runtime_stage_timeout:${stage}:${operation}`);
    this.name = "MayorRuntimeStageTimeoutError";
  }
}

async function boundedRuntimeAwait<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  stage: string,
  operationName: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
  const watchdog = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new MayorRuntimeStageTimeoutError(stage, operationName, Date.now() - startedAt));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, abort, watchdog]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function linkedAbortController(parent: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new Error("aborted"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return { controller, unlink: () => parent.removeEventListener("abort", abort) };
}

/**
 * The built-but-vacant stock, read from the durable tranches that observed it.
 *
 * Gate 1 records, per tranche, the buildings it attributed to its own land use
 * and the subset of them that has residents. The difference is real, already
 * observed vacancy — and it is the half of the city's unabsorbed supply the
 * growth policy otherwise cannot see, because a zoned cell leaves
 * `zonedUnoccupied` the moment a building appears on it whether or not anybody
 * ever moves in.
 *
 * Returns null when no durable tranche has observed occupancy at all, so an
 * unobserved stock stays unobserved rather than being reported as zero.
 */
export function builtButVacantFromGoalOrders(
  orders: readonly V2GoalWorkOrderRecord[],
): LocalTypedDevelopmentReserve | null {
  const vacant: LocalTypedDevelopmentReserve = { residential: 0, commercial: 0, industrial: 0, office: 0, unknown: 0 };
  let observed = false;
  for (const order of orders) {
    const progress = order.state?.tranche?.effect_progress;
    if (!progress) continue;
    const built = progress.attributedResidentialBuildings;
    const occupied = progress.occupiedResidentialBuildings;
    if (!Array.isArray(built) || !Array.isArray(occupied)) continue;
    observed = true;
    const gap = Math.max(0, built.length - occupied.length);
    if (gap === 0) continue;
    // Gate 1 attributes buildings of the tranche's OWN land use, so the Goal's
    // own land use is what the gap belongs to. An id that names none of them is
    // left out rather than guessed into a domain.
    const landUse = /EXPAND_(RESIDENTIAL|COMMERCIAL|INDUSTRIAL|OFFICE)\b/.exec(order.goalId)?.[1]?.toLowerCase();
    if (landUse === "residential" || landUse === "commercial" || landUse === "industrial" || landUse === "office") {
      vacant[landUse] += gap;
    } else {
      vacant.unknown += gap;
    }
  }
  return observed ? vacant : null;
}

/**
 * Whether a durable Goal work order is proof that an expansion family's target
 * cannot be served by a Road, and therefore that the family must be parked.
 *
 * The finding itself is `goalWorkOrderJournalProvesUnservableRoadTarget`'s — the
 * one predicate both this family park and admission's successor walk read, so
 * "this target is not Road-deliverable" cannot mean two different things on the
 * two paths that have to agree about it.
 *
 * A Goal whose admission is answered by a prerequisite never gets a work order
 * of its own — `admitProject` throws the prerequisite and the child IS that
 * Goal's execution — so reading only parents missed the finding entirely. The
 * family was then re-derived every tick with a fresh facts hash, each derivation
 * minting another blocked child at the same target while the parent Goal never
 * reached a decision of its own.
 */
export function goalOrderUnservableRoadTarget(order: {
  goalId: string;
  parentGoalId?: string | null;
  status: string;
  state: { journal?: ReadonlyArray<{ failureClassification?: string | null; reason?: string | null }> };
}): { goalFamily: string; factsFingerprint: string } | null {
  if (order.status !== "BLOCKED") return null;
  // A service Goal (`PROVIDE_SERVICE:electricity`…) is answered by the same Road step, and measured live
  // (2026-10-02) it died at the SAME node window after window because only EXPAND_* families were
  // remembered. Its family is its own Goal id, which is the key the ranking suppresses by.
  const goal = /^(EXPAND_RESIDENTIAL|EXPAND_COMMERCIAL|EXPAND_INDUSTRIAL|EXPAND_OFFICE|PROVIDE_SERVICE:(?:electricity|water|sewage))(?::[a-z]+)?:facts:([a-f0-9]{12})(?::(?:successor:[a-f0-9]+|prerequisite:ROAD_(?:ACCESS|FRONTAGE):\d+:[a-f0-9]+)|$)/
    .exec(order.goalId);
  if (!goal) return null;
  // Children other than a Road prerequisite are not this family's Road step.
  if (order.parentGoalId && !order.goalId.includes(":prerequisite:")) return null;
  if (!goalWorkOrderJournalProvesUnservableRoadTarget(order)) return null;
  return { goalFamily: goal[1], factsFingerprint: goal[2] };
}

/** Cycles a named city problem stays first in the care round. */
const CARE_FOCUS_CYCLES = 10;
/** A finance recovery the player asked for: reads whose average must not be negative before it ends, and the cycles after which it ends anyway. */
const FINANCE_BY_PLAYER_SETTLED_READS = 6;
const FINANCE_BY_PLAYER_MAXIMUM_CYCLES = 40;

export class MayorRuntime {
  #state: MayorSessionState | null = null;
  #lifecycleStatus: "OFFLINE" | "STARTING" | "RUNNING" | "FAILED" | "STOPPED" = "OFFLINE";
  #lifecycleLastError: string | null = null;
  #startCallCount = 0;
  #lastStartResult: "RUNNING" | "FAILED" | null = null;
  #cost: DeepSeekSessionCostState | null = null;
  #model = DEFAULT_MODEL;
  #tickDelayMs = DEFAULT_TICK_DELAY_MS;
  #tickPromise: Promise<MayorSessionState> | null = null;
  #continuousPromise: Promise<MayorSessionState> | null = null;
  #autonomousConstructionPromise: Promise<unknown> | null = null;
  #productionResumeAttempts = 0;
  #abortController = new AbortController();
  /** The district cycle in progress, which a pause of the player's ends at the next write (`interruptCycle`). */
  #cycleAbort: AbortController | null = null;
  #lastFailureKind: string | null = null;
  #finalized = false;
  #speed: "normal" | "fast" = "normal";
  #decisionMode: "deepseek" | "fast" | "local" = "deepseek";
  #localHistory: LocalMayorHistory = { recentActions: [], cooldowns: [], consecutiveWaits: 0 };
  #localState: ReturnType<typeof compileLocalMayorState> | null = null;
  #expectedLocalMutation = false;
  #lastLocalSupplyRefreshKey: string | null = null;
  #localLastMeaningfulAction: string | null = null;
  #localGrowthDomain: LocalMayorGrowthDomain | undefined;
  #localGrowthIntent: LocalGrowthIntent | undefined;
  #localActionabilityBlock: {
    key: string;
    snapshotRevision: string | null;
    reasonCode: string;
    reason: string;
    remainingObservations: number;
  } | null = null;
  #localConsecutiveZeroProgressIterations = 0;
  #consecutiveNoProgressDecisions = 0;
  #noProgressGuardEnabled = false;
  #growthCadenceState: {
    successfulBurstsSinceAbsorb: number;
    absorbRequired: boolean;
  } = { successfulBurstsSinceAbsorb: 0, absorbRequired: false };
  #stageTraceEnabled = false;
  #stageTimeoutMs = LOCAL_MAYOR_STAGE_TIMEOUT_MS;
  #stageStartedAt = new Map<string, number>();
  #localTickProgress: {
    kind: "none" | "execution" | "simulation" | "yield" | "observation";
    gameTimeAdvanced: boolean;
    worldRevisionChanged: boolean;
  } = { kind: "none", gameTimeAdvanced: false, worldRevisionChanged: false };
  #tickMadeProgress = false;
  #brainLastFailureReason: string | null = null;
  #brainRepeatedFailureCount = 0;
  /** This tick's run-ledger record, filled in as the tick learns things. */
  #runLedgerDecision: RunLedgerDecision = emptyRunLedgerDecision();
  /** This tick's read-only labour view, or null when it could not be read. */
  #runLedgerLabor: unknown = null;
  /** This tick's built-but-vacant stock, or null when no tranche observed it. */
  #runLedgerBuiltButVacant: Record<string, number> | null = null;
  #pendingStructuredIntent: MayorStructuredGoalIntent | null = null;
  /** The city problems the player named (`v2/care-focus.ts`), kept first in the care round for a few cycles. */
  #careFocus: { focus: CareFocus[]; cyclesLeft: number; fresh: boolean } | null = null;
  #parkedGrowthGoalFacts = new Map<string, GrowthGoalPark>();
  /**
   * The player-facing pacing configuration.
   *
   * Defaulted here rather than injected so a build with no settings source runs
   * the frozen default policy exactly: full-speed expansion, braking
   * automatically at 100,000 residents. `setGrowthSettings` is the seam the
   * player-facing switch and target-population input will use.
   */
  #growthSettings: MayorGrowthSettings = DEFAULT_MAYOR_GROWTH_SETTINGS;

  constructor(private readonly ports: MayorRuntimePorts) {}

  /**
   * The gameplay objective: what result the cycle is chasing and what it may cost (see `v2/objective-profile.ts`). The
   * Mayor, the world reading, the execution primitives and the loop are the same under every profile.
   */
  #objectiveProfile: ObjectiveProfile = DEFAULT_OBJECTIVE_PROFILE;
  #recovered = false;
  /**
   * The player said the city loses money (care focus FINANCE): the recovery profile took the lead (growth stops) and this is the profile to go back to once the
   * finance loop calls the books recovered. The player's word outranks the growth path, and it ends by itself — nothing is left switched.
   */
  #financeByPlayer: { before: ObjectiveProfile; cycles: number } | null = null;
  get objectiveProfile(): ObjectiveProfile { return this.#objectiveProfile; }
  /** The player said "stop expanding" (until they say "go on"): nothing is built outward, the city that stands is still cared for. */
  #expansionHeldByPlayer = false;
  get expansionHeldByPlayer(): boolean { return this.#expansionHeldByPlayer; }
  holdExpansion(held: boolean): void {
    this.#expansionHeldByPlayer = held;
    if (this.#state) this.#state.lastStatus = held ? "EXPANSION_HELD_BY_PLAYER" : "EXPANSION_RESUMED_BY_PLAYER";
    this.#emit("status");
  }
  setObjectiveProfile(profile: ObjectiveProfile): void {
    this.#objectiveProfile = profile;
    this.#recovered = false;
  }

  /** Which expansion policy is in force. */
  get growthMode(): MayorGrowthMode {
    return this.#growthSettings.mode;
  }

  get growthSettings(): MayorGrowthSettings {
    return { ...this.#growthSettings };
  }

  /**
   * Reconfigure pacing. Every field is optional and every unusable value falls
   * back to the frozen default, so a half-filled settings surface can never
   * produce a Mayor that builds nothing.
   */
  setGrowthSettings(settings: Partial<MayorGrowthSettings>): MayorGrowthSettings {
    this.#growthSettings = resolveGrowthSettings({ ...this.#growthSettings, ...settings });
    this.#emit("status");
    return this.growthSettings;
  }

  /**
   * The player's switches about the game's own UI (see `ui-settings.ts`). `autoDismissMilestoneModal` decides whether the Mayor closes an
   * ordinary milestone popup itself; it is read at the moment of each check, so a button can flip it while the Mayor runs.
   */
  get uiSettings(): MayorUiSettings {
    return mayorUiSettings.get();
  }

  setUiSettings(settings: Partial<MayorUiSettings>): MayorUiSettings {
    const next = mayorUiSettings.set(settings);
    this.#emit("status");
    return next;
  }

  /** The pace the city's own population currently asks for. */
  growthPace(population: number | null | undefined) {
    return growthPaceForPopulation(population, this.#growthSettings);
  }

  /**
   * Watch one work order for durable progress.
   *
   * A Goal owns the Brain while it still has a step to take, which is the right
   * rule — but "still has a step" was read only from the work order's own
   * lifecycle, so a work order that neither advances nor closes owned the Brain
   * forever. Measured live (2026-09-30) on a commercial Goal carried over from an
   * earlier session: stage frozen at `ROAD_DELIVERED`, journal frozen at
   * position 93, identical across eight Brain cycles and across two independent
   * runs — while every other expansion domain the city could have built in was
   * never even asked for.
   *
   * The signature is the work order's own durable progress, so a Goal that
   * advances is never disturbed. Only a work order that has produced no change
   * at all for {@link WORK_ORDER_STALL_CYCLES} consecutive cycles is treated as
   * stalled, and even then nothing is written by hand: the Brain simply stops
   * letting it veto its successor, which the existing displacement path then
   * handles.
   */
  #workOrderProgress: { workOrderId: string; signature: string; unchangedCycles: number } | null = null;

  #noteWorkOrderProgress(order: { workOrderId: string; goalId: string; status: string;
    state?: { tranche?: { stage?: string }; journal?: ReadonlyArray<unknown>; tasks?: ReadonlyArray<{ kind: string; status: string; attempts?: number }> } } | null): boolean {
    if (!order) { this.#workOrderProgress = null; return false; }
    const signature = JSON.stringify([order.status, order.state?.tranche?.stage ?? null,
      order.state?.journal?.length ?? 0,
      (order.state?.tasks ?? []).map((task) => `${task.kind}:${task.status}:${task.attempts ?? 0}`)]);
    const watch = this.#workOrderProgress;
    if (!watch || watch.workOrderId !== order.workOrderId || watch.signature !== signature) {
      this.#workOrderProgress = { workOrderId: order.workOrderId, signature, unchangedCycles: 0 };
      return false;
    }
    watch.unchangedCycles += 1;
    return watch.unchangedCycles >= WORK_ORDER_STALL_CYCLES;
  }

  /** Forget the progress watch, so a freshly admitted Goal starts its own count. */
  #forgetWorkOrderProgress(): void {
    this.#workOrderProgress = null;
  }

  /**
   * Whether the active tranche still holds construction it can do right now.
   *
   * This is the BUILD BURST question, and it is asked before every world
   * advance: a tranche with a pending `SITE_SELECTION`, `ROAD_CONNECTION`,
   * `ZONING` or `RECOVERY` task has work the Brain can do without the
   * simulation, so letting the city run is not a wait — it is time the Mayor
   * spent not building.
   *
   * Measured live (2026-10-01): eleven `cs2_run_simulation` calls produced two
   * mutations, and 1002 of 1231 native calls were the auto-pause polling those
   * runs spend inside the adapter. The work those minutes were spent waiting for
   * was already executable.
   *
   * Only `PENDING` counts. A `WAITING` task with a command in flight is
   * reconciling an authoritative answer, which is exactly a fact the world has
   * to supply.
   */
  #activeTrancheHasExecutableWork(): boolean {
    const order = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
    const tasks = (order?.state as { tasks?: ReadonlyArray<{ kind: string; status: string }> } | undefined)?.tasks ?? [];
    return tasks.some((task) => task.status === "PENDING" && EXECUTABLE_CONSTRUCTION_TASK_KINDS.has(task.kind));
  }

  /**
   * Whether the active tranche has handed the rest of its work to the world.
   *
   * A tranche at `ZONED_WAITING_FOR_BUILDING` has already delivered everything
   * the Mayor controls: its road is built, its land is zoned, and the buildings
   * that follow are the simulation's answer. Nothing about that becomes more
   * true because the Brain sat and watched it. Another domain can be zoned while
   * this one grows, and displacing the work order costs nothing that has not
   * already been banked — the zoning is durable and the simulation does not
   * care which Goal is nominally active.
   *
   * "In flight" is excluded: a dispatched task or an unsettled command is an
   * authoritative question that has not been answered, and displacing the scope
   * it belongs to would leave the reconciliation nowhere to put its answer.
   */
  #activeTrancheAwaitsTheWorld(): boolean {
    const order = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
    if (!order || order.status !== "ACTIVE") return false;
    const tasks = (order.state as { tasks?: ReadonlyArray<{ kind: string; status: string; activeCommandId?: string | null }> } | undefined)?.tasks;
    if (!tasks || tasks.length === 0) return false;
    if (tasks.some((task) => task.status === "DISPATCHED" || task.activeCommandId)) return false;
    if (tasks.some((task) => task.status === "PENDING" && EXECUTABLE_CONSTRUCTION_TASK_KINDS.has(task.kind))) return false;
    return true;
  }

  /**
   * The player paused: the district cycle in progress ends at its next write instead of finishing its batch (live 2026-10-08: "several seconds after pause the
   * Mayor was still building"). The session is not stopped; the next cycle starts when the player resumes. True when a cycle was running.
   */
  interruptCycle(): boolean {
    const cycle = this.#cycleAbort;
    if (!cycle || cycle.signal.aborted) return false;
    cycle.abort(new Error("paused by the player"));
    return true;
  }

  getState(): MayorSessionState | null {
    return this.#state ? structuredClone(this.#state) : null;
  }

  getSessionStatus() {
    return {
      status: this.#lifecycleStatus,
      lastError: this.#lifecycleLastError,
      startCallCount: this.#startCallCount,
      lastStartResult: this.#lastStartResult,
      startInFlight: false,
    } as const;
  }

  start(options: StartMayorSessionOptions): MayorSessionState {
    this.#startCallCount++;
    if (this.#state?.status === "running") {
      this.#lifecycleStatus = "RUNNING";
      this.#lifecycleLastError = null;
      this.#lastStartResult = "RUNNING";
      return this.#snapshotState();
    }
    this.#lifecycleStatus = "STARTING";
    this.#lifecycleLastError = null;
    this.#parkedGrowthGoalFacts.clear();
    try {
      return this.#startInternal(options);
    } catch (error) {
      this.#lifecycleStatus = "FAILED";
      this.#lifecycleLastError = message(error);
      this.#lastStartResult = "FAILED";
      throw error;
    }
  }

  #startInternal(options: StartMayorSessionOptions): MayorSessionState {
    if (this.#state?.status === "running") return this.#snapshotState();
    const goal = options.goal.trim();
    if (!goal) throw new Error("Mayor goal is required");
    if (goal.length > 1_000) throw new Error("Mayor goal cannot exceed 1000 characters");
    if (!Number.isFinite(options.maxSessionSpend) || !(options.maxSessionSpend > 0))
      throw new Error("maxSessionSpend must be a finite number greater than zero");
    if (!Number.isFinite(options.minimumBalance) || options.minimumBalance < 0)
      throw new Error("minimumBalance must be a finite non-negative number");
    if (options.tickDelayMs !== undefined && !Number.isFinite(options.tickDelayMs))
      throw new Error("tickDelayMs must be finite");
    this.#productionResumeAttempts = 0;
    this.ports.v2ProductionSkillRuntime?.initialize();

    const startedAt = this.#now().toISOString();
    this.#abortController = new AbortController();
    this.#model = options.model?.trim() || DEFAULT_MODEL;
    this.#tickDelayMs = Math.max(0, Math.min(options.tickDelayMs ?? DEFAULT_TICK_DELAY_MS, 60_000));
    this.#speed = options.speed ?? "normal";
    this.#decisionMode = options.decisionMode ?? (options.speed === "fast" ? "fast" : "deepseek");
    this.#localHistory = { recentActions: [], cooldowns: [], consecutiveWaits: 0 };
    this.#localState = null;
    this.#lastLocalSupplyRefreshKey = null;
    this.#localLastMeaningfulAction = null;
    this.#localGrowthDomain = undefined;
    this.#localGrowthIntent = undefined;
    this.#localActionabilityBlock = null;
    this.#localConsecutiveZeroProgressIterations = 0;
    this.#consecutiveNoProgressDecisions = 0;
    this.#noProgressGuardEnabled = options.noProgressGuard === true;
    this.#growthCadenceState = { successfulBurstsSinceAbsorb: 0, absorbRequired: false };
    this.#stageTraceEnabled = options.stageTrace === true;
    this.#stageTimeoutMs = Math.max(1_000, options.localMayorStageTimeoutMs ?? LOCAL_MAYOR_STAGE_TIMEOUT_MS);
    this.#stageStartedAt.clear();
    this.#localTickProgress = { kind: "none", gameTimeAdvanced: false, worldRevisionChanged: false };
    this.#tickMadeProgress = false;
    this.#expectedLocalMutation = false;
    this.#lastFailureKind = null;
    this.#brainLastFailureReason = null;
    this.#brainRepeatedFailureCount = 0;
    this.#pendingStructuredIntent = null;
    this.#finalized = false;
    this.#cost = createDeepSeekSessionCostState({
      currency: "CNY",
      maxSessionSpend: options.maxSessionSpend,
      minimumBalance: options.minimumBalance,
      startedAt: new Date(startedAt),
    });
    this.#state = {
      sessionId: this.ports.id?.() ?? crypto.randomUUID(),
      goal,
      status: "running",
      lifecycleMode: options.lifecycleMode ?? "LIVE",
      startedAt,
      tickCount: 0,
      maxSessionSpend: options.maxSessionSpend,
      minimumBalance: options.minimumBalance,
      estimatedSessionSpend: 0,
      currentBalance: null,
      compactMayorMemory: emptyMayorMemory(),
      operationalSignals: emptyMayorOperationalSignals(),
      lastSnapshot: null,
      lastBatchResult: null,
      consecutiveFailures: 0,
      pendingUserCommand: null,
      lastStatus: "Mayor session started; awaiting first snapshot.",
      telemetryTotals: totals(),
      recentTickTelemetry: [],
      ...(this.#stageTraceEnabled ? { localMayorStageTrace: [] } : {}),
      decisionMode: this.#decisionMode,
      localMayorStatus: this.#decisionMode === "local" ? "observing" : undefined,
      localMayorProgress:
        this.#decisionMode === "local"
          ? {
              kind: "none",
              consecutiveZeroProgressIterations: 0,
              gameTimeAdvanced: false,
              worldRevisionChanged: false,
            }
          : undefined,
    };
    this.#lifecycleStatus = "RUNNING";
    this.#lifecycleLastError = null;
    this.#lastStartResult = "RUNNING";
    this.#emit("status");
    // The milestone popup is watched for as long as the session lives, not only at the start of a simulation window (see `blocking-modal-runtime.ts`).
    // The player's switch (`setUiSettings`) decides whether the Mayor may close it; the watcher ends when this session's signal aborts.
    void this.ports.watchBlockingModal?.(this.#abortController.signal)?.catch(() => undefined);
    if (options.continuous) void this.continuousRun().catch(() => undefined);
    return this.#snapshotState();
  }

  setPendingUserCommand(command: Omit<MayorCommand, "createdAt">): MayorSessionState {
    const state = this.#requireState();
    const text = command.text?.trim();
    if (!text) throw new Error("Mayor command text is required");
    if (!(["text", "voice", "map"] as const).includes(command.source)) throw new Error("Invalid Mayor command source");
    if (
      command.target &&
      (!Number.isFinite(command.target.x) ||
        !Number.isFinite(command.target.z) ||
        Math.abs(command.target.x) > 10_000 ||
        Math.abs(command.target.z) > 10_000)
    )
      throw new Error("Mayor command target is outside the supported map bounds");
    const intent = command.structuredIntent;
    let driving: MayorStructuredGoalIntent | null = intent ?? null;
    let gapStatus: string | undefined;
    if (intent) {
      if (!isStructuredIntentInVocabulary(intent)) throw new Error("Invalid structured Mayor Goal intent");
      // A well-formed intent that needs a primitive the product lacks is refused BY NAME, not silently dropped.
      // District work goes to the district builder, which carries out region, density and land purchase itself.
      // A goal about the city's problems (traffic, noise, ruins, crime, fire, ...) is carried out by the district builder's care round.
      const care = this.ports.districtBuilder ? careFocusFrom(intent) : null;
      const plan = planStructuredIntent(intent,
        this.ports.districtBuilder && districtIntentFrom(intent) ? DISTRICT_BUILDER_PRIMITIVES : care ? CARE_PRIMITIVES : undefined);
      if (!plan.executable) {
        driving = null;
        gapStatus = `INTENT_CAPABILITY_GAP:${plan.gaps.join(",")}`;
      } else if (care) {
        // It is not a Goal for the growth path: the named problems go first in the next cycles' care round, then the round goes on as usual.
        this.#careFocus = { focus: care, cyclesLeft: CARE_FOCUS_CYCLES, fresh: true };
        if (care.includes("FINANCE") && this.#objectiveProfile !== "FINANCIAL_RECOVERY" && this.ports.financeRecovery) {
          this.#financeByPlayer = { before: this.#objectiveProfile, cycles: 0 };
          this.setObjectiveProfile("FINANCIAL_RECOVERY");
        }
        driving = null;
        gapStatus = `CARE_FOCUS:${care.join(",")}`;
      }
    }
    this.#pendingStructuredIntent = driving;
    if (gapStatus) state.lastStatus = gapStatus.slice(0, 240);
    state.pendingUserCommand = { ...command, text: text.slice(0, 500), createdAt: this.#now().toISOString() };
    return this.#snapshotState();
  }

  async stop(reason = "Stopped by user"): Promise<MayorSessionState> {
    const state = this.#requireState();
    if (state.status === "running") {
      state.status = "stopped";
      state.stopReason = reason.slice(0, 240);
      state.stoppedAt = this.#now().toISOString();
      this.#abortController.abort(new Error(state.stopReason));
    }
    const inFlight = this.#tickPromise;
    if (inFlight) {
      await Promise.race([
        inFlight.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.#stageTimeoutMs, 2_000))),
      ]);
    }
    await this.#finalize();
    this.ports.v2ProductionSkillRuntime?.dispose();
    this.#lifecycleStatus = "STOPPED";
    this.#lifecycleLastError = null;
    return this.#snapshotState();
  }

  async focusActivityTarget(): Promise<boolean> {
    const target = this.#state?.localMayorActivity?.focusTarget;
    if (!target || !this.ports.focusTarget) return false;
    return this.ports.focusTarget(target);
  }

  async dispatchProductionSkillIntent(intent: unknown): Promise<import("./skills/schemas/result").SkillResult> {
    this.#requireRunning();
    if (!this.ports.v2ProductionSkillRuntime?.isInitialized()) {
      throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    }
    return this.ports.v2ProductionSkillRuntime.dispatch(intent, this.#abortController.signal);
  }

  async productionRuntimeReadiness(): Promise<unknown> {
    this.#requireRunning();
    if (!this.ports.v2ProductionSkillRuntime?.isInitialized()) {
      throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    }
    return this.ports.v2ProductionSkillRuntime.readiness();
  }

  /**
   * Formal production entry for the first durable Gate 1 project admission.
   * Idempotent: an already admitted project is returned unchanged. Refuses when
   * the world is not durably activated.
   */
  async ensureProjectAdmission(): Promise<unknown> {
    this.#requireRunning();
    if (!this.ports.v2ProductionSkillRuntime?.isInitialized()) {
      throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    }
    return this.ports.v2ProductionSkillRuntime.ensureProjectAdmission(this.#abortController.signal);
  }

  /** Admit or resume one durable work order selected by the V2 Brain. */
  async ensureGoalWorkOrder(goalId: string, landUse?: GrowableLandUse,
    completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED"): Promise<unknown> {
    this.#requireRunning();
    const runtime = this.ports.v2ProductionSkillRuntime;
    if (!runtime?.isInitialized()) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    if (!goalId.trim()) throw new Error("GOAL_WORK_ORDER_ID_REQUIRED");
    return runtime.ensureGoalWorkOrder({ goalId, ...(landUse ? { landUse } : {}), ...(completionStage ? { completionStage } : {}) }, this.#abortController.signal);
  }

  /**
   * Formal production entry for Gate 1 lifecycle progression. It advances the
   * durable Gate 1 state machine toward `milestone` through the existing
   * transitions and stops there. It does not execute a Skill.
   */
  async advanceGate1ToStage(milestone: import("./v2/gate1").Gate1Stage): Promise<unknown> {
    this.#requireRunning();
    if (!this.ports.v2Gate1Progression) throw new Error("V2_GATE1_PROGRESSION_NOT_CONFIGURED");
    const result = await this.ports.v2Gate1Progression.advanceToStage(milestone, this.#abortController.signal);
    this.ports.v2ProductionSkillRuntime?.recordGate1ProgressionOutcome?.(result);
    // Progression mutates durable Gate 1 state, so a context memoized at session
    // start is no longer authoritative for readiness or Skill dispatch.
    this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
    return result;
  }

  /** Start the deterministic production Brain for one complete residential-growth cycle. */
  async runAutonomousConstructionCycle(): Promise<unknown> {
    this.#requireRunning();
    if (this.#autonomousConstructionPromise) return this.#autonomousConstructionPromise;
    this.#autonomousConstructionPromise = this.#runAutonomousConstructionCycle()
      .then((result) => {
        const state = this.#state;
        if (state?.status === "running") {
          const outcome = result as { status?: string; stage?: string; reason?: string };
          state.lastStatus = outcome.status === "MILESTONE_REACHED"
            ? `V2 Brain reached ${outcome.stage ?? "its current milestone"}`
            : `V2 Brain ${outcome.status ?? "stopped"}: ${outcome.reason ?? "no further progress"}`;
          this.#emit("tick");
        }
        return result;
      })
      .finally(() => { this.#autonomousConstructionPromise = null; });
    return this.#autonomousConstructionPromise;
  }

  /**
   * Let the city run for one bounded observation window.
   *
   * The stage watchdog is the OUTER bound of the shared wait contract, so it
   * normally never fires: the adapter's own stall/absolute budgets are smaller
   * and end the wait first with a real result. When it does fire it must stop
   * the adapter's in-flight poll loop rather than orphan it — an orphaned loop
   * keeps reading the Bridge until its own budget expires and then rejects a
   * promise nobody awaits, which is how a cancelled run came back to the tick
   * as `CS2 simulation did not auto-pause before timeout`.
   */
  async #awaitSimulationWindow(hours = AUTONOMOUS_WAIT_SIMULATION_HOURS, custom?: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    const waitAbort = linkedAbortController(this.#abortController.signal);
    const startedAt = Date.now();
    // A profile that writes into a running city waits without stopping it: a timed run ends in the Bridge's auto-pause (see
    // `observeRunningSimulation`). Whether to pause is the planner's call (V2 candidate, P2), and this planner needs no still frame.
    const wait = profileUsesPipeline(this.#objectiveProfile) && this.ports.observeRunningSimulation
      ? this.ports.observeRunningSimulation.bind(this.ports) : this.ports.runSimulation.bind(this.ports);
    try {
      await boundedRuntimeAwait(
        custom ? custom(waitAbort.controller.signal) : wait({ hours, speed: 4 }, waitAbort.controller.signal),
        this.#abortController.signal,
        simulationStageBudgetMs(hours, 4, this.#stageTimeoutMs),
        "simulation",
        "runSimulation",
        () => waitAbort.controller.abort(new Error("runtime simulation stage timed out")),
      );
      this.#runLedgerDecision.simulation = {
        outcome: "completed", elapsedMs: Date.now() - startedAt, framesAdvanced: null, reason: null,
      };
    } catch (error) {
      // Which bound ended the wait is the ledger's business: a stall and an
      // unreachable target are both bounded, and only one of them means stuck.
      const detail = message(error);
      const outcome: RunLedgerDecision["simulation"]["outcome"] =
        /exceeded its absolute wait budget/.test(detail) ? "absolute_budget"
          : /did not (auto-pause|advance) before timeout/.test(detail) || error instanceof MayorRuntimeStageTimeoutError ? "stalled"
            : this.#abortController.signal.aborted ? "aborted" : "errored";
      this.#runLedgerDecision.simulation = { outcome, elapsedMs: Date.now() - startedAt, framesAdvanced: null, reason: detail };
      throw error;
    } finally {
      waitAbort.unlink();
      // Whether the window completed or not, it is over. The world is released
      // here rather than left paused, so the next plan-and-decide step runs
      // against a city that is still moving.
      await this.#releaseWorld();
    }
  }

  /**
   * Take the consistency window the product needs around a native mutation.
   *
   * The write endpoints themselves take no pause requirement — this is the
   * product's own choice to mutate against a frame that is not moving. It is
   * taken once per cycle, immediately before the only work that writes.
   */
  async #claimWorldForMutation(): Promise<void> {
    if (!this.ports.resume) return;
    // The district builder, the utility repair and the civic placement already write into a running city through the game's own validation
    // (a lot taken meanwhile is a refusal the next cycle reads). Stopping the city for the cycle's few tax and budget reads only made it
    // flicker: measured live (2026-10-04, BALANCED) a pause and a resume at the head of every cycle, several times a minute.
    if (profileUsesPipeline(this.#objectiveProfile)) return;
    try {
      await this.ports.pause();
    } catch {
      // Failing to claim the window is not a reason to refuse to plan: the
      // mutation paths carry their own readback and reconciliation.
    }
  }

  /** Release the mutation window and let the city run again. Best effort. */
  async #releaseWorld(): Promise<void> {
    if (!this.ports.resume) return;
    try {
      await this.ports.resume(this.#abortController.signal);
    } catch {
      // A world that could not be released is reported by the next readback;
      // it must not fail the tick that has already finished its work.
    }
  }

  /**
   * One public-service building per cycle, while the city owes one.
   *
   * A city with homes and no clinic, school, landfill, fire or police station is not a city; this places the first
   * of each as population reaches it, through the same journaled placement path as a utility facility. It never
   * decides the growth Goal and never stops the cycle: a refusal or a failure is reported and the cycle builds on.
   * After a cycle that placed nothing it rests three cycles, so an unchanged city is not re-read every tick.
   */
  /** Raise taxes one bounded step while the runway is short. A failed read or write never stops the cycle. */
  async #ensureSolvency(): Promise<void> {
    // The player's takeover permission (`host/protocol.ts`): taxes are the player's unless they allowed economic adjustments.
    if (process.env.AI_MAYOR_ALLOW_ECONOMY === "0") return;
    const runtime = this.ports.v2ProductionSkillRuntime;
    const state = this.#state;
    if (!runtime?.ensureSolvency || !state) return;
    try {
      const changes = await runtime.ensureSolvency(this.#abortController.signal);
      if (changes.length > 0) {
        state.lastStatus = `V2 solvency: taxes raised ${changes.map((change) => `${change.area}->${change.rate}%`).join(", ")}`.slice(0, 240);
        this.#emit("status");
      }
    } catch {
      // The finance read is best-effort; the Brain's own runway rule still applies.
    }
  }

  /**
   * Before any cycle reads or writes: is the game reachable, and is it the same world? Unreachable: nothing is written this cycle. A
   * world that came back or changed: everything remembered about the old one is dropped and the world is read afresh (what the player
   * did meanwhile is simply what the world now is). Nothing else holds the Mayor back.
   */
  readonly #worldWatch = new WorldWatch();
  #lastCheckpointMs: number | null = null;
  #checkpointSlot = 0;
  async #sessionGuard(): Promise<{ status: string; reason: string } | null> {
    const lifecycle = this.ports.lifecycle;
    const state = this.#state;
    if (!lifecycle || !state) return null;
    let identity: Awaited<ReturnType<typeof lifecycle.worldIdentity>> = null;
    try { identity = await lifecycle.worldIdentity(this.#abortController.signal); } catch { identity = null; }
    const verdict = this.#worldWatch.observe(identity);
    if (verdict === "UNREACHABLE") {
      state.lastStatus = "V2 session: the game cannot be reached; nothing is written until it answers";
      this.#emit("status");
      return { status: "WAITING", reason: "GAME_UNREACHABLE: writes stopped; the world is re-read when the game answers" };
    }
    if (verdict === "REBASELINE") {
      this.ports.districtBuilder?.rebaseline?.();
      // A reloaded save raises the same milestone popup again; it is a new occurrence in a new world, not a loop to refuse.
      this.ports.resetBlockingModalMemory?.();
      this.#lastCheckpointMs = null;
      state.lastStatus = "V2 session: reconnected or the world changed; everything is re-read from the world as it is now";
      this.#emit("status");
    }
    return null;
  }

  /**
   * Crash protection, not authority: after a batch the builder read back (a district stands, land was bought), save into the next
   * of a few named slots, at most every few minutes, never when memory is short (the save is what runs out). A failure is reported and
   * never stops the cycle.
   */
  #memoryWarned = false;
  async #maybeCheckpoint(batchConfirmed: boolean): Promise<void> {
    const lifecycle = this.ports.lifecycle;
    const state = this.#state;
    if (!lifecycle || !state) return;
    let free: number | null = null;
    try { free = await lifecycle.freeCommitGb(); } catch { free = null; }
    const now = this.ports.now?.().getTime() ?? Date.now();
    const decision = decideCheckpoint({ nowMs: now, lastCheckpointMs: this.#lastCheckpointMs, freeCommitGb: free, batchConfirmed });
    // The machine is short of memory (live 2026-10-07: the game at 16 GB and the system out of virtual memory closed it twice): the Mayor keeps building, but the
    // player is told once, in the Mayor's own words, so they can save and restart the game before the system does it for them.
    if (free !== null && memoryVerdict(free) !== "OK") {
      if (!this.#memoryWarned) { this.#memoryWarned = true; state.lastStatus = `MEMORY_LOW:${free.toFixed(1)}`; this.#emit("status"); }
    } else if (free !== null) this.#memoryWarned = false;
    if (!decision.save) return;
    this.#lastCheckpointMs = now;
    try {
      const outcome = await lifecycle.checkpointSave(checkpointSlotName(this.#checkpointSlot), this.#abortController.signal);
      if (outcome.ok) this.#checkpointSlot += 1;
      state.lastStatus = `V2 checkpoint ${outcome.ok ? "saved" : "failed"}: ${outcome.detail}`.slice(0, 240);
    } catch (error) {
      state.lastStatus = `V2 checkpoint failed: ${message(error)}`.slice(0, 240);
    }
    this.#emit("status");
  }

  /** When the civic path last rested (null: not resting). A rest is game time, not ticks: a tick is no longer a game hour (`v2/game-clock.ts`). */
  #civicRestSince: GameStamp | null = null;
  async #civicStamp(tickCount: number): Promise<GameStamp> {
    let frame: number | null = null;
    try { frame = (await this.ports.readGameFrame?.(this.#abortController.signal)) ?? null; } catch { frame = null; }
    return { frame, cycle: tickCount };
  }
  async #provideCivicService(): Promise<void> {
    const runtime = this.ports.v2ProductionSkillRuntime;
    const state = this.#state;
    if (!runtime?.provideCivicService || !state) return;
    const now = await this.#civicStamp(state.tickCount);
    // 3 ticks was about 3 game hours; the tick count stays as the fallback when the game clock cannot be read.
    if (this.#civicRestSince && !stampElapsed(this.#civicRestSince, now, CIVIC_REST_HOURS, CIVIC_REST_TICKS)) return;
    try {
      const outcome = await runtime.provideCivicService(this.#abortController.signal);
      if (outcome.status !== "PLACED") this.#civicRestSince = now;
      if (outcome.status === "PLACED" || outcome.status === "NO_PLACEMENT") {
        state.lastStatus = (outcome.status === "PLACED"
          ? `V2 civic service placed: ${outcome.kind} ${outcome.prefab} (${outcome.verdict})`
          : `V2 civic service owed but not placed: ${outcome.refusals.join("; ")}`).slice(0, 240);
        this.#emit("status");
      }
      runtime.invalidateReadiness();
    } catch (error) {
      this.#civicRestSince = now;
      state.lastStatus = `V2 civic service failed: ${message(error)}`.slice(0, 240);
      this.#emit("status");
    }
  }

  /**
   * FINANCIAL_RECOVERY, one cycle: the finance loop reads the world and the books, does at most one thing, and the city
   * then runs long enough for the books to move (they update by the hour) before the next read judges it.
   */
  async #financialRecoveryCycle(): Promise<{ status: string; stage?: string; reason?: string } | null> {
    const loop = this.ports.financeRecovery;
    const state = this.#state;
    if (!loop || !state) return null;
    const result = await loop.step(this.#abortController.signal);
    let status = result.status;
    const byPlayer = this.#financeByPlayer;
    if (byPlayer) {
      // The player's word is not undone by two lucky reads: the books update by the hour and swing by tens of thousands (live 2026-10-07: two reads of +7.6k and
      // +1.6k ended the recovery while the month was still -65k, and the Mayor laid two districts at once). It ends when the average of the last reads is
      // not negative, or after FINANCE_BY_PLAYER_MAXIMUM_CYCLES cycles, so a city that cannot be cut further is never locked for ever.
      byPlayer.cycles += 1;
      const reads = loop.memory?.balanceReads ?? [];
      const recent = reads.slice(-FINANCE_BY_PLAYER_SETTLED_READS);
      const settled = recent.length >= FINANCE_BY_PLAYER_SETTLED_READS && recent.reduce((sum, value) => sum + value, 0) / recent.length >= 0;
      if (status === "RECOVERED" && !settled && byPlayer.cycles < FINANCE_BY_PLAYER_MAXIMUM_CYCLES) status = "RECOVERING";
      if (byPlayer.cycles >= FINANCE_BY_PLAYER_MAXIMUM_CYCLES && status !== "RECOVERED") status = "RECOVERED";
    }
    this.#recovered = status === "RECOVERED";
    if (this.#recovered && this.#financeByPlayer) {
      // The books hold (or the limit is reached): the mode the player found the Mayor in comes back.
      const back = this.#financeByPlayer.before;
      this.#financeByPlayer = null;
      this.setObjectiveProfile(back);
      state.lastStatus = `V2 finance recovery done at the player's word; back to ${back}`.slice(0, 240);
    }
    this.#runLedgerDecision.policyAnswer = `FINANCE_RECOVERY:${result.status}:${result.notes.join(" | ")}`.slice(0, 2400);
    // Every note of the step (what was read, chosen, done, judged): the one line that was kept hid why a step failed (live 2026-10-07: "the world did not accept the action").
    state.lastStatus = `V2 finance recovery ${result.status}: ${result.notes.join(" | ")}`.slice(0, 1200);
    this.#emit("status");
    if (result.status === "RECOVERED") return null;
    try {
      await this.#awaitSimulationWindow(RECOVERY_WINDOW_HOURS);
    } catch (error) {
      if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
    }
    return result.acted
      ? { status: "MILESTONE_REACHED", stage: "FINANCE_RECOVERY_ACTION", reason: result.notes.join("; ").slice(0, 300) }
      : { status: "WAITING", reason: `FINANCE_RECOVERY_${result.status}:${result.notes.join("; ")}`.slice(0, 300) };
  }

  /**
   * After a facility was placed: let the city run until the utility reading SHOWS it working, not for a fixed span. Measured live (2026-10-04) the fixed
   * 0.5 game hour was 24 s of wall clock with nothing written, twice at the start of every city, and nothing had measured how long a facility needs.
   * The Bible asks to "prove operation before adding another" (POL-UTILITY): this proves it from the world, and ends the wait the moment it is proven.
   *
   * What shows in a reading: electricity production and fresh water capacity, of a facility that read back attached. A sewage outlet takes any amount
   * (its capacity reads as ~1e9) and an unattached facility adds nothing, so with only those there is nothing to wait for. A host that cannot read the
   * capacity waits the fixed window as before.
   */
  async #awaitFacilitiesOperational(facilities: ReadonlyArray<{ kind: string; attached: boolean | null }>): Promise<void> {
    const wait = this.ports.awaitUtilityCapacity;
    if (!wait) { await this.#awaitSimulationWindow(); return; }
    const kinds = [...new Set(facilities.filter((facility) => facility.attached === true && (facility.kind === "electricity" || facility.kind === "water"))
      .map((facility) => facility.kind as "electricity" | "water"))];
    if (kinds.length === 0) { await this.#releaseWorld(); return; }
    await this.#awaitSimulationWindow(AUTONOMOUS_WAIT_SIMULATION_HOURS, async (signal) => {
      const result = await wait.call(this.ports, { kinds, maximumHours: AUTONOMOUS_WAIT_SIMULATION_HOURS, speed: 4 }, signal);
      const detail = `${kinds.join("+")} ${result.ready ? "showed" : "did NOT show"} its capacity after ${result.gameHours.toFixed(2)} game hours (${(result.wallMs / 1000).toFixed(1)} s)`;
      if (this.#state) this.#state.lastStatus = `${this.#state.lastStatus ?? ""} | ${detail}`.slice(0, 300);
      // The status line is overwritten by the next stage, so the measurement is also kept where the evidence reads it (the ledger's policy answer).
      this.#runLedgerDecision.policyAnswer = `${this.#runLedgerDecision.policyAnswer ?? ""} | CAPACITY_READBACK ${detail}`.slice(0, 2600);
      return result;
    });
  }

  /** Pass world facts into the district policy and execute its chosen realization. */
  async #buildNextDistrict(): Promise<{ status: string; stage?: string; reason?: string } | null> {
    const builder = this.ports.districtBuilder;
    const state = this.#state;
    if (!builder || !state) return null;
    // No outward building (financial recovery, or the player held expansion): the cycle still tends what stands — the care round and the road upkeep.
    const careOnly = !profileAllowsExpansion(this.#objectiveProfile, this.#recovered) ? "FINANCIAL_RECOVERY"
      : this.#expansionHeldByPlayer ? "EXPANSION_HELD_BY_PLAYER" : null;
    const snapshot = state.lastSnapshot;
    const facts = compileLocalMayorState(snapshot, this.#localHistory);
    // Critical utility shortage is a policy priority; the builder realizes it before district search.
    const short = (["electricity", "water", "sewage"] as const).filter((kind) => {
      const utility = facts.utilities[kind];
      // A network with no capacity at all yet (a new city: nothing is built, so there is no load to be short of) is built BEFORE the zoning that
      // would claim the lots beside the streets — the first district's utilities were placed 50 m out, with no road access, because the zoning came first.
      if (utility.available && utility.uncommissioned) return true;
      return utility.available && utility.risk === "critical" && (utility.headroom ?? 0) + (utility.undeliveredLoad ?? 0) <= 0;
    });
    state.lastStatus = "V2 district builder: surveying the next district";
    this.#emit("status");
    let outcome: Awaited<ReturnType<NonNullable<MayorRuntimePorts["districtBuilder"]>["runCycle"]>>;
    // What the player asked for (a land use, a region or map point, a density, leave to buy land), when they asked.
    const districtIntent = districtIntentFrom(this.#pendingStructuredIntent, state.pendingUserCommand?.target ?? null);
    // The city problems the player named, still first for a few cycles.
    const careFocus = this.#careFocus;
    if (careFocus) {
      careFocus.cyclesLeft -= 1;
      if (careFocus.cyclesLeft <= 0) this.#careFocus = null;
    }
    // The cycle's own abort (`interruptCycle`): a pause of the player's ends the cycle between two writes, not after a whole batch of districts.
    const cycleAbort = linkedAbortController(this.#abortController.signal);
    this.#cycleAbort = cycleAbort.controller;
    try {
      outcome = await builder.runCycle({
        ...(districtIntent ? { intent: districtIntent } : {}),
        ...(careFocus ? { care: { focus: careFocus.focus, fresh: careFocus.fresh } } : {}),
        ...(careOnly ? { careOnly } : {}),
        ...(profileUsesPipeline(this.#objectiveProfile) ? { pipelined: true } : {}),
        population: facts.population,
        ...(profileUsesPipeline(this.#objectiveProfile) && facts.population !== null && facts.population >= this.#growthSettings.stabilizationPopulation * NEAR_TARGET_START_SHARE && facts.population < this.#growthSettings.stabilizationPopulation
          ? { nearTarget: { population: facts.population, target: this.#growthSettings.stabilizationPopulation } } : {}),
        targetPopulation: profileUsesPipeline(this.#objectiveProfile) ? this.#growthSettings.stabilizationPopulation : null,
        utilityReadComplete: (["electricity", "water", "sewage"] as const).every((kind) => facts.utilities[kind].available),
        criticalUtilityShortfalls: Object.fromEntries(short.map((kind) => [kind, Math.max(1, -(facts.utilities[kind].headroom ?? 0))])),
        // What the zone catalogue has unlocked: the stage and density signal of the V2 policy (FAST_EXPANSION only reads it).
        ...(() => { const unlocked = unlockedZoneCapabilities(snapshot); return unlocked ? { unlocked } : {}; })(),
        // A founding district is about 3.4x the old largest; it is offered only to a treasury that can pay for it with
        // a reserve left (roads and zoning cost roughly 0.3 per square metre in the districts measured so far).
        ...(!profileUsesPipeline(this.#objectiveProfile) && facts.treasury !== null
          ? { maximumAreaSquareMeters: Math.max(57_600, (facts.treasury - 150_000) / 0.3) } : {}),
        demand: {
          residential: facts.demands.residential ?? 0,
          commercial: facts.demands.commercial ?? 0,
          industrial: facts.demands.industrial ?? 0,
        },
        zoneFor: (role, density) => density
          ? zoneForDensity((snapshot as { planningCatalog?: { zoneTypes?: unknown } } | undefined)?.planningCatalog?.zoneTypes, role, density)
          : zonePrefabForDomain(snapshot, role),
        utilities: Object.fromEntries((["electricity", "water", "sewage"] as const).map((kind) => [kind,
          { headroom: facts.utilities[kind].headroom, consumption: facts.utilities[kind].load,
            undelivered: facts.utilities[kind].undeliveredLoad ?? 0 }])) as DistrictUtilityReadings,
        // Land is paid for out of earnings (K34): the builder tests the recurring upkeep a tile adds against the monthly
        // surplus. Here the Brain only says whether it can read the books at all.
        // The player's takeover permission (`host/protocol.ts`): no land is bought without it.
        mayPurchaseLand: facts.treasury !== null && facts.monthlyBalance !== null && process.env.AI_MAYOR_ALLOW_LAND !== "0",
        ...(facts.treasury !== null && facts.monthlyBalance !== null
          ? { finance: { treasury: facts.treasury, monthlyBalance: facts.monthlyBalance } } : {}),
        signal: cycleAbort.controller.signal,
      });
    } catch (error) {
      state.lastStatus = `V2 district builder ${cycleAbort.controller.signal.aborted && !this.#abortController.signal.aborted ? "interrupted (paused)" : `failed: ${message(error)}`}`.slice(0, 240);
      this.#emit("status");
      return null;
    } finally {
      cycleAbort.unlink();
      if (this.#cycleAbort === cycleAbort.controller) this.#cycleAbort = null;
    }
    // The player's named problems have had their first, forced round: the next cycles keep them first, without forcing the periodic passes again.
    if (careFocus?.fresh) {
      careFocus.fresh = false;
      if (!districtIntent) state.pendingUserCommand = null;
    }
    // Also on a cycle that built: the status the reader sees is always this cycle's, never an earlier one's.
    if (outcome.status === "BUILT") state.lastStatus = describeDistrictOutcome(outcome);
    this.#runLedgerDecision.policyAnswer = (`DISTRICT_${outcome.outcome ?? outcome.status}:${outcome.batch ? JSON.stringify(outcome.batch) : ""}:${outcome.nextDecision ?? ""}:` +
      `${outcome.feasibility ? JSON.stringify(outcome.feasibility) : ""}:${outcome.notes.slice(-9).join(" | ")}`).slice(0, 2400);
    if (outcome.status === "UTILITY_REPAIRED") {
      this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
      state.lastStatus = `V2 utility repair: ${outcome.notes.join("; ")}`.slice(0, 240);
      this.#emit("status");
      try {
        await this.#awaitFacilitiesOperational(outcome.facilities ?? []);
      } catch (error) {
        if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
      }
      return { status: "MILESTONE_REACHED", stage: "UTILITY_REPAIRED", reason: outcome.notes.join("; ").slice(0, 300) };
    }
    if (outcome.status === "LAND_PURCHASED") {
      await this.#maybeCheckpoint(true);
      state.lastStatus = `V2 district builder: ${outcome.notes.at(-1) ?? "land purchased"}`.slice(0, 240);
      this.#emit("status");
      return { status: "MILESTONE_REACHED", stage: "LAND_PURCHASED", reason: outcome.notes.at(-1) ?? "" };
    }
    if (outcome.status !== "BUILT") {
      // The reason first (`describeDistrictOutcome`): the joined notes were cut at 240 characters before the reason, which comes last.
      state.lastStatus = describeDistrictOutcome(outcome);
      this.#emit("status");
      if (outcome.outcome === "NO_FEASIBLE_SITE" || outcome.outcome === "REPLAN_REQUIRED" || outcome.outcome === "SAFETY_BLOCKED") {
        return { status: "BLOCKED", stage: "DISTRICT_FEASIBILITY",
          reason: `${outcome.outcome}:${outcome.feasibility ? JSON.stringify(outcome.feasibility) : outcome.notes.at(-1) ?? "unknown"}` };
      }
      return null;
    }
    // The player's request was carried out here, so it is no longer pending for the Goal path to carry out again.
    if (districtIntent) {
      this.#pendingStructuredIntent = null;
      state.pendingUserCommand = null;
    }
    this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
    // A district stands only if its streets were read back: that is a confirmed batch worth a checkpoint.
    await this.#maybeCheckpoint(outcome.roadsLanded > 0);
    this.#say({ eventType: "BLOCK_COMPLETE", toneHint: "NEUTRAL", subjectDomain: "GRID", resultKey: "batch-complete",
      continuityRef: `district:${outcome.site?.anchor.x ?? ""},${outcome.site?.anchor.z ?? ""}` });
    // No window here. The city has been running while the district was laid (see the release before `#buildNextDistrict`), the zoned lots grow
    // in the time the next cycle spends reading the world, and a fixed wait only delayed that reading: measured live (2026-10-04) 23.7 s of
    // wall clock with no write after a district. The next cycle starts at once; this only makes sure the city is not left paused.
    await this.#releaseWorld();
    return { status: "MILESTONE_REACHED", stage: "DISTRICT_BUILT",
      reason: `${outcome.notes.at(-1) ?? ""}`.slice(0, 300) };
  }

  /**
   * Look for a blocking popup and clear it when the player's switch allows (`checkBlockingModal` reads first, dismisses only the expected
   * identity and verifies it is gone). Returns a blocked result when the popup is one the Mayor may not close; a failed LOOK never stops the
   * cycle (it is repeated at the next one), but an aborted session does.
   */
  async #clearBlockingModal(): Promise<{ status: string; stage?: string; reason?: string } | null> {
    const check = this.ports.checkBlockingModal;
    if (!check) return null;
    try {
      const result = await check.call(this.ports, this.#abortController.signal);
      if (!result.allowedToContinue) return { status: "BLOCKED", stage: "BLOCKING_MODAL", reason: `blocking_modal_guard:${result.modalClass}` };
    } catch (error) {
      if (this.#abortController.signal.aborted) throw error;
    }
    return null;
  }

  async #runAutonomousConstructionCycle(): Promise<unknown> {
    this.#requireRunning();
    if (!this.ports.v2ProductionSkillRuntime?.isInitialized()) {
      throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    }
    // The game is reachable and it is the same world, or nothing is written this cycle (see `#sessionGuard`).
    const guard = await this.#sessionGuard();
    if (guard) return guard;
    // A milestone popup PAUSES the game and covers the screen. The popup is cleared by the check that opens a simulation window, and a cycle that
    // builds a district no longer ends in a window (nothing waits any more), so without this look no cycle ever cleared it: measured live
    // (2026-10-04) the first milestone's popup stayed up from the second tick, the game stood paused at 12:20, ten cycles read "the world did not
    // advance", and the run ledger stopped the session. One small read per cycle (the background watcher stays off: it cost 12% of a run).
    const modal = await this.#clearBlockingModal();
    if (modal) return modal;
    // The world was released at the end of the previous observation, so it is
    // running now. Claim it for the mutations this cycle may perform — one
    // consistency window per cycle, not one per action.
    await this.#claimWorldForMutation();
    // Admission is idempotent for an existing project and creates a scoped
    // project only when the authoritative world has not been admitted yet.
    if (this.#objectiveProfile === "FINANCIAL_RECOVERY") {
      // A city that is losing money adds no civic building and no street until it has stopped; the care round still runs (care-only cycle) first,
      // because garbage, ruins and unconnected buildings are what drive the losses (live 2026-10-07: 45 garbage icons grew while only budgets were cut).
      if (!this.#recovered) await this.#buildNextDistrict();
      const recovery = await this.#financialRecoveryCycle();
      if (recovery) return recovery;
    } else {
      await this.#ensureSolvency();
    }
    // The district builder reads the world and writes through the game's own validation; it has no ledger, so it does
    // not wait on durable admission. Measured live (2026-10-03): the first district written after a Load moves the world
    // off its loaded-save anchor, every later admission then stops at "baseline checkpoint ... not saving again", and a
    // builder queued behind admission never got to lay the next one.
    if (profileAllowsExpansion(this.#objectiveProfile, this.#recovered)) await this.#provideCivicService();
    // The consistency window is for the writers that need a still frame (taxes, a civic building). The district builder reads
    // the world fresh and writes street by street through the game's own validation, which takes no pause: holding the city
    // still for its several hundred calls stopped the simulation for 30-60 s of every building tick (measured live, 47% of
    // the wall clock paused). BALANCED lets the city run while a district is laid; the other profiles are unchanged.
    if (profileUsesPipeline(this.#objectiveProfile) && this.ports.districtBuilder) await this.#releaseWorld();
    const district = await this.#buildNextDistrict();
    if (district) return district;
    // With a district builder the Goal path no longer grows the city: it laid 40-120 m stub streets that joined nothing
    // (measured live, 2026-10-03: two single-street components and four dead ends beside a finished district). Nothing to
    // build this cycle means the city runs one window and the builder reads the world again.
    if (this.ports.districtBuilder) {
      try {
        await this.#awaitSimulationWindow(AUTONOMOUS_BRIEF_WINDOW_HOURS);
      } catch (error) {
        if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
      }
      return { status: "WAITING", reason: `DISTRICT_BUILDER_NOTHING_TO_BUILD:${this.#state?.lastStatus ?? ""}`.slice(0, 300) };
    }
    await this.ensureProjectAdmission();
    let latestRoadGoalProducedAtMs: number | null = null;
    let latestRoadAdmissionEvidence: Record<string, unknown> | null = null;
    // The cycle's pace, resolved from the city's own population as soon as this
    // cycle reads its growth state. The package chain below needs it too, and
    // that block only runs after a Goal was admitted from those same facts.
    let pace: GrowthPace = growthPaceForPopulation(null, this.#growthSettings);
    const advanceActiveWorkOrder = async () => {
      let active = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
      let milestone: import("./v2/gate1").Gate1Stage = active?.completionStage ?? "OCCUPIED";
      if (active?.goalId.startsWith("ESTABLISH_ROAD_NETWORK") && active.state.tranche.stage !== "ROAD_DELIVERED") {
        this.#say({ eventType: "ACT_START", toneHint: "NEUTRAL", subjectDomain: "GRID",
          actionKey: "extend-grid", continuityRef: active.goalId });
      }
      let outcome = await this.advanceGate1ToStage(milestone) as {
        status?: string; reason?: string; stage?: string; latestRoadSubmissionAt?: string | null;
        // The progression's own statement of what this wait is for. Carried
        // through `advanceGate1ToStage`'s `unknown` return; the wait loop reads
        // it to decide whether running the city can answer it at all.
        wake?: { condition?: string; detail?: string };
        state?: { project?: { status?: string }; intent?: { id?: string } };
      };
      if (outcome.status === "MILESTONE_REACHED" && outcome.stage === "ROAD_DELIVERED" &&
        active?.goalId.startsWith("ESTABLISH_ROAD_NETWORK")) {
        this.#say({ eventType: "ACT_SUCCESS", toneHint: "NEUTRAL", subjectDomain: "GRID",
          resultKey: "road-confirmed", continuityRef: active.goalId });
      }
      for (let handoff = 0; outcome.status === "EXHAUSTED" &&
        outcome.reason?.startsWith("GOAL_WORK_ORDER_ACTIVATED:") && handoff < 8; handoff += 1) {
        active = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
        milestone = active?.completionStage ?? "OCCUPIED";
        outcome = await this.advanceGate1ToStage(milestone) as typeof outcome;
      }
      return outcome;
    };
    const resumeParentGoal = async (child: V2GoalWorkOrderRecord) => {
      const parentGoalId = child.parentGoalId;
      if (!parentGoalId) throw new Error("GOAL_PREREQUISITE_PARENT_REQUIRED");
      const orders = this.ports.v2ProductionSkillRuntime?.goalWorkOrders?.() ?? [];
      const parent = orders.find((order) => order.goalId === parentGoalId);
      const parentLandUse = parent?.state.districtPlan.landUse ?? child.parentLandUse ??
        canonicalGrowableLandUseForGoalId(parentGoalId);
      await this.ensureGoalWorkOrder(parentGoalId, parentLandUse);
    };
    let result = await advanceActiveWorkOrder();
    // A prerequisite work order stops at its recorded Gate1 milestone. Mark it
    // complete only after that authoritative stage is reached, then re-admit the
    // parent Goal from fresh world facts. Each transition is bounded and the
    // parent may derive another child only through the same capped durable path.
    let prerequisiteTransitions = 0;
    // Set when the Goal's own bounded chain refuses to continue: its last step is
    // terminal and the parent Goal will not be re-admitted — a spent prerequisite
    // budget, an exhausted site search. That closes the Goal for this cycle, not
    // the city, so the Brain moves to whatever the growth policy asks for next.
    let closedGoalChain: string | null = null;
    for (; prerequisiteTransitions < 16; prerequisiteTransitions += 1) {
      const active = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
      if (active?.status === "RECONCILING" && result.status === "BLOCKED") break;
      if (active?.parentGoalId && active.completionStage && active.status === "BLOCKED" && result.status === "BLOCKED") {
        // A prerequisite child is a bounded attempt, not the parent Goal's
        // terminal outcome. Re-derive the parent from current world facts; its
        // provider may select another legal candidate or admit the next bounded
        // corridor step. The durable child remains BLOCKED history either way.
        try {
          await resumeParentGoal(active);
        } catch (error) {
          closedGoalChain = `PARENT_GOAL_NOT_RE_ADMITTED:${message(error)}`;
          break;
        }
        this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
        result = await advanceActiveWorkOrder();
        continue;
      }
      if (active && !active.parentGoalId && active.completionStage && result.status === "MILESTONE_REACHED" &&
        result.stage === active.completionStage) {
        if (active.state.project.status !== "COMPLETE" && active.state.tranche.stage !== active.completionStage) {
          result = { status: "WAITING", stage: active.state.tranche.stage,
            reason: `GOAL_WORK_ORDER_MILESTONE_NOT_PERSISTED:${active.goalId}:${active.state.tranche.stage}->${active.completionStage}` };
          break;
        }
        // A root Road Goal is complete when its requested Road milestone is
        // authoritatively read back. Closing the reservation lets the Brain
        // derive its next Goal from the changed road graph on the next pass.
        this.ports.v2ProductionSkillRuntime?.completeGoalWorkOrder?.(active.goalId);
        this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
        closedGoalChain = `GOAL_WORK_ORDER_MILESTONE_REACHED:${active.goalId}`;
        break;
      }
      if (!active?.parentGoalId || !active.completionStage || result.status !== "MILESTONE_REACHED" ||
        result.stage !== active.completionStage) break;
      if (active.state.project.status !== "COMPLETE" && active.state.tranche.stage !== active.completionStage) {
        result = { status: "WAITING", stage: active.state.tranche.stage,
          reason: `GOAL_WORK_ORDER_MILESTONE_NOT_PERSISTED:${active.goalId}:${active.state.tranche.stage}->${active.completionStage}` };
        break;
      }
      this.ports.v2ProductionSkillRuntime?.completeGoalWorkOrder?.(active.goalId);
      await resumeParentGoal(active);
      this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
      result = await advanceActiveWorkOrder();
    }
    if (prerequisiteTransitions === 16 && result.status === "MILESTONE_REACHED" && result.stage === "ROAD_DELIVERED") {
      result = { status: "EXHAUSTED", reason: "GOAL_PREREQUISITE_TRANSITION_BUDGET_EXHAUSTED" };
    }
    // A root Goal whose bounded work order has closed terminally is a finished
    // Goal, not a stalled one. It stays the "active" work order by identity, but
    // its own Gate1 project state need not be BLOCKED — the work order closes on
    // a bounded failure the project never recorded — so nothing else in this
    // cycle notices, and every later cycle would advance exactly nothing. Ask
    // the growth policy what the city needs next instead.
    // The same fact read from the work order's own lifecycle rather than from
    // this cycle's progression status: a Goal whose work order has closed is
    // finished whatever the last step reported, and the city has to be asked
    // what it needs next instead of being held behind a scope that is gone.
    const activeWorkOrderRecord: V2GoalWorkOrderRecord | null =
      this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
    const closedActiveWorkOrder: V2GoalWorkOrderRecord | null =
      activeWorkOrderRecord && goalWorkOrderChainClosed(activeWorkOrderRecord) ? activeWorkOrderRecord : null;
    if (!closedGoalChain && result.status === "BLOCKED" && closedActiveWorkOrder && !closedActiveWorkOrder.parentGoalId) {
      closedGoalChain = `GOAL_WORK_ORDER_CLOSED:${closedActiveWorkOrder.goalId}`;
    }
    // A Goal already in flight whose own deliverable needs a capability this
    // runtime does not have.
    //
    // This is the BACKSTOP, not the detector. The catalogue's own answer — which
    // domains it can zone at all — is read every cycle and the planner drops a
    // domain it cannot zone before turning it into work (`cannotZoneDomain` in
    // `autonomous-brain`), so an Office Goal is no longer admitted to discover
    // the gap. That filter is the authority because it releases by itself the
    // moment the category unlocks.
    //
    // What is left here is the case the filter cannot see: a Goal admitted
    // earlier — by an older build, or by a work order already in durable state —
    // that is now showing the gap. It stands the family down for the rest of
    // THIS cycle so the Brain spends the round on the domains it can execute,
    // and it is deliberately neither durable nor fingerprinted for the same
    // reason as before: a Bridge that later exposes the category clears it with
    // nobody remembering to. Measured live (2026-10-01): without it, office
    // re-admitted every tick, built a road, refused its own zoning and minted
    // its own successor — five Road mutations in four ticks, none usable.
    const capabilityGappedFamily = closedActiveWorkOrder && result.status === "BLOCKED" &&
      ZONE_CAPABILITY_GAP.test(result.reason ?? "")
      ? growthFamilyKey(landUseOfExpansionGoalId(closedActiveWorkOrder.goalId))
      : null;
    // Read once per cycle, here, so the stall counter counts cycles rather than
    // calls. This is the fact the branch below needs: a work order that neither
    // reaches its milestone nor closes never enters the goal-pursuit path at all
    // — it just returns EXHAUSTED to the wait loop forever, so no other Goal is
    // ever considered. Measured live (2026-09-30): that is exactly how one
    // commercial work order froze the whole Mayor across runs.
    const stalledActiveWorkOrder = this.#noteWorkOrderProgress(activeWorkOrderRecord);
    // A tranche that has handed its remaining work to the world is not a reason
    // for the city to stop: see the branch below.
    const awaitsTheWorld = this.#activeTrancheAwaitsTheWorld();
    // The growth policy is consulted from the facts this cycle just re-read, and
    // it is not a stage table: it answers with whatever the current population,
    // demand, service headroom, frontage and development capacity ask for. When
    // the answer is "observe", the Brain lets the city run and reads again,
    // because occupancy and demand are the facts the next Goal is derived from.
    // What the growth policy answered, kept for the cycle's own report. Without
    // it an IDLE cycle and a cycle whose Goal the policy keeps re-deriving look
    // identical from outside: both end as a BLOCKED tick with a closed-chain
    // reason, and the one fact that tells them apart is this.
    let policyAnswer: string | null = null;
    const pursueNextGoal = async (options: { closedGoalChain?: boolean; stalled?: boolean } = {}): Promise<boolean> => {
      const runtime = this.ports.v2ProductionSkillRuntime;
      if (!runtime?.isInitialized()) return false;
      // A live Goal owns the Brain while it still has a step to take. A Goal
      // whose chain has closed owns nothing: leaving it active would let one
      // exhausted Goal block every other Goal the city could be growing toward.
      //
      // "Owns nothing" has to be read from the work order's own lifecycle, not
      // from the fact that some work order is still the active one. A closed
      // work order stays active by identity until its successor replaces it, so
      // testing for mere presence would let one closed Goal veto its own
      // successor — the successor can only be admitted by the path this guard
      // was refusing to enter.
      const activeWorkOrder = runtime.activeGoalWorkOrder?.() ?? null;
      // A Goal that is still taking steps owns the Brain. A Goal that has taken
      // NO step at all for WORK_ORDER_STALL_CYCLES cycles does not: it is not
      // waiting for anything the world will supply, it is simply not moving, and
      // while it holds the Brain no other expansion domain is ever asked for.
      // Measured live (2026-09-30): one such work order froze the whole Mayor
      // across two independent runs with every other domain available.
      //
      // Nothing is written to durable state here. The stalled Goal is suppressed
      // for this ranking, and the admission path below displaces the work order
      // through the mechanism that already exists for it.
      const stalledWorkOrder = options.stalled === true;
      if (!options.closedGoalChain && activeWorkOrder && !goalWorkOrderChainClosed(activeWorkOrder) && !stalledWorkOrder) {
        return false;
      }
      const observe = async (reason: string) => {
        const state = this.#state;
        if (state?.status !== "running") return;
        state.lastStatus = `V2 Brain observing: ${reason}`;
        this.#say({ eventType: "WAIT", toneHint: "CASUAL", subjectDomain: "GENERIC", actionKey: "wait-for-world" });
        this.#emit("status");
        // How long an observation step runs is a pace dial, and it is the one
        // the hardware actually pays for: a city at its stabilization node lets
        // the world run four times as long per step and therefore takes four
        // times fewer steps. It is never a reason not to build — the policy
        // answers "observe" only when there is no room to build at all.
        const observationHours = pace.interPackageObservationHours || AUTONOMOUS_GROWTH_OBSERVATION_HOURS;
        try {
          await boundedRuntimeAwait(
            this.ports.runSimulation({ hours: observationHours, speed: 4 }, this.#abortController.signal),
            this.#abortController.signal,
            simulationStageBudgetMs(observationHours, 4, this.#stageTimeoutMs),
            "simulation",
            "runSimulation",
          );
        } catch (error) {
          // Observation is the Brain letting the city run and reading again, so
          // a simulation that could not be advanced is a cycle that learned
          // nothing, not a Brain failure. The wait loop below already treats it
          // that way; letting it propagate from here instead counted one
          // Bridge-side timing hiccup toward the repeated-failure halt and could
          // stop a city that was working. A real abort still stops the session.
          if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
          state.lastStatus = `V2 Brain could not advance the city: ${message(error)}`;
          this.#emit("status");
        }
        // A bounded advance leaves the world auto-paused at its target frame.
        // Holding it there is what turned the Mayor into a metronome of visible
        // pauses; the observation is over, so the city goes back to running.
        await this.#releaseWorld();
      };
      const snapshot = await this.ports.getSnapshot(this.#abortController.signal,
        this.ports.districtBuilder && profileAllowsExpansion(this.#objectiveProfile, this.#recovered) ? { strategicOnly: true } : undefined);
      const growthState = compileLocalMayorState(snapshot, this.#localHistory);
      // The city's own size now decides the pace the next admission is sized and
      // bounded by. Set here, on the facts this cycle just read, so the brake
      // follows the city rather than being fixed at session start — and set on
      // every cycle, including the ones below the node, so a city that shrinks
      // (or a player who moves the target) is not left on a stale dial.
      pace = this.growthPace(growthState.population);
      this.ports.v2ProductionSkillRuntime?.setGrowthPace?.(pace);
      const durableGoalOrders = this.ports.v2ProductionSkillRuntime?.goalWorkOrders?.() ??
        (activeWorkOrder ? [activeWorkOrder] : []);
      // The third stock, read from the tranches that already observed it. The
      // growth policy's own reserve counts land, and land stops counting the
      // moment a building appears on it — so without this a batch whose
      // buildings nobody moved into reads exactly like an absorbed one.
      const builtButVacant = builtButVacantFromGoalOrders(durableGoalOrders);
      if (builtButVacant) growthState.developmentCapacity.builtButVacantByType = builtButVacant;
      this.#runLedgerBuiltButVacant = builtButVacant
        ? {
            residential: builtButVacant.residential, commercial: builtButVacant.commercial,
            industrial: builtButVacant.industrial, office: builtButVacant.office, unknown: builtButVacant.unknown,
          }
        : null;
      for (const order of durableGoalOrders) {
        const unservable = goalOrderUnservableRoadTarget(order);
        if (!unservable) continue;
        const landUse = landUseOfExpansionGoalId(unservable.goalFamily);
        const family = unservable.goalFamily.startsWith("PROVIDE_SERVICE:")
          ? unservable.goalFamily
          : `${unservable.goalFamily}:${landUse.toLowerCase()}`;
        const currentFacts = growthGoalFactFingerprint(family, landUse, growthState);
        // A closed Goal ID carries the stable fingerprint captured when its
        // target failed. Reconstruct the existing in-memory park after restart
        // only while those same relevant facts still hold; an unrelated world
        // revision cannot reopen it, and a changed planning fingerprint can.
        if (currentFacts !== unservable.factsFingerprint) continue;
        this.#parkedGrowthGoalFacts.set(family, { kind: "FACTS", fingerprint: currentFacts });
      }
      const suppressedGoalFamilies = new Set<string>();
      const factsParkedFamilies = new Set<string>();
      // This cycle's capability gap, if the round has already found one. Applies
      // to the ranking below and to nothing else: no park, no fingerprint.
      if (capabilityGappedFamily) {
        suppressedGoalFamilies.add(capabilityGappedFamily);
        policyAnswer = `GROWTH_POLICY_CAPABILITY_GAP:${capabilityGappedFamily}`;
      }
      const targetParks: Array<{ key: string; park: Extract<GrowthGoalPark, { kind: "TARGET" }> }> = [];
      for (const [key, park] of this.#parkedGrowthGoalFacts) {
        // Each park is read against the facts that raised it: a family held back
        // by the growth policy's own facts, or one target the land itself has
        // already disproved.
        if (park.kind === "FACTS") {
          if (growthGoalFactFingerprint(key, growthLandUseOfFamilyKey(key), growthState) === park.fingerprint) {
            suppressedGoalFamilies.add(key);
            factsParkedFamilies.add(key);
          } else {
            // A material change in the facts that justified the failed search
            // releases this family for a fresh bounded admission attempt.
            this.#parkedGrowthGoalFacts.delete(key);
          }
          continue;
        }
        if (park.released) {
          // The escape released this park for exactly one cycle. It stands down
          // now and is armed again on the next read, so a family that keeps
          // landing on dead ground still reaches the strike limit.
          park.released = false;
          continue;
        }
        if (growthFootprintTargetFingerprint(park.subjectKey, growthState) !== park.fingerprint) {
          this.#parkedGrowthGoalFacts.delete(key);
          continue;
        }
        if (park.strikes >= GROWTH_TARGET_PARK_STRIKE_LIMIT) {
          // Enough admissions have died on this exact ground that the domain,
          // not one target, is the finding. Hand it to the family-wide park,
          // which the land facts themselves release.
          this.#parkedGrowthGoalFacts.delete(key);
          this.#parkedGrowthGoalFacts.set(park.family,
            { kind: "FACTS", fingerprint: growthGoalFactFingerprint(park.family, park.landUse, growthState) });
          suppressedGoalFamilies.add(park.family);
          factsParkedFamilies.add(park.family);
          continue;
        }
        targetParks.push({ key, park });
        suppressedGoalFamilies.add(park.family);
      }
      // A stalled work order is suppressed for exactly as long as it is stalled,
      // and no longer. Deliberately not a durable park: a park that stands on the
      // planning facts would be released by the very observation step the Brain
      // takes next, and the same frozen Goal would be admitted again — the
      // measured live loop this whole ladder exists to avoid. The watch is
      // re-read every cycle and clears itself the moment the work order moves, so
      // a Goal that recovers is asked for again immediately.
      if (stalledWorkOrder && activeWorkOrder) {
        const stalledBaseGoalId = activeWorkOrder.goalId.split(":facts:")[0]!;
        suppressedGoalFamilies.add(stalledBaseGoalId);
        if (stalledBaseGoalId.startsWith("EXPAND_")) {
          suppressedGoalFamilies.add(growthFamilyKey(landUseOfExpansionGoalId(stalledBaseGoalId)));
        }
        policyAnswer = `GROWTH_POLICY_WORK_ORDER_STALLED:${stalledBaseGoalId}`;
        this.#say({ eventType: "ACT_REJECT_RETRY", toneHint: "NEUTRAL",
          subjectDomain: landUseOfExpansionGoalId(stalledBaseGoalId) as MayorSubject,
          reasonKey: "candidate-refused", continuityRef: activeWorkOrder.goalId });
        this.#emit("status");
      }
      // Every Goal the city currently wants, best first. A ranked list rather
      // than one answer, because "the best Goal could not be admitted" and "the
      // city has nothing to build" are different findings, and the single-answer
      // shape forced this cycle to treat them the same — which is how one dead
      // domain came to mean an idle Mayor while three others had land.
      const rankGoals = () => rankedGrowthGoals(growthState, this.growthMode,
        this.#pendingStructuredIntent, suppressedGoalFamilies);
      let ranked = rankGoals();
      if (ranked.length === 0 && targetParks.length > 0) {
        // A target the land disproved is not proof that the domain is
        // unavailable, and it must never leave the Brain with nothing to do
        // while a legitimate growth opportunity exists. Release the oldest such
        // park and ask once more, so the family can try another candidate or
        // site before "no goal" is the answer. The re-park on the next failure
        // counts the strike, and the strike limit bounds the whole ladder.
        const released = targetParks[0]!;
        this.#parkedGrowthGoalFacts.set(released.key, { ...released.park, released: true });
        if (!factsParkedFamilies.has(released.park.family)) suppressedGoalFamilies.delete(released.park.family);
        ranked = rankGoals();
        if (ranked.length > 0) policyAnswer = `GROWTH_POLICY_TARGET_RETRY:${released.park.subjectKey}`;
      }
      // Nothing workable is left even after the park release: the domains refused the ground the roads can see.
      // Offer the frontier Goal, so admission's frontier survey can look for open owned land no road reaches.
      if (!ranked.some((goal) => goal.type !== "ADVANCE_SIMULATION" && goal.type !== "PAUSE_FOR_ISSUE")) {
        const withFrontier = rankedGrowthGoals(growthState, this.growthMode, this.#pendingStructuredIntent,
          suppressedGoalFamilies, { frontierFallback: true });
        if (withFrontier.length > ranked.length) {
          ranked = withFrontier;
          policyAnswer = "GROWTH_POLICY_FRONTIER_SURVEY";
        }
      } else if (this.#parkedGrowthGoalFacts.size > 0 && !suppressedGoalFamilies.has("ESTABLISH_ROAD_NETWORK") &&
        !ranked.some((goal) => goal.type === "ESTABLISH_ROAD_NETWORK") && !this.#pendingStructuredIntent) {
        // Domains are being tried and some are already parked: the frontier Goal goes at the END of the queue, so it
        // is reached exactly when every domain above it has refused its own land (measured live 2026-10-03: 45
        // ticks of "every expansion domain refused", then observation, and the frontier was never asked).
        ranked = [...ranked, { goalId: "ESTABLISH_ROAD_NETWORK", type: "ESTABLISH_ROAD_NETWORK", urgency: 1,
          evidence: ["NO_EXPANSION_WORK_LEFT_ON_SEEN_GROUND"] }];
      }
      if (ranked.length === 0) {
        policyAnswer = "GROWTH_POLICY_HAS_NO_GOAL";
        return false;
      }
      // A Goal whose whole point is that the next expansion area is *already*
      // prepared used to suppress the Brain until population or demand moved:
      // `GROWTH_POLICY_NEXT_AREA_ALREADY_PREPARED`, answered with a simulation
      // wait. That is the opposite of the product's posture. Prepared land is
      // precisely what should be built on next, and the Goal is now admitted
      // like any other.
      const preferred = ranked[0]!;
      if (preferred.type === "PAUSE_FOR_ISSUE") {
        policyAnswer = "GROWTH_POLICY_PAUSED_FOR_BLOCKER";
        this.#say({ eventType: "PAUSE_ISSUE", toneHint: "SERIOUS", subjectDomain: "GENERIC",
          reasonKey: "growth-condition-blocks" });
        return false;
      }
      if (preferred.type === "ADVANCE_SIMULATION") {
        policyAnswer = `GROWTH_POLICY_OBSERVES:${preferred.goalId}`;
        await observe("no executable gap in the current world facts");
        return false;
      }
      // Try each domain's Goal in turn, best first. A refusal that is about this
      // Goal's own land, or about this Goal having run out of bounded work, is a
      // refusal about ONE domain — the loop moves to the next. Only a refusal
      // about the world itself stops the cycle, because re-reading the world is
      // the only thing that can change it.
      const attemptedDomains = new Set<string>();
      let sawDomainRefusal = false;
      for (const goal of ranked) {
        if (goal.type === "PAUSE_FOR_ISSUE" || goal.type === "ADVANCE_SIMULATION") continue;
        const domainKey = goal.type.startsWith("EXPAND_") || goal.goalId.startsWith("EXPAND_")
          ? growthFamilyKey(landUseOfExpansionGoalId(goal.goalId))
          : goal.goalId;
        if (attemptedDomains.has(domainKey)) continue;
        attemptedDomains.add(domainKey);
        const landUse = landUseOfExpansionGoalId(goal.goalId);
        const goalFacts = growthGoalFactFingerprint(goal.goalId, landUse, growthState);
        const goalId = `${goal.goalId}:facts:${goalFacts}`;
        try {
          const goalProducedAtMs = this.#now().getTime();
          // Where this Goal is done: read from its own id by
          // `goalCompletionStageForGoalId`, so every reader agrees on what a
          // Goal's deliverable is. A growth Goal's is its delivered land, not
          // the residents who may later arrive on it.
          const completionStage = goalCompletionStageForGoalId(goalId);
          const admission = await this.ensureGoalWorkOrder(goalId, landUse, completionStage);
          if (goal.type === "ESTABLISH_ROAD_NETWORK") {
            latestRoadGoalProducedAtMs = goalProducedAtMs;
            latestRoadAdmissionEvidence = (admission as { evidence?: Record<string, unknown> } | null)?.evidence ?? null;
            this.#say({ eventType: "PREPARE", toneHint: "NEUTRAL", subjectDomain: "GRID",
              observationKey: "grid-aligned", actionKey: "prepare-grid", reasonKey: "safe-expansion-window",
              continuityRef: goalId });
          } else {
            // A service Goal is admitted in its own domain and says what it is
            // doing. Announcing it as residential grid work would narrate a road
            // extension the Brain is not performing, and the caption is a claim
            // about real behaviour.
            const serviceKind = /^PROVIDE_SERVICE:(electricity|water|sewage)\b/.exec(goal.goalId)?.[1];
            const domain: MayorSubject = serviceKind === "water" ? "WATER" : serviceKind === "sewage" ? "SEWAGE"
              : serviceKind === "electricity" ? "ELECTRICITY"
                : landUseOfExpansionGoalId(goal.goalId) as MayorSubject;
            this.#say({ eventType: "PREPARE", toneHint: "NEUTRAL", subjectDomain: domain,
              actionKey: serviceKind ? "provide-service" : "prepare-grid", continuityRef: goalId });
          }
          this.#pendingStructuredIntent = null;
          if (this.#state) this.#state.pendingUserCommand = null;
          // Which domain was admitted, and which earlier ones this cycle had to
          // give up on to reach it. The switch is carried in the policy answer
          // rather than narrated again here: the Goal's own subject was already
          // announced above, from its own land use or its own utility.
          policyAnswer = attemptedDomains.size > 1
            ? `GROWTH_POLICY_DOMAIN_SWITCH:${[...attemptedDomains].slice(0, -1).join(",")}->${goalId}`
            : `GROWTH_POLICY_ADMITTED:${goalId}`;
          return true;
        } catch (error) {
          const failure = message(error);
          // A bounded search that disproved this ground, named by the ring it
          // read rather than by one centre in it. Distinct from the family-wide
          // park: the Goal is not unwarranted and the city may still want it —
          // this land just cannot take it. Parking the target rather than the
          // family is what lets the same domain be asked for somewhere else.
          const unserviceable = error instanceof V2GrowableFootprintUnserviceableError ? error.subject : null;
          const parkedFamily = goal.type.startsWith("EXPAND_") ? growthFamilyKey(landUse) : goal.goalId;
          if (unserviceable) {
            const targetKey = `TARGET:${unserviceable.subjectKey}`;
            const prior = this.#parkedGrowthGoalFacts.get(targetKey);
            const strikes = prior?.kind === "TARGET" && prior.subjectKey === unserviceable.subjectKey
              ? prior.strikes + 1
              : 1;
            this.#parkedGrowthGoalFacts.set(targetKey, {
              kind: "TARGET",
              subjectKey: unserviceable.subjectKey,
              family: parkedFamily,
              landUse,
              fingerprint: growthFootprintTargetFingerprint(unserviceable.subjectKey, growthState),
              strikes,
              released: false,
            });
          }
          if (isDomainScopedRefusal(failure)) {
            // The finding is about this Goal's own land or its own exhausted
            // bounded work, and letting the city run cannot change either. Move
            // to the next domain in this same cycle rather than yielding the
            // city to a wait.
            sawDomainRefusal = true;
            policyAnswer = unserviceable
              ? `GROWTH_POLICY_TARGET_PARKED:${unserviceable.subjectKey}:${unserviceable.reason}${
                unserviceable.detail ? `:${unserviceable.detail}` : ""}`
              : `GROWTH_POLICY_GOAL_SKIPPED:${goalId}:${failure}`;
            continue;
          }
          policyAnswer = `GROWTH_POLICY_GOAL_CLOSED:${goalId}:${failure}`;
          await observe(`the policy's current Goal is closed (${failure})`);
          return false;
        }
      }
      // Every domain the city currently wants was tried inside this cycle and
      // none could be admitted. This is the one refusal the search cannot answer
      // for itself: the finding is about all the land the city can reach, so the
      // world is what has to change, and letting it run is the answer rather
      // than yielding a cycle that will re-read the same facts.
      if (sawDomainRefusal) {
        policyAnswer = `GROWTH_POLICY_ALL_DOMAINS_REFUSED:${policyAnswer ?? ""}`;
        await observe("every expansion domain the city wants refused its own land");
        return false;
      }
      return false;
    };
    const reachedOccupancy = result.status === "MILESTONE_REACHED" && result.stage === "OCCUPIED" &&
      result.state?.project?.status === "OCCUPIED";
    const projectClosedForPlanning = result.state?.project?.status === "COMPLETE" ||
      result.state?.project?.status === "BLOCKED";
    // A top-level project left ACTIVE at a milestone whose work order has already been completed (a road-only
    // Goal ends at ROAD_DELIVERED) has no task and no work order. Measured live (2026-10-02): every tick of a
    // fresh session answered the liveness invariant and the growth policy was never asked, so the Mayor built
    // nothing. It is a finished plan, and the next Goal replaces it through ordinary admission.
    const orphanedProject = !activeWorkOrderRecord &&
      /Gate 1 liveness invariant violated/.test(String((result as { reason?: unknown }).reason ?? ""));
    if (reachedOccupancy || projectClosedForPlanning || orphanedProject) {
      // A project that closed for planning — COMPLETE or terminally BLOCKED —
      // is a finished work order, so the Goal it belonged to does not still own
      // the Brain and must not veto the Goal that replaces it.
      if (await pursueNextGoal({ closedGoalChain: !!closedActiveWorkOrder, stalled: stalledActiveWorkOrder })) {
        result = await advanceActiveWorkOrder() as typeof result;
      } else if (closedActiveWorkOrder && !reachedOccupancy) {
        // A closed work order that could re-admit nothing from these facts is a
        // scheduler yield, not a terminal block: the next cycle re-reads a city
        // that has been allowed to run and asks again. A project that merely
        // completed its milestone is not this case and keeps its milestone
        // result, so a finished project is not reported as a hand-off.
        const closedReason = closedGoalChain ?? `GOAL_WORK_ORDER_CLOSED:${closedActiveWorkOrder.goalId}`;
        result = {
          status: "PLANNING_HANDOFF",
          reason: policyAnswer ? `${closedReason}:${policyAnswer}` : closedReason,
        };
      }
    } else if (closedGoalChain || stalledActiveWorkOrder || awaitsTheWorld) {
      // The Goal this Brain was advancing has closed without reaching a
      // milestone, has stopped moving entirely, or has handed the rest of its
      // work to the world. All three mean the same thing for this cycle: it does
      // not get to decide that the city builds nothing.
      //
      // The third case is the throughput one. A tranche waiting for its
      // buildings to appear has already delivered its road and its zoning;
      // watching it is the most expensive thing the Brain can do, and another
      // domain's package is work it could be doing instead.
      //
      // The stalled case is the one that was missing. A work order that neither
      // reaches its milestone nor closes returns EXHAUSTED to the wait loop
      // forever, and because it never closed, this whole block was skipped and
      // no other Goal was ever asked for — the Brain looked busy and built
      // nothing, which is exactly what was measured live (2026-09-30).
      //
      // Before asking the growth policy what the city needs next,
      // give the city's service Goals their own bounded turn.
      //
      // They are the Goals whose prerequisite just ran out, and they are the only
      // thing that can tell this Brain whether that Goal is spent or merely
      // waiting. Asking the policy first would re-derive the same exhausted
      // corridor: the policy answers from demand, and demand cannot see that the
      // Goal's own bounded work is gone. The pass is asked WITHOUT moving the
      // closed step's milestone — the step did not reach one, and pretending it
      // did is what the gate it used to sit behind forced.
      //
      // Asked only for a SERVICE chain. The pass spends real native work to
      // answer for electricity, water and sewage, and a residential or
      // commercial Goal closing says nothing about any of them.
      const settle = await (async () => {
        const progression = this.ports.v2Gate1Progression;
        if (!progression?.settleUtilityGoals) return null;
        const closedGoalId = closedActiveWorkOrder?.goalId ?? closedGoalChain ?? activeWorkOrderRecord?.goalId ?? "";
        if (!SERVICE_GOAL_ID.test(closedGoalId)) return null;
        this.#requireRunning().lastStatus = "V2 Brain settling the city's service Goals";
        this.#emit("status");
        try {
          return await progression.settleUtilityGoals(this.#abortController.signal);
        } catch (error) {
          return { status: "UNAVAILABLE" as const, reason: message(error) };
        }
      })();
      this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
      const settledActive = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
      // Gated on the pass having actually been asked. Without `settle`, no
      // bounded turn was taken, so the work order that is active now is the one
      // that was already active — usually the very one this branch exists to
      // stop being held behind — and reading it as the pass's own product
      // advanced nothing while looking like progress.
      if (settle && settledActive && !goalWorkOrderChainClosed(settledActive)) {
        // The pass took a service Goal's bounded turn and admitted a work order
        // for it. That work order is now the Brain's, not the policy's.
        result = await advanceActiveWorkOrder();
      } else if (await pursueNextGoal({ closedGoalChain: true, stalled: stalledActiveWorkOrder || awaitsTheWorld })) {
        result = await advanceActiveWorkOrder() as typeof result;
        // THE BATCH.
        //
        // That was one Goal's worth of building — one corridor, one frontage,
        // one footprint zoned. A city that only ever settles one tranche per
        // cycle is a person clicking; a city that settles as many as it can pay
        // for is a machine, and the fixed costs it is spreading are exactly the
        // ones that hurt: the ring census, the corridor plan, the native
        // previews, the admission, the Apply and the readback.
        //
        // So keep going while the tranche that just finished is only waiting on
        // the world — it has no executable work left, nothing is abandoned by
        // moving on — and the treasury still covers another. Bounded by capacity
        // rather than by a constant, so a rich city expands in batches and a
        // poor one expands in ones, and bounded absolutely so one cycle cannot
        // run away with the tick.
        const batchState = compileLocalMayorState(this.#requireState().lastSnapshot, this.#localHistory);
        for (let batched = 1; batched < growthBatchSize(batchState); batched += 1) {
          if (!this.#activeTrancheAwaitsTheWorld()) break;
          if (!(await pursueNextGoal({ closedGoalChain: true, stalled: false }))) break;
          const batchedResult = await advanceActiveWorkOrder() as typeof result;
          result = batchedResult;
          // A tranche that reached its milestone is finished building; one that
          // did not is a finding the next cycle has to read from fresh facts.
          if (batchedResult.status !== "MILESTONE_REACHED") break;
        }
      } else {
        // A stalled work order has no closed chain to name, so the reason is the
        // stall itself; without this the handoff would report a bare "null".
        const chain = closedGoalChain ??
          (stalledActiveWorkOrder ? `GOAL_WORK_ORDER_STALLED:${activeWorkOrderRecord?.goalId ?? ""}` : "");
        const handoff = settle?.reason ? `${chain}:${settle.status}:${settle.reason}` : chain;
        result = { status: "PLANNING_HANDOFF",
          reason: policyAnswer ? `${handoff}:${policyAnswer}` : handoff };
      }
    }
    // One Road Goal is one coherent package of streets, not one segment. The
    // chain used to run only at the session's own "fast" speed, which made the
    // product's headline posture an option nobody enabled; the pace now decides
    // how many items a package carries, and full pace is the default.
    //
    // Every item is an ordinary bounded Road step with its own native preview,
    // durable command, Apply and authoritative readback, and every item is the
    // same kind of work: a street. A street batch is not a batch of zones — the
    // capacity it creates is frontage, and the growth goals that follow are the
    // ones that consume it, each on a land use the policy actually chose. What
    // the batch buys is the fixed cost: one ring census, one corridor plan, one
    // native preview and one Apply per street, all spent on the same city.
    //
    // The loop used to stop after the item it called the "carrier", which was the
    // last one by construction, so a package of five already built five streets.
    // It stops now only when an item fails to reach its milestone, which is a
    // finding about the world rather than a schedule.
    if (latestRoadGoalProducedAtMs !== null &&
      result.status === "MILESTONE_REACHED" && result.stage === "ROAD_DELIVERED") {
      const root = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
      if (root?.goalId.startsWith("ESTABLISH_ROAD_NETWORK") && root.completionStage === "ROAD_DELIVERED") {
        const batchStartedAt = latestRoadGoalProducedAtMs;
        const counters = { applySuccesses: 1, previewCandidates: 0, nativeRejections: 0 };
        const rootEvidence: Record<string, unknown> = latestRoadAdmissionEvidence ?? {};
        counters.previewCandidates += Number(rootEvidence["nativeRoadPreviewCount"] ?? 0);
        counters.nativeRejections += Number(rootEvidence["nativeRoadPreviewRejectedCount"] ?? 0);
        const firstSubmittedAt = Date.parse(String((result as { latestRoadSubmissionAt?: string | null }).latestRoadSubmissionAt ?? ""));
        const goalToFirstApplyMs = Number.isFinite(firstSubmittedAt)
          ? Math.max(0, firstSubmittedAt - batchStartedAt) : Math.max(0, this.#now().getTime() - batchStartedAt);
        const rootGoalId = root.goalId;
        this.ports.v2ProductionSkillRuntime?.completeGoalWorkOrder?.(rootGoalId);
        this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
        let trancheStage: string | null = null;
        let roadSubmissionAt = String((result as { latestRoadSubmissionAt?: string | null }).latestRoadSubmissionAt ?? "");
        for (let item = 2; item <= pace.maximumPackageItems; item += 1) {
          const freshSnapshot = await this.ports.getSnapshot(this.#abortController.signal);
          const freshState = compileLocalMayorState(freshSnapshot, this.#localHistory);
          const hardServiceIssue = [freshState.utilities.electricity, freshState.utilities.water, freshState.utilities.sewage]
            .some((utility) => !utility.available || utility.risk === "critical");
          const financeBlocked = freshState.financeRunwayMonths !== null && freshState.financeRunwayMonths < 3;
          if (freshState.status !== "available" || hardServiceIssue || financeBlocked || freshState.issues.highest?.actionable) break;
          const packageItemGoalId = `${rootGoalId}:FAST_GROWTH_PACKAGE_ITEM:${item}`;
          try {
            // Road-only, and named that way rather than left to be derived from
            // the id. An `ESTABLISH_ROAD_NETWORK` scope carries no land use — the
            // goals that generate it (`expand_frontier`,
            // `recover_from_failed_expansion`) have no domain of their own — so
            // there is no zone category this item could honestly write. Making it
            // walk a land ladder would send it through the generic starter site
            // search on a land use nobody chose, and ending it early at the road
            // is the same statement the road-only prerequisite makes: this scope
            // owns the delivered road and the frontage it opens, and the growth
            // goals that follow are the ones that zone it.
            const admission = await this.ensureGoalWorkOrder(packageItemGoalId, undefined,
              "ROAD_DELIVERED") as { evidence?: Record<string, unknown> } | null;
            const evidence = admission?.evidence ?? {};
            counters.previewCandidates += Number(evidence["nativeRoadPreviewCount"] ?? 0);
            counters.nativeRejections += Number(evidence["nativeRoadPreviewRejectedCount"] ?? 0);
            this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
            const itemResult = await advanceActiveWorkOrder() as typeof result;
            result = itemResult;
            // Counted from the durable journal's own latest submission rather
            // than from the milestone: a carrier that opens the tranche and then
            // settles on a diagnosis still built the road it opened with.
            const submittedAt = String((itemResult as { latestRoadSubmissionAt?: string | null }).latestRoadSubmissionAt ?? "");
            if (submittedAt && submittedAt !== roadSubmissionAt) {
              counters.applySuccesses += 1;
              roadSubmissionAt = submittedAt;
            }
            if (itemResult.status !== "MILESTONE_REACHED") break;
            trancheStage = itemResult.stage ?? trancheStage;
            // This street is finished, so its work order is: the next item opens
            // its own, and the batch continues while the city can still pay for
            // streets and still has service.
            this.ports.v2ProductionSkillRuntime?.completeGoalWorkOrder?.(packageItemGoalId);
            this.ports.v2ProductionSkillRuntime?.invalidateReadiness();
          } catch {
            // A candidate family that cannot be admitted closes this bounded
            // package. The next Brain pass will read the world and choose again.
            break;
          }
        }
        const batchElapsedMs = Math.max(0, this.#now().getTime() - batchStartedAt);
        this.#requireState().fastExpansionMetrics = {
          goalToFirstApplyMs, batchElapsedMs,
          previewCandidates: counters.previewCandidates,
          applySuccesses: counters.applySuccesses,
          nativeRejections: counters.nativeRejections,
          trancheStage,
        };
        if (counters.applySuccesses >= 2) {
          this.#say({ eventType: "BLOCK_COMPLETE", toneHint: "NEUTRAL", subjectDomain: "GRID",
            resultKey: "batch-complete", continuityRef: rootGoalId });
        }
        if (counters.applySuccesses >= 2) {
          this.#say({ eventType: "WAIT", toneHint: "CASUAL", subjectDomain: "GRID",
            actionKey: "wait-for-world", continuityRef: rootGoalId });
          try {
            await this.#awaitSimulationWindow();
          } catch (error) {
            if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
          }
        }
      }
    }
    // An unresolved cycle is a scheduler yield, not completion. Keep the
    // product's autonomous loop alive: let the city run, pause briefly, then
    // re-enter progression, which starts from fresh authoritative reads. Each
    // pass remains bounded and the overall wait has a hard cap so a real blocker
    // is reported rather than hidden.
    // A cycle that ends without a reachable milestone is not the end of the
    // city. WAITING, an exhausted Skill ladder and a capability gap all say the
    // same thing: the fact the next decision needs is not in the world yet. A
    // paused world never produces it — a placed facility becomes operational,
    // a zoned lot gets built on, demand appears, only while the simulation runs
    // — so the Brain lets the city run and asks again, bounded.
    // A scheduler yield's reason survives the bounded re-observation below. The
    // loop ends on the same closed chain it started from, so its final BLOCKED
    // would otherwise bury the one fact worth reporting: what the growth policy
    // answered when it was asked.
    const yieldReason = result.status === "PLANNING_HANDOFF" ? result.reason : null;
    const unresolvedStatuses: readonly string[] = ["WAITING", "EXHAUSTED", "PLANNING_HANDOFF", "CAPABILITY_GAP"];
    // The bound is the number of times this loop can ADVANCE THE WORLD, not a
    // poll count. Only the first `AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS` cycles
    // ask the city to run; every cycle after that would re-observe an unchanged
    // paused world, and a re-observation of a frozen frame cannot produce the
    // fact the wait is for. It could only spend the game thread — each pass is a
    // snapshot plus a spatial scan plus a bounded detail read — and that is what
    // starved the very simulation this loop exists to let finish: the next
    // cycle's `runSimulation` was queued behind ~116 inert progression passes
    // and blew the stage budget.
    //
    // So the loop is bounded by the work it can actually do. When the world has
    // been given its bounded chance and the fact still has not arrived, this is
    // a real WAITING and the honest answer is to report it: the outer Brain loop
    // re-enters from fresh facts on its next cycle, and a genuinely stuck wait
    // stays bounded instead of holding the tick for minutes.
    //
    // BUILD BURST, before any of that: while the tranche still holds a
    // construction task it can execute, re-enter progression immediately and do
    // NOT advance the world. The simulation is the most expensive operation in
    // the system and it is only ever the right answer when the next fact cannot
    // be produced by building. Measured live (2026-10-01): eleven simulation
    // calls, two mutations, and four fifths of all native traffic spent polling
    // for an auto-pause that was covering work already sitting in the queue.
    //
    // A burst of BUILDING, which is a claim the tranche's own position has to
    // keep making. Measured live (2026-10-01, greenfield bootstrap): the active
    // electricity Goal held a `PENDING` ZONING task whose commission step could
    // only answer `UTILITY_SERVICE_PROGRESS_PENDING`, so three burst entries each
    // spent twelve simulation windows — the whole tick — and left the tranche
    // exactly where they found it. Re-entering progression on work that has
    // already answered "not without the world" is not building; it is paying for
    // the same simulation twice.
    //
    // The position is the stage and the task ledger, and deliberately not the
    // Gate1 journal: every decision the progression takes appends to it, so a
    // call that spent twelve decisions asking for the world twelve times looks
    // like twelve steps of progress by journal length and like no progress at
    // all by a task that is still `PENDING` with no command against it. A write
    // that actually happened moves the task — to `SUCCEEDED`, or to a dispatched
    // status carrying the command's own id — so real building is never mistaken
    // for a repeat.
    const tranchePosition = (order: V2GoalWorkOrderRecord | null): string => {
      const state = order?.state as { tranche?: { stage?: string };
        tasks?: ReadonlyArray<{ kind: string; status: string; activeCommandId?: string | null }> } | undefined;
      return JSON.stringify([order?.status ?? null, state?.tranche?.stage ?? null,
        (state?.tasks ?? []).map((task) => `${task.kind}:${task.status}:${task.activeCommandId ?? ""}`)]);
    };
    let burstPosition = tranchePosition(this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null);
    let burstFoundOnlyWaiting = false;
    for (let burst = 0; burst < AUTONOMOUS_BUILD_BURST_ATTEMPTS; burst += 1) {
      if (!unresolvedStatuses.includes(result.status ?? "")) break;
      if (!this.#activeTrancheHasExecutableWork()) break;
      const state = this.#requireRunning();
      state.lastStatus = `V2 Brain building: ${result.reason ?? "an executable construction task is pending"}`;
      this.#emit("status");
      result = await advanceActiveWorkOrder();
      const position = tranchePosition(this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null);
      if (position === burstPosition) { burstFoundOnlyWaiting = true; break; }
      burstPosition = position;
    }
    // That finding is the same one the Goal-pursuit branch above acts on, and it
    // has to be acted on here too. That branch is only entered while the
    // tranche's own tasks are all waited-on, so a tranche holding a `PENDING`
    // task it cannot actually advance — the electricity Goal above — never
    // reached it, and the rest of the cycle went on running the world for one
    // Goal while every other domain went unasked. A tranche the burst just proved
    // can only advance by running the world is waiting on the world, so the cycle
    // asks the growth policy what this city needs next, exactly as that branch
    // does. Whether another Goal exists is the policy's answer rather than an
    // assumption here: a refusal leaves the wait loop below to give the world its
    // bounded chance unchanged.
    if (burstFoundOnlyWaiting && await pursueNextGoal({ closedGoalChain: true, stalled: true })) {
      result = await advanceActiveWorkOrder() as typeof result;
    }
    // What this wait is actually for, read once from the result the cycle is
    // holding. A wait another operation's construction answers is not a world
    // wait, and spending simulation windows on it is the measured defect.
    const waitsOnDependentConstruction = !wakeNeedsTheWorldToRun(
      (result as { wake?: { condition?: string; detail?: string } | null }).wake);
    for (let cycle = 0; !["GROWTH_POLICY_PAUSED_FOR_BLOCKER", "GROWTH_POLICY_NEXT_AREA_ALREADY_PREPARED"].includes(policyAnswer ?? "") &&
      unresolvedStatuses.includes(result.status ?? "") &&
      cycle < AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS; cycle += 1) {
      // Waiting freezes this operation, not the city. The fact will arrive when
      // another tranche builds — so end the cycle with the wait reported and let
      // the next cycle re-read facts and ask the growth policy again, instead of
      // running the world four times for an answer the clock does not hold.
      if (waitsOnDependentConstruction) break;
      const state = this.#requireRunning();
      // WAITING asks for world progress, not for another read of the same frozen
      // frame. Let the city run before asking again — a paused world can never
      // produce the fact the wait is for, which is how a placed facility that is
      // merely not operational yet becomes a permanent stall.
      if (cycle < AUTONOMOUS_WAIT_SIMULATION_ATTEMPTS) {
        state.lastStatus = `Autonomous Brain letting the city run: ${result.reason ?? "authoritative observation pending"}`;
        this.#emit("status");
        try {
          await this.#awaitSimulationWindow();
        } catch (error) {
          if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
          // The world could not be advanced this cycle. Keep the existing
          // bounded re-observation instead of failing the cycle.
          state.lastStatus = `Autonomous Brain could not advance the city: ${message(error)}`;
          this.#emit("status");
          break;
        }
      }
      state.lastStatus = `Autonomous Brain waiting for world progress: ${result.reason ?? "authoritative observation pending"}`;
      this.#emit("status");
      await (this.ports.delay ?? defaultDelay)(AUTONOMOUS_CONSTRUCTION_WAIT_DELAY_MS, this.#abortController.signal);
      result = await advanceActiveWorkOrder();
    }
    if (result.status === "WAITING") {
      // Name the wait for what it is. "Budget exhausted" would be a lie when no
      // window was bought at all, and it is exactly that string an operator was
      // reading while the city was frozen for a fact the clock cannot produce.
      const prefix = waitsOnDependentConstruction
        ? "AUTONOMOUS_CONSTRUCTION_LOCAL_WAIT"
        : "AUTONOMOUS_CONSTRUCTION_WAIT_BUDGET_EXHAUSTED";
      result = { ...result, reason: `${prefix}:${result.reason ?? "authoritative observation pending"}` };
    }
    if (yieldReason && typeof result.reason === "string" && !result.reason.includes(yieldReason)) {
      result = { ...result, reason: `${result.reason}:${yieldReason}` };
    }
    // A delivered package is land, not a city. Roads and zoning are static
    // mutations: they apply without the world advancing, so a cycle that only
    // builds can finish a whole run while the game clock never moves a frame —
    // measured live (2026-10-02): 6/6 ticks delivered, `cs2_run_simulation` was
    // called six times and **every one was `{cancel:true}`**, and the frame index
    // and game date were unchanged across the entire run. Zoned land becomes
    // buildings only while the city runs, so a cycle that delivered lets the
    // world run ONE bounded window before handing back. One window per delivery,
    // and never while the tranche is only waiting: this is the product's
    // "let the city run" half, not the wait loop that was removed for spending
    // the whole tick on a fact the clock could not supply.
    // `GROWTH_POLICY_OBSERVES` means this cycle already let the city run (the
    // policy had no Goal left and observing is what it answered); running a
    // second window here would charge the same delivery twice.
    if (result.status === "MILESTONE_REACHED" && !(policyAnswer ?? "").startsWith("GROWTH_POLICY_OBSERVES")) {
      const state = this.#state;
      if (state?.status === "running") {
        state.lastStatus = "Autonomous Brain letting the delivered land build out";
        this.#emit("status");
      }
      try {
        await this.#awaitSimulationWindow();
      } catch (error) {
        if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
        // The world could not be advanced. The delivery still happened and is
        // durable, so this is a cycle that learned nothing extra, not a failure.
        if (state?.status === "running") {
          state.lastStatus = `Autonomous Brain could not advance the city: ${message(error)}`;
          this.#emit("status");
        }
      }
    }
    // What the growth policy answered this cycle, for the ledger. The Brain's
    // own result does not carry it in a machine-readable field, so it is taken
    // here, where it is final, rather than re-derived from a status string.
    this.#runLedgerDecision.policyAnswer = policyAnswer;
    return result;
  }

  /**
   * Read-only K05 admission preflight. It maps the authoritative context through
   * `buildUtilityPreparationInput` and never calls utility `prepare()` or `run()`.
   */
  async productionK05Preflight(): Promise<unknown> {
    this.#requireRunning();
    const runtime = this.ports.v2ProductionSkillRuntime;
    if (!runtime?.isInitialized()) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
    const context = (await runtime.readiness()) as AuthoritativeUtilityAdmissionContext;
    try {
      return {
        admitted: true,
        stage: context.state.tranche.stage,
        // The whole authoritative context travels into the admission builder:
        // the certified road and the durable first-facility placement state are
        // the authority a first placement needs, so projecting this call down to
        // state/world/treasury would silently withhold it from this preflight.
        preparation: buildUtilityPreparationInput(context),
      };
    } catch (error) {
      return { admitted: false, stage: context.state?.tranche?.stage ?? null, reason: message(error) };
    }
  }

    /**
     * Continue an in-flight production utility workflow through the same
     * production dispatch path. Durable state decides: the workflow is re-entered
     * only while the admitted tranche holds an unfinished utility operation, and
     * the workflow's own write-ahead placement guard still forbids a second
     * facility placement. This continues the attempt already on record and never
     * starts a new one.
     */
    async resumeInFlightProductionSkill(): Promise<import("./skills/schemas/result").SkillResult | null> {
      const MAX_RESUME_ATTEMPTS = 12;
      const runtime = this.ports.v2ProductionSkillRuntime;
      if (this.#state?.status !== "running" || !runtime?.isInitialized()) return null;
      if (this.#productionResumeAttempts >= MAX_RESUME_ATTEMPTS) return null;
      if (!(await this.#hasInFlightUtilityOperation(runtime))) return null;
      if (this.#state?.status !== "running") return null;
      this.#productionResumeAttempts += 1;
      return this.dispatchProductionSkillIntent({ skillId: "skill.K05" });
    }

    /**
     * Durable in-flight test. A utility kind is in flight while it has not
     * certified its service *and* at least one durable placement or connection
     * operation was already attempted. A clean scope, where nothing was ever
     * attempted, is never resumed automatically.
     */
    async #hasInFlightUtilityOperation(runtime: { readiness(): Promise<unknown> }): Promise<boolean> {
      const context = (await runtime.readiness()) as AuthoritativeUtilityAdmissionContext;
      const utilities = context.state?.tranche?.utilityExecution?.utilities;
      if (!utilities) return false;
      return Object.values(utilities).some((utility) =>
        utility.stage !== "SERVICE_CERTIFIED" &&
        (utility.constructionAttempts > 0 || utility.facilityCommandId !== null || utility.networkCommandIds.length > 0));
    }


  singleTick(): Promise<MayorSessionState> {
    this.#requireRunning();
    if (!this.#tickPromise) {
      this.#tickPromise = this.#runTick()
        .then(async () => {
          // The run ledger's only escalation, applied once per tick so every
          // path through the tick is covered. A run of bounded observation
          // windows that changed nothing measurable, and that was not a
          // declared wait for an effect, stops the session with that reason.
          // It reports and stops; it never invents a recovery.
          const stallReason = this.#requireState().runLedger?.stallReason ?? null;
          if (stallReason && this.#requireState().status === "running") await this.#halt(stallReason);
          return this.#snapshotState();
        })
        .finally(() => {
          this.#tickPromise = null;
        });
    }
    return this.#tickPromise;
  }

  continuousRun(): Promise<MayorSessionState> {
    this.#requireRunning();
    if (!this.#continuousPromise) {
      this.#continuousPromise = this.#runContinuously().finally(() => {
        this.#continuousPromise = null;
      });
    }
    return this.#continuousPromise;
  }

  async #runContinuously(): Promise<MayorSessionState> {
    const delay = this.ports.delay ?? defaultDelay;
    while (this.#state?.status === "running") {
      await this.singleTick();
      if (this.#state.status === "running" && this.#decisionMode === "local") {
        const progress = this.#localTickProgress;
        const zeroProgress = !this.#tickMadeProgress && !progress.gameTimeAdvanced && !progress.worldRevisionChanged;
        this.#localConsecutiveZeroProgressIterations = zeroProgress
          ? this.#localConsecutiveZeroProgressIterations + 1
          : 0;
        this.#state.localMayorProgress = {
          ...progress,
          consecutiveZeroProgressIterations: this.#localConsecutiveZeroProgressIterations,
        };
        const delayMs = zeroProgress
          ? Math.max(this.#tickDelayMs, LOCAL_MAYOR_ZERO_PROGRESS_DELAY_MS)
          : this.#tickDelayMs;
        if (delayMs > 0) {
          try {
            await delay(delayMs, this.#abortController.signal);
          } catch {
            if (this.#state.status === "running") throw new Error("Mayor loop delay failed");
          }
        }
      } else if (this.#state.status === "running" && this.#tickDelayMs > 0) {
        try {
          await delay(this.#tickDelayMs, this.#abortController.signal);
        } catch {
          if (this.#state.status === "running") throw new Error("Mayor loop delay failed");
        }
      }
    }
    return this.#snapshotState();
  }

  async #runTick(): Promise<MayorSessionState> {
    const state = this.#requireRunning();
    this.#tickMadeProgress = false;
    this.#localTickProgress = { kind: "none", gameTimeAdvanced: false, worldRevisionChanged: false };
    const tick = state.tickCount + 1;
    this.#traceStage(tick, "tickStarted", "start");
    const startedAt = this.#now();
    let promptChars = 0;
    let promptBytes = 0;
    let snapshotBytes = 0;
    let memoryBytes = bytes(state.compactMayorMemory);
    let decision: Awaited<ReturnType<MayorRuntimePorts["decide"]>> | undefined;
    const metrics = {
      decisionLatencyMs: 0,
      planningValidationLatencyMs: 0,
      executionLatencyMs: 0,
      simulationWaitDurationMs: 0,
      requestedActionCount: 0,
      executedActionCount: 0,
      selectedCandidateCount: 0,
      roadActionCount: 0,
      buildingPlacementCount: 0,
      modelPlanFormat: "actions" as "actions" | "constructionPhase",
      normalizedToConstructionPhase: false,
    };

    try {
      // The V2 Brain picks every action from durable state and authoritative
      // world facts; it spends nothing on a model provider. Guarding a Brain
      // session on a provider balance would end the product for a cost that
      // cannot occur — and did, on a 401 from a credential the Brain never uses.
      if (this.#decisionMode !== "local") await this.#refreshAndCheckCostGuard();
      this.#requireRunning();

      let snapshot: unknown;
      try {
        this.#traceStage(tick, "snapshot", "start", "getSnapshot");
        snapshot = await boundedRuntimeAwait(
          this.ports.getSnapshot(this.#abortController.signal,
            this.ports.districtBuilder && profileAllowsExpansion(this.#objectiveProfile, this.#recovered) ? { strategicOnly: true } : undefined),
          this.#abortController.signal,
          this.#stageTimeoutMs,
          "snapshot",
          "getSnapshot",
        );
        this.#traceStage(tick, "snapshot", "end", "getSnapshot");
        snapshotBytes = bytes(snapshot);
        if (snapshotBytes > MAYOR_SNAPSHOT_MAX_BYTES)
          throw new Error(`snapshot exceeds ${MAYOR_SNAPSHOT_MAX_BYTES} bytes`);
      } catch (error) {
        if (this.#decisionMode === "local") {
          state.localMayorStatus = "blocked";
          const timedOut = error instanceof MayorRuntimeStageTimeoutError;
          const aborted = this.#abortController.signal.aborted;
          state.lastStatus = timedOut
            ? `runtime_stage_timeout:${error.stage}:${error.operation}`
            : aborted
              ? "runtime_stage_aborted"
              : `Local Mayor blocked: Bridge unavailable (${message(error)})`;
          state.localMayorActivity = {
            ...(state.localMayorActivity ?? {
              status: "blocked",
              goal: null,
              activityKind: "blocked",
              reasonCode: "runtime_stage_failure",
              displayKey: "local_mayor.blocked",
              lastMeaningfulAction: this.#localLastMeaningfulAction,
              waitingReason: null,
              nextObservation: "next_snapshot",
            }),
            status: "blocked",
            activityKind: "blocked",
            displayKey: "local_mayor.blocked",
            reasonCode: timedOut
              ? "runtime_stage_timeout"
              : aborted
                ? "runtime_stage_aborted"
                : "runtime_stage_failure",
            waitingReason: message(error),
            nextObservation: "next_snapshot",
          };
          this.#traceStage(
            tick,
            timedOut ? "tickTimedOut" : aborted ? "tickAborted" : "tickFailed",
            "failure",
            timedOut ? error.operation : "getSnapshot",
            message(error),
          );
          this.#finishTick(
            tick,
            this.#telemetry({ tick, startedAt, promptChars: 0, promptBytes: 0, snapshotBytes, memoryBytes }),
          );
          this.#emit("tick");
          return this.#snapshotState();
        }
        await this.#fail("bridge", `Snapshot failed: ${message(error)}`, MAX_BRIDGE_FAILURES);
        return this.#snapshotState();
      }
      const previousSnapshot = state.lastSnapshot;
      state.operationalSignals = updateMayorOperationalSignals({
        current: state.operationalSignals,
        snapshot,
        previousSnapshot,
        previousBatch: state.lastBatchResult,
        previousStatus: state.lastStatus,
      });
      state.lastSnapshot = snapshot;
      // Read-only labour view for the run ledger. Nothing in the growth policy
      // consumes it, and a failed read leaves the facts null rather than
      // failing the tick it was only meant to describe.
      this.#runLedgerLabor = this.ports.readLabor
        ? await this.ports.readLabor(this.#abortController.signal).catch(() => null)
        : null;
      if (state.lifecycleMode === "GREENFIELD_BOOTSTRAP" && hasGreenfieldUtilityProof(snapshot)) {
        state.lifecycleMode = "LIVE";
        state.lastStatus = "Greenfield bootstrap certificate complete; LIVE mode entered.";
      }
      this.#requireRunning();

      if (this.#decisionMode === "local") {
        // The former Local Mayor action loop is retained as a provider source,
        // but production dispatch is owned by the V2 Brain/Gate1 boundary.
        let result: { status?: string; stage?: string; reason?: string };
        try {
          result = await this.runAutonomousConstructionCycle() as typeof result;
          this.#brainLastFailureReason = null;
          this.#brainRepeatedFailureCount = 0;
        } catch (error) {
          // A bounded planning failure is the Brain's ordinary working life: a
          // Goal can run out of legal candidates, a corridor can exhaust its
          // step budget, an unchanged world can refuse every site. Report it and
          // let the next cycle re-observe. A failure that is IDENTICAL every
          // cycle is not going to clear itself, so the session stops and says so
          // rather than retrying it forever behind a "running" indicator.
          const reason = message(error);
          this.#brainRepeatedFailureCount = reason === this.#brainLastFailureReason
            ? this.#brainRepeatedFailureCount + 1
            : 1;
          this.#brainLastFailureReason = reason;
          state.localMayorStatus = "blocked";
          state.lastStatus = `V2 Brain failure (${this.#brainRepeatedFailureCount}/${MAX_BRAIN_REPEATED_FAILURES}): ${reason}`;
          state.tickCount = tick;
          this.#finishTick(tick, this.#telemetry({ tick, startedAt, promptChars: 0, promptBytes: 0, snapshotBytes, memoryBytes, metrics }));
          this.#emit("tick");
          if (this.#brainRepeatedFailureCount >= MAX_BRAIN_REPEATED_FAILURES) {
            await this.#halt(`V2 Brain stopped after ${MAX_BRAIN_REPEATED_FAILURES} identical failures: ${reason}`);
          }
          return this.#snapshotState();
        }
        state.lastStatus = result.status === "MILESTONE_REACHED"
          ? `V2 Brain reached ${result.stage ?? "its current milestone"}`
          : `V2 Brain ${result.status ?? "stopped"}: ${result.reason ?? "no further progress"}`;
        state.localMayorStatus = result.status === "MILESTONE_REACHED" ? "waiting" : "blocked";
        state.tickCount = tick;
        this.#finishTick(tick, this.#telemetry({ tick, startedAt, promptChars: 0, promptBytes: 0, snapshotBytes, memoryBytes, metrics }));
        this.#emit("tick");
        return this.#snapshotState();
      }

      const userPrompt = buildMayorPrompt({
        goal: state.goal,
        tick,
        memory: state.compactMayorMemory,
        operationalSignals: state.operationalSignals,
        snapshot,
        lastBatchResult: state.lastBatchResult,
        command: state.pendingUserCommand,
        speed: this.#speed,
        urbanDesign: readUrbanDesignSnapshot(snapshot),
      });
      promptChars = MAYOR_SKILL.length + userPrompt.length;
      promptBytes = Buffer.byteLength(MAYOR_SKILL, "utf8") + Buffer.byteLength(userPrompt, "utf8");

      try {
        const decisionStartedAt = Date.now();
        decision = await this.ports.decide({ systemPrompt: MAYOR_SKILL, userPrompt, model: this.#model });
        metrics.decisionLatencyMs = Date.now() - decisionStartedAt;
      } catch (error) {
        await this.#fail("model", `DeepSeek request failed: ${message(error)}`, MAX_MODEL_FAILURES);
        this.#recordTelemetry(
          this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision, error }),
        );
        return this.#snapshotState();
      }

      if (state.status !== "running") {
        this.#recordTelemetry(
          this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision }),
        );
        return this.#snapshotState();
      }

      if (!decision.estimatedCost || decision.estimatedCost.currency !== "CNY") {
        await this.#halt("DeepSeek pricing unavailable; session spend cannot be enforced safely");
        this.#recordTelemetry(
          this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision }),
        );
        return this.#snapshotState();
      }
      this.#cost = addEstimatedRequestCost(this.#requireCost(), decision.estimatedCost);
      state.estimatedSessionSpend = this.#cost.estimatedSessionCost;

      let plan: ReturnType<typeof parseMayorPlan>;
      try {
        const planningStartedAt = Date.now();
        plan = parseMayorPlan(decision.content);
        if (this.#speed !== "fast" && plan.constructionPhase)
          throw new Error("constructionPhase is available only in Fast speed");
        const normalized = normalizeMayorPlanForSpeed(plan, this.#speed);
        plan = normalized.plan;
        metrics.modelPlanFormat = normalized.modelPlanFormat;
        metrics.normalizedToConstructionPhase = normalized.normalizedToConstructionPhase;
        plan = validateMayorPlanAgainstSnapshot(plan, snapshot, {
          maxCandidateCount: this.#speed === "fast" ? MAYOR_FAST_MAX_CANDIDATES : 20,
        });
        if (plan.urbanDesignIntent && plan.urbanDesignIntent.status !== "wait") {
          await this.ports.realizeUrbanDesignIntent?.(plan.urbanDesignIntent);
        }
        metrics.planningValidationLatencyMs = Date.now() - planningStartedAt;
        metrics.selectedCandidateCount = plan.actions.filter((action) => action.type === "choose_candidate").length;
      } catch (error) {
        await this.#fail("validation", `MayorPlan validation failed: ${message(error)}`, MAX_VALIDATION_FAILURES);
        this.#recordTelemetry(
          this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision, error }),
        );
        return this.#snapshotState();
      }

      state.pendingUserCommand = null;
      state.lastStatus = plan.status;
      state.compactMayorMemory = mergeMayorMemory(state.compactMayorMemory, plan.memoryUpdate);
      memoryBytes = bytes(state.compactMayorMemory);
      if (memoryBytes > MAYOR_MEMORY_MAX_BYTES) throw new Error("Mayor memory boundary was exceeded");

      let batch: MayorBatchResult = { ok: true, requested: 0, executed: 0, results: [] };
      metrics.requestedActionCount = plan.actions.length;
      metrics.roadActionCount = plan.actions.filter((action) => action.type === "build_road").length;
      metrics.buildingPlacementCount = plan.actions.filter((action) => action.type === "place_building").length;
      if (plan.actions.length > 0) {
        try {
          const executionStartedAt = Date.now();
          batch = await this.ports.executeActions(plan.actions);
          metrics.executionLatencyMs = Date.now() - executionStartedAt;
          metrics.executedActionCount = batch.executed;
          if (bytes(batch) > MAYOR_BATCH_RESULT_MAX_BYTES) throw new Error("batch result exceeded compact boundary");
        } catch (error) {
          batch = { ok: false, requested: plan.actions.length, executed: 0, failedAt: 0, results: [] };
          state.lastBatchResult = batch;
          await this.#fail("bridge", `Batch execution failed: ${message(error)}`, MAX_BRIDGE_FAILURES);
          this.#finishTick(
            tick,
            this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision, error }),
          );
          this.#emit("tick");
          return this.#snapshotState();
        }
      }
      state.lastBatchResult = batch;
      if (batch.ok && batch.executed > 0) this.#tickMadeProgress = true;

      if (!batch.ok) {
        const failure = batch.results.find((result) => !result.ok)?.error ?? `action ${batch.failedAt ?? 0} failed`;
        await this.#fail("batch", `Batch failed: ${failure}`, MAX_BATCH_FAILURES);
      } else {
        this.#resetFailures();
        if (plan.simulation.run) {
          const hours = plan.simulation.hours;
          if (hours === undefined) throw new Error("Validated simulation plan is missing hours");
          if (this.ports.checkBlockingModal) {
            const modal = await this.ports.checkBlockingModal(this.#abortController.signal);
            if (!modal.allowedToContinue) throw new Error(`blocking_modal_guard:${modal.modalClass}`);
          }
          const simulationStartedAt = Date.now();
          const simulationAbort = linkedAbortController(this.#abortController.signal);
          try {
            await boundedRuntimeAwait(
              this.ports.runSimulation({ hours, speed: plan.simulation.speed ?? 4 }, simulationAbort.controller.signal),
              this.#abortController.signal,
              simulationStageBudgetMs(hours, plan.simulation.speed ?? 4, this.#stageTimeoutMs),
              "simulation",
              "runSimulation",
              () => simulationAbort.controller.abort(new Error("runtime simulation stage timed out")),
            );
          } finally {
            simulationAbort.unlink();
          }
          metrics.simulationWaitDurationMs = Date.now() - simulationStartedAt;
        }
      }

      this.#consecutiveNoProgressDecisions = this.#tickMadeProgress ? 0 : this.#consecutiveNoProgressDecisions + 1;
      if (this.#noProgressGuardEnabled && this.#consecutiveNoProgressDecisions >= 3 && state.status === "running") {
        await this.#halt("NO_PROGRESS_LOOP: three consecutive Mayor decisions without meaningful progress");
      }

      this.#finishTick(
        tick,
        this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision, metrics }),
      );
      this.#traceStage(tick, "tickCompleted", "end");

      if (plan.stop.requested && state.status === "running") {
        await this.#halt(`Mayor requested stop: ${plan.stop.reason}`);
      } else if (shouldStopForBudget(this.#requireCost()) && state.status === "running") {
        await this.#halt("Maximum session spend reached");
      }
    } catch (error) {
      if (this.#decisionMode === "local") {
        const timedOut = error instanceof MayorRuntimeStageTimeoutError;
        const aborted = this.#abortController.signal.aborted;
        state.localMayorStatus = "blocked";
        state.localMayorActivity = {
          ...(state.localMayorActivity ?? {
            status: "blocked",
            goal: null,
            activityKind: "blocked",
            reasonCode: "runtime_stage_failure",
            displayKey: "local_mayor.blocked",
            lastMeaningfulAction: this.#localLastMeaningfulAction,
            waitingReason: null,
            nextObservation: "next_snapshot",
          }),
          status: "blocked",
          activityKind: "blocked",
          displayKey: "local_mayor.blocked",
          reasonCode: timedOut ? "runtime_stage_timeout" : aborted ? "runtime_stage_aborted" : "runtime_stage_failure",
          waitingReason: message(error),
          nextObservation: "next_snapshot",
        };
        state.lastStatus = timedOut
          ? `runtime_stage_timeout:${error.stage}:${error.operation}`
          : aborted
            ? "runtime_stage_aborted"
            : `runtime_stage_failure:${message(error)}`;
        this.#traceStage(
          tick,
          timedOut ? "tickTimedOut" : aborted ? "tickAborted" : "tickFailed",
          "failure",
          timedOut ? error.operation : undefined,
          message(error),
        );
        this.#finishTick(
          tick,
          this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, metrics, error }),
        );
      }
      if (state.status === "running") {
        await this.#fail("runtime", `Mayor tick failed: ${message(error)}`, MAX_MODEL_FAILURES);
        this.#recordTelemetry(
          this.#telemetry({ tick, startedAt, promptChars, promptBytes, snapshotBytes, memoryBytes, decision, error }),
        );
      }
    }

    if (state.tickCount === tick) this.#traceStage(tick, "tickCompleted", "end");
    this.#emit("tick");
    return this.#snapshotState();
  }

  async #runLocalMayorTick(
    snapshot: unknown,
    input: {
      tick: number;
      startedAt: Date;
      snapshotBytes: number;
      memoryBytes: number;
      metrics: Partial<MayorTickTelemetry>;
    },
  ) {
    const state = this.#requireState();
    state.localMayorStatus = "deciding";
    const previousLocalState = this.#localState;
    this.#localHistory = advanceLocalMayorObservation(this.#localHistory);
    let workingSnapshot = snapshot;
    let refreshedSupply = false;
    const initialState = compileLocalMayorState(workingSnapshot, this.#localHistory);
    if (!this.#localGrowthIntent && initialState.growthIntent) this.#localGrowthIntent = initialState.growthIntent;
    this.#traceStage(input.tick, "issueScan", "start");
    this.#traceStage(input.tick, "issueScan", "end", "compileLocalMayorState");
    const actionabilityBlock = this.#localActionabilityBlock;
    const hasInitialCandidates =
      initialState.candidates.zoning.length > 0 || initialState.candidates.roadExpansion.length > 0;
    const sameBlockedContext =
      !hasInitialCandidates &&
      actionabilityBlock &&
      actionabilityBlock.key === localMayorActionabilityKey(initialState) &&
      (actionabilityBlock.snapshotRevision === null ||
        initialState.snapshotRevision === null ||
        actionabilityBlock.snapshotRevision === initialState.snapshotRevision);
    const blockedDuringBackoff = Boolean(sameBlockedContext && actionabilityBlock.remainingObservations > 0);
    if (hasInitialCandidates) {
      this.#localActionabilityBlock = null;
      this.#lastLocalSupplyRefreshKey = null;
    }
    if (sameBlockedContext && actionabilityBlock.remainingObservations > 0) {
      workingSnapshot = annotateLocalMayorActionability(workingSnapshot, {
        status: "blocked",
        reasonCode: actionabilityBlock.reasonCode,
        reason: actionabilityBlock.reason,
        refreshAttempted: true,
        backoffRemaining: actionabilityBlock.remainingObservations,
      });
      actionabilityBlock.remainingObservations -= 1;
    } else if (sameBlockedContext) {
      this.#localActionabilityBlock = null;
      this.#lastLocalSupplyRefreshKey = null;
    }
    if (
      this.ports.refreshActionableCandidates &&
      !blockedDuringBackoff &&
      shouldRefreshLocalMayorSupply(initialState, this.#lastLocalSupplyRefreshKey)
    ) {
      this.#lastLocalSupplyRefreshKey = localMayorActionabilityKey(initialState);
      refreshedSupply = true;
      try {
        this.#traceStage(input.tick, "candidateRefresh", "start", "refreshActionableCandidates");
        workingSnapshot =
          (await boundedRuntimeAwait(
            this.ports.refreshActionableCandidates(this.#abortController.signal),
            this.#abortController.signal,
            this.#stageTimeoutMs,
            "candidateRefresh",
            "refreshActionableCandidates",
          )) ?? workingSnapshot;
        this.#traceStage(input.tick, "candidateRefresh", "end", "refreshActionableCandidates");
      } catch (error) {
        if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
        workingSnapshot = {
          ...(typeof workingSnapshot === "object" && workingSnapshot !== null ? workingSnapshot : {}),
          localMayorActionability: {
            status: "blocked",
            reasonCode: "candidate_supply_refresh_failed",
            reason: "existing planner refresh failed",
            refreshAttempted: true,
          },
        };
      }
      const refreshedState = compileLocalMayorState(workingSnapshot, this.#localHistory);
      if (refreshedState.candidates.zoning.length === 0 && refreshedState.candidates.roadExpansion.length === 0) {
        if (
          refreshedState.developmentCapacity.developmentDigesting ||
          refreshedState.actionability.capacityStatus === "sufficient"
        ) {
          workingSnapshot = annotateLocalMayorActionability(workingSnapshot, {
            status: "available",
            reasonCode: "waiting_for_absorption_after_burst",
            reason: "recent district capacity is still being absorbed",
            refreshAttempted: true,
          });
          this.#localActionabilityBlock = null;
          this.#lastLocalSupplyRefreshKey = null;
        } else {
          const reason = refreshedState.actionability.reason;
          const reasonCode = "no_safe_actionability_after_refresh";
          this.#localActionabilityBlock = {
            key: localMayorActionabilityKey(refreshedState),
            snapshotRevision: refreshedState.snapshotRevision,
            reasonCode,
            reason,
            remainingObservations: LOCAL_MAYOR_ACTIONABILITY_BACKOFF,
          };
          workingSnapshot = {
            ...annotateLocalMayorActionability(workingSnapshot, {
              status: "blocked",
              reasonCode,
              reason,
              refreshAttempted: true,
              backoffRemaining: LOCAL_MAYOR_ACTIONABILITY_BACKOFF,
            }),
          };
        }
      } else {
        this.#localActionabilityBlock = null;
        this.#lastLocalSupplyRefreshKey = null;
      }
    }
    const postRefreshState = compileLocalMayorState(workingSnapshot, this.#localHistory);
    if (
      this.ports.ensureGrowthOpportunity &&
      !blockedDuringBackoff &&
      classifyLocalDistrictLifecycle(postRefreshState) !== "selecting_next_district" &&
      shouldEnsureGrowthOpportunity(postRefreshState)
    ) {
      const target = postRefreshState.developmentCapacity.targetZoningCells;
      const preferredPolicy =
        target > 0 && postRefreshState.developmentCapacity.availableFrontageCells >= target ? "mixed" : "expand_first";
      const growthDomain = this.#localGrowthDomain ?? localMayorGrowthDomain(postRefreshState);
      try {
        this.#traceStage(input.tick, "candidateRefresh", "start", "ensureGrowthOpportunity");
        const growth = await boundedRuntimeAwait(
          this.ports.ensureGrowthOpportunity({
            developmentCapacity: postRefreshState.developmentCapacity,
            demand: postRefreshState.demands,
            preferredPolicy,
            growthDomain,
            signal: this.#abortController.signal,
          }),
          this.#abortController.signal,
          // A candidate refresh is not a simulation run, so it takes the plain
          // stage timeout. Passing the simulation budget here read two names
          // that do not exist in this scope — a ReferenceError on the first
          // local tick that asked for a growth opportunity.
          this.#stageTimeoutMs,
          "candidateRefresh",
          "ensureGrowthOpportunity",
        );
        this.#traceStage(input.tick, "candidateRefresh", "end", "ensureGrowthOpportunity");
        if (growth.status === "available" && growth.snapshot) {
          // A successful bounded global reseed is a district boundary. Do not let
          // the exhausted site's source/revision/candidate registry leak forward.
          this.#localGrowthIntent = undefined;
          this.#localGrowthDomain = growthDomain;
          workingSnapshot = annotateLocalGrowthIntent(growth.snapshot, growthDomain);
          refreshedSupply = true;
          this.#localActionabilityBlock = null;
          this.#lastLocalSupplyRefreshKey = null;
        } else {
          const reason = growth.reason || "no safe frontier growth opportunity";
          const takeoverOutcome = growth.outcome ?? "search_exhausted";
          const previousSiteId = this.#localGrowthIntent?.sourceRoad
            ? `${this.#localGrowthIntent.sourceRoad.index}:${this.#localGrowthIntent.sourceRoad.version}`
            : null;
          // A failed continuation retires the corridor before the next search. This
          // prevents a stranded source from being reinterpreted as the current site.
          this.#localGrowthIntent = undefined;
          this.#localActionabilityBlock = takeoverOutcome === "search_exhausted" ? {
            key: localMayorActionabilityKey(postRefreshState),
            snapshotRevision: postRefreshState.snapshotRevision,
            reasonCode:
              takeoverOutcome === "search_exhausted"
                ? "no_safe_growth_opportunity_after_frontier_search"
                : "select_next_district",
            reason,
            remainingObservations: LOCAL_MAYOR_ACTIONABILITY_BACKOFF,
          } : null;
          workingSnapshot = annotateLocalDistrictTakeover(
            annotateLocalMayorActionability(workingSnapshot, {
              status: takeoverOutcome === "search_exhausted" ? "blocked" : "available",
              reasonCode: takeoverOutcome === "search_exhausted" ? "no_safe_growth_opportunity_after_frontier_search" : "select_next_district",
              reason,
              recoveryLevel: growth.recoveryLevel ?? 4,
              refreshAttempted: true,
              backoffRemaining: takeoverOutcome === "search_exhausted" ? LOCAL_MAYOR_ACTIONABILITY_BACKOFF : 0,
            }),
            {
              previousSiteId,
              searchRevision: postRefreshState.snapshotRevision,
              checkedSources: [],
              outcome: takeoverOutcome,
            },
          );
        }
      } catch (error) {
        if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
        const reason = `frontier growth opportunity failed: ${message(error)}`;
        const previousSiteId = this.#localGrowthIntent?.sourceRoad
          ? `${this.#localGrowthIntent.sourceRoad.index}:${this.#localGrowthIntent.sourceRoad.version}`
          : null;
        this.#localGrowthIntent = undefined;
        this.#localActionabilityBlock = null;
        workingSnapshot = annotateLocalDistrictTakeover(annotateLocalMayorActionability(workingSnapshot, {
          status: "available",
          reasonCode: "select_next_district",
          reason,
          refreshAttempted: true,
          backoffRemaining: 0,
        }), {
          previousSiteId,
          searchRevision: postRefreshState.snapshotRevision,
          // The failed refresh produced no candidate set to read sources from,
          // and the value it would have come from is not in scope here. This
          // branch is a technical failure, so it reports no checked sources
          // rather than reaching for one that does not exist.
          checkedSources: [],
          outcome: "technical_failure",
        });
      }
    }
    workingSnapshot = annotateLocalGrowthIntent(workingSnapshot, this.#localGrowthDomain);
    workingSnapshot = annotateLocalMayorCorridor(workingSnapshot, this.#localGrowthIntent);
    state.lastSnapshot = workingSnapshot;
    this.#traceStage(input.tick, "decision", "start", "decideLocalMayorEpisode");
    let episode = decideLocalMayorEpisode(workingSnapshot, this.#localHistory, `local-${input.tick}`);
    this.#traceStage(input.tick, "decision", "end", "decideLocalMayorEpisode");
    let episodeGrowthDomain = episode.trace.goals.find(
      (goal) => goal.kind === "maintain_development_reserve",
    )?.domain;
    if (
      episode.chosen.action.kind === "wait" &&
      episode.chosen.action.reasonCode === "select_next_district" &&
      this.ports.ensureGrowthOpportunity
    ) {
      const takeoverDomain = episodeGrowthDomain ?? this.#localGrowthDomain ?? localMayorGrowthDomain(episode.state);
      const target = episode.state.developmentCapacity.targetZoningCells;
      const preferredPolicy =
        target > 0 && episode.state.developmentCapacity.availableFrontageCells >= target ? "mixed" : "expand_first";
      const previousSiteId = this.#localGrowthIntent?.sourceRoad
        ? `${this.#localGrowthIntent.sourceRoad.index}:${this.#localGrowthIntent.sourceRoad.version}`
        : null;
      this.#traceStage(input.tick, "candidateRefresh", "start", "selectNextDistrictTakeover");
      const takeover = await boundedRuntimeAwait(
        this.ports.ensureGrowthOpportunity({
          developmentCapacity: episode.state.developmentCapacity,
          demand: episode.state.demands,
          preferredPolicy,
          growthDomain: takeoverDomain,
          signal: this.#abortController.signal,
        }),
        this.#abortController.signal,
        this.#stageTimeoutMs,
        "candidateRefresh",
        "selectNextDistrictTakeover",
      );
      this.#traceStage(input.tick, "candidateRefresh", "end", "selectNextDistrictTakeover");
      const takeoverOutcome = takeover.outcome ?? (takeover.status === "available" ? "opportunity_found" : "search_incomplete");
      this.#localGrowthIntent = undefined;
      this.#localGrowthDomain = takeoverDomain;
      workingSnapshot = annotateLocalDistrictTakeover(
        takeover.snapshot ?? workingSnapshot,
        {
          previousSiteId,
          searchRevision: episode.state.snapshotRevision,
          checkedSources: "checkedSources" in takeover ? takeover.checkedSources : [],
          outcome: takeoverOutcome,
        },
      );
      state.lastSnapshot = workingSnapshot;
      if (takeover.status === "available" && takeover.snapshot) {
        episode = decideLocalMayorEpisode(workingSnapshot, this.#localHistory, `local-${input.tick}-takeover`);
        episodeGrowthDomain = episode.trace.goals.find(
          (goal) => goal.kind === "maintain_development_reserve",
        )?.domain;
      }
    }
    if (episodeGrowthDomain) this.#localGrowthDomain = episodeGrowthDomain;
    const currentLocalState = episode.state;
    this.#localHistory = {
      ...this.#localHistory,
      issueMemory: currentLocalState.issues.current,
      ...(currentLocalState.serviceRecovery
        ? { serviceRecovery: currentLocalState.serviceRecovery }
        : { serviceRecovery: undefined }),
    };
    this.#localState = currentLocalState;
    state.localMayorTrace = episode.trace;
    const gameTimeAdvanced = Boolean(
      previousLocalState?.game.gameDateTime &&
        currentLocalState.game.gameDateTime &&
        previousLocalState.game.gameDateTime !== currentLocalState.game.gameDateTime,
    );
    const worldRevisionChanged = Boolean(
      previousLocalState?.worldFingerprint &&
        currentLocalState.worldFingerprint &&
        previousLocalState.worldFingerprint !== currentLocalState.worldFingerprint,
    );
    this.#localTickProgress = {
      ...this.#localTickProgress,
      gameTimeAdvanced,
      worldRevisionChanged,
      kind: gameTimeAdvanced || worldRevisionChanged ? "observation" : this.#localTickProgress.kind,
    };
    if (previousLocalState && !this.#expectedLocalMutation && !refreshedSupply) {
      const world = invalidateLocalMayorEpisode(previousLocalState, currentLocalState);
      if (world.status === "yielding") {
        this.#tickMadeProgress = true;
        this.#localTickProgress.kind = "yield";
        this.#localGrowthIntent = undefined;
        state.localMayorStatus = "yielding";
        this.#localHistory = recordLocalMayorOutcome(this.#localHistory, {
          action: { kind: "replan", quietObservations: 1, reasonCode: "external_world_change" },
          outcome: "external_world_change",
          reason: world.reason,
        });
        this.#finishTick(
          input.tick,
          this.#telemetry({
            tick: input.tick,
            startedAt: input.startedAt,
            promptChars: 0,
            promptBytes: 0,
            snapshotBytes: input.snapshotBytes,
            memoryBytes: input.memoryBytes,
            metrics: { ...input.metrics, modelPlanFormat: "actions" },
          }),
        );
        return;
      }
    }
    this.#expectedLocalMutation = false;
    const selectedAction = episode.chosen.action;
    const mandatoryAbsorb =
      this.#growthCadenceState.absorbRequired &&
      (selectedAction.kind === "wait" || selectedAction.kind === "simulate" || selectedAction.kind === "choose_candidate");
    const action =
      mandatoryAbsorb && selectedAction.kind === "choose_candidate"
        ? ({ kind: "simulate", hours: 0.25, speed: 4, reasonCode: "mandatory_bounded_absorb" } as const)
        : selectedAction;
    const projectedActivity = projectLocalMayorActivity({
      episode,
      lastMeaningfulAction: this.#localLastMeaningfulAction,
    });
    state.localMayorActivity = mandatoryAbsorb
      ? { ...projectedActivity, activityKind: "waiting_for_absorption", displayKey: "local_mayor.waiting_for_absorption" }
      :
      action.kind === "choose_candidate" && projectedActivity.activityKind === "building"
        ? {
            ...projectedActivity,
            activityKind: "planning",
            displayKey: "local_mayor.planning",
            reasonCode: "candidate_dispatch_pending",
          }
        : projectedActivity;
    if (currentLocalState.status !== "available") {
      state.localMayorStatus = "blocked";
      this.#localHistory = recordLocalMayorOutcome(this.#localHistory, {
        action: episode.chosen.action,
        outcome: "failure",
        reason: "no_city_loaded_or_snapshot_unavailable",
      });
      this.#finishTick(
        input.tick,
        this.#telemetry({
          tick: input.tick,
          startedAt: input.startedAt,
          promptChars: 0,
          promptBytes: 0,
          snapshotBytes: input.snapshotBytes,
          memoryBytes: input.memoryBytes,
          metrics: { ...input.metrics, modelPlanFormat: "actions" },
        }),
      );
      return;
    }
    let outcome: "success" | "failure" | "stale" | "external_world_change" = "success";
    let reason = action.reasonCode;
    const worldFingerprintBefore = currentLocalState.worldFingerprint;
    let impact: ReturnType<typeof classifyLocalMayorOutcomeImpact> | undefined;
    let mutation:
      | {
          roads: number;
          residentialZoning: number;
          commercialZoning: number;
          industrialZoning: number;
          officeZoning: number;
          newBuildings: number | null;
          populationBefore: number | null;
          populationAfter: number | null;
        }
      | undefined;
    if (action.kind === "recover_utility") {
      state.localMayorStatus = "recovering";
      this.#tickMadeProgress = true;
      this.#localTickProgress.kind = "execution";
      const intent = currentLocalState.serviceRecovery;
      if (!intent || !this.ports.ensureUtilityCapacity) {
        outcome = "failure";
        reason = "utility_recovery_unavailable";
      } else {
        this.#localHistory = {
          ...this.#localHistory,
          serviceRecovery: recordServiceRecoveryAttempt(
            intent,
            currentLocalState.snapshotRevision ?? `tick-${input.tick}`,
          ),
        };
        const before = Date.now();
        try {
          const recovery = await boundedLocalExecution(
            this.ports.ensureUtilityCapacity({
              kind: action.utility,
              expectedRevision: currentLocalState.snapshotRevision,
              treasury: currentLocalState.treasury,
              runwayMonths: currentLocalState.financeRunwayMonths,
              signal: this.#abortController.signal,
            }),
            this.#abortController.signal,
          );
          input.metrics.executionLatencyMs = Date.now() - before;
          input.metrics.requestedActionCount = recovery.executedActions;
          input.metrics.executedActionCount = recovery.executedActions;
          if (recovery.executedActions > 0) this.#expectedLocalMutation = true;
          this.#traceStage(input.tick, "readback", "start", "utilityRecoveryReadback");
          const readback = await boundedRuntimeAwait(
            this.ports.getSnapshot(this.#abortController.signal),
            this.#abortController.signal,
            this.#stageTimeoutMs,
            "readback",
            "utilityRecoveryReadback",
          );
          this.#traceStage(input.tick, "readback", "end", "utilityRecoveryReadback");
          const afterState = compileLocalMayorState(readback, this.#localHistory);
          const issueAfter = afterState.issues.current.find((issue) => issue.key === action.issueKey) ?? null;
          this.#localHistory = {
            ...this.#localHistory,
            issueMemory: afterState.issues.current,
            serviceRecovery: evaluateServiceRecoveryReadback(
              this.#localHistory.serviceRecovery ?? intent,
              issueAfter,
              recovery.stage === "improving" ? "improving" : "no_material_issue_improvement",
            ),
          };
          this.#localState = compileLocalMayorState(readback, this.#localHistory);
          outcome = recovery.ok ? "success" : "failure";
          reason = recovery.reason;
          if (recovery.stage === "resolved") this.#localLastMeaningfulAction = "local_mayor.recent.utility_resolved";
          else if (recovery.stage === "improving")
            this.#localLastMeaningfulAction = "local_mayor.recent.utility_improving";
        } catch (error) {
          if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
          input.metrics.executionLatencyMs = Date.now() - before;
          outcome = "failure";
          reason = `utility recovery failed: ${message(error)}`;
        }
      }
    } else if (action.kind === "choose_candidate") {
      state.localMayorStatus = "acting";
      this.#tickMadeProgress = true;
      this.#localTickProgress.kind = "execution";
      const planActions = toMayorPlanActions(action);
      if (planActions.length === 0) {
        outcome = "failure";
        reason = "unsupported_local_candidate_action";
      } else {
        state.localMayorActivity = projectedActivity;
        const before = Date.now();
        let batch: MayorBatchResult;
        try {
          this.#traceStage(input.tick, "execution", "start", "executeActions");
          batch = await boundedRuntimeAwait(
            this.ports.executeActions(planActions, this.#abortController.signal),
            this.#abortController.signal,
            Math.min(LOCAL_MAYOR_EXECUTION_TIMEOUT_MS, this.#stageTimeoutMs),
            "execution",
            "executeActions",
          );
          this.#traceStage(input.tick, "execution", "end", "executeActions");
        } catch (error) {
          if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
          outcome = "failure";
          reason = `local execution failed: ${message(error)}`;
          batch = {
            ok: false,
            requested: 1,
            executed: 0,
            failedAt: 0,
            results: [
              {
                index: 0,
                type: "zone",
                ok: false,
                summary: "local_execution_failed",
                error: message(error),
              },
            ],
          };
        }
        input.metrics.executionLatencyMs = Date.now() - before;
        input.metrics.requestedActionCount = planActions.length;
        input.metrics.selectedCandidateCount = planActions.length;
        input.metrics.executedActionCount = batch.executed;
        state.lastBatchResult = batch;
        if (outcome === "success" && batch.ok && batch.executed >= 1) {
          this.#growthCadenceState.successfulBurstsSinceAbsorb += 1;
          this.#growthCadenceState.absorbRequired = this.#growthCadenceState.successfulBurstsSinceAbsorb >= 2;
        }
        if (outcome === "success" && batch.ok && batch.executed >= 1) {
          this.#expectedLocalMutation = true;
          const selectedCandidates = [
            ...currentLocalState.candidates.zoning,
            ...currentLocalState.candidates.roadExpansion,
          ].filter((candidate) => action.candidateIds?.includes(candidate.id) ?? candidate.id === action.candidateId);
          for (const selectedCandidate of selectedCandidates) {
            const domain =
              this.#localGrowthIntent?.domain ??
              selectedCandidate.growthDomain ??
              (selectedCandidate.areaType?.toLowerCase() as LocalMayorGrowthDomain | undefined) ??
              this.#localGrowthDomain ??
              "residential";
            this.#localGrowthIntent = this.#localGrowthIntent
              ? nextLocalGrowthIntent(this.#localGrowthIntent, selectedCandidate, currentLocalState)
              : createLocalGrowthIntent(currentLocalState, selectedCandidate, domain);
          }
          try {
            this.#traceStage(input.tick, "readback", "start", "candidateReadback");
            const candidateReadback = await boundedRuntimeAwait(
              this.ports.getSnapshot(this.#abortController.signal),
              this.#abortController.signal,
              this.#stageTimeoutMs,
              "readback",
              "candidateReadback",
            );
            this.#traceStage(input.tick, "readback", "end", "candidateReadback");
            const readback = annotateLocalMayorCorridor(
              annotateLocalGrowthIntent(candidateReadback, this.#localGrowthDomain),
              this.#localGrowthIntent,
            );
            const afterState = compileLocalMayorState(readback, this.#localHistory);
            if (this.#localGrowthIntent?.phase === "corridor") {
              this.#localGrowthIntent = rebaseLocalGrowthIntentFromSnapshot(this.#localGrowthIntent, afterState);
            }
            const rebasedReadback = annotateLocalMayorCorridor(
              annotateLocalGrowthIntent(candidateReadback, this.#localGrowthDomain),
              this.#localGrowthIntent,
            );
            const rebasedState = compileLocalMayorState(rebasedReadback, this.#localHistory);
            impact = classifyLocalMayorOutcomeImpact(action, currentLocalState, afterState);
            const successfulResults = batch.results.filter((result) => result.ok);
            const selectedById = new Map(selectedCandidates.map((candidate) => [candidate.id, candidate]));
            const resolvedCandidateIds = planActions.map((planAction) =>
              planAction.type === "choose_candidate" ? planAction.candidateId : null,
            );
            mutation = {
              roads: successfulResults.filter((result) => result.type === "build_road").length,
              residentialZoning: successfulResults.filter(
                (result) =>
                  result.type === "zone" &&
                  selectedById.get(resolvedCandidateIds[result.index] ?? "")?.areaType === "Residential",
              ).length,
              commercialZoning: successfulResults.filter(
                (result) =>
                  result.type === "zone" &&
                  selectedById.get(resolvedCandidateIds[result.index] ?? "")?.areaType === "Commercial",
              ).length,
              industrialZoning: successfulResults.filter(
                (result) =>
                  result.type === "zone" &&
                  selectedById.get(resolvedCandidateIds[result.index] ?? "")?.areaType === "Industrial",
              ).length,
              officeZoning: successfulResults.filter(
                (result) =>
                  result.type === "zone" &&
                  selectedById.get(resolvedCandidateIds[result.index] ?? "")?.areaType === "Office",
              ).length,
              newBuildings: null,
              populationBefore: currentLocalState.population,
              populationAfter: afterState.population,
            };
            this.#localState = rebasedState;
            if (
              this.#localGrowthDomain &&
              afterState.developmentCapacity.typedReserveDeficit?.[this.#localGrowthDomain] !== true
            ) {
              this.#localGrowthDomain = undefined;
            }
            if (
              this.#localGrowthIntent &&
              this.#localGrowthIntent.domain &&
              afterState.developmentCapacity.reserveStatus !== "unknown" &&
              afterState.developmentCapacity.typedReserveDeficit?.[this.#localGrowthIntent.domain] === false
            ) {
              this.#localGrowthIntent = {
                ...this.#localGrowthIntent,
                phase: "digest",
                remainingZoningPatches: 0,
                digestStartedGameTime: afterState.game.gameDateTime,
              };
            }
            if (impact.kind === "road_added") this.#localLastMeaningfulAction = "local_mayor.recent.road_added";
            if (impact.kind === "zoning_added") this.#localLastMeaningfulAction = "local_mayor.recent.zoning_added";
          } catch {
            impact = classifyLocalMayorOutcomeImpact(action, currentLocalState, null);
          }
        }
        if (outcome === "success" && (!batch.ok || batch.executed < 1)) {
          const failure = batch.results.find((result) => !result.ok)?.error ?? "local candidate execution rejected";
          outcome = /stale|revision|world changed/i.test(failure) ? "stale" : "failure";
          reason = failure;
        }
      }
    } else if (action.kind === "wait" || action.kind === "simulate") {
      state.localMayorStatus = "waiting";
      if (this.ports.checkBlockingModal) {
        const modal = await this.ports.checkBlockingModal(this.#abortController.signal);
        if (!modal.allowedToContinue) throw new Error(`blocking_modal_guard:${modal.modalClass}`);
      }
      const simulation =
        action.kind === "wait"
          ? {
              // WaitObserve is an explicit bounded observation request.  Keep
              // each tick short enough for recovery/guards, but do not discard
              // the planner's requested cadence.
              hours: 0.25 * Math.max(1, Math.min(4, Math.floor(action.observeAfterTicks ?? 1))),
              speed: 4,
            }
          : { hours: action.hours, speed: action.speed };
      const before = Date.now();
      const simulationAbort = linkedAbortController(this.#abortController.signal);
      try {
        this.#traceStage(input.tick, "simulation", "start", "runSimulation");
        await boundedRuntimeAwait(
          this.ports.runSimulation(simulation, simulationAbort.controller.signal),
          this.#abortController.signal,
          this.#stageTimeoutMs,
          "simulation",
          "runSimulation",
          () => simulationAbort.controller.abort(new Error("runtime simulation stage timed out")),
        );
        this.#traceStage(input.tick, "simulation", "end", "runSimulation");
        if (mandatoryAbsorb) this.#growthCadenceState = { successfulBurstsSinceAbsorb: 0, absorbRequired: false };
        if (this.#localGrowthIntent?.phase === "digest") this.#localGrowthIntent = undefined;
        this.#expectedLocalMutation = true;
        this.#tickMadeProgress = true;
        this.#localTickProgress.kind = "simulation";
      } catch (error) {
        if (error instanceof MayorRuntimeStageTimeoutError || this.#abortController.signal.aborted) throw error;
        outcome = "failure";
        reason = `local simulation failed: ${message(error)}`;
      } finally {
        simulationAbort.unlink();
      }
      input.metrics.simulationWaitDurationMs = Date.now() - before;
    } else {
      state.localMayorStatus = episode.status === "recovering" ? "recovering" : "deciding";
    }
    state.localMayorActivity = projectLocalMayorActivity({
      episode,
      lastMeaningfulAction: this.#localLastMeaningfulAction,
      impact:
        impact ??
        (outcome === "success"
          ? undefined
          : {
              kind: "unavailable",
              worldChanged: false,
              capacityAdded: false,
              roadAdded: false,
              zoningAdded: false,
              summary: reason,
            }),
      mutation,
    });
    this.#localHistory = recordLocalMayorOutcome(this.#localHistory, { action, outcome, reason, impact });
    state.lastStatus = `Local Mayor ${action.kind}: ${reason}`.slice(0, 240);
    state.localMayorTrace = {
      ...episode.trace,
      outcome,
      worldFingerprintBefore,
      worldFingerprintAfter: this.#localState?.worldFingerprint ?? currentLocalState.worldFingerprint,
      impact,
      failureReason: outcome === "success" ? undefined : reason,
    };
    this.#finishTick(
      input.tick,
      this.#telemetry({
        tick: input.tick,
        startedAt: input.startedAt,
        promptChars: 0,
        promptBytes: 0,
        snapshotBytes: input.snapshotBytes,
        memoryBytes: input.memoryBytes,
        metrics: { ...input.metrics, modelPlanFormat: "actions" },
      }),
    );
  }

  async #refreshAndCheckCostGuard() {
    const state = this.#requireRunning();
    try {
      const balance = await this.ports.getBalance();
      this.#cost = updateSessionBalance(this.#requireCost(), balance);
      state.currentBalance = balance.totalBalance;
      this.#emit("balance");
    } catch (error) {
      this.#cost = markSessionBalanceFailure(this.#requireCost(), "error");
      state.currentBalance = null;
      await this.#halt(`Balance check failed: ${message(error)}`);
      return;
    }
    if (!canContinue(this.#requireCost())) {
      const reason = shouldStopForBudget(this.#requireCost())
        ? "Maximum session spend reached"
        : "Balance unavailable or below minimum";
      await this.#halt(reason);
    }
  }

  #finishTick(tick: number, telemetry: MayorTickTelemetry) {
    const state = this.#requireState();
    state.tickCount = tick;
    this.#recordTelemetry(telemetry);
    this.#appendRunLedger(tick, telemetry);
  }

  /**
   * Record this window in the run ledger.
   *
   * Diagnostics only. It reads what the tick already holds, names what happened
   * in the six terms the ledger defines, and — when the city has changed nothing
   * for long enough — leaves an explicit stall reason behind. It never decides
   * anything about the city and never invents a recovery.
   */
  #appendRunLedger(tick: number, telemetry: MayorTickTelemetry) {
    const state = this.#requireState();
    const workOrder = this.ports.v2ProductionSkillRuntime?.activeGoalWorkOrder?.() ?? null;
    const parked = [...this.#parkedGrowthGoalFacts.entries()][0] ?? null;
    const decision: RunLedgerDecision = {
      ...this.#runLedgerDecision,
      goalId: workOrder?.goalId ?? this.#runLedgerDecision.goalId,
      workOrderGoalId: workOrder?.goalId ?? null,
      workOrderStatus: workOrder?.status ?? null,
      workOrderStage: workOrder?.state?.tranche?.stage ?? null,
      applied: {
        zoning: telemetry.zonedCellCount ?? 0,
        road: telemetry.roadActionCount ?? 0,
        facility: telemetry.buildingPlacementCount ?? 0,
      },
      parkedFamily: parked?.[0] ?? null,
      parkedReason: parked ? `held back on ${parked[1].kind} facts` : null,
      haltReason: state.stopReason ?? null,
    };
    state.runLedger = appendRunLedgerEntry(state.runLedger ?? emptyRunLedgerState(), {
      tick,
      at: this.#now().toISOString(),
      facts: runLedgerFactsFromSnapshot(state.lastSnapshot, this.#runLedgerLabor, this.#runLedgerBuiltButVacant),
      decision,
    });
    this.#runLedgerDecision = emptyRunLedgerDecision();
    this.#runLedgerLabor = null;
    this.#runLedgerBuiltButVacant = null;
  }

  #telemetry(input: {
    tick: number;
    startedAt: Date;
    promptChars: number;
    promptBytes: number;
    snapshotBytes: number;
    memoryBytes: number;
    decision?: Awaited<ReturnType<MayorRuntimePorts["decide"]>>;
    error?: unknown;
    metrics?: Partial<MayorTickTelemetry>;
  }): MayorTickTelemetry {
    const usage = input.decision?.usage;
    const state = this.#requireState();
    return {
      tick: input.tick,
      startedAt: input.startedAt.toISOString(),
      endedAt: this.#now().toISOString(),
      outcome: state.status === "stopped" ? "stopped" : input.error ? "failed" : "success",
      ...(input.error ? { error: message(input.error) } : {}),
      apiRequestCount: input.decision ? 1 : 0,
      requestId: input.decision?.requestId,
      model: input.decision?.model,
      promptChars: input.promptChars,
      promptBytes: input.promptBytes,
      promptTokens: usage?.promptTokens ?? 0,
      snapshotBytes: input.snapshotBytes,
      mayorMemoryBytes: input.memoryBytes,
      cacheHitTokens: usage?.promptCacheHitTokens ?? 0,
      cacheMissTokens: usage?.promptCacheMissTokens ?? 0,
      outputTokens: usage?.completionTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      estimatedCnyCost: input.decision?.estimatedCost?.currency === "CNY" ? input.decision.estimatedCost.total : 0,
      wallClockDurationMs: Math.max(0, this.#now().getTime() - input.startedAt.getTime()),
      decisionLatencyMs: input.metrics?.decisionLatencyMs ?? 0,
      planningValidationLatencyMs: input.metrics?.planningValidationLatencyMs ?? 0,
      executionLatencyMs: input.metrics?.executionLatencyMs ?? 0,
      simulationWaitDurationMs: input.metrics?.simulationWaitDurationMs ?? 0,
      requestedActionCount: input.metrics?.requestedActionCount ?? 0,
      executedActionCount: input.metrics?.executedActionCount ?? 0,
      selectedCandidateCount: input.metrics?.selectedCandidateCount ?? 0,
      zonedCellCount: input.metrics?.zonedCellCount,
      roadActionCount: input.metrics?.roadActionCount ?? 0,
      approximateRoadLength: input.metrics?.approximateRoadLength,
      buildingPlacementCount: input.metrics?.buildingPlacementCount ?? 0,
      modelPlanFormat: input.metrics?.modelPlanFormat ?? "actions",
      normalizedToConstructionPhase: input.metrics?.normalizedToConstructionPhase ?? false,
    };
  }

  #recordTelemetry(telemetry: MayorTickTelemetry) {
    const state = this.#requireState();
    state.recentTickTelemetry.push(telemetry);
    state.recentTickTelemetry = state.recentTickTelemetry.slice(-MAX_RECENT_TELEMETRY);
    const total = state.telemetryTotals;
    total.apiRequestCount += telemetry.apiRequestCount;
    total.promptTokens += telemetry.promptTokens;
    total.cacheHitTokens += telemetry.cacheHitTokens;
    total.cacheMissTokens += telemetry.cacheMissTokens;
    total.outputTokens += telemetry.outputTokens;
    total.reasoningTokens += telemetry.reasoningTokens;
    total.estimatedCnyCost += telemetry.estimatedCnyCost;
  }

  #traceStage(
    tick: number,
    stage: MayorStageName,
    phase: MayorStageTraceEntry["phase"],
    operation?: string,
    error?: string,
  ) {
    if (!this.#stageTraceEnabled || !this.#state) return;
    const key = `${tick}:${stage}:${operation ?? ""}`;
    const now = Date.now();
    if (phase === "start") this.#stageStartedAt.set(key, now);
    const startedAt = this.#stageStartedAt.get(key) ?? now;
    if (phase !== "start") this.#stageStartedAt.delete(key);
    const trace = this.#state.localMayorStageTrace ?? [];
    const revision =
      this.#localState?.snapshotRevision ??
      (typeof this.#state.lastSnapshot === "object" && this.#state.lastSnapshot !== null
        ? String((this.#state.lastSnapshot as Record<string, unknown>).snapshotRevision ?? "") || null
        : null);
    trace.push({
      tick,
      stage,
      phase,
      elapsedMs: Math.max(0, now - startedAt),
      revision,
      activity: this.#state.localMayorActivity?.activityKind ?? null,
      ...(operation ? { operation } : {}),
      ...(error ? { error: error.slice(0, 300) } : {}),
    });
    this.#state.localMayorStageTrace = trace.slice(-MAX_STAGE_TRACE);
  }

  async #fail(kind: string, reason: string, limit: number) {
    const state = this.#requireState();
    state.consecutiveFailures = this.#lastFailureKind === kind ? state.consecutiveFailures + 1 : 1;
    this.#lastFailureKind = kind;
    state.lastStatus = reason;
    if (state.consecutiveFailures >= limit)
      await this.#halt(`${reason} (${state.consecutiveFailures} consecutive ${kind} failures)`);
  }

  #resetFailures() {
    const state = this.#requireState();
    state.consecutiveFailures = 0;
    this.#lastFailureKind = null;
  }

  async #halt(reason: string) {
    const state = this.#requireState();
    if (state.status === "running") {
      state.status = "stopped";
      state.stopReason = reason.slice(0, 240);
      state.stoppedAt = this.#now().toISOString();
      // One final ledger entry, so the record ends on the reason the session
      // actually stopped rather than on the last window before it.
      state.runLedger = appendRunLedgerEntry(state.runLedger ?? emptyRunLedgerState(), {
        tick: state.tickCount,
        at: state.stoppedAt,
        facts: runLedgerFactsFromSnapshot(state.lastSnapshot, this.#runLedgerLabor, this.#runLedgerBuiltButVacant),
        decision: { ...this.#runLedgerDecision, haltReason: state.stopReason },
      });
    }
    this.#lifecycleStatus = "FAILED";
    this.#lifecycleLastError = reason.slice(0, 240);
    await this.#finalize();
  }

  async #finalize() {
    if (this.#finalized) return;
    this.#finalized = true;
    const state = this.#requireState();
    let pauseError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ports.pause();
        pauseError = undefined;
        if (!this.ports.confirmPaused || (await this.ports.confirmPaused())) break;
        pauseError = new Error("final runtime readback still reports paused:false");
      } catch (error) {
        pauseError = error;
        break;
      }
    }
    if (pauseError) state.lastStatus = `${state.lastStatus} Pause failed: ${message(pauseError)}`.slice(0, 240);
    // Saving is the player's decision (CURRENT_GAME_WORLD_IS_AUTHORITY): stop and halt never force a CS2 save.
    this.#emit("status");
  }

  #emit(event: "status" | "balance" | "tick") {
    if (this.#state) this.ports.emit?.(event, this.#snapshotState());
  }

  #say(event: MayorEvent) {
    const line = renderMayorEvent(event, this.#now().toISOString());
    if (line) this.ports.emitMayorCommentary?.(line);
  }

  #now() {
    return this.ports.now?.() ?? new Date();
  }

  #requireState() {
    if (!this.#state || !this.#cost) throw new Error("Mayor session has not been started");
    return this.#state;
  }

  #requireCost() {
    if (!this.#cost) throw new Error("Mayor session cost guard has not been initialized");
    return this.#cost;
  }

  #snapshotState() {
    const state = this.getState();
    if (!state) throw new Error("Mayor session has not been started");
    return state;
  }

  #requireRunning() {
    const state = this.#requireState();
    if (state.status !== "running")
      throw new Error(`Mayor session is stopped: ${state.stopReason ?? "unknown reason"}`);
    return state;
  }
}
