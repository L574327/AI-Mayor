import type { ActionEvidence, ExecutionContext } from "../../v2/control-layer/types";
import type { DurableGreenfieldUtilityState } from "../../v2/greenfield-utility-bootstrap";

export interface SkillResult {
  skillId: string;
  sequenceId: string;
  status: "SUCCESS" | "FAILED" | "WAITING" | "UNKNOWN";
  /**
   * What a successful result is allowed to claim, when the ordinary reading
   * would overstate it.
   *
   * A Skill that restored a service it did not newly authorize must not have
   * its success read as the stronger verdict. Absent means the ordinary
   * meaning; this is a qualifier on an existing result, not a new lifecycle.
   */
  successSemantics?: "EXISTING_SERVICE_RESTORED";
  error?: string;
  context?: ExecutionContext;
  evidence: readonly ActionEvidence[];
  durableOutcome?: {
    serviceCertified: boolean;
    waiting: boolean;
    reason: string;
    state: DurableGreenfieldUtilityState;
  };
}
