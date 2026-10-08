import type { SpatialLocalTerrain, SpatialPoint2 } from "../spatial/types";
import { DISTRICT_ROAD_GRADE_PERCENT, sampleTerrain } from "./district-land";

/**
 * THE FRONTAGE ROAD — a way in for a building the game says has no road, laid the way a player lays it: ending at the MIDDLE OF THE BUILDING'S FRONT
 * EDGE and running PARALLEL to that edge, so the building touches the road and the road never runs into the building (live 2026-10-06: two signature
 * offices stood with no road because every candidate road ended on the notice point, inside the lot, and the game refused it as "Overlap Existing
 * <the building itself>"; the same two were also refused for "Steep Slope").
 *
 * Geometry: the notice stands at the middle of the front edge, so the way out of the building is `centre -> notice`. The road's centre line is that
 * point pushed outward by half a road width plus a margin, and runs along the edge (perpendicular to the way out) for `lengthMeters`. It is reached from
 * the nearest street by an approach road to the nearer end of that run.
 *
 * Slope: the approach is checked against the terrain read. Straight if it is gentle enough; else along the contour (one bend, a waypoint sideways of the
 * straight line, chosen where the steepest stretch is least); else a switchback of two or three bends. The game's own dry run still decides every piece.
 */
export interface FrontageSegment { start: SpatialPoint2; end: SpatialPoint2 }

export interface FrontageCourse {
  reason: string;
  /** Laid in this order; each starts where the one before ended (the first starts at the street). */
  segments: FrontageSegment[];
  /** The steepest stretch of the approach, percent; null when the terrain could not be read. */
  maxGradePercent: number | null;
}

export const FRONTAGE_HALF_ROAD_METERS = 4;
export const FRONTAGE_MARGIN_METERS = 3;
export const FRONTAGE_RUN_METERS = 24;
/** Metres from the notices' line to the road's centre line, in the order offered: a small building's, then wider. */
export const FRONTAGE_CLEARANCES_METERS: readonly number[] = [FRONTAGE_HALF_ROAD_METERS + FRONTAGE_MARGIN_METERS, 13, 20];
/** A big building (several notices): its entrances stand inside the lot, so the clear ones come first. */
export const FRONTAGE_BIG_CLEARANCES_METERS: readonly number[] = [13, 20, FRONTAGE_HALF_ROAD_METERS + FRONTAGE_MARGIN_METERS];
/** Metres between height samples along a road. */
export const GRADE_SAMPLE_METERS = 4;

const length = (a: SpatialPoint2, b: SpatialPoint2) => Math.hypot(b.x - a.x, b.z - a.z);
/** Distance from a point to a segment. */
function distanceToSegment(point: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2): number {
  const dx = b.x - a.x; const dz = b.z - a.z; const squared = dx * dx + dz * dz;
  const ratio = squared > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / squared)) : 0;
  return Math.hypot(point.x - (a.x + dx * ratio), point.z - (a.z + dz * ratio));
}
const lerp = (a: SpatialPoint2, b: SpatialPoint2, ratio: number): SpatialPoint2 => ({ x: a.x + (b.x - a.x) * ratio, z: a.z + (b.z - a.z) * ratio });

/** The steepest stretch (percent, over `GRADE_SAMPLE_METERS`) of a road from `start` to `end`, or null when a sample falls outside the terrain read. */
export function maxGradePercent(terrain: SpatialLocalTerrain | undefined, start: SpatialPoint2, end: SpatialPoint2): number | null {
  const total = length(start, end);
  if (total < 1e-6) return 0;
  const steps = Math.max(1, Math.ceil(total / GRADE_SAMPLE_METERS));
  let previous = sampleTerrain(terrain, start);
  if (!previous) return null;
  let steepest = 0;
  for (let step = 1; step <= steps; step += 1) {
    const point = lerp(start, end, step / steps);
    const reading = sampleTerrain(terrain, point);
    if (!reading) return null;
    steepest = Math.max(steepest, (Math.abs(reading.height - previous.height) / (total / steps)) * 100);
    previous = reading;
  }
  return steepest;
}

/** The steepest stretch over a polyline of waypoints. */
function pathGrade(terrain: SpatialLocalTerrain | undefined, points: readonly SpatialPoint2[]): number | null {
  let steepest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const grade = maxGradePercent(terrain, points[index - 1]!, points[index]!);
    if (grade === null) return null;
    steepest = Math.max(steepest, grade);
  }
  return steepest;
}

export interface FrontageInput {
  /** The building's centre and the point the game hangs its notice at (the middle of the front edge). */
  centre: SpatialPoint2;
  notice: SpatialPoint2;
  /** The nearest point of the street network to the notice. */
  street: SpatialPoint2;
  terrain?: SpatialLocalTerrain;
  maximumGradePercent?: number;
  runMeters?: number;
  /**
   * The other notices of the SAME building. A big building (a recycling centre: a front 144 m long, entrances every ~60 m) hangs one notice at every
   * entrance, not one in the middle; a 24 m stub at one of them leaves the others without a road (live 2026-10-07: a recycling centre with a 53 m road to
   * its middle kept ten access icons). With siblings the run covers all the entrances, and the way out is read from their middle.
   */
  siblings?: readonly SpatialPoint2[];
}

/** A street end this far out from the notices' line (and within the run) anchors the run: it is the stub of an access road that stopped short. The game accepted 12 m and refused 11 m (the road with its footpaths must clear the lot). */
export const FRONTAGE_ANCHOR_MINIMUM_METERS = 11.5;
export const FRONTAGE_ANCHOR_MAXIMUM_METERS = 24;
export const FRONTAGE_STUB_MINIMUM_METERS = 14;
export const FRONTAGE_STUB_MAXIMUM_METERS = 40;
export const FRONTAGE_STUB_CLEARANCE_METERS = 12.2;
/** The longest front a run is laid along (a road past this is no frontage road). */
export const FRONTAGE_MAXIMUM_RUN_METERS = 220;
/** The run reaches this far past the outermost entrance. */
export const FRONTAGE_RUN_PADDING_METERS = 12;

/**
 * The courses to try, the cheapest first: straight approaches (both ends of the run, both ways round), then along the contour, then switchbacks. A course
 * whose steepest stretch is known to exceed the limit is not offered; one whose slope could not be read is offered last (the game's dry run judges it).
 */
export function frontageCourses(input: FrontageInput): FrontageCourse[] {
  const limit = input.maximumGradePercent ?? DISTRICT_ROAD_GRADE_PERCENT;
  let run = input.runMeters ?? FRONTAGE_RUN_METERS;
  // With the building's other notices the front is read from their middle, and the way out snapped to the nearest axis when it is within 20 degrees of one
  // (the Mayor and the game place buildings square to the grid): a notice at one end of a long front would otherwise slant the whole run.
  const siblings = input.siblings ?? [];
  const everyNotice = [input.notice, ...siblings];
  const heart = siblings.length > 0
    ? { x: everyNotice.reduce((sum, point) => sum + point.x, 0) / everyNotice.length, z: everyNotice.reduce((sum, point) => sum + point.z, 0) / everyNotice.length } : input.notice;
  const outwardLength = length(input.centre, heart);
  if (outwardLength < 1) return [];
  let out = { x: (heart.x - input.centre.x) / outwardLength, z: (heart.z - input.centre.z) / outwardLength };
  if (siblings.length > 0) {
    const axis = Math.abs(out.x) >= Math.abs(out.z) ? { x: Math.sign(out.x) || 1, z: 0 } : { x: 0, z: Math.sign(out.z) || 1 };
    if (out.x * axis.x + out.z * axis.z >= Math.cos((20 * Math.PI) / 180)) out = axis;
  }
  const along = { x: -out.z, z: out.x };
  // The run covers every entrance: from the outermost to the outermost, padded, centred on them.
  let shift = 0;
  if (siblings.length > 0) {
    const spread = everyNotice.map((point) => (point.x - heart.x) * along.x + (point.z - heart.z) * along.z);
    const low = Math.min(...spread); const high = Math.max(...spread);
    run = Math.min(FRONTAGE_MAXIMUM_RUN_METERS, Math.max(run, high - low + 2 * FRONTAGE_RUN_PADDING_METERS));
    shift = (low + high) / 2;
  }
  const frontLine = { x: heart.x + along.x * shift, z: heart.z + along.z * shift };
  const courses: FrontageCourse[] = [];
  const rank = new Map<FrontageCourse, number>();
  // The road runs outside the notices' line. How far out is not the same for every building: a notice at the middle of a small building's front edge
  // wants 7 m (half a road plus a margin), but the entrances of a big one stand 4 m INSIDE the lot, and the road (with its footpaths) then overlaps the lot
  // until it is 13 m out (measured live 2026-10-07 by the game's own dry run: x = -498 refused, -500 accepted, notices at -487). Each clearance is offered.
  const clearances = siblings.length > 0 ? FRONTAGE_BIG_CLEARANCES_METERS : FRONTAGE_CLEARANCES_METERS;
  // The street already ENDS in front of the building (the stub the first access road left, 8-20 m short of the front): the run goes through that very end,
  // both ways along the front, so it joins the end exactly (live 2026-10-07 by the game's dry run: a run 1 m beside such an end was refused at every length,
  // and the two halves starting AT the end were accepted).
  const reach = { x: input.street.x - frontLine.x, z: input.street.z - frontLine.z };
  const outward = reach.x * out.x + reach.z * out.z;
  const position = reach.x * along.x + reach.z * along.z;
  // The street's end is further out (14-40 m): a short stub from the lot's clear edge (11.5 m out) straight to that end, laid from the free point onto the node.
  // The game attached a building to a road end 8-12 m from its front; a road along the front is refused there (live 2026-10-07: a landfill 17-20 m from the road).
  if (outward > FRONTAGE_STUB_MINIMUM_METERS && outward <= FRONTAGE_STUB_MAXIMUM_METERS && Math.abs(position) <= run / 2 + FRONTAGE_RUN_PADDING_METERS) {
    const startOut = FRONTAGE_STUB_CLEARANCE_METERS;
    // A piece shorter than ~8.5 m is not an edge the game identifies, and 11.5 m out is the nearest the lot lets a road start: the stub slants 10 m sideways.
    const lateral = position - (position >= 0 ? 10 : -10);
    const from = { x: frontLine.x + out.x * startOut + along.x * lateral, z: frontLine.z + out.z * startOut + along.z * lateral };
    courses.push({ reason: "frontage:stub-to-street-end", segments: [{ start: from, end: input.street }], maxGradePercent: maxGradePercent(input.terrain, from, input.street) });
  }
  if (outward >= FRONTAGE_ANCHOR_MINIMUM_METERS && outward <= FRONTAGE_ANCHOR_MAXIMUM_METERS && outward <= FRONTAGE_STUB_MINIMUM_METERS && Math.abs(position) <= run / 2 + FRONTAGE_RUN_PADDING_METERS) {
    const halves = [-run / 2 - position, run / 2 - position].filter((span) => Math.abs(span) >= 8)
      // Laid FROM the free far end TO the street's end: a course that starts on an existing node is refused by the real build (NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED,
      // live 2026-10-07, though its dry run passed); one that ends on it is not.
      .map((span) => ({ start: { x: input.street.x + along.x * span, z: input.street.z + along.z * span }, end: input.street }));
    if (halves.length > 0) courses.push({ reason: "frontage:anchored-on-street-end", segments: halves, maxGradePercent: 0 });
  }
  for (const [clearanceRank, clearance] of clearances.entries()) {
  const middle = { x: frontLine.x + out.x * clearance, z: frontLine.z + out.z * clearance };
  const ends = [
    { x: middle.x - along.x * run / 2, z: middle.z - along.z * run / 2 },
    { x: middle.x + along.x * run / 2, z: middle.z + along.z * run / 2 },
  ].sort((a, b) => length(a, input.street) - length(b, input.street));
  const tag = clearanceRank === 0 ? "" : `@${clearance}m`;
  const first = courses.length;
  // The street already ends at the front of the building: the run alone meets it (a short stub of road is all that is missing).
  if (distanceToSegment(input.street, ends[0]!, ends[1]!) < 6) courses.push({ reason: `frontage:along-the-street-end${tag}`, segments: [{ start: ends[0]!, end: ends[1]! }], maxGradePercent: 0 });
  for (const [index, near] of ends.entries()) {
    const far = ends[1 - index]!;
    const frontage: FrontageSegment = { start: near, end: far };
    const approachLength = length(input.street, near);
    // Straight.
    courses.push({ reason: `frontage:straight:${index === 0 ? "near" : "far"}-end${tag}`, segments: approachLength < 8 ? [frontage] : [{ start: input.street, end: near }, frontage],
      maxGradePercent: approachLength < 8 ? 0 : maxGradePercent(input.terrain, input.street, near) });
    if (approachLength < 8) continue;
    // Along the contour: one bend, a waypoint to the side of the straight line, where the steepest stretch is least.
    const direction = { x: (near.x - input.street.x) / approachLength, z: (near.z - input.street.z) / approachLength };
    const side = { x: -direction.z, z: direction.x };
    const bends: Array<{ waypoint: SpatialPoint2; grade: number | null }> = [];
    for (const offset of [-60, -40, -25, 25, 40, 60]) {
      const waypoint = { x: input.street.x + direction.x * approachLength * 0.5 + side.x * offset, z: input.street.z + direction.z * approachLength * 0.5 + side.z * offset };
      bends.push({ waypoint, grade: pathGrade(input.terrain, [input.street, waypoint, near]) });
    }
    const best = bends.filter((bend) => bend.grade !== null).sort((a, b) => a.grade! - b.grade!)[0];
    if (best) courses.push({ reason: `frontage:contour:${index === 0 ? "near" : "far"}-end${tag}`, segments: [{ start: input.street, end: best.waypoint }, { start: best.waypoint, end: near }, frontage], maxGradePercent: best.grade });
    // Switchback: two and three bends, alternating sides.
    for (const bendCount of [2, 3]) {
      const waypoints: SpatialPoint2[] = [];
      for (let bend = 1; bend <= bendCount; bend += 1) {
        const ratio = bend / (bendCount + 1);
        const sign = bend % 2 === 1 ? 1 : -1;
        waypoints.push({ x: input.street.x + direction.x * approachLength * ratio + side.x * 30 * sign, z: input.street.z + direction.z * approachLength * ratio + side.z * 30 * sign });
      }
      const points = [input.street, ...waypoints, near];
      courses.push({ reason: `frontage:switchback${bendCount}:${index === 0 ? "near" : "far"}-end${tag}`,
        segments: [...points.slice(1).map((end, at) => ({ start: points[at]!, end })), frontage], maxGradePercent: pathGrade(input.terrain, points) });
    }
  }
  for (let at = first; at < courses.length; at += 1) rank.set(courses[at]!, clearanceRank);
  }
  const known = courses.filter((course) => course.maxGradePercent === null || course.maxGradePercent <= limit);
  // Fewest pieces first, then the gentlest; unread slopes after the read ones.
  // The run anchored on the street's own end goes first: it needs nothing but the end that is already there.
  const anchored = (course: FrontageCourse) => (/^frontage:(anchored|stub)/.test(course.reason) ? 0 : 1);
  return known.sort((a, b) => anchored(a) - anchored(b) || (a.maxGradePercent === null ? 1 : 0) - (b.maxGradePercent === null ? 1 : 0) || a.segments.length - b.segments.length ||
    (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || (a.maxGradePercent ?? 0) - (b.maxGradePercent ?? 0));
}
