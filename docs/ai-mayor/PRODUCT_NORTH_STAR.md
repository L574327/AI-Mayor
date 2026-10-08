# AI Mayor V2 Product North Star

## Product objective

AI Mayor V2 is a durable, evidence-led city execution system. It observes the authoritative CS2 world, creates an admitted durable scope, runs a bounded domain workflow, submits native work, reconciles completion, and preserves identity/evidence across reloads.

It is not a prompt-to-click macro. Natural language is an optional intent source. Runtime, admission, durability, native execution, and evidence must remain valid without an LLM.

The deterministic Mayor lifecycle also has a read-only authoritative session-status seam. Renderer status is obtained through preload and the existing lifecycle IPC from `MayorRuntime`; it does not infer session state from chat, provider configuration, or a parallel renderer state machine.

## Final architecture

```text
5ire / MayorRuntime
  -> V2 production runtime lifecycle
  -> one SkillRegistry and ProductionSkillDispatcher
  -> authoritative V2 context provider
  -> registered Skill workflow
  -> domain admission and durable workflow
  -> existing native execution boundary
  -> reconciliation and evidence
  -> SkillResult
```

Current K05 path:

```text
SkillIntent(skill.K05)
  -> executeProductionSkillIntent()
  -> K05CommissionUtilitiesWorkflowAdapter.executeProduction()
  -> buildUtilityPreparationInput()
  -> greenfieldUtilityBootstrap.prepare()
  -> greenfieldUtilityBootstrap.run()
  -> utility execution / recovery / evidence
  -> SkillResult
```

CommissionUtilities is a domain Skill. It is not reduced to a fake mouse primitive or a fabricated single MayorAction.

## Core invariants

1. The CS2/Bridge world is authoritative; model assumptions and fixtures are not.
2. A Skill never invents project, tranche, reservation, world, generation, topology, or budget identity.
3. One production SkillRegistry exists per MayorRuntime composition.
4. One production dispatcher exists for all production Skills.
5. Workflow selection is registration-driven, never a K05 conditional in the dispatcher.
6. K05 uses the existing V2 utility workflow and durable semantics.
7. `prepare()` is admission/preflight; `run()` executes the admitted workflow.
8. Authorization, finance, journal, recovery, topology reconciliation, and evidence stay authoritative.
9. Native/API completion is not world completion by itself.
10. Transport UNKNOWN is neither SUCCESS nor permission to retry.
11. After submission, UNKNOWN is reconciled before any further submission.
12. A second submission requires durable proof that the first did not occur.
13. A loaded save without native checkpoint identity is blocked closed, except a first-enable legacy `LoadGame` that has neither a checkpoint nor a bound save-data asset — that unambiguously uninitialized world is admitted for onboarding and receives a certified baseline. A bound save-data asset without a checkpoint identity stays fail-closed.
14. A stale or mismatched checkpoint cannot inherit actions automatically.
15. World identity/generation changes invalidate prior-world assumptions.
16. Evidence identifies the operation, world, generation, topology, and observed effect as required.
17. Production runtime lifecycle is independent of chat and LLM inference.
18. Electron running does not prove MayorRuntime running.
19. Bridge online does not prove V2 initialized.
20. A source function does not prove production wiring.
21. A test caller is not a production caller.
22. The first project is admitted by exactly one production bootstrap seam, and only while the durable project state is still `PLACEHOLDER`. Once a Gate 1 state exists, bootstrap refuses; it never re-derives or overwrites.
23. Project identity descends from durable lineage (world id + the durability-activated, persisted load-context checkpoint), never from a transient checkpoint placeholder (`unsaved:<worldId>`), an advancing rollback boundary, a runtime generation id, wall clock, or randomness.
24. A project budget is bounded by observed treasury *and* an explicit policy ceiling. The whole treasury is never a project budget.
25. K05 is admitted at `ROAD_DELIVERED`. Reaching that stage is the state machine's job; a caller may not hand-edit the stage, relax the check, or skip it.
26. A durable state observed only inside a harness process is not durable live state. In-memory certification proves machinery, not persistence.

## Module responsibilities

### MayorRuntime

Owns the product Mayor session lifecycle. `start()` is idempotent, initializes V2, and does not itself submit a city mutation. `stop()` aborts work and disposes V2 references. Reload cannot duplicate registrations or retain the prior session context.

### V2 production runtime

Owns the single registry, registered workflows, dispatcher, and authoritative context provider. It is created at the existing main-adapter composition root and initialized by MayorRuntime.

### SkillRegistry

Validates manifests/definitions and exposes registered Skills. Unknown Skills fail before workflow/native dispatch. Duplicate registration is an error.

### Production dispatcher

Accepts explicit SkillIntent, validates registry membership, selects the registered workflow, obtains authoritative context, and invokes it. It contains no K05-specific execution branch.

### Skill workflow

Owns domain recipe selection and translation into the existing workflow. It does not invent identity, budget, world state, or evidence and does not call Native Tool directly.

### Utility workflow

`greenfieldUtilityBootstrap.prepare/run` and `executeScopedUtility` own utility-specific admission, planning, authorization, journaling, facility/network actions, recovery, reconciliation, and evidence.

### Bridge

Transports authoritative reads and native calls. It is not the registry, admission authority, Control Layer, or durable utility store.

### Native Tool

Owns CS2-side command execution and native completion/readback. Its core is frozen for the current milestone.

### Control Layer / Mouse20

Control Layer owns low-level action sequencing and FSM checkpoints for supported input execution. Mouse20 is a virtual input device path. Neither is the K05 domain production path.

## Forbidden cross-layer behavior

- Skill code must not call `callTool` directly.
- Skill code must not call `executeLegacyActionBatch`.
- Dispatcher code must not contain per-Skill execution branches.
- A Skill must not fabricate `Gate1State`, `UtilityPreparationInput`, durable identity, or budget.
- Utility code must not silently add unrelated facilities/domains.
- Control Layer must not become a second utility admission system.
- Mouse20 must not substitute for semantic Native execution.
- Bridge transport success must not be treated as world completion.
- Battlefield/test helpers must not be production dependencies, and must not write live durable project state.
- No Skill creates its own project, tranche, reservation, or Gate 1 state; K05 consumes the admitted one.
- No second Gate 1 schema, no second bootstrap seam, and no K05-specific bootstrap.
- A caller must not hand-edit `tranche.stage`, relax a stage check to "any stage", or skip it to reach a workflow.
- Experimental `DomainDispatchPort` / `SkillExecutionAdapter → MayorAction` is not K05 production.

## Durable safety model

Every mutation is scoped to a known world and durable checkpoint lineage. Commands have journal identity and explicit outcomes. A native timeout or transport uncertainty creates UNKNOWN/reconciliation state, never an automatic retry.

A checkpoint snapshot is a boundary record, not a content record: activation restores it only when the durable journal proves the work the project state rests on is gone (a non-`FAILED` command of this world recorded against that very boundary, outside its `journalPosition`, in a different `worldEpochId`, covered by no later checkpoint). Otherwise the recorded project state stands, so a restart or same-save reload cannot regress certified work, a real rollback still restores the older boundary state, and sibling/unknown lineage still fails closed.

```text
authoritative world
  -> admitted durable scope
  -> preflight / authorization
  -> bounded native submission
  -> native completion evidence
  -> world readback / reconciliation
  -> durable settled outcome
```

## Current product boundary

K05 Basic Electricity / WindTurbine is the first production workflow. It may perform the facility and electricity connection work required by its certified recipe. It is not a general water/sewage planner or arbitrary workshop framework.

The native checkpoint identity admission blocker is closed in code, unit tests, and a live certification: an uninitialized legacy `LoadGame` was admitted and onboarded through the existing certified-baseline path (`BASELINE_CHECKPOINT_REQUIRED → cs2_save_game → recordBaselineCheckpoint → ACTIVATED_IN_PLACE`), and the certified rollback anchor is per-world rather than process-global.

The second blocker — "`projectState=PLACEHOLDER`, so Gate 1 project creation is only reachable from a harness/test" — is closed in code, unit tests, and live. Project admission has one production seam (`projectAdmission`) reached through the production runtime's authoritative context. The K05 admission stage contract is aligned to `ROAD_DELIVERED`, so production K05 would enter at the stage the Gate 1 state machine actually requires.

Both earlier blockers are now closed live: the running app itself wrote durable world lineage and the first durable `Gate1State` into its real Electron Store, with no harness, no in-memory durable storage, and no mock. The world was not a `legacyOnboardingCandidate` — it loaded with a native checkpoint identity — so activation completed as `ACTIVATED` with no baseline save at all, and the durable command journal is empty.

The third gap — "an admitted Gate 1 project cannot be advanced by production" — is closed. A generic production Gate 1 lifecycle owner (`v2/gate1-progression.ts`) plus a production boundary (`v2/gate1-progression-boundary.ts`) now drive the durable State Machine from the product runtime. `V2LocalGate1ProductionRunner` was reused unmodified rather than copied, the owner contains no Skill branch, and it never writes `tranche.stage`: reaching a stage remains entirely the State Machine's decision.

Live, on the activated world, the owner advanced `PLANNED → SITE_SELECTED → ROAD_DELIVERED` with exactly one native ROAD command reaching `OBSERVED_MATCH`, and the K05 admission mapping then passed its read-only preflight. No K05 mutation was run.

The first bounded K05 mutation was then attempted, once, through the production dispatcher. It **failed closed before any native submission**: `prepare()` returned `UTILITY_FACILITY_NOT_FOUND`, `run()` was never reached, and nothing in the durable state changed.

The reason was a production integration gap, and at that point it was the single first blocker: `prepareSharedUtilityRecovery` only takes the facility-placement branch when `allowFacilityPlacementMutation` is true (`utility-recovery.ts:242`), and nothing on the V2 *preparation* path ever set it — `buildUtilityPreparationInput()` had no such field and `prepareScopedUtilityExecution()` did not pass it. The only `true` in the repository is inside `executeSharedUtilityRecovery` (the *execution* seam, which the V2 `run()` path also uses; it is not legacy-only, but it is not preparation authority either). Preparation alone could therefore rebind an existing facility but never place the first one — and preparation must not gain that authority, because it holds no durable command identity, no native submission, and no reconciliation.

Fail-closed behaviour worked exactly as intended: the gap became a `FAILED` SkillResult with no world write, not a silent partial mutation. It was deliberately **not** patched — a default flip would authorize an unbounded world write without durable evidence or reconciliation.

The gap turned out to be a circular dependency rather than a missing flag. `prepare()` cannot return READY without a connector, a connector cannot exist without a placed facility, only `run()` places one, and `run()` cannot be entered without a certified target road that `prepare()` derives from the connector. The work therefore introduces an explicit, bounded **first-placement admission**: `UtilityPreparationInput` carries a typed `UtilityFacilityPlacementAuthorization` built only from production state (admitted Gate 1 scope, recipe, treasury and admitted budget, and the road Gate 1 already certified). `prepare()` admits a scope and sends nothing; the placement and the connection still happen exclusively in `run()` through the existing durable journal / native / evidence / reconciliation path. Placement authority is never inferred, never defaulted, and never granted to a connection-only request.

The authorization was plumbed but inert until the composition root could supply the certified road from durable ROAD_DELIVERED evidence. Deriving that road by searching the world or matching geometry against a fresh scan is not acceptable: the authority must be the durable delivered road itself. That supply is now implemented — `v2/certified-road-delivery.ts` reads `state.tasks[ROAD_CONNECTION].terminalOutcomeId` → the journal entry's `commandId` → the durable command record → the `RECONCILIATION` `observationEvidence.details` the authoritative matcher wrote when it certified `OBSERVED_MATCH`, and refuses with an explicit reason on any gap, including several matched edges. The composition root attaches it; `prepare()` admits a bounded first-placement scope and still sends nothing; `run()` alone places and connects, through the existing durable journal, native submission, evidence, and reconciliation.

The production dispatcher is reachable from the renderer through a typed preload seam (`aiMayor.dispatchProductionSkill`) that carries only an intent — not a runtime, a registry, or a workflow. A live proof no longer needs a debugger client attached to the main process.

Three blockers found by independent review have since been closed, and none of them by widening authority.

**The delivered road must be *this task's* road.** `certifyDeliveredRoad` now requires the durable command's `authorizedScope.owner` to be `TASK` and to name the current `ROAD_CONNECTION` task. A command with a perfect match that belongs to another task is refused; nothing is substituted.

**Durable authority cannot rest on a load-scoped field.** The gate used to compare the reconciliation evidence's `worldGeneration` against the current native generation, and the generation changes on every reload/re-attach — so the same save could not reproduce it. The generation is now observation metadata only. This reuses the durability layer's own reasoning that a command's old ECS generation is a historical execution artifact, rather than inventing a second world-identity system.

**Nor may a normal save revoke authority, and nor may a rollback keep it.** The first replacement gate required the command's *base checkpoint* to equal the active rollback boundary. That is too strict in one direction and too loose in another: a routine periodic save advances the boundary and would have wrongly revoked certified `ROAD_DELIVERED`, while a reload onto the save the command was recorded against would have kept authority for a world that no longer contains the road. The gate is now durable checkpoint ancestry plus survival, built only from records the durability layer already keeps: the boundary is either the checkpoint the command was recorded against, or a certified periodic save of this world whose journal position already included the command; and the boundary's world must still contain the command, or the command must still be live on the recorded checkpoint in the current generation. The existing rollback classification is consulted explicitly. So a periodic save preserves authority, while a rollback behind the command, a sibling or unrelated save, a different world, and unprovable lineage all fail closed.

This is deliberately stricter than the wiring round that preceded it, and the difference is real: restarting onto a save taken before the road was built *is* a rollback, and the system now says so instead of certifying a road that save does not contain.

**A crash must not become a second facility.** A placement that reached native and then lost its durable completion is invisible to the next observation, and "I do not see a facility" is not evidence that none was built. The durable command journal — already written ahead of the native call — is now consulted as the authority: while any placement operation for the same project, tranche, reservation and recipe is unresolved, or may already have mutated the world, no second placement is authorized. The rule is evaluated both at preparation and again at the native submission boundary, and a first-placement authorization is inert without a durable clearance, so a caller that forgets to supply one loses authority rather than gaining it. A new attempt requires authoritative proof of terminal failure *and* no mutation. Recovery reuses the existing path: a facility that is visible is claimed and connected; an unresolved one holds as `WAITING`, never as success and never as a retryable failure.

What this does **not** yet establish is that the first placement has happened. Wiring, durability and unit-level admission are not a live gate: no K05 mutation was run, and the live world has not been re-read. That remains the next proof, and it is the operator's call, not a test's.

Two further capabilities are deliberately absent and recorded, not worked around: `ZONING` execution refuses with an explicit capability-gap error, and the one-shot recovery resolvers are not wired because the battlefield drove them from a hard-coded road entity that is save-specific. Neither may be replaced by a hand-edited stage, a relaxed check, a harness route, or a temporary runner.

## 8. State ownership

The renderer owns presentation and user intent entry.

The main process owns MayorRuntime lifecycle and composition.

The V2 runtime owns Skill registration and production dispatch.

The V2 durability coordinator owns world lineage and durable project state.

The utility workflow owns utility-specific plans and recovery.

The Bridge owns transport and authoritative native observations.

The Native Tool owns CS2-side command realization.

The Control Layer owns low-level execution governance.

Mouse20 owns virtual input-device behavior only.

No layer may silently assume ownership belonging to another layer.

## 9. Admission principles

Admission is a decision boundary, not a convenience object.

Admission must be reproducible from authoritative inputs.

Admission must fail closed when required identity is missing.

Admission must preserve the current world epoch.

Admission must preserve the current generation.

Admission must bind topology to that generation.

Admission must bound spend by project budget and observed treasury.

Admission must reject inconsistent project/tranche/reservation identity.

Admission must reject an invalid project stage.

Admission must not be synthesized by an LLM.

Admission must not be synthesized by a test harness.

Admission must be reachable from the production runtime without a harness, a test caller, or a fixture state.

Admission of the first project must be reachable only from an ACTIVATED world's untouched PLACEHOLDER state, and must refuse once a Gate 1 state exists.

Admission identity must survive a certified-baseline reload and restart unchanged; a re-bootstrap over the same durable lineage reproduces the same project/tranche/reservation, and a different world inherits nothing.

## 10. Execution principles

Every domain workflow has one production boundary.

Every native submission has a durable identity.

Every completion has an evidence requirement.

Every reconciliation compares against the admitted scope.

Every retry decision is subordinate to durable command outcome.

Unknown is a durable state, not an exception to safety.

Recovery is domain policy, not dispatcher policy.

Topology proof is domain evidence, not UI feedback.

SkillResult reflects the authoritative outcome, not intent acceptance.

The system must be restartable without replaying an uncertain mutation.

## 11. Definition of done

A Skill is production-ready only when its registry entry, workflow, admission context, native path, evidence, reconciliation, failure mapping, restart behavior, and targeted tests are all present.

K05 is production-wired and code-complete. Live durable lineage, a durable `Gate1State`, and a State-Machine-driven `ROAD_DELIVERED` all exist in the running app's Electron Store, written and advanced by the production runtime. One production K05 dispatch has been executed and failed closed at `prepare()` before any native submission.

The next proof required that production K05 be able to place its first utility facility. That production change is now implemented: an explicit, typed placement authorization is threaded through the preparation contract from durable ROAD evidence, and the first placement still runs through the existing placement-capable path with the same durable evidence and reconciliation. The `allowFacilityPlacementMutation` flag remains unset on the V2 prepare path, and the V2 prepare ports still carry no `execute`, so `prepare()` structurally cannot submit anything.

The remaining proof is live: re-run one bounded mutation, preceded by the existing precondition (native operation Idle, unresolved mutation count zero). No later layer may bypass that chain, and no step may be satisfied by a fixture, a hand-edited stage, a relaxed check, a harness-local write, or a passing unit test.

**A deterministic verdict refuses one course, not the objective.** The first live connection attempt settled to an authoritative `OBSERVED_MISMATCH` — a real verdict on that cable course, not a telemetry gap — and the objective then dead-ended, because the approved course set had been computed once and nothing re-derived it from the world. The workflow now replans: while a refused course exists and the bounded budget is unspent, it re-derives a replacement from the **current** authoritative topology through the same connection planner, mints a new stable revision (`<previous>:replan:<n>`, deterministic and durable), and sends it through the normal admission, preflight, native submission and reconciliation path. Three properties keep this from becoming unbounded automation or a disguised retry:

- **Eligibility is the course itself, never its identity.** Every course the ledger records as attempted — refused, preflight-rejected, in flight, or already matched — is permanently ineligible, and the key is the action fingerprint. Re-minting a `candidateId`, an `objectiveId` or a plan revision cannot resurrect geometry the world has already answered.
- **Policy eligibility is the caller's, not a second policy.** A replacement must be a primitive the *current* policy would actually attempt; a course the policy would never execute is not "new".
- **Refusal is a bounded, terminal outcome.** When nothing genuinely new and eligible remains, the replan is refused, the refusal consumes the bounded budget, and the objective ends deterministically. It does not loop and it does not mint.

The refused candidate keeps its verdict and its durable command identity across restart and resume: it is never revived and never re-submitted. A replacement earns its place only by being a different course against the current world.

That transition is now live-verified in Attempt 2, and the live result was a **refusal** — which is the correct outcome here rather than a shortfall. The approved `direct-cable` primitive has no remaining degree of freedom: its start is pinned to the connector's observed position and its end to the approved contact point, so re-deriving it from the current authoritative topology reproduces the refused course byte for byte, and the only other primitive is placement-phase and ineligible once a facility exists. The replan was refused twice, consumed its bounded budget, minted nothing, submitted nothing (`commands` and `journalPosition` unchanged — zero native mutation), left candidate A `FAILED_DETERMINISTIC` under its original `commandId`, and ended at the terminal `UTILITY_CONNECTION_CANDIDATES_EXHAUSTED`. Bounded automation refused rather than looped, and the world was not touched.

The resulting sole blocker is stated in the world's own terms, not the workflow's: **the current authoritative topology admits no connection course distinct from the deterministically-refused one.** The connector is `attached` but `orphan`, its only edge the unmatched `45612:469`; supply, network connectivity and target reachability all hold, while `cityCapacityAvailable` is false with `capacity = 0` and the issue still active. Clearing that needs a course the current primitive family cannot express — the cable's endpoint contract, not another replay of the same course. Any future work must treat that as the open question and must not re-mint the refused course to look busy.


One identity question is recorded rather than resolved: a world that loads with checkpoint identity has `certifiedRollbackAnchor = null`, so its project lineage descends from `baselineActivation.checkpointId` — the load-context checkpoint, which Gate 0 established is durable and content-derived — rather than from a `purpose: "BASELINE"` checkpoint. `MayorRuntime.ensureProjectAdmission()` remains unreachable from the renderer; admission is reached through the production context provider's own `ensureFirstProject()` call.

## 12. Engineering posture

Prefer one authoritative path over parallel convenience paths.

Prefer explicit blocked states over optimistic success.

Prefer evidence over logs that merely describe intent.

Prefer bounded workflows over unbounded automation.

Prefer reversible, journaled operations over opaque batches.

Prefer a short production map over a large historical archive.

Every future workshop should locate startup, admission, execution, evidence, and blocker status without repeating repository archaeology.

The north star is a stable contract between observation, admission, execution, and proof.

No individual Skill may trade that contract for a shorter demo path.

No live gate may be waived merely because earlier unit tests passed.

No archive may describe an experimental route as production.

This boundary is the default assumption for future Skill work.

Any exception requires an explicit architecture decision and evidence.

Until then, the existing V2 path remains the only production contract.

The product favors durable truth over apparent progress.

That is the governing Mayor invariant.

It applies across every future workshop.

Durable identity is part of the proof: AI Mayor V2 state must not depend on the incidental Electron app/userData profile selected by a launch mode. The canonical V2 store is explicit and stable; profile migration may copy only verified V2 durable state, never general application settings, and must fail closed when lineage cannot be resolved.

## P0 next: SAVE_AND_ROLLBACK_SOVEREIGNTY

`CURRENT_GAME_WORLD_IS_AUTHORITY`. The game world, not the AI durable memory, is the authority.

- Default: the AI Mayor never forces a CS2 save. Saving is the player's decision to make or to skip.
- A player may quit without saving, reload any earlier save, switch between existing saves, and deliberately roll back AI-completed work. None of that is an error and none of it may corrupt the AI Mayor.
- When an old save removes earlier AI mutations, durability and reconciliation must recognise a real rollback, revoke the corresponding AI authority, reduce the project to the stage the current world actually corresponds to, and let the Local Mayor replan and continue from the current world.
- Durable memory is never pushed onto a world that does not contain the certified effect, and certified lineage is never preserved by *making* a save.
- Automatic saving is an explicit user opt-in only. It is never a correctness precondition.

Known blocker to fix under this policy: `FORCED_SAVE_ON_STOP` - `MayorRuntime.stop()` -> `#finalize()` unconditionally calls `ports.save()`, i.e. `cs2_save_game` on every Stop and on every `#halt()` path. That default is exactly what this policy forbids; it is recorded here and deliberately not implemented this round.

## The connection blocker, stated in the world's own terms

The AI Mayor can reach the road with a cable and still not be connected. Attempt 2 proved this precisely: the cable was built, the game honoured its prefab and its full length, and the cable's far end came to rest on the road node the Mayor had named — and the electricity network still did not join. The game had created a new node beside the road's node rather than entering it.

The Mayor's own reconciliation said the same thing in its own words: the cable chain terminates at the new node, not at the authoritative road node, so the course is a `PROVEN_MISMATCH` rather than a match. Both the native observer and the Mayor's matcher independently refused to call this connected. That agreement is the system working: a cable that stops one node short of the network is not a connection, and neither layer was willing to pretend otherwise.

The gap is not in what the Mayor asks for. The Mayor declares the road node it means to enter, and the game's own contract for this endpoint deliberately keeps the course free while expecting the network entry to be made by a separate `LocalConnect` write on that road node. That write is not happening, and it is not happening on the game side, not in the Mayor's planning. The Mayor has no legal way to fix this by asking for a different course: the same contract explicitly refuses a bound endpoint, so a second geometry or a bound-endpoint variant would be refused rather than honoured, and inventing one would be the hardcoded workaround this project forbids.

So the honest next step is not another cable. It is one observation of why the game's own network-entry write does not occur. Until that is known, the Mayor records the connection as unproven and keeps the facility placement at one.
