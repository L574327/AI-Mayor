/**
 * Temporal conditions (V1 §4.3).
 *
 * A gate is closed until its declared trigger is observed. CURRENT_TRUE is re-read
 * every compile; LATCH_ON_TRUE latches once and stays open; EVENT opens only on an
 * explicit released release_event. Gate mode is never guessed.
 */

import type {
  BoundGate,
  Comparator,
  GateRecord,
  MetricSample,
  PredicateId,
  PredicateSpec,
  Tri,
  WorldSnapshot,
} from "./types";
import { compareStrings } from "./util";

export function compare(comparator: Comparator, left: number | string | boolean, right: number | string | boolean): boolean {
  switch (comparator) {
    case ">=":
      return Number(left) >= Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case ">":
      return Number(left) > Number(right);
    case "<":
      return Number(left) < Number(right);
    case "==":
      return left === right;
    case "!=":
      return left !== right;
  }
}

export function findSample(
  samples: MetricSample[],
  metric: string,
  scopeKey: string | undefined,
): MetricSample | null {
  const matching = samples.filter(
    (sample) => sample.metric === metric && (scopeKey === undefined || sample.scope_key === scopeKey),
  );
  if (matching.length !== 1) {
    return null;
  }
  return matching[0];
}

/** TRUE / FALSE / UNKNOWN only; UNSUPPORTED is never a truth value. */
export function evaluatePredicate(
  predicate: { metric: string; comparator: Comparator; value: number | string | boolean } | undefined,
  world: WorldSnapshot,
  scopeKey: string | undefined,
): Tri {
  if (!predicate) {
    return "UNKNOWN";
  }
  const sample = findSample(world.metrics, predicate.metric, scopeKey);
  if (!sample || sample.generation !== world.generation || sample.coverage !== "TRUE" || sample.value === null) {
    return "UNKNOWN";
  }
  return compare(predicate.comparator, sample.value, predicate.value) ? "TRUE" : "FALSE";
}

/**
 * Registered predicates that project onto a metric sample. A predicate that carries no
 * comparator/threshold/scope in its params is not evaluable here and reports UNKNOWN —
 * it is never assumed TRUE (V1 §7: an uncheckable hard obligation cannot be split into
 * "build the means now, check later").
 */
export const PREDICATE_METRIC: Partial<Record<PredicateId, string>> = {
  "pollution.at_receptor": "pollution",
  "population.count": "population",
  "cash.amount": "cash",
  "building.floors": "floors",
  "density.population_built": "density",
  "grid.purity": "grid_purity",
  "noise.level": "noise",
};

/** Evaluate a typed predicate against the world. Polarity is applied only after truth. */
export function evaluatePredicateSpec(spec: PredicateSpec, world: WorldSnapshot): Tri {
  const metric = PREDICATE_METRIC[spec.predicate];
  if (!metric) {
    return "UNKNOWN";
  }
  const comparator = spec.params.comparator as Comparator | undefined;
  const value = spec.params.value as number | string | boolean | undefined;
  const scopeKey = typeof spec.params.scope_key === "string" ? spec.params.scope_key : undefined;
  if (comparator === undefined || value === undefined) {
    return "UNKNOWN";
  }
  const truth = evaluatePredicate({ metric, comparator, value }, world, scopeKey);
  if (truth === "UNKNOWN") {
    return "UNKNOWN";
  }
  return spec.negated ? (truth === "TRUE" ? "FALSE" : "TRUE") : truth;
}

/**
 * Evaluate every bound gate against the world, latching LATCH_ON_TRUE gates whose
 * predicate has become TRUE. Mutates only the latch/release bookkeeping of the
 * accepted revision; the declaration itself is immutable.
 */
export function evaluateGates(revision: { gates: BoundGate[] }, world: WorldSnapshot, revisionNumber: number): GateRecord[] {
  return revision.gates
    .map((gate): GateRecord => {
      let state: Tri;
      if (gate.mode === "EVENT") {
        state = gate.released_by_update_id ? "TRUE" : gate.release_event ? "FALSE" : "UNKNOWN";
      } else if (gate.mode === "LATCH_ON_TRUE") {
        if (gate.latch_satisfied_at_revision !== null) {
          state = "TRUE";
        } else {
          state = evaluatePredicate(gate.predicate, world, gate.time_base);
          if (state === "TRUE") {
            gate.latch_satisfied_at_revision = revisionNumber;
          }
        }
      } else {
        state = evaluatePredicate(gate.predicate, world, gate.time_base);
      }
      return {
        gate_ref: gate.gate_ref,
        mode: gate.mode,
        state,
        affects: [...gate.affects],
        latch_satisfied_at_revision: gate.latch_satisfied_at_revision,
        released_by_update_id: gate.released_by_update_id,
      };
    })
    .sort((a, b) => compareStrings(a.gate_ref, b.gate_ref));
}
