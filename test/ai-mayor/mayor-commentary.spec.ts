import { renderMayorEvent, resetMayorCommentaryForTests, type MayorEvent } from "../../src/main/services/ai-mayor/mayor-commentary";

describe("local Mayor Commentary", () => {
  beforeEach(resetMayorCommentaryForTests);

  test("composes a grounded expansion chain without exposing event keys", () => {
    const events: MayorEvent[] = [
      { eventType: "PREPARE", toneHint: "NEUTRAL", subjectDomain: "GRID", observationKey: "grid-aligned",
        actionKey: "prepare-grid", reasonKey: "safe-expansion-window", continuityRef: "internal-goal" },
      { eventType: "ACT_START", toneHint: "NEUTRAL", subjectDomain: "GRID", actionKey: "extend-grid" },
      { eventType: "ACT_SUCCESS", toneHint: "NEUTRAL", subjectDomain: "GRID", resultKey: "road-confirmed" },
      { eventType: "BLOCK_COMPLETE", toneHint: "NEUTRAL", subjectDomain: "GRID", resultKey: "batch-complete" },
    ];
    const lines = events.map((event) => renderMayorEvent(event)?.text);
    expect(lines).toEqual([
      "网格方向已经定了，按网格往外接。",
      "按网格往外接。",
      "这段对齐了。",
      "这一小片，弄好了。",
    ]);
    expect(lines.join(" ")).not.toMatch(/internal-goal|command|status|journal|ERROR|FAILED/);
  });

  test("throttles an unchanged blocker and gives critical truth a direct line", () => {
    const wait: MayorEvent = { eventType: "WAIT", toneHint: "CASUAL", subjectDomain: "GENERIC",
      actionKey: "wait-for-world", reasonKey: "no-legal-site" };
    expect(renderMayorEvent(wait)).not.toBeNull();
    expect(renderMayorEvent(wait)).toBeNull();
    const critical = renderMayorEvent({ eventType: "HARD_STOP", toneHint: "CRITICAL", subjectDomain: "GENERIC",
      reasonKey: "authoritative-uncertain" });
    expect(critical?.text).toContain("为避免重复效果");
    expect(critical?.text).not.toMatch(/嗯|哎|哈/);
  });

  test("does not repeat the exact same line inside its recent expression window", () => {
    const event: MayorEvent = { eventType: "ACT_SUCCESS", toneHint: "NEUTRAL", subjectDomain: "GRID",
      resultKey: "road-confirmed" };
    const first = renderMayorEvent(event)?.text;
    const second = renderMayorEvent({ ...event, continuityRef: "another-build" })?.text;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  test("deduplicates captions across event types in the visible stream", () => {
    const first = renderMayorEvent({ eventType: "PREPARE", toneHint: "NEUTRAL", subjectDomain: "GRID",
      actionKey: "extend-grid", continuityRef: "goal-a" })?.text;
    const second = renderMayorEvent({ eventType: "ACT_START", toneHint: "NEUTRAL", subjectDomain: "GRID",
      actionKey: "extend-grid", continuityRef: "goal-b" })?.text;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
