> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# UDL Road Candidate Rejection Audit

Date: 2026-09-11

## Conclusion

The latest live evidence proves a pre-native-preview rejection, but it does not contain per-attempt geometry or gate telemetry. Therefore the dominant cause cannot be honestly classified as ownership, water, slope, building collision, duplicate road, source direction, or preference range from that evidence alone.

What is proven:

- canonical source pinning succeeded for node `343035:1` and edges `73600:1`, `73605:1`, `73606:1`, `73607:1`;
- the existing bounded style-aware expansion path was reached;
- both styles returned `no_valid_road_candidate` with zero candidate IDs;
- native preview was not reached;
- the city was not mutated.

The old existing-candidate gate is not involved anymore.

## Exact bounded attempt plan

The live evidence records the ordered source list but not the proposal parameter sample or generated endpoints. From the current code, the finite attempt plan is:

| Style | Source order | Heading offsets | Target lengths | Tolerance | Attempts |
|---|---|---:|---:|---:|---:|
| orthogonal-grid | 73600, 73605, 73606, 73607 | `0, 90, -90` | one clamped `blockDepth` | 8° | 12 |
| terrain-organic | 73600, 73605, 73606, 73607 | `0, 15, -15, 30, -30` | one clamped `branchCadence` | 45° | 20 |

For every source, `findRoadExpansionCandidates()` derives the expansion start from the canonical endpoint, derives the source tangent direction, selects the preferred equivalent heading, adds deterministic seed jitter, and constructs a straight endpoint at the bounded target length. The central-node relation order is preserved; the realization fallback is capped to four sources.

The current `live-ab.json` cannot report the numeric headings, lengths or endpoints because the harness only persisted the final realization result. No such values are invented here.

## Current rejection gates

The existing generator evaluates the following gates, without safety changes:

1. source segment length must be valid;
2. endpoint must be inside owned land;
3. endpoint water depth must be zero;
4. endpoint slope ratio must be at most `0.2`;
5. endpoint must be at least 28m from every building;
6. endpoint must be at least 18m from every existing road;
7. every intermediate sample must remain owned, dry, slope-safe, building-clear and road-clear.

Only after these checks does the road enter the candidate registry. Native preview is a later adapter gate and was not reached in the live run. Thus the evidence does not support a registry/conflict or native-preview root cause.

## Gateway comparison

The known successful Phase 5B path used gateway anchor `anchor-gateway-road-47519:1` and produced `E-73629-1-north`. Its live evidence proves one source/endpoint path passed planning, native preview, execution and readback. The current central-node path differs in three relevant ways:

- it is an interior degree-4 node rather than a gateway/frontier relation;
- it offers four incident endpoint sources rather than one preferred gateway source;
- the current live evidence does not establish that any of those endpoints points into a buildable expansion frontier.

This makes a site-semantic explanation plausible, but not proven. The source-direction code is deterministic and finite; no arbitrary first-edge or fuzzy fallback is used.

## Observability change

The generator now optionally records a bounded `roadExpansionDiagnostics` list containing source edge, start/end, heading, offset, target length, outcome and the existing rejection category. Categories are limited to:

- `invalid_source_geometry`
- `outside_owned_land`
- `water`
- `slope`
- `building_collision`
- `duplicate_road`

This is diagnostic plumbing only. It does not alter candidate acceptance, safety thresholds, native preview, registry behavior, or the external `no_valid_road_candidate` taxonomy. The bound is 72 records, matching the maximum four-source × six-offset × three-length planner envelope.

## Classification and recommendation

Current classification: **pre-native bounded geometry/safety rejection; dominant gate unknown**.

It is not currently justified to call this a geometry bug, source bug, style-range bug, or registry bug. The central node may simply be an interior junction unsuitable for outward expansion, while the alternative is that all bounded style directions miss the local safe envelope. The new diagnostics are required to distinguish those cases.

Recommended next action: on a separately authorized future live run, prefer a real `undeveloped_edge` or `road_endpoint` expansion frontier and retain the diagnostic output; do not relax safety or redesign geometry based on the current evidence.

