/**
 * GAMEPLAY OBJECTIVE PROFILES — what result is worth pursuing, and what it may cost.
 *
 * One Mayor, one world reading, one set of execution primitives, one autonomous loop. A profile changes only the
 * answers to two questions: which outcome the cycle is chasing, and which costs it may accept. This file is the whole
 * seam; a profile is not a controller. Three modes (2026-10-04; the "all-out expansion" mode was removed):
 *  - FINANCIAL_RECOVERY, the fire-fighting mode (`finance-recovery.ts`): stop the bleeding, build nothing outward until it has;
 *  - AUTONOMOUS: the city may grow or shrink on its own; the Mayor keeps it running as it always did;
 *  - BALANCED, steady development: the pipelined district cycle (`growth-bottleneck.ts` picks which supply to stop adding, the game's
 *    own dry run gates each street, it ends at the player's target population) on top of the services every mode keeps clear.
 */
export const OBJECTIVE_PROFILES = ["FINANCIAL_RECOVERY", "AUTONOMOUS", "BALANCED"] as const;
export type ObjectiveProfile = (typeof OBJECTIVE_PROFILES)[number];
export const DEFAULT_OBJECTIVE_PROFILE: ObjectiveProfile = "AUTONOMOUS";

export function isObjectiveProfile(value: unknown): value is ObjectiveProfile {
  return typeof value === "string" && (OBJECTIVE_PROFILES as readonly string[]).includes(value);
}

/**
 * Whether the cycle may build outward (new districts, new streets, new land) under this profile. A recovering city
 * does not add road upkeep and fixed costs while it is still bleeding; every other profile builds as before.
 */
export function profileAllowsExpansion(profile: ObjectiveProfile, recovered: boolean): boolean {
  return profile === "FINANCIAL_RECOVERY" ? recovered : true;
}

/** Steady development builds through the pipelined district cycle; the other modes build as the Mayor always did. */
export function profileUsesPipeline(profile: ObjectiveProfile): boolean {
  return profile === "BALANCED";
}

/** A profile name from outside (environment, a saved setting): the removed all-out mode now means steady development. */
export function parseObjectiveProfile(value: unknown): ObjectiveProfile | null {
  if (value === "FAST_EXPANSION") return "BALANCED";
  return isObjectiveProfile(value) ? value : null;
}
