import type { DurableGreenfieldUtilityState, GreenfieldUtilityKind } from "./greenfield-utility-bootstrap";

export interface PhaseBElectricityCertificationInput {
  kind: GreenfieldUtilityKind;
  state: DurableGreenfieldUtilityState;
}

/**
 * Acceptance-only stop.  This is deliberately a typed control event, not a
 * production Utility state transition: the coordinator has already durably
 * recorded certification when this callback is invoked.
 */
export class PhaseBElectricityAcceptanceStopError extends Error {
  readonly input: PhaseBElectricityCertificationInput;

  constructor(input: PhaseBElectricityCertificationInput) {
    super("PHASE_B_ELECTRICITY_ACCEPTANCE_STOP_BEFORE_WATER");
    this.name = "PhaseBElectricityAcceptanceStopError";
    this.input = input;
  }
}

export function interceptPhaseBElectricityCertification(
  input: PhaseBElectricityCertificationInput,
): void {
  if (input.kind !== "electricity") return;
  const utility = input.state.utilities.electricity;
  const unresolved = utility.candidateLedger.some((candidate) =>
    candidate.ledgerState === "AUTHORIZED" || candidate.ledgerState === "SUBMITTED" ||
    candidate.ledgerState === "RECONCILING" || candidate.ledgerState === "UNKNOWN",
  );
  if (utility.stage !== "SERVICE_CERTIFIED" ||
    utility.connectionObjective?.status !== "COMPLETE" || unresolved ||
    utility.commandOutcome === "SUBMITTED" || utility.commandOutcome === "UNKNOWN") {
    throw new Error("PHASE_B_CERTIFICATION_BOUNDARY_PRECONDITION_FAILED");
  }
  throw new PhaseBElectricityAcceptanceStopError(input);
}
