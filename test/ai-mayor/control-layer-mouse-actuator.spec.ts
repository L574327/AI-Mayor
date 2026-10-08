import {
  ActionSequenceExecutor,
  ControlLayerMouseActuator,
  V2CommandObservationEvidenceAdapter,
  createActionSequence,
  createActionSpec,
  type ActionEvidence,
  type NativeMouseCommand,
  type NativeMouseCommandResult,
  type V2MouseNativeCommandTransport,
} from "../../src/main/services/ai-mayor/v2/control-layer";

class FakeMouseTransport implements V2MouseNativeCommandTransport {
  calls: readonly NativeMouseCommand[][] = [];
  private nextId = 0;

  async execute(commands: readonly NativeMouseCommand[]): Promise<NativeMouseCommandResult> {
    this.calls = [...this.calls, [...commands]];
    this.nextId += 1;
    return {
      commandId: `native-mouse-${this.nextId}`,
      success: true,
      timestamp: "2026-01-01T00:00:00.000Z",
      evidence: { accepted: true, commandCount: commands.length },
    };
  }
}

class MemoryEvidenceRecorder {
  records: ActionEvidence[] = [];
  async record(evidence: ActionEvidence): Promise<void> { this.records.push(evidence); }
}

describe("ControlLayerMouseActuator", () => {
  test("executes Action through native command transport and preserves command evidence", async () => {
    const transport = new FakeMouseTransport();
    const actuator = new ControlLayerMouseActuator({
      transport,
      resolveDelta: (target) => ({ deltaX: target.x, deltaY: target.y }),
    });
    const recorder = new MemoryEvidenceRecorder();
    const context = await new ActionSequenceExecutor(actuator, recorder).run(createActionSequence({
      skillId: "mouse-adapter-test",
      actions: [createActionSpec({ type: "Click", parameters: { target: { x: 4, y: -2 } } })],
    }));

    expect(context.state).toBe("SUCCESS");
    expect(transport.calls[0]).toEqual([
      { command: "MOVE", args: ["4", "-2"] },
      { command: "LEFT_DOWN", args: [] },
      { command: "LEFT_UP", args: [] },
    ]);
    expect(recorder.records.find((entry) => entry.stateAfter === "WAITING_OBSERVATION")?.actuatorCommandIds).toEqual(["native-mouse-1"]);
  });

  test("implements button down/up and reset without touching CS2", async () => {
    const transport = new FakeMouseTransport();
    const actuator = new ControlLayerMouseActuator({ transport, resolveDelta: () => ({ deltaX: 0, deltaY: 0 }) });

    await actuator.buttonDown("Right");
    await actuator.buttonUp("Right");
    await actuator.reset();

    expect(transport.calls.map((commands) => commands.map((entry) => entry.command))).toEqual([
      ["RIGHT_DOWN"],
      ["RIGHT_UP"],
      ["LEFT_UP", "RIGHT_UP", "MIDDLE_UP"],
    ]);
  });

  test("maps actuator evidence through the existing V2 evidence shape", async () => {
    const transport = new FakeMouseTransport();
    const actuator = new ControlLayerMouseActuator({ transport, resolveDelta: () => ({ deltaX: 1, deltaY: 1 }) });
    const recorder = new MemoryEvidenceRecorder();
    const evidenceAdapter = new V2CommandObservationEvidenceAdapter();
    await new ActionSequenceExecutor(actuator, recorder).run(createActionSequence({
      skillId: "evidence-chain-test",
      actions: [createActionSpec({ type: "MoveCursor", parameters: { target: { x: 1, y: 1 } } })],
    }));

    const transition = recorder.records.find((entry) => entry.stateAfter === "WAITING_OBSERVATION");
    expect(transition).toBeDefined();
    const mapped = evidenceAdapter.toCommandObservationEvidence(transition!);
    expect(mapped.details).toMatchObject({ actuatorCommandIds: ["native-mouse-1"] });
  });
});
