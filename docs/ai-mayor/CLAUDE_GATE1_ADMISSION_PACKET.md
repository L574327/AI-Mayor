# Gate1 Concrete Child-Operation Admission - Code Review Packet

Read-only, verbatim source excerpts for Water Planner serviceRoad to Gate1 project Admission to finance authorization to Road Kernel. Each block shows source path and inclusive line range. Comments and blank lines are omitted within excerpts; executable statements are copied verbatim.

## 1. Gate1 proposal shape, ownership Admission, and Road dispatch

### src/main/services/ai-mayor/v2/gate1.ts - lines 152-183

```typescript
export interface Gate1SkillProposal {
  id: string;
  attempt: number;
  skill:
    | "SiteSelection"
    | "RoadConnection"
    | "UtilityProvision"
    | "Zoning"
    | "WaitObserve"
    | "OccupancyDiagnosis"
    | "BoundedRecovery";
  taskId: string;
  projectId: string;
  districtId: string;
  trancheId: string;
  reservationRef: string;
  requiredStage: Gate1Stage;
  kind: "STATE" | "OBSERVE" | "WORLD_WRITE";
  actionFamily: "ROAD" | "ZONING" | null;
  operation: "SELECT_SITE" | "BUILD_ROAD" | "CERTIFY_UTILITIES" | "ZONE_RESIDENTIAL" | "WAIT" | "DIAGNOSE" | "RECOVER";
  target: CircleScope;
  boundedFallback: string | null;
  methodVariant: "PRIMARY" | "BOUNDED_FALLBACK";
}
export interface Gate1AdmittedProposal extends Gate1SkillProposal {
  admission: {
    decision: "ADMITTED";
    admittedAt: string;
    scopeFingerprint: string;
  };
}
```

### src/main/services/ai-mayor/v2/gate1.ts - lines 214-234

```typescript
export interface Gate1State {
  schemaVersion: typeof V2_GATE1_STATE_SCHEMA_VERSION;
  stateVersion: number;
  intent: CityIntent;
  project: DevelopmentProject;
  district: District;
  districtPlan: DistrictPlan;
  tranche: Tranche;
  tasks: Gate1Task[];
  journal: Gate1OutcomeJournalEntry[];
  predecessorCompletionId?: string | null;
  completion?: {
    completionId: string;
    completedAt: string;
    terminalOutcomeId: string;
    releasedReservationRefs: string[];
    handoffStatus: "NEXT_DECISION_READY" | "CONSUMED";
    nextDecisionId: string | null;
    handedOffAt: string | null;
  };
}
```

### src/main/services/ai-mayor/v2/gate1.ts - lines 241-250

```typescript
export interface StarterResidentialIntentInput {
  intentId: string;
  targetResidents: number;
  maximumBudget: number;
  planningEnvelope: CircleScope;
  siteCandidates: Array<{ id: string; target: CircleScope; score: number; blocked: boolean }>;
  protections?: Array<{ ref: string; scope: CircleScope }>;
  maximumWaitObservations?: number;
  starterDirection?: SpatialPoint2;
}
```

### src/main/services/ai-mayor/v2/gate1.ts - lines 252-262

```typescript
export interface Gate1WorldBoundary {
  execute(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<Gate1ExecutionOutcome>;
  reconcile?(commandId: string, signal?: AbortSignal): Promise<Gate1ExecutionOutcome>;
}
export interface Gate1FoundationProposalResolvers {
  road(proposal: Gate1AdmittedProposal, signal?: AbortSignal): Promise<RoadExecutionRequest>;
  zoning(
    proposal: Gate1AdmittedProposal,
    signal?: AbortSignal,
  ): Promise<{ intent: ZoningIntent; baseline: V2ObservationEnvelope }>;
```

### src/main/services/ai-mayor/v2/gate1.ts - lines 861-915

```typescript
  return {
    id: `${current.id}:attempt:${current.attempts + 1}`,
    attempt: current.attempts + 1,
    ...mapping[current.kind],
    taskId: current.id,
    projectId: state.project.id,
    districtId: state.district.id,
    trancheId: state.tranche.id,
    reservationRef: state.tranche.reservationRef,
    requiredStage: current.legalStage,
    target: clone(state.tranche.target),
    methodVariant: current.attempts === 0 ? "PRIMARY" : "BOUNDED_FALLBACK",
  };
}
function admissionError(state: Gate1State, current: Gate1Task, proposal: Gate1SkillProposal): string | null {
  if (current.status !== "DISPATCHED") return "task is not dispatched";
  if (state.tranche.stage !== current.legalStage || proposal.requiredStage !== current.legalStage)
    return "proposal is stale for current tranche stage";
  if (
    proposal.taskId !== current.id ||
    proposal.projectId !== state.project.id ||
    proposal.districtId !== state.district.id ||
    proposal.trancheId !== state.tranche.id ||
    proposal.reservationRef !== state.tranche.reservationRef
  )
    return "proposal ownership differs from bounded project/tranche scope";
  if (!contains(state.district.boundary, proposal.target) || !contains(state.tranche.target, proposal.target))
    return "proposal target escapes tranche reservation";
  if (proposal.actionFamily && !state.tranche.allowedActionFamilies.includes(proposal.actionFamily))
    return "proposal action family is outside tranche scope";
  if (proposal.operation === "RECOVER" && state.tranche.recoveryAttempts >= state.tranche.maximumRecoveryAttempts)
    return "bounded recovery exhausted";
  return null;
}
export type Gate1AdmissionDecision = Gate1AdmittedProposal | { admission: { decision: "REJECTED"; reason: string } };
export function admitGate1Proposal(
  state: Gate1State,
  current: Gate1Task,
  proposal: Gate1SkillProposal,
  now = new Date(),
): Gate1AdmissionDecision {
  const error = admissionError(state, current, proposal);
  if (error) return { admission: { decision: "REJECTED", reason: error } };
  return {
    ...proposal,
    admission: {
      decision: "ADMITTED",
      admittedAt: now.toISOString(),
      scopeFingerprint: `${proposal.projectId}|${proposal.districtId}|${proposal.trancheId}|${proposal.reservationRef}`,
    },
  };
}
```

### src/main/services/ai-mayor/v2/gate1.ts - lines 1123-1148

```typescript
      } else {
        current.status = "DISPATCHED";
        current.attempts += 1;
        proposal = proposalFor(state, { ...current, attempts: current.attempts - 1 });
        const decision = admitGate1Proposal(state, current, proposal, now());
        if (decision.admission.decision === "REJECTED") {
          const error = decision.admission.reason;
          current.status = "BLOCKED";
          state.project.status = "BLOCKED";
          state.intent.status = "BLOCKED";
          const outcome = journal(current, proposal, {
            admission: "REJECTED",
            execution: "NOT_REQUIRED",
            commandId: null,
            observationId: observation?.observationId ?? null,
            observedEffect: "NOT_APPLICABLE",
            failureClassification: "ADMISSION_REJECTED",
            reason: error,
          });
          current.terminalOutcomeId = outcome.id;
          persist();
          return { state: clone(state), task: clone(current), proposal, outcome };
        }
        const admitted = decision as Gate1AdmittedProposal;
        if (proposal.kind === "WORLD_WRITE") execution = await options.boundary.execute(admitted, signal);
      }
```

### src/main/services/ai-mayor/v2/gate1.ts - lines 1507-1543

```typescript
export function createGate1FoundationBoundary(
  foundation: Pick<V2FoundationPorts, "road" | "zoning">,
  resolvers: Gate1FoundationProposalResolvers,
): Gate1WorldBoundary {
  const roadOutcome = (result: Awaited<ReturnType<V2FoundationPorts["road"]["execute"]>>): Gate1ExecutionOutcome => ({
    status: roadExecutionStatus(result.command.status),
    commandId: result.command.commandId,
    observedMatch: result.command.status === "OBSERVED_MATCH" && result.effectReport?.matcherResult === "MATCH",
    reason:
      result.command.failureOrUnknownReason ??
      result.effectReport?.reason ??
      result.command.nativeResultSummary ??
      result.command.status,
  });
  return {
    async execute(proposal, signal) {
      if (proposal.admission?.decision !== "ADMITTED") {
        return { status: "REJECTED", commandId: null, observedMatch: false, reason: "Gate 1 Admission token missing" };
      }
      if (proposal.operation === "BUILD_ROAD") {
        let result;
        try {
          result = await foundation.road.execute(await resolvers.road(proposal, signal), signal);
        } catch (error) {
          if (isTransientNativeBuildBusy(error)) {
            return { status: "WAITING", commandId: null, observedMatch: false, reason: NATIVE_BUILD_SLOT_BUSY };
          }
          const classification = classifyNativeRoadPreviewFailure(error);
          return {
            status: classification,
            commandId: null,
            observedMatch: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        return roadOutcome(result);
      }
```

## 2. Gate1 progression boundary: target-based candidate reproduction and Road request resolver

### src/main/services/ai-mayor/v2/gate1-progression-boundary.ts - lines 21-29

```typescript
export interface V2Gate1ProgressionBoundaryOptions {
  foundation: Pick<V2FoundationPorts, "road" | "zoning" | "observation">;
  world: { worldEpochId: string; generation: string };
  previewRoad(input: RoadGeometryInput, signal?: AbortSignal): Promise<unknown>;
  readAvailableRoadPrefabs(signal?: AbortSignal): Promise<readonly string[]>;
}
```

### src/main/services/ai-mayor/v2/gate1-progression-boundary.ts - lines 54-171

```typescript
export function createV2Gate1ProgressionBoundary(options: V2Gate1ProgressionBoundaryOptions): Gate1WorldBoundary {
  const policy = V2_PROJECT_ADMISSION_POLICY;
  const reproduceCandidate = async (
    proposal: Gate1AdmittedProposal,
    signal?: AbortSignal,
  ): Promise<RoadCandidate[]> => {
    const envelope = await options.foundation.observation.capture({
      spatialDetail: {
        x: proposal.target.center.x,
        z: proposal.target.center.z,
        radius: policy.siteObservationRadiusMeters,
        resolution: policy.siteObservationResolution,
      },
      ...(signal ? { signal } : {}),
    });
    const scanSource = envelope.sources.spatialScan;
    if (scanSource.status === "UNAVAILABLE" || scanSource.data === undefined) {
      throw new Error("GATE1_PROGRESSION_SPATIAL_SCAN_UNAVAILABLE");
    }
    const world = buildSpatialWorldModel(parseSpatialBootstrapScan(scanSource.data));
    const availableRoadPrefabs = await options.readAvailableRoadPrefabs(signal);
    const search = await searchBoundedStarterSites({
      world,
      worldEpoch: options.world.worldEpochId,
      bridgeGeneration: options.world.generation,
      availableRoadPrefabs,
      maxAnchors: MAXIMUM_STARTER_ANCHORS,
      maxCandidates: policy.maximumSiteCandidates,
      captureDetail: async (anchor, captureSignal) => {
        const capture = await options.foundation.observation.capture({
          spatialDetail: {
            x: anchor.node.position.x,
            z: anchor.node.position.z,
            radius: policy.siteObservationRadiusMeters,
            resolution: policy.siteObservationResolution,
          },
          ...(captureSignal ? { signal: captureSignal } : {}),
        });
        const detail = capture.sources.spatialDetail;
        if (capture.coherence === "UNKNOWN" || detail.status !== "AVAILABLE" || detail.data === undefined) {
          return { detail: null, coherence: capture.coherence };
        }
        return { detail: detail.data, coherence: capture.coherence };
      },
      accepts: async (candidate) =>
        distance(candidate.target.center, proposal.target.center) <= SITE_TARGET_MATCH_TOLERANCE_METERS,
      ...(signal ? { signal } : {}),
    });
    const anchorsSeen = search.local.anchors + (search.ingress?.anchors ?? 0);
    const observationsSeen = search.local.observations + (search.ingress?.observations ?? 0);
    if (anchorsSeen === 0) throw new Error("GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED");
    if (observationsSeen === 0) throw new Error("GATE1_PROGRESSION_SITE_OBSERVATION_UNKNOWN");
    const matches = search.selection.candidates;
    if (matches.length !== 1) throw new Error("GATE1_PROGRESSION_SITE_TARGET_NOT_REPRODUCED");
    return matches[0].roadCandidates;
  };
  const resolvers: Gate1FoundationProposalResolvers = {
    async road(proposal, signal): Promise<RoadExecutionRequest> {
      const candidates = await reproduceCandidate(proposal, signal);
      const candidate = candidates[proposal.methodVariant === "PRIMARY" ? 0 : 1] ?? candidates[0];
      if (!candidate) throw new Error("GATE1_PROGRESSION_NO_BOUNDED_ROAD_CANDIDATE");
      const productive = await previewProductiveStarterRoad({
        input: candidate.input,
        preview: options.previewRoad,
        signal,
      });
      const roadInput = productive.input;
      const fingerprint = stableRoadInput(roadInput);
      const { quote } = productive;
      return {
        proposal: {
          identity: {
            proposalId: quote.proposalId,
            actionFamily: "ROAD",
            exactInput: fingerprint,
            runtimeEpoch: quote.runtimeEpoch,
            frame: quote.frame,
            validationState: "VALID",
          },
          quoteId: quote.quoteId,
          fingerprint,
          input: roadInput,
          owner: { ownerType: "TASK", ownerId: proposal.taskId },
        },
        quote,
        authorizedMaxSpend: Math.max(quote.signedAmount, 1) * 1.25,
        treasurySafetyReserve: 0,
      };
    },
    async zoning() {
      throw new Gate1ProgressionCapabilityGapError("ZONING");
    },
  };
  return createGate1FoundationBoundary(options.foundation, resolvers);
```

## 3. Road proposal, finance authorization, and exact-input execution

### src/main/services/ai-mayor/v2/finance.ts - lines 22-54

```typescript
export interface ProposalIdentity {
  proposalId: string;
  actionFamily: V2ActionFamily;
  exactInput: string;
  runtimeEpoch: string;
  frame: number;
  validationState: "VALID" | "INVALID";
}
export interface NativeTempEntity {
  tempId: string;
  ownerProposalId: string;
  signedCost: number;
  cancelled: boolean;
  hasTempComponent?: boolean;
}
export interface ProposalQuote {
  schemaVersion: typeof V2_FINANCE_SCHEMA_VERSION;
  proposalId: string;
  quoteId: string;
  actionFamily: V2ActionFamily;
  signedAmount: number;
  eligibleTempEntityCount: number;
  provenance: "OBSERVED_NATIVE";
  sourceKind: "NATIVE_TOOL_TEMP_COST";
  validationResult: "VALID" | "INVALID";
  runtimeEpoch: string;
  frame: number;
  state: QuoteState;
  expiresAt: string;
  exactInput: string;
}
```

### src/main/services/ai-mayor/v2/finance.ts - lines 110-132

```typescript
export function authorizeSpend(input: { observation: FinanceObservation; quote: ProposalQuote | undefined; requiredGrossSpend: number; authorizedMaxSpend: number; treasurySafetyReserve: number; now: Date; operationKind?: "BOUNDED_NETWORK_JUNCTION_INSERT" }): SpendAuthorization {
  const { observation, quote } = input;
  const reject = (reason: string): SpendAuthorization => ({ schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: quote?.proposalId ?? "unknown", quoteId: quote?.quoteId ?? "unknown", authorizedMaxSpend: input.authorizedMaxSpend, provenance: "PLANNED_RESERVED", treasurySafetyReserve: input.treasurySafetyReserve, expiry: input.now.toISOString(), decision: "REJECTED", reason });
  if (observation.freshness !== "FRESH" || !Number.isFinite(observation.treasuryAmount)) return reject("treasury_observation_not_fresh");
  if (typeof observation.unlimitedMoney !== "boolean") return reject("unlimited_money_semantics_unknown");
  if (!quote || quoteState(quote, { runtimeEpoch: observation.runtimeEpoch, frame: observation.frame, now: input.now }) !== "VALID") return reject("quote_unknown_or_stale");
  const typedZeroJunction = input.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
    quote.actionFamily === "ROAD" && quote.signedAmount === 0 && quote.eligibleTempEntityCount > 0 &&
    quote.provenance === "OBSERVED_NATIVE" && quote.sourceKind === "NATIVE_TOOL_TEMP_COST" &&
    quote.exactInput.includes('"kind":"BOUNDED_NETWORK_JUNCTION_INSERT"') && input.requiredGrossSpend === 0 &&
    input.authorizedMaxSpend === 0;
  if (input.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" && quote.signedAmount === 0 && !typedZeroJunction) {
    return reject("typed_zero_quote_requires_zero_spend_cap");
  }
  if (quote.signedAmount === 0 && !typedZeroJunction) return reject("zero_quote_not_authorized_for_operation");
  if (input.authorizedMaxSpend <= 0 && !typedZeroJunction) return reject("authorized_maximum_must_be_positive");
  if (input.requiredGrossSpend > input.authorizedMaxSpend) return reject("required_spend_exceeds_authorized_maximum");
  if (!typedZeroJunction && !observation.unlimitedMoney && observation.treasuryAmount - input.treasurySafetyReserve < input.authorizedMaxSpend) return reject("treasury_below_safety_reserve");
  return { schemaVersion: V2_FINANCE_SCHEMA_VERSION, proposalId: quote.proposalId, quoteId: quote.quoteId, authorizedMaxSpend: input.authorizedMaxSpend, provenance: "PLANNED_RESERVED", treasurySafetyReserve: input.treasurySafetyReserve, expiry: quote.expiresAt, decision: "AUTHORIZED", reason: "fresh_quote_and_treasury_reservation_passed" };
}
```

### src/main/services/ai-mayor/v2/road-kernel.ts - lines 51-66

```typescript
export interface RoadGeometryInput {
  prefab: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  cx?: number;
  cz?: number;
  e1?: number;
  e2?: number;
  startEndpoint?: RoadEndpointAttachment;
  endEndpoint?: RoadEndpointAttachment;
  networkJunctionInsert?: BoundedNetworkJunctionInsert;
}
```

### src/main/services/ai-mayor/v2/road-kernel.ts - lines 104-116

```typescript
export interface RoadProposal {
  identity: ProposalIdentity;
  quoteId: string;
  fingerprint: string;
  input: RoadGeometryInput;
  owner: RoadAuthorizedMutationScope["owner"];
}
export interface RoadExecutionRequest {
  proposal: RoadProposal;
  quote?: ProposalQuote;
  authorizedMaxSpend: number;
  treasurySafetyReserve: number;
```

### src/main/services/ai-mayor/v2/road-kernel.ts - lines 212-238

```typescript
function proposalError(request: RoadExecutionRequest): string | null {
  const { proposal, quote } = request;
  const exactInput = stableRoadInput(proposal.input);
  if (!proposal.identity.proposalId || proposal.identity.actionFamily !== "ROAD") return "invalid_road_proposal_identity";
  if (!proposal.quoteId) return "missing_quote_identity";
  if (proposal.fingerprint !== exactInput || proposal.identity.exactInput !== exactInput) return "proposal_fingerprint_mismatch";
  const junction = proposal.input.networkJunctionInsert;
  if (junction) {
    const preview = request.networkJunctionPreview;
    if (!preview || !preview.generation) return "BOUNDED_JUNCTION_FRESH_PREVIEW_INCOMPLETE";
    const admission = validateBoundedJunctionAdmission({ contract: junction, evidence: preview.evidence });
    if (!admission.valid) return `BOUNDED_JUNCTION_ADMISSION_REJECTED:${admission.reason}`;
    try {
      roadKernelNativeBuildRequest(proposal.input, proposal.identity.proposalId, proposal.quoteId, preview);
    } catch (error) {
      return error instanceof Error ? error.message : "BOUNDED_JUNCTION_NATIVE_CONTACT_WITNESS_INVALID";
    }
    if (quote && (quote.signedAmount !== preview.evidence.quote || quote.sourceKind !== "NATIVE_TOOL_TEMP_COST")) return "BOUNDED_JUNCTION_QUOTE_WITNESS_MISMATCH";
  } else if (request.networkJunctionPreview) return "BOUNDED_JUNCTION_SEMANTIC_MISSING";
  if (!quote) return null;
  if (quote.proposalId !== proposal.identity.proposalId) return "proposal_id_mismatch";
  if (quote.quoteId !== proposal.quoteId) return "quote_id_mismatch";
  if (quote.exactInput !== exactInput) return "quote_fingerprint_mismatch";
  if (!Number.isFinite(request.authorizedMaxSpend) || request.authorizedMaxSpend < 0) return "authorized_max_spend_invalid";
  if (!Number.isFinite(request.treasurySafetyReserve) || request.treasurySafetyReserve < 0) return "treasury_safety_reserve_invalid";
  return null;
}
```

### src/main/services/ai-mayor/v2/road-kernel.ts - lines 250-260

```typescript
export function roadKernelNativeBuildRequest(
  input: RoadGeometryInput,
  proposalId: string,
  quoteId: string,
  junctionPreview?: RoadExecutionRequest["networkJunctionPreview"],
  previewOnly = false,
): RoadKernelNativeBuildRequest {
  const { networkJunctionInsert, ...nativeRoadInput } = input;
  if (!networkJunctionInsert) {
    return { ...nativeRoadInput, proposalId, quoteId, ...(previewOnly ? { previewOnly: true } : {}) };
  }
```

### src/main/services/ai-mayor/v2/road-kernel.ts - lines 331-357

```typescript
function authorizationKey(request: RoadExecutionRequest): string {
  const { identity } = request.proposal;
  return [identity.proposalId, request.proposal.quoteId, request.proposal.fingerprint, identity.runtimeEpoch, identity.frame].join("|");
}
function roadScope(request: RoadExecutionRequest): RoadAuthorizedMutationScope {
  const quote = request.quote;
  const repair = request.facilityAccessRoadRepair;
  const junction = request.proposal.input.networkJunctionInsert;
  const junctionPreview = request.networkJunctionPreview;
  return {
    owner: request.proposal.owner,
    actionFamily: "ROAD",
    proposalId: request.proposal.identity.proposalId,
    quoteId: request.proposal.quoteId,
    fingerprint: request.proposal.fingerprint,
    exactInput: request.proposal.identity.exactInput,
    budget: {
      authorizedMaxSpend: request.authorizedMaxSpend,
      treasurySafetyReserve: request.treasurySafetyReserve,
      currency: "GAME_MONEY",
    },
    observationPrecondition: {
      runtimeEpoch: request.proposal.identity.runtimeEpoch,
      frame: request.proposal.identity.frame,
    },
    expiresAt: quote?.expiresAt ?? new Date(0).toISOString(),
```

### src/main/services/ai-mayor/v2/road-kernel.ts - lines 594-688

```typescript
    async execute(request, signal) {
      await mutex.acquire(signal);
      let executionId = createId();
      const createdAt = now().toISOString();
      const createdRecord: V2CommandRecord = {
        schemaVersion: V2_COMMAND_SCHEMA_VERSION,
        commandId: executionId,
        actionFamily: "ROAD",
        actionType: "build_road",
        authorizedScope: roadScope(request),
        bridgeCommandId: null,
        createdAt,
        submittedAt: null,
        nativeResultSummary: null,
        status: "CREATED",
        statusHistory: [{ status: "CREATED", at: createdAt }],
        reconciliationStatus: "NOT_STARTED",
        observationEvidence: [],
        failureOrUnknownReason: null,
        effectAbsenceProven: false,
      };
      const deferredRepairCommit = !!request.facilityAccessRoadRepair;
      const deferredJunctionCommit = !!request.proposal.input.networkJunctionInsert;
      const junctionExactInput = request.proposal.identity.exactInput;
      const priorJunctionCommand = deferredJunctionCommit
        ? options.journal.list().find((entry) => entry.actionFamily === "ROAD" &&
          entry.authorizedScope.actionFamily === "ROAD" && entry.authorizedScope.exactInput === junctionExactInput &&
          entry.authorizedScope.networkJunctionInsert?.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT")
        : undefined;
      if (priorJunctionCommand) {
        return {
          command: priorJunctionCommand,
          admission: rejectedAuthorization(request, "bounded_junction_operation_already_recorded", now()),
          bridgeCalled: false,
          authorizationConsumed: false,
        };
      }
      if (!deferredRepairCommit && !deferredJunctionCommit) options.journal.create(createdRecord);
      let admission = rejectedAuthorization(request, "admission_unavailable", now());
      let bridgeCalled = false;
      let authorizationConsumed = false;
      try {
        const identityError = proposalError(request);
        if (identityError) admission = rejectedAuthorization(request, identityError, now());
        else {
          let observation: FinanceObservation | undefined;
          try {
            observation = await options.observeFinance(signal);
          } catch {
            observation = undefined;
          }
          if (!observation) admission = rejectedAuthorization(request, "treasury_observation_unavailable", now());
          else {
            admission = authorizeSpend({
              observation,
              quote: request.quote,
              requiredGrossSpend: Math.max(0, request.quote?.signedAmount ?? Number.POSITIVE_INFINITY),
              authorizedMaxSpend: request.authorizedMaxSpend,
              treasurySafetyReserve: request.treasurySafetyReserve,
              now: now(),
              ...(request.proposal.input.networkJunctionInsert ? { operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT" as const } : {}),
            });
            if (admission.decision === "AUTHORIZED") {
              const key = authorizationKey(request);
              if (consumedAuthorizations.has(key)) {
                admission = rejectedAuthorization(request, "authorization_already_consumed", now());
              } else {
                consumedAuthorizations.add(key);
                authorizationConsumed = true;
                if (deferredRepairCommit) {
                  if (!options.persistCreatedCommand) throw new Error("FACILITY_ACCESS_ROAD_DURABLE_COMMIT_UNAVAILABLE");
                  const persisted = options.persistCreatedCommand(createdRecord, request);
                  if (persisted.status !== "CREATED") throw new Error("FACILITY_ACCESS_ROAD_COMMAND_ALREADY_SUBMITTED");
                  executionId = persisted.commandId;
                } else if (deferredJunctionCommit) {
                  if (!options.persistCreatedCommand) throw new Error("BOUNDED_JUNCTION_DURABLE_COMMAND_COMMIT_UNAVAILABLE");
                  const persisted = options.persistCreatedCommand(createdRecord, request);
                  if (persisted.status !== "CREATED") throw new Error("BOUNDED_JUNCTION_COMMAND_ALREADY_SUBMITTED");
                  executionId = persisted.commandId;
                }
                transition(options.journal, executionId, "AUTHORIZED", now().toISOString());
                const submittedAt = now().toISOString();
                transition(options.journal, executionId, "SUBMITTED", submittedAt, undefined, { submittedAt });
                bridgeCalled = true;
                let raw: unknown;
                try {
                  raw = await options.submit(
                    roadKernelNativeBuildRequest(
                      request.proposal.input,
                      request.proposal.identity.proposalId,
                      request.proposal.quoteId,
                      request.networkJunctionPreview,
                    ),
                    signal,
                  );
```

## 4. Durable execution command, exact-input idempotency, and branch/rollback identity

### src/main/services/ai-mayor/v2/foundation.ts - lines 286-319

```typescript
export interface RoadAuthorizedMutationScope {
  owner: AuthorizedMutationScope["owner"];
  actionFamily: "ROAD";
  proposalId: string;
  quoteId: string;
  fingerprint: string;
  exactInput: string;
  budget: {
    authorizedMaxSpend: number;
    treasurySafetyReserve: number;
    currency: string;
  };
  observationPrecondition: {
    runtimeEpoch: string;
    frame: number;
  };
  expiresAt: string;
  facilityAccessRoadRepair?: {
    amendmentId: string;
    repairLineage: string;
    planRevision: string;
    actionFingerprint: string;
    actionCount: 1;
    purpose: string;
    prefab: string;
  };
  networkJunctionInsert?: {
    operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT";
    identityFingerprint: string;
    replacementFingerprint: string;
  };
}
```

### src/main/services/ai-mayor/v2/foundation.ts - lines 349-382

```typescript
export interface V2CommandRecord {
  schemaVersion: typeof V2_COMMAND_SCHEMA_VERSION;
  commandId: string;
  actionFamily: V2ActionFamily;
  actionType: string;
  networkLinkRepairIdentity?: {
    repairLineage: string;
    stepIndex: 1 | 2;
    authorizationId: string;
    quote: number;
    actionIdentity: string;
    startEndpoint: unknown;
    endEndpoint: unknown;
  };
  authorizedScope: V2AuthorizedMutationScope;
  bridgeCommandId?: string | null;
  createdAt: string;
  submittedAt: string | null;
  nativeResultSummary: string | null;
  status: V2CommandStatus;
  statusHistory: Array<{ status: V2CommandStatus; at: string; reason?: string }>;
  reconciliationStatus: "NOT_STARTED" | "MATCH" | "MISMATCH" | "INCONCLUSIVE";
  observationEvidence: CommandObservationEvidence[];
  failureOrUnknownReason: string | null;
  effectAbsenceProven: boolean;
  evidence?: {
    rejectionDiagnostics?: unknown;
    bridgeHttpErrorDiagnostics?: unknown;
    bridgeCommandId?: string;
    mcpBridgeFailureDiagnostics?: unknown;
    nativeBatchSemantics?: unknown;
    nativeActionResults?: unknown;
```

### src/main/services/ai-mayor/v2/durability.ts - lines 173-177

```typescript
export interface V2ProjectBranchIdentity {
  worldId: string;
  checkpointId: string;
  journalCut: number;
}
```

### src/main/services/ai-mayor/v2/durability.ts - lines 331-348

```typescript
export interface V2UtilityBudgetAmendmentRecord {
  schemaVersion: typeof V2_UTILITY_BUDGET_AMENDMENT_SCHEMA_VERSION;
  amendmentId: string;
  projectId: string;
  intentId: string;
  trancheId: string;
  reservationRef: string;
  originalProjectBudget: number;
  requiredUtilityBudget: number;
  amendedEffectiveBudget: number;
  reason:
    | typeof UTILITY_BUDGET_AMENDMENT_REASON
    | typeof UTILITY_CONNECTION_BUDGET_AMENDMENT_REASON
    | typeof FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON;
```

### src/main/services/ai-mayor/v2/durability.ts - lines 363-380

```typescript
  detail: string;
  amendedAt: string;
  status?: "ACTIVE" | "SUPERSEDED_UNUSED" | "CONSUMED";
  planRevision?: string;
  courseFingerprint?: string;
  supersedesAmendmentId?: string | null;
  nativeQuote?: number;
  segmentQuotes?: number[];
  roadPrefab?: string;
  purpose?: string;
  authorizationWorldId?: string;
  authorizationCheckpointId?: string | null;
  authorizationGeneration?: string;
  executionUseLimit?: 1;
  executionUseStatus?: "UNUSED" | "CONSUMED";
  repairLineage?: string;
```

### src/main/services/ai-mayor/v2/durability.ts - lines 394-402

```typescript
export interface V2DurableCommandEntry {
  position: number;
  worldId: string;
  baseCheckpointId: string;
  worldEpochId: string;
  idempotencyKey: string;
  outcome: DurableCommandOutcome;
  record: V2CommandRecord;
}
```

### src/main/services/ai-mayor/v2/durability.ts - lines 537-545

```typescript
export interface V2DurableState {
  schemaVersion: typeof V2_DURABLE_STATE_SCHEMA_VERSION;
  v2StateVersion: 1;
  journalPosition: number;
  checkpoints: V2CheckpointRecord[];
  commands: V2DurableCommandEntry[];
  projectState: V2DurableProjectState;
  baselineActivation?: V2BaselineActivationRecord | null;
  certifiedRollbackAnchor?: V2CertifiedRollbackAnchor | null;
```

### src/main/services/ai-mayor/v2/durability.ts - lines 552-558

```typescript
  supersededProjects?: V2SupersededProjectRecord[];
  utilityBudgetAmendments?: V2UtilityBudgetAmendmentRecord[];
```

### src/main/services/ai-mayor/v2/durability.ts - lines 566-575

```typescript
  active: {
    worldId: string;
    loadedCheckpointId: string | null;
    rollbackBoundaryId: string;
    activatedCheckpointJournalCut?: number;
    worldEpochId: string;
    bridgeRuntimeEpoch: string;
    generation: string;
  } | null;
```

### src/main/services/ai-mayor/v2/durability.ts - lines 1142-1154

```typescript
export function commandIdempotencyKey(record: V2CommandRecord): string {
  const scope = record.authorizedScope;
  const owner = `${scope.owner.ownerType}:${scope.owner.ownerId}`;
  if (scope.actionFamily === "ROAD") return `${owner}:ROAD:${scope.exactInput}`;
  if (scope.actionFamily === "UTILITY") {
    return `${owner}:UTILITY:${scope.utilityKind}:${scope.worldEpochId}:${scope.topologyRevision}:${scope.executionMechanismRevision ?? "legacy-unregistered-localconnect-v1"}:${scope.exactInput}`;
  }
  const cells = scope.allowedCells
    .map((cell) => `${cell.block.index}:${cell.block.version}:${cell.cellIndex}`)
    .sort()
    .join(",");
  return `${owner}:${scope.actionFamily}:${record.actionType}:${cells}`;
}
```

### src/main/services/ai-mayor/v2/durability.ts - lines 2839-2854

```typescript
  isCommandOutsideActiveCheckpoint(commandId: string): boolean {
    this.#assertStoreHealthy();
    const world = this.#current;
    const active = this.#state.active;
    if (this.#blockedReason !== null || !world || !active || !world.checkpointId || active.loadedCheckpointId !== world.checkpointId ||
      active.rollbackBoundaryId !== world.checkpointId) return false;
    const boundary = this.#state.checkpoints.find((checkpoint) =>
      checkpoint.worldId === world.worldId && checkpoint.checkpointId === world.checkpointId && checkpoint.durable,
    );
    const entry = this.#state.commands.find((candidate) =>
      candidate.record.commandId === commandId && candidate.worldId === world.worldId,
    );
    return !!boundary && !!entry && carriesTerminalSuccess(entry) &&
      entry.baseCheckpointId === boundary.checkpointId && entry.position > boundary.journalPosition &&
      entry.worldEpochId !== world.worldEpochId;
```

### src/main/services/ai-mayor/v2/durability.ts - lines 3116-3143

```typescript
  #createCommand(record: V2CommandRecord): void {
    this.#assertStoreHealthy();
    if (!this.#state.active || !this.#current || this.#blockedReason) {
      throw new Error(this.#blockedReason ?? "cannot persist command without an active world identity");
    }
    if (this.#state.commands.some((entry) => entry.record.commandId === record.commandId)) {
      throw new Error(`command already exists: ${record.commandId}`);
    }
    if (record.authorizedScope.actionFamily === "ROAD" && record.authorizedScope.networkJunctionInsert?.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
      this.#state.commands.some((entry) => entry.record.authorizedScope.actionFamily === "ROAD" &&
        entry.record.authorizedScope.networkJunctionInsert?.operationKind === "BOUNDED_NETWORK_JUNCTION_INSERT" &&
        entry.record.authorizedScope.exactInput === record.authorizedScope.exactInput)) {
      throw new Error("BOUNDED_JUNCTION_OPERATION_ALREADY_RECORDED");
    }
    const idempotencyKey = commandIdempotencyKey(record);
    this.assertMutationAllowed(idempotencyKey);
    this.#state.journalPosition += 1;
    this.#state.commands.push({
      position: this.#state.journalPosition,
      worldId: this.#current.worldId,
      baseCheckpointId: this.#state.active.rollbackBoundaryId,
      worldEpochId: this.#current.worldEpochId,
      idempotencyKey,
      outcome: durableOutcome(record),
      record: clone(record),
    });
    this.#trimAndSave();
```

## 5. Project Admission selection, durable identity, and current-branch replan

### src/main/services/ai-mayor/v2/project-admission.ts - lines 128-142

```typescript
export interface V2ProjectAdmissionEvidence {
  worldId: string;
  baselineCheckpointId: string;
  intentId: string;
  projectId: string;
  trancheId: string;
  reservationRef: string;
  selectedCandidateId: string;
  anchorClass: Gate1StarterAnchorClass;
  anchorFallbackReason: Gate1StarterSiteFallbackReason | null;
  inspectedRegions: number;
  eligibleCandidates: number;
```

### src/main/services/ai-mayor/v2/project-admission.ts - lines 308-320

```typescript
export type V2CurrentBranchReplanResult =
  | { status: "REPLANNED"; replan: V2SupersededProjectRecord; state: Gate1State; evidence: V2ProjectAdmissionEvidence }
  | { status: "ALREADY_REPLANNED"; replan: V2SupersededProjectRecord; state: Gate1State };
export function deriveCurrentBranchProjectReplanIdentity(input: V2ProjectBranchIdentity): { replanId: string; intentId: string } {
  if (!input.worldId.trim() || !input.checkpointId.trim() || !Number.isInteger(input.journalCut) || input.journalCut < 0) {
    throw new Error("PROJECT_REPLAN_BRANCH_IDENTITY_INVALID");
  }
  const branch = `${input.worldId}|${input.checkpointId}|${input.journalCut}`;
  const encoded = encodeURIComponent(branch);
  return { replanId: `project-replan:${encoded}`, intentId: `intent:gate1-replan:${encoded}` };
}
```

### src/main/services/ai-mayor/v2/project-admission.ts - lines 589-603

```typescript
    });
    const selected = search.selection.candidates[0];
    if (!selected) {
      const anchorsConsidered = search.local.anchors + (search.ingress?.anchors ?? 0);
      if (anchorsConsidered === 0) throw new Error("PROJECT_ADMISSION_NO_STARTER_ANCHOR");
      if (search.selection.inspectedRegions === 0) throw new Error("PROJECT_ADMISSION_SITE_OBSERVATION_UNKNOWN");
      const evaluatedCandidates = search.local.candidates + (search.ingress?.candidates ?? 0);
      if (siteConstraint && evaluatedCandidates > 0) throw new Error("PROJECT_ADMISSION_NO_VALID_SITE");
      throw new Error("PROJECT_ADMISSION_NO_ELIGIBLE_SITE");
    }
```

### src/main/services/ai-mayor/v2/project-admission.ts - lines 613-643

```typescript
    const intentInput: StarterResidentialIntentInput = {
      intentId,
      targetResidents: policy.targetResidents,
      maximumBudget: funded.maximumBudget,
      planningEnvelope: { center: clone(selected.target.center), radius: selectedRadius },
      siteCandidates: search.selection.candidates.map((candidate) => ({
        id: candidate.id,
        target: clone(candidate.target),
        score: candidate.score,
        blocked: candidate.blocked,
      })),
      starterDirection: clone(selected.direction),
      maximumWaitObservations: policy.maximumWaitObservations,
    };
    const state = planStarterResidentialIntent(intentInput, now());
    createDurableGate1StateStorage(durability).save(state);
    const persisted = durability.projectState();
    if (persisted.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION || persisted.project.id !== state.project.id) {
      throw new Error("PROJECT_ADMISSION_PERSISTENCE_UNVERIFIED");
    }
    const reserved = persisted.project.utilityReservation;
    if (reserved.radius !== selectedRadius || reserved.center.x !== selected.target.center.x || reserved.center.z !== selected.target.center.z) {
      throw new Error("PROJECT_ADMISSION_RESERVATION_UNVERIFIED");
```

### src/main/services/ai-mayor/v2/project-admission.ts - lines 718-753

```typescript
    async replanForCurrentBranch({ detail }, signal) {
      const existing = options.durability.projectState();
      if (existing.schemaVersion !== V2_GATE1_STATE_SCHEMA_VERSION) {
        throw new Error("PROJECT_REPLAN_NO_ADMITTED_PROJECT");
      }
      if (!options.siteConstraint) throw new Error("PROJECT_REPLAN_SITE_CONSTRAINT_REQUIRED");
      const activation = await options.activateDurableWorld(signal);
      if (activation.blockedReason) throw new Error(activation.blockedReason);
      if (!options.durability.isExecutionDurablyActivated(activation)) {
        throw new Error(`${activation.status}: current-branch project replan requires durable activation`);
      }
      const snapshot = options.durability.snapshot();
      const active = snapshot.active;
      const cut = active?.activatedCheckpointJournalCut;
      const checkpointId = activation.world.checkpointId;
      if (!active || !checkpointId || active.worldId !== activation.world.worldId || active.loadedCheckpointId !== checkpointId ||
        active.rollbackBoundaryId !== checkpointId || !Number.isInteger(cut) || cut! < 0) {
        throw new Error("PROJECT_REPLAN_CURRENT_CHECKPOINT_CUT_UNPROVEN");
      }
      const checkpoint = snapshot.checkpoints.find((entry) => entry.worldId === active.worldId && entry.checkpointId === checkpointId);
      if (!checkpoint?.durable || checkpoint.journalPosition !== cut) {
        throw new Error("PROJECT_REPLAN_CHECKPOINT_CUT_MISMATCH");
      }
      const branch: V2ProjectBranchIdentity = { worldId: active.worldId, checkpointId, journalCut: cut! };
      const identity = deriveCurrentBranchProjectReplanIdentity(branch);
      let replan = options.durability.supersededProjects().find(
        (entry) => entry.reason === "CURRENT_BRANCH_REPLAN" && entry.replanId === identity.replanId,
      );
      if (replan?.replacementProjectId === existing.project.id) {
        return { status: "ALREADY_REPLANNED", replan, state: existing };
      }
      if (replan?.replacementProjectId === null && existing.intent.id === identity.intentId) {
        const linked = options.durability.linkProjectSupersessionReplacement(replan.supersessionId, existing.project.id);
        return { status: "ALREADY_REPLANNED", replan: linked, state: existing };
      }
      if (replan && replan.projectId !== existing.project.id && replan.replacementProjectId !== existing.project.id) {
```

## 6. Water Planner serviceRoad production and handoff to caller

### src/main/services/ai-mayor/spatial/types.ts - lines 166-171

```typescript
export interface PlannedRoadSegment {
  id: string;
  role: "main" | "cross" | "side";
  start: SpatialPoint2;
  end: SpatialPoint2;
}
```

### src/main/services/ai-mayor/spatial/types.ts - lines 209-219

```typescript
export interface PlannedUtilityFacility {
  kind: "power" | "water" | "sewage";
  prefab: string;
  position: SpatialPoint2;
  rotationCandidates: number[];
  constructionCost: number;
  expectedCapacity: number;
  siteEvidence: Record<string, number | string>;
  connection: PlannedUtilityConnection;
  serviceRoads?: PlannedRoadSegment[];
}
```

### src/main/services/ai-mayor/spatial/utility-planner.ts - lines 196-219

```typescript
function serviceRoadFor(
  kind: PlannedUtilityFacility["kind"],
  asset: SpatialBootstrapAsset,
  facilityPoint: SpatialPoint2,
  roadNetworkPoint: SpatialPoint2,
): PlannedRoadSegment | undefined {
  const distance = Math.hypot(facilityPoint.x - roadNetworkPoint.x, facilityPoint.z - roadNetworkPoint.z);
  const frontageOffset = Math.max(asset.size.x, asset.size.z) * 0.5 + 12;
  if (distance <= frontageOffset + 8) return undefined;
  const towardNetwork = {
    x: (roadNetworkPoint.x - facilityPoint.x) / distance,
    z: (roadNetworkPoint.z - facilityPoint.z) / distance,
  };
  return {
    id: `${kind}-service-road`,
    role: "side",
    start: roadNetworkPoint,
    end: {
      x: facilityPoint.x + towardNetwork.x * frontageOffset,
      z: facilityPoint.z + towardNetwork.z * frontageOffset,
    },
  };
}
```

### src/main/services/ai-mayor/spatial/utility-planner.ts - lines 543-570

```typescript
function facility(
  kind: PlannedUtilityFacility["kind"],
  asset: SpatialBootstrapAsset,
  sample: GridSample,
  utilityNetworkPoint: SpatialPoint2,
  roadNetworkPoint: SpatialPoint2,
  connectionPrefab: PlannedUtilityFacility["connection"]["prefab"],
  expectedCapacity: number,
  evidence: Record<string, number | string>,
  rotationCandidates = [0, 90, 180, 270],
  plannedServiceRoads?: PlannedRoadSegment[],
): PlannedUtilityFacility {
  const directServiceRoad = serviceRoadFor(kind, asset, sample.point, roadNetworkPoint);
  return {
    kind,
    prefab: asset.prefab,
    position: sample.point,
    rotationCandidates,
    constructionCost: asset.constructionCost,
    expectedCapacity,
    siteEvidence: evidence,
    connection: { prefab: connectionPrefab, start: sample.point, end: utilityNetworkPoint },
    serviceRoads: plannedServiceRoads ?? (directServiceRoad ? [directServiceRoad] : undefined),
  };
}
```

### src/main/services/ai-mayor/spatial/utility-planner.ts - lines 579-620

```typescript
function waterFacilityCandidateSet(input: {
  assets: SpatialBootstrapAsset[];
  groundWaterSites: Array<{ sample: GridSample; utility: { point: SpatialPoint2; distance: number }; road: { point: SpatialPoint2; distance: number } }>;
}): { candidates: PlannedUtilityFacility[]; eligibleGroundwaterAssetCount: number; placementInputCandidateCount: number } {
  const groundAssets = input.assets
    .filter((asset) => !asset.locked && asset.capabilities.freshWaterCapacity > 0 &&
      ((asset.capabilities.allowedWaterTypes?.toLowerCase() ?? "").includes("ground") || asset.capabilities.groundWaterMaximum > 0))
    .sort((a, b) => a.constructionCost - b.constructionCost || a.prefab.localeCompare(b.prefab));
  const rankedByAsset: PlannedUtilityFacility[][] = [];
  let placementInputCandidateCount = 0;
  for (const asset of groundAssets) {
    const frontage = Math.max(asset.size.x, asset.size.z) * 0.5 + 8;
    const assetCandidates: PlannedUtilityFacility[] = [];
    for (const site of input.groundWaterSites) {
      if (site.utility.distance < frontage + 12) continue;
      assetCandidates.push(facility("water", asset, site.sample, site.utility.point, site.road.point, "Small Water Pipe",
        asset.capabilities.freshWaterCapacity,
        { source: "groundwater", groundWater: site.sample.groundWater, groundWaterPollution: site.sample.groundWaterPollution,
          roadDistance: site.road.distance, connectionDistance: site.utility.distance }, [0, 90, 180, 270]));
      placementInputCandidateCount += 1;
    }
    if (assetCandidates.length > 0) rankedByAsset.push(assetCandidates);
  }
  const candidates = rankedByAsset.slice(0, MAX_WATER_PLANNING_CANDIDATES).map((items) => items[0]);
  const reserved = new Set(candidates);
  for (const items of rankedByAsset) {
    for (const candidate of items) {
      if (candidates.length >= MAX_WATER_PLANNING_CANDIDATES) break;
      if (!reserved.has(candidate)) candidates.push(candidate);
    }
  }
  return { candidates: candidates.sort((a, b) => a.constructionCost - b.constructionCost || a.prefab.localeCompare(b.prefab) ||
    Number(b.siteEvidence.groundWater) - Number(a.siteEvidence.groundWater) ||
    Number(a.siteEvidence.connectionDistance) - Number(b.siteEvidence.connectionDistance)),
  eligibleGroundwaterAssetCount: groundAssets.length, placementInputCandidateCount };
}
```

### src/main/services/ai-mayor/spatial/utility-planner.ts - lines 636-670

```typescript
export async function selectStageAWaterPlan(input: {
  model: SpatialWorldModel;
  selectedSite: BootstrapSiteEvaluation;
  areaDetail: SpatialSiteDetail;
  assets: SpatialBootstrapAsset[];
  options?: { networkSource?: "PLANNED_STARTER_ROADS" | "EXISTING_PLAYER_ROADS_ONLY"; siteEnvelope?: { center: SpatialPoint2; radius: number } };
  preflight(candidate: PlannedUtilityFacility): Promise<{ valid: boolean; previewOnly: boolean; reason?: string }>;
}): Promise<{ facility: PlannedUtilityFacility; candidateCount: number; validCandidateCount: number; selectedRank: number; funnel: WaterStageAFunnel }> {
  const base = waterPlanningInputs(input.model, input.selectedSite, input.areaDetail, input.options);
  const candidateSet = waterFacilityCandidateSet({ assets: input.assets, groundWaterSites: base.groundWaterSites });
  const candidates = candidateSet.candidates;
  const funnel: WaterStageAFunnel = {
    ...base.funnel,
    eligibleGroundwaterAssetCount: candidateSet.eligibleGroundwaterAssetCount,
    placementInputCandidateCount: candidateSet.placementInputCandidateCount,
    finalStageACandidateCount: candidates.length,
    firstZeroingFilter: firstZeroingFilter({
      raw: base.funnel.rawTerrainSampleCount, scope: base.funnel.inCurrentScopeCount,
      land: base.funnel.ownedDryBuildableCount, groundwater: base.funnel.groundwaterEligibleCount,
      reach: base.funnel.withinExistingRoadReachCount, assets: candidateSet.eligibleGroundwaterAssetCount,
      placement: candidateSet.placementInputCandidateCount, final: candidates.length,
    }),
  };
  const valid: PlannedUtilityFacility[] = [];
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const preview = await input.preflight(candidate);
    if (preview.valid && preview.previewOnly) valid.push(candidate);
    else reasons.push(preview.reason ?? "FACILITY_PREFLIGHT_REJECTED");
  }
  if (valid.length === 0) throw new NoSupportedWaterTopologyError(candidates.length, 0, reasons.slice(0, MAX_WATER_PLANNING_CANDIDATES), funnel);
  const facility = valid[0];
  return { facility, candidateCount: candidates.length, validCandidateCount: valid.length,
    selectedRank: candidates.indexOf(facility) + 1, funnel };
}
```

### src/main/services/ai-mayor/v2/main-adapter.ts - lines 2477-2498

```typescript
        siteEnvelope: { center: scope.spatialEnvelope.center, radius: scope.spatialEnvelope.radius },
      };
      if (kind === "water" && scope.facilityPlacementOnly === true) {
        const stageA = await selectStageAWaterPlan({
          model, selectedSite: selected, areaDetail: scopedDetail, assets: scan.bootstrapAssets,
          options: { networkSource: planningOptions.networkSource, siteEnvelope: planningOptions.siteEnvelope },
          preflight: async (candidate) => {
            const preview = await constructionPreflightPreview({ type: "place_building", prefab: candidate.prefab,
              x: candidate.position.x, z: candidate.position.z, rotation: candidate.rotationCandidates[0] ?? 0 }, signal);
            return { valid: preview.valid === true, previewOnly: preview.previewOnly === true,
              ...(typeof preview.reason === "string" ? { reason: preview.reason } : {}) };
          },
        });
        plannedResult = { facilities: [stageA.facility], totalFacilityCost: stageA.facility.constructionCost,
          roadAuthorityDiagnostics: {
            roadCountBoundedDetail: scopedDetail.roadGraph.edges.length,
            roadCountAfterAuthorityFilter: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToPlanner: scopedDetail.roadGraph.edges.length,
            roadCountVisibleToCandidateBuilder: scopedDetail.roadGraph.edges.length,
          } };
        waterCandidateDiagnostics = { waterStageACandidateCount: stageA.candidateCount,
```

### src/main/services/ai-mayor/v2/main-adapter.ts - lines 2548-2552

```typescript
      }
      throw error;
    }
    const planned = plannedResult.facilities.find((candidate) => candidate.kind === plannedKind);
    if (!planned) throw new Error(`utility_facility_unavailable:${kind}`);
```

### src/main/services/ai-mayor/v2/main-adapter.ts - lines 3482-3488

```typescript
          };
        });
      };
      return prepareScopedUtilityExecution(input, {
        plan: async (kind, context) => {
          try {
            const planned = await planScopedUtility(kind, planningScope, signal, context);
```

## 7. Existing amendment / child-operation / pre-execution proposal definitions

The excerpts include existing `V2UtilityBudgetAmendmentRecord`, `V2CommandRecord`, and `V2DurableCommandEntry` definitions. No generic durable project amendment, planned/child Road operation, or pre-execution concrete Road proposal record exists in the reviewed Gate1, project-admission, Road Kernel, foundation, and durability source files.

**Generic project-level child Road operation type: NONE**

**Pre-execution durable concrete Road proposal type: NONE**

## FACTS

```text
EXISTING_ROAD_ADMISSION_ACCEPTS_CONCRETE_PROPOSAL=NO
ROAD_AUTHORIZATION_PRESERVES_PROPOSAL_IDENTITY=YES
ROAD_KERNEL_EXECUTES_AUTHORIZED_PROPOSAL=YES
EXISTING_DURABLE_CHILD_OPERATION_CONTAINER=MINIMAL_EXTENSION_REQUIRED

Water serviceRoad native preview:
valid=true
validNewRoadProposal=true

tranche.target is the Gate1 project-level candidate, not the Water facility site.
This is not a target-binding bug.

Current gap: Gate1 Admission cannot create project-level child-operation authorization
for the Planner-selected exact serviceRoad.
```
