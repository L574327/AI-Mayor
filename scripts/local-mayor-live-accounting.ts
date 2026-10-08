import type { MayorBatchResult } from "../src/main/services/ai-mayor/types";

export type LocalMayorLiveActionClass = "build_road" | "zone" | "simulation" | "other" | "unknown";

export interface LocalMayorLiveCandidateMetadata {
  id: string;
  actionType: "build_road" | "zone";
}

export interface LocalMayorLiveExecutionAccounting {
  selectedCandidateId: string | null;
  selectedActionType: LocalMayorLiveActionClass;
  executedActionType: LocalMayorLiveActionClass;
  executionSucceeded: boolean;
  resultSummary: string | null;
}

export const LOCAL_MAYOR_REQUIRED_LIVE_TOOLS = [
  "cs2_mayor_snapshot",
  "cs2_spatial",
  "cs2_mayor_execute_actions",
  "cs2_utility_connectors",
  "cs2_city_services",
  "cs2_run_simulation",
  "cs2_game_state",
  "cs2_save_game",
] as const;

export function missingLocalMayorLiveTools(availableTools: Iterable<string>): string[] {
  const available = new Set(availableTools);
  return LOCAL_MAYOR_REQUIRED_LIVE_TOOLS.filter((name) => !available.has(name));
}

export function accountLocalMayorBatchExecution(input: {
  selectedCandidateId: string | null;
  candidates: readonly LocalMayorLiveCandidateMetadata[];
  batch: MayorBatchResult;
}): LocalMayorLiveExecutionAccounting[] {
  const candidate = input.candidates.find((item) => item.id === input.selectedCandidateId);
  const selectedActionType: LocalMayorLiveActionClass = candidate?.actionType ?? "unknown";
  return input.batch.results.map((result) => ({
    selectedCandidateId: input.selectedCandidateId,
    selectedActionType,
    executedActionType:
      result.type === "build_road" ||
      result.type === "zone" ||
      result.type === "place_building" ||
      result.type === "upgrade_road"
        ? result.type === "build_road"
          ? "build_road"
          : result.type === "zone"
            ? "zone"
            : "other"
        : "unknown",
    executionSucceeded: result.ok === true,
    resultSummary: result.summary ?? null,
  }));
}

export function countLocalMayorLiveExecutions(accounting: readonly LocalMayorLiveExecutionAccounting[]): {
  roadExecutions: number;
  zoningExecutions: number;
} {
  return accounting.reduce(
    (counts, item) => {
      if (!item.executionSucceeded) return counts;
      if (item.executedActionType === "build_road") counts.roadExecutions += 1;
      if (item.executedActionType === "zone") counts.zoningExecutions += 1;
      return counts;
    },
    { roadExecutions: 0, zoningExecutions: 0 },
  );
}

export function localMayorGrowthInvariantViolation(input: {
  batchActionCount: number;
  roadsInBurst: number;
  zoningInBurst: number;
  consecutiveSuccessfulBursts: number;
}): string | null {
  if (input.batchActionCount > 8) return "runaway_batch_bound";
  if (input.roadsInBurst > 8) return "runaway_burst_road_bound";
  if (input.zoningInBurst > 8) return "runaway_burst_zoning_bound";
  if (input.consecutiveSuccessfulBursts > 2) return "runaway_unbounded_district_bursts";
  return null;
}
