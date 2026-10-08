/**
 * AI Mayor Semantic Compiler V1 — typed IR, artifacts, diagnostics.
 *
 * Spec authority: docs/semantic-compiler/AI_MAYOR_SEMANTIC_COMPILER_V1_FREEZE_CANDIDATE.md
 * (V1 wins over the V0 documents wherever they disagree).
 *
 * Everything in this module is a versioned, finite registration. There is no place here
 * that reads natural language: `source_span` / `source_span_comment` are provenance text
 * only and the compiler never derives semantics from them.
 */

export const SCHEMA_VERSION = "mayor-intent/v1";
export const ONTOLOGY_VERSION = "mayor-ontology/v1";

/** Three-valued truth. UNSUPPORTED is a capability diagnostic, never a truth value. */
export type Tri = "TRUE" | "FALSE" | "UNKNOWN";

export type Strength = "REQUIRED" | "PREFERRED";

/**
 * Registered aspects. A permission on one aspect never silently covers another
 * (V1 §5.3: "操作坐标在东区不意味着西区影响有权").
 */
export type Aspect =
  | "appearance"
  | "use"
  | "model"
  | "existence"
  | "height"
  | "density"
  | "network_geometry"
  | "road_alignment"
  | "access"
  | "pollution"
  | "noise"
  | "population"
  | "commercial_activity"
  | "vacancy"
  | "fiscal"
  | "quality";

/** Operation categories a grant can authorize. */
export type OperationCategory =
  | "zoning_change"
  | "building_construct"
  | "building_rebuild"
  | "demolition"
  | "road_rebuild"
  | "road_widen"
  | "style_change"
  | "land_fill"
  | "loan";

export type ObjectKind = "district" | "parcel" | "building" | "road" | "metro" | "land";

export type LandUse = "commercial" | "residential" | "industrial" | "vacant";

/* ------------------------------------------------------------------ ontology */

/** The frozen 16-concept gameplay ontology (V1 §3). No concept is invented here. */
export type ConceptId =
  | "O01_STYLE"
  | "O02_URBAN_FORM"
  | "O03_DENSITY"
  | "O04_EXTENT"
  | "O05_LAND_USE"
  | "O06_USE_MIX"
  | "O07_MOBILITY"
  | "O08_PARKING"
  | "O09_OPEN_SPACE"
  | "O10_ECONOMIC_ROLE"
  | "O11_HOUSING_CONDITION"
  | "O12_ENVIRONMENT_QUALITY"
  | "O13_AESTHETIC_CHARACTER"
  | "O14_VARIATION"
  | "O15_SPATIAL_RELATION"
  | "O16_SITING";

export type PredicateId =
  | "exists.use"
  | "new_build.use"
  | "demolition.of_kind"
  | "pollution.at_receptor"
  | "population.count"
  | "cash.amount"
  | "building.floors"
  | "density.population_built"
  | "grid.purity"
  | "noise.level";

export interface PredicateSpec {
  predicate: PredicateId;
  negated: boolean;
  params: Record<string, unknown>;
}

/* --------------------------------------------------------------- world model */

/** Opaque local handle. Names never substitute for identity (V1 §5.1). */
export type ObjectId = string;

export interface WorldObject {
  id: ObjectId;
  kind: ObjectKind;
  name: string;
  cell: string;
  uses: LandUse[];
  floors: number | null;
  appearance: string | null;
  model: string | null;
  occupants: number | null;
  polluted: boolean | null;
}

export interface MetricSample {
  metric: string;
  scope_key: string;
  value: number | boolean | string | null;
  unit: string;
  generation: number;
  coverage: Tri;
  precision: number | null;
  samples: number;
  source?: string;
}

export interface WorldSnapshot {
  session: string;
  generation: number;
  objects: WorldObject[];
  cash: number | null;
  metrics: MetricSample[];
  /** Fixed district areas in km²; population density denominators come from here. */
  areas: Record<string, number>;
  /** Synthetic inspector records. A candidate may cite one, but cannot author it. */
  impact_certificates?: ImpactCertificate[];
  independence_certificates?: IndependenceCertificate[];
  resource_certificates?: ResourceCertificate[];
}

export interface ResourceCertificate {
  certificate_ref: string;
  candidate_ref: string;
  operation_category: OperationCategory;
  generation: number;
  session: string;
  extent: ScopeExtent;
  effects: CandidateEffect[];
  cash_cost: number;
  source: "SYNTHETIC_INSPECTOR";
}

export interface ImpactCertificate {
  certificate_ref: string;
  candidate_ref: string;
  operation_category: OperationCategory;
  generation: number;
  session: string;
  extent: ScopeExtent;
  effects: CandidateEffect[];
  complete_aspects: Aspect[];
  source: "SYNTHETIC_INSPECTOR";
  postcondition_refs?: string[];
}

export interface IndependenceCertificate {
  certificate_ref: string;
  candidate_ref: string;
  /** Inspector-bound semantic candidate data; a reused ref cannot retarget it. */
  candidate_digest: string;
  generation: number;
  session: string;
  unresolved_obligation_refs: string[];
  scope_known: boolean;
  effects_disjoint: boolean;
  shared_resources: Array<{ key: string; reservation_ref: string | null; conservative_bound: number | null }>;
  uses_unresolved_gates_or_grants: boolean;
  source: "SYNTHETIC_INSPECTOR";
}

/* -------------------------------------------------------------------- scope */

export type ScopeBindingKind = "SNAPSHOT" | "DYNAMIC";

export type ScopeSelector =
  | { kind: "universe" }
  | { kind: "district"; districts: string[] }
  | { kind: "object_kind"; object_kinds: ObjectKind[] }
  | { kind: "objects"; object_ids: ObjectId[] }
  | { kind: "minus"; base: ScopeSelector; remove: ScopeSelector }
  | { kind: "intersect"; parts: ScopeSelector[] }
  | { kind: "union"; parts: ScopeSelector[] };

export interface ScopeDecl {
  scope_ref: string;
  selector: ScopeSelector;
  binding: ScopeBindingKind;
  anchor: string;
}

/**
 * A resolved extent. `cells` are geographic domains (future occupants covered);
 * `entities` are explicit handles (a later same-name object is NOT absorbed).
 */
export interface ScopeExtent {
  cells: string[];
  entities: ObjectId[];
  universe_bound: boolean;
  excluded_entities?: ObjectId[];
}

export interface AspectBaseline {
  entity_id: ObjectId;
  object_kind: ObjectKind;
  object_name: string;
  captured_at_revision: number;
  values: Partial<Record<Aspect, string | number | boolean | null>>;
}

export interface BoundScope {
  scope_ref: string;
  decl: ScopeDecl;
  binding: ScopeBindingKind;
  anchor: string;
  bound_at_revision: number;
  /** SNAPSHOT: frozen at acceptance. DYNAMIC: null, re-resolved from the fixed selector. */
  frozen_extent: ScopeExtent | null;
  /** Entities resolved at acceptance; the baseline identity set. */
  bound_entities: ObjectId[];
  /** DYNAMIC: entity -> revision of first entry. Leaving does not delete the entry. */
  first_seen: Record<ObjectId, number>;
  baselines: Record<ObjectId, AspectBaseline>;
  universe_bound: boolean;
}

/* -------------------------------------------------------------------- gates */

export type Comparator = ">=" | "<=" | ">" | "<" | "==" | "!=";
export type GateMode = "CURRENT_TRUE" | "LATCH_ON_TRUE" | "EVENT";

export interface GateSpec {
  gate_ref: string;
  mode: GateMode;
  predicate?: { metric: string; comparator: Comparator; value: number | string | boolean };
  release_event?: string;
  /** Clause refs this gate gates. Only these writes are blocked. */
  affects: string[];
  time_base?: string;
}

export interface BoundGate extends GateSpec {
  bound_at_revision: number;
  latch_satisfied_at_revision: number | null;
  released_by_update_id: string | null;
}

/* --------------------------------------------------------------- completion */

export type Tense = "REACH" | "MAINTAIN_WINDOW" | "MAINTAIN_OPEN" | "NON_BINARY";
export type VacuousPolicy = "REQUIRE_NONEMPTY" | "ALLOW_VACUOUS" | "UNRESOLVED";

export type Denominator =
  | { kind: "FIXED_DISTRICT_AREA"; cells: string[]; area_km2: number }
  | { kind: "COUNT_RECEPTORS" }
  | { kind: "NONE" };

export interface CompletionDomainDecl {
  kind: "SNAPSHOT_ENTITIES" | "FIXED_SELECTOR";
  scope_ref: string;
  selector?: ScopeSelector;
  denominator?: Denominator;
  population_basis?: "BUILT";
  /** Fixed at acceptance for SNAPSHOT_ENTITIES. */
  bound_entities?: ObjectId[];
  bound_cells?: string[];
  bound_session?: string;
  /** Bound residual after an explicit local REPLACE, evaluated only in that domain. */
  bound_extent?: ScopeExtent;
  residual_unresolved?: boolean;
}

export interface CompletionContractInput {
  metric: string;
  unit: string;
  comparator: Comparator;
  threshold: number | string;
  domain: CompletionDomainDecl;
  tense: Tense;
  window_samples_required?: number;
  /** Synthetic V1 clock for finite window evidence. */
  time_base?: "WORLD_GENERATION";
  vacuous: VacuousPolicy;
  evidence_source: string;
  /** Set when this contract verifies an approved proxy rather than the original meaning. */
  proxy_of?: string;
  approximation_ref?: string;
  /** Mandatory for NON_BINARY; without it the contract is unresolved. */
  decision_protocol?: string;
}

/* ------------------------------------------------------------------ clauses */

export type ClauseKind = "TARGET" | "CONSTRAINT" | "PREFERENCE" | "PRESERVE" | "PERMISSION";
export type ClauseStatus = "ACTIVE" | "SUPERSEDED" | "CANCELLED";

export type OwnerDecl = { kind: "INDEPENDENT" } | { kind: "BOUND"; target_ref: string };

export type GrantValidity =
  | { kind: "UNTIL_REVOKED" }
  | { kind: "UNTIL_GATE"; gate_ref: string }
  | { kind: "QUANTITY"; max: number };

export interface PermissionParams {
  allow: boolean;
  operation_categories: OperationCategory[];
  affected_aspects: Aspect[];
  validity: GrantValidity;
  object_limit?: ObjectId[];
  use_limit?: LandUse[];
}

export interface ClauseInput {
  clause_ref: string;
  kind: ClauseKind;
  strength: Strength;
  concept?: ConceptId;
  predicate?: PredicateSpec;
  params?: Record<string, unknown>;
  aspects: Aspect[];
  scope: ScopeDecl;
  owner?: OwnerDecl;
  temporal?: GateSpec;
  completion?: CompletionContractInput;
  approximation?: ApproximationAuthorization;
  /** Provenance text only. Never interpreted. */
  source_span?: string;
}

export interface ApproximationAuthorization {
  approximation_ref: string;
  target_ref: string;
  aspect: Aspect;
  scope_ref: string;
  interpretation_version: string;
  mapping_ref: string;
  allowed_loss: string;
  acceptance_ref: string;
}

export interface ClauseProvenance {
  update_id: string;
  provider: string;
  operation: EnvelopeOperation;
  /** Historic clause ref this one replaced/restored, if any. */
  derived_from?: string;
}

export interface Clause extends ClauseInput {
  status: ClauseStatus;
  accepted_at_revision: number;
  bound_scope: BoundScope;
  provenance: ClauseProvenance;
  residualized?: boolean;
}

/* ------------------------------------------------------------------ updates */

export type EnvelopeOperation = "INIT" | "PATCH" | "REPLACE" | "CANCEL" | "PRESERVE" | "RESTORE";

export interface UpdateSource {
  provider: string;
  utterance_ref: string;
}

export interface ClausePatch {
  strength?: Strength;
  aspects?: Aspect[];
  params?: Record<string, unknown>;
  scope?: ScopeDecl;
  completion?: CompletionContractInput;
  temporal?: GateSpec;
}

export type UpdateOp =
  | { op: "ADD"; clause: ClauseInput }
  | { op: "PATCH_CLAUSE"; clause_ref: string; patch: ClausePatch }
  | { op: "REPLACE"; targets: string[]; replacements: ClauseInput[] }
  | { op: "CANCEL"; targets: string[] }
  | { op: "ADD_PRESERVE"; clause: ClauseInput }
  | { op: "RESTORE"; historic_clause_ref: string }
  | {
      op: "EXCEPTION";
      exception_ref: string;
      rule_ref: string;
      scope: ScopeDecl;
      aspects: Aspect[];
      operation_categories: OperationCategory[];
      grant?: ClauseInput;
    }
  | { op: "RELEASE_EVENT"; event: string };

export interface MayorIntentUpdate {
  schema_version: string;
  ontology_version: string;
  update_id: string;
  base_revision: number;
  operation: EnvelopeOperation;
  source: UpdateSource;
  ops: UpdateOp[];
  /** Provenance text only. */
  source_span_comment?: string;
}

/* ----------------------------------------------------------------- revision */

export interface RuleCarve {
  carve_ref: string;
  rule_ref: string;
  bound_scope: BoundScope;
  aspects: Aspect[];
  operation_categories: OperationCategory[];
  accepted_at_revision: number;
  provenance: ClauseProvenance;
}

export interface ConflictPause {
  kind: "AMBIGUOUS_CANCEL";
  update_id: string;
  scope_hint: string | null;
  paused: string[];
}

export interface AcceptedRevision {
  revision: number;
  update_id: string;
  session: string;
  world_generation: number;
  clauses: Clause[];
  carves: RuleCarve[];
  gates: BoundGate[];
  pauses: ConflictPause[];
  applied_events: string[];
  /** Ordered log of accepted update ids, used for idempotent re-send. */
  accepted_update_ids: string[];
  /** Hash of the update payload per accepted update id, for UPDATE_ID_COLLISION. */
  accepted_update_digests: Record<string, string>;
  /** Immutable response snapshots for exact accepted-update replay. */
  replay_results?: Record<string, ReplayResult>;
}

export interface ReplayResult {
  revision: Omit<AcceptedRevision, "replay_results">;
  artifact: SemanticArtifact;
  diagnostics: Diagnostic[];
}

/* --------------------------------------------------------------- capability */

export interface EffectDef {
  key: string;
  domain: string;
  aspect: Aspect;
  op: "set" | "max" | "min" | "add" | "range" | "equal";
  /** Scalars, ranges and finite sets; `use.union` merges registered value sets. */
  value: string | number | string[] | { min?: number; max?: number };
  hard: boolean;
  soft_rank?: number;
}

export interface ImpactCoverage {
  aspects: Aspect[];
  complete: boolean;
}

export interface MappingDef {
  mapping_id: string;
  version: string;
  concept: ConceptId | null;
  accepts: { predicate?: PredicateId; params?: string[]; values?: Record<string, string | number | boolean> };
  effects: EffectDef[];
  aspects: Aspect[];
  assumptions: EffectDef[];
  impact_coverage: ImpactCoverage;
  requires: {
    observations?: string[];
    primitives?: OperationCategory[];
    evaluators?: string[];
    content?: string[];
  };
  approximation_required: boolean;
  template: boolean;
  /**
   * Allowing aspects a template would silently add (a density floor, demolition, a
   * loan, terracing). If an active declaration does not grant them, the template is
   * unusable — implementation convenience never widens player semantics (V1 §8).
   */
  requires_declared_allowance?: Aspect[];
  /** Content-driven prerequisites that are never added to player semantics. */
  requires_demolition?: boolean;
  requires_loan?: boolean;
}

export interface MappingRegistry {
  version: string;
  mappings: MappingDef[];
  /** key+domain -> merge operator id. Missing operator means composition is undefined. */
  merge_operators: Record<string, MergeOperatorId>;
}

export type MergeOperatorId =
  | "range.intersect"
  | "set.equal"
  | "bool.and"
  | "use.union"
  | "numeric.min"
  | "numeric.max";

export interface CapabilitySet {
  version: string;
  mappings: MappingRegistry;
  observations: string[];
  evaluators: string[];
  primitives: OperationCategory[];
  content: string[];
  /** Conservative operation impact registration. Missing or incomplete means block. */
  operation_impacts?: Partial<Record<OperationCategory, { required_aspects: Aspect[]; possible_aspects: Aspect[]; complete: boolean }>>;
}

/* --------------------------------------------------------------- candidates */

export interface CandidateEffect {
  object_id: ObjectId;
  aspect: Aspect;
  kind: "DIRECT_WRITE" | "IMPLICIT_DELETE" | "CONSEQUENTIAL";
  detail?: string;
  /** TRUE = checkable and checked; UNKNOWN = impact cannot be determined. */
  verified: Tri;
  to_use?: LandUse;
}

export interface ResourceRequest {
  cash?: number;
  land_cells?: string[];
  capacity_keys?: string[];
}

export interface Candidate {
  candidate_ref: string;
  revision: number;
  world_generation: number;
  purpose_target_refs: string[];
  operation_category: OperationCategory;
  extent: ScopeExtent;
  effects: CandidateEffect[];
  impact_coverage: ImpactCoverage;
  resources: ResourceRequest;
  /** Grant refs the Planner believes cover this candidate. */
  claimed_grants: string[];
  independence?: IndependenceClaim;
  impact_certificate_ref?: string;
}

export interface IndependenceClaim {
  unresolved_obligation_refs: string[];
  scope_known: boolean;
  effects_disjoint: boolean;
  shared_resources: Array<{
    key: string;
    reservation_ref: string | null;
    conservative_bound: number | null;
  }>;
  uses_unresolved_gates_or_grants: boolean;
}

/* ---------------------------------------------------------------- evidence */

export interface CommittedOpRecord {
  op_ref: string;
  operation_category: OperationCategory;
  grant_ref: string | null;
  affected_objects: ObjectId[];
  state: "COMMITTED" | "IN_FLIGHT" | "UNKNOWN";
  generation: number;
}

export interface EvidenceRegister {
  committed_ops: CommittedOpRecord[];
  /** Metric samples read back from the world, per obligation metric+scope. */
  samples: MetricSample[];
  /** Commit-log claims that a world effect was delivered. Never a completion proof. */
  delivery_claims: Array<{ claim_ref: string; metric: string; scope_key: string; generation: number }>;
  invariant_certificates?: Array<{ clause_ref: string; session: string; through_generation: number; holds: Tri; coverage: Tri; source: "SYNTHETIC_INSPECTOR" }>;
}

/* --------------------------------------------------------------- templates */

export interface TemplateDef {
  template_id: string;
  version: string;
  requires_declared_allowance: Aspect[];
  effects: EffectDef[];
}

/* ----------------------------------------------------------------- profiles */

export type ProfileId = "FINANCIAL_RECOVERY" | "FAST_EXPANSION" | "AUTONOMOUS" | "BALANCED";

export interface ProfileInput {
  profile: ProfileId;
  version: string;
  /** Soft commercial preferences. Never hard admission conditions (V1 §10). */
  soft_thresholds: Array<{ key: string; index: number }>;
  candidate_ranking: string[];
  /** A Profile requesting demolition/loan authority must be refused. */
  requested_grants?: ClauseInput[];
}

export interface MissionRecord {
  mission_ref: string;
  profile: ProfileId;
  /** Mission requires advancing now (V1 §10 liveness contract). */
  requires_advance_now: boolean;
}

/* ------------------------------------------------------------------ effects */

export interface ComposedEffect {
  key: string;
  domain: string;
  aspect: Aspect;
  op: EffectDef["op"];
  value: EffectDef["value"];
  sources: string[];
  /** Bound finite domain on which this composed value is authorized. */
  extent?: ScopeExtent;
}

export interface EffectComposition {
  effects: ComposedEffect[];
  undefined_keys: string[];
  soft_ties: string[];
}

/* ---------------------------------------------------------------- artifact */

export type LayerStatus = "COMPILED" | "RESIDUE" | "UNSUPPORTED" | "OUT_OF_BOUNDARY";

export interface ClauseLayerStatus {
  clause_ref: string;
  ir_validity: Tri;
  compilability: LayerStatus;
  executability: Tri;
  verifiability: Tri;
  mapping_refs: string[];
  notes: string[];
}

export interface GoalRecord {
  clause_ref: string;
  strength: Strength;
  predicate: PredicateSpec | null;
  concept: ConceptId | null;
  scope_ref: string;
  aspects: Aspect[];
  owner: OwnerDecl;
  gate_refs: string[];
  completion_ref: string | null;
}

export interface ConstraintRecord {
  clause_ref: string;
  strength: Strength;
  /** Residual domain after every accepted carve is removed. */
  residual: ScopeExtent;
  carved: Array<{ carve_ref: string; extent: ScopeExtent }>;
  predicate: PredicateSpec | null;
  aspects: Aspect[];
  hard: boolean;
}

export interface SpatialPreferenceRecord {
  clause_ref: string;
  concept: ConceptId | null;
  aspects: Aspect[];
  weight_index: number;
}

export interface PreservationRule {
  clause_ref: string;
  strength: Strength;
  scope_ref: string;
  binding: ScopeBindingKind;
  /** Fixed domain at acceptance: geometry protects its future occupants too (V1 §5.1). */
  extent: ScopeExtent;
  members: ObjectId[];
  missing: ObjectId[];
  aspects: Aspect[];
  boundary: "AI_DIRECT_INTERVENTION" | "WORLD_RESULT";
  divergences: Array<{ entity_id: ObjectId; aspect: Aspect; baseline: unknown; current: unknown }>;
}

export interface GrantRecord {
  grant_ref: string;
  clause_ref: string | null;
  allow: boolean;
  operation_categories: OperationCategory[];
  affected_aspects: Aspect[];
  scope_ref: string;
  extent: ScopeExtent;
  purpose: OwnerDecl;
  validity: GrantValidity;
  object_limit: ObjectId[] | null;
  use_limit?: LandUse[] | null;
  quantity_max: number | null;
  consumed: number | null;
  status: "ACTIVE" | "REVOKED";
  revocation_reason: string | null;
  origin: "PLAYER" | "PRODUCT_BASELINE";
}

export interface FiscalRecord {
  clause_ref: string;
  key: string;
  hard: boolean;
  value: number;
}

export interface GateRecord {
  gate_ref: string;
  mode: GateMode;
  state: Tri;
  affects: string[];
  latch_satisfied_at_revision: number | null;
  released_by_update_id: string | null;
}

export interface ResidueRecord {
  clause_ref: string;
  reason: "AMBIGUOUS" | "OPAQUE" | "OUT_OF_BOUNDARY" | "UNSUPPORTED";
  aspects: Aspect[];
  strength: Strength;
  detail: string;
}

export interface CompletionObligation {
  clause_ref: string;
  role: "ORIGINAL" | "PROXY";
  strength: Strength;
  tense: Tense;
  metric: string;
  unit: string;
  comparator: Comparator;
  threshold: number | string;
  domain: CompletionDomainDecl;
  vacuous: VacuousPolicy;
  evidence_source: string;
  /** Finite-window MAINTAIN needs this many covered samples before it may pass. */
  window_samples_required: number | null;
  time_base: "WORLD_GENERATION" | null;
  approximation_ref: string | null;
  proxy_of?: string | null;
  status: "ACTIVE" | "CANCELLED" | "SUPERSEDED";
}

export interface SemanticArtifact {
  revision: number;
  world_generation: number;
  session: string;
  five_layers: {
    fidelity: "NOT_TESTED";
    ir_validity: Tri;
    compilability: Tri;
    executability: Tri;
    verifiability: Tri;
  };
  goals: GoalRecord[];
  constraints: ConstraintRecord[];
  spatial_preferences: SpatialPreferenceRecord[];
  preservation_rules: PreservationRule[];
  permission_envelope: GrantRecord[];
  /** Accepted targeted exceptions; admission exempts a rule only inside these (V1 §5.2). */
  carves: RuleCarve[];
  fiscal_envelope: FiscalRecord[];
  temporal_conditions: GateRecord[];
  allowed_policy_params: EffectComposition;
  completion_criteria: CompletionObligation[];
  residues: ResidueRecord[];
  layers: ClauseLayerStatus[];
  operation_impacts?: CapabilitySet["operation_impacts"];
  /** Immutable accepted clauses needed by admission and completion for shared semantics. */
  active_clauses?: Clause[];
}

/* ------------------------------------------------------------------ diags */

export type DiagnosticCode =
  | "INVALID_IR"
  | "STALE_REVISION"
  | "UPDATE_ID_COLLISION"
  | "AMBIGUOUS_REFERENCE"
  | "AMBIGUOUS_CANCEL"
  | "SCOPE_UNBOUND"
  | "HARD_CONFLICT"
  | "FEASIBILITY_UNKNOWN"
  | "GAME_LIMITATION"
  | "CONTENT_UNAVAILABLE"
  | "LOCAL_MAPPING_MISSING"
  | "OBSERVATION_MISSING"
  | "PRIMITIVE_MISSING"
  | "EVALUATOR_MISSING"
  | "OUT_OF_BOUNDARY"
  | "EFFECT_COMPOSITION_UNDEFINED"
  | "IMPACT_UNKNOWN"
  | "PERMISSION_DENIED"
  | "GATE_CLOSED"
  | "GATE_UNKNOWN"
  | "INDEPENDENCE_UNPROVEN"
  | "CONTRACT_UNRESOLVED"
  | "EVIDENCE_UNKNOWN"
  | "SOFT_TIE_UNRESOLVED"
  | "PROFILE_ONLY_STALL"
  | "RESOURCE_INSUFFICIENT";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "REJECT" | "BLOCK" | "INFO";
  refs: string[];
  detail: string;
}

/* ----------------------------------------------------------------- compile */

export interface CompileInput {
  /** null means "recompile the current revision against a new world snapshot". */
  update: MayorIntentUpdate | null;
  revision: AcceptedRevision | null;
  world: WorldSnapshot;
  capabilities: CapabilitySet;
  evidence: EvidenceRegister;
  clock?: string;
}

export type CompileOutcome = "ACCEPTED" | "REJECTED";

export interface CompileResult {
  outcome: CompileOutcome;
  /** The new revision when accepted; null when the update was rejected. */
  revision: AcceptedRevision | null;
  artifact: SemanticArtifact | null;
  /** Set when a rejected update leaves a write-pause the caller must persist (V1 §6.1). */
  pause: ConflictPause | null;
  diagnostics: Diagnostic[];
}
