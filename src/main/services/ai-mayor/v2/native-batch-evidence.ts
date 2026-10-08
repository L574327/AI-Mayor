import type { MayorAction, MayorBatchResult } from "../types";

/** Multiple road actions cannot be admitted by independent pre-batch previews. */
export function requiresSequentialRoadExecution(actions: MayorAction[]): boolean {
  return actions.filter((action) => action.type === "build_road").length > 1;
}

/**
 * MCP mayor batches are ordered sequences, not transactions. Result rows prove
 * that a Bridge request returned/threw; they do not prove the requested world
 * effect. Keep that distinction explicit in the durable journal.
 */
export function nativeBatchActionEvidence(input: {
  actions: MayorAction[];
  quotes: Array<number | undefined>;
  batch: MayorBatchResult;
  operationId: string;
}): { batchSemantics: Record<string, unknown>; actions: Array<Record<string, unknown>> } {
  const returnedRows = new Map(input.batch.results.map((row) => [row.index, row]));
  return {
    batchSemantics: {
      atomic: false,
      executionOrder: "INPUT_ORDER",
      requestedActionCount: input.actions.length,
      attemptedActionCount: input.batch.executed,
      bridgeBatchOk: input.batch.ok,
      worldEffectConfirmedCount: 0,
      countMeaning: "action result rows recorded by sequential MCP handler; not native effect count",
    },
    actions: input.actions.map((action, index) => {
      const row = returnedRows.get(index);
      const bridgeCommandId = typeof row?.bridgeCommandId === "string" ? row.bridgeCommandId : null;
      return {
        actionIndex: index,
        fingerprint: JSON.stringify(action),
        requestedAction: structuredClone(action),
        requestedCourse:
          action.type === "build_road"
            ? {
                prefab: action.prefab,
                start: { x: action.x1, z: action.z1 },
                end: { x: action.x2, z: action.z2 },
              }
            : null,
        prefab: action.type === "build_road" ? action.prefab : null,
        quote: input.quotes[index] ?? null,
        submitted: row !== undefined,
        attempted: row !== undefined,
        bridgeRequestOutcome: row ? (row.ok ? "RETURNED" : "ERROR") : "NOT_REACHED",
        nativeAcceptance: "UNKNOWN",
        nativeReturnStatus: null,
        errorCode: row && !row.ok ? (row.error ?? null) : null,
        errorReason: row && !row.ok ? row.summary : null,
        rejectionDiagnostics: row?.rejectionDiagnostics ?? null,
        operationId: bridgeCommandId ?? input.operationId,
        effectWitness: null,
        resultingEntities: [],
        authoritativeEffectStatus: "UNOBSERVED",
        failureStage: row && !row.ok ? "BRIDGE_ACTION_REQUEST" : row ? null : "NOT_REACHED",
      };
    }),
  };
}
