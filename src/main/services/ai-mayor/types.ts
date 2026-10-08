import type { IChatUsage } from "intellichat/types";
import type { DeepSeekEstimatedCost } from "@/intellichat/telemetry/deepseekCost";
import type { DeepSeekBalance } from "@/main/services/deepseek-balance";
import type { LocalMayorGrowthDomain, LocalMayorState } from "./local-mayor/types";
import type { UrbanDesignIntent } from "./urban-design/intent";
import type { UtilityEndpointBinding } from "./v2/utility-endpoints";
import type { BoundedNetworkJunctionInsert } from "./v2/bounded-network-junction";

export type MayorSessionStatus = "running" | "stopped";
export type MayorDecisionMode = "deepseek" | "fast" | "local";

export type UrbanDesignDevelopmentPolicy = "infill" | "expand_first" | "mixed";

export interface MayorMemory {
  phase: string;
  strategy: string;
  importantAreas: string[];
  recentMilestones: string[];
  unresolvedProblems: string[];
  nextGoal: string;
}

export interface MayorBuildRoadAction {
  type: "build_road";
  prefab: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  cx?: number;
  cz?: number;
  e1?: number;
  e2?: number;
  /** Durable meaning only; runtime entity IDs are rebound before preview/apply. */
  utilityEndpoints?: {
    start: UtilityEndpointBinding;
    end: UtilityEndpointBinding;
  };
  /** Durable semantic for a preview-certified local edge-split/junction insert. */
  networkJunctionInsert?: BoundedNetworkJunctionInsert;
  /** Runtime-only Bridge fields. Durable plans must use utilityEndpoints above. */
  startEndpoint?: {
    kind: "EXISTING_NET_NODE" | "NEW_FREE_ENDPOINT";
    role: "START";
    entity?: { index: number; version: number } | null;
    expectedPosition: { x: number; y: number; z: number };
    worldEpoch: string;
    utility?: "ELECTRICITY";
    semanticRole?: "NETWORK_ENTRY";
    bindingRule?: string;
    topologyRole?: string;
  };
  endEndpoint?: {
    kind: "EXISTING_NET_NODE" | "NEW_FREE_ENDPOINT";
    role: "END";
    entity?: { index: number; version: number } | null;
    expectedPosition: { x: number; y: number; z: number };
    worldEpoch: string;
    utility?: "ELECTRICITY";
    semanticRole?: "NETWORK_ENTRY";
    bindingRule?: string;
    topologyRole?: string;
  };
  force?: false;
}

export interface MayorZoneAction {
  type: "zone";
  zone: string;
  x: number;
  z: number;
  radius?: number;
  force?: false;
}

export interface MayorPlaceBuildingAction {
  type: "place_building";
  prefab: string;
  x: number;
  z: number;
  rotation?: number;
  force?: false;
}

export interface MayorUpgradeRoadAction {
  type: "upgrade_road";
  index: number;
  version: number;
  upgrades: Array<
    "grass" | "trees" | "wideSidewalk" | "soundBarrier" | "parking" | "lighting" | "medianGrass" | "medianTrees"
  >;
  side?: "both" | "left" | "right";
}

export type MayorAction = MayorBuildRoadAction | MayorZoneAction | MayorPlaceBuildingAction | MayorUpgradeRoadAction;

export interface MayorCandidateSelectionAction {
  type: "choose_candidate";
  candidateId: string;
  reason: string;
  priority?: "low" | "medium" | "high";
}

export type MayorPlanAction = MayorAction | MayorCandidateSelectionAction;

export interface MayorPlanningCandidate {
  id: string;
  actionType: "zone" | "build_road";
  candidateType: "zoning" | "road_expansion";
  zoneType?: string;
  areaType?: "Residential" | "Commercial" | "Industrial" | "Office";
  approximateCells?: number;
  approximateLength?: number;
  approximateNewFrontage?: number;
  approximateDirection?: string;
  sourceRoad?: { index: number; version: number };
  adjacentRoad: {
    entity: { index: number; version: number };
    prefab: string;
  };
  accessibility: "roadside" | "connected_endpoint";
  spatialRole: "infill" | "small_expansion";
  relevantDemand: { category: "residential" | "commercial" | "industrial" | "office"; value: number | null };
  estimatedCost: number | null;
  constraints: string[];
  validationStatus: "validated";
  growthDomain?: LocalMayorGrowthDomain;
  conflictGroup: string;
  roadHeadingDegrees?: number;
  roadHeadingDeltaDegrees?: number;
  roadTopologyRole?: "grid_axis" | "cross_link" | "contour_connector" | "organic_branch";
  roadLength?: number;
  roadTerrainVariation?: number;
  urbanDesign?: MayorUrbanDesignCandidateMetadata;
}

export interface MayorUrbanDesignCandidateMetadata {
  designProposalId: string;
  primaryStyle: string;
  secondaryInfluence?: string;
  motif: string;
  anchorId: string;
  realizationGroupId: string;
  designRole: "primary_road" | "branch" | "frontage" | "district_infill";
}

export interface MayorOperationalSignals {
  demandPersistenceTicks: {
    residential: number;
    commercial: number;
    industrial: number;
    office: number;
  };
  consecutiveNoConstructionTicks: number;
  populationStagnationTicks: number;
  treasury: {
    sessionStart: number | null;
    current: number | null;
    change: number | null;
  };
  previousNoOpStatus: string | null;
  note: string;
}

export interface MayorPlan {
  status: string;
  objective: string;
  rationale: string;
  urbanDesignIntent?: UrbanDesignIntent;
  blockingReason?: string;
  actions: MayorPlanAction[];
  constructionPhase?: {
    objective: string;
    candidateIds: string[];
    rationale: string;
  };
  simulation: {
    run: boolean;
    hours?: number;
    speed?: number;
  };
  memoryUpdate: Partial<MayorMemory>;
  stop: {
    requested: boolean;
    reason?: string;
  };
}

export interface MayorBatchResult {
  ok: boolean;
  requested: number;
  executed: number;
  failedAt?: number;
  results: Array<{
    index: number;
    type: MayorAction["type"];
    ok: boolean;
    summary: string;
    error?: string;
    receipt?: {
      entity: { index: number; version: number };
      prefab: string;
      position: { x: number; y?: number; z: number };
    };
    v2Road?: {
      executionCommandId: string;
      bridgeCommandId: string | null;
      proposalId: string;
      quoteId: string;
      fingerprint: string;
      financeReceipt?: import("./v2/finance").ApplyFinanceReceipt;
    };
    /** Raw native completion envelope carried through batch aggregation for bounded evidence. */
    nativeCompletionEvidence?: unknown;
    rejectionDiagnostics?: unknown;
    bridgeHttpErrorDiagnostics?: unknown;
    bridgeCommandId?: string;
    mcpBridgeFailureDiagnostics?: unknown;
  }>;
}

export interface MayorDecisionResult {
  content: string;
  requestId?: string;
  model: string;
  usage: IChatUsage;
  estimatedCost?: DeepSeekEstimatedCost;
}

export interface MayorTickTelemetry {
  tick: number;
  startedAt: string;
  endedAt: string;
  outcome: "success" | "stopped" | "failed";
  error?: string;
  apiRequestCount: number;
  requestId?: string;
  model?: string;
  promptChars: number;
  promptBytes: number;
  promptTokens: number;
  snapshotBytes: number;
  mayorMemoryBytes: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCnyCost: number;
  wallClockDurationMs: number;
  decisionLatencyMs: number;
  planningValidationLatencyMs: number;
  executionLatencyMs: number;
  simulationWaitDurationMs: number;
  requestedActionCount: number;
  executedActionCount: number;
  selectedCandidateCount: number;
  zonedCellCount?: number;
  roadActionCount: number;
  approximateRoadLength?: number;
  buildingPlacementCount: number;
  modelPlanFormat: "actions" | "constructionPhase";
  normalizedToConstructionPhase: boolean;
}

export interface MayorTelemetryTotals {
  apiRequestCount: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCnyCost: number;
}

export interface MayorSessionState {
  sessionId: string;
  goal: string;
  status: MayorSessionStatus;
  lifecycleMode: "GREENFIELD_BOOTSTRAP" | "LIVE";
  startedAt: string;
  stoppedAt?: string;
  stopReason?: string;
  tickCount: number;
  maxSessionSpend: number;
  minimumBalance: number;
  estimatedSessionSpend: number;
  currentBalance: number | null;
  compactMayorMemory: MayorMemory;
  operationalSignals: MayorOperationalSignals;
  lastSnapshot: unknown | null;
  lastBatchResult: MayorBatchResult | null;
  consecutiveFailures: number;
  pendingUserCommand: MayorCommand | null;
  lastStatus: string;
  telemetryTotals: MayorTelemetryTotals;
  recentTickTelemetry: MayorTickTelemetry[];
  /**
   * Diagnostic record of why the city did or did not keep growing, one bounded
   * window per tick. Purely observational — see `v2/run-ledger`.
   */
  runLedger?: import("./v2/run-ledger").RunLedgerState;
  /**
   * Lightweight, player-independent timing and rejection counters for the latest
   * bounded growth package: one Goal's roads and the tranche its last item
   * carries on into utilities, zoning and absorption.
   */
  fastExpansionMetrics?: {
    goalToFirstApplyMs: number;
    batchElapsedMs: number;
    previewCandidates: number;
    applySuccesses: number;
    nativeRejections: number;
    /** The stage the package's tranche carrier reached, or null if none ran. */
    trancheStage?: string | null;
  };
  localMayorStageTrace?: MayorStageTraceEntry[];
  decisionMode?: MayorDecisionMode;
  localMayorStatus?:
    | "observing"
    | "deciding"
    | "acting"
    | "waiting"
    | "recovering"
    | "yielding"
    | "blocked"
    | "stopped";
  localMayorActivity?: import("./local-mayor/types").LocalMayorActivity;
  localMayorTrace?: unknown;
  localMayorProgress?: {
    kind: "none" | "execution" | "simulation" | "yield" | "observation";
    consecutiveZeroProgressIterations: number;
    gameTimeAdvanced: boolean;
    worldRevisionChanged: boolean;
  };
}

export type MayorStageName =
  | "tickStarted"
  | "observeGameState"
  | "snapshot"
  | "issueScan"
  | "candidateRefresh"
  | "decision"
  | "execution"
  | "readback"
  | "simulation"
  | "tickCompleted"
  | "tickFailed"
  | "tickTimedOut"
  | "tickAborted";

export interface MayorStageTraceEntry {
  tick: number;
  stage: MayorStageName;
  phase: "start" | "end" | "failure";
  elapsedMs: number;
  revision: string | null;
  activity: string | null;
  operation?: string;
  error?: string;
}

export interface MayorStructuredGoalIntent {
  kind: "GOAL";
  type: "GROW_POPULATION" | "EXPAND_RESIDENTIAL" | "EXPAND_COMMERCIAL" | "EXPAND_INDUSTRIAL" | "EXPAND_OFFICE" |
    "PROVIDE_SERVICE" | "IMPROVE_TRAFFIC" | "ESTABLISH_ROAD_NETWORK" | "REDEVELOP_AREA" | "CONNECT_ACROSS_OBSTACLE" | "RESOLVE_ISSUES";
  scope?: {
    /** RESOLVE_ISSUES: the city problems named (`v2/care-focus.ts`); absent or empty = all of them. */
    issues?: Array<"TRAFFIC" | "NOISE" | "RUINS" | "ACCESS" | "CRIME" | "FIRE" | "HEALTH" | "DEATHCARE" | "GARBAGE" | "FINANCE">;
    region?: "ANY" | "NEAR_EXISTING" | "WATERFRONT" | "INFILL" | "EDGE" | "FAR";
    serviceKind?: "ELECTRICITY" | "WATER" | "SEWAGE" | "EDUCATION" | "HEALTHCARE" | "FIRE" | "POLICE" | "PARK";
    density?: "LOW" | "MEDIUM" | "HIGH";
    roadCharacter?: "GRID" | "ORGANIC" | "ROUNDABOUT";
    acquireLand?: boolean;
    /** District work: the side of the city the district goes, as a compass bearing from the city's centre (x is east, z is north). */
    direction?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  };
  priority: "LOW" | "NORMAL" | "HIGH";
}

export interface MayorCommand {
  text: string;
  source: "text" | "voice" | "map";
  target?: { x: number; z: number };
  structuredIntent?: MayorStructuredGoalIntent;
  createdAt: string;
}

export interface StartMayorSessionOptions {
  goal: string;
  maxSessionSpend: number;
  minimumBalance: number;
  model?: string;
  continuous?: boolean;
  tickDelayMs?: number;
  speed?: "normal" | "fast";
  decisionMode?: MayorDecisionMode;
  stageTrace?: boolean;
  localMayorStageTimeoutMs?: number;
  lifecycleMode?: "GREENFIELD_BOOTSTRAP" | "LIVE";
  noProgressGuard?: boolean;
}

export interface MayorRuntimePorts {
  v2ProductionSkillRuntime?: import("./v2/production-skill-runtime").V2ProductionSkillRuntime;
  /** Generic production Gate 1 lifecycle owner; advances the durable state machine. */
  v2Gate1Progression?: import("./v2/gate1-progression").V2Gate1Progression;
  /** The player-style decision layer: one whole district per cycle. Tried before the Gate 1 Goal path. */
  districtBuilder?: Pick<import("./v2/district-builder").DistrictBuilder, "runCycle" | "repairUtilities"> & Partial<Pick<import("./v2/district-builder").DistrictBuilder, "rebaseline">>;
  /**
   * What keeps the player's game alive and the Mayor honest across crashes and disconnects (see `v2/session-safety.ts`). Absent: none
   * of it applies. Nothing here is a source of truth about the world.
   */
  lifecycle?: {
    /** Which world the game is showing now; null when it cannot be reached or is still loading. */
    worldIdentity(signal?: AbortSignal): Promise<import("./v2/session-safety").WorldIdentity | null>;
    /** The machine's free commit memory in GB (what a save needs new memory from); null when it cannot be read. */
    freeCommitGb(): Promise<number | null>;
    /** One native save into a named slot, then a health read-back; it leaves the pause and speed state as it found them. */
    checkpointSave(name: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  };
  /** FINANCIAL_RECOVERY: one cycle of the finance loop (see `v2/finance-recovery.ts`). */
  financeRecovery?: Pick<import("./v2/finance-recovery").FinanceRecoveryLoop, "step"> & { memory?: { balanceReads: readonly number[] } };
  getBalance(): Promise<DeepSeekBalance>;
  getSnapshot(signal?: AbortSignal, options?: { strategicOnly?: boolean }): Promise<unknown>;
  decide(input: { systemPrompt: string; userPrompt: string; model: string }): Promise<MayorDecisionResult>;
  decideUrbanDesign?(input: { systemPrompt: string; userPrompt: string; model: string }): Promise<MayorDecisionResult>;
  executeActions(actions: MayorPlanAction[], signal?: AbortSignal): Promise<MayorBatchResult>;
  realizeUrbanDesignIntent?(intent: unknown): Promise<unknown>;
  getUrbanDesignNoveltyMemory?(): unknown;
  runSimulation(simulation: { hours: number; speed: number }, signal: AbortSignal): Promise<void>;
  /**
   * The same bounded wait as `runSimulation`, without the pause at its end: the city is kept running and the wait ends when `hours` of game
   * time have passed. No timed run is started, so nothing auto-pauses and nothing is cancelled. Absent: the caller uses `runSimulation`.
   */
  observeRunningSimulation?(simulation: { hours: number; speed: number }, signal: AbortSignal): Promise<void>;
  /**
   * Keep the city running until the utility readings show what a placement was meant to add (electricity production, fresh water capacity), or
   * `maximumHours` of game time pass. Resolves with whether the capacity appeared and how long that took. The wait that follows a facility ends
   * when the WORLD shows the facility working, instead of after a fixed span that nothing had measured. Absent: the caller waits a fixed window.
   */
  awaitUtilityCapacity?(input: { kinds: ReadonlyArray<"electricity" | "water">; maximumHours: number; speed: number }, signal: AbortSignal):
    Promise<{ ready: boolean; gameHours: number; wallMs: number }>;
  /** The simulation frame now (null when unreadable): the clock the cooldowns are measured on (`v2/game-clock.ts`). Absent: they count ticks. */
  readGameFrame?(signal?: AbortSignal): Promise<number | null>;
  checkBlockingModal?(signal?: AbortSignal): Promise<{ allowedToContinue: boolean; modalClass: string }>;
  /** Watches for an ordinary milestone popup while the session lives (until `signal` aborts) and clears it unless the player turned that off. */
  watchBlockingModal?(signal: AbortSignal): Promise<void>;
  /** The world changed or was reloaded: popups handled before may be raised again. */
  resetBlockingModalMemory?(): void;
  /**
   * Read-only labour view for the run ledger. Observation only: nothing in the
   * growth policy consumes it, and an implementation that cannot answer leaves
   * the ledger's labour facts null rather than inferring them.
   */
  readLabor?(signal?: AbortSignal): Promise<unknown>;
  pause(): Promise<void>;
  /**
   * Let the world run again after a bounded observation window.
   *
   * The Bridge places no pause requirement on any of its write endpoints — the
   * pause this product takes for a mutation is its own consistency window, not
   * the game's. So the world is resumed as soon as that window closes, and the
   * Brain goes on observing, planning and deciding while the city keeps moving.
   */
  resume?(signal?: AbortSignal): Promise<void>;
  confirmPaused?(): Promise<boolean>;
  refreshActionableCandidates?(signal?: AbortSignal): Promise<unknown>;
  ensureGrowthOpportunity?(input: {
    developmentCapacity: LocalMayorState["developmentCapacity"];
    demand: LocalMayorState["demands"];
    preferredPolicy: UrbanDesignDevelopmentPolicy;
    growthDomain?: LocalMayorGrowthDomain;
    signal?: AbortSignal;
  }): Promise<{
    status: "available" | "blocked" | "unavailable";
    snapshot?: unknown;
    reason: string;
    outcome?: "opportunity_found" | "search_incomplete" | "search_exhausted" | "stale_spatial_context" | "technical_failure";
    recoveryLevel?: 0 | 1 | 2 | 3 | 4;
  }>;
  ensureUtilityCapacity?(input: {
    kind: import("./utility-recovery").UtilityRecoveryKind;
    expectedRevision: string | null;
    treasury: number | null;
    runwayMonths: number | null;
    signal: AbortSignal;
  }): Promise<import("./utility-recovery").UtilityRecoveryResult>;
  focusTarget?(target: import("./local-mayor/types").LocalMayorFocusTarget): Promise<boolean>;
  save(name: string): Promise<void>;
  emit?(event: "status" | "balance" | "tick", state: MayorSessionState): void;
  emitMayorCommentary?(line: import("./mayor-commentary").MayorCommentaryLine): void;
  now?(): Date;
  id?(): string;
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>;
}
