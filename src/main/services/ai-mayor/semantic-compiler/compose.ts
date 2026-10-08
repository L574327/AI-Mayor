/**
 * Finite mapping effect composition (V1 §8).
 *
 * Order is fixed and order-independent:
 *   1. hard constraints on the same key/domain intersect through a registered operator;
 *      a missing operator is EFFECT_COMPOSITION_UNDEFINED and writes nothing for the key;
 *   2. hard-hard incompatibility is a declaration-level HARD_CONFLICT;
 *   3. soft preferences are applied lexicographically inside the legal set, and an
 *      unregistered same-key soft conflict writes nothing and reports SOFT_TIE_UNRESOLVED;
 *   4. ties are broken by the normalized stable mapping id, never by clause input order
 *      or by provider.
 */

import type {
  ComposedEffect,
  Diagnostic,
  EffectComposition,
  EffectDef,
  MappingRegistry,
  MergeOperatorId,
  ScopeExtent,
} from "./types";
import { stableStringify } from "./util";

export interface DeclarationEffect {
  /** Stable mapping id + version, e.g. "form.grid.set@v1". */
  source_ref: string;
  effect: EffectDef;
  extent: ScopeExtent;
  members: string[];
}

const domainKey = (effect: EffectDef): string => `${effect.key}@${effect.domain}`;

type Range = { min?: number; max?: number };

const asRange = (value: EffectDef["value"]): Range | null => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Range;
  }
  return null;
};

const asList = (value: EffectDef["value"]): string[] | null => {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return null;
};

interface MergeOutcome {
  value: EffectDef["value"] | null;
  conflict: boolean;
  undefined_operator: boolean;
}

const merge = (
  operator: MergeOperatorId | undefined,
  current: EffectDef["value"],
  next: EffectDef["value"],
): MergeOutcome => {
  if (operator === undefined) {
    const identical = JSON.stringify(current) === JSON.stringify(next);
    return identical
      ? { value: current, conflict: false, undefined_operator: false }
      : { value: null, conflict: false, undefined_operator: true };
  }
  switch (operator) {
    case "set.equal":
    case "bool.and": {
      const left = JSON.stringify(current);
      const right = JSON.stringify(next);
      return left === right
        ? { value: current, conflict: false, undefined_operator: false }
        : { value: null, conflict: true, undefined_operator: false };
    }
    case "range.intersect": {
      const a = asRange(current);
      const b = asRange(next);
      if (!a || !b) {
        return { value: null, conflict: true, undefined_operator: false };
      }
      const min = Math.max(...[a.min, b.min].filter((v): v is number => typeof v === "number"), -Infinity);
      const max = Math.min(...[a.max, b.max].filter((v): v is number => typeof v === "number"), Infinity);
      if (min > max) {
        return { value: null, conflict: true, undefined_operator: false };
      }
      const merged: Range = {};
      if (Number.isFinite(min)) {
        merged.min = min;
      }
      if (Number.isFinite(max)) {
        merged.max = max;
      }
      return { value: merged, conflict: false, undefined_operator: false };
    }
    case "use.union": {
      const a = asList(current) ?? [String(current)];
      const b = asList(next) ?? [String(next)];
      return { value: [...new Set([...a, ...b])].sort(), conflict: false, undefined_operator: false };
    }
    case "numeric.min": {
      const a = Number(current);
      const b = Number(next);
      return { value: Math.min(a, b), conflict: false, undefined_operator: false };
    }
    case "numeric.max": {
      const a = Number(current);
      const b = Number(next);
      return { value: Math.max(a, b), conflict: false, undefined_operator: false };
    }
  }
};

export function composeEffects(
  declarations: DeclarationEffect[],
  registry: MappingRegistry,
): { composition: EffectComposition; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const groups = new Map<string, DeclarationEffect[]>();
  const byBase = new Map<string, DeclarationEffect[]>();
  for (const declaration of declarations) {
    const base = domainKey(declaration.effect);
    byBase.set(base,[...(byBase.get(base) ?? []),declaration]);
    const key = base + "#" + stableStringify(declaration.extent);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(declaration);
    } else {
      groups.set(key, [declaration]);
    }
  }

  const effects: ComposedEffect[] = [];
  const undefinedKeys: string[] = [];
  const softTies: string[] = [];

  const unsafe = new Set<string>();
  for (const [base, entries] of byBase) {
    for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
      const a=entries[i],b=entries[j];
      if (stableStringify(a.extent) === stableStringify(b.extent)) continue;
      if (a.extent.cells.some((cell)=>b.extent.cells.includes(cell)) ||
        a.members.some((member)=>b.members.includes(member))) unsafe.add(base);
    }
    if (unsafe.has(base)) {
      undefinedKeys.push(base);
      diagnostics.push({ code:"EFFECT_COMPOSITION_UNDEFINED",severity:"BLOCK",refs:entries.map((e)=>e.source_ref).sort(),
        detail:base + ": overlapping but unequal effect scopes require a registered spatial merge; no write emitted" });
    }
  }

  for (const [key, bucket] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const base = domainKey(bucket[0].effect);
    if (unsafe.has(base)) continue;
    const hard = bucket.filter((entry) => entry.effect.hard).sort((a, b) => (a.source_ref < b.source_ref ? -1 : 1));
    const soft = bucket.filter((entry) => !entry.effect.hard).sort((a, b) => (a.source_ref < b.source_ref ? -1 : 1));
    const operator = registry.merge_operators[base] ?? registry.merge_operators[bucket[0]?.effect.key ?? base];
    const sources = bucket.map((entry) => entry.source_ref).sort();

    if (hard.length > 0) {
      let value = hard[0].effect.value;
      let conflicted = false;
      let undefinedOperator = false;
      for (const entry of hard.slice(1)) {
        const outcome = merge(operator, value, entry.effect.value);
        if (outcome.conflict || outcome.undefined_operator) {
          conflicted = outcome.conflict;
          undefinedOperator = outcome.undefined_operator;
          break;
        }
        value = outcome.value as EffectDef["value"];
      }
      if (conflicted) {
        diagnostics.push({
          code: "HARD_CONFLICT",
          severity: "REJECT",
          refs: sources,
          detail: `${key}: hard declarations are not simultaneously satisfiable`,
        });
        continue;
      }
      if (undefinedOperator) {
        diagnostics.push({
          code: "EFFECT_COMPOSITION_UNDEFINED",
          severity: "BLOCK",
          refs: sources,
          detail: `${key}: no registered merge operator for these hard declarations; the key is not written`,
        });
        undefinedKeys.push(key);
        continue;
      }
      effects.push({
        key: hard[0].effect.key,
        domain: hard[0].effect.domain,
        aspect: hard[0].effect.aspect,
        op: hard[0].effect.op,
        value,
        sources,
        extent: bucket[0].extent,
      });
      for (const entry of soft) {
        diagnostics.push({
          code: "SOFT_TIE_UNRESOLVED",
          severity: "INFO",
          refs: [entry.source_ref],
          detail: `${key}: soft preference yields to the hard constraint; recorded as a disclosed loss`,
        });
      }
      continue;
    }

    const ranked = soft.filter((entry) => typeof entry.effect.soft_rank === "number");
    if (ranked.length > 0) {
      const best = Math.max(...ranked.map((entry) => entry.effect.soft_rank ?? Number.NEGATIVE_INFINITY));
      const winners = ranked
        .filter((entry) => entry.effect.soft_rank === best)
        .sort((a, b) => (a.source_ref < b.source_ref ? -1 : 1));
      const distinct = new Set(winners.map((entry) => JSON.stringify(entry.effect.value)));
      if (distinct.size > 1) {
        diagnostics.push({
          code: "SOFT_TIE_UNRESOLVED",
          severity: "INFO",
          refs: winners.map((entry) => entry.source_ref),
          detail: `${key}: same registered soft level with different values; the key is not written`,
        });
        softTies.push(key);
        continue;
      }
      effects.push({
        key: winners[0].effect.key,
        domain: winners[0].effect.domain,
        aspect: winners[0].effect.aspect,
        op: winners[0].effect.op,
        value: winners[0].effect.value,
        sources: winners.map((entry) => entry.source_ref),
        extent: bucket[0].extent,
      });
      continue;
    }

    // No registered rank: only identical values may be written together.
    const first = soft[0];
    const distinct = new Set(soft.map((entry) => JSON.stringify(entry.effect.value)));
    if (distinct.size > 1) {
      diagnostics.push({
        code: "SOFT_TIE_UNRESOLVED",
        severity: "INFO",
        refs: sources,
        detail: `${key}: unranked soft conflict; the key is not written`,
      });
      softTies.push(key);
      continue;
    }
    effects.push({
      key: first.effect.key,
      domain: first.effect.domain,
      aspect: first.effect.aspect,
      op: first.effect.op,
      value: first.effect.value,
      sources,
      extent: bucket[0].extent,
    });
  }

  return { composition: { effects, undefined_keys: undefinedKeys, soft_ties: softTies }, diagnostics };
}
