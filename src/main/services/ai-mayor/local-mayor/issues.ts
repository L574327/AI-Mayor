export type CityIssueDomain = "infrastructure" | "safety" | "operations" | "economy";
export type CityIssueSeverity = "critical" | "high" | "medium" | "low";
export type CityIssueEvidence = "authoritative" | "structured" | "notification";

export type CityIssueKind =
  | "electricity_shortage"
  | "water_shortage"
  | "sewage_shortage"
  | "garbage_pressure"
  | "fire_service_deficit"
  | "healthcare_service_deficit"
  | "police_service_deficit"
  | "worker_shortage"
  | "abandoned_buildings"
  | "finance_runway";

export interface CityIssueTarget {
  kind: "notification";
  type: string;
  location?: { x: number; z: number };
}

export interface CityIssue {
  kind: CityIssueKind;
  domain: CityIssueDomain;
  severity: CityIssueSeverity;
  priority: 0 | 1 | 2 | 3 | 4;
  urgency: number;
  affectedCount: number | null;
  source: string;
  key: string;
  firstSeen: string;
  lastSeen: string;
  persistence: number;
  actionable: boolean;
  confidence: CityIssueEvidence;
  targets: CityIssueTarget[];
  message: string;
}

export interface CityIssueSummary {
  current: CityIssue[];
  highest: CityIssue | null;
}

const MAX_ISSUES = 8;
const MAX_TARGETS = 3;
const severityRank: Record<CityIssueSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

type JsonObject = Record<string, any>;
const record = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function observationTime(root: JsonObject): string {
  return typeof root.generatedAt === "string"
    ? root.generatedAt
    : typeof record(root.game).gameDateTime === "string"
      ? (record(root.game).gameDateTime as string)
      : "observation";
}

function utilityIssue(
  root: JsonObject,
  kind: CityIssueKind,
  field: string,
  source: string,
  label: string,
): Omit<CityIssue, "firstSeen" | "lastSeen" | "persistence"> | null {
  const utility = record(record(root.utilities)[field]);
  const available = utility.status === "available";
  const capacity = finite(utility[field === "electricity" ? "production" : "capacity"]);
  const consumption = finite(utility.consumption);
  const fulfilled = finite(utility.fulfilledConsumption);
  const headroom = capacity !== null && consumption !== null ? capacity - consumption : null;
  // A shortage is load that is not being served. With no observed load there is
  // nothing being starved, and `headroom <= Math.max(1, consumption * 0.1)` is
  // `0 <= 1` for an uncommissioned utility — so "no supply, no demand" used to
  // raise this urgency-100 emergency, which is what let a NewGame city's water
  // and sewage outrank every growth decision forever. Preparation for a utility
  // that has no load yet is expressed as a Goal, never as an emergency here.
  const carried = consumption === null ? null : Math.max(consumption, fulfilled ?? 0);
  // A read that did not resolve is a genuine unknown and still fails safe,
  // unchanged. "No supply and no load" is not that: it is a utility that has not
  // been commissioned yet.
  const unservedLoad = carried !== null && carried > 0 &&
    ((fulfilled !== null && consumption !== null && fulfilled < consumption) ||
      (headroom !== null && consumption !== null && headroom <= Math.max(1, consumption * 0.1)));
  const critical = !available || headroom === null || unservedLoad;
  if (!critical) return null;
  return {
    kind,
    domain: "infrastructure",
    severity: "critical",
    priority: 0,
    urgency: 100,
    affectedCount: consumption,
    source,
    key: kind,
    actionable: true,
    confidence: "authoritative",
    targets: [],
    message: `${label} capacity is critical or unavailable`,
  };
}

function warningTargets(warnings: JsonObject, matches: RegExp): { count: number; targets: CityIssueTarget[] } {
  const topTypes = Array.isArray(warnings.topTypes) ? warnings.topTypes.map(record) : [];
  const topItems = Array.isArray(warnings.topItems) ? warnings.topItems.map(record) : [];
  const types = topTypes.filter((item) => typeof item.type === "string" && matches.test(item.type));
  const count = types.reduce((sum, item) => sum + (finite(item.count) ?? 0), 0);
  const targets = topItems
    .filter((item) => typeof item.type === "string" && matches.test(item.type))
    .slice(0, MAX_TARGETS)
    .map((item) => {
      const location = record(item.location);
      return {
        kind: "notification" as const,
        type: item.type as string,
        ...(finite(location.x) !== null && finite(location.z) !== null
          ? { location: { x: finite(location.x) as number, z: finite(location.z) as number } }
          : {}),
      };
    });
  return { count, targets };
}

function notificationIssue(
  root: JsonObject,
  kind: CityIssueKind,
  domain: CityIssueDomain,
  priority: 1 | 2,
  severity: CityIssueSeverity,
  urgency: number,
  pattern: RegExp,
  message: string,
): Omit<CityIssue, "firstSeen" | "lastSeen" | "persistence"> | null {
  const warnings = record(root.warnings);
  const match = warningTargets(warnings, pattern);
  if (match.count <= 0 && match.targets.length === 0) return null;
  return {
    kind,
    domain,
    priority,
    severity,
    urgency,
    affectedCount: match.count || null,
    source: "snapshot.warnings.topTypes",
    key: kind,
    actionable: false,
    confidence: "notification",
    targets: match.targets,
    message,
  };
}

function mergePersistence(
  issue: Omit<CityIssue, "firstSeen" | "lastSeen" | "persistence">,
  previous: CityIssue[],
  now: string,
): CityIssue {
  const prior = previous.find((candidate) => candidate.key === issue.key);
  const persistence = (prior?.persistence ?? 0) + 1;
  const promotedSeverity =
    issue.severity === "low" && persistence >= 2
      ? "medium"
      : issue.severity === "medium" && persistence >= 3
        ? "high"
        : issue.severity;
  return {
    ...issue,
    severity: promotedSeverity,
    urgency: Math.min(100, issue.urgency + (persistence >= 2 ? 10 : 0)),
    firstSeen: prior?.firstSeen ?? now,
    lastSeen: now,
    persistence,
  };
}

export function scanCityIssues(snapshot: unknown, previous: CityIssue[] = []): CityIssueSummary {
  const root = record(snapshot);
  const candidates: Array<Omit<CityIssue, "firstSeen" | "lastSeen" | "persistence">> = [];
  for (const issue of [
    utilityIssue(root, "electricity_shortage", "electricity", "snapshot.utilities.electricity", "Electricity"),
    utilityIssue(root, "water_shortage", "water", "snapshot.utilities.water", "Water"),
    utilityIssue(root, "sewage_shortage", "sewage", "snapshot.utilities.sewage", "Sewage"),
  ]) {
    if (issue) candidates.push(issue);
  }
  const garbage = record(record(root.utilities).garbage);
  if ((finite(garbage.accumulationRate) ?? 0) > 0) {
    candidates.push({
      kind: "garbage_pressure",
      domain: "operations",
      priority: 1,
      severity: "low",
      urgency: 20,
      affectedCount: finite(garbage.accumulationRate),
      source: "snapshot.utilities.garbage.accumulationRate",
      key: "garbage_pressure",
      actionable: false,
      confidence: "structured",
      targets: [],
      message: "Garbage accumulation is observable; automatic service repair is not supported",
    });
  }
  const serviceDefinitions = [
    ["fire_service_deficit", "fire", "Fire service", 1],
    ["healthcare_service_deficit", "healthcare", "Healthcare/deathcare service", 1],
    ["police_service_deficit", "police", "Police service", 1],
  ] as const;
  for (const [kind, field, label, priority] of serviceDefinitions) {
    const service = record(record(root.cityServices)[field]);
    const efficiency = finite(service.efficiencyPercent);
    if (service.status === "unavailable" || (efficiency !== null && efficiency < 50)) {
      candidates.push({
        kind,
        domain: "safety",
        priority,
        severity: "high",
        urgency: 80,
        affectedCount: finite(service.buildingCount),
        source: `snapshot.cityServices.${field}`,
        key: kind,
        actionable: false,
        confidence: "structured",
        targets: [],
        message: `${label} has a structured service deficit; automatic repair is not supported`,
      });
    }
  }
  for (const issue of [
    notificationIssue(
      root,
      "worker_shortage",
      "economy",
      2,
      "medium",
      55,
      /worker|uneducated/i,
      "Worker shortage notification detected; observing only",
    ),
    notificationIssue(
      root,
      "abandoned_buildings",
      "operations",
      2,
      "medium",
      60,
      /abandoned|condemned/i,
      "Abandoned or condemned building notification detected; observing only",
    ),
  ]) {
    if (issue) candidates.push(issue);
  }
  const economy = record(root.economy);
  const treasury = finite(economy.treasury);
  const monthlyBalance = finite(economy.monthlyBalance);
  if (treasury !== null && monthlyBalance !== null && monthlyBalance < 0 && treasury / Math.abs(monthlyBalance) < 3) {
    candidates.push({
      kind: "finance_runway",
      domain: "economy",
      priority: 2,
      severity: "high",
      urgency: 90,
      affectedCount: null,
      source: "snapshot.economy",
      key: "finance_runway",
      actionable: false,
      confidence: "authoritative",
      targets: [],
      message: "Finance runway is critical; noncritical growth is suppressed",
    });
  }
  const current = candidates
    .map((issue) => mergePersistence(issue, previous, observationTime(root)))
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        severityRank[right.severity] - severityRank[left.severity] ||
        right.urgency - left.urgency ||
        right.persistence - left.persistence ||
        left.key.localeCompare(right.key),
    )
    .slice(0, MAX_ISSUES);
  return { current, highest: current[0] ?? null };
}
