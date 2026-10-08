import { createActionSequence, createActionSpec } from "../../v2/control-layer/types";
import type { SkillAdapter, SkillAdapterContext, SkillIntent } from "./port";
import type { SkillManifest } from "../schemas/manifest";

/** K05 v0.1 emits one admitted building-placement intent and nothing else. */
export class CommissionUtilitiesAdapter implements SkillAdapter {
  readonly id = "commission-utilities";

  compile(intent: SkillIntent, manifest: SkillManifest, _context: SkillAdapterContext) {
    if (intent.skillId !== manifest.id) throw new Error(`Skill intent mismatch: ${intent.skillId}`);
    return createActionSequence({
      skillId: manifest.id,
      actions: [
        createActionSpec({
          actionId: "skill.K05.place-wind-turbine",
          type: "VerifyState",
          execution: { kind: "domain", adapterId: "commission-utilities.place_building" },
          parameters: {
            operation: "place_building",
            prefab: "WindTurbine",
            x: 0,
            z: 0,
            rotation: 0,
          },
          expectedEffect: {
            observationKey: "building.created",
            expectedValue: true,
            comparator: "equals",
          },
          timeoutMs: 3000,
          maxRetries: 0,
        }),
      ],
    });
  }
}
