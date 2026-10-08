/**
 * Lowering an accepted revision into the finite semantic artifact (V1 §8, §11).
 *
 * The artifact is a registration, not a plan: no coordinates, no construction order,
 * no tool calls. Every effect traces back to a clause, a mapping version, a world
 * sample, and a grant or prohibition. Missing capability is a diagnostic, never a
 * silently invented approximation.
 */

import { composeEffects, type DeclarationEffect } from "./compose";
import { evaluateGates } from "./gates";
import { extentContains, resolveSelector, subtractExtents, verifyScope } from "./scope";
import type {
  AcceptedRevision,
  CapabilitySet,
  Clause,
  ClauseLayerStatus,
  CompletionObligation,
  ConstraintRecord,
  Diagnostic,
  EvidenceRegister,
  FiscalRecord,
  GateRecord,
  GoalRecord,
  GrantRecord,
  LayerStatus,
  MappingDef,
  PermissionParams,
  PreservationRule,
  ResidueRecord,
  SemanticArtifact,
  SpatialPreferenceRecord,
  Tri,
  WorldSnapshot,
} from "./types";
import { compareStrings, triAnd } from "./util";

export interface LoweringInput {
  revision: AcceptedRevision;
  world: WorldSnapshot;
  capabilities: CapabilitySet;
  evidence: EvidenceRegister;
}

export interface LoweringResult {
  artifact: SemanticArtifact;
  diagnostics: Diagnostic[];
}

const OUT_OF_BOUNDARY_KEYS = ["prefab", "coordinate", "coordinates", "schedule", "construction_order", "tool_call"];

const info = (code: Diagnostic["code"], refs: string[], detail: string): Diagnostic => ({
  code,
  severity: "INFO",
  refs,
  detail,
});

const block = (code: Diagnostic["code"], refs: string[], detail: string): Diagnostic => ({
  code,
  severity: "BLOCK",
  refs,
  detail,
});

const mappingRef = (mapping: MappingDef): string => `${mapping.mapping_id}@${mapping.version}`;

/**
 * Mappings whose registered input matches the clause. `accepts.params` names the
 * declaration parameter keys a mapping requires, so several mappings on one predicate
 * or concept stay deterministically separable rather than all firing at once.
 */
function resolveMappings(clause: Clause, capabilities: CapabilitySet): MappingDef[] {
  const params = clause.params ?? {};
  return capabilities.mappings.mappings
    .filter((mapping) => {
      const acceptsInput =
        (clause.predicate && mapping.accepts.predicate === clause.predicate.predicate) ||
        Boolean(clause.concept && mapping.concept === clause.concept);
      if (!acceptsInput) {
        return false;
      }
      return (mapping.accepts.params ?? []).every((key) => key in params) &&
        Object.entries(mapping.accepts.values ?? {}).every(([key, value]) => params[key] === value);
    })
    .sort((a, b) => compareStrings(a.mapping_id, b.mapping_id));
}

function missingRequirements(mapping: MappingDef, capabilities: CapabilitySet): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const observation of mapping.requires.observations ?? []) {
    if (!capabilities.observations.includes(observation)) {
      diagnostics.push(
        block("OBSERVATION_MISSING", [mappingRef(mapping), observation], "required observation is not registered"),
      );
    }
  }
  for (const primitive of mapping.requires.primitives ?? []) {
    if (!capabilities.primitives.includes(primitive)) {
      diagnostics.push(
        block("PRIMITIVE_MISSING", [mappingRef(mapping), primitive], "required primitive is not registered"),
      );
    }
  }
  for (const evaluator of mapping.requires.evaluators ?? []) {
    if (!capabilities.evaluators.includes(evaluator)) {
      diagnostics.push(
        block("EVALUATOR_MISSING", [mappingRef(mapping), evaluator], "required evaluator is not registered"),
      );
    }
  }
  for (const content of mapping.requires.content ?? []) {
    if (!capabilities.content.includes(content)) {
      diagnostics.push(block("CONTENT_UNAVAILABLE", [mappingRef(mapping), content], "required content is not available"));
    }
  }
  return diagnostics;
}

/**
 * Templates may carry allowances (a density floor, demolition, a loan) that the player
 * semantics never granted. Such a template is unusable, never silently applied (V1 §8).
 */
function templateDiagnostics(mapping: MappingDef, clause: Clause, grants: GrantRecord[], active: Clause[], capabilities: CapabilitySet): Diagnostic[] {
  if (!mapping.template) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  const activeAllows = grants.filter((grant) => grant.allow && grant.status === "ACTIVE");
  const intended = clause.bound_scope.frozen_extent;
  const covering = activeAllows.filter((grant) => intended &&
    intended.cells.every((cell) => grant.extent.cells.includes(cell)) &&
    intended.entities.every((id) => grant.extent.entities.includes(id)));
  const allowedAspects = new Set(covering.flatMap((grant) => grant.affected_aspects));
  const declaredAllowance = mapping.requires_declared_allowance ?? [];
  const undeclared = declaredAllowance.filter((aspect) => !allowedAspects.has(aspect));
  if (undeclared.length > 0) {
    diagnostics.push(
      block(
        "GAME_LIMITATION",
        [clause.clause_ref, mappingRef(mapping), ...undeclared],
        "template carries an allowance the declarations never granted",
      ),
    );
  }
  if (mapping.requires_demolition && !covering.some((grant) => grant.operation_categories.includes("demolition"))) {
    diagnostics.push(
      block(
        "PERMISSION_DENIED",
        [clause.clause_ref, mappingRef(mapping)],
        "template needs demolition authority the declarations do not grant",
      ),
    );
  }
  if (mapping.requires_loan && !covering.some((grant) => grant.operation_categories.includes("loan"))) {
    diagnostics.push(
      block(
        "PERMISSION_DENIED",
        [clause.clause_ref, mappingRef(mapping)],
        "template needs loan authority the declarations do not grant",
      ),
    );
  }
  for (const other of active.filter((entry) => entry.clause_ref !== clause.clause_ref && entry.strength === "REQUIRED")) {
    for (const otherMapping of resolveMappings(other, capabilities)) {
      for (const effect of mapping.effects) for (const hard of otherMapping.effects.filter((entry) => entry.hard && entry.key === effect.key && entry.domain === effect.domain)) {
        const a = effect.value, b = hard.value;
        if (typeof a === "object" && !Array.isArray(a) && typeof b === "object" && !Array.isArray(b) &&
            Math.max(a.min ?? -Infinity, b.min ?? -Infinity) > Math.min(a.max ?? Infinity, b.max ?? Infinity))
          diagnostics.push(block("GAME_LIMITATION", [clause.clause_ref, other.clause_ref], "template assumption conflicts with an active hard bound"));
      }
    }
  }
  return diagnostics;
}

function outOfBoundaryKeys(clause: Clause): string[] {
  const params = clause.params ?? {};
  return OUT_OF_BOUNDARY_KEYS.filter((key) => key in params);
}

export function lowerRevision(input: LoweringInput): LoweringResult {
  const { revision, world, capabilities, evidence } = input;
  const diagnostics: Diagnostic[] = [];
  const active = revision.clauses
    .filter((clause) => clause.status === "ACTIVE")
    .sort((a, b) => compareStrings(a.clause_ref, b.clause_ref));

  const gates: GateRecord[] = evaluateGates(revision, world, revision.revision);

  const goals: GoalRecord[] = [];
  const constraints: ConstraintRecord[] = [];
  const spatialPreferences: SpatialPreferenceRecord[] = [];
  const preservationRules: PreservationRule[] = [];
  const fiscalEnvelope: FiscalRecord[] = [];
  const completionCriteria: CompletionObligation[] = [];
  const residues: ResidueRecord[] = [];
  const layers: ClauseLayerStatus[] = [];
  const verifiabilityByClause = new Map<string, Tri>();

  const grants: GrantRecord[] = active
    .filter((clause) => clause.kind === "PERMISSION")
    .map((clause) => buildGrant(clause, world, revision, evidence));

  const declarations: DeclarationEffect[] = [];

  for (const clause of active) {
    const mappingRefs: string[] = [];
    const notes: string[] = [];
    let compilability: LayerStatus = "COMPILED";
    let executability: Tri = "TRUE";
    let verifiability: Tri = "UNKNOWN";
    const clauseDiagnostics: Diagnostic[] = [];

    const boundaryKeys = outOfBoundaryKeys(clause);
    if (boundaryKeys.length > 0) {
      compilability = "OUT_OF_BOUNDARY";
      executability = "FALSE";
      residues.push({
        clause_ref: clause.clause_ref,
        reason: "OUT_OF_BOUNDARY",
        aspects: [...clause.aspects],
        strength: clause.strength,
        detail: `out-of-boundary parameter key(s): ${boundaryKeys.join(", ")}`,
      });
      clauseDiagnostics.push(
        block("OUT_OF_BOUNDARY", [clause.clause_ref, ...boundaryKeys], "this parameter shape is not part of the typed contract"),
      );
    } else if (clause.concept || clause.predicate) {
      const mappings = resolveMappings(clause, capabilities);
      if (mappings.length === 0) {
        compilability = "RESIDUE";
        executability = "FALSE";
        residues.push({
          clause_ref: clause.clause_ref,
          reason: "UNSUPPORTED",
          aspects: [...clause.aspects],
          strength: clause.strength,
          detail: clause.predicate
            ? `no registered mapping accepts predicate ${clause.predicate.predicate}`
            : `no registered mapping accepts concept ${clause.concept ?? "<none>"}`,
        });
        clauseDiagnostics.push(
          block(
            "LOCAL_MAPPING_MISSING",
            [clause.clause_ref],
            "no local mapping lowers this declaration; it stays a residue with no write effect",
          ),
        );
      } else {
        const unusable: Diagnostic[] = [];
        let usableCount = 0;
        for (const mapping of mappings) {
          const missing = missingRequirements(mapping, capabilities);
          const template = templateDiagnostics(mapping, clause, grants, active, capabilities);
          const unproved = mapping.assumptions.length || !mapping.impact_coverage.complete
            ? [block("IMPACT_UNKNOWN", [clause.clause_ref, mappingRef(mapping)], "mapping assumptions or impact coverage are not proven")]
            : [];
          if (missing.length > 0 || template.length > 0 || unproved.length > 0) {
            unusable.push(...missing, ...template, ...unproved);
            continue;
          }
          if (mapping.approximation_required && !clause.approximation) {
            unusable.push(
              block(
                "CONTRACT_UNRESOLVED",
                [clause.clause_ref, mappingRef(mapping)],
                "mapping requires an explicit approximation authorization",
              ),
            );
            continue;
          }
          usableCount += 1;
          mappingRefs.push(mappingRef(mapping));
          for (const effect of mapping.effects) {
            const scoped = verifyScope(clause.bound_scope,world,clause.aspects,revision.revision);
            declarations.push({ source_ref: `${clause.clause_ref}|${mappingRef(mapping)}`,
              effect: { ...effect, hard: clause.strength === "REQUIRED" && effect.hard },
              extent:scoped.extent,members:scoped.members });
          }
        }
        clauseDiagnostics.push(...unusable);
        if (usableCount === 0) {
          compilability = "UNSUPPORTED";
          executability = "FALSE";
          residues.push({
            clause_ref: clause.clause_ref,
            reason: "UNSUPPORTED",
            aspects: [...clause.aspects],
            strength: clause.strength,
            detail: `no usable mapping: ${unusable.map((diagnostic) => diagnostic.code).join(", ") || "unspecified"}`,
          });
        }
      }
    }

    // Gate interaction: a closed or unknown gate blocks gated writes without deleting
    // the declaration.
    const affecting = gates.filter((gate) => gate.affects.includes(clause.clause_ref));
    for (const gate of affecting) {
      if (gate.state === "FALSE") {
        executability = "FALSE";
        clauseDiagnostics.push(
          block("GATE_CLOSED", [clause.clause_ref, gate.gate_ref], "gated writes are blocked while the gate is closed"),
        );
      } else if (gate.state === "UNKNOWN") {
        if (executability === "TRUE") {
          executability = "UNKNOWN";
        }
        clauseDiagnostics.push(
          block("GATE_UNKNOWN", [clause.clause_ref, gate.gate_ref], "gated writes are blocked while the gate is unknown"),
        );
      }
    }

    if (clause.completion) {
      if (clause.completion.proxy_of && (!clause.approximation ||
          clause.approximation.approximation_ref !== clause.completion.approximation_ref ||
          clause.approximation.target_ref !== clause.completion.proxy_of ||
          !clause.aspects.includes(clause.approximation.aspect) ||
          clause.approximation.scope_ref !== clause.scope.scope_ref ||
          !clause.approximation.interpretation_version || !clause.approximation.allowed_loss || !clause.approximation.acceptance_ref ||
          !mappingRefs.includes(clause.approximation.mapping_ref) ||
          !revision.clauses.some((entry) => entry.clause_ref === clause.completion?.proxy_of ||
            entry.clause_ref.startsWith(`${clause.completion?.proxy_of}@h`)))) {
        compilability = "RESIDUE";
        executability = "FALSE";
        residues.push({ clause_ref: clause.clause_ref, reason: "UNSUPPORTED", aspects: [...clause.aspects], strength: clause.strength,
          detail: "proxy lacks a matching scoped approximation authorization" });
        clauseDiagnostics.push(block("CONTRACT_UNRESOLVED", [clause.clause_ref], "proxy authorization is incomplete or mismatched"));
      }
      const obligation = buildObligation(clause,world,revision);
      completionCriteria.push(obligation);
      verifiability = obligationVerifiability(obligation, clause, capabilities);
      if (verifiability !== "TRUE") {
        clauseDiagnostics.push(
          block(
            "CONTRACT_UNRESOLVED",
            [clause.clause_ref],
            verifiability === "FALSE"
              ? "completion contract is unresolved for this tense"
              : "completion contract has no evaluator or evidence source",
          ),
        );
      }
    }
    verifiabilityByClause.set(clause.clause_ref, verifiability);

    diagnostics.push(...clauseDiagnostics);
    notes.push(...clauseDiagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.detail}`));

    if (clause.kind === "TARGET") {
      goals.push({
        clause_ref: clause.clause_ref,
        strength: clause.strength,
        predicate: clause.predicate ?? null,
        concept: clause.concept ?? null,
        scope_ref: clause.bound_scope.scope_ref,
        aspects: [...clause.aspects],
        owner: clause.owner ?? { kind: "INDEPENDENT" },
        gate_refs: affecting.map((gate) => gate.gate_ref).sort(),
        completion_ref: clause.completion ? `${clause.clause_ref}:completion` : null,
      });
    } else if (clause.kind === "CONSTRAINT") {
      constraints.push(buildConstraint(clause, world, revision));
    } else if (clause.kind === "PREFERENCE") {
      spatialPreferences.push({
        clause_ref: clause.clause_ref,
        concept: clause.concept ?? null,
        aspects: [...clause.aspects],
        weight_index: Number((clause.params as { weight_index?: number } | undefined)?.weight_index ?? 0),
      });
    } else if (clause.kind === "PRESERVE") {
      preservationRules.push(buildPreservation(clause, world, revision));
    }

    const fiscal = (clause.params as { fiscal?: Array<{ key: string; hard?: boolean; value: number }> } | undefined)?.fiscal;
    for (const entry of fiscal ?? []) {
      fiscalEnvelope.push({
        clause_ref: clause.clause_ref,
        key: entry.key,
        hard: clause.strength === "REQUIRED" || entry.hard === true,
        value: entry.value,
      });
    }

    layers.push({
      clause_ref: clause.clause_ref,
      ir_validity: "TRUE",
      compilability,
      executability,
      verifiability,
      mapping_refs: mappingRefs,
      notes,
    });
  }

  const composed = composeEffects(declarations, capabilities.mappings);
  diagnostics.push(...composed.diagnostics);
  for (const key of composed.composition.undefined_keys) {
    diagnostics.push(block("EFFECT_COMPOSITION_UNDEFINED", [key], "no registered merge operator; the key is not written"));
  }
  for (const key of composed.composition.soft_ties) {
    diagnostics.push(info("SOFT_TIE_UNRESOLVED", [key], "soft preferences on this key do not resolve; it is not written"));
  }

  const requiredTargets = active.filter((clause) => clause.kind === "TARGET" && clause.strength === "REQUIRED");
  const requiredLayers = layers.filter((layer) =>
    requiredTargets.some((clause) => clause.clause_ref === layer.clause_ref),
  );

  const artifact: SemanticArtifact = {
    revision: revision.revision,
    world_generation: world.generation,
    session: world.session,
    five_layers: {
      fidelity: "NOT_TESTED",
      ir_validity: "TRUE",
      compilability: layers.some((layer) => layer.compilability !== "COMPILED" && active.find((c) => c.clause_ref === layer.clause_ref)?.strength === "REQUIRED") ? "FALSE" : "TRUE",
      executability: requiredLayers.length > 0 ? triAnd(requiredLayers.map((layer) => layer.executability)) : "TRUE",
      verifiability:
        requiredTargets.length > 0
          ? triAnd(requiredTargets.map((clause) => verifiabilityByClause.get(clause.clause_ref) ?? "UNKNOWN"))
          : "TRUE",
    },
    goals: goals.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    constraints: constraints.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    spatial_preferences: spatialPreferences.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    preservation_rules: preservationRules.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    permission_envelope: grants.sort((a, b) => compareStrings(a.grant_ref, b.grant_ref)),
    carves: revision.carves
      .map((carve) => ({
        ...carve,
        aspects: [...carve.aspects],
        operation_categories: [...carve.operation_categories],
        bound_scope: { ...carve.bound_scope, baselines: { ...carve.bound_scope.baselines } },
        provenance: { update_id: "", provider: "", operation: "INIT" as const },
      }))
      .sort((a, b) => compareStrings(a.carve_ref, b.carve_ref)),
    fiscal_envelope: fiscalEnvelope.sort((a, b) =>
      a.clause_ref === b.clause_ref ? compareStrings(a.key, b.key) : compareStrings(a.clause_ref, b.clause_ref),
    ),
    temporal_conditions: gates,
    allowed_policy_params: composed.composition,
    completion_criteria: completionCriteria.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    residues: residues.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    layers: layers.sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
    operation_impacts: capabilities.operation_impacts ?? {},
    active_clauses: revision.clauses.map((clause) => ({ ...clause, source_span: undefined,
      provenance: { update_id: "", provider: "", operation: "INIT" as const },
      bound_scope: { ...clause.bound_scope, baselines: { ...clause.bound_scope.baselines } } }))
      .sort((a, b) => compareStrings(a.clause_ref, b.clause_ref)),
  };
  return { artifact, diagnostics };
}

function obligationVerifiability(obligation: CompletionObligation, clause: Clause, capabilities: CapabilitySet): Tri {
  if (obligation.tense === "MAINTAIN_WINDOW" && (obligation.time_base !== "WORLD_GENERATION" ||
    !obligation.window_samples_required || obligation.window_samples_required < 1)) return "FALSE";
  if (obligation.tense === "NON_BINARY" && !clause.completion?.decision_protocol) {
    return "FALSE";
  }
  if (!obligation.evidence_source) {
    return "UNKNOWN";
  }
  if (!capabilities.evaluators.includes(obligation.evidence_source)) {
    return "FALSE";
  }
  return "TRUE";
}

function buildObligation(clause: Clause,world:WorldSnapshot,revision:AcceptedRevision): CompletionObligation {
  const completion = clause.completion;
  if (!completion) {
    throw new Error("buildObligation requires a completion contract");
  }
  let domain = completion.domain.kind === "SNAPSHOT_ENTITIES"
    ? { ...completion.domain, bound_entities: [...clause.bound_scope.bound_entities], bound_cells: [...(clause.bound_scope.frozen_extent?.cells ?? [])], bound_session: clause.bound_scope.anchor }
    : { ...completion.domain };
  if (clause.residualized && completion.domain.kind === "FIXED_SELECTOR") {
    const residual=verifyScope(clause.bound_scope,world,clause.aspects,revision.revision);
    const original=completion.domain.selector ? resolveSelector(completion.domain.selector,world) : null;
    if (residual.unresolved || !original?.ok || completion.domain.denominator?.kind === "FIXED_DISTRICT_AREA")
      domain={ ...domain,residual_unresolved:true };
    else {
      const cells=original.extent.cells.filter((cell)=>residual.extent.cells.includes(cell));
      const entities=world.objects.filter((object)=>extentContains(original.extent,object) &&
        extentContains(residual.extent,object) && !cells.includes(object.cell)).map((object)=>object.id).sort();
      domain={ ...domain,bound_extent:{ cells,entities,universe_bound:false },bound_session:world.session };
    }
  }
  return {
    clause_ref: clause.clause_ref,
    role: completion.proxy_of ? "PROXY" : "ORIGINAL",
    strength: clause.strength,
    tense: completion.tense,
    metric: completion.metric,
    unit: completion.unit,
    comparator: completion.comparator,
    threshold: completion.threshold,
    domain,
    vacuous: completion.vacuous,
    evidence_source: completion.evidence_source,
    window_samples_required: completion.window_samples_required ?? null,
    time_base: completion.time_base ?? null,
    approximation_ref: completion.approximation_ref ?? null,
    proxy_of: completion.proxy_of ?? null,
    status: "ACTIVE",
  };
}

function buildGrant(
  clause: Clause,
  world: WorldSnapshot,
  revision: AcceptedRevision,
  evidence: EvidenceRegister,
): GrantRecord {
  const params = (clause.params ?? {}) as unknown as Partial<PermissionParams>;
  const extent = verifyScope(clause.bound_scope, world, clause.aspects, revision.revision).extent;
  const validity = params.validity ?? { kind: "UNTIL_REVOKED" as const };
  const consumed = evidence.committed_ops
    .filter((record) => record.grant_ref === clause.clause_ref && record.state === "COMMITTED")
    .reduce((total, record) => total + record.affected_objects.length, 0);
  const inFlight = evidence.committed_ops.some(
    (record) => record.grant_ref === clause.clause_ref && record.state !== "COMMITTED",
  );
  return {
    grant_ref: clause.clause_ref,
    clause_ref: clause.clause_ref,
    allow: params.allow ?? true,
    operation_categories: params.operation_categories ? [...params.operation_categories] : [],
    affected_aspects: params.affected_aspects ? [...params.affected_aspects] : [...clause.aspects],
    scope_ref: clause.bound_scope.scope_ref,
    extent,
    purpose: clause.owner ?? { kind: "INDEPENDENT" },
    validity,
    object_limit: params.object_limit ? [...params.object_limit] : null,
    use_limit: params.use_limit ? [...params.use_limit] : null,
    quantity_max: validity.kind === "QUANTITY" ? validity.max : null,
    // An in-flight commit makes the remaining quantity unknown, never zero (V1 §5.3).
    consumed: validity.kind === "QUANTITY" ? (inFlight ? null : consumed) : null,
    status: "ACTIVE",
    revocation_reason: null,
    origin: "PLAYER",
  };
}

function buildConstraint(clause: Clause, world: WorldSnapshot, revision: AcceptedRevision): ConstraintRecord {
  const base = verifyScope(clause.bound_scope, world, clause.aspects, revision.revision).extent;
  const carved = revision.carves
    .filter((carve) => carve.rule_ref === clause.clause_ref)
    .map((carve) => ({
      carve_ref: carve.carve_ref,
      extent: verifyScope(carve.bound_scope, world, carve.aspects, revision.revision).extent,
    }));
  // Carves are operation and aspect specific. A single geometric residual cannot
  // erase the rule for other operations; admission evaluates all dimensions.
  const residual = base;
  return {
    clause_ref: clause.clause_ref,
    strength: clause.strength,
    residual,
    carved,
    predicate: clause.predicate ?? null,
    aspects: [...clause.aspects],
    hard: clause.strength === "REQUIRED",
  };
}

function buildPreservation(clause: Clause, world: WorldSnapshot, revision: AcceptedRevision): PreservationRule {
  const verification = verifyScope(clause.bound_scope, world, clause.aspects, revision.revision);
  return {
    clause_ref: clause.clause_ref,
    strength: clause.strength,
    scope_ref: clause.bound_scope.scope_ref,
    binding: clause.bound_scope.binding,
    extent: verification.extent,
    members: verification.members,
    missing: verification.missing,
    aspects: [...clause.aspects],
    boundary: clause.completion ? "WORLD_RESULT" : "AI_DIRECT_INTERVENTION",
    divergences: verification.divergences,
  };
}
