/**
 * Precise hands: one closed loop for any write that targets a set of world objects.
 *
 *   complete enumeration -> exact selector -> native impact preview + scope safety -> guarded act
 *   -> complete re-enumeration -> residual (same predicate) + preserve verification
 *
 * The world is the authority. Nothing here is a ledger: every fact is read from the game, and a fact that cannot be
 * proven (an enumeration that may be truncated, a type known only by its name, an impact the game did not report in
 * full) makes the loop refuse or stop short of COMPLETE instead of guessing. Authorship is never inferred: the
 * selector carries no "who built it" dimension, because the world does not record one.
 */

export interface EntityRef { index: number; version: number }
export interface Point2 { x: number; z: number }

export const entityKey = (entity: EntityRef) => `${entity.index}:${entity.version}`;

export type ObjectStateFlag = "destroyed" | "abandoned" | "condemned";

export interface WorldObject {
  entity: EntityRef;
  prefab: string;
  position: Point2;
  isSubBuilding: boolean;
  /** null when the reader did not report state; a selector that constrains state then cannot decide. */
  state: Record<ObjectStateFlag, boolean> | null;
}

export interface WorldIdentity {
  generation: string | null;
  frameIndex: number | null;
  paused: boolean | null;
  nativeBusy: boolean | null;
}

/**
 * A type, as the set of prefabs the game itself classifies as that type (from prefab ECS components). `proven` is
 * false when the set was only matched by name: such a type can still be read, but no write may claim it is complete.
 */
export interface TypeIdentity { label: string; prefabs: string[]; proven: boolean; source: string }

export interface ObjectPage {
  total: number;
  offset: number;
  rows: WorldObject[];
  generation: string | null;
  frameIndex: number | null;
}

export interface ObjectEnumeration {
  objects: WorldObject[];
  complete: boolean;
  gaps: string[];
  generation: string | null;
  frameIndex: number | null;
}

export type SpatialScope =
  | { kind: "circle"; center: Point2; radius: number }
  | { kind: "rect"; minX: number; maxX: number; minZ: number; maxZ: number }
  | { kind: "city" };

export interface Selector {
  type: TypeIdentity;
  scope: SpatialScope;
  /** Required values of the object's current state flags; an unlisted flag is unconstrained. */
  state?: Partial<Record<ObjectStateFlag, boolean>>;
  /** Sub-buildings (installed extensions) are part of their owner; they are selected only when asked. */
  includeSubBuildings?: boolean;
  /** Objects that match everything else but must not be touched. */
  preserve?: { entities?: EntityRef[]; predicate?: (object: WorldObject) => boolean };
}

export type Classification = "TARGET" | "PROTECTED" | "OUT_OF_SCOPE" | "STATE_MISMATCH" | "STATE_UNKNOWN" | "SUB_BUILDING" | "NOT_TYPE";

export function inScope(point: Point2, scope: SpatialScope): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
  if (scope.kind === "city") return true;
  if (scope.kind === "circle") return Math.hypot(point.x - scope.center.x, point.z - scope.center.z) <= scope.radius;
  return point.x >= scope.minX && point.x <= scope.maxX && point.z >= scope.minZ && point.z <= scope.maxZ;
}

export function classify(object: WorldObject, selector: Selector): Classification {
  if (!selector.type.prefabs.includes(object.prefab)) return "NOT_TYPE";
  if (object.isSubBuilding && !selector.includeSubBuildings) return "SUB_BUILDING";
  if (!inScope(object.position, selector.scope)) return "OUT_OF_SCOPE";
  const wanted = Object.entries(selector.state ?? {}) as Array<[ObjectStateFlag, boolean]>;
  if (wanted.length > 0) {
    if (!object.state) return "STATE_UNKNOWN";
    if (wanted.some(([flag, value]) => object.state![flag] !== value)) return "STATE_MISMATCH";
  }
  const preserved = new Set((selector.preserve?.entities ?? []).map(entityKey));
  if (preserved.has(entityKey(object.entity)) || selector.preserve?.predicate?.(object)) return "PROTECTED";
  return "TARGET";
}

export interface Selection {
  status: "EXACT" | "INCOMPLETE";
  reasons: string[];
  targets: WorldObject[];
  protectedMatches: WorldObject[];
  outOfScope: WorldObject[];
}

/** The exact target set, or INCOMPLETE when the type or the enumeration cannot be proven whole. */
export function selectExact(enumeration: ObjectEnumeration, selector: Selector): Selection {
  const reasons: string[] = [];
  if (!selector.type.proven) reasons.push(`TYPE_IDENTITY_UNPROVEN:${selector.type.source}`);
  if (!enumeration.complete) reasons.push(...enumeration.gaps.map((gap) => `ENUMERATION_INCOMPLETE:${gap}`));
  const targets: WorldObject[] = [];
  const protectedMatches: WorldObject[] = [];
  const outOfScope: WorldObject[] = [];
  for (const object of enumeration.objects) {
    const verdict = classify(object, selector);
    if (verdict === "TARGET") targets.push(object);
    else if (verdict === "PROTECTED") protectedMatches.push(object);
    else if (verdict === "OUT_OF_SCOPE") outOfScope.push(object);
    else if (verdict === "STATE_UNKNOWN") reasons.push(`STATE_UNKNOWN:${entityKey(object.entity)}`);
  }
  return { status: reasons.length === 0 ? "EXACT" : "INCOMPLETE", reasons, targets, protectedMatches, outOfScope };
}

export const PAGE_LIMIT = 500;

/**
 * Every placed instance of every prefab of a type, page by page. Complete only when each prefab's pages add up to
 * the total the game counted, every row is the prefab asked for, no entity repeats, and all pages were read from
 * one world generation and one simulation frame (the world must be paused for a paged read to be one snapshot).
 */
export async function enumerateType(
  read: (prefab: string, offset: number, signal?: AbortSignal) => Promise<ObjectPage>,
  type: TypeIdentity,
  signal?: AbortSignal,
): Promise<ObjectEnumeration> {
  const gaps: string[] = [];
  const objects: WorldObject[] = [];
  const seen = new Set<string>();
  let generation: string | null | undefined;
  let frameIndex: number | null | undefined;
  for (const prefab of type.prefabs) {
    let offset = 0;
    let total: number | null = null;
    let collected = 0;
    for (let guard = 0; guard < 1_000; guard += 1) {
      const page = await read(prefab, offset, signal);
      if (generation === undefined) generation = page.generation;
      if (frameIndex === undefined) frameIndex = page.frameIndex;
      if (page.generation === null || page.generation !== generation) gaps.push(`GENERATION_CHANGED_OR_UNKNOWN:${prefab}`);
      if (page.frameIndex === null || page.frameIndex !== frameIndex) gaps.push(`FRAME_MOVED_BETWEEN_PAGES:${prefab}`);
      if (total !== null && page.total !== total) gaps.push(`TOTAL_CHANGED_BETWEEN_PAGES:${prefab}`);
      total = page.total;
      if (!Number.isFinite(page.total) || page.total < 0) { gaps.push(`TOTAL_UNKNOWN:${prefab}`); break; }
      for (const row of page.rows) {
        if (row.prefab !== prefab) { gaps.push(`ROW_NOT_OF_PREFAB:${prefab}:${row.prefab}`); continue; }
        const key = entityKey(row.entity);
        if (seen.has(key)) { gaps.push(`DUPLICATE_ENTITY:${key}`); continue; }
        seen.add(key);
        objects.push(row);
        collected += 1;
      }
      offset += page.rows.length;
      if (page.rows.length === 0 || offset >= page.total) break;
    }
    if (total === null || collected !== total) gaps.push(`COUNT_MISMATCH:${prefab}:${collected}/${total ?? "?"}`);
  }
  const unique = [...new Set(gaps)];
  return { objects, complete: unique.length === 0, gaps: unique, generation: generation ?? null, frameIndex: frameIndex ?? null };
}

export interface ImpactRow {
  original: EntityRef | null;
  kind: string;
  prefab: string | null;
  flags: string;
  deletes: boolean;
  isTarget: boolean;
  ownedByTarget: boolean;
}

/** The game's own Temp set for a proposed write: every entity it would delete, rewrite, or create. */
export interface NativeImpact {
  fingerprint: string;
  allowApply: boolean;
  rowCount: number;
  truncated: boolean;
  rows: ImpactRow[];
}

export interface ImpactAssessment {
  safe: boolean;
  reasons: string[];
  /** Deleted originals that are neither the target nor owned by it. */
  collateral: ImpactRow[];
  /** The subset of collateral the caller explicitly authorized. */
  authorizedCollateral: ImpactRow[];
  /** Originals the game rewrites without deleting them. */
  modified: ImpactRow[];
}

/**
 * Scope safety from the native impact, not from the request: the target must be in the set the game will delete,
 * no protected object may appear in the set at all, and anything else the game would delete must be explicitly
 * authorized. An impact the game reported only in part cannot be judged and is unsafe.
 */
export function assessImpact(impact: NativeImpact, policy: {
  target?: EntityRef;
  protectedKeys: ReadonlySet<string>;
  allowCollateral?: (row: ImpactRow) => boolean;
}): ImpactAssessment {
  const reasons: string[] = [];
  const collateral: ImpactRow[] = [];
  const authorizedCollateral: ImpactRow[] = [];
  const modified: ImpactRow[] = [];
  if (!impact.allowApply) reasons.push("NATIVE_TOOL_REFUSED");
  if (impact.truncated || impact.rows.length !== impact.rowCount) reasons.push("IMPACT_NOT_FULLY_REPORTED");
  if (policy.target && !impact.rows.some((row) => row.isTarget && row.deletes &&
    row.original !== null && entityKey(row.original) === entityKey(policy.target!))) {
    reasons.push("TARGET_NOT_IN_NATIVE_DELETE_SET");
  }
  for (const row of impact.rows) {
    if (!row.original) continue;
    const key = entityKey(row.original);
    if (policy.protectedKeys.has(key)) reasons.push(`PROTECTED_OBJECT_IN_IMPACT:${key}:${row.prefab ?? row.kind}:${row.deletes ? "delete" : "modify"}`);
    if (!row.deletes) { modified.push(row); continue; }
    if (row.isTarget || row.ownedByTarget) continue;
    collateral.push(row);
    if (policy.allowCollateral?.(row)) authorizedCollateral.push(row);
    else reasons.push(`UNAUTHORIZED_COLLATERAL_DELETE:${key}:${row.prefab ?? row.kind}`);
  }
  return { safe: reasons.length === 0, reasons, collateral, authorizedCollateral, modified };
}

export interface Neighbourhood {
  complete: boolean;
  gaps: string[];
  /** Every structural entity (buildings and network edges) in the read area, as "index:version" with its prefab. */
  entities: Map<string, string>;
  generation: string | null;
}

export interface PreciseHandsPort {
  identity(signal?: AbortSignal): Promise<WorldIdentity>;
  listObjects(prefab: string, offset: number, signal?: AbortSignal): Promise<ObjectPage>;
  previewRemoval(entity: EntityRef, signal?: AbortSignal): Promise<NativeImpact>;
  /** Applies only if the native impact still has `expectFingerprint`. */
  remove(entity: EntityRef, expectFingerprint: string, signal?: AbortSignal): Promise<{ ok: boolean; impact: NativeImpact | null; detail: string }>;
  /** Resolves true once no native write is pending (or false if it never settles). */
  waitIdle(signal?: AbortSignal): Promise<boolean>;
  neighbourhood(center: Point2, radius: number, signal?: AbortSignal): Promise<Neighbourhood>;
}

export type RemovalVerdict =
  | "COMPLETE"
  | "NOTHING_TO_DO"
  | "PARTIAL"
  | "RESIDUAL_REMAINS"
  | "PRESERVE_VIOLATION"
  | "UNSAFE_IMPACT"
  | "VERIFY_INCOMPLETE"
  | "ABORTED_WORLD_CHANGED"
  | "REFUSED_TOO_MANY_TARGETS"
  | "BLOCKED_NOT_PAUSED"
  | "BLOCKED_PENDING_WRITES"
  | "BLOCKED_BY_WORLD_OBSERVABILITY";

export interface RemovalReport {
  verdict: RemovalVerdict;
  reasons: string[];
  targets: WorldObject[];
  removed: EntityRef[];
  skipped: Array<{ entity: EntityRef; reason: string }>;
  residual: WorldObject[];
  newlyAppeared: WorldObject[];
  preserveViolations: string[];
  impacts: Array<{ entity: EntityRef; fingerprint: string; collateral: ImpactRow[]; modified: ImpactRow[] }>;
  steps: string[];
}

/** Margin around the targets whose structures are read before and after, for the preserve check. */
export const NEIGHBOURHOOD_MARGIN_METERS = 150;

/**
 * Remove exactly the objects a selector names, and prove it. Sequential and stop-on-first-failure: a write the
 * world did not confirm is never followed by another one built on the same, now stale, reading.
 */
export async function runPreciseRemoval(port: PreciseHandsPort, selector: Selector, options: {
  maxTargets: number;
  allowCollateral?: (row: ImpactRow) => boolean;
  signal?: AbortSignal;
}): Promise<RemovalReport> {
  const report: RemovalReport = {
    verdict: "COMPLETE", reasons: [], targets: [], removed: [], skipped: [], residual: [], newlyAppeared: [],
    preserveViolations: [], impacts: [], steps: [],
  };
  const finish = (verdict: RemovalVerdict, ...reasons: string[]) => {
    report.verdict = verdict;
    report.reasons.push(...reasons);
    return report;
  };
  const step = (text: string) => { report.steps.push(text); };
  const signal = options.signal;
  const read = (prefab: string, offset: number) => port.listObjects(prefab, offset, signal);

  // OBSERVE: a paused, idle, identified world, and the whole type.
  const before = await port.identity(signal);
  if (before.generation === null) return finish("BLOCKED_BY_WORLD_OBSERVABILITY", "WORLD_GENERATION_UNKNOWN");
  if (before.paused !== true) return finish("BLOCKED_NOT_PAUSED", "WORLD_NOT_PAUSED");
  if (before.nativeBusy !== false) return finish("BLOCKED_PENDING_WRITES", "NATIVE_WRITE_PENDING_BEFORE_START");
  if (!selector.type.proven) return finish("BLOCKED_BY_WORLD_OBSERVABILITY", `TYPE_IDENTITY_UNPROVEN:${selector.type.source}`);
  const enumeration = await enumerateType(read, selector.type, signal);
  if (enumeration.generation !== before.generation) enumeration.gaps.push("ENUMERATION_FROM_ANOTHER_GENERATION");
  // SELECT
  const selection = selectExact({ ...enumeration, complete: enumeration.complete && enumeration.generation === before.generation }, selector);
  step(`observe: ${enumeration.objects.length} ${selector.type.label} (${selection.status}); targets ${selection.targets.length}, protected ${selection.protectedMatches.length}, out of scope ${selection.outOfScope.length}`);
  if (selection.status !== "EXACT") return finish("BLOCKED_BY_WORLD_OBSERVABILITY", ...selection.reasons);
  report.targets = selection.targets;
  if (selection.targets.length === 0) return finish("NOTHING_TO_DO");
  if (selection.targets.length > options.maxTargets) return finish("REFUSED_TOO_MANY_TARGETS", `${selection.targets.length}>${options.maxTargets}`);

  const targetKeys = new Set(selection.targets.map((object) => entityKey(object.entity)));
  // Same-type objects that are not targets, and anything the selector preserves, must not be touched at all.
  const protectedKeys = new Set(enumeration.objects.filter((object) => !targetKeys.has(entityKey(object.entity))).map((object) => entityKey(object.entity)));
  for (const entity of selector.preserve?.entities ?? []) protectedKeys.add(entityKey(entity));
  const center = {
    x: selection.targets.reduce((sum, object) => sum + object.position.x, 0) / selection.targets.length,
    z: selection.targets.reduce((sum, object) => sum + object.position.z, 0) / selection.targets.length,
  };
  const radius = Math.max(...selection.targets.map((object) => Math.hypot(object.position.x - center.x, object.position.z - center.z))) + NEIGHBOURHOOD_MARGIN_METERS;
  const areaBefore = await port.neighbourhood(center, radius, signal);
  if (!areaBefore.complete || areaBefore.generation !== before.generation) {
    return finish("BLOCKED_BY_WORLD_OBSERVABILITY", ...areaBefore.gaps.map((gap) => `NEIGHBOURHOOD_INCOMPLETE:${gap}`),
      ...(areaBefore.generation !== before.generation ? ["NEIGHBOURHOOD_FROM_ANOTHER_GENERATION"] : []));
  }
  step(`neighbourhood: ${areaBefore.entities.size} structures within ${radius.toFixed(0)} m of (${center.x.toFixed(1)}, ${center.z.toFixed(1)})`);

  // ACT, one target at a time, each re-confirmed against the current world.
  const mayChange = new Set<string>(targetKeys);
  for (const target of selection.targets) {
    const key = entityKey(target.entity);
    const now = await port.identity(signal);
    if (now.generation !== before.generation) return finish("ABORTED_WORLD_CHANGED", `GENERATION_CHANGED_BEFORE:${key}`);
    if (now.paused !== true) return finish("BLOCKED_NOT_PAUSED", `WORLD_UNPAUSED_BEFORE:${key}`);
    if (now.nativeBusy !== false) return finish("BLOCKED_PENDING_WRITES", `NATIVE_WRITE_PENDING_BEFORE:${key}`);
    const fresh = await enumerateType(read, { ...selector.type, prefabs: [target.prefab] }, signal);
    if (!fresh.complete) return finish("BLOCKED_BY_WORLD_OBSERVABILITY", ...fresh.gaps.map((gap) => `RECONFIRM_INCOMPLETE:${gap}`));
    const current = fresh.objects.find((object) => entityKey(object.entity) === key);
    if (!current) { report.skipped.push({ entity: target.entity, reason: "STALE_TARGET_GONE" }); step(`skip ${key}: no longer in the world`); continue; }
    const still = classify(current, selector);
    if (still !== "TARGET") { report.skipped.push({ entity: target.entity, reason: `STALE_NO_LONGER_${still}` }); step(`skip ${key}: now ${still}`); continue; }

    const impact = await port.previewRemoval(target.entity, signal);
    const assessment = assessImpact(impact, { target: target.entity, protectedKeys, allowCollateral: options.allowCollateral });
    report.impacts.push({ entity: target.entity, fingerprint: impact.fingerprint, collateral: assessment.collateral, modified: assessment.modified });
    step(`preview ${key}: ${impact.rowCount} native rows, collateral ${assessment.collateral.length} (authorized ${assessment.authorizedCollateral.length}), modified ${assessment.modified.length}`);
    if (!assessment.safe) return finish("UNSAFE_IMPACT", ...assessment.reasons.map((reason) => `${key}:${reason}`));

    const outcome = await port.remove(target.entity, impact.fingerprint, signal);
    step(`remove ${key}: ${outcome.ok ? "applied" : "refused"} ${outcome.detail.slice(0, 160)}`);
    if (!outcome.ok) return finish("PARTIAL", `REMOVE_FAILED:${key}:${outcome.detail.slice(0, 200)}`);
    report.removed.push(target.entity);
    for (const row of [...assessment.authorizedCollateral, ...assessment.modified]) if (row.original) mayChange.add(entityKey(row.original));
    for (const row of impact.rows) if (row.original && (row.isTarget || row.ownedByTarget)) mayChange.add(entityKey(row.original));
  }

  // VERIFY: the world settles, is re-read whole, and judged by the same predicate.
  if (!(await port.waitIdle(signal))) return finish("BLOCKED_PENDING_WRITES", "NATIVE_WRITE_PENDING_AFTER_ACT");
  const after = await port.identity(signal);
  if (after.generation !== before.generation) return finish("ABORTED_WORLD_CHANGED", "GENERATION_CHANGED_BEFORE_VERIFY");
  if (after.nativeBusy !== false) return finish("BLOCKED_PENDING_WRITES", "NATIVE_WRITE_PENDING_AT_VERIFY");
  const final = await enumerateType(read, selector.type, signal);
  const finalSelection = selectExact({ ...final, complete: final.complete && final.generation === before.generation }, selector);
  if (finalSelection.status !== "EXACT") return finish("VERIFY_INCOMPLETE", ...finalSelection.reasons);
  report.residual = finalSelection.targets;
  report.newlyAppeared = finalSelection.targets.filter((object) => !targetKeys.has(entityKey(object.entity)));
  const finalKeys = new Set(final.objects.map((object) => entityKey(object.entity)));
  for (const object of enumeration.objects) {
    const key = entityKey(object.entity);
    if (!targetKeys.has(key) && !finalKeys.has(key)) report.preserveViolations.push(`SAME_TYPE_NON_TARGET_GONE:${key}:${object.prefab}`);
  }
  const areaAfter = await port.neighbourhood(center, radius, signal);
  if (!areaAfter.complete || areaAfter.generation !== before.generation) return finish("VERIFY_INCOMPLETE", ...areaAfter.gaps.map((gap) => `NEIGHBOURHOOD_INCOMPLETE:${gap}`));
  for (const [key, prefab] of areaBefore.entities) {
    if (!mayChange.has(key) && !areaAfter.entities.has(key)) report.preserveViolations.push(`STRUCTURE_GONE:${key}:${prefab}`);
  }
  step(`verify: residual ${report.residual.length} (new ${report.newlyAppeared.length}), preserve violations ${report.preserveViolations.length}, neighbourhood ${areaBefore.entities.size}->${areaAfter.entities.size}`);
  if (report.preserveViolations.length > 0) return finish("PRESERVE_VIOLATION", ...report.preserveViolations);
  if (report.residual.length > 0) return finish("RESIDUAL_REMAINS", ...report.residual.map((object) => `RESIDUAL:${entityKey(object.entity)}${targetKeys.has(entityKey(object.entity)) ? "" : ":NEW"}`));
  if (report.skipped.length > 0) return finish("PARTIAL", ...report.skipped.map((entry) => `${entityKey(entry.entity)}:${entry.reason}`));
  return finish("COMPLETE");
}
