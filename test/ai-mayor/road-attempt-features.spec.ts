import { isStraightContinuationOfDeadEnd, roadAttemptFeatures, streetSegments, type Segment } from "../../src/main/services/ai-mayor/v2/road-attempt-features";

const seg = (x1: number, z1: number, x2: number, z2: number): Segment => ({ start: { x: x1, z: z1 }, end: { x: x2, z: z2 } });

describe("road attempt features: what a street attempt looks like against the streets there", () => {
  test("a course leaving a node along a street that already leaves it is on the same ray; one leaving the other way is not", () => {
    const streets = [seg(0, 0, 0, 120)];
    // Same ray: out of (0,0) along +z, where a street already leaves.
    expect(roadAttemptFeatures(seg(0, 0, 0, 40), streets)).toMatchObject({ startRayDegrees: 0, startDegree: 1, overlapMeters: 40 });
    // Opposite ray from the same node: free (the Bridge certifies "same axis, other direction").
    expect(roadAttemptFeatures(seg(0, 0, 0, -40), streets).startRayDegrees).toBe(180);
    // At right angles.
    expect(roadAttemptFeatures(seg(0, 0, 40, 0), streets)).toMatchObject({ startRayDegrees: 90, overlapMeters: 0, crossings: 0, axis: "h" });
  });

  test("it counts crossings of other streets and a start on the inside of a street", () => {
    const streets = [seg(0, 0, 0, 120), seg(-40, 60, 40, 60)];
    expect(roadAttemptFeatures(seg(-40, 20, 40, 20), streets).crossings).toBe(1);
    const onStreet = roadAttemptFeatures(seg(0, 60, 40, 90), [seg(0, 0, 0, 120)]);
    expect(onStreet.startOnStreet).toBe(true);
    expect(onStreet.axis).toBe("d");
  });

  test("only one block straight on from a single street's dead end is held back; longer ones and turned ones are submitted", () => {
    const deadEnd = [seg(-120, 0, 0, 0)];
    expect(isStraightContinuationOfDeadEnd(roadAttemptFeatures(seg(0, 0, 40, 0), deadEnd))).toBe(true);
    // Longer straight continuations were accepted as often as refused: not filtered.
    expect(isStraightContinuationOfDeadEnd(roadAttemptFeatures(seg(0, 0, 160, 0), deadEnd))).toBe(false);
    // Turned 5 degrees (certified by the game's dry run), at a right angle, or from a free point: not filtered.
    expect(isStraightContinuationOfDeadEnd(roadAttemptFeatures(seg(0, 0, 40, 3.5), deadEnd))).toBe(false);
    expect(isStraightContinuationOfDeadEnd(roadAttemptFeatures(seg(0, 0, 0, 40), deadEnd))).toBe(false);
    expect(isStraightContinuationOfDeadEnd(roadAttemptFeatures(seg(0, 0, 40, 0), []))).toBe(false);
    // A junction (two streets leave the point) is not a dead end.
    expect(isStraightContinuationOfDeadEnd(roadAttemptFeatures(seg(0, 0, 40, 0), [...deadEnd, seg(0, 0, 0, 80)]))).toBe(false);
  });

  test("street geometry comes from the nodes, not from the trimmed edge ends", () => {
    const a = { entity: { index: 1, version: 1 }, position: { x: 0, y: 0, z: 0 } };
    const b = { entity: { index: 2, version: 1 }, position: { x: 0, y: 0, z: 100 } };
    const edge = { entity: { index: 3, version: 1 }, startNode: a.entity, endNode: b.entity, start: { x: 0, y: 0, z: 12 }, end: { x: 0, y: 0, z: 88 }, prefab: "Medium Road" };
    expect(streetSegments({ nodes: [a, b] as never, edges: [edge] as never })).toEqual([{ start: { x: 0, z: 0 }, end: { x: 0, z: 100 } }]);
  });
});
