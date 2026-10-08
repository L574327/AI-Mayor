/**
 * Read-only probe: what a production activation of the CURRENT live clean world
 * does to the durable project authority.
 *
 * Phase 7P attempt 4 needs the certified production path
 * (`createV2FoundationPorts().activateDurableWorld()` -> `V2DurabilityCoordinator.activate()`)
 * to keep the admitted project so `repairFacilityAccessRoad` can mint the next
 * bounded amendment. Rolling the world back is a statement about a world effect,
 * not about the project that authored it, and this probe answers, offline and
 * without any world write, which world transition the loaded save produces, what
 * survives it, and that the rolled-back attempt is neither replayed nor replayable.
 *
 * Read-only by construction: it never talks to the Bridge, never spawns the MCP
 * server, and never writes the canonical store -- the activation runs against a
 * memory copy seeded from the real state, and the real file is compared before
 * and after (`REAL_STORE_UNTOUCHED`). No native mutation, no authorization, no
 * save.
 *
 * Usage (from the repository root):
 *   npx tsx scripts/ai-mayor-water-phase7p-activation-rollback-probe.ts
 *   npx tsx scripts/ai-mayor-water-phase7p-activation-rollback-probe.ts --generation <generation> --json
 */
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import {
  V2DurabilityCoordinator,
  createMemoryDurableStateStorage,
  parseNativeWorldIdentity,
} from "../src/main/services/ai-mayor/v2/durability";
import {
  facilityAccessRoadRepairAttemptIndexFromLineage,
  facilityAccessRoadRepairLineage,
  nextFacilityAccessRoadRepairAttemptIndex,
} from "../src/main/services/ai-mayor/v2/facility-access-road";
import { FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON } from "../src/main/services/ai-mayor/v2/utility-budget";

/** The live clean checkpoint this phase is certified against (Phase 7P). */
const CLEAN_SAVE = {
  checkpointId: "save:7d1828be91228633382948bf242d58b3:e4b775c9f84227adfc5696d3db19da2a",
  loadAssetGuid: "7d1828be91228633382948bf242d58b3",
  saveDataAssetGuid: "e4b775c9f84227adfc5696d3db19da2a",
  nativeSessionGuid: "cd0d8ea80e624df4abd692fc89df5cc4",
};
/** Minted by the current load; overridable because it changes on every load. */
const LIVE_GENERATION = "ee34ba9e3b1d42fc888dbdb87fde9af5";

const record = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : {};
const innerState = (value: unknown) => record(record(value).aiMayorV2DurableState ?? value);

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

/**
 * The ordinal the production repair path would derive, computed the way
 * `repairFacilityAccessRoad` computes it: one past the highest attempt any
 * durable record of this lineage carries, amendments and candidate ledger alike.
 */
function derivedNextAttempt(store: Record<string, any>): number | string {
  const projectId = store.projectState?.project?.id ?? null;
  const water = store.projectState?.tranche?.utilityExecution?.utilities?.water;
  const indices = [
    ...(store.utilityBudgetAmendments ?? [])
      .filter((entry: any) => entry.projectId === projectId &&
        entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON)
      .map((entry: any) => entry.repairAttemptIndex ?? facilityAccessRoadRepairAttemptIndexFromLineage(entry.repairLineage) ?? 0),
    ...((water?.candidateLedger ?? []) as any[]).map((candidate) => candidate.repairAttemptIndex ?? 0),
  ];
  try {
    return nextFacilityAccessRoadRepairAttemptIndex(indices);
  } catch (error) {
    return `THROW:${(error as Error).message}`;
  }
}

const planRevisionOf = (projectState: any): string | null =>
  projectState?.tranche?.utilityExecution?.utilities?.water?.connectionObjective?.approvedPlanRevision ?? null;

const repairAmendment = (store: Record<string, any>): any =>
  (store.utilityBudgetAmendments ?? []).find((entry: any) =>
    entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON &&
    typeof entry.repairLineage === "string");

const repairAmendmentIndex = (entry: any): number | null =>
  entry === undefined ? null : entry.repairAttemptIndex ?? facilityAccessRoadRepairAttemptIndexFromLineage(entry.repairLineage);

async function main() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA_UNAVAILABLE");
  const generation = flag("--generation") ?? LIVE_GENERATION;
  const asJson = process.argv.includes("--json");
  const load = () => createCanonicalDurableStateStorage(appData).load();
  const real = load();
  const store = innerState(real);

  // The live world as the Bridge reports it: the same save identity, a runtime
  // identity minted by this very load.
  const liveWorld = {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    world: {
      identityStatus: "AVAILABLE",
      worldReady: true,
      worldId: store.active.worldId,
      nativeSessionGuid: CLEAN_SAVE.nativeSessionGuid,
      loadPurpose: "LoadGame",
      loadAssetGuid: CLEAN_SAVE.loadAssetGuid,
      saveDataAssetGuid: CLEAN_SAVE.saveDataAssetGuid,
      checkpointId: CLEAN_SAVE.checkpointId,
      bridgeRuntimeEpoch: "3da5fcacbac944d7b70157857cdc47a0",
      generation,
      generationSequence: 2,
      generationOrigin: "LOAD_COMPLETED",
    },
  };

  const memory = createMemoryDurableStateStorage(real);
  const coordinator = new V2DurabilityCoordinator(memory);
  const projectBefore = coordinator.projectState() as Record<string, any> | null;
  const beforeStore = store;
  const beforeAmendment = repairAmendment(beforeStore);
  const beforeAmendmentJson = beforeAmendment === undefined ? null : JSON.stringify(beforeAmendment);
  const attemptCommandId = "f666e0e8-6110-4f8a-a042-a9d7bc20cfbf";
  const beforeCommandJson =
    JSON.stringify((beforeStore.commands ?? []).find((entry: any) => entry.record?.commandId === attemptCommandId) ?? null);
  const derivedNextBefore = derivedNextAttempt(beforeStore);

  const activation = coordinator.activate(liveWorld);
  const projectAfter = coordinator.projectState() as Record<string, any> | null;
  const afterStore = innerState(memory.value());
  const afterAmendment = repairAmendment(afterStore);
  const afterCommand = (afterStore.commands ?? []).find((entry: any) => entry.record?.commandId === attemptCommandId) ?? null;
  const derivedNextAfter = derivedNextAttempt(afterStore);
  const amendmentState = (beforeAmendment as any)?.status ?? null;
  const authorizationConsumed =
    (beforeAmendment as any)?.executionUseStatus === "CONSUMED" && amendmentState === "CONSUMED";
  const reconciliationRequired = coordinator
    .reconciliationRequired()
    .map((entry) => entry.record.commandId);
  const anyActiveAmendment = (afterStore.utilityBudgetAmendments ?? []).filter(
    (entry: any) => entry.reason === FACILITY_ACCESS_ROAD_REPAIR_BUDGET_AMENDMENT_REASON && entry.status === "ACTIVE",
  ).length;

  const identity = parseNativeWorldIdentity(liveWorld);
  const boundary = ((store.checkpoints ?? []) as any[]).find(
    (checkpoint) => checkpoint.checkpointId === identity.checkpointId,
  );
  const discardedCommands = ((store.commands ?? []) as any[])
    .filter(
      (entry) =>
        boundary?.durable === true &&
        entry.worldId === identity.worldId &&
        entry.outcome !== "FAILED" &&
        entry.baseCheckpointId === boundary.checkpointId &&
        entry.worldEpochId !== identity.worldEpochId &&
        entry.position > boundary.journalPosition &&
        !((store.checkpoints ?? []) as any[]).some(
          (other) =>
            other.worldId === entry.worldId &&
            other.checkpointId !== boundary.checkpointId &&
            other.journalPosition >= entry.position,
        ),
    )
    .map((entry) => ({
      position: entry.position,
      outcome: entry.outcome,
      commandId: record(entry.record).commandId ?? null,
      actionFamily: record(entry.record).actionFamily ?? null,
      exactInput: record(record(entry.record).authorizedScope).exactInput ?? null,
      recordedWorldEpochId: entry.worldEpochId,
      rolledBackClassifiable: coordinator.canClassifyCommandRolledBack(entry),
    }));

  const projectStatePreserved =
    JSON.stringify(projectAfter) === JSON.stringify(projectBefore) &&
    projectAfter !== null &&
    (projectAfter as any).schemaVersion === "ai-mayor-v2-gate1-state/2";
  const planRevisionPreserved = planRevisionOf(projectAfter) !== null && planRevisionOf(projectAfter) === planRevisionOf(projectBefore);
  const repairLineagePreserved =
    afterAmendment !== undefined && JSON.stringify(afterAmendment) === beforeAmendmentJson;
  const attemptImmutable = afterCommand !== null && JSON.stringify(afterCommand) === beforeCommandJson && repairLineagePreserved;
  const journalUnmoved = afterStore.journalPosition === beforeStore.journalPosition &&
    (afterStore.commands ?? []).length === (beforeStore.commands ?? []).length &&
    (afterStore.utilityBudgetAmendments ?? []).length === (beforeStore.utilityBudgetAmendments ?? []).length;
  const replayable = reconciliationRequired.includes(attemptCommandId) || anyActiveAmendment > 0;

  const verdict = {
    REAL_STORE_UNTOUCHED: JSON.stringify(load()) === JSON.stringify(real) ? "YES" : "NO",
    ACTIVATION_KIND: activation.kind,
    ACTIVATION_STATUS: activation.status,
    ACTIVATION_BLOCKED_REASON: activation.blockedReason ?? null,
    PROJECT_AUTHORITY_PRESERVED: projectStatePreserved ? "YES" : "NO",
    PLAN_REVISION_PRESERVED: planRevisionPreserved ? "YES" : "NO",
    REPAIR_LINEAGE_PRESERVED: repairLineagePreserved ? "YES" : "NO",
    ATTEMPT_INDEX_IN_LINEAGE: repairAmendmentIndex(beforeAmendment),
    ATTEMPT_3_IMMUTABLE: attemptImmutable ? "YES" : "NO",
    ATTEMPT_3_AUTHORIZATION: authorizationConsumed ? "CONSUMED" : String(amendmentState),
    ATTEMPT_3_REPLAYABLE: replayable ? "YES" : "NO",
    ACTIVATION_WROTE_NOTHING: journalUnmoved ? "YES" : "NO",
    NEXT_REPAIR_ATTEMPT: derivedNextAfter,
  };

  const report = {
    probe: "ai-mayor-water-phase7p-activation-rollback",
    readOnly: true,
    liveWorldEpochId: identity.worldEpochId,
    liveCheckpointId: identity.checkpointId,
    journalPosition: store.journalPosition,
    boundary: boundary
      ? {
          checkpointId: boundary.checkpointId,
          journalPosition: boundary.journalPosition,
          durable: boundary.durable,
          purpose: boundary.purpose ?? null,
          projectState: boundary.projectState ?? null,
        }
      : null,
    before: {
      projectStatus: projectBefore?.project?.status ?? null,
      trancheStage: projectBefore?.tranche?.stage ?? null,
      planRevision: planRevisionOf(projectBefore),
      derivedNextAttempt: derivedNextBefore,
    },
    activation: {
      kind: activation.kind,
      status: activation.status,
      blockedReason: activation.blockedReason ?? null,
      isExecutionDurablyActivated: coordinator.isExecutionDurablyActivated(activation),
    },
    commandsDiscardedByBoundary: discardedCommands,
    after: {
      projectStatus: projectAfter?.project?.status ?? null,
      projectId: projectAfter?.project?.id ?? null,
      planRevision: planRevisionOf(projectAfter),
      journalPosition: afterStore.journalPosition,
      derivedNextAttempt: derivedNextAfter,
      reconciliationRequired: reconciliationRequired,
      activeRepairAuthorizations: anyActiveAmendment,
      exampleLineageForAttempt4: facilityAccessRoadRepairLineage({
        projectId: (projectAfter as any)?.project?.id ?? "NO_PROJECT",
        planRevision: planRevisionOf(projectAfter) ?? "NO_PLAN_REVISION",
        attemptIndex: 4,
      }),
    },
    verdict,
    realStoreUntouched: JSON.stringify(load()) === JSON.stringify(real),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(verdict)) {
    console.log(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  console.log(`commandsDiscardedByBoundary=${JSON.stringify(report.commandsDiscardedByBoundary)}`);
  console.log(`before=${JSON.stringify(report.before)}`);
  console.log(`after=${JSON.stringify({ ...report.after, projectState: undefined })}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});