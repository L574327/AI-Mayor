import { spawn } from "node:child_process";

export const VIRTUAL_HID_MOUSE_ADAPTER_SCHEMA_VERSION = "ai-mayor-v2-virtual-hid-mouse-adapter/1" as const;

export interface VirtualHidMouseClickInput {
  deltaX?: number;
  deltaY?: number;
  click?: boolean;
  timeoutMs?: number;
  executablePath?: string;
  signal?: AbortSignal;
}

export type VirtualHidMouseCommand = "MOVE" | "LEFT_DOWN" | "LEFT_UP" | "RIGHT_DOWN" | "RIGHT_UP" | "MIDDLE_DOWN" | "MIDDLE_UP";

export interface VirtualHidMouseCommandsInput {
  commands: Array<{ command: VirtualHidMouseCommand; args?: string[] }>;
  timeoutMs?: number;
  executablePath?: string;
  signal?: AbortSignal;
}

export interface VirtualHidMouseCommandEvidence {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface VirtualHidMouseClickEvidence {
  schemaVersion: typeof VIRTUAL_HID_MOUSE_ADAPTER_SCHEMA_VERSION;
  status: "SENT";
  adapter: "VirtualHidMouseCtl";
  executablePath: string;
  commands: VirtualHidMouseCommandEvidence[];
}

const DEFAULT_EXECUTABLE_PATH =
  "D:\\AI_Home\\VirtualHidMousePoC\\artifacts\\x64\\Release\\control\\VirtualHidMouseCtl.exe";

function finiteInt(value: number | undefined, field: string): number {
  const resolved = value ?? 0;
  if (!Number.isInteger(resolved) || resolved < -127 || resolved > 127) {
    throw new Error(`${field} must be an integer in [-127, 127]`);
  }
  return resolved;
}

function runCommand(
  executablePath: string,
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VirtualHidMouseCommandEvidence> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [command, ...args], { windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (value: VirtualHidMouseCommandEvidence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      child.kill();
      if (!settled) reject(new Error("virtual HID mouse command aborted"));
    };
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) reject(new Error(`virtual HID mouse command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1000);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
    child.on("exit", (exitCode, exitSignal) => {
      finish({ command, args, exitCode, signal: exitSignal, stderr });
    });
  });
}

/**
 * The only write boundary for the already-validated Virtual HID Mouse.
 * This adapter intentionally knows nothing about HID reports or the driver.
 */
export async function sendVirtualHidMouseClick(input: VirtualHidMouseClickInput = {}): Promise<VirtualHidMouseClickEvidence> {
  const deltaX = finiteInt(input.deltaX, "deltaX");
  const deltaY = finiteInt(input.deltaY, "deltaY");
  const timeoutMs = input.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("timeoutMs must be an integer in [100, 30000]");
  }
  const executablePath = input.executablePath ?? process.env.VIRTUAL_HID_MOUSE_CTL ?? DEFAULT_EXECUTABLE_PATH;
  const commands: Array<{ command: VirtualHidMouseCommand; args: string[] }> = [];
  if (deltaX !== 0 || deltaY !== 0) commands.push({ command: "MOVE", args: [String(deltaX), String(deltaY)] });
  if (input.click !== false) commands.push({ command: "LEFT_DOWN", args: [] }, { command: "LEFT_UP", args: [] });
  const result = await sendVirtualHidMouseCommands({ commands, timeoutMs, executablePath, signal: input.signal });
  return result;
}

/** Reuses the existing VirtualHidMouseCtl process boundary for compound actions. */
export async function sendVirtualHidMouseCommands(input: VirtualHidMouseCommandsInput): Promise<VirtualHidMouseClickEvidence> {
  const timeoutMs = input.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("timeoutMs must be an integer in [100, 30000]");
  }
  const executablePath = input.executablePath ?? process.env.VIRTUAL_HID_MOUSE_CTL ?? DEFAULT_EXECUTABLE_PATH;
  const commands: VirtualHidMouseCommandEvidence[] = [];
  for (const entry of input.commands) {
    commands.push(await runCommand(executablePath, entry.command, entry.args ?? [], timeoutMs, input.signal));
  }
  const failed = commands.find((command) => command.exitCode !== 0 || command.signal !== null);
  if (failed) throw new Error(`virtual HID mouse command failed: ${failed.command} ${failed.stderr}`.trim());
  return { schemaVersion: VIRTUAL_HID_MOUSE_ADAPTER_SCHEMA_VERSION, status: "SENT", adapter: "VirtualHidMouseCtl", executablePath, commands };
}
