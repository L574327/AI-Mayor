import {
  DEFAULT_SERVICE_REACH_METERS,
  netsMissingService,
  scopeNeedsService,
  serviceReachByNet,
  type ServiceReachStreet,
} from "@/main/services/ai-mayor/v2/utility-service-reach";

const street = (index: number, nodeA: number, nodeB: number, x: number): ServiceReachStreet => ({
  ref: { index, version: 1 },
  startNode: { index: nodeA, version: 1 },
  endNode: { index: nodeB, version: 1 },
  start: { x, z: 0 },
  end: { x: x + 40, z: 0 },
});

describe("utility service reach over the road component", () => {
  // A chain 1-2-3-4 (district streets 1 and 3) and a separate chain 5-6.
  const streets = [street(1, 1, 2, 0), street(2, 2, 3, 40), street(3, 3, 4, 80), street(4, 5, 6, 900)];
  const district = [{ index: 1, version: 1 }, { index: 3, version: 1 }];

  it("counts a facility on the district's component as serving, however far away", () => {
    const report = netsMissingService({
      streets,
      districtStreetRefs: district,
      // 900 m away along the same chain, i.e. on street 3's component.
      facilities: [{ kind: "WATER", position: { x: 100, z: 0 } }],
    });
    expect(report.missing).not.toContain("WATER");
    expect(report.served.find((entry) => entry.kind === "WATER")?.streetRef.index).toBe(3);
    expect(report.missing).toContain("ELECTRICITY");
    expect(report.missing).toContain("SEWAGE");
  });

  it("ignores a facility on a different component, however near", () => {
    const report = netsMissingService({
      streets,
      districtStreetRefs: district,
      // The separate chain 5-6, only 20 m east of the district's first street.
      facilities: [{ kind: "WATER", position: { x: 920, z: 0 } }],
    });
    expect(report.missing).toContain("WATER");
    expect(report.served).toHaveLength(0);
  });

  it("reports every net missing when there is no facility at all", () => {
    const report = netsMissingService({ streets, districtStreetRefs: district, facilities: [] });
    expect(report.missing).toEqual(["ELECTRICITY", "WATER", "SEWAGE"]);
    expect(report.componentStreets).toBe(3);
  });

  it("names the nets that still need placing when only some are served", () => {
    const report = netsMissingService({
      streets,
      districtStreetRefs: district,
      facilities: [
        { kind: "ELECTRICITY", position: { x: 20, z: 0 } },
        { kind: "WATER", position: { x: 920, z: 0 } }, // other component
      ],
    });
    expect(report.missing).toEqual(["WATER", "SEWAGE"]);
    expect(report.served.map((entry) => entry.kind)).toEqual(["ELECTRICITY"]);
  });

  it("separates 'on my component' from 'close enough to reach me'", () => {
    // A long chain 1-2-3-4-5-6-7 along x, district on its first link, plus a
    // detached chain far east. The bound is set to 60 m so both answers are
    // decided by the fixture rather than by the production constant.
    const chain = [
      street(1, 1, 2, 0), street(2, 2, 3, 40), street(3, 3, 4, 80),
      street(4, 4, 5, 120), street(5, 5, 6, 160), street(6, 6, 7, 200),
      street(7, 8, 9, 900),
    ];
    const districtOnly = [{ index: 1, version: 1 }];

    // Same component, 180 m up the chain: the old rule says "served", the reach
    // says no. THIS is the disagreement the 2026-10-02 district measured
    // (water served from 611 m, electricity not from 1,021 m, one component).
    const same = serviceReachByNet({
      streets: chain, districtStreetRefs: districtOnly,
      facilities: [{ kind: "WATER", position: { x: 220, z: 0 } }], maxReachMeters: 60,
    });
    const far = same.nets.find((report) => report.kind === "WATER")!;
    expect(far.onComponent).toBe(true);
    expect(far.nearestEuclideanMeters).toBeGreaterThan(60);
    expect(far.withinReach).toBe(false);
    expect(same.needsPlacement).toEqual(["ELECTRICITY", "WATER", "SEWAGE"]);

    // A detached chain: neither connected nor near, so both answers agree.
    const off = serviceReachByNet({
      streets: chain, districtStreetRefs: districtOnly,
      facilities: [{ kind: "WATER", position: { x: 920, z: 0 } }], maxReachMeters: 60,
    });
    const detached = off.nets.find((report) => report.kind === "WATER")!;
    expect(detached.onComponent).toBe(false);
    expect(detached.withinReach).toBe(false);

    // And a facility on the district's own street is both.
    const on = serviceReachByNet({
      streets: chain, districtStreetRefs: districtOnly,
      facilities: [{ kind: "WATER", position: { x: 20, z: 0 } }], maxReachMeters: 60,
    });
    const own = on.nets.find((report) => report.kind === "WATER")!;
    expect(own.onComponent).toBe(true);
    expect(own.withinReach).toBe(true);
  });

  it("measures reach from the district's own streets, nearest facility first", () => {
    const report = serviceReachByNet({
      streets, districtStreetRefs: district,
      facilities: [
        { kind: "ELECTRICITY", position: { x: 900, z: 0 } },  // connected, 820 m from the district's street 1
        { kind: "ELECTRICITY", position: { x: 60, z: 0 } },   // on the district's own chain
      ],
    });
    const electricity = report.nets.find((entry) => entry.kind === "ELECTRICITY")!;
    expect(electricity.facilityIndices).toEqual([0, 1]);
    expect(electricity.nearestEuclideanMeters).toBeLessThan(DEFAULT_SERVICE_REACH_METERS);
    expect(electricity.withinReach).toBe(true);
    // The graph distance is to the street the marker attaches to, which is the
    // district's own here: 20 m along it.
    expect(electricity.nearestGraphMeters).toBeLessThan(60);
    expect(report.needsPlacement).toEqual(["WATER", "SEWAGE"]);
  });

  it("reports unreachable facilities as needing placement", () => {
    const report = serviceReachByNet({ streets, districtStreetRefs: district, facilities: [] });
    expect(report.needsPlacement).toEqual(["ELECTRICITY", "WATER", "SEWAGE"]);
    for (const entry of report.nets) {
      expect(entry.nearestEuclideanMeters).toBe(Number.POSITIVE_INFINITY);
      expect(entry.nearestGraphMeters).toBeNull();
      expect(entry.withinReach).toBe(false);
    }
  });

  // The predicate a commissioning pass reads per net. The city-level read is
  // one input to it and not the answer: measured live 2026-10-02, a district on
  // its own 66-street component read city headroom and was answered
  // `no_action_needed` while every facility of that net stood on the main
  // network 1.7 km away.
  describe("scopeNeedsService: the city's headroom is not the scope's service", () => {
    it("places a facility when the city has headroom but the scope cannot be reached", () => {
      // Both shapes of unreached: another component, and same component past
      // the reach.
      const otherComponent = scopeNeedsService({
        cityIssueActive: false, kind: "SEWAGE",
        streets, districtStreetRefs: district,
        facilities: [{ kind: "SEWAGE", position: { x: 920, z: 0 } }],
      });
      expect(otherComponent).toBe(true);

      const tooFar = scopeNeedsService({
        cityIssueActive: false, kind: "ELECTRICITY",
        streets, districtStreetRefs: district,
        facilities: [{ kind: "ELECTRICITY", position: { x: -900, z: 0 } }],
        maxReachMeters: 60,
      });
      expect(tooFar).toBe(true);
    });

    it("leaves a scope alone when a facility of that net already reaches it", () => {
      const reached = scopeNeedsService({
        cityIssueActive: false, kind: "WATER",
        streets, districtStreetRefs: district,
        facilities: [{ kind: "WATER", position: { x: 60, z: 0 } }],
      });
      expect(reached).toBe(false);
    });

    it("never turns an active city issue off", () => {
      expect(scopeNeedsService({
        cityIssueActive: true, kind: "WATER",
        streets, districtStreetRefs: district,
        facilities: [{ kind: "WATER", position: { x: 60, z: 0 } }],
      })).toBe(true);
    });

    it("does not invent a placement out of an unread world", () => {
      // Neither the scope's streets nor the city's are in the read: a failed
      // read cannot prove a facility is missing.
      expect(scopeNeedsService({
        cityIssueActive: false, kind: "WATER",
        streets: [], districtStreetRefs: district, facilities: [],
      })).toBe(false);
      expect(scopeNeedsService({
        cityIssueActive: false, kind: "WATER",
        streets, districtStreetRefs: [], facilities: [],
      })).toBe(false);
    });
  });

  it("honours a caller's net order and an empty world", () => {
    const report = netsMissingService({
      streets,
      districtStreetRefs: district,
      facilities: [],
      nets: ["WATER", "SEWAGE"],
    });
    expect(report.missing).toEqual(["WATER", "SEWAGE"]);
    expect(netsMissingService({ streets: [], districtStreetRefs: [], facilities: [] }).missing)
      .toEqual(["ELECTRICITY", "WATER", "SEWAGE"]);
  });
});
