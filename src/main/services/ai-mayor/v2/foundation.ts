import { Mutex } from "@/main/internal/mutex";
import type { SpatialEntityRef, SpatialPoint2, SpatialSiteDetail, SpatialZoningCell } from "../spatial/types";

export const V2_OBSERVATION_SCHEMA_VERSION = "ai-mayor-v2-observation/1";
export const V2_COMMAND_SCHEMA_VERSION = "ai-mayor-v2-command/1";
export const V2_OBSERVATION_MIN_RADIUS = 64;
export const V2_OBSERVATION_MIN_RESOLUTION = 16;
const EXACT_ZONING_RADIUS_EPSILON_METERS = 1e-3;
export const NATIVE_ZONING_MIN_RADIUS_METERS = 8;

export type ObservationSourceStatus = "AVAILABLE" | "UNAVAILABLE" | "PARTIAL";
export type ObservationCoherence = "STABLE_FRAME" | "BOUNDED_DRIFT" | "UNKNOWN";

export interface V2SourcePayload<T = unknown> {
  status: ObservationSourceStatus;
  data?: T;
  reason?: string;
}

export interface V2ObservationSource<T = unknown> extends V2SourcePayload<T> {
  readStartedAt: string;
  readEndedAt: string;
  simulationFrameStart: number | null;
  simulationFrameEnd: number | null;
  freshness: {
    basis: "WALL_CLOCK_CAPTURE_WINDOW";
    ageAtEnvelopeEndMs: number;
  };
}

export interface V2ObservationEnvelope {
  schemaVersion: typeof V2_OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  runtimeEpoch: string;
  worldEpoch: {
    kind: "RUNTIME_SESSION";
    value: string;
    durableAcrossSaveLoad: false;
  };
  readStartedAt: string;
  readEndedAt: string;
  simulationFrameStart: number | null;
  simulationFrameEnd: number | null;
  gameTimeStart: string | null;
  gameTimeEnd: string | null;
  pausedBefore: boolean | null;
  pausedAfter: boolean | null;
  coherence: ObservationCoherence;
  sourceFreshness: {
    basis: "WALL_CLOCK_CAPTURE_WINDOW";
    maximumAgeMs: number;
    allRequiredSourcesAvailable: boolean;
  };
  revision: {
    authoritativeWorldRevision: null;
    syntheticCacheRevision?: {
      value: string;
      authority: "SYNTHETIC_CACHE_ONLY";
    };
  };
  sources: {
    gameStateBefore: V2ObservationSource;
    snapshot: V2ObservationSource;
    spatialScan: V2ObservationSource;
    spatialDetail: V2ObservationSource<SpatialSiteDetail>;
    gameStateAfter: V2ObservationSource;
    /**
     * The net-edge listing, present only when a capture was asked for it.
     *
     * Deliberately outside the required set: the five road/zoning sources above
     * decide coherence exactly as before, and a net listing that could not be
     * read must not turn a road observation incoherent. A matcher that needs it
     * fails closed on its own when it is missing.
     */
    netEdges?: V2ObservationSource;
  };
}

export interface V2SpatialDetailRequest extends SpatialPoint2 {
  radius: number;
  resolution?: number;
}

export interface V2ObservationReaders {
  readGameState(signal?: AbortSignal): Promise<V2SourcePayload>;
  readSnapshot(signal?: AbortSignal): Promise<V2SourcePayload>;
  readSpatialScan(signal?: AbortSignal): Promise<V2SourcePayload>;
  readSpatialDetail(request: V2SpatialDetailRequest, signal?: AbortSignal): Promise<V2SourcePayload<SpatialSiteDetail>>;
  /**
   * Concrete placed network edges of the named prefabs, read from the listing
   * that DOES contain them.
   *
   * The bootstrap scan is a road-graph view: it is built by requiring the
   * prefab to carry `RoadData`, so water pipes, sewage pipes and cables are
   * absent from it by construction (measured 2026-10-02: 429 scanned edges, all
   * road prefabs, zero pipes, while the world held 11 `Small Sewage Pipe` and a
   * `Low-voltage Ground Cable`). A net course therefore cannot be certified
   * against the scan at all, and asking there returns a proven absence for a
   * pipe that is physically in the world -- the direction the ROAD matcher is
   * forbidden to get wrong. This reader is the other view.
   *
   * Optional so every existing reader set stays valid: a capture that is not
   * asked for net edges never calls it.
   */
  readNetEdges?(prefabs: readonly string[], signal?: AbortSignal): Promise<V2SourcePayload>;
}

export interface V2ObservationPorts {
  readonly runtimeEpoch: string;
  capture(request: {
    spatialDetail: V2SpatialDetailRequest;
    syntheticCacheRevision?: string;
    signal?: AbortSignal;
    /**
     * Net prefabs whose placed edges must be captured alongside the road graph.
     *
     * Only a matcher that cannot answer from the road graph asks for these, so
     * the ordinary ROAD path pays nothing: a capture with no request here has no
     * `netEdges` source and its coherence is decided by exactly the same five
     * sources as before.
     */
    netEdgePrefabs?: readonly string[];
    /**
     * The global sources this caller will actually READ.
     *
     * `capture()` answers "what is the world", and charges for all of it: two
     * frame reads, a city snapshot, and the whole road-graph scan. A caller that
     * only ever looks at `sources.spatialDetail` — a per-anchor site search
     * walking two dozen anchors, a reservation recheck walking candidate points
     * — reads none of the rest and discards it, but paid for it anyway.
     *
     * Measured live 2026-10-02, one blocked construction tick: 162 full captures
     * and 0 mutations, of which `cs2_spatial#scan` (132 ms) and
     * `cs2_mayor_snapshot` (48 ms) were 162 calls each, all of them dropped by
     * the caller. Across three ticks the scan alone was 45.5 s of a 133.8 s
     * native budget.
     *
     * Naming a source here means the caller WILL read it and it decides
     * coherence exactly as before. Omitting one means the caller asked no
     * question of it: it is not read, it is reported `UNAVAILABLE` with reason
     * `NOT_REQUESTED`, and it does not decide coherence — a source nobody reads
     * cannot make an observation incoherent. The frame reads either side and the
     * detail read are never optional, so `coherence` still answers the same
     * question about the read that was actually made.
     *
     * Absent means every source, which is every pre-existing call site.
     */
    globalSources?: readonly V2GlobalObservationSource[];
  }): Promise<V2ObservationEnvelope>;
}

/** The capture's non-detail global sources: the ones a caller can decline. */
export type V2GlobalObservationSource = "snapshot" | "spatialScan";

/** The one reason this module uses for a source a capture was not asked to read. */
export const OBSERVATION_SOURCE_NOT_REQUESTED = "NOT_REQUESTED";

export function observationRequestForZoning(intent: Pick<ZoningIntent, "spatialEnvelope">): V2SpatialDetailRequest {
  return {
    x: intent.spatialEnvelope.center.x,
    z: intent.spatialEnvelope.center.z,
    // Bridge reads zoning cells inside a circle, while native Apply selects
    // cell centers inside a square marquee. Read the square's full diagonal.
    radius: Math.max(V2_OBSERVATION_MIN_RADIUS, intent.spatialEnvelope.radius * Math.SQRT2),
    resolution: Math.max(V2_OBSERVATION_MIN_RESOLUTION, intent.spatialEnvelope.resolution ?? 0),
  };
}

export const availableSource = <T>(data: T): V2SourcePayload<T> => ({ status: "AVAILABLE", data });
export const partialSource = <T>(data: T, reason: string): V2SourcePayload<T> => ({
  status: "PARTIAL",
  data,
  reason,
});

/**
 * Derives the smallest half-width of the native axis-aligned marquee that
 * contains the planned cells. Bridge clamps smaller requests to 8m, so the
 * returned value is also the exact radius it will submit.
 */
export function deriveExactZoningActionRadius(center: SpatialPoint2, cells: Pick<SpatialZoningCell, "position">[]): number {
  if (cells.length === 0) return 0;
  const halfWidth = Math.max(...cells.map((cell) =>
    Math.max(Math.abs(cell.position.x - center.x), Math.abs(cell.position.z - center.z)),
  ));
  return Math.max(NATIVE_ZONING_MIN_RADIUS_METERS, halfWidth + EXACT_ZONING_RADIUS_EPSILON_METERS);
}

/** The exact visible-cell selector used by Bridge's native Zone marquee. */
export function nativeZoningMarqueeFootprint(
  detail: SpatialSiteDetail,
  center: SpatialPoint2,
  radius: number,
): SpatialZoningCell[] {
  return detail.zoningCells.filter((cell) =>
    cell.visible &&
    Math.abs(cell.position.x - center.x) <= radius &&
    Math.abs(cell.position.z - center.z) <= radius,
  );
}

type Clock = () => Date;

const objectRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function stateFacts(value: unknown): { frame: number | null; paused: boolean | null; gameTime: string | null } {
  const root = objectRecord(value);
  const simulation = objectRecord(root.simulation);
  const game = objectRecord(root.game);
  const frame = finiteNumber(simulation.frameIndex ?? root.frameIndex);
  const pausedValue = simulation.paused ?? root.paused;
  const gameTimeValue = root.gameDateTime ?? root.gameTime ?? game.gameDateTime ?? game.time;
  return {
    frame,
    paused: typeof pausedValue === "boolean" ? pausedValue : null,
    gameTime: typeof gameTimeValue === "string" && gameTimeValue.length > 0 ? gameTimeValue : null,
  };
}

async function timedRead<T>(reader: () => Promise<V2SourcePayload<T>>, now: Clock): Promise<V2ObservationSource<T>> {
  const started = now();
  try {
    const result = await reader();
    const ended = now();
    return {
      ...result,
      readStartedAt: started.toISOString(),
      readEndedAt: ended.toISOString(),
      simulationFrameStart: null,
      simulationFrameEnd: null,
      freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", ageAtEnvelopeEndMs: 0 },
    };
  } catch (error) {
    const ended = now();
    return {
      status: "UNAVAILABLE",
      reason: error instanceof Error ? error.message : String(error),
      readStartedAt: started.toISOString(),
      readEndedAt: ended.toISOString(),
      simulationFrameStart: null,
      simulationFrameEnd: null,
      freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", ageAtEnvelopeEndMs: 0 },
    };
  }
}

export function createV2ObservationPorts(options: {
  readers: V2ObservationReaders;
  runtimeEpoch?: string;
  now?: Clock;
  createId?: () => string;
}): V2ObservationPorts {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const runtimeEpoch = options.runtimeEpoch ?? `runtime:${createId()}`;

  return {
    runtimeEpoch,
    async capture(request) {
      const readStarted = now();
      // A source the caller named is read; everything else the capture would
      // have read anyway is skipped. Absent = all of them, so a caller that
      // never heard of this option gets yesterday's capture exactly.
      const wantedGlobal = (name: V2GlobalObservationSource) =>
        request.globalSources === undefined || request.globalSources.includes(name);
      const notRequested = (): V2ObservationSource => {
        const at = now().toISOString();
        return {
          status: "UNAVAILABLE",
          reason: OBSERVATION_SOURCE_NOT_REQUESTED,
          readStartedAt: at,
          readEndedAt: at,
          simulationFrameStart: null,
          simulationFrameEnd: null,
          freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", ageAtEnvelopeEndMs: 0 },
        };
      };
      const gameStateBefore = await timedRead(() => options.readers.readGameState(request.signal), now);
      const beforeFacts = stateFacts(gameStateBefore.data);
      const netEdgePrefabs = (request.netEdgePrefabs ?? []).filter(
        (prefab): prefab is string => typeof prefab === "string" && prefab.length > 0,
      );
      const netEdgesRead =
        netEdgePrefabs.length > 0 && options.readers.readNetEdges
          ? timedRead(() => options.readers.readNetEdges!(netEdgePrefabs, request.signal), now)
          : null;
      const wantSnapshot = wantedGlobal("snapshot");
      const wantScan = wantedGlobal("spatialScan");
      const [snapshot, spatialScan, spatialDetail, netEdges] = await Promise.all([
        wantSnapshot ? timedRead(() => options.readers.readSnapshot(request.signal), now) : notRequested(),
        wantScan ? timedRead(() => options.readers.readSpatialScan(request.signal), now) : notRequested(),
        timedRead(() => options.readers.readSpatialDetail(request.spatialDetail, request.signal), now),
        netEdgesRead,
      ]);
      const gameStateAfter = await timedRead(() => options.readers.readGameState(request.signal), now);
      const afterFacts = stateFacts(gameStateAfter.data);
      const readEnded = now();
      // Only the sources that were actually asked for decide coherence. The
      // frame reads and the detail are unconditional, so this is never empty.
      const required: V2ObservationSource[] = [gameStateBefore];
      if (wantSnapshot) required.push(snapshot);
      if (wantScan) required.push(spatialScan);
      required.push(spatialDetail, gameStateAfter);
      const allRequiredSourcesAvailable = required.every((source) => source.status !== "UNAVAILABLE");
      const coherence: ObservationCoherence =
        beforeFacts.frame === null || afterFacts.frame === null || !allRequiredSourcesAvailable
          ? "UNKNOWN"
          : beforeFacts.frame === afterFacts.frame
            ? "STABLE_FRAME"
            : "BOUNDED_DRIFT";

      for (const source of required) {
        source.simulationFrameStart = beforeFacts.frame;
        source.simulationFrameEnd = afterFacts.frame;
        source.freshness.ageAtEnvelopeEndMs = Math.max(
          0,
          readEnded.getTime() - new Date(source.readEndedAt).getTime(),
        );
      }

      return {
        schemaVersion: V2_OBSERVATION_SCHEMA_VERSION,
        observationId: createId(),
        runtimeEpoch,
        worldEpoch: { kind: "RUNTIME_SESSION", value: runtimeEpoch, durableAcrossSaveLoad: false },
        readStartedAt: readStarted.toISOString(),
        readEndedAt: readEnded.toISOString(),
        simulationFrameStart: beforeFacts.frame,
        simulationFrameEnd: afterFacts.frame,
        gameTimeStart: beforeFacts.gameTime,
        gameTimeEnd: afterFacts.gameTime,
        pausedBefore: beforeFacts.paused,
        pausedAfter: afterFacts.paused,
        coherence,
        sourceFreshness: {
          basis: "WALL_CLOCK_CAPTURE_WINDOW",
          maximumAgeMs: Math.max(...required.map((source) => source.freshness.ageAtEnvelopeEndMs)),
          allRequiredSourcesAvailable,
        },
        revision: {
          authoritativeWorldRevision: null,
          ...(request.syntheticCacheRevision
            ? {
                syntheticCacheRevision: {
                  value: request.syntheticCacheRevision,
                  authority: "SYNTHETIC_CACHE_ONLY" as const,
                },
              }
            : {}),
        },
        sources: {
          gameStateBefore,
          snapshot,
          spatialScan,
          spatialDetail,
          gameStateAfter,
          ...(netEdges ? { netEdges } : {}),
        },
      };
    },
  };
}

export type V2ActionFamily = "ZONING" | "ROAD" | "BUILDING" | "UTILITY";
export type V2CommandStatus =
  | "CREATED"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "COMMIT_ACK"
  | "NATIVE_COMPLETED"
  | "NATIVE_COMPLETION_UNKNOWN"
  | "OBSERVED_MATCH"
  | "OBSERVED_MISMATCH"
  | "REJECTED"
  | "UNKNOWN_TIMEOUT"
  | "UNKNOWN_TRANSPORT"
  | "FAILED_BEFORE_SUBMIT";

export interface ExactZoningCellRef {
  block: SpatialEntityRef;
  cellIndex: number;
}

export interface AuthorizedMutationScope {
  owner: {
    ownerType: "PROJECT" | "TRANCHE" | "TASK" | "MANUAL" | "AUDIT";
    ownerId: string;
  };
  actionFamily: Exclude<V2ActionFamily, "ROAD" | "UTILITY">;
  allowedCells: ExactZoningCellRef[];
  spatialEnvelope: { center: SpatialPoint2; radius: number };
  maximumAffectedArea: { maxCellCount: number; maxRadiusMeters: number };
  budget: { maximumCost: number | null; currency: string | null; status: "PLACEHOLDER" };
  observationPrecondition: {
    observationId: string;
    runtimeEpoch: string;
    coherence: ObservationCoherence;
  };
  intendedEffect?: { zoneCategory: "residential" | "commercial" | "industrial" | "office" };
  expiresAt?: string;
  invalidatedReason?: string;
}

export interface RoadAuthorizedMutationScope {
  owner: AuthorizedMutationScope["owner"];
  actionFamily: "ROAD";
  proposalId: string;
  quoteId: string;
  fingerprint: string;
  exactInput: string;
  /** Missing on legacy records; only current-generation commands participate in write vetoes. */
  worldGeneration?: string;
  budget: {
    authorizedMaxSpend: number;
    treasurySafetyReserve: number;
    currency: string;
  };
  observationPrecondition: {
    runtimeEpoch: string;
    frame: number;
  };
  expiresAt: string;
  /** Exact one-shot facility repair authority, when this ROAD command is a repair. */
  facilityAccessRoadRepair?: {
    amendmentId: string;
    repairLineage: string;
    planRevision: string;
    actionFingerprint: string;
    actionCount: 1;
    purpose: string;
    prefab: string;
  };
  /** Durable typed single-use identity for a native local replacement/split operation. */
  networkJunctionInsert?: {
    operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT";
    identityFingerprint: string;
    replacementFingerprint: string;
  };
}

export interface UtilityAuthorizedMutationScope {
  owner: AuthorizedMutationScope["owner"];
  actionFamily: "UTILITY";
  /**
   * `civic` is a public-service building (school, clinic, fire/police station, landfill) placed by the same
   * journaled `place_building` path and read back by the same prefab-at-position census. It carries no network.
   */
  utilityKind: "electricity" | "water" | "sewage" | "civic";
  projectId: string;
  trancheId: string;
  reservationRef: string;
  /** Stable identity of one durable facility-placement execution instance. */
  placementScopeId?: string;
  worldEpochId: string;
  generation: string;
  topologyRevision: string;
  executionMechanismRevision?: string;
  certifiedRoadRefs: SpatialEntityRef[];
  exactInput: string;
  spatialEnvelope: { center: SpatialPoint2; radius: number };
  budget: { authorizedMaxSpend: number; treasurySafetyReserve: number; currency: string };
}

export type V2AuthorizedMutationScope = AuthorizedMutationScope | RoadAuthorizedMutationScope | UtilityAuthorizedMutationScope;

export interface CommandObservationEvidence {
  phase: "PRE_SUBMIT" | "RECONCILIATION";
  observationId: string;
  coherence: ObservationCoherence;
  recordedAt: string;
  summary: string;
  details?: unknown;
}

export interface V2CommandRecord {
  schemaVersion: typeof V2_COMMAND_SCHEMA_VERSION;
  commandId: string;
  actionFamily: V2ActionFamily;
  actionType: string;
  /** Exact durable Utility endpoint identity for sequential network-link repairs. */
  networkLinkRepairIdentity?: {
    repairLineage: string;
    stepIndex: 1 | 2;
    authorizationId: string;
    quote: number;
    actionIdentity: string;
    startEndpoint: unknown;
    endEndpoint: unknown;
  };
  authorizedScope: V2AuthorizedMutationScope;
  bridgeCommandId?: string | null;
  createdAt: string;
  submittedAt: string | null;
  nativeResultSummary: string | null;
  status: V2CommandStatus;
  statusHistory: Array<{ status: V2CommandStatus; at: string; reason?: string }>;
  reconciliationStatus: "NOT_STARTED" | "MATCH" | "MISMATCH" | "INCONCLUSIVE";
  observationEvidence: CommandObservationEvidence[];
  failureOrUnknownReason: string | null;
  effectAbsenceProven: boolean;
  /** Evidence-only payload returned by a rejected Bridge operation. */
  evidence?: {
    rejectionDiagnostics?: unknown;
    bridgeHttpErrorDiagnostics?: unknown;
    bridgeCommandId?: string;
    mcpBridgeFailureDiagnostics?: unknown;
    nativeBatchSemantics?: unknown;
    nativeActionResults?: unknown;
  };
  nativeCompletionEvidence?: unknown;
  nativeCompletionTelemetryTrace?: unknown;
  /** Bounded, read-only utility topology captured after native completion. */
  topologyEvidence?: unknown;
}

export interface UtilityNativeTelemetryEvidence {
  nativeCompletionEvidence?: unknown;
  nativeCompletionTelemetryTrace?: unknown;
  topologyEvidence?: unknown;
  preflightResidual?: unknown;
}

/**
 * The durable, restart-stable identity of a recorded command.
 *
 * Deliberately free of every load-scoped field. The native generation (and the
 * `worldEpochId` derived from it) changes on every reload/re-attach, so it can
 * never be the key of a durable lineage comparison; `durability.ts` says the
 * same thing for rollback classification: "the command's old ECS generation is
 * a historical execution artifact, not the generation of the current world."
 *
 * `worldId` + `baseCheckpointId` descend from the durability-activated world
 * and the checkpoint boundary the command was recorded against, both of which
 * are persisted and survive a restart of the same save/checkpoint lineage.
 */
export interface V2CommandDurableLineage {
  worldId: string;
  baseCheckpointId: string;
  position: number;
  /** The active rollback-boundary checkpoint the lineage was proven against. */
  boundaryCheckpointId: string;
  /**
   * How the proof was made. Both are durable checkpoint ancestry; neither is a
   * generation comparison.
   */
  proof: "CERTIFIED_CHECKPOINT_CONTAINS_COMMAND" | "LIVE_ON_RECORDED_CHECKPOINT";
}

export interface V2CommandJournal {
  create(record: V2CommandRecord): void;
  get(commandId: string): V2CommandRecord | undefined;
  update(commandId: string, update: (current: V2CommandRecord) => V2CommandRecord): V2CommandRecord;
  list(): V2CommandRecord[];
  /**
   * The durable lineage of a recorded command, or `null` when the active
   * durable world/checkpoint lineage cannot be proven to still contain it.
   *
   * The proof is durable checkpoint ancestry plus survival, never a generation
   * comparison: a normal periodic save of the same world advances the rollback
   * boundary to a descendant that contains the command and the lineage still
   * holds, while a rollback behind the command, a sibling or unrelated save, a
   * different world, and missing lineage all return `null`.
   *
   * Callers must treat `null` as "unproven" and fail closed; it is not "no
   * command". A journal without durable backing always returns `null`.
   */
  durableLineage(commandId: string): V2CommandDurableLineage | null;
}

const cloneCommand = (record: V2CommandRecord): V2CommandRecord => structuredClone(record);

export function createMemoryCommandJournal(): V2CommandJournal {
  const records = new Map<string, V2CommandRecord>();
  return {
    create(record) {
      if (records.has(record.commandId)) throw new Error(`command already exists: ${record.commandId}`);
      records.set(record.commandId, cloneCommand(record));
    },
    get(commandId) {
      const value = records.get(commandId);
      return value ? cloneCommand(value) : undefined;
    },
    update(commandId, update) {
      const current = records.get(commandId);
      if (!current) throw new Error(`unknown command: ${commandId}`);
      const next = update(cloneCommand(current));
      records.set(commandId, cloneCommand(next));
      return cloneCommand(next);
    },
    list() {
      return [...records.values()].map(cloneCommand);
    },
    // An in-memory journal holds no durable world/checkpoint lineage, so every
    // lineage question is unanswerable and must fail closed.
    durableLineage() {
      return null;
    },
  };
}

export type RetrySafetyDecision =
  | { automaticResendAllowed: false; next: "RECONCILE_FIRST" | "BLOCKED" | "CREATE_NEW_COMMAND"; reason: string }
  | { automaticResendAllowed: false; next: "NO_RETRY_NEEDED"; reason: string };

export function commandRetrySafety(record: V2CommandRecord): RetrySafetyDecision {
  if (record.status === "UNKNOWN_TIMEOUT" || record.status === "UNKNOWN_TRANSPORT") {
    return {
      automaticResendAllowed: false,
      next: "RECONCILE_FIRST",
      reason: "submission outcome is unknown; automatic resend could duplicate world effects",
    };
  }
  if (
    record.status === "COMMIT_ACK" ||
    record.status === "NATIVE_COMPLETED" ||
    record.status === "NATIVE_COMPLETION_UNKNOWN"
  ) {
    return {
      automaticResendAllowed: false,
      next: "RECONCILE_FIRST",
      reason: "submitted ROAD execution is not an authoritative world-effect certificate",
    };
  }
  if (record.status === "OBSERVED_MISMATCH" && record.effectAbsenceProven) {
    return {
      automaticResendAllowed: false,
      next: "CREATE_NEW_COMMAND",
      reason: "readback proved the original effect did not occur; never reuse the submitted command id",
    };
  }
  if (record.status === "FAILED_BEFORE_SUBMIT" || record.status === "REJECTED") {
    return {
      automaticResendAllowed: false,
      next: "CREATE_NEW_COMMAND",
      reason: "the failed command is terminal; caller may create a new authorized command",
    };
  }
  if (record.status === "OBSERVED_MATCH") {
    return { automaticResendAllowed: false, next: "NO_RETRY_NEEDED", reason: "world effect already matched" };
  }
  return {
    automaticResendAllowed: false,
    next: "BLOCKED",
    reason: "command is not in a state that permits a replacement command",
  };
}

export type ZoneCategory = "residential" | "commercial" | "industrial" | "office";

export interface AuthorizedZoningCell extends ExactZoningCellRef {
  expected: {
    zoneType: number;
    zoneCategory?: SpatialZoningCell["zoneCategory"];
    visible: boolean;
    roadside: boolean;
    occupied: boolean;
    blocked: boolean;
    overridden: boolean;
  };
}

export interface ZoningIntent {
  intentId: string;
  scope: AuthorizedMutationScope;
  zoneCategory: ZoneCategory;
  nativeZone: string;
  authorizedCells: AuthorizedZoningCell[];
  spatialEnvelope: { center: SpatialPoint2; radius: number; resolution?: number };
}

export type EffectMatcherResult = "MATCH" | "MISMATCH" | "INCONCLUSIVE";

export interface ZoningCellOutcome {
  ref: ExactZoningCellRef;
  before: Pick<SpatialZoningCell, "zoneType" | "zoneCategory" | "visible" | "roadside" | "occupied" | "blocked" | "overridden"> | null;
  after: Pick<SpatialZoningCell, "zoneType" | "zoneCategory" | "visible" | "roadside" | "occupied" | "blocked" | "overridden"> | null;
}

export interface ZoningEffectReport {
  matcherResult: EffectMatcherResult;
  authorizedCellCount: number;
  changedAuthorizedCells: ExactZoningCellRef[];
  changedUnauthorizedCells: ExactZoningCellRef[];
  unchangedAuthorizedCells: ExactZoningCellRef[];
  missingAuthorizedCells: ExactZoningCellRef[];
  zoneCategory: ZoneCategory;
  cellOutcomes: ZoningCellOutcome[];
  effectAbsenceProven: boolean;
  reason: string;
  observedEnvelope: {
    observationId: string;
    runtimeEpoch: string;
    coherence: ObservationCoherence;
  };
}

export type NativeZoningSubmission =
  | { kind: "COMMIT_ACK"; summary: string; raw?: unknown }
  | { kind: "REJECTED"; reason: string; raw?: unknown };

export class V2SubmissionTimeoutError extends Error {
  constructor(message = "native zoning submission timed out with unknown outcome") {
    super(message);
    this.name = "V2SubmissionTimeoutError";
  }
}

export interface V2ZoningKernel {
  execute(intent: ZoningIntent, baseline: V2ObservationEnvelope, signal?: AbortSignal): Promise<{
    command: V2CommandRecord;
    effectReport?: ZoningEffectReport;
  }>;
  reconcile(commandId: string, signal?: AbortSignal): Promise<{
    command: V2CommandRecord;
    effectReport: ZoningEffectReport;
  }>;
}

const cellKey = (ref: ExactZoningCellRef | SpatialZoningCell) =>
  `${"block" in ref ? ref.block.index : ""}:${"block" in ref ? ref.block.version : ""}:${"cellIndex" in ref ? ref.cellIndex : ref.index}`;

const exactRef = (cell: SpatialZoningCell): ExactZoningCellRef => ({ block: cell.block, cellIndex: cell.index });

const cellState = (cell: SpatialZoningCell): ZoningCellOutcome["before"] => ({
  zoneType: cell.zoneType,
  zoneCategory: cell.zoneCategory,
  visible: cell.visible,
  roadside: cell.roadside,
  occupied: cell.occupied,
  blocked: cell.blocked,
  overridden: cell.overridden,
});

const changed = (before: SpatialZoningCell, after: SpatialZoningCell) =>
  before.zoneType !== after.zoneType || before.zoneCategory !== after.zoneCategory;

function detailFrom(envelope: V2ObservationEnvelope): SpatialSiteDetail | null {
  return envelope.sources.spatialDetail.status === "UNAVAILABLE" ? null : (envelope.sources.spatialDetail.data ?? null);
}

function cellsWithinActionRadius(detail: SpatialSiteDetail, intent: ZoningIntent): SpatialZoningCell[] {
  return nativeZoningMarqueeFootprint(detail, intent.spatialEnvelope.center, intent.spatialEnvelope.radius);
}

function transition(
  journal: V2CommandJournal,
  commandId: string,
  status: V2CommandStatus,
  at: string,
  reason?: string,
  extra?: Partial<V2CommandRecord>,
) {
  return journal.update(commandId, (current) => ({
    ...current,
    ...extra,
    status,
    statusHistory: [...current.statusHistory, { status, at, ...(reason ? { reason } : {}) }],
  }));
}

function validateIntent(intent: ZoningIntent, baseline: V2ObservationEnvelope, now: Date): string | null {
  if (intent.scope.actionFamily !== "ZONING") return "authorized scope is not for zoning";
  if (intent.scope.invalidatedReason) return `authorized scope invalidated: ${intent.scope.invalidatedReason}`;
  if (intent.scope.expiresAt && new Date(intent.scope.expiresAt).getTime() <= now.getTime()) return "authorized scope expired";
  if (intent.scope.observationPrecondition.observationId !== baseline.observationId)
    return "observation precondition does not reference the supplied baseline";
  if (intent.scope.observationPrecondition.runtimeEpoch !== baseline.runtimeEpoch)
    return "observation precondition runtime epoch is stale";
  if (intent.scope.spatialEnvelope.radius !== intent.spatialEnvelope.radius) return "scope and intent radius differ";
  if (
    intent.spatialEnvelope.radius < NATIVE_ZONING_MIN_RADIUS_METERS ||
    intent.spatialEnvelope.radius > 200
  ) return "native zoning radius is outside the Bridge's clamped 8m to 200m range";
  if (intent.spatialEnvelope.radius > intent.scope.maximumAffectedArea.maxRadiusMeters)
    return "native zoning radius exceeds authorized maximum";
  if (intent.authorizedCells.length > intent.scope.maximumAffectedArea.maxCellCount)
    return "authorized cells exceed maximum affected cell count";
  const intentKeys = new Set(intent.authorizedCells.map(cellKey));
  const scopeKeys = new Set(intent.scope.allowedCells.map(cellKey));
  if (intentKeys.size !== intent.authorizedCells.length) return "authorized zoning cells contain duplicates";
  if (intentKeys.size !== scopeKeys.size || [...intentKeys].some((key) => !scopeKeys.has(key)))
    return "intent cells differ from the admitted exact cell set";
  return intent.authorizedCells.length === 0 ? "authorized zoning cell set is empty" : null;
}

function preSubmitCellValidation(intent: ZoningIntent, detail: SpatialSiteDetail): string | null {
  const current = new Map(detail.zoningCells.map((cell) => [cellKey(cell), cell]));
  for (const authorized of intent.authorizedCells) {
    const cell = current.get(cellKey(authorized));
    if (!cell) return `authorized cell disappeared or is stale: ${cellKey(authorized)}`;
    const expected = authorized.expected;
    if (
      cell.zoneType !== expected.zoneType ||
      cell.zoneCategory !== expected.zoneCategory ||
      cell.visible !== expected.visible ||
      cell.roadside !== expected.roadside ||
      cell.occupied !== expected.occupied ||
      cell.blocked !== expected.blocked ||
      cell.overridden !== expected.overridden
    ) {
      return `authorized cell state changed concurrently: ${cellKey(authorized)}`;
    }
  }

  const potentiallyMutable = nativeZoningMarqueeFootprint(
    detail,
    intent.spatialEnvelope.center,
    intent.spatialEnvelope.radius,
  ).filter((cell) => cell.zoneCategory !== intent.zoneCategory);
  const authorizedKeys = new Set(intent.authorizedCells.map(cellKey));
  const unauthorizedPotential = potentiallyMutable.filter((cell) => !authorizedKeys.has(cellKey(cell)));
  if (unauthorizedPotential.length > 0) {
    return `native marquee footprint includes ${unauthorizedPotential.length} unauthorized cell(s)`;
  }
  return null;
}

export function matchZoningEffect(input: {
  intent: ZoningIntent;
  before: SpatialSiteDetail;
  afterEnvelope: V2ObservationEnvelope;
}): ZoningEffectReport {
  const after = detailFrom(input.afterEnvelope);
  const authorizedKeys = new Set(input.intent.authorizedCells.map(cellKey));
  const beforeByKey = new Map(cellsWithinActionRadius(input.before, input.intent).map((cell) => [cellKey(cell), cell]));
  const afterByKey = new Map(
    (after ? cellsWithinActionRadius(after, input.intent) : []).map((cell) => [cellKey(cell), cell]),
  );
  const changedAuthorizedCells: ExactZoningCellRef[] = [];
  const changedUnauthorizedCells: ExactZoningCellRef[] = [];
  const unchangedAuthorizedCells: ExactZoningCellRef[] = [];
  const missingAuthorizedCells: ExactZoningCellRef[] = [];
  const cellOutcomes: ZoningCellOutcome[] = [];

  for (const authorized of input.intent.authorizedCells) {
    const key = cellKey(authorized);
    const beforeCell = beforeByKey.get(key);
    const afterCell = afterByKey.get(key);
    if (!beforeCell || !afterCell) missingAuthorizedCells.push(authorized);
    else if (changed(beforeCell, afterCell) && afterCell.zoneCategory === input.intent.zoneCategory)
      changedAuthorizedCells.push(authorized);
    else unchangedAuthorizedCells.push(authorized);
    cellOutcomes.push({
      ref: authorized,
      before: beforeCell ? cellState(beforeCell) : null,
      after: afterCell ? cellState(afterCell) : null,
    });
  }

  if (after) {
    for (const [key, beforeCell] of beforeByKey) {
      if (authorizedKeys.has(key)) continue;
      const afterCell = afterByKey.get(key);
      if (afterCell && changed(beforeCell, afterCell)) changedUnauthorizedCells.push(exactRef(afterCell));
    }
  }

  const completeReadback =
    after !== null &&
    input.afterEnvelope.coherence === "STABLE_FRAME" &&
    missingAuthorizedCells.length === 0 &&
    beforeByKey.size === afterByKey.size &&
    [...beforeByKey.keys()].every((key) => afterByKey.has(key));
  const allAuthorizedChanged = changedAuthorizedCells.length === input.intent.authorizedCells.length;
  const noCellChanged = changedAuthorizedCells.length === 0 && changedUnauthorizedCells.length === 0;
  const effectAbsenceProven = completeReadback && noCellChanged && unchangedAuthorizedCells.length === input.intent.authorizedCells.length;
  const matcherResult: EffectMatcherResult = !completeReadback
    ? "INCONCLUSIVE"
    : allAuthorizedChanged && changedUnauthorizedCells.length === 0
      ? "MATCH"
      : "MISMATCH";
  const reason =
    matcherResult === "MATCH"
      ? "all authorized cells changed to the requested category and no unauthorized cell changed"
      : matcherResult === "INCONCLUSIVE"
        ? "readback lacked a coherent complete exact-cell comparison"
        : changedUnauthorizedCells.length > 0
          ? "one or more unauthorized cells changed"
          : "one or more authorized cells did not change to the requested category";

  return {
    matcherResult,
    authorizedCellCount: input.intent.authorizedCells.length,
    changedAuthorizedCells,
    changedUnauthorizedCells,
    unchangedAuthorizedCells,
    missingAuthorizedCells,
    zoneCategory: input.intent.zoneCategory,
    cellOutcomes,
    effectAbsenceProven,
    reason,
    observedEnvelope: {
      observationId: input.afterEnvelope.observationId,
      runtimeEpoch: input.afterEnvelope.runtimeEpoch,
      coherence: input.afterEnvelope.coherence,
    },
  };
}

export function createV2ZoningKernel(options: {
  observation: V2ObservationPorts;
  journal: V2CommandJournal;
  submit(intent: ZoningIntent, signal?: AbortSignal): Promise<NativeZoningSubmission>;
  now?: Clock;
  createId?: () => string;
}): V2ZoningKernel {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const mutex = Mutex.create();
  const contexts = new Map<string, { intent: ZoningIntent; before: SpatialSiteDetail }>();

  const reconcile = async (commandId: string, signal?: AbortSignal) => {
    const current = options.journal.get(commandId);
    const context = contexts.get(commandId);
    if (!current || !context) throw new Error(`command cannot be reconciled in this process: ${commandId}`);
    const afterEnvelope = await options.observation.capture({ spatialDetail: observationRequestForZoning(context.intent), signal });
    const report = matchZoningEffect({ intent: context.intent, before: context.before, afterEnvelope });
    const at = now().toISOString();
    const evidence: CommandObservationEvidence = {
      phase: "RECONCILIATION",
      observationId: afterEnvelope.observationId,
      coherence: afterEnvelope.coherence,
      recordedAt: at,
      summary: report.reason,
      details: report,
    };
    const command =
      report.matcherResult === "INCONCLUSIVE"
        ? options.journal.update(commandId, (record) => ({
            ...record,
            reconciliationStatus: "INCONCLUSIVE",
            observationEvidence: [...record.observationEvidence, evidence],
            failureOrUnknownReason: report.reason,
          }))
        : transition(
            options.journal,
            commandId,
            report.matcherResult === "MATCH" ? "OBSERVED_MATCH" : "OBSERVED_MISMATCH",
            at,
            report.reason,
            {
              reconciliationStatus: report.matcherResult,
              observationEvidence: [...current.observationEvidence, evidence],
              failureOrUnknownReason: report.matcherResult === "MATCH" ? null : report.reason,
              effectAbsenceProven: report.effectAbsenceProven,
            },
          );
    return { command, effectReport: report };
  };

  return {
    reconcile,
    async execute(intent, baseline, signal) {
      await mutex.acquire(signal);
      const createdAt = now().toISOString();
      const commandId = createId();
      const initial: V2CommandRecord = {
        schemaVersion: V2_COMMAND_SCHEMA_VERSION,
        commandId,
        actionFamily: "ZONING",
        actionType: "zone",
        authorizedScope: { ...intent.scope, intendedEffect: { zoneCategory: intent.zoneCategory } },
        createdAt,
        submittedAt: null,
        nativeResultSummary: null,
        status: "CREATED",
        statusHistory: [{ status: "CREATED", at: createdAt }],
        reconciliationStatus: "NOT_STARTED",
        observationEvidence: [],
        failureOrUnknownReason: null,
        effectAbsenceProven: false,
      };
      options.journal.create(initial);
      try {
        const intentError = validateIntent(intent, baseline, now());
        if (intentError) {
          return {
            command: transition(options.journal, commandId, "FAILED_BEFORE_SUBMIT", now().toISOString(), intentError, {
              failureOrUnknownReason: intentError,
            }),
          };
        }
        transition(options.journal, commandId, "AUTHORIZED", now().toISOString());
        const beforeEnvelope = await options.observation.capture({
          spatialDetail: observationRequestForZoning(intent),
          signal,
        });
        const before = detailFrom(beforeEnvelope);
        if (!before) {
          const reason = "pre-submit exact zoning cells are unavailable";
          return {
            command: transition(options.journal, commandId, "FAILED_BEFORE_SUBMIT", now().toISOString(), reason, {
              failureOrUnknownReason: reason,
            }),
          };
        }
        if (beforeEnvelope.coherence !== "STABLE_FRAME") {
          const reason = `pre-submit observation coherence is ${beforeEnvelope.coherence}; STABLE_FRAME is required`;
          return {
            command: transition(options.journal, commandId, "FAILED_BEFORE_SUBMIT", now().toISOString(), reason, {
              failureOrUnknownReason: reason,
            }),
          };
        }
        const validationError = preSubmitCellValidation(intent, before);
        if (validationError) {
          return {
            command: transition(options.journal, commandId, "FAILED_BEFORE_SUBMIT", now().toISOString(), validationError, {
              failureOrUnknownReason: validationError,
            }),
          };
        }
        const preEvidence: CommandObservationEvidence = {
          phase: "PRE_SUBMIT",
          observationId: beforeEnvelope.observationId,
          coherence: beforeEnvelope.coherence,
          recordedAt: now().toISOString(),
          summary: `validated ${intent.authorizedCells.length} exact authorized zoning cell(s)`,
          details: {
            cells: before.zoningCells,
            observedSpatialRadiusMeters: observationRequestForZoning(intent).radius,
            nativeMarquee: {
              shape: "AXIS_ALIGNED_QUAD",
              center: intent.spatialEnvelope.center,
              halfWidthMeters: intent.spatialEnvelope.radius,
            },
          },
        };
        options.journal.update(commandId, (record) => ({
          ...record,
          observationEvidence: [...record.observationEvidence, preEvidence],
        }));
        contexts.set(commandId, { intent: structuredClone(intent), before: structuredClone(before) });
        const submittedAt = now().toISOString();
        transition(options.journal, commandId, "SUBMITTED", submittedAt, undefined, { submittedAt });
        let native: NativeZoningSubmission;
        try {
          native = await options.submit(intent, signal);
        } catch (error) {
          const status: V2CommandStatus = error instanceof V2SubmissionTimeoutError ? "UNKNOWN_TIMEOUT" : "UNKNOWN_TRANSPORT";
          const reason = error instanceof Error ? error.message : String(error);
          return {
            command: transition(options.journal, commandId, status, now().toISOString(), reason, {
              failureOrUnknownReason: reason,
            }),
          };
        }
        if (native.kind === "REJECTED") {
          return {
            command: transition(options.journal, commandId, "REJECTED", now().toISOString(), native.reason, {
              nativeResultSummary: native.reason,
              failureOrUnknownReason: native.reason,
            }),
          };
        }
        transition(options.journal, commandId, "COMMIT_ACK", now().toISOString(), native.summary, {
          nativeResultSummary: native.summary,
        });
        return await reconcile(commandId, signal);
      } finally {
        await mutex.release();
      }
    },
  };
}

/**
 * Why a ROAD effect observation may be attributed to the world a durable
 * command belongs to.
 *
 * The command's execution-time runtime generation is deliberately absent. The
 * bridge mints a fresh generation on every load, so demanding that the current
 * scan carry the command's own generation made every ordinary reload
 * unprovable — while proving nothing, because a generation answers "which
 * session is this", never "which world is this".
 *
 * What is carried instead is the persistent identity the durability layer has
 * already established: the native world and its session guid, the durable
 * checkpoints the command's journal lineage was recorded against, and the name
 * of the proof that established it. No second world identity is introduced
 * here — these are the same fields `V2CheckpointRecord` and
 * `V2CommandDurableLineage` are keyed on.
 */
export interface V2RoadEffectProvenance {
  worldId: string;
  nativeSessionGuid: string;
  /** The durable checkpoint this very command was recorded against. */
  baseCheckpointId: string;
  /** Every durable checkpoint the lineage's commands were recorded against. */
  lineageCheckpointIds: string[];
  proof: "CERTIFIED_DURABLE_LINEAGE" | "PENDING_DESCENDANT_LINEAGE" | "REGISTERED_CHECKPOINT_CUT_EXCLUDES_COMMAND";
}

export interface RoadEffectMatcher {
  match(input: { command: V2CommandRecord; observation: V2ObservationEnvelope }): {
    result: EffectMatcherResult;
    evidence: unknown;
    reason: string;
    effectAbsenceProven: boolean;
  };
  /**
   * Net prefabs this matcher needs beyond the road graph, asked BEFORE the
   * observation is captured.
   *
   * A matcher that answers from `sources.spatialScan` (every ROAD course) omits
   * this and pays nothing. One whose command builds a net object the scan cannot
   * hold returns the prefab here, and the capture then also reads the listing
   * that does hold it. Returning null/undefined means "the road graph is
   * enough", never "capture nothing".
   */
  netEdgePrefabs?(command: V2CommandRecord): readonly string[] | null;
}
