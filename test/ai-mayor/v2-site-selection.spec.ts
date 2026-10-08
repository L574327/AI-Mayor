import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../../src/main/services/ai-mayor/spatial/world-scanner";
import { boundedZoningCellSetInNativeMarquee, classifyGrowableFrontageAbsence, evaluateBoundedStarterSites, growableFrontageCells, hasZoneableCellInNativeMarquee, selectAvailableStarterRoadPrefab, selectBoundedGate1Sites, selectBoundedStarterSiteAnchors, selectGoalWorkOrderSiteAnchors, selectGrowableFrontageFootprint } from "../../src/main/services/ai-mayor/v2/site-selection";
import type { SpatialSiteDetail } from "../../src/main/services/ai-mayor/spatial/types";

const scan = (owned: boolean, diagonal = false) => parseSpatialBootstrapScan({
  world: { min: -200, max: 200, size: 400 },
  tiles: [{ entity: { index: 1, version: 1 }, owned, bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } }, center: { x: 0, z: 0 }, polygon: [] }],
  outsideConnections: [], bootstrapAssets: [],
  roadGraph: {
    truncated: false,
    nodes: [
      { entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
      { entity: { index: 11, version: 1 }, position: { x: diagonal ? -30 : 30, y: 0, z: diagonal ? -30 : 0 }, native: true, outsideConnection: false, roadDegree: 1 },
    ],
    edges: [{ entity: { index: 20, version: 1 }, prefab: "Small Road", native: true, startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 }, start: { x: 0, z: 0 }, end: { x: diagonal ? -30 : 30, z: diagonal ? -30 : 0 }, length: diagonal ? 42.4 : 30 }],
  },
});

const detail = (overrides: Partial<SpatialSiteDetail> = {}): SpatialSiteDetail => ({
  center: { x: 20, z: 0 }, radius: 96,
  terrain: { resolution: 2, bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 }, cellSize: { x: 100, z: 100 }, heights: [0, 0, 0, 0], waterDepths: [0, 0, 0, 0], groundWater: [0, 0, 0, 0], groundWaterPollution: [0, 0, 0, 0], windSpeed: [0, 0, 0, 0] },
  roadGraph: { nodes: [], edges: [{ entity: { index: 20, version: 1 }, prefab: "Small Road", native: true, startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 }, start: { x: 0, z: 0 }, end: { x: 30, z: 0 }, length: 30 }] },
  buildings: [],
  zoningCells: [{ block: { index: 30, version: 1 }, index: 0, position: { x: 20, y: 0, z: 0 }, visible: true, roadside: true, occupied: false, blocked: false, overridden: false, zoneType: 0, zoneCategory: "none" }],
  ...overrides,
});

const input = (world: ReturnType<typeof buildSpatialWorldModel>, siteDetail: SpatialSiteDetail, projectScope?: { center: { x: number; z: number }; radius: number }) => ({ world, details: [{ anchor: { x: 0, z: 0 }, detail: siteDetail }], projectScope });

describe("V2 bounded Gate1 site selection", () => {
  /**
   * The category a Goal asked for travels unchanged.
   *
   * `requestedZoneCategory` used to answer `undefined` for office, which dropped
   * the Goal's own requirement on the floor. It is not the world's limit: the
   * scan has always carried `office` in a zoning cell's `zoneCategory`.
   */
  test("every zone category the product plans for is passed through unchanged", async () => {
    const { requestedZoneCategory } = await import("../../src/main/services/ai-mayor/v2/site-selection");
    for (const category of ["residential", "commercial", "industrial", "office"] as const) {
      expect(requestedZoneCategory(category)).toBe(category);
    }
  });

  test("an empty zoning census proves neither frontage nor an executable footprint", () => {
    const missing = detail({ zoningCells: [] });
    const target = { center: { x: 0, z: 0 }, radius: 28 };
    expect(hasZoneableCellInNativeMarquee(missing, target)).toBe(false);
    expect(boundedZoningCellSetInNativeMarquee(missing, target)).toBeNull();
  });

  test("marquee-corner free cells count as zoneable frontage outside the inscribed circle", () => {
    const corner = detail({ center: { x: 0, z: 0 }, zoningCells: [{
      ...detail().zoningCells[0]!, position: { x: 26, y: 0, z: 26 },
    }] });
    expect(Math.hypot(26, 26)).toBeGreaterThan(28);
    expect(hasZoneableCellInNativeMarquee(corner, { center: { x: 0, z: 0 }, radius: 28 })).toBe(true);
  });

  /**
   * Frontage is not the zoning step's question, and the difference decides
   * whether a tranche can be zoned at all.
   *
   * Native Zone Apply is a marquee: it selects every visible cell centre inside a
   * square, and the authorization must span all of them. A reservation whose
   * CENTRE sits on a blocked cell therefore has no usable radius however much
   * free land it contains further out. Measured live (2026-09-29) on the
   * electricity Goal's admitted target, which is exactly this fixture: the five
   * free cells sat in the 21-28 m ring and the nearest cell to the centre was
   * `none, blocked` at 3.34 m, so the tranche paid for its road and died at
   * `GATE1_ZONING_NO_BOUNDED_RESIDENTIAL_CELL_SET`.
   */
  test("a reservation whose centre is blocked is not zoneable however much free land surrounds it", () => {
    const target = { center: { x: 0, z: 0 }, radius: 28 };
    const at = (x: number, z: number, zoneCategory: string, blocked = false) => ({
      ...detail().zoningCells[0]!, index: 0, position: { x, y: 0, z },
      zoneCategory, blocked, occupied: false, overridden: false, visible: true,
    });
    const blockedCentre = detail({ center: { x: 0, z: 0 }, zoningCells: [
      at(3.34, 0, "none", true),
      ...[[-26, 0], [26, 0], [0, -26], [0, 26], [-24, 12]].map(([x, z]) => at(x, z, "none")),
    ] });
    // The weaker predicate still says yes: free land does lie inside the box.
    expect(hasZoneableCellInNativeMarquee(blockedCentre, target)).toBe(true);
    // The zoning step's own predicate says no, and that is the one that decides.
    expect(boundedZoningCellSetInNativeMarquee(blockedCentre, target)).toBeNull();

    const cleanCentre = detail({ center: { x: 0, z: 0 }, zoningCells: [
      at(0, 0, "none"), at(3.34, 0, "none"),
    ] });
    expect(boundedZoningCellSetInNativeMarquee(cleanCentre, target)).not.toBeNull();
  });

  test("rejects the observed contiguous 1x2 parcel when neither cell has roadside frontage", () => {
    const target = { center: { x: 0, z: 0 }, radius: 28 };
    const cells = [
      { ...detail().zoningCells[0]!, block: { index: 71, version: 1 }, index: 8,
        position: { x: 0, y: 0, z: 0 }, roadside: false },
      { ...detail().zoningCells[0]!, block: { index: 71, version: 1 }, index: 14,
        position: { x: 0.6, y: 0, z: 8 }, roadside: false, roadRight: false },
    ];
    const parcel = detail({ center: target.center, zoningCells: cells });

    expect(hasZoneableCellInNativeMarquee(parcel, target)).toBe(true);
    expect(boundedZoningCellSetInNativeMarquee(parcel, target)).toBeNull();
  });

  test("requires a connected roadside-backed native footprint for every growable zone family", () => {
    const target = { center: { x: 0, z: 0 }, radius: 28 };
    const connected = detail({ center: target.center, zoningCells: [
      { ...detail().zoningCells[0]!, index: 4, position: { x: 0, y: 0, z: 0 }, roadside: true },
      { ...detail().zoningCells[0]!, index: 5, position: { x: 0, y: 0, z: 8 }, roadside: false },
    ] });
    const disconnected = detail({ center: target.center, zoningCells: [
      { ...detail().zoningCells[0]!, index: 4, position: { x: 0, y: 0, z: 0 }, roadside: true },
      { ...detail().zoningCells[0]!, index: 5, position: { x: 8, y: 0, z: 8 }, roadside: false },
    ] });

    for (const family of ["residential", "commercial", "industrial"] as const) {
      expect(boundedZoningCellSetInNativeMarquee(connected, target, family)).not.toBeNull();
      expect(boundedZoningCellSetInNativeMarquee(disconnected, target, family)).toBeNull();
    }
  });

  test.each(["residential", "commercial", "industrial", "office"] as const)(
    "shared fast path takes a normal continuous %s strip from Zone Block side bits even when roadside is unset", (zoneCategory) => {
    const cells = Array.from({ length: 12 }, (_, index) => ({
      ...detail().zoningCells[0]!, block: { index: 71, version: 1 }, index,
      position: { x: 0, y: 0, z: index * 8 }, roadside: false,
      roadRight: index === 0, occupied: false, blocked: false, overridden: false, zoneCategory: "none" as const,
    }));
    const candidates = selectGrowableFrontageFootprint({
      detail: detail({ center: { x: 0, z: 0 }, zoningCells: cells }), zoneCategory,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.evidence.openResidentialCells).toBeGreaterThanOrEqual(6);
    expect(candidates[0]!.evidence.frontage).toBe(true);
  });

  test("fast path refuses the incidental 1x2 fragment", () => {
    const cells = [0, 1].map((index) => ({ ...detail().zoningCells[0]!, index,
      position: { x: 0, y: 0, z: index * 8 }, roadside: true, zoneCategory: "none" as const }));
    expect(selectGrowableFrontageFootprint({ detail: detail({ zoningCells: cells }), zoneCategory: "residential" })).toEqual([]);
  });

  /**
   * Four worlds answer "no footprint", and only one of them is a Road problem.
   * Reporting them all as missing frontage is what made the Brain raise a
   * `ROAD_FRONTAGE` prerequisite against land that already had frontage and
   * already carried an executable footprint — a work order that can only fail,
   * re-derived every tick because the family park was keyed on volatile facts.
   * Measured live (2026-09-30): the live census held four valid, owned,
   * in-band footprints and the classification said "no productive Road
   * frontage" because a stale reservation covered all four.
   */
  describe("why the Growable Fast Path found no footprint", () => {
    const strip = (count: number, roadside: (index: number) => boolean,
      position: (index: number) => { x: number; z: number } = (index) => ({ x: 20, z: index * 8 })) =>
      Array.from({ length: count }, (_, index) => ({ ...detail().zoningCells[0]!, block: { index: 72, version: 1 }, index,
        position: { ...position(index), y: 0 }, roadside: roadside(index),
        occupied: false, blocked: false, overridden: false, zoneCategory: "none" as const }));

    test("no roadside cell anywhere is a missing-frontage finding, so a Road is the answer", () => {
      const absent = detail({ zoningCells: strip(12, () => false) });
      expect(growableFrontageCells(absent)).toEqual([]);
      expect(classifyGrowableFrontageAbsence({ detail: absent, zoneCategory: "residential" }))
        .toMatchObject({ reason: "MISSING_FRONTAGE", frontageCells: 0 });
    });

    test("frontage that cannot seed a large enough marquee is a land finding, not a Road one", () => {
      // One roadside cell carrying a three-cell strip: frontage exists, and no
      // radius reaches the six cells the Fast Path requires. Native zoning only
      // recolours existing cells, so no Road can close that gap.
      const short = detail({ zoningCells: strip(3, (index) => index === 0) });
      expect(growableFrontageCells(short)).toHaveLength(1);
      expect(selectGrowableFrontageFootprint({ detail: short, zoneCategory: "residential" })).toEqual([]);
      expect(classifyGrowableFrontageAbsence({ detail: short, zoneCategory: "residential" }))
        .toMatchObject({ reason: "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT", frontageCells: 1,
          unprotectedFootprints: 0, ownedFootprints: 0 });
    });

    test("in-band land with no road near it is missing frontage, not a land finding", () => {
      // The live shape, measured 2026-10-01: one small strip that does carry
      // frontage, and a block of free owned unzoned cells 40 m away that
      // carries none. `selectGrowableFrontageFootprint` can only seed a marquee
      // on a frontage cell, so the block is invisible to it although a marquee
      // there reaches the six cells the Fast Path requires. Frontage is exactly
      // what a Road produces, so this is a Road problem — the old rule answered
      // "frontage cells exist, so a Road cannot help" and the city stood idle
      // with a 48-cell block of buildable land on the map.
      const block = Array.from({ length: 8 }, (_, index) => ({
        ...detail().zoningCells[0]!, block: { index: 73, version: 1 }, index,
        position: { x: 60, y: 0, z: index * 8 }, roadside: false,
        occupied: false, blocked: false, overridden: false, zoneCategory: "none" as const,
      }));
      const split = detail({ zoningCells: [...strip(3, (index) => index === 0), ...block] });

      expect(growableFrontageCells(split)).toHaveLength(1);
      expect(selectGrowableFrontageFootprint({ detail: split, zoneCategory: "residential" })).toEqual([]);

      const absence = classifyGrowableFrontageAbsence({ detail: split, zoneCategory: "residential" });
      expect(absence).toMatchObject({ reason: "MISSING_FRONTAGE", frontageCells: 1, unprotectedFootprints: 0 });
      expect(absence.missingFrontage?.cells).toBeGreaterThanOrEqual(6);
      // The Road belongs where the frontage is missing, not at the centroid of
      // every clean cell the anchor holds.
      expect(absence.missingFrontage?.center.x).toBeCloseTo(60, 0);
    });

    test("with no unfronted land in band either, it stays a land finding", () => {
      // The same split with a block too small to seed a marquee: now nothing a
      // Road could open would be executable, and the honest answer is the land.
      const tiny = Array.from({ length: 3 }, (_, index) => ({
        ...detail().zoningCells[0]!, block: { index: 73, version: 1 }, index,
        position: { x: 60, y: 0, z: index * 8 }, roadside: false,
        occupied: false, blocked: false, overridden: false, zoneCategory: "none" as const,
      }));
      expect(classifyGrowableFrontageAbsence({
        detail: detail({ zoningCells: [...strip(3, (index) => index === 0), ...tiny] }),
        zoneCategory: "residential",
      })).toMatchObject({ reason: "FRONTAGE_EXISTS_BUT_NO_VALID_GROWABLE_FOOTPRINT", frontageCells: 1,
        unprotectedFootprints: 0, ownedFootprints: 0 });
    });

    test("a valid footprint on land the project does not own is an ownership finding", () => {
      const long = detail({ zoningCells: strip(12, (index) => index === 0) });
      expect(selectGrowableFrontageFootprint({ detail: long, zoneCategory: "residential" }).length).toBeGreaterThan(0);
      expect(classifyGrowableFrontageAbsence({ detail: long, zoneCategory: "residential",
        isOwned: () => false }))
        .toMatchObject({ reason: "GROWABLE_FOOTPRINT_OUTSIDE_OWNED_TILES", ownedFootprints: 0 });
    });

    test("a valid owned footprint under another Goal's live reservation is a land-claim finding", () => {
      const long = detail({ zoningCells: strip(12, (index) => index === 0) });
      const owned = selectGrowableFrontageFootprint({ detail: long, zoneCategory: "residential" });
      const protections = [{ ref: "goal-work-order:sewage", scope: { center: { x: 0, z: 0 }, radius: 180 } }];
      // The claim is what removes them, and it is the only thing that does:
      // without it the same census yields the same footprints.
      expect(selectGrowableFrontageFootprint({ detail: long, zoneCategory: "residential", protections }))
        .toEqual([]);
      expect(classifyGrowableFrontageAbsence({ detail: long, zoneCategory: "residential", protections,
        isOwned: () => true }))
        .toMatchObject({ reason: "GROWABLE_FOOTPRINT_CLAIMED_BY_EXISTING_RESERVATION",
          unprotectedFootprints: owned.length, ownedFootprints: owned.length });
    });
  });

  test("selects preferred unlocked starter road prefab", () => {
    expect(selectAvailableStarterRoadPrefab({ availableRoadPrefabs: ["Small Road", "Medium Road"], preferred: "Medium Road" })).toBe("Medium Road");
  });

  test("falls back deterministically when preferred road prefab is locked", () => {
    expect(selectAvailableStarterRoadPrefab({ availableRoadPrefabs: ["Small Road", "Basic Road"], preferred: "Medium Road" })).toBe("Basic Road");
  });

  test("returns typed failure when no compatible unlocked road exists", () => {
    expect(() => selectAvailableStarterRoadPrefab({ availableRoadPrefabs: ["Medium Road Divided", "Highway Twoway"] })).toThrow("NO_UNLOCKED_COMPATIBLE_ROAD_PREFAB");
  });

  test("never carries a locked source-edge prefab into a road candidate", () => {
    const world = buildSpatialWorldModel(scan(true));
    const lockedSource = { ...world.roadGraph.edges[0], prefab: "Medium Road Divided" };
    const result = selectBoundedGate1Sites({
      ...input({ ...world, roadGraph: { ...world.roadGraph, edges: [lockedSource] } }, detail({ roadGraph: { nodes: [], edges: [lockedSource] } })),
      availableRoadPrefabs: ["Small Road", "Medium Road"],
    });
    expect(result.candidates[0]?.roadCandidates[0]?.input.prefab).toBe("Medium Road");
  });
  test("owned/buildable/accessible observation yields deterministic bounded candidate", () => {
    const world = buildSpatialWorldModel(scan(true));
    const first = selectBoundedGate1Sites(input(world, detail()));
    const second = selectBoundedGate1Sites(input(world, detail()));
    expect(first.candidates).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first.candidates[0].direction).toEqual({ x: 1, z: 0 });
    expect(first.candidates).toHaveLength(1);
  });

  test("target-directed goal admission selects the legal frontage that advances toward its target", () => {
    const world = buildSpatialWorldModel(scan(true));
    const result = evaluateBoundedStarterSites({
      world,
      anchors: selectBoundedStarterSiteAnchors(world),
      details: [{ anchor: { x: 0, z: 0 }, detail: detail() }],
      targetPoint: { x: 0, z: 100 },
      maxCandidates: 4,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].target.center.z).toBeGreaterThan(0);
    expect(Math.hypot(result.candidates[0].target.center.x, result.candidates[0].target.center.z - 100))
      .toBeLessThan(Math.hypot(result.candidates[0].evidence.sourceAnchor.x,
        result.candidates[0].evidence.sourceAnchor.z - 100));
  });

  test("samples goal-scoped road anchors nearest the durable target first", () => {
    const world = buildSpatialWorldModel(scan(true));
    const anchors = selectGoalWorkOrderSiteAnchors(world, 24, { x: 100, z: 0 });
    expect(anchors[0].node.entity.index).toBe(11);
  });

  test("admits a target-directed Road corridor scope when the starter route has no candidate", () => {
    const world = buildSpatialWorldModel(scan(true));
    const anchors = selectBoundedStarterSiteAnchors(world);
    const noCurrentRoute = { ...world, roadGraph: { ...world.roadGraph, edges: [] } };
    const fallback = evaluateBoundedStarterSites({
      world: noCurrentRoute,
      anchors,
      details: [{ anchor: { x: 0, z: 0 }, detail: detail() }],
      targetPoint: { x: 0, z: 100 },
      allowGenericRoadFallback: true,
    });
    expect(fallback.candidates).toHaveLength(1);
    expect(fallback.candidates[0]).toMatchObject({ roadCandidates: [], evidence: { access: "TARGET_DIRECTED_ROAD_FALLBACK" } });

    const residential = evaluateBoundedStarterSites({ world: noCurrentRoute, anchors,
      details: [{ anchor: { x: 0, z: 0 }, detail: detail() }], targetPoint: { x: 0, z: 100 } });
    expect(residential.candidates).toHaveLength(0);
  });

  /**
   * A site the bounded road resolver could not reach is a site the native
   * boundary will refuse. It is a last resort, so it must lose to every
   * reachable candidate — including one farther from the target. Scoring both
   * families on raw distance to the target let an unreachable site outrank a
   * reachable one by two orders of magnitude, which is how a target-directed
   * corridor kept choosing the one site it could not build.
   */
  test("a reachable target-directed candidate outranks a nearer unreachable one", () => {
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan({
      world: { min: -400, max: 400, size: 800 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -400, z: -100 }, max: { x: 400, z: 100 } }, center: { x: 0, z: 0 }, polygon: [] }],
      outsideConnections: [], bootstrapAssets: [],
      roadGraph: {
        truncated: false,
        nodes: [
          { entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
          { entity: { index: 11, version: 1 }, position: { x: 0, y: 0, z: 30 }, native: true, outsideConnection: false, roadDegree: 1 },
        ],
        // The existing road runs across the target direction, so the corridor
        // step toward the target is a new perpendicular segment rather than one
        // laid over an existing edge.
        edges: [{ entity: { index: 20, version: 1 }, prefab: "Small Road", native: true,
          startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 },
          start: { x: 0, z: 0 }, end: { x: 0, z: 30 }, length: 30 }],
      },
    }));
    const wideTerrain = {
      resolution: 2,
      bounds: { minX: -400, minZ: -100, maxX: 400, maxZ: 100 },
      cellSize: { x: 400, z: 100 },
      heights: [0, 0, 0, 0], waterDepths: [0, 0, 0, 0],
      groundWater: [0, 0, 0, 0], groundWaterPollution: [0, 0, 0, 0], windSpeed: [0, 0, 0, 0],
    };
    // A: on the existing road, 236 m short of the target. B: 100 m from the
    // target but with no road edge of its own, so its only candidate is the
    // unreachable fallback.
    const reachable = { node: world.roadGraph.nodes[0], sourceEdges: world.roadGraph.edges,
      direction: { x: 1, z: 0 }, derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" as const };
    const unreachable = {
      node: { entity: { index: 99, version: 1 }, position: { x: 200, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 0 },
      sourceEdges: [], direction: { x: 1, z: 0 }, derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" as const,
    };
    const result = evaluateBoundedStarterSites({
      world,
      anchors: [reachable as never, unreachable as never],
      details: [
        { anchor: { x: 0, z: 0 }, detail: detail({ terrain: wideTerrain }) },
        { anchor: { x: 200, z: 0 }, detail: detail({ center: { x: 200, z: 0 }, radius: 96, terrain: wideTerrain }) },
      ],
      targetPoint: { x: 300, z: 0 },
      allowGenericRoadFallback: true,
      maxCandidates: 4,
    });

    expect(result.candidates[0]).toMatchObject({ evidence: { access: "BOUNDED_ROAD_FEASIBLE" } });
    expect(result.candidates[0].roadCandidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].target.center.x).toBeLessThan(200);
    // The unreachable site is still offered, just never chosen over a buildable one.
    expect(result.candidates.at(-1)).toMatchObject({ roadCandidates: [], evidence: { access: "TARGET_DIRECTED_ROAD_FALLBACK" } });
  });

  /**
   * A reservation that carries no cell this project may zone is a site it pays a
   * road for and then cannot use. Preferring frontage *within* one anchor was not
   * enough: another anchor's frontage-less candidate could still win on distance,
   * and that is how a tranche ends its Road at ROAD_DELIVERED with nothing to
   * zone. Frontage is therefore a ranking key over the whole candidate set.
   */
  /**
   * A Road-only scope — the `ROAD_FRONTAGE` prerequisite — is a directed
   * delivery, not a site search: it exists to carry the road network closer to
   * ONE piece of ground. Measured live 2026-10-01, three such prerequisites for
   * a single target were admitted 265 m, 274 m and 710 m away, all three built
   * real roads, and the frontage census at the anchor moved 7 -> 7, 18 -> 19,
   * 7 -> 7. The target never gained frontage, so the parent Goal re-derived and
   * minted another one.
   */
  test("a Road-only step that leaves the network no closer to its target is not admitted", () => {
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan({
      world: { min: -1200, max: 300, size: 1500 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -1100, z: -200 }, max: { x: 100, z: 200 } }, center: { x: -500, z: 0 }, polygon: [] }],
      outsideConnections: [], bootstrapAssets: [],
      roadGraph: {
        truncated: false,
        nodes: [
          { entity: { index: 10, version: 1 }, position: { x: -300, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
          { entity: { index: 11, version: 1 }, position: { x: -1000, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
        ],
        edges: [{ entity: { index: 20, version: 1 }, prefab: "Small Road", native: true,
          startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 },
          start: { x: -300, z: 0 }, end: { x: -1000, z: 0 }, length: 700 }],
      },
    }));
    const wideTerrain = {
      resolution: 2, bounds: { minX: -1100, minZ: -200, maxX: 100, maxZ: 200 },
      cellSize: { x: 600, z: 200 }, heights: [0, 0, 0, 0], waterDepths: [0, 0, 0, 0],
      groundWater: [0, 0, 0, 0], groundWaterPollution: [0, 0, 0, 0], windSpeed: [0, 0, 0, 0],
    };
    const freeCell = (x: number) => ({
      block: { index: 30, version: 1 }, index: 0, position: { x, y: 0, z: 0 },
      visible: true, roadside: true, occupied: false, blocked: false, overridden: false,
      zoneType: 0, zoneCategory: "none",
    });
    const anchorAt = (node: (typeof world.roadGraph.nodes)[number]) => ({
      node, sourceEdges: world.roadGraph.edges, direction: { x: 1, z: 0 },
      derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" as const,
    });
    // The target sits 100 m past the nearest road node; the far node is 800 m out.
    const targetPoint = { x: -200, z: 0 };
    const input = (roadDelivery: boolean) => ({
      world,
      anchors: [anchorAt(world.roadGraph.nodes[0]), anchorAt(world.roadGraph.nodes[1])] as never,
      details: [
        { anchor: { x: -300, z: 0 }, detail: detail({ center: { x: -300, z: 0 }, radius: 96, terrain: wideTerrain, zoningCells: [freeCell(-250)] }) },
        { anchor: { x: -1000, z: 0 }, detail: detail({ center: { x: -1000, z: 0 }, radius: 96, terrain: wideTerrain, zoningCells: [freeCell(-950)] }) },
      ],
      targetPoint, allowGenericRoadFallback: true, maxCandidates: 8, roadDelivery,
    });

    // Every admitted step must leave the frontier closer to the target than the
    // nearest road node it could build from — 100 m from the target here.
    const directed = evaluateBoundedStarterSites(input(true));
    // The far anchor's own points are closer to the target than that anchor, so
    // the old per-anchor bar admitted them. Against the network's reach they are
    // not progress, and the rule says so by name.
    expect(directed.rejections.TARGET_NOT_ADVANCED).toBeGreaterThan(0);
    for (const candidate of directed.candidates) {
      const centre = candidate.target.center;
      expect(Math.hypot(centre.x - targetPoint.x, centre.z - targetPoint.z)).toBeLessThan(100);
    }

    // The same world without the Road-only requirement still offers the far
    // site: this is the directed prerequisite's rule, not a global one.
    const search = evaluateBoundedStarterSites(input(false));
    expect(search.rejections.TARGET_NOT_ADVANCED).toBe(0);
    expect(search.candidates.some((candidate) =>
      Math.hypot(candidate.target.center.x - targetPoint.x, candidate.target.center.z - targetPoint.z) > 100)).toBe(true);

    // A standalone Road Goal's target is only a grid-frame reference: nothing has to advance toward it, so the
    // frontier far from that reference is still expandable (live: 849/849 candidates refused).
    const reference = evaluateBoundedStarterSites({ ...input(true), targetIsReferenceOnly: true });
    expect(reference.rejections.TARGET_NOT_ADVANCED).toBe(0);
    expect(reference.candidates.length).toBeGreaterThanOrEqual(directed.candidates.length);
  });

  test("a site the project can actually zone outranks a nearer one it cannot", () => {
    const targetPoint = { x: 0, z: 0 };
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan({
      world: { min: -1200, max: 300, size: 1500 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -1100, z: -200 }, max: { x: 100, z: 200 } }, center: { x: -500, z: 0 }, polygon: [] }],
      outsideConnections: [], bootstrapAssets: [],
      roadGraph: {
        truncated: false,
        nodes: [
          { entity: { index: 10, version: 1 }, position: { x: -200, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
          { entity: { index: 11, version: 1 }, position: { x: -1000, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
        ],
        edges: [{ entity: { index: 20, version: 1 }, prefab: "Small Road", native: true,
          startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 },
          start: { x: -200, z: 0 }, end: { x: -1000, z: 0 }, length: 800 }],
      },
    }));
    const wideTerrain = {
      resolution: 2,
      bounds: { minX: -1100, minZ: -200, maxX: 100, maxZ: 200 },
      cellSize: { x: 600, z: 200 },
      heights: [0, 0, 0, 0], waterDepths: [0, 0, 0, 0],
      groundWater: [0, 0, 0, 0], groundWaterPollution: [0, 0, 0, 0], windSpeed: [0, 0, 0, 0],
    };
    const cell = (x: number, zoneCategory: string) => ({
      block: { index: 30, version: 1 }, index: 0, position: { x, y: 0, z: 0 },
      visible: true, roadside: true, occupied: false, blocked: false, overridden: false,
      zoneType: 0, zoneCategory,
    });
    const nearer = { node: world.roadGraph.nodes[0], sourceEdges: world.roadGraph.edges,
      direction: { x: 1, z: 0 }, derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" as const };
    const farther = { node: world.roadGraph.nodes[1], sourceEdges: world.roadGraph.edges,
      direction: { x: 1, z: 0 }, derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" as const };

    const result = evaluateBoundedStarterSites({
      world,
      anchors: [nearer as never, farther as never],
      details: [
        // Everything this anchor can reach is already categorised, so no cell of
        // the reservation is free to zone.
        { anchor: { x: -200, z: 0 }, detail: detail({ center: { x: -200, z: 0 }, radius: 96,
          terrain: wideTerrain, zoningCells: [cell(-112, "residential")] }) },
        { anchor: { x: -1000, z: 0 }, detail: detail({ center: { x: -1000, z: 0 }, radius: 96,
          terrain: wideTerrain, zoningCells: [cell(-912, "none")] }) },
      ],
      targetPoint,
      maxCandidates: 4,
    });

    const selected = result.candidates[0];
    expect(selected.evidence.sourceAnchor).toEqual({ x: -1000, z: 0 });
    expect(selected.evidence.frontage).toBe(true);
    expect(selected.target.center.x).toBe(-912);

    const rejectedForFrontage = result.candidates.find(
      (candidate) => candidate.evidence.sourceAnchor.x === -200,
    );
    expect(rejectedForFrontage?.evidence.frontage).toBe(false);
    // Distance alone would have chosen it: it is the nearer of the two, and the
    // whole point of the tier is that being nearer is not enough.
    expect(rejectedForFrontage!.score).toBeGreaterThan(selected.score);
    expect(Math.hypot(rejectedForFrontage!.target.center.x - targetPoint.x,
      rejectedForFrontage!.target.center.z - targetPoint.z))
      .toBeLessThan(Math.hypot(selected.target.center.x - targetPoint.x, selected.target.center.z - targetPoint.z));
  });

  test("a world with no zoneable frontage anywhere still admits its best remaining site", () => {
    const world = buildSpatialWorldModel(scan(true));
    const categorised = detail({ zoningCells: [{ ...detail().zoningCells[0], zoneCategory: "residential" }] });
    const result = selectBoundedGate1Sites(input(world, categorised));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence.frontage).toBe(false);
    expect(result.rejections.ZONEABLE_FRONTAGE).toBeGreaterThan(0);
  });

  test("rejects unowned, water, building conflict, and UNKNOWN frontage", () => {
    const ownedWorld = buildSpatialWorldModel(scan(true));
    const unownedWorld = { ...ownedWorld, ownedTiles: [] };
    const unowned = selectBoundedGate1Sites(input(unownedWorld, detail()));
    expect(unowned.candidates).toHaveLength(0);
    expect(unowned.rejections.NOT_OWNED).toBe(0);
    const water = detail({ terrain: { ...detail().terrain, waterDepths: [1, 1, 1, 1] } });
    expect(selectBoundedGate1Sites(input(buildSpatialWorldModel(scan(true)), water)).rejections.WATER).toBeGreaterThan(0);
    // The conflict has to sit on the anchor itself: the near site offsets are tried
    // first, and a building that only reaches the far ones would never be probed.
    const blocked = detail({ buildings: [{ entity: { index: 40, version: 1 }, prefab: "Residential", native: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null }] });
    expect(selectBoundedGate1Sites(input(buildSpatialWorldModel(scan(true)), blocked)).rejections.NOT_BUILDABLE).toBeGreaterThan(0);
    const unknownExistingCell = detail({ zoningCells: [{ ...detail().zoningCells[0], zoneCategory: "unknown" }] });
    expect(selectBoundedGate1Sites(input(buildSpatialWorldModel(scan(true)), unknownExistingCell)).candidates).toHaveLength(1);
  });

  /**
   * "Not inside this anchor's observation circle" and "not in our owned tiles"
   * are two different facts and must not share a counter.
   *
   * Measured live 2026-10-01: 36 anchors testing the SAME point produced 31
   * `NOT_OWNED` rejections, while `owned(point)` is constant for a fixed point —
   * the variation could only come from the per-anchor observation circle
   * (`localScope`), and the point was verified to be owned land. Reporting both
   * as `NOT_OWNED` made the histogram unable to answer whether the land was ours
   * at all, which is the question the whole investigation rested on.
   */
  test("separates the anchor's observation circle from ownership in the rejection histogram", () => {
    const ownedWorld = buildSpatialWorldModel(scan(true));
    const anchorFor = (world: ReturnType<typeof buildSpatialWorldModel>) => [{
      node: world.roadGraph.nodes[0], sourceEdges: world.roadGraph.edges,
      direction: { x: 1, z: 0 }, derivation: "OWNED_LOCAL_ROAD_TOPOLOGY" as const,
    }] as never;

    // Owned land, but the anchor's observation circle is nowhere near the points
    // it probes: the rejection is the scope constraint and must NOT read as
    // ownership. `owned(point)` would say yes for every one of these points.
    const offScope = evaluateBoundedStarterSites({
      world: ownedWorld,
      anchors: anchorFor(ownedWorld),
      details: [{ anchor: { x: 0, z: 0 }, detail: detail({ center: { x: 1000, z: 1000 }, radius: 10 }) }],
    });
    expect(offScope.rejections.OUTSIDE_ANCHOR_OBSERVATION).toBeGreaterThan(0);
    expect(offScope.rejections.NOT_OWNED).toBe(0);

    // Inside the circle but unowned: ownership is the only reason left, and the
    // scope counter must stay silent.
    const unownedWorld = { ...ownedWorld, ownedTiles: [] };
    const inScope = evaluateBoundedStarterSites({
      world: unownedWorld,
      anchors: anchorFor(unownedWorld),
      details: [{ anchor: { x: 0, z: 0 }, detail: detail() }],
    });
    expect(inScope.rejections.NOT_OWNED).toBeGreaterThan(0);
    expect(inScope.rejections.OUTSIDE_ANCHOR_OBSERVATION).toBe(0);
  });

  test("derives a non-cardinal direction from observed road topology", () => {
    const world = buildSpatialWorldModel(scan(true, true));
    const diagonalDetail = detail({ roadGraph: { nodes: [], edges: [{ ...detail().roadGraph.edges[0], end: { x: -30, z: -30 }, length: 42.4 }] } });
    const result = selectBoundedGate1Sites(input(world, diagonalDetail));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].direction).not.toEqual({ x: 1, z: 0 });
  });

  test("accepts open non-roadside land when bounded RoadConnection is feasible", () => {
    const nonRoadside = detail({ zoningCells: [{ ...detail().zoningCells[0], roadside: false }] });
    const result = selectBoundedGate1Sites(input(buildSpatialWorldModel(scan(true)), nonRoadside));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence.access).toBe("BOUNDED_ROAD_FEASIBLE");
  });

  test("accepts bounded open land when no existing zoning cells are returned", () => {
    const result = selectBoundedGate1Sites(input(buildSpatialWorldModel(scan(true)), detail({ zoningCells: [] })));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence.openResidentialCells).toBe(0);
    expect(result.rejections.NOT_BUILDABLE).toBe(0);
  });

  /**
   * A RoadConnection course leaves with BOTH ENDS FREE, and the activated epoch
   * is bound onto the free endpoint.
   *
   * The shape this replaces declared `EXISTING_NET_NODE` at START. Measured
   * read-only on the live world (2026-10-02): a course whose heading matches the
   * ray of the street already leaving that node is folded back onto it
   * (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`, or a bare 409) at 40 m exactly as
   * at 600 m, which is every second course of a cut grid line; and declaring
   * `NEW_FREE_ENDPOINT` for START instead is refused outright
   * (`ROAD_ENDPOINT_ATTACHMENT_UNSUPPORTED`). Omitting `startEndpoint` entirely
   * is the shape the world answers CERTIFIED to, and it is what the live run
   * built 7/7 of a collection's lines with.
   */
  test("binds the activated epoch to the free endpoint, and declares no start attachment", () => {
    const world = buildSpatialWorldModel(scan(true));
    const result = selectBoundedGate1Sites(input(world, detail()));
    const withoutEpoch = result.candidates[0].roadCandidates[0];
    expect(withoutEpoch.input.startEndpoint).toBeUndefined();
    expect(withoutEpoch.input.endEndpoint?.kind).toBe("NEW_FREE_ENDPOINT");
    expect(withoutEpoch.input.endEndpoint?.worldEpoch).toBe("UNVERIFIED");
    const selected = selectBoundedStarterSiteAnchors(world, 24);
    const withEpoch = evaluateBoundedStarterSites({
      world,
      anchors: selected,
      details: [{ anchor: { x: 0, z: 0 }, detail: detail() }],
      worldEpoch: "active-epoch-a",
      bridgeGeneration: "bridge-generation-a",
    });
    expect(withEpoch.candidates[0].roadCandidates[0].input.startEndpoint).toBeUndefined();
    expect(withEpoch.candidates[0].roadCandidates[0].input.endEndpoint?.worldEpoch).toBe("bridge-generation-a");
  });

  /**
   * The scan's `native` flag marks the MAP's network, not the player's: the roads
   * this product itself delivered come back `native: false`. Requiring `native`
   * hid the entire delivered network from site selection, which starved the
   * anchor classes and left every later admission decided by buildability and
   * reservation conflicts instead of by where the city is.
   */
  test("a delivered road is an anchor when the unlocked catalogue names its prefab", () => {
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan({
      world: { min: -200, max: 200, size: 400 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true,
        bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } }, center: { x: 0, z: 0 }, polygon: [] }],
      outsideConnections: [], bootstrapAssets: [],
      roadGraph: {
        truncated: false,
        nodes: [
          { entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 },
          { entity: { index: 11, version: 1 }, position: { x: 40, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 },
          { entity: { index: 12, version: 1 }, position: { x: 0, y: 0, z: 40 }, native: false, outsideConnection: false, roadDegree: 1 },
        ],
        edges: [
          { entity: { index: 20, version: 1 }, prefab: "Small Road", native: false,
            startNode: { index: 10, version: 1 }, endNode: { index: 11, version: 1 },
            start: { x: 0, z: 0 }, end: { x: 40, z: 0 }, length: 40 },
          // A non-road net is in no road catalogue, so it is never an anchor.
          { entity: { index: 21, version: 1 }, prefab: "Medium Seaway", native: false,
            startNode: { index: 10, version: 1 }, endNode: { index: 12, version: 1 },
            start: { x: 0, z: 0 }, end: { x: 0, z: 40 }, length: 40 },
        ],
      },
    }));

    // Without a catalogue the previous map-native-only behaviour is unchanged.
    expect(selectGoalWorkOrderSiteAnchors(world, 24)).toHaveLength(0);
    const withCatalogue = selectGoalWorkOrderSiteAnchors(world, 24, undefined, ["Small Road", "Medium Road"]);
    expect(withCatalogue.map((anchor) => anchor.node.entity.index).sort()).toEqual([10, 11]);
  });

  test("selects owned local-road anchors instead of arbitrary unowned highways", () => {
    const base = scan(true);
    const fixture = parseSpatialBootstrapScan({
      ...base,
      roadGraph: {
        ...base.roadGraph,
        nodes: [
          { entity: { index: 1, version: 1 }, position: { x: -150, y: 0, z: -150 }, native: true, outsideConnection: false, roadDegree: 1 },
          { entity: { index: 2, version: 1 }, position: { x: -120, y: 0, z: -150 }, native: true, outsideConnection: false, roadDegree: 1 },
          ...base.roadGraph.nodes,
        ],
        edges: [
          { entity: { index: 3, version: 1 }, prefab: "Highway Twoway", native: true, startNode: { index: 1, version: 1 }, endNode: { index: 2, version: 1 }, start: { x: -150, z: -150 }, end: { x: -120, z: -150 }, length: 30 },
          ...base.roadGraph.edges,
        ],
      },
    });
    const anchors = selectBoundedStarterSiteAnchors(buildSpatialWorldModel(fixture), 24);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.every((anchor) => anchor.node.entity.index >= 10)).toBe(true);
    expect(anchors.every((anchor) => anchor.sourceEdges.every((edge) => !/highway/i.test(edge.prefab)))).toBe(true);
  });

  test("uses an owned topology-derived highway ingress only as a local RoadConnection seed", () => {
    const fixture = parseSpatialBootstrapScan({
      world: { min: -200, max: 200, size: 400 },
      tiles: [{ entity: { index: 1, version: 1 }, owned: true, bounds: { min: { x: -100, z: -100 }, max: { x: 100, z: 100 } }, center: { x: 0, z: 0 }, polygon: [] }],
      outsideConnections: [{ entity: { index: 9, version: 1 }, position: { x: -150, y: 0, z: 0 }, connectedRoadEdges: [{ index: 20, version: 1 }] }],
      bootstrapAssets: [],
      roadGraph: {
        truncated: false,
        nodes: [
          { entity: { index: 9, version: 1 }, position: { x: -150, y: 0, z: 0 }, native: true, outsideConnection: true, roadDegree: 1 },
          { entity: { index: 10, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
        ],
        edges: [{ entity: { index: 20, version: 1 }, prefab: "Highway Twoway - 2 lanes", native: true, startNode: { index: 9, version: 1 }, endNode: { index: 10, version: 1 }, start: { x: -150, z: 0 }, end: { x: 0, z: 0 }, length: 150 }],
      },
    });
    const world = buildSpatialWorldModel(fixture);
    const anchors = selectBoundedStarterSiteAnchors(world, 24);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].derivation).toBe("OWNED_START_CONNECTION_TOPOLOGY");
    const result = selectBoundedGate1Sites(input(world, detail()));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].roadCandidates[0].sourceNode.entity).toEqual({ index: 10, version: 1 });
    expect(result.candidates[0].roadCandidates[0].sourceEdge.prefab).toMatch(/Highway/);
    expect(result.candidates[0].roadCandidates[0].input.prefab).toBe("Medium Road");
  });

  test("uses local detail scope and rejects only anchors outside an explicit project scope", () => {
    const world = buildSpatialWorldModel(scan(true));
    const accepted = selectBoundedGate1Sites(input(world, detail(), { center: { x: 0, z: 0 }, radius: 40 }));
    expect(accepted.candidates).toHaveLength(1);
    const rejected = selectBoundedGate1Sites(input(world, detail(), { center: { x: 1000, z: 1000 }, radius: 10 }));
    expect(rejected.candidates).toHaveLength(0);
    expect(rejected.rejections.OUTSIDE_PROJECT_SCOPE).toBe(1);
    expect(rejected.rejections.NOT_BUILDABLE).toBe(0);
  });
});
