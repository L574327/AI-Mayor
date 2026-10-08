import {
  buildLandMask,
  composeBlocks,
  maximalRectangles,
  rectangleIsFree,
  shrunkVariants,
  slopePercentAround,
  type LandMask,
} from "../../src/main/services/ai-mayor/v2/district-land";

const flatTerrain = (size: number, cellMeters: number, mutate?: (heights: number[], waterDepths: number[], resolution: number) => void) => {
  const heights = new Array<number>(size * size).fill(100);
  const waterDepths = new Array<number>(size * size).fill(0);
  mutate?.(heights, waterDepths, size);
  return { resolution: size, bounds: { minX: 0, minZ: 0, maxX: size * cellMeters, maxZ: size * cellMeters }, cellSize: { x: cellMeters, z: cellMeters },
    heights, waterDepths, groundWater: [], groundWaterPollution: [], windSpeed: [] };
};
const mask = (terrain: ReturnType<typeof flatTerrain>, overrides: Partial<Parameters<typeof buildLandMask>[0]> = {}): LandMask =>
  buildLandMask({ origin: { x: 0, z: 0 }, bounds: { minX: 0, minZ: 0, maxX: 800, maxZ: 800 }, isOwned: () => true, terrain, edges: [], buildings: [],
    clearanceMeters: 12, ...overrides });

describe("district land: the ground as free lattice cells", () => {
  test("flat dry owned land is all free; the lattice is the city's own", () => {
    const m = mask(flatTerrain(40, 20));
    expect(m.columns).toBe(20);
    expect(m.rows).toBe(20);
    expect(m.free.every((cell) => cell === 1)).toBe(true);
  });

  test("water, mountains, roads, buildings and foreign land are not free; a gentle slope is", () => {
    const lake = mask(flatTerrain(40, 20, (_h, water, n) => { for (let row = 0; row < 10; row += 1) for (let col = 0; col < 10; col += 1) water[row * n + col] = 2; }));
    expect(lake.free[0]).toBe(0);
    expect(lake.free[19 * 20 + 19]).toBe(1);
    const gentle = mask(flatTerrain(40, 20, (heights, _w, n) => { for (let row = 0; row < n; row += 1) for (let col = 0; col < n; col += 1) heights[row * n + col] = 100 + col * 2; }));
    expect(gentle.free.every((cell) => cell === 1)).toBe(true);
    const mountain = mask(flatTerrain(40, 20, (heights, _w, n) => { for (let row = 0; row < n; row += 1) for (let col = 0; col < n; col += 1) heights[row * n + col] = 100 + col * 20; }));
    expect(mountain.free.some((cell) => cell === 1)).toBe(false);
    const road = mask(flatTerrain(40, 20), { edges: [{ start: { x: 400, y: 0, z: 0 }, end: { x: 400, y: 0, z: 800 }, deleted: false, temp: false } as never] });
    expect(road.free[5 * 20 + 10]).toBe(0);
    expect(road.free[5 * 20 + 3]).toBe(1);
    const building = mask(flatTerrain(40, 20), { buildings: [{ x: 100, z: 100 }] });
    expect(building.free[2 * 20 + 2]).toBe(0);
    const foreign = mask(flatTerrain(40, 20), { isOwned: (point) => point.x < 400 });
    expect(foreign.free[0]).toBe(1);
    expect(foreign.free[19]).toBe(0);
  });

  test("unreadable ground is not assumed to be land", () => {
    const m = buildLandMask({ origin: { x: 0, z: 0 }, bounds: { minX: 0, minZ: 0, maxX: 800, maxZ: 800 }, isOwned: () => true,
      terrain: flatTerrain(10, 20), edges: [], buildings: [], clearanceMeters: 12 });
    expect(m.free[19 * 20 + 19]).toBe(0);
    expect(m.free[0]).toBe(1);
  });

  test("isolation keeps cells away from what they must not touch", () => {
    const m = mask(flatTerrain(40, 20), { keepAway: { points: [{ x: 0, z: 0 }], meters: 200 } });
    expect(m.free[0]).toBe(0);
    expect(m.free[19 * 20 + 19]).toBe(1);
  });

  test("slope is measured around a point", () => {
    expect(slopePercentAround(flatTerrain(10, 20), { x: 100, z: 100 }, 20)).toBe(0);
  });
});

describe("district land: maximal rectangles", () => {
  const grid = (rows: string[]): LandMask => ({ origin: { x: 0, z: 0 }, spacing: 40, columns: rows[0]!.length, rows: rows.length,
    free: Uint8Array.from(rows.join("").split("").map((cell) => (cell === "#" ? 1 : 0))) });

  test("the biggest rectangle comes first, and a rectangle is a rectangle rather than a square", () => {
    const m = grid([
      "##########",
      "##########",
      "##########",
      "##########",
      "..........",
      "..######..",
      "..######..",
      "..######..",
      "..######..",
      "..######..",
    ]);
    const [first, second] = maximalRectangles(m);
    expect(first).toEqual({ minX: 0, minZ: 0, widthMeters: 400, heightMeters: 160 });
    expect(second).toEqual({ minX: 80, minZ: 200, widthMeters: 240, heightMeters: 200 });
  });

  test("an L-shaped coast splits into rectangles, each maximal", () => {
    const m = grid([
      "######....",
      "######....",
      "######....",
      "######....",
      "##########",
      "##########",
      "##########",
      "##########",
    ]);
    const found = maximalRectangles(m);
    const areas = found.map((rectangle) => rectangle.widthMeters * rectangle.heightMeters);
    expect(Math.max(...areas)).toBe(240 * 320);
    expect(found.some((rectangle) => rectangle.widthMeters === 400 && rectangle.heightMeters === 160)).toBe(true);
  });

  test("land too narrow for a two-block grid yields nothing", () => {
    expect(maximalRectangles(grid(["###", "###", "###", "###", "###", "###"]))).toEqual([]);
  });

  test("a rectangle is free only when all its cells are; a refused one comes back a little smaller", () => {
    const m = grid(["####", "####", "####", "####", "####", "####"]);
    expect(rectangleIsFree(m, { minX: 0, minZ: 0, widthMeters: 160, heightMeters: 240 })).toBe(true);
    expect(rectangleIsFree(m, { minX: 0, minZ: 0, widthMeters: 200, heightMeters: 240 })).toBe(false);
    const variants = shrunkVariants({ minX: 0, minZ: 0, widthMeters: 800, heightMeters: 600 });
    expect(variants).toHaveLength(4);
    expect(variants.every((variant) => variant.widthMeters * variant.heightMeters < 800 * 600)).toBe(true);
    expect(shrunkVariants({ minX: 0, minZ: 0, widthMeters: 160, heightMeters: 160 })).toEqual([]);
  });
});

describe("district land: block widths", () => {
  test("composes 120 m and 160 m blocks, balanced, and shortens a total no mix reaches", () => {
    expect(composeBlocks(400)).toEqual([120, 160, 120]);
    expect(composeBlocks(560)).toEqual([120, 160, 120, 160]);
    expect(composeBlocks(240)).toEqual([120, 120]);
    expect(composeBlocks(200)).toEqual([160]);
    expect(composeBlocks(1120)?.reduce((sum, value) => sum + value, 0)).toBe(1120);
    expect(composeBlocks(80)).toBeNull();
    for (const width of [320, 360, 440, 480, 680, 920, 1480]) {
      expect(composeBlocks(width)?.reduce((sum, value) => sum + value, 0)).toBe(width);
    }
  });
});
