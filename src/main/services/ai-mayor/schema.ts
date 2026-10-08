import { z } from "zod";
import type { MayorMemory, MayorPlan } from "./types";
import { UrbanDesignIntentSchema, validateUrbanDesignIntentAgainstSnapshot } from "./urban-design/intent";
import { createPumpSegment2JunctionContract } from "./v2/bounded-network-junction";
import type { BoundedNetworkJunctionInsert } from "./v2/bounded-network-junction";

export const MAYOR_MEMORY_MAX_BYTES = 4_096;
export const MAYOR_SNAPSHOT_MAX_BYTES = 48_000;
export const MAYOR_BATCH_RESULT_MAX_BYTES = 8_000;
export const MAYOR_FAST_MAX_CANDIDATES = 3;

const shortText = z.string().trim().min(1).max(240);
const coord = z.number().finite().min(-10_000).max(10_000);
const prefab = z.string().trim().min(1).max(160);
const junctionContract = z.custom<BoundedNetworkJunctionInsert>((value) => {
  if (typeof value !== "object" || value === null) return false;
  const sort = (item: unknown): string => JSON.stringify(item, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b))) : nested);
  return sort(value) === sort(createPumpSegment2JunctionContract());
}).optional();

const buildRoad = z
  .object({
    type: z.literal("build_road"),
    prefab,
    x1: coord,
    z1: coord,
    x2: coord,
    z2: coord,
    cx: coord.optional(),
    cz: coord.optional(),
    e1: z.number().finite().min(-1_000).max(1_000).optional(),
    e2: z.number().finite().min(-1_000).max(1_000).optional(),
    networkJunctionInsert: junctionContract,
    force: z.literal(false).optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if ((action.cx === undefined) !== (action.cz === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cx and cz must be provided together" });
    }
    if ((action.e1 === undefined) !== (action.e2 === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "e1 and e2 must be provided together" });
    }
    if (action.networkJunctionInsert) {
      const contract = action.networkJunctionInsert;
      if (action.prefab !== contract.road.prefab || action.x1 !== contract.road.course.x1 || action.z1 !== contract.road.course.z1 ||
        action.x2 !== contract.road.course.x2 || action.z2 !== contract.road.course.z2 || action.cx !== undefined || action.cz !== undefined ||
        action.e1 !== undefined || action.e2 !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "bounded junction operation requires its exact approved course" });
      }
    }
  });

const zone = z
  .object({
    type: z.literal("zone"),
    zone: prefab,
    x: coord,
    z: coord,
    radius: z.number().finite().min(8).max(200).optional(),
    force: z.literal(false).optional(),
  })
  .strict();

const placeBuilding = z
  .object({
    type: z.literal("place_building"),
    prefab,
    x: coord,
    z: coord,
    rotation: z.number().finite().min(-360_000).max(360_000).optional(),
    force: z.literal(false).optional(),
  })
  .strict();

const upgradeRoad = z
  .object({
    type: z.literal("upgrade_road"),
    index: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    upgrades: z
      .array(
        z.enum(["grass", "trees", "wideSidewalk", "soundBarrier", "parking", "lighting", "medianGrass", "medianTrees"]),
      )
      .min(1)
      .max(8),
    side: z.enum(["both", "left", "right"]).optional(),
  })
  .strict();

const chooseCandidate = z
  .object({
    type: z.literal("choose_candidate"),
    candidateId: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9-]+$/),
    reason: shortText,
    priority: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

export const MayorActionSchema = z.union([buildRoad, zone, placeBuilding, upgradeRoad, chooseCandidate]);

export const MayorBatchResultSchema = z
  .object({
    ok: z.boolean(),
    requested: z.number().int().min(0).max(20),
    executed: z.number().int().min(0).max(20),
    failedAt: z.number().int().min(0).max(19).optional(),
    results: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(19),
            type: z.enum(["build_road", "zone", "place_building", "upgrade_road"]),
            ok: z.boolean(),
            summary: z.string().max(240),
            error: z.string().max(300).optional(),
            receipt: z
              .object({
                entity: z.object({ index: z.number().int(), version: z.number().int() }).strict(),
                prefab: z.string().max(160),
                position: z.object({ x: z.number(), y: z.number().optional(), z: z.number() }).strict(),
              })
              .strict()
              .optional(),
            nativeCompletionEvidence: z.unknown().optional(),
            rejectionDiagnostics: z.unknown().optional(),
            bridgeHttpErrorDiagnostics: z.unknown().optional(),
            bridgeCommandId: z.string().optional(),
            mcpBridgeFailureDiagnostics: z.unknown().optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const memoryUpdate = z
  .object({
    phase: shortText.optional(),
    strategy: shortText.optional(),
    importantAreas: z.array(shortText).max(8).optional(),
    recentMilestones: z.array(shortText).max(8).optional(),
    unresolvedProblems: z.array(shortText).max(8).optional(),
    nextGoal: shortText.optional(),
  })
  .strict();

export const MayorPlanSchema = z
  .object({
    status: z.string().trim().min(1).max(160),
    objective: shortText,
    rationale: z.string().trim().min(1).max(500),
    urbanDesignIntent: UrbanDesignIntentSchema.optional(),
    blockingReason: z.string().trim().min(1).max(300).optional(),
    actions: z.array(MayorActionSchema).max(20),
    constructionPhase: z
      .object({
        objective: shortText,
        candidateIds: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(120)
              .regex(/^[A-Za-z0-9-]+$/),
          )
          .min(1)
          .max(MAYOR_FAST_MAX_CANDIDATES),
        rationale: shortText,
      })
      .strict()
      .optional(),
    simulation: z
      .object({
        run: z.boolean(),
        hours: z.number().finite().min(0.1).max(24).optional(),
        speed: z.number().finite().min(0.5).max(8).optional(),
      })
      .strict()
      .superRefine((simulation, context) => {
        if (simulation.run && simulation.hours === undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "hours is required when simulation.run is true" });
        }
      }),
    memoryUpdate,
    stop: z
      .object({
        requested: z.boolean(),
        reason: z.string().trim().min(1).max(240).optional(),
      })
      .strict()
      .superRefine((stop, context) => {
        if (stop.requested && !stop.reason) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "reason is required when stop.requested is true" });
        }
      }),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.constructionPhase && plan.actions.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "constructionPhase cannot also include actions",
      });
    }
    if (plan.actions.length === 0 && !plan.constructionPhase && !plan.blockingReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockingReason"],
        message: "blockingReason is required when actions is empty",
      });
    }
  });

export function emptyMayorMemory(): MayorMemory {
  return {
    phase: "assessment",
    strategy: "Protect solvency and establish reliable basic infrastructure.",
    importantAreas: [],
    recentMilestones: [],
    unresolvedProblems: [],
    nextGoal: "Assess the current city snapshot.",
  };
}

const trim = (value: string, max: number) => value.trim().slice(0, max);
const trimList = (values: string[]) => values.slice(-8).map((value) => trim(value, 240));

export function mergeMayorMemory(current: MayorMemory, update: Partial<MayorMemory>): MayorMemory {
  const merged: MayorMemory = {
    phase: trim(update.phase ?? current.phase, 240),
    strategy: trim(update.strategy ?? current.strategy, 240),
    importantAreas: trimList(update.importantAreas ?? current.importantAreas),
    recentMilestones: trimList(update.recentMilestones ?? current.recentMilestones),
    unresolvedProblems: trimList(update.unresolvedProblems ?? current.unresolvedProblems),
    nextGoal: trim(update.nextGoal ?? current.nextGoal, 240),
  };
  if (Buffer.byteLength(JSON.stringify(merged), "utf8") > MAYOR_MEMORY_MAX_BYTES) {
    merged.importantAreas = merged.importantAreas.slice(-4);
    merged.recentMilestones = merged.recentMilestones.slice(-4);
    merged.unresolvedProblems = merged.unresolvedProblems.slice(-4);
  }
  return merged;
}

export function parseMayorPlan(content: string) {
  const trimmed = content.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const parsed = JSON.parse(withoutFence) as unknown;
  return MayorPlanSchema.parse(normalizeMayorPlanWirePayload(parsed));
}

/** Normalize only fixed wire representation details; semantic omissions remain invalid. */
export function normalizeMayorPlanWirePayload(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const plan = parsed as Record<string, unknown>;
    const intent = plan.urbanDesignIntent;
    if (typeof intent === "object" && intent !== null && !Array.isArray(intent)) {
      const wireIntent = intent as Record<string, unknown>;
      if (wireIntent.version === undefined) {
        return { ...plan, urbanDesignIntent: { version: 1, ...wireIntent } };
      }
    }
  }
  return parsed;
}

export function normalizeMayorPlanForSpeed(plan: MayorPlan, speed: "normal" | "fast") {
  const modelPlanFormat = plan.constructionPhase ? "constructionPhase" : "actions";
  if (speed !== "fast" || plan.constructionPhase || plan.actions.length < 2) {
    return {
      plan,
      modelPlanFormat: modelPlanFormat as "actions" | "constructionPhase",
      normalizedToConstructionPhase: false,
    };
  }
  if (!plan.actions.every((action) => action.type === "choose_candidate")) {
    return { plan, modelPlanFormat: "actions" as const, normalizedToConstructionPhase: false };
  }
  return {
    plan: {
      ...plan,
      actions: [],
      constructionPhase: {
        objective: plan.objective,
        candidateIds: plan.actions.map((action) => action.candidateId),
        rationale: plan.rationale.slice(0, 240),
      },
    },
    modelPlanFormat: "actions" as const,
    normalizedToConstructionPhase: true,
  };
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const exactNames = (value: unknown): Set<string> =>
  new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** Enforce the live snapshot catalog locally; model instructions alone are not a safety boundary. */
export function validateMayorPlanAgainstSnapshot(
  plan: MayorPlan,
  snapshot: unknown,
  options: { maxCandidateCount?: number } = {},
): MayorPlan {
  if (plan.urbanDesignIntent) validateUrbanDesignIntentAgainstSnapshot(plan.urbanDesignIntent, snapshot);
  const constructionPhase = plan.constructionPhase;
  if (constructionPhase) {
    const max = options.maxCandidateCount ?? MAYOR_FAST_MAX_CANDIDATES;
    if (constructionPhase.candidateIds.length > max)
      throw new Error(`construction phase exceeds the ${max}-candidate safety limit`);
    plan = {
      ...plan,
      actions: constructionPhase.candidateIds.map((candidateId) => ({
        type: "choose_candidate" as const,
        candidateId,
        reason: constructionPhase.rationale.slice(0, 240) || constructionPhase.objective,
      })),
    };
  }
  if (plan.actions.length === 0) return plan;
  const treasury = object(object(snapshot).economy).treasury;
  if (typeof treasury === "number" && treasury <= 0) {
    throw new Error("city treasury is depleted; construction is blocked by the extreme-solvency safety boundary");
  }
  const catalog = object(object(snapshot).planningCatalog);
  const roadPrefabs = exactNames(catalog.roadPrefabs);
  const buildings = object(catalog.buildingPrefabs);
  const buildingPrefabs = new Set(Object.values(buildings).flatMap((items) => [...exactNames(items)]));
  const roadEntities = new Set(
    (Array.isArray(catalog.roadAnchors) ? catalog.roadAnchors : []).map((road) => {
      const entity = object(object(road).entity);
      return `${entity.index}:${entity.version}`;
    }),
  );
  const actionable = object(object(snapshot).actionablePlanning);
  const candidates = new Map(
    (Array.isArray(actionable.candidates) ? actionable.candidates : []).map((candidate) => {
      const item = object(candidate);
      return [item.id, item] as const;
    }),
  );
  const selectedIds = new Set<string>();
  const selectedConflictGroups = new Set<string>();

  for (const [index, action] of plan.actions.entries()) {
    if (action.type === "zone")
      throw new Error(`action ${index} must choose a validated zoning candidate instead of supplying coordinates`);
    if (action.type === "build_road" && !roadPrefabs.has(action.prefab))
      throw new Error(`action ${index} road prefab is not in the unlocked snapshot catalog: ${action.prefab}`);
    if (action.type === "place_building" && !buildingPrefabs.has(action.prefab))
      throw new Error(`action ${index} building prefab is not in the unlocked snapshot catalog: ${action.prefab}`);
    if (action.type === "upgrade_road" && !roadEntities.has(`${action.index}:${action.version}`))
      throw new Error(`action ${index} road entity is not in the current snapshot anchors`);
    if (action.type === "choose_candidate") {
      const candidate = candidates.get(action.candidateId);
      if (!candidate || candidate.validationStatus !== "validated")
        throw new Error(`action ${index} candidate is not currently validated: ${action.candidateId}`);
      if (selectedIds.has(action.candidateId))
        throw new Error(`action ${index} repeats candidate ${action.candidateId}`);
      selectedIds.add(action.candidateId);
      if (candidate.candidateType === "road_expansion" && !plan.urbanDesignIntent) {
        throw new Error("road expansion candidates require urbanDesignIntent before legacy selection");
      }
      const conflictGroup = candidate.conflictGroup;
      if (typeof conflictGroup !== "string" || !conflictGroup)
        throw new Error(`action ${index} candidate has no conflict group: ${action.candidateId}`);
      if (selectedConflictGroups.has(conflictGroup))
        throw new Error(`action ${index} conflicts with another selected candidate: ${action.candidateId}`);
      selectedConflictGroups.add(conflictGroup);
    }
  }
  return plan;
}
