import type { ActionSpec, ActuatorResult } from "../../v2/control-layer/types";
import type { DomainDispatchPort, MayorActionExecutionPort } from "../../v2/control-layer/ports";
import { SkillExecutionAdapter } from "./skill-execution-adapter";

export class K05DomainDispatchAdapter implements DomainDispatchPort {
  constructor(
    private readonly nativePort: MayorActionExecutionPort,
    private readonly actionAdapter = new SkillExecutionAdapter(),
  ) {}

  canHandle(action: ActionSpec): boolean {
    return action.execution?.kind === "domain" && action.execution.adapterId === "commission-utilities.place_building";
  }

  async dispatch(action: ActionSpec, signal?: AbortSignal): Promise<ActuatorResult> {
    if (!this.canHandle(action)) throw new Error(`unsupported K05 domain action: ${action.actionId}`);
    const mayorActions = [this.actionAdapter.convertAction("skill.K05", action)];
    const result = await this.nativePort.execute(mayorActions, signal);
    return {
      commandId: result.commandId ?? `k05-domain:${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      action: "place_building",
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      ...(result.details === undefined ? {} : { details: result.details }),
    };
  }
}
