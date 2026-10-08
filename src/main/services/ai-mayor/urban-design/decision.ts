import { z } from "zod";
import { UrbanDesignIntentSchema, UrbanDesignIntentWireSchema, type UrbanDesignSnapshotContext } from "./intent";

export const URBAN_DESIGN_DECISION_VERSION = 1 as const;

export const UrbanDesignDecisionSchema = z
  .object({
    version: z.literal(URBAN_DESIGN_DECISION_VERSION),
    status: z.enum(["design", "continue", "wait"]),
    urbanDesignIntent: UrbanDesignIntentSchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.status === "design" || decision.status === "continue") && !decision.urbanDesignIntent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urbanDesignIntent"],
        message: `${decision.status} requires urbanDesignIntent`,
      });
    }
    if (decision.urbanDesignIntent && decision.urbanDesignIntent.status !== decision.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urbanDesignIntent", "status"],
        message: "decision status and urbanDesignIntent status must match",
      });
    }
    if (decision.status === "wait" && decision.urbanDesignIntent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urbanDesignIntent"],
        message: "wait must not include urbanDesignIntent",
      });
    }
  });

export type UrbanDesignDecision = z.infer<typeof UrbanDesignDecisionSchema>;

export const UrbanDesignDecisionWireSchema = z
  .object({
    version: z.literal(URBAN_DESIGN_DECISION_VERSION),
    status: z.enum(["design", "continue", "wait"]),
    urbanDesignIntent: UrbanDesignIntentWireSchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.status === "design" || decision.status === "continue") && !decision.urbanDesignIntent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urbanDesignIntent"],
        message: `${decision.status} requires urbanDesignIntent`,
      });
    }
    if (decision.status === "wait" && decision.urbanDesignIntent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["urbanDesignIntent"],
        message: "wait must not include urbanDesignIntent",
      });
    }
  });

export type UrbanDesignDecisionWire = z.infer<typeof UrbanDesignDecisionWireSchema>;

export function canonicalizeUrbanDesignDecisionWire(value: unknown): UrbanDesignDecision {
  const wire = UrbanDesignDecisionWireSchema.parse(value);
  return UrbanDesignDecisionSchema.parse({
    version: wire.version,
    status: wire.status,
    ...(wire.urbanDesignIntent
      ? { urbanDesignIntent: { version: wire.version, status: wire.status, ...wire.urbanDesignIntent } }
      : {}),
  });
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  return JSON.parse(withoutFence) as unknown;
}

export function parseUrbanDesignDecision(content: string): UrbanDesignDecision {
  return UrbanDesignDecisionSchema.parse(parseJsonContent(content));
}

export function parseUrbanDesignDecisionWire(content: string): UrbanDesignDecision {
  return canonicalizeUrbanDesignDecisionWire(parseJsonContent(content));
}

export function validateUrbanDesignDecision(value: unknown): UrbanDesignDecision {
  return UrbanDesignDecisionSchema.parse(value);
}

export function urbanDesignDecisionHasNoExecutionFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.every((key) => ["version", "status", "urbanDesignIntent"].includes(key));
}

export function boundedUrbanDesignDecisionContext(input: {
  goal: string;
  tick: number;
  urbanDesign: UrbanDesignSnapshotContext;
  playerDirection?: string | null;
  strategicContext?: { goal?: string; phase: string; strategy: string; operationalNote: string };
}) {
  const context = {
    goal: input.goal.slice(0, 240),
    tick: input.tick,
    playerDirection: input.playerDirection?.slice(0, 240) ?? null,
    strategicContext: input.strategicContext
      ? {
          ...(input.strategicContext.goal ? { goal: input.strategicContext.goal.slice(0, 240) } : {}),
          phase: input.strategicContext.phase.slice(0, 120),
          strategy: input.strategicContext.strategy.slice(0, 240),
          operationalNote: input.strategicContext.operationalNote.slice(0, 240),
        }
      : null,
    urbanDesign: input.urbanDesign,
  };
  return JSON.stringify(context);
}
