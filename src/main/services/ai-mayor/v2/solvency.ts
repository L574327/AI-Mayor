/**
 * Keeping the city solvent — the executable form of skill.S06 StabilizeFinance (Bible POL-FINANCE, cards K29–K34).
 *
 * What the Bible forbids, and this module therefore does not do: freeze growth on a negative opening month, change
 * taxes every tick or across the board, halve every low-utilisation service, or borrow to carry a structural deficit.
 * What it requires, and this module provides: affordability judged by cash runway, the FULL marginal cost of an
 * expansion (land upkeep that rises on tiles already owned, K34), and nothing automatic on taxes until a purposeful,
 * measured experiment says which way to move them (K31).
 *
 * History (2026-10-03): the first version raised every tax to 14% and cut every costly service to 50% whenever the
 * runway was short. Measured live, 14% put the demand "Taxes" factor at −320 (commercial) and −360 (industrial) and the
 * city could not grow its tax base; land bought "because the treasury allowed it" took the map-tile upkeep from 0 to
 * 59k a month (9 tiles are free, every one beyond them is charged, and the rate on all of them rises with the count).
 */
export const SOLVENCY_RUNWAY_MONTHS = 4;
export const CIVIC_AFFORDABLE_RUNWAY_MONTHS = 8;
export const SOLVENCY_TAX_AREAS = ["Residential", "Commercial", "Industrial", "Office"] as const;

export type TaxArea = (typeof SOLVENCY_TAX_AREAS)[number];

/** Months of runway: infinite for a non-negative balance, null when the treasury or balance is unknown. */
export function runwayMonths(treasury: number | null, monthlyBalance: number | null): number | null {
  if (treasury === null || monthlyBalance === null || !Number.isFinite(treasury) || !Number.isFinite(monthlyBalance)) return null;
  if (monthlyBalance >= 0) return Number.POSITIVE_INFINITY;
  return treasury / -monthlyBalance;
}

/** Whether the city can carry one more recurring cost. Unknown is not affordable. */
export function civicIsAffordable(treasury: number | null, monthlyBalance: number | null): boolean {
  const runway = runwayMonths(treasury, monthlyBalance);
  return runway !== null && runway >= CIVIC_AFFORDABLE_RUNWAY_MONTHS;
}

/**
 * Land (K34). The first nine tiles are free; every tile beyond them is charged a share of its price, and that share
 * climbs with the number of tiles owned, so the cost of tile n+1 includes the rise on the n tiles already held.
 * Measured live on this product's map: 9 owned = 0, 11 owned = 36k a month, 13 owned = 59k a month.
 * The two tiles added last cost 11.7k a month each, so a tile is never assumed to cost less than that.
 */
export const FREE_MAP_TILES = 9;
/** Measured: the average charged tile cost 18k–21k a month on the maps seen; used until the game's own figure can be read. */
export const MEASURED_MINIMUM_MARGINAL_TILE_UPKEEP = 20_000;
/** The next tile costs more than the average one (the rate on all tiles rises with the count): margin over the average. */
export const MARGINAL_TILE_UPKEEP_MARGIN = 1.25;
/** Cash a land purchase must leave behind, as hours of the city's own net outflow (a city that earns more than it spends leaves nothing). */
export const LAND_RESERVE_HOURS = 6;
/** Game hours in a game month (30 days): the bridge between the game's monthly figures and an hourly rule. */
export const GAME_HOURS_PER_MONTH = 30 * 24;
/** Building outward needs cash for this many months of spending, whatever the monthly balance says. */
export const EXPANSION_CASH_MONTHS = 3;

/**
 * What the next tile will add to the monthly bill. The best figure is the one measured: what the last purchase really added (the whole
 * bill rises, because the rate climbs with the count on the tiles already held — the candidate's P5 asks for exactly this difference).
 * Otherwise the game's own charge per charged tile; otherwise the measured floor.
 */
export function marginalTileUpkeep(input: { ownedTiles: number | null; tileUpkeep?: number | null; observedMarginalUpkeep?: number | null }): number {
  const charged = input.ownedTiles === null ? 0 : Math.max(0, input.ownedTiles - FREE_MAP_TILES);
  const average = charged > 0 && typeof input.tileUpkeep === "number" && input.tileUpkeep > 0 ? (input.tileUpkeep / charged) * MARGINAL_TILE_UPKEEP_MARGIN : null;
  // The observed addition can only be larger than the average: the marginal tile costs more than the average one.
  if (typeof input.observedMarginalUpkeep === "number" && input.observedMarginalUpkeep > 0) return Math.max(input.observedMarginalUpkeep * MARGINAL_TILE_UPKEEP_MARGIN, average ?? 0);
  return average ?? MEASURED_MINIMUM_MARGINAL_TILE_UPKEEP;
}

/**
 * Whether the cash covers building outward. Without `requiredCash`: the months of spending of the early rule (kept for the modes that
 * still use it). Unknown spending is not assumed covered.
 */
export function cashCoversExpansion(input: { treasury: number | null; monthlyExpenses?: number | null; requiredCash?: number }): boolean {
  if (input.treasury === null) return false;
  if (input.requiredCash !== undefined) return input.treasury >= input.requiredCash;
  if (typeof input.monthlyExpenses !== "number" || !(input.monthlyExpenses > 0)) return true;
  return input.treasury >= EXPANSION_CASH_MONTHS * input.monthlyExpenses;
}

/**
 * FAST-growth affordability as the study states it (FAST_EXPANSION_100K_Optimization_Study_V1, "按现金跑道融资"; Bible S06/K30):
 * usable cash >= the build still to be paid for + the net cash that leaves before the build pays + a reserve for deviations. Total
 * monthly spending is NOT the yardstick: it is already netted into the monthly balance, and a city that earns more than it spends has no
 * net outflow to carry. The build itself is paid for by sizing the district to the cash (runtime: (treasury - reserve) / cost per m²).
 * The study's example takes a conservative realisation period of 2 months and gives no figure for the reserve; the 150k is the one the
 * district sizing already holds back. Both are starting values, not rules.
 */
export const RUNWAY_REALIZATION_MONTHS = 2;
/**
 * A flat yardstick of "comfortable cash" for the LOAN rules (`loan-policy.ts`: how large a loan may be, when one is repaid). It is deliberately NOT part of
 * the land rule any more: as a land gate it demanded 150,000 whatever the city's size or earnings, so a city earning 705,599 a month and holding 53,148
 * refused every tile it could easily pay for (live 2026-10-08), and it also shrank every district's batch through `capitalReserve`.
 */
export const EXPANSION_DEVIATION_RESERVE = 150_000;
/**
 * Cash the expansion itself must carry: the net outflow of `RUNWAY_REALIZATION_MONTHS` months, and nothing else. A city that earns more than it spends needs
 * no cash reserve at all — its income pays the build as it goes (the guide's rule: land is bought when the income carries the tile, one tile at a time).
 */
export function expansionCashRequired(monthlyBalance: number | null | undefined): number {
  const outflowPerMonth = typeof monthlyBalance === "number" && monthlyBalance < 0 ? -monthlyBalance : 0;
  return outflowPerMonth * RUNWAY_REALIZATION_MONTHS;
}

/**
 * Whether a tile may be bought now. Land is paid for out of the city's earnings, not its savings: the recurring cost the
 * tile adds (measured per charged tile when the game reports it) must fit inside the monthly surplus, with cash left for the
 * district on it and for the months of spending that expansion needs. `ownedTiles` null (unknown) is treated as past the free tiles.
 */
export function landPurchaseAffordable(input: { treasury: number | null; monthlyBalance: number | null; ownedTiles: number | null;
  tileUpkeep?: number | null; monthlyExpenses?: number | null; requiredCash?: number; observedMarginalUpkeep?: number | null;
  /** What the next tile is thought to cost (`#tilePriceBought`, or the game's own quote when it refused). Absent: only the surplus test is applied. */
  tilePrice?: number | null }): boolean {
  if (input.treasury === null || input.monthlyBalance === null) return false;
  const price = typeof input.tilePrice === "number" && input.tilePrice > 0 ? input.tilePrice : 0;
  // The cash pays for the tile itself...
  if (input.treasury < price) return false;
  // ...and what is left carries the city's own net outflow for `LAND_RESERVE_HOURS` (nothing at all for a city that earns more than it spends).
  const outflowPerHour = input.monthlyBalance < 0 ? -input.monthlyBalance / GAME_HOURS_PER_MONTH : 0;
  if (input.treasury - price - (input.requiredCash ?? 0) < outflowPerHour * LAND_RESERVE_HOURS) return false;
  // The surplus itself must carry the upkeep the tile adds for ever: the recurring cost is what has to fit, not the bank balance (`marginalTileUpkeep`).
  const added = marginalTileUpkeep({ ownedTiles: input.ownedTiles === null ? FREE_MAP_TILES : input.ownedTiles, tileUpkeep: input.tileUpkeep ?? null,
    observedMarginalUpkeep: input.observedMarginalUpkeep ?? null });
  return input.monthlyBalance - added >= 0;
}

/**
 * The way out of a dead end, NOT the normal rule. `landPurchaseAffordable` (K34) wants the monthly surplus to carry the tile, which is right for a city
 * that has other things to build. A young city earns almost nothing (measured live 2026-10-05: surplus +948 a month, 800k in the bank, 332 residents), so
 * K34 refuses every tile for ever; and when the land it owns is used up, the use the city needs (industry, which has to stand 400 m from every home)
 * has no site and the other uses are held, nothing at all is built: 70 of 83 cycles read LAND_FINANCE_HELD, minutes of standing still beside 800k.
 *
 * The V2 candidate's P8 asks for a cash reserve and a surplus that is not negative for K months in a row, not for a surplus that already
 * covers every purchase. So when the city is STUCK (the caller decides: nothing could be built for a while), a tile may be bought on the cash it holds:
 * the deficit it creates (its upkeep beyond the surplus) must be carried by what is left after the district reserve for `LAND_ESCAPE_RUNWAY_MONTHS`
 * months, and the same cash gates as K34 apply. The caller still buys one tile at a time and only where a district can then stand.
 */
export const LAND_ESCAPE_RUNWAY_MONTHS = 12;
export function landPurchaseRunwayAffordable(input: { treasury: number | null; monthlyBalance: number | null; ownedTiles: number | null;
  tileUpkeep?: number | null; monthlyExpenses?: number | null; requiredCash?: number; observedMarginalUpkeep?: number | null; tilePrice?: number | null }): boolean {
  if (input.treasury === null || input.monthlyBalance === null) return false;
  const price = typeof input.tilePrice === "number" && input.tilePrice > 0 ? input.tilePrice : 0;
  if (input.treasury < price) return false;
  const added = marginalTileUpkeep({ ownedTiles: input.ownedTiles === null ? FREE_MAP_TILES : input.ownedTiles, tileUpkeep: input.tileUpkeep ?? null,
    observedMarginalUpkeep: input.observedMarginalUpkeep ?? null });
  const deficitPerMonth = Math.max(0, added - input.monthlyBalance);
  // The deficit the tile creates, carried for the whole escape runway on the cash that is left after paying for the tile.
  return input.treasury - price >= deficitPerMonth * LAND_ESCAPE_RUNWAY_MONTHS;
}

/**
 * Budget changes to make now. The product never trims a service on its own (K32: a lower budget changes what a
 * service can do, it is not a discount); it only undoes a trim someone made, once the runway is comfortable.
 */
export const SOLVENCY_RESTORE_RUNWAY_MONTHS = 6;
export function solvencyBudgetPlan(input: {
  treasury: number | null;
  monthlyBalance: number | null;
  services: ReadonlyArray<{ name: string; budgetPercent: number; estimatedUpkeep: number }>;
}): Array<{ service: string; percentage: number }> {
  const runway = runwayMonths(input.treasury, input.monthlyBalance);
  if (runway === null || runway < SOLVENCY_RESTORE_RUNWAY_MONTHS) return [];
  return input.services.filter((service) => service.budgetPercent < 100).map((service) => ({ service: service.name, percentage: 100 }));
}

/**
 * Tax changes to make now: none. Tax is a demand and business lever with no proven global optimum (K31); a change
 * needs a named purpose, one area, a small step and an observation window, which is the fiscal experiment loop's job,
 * not a reflex on a short runway.
 */
export function solvencyTaxPlan(_input: {
  treasury: number | null;
  monthlyBalance: number | null;
  rates: Partial<Record<TaxArea, number>>;
}): Array<{ area: TaxArea; rate: number }> {
  return [];
}
