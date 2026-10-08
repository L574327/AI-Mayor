import { compileSkillIntent, createSkillRegistry } from "../../src/main/services/ai-mayor/skills";
import {
  K05CommissionUtilitiesDefinition as K05_COMMISSION_UTILITIES_DEFINITION,
  K05_COMMISSION_UTILITIES_MANIFEST,
} from "../../src/main/services/ai-mayor/skills/definitions/k05-commission-utilities";
import {
  K05CommissionUtilitiesWorkflowAdapter,
  SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION,
  classifySewageCommissioning,
  sewageEnvironmentalSafety,
} from "../../src/main/services/ai-mayor/skills/adapters/k05-commission-utilities-workflow";
import { ActionSequenceExecutor, type IMouseActuator, type EvidenceRecorder } from "../../src/main/services/ai-mayor/v2/control-layer";

describe("Skill Runtime K05 compile smoke", () => {
  it("discovers K05, validates its intent, and compiles an ActionSequence without execution", async () => {
    const registry = createSkillRegistry();
    const sequence = await compileSkillIntent(registry, { skillId: "skill.K05" });

    expect(registry.has("skill.K05")).toBe(true);
    expect(sequence.skillId).toBe("skill.K05");
    expect(sequence.actions).toHaveLength(1);
    expect(sequence.actions[0]).toMatchObject({
      actionId: "skill.K05.place-wind-turbine",
      type: "VerifyState",
    });
  });

  it("admits the compiled sequence through Executor.prepare without dispatching", async () => {
    const registry = createSkillRegistry();
    const sequence = await compileSkillIntent(registry, { skillId: "skill.K05" });
    const actuator = {} as IMouseActuator;
    const recorder = {} as EvidenceRecorder;
    const prepared = new ActionSequenceExecutor(actuator, recorder).prepare(sequence);

    expect(prepared.checkpoint).toBe("CONTROL_LAYER_ACCEPTED");
    expect(prepared.actionIds).toEqual(["skill.K05.place-wind-turbine"]);
    expect(sequence.actions[0].type).toBe("VerifyState");
  });
});

describe("K05 production contract matches the dispatching Brain", () => {
  const dispatch = () => ({
    skillId: "skill.K05",
    utilityKind: "sewage",
    capabilityId: "PLACE_FACILITY",
    strategyId: "INITIAL_FACILITY_PLACEMENT",
  });

  it("describes commissioning, not planning-only", () => {
    expect(K05_COMMISSION_UTILITIES_MANIFEST.description).not.toMatch(/planning-only|without executing construction/i);
    expect(K05_COMMISSION_UTILITIES_MANIFEST.description).toMatch(/commission/i);
    expect(K05_COMMISSION_UTILITIES_MANIFEST.metadata.execution).toBe("bounded-commissioning");
    expect(K05_COMMISSION_UTILITIES_MANIFEST.capabilities).toEqual(
      expect.arrayContaining(["utility-planning", "utility-execution"]),
    );
  });

  it("admit the exact fields the Brain dispatches, and no others", () => {
    const parsed = K05_COMMISSION_UTILITIES_DEFINITION.validateIntent(dispatch());
    expect(parsed).toMatchObject({ utilityKind: "sewage", strategyId: "INITIAL_FACILITY_PLACEMENT" });
    // A dispatch the contract does not describe is refused rather than asserted
    // past, which is what "validated" has to mean for it to mean anything.
    expect(() => K05_COMMISSION_UTILITIES_DEFINITION.validateIntent({ ...dispatch(), unreviewed: 1 })).toThrow();
    expect(() => K05_COMMISSION_UTILITIES_DEFINITION.validateIntent({ skillId: "skill.K04" })).toThrow();
    expect(() => K05_COMMISSION_UTILITIES_DEFINITION.validateIntent({ ...dispatch(), utilityKind: "garbage" })).toThrow();
  });

  it("still compiles the minimal intent the registry passes", async () => {
    const registry = createSkillRegistry();
    await expect(compileSkillIntent(registry, { skillId: "skill.K05" })).resolves.toMatchObject({ skillId: "skill.K05" });
  });
});


describe("K05 blocked semantics and the sewage environmental gate", () => {
  const unreachable = async () => { throw new Error("K05_FOUNDATION_MUST_NOT_BE_REACHED"); };
  const workflow = () => new K05CommissionUtilitiesWorkflowAdapter({
    greenfieldUtilityBootstrap: { run: unreachable, prepare: unreachable },
  } as never);

  it("refuses sewage with BLOCKED_TELEMETRY before the execution boundary is touched", async () => {
    const result = await workflow().executeProduction(
      { skillId: "skill.K05", utilityKind: "sewage", strategyId: "INITIAL_FACILITY_PLACEMENT" },
      {} as never,
    );
    // The foundation throws if it is reached, so a FAILED result carrying this
    // exact reason proves the gate fired first: nothing was read, planned or
    // placed, and no facility that merely fits was allowed to stand in for a
    // judgement that cannot be made.
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/^K05_BLOCKED_TELEMETRY:/);
    expect(result.error).toContain(SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
    expect(result.error).toContain("water-body flow/connectivity");
  });

  it("names the missing observation rather than withdrawing the capability", () => {
    const safety = sewageEnvironmentalSafety();
    expect(safety.certified).toBe(false);
    expect(safety.missingObservation).toBe(SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
    expect(SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION).toMatch(/^T20 /);
  });

  it("lifts the gate when the T20 observation exists, and keeps it down when it does not", async () => {
    // T20 exists: the gate no longer blocks on a missing observation. The
    // dispatch reaches the (unreachable) foundation, which is what proves it
    // passed — the judgement itself has moved to the per-site criterion.
    const withObservation = new K05CommissionUtilitiesWorkflowAdapter(
      { greenfieldUtilityBootstrap: { run: unreachable, prepare: unreachable } } as never,
      async () => ({ available: true, detail: "waterIntakes=0" }),
    );
    const lifted = await withObservation
      .executeProduction({ skillId: "skill.K05", utilityKind: "sewage", strategyId: "INITIAL_FACILITY_PLACEMENT" }, {} as never)
      .catch((error: unknown) => ({ error: String(error) }));
    expect(String(lifted.error ?? "")).not.toMatch(/BLOCKED_TELEMETRY/);

    // An unreadable half is still BLOCKED_TELEMETRY, and it names which half.
    const missingCensus = new K05CommissionUtilitiesWorkflowAdapter(
      { greenfieldUtilityBootstrap: { run: unreachable, prepare: unreachable } } as never,
      async () => ({ available: false, missingObservation: SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION,
        detail: "the authoritative water-intake listing was incomplete" }),
    );
    const blocked = await missingCensus.executeProduction(
      { skillId: "skill.K05", utilityKind: "sewage", strategyId: "INITIAL_FACILITY_PLACEMENT" }, {} as never,
    );
    expect(blocked.status).toBe("FAILED");
    expect(blocked.error).toMatch(/^K05_BLOCKED_TELEMETRY:/);
    expect(blocked.error).toContain(SEWAGE_ENVIRONMENTAL_SAFETY_MISSING_OBSERVATION);
  });

  it("classifies risk-changing, restore-as-is and undeclared sewage work apart", () => {
    // Risk-changing: an outfall appears, moves, or gains capacity.
    expect(classifySewageCommissioning("INITIAL_FACILITY_PLACEMENT")).toBe("RISK_CHANGING");
    expect(classifySewageCommissioning("FACILITY_REPLACEMENT_LAST_RESORT")).toBe("RISK_CHANGING");
    expect(classifySewageCommissioning("EXTEND_EXISTING_NETWORK")).toBe("RISK_CHANGING");
    // Restore-as-is: identity, site, path and capacity all left as found.
    expect(classifySewageCommissioning("REUSE_REACHABLE_NETWORK")).toBe("RESTORE_AS_IS");
    expect(classifySewageCommissioning("REPAIR_MISSING_FLOW_PATH")).toBe("RESTORE_AS_IS");
    expect(classifySewageCommissioning("RECONNECT_TARGET")).toBe("RESTORE_AS_IS");
    // A dispatch that does not say which it is fails closed.
    expect(classifySewageCommissioning(undefined)).toBe("UNPROVEN");
    expect(classifySewageCommissioning("SOMETHING_UNREVIEWED")).toBe("UNPROVEN");
  });

  it("holds a restore-as-is dispatch to no new certification, and blocks every other", async () => {
    const adapter = workflow();
    // The three restore strategies get past the telemetry gate — they fail
    // later, on the unreachable foundation, which is what proves they passed it.
    for (const strategyId of ["REUSE_REACHABLE_NETWORK", "REPAIR_MISSING_FLOW_PATH", "RECONNECT_TARGET"]) {
      const outcome = await adapter
        .executeProduction({ skillId: "skill.K05", utilityKind: "sewage", strategyId }, {} as never)
        .catch((error: unknown) => ({ error: String(error) }));
      expect(String(outcome.error ?? "")).not.toMatch(/BLOCKED_TELEMETRY/);
    }
    // Risk-changing and undeclared work is still held to the evidence.
    for (const strategyId of ["INITIAL_FACILITY_PLACEMENT", "EXTEND_EXISTING_NETWORK", undefined, "SOMETHING_UNREVIEWED"]) {
      const result = await adapter.executeProduction(
        { skillId: "skill.K05", utilityKind: "sewage", ...(strategyId ? { strategyId } : {}) }, {} as never,
      );
      expect(result.error).toMatch(/^K05_BLOCKED_TELEMETRY:/);
    }
  });

  it("is specific to sewage, and still validates intent first", async () => {
    const adapter = workflow();
    expect((await adapter.executeProduction({ skillId: "skill.K04" }, {} as never)).error)
      .toBe("K05_INTENT_INVALID");
    const electricity = await adapter
      .executeProduction({ skillId: "skill.K05", utilityKind: "electricity" }, {} as never)
      .catch((error: unknown) => ({ error: String(error) }));
    expect(String(electricity.error ?? "")).not.toMatch(/BLOCKED_TELEMETRY/);
  });
});

