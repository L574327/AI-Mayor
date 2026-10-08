import type { ActionSequence } from "../../v2/control-layer/types";
import type { SkillManifest } from "../schemas/manifest";

export interface SkillAdapterContext {
  readonly signal?: AbortSignal;
  readonly observation: unknown;
}

export interface SkillIntent {
  readonly skillId: string;
}

/** Adapter port owned by the runtime; concrete Skills implement this elsewhere. */
export interface SkillAdapter {
  readonly id: string;
  compile(intent: SkillIntent, manifest: SkillManifest, context: SkillAdapterContext): ActionSequence | Promise<ActionSequence>;
}
