/**
 * Deterministic local compiler entry point (V1 §11).
 *
 * Order is fixed: type/version validation → build the complete candidate revision and
 * bind its scopes → semantic/reference/owner/definite-conflict checks → atomic accept →
 * capability resolution and finite effect composition → permission/preserve/temporal
 * lowering → hard/unknown/independence diagnostics. Acceptance is not an executability
 * or permission pass.
 *
 * Nothing here reads natural language. `source_span` and `source_span_comment` are
 * provenance text; the compiler never derives semantics from them.
 */

import { lowerRevision } from "./lowering";
import { applyUpdate } from "./revision";
import { verifyScope, cloneBoundScope } from "./scope";
import type { AcceptedRevision, CompileInput, CompileResult, Diagnostic, WorldSnapshot } from "./types";

const reject = (diagnostics: Diagnostic[]): CompileResult => ({
  outcome: "REJECTED",
  revision: null,
  artifact: null,
  pause: null,
  diagnostics,
});

/**
 * Recompile an already accepted revision against a new world snapshot. SNAPSHOT scopes
 * are re-verified, never re-captured; DYNAMIC scopes re-run their fixed selector and
 * bind first-entry baselines for new members.
 */
function recompile(revision: AcceptedRevision, world: WorldSnapshot): AcceptedRevision {
  const clone: AcceptedRevision = {
    ...revision,
    session: world.session,
    world_generation: world.generation,
    clauses: revision.clauses.map((clause) => ({ ...clause, bound_scope: cloneBoundScope(clause.bound_scope) })),
    carves: revision.carves.map((carve) => ({ ...carve, bound_scope: cloneBoundScope(carve.bound_scope) })),
    gates: revision.gates.map((gate) => ({ ...gate, affects: [...gate.affects] })),
    applied_events: [...revision.applied_events],
  };
  for (const clause of clone.clauses) {
    if (clause.status === "ACTIVE") {
      verifyScope(clause.bound_scope, world, clause.aspects, clone.revision);
    }
  }
  for (const carve of clone.carves) {
    verifyScope(carve.bound_scope, world, carve.aspects, clone.revision);
  }
  return clone;
}

export function compile(input: CompileInput): CompileResult {
  if (input.update === null) {
    if (!input.revision) {
      return reject([
        { code: "INVALID_IR", severity: "REJECT", refs: [], detail: "no update and no revision to recompile" },
      ]);
    }
    const revision = recompile(input.revision, input.world);
    const { artifact, diagnostics } = lowerRevision({
      revision,
      world: input.world,
      capabilities: input.capabilities,
      evidence: input.evidence,
    });
    return { outcome: "ACCEPTED", revision, artifact, pause: null, diagnostics };
  }

  const application = applyUpdate(input.update, input.revision, input.world);
  if (!application.ok || !application.revision) {
    return {
      outcome: "REJECTED",
      revision: null,
      artifact: null,
      pause: application.pause ?? null,
      diagnostics: application.diagnostics,
    };
  }

  const revision = application.revision;
  const replay = input.revision?.replay_results?.[input.update.update_id];
  if (replay) {
    return { outcome: "ACCEPTED", revision, artifact: structuredClone(replay.artifact), pause: null, diagnostics: structuredClone(replay.diagnostics) };
  }
  const lowered = lowerRevision({
    revision,
    world: input.world,
    capabilities: input.capabilities,
    evidence: input.evidence,
  });

  // A definite hard-hard contradiction is a declaration-level conflict: the update is
  // rejected as a whole and the previous accepted set is preserved byte-identical.
  const hardConflicts = lowered.diagnostics.filter(
    (diagnostic) => diagnostic.code === "HARD_CONFLICT" && diagnostic.severity === "REJECT",
  );
  if (hardConflicts.length > 0) {
    return reject([...application.diagnostics, ...hardConflicts]);
  }

  const acceptedDiagnostics = [...application.diagnostics, ...lowered.diagnostics];
  const snapshot = structuredClone(revision);
  delete snapshot.replay_results;
  revision.replay_results ??= {};
  revision.replay_results[input.update.update_id] = { revision: snapshot, artifact: structuredClone(lowered.artifact), diagnostics: structuredClone(acceptedDiagnostics) };
  return {
    outcome: "ACCEPTED",
    revision,
    artifact: lowered.artifact,
    pause: null,
    diagnostics: acceptedDiagnostics,
  };
}
