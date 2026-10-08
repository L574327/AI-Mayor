import type { LocalMayorActivity, LocalMayorDecisionEpisode, LocalMayorOutcomeImpact } from "./types";

type ActivityInput = {
  episode: LocalMayorDecisionEpisode;
  lastMeaningfulAction?: string | null;
  impact?: LocalMayorOutcomeImpact | null;
  mutation?: LocalMayorActivity["recentMutation"];
};

export function projectLocalMayorActivity({
  episode,
  lastMeaningfulAction = null,
  impact = null,
  mutation,
}: ActivityInput) {
  const { action } = episode.chosen;
  const candidate =
    action.kind === "choose_candidate"
      ? [...episode.state.candidates.zoning, ...episode.state.candidates.roadExpansion].find(
          (item) => item.id === action.candidateId,
        )
      : undefined;
  const focusTarget =
    candidate === undefined
      ? undefined
      : {
          kind: "candidate" as const,
          candidateId: candidate.id,
          ...(candidate.sourceRoad ? { sourceRoad: candidate.sourceRoad } : {}),
        };
  const activity: LocalMayorActivity = {
    status: episode.status,
    goal: episode.goals[0]?.kind ?? null,
    activityKind: "planning",
    reasonCode: action.reasonCode,
    displayKey: "local_mayor.planning",
    ...(focusTarget ? { focusTarget } : {}),
    lastMeaningfulAction,
    waitingReason: null,
    nextObservation: null,
    ...(episode.state.issues.highest
      ? {
          topIssue: {
            kind: episode.state.issues.highest.kind,
            severity: episode.state.issues.highest.severity,
            message: episode.state.issues.highest.message,
            actionable: episode.state.issues.highest.actionable,
            persistence: episode.state.issues.highest.persistence,
          },
        }
      : {}),
    ...(episode.state.growthIntent
      ? {
          growthProgress: {
            domain: episode.state.growthIntent.domain,
            phase: episode.state.growthIntent.phase,
            current:
              episode.state.growthIntent.phase === "corridor"
                ? episode.state.growthIntent.maxSegments - episode.state.growthIntent.remainingSegments
                : episode.state.growthIntent.maxZoningPatches - episode.state.growthIntent.remainingZoningPatches,
            total:
              episode.state.growthIntent.phase === "corridor"
                ? episode.state.growthIntent.maxSegments
                : episode.state.growthIntent.maxZoningPatches,
          },
        }
      : {}),
    ...(mutation ? { recentMutation: mutation } : {}),
  };

  if (action.kind === "choose_candidate") {
    if (!candidate) {
      activity.activityKind = "blocked";
      activity.displayKey = "local_mayor.blocked";
      activity.reasonCode = "candidate_not_executable";
      activity.waitingReason = "selected candidate is not present in the executable registry";
      activity.nextObservation = "candidate_registry_refresh";
      return activity;
    }
    if (impact?.kind === "no_material_change" || impact?.kind === "unavailable") {
      activity.activityKind = "observing";
      activity.displayKey = "local_mayor.observing";
      activity.reasonCode = impact.kind;
      activity.nextObservation = "world_change_or_backoff";
      return activity;
    }
    activity.activityKind =
      action.reasonCode === "build_starter_district" && (action.candidateIds?.length ?? 1) > 1
        ? "building_district"
        : "building";
    activity.displayKey =
      candidate?.kind === "road_expansion" ? "local_mayor.building_road" : "local_mayor.building_zoning";
    return activity;
  }
  if (action.kind === "recover_utility") {
    activity.activityKind = "recovering";
    activity.displayKey = "local_mayor.recovering";
    activity.reasonCode = action.reasonCode;
    activity.nextObservation = "utility_recovery_readback";
    return activity;
  }
  if (action.reasonCode === "select_next_district") {
    activity.activityKind = "selecting_next_district";
    activity.displayKey = "local_mayor.selecting_next_district";
    activity.waitingReason = action.reasonCode;
    activity.nextObservation = "fresh_global_district_registry";
    return activity;
  }
  if (episode.state.actionability.status === "blocked") {
    activity.activityKind = "blocked";
    activity.displayKey = "local_mayor.blocked";
    activity.reasonCode = episode.state.actionability.reasonCode;
    activity.waitingReason = episode.state.actionability.reason;
    activity.nextObservation = "demand_or_capacity_change";
    return activity;
  }
  if (action.kind === "wait" || action.kind === "simulate") {
    if (
      action.reasonCode === "corridor_no_continuation_candidate" ||
      action.reasonCode === "zoning_batch_candidate_unavailable"
    ) {
      activity.activityKind = "blocked";
      activity.displayKey = "local_mayor.blocked";
      activity.waitingReason = action.reasonCode;
      activity.nextObservation = "candidate_registry_refresh";
      return activity;
    }
    if (
      action.reasonCode === "waiting_for_absorption" ||
      action.reasonCode === "digest_growth_corridor" ||
      action.reasonCode === "digest_existing_capacity"
    ) {
      activity.activityKind = "waiting_for_absorption";
      activity.displayKey = "local_mayor.waiting_for_absorption";
    } else if (action.kind === "simulate" || action.reasonCode === "observe_bounded_growth") {
      activity.activityKind = "waiting_for_simulation";
      activity.displayKey = "local_mayor.waiting_for_simulation";
    } else {
      const hasCapacity = episode.state.actionability.capacityStatus === "sufficient";
      activity.activityKind = hasCapacity ? "waiting_for_growth" : "waiting_for_demand";
      activity.displayKey = hasCapacity ? "local_mayor.waiting_for_growth" : "local_mayor.waiting_for_demand";
    }
    activity.waitingReason = action.reasonCode;
    activity.nextObservation = action.kind === "simulate" ? "simulation_observation" : "next_snapshot";
    return activity;
  }
  if (episode.status === "recovering") {
    activity.activityKind = "recovering";
    activity.displayKey = "local_mayor.recovering";
  } else if (episode.status === "yielding") {
    activity.activityKind = "yielding";
    activity.displayKey = "local_mayor.yielding";
  } else {
    activity.activityKind = "observing";
    activity.displayKey = "local_mayor.observing";
    activity.nextObservation = impact?.kind === "no_material_change" ? "world_change_or_backoff" : "next_snapshot";
  }
  return activity;
}
