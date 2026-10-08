# AI Mayor V2 Technical Map

This is the first-read production map for a new implementation window. It records repository facts, not historical debugging narrative.

## 1. 5ire / MayorRuntime lifecycle

### Production startup

```text
OverlayApp.tsx lifecycle effect / Start AI Mayor control
  -> window.electron.aiMayor.start(options)
  -> preload.ts IPC invoke("ai-mayor-start")
  -> main.ts ipcMain.handle("ai-mayor-start")
  -> MayorRuntime.start(options)
  -> ports.v2ProductionSkillRuntime.initialize()
```

The renderer entry is `src/renderer/apps/ai-mayor-overlay/OverlayApp.tsx`. On authoritative game/MCP connection, the lifecycle effect calls `window.electron.aiMayor.start(options)` through the formal IPC path; the panel also exposes Start/Stop controls. Chat `send()` may ensure a session but is not the sole lifecycle caller.

The read-only status path is `window.electron.aiMayor.sessionStatus()` -> `ai-mayor-session-status` -> `MayorRuntime.getSessionStatus()`. It returns `OFFLINE`, `STARTING`, `RUNNING`, `FAILED`, or `STOPPED`, plus an authoritative `lastError`, without starting, stopping, dispatching a Skill, or requiring an LLM provider.

The preload entry is `src/main/preload.ts`, `electronHandler.aiMayor.start`. The main IPC handler is in `src/main/main.ts`. Main creates the one `MayorRuntime` with `createMainMayorPorts(...)` and the durable storage adapter.

`MayorRuntime.start()` validates options, creates session state, and initializes V2. It does not call DeepSeek merely to start. A deterministic local session can initialize without an LLM prompt.

`MayorRuntime.stop()` aborts work, waits within its bounded stop behavior, finalizes state, and calls V2 runtime `dispose()`. `start()` is idempotent while a session is already running. Reinitialization does not add another registry entry or preserve the old readiness promise.

### Important distinctions

| Fact | Does not prove |
|---|---|
| 5ire Electron running | MayorRuntime session running |
| Bridge HTTP online | V2 runtime initialized |
| `executeProductionSkillIntent` exists | production caller reaches it |
| Jest caller reaches workflow | production caller exists |
| K05 in registry | current-world admission passed |
| native API response | CS2 world effect completed |

### V2 composition

`src/main/services/ai-mayor/main-adapters.ts::createMainMayorPorts()` creates the existing V2 foundation and one `createV2ProductionSkillRuntime(...)` instance. The runtime is `src/main/services/ai-mayor/v2/production-skill-runtime.ts`.

It owns:

- one `SkillRegistry` from `createSkillRegistry()`;
- the registered production workflows;
- the generic production dispatcher;
- the authoritative context provider;
- initialization/disposal state;
- the readiness promise for a read-only context check.

The runtime API is:

- `initialize()` — idempotent activation;
- `dispose()` — clears activation and readiness references;
- `readiness()` — authoritative read-only context;
- `dispatch()` — context acquisition plus workflow dispatch.

The production entry exposed by MayorRuntime is `dispatchProductionSkillIntent()`. The main process exposes it as the `ai-mayor-production-skill` IPC handler, and as of 2026-09-21 `preload.ts` surfaces it to the renderer as `window.electron.aiMayor.dispatchProductionSkill(intent)`. Read-only context is exposed as `ai-mayor-production-readiness` / `aiMayor.productionReadiness()`.

## 2. Production Skill Runtime

### Generic dispatcher

```text
SkillIntent
  -> executeProductionSkillIntent()
  -> SkillIntentSchema validation
  -> SkillRegistry membership check
  -> registered workflow lookup by skillId
  -> workflow.executeProduction()
```

`src/main/services/ai-mayor/skills/runtime/skill-execution-runtime.ts` contains `executeProductionSkillIntent`. It has no K05 conditional. An unregistered Skill fails before workflow/native dispatch. A registered Skill with no production workflow also fails.

### K05 production chain

```text
SkillIntent(skill.K05)
  -> MayorRuntime.dispatchProductionSkillIntent()
  -> V2ProductionSkillRuntime.dispatch()
  -> executeProductionSkillIntent()
  -> K05CommissionUtilitiesWorkflowAdapter.executeProduction()
  -> buildUtilityPreparationInput()
  -> greenfieldUtilityBootstrap.prepare()
  -> greenfieldUtilityBootstrap.run()
  -> existing utility execution / recovery / evidence
  -> SkillResult
```

K05 is registered once through normal Skill registry registration. Its first recipe family is `basic-electricity-provision` / Basic Electricity Provision / WindTurbine.

### Not K05 production

```text
ActionSequence
  -> DomainDispatchPort
  -> K05DomainDispatchAdapter
  -> SkillExecutionAdapter
  -> MayorAction
```

This route is experimental and test-covered. It is not the K05 production caller and must not be used to claim live readiness.

## 3. Authoritative context map

The production builder is `src/main/services/ai-mayor/v2/utility-admission-context.ts::buildUtilityPreparationInput`.

It maps already-authoritative input. It is not an identity generator.

| Field | Source/rule | Forbidden behavior |
|---|---|---|
| `kind` | electricity recipe | no arbitrary Skill replacement |
| `intentId` | `Gate1State.intent.id` | never invent |
| `projectId` | `Gate1State.project.id` | never invent |
| `trancheId` | `Gate1State.tranche.id` | never invent |
| `reservationRef` | `Gate1State.tranche.reservationRef` | never invent |
| `worldId` | `NativeWorldIdentity.worldId` | never invent |
| `worldEpochId` | `NativeWorldIdentity.worldEpochId` | never invent |
| `generation` | `NativeWorldIdentity.generation` | never invent |
| `topologyRevision` | `${world.generation}:production` | no independent revision |
| `spatialEnvelope` | `Gate1State.project.utilityReservation` | no guessed geometry |
| `maximumSpend` | `min(project.maximumBudget, treasury)` | no Skill budget |
| `treasury` | `cs2_city_overview.treasury` through V2 source | no fixture value |
| `treasurySafetyReserve` | current builder contract value `0` | no Skill override |
| stage | project `ACTIVE`; tranche `ROAD_DELIVERED` | no bypass, no stage edit |

The builder verifies `worldReady`, finite/nonnegative treasury, active project, required stage, and identity consistency between project/tranche/reservation. It rejects unknown/invalid admission context.

The required stage is `ROAD_DELIVERED`, matching the Gate 1 state machine rather than an arbitrary choice: `recordUtilityExecution()` rejects every other stage, and the `ZONING` task's `legalStage` is `ROAD_DELIVERED` with a prerequisite gate on every `tranche.utilityExecution.utilities[*]` reaching `SERVICE_CERTIFIED`. Supply-side utility execution therefore belongs at `ROAD_DELIVERED`. `BUILDING_OBSERVED` is the later consumer-service certification boundary (`UTILITY_PROVISION` / `CERTIFY_UTILITIES`) and can never admit K05; requiring it made production K05 unreachable. The stage is never hand-edited, relaxed to "any stage", or skipped to work around this — callers and tests must reach `ROAD_DELIVERED` through the real state machine.

Battlefield and K05 call this same builder. K05 receives context from the production V2 provider; it does not import the battlefield script.

### Project admission bootstrap (the source of the first Gate 1 state)

`src/main/services/ai-mayor/v2/project-admission.ts::createV2ProjectAdmissionBootstrap` is the single production seam that turns an ACTIVATED world with an untouched `PLACEHOLDER` project state into a durable, admitted Gate 1 project.

```text
durably ACTIVATED world (projectState === PLACEHOLDER)
  -> authoritative reads: treasury, spatial scan, bounded site detail, road prefabs
  -> deriveStarterProjectIntentId(worldId, certified baseline checkpointId)
  -> deriveStarterProjectBudget(observed treasury, explicit policy)
  -> selectBoundedStarterSiteAnchors() + evaluateBoundedStarterSites()
  -> planStarterResidentialIntent()
  -> createDurableGate1StateStorage(durability).save()
  -> durable Gate1State (project/tranche/reservation)
```

Composition and entry points:

| Layer | Symbol |
|---|---|
| composition root | `V2FoundationPorts.projectAdmission` (built in `createV2FoundationPorts`) |
| authoritative context | `main-adapters.ts::authoritativeContext()` calls `ensureFirstProject()` then requires `V2_GATE1_STATE_SCHEMA_VERSION` |
| Skill runtime | `V2ProductionSkillRuntime.ensureProjectAdmission()` |
| product runtime | `MayorRuntime.ensureProjectAdmission()` |

`ensureFirstProject()` is idempotent and performs no native read when a Gate 1 state already exists. `admitFirstProject()` is strict and throws `PROJECT_ADMISSION_ALREADY_EXISTS` once any durable state exists, so a bootstrap can never overwrite or re-derive an admitted project. When `projectAdmission` is absent the production context fails closed with `V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED`; there is no K05-specific or fallback bootstrap.

Identity rules:

- `intentId = intent:gate1-starter:${worldId}:baseline:${certifiedBaselineCheckpointId}`, derived from durable lineage only.
- Deliberately excluded: `worldEpochId` and `generation` (runtime generation ids that change on every reload/re-attach), the *transient* checkpoint placeholder (`transientCheckpoint()` = `unsaved:<worldId>`, used only when `checkpointId === null`), `active.rollbackBoundaryId` (advances with periodic saves), wall clock, and randomness.
- **Allowed:** the durability-activated, persisted **load-context** checkpoint — `NativeWorldIdentity.checkpointId`, i.e. `active.loadedCheckpointId`. It is content-derived (`save:<loadAssetGuid>:<saveDataAssetGuid>`), it survives a same-save reload unchanged, and `recordCheckpoint()` never moves it. Earlier wording here said "the live `checkpointId` of the loaded save (advances with periodic saves)" and conflated this field with `rollbackBoundaryId`; CURRENT_STATUS "Gate 0" carries the four facts that settle it.
- `projectId` / `districtId` / `trancheId` / `reservationRef` are unchanged: they still come from the existing deterministic Gate 1 derivation inside `planStarterResidentialIntent`.
- When no certified baseline exists, the derivation refuses (`PROJECT_ADMISSION_BASELINE_NOT_CERTIFIED` / `PROJECT_ADMISSION_BASELINE_IDENTITY_MISSING`) rather than inventing lineage.

Budget policy (`V2_PROJECT_ADMISSION_POLICY`): `maximumBudget = min(absoluteBudgetCeiling 25_000, floor(treasury × 0.25))`, refused below `minimumViableBudget 2_500`, with the binding constraint reported as `budgetBound`. The whole treasury is never treated as a project budget, and the existing `maximumSpend = min(project.maximumBudget, treasury)` containment is unchanged.

## 4. Save and native checkpoint identity

### Structures

`src/main/services/ai-mayor/v2/durability.ts` defines:

- `NativeWorldIdentity`: world id, native session, load purpose, asset GUIDs, checkpoint id, bridge epoch, generation, generation sequence/origin, world epoch, and readiness.
- `V2CheckpointRecord`: checkpoint id, world id/epoch/generation, native session, save asset GUIDs, journal position, purpose, project state, timestamp, and durability.
- `V2DurableState.active`: current world, loaded checkpoint, rollback boundary, world epoch, bridge epoch, generation.
- `V2CertifiedRollbackAnchor`: certified checkpoint, source generation, source epoch, and journal position 0.
- `SaveCompletionReceipt`: completed durable save, world generation, checkpoint id, save metadata/data GUIDs, and native session GUID.

### Source and creation

`parseNativeWorldIdentity()` reads the authoritative `cs2_game_state.world` payload. A `LoadGame` world must contain a non-empty native `checkpointId`, except for first-enable onboarding: a `LoadGame` with `checkpointId === null` **and** `saveDataAssetGuid === null` is admitted as `legacyOnboardingCandidate: true` (unambiguously uninitialized) and proceeds through `BASELINE_CHECKPOINT_REQUIRED` → `cs2_save_game` → `recordBaselineCheckpoint`. A `LoadGame` with `checkpointId === null` but a bound `saveDataAssetGuid` stays fail-closed (`loaded save lacks native checkpoint identity`).

`V2DurabilityCoordinator.activate(rawWorldState)`:

1. parses world identity;
2. compares prior world/epoch/checkpoint lineage;
3. chooses the observed rollback boundary;
4. creates or updates checkpoint/active records;
5. applies stale and unknown checkpoint guards;
6. persists the durable state.

In 5ire main, durable state is stored through `aiMayorV2DurableState` in Electron Store.

`saveProjectState()` persists an authoritative `Gate1State` only when an active world identity exists. `recordCheckpoint()` persists a verified native save receipt and updates the active rollback boundary.

### Save/load lifecycle

The native save path calls `cs2_save_game`, polls `cs2_save_status`, requires `COMPLETED` plus `durable=true`, validates world/session/checkpoint identity, and records the receipt. Pending, failed, unknown, stale, or mismatched status is not completion.

On reconnect/reload, `activate()` compares world id, world epoch, loaded checkpoint, rollback boundary, and known checkpoint records. Same world/epoch may retain a valid durable boundary. A different world, save, or lineage cannot silently inherit prior actions. An unknown checkpoint in a known world quarantines inherited work.

### Legacy onboarding resolution

The prior live blocker — a `LoadGame` world with no usable `checkpointId` being rejected by `parseNativeWorldIdentity()` — is resolved for first-enable onboarding. A legacy `LoadGame` (`checkpointId === null` and `saveDataAssetGuid === null`) is now admitted and onboarded through the existing `BASELINE_CHECKPOINT_REQUIRED` → save → `recordBaselineCheckpoint` → `ACTIVATED_IN_PLACE` path. Corrupt/ambiguous loads (`checkpointId === null` with a bound `saveDataAssetGuid`) remain fail-closed.

The certified rollback anchor is per-world, not process-global: it is rebuilt in `activate()` from the world's certified `BASELINE` checkpoint (`checkpoints[]` keyed by `worldId` + `purpose === "BASELINE"` + `durable` + `journalPosition === 0`), and `nativeSessionGuid` is persisted on the checkpoint record. `recordBaselineCheckpoint` first-writer-wins is scoped to `worldId`. `ensureDurableWorld` is single-flighted by a process-local `Mutex`.

The code does not contain a general migration that invents a missing native checkpoint id, nor a generic automatic rebind from an arbitrary old save. First-enable onboarding is an admission decision for an uninitialized load, not an identity migration. No Skill may fabricate the identity.

Harness result (2026-09-20, superseded): onboarding was first certified via `scripts/legacy-onboarding-certification.ts --onboard`. The save was admitted as `legacyOnboardingCandidate` and onboarded — one `cs2_save_game` → `COMPLETED` → `recordBaselineCheckpoint` → `ACTIVATED_IN_PLACE` — producing checkpoint `save:9108a92378172c02d969e2672fc14b73:8094f9811fdb950f439fb35d9a19867d` with a `CERTIFIED` rollback anchor at `journalPosition=0`. That certification was **machinery only**: the harness used in-memory durable storage, so nothing reached the app's Electron Store.

Production-owned live result (2026-09-20/21): the running app performed the same activation itself. With Cities2 on the experimental save, Bridge online, and 5ire built from the working tree, `window.electron.aiMayor.start({ continuous: false })` drove `MayorRuntime.start()` → `V2ProductionSkillRuntime.initialize()` → `authoritativeContext()` → `activateDurableWorld()` (`ensureDurableWorld()`) → `projectAdmission.ensureFirstProject()` entirely inside the running app. `%APPDATA%\5ire\config.json` gained the `aiMayorV2DurableState` key.

The observed path was **not** the legacy-onboarding path. The loaded save reported `checkpointId = save:444a6f12bc33ab7e07e279f17b4ceac4:be9eac6e0c07368bf19dc8ded06bc7d5` with a bound `saveDataAssetGuid`, so `legacyOnboardingCandidate` was `false` and `activate()` took its non-null-checkpoint branch: `kind = FIRST_OBSERVATION`, `status = ACTIVATED`, one checkpoint record with `durable=true`, `journalPosition=0`, `purpose=null`, and `certifiedRollbackAnchor = null`. `ensureDurableWorldOnce()` never entered its `BASELINE_CHECKPOINT_REQUIRED` block, so **no `cs2_save_game` was submitted** and the durable command journal stayed empty. This is the designed behaviour for a `LoadGame` that is not a first-enable legacy candidate; the `BASELINE_CHECKPOINT_REQUIRED → cs2_save_game → ACTIVATED_IN_PLACE` path is reachable only when `checkpointId === null` (see `durability.ts` `activate()`), which also means `assertStableFreshWorld()` requires either `loadPurpose === "NewGame"` or `legacyOnboardingCandidate === true`.

Consequence for `certifiedBaselineCheckpointId()`: with `certifiedRollbackAnchor` null, the derivation fell through to `baselineActivation.checkpointId`, which for this world is the loaded save's own checkpoint. A world that loads with checkpoint identity therefore treats its load-context checkpoint as the de-facto baseline. Whether that fallback should be treated as certified lineage is an open question recorded in CURRENT_STATUS; this round did not change it.

Durable store location: `%APPDATA%\5ire\config.json`. The `__DEV__` subfolder that `Environment.userDataFolder` selects in development is used for `Database/`, `Embedding/`, `Logs/`, and `Stories/` only — it is **not** the electron-store path. Reading `%APPDATA%\5ire\__DEV__\config.json` to check durable state is wrong and was a source of confusion.

### Battlefield relation

`local-v2-gate1-battlefield.ts` can create and verify a baseline checkpoint through the same coordinator. It validates save status, checkpoint record, journal position, active rollback boundary, and project state. It is a harness use of production durability, not a second identity format.

## 5. Utility production path

| Component | Responsibility | Class |
|---|---|---|
| `greenfieldUtilityBootstrap.prepare` | admission and durable preparation | PRODUCTION |
| `greenfieldUtilityBootstrap.run` | admitted utility workflow | PRODUCTION |
| `executeScopedUtility` | full utility workflow | PRODUCTION |
| durable utility state | facility/network identity and stage | PRODUCTION |
| candidate ledger | candidate/context authority | PRODUCTION |
| authorization/finance | permission and bounded spend | PRODUCTION |
| command journal | idempotency/outcomes | PRODUCTION |
| native submission | V2 native boundary | PRODUCTION |
| recovery | utility-specific recovery policy | PRODUCTION |
| topology reconciliation | facility/connection proof | PRODUCTION |
| completion evidence | native/world evidence | PRODUCTION |
| `local-v2-gate1-battlefield.ts` | acceptance harness | HARNESS |
| `executeLegacyActionBatch` | old action route | LEGACY / FROZEN |
| `DomainDispatchPort` / MayorAction | alternate route | EXPERIMENTAL |
| Mouse20 | virtual input capability | FROZEN / OUTSIDE K05 |

K05 uses the existing utility workflow and may perform the facility plus electricity connection required by the certified recipe. It must not copy `executeScopedUtility`, create a second journal, or bypass recovery/reconciliation.

### Known blocker: first-facility placement is unreachable from production

`prepareSharedUtilityRecovery` (`utility-recovery.ts:242`) refuses the greenfield branch before it can place anything:

```ts
receipt = await ports.findExistingFacility?.(kind, plan);
if (!receipt) {
  if (!input.allowFacilityPlacementMutation) return blockedResult("UTILITY_FACILITY_NOT_FOUND", { plan });
  // 243-256: preflight + ports.execute([placementAction]) — the branch that places the facility
}
```

`buildUtilityPreparationInput()` (`v2/utility-admission-context.ts`) has no field for `allowFacilityPlacementMutation`, and `prepareScopedUtilityExecution` (`v2/utility-execution-planner.ts:114-121`) does not pass it. The only `allowFacilityPlacementMutation: true` in the repository is `utility-recovery.ts:492`, inside the **legacy** `executeSharedUtilityRecovery` used by the old Local Mayor `ensureUtilityCapacity` route.

Consequence: production K05 can only rebind a facility that already exists (`connectionOnly: true` with a matching binding). Placing the first one always blocks with `UTILITY_FACILITY_NOT_FOUND`. Confirmed live on 2026-09-21 — the dispatch failed closed at `prepare()`, no native submission occurred, and `greenfieldUtilityBootstrap.run()` was never reached.

Deliberately **not** patched. Any fix must be a deliberate production change that preserves durable evidence and reconciliation; a one-line default flip would silently authorize an unbounded world write.

### Why the flag alone is not the fix

`utility-recovery.ts:242` is a symptom. `prepare()` and `run()` are circular: `prepare()` needs `prepared.connector` (`utility-execution-planner.ts:122`), a connector needs a placed facility, only `run()` → `executeScopedUtility` → `executeSharedUtilityRecovery` places one, and `run()` needs an `executionScope` whose `certifiedRoadRefs` are non-empty and contain `targetServiceEntry.road` (`greenfield-utility-bootstrap.ts:400-402`) — which `prepare()` derives from the connector-dependent connection contact. The V2 `prepare` ports also carry no `execute`, so `utility-recovery.ts:252` would block even with the flag set.

**First-facility placement admission (added 2026-09-21).** `v2/utility-execution-planner.ts` now carries an explicit, bounded `UtilityFacilityPlacementAuthorization` on `UtilityPreparationInput`:

- `authorizingPlacement()` validates the admitted Gate 1 scope binding, the facility kind, exact reservation-envelope equality, a spend ceiling bounded by `input.maximumSpend`, and that the target road is one of the certified refs. A mismatch is discarded, never repaired.
- `admitFirstPlacement()` returns a `PreparedUtilityFirstPlacement` (`mode: "GREENFIELD_FIRST_PLACEMENT"`) whose `executionScope.certifiedRoadRefs` is the certified road set. It enforces reservation containment and `constructionCost <= maximumSpend`, and sends **no** native command.
- `buildUtilityPreparationInput()` constructs the authorization from production state only — admitted Gate 1 scope, recipe, treasury/project budget, and a caller-supplied certified road. Never for `connectionOnly`.

The authorized road must come from durable ROAD_DELIVERED evidence: `state.tasks[ROAD_CONNECTION].terminalOutcomeId` → journal `commandId` → `durability.commandJournal.get(commandId)`. **Not** a nearest-road search, a fresh world scan, a hardcoded entity, or a geometric re-identification. That read is implemented by `v2/certified-road-delivery.ts` and wired into the composition root; see "Where the certified refs live" below.

**K05's context type is not a second shape.** `K05AuthoritativeProductionContext` is an alias of `AuthoritativeUtilityAdmissionContext`, and the workflow is registered as the `K05CommissionUtilitiesWorkflowAdapter` instance itself rather than an arrow function carrying `context as never`. Every admission field, the certified road included, is therefore type-checked across the production boundary instead of cast through it.

### First-facility placement durability

The crash window: a first placement reaches native, the facility exists, and the process dies before the utility durable completion is written; on restart the observation is incomplete, so an absent facility in the observation is not evidence that none was built.

The write-ahead command identity existed (`commandJournal.create` before the native call, `SUBMITTED` before it), but `commandIdempotencyKey` for `UTILITY` embeds `worldEpochId` and `topologyRevision` — both generation-derived — so after a restart the key differed and `assertMutationAllowed` saw nothing.

| Component | Role |
|---|---|
| `durability.utilityPlacementOperations(scope)` | durable utility commands for one admitted scope whose exact actions carried a `place_building`. Generation-free matching; `null` when lineage is unreadable, so "cannot prove" is distinct from "no operation" |
| `durability.carriesFacilityPlacement(exactInput)` | reads the exact actions, not a recipe name; an unreadable input answers "placement" (fail closed) |
| `v2/utility-placement-durability.ts` | `NONE` / `TERMINAL_NO_MUTATION` / `PLACED` / `UNRESOLVED` / `UNPROVEN` + `firstFacilityPlacementPermitted()` |
| `authorizingPlacement()` | honours a first-placement authorization only when durability permits one |
| `executeScopedUtility` submission boundary | re-evaluates the same rule immediately before a `place_building` batch gets its own durable identity |
| `K05` adapter | maps `UTILITY_FACILITY_PLACEMENT_UNRESOLVED` to `WAITING` (`K05_PREPARE_HELD:…`), never `SUCCESS` and never a retryable failure |

A new attempt is permitted only when no operation exists, or every operation is *proven* mutation-free (`FAILED_BEFORE_SUBMIT`, or `OBSERVED_MISMATCH` with `effectAbsenceProven`). A failure that does not prove absence is unresolved. A durable `OBSERVED_MATCH` outranks everything.

Recovery reuses the existing path: `prepare()` reads `findExistingFacility` before the authorization, so a visible facility is claimed and connected with no placement; otherwise preparation holds. No process-local flag, in-memory boolean, wall clock, or "I don't see one, so build one" reasoning participates.

**Where the certified refs live (Gate A, 2026-09-21):** they are already durable, no re-derivation needed.

```text
state.tasks[ROAD_CONNECTION].terminalOutcomeId
  -> state.journal[...].commandId
  -> commandJournal.get(commandId).observationEvidence[phase === "RECONCILIATION"].details   // the whole RoadEffectReport
       .matchedEdges          // SpatialEntityRef[]
       .observedEnvelope.worldGeneration
```

`road-effect.ts:191-199` sets `matchedEdges` on MATCH; `road-effect.ts:220` returns the whole report as `evidence`; `road-kernel.ts:374-402` persists it as `CommandObservationEvidence.details` in `observationEvidence` through the durable journal. It is the matcher's real match at certification time — not a fresh scan, not geometry replay, not a nearest-road search, not a hardcoded entity. Requirements: `observationEvidence` is durable, so it survives reload; reconciliation only appends, and a MATCH is terminal, so duplicate reconciliation cannot produce conflicting refs.

**Wired (2026-09-21).** `v2/certified-road-delivery.ts::certifyDeliveredRoad({ state, world, journal })` performs that read and returns `{ status: "CERTIFIED", commandId, prefab, refs, target, lineage, observedWorldGeneration }` or `{ status: "UNAVAILABLE", reason }`. `main-adapters.ts::authoritativeContext()` calls it with the durability coordinator's `commandJournal` and returns `certifiedRoad` + `certifiedRoadRefs` (or, on refusal, `certifiedRoadUnavailableReason`), which flow through the K05 workflow into `buildUtilityPreparationInput()`. `targetRoad.prefab` and `targetRoad.position` come from the same command's `authorizedScope.exactInput`: the prefab as built, and the committed **start** endpoint (`x1, z1`), matching the `endpointRole: "start"` contract used by `admitFirstPlacement` and `reacquirePreflightTargetRoad`.

It refuses, without falling back to a search or a second command, on: no ROAD_CONNECTION task; a task from another tranche; a task that is not `SUCCEEDED`; no terminal outcome; an outcome missing from the journal or owned by another task; an outcome that is not `DELIVERED` or carries no `commandId`; no durable command; a command that is not the certified `OBSERVED_MATCH` ROAD command; an owner that is missing, not `TASK`, or not this task; a command outside the current durable world/checkpoint lineage; no reconciliation evidence; a non-MATCH matcher result; an unknown `observedEnvelope.worldGeneration`; an empty, invalid, or ambiguous `matchedEdges` set; and a malformed `authorizedScope.exactInput`. **Ambiguity refuses too**: with several matched edges, which one is the service entry is not derivable from durable evidence alone, so the read fails closed rather than picking one.

**Ownership (2026-09-21).** `authorizedScope.owner.ownerType` must be `TASK` and `ownerId` must equal the current `ROAD_CONNECTION` task's id. A command with a valid match that belongs to another task or tranche is refused, never substituted.

**Lineage (2026-09-21) — generation is not the gate, and a periodic save is not a rollback.** The native generation is load-scoped and changes on every reload/re-attach, so `observedEnvelope.worldGeneration` is observation metadata only. The authority gate is durable **checkpoint ancestry plus survival**, reusing machinery that already exists:

| Condition | Rule | Source of the rule |
|---|---|---|
| Ancestry | boundary is the checkpoint the command was recorded against, **or** a `PERIODIC` checkpoint of this world with `journalPosition >= entry.position` | `recordCheckpoint` marks certified saves `PERIODIC`; `createContinuationFromCheckpoint` already cuts state with `position <= journalPosition` |
| Survival | `position <= boundary.journalPosition`, **or** live on the recorded checkpoint in the current generation | a load-context checkpoint's `journalPosition` is only where the store stood at first sight, so it is not descent evidence |
| Not rolled back | `!canClassifyCommandRolledBack(entry)` | the existing classification. Redundant given the two above, kept explicit so a future loosening of survival cannot silently drop the rollback gate |

`durableLineage` returns `boundaryCheckpointId` and `proof` (`CERTIFIED_CHECKPOINT_CONTAINS_COMMAND` / `LIVE_ON_RECORDED_CHECKPOINT`) so the conclusion is auditable. A periodic save therefore keeps certified evidence valid; a rollback behind the command, a sibling or unrelated save, a different world, and unprovable lineage all fail closed. No second checkpoint graph exists.

**Behaviour change from the first wiring round, deliberate:** restarting onto a save taken *before* the road was built is a genuine rollback — the repository's own `canClassifyCommandRolledBack` says so — and now fails closed. The case that passes is a restart onto the **latest descendant** save. Recorded limitations: a save taken while the world is quarantined is still recorded as a descendant (the save path in `main-adapters.ts` does not check `blockedReason`), and the narrow "reload onto an earlier checkpoint while a later cover exists" case is not revoked, because `canClassifyCommandRolledBack` is deliberately narrow about automatic rollbacks.

### Renderer reachability

`preload.ts` exposes `productionReadiness`, `advanceGate1`, `k05Preflight`, and — added 2026-09-21 — `dispatchProductionSkill(intent)`, which invokes the one existing `ai-mayor-production-skill` handler. Skill dispatch is therefore reachable from the renderer with no debugger client. Only the intent crosses the boundary; no runtime, registry, or workflow object is exposed. `src/renderer/preload.d.ts` types it through `ElectronHandler`. `ensureProjectAdmission` is still absent from preload, and does not need to be: admission is reached through `authoritativeContext()`'s own `ensureFirstProject()` call.

## 6. Boundary map

### Bridge

Bridge provides transport and authoritative payloads such as `cs2_game_state`, `cs2_city_overview`, spatial scans, and native tool calls. HTTP/transport success is not world completion.

### Semantic Native execution

The V2 main adapter submits semantic CS2 utility work and consumes native completion/readback evidence. This is the K05 execution boundary.

### Control Layer

Control Layer governs supported low-level action sequence execution, FSM checkpoints, and observation. It does not own utility durable identity, project admission, or topology reconciliation.

### Mouse20

Mouse20 is a virtual mouse device and lifecycle. Its baseline is frozen and it is not required for K05 semantic execution.

## 7. Harness versus production

`scripts/local-v2-gate1-battlefield.ts` is a battlefield harness. It is not a production caller. Its preparation logic was extracted to `buildUtilityPreparationInput`, and both harness and K05 now depend on the production builder. Its `intentId = intent:local-v2-gate1:${Date.now()}` is harness-only and is not an authoritative identity.

`scripts/project-admission-live-preflight.ts` is a read-only live probe, not a production caller. It imports the production seam rather than reimplementing it, but it uses a throwaway in-memory durable store, never calls `ensureDurableWorld`'s baseline-save branch, and asserts afterwards that no native action tool was invoked. It is not a bootstrap for a live Gate 1 state: `AUTHORITATIVE_GATE1_STATE_CREATED` from that script means "in memory, for observation only".

Production admission must be reached through `MayorRuntime.ensureProjectAdmission()` / `V2ProductionSkillRuntime.ensureProjectAdmission()` over the real Electron Store. No harness may write the live durable project state.

### Production-observable seams

These are the channels a live certification may use. They run inside the production renderer and reach the production main process; a debugger attached to that renderer is a *driver*, not a durable owner.

| Seam | Reaches |
|---|---|
| `window.electron.aiMayor.start(options)` → `ai-mayor-start` | `MayorRuntime.start()` → V2 `initialize()` → `ensureDurableWorld()` + `ensureFirstProject()` |
| `window.electron.aiMayor.productionReadiness()` → `ai-mayor-production-readiness` | authoritative context `{ state: Gate1State, world, treasury }` |
| `window.electron.aiMayor.getState()` → `ai-mayor-state` | session snapshot |
| `window.electron.store.get(key)` → `get-store` | the same `new Store()` instance that backs `aiMayorV2DurableState` |

`MayorRuntime.ensureProjectAdmission()` exists but has **no** IPC handler and is not exposed in `preload.ts`; from the renderer, admission is reached only through `authoritativeContext()`'s own `ensureFirstProject()` call. `ai-mayor-production-skill` has an IPC handler but is likewise absent from `preload.ts`, so a renderer-driven K05 dispatch is not currently possible. Both are wiring gaps, not blockers for this round.

Driving note: `npm run dev` launches Electron with `--inspect=33078` only. To attach a CDP driver to the renderer, launch the built app from `output/` with `--remote-debugging-port=9222` added. `output/main.cjs` must be rebuilt (`npm run dev:build`) whenever `src/main` is newer than it, or the certification runs against stale code.

Correct dependency direction:

```text
production V2 modules
  ↑
battlefield harness
```

Production must never import the battlefield script.

## 8. Build, tests, deploy, live gate

### Targeted suites

- `k05-commission-utilities-workflow.spec.ts`
- `v2-production-skill-runtime.spec.ts`
- `skill-runtime.spec.ts`
- `skill-execution-adapter.spec.ts`
- `mayor-runtime.spec.ts`
- `main-adapters.spec.ts`
- `v2-foundation.spec.ts`
- `v2-greenfield-lifecycle.spec.ts`
- `v2-utility-execution-planner.spec.ts`
- `v2-utility-service.spec.ts`
- `utility-recovery.spec.ts`
- `v2-local-gate1-production-wiring.spec.ts`
- `v2-project-admission.spec.ts`
- `v2-gate1-progression.spec.ts`
- `v2-gate1-progression-boundary.spec.ts`

Latest consolidated result (**2026-09-23**): 84 suites / 1171 tests, **all passing (0 FAIL)**. That supersedes the older 65 / 834 with 12 `PRE_EXISTING_IDENTICAL` topology-fixture failures in `v2-greenfield-utility-bootstrap.spec.ts` recorded here previously — those failures no longer reproduce in this tree. The only TypeScript diagnostic in the files touched by the 2026-09-23 ordering round is the pre-existing `TS2367` on `greenfield-utility-bootstrap.ts`'s `current.commandOutcome === "SUBMITTED"` comparison; repository-wide count is 372, and no clean before/after count was taken, so that is evidence rather than proof.

Added 2026-09-21 in the checkpoint-ancestry round:

- `v2-certified-road-delivery.spec.ts` (30 total) — the ten required durability scenarios run against a real `V2DurabilityCoordinator` checkpoint state machine, driven through `recordCheckpoint` for periodic saves and `activate` for reloads: unchanged boundary, one periodic descendant, several descendants, and a restart onto the latest descendant all certify; a rollback behind the command, a sibling save, another world's save in the same store, a different world identity, a transient boundary, and a command whose rollback classification proves revocation all fail closed. Owner binding (missing / non-`TASK` / wrong task), `matchedEdges`, evidence selection, and `exactInput` validation are covered alongside.

Added 2026-09-21 in the durability round (19 tests, all passing) — same file, superseded cases replaced:

- `v2-certified-road-delivery.spec.ts` — every case runs against a real `V2DurabilityCoordinator`, so the durable lineage gate is exercised as a state machine rather than a fixture.
- `v2-first-facility-placement-durability.spec.ts` (10) — the durable decision table, plus the crash window end to end over the real admission builder, planner, `runScopedGreenfieldUtilityBootstrap` and `executeSharedUtilityRecovery`: a placement survives a restart and blocks a second one even when nothing is visible; a simulated crash before the durable completion still yields exactly one placement; an UNKNOWN submission holds the scope; a proven terminal failure with no mutation permits a new attempt; an existing facility is rebound; another project/tranche inherits nothing; and the durable placement command is written before any native placement.

Added in the preceding wiring round (39 tests, all passing):

- `v2-certified-road-delivery.spec.ts` — the durable-evidence read: the happy path plus every fail-closed reason (wrong command, wrong tranche lineage, wrong world generation, empty/ambiguous matched edges, non-ROAD command, non-certified status, missing evidence, malformed input, PRE_SUBMIT decoy ignored).
- `v2-first-placement-authorization.spec.ts` — authorized first placement admits a `GREENFIELD_FIRST_PLACEMENT` scope and sends nothing; unauthorized placement fails closed; an existing facility rebinds instead of being replaced; a connection-only request never receives authority; every authorization mismatch is discarded; over-budget and out-of-reservation placements refuse; a blocked prepare never reaches `run()`; and a duplicate production dispatch places exactly one facility (the second run reaches real `executeSharedUtilityRecovery` as a connection, not a placement).
- `preload-production-skill-seam.spec.ts` — the renderer seam hits the single existing `ai-mayor-production-skill` IPC channel, and no runtime/registry/workflow object is exposed.

Repository-wide TypeScript checking still has unrelated dependency/legacy errors; targeted AI Mayor suites are the current gate. The changed and added `src` files introduce no new diagnostics.

The repository desktop path is `npm run dev` for the development composition and the existing build/deploy scripts for packaged output. Starting Electron is not sufficient; the formal renderer IPC start must be observed.

### Live preflight order

1. MayorRuntime running.
2. V2 runtime initialized.
3. Bridge online.
4. CS2 `Game`, city loaded, world ready.
5. NativeWorldIdentity and checkpoint lineage available (durably ACTIVATED, not just observed).
6. Project admission: `projectState === PLACEHOLDER` → `ensureFirstProject()` → durable `Gate1State`. An already admitted project returns `ALREADY_ADMITTED` unchanged.
7. Gate1State available and valid.
8. Treasury/budget available.
9. Recipe capability available.
10. `buildUtilityPreparationInput` passes (requires tranche at `ROAD_DELIVERED`).
11. `greenfieldUtilityBootstrap.prepare` passes.
12. Durable utility state clean; native operation Idle; unresolved mutation count zero.
13. Only then allow one bounded mutation.

Steps 1–11 are now observed live. The production Gate 1 owner advances the durable project `PLANNED → SITE_SELECTED → ROAD_DELIVERED` through the real State Machine (one native ROAD command reaching `OBSERVED_MATCH`), and `buildUtilityPreparationInput` passes at that stage. Step 12 is the precondition for the first bounded mutation, which has not been run. Nothing on this path may be satisfied by hand-editing the stage, relaxing the check, or routing through `scripts/local-v2-gate1-battlefield.ts`.

A read-only preflight that must not take a baseline save can stop at step 5: if the world reports `BASELINE_CHECKPOINT_REQUIRED`, no durable lineage exists, so step 6 legitimately refuses and no project identity may be derived. `scripts/project-admission-live-preflight.ts` is that read-only probe; it uses a throwaway in-memory durable store and asserts the MCP call log contains no native action tool. Note that a world which loads **with** checkpoint identity does not report `BASELINE_CHECKPOINT_REQUIRED` at all and activates in place, so this probe's refusal branch only exercises the first-enable legacy case.

If native completion becomes UNKNOWN, do not resubmit. Reconcile only and preserve UNKNOWN until authoritative outcome is known.

## 9. Known baseline debt

The full `v2-greenfield-utility-bootstrap.spec.ts` suite has 12 `PRE_EXISTING_IDENTICAL` topology matcher fixture failures. They use old fixture topology/prefab assumptions and are unrelated to the canonical Basic Electricity / WindTurbine live recipe. They are baseline debt, not permission to weaken reconciliation.

## 10. Runtime lifecycle contract

### Start

`MayorRuntime.start()` is the product session boundary.

It validates the goal and budget options.

It creates one session identity.

It resets per-session local state.

It initializes the V2 production runtime.

It does not call DeepSeek by itself.

It does not call `executeActions` by itself.

It does not submit K05.

It does not create a fake Gate1State.

Repeated start while running returns the current session snapshot.

### Stop

`MayorRuntime.stop()` marks the session stopped.

It aborts the session signal.

It waits for bounded in-flight work.

It finalizes the Mayor session.

It disposes the V2 production runtime.

It does not delete durable V2 state.

It does not mark UNKNOWN work successful.

### Reload

Electron reload reconstructs the main composition.

The old V2 runtime is disposed with the old Mayor session.

The new composition creates one registry.

K05 is registered once in that registry.

Old readiness promises are discarded.

Old context references are not reused.

Durable state remains in the configured storage and is revalidated on activation.

## 11. Runtime status vocabulary

`Electron online` means the desktop process exists.

`Bridge online` means the Bridge transport answers.

`MayorRuntime running` means a Mayor session has status `running`.

`V2 initialized` means `v2ProductionSkillRuntime.initialize()` completed.

`Skill registered` means registry membership exists.

`Context ready` means authoritative activation and context reads succeeded.

`Preparation ready` means utility admission passed.

`Native complete` means native completion evidence is terminal.

`Reconciled` means world readback matches the admitted intended effect.

These statuses must not be collapsed into one `ready` boolean.

## 12. Context provider contract

The provider is created by the main-adapter composition.

It uses the V2 foundation, not battlefield code.

It invokes the existing durable-world activation boundary.

It reads `projectState()` from the durability coordinator.

It requires the full Gate1 schema.

It reads treasury from `cs2_city_overview`.

It returns the activation world identity.

It fails if durability is unavailable.

It fails if activation is blocked.

It fails if project state is a placeholder.

It fails if treasury is not finite.

It never fills missing IDs with UUIDs.

It never copies IDs from a prior test.

It never reads a battlefield report as state.

It never turns a stale checkpoint into a current checkpoint.

The readiness query only reads this context.

The readiness query does not call utility `run()`.

## 13. Field provenance checklist

`Gate1State` comes from the durability coordinator's validated project state.

`intentId` comes from `state.intent.id`.

`projectId` comes from `state.project.id`.

`trancheId` comes from `state.tranche.id`.

`reservationRef` comes from the tranche/district reservation contract.

`NativeWorldIdentity` comes from `cs2_game_state` parsing.

`worldId` comes from native world identity.

`worldEpochId` comes from native world identity.

`generation` comes from native world identity.

`topologyRevision` is the preserved generation-derived production revision.

`spatialEnvelope` comes from the admitted project utility reservation.

`maximumBudget` comes from the project state.

`treasury` comes from the authoritative city overview.

`maximumSpend` is the bounded minimum of budget and treasury.

`budget/admission` is enforced by existing V2 preparation and finance paths.

No field is sourced from a prompt.

No field is sourced from a rendered UI.

No field is sourced from a test snapshot.

## 14. Checkpoint field rules

`checkpointId` identifies the native save/load checkpoint.

`worldId` identifies the current CS2 session world.

`nativeSessionGuid` identifies the native session.

`worldEpochId` scopes a runtime world lineage.

`generation` scopes the observed generation.

`bridgeRuntimeEpoch` identifies the Bridge runtime epoch.

`loadedCheckpointId` records what the world reported on load.

`rollbackBoundaryId` records the durable action boundary.

`journalPosition` bounds inherited command history.

`saveMetadataAssetGuid` and `saveDataAssetGuid` bind the verified save assets.

`purpose` distinguishes baseline and normal checkpoint records.

`durable` distinguishes verified native persistence.

These values are cross-checked during activation and checkpoint recording.

Missing `checkpointId` on a loaded game is not equivalent to a transient checkpoint, except for the `legacyOnboardingCandidate` first-enable case (no `checkpointId` and no `saveDataAssetGuid`).

The transient fallback used by `activate()` does not remove the parser's loaded-save requirement; a bound save-data asset without a checkpoint identity remains fail-closed.

## 15. Existing legal recovery capabilities

Same-world reconnect is supported when identity matches.

Same-save reload checks the loaded checkpoint.

Same-save reload keeps the recorded project state unless the bound checkpoint proves the journaled work is gone: a command of this world with `baseCheckpointId === rollbackBoundaryId`, `position > boundary.journalPosition`, a different `worldEpochId`, and no later checkpoint with `journalPosition >= position`. When that proof holds the boundary snapshot (`PLACEHOLDER` for a load-context record) is restored, which is the same survival proof `commandJournal.durableLineage()` uses, so a project state can never claim work its commands cannot prove.

Different save lineage is classified, not silently merged.

Unknown checkpoints in known worlds are quarantined.

Certified rollback anchors can restore registered durable state.

Continuation requires a registered checkpoint and matching save assets.

Native completion can be reconciled by existing effect readers.

Save completion is polled until terminal.

Unknown save completion remains blocking.

First-enable legacy onboarding is supported: an uninitialized `LoadGame` (`checkpointId === null` and `saveDataAssetGuid === null`) is admitted and receives a certified baseline through the existing save/checkpoint path.

No general legacy-save checkpoint migration is present.

No automatic arbitrary-save rebind is present.

No Skill-layer recovery is permitted.

A corrupt load (a bound save-data asset with no checkpoint identity) still fails closed.

Each world may hold one certified baseline; switching worlds neither inherits nor overwrites another world's baseline.

Any future migration must be a separate durability decision, not a document assumption.

## 16. Utility durable vocabulary

`DurableUtilityKindState` records utility progress.

The candidate ledger records selected/available candidate context.

Authorization records whether the operation may proceed.

The command journal records submission/outcome identity.

Facility identity binds placed service facilities.

Network identity binds connection effects.

Recovery selects a utility-specific repair path.

Topology reconciliation checks observed connection structure.

Evidence records completion and scope markers.

`connectionOnly` is utility workflow policy.

`selectedPrimitive` is utility workflow context.

Neither belongs in the generic Skill dispatcher.

## 17. Failure and UNKNOWN handling

Prepare failure returns a blocked/failed Skill result.

Run waiting returns WAITING, not SUCCESS.

Native failure returns failure evidence.

Transport UNKNOWN returns unresolved/unknown state.

Reconciliation runs against the original scope.

No automatic duplicate submission occurs.

Recovery cannot invent a missing world identity.

An observation gap is not completion.

An API `ok` field is not completion.

An old evidence record is not current-world evidence.

## 18. Test reading guide

K05 workflow tests cover builder and prepare/run delegation.

V2 production runtime tests cover one registry and lifecycle reset.

Skill runtime tests cover compile/registry behavior.

Skill execution adapter tests cover the experimental path only.

Mayor runtime tests cover start/stop/idempotence.

Main adapter tests cover production composition behavior.

Foundation tests cover V2 ports.

Greenfield lifecycle tests cover durable utility lifecycle.

Utility planner/service tests cover planning boundaries.

Recovery tests cover recovery semantics.

Battlefield wiring tests ensure the harness uses production seams.

A passing test that calls an adapter directly is not production evidence.

An integration test must enter through the production dispatcher.

Live proof must use live Bridge/CS2 evidence.

## 19. Quick implementation checklist

Read this map first.

Find the existing composition root.

Find the existing MayorRuntime lifecycle.

Find the single production registry.

Find the registered workflow.

Find the authoritative context provider.

Trace every identity field to its source.

Check checkpoint lineage before planning.

Check durable state before native work.

Check operation Idle before submission.

Count submissions.

Never retry UNKNOWN.

Reconcile before deciding outcome.

Update CURRENT_STATUS after every gate.

## 20. Production Gate 1 lifecycle

The production owner that advances an admitted `Gate1State` through the existing State Machine. It was added because `projectAdmission` could create a Gate 1 project but nothing in production could move its `tranche.stage`.

```text
MayorRuntime.advanceGate1ToStage(milestone)
  -> preload aiMayor.advanceGate1(milestone)
  -> ipcMain "ai-mayor-gate1-progression"
  -> V2Gate1Progression.advanceToStage()
  -> createV2LocalGate1FoundationRunner()      # unchanged production composition
  -> V2LocalGate1ProductionRunner.tick()       # reused unmodified
  -> createGate1VerticalSlice()                # the State Machine
  -> boundary.execute(admitted)                # V2Gate1ProgressionBoundary
  -> foundation.road.execute()                 # native ROAD
```

| Component | Location |
|---|---|
| lifecycle owner | `src/main/services/ai-mayor/v2/gate1-progression.ts` |
| production boundary | `src/main/services/ai-mayor/v2/gate1-progression-boundary.ts` |
| composition | `createMainMayorPorts` in `src/main/services/ai-mayor/main-adapters.ts` → `MayorRuntimePorts.v2Gate1Progression` |
| runtime entries | `MayorRuntime.advanceGate1ToStage()`, `MayorRuntime.productionK05Preflight()` |
| IPC / preload | `ai-mayor-gate1-progression`, `ai-mayor-k05-preflight` / `aiMayor.advanceGate1`, `aiMayor.k05Preflight` |

Contract rules:

- The owner never writes `tranche.stage`. Reaching a stage is entirely `createGate1VerticalSlice`'s decision; the owner only decides when to stop asking.
- It contains no Skill branch. `advanceToStage(milestone)` is generic over any linear stage.
- `MILESTONE_REACHED` requires `stageIndex(stage) >= stageIndex(milestone)`. `DIAGNOSING` and `RECOVERING` are not linear stages and can never satisfy a milestone.
- Re-entering with the milestone already satisfied returns `MILESTONE_REACHED` with zero decisions and zero native calls.
- `NOT_ADMITTED` means the world has no durable `Gate1State`; nothing is created and nothing is advanced.
- `maximumDecisions` (default 32) and `maximumWakeIterations` (default 3) bound the loop.

The boundary's ROAD resolver: the persisted state keeps only `tranche.target`, so the resolver replays the deterministic `evaluateBoundedStarterSites` evaluation the admission ran — anchors within 150 m of the target, bounded detail per anchor, the same admission policy constants — and matches the persisted target within 0.01 m. No match or an ambiguous match throws `GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED`. It never guesses geometry. `ZONE_RESIDENTIAL` throws `Gate1ProgressionCapabilityGapError("ZONING")`, and the owner maps it to `CAPABILITY_GAP`. No recovery resolver is supplied.

`V2ProductionSkillRuntime.invalidateReadiness()` exists because the authoritative context is memoized at session start; without it, `productionReadiness()` and Skill dispatch would keep serving the pre-progression snapshot after the State Machine advanced.

## Canonical V2 durable storage

`src/main/services/ai-mayor/v2/durable-storage.ts` owns the V2 storage identity. The canonical file is `%APPDATA%\\5ire\\ai-mayor-v2.json`; it is separate from Electron's default `config.json` so packaged 5ire, development 5ire, and direct Electron launches share one V2 state file. Legacy discovery reads only `aiMayorV2DurableState` from known profiles and preserves all source files. Migration is atomic through `electron-store`, canonical state wins, and unresolved legacy ambiguity fails closed.

## P0 next: SAVE_AND_ROLLBACK_SOVEREIGNTY

`CURRENT_GAME_WORLD_IS_AUTHORITY`. The game world, not the AI durable memory, is the authority.

- Default: the AI Mayor never forces a CS2 save. Saving is the player's decision to make or to skip.
- A player may quit without saving, reload any earlier save, switch between existing saves, and deliberately roll back AI-completed work. None of that is an error and none of it may corrupt the AI Mayor.
- When an old save removes earlier AI mutations, durability and reconciliation must recognise a real rollback, revoke the corresponding AI authority, reduce the project to the stage the current world actually corresponds to, and let the Local Mayor replan and continue from the current world.
- Durable memory is never pushed onto a world that does not contain the certified effect, and certified lineage is never preserved by *making* a save.
- Automatic saving is an explicit user opt-in only. It is never a correctness precondition.

Known blocker to fix under this policy: `FORCED_SAVE_ON_STOP` - `MayorRuntime.stop()` -> `#finalize()` unconditionally calls `ports.save()`, i.e. `cs2_save_game` on every Stop and on every `#halt()` path. That default is exactly what this policy forbids; it is recorded here and deliberately not implemented this round.

## K05 continuation seam (2026-09-21)

- `MayorRuntime.resumeInFlightProductionSkill()` (`src/main/services/ai-mayor/runtime.ts`) re-enters the production dispatch (`skill.K05`) only while durable `tranche.utilityExecution` holds a kind that has not reached `SERVICE_CERTIFIED` after having attempted something. Bounded to 12 attempts per session; refuses when the session is not running, so a clean scope is never picked up.
- Seam: `ai-mayor-production-skill-resume` (main) -> `aiMayor.resumeProductionSkill()` (preload) -> overlay polls while such an operation exists. This is how an in-flight K05 continues without a new user dispatch.
- `commandOutcome` in `v2/greenfield-utility-bootstrap.ts` describes network commands only; a first-facility placement is tracked by `facilityCommandId` plus the durable placement guard.
- First-facility placement reconciliation is `reconcileDurableCommand` (UTILITY branch, `place_building` readback via `cs2_list_buildings`, tolerance 1 m), executed by `requireActivatedDurableWorld` before any world write.

## Bounded connection-course replan (2026-09-21)

A deterministic native verdict refuses one *course*, not the objective. When every approved connection candidate has reached a terminal verdict, the workflow re-derives a replacement from the current authoritative topology instead of dead-ending at `UTILITY_CONNECTION_CANDIDATES_EXHAUSTED`. It lives entirely in `v2/greenfield-utility-bootstrap.ts` and reuses the existing candidate ledger, connection objective, durable command journal, connection planner and execution seam.

```text
candidate A: admitted -> native -> authoritative PROVEN_MISMATCH
  -> A ledgerState = FAILED_DETERMINISTIC   (durable, never revived, never re-submitted)
  -> no attemptable candidate remains
  -> canReplanConnectionCourse():  plan/facility/connector bound
                                   && replanCount < maximumReplans
                                   && some candidate is FAILED_DETERMINISTIC
  -> replanConnectionCourse():     buildUtilityConnectionCandidates(plan, connector)   # current topology
                                   filter  actionFingerprint NOT already attempted
                                   filter  isAttemptable(current policy)
                                   -> approvedPlanRevision = "<previous>:replan:<n>"
                                   -> new objectiveId / candidateId, appended NOT_ATTEMPTED
  -> candidate B admitted -> preflight -> native -> reconciliation   (the normal path)
```

| Piece | Rule |
|---|---|
| `DurableConnectionCourseReplan` | `replanCount` / `maximumReplans = 2` / `journal`; same shape as `DurableConnectionPrimitiveFallbackRecovery`; backfilled by `initialKind` and `normalizeKindState` |
| `canReplanConnectionCourse()` | budget unspent **and** ≥1 `FAILED_DETERMINISTIC` candidate **and** a live plan/facility/connector binding |
| course identity | the **action fingerprint**. Every ledger entry whose `ledgerState !== "NOT_ATTEMPTED"` — refused, preflight-rejected, in flight, `OBSERVED_MATCH` — revokes that course. `candidateId` / `objectiveId` / `approvedPlanRevision` are deliberately **not** part of the key, so re-minting identity cannot resurrect attempted geometry |
| primitive eligibility | the caller's own predicate (`isAttemptable`, the same one the selection uses), so a primitive the current policy would never attempt cannot be passed off as a new course |
| new revision | `"<previous>:replan:<n>"` — the generation-derived production revision plus the bounded ordinal. Deterministic and durable: no wall clock, no randomness, no LLM |
| no new course | the replan is **refused**, the refusal consumes the bounded budget, and the objective terminates at `UTILITY_CONNECTION_CANDIDATES_EXHAUSTED`. It does not loop and does not mint |
| candidate A | keeps `FAILED_DETERMINISTIC` and its original `commandId` across restart/resume; never revived, never re-submitted |

Tests: `test/ai-mayor/v2-k05-connection-replan.spec.ts` (4). Full `test/ai-mayor`: 69 suites / 872 tests, 872 PASS, 0 FAIL.

**Live-verified in Attempt 2 (2026-09-21).** After `npm run build` (Electron native ABI intact) and a dev-instance restart, the resume seam exercised the transition in the real product. `connectionReplan` was backfilled from a pre-change record, the replan was **refused** twice (`replanCount = 2 / 2`, `CONNECTION_COURSE_REPLAN_NOT_DISTINCT`, `candidateIds = []`), and the run ended at `stage = BLOCKED` / `UTILITY_CONNECTION_CANDIDATES_EXHAUSTED`. `commands` and `journalPosition` stayed at 4 throughout: **zero native mutation**. Candidate A kept its original `commandId` as `FAILED_DETERMINISTIC` and was never resubmitted; the ledger stayed at 2 entries.

This is the refusal path, and it is the correct verdict for this world rather than a planner shortfall: `direct-cable` is fully determined by the approved plan — start pinned to `connector.worldPosition`, end pinned to `targetSemantics.approvedContact` — so re-derivation reproduces the refused course byte for byte (independently confirmed against the durable command journal's refused `build_road` action), and `service-road` is placement-phase, hence ineligible once a facility exists. No distinct, policy-eligible course remains.

## State-machine ordering: an actionable repair outranks a passive wait (2026-09-23)

`runScopedGreenfieldUtilityBootstrap` asks its questions in the order that answers them. Within one bounded invocation, for each commissioned family:

```text
rebind generation-scoped bindings      (unchanged)
observe                                (unchanged)
commandOutcome resolution              (unchanged)
certified? -> SERVICE_CERTIFIED        (unchanged)
observation UNKNOWN / uncertainty      -> reconciliation hold  (unchanged, and first)
binding staleness check -> admit the plan if there is none
syncCandidateCommands / ensureCandidateLedger / mechanism revision / rearm
unresolved candidate                   -> reconciliation hold
ensureFacilityAccessRoadRepair         -> plans at most one bounded repair course
  repairStillRequired?  =  an unspent FACILITY_ACCESS_ROAD course exists in the ledger
                        && facilityAccessRoadWorldPrecondition(the authoritative world read)
if (!repairStillRequired) -> the passive wait / observation budget  (unchanged)
selection -> exhaustion checks -> execute
```

The invariant: **the passive service wait is entered only when this slice holds no unspent repair course that the engine still says it needs.** A facility with no road frontage has no low-voltage electricity either — this engine carries it along the road network — so the service cannot appear however long the workflow waits; parking there is a dead end a later invocation only escapes by discarding the authority it was waiting under.

- Both halves fail closed in their own direction: an unspent course with no readable world does **not** skip the wait, and a world that no longer reports the frontage missing does **not** skip it either.
- The three world clauses (frontage `NONE`, `No Road Access`, city power sufficient) live once, in `facilityAccessRoadWorldPrecondition` (`v2/facility-access-road.ts`), and are shared by the repair verdict and this gate. The verdict re-derives its per-clause refusal text from the same predicate, so the two cannot drift.
- The observation-wait budget bounds the *wait*; it does not revoke authority. While a repair course is unspent it no longer clears `plan` / `planBinding`, so it cannot drop a facility-bearing slice back into greenfield planning. The discard-and-re-derive the branch exists for still happens — **in the same invocation**, via the local `admitPlan()` closure — whenever no repair is pending.
- `unspentAccessRoadRepairCourse` is exported: a course that carries a command id, or that has left `NOT_ATTEMPTED`, is spent or in flight and is never offered as actionable.
- The bounded repair is marked `ATTEMPTED` on the durable record only when its course actually reached the engine (`networkSubmissionAttempted || commandId !== null` — the latter because the write-ahead command identity is minted immediately before submission, so a crash inside that window stays fail-closed). A live-binding precondition refusal leaves both the ledger entry and the record unspent.

Known open gap: **`GATE1_FACILITY_ACCESS_ROAD_COURSE_NOT_REANCHORED_ON_PLAN_CHANGE`** — the repair course is derived from the plan's own corridor and then kept forever, so a plan the product legitimately re-derives leaves the ledger holding a course anchored to geometry the durable state no longer contains, plus an amendment priced for it. See `evidence/water-phase7-stale-repair-course-blocker-2026-09-23.md`.

Tests: `test/ai-mayor/v2-facility-access-road.spec.ts` describe `an actionable repair outranks the passive service wait`; `test/ai-mayor/water-phase7-driver.spec.ts` guards the driver's payload parsing, teardown and bounded mandate.

### Direct-cable endpoint contract: root cause (2026-09-21, source-level differential, no live mutation)

`CABLE_ENDPOINT_CONTRACT_EXPRESSIVENESS` was investigated as an evidence differential only. Five sources were compared field by field: the refused command `fa032a75-9676-44da-828b-1951f670a74e` in the durable journal, the saved Golden Route B native contract, the current Bridge `build_road` path, the facility connector readback, and the target road contact.

| Field | Refused cable (`fa032a75`) | Golden Route B |
|---|---|---|
| prefab | `"Low-voltage Ground Cable"` (Bridge hardcode, `spatial/types.ts:207`) | `"Low-voltage Line"` = `{15967,1}` |
| start | `(x1,z1)` = connector `45583:17` worldPosition; **no `startEndpoint` emitted at all** | `netCourse.Start {Entity: null, Flags: 51}` |
| end | `endEndpoint.kind = "NEW_FREE_ENDPOINT"`, `entity: null`, plus `geometricContact {roadEdge 45586:13, roadNode 56051:1}` and `topologyExpectation {flowNode 185860:1, expectedReachability ELECTRICITY}` | `netCourse.End {Entity: null, Flags: 51}` |
| flags | none emitted by the Bridge; native `preSplitEnd.Flags = 51` (`IsFirst, IsLast, IsRight, IsLeft`) | `CreationDefinition.Flags = 65536`, course flags `51` |
| curve | one straight 2-point chord; no `CurveA..D`, no `Length`, no `SplitPosition` | full Bezier `m_Curve`, `Length 442.661743`, `FixedIndex -1`, `CourseDelta 0.0 -> 1.0` |

Native honoured the prefab (both realised edges `45612:469` / `45619:469` are `Low-voltage Ground Cable`), honoured the geometry (the two edges total 129.728 m against 129.73 m requested, split at the exact midpoint), and produced course flags already Native-equivalent to Golden Route B (`51`). Those three are therefore **not** the defect.

The defect is the binding, and it is not fixable on the TypeScript side. `BridgeToolSystem.CreateRoadDefinitions` enters the electricity branch **only** when `kind == "NEW_FREE_ENDPOINT" && utility == "ELECTRICITY"`, and treats a non-null entity as a hard error (`ELECTRICITY_FREE_ENDPOINT_ENTITY_UNSUPPORTED`); `attachedEnd` stays `Entity.Null` and `course.m_EndPosition.m_Entity = attachedEnd`. The road node is retained **only** as `electricityContactNode` and used as a `LocalConnect` patch target. So `ELECTRICITY_DUAL_IDENTITY` is dual in name only: `courseEndpoint.entity` is null by contract, and the electrical half of the identity is meant to be realised by the `LocalConnect` write, not by the course.

Native resolved the endpoint to a brand-new node `45604:469` at the road node's position (`remapResult "NATIVE_FREE_ENDPOINT"`, `postApply.finalMatchesRequested false`) with `electricityNodeConnectionPresent: true` but `exactGraphRelation: []`, `networkConnected: false`, `sourcePhysicalNode: null`, `visitedNodeCount: 0`, `targetNetworkReachableFailureReason: "SOURCE_FLOW_NODE_MISSING"`. The Bridge's own `matchCablePrimitiveEffect` then requires the chain to terminate at the authoritative target node `56051:1`; the realised chain is `45601:471 -> 45612:469 -> 45602:471 -> 45619:469 -> 45604:469`, terminating at `45604:469`, so `paths = []` and the verdict is `PROVEN_MISMATCH` / `complete bounded cable scan proves no exact continuous cable chain`.

`SOURCE_FLOW_NODE_MISSING` reproduces in every saved electricity attempt across at least two worlds (`3d206ee9596e4315b64cc55dd81a607b`, `84de03146f72464580135e316822ff7e`), so it is a stable structural defect, not a world quirk.

The one missing piece of evidence is native-side: which eligibility branch in `CourseSplitLocalConnectMembershipSystem.OnUpdate` returns before its ECB write. The ASTRA source packet §8 (absorbed into canonical docs, 2026-09-22) recorded `SYSTEM_TICKED=YES / PATCH_BRANCH_ENTERED=YES / ECB_COMMAND_RECORDED=NO / TARGET_ROAD_LOCAL_CONNECT_ENQUEUED=FALSE / TARGET_ROAD_PRESENT_IN_CANDIDATES=FALSE / FIRST_CONFIRMED_FAILURE=ECB_COMMAND_NOT_RECORDED / ROOT_CAUSE_PROVEN=NO`, and none of that telemetry is persisted in this repo (repo-wide grep for `localConnectFirstFailureStage` / `ECB_COMMAND_RECORDED` finds nothing). Adding a bound-endpoint or alternative-geometry TypeScript primitive is **not** justified: the Bridge rejects a bound entity outright, so such a primitive would be refused at `APPLY_GUARD`, and the evidence shows prefab, flags and geometry are already honoured.

