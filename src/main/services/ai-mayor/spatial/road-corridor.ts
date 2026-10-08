/**
 * P4 — Road corridor planning: a bounded long-distance route search.
 *
 * This replaced a greedy one-step-with-a-lateral-fan walk. That walk could only
 * ever ask "is this single step legal", never "does this step bring the whole
 * route closer", so on real ground it went backwards as often as forwards (the
 * live measurement: 9 of 17 committed segments increased the distance to the
 * target, 2 sharp reversals, 279.5 m gained of ~740 m needed). A planner with no
 * cost over the whole route cannot detour, because detouring means accepting a
 * step that is further away — which is exactly what a per-step legality test
 * cannot express.
 *
 * It is a PLANNER and nothing else. It reads authoritative ground through a
 * bounded sampler the caller supplies, returns a route, waypoints and what is
 * still left to reach, and submits nothing: the selected corridor is compiled
 * into bounded legal segments and handed to the existing Gate1 Road step, which
 * keeps owning preview, durable command, Apply and readback.
 *
 * The search is deterministic A* over a coarse grid: fixed neighbour order, one
 * stable tie-break, no randomness anywhere. Every bound is explicit — expanded
 * cells, distinct ground samples, route length, and detour ratio — so a target
 * no corridor can reach ends the search with a named reason instead of running
 * away.
 */

import type { SpatialPoint2 } from "./types";

/**
 * The grade a planned road corridor may be built at.
 *
 * Stated once, here, because it is a property of ROADS rather than of any one
 * caller: a utility access corridor, a district access road and a frontage
 * street all cross the same ground under the same physical limit.
 */
export const ROAD_CORRIDOR_MAXIMUM_GRADE_PERCENT = 25;

/** Default coarse grid the route search runs on, in metres. */
export const ROAD_CORRIDOR_CELL_METERS = 25;
/** How close to an existing road, along its own bearing, a step may not be. */
const EXISTING_ROAD_ALIGNMENT_DEGREES = 20;
/** Default clearance from an existing road's line, in metres. */
export const ROAD_CORRIDOR_EXISTING_ROAD_CLEARANCE_METERS = 15;
/**
 * What running along an existing corridor costs, as a multiplier on that step.
 *
 * A cost and not a refusal: near its own start every corridor is close to the
 * road it leaves, and a planner that refused outright there could never begin. A
 * heavy penalty makes the search leave the corridor as soon as it cheaply can,
 * which is what native needs without making the first step impossible.
 */
const EXISTING_ROAD_ALIGNMENT_COST = 4;

/**
 * Degrees the corridor's FIRST segment must diverge from the bearing of the road
 * it leaves.
 *
 * The first segment is the one a Road step commits, and native folds a course
 * that continues a standing road's own line back into that road rather than
 * certifying a new one. Measured on the live world at the end node of a
 * just-built 114 m road: `proposalEdgeCount` 0 and
 * `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` at 0.0 and 0.5 degrees of divergence,
 * certified at 1.0 — and the same boundary at 300 m. Five degrees is that
 * boundary with five times the headroom, and small enough that the corridor is
 * still recognisably itself: a route collinear with the road it stands on
 * alternates a few degrees either side of its own direction instead of stalling
 * on its first hop forever.
 */
export const ROAD_CORRIDOR_DEPARTURE_DEGREES = 5;

export interface CorridorGround {
  height: number;
  waterDepth: number;
  /** Worst gradient to an orthogonal neighbour, in percent. */
  gradePercent: number;
}

export interface RoadCorridorInput {
  /** Where the corridor begins: a point on the current road network. */
  start: SpatialPoint2;
  /** Where it wants to end. */
  target: SpatialPoint2;
  /**
   * Authoritative ground at a position, or null when it was not observed.
   *
   * Supplied by the caller so the search can read the ground its route actually
   * needs instead of a mosaic fixed around the start — the second live limit.
   * `null` is "not observed" and is never treated as buildable.
   */
  sampleGround(point: SpatialPoint2): Promise<CorridorGround | null>;
  /** Where the corridor is allowed to be. */
  isOwned(point: SpatialPoint2): boolean;
  /**
   * The roads that already exist, as straight segments.
   *
   * A course laid along one of them is what native folds back into that edge
   * (`NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED`); a free heading is what certifies.
   * So alignment is priced, not forbidden.
   */
  existingRoads?: readonly { start: SpatialPoint2; end: SpatialPoint2 }[];
  /** Coarse grid the search runs on. */
  cellSizeMeters?: number;
  /** Total corridor ceiling, in metres. */
  maximumLength: number;
  /** One compiled segment's ceiling, in metres — never exceeded. */
  maximumSegmentLength: number;
  /** Grade a road may be built at, in percent. */
  maximumGradePercent: number;
  /** How much longer than the straight line the route may be. */
  maximumDetourRatio: number;
  /** Hard bounds. Running out is a refusal with a reason, not an open search. */
  maximumExpandedCells: number;
  maximumSamples: number;
  /**
   * Leave the start through this entrance, named by the plan that listed it.
   *
   * The entrance is the search's own first step, so a route planned this way is
   * the same planner's route under the same costs — not a course invented
   * beside it. It exists because which way a corridor leaves is only partly a
   * planning question: native certifies some exits and folds others, by local
   * topology the planner cannot see, and the way to answer that is to re-plan
   * from a different exit of the same route rather than to bend a course.
   */
  firstStep?: { col: number; row: number };
}

/** One way the search itself would leave its start. */
export interface RoadCorridorEntrance {
  col: number;
  row: number;
  /** Bearing of the step from the start centre to this cell's centre, in degrees. */
  bearingDegrees: number;
  /** The search's own cost to reach it plus its own estimate onward: lower is better. */
  f: number;
}

export interface RoadCorridorWaypoint extends SpatialPoint2 {
  /** Distance travelled along the cleaned route to reach this point. */
  travelled: number;
}

export interface RoadCorridorPlan {
  status: "PLANNED" | "NO_BOUNDED_CORRIDOR" | "ALREADY_REACHED";
  waypoints: RoadCorridorWaypoint[];
  /** The corridor compiled into bounded legal segments, in order. */
  segments: Array<{ start: SpatialPoint2; end: SpatialPoint2; length: number }>;
  /**
   * Every exit this search would accept at its start, best first.
   *
   * The same legal, owned, grade-checked, alignment-priced steps the search
   * itself chooses between, ordered by its own cost. A caller that has to answer
   * something the planner cannot — whether native certifies the first hop — asks
   * for the plan again under a different entrance from this list, so the
   * alternative is still this planner's route and not a second one.
   */
  entrances: RoadCorridorEntrance[];
  /** Straight-line distance from the last waypoint to the target. */
  remaining: number;
  reason: string;
  evidence: Record<string, number | string>;
}

const key = (col: number, row: number) => `${col},${row}`;

/** Deterministic binary heap: ties break on the insertion order. */
class BoundedHeap {
  #items: Array<{ f: number; h: number; order: number; col: number; row: number }> = [];
  #order = 0;
  get size(): number {
    return this.#items.length;
  }
  push(col: number, row: number, f: number, h: number): void {
    this.#items.push({ col, row, f, h, order: this.#order++ });
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#less(this.#items[index], this.#items[parent])) {
        [this.#items[index], this.#items[parent]] = [this.#items[parent], this.#items[index]];
        index = parent;
      } else break;
    }
  }
  pop(): { col: number; row: number; f: number; h: number; order: number } | undefined {
    const top = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length > 0 && last) {
      this.#items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.#items.length && this.#less(this.#items[left], this.#items[smallest])) smallest = left;
        if (right < this.#items.length && this.#less(this.#items[right], this.#items[smallest])) smallest = right;
        if (smallest === index) break;
        [this.#items[index], this.#items[smallest]] = [this.#items[smallest], this.#items[index]];
        index = smallest;
      }
    }
    return top;
  }
  #less(left: { f: number; h: number; order: number }, right: { f: number; h: number; order: number }): boolean {
    if (left.f !== right.f) return left.f < right.f;
    if (left.h !== right.h) return left.h < right.h;
    return left.order < right.order;
  }
}

/** The eight neighbours, in a fixed order so the search is reproducible. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1],
];

/**
 * Whether a step runs along an existing road corridor.
 *
 * Bearing-plus-proximity, deliberately not endpoint-based: the Bridge reports an
 * edge's start/end as trimmed curve endpoints rather than node positions, so an
 * edge's EXTENT can be short by tens of metres while its BEARING is unchanged.
 */
function runsAlongExistingRoad(
  step: { start: SpatialPoint2; end: SpatialPoint2 },
  roads: readonly { start: SpatialPoint2; end: SpatialPoint2 }[],
  clearance: number,
): boolean {
  const stepDx = step.end.x - step.start.x;
  const stepDz = step.end.z - step.start.z;
  const stepLength = Math.hypot(stepDx, stepDz);
  if (!(stepLength > 0)) return false;
  const midpoint = { x: (step.start.x + step.end.x) / 2, z: (step.start.z + step.end.z) / 2 };
  return roads.some((road) => {
    const dx = road.end.x - road.start.x;
    const dz = road.end.z - road.start.z;
    const length = Math.hypot(dx, dz);
    if (!(length > 0)) return false;
    const angle = Math.acos(Math.min(1, Math.abs((stepDx * dx + stepDz * dz) / (stepLength * length)))) * (180 / Math.PI);
    if (angle > EXISTING_ROAD_ALIGNMENT_DEGREES) return false;
    const distanceToLine = Math.abs((midpoint.x - road.start.x) * dz - (midpoint.z - road.start.z) * dx) / length;
    return distanceToLine <= clearance;
  });
}

/**
 * The bearings of the existing roads the corridor starts ON.
 *
 * Bearing only, deliberately: the scan reports an edge's start/end as trimmed
 * curve endpoints, so an edge's EXTENT can be short by tens of metres while its
 * BEARING is unchanged. What native folds back is a course that continues the
 * road's direction where it stands, so the direction is the whole fact.
 */
function standingRoadBearings(
  point: SpatialPoint2,
  roads: readonly { start: SpatialPoint2; end: SpatialPoint2 }[],
  clearance: number,
): number[] {
  const bearings: number[] = [];
  for (const road of roads) {
    const dx = road.end.x - road.start.x;
    const dz = road.end.z - road.start.z;
    const length = Math.hypot(dx, dz);
    if (!(length > 0)) continue;
    const ratio = Math.max(0, Math.min(1,
      ((point.x - road.start.x) * dx + (point.z - road.start.z) * dz) / (length * length)));
    const distance = Math.hypot(point.x - (road.start.x + ratio * dx), point.z - (road.start.z + ratio * dz));
    if (distance <= clearance) bearings.push(Math.atan2(dz, dx));
  }
  return bearings;
}

/** Whether a segment leaves those bearings by at least `margin` degrees, either side. */
function departsFromBearings(
  segment: { start: SpatialPoint2; end: SpatialPoint2 },
  bearings: readonly number[],
  margin: number,
): boolean {
  const dx = segment.end.x - segment.start.x;
  const dz = segment.end.z - segment.start.z;
  const length = Math.hypot(dx, dz);
  if (!(length > 0)) return false;
  const cosine = Math.cos((margin * Math.PI) / 180);
  return bearings.every((bearing) =>
    Math.abs((dx / length) * Math.cos(bearing) + (dz / length) * Math.sin(bearing)) <= cosine);
}

/** One searched cell's authoritative facts, cached by the search. */
interface CellFacts {
  legal: boolean;
  alongExistingRoad: boolean;
  reason: string;
}

export async function planRoadCorridor(input: RoadCorridorInput): Promise<RoadCorridorPlan> {
  const cellSize = input.cellSizeMeters ?? ROAD_CORRIDOR_CELL_METERS;
  const straight = Math.hypot(input.target.x - input.start.x, input.target.z - input.start.z);
  const evidence: Record<string, number | string> = {
    startToTarget: Number(straight.toFixed(1)),
    cellSizeMeters: cellSize,
    maximumLength: input.maximumLength,
    maximumDetourRatio: input.maximumDetourRatio,
  };
  const refuse = (
    reason: string,
    extra: Record<string, number | string> = {},
    waypoints: RoadCorridorWaypoint[] = [],
    entrances: RoadCorridorEntrance[] = [],
  ) => ({
    status: "NO_BOUNDED_CORRIDOR" as const,
    waypoints,
    segments: compileSegments(waypoints, input.maximumSegmentLength),
    entrances,
    remaining: Math.hypot(input.target.x - (waypoints.at(-1)?.x ?? input.start.x),
      input.target.z - (waypoints.at(-1)?.z ?? input.start.z)),
    reason,
    evidence: { ...evidence, ...extra },
  });
  if (straight <= cellSize) {
    return {
      status: "ALREADY_REACHED",
      waypoints: [{ ...input.start, travelled: 0 }, { ...input.target, travelled: straight }],
      segments: [{ start: input.start, end: input.target, length: straight }],
      // No exit was searched for: the target is inside one cell, so this plan
      // has no entrance to choose between.
      entrances: [],
      remaining: 0,
      reason: `the target is ${straight.toFixed(1)}m away, inside one cell`,
      evidence,
    };
  }

  const cellOf = (point: SpatialPoint2) => ({ col: Math.floor(point.x / cellSize), row: Math.floor(point.z / cellSize) });
  const centreOf = (col: number, row: number) => ({ x: (col + 0.5) * cellSize, z: (row + 0.5) * cellSize });
  const startCell = cellOf(input.start);
  const goalCell = cellOf(input.target);

  // Ground is read on demand and cached per CELL, so the route the search is
  // considering is what gets read — not a mosaic fixed around the start. The
  // sample budget is the hard bound on how much world the search may look at.
  const facts = new Map<string, CellFacts>();
  let samples = 0;
  let samplesExhausted = false;
  const factsOf = async (col: number, row: number): Promise<CellFacts> => {
    const id = key(col, row);
    const cached = facts.get(id);
    if (cached) return cached;
    if (samples >= input.maximumSamples) {
      samplesExhausted = true;
      const unknown: CellFacts = { legal: false, alongExistingRoad: false, reason: "SAMPLE_BUDGET_EXHAUSTED" };
      return unknown;
    }
    samples += 1;
    const point = centreOf(col, row);
    const ground = await input.sampleGround(point);
    let verdict: CellFacts;
    if (!ground) verdict = { legal: false, alongExistingRoad: false, reason: "NOT_OBSERVED" };
    else if (ground.waterDepth > 0.05) verdict = { legal: false, alongExistingRoad: false, reason: "WATER" };
    else if (ground.gradePercent > input.maximumGradePercent) {
      verdict = { legal: false, alongExistingRoad: false, reason: "SLOPE" };
    } else if (!input.isOwned(point)) verdict = { legal: false, alongExistingRoad: false, reason: "NOT_OWNED" };
    else {
      // Being near a road is priced, not forbidden: every corridor starts at
      // one, and a planner that refused outright there could never begin.
      verdict = {
        legal: true,
        alongExistingRoad: (input.existingRoads ?? []).some((road) => {
          const dx = road.end.x - road.start.x;
          const dz = road.end.z - road.start.z;
          const length = Math.hypot(dx, dz);
          if (!(length > 0)) return false;
          const distanceToLine = Math.abs((point.x - road.start.x) * dz - (point.z - road.start.z) * dx) / length;
          return distanceToLine <= ROAD_CORRIDOR_EXISTING_ROAD_CLEARANCE_METERS;
        }),
        reason: "LEGAL",
      };
    }
    facts.set(id, verdict);
    return verdict;
  };

  const open = new BoundedHeap();
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();
  const cellByKey = new Map<string, { col: number; row: number }>();
  const h = (col: number, row: number) =>
    Math.hypot((col + 0.5) * cellSize - input.target.x, (row + 0.5) * cellSize - input.target.z);
  cellByKey.set(key(startCell.col, startCell.row), startCell);
  cellByKey.set(key(goalCell.col, goalCell.row), goalCell);
  gScore.set(key(startCell.col, startCell.row), 0);
  open.push(startCell.col, startCell.row, h(startCell.col, startCell.row), h(startCell.col, startCell.row));

  const startFacts = await factsOf(startCell.col, startCell.row);
  if (!startFacts.legal && startFacts.reason !== "SAMPLE_BUDGET_EXHAUSTED") {
    // The start is where the corridor leaves the network; a start the search
    // cannot stand on means it has nothing to plan from, which is a real answer.
    return refuse(`the corridor's start is not buildable: ${startFacts.reason}`, { samples, expandedCells: 0 });
  }

  // The exits this search would accept here, scored the way it is about to score
  // them: the same eight legal, owned, grade-checked, alignment-priced steps it
  // chooses between, ordered by the same `g + h`. Reported so a caller that has
  // to answer a question the planner cannot — whether native certifies the first
  // hop — can re-plan from a different exit of the SAME route rather than bend
  // the course it was given.
  const entrances: RoadCorridorEntrance[] = [];
  for (const [dc, dr] of NEIGHBOURS) {
    const col = startCell.col + dc;
    const row = startCell.row + dr;
    const verdict = await factsOf(col, row);
    if (!verdict.legal) continue;
    const stepLength = Math.hypot(dc, dr) * cellSize;
    const stepAligned = (input.existingRoads?.length ?? 0) > 0 &&
      runsAlongExistingRoad({ start: centreOf(startCell.col, startCell.row), end: centreOf(col, row) },
        input.existingRoads ?? [], ROAD_CORRIDOR_EXISTING_ROAD_CLEARANCE_METERS);
    const cost = stepLength * ((verdict.alongExistingRoad || stepAligned) ? EXISTING_ROAD_ALIGNMENT_COST : 1);
    const point = centreOf(col, row);
    entrances.push({
      col, row, f: cost + h(col, row),
      bearingDegrees: Number((((Math.atan2(point.z - input.start.z, point.x - input.start.x) * 180) / Math.PI).toFixed(2))),
    });
  }
  entrances.sort((left, right) => left.f - right.f || left.col - right.col || left.row - right.row);

  let expanded = 0;
  let solved = false;
  const closed = new Set<string>();
  while (open.size > 0 && expanded < input.maximumExpandedCells) {
    const current = open.pop();
    if (!current) break;
    const currentKey = key(current.col, current.row);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    expanded += 1;
    if (current.col === goalCell.col && current.row === goalCell.row) {
      solved = true;
      break;
    }
    const base = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY;
    const leavingStart = currentKey === key(startCell.col, startCell.row);
    for (const [dc, dr] of NEIGHBOURS) {
      const col = current.col + dc;
      const row = current.row + dr;
      // A caller that named an entrance gets the route that leaves by it, and
      // only that one: the exits are alternatives, not a fan to search through.
      if (leavingStart && input.firstStep && (col !== input.firstStep.col || row !== input.firstStep.row)) continue;
      const id = key(col, row);
      if (closed.has(id)) continue;
      const verdict = await factsOf(col, row);
      if (!verdict.legal) continue;
      if (!cellByKey.has(id)) cellByKey.set(id, { col, row });
      const stepLength = Math.hypot(dc, dr) * cellSize;
      // Route-level cost, not just legality: distance, plus what running beside
      // an existing corridor costs. This is the term the old walk did not have,
      // and without it the search could not prefer a detour over a straight line
      // it cannot legally build.
      const stepAligned = (input.existingRoads?.length ?? 0) > 0 &&
        runsAlongExistingRoad({ start: centreOf(current.col, current.row), end: centreOf(col, row) },
          input.existingRoads ?? [], ROAD_CORRIDOR_EXISTING_ROAD_CLEARANCE_METERS);
      const stepCost = stepLength * ((verdict.alongExistingRoad || stepAligned) ? EXISTING_ROAD_ALIGNMENT_COST : 1);
      const tentative = base + stepCost;
      if (tentative >= (gScore.get(id) ?? Number.POSITIVE_INFINITY)) continue;
      if (tentative > input.maximumLength) continue;
      gScore.set(id, tentative);
      cameFrom.set(id, currentKey);
      open.push(col, row, tentative + h(col, row), h(col, row));
    }
  }

  if (!solved) {
    const reason = samplesExhausted ? "the ground sample budget was exhausted before a route was found"
      : expanded >= input.maximumExpandedCells ? "the cell expansion budget was exhausted before a route was found"
        : "no legal corridor connects the start to the target";
    return refuse(reason, { samples, expandedCells: expanded, sampledCells: facts.size }, [], entrances);
  }

  // Rebuild the route, then clean it: collinear points and any point a straight
  // legal segment can replace are dropped, which is what removes the sawtooth a
  // grid search otherwise leaves behind.
  const raw: Array<{ col: number; row: number }> = [];
  let cursor: string | undefined = key(goalCell.col, goalCell.row);
  while (cursor) {
    const cell = cellByKey.get(cursor);
    if (cell) raw.unshift(cell);
    cursor = cameFrom.get(cursor);
  }
  const cleaned = await simplifyRoute(raw, input, factsOf, cellOf, cellSize);
  const gridPoints: SpatialPoint2[] = [];
  for (const [index, cell] of cleaned.entries()) {
    const point = centreOf(cell.col, cell.row);
    if (index > 0) gridPoints.push(point);
  }
  if (gridPoints.length === 0) return refuse("the search produced an empty route", { samples, expandedCells: expanded }, [], entrances);
  // The compiled first segment is the one the Road step commits, so it is the
  // one native has to certify — and native folds a course that continues the
  // road the corridor starts on back into that road. A route whose first hop is
  // a grid step that happens to land on the road's own line is therefore a hop
  // no Road step can ever commit, and because each hop begins where the last one
  // ended, the whole corridor stalls on it. Re-aiming the first waypoint fixes
  // that without touching the route: the waypoint keeps its distance from the
  // start, so the corridor is still the corridor.
  const streetBearings = standingRoadBearings(input.start, input.existingRoads ?? [],
    ROAD_CORRIDOR_EXISTING_ROAD_CLEARANCE_METERS);
  const firstSegmentEnd = (to: SpatialPoint2) => {
    const length = Math.hypot(to.x - input.start.x, to.z - input.start.z);
    const pieces = Math.max(1, Math.ceil(length / input.maximumSegmentLength));
    return { x: input.start.x + (to.x - input.start.x) / pieces,
      z: input.start.z + (to.z - input.start.z) / pieces };
  };
  const points: SpatialPoint2[] = [...gridPoints];
  // A named entrance is honoured by re-aiming the first waypoint onto its
  // bearing at the SAME distance — the rotation the departure rule below already
  // performs, for the same reason, and it keeps the hop length the route wanted.
  //
  // Not by pinning the entrance cell in front of the route: `simplifyRoute` is
  // free to replace any point a straight legal line can reach, so a first step
  // that merely differs from the route's own is shortcut away and the compiled
  // first segment comes back identical. Measured live (2026-10-01): four
  // different entrances produced the same 94.8 m @39.0 degrees hop.
  if (input.firstStep) {
    const entrancePoint = centreOf(input.firstStep.col, input.firstStep.row);
    const bearing = Math.atan2(entrancePoint.z - input.start.z, entrancePoint.x - input.start.x);
    const dx = points[0].x - input.start.x;
    const dz = points[0].z - input.start.z;
    const radius = Math.hypot(dx, dz);
    const aimed = { x: input.start.x + Math.cos(bearing) * radius, z: input.start.z + Math.sin(bearing) * radius };
    // A named exit that cannot be left by is not this exit. Refused by name
    // rather than quietly handing back the route's own first hop: a caller that
    // asked for a specific exit has to be able to tell "this one is unavailable"
    // from "here is the exchange you asked for".
    if (!(await factsOf(cellOf(aimed).col, cellOf(aimed).row)).legal) {
      return refuse(`the named entrance at (${entrancePoint.x.toFixed(1)}, ${entrancePoint.z.toFixed(1)}) ` +
        `cannot be left by: its aim is not buildable`,
      { samples, expandedCells: 0 }, [], entrances);
    }
    // Unshifted, never substituted: the route still reaches its target through
    // the waypoint it already had, and the leg back to that waypoint is simply
    // the first bend of the corridor.
    points.unshift(aimed);
  }
  if (streetBearings.length > 0 &&
    !departsFromBearings({ start: input.start, end: firstSegmentEnd(points[0]) }, streetBearings,
      ROAD_CORRIDOR_DEPARTURE_DEGREES)) {
    const dx = points[0].x - input.start.x;
    const dz = points[0].z - input.start.z;
    let departed: SpatialPoint2 | null = null;
    for (const steps of [1, 2, 3, 4]) {
      for (const sign of [1, -1]) {
        const angle = (sign * steps * ROAD_CORRIDOR_DEPARTURE_DEGREES * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const candidate = { x: input.start.x + dx * cos - dz * sin, z: input.start.z + dx * sin + dz * cos };
        if (!departsFromBearings({ start: input.start, end: firstSegmentEnd(candidate) }, streetBearings,
          ROAD_CORRIDOR_DEPARTURE_DEGREES)) continue;
        if (!(await factsOf(cellOf(candidate).col, cellOf(candidate).row)).legal) continue;
        departed = candidate;
        break;
      }
      if (departed) break;
    }
    if (!departed) {
      return refuse("the corridor's first segment cannot leave the road it starts on", { samples, expandedCells: expanded }, [], entrances);
    }
    // Kept as an extra waypoint rather than replacing one: the route still
    // reaches its target, and the segment back to the original waypoint is
    // simply the first bend of the corridor.
    points.unshift(departed);
  }
  let travelled = 0;
  const start: RoadCorridorWaypoint = { ...input.start, travelled: 0 };
  const waypoints: RoadCorridorWaypoint[] = [start];
  for (const point of points) {
    travelled += Math.hypot(point.x - waypoints[waypoints.length - 1].x, point.z - waypoints[waypoints.length - 1].z);
    waypoints.push({ ...point, travelled });
  }
  const routeLength = travelled;
  const detourRatio = routeLength / straight;
  if (routeLength > input.maximumLength) {
    return refuse(`the route is ${routeLength.toFixed(1)}m, beyond the ${input.maximumLength}m ceiling`,
      { samples, expandedCells: expanded, routeLength: Number(routeLength.toFixed(1)) }, waypoints, entrances);
  }
  if (detourRatio > input.maximumDetourRatio) {
    return refuse(`the route is ${detourRatio.toFixed(2)}x the straight line, beyond the ` +
      `${input.maximumDetourRatio}x detour ceiling`,
      { samples, expandedCells: expanded, routeLength: Number(routeLength.toFixed(1)) }, waypoints, entrances);
  }
  const remaining = Math.hypot(input.target.x - (waypoints.at(-1)?.x ?? input.start.x),
    input.target.z - (waypoints.at(-1)?.z ?? input.start.z));
  const segments = compileSegments(waypoints, input.maximumSegmentLength);
  return {
    status: "PLANNED",
    waypoints,
    segments,
    // The exits are the same set whichever one this plan took: they describe the
    // start, not the route.
    entrances,
    remaining,
    reason: `the corridor reaches the target in ${segments.length} bounded segment(s) over ` +
      `${routeLength.toFixed(1)}m (${detourRatio.toFixed(2)}x straight)`,
    evidence: { ...evidence, samples, expandedCells: expanded, sampledCells: facts.size,
      waypoints: waypoints.length, segments: segments.length,
      routeLength: Number(routeLength.toFixed(1)), detourRatio: Number(detourRatio.toFixed(2)),
      longestSegment: Number(Math.max(0, ...segments.map((segment) => segment.length)).toFixed(1)) },
  };
}

/**
 * Drop every waypoint a straight legal line can replace.
 *
 * A grid search returns a staircase. Removing collinear points alone leaves the
 * staircase's corners, so each candidate shortcut is also checked against the
 * ground it would cross — a simplification that is only allowed to be as good as
 * the route it replaces, never worse.
 */
async function simplifyRoute(
  cells: ReadonlyArray<{ col: number; row: number }>,
  input: RoadCorridorInput,
  factsOf: (col: number, row: number) => Promise<CellFacts>,
  cellOf: (point: SpatialPoint2) => { col: number; row: number },
  cellSize: number,
): Promise<Array<{ col: number; row: number }>> {
  if (cells.length <= 2) return [...cells];
  const centreOf = (cell: { col: number; row: number }) => ({ x: (cell.col + 0.5) * cellSize, z: (cell.row + 0.5) * cellSize });
  const clear = async (from: { col: number; row: number }, to: { col: number; row: number }): Promise<boolean> => {
    const a = centreOf(from);
    const b = centreOf(to);
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (cellSize / 2)));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      const cell = cellOf({ x: a.x + (b.x - a.x) * ratio, z: a.z + (b.z - a.z) * ratio });
      if (!(await factsOf(cell.col, cell.row)).legal) return false;
    }
    return true;
  };
  const simplified: Array<{ col: number; row: number }> = [cells[0]];
  let anchor = 0;
  for (let index = 2; index < cells.length; index += 1) {
    if (!(await clear(cells[anchor], cells[index]))) {
      simplified.push(cells[index - 1]);
      anchor = index - 1;
    }
  }
  simplified.push(cells[cells.length - 1]);
  return simplified;
}

/**
 * Compile a waypoint route into bounded legal segments.
 *
 * A waypoint hop that exceeds one segment's legal length is split at equal
 * fractions rather than left long: the Road step may commit bounded segments
 * only, so the compilation is where that ceiling is enforced — not at the step
 * that produced the route.
 */
function compileSegments(
  waypoints: readonly RoadCorridorWaypoint[],
  maximumSegmentLength: number,
): Array<{ start: SpatialPoint2; end: SpatialPoint2; length: number }> {
  const segments: Array<{ start: SpatialPoint2; end: SpatialPoint2; length: number }> = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const from = waypoints[index - 1];
    const to = waypoints[index];
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    if (!(length > 0)) continue;
    const pieces = Math.max(1, Math.ceil(length / maximumSegmentLength));
    let previous: SpatialPoint2 = { x: from.x, z: from.z };
    for (let piece = 1; piece <= pieces; piece += 1) {
      const ratio = piece / pieces;
      const end = { x: from.x + (to.x - from.x) * ratio, z: from.z + (to.z - from.z) * ratio };
      segments.push({ start: previous, end, length: Math.hypot(end.x - previous.x, end.z - previous.z) });
      previous = end;
    }
  }
  return segments;
}
