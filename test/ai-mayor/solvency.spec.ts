import {
  CIVIC_AFFORDABLE_RUNWAY_MONTHS,
  civicIsAffordable,
  cashCoversExpansion,
  expansionCashRequired,
  landPurchaseAffordable,
  marginalTileUpkeep,
  runwayMonths,
  solvencyBudgetPlan,
  solvencyTaxPlan,
} from "../../src/main/services/ai-mayor/v2/solvency";

describe("solvency (skill.S06)", () => {
  test("growth cash is the net outflow of the realisation window, not a fixed reserve: an earning city needs none", () => {
    // An earning city has no net outflow to carry (the flat 150,000 that used to be added here pinned a profitable city's land and district sizing down).
    expect(expansionCashRequired(128_702)).toBe(0);
    expect(expansionCashRequired(0)).toBe(0);
    // A losing city carries its outflow through the realisation period (2 months in the study's example).
    expect(expansionCashRequired(-100_000)).toBe(2 * 100_000);
    expect(expansionCashRequired(null)).toBe(0);
    // Measured live: 308k in the treasury against 1.04M of monthly spending, earning 128k a month: building goes on.
    expect(cashCoversExpansion({ treasury: 308_000, monthlyExpenses: 1_036_808, requiredCash: expansionCashRequired(128_702) })).toBe(true);
    expect(cashCoversExpansion({ treasury: 308_000, monthlyExpenses: 1_036_808 })).toBe(false);
    // A city losing 100k a month carries 200k of it over the realisation window: 100k does not cover it, 250k does.
    expect(cashCoversExpansion({ treasury: 100_000, requiredCash: expansionCashRequired(-100_000) })).toBe(false);
    expect(cashCoversExpansion({ treasury: 250_000, requiredCash: expansionCashRequired(-100_000) })).toBe(true);
  });
  test("runway is infinite for a surplus, unknown stays unknown", () => {
    expect(runwayMonths(100, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(runwayMonths(169_688, -121_759)).toBeCloseTo(1.39, 2);
    expect(runwayMonths(null, -5)).toBeNull();
  });

  test("a short runway never moves taxes on its own: a tax change needs a purpose and a measured experiment (K31)", () => {
    const rates = { Residential: 10, Commercial: 10, Industrial: 10, Office: 10 };
    expect(solvencyTaxPlan({ treasury: 169_688, monthlyBalance: -121_759, rates })).toEqual([]);
    expect(solvencyTaxPlan({ treasury: 1000, monthlyBalance: -10_000, rates })).toEqual([]);
  });

  test("services are never trimmed automatically (K32); a trim someone made is undone once the runway is comfortable", () => {
    const services = [
      { name: "Water & Sewage", budgetPercent: 100, estimatedUpkeep: 60_800 },
      { name: "Health & Deathcare", budgetPercent: 100, estimatedUpkeep: 48_050 },
    ];
    expect(solvencyBudgetPlan({ treasury: 169_688, monthlyBalance: -121_759, services })).toEqual([]);
    const trimmed = services.map((service) => ({ ...service, budgetPercent: 50 }));
    expect(solvencyBudgetPlan({ treasury: 900_000, monthlyBalance: 5_000, services: trimmed }).map((change) => change.percentage)).toEqual([100, 100]);
    expect(solvencyBudgetPlan({ treasury: 300_000, monthlyBalance: -60_000, services: trimmed })).toEqual([]);
  });

  test("land is bought out of earnings: the surplus must cover a tile's upkeep, the cash must pay for the tile, and the city's own outflow sets the buffer (K34)", () => {
    // A saved city with a deficit never buys, however much cash it holds.
    expect(landPurchaseAffordable({ treasury: 265_000, monthlyBalance: -94_000, ownedTiles: 9 })).toBe(false);
    // A new city with cash but no income has no surplus to carry the upkeep either.
    expect(landPurchaseAffordable({ treasury: 1_000_000, monthlyBalance: 0, ownedTiles: 9 })).toBe(false);
    expect(landPurchaseAffordable({ treasury: 1_000_000, monthlyBalance: 19_999, ownedTiles: 9 })).toBe(false);
    expect(landPurchaseAffordable({ treasury: 1_000_000, monthlyBalance: 20_000, ownedTiles: 9 })).toBe(true);
    // 50,000 of cash with 50,000 a month of surplus is enough. The flat 100,000/150,000 reserve that used to refuse this held the city's own money back:
    // live 2026-10-08, treasury 53,148, monthly balance +705,599, 21 tiles owned, and every tile refused for hours on end.
    expect(landPurchaseAffordable({ treasury: 50_000, monthlyBalance: 50_000, ownedTiles: 9 })).toBe(true);
    expect(landPurchaseAffordable({ treasury: null, monthlyBalance: 50_000, ownedTiles: 9 })).toBe(false);
    // Unknown tile count is treated as past the free tiles.
    expect(landPurchaseAffordable({ treasury: 1_000_000, monthlyBalance: 5_000, ownedTiles: null })).toBe(false);
    // The game's own figure replaces the constant once tiles are being charged: 11 tiles at 41,852 a month is 20.9k each, ×1.25.
    expect(marginalTileUpkeep({ ownedTiles: 11, tileUpkeep: 41_852 })).toBeCloseTo(26_157.5, 0);
    expect(landPurchaseAffordable({ treasury: 1_000_000, monthlyBalance: 26_000, ownedTiles: 11, tileUpkeep: 41_852 })).toBe(false);
    expect(landPurchaseAffordable({ treasury: 1_000_000, monthlyBalance: 27_000, ownedTiles: 11, tileUpkeep: 41_852 })).toBe(true);
    // What the next tile is thought to cost must be payable, and what is left covers the city's own outflow for the buffer hours — none at all for a city
    // that earns more than it spends (the old rule wanted three times the last tile's price: 347,070 against a 115,790 tile).
    expect(landPurchaseAffordable({ treasury: 100_000, monthlyBalance: 200_000, ownedTiles: 9, tilePrice: 115_790 })).toBe(false);
    expect(landPurchaseAffordable({ treasury: 150_000, monthlyBalance: 200_000, ownedTiles: 9, tilePrice: 115_790 })).toBe(true);
    // Total monthly spending is not the yardstick either (it is already netted into the balance): the runway rule is kept for the modes that still use it.
    expect(cashCoversExpansion({ treasury: 172_000, monthlyExpenses: 286_000 })).toBe(false);
    expect(cashCoversExpansion({ treasury: 900_000, monthlyExpenses: 286_000 })).toBe(true);
  });

  test("a civic building is added only when the treasury can carry it", () => {
    expect(civicIsAffordable(169_688, -121_759)).toBe(false);
    expect(civicIsAffordable(500_000, -40_000)).toBe(true);
    expect(civicIsAffordable(500_000, -60_000)).toBe(CIVIC_AFFORDABLE_RUNWAY_MONTHS <= 500_000 / 60_000);
    expect(civicIsAffordable(null, null)).toBe(false);
  });
});

