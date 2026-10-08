# Urban Design Language v0

Status: **VALIDATED / FEATURE-FROZEN FOR ALPHA** (2026-09-11).

UDL Alpha validation covers the semantic design pipeline, canonical anchors, style-aware planning envelope, style-aware road realization, deterministic material geometry difference, real UDL execution into CS2, and existing safety/revalidation boundaries. Phase 5B live execution changed real CS2 roads from `362` to `363`; Phase 6 deterministic realization showed materially different orthogonal-grid and terrain-organic headings, endpoints, lengths and topology roles.

The same-baseline dual-style live native-preview proof is deliberately **DEFERRED**. The final frontier run reached the existing generator, but the current site's unchanged ownership/building safety rejected all bounded attempts. This does not invalidate the deterministic style-realization or live execution evidence, and it must not be described as a same-site live A/B PASS.

UDL Alpha scope is frozen. Curved roads, advanced topology, Style Packs, further beautification and the deferred same-site native-preview comparison are backlog items. Do not reopen UDL unless a real user/runtime regression requires it. The next primary project milestone is Local Mayor Engine v0.

## 1. Decision

Urban Design Language (UDL) is a new planning layer between Mayor intent and the existing deterministic Spatial Planner. It expresses a district as a composable grammar, not as a blueprint and not as model-authored coordinates.

The architecture is:

```text
player natural language + current Snapshot + bounded design memory
                              |
                              v
                    DeepSeek Urban Designer
                    UrbanDesignIntent (no coordinates)
                              |
                              v
          grammar catalog + deterministic SiteContext extraction
                              |
                              v
                    Spatial Design Planner
          bounded proposal alternatives + private geometry
                              |
                              v
             existing validated candidate registry
                              |
                   +----------+----------+
                   |                     |
             Normal actions       Fast constructionPhase
                   |                     |
                   +----------+----------+
                              |
                              v
             existing Runtime / Safety / Batch
                              |
                              v
                 fresh Snapshot and re-plan
```

UDL does not replace `MayorPlan`, `choose_candidate`, `constructionPhase`, live candidate revalidation, Batch execution, simulation boundaries, or pause/save/stop. It expands how the Spatial Planner generates and describes validated candidates.

The central product rule is **constrained creativity**:

- identity comes from a grammar envelope;
- site form comes from measured geometry;
- variation comes from bounded parameters, motif choices, and a deterministic seed;
- novelty comes from compact recent-design memory;
- judgment remains with DeepSeek where alternatives are all safe;
- legality always remains with deterministic validation.

Raising model temperature is not a diversity mechanism. A model may vary its high-level choice, but every choice must resolve through typed intent, grammar bounds, deterministic geometry, scoring, native preview where required, and current-Snapshot validation.

## 2. Responsibilities and boundaries

### DeepSeek: Urban Designer / Mayor

DeepSeek interprets natural language and current city conditions. It chooses:

- district goal and identity;
- primary style and optional secondary influence;
- development intensity and density profile;
- road hierarchy intent;
- commercial, green-space, buffering, and transit tendencies;
- an allowed motif or permission for the Planner to choose one;
- whether to continue, reinterpret, or deliberately break a recent motif;
- one proposal or one/more currently validated candidate IDs;
- whether to build, wait, or request a later phase.

It does not choose world coordinates, raw splines, zoning radii, road entity IDs, exact block dimensions, or safety thresholds. It cannot mark geometry validated and cannot override an invalid candidate.

### Urban Design Language

UDL provides a small vocabulary and grammar catalog that turns qualitative intent into bounded planning parameters. It owns style identity, parameter ranges, allowed motifs, adaptation preferences, anti-patterns, and soft-scoring preferences. It is data, schema, and interpretation rules—not executable construction code.

### Spatial Design Planner

The Planner reads current map geometry and converts intent into a bounded set of deterministic proposal alternatives. It owns:

- site analysis and coordinate systems;
- topology and curve construction;
- parameter resolution inside grammar bounds;
- candidate geometry and dependencies;
- hard constraint checks and native previews;
- soft metric calculation and proposal diversity filtering;
- publication of safe summaries while retaining private geometry.

Given the same Snapshot, intent, grammar versions, and seed, it must produce the same proposals in the same order.

### Runtime / Safety

Runtime remains style-blind except for telemetry and bounded schema transport. It continues to own strict plan parsing, candidate freshness, conflict checks, execution limits, Batch, simulation, Cost Guard, single-flight, pause/save/stop, and extreme risk protection. It must not select a prettier proposal, alter style weights, or silently replace the Mayor's design choice.

## 3. Data flow

1. Snapshot acquisition reads the same authoritative city state used today.
2. `SiteContext` deterministically summarizes owned land, terrain, water edges, road geometry, access nodes, existing districts, pollution, utilities, and developable envelopes. Coordinates stay private.
3. The prompt receives compact site affordances, available style cards, recent design signatures, and the player's natural-language request.
4. DeepSeek returns `UrbanDesignIntent` with semantic choices only.
5. The intent validator resolves style IDs, defaults, mixing rules, and requested values against grammar ranges. Invalid or unavailable choices are rejected or returned for one bounded correction; they are never guessed into geometry.
6. The Spatial Design Planner derives a local coordinate frame from the site, resolves parameters with a seeded PRNG, generates a bounded number of alternatives, rejects hard failures, calculates a vector of soft metrics, and removes near-duplicates.
7. It publishes `SpatialDesignProposal` summaries and active validated `MayorPlanningCandidate` IDs. Raw geometry remains in the existing private registry.
8. DeepSeek selects a proposal/candidate set. Normal mode uses existing candidate actions. Fast mode may select multiple non-conflicting IDs in the existing `constructionPhase`.
9. Runtime revalidates and executes through the current path.
10. A fresh Snapshot updates the active planning frontier. Road work can expose new frontage; dependent zoning is generated only after that real geometry exists.
11. On successful mutation, the design memory records a compact signature. Failed or rejected work does not count as a used motif.

This is deliberately snapshot-phased. A proposal may describe `roads -> frontage -> zoning` as expected stages, but v0 publishes only candidates valid now. It never assumes that a future zoning stage is legal before the post-road Snapshot.

## 4. Variation without repetition or chaos

Each style separates five sources of decision:

| Source | Examples | Authority |
| --- | --- | --- |
| Fixed identity | topology family, hierarchy character, defining anti-patterns | grammar pack |
| Bounded variation | block scale range, curvature band, intersection spacing, green ratio | grammar range resolved by Planner |
| Site-derived | waterfront axis, contour direction, gateway bearing, obstacle gaps | `SiteContext` |
| Deliberate design choice | density, commercial organization, motif, continue/break recent pattern | DeepSeek within allowed vocabulary |
| Seeded variation | alternative ordering, spacing jitter, branch cadence, equivalent motif variant | deterministic Planner PRNG |

The seed never perturbs hard constraints. It is used only after the grammar and site have established a legal design envelope. It may select among allowed motifs or sample bounded values, but may not turn a grid into an organic network, erase hierarchy, exceed slope limits, or bypass a buffer.

The Planner should generate 3–6 raw alternatives per planning area, retain at most 3 materially distinct validated proposals, and cap active executable candidates using the existing Runtime limit. Diversity filtering compares topology, orientation, block-scale band, land-use pattern, and green pattern; changing only a few meters of geometry does not create a distinct proposal.

Soft metrics remain a vector rather than one universal beauty score. The Planner may use grammar-specific weights to find a Pareto frontier and deterministic tie order, but should expose the meaningful trade-offs to DeepSeek. This preserves judgment without asking the model to reason about private coordinates.

## 5. v0 style set

v0 should ship five grammars. They cover meaningfully different spatial structures while remaining feasible with current road/zoning candidate architecture.

### 5.1 Orthogonal Grid (`orthogonal-grid`)

- **Identity:** two dominant near-perpendicular axes, legible hierarchy, connected rectangular blocks.
- **Ranges:** medium-to-large blocks, low-to-moderate orientation jitter, optional alternating block depth, bounded local interruptions.
- **Motifs:** aligned grid, offset grid, gateway-aligned grid, elongated commercial spine.
- **Preferences:** connectivity, frontage efficiency, coherent collectors, selective block-size variation.
- **Anti-patterns:** identical blocks over many districts, excessive four-way intersections, grid projected through water or steep terrain.
- **Adaptation:** choose orientation from existing streets, highway entrance, shoreline tangent, or terrain feasibility; clip, step, or locally bend around obstacles.

### 5.2 Terrain-Following Organic (`terrain-organic`)

- **Identity:** roads follow contours and obstacles; irregular blocks; a small number of clear connectors prevent maze-like growth.
- **Ranges:** moderate curvature, variable segment length, sparse local branches, bounded dead ends.
- **Motifs:** contour loops, branching crescents, saddle connector, adapted village web.
- **Preferences:** terrain fit, low cut/fill proxy, preserved natural edges, connector legibility.
- **Anti-patterns:** arbitrary wiggles on flat land, disconnected curls, excessive cul-de-sacs, weak access to the existing network.
- **Adaptation:** curvature and branching derive from slope field, dry corridors, existing-road tangents, and owned-land shape.

### 5.3 Waterfront Linear (`waterfront-linear`)

- **Identity:** a public-facing shoreline sequence with one or more parallel/back streets and frequent inland connections.
- **Ranges:** shoreline setback band, promenade/road continuity, cross-link cadence, density gradient inland.
- **Motifs:** linear promenade, harbor fingers where geometry permits, waterfront nodes, alternating green and commercial edges.
- **Preferences:** shoreline following, water access continuity, view/frontage value, flood/water safety, inland connectivity.
- **Anti-patterns:** zoning into water, continuous industrial occupation of scenic edge, roads mechanically tracing every shoreline irregularity, isolated waterfront strip.
- **Adaptation:** derive local tangent and curvature from sampled coastline; react to bridges, river width, existing crossings, and buildable setbacks.

### 5.4 Garden Neighborhood (`garden-neighborhood`)

- **Identity:** low-density local streets grouped around green anchors, with traffic concentrated on a clear perimeter/collector structure.
- **Ranges:** small clusters, high green distribution, low intersection intensity, limited and bounded cul-de-sacs.
- **Motifs:** green-centered loop, paired crescents, filtered grid, short cul-de-sac clusters.
- **Preferences:** residential buffering, distributed green access, low through-traffic, safe collector access.
- **Anti-patterns:** disconnected sprawl, one giant residual park, commercial strips on every local street, unbounded low-density land consumption.
- **Adaptation:** place clusters in flatter buildable pockets and use existing collectors, barriers, pollution buffers, and ownership boundaries as edges.

### 5.5 Compact Urban (`compact-urban`)

- **Identity:** fine-grained connected blocks, strong center or civic node, mixed commercial organization, short walking-scale links.
- **Ranges:** small-to-medium blocks, high connectivity, moderate irregularity, center-to-edge density gradient.
- **Motifs:** perimeter blocks, market spine, civic square frame, fine-grain infill, gateway-to-center axis.
- **Preferences:** frontage utilization, connected blocks, active central streets, density coherence, small distributed greens/plazas.
- **Anti-patterns:** superblocks, uniform commercial carpeting, decorative plazas without access, high density beside pollution without buffering.
- **Adaptation:** center on existing junctions, transit/access nodes, or a feasible new node; inherit nearby street bearings but allow bounded historical irregularity.

`node-centered/radial` is not a standalone v0 grammar. Its useful, feasible part is represented by civic-node and green-centered motifs. Full radial networks require reliable curved-road junction and roundabout generation and should be considered after v0 geometry is proven.

## 6. Style mixing

v0 supports exactly one `primaryStyle` and at most one `secondaryInfluence`. The primary owns topology, hard anti-patterns, and base parameter bounds. The secondary may influence only whitelisted dimensions:

- block scale within the primary's safe intersection;
- density gradient;
- commercial pattern;
- green-space pattern;
- curvature or orientation jitter when compatible;
- transit bias and street emphasis.

The secondary weight is a semantic enum (`subtle` or `moderate`), resolved to a bounded pack-defined range roughly equivalent to 15–35%. It cannot replace topology, relax safety, or introduce motifs the primary cannot represent. Every bundled pair has a compatibility declaration per influence dimension. Unsupported combinations preserve the primary and report which requested influence could not be expressed.

This avoids pair-specific hybrid grammars and combinatorial explosion. `Waterfront + Compact Urban` can produce a compact waterfront center because compact density/commercial/green tendencies can influence waterfront topology. `Grid + Garden` can produce a filtered, greener grid. It does not create a sixth or seventh hidden grammar.

## 7. Core schemas

These are conceptual TypeScript shapes for implementation. Exact names may be aligned with existing project conventions, but their authority boundaries should remain.

```ts
type StyleId = string;
type DensityIntent = "low" | "medium" | "high" | "gradient";
type MotifNovelty = "continue" | "vary" | "break" | "planner_choice";

interface UrbanDesignIntent {
  intentId: string;
  districtGoal: string;              // bounded natural-language summary
  targetArea: {
    siteId: string;                  // Planner-issued opaque site reference
    relation?: "infill" | "edge_expansion" | "waterfront" | "gateway" | "node";
  };
  primaryStyle: StyleId;
  secondaryInfluence?: {
    style: StyleId;
    strength: "subtle" | "moderate";
    dimensions?: Array<"block_scale" | "density" | "commercial" | "green" | "curvature" | "transit">;
  };
  density: DensityIntent;
  roadHierarchy: "local_first" | "balanced" | "collector_spine";
  commercialPattern: "none" | "nodes" | "main_street" | "edge" | "mixed_core" | "planner_choice";
  greenSpaceIntent: "minimal" | "distributed" | "central" | "linear" | "buffer" | "planner_choice";
  transitBias: "neutral" | "transit_ready" | "walking_cycling_ready";
  preferredMotif?: string;           // must exist in resolved primary grammar
  novelty: {
    motif: MotifNovelty;
    avoidSignatures?: string[];      // bounded opaque IDs supplied in prompt
  };
  variationSeed: string;             // assigned/normalized by orchestrator, not a coordinate
  rationale: string;
}
```

DeepSeek may request a `siteId` only from the current site catalog. If a player says “这里”, the site catalog resolves camera/selection context into an opaque site; the model does not receive permission to treat camera coordinates as build coordinates.

```ts
interface SiteContext {
  siteId: string;
  snapshotRevision: string;
  localFrameId: string;              // private Planner coordinate frame
  areaClass: "infill" | "edge" | "waterfront" | "gateway" | "isolated_pocket";
  buildableAreaBand: "small" | "medium" | "large";
  slopeProfile: "flat" | "rolling" | "steep" | "mixed";
  waterRelationship: "none" | "river_edge" | "coastline" | "crossing";
  roadContext: {
    geometry: "grid_like" | "curved" | "mixed" | "sparse";
    gatewayCount: number;
    dominantBearingBand?: string;
    hierarchyEvidence: string[];
  };
  constraints: string[];
  opportunities: string[];
  pollutionRisk: "none" | "nearby" | "intersects";
  ownedLandCoverage: "constrained" | "adequate" | "open";
}
```

Only the semantic projection of `SiteContext` enters the prompt. Terrain samples, polygons, coordinates, entity geometry, and collision details remain private.

```ts
interface SpatialDesignProposal {
  proposalId: string;
  intentId: string;
  snapshotRevision: string;
  grammar: { primary: StyleId; primaryVersion: string; secondary?: StyleId };
  designSummary: string;
  motif: string;
  designSignature: string;
  tradeoffs: string[];
  activeCandidates: Array<{
    candidateId: string;             // existing registry ID
    role: "structure" | "connector" | "zoning" | "buffer" | "green_anchor";
    phase: "active_now";
    conflictGroup: string;
    dependsOn?: string[];            // v0 active set must already be satisfiable
  }>;
  futureStages: Array<{
    after: "fresh_snapshot";
    goal: string;                    // descriptive, never pre-authorized geometry
  }>;
  utilityServiceImplications: string[];
  estimatedCapacity: { band: "small" | "medium" | "large"; approximateCells?: number };
  estimatedCost: { band: "low" | "medium" | "high" | "unknown"; amount?: number };
  metrics: DesignMetricVector;
  constraints: string[];
  validation: {
    state: "validated" | "partial" | "rejected";
    validatedCandidateCount: number;
    rejectionReasons: string[];
  };
}
```

Only `validated` proposals with at least one active validated candidate are selectable for construction. `partial` proposals may be shown as planning information but may not leak unvalidated candidate IDs into `MayorPlan`.

```ts
interface DesignMetricVector {
  roadHierarchyCoherence: number;
  connectivity: number;
  frontageUtilization: number;
  terrainFit: number;
  shorelineFit?: number;
  blockScaleFit: number;
  blockVariation: number;
  deadEndControl: number;
  landUseBuffering: number;
  greenDistribution: number;
  noveltyDistance: number;
}
```

Metrics use normalized, versioned definitions for comparison inside one Planner version. They are not claims of objective beauty and should not be presented as player-facing percentages in v0.

## 8. Grammar representation

Use a hybrid with a strict boundary:

1. **TypeScript owns trusted mechanics.** It defines schemas, version migration, deterministic PRNG, generic geometry operators, motif composition, site analyzers, hard validators, metric implementations, bounded search, and the pack loader. Examples of generic operators are `parallelSpine`, `crossLinks`, `contourPath`, `loop`, `branch`, `perimeterBlock`, and `greenAnchor`. Packs may reference only registered operators.
2. **Validated JSON owns grammar data.** Each bundled style is a data file containing identity tags, parameter ranges, allowed operator sequences/motifs, adaptation rules expressed through a finite condition DSL, soft preference weights, anti-pattern thresholds, mix compatibility, and concise semantic descriptions.
3. **Prompt cards are generated from validated grammar data.** DeepSeek sees IDs, identity, available motifs, meaningful trade-offs, compatibility, and site affordances—not every numeric threshold or operator detail. This keeps the prompt compact and prevents semantic and executable definitions from drifting.
4. **Markdown owns human rationale and examples only.** Documentation can explain why a style exists and illustrate expected forms, but Planner behavior must not depend on parsing Markdown or a model Skill.

Illustrative pack shape:

```json
{
  "schemaVersion": 1,
  "id": "waterfront-linear",
  "version": "1.0.0",
  "identity": ["shoreline-oriented", "linear-public-edge", "inland-cross-links"],
  "prompt": {
    "name": "Waterfront Linear",
    "summary": "A connected waterfront sequence with inland links and a protected public edge."
  },
  "parameters": {
    "shoreSetbackBand": { "min": 24, "max": 80 },
    "crossLinkSpacing": { "min": 80, "max": 180 }
  },
  "motifs": [
    { "id": "promenade-spine", "operators": ["shorelineSpine", "parallelSpine", "crossLinks"] }
  ],
  "adaptationRules": [
    { "when": "site.waterRelationship in [river_edge, coastline]", "prefer": "shorelineSpine" }
  ],
  "preferences": { "shorelineFit": 1.0, "connectivity": 0.8, "frontageUtilization": 0.6 },
  "antiPatterns": { "maxDisconnectedComponents": 0, "maxDeadEndRatio": 0.2 },
  "mixing": { "allowInfluenceDimensions": ["density", "commercial", "green", "transit"] }
}
```

The real DSL must be enumerated and schema-validated; it must not evaluate strings, expressions, scripts, callbacks, dynamic imports, shell commands, or arbitrary JavaScript.

## 9. Site adaptation

The Planner derives design axes and feasibility before sampling style variation:

- **Terrain/slope:** construct buildability and contour fields; penalize cross-slope segments and reject excessive grades. Organic styles follow feasible contours; grids may rotate, step, clip, or reduce block depth.
- **River/coastline:** extract a simplified safe shoreline curve and tangent field. Waterfront roads follow a smoothed approximation with safe setbacks; other styles may orient an axis toward or parallel to water without becoming waterfront grammars.
- **Existing road geometry:** infer local bearings, connectivity, endpoints, and hierarchy proxies. New structure should connect and can inherit, transition from, or deliberately contrast nearby geometry when the intent says to break a motif.
- **Highway entrance/gateway:** treat it as access and orientation evidence, not as a city center. Collector-spine intent may align from gateway toward a feasible node; local streets should not connect indiscriminately to highway geometry.
- **Developed districts:** respect occupied geometry, infer boundaries and recent signatures, prefer infill where appropriate, and avoid erasing established hierarchy.
- **Industrial pollution:** create hard unsafe-residential exclusion where authoritative constraints exist and a soft buffer preference outside it. Green/commercial/road buffers may be proposed; visual style never overrides health/safety.
- **Owned land:** clip search envelopes to owned polygons and score compact use. A style may shrink, rotate, switch to another allowed motif, or return no valid proposal; it may not build outside ownership.

Style identity survives adaptation through invariants. A terrain-adapted grid still has dominant orthogonal axes and grid hierarchy; an organic plan on flat ground still needs meaningful branching and curvature but may become gentler; waterfront style without a valid water edge is unavailable rather than faked.

## 10. Novelty memory

Novelty memory is separate from narrative `MayorMemory`. It is a constant-size design ledger, updated only after confirmed successful construction.

```ts
interface UrbanDesignMemoryV0 {
  version: 1;
  recent: Array<{                     // ring buffer, newest first, max 8
    districtKey: string;              // stable opaque spatial bucket, no geometry
    tick: number;
    primaryStyle: StyleId;
    secondaryStyle?: StyleId;
    motif: string;
    topology: "grid" | "organic" | "linear" | "node" | "filtered";
    blockBand: "small" | "medium" | "large" | "mixed";
    commercial: "none" | "nodes" | "spine" | "edge" | "core";
    green: "minimal" | "distributed" | "central" | "linear" | "buffer";
    density: DensityIntent;
    signature: string;                // versioned hash of categorical features
  }>;
  rollingCounts: {                    // saturating/decayed counters, fixed keys
    styles: Record<string, number>;
    motifs: Record<string, number>;
    topology: Record<string, number>;
    commercial: Record<string, number>;
    green: Record<string, number>;
    density: Record<string, number>;
  };
  lastDecayTick: number;
}
```

Bounds:

- maximum eight recent signatures;
- only known catalog IDs and finite enums;
- capped string lengths and total serialized size (target 4 KiB, hard limit 8 KiB);
- rolling counters saturate and decay by deterministic epochs instead of appending history;
- no coordinates, proposal bodies, screenshots, chain-of-thought, or full district histories;
- unknown styles from removed packs collapse into an `other` counter while recent entries age out.

The Planner calculates `noveltyDistance` against the ring and adds penalties for repeating the same motif/topology/commercial/green combination nearby or in the last few successful districts. DeepSeek receives a compact summary such as “recent: 3 grid districts; last two used main-street commercial and central green” plus opaque avoid-signatures. It can explicitly continue a coherent motif, request variation, or break it. Novelty is therefore a preference with deliberate override, not a ban that fragments the city.

## 11. Scoring and beauty proxies

### Hard constraints

Hard constraints remain binary and deterministic:

- owned land and unlocked assets;
- current geometry freshness;
- water, slope, collision, building, road, and zoning legality;
- native preview where the current adapter requires it;
- utility/service safety floors and extreme fiscal guardrails already owned by Runtime;
- industrial/residential exclusion where supported by authoritative pollution data;
- candidate conflicts, duplicate roads, dependency validity, and Fast phase limits.

No style, seed, player wording, or DeepSeek preference can weaken these.

### Soft metric vector

The Planner calculates separately:

- road hierarchy coherence;
- connectivity and disconnected-component penalty;
- block-size fit and within-style variation;
- excessive repeated orientation/block/motif penalty;
- dead-end density and useful-vs-decorative dead-end ratio;
- frontage utilization;
- terrain and contour fit;
- shoreline fit and continuity when relevant;
- industrial/residential buffer quality;
- green-space distribution and access proxy;
- access-node/transit-readiness alignment;
- approximate cost, capacity, and land-use efficiency;
- novelty distance from recent design signatures.

Each grammar declares preference weights and acceptable bands, but the output remains a metric vector. Hard-coded global weights must not reduce all styles to the same optimal grid.

### DeepSeek judgment

DeepSeek chooses among safe, materially distinct alternatives based on player intent and city strategy: for example, whether stronger waterfront continuity is worth higher cost, whether a compact center should break recent low-density patterns, or whether cohesion is more important than novelty in an adjacent district. It may explain aesthetic intent in natural language. It cannot assert that a failed metric is legal, edit the score, or select hidden geometry.

## 12. Natural-language player intent

The existing natural-language input remains the interface. The prompt supplies the available style vocabulary and asks DeepSeek to map ordinary wording into intent:

- “给我建一个欧洲风格老城” -> `compact-urban`, civic-square/perimeter-block motif, moderate irregularity.
- “这里做成低密花园社区” -> `garden-neighborhood`, low density, distributed/central green.
- “别再盖方格了” -> exclude/reduce `orthogonal-grid`, novelty `break`, select an available non-grid grammar.
- “沿河做漂亮一点” -> select a waterfront `siteId`, `waterfront-linear`, green/commercial judgment from context.
- “中心城区密一点” -> compact style or influence with high/gradient density at a node/infill site.
- “东京 + 阿姆斯特丹混合” -> map semantic traits to an available primary plus one supported secondary influence; do not pretend v0 includes literal architectural themes or full transit/cycling systems.
- “这一片你自由发挥” -> DeepSeek chooses among available styles using site affordances and novelty summary; seed supplies controlled variation.

If a request asks for a capability outside v0, DeepSeek should preserve the expressible intent and state the limitation. It must not silently encode unsupported architectural assets, detailed parks, or transit networks into guessed actions.

## 13. Fast Mayor integration

UDL plugs into the proven candidate lifecycle:

```text
UrbanDesignIntent
  -> SpatialDesignProposal alternatives
  -> active validated candidate registry
  -> DeepSeek proposal/candidate selection
  -> existing MayorPlan
  -> existing Fast normalization and constructionPhase validation
  -> existing adapter revalidation and Batch
  -> fresh Snapshot
  -> next proposal stage
```

Rules for v0:

- Proposal IDs are descriptive planning handles; only existing candidate IDs authorize execution.
- A proposal can contribute several active candidates if they are independently valid, mutually compatible, affordable, and within the existing Fast cap.
- Existing `conflictGroup` semantics remain authoritative. UDL may add proposal/group metadata but cannot bypass conflicts.
- Dependencies across real mutations are snapshot barriers. A road and zoning that depends on its future frontage cannot be executed in one phase.
- Fast normalization remains unchanged: multiple candidate actions may normalize into the same existing `constructionPhase`.
- Normal mode may select one candidate while preserving the same design intent for later Snapshots.
- If all proposal geometry fails, the Planner publishes no executable candidate and DeepSeek may choose another intent or wait. Runtime does not manufacture an aesthetic fallback.

The first implementation should extend `MayorPlanningCandidate` only with compact optional design metadata such as `proposalId`, `designRole`, `styleId`, and `motifId`. Raw geometry and full score vectors stay outside the model-facing candidate record unless a concise trade-off summary is needed.

## 14. Community Style Packs: future-safe boundary

v0 should load bundled packs through the same interface intended for future community packs, but should not ship a marketplace or third-party loader yet.

A future pack may contain:

- one manifest with ID, version, schema compatibility, authorship, and content hash;
- validated grammar JSON;
- prompt name/summary and semantic tags;
- parameter ranges within engine-wide ceilings;
- motifs composed only from registered operators;
- adaptation, anti-pattern, preference, and mixing data;
- optional static documentation or preview images that are never executable.

A pack may not contain JavaScript, TypeScript, DLLs, shaders, expressions, URLs fetched at runtime, model tools, shell commands, arbitrary file paths, or custom validators. It cannot add a new geometry primitive, action type, native prefab, or hard-constraint override. Unknown fields fail closed. Numeric ranges are clamped to engine limits, references must resolve to allowlisted operators/enums, resource counts are capped, and generation has fixed time/candidate budgets.

New mechanics require a reviewed application release; new combinations of existing trusted mechanics can remain data-driven. This is the security boundary that permits future styles without arbitrary code execution.

## 15. Testing strategy

No live game is required for most UDL verification. Tests should use deterministic synthetic `SiteContext` fixtures and captured, sanitized Snapshot geometry where appropriate.

1. **Same map, different styles:** hold Snapshot/site/seed constant. Assert distinct topology/style signatures and metric profiles, not merely different coordinates.
2. **Same style, different seeds:** assert all outputs retain identity invariants and remain within parameter bounds, while a minimum proportion of signatures/layout metrics differ.
3. **Same style, different terrain:** flat, sloped, constrained, and waterfront fixtures must rotate, clip, curve, shrink, or change allowed motif naturally while preserving style identity.
4. **Sequential districts:** feed successful signatures into memory and assert repeated motif combinations receive a novelty penalty and alternatives change unless intent explicitly says `continue`.
5. **Style mix:** assert primary topology/invariants remain unchanged, only allowlisted dimensions move, and unsupported influence dimensions fail closed with an explanation.
6. **Invalid geometry:** out-of-ownership, water, excessive slope, collisions, stale geometry, duplicate roads, and native-preview failure must remain rejected regardless of style or score.
7. **Bounded memory:** simulate thousands of successful districts; serialized memory, ring length, counter keys, and update time remain bounded and removed style IDs collapse safely.
8. **Fast Mayor:** generate multiple compatible active candidates, ensure they enter the existing registry, preserve conflict groups, normalize/select within the current cap, and require a fresh Snapshot for dependent stages.
9. **Deterministic replay:** same Snapshot revision + intent + grammar versions + seed produces byte-stable proposal IDs/order and equivalent private geometry.
10. **Candidate diversity:** near-duplicate alternatives are collapsed; retained proposals exceed minimum categorical or metric distance.
11. **Grammar validation/security:** malformed packs, unknown operators, excessive ranges/counts, cyclic references, scripts/expressions, and unsupported schema versions fail before generation.
12. **Prompt contract:** natural-language examples parse to legal semantic intents; model-visible payload contains no private coordinates and remains within a fixed byte budget.

Live acceptance should occur only in a later explicitly authorized implementation session after static geometry, schema, safety, and integration tests pass. It should be bounded to a small number of phases and should verify actual visual/topological differentiation, not merely successful execution.

## 16. v0 scope and later boundary

### Required in v0

- the five bundled grammars and strict versioned pack schema;
- one primary plus one bounded secondary influence;
- semantic `UrbanDesignIntent` and deterministic `SiteContext`;
- local-frame, seed-based bounded alternative generation;
- proposal summaries, private geometry, hard validation, metric vectors, and diversity filtering;
- compact novelty memory with deterministic update/decay;
- current candidate registry and Fast Mayor integration;
- natural-language mapping through DeepSeek without coordinates;
- deterministic/security/unit/integration fixtures and telemetry sufficient to reproduce a proposal.

### Explicitly later

- complex highway interchanges and full radial/roundabout systems;
- advanced public transit network routing and scheduling;
- detailed parks, plazas, paths, and park-area tools;
- custom asset selection or downloadable assets;
- architectural themes and building façade control;
- procedural landscaping, trees, props, and terrain sculpting;
- cinematic beautification and camera direction;
- arbitrary user-authored geometry operators or code;
- large style marketplace, discovery, ratings, updates, and dependency resolution;
- more than one secondary influence or free-form style graphs;
- city-wide masterplan optimization over many future construction phases.

v0 should produce recognizable district structure with controlled variation. It should not promise asset-level visual theming or solve every layer of urbanism.

## 17. Implementation phases for Luna

### Phase 0 — contracts and fixtures

Add TypeScript types/Zod schemas for intent, grammar packs, site summaries, proposals, metric vectors, and design memory. Add deterministic fixture snapshots/site contexts and golden replay tests. No Runtime behavior change.

### Phase 1 — trusted grammar engine and bundled packs

Implement the allowlisted operator registry, pack loader, engine-wide bounds, deterministic PRNG, and five bundled JSON grammars. Generate compact prompt cards from validated data. Do not add community loading yet.

### Phase 2 — site analysis and proposal generation

Build private local frames and site affordances from existing Spatial data. Generate bounded alternatives, enforce identity invariants, hard-reject invalid geometry, calculate metric vectors, and remove near-duplicates. Start with road structure plus zoning frontage compatible with current capabilities.

### Phase 3 — model intent and proposal choice

Extend the decision prompt/schema so DeepSeek produces coordinate-free `UrbanDesignIntent` and chooses among proposal summaries. Keep one bounded correction path for invalid semantic intent. Preserve ordinary no-op and existing Mayor strategy.

### Phase 4 — novelty memory

Add the separate ring/counter ledger, success-only updates, deterministic decay, prompt summary, and motif repetition scoring. Prove fixed serialized size under long synthetic runs.

### Phase 5 — existing candidate/Fast integration

Attach optional design metadata to current candidates, publish only active validated stages, preserve the private registry and conflict groups, and feed selections through unchanged Normal/Fast validation and Batch paths. Add snapshot-barrier tests for road-then-zoning proposals.

### Phase 6 — bounded acceptance

After all static tests pass, conduct separately authorized offline visual review and then a short live acceptance across a small style/seed/site matrix. Do not combine this with UI, Style Pack marketplace, transit, asset, or beautification work.

## 18. Architecture acceptance criteria

UDL v0 is architecturally successful when:

- the same style is recognizable across seeds and sites without repeating a blueprint;
- different styles are measurably and visibly structurally different;
- all variability is reproducible from explicit inputs;
- recent district patterns influence but do not dictate future choices;
- natural-language intent maps to typed semantics without player command syntax;
- DeepSeek owns design judgment but never exact geometry or legality;
- Spatial Planner produces only bounded, validated executable candidates;
- Runtime and Fast Mayor reuse their proven execution and safety path unchanged;
- style data is extensible without granting code execution;
- v0 remains limited to district-scale road/zoning structure and does not absorb deferred systems.
