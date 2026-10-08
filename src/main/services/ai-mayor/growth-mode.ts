/**
 * How fast the city is being built, and which pacing policy decides that.
 *
 * This is product direction, not an observation, and it deliberately outranks
 * the earlier "early phase" reading of the same question. The previous model
 * treated rapid expansion as a *transient* early-game exception: a city started
 * fast, proved its first absorption loop, and then settled into small tranches
 * each observed before the next. That is no longer the default product. The
 * product asks for a city that keeps building for as long as legal, fundable,
 * natively-valid buildable space and an executable construction action both
 * exist.
 *
 * Two distinct questions live here, and collapsing them is what produced the
 * old behaviour:
 *
 * 1. **Strategy** — `MayorGrowthMode`. Whether the city's own absorption,
 *    vacancy or demand may stop the next package. In `FULL_SPEED_EXPANSION`
 *    (the default) none of them may: they reorder what is built, never whether.
 *    In `ABSORPTION_CONTROL` (the superseded policy, kept selectable) a domain's
 *    unabsorbed supply holds back the next package of that domain.
 *
 * 2. **Pace** — `GrowthPace`, derived from the city's population. SimCity is
 *    hardware-hungry, and an agent that expands flat-out forever will make the
 *    simulation itself the bottleneck. The first automatic slow-down node is
 *    {@link AUTONOMY_STABILIZATION_POPULATION} (100,000 residents), where the
 *    Mayor settles into a sustainable autonomous cadence.
 *
 * The pace is a dial, never a switch, and that is a hard product rule: at and
 * above the node the Mayor **must still be able to expand**. Slowing down means
 * smaller packages, fewer census reads per package and longer observation
 * windows — fewer native reads and writes per minute, which is what the hardware
 * actually pays for. It never means "no growth goal", "observe forever", or
 * "the city is finished". A city that has run out of legal room is a different
 * finding, decided by admission and the native readback, and it is not this
 * module's to make.
 *
 * Nothing here reads the world. Every fact that decides whether a *specific*
 * build is legal belongs to admission and to the native readback.
 *
 * **There is no direct growable-placement fast lane, and this is why.** The
 * product asked for `frontage → zoning + direct building placement in parallel`;
 * it was measured live (2026-09-30) and refused. `cs2_place_building` runs CS2's
 * object placement tool, which has no concept of a zone lot: the committed
 * growable came back `condemned`, with `roadEdge: null` and zero renters, and
 * the game removed it within two game hours. A growable is spawned onto a
 * VacantLot owned by a zone block and needs a native road connection; zoning is
 * the mechanism that creates the lot, not an alternative to it. So throughput is
 * taken from the two levers that are real — maximum-throughput zoning, and Road
 * and frontage built ahead of the current district. Evidence and reproduction:
 * `docs/ai-mayor/DIRECT_GROWABLE_PLACEMENT_CAPABILITY.md`.
 */

export type MayorGrowthMode = "FULL_SPEED_EXPANSION" | "ABSORPTION_CONTROL";

/**
 * A growable land use, in the spelling the durable Goal identity carries.
 *
 * All four are first-class. Office was previously present in the state model and
 * in the land search while being unreachable from the Brain's Goal vocabulary,
 * which made it a capability without an outlet; naming the whole set once, in a
 * leaf module both the policy provider and the execution layer import, is what
 * keeps a new land use from being added in one place and forgotten in the five
 * that have to agree.
 */
export type GrowableLandUse = "RESIDENTIAL" | "COMMERCIAL" | "INDUSTRIAL" | "OFFICE";

/** The same four, lowercased, as the zoning census and the policy provider spell them. */
export type GrowableZoneCategory = "residential" | "commercial" | "industrial" | "office";

export const GROWABLE_LAND_USES: readonly GrowableLandUse[] = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "OFFICE"];

export const GROWABLE_ZONE_CATEGORY_FOR_LAND_USE: Readonly<Record<GrowableLandUse, GrowableZoneCategory>> = {
  RESIDENTIAL: "residential",
  COMMERCIAL: "commercial",
  INDUSTRIAL: "industrial",
  OFFICE: "office",
};

/** The land use a spelling names, or undefined when it names none of them. */
export function growableLandUseOf(value: string | undefined | null): GrowableLandUse | undefined {
  if (!value) return undefined;
  const needle = value.toLowerCase();
  return GROWABLE_LAND_USES.find((landUse) => landUse.toLowerCase() === needle);
}

/**
 * The product default.
 *
 * The frozen product requirement is that the default mode is full-speed
 * expansion until the user chooses otherwise, so this is not derived from the
 * city's state and is not exited on a milestone.
 */
export const DEFAULT_MAYOR_GROWTH_MODE: MayorGrowthMode = "FULL_SPEED_EXPANSION";

/**
 * The first population at which the Mayor automatically settles into its
 * sustainable autonomous cadence.
 *
 * The earlier "early growth phase" model used the same idea but defined the
 * boundary by a control problem — scarce cash, an unproven absorption loop — and
 * therefore left it the moment the *design* was proven, at a few hundred
 * residents. That boundary is far too low to be the hardware answer: the
 * simulation cost that makes flat-out expansion unsustainable is a function of
 * the city's size, and it is not felt until the city is large.
 *
 * 100,000 is the node the product names. It is a *settling* point, not a stop:
 * see the module header. The pace below it is {@link FULL_PACE}, at and above it
 * {@link SUSTAINED_PACE}.
 */
export const AUTONOMY_STABILIZATION_POPULATION = 100_000;
/** From this share of the player's population target the districts get smaller (`NEAR_TARGET_SQUARE_METERS_PER_PERSON` in the district builder). */
export const NEAR_TARGET_START_SHARE = 0.9;

/**
 * How large a package is, how many anchors it censuses, and how long the Mayor
 * lets the city run between packages.
 *
 * These are the three dials that decide how much native work — and therefore how
 * much of the game's own simulation budget — one minute of autonomy costs.
 * Everything else about a package is a legality rule and is identical in both
 * paces.
 */
export interface GrowthPace {
  readonly paceId: "FULL" | "SUSTAINED";
  /**
   * How much land one growable admission may search before it refuses a domain.
   *
   * The single largest speed lever that is also a correctness one: a wider ring
   * is what turns "this domain is unavailable" back into "this region is".
   */
  readonly maximumSiteAnchors: number;
  /**
   * Multiplier on the tranche's programme — its population target, its candidate
   * count and its spend ceiling.
   *
   * Deliberately NOT applied to the planning envelope: the reservation has to
   * stay inside the region admission actually observed, so a larger programme
   * buys more capacity inside the same proven ground rather than a claim on
   * ground nobody read.
   */
  readonly programmeMultiplier: number;
  /** How many bounded construction items one growth package may chain. */
  readonly maximumPackageItems: number;
  /** Game hours the Mayor lets the city run between packages. */
  readonly interPackageObservationHours: number;
}

/**
 * Below the stabilization node: the product's headline posture. A package is a
 * programme of several coherent construction items, searched across the widest
 * bounded ring, with the shortest gap between packages.
 */
export const FULL_PACE: GrowthPace = {
  paceId: "FULL",
  maximumSiteAnchors: 8,
  programmeMultiplier: 2,
  maximumPackageItems: 5,
  interPackageObservationHours: 0.25,
};

/**
 * At and above the stabilization node: the same construction pipeline, dialled
 * down on every axis so the Mayor spends far fewer native reads and writes per
 * minute. A package is still a package — bounded, funded, natively previewed,
 * durably commanded and authoritatively read back — it is simply smaller and
 * further apart. Expansion capability is untouched: the next frontier is still
 * planned, admitted and built.
 */
export const SUSTAINED_PACE: GrowthPace = {
  paceId: "SUSTAINED",
  maximumSiteAnchors: 4,
  programmeMultiplier: 1,
  maximumPackageItems: 2,
  interPackageObservationHours: 1,
};

/**
 * The player-facing pacing configuration.
 *
 * Two player intents, both of which the product must support even though only
 * the default is wired today:
 *
 * - the **target population** at which the Mayor brakes automatically, and
 * - an explicit **mode switch** between expansion and autonomy, available at any
 *   time regardless of population.
 *
 * Both are optional and both default to the frozen product behaviour, so a build
 * with no settings source at all runs exactly the default policy. The shape
 * exists now so the UI is an input box rather than a redesign: everything that
 * reads the pace already goes through {@link growthPaceForPopulation}, which
 * takes this object.
 */
export interface MayorGrowthSettings {
  /** Which expansion policy is in force. See {@link MayorGrowthMode}. */
  mode: MayorGrowthMode;
  /**
   * The population at which the Mayor automatically settles into its
   * sustainable cadence — the player's chosen target population.
   *
   * The default is {@link AUTONOMY_STABILIZATION_POPULATION} (100,000) and that
   * default must not move: 100,000 is the first automatic brake node, and a
   * player may aim lower or higher from there, not instead of it.
   */
  stabilizationPopulation: number;
  /**
   * A pace the player pinned, overriding the population-derived one.
   *
   * `null` means "automatic": the pace follows the target population. `"FULL"`
   * is the explicit expansion mode and `"SUSTAINED"` the explicit autonomy mode,
   * and either can be selected at any population — including switching into
   * autonomy long before the brake node is reached, which is the switch the
   * product promises.
   */
  pinnedPace: GrowthPace["paceId"] | null;
}

/** The frozen product defaults: automatic, braking at 100,000. */
export const DEFAULT_MAYOR_GROWTH_SETTINGS: MayorGrowthSettings = {
  mode: DEFAULT_MAYOR_GROWTH_MODE,
  stabilizationPopulation: AUTONOMY_STABILIZATION_POPULATION,
  pinnedPace: null,
};

/** Bounds a player-supplied target population must land inside. */
export const MINIMUM_STABILIZATION_POPULATION = 1_000;
export const MAXIMUM_STABILIZATION_POPULATION = 1_000_000;

/**
 * Fill in and bound a partial settings object.
 *
 * Every field is optional and every refusal falls back to the frozen default
 * rather than failing: a configuration surface must not be able to produce a
 * Mayor that builds nothing, and an unusable target population is much more
 * likely to be a typo or a not-yet-populated input box than an instruction.
 */
export function resolveGrowthSettings(input?: Partial<MayorGrowthSettings> | null): MayorGrowthSettings {
  const target = input?.stabilizationPopulation;
  const stabilizationPopulation = typeof target === "number" && Number.isFinite(target)
    ? Math.max(MINIMUM_STABILIZATION_POPULATION, Math.min(MAXIMUM_STABILIZATION_POPULATION, Math.round(target)))
    : DEFAULT_MAYOR_GROWTH_SETTINGS.stabilizationPopulation;
  return {
    mode: input?.mode === "ABSORPTION_CONTROL" ? "ABSORPTION_CONTROL" : DEFAULT_MAYOR_GROWTH_MODE,
    stabilizationPopulation,
    pinnedPace: input?.pinnedPace === "FULL" || input?.pinnedPace === "SUSTAINED" ? input.pinnedPace : null,
  };
}

/**
 * The pace the city is built at: the player's pin if there is one, otherwise the
 * pace its own population asks for against the player's target.
 *
 * An unknown population is read as "not yet at the node", matching the earlier
 * module's rule that anything unread is treated as not-yet-proven: a city whose
 * census did not resolve has not been shown to be large.
 */
export function growthPaceForPopulation(
  population: number | null | undefined,
  settings: MayorGrowthSettings = DEFAULT_MAYOR_GROWTH_SETTINGS,
): GrowthPace {
  if (settings.pinnedPace === "FULL") return FULL_PACE;
  if (settings.pinnedPace === "SUSTAINED") return SUSTAINED_PACE;
  if (population === null || population === undefined || !Number.isFinite(population)) return FULL_PACE;
  return population >= settings.stabilizationPopulation ? SUSTAINED_PACE : FULL_PACE;
}

/**
 * Demand at or above which a domain's own growth goal is raised under the
 * absorption-controlled policy. Under full-speed expansion the floor is zero:
 * buildable, owned, fronted land with a funded executable action is itself the
 * warrant, and demand only orders the domains against each other.
 */
export const ABSORPTION_CONTROL_DEMAND_FLOOR = 60;

/**
 * The demand floor this mode raises a domain's growth goal at.
 *
 * Zero in full-speed expansion, and **still zero at the stabilization node**.
 * The pace dials the size and cadence of packages; it does not reintroduce
 * demand gating, because that would be exactly the "slowed down so far it
 * stopped" failure the product forbids. This is the single place the "demand is
 * a priority signal, never a master off-switch" rule is expressed, so no caller
 * can reintroduce gating by picking its own threshold.
 */
export function growthModeDemandFloor(mode: MayorGrowthMode = DEFAULT_MAYOR_GROWTH_MODE): number {
  return mode === "FULL_SPEED_EXPANSION" ? 0 : ABSORPTION_CONTROL_DEMAND_FLOOR;
}

/**
 * Whether a domain's own unabsorbed supply may hold back its next package.
 *
 * Only in absorption control. Under full-speed expansion an unabsorbed batch is
 * a reason to build *something else* — another domain, the next frontier, the
 * utilities the committed land needs — never a reason for the Mayor to stop. The
 * pace does not change this: a large city still builds.
 */
export function absorptionGatesExpansion(mode: MayorGrowthMode = DEFAULT_MAYOR_GROWTH_MODE): boolean {
  return mode === "ABSORPTION_CONTROL";
}

/** The fields of an admission policy the pace is allowed to move. */
export interface GrowthPolicyShape {
  planningEnvelopeRadiusMeters: number;
  maximumPlanningEnvelopeRadiusMeters: number;
  /** Absolute spend ceiling for one starter tranche, regardless of treasury. */
  absoluteBudgetCeiling: number;
  /** Bounded number of site candidates handed to the deterministic planner. */
  maximumSiteCandidates?: number;
  /** Bounded starter population target. Meaningful for a residential package. */
  targetResidents?: number;
  /** Bounded census centres one growable admission may read. */
  maximumGrowableSearchAnchors?: number;
}

/**
 * The admission policy for one pace.
 *
 * Only two things move: how much land one admission searches, and how large a
 * programme it asks for on that land. Every refusal rule, every legality
 * predicate, every native preview and every readback is untouched — which is
 * what keeps a full-speed package a real, bounded, individually validated
 * tranche rather than a district-sized request nobody validated.
 *
 * The **planning envelope and its ceiling are deliberately not scaled**. The
 * envelope is the reservation admission places on land, and the whole admission
 * design rests on that land having been observed: the ceiling is sized to the
 * bounded detail read so a selected envelope is always a region the search
 * actually looked at. Scaling it with the pace would hand a large city a claim
 * on ground nobody censused, which is exactly the failure the ceiling exists to
 * prevent. A bigger programme therefore buys more capacity inside proven ground,
 * not more ground.
 */
export function growthPacePolicy<T extends GrowthPolicyShape>(base: T, pace: GrowthPace): T {
  const multiplier = pace.programmeMultiplier;
  const scale = (value: number | undefined) =>
    value === undefined || multiplier <= 1 ? value : Math.round(value * multiplier);
  return {
    ...base,
    ...(base.maximumGrowableSearchAnchors === undefined
      ? {}
      : { maximumGrowableSearchAnchors: pace.maximumSiteAnchors }),
    ...(scale(base.targetResidents) === undefined ? {} : { targetResidents: scale(base.targetResidents) }),
    ...(multiplier <= 1 ? {} : { absoluteBudgetCeiling: Math.round(base.absoluteBudgetCeiling * multiplier) }),
    ...(scale(base.maximumSiteCandidates) === undefined
      ? {}
      : { maximumSiteCandidates: scale(base.maximumSiteCandidates) }),
  };
}
