import type { MayorAction } from "../types";
import type { SpatialEntityRef } from "../spatial/types";
import type { ImmutableElectricityTargetSemantics } from "./utility-target-binding";
import { matchCablePrimitiveEffect } from "./utility-topology-matchers";

export type WorldDomain = "ROAD" | "BUILDING" | "UTILITY" | "ZONING";

export interface WorldStateIdentity {
  worldId: string;
  checkpointId: string | null;
  generation: string;
}

export interface DomainWorldObservation<T = unknown> {
  identity: WorldStateIdentity;
  observedAt: string;
  complete: boolean;
  value: T;
}

interface DomainEntry {
  revision: number;
  dirty: boolean;
  fingerprint: string | null;
  observation: DomainWorldObservation | null;
}

const fingerprint = (value: unknown): string => {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, visit(child)]));
  };
  return JSON.stringify(visit(value));
};

/** In-memory copy of the latest authoritative observations; never grants mutation authority. */
export class DomainWorldStateCache {
  private identity: WorldStateIdentity | null = null;
  private readonly domains = new Map<WorldDomain, DomainEntry>(
    (["ROAD", "BUILDING", "UTILITY", "ZONING"] as const).map((domain) =>
      [domain, { revision: 0, dirty: true, fingerprint: null, observation: null }]),
  );

  private align(identity: WorldStateIdentity): void {
    if (!this.identity || fingerprint(this.identity) === fingerprint(identity)) {
      this.identity = structuredClone(identity);
      return;
    }
    this.identity = structuredClone(identity);
    for (const entry of this.domains.values()) {
      entry.revision += 1;
      entry.dirty = true;
      entry.fingerprint = null;
      entry.observation = null;
    }
  }

  markDirty(domain: WorldDomain): void {
    const entry = this.domains.get(domain)!;
    entry.dirty = true;
  }

  markUtilityDirty(): void { this.markDirty("UTILITY"); }

  refresh<T>(domain: WorldDomain, observation: DomainWorldObservation<T>): number {
    this.align(observation.identity);
    const entry = this.domains.get(domain)!;
    const nextFingerprint = fingerprint(observation.value);
    if (entry.fingerprint !== null && entry.fingerprint !== nextFingerprint) entry.revision += 1;
    if (entry.fingerprint === null && entry.revision === 0) entry.revision = 1;
    entry.fingerprint = nextFingerprint;
    entry.observation = structuredClone(observation);
    entry.dirty = !observation.complete;
    return entry.revision;
  }

  revision(domain: WorldDomain): number { return this.domains.get(domain)!.revision; }
  isDirty(domain: WorldDomain): boolean { return this.domains.get(domain)!.dirty; }
  get<T = unknown>(domain: WorldDomain): DomainWorldObservation<T> | null {
    const observation = this.domains.get(domain)!.observation;
    return observation ? structuredClone(observation) as DomainWorldObservation<T> : null;
  }
  identityMatches(identity: WorldStateIdentity): boolean {
    return !!this.identity && fingerprint(this.identity) === fingerprint(identity);
  }
}

export interface UtilityWorldState {
  identity: WorldStateIdentity;
  readbackComplete: boolean;
  facility: { entity: SpatialEntityRef; prefab: string; position: { x: number; z: number } } | null;
  connector: { entity: SpatialEntityRef; attached: boolean | null; orphan: boolean | null } | null;
  targetResolutionComplete: boolean;
  resolvedEndpoint: {
    road: SpatialEntityRef;
    node: SpatialEntityRef;
    flowNode: SpatialEntityRef | null;
    prefab: string;
    role: "start" | "end";
    position: { x: number; y: number; z: number };
  } | null;
  topology: Record<string, unknown> | null;
}

export type UtilityEffectVerdict = "OBSERVED_MATCH" | "OBSERVED_ABSENT" | "UNKNOWN";

export function matchUtilityConnectionEffect(input: {
  action: Extract<MayorAction, { type: "build_road" }>;
  expectedConnector: SpatialEntityRef;
  semantic: ImmutableElectricityTargetSemantics;
  world: UtilityWorldState;
}): { verdict: UtilityEffectVerdict; reason: string } {
  const { world, semantic, action } = input;
  if (!world.readbackComplete || !world.facility || !world.connector || !world.identity.worldId || !world.identity.generation) {
    return { verdict: "UNKNOWN", reason: "utility authoritative readback is incomplete" };
  }
  if (world.connector.entity.index !== input.expectedConnector.index || world.connector.entity.version !== input.expectedConnector.version) {
    return { verdict: "UNKNOWN", reason: "current utility connector identity differs from the admitted source" };
  }
  if (!world.targetResolutionComplete) return { verdict: "UNKNOWN", reason: "utility target endpoint lookup is incomplete" };
  const endpoint = world.resolvedEndpoint;
  // The admitted target is rebound through the current road/entity and endpoint
  // role. Utility topology nodes can sit away from the geometric road contact;
  // coordinates are useful to discover/rebind the road, but they are not the
  // identity of its utility flow node.
  const endpointMatches = !!endpoint && endpoint.prefab === semantic.targetRoad.prefab &&
    endpoint.role === semantic.targetRoad.endpointRole && Number.isInteger(endpoint.road.index) &&
    Number.isInteger(endpoint.road.version) && Number.isInteger(endpoint.node.index) &&
    Number.isInteger(endpoint.node.version);
  if (!endpointMatches || !endpoint) {
    return { verdict: "OBSERVED_ABSENT", reason: "complete current road readback proves the admitted target endpoint is absent" };
  }
  if (!world.topology) return { verdict: "UNKNOWN", reason: "utility connector/target topology readback is unavailable" };
  const topology = world.topology;
  const binding = typeof topology.binding === "object" && topology.binding !== null
    ? topology.binding as Record<string, unknown> : {};
  const targetNetwork = typeof topology.targetNetwork === "object" && topology.targetNetwork !== null
    ? topology.targetNetwork as Record<string, unknown> : {};
  if (binding.bindingStatus !== "VALID" || binding.complete !== true || binding.truncated === true ||
    targetNetwork.complete !== true || targetNetwork.truncated === true) {
    return { verdict: "UNKNOWN", reason: "utility topology is not complete and bound to the current target" };
  }
  const primitive = matchCablePrimitiveEffect({ topology, action, connector: input.expectedConnector });
  if (primitive.decision === "UNKNOWN") return { verdict: "UNKNOWN", reason: primitive.reason };
  // This matcher answers whether this exact physical cable action exists. Flow
  // reachability is a separate network objective that construction may still
  // need to achieve after this edge is observed.
  if (primitive.decision === "OBSERVED_MATCH") {
    return { verdict: "OBSERVED_MATCH", reason: "authoritative topology contains the admitted physical cable effect" };
  }
  if (primitive.decision === "PROVEN_MISMATCH") {
    return { verdict: "OBSERVED_ABSENT", reason: "complete authoritative topology proves the admitted connector-to-target effect is absent" };
  }
  return { verdict: "UNKNOWN", reason: "authoritative topology does not resolve target reachability" };
}

/** Recompute derived planning data only when its source revision is stale. */
export async function recomputeOnUtilityRevision<T>(input: {
  currentRevision: number;
  basedOnRevision: number | undefined;
  value: T | null | undefined;
  recompute: () => Promise<T>;
}): Promise<{ value: T; basedOnRevision: number; recomputed: boolean }> {
  if (input.value !== null && input.value !== undefined && input.basedOnRevision === input.currentRevision) {
    return { value: input.value, basedOnRevision: input.currentRevision, recomputed: false };
  }
  return { value: await input.recompute(), basedOnRevision: input.currentRevision, recomputed: true };
}
