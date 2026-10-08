import type { GreenfieldUtilityKind, GreenfieldUtilityServiceEvidence } from "./greenfield-utility-bootstrap";
import type { Gate1Stage, Gate1Task, Gate1TaskKind } from "./gate1";
import { DEFAULT_MAYOR_PLANNING_POLICY, rankRoadPlanningCandidates, type MayorPlanningPolicy, type RoadPlanningCandidate } from "./road-planning-policy";
import { DEFAULT_MAYOR_GROWTH_MODE, type GrowableLandUse, type GrowableZoneCategory, type MayorGrowthMode } from "../growth-mode";
import { generateLocalMayorGoals } from "../local-mayor/decision";
import { uncommissionedUtilityKinds } from "../local-mayor/state";
import type { LocalMayorGoal, LocalMayorGrowthDomain, LocalMayorState } from "../local-mayor/types";
import type { MayorStructuredGoalIntent } from "../types";
import { isStructuredIntentInVocabulary, planStructuredIntent } from "./intent-primitive-map";

export type MayorGap =
  | "FACILITY_AVAILABLE"
  | "FACILITY_ACCESSIBLE"
  | "PHYSICAL_CONNECTION"
  | "NETWORK_REACHABLE"
  | "CAPACITY_SUFFICIENT"
  | "SERVICE_DELIVERED"
  | "ROAD_ACCESS"
  | "RESIDENTIAL_ZONING"
  | "COMMERCIAL_ZONING"
  | "INDUSTRIAL_ZONING"
  | "POPULATION_GROWTH";

export type MayorCapabilityId =
  | "PLACE_FACILITY"
  | "BUILD_ROAD"
  | "BUILD_SERVICE_ROAD"
  | "CONNECT_UTILITY"
  | "REPAIR_UTILITY_NETWORK"
  | "EXTEND_UTILITY_NETWORK"
  | "ZONE_RESIDENTIAL"
  | "ZONE_COMMERCIAL"
  | "ZONE_INDUSTRIAL"
  | "ADVANCE_SIMULATION";

export interface CapabilityDescriptor {
  capabilityId: MayorCapabilityId;
  solves: readonly MayorGap[];
  requires: readonly string[];
  effect: string;
  effectPredicate: string;
  owningSkill: "UTILITY_PLANNING_SKILL" | "ROAD_NETWORK_PLANNING_SKILL" | "ZONING_LAYOUT_SKILL" | "CITY_GROWTH_STRATEGY_SKILL";
  mutates: boolean;
  needsNativeValidation: boolean;
  failureMeaning: string;
}

export const MAYOR_CAPABILITIES: readonly CapabilityDescriptor[] = [
  { capabilityId: "PLACE_FACILITY", solves: ["FACILITY_AVAILABLE"], requires: ["siteCandidate"], effect: "facility exists", effectPredicate: "facilityAvailable", owningSkill: "UTILITY_PLANNING_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "facility site candidate rejected or exhausted" },
  { capabilityId: "BUILD_ROAD", solves: ["ROAD_ACCESS"], requires: ["roadCandidate"], effect: "road effect observed", effectPredicate: "roadAccess", owningSkill: "ROAD_NETWORK_PLANNING_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "road candidate rejected; escalate road strategy" },
  { capabilityId: "BUILD_SERVICE_ROAD", solves: ["FACILITY_ACCESSIBLE"], requires: ["facilityAvailable", "roadCandidate"], effect: "facility has authoritative road access", effectPredicate: "facilityAccessible", owningSkill: "ROAD_NETWORK_PLANNING_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "service road candidate rejected; escalate road strategy" },
  { capabilityId: "CONNECT_UTILITY", solves: ["PHYSICAL_CONNECTION"], requires: ["facilityAccessible", "networkTarget"], effect: "physical utility link exists", effectPredicate: "physicalConnection", owningSkill: "UTILITY_PLANNING_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "connection candidate rejected; try next utility strategy" },
  { capabilityId: "REPAIR_UTILITY_NETWORK", solves: ["NETWORK_REACHABLE"], requires: ["facilityAvailable", "physicalConnection"], effect: "target joins source network", effectPredicate: "networkReachable", owningSkill: "UTILITY_PLANNING_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "repair course rejected; escalate utility strategy" },
  { capabilityId: "EXTEND_UTILITY_NETWORK", solves: ["NETWORK_REACHABLE", "CAPACITY_SUFFICIENT"], requires: ["facilityAvailable", "sourceNetwork"], effect: "source network reaches target or capacity increases", effectPredicate: "networkReachableOrCapacity", owningSkill: "UTILITY_PLANNING_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "extension course rejected; escalate utility strategy" },
  { capabilityId: "ZONE_RESIDENTIAL", solves: ["RESIDENTIAL_ZONING"], requires: ["roadAccess", "servicesReady", "zoningCells"], effect: "residential zoning observed", effectPredicate: "residentialZoning", owningSkill: "ZONING_LAYOUT_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "zoning layout exhausted; rank another bounded layout" },
  { capabilityId: "ZONE_COMMERCIAL", solves: ["COMMERCIAL_ZONING"], requires: ["roadAccess", "servicesReady", "commercialDemand", "zoningCells"], effect: "commercial zoning observed", effectPredicate: "commercialZoning", owningSkill: "ZONING_LAYOUT_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "commercial zoning layout exhausted; rank another bounded layout" },
  { capabilityId: "ZONE_INDUSTRIAL", solves: ["INDUSTRIAL_ZONING"], requires: ["roadAccess", "servicesReady", "industrialDemand", "zoningCells"], effect: "industrial zoning observed", effectPredicate: "industrialZoning", owningSkill: "ZONING_LAYOUT_SKILL", mutates: true, needsNativeValidation: true, failureMeaning: "industrial zoning layout exhausted; rank another bounded layout" },
  { capabilityId: "ADVANCE_SIMULATION", solves: ["SERVICE_DELIVERED", "POPULATION_GROWTH"], requires: ["simulationRunnable"], effect: "authoritative simulation progress observed", effectPredicate: "simulationFrameAdvanced", owningSkill: "CITY_GROWTH_STRATEGY_SKILL", mutates: true, needsNativeValidation: false, failureMeaning: "wait for simulation availability or player input" },
];

export interface UtilityWorldFacts {
  facilityAvailable: boolean;
  facilityAccessible: boolean;
  physicalConnection: boolean;
  networkReachable: boolean;
  capacitySufficient: boolean;
  serviceDelivered: boolean;
  /** Null means the in-scope consumer census is unknown; it must not imply an empty cohort. */
  scopedConsumerCount: number | null;
  /**
   * The city's own observed supply already covers its own observed load.
   *
   * This is the doctrine's first question, asked before any facility is
   * considered: capacity that already exists and already serves is never
   * replaced. It is a city-level fact, so it says nothing about whether *this*
   * scope's consumers are reached — that is what `serviceDelivered` is for.
   */
  existingUsableCapacity: boolean;
  /**
   * An in-scope supply exists but is not connected or not reachable. The
   * infrastructure is there and incomplete, which is a different problem from
   * having none, and it is reconnected before a new one is built.
   */
  existingInfrastructureIncomplete: boolean;
}

export interface DerivedGap {
  goalId: string;
  utility: GreenfieldUtilityKind;
  gap: MayorGap;
  satisfiedPrerequisites: readonly string[];
  unsatisfiedPredicate: string;
}

/** Recompute the first unsatisfied predicate from the current authoritative readback. */
export function deriveUtilityGap(goalId: string, utility: GreenfieldUtilityKind, facts: UtilityWorldFacts): DerivedGap | null {
  // Capacity that already exists and already serves its load is not replaced. A
  // scope with no facility of its own, in a city whose observed supply already
  // covers its observed load, has no capacity Gap to close: what is unproven is
  // whether this scope's consumers are reached, and no new facility answers
  // that. Without this, every fresh tranche re-derived FACILITY_AVAILABLE and
  // placed another generator beside a city that was already fully supplied.
  if (facts.existingUsableCapacity && !facts.facilityAvailable) {
    if (facts.scopedConsumerCount === 0) return null;
    return facts.serviceDelivered
      ? null
      : {
          goalId,
          utility,
          gap: "SERVICE_DELIVERED",
          satisfiedPrerequisites: ["existingUsableCapacity"],
          unsatisfiedPredicate: "serviceDelivered",
        };
  }
  const chain: Array<[keyof UtilityWorldFacts, MayorGap]> = [
    ["facilityAvailable", "FACILITY_AVAILABLE"],
    ["facilityAccessible", "FACILITY_ACCESSIBLE"],
    ["physicalConnection", "PHYSICAL_CONNECTION"],
    ["networkReachable", "NETWORK_REACHABLE"],
    ["capacitySufficient", "CAPACITY_SUFFICIENT"],
    ["serviceDelivered", "SERVICE_DELIVERED"],
  ];
  const satisfiedPrerequisites: string[] = [];
  for (const [predicate, gap] of chain) {
    // With no consumers in the admitted scope, the preceding facts describe
    // infrastructure readiness only. Do not turn city aggregates into a
    // service-delivery claim; delivery becomes a required predicate as soon
    // as the scoped census is positive (or unknown).
    if (predicate === "serviceDelivered" && facts.scopedConsumerCount === 0) return null;
    if (!facts[predicate]) return { goalId, utility, gap, satisfiedPrerequisites, unsatisfiedPredicate: predicate };
    satisfiedPrerequisites.push(predicate);
  }
  return null;
}

export function utilityFactsFromEvidence(input: {
  evidence: GreenfieldUtilityServiceEvidence | null;
  facilityExists: boolean;
  facilityAccessible: boolean;
  physicalConnection: boolean;
  scopedConsumerCount?: number | null;
  /**
   * The city's own observed supply covers its own observed load, read from the
   * authoritative city utilities: `supply >= load` where supply counts the
   * outside connection's import. Absent means the read did not resolve, which is
   * `false` on purpose — an unproven city is never assumed to be supplied.
   */
  existingUsableCapacity?: boolean;
  /**
   * An in-scope supply exists but is not connected or not reachable: the
   * infrastructure is there and incomplete, which is a different problem from
   * having none.
   */
  existingInfrastructureIncomplete?: boolean;
}): UtilityWorldFacts {
  const evidence = input.evidence;
  return {
    // Facility existence is the placement fact, and nothing else.
    //
    // It used to also require `supplyExists`, which is a later fact: a supply
    // readback only turns true once the facility is connected, reachable and
    // operational. That made the Gap unsatisfiable by the capability that solves
    // it -- `PLACE_FACILITY` produces a facility, never a supply -- so the ledger
    // recorded "no progress" for a placement that actually succeeded, advanced
    // past the only `FACILITY_AVAILABLE` strategy, and reported
    // `BRAIN_STRATEGIES_EXHAUSTED:FACILITY_AVAILABLE` with a placed facility on
    // the map. Each Gap in the chain is satisfied by its own capability's effect;
    // operability belongs to the network and capacity Gaps that follow.
    facilityAvailable: input.facilityExists,
    facilityAccessible: input.facilityExists && input.facilityAccessible,
    physicalConnection: input.physicalConnection,
    networkReachable: evidence?.targetNetworkReachable === true,
    capacitySufficient: evidence?.cityCapacityAvailable === true,
    // GreenfieldUtilityServiceEvidence is city/supply scoped; it does not carry
    // this tranche's consumer components. Gate1's per-building readback owns
    // delivery certification, so an aggregate cannot satisfy this predicate.
    serviceDelivered: false,
    scopedConsumerCount: input.scopedConsumerCount ?? null,
    // A read that did not resolve is never assumed to be usable capacity:
    // `undefined` and `false` both mean "not proven supplied".
    existingUsableCapacity: input.existingUsableCapacity === true,
    existingInfrastructureIncomplete: input.existingInfrastructureIncomplete === true ||
      (input.facilityExists && (input.facilityAccessible === false || input.physicalConnection === false)),
  };
}

/** A utility action counts toward the current Gap only when that Gap's own
 * predicate changes. Later facts (for example spare capacity) cannot make an
 * unreachable network count as progress. */
export function utilityGapSatisfied(gap: MayorGap, facts: UtilityWorldFacts): boolean {
  switch (gap) {
    case "FACILITY_AVAILABLE": return facts.facilityAvailable;
    case "FACILITY_ACCESSIBLE": return facts.facilityAccessible;
    case "PHYSICAL_CONNECTION": return facts.physicalConnection;
    case "NETWORK_REACHABLE": return facts.networkReachable;
    case "CAPACITY_SUFFICIENT": return facts.capacitySufficient;
    case "SERVICE_DELIVERED": return facts.serviceDelivered;
    default: return false;
  }
}

/** The utility action must have an authoritative confirmed effect, and that
 * effect must satisfy the current Gap. A planner failure cannot be credited
 * for a stale or unrelated later predicate. */
export function utilityActionMadeGapProgress(gap: MayorGap, facts: UtilityWorldFacts, effectConfirmed: boolean): boolean {
  return effectConfirmed && utilityGapSatisfied(gap, facts);
}

export type UtilityStrategy = "INITIAL_FACILITY_PLACEMENT" | "REUSE_REACHABLE_NETWORK" | "REPAIR_MISSING_FLOW_PATH" | "EXTEND_EXISTING_NETWORK" | "RECONNECT_TARGET" | "FACILITY_REPLACEMENT_LAST_RESORT" | "ADVANCE_SIMULATION";

/** Which tier of the doctrine's comparison an option belongs to. */
export type UtilityStrategyTier =
  | "existing-usable-capacity"
  | "existing-infrastructure-incomplete"
  | "outside-connection"
  | "local-generation";

export interface UtilityStrategyOption {
  strategy: UtilityStrategy;
  tier: UtilityStrategyTier;
  /** `UNSUPPORTED` names an option the product cannot observe or cannot execute. */
  availability: "AVAILABLE" | "UNSUPPORTED";
  reason: string;
}

/**
 * How a facility Gap can be closed, in the order the doctrine requires the
 * admission to consider the options, with the reason each one is or is not
 * takeable from current observable facts.
 *
 * Only options this product can actually execute are `AVAILABLE`. The outside
 * connection is observable (the city read carries its import) but this product
 * has no execution path that joins a scope to it — the connection course is
 * anchored on a facility's own connector — so it is named `UNSUPPORTED` rather
 * than offered as something nobody can take. Renaming it into the ladder would
 * be a fabricated capability.
 *
 * `existing-usable-capacity` is not enumerated here because it never reaches
 * this Gap: it is answered one level up, in `deriveUtilityGap`, where usable
 * capacity removes the facility Gap altogether — a new placement is exactly what
 * it forbids — and is then recorded as the `existingUsableCapacity` prerequisite
 * the derived Gap stands on.
 */
export function facilityGapOptions(facts?: UtilityWorldFacts): readonly UtilityStrategyOption[] {
  return [
    {
      strategy: "RECONNECT_TARGET",
      tier: "existing-infrastructure-incomplete",
      availability: facts?.existingInfrastructureIncomplete ? "AVAILABLE" : "UNSUPPORTED",
      reason: facts?.existingInfrastructureIncomplete
        ? "an in-scope supply exists and is not connected or not reachable; reconnect it"
        : "no in-scope supply exists to reconnect",
    },
    {
      strategy: "REUSE_REACHABLE_NETWORK",
      tier: "outside-connection",
      // Named, never offered. This product reads the outside connection as the
      // city's import, but it has no execution path that joins a scope to it:
      // the connection course is anchored on a facility's own connector, so a
      // scope with no supply has nothing to run it from. Marking it AVAILABLE
      // would offer an option nobody can take.
      availability: "UNSUPPORTED",
      reason: "outside connection is observable as import only; no execution path joins a scope to it",
    },
    {
      strategy: "INITIAL_FACILITY_PLACEMENT",
      tier: "local-generation",
      availability: "AVAILABLE",
      reason: "place a bounded local supply; the only path this product executes for a scope with no supply",
    },
  ];
}

export function utilityStrategiesForGap(gap: MayorGap, facts?: UtilityWorldFacts): readonly UtilityStrategy[] {
  switch (gap) {
    case "FACILITY_AVAILABLE":
      // Doctrine order, from current observable facts. A caller that passes no
      // facts keeps the previous single-option ladder, which is the last tier —
      // placement — never a fabricated higher one.
      return facts === undefined
        ? ["INITIAL_FACILITY_PLACEMENT"]
        : facilityGapOptions(facts).filter((option) => option.availability === "AVAILABLE").map((option) => option.strategy);
    // Only enumerate strategies with distinct K05 planner/execution behavior.
    // Alternate target/topology labels previously fell through to the same
    // default K05 plan and therefore were aliases, not real strategies.
    case "FACILITY_ACCESSIBLE": return [];
    case "PHYSICAL_CONNECTION": return ["REUSE_REACHABLE_NETWORK", "RECONNECT_TARGET"];
    case "NETWORK_REACHABLE": return ["REUSE_REACHABLE_NETWORK", "REPAIR_MISSING_FLOW_PATH", "EXTEND_EXISTING_NETWORK", "RECONNECT_TARGET", "FACILITY_REPLACEMENT_LAST_RESORT"];
    case "CAPACITY_SUFFICIENT": return ["REUSE_REACHABLE_NETWORK", "EXTEND_EXISTING_NETWORK", "FACILITY_REPLACEMENT_LAST_RESORT"];
    case "SERVICE_DELIVERED": return ["ADVANCE_SIMULATION"];
    default: return [];
  }
}

export function nextUtilityStrategy(
  gap: MayorGap,
  prior: readonly BrainLedgerEntry[],
  facts?: UtilityWorldFacts,
): UtilityStrategy | null {
  // Service delivery is an authoritative simulation/readback wait. Keep polling
  // the same existing progression capability until the world predicate changes;
  // treating a waiting frame as a failed construction strategy would park it.
  if (gap === "SERVICE_DELIVERED") return "ADVANCE_SIMULATION";
  const strategies = utilityStrategiesForGap(gap, facts);
  const latest = [...prior].reverse().find((entry) => entry.gap === gap);
  if (!latest) return strategies[0] ?? null;
  const previousIndex = strategies.indexOf(latest.strategy as UtilityStrategy);
  const nextIndex = Math.max(0, previousIndex) + (latest.noProgressCount > 0 || latest.exhausted ? 1 : 0);
  return strategies[nextIndex] ?? null;
}

/** Registry matching is by the derived Gap, so a placement capability cannot match a network gap. */
export function capabilitiesForGap(gap: MayorGap): CapabilityDescriptor[] {
  return MAYOR_CAPABILITIES.filter((capability) => capability.solves.includes(gap));
}

export function chooseUtilityCapability(gap: MayorGap): CapabilityDescriptor | null {
  const candidates = capabilitiesForGap(gap);
  if (gap === "NETWORK_REACHABLE") return candidates.find((candidate) => candidate.capabilityId === "REPAIR_UTILITY_NETWORK") ?? null;
  return candidates[0] ?? null;
}

/**
 * Whether a derived Gap's only capability is to let the world run.
 *
 * A wait is not work a commissioning pass can do, and the distinction decides
 * whether such a Gap may hold anything back. `SERVICE_DELIVERED` is the only
 * one in the registry, and it is special in a way that matters: its predicate
 * cannot be produced by its own capability. `utilityFactsFromEvidence` sets
 * `serviceDelivered` false by construction for a city-scoped read, because the
 * per-building consumer readback owns that fact — and that readback runs after
 * zoning. So "wait for the world" here is a livelock for any caller that must
 * zone before its consumers can exist.
 *
 * Every other Gap — a facility, its access road, the physical connection, the
 * network, the capacity, and an explicit service failure — is actionable and
 * keeps blocking. This predicate exists so that stays true by construction and
 * not by the order of a branch.
 */
export const utilityGapIsWaitOnly = (gap: MayorGap): boolean =>
  chooseUtilityCapability(gap)?.capabilityId === "ADVANCE_SIMULATION";

/**
 * Selects the next project capability from the current executable task set.
 * Gate1 owns state transitions and admission; it no longer picks the first
 * inserted task as its cross-capability scheduling policy.
 */
export const CITY_GROWTH_STRATEGY_SKILL = {
  skillId: "CITY_GROWTH_STRATEGY_SKILL" as const,
  prioritiesByStage: {
    PLANNED: ["SITE_SELECTION"],
    SITE_SELECTED: ["ROAD_CONNECTION"],
    ROAD_DELIVERED: ["ZONING", "UTILITY_PROVISION"],
    ZONED_WAITING_FOR_BUILDING: ["WAIT_FOR_BUILDING", "WAIT_OBSERVE"],
    BUILDING_OBSERVED: ["UTILITY_PROVISION", "OCCUPANCY_DIAGNOSIS", "RECOVERY"],
    WAITING_FOR_OCCUPANCY: ["WAIT_OBSERVE", "OCCUPANCY_DIAGNOSIS", "RECOVERY"],
    DIAGNOSING: ["OCCUPANCY_DIAGNOSIS", "RECOVERY"],
    RECOVERING: ["RECOVERY", "OCCUPANCY_DIAGNOSIS"],
    OCCUPIED: [],
  } satisfies Partial<Record<Gate1Stage, readonly Gate1TaskKind[]>>,
};

/**
 * Task kinds whose skill actually changes the world.
 *
 * The distinction decides scheduling precedence below, so it is named once here
 * and mirrors the `kind` each of these maps to in Gate1's own proposal table:
 * only a task that writes can be worth running ahead of the stage's own order.
 */
const WORLD_WRITE_TASK_KINDS: ReadonlySet<Gate1TaskKind> = new Set<Gate1TaskKind>([
  "ROAD_CONNECTION", "ZONING", "RECOVERY",
]);

/**
 * Which eligible task the stage's own policy runs next.
 *
 * The stage's priority order is the scheduling policy. The tranche's sticky
 * `currentTaskIds` pointer may continue work the stage has no opinion about —
 * a utility service Road child is a `ROAD_CONNECTION` running at
 * `ROAD_DELIVERED`, where the stage's list names only `ZONING` and
 * `UTILITY_PROVISION` — but it may **never let a waiting task outrank a task
 * that builds**.
 *
 * Until that last clause existed, the pointer was checked first and simple, and
 * it deadlocked the live city. Measured 2026-09-30 on a commercial tranche at
 * `ROAD_DELIVERED`: `UTILITY_PROVISION` held the pointer, its 102nd attempt was
 * journaled `UTILITY_PROVISION_PENDING:NO_ATTRIBUTED_BUILDING`, and `ZONING` —
 * the stage's first priority, and the only task that can ever produce the
 * building being waited for — sat at `attempts: 0`. The tranche could neither
 * advance nor close, and held the Brain across two independent live runs.
 */
export function chooseGate1CapabilityTask(stage: Gate1Stage, eligible: readonly Gate1Task[], currentTaskIds?: Partial<Record<Gate1TaskKind, string>>): Gate1Task | null {
  const byKind = new Map(eligible.map((task) => [task.kind, task]));
  let preferred: Gate1Task | null = null;
  for (const kind of CITY_GROWTH_STRATEGY_SKILL.prioritiesByStage[stage] ?? []) {
    const selected = byKind.get(kind);
    if (selected) { preferred = selected; break; }
  }
  const current = eligible.find((task) => currentTaskIds?.[task.kind] === task.id) ?? null;
  if (current && (!preferred || WORLD_WRITE_TASK_KINDS.has(current.kind))) return current;
  return preferred ?? current ?? null;
}

/** Runtime Skill wrapper around the already validated Road family scoring. */
export const ROAD_NETWORK_PLANNING_SKILL = {
  skillId: "ROAD_NETWORK_PLANNING_SKILL" as const,
  preferences: ["CORRIDOR_CONTINUATION", "STRAIGHT", "T_JUNCTION", "PERPENDICULAR", "GRID"] as const,
  policy: DEFAULT_MAYOR_PLANNING_POLICY as MayorPlanningPolicy,
  rankCandidates<T extends RoadPlanningCandidate>(candidates: readonly T[]): T[] {
    return rankRoadPlanningCandidates(candidates, DEFAULT_MAYOR_PLANNING_POLICY);
  },
};

/** A thin, deterministic layout ranker: retain every legal cell and prefer usable frontage. */
export const ZONING_LAYOUT_SKILL = {
  skillId: "ZONING_LAYOUT_SKILL" as const,
  strategies: ["ROAD_FRONTAGE", "COMPACT_LAYOUT", "INDUSTRIAL_SEPARATION", "ESCALATE_BOUNDED_RADIUS"] as const,
  rankCells<T extends { position: { x: number; z: number }; roadside: boolean; index: number }>(
    // Every category the product can plan for, office included: the ranker used
    // to name only R/C/I, so an office scope's own category could not be passed
    // without narrowing it first.
    cells: readonly T[], center: { x: number; z: number }, zone: GrowableZoneCategory = "residential",
  ): T[] {
    return cells.map((cell, index) => ({ cell, index,
      // All zones share candidate legality and native execution. Their actual
      // placement policies differ: commercial favors frontage; industry favors
      // separation from residential context when that read is available.
      score: zone === "industrial"
        ? ((cell as T & { distanceFromResidentialMeters?: number }).distanceFromResidentialMeters ?? 0) +
          (cell.roadside ? 10 : 0) - Math.hypot(cell.position.x - center.x, cell.position.z - center.z) * 0.001
        : zone === "commercial"
          ? (cell.roadside ? 140 : 0) - Math.hypot(cell.position.x - center.x, cell.position.z - center.z) * 0.005
          : (cell.roadside ? 100 : 0) - Math.hypot(cell.position.x - center.x, cell.position.z - center.z) * 0.01,
    })).sort((left, right) => right.score - left.score || left.index - right.index).map(({ cell }) => cell);
  },
};

export interface V2GrowthGoal {
  goalId: string;
  type: "PROVIDE_SERVICE" | "ESTABLISH_ROAD_NETWORK" | "EXPAND_RESIDENTIAL" |
    "EXPAND_COMMERCIAL" | "EXPAND_INDUSTRIAL" | "EXPAND_OFFICE" |
    "ADVANCE_SIMULATION" | "PAUSE_FOR_ISSUE";
  domain?: LocalMayorGrowthDomain;
  urgency: number;
  evidence: readonly string[];
}

/**
 * The growth domain a structured or generated goal names.
 *
 * Office is a first-class domain here. It was previously generated by the
 * policy provider, counted in the supply census and understood by the admission
 * fast path, but the Brain had no `EXPAND_OFFICE` to map it to and its allow-list
 * dropped the goal — a capability with no outlet, which is indistinguishable
 * from a missing one.
 */
export function expansionGoalTypeForDomain(domain: LocalMayorGrowthDomain): V2GrowthGoal["type"] {
  switch (domain) {
    case "commercial": return "EXPAND_COMMERCIAL";
    case "industrial": return "EXPAND_INDUSTRIAL";
    case "office": return "EXPAND_OFFICE";
    default: return "EXPAND_RESIDENTIAL";
  }
}

/** The land use a growth Goal id carries, from the Goal id itself. */
export function landUseForExpansionGoalType(type: V2GrowthGoal["type"]): GrowableLandUse | undefined {
  switch (type) {
    case "EXPAND_COMMERCIAL": return "COMMERCIAL";
    case "EXPAND_INDUSTRIAL": return "INDUSTRIAL";
    case "EXPAND_OFFICE": return "OFFICE";
    case "EXPAND_RESIDENTIAL": return "RESIDENTIAL";
    default: return undefined;
  }
}

/** Resolve the service named by either Brain or utility-provider Goal IDs. */
export function utilityKindFromServiceGoalId(goalId: string): GreenfieldUtilityKind | undefined {
  return goalId.match(/^(?:UTILITY_SERVICE|PROVIDE_SERVICE):(electricity|water|sewage)(?::|$)/)?.[1] as
    GreenfieldUtilityKind | undefined;
}

/**
 * The growth goals the city currently wants, in the order it wants them.
 *
 * A *list* rather than one answer, because "the highest-urgency Goal could not be
 * admitted" and "the city has nothing to build" are different findings, and the
 * single-answer shape forced the caller to treat them the same. With a ranked
 * list the caller can try the next domain, which is what makes a domain-level
 * refusal about one domain instead of about the city.
 *
 * Ordering is the policy provider's own, taken as it comes: urgency, then the
 * order the provider declares between the expansion domains, then a stable name
 * order, so an unchanged world yields an unchanged list.
 *
 * It used to be re-sorted here on urgency, then demand, then the domain's NAME —
 * which threw away exactly the order the provider had just decided and put
 * `EXPAND_OFFICE` ahead of `EXPAND_RESIDENTIAL` whenever the two were tied.
 * Measured live (2026-10-01, fresh city): the ranking came out
 * `PROVIDE_SERVICE, EXPAND_OFFICE, EXPAND_RESIDENTIAL, EXPAND_INDUSTRIAL,
 * EXPAND_COMMERCIAL`, and since this runtime has no Office zone prefab at all,
 * the city spent its turns on a capability gap while the housing that produces
 * the population it has none of waited behind it. Urgency already carries
 * demand for a domain goal — `growthGoalUrgency` is that function — so the
 * re-sort's second key could not add anything the first did not already hold.
 */
/**
 * Whether this Goal's own domain is one the native catalogue cannot zone at all.
 *
 * A capability the bridge does not have is not a fact about the land, and no
 * amount of building changes it. Measured live (2026-10-01): the Brain admitted
 * an Office Goal every other tick, built its access road, and only then refused
 * its own ZONING step by name — `GATE1_OFFICE_ZONE_PREFAB_UNAVAILABLE`, because
 * the map's catalogue exposes no `office: true` zone at all. Half the run's
 * ticks built nothing usable.
 *
 * The answer is a fact about the catalogue, which the observation step re-reads
 * every cycle, so filtering here releases the domain by itself the moment the
 * category unlocks: no park to expire, no strike budget, nothing to remember.
 * The domain is only ever dropped on POSITIVE evidence — `null` means the
 * catalogue was not read, and an unread catalogue suppresses nothing.
 */
function cannotZoneDomain(goal: LocalMayorGoal, state: LocalMayorState): boolean {
  const available = state.availableZoneDomains;
  // Not observed — `null`, or a state assembled without the field — suppresses
  // nothing. Only a catalogue that was read and did not carry the domain is
  // evidence that the domain is unavailable.
  if (!available) return false;
  const domain = goal.domain;
  return typeof domain === "string" && domain.length > 0 && !available.includes(domain);
}

export function rankedGrowthGoals(
  state: LocalMayorState,
  mode: MayorGrowthMode = DEFAULT_MAYOR_GROWTH_MODE,
  requestedIntent?: MayorStructuredGoalIntent | null,
  suppressedGoalFamilies: ReadonlySet<string> = new Set(),
  /**
   * `frontierFallback`: offer the frontier Goal when nothing else is left. Off by default so the caller's own
   * recovery (releasing a parked target for one more try) runs first; the runtime turns it on after that.
   */
  options?: { frontierFallback?: boolean },
): V2GrowthGoal[] {
  // A structured command is the player's own answer to "what next", so it heads
  // the list rather than replacing it: if the Goal it names cannot be admitted,
  // the city keeps building something else instead of falling idle on a command
  // that turned out to be impossible.
  const requested = requestedIntent?.kind === "GOAL"
    ? growthGoalFromStructuredIntent(requestedIntent, suppressedGoalFamilies)
    : null;
  const goals = generateLocalMayorGoals(state, mode);
  const ranked = goals.filter((goal) =>
    ["stabilize_utilities", "prepare_utility_bootstrap", "maintain_development_reserve", "grow_residential", "grow_commercial",
      "grow_industrial", "grow_office", "expand_frontier", "recover_from_failed_expansion", "wait_for_growth",
      "protect_finances", "address_city_issue"].includes(goal.kind));
  const familyOf = (goal: (typeof ranked)[number]): string | null => {
    const domain = goal.kind === "recover_from_failed_expansion" ? "residential"
      : goal.domain;
    if (goal.kind === "grow_residential" || goal.kind === "grow_commercial" || goal.kind === "grow_industrial" ||
        goal.kind === "grow_office" || goal.kind === "recover_from_failed_expansion" ||
        (goal.kind === "maintain_development_reserve" && domain)) {
      const landUse = domain ?? "residential";
      return `EXPAND_${landUse.toUpperCase()}:${landUse}`;
    }
    return null;
  };
  const generated = ranked
    .filter((goal) => {
      const family = familyOf(goal);
      return family === null || !suppressedGoalFamilies.has(family);
    })
    // A domain the catalogue cannot zone is dropped BEFORE it becomes work. The
    // family-level suppression above releases on the planning facts, which the
    // Brain's own observation step moves every cycle, so a gap handled there has
    // to be re-detected by failing again — one admitted Goal and one wasted
    // access road per cycle, forever. This one releases when the capability
    // does, and needs no memory to do it.
    .filter((goal) => !cannotZoneDomain(goal, state))
    .map((selected) => toV2GrowthGoal(state, selected));
  // A suppression key may name a family or an exact Goal. A work order that is
  // not moving is suppressed by its own Goal id — "this exact Goal is not
  // moving" is a different finding from "this domain is unavailable", and only
  // the first is true when a single work order has stalled.
  const permitted = (goal: V2GrowthGoal) => !suppressedGoalFamilies.has(goal.goalId);
  // When no expansion or service work is left to try (every domain refused its own land and what remains is only
  // "let the city run"), the city has not run out of land — it has run out of land its roads can SEE. Measured live
  // (2026-10-03): 45 ticks of observation, zero writes, while three flat, empty, owned tiles stood unreached. Offer the
  // frontier Goal so admission's frontier survey can walk a corridor to open ground; when it is suppressed (it was
  // refused and parked) the city keeps observing as before.
  const workLeft = generated.filter(permitted).some((goal) =>
    goal.type !== "ADVANCE_SIMULATION" && goal.type !== "PAUSE_FOR_ISSUE");
  const frontier: V2GrowthGoal = { goalId: "ESTABLISH_ROAD_NETWORK", type: "ESTABLISH_ROAD_NETWORK", urgency: 40,
    evidence: ["NO_EXPANSION_WORK_LEFT_ON_SEEN_GROUND"] };
  // Only when expansion domains were actually refused or parked: a city that simply has nothing to want yet is not
  // exhausted, and keeps observing.
  const domainsRefused = [...suppressedGoalFamilies].some((family) => family.startsWith("EXPAND_"));
  const withFrontier = options?.frontierFallback === true && !workLeft && domainsRefused && permitted(frontier) && !requested
    ? [...generated.filter(permitted), frontier] : null;
  if (withFrontier) {
    // Ahead of the idle answers, behind a real pause.
    return withFrontier.sort((a, b) => Number(b.type !== "ADVANCE_SIMULATION") - Number(a.type !== "ADVANCE_SIMULATION"));
  }
  if (!requested) return generated.filter(permitted);
  if (!permitted(requested)) return generated.filter(permitted);
  // The request is deduplicated by Goal id, because a generated Goal of the same
  // kind is the same work and offering it twice would spend two admissions on it.
  return [requested, ...generated.filter((goal) => permitted(goal) && goal.goalId !== requested.goalId)];
}

/** `protect_finances` below this urgency is the "balance is negative but runway remains" case (45), not the runway shortfall (90). */
export const SOFT_FINANCE_URGENCY_CEILING = 90;

function toV2GrowthGoal(state: LocalMayorState, selected: LocalMayorGoal): V2GrowthGoal {
  // A deficit with runway left is not a blocker. Measured live (2026-10-03): treasury 461k at -61k a month (7.5 months),
  // every growth domain parked, and the one goal left was `protect_finances` at urgency 45 — read as "pause for an
  // issue", it froze the whole Brain for six windows until the stall watchdog halted the session. Only a real runway
  // shortfall (urgency 90) pauses; a soft one lets the city run, like any other idle answer.
  if (selected.kind === "protect_finances" && selected.urgency < SOFT_FINANCE_URGENCY_CEILING) {
    return { goalId: "ADVANCE_SIMULATION", type: "ADVANCE_SIMULATION", urgency: selected.urgency, evidence: selected.evidence };
  }
  if (selected.kind === "protect_finances" || selected.kind === "address_city_issue") {
    return { goalId: selected.kind, type: "PAUSE_FOR_ISSUE", urgency: selected.urgency, evidence: selected.evidence };
  }
  // Preparation for an uncommissioned utility is a service Goal for its own
  // kind. It picks that kind from the world facts — never a second red light —
  // so one requirement covers the committed development instead of water and
  // sewage each claiming the Brain.
  const bootstrapKinds = selected.kind === "prepare_utility_bootstrap" ? uncommissionedUtilityKinds(state.utilities) : [];
  const service = selected.kind === "stabilize_utilities" || bootstrapKinds.length > 0;
  const domain = selected.domain;
  // A domain goal carries its own domain through unchanged, so every growable
  // land use — including office — reaches admission; only a goal with no domain
  // of its own falls back to residential.
  const growthDomain = service ? undefined : domain ?? (selected.kind === "recover_from_failed_expansion" ? "residential" : undefined);
  const type: V2GrowthGoal["type"] = service ? "PROVIDE_SERVICE"
    : growthDomain ? expansionGoalTypeForDomain(growthDomain)
      : selected.kind === "wait_for_growth" ? "ADVANCE_SIMULATION"
        : selected.kind === "expand_frontier" || selected.kind === "recover_from_failed_expansion" ||
          (selected.kind === "maintain_development_reserve" && !domain && state.developmentCapacity.reserveStatus === "empty")
          ? "ESTABLISH_ROAD_NETWORK" : "EXPAND_RESIDENTIAL";
  const utilityDomain = bootstrapKinds[0] ?? state.serviceRecovery?.targetDomain ??
    (["electricity", "water", "sewage"] as const).find((kind) => state.utilities[kind].risk === "critical");
  return {
    goalId: `${type}${domain ? `:${domain}` : service && utilityDomain ? `:${utilityDomain}` : ""}`,
    type,
    ...(domain ? { domain } : {}),
    urgency: selected.urgency,
    evidence: selected.evidence,
  };
}

/**
 * The single highest-ranked growth goal.
 *
 * Kept as the shape most callers want, and defined as the head of
 * {@link rankedGrowthGoals} so there is exactly one ranking in the product. A
 * caller that needs to fall through to the next domain asks for the list.
 */
export function nextGrowthGoal(
  state: LocalMayorState,
  requestedIntent?: MayorStructuredGoalIntent | null,
  suppressedGoalFamilies: ReadonlySet<string> = new Set(),
  mode: MayorGrowthMode = DEFAULT_MAYOR_GROWTH_MODE,
): V2GrowthGoal | null {
  return rankedGrowthGoals(state, mode, requestedIntent, suppressedGoalFamilies)[0] ?? null;
}

/** A structured quick-command Goal, or null when it names something unexecutable. */
export function growthGoalFromStructuredIntent(
  requestedIntent: MayorStructuredGoalIntent,
  suppressedGoalFamilies: ReadonlySet<string> = new Set(),
): V2GrowthGoal | null {
  // The intent→primitive table decides executability; an intent with a missing primitive names no Goal.
  if (!isStructuredIntentInVocabulary(requestedIntent) || !planStructuredIntent(requestedIntent).executable) return null;
  if (!["GROW_POPULATION", "EXPAND_RESIDENTIAL", "EXPAND_COMMERCIAL", "EXPAND_INDUSTRIAL", "EXPAND_OFFICE",
    "PROVIDE_SERVICE", "ESTABLISH_ROAD_NETWORK"].includes(requestedIntent.type)) return null;
  const service = requestedIntent.type === "PROVIDE_SERVICE" ? requestedIntent.scope?.serviceKind?.toLowerCase() : undefined;
  const type: V2GrowthGoal["type"] = requestedIntent.type === "PROVIDE_SERVICE" ? "PROVIDE_SERVICE"
    : requestedIntent.type === "ESTABLISH_ROAD_NETWORK" ? "ESTABLISH_ROAD_NETWORK"
      : requestedIntent.type === "EXPAND_COMMERCIAL" ? "EXPAND_COMMERCIAL"
        : requestedIntent.type === "EXPAND_INDUSTRIAL" ? "EXPAND_INDUSTRIAL"
          : requestedIntent.type === "EXPAND_OFFICE" ? "EXPAND_OFFICE"
            : "EXPAND_RESIDENTIAL";
  if (type === "PROVIDE_SERVICE" && service !== "electricity" && service !== "water" && service !== "sewage") return null;
  if (type === "PROVIDE_SERVICE" && !(service === "electricity" || service === "water" || service === "sewage")) return null;
  const domain = landUseForExpansionGoalType(type)?.toLowerCase() as LocalMayorGrowthDomain | undefined;
  const requested: V2GrowthGoal = {
    goalId: `${type}${service ? `:${service}` : ""}`,
    type,
    ...(domain ? { domain } : {}),
    urgency: requestedIntent.priority === "HIGH" ? 100 : requestedIntent.priority === "LOW" ? 1 : 50,
    evidence: ["STRUCTURED_QUICK_COMMAND"],
  };
  const family = type.startsWith("EXPAND_") ? `${type}:${requested.domain}` : requested.goalId;
  return suppressedGoalFamilies.has(family) ? null : requested;
}

export interface BrainLedgerEntry {
  goalId: string;
  gap: MayorGap;
  strategy: string;
  planningEpoch: string;
  noProgressCount: number;
  exhausted: boolean;
  lastOutcome: string;
}

/** Bump when runtime strategy wiring changes so old exhaustion cannot suppress a fixed capability. */
export const AUTONOMOUS_BRAIN_LEDGER_REVISION = "journal-proven-placement-claim/15";

/** Planning history expires when its world/branch, relevant domain, or runtime decision revision changes. */
export function ledgerEpoch(identity: { worldId: string; checkpointId: string | null; generation: string; branchId: string; domainRevision: number }): string {
  return JSON.stringify([identity.worldId, identity.checkpointId, identity.generation, identity.branchId,
    identity.domainRevision, AUTONOMOUS_BRAIN_LEDGER_REVISION]);
}

export function meaningfulProgress(input: { before: readonly boolean[]; after: readonly boolean[]; measureBefore?: number | null; measureAfter?: number | null }): boolean {
  if (input.before.length !== input.after.length) return false;
  if (input.before.some((value, index) => !value && input.after[index])) return true;
  return input.measureBefore !== null && input.measureBefore !== undefined && input.measureAfter !== null && input.measureAfter !== undefined &&
    Number.isFinite(input.measureBefore) && Number.isFinite(input.measureAfter) && input.measureAfter < input.measureBefore;
}
