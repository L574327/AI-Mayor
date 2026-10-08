/** Positive and metamorphic V1 controls independent of the K examples. */
import { admitCandidate } from "../../../src/main/services/ai-mayor/semantic-compiler/admit";
import { compile } from "../../../src/main/services/ai-mayor/semantic-compiler/compile";
import { aggregateMission, evaluateObligation } from "../../../src/main/services/ai-mayor/semantic-compiler/completion";
import { resolveSelector } from "../../../src/main/services/ai-mayor/semantic-compiler/scope";
import type { Candidate, ClauseInput, CompletionContractInput } from "../../../src/main/services/ai-mayor/semantic-compiler/types";
import { accept, attachImpact, attachIndependence, attachResource, candidate, clause, district, harness, intent, objects, sample, universe } from "./fixtures";

const allow=(ref:string,op:Candidate["operation_category"],aspects:Candidate["impact_coverage"]["aspects"],scope=universe(),extra:Record<string,unknown>={})=>
  clause({ clause_ref:ref,kind:"PERMISSION",scope,aspects,params:{ allow:true,operation_categories:[op],affected_aspects:aspects,validity:{ kind:"UNTIL_REVOKED" },...extra } });
const eff=(object_id:string,aspect:Candidate["effects"][number]["aspect"],to_use?:Candidate["effects"][number]["to_use"]) =>
  ({ object_id,aspect,kind:"DIRECT_WRITE" as const,verified:"TRUE" as const,...(to_use ? { to_use } : {}) });
const build=(a:NonNullable<ReturnType<typeof accept>["artifact"]>,ref="c",cell="east",effects:Candidate["effects"]=[eff("b_east_1","use")])=>
  candidate({ candidate_ref:ref,revision:a.revision,world_generation:a.world_generation,operation_category:"building_construct",
    extent:{ cells:[cell],entities:[],universe_bound:false },effects,impact_coverage:{ aspects:[...new Set(effects.map((e)=>e.aspect))],complete:true } });
const popContract=():CompletionContractInput=>({ metric:"population",unit:"count",comparator:">=",threshold:1000,
  domain:{ kind:"FIXED_SELECTOR",scope_ref:"east",selector:{ kind:"district",districts:["east"] } },tense:"REACH",vacuous:"REQUIRE_NONEMPTY",evidence_source:"population_density_eval" });

test("mixed geographic and entity intersection excludes unrelated objects in the same cell",()=>{
  const world=harness().world;
  const selected=resolveSelector({ kind:"intersect",parts:[
    { kind:"district",districts:["east"] },{ kind:"object_kind",object_kinds:["building"] }
  ] },world);
  expect(selected.ok).toBe(true);
  if (selected.ok) {
    expect(selected.extent.cells).toEqual([]);
    expect(selected.extent.entities).toEqual(["b_east_1","b_east_2"]);
  }
});

test("hand-authored permission cannot omit its lifetime or claim product-baseline authority",()=>{
  const h=harness();
  const bare=clause({ clause_ref:"bare",kind:"PERMISSION",aspects:["use"],params:{ allow:true,
    operation_categories:["building_construct"],affected_aspects:["use"] } });
  expect(h.run(null,[{ op:"ADD",clause:bare }],{ id:"bare-permission" }).outcome).toBe("REJECTED");
  expect(h.run(null,[{ op:"ADD",clause:{ ...bare,clause_ref:"forged",params:{ ...bare.params,
    validity:{ kind:"UNTIL_REVOKED" },origin:"PRODUCT_BASELINE" } } }],{ id:"forged-permission" }).outcome).toBe("REJECTED");
  expect(h.run(null,[{ op:"ADD",clause:{ ...bare,clause_ref:"unbound-quantity",params:{ ...bare.params,
    validity:{ kind:"UNTIL_REVOKED" },quantity:2 } } }],{ id:"unbound-quantity" }).outcome).toBe("REJECTED");
  expect(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"bad-hard",kind:"TARGET",scope:universe(),
    aspects:["pollution"],params:{ postcondition_required:"yes" } }) }],{ id:"bad-hard" }).outcome).toBe("REJECTED");
});

test("PATCH validates permission and binds only newly added preservation aspects",()=>{
  const h=harness();
  const first=accept(h.run(null,[{ op:"ADD",clause:allow("G","building_construct",["use"]) },
    { op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",aspects:["appearance"],scope:objects("one",["b_east_1"]) }) }],
    { id:"patch-validate-1" }));
  expect(h.run(first,[{ op:"PATCH_CLAUSE",clause_ref:"G",patch:{ params:{ validity:{ kind:"QUANTITY",max:0 } } } }],
    { id:"patch-invalid",operation:"PATCH" }).outcome).toBe("REJECTED");
  h.world.objects[0].appearance="changed";
  const second=accept(h.run(first,[{ op:"PATCH_CLAUSE",clause_ref:"P",patch:{ aspects:["appearance","model"] } }],
    { id:"patch-validate-2",operation:"PATCH" }));
  const baseline=second.revision!.clauses.find((c)=>c.clause_ref==="P")!.bound_scope.baselines.b_east_1.values;
  expect(baseline.appearance).toBe("european");
  expect(baseline.model).toBe("a");
});

test("dynamic local replacement keeps the original rule for future members outside the carve",()=>{
  const h=harness();
  const original=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"A",kind:"PRESERVE",aspects:["appearance"],
    scope:{ ...universe(),binding:"DYNAMIC" } }) }],{ id:"dynamic-replace-1" }));
  const changed=accept(h.run(original,[{ op:"REPLACE",targets:["A"],replacements:[clause({ clause_ref:"B",kind:"TARGET",aspects:["appearance"],scope:district("east","east") })] }],
    { id:"dynamic-replace-2",operation:"REPLACE" }));
  h.world.objects.push({ ...h.world.objects[0],id:"new_west",cell:"west" });
  const refreshed=accept(h.recompile(changed));
  const residual=refreshed.artifact!.active_clauses!.find((c)=>c.clause_ref==="A")!;
  expect(residual.status).toBe("ACTIVE");
  expect(residual.bound_scope.baselines.new_west).toBeDefined();
  expect(residual.bound_scope.baselines.b_east_1).toBeUndefined();
});

test("local REPLACE keeps only the original completion contract's residual domain",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"population",scope_key:"west",value:1500 })] } });
  const original=clause({ clause_ref:"A",kind:"TARGET",scope:universe(),aspects:["population"],completion:{ ...popContract(),
    domain:{ kind:"FIXED_SELECTOR",scope_ref:"city",selector:{ kind:"district",districts:["east","west"] } } } });
  const first=accept(h.run(null,[{ op:"ADD",clause:original }],{ id:"completion-residual-1" }));
  const second=accept(h.run(first,[{ op:"REPLACE",targets:["A"],replacements:[clause({ clause_ref:"B",kind:"TARGET",
    scope:district("east","east"),aspects:["population"] })] }],{ id:"completion-residual-2",operation:"REPLACE" }));
  const obligation=second.artifact!.completion_criteria.find((o)=>o.clause_ref==="A")!;
  expect(obligation.domain.bound_extent?.cells).toEqual(["west"]);
  expect(evaluateObligation(obligation,h.world,h.evidence).status).toBe("REACHED");
});

test("disjoint geographic scopes do not create a false hard composition conflict",()=>{
  const h=harness();
  const east=clause({ clause_ref:"east_grid",kind:"TARGET",scope:district("east","east"),aspects:["network_geometry"],
    concept:"O02_URBAN_FORM",params:{ pattern:"GRID",scale:"local" } });
  const west=clause({ clause_ref:"west_not_grid",kind:"TARGET",scope:district("west","west"),aspects:["network_geometry"],
    concept:"O02_URBAN_FORM",params:{ pattern:"NOT_GRID",scale:"local" } });
  const compiled=h.run(null,[{ op:"ADD",clause:east },{ op:"ADD",clause:west }],{ id:"disjoint-composition" });
  expect(compiled.outcome).toBe("ACCEPTED");
  expect(compiled.artifact!.allowed_policy_params.effects).toHaveLength(2);
});

test("stale or ambiguous metric readback does not open a current-value gate",()=>{
  const h=harness();
  const gated=clause({ clause_ref:"T",kind:"TARGET",aspects:["population"],scope:universe(),
    temporal:{ gate_ref:"population-gate",mode:"CURRENT_TRUE",predicate:{ metric:"population",comparator:">=",value:1000 },
      affects:["T"],time_base:"city" } });
  const first=accept(h.run(null,[{ op:"ADD",clause:gated }],{ id:"gate-fresh" }));
  expect(first.artifact!.temporal_conditions[0].state).toBe("TRUE");
  h.world.generation=2;
  expect(accept(h.recompile(first)).artifact!.temporal_conditions[0].state).toBe("UNKNOWN");
  h.world.generation=1;
  h.world.metrics.push({ ...h.world.metrics.find((m)=>m.metric==="population" && m.scope_key==="city")! });
  expect(accept(h.recompile(first)).artifact!.temporal_conditions[0].state).toBe("UNKNOWN");
});

test("a missing snapshot object cannot be completed by a remaining sample",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"population",scope_key:"b_east_1",value:12000 })] } });
  const obligation={ ...popContract(),domain:{ kind:"SNAPSHOT_ENTITIES" as const,scope_ref:"building",bound_entities:["b_east_1"],bound_session:h.world.session } };
  const first=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"T",kind:"TARGET",scope:objects("building",["b_east_1"]),
    aspects:["population"],completion:obligation }) }],{ id:"missing-object" }));
  expect(aggregateMission(first.artifact!,h.world,h.evidence).complete).toBe(true);
  h.world.objects=h.world.objects.filter((o)=>o.id!=="b_east_1");
  expect(aggregateMission(first.artifact!,h.world,h.evidence).required[0].status).toBe("UNKNOWN");
});

test("finite MAINTAIN needs an explicit clock and every sample in the fixed window",()=>{
  const h=harness({ world:{ generation:2 },evidence:{ committed_ops:[],delivery_claims:[],samples:[
    sample({ metric:"population",scope_key:"east",value:12000,generation:1 }),
    sample({ metric:"population",scope_key:"east",value:12000,generation:2 })] } });
  const contract={ ...popContract(),tense:"MAINTAIN_WINDOW" as const,window_samples_required:2,time_base:"WORLD_GENERATION" as const };
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"T",kind:"TARGET",scope:district("east","east"),
    aspects:["population"],completion:contract }) }],{ id:"finite-maintain" }));
  expect(aggregateMission(r.artifact!,h.world,h.evidence).required[0].status).toBe("WINDOW_SATISFIED");
  expect(aggregateMission(r.artifact!,h.world,{ ...h.evidence,samples:h.evidence.samples.slice(1) }).required[0].status).toBe("UNKNOWN");
  expect(aggregateMission(r.artifact!,h.world,{ ...h.evidence,samples:[{ ...h.evidence.samples[0],value:0 },h.evidence.samples[1]] }).required[0].status)
    .toBe("VIOLATED");
  const noClock=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"T",kind:"TARGET",scope:district("east","east"),
    aspects:["population"],completion:{ ...contract,time_base:undefined } }) }],{ id:"finite-no-clock" }));
  expect(aggregateMission(noClock.artifact!,h.world,h.evidence).required[0].status).toBe("UNRESOLVED");
});

test("a fiscal hard floor uses inspector cost, not a candidate's omitted or lowered cost",()=>{
  const h=harness({ world:{ cash:1000 } });
  const r=accept(h.run(null,[{ op:"ADD",clause:allow("G","building_construct",["use"]) },
    { op:"ADD",clause:clause({ clause_ref:"cash",kind:"CONSTRAINT",scope:universe(),aspects:["fiscal"],
      params:{ fiscal:[{ key:"cash_floor",value:800,hard:false }] } }) }],{ id:"fiscal-proof" }));
  const a=r.artifact!,c=build(a,"fiscal-candidate");
  expect(r.artifact!.fiscal_envelope[0].hard).toBe(true);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:c }).diagnostics.map((d)=>d.code)).toContain("EVIDENCE_UNKNOWN");
  attachResource(h.world,c,300);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:c }).diagnostics.map((d)=>d.code)).toContain("EVIDENCE_UNKNOWN");
  const honest={ ...c,resources:{ cash:300 } };
  expect(admitCandidate({ artifact:a,world:h.world,candidate:honest }).diagnostics.map((d)=>d.code)).toContain("RESOURCE_INSUFFICIENT");
});

test("atomic rejection preserves the old revision when a replacement scope cannot bind",()=>{
  const h=harness();
  const first=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"F",kind:"PERMISSION",scope:universe(),aspects:["use"],
    params:{ allow:false,operation_categories:["building_construct"],affected_aspects:["use"],validity:{ kind:"UNTIL_REVOKED" } } }) }],{ id:"atomic-1" }));
  const original=JSON.stringify(first.revision);
  const failed=h.run(first,[{ op:"CANCEL",targets:["F"] },{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:district("bad","north"),aspects:["use"] }) }],{ id:"atomic-2",operation:"PATCH" });
  expect(failed.outcome).toBe("REJECTED");
  expect(JSON.stringify(first.revision)).toBe(original);
  expect(first.artifact!.permission_envelope[0].allow).toBe(false);
});
test("positive: a typed, authorized construction is admitted; destructive work needs a target",()=>{
  const h=harness();
  const result=accept(h.run(null,[{ op:"ADD",clause:allow("G","building_construct",["use"]) },
    { op:"ADD",clause:allow("D","demolition",["existence"]) }],{ id:"positive-admit" }));
  const a=result.artifact!;
  expect(admitCandidate({ artifact:a,world:h.world,candidate:build(a) }).admitted).toBe(true);
  const demolition=candidate({ ...build(a,"demo"),operation_category:"demolition",effects:[{ ...eff("b_east_1","existence"),kind:"IMPLICIT_DELETE" }],
    impact_coverage:{ aspects:["existence"],complete:true } });
  expect(admitCandidate({ artifact:a,world:h.world,candidate:demolition }).admitted).toBe(false);
});
test("use-limited prohibition rejects commercial and permits residential within the same grant",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:allow("G","building_construct",["use"]) },
    { op:"ADD",clause:clause({ clause_ref:"F",kind:"PERMISSION",scope:universe(),aspects:["use"],
      params:{ allow:false,operation_categories:["building_construct"],affected_aspects:["use"],validity:{ kind:"UNTIL_REVOKED" },use_limit:["commercial"] } }) }],{ id:"use-limit" }));
  const a=r.artifact!;
  expect(admitCandidate({ artifact:a,world:h.world,candidate:build(a,"commercial","east",[eff("b_east_1","use","commercial")]) }).admitted).toBe(false);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:build(a,"residential","east",[eff("b_east_1","use","residential")]) }).admitted).toBe(true);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:build(a,"unknown-use") }).diagnostics.map((x)=>x.code)).toContain("IMPACT_UNKNOWN");
});
test("replay preserves original semantic response after a later update and changed world",()=>{
  const h=harness();
  const original=intent([{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:objects("b",["b_east_1"]),aspects:["appearance"] }) }],{ id:"replay-1",base:0 });
  const one=accept(compile({ update:original,revision:null,world:h.world,capabilities:h.capabilities,evidence:h.evidence }));
  const two=accept(h.run(one,[{ op:"ADD",clause:allow("G","building_construct",["use"]) }],{ id:"replay-2",operation:"PATCH" }));
  h.world.objects.find((x)=>x.id==="b_east_1")!.appearance="renovated";
  const again=accept(compile({ update:original,revision:two.revision,world:h.world,capabilities:h.capabilities,evidence:h.evidence }));
  expect(again.revision?.revision).toBe(1);
  expect(again.artifact).toEqual(one.artifact);
});
test("dynamic first-entry baseline is stable on re-entry and a changed session does not rebind",()=>{
  const h=harness();
  const dynamic={ ...district("east","east"),binding:"DYNAMIC" as const };
  let r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:dynamic,aspects:["appearance"] }) }],{ id:"dynamic" }));
  h.world.objects.push({ ...h.world.objects[0],id:"new",appearance:"blue" });
  r=accept(h.recompile(r));
  const baseline=r.revision!.clauses.find((x)=>x.clause_ref==="P")!.bound_scope.baselines.new.values.appearance;
  h.world.objects.find((x)=>x.id==="new")!.appearance="red";
  r=accept(h.recompile(r));
  expect(r.revision!.clauses.find((x)=>x.clause_ref==="P")!.bound_scope.baselines.new.values.appearance).toBe(baseline);
  const wrong=compile({ update:null,revision:r.revision,world:{ ...h.world,session:"other" },capabilities:h.capabilities,evidence:h.evidence });
  expect(wrong.artifact!.preservation_rules[0].members).toEqual([]);
});
test("metamorphic: clause order, provider and comment do not alter normalized artifact",()=>{
  const h=harness();
  const a=clause({ clause_ref:"A",kind:"TARGET",scope:district("east","east"),aspects:["use"],predicate:{ predicate:"new_build.use",negated:false,params:{} } });
  const b=allow("G","building_construct",["use"]);
  const one=accept(compile({ update:intent([{ op:"ADD",clause:a },{ op:"ADD",clause:b }],{ id:"meta-1",base:0 }),revision:null,world:h.world,capabilities:h.capabilities,evidence:h.evidence }));
  const two=accept(compile({ update:intent([{ op:"ADD",clause:b },{ op:"ADD",clause:a }],{ id:"meta-2",base:0,provider:"other",comment:"different" }),revision:null,world:h.world,capabilities:h.capabilities,evidence:h.evidence }));
  expect(two.artifact).toEqual(one.artifact);
});
test("metamorphic: a narrow grant does not widen or revoke the original wide grant",()=>{
  const h=harness();
  const one=accept(h.run(null,[{ op:"ADD",clause:allow("wide","building_construct",["use"]) }],{ id:"grant-1" }));
  const two=accept(h.run(one,[{ op:"ADD",clause:allow("narrow","building_construct",["use"],district("east","east")) }],{ id:"grant-2",operation:"PATCH" }));
  const west=build(two.artifact!,"west","west",[eff("b_west_1","use")]);
  expect(admitCandidate({ artifact:two.artifact!,world:h.world,candidate:west }).admitted).toBe(true);
  const narrowOnly=accept(h.run(null,[{ op:"ADD",clause:allow("narrow","building_construct",["use"],district("east","east")) }],{ id:"grant-3" }));
  expect(admitCandidate({ artifact:narrowOnly.artifact!,world:h.world,candidate:build(narrowOnly.artifact!,"west","west",[eff("b_west_1","use")]) }).admitted).toBe(false);
});
test("impact certificate must match the candidate, generation, extent and inspected effects",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:allow("G","road_widen",["network_geometry"]) }],{ id:"impact-cert" }));
  const a=r.artifact!, c=candidate({ ...build(a,"road"),operation_category:"road_widen",effects:[eff("road_east","network_geometry")],impact_coverage:{ aspects:["network_geometry"],complete:true } });
  const certified=attachImpact(h.world,c,["network_geometry","existence","access"]);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:certified }).admitted).toBe(true);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:{ ...certified,effects:[eff("b_east_1","network_geometry")] } }).admitted).toBe(false);
});
test("independence needs trusted scope, effect and resource evidence",()=>{
  const h=harness();
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"opaque",kind:"TARGET",scope:district("east","east"),aspects:["quality"],concept:"O13_AESTHETIC_CHARACTER" }) },
    { op:"ADD",clause:allow("G","building_construct",["use"]) }],{ id:"independent" }));
  const a=r.artifact!, c=build(a,"west","west",[eff("b_west_1","use")]);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:c }).admitted).toBe(false);
  attachIndependence(h.world,c,["opaque"],[{ key:"cash",reservation_ref:null,conservative_bound:100 }]);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:c }).admitted).toBe(true);
  expect(admitCandidate({ artifact:a,world:h.world,candidate:{ ...c,resources:{ cash:200 } } }).diagnostics.map((d)=>d.code))
    .toContain("INDEPENDENCE_UNPROVEN");
});
test("completion degrades from proven to UNKNOWN on missing data or a shrunk denominator",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"population",scope_key:"east",value:12000 })] } });
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"T",kind:"TARGET",scope:district("east","east"),aspects:["population"],completion:popContract() }) }],{ id:"complete-positive" }));
  expect(aggregateMission(r.artifact!,h.world,h.evidence).complete).toBe(true);
  expect(aggregateMission(r.artifact!,h.world,h.evidence).required[0].reached_at_generation).toBe(h.world.generation);
  expect(aggregateMission(r.artifact!,h.world,{ ...h.evidence,samples:[] }).required[0].status).toBe("UNKNOWN");
  const areaContract={ ...popContract(),metric:"density",unit:"pop/km2",threshold:100,
    domain:{ kind:"FIXED_SELECTOR" as const,scope_ref:"east",denominator:{ kind:"FIXED_DISTRICT_AREA" as const,cells:["east"],area_km2:0.1 },population_basis:"BUILT" as const } };
  const bad=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"density",kind:"TARGET",scope:district("east","east"),aspects:["density"],completion:areaContract }) }],{ id:"shrink" }));
  expect(aggregateMission(bad.artifact!,h.world,h.evidence).complete).toBe(false);
});
test("finite required goal plus required preserve needs a period certificate",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"population",scope_key:"east",value:12000 })] } });
  const r=accept(h.run(null,[{ op:"ADD",clause:clause({ clause_ref:"T",kind:"TARGET",scope:district("east","east"),aspects:["population"],completion:popContract() }) },
    { op:"ADD",clause:clause({ clause_ref:"P",kind:"PRESERVE",scope:objects("west",["b_west_1"]),aspects:["appearance"] }) }],{ id:"preserve-proof" }));
  expect(aggregateMission(r.artifact!,h.world,h.evidence).complete).toBe(false);
  h.evidence.invariant_certificates=[{ clause_ref:"P",session:h.world.session,through_generation:h.world.generation,holds:"TRUE",coverage:"TRUE",source:"SYNTHETIC_INSPECTOR" }];
  expect(aggregateMission(r.artifact!,h.world,h.evidence).complete).toBe(true);
});
test("an explicit scoped proxy replacement completes only the replacement, not its historic original",()=>{
  const h=harness({ evidence:{ committed_ops:[],delivery_claims:[],samples:[sample({ metric:"population",scope_key:"east",value:12000 })] } });
  const original=clause({ clause_ref:"A",kind:"TARGET",scope:district("east","east"),aspects:["population"],completion:{ ...popContract(),threshold:100000 } });
  const first=accept(h.run(null,[{ op:"ADD",clause:original }],{ id:"proxy-1" }));
  const proxy=clause({ clause_ref:"B",kind:"TARGET",scope:district("east","east"),aspects:["population"],
    predicate:{ predicate:"new_build.use",negated:false,params:{} },completion:{ ...popContract(),proxy_of:"A",approximation_ref:"appr" },
    approximation:{ approximation_ref:"appr",target_ref:"A",aspect:"population",scope_ref:"east",interpretation_version:"v1",
      mapping_ref:"use.add@v1",allowed_loss:"population proxy loss",acceptance_ref:"player-appr" } });
  const second=accept(h.run(first,[{ op:"REPLACE",targets:["A"],replacements:[proxy] }],{ id:"proxy-2",operation:"REPLACE" }));
  expect(aggregateMission(second.artifact!,h.world,h.evidence).complete).toBe(true);
  const leaked=accept(h.run(null,[{ op:"ADD",clause:{ ...proxy,clause_ref:"C",completion:{ ...proxy.completion!,proxy_of:"other" } } }],{ id:"proxy-leak" }));
  expect(aggregateMission(leaked.artifact!,h.world,h.evidence).complete).toBe(false);
});
