import type { UtilityPlacementOperation } from "./durability";

/**
 * Whether a recipe's first facility may be placed, judged only from durable
 * command history.
 *
 * The crash window this closes: a first placement reaches native, the facility
 * really exists in the world, and the process dies before the utility durable
 * completion is written. On restart the observation may be incomplete, so
 * "the facility is not visible" is not evidence that none was built. The only
 * durable evidence that survives that crash is the write-ahead command journal
 * entry recorded before the native call.
 *
 * The invariant, for one admitted scope (project + tranche + reservation +
 * recipe kind + first-facility role):
 *
 * > While any placement operation is unresolved — or may already have mutated
 * > the world — a second placement is never authorized.
 *
 * A new attempt is permitted only when no placement operation exists, or when
 * every one of them is *proven* to have left no facility: either it never
 * reached native, or an authoritative reconciliation proved the absence of the
 * effect.
 *
 * Nothing here consults a process-local flag, an in-memory boolean, a wall
 * clock, or the current observation. All of it comes from the durable journal.
 */
export type FirstFacilityPlacementDurability =
  /** No durable placement operation exists for this scope. */
  | { status: "NONE" }
  /** A prior attempt is proven to have left no facility; a new attempt is permitted. */
  | { status: "TERMINAL_NO_MUTATION"; commandId: string }
  /** A facility was authoritatively placed. Claim it; never place a second one. */
  | { status: "PLACED"; commandId: string }
  /** A prior attempt may have mutated the world and is not reconciled. */
  | { status: "UNRESOLVED"; commandId: string; outcome: UtilityPlacementOperation["outcome"] }
  /** Durable lineage was unavailable or unreadable, so nothing can be proven. */
  | { status: "UNPROVEN"; reason: string };

const PROVEN_NO_MUTATION = (operation: UtilityPlacementOperation): boolean =>
  operation.failedBeforeSubmit || (operation.status === "OBSERVED_MISMATCH" && operation.effectAbsenceProven);

/**
 * Decide from durable placement operations alone.
 *
 * `null` / `undefined` mean the durable lineage could not be read. That is not
 * "no operation": it is "unproven", and it must block placement.
 */
export function firstFacilityPlacementDurability(
  operations: readonly UtilityPlacementOperation[] | null | undefined,
): FirstFacilityPlacementDurability {
  if (operations === null || operations === undefined) {
    return { status: "UNPROVEN", reason: "DURABLE_WORLD_LINEAGE_UNAVAILABLE" };
  }
  if (operations.length === 0) return { status: "NONE" };

  const ordered = [...operations].sort((left, right) => left.position - right.position);
  // A durable success outranks everything: the facility exists, whatever else
  // the history says.
  const placed = ordered.find((operation) => operation.outcome === "OBSERVED_MATCH");
  if (placed) return { status: "PLACED", commandId: placed.commandId };

  // Any operation that is not provably mutation-free keeps the scope unresolved.
  const unresolved = ordered.find((operation) => operation.outcome !== "FAILED" || !PROVEN_NO_MUTATION(operation));
  if (unresolved) {
    return { status: "UNRESOLVED", commandId: unresolved.commandId, outcome: unresolved.outcome };
  }

  // Every operation is `FAILED` *and* proven to have left no facility.
  return { status: "TERMINAL_NO_MUTATION", commandId: ordered[ordered.length - 1].commandId };
}

/**
 * The single place that says whether a first placement may proceed. Both the
 * admission boundary and the native submission boundary call this, so they
 * cannot disagree.
 */
export function firstFacilityPlacementPermitted(state: FirstFacilityPlacementDurability): boolean {
  return state.status === "NONE" || state.status === "TERMINAL_NO_MUTATION";
}

/**
 * Reconcile-first states stay unresolved on purpose: the caller must not
 * declare success and must not resubmit while a facility may already exist.
 */
export function firstFacilityPlacementRequiresReconciliation(state: FirstFacilityPlacementDurability): boolean {
  return state.status === "PLACED" || state.status === "UNRESOLVED" || state.status === "UNPROVEN";
}
