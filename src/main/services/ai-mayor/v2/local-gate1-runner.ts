import {
  createGate1VerticalSlice,
  createDurableGate1StateStorage,
  type Gate1Observation,
  type Gate1Stage,
  type Gate1SkillProposal,
  type Gate1State,
  type Gate1Task,
  type Gate1WorldBoundary,
  type Gate1OutcomeJournalEntry,
  type Gate1StateStorage,
  type StarterResidentialIntentInput,
  planStarterResidentialIntent,
} from "./gate1";
import { type V2DurabilityCoordinator } from "./durability";
import type { DurableGreenfieldUtilityState } from "./greenfield-utility-bootstrap";
import { deriveCurrentBranchProjectReplanIdentity } from "./project-admission";

export type V2LocalGate1ResultKind =
  | "LOCAL_SUCCESS"
  | "LOCAL_WAITING"
  | "LOCAL_NO_APPLICABLE_SKILL"
  | "LOCAL_RECOVERABLE_FAILURE"
  | "LOCAL_EXHAUSTED"
  | "LOCAL_WORLD_CHANGED"
  | "PROJECT_COMPLETED_NEXT_DECISION_READY"
  | "LOCAL_NEXT_DECISION_CREATED";

export type V2LocalGate1WakeCondition =
  | "NEXT_OBSERVATION"
  | "SIMULATION_PROGRESS"
  /**
   * The fact this operation waits for is supplied by ANOTHER operation's
   * construction, not by the clock. Running the city cannot produce it, so the
   * wake must not be answered with a simulation window.
   *
   * Measured live (2026-10-01): a base `PROVIDE_SERVICE:electricity` Goal waits
   * for `NO_ATTRIBUTED_BUILDING` — a building in its scope. `ZONING` is
   * deliberately not an eligible task for a base utility Goal (`gate1.ts:1820`),
   * so that Goal cannot produce the building itself; the building arrives when
   * another tranche zones. Claiming `SIMULATION_PROGRESS` for it spent three
   * simulation windows per progression call on a fact the clock provably cannot
   * supply, and the utility wait then held the whole Brain for the tick.
   */
  | "DEPENDENT_CONSTRUCTION"
  | "WORLD_WRITE_IDLE"
  | "RECONCILIATION_REQUIRED"
  | "PLAYER_INPUT";

export interface V2LocalGate1WakeConditionValue {
  condition: V2LocalGate1WakeCondition;
  detail: string;
}

export interface V2LocalGate1CapabilityGap {
  skill: Gate1SkillProposal["skill"] | null;
  operation: Gate1SkillProposal["operation"] | null;
  reason: string;
}

export interface V2LocalGate1ProductionRunnerOptions {
  storage?: Gate1StateStorage;
  boundary: Gate1WorldBoundary;
  initial?: StarterResidentialIntentInput;
  /** Deterministic planner seam used to verify create-once/restore semantics. */
  planIntent?: typeof planStarterResidentialIntent;
  observe(state: Gate1State, signal?: AbortSignal): Promise<Gate1Observation>;
  nextDecision?(input: {
    completed: Gate1State;
    observation: Gate1Observation;
  }): StarterResidentialIntentInput | null | Promise<StarterResidentialIntentInput | null>;
  durability?: V2LocalGate1DurabilityPort;
}

export interface V2LocalGate1DurabilityPort {
  coordinator: V2DurabilityCoordinator;
  activate(signal?: AbortSignal): Promise<ReturnType<V2DurabilityCoordinator["activate"]>>;
}

export interface V2LocalGate1TickResult {
  kind: V2LocalGate1ResultKind;
  state: Gate1State;
  task: Gate1Task | null;
  proposal: Gate1SkillProposal | null;
  outcome: Gate1OutcomeJournalEntry | null;
  wake?: V2LocalGate1WakeConditionValue;
  capabilityGap?: V2LocalGate1CapabilityGap;
  reason: string;
}

const unknownObservation = (error: unknown): V2LocalGate1TickResult["reason"] =>
  `pure V2 observation unavailable: ${error instanceof Error ? error.message : String(error)}`;

const isCapabilityGap = (reason: string) =>
  /no bounded (?:Foundation )?resolver|no applicable skill|unsupported capability/i.test(reason);

export const isBoundedUtilityRoadPlannerRejection = (
  task: Gate1Task | null,
  outcome: Gate1OutcomeJournalEntry | null,
  reason: string,
): boolean => !!task && task.kind === "ROAD_CONNECTION" && !!task.utilityRoadParentTaskId &&
  outcome?.execution === "NOT_REQUIRED" && outcome.commandId === null &&
  outcome.failureClassification === "ROAD_PREFLIGHT_REJECTED" && reason.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE");

/**
 * Exported for its own test, the way `isBoundedUtilityRoadPlannerRejection` is:
 * it is a pure decision, and it is the decision that was wrong — a base utility
 * Goal's unattributable-building wait was announced as `SIMULATION_PROGRESS` and
 * spent the tick's whole simulation budget on a fact the clock cannot supply.
 */
export const wakeForTask = (task: Gate1Task | null, baseUtilityGoal = false): V2LocalGate1WakeConditionValue => {
  // A base utility Goal's UTILITY_PROVISION waits on a building the SIMULATION
  // does not owe it: `ZONING` is not eligible for this Goal (`gate1.ts:1820`),
  // so its consumers can only appear when another tranche zones. That is the
  // one case where the clock is not the answer. A growth Goal's
  // UTILITY_PROVISION still waits on its own consumers initializing, which the
  // simulation does supply, so it keeps SIMULATION_PROGRESS below.
  if (task?.kind === "UTILITY_PROVISION" && baseUtilityGoal) {
    return { condition: "DEPENDENT_CONSTRUCTION",
      detail: "wait for another tranche's attributable building; this utility Goal cannot produce it" };
  }
  if (task?.kind === "WAIT_FOR_BUILDING" || task?.kind === "WAIT_OBSERVE" || task?.kind === "UTILITY_PROVISION") {
    return { condition: "SIMULATION_PROGRESS", detail: "observe after bounded simulation progress" };
  }
  if (task?.kind === "RECOVERY") {
    return { condition: "NEXT_OBSERVATION", detail: "re-observe the recovery scope before dispatch" };
  }
  if (task?.kind === "ROAD_CONNECTION") {
    return { condition: "WORLD_WRITE_IDLE", detail: "observe native build operation until the single-flight slot is idle" };
  }
  return { condition: "NEXT_OBSERVATION", detail: "capture the next coherent V2 observation" };
};

/**
 * Deterministic V2 Gate 1 production composition.
 *
 * This module intentionally has no provider, MayorRuntime, or legacy Local Mayor
 * dependency. Cloud rescue is a caller-owned control-plane concern and cannot be
 * reached through this routine runner.
 */
export class V2LocalGate1ProductionRunner {
  #workflow: ReturnType<typeof createGate1VerticalSlice> | null = null;
  readonly #observe: V2LocalGate1ProductionRunnerOptions["observe"];
  readonly #boundary: Gate1WorldBoundary;
  readonly #initial: StarterResidentialIntentInput | undefined;
  readonly #planIntent: V2LocalGate1ProductionRunnerOptions["planIntent"];
  readonly #durability: V2LocalGate1DurabilityPort | undefined;
  readonly #nextDecision: V2LocalGate1ProductionRunnerOptions["nextDecision"];
  #worldEpochId: string | null = null;

  constructor(options: V2LocalGate1ProductionRunnerOptions) {
    if (!options.storage && !options.durability) throw new Error("V2 Local Gate 1 runner requires durable or memory storage");
    this.#boundary = options.boundary;
    this.#initial = options.initial;
    this.#planIntent = options.planIntent;
    this.#durability = options.durability;
    this.#nextDecision = options.nextDecision;
    if (options.storage) {
      this.#workflow = createGate1VerticalSlice({ storage: options.storage, boundary: options.boundary, initial: options.initial, planIntent: options.planIntent });
    }
    this.#observe = options.observe;
  }

  static async create(options: V2LocalGate1ProductionRunnerOptions, signal?: AbortSignal) {
    const runner = new V2LocalGate1ProductionRunner(options);
    await runner.#activate(signal);
    return runner;
  }

  async #activate(signal?: AbortSignal) {
    if (!this.#durability) return;
    const activation = await this.#durability.activate(signal);
    if (activation.blockedReason) throw new Error(`V2 durable world blocked: ${activation.blockedReason}`);
    if (!this.#durability.coordinator.isExecutionDurablyActivated(activation)) throw new Error(`V2 durable world is ${activation.status}`);
    this.#worldEpochId = activation.world.worldEpochId;
    this.#workflow = createGate1VerticalSlice({
      storage: createDurableGate1StateStorage(this.#durability.coordinator),
      boundary: this.#boundary,
      initial: this.#initial,
      planIntent: this.#planIntent,
      commandJournal: this.#durability.coordinator.commandJournal,
      utilityServiceRoadChildOperation: (amendmentId) => this.#durability!.coordinator.utilityBudgetAmendments()
        .find((entry) => entry.amendmentId === amendmentId) ?? null,
      concreteChildOperationAdmissionContext: (observation) => {
        const coordinator = this.#durability!.coordinator;
        const observed = observation?.world;
        let current: { worldId: string; checkpointId: string; generation: string; planRevision: string } | null = null;
        // The branch identity is its rollback boundary, proven by the store. The
        // observation has to be of that same world and generation, but not of a
        // save identity: a world started fresh carries no checkpoint id of its
        // own, and requiring one made this context unreachable there.
        const branch = coordinator.currentBranchCheckpoint();
        if (branch && observed && observed.worldId === branch.worldId && observed.generation === branch.generation) {
          const identity = deriveCurrentBranchProjectReplanIdentity({
            worldId: branch.worldId,
            checkpointId: branch.checkpointId,
            journalCut: branch.journalCut,
          });
          current = { worldId: branch.worldId, checkpointId: branch.checkpointId,
            generation: branch.generation, planRevision: identity.replanId };
        }
        return {
          current,
          getAmendment: (amendmentId) => coordinator.utilityBudgetAmendments()
            .find((entry) => entry.amendmentId === amendmentId) ?? null,
          hasRoadOperation: (exactInput) => coordinator.commandJournal.list().some((command) =>
            command.actionFamily === "ROAD" && command.authorizedScope.actionFamily === "ROAD" &&
            command.authorizedScope.exactInput === exactInput),
        };
      },
    });
  }

  #currentWorkflow() {
    if (!this.#workflow) throw new Error("V2 Local Gate 1 runner has not been activated");
    return this.#workflow;
  }

  snapshot(): Gate1State {
    return this.#currentWorkflow().snapshot();
  }

  recordUtilityExecution(value: DurableGreenfieldUtilityState): Gate1State {
    return this.#currentWorkflow().recordUtilityExecution(value);
  }

  async tick(signal?: AbortSignal, goalCompletionStage?: Gate1Stage,
    servesBaseUtilityGoal?: boolean): Promise<V2LocalGate1TickResult> {
    const workflow = this.#currentWorkflow();
    const before = workflow.snapshot();
    // Read once: every wait below decides "the clock or another operation" from it.
    const baseUtility = servesBaseUtilityGoal === true;
    if (this.#durability) {
      try {
        const activation = await this.#durability.activate(signal);
        if (activation.blockedReason) throw new Error(activation.blockedReason);
        if (!this.#durability.coordinator.isExecutionDurablyActivated(activation)) throw new Error(`V2 durable world is ${activation.status}`);
        if (this.#worldEpochId !== activation.world.worldEpochId) {
          return {
            kind: "LOCAL_WORLD_CHANGED",
            state: before,
            task: null,
            proposal: null,
            outcome: null,
            wake: { condition: "PLAYER_INPUT", detail: "create or explicitly rebind a V2 project for the active world" },
            reason: `active world epoch changed from ${this.#worldEpochId} to ${activation.world.worldEpochId}`,
          };
        }
      } catch (error) {
        return {
          kind: "LOCAL_RECOVERABLE_FAILURE",
          state: before,
          task: null,
          proposal: null,
          outcome: null,
          wake: { condition: "RECONCILIATION_REQUIRED", detail: "durable command reconciliation must complete before another write" },
          reason: `durable world activation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    let observation: Gate1Observation;
    try {
      observation = await this.#observe(before, signal);
    } catch (error) {
      return {
        kind: "LOCAL_RECOVERABLE_FAILURE",
        state: before,
        task: null,
        proposal: null,
        outcome: null,
        wake: { condition: "NEXT_OBSERVATION", detail: "retry after the pure observation boundary is available" },
        reason: unknownObservation(error),
      };
    }

    if (observation.coherence === "UNKNOWN") {
      const executableTask = before.tasks.find((candidate) =>
        (candidate.status === "PENDING" || candidate.status === "WAITING") &&
        candidate.legalStage === before.tranche.stage,
      ) ?? null;
      return {
        kind: "LOCAL_RECOVERABLE_FAILURE",
        state: before,
        task: executableTask,
        proposal: null,
        outcome: null,
        wake: { condition: "NEXT_OBSERVATION", detail: "UNKNOWN coherence cannot advance a V2 task" },
        // Name the read that was unavailable. A bare "UNKNOWN" cannot be acted
        // on: measured live (2026-09-30), eight ticks in a row refused here with
        // nothing in the evidence to say whether the Bridge read failed, the
        // frame was unreadable, or the world had simply not settled.
        reason: "V2 observation coherence is UNKNOWN; task progression is blocked"
          + (observation.incoherence
            ? `: frames ${observation.incoherence.frameBefore}->${observation.incoherence.frameAfter}`
              + `: incoherent ${observation.incoherence.unavailableSources.join(",") || "none"}`
            : ""),
      };
    }

    if (before.project.status === "COMPLETE" && before.completion?.handoffStatus === "NEXT_DECISION_READY") {
      const next = await this.#nextDecision?.({ completed: before, observation });
      if (!next) {
        return {
          kind: "PROJECT_COMPLETED_NEXT_DECISION_READY",
          state: before,
          task: null,
          proposal: null,
          outcome: null,
          wake: { condition: "NEXT_OBSERVATION", detail: "Local Mayor scheduler may select a new scoped development decision" },
          reason: `project ${before.project.id} is complete and its handoff is ready`,
        };
      }
      const state = workflow.startNextProject(next);
      return {
        kind: "LOCAL_NEXT_DECISION_CREATED",
        state,
        task: state.tasks.find((task) => task.status === "PENDING") ?? null,
        proposal: null,
        outcome: null,
        reason: `new Local V2 decision ${state.intent.id} created after observing the completed project handoff`,
      };
    }

    const result = await workflow.tick(observation, signal,
      goalCompletionStage === undefined && servesBaseUtilityGoal === undefined ? undefined
        : { ...(goalCompletionStage === undefined ? {} : { goalCompletionStage }),
            ...(servesBaseUtilityGoal === undefined ? {} : { servesBaseUtilityGoal }) });
    const task = result.task;
    const proposal = result.proposal;
    const outcome = result.outcome;
    const state = result.state;

    if (state.project.status === "OCCUPIED") {
      const completed = workflow.completeOccupiedProject();
      return {
        kind: "PROJECT_COMPLETED_NEXT_DECISION_READY",
        state: completed.state,
        task: null,
        proposal,
        outcome,
        wake: { condition: "NEXT_OBSERVATION", detail: "observe current city before selecting the next development decision" },
        reason: completed.newlyCompleted
          ? `project ${completed.state.project.id} completed once; reservation released and next decision handoff recorded`
          : `project ${completed.state.project.id} was already completed`,
      };
    }

    if (!task) {
      if (state.project.status !== "BLOCKED") {
        return {
          kind: "LOCAL_RECOVERABLE_FAILURE",
          state,
          task,
          proposal,
          outcome,
          wake: { condition: "PLAYER_INPUT", detail: "inspect or reconcile the nonterminal Gate 1 task graph" },
          reason: `Gate 1 liveness invariant violated: ${state.tranche.stage} has no executable task`,
        };
      }
      const blockingOutcome = [...state.journal]
        .reverse()
        .find((candidate) => candidate.failureClassification !== "NONE");
      return {
        kind: "LOCAL_EXHAUSTED",
        state,
        task,
        proposal,
        outcome,
        reason: blockingOutcome
          ? `Gate 1 blocked by ${blockingOutcome.failureClassification}: ${blockingOutcome.reason}`
          : "Gate 1 is terminally blocked without a recorded failure outcome",
      };
    }

    const reason = outcome?.reason ?? "V2 task did not produce a terminal outcome";
    if (isBoundedUtilityRoadPlannerRejection(task, outcome, reason)) {
      return {
        kind: "LOCAL_RECOVERABLE_FAILURE",
        state,
        task,
        proposal,
        outcome,
        wake: { condition: "NEXT_OBSERVATION", detail: "return exhausted utility route candidate to the K05 planner" },
        reason,
      };
    }
    if (outcome?.failureClassification === "OBSERVATION_UNKNOWN") {
      if (task?.kind === "ZONING" && state.tranche.stage === "ROAD_DELIVERED") {
        return {
          kind: "LOCAL_WAITING",
          state,
          task,
          proposal,
          outcome,
          wake: {
            condition: "SIMULATION_PROGRESS",
            detail: "advance the paused world through a bounded update before re-observing post-road frontage",
          },
          reason,
        };
      }
      return {
        kind: "LOCAL_RECOVERABLE_FAILURE",
        state,
        task,
        proposal,
        outcome,
        wake: { condition: "NEXT_OBSERVATION", detail: "UNKNOWN observation must be replaced by a coherent observation" },
        reason,
      };
    }

    if (isCapabilityGap(reason)) {
      return {
        kind: "LOCAL_NO_APPLICABLE_SKILL",
        state,
        task,
        proposal,
        outcome,
        capabilityGap: {
          skill: proposal?.skill ?? null,
          operation: proposal?.operation ?? null,
          reason,
        },
        reason,
      };
    }

    if (outcome?.failureClassification === "RECOVERY_EXHAUSTED" || state.project.status === "BLOCKED") {
      return { kind: "LOCAL_EXHAUSTED", state, task, proposal, outcome, reason };
    }

    if (outcome?.execution === "WAITING") {
      const nativeSlotWait = reason === "WAITING_FOR_NATIVE_BUILD_SLOT";
      const asyncWorldWait = /WAITING_FOR_(ROUTE_RESULT|CONSUMER_INITIALIZATION|OCCUPANCY)/.test(reason);
      // Only the fall-through is overridden, and only for a base utility Goal:
      // its leftover wait is the building another tranche owes it, not the clock.
      // A native-slot or route/consumer wait IS a world wait and keeps its answer.
      const dependentConstruction = baseUtility && task?.kind === "UTILITY_PROVISION";
      return {
        kind: "LOCAL_WAITING",
        state,
        task,
        proposal,
        outcome,
        wake: {
          condition: nativeSlotWait
            ? "WORLD_WRITE_IDLE"
            : asyncWorldWait
            ? "SIMULATION_PROGRESS"
            : dependentConstruction
            ? "DEPENDENT_CONSTRUCTION"
            : "NEXT_OBSERVATION",
          detail: nativeSlotWait
            ? "poll native operation state with bounded backoff, then resume the same RoadConnection task"
            : asyncWorldWait
            ? "advance bounded simulation and re-observe the pending asynchronous condition"
            : dependentConstruction
            ? "wait for another tranche's attributable building; this utility Goal cannot produce it"
            : "reconcile the same submitted ROAD command against the next authoritative topology observation",
        },
        reason,
      };
    }

    if (task.kind === "WAIT_FOR_BUILDING" || task.kind === "WAIT_OBSERVE" ||
      // Only while the certification is still waiting. Once its budget is
      // spent the stage has already moved to DIAGNOSING and the next tick must
      // take the new task rather than re-run the simulation for this one.
      (task.kind === "UTILITY_PROVISION" && (task.status === "PENDING" || task.status === "WAITING"))) {
      return { kind: "LOCAL_WAITING", state, task, proposal, outcome, wake: wakeForTask(task, baseUtility), reason };
    }

    if (outcome?.failureClassification === "EXECUTION_REJECTED" || outcome?.failureClassification === "ADMISSION_REJECTED") {
      return { kind: "LOCAL_RECOVERABLE_FAILURE", state, task, proposal, outcome, wake: wakeForTask(task), reason };
    }

    return { kind: "LOCAL_SUCCESS", state, task, proposal, outcome, reason };
  }
}
