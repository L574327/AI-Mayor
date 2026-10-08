import {
  allocateByDeficit,
  assignDistrictSpots,
  categoryOfZoneName,
  emptyMix,
  mixDeficits,
  targetShares,
  unrealizedShare,
  type ZoningMixSignals,
} from "../../src/main/services/ai-mayor/v2/zoning-mix";

/** The measured live state: 86% homes (nine in ten medium-density cells empty), 3% shops, no offices, industry 10%. */
const measured = (): ZoningMixSignals => ({
  cells: { residential: { zoned: 15_127, empty: 9_131 }, commercial: { zoned: 581, empty: 34 }, office: { zoned: 0, empty: 0 }, industrial: { zoned: 1_796, empty: 433 } },
  demand: { residential: 100, commercial: 100, office: 100, industrial: 0 },
});

describe("zoning mix: the prior corrected by the world", () => {
  test("a city with no readings gets the prior", () => {
    const shares = targetShares({ ...emptyMix(), demand: { residential: 100, commercial: 100, office: 100, industrial: 100 } });
    expect(shares.residential).toBeCloseTo(0.5, 5);
    expect(shares.commercial).toBeCloseTo(0.2, 5);
    expect(shares.office).toBeCloseTo(0.15, 5);
    expect(shares.industrial).toBeCloseTo(0.15, 5);
  });

  test("the measured city is short of shops and offices and long on housing it has not filled", () => {
    const deficits = mixDeficits(measured());
    expect(deficits.commercial).toBeGreaterThan(0.2);
    expect(deficits.office).toBeGreaterThan(0.15);
    expect(deficits.residential).toBeLessThan(-0.3);
    expect(deficits.industrial).toBeLessThan(0);
    expect(unrealizedShare(measured(), "residential")).toBeGreaterThan(0.5);
  });

  test("zoning that already stands empty is not added to, whatever the demand says", () => {
    const empty = measured();
    empty.cells.residential.empty = empty.cells.residential.zoned;
    const full = measured();
    full.cells.residential.empty = 0;
    expect(targetShares(empty).residential).toBeLessThan(targetShares(full).residential);
  });

  test("a use nobody asks for keeps a floor and is never zoned out of the city", () => {
    expect(targetShares(measured()).industrial).toBeGreaterThan(0);
  });

  test("zone types are told apart by name, offices before housing", () => {
    expect(categoryOfZoneName("EU Residential Medium Row")).toBe("residential");
    expect(categoryOfZoneName("EU Commercial Low")).toBe("commercial");
    expect(categoryOfZoneName("Office Low")).toBe("office");
    expect(categoryOfZoneName("Industrial Manufacturing")).toBe("industrial");
    expect(categoryOfZoneName("Park")).toBeNull();
  });
});

describe("zoning mix: only what the game lets the city zone", () => {
  test("a land use that is not unlocked holds no share; the others divide the whole", () => {
    const shares = targetShares(measured(), ["residential", "commercial"]);
    expect(shares.office).toBe(0);
    expect(shares.industrial).toBe(0);
    expect(shares.residential + shares.commercial).toBeCloseTo(1, 5);
    expect(mixDeficits(measured(), ["residential", "commercial"]).office).toBeLessThan(0.01);
    const categories = assignDistrictSpots(Array.from({ length: 100 }, (_, index) => ({ onRing: index % 4 === 0 })), false, measured(), ["residential", "commercial"]);
    expect(categories.includes("office")).toBe(false);
    expect(categories.filter((category) => category === "commercial").length).toBeGreaterThan(5);
  });
});

describe("zoning mix: allocation", () => {
  test("splits spots in proportion to the deficits and conserves the count", () => {
    const allocation = allocateByDeficit(100, { residential: -0.4, commercial: 0.3, office: 0.1, industrial: -0.1 }, ["residential", "commercial", "office"]);
    expect(allocation.commercial + allocation.office + allocation.residential).toBe(100);
    expect(allocation.commercial).toBe(75);
    expect(allocation.office).toBe(25);
    expect(allocation.residential).toBe(0);
  });

  test("with no use in deficit the spots go to the least over-supplied one", () => {
    const allocation = allocateByDeficit(10, { residential: -0.1, commercial: -0.3, office: -0.2, industrial: 0 }, ["residential", "commercial", "office"]);
    expect(allocation.residential).toBe(10);
  });
});

describe("zoning mix: a new district", () => {
  const spots = Array.from({ length: 200 }, (_, index) => ({ onRing: index % 4 === 0 }));

  test("homes inside, shops and offices on the outer faces, in the measured shortfall's proportion", () => {
    const categories = assignDistrictSpots(spots, false, measured());
    expect(categories).toHaveLength(200);
    categories.forEach((category, index) => { if (category !== "residential") expect(spots[index]!.onRing).toBe(true); });
    expect(categories.filter((category) => category === "commercial").length).toBeGreaterThan(5);
    expect(categories.filter((category) => category === "office").length).toBeGreaterThan(5);
    expect(categories.filter((category) => category === "industrial")).toHaveLength(0);
  });

  test("an industrial district is industrial throughout", () => {
    expect(new Set(assignDistrictSpots(spots, true, measured()))).toEqual(new Set(["industrial"]));
  });

  test("shops are spread along the ring, not laid in one run", () => {
    const categories = assignDistrictSpots(spots, false, measured());
    const ringIndexes = categories.map((category, index) => ({ category, index })).filter((entry) => spots[entry.index]!.onRing);
    const firstShops = ringIndexes.filter((entry) => entry.category === "commercial").slice(0, 3).map((entry) => entry.index);
    expect(firstShops[1]! - firstShops[0]!).toBeGreaterThan(4);
  });
});
