import type { MayorStructuredGoalIntent } from "../types";

/**
 * Deterministic "structured intent → primitive calls" table.
 *
 * This is a lookup, not a controller: it owns no state, calls nothing and decides
 * nothing about the world. It answers one question — which primitives does this
 * intent need, and does the product have each of them — so a stated intent is
 * either mapped onto existing primitives or refused BY NAME as a capability gap,
 * never silently dropped (the old behaviour returned `null`, which is
 * indistinguishable from "not understood").
 *
 * `PRIMITIVE_STATUS` is the single place that says what the product can execute.
 * A gap closes by flipping its entry when the primitive lands — and only then.
 */
export type IntentPrimitive =
  | "ROAD_GRID" | "ZONE" | "UTILITY"
  | "SITE_REGION:NEAR_EXISTING" | "SITE_REGION:WATERFRONT" | "SITE_REGION:INFILL"
  | "SITE_REGION:EDGE" | "SITE_REGION:FAR"
  | "ZONE_DENSITY" | "ROAD_UPGRADE" | "CURVED_ROAD" | "ROUNDABOUT"
  | "SERVICE_BUILDING" | "DEMOLISH" | "BRIDGE" | "LAND_PURCHASE";

export const PRIMITIVE_STATUS: Readonly<Record<IntentPrimitive, "IMPLEMENTED" | "MISSING">> = {
  ROAD_GRID: "IMPLEMENTED",
  ZONE: "IMPLEMENTED",
  UTILITY: "IMPLEMENTED",
  "SITE_REGION:NEAR_EXISTING": "IMPLEMENTED",
  "SITE_REGION:WATERFRONT": "MISSING",
  "SITE_REGION:INFILL": "MISSING",
  "SITE_REGION:EDGE": "MISSING",
  "SITE_REGION:FAR": "MISSING",
  ZONE_DENSITY: "MISSING",
  ROAD_UPGRADE: "MISSING",
  CURVED_ROAD: "MISSING",
  ROUNDABOUT: "MISSING",
  SERVICE_BUILDING: "MISSING",
  DEMOLISH: "MISSING",
  BRIDGE: "MISSING",
  LAND_PURCHASE: "MISSING",
};

export interface IntentPrimitivePlan {
  /** Primitives the intent needs, in execution order. */
  readonly primitives: readonly IntentPrimitive[];
  /** The subset the product does not have yet. Empty means the intent is executable as stated. */
  readonly gaps: readonly IntentPrimitive[];
  readonly executable: boolean;
}

const REGION_PRIMITIVE: Record<string, IntentPrimitive | undefined> = {
  ANY: undefined,
  NEAR_EXISTING: "SITE_REGION:NEAR_EXISTING",
  WATERFRONT: "SITE_REGION:WATERFRONT",
  INFILL: "SITE_REGION:INFILL",
  EDGE: "SITE_REGION:EDGE",
  FAR: "SITE_REGION:FAR",
};

const BASIC_SERVICES = new Set(["ELECTRICITY", "WATER", "SEWAGE"]);
const CIVIC_SERVICES = new Set(["EDUCATION", "HEALTHCARE", "FIRE", "POLICE", "PARK"]);

export const STRUCTURED_INTENT_TYPES: readonly MayorStructuredGoalIntent["type"][] = [
  "GROW_POPULATION", "EXPAND_RESIDENTIAL", "EXPAND_COMMERCIAL", "EXPAND_INDUSTRIAL", "EXPAND_OFFICE",
  "PROVIDE_SERVICE", "IMPROVE_TRAFFIC", "ESTABLISH_ROAD_NETWORK", "REDEVELOP_AREA", "CONNECT_ACROSS_OBSTACLE", "RESOLVE_ISSUES",
];
const ISSUES = new Set(["TRAFFIC", "NOISE", "RUINS", "ACCESS", "CRIME", "FIRE", "HEALTH", "DEATHCARE", "GARBAGE", "FINANCE"]);

/** Whether the intent is inside the vocabulary at all. A false here is a malformed request, not a gap. */
export function isStructuredIntentInVocabulary(intent: MayorStructuredGoalIntent): boolean {
  if (intent.kind !== "GOAL" || !STRUCTURED_INTENT_TYPES.includes(intent.type)) return false;
  if (!["LOW", "NORMAL", "HIGH"].includes(intent.priority)) return false;
  const scope = intent.scope;
  if (scope?.region !== undefined && !(scope.region in REGION_PRIMITIVE)) return false;
  if (scope?.direction !== undefined && !["N", "NE", "E", "SE", "S", "SW", "W", "NW"].includes(scope.direction)) return false;
  if (scope?.density !== undefined && !["LOW", "MEDIUM", "HIGH"].includes(scope.density)) return false;
  if (scope?.roadCharacter !== undefined && !["GRID", "ORGANIC", "ROUNDABOUT"].includes(scope.roadCharacter)) return false;
  const kind = scope?.serviceKind;
  if (kind !== undefined && !BASIC_SERVICES.has(kind) && !CIVIC_SERVICES.has(kind)) return false;
  if (intent.type === "PROVIDE_SERVICE" && kind === undefined) return false;
  if (scope?.issues !== undefined && (intent.type !== "RESOLVE_ISSUES" || !Array.isArray(scope.issues) || !scope.issues.every((issue) => ISSUES.has(issue)))) return false;
  return true;
}

/**
 * Primitives the care round carries out (`care-focus.ts`): traffic at intersections and in-place road replacement, the services that answer
 * icons (police, fire, clinic, cemetery), bulldozing ruins. They exist for a care goal only — the Goal path still lacks them.
 */
export const CARE_PRIMITIVES: ReadonlySet<IntentPrimitive> = new Set<IntentPrimitive>(["ROAD_UPGRADE", "SERVICE_BUILDING", "DEMOLISH"]);

/**
 * Primitives the district builder carries out itself, for an intent that is district work (an EXPAND_/GROW_ intent):
 * where the district goes, at what density, and whether land is bought for it. The Goal path still lacks them, so
 * this set only applies when the caller says the district builder is the one that will execute the intent.
 */
export const DISTRICT_BUILDER_PRIMITIVES: ReadonlySet<IntentPrimitive> = new Set<IntentPrimitive>([
  "SITE_REGION:WATERFRONT", "SITE_REGION:INFILL", "SITE_REGION:EDGE", "SITE_REGION:FAR", "ZONE_DENSITY", "LAND_PURCHASE",
]);

export function planStructuredIntent(intent: MayorStructuredGoalIntent, implementedElsewhere?: ReadonlySet<IntentPrimitive>): IntentPrimitivePlan {
  const scope = intent.scope;
  const primitives: IntentPrimitive[] = [];
  const region = REGION_PRIMITIVE[scope?.region ?? "ANY"];
  if (region) primitives.push(region);
  if (intent.type === "REDEVELOP_AREA") primitives.push("DEMOLISH");
  if (intent.type === "CONNECT_ACROSS_OBSTACLE") primitives.push("BRIDGE");
  if (intent.type === "IMPROVE_TRAFFIC") primitives.push("ROAD_UPGRADE");
  if (intent.type === "RESOLVE_ISSUES") {
    const issues = scope?.issues?.length ? scope.issues : [...ISSUES];
    if (issues.some((issue) => issue === "TRAFFIC" || issue === "NOISE")) primitives.push("ROAD_UPGRADE");
    if (issues.some((issue) => ["CRIME", "FIRE", "HEALTH", "DEATHCARE"].includes(issue))) primitives.push("SERVICE_BUILDING");
    if (issues.includes("RUINS")) primitives.push("DEMOLISH");
  }
  if (intent.type === "ESTABLISH_ROAD_NETWORK" || intent.type === "REDEVELOP_AREA" ||
      intent.type.startsWith("EXPAND_") || intent.type === "GROW_POPULATION") primitives.push("ROAD_GRID");
  if (scope?.roadCharacter === "ORGANIC") primitives.push("CURVED_ROAD");
  if (scope?.roadCharacter === "ROUNDABOUT") primitives.push("ROUNDABOUT");
  if (intent.type.startsWith("EXPAND_") || intent.type === "GROW_POPULATION" || intent.type === "REDEVELOP_AREA") {
    primitives.push("ZONE");
    if (scope?.density !== undefined) primitives.push("ZONE_DENSITY");
  }
  if (intent.type === "PROVIDE_SERVICE" || intent.type.startsWith("EXPAND_") || intent.type === "REDEVELOP_AREA") {
    primitives.push("UTILITY");
  }
  if (scope?.serviceKind !== undefined && CIVIC_SERVICES.has(scope.serviceKind)) primitives.push("SERVICE_BUILDING");
  if (scope?.acquireLand === true) primitives.unshift("LAND_PURCHASE");
  const ordered = [...new Set(primitives)];
  const gaps = ordered.filter((primitive) => PRIMITIVE_STATUS[primitive] === "MISSING" && !implementedElsewhere?.has(primitive));
  return { primitives: ordered, gaps, executable: gaps.length === 0 };
}
