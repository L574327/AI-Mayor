/**
 * EXECUTION OUTCOME TELEMETRY — the seam a later Adaptive Execution Memory will read; today it only records.
 *
 * Every construction primitive the district builder calls (a street, a zoning brush, a tile purchase, a demolition) leaves
 * one outcome row: what was tried and where, whether the world accepted it, why not, which attempt at the same thing it was,
 * and how long the call took. The aim is measured data about execution efficiency — which candidates the game's own
 * validation refuses, how many tries one visible action takes — so that, later, candidate ordering can be tuned locally and
 * the player is shown one or two attempts instead of a dozen.
 *
 * Boundaries (the user's, 2026-10-04): this module records execution only. It has no consumer, it decides nothing, and
 * nothing here may learn or change a Mission, an Objective Profile, a hard constraint, a preservation rule or a demolition
 * permission. A future reader may reorder candidates that are already allowed; it may never allow one. Rows live in memory
 * for the process, and the world stays the only authority.
 */
import type { DistrictBuilderPort } from "./district-builder";
import type { SpatialPoint2 } from "../spatial/types";

export type ExecutionPrimitive = "ROAD" | "ZONE" | "PURCHASE_TILE" | "DEMOLISH_ROAD" | "PLACE_OBJECT" | "LAY_NET";

export interface ExecutionOutcome {
  primitive: ExecutionPrimitive;
  /** What was tried: a prefab or zone name and the place, rounded to the metre. */
  context: Record<string, string | number>;
  /** The same thing tried again has the same key; `attempt` counts them. */
  contextKey: string;
  ok: boolean;
  /** The game's own refusal code or the first words of its message; null on success. */
  reason: string | null;
  /** 1 for the first try at this context, 2 for the first retry, and so on. */
  attempt: number;
  latencyMs: number;
  /** Wall-clock time of the call (ms since the epoch). */
  at: number;
  /** What the caller knew about the candidate when it submitted it (geometry, which course of which district); not part of the key. */
  features?: Record<string, string | number | boolean | null>;
}

export type OutcomeFeatures = NonNullable<ExecutionOutcome["features"]>;

const ROW_LIMIT = 4_000;

/** The refusal code in a message (UPPER_SNAKE), else its first 60 characters. */
export function refusalReason(detail: string): string {
  return /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/.exec(detail)?.[0] ?? detail.replace(/\s+/g, " ").slice(0, 60);
}

export class ExecutionOutcomeRecorder {
  readonly #rows: ExecutionOutcome[] = [];
  readonly #attempts = new Map<string, number>();

  #pending: OutcomeFeatures | null = null;

  /** `sink`, when given, receives each row as it is recorded (a diagnostics file in live runs); a failing sink never disturbs the call. */
  constructor(private readonly clock: () => number = Date.now, private readonly sink?: (row: ExecutionOutcome) => void) {}

  /** Describe the NEXT row recorded: the caller says what it knows about the candidate it is about to submit. */
  annotate(features: OutcomeFeatures): void { this.#pending = { ...(this.#pending ?? {}), ...features }; }

  record(input: { primitive: ExecutionPrimitive; context: Record<string, string | number>; ok: boolean; detail?: string; latencyMs: number }): ExecutionOutcome {
    const contextKey = `${input.primitive}|${Object.entries(input.context).map(([name, value]) => `${name}=${value}`).join(",")}`;
    const attempt = (this.#attempts.get(contextKey) ?? 0) + 1;
    this.#attempts.set(contextKey, attempt);
    const row: ExecutionOutcome = { primitive: input.primitive, context: input.context, contextKey, ok: input.ok,
      reason: input.ok ? null : refusalReason(input.detail ?? ""), attempt, latencyMs: Math.round(input.latencyMs), at: this.clock(),
      ...(this.#pending ? { features: this.#pending } : {}) };
    this.#pending = null;
    this.#rows.push(row);
    if (this.#rows.length > ROW_LIMIT) this.#rows.shift();
    try { this.sink?.(row); } catch { /* diagnostics only */ }
    return row;
  }

  /** Rows recorded so far; `from` skips the first n (the length when a span began). */
  rows(from = 0): readonly ExecutionOutcome[] { return this.#rows.slice(from); }
  get length(): number { return this.#rows.length; }

  /** One line of what the rows from `from` on show: per primitive, accepted and refused, the commonest refusals, retries, latency. */
  summary(from = 0): string | null {
    const rows = this.#rows.slice(from);
    if (rows.length === 0) return null;
    const parts: string[] = [];
    for (const primitive of ["ROAD", "ZONE", "PURCHASE_TILE", "DEMOLISH_ROAD", "PLACE_OBJECT", "LAY_NET"] as const) {
      const mine = rows.filter((row) => row.primitive === primitive);
      if (mine.length === 0) continue;
      const refused = mine.filter((row) => !row.ok);
      const reasons = new Map<string, number>();
      for (const row of refused) reasons.set(row.reason ?? "?", (reasons.get(row.reason ?? "?") ?? 0) + 1);
      const top = [...reasons].sort((left, right) => right[1] - left[1]).slice(0, 2).map(([reason, count]) => `${reason} x${count}`).join(", ");
      const retries = mine.filter((row) => row.attempt > 1).length;
      const meanMs = Math.round(mine.reduce((sum, row) => sum + row.latencyMs, 0) / mine.length);
      parts.push(`${primitive} ${mine.length - refused.length} ok/${refused.length} refused${top ? ` (${top})` : ""}${retries > 0 ? `, ${retries} retries` : ""}, ${meanMs} ms avg`);
    }
    return `telemetry: ${parts.join("; ")}`;
  }
}

const metre = (value: number) => Math.round(value);
const spot = (point: SpatialPoint2) => `${metre(point.x)},${metre(point.z)}`;
/** The context a street attempt is keyed by (also used for a street the builder decides not to submit). */
export const roadContext = (course: { start: SpatialPoint2; end: SpatialPoint2 }, prefab: string): Record<string, string | number> =>
  ({ prefab, from: spot(course.start), to: spot(course.end), meters: metre(Math.hypot(course.end.x - course.start.x, course.end.z - course.start.z)) });

/**
 * The builder's write port with every call recorded. Behaviour is unchanged: the same call, the same result, the same error;
 * only the outcome row is added.
 */
export function instrumentDistrictPort(port: DistrictBuilderPort, recorder: ExecutionOutcomeRecorder, now: () => number = Date.now): DistrictBuilderPort {
  const timed = async <T extends { ok: boolean; detail: string }>(primitive: ExecutionPrimitive, context: Record<string, string | number>, call: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      const result = await call();
      recorder.record({ primitive, context, ok: result.ok, detail: result.detail, latencyMs: now() - startedAt });
      return result;
    } catch (error) {
      recorder.record({ primitive, context, ok: false, detail: error instanceof Error ? error.message : String(error), latencyMs: now() - startedAt });
      throw error;
    }
  };
  return {
    ...port,
    buildRoad: (course, prefab, signal) => timed("ROAD", roadContext(course, prefab), () => port.buildRoad(course, prefab, signal)),
    zone: (zone, center, radius, signal) => timed("ZONE", { zone, at: spot(center), radius: metre(radius) }, () => port.zone(zone, center, radius, signal)),
    ...(port.purchaseTile ? { purchaseTile: (point: SpatialPoint2, signal?: AbortSignal) => timed("PURCHASE_TILE", { at: spot(point) }, () => port.purchaseTile!(point, signal)) } : {}),
    // The facilities, signature buildings, transformer, station and their cables and tracks (2026-10-05): the same record, nothing else changes.
    ...(port.utilities ? { utilities: { ...port.utilities,
      place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => timed("PLACE_OBJECT", { prefab, at: spot(point) }, () => port.utilities!.place(prefab, point, rotation, signal)),
      ...(port.utilities.connect ? { connect: (prefab: string, from: SpatialPoint2, to: SpatialPoint2, signal?: AbortSignal) =>
        timed("LAY_NET", { prefab, from: spot(from), to: spot(to) }, () => port.utilities!.connect!(prefab, from, to, signal)) } : {}) } } : {}),
    ...(port.powerExport ? { powerExport: { ...port.powerExport,
      place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => timed("PLACE_OBJECT", { prefab, at: spot(point) }, () => port.powerExport!.place(prefab, point, rotation, signal)),
      lay: (prefab: string, from: SpatialPoint2, to: SpatialPoint2, startElevation: number, endElevation: number, signal?: AbortSignal) =>
        timed("LAY_NET", { prefab, from: spot(from), to: spot(to), depth: startElevation }, () => port.powerExport!.lay(prefab, from, to, startElevation, endElevation, signal)) } } : {}),
    ...(port.trainLink ? { trainLink: { ...port.trainLink,
      place: (prefab: string, point: SpatialPoint2, rotation: number, signal?: AbortSignal) => timed("PLACE_OBJECT", { prefab, at: spot(point), rotation: metre(rotation) }, () => port.trainLink!.place(prefab, point, rotation, signal)),
      lay: (prefab: string, from: SpatialPoint2, to: SpatialPoint2, signal?: AbortSignal) => timed("LAY_NET", { prefab, from: spot(from), to: spot(to) }, () => port.trainLink!.lay(prefab, from, to, signal)) } } : {}),
    ...(port.demolishRoad ? {
      demolishRoad: async (entity: { index: number; version: number }, signal?: AbortSignal) => {
        const startedAt = now();
        const ok = await port.demolishRoad!(entity, signal);
        recorder.record({ primitive: "DEMOLISH_ROAD", context: { entity: `${entity.index}:${entity.version}` }, ok, detail: ok ? "" : "demolish refused", latencyMs: now() - startedAt });
        return ok;
      },
    } : {}),
  };
}
