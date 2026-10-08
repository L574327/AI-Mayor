/** Corrected K01–K20 oracles from V1 Freeze Candidate §12.2. */
import { admitCandidate } from "../../../src/main/services/ai-mayor/semantic-compiler/admit";
import { aggregateMission } from "../../../src/main/services/ai-mayor/semantic-compiler/completion";
import { evaluateProfileLiveness } from "../../../src/main/services/ai-mayor/semantic-compiler/profile";
import type { Candidate, ClauseInput, CompletionContractInput, UpdateOp } from "../../../src/main/services/ai-mayor/semantic-compiler/types";
import { accept, attachImpact, attachIndependence, attachResource, candidate, clause, codes, district, harness, kinds, makeCapabilities, minus, object, objects, sample, universe } from "./fixtures";

const E = (object_id:string,aspect:Candidate["effects"][number]["aspect"],kind:Candidate["effects"][number]["kind"]="DIRECT_WRITE",to_use?:Candidate["effects"][number]["to_use"]) =>
  ({ object_id,aspect,kind,verified:"TRUE" as const,...(to_use ? { to_use } : {}) });
const G = (ref:string,operation:Candidate["operation_category"],aspects:Candidate["impact_coverage"]["aspects"],scope=universe(),allow=true,owner?:ClauseInput["owner"],more:Record<string,unknown>={}) =>
  clause({ clause_ref:ref,kind:"PERMISSION",scope,aspects,owner,params:{ allow,operation_categories:[operation],affected_aspects:aspects,validity:{ kind:"UNTIL_REVOKED" },...more } });
const T = (ref:string,scope=district("east","east"),aspects:Candidate["impact_coverage"]["aspects"]=["use"],more:Partial<ClauseInput>={}) =>
  clause({ clause_ref:ref,kind:"TARGET",scope,aspects,...more });
const C = (a:NonNullable<ReturnType<typeof accept>["artifact"]>,ref:string,operation:Candidate["operation_category"],effects:Candidate["effects"],cell="east",purpose:string[]=[]) =>
  candidate({ candidate_ref:ref,revision:a.revision,world_generation:a.world_generation,purpose_target_refs:purpose,operation_category:operation,
    extent:{ cells:[cell],entities:[],universe_bound:false },effects,impact_coverage:{ aspects:[...new Set(effects.map((e)=>e.aspect))],complete:true } });
const contract = (metric:string,threshold:number,unit="count",extra:Partial<CompletionContractInput>={}):CompletionContractInput =>
  ({ metric,unit,comparator:">=",threshold,domain:{ kind:"FIXED_SELECTOR",scope_ref:"east",selector:{ kind:"district",districts:["east"] } },
    tense:"REACH",vacuous:"REQUIRE_NONEMPTY",evidence_source:"population_density_eval",...extra });
const codesOf = (r:ReturnType<typeof admitCandidate>) => r.diagnostics.map((d)=>d.code);

test("K01 explicit polarity: commercial FORBID differs from EXISTS and is use-limited",()=>{
  const h=harness();
  const forbidden=accept(h.run(null,[{ op:"ADD",clause:G("F","zoning_change",["use"],universe(),false,undefined,{ use_limit:["commercial"] }) }],{ id:"k01-f" }));
  const exists=accept(h.run(null,[{ op:"ADD",clause:T("T",universe(),["use"],{ predicate:{ predicate:"exists.use",negated:false,params:{ use:"commercial" } } }) }],{ id:"k01-e" }));
  expect(exists.artifact!.goals[0].predicate?.predicate).toBe("exists.use");
  expect(exists.artifact!.permission_envelope).toEqual([]);
  expect(forbidden.artifact!.permission_envelope[0].use_limit).toEqual(["commercial"]);
  expect(forbidden.artifact!.permission_envelope[0].operation_categories).not.toContain("demolition");
});
test("K02 appearance residue preserves roads without a hidden road mapping",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"P_appearance",kind:"PREFERENCE",strength:"PREFERRED",scope:universe(),aspects:["appearance"],concept:"O13_AESTHETIC_CHARACTER" }) },
    { op:"ADD",clause:clause({ clause_ref:"P_road",kind:"PRESERVE",scope:kinds("roads",["road"]),aspects:["network_geometry"] }) }],{ id:"k02" }));
  expect(r.artifact!.residues.map((x)=>x.clause_ref)).toContain("P_appearance");
  expect(r.artifact!.preservation_rules[0].members).toContain("road_east");
  expect(r.artifact!.allowed_policy_params.effects).toEqual([]);
});
test("K03 bounded complement preserves west, grants nothing east, rejects unknown U",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:minus("west",{ kind:"universe" },{ kind:"district",districts:["east"] }),aspects:["existence"] }) }],{ id:"k03" }));
  expect(r.artifact!.preservation_rules[0].members).toEqual(["b_west_1"]);
  expect(r.artifact!.permission_envelope).toEqual([]);
  expect(h.run(r,[{ op:"ADD",clause:clause({ clause_ref:"bad",kind:"PRESERVE",scope:minus("bad",{ kind:"universe" },{ kind:"district",districts:["north"] }),aspects:["existence"] }) }],{ id:"k03bad" }).outcome).toBe("REJECTED");
});
test("K04 carve only its rule and east scope; metro and west remain protected",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:T("T_change",universe(),["existence"]) },
    { op:"ADD",clause:G("F","demolition",["existence"],universe(),false) },
    { op:"ADD",clause:clause({ clause_ref:"P_metro",kind:"PRESERVE",scope:objects("metro",["metro_east"]),aspects:["existence"] }) }],{ id:"k04a" }));
  const two=accept(h.run(one,[{ op:"EXCEPTION",exception_ref:"E",rule_ref:"F",scope:district("east","east"),aspects:["existence"],
    operation_categories:["demolition"],grant:G("G_east","demolition",["existence"],district("east","east")) }],{ id:"k04b",operation:"PATCH" }));
  const a=two.artifact!;
  expect(admitCandidate({ artifact:a,world:h.world,candidate:C(a,"east","demolition",[E("b_east_1","existence","IMPLICIT_DELETE")],"east",["T_change"]) }).admitted).toBe(true);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:C(a,"west","demolition",[E("b_west_1","existence","IMPLICIT_DELETE")],"west",["T_change"]) }).admitted).toBe(false);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:C(a,"metro","demolition",[E("metro_east","existence","IMPLICIT_DELETE")],"east",["T_change"]) }).admitted).toBe(false);
});
test("K05 road widening with implicit demolition is vetoed; certified no-building impact proceeds",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:objects("building",["b_east_1"]),aspects:["existence"] }) },
    { op:"ADD",clause:G("G","road_widen",["network_geometry","existence"]) },{ op:"ADD",clause:T("T",universe(),["existence"]) }],{ id:"k05" }));
  const a=r.artifact!, bad=attachImpact(h.world,C(a,"bad","road_widen",[E("road_east","network_geometry"),E("b_east_1","existence","IMPLICIT_DELETE")],"east",["T"]),
    ["network_geometry","existence","access"]);
  const good=attachImpact(h.world,C(a,"good","road_widen",[E("road_east","network_geometry")]),["network_geometry","existence","access"]);
  expect(codesOf(admitCandidate({ artifact:a,world:h.world,candidate:bad }))).toContain("HARD_CONFLICT");
  expect(admitCandidate({ artifact:a,world:h.world,candidate:good }).admitted).toBe(true);
});
test("K06 model consequence is checked separately from use and UNKNOWN blocks",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:objects("b",["b_east_1"]),aspects:["model"] }) },
    { op:"ADD",clause:G("G","building_rebuild",["use","model"]) }],{ id:"k06" }));
  const a=r.artifact!, bad=attachImpact(h.world,C(a,"bad","building_rebuild",[E("b_east_1","use"),E("b_east_1","model")]),["use","existence","appearance","model"]);
  const good=attachImpact(h.world,C(a,"good","building_rebuild",[E("b_east_1","use")]),["use","existence","appearance","model"]);
  expect(codesOf(admitCandidate({ artifact:a,world:h.world,candidate:bad }))).toContain("HARD_CONFLICT");
  expect(admitCandidate({ artifact:a,world:h.world,candidate:good }).admitted).toBe(true);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:C(a,"unknown","building_rebuild",[E("b_east_1","use")]) }).admitted).toBe(false);
});
test("K07 snapshot baseline survives natural change, unrelated PATCH and same-name replacement",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:objects("west",["b_west_1"]),aspects:["appearance"] }) },
    { op:"ADD",clause:clause({ clause_ref:"style",kind:"PREFERENCE",strength:"PREFERRED",scope:district("east","east"),aspects:["appearance"],concept:"O01_STYLE",params:{ style:"european" } }) }],{ id:"k07a" }));
  const before=JSON.stringify(one.revision!.clauses.find((x)=>x.clause_ref==="P")!.bound_scope.baselines);
  h.world.objects.find((x)=>x.id==="b_west_1")!.appearance="renovated";
  const two=accept(h.run(one,[{ op:"PATCH_CLAUSE",clause_ref:"style",patch:{ params:{ style:"american" } } }],{ id:"k07b",operation:"PATCH" }));
  expect(JSON.stringify(two.revision!.clauses.find((x)=>x.clause_ref==="P")!.bound_scope.baselines)).toBe(before);
  expect(two.artifact!.preservation_rules[0].divergences.length).toBeGreaterThan(0);
  h.world.objects=h.world.objects.filter((x)=>x.id!=="b_west_1");
  h.world.objects.push(object({ id:"new",kind:"building",cell:"west",name:"b_west_1" }));
  const three=accept(h.recompile(two));
  expect(three.artifact!.preservation_rules[0].members).toEqual(["b_west_1"]);
  expect(three.artifact!.preservation_rules[0].missing).toContain("b_west_1");
});
test("K08 local replace retains A west; cancel B does not revive A east",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"A",kind:"PREFERENCE",strength:"PREFERRED",scope:universe(),aspects:["appearance"],concept:"O01_STYLE",params:{ style:"european" } }) }],{ id:"k08a" }));
  const two=accept(h.run(one,[{ op:"REPLACE",targets:["A"],replacements:[clause({ clause_ref:"B",kind:"PREFERENCE",strength:"PREFERRED",scope:district("east","east"),aspects:["appearance"],concept:"O01_STYLE",params:{ style:"american" } })] }],{ id:"k08b",operation:"REPLACE" }));
  const three=accept(h.run(two,[{ op:"CANCEL",targets:["B"] }],{ id:"k08c",operation:"CANCEL" }));
  const current=three.revision!.clauses.filter((x)=>x.status==="ACTIVE");
  expect(current.find((x)=>x.clause_ref==="A")?.bound_scope.frozen_extent?.cells).toEqual(["west"]);
  expect(current.some((x)=>x.clause_ref==="B")).toBe(false);
});
test("K09 cancelling a target closes its bound gate and grant, keeping independent preserve",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:T("T_metro",universe(),["use"],{ temporal:{ gate_ref:"g",mode:"CURRENT_TRUE",predicate:{ metric:"population",comparator:">=",value:20000 },affects:["T_metro"],time_base:"city" } }) },
    { op:"ADD",clause:G("G","demolition",["existence"],universe(),true,{ kind:"BOUND",target_ref:"T_metro" }) },
    { op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:objects("metro",["metro_east"]),aspects:["existence"] }) }],{ id:"k09a" }));
  const two=accept(h.run(one,[{ op:"CANCEL",targets:["T_metro"] }],{ id:"k09b",operation:"CANCEL" }));
  expect(two.artifact!.permission_envelope.map((x)=>x.grant_ref)).not.toContain("G");
  expect(two.artifact!.temporal_conditions.map((x)=>x.gate_ref)).not.toContain("g");
  expect(two.artifact!.preservation_rules.map((x)=>x.clause_ref)).toContain("P");
});
test("K10 style PATCH cannot release an event gate; matching release does not grant permission",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:T("T",universe(),["use"],{ temporal:{ gate_ref:"wait",mode:"EVENT",release_event:"return",affects:["T"] } }) },
    { op:"ADD",clause:clause({ clause_ref:"style",kind:"PREFERENCE",strength:"PREFERRED",scope:universe(),aspects:["appearance"] }) }],{ id:"k10a" }));
  const two=accept(h.run(one,[{ op:"PATCH_CLAUSE",clause_ref:"style",patch:{ aspects:["appearance"] } }],{ id:"k10b",operation:"PATCH" }));
  expect(two.artifact!.temporal_conditions[0].state).toBe("FALSE");
  const three=accept(h.run(two,[{ op:"RELEASE_EVENT",event:"return" }],{ id:"k10c",operation:"PATCH" }));
  expect(three.artifact!.temporal_conditions[0].state).toBe("TRUE");
  expect(three.artifact!.permission_envelope).toEqual([]);
});
test("K11 bound quantity grant is not reusable after cancel and unknown consumption blocks",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:T("T",universe(),["existence"]) },
    { op:"ADD",clause:G("G","demolition",["existence"],objects("two",["b_east_1","b_east_2"]),true,{ kind:"BOUND",target_ref:"T" },
      { validity:{ kind:"QUANTITY",max:2 },object_limit:["b_east_1","b_east_2"] }) }],{ id:"k11a" }));
  h.evidence.committed_ops.push({ op_ref:"pending",operation_category:"demolition",grant_ref:"G",affected_objects:["b_east_1"],state:"UNKNOWN",generation:1 });
  const pending=accept(h.recompile(one));
  expect(codesOf(admitCandidate({ artifact:pending.artifact!,world:h.world,candidate:C(pending.artifact!,"c","demolition",[E("b_east_2","existence","IMPLICIT_DELETE")],"east",["T"]) }))).toContain("EVIDENCE_UNKNOWN");
  const cancelled=accept(h.run(pending,[{ op:"CANCEL",targets:["T"] }],{ id:"k11b",operation:"CANCEL" }));
  expect(cancelled.artifact!.permission_envelope).toEqual([]);
});
test("K12 unsupported zero-pollution hard cannot be bypassed; complete postcondition evidence can admit",()=>{
  const h=harness();
  const ops:UpdateOp[]=[{ op:"ADD",clause:T("T_zero",district("east","east"),["pollution"],{ concept:"O12_ENVIRONMENT_QUALITY",params:{ goal:"ZERO",postcondition_required:true },
    completion:contract("pollution",0,"index",{ comparator:"<=",evidence_source:"pollution_eval" }) }) },
    { op:"ADD",clause:G("G","building_construct",["use","pollution"]) }];
  const first=accept(h.run(null,ops,{ id:"k12a" }));
  expect(codes(first)).toContain("OBSERVATION_MISSING");
  const a=first.artifact!, bad=C(a,"industry","building_construct",[E("b_east_1","use"),E("b_east_1","pollution")],"east",["T_zero"]);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:bad }).admitted).toBe(false);
  const c=makeCapabilities({ observations:[...h.capabilities.observations,"pollution_sensor"],
    operation_impacts:{ ...h.capabilities.operation_impacts,building_construct:{ required_aspects:["use"],possible_aspects:["use","pollution"],complete:false } } });
  const goodHarness=harness({ capabilities:c,evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"pollution",scope_key:"east",value:0,unit:"index",source:"pollution_eval" })] } });
  const supported=accept(goodHarness.run(null,ops,{ id:"k12b" }));
  const candidateGood=attachImpact(goodHarness.world,C(supported.artifact!,"industry2","building_construct",[E("b_east_1","use"),E("b_east_1","pollution")],"east",["T_zero"]),["use","pollution"],["T_zero"]);
  expect(admitCandidate({ artifact:supported.artifact!,world:goodHarness.world,candidate:candidateGood }).admitted).toBe(true);
});
test("K13 empty receptors and missing observation are UNKNOWN; explicit vacuity is honored",()=>{
  const world=harness().world;
  world.objects=world.objects.filter((x)=>!x.uses.includes("residential"));
  const h=harness({ world });
  const make=(vacuous:CompletionContractInput["vacuous"])=>T("T",universe(),["pollution"],{ completion:contract("pollution",0,"index",{
    comparator:"<=",domain:{ kind:"FIXED_SELECTOR",scope_ref:"receivers",selector:{ kind:"object_kind",object_kinds:["building"] },denominator:{ kind:"COUNT_RECEPTORS" } },
    vacuous,evidence_source:"pollution_eval" }) });
  // The chosen selector still has commercial buildings: missing pollution observations remain UNKNOWN.
  const missing=accept(h.run(null,[{ op:"ADD",clause:make("ALLOW_VACUOUS") }],{ id:"k13a" }));
  expect(aggregateMission(missing.artifact!,h.world,{ committed_ops:[],delivery_claims:[],samples:[] }).complete).toBe(false);
  const emptyWorld={ ...world,objects:world.objects.filter((x)=>x.kind!=="building") };
  const empty=harness({ world:emptyWorld });
  const unresolved=accept(empty.run(null,[{ op:"ADD",clause:make("UNRESOLVED") }],{ id:"k13b" }));
  expect(aggregateMission(unresolved.artifact!,empty.world,empty.evidence).complete).toBe(false);
  const allowed=accept(empty.run(null,[{ op:"ADD",clause:make("ALLOW_VACUOUS") }],{ id:"k13c" }));
  expect(aggregateMission(allowed.artifact!,empty.world,empty.evidence).required[0].status).toBe("REACHED");
});
test("K14 density and height are independent built metrics with a fixed area",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[
    sample({ metric:"density",scope_key:"east",value:25,unit:"pop/km2" }),
    sample({ metric:"floors",scope_key:"east",value:6 }),
  ] } });
  const density=contract("density",100,"pop/km2",{ domain:{ kind:"FIXED_SELECTOR",scope_ref:"east",denominator:{ kind:"FIXED_DISTRICT_AREA",cells:["east"],area_km2:1 },population_basis:"BUILT" } });
  const height=contract("floors",6,"count",{ comparator:"<=" });
  const r=accept(h.run(null,[{ op:"ADD",clause:T("density",district("east","east"),["density"],{ completion:density }) },
    { op:"ADD",clause:T("height",district("east","east"),["height"],{ completion:height }) }],{ id:"k14" }));
  const result=aggregateMission(r.artifact!,h.world,h.evidence);
  expect(result.required.find((x)=>x.clause_ref==="density")?.status).toBe("NOT_REACHED");
  expect(result.required.find((x)=>x.clause_ref==="height")?.status).toBe("REACHED");
  expect(result.complete).toBe(false);
});
test("K15 compact and low density remain separate; high-density template is unusable",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:T("compact",universe(),["network_geometry"],{ concept:"O04_EXTENT",params:{ pattern:"COMPACT" } }) },
    { op:"ADD",clause:T("low",universe(),["density"],{ concept:"O03_DENSITY",params:{ class:"LOW" } }) },
    { op:"ADD",clause:clause({ clause_ref:"template",kind:"PREFERENCE",strength:"PREFERRED",scope:universe(),aspects:["density"],concept:"O03_DENSITY",params:{ template:"COMPACT_HIGH" } }) },
    { op:"ADD",clause:G("density_authority","zoning_change",["density"]) }],{ id:"k15" }));
  expect(r.artifact!.allowed_policy_params.effects.find((x)=>x.key==="density")?.value).toEqual({ max:60 });
  expect(r.artifact!.allowed_policy_params.effects.some((x)=>x.key==="extent")).toBe(true);
  expect(codes(r)).toContain("GAME_LIMITATION");
});
test("K16 GRID conflicts only on the same network scale; qualitative organic remains residue",()=>{
  const h=harness();
  const grid=T("grid",universe(),["network_geometry"],{ concept:"O02_URBAN_FORM",params:{ pattern:"GRID",scale:"local" } });
  const notGrid=T("no_grid",universe(),["network_geometry"],{ concept:"O02_URBAN_FORM",params:{ pattern:"NOT_GRID",scale:"local" } });
  const fail=h.run(null,[{ op:"ADD",clause:grid },{ op:"ADD",clause:notGrid }],{ id:"k16a" });
  expect(fail.outcome).toBe("REJECTED"); expect(codes(fail)).toContain("HARD_CONFLICT");
  const valid=accept(h.run(null,[{ op:"ADD",clause:grid },{ op:"ADD",clause:T("city",universe(),["network_geometry"],{ concept:"O02_URBAN_FORM",params:{ pattern:"GRID",scale:"city" } }) },
    { op:"ADD",clause:T("organic",universe(),["quality"],{ concept:"O13_AESTHETIC_CHARACTER" }) }],{ id:"k16b" }));
  expect(valid.artifact!.allowed_policy_params.effects.map((x)=>x.domain).sort()).toEqual(["network:city","network:local"]);
  expect(valid.artifact!.residues.map((x)=>x.clause_ref)).toContain("organic");
});
test("K17 fiscal hard blocks insufficient cash without inventing a loan",()=>{
  const h=harness({ world:{ cash:1000 } });
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"cash",kind:"CONSTRAINT",scope:universe(),aspects:["fiscal"],params:{ fiscal:[{ key:"cash_floor",hard:true,value:800 }] } }) },
    { op:"ADD",clause:G("build","building_construct",["use"]) },
    { op:"ADD",clause:G("no_loan","loan",["fiscal"],universe(),false) }],{ id:"k17" }));
  const a=r.artifact!;
  const costly={ ...C(a,"costly","building_construct",[E("b_east_1","use")]),resources:{ cash:300 } };
  const affordable={ ...C(a,"affordable","building_construct",[E("b_east_1","use")]),resources:{ cash:100 } };
  attachResource(h.world,costly,300); attachResource(h.world,affordable,100);
  expect(codesOf(admitCandidate({ artifact:a,world:h.world,candidate:costly }))).toContain("RESOURCE_INSUFFICIENT");
  expect(admitCandidate({ artifact:a,world:h.world,candidate:affordable }).admitted).toBe(true);
  expect(a.permission_envelope.some((g)=>g.allow && g.operation_categories.includes("loan"))).toBe(false);
});
test("K18 Profile ranks actual admitted candidates and yields its soft floor",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:G("G","building_construct",["use"]) }],{ id:"k18" }));
  const a=r.artifact!, profile={ profile:"FINANCIAL_RECOVERY" as const,version:"v1",soft_thresholds:[{ key:"profit",index:100 }],candidate_ranking:[] };
  const c=C(a,"legal","building_construct",[E("b_east_1","use")]);
  const advance=evaluateProfileLiveness({ profile,mission:{ mission_ref:"M",profile:"FINANCIAL_RECOVERY",requires_advance_now:true },
    artifact:a,world:h.world,candidates:[{ candidate:c,soft_index:0 }] });
  expect(advance.admissible).toEqual(["legal"]); expect(advance.soft_concessions).toHaveLength(1);
  const denied=evaluateProfileLiveness({ profile,mission:{ mission_ref:"M",profile:"FINANCIAL_RECOVERY",requires_advance_now:true },
    artifact:a,world:{ ...h.world,cash:0 },candidates:[{ candidate:{ ...c,resources:{ cash:100 } },soft_index:0 }] });
  expect(denied.blocked[0].reasons.map((x)=>x.code)).toContain("RESOURCE_INSUFFICIENT");
});
test("K19 vacant MAINTAIN itself blocks infill while certified independent work proceeds",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:T("vacant",objects("land",["land_east"]),["vacancy"],{ predicate:{ predicate:"exists.use",negated:false,params:{ use:"vacant" } },
    completion:contract("vacancy",1,"bool",{ tense:"MAINTAIN_OPEN",comparator:"==",threshold:1 }) }) },
    { op:"ADD",clause:G("G","building_construct",["use"]) }],{ id:"k19" }));
  const a=r.artifact!;
  expect(admitCandidate({ artifact:a,world:h.world,candidate:C(a,"infill","building_construct",[E("land_east","use")],"east",["vacant"]) }).admitted).toBe(false);
  const elsewhere=C(a,"elsewhere","building_construct",[E("b_west_1","use")],"west");
  attachIndependence(h.world,elsewhere,["vacant"],[{ key:"land",reservation_ref:"reserved-west",conservative_bound:null }]);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:elsewhere }).admitted).toBe(true);
});
test("K20 required original, proxy, open MAINTAIN and OPAQUE cannot aggregate to COMPLETE",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"population",scope_key:"east",value:20 })] } });
  const proxy=contract("population",10,"count",{ proxy_of:"original",approximation_ref:"appr" });
  const r=accept(h.run(null,[{ op:"ADD",clause:T("original",district("east","east"),["population"],{ completion:contract("population",100000) }) },
    { op:"ADD",clause:T("proxy",district("east","east"),["population"],{ completion:proxy }) },
    { op:"ADD",clause:T("open",district("east","east"),["population"],{ completion:contract("population",10,"count",{ tense:"MAINTAIN_OPEN" }) }) },
    { op:"ADD",clause:T("opaque",district("east","east"),["quality"],{ concept:"O13_AESTHETIC_CHARACTER" }) }],{ id:"k20" }));
  const done=aggregateMission(r.artifact!,h.world,h.evidence);
  expect(done.complete).toBe(false);
  expect(done.required.find((x)=>x.clause_ref==="open")?.satisfied_closed).toBe(false);
  expect(done.disclosures.some((s)=>s.includes("proxy"))).toBe(true);
});
