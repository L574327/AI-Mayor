import {
  createDurableGreenfieldUtilityState,
  ensureMechanismRevisionRetry,
  type GreenfieldUtilityExecutionScope,
} from "../../src/main/services/ai-mayor/v2/greenfield-utility-bootstrap";
import { commandIdempotencyKey } from "../../src/main/services/ai-mayor/v2/durability";
import type { SpatialEntityRef } from "../../src/main/services/ai-mayor/spatial/types";
import type { V2CommandRecord } from "../../src/main/services/ai-mayor/v2/foundation";

const ROAD: SpatialEntityRef = { index: 45629, version: 15 };
const scope: GreenfieldUtilityExecutionScope = {
  intentId: "intent:gate1-starter:mechanism-retry",
  projectId: "project-k05",
  trancheId: "tranche-k05",
  reservationRef: "reservation-k05",
  worldId: "cs2-session:test",
  worldEpochId: "cs2-session:test:generation:new",
  generation: "new-generation",
  topologyRevision: "topology-1",
  executionMechanismRevision: "localconnect-membership-production-v2",
  certifiedRoadRefs: [ROAD],
  targetServiceEntry: { road: ROAD, position: { x: 0, z: 0 } },
  spatialEnvelope: { center: { x: 0, z: 0 }, radius: 100 },
  maximumSpend: 1000,
  treasury: 2000,
  treasurySafetyReserve: 100,
};

function oldFailedState() {
  const state = createDurableGreenfieldUtilityState(scope);
  const exactActions = [{ type: "build_road" as const, prefab: "Low-voltage Ground Cable", start: { x: 0, z: 0 }, end: { x: 1, z: 1 } }];
  state.utilities.electricity.candidateLedger = [{
    candidateId: "objective:direct-cable",
    objectiveId: "objective",
    kind: "direct-cable",
    ordinal: 0,
    exactActions,
    actionFingerprint: JSON.stringify(exactActions),
    approvedPlanRevision: "topology-1",
    spatialScope: scope.spatialEnvelope,
    budgetCeiling: scope.maximumSpend,
    ledgerState: "FAILED_DETERMINISTIC",
    commandId: "fa032a75-9676-44da-828b-1951f670a74e",
    primitiveEffect: "OBSERVED_MISMATCH",
  }];
  return state.utilities.electricity;
}

describe("engine mechanism revision retry", () => {
  it("permits one same-geometry retry while preserving the old failed attempt", () => {
    const state = oldFailedState();
    expect(ensureMechanismRevisionRetry(state, scope.executionMechanismRevision!)).toBe(true);

    expect(state.candidateLedger[0].ledgerState).toBe("FAILED_DETERMINISTIC");
    expect(state.candidateLedger[0].commandId).toBe("fa032a75-9676-44da-828b-1951f670a74e");
    const retries = state.candidateLedger.filter((candidate) =>
      candidate.executionMechanismRevision === scope.executionMechanismRevision);
    expect(retries).toHaveLength(1);
    expect(retries[0].actionFingerprint).toBe(state.candidateLedger[0].actionFingerprint);
    expect(retries[0].ledgerState).toBe("NOT_ATTEMPTED");
    expect(ensureMechanismRevisionRetry(state, scope.executionMechanismRevision!)).toBe(false);
    expect(state.candidateLedger).toHaveLength(2);
  });

  it("keeps retry authority stable across a durable reload", () => {
    const state = oldFailedState();
    ensureMechanismRevisionRetry(state, scope.executionMechanismRevision!);
    const reloaded = structuredClone(state);
    expect(ensureMechanismRevisionRetry(reloaded, scope.executionMechanismRevision!)).toBe(false);
    expect(reloaded.candidateLedger).toHaveLength(2);
    expect(reloaded.candidateLedger[0].ledgerState).toBe("FAILED_DETERMINISTIC");
  });

  it("separates mechanism idempotency without changing the legacy command record", () => {
    const base = {
      schemaVersion: "ai-mayor-v2-command/1",
      commandId: "old-command",
      actionFamily: "UTILITY",
      actionType: "build_road",
      createdAt: "2026-01-01T00:00:00.000Z",
      submittedAt: null,
      nativeResultSummary: null,
      status: "FAILED_DETERMINISTIC",
      statusHistory: [{ status: "FAILED_DETERMINISTIC", at: "2026-01-01T00:00:00.000Z" }],
      reconciliationStatus: "MISMATCH",
      observationEvidence: [],
      failureOrUnknownReason: "PROVEN_MISMATCH",
      effectAbsenceProven: false,
      authorizedScope: {
        owner: { ownerType: "TRANCHE", ownerId: scope.trancheId },
        actionFamily: "UTILITY",
        utilityKind: "electricity",
        projectId: scope.projectId,
        trancheId: scope.trancheId,
        reservationRef: scope.reservationRef,
        worldEpochId: scope.worldEpochId,
        generation: scope.generation,
        topologyRevision: scope.topologyRevision,
        certifiedRoadRefs: [ROAD],
        exactInput: "same-cable-geometry",
        spatialEnvelope: scope.spatialEnvelope,
        budget: { authorizedMaxSpend: 1000, treasurySafetyReserve: 100, currency: "GAME_MONEY" },
      },
    } as unknown as V2CommandRecord;
    const revised = structuredClone(base);
    revised.authorizedScope = { ...revised.authorizedScope, executionMechanismRevision: scope.executionMechanismRevision };
    expect(commandIdempotencyKey(base)).not.toBe(commandIdempotencyKey(revised));
    expect(base.commandId).toBe("old-command");
    expect(base.status).toBe("FAILED_DETERMINISTIC");
  });
});
