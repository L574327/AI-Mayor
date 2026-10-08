import type { SpatialEntityRef, SpatialPoint2 } from "../spatial/types";
import type { NativeWorldIdentity } from "./durability";
import type { V2CommandDurableLineage, V2CommandJournal } from "./foundation";
import type { Gate1State } from "./gate1";

/**
 * The road the Gate 1 state machine actually delivered, read back from durable
 * evidence.
 *
 * Authority chain — every link is a persisted production record, never a fresh
 * observation:
 *
 * ```text
 * state.tasks[ROAD_CONNECTION].terminalOutcomeId
 *   -> state.journal[...].commandId
 *   -> durability.commandJournal.get(commandId)
 *   -> observationEvidence[phase === "RECONCILIATION"].details
 *        .matchedEdges                      // the authoritative matcher's certified match
 *        .observedEnvelope.worldGeneration  // observation metadata only
 *   -> authorizedScope.owner                 // must be this ROAD_CONNECTION task
 *   -> authorizedScope.exactInput            // the exact ROAD input that was authorized
 *   -> commandJournal.durableLineage(commandId)
 *        durable checkpoint ancestry + survival; never a generation comparison
 * ```
 *
 * `matchedEdges` is produced by the authoritative RoadEffect matcher at the
 * moment `OBSERVED_MATCH` was certified and travels with the durable command
 * journal (`road-effect.ts` sets it on MATCH, `road-kernel.ts` persists the
 * whole report as `CommandObservationEvidence.details`). It is therefore not a
 * world scan, not a geometric replay, not a nearest-road search, and not a
 * hardcoded entity — and it survives reload because the journal is durable.
 */
export interface CertifiedRoadDelivery {
  status: "CERTIFIED";
  /** The durable ROAD command whose terminal outcome delivered this road. */
  commandId: string;
  /** The road prefab exactly as it was authorized and built. */
  prefab: string;
  /** Every road entity the authoritative matcher certified at reconciliation time. */
  refs: readonly SpatialEntityRef[];
  /**
   * The delivered road this tranche's utility service entry binds to. Its
   * position is the road's own committed start endpoint — the end that was
   * attached to the existing network — which is the `endpointRole: "start"`
   * contract the first-placement admission and the connection preflight share.
   */
  target: {
    entity: SpatialEntityRef;
    position: SpatialPoint2;
    prefab: string;
    /**
     * The same command's committed far endpoint (`x2, z2`). Immutable geometry
     * from the same `exactInput`, and the key that keeps the road reacquirable
     * by geometry once the game has split the delivered course into several
     * edges meeting at the contact node. Absent only for a malformed input that
     * carries no far end at all.
     */
    farEnd?: SpatialPoint2;
  };
  /**
   * The durable checkpoint ancestry proving the active lineage still contains
   * this command. This is the authority gate: it survives a restart of the same
   * save and a normal periodic save, and it is revoked by a rollback behind the
   * command, a sibling save, a different world, or unprovable lineage.
   */
  lineage: V2CommandDurableLineage;
  /**
   * Observation metadata only. The native generation is load-scoped and changes
   * on every reload/re-attach, so it can never be the equality gate for durable
   * authority — it is recorded here so a live proof can compare it, not so a
   * decision can depend on it.
   */
  observedWorldGeneration: string;
}

/** Why no certified road could be read. Every reason fails the placement closed. */
export type CertifiedRoadDeliveryUnavailableReason =
  | "ROAD_CONNECTION_TASK_NOT_FOUND"
  | "ROAD_CONNECTION_LINEAGE_MISMATCH"
  | "ROAD_CONNECTION_TASK_NOT_SUCCEEDED"
  | "ROAD_TERMINAL_OUTCOME_MISSING"
  | "ROAD_TERMINAL_OUTCOME_NOT_IN_JOURNAL"
  | "ROAD_TERMINAL_OUTCOME_TASK_MISMATCH"
  | "ROAD_TERMINAL_OUTCOME_NOT_DELIVERED"
  | "ROAD_TERMINAL_OUTCOME_COMMAND_MISSING"
  | "ROAD_DURABLE_COMMAND_MISSING"
  | "ROAD_DURABLE_COMMAND_IDENTITY_MISMATCH"
  | "ROAD_DURABLE_COMMAND_NOT_ROAD"
  | "ROAD_DURABLE_COMMAND_NOT_CERTIFIED_MATCH"
  | "ROAD_COMMAND_OWNER_MISSING"
  | "ROAD_COMMAND_OWNER_TYPE_MISMATCH"
  | "ROAD_COMMAND_OWNER_TASK_MISMATCH"
  | "ROAD_COMMAND_NOT_IN_CURRENT_DURABLE_LINEAGE"
  | "ROAD_COMMAND_DURABLE_WORLD_MISMATCH"
  | "ROAD_RECONCILIATION_EVIDENCE_MISSING"
  | "ROAD_RECONCILIATION_NOT_MATCH"
  | "ROAD_RECONCILIATION_GENERATION_UNKNOWN"
  | "ROAD_RECONCILIATION_MATCHED_EDGES_EMPTY"
  | "ROAD_RECONCILIATION_MATCHED_EDGE_INVALID"
  | "ROAD_RECONCILIATION_MATCHED_EDGE_AMBIGUOUS"
  | "ROAD_AUTHORIZED_INPUT_MALFORMED";

export interface CertifiedRoadDeliveryUnavailable {
  status: "UNAVAILABLE";
  reason: CertifiedRoadDeliveryUnavailableReason;
}

export type CertifiedRoadDeliveryResult = CertifiedRoadDelivery | CertifiedRoadDeliveryUnavailable;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const entityRef = (value: unknown): SpatialEntityRef | null => {
  const item = record(value);
  return Number.isInteger(item.index) && Number.isInteger(item.version)
    ? { index: Number(item.index), version: Number(item.version) }
    : null;
};

const sameRef = (left: SpatialEntityRef, right: SpatialEntityRef) =>
  left.index === right.index && left.version === right.version;

const unavailable = (reason: CertifiedRoadDeliveryUnavailableReason): CertifiedRoadDeliveryUnavailable => ({
  status: "UNAVAILABLE",
  reason,
});

/**
 * Read the tranche's delivered access road from its root ROAD_CONNECTION task
 * and durable command journal record. Utility service-road children may extend
 * the graph, but they do not replace the road the tranche was admitted against.
 *
 * Fails closed on every gap: a missing or non-terminal-outcome task, a tranche
 * lineage mismatch, a command that is not the certified `OBSERVED_MATCH` ROAD
 * command, a command whose durable owner is not this task, a command outside
 * the current durable world/checkpoint lineage, missing or non-matching
 * reconciliation evidence, an empty or ambiguous matched-edge set, or a
 * malformed authorized input. It never falls back to a search, a second
 * command, or a guess.
 */
export function certifyDeliveredRoad(input: {
  state: Gate1State;
  world: NativeWorldIdentity;
  journal: V2CommandJournal;
}): CertifiedRoadDeliveryResult {
  const currentTaskId = input.state.tranche.currentTaskIds?.ROAD_CONNECTION;
  let task = currentTaskId
    ? input.state.tasks.find((candidate) => candidate.id === currentTaskId && candidate.kind === "ROAD_CONNECTION")
    : input.state.tasks.find((candidate) => candidate.kind === "ROAD_CONNECTION");
  if (!task) return unavailable("ROAD_CONNECTION_TASK_NOT_FOUND");
  // A bounded utility service-road replan can leave the next child pending or
  // natively rejected while the previous segment remains the latest delivered
  // Road authority. Keep that exact prior task as the certified target until a
  // replacement task has its own authoritative delivery.
  const visitedTaskIds = new Set<string>();
  for (let depth = 0; task.utilityRoadParentTaskId; depth += 1) {
    if (depth >= input.state.tasks.length || visitedTaskIds.has(task.id)) return unavailable("ROAD_TASK_PARENT_CHAIN_INVALID");
    visitedTaskIds.add(task.id);
    const parent = input.state.tasks.find((candidate) =>
      candidate.id === task!.utilityRoadParentTaskId && candidate.kind === "ROAD_CONNECTION" &&
      candidate.trancheId === task!.trancheId);
    if (!parent) break;
    task = parent;
  }
  // Only the current tranche's ROAD_CONNECTION lineage may authorize anything.
  if (task.trancheId !== input.state.tranche.id) return unavailable("ROAD_CONNECTION_LINEAGE_MISMATCH");
  if (task.status !== "SUCCEEDED") return unavailable("ROAD_CONNECTION_TASK_NOT_SUCCEEDED");
  const terminalOutcomeId = task.terminalOutcomeId;
  if (!terminalOutcomeId) return unavailable("ROAD_TERMINAL_OUTCOME_MISSING");

  const outcome = input.state.journal.find((entry) => entry.id === terminalOutcomeId);
  if (!outcome) return unavailable("ROAD_TERMINAL_OUTCOME_NOT_IN_JOURNAL");
  if (outcome.taskId !== task.id) return unavailable("ROAD_TERMINAL_OUTCOME_TASK_MISMATCH");
  if (outcome.execution !== "DELIVERED") return unavailable("ROAD_TERMINAL_OUTCOME_NOT_DELIVERED");
  const commandId = outcome.commandId;
  if (!commandId) return unavailable("ROAD_TERMINAL_OUTCOME_COMMAND_MISSING");

  const command = input.journal.get(commandId);
  if (!command) return unavailable("ROAD_DURABLE_COMMAND_MISSING");
  if (command.commandId !== commandId) return unavailable("ROAD_DURABLE_COMMAND_IDENTITY_MISMATCH");
  if (command.actionFamily !== "ROAD") return unavailable("ROAD_DURABLE_COMMAND_NOT_ROAD");
  if (command.status !== "OBSERVED_MATCH" || command.reconciliationStatus !== "MATCH") {
    return unavailable("ROAD_DURABLE_COMMAND_NOT_CERTIFIED_MATCH");
  }

  // Formal ownership. The road must be the one the *current* ROAD_CONNECTION
  // task was admitted to build; a command that merely matches the geometry, or
  // that belongs to a previous task or tranche, is not this task's delivery.
  // Never fall back to another command.
  const owner = record(record(command.authorizedScope).owner);
  const ownerType = owner.ownerType;
  const ownerId = owner.ownerId;
  if (typeof ownerType !== "string" || typeof ownerId !== "string" || ownerId.trim().length === 0) {
    return unavailable("ROAD_COMMAND_OWNER_MISSING");
  }
  if (ownerType !== "TASK") return unavailable("ROAD_COMMAND_OWNER_TYPE_MISMATCH");
  if (ownerId !== task.id) return unavailable("ROAD_COMMAND_OWNER_TASK_MISMATCH");

  // Durable lineage. The native generation is load-scoped and changes on every
  // reload/re-attach, so it cannot gate restart-safe authority. The command's
  // persisted world id and base checkpoint can: they descend from the
  // durability-activated world and the checkpoint boundary the command was
  // recorded against, so the same save reproduces them after a restart.
  const lineage = input.journal.durableLineage(commandId);
  if (!lineage) return unavailable("ROAD_COMMAND_NOT_IN_CURRENT_DURABLE_LINEAGE");
  if (lineage.worldId !== input.world.worldId) return unavailable("ROAD_COMMAND_DURABLE_WORLD_MISMATCH");

  // Reconciliation only appends and a MATCH is terminal, so the latest
  // reconciliation entry is the certification. Duplicate reconciliation cannot
  // produce a conflicting ref set.
  const evidence = [...command.observationEvidence].reverse().find((entry) => entry.phase === "RECONCILIATION");
  if (!evidence) return unavailable("ROAD_RECONCILIATION_EVIDENCE_MISSING");
  const details = record(evidence.details);
  if (details.matcherResult !== "MATCH") return unavailable("ROAD_RECONCILIATION_NOT_MATCH");

  // Observation metadata. Required to be present so the evidence is
  // well-formed, but never compared for equality against the current world
  // generation: that is the load-scoped field this gate replaced.
  const observedWorldGeneration = record(details.observedEnvelope).worldGeneration;
  if (typeof observedWorldGeneration !== "string" || observedWorldGeneration.trim().length === 0) {
    return unavailable("ROAD_RECONCILIATION_GENERATION_UNKNOWN");
  }

  const rawEdges = details.matchedEdges;
  if (!Array.isArray(rawEdges) || rawEdges.length === 0) {
    return unavailable("ROAD_RECONCILIATION_MATCHED_EDGES_EMPTY");
  }
  const refs: SpatialEntityRef[] = [];
  for (const raw of rawEdges) {
    const ref = entityRef(raw);
    if (!ref) return unavailable("ROAD_RECONCILIATION_MATCHED_EDGE_INVALID");
    if (!refs.some((candidate) => sameRef(candidate, ref))) refs.push(ref);
  }
  // Which of several matched edges is *the* service entry is not derivable from
  // durable evidence alone. Refuse rather than pick.
  if (refs.length !== 1) return unavailable("ROAD_RECONCILIATION_MATCHED_EDGE_AMBIGUOUS");

  const authorizedScope = record(command.authorizedScope);
  if (authorizedScope.actionFamily !== "ROAD" || typeof authorizedScope.exactInput !== "string") {
    return unavailable("ROAD_AUTHORIZED_INPUT_MALFORMED");
  }
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(authorizedScope.exactInput);
  } catch {
    return unavailable("ROAD_AUTHORIZED_INPUT_MALFORMED");
  }
  const geometry = record(parsedInput);
  const prefab = geometry.prefab;
  // The service entry is the road's committed start endpoint, matching the
  // `endpointRole: "start"` contract used by the placement admission and by
  // `reacquirePreflightTargetRoad`.
  if (typeof prefab !== "string" || prefab.trim().length === 0 || !finite(geometry.x1) || !finite(geometry.z1)) {
    return unavailable("ROAD_AUTHORIZED_INPUT_MALFORMED");
  }

  // The far endpoint travels with the target so the road can still be reacquired
  // after a reload splits the delivered course. A command whose input carries no
  // finite far end simply has none: the reacquisition then keys on the contact
  // and the prefab alone and refuses when that is not unique.
  const farEnd = finite(geometry.x2) && finite(geometry.z2)
    ? { x: geometry.x2, z: geometry.z2 }
    : undefined;

  return {
    status: "CERTIFIED",
    commandId,
    prefab,
    refs,
    target: {
      entity: refs[0],
      position: { x: geometry.x1, z: geometry.z1 },
      prefab,
      ...(farEnd ? { farEnd } : {}),
    },
    lineage,
    observedWorldGeneration,
  };
}
