export type ActionType =
  | "SelectTool"
  | "MoveCamera"
  | "MoveCursor"
  | "Click"
  | "Drag"
  | "Scroll"
  | "Wait"
  | "VerifyState";

export type MouseButton = "Left" | "Right" | "Middle";

export interface Vector2D {
  x: number;
  y: number;
}

export interface MoveOptions {
  durationMs?: number;
}

export interface ClickOptions {
  holdMs?: number;
}

export interface DragOptions {
  durationMs?: number;
}

export interface ExpectedEffect {
  observationKey: string;
  expectedValue: unknown;
  comparator?: "equals" | "changed" | "withinRange" | string;
}

export interface ActionSpec {
  actionId: string;
  type: ActionType;
  parameters: Record<string, unknown>;
  expectedEffect?: ExpectedEffect;
  timeoutMs: number;
  maxRetries: number;
  execution?: {
    kind: "primitive" | "domain";
    adapterId?: string;
  };
}

export function createActionSpec(input: Partial<Omit<ActionSpec, "actionId">> & { type: ActionType; actionId?: string }): ActionSpec {
  return {
    actionId: input.actionId ?? crypto.randomUUID(),
    type: input.type,
    parameters: input.parameters ?? {},
    expectedEffect: input.expectedEffect,
    timeoutMs: input.timeoutMs ?? 3000,
    maxRetries: input.maxRetries ?? 2,
    execution: input.execution,
  };
}

export interface ActionSequence {
  sequenceId: string;
  skillId: string;
  actions: readonly ActionSpec[];
  createdAt: string;
}

export function createActionSequence(input: Partial<Omit<ActionSequence, "sequenceId" | "createdAt">> & { skillId: string; sequenceId?: string; createdAt?: string }): ActionSequence {
  return {
    sequenceId: input.sequenceId ?? crypto.randomUUID(),
    skillId: input.skillId,
    actions: input.actions ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export type ExecutionState =
  | "IDLE"
  | "PREPARING"
  | "EXECUTING"
  | "WAITING_OBSERVATION"
  | "VERIFYING"
  | "RECOVERING"
  | "SUCCESS"
  | "FAILED";

export interface ExecutionContext {
  skillId: string;
  sequenceId: string;
  currentActionIndex: number;
  currentActionId: string | null;
  state: ExecutionState;
  recoveryAttemptsForCurrentAction: number;
  startedAt: string;
  lastError: string | null;
}

export interface ActuatorResult {
  commandId: string;
  timestamp: string;
  action: string;
  success: boolean;
  error?: string;
  details?: unknown;
}

export interface ActionResult {
  actionId: string;
  success: boolean;
  observedValue?: unknown;
  error?: string;
  actuatorCommandIds: string[];
}

export interface RecoveryAttemptRecord {
  attemptIndex: number;
  reason: string;
  strategy: string;
  result: boolean;
  timestamp: string;
}

export interface ActionEvidence {
  actionId: string | null;
  skillId: string;
  sequenceId: string;
  timestamp: string;
  stateBefore: ExecutionState;
  stateAfter: ExecutionState;
  expected?: ExpectedEffect;
  observed: unknown;
  recoveryAttempts: RecoveryAttemptRecord[];
  finalStatus: ExecutionState;
  actuatorCommandIds: string[];
  error?: string;
}
