# AI Mayor V2 — Canonical Architecture Baseline

> **DOCUMENT STATUS — CURRENT ARCHITECTURE AUTHORITY:** This file answers how V2 works. Product purpose belongs in `PRODUCT_NORTH_STAR.md`; implementation progress belongs in `IMPLEMENTATION_STATUS.md`; session handoff belongs in `NEXT_SESSION.md`.

## Minimum Local V2 greenfield utility bootstrap (2026-09-15)

The zero-utility product path now inserts a provider-free supply bootstrap between authoritative ROAD delivery and residential ZONING. It reuses the existing deterministic Bootstrap utility planner and shared UtilityProvision execution method, but anchors utility connections only to authoritative existing player roads. Each electricity, water and sewage proposal is bounded to one attempt and follows `UtilityProvision Method -> Proposal -> Admission -> native object/net primitives -> authoritative effect observation`.

Supply bootstrap has four separate boundaries: facility identity (`PLACED`), connector attachment (`CONNECTED`), positive operating capacity (`OPERATING`), and `SERVICE_CERTIFIED`. A placed facility, warning change, `improving`, zero capacity, missing connector, or UNKNOWN observation cannot certify service. Existing same-kind starter facilities are reused rather than blindly duplicated. This supply-side certificate does not replace the later building-local `ACTUAL_CONSUMER_SERVICE` Gate 1 requirement.

## Gate 1 utility contract resolution (2026-09-13)

The impossible pre-zoning building-consumer gate is removed. The minimum starter path now uses exact zoning after ROAD, waits for a tranche-attributed residential building, and then requires Batch 2 `ACTUAL_CONSUMER_SERVICE` for the exact attributed building refs before occupancy success. `PRE_ZONING_SERVICEABILITY`, global surplus, nearby service, and proximity cannot satisfy that gate. The state schema is `ai-mayor-v2-gate1-state/2`; UNKNOWN fails closed and delivery remains separate from effect. Full rationale: [V2_UTILITY_CONNECTION_STATE_CONTRACT.md](V2_UTILITY_CONNECTION_STATE_CONTRACT.md).

## Gate 1 minimum vertical slice implementation (2026-09-13)

Gate 1 now has a production state model and deterministic executable workflow for exactly one bounded residential starter project. The path is `CityIntent -> DevelopmentProject -> District/DistrictPlan/Tranche -> Executive -> bounded SkillProposal -> Gate 1 Admission -> existing ROAD/ZONING Kernel -> observation/effect state`. It does not use the Local Mayor v1 planning brain.

The tranche advances through `PLANNED`, `SITE_SELECTED`, `ROAD_DELIVERED`, `ZONED_WAITING_FOR_BUILDING`, `BUILDING_OBSERVED`, and `WAITING_FOR_OCCUPANCY`. The exact attributed building must pass building-local access/frontage and `ACTUAL_CONSUMER_SERVICE` before occupancy can succeed. Delivery completion remains separate from effect completion: exact zoning delivery advances `delivery_progress`, but only observed attributed residential buildings with actual residents can set `effect_progress=OCCUPIED`. Bounded known-zero waits enter `DIAGNOSING`; UNKNOWN fails closed; recovery is capped at one in-reservation attempt.

Batch 5 durability now stores the current Gate 1 project state and checkpoint-specific project state instead of only a placeholder, while retaining backward compatibility with placeholder documents. Static verification is `30 suites / 417 tests PASS`; production build PASS; CS2/runtime work and gameplay mutations were `0`. Raw evidence: `docs/ai-mayor/evidence/gate1-schema2-runtime-certification-2026-09-13.md`.

`Foundation = CLOSED`. No Foundation Batch 6 was created. The next step is bounded disposable-save Gate 1 runtime certification, not Skill Library expansion or a long-running Agent loop.

## Batch 5 durability addendum (2026-09-13)

Foundation Batch 5 is statically implemented and awaits bounded runtime certification after a mandatory manual CS2 restart. The production durability boundary is now:

- `WorldIdentity = cs2-session:{native SaveInfo.sessionGuid}`. The native session GUID is retained by `LoadGame` and regenerated for `NewGame`; city name, frame, and wall clock are not identity inputs.
- `CheckpointIdentity = save:{SaveGameMetadata asset GUID}:{SaveGameData asset GUID}`. This distinguishes save branches/checkpoints within one world lineage.
- `WorldEpoch = WorldIdentity + Bridge-observed load generation GUID`. A Bridge reconnect without a world load retains the generation; each completed load/new-game transition creates a new generation.
- A save is durable only when the asynchronous native task succeeds and both metadata/data asset identities can be resolved. Submission alone is not a checkpoint.
- A loaded world is ready only when game mode is `Game`, loading is false, a city is loaded, native session identity exists, and Bridge generation identity exists. `LoadGame` additionally requires an exact checkpoint identity.
- The bounded durable state contains identity, checkpoint metadata, a project-state placeholder, journal position, command scope/reconciliation key, and terminal/uncertain outcome metadata. It does not contain a world snapshot, transient ECS `Temp`, observations, or planner scratch state.
- Outcomes are `SUBMITTED`, `APPLIED`, `OBSERVED_MATCH`, `FAILED`, and `UNKNOWN`. `SUBMITTED`/`UNKNOWN` are quarantined after restart and must be reconciled from exact world observation before another write. They are never silently converted to failure or replayed.
- Same-world reconnect resumes; same-save reload recovers and reconciles; known different-save selection uses that checkpoint's journal position; different world/new game does not inherit unrelated commands; unknown identity/checkpoint fails closed.
- Within one unchanged world epoch, a newly completed save becomes the coordinator's current checkpoint even though native load context still names the generation's original load checkpoint; a true reload changes generation and rebinds from native identity.

Reliability boundary: native session identity represents a world lineage, not one immutable save file. Exact save metadata/data asset IDs provide checkpoint identity. Save duplication/export behavior and unusual modded load paths remain runtime-certification concerns, so unrecognized checkpoints in a known lineage are quarantined rather than guessed.

After Batch 5 runtime certification, V2 Foundation closes. The next phase is Gate 1 Agent / Skill integration; no new Foundation batch is permitted unless a real Agent runtime failure proves a missing lower-level capability.

### Batch 5 runtime closure (2026-09-13)

Runtime certified: `YES`. The exact certification save reloaded with the same native world ID and exact metadata/data checkpoint ID, while Bridge load generation changed from `1018722b268e44aea336491478653bc4` to `aebdc24f795d41b7acbcaa0dc47e7250`; classification was `SAME_SAVE_RELOAD`. Durable checkpoint/journal metadata survived, no Bridge world-write redispatch occurred, and gameplay mutations were `0`. `Batch 5 = CLOSED`; `Foundation = CLOSED`; no Foundation Batch 6.

Status: `MOSTLY CONVERGED`  
Effective: 2026-09-12  
Authority: active V2 project-state baseline.

## Final Product North Star

Low-frequency Cloud AI + high-frequency 0-token Local Expert Mayor + 0-token Manual Rescue / Control Plane.

The final acceptance target is greenfield → autonomous city development → around 50,000 population → long unattended endurance, while validating finance, utilities, housing/jobs, zoning efficiency, traffic, services, pollution, spatial quality, recovery, autonomy, and runtime performance.

## V1 Legacy Status

The Local Mayor v1 planning brain is ended and is not an active planning direction. The following are legacy concepts, regression references, or failure counterexamples only: `growthOpportunity`, road-source scanning, candidate-driven expansion, `roadExpansion`, tick-by-tick `BUILD` arbitration, source exhaustion as growth logic, “run v1 to 500 population”, and V2 failure → legacy-planner fallback.

V1 remains a source/reference for execution infrastructure and observation/spatial/native primitives. Legacy checkpoint: `cb2d07f5945be1c313675161318dfdb524476fef`.

## Frozen V2 Invariants

- LLM is a low-frequency semantic interface, not the continuous game-control layer. Local Mayor owns routine state judgment, bounded Skill/Method selection, ordinary autonomy, and low-token operation.
- Authority flow: Player / CityIntent / Policy → Planning → Capital / Spatial Development Projects + Operational Tasks / Incident Responses → Executive → Skill / Method concrete proposal → Admission → Kernel → CS2.
- Shared state includes a Versioned World Model, spatial state, plan/project state, reservations/protections, Observation / Outcome Journal, Capability & Mechanics Profile, and Safety Supervisor.
- `DevelopmentProject` is for capital/spatial work, not a superclass for all city activity. `District` is a persistent spatial unit. `DistrictPlan` expresses spatial direction and capacity. `Tranche` is the primary construction commitment unit. `Task` is dispatchable work. `Action` is one explicit native/world modification.
- `delivery_progress` and `effect_progress` remain separate.
- Every concrete world write follows Skill/Method → concrete proposal → Admission → Kernel. Project approval does not grant automatic write permission for later actions.
- Skill/Method may perform bounded local target selection, fallback, and recovery within scope; it may not redefine intent, expand budget, switch district, invade reservations, or start an unrelated capital project.
- Skill/Method is a bounded capability module, not a prompt, persona, mini-agent, or top-level decision maker. A future Skill Library remains an independent versioned asset; it is not part of the current Gate 1 implementation requirement.
- Admission and Kernel remain the only world-write authority. MCP, Bridge, native API/ECS interaction, telemetry, evidence, and authoritative readback together form the execution/validation boundary; command acceptance alone is not success.
- `Observed`, `Derived`, `Estimated`, and `Planned-Reserved` remain distinct. `UNKNOWN` must not be converted into planner fact.
- Planning formalism is HTN-style decomposition + constrained spatial planning + recoverable conditional workflow; it is not a generic HTN solver, GOAP, RL, or global Skill auction.

## Current Gate

### Gate 1 — Occupied Tranche + Contingent Release

Future proof chain: autonomous site selection → local district/tranche plan → functional access → productive frontage → certified utility recipe → zoning → actual residents → evidence-based WAIT / RELEASE / DIAGNOSE → bounded recovery.

### Gate 2 — Economic Handover

Immediately follows Gate 1: real employment, a real operating local economy, basic services, and conservative cash runway. Gate 2 is not optional backlog; it is the second half of the first product loop.

## Current Engineering Phase

`V2 FOUNDATION / EXPOSURE ENGINEERING`

Do not begin V2 planner implementation yet. Priority is pure V2 observation boundary, coherent observation envelope, command/outcome reconciliation, exact zoning outcome, route/access, target-building utility service, finance quote/spend, and checkpoint/save semantics.

## Current Audit Verdict

`FEASIBLE_WITH_SMALL_EXPOSURES`

The V2 Gate 1 Capability & Observability Audit (report absorbed into canonical docs, 2026-09-22) found a viable bounded path on the current substrate, but Gate 1 is not yet runtime-certified. This verdict authorizes evidence tracking, not a V2 planner or automatic legacy fallback.

## Provisional Decisions

- V2 planning must not depend on `growthOpportunity`, old `roadExpansion`, old `BUILD` arbitration, `CandidateAvailability`, or road-source scanning as its planning brain.
- Existing MCP/Bridge/native execution and readback primitives may be reused only behind future pure observation and proposal/admission/kernel contracts.
- Treat the current snapshot as non-atomic until a coherent observation envelope is exposed.
- Treat ECS `{index, version}` as live identity only; durable references require explicit epoch/remap semantics.
- Treat action accepted/committed as distinct from completed world effect until observed and reconciled.
- Treat global utility surplus as distinct from local tranche service.

These are provisional architecture decisions, not an immutable schema. Changes require an explicit project decision and an updated baseline.

## Next Engineering Step

Foundation Batch 1 should define the smallest exposure contracts for: (1) a pure V2 observation boundary; (2) a coherent observation envelope; (3) command IDs, outcome states, and idempotent command/outcome reconciliation; and (4) an exact zoning outcome contract. Subsequent bounded foundation batches should address target-building utility service, route/access, finance quote/spend, and checkpoint/save-load semantics. Follow with disposable-save Gate 1 runtime certification; never use v1 fallback as the recovery strategy.

## Canonical References

- [PRODUCT_NORTH_STAR.md](PRODUCT_NORTH_STAR.md) — product goals and active direction.
- [CURRENT_STATUS.md](CURRENT_STATUS.md) — current evidence and status verdict.
- `docs/ai-mayor/evidence/` — raw evidence for the Gate 1 audits and runtime certifications.
- [ARCHITECTURE.md](ARCHITECTURE.md) — legacy/Core MVP implementation substrate reference.
- [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) — current implementation/status authority and historical log.
- [NEXT_SESSION.md](NEXT_SESSION.md) — current AI handoff protocol and session provenance.
- Legacy checkpoint: `cb2d07f5945be1c313675161318dfdb524476fef`.
- External architecture/research review completed; detailed source remains external and is not reproduced here.
