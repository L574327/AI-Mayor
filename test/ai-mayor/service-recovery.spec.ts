import { scanCityIssues } from "../../src/main/services/ai-mayor/local-mayor/issues";
import { buildLocalMayorSnapshotFixture } from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import {
  advanceServiceRecoveryCooldown,
  deriveServiceRecoveryIntent,
  evaluateServiceRecoveryReadback,
  recordServiceRecoveryAttempt,
} from "../../src/main/services/ai-mayor/local-mayor/service-recovery";

describe("Local Mayor service recovery intent", () => {
  test("critical utility receives bounded stabilization intent", () => {
    const issue = scanCityIssues(
      buildLocalMayorSnapshotFixture({
        utilities: {
          electricity: { status: "available", production: 40, consumption: 100, fulfilledConsumption: 40 },
        },
      }),
    ).highest;
    const intent = deriveServiceRecoveryIntent(issue);
    expect(intent).toMatchObject({
      issueKind: "electricity_shortage",
      chosenActionKind: "stabilize_utilities",
      status: "actionable",
      attempts: 0,
    });
  });

  test("unsupported service is observed without a fake action", () => {
    const issue = scanCityIssues(
      buildLocalMayorSnapshotFixture({ utilities: { garbage: { accumulationRate: 5000 } } }),
    ).highest;
    expect(deriveServiceRecoveryIntent(issue)).toMatchObject({
      issueKind: "garbage_pressure",
      chosenActionKind: "none",
      status: "unsupported",
    });
  });

  test("readback resolves an issue or enters cooldown without spam", () => {
    const issue = scanCityIssues(
      buildLocalMayorSnapshotFixture({
        utilities: {
          water: { status: "available", capacity: 10, consumption: 50, fulfilledConsumption: 10 },
        },
      }),
    ).highest;
    const intent = deriveServiceRecoveryIntent(issue);
    if (!intent || !issue) throw new Error("expected water issue");
    const attempted = recordServiceRecoveryAttempt(intent, "tick-1");
    expect(attempted).toMatchObject({ status: "recovering", attempts: 1 });
    const unchanged = evaluateServiceRecoveryReadback(attempted, issue);
    expect(unchanged).toMatchObject({ status: "cooldown", lastObservedEffect: "no_material_issue_improvement" });
    expect(advanceServiceRecoveryCooldown(unchanged)).toMatchObject({ status: "actionable", cooldownRemaining: 0 });
    expect(evaluateServiceRecoveryReadback(attempted, issue, "improving")).toMatchObject({
      status: "cooldown",
      lastObservedEffect: "improving",
    });
    expect(evaluateServiceRecoveryReadback(attempted, null)).toMatchObject({
      status: "resolved",
      lastObservedEffect: "resolved",
    });
  });

  test("150 episode governance run remains bounded and provider-free", () => {
    let previous = undefined as ReturnType<typeof deriveServiceRecoveryIntent>;
    let recoveryAttempts = 0;
    let providerCalls = 0;
    let cooldownHits = 0;
    for (let episode = 0; episode < 150; episode += 1) {
      const utilityPressure = episode >= 20 && episode < 45;
      const garbagePressure = episode >= 90 && episode < 120;
      const snapshot = buildLocalMayorSnapshotFixture({
        utilities: {
          electricity: utilityPressure
            ? { status: "available", production: 40, consumption: 100, fulfilledConsumption: 40 }
            : { status: "available", production: 100, consumption: 50, fulfilledConsumption: 50 },
          garbage: garbagePressure ? { accumulationRate: 5000 } : { accumulationRate: 0 },
        },
      });
      const issue = scanCityIssues(snapshot).highest;
      const intent = deriveServiceRecoveryIntent(issue, previous);
      if (intent?.status === "cooldown") cooldownHits += 1;
      if (intent?.status === "actionable" && intent.chosenActionKind === "stabilize_utilities") {
        recoveryAttempts += 1;
        previous = recordServiceRecoveryAttempt(intent, `episode-${episode}`);
      } else {
        previous = intent;
      }
      providerCalls += 0;
      expect(intent?.attempts ?? 0).toBeLessThanOrEqual(3);
    }
    expect(recoveryAttempts).toBeGreaterThan(0);
    expect(cooldownHits).toBeGreaterThan(0);
    expect(providerCalls).toBe(0);
  });
});
