import type { NativeMouseCommand, NativeMouseCommandResult, V2MouseNativeCommandTransport } from "./mouse-actuator-adapter";

export interface Mouse20BridgeTransportOptions {
  leaseId: string;
  bridgeUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type BridgeResponse = {
  commandId?: string;
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
};

function buttonFor(command: NativeMouseCommand["command"]): string | undefined {
  if (command.includes("LEFT")) return "Left";
  if (command.includes("RIGHT")) return "Right";
  if (command.includes("MIDDLE")) return "Middle";
  return undefined;
}

function bridgeCommandFor(command: NativeMouseCommand["command"]): "MOVE" | "BUTTON_DOWN" | "BUTTON_UP" | "RESET" {
  if (command === "MOVE" || command === "RESET") return command;
  return command.endsWith("_DOWN") ? "BUTTON_DOWN" : "BUTTON_UP";
}

export function createMouse20BridgeTransport(options: Mouse20BridgeTransportOptions): V2MouseNativeCommandTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bridgeUrl = options.bridgeUrl ?? "http://127.0.0.1:8642";
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async execute(commands, executeOptions): Promise<NativeMouseCommandResult> {
      const responses: BridgeResponse[] = [];
        const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), executeOptions?.timeoutMs ?? timeoutMs);
      const onAbort = () => controller.abort();
      executeOptions?.signal?.addEventListener("abort", onAbort, { once: true });
        try {
        for (const command of commands) {
          const query = new URLSearchParams({ command: bridgeCommandFor(command.command), leaseId: options.leaseId });
          if (command.command === "MOVE") {
            query.set("dx", command.args[0] ?? "0");
            query.set("dy", command.args[1] ?? "0");
          } else if (command.command !== "RESET") {
            query.set("button", buttonFor(command.command) ?? "");
          }
          const response = await fetchImpl(`${bridgeUrl}/input/mouse20/command?${query.toString()}`, {
            method: "POST",
            signal: controller.signal,
          });
          const payload = (await response.json()) as BridgeResponse;
          if (!response.ok || payload.ok === false || payload.error) {
            throw new Error(payload.error ?? `Mouse20 bridge returned HTTP ${response.status}`);
          }
          responses.push(payload);
        }
        return {
          success: true,
          commandId: responses[responses.length - 1]?.commandId,
          evidence: { transport: "bridge-mouse20", leaseId: options.leaseId, commandIds: responses.map((entry) => entry.commandId), responses },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), evidence: { transport: "bridge-mouse20", leaseId: options.leaseId, responses } };
      } finally {
        clearTimeout(timeout);
        executeOptions?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
