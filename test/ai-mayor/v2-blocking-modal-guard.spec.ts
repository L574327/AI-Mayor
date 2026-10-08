import {
  checkBlockingModal,
  type BlockingModalGuardEvidence,
  type BlockingModalObservation,
  type BlockingModalSurface,
} from "../../src/main/services/ai-mayor/v2/blocking-modal-guard";

function surface(observations: Array<BlockingModalObservation | null>, dismissError = false): BlockingModalSurface & { dismissCount: number } {
  let index = 0;
  const value = {
    dismissCount: 0,
    async observe() {
      return observations[Math.min(index++, observations.length - 1)] ?? null;
    },
    async dismissKnownMilestone() {
      value.dismissCount += 1;
      if (dismissError) throw new Error("dismiss failed");
    },
  };
  return value;
}

function journal() {
  const entries: BlockingModalGuardEvidence[] = [];
  return { entries, append(entry: BlockingModalGuardEvidence) { entries.push(entry); } };
}

const known = (identity = "native.progression.milestone") => ({
  identity,
  type: "MILESTONE",
  blocking: true,
  displayText: "Small Town",
  detectionSource: "AUTHORITATIVE_UI_MODEL",
  runtimeCorrelation: "runtime-1",
});

describe("bounded blocking modal guard", () => {
  test("no modal allows progress without an action", async () => {
    const log = journal();
    const result = await checkBlockingModal({ surface: surface([null]), journal: log, checkId: () => "check-1", now: () => "time-1" });
    expect(result.allowedToContinue).toBe(true);
    expect(result.modalClass).toBe("NO_MODAL");
    expect(result.evidence.dismissAttempted).toBe(false);
    expect(log.entries).toHaveLength(1);
  });

  test("known milestone identity is detected and dismissed exactly once", async () => {
    const target = surface([known(), null]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"], checkId: () => "check-2" });
    expect(result.allowedToContinue).toBe(true);
    expect(result.modalClass).toBe("KNOWN_SAFE_DISMISSIBLE_MODAL");
    expect(target.dismissCount).toBe(1);
    expect(result.evidence.dismissMethod).toBe("EXPLICIT_ALLOWLISTED_MILESTONE_ACTION");
    expect(result.evidence.verificationObservation).toBeNull();
  });

  test("failed dismiss fails closed", async () => {
    const target = surface([known(), known()], true);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"] });
    expect(result.allowedToContinue).toBe(false);
    expect(result.evidence.dismissAttempted).toBe(true);
    expect(result.evidence.dismissSucceeded).toBe(false);
  });

  test("modal remaining after dismiss fails closed", async () => {
    const target = surface([known(), known()]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"] });
    expect(result.allowedToContinue).toBe(false);
    expect(result.evidence.dismissSucceeded).toBe(false);
    expect(result.evidence.verificationObservation?.identity).toBe("native.progression.milestone");
  });

  test("unknown blocking modal records evidence and performs no action", async () => {
    const target = surface([{ identity: "native.save.overwrite", type: "CONFIRMATION", blocking: true, detectionSource: "AUTHORITATIVE_UI_MODEL" }]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"] });
    expect(result.allowedToContinue).toBe(false);
    expect(result.modalClass).toBe("UNKNOWN_BLOCKING_MODAL");
    expect(target.dismissCount).toBe(0);
    expect(log.entries[0].modalIdentity).toBe("native.save.overwrite");
  });

  test("display language does not change stable allowlist identity", async () => {
    const target = surface([{ ...known(), displayText: "新兴城镇" }, null]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"] });
    expect(result.allowedToContinue).toBe(true);
    expect(target.dismissCount).toBe(1);
  });

  test("non-blocking UI is not dismissed", async () => {
    const target = surface([{ ...known(), blocking: false }]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"] });
    expect(result.allowedToContinue).toBe(true);
    expect(result.modalClass).toBe("NON_BLOCKING_UI");
    expect(target.dismissCount).toBe(0);
  });

  test("journal evidence contains the complete bounded record", async () => {
    const log = journal();
    await checkBlockingModal({ surface: surface([known(), null]), journal: log, allowedMilestoneIdentities: ["native.progression.milestone"], checkId: () => "check-3", now: () => "time-3" });
    expect(log.entries[0]).toMatchObject({
      modalGuardCheckId: "check-3",
      detected: true,
      modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL",
      modalIdentity: "native.progression.milestone",
      detectionSource: "AUTHORITATIVE_UI_MODEL",
      dismissAttempted: true,
      dismissSucceeded: true,
      timestamp: "time-3",
      runtimeCorrelation: "runtime-1",
    });
  });

  test("empty allowlist fails closed for a milestone-shaped observation", async () => {
    const target = surface([known()]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log });
    expect(result.modalClass).toBe("UNKNOWN_BLOCKING_MODAL");
    expect(target.dismissCount).toBe(0);
  });

  test("repeated identity does not trigger an unbounded second dismiss", async () => {
    const target = surface([known(), null, known()]);
    const log = journal();
    const handled = new Set<string>();
    const first = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"], handledModalIdentities: handled });
    const second = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"], handledModalIdentities: handled });
    expect(first.allowedToContinue).toBe(true);
    expect(second.allowedToContinue).toBe(false);
    expect(second.modalClass).toBe("UNKNOWN_BLOCKING_MODAL");
    expect(target.dismissCount).toBe(1);
  });

  test("victory milestone is never classified safe or dismissed", async () => {
    const target = surface([{ ...known(), isVictory: true }, null]);
    const log = journal();
    const result = await checkBlockingModal({
      surface: target,
      journal: log,
      allowedMilestoneIdentities: ["native.progression.milestone"],
    });
    expect(result.allowedToContinue).toBe(false);
    expect(result.modalClass).toBe("UNKNOWN_BLOCKING_MODAL");
    expect(target.dismissCount).toBe(0);
  });

  test("with automatic closing switched off the popup is the player's: it is never dismissed, and the run continues once they close it", async () => {
    // The player closes it on the third look.
    const target = surface([known(), known(), null]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"],
      autoDismiss: () => false, sleep: async () => undefined, pollMs: 1, waitForPlayerMs: 60_000 });
    expect(target.dismissCount).toBe(0);
    expect(result.allowedToContinue).toBe(true);
    expect(result.evidence.dismissAttempted).toBe(false);
    expect(result.evidence.dismissMethod).toBe("PLAYER_DISMISS_EXPECTED");
    expect(result.evidence.dismissSucceeded).toBe(true);
  });

  test("with automatic closing switched off, a popup the player never closes stops the run instead of being closed for them", async () => {
    const target = surface([known()]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log, allowedMilestoneIdentities: ["native.progression.milestone"],
      autoDismiss: () => false, sleep: async () => undefined, pollMs: 1, waitForPlayerMs: 0 });
    expect(target.dismissCount).toBe(0);
    expect(result.allowedToContinue).toBe(false);
    expect(result.evidence.dismissSucceeded).toBe(false);
  });

  test("an unknown popup is never dismissed whatever the switch says", async () => {
    const target = surface([{ identity: "native.save.overwrite", type: "CONFIRMATION", blocking: true, detectionSource: "AUTHORITATIVE_UI_MODEL" }]);
    const result = await checkBlockingModal({ surface: target, journal: journal(), autoDismiss: () => true });
    expect(result.allowedToContinue).toBe(false);
    expect(target.dismissCount).toBe(0);
  });

  test("unavailable detection surface fails closed instead of becoming NO_MODAL", async () => {
    const target = surface([{ identity: null, type: "UI_SURFACE_UNAVAILABLE", blocking: true, surfaceAvailable: false, detectionSource: "version mismatch" }]);
    const log = journal();
    const result = await checkBlockingModal({ surface: target, journal: log });
    expect(result.allowedToContinue).toBe(false);
    expect(result.modalClass).toBe("UNKNOWN_BLOCKING_MODAL");
    expect(target.dismissCount).toBe(0);
  });
});
