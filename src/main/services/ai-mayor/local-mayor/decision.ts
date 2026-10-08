import {
  ABSORPTION_CONTROL_DEMAND_FLOOR,
  DEFAULT_MAYOR_GROWTH_MODE,
  absorptionGatesExpansion,
  growthModeDemandFloor,
  type MayorGrowthMode,
} from "../growth-mode";
import { corridorCandidateMatches, zoningCandidateMatches } from "./corridor";
import { advanceServiceRecoveryCooldown } from "./service-recovery";
import { compareLocalMayorWorld, compileLocalMayorState, uncommissionedUtilityKinds } from "./state";
import {
  LOCAL_MAYOR_MAX_ACTIONS,
  LOCAL_MAYOR_MAX_DISTRICT_BURST,
  LOCAL_MAYOR_MAX_GOALS,
  LOCAL_MAYOR_MAX_TRACE_CANDIDATES,
  type LocalDistrictLifecycle,
  type LocalMayorAction,
  type LocalMayorCandidateRef,
  type LocalMayorDecisionEpisode,
  type LocalMayorGoal,
  type LocalMayorGrowthDomain,
  type LocalMayorHistory,
  type LocalMayorOutcomeImpact,
  type LocalMayorOutcomeInput,
  type LocalMayorScoreBreakdown,
  type LocalMayorScoredAction,
  type LocalMayorState,
} from "./types";

const clamp = (value: number, min = -100, max = 100) => Math.max(min, Math.min(max, Math.round(value)));
const demand = (value: number | null) => (value === null ? 0 : clamp(value, 0, 100));
const utilityRisk = (state: LocalMayorState) => [
  state.utilities.electricity,
  state.utilities.water,
  state.utilities.sewage,
];
const hasCriticalUtility = (state: LocalMayorState) =>
  utilityRisk(state).some((utility) => utility.risk === "critical");
/** Below this runway the Brain stops spending and lets the world run; above it a shortfall only ranks low. */
const HARD_FINANCE_PAUSE_RUNWAY_MONTHS = 1.5;
const hasHealthyGrowthFinance =(state: LocalMayorState) =>
  state.financeRunwayMonths === Number.POSITIVE_INFINITY ||
  (state.financeRunwayMonths !== null && state.financeRunwayMonths >= 3);
const actionKey = (action: LocalMayorAction) =>
  action.kind === "choose_candidate"
    ? `candidate:${action.candidateId}`
    : action.kind === "recover_utility"
      ? `utility:${action.utility}:${action.issueKey}`
      : `${action.kind}:${action.reasonCode}`;
const goalUrgency = (goals: LocalMayorGoal[], kind: LocalMayorGoal["kind"], domain?: LocalMayorGrowthDomain) =>
  goals.find((goal) => goal.kind === kind && (domain === undefined || goal.domain === domain))?.urgency ?? 0;
const hasCooldown = (state: LocalMayorState, key: string) =>
  state.history.cooldowns.some((cooldown) => cooldown.key === key && cooldown.remainingObservations > 0);

const candidateImpact = (candidate: LocalMayorState["candidates"]["zoning"][number] | undefined) => {
  if (!candidate) return 0;
  if (candidate.kind === "zoning") return Math.min(30, Math.max(1, candidate.approximateCells ?? 1) / 2);
  return Math.min(30, Math.max(1, candidate.approximateNewFrontage ?? candidate.approximateLength ?? 20) / 10);
};

const maxDemandValue = (state: LocalMayorState) =>
  Math.max(
    demand(state.demands.residential),
    demand(state.demands.commercial),
    demand(state.demands.industrial),
    demand(state.demands.office),
  );

const reserveTarget = (state: LocalMayorState) =>
  Math.max(
    1,
    state.developmentCapacity.targetZoningCells ||
      (state.population !== null && state.population < 500 && maxDemandValue(state) >= 80 ? 24 : 16),
  );

/**
 * Supply this city has already paid for and has not absorbed.
 *
 * Both halves count, because both are the same thing from the city's point of
 * view: land that has not been built on yet, and buildings that have been built
 * and stand empty. Reading only the first is what lets a batch whose buildings
 * nobody moved into look identical to a batch that was absorbed.
 *
 * The vacant half is capped at one tranche's target. One unabsorbed batch is a
 * lag the city should wait out; more than a tranche's worth is a structural
 * failure, and a growth policy that keeps freezing itself over one would stop
 * the city rather than diagnose it.
 */
export const unabsorbedReserve = (state: LocalMayorState, domain: LocalMayorGrowthDomain) => {
  const capacity = state.developmentCapacity;
  const vacant = capacity.builtButVacantByType?.[domain] ?? 0;
  return (capacity.zonedUnoccupiedByType?.[domain] ?? 0) + Math.min(vacant, reserveTarget(state));
};

export function growthPressure(state: LocalMayorState, domain: LocalMayorGrowthDomain) {
  const currentDemand = demand(state.demands[domain]);
  const reserve = unabsorbedReserve(state, domain);
  const target = reserveTarget(state);
  const hasReserveSignal =
    state.developmentCapacity.targetZoningCells > 0 ||
    Object.values(state.developmentCapacity.typedReserveDeficit ?? {}).some((value) => value === true);
  const reserveDeficit =
    state.developmentCapacity.typedReserveDeficit?.[domain] === true || (hasReserveSignal && reserve < target);
  return {
    domain,
    demand: currentDemand,
    reserve,
    target,
    reserveDeficit,
    pressured: currentDemand >= 60 && reserveDeficit,
  };
}

/**
 * Whether this domain's previous tranche is still absorbing.
 *
 * Demand is an absorption signal, not a build command. A city that has already
 * zoned land nobody has built on, or that the world reports as digesting, is
 * already answering the demand it has; appending another tranche of the same
 * kind answers nothing and spends the next tranche's budget on land that will
 * stand empty.
 *
 * Missing evidence is not absorption. When the world reports no reserve facts
 * at all this is `false` and growth proceeds exactly as it did before — a
 * reader that invents a block out of a fact nobody measured stops the city.
 */
export function isAbsorbing(state: LocalMayorState, domain: LocalMayorGrowthDomain): boolean {
  const capacity = state.developmentCapacity;
  // A deficit for this domain — declared by the world or derived from the
  // domain's own reserve against its target — says the opposite: the reserve is
  // short, and another tranche is exactly what closes it. No city-level
  // digestion report outranks a fact the state model already calls a deficit.
  if (capacity.typedReserveDeficit?.[domain] === true) return false;
  return unabsorbedReserve(state, domain) >= reserveTarget(state);
}

const typedDemandReserveDomains = (state: LocalMayorState): LocalMayorGrowthDomain[] =>
  (["residential", "commercial", "industrial", "office"] as const)
    .filter((domain) => demand(state.demands[domain]) > 0 && growthPressure(state, domain).reserveDeficit)
    .sort((left, right) => demand(state.demands[right]) - demand(state.demands[left]) || left.localeCompare(right));
const typedDemandReserveDeficit = (state: LocalMayorState) => typedDemandReserveDomains(state).length > 0;

const candidateNeedsGrowth = (state: LocalMayorState, candidate: LocalMayorCandidateRef) => {
  if (candidate.kind !== "zoning") return true;
  const domain = candidate.areaType?.toLowerCase() as LocalMayorGrowthDomain | undefined;
  if (!domain) return false;
  const pressure = growthPressure(state, domain);
  if (pressure.pressured) return true;
  if (state.actionability.capacityStatus === "sufficient")
    return demand(state.demands[domain]) >= 80 && (candidate.approximateCells ?? 0) >= pressure.target;
  return demand(state.demands[domain]) >= 60 || maxDemandValue(state) >= 60;
};

const consecutiveBuildBursts = (state: LocalMayorState) => {
  let count = 0;
  for (const entry of [...state.history.recentActions].reverse()) {
    if (
      entry.kind !== "choose_candidate" ||
      (entry.outcome !== "success" && entry.reason !== "road_attempt_guard_skipped")
    )
      break;
    if (entry.outcome !== "success") continue;
    count += 1;
  }
  return count;
};

const shouldPrioritizeEarlyBuild = (state: LocalMayorState) =>
  state.population < 500 &&
  hasHealthyGrowthFinance(state) &&
  !hasCriticalUtility(state) &&
  (maxDemandValue(state) >= 60 || typedDemandReserveDeficit(state)) &&
  (state.candidates.zoning.length > 0 || state.candidates.roadExpansion.length > 0);

export function shouldHarvestZoning(state: LocalMayorState) {
  return (
    state.candidates.zoning.some((candidate) => candidateNeedsGrowth(state, candidate)) &&
    hasHealthyGrowthFinance(state) &&
    (typedDemandReserveDeficit(state) || maxDemandValue(state) >= 60) &&
    (state.developmentCapacity.availableFrontageCells > 0 ||
      state.developmentCapacity.candidateZoningCells > 0 ||
      state.developmentCapacity.pendingZoningCells > 0)
  );
}

export function localMayorGrowthDomain(state: LocalMayorState): LocalMayorGrowthDomain | undefined {
  return generateLocalMayorGoals(state).find((goal) => goal.kind === "maintain_development_reserve")?.domain;
}

export function localMayorActionabilityKey(state: LocalMayorState) {
  return [
    Math.floor(maxDemandValue(state) / 25),
    state.actionability.capacityStatus,
    state.developmentCapacity.zonedUnoccupiedByType?.residential ?? 0,
    state.developmentCapacity.zonedUnoccupiedByType?.commercial ?? 0,
    state.developmentCapacity.zonedUnoccupiedByType?.industrial ?? 0,
    state.developmentCapacity.zonedUnoccupiedByType?.office ?? 0,
    Math.min(4, Math.floor(state.candidates.pendingZoningCells / 16)),
    Math.min(4, Math.floor(state.candidates.pendingFrontageCapacity / 80)),
    state.utilities.electricity.risk,
    state.utilities.water.risk,
    state.utilities.sewage.risk,
  ].join("|");
}

export function shouldRefreshLocalMayorSupply(state: LocalMayorState, lastRefreshKey: string | null) {
  if (state.status !== "available" || state.actionability.status === "unavailable") return false;
  if (state.candidates.zoning.length > 0 || state.candidates.roadExpansion.length > 0) return false;
  if (state.developmentCapacity.developmentDigesting) return false;
  const typedDeficit = typedDemandReserveDeficit(state);
  if (maxDemandValue(state) < 50 && !typedDeficit) return false;
  if (state.actionability.capacityStatus === "sufficient" && !typedDeficit) return false;
  if (state.actionability.status === "blocked" && state.actionability.refreshAttempted) return false;
  return localMayorActionabilityKey(state) !== lastRefreshKey;
}

export function shouldEnsureGrowthOpportunity(state: LocalMayorState) {
  return (
    state.status === "available" &&
    state.candidates.zoning.length === 0 &&
    state.candidates.roadExpansion.length === 0 &&
    (state.developmentCapacity.reserveDeficit || typedDemandReserveDeficit(state)) &&
    state.developmentCapacity.frontierAnchorCount > 0 &&
    !hasCriticalUtility(state) &&
    hasHealthyGrowthFinance(state)
  );
}

/**
 * Whether the world has shown the city anywhere it could still build.
 *
 * This is the fact that decides whether "let the city run" is the right answer
 * or an excuse. A city with validated road or zoning candidates, free frontage,
 * a usable frontier anchor or undeveloped owned land has somewhere to go, and a
 * Mayor that answers "wait" while this is true is idling on buildable ground.
 *
 * Missing evidence is read as "no room", which is the opposite of the rule
 * `isAbsorbing` uses, and deliberately so: this predicate only ever *withholds*
 * the wait, so reading an unmeasured world as "room exists" would suppress the
 * observation the city genuinely needs to learn where its room is.
 */
export function hasExpansionRoom(state: LocalMayorState): boolean {
  const capacity = state.developmentCapacity;
  return (
    state.candidates.zoning.length > 0 ||
    state.candidates.roadExpansion.length > 0 ||
    state.candidates.usefulFrontierCount > 0 ||
    capacity.frontierAnchorCount > 0 ||
    capacity.availableFrontageCells > 0 ||
    capacity.candidateFrontageCapacity > 0 ||
    (capacity.availableDevelopmentCells ?? 0) > 0
  );
}

/**
 * How urgently a domain's next package is wanted.
 *
 * Demand orders the domains against each other; it no longer decides whether any
 * of them is built. Absorption subtracts, it does not exclude: a domain whose
 * last tranche has not been absorbed is a worse next package than one whose has,
 * and a better one than doing nothing at all.
 *
 * The base sits above every non-growth goal so that under full-speed expansion a
 * domain with buildable room and a funded action is always a real answer to
 * "what next". `expand_frontier` is the one deliberate exception and is placed
 * between the two: it outranks an absorbing domain — building the next area's
 * road while this one fills in is the whole point of a rolling pipeline — and
 * loses to a domain that is still hot.
 */
export const GROWTH_GOAL_BASE_URGENCY = 62;
export const ABSORPTION_URGENCY_PENALTY = 14;
/**
 * A job domain whose demand the game says is held down by a missing workforce adds jobs nobody can take.
 * Measured live (2026-10-03): 808 jobs, 812 of them free, 23 employed, industrial `UneducatedWorkforce -180` —
 * while the policy admitted industry 57 times against housing's 11. Such a domain yields to housing.
 */
export const LABOR_STARVED_URGENCY_PENALTY = 24;
const laborStarved = (state: LocalMayorState, domain: LocalMayorGrowthDomain) =>
  (state.laborStarvedDomains ?? []).includes(domain);
export const growthGoalUrgency = (state: LocalMayorState, domain: LocalMayorGrowthDomain, absorbing: boolean) =>
  clamp(GROWTH_GOAL_BASE_URGENCY + Math.round(demand(state.demands[domain]) * 0.2) -
    (absorbing ? ABSORPTION_URGENCY_PENALTY : 0) - (laborStarved(state, domain) ? LABOR_STARVED_URGENCY_PENALTY : 0));

/** One expansion domain's growth goal, in the order the policy wants them built. */
const EXPANSION_DOMAINS = ["residential", "commercial", "industrial", "office"] as const;

export function classifyLocalDistrictLifecycle(state: LocalMayorState): LocalDistrictLifecycle {
  if (hasCriticalUtility(state) || (state.financeRunwayMonths !== null && state.financeRunwayMonths < 3))
    return "blocked";
  if (state.candidates.zoning.length > 0 || state.candidates.roadExpansion.length > 0) return "building_district";
  if (state.developmentCapacity.developmentDigesting || state.developmentCapacity.reserveStatus === "digesting")
    return "fast_absorb";
  const hasPressure = typedDemandReserveDeficit(state) || maxDemandValue(state) >= 60;
  const hasGlobalOpportunity =
    state.developmentCapacity.frontierAnchorCount > 0 ||
    state.developmentCapacity.availableFrontageCells > 0 ||
    state.developmentCapacity.candidateFrontageCapacity > 0;
  if (hasPressure && hasGlobalOpportunity) return "selecting_next_district";
  return hasPressure ? "blocked" : "fast_absorb";
}

export function classifyLocalMayorOutcomeImpact(
  action: LocalMayorAction,
  before: LocalMayorState,
  after: LocalMayorState | null,
): LocalMayorOutcomeImpact {
  if (!after)
    return {
      kind: "unavailable",
      worldChanged: false,
      capacityAdded: false,
      roadAdded: false,
      zoningAdded: false,
      summary: "post-action readback unavailable",
    };
  const changed = before.worldFingerprint !== after.worldFingerprint;
  const roadAdded = changed && action.kind === "choose_candidate" && action.candidateKind === "road_expansion";
  const zoningAdded = changed && action.kind === "choose_candidate" && action.candidateKind === "zoning";
  return {
    kind: !changed ? "no_material_change" : roadAdded ? "road_added" : zoningAdded ? "zoning_added" : "world_changed",
    worldChanged: changed,
    capacityAdded: roadAdded || zoningAdded,
    roadAdded,
    zoningAdded,
    summary: changed ? "bounded post-action readback changed" : "bounded post-action readback was unchanged",
  };
}

/**
 * Utilities the city has not commissioned yet, in bootstrap order.
 *
 * This is a PREPARATION requirement: the utility carries no load, so nothing is
 * being starved and it is not an emergency — but the first committed
 * development cannot operate without it. It is raised only once there is
 * committed development for it to serve, because commissioning a network for a
 * city that has not decided where anything goes is spending, not preparation.
 *
 * One requirement covers every uncommissioned utility rather than one red light
 * per capacity reading, and it disappears the moment the utility is
 * commissioned, so preparation cannot hold the city at emergency priority.
 */
const utilityBootstrapRequirement = (state: LocalMayorState): Array<"electricity" | "water" | "sewage"> => {
  const kinds = uncommissionedUtilityKinds(state.utilities);
  if (kinds.length === 0) return [];
  const committedDevelopment =
    (state.population ?? 0) > 0 ||
    state.developmentCapacity.existingZonedCells > 0 ||
    state.developmentCapacity.existingZonedUnoccupiedCells > 0 ||
    state.candidates.currentDevelopmentCapacity > 0;
  return committedDevelopment ? kinds : [];
};

export function generateLocalMayorGoals(
  state: LocalMayorState,
  mode: MayorGrowthMode = DEFAULT_MAYOR_GROWTH_MODE,
): LocalMayorGoal[] {
  const demandFloor = growthModeDemandFloor(mode);
  const absorbingGates = absorptionGatesExpansion(mode);
  const goals: LocalMayorGoal[] = [];
  const add = (kind: LocalMayorGoal["kind"], urgency: number, evidence: string[], domain?: LocalMayorGrowthDomain) =>
    goals.push({ kind, urgency: clamp(urgency, 0, 100), evidence, ...(domain ? { domain } : {}) });
  if (hasCriticalUtility(state))
    add("stabilize_utilities", 100, ["one or more utility headrooms are critical or unavailable"]);
  const bootstrapKinds = utilityBootstrapRequirement(state);
  if (bootstrapKinds.length > 0) {
    // Above ordinary growth and reserve, below a real shortage and a finance
    // runway: preparation is a prerequisite for the committed development, not
    // a crisis, and it must not be outranked by the next speculative tranche.
    add("prepare_utility_bootstrap", 86, [
      `${bootstrapKinds.join(", ")} has no supply and carries no load; the first committed development needs it`,
    ]);
  }
  const highestIssue = state.issues.highest;
  if (
    highestIssue?.actionable &&
    highestIssue.kind !== "electricity_shortage" &&
    highestIssue.kind !== "water_shortage" &&
    highestIssue.kind !== "sewage_shortage"
  )
    add("address_city_issue", highestIssue.urgency, [highestIssue.message]);
  // Only a runway that is about to run out freezes the Brain. Measured live (2026-10-03, run-v3): runway 2.7 months with
  // every budget lever already pulled answered PAUSE_FOR_ISSUE on 31 of 39 policy asks — nothing was built, the deficit
  // was never fixed, and the freeze itself is what made the run stall. Between the two thresholds the shortfall is
  // still named, but below every growth goal, so revenue-producing growth keeps going while the treasury can carry it.
  if (state.financeRunwayMonths !== null && state.financeRunwayMonths < HARD_FINANCE_PAUSE_RUNWAY_MONTHS)
    add("protect_finances", 90, ["treasury runway is nearly exhausted"]);
  else if (state.financeRunwayMonths !== null && state.financeRunwayMonths < 3)
    add("protect_finances", 45, ["treasury runway is below three deficit observations; growth continues while the treasury can carry it"]);
  else if (state.monthlyBalance !== null && state.monthlyBalance < 0)
    add("protect_finances", 45, ["monthly balance is negative but runway remains available"]);
  // A quiet city may prepare one next GRID area before demand spikes. Reuse
  // the reserve Gap, and only when the current facts show room to grow.
  const proactiveReserve = state.developmentCapacity.reserveStatus === "empty" &&
    state.developmentCapacity.frontierAnchorCount > 0 &&
    state.candidates.usefulFrontierCount > 0 &&
    !highestIssue?.actionable &&
    !hasCriticalUtility(state) &&
    hasHealthyGrowthFinance(state);
  if (
    (state.developmentCapacity.reserveDeficit || typedDemandReserveDeficit(state) || proactiveReserve) &&
    state.developmentCapacity.frontierAnchorCount > 0 &&
    !hasCriticalUtility(state) &&
    hasHealthyGrowthFinance(state)
  ) {
    const reserveDomains = typedDemandReserveDomains(state);
    if (reserveDomains.length > 0) {
      for (const domain of reserveDomains) {
        add(
          "maintain_development_reserve",
          state.developmentCapacity.reserveStatus === "empty" ? (proactiveReserve ? 62 : 82) : 68,
          [`${domain} development reserve is insufficient; bounded frontier capacity is available`],
          domain,
        );
      }
    } else {
      add("maintain_development_reserve", state.developmentCapacity.reserveStatus === "empty" ? (proactiveReserve ? 62 : 82) : 68, [
        proactiveReserve
          ? "one bounded next expansion area is available"
          : `development reserve is ${state.developmentCapacity.reserveStatus}; bounded frontier capacity is available`,
      ]);
    }
  }
  const failedRoad = state.history.recentActions.some(
    (entry) => entry.kind === "choose_candidate" && entry.outcome !== "success" && entry.reason.includes("road"),
  );
  if (failedRoad) add("recover_from_failed_expansion", 78, ["a recent road expansion failed or became stale"]);
  // Which domains the city should build next.
  //
  // Under full-speed expansion a domain is a candidate whenever the world still
  // shows somewhere to build and the action is funded: demand orders the
  // domains, and absorption demotes one of them, but neither decides whether the
  // city builds at all. The absorption-controlled policy keeps its old rule in
  // full — elevated demand AND not currently absorbing — because that policy is
  // the one that deliberately waits for the previous tranche.
  //
  // Missing evidence is not a block: an unread demand reads as zero and, under
  // full-speed expansion, still clears the zero floor, so a city whose census
  // did not resolve is built rather than frozen.
  const financeAllowsGrowth = hasHealthyGrowthFinance(state) && !hasCriticalUtility(state);
  for (const domain of EXPANSION_DOMAINS) {
    // While jobs stand empty for want of workers, housing is the binding constraint, and unbuilt residential
    // land is not evidence that homes are not wanted (on the live map it was low-density land the game had zero
    // demand for). The absorption demotion is not applied to housing then.
    const housingBinds = domain === "residential" && (state.laborStarvedDomains ?? []).length > 0;
    const absorbing = isAbsorbing(state, domain) && !housingBinds;
    if (absorbingGates && absorbing) continue;
    // "Elevated demand" is a real signal in either policy and keeps its own
    // threshold, so this is the one clause the two modes share.
    const elevatedDemand = demand(state.demands[domain]) >= ABSORPTION_CONTROL_DEMAND_FLOOR;
    const warranted = demandFloor === 0
      // Full-speed expansion: a domain is a candidate when the city wants it
      // (demand or a declared reserve deficit) or when the world has shown
      // buildable room and the action is funded. Buildable room is the warrant;
      // demand only decides how badly it is wanted.
      ? elevatedDemand || growthPressure(state, domain).reserveDeficit || (financeAllowsGrowth && hasExpansionRoom(state))
      // The superseded policy's own rule, byte for byte: elevated demand only.
      : elevatedDemand;
    if (!warranted) continue;
    add(`grow_${domain}` as LocalMayorGoal["kind"], growthGoalUrgency(state, domain, absorbing),
      [absorbing
        ? `${domain} demand is present and the previous tranche is still absorbing; build elsewhere or ahead`
        : elevatedDemand
          ? `${domain} demand is elevated`
          : `${domain} has buildable room and a funded growth action`], domain);
  }
  if (state.candidates.zoning.length > 0)
    add("use_existing_frontage", 58, ["validated zoning candidates are available"]);
  // The next frontier's Road, built while the current district is still filling
  // in. Deliberately placed between an absorbing domain and a hot one: when
  // nothing is absorbing the hot domain is the better next package, and when
  // something is, opening the next area is what keeps the pipeline moving
  // instead of waiting for it to fill.
  if (state.candidates.usefulFrontierCount > 0 && !hasCooldown(state, "action:road_expansion"))
    add("expand_frontier", absorbingGates ? 56 : 64, ["validated bounded road candidates are available"]);
  // Letting the city run is the right answer only when there is nothing to want
  // AND nowhere to put it. Both halves matter: a low demand reading over
  // validated frontage is not a reason to wait, and neither is a high demand
  // reading over a census the planner simply did not populate — the growable
  // path censuses for itself, so an empty candidate list is not evidence that
  // the land is gone.
  if (!hasCriticalUtility(state) && maxDemandValue(state) < 45 && !hasExpansionRoom(state)) {
    add("wait_for_growth", 55, [
      "demand is below the local growth threshold, the world shows no buildable room, and utilities are not critical",
    ]);
  }
  return goals
    .sort((a, b) => {
      if (a.urgency !== b.urgency) return b.urgency - a.urgency;
      // Two expansion domains at the same urgency are decided by
      // {@link EXPANSION_DOMAINS}' order — the order this function's own comment
      // and that constant both call the order the policy wants them built in.
      // They used to be decided by `localeCompare`, which put `grow_commercial`
      // ahead of `grow_residential`, and on a city whose four demands all read
      // 100 that alphabetical order WAS the entire ranking: measured live
      // (2026-10-01, fresh city) eight consecutive `EXPAND_COMMERCIAL` Goals,
      // zero residential, population 0 — and because the demand that would break
      // the tie is produced by the housing the ranking never picks, the city
      // could not leave it. Only two domain goals are reordered; every other
      // comparison is the one that was there before.
      const left = expansionDomainRank(a.kind);
      const right = expansionDomainRank(b.kind);
      if (left !== null && right !== null && left !== right) return left - right;
      return a.kind.localeCompare(b.kind) || (a.domain ?? "").localeCompare(b.domain ?? "");
    })
    .slice(0, LOCAL_MAYOR_MAX_GOALS);
}

/** Where a `grow_<domain>` kind sits in {@link EXPANSION_DOMAINS}, or null for any other goal. */
function expansionDomainRank(kind: string): number | null {
  const match = /^grow_([a-z]+)$/.exec(kind);
  const index = match ? EXPANSION_DOMAINS.indexOf(match[1] as (typeof EXPANSION_DOMAINS)[number]) : -1;
  return index < 0 ? null : index;
}

export function buildLocalMayorActions(state: LocalMayorState, goals: LocalMayorGoal[]): LocalMayorAction[] {
  const actions: LocalMayorAction[] = [];
  if (
    state.serviceRecovery?.status === "actionable" &&
    state.serviceRecovery.chosenActionKind === "stabilize_utilities" &&
    state.serviceRecovery.attempts < 3
  ) {
    actions.push({
      kind: "recover_utility",
      utility: state.serviceRecovery.targetDomain as "electricity" | "water" | "sewage",
      issueKey: state.serviceRecovery.issueKey,
      reasonCode: `recover_${state.serviceRecovery.targetDomain}`,
    });
    actions.push({ kind: "wait", observeAfterTicks: 1, reasonCode: "utility_recovery_fallback" });
    return actions;
  }
  const preferredDomain = goals.find((goal) => goal.kind === "maintain_development_reserve")?.domain;
  const addBurst = (candidates: LocalMayorState["candidates"]["zoning"], reasonCode?: string) => {
    const selected = candidates
      .filter((candidate) => !hasCooldown(state, `candidate:${candidate.id}`))
      .slice(0, LOCAL_MAYOR_MAX_DISTRICT_BURST);
    if (selected.length === 0) return;
    const first = selected[0];
    actions.push({
      kind: "choose_candidate",
      candidateId: first.id,
      candidateKind: first.kind,
      candidateIds: selected.map((candidate) => candidate.id),
      reasonCode: reasonCode ?? (first.kind === "road_expansion" ? "build_starter_district" : "zone_starter_district"),
    });
  };
  const intent = state.growthIntent;
  const zoning = [...state.candidates.zoning]
    .filter((candidate) => candidateNeedsGrowth(state, candidate))
    .sort(
      (left, right) =>
        Number(right.areaType?.toLowerCase() === preferredDomain) -
          Number(left.areaType?.toLowerCase() === preferredDomain) || left.id.localeCompare(right.id),
    )
    .slice(0, LOCAL_MAYOR_MAX_DISTRICT_BURST);
  const harvestableZoning =
    intent?.phase === "zoning" ? zoning.filter((candidate) => zoningCandidateMatches(intent, candidate)) : zoning;
  if (shouldHarvestZoning({ ...state, candidates: { ...state.candidates, zoning: harvestableZoning } })) {
    addBurst(harvestableZoning, "harvest_existing_frontage");
    if (consecutiveBuildBursts(state) >= 2)
      return actions.filter((action) => action.kind !== "choose_candidate").slice(0, LOCAL_MAYOR_MAX_ACTIONS);
    if (actions.length > 0) return actions.slice(0, LOCAL_MAYOR_MAX_ACTIONS);
  }
  if (intent?.status === "active" && intent.phase === "digest") {
    if (consecutiveBuildBursts(state) < 2 && shouldPrioritizeEarlyBuild(state)) {
      addBurst([...state.candidates.roadExpansion, ...state.candidates.zoning], "build_starter_district");
      if (actions.length > 0) return actions.slice(0, LOCAL_MAYOR_MAX_ACTIONS);
    }
    actions.push({ kind: "wait", observeAfterTicks: 2, reasonCode: "digest_growth_corridor" });
    if (state.game.paused)
      actions.push({ kind: "simulate", hours: 0.25, speed: 4, reasonCode: "digest_growth_corridor" });
    return actions;
  }
  if (intent?.status === "active" && intent.phase === "corridor") {
    const continuation = state.candidates.roadExpansion
      .filter((candidate) => corridorCandidateMatches(intent, candidate))
      .sort((left, right) => left.id.localeCompare(right.id));
    addBurst(continuation);
    if (actions.length > 0) return actions.slice(0, LOCAL_MAYOR_MAX_ACTIONS);
    const frontage = state.candidates.zoning
      .filter((candidate) => candidate.areaType?.toLowerCase() === intent.domain)
      .slice(0, LOCAL_MAYOR_MAX_DISTRICT_BURST);
    addBurst(frontage, "corridor_safe_truncated");
    if (actions.length > 0) {
      return actions.slice(0, LOCAL_MAYOR_MAX_ACTIONS);
    }
    if (
      classifyLocalDistrictLifecycle(state) === "selecting_next_district" ||
      (state.districtTakeover && state.districtTakeover.outcome !== "search_exhausted")
    ) {
      actions.push({ kind: "wait", observeAfterTicks: 1, reasonCode: "select_next_district" });
      return actions;
    }
    actions.push({ kind: "wait", observeAfterTicks: 1, reasonCode: "corridor_no_continuation_candidate" });
    return actions;
  }
  if (intent?.status === "active" && intent.phase === "zoning") {
    const batch = state.candidates.zoning
      .filter((candidate) => zoningCandidateMatches(intent, candidate))
      .sort((left, right) => left.id.localeCompare(right.id));
    addBurst(batch, "zone_starter_district");
    if (actions.length > 0) return actions.slice(0, LOCAL_MAYOR_MAX_ACTIONS);
    actions.push({ kind: "wait", observeAfterTicks: 1, reasonCode: "zoning_batch_candidate_unavailable" });
    return actions;
  }
  const roads = state.candidates.roadExpansion.slice(0, LOCAL_MAYOR_MAX_DISTRICT_BURST);
  addBurst(roads, "build_starter_district");
  if (consecutiveBuildBursts(state) >= 2)
    return actions.filter((action) => action.kind !== "choose_candidate").slice(0, LOCAL_MAYOR_MAX_ACTIONS);
  if (shouldPrioritizeEarlyBuild(state))
    return actions.filter((action) => action.kind === "choose_candidate").slice(0, LOCAL_MAYOR_MAX_ACTIONS);
  if (
    classifyLocalDistrictLifecycle(state) === "selecting_next_district" ||
    (state.districtTakeover && state.districtTakeover.outcome !== "search_exhausted")
  ) {
    actions.push({ kind: "wait", observeAfterTicks: 1, reasonCode: "select_next_district" });
    return actions;
  }
  const lifecycle = classifyLocalDistrictLifecycle(state);
  if (state.history.consecutiveWaits < 3)
    actions.push({
      kind: "wait",
      observeAfterTicks: hasCriticalUtility(state) ? 1 : 2,
      reasonCode:
        lifecycle === "selecting_next_district"
          ? "select_next_district"
          : state.actionability.status === "blocked"
            ? "no_safe_actionability"
          : state.actionability.capacityStatus === "sufficient"
            ? "digest_existing_capacity"
            : typedDemandReserveDeficit(state)
              ? "waiting_for_absorption"
              : maxDemandValue(state) < 50
                ? "observe_low_demand"
                : "bounded_reobserve",
    });
  if (state.actionability.status !== "blocked")
    actions.push({
      kind: "replan",
      quietObservations: 1,
      reasonCode: goals.some((goal) => goal.kind === "recover_from_failed_expansion")
        ? "recover_with_fresh_snapshot"
        : "fresh_snapshot",
    });
  if (
    state.game.paused &&
    !hasCriticalUtility(state) &&
    !goals.some((goal) => goal.kind === "recover_from_failed_expansion") &&
    (state.candidates.zoning.length > 0 ||
      state.candidates.roadExpansion.length > 0 ||
      state.history.consecutiveWaits >= 2)
  ) {
    actions.push({ kind: "simulate", hours: 0.5, speed: 4, reasonCode: "observe_bounded_growth" });
  }
  return actions.slice(0, LOCAL_MAYOR_MAX_ACTIONS);
}

function scoreAction(
  state: LocalMayorState,
  goals: LocalMayorGoal[],
  action: LocalMayorAction,
): LocalMayorScoreBreakdown {
  const candidate =
    action.kind === "choose_candidate"
      ? [...state.candidates.zoning, ...state.candidates.roadExpansion].find((item) => item.id === action.candidateId)
      : undefined;
  const maxDemand = maxDemandValue(state);
  const urgency =
    action.kind === "recover_utility"
      ? goalUrgency(goals, "stabilize_utilities")
      : action.kind === "wait" || action.kind === "replan"
        ? Math.max(
            goalUrgency(goals, "wait_for_growth"),
            goalUrgency(goals, "protect_finances"),
            goalUrgency(goals, "stabilize_utilities"),
          )
        : candidate?.kind === "zoning"
          ? Math.max(
              goalUrgency(goals, "use_existing_frontage"),
              goalUrgency(
                goals,
                `grow_${(candidate.areaType ?? "residential").toLowerCase()}` as LocalMayorGoal["kind"],
                candidate.areaType?.toLowerCase() as LocalMayorGrowthDomain | undefined,
              ),
              goalUrgency(
                goals,
                "maintain_development_reserve",
                candidate.areaType?.toLowerCase() as LocalMayorGrowthDomain | undefined,
              ),
            )
          : Math.max(
              goalUrgency(goals, "expand_frontier"),
              goalUrgency(goals, "maintain_development_reserve", candidate?.growthDomain),
            );
  const critical = hasCriticalUtility(state);
  const runway = state.financeRunwayMonths;
  const financeSafety =
    action.kind === "recover_utility"
      ? runway !== null && runway < 1
        ? -30
        : 20
      : action.kind === "choose_candidate"
        ? runway === null
          ? -12
          : runway < 3
            ? -45
            : runway < 8
              ? -15
              : 15
        : runway !== null && runway < 3
          ? 30
          : 5;
  const cost = candidate?.estimatedCost ?? 0;
  const expectedCost = action.kind === "choose_candidate" ? -clamp(cost / 1000, 0, 35) : 0;
  const utility = critical
    ? action.kind === "recover_utility"
      ? 80
      : action.kind === "choose_candidate"
        ? -60
        : 35
    : 5;
  const useful =
    action.kind === "choose_candidate"
      ? candidate?.kind === "zoning"
        ? 26 + maxDemand / 8
        : 20 + state.candidates.usefulFrontierCount * 2
      : action.kind === "wait"
        ? 8
        : action.kind === "simulate"
          ? 5
          : 0;
  const impact = action.kind === "choose_candidate" ? candidateImpact(candidate) : 0;
  const capacity =
    action.kind === "choose_candidate"
      ? candidate?.kind === "zoning"
        ? Math.min(20, state.candidates.pendingZoningCells / 4)
        : Math.min(20, state.candidates.pendingFrontageCapacity / 20)
      : 0;
  const recent = state.history.recentActions.filter((entry) => entry.key === actionKey(action));
  const repeated = -Math.min(25, recent.length * 10);
  const failure = -Math.min(40, recent.filter((entry) => entry.outcome !== "success").length * 18);
  const noImpact = -Math.min(
    24,
    state.history.recentActions.filter(
      (entry) => entry.kind === action.kind && entry.outcome === "success" && entry.impact === "no_material_change",
    ).length * 8,
  );
  const cooldown = hasCooldown(state, actionKey(action)) ? -100 : 0;
  const waitValue =
    action.kind === "wait"
      ? (state.actionability.status === "blocked"
          ? 18
          : maxDemand < 45
            ? 30
            : state.developmentCapacity.developmentDigesting
              ? 28
              : typedDemandReserveDeficit(state)
                ? -8
                : state.candidates.pendingZoningCells > 0
                  ? 12
                  : 2) + (state.history.consecutiveWaits > 0 ? -state.history.consecutiveWaits * 8 : 0)
      : action.kind === "replan"
        ? 8
        : 0;
  const breakdown = {
    goalUrgency: clamp(urgency * 0.35),
    demandPressure: action.kind === "choose_candidate" ? clamp(maxDemand * 0.35) : clamp((45 - maxDemand) * 0.25),
    utilityRisk: utility,
    treasurySafety: financeSafety,
    expectedCost,
    usefulness: useful,
    actionImpact: impact,
    developmentCapacity: capacity,
    repeatedActionPenalty: repeated,
    recentFailurePenalty: failure,
    cooldownPenalty: cooldown,
    waitValue: waitValue + noImpact,
    total: 0,
  };
  breakdown.total = Object.entries(breakdown)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  return breakdown;
}

export function scoreLocalMayorAction(
  state: LocalMayorState,
  goals: LocalMayorGoal[],
  action: LocalMayorAction,
): LocalMayorScoredAction {
  return { action, score: scoreAction(state, goals, action) };
}

export function decideLocalMayorEpisode(
  snapshot: unknown,
  history?: Partial<LocalMayorHistory>,
  seed = "local-mayor-v0",
): LocalMayorDecisionEpisode {
  const state = compileLocalMayorState(snapshot, history);
  const goals = generateLocalMayorGoals(state);
  const actions =
    state.status === "available"
      ? buildLocalMayorActions(state, goals)
      : [{ kind: "wait", observeAfterTicks: 1, reasonCode: "world_unavailable" } satisfies LocalMayorAction];
  const scored = actions
    .map((action) => scoreLocalMayorAction(state, goals, action))
    .sort((a, b) => b.score.total - a.score.total || actionKey(a.action).localeCompare(actionKey(b.action)));
  const chosen =
    scored[0] ??
    scoreLocalMayorAction(state, goals, { kind: "wait", observeAfterTicks: 1, reasonCode: "bounded_fallback" });
  const margin = chosen.score.total - (scored[1]?.score.total ?? 0);
  const status =
    chosen.action.kind === "recover_utility"
      ? "recovering"
      : chosen.action.kind === "wait"
        ? "waiting"
        : goals.some((goal) => goal.kind === "recover_from_failed_expansion")
          ? "recovering"
          : "acting";
  const trace = {
    version: state.version,
    stateSummary: {
      snapshotRevision: state.snapshotRevision,
      worldFingerprint: state.worldFingerprint,
      population: state.population,
      treasury: state.treasury,
      monthlyBalance: state.monthlyBalance,
    },
    goals,
    candidates: scored.slice(0, LOCAL_MAYOR_MAX_TRACE_CANDIDATES),
    chosen,
    rejectedAlternatives: scored.slice(1, LOCAL_MAYOR_MAX_TRACE_CANDIDATES).map((item) => ({
      kind: item.action.kind,
      key: actionKey(item.action),
      reason: `score ${item.score.total} below chosen ${chosen.score.total}`,
    })),
    confidence: clamp(50 + margin, 0, 100) / 100,
    margin,
    reasonCode: `${seed}:${chosen.action.reasonCode}`,
  };
  return { status, state, goals, actions, chosen, trace };
}

export function recordLocalMayorOutcome(
  history: LocalMayorHistory,
  outcome: LocalMayorOutcomeInput,
): LocalMayorHistory {
  const key = actionKey(outcome.action);
  const recentActions = [
    ...history.recentActions,
    {
      key,
      kind: outcome.action.kind,
      outcome: outcome.outcome,
      reason: outcome.reason,
      impact: outcome.impact?.kind,
    },
  ].slice(-8);
  const shouldCooldown = outcome.outcome !== "success" && outcome.action.kind === "choose_candidate";
  const cooldowns = history.cooldowns.filter((cooldown) => cooldown.key !== key);
  if (shouldCooldown) cooldowns.push({ key, remainingObservations: 2, reason: outcome.reason });
  if (outcome.outcome === "success" && outcome.action.kind === "choose_candidate")
    cooldowns.push({ key, remainingObservations: 2, reason: "bounded recent success anti-spam" });
  return {
    recentActions,
    cooldowns: cooldowns.slice(-12),
    consecutiveWaits: outcome.action.kind === "wait" ? Math.min(3, history.consecutiveWaits + 1) : 0,
    issueMemory: history.issueMemory,
    serviceRecovery: history.serviceRecovery,
  };
}

export function compareMayorWorldForEpisode(previous: LocalMayorState, current: LocalMayorState) {
  return compareLocalMayorWorld(previous, current);
}

export function invalidateLocalMayorEpisode(previous: LocalMayorState, current: LocalMayorState) {
  const comparison = compareLocalMayorWorld(previous, current);
  return comparison.status === "unchanged"
    ? { status: "acting" as const, reason: "bounded world facts unchanged" }
    : { status: "yielding" as const, reason: comparison.reason };
}

export function advanceLocalMayorObservation(history: LocalMayorHistory): LocalMayorHistory {
  return {
    ...history,
    cooldowns: history.cooldowns
      .map((cooldown) => ({ ...cooldown, remainingObservations: cooldown.remainingObservations - 1 }))
      .filter((cooldown) => cooldown.remainingObservations > 0),
    ...(history.serviceRecovery ? { serviceRecovery: advanceServiceRecoveryCooldown(history.serviceRecovery) } : {}),
  };
}
