import fs from "node:fs";
import path from "node:path";
import Store from "electron-store";
import type { V2DurableState } from "./durability";

export const AI_MAYOR_CANONICAL_PROFILE = "AI Mayor";
export const AI_MAYOR_CANONICAL_STORE_NAME = "ai-mayor-v2";
export const AI_MAYOR_STATE_KEY = "aiMayorV2DurableState";
const MAX_EXECUTION_BRANCHES = 64;

type StateEnvelope = { [AI_MAYOR_STATE_KEY]?: unknown };

export interface DurableStateCandidate {
  path: string;
  profile: string;
  state: V2DurableState;
}

export interface DurableStateMigrationResult {
  source: "canonical" | "legacy" | "empty" | "blocked";
  state?: V2DurableState;
  sourcePath?: string;
  reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDurableState = (value: unknown): value is V2DurableState => {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === "ai-mayor-v2-durability/1" &&
    value.v2StateVersion === 1 &&
    Array.isArray(value.checkpoints) &&
    Array.isArray(value.commands) &&
    isRecord(value.projectState)
  );
};

const readState = (filePath: string): V2DurableState | undefined => {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StateEnvelope;
    return isDurableState(parsed[AI_MAYOR_STATE_KEY]) ? parsed[AI_MAYOR_STATE_KEY] : undefined;
  } catch {
    return undefined;
  }
};

const lineageKey = (state: V2DurableState): string | null => {
  const active = state.active;
  const project = state.projectState;
  if (!active || !isRecord(project)) return null;
  const projectRecord = project as Record<string, unknown>;
  const tranche = projectRecord.tranche;
  const projectIdentity = isRecord(projectRecord.project) ? projectRecord.project : undefined;
  const projectId = projectIdentity?.id;
  const trancheId = isRecord(tranche) ? tranche.id : undefined;
  if (typeof active.worldId !== "string" || typeof projectId !== "string" || typeof trancheId !== "string") {
    return null;
  }
  return JSON.stringify({ worldId: active.worldId, checkpointId: active.loadedCheckpointId, projectId, trancheId });
};

export function canonicalStorePath(appDataPath: string): string {
  return path.join(appDataPath, AI_MAYOR_CANONICAL_PROFILE, `${AI_MAYOR_CANONICAL_STORE_NAME}.json`);
}

export function legacyStorePaths(appDataPath: string): Array<{ path: string; profile: string }> {
  return [
    { path: path.join(appDataPath, "AI Mayor", "config.json"), profile: "AI Mayor" },
    { path: path.join(appDataPath, "Electron", "config.json"), profile: "Electron" },
    { path: path.join(appDataPath, "AI Mayor", "__DEV__", "config.json"), profile: "AI Mayor/__DEV__" },
  ];
}

export function discoverLegacyDurableStates(appDataPath: string): DurableStateCandidate[] {
  return legacyStorePaths(appDataPath)
    .map((candidate) => ({ ...candidate, state: readState(candidate.path) }))
    .filter((candidate): candidate is DurableStateCandidate => candidate.state !== undefined);
}

/**
 * Selects a legacy state without copying any unrelated Electron settings.
 * The real product profile is the canonical legacy namespace; alternate
 * profiles are considered only when that preferred source is absent. This
 * prevents the accidental Electron profile from shadowing the product state.
 * If no preferred source exists, conflicting lineage candidates fail closed.
 */
export function selectDurableStateMigration(
  appDataPath: string,
  canonicalState?: V2DurableState,
): DurableStateMigrationResult {
  if (canonicalState) return { source: "canonical", state: canonicalState };

  const candidates = discoverLegacyDurableStates(appDataPath);
  const preferred = candidates.find((candidate) => candidate.profile === "AI Mayor");
  if (preferred) return { source: "legacy", state: preferred.state, sourcePath: preferred.path };
  if (candidates.length === 0) return { source: "empty" };

  const lineages = new Set(candidates.map((candidate) => lineageKey(candidate.state)));
  if (lineages.size !== 1 || lineages.has(null)) {
    return { source: "blocked", reason: "CONFLICTING_LEGACY_DURABLE_STATE_LINEAGE" };
  }
  if (candidates.length !== 1) {
    return { source: "blocked", reason: "MULTIPLE_LEGACY_DURABLE_STATES" };
  }
  return { source: "legacy", state: candidates[0].state, sourcePath: candidates[0].path };
}

export function createCanonicalDurableStateStorage(appDataPath: string) {
  const canonicalDir = path.join(appDataPath, AI_MAYOR_CANONICAL_PROFILE);
  const canonicalStore = new Store<{ [AI_MAYOR_STATE_KEY]?: V2DurableState }>({
    cwd: canonicalDir,
    name: AI_MAYOR_CANONICAL_STORE_NAME,
  });
  const routingStore = new Store<{ activeBranchId?: string }>({ cwd: canonicalDir, name: `${AI_MAYOR_CANONICAL_STORE_NAME}-routing` });
  const activeBranchId = routingStore.get("activeBranchId");
  const branchStore = (branchId: string) => new Store<{ [AI_MAYOR_STATE_KEY]?: V2DurableState }>({
    cwd: path.join(canonicalDir, "execution-branches", branchId),
    name: AI_MAYOR_CANONICAL_STORE_NAME,
  });
  let selectedStore = typeof activeBranchId === "string" && /^[a-f0-9]{40}$/.test(activeBranchId)
    ? branchStore(activeBranchId)
    : canonicalStore;
  let selectedNamespace = typeof activeBranchId === "string" && /^[a-f0-9]{40}$/.test(activeBranchId)
    ? path.join(canonicalDir, "execution-branches", activeBranchId, `${AI_MAYOR_CANONICAL_STORE_NAME}.json`)
    : canonicalStorePath(appDataPath);
  let migrationChecked = false;
  let migrationResult: DurableStateMigrationResult | undefined;

  const ensureMigration = () => {
    if (migrationChecked) return;
    migrationChecked = true;
    const current = canonicalStore.get(AI_MAYOR_STATE_KEY);
    migrationResult = selectDurableStateMigration(appDataPath, current);
    if (migrationResult.source === "legacy" && migrationResult.state) {
      canonicalStore.set(AI_MAYOR_STATE_KEY, migrationResult.state);
    }
  };

  return {
    load: () => {
      if (selectedStore === canonicalStore) ensureMigration();
      return selectedStore.get(AI_MAYOR_STATE_KEY);
    },
    save: (state: V2DurableState) => selectedStore.set(AI_MAYOR_STATE_KEY, state),
    get namespaceId() { return selectedNamespace; },
    forkHistoricalBranch(input: {
      branchId: string; parentBranchId: string; checkpointId: string | null; journalCut: number;
      loadEventId: string; state: V2DurableState;
    }) {
      if (!/^[a-f0-9]{40}$/.test(input.branchId) || input.state.executionBranch?.branchId !== input.branchId ||
        input.state.executionBranch.parentBranchId !== input.parentBranchId ||
        input.state.executionBranch.sourceCheckpointId !== input.checkpointId ||
        input.state.executionBranch.sourceJournalCut !== input.journalCut ||
        input.state.executionBranch.loadEventId !== input.loadEventId) {
        throw new Error("HISTORICAL_EXECUTION_BRANCH_PROVENANCE_INVALID");
      }
      const existingStore = branchStore(input.branchId);
      const existing = existingStore.get(AI_MAYOR_STATE_KEY);
      if (existing) {
        const provenance = existing.executionBranch;
        if (provenance?.loadEventId !== input.loadEventId || provenance.parentBranchId !== input.parentBranchId) {
          throw new Error("HISTORICAL_EXECUTION_BRANCH_ID_COLLISION");
        }
        selectedStore = existingStore;
      } else {
        const branchRoot = path.join(canonicalDir, "execution-branches");
        const existingBranches = fs.existsSync(branchRoot)
          ? fs.readdirSync(branchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name)).length
          : 0;
        if (existingBranches >= MAX_EXECUTION_BRANCHES) throw new Error("EXECUTION_BRANCH_HISTORY_CAPACITY_REACHED");
        existingStore.set(AI_MAYOR_STATE_KEY, input.state);
        selectedStore = existingStore;
      }
      selectedNamespace = path.join(canonicalDir, "execution-branches", input.branchId, `${AI_MAYOR_CANONICAL_STORE_NAME}.json`);
      routingStore.set("activeBranchId", input.branchId);
    },
    resolveArchivedCheckpoint(input: {
      worldId: string; checkpointId: string; saveMetadataAssetGuid: string | null; saveDataAssetGuid: string | null;
    }) {
      const branchRoot = path.join(canonicalDir, "execution-branches");
      const candidates: V2DurableState[] = [];
      const current = canonicalStore.get(AI_MAYOR_STATE_KEY);
      if (isDurableState(current)) candidates.push(current);
      if (fs.existsSync(branchRoot)) {
        for (const entry of fs.readdirSync(branchRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name)) continue;
          const archived = readState(path.join(branchRoot, entry.name, `${AI_MAYOR_CANONICAL_STORE_NAME}.json`));
          if (archived) candidates.push(archived);
        }
      }
      const matches = candidates.filter((state) => state.checkpoints.some((checkpoint) => checkpoint.durable &&
        checkpoint.worldId === input.worldId && checkpoint.checkpointId === input.checkpointId &&
        checkpoint.saveMetadataAssetGuid === input.saveMetadataAssetGuid &&
        checkpoint.saveDataAssetGuid === input.saveDataAssetGuid));
      if (matches.length !== 1) return null;
      return matches[0];
    },
    migration: () => {
      ensureMigration();
      return migrationResult;
    },
  };
}
