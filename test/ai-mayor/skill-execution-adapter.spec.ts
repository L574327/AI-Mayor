import { compileSkillIntent, createSkillRegistry, executeSkillIntent, K05DomainDispatchAdapter, SkillExecutionAdapter } from "../../src/main/services/ai-mayor/skills";
import { ActionSequenceExecutor, type EvidenceRecorder, type IMouseActuator, type ObservationVerifier } from "../../src/main/services/ai-mayor/v2/control-layer";

describe("SkillExecutionAdapter", () => {
  it("converts an admitted K05 ActionSequence into MayorAction", async () => {
    const sequence = await compileSkillIntent(createSkillRegistry(), { skillId: "skill.K05" });
    const prepared = new ActionSequenceExecutor({} as IMouseActuator, {} as EvidenceRecorder).prepare(sequence);

    expect(new SkillExecutionAdapter().convert(prepared)).toEqual([{
      type: "place_building",
      prefab: "WindTurbine",
      x: 0,
      z: 0,
      rotation: 0,
    }]);
  });

  it("runs K05 through the Control Layer FSM and domain dispatch port in dry-run", async () => {
    const nativeActions: unknown[] = [];
    const evidence: Array<Awaited<ReturnType<typeof Promise.resolve>>> = [];
    const nativePort = {
      async execute(actions: readonly unknown[]) {
        nativeActions.push(actions);
        return { success: true, commandId: "dry-run-k05-1", details: { entity: { index: 1, version: 1 } } };
      },
    };
    const verifier: ObservationVerifier = {
      async observe() { return true; },
      matches(expected, observed) { return expected?.expectedValue === observed; },
    };
    const recorder: EvidenceRecorder = {
      async record(item) { evidence.push(item); },
    };
    const executor = new ActionSequenceExecutor(
      {} as IMouseActuator,
      recorder,
      verifier,
      undefined,
      new K05DomainDispatchAdapter(nativePort),
    );

    const result = await executeSkillIntent({
      registry: createSkillRegistry(),
      executor,
      intent: { skillId: "skill.K05" },
      evidence: { entries: evidence as never[] },
    });

    expect(result.status).toBe("SUCCESS");
    expect(result.context.state).toBe("SUCCESS");
    expect(nativeActions).toEqual([[{
      type: "place_building",
      prefab: "WindTurbine",
      x: 0,
      z: 0,
      rotation: 0,
    }]]);
    expect(evidence.some((item) => item.stateAfter === "VERIFYING")).toBe(true);
  });
});
