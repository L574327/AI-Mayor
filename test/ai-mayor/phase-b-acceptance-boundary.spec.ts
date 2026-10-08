import {
  interceptPhaseBElectricityCertification,
  PhaseBElectricityAcceptanceStopError,
} from "../../src/main/services/ai-mayor/v2/phase-b-acceptance-boundary";
import { createDurableGreenfieldUtilityState, type DurableGreenfieldUtilityState } from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";

function state(overrides: Partial<DurableGreenfieldUtilityState["utilities"]["electricity"]> = {}): DurableGreenfieldUtilityState {
  const value = createDurableGreenfieldUtilityState({
    intentId: "intent:test", projectId: "project:test", trancheId: "tranche:test", reservationRef: "reservation:test",
    worldId: "world:test", worldEpochId: "epoch:test", generation: "generation:test", topologyRevision: "topology:test",
    certifiedRoadRefs: [{ index: 1, version: 1 }], targetServiceEntry: { road: { index: 1, version: 1 }, position: { x: 0, z: 0 } },
    spatialEnvelope: { center: { x: 0, z: 0 }, radius: 100 }, maximumSpend: 100, treasury: 100, treasurySafetyReserve: 0,
  });
  value.utilities.electricity = { ...value.utilities.electricity, stage: "SERVICE_CERTIFIED", connectionObjective: {
    objectiveId: "objective:test", approvedPlanRevision: "plan:test", candidateOrder: [], status: "COMPLETE",
    observationBudget: 3, candidateBudget: 2,
  }, ...overrides };
  return value;
}

describe("Phase B electricity-only acceptance boundary", () => {
  test("stops after durable electricity certification", () => {
    expect(() => interceptPhaseBElectricityCertification({ kind: "electricity", state: state() }))
      .toThrow(PhaseBElectricityAcceptanceStopError);
  });

  test("fails closed for incomplete or unresolved electricity state", () => {
    expect(() => interceptPhaseBElectricityCertification({ kind: "electricity", state: state({
      connectionObjective: { ...state().utilities.electricity.connectionObjective!, status: "INCOMPLETE" },
    }) })).toThrow("PHASE_B_CERTIFICATION_BOUNDARY_PRECONDITION_FAILED");
    expect(() => interceptPhaseBElectricityCertification({ kind: "electricity", state: state({
      candidateLedger: [{
        candidateId: "c", objectiveId: "o", kind: "direct-cable", ordinal: 0, exactActions: [], actionFingerprint: "f",
        approvedPlanRevision: "p", spatialScope: { center: { x: 0, z: 0 }, radius: 1 }, budgetCeiling: 1,
        ledgerState: "AUTHORIZED", commandId: "cmd", primitiveEffect: "NOT_OBSERVED",
      }],
    }) })).toThrow("PHASE_B_CERTIFICATION_BOUNDARY_PRECONDITION_FAILED");
  });

  test("is inert for non-electricity utility kinds", () => {
    expect(() => interceptPhaseBElectricityCertification({ kind: "water", state: state() })).not.toThrow();
  });
});
