import { HttpsProxyAgent } from "https-proxy-agent";
import type { IChatUsage } from "intellichat/types";
import fetch, { type RequestInit } from "node-fetch";
import { calculateDeepSeekCost } from "@/intellichat/telemetry/deepseekCost";
import { Mutex } from "@/main/internal/mutex";
import { type DeepSeekBalance, fetchDeepSeekBalance } from "@/main/services/deepseek-balance";
import {
  buildMayorCandidateSet,
  candidateQuery,
  type MayorCandidateSet,
  type PrivateMayorCandidate,
  parseSpatialSiteDetail,
  type RoadExpansionPreferences,
  residentialZoneDensity,
  validateZoningCandidate,
  zonePrefabForDomain,
} from "./action-candidates";
import { scanCityIssues } from "./local-mayor/issues";
import type {
  LocalDevelopmentCapacity,
  LocalMayorGrowthDomain,
  LocalTypedDevelopmentReserve,
  LocalTypedReserveDeficit,
} from "./local-mayor/types";
import { MayorBatchResultSchema } from "./schema";
import { evaluateBootstrapSites } from "./spatial/site-finder";
import type { PlannedUtilityFacility, SpatialRoadEdge } from "./spatial/types";
import { planBootstrapUtilities } from "./spatial/utility-planner";
import { buildSpatialWorldModel, parseSpatialBootstrapScan, pointInTile } from "./spatial/world-scanner";
import { DistrictBuilder, mainStreetNetwork } from "./v2/district-builder";
import { fileBuilderMemory } from "./v2/builder-memory";
import type { PrefabLock, TechTree } from "./v2/tech-tree";
import { ExecutionOutcomeRecorder } from "./v2/execution-telemetry";
import { appendFileSync, existsSync, statSync } from "node:fs";
/** Recorders only append and never stop the city; a file past 20 MB stops growing. */
function cappedAppend(file: string, row: string): void {
  try { if (existsSync(file) && statSync(file).size > 20_000_000) return; appendFileSync(file, row); } catch { /* evidence never stops the city */ }
}

import { execFile } from "node:child_process";
import { ExperienceBook, fileExperienceStore } from "./v2/experience-book";
import { FinanceRecoveryLoop, serviceLineOfPrefab, type FinanceFacts, type FinanceRecoveryPort, type TaxArea, type UnattachedFacility } from "./v2/finance-recovery";
import { BURIED_NET_ELEVATION_METERS, connectorForNet, DISTRICT_UTILITY_CONNECTION_PREFAB, rankPowerSources, THERMAL_PLANT, type PowerAsset } from "./v2/district-utilities";
import { plausibleLaborReading } from "./v2/growth-bottleneck";
import { categoryOfZoneName, emptyMix } from "./v2/zoning-mix";
import type {
  MayorAction,
  MayorBatchResult,
  MayorCandidateSelectionAction,
  MayorDecisionResult,
  MayorPlanAction,
  MayorPlanningCandidate,
  MayorRuntimePorts,
  MayorSessionState,
  UrbanDesignDevelopmentPolicy,
} from "./types";
import type { UrbanDesignSnapshotContext } from "./urban-design/intent";
import { resolveUrbanDesignIntent } from "./urban-design/intent";
import {
  createEmptyUrbanDesignNoveltyMemory,
  recordSuccessfulUrbanDesignLifecycle,
  summarizeUrbanDesignNovelty,
  type UrbanDesignNoveltyMemory,
} from "./urban-design/novelty";
import type { UrbanDesignProposal } from "./urban-design/proposal";
import { realizeUrbanDesignProposal } from "./urban-design/realization";
import type { UrbanPlanningAnchor } from "./urban-design/site-context";
import { buildUrbanPlanningAnchors, buildUrbanSiteContext } from "./urban-design/site-context";
import { executeSharedUtilityRecovery, type UtilityRecoveryKind } from "./utility-recovery";
import { certifyDeliveredRoad, type CertifiedRoadDelivery } from "./v2/certified-road-delivery";
import {
  simulationAbsoluteBudgetMs,
  simulationNoProgressBudgetMs,
} from "./v2/simulation-wait-contract";
import { FRAMES_PER_GAME_DAY } from "./v2/growth-policy";
import { currentUtilityServiceEntry as resolveCurrentUtilityServiceEntry } from "./v2/utility-service-entry";
import { AUTHORITATIVE_UTILITY_KIND, buildUtilityPreparationInput } from "./v2/utility-admission-context";
import {
  firstFacilityPlacementDurability,
  firstFacilityPlacementPermitted,
} from "./v2/utility-placement-durability";
import { createUtilityPlacementSuccessor } from "./v2/greenfield-utility-bootstrap";
import { createV2Gate1Progression } from "./v2/gate1-progression";
import { chooseUtilityCapability, deriveUtilityGap, facilityGapOptions, ledgerEpoch, meaningfulProgress, nextUtilityStrategy, utilityFactsFromEvidence, utilityActionMadeGapProgress, utilityGapIsWaitOnly, utilityKindFromServiceGoalId,
  type UtilityStrategy } from "./v2/autonomous-brain";
import { createV2Gate1ProgressionBoundary } from "./v2/gate1-progression-boundary";
import { createV2FoundationPorts, WATER_FLOW_OBSERVATION_RESOLUTION } from "./v2/main-adapter";
import { parseWaterFlowObservation, type WaterFlowObservation } from "./spatial/water-flow";
import type { WaterSafety } from "./v2/water-safety-siting";
import type { V2ProjectSiteConstraint } from "./v2/project-admission";
import { createV2ProductionSkillRuntime } from "./v2/production-skill-runtime";
import { createBlockingModalRuntimePort } from "./v2/blocking-modal-runtime";
import { normalizeNativeRoadDiagnostics } from "./v2/runtime-road-caller";
import {
  createV2RuntimeRoadCaller,
  type RuntimeRoadAuthorization,
  type RuntimeRoadTask,
} from "./v2/runtime-road-caller";
import type { ProposalQuote } from "./v2/finance";
import { parseNativeWorldIdentity, type SaveCompletionReceipt, type V2DurableStateStorage } from "./v2/durability";
import { V2_GATE1_STATE_SCHEMA_VERSION, type Gate1State } from "./v2/gate1";
import type { V2DurableProjectState } from "./v2/durability";
import { K05CommissionUtilitiesWorkflowAdapter } from "./skills/adapters/k05-commission-utilities-workflow";
import type { RoadExecutionResult } from "./v2/road-kernel";
import {
  createPumpSegment2JunctionContract,
  junctionIdentityFingerprint,
  junctionReplacementFingerprint,
  type BoundedJunctionAdmissionEvidence,
  type JunctionReplacementObservation,
} from "./v2/bounded-network-junction";

const isGate1ProjectState = (state: V2DurableProjectState | null | undefined): state is Gate1State =>
  state?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION;

interface DeepSeekProviderConfig {
  apiBase?: string;
  apiKey?: string;
  proxy?: string;
}

/** Preserve native completion evidence while aggregating a V2 ROAD result. */
/**
 * How many site scopes one water Goal may be granted before the Brain stops
 * looking for a reservation that can host a source.
 *
 * A scope is a claim on land; the bound is what keeps "try somewhere else" from
 * becoming an unbounded land grab. Each scope still has to pass the whole site
 * search, the water constraint and the native placement probe on its own.
 */
export const MAXIMUM_UTILITY_GOAL_SITE_SCOPES = 3;

/**
 * Outcomes that spend a water reservation's real placement capability.
 *
 * The planner produces two shapes: a zero-candidate bounded plan, and a
 * prepare-time rejection of every connection candidate by the game's own
 * validation. Operationally they mean the same thing 鈥?no further K05 attempt
 * against this reservation can succeed 鈥?so both must advance to a fresh bounded
 * site admission. Recognising only the first shape left the second reporting
 * `BRAIN_STRATEGIES_EXHAUSTED` with the reservation still counted as unspent, and
 * the Goal parked with one budgeted scope never claimed.
 */
export const UTILITY_RESERVATION_EXHAUSTION_OUTCOMES = [
  "NO_SUPPORTED_WATER_TOPOLOGY",
  "UTILITY_CONNECTION_CANDIDATE_MISSING",
  "operation blocked by game validation",
] as const;

/**
 * A Goal's own site scope, as its goal id records it.
 *
 * Both piped utilities escape a spent reservation the same way, so both shapes
 * count: the water Goal's `UTILITY_SERVICE:water:city` and the sewage Goal's
 * `PROVIDE_SERVICE:sewage:facts:<fingerprint>`. A scope is a goal id with the
 * ordinal its successor appends, so the pattern anchors on that suffix instead
 * of on either family's middle segment.
 */
/** Polls in a row a window sees the game paused short of its target with nothing moving, before it looks for a popup. */
const MID_WINDOW_PAUSED_POLLS = 3;
/**
 * A milestone is a number of XP, so the popup can be seen coming: when the city is within this share of the next threshold (or this many XP,
 * whichever is more) the popup may be raised in the middle of the next window, and the window looks for it after ONE paused poll instead of three.
 * Far from a milestone the window is not touched. ⟨待标定⟩; the saving is a couple of seconds per milestone, the cost is none.
 */
const MILESTONE_NEAR_SHARE = 0.1;
const MILESTONE_NEAR_MINIMUM_XP = 300;
let milestoneProgress: { xp: number; next: number } | null = null;
/** Remember where the city stands against its next milestone (read by the district builder every cycle). Null clears it. */
export function noteMilestoneProgress(xp: number | null, nextMilestoneXp: number | null): void {
  milestoneProgress = xp !== null && nextMilestoneXp !== null && nextMilestoneXp > 0 ? { xp, next: nextMilestoneXp } : null;
}
/** Whether the next milestone is close enough for its popup to arrive during a window. */
export function milestoneIsNear(): boolean {
  return milestoneProgress !== null && milestoneProgress.next - milestoneProgress.xp <= Math.max(MILESTONE_NEAR_MINIMUM_XP, milestoneProgress.next * MILESTONE_NEAR_SHARE);
}
/** The least wall time between two such looks in one window. */
const MID_WINDOW_MODAL_LOOK_INTERVAL_MS = 10_000;

/** Output per generator from the latest power ranking (refreshed by every ranking; read by the utility realization). */
const rankedPowerOutput = new Map<string, number>();

const UTILITY_SITE_SCOPE_PREFIX =/^(?:UTILITY_SERVICE|PROVIDE_SERVICE):(?:water|sewage)\b.*?:site_scope:\d+/;

/**
 * The water Goal's own site scopes, derived from the work orders it produced.
 *
 * Counting goal ids by prefix is wrong in both directions. A scope's bounded
 * Road prerequisites are descendants of it, so a prefix match counts one scope
 * plus every corridor step it took, and the first scope's first few
 * prerequisites already read as "the scope budget is spent". And a scope whose
 * admission always succeeded into a prerequisite never has a work-order record
 * of its own, so counting only exact goal ids reads as "no scope was ever
 * tried" and re-mints the scope whose budget is already gone.
 *
 * So a scope counts when it is a work order's own goal, or the parent of one.
 */
export function utilityGoalSiteScopes(
  orders: readonly { goalId: string; parentGoalId?: string | null }[],
): string[] {
  const scopes = new Set<string>();
  for (const order of orders) {
    const own = UTILITY_SITE_SCOPE_PREFIX.exec(order.goalId)?.[0];
    if (own) scopes.add(own);
    const parent = order.parentGoalId ? UTILITY_SITE_SCOPE_PREFIX.exec(order.parentGoalId)?.[0] : undefined;
    if (parent) scopes.add(parent);
  }
  return [...scopes].sort();
}

/** The next site scope for a water Goal: the smallest index not already spent. */
export function nextUtilityGoalSiteScopeId(goalId: string, scopes: readonly string[]): string {
  const highest = scopes.reduce((max, scope) => Math.max(max, Number(scope.split(":").pop()) || 0), 0);
  return `${goalId}:site_scope:${highest + 1}`;
}

export function aggregateV2RoadBatchResult(
  index: number,
  result: RoadExecutionResult,
): MayorBatchResult["results"][number] {
  const ok = result.command.status === "OBSERVED_MATCH";
  return {
    index,
    type: "build_road",
    ok,
    summary: ok ? "v2_authoritative_road_effect_certified" : "v2_road_effect_not_certified",
    ...(result.nativeCompletion?.raw !== undefined
      ? { nativeCompletionEvidence: result.nativeCompletion.raw }
      : {}),
    ...(result.command.evidence?.rejectionDiagnostics !== undefined
      ? { rejectionDiagnostics: result.command.evidence.rejectionDiagnostics }
      : {}),
    ...(result.command.evidence?.bridgeHttpErrorDiagnostics !== undefined
      ? { bridgeHttpErrorDiagnostics: result.command.evidence.bridgeHttpErrorDiagnostics }
      : {}),
    ...(result.command.evidence?.bridgeCommandId !== undefined
      ? { bridgeCommandId: result.command.evidence.bridgeCommandId }
      : {}),
    ...(result.command.evidence?.mcpBridgeFailureDiagnostics !== undefined
      ? { mcpBridgeFailureDiagnostics: result.command.evidence.mcpBridgeFailureDiagnostics }
      : {}),
    ...(ok
      ? {
          v2Road: {
            executionCommandId: result.command.commandId,
            bridgeCommandId: result.command.bridgeCommandId ?? null,
            proposalId: result.admission.proposalId,
            quoteId: result.admission.quoteId,
            fingerprint: result.command.authorizedScope.actionFamily === "ROAD"
              ? result.command.authorizedScope.fingerprint
              : "",
            ...(result.receipt ? { financeReceipt: result.receipt } : {}),
          },
        }
      : {
          error: result.command.failureOrUnknownReason ?? result.admission.reason ?? "V2 ROAD execution rejected",
        }),
  };
}

// Save is process-wide rather than adapter-instance-wide. Multiple runtime
// owners can create ports in one app process; none may submit a second native
// save while the first native operation is still unresolved.
let processSaveInFlight: Promise<void> | null = null;

interface LegacyMCPToolsManager {
  legacyList(): Promise<{ tools: Array<{ name: string }>; error?: unknown }>;
  legacyCall(options: {
    client: string;
    name: string;
    arguments: Record<string, unknown>;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

interface MayorFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export class LocalMayorCandidateExecutionError extends Error {
  constructor(
    readonly code:
      | "candidate_not_executable"
      | "residual_zoning_payload_incomplete"
      | "residual_zoning_stale"
      | "residual_zoning_revalidation_failure"
      | "zoning_executor_blocker",
    readonly reason: string,
  ) {
    super(`${code}:${reason}`);
    this.name = "LocalMayorCandidateExecutionError";
  }
}

export type MayorFetch = (url: string, init: RequestInit) => Promise<MayorFetchResponse>;

interface MainMayorAdapterOptions {
  getProvider(): DeepSeekProviderConfig | undefined;
  getToolsManager(): LegacyMCPToolsManager;
  emit?(event: "status" | "balance" | "tick", state: MayorSessionState): void;
  emitMayorCommentary?(line: import("./mayor-commentary").MayorCommentaryLine): void;
  fetchBalance?(
    provider: Required<Pick<DeepSeekProviderConfig, "apiBase" | "apiKey">> & { proxy?: string },
  ): Promise<DeepSeekBalance>;
  fetchImpl?: MayorFetch;
  pollIntervalMs?: number;
  simulationTimeoutMs?: number;
  saveCompletionTimeoutMs?: number;
  roadAuthorizationPolicy?(quote: ProposalQuote, task: RuntimeRoadTask): RuntimeRoadAuthorization;
  durableStateStorage?: V2DurableStateStorage;
  /**
   * The current project's own site requirement, when its domain has one. It is
   * threaded to project admission unchanged; absent, admission behaves exactly
   * as it did before the ingress fallback existed.
   */
  projectSiteConstraint?: V2ProjectSiteConstraint;
  /** Optional hard stop for one-shot production recovery runs. */
  gate1MaximumDecisions?: number;
  /**
   * Whether the Mayor may drive its own native save when it needs a durable
   * rollback boundary and no adoptable save of this world exists.
   *
   * On by default here, because this is the product construction and the product
   * is meant to run unattended: a Mayor that can only wait for a human to choose
   * a save point cannot be left to grow a city on its own. The boundary it
   * creates is its own uniquely named save, so a player's save is never
   * overwritten. Set it to `false` only where the "wait for the user's save"
   * policy is itself the thing under test -- the certification harnesses do
   * exactly that, which is why the lower-level factory stays explicit.
   */
  automaticRecoverySave?: boolean;
}

function summarizeDevelopmentCapacity(
  detail: ReturnType<typeof parseSpatialSiteDetail>,
  ownedTiles: ReturnType<typeof parseSpatialBootstrapScan>["tiles"],
  context: UrbanDesignSnapshotContext,
  candidateSet: MayorCandidateSet,
  snapshot?: unknown,
): Omit<LocalDevelopmentCapacity, "recentZoningAdded" | "recentRoadAddedFrontage"> {
  const visible = detail.zoningCells.filter((cell) => cell.visible === true);
  const owned = (cell: (typeof visible)[number]) =>
    ownedTiles.some((tile) => tile.owned && pointInTile(cell.position, tile));
  const safe = (cell: (typeof visible)[number]) =>
    owned(cell) &&
    cell.occupied === false &&
    cell.blocked === false &&
    cell.overridden === false &&
    cell.zoneType === 0;
  const safeUnzonedRoadsideCells = visible.filter((cell) => cell.roadside === true && safe(cell)).length;
  const safeUnzonedCells = visible.filter(safe).length;
  // zoneType is ZoneType.m_Index, a runtime prefab-type key rather than a
  // demand-domain enum. The Bridge resolves it through authoritative ZoneData
  // metadata and supplies the bounded semantic zoneCategory. Missing or future
  // categories remain unknown; numeric ids are never guessed here.
  const typedReserve: LocalTypedDevelopmentReserve = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    office: 0,
    unknown: 0,
  };
  for (const cell of visible) {
    if (!owned(cell) || cell.zoneType === 0 || cell.occupied || cell.blocked || cell.overridden) continue;
    if (cell.zoneCategory === "residential") typedReserve.residential += 1;
    else if (cell.zoneCategory === "commercial") typedReserve.commercial += 1;
    else if (cell.zoneCategory === "industrial") typedReserve.industrial += 1;
    else if (cell.zoneCategory === "office") typedReserve.office += 1;
    else typedReserve.unknown += 1;
  }
  const existingZonedUnoccupiedCells = Object.values(typedReserve).reduce((sum, value) => sum + value, 0);
  const existingZonedCells = visible.filter((cell) => owned(cell) && cell.zoneType !== 0).length;
  const zoningGroups = new Map<string, number>();
  const roadGroups = new Map<string, number>();
  for (const candidate of candidateSet.candidates) {
    const group = candidate.conflictGroup || candidate.id;
    if (candidate.actionType === "zone")
      zoningGroups.set(group, Math.max(zoningGroups.get(group) ?? 0, candidate.approximateCells ?? 0));
    if (candidate.actionType === "build_road")
      roadGroups.set(
        group,
        Math.max(roadGroups.get(group) ?? 0, candidate.approximateNewFrontage ?? candidate.approximateLength ?? 0),
      );
  }
  const candidateZoningCells = [...zoningGroups.values()].reduce((sum, value) => sum + value, 0);
  const candidateFrontageCapacity = [...roadGroups.values()].reduce((sum, value) => sum + value, 0);
  const extent = context.siteContext.development.extentBand;
  const snapshotRoot = record(snapshot);
  const population = Number(record(snapshotRoot.population).current ?? 0);
  const demandRoot = record(snapshotRoot.demand);
  const demandValue = (value: unknown) => {
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    const levels = record(value);
    return Math.max(Number(levels.low ?? 0), Number(levels.medium ?? 0), Number(levels.high ?? 0));
  };
  const highestDemand = Math.max(
    demandValue(demandRoot.residential),
    demandValue(demandRoot.commercial),
    demandValue(demandRoot.industrial),
    demandValue(demandRoot.office),
  );
  const economy = record(snapshotRoot.economy);
  const monthlyBalance = Number(economy.monthlyBalance);
  const treasury = Number(economy.treasury);
  const runway = monthlyBalance < 0 && treasury >= 0 ? treasury / Math.abs(monthlyBalance) : Number.POSITIVE_INFINITY;
  const utilityRoot = record(snapshotRoot.utilities);
  const utilityCritical = ["electricity", "water", "sewage"].some((kind) => {
    const utility = record(utilityRoot[kind]);
    const capacity = Number(utility.production ?? utility.capacity);
    const consumption = Number(utility.consumption);
    const fulfilled = Number(utility.fulfilledConsumption);
    return (
      utility.status !== "available" ||
      (Number.isFinite(fulfilled) && fulfilled < consumption) ||
      capacity <= consumption
    );
  });
  const extentTarget = extent === "large" ? 48 : extent === "medium" ? 32 : 24;
  const earlyCityTarget = population > 0 && population < 500 ? Math.max(32, Math.min(40, extentTarget)) : extentTarget;
  const demandAdjustment = highestDemand >= 80 ? 8 : highestDemand < 45 ? -8 : 0;
  const pressureAdjustment = utilityCritical || runway < 8 ? -8 : 0;
  const targetZoningCells = Math.max(8, Math.min(48, earlyCityTarget + demandAdjustment + pressureAdjustment));
  const targetFrontageCapacity = 80;
  const typedReserveDeficit: LocalTypedReserveDeficit = {
    residential: typedReserve.residential < targetZoningCells,
    commercial: typedReserve.commercial < targetZoningCells,
    industrial: typedReserve.industrial < targetZoningCells,
    office: typedReserve.office < targetZoningCells,
  };
  const availableDevelopmentCells = Math.min(
    512,
    existingZonedUnoccupiedCells + safeUnzonedRoadsideCells + candidateZoningCells,
  );
  const concreteReserveCells = existingZonedUnoccupiedCells + candidateZoningCells;
  const reserveDeficit =
    concreteReserveCells < targetZoningCells &&
    (safeUnzonedRoadsideCells > 0 || context.anchors.some((anchor) => anchor.canonicalSource));
  const reserveStatus = reserveDeficit
    ? availableDevelopmentCells > 0
      ? "low"
      : "empty"
    : existingZonedUnoccupiedCells >= 16
      ? "digesting"
      : "adequate";
  return {
    safeUnzonedRoadsideCells: Math.min(512, safeUnzonedRoadsideCells),
    safeUnzonedCells: Math.min(512, safeUnzonedCells),
    existingZonedUnoccupiedCells,
    zonedUnoccupiedByType: typedReserve,
    typedReserveDeficit,
    existingZonedCells: Math.min(2_000, existingZonedCells),
    candidateZoningCells: Math.min(256, candidateZoningCells),
    candidateFrontageCapacity: Math.min(320, candidateFrontageCapacity),
    availableFrontageCells: Math.min(512, safeUnzonedRoadsideCells),
    frontierAnchorCount: Math.min(8, context.anchors.length),
    targetZoningCells,
    targetFrontageCapacity,
    availableDevelopmentCells,
    reserveStatus,
    reserveDeficit,
    developmentDigesting: existingZonedUnoccupiedCells > 0,
  };
}

function providerOrThrow(options: MainMayorAdapterOptions) {
  const provider = options.getProvider();
  const apiKey = provider?.apiKey?.trim();
  if (!apiKey) throw new Error("PROVIDER_NOT_CONFIGURED: DeepSeek API key is not configured");
  return {
    apiBase: provider?.apiBase?.trim() || "https://api.deepseek.com/v1",
    apiKey,
    proxy: provider?.proxy,
  };
}

function deepSeekChatUrl(apiBase: string) {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.toString();
}

interface DeepSeekCompletionPayload {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  };
}

function usageFrom(payload: DeepSeekCompletionPayload): IChatUsage {
  const usage = payload.usage;
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) {
    throw new Error("DeepSeek Mayor response had no valid token usage");
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const promptCacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  return {
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens: usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - promptCacheHitTokens),
    completionTokens: usage.completion_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The rows of a list the Bridge returns as an array (or, older, keyed by name). `record()` of an array is `{}`: reading the scan's
 * `bootstrapAssets` through it emptied the generator catalogue, so every power ranking fell back to the turbines-only list (measured live
 * 2026-10-04: no unlocked plant was ever offered).
 */
const listOf = (value: unknown): unknown[] => Array.isArray(value) ? value : Object.values(record(value));

/** Every generator a spatial scan offers (unlocked or not): what it produces (a turbine at its nameplate) and what it costs. */
export function powerAssetsOfScan(scan: unknown): PowerAsset[] {
  return listOf(record(scan).bootstrapAssets).map(record).filter((asset) => typeof asset.prefab === "string").map((asset) => {
    const capability = record(asset.capabilities);
    const production = Number(capability.electricityProduction) > 0 ? Number(capability.electricityProduction) : Number(capability.windProduction) > 0 ? Number(capability.windProduction) : 0;
    const prefab = String(asset.prefab);
    return { prefab, locked: asset.locked === true, production, constructionCost: Number(asset.constructionCost ?? 0), needsFuel: THERMAL_PLANT.test(prefab),
      isGenerator: production > 0 || record(asset.kinds).power === true || /PowerPlant|PowerStation|WindTurbine/i.test(prefab) };
  }).filter((asset) => asset.isGenerator).map(({ isGenerator: _isGenerator, ...asset }) => asset);
}

const refKey = (value: unknown): string => {
  const item = record(value);
  return `${Number(item.index)}:${Number(item.version)}`;
};

function nativeCurvePointAtXZ(edge: Record<string, unknown>, point: { x: number; z: number }): { x: number; y: number; z: number } | null {
  const curve = record(edge.nativeCurve);
  const a = record(curve.a); const b = record(curve.b); const c = record(curve.c); const d = record(curve.d);
  if (![a, b, c, d].every((p) => [p.x, p.y, p.z].every((value) => Number.isFinite(Number(value))))) return null;
  let best: { x: number; y: number; z: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= 100; i += 1) {
    const t = i / 100; const u = 1 - t;
    const x = u ** 3 * Number(a.x) + 3 * u ** 2 * t * Number(b.x) + 3 * u * t ** 2 * Number(c.x) + t ** 3 * Number(d.x);
    const y = u ** 3 * Number(a.y) + 3 * u ** 2 * t * Number(b.y) + 3 * u * t ** 2 * Number(c.y) + t ** 3 * Number(d.y);
    const z = u ** 3 * Number(a.z) + 3 * u ** 2 * t * Number(b.z) + 3 * u * t ** 2 * Number(c.z) + t ** 3 * Number(d.z);
    const distance = Math.hypot(x - point.x, z - point.z);
    if (distance < bestDistance) { bestDistance = distance; best = { x, y, z }; }
  }
  return bestDistance <= 0.25 ? best : null;
}

function curvePassesPoint(edge: Record<string, unknown>, point: { x: number; z: number }): boolean {
  return nativeCurvePointAtXZ(edge, point) !== null;
}

export function roadActionKey(action: MayorAction): string | null {
  if (action.type !== "build_road") return null;
  return [action.prefab, action.x1, action.z1, action.x2, action.z2]
    .map((value) => (typeof value === "number" ? value.toFixed(2) : value))
    .join("|");
}

export function roadSourceDirectionKey(
  candidate: Pick<MayorPlanningCandidate, "actionType" | "sourceRoad" | "approximateDirection" | "approximateLength">,
): string | null {
  if (candidate.actionType !== "build_road" || !candidate.sourceRoad || !candidate.approximateDirection) return null;
  return `${candidate.sourceRoad.index}:${candidate.sourceRoad.version}|${candidate.approximateDirection}|${Math.round(candidate.approximateLength ?? 0)}`;
}

export type RoadAttemptOutcome = "success" | "rejected";
export type CandidateDisposition = "available" | "succeeded" | "rejected" | "quarantined" | "transient";
/** Backward-compatible name for callers that still describe the disposition as availability. */
export type CandidateAvailability = CandidateDisposition;
export type CandidateAvailabilityStore = Map<string, Map<string, CandidateDisposition>>;

export function roadAttemptKey(
  revision: string,
  action: MayorAction,
  summary?: Pick<MayorPlanningCandidate, "actionType" | "sourceRoad" | "approximateDirection" | "approximateLength">,
): string | null {
  const geometry = roadActionKey(action);
  if (!geometry) return null;
  return `${revision}|${roadSourceDirectionKey(summary ?? { actionType: "build_road" }) ?? "unknown-source"}|${geometry}`;
}

export function isRoadAttemptBlocked(
  revision: string | null,
  action: MayorAction,
  ledger: ReadonlyMap<string, ReadonlyMap<string, CandidateAvailability | RoadAttemptOutcome>>,
  summary?: Pick<MayorPlanningCandidate, "actionType" | "sourceRoad" | "approximateDirection" | "approximateLength">,
): boolean {
  return !isCandidateAvailable(revision, action, ledger, summary);
}

/** Authoritative road eligibility contract used by publication, selection, and dispatch. */
export function isCandidateAvailable(
  revision: string | null,
  action: MayorAction,
  availability: ReadonlyMap<string, ReadonlyMap<string, CandidateAvailability | RoadAttemptOutcome>>,
  summary?: Pick<MayorPlanningCandidate, "actionType" | "sourceRoad" | "approximateDirection" | "approximateLength">,
  candidateId?: string,
): boolean {
  if (!revision) return true;
  const outcomes = availability.get(revision);
  if (!outcomes) return true;
  const isUnavailable = (key: string | null) => {
    if (!key) return false;
    const outcome = outcomes.get(key);
    return outcome !== undefined && outcome !== "available";
  };
  if (candidateId && isUnavailable(candidateId)) return false;
  if (action.type !== "build_road") return true;
  return !(
    isUnavailable(roadAttemptKey(revision, action, summary)) ||
    isUnavailable(roadActionKey(action)) ||
    isUnavailable(roadSourceDirectionKey(summary ?? { actionType: "build_road" }))
  );
}

export function resolveSpatialRevision(snapshot: unknown): string | null {
  const root = record(snapshot);
  const directSiteContext = record(root.siteContext);
  const urbanDesign = record(root.urbanDesign);
  const siteContext = record(urbanDesign.siteContext);
  const canonical = directSiteContext.snapshotRevision ?? siteContext.snapshotRevision;
  if (typeof canonical === "string" && canonical.length > 0) return canonical;
  const legacy = record(snapshot).snapshotRevision;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : null;
}

export function filterUnavailableRoadCandidates(
  set: MayorCandidateSet,
  revision: string | null,
  availability: ReadonlyMap<string, ReadonlyMap<string, CandidateAvailability | RoadAttemptOutcome>>,
): MayorCandidateSet {
  if (!revision) return set;
  const outcomes = availability.get(revision);
  if (!outcomes || outcomes.size === 0) return set;
  const isRetired = (candidate: { action: MayorAction; summary: MayorPlanningCandidate }) =>
    !isCandidateAvailable(revision, candidate.action, availability, candidate.summary, candidate.summary.id);
  const candidates = set.candidates.filter((candidate) => {
    const privateCandidate = set.registry.get(candidate.id);
    return !privateCandidate || !isRetired(privateCandidate);
  });
  const registry = new Map([...set.registry].filter(([, candidate]) => !isRetired(candidate)));
  return { ...set, candidates, registry };
}

/** Backward-compatible name for callers that only care about road unavailability. */
export const filterRetiredRoadCandidates = filterUnavailableRoadCandidates;

/** The only registry-to-selection boundary for a public candidate id. */
export function resolveAvailableCandidate(
  set: MayorCandidateSet,
  candidateId: string,
  revision: string | null,
  availability: ReadonlyMap<string, ReadonlyMap<string, CandidateAvailability | RoadAttemptOutcome>>,
): PrivateMayorCandidate | null {
  const candidate = set.registry.get(candidateId);
  if (!candidate) return null;
  return isCandidateAvailable(revision, candidate.action, availability, candidate.summary, candidateId)
    ? candidate
    : null;
}

export const UDL_CANONICAL_ROAD_CATALOG_MAX = 16;

function entityKey(entity: { index: number; version: number }): string {
  return `${entity.index}:${entity.version}`;
}

function catalogRoadKey(value: unknown): string {
  const entity = record(record(value).entity);
  return `${String(entity.index)}:${String(entity.version)}`;
}

/** Pin only the selected anchor's authoritative graph sources into the compact catalog. */
export function pinCanonicalRoadAnchors(
  snapshot: unknown,
  roadEdges: readonly SpatialRoadEdge[],
  anchor: UrbanPlanningAnchor,
): unknown {
  const root = record(snapshot);
  const planningCatalog = record(root.planningCatalog);
  const existing = Array.isArray(planningCatalog.roadAnchors) ? planningCatalog.roadAnchors : [];
  const requiredKeys = new Set(anchor.canonicalSource?.incidentRoads.map((relation) => entityKey(relation.edge)) ?? []);
  const pinned = roadEdges
    .filter((edge) => requiredKeys.has(entityKey(edge.entity)))
    .map((edge) => ({
      entity: edge.entity,
      prefab: edge.prefab,
      start: edge.start,
      end: edge.end,
    }));
  if (requiredKeys.size !== pinned.length) return snapshot;
  const ordered = [...pinned, ...existing];
  const deduplicated = [...new Map(ordered.map((road) => [catalogRoadKey(road), road])).values()].slice(
    0,
    UDL_CANONICAL_ROAD_CATALOG_MAX,
  );
  return {
    ...root,
    planningCatalog: {
      ...planningCatalog,
      roadAnchors: deduplicated,
    },
  };
}

export function parseMcpJson(result: unknown): unknown {
  const response = record(result);
  const content = Array.isArray(response.content) ? response.content : [];
  if (response.isError === true) {
    const blocks = content.map(record);
    const errorItem = blocks.find((item) => item.error !== undefined);
    const textItem = blocks.find((item) => item.type === "text" && typeof item.text === "string");
    const detail = errorItem?.error ?? textItem?.text ?? "MCP tool returned an error";
    const error = new Error(String(detail));
    if (typeof detail === 'string') {
      try {
        const envelope = JSON.parse(detail) as Record<string, unknown>;
        if (typeof envelope.error === 'string' && (typeof envelope.commandId === 'string' || typeof envelope.status === 'number')) {
          Object.assign(error, { message: envelope.error, reason: envelope.error, status: envelope.status, commandId: envelope.commandId });
          const diagnostics = normalizeNativeRoadDiagnostics(envelope);
          if (diagnostics) Object.assign(error, { nativeRoadDiagnostics: diagnostics, diagnostics });
        }
      } catch {
        // Preserve the existing plain-text error behavior.
      }
    }
    throw error;
  }
  if (response.structuredContent !== undefined) return response.structuredContent;
  for (const item of content) {
    const block = record(item);
    if (block.type === "text" && typeof block.text === "string") {
      try {
        return JSON.parse(block.text);
      } catch {
        // Continue to the next content block.
      }
    }
  }
  throw new Error("MCP tool returned no JSON content");
}

async function abortableDelay(milliseconds: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export async function withBoundedNativeBuildBackpressure<T>(
  operation: () => Promise<T>,
  isBusy: (value: T) => boolean,
  signal?: AbortSignal,
  retryDelays = [100, 200, 400],
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const value = await operation();
      if (!isBusy(value) || attempt >= retryDelays.length) return value;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!/another build operation is in progress|build operation.*busy/i.test(reason) || attempt >= retryDelays.length)
        throw error;
    }
    await abortableDelay(retryDelays[attempt], signal ?? new AbortController().signal);
  }
}

/**
 * The speed the world is left running at between bounded observation windows.
 *
 * The Brain no longer holds the city still while it plans: it releases the
 * consistency window it took for its last mutation and lets the world run at
 * the game's fastest UI speed until the next mutation needs it stopped.
 */
export const AUTONOMOUS_RESUME_SPEED = 4;

/**
 * The adapter's own stall budget for a simulation run.
 *
 * Derived in `simulation-wait-contract` alongside the runtime's stage watchdog
 * so the two can never disagree about how long a run owns the game thread.
 */
export function defaultSimulationTimeoutMs(hours: number, speed: number): number {
  return simulationNoProgressBudgetMs(hours, speed);
}

/** The frame index a `/state`-shaped read reports, wherever it carries it. */
export function simulationFrameIndex(
  game: Record<string, unknown>,
  simulation: Record<string, unknown>,
): number | null {
  const value = typeof game.frameIndex === "number" ? game.frameIndex : simulation.frameIndex;
  return typeof value === "number" ? value : null;
}

/** The in-game clock a `/state`-shaped read reports, wherever it carries it. */
export function simulationGameDateTime(
  game: Record<string, unknown>,
  simulation: Record<string, unknown>,
): string | null {
  const value = typeof game.gameDateTime === "string" ? game.gameDateTime : simulation.gameDateTime;
  return typeof value === "string" ? value : null;
}

/** A utility road child only belongs to a facility already proven at its site. */
export function utilityCanMaterializeServiceRoadChild(utility: {
  stage?: string;
  facility?: unknown;
  connector?: unknown;
  plan?: { serviceRoads?: readonly unknown[] } | null;
}): boolean {
  return utility.stage === "PLACED" && !!utility.facility && !!utility.connector &&
    (utility.plan?.serviceRoads?.length ?? 0) > 0;
}

export const URBAN_DESIGN_VALIDATION_MAX_SIMULATION_HOURS = 0.5;

/** Short, opt-in validation burst; normal Mayor simulation strategy is unchanged. */
export function boundedValidationSimulationHours(hours: number): number {
  return Math.min(hours, URBAN_DESIGN_VALIDATION_MAX_SIMULATION_HOURS);
}

/**
 * Bounded authoritative simulation used to satisfy a Gate 1 SIMULATION_PROGRESS
 * wake.
 *
 * A wake means one task wants the world to have moved, and the caller re-checks
 * after it. It is a nudge, not a request for a working day: `advanceToStage` may
 * take up to `maximumWakeIterations` of these, and the Brain's own cycle may
 * take several passes, so the budget multiplies. At a quarter of a game hour
 * each that is three quarters of an hour per `advanceToStage` call, and the
 * measured live run (2026-10-01, fresh city) spent 79 of them across one cycle's
 * six calls for a single road — all of it waiting on a world that the tranche's
 * own pending construction task did not need.
 *
 * It used to match the Gate 1 battlefield's certification cadence. That is a
 * harness-parity reason, and it is not worth a city that builds nothing while it
 * waits.
 */
export const GATE1_PROGRESSION_SIMULATION = { hours: 0.25, speed: 4 } as const;

/** The product host's listener for the district builder's decision rows (one JSON row per cycle). Set before the ports are created. */
let decisionListener: ((row: string) => void) | null = null;
export function setDecisionListener(listener: ((row: string) => void) | null): void { decisionListener = listener; }

export function createMainMayorPorts(options: MainMayorAdapterOptions): MayorRuntimePorts {
  let candidateSet: MayorCandidateSet = {
    status: "unavailable",
    candidates: [],
    note: "Actionable planning has not been refreshed.",
    registry: new Map(),
    ownedTiles: [],
  };
  // Recovery supply remains a first-class registry across observational Snapshot reads
  // until the selected action is resolved.
  let recoveryCandidateSet: MayorCandidateSet | null = null;
  let urbanDesignContext: UrbanDesignSnapshotContext | null = null;
  let noveltyMemory: UrbanDesignNoveltyMemory = createEmptyUrbanDesignNoveltyMemory();
  let latestSpatial: {
    snapshot: unknown;
    context: UrbanDesignSnapshotContext;
    detail: ReturnType<typeof parseSpatialSiteDetail>;
    ownedTiles: ReturnType<typeof parseSpatialBootstrapScan>["tiles"];
    roadEdges: ReturnType<typeof parseSpatialBootstrapScan>["roadGraph"]["edges"];
    scan: ReturnType<typeof parseSpatialBootstrapScan>;
  } | null = null;
  // One authoritative availability store backs both selector filtering and the
  // final dispatch guard. Entries are scoped to the spatial revision.
  const candidateAvailability: CandidateAvailabilityStore = new Map();
  let spatialGeneration = 0;
  let snapshotBuildSequence = 0;
  const nativeBuildMutex = Mutex.create();
  /** The surface-water grid of the district builder's water rules, with the world generation it was read for. */
  let districtWaterGrid: { generation: string; grid: WaterFlowObservation } | null = null;
  let activeRealization: { proposal: UrbanDesignProposal; anchorId: string } | null = null;
  const callTool = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const manager = options.getToolsManager();
    const listed = await manager.legacyList();
    const tool = listed.tools.find((candidate) => candidate.name.endsWith(`--${name}`));
    if (!tool) throw new Error(`Required MCP tool is not connected: ${name}`);
    const separator = tool.name.indexOf("--");
    const client = tool.name.slice(0, separator);
    return parseMcpJson(
      await manager.legacyCall({ client, name, arguments: args, requestId: crypto.randomUUID(), signal }),
    );
  };
  /**
   * The snapshot with its zone catalogue read in full.
   *
   * `cs2_mayor_snapshot` keeps only the first 12 unlocked zone types and drops `spawnableBuildingCount`; on this
   * map that cut both `EU Residential Medium` (the density the game wants) and the fact that the generic
   * `Residential Medium` grows nothing. The full list comes from `cs2_list_zones`, read here, so the candidate
   * generator, the growth policy and the ZONING step all choose from the same complete catalogue. A failed read
   * leaves the snapshot exactly as it was.
   */
  const withZoneCatalogue = async (snapshot: unknown, signal?: AbortSignal): Promise<unknown> => {
    let root = record(snapshot);
    try {
      const zones = record(await callTool("cs2_list_zones", {}, signal)).zones;
      const zoneTypes = (Array.isArray(zones) ? zones : []).map(record)
        .filter((zone) => zone.locked !== true && typeof zone.name === "string" && typeof zone.areaType === "string" &&
          zone.areaType !== "None")
        .map((zone) => ({ name: zone.name, areaType: zone.areaType, office: zone.office === true,
          ...(typeof zone.spawnableBuildingCount === "number" ? { spawnableBuildingCount: zone.spawnableBuildingCount } : {}) }));
      if (zoneTypes.length > 0) root = { ...root, planningCatalog: { ...record(root.planningCatalog), zoneTypes } };
    } catch {
      // The snapshot's own catalogue stands.
    }
    // The job domains the game says are held down by a missing workforce. The snapshot keeps only the building
    // demand numbers, which still read "wanted" for a factory nobody can staff.
    try {
      const factorsOf = (domain: unknown) => record(record(domain).factors);
      const demand = record(await callTool("cs2_demand", {}, signal));
      const laborStarved = (["commercial", "industrial", "office"] as const).filter((domain) => {
        const factors = factorsOf(demand[domain]);
        return Number(factors.UneducatedWorkforce ?? 0) < 0 || Number(factors.EducatedWorkforce ?? 0) < 0;
      });
      root = { ...root, demand: { ...record(root.demand), laborStarved } };
    } catch {
      // Unread factors starve nothing.
    }
    return root;
  };
  const waitForAuthoritativeNativeIdle = async (signal?: AbortSignal, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let state: Record<string, unknown>;
      try {
        state = record(await callTool("cs2_game_state", {}, signal));
      } catch (error) {
        // Older test/minimal tool registries have no state probe; production
        // registries expose nativeOperationBusy and remain fail-closed there.
        if (String(error).includes("not connected: cs2_game_state")) return;
        throw error;
      }
      const world = record(state.world);
      if (world.nativeOperationBusy !== true) return;
      await abortableDelay(250, signal ?? new AbortController().signal);
    }
    throw new Error("BUSY_UNRESOLVED: native operation did not reach authoritative Idle");
  };
  const v2FoundationPorts = createV2FoundationPorts({
    getToolsManager: options.getToolsManager,
    durableStateStorage: options.durableStateStorage,
    // Product mode is unattended, so a recovery boundary is created rather than
    // waited for. This changes only *whether* a save is submitted: the receipt
    // it produces must still prove the same world, generation and native session
    // as before, and an adoptable save is still looked for first.
    automaticRecoverySave: options.automaticRecoverySave ?? true,
    ...(options.projectSiteConstraint ? { projectSiteConstraint: options.projectSiteConstraint } : {}),
  });
  const currentUtilityRoad = (state: Gate1State, world: import("./v2/durability").NativeWorldIdentity,
    fallback: CertifiedRoadDelivery | null) => resolveCurrentUtilityServiceEntry({
      scope: state.tranche.utilityExecution?.scope,
      projectId: state.project.id,
      trancheId: state.tranche.id,
      worldId: world.worldId,
      worldEpochId: world.worldEpochId,
      generation: world.generation,
      fallback: fallback ? { target: fallback.target, refs: fallback.refs } : null,
    });
  // K05 reads the same authoritative observation the planning path does, so the
  // Skill's gate and the plan's own certification cannot disagree about whether
  // the sewage question is answerable on this world.
  const k05Workflow = new K05CommissionUtilitiesWorkflowAdapter(
    v2FoundationPorts,
    (signal) => v2FoundationPorts.sewageEnvironmentalObservation(signal),
  );
  const v2ProductionSkillRuntime = createV2ProductionSkillRuntime({
    foundation: v2FoundationPorts,
    context: {
      currentWorldIdentity: async () => {
        const world = parseNativeWorldIdentity(await callTool("cs2_game_state", {}));
        return JSON.stringify([world.worldId, world.generation, world.worldEpochId]);
      },
      authoritativeContext: async (intent?: unknown) => {
        if (!v2FoundationPorts.activateDurableWorld || !v2FoundationPorts.durability) {
          throw new Error("V2_PRODUCTION_DURABILITY_NOT_CONFIGURED");
        }
        const activation = await v2FoundationPorts.activateDurableWorld();
        if (activation.blockedReason) throw new Error(activation.blockedReason);
        // Production Project Admission Bootstrap. An ACTIVATED world whose
        // project state is still PLACEHOLDER acquires its first durable Gate 1
        // project here, through the single admission seam. An already admitted
        // project is returned unchanged without any native read.
        if (!v2FoundationPorts.projectAdmission) {
          throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
        }
        await v2FoundationPorts.projectAdmission.ensureFirstProject();
        const state = v2FoundationPorts.durability.projectState();
        if (state.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
          throw new Error("V2_PRODUCTION_GATE1_STATE_UNAVAILABLE");
        }
        const overview = record(await callTool("cs2_city_overview"));
        const treasury = Number(overview.treasury);
        if (!Number.isFinite(treasury)) throw new Error("V2_PRODUCTION_TREASURY_UNAVAILABLE");
        // The road Gate 1 already delivered, read from the current tranche's
        // ROAD_CONNECTION terminal outcome and its durable command journal record.
        // It is the only road authority a first facility placement may use, and it
        // is never searched for, re-scanned, or re-derived geometrically. When it
        // cannot be read the placement stays unauthorized and preparation keeps
        // failing closed with UTILITY_FACILITY_NOT_FOUND.
        const deliveredRoad = certifyDeliveredRoad({
          state,
          world: activation.world,
          journal: v2FoundationPorts.durability.commandJournal,
        });
        const utilityRoad = currentUtilityRoad(state, activation.world,
          deliveredRoad.status === "CERTIFIED" ? deliveredRoad : null);
        // The durable, restart-stable first-facility placement state. Read from
        // the same durable journal the write-ahead command identity lives in, so
        // a crash between a native placement and the utility completion cannot
        // hide an already-built facility behind an incomplete observation.
        const requestedKind = (intent as { utilityKind?: unknown } | null)?.utilityKind;
        const kind = requestedKind === "electricity" || requestedKind === "water" || requestedKind === "sewage"
          ? requestedKind
          : AUTHORITATIVE_UTILITY_KIND;
        const firstFacilityPlacement = firstFacilityPlacementDurability(
          v2FoundationPorts.durability.utilityPlacementOperations({
            projectId: state.project.id,
            trancheId: state.tranche.id,
            reservationRef: state.tranche.reservationRef,
            utilityKind: kind,
            placementScopeId: state.tranche.utilityExecution?.utilities[kind]?.placementScopeId ?? "utility-placement:legacy",
          }),
        );
        const currentUtility = state.tranche.utilityExecution?.utilities[kind];
        const successorPlacementPending = !!currentUtility &&
          (currentUtility.stage === "MISSING" || currentUtility.stage === "BLOCKED") &&
          currentUtility.facility === null && (currentUtility.placementScopeHistory?.length ?? 0) > 0 &&
          currentUtility.facilityCommandId === null && firstFacilityPlacement.status === "NONE";
        return {
          state,
          world: activation.world,
          treasury,
          kind,
          firstFacilityPlacement,
          ...(successorPlacementPending ? { deferConnectionUntilPlaced: true } : {}),
          ...(utilityRoad
            ? { certifiedRoad: utilityRoad.target, certifiedRoadRefs: utilityRoad.refs }
            : { certifiedRoadUnavailableReason: deliveredRoad.status === "CERTIFIED" ? "CURRENT_UTILITY_SERVICE_ENTRY_UNAVAILABLE" : deliveredRoad.reason }),
        };
      },
    },
    // The adapter itself is the workflow. Registering it directly keeps its
    // typed admission context instead of an unchecked `never` cast at the
    // boundary, and keeps every context field (including the certified road)
    // type-checked end to end.
    workflows: [k05Workflow],
  });
  const blockingModal = createBlockingModalRuntimePort({
    call: (name, args, signal) => callTool(name, args, signal),
  });
  const v2RoadCaller = createV2RuntimeRoadCaller({
    road: v2FoundationPorts.road,
    readWorldGeneration: async () => {
      const state = record(await callTool("cs2_game_state"));
      const generation = record(state.world).generation;
      if (typeof generation !== "string" || !generation) throw new Error("ROAD_CURRENT_WORLD_GENERATION_UNAVAILABLE");
      return generation;
    },
    previewBuild: (input, signal) => callTool("cs2_build_road", { ...input, previewOnly: true }, signal),
    preview: (input, signal) =>
      {
        const contract = input.networkJunctionInsert;
        const identity = contract ? junctionIdentityFingerprint(contract) : null;
        const { networkJunctionInsert: _semantic, ...geometry } = input;
        return callTool("cs2_spatial", {
          mode: "preflight", kind: "net", ...geometry,
          ...(contract ? {
            roadOperationKind: "BOUNDED_NETWORK_JUNCTION_INSERT",
            junctionIdentityFingerprint: identity,
            replacementFingerprint: junctionReplacementFingerprint(contract.replacementClasses.map((semanticClass, index) => ({
              semanticClass,
              entity: { index, version: 1 },
            }))),
            proposalId: `junction:${identity}`,
            quoteId: `junction:${identity}`,
          } : {}),
        }, signal);
      },
    resolveJunctionContact: async (input, signal) => {
      const contract = input.networkJunctionInsert;
      if (!contract) throw new Error("BOUNDED_JUNCTION_CONTRACT_MISSING");
      const state = record(await callTool("cs2_game_state", {}, signal));
      const world = record(state.world);
      const simulation = record(state.simulation);
      if (typeof world.generation !== "string" || !world.generation || simulation.paused !== true ||
        world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle") throw new Error("BOUNDED_JUNCTION_WORLD_NOT_PAUSED_IDLE");
      const scan = record(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2000 }, signal));
      const graph = record(scan.roadGraph);
      const edges = Array.isArray(graph.edges) ? graph.edges.map(record) : [];
      if (graph.truncated !== false) throw new Error("BOUNDED_JUNCTION_CONTACT_SCAN_INCOMPLETE");
      const matches = edges.flatMap((edge) => {
        if (edge.prefab !== "Small Road") return [];
        const position = nativeCurvePointAtXZ(edge, contract.road.contact);
        if (!position) return [];
        const start = record(edge.start);
        const end = record(edge.end);
        const node = Math.hypot(Number(start.x) - contract.road.contact.x, Number(start.z) - contract.road.contact.z) <=
          Math.hypot(Number(end.x) - contract.road.contact.x, Number(end.z) - contract.road.contact.z)
          ? record(edge.startNode)
          : record(edge.endNode);
        return [{ edge, position, node }];
      });
      if (matches.length !== 1 || !Number.isInteger(Number(matches[0].edge.entity?.index)) ||
        !Number.isInteger(Number(matches[0].edge.entity?.version)) || !Number.isInteger(Number(matches[0].node.index)) ||
        !Number.isInteger(Number(matches[0].node.version))) throw new Error("BOUNDED_JUNCTION_CONTACT_REBIND_NOT_UNIQUE");
      const contact = {
        roadEdge: matches[0].edge.entity as { index: number; version: number },
        roadNode: { index: Number(matches[0].node.index), version: Number(matches[0].node.version) },
        position: matches[0].position,
        endpointRole: "START" as const,
      };
      const after = record(await callTool("cs2_game_state", {}, signal));
      if (record(after.world).generation !== world.generation || record(after.simulation).paused !== true ||
        record(after.world).nativeOperationBusy !== false || record(after.world).nativeOperationStage !== "Idle") {
        throw new Error("BOUNDED_JUNCTION_WORLD_CHANGED_DURING_CONTACT_REBIND");
      }
      return { generation: String(world.generation), contact };
    },
    certifyJunctionPreview: async (input, rawPreview, signal) => {
      const contract = input.networkJunctionInsert;
      if (!contract) throw new Error("BOUNDED_JUNCTION_CONTRACT_MISSING");
      const preview = record(rawPreview);
      const operation = record(preview.junctionOperation);
      if (preview.roadOperationKind !== contract.kind || operation.identityFingerprint !== junctionIdentityFingerprint(contract) ||
        preview.valid !== true || preview.previewOnly !== true || preview.toolAllowApply !== true) {
        throw new Error("BOUNDED_JUNCTION_NATIVE_PREVIEW_IDENTITY_INVALID");
      }
      await waitForAuthoritativeNativeIdle(signal);
      const state = record(await callTool("cs2_game_state", {}, signal));
      const world = record(state.world); const simulation = record(state.simulation);
      if (typeof world.generation !== "string" || !world.generation || simulation.paused !== true ||
        world.nativeOperationBusy !== false || world.nativeOperationStage !== "Idle") throw new Error("BOUNDED_JUNCTION_WORLD_NOT_PAUSED_IDLE");
      const realization = record(record(preview.diagnostics).realization);
      const tempEntities = Array.isArray(realization.generatedTempEntities) ? realization.generatedTempEntities.map(record) : [];
      const originalEdges = tempEntities.filter((item) => item.kind === "EDGE" && item.original !== null && item.original !== undefined)
        .map((item) => record(item.original));
      if (originalEdges.length !== contract.replacementClasses.length || new Set(originalEdges.map(refKey)).size !== originalEdges.length) {
        throw new Error("BOUNDED_JUNCTION_REPLACEMENT_WITNESS_INCOMPLETE");
      }
      const [scanRaw, cableRaw, prefabRaw] = await Promise.all([
        callTool("cs2_spatial", { mode: "scan", roadLimit: 2000 }, signal),
        callTool("cs2_list_roads", { query: "Low-voltage Ground Cable", limit: 500 }, signal),
        callTool("cs2_find_prefabs", { category: "road", query: "Medium Road", limit: 50 }, signal),
      ]);
      const scan = record(scanRaw); const graph = record(scan.roadGraph);
      const graphEdges = Array.isArray(graph.edges) ? graph.edges.map(record) : [];
      const cables = record(cableRaw); const cableEdges = Array.isArray(cables.roads) ? cables.roads.map(record) : [];
      const prefabResult = record(prefabRaw); const prefabs = Array.isArray(prefabResult.prefabs) ? prefabResult.prefabs.map(record) : [];
      if (graph.truncated !== false || cables.truncated === true || cables.hasMore === true || cables.complete === false ||
        prefabs.filter((item) => item.name === "Medium Road" || item.prefab === "Medium Road").length !== 1) {
        throw new Error("BOUNDED_JUNCTION_FRESH_REBIND_SCAN_INCOMPLETE");
      }
      const inspections = await Promise.all(originalEdges.map(async (entity) => ({
        entity: { index: Number(entity.index), version: Number(entity.version) },
        read: record(await callTool("cs2_inspect", { index: Number(entity.index), version: Number(entity.version) }, signal)),
      })));
      const observations: JunctionReplacementObservation[] = inspections.map(({ entity, read }) => {
        const prefab = String(read.prefab ?? "");
        let semanticClass: JunctionReplacementObservation["semanticClass"] = "UNEXPECTED";
        if (prefab === "Invisible Car Path - 1xTwoway") semanticClass = "PUMP_INTERNAL_CAR_PATH";
        else if (prefab === "Invisible Road Path - 2xTwoway") semanticClass = "PUMP_INTERNAL_ROAD_PATH";
        else if (prefab === "Low-voltage Ground Cable") {
          const matches = cableEdges.filter((edge) => refKey(edge.entity) === `${entity.index}:${entity.version}` &&
            [record(edge.start), record(edge.end)].some((point) => Math.hypot(Number(point.x) - contract.segment2Terminal.anchor.x, Number(point.z) - contract.segment2Terminal.anchor.z) <= 0.25));
          semanticClass = matches.length === 1 ? "SEGMENT_2_TERMINAL_CABLE_EDGE" : "SEGMENT_1";
        } else if (prefab === "Small Road") {
          const matches = graphEdges.filter((edge) => refKey(edge.entity) === `${entity.index}:${entity.version}` &&
            edge.prefab === "Small Road" && curvePassesPoint(edge, contract.road.contact));
          semanticClass = matches.length === 1 ? "PUMP_ACCESS_ROAD" : "UNEXPECTED";
        } else if (/water pipe/i.test(prefab)) semanticClass = "WATER_PIPE";
        else if (/pumping station|water pumping/i.test(prefab) || (Array.isArray(read.flags) && read.flags.includes("building"))) semanticClass = "PUMP_BUILDING";
        return { entity, semanticClass };
      });
      const s2Terminal = observations.filter((item) => item.semanticClass === "SEGMENT_2_TERMINAL_CABLE_EDGE");
      const pumpRoad = observations.find((item) => item.semanticClass === "PUMP_ACCESS_ROAD");
      const pumpRoadMatches = pumpRoad ? graphEdges.filter((edge) => refKey(edge.entity) === refKey(pumpRoad.entity) && edge.prefab === "Small Road") : [];
      const pumpRoadEdge = pumpRoadMatches[0];
      const roadContactPosition = pumpRoadEdge ? nativeCurvePointAtXZ(pumpRoadEdge, contract.road.contact) : null;
      const contactStartNode = pumpRoadEdge ? record(pumpRoadEdge.startNode) : {};
      const contactEndNode = pumpRoadEdge ? record(pumpRoadEdge.endNode) : {};
      const contactStartPosition = pumpRoadEdge ? record(pumpRoadEdge.start) : {};
      const contactEndPosition = pumpRoadEdge ? record(pumpRoadEdge.end) : {};
      const contactStartDistance = Math.hypot(Number(contactStartPosition.x) - contract.road.contact.x, Number(contactStartPosition.z) - contract.road.contact.z);
      const contactEndDistance = Math.hypot(Number(contactEndPosition.x) - contract.road.contact.x, Number(contactEndPosition.z) - contract.road.contact.z);
      const contactNode = contactStartDistance <= contactEndDistance ? contactStartNode : contactEndNode;
      const duplicates = graphEdges.filter((edge) => edge.prefab === contract.road.prefab &&
        Math.hypot(Number(record(edge.start).x) - input.x1, Number(record(edge.start).z) - input.z1) <= 0.25 &&
        Math.hypot(Number(record(edge.end).x) - input.x2, Number(record(edge.end).z) - input.z2) <= 0.25);
      if (s2Terminal.length !== 1 || !pumpRoad || pumpRoadMatches.length !== 1 || !roadContactPosition ||
        !Number.isInteger(Number(contactNode.index)) || !Number.isInteger(Number(contactNode.version)) || duplicates.length !== 0) {
        throw new Error("BOUNDED_JUNCTION_SEMANTIC_REBIND_MISMATCH");
      }

      const windRead = record(await callTool("cs2_list_buildings", { query: "WindTurbine03", limit: 64 }, signal));
      const wind = (Array.isArray(windRead.buildings) ? windRead.buildings.map(record) : []).filter((item) => item.prefab === "WindTurbine03");
      if (wind.length !== 1) throw new Error("BOUNDED_JUNCTION_SOURCE_REBIND_NOT_UNIQUE");
      const sourceRef = record(wind[0].entity);
      const connectorRead = record(await callTool("cs2_utility_connectors", { index: Number(sourceRef.index), version: Number(sourceRef.version) }, signal));
      const connectors = Array.isArray(connectorRead.connectors) ? connectorRead.connectors.map(record) : [];
      const sourceConnector = connectors.find((item) => item.type === "electricity");
      if (!sourceConnector) throw new Error("BOUNDED_JUNCTION_SOURCE_CONNECTOR_MISSING");
      const connectorNode = record(sourceConnector.node);
      const topologyFor = async (target: { index: number; version: number }) => record(await callTool("cs2_utility_connectors", {
        index: Number(sourceRef.index), version: Number(sourceRef.version),
        connector: { index: Number(connectorNode.index), version: Number(connectorNode.version) },
        target,
        expectedWorldId: world.worldId, expectedGeneration: world.generation,
      }, signal));
      const [segment2TopologyRaw, pumpRoadTopologyRaw] = await Promise.all([
        topologyFor(s2Terminal[0].entity), topologyFor(pumpRoad.entity),
      ]);
      const segment2Topology = record(record(segment2TopologyRaw.topology).targetNetwork);
      const pumpRoadTopology = record(record(pumpRoadTopologyRaw.topology).targetNetwork);
      if (segment2Topology.targetNetworkReachable !== true || !Array.isArray(pumpRoadTopology.flowNodes) || pumpRoadTopology.flowNodes.length < 1 ||
        !Array.isArray(pumpRoadTopology.targetEndpoints) || pumpRoadTopology.targetEndpoints.length < 2) {
        throw new Error("BOUNDED_JUNCTION_CURRENT_TOPOLOGY_PRECONDITION_FAILED");
      }
      const finance = record(preview.finance);
      const evidence: BoundedJunctionAdmissionEvidence = {
        operationKind: contract.kind,
        identityFingerprint: String(operation.identityFingerprint),
        replacementFingerprint: junctionReplacementFingerprint(observations),
        nativeAllowApply: preview.toolAllowApply === true,
        replacementObservations: observations,
        nativeRoadContact: {
          roadEdge: pumpRoad.entity,
          roadNode: { index: Number(contactNode.index), version: Number(contactNode.version) },
          position: roadContactPosition,
          endpointRole: "START",
        },
        duplicateRisk: "NO",
        segment1Touched: observations.some((item) => item.semanticClass === "SEGMENT_1"),
        waterPipeTouched: observations.some((item) => item.semanticClass === "WATER_PIPE"),
        pumpBuildingTouched: observations.some((item) => item.semanticClass === "PUMP_BUILDING"),
        fullSegment2Rebuild: s2Terminal.length !== 1,
        segment2TerminalLocalReplacementOnly: s2Terminal.length === 1 &&
          observations.filter((item) => item.semanticClass === "SEGMENT_1").length === 0,
        expectedSuccessorLineage: s2Terminal.length === 1 && contract.expectedSuccessors.segment2CableEdges === 1,
        segment2SourceContinuity: segment2Topology.targetNetworkReachable === true,
        pumpRoadFlowComponentContinuous: Array.isArray(pumpRoadTopology.flowNodes) && pumpRoadTopology.flowNodes.length > 0 &&
          Array.isArray(pumpRoadTopology.targetEndpoints) && pumpRoadTopology.targetEndpoints.length >= 2,
        localConnectCompatibleMediumRoad: prefabs.some((item) => item.name === "Medium Road" || item.prefab === "Medium Road"),
        quote: Number(finance.signedAmount),
        quoteSource: finance.sourceKind === "NATIVE_TOOL_TEMP_COST" ? "NATIVE_TOOL_TEMP_COST" : "UNKNOWN",
        nativeTempCount: Number(finance.eligibleTempEntityCount),
      };
      if (operation.nativeCostSource !== evidence.quoteSource || operation.nativeTempCount !== evidence.nativeTempCount ||
        operation.replacementFingerprint !== evidence.replacementFingerprint) throw new Error("BOUNDED_JUNCTION_NATIVE_WITNESS_MISMATCH");
      const afterState = record(await callTool("cs2_game_state", {}, signal));
      if (record(afterState.world).generation !== world.generation || record(afterState.simulation).paused !== true ||
        record(afterState.world).nativeOperationBusy !== false) throw new Error("BOUNDED_JUNCTION_WORLD_CHANGED_DURING_REBIND");
      return { generation: String(world.generation), evidence };
    },
    authorize: options.roadAuthorizationPolicy,
  });
  const executeLegacyActionBatch = async (actions: MayorAction[], signal?: AbortSignal): Promise<MayorBatchResult> => {
    if (actions.some((action) => action.type === "build_road")) {
      throw new Error("production ROAD execution requires the authorized V2 ROAD runtime boundary");
    }
    return MayorBatchResultSchema.parse(
      await callTool("cs2_mayor_execute_actions", { actions }, signal),
    ) as MayorBatchResult;
  };

  const setRoadCandidateAvailability = (
    action: MayorAction,
    outcome: CandidateAvailability,
    revision = resolveSpatialRevision(latestSpatial?.context),
    summary?: MayorPlanningCandidate,
  ) => {
    const key = roadActionKey(action);
    if (!key || !revision) return;
    const outcomes = candidateAvailability.get(revision) ?? new Map<string, CandidateAvailability>();
    if (summary?.id) outcomes.set(summary.id, outcome);
    outcomes.set(key, outcome);
    const sourceDirectionKey = summary ? roadSourceDirectionKey(summary) : null;
    if (sourceDirectionKey) outcomes.set(sourceDirectionKey, outcome);
    const attemptKey = roadAttemptKey(revision, action, summary);
    if (attemptKey) outcomes.set(attemptKey, outcome);
    candidateAvailability.set(revision, outcomes);
    candidateSet = filterUnavailableRoadCandidates(candidateSet, revision, candidateAvailability);
    if (recoveryCandidateSet) {
      recoveryCandidateSet = filterUnavailableRoadCandidates(recoveryCandidateSet, revision, candidateAvailability);
    }
  };

  const setCandidateDisposition = (
    candidateId: string,
    disposition: CandidateDisposition,
    revision = resolveSpatialRevision(latestSpatial?.context),
  ) => {
    if (!revision) return;
    const outcomes = candidateAvailability.get(revision) ?? new Map<string, CandidateDisposition>();
    outcomes.set(candidateId, disposition);
    candidateAvailability.set(revision, outcomes);
    candidateSet = filterUnavailableRoadCandidates(candidateSet, revision, candidateAvailability);
    if (recoveryCandidateSet) {
      recoveryCandidateSet = filterUnavailableRoadCandidates(recoveryCandidateSet, revision, candidateAvailability);
    }
  };

  const recordRoadAttempt = (
    action: MayorAction,
    outcome: RoadAttemptOutcome,
    summary?: MayorPlanningCandidate,
    revision = resolveSpatialRevision(latestSpatial?.context),
  ) => {
    if (!revision) return;
    const key = roadAttemptKey(revision, action, summary);
    if (!key) return;
    setRoadCandidateAvailability(action, outcome === "success" ? "succeeded" : "rejected", revision, summary);
    while (candidateAvailability.size > 8) candidateAvailability.delete(candidateAvailability.keys().next().value!);
  };

  const getSnapshot = async (signal?: AbortSignal, options?: { strategicOnly?: boolean }) => {
    const requestGeneration = spatialGeneration;
    const buildSequence = ++snapshotBuildSequence;
    const snapshot = await withZoneCatalogue(await callTool("cs2_mayor_snapshot", {}, signal), signal);
    // The district builder obtains its own world scan, planning terrain and fresh local safety reads. The urban-design
    // candidate detail below is for the Goal path and costs tens of seconds on a grown city.
    if (options?.strategicOnly) return { ...record(snapshot), schemaVersion: "1.2" };
    let nextUrbanDesignContext: UrbanDesignSnapshotContext | null = null;
    let nextSpatial: NonNullable<typeof latestSpatial> | null = null;
    let nextCandidateSet = candidateSet;
    try {
      const query = candidateQuery(snapshot);
      const [scanValue, detailValue] = await Promise.all([
        callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal),
        callTool(
          "cs2_spatial",
          {
            mode: "detail",
            x: query.x,
            z: query.z,
            radius: query.radius,
            resolution: 24,
          },
          signal,
        ),
      ]);
      const scan = parseSpatialBootstrapScan(scanValue);
      const detail = parseSpatialSiteDetail(detailValue);
      const siteContext = buildUrbanSiteContext({
        world: buildSpatialWorldModel(scan),
        detail,
        snapshot,
      });
      const anchors = buildUrbanPlanningAnchors(siteContext);
      nextUrbanDesignContext = { siteContext, anchors, novelty: summarizeUrbanDesignNovelty(noveltyMemory) };
      nextSpatial = {
        snapshot,
        context: nextUrbanDesignContext,
        detail,
        ownedTiles: scan.tiles.filter((tile) => tile.owned),
        roadEdges: scan.roadGraph.edges,
        scan,
      };
      nextCandidateSet = buildMayorCandidateSet({
        snapshot,
        detail,
        ownedTiles: scan.tiles.filter((tile) => tile.owned),
      });
      if (
        nextCandidateSet.candidates.length > 0 &&
        nextCandidateSet.candidates.every((candidate) => candidate.actionType === "build_road")
      ) {
        const validatedRoadExpansionIds = new Set<string>();
        for (const candidate of nextCandidateSet.registry.values()) {
          if (candidate.action.type !== "build_road") continue;
          try {
            await requireNativePreflight(candidate.action, signal, candidate.summary);
            validatedRoadExpansionIds.add(candidate.summary.id);
          } catch {
            setRoadCandidateAvailability(
              candidate.action,
              "rejected",
              resolveSpatialRevision(nextUrbanDesignContext),
              candidate.summary,
            );
          }
        }
        nextCandidateSet = buildMayorCandidateSet({
          snapshot,
          detail,
          ownedTiles: scan.tiles.filter((tile) => tile.owned),
          validatedRoadExpansionIds,
        });
      }
      if (activeRealization && nextSpatial) {
        const activeAnchor = anchors.find((candidate) => candidate.id === activeRealization?.anchorId);
        if (activeAnchor) {
          const refreshed = realizeUrbanDesignProposal({
            proposal: activeRealization.proposal,
            context: siteContext,
            anchor: activeAnchor,
            snapshot: pinCanonicalRoadAnchors(snapshot, nextSpatial.roadEdges, activeAnchor),
            detail,
            ownedTiles: nextSpatial.ownedTiles,
          });
          nextCandidateSet = await previewUrbanDesignCandidateSet(refreshed.candidateSet, signal);
          if (refreshed.result.status === "no_realization") activeRealization = null;
        } else {
          activeRealization = null;
        }
      }
      nextCandidateSet = filterUnavailableRoadCandidates(
        nextCandidateSet,
        resolveSpatialRevision(nextUrbanDesignContext),
        candidateAvailability,
      );
      if (recoveryCandidateSet) {
        recoveryCandidateSet = filterUnavailableRoadCandidates(
          recoveryCandidateSet,
          resolveSpatialRevision(nextUrbanDesignContext),
          candidateAvailability,
        );
      }
      if (nextCandidateSet.candidates.length === 0 && recoveryCandidateSet) nextCandidateSet = recoveryCandidateSet;
      if (
        buildSequence === snapshotBuildSequence &&
        requestGeneration === spatialGeneration &&
        nextSpatial &&
        nextUrbanDesignContext
      ) {
        spatialGeneration += 1;
        urbanDesignContext = nextUrbanDesignContext;
        latestSpatial = nextSpatial;
        candidateSet = nextCandidateSet;
        if (nextCandidateSet.candidates.length > 0) recoveryCandidateSet = null;
      }
    } catch (error) {
      nextCandidateSet = {
        status: "unavailable",
        candidates: [],
        note: `Actionable candidate discovery unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        ),
        registry: new Map(),
        ownedTiles: [],
      };
    }
    const publishedSpatial = nextSpatial && buildSequence === snapshotBuildSequence && requestGeneration !== spatialGeneration
      ? nextSpatial
      : latestSpatial;
    const publishedContext = nextUrbanDesignContext && buildSequence === snapshotBuildSequence && requestGeneration !== spatialGeneration
      ? nextUrbanDesignContext
      : urbanDesignContext;
    const developmentCapacity =
      publishedSpatial && publishedContext && publishedSpatial.snapshot === snapshot
        ? summarizeDevelopmentCapacity(
            publishedSpatial.detail,
            publishedSpatial.ownedTiles,
            publishedContext,
            nextCandidateSet,
            snapshot,
          )
        : undefined;
    return {
      ...record(snapshot),
      schemaVersion: "1.2",
      ...(publishedContext && publishedSpatial?.snapshot === snapshot ? { urbanDesign: publishedContext } : {}),
      ...(developmentCapacity ? { developmentCapacity } : {}),
      actionablePlanning: {
        status: nextCandidateSet.status,
        candidates: nextCandidateSet.candidates,
        note: nextCandidateSet.note,
      },
    };
  };

  const realizeIntent = async (intent: unknown) => {
    if (!latestSpatial) return { status: "no_realization", reason: "spatial context is unavailable" };
    const resolution = resolveUrbanDesignIntent({
      value: intent,
      context: { siteContext: latestSpatial.context.siteContext, anchors: latestSpatial.context.anchors },
    });
    if (!resolution.proposal || resolution.proposal.status !== "proposal")
      return { status: "no_realization", reason: "intent requested no design proposal" };
    const anchor = latestSpatial.context.anchors.find(
      (candidate) => candidate.id === resolution.intent.preferredAnchorId,
    );
    if (!anchor) return { status: "no_realization", reason: "intent anchor is unavailable" };
    const realizationSnapshot = pinCanonicalRoadAnchors(latestSpatial.snapshot, latestSpatial.roadEdges, anchor);
    const realization = realizeUrbanDesignProposal({
      proposal: resolution.proposal,
      context: latestSpatial.context.siteContext,
      anchor,
      snapshot: realizationSnapshot,
      detail: latestSpatial.detail,
      ownedTiles: latestSpatial.ownedTiles,
    });
    if (realization.result.status === "realized" && realization.result.candidateIds.length > 0) {
      const previewedIds: string[] = [];
      const rejectedByPreview: string[] = [];
      for (const candidateId of realization.result.candidateIds) {
        const candidate = realization.candidateSet.registry.get(candidateId);
        if (!candidate) continue;
        try {
          if (candidate.action.type === "build_road")
            await requireNativePreflight(candidate.action, undefined, candidate.summary);
          previewedIds.push(candidateId);
        } catch {
          rejectedByPreview.push(candidateId);
        }
      }
      const previewed = new Set(previewedIds);
      candidateSet = {
        ...realization.candidateSet,
        candidates: realization.candidateSet.candidates.filter((candidate) => previewed.has(candidate.id)),
        registry: new Map([...realization.candidateSet.registry].filter(([candidateId]) => previewed.has(candidateId))),
      };
      const gatedResult = {
        ...realization.result,
        status: previewedIds.length > 0 ? "realized" : "no_realization",
        candidateIds: previewedIds,
        candidateMetadata: realization.result.candidateMetadata.filter((item) => previewed.has(item.candidateId)),
        rejectedElements: [...realization.result.rejectedElements, ...rejectedByPreview].slice(0, 8),
        constraintReasons:
          previewedIds.length > 0
            ? realization.result.constraintReasons
            : [...realization.result.constraintReasons, "native_preview_rejected_all_candidates"].slice(0, 12),
      };
      if (previewedIds.length === 0) return gatedResult;
      activeRealization = { proposal: resolution.proposal, anchorId: anchor.id };
      return gatedResult;
    }
    return realization.result;
  };

  const requireNativePreflight = async (
    action: MayorAction,
    signal?: AbortSignal,
    summary?: MayorPlanningCandidate,
  ) => {
    if (action.type === "build_road") {
      const result = record(
        await callTool(
          "cs2_spatial",
          {
            mode: "preflight",
            kind: "net",
            prefab: action.prefab,
            x1: action.x1,
            z1: action.z1,
            x2: action.x2,
            z2: action.z2,
          },
          signal,
        ),
      );
      if (result.valid !== true || result.previewOnly !== true) {
        recordRoadAttempt(action, "rejected", summary);
        setRoadCandidateAvailability(action, "rejected", undefined, summary);
        const reason = typeof result.reason === "string" ? result.reason : "native_preview_rejected";
        throw new Error(`road action failed native preview validation: ${reason}`);
      }
    } else if (action.type === "place_building") {
      const result = record(
        await callTool(
          "cs2_spatial",
          {
            mode: "preflight",
            kind: "object",
            prefab: action.prefab,
            x: action.x,
            z: action.z,
            rotation: action.rotation ?? 0,
          },
          signal,
        ),
      );
      if (result.valid !== true || result.previewOnly !== true)
        throw new Error("building action failed native preview validation");
    }
  };
  const requireNativePreflightSequenced = async (
    action: MayorAction,
    signal?: AbortSignal,
    summary?: MayorPlanningCandidate,
  ) => {
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      try {
        await waitForAuthoritativeNativeIdle(signal);
        await requireNativePreflight(action, signal, summary);
        await waitForAuthoritativeNativeIdle(signal);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!/another build operation is in progress|build operation.*busy|BUSY_UNRESOLVED/i.test(reason) || attempt >= 2)
          throw error;
        await waitForAuthoritativeNativeIdle(signal);
      }
    }
  };

  const previewUrbanDesignCandidateSet = async (
    set: MayorCandidateSet,
    signal?: AbortSignal,
  ): Promise<MayorCandidateSet> => {
    const entries = [...set.registry.entries()];
    if (!entries.every(([, candidate]) => candidate.action.type === "build_road")) return set;
    const validEntries: Array<[string, (typeof entries)[number][1]]> = [];
    for (const [candidateId, candidate] of entries) {
      try {
        await requireNativePreflight(candidate.action, signal, candidate.summary);
        validEntries.push([candidateId, candidate]);
      } catch {
      setRoadCandidateAvailability(candidate.action, "rejected", undefined, candidate.summary);
      }
    }
    const valid = new Set(validEntries.map(([candidateId]) => candidateId));
    return {
      ...set,
      candidates: set.candidates.filter((candidate) => valid.has(candidate.id)),
      registry: new Map(validEntries),
    };
  };

  const ensureGrowthOpportunity = async (input: {
    developmentCapacity: LocalDevelopmentCapacity;
    demand: { residential: number | null; commercial: number | null; industrial: number | null; office: number | null };
    preferredPolicy: UrbanDesignDevelopmentPolicy;
    growthDomain?: LocalMayorGrowthDomain;
    signal?: AbortSignal;
  }) => {
    const spatial = latestSpatial;
    const generation = spatialGeneration;
    if (!spatial)
      return { status: "unavailable" as const, reason: "spatial context is unavailable", outcome: "search_incomplete" as const };
    const stale = () =>
      ({
        status: "unavailable" as const,
        reason: "spatial context was replaced while growth search was in flight",
        outcome: "stale_spatial_context" as const,
      });
    const priority = new Map([
      ["road_endpoint", 0],
      ["undeveloped_edge", 1],
      ["gateway", 2],
      ["central_node", 3],
    ]);
    const anchors = [...spatial.context.anchors]
      .filter((anchor) => anchor.kind !== "waterfront_opportunity" && anchor.canonicalSource)
      .sort((left, right) => (priority.get(left.kind) ?? 9) - (priority.get(right.kind) ?? 9) || left.rank - right.rank)
      .slice(0, 8);
    let attempts = 0;
    let deterministicAccepted = 0;
    const dominantDemand =
      Object.entries(input.demand)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "balanced";
    const recoveryPlans = [
      { level: 1 as const, anchors: anchors.slice(0, 4), offsets: [0, 90, -90, 45, -45] },
      { level: 2 as const, anchors: anchors.slice(4), offsets: [0, 90, -90, 45, -45] },
      { level: 3 as const, anchors, offsets: [0, 15, -15, 30, -30, 90, -90] },
    ];
    const checkedSources: string[] = [];
    const residual = buildMayorCandidateSet({
      snapshot: spatial.snapshot,
      detail: spatial.detail,
      ownedTiles: spatial.ownedTiles,
      minimumZoningCells: 4,
      urbanDesignPolicy: {
        developmentPolicy: "infill",
        includeExistingFrontage: true,
        growthDomain: input.growthDomain,
      },
    });
    const residualPreviewed = filterUnavailableRoadCandidates(
      await previewUrbanDesignCandidateSet(residual, input.signal),
      resolveSpatialRevision(spatial.context),
      candidateAvailability,
    );
    if (generation !== spatialGeneration || latestSpatial !== spatial) return stale();
    if (residualPreviewed.candidates.length > 0) {
      candidateSet = residualPreviewed;
      recoveryCandidateSet = candidateSet;
      const developmentCapacity = summarizeDevelopmentCapacity(
        spatial.detail,
        spatial.ownedTiles,
        spatial.context,
        candidateSet,
        spatial.snapshot,
      );
      return {
        status: "available" as const,
        snapshot: {
          ...record(spatial.snapshot),
          urbanDesign: spatial.context,
          developmentCapacity,
          actionablePlanning: {
            status: candidateSet.status,
            candidates: candidateSet.candidates,
            note: "Residual safe frontage supplied a bounded zoning patch; zoning remains ownership/collision validated.",
          },
          localMayorActionability: {
            status: "available",
            reasonCode: "residual_safe_zoning_opportunity_available",
            reason: "bounded residual safe frontage is available",
            recoveryLevel: 4,
            refreshAttempted: true,
          },
        },
        reason: "bounded residual safe zoning opportunity found",
        outcome: "opportunity_found" as const,
        recoveryLevel: 4 as const,
        checkedSources,
      };
    }
    for (const plan of recoveryPlans) {
      for (const anchor of plan.anchors) {
        const canonical = anchor.canonicalSource;
        if (!canonical) continue;
        checkedSources.push(anchor.sourceId);
        const relation = canonical.preferredRoad ?? canonical.incidentRoads[0];
        const edge = spatial.roadEdges.find(
          (candidate) =>
            candidate.entity.index === relation.edge.index && candidate.entity.version === relation.edge.version,
        );
        if (!edge) continue;
        const endpoint = relation.endpointRole === "start" ? edge.start : edge.end;
        const direction =
          relation.endpointRole === "start"
            ? { x: edge.start.x - edge.end.x, z: edge.start.z - edge.end.z }
            : { x: edge.end.x - edge.start.x, z: edge.end.z - edge.start.z };
        const directionLength = Math.hypot(direction.x, direction.z);
        if (directionLength < 1) continue;
        const preferences: RoadExpansionPreferences = {
          seed: `local-growth-${dominantDemand}-${anchor.id}`,
          preferredHeadingDegrees: (Math.atan2(direction.z, direction.x) * 180) / Math.PI,
          headingOffsetsDegrees: plan.offsets,
          headingToleranceDegrees: 0,
          targetLengths: [60, 80, 100],
          topologyPreference: "grid_axis",
          hierarchyPreference: "fine_grain",
        };
        const diagnostics: import("./action-candidates").RoadExpansionAttemptDiagnostic[] = [];
        const pinnedSnapshot = pinCanonicalRoadAnchors(spatial.snapshot, spatial.roadEdges, anchor);
        const generated = buildMayorCandidateSet({
          snapshot: pinnedSnapshot,
          detail: spatial.detail,
          ownedTiles: spatial.ownedTiles,
          forceRoadExpansion: input.preferredPolicy === "expand_first",
          roadExpansionSource: { entity: edge.entity, endpoint },
          urbanDesignPolicy: {
            developmentPolicy: input.preferredPolicy,
            includeExistingFrontage: input.preferredPolicy !== "expand_first",
            growthDomain: input.growthDomain,
            roadExpansion: preferences,
          },
          roadExpansionDiagnostics: diagnostics,
        });
        attempts += diagnostics.length;
        deterministicAccepted += diagnostics.filter((item) => item.outcome === "accepted").length;
        const previewed = filterUnavailableRoadCandidates(
          await previewUrbanDesignCandidateSet(generated, input.signal),
          resolveSpatialRevision(spatial.context),
          candidateAvailability,
        );
        if (generation !== spatialGeneration || latestSpatial !== spatial) return stale();
        if (previewed.candidates.length === 0) continue;
        candidateSet = previewed;
        recoveryCandidateSet = candidateSet;
        const developmentCapacity = summarizeDevelopmentCapacity(
          spatial.detail,
          spatial.ownedTiles,
          spatial.context,
          candidateSet,
          spatial.snapshot,
        );
        const snapshot = {
          ...record(spatial.snapshot),
          urbanDesign: spatial.context,
          developmentCapacity,
          actionablePlanning: {
            status: candidateSet.status,
            candidates: candidateSet.candidates,
            note: "Frontier-aware growth opportunity found from an existing planning anchor; native preview passed.",
          },
          localMayorActionability: {
            status: "available",
            reasonCode: "frontier_growth_opportunity_available",
            reason: "bounded frontier-aware road candidates are available",
            recoveryLevel: plan.level,
            refreshAttempted: true,
          },
        };
        return {
          status: "available" as const,
          snapshot,
          reason: `frontier ${anchor.kind} supplied ${previewed.candidates.length} native-preview candidates`,
          outcome: "opportunity_found" as const,
          recoveryLevel: plan.level,
          checkedSources,
        };
      }
    }

    // The current site's bounded anchors can all be exhausted while the global
    // road catalog still contains another owned frontier. Search those sources
    // with a fresh detail window before declaring the whole site exhausted.
    const catalog = record(record(spatial.snapshot).planningCatalog);
    const catalogAnchors = Array.isArray(catalog.roadAnchors) ? catalog.roadAnchors.map(record).slice(0, 16) : [];
    for (const catalogAnchor of catalogAnchors) {
      const entity = record(catalogAnchor.entity);
      const sourceId = `${String(entity.index)}:${String(entity.version)}`;
      if (!Number.isInteger(entity.index) || !Number.isInteger(entity.version) || checkedSources.includes(sourceId)) continue;
      const start = record(catalogAnchor.start);
      const end = record(catalogAnchor.end);
      const x = [start.x, end.x].every((value) => typeof value === "number") ? (start.x + end.x) / 2 : null;
      const z = [start.z, end.z].every((value) => typeof value === "number") ? (start.z + end.z) / 2 : null;
      if (x === null || z === null) continue;
      checkedSources.push(sourceId);
      let nextDetail: ReturnType<typeof parseSpatialSiteDetail>;
      try {
        nextDetail = parseSpatialSiteDetail(
          await callTool(
            "cs2_spatial",
            { mode: "detail", x, z, radius: 128, resolution: 24 },
            input.signal,
          ),
        );
      } catch {
        continue;
      }
      const nextCandidateSet = filterUnavailableRoadCandidates(
        await previewUrbanDesignCandidateSet(
          buildMayorCandidateSet({
            snapshot: spatial.snapshot,
            detail: nextDetail,
            ownedTiles: spatial.ownedTiles,
            forceRoadExpansion: input.preferredPolicy === "expand_first",
            urbanDesignPolicy: {
              developmentPolicy: input.preferredPolicy,
              includeExistingFrontage: input.preferredPolicy !== "expand_first",
              growthDomain: input.growthDomain,
            },
          }),
          input.signal,
        ),
        resolveSpatialRevision(spatial.context),
        candidateAvailability,
      );
      if (generation !== spatialGeneration || latestSpatial !== spatial) return stale();
      if (nextCandidateSet.candidates.length === 0) continue;
      const nextSiteContext = buildUrbanSiteContext({
        world: buildSpatialWorldModel(spatial.scan),
        detail: nextDetail,
        snapshot: spatial.snapshot,
      });
      const nextContext = {
        siteContext: nextSiteContext,
        anchors: buildUrbanPlanningAnchors(nextSiteContext),
        novelty: summarizeUrbanDesignNovelty(noveltyMemory),
      };
      const nextSpatial = { ...spatial, context: nextContext, detail: nextDetail };
      spatialGeneration += 1;
      urbanDesignContext = nextContext;
      latestSpatial = nextSpatial;
      candidateSet = nextCandidateSet;
      recoveryCandidateSet = candidateSet;
      const developmentCapacity = summarizeDevelopmentCapacity(
        nextDetail,
        spatial.ownedTiles,
        nextContext,
        candidateSet,
        spatial.snapshot,
      );
      return {
        status: "available" as const,
        snapshot: {
          ...record(spatial.snapshot),
          urbanDesign: nextContext,
          developmentCapacity,
          actionablePlanning: {
            status: candidateSet.status,
            candidates: candidateSet.candidates,
            note: "Next bounded catalog source supplied a fresh site candidate set.",
          },
          localMayorActionability: {
            status: "available",
            reasonCode: "frontier_growth_opportunity_available",
            reason: "next bounded catalog source supplied a new site candidate set",
            recoveryLevel: 4,
            refreshAttempted: true,
          },
        },
        reason: `next catalog source ${sourceId} supplied ${candidateSet.candidates.length} candidates`,
        outcome: "opportunity_found" as const,
        recoveryLevel: 4 as const,
        checkedSources,
      };
    }
    return {
      status: "blocked" as const,
      outcome: "search_exhausted" as const,
      reason: `no safe growth opportunity after bounded recovery levels 1-4, ${anchors.length} anchors, ${attempts} attempts, ${deterministicAccepted} deterministic accepts`,
      recoveryLevel: 4 as const,
      checkedSources,
    };
  };

  const runSimulation = async ({ hours, speed }: { hours: number; speed: number }, signal: AbortSignal) => {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 8)
      throw new Error(`INVALID_SIMULATION_SPEED: ${String(speed)}; supported range is 0.5-8`);
    // A progression milestone raises a modal, and a modal PAUSES the game. The
    // window below then waits for an "auto-pause" that has already happened,
    // sees no frame advance, and ends on `CS2 simulation did not auto-pause
    // before timeout` — every tick, until a human clicks it away.
    //
    // This function is the one place every simulation driver goes through: the
    // runtime's two windows, the Gate 1 progression's `runBoundedSimulation`,
    // and the plan path all call it. `blocking-modal-guard.ts` states the rule
    // this restores: "Future simulation drivers must call this bounded hook
    // before advancing time." Measured live (2026-10-01): zero
    // `cs2_read_blocking_modal` calls appeared in a whole growth run, because
    // the guard had been attached to two call sites out of four — and the growth
    // path, `runBoundedSimulation`, was one of the two that had none.
    const modal = await blockingModal.check(signal);
    if (!modal.allowedToContinue) throw new Error(`blocking_modal_guard:${modal.modalClass}`);
    let completed = false;
    try {
      const before = record(await callTool("cs2_game_state", {}, signal));
      const beforeSimulation = record(before.simulation);
      const initialFrame = simulationFrameIndex(before, beforeSimulation);
      const initialGameTime = simulationGameDateTime(before, beforeSimulation);
      const started = record(await callTool("cs2_run_simulation", { hours, speed }, signal));
      let targetFrame = typeof started.targetFrame === "number" ? started.targetFrame : null;
      // Two bounds, both from the shared wait contract. The stall budget is what
      // ends a run that has stopped advancing; the absolute budget is what ends
      // one that keeps advancing but never reaches its target, so neither a
      // frozen Bridge nor an unreachable target frame can hold the tick open.
      const noProgressBudget = simulationNoProgressBudgetMs(hours, speed, options.simulationTimeoutMs);
      const absoluteBudget = simulationAbsoluteBudgetMs(hours, speed, options.simulationTimeoutMs);
      const startedAt = Date.now();
      // The stall clock is reset by world progress, never by a wall clock, and
      // never by `paused === false` alone: a Bridge that reports a running
      // simulation over a frozen frame index is exactly the case that must still
      // time out. `observedProgress` keeps its existing meaning for the success
      // gate below and is deliberately not the stall signal.
      let lastAdvanceAt = startedAt;
      let lastFrame = initialFrame;
      let lastGameTime = initialGameTime;
      let observedProgress = false;
      // A milestone popup pauses the game in the MIDDLE of a window. The window waits for the game's own auto-pause at the target frame, sees a
      // game that is paused short of it with no frame moving, and (measured live 2026-10-04) sat there for the whole 5-minute no-progress budget
      // before the next window's check closed the popup. That state is the feature to look for: paused, short of the target, nothing moving.
      let pausedShortPolls = 0;
      let lastModalLookAt = 0;
      while (!signal.aborted) {
        const now = Date.now();
        // No progress is checked first, and that order is the contract: a run
        // that never advanced is a stall whenever it is noticed, even if a slow
        // poll let the absolute budget elapse in the same step. The absolute
        // budget exists to end a run that IS progressing, never to relabel one
        // that is not.
        if (now - lastAdvanceAt >= noProgressBudget) {
          throw new Error("CS2 simulation did not auto-pause before timeout");
        }
        if (now - startedAt >= absoluteBudget) {
          throw new Error(
            `CS2 simulation exceeded its absolute wait budget (${absoluteBudget}ms) while still progressing`,
          );
        }
        await abortableDelay(options.pollIntervalMs ?? 1_000, signal);
        const game = record(await callTool("cs2_game_state", {}, signal));
        const simulation = record(game.simulation);
        const paused = game.simulationPaused === true || simulation.paused === true;
        const frameIndex = simulationFrameIndex(game, simulation);
        const gameDateTime = simulationGameDateTime(game, simulation);
        const advancedFrame = frameIndex !== null && (lastFrame === null || frameIndex > lastFrame);
        const advancedClock = gameDateTime !== null && lastGameTime !== null && gameDateTime !== lastGameTime;
        if (frameIndex !== null) lastFrame = frameIndex;
        if (gameDateTime !== null) lastGameTime = gameDateTime;
        if (advancedFrame || advancedClock) {
          lastAdvanceAt = Date.now();
          observedProgress = true;
        }
        if (paused === false) observedProgress = true;
        const reachedTarget = targetFrame === null || (frameIndex !== null && frameIndex >= targetFrame);
        if (observedProgress && reachedTarget && paused) {
          completed = true;
          return;
        }
        pausedShortPolls = paused && !reachedTarget && !advancedFrame && !advancedClock ? pausedShortPolls + 1 : 0;
        // Three polls in a row (the Bridge's state lags a poll or two behind a run it has just started), and not more than one look every 10 s.
        if (pausedShortPolls >= (milestoneIsNear() ? 1 : MID_WINDOW_PAUSED_POLLS) && Date.now() - lastModalLookAt >= MID_WINDOW_MODAL_LOOK_INTERVAL_MS) {
          lastModalLookAt = Date.now();
          const midWindow = await blockingModal.check(signal);
          if (!midWindow.allowedToContinue) throw new Error(`blocking_modal_guard:${midWindow.modalClass}`);
          if (midWindow.evidence.dismissSucceeded === true) {
            // The popup is gone and the game with it still holds the old timed run: clear it, run the window again from here.
            await callTool("cs2_run_simulation", { cancel: true }, signal).catch(() => undefined);
            const restarted = record(await callTool("cs2_run_simulation", { hours, speed }, signal));
            targetFrame = typeof restarted.targetFrame === "number" ? restarted.targetFrame : null;
            lastAdvanceAt = Date.now();
            observedProgress = false;
            pausedShortPolls = 0;
          }
        }
      }
      if (signal.aborted) throw signal.reason ?? new Error("Mayor simulation wait aborted");
      throw new Error("CS2 simulation did not auto-pause before timeout");
    } finally {
      // A Runtime stage timeout races this operation. Always clear Bridge's
      // timed-run ownership before the next tick can issue another run.
      if (!completed) {
        try {
          await callTool("cs2_run_simulation", { cancel: true });
        } catch {
          // Preserve the original timeout/abort; cleanup remains best effort.
        }
      }
    }
  };

  /**
   * Run the city until the utility readings show a placed facility working (or `maximumHours` pass). The baseline is read at the start: a placement's
   * effect only appears after the simulation has run, so the reading taken as the wait begins is the one before it. Poll cost is two small reads.
   */
  const awaitUtilityCapacity = async ({ kinds, maximumHours, speed }: { kinds: ReadonlyArray<"electricity" | "water">; maximumHours: number; speed: number },
    signal: AbortSignal) => {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 8) throw new Error(`INVALID_SIMULATION_SPEED: ${String(speed)}; supported range is 0.5-8`);
    const modal = await blockingModal.check(signal);
    if (!modal.allowedToContinue) throw new Error(`blocking_modal_guard:${modal.modalClass}`);
    const startedAt = Date.now();
    const readings = async () => {
      const services = record(await callTool("cs2_city_services", {}, signal));
      const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
      return { electricity: number(record(services.electricity).production), water: number(record(services.water).freshCapacity) };
    };
    await callTool("cs2_set_simulation", { paused: false, speed }, signal);
    const before = await readings();
    const startGame = record(await callTool("cs2_game_state", {}, signal));
    const startFrame = simulationFrameIndex(startGame, record(startGame.simulation));
    const gameHoursSince = (frame: number | null) => (frame !== null && startFrame !== null ? (frame - startFrame) / (FRAMES_PER_GAME_DAY / 24) : 0);
    const noProgressBudget = simulationNoProgressBudgetMs(maximumHours, speed, options.simulationTimeoutMs);
    let lastAdvanceAt = startedAt;
    let lastFrame = startFrame;
    let pausedPolls = 0;
    let lastModalLookAt = 0;
    while (!signal.aborted) {
      if (Date.now() - lastAdvanceAt >= noProgressBudget) throw new Error("CS2 simulation did not advance before timeout");
      await abortableDelay(options.pollIntervalMs ?? 500, signal);
      const game = record(await callTool("cs2_game_state", {}, signal));
      const simulation = record(game.simulation);
      const frame = simulationFrameIndex(game, simulation);
      const paused = game.simulationPaused === true || simulation.paused === true;
      const advanced = frame !== null && lastFrame !== null && frame > lastFrame;
      if (frame !== null) lastFrame = frame;
      if (advanced) lastAdvanceAt = Date.now();
      const now = await readings();
      const shown = kinds.every((kind) => now[kind] !== null && before[kind] !== null && now[kind]! > before[kind]!);
      const hours = gameHoursSince(frame);
      if (shown) return { ready: true, gameHours: hours, wallMs: Date.now() - startedAt };
      if (hours >= maximumHours) return { ready: false, gameHours: hours, wallMs: Date.now() - startedAt };
      // The city was stopped under the wait (a milestone popup, or a pause from elsewhere): the same look and resume as `observeRunningSimulation`.
      pausedPolls = paused && !advanced ? pausedPolls + 1 : 0;
      if (pausedPolls >= (milestoneIsNear() ? 1 : MID_WINDOW_PAUSED_POLLS) && Date.now() - lastModalLookAt >= MID_WINDOW_MODAL_LOOK_INTERVAL_MS) {
        lastModalLookAt = Date.now();
        const midWindow = await blockingModal.check(signal);
        if (!midWindow.allowedToContinue) throw new Error(`blocking_modal_guard:${midWindow.modalClass}`);
        await callTool("cs2_set_simulation", { paused: false, speed }, signal);
        pausedPolls = 0;
      }
    }
    throw signal.reason ?? new Error("Mayor simulation wait aborted");
  };

  /**
   * `runSimulation` without its pause. A timed run (`cs2_run_simulation {hours}`) ends in the Bridge's own auto-pause, and its cleanup is a
   * cancel, which pauses too: measured live (2026-10-04, BALANCED) the city stopped at the end of every window, and with short windows several
   * times a minute. This keeps the city running at `speed` and waits for the same game time by the frame counter (the Bridge's own conversion,
   * `262144 / 24` frames an hour), with the same stall bounds and the same popup guard. It never starts a timed run and never cancels one.
   */
  const observeRunningSimulation = async ({ hours, speed }: { hours: number; speed: number }, signal: AbortSignal) => {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 8)
      throw new Error(`INVALID_SIMULATION_SPEED: ${String(speed)}; supported range is 0.5-8`);
    const modal = await blockingModal.check(signal);
    if (!modal.allowedToContinue) throw new Error(`blocking_modal_guard:${modal.modalClass}`);
    await callTool("cs2_set_simulation", { paused: false, speed }, signal);
    const before = record(await callTool("cs2_game_state", {}, signal));
    const initialFrame = simulationFrameIndex(before, record(before.simulation));
    // Without a frame counter there is no game time to wait for: the city runs on and the next cycle reads it.
    if (initialFrame === null) return;
    const targetFrame = initialFrame + Math.max(0, hours) * (FRAMES_PER_GAME_DAY / 24);
    const noProgressBudget = simulationNoProgressBudgetMs(hours, speed, options.simulationTimeoutMs);
    const absoluteBudget = simulationAbsoluteBudgetMs(hours, speed, options.simulationTimeoutMs);
    const startedAt = Date.now();
    let lastAdvanceAt = startedAt;
    let lastFrame = initialFrame;
    let pausedShortPolls = 0;
    let lastModalLookAt = 0;
    while (!signal.aborted) {
      if (Date.now() - lastAdvanceAt >= noProgressBudget) throw new Error("CS2 simulation did not advance before timeout");
      if (Date.now() - startedAt >= absoluteBudget) {
        throw new Error(`CS2 simulation exceeded its absolute wait budget (${absoluteBudget}ms) while still progressing`);
      }
      await abortableDelay(options.pollIntervalMs ?? 1_000, signal);
      const game = record(await callTool("cs2_game_state", {}, signal));
      const simulation = record(game.simulation);
      const frameIndex = simulationFrameIndex(game, simulation);
      const paused = game.simulationPaused === true || simulation.paused === true;
      const advanced = frameIndex !== null && frameIndex > lastFrame;
      if (frameIndex !== null) lastFrame = Math.max(lastFrame, frameIndex);
      if (advanced) lastAdvanceAt = Date.now();
      if (frameIndex !== null && frameIndex >= targetFrame) return;
      // Something paused the city mid-wait (a milestone popup, or a pause from elsewhere): the same look as `runSimulation`, then run it again.
      pausedShortPolls = paused && !advanced ? pausedShortPolls + 1 : 0;
      if (pausedShortPolls >= (milestoneIsNear() ? 1 : MID_WINDOW_PAUSED_POLLS) && Date.now() - lastModalLookAt >= MID_WINDOW_MODAL_LOOK_INTERVAL_MS) {
        lastModalLookAt = Date.now();
        const midWindow = await blockingModal.check(signal);
        if (!midWindow.allowedToContinue) throw new Error(`blocking_modal_guard:${midWindow.modalClass}`);
        await callTool("cs2_set_simulation", { paused: false, speed }, signal);
        pausedShortPolls = 0;
      }
    }
    throw signal.reason ?? new Error("Mayor simulation wait aborted");
  };

  const utilityCapacity = async (kind: UtilityRecoveryKind) => {
    const snapshot = record(await callTool("cs2_mayor_snapshot"));
    const utility = record(record(snapshot.utilities)[kind]);
    const capacity = utility[kind === "electricity" ? "production" : "capacity"];
    const consumption = utility.consumption;
    const fulfilledConsumption = utility.fulfilledConsumption;
    // The outside connection is part of this city's usable supply, and it is
    // reported as its own figure. Reading only `capacity` would call a city
    // supplied by import unsupplied and build it a generator it does not need.
    const imported = utility.import;
    return {
      revision: resolveSpatialRevision(latestSpatial?.context),
      capacity: typeof capacity === "number" ? capacity : null,
      consumption: typeof consumption === "number" ? consumption : null,
      fulfilledConsumption: typeof fulfilledConsumption === "number" ? fulfilledConsumption : null,
      import: typeof imported === "number" && Number.isFinite(imported) ? imported : null,
      issueActive: scanCityIssues(snapshot).current.some((issue) => issue.kind === `${kind}_shortage`),
    };
  };

  const ensureUtilityCapacity: NonNullable<MayorRuntimePorts["ensureUtilityCapacity"]> = async (input) => {
    const unavailableBefore = {
      revision: input.expectedRevision,
      capacity: null,
      consumption: null,
      fulfilledConsumption: null,
      issueActive: true,
    };
    if (!latestSpatial)
      return {
        ok: false,
        kind: input.kind,
        stage: "blocked",
        reason: "spatial_context_unavailable",
        before: unavailableBefore,
        executedActions: 0,
        trace: ["planning", "blocked"],
      };
    const spatial = latestSpatial;
    return executeSharedUtilityRecovery({
      ...input,
      ports: {
        plan: async (kind) => {
          try {
            const model = buildSpatialWorldModel(spatial.scan);
            const details = new Map<string, ReturnType<typeof parseSpatialSiteDetail>>();
            for (const candidate of model.connectionCandidates.slice(0, 12)) {
              const key = `${candidate.node.entity.index}:${candidate.node.entity.version}`;
              if (details.has(key)) continue;
              details.set(
                key,
                parseSpatialSiteDetail(
                  await callTool("cs2_spatial", {
                    mode: "detail",
                    x: candidate.node.position.x,
                    z: candidate.node.position.z,
                    radius: 512,
                    resolution: 128,
                  }),
                ),
              );
            }
            const selected = evaluateBootstrapSites(model, details).find((candidate) => candidate.valid);
            if (!selected) return { status: "no_safe_site" as const, reason: "no_safe_utility_site" };
            const bounds = model.ownedTiles.flatMap((tile) => (tile.bounds ? [tile.bounds] : []));
            if (bounds.length === 0) return { status: "no_safe_site" as const, reason: "no_owned_utility_area" };
            const minX = Math.min(...bounds.map((item) => item.min.x));
            const minZ = Math.min(...bounds.map((item) => item.min.z));
            const maxX = Math.max(...bounds.map((item) => item.max.x));
            const maxZ = Math.max(...bounds.map((item) => item.max.z));
            const areaDetail = parseSpatialSiteDetail(
              await callTool("cs2_spatial", {
                mode: "detail",
                x: (minX + maxX) / 2,
                z: (minZ + maxZ) / 2,
                radius: Math.min(2_048, Math.ceil(Math.max(maxX - minX, maxZ - minZ) / 2 + 64)),
                resolution: 128,
              }),
            );
            const plan = planBootstrapUtilities(model, selected, areaDetail, spatial.scan.bootstrapAssets);
            const facility = plan.facilities.find(
              (candidate) => candidate.kind === (kind === "electricity" ? "power" : kind),
            );
            return facility
              ? { status: "candidate" as const, facility, reason: "shared_bootstrap_utility_candidate" }
              : { status: "unsupported" as const, reason: "utility_facility_unavailable" };
          } catch (error) {
            return {
              status: "no_safe_site" as const,
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
            };
          }
        },
        preflight: async (action) => {
          try {
            await requireNativePreflightSequenced(action);
            return true;
          } catch {
            return false;
          }
        },
        execute: async (actions) => {
          const result = await withBoundedNativeBuildBackpressure(
            () => executeLegacyActionBatch(actions),
            (candidateBatch) => candidateBatch.results.length > 0 && candidateBatch.results.every(
              (item) => item.ok !== true && /another build operation is in progress|build operation.*busy/i.test(`${item.error ?? ""} ${item.summary ?? ""}`),
            ),
          );
          await waitForAuthoritativeNativeIdle();
          return result;
        },
        readConnectors: async (entity) => {
          const value = record(
            await callTool("cs2_utility_connectors", { index: entity.index, version: entity.version }),
          );
          return (Array.isArray(value.connectors) ? value.connectors : []).slice(0, 8).map((item) => {
            const connector = record(item);
            const node = record(connector.node);
            const position = record(connector.worldPosition);
            const capacity = record(connector.capacity);
            return {
              type: connector.type === "electricity" ? ("electricity" as const) : ("waterPipe" as const),
              node: { index: Number(node.index), version: Number(node.version) },
              worldPosition: { x: Number(position.x), z: Number(position.z) },
              attached: connector.attached === true,
              capacity: {
                ...(typeof capacity.electricity === "number" ? { electricity: capacity.electricity } : {}),
                ...(typeof capacity.fresh === "number" ? { fresh: capacity.fresh } : {}),
                ...(typeof capacity.sewage === "number" ? { sewage: capacity.sewage } : {}),
              },
            };
          });
        },
        readCapacity: utilityCapacity,
        settle: () => runSimulation({ hours: 0.5, speed: 4 }, input.signal),
        currentRevision: async () => resolveSpatialRevision(latestSpatial?.context),
      },
    });
  };

  const resolveActions = async (
    actions: MayorPlanAction[],
    signal?: AbortSignal,
  ): Promise<{
    actions: MayorAction[];
    originalIndices: number[];
    candidates: Array<PrivateMayorCandidate | undefined>;
  }> => {
    const resolved: MayorAction[] = [];
    const originalIndices: number[] = [];
    const resolvedCandidates: Array<PrivateMayorCandidate | undefined> = [];
    let lastResolutionError: unknown;
    const attemptedCandidateIds = new Set(
      actions.filter((action): action is MayorCandidateSelectionAction => action.type === "choose_candidate").map((action) => action.candidateId),
    );
    const pending = actions.map((action, originalIndex) => ({ action, originalIndex }));
    let progressionBudget = 8;
    while (pending.length > 0) {
      const nextPending = pending.shift();
      if (!nextPending) break;
      const { action, originalIndex } = nextPending;
      try {
        if (action.type === "choose_candidate") {
          const revision = resolveSpatialRevision(latestSpatial?.context);
          const candidate = resolveAvailableCandidate(candidateSet, action.candidateId, revision, candidateAvailability);
          if (!candidate) {
            setCandidateDisposition(action.candidateId, "rejected", revision);
            throw new LocalMayorCandidateExecutionError("candidate_not_executable", action.candidateId);
          }
          if (candidate.action.type === "build_road") {
            if (!isCandidateAvailable(revision, candidate.action, candidateAvailability, candidate.summary))
              throw new LocalMayorCandidateExecutionError("candidate_not_executable", action.candidateId);
            resolved.push(candidate.action);
            originalIndices.push(originalIndex);
            resolvedCandidates.push(candidate);
            continue;
          }
          const detail = parseSpatialSiteDetail(
            await callTool(
              "cs2_spatial",
              {
                mode: "detail",
                x: candidate.center.x,
                z: candidate.center.z,
                radius: 64,
                resolution: 16,
              },
              signal,
            ),
          );
          const currentRevision = resolveSpatialRevision(latestSpatial?.context);
          if (candidate.snapshotRevision && currentRevision && candidate.snapshotRevision !== currentRevision) {
            throw new LocalMayorCandidateExecutionError(
              "residual_zoning_stale",
              `revision ${candidate.snapshotRevision} != ${currentRevision}`,
            );
          }
          const validation = validateZoningCandidate(candidate, detail, candidateSet.ownedTiles);
          if (!validation.ok) {
            throw new LocalMayorCandidateExecutionError(validation.code, validation.reason);
          }
          resolved.push(candidate.action);
          originalIndices.push(originalIndex);
          resolvedCandidates.push(candidate);
          continue;
        }
        if (action.type === "zone")
          throw new Error("direct zoning coordinates are not accepted; choose a validated candidate");
        if (action.type === "place_building") await requireNativePreflightSequenced(action, signal);
        resolved.push(action);
        originalIndices.push(originalIndex);
        resolvedCandidates.push(undefined);
      } catch (error) {
        lastResolutionError = error;
        if (action.type === "choose_candidate" && error instanceof LocalMayorCandidateExecutionError && error.code !== "zoning_executor_blocker") {
          setCandidateDisposition(action.candidateId, "rejected", resolveSpatialRevision(latestSpatial?.context));
          if (progressionBudget > 0 && !pending.some((entry) => entry.action.type === "choose_candidate")) {
            const failed = candidateSet.registry.get(action.candidateId);
            const next = candidateSet.candidates.find((candidate) => {
              if (attemptedCandidateIds.has(candidate.id)) return false;
              if (failed && candidate.actionType !== failed.summary.actionType) return false;
              const privateCandidate = candidateSet.registry.get(candidate.id);
              return (
                privateCandidate !== undefined &&
                resolveAvailableCandidate(
                  candidateSet,
                  candidate.id,
                  resolveSpatialRevision(latestSpatial?.context),
                  candidateAvailability,
                ) !== null
              );
            });
            if (next) {
              attemptedCandidateIds.add(next.id);
              pending.push({
                action: { type: "choose_candidate", candidateId: next.id, reason: action.reason, priority: action.priority },
                originalIndex,
              });
              progressionBudget -= 1;
            }
          }
        }
      }
    }
    if (resolved.length === 0 && lastResolutionError) throw lastResolutionError;
    return { actions: resolved, originalIndices, candidates: resolvedCandidates };
  };

  const decideWithProvider = async ({
    systemPrompt,
    userPrompt,
    model,
  }: {
    systemPrompt: string;
    userPrompt: string;
    model: string;
  }): Promise<MayorDecisionResult> => {
    const provider = providerOrThrow(options);
    const agent = provider.proxy ? new HttpsProxyAgent(provider.proxy) : undefined;
    const fetcher: MayorFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const response = await fetcher(deepSeekChatUrl(provider.apiBase), {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 1_800,
        stream: false,
      }),
      ...(agent ? { agent } : {}),
    });
    if (!response.ok) throw new Error(`DeepSeek Mayor request failed (HTTP ${response.status})`);
    const payload = (await response.json()) as DeepSeekCompletionPayload;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek Mayor response had no content");
    const usage = usageFrom(payload);
    const responseModel = payload.model || model;
    const estimatedCost =
      calculateDeepSeekCost(responseModel, usage, new Date(), "CNY") ??
      calculateDeepSeekCost(model, usage, new Date(), "CNY");
    return { content, requestId: payload.id, model: responseModel, usage, estimatedCost };
  };

  const prepareUtilityServiceRoadChild = async (state: Gate1State, signal: AbortSignal): Promise<boolean> => {
    const utilities = state.tranche.utilityExecution?.utilities;
    const plannedUtilityEntry = utilities
      // A service-road child connects an already placed facility. Once K05 has
      // promoted an exhausted site to a new placement scope, the old Road child
      // no longer owns that scope: asking it to reconnect the stranded facility
      // both revives stale routes and can scan multiple city facilities as if
      // they were the new site's binding. Let K05 place the persisted successor
      // site first; only then may a connection child be materialized.
      ? Object.entries(utilities).find(([, utility]) => utilityCanMaterializeServiceRoadChild(utility))
      : undefined;
    if (!plannedUtilityEntry?.[1].plan) return false;
    const [utilityKind, plannedUtility] = plannedUtilityEntry;
    if (!v2FoundationPorts.activateDurableWorld || !v2FoundationPorts.durability || !v2FoundationPorts.greenfieldUtilityBootstrap) {
      throw new Error("GATE1_UTILITY_CHILD_PREPARATION_PORTS_UNAVAILABLE");
    }
    const activation = await v2FoundationPorts.activateDurableWorld(signal);
    if (!activation || activation.blockedReason || !v2FoundationPorts.durability.isExecutionDurablyActivated(activation)) {
      throw new Error(activation?.blockedReason ?? "GATE1_UTILITY_CHILD_WORLD_NOT_DURABLY_ACTIVATED");
    }
    const overview = record(await callTool("cs2_city_overview", {}, signal));
    const treasury = Number(overview.treasury);
    if (!Number.isFinite(treasury) || treasury < 0) throw new Error("GATE1_UTILITY_CHILD_TREASURY_UNKNOWN");
    const deliveredRoad = certifyDeliveredRoad({ state, world: activation.world, journal: v2FoundationPorts.durability.commandJournal });
    const utilityRoad = currentUtilityRoad(state, activation.world,
      deliveredRoad.status === "CERTIFIED" ? deliveredRoad : null);
    const preparation = buildUtilityPreparationInput({
      state,
      world: activation.world,
      treasury,
      kind: utilityKind as "electricity" | "water" | "sewage",
      connectionOnly: true,
      stageBReadOnly: true,
      ...(utilityRoad
        ? { certifiedRoad: utilityRoad.target, certifiedRoadRefs: utilityRoad.refs }
        : { certifiedRoadUnavailableReason: deliveredRoad.status === "CERTIFIED" ? "CURRENT_UTILITY_SERVICE_ENTRY_UNAVAILABLE" : deliveredRoad.reason }),
    });
    const prepared = await v2FoundationPorts.greenfieldUtilityBootstrap.prepare(preparation, signal);
    if (prepared.status !== "READY") throw new Error(`GATE1_UTILITY_CHILD_PREPARATION_BLOCKED:${prepared.reason}`);
    // A current-facility connection plan may have only a direct cable after
    // the certified service road is already delivered. In that case there is
    // no utility-road child to materialize; K05 proceeds to the exact network
    // command path using the same authoritative binding.
    if (prepared.selected?.primitive === "direct-cable") return false;
    const refreshed = v2FoundationPorts.durability.projectState();
    const refreshedRoadTaskId = refreshed.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
      ? refreshed.tranche.currentTaskIds?.ROAD_CONNECTION
      : undefined;
    const refreshedRoadTask = refreshed.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION
      ? refreshedRoadTaskId
        ? refreshed.tasks.find((task) => task.id === refreshedRoadTaskId && task.kind === "ROAD_CONNECTION")
        : refreshed.tasks.find((task) => task.kind === "ROAD_CONNECTION")
      : undefined;
    const amendmentId = refreshedRoadTask?.childOperationAmendmentId ?? refreshedRoadTask?.childOperationAmendmentIds?.[0];
    const amendment = amendmentId
      ? v2FoundationPorts.durability.utilityBudgetAmendments().find((item) => item.amendmentId === amendmentId)
      : undefined;
    if (!amendment?.exactRoadInput || amendment.executionUseStatus !== "UNUSED") {
      throw new Error("GATE1_UTILITY_CHILD_OPERATION_NOT_DURABLY_MATERIALIZED");
    }
    return true;
  };

  const planAlternateUtilitySite = async (state: Gate1State, signal: AbortSignal) => {
    const utilities = state.tranche.utilityExecution?.utilities;
    const selected = utilities ? Object.entries(utilities).find(([, utility]) => utility.stage === "PLACED" && utility.plan) : undefined;
    if (!selected?.[1].plan || !v2FoundationPorts.activateDurableWorld ||
      !v2FoundationPorts.greenfieldUtilityBootstrap?.planAlternateFacilitySite) return null;
    const [utilityKind] = selected;
    const kind = utilityKind as "electricity" | "water" | "sewage";
    const activation = await v2FoundationPorts.activateDurableWorld(signal);
    if (!activation || activation.blockedReason || !v2FoundationPorts.durability?.isExecutionDurablyActivated(activation)) {
      throw new Error(activation?.blockedReason ?? "GATE1_ALTERNATE_UTILITY_SITE_WORLD_NOT_DURABLY_ACTIVATED");
    }
    const overview = record(await callTool("cs2_city_overview", {}, signal));
    const treasury = Number(overview.treasury);
    if (!Number.isFinite(treasury) || treasury < 0) throw new Error("GATE1_ALTERNATE_UTILITY_SITE_TREASURY_UNKNOWN");
    const deliveredRoad = certifyDeliveredRoad({ state, world: activation.world, journal: v2FoundationPorts.durability.commandJournal });
    const utilityRoad = currentUtilityRoad(state, activation.world,
      deliveredRoad.status === "CERTIFIED" ? deliveredRoad : null);
    const preparation = buildUtilityPreparationInput({
      state, world: activation.world, treasury, kind, connectionOnly: false, stageBReadOnly: true,
      ...(utilityRoad
        ? { certifiedRoad: utilityRoad.target, certifiedRoadRefs: utilityRoad.refs }
        : { certifiedRoadUnavailableReason: deliveredRoad.status === "CERTIFIED" ? "CURRENT_UTILITY_SERVICE_ENTRY_UNAVAILABLE" : deliveredRoad.reason }),
    });
    return v2FoundationPorts.greenfieldUtilityBootstrap.planAlternateFacilitySite(preparation, signal);
  };

  // Production Gate 1 lifecycle owner. It advances the durable Gate 1 state
  // machine through the same runner the battlefield harness uses, bound to the
  // activated world. It owns no identity, writes no stage, and contains no
  // per-Skill branch.
  const v2Gate1Progression = createV2Gate1Progression({
    foundation: v2FoundationPorts,
    commissionZoningUtilities: async (_observedState, signal) => {
      // A native INVALID service-road candidate has no Apply command and does
      // not justify blocking the residential project. Retire that failed exact
      // candidate, return ownership to its last delivered parent, and let K05
      // choose another bounded route candidate.
      const durability = v2FoundationPorts.durability;
      let planningEpoch: string | null = null;
      let activeBrainStrategy: UtilityStrategy | null = null;
      if (durability && v2FoundationPorts.activateDurableWorld) {
        const activation = await v2FoundationPorts.activateDurableWorld(signal);
        if (activation && !activation.blockedReason && durability.isExecutionDurablyActivated(activation)) {
          planningEpoch = ledgerEpoch({
            worldId: activation.world.worldId,
            checkpointId: activation.world.checkpointId,
            generation: activation.world.generation,
            branchId: durability.snapshot().executionBranch?.branchId ?? "unbound-branch",
            domainRevision: v2FoundationPorts.worldState.revision("UTILITY"),
          });
          const current = durability.projectState();
          const roadId = current.tranche.currentTaskIds?.ROAD_CONNECTION;
          const roadTask = roadId ? current.tasks.find((task) => task.id === roadId && task.kind === "ROAD_CONNECTION") : undefined;
          const rejection = roadTask?.terminalOutcomeId
            ? current.journal.find((entry) => entry.id === roadTask.terminalOutcomeId && entry.taskId === roadTask.id)
            : undefined;
          const parent = roadTask?.utilityRoadParentTaskId
            ? current.tasks.find((task) => task.id === roadTask.utilityRoadParentTaskId && task.kind === "ROAD_CONNECTION" &&
              task.trancheId === current.tranche.id && task.status === "SUCCEEDED" && task.terminalOutcomeId !== null)
            : undefined;
          if (current.project.status === "BLOCKED" && current.intent.status === "BLOCKED" &&
            current.tranche.stage === "ROAD_DELIVERED" && roadTask?.utilityRoadParentTaskId && roadTask.status === "BLOCKED" &&
            rejection?.execution === "NOT_REQUIRED" && rejection.commandId === null &&
            rejection.reason.includes("NO_FEASIBLE_GATE1_ROAD_CANDIDATE") && parent && !roadTask.activeCommandId) {
            const child = roadTask.childOperationAmendmentId
              ? durability.utilityBudgetAmendments().find((entry) => entry.amendmentId === roadTask.childOperationAmendmentId)
              : undefined;
            if (child?.reason === "UTILITY_SERVICE_ROAD_CHILD_OPERATION" && child.status === "ACTIVE" &&
              child.executionUseStatus === "UNUSED") {
              roadTask.status = "FAILED";
              current.project.status = "ACTIVE";
              current.intent.status = "ACTIVE";
              current.tranche.currentTaskIds = { ...current.tranche.currentTaskIds, ROAD_CONNECTION: parent.id };
              durability.saveProjectState(current);
            }
          }
        }
      }
      let outcome: Awaited<ReturnType<typeof v2ProductionSkillRuntime.dispatch>> | null = null;
      const scopedResidentialCount = async (state: Gate1State | null): Promise<number | null> => {
        if (!state || !v2FoundationPorts.observation) return null;
        try {
          // A building census inside one scope: the detail grid is the whole
          // question, so the snapshot and the road-graph scan are declined.
          const envelope = await v2FoundationPorts.observation.capture({
            spatialDetail: {
              x: state.tranche.target.center.x,
              z: state.tranche.target.center.z,
              radius: Math.max(64, state.tranche.target.radius),
              resolution: 16,
            },
            globalSources: [],
            signal,
          });
          const source = envelope.sources.spatialDetail;
          if (envelope.coherence === "UNKNOWN" || source.status !== "AVAILABLE" || !source.data) return null;
          return source.data.buildings.filter((building) =>
            building.prefab.toLowerCase().includes("residential") &&
            Math.hypot(building.position.x - state.tranche.target.center.x,
              building.position.z - state.tranche.target.center.z) <= state.tranche.target.radius).length;
        } catch {
          return null;
        }
      };
      // Each utility family is a separate Brain decision. Re-observe after each
      // successful action and derive its first unsatisfied predicate from the
      // durable authoritative readback before selecting a capability.
      const activeGoalOrder = durability?.snapshot().goalWorkOrders?.find((item) =>
        item.workOrderId === durability.snapshot().activeGoalWorkOrderId);
      const scopedUtilityGoal = activeGoalOrder ? utilityKindFromServiceGoalId(activeGoalOrder.goalId) : undefined;
      /**
       * Hand a water Goal's spent site scope back to the Goal-scoped work-order
       * machinery and open the next one.
       *
       * A reservation that cannot host a source the planner will serve is not a
       * reason for the Goal to stop; it is a reason to look somewhere else. The
       * successor is an ordinary goal-scoped work order: its own reservation,
       * its own bounded prerequisite chain, its own admission, its own budget.
       * Nothing here mints authority or widens a threshold 鈥?a scope that turns
       * out to be unusable is simply replaced, exactly as a Goal whose
       * prerequisite chain closed is.
       */
      const openNextUtilityGoalSiteScope = async (requestedGoalId: string, why: string): Promise<
        | { status: "ACTIVATED"; reason: string }
        | { status: "SCOPE_BUDGET_EXHAUSTED"; reason: string }
        | { status: "ADMISSION_FAILED"; reason: string }
      > => {
        const spent = utilityGoalSiteScopes(durability?.snapshot().goalWorkOrders ?? []);
        if (spent.length >= MAXIMUM_UTILITY_GOAL_SITE_SCOPES) {
          return { status: "SCOPE_BUDGET_EXHAUSTED", reason: `WATER_GOAL_SITE_SCOPE_BUDGET_EXHAUSTED:${why}` };
        }
        const nextGoalId = nextUtilityGoalSiteScopeId(requestedGoalId, spent);
        try {
          // The scope inherits the Goal's own deliverable. A utility service
          // Goal's is the utility (`WAITING_FOR_OCCUPANCY`, the stage the
          // runtime's own goal derivation gives `PROVIDE_SERVICE`), and without
          // it the scope defaults to `OCCUPIED` and walks the residential growth
          // ladder — which stops the tranche at `ZONED_WAITING_FOR_BUILDING`,
          // the one stage that no longer admits the very utility execution the
          // Goal exists to deliver.
          const admission = record(await v2ProductionSkillRuntime.ensureGoalWorkOrder(
            { goalId: nextGoalId, completionStage: "WAITING_FOR_OCCUPANCY" }));
          v2ProductionSkillRuntime.invalidateReadiness();
          const activeGoalId = typeof admission.activeGoalId === "string" ? admission.activeGoalId : nextGoalId;
          return { status: "ACTIVATED", reason: `GOAL_WORK_ORDER_ACTIVATED:${activeGoalId}` };
        } catch (error) {
          return { status: "ADMISSION_FAILED", reason: `WATER_GOAL_WORK_ORDER_ADMISSION_FAILED:${
            error instanceof Error ? error.message : String(error)}` };
        }
      };
      /**
       * Goals whose bounded work is spent for this planning epoch.
       *
       * A Goal that cannot act is a parked Goal, not a stopped Brain. Reaching
       * the end of one Goal's bounded ladder says nothing about the others: the
       * electricity network Gap, the tranche's own zoning, and every later
       * service still have executable work, and the city only keeps growing if
       * the pass keeps making the decisions that ARE executable. So an exhausted
       * Goal is recorded here (and in the durable ledger, which is scoped to the
       * planning epoch and therefore re-opens when the world, branch or strategy
       * revision changes) and the pass moves on instead of handing the whole
       * session back.
       */
      const parkedGoals: string[] = [];
      /**
       * Utility families whose only outstanding Gap is a wait this pass cannot
       * resolve, in a pass that is not that family's own turn.
       *
       * `SERVICE_DELIVERED` is the one Gap no utility capability produces:
       * `utilityFactsFromEvidence` sets `serviceDelivered` to false by
       * construction for a city-scoped read, because Gate1's per-building
       * consumer readback owns that predicate — and that readback runs AFTER
       * zoning. Waiting for it from the pre-zoning commissioning pass is a
       * livelock, not a wait: the only thing that could change this tranche's
       * consumers is the zoning the wait is holding back. Measured live
       * (2026-09-30): four ticks, sixteen bounded simulations, journal flat,
       * `ZONING` still `PENDING`.
       */
      const awaitingWorldGoals: string[] = [];
      const utilityKinds = scopedUtilityGoal ? [scopedUtilityGoal] as const : ["electricity", "water", "sewage"] as const;
      for (const utilityKind of utilityKinds) {
        const current = durability?.projectState();
        const consumerCount = await scopedResidentialCount(isGate1ProjectState(current) ? current : null);
        const utility = isGate1ProjectState(current)
          ? current.tranche.utilityExecution?.utilities[utilityKind]
          : undefined;
        if (utility?.stage === "SERVICE_CERTIFIED") continue;
        const facilityExists = !!utility?.facility || utility?.serviceEvidence?.supplyExists === true;
        const physicalConnection = utility?.serviceEvidence?.networkConnected === true;
        // The doctrine's first question, answered from the city's own read
        // rather than from this scope's evidence. A scope's evidence only
        // exists once it has a facility, so judging by it made every fresh
        // tranche re-derive FACILITY_AVAILABLE and put a second generator
        // beside a city that was already supplied.
        const cityUtility = await utilityCapacity(utilityKind);
        const supplied = cityUtility.capacity === null || cityUtility.import === null
          ? null
          : cityUtility.capacity + cityUtility.import;
        const utilityFacts = utilityFactsFromEvidence({
          evidence: utility?.serviceEvidence ?? null,
          facilityExists,
          facilityAccessible: facilityExists && !!utility?.connector,
          physicalConnection,
          scopedConsumerCount: consumerCount,
          existingUsableCapacity: supplied !== null && cityUtility.consumption !== null &&
            supplied > 0 && supplied >= cityUtility.consumption,
        });
        const gap = deriveUtilityGap(`UTILITY_SERVICE:${utilityKind}:city`, utilityKind, utilityFacts);
        if (!gap) continue;
        const capability = chooseUtilityCapability(gap.gap);
        if (!capability) return { status: "PLANNING_HANDOFF", reason: `BRAIN_NO_CAPABILITY_FOR_GAP:${gap.gap}` };
        if (utilityGapIsWaitOnly(gap.gap)) {
          // This Gap is a wait, not a construction. Dispatching it into the
          // utility workflow would submit a facility for a city whose observed
          // supply already covers its observed load — the over-build the
          // admission comparison exists to prevent.
          //
          // Whether the wait may hold the CALLER back depends on whose turn it
          // is. When the active Goal is this family's own service Goal, the wait
          // is that Goal's answer and the Brain has to hear it.
          if (scopedUtilityGoal) {
            return { status: "PLANNING_HANDOFF",
              reason: `BRAIN_UTILITY_GAP_AWAITS_WORLD:${utilityKind}:${gap.gap}` };
          }
          // In the pre-zoning commissioning pass it must not gate the tranche.
          // Services are a planning input to zoning, not a gate on it: record
          // the wait and let the tranche take its own next step, which is the
          // only thing that can produce the consumers this Gap is waiting for.
          // Every other Gap — capacity, connection, reachability, an explicit
          // service failure — still dispatches and still blocks.
          awaitingWorldGoals.push(`${utilityKind}:${gap.goalId}:BRAIN_UTILITY_GAP_AWAITS_WORLD:${gap.gap}`);
          continue;
        }
        const boundProject = isGate1ProjectState(current) ? current : null;
        if (boundProject && planningEpoch) {
          if (boundProject.brainLedger?.planningEpoch !== planningEpoch) {
            boundProject.brainLedger = { planningEpoch, entries: [] };
          }
        }
        const goalId = gap.goalId;
        const prior = boundProject?.brainLedger?.entries.filter((entry) => entry.goalId === goalId) ?? [];
        const strategy = nextUtilityStrategy(gap.gap, prior, utilityFacts);
        if (!strategy) {
          const latestGapOutcome = [...prior].reverse().find((entry) => entry.gap === gap.gap)?.lastOutcome ?? "";
          const exhaustedMarker = UTILITY_RESERVATION_EXHAUSTION_OUTCOMES
            .find((marker) => latestGapOutcome.includes(marker));
          if ((utilityKind === "water" || utilityKind === "sewage") && gap.gap === "FACILITY_AVAILABLE" &&
            (scopedUtilityGoal === undefined || scopedUtilityGoal === utilityKind) && exhaustedMarker) {
            // This reservation's real placement capability is spent. The next Brain
            // action is a fresh, bounded site admission, never a duplicate K05
            // attempt against the same reservation. Each admitted scope retains its
            // own durable lineage, and the scope budget still bounds how many
            // reservations one Goal may claim.
            //
            // Both piped utilities escape this way. Sewage was excluded, so a
            // sewage Goal whose reservation could not host an outlet had no move
            // left at all and the same scope was re-attempted until the Brain
            // parked it.
            const successor = await openNextUtilityGoalSiteScope(goalId, exhaustedMarker);
            if (successor.status === "ACTIVATED") return { status: "PLANNING_HANDOFF", reason: successor.reason };
            // The bounded scope budget is spent, or no further scope can be
            // admitted. Either way this Goal is parked, not the pass.
            parkedGoals.push(`${goalId}:${successor.reason}`);
            continue;
          }
          parkedGoals.push(`${goalId}:BRAIN_STRATEGIES_EXHAUSTED:${gap.gap}`);
          continue;
        }
        activeBrainStrategy = strategy;
        try {
          outcome = await v2ProductionSkillRuntime.dispatch({
            skillId: "skill.K05", utilityKind, capabilityId: capability.capabilityId, strategyId: strategy,
          }, signal);
        } finally {
          v2ProductionSkillRuntime.invalidateReadiness();
        }
        const afterProject = durability?.projectState();
        const afterConsumerCount = await scopedResidentialCount(isGate1ProjectState(afterProject) ? afterProject : null);
        const afterUtility = isGate1ProjectState(afterProject)
          ? afterProject.tranche.utilityExecution?.utilities[utilityKind]
          : undefined;
        const afterFacts = utilityFactsFromEvidence({
          evidence: afterUtility?.serviceEvidence ?? null,
          facilityExists: !!afterUtility?.facility || afterUtility?.serviceEvidence?.supplyExists === true,
          facilityAccessible: (!!afterUtility?.facility || afterUtility?.serviceEvidence?.supplyExists === true) && !!afterUtility?.connector,
          physicalConnection: afterUtility?.serviceEvidence?.networkConnected === true,
          scopedConsumerCount: afterConsumerCount,
        });
        const progressed = outcome.status === "SUCCESS" && meaningfulProgress({ before: [false],
          after: [utilityActionMadeGapProgress(gap.gap, afterFacts, true)] });
        if (isGate1ProjectState(afterProject) && planningEpoch) {
          if (afterProject.brainLedger?.planningEpoch !== planningEpoch) afterProject.brainLedger = { planningEpoch, entries: [] };
          const previousCount = afterProject.brainLedger.entries.filter((entry) => entry.goalId === goalId &&
            entry.gap === gap.gap && entry.strategy === strategy).at(-1)?.noProgressCount ?? 0;
          afterProject.brainLedger.entries.push({ goalId, gap: gap.gap, strategy, planningEpoch,
            noProgressCount: progressed ? 0 : previousCount + 1,
            exhausted: !progressed && previousCount + 1 >= 2,
            // Preserve the bounded adapter failure code in the ledger summary;
            // status alone collapses native preflight, binding, and planner
            // outcomes into the same FAILED bucket and hides the actual seam.
            //
            // A facility Gap also carries the admission comparison that selected
            // the strategy, so what was considered 鈥?and what was refused for
            // having no execution path 鈥?is readable from the durable state
            // instead of having to be inferred from the placement.
            lastOutcome: `${outcome.error ?? outcome.status}${
              gap.gap === "FACILITY_AVAILABLE"
                ? `:DOCTRINE=${facilityGapOptions(utilityFacts).map((option) => `${option.tier}=${option.availability}`).join(",")}`
                : ""}` });
          durability?.saveProjectState(afterProject);
        }
        if (outcome.status !== "SUCCESS" && utilityKind === "water" &&
          /NO_SUPPORTED_WATER_TOPOLOGY/.test(outcome.error ?? "") && !scopedUtilityGoal) {
          // The current reservation contains no planner-supported water source.
          //
          // Re-admit the Goal itself first: its own admission searches for a
          // reservation that CAN host a source, and derives a bounded Road
          // prerequisite when the source it finds is out of the road network's
          // reach. Only when that admission cannot find a legal site at all is
          // the *scope* the problem, and the Goal moves to the next one through
          // the same Goal-scoped machinery rather than failing in place.
          try {
            const admission = record(await v2ProductionSkillRuntime.ensureGoalWorkOrder({ goalId }));
            v2ProductionSkillRuntime.invalidateReadiness();
            const activeGoalId = typeof admission.activeGoalId === "string" ? admission.activeGoalId : goalId;
            return { status: "PLANNING_HANDOFF", reason: `GOAL_WORK_ORDER_ACTIVATED:${activeGoalId}` };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!/NO_ELIGIBLE_SITE|NO_VALID_SITE|NO_STARTER_ANCHOR/.test(reason)) {
              return { status: "PLANNING_HANDOFF", reason: `WATER_GOAL_WORK_ORDER_ADMISSION_FAILED:${reason}` };
            }
            const successor = await openNextUtilityGoalSiteScope(goalId, reason);
            if (successor.status === "ACTIVATED") return { status: "PLANNING_HANDOFF", reason: successor.reason };
            parkedGoals.push(`${goalId}:${successor.reason}`);
            continue;
          }
        }
        if (outcome.status !== "SUCCESS") break;
      }
      if (!outcome) {
        // Nothing was dispatchable. If that is because every Goal this pass could
        // consider has spent its bounded work, say so explicitly: the caller
        // continues with the rest of the tranche instead of treating the whole
        // session as finished. A family whose only Gap is a wait is the same
        // instruction for the same reason, and is named separately so the
        // evidence distinguishes "spent" from "waiting on the world".
        if (parkedGoals.length > 0) {
          return { status: "PARKED" as const, reason: `BRAIN_GOALS_PARKED:${parkedGoals.join("|")}` };
        }
        return awaitingWorldGoals.length > 0
          ? { status: "PARKED" as const,
              reason: `BRAIN_UTILITY_GAP_AWAITS_WORLD_PARKED:${awaitingWorldGoals.join("|")}` }
          : { status: "READY" as const };
      }
      if (outcome.status === "SUCCESS") return { status: "READY" };
      if (outcome.status === "WAITING") return { status: "WAITING", reason: outcome.error };
      const currentProjectAfterK05 = durability?.projectState();
      const utilityPlanningExhausted = currentProjectAfterK05?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION &&
        Object.values(currentProjectAfterK05.tranche.utilityExecution?.utilities ?? {}).some((utility) =>
          utility.stage === "PLACED" && !!utility.plan && (
            utility.connectionReplan.replanCount >= utility.connectionReplan.maximumReplans ||
            utility.connectionReplan.journal.some((entry) => entry.event === "UTILITY_SITE_CONTEXT_EXHAUSTED")
          ));
      if (utilityPlanningExhausted) {
        // K05 reports local connection exhaustion. It does not own the next
        // city strategy: keep the same authoritative network Gap open and let
        // the Brain advance its bounded Runtime Skill ladder. Alternate
        // facility placement is admitted only at the Skill's final strategy.
        if (activeBrainStrategy !== "FACILITY_REPLACEMENT_LAST_RESORT") {
          return { status: "REPLAN", reason: `BRAIN_UTILITY_STRATEGY_EXHAUSTED:${activeBrainStrategy ?? "UNKNOWN"}` };
        }
        const latest = durability?.projectState();
        if (latest?.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION) {
          const utilityEntry = latest.tranche.utilityExecution?.utilities
            ? Object.entries(latest.tranche.utilityExecution.utilities).find(([, utility]) => utility.stage === "PLACED" && utility.plan)
            : undefined;
          if (!utilityEntry) return { status: "PLANNING_HANDOFF", reason: `K05_UTILITY_SITE_CONTACT_OPTIONS_EXHAUSTED:${outcome.error}` };
          const utility = utilityEntry[1];
          const journal = utility.connectionReplan.journal;
          const utilityScope = latest.tranche.utilityExecution?.scope;
          if (utility.facility && utility.connector && utilityScope &&
            !journal.some((entry) => entry.event === "UTILITY_SITE_CONTEXT_EXHAUSTED" && entry.siteFingerprint && (() => {
              try {
                const context = JSON.parse(entry.siteFingerprint) as Record<string, unknown>;
                const facility = context.facility as Record<string, unknown> | undefined;
                const position = facility?.position as Record<string, unknown> | undefined;
                return context.projectId === latest.project.id && context.trancheId === latest.tranche.id &&
                  context.worldEpochId === utilityScope.worldEpochId && context.kind === utility.kind &&
                  Math.hypot(Number(position?.x) - utility.plan!.position.x,
                    Number(position?.z) - utility.plan!.position.z) < 1.5;
              } catch { return false; }
            })())) {
            const siteFingerprint = JSON.stringify({ kind: utilityEntry[0], objectiveId: utilityScope.intentId,
              projectId: utilityScope.projectId, trancheId: utilityScope.trancheId, worldEpochId: utilityScope.worldEpochId,
              topologyRevision: utilityScope.topologyRevision, utilityRevision: v2FoundationPorts.worldState.revision("UTILITY"),
              facility: { entity: utility.facility.entity, prefab: utility.facility.prefab, position: utility.facility.position },
              connector: { entity: utility.connector.node, position: utility.connector.worldPosition },
              roads: utilityScope.certifiedRoadRefs.map((ref) => `${ref.index}:${ref.version}`).sort() });
            journal.push({ event: "UTILITY_SITE_CONTEXT_EXHAUSTED", siteFingerprint,
              sitePosition: utility.facility.position, reason: "BOUNDED_CONNECTION_COURSES_EXHAUSTED" });
            durability!.saveProjectState(latest);
          }
          const exhaustedSite = [...journal].reverse().find((entry) => {
            if (entry.event !== "UTILITY_SITE_CONTEXT_EXHAUSTED" || !entry.siteFingerprint) return false;
            try {
              const context = JSON.parse(entry.siteFingerprint) as Record<string, unknown>;
              const facility = context.facility as Record<string, unknown> | undefined;
              const position = facility?.position as Record<string, unknown> | undefined;
              return context.projectId === latest.project.id && context.trancheId === latest.tranche.id &&
                context.worldEpochId === latest.tranche.utilityExecution?.scope.worldEpochId &&
                context.topologyRevision === utility.planBinding?.topologyRevision && context.kind === utility.kind &&
                Math.hypot(Number(position?.x) - utility.plan!.position.x,
                  Number(position?.z) - utility.plan!.position.z) < 1.5;
            } catch { return false; }
          })?.siteFingerprint;
          if (!exhaustedSite) return { status: "PLANNING_HANDOFF", reason: `K05_UTILITY_SITE_CONTACT_OPTIONS_EXHAUSTED:${outcome.error}` };
          const priorSiteOption = journal.find((entry) => entry.event === "ALTERNATE_UTILITY_SITE_SELECTED" &&
            entry.exhaustedSiteFingerprint === exhaustedSite);
          try {
            const alternate = await planAlternateUtilitySite(latest, signal) as PlannedUtilityFacility | null;
            if (!alternate) return { status: "PLANNING_HANDOFF", reason: `K05_ALL_BOUNDED_UTILITY_SITE_OPTIONS_EXHAUSTED:${outcome.error}` };
            const alternateSiteFingerprint = JSON.stringify({ kind: utilityEntry[0], prefab: alternate.prefab,
              position: alternate.position, roadDistance: alternate.siteEvidence.roadDistance,
              connectionDistance: alternate.siteEvidence.connectionDistance });
            if (priorSiteOption &&
              (priorSiteOption.alternateSiteFingerprint ?? priorSiteOption.siteFingerprint) !== alternateSiteFingerprint) {
              return { status: "PLANNING_HANDOFF", reason: "K05_ALTERNATE_SITE_IDENTITY_CHANGED_DURING_SUCCESSOR_RECOVERY" };
            }
            if (!priorSiteOption) journal.push({ event: "ALTERNATE_UTILITY_SITE_SELECTED", siteFingerprint: alternateSiteFingerprint,
              alternateSiteFingerprint, exhaustedSiteFingerprint: exhaustedSite,
              sitePosition: alternate.position, reason: "NEXT_RANKED_UTILITY_SITE_AFTER_BOUNDED_CONTACT_EXHAUSTION" });
            const activation = await v2FoundationPorts.activateDurableWorld?.(signal);
            const executionScope = latest.tranche.utilityExecution?.scope;
            const predecessorPlacementScopeId = utility.placementScopeId ?? "utility-placement:legacy";
            const predecessorOperations = activation && executionScope
              ? durability!.utilityPlacementOperations({ projectId: latest.project.id, trancheId: latest.tranche.id,
                  reservationRef: latest.tranche.reservationRef, utilityKind: utilityEntry[0] as UtilityRecoveryKind,
                  placementScopeId: predecessorPlacementScopeId })
              : null;
            const promoted = createUtilityPlacementSuccessor({
              utility,
              plan: alternate,
              alternateSiteFingerprint,
              exhaustedSiteFingerprint: exhaustedSite,
              projectId: latest.project.id,
              trancheId: latest.tranche.id,
              worldId: activation?.world.worldId ?? "",
              worldEpochId: activation?.world.worldEpochId ?? "",
              generation: activation?.world.generation ?? "",
              branchActivated: !!activation && !activation.blockedReason && durability!.isExecutionDurablyActivated(activation) &&
                !!executionScope && executionScope.worldId === activation.world.worldId &&
                executionScope.worldEpochId === activation.world.worldEpochId &&
                executionScope.generation === activation.world.generation,
              predecessorPlacement: firstFacilityPlacementDurability(predecessorOperations),
              predecessorOperations,
            });
            if (!promoted) {
              durability!.saveProjectState(latest);
              return { status: "PLANNING_HANDOFF", reason: "K05_ALTERNATE_SITE_SUCCESSOR_SCOPE_PRECONDITIONS_NOT_PROVEN" };
            }
            latest.tranche.utilityExecution!.utilities[utilityEntry[0] as UtilityRecoveryKind] = promoted.utility;
            durability!.saveProjectState(latest);
            return { status: "PLANNING_HANDOFF", reason: `${promoted.reused ? "K05_ALTERNATE_SITE_SCOPE_REUSED" : "K05_ALTERNATE_SITE_SCOPE_CREATED"}:` +
              `${alternate.prefab}:${alternate.position.x.toFixed(2)},${alternate.position.z.toFixed(2)}:${promoted.placementScopeId}` };
          } catch (error) {
            return { status: "PLANNING_HANDOFF", reason: `K05_ALTERNATE_UTILITY_SITE_PLANNING_SIGNAL:${error instanceof Error ? error.message : String(error)}` };
          }
        }
        // Candidate exhaustion remains a planner signal; it never marks the
        // residential project permanently blocked.
        return { status: "PLANNING_HANDOFF", reason: `K05_UTILITY_SITE_CONTACT_OPTIONS_EXHAUSTED:${outcome.error}` };
      }
      const latest = durability?.projectState();
      const latestRoadTaskId = latest?.tranche.currentTaskIds?.ROAD_CONNECTION;
      const latestRoadTask = latestRoadTaskId
        ? latest.tasks.find((task) => task.id === latestRoadTaskId && task.kind === "ROAD_CONNECTION")
        : undefined;
      const currentChild = latestRoadTask?.childOperationAmendmentId
        ? durability?.utilityBudgetAmendments().find((item) => item.amendmentId === latestRoadTask.childOperationAmendmentId)
        : undefined;
      const hasPendingRoadChild = !!latestRoadTask?.utilityRoadParentTaskId &&
        ["PENDING", "WAITING"].includes(latestRoadTask.status) && currentChild?.reason === "UTILITY_SERVICE_ROAD_CHILD_OPERATION" &&
        currentChild.status === "ACTIVE" && currentChild.executionUseStatus === "UNUSED";
      const latestUtilityPlan = latest?.tranche.utilityExecution?.utilities
        ? Object.values(latest.tranche.utilityExecution.utilities).find((utility) => (utility.plan?.serviceRoads?.length ?? 0) > 0)
        : undefined;
      if (latest && latest.schemaVersion === V2_GATE1_STATE_SCHEMA_VERSION && latest.tranche.stage === "ROAD_DELIVERED" &&
        latest.project.status === "ACTIVE" && latest.intent.status === "ACTIVE" && latestUtilityPlan && !hasPendingRoadChild) {
        try {
          await prepareUtilityServiceRoadChild(latest, signal);
        } catch (error) {
          return { status: "REPLAN", reason: `${outcome.error ?? "K05 utility planner needs another bounded plan"};
            SERVICE_ROAD_REPLAN_SIGNAL:${error instanceof Error ? error.message : String(error)}` };
        }
      }
      return { status: "REPLAN", reason: outcome.error ?? "K05 utility planner needs another bounded plan" };
    },
    prepareUtilityServiceRoadChild,
    boundaryForWorld: (world) =>
      createV2Gate1ProgressionBoundary({
        foundation: v2FoundationPorts,
        world: { worldEpochId: world.worldEpochId, generation: world.generation },
        roadAccessConnected: async (proposal, signal) => {
          if (!proposal.concreteChildOperation) throw new Error("ROAD_ACCESS_CHILD_OPERATION_MISSING");
          // What this answers is "did the delivered Road give THIS scope the
          // access it asked for", and different scopes ask different things.
          //
          // A water `ROAD_ACCESS` prerequisite asks for its pump to have road
          // access, and reads exactly that. A `ROAD_FRONTAGE` prerequisite owns
          // no facility at all: the segment the command built IS the deliverable,
          // and the Road kernel has already read its effect back before this is
          // ever called — so there is nothing further to read, and the pump read
          // asks about a facility that scope never had. Measured live
          // (2026-10-01): a frontage prerequisite built its road
          // (`OBSERVED_MATCH`, journal 111 -> 112) and then blocked on
          // `ROAD_ACCESS_READBACK_PUMP_UNAVAILABLE` on every following tick.
          const snapshot = v2FoundationPorts.durability?.snapshot();
          const activeGoalId = snapshot
            ? snapshot.goalWorkOrders?.find((item) => item.workOrderId === snapshot.activeGoalWorkOrderId)?.goalId ?? ""
            : "";
          if (activeGoalId.includes(":prerequisite:ROAD_FRONTAGE:")) return true;
          if (!activeGoalId.includes(":prerequisite:ROAD_ACCESS:")) {
            // Neither scope: this readback has no answer to give, and a guess
            // here would certify access nothing measured.
            throw new Error(`ROAD_ACCESS_READBACK_SCOPE_UNKNOWN:${activeGoalId || "<no-active-goal>"}`);
          }
          const game = record(await callTool("cs2_game_state", {}, signal));
          const liveWorld = record(game.world);
          if (liveWorld.worldId !== world.worldId || liveWorld.generation !== world.generation)
            throw new Error("ROAD_ACCESS_READBACK_WORLD_CHANGED");
          const project = v2FoundationPorts.durability?.projectState();
          if (!project || project.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION ||
            project.project.id !== proposal.projectId || project.tranche.id !== proposal.trancheId)
            throw new Error("ROAD_ACCESS_READBACK_PROJECT_MISMATCH");
          const pump = project.tranche.utilityExecution?.utilities.water.facility;
          if (!pump || pump.prefab !== "GroundwaterPumpingStation01")
            throw new Error("ROAD_ACCESS_READBACK_PUMP_UNAVAILABLE");
          const access = record(await callTool("cs2_building_access", {
            index: pump.entity.index, version: pump.entity.version,
          }, signal));
          const attachment = record(access.roadAttachment);
          if (attachment.roadEdge === undefined || typeof attachment.reciprocalConnectedBuilding !== "boolean")
            throw new Error("ROAD_ACCESS_READBACK_INCOMPLETE");
          return attachment.roadEdge !== null && attachment.roadEdge !== undefined &&
            attachment.roadExists === true && attachment.roadIsEdge === true &&
            attachment.reciprocalConnectedBuilding === true;
        },
        previewRoad: (input, signal) =>
          callTool("cs2_spatial", { mode: "preflight", kind: "net", ...input }, signal),
        readAvailableRoadPrefabs: async (signal) => {
          const declared = record(record(await callTool("cs2_mayor_snapshot", {}, signal)).planningCatalog).roadPrefabs;
          return Array.isArray(declared)
            ? declared.filter((value): value is string => typeof value === "string")
            : [];
        },
        readResidentialZone: async (signal) => {
          // The same choice `readZoneCategory` makes, so the fallback cannot lay a different residential density.
          const snapshot = await withZoneCatalogue(await callTool("cs2_mayor_snapshot", {}, signal), signal);
          const residential = zonePrefabForDomain(snapshot, "residential");
          if (!residential) throw new Error("GATE1_RESIDENTIAL_ZONE_PREFAB_UNAVAILABLE");
          return residential;
        },
        readZoneCategory: async (category, signal) => {
          const snapshot = record(await withZoneCatalogue(await callTool("cs2_mayor_snapshot", {}, signal), signal));
          // The category's own zone, resolved by the SAME rule the candidate
          // generator uses (`zonePrefabForDomain` reads `zoneOptions`), so the
          // prefab this step authorizes is the one the Goal's own candidate was
          // built from. It used to spell an area type from the category name and
          // look for it — which never matches Office, because the catalogue names
          // office zones as office-labelled `Industrial`, not `areaType:
          // "Office"`. A category the game HAD unlocked would still refuse here.
          //
          // A catalogue that exposes no unlocked zone for the category is a
          // capability this adapter does not have, and it is reported as one:
          // the domain fails closed by name. The Brain no longer admits a Goal
          // for such a domain in the first place — see `cannotZoneDomain` — so
          // this is the backstop, not the detector.
          const prefab = zonePrefabForDomain(snapshot, category);
          if (!prefab) {
            throw new Error(`GATE1_${category.toUpperCase()}_ZONE_PREFAB_UNAVAILABLE: the native planning ` +
              `catalogue exposes no unlocked zone for the ${category} category`);
          }
          return prefab;
        },
      }),
    waitForNativeIdle: (signal) => waitForAuthoritativeNativeIdle(signal),
    runBoundedSimulation: (signal) =>
      runSimulation({ hours: GATE1_PROGRESSION_SIMULATION.hours, speed: GATE1_PROGRESSION_SIMULATION.speed }, signal),
    ...(options.gate1MaximumDecisions !== undefined ? { maximumDecisions: options.gate1MaximumDecisions } : {}),
  });

  // The district builder writes through the same MCP tools a player-facing script would, one call at a time, and
  // reads every street back before the next. The world is the authority (no ledger): a refused write is reported and
  // skipped, and the next cycle re-derives the next district from what is actually built.
  const districtWrite = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await nativeBuildMutex.acquire(signal);
        let body: Record<string, unknown>;
        try {
          body = record(await callTool(name, args, signal));
        } finally {
          await nativeBuildMutex.release();
        }
        return { ok: body.success !== false && !body.error, detail: JSON.stringify(body).slice(0, 400) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/in progress|busy/i.test(detail) && !signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        return { ok: false, detail: detail.slice(0, 600) };
      }
    }
    return { ok: false, detail: "the Bridge stayed busy" };
  };
  const districtBuilder = new DistrictBuilder({
    // Write-only experience log next to the decision log (nothing reads it back yet).
    ...(process.env.AI_MAYOR_DECISION_FILE || process.env.AI_MAYOR_EXPERIENCE_FILE ? { recordAccessAttempt: (row: unknown) => cappedAppend(process.env.AI_MAYOR_EXPERIENCE_FILE ?? `${process.env.AI_MAYOR_DECISION_FILE!}.experience.jsonl`, `${JSON.stringify(row)}\n`) } : {}),
    // The game's own state, not the mayor snapshot: `game.frameIndex` is null there on this Bridge (measured live 2026-10-04).
    readGameFrame: async (signal) => {
      const game = record(await callTool("cs2_game_state", {}, signal));
      return simulationFrameIndex(game, record(game.simulation));
    },
    scanWorld: async (signal) =>
      buildSpatialWorldModel(parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal))),
    // The Bridge lists at most 500 buildings and takes no offset, so a city of 9,000+ people was seen through its first 500 only: the
    // district builder knew 0-5 polluters, its isolation rule was blind, and 59 of 65 noise icons hung within 200 m of industry
    // (measured 2026-10-04). The polluting kinds are therefore also asked for by name, each its own 500.
    listBuildings: async (signal) => {
      const read = async (query?: string) => {
        const body = record(await callTool("cs2_list_buildings", { limit: 500, ...(query ? { query } : {}) }, signal));
        return (Array.isArray(body.buildings) ? body.buildings : []).map(record)
          .map((row) => ({ prefab: String(row.prefab ?? ""), position: { x: Number(record(row.position).x), z: Number(record(row.position).z) } }))
          .filter((row) => Number.isFinite(row.position.x) && Number.isFinite(row.position.z));
      };
      const merged = new Map<string, { prefab: string; position: { x: number; z: number } }>();
      for (const rows of [await read(), ...(await Promise.all(["Industrial", "Factory", "Warehouse", "Storage", "Manufactur", "Power", "Sewage", "Landfill"].map((query) => read(query).catch(() => []))))]) {
        for (const row of rows) merged.set(`${row.prefab}@${Math.round(row.position.x)},${Math.round(row.position.z)}`, row);
      }
      return [...merged.values()];
    },
    siteDetail: async (center, radius, resolution, signal) => {
      try {
        return parseSpatialSiteDetail(await callTool("cs2_spatial",
          { mode: "detail", x: center.x, z: center.z, radius: Math.round(radius), resolution }, signal));
      } catch {
        return null;
      }
    },
    readPlanningTerrain: async (signal) => {
      try {
        const body = record(await callTool("cs2_terrain", { resolution: 256 }, signal));
        const resolution = Number(body.resolution);
        const min = Number(body.worldMin);
        const max = Number(body.worldMax);
        const cell = Number(body.cellSize);
        if (!Number.isInteger(resolution) || !(resolution > 0) || !Number.isFinite(min) || !Number.isFinite(max) || !(cell > 0) ||
          !Array.isArray(body.heights) || !Array.isArray(body.waterDepths) ||
          body.heights.length !== resolution * resolution || body.waterDepths.length !== resolution * resolution) return null;
        return { resolution, bounds: { minX: min, minZ: min, maxX: max, maxZ: max }, cellSize: { x: cell, z: cell },
          heights: body.heights.map(Number), waterDepths: body.waterDepths.map(Number), groundWater: [], groundWaterPollution: [], windSpeed: [] };
      } catch { return null; }
    },
    buildRoad: (course, prefab, signal) => districtWrite("cs2_build_road",
      { prefab, x1: course.start.x, z1: course.start.z, x2: course.end.x, z2: course.end.z }, signal),
    zone: (zone, center, radius, signal) => districtWrite("cs2_zone_area", { zone, x: center.x, z: center.z, radius }, signal),
    // The game's own read-only dry run of a street. FAST_EXPANSION submits a street only after the dry run certifies it (it agreed
    // with the real build 40 of 40 times, 2026-10-04). AI_MAYOR_ROAD_PREFLIGHT_GATE=0 removes it, for A/B comparisons.
    ...(process.env.AI_MAYOR_ROAD_PREFLIGHT_GATE !== "0" ? {
      preflightRoad: async (course: { start: { x: number; z: number }; end: { x: number; z: number } }, prefab: string, signal?: AbortSignal) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            const body = record(await callTool("cs2_spatial", { mode: "preflight", kind: "net", prefab, x1: course.start.x, z1: course.start.z, x2: course.end.x, z2: course.end.z }, signal));
            const integrity = record(body.courseIntegrity);
            return body.valid === false || integrity.proposalEdgeCount === 0 ? `REJECT:${String(integrity.firstFailure ?? "valid=false")}` : "OK";
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (/in progress/i.test(text) && attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 150)); continue; }
            // The game names WHY in `nativeToolErrors` (OverlapExisting, SteepSlope, ...): all of them are kept (the generic UNKNOWN of the wrapper is not a reason).
            const reasons = [...new Set([...text.matchAll(/"errorType":"([A-Za-z]+)"/g)].map((match) => match[1]!).filter((name) => name !== "UNKNOWN"))];
            return `REJECT:${reasons.length > 0 ? reasons.join("+") : /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/.exec(text)?.[0] ?? text.replace(/\s+/g, " ").slice(0, 50)}`;
          }
        }
        return "BUSY";
      },
    } : {}),
    demolishRoad: async (entity, signal) => (await districtWrite("cs2_demolish", { index: entity.index, version: entity.version }, signal)).ok,
    readLandCosts: async (signal) => {
      try {
        const budget = record(await callTool("cs2_budget", {}, signal));
        return { tileUpkeep: Number(record(budget.expenses).MapTileUpkeep ?? 0), monthlyExpenses: Math.abs(Number(budget.totalExpenses)) };
      } catch {
        return null;
      }
    },
    // The loan: read it (principal, daily interest and payment, the credit line) and set its principal. Policy is `v2/loan-policy.ts`.
    loan: {
      read: async (signal) => {
        try {
          const body = record(await callTool("cs2_get_loan", {}, signal));
          const current = record(body.currentLoan);
          const reading = { amount: Number(current.amount), dailyInterestRate: Number(current.dailyInterestRate), dailyPayment: Number(current.dailyPayment), creditworthiness: Number(body.creditworthiness) };
          return Object.values(reading).every(Number.isFinite) ? reading : null;
        } catch {
          return null;
        }
      },
      set: async (amount, signal) => {
        try {
          const body = record(await callTool("cs2_set_loan", { amount: Math.max(0, Math.round(amount)) }, signal));
          return body.success !== false && !body.error;
        } catch {
          return false;
        }
      },
    },
    readIcons: async (signal) => {
      try {
        // 500 (the most the tool returns): a city of 600 notices hid every "No Road Access" from the first 200 (live 2026-10-05); a restarted Bridge also lists the most important first.
        const body = record(await callTool("cs2_notifications", { limit: 500 }, signal));
        const counts = Object.fromEntries(Object.entries(record(body.countsByType)).map(([type, count]) => [type, Number(count)]));
        const items = (Array.isArray(body.notifications) ? body.notifications : []).map(record)
          .map((row) => {
            const target = record(row.target);
            const entity = { index: Number(target.index), version: Number(target.version) };
            return { type: String(row.type ?? ""), x: Number(record(row.location).x), z: Number(record(row.location).z),
              ...(Number.isFinite(entity.index) && Number.isFinite(entity.version) ? { entity } : {}), ...(typeof target.prefab === "string" ? { prefab: target.prefab } : {}) };
          })
          .filter((row) => row.type && Number.isFinite(row.x) && Number.isFinite(row.z));
        return { counts, items };
      } catch {
        return null;
      }
    },
    findPrefabs: async (query, signal) => {
      try {
        const body = record(await callTool("cs2_find_prefabs", { category: "building", query, limit: 200 }, signal));
        return (Array.isArray(body.prefabs) ? body.prefabs : []).map(record).filter((row) => typeof row.name === "string")
          .map((row) => ({ name: String(row.name), locked: row.locked === true }));
      } catch {
        return [];
      }
    },
    readLabor: async (signal) => {
      try {
        const labor = record(await callTool("cs2_labor", {}, signal));
        const jobs = record(labor.jobs);
        const reading = { employed: Number(labor.employed), unemploymentRate: Number(labor.unemploymentRate), jobsTotal: Number(jobs.total), jobsFree: Number(jobs.free) };
        if (!Object.values(reading).every(Number.isFinite)) return null;
        // A reading that contradicts the city's own head count is not a labour market (see `plausibleLaborReading`).
        const citizens = Number(record(labor.ageStructure).totalCitizens);
        return plausibleLaborReading(reading, Number.isFinite(citizens) ? citizens : null) ? reading : null;
      } catch {
        return null;
      }
    },
    // The game's progression (V2 P1): achieved milestone, XP and the XP the next milestone asks for, and the game date (month key of the finance watch).
    // The milestone fields exist only in a Bridge built after 2026-10-04; an older Bridge answers null and the stage is read from the unlocks.
    readProgress: async (signal) => {
      try {
        const overview = record(await callTool("cs2_city_overview", {}, signal));
        const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
        const progress = { milestone: num(overview.milestoneLevel), xp: num(overview.xp), nextMilestoneXp: num(overview.nextMilestoneXp),
          gameDateTime: typeof overview.gameDateTime === "string" ? overview.gameDateTime : null };
        noteMilestoneProgress(progress.xp, progress.nextMilestoneXp);
        return progress;
      } catch {
        return null;
      }
    },
    // The population over the last ~4 game days (32 samples a day), to read the net immigration rate (V2 P2).
    readPopulationSeries: async (signal) => {
      try {
        const body = record(await callTool("cs2_statistics", { type: "Population", samples: 128 }, signal));
        const frames = (Array.isArray(body.frames) ? body.frames : []).map(Number);
        const values = (Array.isArray(body.values) ? body.values : []).map(Number);
        return frames.length >= 2 && frames.length === values.length && [...frames, ...values].every(Number.isFinite) ? { frames, values } : null;
      } catch {
        return null;
      }
    },
    // The zoning inside a disk by zone name (`#withdrawStaleZoning`): cells, occupied, empty.
    readZoningAround: async (center, radius, signal) => {
      try {
        const body = record(await callTool("cs2_zoning", { x: center.x, z: center.z, radius }, signal));
        const rows = Object.entries(record(body.byZone)).map(([zone, value]) => ({ zone, cells: Number(record(value).cells), occupied: Number(record(value).occupied), empty: Number(record(value).empty) }))
          .filter((row) => [row.cells, row.occupied, row.empty].every(Number.isFinite));
        return rows;
      } catch { return null; }
    },
    // The surplus power sold through a transformer onto the map's own high-voltage line (`power-export.ts`; measured live 2026-10-05).
    powerExport: {
      readTrade: async (signal) => {
        try {
          const electricity = record(record(await callTool("cs2_city_services", {}, signal)).electricity);
          const trade = { production: Number(electricity.production), consumption: Number(electricity.consumption), exported: Number(electricity.export) };
          return Object.values(trade).every(Number.isFinite) ? trade : null;
        } catch { return null; }
      },
      highVoltageLines: async (signal) => {
        try {
          const body = record(await callTool("cs2_list_roads", { query: "High-voltage Line", limit: 500 }, signal));
          return (Array.isArray(body.roads) ? body.roads : []).map(record).filter((row) => row.prefab === "High-voltage Line")
            .map((row) => ({ start: { x: Number(record(row.start).x), z: Number(record(row.start).z) }, end: { x: Number(record(row.end).x), z: Number(record(row.end).z) } }))
            .filter((line) => [line.start.x, line.start.z, line.end.x, line.end.z].every(Number.isFinite));
        } catch { return []; }
      },
      transformerPrefabs: async (signal) => {
        try {
          const body = record(await callTool("cs2_find_prefabs", { category: "building", query: "TransformerStation", limit: 20 }, signal));
          return (Array.isArray(body.prefabs) ? body.prefabs : []).map(record)
            .filter((row) => typeof row.name === "string" && /^TransformerStation\d+$/.test(row.name) && row.locked !== true).map((row) => String(row.name)).sort();
        } catch { return []; }
      },
      listFacilities: async (prefab, signal) => {
        const body = record(await callTool("cs2_list_buildings", { query: prefab, limit: 64 }, signal));
        return (Array.isArray(body.buildings) ? body.buildings : []).map(record).filter((row) => row.prefab === prefab)
          .map((row) => ({ entity: { index: Number(record(row.entity).index), version: Number(record(row.entity).version) },
            position: { x: Number(record(row.position).x), z: Number(record(row.position).z) } }))
          .filter((row) => Number.isFinite(row.entity.index) && Number.isFinite(row.position.x) && Number.isFinite(row.position.z));
      },
      preflight: async (prefab, point, rotation, signal) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            return record(await callTool("cs2_spatial", { mode: "preflight", kind: "object", prefab, x: point.x, z: point.z, rotation }, signal)).valid === true;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (/in progress|busy|retry shortly/i.test(detail) && !signal?.aborted) { await new Promise((resolve) => setTimeout(resolve, 350)); continue; }
            return false;
          }
        }
        return null;
      },
      place: async (prefab, point, rotation, signal) => {
        const outcome = await districtWrite("cs2_mayor_execute_actions", { actions: [{ type: "place_building", prefab, x: point.x, z: point.z, rotation }] }, signal);
        if (outcome.ok) await waitForAuthoritativeNativeIdle(signal, 10_000).catch(() => undefined);
        return { ok: outcome.ok && !/"ok":\s*false/.test(outcome.detail), detail: outcome.detail };
      },
      markers: async (entity, signal) => {
        try {
          const body = record(await callTool("cs2_utility_connectors", { index: entity.index, version: entity.version }, signal));
          const markers = (Array.isArray(body.connectors) ? body.connectors : []).map(record).filter((row) => row.type === "electricity")
            .map((row) => ({ voltage: row.voltage === "High" ? "High" as const : "Low" as const, attached: row.attached === true,
              position: { x: Number(record(row.worldPosition).x), z: Number(record(row.worldPosition).z) } }))
            .filter((marker) => Number.isFinite(marker.position.x) && Number.isFinite(marker.position.z));
          return markers.length > 0 ? markers : null;
        } catch { return null; }
      },
      lay: async (prefab, from, to, startElevation, endElevation, signal) => {
        const edgesOf = async () => {
          try {
            const body = record(await callTool("cs2_list_roads", { query: prefab, limit: 500 }, signal));
            return (Array.isArray(body.roads) ? body.roads : []).map(record).filter((row) => row.prefab === prefab)
              .map((row) => ({ index: Number(record(row.entity).index), version: Number(record(row.entity).version) }))
              .filter((entity) => Number.isFinite(entity.index) && Number.isFinite(entity.version));
          } catch { return null; }
        };
        const before = await edgesOf();
        const laid = await districtWrite("cs2_build_road", { prefab, x1: from.x, z1: from.z, x2: to.x, z2: to.z, e1: startElevation, e2: endElevation }, signal);
        const after = laid.ok && before ? await edgesOf() : null;
        const known = new Set((before ?? []).map((entity) => `${entity.index}:${entity.version}`));
        return { ...laid, ...(after ? { created: after.filter((entity) => !known.has(`${entity.index}:${entity.version}`)) } : {}) };
      },
      remove: async (entity, signal) => (await districtWrite("cs2_demolish", { index: entity.index, version: entity.version }, signal)).ok,
    },
    // The development tree (`tech-tree.ts`): points, nodes, the railway prefabs' unlock requirements, and the purchase the game's own UI makes.
    techTree: {
      read: async (signal) => {
        try {
          const body = record(await callTool("cs2_devtree", {}, signal));
          if (!Array.isArray(body.nodes) || !Number.isFinite(Number(body.points))) return null;
          const nodes = body.nodes.map(record).filter((row) => typeof row.name === "string").map((row) => ({ name: String(row.name), service: typeof row.service === "string" ? row.service : null, serviceLocked: row.serviceLocked === true,
            cost: Number(row.cost), locked: row.locked === true, purchasable: row.purchasable === true, refusals: Array.isArray(row.refusals) ? row.refusals.map(String) : [],
            requirements: (Array.isArray(row.requirements) ? row.requirements : []).map(record).map((requirement) => ({ name: typeof requirement.name === "string" ? requirement.name : null, locked: requirement.locked === true })) }));
          return { points: Number(body.points), nodes } as TechTree;
        } catch { return null; }
      },
      prefabLocks: async (prefabs, signal) => {
        try {
          const locks: PrefabLock[] = [];
          for (const entry of prefabs) {
            const body = record(await callTool("cs2_prefab_lock", { prefab: entry.prefab, category: entry.category }, signal).catch(() => ({})));
            if (typeof body.prefab !== "string") continue;
            const lot = record(body.lotSize); const size = record(body.size);
            locks.push({ prefab: body.prefab, locked: body.locked === true,
              lotSize: Number.isFinite(Number(lot.x)) && Number.isFinite(Number(lot.z)) ? { x: Number(lot.x), z: Number(lot.z) } : null,
              size: Number.isFinite(Number(size.x)) && Number.isFinite(Number(size.z)) ? { x: Number(size.x), z: Number(size.z) } : null, requirements: (Array.isArray(body.requirements) ? body.requirements : []).map(record).map((row) => ({
              name: typeof row.name === "string" ? row.name : null, kind: String(row.kind ?? ""), locked: row.locked === true, cost: Number.isFinite(Number(row.cost)) ? Number(row.cost) : null, flags: String(row.flags ?? "") })) });
          }
          return locks.length > 0 ? locks : null;
        } catch { return null; }
      },
      purchase: async (node, signal) => {
        try {
          const body = record(await callTool("cs2_devtree_purchase", { node }, signal));
          return { ok: body.requested === true, detail: JSON.stringify(body).slice(0, 200) };
        } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
      },
    },
    // A passenger station on the map's own railway (`train-link.ts`). Needs the Bridge's `/city/roads?ownerIndex=` read (built 2026-10-05; loads on restart).
    trainLink: {
      railEdges: async (signal) => {
        try {
          const body = record(await callTool("cs2_list_roads", { query: "Train Track", limit: 500 }, signal));
          return (Array.isArray(body.roads) ? body.roads : []).map(record).filter((row) => /^(Double|Twoway|Oneway) Train Track$/.test(String(row.prefab)))
            .map((row) => ({ start: { x: Number(record(row.start).x), z: Number(record(row.start).z) }, end: { x: Number(record(row.end).x), z: Number(record(row.end).z) },
              ...(typeof row.native === "boolean" ? { native: row.native } : {}) }))
            .filter((edge) => [edge.start.x, edge.start.z, edge.end.x, edge.end.z].every(Number.isFinite));
        } catch { return []; }
      },
      stationPrefabs: async (signal) => {
        try {
          const body = record(await callTool("cs2_find_prefabs", { category: "building", query: "TrainStation", limit: 20 }, signal));
          return (Array.isArray(body.prefabs) ? body.prefabs : []).map(record)
            .filter((row) => typeof row.name === "string" && /^TrainStation\d+$/.test(row.name) && row.locked !== true).map((row) => String(row.name)).sort();
        } catch { return []; }
      },
      trackPrefab: async (signal) => {
        try {
          const body = record(await callTool("cs2_find_prefabs", { category: "net", query: "Train Track", limit: 20 }, signal));
          const open = (Array.isArray(body.prefabs) ? body.prefabs : []).map(record).filter((row) => row.locked !== true).map((row) => String(row.name));
          return open.find((name) => name === "Double Train Track") ?? open.find((name) => name === "Twoway Train Track") ?? null;
        } catch { return null; }
      },
      listStations: async (prefab, signal) => {
        const body = record(await callTool("cs2_list_buildings", { query: prefab, limit: 20 }, signal));
        return (Array.isArray(body.buildings) ? body.buildings : []).map(record).filter((row) => row.prefab === prefab)
          .map((row) => ({ entity: { index: Number(record(row.entity).index), version: Number(record(row.entity).version) },
            position: { x: Number(record(row.position).x), z: Number(record(row.position).z) } }))
          .filter((row) => Number.isFinite(row.entity.index) && Number.isFinite(row.position.x));
      },
      preflight: async (prefab, point, rotation, signal) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            return record(await callTool("cs2_spatial", { mode: "preflight", kind: "object", prefab, x: point.x, z: point.z, rotation }, signal)).valid === true;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (/in progress|busy|retry shortly/i.test(detail) && !signal?.aborted) { await new Promise((resolve) => setTimeout(resolve, 350)); continue; }
            return false;
          }
        }
        return null;
      },
      place: async (prefab, point, rotation, signal) => {
        const outcome = await districtWrite("cs2_mayor_execute_actions", { actions: [{ type: "place_building", prefab, x: point.x, z: point.z, rotation }] }, signal);
        if (outcome.ok) await waitForAuthoritativeNativeIdle(signal, 10_000).catch(() => undefined);
        return { ok: outcome.ok && !/"ok":\s*false/.test(outcome.detail), detail: outcome.detail };
      },
      ownedTracks: async (entity, signal) => {
        try {
          const body = record(await callTool("cs2_list_roads", { ownerIndex: entity.index, ownerVersion: entity.version }, signal));
          // An older Bridge ignores the owner and answers the plain listing (no `owner` field): that is not the station's tracks.
          if (!body.owner) return null;
          return (Array.isArray(body.roads) ? body.roads : []).map(record).map((row) => ({ prefab: String(row.prefab ?? ""),
            start: { x: Number(record(row.start).x), z: Number(record(row.start).z) }, end: { x: Number(record(row.end).x), z: Number(record(row.end).z) },
            startDegree: Number(row.startDegree), endDegree: Number(row.endDegree) }))
            .filter((row) => [row.start.x, row.start.z, row.end.x, row.end.z, row.startDegree, row.endDegree].every(Number.isFinite));
        } catch { return null; }
      },
      frontage: async (entity, signal) => {
        try {
          const position = record(record(record(await callTool("cs2_building_access", { index: entity.index, version: entity.version }, signal)).nativeRoadFrontage).position);
          const point = { x: Number(position.x), z: Number(position.z) };
          return Number.isFinite(point.x) && Number.isFinite(point.z) ? point : null;
        } catch { return null; }
      },
      lay: async (prefab, from, to, signal) => {
        const edgesOf = async () => {
          try {
            const body = record(await callTool("cs2_list_roads", { query: prefab, limit: 500 }, signal));
            return (Array.isArray(body.roads) ? body.roads : []).map(record).filter((row) => row.prefab === prefab)
              .map((row) => ({ index: Number(record(row.entity).index), version: Number(record(row.entity).version) }))
              .filter((entity) => Number.isFinite(entity.index) && Number.isFinite(entity.version));
          } catch { return null; }
        };
        const before = await edgesOf();
        const laid = await districtWrite("cs2_build_road", { prefab, x1: from.x, z1: from.z, x2: to.x, z2: to.z }, signal);
        const after = laid.ok && before ? await edgesOf() : null;
        const known = new Set((before ?? []).map((entity) => `${entity.index}:${entity.version}`));
        return { ...laid, ...(after ? { created: after.filter((entity) => !known.has(`${entity.index}:${entity.version}`)) } : {}) };
      },
      remove: async (entity, signal) => (await districtWrite("cs2_demolish", { index: entity.index, version: entity.version }, signal)).ok,
    },
    // Public transport lines (`transit-lines.ts`): Bridge `/transit/*` (built 2026-10-05; loads on restart). An older Bridge answers 404: read as null.
    transit: {
      stops: async (type, signal) => {
        try {
          const body = record(await callTool("cs2_transit_stops", { type, limit: 500 }, signal));
          if (!Array.isArray(body.stops)) return null;
          return body.stops.map(record).map((row) => ({ entity: { index: Number(record(row.entity).index), version: Number(record(row.entity).version) },
            prefab: typeof row.prefab === "string" ? row.prefab : null, transportType: typeof row.transportType === "string" ? row.transportType : null,
            // Live 2026-10-05: the map-edge stop is its own entity owned by the track ("Train Outside Connection - Twoway"), so the Bridge's owner test missed it.
            outsideConnection: row.outsideConnection === true || /Outside Connection/i.test(String(row.prefab ?? "")), ownerPrefab: typeof record(row.owner).prefab === "string" ? String(record(row.owner).prefab) : null,
            position: { x: Number(record(row.position).x), z: Number(record(row.position).z) }, waitingPassengers: Number(row.waitingPassengers) || 0 }))
            .filter((row) => Number.isFinite(row.entity.index) && Number.isFinite(row.position.x));
        } catch { return null; }
      },
      lines: async (signal) => {
        try {
          const body = record(await callTool("cs2_transit_lines", { prefabs: true }, signal));
          if (!Array.isArray(body.lines)) return null;
          const entityOf = (value: unknown) => { const row = record(value); const entity = { index: Number(row.index), version: Number(row.version) };
            return Number.isFinite(entity.index) && Number.isFinite(entity.version) ? entity : null; };
          return {
            lines: body.lines.map(record).map((row) => ({ entity: entityOf(row.entity) ?? { index: -1, version: -1 },
              transportType: typeof row.transportType === "string" ? row.transportType : null,
              stops: (Array.isArray(row.stops) ? row.stops : []).map(record).map((stop) => ({ stop: entityOf(stop.stop),
                position: { x: Number(record(stop.position).x), z: Number(record(stop.position).z) }, waitingPassengers: Number(stop.waitingPassengers) || 0 })),
              vehicleCount: Number(row.vehicleCount) || 0, passengersOnBoard: Number(row.passengersOnBoard) || 0, passengersWaiting: Number(row.passengersWaiting) || 0 })),
            prefabs: (Array.isArray(body.linePrefabs) ? body.linePrefabs : []).map(record).filter((row) => typeof row.name === "string")
              .map((row) => ({ name: String(row.name), transportType: String(row.transportType ?? ""), passenger: row.passenger === true, locked: row.locked === true })),
          };
        } catch { return null; }
      },
      createLine: async (prefab, stops, signal) => districtWrite("cs2_transit_line_create", { prefab, stops }, signal),
      runBriefly: async (signal) => { await runSimulation({ hours: 0.1, speed: 1 }, signal ?? new AbortController().signal).catch(() => undefined); },
    },
    // The road network's own tools (`v2/road-care.ts`): reads are plain calls, writes go through the native build mutex like every other write.
    roads: (() => {
      const ref = (value: unknown) => { const row = record(value); return { index: Number(row.index), version: Number(row.version) }; };
      const point = (value: unknown) => { const row = record(value); return { x: Number(row.x), z: Number(row.z) }; };
      const edgeOf = (value: unknown) => {
        const row = record(value);
        return { entity: ref(row.entity), prefab: typeof row.prefab === "string" ? row.prefab : null, aggregate: row.aggregate ? ref(row.aggregate) : null,
          startNode: ref(row.startNode), endNode: ref(row.endNode), position: point(row.position), length: Number(row.length) || 0,
          volume: Number(row.volume) || 0, flowPercent: Number.isFinite(Number(row.flowPercent)) ? Number(row.flowPercent) : 100, wear: Number(row.wear) || 0 };
      };
      /** A write whose whole answer is read (a preview's impact), serialised with the other native writes. */
      const write = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; body: Record<string, unknown>; detail: string }> => {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            await nativeBuildMutex.acquire(signal);
            try {
              const body = record(await callTool(name, args, signal));
              return { ok: body.success !== false && !body.error, body, detail: JSON.stringify(body).slice(0, 400) };
            } finally {
              await nativeBuildMutex.release();
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (/in progress|busy/i.test(detail) && !signal?.aborted) { await new Promise((resolve) => setTimeout(resolve, 400)); continue; }
            return { ok: false, body: {}, detail: detail.slice(0, 600) };
          }
        }
        return { ok: false, body: {}, detail: "the Bridge stayed busy" };
      };
      return {
        near: async (at: { x: number; z: number }, radius: number, signal?: AbortSignal) => {
          try {
            const body = record(await callTool("cs2_list_roads", { x: at.x, z: at.z, radius, limit: 60 }, signal));
            return (Array.isArray(body.roads) ? body.roads : []).map(record).filter((row) => typeof row.prefab === "string")
              .map((row) => ({ entity: ref(row.entity), prefab: String(row.prefab), start: point(row.start), end: point(row.end) }))
              .filter((row) => Number.isFinite(row.entity.index) && Number.isFinite(row.start.x));
          } catch { return []; }
        },
        upgrade: async (entity: { index: number; version: number }, upgrades: "trees" | "soundBarrier", signal?: AbortSignal) =>
          districtWrite("cs2_upgrade_road", { index: entity.index, version: entity.version, upgrades }, signal),
        traffic: async (options: { limit?: number; minVolume?: number; aggregate?: number }, signal?: AbortSignal) => {
          try {
            const body = record(await callTool("cs2_traffic", { ...options }, signal));
            if (!Array.isArray(body.worst)) return null;
            return { cityFlowPercent: Number.isFinite(Number(body.cityFlowPercent)) ? Number(body.cityFlowPercent) : null, worst: body.worst.map(edgeOf) };
          } catch { return null; }
        },
        node: async (node: { index: number; version: number }, signal?: AbortSignal) => {
          try {
            const body = record(await callTool("cs2_traffic_node", { index: node.index, version: node.version }, signal));
            if (!Array.isArray(body.edges)) return null;
            return { node: ref(body.node), position: point(body.position), trafficLights: body.trafficLights === true, roundabout: body.roundabout === true,
              allWayStop: body.allWayStop === true,
              legs: body.edges.map(record).map((row) => ({ entity: ref(row.entity), prefab: typeof row.prefab === "string" ? row.prefab : null, road: row.road === true,
                startsHere: row.startsHere === true, otherNode: ref(row.otherNode), length: Number(row.length) || 0,
                flowA: Number(row.flowA), flowB: Number(row.flowB), volumeA: Number(row.volumeA) || 0, volumeB: Number(row.volumeB) || 0, wear: Number(row.wear) || 0 })) };
          } catch { return null; }
        },
        replace: async (edge: { index: number; version: number }, prefab: string, preview: boolean, signal?: AbortSignal) => {
          const result = await write("cs2_replace_road", { index: edge.index, version: edge.version, prefab, ...(preview ? { preview: true } : {}) }, signal);
          const deleted = Number(result.body.buildingsDeleted);
          return { ok: result.ok, detail: result.detail, buildingsDeleted: Number.isFinite(deleted) ? deleted : null };
        },
        control: async (node: { index: number; version: number }, set: "lights" | "nolights" | "stop" | "roundabout" | "default", preview: boolean, signal?: AbortSignal) => {
          const result = await write("cs2_node_control", { index: node.index, version: node.version, set, ...(preview ? { preview: true } : {}) }, signal);
          return { ok: result.ok, detail: result.detail };
        },
      };
    })(),
    readZoningMix: async (signal) => {
      try {
        const zoning = record(await callTool("cs2_zoning", {}, signal));
        const demand = record(await callTool("cs2_demand", {}, signal));
        const mix = emptyMix();
        // Homes by density as well (the zone's own name says which): vacancy per density is what the density policy judges (P3).
        const residentialDemandNow = record(record(demand.residential).buildingDemand);
        const demandOfDensity = (density: "low" | "medium" | "high") => {
          const value = Number(residentialDemandNow[`${density}Density`]);
          return Number.isFinite(value) ? value : null;
        };
        const byDensity = { low: { zoned: 0, empty: 0, demand: demandOfDensity("low") }, medium: { zoned: 0, empty: 0, demand: demandOfDensity("medium") },
          high: { zoned: 0, empty: 0, demand: demandOfDensity("high") } };
        for (const [name, row] of Object.entries(record(zoning.byZone))) {
          const category = categoryOfZoneName(name);
          if (!category) continue;
          mix.cells[category].zoned += Number(record(row).cells ?? 0);
          mix.cells[category].empty += Number(record(row).empty ?? 0);
          if (category === "residential") {
            const density = residentialZoneDensity(name);
            if (density) { byDensity[density].zoned += Number(record(row).cells ?? 0); byDensity[density].empty += Number(record(row).empty ?? 0); }
          }
        }
        mix.residentialByDensity = byDensity;
        const residential = record(record(demand.residential).buildingDemand);
        mix.demand = {
          residential: Math.max(0, ...["lowDensity", "mediumDensity", "highDensity"].map((density) => Number(residential[density] ?? 0))),
          commercial: Number(record(demand.commercial).buildingDemand ?? 0), office: Number(record(demand.office).buildingDemand ?? 0),
          industrial: Number(record(demand.industrial).buildingDemand ?? 0),
        };
        return mix;
      } catch {
        return null;
      }
    },
    utilities: {
      // What the world offers for each utility: the planning catalogue says which prefabs are unlocked, the spatial scan
      // says what each produces and costs. Ranked by capacity per cost; nothing is assumed from an earlier test.
      rankPrefabs: async (kind, signal, neededOutput) => {
        try {
          // Electricity: the snapshot's catalogue lists wind turbines only (it searches the name "WindTurbine"), so a power plant the
          // game has unlocked was never offered and every shortage became one more 20 kW turbine (11 of them, all at full load). Ask the
          // game for the unlocked plants; a fuel-burning plant, when there is one, is the answer and no turbine is placed.
          if (kind === "electricity") {
            // V2 P7: every unlocked generator the game offers is a candidate (coal, gas, hydro, solar, geothermal, nuclear, wind), ranked by
            // output per construction cost — a wind turbine at what its wind really gives (measured below), not at its nameplate. The Bridge
            // reports neither upkeep nor export price yet (experiment E6), so cost per output is the stand-in; fuel plants are flagged and
            // are not trusted until their output is read back (district-utilities).
            const assets = powerAssetsOfScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 10 }, signal));
            // What the turbines really deliver: city production over the nameplate of the turbines standing, when turbines are all there is.
            let windCapacityFactor: number | null = null;
            try {
              const standing = new Map<string, number>();
              for (const asset of assets.filter((entry) => /WindTurbine/i.test(entry.prefab))) {
                const listed = record(await callTool("cs2_list_buildings", { query: asset.prefab, limit: 500 }, signal));
                standing.set(asset.prefab, (Array.isArray(listed.buildings) ? listed.buildings : []).map(record).filter((row) => row.prefab === asset.prefab).length);
              }
              const otherGenerators: number[] = [];
              for (const entry of assets.filter((asset) => !/WindTurbine/i.test(asset.prefab) && !asset.locked && asset.production > 0)) {
                const listed = record(await callTool("cs2_list_buildings", { query: entry.prefab, limit: 50 }, signal));
                otherGenerators.push((Array.isArray(listed.buildings) ? listed.buildings : []).map(record).filter((row) => row.prefab === entry.prefab).length);
              }
              const nameplate = assets.filter((entry) => /WindTurbine/i.test(entry.prefab)).reduce((sum, entry) => sum + entry.production * (standing.get(entry.prefab) ?? 0), 0);
              const production = Number(record(record(await callTool("cs2_city_services", {}, signal)).electricity).production);
              if (otherGenerators.every((count) => count === 0) && nameplate > 0 && Number.isFinite(production) && production > 0) windCapacityFactor = Math.min(1, production / nameplate);
            } catch { /* not measured: the nameplate stands */ }
            const ranked = rankPowerSources(assets, { windCapacityFactor, neededOutput: neededOutput ?? null });
            // What one more of each adds, in the same units as the shortage (the city's production reading): a turbine at its measured share.
            rankedPowerOutput.clear();
            for (const asset of ranked) {
              const output = /WindTurbine/i.test(asset.prefab) && windCapacityFactor !== null ? asset.production * windCapacityFactor : asset.production;
              if (output > 0) rankedPowerOutput.set(asset.prefab, output);
            }
            if (ranked.length > 0) return ranked.map((asset) => asset.prefab);
          }
          const catalogue = record(record(record(await callTool("cs2_mayor_snapshot", {}, signal)).planningCatalog).buildingPrefabs);
          const scan = record(await callTool("cs2_spatial", { mode: "scan", roadLimit: 10 }, signal));
          const assets = new Map(listOf(scan.bootstrapAssets).map(record).filter((asset) => typeof asset.prefab === "string").map((asset) => [String(asset.prefab), asset]));
          // The snapshot's catalogue lists at most 12 names per kind, found by name search, so it leaves out what the scan's own `kinds` flag
          // knows: a Water Tower (no water source needed, +10–30k capacity — measured live 2026-10-04: 61,330 → 71,330) was never offered, and a
          // city whose pumps have no legal lot stayed short. For water the scan's flagged facilities that really add capacity join the list.
          const fromScan = kind === "water"
            ? [...assets.values()].filter((asset) => record(asset.kinds).water === true && Number(record(asset.capabilities).freshWaterCapacity) > 0).map((asset) => String(asset.prefab))
            : [];
          // Sewage: the treatment plant is a second way to carry the city's sewage when no outlet can stand (the outlet needs open water that no intake is
          // downstream of); it is offered once the development tree has unlocked it (district-builder buys it when the outlet has nowhere to stand).
          let treatmentPlants: string[] = [];
          if (kind === "sewage") {
            try {
              const found = record(await callTool("cs2_find_prefabs", { category: "building", query: "WastewaterTreatmentPlant", limit: 20 }, signal));
              treatmentPlants = (Array.isArray(found.prefabs) ? found.prefabs : []).map(record).filter((row) => row.locked !== true && /^WastewaterTreatmentPlant\d+$/.test(String(row.name))).map((row) => String(row.name));
            } catch { treatmentPlants = []; }
          }
          const offered = [...new Set([...(Array.isArray(catalogue[kind]) ? catalogue[kind] as unknown[] : []).filter((name): name is string => typeof name === "string"), ...fromScan, ...treatmentPlants])]
            .filter((name) => !/Extension|Extra|Collection Point|Classroom|Wing/i.test(name));
          const capacityOf = (asset: Record<string, unknown>) => {
            const capability = record(asset.capabilities);
            return kind === "electricity" ? Number(capability.windProduction) > 0 ? Number(capability.windProduction) : Number(capability.electricityProduction)
              : kind === "water" ? Math.max(Number(capability.freshWaterCapacity ?? 0), Number(capability.groundWaterProduction ?? 0) / 100)
                : Number(capability.sewageCapacity ?? 0);
          };
          // A source-free facility (water tower) adds its stated capacity wherever it stands: that is the known output, so several can be placed.
          if (kind === "water") for (const name of offered) {
            const asset = assets.get(name);
            const capacity = Number(record(asset?.capabilities).freshWaterCapacity);
            if (asset && record(asset.capabilities).allowedWaterTypes === "None" && capacity > 0) rankedPowerOutput.set(name, capacity);
          }
          // A plant has no known capacity in the scan: it is offered after the scored list (an outlet that can stand is cheaper), and one placement is the answer.
          const plantsLast = (names: string[]) => [...names.filter((name) => !treatmentPlants.includes(name)), ...names.filter((name) => treatmentPlants.includes(name))];
          return plantsLast(offered.filter((name) => assets.get(name)?.locked !== true)
            .map((name) => ({ name, score: assets.has(name) ? capacityOf(assets.get(name)!) / Math.max(1, Number(assets.get(name)!.constructionCost ?? 1)) : 0 }))
            .sort((left, right) => right.score - left.score).map((entry) => entry.name));
        } catch {
          return [];
        }
      },
      // Only power has a known output per facility in the shortage's units; water and sewage capacities are not comparable to their
      // shortage reading yet, so one placement stays the whole answer there (null).
      expectedOutput: (kind, prefab) => kind === "electricity" || kind === "water" ? rankedPowerOutput.get(prefab) ?? null : null,
      listFacilities: async (prefab, signal) => {
        const body = record(await callTool("cs2_list_buildings", { query: prefab, limit: 64 }, signal));
        return (Array.isArray(body.buildings) ? body.buildings : []).map(record).filter((row) => row.prefab === prefab)
          .map((row) => ({ entity: { index: Number(record(row.entity).index), version: Number(record(row.entity).version) },
            position: { x: Number(record(row.position).x), z: Number(record(row.position).z) } }))
          .filter((row) => Number.isFinite(row.entity.index) && Number.isFinite(row.position.x) && Number.isFinite(row.position.z));
      },
      // The object preflight throws a 409 for a position the game refuses; that is an answer, not a failure.
      preflight: async (prefab, point, rotation, signal) => {
        // A busy Bridge is not an answer: measured live, about half of a run of preflights came back "another build
        // operation is in progress" and every one of them was counted as an illegal site, so no pump was ever placed.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const answer = record(await callTool("cs2_spatial",
              { mode: "preflight", kind: "object", prefab, x: point.x, z: point.z, rotation }, signal));
            return answer.valid === true;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (/in progress|busy|retry shortly/i.test(detail) && !signal?.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 350));
              continue;
            }
            return false;
          }
        }
        // Still busy after every retry: NO ANSWER (null), not "illegal" (false), so the site is not remembered as refused.
        return null;
      },
      // The flow grid is a fact of the loaded world (read once per world generation); the intakes are read fresh every time, because a pump
      // placed a moment ago must be in them (the older census was cached for good, which is right for a plan and wrong for this).
      readWaterSafety: async (signal): Promise<WaterSafety | null> => {
        try {
          const generation = String(record(record(await callTool("cs2_game_state", {}, signal)).world).generation ?? "");
          if (!districtWaterGrid || districtWaterGrid.generation !== generation) {
            const grid = parseWaterFlowObservation(await callTool("cs2_terrain", { resolution: WATER_FLOW_OBSERVATION_RESOLUTION }, signal));
            districtWaterGrid = grid.available ? { generation, grid } : null;
          }
          if (!districtWaterGrid) return null;
          const listed = record(await callTool("cs2_list_buildings", { query: "Pumping", limit: 200 }, signal));
          const buildings = (Array.isArray(listed.buildings) ? listed.buildings : []).map(record);
          const complete = listed.complete === true || (Number.isInteger(listed.totalMatches) && Number.isInteger(listed.returned) &&
            Number(listed.returned) === buildings.length && Number(listed.returned) === Number(listed.totalMatches));
          const intakes = buildings.map((building) => ({ prefab: String(building.prefab ?? ""), position: { x: Number(record(building.position).x), z: Number(record(building.position).z) } }))
            .filter((intake) => Number.isFinite(intake.position.x) && Number.isFinite(intake.position.z));
          return { observation: districtWaterGrid.grid, intakes, intakesComplete: complete };
        } catch {
          return null;
        }
      },
      place: async (prefab, point, rotation, signal) => {
        const outcome = await districtWrite("cs2_mayor_execute_actions",
          { actions: [{ type: "place_building", prefab, x: point.x, z: point.z, rotation }] }, signal);
        // The Bridge stays "busy" for a moment after a placement while the game finishes it. Measured live (2026-10-04): the next placement checks
        // (the water pump's, right after the turbine) found it busy for over 2.8 s and, with no answer, the pump search was cut short. Wait for the
        // Bridge to be idle again (bounded; the busy breaker takes over if it never clears) before the next check is asked of it.
        if (outcome.ok) await waitForAuthoritativeNativeIdle(signal, 10_000).catch(() => undefined);
        return { ok: outcome.ok && !/"ok":\s*false/.test(outcome.detail), detail: outcome.detail };
      },
      // The facility's own pipe or cable goes in underground: on the surface it raises the terrain and blocks the road that has to run there.
      connect: async (prefab, from, to, signal) => {
        // The edges of this prefab before and after: the difference is what this call created, so a facility that fails can take exactly those down.
        const edgesOf = async () => {
          try {
            const body = record(await callTool("cs2_list_roads", { query: prefab, limit: 500 }, signal));
            return (Array.isArray(body.roads) ? body.roads : []).map(record).filter((row) => row.prefab === prefab)
              .map((row) => ({ index: Number(record(row.entity).index), version: Number(record(row.entity).version) }))
              .filter((entity) => Number.isFinite(entity.index) && Number.isFinite(entity.version));
          } catch { return null; }
        };
        const before = await edgesOf();
        const laid = await districtWrite("cs2_build_road",
          { prefab, x1: from.x, z1: from.z, x2: to.x, z2: to.z, e1: BURIED_NET_ELEVATION_METERS, e2: BURIED_NET_ELEVATION_METERS }, signal);
        const after = laid.ok && before ? await edgesOf() : null;
        const known = new Set((before ?? []).map((entity) => `${entity.index}:${entity.version}`));
        return { ...laid, ...(after ? { created: after.filter((entity) => !known.has(`${entity.index}:${entity.version}`)) } : {}) };
      },
      connectorFront: async (entity, signal, kind) => {
        try {
          const body = record(await callTool("cs2_utility_connectors", { index: entity.index, version: entity.version }, signal));
          const connectors = (Array.isArray(body.connectors) ? body.connectors : []).map(record);
          // A power plant has an electricity connector (and may have others): the net being laid is the one that is read.
          const connector = connectorForNet(connectors, kind ?? "electricity");
          const at = record(connector?.worldPosition);
          const direction = record(connector?.worldDirection);
          const numbers = [at.x, at.z, direction.x, direction.z].map(Number);
          return numbers.every(Number.isFinite) ? { position: { x: numbers[0]!, z: numbers[1]! }, direction: { x: numbers[2]!, z: numbers[3]! } } : null;
        } catch {
          return null;
        }
      },
      remove: async (entity, signal) => (await districtWrite("cs2_demolish", { index: entity.index, version: entity.version }, signal)).ok,
      attached: async (entity, signal) => {
        try {
          const body = record(await callTool("cs2_utility_connectors", { index: entity.index, version: entity.version }, signal));
          const connectors = (Array.isArray(body.connectors) ? body.connectors : []).map(record);
          return connectors.length === 0 ? null : connectors.some((connector) => connector.attached === true);
        } catch {
          return null;
        }
      },
    },
    purchaseTile: async (point, signal) => {
      const outcome = await districtWrite("cs2_purchase_tile", { x: point.x, z: point.z }, signal);
      // Only an actual purchase counts; "already owned" is a fact about the survey, not land gained.
      return { ok: outcome.ok && /"purchased":true/.test(outcome.detail), detail: outcome.detail };
    },
  }, { serviceDemolitionExperiment: process.env.AI_MAYOR_SERVICE_DEMOLITION_EXPERIMENT === "1",
    // The recorder that tunes choices (per player, across saves): the order of repair candidates follows what passed and helped before.
    ...(process.env.AI_MAYOR_EXPERIENCE_BOOK ? { experience: new ExperienceBook(fileExperienceStore(process.env.AI_MAYOR_EXPERIENCE_BOOK)) } : {}),
    // What survives a restart of the run process (builder-memory.ts), keyed by the world: set by the live host (the supervisor restarts the run).
    ...(process.env.AI_MAYOR_BUILDER_MEMORY_FILE && process.env.AI_MAYOR_BUILDER_MEMORY_KEY
      ? { memory: fileBuilderMemory(process.env.AI_MAYOR_BUILDER_MEMORY_FILE, process.env.AI_MAYOR_BUILDER_MEMORY_KEY), memoryKey: process.env.AI_MAYOR_BUILDER_MEMORY_KEY } : {}),
    // The decision rows go to the evidence file (live runs) and to the product host's listener (the console shows the latest cycle's reasoning).
    ...(process.env.AI_MAYOR_DECISION_FILE || decisionListener ? { decisionLog: (row: string) => {
      if (process.env.AI_MAYOR_DECISION_FILE) { try { appendFileSync(process.env.AI_MAYOR_DECISION_FILE, `${row}\n`); } catch { /* evidence never stops the city */ } }
      try { decisionListener?.(row); } catch { /* a listener never stops the city */ }
    } } : {}),
    outcomes: new ExecutionOutcomeRecorder(Date.now, process.env.AI_MAYOR_TELEMETRY_FILE
    // Live diagnostics only: one JSON row per construction call, appended to the named file.
    ? (row) => cappedAppend(process.env.AI_MAYOR_TELEMETRY_FILE!, `${JSON.stringify(row)}\n`) : undefined) });


  // FINANCIAL_RECOVERY reads the world and the books through the same tools every profile uses, and writes through the
  // same serialized write path the district builder uses. Facts that decide a repair are confirmed on each building's
  // own service state, not taken from an icon count: icons were measured to under-report (control buildings with no
  // icon were just as unserved) and an aggregate capacity reading says nothing about delivery.
  const financeRecoveryPort: FinanceRecoveryPort = {
    readFacts: async (signal) => {
      const budget = record(await callTool("cs2_budget", {}, signal));
      const overview = record(await callTool("cs2_city_overview", {}, signal));
      const budgets = record(await callTool("cs2_service_budgets", {}, signal));
      const taxes = record(record(await callTool("cs2_get_taxes", {}, signal)).taxRates);
      const loan = record(record(await callTool("cs2_get_loan", {}, signal)).currentLoan);
      const demand = record(await callTool("cs2_demand", {}, signal));
      const notifications = record(await callTool("cs2_notifications", { limit: 500 }, signal));
      const listed = record(await callTool("cs2_list_buildings", { limit: 500 }, signal));
      const buildings = (Array.isArray(listed.buildings) ? listed.buildings : []).map(record);
      const income = record(budget.income);
      const areas: TaxArea[] = ["Residential", "Commercial", "Industrial", "Office"];
      const taxPenalty: Partial<Record<TaxArea, number>> = {};
      const factorsOf = (value: unknown) => record(record(value).factors);
      const residentialFactors = factorsOf(demand.residential);
      taxPenalty.Residential = Math.min(0, ...["lowDensity", "mediumDensity", "highDensity"].map((density) => Number(record(residentialFactors[density]).Taxes ?? 0)));
      taxPenalty.Commercial = Math.min(0, Number(factorsOf(demand.commercial).Taxes ?? 0));
      taxPenalty.Industrial = Math.min(0, Number(factorsOf(demand.industrial).Taxes ?? 0));
      taxPenalty.Office = Math.min(0, Number(factorsOf(demand.office).Taxes ?? 0));
      // Icons -> distinct buildings per utility; then each is checked against the building's own consumerService.
      const items = (Array.isArray(notifications.notifications) ? notifications.notifications : []).map(record);
      const complete = items.length >= Number(notifications.total);
      const flagged: Record<"electricity" | "water" | "sewage", Map<string, { index: number; version: number }>> = { electricity: new Map(), water: new Map(), sewage: new Map() };
      let assetLossIcons = 0;
      const notConnected: Array<{ index: number; version: number; prefab: string }> = [];
      for (const item of items) {
        const type = String(item.type ?? "");
        const target = record(item.target);
        const ref = { index: Number(target.index), version: Number(target.version) };
        const key = `${ref.index}:${ref.version}`;
        if (/^Electricity Notification/i.test(type)) flagged.electricity.set(key, ref);
        else if (/^Water Notification/i.test(type)) flagged.water.set(key, ref);
        else if (/^Sewage Notification/i.test(type)) flagged.sewage.set(key, ref);
        else if (/Condemned|Abandoned|Collapsed|Burned|On Fire|Destroyed/i.test(type)) assetLossIcons += 1;
        else if (/Not Connected/i.test(type) && Number.isFinite(ref.index)) notConnected.push({ ...ref, prefab: String(target.prefab ?? "") });
      }
      const consumerState = async (ref: { index: number; version: number }) => {
        try {
          return record(record(await callTool("cs2_utility_connectors", { index: ref.index, version: ref.version }, signal)).consumerService);
        } catch { return {} as Record<string, unknown>; }
      };
      const confirm = async (utility: "electricity" | "water" | "sewage") => {
        const refs = [...flagged[utility].values()];
        const sample = refs.slice(0, 10);
        let agree = 0;
        for (const ref of sample) {
          const state = await consumerState(ref);
          const electricity = record(state.electricity);
          const water = record(state.water);
          const unserved = utility === "electricity"
            ? Number(electricity.wantedConsumption) > 0 && Number(electricity.fulfilledConsumption) < Number(electricity.wantedConsumption) * 0.99
            : utility === "water" ? water.waterConnected === false : water.sewageConnected === false;
          if (unserved) agree += 1;
        }
        return { count: refs.length, agreement: sample.length === 0 ? 1 : agree / sample.length };
      };
      const confirmed = await Promise.all((["electricity", "water", "sewage"] as const).map(confirm));
      const unservedConfirmed = complete && confirmed.every((entry) => entry.agreement >= 0.7);
      // Facilities: the game's own "not connected" icons plus every utility facility whose connector reads unattached.
      const facilityRows = buildings.filter((row) => {
        const line = serviceLineOfPrefab(String(row.prefab ?? ""));
        return line === "Electricity" || line === "Water & Sewage";
      });
      const unattached = new Map<number, UnattachedFacility>();
      const candidates = [...facilityRows.map((row) => ({ index: Number(record(row.entity).index), version: Number(record(row.entity).version), prefab: String(row.prefab) })),
        ...notConnected.filter((entry) => !facilityRows.some((row) => Number(record(row.entity).index) === entry.index))];
      for (const facility of candidates) {
        try {
          const read = record(await callTool("cs2_utility_connectors", { index: facility.index, version: facility.version }, signal));
          const connectors = (Array.isArray(read.connectors) ? read.connectors : []).map(record);
          const loose = connectors.find((connector) => connector.attached === false);
          if (!loose) continue;
          const position = record(record(read.facility).position);
          unattached.set(facility.index, { entity: { index: facility.index, version: facility.version }, prefab: facility.prefab, utility: String(loose.type ?? "electricity"),
            position: { x: Number(position.x), z: Number(position.z) } });
        } catch { /* unreadable: not claimed */ }
      }
      const byLine: Record<string, Array<{ entity: { index: number; version: number }; prefab: string }>> = {};
      for (const row of buildings) {
        const line = serviceLineOfPrefab(String(row.prefab ?? ""));
        if (!line) continue;
        (byLine[line] ??= []).push({ entity: { index: Number(record(row.entity).index), version: Number(record(row.entity).version) }, prefab: String(row.prefab) });
      }
      const expenses = Math.abs(Number(budget.totalExpenses));
      let electricityHeadroom: number | null = null;
      try {
        const power = record(record(record(await callTool("cs2_mayor_snapshot", {}, signal)).utilities).electricity);
        const production = Number(power.production), load = Number(power.consumption);
        if (Number.isFinite(production) && Number.isFinite(load) && load > 0) electricityHeadroom = production / load;
      } catch { /* unread: no surplus is claimed */ }
      const serviceIcons = { garbage: 0, health: 0, deathcare: 0 };
      for (const item of items) {
        const type = String(item.type ?? "");
        if (/Garbage/i.test(type)) serviceIcons.garbage += 1;
        else if (/Ambulance|Sick/i.test(type)) serviceIcons.health += 1;
        else if (/Hearse|Dead|Death/i.test(type)) serviceIcons.deathcare += 1;
      }
      const facts: FinanceFacts = {
        electricityHeadroom, serviceIcons,
        treasury: Number(overview.treasury), monthlyIncome: Number(budget.totalIncome), monthlyExpenses: expenses, monthlyBalance: Number(budget.balance),
        incomeByTaxArea: { Residential: Number(income.TaxResidential ?? 0), Commercial: Number(income.TaxCommercial ?? 0), Industrial: Number(income.TaxIndustrial ?? 0), Office: Number(income.TaxOffice ?? 0) },
        serviceLines: (Array.isArray(budgets.services) ? budgets.services : []).map(record).filter((line) => typeof line.name === "string")
          .map((line) => ({ name: String(line.name), budgetPercent: Number(line.budgetPercent), efficiencyPercent: Number(line.efficiencyPercent), estimatedUpkeep: Number(line.estimatedUpkeep) })),
        taxRates: Object.fromEntries(areas.map((area) => [area, Number(record(taxes[area]).rate)]).filter(([, rate]) => Number.isFinite(rate))) as Partial<Record<TaxArea, number>>,
        taxDemandPenalty: taxPenalty, loanPrincipal: Number(loan.amount ?? 0), population: Number(overview.population), happiness: Number(overview.averageHappiness),
        unserved: { electricity: unservedConfirmed ? Math.round(confirmed[0]!.count * confirmed[0]!.agreement) : 0, water: unservedConfirmed ? Math.round(confirmed[1]!.count * confirmed[1]!.agreement) : 0,
          sewage: unservedConfirmed ? Math.round(confirmed[2]!.count * confirmed[2]!.agreement) : 0 },
        unservedConfirmed, unattachedFacilities: [...unattached.values()], assetLossIcons, facilitiesByServiceLine: byLine,
        buildingCount: buildings.filter((row) => !/Ruins/i.test(String(row.prefab ?? ""))).length,
      };
      return facts;
    },
    // More capacity for a utility: the same shared placement primitive the district builder uses, over the facilities the
    // world offers for it (ranked by capacity per cost), and read back for its connection.
    provisionUtility: async (utility, signal) => {
      const repair = await districtBuilder.repairUtilities({ kinds: [utility], shortfalls: { [utility]: 1 }, signal });
      return { ok: repair.placed.some((placement) => placement.attached === true), detail: repair.notes.join("; ").slice(0, 300) };
    },
    setServiceBudget: async (service, percent, signal) => (await districtWrite("cs2_set_service_budget", { service, percentage: percent }, signal)).ok,
    setTax: async (area, rate, signal) => (await districtWrite("cs2_set_tax", { area, rate }, signal)).ok,
    demolish: async (entity, signal) => (await districtWrite("cs2_demolish", { index: entity.index, version: entity.version }, signal)).ok,
    // Lay the facility's own net (cable or pipe) from its connector to the nearest point of the main street network, then
    // read the connector back: only an attached connector is success.
    connectFacility: async (facility, signal) => {
      const kind = /elec/i.test(facility.utility) ? "electricity" : /sewage/i.test(facility.utility) ? "sewage" : "water";
      const world = buildSpatialWorldModel(parseSpatialBootstrapScan(await callTool("cs2_spatial", { mode: "scan", roadLimit: 2_000 }, signal)));
      const streets = mainStreetNetwork(world.roadGraph).edges;
      let best: { point: { x: number; z: number }; meters: number } | null = null;
      for (const edge of streets) {
        const dx = edge.end.x - edge.start.x; const dz = edge.end.z - edge.start.z;
        const lengthSquared = dx * dx + dz * dz;
        const ratio = lengthSquared > 0 ? Math.max(0.1, Math.min(0.9, ((facility.position.x - edge.start.x) * dx + (facility.position.z - edge.start.z) * dz) / lengthSquared)) : 0.5;
        const point = { x: edge.start.x + dx * ratio, z: edge.start.z + dz * ratio };
        const meters = Math.hypot(point.x - facility.position.x, point.z - facility.position.z);
        if (!best || meters < best.meters) best = { point, meters };
      }
      if (!best) return { ok: false, detail: "no street network to connect to" };
      const prefab = DISTRICT_UTILITY_CONNECTION_PREFAB[kind];
      const laid = await districtWrite("cs2_build_road", { prefab, x1: facility.position.x, z1: facility.position.z, x2: best.point.x, z2: best.point.z,
        e1: BURIED_NET_ELEVATION_METERS, e2: BURIED_NET_ELEVATION_METERS }, signal);
      if (!laid.ok) return { ok: false, detail: `${prefab} ${best.meters.toFixed(0)} m refused: ${laid.detail.slice(0, 120)}` };
      await waitForAuthoritativeNativeIdle(signal);
      const read = record(await callTool("cs2_utility_connectors", { index: facility.entity.index, version: facility.entity.version }, signal));
      const attached = (Array.isArray(read.connectors) ? read.connectors : []).map(record).some((connector) => connector.attached === true);
      return { ok: attached, detail: `${prefab} ${best.meters.toFixed(0)} m to the street: ${attached ? "attached" : "still not attached"}` };
    },
  };
  const financeRecovery = new FinanceRecoveryLoop(financeRecoveryPort);

  return {
    v2ProductionSkillRuntime,
    v2Gate1Progression,
    districtBuilder,
    financeRecovery,
    getBalance: async () => {
      const provider = providerOrThrow(options);
      return (options.fetchBalance ?? fetchDeepSeekBalance)(provider);
    },
    getSnapshot,
    refreshActionableCandidates: getSnapshot,
    ensureGrowthOpportunity,
    ensureUtilityCapacity,
    focusTarget: async (target) => {
      if (target.kind !== "candidate") return false;
      const candidate = candidateSet.registry.get(target.candidateId);
      if (!candidate) return false;
      try {
        await callTool("cs2_set_camera", {
          x: candidate.center.x,
          z: candidate.center.z,
          angleX: 25,
          angleY: 68,
          zoom: 75,
        });
        return true;
      } catch {
        return false;
      }
    },
    realizeUrbanDesignIntent: realizeIntent,
    getUrbanDesignNoveltyMemory: () => noveltyMemory,
    decide: decideWithProvider,
    decideUrbanDesign: decideWithProvider,
    executeActions: async (actions: MayorPlanAction[], signal?: AbortSignal) => {
      const selectedUrbanDesign =
        activeRealization &&
        actions.some(
          (action) =>
            action.type === "choose_candidate" &&
            candidateSet.registry.get(action.candidateId)?.summary.urbanDesign?.designProposalId ===
              activeRealization?.proposal.proposalId,
        );
      await nativeBuildMutex.acquire(signal);
      try {
        let resolved: MayorAction[];
        let resolvedOriginalIndices: number[] = [];
        let resolvedCandidates: Awaited<ReturnType<typeof resolveActions>>["candidates"] = [];
        try {
          const resolvedSet = await resolveActions(actions, signal);
          resolved = resolvedSet.actions;
          resolvedOriginalIndices = resolvedSet.originalIndices;
          resolvedCandidates = resolvedSet.candidates;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const actionType: MayorAction["type"] =
            actions[0]?.type === "choose_candidate" ? "zone" : (actions[0]?.type ?? "zone");
          return {
            ok: false,
            requested: actions.length,
            executed: 0,
            failedAt: 0,
            results: [
              {
                index: 0,
                type: actionType,
                ok: false,
                summary: "pre_dispatch_rejected",
                error: reason,
              },
            ],
          } as MayorBatchResult;
        }
        let batch: MayorBatchResult;
        const dispatchRevision = resolveSpatialRevision(latestSpatial?.context);
        const dispatchActions: MayorAction[] = [];
        const dispatchOriginalIndices: number[] = [];
        const dispatchCandidates: Array<PrivateMayorCandidate | undefined> = [];
        for (const [resolvedIndex, action] of resolved.entries()) {
          if (action.type !== "build_road") {
            dispatchActions.push(action);
            dispatchOriginalIndices.push(resolvedOriginalIndices[resolvedIndex] ?? resolvedIndex);
            dispatchCandidates.push(resolvedCandidates[resolvedIndex]);
            continue;
          }
          const candidate = resolvedCandidates[resolvedIndex];
          if (!isCandidateAvailable(dispatchRevision, action, candidateAvailability, candidate?.summary)) {
            setRoadCandidateAvailability(action, "quarantined", dispatchRevision, candidate?.summary);
            continue;
          }
          dispatchActions.push(action);
          dispatchOriginalIndices.push(resolvedOriginalIndices[resolvedIndex] ?? resolvedIndex);
          dispatchCandidates.push(candidate);
        }
        if (dispatchActions.length === 0) {
          return {
            ok: false,
            requested: actions.length,
            executed: 0,
            failedAt: 0,
            results: [
              {
                index: resolvedOriginalIndices[0] ?? 0,
                type: "build_road",
                ok: false,
                summary: "road_attempt_guard_skipped",
                error: "road action already succeeded or is quarantined for the current spatial revision",
              },
            ],
          } as MayorBatchResult;
        }
        try {
          const roadActions = dispatchActions.filter((action) => action.type === "build_road");
          if (roadActions.length > 0 && roadActions.length !== dispatchActions.length) {
            throw new Error("mixed ROAD/non-ROAD execution batches are not accepted by the V2 ROAD runtime boundary");
          }
          if (roadActions.length > 0) {
            const results: MayorBatchResult["results"] = [];
            for (const [index, action] of roadActions.entries()) {
              const candidate = dispatchCandidates[index];
              const result = await v2RoadCaller.execute(
                {
                  input: {
                    prefab: action.prefab,
                    x1: action.x1,
                    z1: action.z1,
                    x2: action.x2,
                    z2: action.z2,
                    ...(action.cx !== undefined ? { cx: action.cx } : {}),
                    ...(action.cz !== undefined ? { cz: action.cz } : {}),
                    ...(action.e1 !== undefined ? { e1: action.e1 } : {}),
                    ...(action.e2 !== undefined ? { e2: action.e2 } : {}),
                    ...(action.networkJunctionInsert ? { networkJunctionInsert: action.networkJunctionInsert } : {}),
                  },
                  owner: {
                    ownerType: "TASK",
                    ownerId: candidate?.summary.id ?? `runtime-road-${roadActionKey(action)}`,
                  },
                },
                signal,
              );
              const ok = result.command.status === "OBSERVED_MATCH";
              results.push(aggregateV2RoadBatchResult(index, result));
              if (!ok) break;
            }
            const executed = results.filter((result) => result.ok).length;
            const failedAt = results.find((result) => !result.ok)?.index;
            batch = {
              ok: failedAt === undefined && results.length === roadActions.length,
              requested: roadActions.length,
              executed,
              ...(failedAt === undefined ? {} : { failedAt }),
              results,
            };
          } else {
            batch = await withBoundedNativeBuildBackpressure(
              async () =>
                executeLegacyActionBatch(dispatchActions, signal),
              (candidateBatch) =>
                candidateBatch.results.length > 0 &&
                candidateBatch.results.every(
                  (result) =>
                    result.ok !== true &&
                    /another build operation is in progress|build operation.*busy/i.test(
                      `${result.error ?? ""} ${result.summary ?? ""}`,
                    ),
                ),
              signal,
            );
            await waitForAuthoritativeNativeIdle(signal);
          }
          for (const result of batch.results) {
            if (result.type !== "build_road") continue;
            const action = dispatchActions[result.index];
            if (action) {
              const candidate = [...candidateSet.registry.values()].find((entry) => entry.action === action);
              recordRoadAttempt(action, result.ok === true ? "success" : "rejected", candidate?.summary, dispatchRevision ?? undefined);
              setRoadCandidateAvailability(
                action,
                result.ok === true ? "succeeded" : "rejected",
                dispatchRevision ?? undefined,
                candidate?.summary,
              );
            }
          }
          if (dispatchActions.length !== actions.length) {
            batch = {
              ...batch,
              results: batch.results.map((result) => ({
                ...result,
                index: dispatchOriginalIndices[result.index] ?? result.index,
              })),
            };
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            requested: actions.length,
            executed: 0,
            failedAt: 0,
            results: [
              {
                index: 0,
                type: resolved[0]?.type ?? "zone",
                ok: false,
                summary: "executor_failed",
                error: `road_executor_blocker:${reason}`,
              },
            ],
          } as MayorBatchResult;
        }
        if (batch.ok === true && selectedUrbanDesign && activeRealization) {
          noveltyMemory = recordSuccessfulUrbanDesignLifecycle({
            memory: noveltyMemory,
            result: activeRealization.proposal,
            lifecycle: "executed",
            successful: true,
          });
          activeRealization = null;
        }
        return batch;
      } finally {
        recoveryCandidateSet = null;
        await nativeBuildMutex.release();
      }
    },
    runSimulation,
    observeRunningSimulation,
    awaitUtilityCapacity,
    readGameFrame: async (signal?: AbortSignal) => {
      const game = record(await callTool("cs2_game_state", {}, signal));
      return simulationFrameIndex(game, record(game.simulation));
    },
    checkBlockingModal: (signal) => blockingModal.check(signal),
    watchBlockingModal: (signal) => blockingModal.watch(signal),
    resetBlockingModalMemory: () => blockingModal.reset(),
    pause: async () => {
      await callTool("cs2_run_simulation", { cancel: true });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const game = record(await callTool("cs2_game_state"));
        const simulation = record(game.simulation);
        if (game.simulationPaused === true || simulation.paused === true) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("CS2 did not confirm paused state after simulation cancel");
    },
    confirmPaused: async () => {
      const snapshot = record(await callTool("cs2_mayor_snapshot", {}));
      const game = record(snapshot.game);
      return game.paused === true;
    },
    // Read-only labour view for the run ledger. It is its own call because the
    // mayor snapshot does not carry labour, and it is deliberately not folded
    // into any decision: the ledger records it and nothing acts on it.
    readLabor: async (signal?: AbortSignal) => callTool("cs2_labor", {}, signal),
    // Release the consistency window the product takes for a mutation. The
    // Bridge's write endpoints take no pause requirement of their own, so this
    // is purely "stop holding the city still", never a resume of game state the
    // product had a right to leave stopped.
    resume: async (signal?: AbortSignal) => {
      await callTool("cs2_set_simulation", { paused: false, speed: AUTONOMOUS_RESUME_SPEED }, signal);
    },
    save: async (name) => {
      if (processSaveInFlight) throw new Error("SAVE_BUSY: a native save operation is still in flight or unresolved");
      const nativeOperation = (async () => {
        const saveState = record(await callTool("cs2_save_status", {}));
        if (saveState.state !== undefined && saveState.state !== "IDLE") {
          throw new Error(`SAVE_BUSY: authoritative Bridge save state is ${String(saveState.state)}`);
        }
        let journalPosition = 0;
        if (v2FoundationPorts.durability) {
          v2FoundationPorts.durability.activate(await callTool("cs2_game_state", {}));
          journalPosition = v2FoundationPorts.durability.currentJournalPosition();
        }
        const submitted = record(await callTool("cs2_save_game", { name }));
        if (typeof submitted.saveRequestId !== "string" || submitted.status !== "SUBMITTED") {
          throw new Error(`native save was not accepted: ${String(submitted.status ?? "UNKNOWN")}`);
        }
        const requestId = submitted.saveRequestId;
        while (true) {
          let status: Record<string, unknown>;
          try {
            status = record(await callTool("cs2_save_status", { requestId }));
          } catch {
            // A transport/MCP timeout is not a native terminal result. Keep
            // the process-wide slot occupied and continue authoritative poll.
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          if (status.status === "COMPLETED" && status.durable === true) {
            v2FoundationPorts.durability?.recordCheckpoint(status as unknown as SaveCompletionReceipt, journalPosition);
            return;
          }
          if (status.status === "FAILED") {
            throw new Error(`native save failed: ${String(status.reason ?? status.status)}`);
          }
          if (status.status === "UNKNOWN") {
            throw new Error(`native save completion is unknown: ${String(status.reason ?? status.status)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      processSaveInFlight = nativeOperation;
      // Clear the process guard only when the native operation reaches a
      // terminal status. Suppress a late rejection after caller timeout while
      // preserving the guard until this handler runs.
      void nativeOperation.then(
        () => {
          if (processSaveInFlight === nativeOperation) processSaveInFlight = null;
        },
        () => {
          if (processSaveInFlight === nativeOperation) processSaveInFlight = null;
        },
      );
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const callerTimeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("SAVE_COMPLETION_UNKNOWN: native save did not reach a terminal state within 30 seconds")),
            options.saveCompletionTimeoutMs ?? 30_000,
          );
        });
        await Promise.race([nativeOperation, callerTimeout]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      } finally {
        // The native operation owns processSaveInFlight and clears it only at
        // terminal completion. This finally only removes the caller timer.
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },
    lifecycle: {
      worldIdentity: async (signal) => {
        try {
          const state = record(await callTool("cs2_game_state", {}, signal));
          const world = record(state.world);
          if (state.gameMode !== "Game" || state.cityLoaded !== true || state.isLoading === true) return null;
          const worldId = typeof world.worldId === "string" ? world.worldId : null;
          const generation = typeof world.generation === "string" ? world.generation : null;
          if (!worldId || !generation) return null;
          const frame = record(state.simulation).frameIndex;
          return { id: `${String(state.bridgeRuntimeEpoch ?? "")}:${worldId}:${generation}`, frame: typeof frame === "number" ? frame : null };
        } catch {
          return null;
        }
      },
      freeCommitGb: () => readFreeCommitGb(),
      // Crash protection only. The game's own native save, polled to a terminal state, then a health read-back; the pause and speed the
      // game had before are left as they were. The save is never read back as a fact about the world.
      checkpointSave: async (name, signal) => {
        const read = async () => record(await callTool("cs2_game_state", {}, signal));
        const before = await read();
        const beforeSim = record(before.simulation);
        if (processSaveInFlight) return { ok: false, detail: "another save is still in flight" };
        const status = record(await callTool("cs2_save_status", {}, signal));
        if (status.state !== undefined && status.state !== "IDLE") return { ok: false, detail: `save state is ${String(status.state)}` };
        const submitted = record(await callTool("cs2_save_game", { name }, signal));
        if (typeof submitted.saveRequestId !== "string" || submitted.status !== "SUBMITTED") return { ok: false, detail: `not accepted: ${String(submitted.status ?? submitted.error ?? "UNKNOWN")}` };
        const startedAt = Date.now();
        let terminal: Record<string, unknown> | null = null;
        while (Date.now() - startedAt < 60_000 && !signal?.aborted) {
          try { terminal = record(await callTool("cs2_save_status", { requestId: submitted.saveRequestId }, signal)); } catch { terminal = null; }
          if (terminal && (terminal.status === "COMPLETED" || terminal.status === "FAILED" || terminal.status === "UNKNOWN")) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!terminal || terminal.status !== "COMPLETED" || terminal.durable !== true) return { ok: false, detail: `save ended ${String(terminal?.status ?? "without a terminal state")}: ${String(terminal?.reason ?? "")}`.trim() };
        // The session must still be healthy, and the clock exactly as it was.
        const after = await read();
        const afterSim = record(after.simulation);
        if (after.gameMode !== "Game" || after.cityLoaded !== true || after.isLoading === true) return { ok: false, detail: "saved, but the game session no longer reads as a loaded city" };
        if (afterSim.paused !== beforeSim.paused || afterSim.selectedSpeed !== beforeSim.selectedSpeed) {
          await callTool("cs2_set_simulation", { paused: beforeSim.paused === true, ...(typeof beforeSim.selectedSpeed === "number" && beforeSim.selectedSpeed > 0 ? { speed: beforeSim.selectedSpeed } : {}) }, signal);
        }
        return { ok: true, detail: `${name} saved in ${((Date.now() - startedAt) / 1000).toFixed(1)} s` };
      },
    },
    emit: options.emit,
    emitMayorCommentary: options.emitMayorCommentary,
  };
}

/**
 * The machine's free commit memory (physical + page file not yet promised to a process), in GB. Windows only; null elsewhere or on any
 * error. Cached for 20 s: each read starts a PowerShell, and the figure moves slowly.
 */
let commitCache: { atMs: number; gb: number | null } | null = null;
async function readFreeCommitGb(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  if (commitCache && Date.now() - commitCache.atMs < 20_000) return commitCache.gb;
  const gb = await new Promise<number | null>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory"], { timeout: 8_000, windowsHide: true },
      (error, stdout) => {
        const kilobytes = Number(String(stdout).trim());
        resolve(error || !Number.isFinite(kilobytes) ? null : kilobytes / 1024 / 1024);
      });
  });
  commitCache = { atMs: Date.now(), gb };
  return gb;
}
