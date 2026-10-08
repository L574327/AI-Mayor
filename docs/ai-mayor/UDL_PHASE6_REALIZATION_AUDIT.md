> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# UDL Phase 6 Realization Architecture Audit

Date: 2026-09-11  
Status: architecture audit baseline; minimal v0 implementation follow-up is tracked in the current status handoff

## Executive conclusion

Phase 6 failed for a precise architectural reason: UDL currently produces a style-specific semantic proposal and planning envelope, but the existing candidate generator receives neither. `realizeUrbanDesignProposal()` passes only ordinary Snapshot/detail/owned-land inputs plus optional candidate metadata into `buildMayorCandidateSet()`. When any safe existing-frontage zoning patch exists, `buildMayorCandidateSet()` fills the registry with zoning candidates and does not call the road-expansion generator. The Phase 6 fixture therefore returned the same Commercial and Residential patches for both styles.

There is also an independent road-side collapse. When road expansion is reached, `findRoadExpansionCandidates()` accepts only an optional source road/entity endpoint. It always continues the source tangent for exactly 80 metres. It has no input for topology, heading tolerance, curvature, hierarchy, block scale, density, frontage target, adaptation hints, grammar parameters or variation seed.

A large procedural geometry rewrite is not required for UDL v0. A bounded preference-aware straight-segment enumerator, plus an explicit infill-versus-expansion policy, is sufficient to make `orthogonal-grid` and `terrain-organic` produce materially different safe road candidates. True curved/spline realization should remain deferred until curve control points are included in native preview and execution revalidation.

## 1. Exact collapse points

The current data flow has three losses:

1. `resolveUrbanDesignIntent()` validates `density`, `developmentEmphasis`, `roadCharacter`, `commercialTendency`, `greenSpaceTendency` and `adaptationPriorities`, but calls `generateUrbanDesignProposal()` with only context, anchor, grammar, preferred motif, secondary influence and seed. The typed intent's expansion/infill choice and requested road character do not survive into the proposal.
2. `generateUrbanDesignProposal()` correctly creates distinct style semantics and sampled grammar parameters. `buildUrbanDesignPlanningEnvelope()` copies a subset into a distinct envelope. However, `realizeUrbanDesignProposal()` calls `buildMayorCandidateSet()` without the envelope or any compiled planner preferences. Only `primaryStyle`, motif and proposal identity are attached as candidate metadata.
3. `buildMayorCandidateSet()` generates zoning patches first. `findRoadExpansionCandidates()` is called only when the registry is empty. If a zoning patch exists anywhere in the candidate set, road generation is suppressed. The UDL fallback with `forceRoadExpansion: true` runs only when anchor-filtered selection is empty; in the Phase 6 fixture, the zoning patch matched the same road anchor, so fallback was never reached.

The exact geometry collapse is therefore the call from `realizeUrbanDesignProposal()` into `buildMayorCandidateSet()`: the style-specific envelope is available but not supplied or consumed. The zoning-first policy then determines the observed zoning-only result.

## 2. Metadata versus geometry-consumed fields

| Field | Current propagation | Current geometry effect |
| --- | --- | --- |
| `topology` | Grammar-derived proposal semantics → envelope | None |
| `preferredHeading` | Derived only from anchor orientation → envelope | None |
| `allowedHeadings` | Exact anchor orientation, or `mixed` → envelope | None; it is not a numerical range |
| `curvature` | Grammar-derived proposal semantics → envelope | None |
| `roadHierarchy` | Proposal → envelope; gives road candidates a small ranking bonus in `scoreCandidate()` | Ranking only, not geometry; irrelevant when zoning suppresses roads |
| `blockScale` | Proposal → envelope `approximateScale` | None |
| `density` | Proposal → capacity estimate and envelope; high/low can rank zoning patch size | Candidate ranking/capacity only, not geometry; `gradient` and `medium` do nothing in the Phase 6 case |
| `frontageTarget` | Derived from SiteContext frontage opportunity band | None; not style-specific in the current implementation |
| `adaptationHints` | Anchor/context → proposal → envelope | None |
| grammar `parameterSample` | Deterministically sampled and stored in proposal | None after proposal creation |
| grammar preference weights / anti-patterns | Loaded and exposed as grammar data | None in realization |
| `primaryStyle`, motif, proposal/group IDs | Copied to candidate `urbanDesign` fields | Metadata only |

The only UDL semantics currently consumed after proposal construction are commercial/density/road-hierarchy values in `scoreCandidate()`. That function can reorder already-generated candidates, but it cannot create a different route, heading, length or curve.

## 3. Why Phase 6 produced zoning candidates only

The fixture contains a real road anchor and 25 safe, visible, unoccupied roadside cells. `findPatches()` therefore creates one existing-frontage patch. `zoneOptions()` exposes Commercial and Residential zone types. Those two patch alternatives populate the registry as `C-10-50-12` and `R-10-50-12`.

Because the registry is non-empty, `buildMayorCandidateSet()` never invokes `findRoadExpansionCandidates()`. `realizeUrbanDesignProposal()` then filters candidates by adjacent/source road. Both zoning candidates match `anchor-road-10-2`, so selection is non-empty and its forced-road fallback does not run.

This behavior is appropriate for routine actionability: existing safe frontage should normally be used before spending money on unnecessary roads. It is not sufficient for a typed spatial-design episode because the generic candidate builder cannot distinguish an infill design from an edge-expansion/new-district design.

## 4. Test issue versus product architecture issue

The Phase 6 fixture is functionally an infill scenario even though its handcrafted SiteContext says `areaClass: edge`: it has abundant safe frontage beside an existing road. It was therefore not a fair road-style acceptance gate. A fair geometry A/B must explicitly request expansion and use an endpoint/gateway/undeveloped-edge source with more than one safe heading option.

The product issue remains real. A live `developmentEmphasis: edge_expansion` intent would still lose that value before proposal generation, and any unrelated or anchor-matching zoning patch could suppress road generation globally. Even with no zoning patch, the current road generator would produce the same fixed 80m tangent continuation for both grammars. Improving only the test would expose, not solve, this architecture gap.

## 5. Minimal planner change

Add two bounded concepts; do not add a second planner:

1. Preserve a typed realization objective from intent into proposal: `infill`, `expand_first`, or `mixed`. It should be derived from the existing `developmentEmphasis`, anchor kind and SiteContext, never from free-text keyword parsing.
2. Compile the UDL planning envelope and sampled grammar parameters into bounded road-expansion preferences consumed by the existing road candidate generator.

The existing generator should enumerate a small fixed set of straight segment alternatives from the resolved source endpoint, filter every alternative through existing deterministic safety, then rank safe alternatives by style preferences. Keep the current global limits (`URBAN_DESIGN_MAX_GEOMETRY_ATTEMPTS`, preview cap and candidate cap).

This change should parameterize the existing `buildMayorCandidateSet()`/registry path. It must not create a UDL-only executor or public raw-coordinate path.

## 6. Required interfaces

Suggested architecture-level contracts:

```ts
type UrbanDesignRealizationMode = "infill" | "expand_first" | "mixed";

interface RoadExpansionPreferences {
  source: RoadExpansionSource;
  seed: string;
  topologyRole: "grid_axis" | "cross_link" | "contour_connector" | "organic_branch";
  preferredHeadingDegrees: number;
  headingOffsetsDegrees: readonly number[];
  headingToleranceDegrees: number;
  targetLengths: readonly number[];
  curvatureMode: "straight" | "bounded_heading_deviation";
  hierarchy: "local_first" | "balanced" | "collector_spine" | "fine_grain";
}

interface UrbanDesignCandidatePolicy {
  mode: UrbanDesignRealizationMode;
  roadExpansion?: RoadExpansionPreferences;
  includeExistingFrontage: boolean;
}
```

`resolveUrbanDesignIntent()` should preserve the existing typed `developmentEmphasis` and variation seed in the proposal or a realization request. A deterministic adapter should compile proposal/envelope values into `RoadExpansionPreferences`. `buildMayorCandidateSet()` should accept `UrbanDesignCandidatePolicy` instead of relying on `registry.size === 0` and the `forceRoadExpansion` boolean.

Candidate summaries should expose bounded, non-executable evidence needed for verification: actual heading, heading delta from source, approximate length, topology role and sampled slope/terrain-fit band. Raw endpoints remain private in the registry. Candidate IDs must include a stable geometry/role discriminator so multiple alternatives from one source do not collide.

## 7. Orthogonal-grid realization rule

For a resolved endpoint, derive the source tangent and the site's dominant road axis. Enumerate a bounded set around:

- straight continuation (`0°` from source tangent);
- near-perpendicular branches (`+90°`, `-90°`) when the endpoint topology permits them;
- small seeded axis jitter bounded by the sampled `axisJitter`, capped to a conservative angle such as 8°.

Use sampled `blockWidth`/`blockDepth` to propose a bounded, sorted set of target lengths rather than the fixed 80m value. Rank safe candidates by axis alignment, near-90-degree relationship to the selected grid axis, straightness, useful frontage and terrain feasibility. The style may choose among safe candidates; it may not weaken slope, ownership, water, collision or duplicate checks.

## 8. Terrain-organic realization rule

From the same resolved endpoint, enumerate bounded non-orthogonal heading offsets around the source tangent, for example `0°`, `±15°`, `±30°` and `±45°`, with stable seed ordering. Sample terrain along each proposed straight segment and rank candidates by lower cross-slope/height variation, water/building clearance and continuity with a small number of legible connectors.

Use sampled `branchCadence` as the bounded target-length source and label the result as `contour_connector` or `organic_branch`. For v0, `high` curvature means a preference for bounded heading deviation across successive safe segments; it must not claim a true spline. The current action type permits optional control points, but the native preflight call currently validates only endpoints. Curve control points must remain unused until preview and revalidation cover the complete curved geometry.

## 9. Safety boundary

Style preferences are soft ranking inputs after hard rejection. Every generated alternative must continue through:

1. resolved real road source and endpoint;
2. owned-land containment, including sampled interior points rather than endpoint-only acceptance;
3. dry-land/water rejection;
4. bounded slope and terrain sampling;
5. building and road collision clearance;
6. duplicate/near-duplicate road rejection;
7. private candidate registry and conflict groups;
8. native preview before publication/execution;
9. stale registry lookup and fresh native preview immediately before execution;
10. existing Batch execution and CS2 readback.

No grammar, seed, style score or realization mode may bypass a failed hard check. If all preferred candidates fail, realization returns `no_realization`; it must not silently fall back to unsafe geometry.

## 10. Fair Phase 6 A/B test design

The deterministic gate should use the same immutable Snapshot, SiteContext, detail, owned tiles and one expansion-class source anchor for both styles. Previewing both alternatives against the same unchanged world is fairer than executing A before generating B. The site must have no test-only coordinates and must offer at least two deterministically discovered safe heading choices; otherwise report an environmental limitation.

Test setup:

1. Select a real `gateway`, `road_endpoint`, or `undeveloped_edge` anchor with typed `expand_first` policy.
2. Use fixed recorded seeds and generate `orthogonal-grid` and `terrain-organic` proposals through the same UDL/Spatial Planner entrypoint.
3. Require at least one road candidate from each realization and require both to pass the existing native preview gate.
4. Compare private realized actions and public structural summaries before executing either.
5. Optionally execute at most one candidate per style only on equivalent independent anchors or reset-equivalent saves, then verify road graph/readback. Execution is not needed to prove deterministic geometry difference if both native previews pass.

Material difference must include non-identical endpoints and at least one structural discriminator, such as:

- selected heading delta of at least 15°;
- grid axis/perpendicular alignment error versus contour-following terrain score;
- target segment-length difference of at least 20%;
- distinct `grid_axis`/`cross_link` versus `contour_connector`/`organic_branch` role;
- a different safe branch orientation or, after curve-aware preview exists, a different validated curvature/control point.

Motif/style IDs and envelope strings alone are insufficient. If hard safety leaves only one feasible segment and both styles converge, the gate must report an environmental limitation rather than fail the architecture globally.

## 11. Luna implementation plan

Implement in small checkpoints:

1. Add tests proving the current typed `developmentEmphasis` loss and define the `infill`/`expand_first`/`mixed` policy contract.
2. Preserve realization mode and variation seed across intent resolution without changing model prompts or grammar rules.
3. Add the bounded `RoadExpansionPreferences` compiler from proposal/envelope/anchor; unit-test fixed seeds and ordering.
4. Parameterize the existing road-expansion generator to enumerate safe straight headings and lengths. Keep its current registry ownership and candidate caps.
5. Replace implicit `registry.size === 0` precedence with the explicit policy: infill may omit roads, expand-first must generate roads even when frontage exists, and mixed may expose both under separate conflict groups.
6. Add deterministic orthogonal-versus-organic geometry tests on an expansion fixture, then targeted native-preview integration tests.
7. Run one bounded Phase 6 live A/B only after static geometry differs and both candidates pass preview. Use zero DeepSeek calls and no zoning/simulation wait.

Each checkpoint should run targeted Jest, affected TypeScript, targeted Biome and `git diff --check`. Do not begin Local Mayor Engine or broaden UDL.

## 12. Geometry rewrite decision

No large geometry rewrite is needed for the minimum v0 acceptance. The current source resolution, private registry, straight `build_road` action, deterministic terrain/detail inputs, native preview and execution path are reusable. The missing primitive is a bounded preference-aware road-option enumerator plus an explicit realization policy.

A later true curved-road or multi-segment district grammar would need a curve/polyline candidate primitive whose complete geometry is covered by preview, registry identity, conflict checks and execution-time revalidation. That is outside Phase 6 minimal scope and should not be smuggled into this fix.
