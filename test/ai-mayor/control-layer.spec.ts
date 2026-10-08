import {
  ActionSequenceExecutor,
  V2CommandObservationEvidenceAdapter,
  createActionSequence,
  createActionSpec,
  type ActionEvidence,
  type ActuatorResult,
  type IMouseActuator,
  type ObservationVerifier,
} from "../../src/main/services/ai-mayor/v2/control-layer";

class FakeMouseActuator implements IMouseActuator {
  calls: string[] = [];
  private counter = 0;

  private ok(action: string): Promise<ActuatorResult> {
    this.calls.push(action);
    this.counter += 1;
    return Promise.resolve({ commandId: `fake-${this.counter}`, timestamp: new Date().toISOString(), action, success: true });
  }

  move() { return this.ok("move"); }
  buttonDown() { return this.ok("buttonDown"); }
  buttonUp() { return this.ok("buttonUp"); }
  click() { return this.ok("click"); }
  drag() { return this.ok("drag"); }
  scroll() { return this.ok("scroll"); }
  reset() { return this.ok("reset"); }
}

class MemoryEvidenceRecorder {
  records: ActionEvidence[] = [];
  async record(evidence: ActionEvidence): Promise<void> { this.records.push(evidence); }
}

describe("AI Mayor V2 Control Layer", () => {
  test("runs a sequence and records FSM transitions", async () => {
    const actuator = new FakeMouseActuator();
    const recorder = new MemoryEvidenceRecorder();
    const executor = new ActionSequenceExecutor(actuator, recorder);
    const context = await executor.run(createActionSequence({
      skillId: "skill-test",
      actions: [createActionSpec({ type: "Click", parameters: { target: { x: 10, y: 20 } })],
    }));

    expect(context.state).toBe("SUCCESS");
    expect(actuator.calls).toEqual(["click"]);
    expect(recorder.records.some((entry) => entry.stateAfter === "WAITING_OBSERVATION")).toBe(true);
    expect(recorder.records.at(-1)?.stateAfter).toBe("SUCCESS");
  });

  test("uses bounded retries and resets the actuator on terminal failure", async () => {
    const actuator = new FakeMouseActuator();
    actuator.click = async () => ({ commandId: `failed-${actuator.calls.length}`, timestamp: new Date().toISOString(), action: "click", success: false, error: "native-failed" });
    const recorder = new MemoryEvidenceRecorder();
    const executor = new ActionSequenceExecutor(actuator, recorder);
    const context = await executor.run(createActionSequence({
      skillId: "skill-failure",
      actions: [createActionSpec({ type: "Click", maxRetries: 1, parameters: { target: { x: 1, y: 1 } } })],
    }));

    expect(context.state).toBe("FAILED");
    expect(recorder.records.some((entry) => entry.stateAfter === "RECOVERING")).toBe(true);
    expect(actuator.calls).toContain("reset");
  });

  test("maps action evidence to the existing CommandObservationEvidence shape", () => {
    const adapter = new V2CommandObservationEvidenceAdapter();
    const mapped = adapter.toCommandObservationEvidence({
      actionId: "action-1", skillId: "skill-1", sequenceId: "sequence-1", timestamp: "2026-01-01T00:00:00.000Z",
      stateBefore: "EXECUTING", stateAfter: "WAITING_OBSERVATION", observed: "actuator-ack", recoveryAttempts: [], finalStatus: "WAITING_OBSERVATION", actuatorCommandIds: ["cmd-1"],
    });
    expect(mapped.phase).toBe("RECONCILIATION");
    expect(mapped.details).toMatchObject({ actionId: "action-1", actuatorCommandIds: ["cmd-1"] });
  });
});
