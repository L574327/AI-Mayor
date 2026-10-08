# V2 Utility Connection State Contract

Status: proposed local redesign contract for the first Utility connection implementation.

Scope: one bounded UtilityProvision connection objective inside one existing V2 Project/Tranche. This document changes the contract boundary only. It does not change production code, execute CS2, or certify the current cable blocker.

Source basis: `PRODUCT_NORTH_STAR.md`, `V2_ARCHITECTURE_BASELINE.md`, current `utility-recovery.ts`, `v2/greenfield-utility-bootstrap.ts`, `v2/main-adapter.ts`, `v2/foundation.ts`, and `v2/durability.ts`. Where the current code does not yet implement this contract, the text says `TARGET CONTRACT`.

## 1. Purpose and non-goals

The connection objective is a durable, bounded objective that may require more than one native primitive. A primitive is a means; it is not the objective. The contract therefore separates:

1. Facility state
2. Connector identity
3. Connection objective
4. Primitive candidate
5. Native command
6. Primitive world effect
7. Objective observation
8. Service certification

This local redesign does not expand the planner, Kernel, generic durability, Skill Library, Gate 2, or multi-project concurrency. It only gives the existing UtilityProvision method a correct state boundary between a facility and certified service.

## 2. State layers

### 2.1 Facility state

Facility state answers: does the planned utility building exist as the intended entity in the current world?

```text
FacilityState =
  MISSING
  | PLACED { entity, prefab, position, observedWorldEpoch }
  | INVALID { reason }
```

`PLACED` requires an authoritative building observation with the planned prefab and live entity identity. A placement receipt alone is not sufficient. An existing same-kind facility may satisfy this state; facility placement is never repeated merely because the connection objective is incomplete.

`constructionAttempts` belongs to facility construction. It is not incremented by a connection preflight, candidate selection, reconciliation, or connection-only execution. Its existing maximum remains 2 for facility placement. Reaching `2/2` blocks a missing facility, but does not block an existing facility’s uncompleted connection objective when a candidate remains eligible.

### 2.2 Connector identity

Connector identity is the exact facility connector observed in the current epoch:

```text
ConnectorIdentity = {
  facilityEntity,
  connectorNode,
  utilityKind,
  connectorType,
  worldEpoch,
  topologyRevision,
  worldPosition,
  orphan,
  attached
}
```

`facilityEntity` and `connectorNode` are live `{index, version}` references, not durable global identities. On reload, the facility and connector must be re-observed and rebound. A connector is valid for objective execution only when its node identity is present, its facility binding is authoritative, and its epoch/topology binding matches the current scope. Missing, stale, malformed, or ambiguous connector identity is `BLOCKED` or `UNKNOWN` according to the observation failure, never a guessed rebind.

`orphan=false` and `attached=true` are observations, not assumptions from proximity or capacity.

### 2.3 Connection objective

```text
ConnectionObjective = {
  objectiveId,
  worldIdentity,
  worldEpoch,
  projectId,
  trancheId,
  utilityKind,
  facilityEntity,
  connectorNode,
  targetNetwork,
  approvedPlanRevision,
  candidateOrder,
  spatialScope,
  budgetCeiling,
  status: INCOMPLETE | COMPLETE | BLOCKED,
  observationBudget,
  candidateBudget
}
```

`objectiveId` is stable for the same Project, Tranche, utility kind, approved plan revision, and facility/connector binding. It is not a new Project, Task, or facility placement. `candidateOrder` is an immutable ordered list, for the current plan normally:

```text
1. service-road
2. direct-cable (Low-voltage Ground Cable)
```

The objective is `COMPLETE` only when the objective observation in Section 7 passes. A successful primitive never directly sets objective completion.

### 2.4 Primitive candidate

Each candidate is a bounded planned option, not an unconstrained retry:

```text
PrimitiveCandidate = {
  candidateId,
  objectiveId,
  kind: service-road | direct-cable,
  ordinal,
  exactActions,
  approvedPlanRevision,
  spatialScope,
  budgetCeiling,
  ledgerState,
  commandId: nullable,
  primitiveEffect: nullable
}
```

The exact actions, prefab, endpoints, target network, scope, and budget are inherited from the admitted plan. A candidate cannot silently change them during fallback. A new candidate is progression within the same objective, not a retry of an earlier write.

### 2.5 Native command

The existing V2 command journal remains the source of native write truth. Candidate state references a command; it does not replace the command record.

```text
NativeCommand = existing V2CommandRecord
  { commandId, idempotencyKey, authorizedScope, status,
    statusHistory, reconciliationStatus, observationEvidence }
```

The command record retains frozen outcomes such as `CREATED`, `AUTHORIZED`, `SUBMITTED`, `NATIVE_COMPLETED`, `COMMIT_ACK`, `OBSERVED_MATCH`, `OBSERVED_MISMATCH`, `REJECTED`, `UNKNOWN_TIMEOUT`, and `UNKNOWN_TRANSPORT` as defined by the current foundation/journal implementation. The candidate ledger may project these into its smaller lifecycle, but must not overwrite or reinterpret the underlying journal.

### 2.6 Primitive world effect

Primitive effect is the authoritative result of that exact candidate’s proposed world change:

```text
PrimitiveEffect =
  NOT_OBSERVED
  | OBSERVED_MATCH { evidence }
  | OBSERVED_MISMATCH { evidence }
  | UNKNOWN { reason }
```

For `service-road`, `OBSERVED_MATCH` proves the permanent Small Road effect matched the road proposal. It does not prove that the facility connector has an external ConnectedFlowEdge. For `direct-cable`, `OBSERVED_MATCH` proves the cable/net primitive effect, but objective completion still requires the objective observation.

## 3. Durable candidate ledger

### 3.1 Candidate states

Every candidate has exactly one durable ledger state:

```text
NOT_ATTEMPTED
PREFLIGHT_REJECTED
AUTHORIZED
SUBMITTED
RECONCILING
OBSERVED_MATCH
FAILED_DETERMINISTIC
UNKNOWN
```

Meaning:

- `NOT_ATTEMPTED`: no native submission has occurred for this candidate.
- `PREFLIGHT_REJECTED`: authoritative/native preview rejected the exact action; no native write crossed the boundary.
- `AUTHORIZED`: admission and durable command creation completed; submission has not occurred.
- `SUBMITTED`: the candidate’s command crossed the native boundary and awaits a terminal native/reconciliation result.
- `RECONCILING`: the command outcome is unresolved or the objective requires fresh post-command observation.
- `OBSERVED_MATCH`: this candidate’s exact primitive effect is authoritatively observed.
- `FAILED_DETERMINISTIC`: the candidate failed before an ambiguous native effect and cannot be retried.
- `UNKNOWN`: native outcome or observation cannot safely distinguish effect from no effect.

These states are candidate facts. They do not replace `V2CommandStatus`, durable command outcome, or command reconciliation status. For example, candidate `SUBMITTED` may map to command `SUBMITTED`; candidate `RECONCILING` may map to `UNKNOWN_TIMEOUT`, `UNKNOWN_TRANSPORT`, `NATIVE_COMPLETION_UNKNOWN`, or a known command awaiting objective observation. Candidate `OBSERVED_MATCH` requires the command’s authoritative effect reconciliation, not merely `COMMIT_ACK`.

### 3.2 Submission cardinality

For each `candidateId`, the native submission cardinality is at most one. A second call with the same candidate exact input is a duplicate write and is forbidden, regardless of whether the first command was acknowledged, observed, or later found not to complete the objective.

Candidate progression is therefore:

```text
candidate[n] NOT_ATTEMPTED
  -> PREFLIGHT_REJECTED | AUTHORIZED
  -> SUBMITTED
  -> RECONCILING
  -> OBSERVED_MATCH | FAILED_DETERMINISTIC | UNKNOWN

objective incomplete after candidate[n] OBSERVED_MATCH
  -> candidate[n+1] NOT_ATTEMPTED
```

There is no transition from `OBSERVED_MATCH` back to `SUBMITTED` for the same candidate.

## 4. Objective semantics

The objective observation is a separate authoritative read:

```text
ConnectionObjectiveComplete iff
  facility identity valid
  AND connector identity valid
  AND external ConnectedFlowEdge exists
  AND connector.orphan = false
  AND connector.attached = true
  AND networkConnected = true
  AND targetNetworkReachable = true
```

For Electricity, the positive capacity/headroom and other existing service conditions must also remain valid. `capacity > 0` alone is insufficient. A primitive `OBSERVED_MATCH` alone is insufficient.

Normative transitions:

```text
OBSERVED_MATCH primitive + objective complete
  -> objective COMPLETE; stop all candidates; certify only after service checks.

OBSERVED_MATCH primitive + fresh authoritative objective observation incomplete
  + no unresolved uncertain command
  -> retain primitive as OBSERVED_MATCH;
     advance to the next NOT_ATTEMPTED approved candidate.

SUBMITTED / UNKNOWN / RECONCILING unresolved
  -> reconcile that command/objective first; issue no new native write.

PREFLIGHT_REJECTED
  -> retain rejection evidence; evaluate only the next approved candidate.

FAILED_DETERMINISTIC
  -> retain failure evidence; evaluate only the next approved candidate.

no NOT_ATTEMPTED approved candidate remains
  -> objective BLOCKED.
```

An `OBSERVED_MATCH` command in the same scope cannot cover an UNKNOWN command for another candidate. Each command is reconciled independently, each candidate is observed independently, and the objective is evaluated from the aggregate authoritative observation only after all relevant command uncertainty is cleared.

## 5. Objective identity, reload, and invalidation

### Persist across reload

Persist:

- objective identity and Project/Tranche ownership
- approved plan revision and immutable candidate order
- spatial scope and budget ceiling
- candidate ledger entries, exact action fingerprints, command IDs, and primitive effects
- existing V2 command journal and reconciliation metadata
- facility placement attempt count and existing `connectionRecovery` marker
- objective status, terminal reason, observation budget, and candidate budget

### Re-observe and rebind after reload

Re-observe:

- current world identity, checkpoint identity, and Bridge generation/epoch
- facility existence, prefab, and live entity identity
- connector node identity, position, orphan/attached state, and connected edges
- target road/network anchor and topology revision
- objective observation, capacity, reachability, and service conditions
- every non-terminal command requiring reconciliation

The durable ledger is not itself proof that a world effect still exists. A prior `OBSERVED_MATCH` remains historical command/effect evidence, while the current objective must be freshly observed in the new epoch.

### Mandatory BLOCK conditions

Block without write when any of these changes cannot be authoritatively rebound:

- different world identity or an unrecognized checkpoint lineage
- stale or incompatible world epoch/generation
- Project, Tranche, utility kind, or approved plan revision mismatch
- facility missing, replaced by a different prefab/entity, or outside the approved scope
- connector missing, ambiguous, or not bound to the facility
- target network/road changed outside the approved topology revision
- budget ceiling or spatial scope cannot be proven unchanged
- an unresolved `SUBMITTED`, native-completion-unknown, timeout, transport-unknown, or `UNKNOWN` command exists

Reload must never reset candidate state, recovery consumption, construction attempts, command history, or budget spent. A new epoch may require re-observation; it does not grant another submission for a consumed candidate.

## 6. Current battlefield migration acceptance case

The migration input is:

```text
Facility: WindTurbine03 46620:9
Connector: 46621:9
Capacity: 1681
Service-road command: ad5c081f-d20e-4c43-956b-57a215b89a83
Service-road command outcome: OBSERVED_MATCH
Service-road permanent effect: YES
Objective: INCOMPLETE
Connector: orphan=true
External ConnectedFlowEdge: absent
Direct cable: NOT_ATTEMPTED
Existing connection recovery: consumed
constructionAttempts: 2/2
```

TARGET CONTRACT migration result:

```text
FacilityState: PLACED(46620:9)
ConnectorIdentity: rebound(46621:9), current epoch verified
Candidate[0] service-road: OBSERVED_MATCH
  commandId = ad5c081f-d20e-4c43-956b-57a215b89a83
  primitive effect = permanent road observed
Candidate[1] direct-cable: NOT_ATTEMPTED
ConnectionObjective: INCOMPLETE
connectionRecovery: consumed (unchanged)
constructionAttempts: 2/2 (unchanged)
```

The migration must not replay the service-road command, clear its command history, reset recovery, increment facility attempts, expand scope, or increase budget. `connectionRecovery=consumed` means the old one-shot pre-native recovery marker cannot be consumed again; it does not erase the objective’s remaining planned candidate. The candidate ledger is the bounded progression record for this objective and is not a second recovery loop.

The cable may become eligible only after:

1. current facility and connector authoritative rebind;
2. current target network/epoch/plan binding validation;
3. confirmation that no command is uncertain or unresolved;
4. fresh Low-voltage Ground Cable preflight;
5. fresh Admission against the original scope and budget;
6. durable creation of the cable command record and candidate transition to `AUTHORIZED`.

Only then may one native cable submit occur. If cable preflight is invalid, record `PREFLIGHT_REJECTED` and stop or evaluate another explicitly approved candidate; do not reinterpret the old road effect. If cable becomes UNKNOWN, reconcile cable and do not certify or submit another candidate.

## 7. Reconciliation contract

Reconciliation is three-layered:

### Command layer

For each `commandId`, read the existing durable journal record and reconcile against the exact current-world effect matcher. `SUBMITTED`, `NATIVE_COMPLETED`, `NATIVE_COMPLETION_UNKNOWN`, `UNKNOWN_TIMEOUT`, `UNKNOWN_TRANSPORT`, and `UNKNOWN` remain quarantined until resolved. No other command’s `OBSERVED_MATCH` may resolve it.

### Candidate layer

Map only that command’s result to its candidate ledger entry. A command `OBSERVED_MATCH` sets that candidate’s primitive effect to `OBSERVED_MATCH`; it does not set the objective complete. A command mismatch becomes candidate `FAILED_DETERMINISTIC` only when no ambiguous world effect remains. An inconclusive read becomes candidate `UNKNOWN` or `RECONCILING` and forbids new writes.

### Objective layer

After all relevant command uncertainty is clear, perform a fresh objective observation of facility, connector, external edge, orphan/attached state, network connectivity, target reachability, and utility service conditions. Objective completion is derived only from this observation. If incomplete and a later candidate is `NOT_ATTEMPTED`, that candidate may be considered under the bounded rules; otherwise the objective is `BLOCKED`.

## 8. Termination and stop-loss

For the current two-candidate plan:

- `maximumCandidates = 2`; no candidate may be invented by the local method.
- `maximumNativeSubmissionsPerCandidate = 1`.
- `maximumFacilityPlacementAttempts = 2`, unchanged and separate from candidate attempts.
- `maximumConnectionRecoveryConsumptions` remains the existing one-shot value; candidate progression does not consume it again.
- Each candidate gets one preflight evaluation per current approved binding. A rejected preflight is terminal for that candidate under that binding.
- Observation and simulation waits remain bounded by the existing Utility observation budget; exhaustion is `BLOCKED`/typed waiting, never an implicit retry.
- Any unresolved UNKNOWN or submitted command stops all new writes until reconciliation.
- Candidate exhaustion with objective incomplete is `BLOCKED`.
- Reload, reconnect, or epoch change never resets candidate ledger, spend, attempts, or recovery marker.
- No silent budget or spatial-scope expansion is permitted.

## 9. Service certification

Electricity `SERVICE_CERTIFIED=true` requires all of:

- valid authoritative WindTurbine facility identity;
- valid current connector identity;
- external ConnectedFlowEdge exists and is the intended external network effect;
- connector `orphan=false`;
- connector `attached=true`;
- `networkConnected=true`;
- `targetNetworkReachable=true`;
- capacity status available, positive, and sufficient relative to consumption/headroom;
- no unresolved command, UNKNOWN observation, stale binding, or missing service condition.

Neither `capacity=1681`, a warning change, a primitive `OBSERVED_MATCH`, a command acknowledgement, nor native completion can certify service. Bootstrap `SERVICE_CERTIFIED` proves supply-side service for the facility/network objective only. It does not equal later building-local `ACTUAL_CONSUMER_SERVICE`, which remains a separate Gate 1 requirement for an attributed building.

## 10. First Playable scope

### REQUIRED BEFORE FIRST PLAYABLE

- Correct facility/connector/objective separation for one Electricity connection.
- Ordered, immutable service-road -> Low-voltage Ground Cable candidate ledger.
- One native submission per candidate and durable command linkage.
- Independent command reconciliation and objective observation.
- Current battlefield migration without duplicate road write, facility placement, recovery reset, attempt reset, or budget expansion.
- Correct Electricity service certificate before ZONING.
- Provider invocation `0`; legacy V1 brain invocation `0`.

### DEFERRED UNTIL HARDENING

- Generic candidate-ledger framework for every city operation.
- Multi-project or concurrent utility objectives.
- Planner architecture changes, generic HTN/GOAP machinery, or Skill Library expansion.
- Kernel redesign or Bridge protocol redesign.
- Generic durability schema replacement.
- Gate 2 economic handover, 50k endurance, broad utility optimization, and cross-map policy.

This local redesign must not smuggle deferred scope into the first playable path.

## 11. Bounded implementation map

### KEEP

- `executeSharedUtilityRecovery`: native facility/connection execution boundary and authoritative connector readback.
- `canConsumeConnectionPrimitiveFallbackRecovery`: pre-native one-shot recovery safety gate, limited to its original purpose.
- `V2CommandRecord`, `V2CommandJournal`, `commandIdempotencyKey`: frozen command durability and replay safety.
- `V2DurabilityCoordinator`: world/checkpoint identity, journal persistence, and uncertain-command quarantine.
- `readScopedUtilityEvidence` / `isScopedUtilityServiceCertified`: authoritative capacity, connector, reachability, and service evidence boundary.
- Existing Project, Tranche, plan binding, spatial scope, and budget admission.

### CHANGE

- `DurableGreenfieldUtilityKindState`: add durable connection objective identity and per-candidate ledger without removing existing fields.
- `runScopedGreenfieldUtilityBootstrap`: consume command inspection per command, evaluate objective completion separately, and advance only to the next `NOT_ATTEMPTED` candidate when the current primitive effect is known and objective observation is incomplete.
- `inspectNetworkCommands`: return candidate/command association or an equivalent exact mapping; do not expose only a scope-wide `authoritativeEffect` boolean.
- `executeScopedUtility`: accept one selected candidate ledger entry, enforce its one-submit cardinality, preserve exact command linkage, and avoid facility attempt increments for connection-only execution.
- `readScopedUtilityEvidence`: remain authoritative for objective observation; ensure external edge, orphan, attached, and target reachability are all represented distinctly.

### REMOVE / SUPERSEDE

- Scope-wide `authoritativeEffect` as a blanket prohibition on every later candidate.
- Any branch that maps `facilityExists && !useConnectionRecovery` directly to terminal connection failure when a known primitive effect exists and a later approved candidate is `NOT_ATTEMPTED`.
- Any implicit assumption that `commandOutcome=OBSERVED_MATCH` means `ConnectionObjective=COMPLETE`.
- Any retry path that reconstructs an already submitted candidate from plan state without consulting its candidate ledger and command journal.

## 12. Contract validation matrix

| Case | Normative result |
|---|---|
| A. service-road preflight rejected | road ledger `PREFLIGHT_REJECTED`; cable remains eligible for fresh preflight/admission. |
| B. service-road `OBSERVED_MATCH` + objective complete | objective `COMPLETE`; stop; no cable. |
| C. service-road `OBSERVED_MATCH` + objective incomplete | retain road effect; cable `NOT_ATTEMPTED` becomes eligible if no uncertainty and bounds remain. |
| D. service-road `UNKNOWN` | reconcile road; cable forbidden. |
| E. road matched + cable `UNKNOWN` | reconcile cable; objective not certified; no new write. |
| F. all candidates exhausted | objective `BLOCKED`; no loop or invented fallback. |
| G. reload | re-observe/rebind; no consumed budget, attempt, recovery, or candidate reset. |
| H. current `46620:9` / `46621:9` | migrate road as observed, preserve all durable history, leave cable not attempted, permit cable only after fresh bounded preflight/admission under unchanged scope. |

## 13. Unresolved architecture questions

- Should candidate ledger records live inside the Utility state document or as typed journal entries keyed by objective and candidate?
- What is the smallest authoritative representation of an external ConnectedFlowEdge that remains stable across topology revisions?
- Should an objective observation with a known primitive effect but no connector effect be `RECONCILING` or immediately eligible for the next candidate?
- How should a future plan revision invalidate candidate history without allowing a hidden budget reset?
- Which existing `commandOutcome` values can be safely normalized without losing the frozen foundation distinctions?
- What exact observation budget is sufficient for cable effect settlement on the real CS2 substrate?

These questions do not permit production changes in this document-only step. They are bounded design decisions for the next implementation review.
