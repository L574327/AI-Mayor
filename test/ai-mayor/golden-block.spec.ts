import { fillGaps, gridCells, GOLDEN_SPACING_METERS, optimalSpacing, reserveCells, serviceLotSideMeters, serviceNeedsWholeCell, smallServiceLotSideMeters, zonedShare } from "../../src/main/services/ai-mayor/v2/golden-block";

describe("the golden block: the guide's grid", () => {
  test("x = 2W + 96: 112 m for Small Roads, and it beats the spacings around it", () => {
    expect(optimalSpacing(8)).toBe(112);
    expect(GOLDEN_SPACING_METERS).toBe(112);
    expect(zonedShare(112, 8)).toBeCloseTo(0.857, 2);
    expect(zonedShare(112, 8)).toBeGreaterThan(zonedShare(80, 8));
    expect(zonedShare(112, 8)).toBeGreaterThan(zonedShare(160, 8));
  });

  test("a 400 x 400 area holds 3 x 3 cells; the 64 m remainder is left for the gap filler", () => {
    expect(gridCells({ minX: 0, minZ: 0, maxX: 400, maxZ: 400 })).toHaveLength(9);
  });
});

describe("the golden block: the lots the game itself gives the services (live 2026-10-08, cs2_prefab_lock)", () => {
  const lot = (x: number, z: number) => ({ prefab: "P", lotCells: { x, z }, rangeMeters: null });
  test("a lot 10 x 10 cells or more on both sides takes a whole cell", () => {
    expect(serviceNeedsWholeCell(lot(10, 10))).toBe(true);
    expect(serviceNeedsWholeCell(lot(16, 25))).toBe(true);   // Cemetery01
    expect(serviceNeedsWholeCell(lot(23, 10))).toBe(true);   // Hospital01
    expect(serviceNeedsWholeCell(lot(12, 7))).toBe(false);   // PoliceStation01: 96 x 56 m, a cell's middle holds it
  });
  test("a lot longer than a cell's 104 m free middle takes a whole cell even when it is thin", () => {
    expect(serviceLotSideMeters(lot(18, 8))).toBe(144);       // ElementarySchool01
    expect(serviceNeedsWholeCell(lot(18, 8))).toBe(true);
    expect(serviceNeedsWholeCell(lot(18, 9))).toBe(true);    // BusDepot01
    expect(serviceNeedsWholeCell(lot(11, 6))).toBe(false);   // MedicalClinic01: 88 m
  });
  test("the kept middle is sized by the largest small lot that fits one (96 m, the police station)", () => {
    const real = [lot(5, 5), lot(11, 6), lot(12, 7), lot(18, 8), lot(18, 9), lot(23, 10)];
    expect(smallServiceLotSideMeters(real)).toBe(96);
    // Nothing that fits: nothing is kept.
    expect(smallServiceLotSideMeters([lot(18, 8)])).toBe(0);
  });
});

describe("the golden block: lots kept for services", () => {
  const cells = gridCells({ minX: 0, minZ: 0, maxX: 112 * 6, maxZ: 112 * 6 });
  const clinic = { prefab: "MedicalClinic01", lotCells: { x: 4, z: 4 }, rangeMeters: 250 };
  const cemetery = { prefab: "Cemetery01", lotCells: { x: 12, z: 12 }, rangeMeters: 600 };

  test("a big service takes a whole cell every ceil(range / 112) cells, inside the area; the rest is zoned", () => {
    const plan = reserveCells(cells, [clinic, cemetery]);
    expect(plan.reservedBig.length).toBeGreaterThan(0);
    expect(plan.reservedBig.every((cell) => cell.column > 0 && cell.row > 0)).toBe(true);
    expect(plan.zoned.length + plan.reservedBig.length).toBe(cells.length);
  });

  test("small services keep the middle of a cell every ceil(range / 112) cells, never in a big service's cell", () => {
    const plan = reserveCells(cells, [clinic, cemetery]);
    expect(plan.reservedSmall.length).toBeGreaterThan(0);
    expect(plan.reservedSmall[0]!.sideMeters).toBe(32);
    expect(plan.reservedSmall.some((entry) => plan.reservedBig.includes(entry.cell))).toBe(false);
  });

  test("no services read: nothing is kept, everything is zoned", () => {
    const plan = reserveCells(cells, []);
    expect(plan.reservedBig).toHaveLength(0);
    expect(plan.reservedSmall).toHaveLength(0);
    expect(plan.zoned).toHaveLength(cells.length);
  });
});

describe("the golden block: the gaps between districts are filled", () => {
  test("two grid cells or more: a mini district; a 60 m strip: one road down its middle; a scrap: left", () => {
    const gaps = fillGaps([
      { minX: 0, minZ: 0, maxX: 240, maxZ: 120 },
      { minX: 0, minZ: 500, maxX: 300, maxZ: 560 },
      { minX: 900, minZ: 900, maxX: 930, maxZ: 960 },
    ]);
    expect(gaps.miniDistricts).toHaveLength(1);
    expect(gaps.stripRoads).toEqual([{ start: { x: 0, z: 530 }, end: { x: 300, z: 530 } }]);
    expect(gaps.left).toHaveLength(1);
  });
});
