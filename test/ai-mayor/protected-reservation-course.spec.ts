import { protectedReservationCrossedBy } from "../../src/main/services/ai-mayor/v2/project-admission";

const reservation = (ref: string, x: number, z: number, radius: number) =>
  ({ ref, scope: { center: { x, z }, radius } }) as never;

describe("protectedReservationCrossedBy", () => {
  // Measured live (run-s1): a corridor hop toward an orphan stub crossed a held tranche reservation and the whole
  // Goal closed 15 times. The orphan-reconnection search must see the same answer the child step will give.
  const hop = { start: { x: 0, z: 0 }, end: { x: 100, z: 0 } };

  test("names the reservation a course passes through, at any of its five sample points", () => {
    expect(protectedReservationCrossedBy(hop, [reservation("mid", 50, 5, 10)])?.ref).toBe("mid");
    expect(protectedReservationCrossedBy(hop, [reservation("end", 100, 0, 1)])?.ref).toBe("end");
  });

  test("a course clear of every reservation crosses none", () => {
    expect(protectedReservationCrossedBy(hop, [reservation("far", 50, 80, 10)])).toBeNull();
    expect(protectedReservationCrossedBy(hop, [])).toBeNull();
  });
});
