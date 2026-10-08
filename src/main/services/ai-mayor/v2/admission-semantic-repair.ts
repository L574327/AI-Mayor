import type { SpatialPoint2 } from "../spatial/types";
import type { Gate1State } from "./gate1";
import type { V2AdmissionSemanticRepairRecord, V2SupersededProjectRecord } from "./durability";

/**
 * The one admission-semantics revision this repair is keyed by.
 *
 * Named the way the repository already names a mechanism revision
 * (`EXECUTION_MECHANISM_REVISION` = `localconnect-membership-production-v2`):
 * `<subject>-<scope>-v<ordinal>`. It is a durable constant, not a runtime value,
 * and it must be bumped whenever the admission semantics it describes change —
 * because the revision IS the repair's identity key, and two different semantics
 * sharing one revision would let a second repair reuse the first one's identity.
 *
 * What this revision asserts: water admission now requires the game's own verdict
 * on a real `GroundwaterPumpingStation01` placement to participate in bounded
 * site selection. A reservation whose only evidence is a terrain read can no
 * longer be admitted, because a terrain read that says "clean groundwater, owned,
 * flat" is not the game saying the station fits there.
 */
export const ADMISSION_SEMANTICS_REVISION = "water-native-placeability-admission-v1";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The deterministic identity of a repair.
 *
 * Derived from the ROOT project and the semantics revision, and from nothing
 * else. Deliberately not a timestamp, not randomness, and not a repair ordinal:
 * a counter would let a caller keep minting identities by incrementing it, which
 * is exactly the unbounded re-admission the first project's stable identity
 * exists to prevent. With this key, `(root, revision)` names at most one repair
 * forever, so a repeat activate, restart or resume reproduces the same repair
 * rather than buying another one — and a repair that itself fails cannot be
 * retried by minting `repair2`.
 *
 * The root is used rather than the currently durable project because the durable
 * slot changes hands: the project a repair replaces is already the root's
 * replacement, and keying on that would mint a fresh identity every time the
 * lineage moved.
 */
export function deriveAdmissionSemanticRepairId(input: {
  rootProjectId: string;
  semanticsRevision: string;
}): string {
  if (!nonEmpty(input.rootProjectId)) throw new Error("ADMISSION_SEMANTIC_REPAIR_ROOT_PROJECT_MISSING");
  if (!nonEmpty(input.semanticsRevision)) throw new Error("ADMISSION_SEMANTIC_REPAIR_REVISION_MISSING");
  return `${input.rootProjectId}:admission-semantic-repair:${input.semanticsRevision}`;
}

/**
 * The deterministic intent id the repair project is admitted under.
 *
 * Same discipline as {@link deriveAdmissionSemanticRepairId}: derived from the
 * root's intent and the revision, so the same repair always admits the same
 * project and a repair cannot be minted for a root that was never repaired.
 */
export function deriveAdmissionSemanticRepairIntentId(input: {
  rootIntentId: string;
  semanticsRevision: string;
}): string {
  if (!nonEmpty(input.rootIntentId)) throw new Error("ADMISSION_SEMANTIC_REPAIR_ROOT_INTENT_MISSING");
  if (!nonEmpty(input.semanticsRevision)) throw new Error("ADMISSION_SEMANTIC_REPAIR_REVISION_MISSING");
  return `${input.rootIntentId}:admission-semantic-repair:${input.semanticsRevision}`;
}

/**
 * The root of the admission lineage a project belongs to.
 *
 * Walks the two append-only relationship records — ordinary supersessions and
 * semantic repairs — backwards from the currently durable project until nothing
 * points at it. Both are consulted because a repair may itself be replaced
 * later, and a root that stopped at the first hop would let each hand-off start
 * a fresh repair chain under a fresh key.
 *
 * A cycle, or a project claimed as the replacement of two different things, is
 * refused rather than resolved: either would mean the lineage is not a chain,
 * and every identity derived from it would be a guess.
 */
export function resolveAdmissionLineageRoot(input: {
  currentProjectId: string;
  supersessions: readonly V2SupersededProjectRecord[];
  repairs: readonly V2AdmissionSemanticRepairRecord[];
}): string {
  if (!nonEmpty(input.currentProjectId)) throw new Error("ADMISSION_SEMANTIC_REPAIR_CURRENT_PROJECT_MISSING");
  const viaSupersession = new Map<string, string>();
  for (const entry of input.supersessions) {
    if (entry.replacementProjectId === null) continue;
    viaSupersession.set(entry.replacementProjectId, entry.projectId);
  }
  const viaRepair = new Map<string, string>();
  for (const entry of input.repairs) {
    if (entry.repairProjectId === null) continue;
    viaRepair.set(entry.repairProjectId, entry.rootProjectId);
  }
  const visited = new Set<string>();
  let current = input.currentProjectId;
  for (;;) {
    if (visited.has(current)) throw new Error("ADMISSION_SEMANTIC_REPAIR_LINEAGE_CYCLE");
    visited.add(current);
    const supersededBy = viaSupersession.get(current);
    const repairedFrom = viaRepair.get(current);
    if (supersededBy !== undefined && repairedFrom !== undefined && supersededBy !== repairedFrom) {
      throw new Error("ADMISSION_SEMANTIC_REPAIR_LINEAGE_AMBIGUOUS");
    }
    const previous = supersededBy ?? repairedFrom;
    if (previous === undefined) return current;
    current = previous;
  }
}

/**
 * What an authoritative production replay observed, when it was asked whether an
 * already-durable project's admission still holds under the current semantics.
 *
 * Both halves are required, and they are not symmetric. A contradiction — the
 * old project judged valid, or the new plan missing any one of its verdicts — is
 * a refusal, never a repair: repairing a project that is still serviceable would
 * spend the one identity a `(root, revision)` pair has on nothing, and repairing
 * on partial evidence would mint a project whose site nobody proved.
 */
export interface AdmissionSemanticsReplayEvidence {
  /** The revision the replay was run under; must match the repair's own. */
  semanticsRevision: string;
  /** The durable project the replay judged. Must be the one being repaired. */
  projectId: string;
  /**
   * Whether that project's OWN reservation satisfies the current admission
   * semantics. Required to be `false`: a repair is only for an admission that
   * does not hold.
   */
  oldProjectValidUnderCurrentSemantics: boolean;
  /** Why it does not hold, in the replay's own words. */
  oldProjectRefusalReason: string;
  /** The game accepted this facility at this place and rotation for the NEW plan. */
  nativePlacementAccepted: boolean;
  facilityPrefab: string;
  facilityPosition: SpatialPoint2;
  facilityRotation: number;
  /** A clean groundwater source lies inside the new reservation. */
  groundwaterValid: boolean;
  /** The new site has a bounded road candidate admission could build against. */
  roadCandidateValid: boolean;
  /** The minimum feasible spend the accepted plan declares. */
  requiredUtilityBudget: number;
}

/**
 * Validate the replay evidence, fail-closed on every gap.
 *
 * Throws rather than returning a verdict: this runs on the admission path, and a
 * caller that supplied partial evidence must not be handed a repairable answer.
 */
export function assertAdmissionSemanticsReplayEvidence(
  evidence: AdmissionSemanticsReplayEvidence,
  expected: { projectId: string; semanticsRevision: string },
): void {
  if (!evidence || typeof evidence !== "object") throw new Error("ADMISSION_SEMANTIC_REPAIR_EVIDENCE_MISSING");
  if (evidence.semanticsRevision !== expected.semanticsRevision) {
    throw new Error("ADMISSION_SEMANTIC_REPAIR_EVIDENCE_REVISION_MISMATCH");
  }
  if (evidence.projectId !== expected.projectId) {
    throw new Error("ADMISSION_SEMANTIC_REPAIR_EVIDENCE_PROJECT_MISMATCH");
  }
  // The half that makes a repair necessary at all. Evidence claiming the durable
  // project is still valid under the current semantics is not a repair, it is a
  // contradiction, and acting on it would spend the one identity for nothing.
  if (evidence.oldProjectValidUnderCurrentSemantics !== false) {
    throw new Error("ADMISSION_SEMANTIC_REPAIR_OLD_PROJECT_STILL_VALID");
  }
  if (!nonEmpty(evidence.oldProjectRefusalReason)) {
    throw new Error("ADMISSION_SEMANTIC_REPAIR_OLD_PROJECT_REFUSAL_UNPROVEN");
  }
  // The half that makes a repair legitimate: a complete, game-verified plan.
  if (evidence.nativePlacementAccepted !== true) throw new Error("ADMISSION_SEMANTIC_REPAIR_NATIVE_PLACEMENT_UNPROVEN");
  if (evidence.groundwaterValid !== true) throw new Error("ADMISSION_SEMANTIC_REPAIR_GROUNDWATER_UNPROVEN");
  if (evidence.roadCandidateValid !== true) throw new Error("ADMISSION_SEMANTIC_REPAIR_ROAD_CANDIDATE_UNPROVEN");
  if (!nonEmpty(evidence.facilityPrefab)) throw new Error("ADMISSION_SEMANTIC_REPAIR_FACILITY_PREFAB_UNKNOWN");
  if (!evidence.facilityPosition || !finite(evidence.facilityPosition.x) || !finite(evidence.facilityPosition.z)) {
    throw new Error("ADMISSION_SEMANTIC_REPAIR_FACILITY_POSITION_UNKNOWN");
  }
  if (!finite(evidence.facilityRotation)) throw new Error("ADMISSION_SEMANTIC_REPAIR_FACILITY_ROTATION_UNKNOWN");
  if (!finite(evidence.requiredUtilityBudget) || evidence.requiredUtilityBudget < 0) {
    throw new Error("ADMISSION_SEMANTIC_REPAIR_BUDGET_UNKNOWN");
  }
}

/**
 * The identity fields of the lineage root, resolved from durable records only.
 *
 * A root that is the currently durable project is read from it; any other root
 * must be named by a supersession record, because that is the only place a
 * project's verbatim identity survives once the durable slot has moved on. An
 * unresolvable root is refused rather than filled in from the current project —
 * that substitution is how a repair would come to claim a lineage it does not
 * descend from.
 */
export function resolveAdmissionLineageRootIdentity(input: {
  rootProjectId: string;
  current: Gate1State;
  supersessions: readonly V2SupersededProjectRecord[];
}): { intentId: string; trancheId: string; reservationRef: string } {
  if (input.rootProjectId === input.current.project.id) {
    return {
      intentId: input.current.intent.id,
      trancheId: input.current.tranche.id,
      reservationRef: input.current.tranche.reservationRef,
    };
  }
  const entry = input.supersessions.find((record) => record.projectId === input.rootProjectId);
  if (!entry) throw new Error("ADMISSION_SEMANTIC_REPAIR_ROOT_NOT_RESOLVED");
  return { intentId: entry.intentId, trancheId: entry.trancheId, reservationRef: entry.reservationRef };
}
