import type { DurableGreenfieldUtilityKindState } from "./greenfield-utility-bootstrap";
import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB } from "../spatial/types";

export interface PhaseAUtilityExecutePortInput {
  scope: { projectId: string; trancheId: string; worldEpochId: string; generation: string; topologyRevision: string };
  utilityKind: "electricity" | "water" | "sewage";
  candidateId: string | null;
  candidateKind: "service-road" | "direct-cable" | "facility-access-road" | null;
  actionFingerprint: string;
  exactActions: unknown[];
  prefab: string | null;
}

export class PhaseAAcceptanceStopError extends Error {
  readonly input: PhaseAUtilityExecutePortInput;

  constructor(input: PhaseAUtilityExecutePortInput, message = "PHASE_A_ACCEPTANCE_STOP_BEFORE_DIRECT_CABLE") {
    super(message);
    this.name = "PhaseAAcceptanceStopError";
    this.input = input;
  }
}

export function interceptPhaseADirectCableExecution(input: PhaseAUtilityExecutePortInput): void {
  if (input.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) return;
  if (input.candidateKind !== "direct-cable" || !input.candidateId) {
    throw new PhaseAAcceptanceStopError(input, "PHASE_A_CABLE_CANDIDATE_IDENTITY_UNAVAILABLE");
  }
  throw new PhaseAAcceptanceStopError(input);
}

/** Acceptance-only gate used before a subsequent Utility invocation. */
export function shouldStopBeforeDirectCableExecution(
  utility: DurableGreenfieldUtilityKindState | null | undefined,
  unresolvedCommand = false,
): boolean {
  if (!utility || unresolvedCommand) return false;
  const serviceRoad = utility.candidateLedger.find((candidate) => candidate.kind === "service-road");
  const directCable = utility.candidateLedger.find((candidate) => candidate.kind === "direct-cable");
  const hasUnresolvedCandidate = utility.candidateLedger.some((candidate) =>
    candidate.ledgerState === "AUTHORIZED" || candidate.ledgerState === "SUBMITTED" ||
    candidate.ledgerState === "RECONCILING" || candidate.ledgerState === "UNKNOWN",
  );
  return !hasUnresolvedCandidate &&
    serviceRoad?.ledgerState === "OBSERVED_MATCH" &&
    serviceRoad.primitiveEffect === "OBSERVED_MATCH" &&
    utility.connectionObjective?.status === "INCOMPLETE" &&
    directCable?.ledgerState === "NOT_ATTEMPTED" &&
    directCable.commandId === null;
}
