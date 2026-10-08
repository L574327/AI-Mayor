import type { SpatialEntityRef } from "../spatial/types";

export const V2_ROUTE_QUERY_SCHEMA_VERSION = "ai-mayor-v2-native-route-query/1";
export type NativeRouteQueryState =
  | "CREATED" | "ACCEPTED" | "PENDING" | "ROUTABLE" | "UNROUTABLE"
  | "QUERY_ERROR" | "STALE" | "EXPIRED";
export type RouteQueryLifecycle =
  | "NEW" | "SUBMITTED" | "WAITING_FOR_ROUTE_RESULT" | "ROUTABLE"
  | "NOT_ROUTABLE" | "FAILED" | "STALE";

export interface RouteQueryRequest {
  queryId?: string;
  buildingRef: SpatialEntityRef;
  targetAnchor: { lane: SpatialEntityRef; delta: number };
  signal?: AbortSignal;
}

export interface RouteQueryResult {
  schemaVersion: typeof V2_ROUTE_QUERY_SCHEMA_VERSION;
  queryId: string;
  runtimeEpoch: string;
  state: NativeRouteQueryState;
  lifecycle: RouteQueryLifecycle;
  duplicate: boolean;
  nativeSubmitted: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  error: string | null;
  evidence: {
    pathOwnerFlags: string;
    pathElementCount: number;
    pathInformation: {
      origin: SpatialEntityRef | null;
      destination: SpatialEntityRef | null;
      distance: number | null;
      duration: number | null;
      cost: number | null;
      actualMethods: string | null;
      state: string | null;
    } | null;
    resolvedSource: { building: SpatialEntityRef; lane: SpatialEntityRef; delta: number } | null;
    resolvedTarget: { lane: SpatialEntityRef; delta: number; pathMethod: "Road"; roadType: "Car" } | null;
  } | null;
}

export interface TargetRouteQueryPorts {
  readonly runtimeEpoch: string;
  submit(request: RouteQueryRequest & { queryId: string }): Promise<RouteQueryResult>;
  status(queryId: string, signal?: AbortSignal): Promise<RouteQueryResult>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const entity = (value: unknown): SpatialEntityRef | null => {
  const item = record(value);
  return Number.isInteger(item.index) && Number.isInteger(item.version)
    ? { index: item.index as number, version: item.version as number } : null;
};
const nullableNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const lifecycleFor = (state: NativeRouteQueryState): RouteQueryLifecycle => {
  if (state === "ROUTABLE") return "ROUTABLE";
  if (state === "UNROUTABLE") return "NOT_ROUTABLE";
  if (state === "ACCEPTED" || state === "PENDING" || state === "CREATED") return "WAITING_FOR_ROUTE_RESULT";
  if (state === "STALE") return "STALE";
  return "FAILED";
};

export function normalizeRouteQuery(value: unknown, runtimeEpoch: string, duplicate = false): RouteQueryResult {
  const raw = record(value);
  const evidence = record(raw.evidence);
  const info = record(evidence.pathInformation);
  const source = record(evidence.resolvedSource);
  const target = record(evidence.resolvedTarget);
  const state = typeof raw.state === "string" ? raw.state as NativeRouteQueryState : "QUERY_ERROR";
  const allowed: NativeRouteQueryState[] = ["CREATED", "ACCEPTED", "PENDING", "ROUTABLE", "UNROUTABLE", "QUERY_ERROR", "STALE", "EXPIRED"];
  return {
    schemaVersion: V2_ROUTE_QUERY_SCHEMA_VERSION,
    queryId: typeof raw.queryId === "string" ? raw.queryId : "",
    runtimeEpoch: typeof raw.runtimeEpoch === "string" ? raw.runtimeEpoch : runtimeEpoch,
    state: allowed.includes(state) ? state : "QUERY_ERROR",
    lifecycle: lifecycleFor(allowed.includes(state) ? state : "QUERY_ERROR"),
    duplicate: raw.duplicate === true || duplicate,
    nativeSubmitted: raw.nativeSubmitted === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    error: typeof raw.error === "string" ? raw.error : null,
    evidence: Object.keys(evidence).length === 0 ? null : {
      pathOwnerFlags: typeof evidence.pathOwnerFlags === "string" ? evidence.pathOwnerFlags : "",
      pathElementCount: typeof evidence.pathElementCount === "number" ? evidence.pathElementCount : 0,
      pathInformation: Object.keys(info).length === 0 ? null : {
        origin: entity(info.origin), destination: entity(info.destination),
        distance: nullableNumber(info.distance), duration: nullableNumber(info.duration), cost: nullableNumber(info.cost),
        actualMethods: typeof info.actualMethods === "string" ? info.actualMethods : null,
        state: typeof info.state === "string" ? info.state : null,
      },
      resolvedSource: entity(source.building) && entity(source.lane) && typeof source.delta === "number"
        ? { building: entity(source.building)!, lane: entity(source.lane)!, delta: source.delta as number } : null,
      resolvedTarget: entity(target.lane) && typeof target.delta === "number"
        ? { lane: entity(target.lane)!, delta: target.delta as number, pathMethod: "Road", roadType: "Car" } : null,
    },
  };
}

export function createTargetRouteQueryPorts(options: {
  runtimeEpoch: string;
  submit: (request: RouteQueryRequest & { queryId: string }) => Promise<unknown>;
  status: (queryId: string, signal?: AbortSignal) => Promise<unknown>;
  createId?: () => string;
  /** Probe native state before submit when reconstructing ports after reload. */
  resume?: boolean;
}): TargetRouteQueryPorts {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const submitted = new Map<string, RouteQueryResult>();
  const terminal = (result: RouteQueryResult) => ["ROUTABLE", "UNROUTABLE", "QUERY_ERROR", "STALE", "EXPIRED"].includes(result.state);
  const stale = (result: RouteQueryResult, queryId: string): RouteQueryResult => ({
    ...result,
    queryId,
    runtimeEpoch: options.runtimeEpoch,
    state: "STALE",
    lifecycle: "STALE",
    duplicate: true,
    nativeSubmitted: false,
    error: result.error ?? "route query belongs to a different runtime epoch",
  });
  const readStatus = async (queryId: string, signal?: AbortSignal) => {
    const result = normalizeRouteQuery(await options.status(queryId, signal), options.runtimeEpoch);
    if (result.queryId && result.queryId !== queryId) {
      return stale(result, queryId);
    }
    if (result.runtimeEpoch !== options.runtimeEpoch) return stale(result, queryId);
    return result;
  };
  return {
    runtimeEpoch: options.runtimeEpoch,
    async submit(request) {
      const queryId = request.queryId ?? createId();
      const prior = submitted.get(queryId);
      if (prior) {
        if (prior.runtimeEpoch !== options.runtimeEpoch) return stale(prior, queryId);
        if (terminal(prior)) return { ...prior, duplicate: true };
        const refreshed = await readStatus(queryId, request.signal);
        submitted.set(queryId, refreshed);
        return { ...refreshed, duplicate: true };
      }
      if (options.resume) {
        // A durable/native query may have survived a process reload. Probe its
        // status before submitting so reload reconciliation cannot duplicate the
        // world-side query. A missing native query is the only case that submits.
        try {
          const existing = await readStatus(queryId, request.signal);
          submitted.set(queryId, existing);
          return existing;
        } catch {
          // Native has no query with this identity; submit exactly once.
        }
      }
      const result = normalizeRouteQuery(await options.submit({ ...request, queryId }), options.runtimeEpoch);
      submitted.set(queryId, result);
      return result;
    },
    async status(queryId, signal) {
      const prior = submitted.get(queryId);
      if (prior && terminal(prior)) return { ...prior, duplicate: true };
      const result = await readStatus(queryId, signal);
      submitted.set(queryId, result);
      return result;
    },
  };
}
