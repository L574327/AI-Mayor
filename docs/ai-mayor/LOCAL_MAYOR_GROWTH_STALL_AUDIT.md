> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# Local Mayor Early-City Growth Stall Audit

> **STATUS: LEGACY / HISTORICAL V1 AUDIT (2026-09-12).** This report is preserved as regression and failure evidence. It is not an active 125→500 milestone or V2 planning directive; see [V2_ARCHITECTURE_BASELINE.md](V2_ARCHITECTURE_BASELINE.md).

Date: 2026-09-11  
Scope: read-only code and live-world audit; no construction, provider request, safety change, or product implementation.

## Executive conclusion

**CURRENT STALL IS PRIMARILY: multiple interacting causes, led by a Local Mayor integration/growth-policy gap.**

The city does not lack owned land. The planner can see a large owned footprint and real frontier sources. The principal failure is that Local Mayor has no durable development-reserve objective and no frontier-aware growth-opportunity request. Its “refresh” only reruns the ordinary candidate catalog. When ordinary zoning patches are consumed and the compact legacy road fallback cannot publish one of its fixed tangent attempts, refresh deterministically returns the same empty supply.

The capacity model compounds the problem: unless an external `developmentCapacity` object happens to be present, Local Mayor treats currently offered candidate cells as pending development capacity. It does not count already-zoned but not-yet-developed cells. It can therefore neither distinguish “capacity exists; digest it” from “frontage is exhausted; create more” nor maintain a bounded reserve.

Demand is not the immediate cause of the recorded `55–62` industrial stall because the refresh threshold is `50`, so refresh did run. It is nevertheless modeled too much like permission: no reserve goal exists below the growth-goal thresholds, and the industrial goal itself appears only at `60`. In an early city, demand should choose mix and pace, while healthy finance/utilities plus a low development reserve should remain sufficient to create bounded actionability.

## Evidence boundary and live revision

The previously recorded stall revision was approximately population `80–82`, treasury `2.013M`, commercial demand `0`, industrial demand `55–62`, and candidate supply `0 -> 0`. The city currently loaded for this audit is the same named city but a different revision: `2026-01-06 10:13`, population `84`, treasury `1,949,246`, monthly balance `-8,847`, commercial demand `100`, industrial demand `65`, and healthy utilities. The audit does not pretend these are one exact Snapshot.

That revision difference is useful evidence. The current revision exposes the same map/road lineage before the candidate supply is exhausted and proves that owned-land scanning, zoning-cell visibility, native road construction validation, and the base candidate generator can all work. The prior JSONL proves that the later revision reached an empty catalog and stayed there. No automatic save loading was used to reconstruct the later revision.

The game was paused before Spatial reads and remained paused after all native previews. Native previews returned `previewOnly=true` and did not commit construction.

## 1. Current live world facts

| Fact | Authoritative live value |
| --- | ---: |
| City | 法兰克福广场 |
| Game time | 2026-01-06 10:13 |
| Population | 84 |
| Treasury / monthly balance | 1,949,246 / -8,847 |
| Demand | residential high 0; commercial 100; industrial 65; office 100 |
| Utilities | electricity 1,474/7,175 fulfilled; water 165/10,000; sewage 165/100,000 |
| Map tiles | 529 total; 9 owned |
| Approximate owned polygon area | 3,496,575 m² (3.50 km²) |
| Road graph | 241 nodes; 246 edges; 230 native; 16 player |
| Terrain query | center (-603.44, -188.75), radius 529m |
| Terrain | rolling/rough; mean sampled slope 7.3%; max 40.2%; no sampled water opportunity |

The live SiteContext reports `areaBand=large`, a moderate owned boundary, and 269 available roadside cells. Its `buildableCoverage=0.078` is **not total buildable land coverage**; it is the ratio of currently available roadside zoning cells to all zoning cells in the detail window. It must not be interpreted as “only 7.8% of owned land is buildable.”

All 2,887 visible zoning cells in the queried urban window are inside owned land. The visual empty surroundings are therefore not being rejected as universally unowned. No road attempt in the live default or alternate envelopes failed ownership or water.

## 2. Current frontier inventory

The Spatial world model found 20 bounded ingress/connection candidates and 3 owned endpoint nodes. SiteContext projected 8 planning anchors:

- 4 `gateway`
- 3 `undeveloped_edge`
- 1 `central_node`
- 0 `road_endpoint` because the three endpoint nodes also had available frontage and were classified as `undeveloped_edge`

The three undeveloped-edge anchors have authoritative canonical graph sources on road edges `73594:1`, `73599:1`, and `73606:1`, each with an endpoint role. The central node carries four incident road identities. This is enough frontier inventory for bounded expansion planning.

The ordinary Snapshot catalog is a different source set: MCP returns only the last 8 roads from `/city/roads?query=Road&limit=100`. In this live revision those are edges `73622:1` through `73629:1`. The legacy generator loops those compact road records, starts from `anchor.end`, and assumes that end is a usable connected endpoint. It does not consume SiteContext’s endpoint inventory or canonical endpoint role. UDL realization explicitly pins a selected canonical graph source into the compact catalog; ordinary Local Mayor refresh does not.

## 3. End-to-end growth pipeline

| Layer | Input → output | Bound/gate | Empty/failure behavior |
| --- | --- | --- | --- |
| Snapshot | city/economy/demand/catalog reads → schema 1.1 facts and last 8 road anchors | compact catalogs | missing source becomes unavailable/empty |
| Spatial scan/model | all tiles, road graph, outside links → owned tiles, graph, ingress/frontier sources | road limit 2,000; fail if truncated | throws/fails closed |
| Spatial detail/SiteContext | query around compact anchors → terrain, buildings, zoning, semantic anchors | radius 128–2,048; 24-resolution adapter detail; 8 planning anchors | unavailable context, no invented facts |
| Zoning generator | visible roadside cells near Snapshot road anchors → up to 3 non-overlapping patches, then land-use variants | radii 32/24/16; minimum 8 cells; every affected cell must be owned, visible, unoccupied, unblocked, non-overridden and unzoned | zero patches |
| Legacy road fallback | runs only when zoning registry is empty → up to 3 roads | last 8 Snapshot roads; `anchor.end`; tangent offset 0; length 80m | geometry rejections, then native preview can remove all |
| UDL/Sustainable route | selected semantic/canonical anchor → pinned source, policy/preferences, same generator/registry | bounded headings, length, attempts, native preview | explicit no-realization/constraints |
| Registry/execution | public candidate IDs → private geometry → revalidation/native Batch | candidate ID, conflict group, native preview | stale/rejected without bypass |
| LocalMayorState | actionable catalog + finance/demand/utilities → goals/actions/scores | 6 zoning + 3 roads; bounded history/cooldown | wait/replan/blocked |
| Local Runtime | Snapshot → optional same-adapter refresh → Local decision → execute/simulate | refresh key/backoff; single flight | sticky no-safe-actionability |

The safety and execution half of this chain is sound. The break is between available spatial frontier facts and the Local Mayor’s ability to request a suitable growth opportunity after the ordinary catalog is exhausted.

## 4. Road candidate failure breakdown

### Current legacy envelope

The exact ordinary geometry envelope is one 80m straight tangent from `anchor.end` for each of the 8 compact Snapshot roads. Read-only diagnostics produced:

| Outcome | Attempts |
| --- | ---: |
| Accepted by deterministic geometry | 4 |
| Building collision | 2 |
| Duplicate road | 2 |
| Outside owned land | 0 |
| Water | 0 |
| Slope | 0 |

The registry published three of the accepted roads. All three passed the game’s native net preview with `previewOnly=true`:

- `E-73627-1-north-80-0`, Medium Road
- `E-73623-1-west-80-0`, Small Road
- `E-73624-1-north-80-0`, Medium Road

Thus the current loaded revision does **not** reproduce zero road candidates. It also disproves “the entire settlement is boxed in by ownership/water.”

### Search-envelope audit

A read-only bounded diagnostic used the existing candidate generator with richer existing policy inputs:

- 60/80/100m, six bounded headings: 144 attempts; 23 deterministic accepts; dominant rejects were duplicate 70, building collision 26, and slope 25. The first three published candidates all passed native preview.
- 180m, six bounded headings: 48 attempts; 22 deterministic accepts; 14 building collisions and 12 duplicates. The first three published candidates all passed native preview.

Road length is therefore not the primary current failure. Both fine-grain and 180m roads can be legal. The fragile part is the **source/heading search envelope**: ordinary Local supply tries only one endpoint assumption and one tangent per compact road, while the frontier-aware paths know canonical endpoint roles and can try bounded alternatives. As the small network is consumed, duplicate/collision rejection can eliminate every one-shot tangent even when another safe direction exists.

The earlier zero-road Snapshot reached the native-preview-filtered empty catalog, but its evidence did not retain per-attempt rejection details. The architecture and current diagnostics identify the mechanism; they do not invent an exact numerical rejection histogram for that older revision.

## 5. Zoning candidate failure breakdown

Current Spatial detail contains:

| Zoning-cell fact | Count |
| --- | ---: |
| Total / visible | 3,463 / 2,887 |
| Visible roadside | 497 |
| Safe unzoned | 1,495 |
| Safe unzoned roadside | 269 |
| Zoned | 1,035 |
| Zoned and unoccupied | 148 |
| Zoned and occupied | 887 |
| Blocked / overridden | 0 / 20 |

The existing generator found many valid seeds on all 8 compact road anchors and published three non-overlapping patches of approximately 58, 49 and 28 cells. With the available zone catalog this became 9 public Residential/Commercial/Industrial candidates. Therefore zoning discovery is functional in this revision and the owned scanner is not hiding nearby frontage.

The later stalled revision followed a long run containing 19 zoning candidate selections and 5 road selections. Its zero-zoning result means no patch survived the generator’s exact rules at that later world state. The most supported explanation is consumed/painted frontage: zoning actions remove cells from the `zoneType===0` set, and occupied/zoned cells poison any circular patch whose affected set is not entirely safe. Residual narrow pockets can also be lost because the patch requires at least 8 cells and rejects the whole circle when any affected visible cell is zoned, occupied, blocked, overridden, or outside owned land.

That strict all-cells-safe rule is a secondary utilization constraint, not the primary product stall. Even perfect residual infill cannot grow beyond existing frontage. The required next step after frontage exhaustion is frontier-aware road creation.

## 6. Bootstrap and Sustainable Expansion versus Local Mayor

### Bootstrap

Bootstrap starts from the full Spatial road graph and owned polygons, discovers native terminal/owned gateway sources, evaluates sampled starter layouts over terrain/ownership/buildings, and preflights every road segment. It can create a complete initial road and zoning substrate because its product contract explicitly says “create a settlement from no development.”

Reusable Bootstrap primitives are the authoritative owned-area model, graph endpoint/gateway discovery, sampled layout diagnostics, and native preflight discipline. Its full starter-grid, utility placement, pristine-city guards, and executor sequence should not be imported into an ongoing Mayor loop.

### Sustainable Expansion / Fast / DeepSeek

The proven Sustainable Expansion sequence was `0 zoning → validated road candidate → execute road → fresh Snapshot → zoning candidate → execute zoning → development`. Its key strength was not the provider: it exercised the existing candidate registry, road fallback, fresh Snapshot, zoning regeneration, revalidation and simulation lifecycle. DeepSeek/Fast could also emit an Urban Design intent, which routes through `realizeUrbanDesignIntent`, selected SiteContext anchors, canonical-source pinning, and bounded policy/preferences before returning IDs to the same registry.

Fast Mayor changes batching/normalization, not candidate supply. DeepSeek can choose strategy and UDL intent; Local mode deliberately cannot call a provider.

### Local Mayor

Local Mayor is currently a capable **consumer and scorer of the ordinary actionable catalog**, plus a bounded request to rerun that same catalog. It does not invoke `realizeUrbanDesignIntent`, choose a SiteContext frontier anchor, pin a canonical road source, or request `expand_first/mixed` candidate policy. Its refresh is fresh data, not a stronger growth-opportunity primitive.

Therefore the answer to “can Local Mayor create actionability?” is: **only indirectly when the ordinary legacy fallback happens to produce it. It cannot deliberately create a frontier-aware opportunity when that fallback is exhausted.**

## 7. Development capacity and demand gating

`compileLocalMayorState` calculates fallback pending zoning capacity by summing `approximateCells` on currently offered zoning candidates, and frontage capacity by summing currently offered road candidates. Those are opportunities not yet taken, not the city’s already-created development reserve. The main adapter does not currently project authoritative `developmentCapacity`, so the fallback usually controls.

This creates two symmetric errors:

1. Existing zoned-but-unoccupied capacity can be reported as zero once it is no longer an unzoned candidate.
2. Multiple land-use variants for the same conflict-group patch can be summed as if they were independent capacity.

Current live evidence contains 148 zoned/unoccupied cells, but the fallback model cannot use that fact. This is the strongest direct evidence for missing development-capacity awareness.

Demand is also split inconsistently: zoning options use the maximum of residential low/medium/high demand, while LocalMayorState takes `high ?? medium ?? low`, so `high=0` masks lower-density demand values of 100. The exact industrial stall still passed the refresh gate (`55–62 >= 50`), so lowering a threshold would not solve it. A proper reserve goal should decouple permission to maintain capacity from the current demand meter, while demand selects land-use mix and scales urgency.

## 8. Root-cause classification

Primary cause:

- **Local Mayor integration/growth-policy issue.** No explicit development-reserve goal and no frontier-aware `ensure growth opportunity` path. Empty-supply refresh repeats the same legacy catalog.

Secondary interacting causes:

- **Development-capacity measurement gap.** Existing zoned/unoccupied capacity is absent; mutually exclusive candidate variants are overcounted.
- **Legacy source/search-envelope fragility.** Last-eight-road catalog, unconditional `anchor.end`, one heading and one 80m length do not represent authoritative frontier inventory.
- **Residual zoning utilization.** Whole-circle all-safe/minimum-8/non-overlap rules can strand small usable pockets after repeated zoning.
- **Demand semantics inconsistency.** Demand is too close to an absolute growth gate, and residential demand aggregation differs between candidate generation and LocalMayorState.

Not primary:

- Genuinely no owned/buildable land.
- Ownership, water, slope, collision, duplicate, native preview, or execution-time revalidation safety rules.
- 180m roads being universally too long. The current world accepted both 60–100m and 180m preview-only candidates.

## 9. Minimal architecture fix

No large rewrite is required. Add one bounded capability to the existing pipeline and correct the capacity facts:

1. Project a compact `DevelopmentCapacityFacts` from existing Spatial detail: zoned-but-unoccupied cells, safe unzoned roadside cells, and bounded authoritative frontier count. Keep unknowns explicit and avoid predicted population yield.
2. Add a Local-only strategic goal such as `maintain_development_reserve`. It activates when utilities and runway are healthy and the reserve is low; it is city-stage/state driven rather than a hard population threshold.
3. Add one adapter port such as `ensureGrowthOpportunity(request)` implemented inside the existing main adapter. It reuses the current `latestSpatial`, planning anchors, canonical-source pinning, `buildMayorCandidateSet`, registry, diagnostics, and native preview. It is not a second generator or executor.
4. Rank real `undeveloped_edge`/`road_endpoint` sources deterministically, then request a neutral bounded fine-grain road envelope (for example up to three lengths in the 60–100m range and a small allowlisted heading set). Keep current hard gates unchanged.
5. Publish only native-preview-valid IDs into the existing registry. A fresh Snapshot after execution must remain the only way to discover new frontage/zoning.

The state machine becomes:

`measure reserve → digest if adequate → zone safe existing frontage if reserve low → ensure frontier opportunity if frontage exhausted → execute one registry candidate → fresh Snapshot → zone new frontage → observe development`.

## 10. Existing proven primitives to reuse

- `buildSpatialWorldModel`: owned tiles, graph, ingress/frontier discovery.
- `buildUrbanSiteContext` and `buildUrbanPlanningAnchors`: bounded real frontier inventory.
- `pinCanonicalRoadAnchors`: bridge a selected graph source into the compact candidate catalog without arbitrary coordinates in Local state.
- `buildMayorCandidateSet`: sole zoning/road generator and registry owner.
- `RoadExpansionPreferences` and existing UDL realization bounds: bounded heading/length/topology inputs; reuse the mechanism without adding an LLM or changing frozen UDL semantics.
- Main-adapter native preview and execution-time revalidation.
- Sustainable Expansion lifecycle: road → fresh Snapshot → zoning → simulation/readback.
- Bootstrap site diagnostics only where useful for source ranking and explainability, not its settlement executor.

## 11. Early-growth/development-reserve recommendation

Represent reserve as bands (`empty`, `low`, `adequate`, `digesting`, `unavailable`) derived from observed zoned/unoccupied cells and safe frontage, with a bounded recent-consumption signal if available. The target should scale within a small cap using city extent and recent digestion, not a fixed “population below N” rule and not a fabricated population forecast.

Policy:

- adequate zoned reserve → simulate/observe;
- low zoned reserve but safe unzoned frontage → zone according to demand mix;
- low reserve and exhausted frontage → request one frontier-aware road opportunity;
- no safe preview after bounded search → sticky blocked/backoff with diagnostics;
- finance or utility pressure → lower reserve urgency naturally;
- demand changes → alter Industrial/Residential/Commercial allocation and pace, not erase the ability to maintain a small reserve.

## 12. What not to change

- Do not weaken ownership, water, slope, building collision, duplicate-road, native preview, registry identity, revalidation, or player/world-change yielding.
- Do not add arbitrary coordinates to LocalMayorState or Overlay.
- Do not create a Local-only road generator, executor, or planner registry.
- Do not solve this by lowering demand thresholds, forcing a build every N seconds, increasing simulation speed, or expanding candidate caps without evidence.
- Do not import Bootstrap’s utility/service system or reset logic into ongoing city management.
- Do not require DeepSeek, Fast mode, or an API call to escape candidate starvation.
- Do not change frozen UDL product semantics; only reuse its already-existing bounded planner inputs and canonical-source bridge.

## 13. Exact Luna implementation plan

1. Add regression fixtures for the recorded stall: tiny city, healthy utilities/runway, industrial 55–62, empty ordinary registry, real frontier anchors, and both low-reserve and adequate-reserve variants.
2. Extend the existing main-adapter Snapshot projection with typed bounded capacity facts computed from current Spatial zoning cells. Deduplicate capacity by physical cells/conflict group; do not sum Residential/Commercial/Industrial variants.
3. Update `compileLocalMayorState` to consume those facts and retain `unknown` when detail is unavailable. Align residential demand aggregation with the candidate-demand representation.
4. Add `maintain_development_reserve` to existing Local goals/scoring. Demand remains a mix/pace input; finance and utility pressure can suppress it.
5. Add the bounded `ensureGrowthOpportunity` runtime port. Trigger only when reserve is low, safe existing frontage is insufficient, ordinary supply is empty, and backoff/world-key rules allow it.
6. In the main adapter, rank existing planning anchors, pin one canonical source, call the existing candidate builder with `forceRoadExpansion`/bounded policy preferences, run native previews, and publish accepted IDs into the existing registry. Try a bounded number of sources/envelopes and return structured failure counts.
7. After a road success, require the existing post-action fresh Snapshot. Prefer newly exposed zoning candidates before requesting another road. Preserve exact-target cooldown and no-material-impact semantics.
8. Add tests for reserve digestion, frontier exhaustion, canonical endpoint selection, 60/80/100m bounded alternatives, all-safety-rejected blocked behavior, demand jitter, finance/utility suppression, no road/zoning spam, zero provider calls, and unchanged DeepSeek/Fast/Sustainable/UDL behavior.
9. Run 50-episode early-growth and no-actionability simulations. Then perform one read-only live candidate audit on the stalled revision if the user loads it, followed by a separately authorized bounded construction smoke.

## 14. Expected product behavior after the fix

In a tiny healthy city, Local Mayor first recognizes already-created development reserve. If capacity is adequate, it explains that it is waiting for buildings. If capacity is low but current roads have safe frontage, it zones an appropriate bounded patch. If frontage is exhausted, it asks the existing Spatial Planner for a real frontier-aware opportunity, receives only native-preview-valid candidate IDs, builds one road, refreshes the world, and zones the resulting frontage. Demand controls whether that frontage becomes industrial, residential, or commercial and how urgently the cycle repeats.

The visible rhythm becomes `build → digest → build`, while a genuinely constrained city remains safely blocked with specific diagnostics. The player no longer sees “no safe expansion position” merely because Local Mayor reran a passive catalog that lacked the richer frontier path already present elsewhere in the architecture.
