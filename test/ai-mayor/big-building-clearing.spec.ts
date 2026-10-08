import { describeRoom, planClearing, type ClearingBuilding } from "../../src/main/services/ai-mayor/v2/big-building-site";

const building = (id: string, x: number, z: number, half = 10): ClearingBuilding => ({ id, position: { x, z }, bounds: { minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half } });

describe("big building with no free ground: what has to come down is worked out from the footprint, never tried blind", () => {
  const footprint = { widthMeters: 60, depthMeters: 80 };
  const places = [{ center: { x: 0, z: 0 }, rotation: 0 }, { center: { x: 300, z: 0 }, rotation: 0 }];

  test("the place with the fewest buildings, all of them eligible, wins; one that holds an ineligible building is skipped", () => {
    const buildings = [building("a", -20, 0), building("b", 20, 10), building("c", 300, 0), building("keep", 330, 20)];
    const plan = planClearing({ footprint, places, target: { x: 0, z: 0 }, buildings, eligible: (entry) => entry.id !== "keep" });
    expect(plan?.center).toEqual({ x: 0, z: 0 });
    expect(plan?.blockers.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    const onlyOne = planClearing({ footprint, places, target: { x: 0, z: 0 }, buildings: [building("keep", 0, 0), building("c", 300, 0)], eligible: (entry) => entry.id !== "keep" });
    expect(onlyOne?.center).toEqual({ x: 300, z: 0 });
  });
  test("nothing is planned when every place holds something that must stay, holds nothing (it is simply free), or holds too many", () => {
    expect(planClearing({ footprint, places, target: { x: 0, z: 0 }, buildings: [building("a", 0, 0), building("b", 300, 0)], eligible: () => false })).toBeNull();
    expect(planClearing({ footprint, places, target: { x: 0, z: 0 }, buildings: [], eligible: () => true })).toBeNull();
    const crowd = Array.from({ length: 9 }, (_, i) => building(`x${i}`, -25 + (i % 3) * 25, -30 + Math.floor(i / 3) * 30, 6));
    expect(planClearing({ footprint, places: [places[0]!], target: { x: 0, z: 0 }, buildings: crowd, eligible: () => true })).toBeNull();
  });
  test("the quarter turn swaps width and depth", () => {
    const wide = { widthMeters: 120, depthMeters: 20 };
    const near = building("n", 0, 50, 5);
    expect(planClearing({ footprint: wide, places: [{ center: { x: 0, z: 0 }, rotation: 0 }], target: { x: 0, z: 0 }, buildings: [near], eligible: () => true })).toBeNull();
    expect(planClearing({ footprint: wide, places: [{ center: { x: 0, z: 0 }, rotation: 90 }], target: { x: 0, z: 0 }, buildings: [near], eligible: () => true })?.blockers).toHaveLength(1);
  });
  test("the room is said in numbers", () => {
    expect(describeRoom([{ minX: 0, minZ: 0, widthMeters: 40, heightMeters: 50 }, { minX: 100, minZ: 0, widthMeters: 70, heightMeters: 30 }], footprint)).toBe("needs 60 x 80 m (+16 m round it); the largest free ground in reach is 70 x 30 m");
  });
});