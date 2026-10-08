import type {
  ActionEvidence,
  ActionResult,
  ActionSequence,
  ActionSpec,
  ActuatorResult,
  ExecutionContext,
  ExecutionState,
  MouseButton,
  Vector2D,
} from "./types";
import {
  DefaultRetryRecoveryPolicy,
  NullObservationVerifier,
  type EvidenceRecorder,
  type IMouseActuator,
  type DomainDispatchPort,
  type ObservationVerifier,
  type RecoveryPolicy,
} from "./ports";

export interface PreparedActionSequence {
  readonly sequence: ActionSequence;
  readonly checkpoint: "CONTROL_LAYER_ACCEPTED";
  readonly actionIds: readonly string[];
}

const ACTION_TYPES = new Set<ActionSpec["type"]>([
  "SelectTool", "MoveCamera", "MoveCursor", "Click", "Drag", "Scroll", "Wait", "VerifyState",
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const vector = (value: unknown, field: string): Vector2D => {
  const candidate = asRecord(value);
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") throw new Error(`missing vector parameter: ${field}`);
  return { x: candidate.x, y: candidate.y };
};

const button = (value: unknown): MouseButton => value === "Right" || value === "Middle" ? value : "Left";

export class ActionSequenceExecutor {
  private contextValue: ExecutionContext | null = null;

  constructor(
    private readonly mouseActuator: IMouseActuator,
    private readonly evidenceRecorder: EvidenceRecorder,
    private readonly verifier: ObservationVerifier = new NullObservationVerifier(),
    private readonly recoveryPolicy: RecoveryPolicy = new DefaultRetryRecoveryPolicy(),
    private readonly domainDispatchPort?: DomainDispatchPort,
  ) {}

  get context(): ExecutionContext | null {
    return this.contextValue ? { ...this.contextValue } : null;
  }

  /** Non-executing admission check for runtime integrations and smoke tests. */
  prepare(sequence: ActionSequence): PreparedActionSequence {
    if (!sequence || typeof sequence.skillId !== "string" || sequence.skillId.trim() === "") {
      throw new Error("control-layer sequence requires a skillId");
    }
    if (!sequence.sequenceId || !Array.isArray(sequence.actions) || sequence.actions.length === 0) {
      throw new Error("control-layer sequence requires at least one action");
    }
    for (const action of sequence.actions) {
      if (!action.actionId || !ACTION_TYPES.has(action.type)) throw new Error(`unsupported control-layer action: ${String(action.type)}`);
      if (!Number.isFinite(action.timeoutMs) || action.timeoutMs < 0) throw new Error(`invalid action timeout: ${action.actionId}`);
      if (!Number.isInteger(action.maxRetries) || action.maxRetries < 0) throw new Error(`invalid action retries: ${action.actionId}`);
    }
    return Object.freeze({
      sequence,
      checkpoint: "CONTROL_LAYER_ACCEPTED" as const,
      actionIds: Object.freeze(sequence.actions.map((action) => action.actionId)),
    });
  }

  async run(sequence: ActionSequence, signal?: AbortSignal): Promise<ExecutionContext> {
    this.contextValue = {
      skillId: sequence.skillId,
      sequenceId: sequence.sequenceId,
      currentActionIndex: 0,
      currentActionId: null,
      state: "IDLE",
      recoveryAttemptsForCurrentAction: 0,
      startedAt: new Date().toISOString(),
      lastError: null,
    };

    await this.transition("PREPARING", sequence, null, "sequence-received");
    await this.transition("EXECUTING", sequence, null, "preparation-skipped-in-skeleton");

    while (this.contextValue.currentActionIndex < sequence.actions.length) {
      this.throwIfAborted(signal);
      const action = sequence.actions[this.contextValue.currentActionIndex];
      this.contextValue.currentActionId = action.actionId;
      this.contextValue.recoveryAttemptsForCurrentAction = 0;
      const result = await this.executeActionWithRecovery(sequence, action, signal);
      if (!result.success) {
        this.contextValue.lastError = result.error ?? "control-layer-action-failed";
        try { await this.mouseActuator.reset(signal); } catch { /* preserve the original action failure */ }
        await this.transition("FAILED", sequence, action, result.error ?? "control-layer-action-failed", result.actuatorResult);
        return { ...this.contextValue };
      }
      this.contextValue.currentActionIndex += 1;
    }

    await this.transition("SUCCESS", sequence, null, "all-actions-completed");
    return { ...this.contextValue };
  }

  private async executeActionWithRecovery(sequence: ActionSequence, action: ActionSpec, signal?: AbortSignal): Promise<ActionResult & { actuatorResult?: ActuatorResult }> {
    while (true) {
      this.throwIfAborted(signal);
      await this.transition("EXECUTING", sequence, action, `dispatch-attempt-${this.contextValue?.recoveryAttemptsForCurrentAction ?? 0}`);
      let actuatorResult: ActuatorResult;
      try {
        actuatorResult = await this.dispatch(action, signal);
      } catch (error) {
        actuatorResult = { commandId: `control-layer-error:${crypto.randomUUID()}`, timestamp: new Date().toISOString(), action: action.type, success: false, error: error instanceof Error ? error.message : String(error) };
      }
      await this.transition("WAITING_OBSERVATION", sequence, action, actuatorResult.success ? "actuator-ack" : `actuator-error:${actuatorResult.error ?? "unknown"}`, actuatorResult);
      if (!actuatorResult.success) {
        if (await this.tryRecover(sequence, action, actuatorResult.error ?? "actuator-failed", signal)) continue;
        return { actionId: action.actionId, success: false, error: actuatorResult.error ?? "actuator-failed", actuatorCommandIds: [actuatorResult.commandId], actuatorResult };
      }

      const observed = await this.verifier.observe(action, signal);
      await this.transition("VERIFYING", sequence, action, observed, actuatorResult);
      if (this.verifier.matches(action.expectedEffect, observed)) {
        return { actionId: action.actionId, success: true, observedValue: observed, actuatorCommandIds: [actuatorResult.commandId], actuatorResult };
      }
      if (await this.tryRecover(sequence, action, `expectation-not-met:${String(observed)}`, signal)) continue;
      return { actionId: action.actionId, success: false, observedValue: observed, error: "max-retries-exceeded", actuatorCommandIds: [actuatorResult.commandId], actuatorResult };
    }
  }

  private async dispatch(action: ActionSpec, signal?: AbortSignal): Promise<ActuatorResult> {
    if (action.execution?.kind === "domain") {
      if (!this.domainDispatchPort?.canHandle(action)) {
        throw new Error(`no domain dispatch handler: ${action.execution.adapterId ?? "unknown"}`);
      }
      return this.domainDispatchPort.dispatch(action, signal);
    }
    const params = action.parameters;
    switch (action.type) {
      case "MoveCursor":
      case "MoveCamera":
        return this.mouseActuator.move(vector(params.target, "target"), asRecord(params.options) as { durationMs?: number }, signal);
      case "SelectTool":
      case "Click":
        return this.mouseActuator.click(vector(params.target, "target"), button(params.button), asRecord(params.options) as { holdMs?: number }, signal);
      case "Drag":
        return this.mouseActuator.drag(vector(params.from, "from"), vector(params.to, "to"), asRecord(params.options) as { durationMs?: number }, signal);
      case "Scroll":
        return this.mouseActuator.scroll(typeof params.delta === "number" ? params.delta : 0, params.at === undefined ? null : vector(params.at, "at"), signal);
      case "Wait":
      case "VerifyState":
        return { commandId: `control-layer-noop:${crypto.randomUUID()}`, timestamp: new Date().toISOString(), action: action.type, success: true };
    }
  }

  private async tryRecover(sequence: ActionSequence, action: ActionSpec, reason: string, signal?: AbortSignal): Promise<boolean> {
    const context = this.requireContext();
    context.recoveryAttemptsForCurrentAction += 1;
    const attempt = context.recoveryAttemptsForCurrentAction;
    if (attempt > action.maxRetries) {
      await this.transition("RECOVERING", sequence, action, `gave-up-after-${attempt - 1}-attempts:${reason}`);
      return false;
    }
    const strategy = this.recoveryPolicy.decide(action, attempt, reason);
    await this.transition("RECOVERING", sequence, action, `attempt-${attempt}:${strategy.name}:${reason}`);
    if (strategy.delayMs > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, strategy.delayMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    });
    return true;
  }

  private async transition(state: ExecutionState, sequence: ActionSequence, action: ActionSpec | null, observed: unknown, actuatorResult?: ActuatorResult): Promise<void> {
    const context = this.requireContext();
    const before = context.state;
    context.state = state;
    const evidence: ActionEvidence = {
      actionId: action?.actionId ?? null,
      skillId: sequence.skillId,
      sequenceId: sequence.sequenceId,
      timestamp: new Date().toISOString(),
      stateBefore: before,
      stateAfter: state,
      expected: action?.expectedEffect,
      observed,
      recoveryAttempts: [],
      finalStatus: state,
      actuatorCommandIds: actuatorResult?.commandId ? [actuatorResult.commandId] : [],
      ...(state === "FAILED" ? { error: String(observed) } : {}),
    };
    await this.evidenceRecorder.record(evidence);
  }

  private requireContext(): ExecutionContext {
    if (!this.contextValue) throw new Error("control-layer execution context is not initialized");
    return this.contextValue;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new Error("control-layer execution aborted");
  }
}
