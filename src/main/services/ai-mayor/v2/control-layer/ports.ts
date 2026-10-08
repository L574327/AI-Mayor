import type {
  ActionEvidence,
  ActionSpec,
  ActuatorResult,
  ClickOptions,
  ExpectedEffect,
  MouseButton,
  MoveOptions,
  DragOptions,
  Vector2D,
} from "./types";
import type { MayorAction } from "../../types";

export interface IMouseActuator {
  move(targetPosition: Vector2D, options: MoveOptions, signal?: AbortSignal): Promise<ActuatorResult>;
  buttonDown(button: MouseButton, signal?: AbortSignal): Promise<ActuatorResult>;
  buttonUp(button: MouseButton, signal?: AbortSignal): Promise<ActuatorResult>;
  click(targetPosition: Vector2D, button: MouseButton, options: ClickOptions, signal?: AbortSignal): Promise<ActuatorResult>;
  drag(from: Vector2D, to: Vector2D, options: DragOptions, signal?: AbortSignal): Promise<ActuatorResult>;
  scroll(delta: number, atPosition: Vector2D | null, signal?: AbortSignal): Promise<ActuatorResult>;
  reset(signal?: AbortSignal): Promise<ActuatorResult>;
}

export interface DomainDispatchPort {
  canHandle(action: ActionSpec): boolean;
  dispatch(action: ActionSpec, signal?: AbortSignal): Promise<ActuatorResult>;
}

export interface MayorActionExecutionPort {
  execute(actions: readonly MayorAction[], signal?: AbortSignal): Promise<{
    success: boolean;
    commandId?: string;
    details?: unknown;
    error?: string;
  }>;
}

export interface EvidenceRecorder {
  record(evidence: ActionEvidence): Promise<void>;
}

export interface ObservationVerifier {
  observe(action: ActionSpec, signal?: AbortSignal): Promise<unknown>;
  matches(expected: ExpectedEffect | undefined, observed: unknown): boolean;
}

export interface RecoveryStrategy {
  name: string;
  delayMs: number;
}

export interface RecoveryPolicy {
  decide(action: ActionSpec, attemptIndex: number, reason: string): RecoveryStrategy;
}

export class DefaultRetryRecoveryPolicy implements RecoveryPolicy {
  decide(_action: ActionSpec, attemptIndex: number, _reason: string): RecoveryStrategy {
    return { name: "RetrySameAction", delayMs: 200 * attemptIndex };
  }
}

export class NullObservationVerifier implements ObservationVerifier {
  async observe(_action: ActionSpec, _signal?: AbortSignal): Promise<unknown> {
    return "unobserved-control-layer-default";
  }

  matches(expected: ExpectedEffect | undefined, _observed: unknown): boolean {
    return expected === undefined;
  }
}
