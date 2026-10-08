import {
  LOCAL_MAYOR_MAX_DISTRICT_BURST,
  type LocalGrowthIntent,
  type LocalMayorCandidateRef,
  type LocalMayorGrowthDomain,
  type LocalMayorState,
} from "./types";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));

export function growthCorridorBudget(
  state: LocalMayorState,
  requestedDomain?: LocalMayorGrowthDomain,
): {
  maxSegments: number;
  targetCorridorLength: number;
  maxZoningPatches: number;
} {
  const demand = Math.max(...Object.values(state.demands).map((value) => value ?? 0));
  const reserve = state.developmentCapacity.zonedUnoccupiedByType?.residential ?? 0;
  const domain = requestedDomain ?? state.growthIntent?.domain;
  const typedReserve = domain ? (state.developmentCapacity.zonedUnoccupiedByType?.[domain] ?? reserve) : reserve;
  const runway = state.financeRunwayMonths;
  const utilityTight = [state.utilities.electricity, state.utilities.water, state.utilities.sewage].some(
    (utility) => utility.risk === "tight",
  );
  const utilityCritical = [state.utilities.electricity, state.utilities.water, state.utilities.sewage].some(
    (utility) => utility.risk === "critical",
  );
  const maxSegments =
    utilityCritical || (runway !== null && runway < 3)
      ? 1
      : utilityTight || (runway !== null && runway < 8)
        ? 2
        : demand >= 80 && typedReserve < Math.max(24, state.developmentCapacity.targetZoningCells)
          ? LOCAL_MAYOR_MAX_DISTRICT_BURST
          : 2;
  const targetCorridorLength = clamp(maxSegments * 80, 180, 640);
  const maxZoningPatches =
    utilityCritical || (runway !== null && runway < 3)
      ? 1
      : demand >= 80 && typedReserve < Math.max(24, state.developmentCapacity.targetZoningCells)
        ? LOCAL_MAYOR_MAX_DISTRICT_BURST
        : 2;
  return { maxSegments, targetCorridorLength, maxZoningPatches };
}

export function createLocalGrowthIntent(
  state: LocalMayorState,
  candidate: LocalMayorCandidateRef,
  domain: LocalMayorGrowthDomain,
): LocalGrowthIntent {
  const budget = growthCorridorBudget(state, domain);
  return {
    version: 1,
    domain,
    phase: candidate.kind === "road_expansion" ? "corridor" : "zoning",
    sourceRoad: candidate.sourceRoad,
    preferredHeadingDegrees: candidate.roadHeadingDegrees ?? null,
    targetCorridorLength: budget.targetCorridorLength,
    completedCorridorLength: candidate.approximateLength ?? 0,
    remainingSegments: candidate.kind === "road_expansion" ? Math.max(0, budget.maxSegments - 1) : 0,
    maxSegments: budget.maxSegments,
    remainingZoningPatches: budget.maxZoningPatches,
    maxZoningPatches: budget.maxZoningPatches,
    createdRevision: state.snapshotRevision,
    valid: true,
    status: "active",
    digestStartedGameTime: null,
  };
}

export function nextLocalGrowthIntent(
  intent: LocalGrowthIntent,
  candidate: LocalMayorCandidateRef,
  state: LocalMayorState,
): LocalGrowthIntent {
  if (candidate.kind === "zoning" && intent.phase === "corridor") {
    return nextLocalGrowthIntent(
      { ...intent, phase: "zoning", completionReason: "corridor_safe_truncated" },
      candidate,
      state,
    );
  }
  if (candidate.kind === "road_expansion" && intent.phase === "corridor") {
    const remainingSegments = Math.max(0, intent.remainingSegments - 1);
    const completedCorridorLength = intent.completedCorridorLength + (candidate.approximateLength ?? 0);
    const keepCorridor = remainingSegments > 0 && completedCorridorLength < intent.targetCorridorLength;
    return {
      ...intent,
      sourceRoad: candidate.sourceRoad ?? intent.sourceRoad,
      preferredHeadingDegrees: candidate.roadHeadingDegrees ?? intent.preferredHeadingDegrees ?? null,
      completedCorridorLength,
      remainingSegments,
      phase: keepCorridor ? "corridor" : "zoning",
      ...(keepCorridor ? {} : { completionReason: "corridor_target_reached" as const }),
      status: "active",
    };
  }
  if (candidate.kind === "zoning" && intent.phase === "zoning") {
    const remainingZoningPatches = Math.max(0, intent.remainingZoningPatches - 1);
    const deficit = state.developmentCapacity.typedReserveDeficit?.[intent.domain] === true;
    return {
      ...intent,
      remainingZoningPatches,
      phase: remainingZoningPatches > 0 && deficit ? "zoning" : "digest",
      digestStartedGameTime:
        remainingZoningPatches > 0 && deficit ? (intent.digestStartedGameTime ?? null) : state.game.gameDateTime,
      status: "active",
    };
  }
  return intent;
}

export function corridorCandidateMatches(intent: LocalGrowthIntent, candidate: LocalMayorCandidateRef): boolean {
  if (candidate.kind !== "road_expansion" || intent.phase !== "corridor" || !intent.valid) return false;
  if (intent.domain && candidate.growthDomain && candidate.growthDomain !== intent.domain) return false;
  if (
    intent.sourceRoad &&
    candidate.sourceRoad &&
    (intent.sourceRoad.index !== candidate.sourceRoad.index ||
      intent.sourceRoad.version !== candidate.sourceRoad.version)
  )
    return false;
  if (intent.preferredHeadingDegrees === null || candidate.roadHeadingDegrees === undefined) return true;
  const delta = Math.abs(((candidate.roadHeadingDegrees - intent.preferredHeadingDegrees + 540) % 360) - 180);
  return (candidate.roadHeadingDeltaDegrees ?? delta) <= 30 || delta <= 30;
}

function sameRoad(
  left: { index: number; version: number } | null,
  right: { index: number; version: number } | null,
): boolean {
  return Boolean(left && right && left.index === right.index && left.version === right.version);
}

/** Rebase continuation on a fresh authoritative road source after a successful segment. */
export function rebaseLocalGrowthIntentFromSnapshot(
  intent: LocalGrowthIntent,
  state: LocalMayorState,
): LocalGrowthIntent {
  if (intent.phase !== "corridor" || !intent.valid) return intent;
  const fresh = state.candidates.roadExpansion
    .filter((candidate) => candidate.growthDomain === undefined || candidate.growthDomain === intent.domain)
    .filter((candidate) => candidate.sourceRoad && !sameRoad(candidate.sourceRoad, intent.sourceRoad))
    .sort(
      (left, right) =>
        (left.roadHeadingDeltaDegrees ?? 999) - (right.roadHeadingDeltaDegrees ?? 999) ||
        left.id.localeCompare(right.id),
    )[0];
  if (!fresh?.sourceRoad) return intent;
  return {
    ...intent,
    sourceRoad: fresh.sourceRoad,
    preferredHeadingDegrees: fresh.roadHeadingDegrees ?? intent.preferredHeadingDegrees,
  };
}

export function zoningCandidateMatches(intent: LocalGrowthIntent, candidate: LocalMayorCandidateRef): boolean {
  return (
    intent.phase === "zoning" && candidate.kind === "zoning" && candidate.areaType?.toLowerCase() === intent.domain
  );
}
