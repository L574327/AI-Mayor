/**
 * Scope resolution, binding and re-verification (V1 §5.1).
 *
 * Two hard rules live here:
 *  - A SNAPSHOT scope binds once, at atomic acceptance. Re-compilation re-verifies;
 *    it never re-captures.
 *  - A fixed entity set never absorbs a later same-name object. Identity is the
 *    opaque handle, not the name.
 */

import type {
  Aspect,
  AspectBaseline,
  BoundScope,
  ScopeDecl,
  ScopeExtent,
  ScopeSelector,
  WorldObject,
  WorldSnapshot,
} from "./types";

export type ScopeResolution = { ok: true; extent: ScopeExtent } | { ok: false; reason: string };

const cellsOf = (world: WorldSnapshot): string[] => {
  const cells = new Set<string>(Object.keys(world.areas));
  for (const object of world.objects) {
    cells.add(object.cell);
  }
  return [...cells].sort();
};

const dedupeSorted = (values: string[]): string[] => [...new Set(values)].sort();

const objectsOfKind = (world: WorldSnapshot, kinds: string[]): string[] =>
  world.objects
    .filter((object) => kinds.includes(object.kind))
    .map((object) => object.id)
    .sort();

/**
 * Resolve a selector against a world snapshot.
 *
 * Unknown district names or unknown object handles make the scope unbound rather than
 * silently resolving to the empty set (V1 §11: SCOPE_UNBOUND).
 */
export function resolveSelector(selector: ScopeSelector, world: WorldSnapshot): ScopeResolution {
  switch (selector.kind) {
    case "universe":
      return { ok: true, extent: { cells: cellsOf(world), entities: [], universe_bound: true } };
    case "district": {
      const known = new Set(cellsOf(world));
      const unknown = selector.districts.filter((cell) => !known.has(cell));
      if (unknown.length > 0) {
        return { ok: false, reason: `unknown district cell(s): ${unknown.join(", ")}` };
      }
      return { ok: true, extent: { cells: dedupeSorted(selector.districts), entities: [], universe_bound: false } };
    }
    case "object_kind":
      return {
        ok: true,
        extent: { cells: [], entities: objectsOfKind(world, selector.object_kinds), universe_bound: false },
      };
    case "objects": {
      const known = new Set(world.objects.map((object) => object.id));
      const unknown = selector.object_ids.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return { ok: false, reason: `unknown object handle(s): ${unknown.join(", ")}` };
      }
      return { ok: true, extent: { cells: [], entities: dedupeSorted(selector.object_ids), universe_bound: false } };
    }
    case "minus": {
      const base = resolveSelector(selector.base, world);
      if (!base.ok) {
        return base;
      }
      const remove = resolveSelector(selector.remove, world);
      if (!remove.ok) {
        return remove;
      }
      return { ok: true, extent: subtractExtents(base.extent, remove.extent, world) };
    }
    case "intersect": {
      const parts: ScopeExtent[] = [];
      for (const part of selector.parts) {
        const resolved = resolveSelector(part, world);
        if (!resolved.ok) {
          return resolved;
        }
        parts.push(resolved.extent);
      }
      if (parts.length === 0) {
        return { ok: false, reason: "empty intersection selector" };
      }
      // A geographic cell survives only if every operand covers the whole cell.
      // An entity-only selector must not turn a kind/district intersection into
      // permission for every object in that district.
      const cells = parts.reduce((acc, part) => acc.filter((cell) => part.cells.includes(cell)), cellsOf(world));
      const entities = world.objects
        .filter((object) => parts.every((part) => extentContains(part, object)))
        .map((object) => object.id);
      return {
        ok: true,
        extent: {
          cells: dedupeSorted(cells),
          entities: dedupeSorted(entities.filter((id) => !cells.includes(world.objects.find((object) => object.id === id)?.cell ?? ""))),
          universe_bound: parts.every((part) => part.universe_bound),
        },
      };
    }
    case "union": {
      const parts: ScopeExtent[] = [];
      for (const part of selector.parts) {
        const resolved = resolveSelector(part, world);
        if (!resolved.ok) {
          return resolved;
        }
        parts.push(resolved.extent);
      }
      return {
        ok: true,
        extent: {
          cells: dedupeSorted(parts.flatMap((part) => part.cells)),
          entities: dedupeSorted(parts.flatMap((part) => part.entities)),
          universe_bound: parts.some((part) => part.universe_bound),
        },
      };
    }
  }
}

/** Objects covered by an extent in the current world. Geometry covers future occupants. */
export function extentMembers(extent: ScopeExtent, world: WorldSnapshot): string[] {
  const members = new Set<string>(extent.entities.filter((id) => !extent.excluded_entities?.includes(id)));
  for (const object of world.objects) {
    if (extentContains(extent, object)) {
      members.add(object.id);
    }
  }
  return [...members].sort();
}

export function extentContains(extent: ScopeExtent, object: WorldObject): boolean {
  return !extent.excluded_entities?.includes(object.id) && (extent.entities.includes(object.id) || extent.cells.includes(object.cell));
}

export function subtractExtents(base: ScopeExtent, remove: ScopeExtent, world?: WorldSnapshot): ScopeExtent {
  const excluded = new Set([...(base.excluded_entities ?? []), ...remove.entities]);
  if (world) for (const object of world.objects) if (extentContains(remove, object)) excluded.add(object.id);
  return {
    cells: base.cells.filter((cell) => !remove.cells.includes(cell)),
    entities: base.entities.filter((id) => !excluded.has(id) && (!world || !remove.cells.includes(world.objects.find((object) => object.id === id)?.cell ?? ""))),
    universe_bound: base.universe_bound,
    excluded_entities: [...excluded].sort(),
  };
}

export function intersectExtents(a: ScopeExtent, b: ScopeExtent): ScopeExtent {
  const cells = a.cells.filter((cell) => b.cells.includes(cell));
  return {
    cells: dedupeSorted(cells),
    entities: dedupeSorted(a.entities.filter((id) => b.entities.includes(id))),
    universe_bound: a.universe_bound && b.universe_bound,
  };
}

/** Aspect -> object field projection. Aspects without an object projection yield null. */
export function aspectValue(object: WorldObject, aspect: Aspect): string | number | boolean | null {
  switch (aspect) {
    case "appearance":
      return object.appearance;
    case "model":
      return object.model;
    case "use":
      return [...object.uses].sort().join("+");
    case "existence":
      return true;
    case "height":
      return object.floors;
    case "vacancy":
      return object.uses.includes("vacant");
    default:
      return null;
  }
}

const captureBaseline = (
  object: WorldObject,
  aspects: Aspect[],
  revision: number,
): AspectBaseline => {
  const values: AspectBaseline["values"] = {};
  for (const aspect of aspects) {
    values[aspect] = aspectValue(object, aspect);
  }
  return {
    entity_id: object.id,
    object_kind: object.kind,
    object_name: object.name,
    captured_at_revision: revision,
    values,
  };
};

/**
 * Bind a scope at acceptance. SNAPSHOT freezes the extent and captures the baseline
 * set once; DYNAMIC stores the fixed selector and binds baselines on first entry.
 */
export function bindScope(
  decl: ScopeDecl,
  world: WorldSnapshot,
  revision: number,
  aspects: Aspect[],
): { ok: true; bound: BoundScope } | { ok: false; reason: string } {
  if (decl.anchor !== world.session) return { ok: false, reason: "scope anchor does not match world session" };
  const resolved = resolveSelector(decl.selector, world);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  const members = extentMembers(resolved.extent, world);
  const byId = new Map(world.objects.map((object) => [object.id, object]));
  const baselines: Record<string, AspectBaseline> = {};
  const firstSeen: Record<string, number> = {};
  for (const id of members) {
    const object = byId.get(id);
    if (object) {
      baselines[id] = captureBaseline(object, aspects, revision);
      firstSeen[id] = revision;
    }
  }
  const bound: BoundScope = {
    scope_ref: decl.scope_ref,
    decl,
    binding: decl.binding,
    anchor: decl.anchor,
    bound_at_revision: revision,
    frozen_extent: decl.binding === "SNAPSHOT" ? resolved.extent : null,
    bound_entities: decl.binding === "SNAPSHOT" ? members : [],
    first_seen: firstSeen,
    baselines: decl.binding === "SNAPSHOT" ? baselines : {},
    universe_bound: resolved.extent.universe_bound,
  };
  return { ok: true, bound };
}

export interface ScopeVerification {
  extent: ScopeExtent;
  members: string[];
  missing: string[];
  divergences: Array<{ entity_id: string; aspect: Aspect; baseline: unknown; current: unknown }>;
  /** True when the DYNAMIC selector (or its anchor) can no longer be resolved. */
  unresolved: boolean;
  reason: string | null;
}

/**
 * Re-verify a bound scope against the current world without re-capturing anything.
 *
 * SNAPSHOT keeps its frozen extent; a geography-based SNAPSHOT covers current occupants
 * of that fixed domain, an entity-based SNAPSHOT covers exactly its bound handles.
 * DYNAMIC re-runs the fixed selector and records first-entry baselines for new members.
 */
export function verifyScope(
  bound: BoundScope,
  world: WorldSnapshot,
  aspects: Aspect[],
  revision: number,
): ScopeVerification {
  if (bound.anchor !== world.session) {
    return { extent: { cells: [], entities: [], universe_bound: false }, members: [], missing: [], divergences: [], unresolved: true, reason: "scope anchor does not match world session" };
  }
  if (bound.binding === "SNAPSHOT") {
    const frozen = bound.frozen_extent ?? { cells: [], entities: bound.bound_entities, universe_bound: bound.universe_bound };
    const geometryBased = frozen.cells.length > 0;
    const members = geometryBased ? extentMembers(frozen, world) : [...bound.bound_entities].sort();
    const present = new Set(world.objects.map((object) => object.id));
    const missing = bound.bound_entities.filter((id) => !present.has(id)).sort();
    return {
      extent: frozen,
      members,
      missing,
      divergences: divergences(bound, world, aspects),
      unresolved: false,
      reason: null,
    };
  }

  const resolved = resolveSelector(bound.decl.selector, world);
  if (!resolved.ok) {
    return {
      extent: { cells: [], entities: bound.bound_entities, universe_bound: bound.universe_bound },
      members: [...bound.bound_entities].sort(),
      missing: [],
      divergences: [],
      unresolved: true,
      reason: resolved.reason,
    };
  }
  const members = extentMembers(resolved.extent, world);
  const byId = new Map(world.objects.map((object) => [object.id, object]));
  for (const id of members) {
    if (!(id in bound.first_seen)) {
      bound.first_seen[id] = revision;
    }
    if (!(id in bound.baselines)) {
      const object = byId.get(id);
      if (object) {
        bound.baselines[id] = captureBaseline(object, aspects, revision);
      }
    }
  }
  const present = new Set(world.objects.map((object) => object.id));
  const missing = Object.keys(bound.baselines)
    .filter((id) => !present.has(id))
    .sort();
  return {
    extent: resolved.extent,
    members,
    missing,
    divergences: divergences(bound, world, aspects),
    unresolved: false,
    reason: null,
  };
}

/** Natural divergence only: reported, never auto-restored, never written back. */
function divergences(
  bound: BoundScope,
  world: WorldSnapshot,
  aspects: Aspect[],
): Array<{ entity_id: string; aspect: Aspect; baseline: unknown; current: unknown }> {
  const byId = new Map(world.objects.map((object) => [object.id, object]));
  const out: Array<{ entity_id: string; aspect: Aspect; baseline: unknown; current: unknown }> = [];
  for (const [id, baseline] of Object.entries(bound.baselines)) {
    const object = byId.get(id);
    if (!object) {
      continue;
    }
    for (const aspect of aspects) {
      const before = baseline.values[aspect];
      if (before === undefined) {
        continue;
      }
      const now = aspectValue(object, aspect);
      if (now !== before) {
        out.push({ entity_id: id, aspect, baseline: before, current: now });
      }
    }
  }
  return out.sort((a, b) => (a.entity_id + a.aspect < b.entity_id + b.aspect ? -1 : 1));
}

export function cloneBoundScope(bound: BoundScope): BoundScope {
  return {
    ...bound,
    frozen_extent: bound.frozen_extent
      ? { cells: [...bound.frozen_extent.cells], entities: [...bound.frozen_extent.entities], universe_bound: bound.frozen_extent.universe_bound, excluded_entities: [...(bound.frozen_extent.excluded_entities ?? [])] }
      : null,
    bound_entities: [...bound.bound_entities],
    first_seen: { ...bound.first_seen },
    baselines: Object.fromEntries(Object.entries(bound.baselines).map(([id, baseline]) => [id, { ...baseline, values: { ...baseline.values } }])),
  };
}
