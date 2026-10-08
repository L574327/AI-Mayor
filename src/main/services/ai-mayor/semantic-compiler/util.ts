/**
 * Small deterministic helpers shared by the compiler modules.
 *
 * Nothing here reads natural language or provider identity: `stableStringify`
 * normalises object key order so that two semantically equal payloads compare
 * equal, and `digest` gives a stable local fingerprint for UPDATE_ID_COLLISION.
 */

import type { Tri } from "./types";

export const triAnd = (values: Tri[]): Tri => {
  if (values.includes("FALSE")) {
    return "FALSE";
  }
  if (values.includes("UNKNOWN")) {
    return "UNKNOWN";
  }
  return "TRUE";
};

export const triOr = (values: Tri[]): Tri => {
  if (values.includes("TRUE")) {
    return "TRUE";
  }
  if (values.includes("UNKNOWN")) {
    return "UNKNOWN";
  }
  return "FALSE";
};

export const triFromBool = (value: boolean | null | undefined): Tri => {
  if (value === true) {
    return "TRUE";
  }
  if (value === false) {
    return "FALSE";
  }
  return "UNKNOWN";
};

/** Order-independent canonical JSON: object keys sorted, array order preserved. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** FNV-1a over the canonical form. Stable across processes and platforms. */
export function digest(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
