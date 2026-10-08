import { centreMatchesIntent, districtIntentFrom, intentOrder, intentNamesAPlace } from "../../src/main/services/ai-mayor/v2/district-intent";

describe("district intent: a side of the city", () => {
  const centre = { x: 0, z: 0 };
  const west = districtIntentFrom({ kind: "GOAL", type: "EXPAND_COMMERCIAL", priority: "NORMAL", scope: { direction: "W" } })!;
  test("only centres in the western sector, far enough out, match; the westernmost comes first", () => {
    expect(intentNamesAPlace(west)).toBe(true);
    expect(centreMatchesIntent({ x: -600, z: 100 }, west, centre)).toBe(true);
    expect(centreMatchesIntent({ x: -600, z: 500 }, west, centre)).toBe(true);
    expect(centreMatchesIntent({ x: 600, z: 0 }, west, centre)).toBe(false);
    expect(centreMatchesIntent({ x: 0, z: 800 }, west, centre)).toBe(false);
    expect(centreMatchesIntent({ x: -100, z: 0 }, west, centre)).toBe(false);
    const sorted = [{ x: -300, z: 0 }, { x: -900, z: 0 }, { x: -600, z: 0 }].sort(intentOrder(west, centre));
    expect(sorted.map((point) => point.x)).toEqual([-900, -600, -300]);
  });
  test("north is +z", () => {
    const north = districtIntentFrom({ kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: "NORMAL", scope: { direction: "N" } })!;
    expect(centreMatchesIntent({ x: 50, z: 700 }, north, centre)).toBe(true);
    expect(centreMatchesIntent({ x: 50, z: -700 }, north, centre)).toBe(false);
  });
});