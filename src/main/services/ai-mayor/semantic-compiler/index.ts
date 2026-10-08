/**
 * AI Mayor Semantic Compiler V1 — deterministic typed core.
 *
 * Spec authority: docs/semantic-compiler/AI_MAYOR_SEMANTIC_COMPILER_V1_FREEZE_CANDIDATE.md
 * Falsification cases: docs/semantic-compiler/AI_MAYOR_SEMANTIC_COMPILER_V0_STRUCTURAL_RED_TEAM.md
 *
 * This module tree deliberately excludes any natural-language frontend, LLM call,
 * live game world or construction primitive. It lowers hand-authored MayorIntent into
 * a finite semantic artifact and evaluates candidates, gates and completion contracts
 * deterministically.
 */

export * from "./types";
export { compile } from "./compile";
export { applyUpdate, bindGates } from "./revision";
export { lowerRevision } from "./lowering";
export { admitCandidate } from "./admit";
export { aggregateMission, evaluateObligation } from "./completion";
export { evaluateProfileLiveness } from "./profile";
export { compare, evaluateGates, evaluatePredicate, findSample } from "./gates";
export {
  aspectValue,
  bindScope,
  cloneBoundScope,
  extentContains,
  extentMembers,
  intersectExtents,
  resolveSelector,
  subtractExtents,
  verifyScope,
} from "./scope";
export { composeEffects } from "./compose";
export { compareStrings, digest, sortedUnique, stableStringify, triAnd, triOr } from "./util";
