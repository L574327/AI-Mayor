/** Evidence-based V1 completion. A claim closes only with exact domain, time and source coverage. */
import { compare } from "./gates";
import { extentMembers, resolveSelector } from "./scope";
import type { CompletionObligation, Diagnostic, EvidenceRegister, MetricSample, SemanticArtifact, Tri, WorldSnapshot } from "./types";
import { compareStrings } from "./util";

export type CompletionStatus = "REACHED" | "NOT_REACHED" | "WINDOW_SATISFIED" | "VIOLATED" | "ONGOING_SATISFIED" | "UNKNOWN" | "UNRESOLVED";
export interface CompletionEvaluation { clause_ref:string; role:"ORIGINAL"|"PROXY"; tense:CompletionObligation["tense"]; status:CompletionStatus; satisfied_closed:boolean; refs:string[]; detail:string; reached_at_generation?:number }
export interface MissionCompletion { complete:boolean; required:CompletionEvaluation[]; disclosures:string[]; diagnostics:Diagnostic[] }
const problem = (code:Diagnostic["code"],refs:string[],detail:string):Diagnostic => ({ code,severity:"BLOCK",refs,detail });
const result = (o:CompletionObligation,status:CompletionStatus,closed:boolean,refs:string[],detail:string):CompletionEvaluation =>
  ({ clause_ref:o.clause_ref,role:o.role,tense:o.tense,status,satisfied_closed:closed,refs,detail });

function domain(o:CompletionObligation,world:WorldSnapshot): { keys:string[]; empty:boolean; valid:boolean } {
  const decl = o.domain;
  if (decl.residual_unresolved) return { keys:[],empty:false,valid:false };
  if (decl.kind === "SNAPSHOT_ENTITIES") {
    if (decl.bound_session !== world.session || !decl.bound_entities) return { keys:[],empty:false,valid:false };
    return { keys:[...decl.bound_entities].sort(),empty:decl.bound_entities.length === 0,valid:true };
  }
  if (decl.bound_extent) {
    if (decl.bound_session !== world.session) return { keys:[],empty:false,valid:false };
    const entities=extentMembers(decl.bound_extent,world);
    const keys=decl.denominator?.kind === "COUNT_RECEPTORS" || decl.selector?.kind === "object_kind" || decl.selector?.kind === "objects"
      ? entities : decl.bound_extent.cells.length ? decl.bound_extent.cells : entities;
    return { keys,empty:keys.length===0,valid:true };
  }
  if (decl.denominator?.kind === "FIXED_DISTRICT_AREA") {
    const area = decl.denominator;
    const measuredArea = area.cells.reduce((total,cell) => total + (world.areas[cell] ?? NaN),0);
    if (area.area_km2 <= 0 || area.cells.length === 0 || !Number.isFinite(measuredArea) || Math.abs(measuredArea-area.area_km2) > 1e-9 ||
      o.metric === "density" && decl.population_basis !== "BUILT") return { keys:[],empty:false,valid:false };
    return { keys:[decl.scope_ref],empty:false,valid:true };
  }
  if (!decl.selector) return { keys:[],empty:false,valid:false };
  const resolved = resolveSelector(decl.selector,world);
  if (!resolved.ok) return { keys:[],empty:false,valid:false };
  const entities = extentMembers(resolved.extent,world);
  if (decl.denominator?.kind === "COUNT_RECEPTORS" || decl.selector.kind === "object_kind" || decl.selector.kind === "objects")
    return { keys:entities,empty:entities.length === 0,valid:true };
  return { keys:resolved.extent.cells.length ? resolved.extent.cells : entities,
    empty:resolved.extent.cells.length === 0 && entities.length === 0,valid:true };
}

function sampleTruth(o:CompletionObligation,sample:MetricSample,world:WorldSnapshot):Tri {
  if (sample.metric !== o.metric || sample.unit !== o.unit || sample.source !== o.evidence_source ||
      sample.coverage !== "TRUE" || sample.value === null || sample.generation !== world.generation ||
      sample.precision === null || !Number.isFinite(sample.precision) || sample.precision < 0 || sample.samples < 1) return "UNKNOWN";
  if (typeof sample.value !== typeof o.threshold) return "UNKNOWN";
  if (o.metric === "density" && o.domain.denominator?.kind === "FIXED_DISTRICT_AREA") {
    const area = o.domain.denominator;
    const buildings = world.objects.filter((object) => object.kind === "building" && area.cells.includes(object.cell));
    if (buildings.some((building) => building.occupants === null) || typeof sample.value !== "number") return "UNKNOWN";
    const builtDensity = buildings.reduce((total,building) => total + (building.occupants ?? 0),0) / area.area_km2;
    if (Math.abs(sample.value - builtDensity) > sample.precision) return "UNKNOWN";
  }
  if (typeof sample.value !== "number" && sample.precision !== 0) return "UNKNOWN";
  if (typeof sample.value === "number" && typeof o.threshold === "number") {
    const low = sample.value - sample.precision;
    const high = sample.value + sample.precision;
    if (o.comparator === ">=" || o.comparator === ">") {
      if (compare(o.comparator,low,o.threshold)) return "TRUE";
      if (!compare(o.comparator,high,o.threshold)) return "FALSE";
      return "UNKNOWN";
    }
    if (o.comparator === "<=" || o.comparator === "<") {
      if (compare(o.comparator,high,o.threshold)) return "TRUE";
      if (!compare(o.comparator,low,o.threshold)) return "FALSE";
      return "UNKNOWN";
    }
    if (sample.precision !== 0) return "UNKNOWN";
  }
  return compare(o.comparator,sample.value as number|string,o.threshold) ? "TRUE" : "FALSE";
}

function latestEvidence(o:CompletionObligation,key:string,world:WorldSnapshot,evidence:EvidenceRegister):MetricSample | null {
  const rows = evidence.samples.filter((s) => s.metric === o.metric && s.scope_key === key && s.generation === world.generation);
  if (rows.length !== 1) return null;
  return rows[0];
}

export function evaluateObligation(o:CompletionObligation,world:WorldSnapshot,evidence:EvidenceRegister):CompletionEvaluation {
  if (o.domain.kind === "SNAPSHOT_ENTITIES" && o.domain.bound_entities?.some((id) => !world.objects.some((object) => object.id === id)))
    return result(o,"UNKNOWN",false,o.domain.bound_entities,"a bound object is missing from world readback");
  const declared = domain(o,world);
  const refs = declared.keys.length ? declared.keys : [o.domain.scope_ref];
  if (!declared.valid) return result(o,"UNRESOLVED",false,refs,"completion domain or denominator is not bound");
  if (declared.empty) {
    if (o.vacuous !== "ALLOW_VACUOUS") return result(o,o.vacuous === "UNRESOLVED" ? "UNRESOLVED" : "UNKNOWN",false,refs,"empty quantified domain");
    if (o.tense === "NON_BINARY") return result(o,"UNRESOLVED",false,refs,"qualitative decision protocol required");
    if (o.tense === "MAINTAIN_OPEN") return result(o,"ONGOING_SATISFIED",false,refs,"explicit vacuous policy; obligation remains open");
    return result(o,o.tense === "REACH" ? "REACHED" : "WINDOW_SATISFIED",true,refs,"explicit vacuous policy");
  }
  if (o.tense === "NON_BINARY") return result(o,"UNRESOLVED",false,refs,"qualitative decision protocol has no verified decision evidence");

  if (o.tense === "MAINTAIN_WINDOW") {
    const need = o.window_samples_required;
    if (!need || need < 1 || !Number.isInteger(need) || o.time_base !== "WORLD_GENERATION")
      return result(o,"UNRESOLVED",false,refs,"window length or clock is not declared");
    const all: Tri[] = [];
    for (let generation = world.generation - need + 1; generation <= world.generation; generation++) {
      if (generation < 0) return result(o,"UNKNOWN",false,refs,"window extends before known history");
      for (const key of declared.keys) {
        const rows = evidence.samples.filter((s) => s.metric === o.metric && s.scope_key === key && s.generation === generation);
        if (rows.length !== 1) { all.push("UNKNOWN"); continue; }
        all.push(sampleTruth(o,rows[0],{ ...world,generation }));
      }
    }
    if (all.includes("FALSE")) return result(o,"VIOLATED",false,refs,"a covered window point violates the threshold");
    if (all.includes("UNKNOWN")) return result(o,"UNKNOWN",false,refs,"window has missing or invalid evidence");
    return result(o,"WINDOW_SATISFIED",true,refs,"every declared window point is covered");
  }

  const values = declared.keys.map((key) => {
    const measured = latestEvidence(o,key,world,evidence);
    return measured ? sampleTruth(o,measured,world) : "UNKNOWN";
  });
  if (values.includes("UNKNOWN")) return result(o,"UNKNOWN",false,refs,"quantified domain has missing, stale, imprecise or mismatched evidence");
  if (values.includes("FALSE")) return result(o,o.tense === "REACH" ? "NOT_REACHED" : "VIOLATED",false,refs,"a covered member fails the threshold");
  return o.tense === "REACH" ? { ...result(o,"REACHED",true,refs,"all required evidence reaches the threshold"),reached_at_generation:world.generation }
    : result(o,"ONGOING_SATISFIED",false,refs,"open maintenance is currently satisfied");
}

export function aggregateMission(artifact:SemanticArtifact,world:WorldSnapshot,evidence:EvidenceRegister):MissionCompletion {
  const diagnostics:Diagnostic[] = [];
  const disclosures:string[] = [];
  const obligations = artifact.completion_criteria.filter((o) => o.status === "ACTIVE");
  const required = obligations.filter((o) => o.strength === "REQUIRED")
    .sort((a,b) => compareStrings(a.clause_ref,b.clause_ref))
    .map((o) => evaluateObligation(o,world,evidence));
  for (const evaluation of required) {
    if (evaluation.role === "PROXY") disclosures.push(evaluation.clause_ref + ": proxy result; original meaning is not claimed");
    if (evaluation.tense === "NON_BINARY") disclosures.push(evaluation.clause_ref + ": qualitative obligation is unresolved");
    if (!evaluation.satisfied_closed) diagnostics.push(problem(evaluation.status === "UNRESOLVED" ? "CONTRACT_UNRESOLVED" : "EVIDENCE_UNKNOWN",
      [evaluation.clause_ref],"required obligation is " + evaluation.status));
  }
  for (const residue of artifact.residues) {
    if (residue.strength === "REQUIRED") diagnostics.push(problem("CONTRACT_UNRESOLVED",[residue.clause_ref],"required residue remains: " + residue.detail));
    else disclosures.push(residue.clause_ref + ": preferred residue " + residue.reason);
  }
  for (const o of obligations.filter((entry) => entry.strength === "PREFERRED")) disclosures.push(o.clause_ref + ": preferred completion is separately disclosed");

  const requiredGoals = artifact.goals.filter((g) => g.strength === "REQUIRED");
  for (const goal of requiredGoals) {
    const own = obligations.find((o) => o.clause_ref === goal.clause_ref && o.role === "ORIGINAL");
    const proxy = obligations.find((o) => o.clause_ref === goal.clause_ref && o.role === "PROXY");
    if (!own) {
      const replaced = proxy?.proxy_of && artifact.active_clauses?.some((c) => c.status === "SUPERSEDED" && c.clause_ref.startsWith(proxy.proxy_of + "@h"));
      if (!proxy || !replaced) diagnostics.push(problem("CONTRACT_UNRESOLVED",[goal.clause_ref],"active required original has no original completion contract"));
    }
  }
  for (const rule of artifact.active_clauses ?? [])
    if (rule.status === "ACTIVE" && rule.strength === "REQUIRED" && (rule.kind === "PRESERVE" || rule.kind === "CONSTRAINT")) {
      const certificate = evidence.invariant_certificates?.find((c) => c.clause_ref === rule.clause_ref &&
        c.session === world.session && c.through_generation === world.generation && c.source === "SYNTHETIC_INSPECTOR");
      if (!certificate || certificate.coverage !== "TRUE" || certificate.holds !== "TRUE")
        diagnostics.push(problem("EVIDENCE_UNKNOWN",[rule.clause_ref],"required invariant or preservation lacks full period evidence"));
    }
  if (artifact.session !== world.session || artifact.world_generation !== world.generation)
    diagnostics.push(problem("EVIDENCE_UNKNOWN",[],"artifact and world generation differ"));
  if (artifact.five_layers.verifiability === "FALSE")
    diagnostics.push(problem("CONTRACT_UNRESOLVED",[],"required evaluator is unavailable"));
  if (!required.length) diagnostics.push(problem("CONTRACT_UNRESOLVED",requiredGoals.map((g) => g.clause_ref),"no required completion obligations"));
  return { complete:required.length > 0 && diagnostics.length === 0,required,disclosures:disclosures.sort(),diagnostics };
}
