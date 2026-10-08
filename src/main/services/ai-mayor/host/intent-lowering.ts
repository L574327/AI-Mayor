/**
 * INTENT LOWERING — the bounded subset of the frozen Semantic Compiler (docs/semantic-compiler) the product uses:
 *
 *   instruction (goal + forbids + preserves, from the AI line or the local reader)
 *     -> MayorIntentUpdate (built here, deterministically; the AI never writes the IR)
 *     -> compile() against a WorldSnapshot of the city's real districts
 *     -> lowered result: the runtime goal, permission overrides, protected areas (district outlines), and what was not understood or not supported.
 *
 * The compiler keeps the revision (what the player asked over time: a later "you may change the old town" is a new instruction, never a silent edit).
 * The goal itself goes to the runtime's own capability-checked vocabulary; the compiler owns the constraints, which is where its value is (preserve,
 * forbid, scope, conflicts).
 */
import { compile } from "../semantic-compiler/compile";
import type { AcceptedRevision, CapabilitySet, ClauseInput, CompileResult, EvidenceRegister, MayorIntentUpdate, OperationCategory, ScopeDecl, WorldSnapshot } from "../semantic-compiler/types";
import { ONTOLOGY_VERSION, SCHEMA_VERSION } from "../semantic-compiler/types";
import type { MayorStructuredGoalIntent } from "../types";
import type { ProtectedArea } from "../v2/protection";
import { careFocusFrom, describeCarePlan } from "../v2/care-focus";

export type ForbidKind = "demolition" | "loan" | "zoning_change" | "road_rebuild" | "land_purchase";
export const FORBID_KINDS: readonly ForbidKind[] = ["demolition", "loan", "zoning_change", "road_rebuild", "land_purchase"];

export type GrowthControl = "PAUSE" | "RESUME";
export type GrowthStyle = "STEADY" | "SNOWBALL";

export interface Instruction {
  goal: MayorStructuredGoalIntent | null;
  /** Further goals of the same sentence, in the player's order ("clear the ruins, then expand housing"). */
  goals?: MayorStructuredGoalIntent[];
  /** "Stop expanding" / "go on expanding": outward building held or resumed; the care of the city goes on either way. */
  growth?: GrowthControl;
  /** "Grow to 50,000": the population at which outward growth stops by itself. */
  targetPopulation?: number;
  /** "Expand all out / snowball" or "steady, keep the money growing": the growth mode, the same switch as on the home page. */
  style?: GrowthStyle;
  forbid: ForbidKind[];
  /** District names as the player said them, matched against the city's districts. */
  preserve: string[];
  unsupported: string[];
  /** Nothing in the sentence could be carried out as said, so the Mayor looks after the city's problems instead (never a flat refusal); what was left out stays in `unsupported`. */
  fallback?: boolean;
}

export interface CityDistrict { key: string; name: string; outline: Array<{ x: number; z: number }> }

export interface Lowered {
  accepted: boolean;
  goal: MayorStructuredGoalIntent | null;
  /** The city problems of every goal of the sentence, as one care goal (null: none named). */
  careGoal: MayorStructuredGoalIntent | null;
  /** The one building goal of the sentence (null: none). */
  buildGoal: MayorStructuredGoalIntent | null;
  growth: GrowthControl | null;
  targetPopulation: number | null;
  style: GrowthStyle | null;
  permissions: { allowLand?: boolean; allowEconomy?: boolean; preservePlayerAssets?: boolean; keepZoning?: boolean; keepRoads?: boolean };
  protectedAreas: ProtectedArea[];
  /** What the player should read: names matched, what was refused and why, what is not supported. */
  notes: string[];
  revision: AcceptedRevision | null;
}

/** "老城区" / "Old Town" against the city's districts: an exact (case/space-insensitive) name, else a unique containing match. */
export function matchDistrict(said: string, districts: readonly CityDistrict[]): { district: CityDistrict | null; ambiguous: CityDistrict[] } {
  const norm = (value: string) => value.toLowerCase().replace(/\s+/g, "").replace(/(区|district)$/i, "");
  const wanted = norm(said);
  if (!wanted) return { district: null, ambiguous: [] };
  const exact = districts.filter((district) => norm(district.name) === wanted);
  if (exact.length === 1) return { district: exact[0]!, ambiguous: [] };
  const partial = districts.filter((district) => norm(district.name).includes(wanted) || wanted.includes(norm(district.name)));
  if (partial.length === 1) return { district: partial[0]!, ambiguous: [] };
  return { district: null, ambiguous: exact.length > 1 ? exact : partial };
}

const OPERATION_OF: Partial<Record<ForbidKind, { category: OperationCategory; aspect: import("../semantic-compiler/types").Aspect }>> = {
  demolition: { category: "demolition", aspect: "existence" },
  loan: { category: "loan", aspect: "fiscal" },
  zoning_change: { category: "zoning_change", aspect: "use" },
  road_rebuild: { category: "road_rebuild", aspect: "network_geometry" },
};

/** What the local Mayor can do, registered for the compiler (constraints only: goals are the runtime's vocabulary). */
export function productCapabilities(): CapabilitySet {
  return {
    version: "ai-mayor/cap/1", mappings: { version: "ai-mayor/map/1", mappings: [], merge_operators: {} },
    observations: ["population"], evaluators: [], content: [],
    primitives: ["zoning_change", "building_construct", "demolition", "road_rebuild", "loan"],
    operation_impacts: {
      zoning_change: { required_aspects: ["use"], possible_aspects: ["use"], complete: true },
      building_construct: { required_aspects: ["use"], possible_aspects: ["use", "existence"], complete: true },
      demolition: { required_aspects: ["existence"], possible_aspects: ["existence"], complete: true },
      road_rebuild: { required_aspects: ["network_geometry"], possible_aspects: ["network_geometry", "access"], complete: true },
      loan: { required_aspects: ["fiscal"], possible_aspects: ["fiscal"], complete: true },
    },
  };
}

export function citySnapshot(session: string, generation: number, districts: readonly CityDistrict[], population: number | null, cash: number | null): WorldSnapshot {
  return {
    session, generation, cash,
    objects: districts.map((district) => ({ id: district.key, kind: "district" as const, name: district.name, cell: district.key, uses: [], floors: null, appearance: null, model: null, occupants: null, polluted: null })),
    metrics: population === null ? [] : [{ metric: "population", scope_key: "city", value: population, unit: "count", generation, coverage: "TRUE", precision: 0, samples: 1 }],
    areas: {}, impact_certificates: [], independence_certificates: [], resource_certificates: [],
  };
}

/**
 * The areas kept after an instruction: those already kept stay (by their recorded outlines), and a district named again replaces its own older
 * outline. An instruction resolves only the districts it names, so its own list is never the whole answer. Only "lift all" removes an area.
 */
export function mergeProtectedAreas(kept: readonly ProtectedArea[], named: readonly ProtectedArea[]): ProtectedArea[] {
  return [...kept.filter((area) => !named.some((next) => next.name === area.name)), ...named];
}

/** A population target the Mayor accepts (the runtime clamps it again). */
export const TARGET_POPULATION_RANGE = { minimum: 1_000, maximum: 2_000_000 } as const;

/**
 * The goals of one sentence as the runtime carries them: every city problem named (traffic, garbage, a service the care round answers) in ONE care
 * goal, and ONE building goal; a second building goal cannot run at the same time and is reported back, not dropped silently.
 */
export function combineGoals(goals: ReadonlyArray<MayorStructuredGoalIntent | null | undefined>): { care: MayorStructuredGoalIntent | null; build: MayorStructuredGoalIntent | null; dropped: MayorStructuredGoalIntent[] } {
  const present = goals.filter((goal): goal is MayorStructuredGoalIntent => !!goal);
  const careGoals = present.filter((goal) => careFocusFrom(goal) !== null);
  const buildGoals = present.filter((goal) => careFocusFrom(goal) === null);
  let care: MayorStructuredGoalIntent | null = null;
  if (careGoals.length === 1) care = careGoals[0]!;
  else if (careGoals.length > 1) {
    // EDUCATION is a care focus with no goal of its own (it answers the labour market): it is not named in a combined goal.
    const issues = [...new Set(careGoals.flatMap((goal) => careFocusFrom(goal) ?? []))].filter((issue): issue is Exclude<typeof issue, "EDUCATION"> => issue !== "EDUCATION");
    const priority = careGoals.some((goal) => goal.priority === "HIGH") ? "HIGH" : "NORMAL";
    care = { kind: "GOAL", type: "RESOLVE_ISSUES", priority, scope: { issues } };
  }
  return { care, build: buildGoals[0] ?? null, dropped: buildGoals.slice(1) };
}

const emptyEvidence = (): EvidenceRegister => ({ committed_ops: [], samples: [], delivery_claims: [] });

/** Lower one instruction on top of the revision so far. Pure: the caller keeps the revision and applies the result. */
export function lowerInstruction(input: {
  instruction: Instruction; districts: readonly CityDistrict[]; session: string; generation: number; population: number | null; cash: number | null;
  previous: AcceptedRevision | null; updateId: string; lang: "zh" | "en";
}): Lowered {
  const { instruction, districts, lang } = input;
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const notes: string[] = [...instruction.unsupported.map((item) => say(`暂不支持：${item}`, `Not supported yet: ${item}`))];
  if (instruction.fallback) notes.push(say("这句话里没有能直接照做的部分，市长先照看城市里所有的问题；想要别的，换个更具体的说法再告诉我", "Nothing here could be done exactly as said, so the Mayor looks after all of the city's problems for now; say it more specifically for something else"));
  const anchor = input.session;
  const universe: ScopeDecl = { scope_ref: `all-${input.updateId}`, selector: { kind: "universe" }, binding: "SNAPSHOT", anchor };
  const ops: MayorIntentUpdate["ops"] = [];
  const preservedKeys: Array<{ key: string; name: string }> = [];

  for (const said of instruction.preserve) {
    const match = matchDistrict(said, districts);
    if (!match.district) {
      notes.push(match.ambiguous.length > 1
        ? say(`“${said}”对应了多个区（${match.ambiguous.map((d) => d.name).join("、")}），请说得更具体`, `"${said}" matches several districts (${match.ambiguous.map((d) => d.name).join(", ")}); please be more specific`)
        : say(`城市里没有叫“${said}”的区（先在游戏里划出这个区并命名）`, `There is no district called "${said}" (draw and name it in the game first)`));
      continue;
    }
    preservedKeys.push({ key: match.district.key, name: match.district.name });
    ops.push({ op: "ADD_PRESERVE", clause: { clause_ref: `keep-${match.district.key}-${input.updateId}`, kind: "PRESERVE", strength: "REQUIRED",
      aspects: ["existence", "use", "network_geometry"], scope: { scope_ref: `d-${match.district.key}-${input.updateId}`, selector: { kind: "district", districts: [match.district.key] }, binding: "SNAPSHOT", anchor },
      source_span: said } satisfies ClauseInput });
  }
  for (const kind of instruction.forbid) {
    const operation = OPERATION_OF[kind];
    if (!operation) continue;
    ops.push({ op: "ADD", clause: { clause_ref: `forbid-${kind}-${input.updateId}`, kind: "PERMISSION", strength: "REQUIRED", aspects: [operation.aspect], scope: universe,
      params: { allow: false, operation_categories: [operation.category], affected_aspects: [operation.aspect], validity: { kind: "UNTIL_REVOKED" } } } satisfies ClauseInput });
  }

  let result: CompileResult | null = null;
  if (ops.length > 0) {
    const update: MayorIntentUpdate = { schema_version: SCHEMA_VERSION, ontology_version: ONTOLOGY_VERSION, update_id: input.updateId,
      base_revision: input.previous?.revision ?? 0, operation: input.previous ? "PATCH" : "INIT", source: { provider: "ai-mayor-console", utterance_ref: input.updateId }, ops };
    result = compile({ update, revision: input.previous, world: citySnapshot(input.session, input.generation, districts, input.population, input.cash),
      capabilities: productCapabilities(), evidence: emptyEvidence() });
    if (result.outcome !== "ACCEPTED") {
      notes.push(say(`这些限制没有被接受：${result.diagnostics.map((d) => `${d.code}`).join("、")}`, `These limits were not accepted: ${result.diagnostics.map((d) => d.code).join(", ")}`));
      return { accepted: false, goal: instruction.goal, careGoal: null, buildGoal: null, growth: null, targetPopulation: null, style: null, permissions: {}, protectedAreas: [], notes, revision: input.previous };
    }
  }

  // What the accepted revision says now (all instructions so far): protected district cells and forbidden operations.
  const revision = result?.revision ?? input.previous;
  const artifact = result?.artifact ?? null;
  const protectedKeys = new Set<string>();
  for (const rule of artifact?.preservation_rules ?? []) for (const cell of rule.extent.cells) protectedKeys.add(cell);
  const forbidden = new Set<OperationCategory>();
  for (const grant of artifact?.permission_envelope ?? []) if (!grant.allow && grant.status === "ACTIVE") for (const category of grant.operation_categories) forbidden.add(category);
  const protectedAreas = districts.filter((district) => protectedKeys.has(district.key) && district.outline.length >= 3)
    .map((district) => ({ name: district.name, polygon: district.outline, source: "player instruction" }));
  // Permissions come from what THIS instruction forbade (and the compiler accepted): the caller keeps them, and a later change in Settings may
  // lift them; an older clause in the revision must not quietly come back with an unrelated instruction.
  const permissions: Lowered["permissions"] = {};
  if (instruction.forbid.includes("loan") && forbidden.has("loan")) permissions.allowEconomy = false;
  if (instruction.forbid.includes("demolition") && forbidden.has("demolition")) permissions.preservePlayerAssets = true;
  if (instruction.forbid.includes("zoning_change") && forbidden.has("zoning_change")) permissions.keepZoning = true;
  if (instruction.forbid.includes("road_rebuild") && forbidden.has("road_rebuild")) permissions.keepRoads = true;
  if (instruction.forbid.includes("land_purchase")) permissions.allowLand = false;
  for (const kept of preservedKeys) notes.push(say(`会保护“${kept.name}”：市长不在这个区里修路、划区、建造或拆除`, `"${kept.name}" is protected: the Mayor will not build, zone, lay roads or demolish there`));
  if (permissions.keepZoning) notes.push(say("不改区划：已有分区的格子不再涂，只在空地上划新区", "No rezoning: cells that already have a zone are left alone; new zones go on bare ground only"));
  if (permissions.keepRoads) notes.push(say("不改路：不拆任何道路（包括市长自己修的断头路），新路照常修在空地上", "No road changes: no road is removed (not even the Mayor's own dead ends); new streets are still laid on free ground"));
  if (permissions.allowEconomy === false) notes.push(say("不贷款、不动税率和预算", "No loans, no tax or budget changes"));
  if (permissions.preservePlayerAssets) notes.push(say("不拆玩家的建筑", "The player's buildings are not demolished"));
  if (permissions.allowLand === false) notes.push(say("不买新地块", "No new land is bought"));
  const combined = combineGoals([instruction.goal, ...(instruction.goals ?? [])].slice(0, 4));
  const growth = instruction.growth === "PAUSE" || instruction.growth === "RESUME" ? instruction.growth : null;
  const wanted = instruction.targetPopulation;
  const targetPopulation = typeof wanted === "number" && Number.isFinite(wanted)
    ? Math.max(TARGET_POPULATION_RANGE.minimum, Math.min(TARGET_POPULATION_RANGE.maximum, Math.round(wanted))) : null;
  if (growth === "PAUSE") notes.push(say("暂停扩张：不再开新片区、不买地；已有城市的问题（道路连通、垃圾、废墟、交通、服务）照常处理；取消首页的“自治·不扩张”勾选（或说“继续扩张”）即可恢复",
    "Expansion held: no new districts and no land; the city that stands is still looked after (roads, garbage, ruins, traffic, services). Untick the Autonomy / no-expansion box on the home page (or say: resume expansion) to go on"));
  if (growth === "RESUME") notes.push(say("恢复扩张：按城市需求继续开新片区", "Expansion resumed: new districts as the city needs them"));
  const style = instruction.style === "SNOWBALL" || instruction.style === "STEADY" ? instruction.style : null;
  if (style === "SNOWBALL") notes.push(say("扩张模式：滚雪球——有钱就建，批次按现金上限，空地不够就买地", "Growth mode: snowball — cash is spent on building as it comes, land is bought as needed"));
  if (style === "STEADY") notes.push(say("扩张模式：稳健——边扩张边攒钱", "Growth mode: steady — the city grows while the treasury keeps growing"));
  if (targetPopulation !== null) notes.push(say(`目标人口 ${targetPopulation.toLocaleString("zh-CN")}：到达后停止向外扩张，只维护城市`, `Target population ${targetPopulation.toLocaleString("en-US")}: outward growth stops there and the Mayor keeps the city running`));
  if (growth === "PAUSE" && combined.build) notes.push(say("这句话同时要求暂停扩张和新建片区：以暂停为准，新建片区不执行", "This asks to hold expansion and to build a district: the hold wins, the district is not built"));
  const buildGoal = growth === "PAUSE" ? null : combined.build;
  for (const extra of combined.dropped) notes.push(say(`一次只执行一个建设目标，“${extra.type}”请在当前目标完成后再说`, `One building goal at a time: say "${extra.type}" again once the current one is done`));
  // A goal about the city's problems: what the Mayor will do about each, in the player's language (`v2/care-focus.ts`).
  const care = careFocusFrom(combined.care);
  if (care) notes.push(...describeCarePlan(care, lang));
  return { accepted: true, goal: buildGoal ?? combined.care, careGoal: combined.care, buildGoal, growth, targetPopulation, style, permissions, protectedAreas, notes, revision };
}
