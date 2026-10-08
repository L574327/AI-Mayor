/**
 * Independent V1 specification oracle. Expectations come from Freeze Candidate
 * sections 5–10 and Structural Red Team R02–R06, not from the old implementation.
 * Each case describes an observable semantic result using hand-authored Intent and
 * a synthetic world. This file is deliberately run against the old core first.
 */
import { admitCandidate } from "../../../src/main/services/ai-mayor/semantic-compiler/admit";
import { aggregateMission } from "../../../src/main/services/ai-mayor/semantic-compiler/completion";
import { resolveSelector } from "../../../src/main/services/ai-mayor/semantic-compiler/scope";
import type { Candidate, CompletionContractInput, MetricSample } from "../../../src/main/services/ai-mayor/semantic-compiler/types";
import { accept, attachResource, candidate, clause, district, harness, intent, objects, sample, universe } from "./fixtures";
import { compile } from "../../../src/main/services/ai-mayor/semantic-compiler/compile";

const grant = (ref: string, operation: Candidate["operation_category"], aspects: Candidate["impact_coverage"]["aspects"], scope = universe()) =>
  clause({ clause_ref: ref, kind: "PERMISSION", scope, aspects, params: {
    allow: true, operation_categories: [operation], affected_aspects: aspects,
    validity: { kind: "UNTIL_REVOKED" },
  } });

const effect = (object_id: string, aspect: Candidate["effects"][number]["aspect"]) => ({
  object_id, aspect, kind: "DIRECT_WRITE" as const, verified: "TRUE" as const,
});

const build = (artifact: NonNullable<ReturnType<typeof accept>["artifact"]>, overrides: Partial<Candidate> = {}) =>
  candidate({ candidate_ref: "candidate", revision: artifact.revision, world_generation: artifact.world_generation,
    operation_category: "building_construct", extent: { cells: ["east"], entities: [], universe_bound: false },
    effects: [effect("b_east_1", "use")], impact_coverage: { aspects: ["use"], complete: true }, ...overrides });

const reach = (metric: string, unit = "count"): CompletionContractInput => ({
  metric, unit, comparator: ">=", threshold: 10,
  domain: { kind: "FIXED_SELECTOR", scope_ref: "east", selector: { kind: "district", districts: ["east"] } },
  tense: "REACH", vacuous: "REQUIRE_NONEMPTY", evidence_source: "population_density_eval",
});

describe("V1 independent specification oracle", () => {
  test("scope intersection uses entity intersection, including mixed geography and handles", () => {
    const world = harness().world;
    const result = resolveSelector({ kind: "intersect", parts: [
      { kind: "objects", object_ids: ["b_east_1", "b_west_1"] },
      { kind: "objects", object_ids: ["b_east_1"] },
    ] }, world);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extent.entities).toEqual(["b_east_1"]);
  });

  test("an exception on an unrelated aspect is rejected at acceptance", () => {
    const h = harness();
    const first = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "C_no_grid", kind: "CONSTRAINT", scope: district("east", "east"), aspects: ["network_geometry"],
        predicate: { predicate: "grid.purity", negated: true, params: { comparator: "==", value: "GRID", scope_key: "east" } } }) },
      { op: "ADD", clause: grant("G_build", "building_construct", ["network_geometry"], district("east", "east")) },
    ], { id: "oracle-carve-1" }));
    const rejected = h.run(first, [{ op: "EXCEPTION", exception_ref: "E_style", rule_ref: "C_no_grid",
      scope: district("east", "east"), aspects: ["appearance"], operation_categories: ["style_change"] }], { id: "oracle-carve-2", operation: "PATCH" });
    expect(rejected.outcome).toBe("REJECTED");
    expect(first.revision?.clauses.some((c) => c.status === "ACTIVE" && c.clause_ref === "C_no_grid")).toBe(true);
  });

  test("an exception for style_change does not lift a hard rule for building_construct", () => {
    const h = harness();
    const first = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "C_no_grid", kind: "CONSTRAINT", scope: district("east", "east"), aspects: ["network_geometry"],
        predicate: { predicate: "grid.purity", negated: true, params: { comparator: "==", value: "GRID", scope_key: "east" } } }) },
      { op: "ADD", clause: grant("G_build", "building_construct", ["network_geometry"], district("east", "east")) },
    ], { id: "oracle-category-1" }));
    const second = accept(h.run(first, [{ op: "EXCEPTION", exception_ref: "E_style", rule_ref: "C_no_grid",
      scope: district("east", "east"), aspects: ["network_geometry"], operation_categories: ["style_change"] }], { id: "oracle-category-2", operation: "PATCH" }));
    const result = admitCandidate({ artifact: second.artifact!, world: h.world, candidate: build(second.artifact!, {
      effects: [effect("b_east_1", "network_geometry")], impact_coverage: { aspects: ["network_geometry"], complete: true },
    }) });
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.some((d) => d.refs.includes("C_no_grid"))).toBe(true);
  });

  test("a candidate cannot certify complete road impacts by omitting possible building effects", () => {
    const h = harness();
    const compiled = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "P_building", kind: "PRESERVE", scope: objects("building", ["b_east_1"]), aspects: ["existence"] }) },
      { op: "ADD", clause: grant("G_road", "road_widen", ["network_geometry"], district("east", "east")) },
    ], { id: "oracle-impact" }));
    const result = admitCandidate({ artifact: compiled.artifact!, world: h.world, candidate: build(compiled.artifact!, {
      operation_category: "road_widen", effects: [effect("road_east", "network_geometry")],
      impact_coverage: { aspects: ["network_geometry"], complete: true },
    }) });
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("IMPACT_UNKNOWN");
  });

  test("unresolved required hard work needs verified independence even when claim is omitted", () => {
    const h = harness();
    const compiled = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "T_zero", kind: "TARGET", scope: district("east", "east"), aspects: ["pollution"], concept: "O12_ENVIRONMENT_QUALITY" }) },
      { op: "ADD", clause: grant("G_build", "building_construct", ["use"]) },
    ], { id: "oracle-independence" }));
    const result = admitCandidate({ artifact: compiled.artifact!, world: h.world, candidate: build(compiled.artifact!) });
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("INDEPENDENCE_UNPROVEN");
  });

  test("local REPLACE preserves the old declaration outside the replaced scope", () => {
    const h = harness();
    const first = accept(h.run(null, [{ op: "ADD", clause: clause({ clause_ref: "A", kind: "PREFERENCE", strength: "PREFERRED", scope: universe(), aspects: ["appearance"], concept: "O01_STYLE" }) }], { id: "oracle-replace-1" }));
    const second = accept(h.run(first, [{ op: "REPLACE", targets: ["A"], replacements: [
      clause({ clause_ref: "B", kind: "PREFERENCE", strength: "PREFERRED", scope: district("east", "east"), aspects: ["appearance"], concept: "O01_STYLE" }),
    ] }], { id: "oracle-replace-2", operation: "REPLACE" }));
    const active = second.revision!.clauses.filter((c) => c.status === "ACTIVE");
    expect(active.some((c) => c.clause_ref.startsWith("A") && c.bound_scope.frozen_extent?.cells.includes("west"))).toBe(true);
    expect(active.some((c) => c.clause_ref === "B" && c.bound_scope.frozen_extent?.cells.includes("east"))).toBe(true);
  });

  test("an ambiguous cancellation pauses related admission until clarified", () => {
    const h = harness();
    const first = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "T", kind: "TARGET", scope: district("east", "east"), aspects: ["use"], predicate: { predicate: "new_build.use", negated: false, params: {} } }) },
      { op: "ADD", clause: grant("G", "building_construct", ["use"]) },
    ], { id: "oracle-pause-1" }));
    const rejected = h.run(first, [{ op: "CANCEL", targets: [] }], { id: "oracle-pause-2", operation: "CANCEL" });
    expect(rejected.pause?.kind).toBe("AMBIGUOUS_CANCEL");
    const admission = { artifact: first.artifact!, world: h.world, candidate: build(first.artifact!, { purpose_target_refs: ["T"] }), pause: rejected.pause };
    const result = admitCandidate(admission);
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("AMBIGUOUS_CANCEL");
  });

  test("replaying an accepted update after a later PATCH returns its original revision", () => {
    const h = harness();
    const original = intent([{ op: "ADD", clause: grant("G", "building_construct", ["use"]) }], { id: "oracle-replay-1", base: 0 });
    const first = accept(compile({ update: original, revision: null, world: h.world, capabilities: h.capabilities, evidence: h.evidence }));
    const second = accept(h.run(first, [{ op: "ADD", clause: clause({ clause_ref: "P", kind: "PREFERENCE", strength: "PREFERRED", scope: universe(), aspects: ["appearance"] }) }], { id: "oracle-replay-2", operation: "PATCH" }));
    const replay = accept(compile({ update: original, revision: second.revision, world: h.world, capabilities: h.capabilities, evidence: h.evidence }));
    expect(replay.revision?.revision).toBe(first.revision?.revision);
  });

  test("an approved proxy alone does not complete an active original required goal", () => {
    const h = harness({ evidence: { committed_ops: [], delivery_claims: [], samples: [sample({ metric: "population", scope_key: "east", value: 20 })] } });
    const compiled = accept(h.run(null, [{ op: "ADD", clause: clause({ clause_ref: "T_original", kind: "TARGET", scope: district("east", "east"), aspects: ["population"],
      predicate: { predicate: "new_build.use", negated: false, params: {} },
      completion: { ...reach("population"), proxy_of: "T_original", approximation_ref: "approved-proxy" } }) }], { id: "oracle-proxy" }));
    expect(aggregateMission(compiled.artifact!, h.world, h.evidence).complete).toBe(false);
  });

  test("REACH needs the whole quantified domain, not one TRUE cell", () => {
    const h = harness({ evidence: { committed_ops: [], delivery_claims: [], samples: [
      sample({ metric: "population", scope_key: "east", value: 20 }), sample({ metric: "population", scope_key: "west", value: 0 }),
    ] } });
    const completion = { ...reach("population"), domain: { kind: "FIXED_SELECTOR" as const, scope_ref: "both", selector: { kind: "district" as const, districts: ["east", "west"] } } };
    const compiled = accept(h.run(null, [{ op: "ADD", clause: clause({ clause_ref: "T", kind: "TARGET", scope: universe(), aspects: ["population"], completion }) }], { id: "oracle-domain" }));
    expect(aggregateMission(compiled.artifact!, h.world, h.evidence).complete).toBe(false);
  });

  test("stale generation, wrong unit and insufficient precision cannot complete", () => {
    const cases: Array<Partial<MetricSample>> = [
      { generation: 0 }, { unit: "wrong-unit" }, { precision: 100 },
    ];
    for (const changed of cases) {
      const h = harness({ evidence: { committed_ops: [], delivery_claims: [], samples: [sample({ metric: "population", scope_key: "east", value: 20, ...changed })] } });
      const compiled = accept(h.run(null, [{ op: "ADD", clause: clause({ clause_ref: "T", kind: "TARGET", scope: district("east", "east"), aspects: ["population"], completion: reach("population") }) }], { id: `oracle-evidence-${JSON.stringify(changed)}` }));
      expect(aggregateMission(compiled.artifact!, h.world, h.evidence).complete).toBe(false);
    }
  });

  test("a vacant MAINTAIN goal itself forbids infill without a separately authored FORBID", () => {
    const h = harness();
    const compiled = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "T_vacant", kind: "TARGET", scope: objects("land", ["land_east"]), aspects: ["vacancy"],
        predicate: { predicate: "exists.use", negated: false, params: { use: "vacant" } },
        completion: { ...reach("population"), tense: "MAINTAIN_OPEN" } }) },
      { op: "ADD", clause: grant("G_infill", "building_construct", ["use"]) },
    ], { id: "oracle-vacancy" }));
    const result = admitCandidate({ artifact: compiled.artifact!, world: h.world, candidate: build(compiled.artifact!, {
      purpose_target_refs: ["T_vacant"], effects: [effect("land_east", "use")],
    }) });
    expect(result.admitted).toBe(false);
  });

  test("a player hard cash floor is enforced by admission", () => {
    const h = harness({ world: { cash: 1000 } });
    const compiled = accept(h.run(null, [
      { op: "ADD", clause: clause({ clause_ref: "C_cash", kind: "CONSTRAINT", scope: universe(), aspects: ["fiscal"], params: { fiscal: [{ key: "cash_floor", hard: true, value: 800 }] } }) },
      { op: "ADD", clause: grant("G_build", "building_construct", ["use"]) },
    ], { id: "oracle-fiscal" }));
    const assessed=build(compiled.artifact!, { resources: { cash: 300 } });
    attachResource(h.world,assessed,300);
    const result = admitCandidate({ artifact: compiled.artifact!, world: h.world, candidate: assessed });
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("RESOURCE_INSUFFICIENT");
  });

  test("admission rechecks the actual world generation, not just artifact and candidate tags", () => {
    const h = harness();
    const compiled = accept(h.run(null, [{ op: "ADD", clause: grant("G", "building_construct", ["use"]) }], { id: "oracle-stale-world" }));
    const changedWorld = { ...h.world, generation: h.world.generation + 1 };
    const result = admitCandidate({ artifact: compiled.artifact!, world: changedWorld, candidate: build(compiled.artifact!) });
    expect(result.admitted).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("STALE_REVISION");
  });
});
