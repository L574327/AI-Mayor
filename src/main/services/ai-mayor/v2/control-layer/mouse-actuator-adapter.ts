import type { IMouseActuator } from "./ports";
import { sendVirtualHidMouseCommands, type VirtualHidMouseCommand } from "../virtual-hid-mouse-adapter";
import type {
  ActuatorResult,
  ClickOptions,
  DragOptions,
  MouseButton,
  MoveOptions,
  Vector2D,
} from "./types";

export type ControlLayerMouseCommand = "MOVE" | "LEFT_DOWN" | "LEFT_UP" | "RIGHT_DOWN" | "RIGHT_UP" | "MIDDLE_DOWN" | "MIDDLE_UP";

export interface NativeMouseCommand {
  command: ControlLayerMouseCommand;
  args: string[];
}

export interface NativeMouseCommandResult {
  commandId?: string;
  success: boolean;
  timestamp?: string;
  evidence?: unknown;
  error?: string;
}

/**
 * Existing V2 mouse/native command boundary. The Control Layer does not know
 * how this transport reaches Mouse20 or the native executable.
 */
export interface V2MouseNativeCommandTransport {
  execute(commands: readonly NativeMouseCommand[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<NativeMouseCommandResult>;
}

export interface ControlLayerMouseActuatorOptions {
  transport: V2MouseNativeCommandTransport;
  /** Converts the Control Layer screen target to one native relative MOVE. */
  resolveDelta(target: Vector2D): Promise<{ deltaX: number; deltaY: number }> | { deltaX: number; deltaY: number };
  now?: () => Date;
  createCommandId?: () => string;
}

export function createVirtualHidMouseNativeCommandTransport(options: { executablePath?: string; timeoutMs?: number } = {}): V2MouseNativeCommandTransport {
  return {
    async execute(commands, executeOptions) {
      try {
        const evidence = await sendVirtualHidMouseCommands({
          commands: commands.map((entry) => ({ command: entry.command as VirtualHidMouseCommand, args: entry.args })),
          executablePath: options.executablePath,
          timeoutMs: executeOptions?.timeoutMs ?? options.timeoutMs,
          signal: executeOptions?.signal,
        });
        return { success: true, evidence };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const buttonCommands: Record<MouseButton, { down: ControlLayerMouseCommand; up: ControlLayerMouseCommand }> = {
  Left: { down: "LEFT_DOWN", up: "LEFT_UP" },
  Right: { down: "RIGHT_DOWN", up: "RIGHT_UP" },
  Middle: { down: "MIDDLE_DOWN", up: "MIDDLE_UP" },
};

function boundedDelta(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -127 || value > 127) {
    throw new Error(`${field} must be an integer in [-127, 127]`);
  }
  return value;
}

export class ControlLayerMouseActuator implements IMouseActuator {
  private readonly now: () => Date;
  private readonly createCommandId: () => string;

  constructor(private readonly options: ControlLayerMouseActuatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.createCommandId = options.createCommandId ?? (() => crypto.randomUUID());
  }

  async move(targetPosition: Vector2D, moveOptions: MoveOptions, signal?: AbortSignal): Promise<ActuatorResult> {
    const delta = await this.options.resolveDelta(targetPosition);
    const command: NativeMouseCommand = { command: "MOVE", args: [String(boundedDelta(delta.deltaX, "deltaX")), String(boundedDelta(delta.deltaY, "deltaY"))] };
    return this.execute("move", [command], moveOptions.durationMs, signal);
  }

  async buttonDown(button: MouseButton, signal?: AbortSignal): Promise<ActuatorResult> {
    return this.execute(`buttonDown:${button}`, [{ command: buttonCommands[button].down, args: [] }], undefined, signal);
  }

  async buttonUp(button: MouseButton, signal?: AbortSignal): Promise<ActuatorResult> {
    return this.execute(`buttonUp:${button}`, [{ command: buttonCommands[button].up, args: [] }], undefined, signal);
  }

  async click(targetPosition: Vector2D, button: MouseButton, clickOptions: ClickOptions, signal?: AbortSignal): Promise<ActuatorResult> {
    const delta = await this.options.resolveDelta(targetPosition);
    const commands: NativeMouseCommand[] = [];
    const boundedX = boundedDelta(delta.deltaX, "deltaX");
    const boundedY = boundedDelta(delta.deltaY, "deltaY");
    if (boundedX !== 0 || boundedY !== 0) commands.push({ command: "MOVE", args: [String(boundedX), String(boundedY)] });
    commands.push({ command: buttonCommands[button].down, args: [] });
    commands.push({ command: buttonCommands[button].up, args: [] });
    return this.execute(`click:${button}`, commands, clickOptions.holdMs, signal);
  }

  async drag(from: Vector2D, to: Vector2D, dragOptions: DragOptions, signal?: AbortSignal): Promise<ActuatorResult> {
    const start = await this.options.resolveDelta(from);
    const end = await this.options.resolveDelta(to);
    const commands: NativeMouseCommand[] = [
      { command: "MOVE", args: [String(boundedDelta(start.deltaX, "from.deltaX")), String(boundedDelta(start.deltaY, "from.deltaY"))] },
      { command: "LEFT_DOWN", args: [] },
      { command: "MOVE", args: [String(boundedDelta(end.deltaX, "to.deltaX")), String(boundedDelta(end.deltaY, "to.deltaY"))] },
      { command: "LEFT_UP", args: [] },
    ];
    return this.execute("drag", commands, dragOptions.durationMs, signal);
  }

  async scroll(_delta: number, _atPosition: Vector2D | null, _signal?: AbortSignal): Promise<ActuatorResult> {
    return {
      commandId: `control-layer-unsupported:${this.createCommandId()}`,
      timestamp: this.now().toISOString(),
      action: "scroll",
      success: false,
      error: "scroll-is-not-supported-by-the-existing-mouse-native-boundary",
    };
  }

  async reset(signal?: AbortSignal): Promise<ActuatorResult> {
    return this.execute("reset", [
      { command: "LEFT_UP", args: [] },
      { command: "RIGHT_UP", args: [] },
      { command: "MIDDLE_UP", args: [] },
    ], undefined, signal);
  }

  private async execute(action: string, commands: readonly NativeMouseCommand[], timeoutMs: number | undefined, signal?: AbortSignal): Promise<ActuatorResult> {
    const commandId = this.createCommandId();
    try {
      const result = await this.options.transport.execute(commands, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      return {
        commandId: result.commandId ?? commandId,
        timestamp: result.timestamp ?? this.now().toISOString(),
        action,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
        details: { nativeCommandId: result.commandId ?? null, commands, nativeEvidence: result.evidence },
      };
    } catch (error) {
      return {
        commandId,
        timestamp: this.now().toISOString(),
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        details: { commands },
      };
    }
  }
}
