import { keepAwayBlocks } from "../../src/main/services/ai-mayor/v2/district-land";
import { loudPoints } from "../../src/main/services/ai-mayor/v2/district-builder";

describe("homes keep clear of railways and highways (noise), with their own distance", () => {
  test("loudPoints samples only railways and highways, about every 50 m", () => {
    const points = loudPoints([{ prefab: "Double Train Track", start: { x: 0, z: 0 }, end: { x: 200, z: 0 } }, { prefab: "Medium Road", start: { x: 0, z: 50 }, end: { x: 200, z: 50 } },
      { prefab: "Highway Oneway - 2 lanes", start: { x: 0, z: 300 }, end: { x: 0, z: 400 } }]);
    expect(points.every((point) => point.z === 0 || point.x === 0)).toBe(true);
    expect(points.filter((point) => point.z === 0 && point.x >= 0 && point.x <= 200).length).toBeGreaterThanOrEqual(5);
    expect(points.some((point) => point.z === 50)).toBe(false);
  });
  test("100 m from the loud points, 320 m from industry", () => {
    const keep = { points: [{ x: 0, z: 0 }], meters: 320, also: [{ points: [{ x: 1000, z: 0 }], meters: 100 }] };
    const at = (x: number) => keepAwayBlocks(keep, (point) => Math.hypot(point.x - x, point.z));
    expect(at(500)).toBe(false);
    expect(at(200)).toBe(true);
    expect(at(1050)).toBe(true);
    expect(at(1150)).toBe(false);
  });
});