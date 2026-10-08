import type { GrowableLandUse, GrowthPace } from "../growth-mode";
import { createSkillRegistry } from "../skills/registry/runtime";
import type { SkillRegistry } from "../skills/registry/skill-registry";
import { executeProductionSkillIntent, type ProductionSkillWorkflow } from "../skills/runtime/skill-execution-runtime";
import type { SkillResult } from "../skills/schemas/result";
import type { V2FoundationPorts } from "./main-adapter";
import type { V2GoalWorkOrderRecord } from "./durability";
import type { Gate1State } from "./gate1";
import type { CivicServiceOutcome } from "./civic-service";

export interface V2ProductionSkillContext {
  readonly authoritativeContext: (intent?: unknown) => Promise<unknown>;
  readonly currentWorldIdentity: () => Promise<string>;
}

export interface V2ProductionSkillRuntime {
  readonly registry: SkillRegistry;
  initialize(): void;
  dispose(): void;
  isInitialized(): boolean;
  readiness(): Promise<unknown>;
  /**
   * Drop the memoized authoritative context. Any operation that changes durable
   * Gate 1 state invalidates it, otherwise readiness and Skill dispatch would
   * keep serving the session-start snapshot.
   */
  invalidateReadiness(): void;
  /** Explicit production entry for the first durable Gate 1 project admission. */
  ensureProjectAdmission(signal?: AbortSignal): Promise<unknown>;
  /** Explicit production entry for a repeatable, goal-scoped Gate1 work order. */
  ensureGoalWorkOrder(input: { goalId: string; landUse?: GrowableLandUse;
    completionStage?: "ROAD_DELIVERED" | "WAITING_FOR_OCCUPANCY" | "OCCUPIED" }, signal?: AbortSignal): Promise<unknown>;
  /**
   * Set the pacing the next admission is sized and bounded by.
   *
   * Called once per Brain cycle from the city's own population, so the brake
   * follows the city rather than being fixed at session start.
   */
  setGrowthPace?(pace: GrowthPace): void;
  activeGoalWorkOrder?(): V2GoalWorkOrderRecord | null;
  /** Read durable Goal history so unchanged-fact parks survive a session restart. */
  goalWorkOrders?(): V2GoalWorkOrderRecord[];
  completeGoalWorkOrder?(goalId: string): V2GoalWorkOrderRecord;
  /** Synchronize progression's public result with the active durable work-order lifecycle. */
  recordGate1ProgressionOutcome?(outcome: unknown): V2GoalWorkOrderRecord | null;
  /** Place the first public-service building the city is owed, through the journaled utility placement path. */
  provideCivicService?(signal?: AbortSignal): Promise<CivicServiceOutcome>;
  /** Raise tax rates one bounded step while the treasury runway is short. */
  ensureSolvency?(signal?: AbortSignal): Promise<Array<{ area: string; rate: number }>>;
  dispatch(intent: unknown, signal?: AbortSignal): Promise<SkillResult>;
}

export function createV2ProductionSkillRuntime(input: {
  foundation: Pick<V2FoundationPorts, "greenfieldUtilityBootstrap" | "projectAdmission" | "civicServices" | "solvency">;
  context: V2ProductionSkillContext;
  workflows: readonly ProductionSkillWorkflow[];
}): V2ProductionSkillRuntime {
  const registry = createSkillRegistry();
  let initialized = false;
  let readinessCache: { promise: Promise<unknown>; worldIdentity: string | null } | null = null;
  const createReadiness = () => {
    const cache = { promise: Promise.resolve(undefined) as Promise<unknown>, worldIdentity: null as string | null };
    cache.promise = input.context.authoritativeContext().then((context) => {
      const world = (context as { world?: Record<string, unknown> } | null)?.world;
      const worldId = typeof world?.worldId === "string" ? world.worldId : "";
      const generation = typeof world?.generation === "string" ? world.generation : "";
      const worldEpochId = typeof world?.worldEpochId === "string" ? world.worldEpochId : "";
      if (!worldId || !generation || !worldEpochId) throw new Error("V2_PRODUCTION_CONTEXT_WORLD_IDENTITY_UNAVAILABLE");
      cache.worldIdentity = JSON.stringify([worldId, generation, worldEpochId]);
      return context;
    });
    readinessCache = cache;
    void cache.promise.catch(() => {
      if (readinessCache === cache) readinessCache = null;
    });
    return cache.promise;
  };
  return {
    registry,
    initialize() {
      if (initialized) return;
      initialized = true;
      createReadiness();
      // Starting the session must not depend on a native read succeeding, but a
      // failed context must not stay memoized: readiness/dispatch would then be
      // permanently poisoned by a transient failure.
    },
    dispose() {
      initialized = false;
      readinessCache = null;
    },
    isInitialized() {
      return initialized;
    },
    async readiness() {
      if (!initialized) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
      const cache = readinessCache;
      if (!cache) return createReadiness();
      const currentWorldIdentity = await input.context.currentWorldIdentity();
      const context = await cache.promise;
      if (cache.worldIdentity === currentWorldIdentity) return context;
      if (readinessCache === cache) readinessCache = null;
      const replacement = readinessCache;
      if (replacement) {
        const replacementContext = await replacement.promise;
        if (replacement.worldIdentity === currentWorldIdentity) return replacementContext;
      }
      return createReadiness();
    },
    invalidateReadiness() {
      readinessCache = null;
    },
    async ensureProjectAdmission(signal) {
      if (!initialized) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
      if (!input.foundation.projectAdmission) {
        throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
      }
      return input.foundation.projectAdmission.ensureFirstProject(signal);
    },
    async ensureGoalWorkOrder(workOrder, signal) {
      if (!initialized) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
      if (!input.foundation.projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
      return input.foundation.projectAdmission.ensureGoalWorkOrder(workOrder, signal);
    },
    setGrowthPace(pace) {
      input.foundation.projectAdmission?.setPace(pace);
    },
    activeGoalWorkOrder() {
      return input.foundation.projectAdmission?.activeGoalWorkOrder() ?? null;
    },
    goalWorkOrders() {
      return input.foundation.projectAdmission?.goalWorkOrders?.() ?? [];
    },
    completeGoalWorkOrder(goalId) {
      if (!input.foundation.projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
      return input.foundation.projectAdmission.completeGoalWorkOrder(goalId);
    },
    recordGate1ProgressionOutcome(outcome) {
      if (!input.foundation.projectAdmission) throw new Error("V2_PRODUCTION_PROJECT_ADMISSION_NOT_CONFIGURED");
      const value = outcome as { status?: unknown; state?: Gate1State | null; reason?: unknown } | null;
      if (!value || typeof value.status !== "string") return null;
      return input.foundation.projectAdmission.recordGate1ProgressionOutcome({
        status: value.status,
        state: value.state ?? null,
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      });
    },
    async ensureSolvency(signal) {
      if (!initialized) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
      return input.foundation.solvency ? input.foundation.solvency.ensure(signal) : [];
    },
    async provideCivicService(signal) {
      if (!initialized) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
      if (!input.foundation.civicServices) return { status: "SKIPPED", reason: "CIVIC_SERVICES_NOT_CONFIGURED" };
      return input.foundation.civicServices.provide(signal);
    },
    async dispatch(intent, signal) {
      if (!initialized) throw new Error("V2_PRODUCTION_SKILL_RUNTIME_NOT_INITIALIZED");
      const utilityKind = (intent as { utilityKind?: unknown } | null)?.utilityKind;
      // Utility placement durability is recipe-scoped. Resolve a kind-specific
      // authoritative context for K05 instead of reusing the session bootstrap
      // (which defaults to electricity and could make a placed wind turbine's
      // placement proof look like a prior water/sewage placement).
      const context = typeof utilityKind === "string"
        ? await input.context.authoritativeContext(intent)
        : await this.readiness();
      const world = (context as { world?: Record<string, unknown> } | null)?.world;
      const contextIdentity = JSON.stringify([world?.worldId, world?.generation, world?.worldEpochId]);
      if (contextIdentity !== await input.context.currentWorldIdentity()) {
        throw new Error("V2_PRODUCTION_CONTEXT_WORLD_IDENTITY_CHANGED_DURING_DISPATCH");
      }
      return executeProductionSkillIntent({
        registry,
        foundation: input.foundation,
        intent,
        authoritativeContext: context,
        workflows: input.workflows,
        signal,
      });
    },
  };
}
