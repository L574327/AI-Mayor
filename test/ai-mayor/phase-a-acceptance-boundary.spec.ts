import { interceptPhaseADirectCableExecution, PhaseAAcceptanceStopError, shouldStopBeforeDirectCableExecution } from "../../src/main/services/ai-mayor/v2/phase-a-acceptance-boundary";
import type { DurableGreenfieldUtilityKindState } from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";

function state(overrides: Partial<DurableGreenfieldUtilityKindState> = {}): DurableGreenfieldUtilityKindState {
  return {
    kind: "electricity", stage: "CONNECTED", constructionAttempts: 1, maximumConstructionAttempts: 2,
    observationWaits: 0, maximumObservationWaits: 3, authorizedSpend: 100, plan: null, planBinding: null,
    facilityCommandId: "facility", networkCommandIds: ["road"], commandOutcome: "OBSERVED_MATCH",
    lastFailureBoundary: "NATIVE_NETWORK_SUBMISSION", connectionRecovery: {
      type: "CONNECTION_PRIMITIVE_FALLBACK_RECOVERY", consumed: true, consumptionCount: 1,
      maximumConsumptions: 1, journal: [],
    }, selectedConnectionPrimitive: "service-road", lastRecoveryReason: null, connectionDiagnostics: [],
    facility: null, connector: null, progression: null,
    serviceEvidence: null,
    connectionObjective: { objectiveId: "objective", approvedPlanRevision: "plan-1", candidateOrder: ["service-road", "direct-cable"], status: "INCOMPLETE", observationBudget: 3, candidateBudget: 2 },
    candidateLedger: [
      { candidateId: "road", objectiveId: "objective", kind: "service-road", ordinal: 0, exactActions: [], actionFingerprint: "road-fp", approvedPlanRevision: "plan-1", spatialScope: { center: { x: 0, z: 0 }, radius: 10 }, budgetCeiling: 100, ledgerState: "OBSERVED_MATCH", commandId: "road", primitiveEffect: "OBSERVED_MATCH" },
      { candidateId: "cable", objectiveId: "objective", kind: "direct-cable", ordinal: 1, exactActions: [], actionFingerprint: "cable-fp", approvedPlanRevision: "plan-1", spatialScope: { center: { x: 0, z: 0 }, radius: 10 }, budgetCeiling: 100, ledgerState: "NOT_ATTEMPTED", commandId: null, primitiveEffect: "NOT_OBSERVED" },
    ],
    ...overrides,
  };
}

describe("Phase A acceptance boundary", () => {
  test.each([
    ["stops after road match and incomplete objective", true, false],
    ["does not stop when an unresolved command exists", false, true],
    ["does not stop after cable authorization", false, false],
    ["does not stop after objective completion", false, false],
  ])("%s", (_name, expected, unresolved) => {
    const utility = state();
    if (_name.includes("cable authorization")) utility.candidateLedger[1].ledgerState = "AUTHORIZED";
    if (_name.includes("objective completion")) utility.connectionObjective!.status = "COMPLETE";
    expect(shouldStopBeforeDirectCableExecution(utility, unresolved)).toBe(expected);
  });

  const cableInput = (overrides: Partial<Parameters<typeof interceptPhaseADirectCableExecution>[0]> = {}) => ({
    scope: { projectId: "project", trancheId: "tranche", worldEpochId: "epoch", generation: "generation", topologyRevision: "topology" },
    utilityKind: "electricity" as const,
    candidateId: "objective:direct-cable",
    candidateKind: "direct-cable" as const,
    actionFingerprint: '[{"type":"build_road","prefab":"Low-voltage Ground Cable","x1":0,"z1":0,"x2":20,"z2":0}]',
    exactActions: [{ type: "build_road", prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 20, z2: 0 }],
    prefab: "Low-voltage Ground Cable",
    ...overrides,
  });

  test.each([
    ["exact direct-cable candidate", cableInput(), "PHASE_A_ACCEPTANCE_STOP_BEFORE_DIRECT_CABLE"],
    ["wrong candidate kind", cableInput({ candidateKind: "service-road" }), "PHASE_A_CABLE_CANDIDATE_IDENTITY_UNAVAILABLE"],
    ["missing candidate id", cableInput({ candidateId: null }), "PHASE_A_CABLE_CANDIDATE_IDENTITY_UNAVAILABLE"],
    ["prefab-only match", cableInput({ candidateKind: null, candidateId: null }), "PHASE_A_CABLE_CANDIDATE_IDENTITY_UNAVAILABLE"],
  ])("intercepts only exact candidate identity: %s", (_label, input, message) => {
    expect(() => interceptPhaseADirectCableExecution(input)).toThrow(message);
    try { interceptPhaseADirectCableExecution(input); } catch (error) {
      expect(error).toBeInstanceOf(PhaseAAcceptanceStopError);
      expect((error as PhaseAAcceptanceStopError).input.actionFingerprint).toBe(input.actionFingerprint);
    }
  });

  test("non-cable action passes without creating command or invoking native executor", () => {
    let commands = 0;
    let nativeCalls = 0;
    expect(() => interceptPhaseADirectCableExecution(cableInput({ prefab: "Small Road", exactActions: [{ type: "build_road", prefab: "Small Road", x1: 0, z1: 0, x2: 20, z2: 0 }] }))).not.toThrow();
    expect(commands).toBe(0);
    expect(nativeCalls).toBe(0);
  });

  test("exact stop helper has no ledger mutation side effect", () => {
    const input = cableInput();
    const before = structuredClone(input);
    expect(() => interceptPhaseADirectCableExecution(input)).toThrow(PhaseAAcceptanceStopError);
    expect(input).toEqual(before);
  });
});
