import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB, type SpatialPoint2 } from "../spatial/types";
import type { MayorAction } from "../types";
import type { PreparedUtilityExecution, UtilityPreparationFailure, UtilityPreparationInput } from "./utility-execution-planner";

export interface RouteBProvenance {
  worldId: string;
  worldEpochId: string;
  generation: string;
  loaded: boolean;
  ready: boolean;
  clean: boolean;
  evidence: Record<string, unknown>;
}

export type RouteBActionGuardResult =
  | { status: "PASS"; action: Extract<MayorAction, { type: "build_road" }> }
  | { status: "BLOCKED"; reason: "ROUTE_B_EXPECTED_ONE_MUTATION_MISSING" | "ROUTE_B_EXPECTED_ONE_MUTATION_VIOLATED" | "ROUTE_B_UNEXPECTED_ACTION_TYPE" | "ROUTE_B_FORBIDDEN_SETUP_ACTION"; actionCount: number };

export function assertExactlyOneRouteBAction(actions: MayorAction[]): RouteBActionGuardResult {
  if (actions.length === 0) return { status: "BLOCKED", reason: "ROUTE_B_EXPECTED_ONE_MUTATION_MISSING", actionCount: 0 };
  if (actions.length !== 1) return { status: "BLOCKED", reason: "ROUTE_B_EXPECTED_ONE_MUTATION_VIOLATED", actionCount: actions.length };
  const action = actions[0];
  if (action.type !== "build_road") return { status: "BLOCKED", reason: "ROUTE_B_UNEXPECTED_ACTION_TYPE", actionCount: actions.length };
  if (action.prefab !== ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB) {
    return { status: "BLOCKED", reason: "ROUTE_B_FORBIDDEN_SETUP_ACTION", actionCount: actions.length };
  }
  return { status: "PASS", action };
}

export function assertPreparedBoundary1Contract(prepared: PreparedUtilityExecution): "YES" | "NO" {
  const contract = prepared.boundary1Contract;
  return contract?.prefab === ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB &&
    contract.creationFlags === 65536 && contract.original === null &&
    contract.start.entity === null && contract.start.flags === 51 &&
    contract.end.entity === null && contract.end.flags === 51 ? "YES" : "NO";
}

export interface RouteBThinHarnessPorts {
  provenance(): Promise<RouteBProvenance>;
  prepare(input: UtilityPreparationInput): Promise<PreparedUtilityExecution | UtilityPreparationFailure>;
}

function preparationEvidence(prepared: PreparedUtilityExecution | UtilityPreparationFailure) {
  const diagnostics = prepared.status === "READY" ? prepared.diagnostics ?? {} : prepared.diagnostics ?? {};
  const currentBinding = diagnostics.currentBinding as Record<string, unknown> | undefined;
  return {
    facilityBindingUnique: currentBinding?.facility !== undefined ? "YES" : "NOT_REACHED",
    connectorBindingUnique: currentBinding?.connector !== undefined ? "YES" : "NOT_REACHED",
    candidateSourceAuthoritative: diagnostics.candidateBuilderCalled === true ? "YES" : "NOT_REACHED",
    candidateCount: typeof diagnostics.candidateCount === "number" ? diagnostics.candidateCount : null,
    candidateActionCount: typeof diagnostics.candidateActionCount === "number" ? diagnostics.candidateActionCount :
      (prepared.status === "READY" ? prepared.candidate.actions.length : null),
    selectedCandidatePrimitive: typeof diagnostics.selectedCandidatePrimitive === "string" ? diagnostics.selectedCandidatePrimitive :
      (prepared.status === "READY" ? prepared.candidate.primitive : null),
  };
}

export async function runRouteBProofOnly(input: UtilityPreparationInput, ports: RouteBThinHarnessPorts) {
  const provenance = await ports.provenance();
  if (!provenance.loaded || !provenance.ready || !provenance.clean) {
    return { status: "BLOCKED" as const, provenance, nativeMutationCount: 0, reason: "ROUTE_B_PROVENANCE_OR_CLEAN_WORLD_FAILED" };
  }
  const prepared = await ports.prepare(input);
  if (prepared.status !== "READY") return {
    status: "BLOCKED" as const, provenance, nativeMutationCount: 0, prepared,
    proofEvidence: preparationEvidence(prepared), reason: prepared.reason,
  };
  const actionGuard = assertExactlyOneRouteBAction(prepared.nativeActions);
  if (actionGuard.status !== "PASS") return { status: "BLOCKED" as const, provenance, nativeMutationCount: 0, prepared, actionGuard, reason: actionGuard.reason };
  return {
    status: "READY" as const,
    provenance,
    prepared,
    actionGuard,
    preparedBoundary1NativeEquivalent: assertPreparedBoundary1Contract(prepared),
    nativeMutationCount: 0,
    mode: "PROOF_ONLY" as const,
  };
}

export function routeBSpatialEnvelope(anchor: SpatialPoint2, radius = 256) {
  return { center: { ...anchor }, radius };
}
