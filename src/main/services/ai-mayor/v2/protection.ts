/**
 * THE PROTECTION FILTER — areas the player asked the Mayor to keep its hands off ("don't touch the old town"). Held for the whole engine process
 * (set from the compiled instruction, see `host/intent-lowering.ts`), and enforced at the ONE place every write passes: the district builder's write
 * port (`guardDistrictPort`). A write whose geometry reaches into a protected area is refused there with `PROTECTED_AREA:<name>` — the same shape as a
 * refusal by the game, so every caller already handles it (skip, remember, try elsewhere). Reads are never filtered.
 *
 * Geometry is the game's own outline of the area (a district polygon). A building is protected when its footprint (a circle around its point) reaches
 * the polygon; a road or a pipe when its course crosses or enters it; a zoning brush when its circle does.
 */
import type { SpatialPoint2 } from "../spatial/types";

export interface ProtectedArea { name: string; polygon: SpatialPoint2[]; source: string }

export function pointInPolygon(point: SpatialPoint2, polygon: readonly SpatialPoint2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if ((a.z > point.z) !== (b.z > point.z) && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsCross(p1: SpatialPoint2, p2: SpatialPoint2, q1: SpatialPoint2, q2: SpatialPoint2): boolean {
  const cross = (o: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const d1 = cross(q1, q2, p1); const d2 = cross(q1, q2, p2); const d3 = cross(p1, p2, q1); const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function distanceToSegment(point: SpatialPoint2, a: SpatialPoint2, b: SpatialPoint2): number {
  const dx = b.x - a.x; const dz = b.z - a.z; const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.z - (a.z + t * dz));
}

export class ProtectionRegistry {
  #areas: ProtectedArea[] = [];
  set(areas: readonly ProtectedArea[]): void { this.#areas = areas.filter((area) => area.polygon.length >= 3).map((area) => ({ ...area, polygon: [...area.polygon] })); }
  clear(): void { this.#areas = []; }
  get areas(): readonly ProtectedArea[] { return this.#areas; }

  /** The protected area a circle (a building's footprint, a zoning brush) reaches, if any. */
  circle(center: SpatialPoint2, radius = 0): ProtectedArea | null {
    for (const area of this.#areas) {
      if (pointInPolygon(center, area.polygon)) return area;
      if (radius > 0 && area.polygon.some((vertex, index) => distanceToSegment(center, vertex, area.polygon[(index + 1) % area.polygon.length]!) <= radius)) return area;
    }
    return null;
  }

  /** The protected area a course (a road, a pipe, a cable) enters or crosses, if any. */
  segment(from: SpatialPoint2, to: SpatialPoint2): ProtectedArea | null {
    for (const area of this.#areas) {
      if (pointInPolygon(from, area.polygon) || pointInPolygon(to, area.polygon)) return area;
      if (area.polygon.some((vertex, index) => segmentsCross(from, to, vertex, area.polygon[(index + 1) % area.polygon.length]!))) return area;
    }
    return null;
  }

  /**
   * The protected area an axis-aligned rectangle (a district site, grown by `margin` metres) overlaps, if any: for the planner, so a site the
   * player asked to keep is never chosen in the first place (the write guard would refuse every street of it, one by one).
   */
  rect(minX: number, minZ: number, maxX: number, maxZ: number, margin = 0): ProtectedArea | null {
    const box = { minX: minX - margin, minZ: minZ - margin, maxX: maxX + margin, maxZ: maxZ + margin };
    const corners = [{ x: box.minX, z: box.minZ }, { x: box.maxX, z: box.minZ }, { x: box.maxX, z: box.maxZ }, { x: box.minX, z: box.maxZ }];
    for (const area of this.#areas) {
      if (area.polygon.some((vertex) => vertex.x >= box.minX && vertex.x <= box.maxX && vertex.z >= box.minZ && vertex.z <= box.maxZ)) return area;
      if (corners.some((corner) => pointInPolygon(corner, area.polygon))) return area;
      if (corners.some((corner, index) => area.polygon.some((vertex, k) => segmentsCross(corner, corners[(index + 1) % 4]!, vertex, area.polygon[(k + 1) % area.polygon.length]!)))) return area;
    }
    return null;
  }
}

/** The engine's one registry (a process holds one city). */
export const protection = new ProtectionRegistry();

/** A building's footprint for the check: half the larger side of a big lot, a modest default otherwise. */
export const PROTECTION_FOOTPRINT_METERS = 24;

export const refusal = (area: ProtectedArea) => ({ ok: false as const, detail: `PROTECTED_AREA:${area.name} (the player asked to keep this area as it is)` });

type GuardablePort = import("./district-builder").DistrictBuilderPort;

/**
 * The builder's write port with the protection filter in front of every write that has a place: streets, zoning, buildings, pipes and cables, the
 * station and its tracks, the export grid. Behaviour is otherwise unchanged (the same call, the same result shape); a refused write never reaches
 * the game. Removals carry only an entity id, so their callers check the place themselves (`protection.circle`).
 */
export function guardDistrictPort(port: GuardablePort, registry: ProtectionRegistry = protection): GuardablePort {
  const viaSegment = async <T extends { ok: boolean; detail: string }>(from: SpatialPoint2, to: SpatialPoint2, call: () => Promise<T>): Promise<T> => {
    const area = registry.segment(from, to);
    return area ? (refusal(area) as T) : call();
  };
  const viaCircle = async <T extends { ok: boolean; detail: string }>(center: SpatialPoint2, radius: number, call: () => Promise<T>): Promise<T> => {
    const area = registry.circle(center, radius);
    return area ? (refusal(area) as T) : call();
  };
  const guarded: Partial<GuardablePort> = {
    buildRoad: (course, prefab, signal) => viaSegment(course.start, course.end, () => port.buildRoad(course, prefab, signal)),
    zone: (zone, center, radius, signal) => viaCircle(center, radius, () => port.zone(zone, center, radius, signal)),
    // "Don't change the roads": no street is taken out, not even the Mayor's own dead ends (new streets are still laid on free ground).
    ...(port.demolishRoad ? { demolishRoad: async (entity: { index: number; version: number }, signal?: AbortSignal) =>
      (process.env.AI_MAYOR_KEEP_ROADS === "1" ? false : port.demolishRoad!(entity, signal)) } : {}),
    ...(port.utilities ? { utilities: { ...port.utilities,
      place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => viaCircle(point, PROTECTION_FOOTPRINT_METERS, () => port.utilities!.place(prefab, point, rotation, signal)),
      ...(port.utilities.connect ? { connect: (prefab: string, from: SpatialPoint2, to: SpatialPoint2, signal?: AbortSignal) =>
        viaSegment(from, to, () => port.utilities!.connect!(prefab, from, to, signal)) } : {}) } } : {}),
    ...(port.powerExport ? { powerExport: { ...port.powerExport,
      place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => viaCircle(point, PROTECTION_FOOTPRINT_METERS, () => port.powerExport!.place(prefab, point, rotation, signal)),
      lay: (prefab: string, from: SpatialPoint2, to: SpatialPoint2, startElevation: number, endElevation: number, signal?: AbortSignal) =>
        viaSegment(from, to, () => port.powerExport!.lay(prefab, from, to, startElevation, endElevation, signal)) } } : {}),
    ...(port.trainLink ? { trainLink: { ...port.trainLink,
      place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => viaCircle(point, PROTECTION_FOOTPRINT_METERS * 3, () => port.trainLink!.place(prefab, point, rotation, signal)),
      lay: (prefab: string, from: SpatialPoint2, to: SpatialPoint2, signal?: AbortSignal) => viaSegment(from, to, () => port.trainLink!.lay(prefab, from, to, signal)) } } : {}),
  };
  // Everything not guarded is read from the port itself at call time (not copied), so the guarded port stays the same port to its callers.
  return new Proxy(port, { get: (target, key, receiver) => (Object.prototype.hasOwnProperty.call(guarded, key) ? guarded[key as keyof GuardablePort] : Reflect.get(target, key, receiver)) });
}
