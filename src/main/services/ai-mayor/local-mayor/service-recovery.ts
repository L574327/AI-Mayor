import type { CityIssue, CityIssueKind } from "./issues";

export type LocalServiceRecoveryStatus =
  | "observed"
  | "actionable"
  | "recovering"
  | "resolved"
  | "cooldown"
  | "unsupported";
export type LocalServiceRecoveryAction = "stabilize_utilities" | "place_service_building" | "none";
export type LocalServiceRecoveryEffect = "unknown" | "improving" | "resolved" | "no_material_issue_improvement";

export interface LocalServiceRecoveryIntent {
  issueKey: string;
  issueKind: CityIssueKind;
  severity: CityIssue["severity"];
  chosenActionKind: LocalServiceRecoveryAction;
  targetDomain: string;
  candidateId?: string;
  createdRevision: string;
  attempts: number;
  cooldownRemaining: number;
  status: LocalServiceRecoveryStatus;
  lastObservedEffect: LocalServiceRecoveryEffect;
  lastAttemptAt?: string;
}

const UTILITY_ISSUES = new Set<CityIssueKind>(["electricity_shortage", "water_shortage", "sewage_shortage"]);
const MAX_ATTEMPTS = 3;
const MAX_COOLDOWN = 4;

export function deriveServiceRecoveryIntent(
  issue: CityIssue | null,
  previous?: LocalServiceRecoveryIntent,
): LocalServiceRecoveryIntent | undefined {
  if (!issue) return undefined;
  const sameIssue = previous?.issueKey === issue.key;
  const attempts = sameIssue ? Math.min(MAX_ATTEMPTS, previous.attempts) : 0;
  const cooldownRemaining = sameIssue ? Math.min(MAX_COOLDOWN, previous.cooldownRemaining) : 0;
  if (UTILITY_ISSUES.has(issue.kind)) {
    return {
      issueKey: issue.key,
      issueKind: issue.kind,
      severity: issue.severity,
      chosenActionKind: "stabilize_utilities",
      targetDomain: issue.kind.replace("_shortage", ""),
      createdRevision: sameIssue ? previous.createdRevision : issue.lastSeen,
      attempts,
      cooldownRemaining,
      status: cooldownRemaining > 0 ? "cooldown" : "actionable",
      lastObservedEffect: sameIssue ? previous.lastObservedEffect : "unknown",
      ...(sameIssue && previous.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}),
    };
  }
  return {
    issueKey: issue.key,
    issueKind: issue.kind,
    severity: issue.severity,
    chosenActionKind: "none",
    targetDomain: issue.domain,
    createdRevision: sameIssue ? previous.createdRevision : issue.lastSeen,
    attempts,
    cooldownRemaining,
    status: "unsupported",
    lastObservedEffect: sameIssue ? previous.lastObservedEffect : "unknown",
    ...(sameIssue && previous.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}),
  };
}

export function recordServiceRecoveryAttempt(
  intent: LocalServiceRecoveryIntent,
  attemptedAt: string,
): LocalServiceRecoveryIntent {
  return {
    ...intent,
    attempts: Math.min(MAX_ATTEMPTS, intent.attempts + 1),
    cooldownRemaining: Math.min(MAX_COOLDOWN, Math.max(1, intent.cooldownRemaining)),
    status: "recovering",
    lastAttemptAt: attemptedAt,
  };
}

export function evaluateServiceRecoveryReadback(
  intent: LocalServiceRecoveryIntent,
  issueAfterReadback: CityIssue | null,
  observedEffect: LocalServiceRecoveryEffect = "no_material_issue_improvement",
): LocalServiceRecoveryIntent {
  if (!issueAfterReadback || issueAfterReadback.key !== intent.issueKey) {
    return { ...intent, status: "resolved", cooldownRemaining: 0, lastObservedEffect: "resolved" };
  }
  return {
    ...intent,
    status: "cooldown",
    cooldownRemaining: Math.min(MAX_COOLDOWN, Math.max(1, intent.cooldownRemaining)),
    lastObservedEffect: observedEffect === "improving" ? "improving" : "no_material_issue_improvement",
  };
}

export function advanceServiceRecoveryCooldown(
  intent: LocalServiceRecoveryIntent,
): LocalServiceRecoveryIntent | undefined {
  if (intent.status !== "cooldown") return intent;
  const cooldownRemaining = Math.max(0, intent.cooldownRemaining - 1);
  return cooldownRemaining === 0
    ? { ...intent, cooldownRemaining, status: "actionable" }
    : { ...intent, cooldownRemaining };
}
