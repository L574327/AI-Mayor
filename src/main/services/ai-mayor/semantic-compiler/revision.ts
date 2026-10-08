/** Atomic V1 declaration lifecycle; every update installs a whole revision or none. */
import type { AcceptedRevision, BoundGate, Clause, ClauseInput, ConflictPause, Diagnostic, MayorIntentUpdate, ScopeExtent, WorldSnapshot } from "./types";
import { ONTOLOGY_VERSION, SCHEMA_VERSION } from "./types";
import { aspectValue, bindScope, cloneBoundScope, extentMembers, subtractExtents, verifyScope } from "./scope";
import { compareStrings, stableStringify } from "./util";

export interface UpdateApplication { ok: boolean; revision: AcceptedRevision | null; pause?: ConflictPause | null; diagnostics: Diagnostic[] }
const diag = (code: Diagnostic["code"], refs: string[], detail: string): Diagnostic => ({ code, severity: "REJECT", refs, detail });
const copy = <T>(value: T): T => structuredClone(value);
const find = (clauses: Clause[], ref: string): Clause | undefined => clauses.find((c) => c.status === "ACTIVE" && c.clause_ref === ref);
const updateDigest = (update: MayorIntentUpdate): string => stableStringify({ operation: update.operation, ops: update.ops });
const empty = (extent: ScopeExtent): boolean => extent.cells.length === 0 && extent.entities.length === 0;
const concepts = new Set(Array.from({ length: 16 }, (_, i) => "O" + String(i + 1).padStart(2, "0") + "_" + ["STYLE","URBAN_FORM","DENSITY","EXTENT","LAND_USE","USE_MIX","MOBILITY","PARKING","OPEN_SPACE","ECONOMIC_ROLE","HOUSING_CONDITION","ENVIRONMENT_QUALITY","AESTHETIC_CHARACTER","VARIATION","SPATIAL_RELATION","SITING"][i]));
const predicates = new Set(["exists.use","new_build.use","demolition.of_kind","pollution.at_receptor","population.count","cash.amount","building.floors","density.population_built","grid.purity","noise.level"]);
const aspects = new Set(["appearance","use","model","existence","height","density","network_geometry","road_alignment","access","pollution","noise","population","commercial_activity","vacancy","fiscal","quality"]);
const operations = new Set(["zoning_change","building_construct","building_rebuild","demolition","road_rebuild","road_widen","style_change","land_fill","loan"]);
const paramKeys = new Set(["allow","operation_categories","affected_aspects","validity","object_limit","use_limit","style","pattern","scale","class","template","goal","postcondition_required","use","weight_index","fiscal"]);
const comparator = new Set([">=","<=",">","<","==","!="]);
function validSelector(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return false;
  const s = selector as { kind?:string; districts?:unknown; object_ids?:unknown; object_kinds?:unknown; base?:unknown; remove?:unknown; parts?:unknown };
  if (s.kind === "universe") return true;
  if (s.kind === "district") return Array.isArray(s.districts) && s.districts.every((x) => typeof x === "string");
  if (s.kind === "objects") return Array.isArray(s.object_ids) && s.object_ids.every((x) => typeof x === "string");
  if (s.kind === "object_kind") return Array.isArray(s.object_kinds) && s.object_kinds.every((x) => ["district","parcel","building","road","metro","land"].includes(x));
  if (s.kind === "minus") return validSelector(s.base) && validSelector(s.remove);
  if (s.kind === "intersect" || s.kind === "union") return Array.isArray(s.parts) && s.parts.length > 0 && s.parts.every(validSelector);
  return false;
}

function makeClause(input: ClauseInput, update: MayorIntentUpdate, number: number, world: WorldSnapshot, from?: string): Clause | Diagnostic {
  if (!input.clause_ref || !input.scope?.scope_ref || !Array.isArray(input.aspects) || !["TARGET","CONSTRAINT","PREFERENCE","PRESERVE","PERMISSION"].includes(input.kind))
    return diag("INVALID_IR", [input.clause_ref ?? ""], "invalid clause");
  if (!["REQUIRED","PREFERRED"].includes(input.strength) || input.aspects.some((a) => !aspects.has(a)) ||
    input.concept && !concepts.has(input.concept) || input.predicate && (!predicates.has(input.predicate.predicate) || typeof input.predicate.negated !== "boolean") ||
    input.scope && (!["SNAPSHOT","DYNAMIC"].includes(input.scope.binding) || !validSelector(input.scope.selector)) ||
    Object.keys(input.params ?? {}).some((key) => !paramKeys.has(key)))
    return diag("INVALID_IR", [input.clause_ref], "unregistered enum, selector or parameter");
  if (input.params?.postcondition_required !== undefined && typeof input.params.postcondition_required !== "boolean" ||
    input.params?.weight_index !== undefined && (typeof input.params.weight_index !== "number" || !Number.isFinite(input.params.weight_index)) ||
    input.owner && (input.owner.kind !== "INDEPENDENT" && input.owner.kind !== "BOUND" ||
      input.owner.kind === "BOUND" && !input.owner.target_ref))
    return diag("INVALID_IR", [input.clause_ref], "invalid typed semantic parameter or owner");
  if (input.kind === "PERMISSION" && (typeof input.params?.allow !== "boolean" || !Array.isArray(input.params?.operation_categories) || !Array.isArray(input.params?.affected_aspects) ||
    !input.params?.validity || typeof input.params.validity !== "object"))
    return diag("INVALID_IR", [input.clause_ref], "permission needs explicit polarity, categories, aspects and validity");
  if (input.kind === "PERMISSION") {
    const validity = input.params!.validity as { kind?:string; max?:unknown; gate_ref?:unknown };
    if (!["UNTIL_REVOKED","UNTIL_GATE","QUANTITY"].includes(validity.kind ?? "") ||
      validity.kind === "UNTIL_GATE" && (typeof validity.gate_ref !== "string" || !validity.gate_ref) ||
      validity.kind === "QUANTITY" && (typeof validity.max !== "number" || !Number.isInteger(validity.max) || validity.max < 1))
      return diag("INVALID_IR", [input.clause_ref], "invalid permission validity");
  }
  if (input.kind === "PERMISSION" && ((input.params?.operation_categories as unknown[]).some((op) => !operations.has(String(op))) ||
    (input.params?.affected_aspects as unknown[]).some((aspect) => !aspects.has(String(aspect)))))
    return diag("INVALID_IR", [input.clause_ref], "unregistered permission operation or aspect");
  if (input.kind === "PERMISSION" && ((input.params?.operation_categories as unknown[]).length === 0 ||
    (input.params?.affected_aspects as unknown[]).length === 0 ||
    input.params?.object_limit !== undefined && (!Array.isArray(input.params.object_limit) || input.params.object_limit.some((id) => typeof id !== "string")) ||
    input.params?.use_limit !== undefined && (!Array.isArray(input.params.use_limit) || input.params.use_limit.some((use) => !["commercial","residential","industrial","vacant"].includes(use)))))
    return diag("INVALID_IR", [input.clause_ref], "invalid permission limits");
  if (input.params?.fiscal !== undefined && (!Array.isArray(input.params.fiscal) ||
    input.params.fiscal.some((entry) => !entry || typeof entry !== "object" ||
      !["cash_floor","forbid_loan"].includes(entry.key) || typeof entry.value !== "number" || !Number.isFinite(entry.value))))
    return diag("INVALID_IR", [input.clause_ref], "invalid fiscal hard parameter");
  if (input.completion && (!input.completion.metric || !input.completion.unit || !comparator.has(input.completion.comparator) ||
    !input.completion.domain || !["SNAPSHOT_ENTITIES","FIXED_SELECTOR"].includes(input.completion.domain.kind) ||
    typeof input.completion.evidence_source !== "string" ||
    !["REACH","MAINTAIN_WINDOW","MAINTAIN_OPEN","NON_BINARY"].includes(input.completion.tense) ||
    !["REQUIRE_NONEMPTY","ALLOW_VACUOUS","UNRESOLVED"].includes(input.completion.vacuous)))
    return diag("INVALID_IR", [input.clause_ref], "invalid completion contract");
  const bound = bindScope(input.scope, world, number, input.aspects);
  if (!bound.ok) return diag("SCOPE_UNBOUND", [input.clause_ref], bound.reason);
  return { ...copy(input), status: "ACTIVE", accepted_at_revision: number, bound_scope: bound.bound,
    provenance: { update_id: update.update_id, provider: update.source.provider, operation: update.operation, ...(from ? { derived_from: from } : {}) } };
}

export function bindGates(clauses: Clause[], _number: number, previous: BoundGate[]): BoundGate[] {
  const result = new Map<string, BoundGate>();
  for (const clause of clauses.filter((c) => c.status === "ACTIVE")) {
    const spec = clause.temporal;
    if (!spec) continue;
    const affects = spec.affects.length ? [...spec.affects] : [clause.clause_ref];
    const prior = previous.find((g) => g.gate_ref === spec.gate_ref && g.affects.includes(clause.clause_ref) &&
      g.mode === spec.mode && g.release_event === spec.release_event && stableStringify(g.predicate) === stableStringify(spec.predicate));
    result.set(spec.gate_ref, { ...copy(spec), affects, bound_at_revision: prior?.bound_at_revision ?? clause.accepted_at_revision,
      latch_satisfied_at_revision: prior?.latch_satisfied_at_revision ?? null, released_by_update_id: prior?.released_by_update_id ?? null });
  }
  return [...result.values()].sort((a,b) => compareStrings(a.gate_ref,b.gate_ref));
}

function closeOwned(clauses: Clause[], targets: string[]): void {
  for (const c of clauses) if (c.status === "ACTIVE" && c.owner?.kind === "BOUND" && targets.includes(c.owner.target_ref)) c.status = "CANCELLED";
}

export function applyUpdate(update: MayorIntentUpdate, current: AcceptedRevision | null, world: WorldSnapshot): UpdateApplication {
  const fail = (code: Diagnostic["code"], refs: string[], detail: string, pause: ConflictPause | null = null): UpdateApplication =>
    ({ ok: false, revision: null, pause, diagnostics: [diag(code,refs,detail)] });
  if (update.schema_version !== SCHEMA_VERSION || update.ontology_version !== ONTOLOGY_VERSION || !update.update_id || !update.source?.provider || !Array.isArray(update.ops))
    return fail("INVALID_IR", [update.update_id ?? ""], "invalid envelope");
  if (current?.accepted_update_ids.includes(update.update_id)) {
    if (current.accepted_update_digests[update.update_id] !== updateDigest(update)) return fail("UPDATE_ID_COLLISION", [update.update_id], "same id, different content");
    const replay = current.replay_results?.[update.update_id];
    if (replay) return { ok: true, revision: { ...copy(replay.revision), replay_results: copy(current.replay_results) }, diagnostics: copy(replay.diagnostics) };
    return { ok: true, revision: current, diagnostics: [] };
  }
  if (update.base_revision !== (current?.revision ?? 0)) return fail("STALE_REVISION", [update.update_id], "base revision is stale");
  if (current && current.session !== world.session) return fail("SCOPE_UNBOUND", [update.update_id], "world session changed");

  const number = (current?.revision ?? 0) + 1;
  const clauses = current ? copy(current.clauses) : [];
  const carves = current ? copy(current.carves) : [];
  let gates = current ? copy(current.gates) : [];
  const events = current ? [...current.applied_events] : [];
  const add = (input: ClauseInput, from?: string): Diagnostic | null => {
    if (find(clauses,input.clause_ref)) return diag("AMBIGUOUS_REFERENCE",[input.clause_ref],"active clause ref exists");
    const made = makeClause(input,update,number,world,from);
    if ("code" in made) return made;
    clauses.push(made);
    return null;
  };
  const historic = (c: Clause): void => { const h = copy(c); h.clause_ref = c.clause_ref + "@h" + number; h.status = "SUPERSEDED"; clauses.push(h); };
  const cancel = (targets: string[]): Diagnostic | null => {
    if (!targets.length) return diag("AMBIGUOUS_CANCEL",[],"cancellation target is ambiguous");
    for (const ref of targets) if (!find(clauses,ref)) return diag("AMBIGUOUS_REFERENCE",[ref],"target is not active");
    for (const ref of targets) find(clauses,ref)!.status = "CANCELLED";
    closeOwned(clauses,targets);
    gates = gates.filter((g) => !g.affects.some((ref) => targets.includes(ref)));
    return null;
  };

  for (const op of update.ops) {
    let problem: Diagnostic | null = null;
    switch (op.op) {
      case "ADD": problem = add(op.clause); break;
      case "ADD_PRESERVE": problem = op.clause.kind === "PRESERVE" ? add(op.clause) : diag("INVALID_IR",[op.clause.clause_ref],"requires preserve"); break;
      case "PATCH_CLAUSE": {
        const old = find(clauses,op.clause_ref);
        if (!old) { problem = diag("AMBIGUOUS_REFERENCE",[op.clause_ref],"patch target not active"); break; }
        const input: ClauseInput = { ...copy(old), ...copy(op.patch), params: { ...(old.params ?? {}), ...(op.patch.params ?? {}) } };
        const made = makeClause(input,update,number,world,old.clause_ref + "@h" + number);
        if ("code" in made) { problem = made; break; }
        historic(old);
        if (!op.patch.scope) {
          // Keep prior identity and aspect baselines. New aspects start their
          // baseline at this accepted PATCH; unrelated aspects never resample.
          const bound = cloneBoundScope(old.bound_scope);
          const currentObjects = new Map(world.objects.map((object) => [object.id,object]));
          for (const [id,baseline] of Object.entries(bound.baselines)) {
            const object = currentObjects.get(id);
            if (!object) continue;
            for (const aspect of made.aspects)
              if (!(aspect in baseline.values)) baseline.values[aspect] = aspectValue(object,aspect);
          }
          made.bound_scope = bound;
        }
        Object.assign(old,made);
        break;
      }
      case "REPLACE": {
        if (!op.targets.length || !op.replacements.length) { problem = diag("AMBIGUOUS_REFERENCE",[],"replacement needs targets and replacements"); break; }
        const targets = op.targets.map((ref) => find(clauses,ref));
        if (targets.some((c) => !c)) { problem = diag("AMBIGUOUS_REFERENCE",op.targets,"replacement target missing"); break; }
        const candidates = op.replacements.map((input) => makeClause(input,update,number,world));
        const bad = candidates.find((c) => "code" in c);
        if (bad && "code" in bad) { problem = bad; break; }
        const replacements = candidates as Clause[];
        for (const old of targets as Clause[]) {
          historic(old);
          let residual = verifyScope(old.bound_scope,world,old.aspects,number).extent;
          for (const replacement of replacements) residual = subtractExtents(residual,verifyScope(replacement.bound_scope,world,replacement.aspects,number).extent,world);
          if (empty(residual) && old.bound_scope.binding === "SNAPSHOT") old.status = "SUPERSEDED";
          else {
            const bound = cloneBoundScope(old.bound_scope);
            old.residualized = true;
            const retained = new Set(extentMembers(residual,world));
            if (bound.binding === "DYNAMIC") {
              // Retain the original dynamic rule outside the replacement's
              // declared selector. A frozen extent would lose future members;
              // keeping the original selector would revive the replaced area.
              const remove = replacements.length === 1 ? copy(replacements[0].scope.selector)
                : { kind:"union" as const, parts:replacements.map((r) => copy(r.scope.selector)) };
              bound.decl = { ...bound.decl, selector:{ kind:"minus", base:copy(bound.decl.selector), remove } };
              bound.frozen_extent = null;
              old.scope = copy(bound.decl);
            } else bound.frozen_extent = residual;
            bound.bound_entities = [...retained].sort();
            bound.baselines = Object.fromEntries(Object.entries(bound.baselines).filter(([id]) => retained.has(id)));
            bound.first_seen = Object.fromEntries(Object.entries(bound.first_seen).filter(([id]) => retained.has(id)));
            old.bound_scope = bound;
          }
        }
        closeOwned(clauses,op.targets);
        gates = gates.filter((g) => !g.affects.some((ref) => op.targets.includes(ref)));
        for (const replacement of replacements) {
          if (find(clauses,replacement.clause_ref)) { problem = diag("AMBIGUOUS_REFERENCE",[replacement.clause_ref],"replacement ref exists"); break; }
          clauses.push(replacement);
        }
        break;
      }
      case "CANCEL": problem = cancel(op.targets); break;
      case "RESTORE": {
        const old = clauses.find((c) => c.clause_ref === op.historic_clause_ref && c.status !== "ACTIVE");
        if (!old) { problem = diag("AMBIGUOUS_REFERENCE",[op.historic_clause_ref],"historic ref missing"); break; }
        const logical = old.clause_ref.replace(/@h\d+$/,"");
        if (find(clauses,logical)) { problem = diag("AMBIGUOUS_REFERENCE",[logical],"logical ref active"); break; }
        const { status:_status, accepted_at_revision:_accepted, bound_scope:_bound, provenance:_prov, ...input } = old;
        problem = add({ ...input, clause_ref:logical },old.clause_ref);
        break;
      }
      case "EXCEPTION": {
        const rule = find(clauses,op.rule_ref);
        if (!rule || !["PERMISSION","CONSTRAINT","PRESERVE"].includes(rule.kind)) { problem = diag("AMBIGUOUS_REFERENCE",[op.rule_ref],"exception rule missing"); break; }
        if (!op.aspects.length || !op.operation_categories.length || !op.aspects.some((aspect) => rule.aspects.includes(aspect))) { problem = diag("INVALID_IR",[op.exception_ref],"exception must intersect rule aspect and name operations"); break; }
        if (carves.some((c) => c.carve_ref === op.exception_ref)) { problem = diag("AMBIGUOUS_REFERENCE",[op.exception_ref],"duplicate exception"); break; }
        const bound = bindScope(op.scope,world,number,op.aspects);
        if (!bound.ok) { problem = diag("SCOPE_UNBOUND",[op.exception_ref],bound.reason); break; }
        carves.push({ carve_ref:op.exception_ref,rule_ref:op.rule_ref,bound_scope:bound.bound,aspects:[...op.aspects],
          operation_categories:[...op.operation_categories],accepted_at_revision:number,
          provenance:{ update_id:update.update_id,provider:update.source.provider,operation:update.operation } });
        if (op.grant) problem = add(op.grant);
        break;
      }
      case "RELEASE_EVENT": events.push(op.event); gates = gates.map((g) => g.mode === "EVENT" && g.release_event === op.event ? { ...g,released_by_update_id:update.update_id } : g); break;
    }
    if (problem) return { ok:false,revision:null,pause:problem.code === "AMBIGUOUS_CANCEL" ? { kind:"AMBIGUOUS_CANCEL",update_id:update.update_id,scope_hint:null,paused:[] } : null,diagnostics:[problem] };
  }
  gates = bindGates(clauses,number,gates);
  for (const c of clauses.filter((entry) => entry.status === "ACTIVE")) {
    if (c.owner?.kind === "BOUND" && find(clauses,c.owner.target_ref)?.kind !== "TARGET") return fail("AMBIGUOUS_REFERENCE",[c.clause_ref,c.owner.target_ref],"owner is not active target");
    const validity = c.params?.validity as { kind?:string; gate_ref?:string } | undefined;
    if (c.kind === "PERMISSION" && validity?.kind === "UNTIL_GATE" && !gates.some((g) => g.gate_ref === validity.gate_ref)) return fail("AMBIGUOUS_REFERENCE",[c.clause_ref],"grant gate missing");
  }
  return { ok:true,revision:{ revision:number,update_id:update.update_id,session:world.session,world_generation:world.generation,
    clauses,carves,gates,pauses:current ? copy(current.pauses) : [],applied_events:[...new Set(events)].sort(),
    accepted_update_ids:[...(current?.accepted_update_ids ?? []),update.update_id],
    accepted_update_digests:{ ...(current?.accepted_update_digests ?? {}),[update.update_id]:updateDigest(update) },
    replay_results:current ? copy(current.replay_results ?? {}) : {} },diagnostics:[] };
}
