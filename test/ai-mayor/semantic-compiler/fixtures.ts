/** Hand-authored V1 inputs and synthetic, registered world facts. */
import { compile } from "../../../src/main/services/ai-mayor/semantic-compiler/compile";
import type { Candidate, CapabilitySet, ClauseInput, CompileResult, EvidenceRegister, ImpactCertificate, IndependenceCertificate, LandUse, MappingDef, MayorIntentUpdate, MetricSample, ObjectKind, ScopeDecl, ScopeSelector, UpdateOp, WorldObject, WorldSnapshot } from "../../../src/main/services/ai-mayor/semantic-compiler/types";
import { ONTOLOGY_VERSION, SCHEMA_VERSION } from "../../../src/main/services/ai-mayor/semantic-compiler/types";
import { stableStringify } from "../../../src/main/services/ai-mayor/semantic-compiler/util";

export interface ObjectSpec { id:string; kind:ObjectKind; cell:string; name?:string; uses?:LandUse[]; floors?:number|null; appearance?:string|null; model?:string|null; occupants?:number|null; polluted?:boolean|null }
export const object = (s:ObjectSpec):WorldObject => ({ id:s.id,kind:s.kind,cell:s.cell,name:s.name ?? s.id,uses:s.uses ?? [],
  floors:s.floors ?? null,appearance:s.appearance ?? null,model:s.model ?? null,occupants:s.occupants ?? null,polluted:s.polluted ?? null });
export const sample = (p:Partial<MetricSample> & Pick<MetricSample,"metric"|"scope_key"|"value">):MetricSample =>
  ({ unit:"count",generation:1,coverage:"TRUE",precision:0,samples:1,source:"population_density_eval",...p });

export const DEFAULT_OBJECTS:WorldObject[] = [
  object({ id:"b_east_1",kind:"building",cell:"east",uses:["residential"],floors:3,appearance:"european",model:"a",occupants:20 }),
  object({ id:"b_east_2",kind:"building",cell:"east",uses:["commercial"],floors:2,appearance:"european",model:"b",occupants:5 }),
  object({ id:"b_west_1",kind:"building",cell:"west",uses:["residential"],floors:4,appearance:"european",model:"a",occupants:25 }),
  object({ id:"metro_east",kind:"metro",cell:"east" }),
  object({ id:"road_east",kind:"road",cell:"east" }),
  object({ id:"land_east",kind:"land",cell:"east",uses:["vacant"] }),
];
export const DEFAULT_METRICS:MetricSample[] = [
  sample({ metric:"population",scope_key:"city",value:25000 }),
  sample({ metric:"population",scope_key:"east",value:12000 }),
  sample({ metric:"pollution",scope_key:"east",value:0,unit:"index",source:"pollution_eval" }),
  sample({ metric:"floors",scope_key:"east",value:6 }),
  sample({ metric:"density",scope_key:"east",value:80,unit:"pop/km2" }),
  sample({ metric:"grid_purity",scope_key:"east",value:"GRID",unit:"pattern" }),
];
export function makeWorld(overrides:Partial<WorldSnapshot> = {}):WorldSnapshot {
  return { session:"session-1",generation:1,cash:5000,objects:DEFAULT_OBJECTS.map((o) => ({ ...o,uses:[...o.uses] })),
    metrics:DEFAULT_METRICS.map((m) => ({ ...m })),areas:{ east:1,west:1 },impact_certificates:[],independence_certificates:[],resource_certificates:[],...overrides };
}

const mapping = (id:string,concept:MappingDef["concept"],accepts:MappingDef["accepts"],effect:MappingDef["effects"][number],extra:Partial<MappingDef> = {}):MappingDef =>
  ({ mapping_id:id,version:"v1",concept,accepts,effects:[effect],aspects:[effect.aspect],assumptions:[],
    impact_coverage:{ aspects:[effect.aspect],complete:true },requires:{},approximation_required:false,template:false,...extra });
export const DEFAULT_MAPPINGS:MappingDef[] = [
  mapping("use.add",null,{ predicate:"new_build.use" },{ key:"land_use",domain:"parcel",aspect:"use",op:"add",value:"commercial",hard:false },
    { requires:{ primitives:["building_construct"] } }),
  mapping("use.exists",null,{ predicate:"exists.use" },{ key:"land_use",domain:"parcel",aspect:"use",op:"set",value:"exists",hard:false }),
  mapping("style.european","O01_STYLE",{ values:{ style:"european" } },{ key:"appearance",domain:"building",aspect:"appearance",op:"set",value:"european",hard:false }),
  mapping("style.american","O01_STYLE",{ values:{ style:"american" } },{ key:"appearance",domain:"building",aspect:"appearance",op:"set",value:"american",hard:false }),
  mapping("form.grid.local","O02_URBAN_FORM",{ values:{ pattern:"GRID",scale:"local" } },{ key:"form.grid",domain:"network:local",aspect:"network_geometry",op:"set",value:"GRID",hard:true }),
  mapping("form.not_grid.local","O02_URBAN_FORM",{ values:{ pattern:"NOT_GRID",scale:"local" } },{ key:"form.grid",domain:"network:local",aspect:"network_geometry",op:"set",value:"NOT_GRID",hard:true }),
  mapping("form.grid.city","O02_URBAN_FORM",{ values:{ pattern:"GRID",scale:"city" } },{ key:"form.grid",domain:"network:city",aspect:"network_geometry",op:"set",value:"GRID",hard:true }),
  mapping("compact","O04_EXTENT",{ values:{ pattern:"COMPACT" } },{ key:"extent",domain:"district",aspect:"network_geometry",op:"set",value:"CONTIGUOUS",hard:true }),
  mapping("density.low","O03_DENSITY",{ values:{ class:"LOW" } },{ key:"density",domain:"district",aspect:"density",op:"range",value:{ max:60 },hard:true }),
  mapping("density.high","O03_DENSITY",{ values:{ class:"HIGH" } },{ key:"density",domain:"district",aspect:"density",op:"range",value:{ min:120 },hard:true }),
  mapping("density.template.floor","O03_DENSITY",{ values:{ template:"COMPACT_HIGH" } },{ key:"density",domain:"district",aspect:"density",op:"range",value:{ min:120 },hard:true },
    { template:true,requires_declared_allowance:["density"] }),
  mapping("pollution.zero","O12_ENVIRONMENT_QUALITY",{ values:{ goal:"ZERO" } },{ key:"pollution",domain:"receptor",aspect:"pollution",op:"max",value:0,hard:true },
    { requires:{ observations:["pollution_sensor"],evaluators:["pollution_eval"] } }),
];
export const MERGE_OPERATORS = { "land_use@parcel":"use.union" as const,"appearance@building":"set.equal" as const,
  "form.grid@network:local":"set.equal" as const,"form.grid@network:city":"set.equal" as const,
  "extent@district":"set.equal" as const,"density@district":"range.intersect" as const,"pollution@receptor":"numeric.min" as const };
export function makeCapabilities(overrides:Partial<CapabilitySet> = {}):CapabilitySet {
  return { version:"cap/v1",mappings:{ version:"map/v1",mappings:DEFAULT_MAPPINGS,merge_operators:MERGE_OPERATORS },
    observations:["population","pollution","noise","density","floors","grid_purity"],
    evaluators:["pollution_eval","population_density_eval"],
    primitives:["zoning_change","building_construct","building_rebuild","demolition","road_rebuild","road_widen","style_change","land_fill","loan"],
    content:["commercial_building"],
    operation_impacts:{
      zoning_change:{ required_aspects:["use"],possible_aspects:["use"],complete:true },
      building_construct:{ required_aspects:["use"],possible_aspects:["use"],complete:true },
      building_rebuild:{ required_aspects:["use"],possible_aspects:["use","existence","appearance","model"],complete:false },
      demolition:{ required_aspects:["existence"],possible_aspects:["existence"],complete:true },
      road_rebuild:{ required_aspects:["network_geometry"],possible_aspects:["network_geometry","existence","access"],complete:false },
      road_widen:{ required_aspects:["network_geometry"],possible_aspects:["network_geometry","existence","access"],complete:false },
      style_change:{ required_aspects:["appearance"],possible_aspects:["appearance"],complete:true },
      land_fill:{ required_aspects:["use"],possible_aspects:["use","vacancy"],complete:false },
      loan:{ required_aspects:["fiscal"],possible_aspects:["fiscal"],complete:true },
    },...overrides };
}
export const emptyEvidence = ():EvidenceRegister => ({ committed_ops:[],samples:[],delivery_claims:[] });
export const defaultEvidence = ():EvidenceRegister => ({ committed_ops:[],samples:DEFAULT_METRICS.map((m) => ({ ...m })),delivery_claims:[] });

export const universe = ():ScopeDecl => ({ scope_ref:"all",selector:{ kind:"universe" },binding:"SNAPSHOT",anchor:"session-1" });
export const district = (scope_ref:string,...districts:string[]):ScopeDecl => ({ scope_ref,selector:{ kind:"district",districts },binding:"SNAPSHOT",anchor:"session-1" });
export const objects = (scope_ref:string,object_ids:string[]):ScopeDecl => ({ scope_ref,selector:{ kind:"objects",object_ids },binding:"SNAPSHOT",anchor:"session-1" });
export const kinds = (scope_ref:string,object_kinds:ObjectKind[]):ScopeDecl => ({ scope_ref,selector:{ kind:"object_kind",object_kinds },binding:"SNAPSHOT",anchor:"session-1" });
export const minus = (scope_ref:string,base:ScopeSelector,remove:ScopeSelector,binding:"SNAPSHOT"|"DYNAMIC"="SNAPSHOT"):ScopeDecl =>
  ({ scope_ref,selector:{ kind:"minus",base,remove },binding,anchor:"session-1" });
export const clause = (p:Partial<ClauseInput> & Pick<ClauseInput,"clause_ref"|"kind"|"scope">):ClauseInput =>
  ({ strength:"REQUIRED",aspects:[],...p });
export const intent = (ops:UpdateOp[],options:{ id:string;base:number;operation?:MayorIntentUpdate["operation"];provider?:string;comment?:string }):MayorIntentUpdate =>
  ({ schema_version:SCHEMA_VERSION,ontology_version:ONTOLOGY_VERSION,update_id:options.id,base_revision:options.base,
    operation:options.operation ?? "INIT",source:{ provider:options.provider ?? "test",utterance_ref:"u-"+options.id },ops,source_span_comment:options.comment });
export interface Harness { world:WorldSnapshot;capabilities:CapabilitySet;evidence:EvidenceRegister;
  run:(previous:CompileResult|null,ops:UpdateOp[],options:{ id:string;operation?:MayorIntentUpdate["operation"] })=>CompileResult;
  recompile:(previous:CompileResult)=>CompileResult }
export function harness(overrides:{ world?:Partial<WorldSnapshot>;capabilities?:Partial<CapabilitySet>;evidence?:EvidenceRegister } = {}):Harness {
  const world=makeWorld(overrides.world),capabilities=makeCapabilities(overrides.capabilities),evidence=overrides.evidence ?? defaultEvidence();
  return { world,capabilities,evidence,
    run:(previous,ops,options)=>compile({ update:intent(ops,{ id:options.id,base:previous?.revision?.revision ?? 0,operation:options.operation }),
      revision:previous?.revision ?? null,world,capabilities,evidence }),
    recompile:(previous)=>compile({ update:null,revision:previous.revision,world,capabilities,evidence }) };
}
export const candidate = (p:Partial<Candidate> & Pick<Candidate,"candidate_ref"|"revision"|"world_generation">):Candidate =>
  ({ purpose_target_refs:[],operation_category:"building_rebuild",extent:{ cells:[],entities:[],universe_bound:false },effects:[],
    impact_coverage:{ aspects:[],complete:true },resources:{},claimed_grants:[],...p });
export function attachImpact(world:WorldSnapshot,c:Candidate,aspects:Candidate["impact_coverage"]["aspects"],postconditions:string[]=[]):Candidate {
  const certificate_ref="impact:"+c.candidate_ref;
  const certificate:ImpactCertificate={ certificate_ref,candidate_ref:c.candidate_ref,operation_category:c.operation_category,
    generation:world.generation,session:world.session,extent:structuredClone(c.extent),effects:structuredClone(c.effects),
    complete_aspects:[...aspects],source:"SYNTHETIC_INSPECTOR",postcondition_refs:[...postconditions] };
  world.impact_certificates ??= [];
  world.impact_certificates.push(certificate);
  return { ...c,impact_certificate_ref:certificate_ref };
}
export function attachIndependence(world:WorldSnapshot,c:Candidate,unresolved:string[],sharedResources:IndependenceCertificate["shared_resources"]=[]):void {
  world.independence_certificates ??= [];
  world.independence_certificates.push({ certificate_ref:"independent:"+c.candidate_ref,candidate_ref:c.candidate_ref,
    candidate_digest:stableStringify({ operation_category:c.operation_category,extent:c.extent,effects:c.effects,
      resources:c.resources,purpose_target_refs:[...c.purpose_target_refs].sort() }),
    generation:world.generation,session:world.session,unresolved_obligation_refs:[...unresolved],scope_known:true,effects_disjoint:true,
    shared_resources:sharedResources,uses_unresolved_gates_or_grants:false,source:"SYNTHETIC_INSPECTOR" });
}
export function attachResource(world:WorldSnapshot,c:Candidate,cashCost:number):void {
  world.resource_certificates ??= [];
  world.resource_certificates.push({ certificate_ref:"resource:"+c.candidate_ref,candidate_ref:c.candidate_ref,
    operation_category:c.operation_category,generation:world.generation,session:world.session,
    extent:structuredClone(c.extent),effects:structuredClone(c.effects),cash_cost:cashCost,source:"SYNTHETIC_INSPECTOR" });
}
export const accept = (r:CompileResult):CompileResult => {
  if (r.outcome !== "ACCEPTED" || !r.revision || !r.artifact) throw new Error("expected ACCEPTED: "+r.diagnostics.map((d)=>d.code+":"+d.detail).join("|"));
  return r;
};
export const codes = (r:CompileResult):string[] => r.diagnostics.map((d)=>d.code);
