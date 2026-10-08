/**
 * Water Phase 7: verify the explicitly loaded pre-attempt-2 save and append an
 * authoritative current-world absence observation using the production V2
 * durability coordinator. This script never submits a native action or saves
 * the CS2 world.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { V2DurabilityCoordinator, type V2DurableState, type V2DurableStateStorage } from "../src/main/services/ai-mayor/v2/durability";

const bridge = process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642";
const storePath = process.env.AI_MAYOR_LIVE_STORE ?? path.join(os.homedir(), "AppData", "Roaming", "5ire", "ai-mayor-v2.json");
const saveMetadata = "7d1828be91228633382948bf242d58b3";
const saveData = "e4b775c9f84227adfc5696d3db19da2a";
const checkpointId = `save:${saveMetadata}:${saveData}`;
const attempt2Id = "6a46f46a-9f16-4d51-93a9-4545e94555ca";
const expectedPump = { prefab: "GroundwaterPumpingStation01", x: -226.909, z: 1283.57007 };
const at = async (endpoint: string) => {
  const response = await fetch(`${bridge}${endpoint}`);
  const value = await response.json() as Record<string, any>;
  if (!response.ok || value.error) throw new Error(`BRIDGE_READ_FAILED:${endpoint}:${JSON.stringify(value)}`);
  return value;
};
const hash = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

async function main() {
  const originalBytes = fs.readFileSync(storePath);
  const envelope = JSON.parse(originalBytes.toString("utf8")) as Record<string, unknown>;
  const key = "aiMayorV2DurableState";
  const stored = envelope[key] as V2DurableState | undefined;
  if (!stored) throw new Error("V2_DURABLE_STATE_MISSING");
  const beforeSnapshot = new V2DurabilityCoordinator({ load: () => stored, save: () => undefined });
  const stateBefore = beforeSnapshot.snapshot();

  const [world, saves, buildings, roads, pipes] = await Promise.all([
    at("/state"), at("/game/saves"), at("/city/buildings?query=GroundwaterPumpingStation01&limit=500"),
    at("/city/roads?query=Small%20Road&limit=500"), at("/city/roads?query=Small%20Water%20Pipe&limit=500"),
  ]);
  const nativeWorld = world.world ?? {};
  const loadedSave = (saves.saves ?? []).find((save: Record<string, unknown>) => save.checkpointId === checkpointId && save.isLoadedSave === true);
  if (nativeWorld.checkpointId !== checkpointId || !loadedSave) throw new Error("ROLLBACK_CHECKPOINT_MISMATCH");
  if (nativeWorld.generation === "f68c6fa6c4854ab9a9dd5693184a6297") throw new Error("ROLLBACK_GENERATION_NOT_REFRESHED");
  if (world.simulation?.paused !== true) throw new Error("WORLD_NOT_PAUSED");
  if (nativeWorld.nativeOperationBusy !== false || nativeWorld.nativeOperationStage !== "Idle") throw new Error("BRIDGE_NOT_IDLE");
  if (buildings.totalMatches !== 1 || buildings.buildings?.length !== 1) throw new Error("PUMP_READBACK_NOT_UNIQUE_COMPLETE");
  const pump = buildings.buildings[0];
  if (pump.prefab !== expectedPump.prefab || Math.hypot(pump.position.x - expectedPump.x, pump.position.z - expectedPump.z) > 0.05) {
    throw new Error("PUMP_CHECKPOINT_CONTENT_MISMATCH");
  }
  if (roads.totalMatches !== roads.roads?.length || pipes.totalMatches !== pipes.roads?.length) throw new Error("NETWORK_LIST_INCOMPLETE");
  if (roads.roads.length !== 2 || pipes.roads.length !== 2) throw new Error("CHECKPOINT_NETWORK_CARDINALITY_MISMATCH");

  const [access, connector] = await Promise.all([
    at(`/entity/building-access?index=${pump.entity.index}&version=${pump.entity.version}`),
    at(`/entity/utility-connectors?index=${pump.entity.index}&version=${pump.entity.version}`),
  ]);
  if (access.roadAttachment?.roadEdge !== null) throw new Error("PUMP_ROAD_ATTACHMENT_NOT_NULL_AT_CHECKPOINT");
  const pumpConnector = connector.connectors?.find((item: Record<string, any>) => item.type === "waterPipe");
  if (!pumpConnector?.node || pumpConnector.node.index !== 193836) throw new Error("WATER_CONNECTOR_REBIND_MISMATCH");
  const oldAttemptCourses = [
    { x1: -193.801147, z1: 1297.19031, x2: -185.909, z2: 1327.57007 },
    { x1: -185.909, z1: 1327.57007, x2: -226.909, z2: 1315.77007 },
  ];
  const distance = (a: Record<string, number>, b: Record<string, number>) => Math.hypot(a.x - b.x, a.z - b.z);
  const matchesCourse = (road: Record<string, any>, course: Record<string, number>) =>
    Math.min(
      Math.max(distance(road.start, { x: course.x1, z: course.z1 }), distance(road.end, { x: course.x2, z: course.z2 })),
      Math.max(distance(road.start, { x: course.x2, z: course.z2 }), distance(road.end, { x: course.x1, z: course.z1 })),
    ) <= 1;
  if (roads.roads.some((road: Record<string, any>) => oldAttemptCourses.some((course) => matchesCourse(road, course)))) {
    throw new Error("ATTEMPT2_PARTIAL_ROAD_EFFECT_STILL_PRESENT");
  }
  if (!pipes.roads.some((road: Record<string, any>) => road.entity.index === 62146) || !pipes.roads.some((road: Record<string, any>) => road.entity.index === 62147)) {
    throw new Error("WATER_PIPE_TOPOLOGY_NOT_INTACT");
  }
  if (!roads.roads.some((road: Record<string, any>) => road.entity.index === 61185) || !roads.roads.some((road: Record<string, any>) => road.entity.index === 61186)) {
    throw new Error("FIRST_ACCESS_ROAD_NOT_INTACT");
  }

  const attempt2 = stateBefore.commands.find((entry) => entry.record.commandId === attempt2Id);
  if (!attempt2 || attempt2.position !== 11 || attempt2.outcome !== "FAILED" || attempt2.record.status !== "REJECTED") {
    throw new Error("ATTEMPT2_HISTORICAL_COMMAND_MISMATCH");
  }
  const cut = stateBefore.checkpoints.find((item) => item.checkpointId === checkpointId);
  if (!cut || cut.journalPosition !== 10 || attempt2.baseCheckpointId !== checkpointId) throw new Error("JOURNAL_CUT_MISMATCH");
  const attemptAuth = stateBefore.utilityBudgetAmendments?.filter((entry) =>
    entry.reason === "FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT" && entry.courseFingerprint?.includes('"x1":-193.801147'),
  ) ?? [];
  if (attemptAuth.length !== 1 || attemptAuth[0].status !== "CONSUMED" || attemptAuth[0].executionUseStatus !== "CONSUMED") {
    throw new Error("ATTEMPT2_AUTHORIZATION_HISTORY_MISMATCH");
  }

  const backupPath = `${storePath}.water-phase7-rollback-before-observation`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(storePath, backupPath);
  const storage: V2DurableStateStorage = {
    load: () => envelope[key] as V2DurableState,
    save: (state) => {
      envelope[key] = state;
      fs.writeFileSync(storePath, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
    },
    namespaceId: storePath,
  };
  const coordinator = new V2DurabilityCoordinator(storage);
  const activation = coordinator.activate(world);
  if (activation.kind !== "SAME_SAVE_RELOAD" && activation.kind !== "ROLLBACK") throw new Error(`UNEXPECTED_WORLD_TRANSITION:${activation.kind}`);
  const currentAttempt = coordinator.snapshot().commands.find((entry) => entry.record.commandId === attempt2Id);
  if (!currentAttempt || !coordinator.canClassifyCommandRolledBack(currentAttempt)) throw new Error("ROLLBACK_CLASSIFICATION_NOT_PROVEN");
  if (coordinator.reconciliationRequired().some((entry) => entry.record.commandId === attempt2Id)) throw new Error("ATTEMPT2_WOULD_AUTO_REPLAY");

  const observation = coordinator.recordCurrentWorldObservation({
    commandId: attempt2Id,
    currentWorldEffectPresent: false,
    currentWorldObjectiveSatisfied: false,
    evidence: JSON.stringify({
      classification: "EFFECT_ABSENT_DUE_TO_USER_ROLLBACK",
      checkpointId,
      loadedGeneration: nativeWorld.generation,
      checkpointJournalPosition: cut.journalPosition,
      commandPosition: attempt2.position,
      currentPump: pump,
      currentConnector: pumpConnector.node,
      exactPartialSegmentCourse: oldAttemptCourses[0],
      exactAuthorizedTerminalCourse: oldAttemptCourses[1],
      completeCurrentSmallRoadList: roads.roads,
      waterPipeEdges: pipes.roads.map((edge: Record<string, unknown>) => edge.entity),
      roadAttachment: access.roadAttachment,
    }),
  });
  const after = coordinator.snapshot();
  if (after.commands.find((entry) => entry.record.commandId === attempt2Id)?.record.status !== "REJECTED") throw new Error("HISTORICAL_COMMAND_WAS_REWRITTEN");
  if (coordinator.commandJournal.get(attempt2Id)?.status !== "REJECTED") throw new Error("ATTEMPT2_HISTORY_CHANGED");
  if (hash(fs.readFileSync(backupPath)) !== hash(originalBytes)) throw new Error("DURABLE_BACKUP_MISMATCH");

  const report = {
    checkpointMatch: true, checkpointId, displayName: loadedSave.displayName, generation: nativeWorld.generation,
    journalCut: cut.journalPosition, activation: { kind: activation.kind, status: activation.status },
    rollbackClassification: coordinator.canClassifyCommandRolledBack(currentAttempt),
    attempt2AutoReplayRisk: coordinator.reconciliationRequired().some((entry) => entry.record.commandId === attempt2Id),
    attempt2: { commandId: attempt2Id, position: attempt2.position, historicalStatus: "REJECTED", authorizationStatus: attemptAuth[0].status, executionUseStatus: attemptAuth[0].executionUseStatus },
    currentWorldObservation: observation, pump, roadAttachment: access.roadAttachment, nativeRoadFrontage: access.nativeRoadFrontage,
    connector: pumpConnector, smallRoads: roads.roads, waterPipes: pipes.roads,
    nativeConstructionMutation: 0, forcedSave: 0, durableBackupPath: backupPath,
  };
  const reportPath = "docs/ai-mayor/evidence/water-phase7-rollback-reconciliation-2026-09-23.json";
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
