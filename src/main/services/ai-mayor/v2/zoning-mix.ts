/**
 * THE MIX OF LAND USES — what share of a city's zoning each use should hold, and which spot gets which.
 *
 * Measured live (2026-10-03): 86% of the zoned cells were residential, 3% commercial, none office, while the game's own
 * demand for commercial and office buildings stood at its maximum and nine in ten medium-density cells sat empty.
 * "Demand is not a build order" (Bible), but demand, what zoning has not yet been realised, and jobs against homes are
 * exactly the evidence that says where the next cells should go.
 *
 * External play knowledge is a STARTING PRIOR only: a new district is roughly half homes, a fifth shops, some offices,
 * some industry. The target is that prior corrected by the world — more of what the game is asking for, less of what
 * is already zoned and standing empty. Nothing here knows a city; the shares move with the readings.
 */
export type ZoneCategory = "residential" | "commercial" | "office" | "industrial";
export const ZONE_CATEGORIES: readonly ZoneCategory[] = ["residential", "commercial", "office", "industrial"];

/** Starting prior for a normal district: R/C/O/I ≈ 50/20/15/15. A prior, not a rule. */
export const LAND_USE_PRIOR: Readonly<Record<ZoneCategory, number>> = { residential: 0.5, commercial: 0.2, office: 0.15, industrial: 0.15 };

export interface ZoningMixSignals {
  /** Zoned cells per land use and how many of them hold no building yet. */
  cells: Record<ZoneCategory, { zoned: number; empty: number }>;
  /** The game's building demand per land use, 0–100. */
  demand: Record<ZoneCategory, number>;
  /**
   * Residential zoned and empty cells per density, and the game's building demand for that density (0–100; null when unread). Absent when
   * the host cannot read it: the density policy then cannot judge vacancy and says so. Low-rent zones are counted in none of these.
   */
  residentialByDensity?: Record<"low" | "medium" | "high", { zoned: number; empty: number; demand: number | null }>;
}

/** A shop, office or industrial zoning this empty (and at least this large) is saturated: no more of it is laid until it fills. */
export const NON_HOUSING_SATURATED_SHARE = 0.5;
export const SATURATION_MINIMUM_ZONED_CELLS = 300;

/** At most this share of a district's outer faces is given to shops and offices; the rest stays housing. */
export const RING_SHARE_FOR_NON_HOUSING = 0.85;
export const emptyMix = (): ZoningMixSignals => ({
  cells: { residential: { zoned: 0, empty: 0 }, commercial: { zoned: 0, empty: 0 }, office: { zoned: 0, empty: 0 }, industrial: { zoned: 0, empty: 0 } },
  demand: { residential: 0, commercial: 0, office: 0, industrial: 0 },
});

/** The land use a zone type belongs to, from its name; null for a name that is none of them. */
export function categoryOfZoneName(name: string): ZoneCategory | null {
  if (/office/i.test(name)) return "office";
  if (/residential/i.test(name)) return "residential";
  if (/commercial/i.test(name)) return "commercial";
  if (/industrial/i.test(name)) return "industrial";
  return null;
}

/** Share of a land use's zoned cells that stand empty. */
export function unrealizedShare(signals: ZoningMixSignals, category: ZoneCategory): number {
  const { zoned, empty } = signals.cells[category];
  return zoned > 0 ? empty / zoned : 0;
}

/**
 * Where the mix should be heading: the prior, raised for what the game is asking for and lowered for zoning that has
 * not been realised, then normalised. A use whose demand is nil still keeps a floor so it is never zoned out of the city.
 */
export function targetShares(signals: ZoningMixSignals, available: readonly ZoneCategory[] = ZONE_CATEGORIES): Record<ZoneCategory, number> {
  const weights = Object.fromEntries(ZONE_CATEGORIES.map((category) => {
    // A land use the game has not unlocked cannot be zoned: it holds no share, and the others divide the whole.
    if (!available.includes(category)) return [category, 0];
    const unrealisedNow = unrealizedShare(signals, category);
    // Shops, offices and industry already standing this empty get no more: their zoning grows nothing until what is there fills (live 2026-10-08:
    // 9,839 of 10,289 office cells and 6,902 of 11,318 shop cells empty while 97% of the homes' cells were built and housing was the bottleneck).
    if (category !== "residential" && signals.cells[category].zoned >= SATURATION_MINIMUM_ZONED_CELLS && unrealisedNow >= NON_HOUSING_SATURATED_SHARE) return [category, 0];
    const demand = Math.max(0, Math.min(100, signals.demand[category])) / 100;
    const unrealised = Math.min(0.9, unrealisedNow);
    // Offices keep no floor: their demand bar is not a signal (V2 P4) and an office zone with no demand stands empty for good.
    const floor = category === "office" ? 0 : 0.3;
    return [category, LAND_USE_PRIOR[category] * (floor + (1 - floor) * demand) * (1 - 0.85 * unrealised)];
  })) as Record<ZoneCategory, number>;
  const total = ZONE_CATEGORIES.reduce((sum, category) => sum + weights[category], 0);
  return Object.fromEntries(ZONE_CATEGORIES.map((category) => [category, total > 0 ? weights[category] / total : LAND_USE_PRIOR[category]])) as Record<ZoneCategory, number>;
}

/** Target share minus the share already zoned: positive means the city is short of that use. */
export function mixDeficits(signals: ZoningMixSignals, available: readonly ZoneCategory[] = ZONE_CATEGORIES): Record<ZoneCategory, number> {
  const target = targetShares(signals, available);
  const total = ZONE_CATEGORIES.reduce((sum, category) => sum + signals.cells[category].zoned, 0);
  return Object.fromEntries(ZONE_CATEGORIES.map((category) => [category, target[category] - (total > 0 ? signals.cells[category].zoned / total : 0)])) as Record<ZoneCategory, number>;
}

/**
 * Splits `count` spots among the allowed uses in proportion to their positive deficits (largest remainder). With no
 * positive deficit among the allowed uses, the whole count goes to the one with the largest target share.
 */
export function allocateByDeficit(count: number, deficits: Record<ZoneCategory, number>, allowed: readonly ZoneCategory[]): Record<ZoneCategory, number> {
  const result: Record<ZoneCategory, number> = { residential: 0, commercial: 0, office: 0, industrial: 0 };
  if (count <= 0 || allowed.length === 0) return result;
  const positive = allowed.filter((category) => deficits[category] > 0);
  const basis = positive.length > 0 ? positive : [allowed.reduce((best, category) => (deficits[category] > deficits[best] ? category : best), allowed[0]!)];
  const weights = basis.map((category) => Math.max(deficits[category], 1e-6));
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => (weight / sum) * count);
  const floors = exact.map(Math.floor);
  let remaining = count - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - floors[index]! })).sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) { if (remaining <= 0) break; floors[index]! += 1; remaining -= 1; }
  basis.forEach((category, index) => { result[category] = floors[index]!; });
  return result;
}

/**
 * The land use of each spot of a new district. Homes sit inside; shops and offices take the outer faces, where customers
 * and traffic arrive (Commercial near customers on collector frontage, Office as the buffer between homes and the
 * through traffic). The shares are the world-corrected target, not a fixed pattern, so the geometry still follows the
 * district's own grid. An industrial district is industrial throughout.
 */
export function assignDistrictSpots(spots: ReadonlyArray<{ onRing: boolean }>, districtIsIndustrial: boolean, signals: ZoningMixSignals,
  available: readonly ZoneCategory[] = ZONE_CATEGORIES): ZoneCategory[] {
  if (districtIsIndustrial) return spots.map(() => "industrial");
  const target = targetShares(signals, available);
  const withoutIndustry = (target.residential + target.commercial + target.office) || 1;
  const shares = { residential: target.residential / withoutIndustry, commercial: target.commercial / withoutIndustry, office: target.office / withoutIndustry };
  const result: ZoneCategory[] = spots.map(() => "residential");
  const ring = spots.map((spot, index) => ({ spot, index })).filter((entry) => entry.spot.onRing);
  // Shops and offices live on the outer faces, so what the mix asks for is capped by the faces there are (and some face is
  // left to homes), then shared between them in the proportion the mix asked.
  const wantedCommercial = Math.round(shares.commercial * spots.length);
  const wantedOffice = Math.round(shares.office * spots.length);
  const room = Math.floor(ring.length * RING_SHARE_FOR_NON_HOUSING);
  const scale = wantedCommercial + wantedOffice > room && wantedCommercial + wantedOffice > 0 ? room / (wantedCommercial + wantedOffice) : 1;
  const commercialQuota = Math.floor(wantedCommercial * scale);
  const quota = { commercial: commercialQuota, office: Math.min(Math.floor(wantedOffice * scale), Math.max(0, room - commercialQuota)) };
  // Spread them along the ring rather than in one run: every k-th ring spot in turn.
  const take = (category: "commercial" | "office", wanted: number, from: number) => {
    const free = ring.filter((entry) => result[entry.index] === "residential");
    if (wanted <= 0 || free.length === 0) return;
    const stride = Math.max(1, Math.floor(free.length / wanted));
    let placed = 0;
    for (let at = from % stride; at < free.length && placed < wanted; at += stride) { result[free[at]!.index] = category; placed += 1; }
  };
  take("commercial", quota.commercial, 0);
  take("office", quota.office, 1);
  return result;
}
