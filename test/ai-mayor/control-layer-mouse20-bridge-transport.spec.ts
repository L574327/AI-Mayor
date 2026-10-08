import { createMouse20BridgeTransport } from "../../src/main/services/ai-mayor/v2/control-layer/mouse20-bridge-transport";

describe("Mouse20 bridge transport", () => {
  test("maps move/click/reset commands to the Bridge and preserves evidence ids", async () => {
    const requests: string[] = [];
    let sequence = 0;
    const fetchImpl: typeof fetch = (async (input) => {
      requests.push(String(input));
      sequence += 1;
      return new Response(JSON.stringify({ ok: true, commandId: `bridge-${sequence}`, status: "MOUSE20_COMMAND_APPLIED" }), { status: 200 });
    }) as typeof fetch;

    const transport = createMouse20BridgeTransport({ leaseId: "bridge-lease", fetchImpl });
    const result = await transport.execute([
      { command: "MOVE", args: ["4", "-2"] },
      { command: "LEFT_DOWN", args: [] },
      { command: "LEFT_UP", args: [] },
    ]);

    expect(result.success).toBe(true);
    expect(result.commandId).toBe("bridge-3");
    expect(requests[0]).toContain("command=MOVE");
    expect(requests[0]).toContain("dx=4");
    expect(requests[0]).toContain("dy=-2");
    expect(requests[1]).toContain("command=BUTTON_DOWN");
    expect(requests[1]).toContain("button=Left");
    expect(requests[2]).toContain("command=BUTTON_UP");
    expect((result.evidence as { commandIds: string[] }).commandIds).toEqual(["bridge-1", "bridge-2", "bridge-3"]);
  });
});
