import type { PlannedRoadSegment, SpatialPoint2 } from "../spatial/types";

/** Thin semantic policy seam for future Runtime Skills. It can express soft preferences only. */
export interface MayorPlanningPolicy {
  roadRolePreference: "LOCAL_GRID" | "CORRIDOR" | "DIRECT_ACCESS";
  expansionPreference: "COMPACT" | "CORRIDOR_FIRST" | "BALANCED";
  utilitySitingPreference: "ROAD_CONNECTED" | "RESOURCE_FIRST" | "BALANCED";
  scoringWeights: {
    directness: number;
    corridorReuse: number;
    frontage: number;
    futureService: number;
    shortSegmentPenalty: number;
    sharpTurnPenalty: number;
    excessLengthPenalty: number;
  };
}

export const DEFAULT_MAYOR_PLANNING_POLICY: Readonly<MayorPlanningPolicy> = Object.freeze({
  roadRolePreference: "LOCAL_GRID",
  expansionPreference: "COMPACT",
  utilitySitingPreference: "ROAD_CONNECTED",
  scoringWeights: Object.freeze({
    directness: 4,
    corridorReuse: 1,
    frontage: 1,
    futureService: 1,
    shortSegmentPenalty: 0.8,
    sharpTurnPenalty: 1.4,
    excessLengthPenalty: 1,
  }),
});

export interface RoadPlanningCandidate {
  segments: readonly PlannedRoadSegment[];
  family?: string;
  gridAlignmentErrorMeters?: number;
  corridorReuse?: number;
  frontage?: number;
  futureService?: number;
  /** Optional directional context at source and target. */
  sourceDirection?: SpatialPoint2;
  targetDirection?: SpatialPoint2;
}

export interface RoadPlanningRejectionMemoryEntry {
  event?: unknown;
  planningContextFingerprint?: unknown;
  candidateFingerprint?: unknown;
}

/** Read the durable per-utility planning journal using Gate 1's persisted key. */
export function durableUtilityPlanningJournal(projectState: unknown, utilityKind: string): Array<Record<string, unknown>> {
  const object = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tranche = object(object(projectState).tranche);
  const utilities = object(object(tranche.utilityExecution).utilities);
  const connectionReplan = object(object(utilities[utilityKind]).connectionReplan);
  return Array.isArray(connectionReplan.journal) ? connectionReplan.journal.map(object) : [];
}

/** Same context + exact identity is remembered; a new material context is eligible again. */
export function shouldPreviewRoadCandidate(input: {
  planningContextFingerprint: string;
  candidateFingerprint: string;
  memory: readonly RoadPlanningRejectionMemoryEntry[];
}): boolean {
  return !input.memory.some((entry) => entry.event === "ROAD_PLANNING_CANDIDATE_REJECTED" &&
    entry.planningContextFingerprint === input.planningContextFingerprint &&
    entry.candidateFingerprint === input.candidateFingerprint);
}

export function scoreRoadPlanningCandidate(
  candidate: RoadPlanningCandidate,
  policy: MayorPlanningPolicy = DEFAULT_MAYOR_PLANNING_POLICY,
): number {
  const segments = candidate.segments;
  if (segments.length === 0) return Number.NEGATIVE_INFINITY;
  const lengths = segments.map((segment) => Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z));
  const directLength = Math.hypot(
    segments[segments.length - 1].end.x - segments[0].start.x,
    segments[segments.length - 1].end.z - segments[0].start.z,
  );
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const tinySegmentCount = lengths.filter((length) => length < 24).length;
  let sharpTurnCost = 0;
  for (let index = 1; index < segments.length; index += 1) {
    const before = segments[index - 1];
    const after = segments[index];
    const ax = before.end.x - before.start.x;
    const az = before.end.z - before.start.z;
    const bx = after.end.x - after.start.x;
    const bz = after.end.z - after.start.z;
    const denominator = Math.hypot(ax, az) * Math.hypot(bx, bz);
    if (denominator > 0) {
      const cosine = Math.max(-1, Math.min(1, (ax * bx + az * bz) / denominator));
      sharpTurnCost += Math.max(0, 0.5 - cosine);
    }
  }
  const directness = directLength > 0 ? Math.max(0, Math.min(1, directLength / Math.max(totalLength, directLength))) : 0;
  return policy.scoringWeights.directness * directness +
    (policy.roadRolePreference === "LOCAL_GRID" && candidate.family === "ORTHOGONAL_GRID" ? 100 : 0) +
    (policy.roadRolePreference === "LOCAL_GRID" && candidate.gridAlignmentErrorMeters !== undefined
      ? -0.1 * candidate.gridAlignmentErrorMeters : 0) +
    policy.scoringWeights.corridorReuse * (candidate.corridorReuse ?? 0) +
    policy.scoringWeights.frontage * (candidate.frontage ?? 0) +
    policy.scoringWeights.futureService * (candidate.futureService ?? 0) -
    policy.scoringWeights.shortSegmentPenalty * tinySegmentCount -
    policy.scoringWeights.sharpTurnPenalty * sharpTurnCost -
    policy.scoringWeights.excessLengthPenalty * Math.max(0, totalLength - directLength);
}

/** Stable rank only: every native-legal candidate remains eligible for preview. */
export function rankRoadPlanningCandidates<T extends RoadPlanningCandidate>(
  candidates: readonly T[], policy: MayorPlanningPolicy = DEFAULT_MAYOR_PLANNING_POLICY,
): T[] {
  return candidates.map((candidate, index) => ({ candidate, index, score: scoreRoadPlanningCandidate(candidate, policy) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate);
}

export function roadSegmentFamily(candidate: RoadPlanningCandidate): string {
  if (candidate.family) return candidate.family;
  if (candidate.segments.length === 1) return "STRAIGHT_EXTENSION";
  return "BOUNDED_CORRIDOR_DOGLEG";
}
