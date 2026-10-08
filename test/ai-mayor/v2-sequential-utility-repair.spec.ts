import {
  advanceSequentialUtilityRepair,
  evaluateSegment2PostApplyTopology,
  type SequentialRepairCandidate,
  type SequentialRepairObservation,
  type SequentialRepairPreview,
  type SequentialRepairState,
  type SequentialUtilityRepairPorts,
} from "../../src/main/services/ai-mayor/v2/sequential-utility-repair";

const candidate = (index: 1 | 2, prior?: Readonly<Record<string, unknown>>): SequentialRepairCandidate => ({
  index, worldId: "world-current", generation: "generation-current",
  actionId: `action-${index}`, commandId: `command-${index}`, authorizationId: `authorization-${index}`,
  utility: "electricity", prefab: "Low-voltage Ground Cable",
  geometry: { x1: index === 1 ? -1247.76172 : Number(prior?.endX), z1: index === 1 ? 139.237488 : Number(prior?.endZ),
    x2: index === 1 ? -737.33536 : -226.909, z2: index === 1 ? 727.868744 : 1316.5 },
});
const topology = (index: 1 | 2, failed?: string) => ({
  checks: Object.fromEntries((index === 1
    ? ["sourceComponentReachable", "newCurrentGenerationEdge", "midpointTerminalBound", "sourceSideConnection", "noUnintendedDuplicate"]
    : ["sourceComponentReachable", "segment1ChainConnected", "segment2CurrentGenerationEdge", "targetJoinPresent", "sourceToTargetNetworkReachable", "localRoadComponentReached", "pumpElectricityPathReached", "noUnintendedDuplicate"]
  ).map((key) => [key, key === failed ? "FAIL" : "PASS"])) as Record<string, "PASS" | "FAIL">,
  evidence: { worldId: "world-current", generation: "generation-current", bindingStatus: "VALID" },
});
const previewTopology = (index: 1 | 2) => ({
  topologyChecks: Object.fromEntries((index === 1
    ? ["sourceComponentReachable", "exactSourceEndpointBound", "sourceAttachmentMatch", "freeMidpointEndpoint", "noUnintendedDuplicate"]
    : ["sourceComponentReachable", "segment1ChainConnected", "midpointTerminalBound", "targetAttachmentMatch", "noUnintendedDuplicate"]
  ).map((key) => [key, "PASS"])) as Record<string, "PASS">,
  worldId: "world-current", generation: "generation-current",
});

function harness(overrides: Partial<SequentialUtilityRepairPorts> = {}) {
  let durable: SequentialRepairState | null = null;
  let effect: SequentialRepairObservation = { effect: "PASS", topology: topology(1), realized: { endX: -737.33536, endZ: 727.868744 } };
  const calls: string[] = [];
  const order: string[] = [];
  const ports: SequentialUtilityRepairPorts = {
    load: async () => durable,
    save: async (state) => { durable = structuredClone(state); order.push(`save:${state.actions.map((a) => a.state).join(",")}`); },
    rebind: async (index, prior) => { calls.push(`rebind:${index}`); order.push(`rebind:${index}:${durable?.actions[0]?.state ?? "none"}`); return candidate(index, prior); },
    preview: async (value) => { calls.push(`preview:${value.index}`); order.push(`preview:${value.index}:${durable?.actions[0]?.state ?? "none"}`); return { valid: true, quote: 792, duplicate: false, ...previewTopology(value.index) }; },
    admit: async (value, quote) => { calls.push(`admit:${value.index}:${quote}`); order.push(`admit:${value.index}`); return {
      admitted: true, actionFingerprint: JSON.stringify(value.action ? [value.action] : []), quote,
      worldId: value.worldId, generation: value.generation,
    }; },
    authorize: async ({ candidate: value, quote }) => { calls.push(`authorize:${value.index}:${value.authorizationId}:${quote}`); return {
      actionId: value.actionId, authorizationId: value.authorizationId, quote, singleUse: true,
    }; },
    submit: async ({ candidate: value }) => { calls.push(`submit:${value.index}:${value.commandId}`); return { commandId: value.commandId, nativeCallCount: 1 }; },
    observe: async ({ candidate: value }) => { calls.push(`observe:${value.index}:${value.commandId}`); return value.index === 1 ? effect : {
      ...effect, topology: topology(2), realized: { endX: -226.909, endZ: 1316.5 },
    }; },
    reconcileDuplicate: async ({ candidate: value }) => { calls.push(`reconcile-duplicate:${value.index}`); return value.index === 1 ? effect : {
      ...effect, topology: topology(2), realized: { endX: -226.909, endZ: 1316.5 },
    }; },
    ...overrides,
  };
  return { ports, calls, order, setEffect(value: SequentialRepairObservation) { effect = value; }, get state() { return durable; } };
}

describe("state-aware sequential utility repair", () => {
  test("source-to-cable-terminal reachability does not imply target join or Pump reachability", () => {
    const result = evaluateSegment2PostApplyTopology({
      cableEffectPresent: true, midpointJoinPresent: true, targetJoinPresent: false,
      sourceToSegment2TerminalReachable: true, sourceToTargetNetworkReachable: false,
      noUnintendedDuplicate: true,
    });
    expect(result.checks.sourceComponentReachable).toBe("PASS");
    expect(result.checks.segment2CurrentGenerationEdge).toBe("PASS");
    expect(result.checks.targetJoinPresent).toBe("FAIL");
    expect(result.checks.sourceToTargetNetworkReachable).toBe("FAIL");
    expect(result.checks.pumpElectricityPathReached).toBe("FAIL");
    expect(result.pass).toBe(false);
  });

  test("requires both the target join and actual target-network reachability", () => {
    const targetReachWithoutJoin = evaluateSegment2PostApplyTopology({
      cableEffectPresent: true, midpointJoinPresent: true, targetJoinPresent: false,
      sourceToSegment2TerminalReachable: true, sourceToTargetNetworkReachable: true,
      noUnintendedDuplicate: true,
    });
    const targetJoinWithoutReach = evaluateSegment2PostApplyTopology({
      cableEffectPresent: true, midpointJoinPresent: true, targetJoinPresent: true,
      sourceToSegment2TerminalReachable: true, sourceToTargetNetworkReachable: false,
      noUnintendedDuplicate: true,
    });
    expect(targetReachWithoutJoin.pass).toBe(false);
    expect(targetJoinWithoutReach.pass).toBe(false);
  });

  test("cannot issue action 2 before action 1 world effect and topology pass", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.calls.some((call) => call.includes(":2"))).toBe(false);
    expect(h.state?.actions[0]).toMatchObject({ state: "COMPLETE" });
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.calls).toContain("submit:2:command-2");
  });

  test("freshly previews action 2 after action 1 topology is observed", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.order.indexOf("preview:2:COMPLETE")).toBeGreaterThan(h.order.indexOf("save:COMPLETE"));
  });

  test("never accepts a pre-action-1 action-2 preview as authority", async () => {
    const h = harness();
    const first = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(first.status).toBe("WAITING");
    expect(h.calls.filter((call) => call.startsWith("preview:"))).toEqual(["preview:1"]);
    const second = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(second.status).toBe("COMPLETE");
    expect(h.calls.filter((call) => call.startsWith("preview:"))).toEqual(["preview:1", "preview:2"]);
  });

  test("step 2 runs fresh production Admission but cannot preauthorize", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports, stopBeforeStep2Authorization: true });
    const second = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports, stopBeforeStep2Authorization: true });
    expect(second.status).toBe("WAITING");
    expect(h.calls).toContain("admit:2:792");
    expect(h.calls).not.toContain("authorize:2:authorization-2:792");
    expect(h.calls).not.toContain("submit:2:command-2");
  });

  test("explicit step 2 authorization refreshes rebind and preview before Admission, authorization, and one submit", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports, stopBeforeStep2Authorization: true });
    const preflight = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports, stopBeforeStep2Authorization: true });
    expect(preflight.status).toBe("WAITING");

    const executed = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports,
      expectedQuoteByStep: { 2: 792 }, refreshBeforeStep2Authorization: true });
    expect(executed.status).toBe("COMPLETE");
    const calls = h.calls;
    expect(calls.filter((call) => call.startsWith("rebind:2"))).toHaveLength(2);
    expect(calls.lastIndexOf("rebind:2")).toBeLessThan(calls.lastIndexOf("preview:2"));
    expect(calls.lastIndexOf("preview:2")).toBeLessThan(calls.lastIndexOf("admit:2:792"));
    expect(calls.lastIndexOf("admit:2:792")).toBeLessThan(calls.lastIndexOf("authorize:2:authorization-2:792"));
    expect(calls.lastIndexOf("authorize:2:authorization-2:792")).toBeLessThan(calls.lastIndexOf("submit:2:command-2"));
    expect(calls.filter((call) => call === "submit:2:command-2")).toHaveLength(1);
  });

  test("action 1 failure blocks action 2", async () => {
    const h = harness();
    h.setEffect({ effect: "FAIL", topology: topology(1), realized: { endX: 0, endZ: 0 } });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(h.calls.some((call) => call.includes(":2"))).toBe(false);
  });

  test("duplicate/effect reconciliation never submits action 1 twice", async () => {
    const h = harness();
    let submits = 0;
    const submit = h.ports.submit;
    h.ports.submit = async (input) => { submits++; await submit(input); throw new Error("transport lost after native call"); };
    const first = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(first.status).toBe("WAITING");
    h.ports.submit = submit;
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(submits).toBe(1);
    expect(h.calls.filter((call) => call === "observe:1:command-1")).toHaveLength(1);
  });

  test("a pre-existing matching effect is reconciled and never recreated", async () => {
    const h = harness();
    const preview = h.ports.preview;
    h.ports.preview = async (value) => ({ ...await preview(value), duplicate: value.index === 1 });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("WAITING");
    expect(h.calls).toContain("reconcile-duplicate:1");
    expect(h.calls).not.toContain("authorize:1:authorization-1:792");
    expect(h.calls).not.toContain("submit:1:command-1");
    expect(result.state.actions[0]).toMatchObject({ state: "COMPLETE" });
  });

  test("each action receives distinct authorization and command identity", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.calls.filter((call) => call.startsWith("authorize:"))).toEqual([
      "authorize:1:authorization-1:792", "authorize:2:authorization-2:792",
    ]);
    expect(h.calls.filter((call) => call.startsWith("submit:"))).toEqual(["submit:1:command-1", "submit:2:command-2"]);
  });

  test("production Admission is before authorization and binds the exact action and quote", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.calls.indexOf("admit:1:792")).toBeLessThan(h.calls.indexOf("authorize:1:authorization-1:792"));
    expect(h.calls.indexOf("authorize:1:authorization-1:792")).toBeLessThan(h.calls.indexOf("submit:1:command-1"));
  });

  test("failed Admission never calls authorization or submit", async () => {
    const h = harness({ admit: async () => { throw new Error("outside_exact_scope"); } });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(h.calls.some((call) => call.startsWith("authorize:"))).toBe(false);
    expect(h.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });

  test("step 1 can persist a production admission result before conditional authorization", async () => {
    const h = harness();
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", stopAfterStep1Admission: true, ports: h.ports });
    expect(result.status).toBe("WAITING");
    expect(result.reason).toBe("ACTION_1_PRODUCTION_ADMISSION_COMPLETE_AUTHORIZATION_NOT_REQUESTED");
    expect(result.state.actions[0]).toMatchObject({ state: "CERTIFIED", quote: 792 });
    expect(h.calls.indexOf("admit:1:792")).toBeGreaterThanOrEqual(0);
    expect(h.calls.some((call) => call.startsWith("authorize:"))).toBe(false);
    expect(h.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });

  test("material quote change stops before Admission and authorization", async () => {
    const h = harness();
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", expectedQuoteByStep: { 1: 790 }, ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(result.reason).toContain("ACTION_1_QUOTE_CHANGED:790->792");
    expect(h.calls.some((call) => call.startsWith("admit:"))).toBe(false);
    expect(h.calls.some((call) => call.startsWith("authorize:"))).toBe(false);
  });

  test("changed action after Admission fails closed before native submission", async () => {
    const h = harness({ authorize: async ({ candidate: value, quote }) => {
      (value.geometry as Record<string, number>).x2 += 1;
      return { actionId: value.actionId, authorizationId: value.authorizationId, quote, singleUse: true };
    } });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(h.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });

  test("submits each native action separately and the contract has a hard count of two", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.calls.filter((call) => call.startsWith("submit:"))).toHaveLength(2);
    expect(h.state?.actionCount).toBe(2);
  });

  test("does not create an automatic third action", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    const after = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(after.status).toBe("COMPLETE");
    expect(h.calls.filter((call) => call.startsWith("rebind:"))).toEqual(["rebind:1", "rebind:2"]);
  });

  test("rebinds the current world between actions using action 1 realized geometry", async () => {
    const h = harness();
    let secondStart: unknown;
    const rebind = h.ports.rebind;
    h.ports.rebind = async (index, prior) => { if (index === 2) secondStart = prior; return rebind(index, prior); };
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(secondStart).toEqual({ endX: -737.33536, endZ: 727.868744 });
  });

  test("topology postcondition, not command return, gates continuation", async () => {
    const h = harness();
    h.setEffect({ effect: "PASS", topology: topology(1, "sourceSideConnection"), realized: { endX: 1, endZ: 1 }, reason: "source edge absent" });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(h.calls.some((call) => call.includes(":2"))).toBe(false);
  });

  test("recovers interruption between actions from durable state without changing action 1", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    const historical = structuredClone(h.state?.actions[0]);
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(h.state?.actions[0]).toEqual(historical);
    expect(h.calls.filter((call) => call === "submit:1:command-1")).toHaveLength(1);
  });

  test("action 1 stays immutable when action 2 fails fresh preview", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    const historical = structuredClone(h.state?.actions[0]);
    h.ports.preview = async () => ({ valid: false, quote: 0, duplicate: false,
      topologyChecks: {}, worldId: "world-current", generation: "generation-current", reason: "stale target" });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(h.state?.actions[0]).toEqual(historical);
    expect(h.calls).not.toContain("submit:2:command-2");
  });

  test("final completion requires source-to-local-road-to-Pump topology reachability", async () => {
    const h = harness();
    await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    h.ports.observe = async ({ candidate: value }) => ({ effect: "PASS", topology: topology(2, "pumpElectricityPathReached"),
      realized: { endX: -226.909, endZ: 1316.5 }, reason: "Pump remains outside the powered component" });
    const result = await advanceSequentialUtilityRepair({ repairId: "repair", ports: h.ports });
    expect(result.status).toBe("STOPPED");
    expect(result.state.status).toBe("STOPPED");
    expect(result.state.actions[0]?.state).toBe("COMPLETE");
  });
});
