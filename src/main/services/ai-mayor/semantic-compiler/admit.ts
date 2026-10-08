/** Joint V1 candidate admission over accepted clauses and trusted finite evidence. */
import { evaluatePredicateSpec } from "./gates";
import { extentContains, verifyScope } from "./scope";
import type { Candidate, CandidateEffect, Clause, ConflictPause, Diagnostic, GrantRecord, ImpactCertificate, IndependenceCertificate, RuleCarve, SemanticArtifact, WorldObject, WorldSnapshot } from "./types";
import { stableStringify } from "./util";

export interface AdmissionInput { artifact: SemanticArtifact; world: WorldSnapshot; candidate: Candidate; pause?: ConflictPause | null }
export interface AdmissionResult { admitted: boolean; diagnostics: Diagnostic[] }
const block = (code: Diagnostic["code"], refs: string[], detail: string): Diagnostic => ({ code, severity:"BLOCK", refs, detail });
const object = (world: WorldSnapshot, id: string): WorldObject | undefined => world.objects.find((o) => o.id === id);
const contains = (extent: { cells:string[]; entities:string[]; excluded_entities?:string[] }, world: WorldSnapshot, id: string): boolean => {
  const found = object(world,id);
  return !!found && extentContains({ ...extent, universe_bound:false },found);
};
const active = (artifact: SemanticArtifact): Clause[] => artifact.active_clauses?.filter((c) => c.status === "ACTIVE") ?? [];

function carveMatches(carves: RuleCarve[], rule: string, effect: CandidateEffect, category: Candidate["operation_category"], world: WorldSnapshot, revision: number): boolean {
  return carves.some((carve) => {
    if (carve.rule_ref !== rule || !carve.aspects.includes(effect.aspect) || !carve.operation_categories.includes(category)) return false;
    const checked = verifyScope(carve.bound_scope,world,carve.aspects,revision);
    return !checked.unresolved && contains(checked.extent,world,effect.object_id);
  });
}

function authoritativeImpact(artifact: SemanticArtifact, world: WorldSnapshot, candidate: Candidate): Diagnostic[] {
  const problems: Diagnostic[] = [];
  const registration = artifact.operation_impacts?.[candidate.operation_category];
  const impactRows = world.impact_certificates?.filter((c) =>
    c.certificate_ref === candidate.impact_certificate_ref && c.candidate_ref === candidate.candidate_ref) ?? [];
  const certificate: ImpactCertificate | undefined = impactRows.length === 1 ? impactRows[0] : undefined;
  if (impactRows.length > 1) problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref],"ambiguous impact certificate identity"));
  if (certificate) {
    if (certificate.source !== "SYNTHETIC_INSPECTOR" || certificate.generation !== world.generation || certificate.session !== world.session ||
      certificate.operation_category !== candidate.operation_category || stableStringify(certificate.extent) !== stableStringify(candidate.extent) ||
      stableStringify(certificate.effects) !== stableStringify(candidate.effects) ||
      !(registration?.possible_aspects ?? []).every((a) => certificate.complete_aspects.includes(a)))
      problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref],"impact certificate does not cover this candidate and registration"));
  } else if (!registration || !registration.complete) {
    problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref],"operation has no authoritative complete impact proof"));
  } else {
    for (const aspect of registration.required_aspects)
      if (!candidate.effects.some((e) => e.aspect === aspect))
        problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref,aspect],"required operation impact omitted"));
    for (const effect of candidate.effects)
      if (!registration.possible_aspects.includes(effect.aspect))
        problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref,effect.aspect],"effect outside registered impact coverage"));
  }
  if (!candidate.effects.length || !candidate.impact_coverage.complete)
    problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref],"effect list or coverage incomplete"));
  for (const effect of candidate.effects) {
    if (effect.aspect === "use" && !effect.to_use && artifact.permission_envelope.some((g) => !g.allow && g.use_limit &&
      g.operation_categories.includes(candidate.operation_category) && contains(g.extent,world,effect.object_id)))
      problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref,effect.object_id],"use-limited prohibition requires a typed use effect"));
    if (effect.verified !== "TRUE" || !contains(candidate.extent,world,effect.object_id))
      problems.push(block("IMPACT_UNKNOWN",[candidate.candidate_ref,effect.object_id,effect.aspect],"effect unverified or outside operated extent"));
  }
  return problems;
}

function grantReason(grant: GrantRecord, artifact: SemanticArtifact, world: WorldSnapshot, candidate: Candidate, effect: CandidateEffect): Diagnostic | null {
  if (!grant.allow || grant.status !== "ACTIVE" || !grant.operation_categories.includes(candidate.operation_category) || !grant.affected_aspects.includes(effect.aspect) ||
    !contains(grant.extent,world,effect.object_id)) return block("PERMISSION_DENIED",[candidate.candidate_ref,grant.grant_ref],"grant does not cover impact");
  if (grant.purpose.kind === "BOUND" && !candidate.purpose_target_refs.includes(grant.purpose.target_ref))
    return block("PERMISSION_DENIED",[candidate.candidate_ref,grant.grant_ref],"grant purpose differs");
  if (grant.object_limit && !grant.object_limit.includes(effect.object_id))
    return block("PERMISSION_DENIED",[candidate.candidate_ref,grant.grant_ref],"object outside grant limit");
  if (grant.use_limit && (!effect.to_use || !grant.use_limit.includes(effect.to_use)))
    return block("PERMISSION_DENIED",[candidate.candidate_ref,grant.grant_ref],"use outside grant limit");
  const gateRef = grant.validity.kind === "UNTIL_GATE" ? grant.validity.gate_ref : null;
  if (gateRef !== null && artifact.temporal_conditions.find((g) => g.gate_ref === gateRef)?.state !== "TRUE")
    return block("GATE_CLOSED",[candidate.candidate_ref,grant.grant_ref],"grant validity gate closed or unknown");
  if (grant.quantity_max !== null && grant.consumed === null)
    return block("EVIDENCE_UNKNOWN",[candidate.candidate_ref,grant.grant_ref],"grant consumption unknown");
  if (grant.quantity_max !== null && grant.consumed !== null &&
    grant.consumed + new Set(candidate.effects.map((e) => e.object_id)).size > grant.quantity_max)
    return block("PERMISSION_DENIED",[candidate.candidate_ref,grant.grant_ref],"grant quantity exhausted");
  return null;
}

function verifiedIndependence(world: WorldSnapshot, candidate: Candidate, unresolved: string[]): IndependenceCertificate | null {
  const expected = [...unresolved].sort();
  const digest = stableStringify({ operation_category:candidate.operation_category,extent:candidate.extent,
    effects:candidate.effects,resources:candidate.resources,purpose_target_refs:[...candidate.purpose_target_refs].sort() });
  const rows=world.independence_certificates?.filter((c) => c.candidate_ref === candidate.candidate_ref) ?? [];
  if (rows.length !== 1) return null;
  return rows.find((c) =>
    c.source === "SYNTHETIC_INSPECTOR" && c.candidate_ref === candidate.candidate_ref && c.generation === world.generation && c.session === world.session &&
    c.candidate_digest === digest &&
    stableStringify([...c.unresolved_obligation_refs].sort()) === stableStringify(expected) && c.scope_known && c.effects_disjoint && !c.uses_unresolved_gates_or_grants &&
    c.shared_resources.every((r) => r.reservation_ref !== null || r.conservative_bound !== null)) ?? null;
}

export function admitCandidate(input: AdmissionInput): AdmissionResult {
  const { artifact, world, candidate } = input;
  const diagnostics: Diagnostic[] = [];
  const refs = [candidate.candidate_ref];
  if (input.pause)
    diagnostics.push(block("AMBIGUOUS_CANCEL",refs,"unresolved cancellation pauses related writing"));
  if (candidate.revision !== artifact.revision || candidate.world_generation !== artifact.world_generation ||
    world.generation !== artifact.world_generation || world.session !== artifact.session)
    diagnostics.push(block("STALE_REVISION",refs,"candidate, artifact and actual world must share revision and generation"));

  diagnostics.push(...authoritativeImpact(artifact,world,candidate));
  const clauses = active(artifact);
  const goals = new Map(artifact.goals.map((g) => [g.clause_ref,g]));
  for (const purpose of candidate.purpose_target_refs)
    if (!goals.has(purpose)) diagnostics.push(block("AMBIGUOUS_REFERENCE",[candidate.candidate_ref,purpose],"purpose target is inactive"));
  for (const target of clauses.filter((c) => c.kind === "TARGET" && c.strength === "REQUIRED" && c.params?.postcondition_required === true)) {
    if (!candidate.effects.some((effect) => target.aspects.includes(effect.aspect))) continue;
    const certificate = world.impact_certificates?.find((c) => c.certificate_ref === candidate.impact_certificate_ref && c.candidate_ref === candidate.candidate_ref);
    if (!certificate?.postcondition_refs?.includes(target.clause_ref))
      diagnostics.push(block("INDEPENDENCE_UNPROVEN",[candidate.candidate_ref,target.clause_ref],"hard result requires verified postcondition evidence"));
  }

  const destructive = candidate.operation_category === "demolition" || candidate.effects.some((e) => e.kind === "IMPLICIT_DELETE" || e.aspect === "existence");
  if (destructive && !candidate.purpose_target_refs.length)
    diagnostics.push(block("PERMISSION_DENIED",refs,"destructive work requires an explicit change target as well as a grant"));

  for (const gate of artifact.temporal_conditions)
    if (gate.affects.some((ref) => candidate.purpose_target_refs.includes(ref)) && gate.state !== "TRUE")
      diagnostics.push(block(gate.state === "UNKNOWN" ? "GATE_UNKNOWN" : "GATE_CLOSED",[candidate.candidate_ref,gate.gate_ref],"purpose gate is not open"));

  for (const clause of clauses) {
    if (clause.kind !== "CONSTRAINT" && clause.kind !== "PRESERVE" && clause.kind !== "TARGET") continue;
    const checked = verifyScope(clause.bound_scope,world,clause.aspects,artifact.revision);
    if (checked.unresolved) {
      diagnostics.push(block("SCOPE_UNBOUND",[candidate.candidate_ref,clause.clause_ref],"active rule scope is unresolved"));
      continue;
    }
    const hits = candidate.effects.filter((e) => contains(checked.extent,world,e.object_id));
    if (!hits.length) continue;
    if (clause.kind === "PRESERVE" && clause.strength === "REQUIRED") {
      for (const effect of hits)
        if (clause.aspects.includes(effect.aspect) && !carveMatches(artifact.carves,clause.clause_ref,effect,candidate.operation_category,world,artifact.revision))
          diagnostics.push(block("HARD_CONFLICT",[candidate.candidate_ref,clause.clause_ref,effect.object_id,effect.aspect],"required preserved aspect would change"));
    }
    if (clause.kind === "CONSTRAINT" && clause.strength === "REQUIRED" && !Array.isArray(clause.params?.fiscal)) {
      const relevant = hits.some((e) => clause.aspects.includes(e.aspect) &&
        !carveMatches(artifact.carves,clause.clause_ref,e,candidate.operation_category,world,artifact.revision));
      if (!relevant) continue;
      const value = clause.predicate ? evaluatePredicateSpec(clause.predicate,world) : "UNKNOWN";
      if (value !== "TRUE") diagnostics.push(block(value === "FALSE" ? "HARD_CONFLICT" : "FEASIBILITY_UNKNOWN",
        [candidate.candidate_ref,clause.clause_ref],"hard constraint is false or unobserved"));
    }
    if (clause.kind === "TARGET" && clause.strength === "REQUIRED" && clause.aspects.includes("vacancy") &&
      clause.completion?.tense === "MAINTAIN_OPEN" &&
      hits.some((e) => ["use","vacancy","existence"].includes(e.aspect)))
      diagnostics.push(block("HARD_CONFLICT",[candidate.candidate_ref,clause.clause_ref],"vacant MAINTAIN forbids infill in its bound scope"));
  }

  for (const effect of candidate.effects) {
    const forbids = artifact.permission_envelope.filter((g) => !g.allow && g.status === "ACTIVE" &&
      g.operation_categories.includes(candidate.operation_category) && g.affected_aspects.includes(effect.aspect) &&
      (!g.use_limit || !!effect.to_use && g.use_limit.includes(effect.to_use)) &&
      contains(g.extent,world,effect.object_id) &&
      !carveMatches(artifact.carves,g.clause_ref ?? g.grant_ref,effect,candidate.operation_category,world,artifact.revision));
    if (forbids.length) diagnostics.push(block("PERMISSION_DENIED",[candidate.candidate_ref,...forbids.map((g) => g.grant_ref)],"active FORBID covers effect"));
    const allows = artifact.permission_envelope.filter((g) => g.allow && g.status === "ACTIVE").map((g) => ({ grant:g, reason:grantReason(g,artifact,world,candidate,effect) }));
    if (!allows.some((entry) => entry.reason === null)) {
      const best = allows.find((entry) => entry.reason?.code === "EVIDENCE_UNKNOWN" || entry.reason?.code === "GATE_CLOSED")?.reason;
      diagnostics.push(best ?? block("PERMISSION_DENIED",[candidate.candidate_ref,effect.object_id,effect.aspect],"no valid ALLOW covers effect"));
    }
  }

  const cash = candidate.resources.cash ?? 0;
  if (!Number.isFinite(cash) || cash < 0) diagnostics.push(block("INVALID_IR",refs,"candidate cash request must be finite and nonnegative"));
  const hardCash = artifact.fiscal_envelope.some((f) => f.hard && f.key === "cash_floor");
  const resourceRows = world.resource_certificates?.filter((c) => c.candidate_ref === candidate.candidate_ref) ?? [];
  const resource = resourceRows.length === 1 ? resourceRows.find((c) =>
    c.source === "SYNTHETIC_INSPECTOR" && c.generation === world.generation && c.session === world.session &&
    c.operation_category === candidate.operation_category && stableStringify(c.extent) === stableStringify(candidate.extent) &&
    stableStringify(c.effects) === stableStringify(candidate.effects) && Number.isFinite(c.cash_cost) && c.cash_cost >= 0) : undefined;
  if ((hardCash || cash > 0) && !resource)
    diagnostics.push(block("EVIDENCE_UNKNOWN",refs,"candidate cash cost has no trusted synthetic resource proof"));
  if (resource && resource.cash_cost !== cash)
    diagnostics.push(block("EVIDENCE_UNKNOWN",refs,"candidate cash request differs from inspected cost"));
  const provenCash = resource?.cash_cost ?? cash;
  if (provenCash > 0 && world.cash === null) diagnostics.push(block("EVIDENCE_UNKNOWN",refs,"cash is unobserved"));
  else if (provenCash > 0 && world.cash !== null && world.cash < provenCash) diagnostics.push(block("RESOURCE_INSUFFICIENT",refs,"cash is insufficient"));
  for (const fiscal of artifact.fiscal_envelope.filter((f) => f.hard)) {
    if (fiscal.key === "cash_floor" && (world.cash === null || world.cash - provenCash < fiscal.value))
      diagnostics.push(block(world.cash === null ? "EVIDENCE_UNKNOWN" : "RESOURCE_INSUFFICIENT",[candidate.candidate_ref,fiscal.clause_ref],"player cash floor would be violated"));
    if (fiscal.key === "forbid_loan" && candidate.operation_category === "loan")
      diagnostics.push(block("PERMISSION_DENIED",[candidate.candidate_ref,fiscal.clause_ref],"player forbids loans"));
  }

  const unresolved = [...new Set([
    ...artifact.residues.filter((r) => r.strength === "REQUIRED").map((r) => r.clause_ref),
    ...clauses.filter((c) => c.kind === "TARGET" && c.strength === "REQUIRED" && c.completion?.tense === "MAINTAIN_OPEN")
      .filter((c) => !candidate.purpose_target_refs.includes(c.clause_ref)).map((c) => c.clause_ref),
  ])];
  if (unresolved.length && !verifiedIndependence(world,candidate,unresolved))
    diagnostics.push(block("INDEPENDENCE_UNPROVEN",[candidate.candidate_ref,...unresolved],"trusted finite independence evidence is missing"));
  return { admitted:diagnostics.length === 0, diagnostics };
}
