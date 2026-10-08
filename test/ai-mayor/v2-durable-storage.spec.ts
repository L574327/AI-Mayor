import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalStorePath,
  createCanonicalDurableStateStorage,
  discoverLegacyDurableStates,
  selectDurableStateMigration,
} from "@/main/services/ai-mayor/v2/durable-storage";

const state = (overrides: Record<string, unknown> = {}) =>
  ({
    schemaVersion: "ai-mayor-v2-durability/1",
    v2StateVersion: 1,
    journalPosition: 0,
    checkpoints: [],
    commands: [],
    projectState: {
      schemaVersion: "ai-mayor-v2-gate1-state/2",
      project: { id: "project-1" },
      tranche: { id: "tranche-1", stage: "PLANNED" },
    },
    active: {
      worldId: "world-1",
      loadedCheckpointId: "checkpoint-1",
      rollbackBoundaryId: "checkpoint-1",
      worldEpochId: "epoch-1",
      bridgeRuntimeEpoch: "runtime-1",
      generation: "generation-1",
    },
    ...overrides,
  }) as never;

const writeEnvelope = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ aiMayorV2DurableState: value }));
};

describe("AI Mayor canonical durable storage discovery", () => {
  let appDataPath: string;

  beforeEach(() => {
    appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mayor-storage-"));
  });

  afterEach(() => fs.rmSync(appDataPath, { recursive: true, force: true }));

  it("uses an explicit stable product path", () => {
    expect(canonicalStorePath(appDataPath)).toBe(path.join(appDataPath, "AI Mayor", "ai-mayor-v2.json"));
  });

  it("routes to a persisted execution branch while preserving the parent store", () => {
    const parentId = "a".repeat(40);
    const branchId = "b".repeat(40);
    const storage = createCanonicalDurableStateStorage(appDataPath);
    const parent = state({
      checkpoints: [{ worldId: "world-1", checkpointId: "checkpoint-old", durable: true, journalPosition: 3,
        saveMetadataAssetGuid: "meta-old", saveDataAssetGuid: "data-old" }],
      executionBranch: { branchId: parentId, parentBranchId: null, sourceCheckpointId: "checkpoint-1", sourceJournalCut: 0, loadEventId: null },
    });
    storage.save(parent as never);
    const child = state({
      projectState: { schemaVersion: "ai-mayor-v2-project-placeholder/1", status: "PLACEHOLDER" },
      executionBranch: { branchId, parentBranchId: parentId, sourceCheckpointId: "checkpoint-1", sourceJournalCut: 4, loadEventId: "load-event-1" },
    });
    storage.forkHistoricalBranch!({ branchId, parentBranchId: parentId, checkpointId: "checkpoint-1", journalCut: 4, loadEventId: "load-event-1", state: child as never });

    expect(storage.namespaceId).toContain(path.join("execution-branches", branchId));
    expect((storage.load() as any).executionBranch.branchId).toBe(branchId);
    const persistedParent = JSON.parse(fs.readFileSync(canonicalStorePath(appDataPath), "utf8")).aiMayorV2DurableState;
    expect(persistedParent.executionBranch.branchId).toBe(parentId);

    const restarted = createCanonicalDurableStateStorage(appDataPath);
    expect((restarted.load() as any).executionBranch.branchId).toBe(branchId);
    expect(restarted.resolveArchivedCheckpoint!({ worldId: "world-1", checkpointId: "checkpoint-old",
      saveMetadataAssetGuid: "meta-old", saveDataAssetGuid: "data-old" })).toMatchObject({ executionBranch: { branchId: parentId } });
  });

  it("discovers the verified product-profile ROAD_DELIVERED legacy state", () => {
    const roadState = state({
      journalPosition: 1,
      projectState: { schemaVersion: "ai-mayor-v2-gate1-state/2", project: { id: "project-1" }, tranche: { id: "tranche-1", stage: "ROAD_DELIVERED" } },
      commands: [{ record: { commandId: "c0c1dda6-e130-4f1e-b616-a0baf598ac93", status: "OBSERVED_MATCH" } }],
    });
    writeEnvelope(path.join(appDataPath, "AI Mayor", "config.json"), roadState);
    writeEnvelope(path.join(appDataPath, "Electron", "config.json"), state());

    const result = selectDurableStateMigration(appDataPath);
    expect(result.source).toBe("legacy");
    expect(result.sourcePath).toBe(path.join(appDataPath, "AI Mayor", "config.json"));
    expect((result.state as any).projectState.tranche.stage).toBe("ROAD_DELIVERED");
  });

  it("never overwrites a populated canonical state", () => {
    const canonical = state({ journalPosition: 4 });
    const legacy = state({ journalPosition: 9 });
    expect(selectDurableStateMigration(appDataPath, canonical)).toEqual({ source: "canonical", state: canonical });
    expect(legacy).toBeDefined();
  });

  it("fails closed for conflicting alternate legacy profiles", () => {
    writeEnvelope(path.join(appDataPath, "Electron", "config.json"), state());
    writeEnvelope(path.join(appDataPath, "AI Mayor", "__DEV__", "config.json"), state({ active: { ...state().active, worldId: "world-2" } }));
    expect(selectDurableStateMigration(appDataPath).source).toBe("blocked");
  });

  it("does not discover unrelated provider/settings data", () => {
    writeEnvelope(path.join(appDataPath, "AI Mayor", "config.json"), { providers: [] });
    expect(discoverLegacyDurableStates(appDataPath)).toHaveLength(0);
  });
});
