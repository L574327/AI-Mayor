import crypto from "node:crypto";
import type { SpatialEntityRef } from "../spatial/types";
import type { ObservationCoherence, ObservationSourceStatus, V2SourcePayload } from "./foundation";

export const V2_TARGET_ACCESS_SCHEMA_VERSION = "ai-mayor-v2-target-access/1";

export type TargetAccessStatus = "ATTACHED_ONLY" | "DISCONNECTED" | "UNKNOWN" | "UNAVAILABLE";

export interface NativeEntityEvidence {
  entity: SpatialEntityRef;
  exists: boolean;
}

export interface NativeLaneEvidence extends NativeEntityEvidence {
  isLane: boolean;
  isCarLane: boolean;
  isConnectionLane: boolean;
  carLaneFlags: string | null;
  connectionLaneFlags: string | null;
  connectionLaneRoadTypes: string | null;
  fromRoadEdgeSubLane: boolean;
  pathMethods: string | null;
  isRoadPath: boolean;
}

export interface NativeEntranceEvidence extends NativeEntityEvidence {
  type: string;
  roadConnectionType: string | null;
  roadTypes: string | null;
  hasAccessRestriction: boolean;
  hasSpawnLocation: boolean;
  allowEnter: boolean;
  allowExit: boolean;
  connectedLane1: NativeLaneEvidence | null;
  connectedLane2: NativeLaneEvidence | null;
  provenance: "OBSERVED_NATIVE_COMPONENT";
}

export interface TargetAccessObservation {
  schemaVersion: typeof V2_TARGET_ACCESS_SCHEMA_VERSION;
  buildingRef: SpatialEntityRef;
  runtimeEpoch: string;
  observationId: string;
  readStartedAt: string;
  readEndedAt: string;
  simulationFrameStart: number | null;
  simulationFrameEnd: number | null;
  pausedBefore: boolean | null;
  pausedAfter: boolean | null;
  coherence: ObservationCoherence;
  source: {
    status: ObservationSourceStatus;
    reason: string | null;
    readStartedAt: string;
    readEndedAt: string;
    authoritativeBasis: string;
  };
  status: TargetAccessStatus;
  statusProvenance: "DERIVED_WITH_EXPLICIT_RULE" | "UNKNOWN" | "UNAVAILABLE";
  roadAttachment: {
    roadEdge: (NativeEntityEvidence & { isRoadEdge: boolean }) | null;
    curvePosition: number | null;
    provenance: "OBSERVED_NATIVE_COMPONENT";
  } | null;
  entrances: NativeEntranceEvidence[];
  networkEvidence: {
    status: "ENTRANCE_LANE_ATTACHED" | "UNKNOWN";
    qualifyingEntranceCount: number;
    reason: string;
  };
  routeEvidence: {
    status: "UNAVAILABLE";
    nativePathQueryExecuted: false;
    targetAnchor: null;
    reason: string;
  };
  reason: string;
  confidence: "HIGH_FOR_ATTACHMENT_ONLY" | "NONE";
  derivation: {
    rule: string;
    inputs: string[];
    assumptions: string[];
    invalidityConditions: string[];
  } | null;
  nonAuthority: {
    geometricNearbyRoad: "NOT_USED";
    undirectedRoadTopology: "NOT_USED";
  };
}

export interface TargetAccessPorts {
  readonly runtimeEpoch: string;
  observe(input: { buildingRef: SpatialEntityRef; signal?: AbortSignal }): Promise<TargetAccessObservation>;
}

export interface RawTargetAccessPayload {
  roadAttachment?: unknown;
  entrances?: unknown;
  authoritativeNegative?: "DISCONNECTED" | null;
}

type Clock = () => Date;

const objectRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const booleanValue = (value: unknown): boolean => value === true;

function entityRef(value: unknown): SpatialEntityRef | null {
  const candidate = objectRecord(value);
  return Number.isInteger(candidate.index) && Number.isInteger(candidate.version)
    ? { index: candidate.index as number, version: candidate.version as number }
    : null;
}

function stateFacts(value: unknown): { frame: number | null; paused: boolean | null } {
  const root = objectRecord(value);
  const simulation = objectRecord(root.simulation);
  return {
    frame: finiteNumber(simulation.frameIndex ?? root.frameIndex),
    paused:
      typeof simulation.paused === "boolean"
        ? simulation.paused
        : typeof root.paused === "boolean"
          ? root.paused
          : null,
  };
}

function parseLane(value: unknown): NativeLaneEvidence | null {
  const raw = objectRecord(value);
  const entity = entityRef(raw.entity);
  if (!entity) return null;
  return {
    entity,
    exists: booleanValue(raw.exists),
    isLane: booleanValue(raw.isLane),
    isCarLane: booleanValue(raw.isCarLane),
    isConnectionLane: booleanValue(raw.isConnectionLane),
    carLaneFlags: typeof raw.carLaneFlags === "string" ? raw.carLaneFlags : null,
    connectionLaneFlags: typeof raw.connectionLaneFlags === "string" ? raw.connectionLaneFlags : null,
    connectionLaneRoadTypes: typeof raw.connectionLaneRoadTypes === "string" ? raw.connectionLaneRoadTypes : null,
    fromRoadEdgeSubLane: booleanValue(raw.fromRoadEdgeSubLane),
    pathMethods: typeof raw.pathMethods === "string" ? raw.pathMethods : null,
    isRoadPath: booleanValue(raw.isRoadPath),
  };
}

function parseEntrance(value: unknown): NativeEntranceEvidence | null {
  const raw = objectRecord(value);
  const entity = entityRef(raw.entity);
  if (!entity) return null;
  return {
    entity,
    exists: booleanValue(raw.exists),
    type: typeof raw.type === "string" ? raw.type : "Unknown",
    roadConnectionType: typeof raw.roadConnectionType === "string" ? raw.roadConnectionType : null,
    roadTypes: typeof raw.roadTypes === "string" ? raw.roadTypes : null,
    hasAccessRestriction: booleanValue(raw.hasAccessRestriction),
    hasSpawnLocation: booleanValue(raw.hasSpawnLocation),
    allowEnter: booleanValue(raw.allowEnter),
    allowExit: booleanValue(raw.allowExit),
    connectedLane1: parseLane(raw.connectedLane1),
    connectedLane2: parseLane(raw.connectedLane2),
    provenance: "OBSERVED_NATIVE_COMPONENT",
  };
}

export function projectTargetAccess(
  buildingRef: SpatialEntityRef,
  payload: RawTargetAccessPayload,
): Pick<
  TargetAccessObservation,
  | "buildingRef"
  | "status"
  | "statusProvenance"
  | "roadAttachment"
  | "entrances"
  | "networkEvidence"
  | "routeEvidence"
  | "reason"
  | "confidence"
  | "derivation"
  | "nonAuthority"
> {
  const rawRoad = objectRecord(payload.roadAttachment);
  const roadEntity = entityRef(rawRoad.roadEdge);
  const roadAttachment = roadEntity
    ? {
        roadEdge: {
          entity: roadEntity,
          exists: booleanValue(rawRoad.roadExists),
          isRoadEdge: booleanValue(rawRoad.roadIsEdge),
        },
        curvePosition: finiteNumber(rawRoad.curvePosition),
        provenance: "OBSERVED_NATIVE_COMPONENT" as const,
      }
    : null;
  const entrances = (Array.isArray(payload.entrances) ? payload.entrances : [])
    .map(parseEntrance)
    .filter((entry): entry is NativeEntranceEvidence => entry !== null);
  const qualifyingEntrances = entrances.filter((entrance) => {
    if (!entrance.exists || !entrance.hasSpawnLocation || entrance.type !== "SpawnLocation") return false;
    if (entrance.roadConnectionType !== "Road") return false;
    if (entrance.hasAccessRestriction && !entrance.allowEnter && !entrance.allowExit) return false;
    return [entrance.connectedLane1, entrance.connectedLane2].some(
      (lane) =>
        lane !== null &&
        lane.exists &&
        lane.isLane &&
        lane.fromRoadEdgeSubLane &&
        lane.isRoadPath &&
        (lane.isCarLane || lane.isConnectionLane),
    );
  });
  const explicitlyDisconnected = payload.authoritativeNegative === "DISCONNECTED";
  const attached =
    roadAttachment?.roadEdge?.exists === true &&
    roadAttachment.roadEdge.isRoadEdge &&
    qualifyingEntrances.length > 0;
  const routeReason =
    "No native building-to-anchor path query or completed PathfindResult was observed; lane attachment is not route reachability.";
  return {
    buildingRef,
    status: attached ? "ATTACHED_ONLY" : explicitlyDisconnected ? "DISCONNECTED" : "UNKNOWN",
    statusProvenance: attached || explicitlyDisconnected ? "DERIVED_WITH_EXPLICIT_RULE" : "UNKNOWN",
    roadAttachment,
    entrances,
    networkEvidence: {
      status: qualifyingEntrances.length > 0 ? "ENTRANCE_LANE_ATTACHED" : "UNKNOWN",
      qualifyingEntranceCount: qualifyingEntrances.length,
      reason:
        qualifyingEntrances.length > 0
          ? "At least one native building spawn location allows entry/exit and references an existing CarLane."
          : "No authoritative enter/exit spawn-location-to-CarLane relation was observed.",
    },
    routeEvidence: {
      status: "UNAVAILABLE",
      nativePathQueryExecuted: false,
      targetAnchor: null,
      reason: routeReason,
    },
    reason: attached
      ? `Native road-edge attachment and ${qualifyingEntrances.length} native-selected road entrance lane attachment(s) observed; routability remains unproved.`
      : explicitlyDisconnected
        ? "Native source explicitly reported that the building has no attachment."
        : "Authoritative road-edge plus native-selected road entrance lane attachment was not established.",
    confidence: attached ? "HIGH_FOR_ATTACHMENT_ONLY" : "NONE",
    derivation: attached
      ? {
          rule:
            "ATTACHED_ONLY iff Building.m_RoadEdge references an existing Game.Net.Edge and at least one road SpawnLocation resolves through that edge's authoritative SubLane relation to an existing road-path Lane carrying CarLane or ConnectionLane; access flags gate only an actual restriction.",
          inputs: [
            "Game.Buildings.Building.m_RoadEdge",
            "Game.Buildings.SpawnLocationElement",
            "Game.Objects.SpawnLocation.m_ConnectedLane1/m_ConnectedLane2",
            "Game.Objects.SpawnLocation.m_AccessRestriction",
            "Game.Net.SubLane.m_SubLane/m_PathMethods",
            "Game.Net.Lane and Game.Net.CarLane/Game.Net.ConnectionLane component presence",
          ],
          assumptions: ["The captured ECS entity/version references remain live for this bounded observation."],
          invalidityConditions: [
            "building, road-edge, spawn-location, or lane entity is replaced or deleted",
            "observation frame drifts",
            "game component semantics change",
            "a route anchor or traversal claim is requested",
          ],
        }
      : explicitlyDisconnected
        ? {
            rule: "DISCONNECTED only when the source supplies an explicit authoritative negative attachment result.",
            inputs: ["authoritativeNegative"],
            assumptions: [],
            invalidityConditions: ["the negative source is inferred from missing data rather than explicitly reported"],
          }
        : null,
    nonAuthority: {
      geometricNearbyRoad: "NOT_USED",
      undirectedRoadTopology: "NOT_USED",
    },
  };
}

export function createTargetAccessPorts(options: {
  runtimeEpoch: string;
  readGameState(signal?: AbortSignal): Promise<V2SourcePayload>;
  readTarget(buildingRef: SpatialEntityRef, signal?: AbortSignal): Promise<V2SourcePayload<RawTargetAccessPayload>>;
  now?: Clock;
  createId?: () => string;
}): TargetAccessPorts {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    runtimeEpoch: options.runtimeEpoch,
    async observe({ buildingRef, signal }) {
      const started = now();
      let before: V2SourcePayload = { status: "UNAVAILABLE", reason: "state read not attempted" };
      let target: V2SourcePayload<RawTargetAccessPayload> = {
        status: "UNAVAILABLE",
        reason: "target read not attempted",
      };
      let after: V2SourcePayload = { status: "UNAVAILABLE", reason: "state read not attempted" };
      const sourceStarted = now();
      try {
        before = await options.readGameState(signal);
        target = await options.readTarget(buildingRef, signal);
        after = await options.readGameState(signal);
      } catch (error) {
        target = { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : String(error) };
        try {
          after = await options.readGameState(signal);
        } catch {
          // Preserve unavailable state evidence.
        }
      }
      const sourceEnded = now();
      const beforeFacts = stateFacts(before.data);
      const afterFacts = stateFacts(after.data);
      const allAvailable = before.status !== "UNAVAILABLE" && target.status !== "UNAVAILABLE" && after.status !== "UNAVAILABLE";
      const coherence: ObservationCoherence =
        beforeFacts.frame === null || afterFacts.frame === null || !allAvailable
          ? "UNKNOWN"
          : beforeFacts.frame === afterFacts.frame
            ? "STABLE_FRAME"
            : "BOUNDED_DRIFT";
      const projected = projectTargetAccess(buildingRef, target.data ?? {});
      const sourceUnavailable = target.status === "UNAVAILABLE";
      const unstableEvidence = !sourceUnavailable && coherence !== "STABLE_FRAME";
      const ended = now();
      return {
        schemaVersion: V2_TARGET_ACCESS_SCHEMA_VERSION,
        ...projected,
        ...(sourceUnavailable
          ? {
              status: "UNAVAILABLE" as const,
              statusProvenance: "UNAVAILABLE" as const,
              reason: target.reason ?? "target access source unavailable",
              confidence: "NONE" as const,
              derivation: null,
            }
          : unstableEvidence
            ? {
                status: "UNKNOWN" as const,
                statusProvenance: "UNKNOWN" as const,
                reason: "Target attachment facts were not captured inside a stable simulation frame.",
                confidence: "NONE" as const,
                derivation: null,
              }
          : {}),
        runtimeEpoch: options.runtimeEpoch,
        observationId: createId(),
        readStartedAt: started.toISOString(),
        readEndedAt: ended.toISOString(),
        simulationFrameStart: beforeFacts.frame,
        simulationFrameEnd: afterFacts.frame,
        pausedBefore: beforeFacts.paused,
        pausedAfter: afterFacts.paused,
        coherence,
        source: {
          status: target.status,
          reason: target.reason ?? null,
          readStartedAt: sourceStarted.toISOString(),
          readEndedAt: sourceEnded.toISOString(),
          authoritativeBasis: sourceUnavailable
            ? "UNAVAILABLE"
            : "Building.m_RoadEdge+SpawnLocationElement+SpawnLocation connected lanes+Lane/CarLane component presence",
        },
      };
    },
  };
}
