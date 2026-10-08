import {
  buildRoadGridCandidates,
  filterGridSegmentsByTerrain,
  goldenRatioLadder,
  GRID_LATTICE_SPACING_METERS,
  gridAxisRadians,
  gridLatticeOffsetMeters,
  headingSeparationDegrees,
  mixedGridDimensions,
  planGridCollections,
  planRectangularGrid,
  reportGridCollectionsOnTerrain,
  sharedRoadGridReference,
} from "@/main/services/ai-mayor/v2/road-grid-generator";
import { MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS } from "@/main/services/ai-mayor/v2/road-contract";
import type {
  SpatialLocalTerrain,
  SpatialRoadEdge,
  SpatialRoadNode,
  SpatialPoint2,
  SpatialTile,
} from "@/main/services/ai-mayor/spatial/types";

const ref = (index: number, version = 1) => ({ index, version });

const flatTerrain = (minX: number, minZ: number, maxX: number, maxZ: number): SpatialLocalTerrain => {
  const resolution = 64;
  return {
    resolution,
    bounds: { minX, minZ, maxX, maxZ },
    cellSize: { x: (maxX - minX) / resolution, z: (maxZ - minZ) / resolution },
    heights: new Array(resolution * resolution).fill(0),
    waterDepths: new Array(resolution * resolution).fill(0),
    groundWater: new Array(resolution * resolution).fill(0),
    groundWaterPollution: new Array(resolution * resolution).fill(0),
    windSpeed: new Array(resolution * resolution).fill(0),
  };
};

const tile = (minX: number, minZ: number, maxX: number, maxZ: number): SpatialTile => ({
  entity: ref(1),
  owned: true,
  bounds: { min: { x: minX, z: minZ }, max: { x: maxX, z: maxZ } },
  center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
  polygon: [],
});

const road = (index: number, start: SpatialPoint2, end: SpatialPoint2): SpatialRoadEdge => ({
  entity: ref(index),
  prefab: "Small Road",
  native: true,
  startNode: ref(index * 2),
  endNode: ref(index * 2 + 1),
  start,
  end,
  length: Math.hypot(end.x - start.x, end.z - start.z),
});

const nodesOf = (edges: readonly SpatialRoadEdge[]): SpatialRoadNode[] =>
  edges.flatMap((edge) => [
    { entity: edge.startNode, position: { ...edge.start, y: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
    { entity: edge.endNode, position: { ...edge.end, y: 0 }, native: true, outsideConnection: false, roadDegree: 1 },
  ]);

const headingOf = (candidate: { input: { x1: number; z1: number; x2: number; z2: number } }): number =>
  ((Math.atan2(candidate.input.z2 - candidate.input.z1, candidate.input.x2 - candidate.input.x1) * 180) / Math.PI + 360) % 360;

const baseInput = (edges: readonly SpatialRoadEdge[]) => ({
  siteTarget: { x: 0, z: 0 },
  sourceEdges: edges,
  sourceNodes: nodesOf(edges),
  ownedTiles: [tile(-400, -400, 400, 400)],
  terrain: flatTerrain(-400, -400, 400, 400),
  buildings: [],
  prefab: "Small Road",
});

describe("road grid generator", () => {
  it("lays every course on a world axis, whatever the seed road's bearing", () => {
    // The seed road is the lowest-index edge and is deliberately diagonal: the
    // grid must still come out 横平 (world 0/90), because a grid built on the
    // seed's own bearing is the skew it exists to remove.
    const edges = [road(1, { x: -200, z: -200 }, { x: -120, z: -120 }), road(9, { x: 0, z: 0 }, { x: 80, z: 0 })];
    const candidates = buildRoadGridCandidates(baseInput(edges));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const heading = headingOf(candidate);
      const offAxis = Math.min(
        headingSeparationDegrees(heading, 0),
        headingSeparationDegrees(heading, 90),
        headingSeparationDegrees(heading, 180),
        headingSeparationDegrees(heading, 270),
      );
      expect(offAxis).toBeLessThan(1e-6);
      expect(candidate.family).toBe("ORTHOGONAL_GRID");
      expect(candidate.contactDerivation).toBe("GRID_AXIS_NODE");
    }
  });

  it("joins the collection to the nearest existing node with an axis-aligned access course", () => {
    const edges = [road(1, { x: 0, z: 0 }, { x: 80, z: 0 })];
    const candidates = buildRoadGridCandidates({ ...baseInput(edges), siteTarget: { x: 0, z: 0 } });
    const first = candidates[0]!;
    // The district joins the network where a node the city already has reaches
    // it, not by declaring an attachment: a collection's own corner is a lattice
    // point, and no lattice point is a node.
    expect(first.input.x1).toBeCloseTo(0, 6);
    expect(first.input.z1).toBeCloseTo(0, 6);
    // 横平: a spur that cuts a diagonal across the collection is not an axis.
    const dx = Math.abs(first.input.x2 - first.input.x1);
    const dz = Math.abs(first.input.z2 - first.input.z1);
    expect(Math.min(dx, dz)).toBeCloseTo(0, 6);
    // BOTH ENDS FREE: the world is asked only whether the geometry may exist, and
    // writing `NEW_FREE_ENDPOINT` for START is what it refuses outright.
    expect(first.input.startEndpoint).toBeUndefined();
    expect(first.input.endEndpoint?.kind).toBe("NEW_FREE_ENDPOINT");
  });

  it("lays one 120 m course per collection line, and never one that is already a road", () => {
    const candidates = buildRoadGridCandidates(baseInput([road(1, { x: 0, z: 0 }, { x: 80, z: 0 })]));
    const lines = candidates.filter((candidate) => candidate.finalSegmentLength === 120);
    // A 120 x 120 m collection plans 3 vertical + 3 horizontal lines, each
    // spanning its whole axis in ONE course — a line cut at its blocks is a
    // queue of collinear courses, and the world folds every one after the first
    // back. One of the six is not offered: the horizontal line at z = 0 runs
    // along the road already there from (0,0) to (80,0), and re-laying a road is
    // what native answers `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` to.
    expect(lines).toHaveLength(5);
    expect(lines.some((candidate) => candidate.input.z1 === 0 && candidate.input.z2 === 0)).toBe(false);
    const headings = new Set(lines.map((candidate) => Math.round(headingOf(candidate)) % 180));
    expect([...headings].sort((left, right) => left - right)).toEqual([0, 90]);
  });

  it("never offers an access leg that lies along a street already there (native folds it back)", () => {
    // Live 2026-10-02: the only course a stuck Road Goal offered was a 53 m leg lying on an existing street.
    const edges = [road(1, { x: 0, z: 0 }, { x: 80, z: 0 }), road(2, { x: 80, z: 0 }, { x: 200, z: 0 })];
    const sites: Array<{ x: number; z: number }> = [];
    for (let x = -300; x <= 300; x += 20) for (let z = -300; z <= 300; z += 20) sites.push({ x, z });
    for (const siteTarget of sites) {
      const candidates = buildRoadGridCandidates({ ...baseInput(edges), siteTarget });
      for (const candidate of candidates) {
        const heading = headingOf(candidate);
        for (const edge of edges) {
          const edgeHeading = ((Math.atan2(edge.end.z - edge.start.z, edge.end.x - edge.start.x) * 180) / Math.PI + 360) % 360;
          const separation = headingSeparationDegrees(heading, edgeHeading);
          const parallel = Math.min(separation, 180 - separation) <= 15;
          const lateral = Math.abs(candidate.input.z1 - edge.start.z);
          const overlapsX = Math.min(candidate.input.x1, candidate.input.x2) < Math.max(edge.start.x, edge.end.x) &&
            Math.max(candidate.input.x1, candidate.input.x2) > Math.min(edge.start.x, edge.end.x);
          expect(parallel && lateral < 12 && overlapsX).toBe(false);
        }
      }
    }
  });

  it("never offers an access leg without the leg that connects it (no island stub)", () => {
    // The lattice is anchored on the seed road far away, so the node streets below sit OFF the lattice and an
    // elbow is not mistaken for a lattice point.
    const edges = [road(1, { x: -400, z: -400 }, { x: -360, z: -400 }), road(2, { x: 13, z: 7 }, { x: 93, z: 7 }),
      road(3, { x: 13, z: 7 }, { x: 13, z: 67 })];
    const nodes = nodesOf(edges).map((node) => node.position);
    const reference = sharedRoadGridReference(edges)!;
    const buildings = [{ x: 33, z: 47 }, { x: -17, z: 27 }, { x: 73, z: -33 }, { x: 113, z: 27 }, { x: 53, z: -73 },
      { x: -37, z: -43 }, { x: 133, z: 67 }].map((position) => ({
      entity: ref(500), prefab: "House", native: true, position: { ...position, y: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 }, footprint: null,
    }));
    const near = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z) < 0.5;
    for (let x = -280; x <= 280; x += 40) {
      for (let z = -280; z <= 280; z += 40) {
        const candidates = buildRoadGridCandidates({ ...baseInput(edges), siteTarget: { x, z }, buildings });
        for (const candidate of candidates) {
          const start = { x: candidate.input.x1, z: candidate.input.z1 };
          const onNode = nodes.some((node) => near(node, start));
          const onLattice = gridLatticeOffsetMeters(start, reference) < 0.5;
          const continued = candidates.some((other) => other !== candidate && near({ x: other.input.x2, z: other.input.z2 }, start));
          expect(onNode || onLattice || continued).toBe(true);
        }
      }
    }
  });

  it("is a pure function of the world", () => {
    const edges = [road(1, { x: 0, z: 0 }, { x: 80, z: 0 }), road(4, { x: 0, z: 0 }, { x: 0, z: 60 })];
    const first = buildRoadGridCandidates(baseInput(edges));
    const second = buildRoadGridCandidates(baseInput(edges));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps every course on the city's own land, and offers nothing when the land is not there", () => {
    const edges = [road(1, { x: 0, z: 0 }, { x: 80, z: 0 })];
    const owned = buildRoadGridCandidates({ ...baseInput(edges), ownedTiles: [tile(-60, -60, 160, 160)] });
    expect(owned.length).toBeGreaterThan(0);
    for (const candidate of owned) {
      for (const point of [
        { x: candidate.input.x1, z: candidate.input.z1 },
        { x: candidate.input.x2, z: candidate.input.z2 },
      ]) {
        expect(point.x).toBeGreaterThanOrEqual(-60);
        expect(point.x).toBeLessThanOrEqual(160);
        expect(point.z).toBeGreaterThanOrEqual(-60);
        expect(point.z).toBeLessThanOrEqual(160);
      }
    }
    // A tile that carries none of the collection is a site this family cannot
    // serve, and it says so by offering nothing rather than by offering a course
    // on ground the city does not own.
    expect(buildRoadGridCandidates({ ...baseInput(edges), ownedTiles: [tile(-20, -20, 40, 40)] })).toEqual([]);
  });

  it("snaps a skewed reference to the nearest quarter turn", () => {
    const skewed = sharedRoadGridReference([road(1, { x: 0, z: 0 }, { x: 40, z: 30 })]);
    expect(skewed).not.toBeNull();
    const [axisA, axisB] = gridAxisRadians(skewed);
    expect(axisA % (Math.PI / 2)).toBeCloseTo(0, 9);
    expect(axisB - axisA).toBeCloseTo(Math.PI / 2, 9);
  });

  it("measures an endpoint's distance to the nearest grid point", () => {
    const reference = { origin: { x: 0, z: 0 }, orientationRadians: 0, spacingMeters: GRID_LATTICE_SPACING_METERS, sourceEdgeRef: ref(1) };
    // On the lattice, however many whole spacings away.
    expect(gridLatticeOffsetMeters({ x: 0, z: 0 }, reference)).toBeCloseTo(0, 9);
    expect(gridLatticeOffsetMeters({ x: 40, z: -80 }, reference)).toBeCloseTo(0, 9);
    // Mid-cell in one axis is half a spacing; the two axes compose.
    expect(gridLatticeOffsetMeters({ x: 20, z: 0 }, reference)).toBeCloseTo(20, 9);
    expect(gridLatticeOffsetMeters({ x: 20, z: 20 }, reference)).toBeCloseTo(Math.hypot(20, 20), 9);
    // The cadence itself has to land on the lattice — that is the whole point.
    expect(gridLatticeOffsetMeters({ x: 120, z: 80 }, reference)).toBeCloseTo(0, 9);
    expect(gridLatticeOffsetMeters({ x: 8, z: 0 }, reference)).toBeCloseTo(8, 9);
  });

  it("plans one course per grid line, every endpoint on the lattice", () => {
    const segments = planRectangularGrid({
      anchor: { x: -4, z: 48 },
      columnWidths: [80, 80, 80],
      rowHeights: [120, 120],
    });
    // 4 vertical lines + 3 horizontal lines. A line is NOT cut at the blocks it
    // crosses: cutting it there is what puts a collinear course on it, and the
    // world folds that one back (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`).
    expect(segments).toHaveLength(4 + 3);
    const reference = { origin: { x: -4, z: 48 }, orientationRadians: 0, spacingMeters: GRID_LATTICE_SPACING_METERS, sourceEdgeRef: ref(1) };
    for (const course of segments) {
      expect(gridLatticeOffsetMeters(course.start, reference)).toBeCloseTo(0, 9);
      expect(gridLatticeOffsetMeters(course.end, reference)).toBeCloseTo(0, 9);
      const expected = course.orientation === "VERTICAL" ? 240 : 240;
      expect(course.lengthMeters).toBe(expected); // 2 rows of 120 / 3 columns of 80
      const heading = Math.atan2(course.end.z - course.start.z, course.end.x - course.start.x) * 180 / Math.PI;
      const offAxis = Math.min(...[0, 90, 180, 270].map((axis) => headingSeparationDegrees(((heading % 360) + 360) % 360, axis)));
      expect(offAxis).toBeLessThan(1e-9);
    }
    // One line, one span: nothing on a line is a continuation of anything else.
    expect(new Set(segments.map((course) => course.spanIndex))).toEqual(new Set([0]));
    expect(new Set(segments.map((course) => course.cutIndex))).toEqual(new Set([0]));
    // The crossings the world will junction are the lattice points both a
    // vertical and a horizontal line run through: 4 x 3.
    const verticalLines = new Set(segments.filter((s) => s.orientation === "VERTICAL").map((s) => s.latticeStart.i));
    const horizontalLines = new Set(segments.filter((s) => s.orientation === "HORIZONTAL").map((s) => s.latticeStart.j));
    expect(verticalLines.size).toBe(4);
    expect(horizontalLines.size).toBe(3);
  });

  it("lays an uneven grid on its prefix sums, with every endpoint still on the lattice", () => {
    // 3 columns of 80/120/160 and 2 rows of 80/120 — a small/medium/large ladder
    // rather than one repeated block size.
    const dimensions = mixedGridDimensions({ columns: 3, rows: 2, ratios: [1, 1.5, 2], unitSteps: 2 });
    expect(dimensions.columnWidths).toEqual([80, 120, 160]);
    expect(dimensions.rowHeights).toEqual([80, 120]);
    const anchor = { x: 100, z: 200 };
    const segments = planRectangularGrid({ anchor, ...dimensions });

    // 4 vertical lines + 3 horizontal lines, each spanning its whole axis.
    expect(segments).toHaveLength(4 + 3);
    const verticals = segments.filter((s) => s.orientation === "VERTICAL");
    const horizontals = segments.filter((s) => s.orientation === "HORIZONTAL");
    expect(verticals.map((s) => s.start.x)).toEqual([100, 180, 300, 460]); // 0, +80, +120, +160
    expect(horizontals.map((s) => s.start.z)).toEqual([200, 280, 400]); // 0, +80, +120
    // A vertical line spans every row: 80 + 120 = 200 m. A horizontal line spans
    // every column: 80 + 120 + 160 = 360 m.
    expect(verticals.every((s) => s.lengthMeters === 200)).toBe(true);
    expect(horizontals.every((s) => s.lengthMeters === 360)).toBe(true);

    const reference = { origin: anchor, orientationRadians: 0, spacingMeters: GRID_LATTICE_SPACING_METERS, sourceEdgeRef: ref(1) };
    for (const course of segments) {
      expect(course.lengthMeters % 40).toBe(0);
      expect(gridLatticeOffsetMeters(course.start, reference)).toBeCloseTo(0, 9);
      expect(gridLatticeOffsetMeters(course.end, reference)).toBeCloseTo(0, 9);
    }
  });

  it("draws mixed block sizes from one ratio ladder, never over the aspect bound", () => {
    const mixed = mixedGridDimensions({ columns: 3, rows: 2, ratios: [1, 1.5, 2], unitSteps: 2 });
    const smallest = Math.min(...mixed.columnWidths, ...mixed.rowHeights);
    const largest = Math.max(...mixed.columnWidths, ...mixed.rowHeights);
    expect(largest / smallest).toBeLessThanOrEqual(3);
    for (const size of [...mixed.columnWidths, ...mixed.rowHeights]) expect(size % GRID_LATTICE_SPACING_METERS).toBe(0);
    // The ratios are the parameter: a different ladder gives different blocks.
    const wider = mixedGridDimensions({ columns: 2, rows: 2, ratios: [1, 2], unitSteps: 2 });
    expect(wider.columnWidths).toEqual([80, 160]);
    // A ladder spanning more than the bound is refused rather than clamped.
    expect(() => mixedGridDimensions({ ratios: [1, 4], columns: 1, rows: 1 })).toThrow(/over the 3:1 bound/);
  });

  it("submits each grid line as one course, with no collinear neighbour anywhere", () => {
    // One street = one submission. A 200 m block edge next to another one must
    // NOT become 120+80+… on the same line: the continuation is the course the
    // world folds back.
    const segments = planRectangularGrid({
      anchor: { x: 0, z: 0 },
      columnWidths: [200, 200],
      rowHeights: [120, 200],
    });
    // 3 vertical lines + 3 horizontal lines.
    expect(segments).toHaveLength(3 + 3);
    expect(segments.filter((segment) => segment.orientation === "VERTICAL").every((segment) => segment.lengthMeters === 320)).toBe(true);
    expect(segments.filter((segment) => segment.orientation === "HORIZONTAL").every((segment) => segment.lengthMeters === 400)).toBe(true);
    // Two courses on one line would be collinear; there is exactly one per line.
    const perLine = new Map<string, number>();
    for (const segment of segments) {
      const key = `${segment.orientation}${segment.lineIndex}`;
      perLine.set(key, (perLine.get(key) ?? 0) + 1);
    }
    for (const count of perLine.values()) expect(count).toBe(1);
  });

  it("refuses a grid whose lines the native net contract cannot take in one segment", () => {
    // A line is one course, so the grid's extent along each axis is what has to
    // fit the native 8-1500 m range — over it the plan is refused rather than
    // emitted as a course the Bridge answers 400 to.
    expect(() => planRectangularGrid({
      anchor: { x: 0, z: 0 }, columnWidths: [800, 800], rowHeights: [80],
    })).toThrow(/single-segment range/);
    expect(() => planRectangularGrid({
      anchor: { x: 0, z: 0 }, columnWidths: [80], rowHeights: [800, 800],
    })).toThrow(/single-segment range/);
    expect(() => planRectangularGrid({
      anchor: { x: 0, z: 0 }, columnWidths: [1480], rowHeights: [80],
    })).not.toThrow();
    expect(MAX_SUPPORTED_NET_SEGMENT_LENGTH_METERS).toBe(1500);
  });

  it("plans the same courses from the same rectangle", () => {
    const input = { anchor: { x: 0, z: 0 }, columnWidths: [80, 80], rowHeights: [80, 80] };
    expect(JSON.stringify(planRectangularGrid(input))).toBe(JSON.stringify(planRectangularGrid(input)));
  });

  it("builds a collection whose ring is the perimeter and whose inside is subdivided", () => {
    const plan = planGridCollections({
      anchor: { x: 0, z: 0 },
      collections: [{ columnWidths: [80, 120, 80], rowHeights: [120, 80] }],
    });
    expect(plan.collections).toHaveLength(1);
    expect(plan.collections[0]!.widthMeters).toBe(280);
    expect(plan.collections[0]!.heightMeters).toBe(200);
    const ring = plan.segments.filter((segment) => segment.level === "ARTERIAL");
    const inside = plan.segments.filter((segment) => segment.level === "LOCAL");
    // 3 columns give 4 vertical lines: only 0 and 3 are ring. 2 rows give 3
    // horizontal lines: only 0 and 2 are ring.
    expect([...new Set(ring.filter((s) => s.orientation === "VERTICAL").map((s) => s.lineIndex))]).toEqual([0, 3]);
    expect([...new Set(ring.filter((s) => s.orientation === "HORIZONTAL").map((s) => s.lineIndex))]).toEqual([0, 2]);
    // Interior: vertical lines 1 and 2 + horizontal line 1.
    expect([...new Set(inside.filter((s) => s.orientation === "VERTICAL").map((s) => s.lineIndex))]).toEqual([1, 2]);
    expect(inside).toHaveLength(2 + 1);
    expect(ring.length + inside.length).toBe(plan.segments.length);
  });

  it("places collections side by side, sharing a boundary at gap 0 and separated at gap > 0", () => {
    const specs = [
      { columnWidths: [80, 80], rowHeights: [80] },
      { columnWidths: [80], rowHeights: [80] },
    ];
    const shared = planGridCollections({ anchor: { x: 0, z: 0 }, collections: specs, gapMeters: 0 });
    expect(shared.collections.map((c) => c.anchor.x)).toEqual([0, 160]);
    const separated = planGridCollections({ anchor: { x: 0, z: 0 }, collections: specs, gapMeters: 40 });
    expect(separated.collections.map((c) => c.anchor.x)).toEqual([0, 200]);
    const stacked = planGridCollections({ anchor: { x: 0, z: 0 }, collections: specs, direction: "COLUMN" });
    expect(stacked.collections.map((c) => c.anchor.z)).toEqual([0, 80]);
    expect(() => planGridCollections({ anchor: { x: 0, z: 0 }, collections: specs, gapMeters: 30 })).toThrow(/whole number of 40 m/);
  });

  it("drops a whole course when any part of it is water, and reports why", () => {
    const terrain = flatTerrain(0, 0, 400, 400);
    // A wet strip at x = 120..140 crosses the second vertical line and nothing else.
    for (let row = 0; row < terrain.resolution; row += 1) {
      for (let col = 0; col < terrain.resolution; col += 1) {
        const x = terrain.bounds.minX + (col + 0.5) * terrain.cellSize.x;
        if (x >= 120 && x <= 140) terrain.waterDepths[row * terrain.resolution + col] = 3;
      }
    }
    const plan = planGridCollections({
      anchor: { x: 0, z: 0 },
      collections: [{ columnWidths: [80, 80, 80], rowHeights: [120] }],
    });
    const report = reportGridCollectionsOnTerrain({ plan, terrain });
    expect(report).toHaveLength(1);
    expect(report[0]!.placeable).toBe(false);
    expect(report[0]!.waterRejected).toBeGreaterThan(0);
    const result = filterGridSegmentsByTerrain({ segments: plan.segments, terrain });
    expect(result.rejected.every((entry) => entry.reason === "WATER")).toBe(true);
    // The two horizontal lines span the whole 240 m width, so both cross the wet
    // strip at x 120..140; the four vertical lines at x = 0/80/160/240 miss it.
    expect(result.rejected).toHaveLength(2);
    for (const entry of result.rejected) {
      expect(entry.segment.orientation).toBe("HORIZONTAL");
      expect(entry.segment.start.x).toBeCloseTo(0, 6);
    }
    expect(result.kept.filter((segment) => segment.orientation === "VERTICAL")).toHaveLength(
      plan.segments.filter((segment) => segment.orientation === "VERTICAL").length,
    );
  });

  it("drops a course over the grade bound and keeps a gently sloping one", () => {
    const steep = flatTerrain(0, 0, 200, 200);
    for (let row = 0; row < steep.resolution; row += 1) {
      for (let col = 0; col < steep.resolution; col += 1) {
        steep.heights[row * steep.resolution + col] = row * 3; // 3 m per ~3 m cell ≈ 100%
      }
    }
    const plan = planGridCollections({ anchor: { x: 0, z: 0 }, collections: [{ columnWidths: [80], rowHeights: [80] }] });
    const steepResult = filterGridSegmentsByTerrain({ segments: plan.segments, terrain: steep });
    expect(steepResult.rejected.some((entry) => entry.reason === "STEEP_GRADE")).toBe(true);

    const gentle = flatTerrain(0, 0, 200, 200);
    for (let row = 0; row < gentle.resolution; row += 1) {
      for (let col = 0; col < gentle.resolution; col += 1) {
        gentle.heights[row * gentle.resolution + col] = col * 0.1; // ≈ 10% across
      }
    }
    const gentleResult = filterGridSegmentsByTerrain({ segments: plan.segments, terrain: gentle });
    expect(gentleResult.kept).toHaveLength(plan.segments.length);
  });

  it("rounds a golden-ratio ladder to whole lattice steps", () => {
    expect(goldenRatioLadder(3)[0]).toBeCloseTo(1, 9);
    expect(goldenRatioLadder(3)[1]).toBeCloseTo(1.618, 3);
    const sizes = mixedGridDimensions({ columns: 3, rows: 2, ratios: goldenRatioLadder(3), unitSteps: 5 });
    expect(sizes.columnWidths).toEqual([200, 320, 520]); // 5, 8, 13 lattice steps
    expect(Math.max(...sizes.columnWidths, ...sizes.rowHeights) / Math.min(...sizes.columnWidths, ...sizes.rowHeights)).toBeLessThanOrEqual(3);
  });

  it("refuses block sizes a course cannot measure", () => {
    expect(() => planRectangularGrid({
      anchor: { x: 0, z: 0 }, columnWidths: [60], rowHeights: [80],
    })).toThrow(/whole number of 40 m/);
  });

  it("anchors the collection on the 40 m lattice, so every line lands on a grid point", () => {
    // 落格 is a property of the PLAN, not of where the site happens to be: the
    // collection's corner is the lattice point nearest the site target, so a
    // planned line's endpoints are lattice points by construction.
    const candidates = buildRoadGridCandidates(baseInput([road(1, { x: 0, z: 0 }, { x: 80, z: 0 })]));
    const lines = candidates.filter((candidate) => candidate.finalSegmentLength === 120);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.gridAlignmentErrorMeters).toBeCloseTo(0, 9);
    for (const candidate of candidates) expect(candidate.gridAlignmentErrorMeters).toBeGreaterThanOrEqual(0);
  });
});
