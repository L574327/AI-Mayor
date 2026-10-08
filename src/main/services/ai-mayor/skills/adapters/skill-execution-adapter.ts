import type { MayorAction } from "../../types";
import type { PreparedActionSequence } from "../../v2/control-layer/executor";
import type { ActionSpec } from "../../v2/control-layer/types";

type K05PlacementParameters = {
  operation?: unknown;
  prefab?: unknown;
  x?: unknown;
  z?: unknown;
  rotation?: unknown;
};

const placementParameters = (action: ActionSpec): K05PlacementParameters => action.parameters as K05PlacementParameters;

/**
 * Converts an admitted Control Layer sequence into the domain action consumed
 * by the existing Mayor execution boundary. It deliberately has no MCP/native
 * transport dependency.
 */
export class SkillExecutionAdapter {
  convert(prepared: PreparedActionSequence): MayorAction[] {
    const { sequence } = prepared;
    if (sequence.skillId !== "skill.K05") throw new Error(`unsupported skill execution: ${sequence.skillId}`);
    if (sequence.actions.length !== 1) throw new Error("K05 execution requires exactly one action");

    return [this.convertAction(sequence.skillId, sequence.actions[0])];
  }

  convertAction(skillId: string, action: ActionSpec): MayorAction {
    if (skillId !== "skill.K05") throw new Error(`unsupported skill execution: ${skillId}`);
    const params = placementParameters(action);
    if (action.execution?.kind !== "domain" || action.execution.adapterId !== "commission-utilities.place_building" || params.operation !== "place_building") {
      throw new Error(`unsupported K05 action: ${action.actionId}`);
    }
    if (typeof params.prefab !== "string" || params.prefab.trim() === "") throw new Error("K05 building prefab is required");
    if (typeof params.x !== "number" || !Number.isFinite(params.x)) throw new Error("K05 building x is required");
    if (typeof params.z !== "number" || !Number.isFinite(params.z)) throw new Error("K05 building z is required");
    if (params.rotation !== undefined && (typeof params.rotation !== "number" || !Number.isFinite(params.rotation))) {
      throw new Error("K05 building rotation must be finite");
    }

    return {
      type: "place_building",
      prefab: params.prefab,
      x: params.x,
      z: params.z,
      ...(params.rotation === undefined ? {} : { rotation: params.rotation }),
    };
  }
}
