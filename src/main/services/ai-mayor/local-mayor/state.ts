import { availableZoneDomains, residentialZoneDemand } from "../action-candidates";
import { scanCityIssues } from "./issues";
import { deriveServiceRecoveryIntent } from "./service-recovery";
import type {
  LocalDevelopmentCapacity,
  LocalGrowthIntent,
  LocalMayorCandidateRef,
  LocalMayorGrowthDomain,
  LocalMayorHistory,
  LocalMayorState,
  LocalMayorUtilityState,
  LocalTypedDevelopmentReserve,
  LocalTypedReserveDeficit,
} from "./types";
import { LOCAL_MAYOR_MAX_COOLDOWNS, LOCAL_MAYOR_MAX_HISTORY, LOCAL_MAYOR_STATE_VERSION } from "./types";

type JsonObject = Record<string, any>;
const record = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const demandValue = (value: unknown): number | null => {
  const direct = finite(value);
  if (direct !== null) return direct;
  const levels = record(value);
  const values = [finite(levels.low), finite(levels.medium), finite(levels.high)].filter(
    (candidate): candidate is number => candidate !== null,
  );
  return values.length > 0 ? Math.max(...values) : null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value as JsonObject)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  let hash = 2_166_136_261;
  for (const character of stableJson(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function utilityState(
  source: unknown,
  capacityKey: "production" | "capacity",
  consumptionKey: "consumption",
): LocalMayorUtilityState {
  const value = record(source);
  const available = value.status === "available";
  const capacity = finite(value[capacityKey]);
  const consumption = finite(value[consumptionKey]);
  const fulfilled = finite(value.fulfilledConsumption);
  const headroom = capacity !== null && consumption !== null ? capacity - consumption : null;
  // A shortage is load that is not being served. With no load there is nothing
  // to be short of: `capacity - consumption` is zero for an uncommissioned
  // utility and `Math.max(1, consumption * 0.1)` is 1, so the old comparison
  // read "no supply, no demand" as the worst possible headroom and raised a
  // permanent global emergency on a city that had not yet been built.
  const carried = consumption === null ? null : Math.max(consumption, fulfilled ?? 0);
  const hasLoad = carried !== null && carried > 0;
  const uncommissioned = available && !hasLoad && capacity !== null && capacity <= 0;
  // Unserved load with supply to spare is a DELIVERY gap at particular consumers, not a shortage: more supply
  // cannot close it. Measured live (2026-10-03): production 22873 against consumption 10520, fulfilled 4102 —
  // 91% of the load was three groundwater pumping stations, two of them never connected to anything, while every
  // home, shop and factory read 99-100% fulfilled. Reading that as "critical" raised an urgency-100 supply Goal
  // that died at admission every cycle and switched off the reserve-growth Goals behind `hasCriticalUtility`.
  const shortOfSupply = capacity === null || consumption === null || capacity < consumption;
  const undeliveredLoad = fulfilled !== null && consumption !== null && fulfilled < consumption && !shortOfSupply
    ? consumption - fulfilled : 0;
  const risk: LocalMayorUtilityState["risk"] =
    !available || headroom === null || consumption === null
      ? "unknown"
      : !hasLoad
        ? "healthy"
        : fulfilled !== null && fulfilled < consumption && shortOfSupply
          ? "critical"
          : headroom <= Math.max(1, consumption * 0.1)
            ? "critical"
            : headroom <= Math.max(1, consumption * 0.25)
              ? "tight"
              : "healthy";
  return { available, headroom, load: carried, risk, uncommissioned, ...(undeliveredLoad > 0 ? { undeliveredLoad } : {}) };
}

/**
 * Utility kinds a fresh city has to commission before its first committed
 * development can operate, in the order preparation asks for them.
 *
 * Only the three piped/wired utilities are bootstrap requirements. Healthcare,
 * education, garbage and fire are services a city acquires as it grows; they are
 * observed and never become a placement Goal, so they are deliberately absent
 * here.
 */
export const UTILITY_BOOTSTRAP_KINDS = ["electricity", "water", "sewage"] as const;

export function uncommissionedUtilityKinds(
  utilities: LocalMayorState["utilities"],
): Array<(typeof UTILITY_BOOTSTRAP_KINDS)[number]> {
  return UTILITY_BOOTSTRAP_KINDS.filter((kind) => utilities[kind].uncommissioned);
}

function candidateRef(value: unknown): LocalMayorCandidateRef | null {
  const candidate = record(value);
  if (typeof candidate.id !== "string" || (candidate.actionType !== "zone" && candidate.actionType !== "build_road"))
    return null;
  const adjacent = record(candidate.adjacentRoad);
  const source = record(candidate.sourceRoad);
  const areaType = ["Residential", "Commercial", "Industrial", "Office"].includes(candidate.areaType)
    ? candidate.areaType
    : null;
  return {
    id: candidate.id,
    kind: candidate.actionType === "zone" ? "zoning" : "road_expansion",
    areaType,
    estimatedCost: finite(candidate.estimatedCost),
    approximateLength: finite(candidate.approximateLength),
    approximateCells: finite(candidate.approximateCells),
    approximateNewFrontage: finite(candidate.approximateNewFrontage),
    conflictGroup: typeof candidate.conflictGroup === "string" ? candidate.conflictGroup : null,
    spatialRole:
      candidate.spatialRole === "infill" || candidate.spatialRole === "small_expansion" ? candidate.spatialRole : null,
    sourceRoad:
      Number.isInteger(source.index) && Number.isInteger(source.version)
        ? { index: source.index, version: source.version }
        : Number.isInteger(adjacent.entity?.index) && Number.isInteger(adjacent.entity?.version)
          ? { index: adjacent.entity.index, version: adjacent.entity.version }
          : null,
    approximateDirection:
      typeof candidate.approximateDirection === "string" ? candidate.approximateDirection : undefined,
    roadHeadingDegrees: finite(candidate.roadHeadingDegrees) ?? undefined,
    roadHeadingDeltaDegrees: finite(candidate.roadHeadingDeltaDegrees) ?? undefined,
    validationStatus: "validated",
    growthDomain: ["residential", "commercial", "industrial", "office"].includes(candidate.growthDomain)
      ? (candidate.growthDomain as LocalMayorGrowthDomain)
      : undefined,
  };
}

function growthIntent(value: unknown): LocalGrowthIntent | undefined {
  const intent = record(value);
  const domain = ["residential", "commercial", "industrial", "office"].includes(intent.domain)
    ? (intent.domain as LocalMayorGrowthDomain)
    : null;
  const phase = ["corridor", "zoning", "digest"].includes(intent.phase) ? intent.phase : null;
  const source = record(intent.sourceRoad);
  if (!domain || !phase || intent.version !== 1) return undefined;
  return {
    version: 1,
    domain,
    phase,
    sourceRoad:
      Number.isInteger(source.index) && Number.isInteger(source.version)
        ? { index: source.index, version: source.version }
        : null,
    preferredHeadingDegrees: finite(intent.preferredHeadingDegrees),
    targetCorridorLength: Math.max(180, Math.min(640, Math.round(finite(intent.targetCorridorLength) ?? 240))),
    completedCorridorLength: Math.max(0, Math.round(finite(intent.completedCorridorLength) ?? 0)),
    remainingSegments: Math.max(0, Math.min(8, Math.round(finite(intent.remainingSegments) ?? 0))),
    maxSegments: Math.max(1, Math.min(8, Math.round(finite(intent.maxSegments) ?? 1))),
    remainingZoningPatches: Math.max(0, Math.min(8, Math.round(finite(intent.remainingZoningPatches) ?? 0))),
    maxZoningPatches: Math.max(1, Math.min(8, Math.round(finite(intent.maxZoningPatches) ?? 1))),
    createdRevision: typeof intent.createdRevision === "string" ? intent.createdRevision : null,
    valid: intent.valid !== false,
    status: intent.status === "blocked" || intent.status === "completed" ? intent.status : "active",
    digestStartedGameTime: typeof intent.digestStartedGameTime === "string" ? intent.digestStartedGameTime : null,
    completionReason: [
      "corridor_target_reached",
      "corridor_frontage_sufficient",
      "corridor_safe_truncated",
      "corridor_no_continuation_candidate",
      "corridor_world_stale",
    ].includes(intent.completionReason)
      ? intent.completionReason
      : undefined,
  };
}

function normalizeHistory(history?: Partial<LocalMayorHistory>): LocalMayorHistory {
  return {
    recentActions: (history?.recentActions ?? []).slice(-LOCAL_MAYOR_MAX_HISTORY),
    cooldowns: (history?.cooldowns ?? [])
      .filter((cooldown) => cooldown.remainingObservations > 0)
      .slice(-LOCAL_MAYOR_MAX_COOLDOWNS),
    consecutiveWaits: Math.max(0, Math.min(3, history?.consecutiveWaits ?? 0)),
    issueMemory: (history?.issueMemory ?? []).slice(0, 8),
    ...(history?.serviceRecovery ? { serviceRecovery: history.serviceRecovery } : {}),
  };
}

function uniqueCandidateCapacity(
  candidates: LocalMayorCandidateRef[],
  key: "approximateCells" | "approximateNewFrontage",
) {
  const groups = new Map<string, number>();
  for (const candidate of candidates) {
    const value = candidate[key] ?? (key === "approximateNewFrontage" ? candidate.approximateLength : 1) ?? 0;
    const group = candidate.conflictGroup ?? candidate.id;
    groups.set(group, Math.max(groups.get(group) ?? 0, value));
  }
  return [...groups.values()].reduce((sum, value) => sum + value, 0);
}

function developmentCapacity(
  root: JsonObject,
  zoning: LocalMayorCandidateRef[],
  roadExpansion: LocalMayorCandidateRef[],
  history: LocalMayorHistory,
): LocalDevelopmentCapacity {
  const declared = record(root.developmentCapacity);
  const hasDeclared = Object.keys(declared).length > 0;
  const read = (key: string, fallback: number) => Math.max(0, Math.round(finite(declared[key]) ?? fallback));
  const candidateZoningCells = uniqueCandidateCapacity(zoning, "approximateCells");
  const candidateFrontageCapacity = uniqueCandidateCapacity(roadExpansion, "approximateNewFrontage");
  const safeUnzonedRoadsideCells = read("safeUnzonedRoadsideCells", 0);
  const safeUnzonedCells = read("safeUnzonedCells", 0);
  const existingZonedUnoccupiedCells = read("existingZonedUnoccupiedCells", 0);
  const declaredTyped = record(declared.zonedUnoccupiedByType);
  const hasTypedReserve = Object.keys(declaredTyped).length > 0;
  const typed = (key: keyof LocalTypedDevelopmentReserve) => Math.max(0, Math.round(finite(declaredTyped[key]) ?? 0));
  const targetZoningCells = read("targetZoningCells", 0);
  const zonedUnoccupiedByType: LocalTypedDevelopmentReserve = {
    residential: typed("residential"),
    commercial: typed("commercial"),
    industrial: typed("industrial"),
    office: typed("office"),
    unknown: typed("unknown"),
  };
  const declaredDeficit = record(declared.typedReserveDeficit);
  const typedReserveDeficit: LocalTypedReserveDeficit = {
    residential:
      declaredDeficit.residential === true ||
      (hasTypedReserve && targetZoningCells > 0 && typed("residential") < targetZoningCells),
    commercial:
      declaredDeficit.commercial === true ||
      (hasTypedReserve && targetZoningCells > 0 && typed("commercial") < targetZoningCells),
    industrial:
      declaredDeficit.industrial === true ||
      (hasTypedReserve && targetZoningCells > 0 && typed("industrial") < targetZoningCells),
    office:
      declaredDeficit.office === true ||
      (hasTypedReserve && targetZoningCells > 0 && typed("office") < targetZoningCells),
  };
  const existingZonedCells = read("existingZonedCells", 0);
  const availableFrontageCells = read("availableFrontageCells", safeUnzonedRoadsideCells);
  const frontierAnchorCount = read("frontierAnchorCount", 0);
  const targetFrontageCapacity = read("targetFrontageCapacity", 0);
  const availableDevelopmentCells = hasDeclared
    ? read("availableDevelopmentCells", existingZonedUnoccupiedCells + safeUnzonedRoadsideCells + candidateZoningCells)
    : 0;
  const reserveStatus = ["empty", "low", "adequate", "digesting", "unknown"].includes(declared.reserveStatus)
    ? declared.reserveStatus
    : "unknown";
  return {
    safeUnzonedRoadsideCells,
    safeUnzonedCells,
    existingZonedUnoccupiedCells,
    zonedUnoccupiedByType,
    typedReserveDeficit,
    existingZonedCells,
    candidateZoningCells,
    candidateFrontageCapacity,
    availableFrontageCells,
    frontierAnchorCount,
    targetZoningCells,
    targetFrontageCapacity,
    availableDevelopmentCells,
    reserveStatus,
    reserveDeficit: hasDeclared && declared.reserveDeficit === true,
    developmentDigesting: hasDeclared && declared.developmentDigesting === true,
    recentZoningAdded: history.recentActions.filter((entry) => entry.impact === "zoning_added").length,
    recentRoadAddedFrontage: history.recentActions.filter((entry) => entry.impact === "road_added").length,
  } as LocalDevelopmentCapacity;
}

export function compileLocalMayorState(snapshot: unknown, history?: Partial<LocalMayorHistory>): LocalMayorState {
  const root = record(snapshot);
  const game = record(root.game);
  const population = record(root.population);
  const economy = record(root.economy);
  const demand = record(root.demand);
  const utilities = record(root.utilities);
  const electricity = utilityState(utilities.electricity, "production", "consumption");
  const water = utilityState(utilities.water, "capacity", "consumption");
  const sewage = utilityState(utilities.sewage, "capacity", "consumption");
  const treasury = finite(economy.treasury);
  const monthlyBalance = finite(economy.monthlyBalance);
  const financeRunwayMonths =
    treasury !== null && monthlyBalance !== null && monthlyBalance < 0
      ? treasury / Math.abs(monthlyBalance)
      : monthlyBalance !== null && monthlyBalance >= 0
        ? Number.POSITIVE_INFINITY
        : null;
  const candidates = Array.isArray(record(root.actionablePlanning).candidates)
    ? record(root.actionablePlanning)
        .candidates.map((candidate: unknown) => candidateRef(candidate))
        .filter((candidate: LocalMayorCandidateRef | null): candidate is LocalMayorCandidateRef => candidate !== null)
    : [];
  const zoning = candidates.filter((candidate: LocalMayorCandidateRef) => candidate.kind === "zoning").slice(0, 6);
  const roadExpansion = candidates
    .filter((candidate: LocalMayorCandidateRef) => candidate.kind === "road_expansion")
    .slice(0, 3);
  const normalizedHistory = normalizeHistory(history);
  const issues = scanCityIssues(root, normalizedHistory.issueMemory);
  const serviceRecovery = deriveServiceRecoveryIntent(issues.highest, normalizedHistory.serviceRecovery);
  const capacity = developmentCapacity(root, zoning, roadExpansion, normalizedHistory);
  const pendingZoningCells =
    capacity.reserveStatus === "unknown"
      ? zoning.reduce((sum: number, candidate: LocalMayorCandidateRef) => sum + (candidate.approximateCells ?? 1), 0)
      : capacity.availableDevelopmentCells;
  const pendingFrontageCapacity = roadExpansion.reduce(
    (sum: number, candidate: LocalMayorCandidateRef) =>
      sum + (candidate.approximateNewFrontage ?? candidate.approximateLength ?? 0),
    0,
  );
  const declaredCapacity = record(root.developmentCapacity);
  const declaredZoningCells = finite(declaredCapacity.pendingZoningCells);
  const declaredFrontage = finite(declaredCapacity.pendingFrontageCapacity);
  const effectiveZoningCells = declaredZoningCells ?? pendingZoningCells;
  const effectiveFrontage = declaredFrontage ?? pendingFrontageCapacity;
  const declaredGrowthIntent = growthIntent(root.localGrowthIntent);
  const declaredTakeover = record(root.districtTakeover);
  const districtTakeover =
    typeof declaredTakeover.outcome === "string"
      ? {
          previousSiteId: typeof declaredTakeover.previousSiteId === "string" ? declaredTakeover.previousSiteId : null,
          searchRevision: typeof declaredTakeover.searchRevision === "string" ? declaredTakeover.searchRevision : null,
          checkedSources: Array.isArray(declaredTakeover.checkedSources)
            ? declaredTakeover.checkedSources.filter((value): value is string => typeof value === "string").slice(0, 8)
            : [],
          outcome: declaredTakeover.outcome as NonNullable<LocalMayorState["districtTakeover"]>["outcome"],
        }
      : undefined;
  const typedDemandReserveDeficit =
    (Math.max(0, residentialZoneDemand(root) ?? 0) > 0 && capacity.typedReserveDeficit?.residential === true) ||
    (Math.max(0, demandValue(demand.commercial) ?? 0) > 0 && capacity.typedReserveDeficit?.commercial === true) ||
    (Math.max(0, demandValue(demand.industrial) ?? 0) > 0 && capacity.typedReserveDeficit?.industrial === true) ||
    (Math.max(0, demandValue(demand.office) ?? 0) > 0 && capacity.typedReserveDeficit?.office === true);
  const capacityStatus: LocalMayorState["actionability"]["capacityStatus"] =
    capacity.reserveStatus !== "unknown" ||
    declaredZoningCells !== null ||
    declaredFrontage !== null ||
    candidates.length > 0
      ? capacity.reserveStatus === "adequate" ||
        capacity.reserveStatus === "digesting" ||
        effectiveZoningCells >= 16 ||
        effectiveFrontage >= 80
        ? typedDemandReserveDeficit
          ? "insufficient"
          : "sufficient"
        : "insufficient"
      : "unknown";
  const declaredActionability = record(root.localMayorActionability);
  const planning = record(root.actionablePlanning);
  const actionabilityStatus: LocalMayorState["actionability"]["status"] =
    candidates.length > 0
      ? "available"
      : planning.status !== undefined && planning.status !== "available"
        ? "unavailable"
        : declaredActionability.status === "blocked"
          ? "blocked"
          : "empty";
  const defaultReasonCode =
    candidates.length > 0
      ? "candidate_supply_available"
      : capacityStatus === "sufficient"
        ? "development_capacity_pending"
        : "candidate_supply_empty";
  const siteContext = record(record(root.urbanDesign).siteContext);
  const snapshotRevision =
    typeof siteContext.snapshotRevision === "string"
      ? siteContext.snapshotRevision
      : typeof root.snapshotRevision === "string"
        ? root.snapshotRevision
        : null;
  const worldFingerprint = digest({
    game: { status: game.status, cityName: game.cityName, paused: game.paused },
    population: population.current,
    economy: { treasury, monthlyBalance },
    utilities: { electricity, water, sewage },
    candidates: candidates.map((candidate: LocalMayorCandidateRef) => [
      candidate.id,
      candidate.kind,
      candidate.areaType,
    ]),
  });
  return {
    version: LOCAL_MAYOR_STATE_VERSION,
    snapshotRevision,
    worldFingerprint,
    status: game.status === "available" ? "available" : "unavailable",
    game: {
      available: game.status === "available",
      paused: typeof game.paused === "boolean" ? game.paused : null,
      gameDateTime: typeof game.gameDateTime === "string" ? game.gameDateTime : null,
    },
    population: finite(population.current),
    treasury,
    monthlyBalance,
    financeRunwayMonths,
    // Which domains this catalogue can zone at all, read from the same snapshot
    // the candidate generator reads and by the same rule. See
    // `availableZoneDomains`.
    availableZoneDomains: availableZoneDomains(root),
    demands: {
      // The demand of the density this city actually zones, not the max over densities it may not be able to lay.
      residential: residentialZoneDemand(root),
      commercial: demandValue(demand.commercial),
      industrial: demandValue(demand.industrial),
      office: demandValue(demand.office),
    },
    laborStarvedDomains: (Array.isArray(demand.laborStarved) ? demand.laborStarved : [])
      .filter((domain): domain is LocalMayorGrowthDomain =>
        domain === "commercial" || domain === "industrial" || domain === "office"),
    utilities: { electricity, water, sewage },
    candidates: {
      zoning,
      roadExpansion,
      usefulFrontierCount: roadExpansion.length,
      currentDevelopmentCapacity: zoning.length + roadExpansion.length,
      pendingZoningCells: effectiveZoningCells,
      pendingFrontageCapacity: effectiveFrontage,
    },
    actionability: {
      status: actionabilityStatus,
      reasonCode:
        typeof declaredActionability.reasonCode === "string" ? declaredActionability.reasonCode : defaultReasonCode,
      reason:
        typeof declaredActionability.reason === "string"
          ? declaredActionability.reason
          : candidates.length > 0
            ? "validated candidate supply is available"
            : capacityStatus === "sufficient"
              ? "existing development capacity is pending digestion"
              : typeof planning.note === "string"
                ? planning.note
                : "no validated zoning or road candidate is currently available",
      refreshAttempted: declaredActionability.refreshAttempted === true,
      backoffRemaining: Math.max(0, finite(declaredActionability.backoffRemaining) ?? 0),
      capacityStatus,
    },
    issues,
    ...(serviceRecovery ? { serviceRecovery } : {}),
    ...(declaredGrowthIntent ? { growthIntent: declaredGrowthIntent } : {}),
    ...(districtTakeover ? { districtTakeover } : {}),
    developmentCapacity: capacity,
    history: normalizedHistory,
  };
}

export function compareLocalMayorWorld(previous: LocalMayorState, current: LocalMayorState) {
  if (!previous.worldFingerprint || !current.worldFingerprint) {
    return { status: "unavailable" as const, reason: "world fingerprint unavailable" };
  }
  return previous.worldFingerprint === current.worldFingerprint
    ? { status: "unchanged" as const, reason: "bounded world facts unchanged" }
    : { status: "external_world_change" as const, reason: "bounded world facts changed before execution" };
}
