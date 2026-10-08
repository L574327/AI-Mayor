# CONTROL_PLANE_SOURCE_PACKET

Read-only source extraction for the Gate1 Road task, concrete Road child operation, current-branch project replan, task replacement, and native-preview pre-veto path. Snippets below are copied from production sources at the cited locations; explanatory lines identify callers, callees, and the blocking boundary.

## 1. Gate1Task: full definition

**FILE** `src/main/services/ai-mayor/v2/gate1.ts`, lines 70–98  
**FUNCTION** type declarations  
**CALLER / CALLEE** Gate1 planner, admission, progression, durability state  
**Can block** task selection and admission through status, stage, attempt, terminal outcome, and child reference.

```ts
export type Gate1TaskKind =
  | "SITE_SELECTION"
  | "ROAD_CONNECTION"
  | "WAIT_FOR_BUILDING"
  | "UTILITY_PROVISION"
  | "ZONING"
  | "WAIT_OBSERVE"
  | "OCCUPANCY_DIAGNOSIS"
  | "RECOVERY";

export interface Gate1Task {
  id: string;
  trancheId: string;
  kind: Gate1TaskKind;
  legalStage: Gate1Stage;
  status: "PENDING" | "DISPATCHED" | "WAITING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
  attempts: number;
  maximumAttempts: number;
  terminalOutcomeId: string | null;
  activeCommandId?: string | null;
  childOperationAmendmentId?: string;
  supersedesTaskId?: string;
  supersessionReason?: "PLANNER_INPUT_CHANGED";
  previousExactInputHash?: string;
  newExactInputHash?: string;
  newMaterialInputHash?: string;
  replacementKey?: string;
  activeBranchIdentity?: string;
  objectiveId?: string;
}
```

Task construction is single-task-per-kind at initial plan time:

```ts
function task(trancheId: string, kind: Gate1TaskKind, legalStage: Gate1Stage, maximumAttempts = 1): Gate1Task {
  return {
    id: taskId(trancheId, kind), trancheId, kind, legalStage,
    status: "PENDING", attempts: 0, maximumAttempts, terminalOutcomeId: null,
  };
}

const tasks = [
  task(trancheId, "SITE_SELECTION", "PLANNED"),
  task(trancheId, "ROAD_CONNECTION", "SITE_SELECTED", 2),
  task(trancheId, "ZONING", "ROAD_DELIVERED", 2),
  ...
];
```

## 2. Task status transitions and attempts

**FILE** `src/main/services/ai-mayor/v2/gate1.ts`, `createGate1Controller().tick`, lines 1190–1310  
**CALLER / CALLEE** `runLocalGate1Progression` → `current.tick` → `admitGate1Proposal` → `boundary.execute` → `complete`/journal/persist.  
**Can block** no current pending/waiting task at current legal stage returns without proposal; Gate1 rejection sets BLOCKED; execution result determines retry, WAITING, FAILED/BLOCKED, or success.

```ts
const current = state.tasks.find((candidate) =>
  (!state.tranche.currentTaskIds?.[candidate.kind] || state.tranche.currentTaskIds[candidate.kind] === candidate.id) &&
  (candidate.status === "PENDING" || candidate.status === "WAITING") &&
  candidate.legalStage === state.tranche.stage,
);
if (!current) return { state: clone(state), task: null, proposal: null, outcome: null };

const reconciling = current.status === "WAITING" && current.activeCommandId !== null;
...
current.status = "DISPATCHED";
current.attempts += 1;
proposal = proposalFor(state, { ...current, attempts: current.attempts - 1 }, ...);
const decision = admitGate1Proposal(...);
if (decision.admission.decision === "REJECTED") {
  current.status = "BLOCKED";
  state.project.status = "BLOCKED";
  state.intent.status = "BLOCKED";
  ...
  current.terminalOutcomeId = outcome.id;
  persist();
  return ...;
}
...
if (execution.status === "WAITING") {
  current.status = "WAITING";
  current.activeCommandId = execution.commandId;
  if (execution.commandId === null && execution.reason === "WAITING_FOR_NATIVE_BUILD_SLOT")
    current.attempts = Math.max(0, current.attempts - 1);
  ... persist(); return ...;
}
if (execution.status !== "DELIVERED" || effectUncertain) {
  const retryable = execution.status === "REJECTED" && !effectUncertain && current.attempts < current.maximumAttempts;
  current.status = retryable ? "PENDING"
    : execution.status === "UNKNOWN" || effectUncertain ? "BLOCKED" : "FAILED";
  current.activeCommandId = null;
  if (!retryable) { state.project.status = "BLOCKED"; state.intent.status = "BLOCKED"; }
  ...
  if (!retryable) current.terminalOutcomeId = outcome.id;
  persist(); return ...;
}
const complete = (nextStage: Gate1Stage, delivery: boolean) => {
  current.status = "SUCCEEDED";
  current.activeCommandId = null;
  state.tranche.stage = nextStage;
  ...
  current.terminalOutcomeId = outcome.id;
  if (delivery) updateDelivery(state, outcome.id);
};
if (current.kind === "ROAD_CONNECTION") complete("ROAD_DELIVERED", true);
```

The complete status set is `PENDING`, `DISPATCHED`, `WAITING`, `SUCCEEDED`, `FAILED`, `BLOCKED`. For ordinary Road execution, attempts increment immediately before proposal/admission. `WAITING_FOR_NATIVE_BUILD_SLOT` with no command decrements the attempt again. Only `REJECTED` with attempts below `maximumAttempts` returns the task to `PENDING`; unknown execution blocks, exhausted deterministic rejection fails, admission rejection blocks and terminalizes.

The status transition sites in `tick` are:

| From / trigger | New status | Terminal outcome / stage effect |
|---|---|---|
| PENDING or WAITING selected for ordinary execution | DISPATCHED | attempts increment; proposal and Admission run |
| Gate1 Admission rejected | BLOCKED | terminal outcome; project and intent BLOCKED |
| Execution WAITING | WAITING | active command recorded; no-command native-slot wait refunds attempt |
| REJECTED, attempts remain | PENDING | nonterminal outcome; same task can be selected again |
| UNKNOWN or uncertain effect | BLOCKED | terminal outcome; project and intent BLOCKED |
| exhausted REJECTED | FAILED | terminal outcome; project and intent BLOCKED |
| DELIVERED | SUCCEEDED | terminal outcome; `complete` advances stage for task kind |
| one-shot recovery functions | PENDING | clear terminal outcome; selected recoveries may increment `maximumAttempts` and/or restore prior stage |

The same controller also sets `WAIT_FOR_BUILDING` and `WAIT_OBSERVE` to `WAITING` while awaiting evidence, and to `SUCCEEDED`/`FAILED`/`BLOCKED` on their respective observation outcomes. Those branches do not alter Road Connection behavior; their status writes reside in `gate1.ts::tick` after the Road `complete` branch.

Other bounded recovery code can reopen the same task and/or increment its `maximumAttempts`; it does not create route segment tasks. Relevant functions in the same file include `recoverRoadConnectionForStarterFrontage`, `reconcileRestoredRoadFalseDelivery`, `recoverRoadConnectionForContinuationDirection`, and `recoverRoadConnectionForExecutionSemantics` (the first three explicit `maximumAttempts += 1` sites are lines 585, 691, 739; the execution-semantics recovery resets status to PENDING but does not add an attempt in the shown branch).

## 3. Concrete child creation, binding, admission, consumption

### Durable creation

**FILE** `src/main/services/ai-mayor/v2/durability.ts`, `recordUtilityServiceRoadChildOperation`, lines 2347–2422  
**CALLER / CALLEE** `main-adapter.ts` preparation → `utility-budget.ts::recordUtilityServiceRoadChildOperation` → durability coordinator method.  
**Can block** unavailable/stale durable world, project mismatch, invalid exact input/fingerprint, current checkpoint/generation mismatch; deterministic identity conflict.

The method validates current active project/tranche and exact course (`stableRoadInput(exactRoadInput) === courseFingerprint`), then requires active/current world, loaded checkpoint, rollback boundary, and generation to match. Identity is derived from:

```ts
const amendmentId = [UTILITY_SERVICE_ROAD_CHILD_OPERATION_REASON, input.state.project.id,
  input.state.tranche.id, input.planRevision, input.courseFingerprint].map(encodeURIComponent).join(":");
```

An existing amendment with that identity is returned only if project/tranche/revision/fingerprint/world/checkpoint/generation/exact input all match. New child fields include `status: "ACTIVE"`, exact input, course fingerprint, world/checkpoint/generation, `executionUseLimit: 1`, `executionUseStatus: "UNUSED"`.

### Binding to current Gate1 task

**FILE** `src/main/services/ai-mayor/v2/main-adapter.ts`, `greenfieldUtilityBootstrap.prepare`, around lines 3581–3682  
**CALLER / CALLEE** K05/utility prepare → `planScopedUtility` → select `preparedServiceRoads?.[0] ?? utilityPlan?.serviceRoads?.[0]` → durable child/replacement → bind `roadTask.childOperationAmendmentId`.  
**Can block** current branch/checkpoint not proven, missing task, stale/rebound target, incomplete road effect scan, duplicate/overlap/disconnected proposal, terminal task lifecycle, child mismatch, nonattachable task.

The current binding path selects only the first segment:

```ts
const serviceRoad = preparedServiceRoads?.[0] ?? utilityPlan?.serviceRoads?.[0];
...
const exactRoadInput = roadCourseGeometry(plannedRoadSegmentToMayorAction(serviceRoad));
const roadTaskId = durableProject.tranche.currentTaskIds?.ROAD_CONNECTION;
const roadTask = roadTaskId
  ? durableProject.tasks.find((task) => task.id === roadTaskId && task.trancheId === input.trancheId)
  : durableProject.tasks.find((task) => task.trancheId === input.trancheId && task.kind === "ROAD_CONNECTION");
if (!roadTask) throw new Error("UTILITY_SERVICE_ROAD_CHILD_GATE1_TASK_NOT_FOUND");
```

For terminal `BLOCKED`/`FAILED` predecessor, Water-only `ensurePlannerInputReplacement` is invoked after authoritative target rebind and complete road scan. Otherwise, `recordUtilityServiceRoadChildOperation` creates/reuses one child and the single task gets its single child reference:

```ts
if (JSON.stringify(child.exactRoadInput) !== JSON.stringify(exactRoadInput) || child.status !== "ACTIVE" ||
    child.executionUseStatus !== "UNUSED") throw new Error("UTILITY_SERVICE_ROAD_CHILD_CURRENT_BINDING_MISMATCH");
if (!['PENDING','WAITING'].includes(roadTask.status) || roadTask.terminalOutcomeId !== null ||
    (roadTask.childOperationAmendmentId && roadTask.childOperationAmendmentId !== child.amendmentId))
  throw new Error("UTILITY_SERVICE_ROAD_CHILD_GATE1_TASK_NOT_ATTACHABLE");
if (roadTask.childOperationAmendmentId !== child.amendmentId) {
  roadTask.childOperationAmendmentId = child.amendmentId;
  durability.saveProjectState(durableProject);
}
```

### Admission binding

**FILE** `src/main/services/ai-mayor/v2/gate1.ts`, `proposalFor` / `admissionError`, lines 832–977  
**CALLER / CALLEE** `tick` → proposalFor resolves current task's referenced child → `admitGate1Proposal` → admissionError.  
**Can block** missing/nonactive/consumed child, different exact course, stale plan/world, reservation escape, or already existing Road command for the exact input.

`proposalFor` reads exactly `current.childOperationAmendmentId`; embeds one `RoadGeometryInput` and one fingerprint in `concreteChildOperation`. `admissionError` verifies:

- task is `DISPATCHED`, tranche and proposal stages match, task/project/district/tranche/reservation identities match, target stays in scopes, action family is allowed, recovery budget remains;
- referenced child exists, reason is the utility service-road child reason, `ACTIVE`, one-use, `UNUSED`;
- amendment ID/project/tranche/reservation match;
- proposal input's `stableRoadInput`, embedded fingerprint, amendment fingerprint, amendment exact input, and JSON exact input all match;
- plan revision equals active current revision; world/checkpoint/generation match;
- both endpoints are inside utility reservation;
- `childContext.hasRoadOperation(exactInput)` is false.

### Consumption

**FILE** `src/main/services/ai-mayor/v2/gate1-progression-boundary.ts`, `createGate1FoundationBoundary.execute`, lines 135–164; `durability.ts::consumeUtilityServiceRoadChildOperation`, lines 2425–2448  
**CALLER / CALLEE** Gate1 admitted proposal → `resolvers.road` (native preview and exact check) → consume child → Road Kernel execute.  
**Can block** missing admission token, invalid preview/exact course, missing/used child, stale world. Consumption changes child `ACTIVE`/`UNUSED` to `CONSUMED`/`CONSUMED` and persists it.

The child is consumed after `resolvers.road` returns its freshly previewed request and before `foundation.road.execute`.

The child record's declared statuses are `ACTIVE | SUPERSEDED_UNUSED | CONSUMED` (durability.ts around line 369); its execution-use status is `UNUSED | CONSUMED`. `consumeUtilityServiceRoadChildOperation` writes `CONSUMED` to both status fields. Task-level planner replacement separately accepts an old child only when it is `CONSUMED`/execution-consumed or `SUPERSEDED_UNUSED`. The access-road repair amendment has its own `supersedeUnusedAccessRoadBudgetAmendment`; it is a separate repair amendment type, not the utility service-road child path.

## 4. ROAD_CONNECTION success and stage/tranche transition

**FILE** `src/main/services/ai-mayor/v2/gate1.ts`, `createGate1Controller().tick`, lines 1288–1309  
**CALLER / CALLEE** admitted Road execution delivered → `complete("ROAD_DELIVERED", true)` → status/journal/delivery progress persisted.  
**Can block** after this transition, current stage no longer matches the Road task's legal stage (`SITE_SELECTED`), so another Road Connection proposal is not selected by normal tick.

```ts
const complete = (nextStage: Gate1Stage, delivery: boolean) => {
  current.status = "SUCCEEDED";
  current.activeCommandId = null;
  state.tranche.stage = nextStage;
  ...
  current.terminalOutcomeId = outcome.id;
  if (delivery) updateDelivery(state, outcome.id);
};
if (current.kind === "SITE_SELECTION") complete("SITE_SELECTED", true);
else if (current.kind === "ROAD_CONNECTION") complete("ROAD_DELIVERED", true);
```

Initial tranche task construction sets the single `ROAD_CONNECTION` task legal stage to `SITE_SELECTED`; zoning is legal only at `ROAD_DELIVERED`. `currentTaskIds` is keyed by task kind, so the current pointer also addresses one `ROAD_CONNECTION` task.

The progression runner only attempts child preparation while milestone is `ROAD_DELIVERED`, stage is `SITE_SELECTED`, and that single current Road task has no available child. It then ticks the Gate1 controller. On Road success the stage transition above ends further Road task selection.

## 5. Task supersession/replacement

**FILE** `src/main/services/ai-mayor/v2/durability.ts`, `ensurePlannerInputReplacement`, lines 2450–2612  
**CALLER / CALLEE** K05 preparation (`main-adapter.ts`) → `ensurePlannerInputReplacement` → atomic project state + child commit.  
**Can block** stale branch/project/predecessor; completed objective; absent/nonterminal predecessor; executable old child; same material input; complete/unknown/overlapping effect; in-flight command; budget exhausted; ID collision.

Key behavior directly in source:

1. Reloads and validates current durable state before checking.
2. Requires activated current branch identity `${worldId}|${checkpointId}|${journalCut}`, current world/checkpoint/generation, active project/objective, exact valid Road input, authoritative target.
3. Computes immutable exact hash from `stableRoadInput(exactRoadInput)` and material hash from canonicalized action family + course fields.
4. Computes `replacementKey = sha256(["planner-input-replacement/1", branch, project, objective, "ROAD_CONNECTION", materialHash])`.
5. Looks up same key **before** consuming one-use budget and returns the durable winner if its child/input/lineage match.
6. Enforces same objective/branch corrective replacement budget: any prior `PLANNER_INPUT_CHANGED` successor blocks a different material replacement.
7. Requires current task ID equals expected predecessor; predecessor is terminal `BLOCKED`/`FAILED`, has terminal outcome and exhausted attempts; old child is consumed or superseded-unused; new input materially differs.
8. Rejects complete effect, unknown effect, partial effect that does not avoid existing effects, and predecessor-owned in-flight commands.
9. Creates deterministic successor task and child; child owns exact course and one-use current world binding; successor attempts start at 0; atomically persists task, child, and `currentTaskIds.ROAD_CONNECTION` update with rollback of in-memory write if persistence throws.

The terminal predecessor itself is retained; the current-task reference moves to the successor.

## 6. `replanForCurrentBranch` and production call sites

**FILE** `src/main/services/ai-mayor/v2/project-admission.ts`, interface line 270 and implementation lines 718 onward  
**FUNCTION** `createV2ProjectAdmissionBootstrap(...).replanForCurrentBranch`  
**CALLER / CALLEE** production project-admission object exposes this method. Repository search found no production invocation; exact matches outside implementation/interface were tests at `test/ai-mayor/v2-project-admission.spec.ts:399,410`.  
**Can block** missing admitted project/site constraint, activation not durable, checkpoint/cut proof failure, mismatched checkpoint evidence, branch already spent, current project still admissible, or replacement admission failure.

The method derives current-branch identity from active world/checkpoint/journal cut, reuses an existing matching `CURRENT_BRANCH_REPLAN` record, checks current reservation remains inadmissible, records project supersession, admits a new project under derived intent ID, and links replacement. This is **project-level** replan, not the task-level `PLANNER_INPUT_CHANGED` replacement method.

## 7. Prior proposal / authorization / operation reuse

**FILE** `src/main/services/ai-mayor/v2/gate1.ts`, `proposalFor`; `gate1-progression-boundary.ts`, `resolvers.road`; `main-adapter.ts`, child binding; `road-kernel.ts`, request validation  
**CALLER / CALLEE** task proposal → exact child → fresh native preview/quote → Road Kernel.  
**Can block** stale or mismatched identity before Bridge Apply.

- Gate1 proposal identity is generated as `${current.id}:attempt:${current.attempts + 1}`. The concrete child contributes one exact input/fingerprint; it does not contribute an old quote or authorization.
- `resolvers.road` calls `previewProductiveStarterRoad` on the child input, then rejects if preview changed the exact fingerprint or JSON input (`GATE1_UTILITY_SERVICE_ROAD_PREVIEW_CHANGED_EXACT_INPUT`). It constructs a request from the returned current preview quote.
- The Road Kernel checks proposal identity, quote presence, exact frozen input, proposal/quote ID binding, and current operation state before submission. In `road-kernel.ts::validateRoadExecutionRequest` (around lines 240–280), quote proposal ID, quote ID, and exact fingerprint must match; request is frozen before execution.
- Child consumption occurs after the fresh preview/request is made, immediately before Road Kernel call. Old child cannot be consumed again because status/use status must be ACTIVE/UNUSED.
- The replacement child uses a new deterministic task/child ID and exact input hash. No source path found that reuses the predecessor's proposal ID or quote ID for a corrected input.
- `admissionError` additionally vetoes exact input when `hasRoadOperation(exactInput)` says a Road command already exists.

## 8. All preview-preceding state veto / return points

### K05 child preparation before `tick`

**FILE** `src/main/services/ai-mayor/v2/gate1-progression.ts`, lines 205–230  
**CALLER / CALLEE** progression milestone loop → child lookup and optional `prepareUtilityServiceRoadChild` → controller tick.  
**Can block** terminal/consumed child causes preparation call; a thrown prep error returns progression `BLOCKED` before `tick`, therefore before Gate1 Admission/native preview. Preparation itself throws at `main-adapter.ts` checks listed in section 3.

### Task selection / attempt / Admission

**FILE** `gate1.ts::tick` and `admissionError`, lines 1090–1260 / 924–977  
**Can block** no pending/waiting task legal at current tranche stage; task already terminal/dispatched; attempts/status/terminal outcome; Gate1 identity/scope/action-family/recovery budget; missing or stale one-use child; exact-input tamper mismatch; world/checkpoint/generation mismatch; endpoint out of reservation; existing exact Road operation.

Admission rejection sets task/project/intent BLOCKED and returns immediately before `boundary.execute`.

### Road resolver's native preview gate

**FILE** `src/main/services/ai-mayor/v2/gate1-progression-boundary.ts::resolvers.road`, lines 140–166; `runtime-road-caller.ts::previewProductiveStarterRoad`, line 241 onward  
**CALLER / CALLEE** admitted BUILD_ROAD → load exact child input → preview productive Road course → exact-course comparison → form RoadExecutionRequest.  
**Can block** course invalid, preview rejection, or preview normalization changing child exact input. This is the native preview boundary. Only after it returns does boundary consume child and call Road Kernel.

```ts
if (proposal.concreteChildOperation) {
  input = structuredClone(proposal.concreteChildOperation.input);
  if (stableRoadInput(input) !== proposal.concreteChildOperation.courseFingerprint)
    throw new Error("GATE1_UTILITY_SERVICE_ROAD_CHILD_FINGERPRINT_MISMATCH");
}
const productive = await previewProductiveStarterRoad({ input, preview: options.previewRoad, lengthsMeters: [length], signal });
const roadInput = productive.input;
const fingerprint = stableRoadInput(roadInput);
if (proposal.concreteChildOperation &&
  (fingerprint !== proposal.concreteChildOperation.courseFingerprint ||
   JSON.stringify(roadInput) !== JSON.stringify(proposal.concreteChildOperation.input)))
  throw new Error("GATE1_UTILITY_SERVICE_ROAD_PREVIEW_CHANGED_EXACT_INPUT");
```

`previewProductiveStarterRoad` calls the injected preview for candidates and accepts only when `nativeRoadQuoteFromPreview` succeeds and `nativePreviewHasNewRoadEffect(preview, input)` is true. For this concrete child caller it supplies the child length as the candidate length. If every candidate produces no new Road effect, it throws the last `NO_PRODUCTIVE_ROAD_EFFECT`; any other preview error propagates immediately.

### Road Kernel pre-Bridge validation

**FILE** `src/main/services/ai-mayor/v2/road-kernel.ts::executeRoad` / request validation, lines 240–280 onward  
**CALLER / CALLEE** boundary request → current proposal/freeze/authorization and journal checks → Bridge submit.  
**Can block** invalid proposal/quote identity, exact input/fingerprint mismatch, stale execution identity, already-used or incompatible command identity, invalid native preview/quote. These checks precede Bridge Apply; they may run after the Bridge-side preview request has already been obtained by the resolver.

```ts
const exactInput = stableRoadInput(proposal.input);
if (!proposal.identity.proposalId || proposal.identity.actionFamily !== "ROAD") return "invalid_road_proposal_identity";
if (!proposal.quoteId) return "missing_quote_identity";
const frozenInput = JSON.parse(proposal.identity.exactInput) as RoadGeometryInput;
if (!sameRoadCourse(frozenInput, proposal.input)) return "OPERATION_DEFINITION_COURSE_MISMATCH";
if (proposal.fingerprint !== exactInput || proposal.identity.exactInput !== exactInput) return "proposal_fingerprint_mismatch";
...
if (quote.proposalId !== proposal.identity.proposalId) return "proposal_id_mismatch";
if (quote.quoteId !== proposal.quoteId) return "quote_id_mismatch";
if (quote.exactInput !== exactInput) return "quote_fingerprint_mismatch";
```

The separate progression owner also refuses to construct its runner unless durable activation is proven (`ensureRunner`, `gate1-progression.ts`): absent activation, `blockedReason`, or `!durability.isExecutionDurablyActivated(activation)` returns/throws before task tick or native preview. Its `advanceToStage` loop only invokes the current state machine and stops when the milestone is reached, decision/wake limits are exhausted, or a tick reports blocked/failed status; it does not advance tranche stage itself.

## Search boundary and remaining unknowns

Production search for `replanForCurrentBranch` found only its interface and implementation; production caller count is zero in current source. Tests call it at `test/ai-mayor/v2-project-admission.spec.ts:399,410`.

No unrelated modules were inspected. The source establishes the one-task/one-child/one-course control path and its state gates; it does not establish current live world identities or runtime task state.
