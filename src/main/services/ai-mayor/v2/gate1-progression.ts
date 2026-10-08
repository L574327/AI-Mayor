import type { NativeWorldIdentity } from "./durability";
import {
  V2_GATE1_STATE_SCHEMA_VERSION,
  type Gate1Stage,
  type Gate1State,
  type Gate1WorldBoundary,
} from "./gate1";
import type { Gate1ObservationProjectorOptions } from "./gate1-observation";
import { createV2LocalGate1FoundationRunner } from "./local-gate1-foundation-runner";
import type {
  V2LocalGate1ProductionRunner,
  V2LocalGate1TickResult,
  V2LocalGate1WakeConditionValue,
} from "./local-gate1-runner";
import type { V2FoundationPorts } from "./main-adapter";

/**
 * A Gate 1 operation the injected boundary cannot perform yet.
 *
 * The progression owner reports it as a capability gap. It never becomes a
 * stage change, and it is never translated into a success or a failure.
 */
export class Gate1ProgressionCapabilityGapError extends Error {
  constructor(readonly capability: "ZONING" | "RECOVERY") {
    super(`GATE1_PROGRESSION_CAPABILITY_GAP:${capability}`);
    this.name = "Gate1ProgressionCapabilityGapError";
  }
}

export type V2Gate1ProgressionStatus =
  | "MILESTONE_REACHED"
  | "WAITING"
  | "BLOCKED"
  | "CAPABILITY_GAP"
  | "WORLD_CHANGED"
  | "EXHAUSTED"
  | "NOT_ADMITTED";

export interface V2Gate1ProgressionResult {
  status: V2Gate1ProgressionStatus;
  state: Gate1State | null;
  stage: Gate1Stage | null;
  milestone: Gate1Stage;
  decisions: number;
  /** Durable journal evidence: ROAD commands that reached the native submission boundary. */
  roadCommandCount: number;
  /** Submission timestamp from the durable journal, for product timing only. */
  latestRoadSubmissionAt?: string | null;
  reason: string;
  wake?: V2LocalGate1WakeConditionValue;
}

/**
 * What the city's utility Goals had to say for themselves.
 *
 * `UNAVAILABLE` means the question could not be asked — no commissioning pass is
 * configured, the world is not durably activated, or the pass itself failed. It
 * is deliberately not `PARKED`: "nobody asked" must never be read as "every
 * service Goal is spent".
 */
export type V2Gate1UtilitySettleStatus =
  | "READY"
  | "WAITING"
  | "PLANNING_HANDOFF"
  | "BLOCKED"
  | "PARKED"
  | "UNAVAILABLE";

export interface V2Gate1UtilitySettleResult {
  status: V2Gate1UtilitySettleStatus;
  reason?: string;
}

export interface V2Gate1Progression {
  advanceToStage(milestone: Gate1Stage, signal?: AbortSignal): Promise<V2Gate1ProgressionResult>;
  snapshot(): Gate1State | null;
  /**
   * Let the city's utility Goals take their own bounded work, or be recorded as
   * spent, WITHOUT moving any tranche.
   *
   * The commissioning pass answers a city-level question — which service Goals
   * can still act — but it used to be reachable only from a tranche sitting at
   * `ROAD_DELIVERED` with a milestone at or beyond `ZONED_WAITING_FOR_BUILDING`.
   * A bounded prerequisite step stops at `ROAD_DELIVERED` and its own milestone
   * IS `ROAD_DELIVERED`, so that gate was unreachable for exactly the case that
   * needed it: the Goal whose prerequisite had just run out could never learn
   * that its service work was spent, and every cycle re-derived the same doomed
   * corridor.
   *
   * This asks the same question without pretending the step reached a milestone
   * it did not. The step's `completionStage` is untouched, and nothing here
   * changes what `advanceToStage` will report.
   */
  settleUtilityGoals(signal?: AbortSignal): Promise<V2Gate1UtilitySettleResult>;
}

export interface V2Gate1ProgressionOptions {
  foundation: V2FoundationPorts;
  /** Built from the activated world so proposals are bound to the live epoch/generation. */
  boundaryForWorld(world: NativeWorldIdentity): Gate1WorldBoundary;
  resolveRouteAnchor?: Gate1ObservationProjectorOptions["resolveRouteAnchor"];
  /** Bounded wait for the authoritative native operation slot. */
  waitForNativeIdle(signal: AbortSignal): Promise<void>;
  /** Bounded authoritative simulation used to satisfy a SIMULATION_PROGRESS wake. */
  runBoundedSimulation(signal: AbortSignal): Promise<void>;
  /**
   * Materialize the already durable utility service-road plan as a Gate 1
   * child operation before the SITE_SELECTED road task is evaluated. This is
   * preparation only; execution still passes through Gate 1 Admission.
   */
  prepareUtilityServiceRoadChild?(state: Gate1State, signal: AbortSignal): Promise<boolean>;
  /** Run the existing scoped production utility workflow before first zoning. */
  commissionZoningUtilities?(state: Gate1State, signal: AbortSignal): Promise<{
    /**
     * `PARKED` reports that every utility Goal the pass could consider has spent
     * its bounded work for this planning epoch, so the commissioning pass is
     * settled and the tranche continues with its own work. It is deliberately not
     * `READY`: nothing certified these services. It is also deliberately not a
     * hand-off, because a parked Goal is not a stopped Brain.
     */
    status: "READY" | "WAITING" | "REPLAN" | "PLANNING_HANDOFF" | "BLOCKED" | "PARKED";
    reason?: string;
  }>;
  /** Consecutive non-progressing wakes tolerated before the progression reports BLOCKED. */
  maximumWakeIterations?: number;
  maximumDecisions?: number;
}

/**
 * The Gate 1 stage order used to decide whether a requested milestone has been
 * reached or already passed. `DIAGNOSING` and `RECOVERING` are deliberately
 * absent: they are failure branches, not progress, and must never satisfy a
 * milestone.
 */
const LINEAR_STAGES: readonly Gate1Stage[] = [
  "PLANNED",
  "SITE_SELECTED",
  "ROAD_DELIVERED",
  "ZONED_WAITING_FOR_BUILDING",
  "BUILDING_OBSERVED",
  "WAITING_FOR_OCCUPANCY",
  "OCCUPIED",
];

const stageIndex = (stage: Gate1Stage): number => LINEAR_STAGES.indexOf(stage);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Commissioning outcomes that are statements about the Goals, not retries. */
const zoningUtilitiesSettleStatuses: ReadonlySet<string> = new Set(
  ["READY", "WAITING", "PLANNING_HANDOFF", "BLOCKED", "PARKED"] satisfies V2Gate1UtilitySettleStatus[],
);

/**
 * How many times one `advanceToStage` call may run the utility commissioning
 * pass.
 *
 * The outer decision budget governs cheap state transitions, and it was the only
 * thing bounding this retry. But one commissioning pass is the most expensive
 * operation in the system — it plans, probes natively and may place a facility,
 * per service — so "retry within the decision budget" meant a failing pass could
 * be repeated tens of times inside a single call. Observed live: one
 * `advanceToStage` ran for over twenty minutes doing exactly that.
 *
 * Two is one attempt and one retry, which is the retry the workflow asks for.
 * Once it is spent the tranche proceeds to its own work, which is correct:
 * frontage and utility supply are planning inputs to zoning, not gates on it.
 */
const MAXIMUM_ZONING_UTILITY_COMMISSIONING_ATTEMPTS = 2;

/**
 * Production Gate 1 lifecycle owner.
 *
 * It drives the existing Gate 1 state machine through `V2LocalGate1ProductionRunner`
 * — the same runner the battlefield harness uses, unmodified — over the durable
 * `Gate1State` in the real store. It never writes `tranche.stage` itself, never
 * fabricates a task outcome, and contains no per-Skill branch: reaching a stage
 * is entirely the state machine's decision, and this owner only decides when to
 * stop asking it to advance.
 */
export function createV2Gate1Progression(options: V2Gate1ProgressionOptions): V2Gate1Progression {
  const maximumWakeIterations = options.maximumWakeIterations ?? 3;
  const maximumDecisions = options.maximumDecisions ?? 32;
  let runner: V2LocalGate1ProductionRunner | null = null;
  let runnerIntentId: string | null = null;
  let runnerProjectId: string | null = null;

  const roadCommandCount = () =>
    options.foundation.commandJournal
      .list()
      .filter((command) => command.actionFamily === "ROAD" && command.submittedAt !== null).length;

  /**
   * Whether the Goal the active tranche serves is a base utility Goal.
   *
   * Read from the Goal's own id, which is the fact that decides it — the
   * milestone no longer distinguishes the two kinds, because a growth Goal is
   * done when its land is delivered and observed, exactly like a utility Goal is
   * done when its utility is. Falls back to the milestone only when no work
   * order names a Goal at all, which is the harness and bootstrap case.
   */
  const baseUtilityGoalForTranche = (): boolean => {
    const snapshot = options.foundation.durability?.snapshot?.();
    const active = (snapshot?.goalWorkOrders ?? [])
      .find((item) => item.workOrderId === snapshot?.activeGoalWorkOrderId);
    if (!active) return false;
    return /^(?:UTILITY_SERVICE|PROVIDE_SERVICE):/.test(active.goalId);
  };

  const ensureRunner = async (signal?: AbortSignal): Promise<V2LocalGate1ProductionRunner> => {
    if (runner) {
      const projectStateReader = options.foundation.durability as
        (typeof options.foundation.durability & { projectState?: () => unknown }) | undefined;
      const current = typeof projectStateReader?.projectState === "function" ? projectStateReader.projectState() as Gate1State : null;
      if (current?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
        current.intent.id === runnerIntentId && current.project.id === runnerProjectId) return runner;
      // Goal work-order activation swaps the durable Gate1 state behind this
      // adapter slot. A runner is a stateful workflow, so retaining the previous
      // project's cached context can report the old milestone for its successor.
      // Recreate only the provider; the successor's durable state and command
      // journal remain authoritative and untouched.
      runner = null;
      runnerIntentId = null;
      runnerProjectId = null;
    }
    const activation = await options.foundation.activateDurableWorld?.(signal);
    if (!activation) throw new Error("V2_GATE1_PROGRESSION_DURABILITY_NOT_CONFIGURED");
    if (activation.blockedReason) throw new Error(activation.blockedReason);
    const durability = options.foundation.durability;
    if (!durability?.isExecutionDurablyActivated(activation)) {
      throw new Error(`V2_GATE1_PROGRESSION_WORLD_NOT_DURABLY_ACTIVATED:${activation.status}`);
    }
    const stored = durability.projectState();
    runner = await createV2LocalGate1FoundationRunner(
      {
        foundation: options.foundation,
        boundary: options.boundaryForWorld(activation.world),
        ...(options.resolveRouteAnchor ? { resolveRouteAnchor: options.resolveRouteAnchor } : {}),
      },
      signal,
    );
    if (stored.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION) {
      runnerIntentId = stored.intent.id;
      runnerProjectId = stored.project.id;
    }
    return runner;
  };

  const result = (input: Omit<V2Gate1ProgressionResult, "roadCommandCount" | "latestRoadSubmissionAt">): V2Gate1ProgressionResult => ({
    ...input,
    roadCommandCount: roadCommandCount(),
    latestRoadSubmissionAt: (() => {
      const submitted = options.foundation.commandJournal.list()
        .filter((command) => command.actionFamily === "ROAD" && command.submittedAt !== null);
      return submitted[submitted.length - 1]?.submittedAt ?? null;
    })(),
  });

  return {
    snapshot: () => runner?.snapshot() ?? null,

    async settleUtilityGoals(signal) {
      if (!options.commissionZoningUtilities) {
        return { status: "UNAVAILABLE", reason: "UTILITY_COMMISSIONING_NOT_CONFIGURED" };
      }
      const activation = await options.foundation.activateDurableWorld?.(signal);
      if (!activation) return { status: "UNAVAILABLE", reason: "V2_GATE1_PROGRESSION_DURABILITY_NOT_CONFIGURED" };
      if (activation.blockedReason) return { status: "UNAVAILABLE", reason: activation.blockedReason };
      const state = options.foundation.durability?.projectState();
      if (state?.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        return { status: "UNAVAILABLE", reason: "NO_DURABLE_GATE1_STATE" };
      }
      let result: Awaited<ReturnType<NonNullable<V2Gate1ProgressionOptions["commissionZoningUtilities"]>>>;
      try {
        result = await options.commissionZoningUtilities(state, signal ?? new AbortController().signal);
      } catch (error) {
        return { status: "UNAVAILABLE", reason: message(error) };
      }
      // A bounded planner failure is a retry signal for the tranche path, not an
      // answer about the Goal's executable state. Reported as unavailable so no
      // caller mistakes it for "spent".
      if (result.status === "REPLAN") return { status: "UNAVAILABLE", reason: result.reason };
      if (!zoningUtilitiesSettleStatuses.has(result.status)) {
        return { status: "UNAVAILABLE", reason: `UNRECOGNIZED_SETTLE_STATUS:${String(result.status)}` };
      }
      return { status: result.status as V2Gate1UtilitySettleStatus, ...(result.reason ? { reason: result.reason } : {}) };
    },

    async advanceToStage(milestone, signal) {
      const milestoneIndex = stageIndex(milestone);
      if (milestoneIndex < 0) {
        return result({
          status: "BLOCKED",
          state: null,
          stage: null,
          milestone,
          decisions: 0,
          reason: `GATE1_PROGRESSION_MILESTONE_NOT_A_LINEAR_STAGE:${milestone}`,
        });
      }
      const reachedOrPassed = (stage: Gate1Stage) => {
        const index = stageIndex(stage);
        return index >= 0 && index >= milestoneIndex;
      };

      // Wake handling needs an abort signal. When the caller supplies none the
      // progression still runs, bounded by its own decision budget rather than
      // by cancellation.
      const abort = signal ?? new AbortController().signal;

      let current: V2LocalGate1ProductionRunner;
      try {
        current = await ensureRunner(abort);
      } catch (error) {
        const reason = message(error);
        return result({
          status: reason.includes("initial CityIntent is required") ? "NOT_ADMITTED" : "BLOCKED",
          state: null,
          stage: null,
          milestone,
          decisions: 0,
          reason,
        });
      }

      let decisions = 0;
      let wakeIterations = 0;
      let utilityChildPreparationAttempted = false;
      let zoningUtilitiesReady = false;
      let zoningUtilityCommissioningAttempts = 0;
      let zoningPlannerReason: string | undefined;
      for (;;) {
        const before = current.snapshot();
        if (reachedOrPassed(before.tranche.stage)) {
          return result({
            status: "MILESTONE_REACHED",
            state: before,
            stage: before.tranche.stage,
            milestone,
            decisions,
            reason: `Gate 1 tranche is at ${before.tranche.stage}, which satisfies milestone ${milestone}`,
          });
        }
        if (decisions >= maximumDecisions) {
          return result({
            status: "EXHAUSTED",
            state: before,
            stage: before.tranche.stage,
            milestone,
            decisions,
            reason: `Gate 1 progression exceeded ${maximumDecisions} decisions without reaching ${milestone}${zoningPlannerReason ? `; K05: ${zoningPlannerReason}` : ""}`,
          });
        }

        if (
          !zoningUtilitiesReady &&
          zoningUtilityCommissioningAttempts < MAXIMUM_ZONING_UTILITY_COMMISSIONING_ATTEMPTS &&
          milestoneIndex >= stageIndex("ZONED_WAITING_FOR_BUILDING") &&
          before.tranche.stage === "ROAD_DELIVERED" &&
          !before.tasks.some((task) => task.id === before.tranche.currentTaskIds?.ROAD_CONNECTION &&
            task.utilityRoadParentTaskId && (task.status === "PENDING" || task.status === "WAITING")) &&
          options.commissionZoningUtilities
        ) {
          let utilityResult: Awaited<ReturnType<NonNullable<V2Gate1ProgressionOptions["commissionZoningUtilities"]>>>;
          try {
            utilityResult = await options.commissionZoningUtilities(before, abort);
          } catch (error) {
            utilityResult = { status: "REPLAN", reason: message(error) };
          }
          zoningUtilityCommissioningAttempts += 1;
          decisions += 1;
          zoningPlannerReason = utilityResult.reason;
          const activeDurableState = options.foundation.durability?.projectState();
          if (activeDurableState?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
            activeDurableState.intent.id !== before.intent.id) {
            // The Brain admitted a distinct Goal work order while the previous
            // one was blocked locally. Recreate the stateless Gate1 provider on
            // the next Brain pass; neither project's persisted task history is
            // rewritten or merged.
            runner = null;
            return result({ status: "EXHAUSTED", state: activeDurableState, stage: activeDurableState.tranche.stage,
              milestone, decisions, reason: utilityResult.reason ?? "GOAL_WORK_ORDER_ACTIVATED" });
          }
          if (utilityResult.status === "READY") {
            zoningUtilitiesReady = true;
            continue;
          }
          if (utilityResult.status === "WAITING") {
            // The utility service workflow is waiting on simulation or readback.
            // Stop commissioning in this call — but do NOT stop the tranche.
            //
            // This used to `return` a WAITING result, which made the utility pass
            // a gate on zoning: the tranche sat at `ROAD_DELIVERED` with its
            // ZONING task PENDING and `advanceToStage` never reached it. Measured
            // live (2026-09-30) on an admitted commercial Goal: eight Brain
            // cycles, a journal that never moved past position 93, zero native
            // mutations, and 2527 of 2823 native calls spent polling for a
            // simulation auto-pause. The file's own rule is the opposite — see
            // the commissioning bound above and the retry arm below: "frontage
            // and utility supply are planning inputs to zoning, not gates on it."
            //
            // A waiting service is answered by the world running, and the tranche
            // has real work it can do meanwhile. Zoning now, and letting the
            // service settle on a later pass, is also the only order in which the
            // service can ever be observed as delivered: its consumers are the
            // buildings this zoning produces.
            zoningUtilitiesReady = true;
            zoningPlannerReason = utilityResult.reason ?? "UTILITY_SERVICE_PROGRESS_PENDING";
            continue;
          }
          if (utilityResult.status === "BLOCKED") {
            // The utility planner has no option left in this scope. That is a
            // finding about the utility, and the tranche still has its own work:
            // stop commissioning in this call and take it.
            //
            // Returning BLOCKED here made a utility failure a gate on zoning,
            // which is the opposite of this file's own rule — "frontage and
            // utility supply are planning inputs to zoning, not gates on it".
            // Measured live (2026-10-01): every admitted Goal closed at
            // `ROAD_DELIVERED` with its `ZONING` task at `attempts: 0`, the Brain
            // admitted another Goal, and the city churned through work orders at
            // fifteen seconds each while zoning nothing.
            zoningUtilitiesReady = true;
            zoningPlannerReason = utilityResult.reason ?? "UTILITY_PLANNER_OPTIONS_EXHAUSTED";
            continue;
          }
          if (utilityResult.status === "PLANNING_HANDOFF") {
            return result({ status: "EXHAUSTED", state: before, stage: before.tranche.stage,
              milestone, decisions, reason: utilityResult.reason ?? "UTILITY_PLANNING_HANDOFF_REQUIRED" });
          }
          if (utilityResult.status === "PARKED") {
            // Every utility Goal this pass could consider has spent its bounded
            // work. The tranche itself still has executable work — its own next
            // stage is zoning — so settle this pass and let the loop take it. The
            // parked Goals stay recorded in the durable ledger, scoped to this
            // planning epoch, so a new world/branch/revision re-opens them without
            // this pass re-running the same exhausted ladder.
            zoningUtilitiesReady = true;
            continue;
          }
          // A bounded planner failure is retried through the existing utility
          // workflow — once. Past that the tranche takes its own next step
          // rather than repeating the most expensive operation in the system:
          // services are a planning input to zoning, not a gate on it.
          continue;
        }

        const roadTaskId = before.tranche.currentTaskIds?.ROAD_CONNECTION;
        const roadTask = roadTaskId
          ? before.tasks.find((task) => task.id === roadTaskId && task.kind === "ROAD_CONNECTION")
          : before.tasks.find((task) => task.kind === "ROAD_CONNECTION");
        const roadChild = roadTask?.childOperationAmendmentId
          ? options.foundation.durability?.utilityBudgetAmendments().find((item) => item.amendmentId === roadTask.childOperationAmendmentId)
          : null;
        const roadChildUnavailable = !!roadTask?.childOperationAmendmentId &&
          (!roadChild || roadChild.reason !== "UTILITY_SERVICE_ROAD_CHILD_OPERATION" || roadChild.status === "CONSUMED" ||
            roadChild.executionUseStatus === "CONSUMED");
        const terminalRoadReplacementEligible = !!roadTask &&
          options.foundation.durability?.isRoadPlannerInputReplacementEligible(before, roadTask.id) === true;
        if (
          milestone === "ROAD_DELIVERED" &&
          before.tranche.stage === "SITE_SELECTED" &&
          roadTask &&
          (!roadTask.childOperationAmendmentId || roadChildUnavailable || terminalRoadReplacementEligible) &&
          !utilityChildPreparationAttempted &&
          options.prepareUtilityServiceRoadChild
        ) {
          utilityChildPreparationAttempted = true;
          try {
            await options.prepareUtilityServiceRoadChild(before, abort);
          } catch (error) {
            const reason = message(error);
            return result({
              status: "BLOCKED",
              state: before,
              stage: before.tranche.stage,
              milestone,
              decisions,
              reason,
            });
          }
        }

        let tick: V2LocalGate1TickResult;
        try {
          tick = await current.tick(abort, milestone, baseUtilityGoalForTranche());
        } catch (error) {
          if (error instanceof Gate1ProgressionCapabilityGapError) {
            return result({
              status: "CAPABILITY_GAP",
              state: before,
              stage: before.tranche.stage,
              milestone,
              decisions,
              reason: error.message,
            });
          }
          return result({
            status: "BLOCKED",
            state: before,
            stage: before.tranche.stage,
            milestone,
            decisions,
            reason: message(error),
          });
        }
        decisions += 1;

        switch (tick.kind) {
          case "LOCAL_SUCCESS":
            wakeIterations = 0;
            continue;
          case "LOCAL_WAITING":
            if (tick.wake?.condition === "WORLD_WRITE_IDLE") {
              await options.waitForNativeIdle(abort);
              wakeIterations = 0;
              continue;
            }
            if (tick.wake?.condition === "SIMULATION_PROGRESS") {
              // Counted, not cleared. Running the city advances the WORLD; it does
              // nothing for THIS tranche, so a simulation wake is exactly the
              // "woke up and did not progress" case `maximumWakeIterations` names.
              // Clearing it made that bound unreachable for the one wait a growth
              // city spends most of its life in, leaving `maximumDecisions` as the
              // only limit: one `advanceToStage` could buy twelve simulation
              // windows — three in-game hours — before answering. Measured live
              // (2026-10-01, fresh city): one Brain cycle spent 79 windows across
              // its six progression calls and produced a single road, twenty
              // in-game hours for one construction, because no other Goal was ever
              // consulted while the world was being run for this one.
              //
              // The bound is checked before the window is spent, so it counts the
              // windows this call actually buys. Nothing is lost by stopping: the
              // tranche is not blocked, it is waiting, and the Brain's cycle acts
              // on exactly that — it hands the work order back, asks the growth
              // policy what else the city can build, and re-enters this one from
              // fresh facts next cycle. The construction per in-game hour is what
              // that buys.
              wakeIterations += 1;
              if (wakeIterations > maximumWakeIterations) {
                return result({
                  status: "WAITING",
                  state: tick.state,
                  stage: tick.state.tranche.stage,
                  milestone,
                  decisions,
                  reason: `GATE1_WAITING_FOR_WORLD_AFTER_${maximumWakeIterations}_SIMULATION_WINDOWS:${tick.reason}`,
                  ...(tick.wake ? { wake: tick.wake } : {}),
                });
              }
              await options.runBoundedSimulation(abort);
              continue;
            }
            if (tick.wake?.condition === "DEPENDENT_CONSTRUCTION") {
              // The operation is not blocked and the clock is not its answer: the
              // fact it waits for is another operation's construction. Hand the
              // cycle back now, buying ZERO simulation windows.
              //
              // This is deliberately NOT routed through the retry tail below. A
              // non-world wake there would be re-observed up to
              // `maximumWakeIterations` times and then reported BLOCKED, which
              // turns a waiting tranche into a blocked one — the opposite of the
              // rule this whole path exists for: waiting freezes this operation
              // only, never the Goal and never the city.
              //
              // Nothing is written: no park, no strike, no suppression, no
              // successor. The Goal stays ACTIVE and the next Brain cycle
              // re-enters from fresh authoritative facts.
              return result({
                status: "WAITING",
                state: tick.state,
                stage: tick.state.tranche.stage,
                milestone,
                decisions,
                reason: `GATE1_WAITING_ON_DEPENDENT_WORK:${tick.reason}`,
                ...(tick.wake ? { wake: tick.wake } : {}),
              });
            }
            break;
          case "LOCAL_RECOVERABLE_FAILURE":
            if (tick.task?.utilityRoadParentTaskId && tick.reason.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE") &&
              options.commissionZoningUtilities) {
              try {
                const replanned = await options.commissionZoningUtilities(tick.state, abort);
                decisions += 1;
                zoningPlannerReason = replanned.reason;
                wakeIterations = 0;
                continue;
              } catch (error) {
                zoningPlannerReason = message(error);
                continue;
              }
            }
            break;
          case "LOCAL_WORLD_CHANGED":
            return result({
              status: "WORLD_CHANGED",
              state: tick.state,
              stage: tick.state.tranche.stage,
              milestone,
              decisions,
              reason: tick.reason,
              ...(tick.wake ? { wake: tick.wake } : {}),
            });
          case "LOCAL_NO_APPLICABLE_SKILL":
            return result({
              status: "CAPABILITY_GAP",
              state: tick.state,
              stage: tick.state.tranche.stage,
              milestone,
              decisions,
              reason: tick.reason,
              ...(tick.wake ? { wake: tick.wake } : {}),
            });
          case "LOCAL_EXHAUSTED":
          case "PROJECT_COMPLETED_NEXT_DECISION_READY":
          case "LOCAL_NEXT_DECISION_CREATED":
            return result({
              status: "BLOCKED",
              state: tick.state,
              stage: tick.state.tranche.stage,
              milestone,
              decisions,
              reason: tick.reason,
              ...(tick.wake ? { wake: tick.wake } : {}),
            });
        }

        // A NEXT_OBSERVATION / RECONCILIATION_REQUIRED wake is retried a bounded
        // number of times. Each retry performs authoritative native reads, so the
        // loop is paced by the observation boundary rather than by a local timer.
        wakeIterations += 1;
        if (wakeIterations > maximumWakeIterations) {
          return result({
            status: "BLOCKED",
            state: tick.state,
            stage: tick.state.tranche.stage,
            milestone,
            decisions,
            reason: tick.reason,
            ...(tick.wake ? { wake: tick.wake } : {}),
          });
        }
      }
    },
  };
}
