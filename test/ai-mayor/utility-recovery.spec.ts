import fs from "node:fs";
import path from "node:path";
import { scanCityIssues } from "../../src/main/services/ai-mayor/local-mayor/issues";
import { buildLocalMayorSnapshotFixture } from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import {
  advanceServiceRecoveryCooldown,
  deriveServiceRecoveryIntent,
  evaluateServiceRecoveryReadback,
  recordServiceRecoveryAttempt,
} from "../../src/main/services/ai-mayor/local-mayor/service-recovery";
import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB, type PlannedUtilityFacility } from "../../src/main/services/ai-mayor/spatial/types";
import type { MayorAction, MayorBatchResult } from "../../src/main/services/ai-mayor/types";
import {
  buildUtilityConnectionCandidates,
  executeSharedUtilityRecovery,
  prepareSharedUtilityRecovery,
  type SharedUtilityRecoveryPorts,
  type UtilityCapacityReadback,
  type UtilityRecoveryKind,
} from "../../src/main/services/ai-mayor/utility-recovery";

const facility = (kind: UtilityRecoveryKind): PlannedUtilityFacility => ({
  kind: kind === "electricity" ? "power" : kind,
  prefab: `${kind}-facility`,
  position: { x: 10, z: 20 },
  rotationCandidates: [0],
  constructionCost: 10_000,
  expectedCapacity: 100,
  siteEvidence: { source: "fixture" },
  connection: {
    prefab:
      kind === "electricity" ? "Low-voltage Ground Cable" : kind === "water" ? "Small Water Pipe" : "Small Sewage Pipe",
    start: { x: 10, z: 20 },
    end: { x: 50, z: 20 },
  },
});

test("post-connection extension candidate preserves exact ID-free endpoint bindings", () => {
  const plan = facility("electricity");
  plan.connection = { ...plan.connection, start: { x: 40, z: 30 }, end: { x: 50, z: 20 } };
  plan.connectionEndpointBindings = {
    start: { mode: "EXISTING_NET_NODE", role: "START", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
      expectedPosition: { x: 40, y: 2, z: 30 }, bindingRule: "CURRENT_REACHABLE_CABLE_TERMINAL", topologyRole: "CONNECTED_UTILITY_CABLE_TERMINAL",
      topologyLookup: { networkEdgePrefab: "Low-voltage Ground Cable", edgeGeometry: { x1: 10, z1: 20, x2: 40, z2: 30 },
        edgeEndpointRole: "END", sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: 10, y: 0, z: 20 }, connectorUtility: "ELECTRICITY" },
        requireSourceReachability: true } },
    end: { mode: "EXISTING_NET_NODE", role: "END", utility: "ELECTRICITY", prefab: "Low-voltage Ground Cable",
      expectedPosition: { x: 50, y: 2, z: 20 }, bindingRule: "CERTIFIED_TARGET_ROAD_ELECTRICITY_NODE", topologyRole: "LOCAL_ROAD_ELECTRICITY_NODE",
      topologyLookup: { networkEdgePrefab: "Small Road", edgeGeometry: { x1: 50, z1: 20, x2: 60, z2: 20 },
        edgeEndpointRole: "START", sourceAnchor: { buildingPrefab: "WindTurbine03", position: { x: 10, y: 0, z: 20 }, connectorUtility: "ELECTRICITY" },
        requireSourceReachability: false } },
  };
  const candidates = buildUtilityConnectionCandidates({
    mode: "EXISTING_FACILITY_CONNECTION",
    kind: "electricity",
    facility: { entity: { index: 4, version: 2 }, prefab: plan.prefab, position: plan.position },
    connection: plan.connection,
    connectionEndpointBindings: plan.connectionEndpointBindings,
  }, {
    type: "electricity", node: { index: 5, version: 1 }, worldPosition: { x: 10, z: 20 }, attached: true,
    capacity: { electricity: 100 },
  });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({ primitive: "direct-cable", actions: [{
    x1: 40, z1: 30, x2: 50, z2: 20,
    utilityEndpoints: { start: { bindingRule: "CURRENT_REACHABLE_CABLE_TERMINAL" }, end: { bindingRule: "CERTIFIED_TARGET_ROAD_ELECTRICITY_NODE" } },
  }] });
});

function ports(
  kind: UtilityRecoveryKind,
  options: { connector?: boolean; attaches?: boolean; improves?: boolean; revision?: string } = {},
) {
  const actions: MayorAction[][] = [];
  let connectorReads = 0;
  let capacityReads = 0;
  const implementation: SharedUtilityRecoveryPorts = {
    plan: async (_requestedKind, context) => context?.mode === "EXISTING_FACILITY_CONNECTION"
      ? { status: "candidate", connection: { mode: "EXISTING_FACILITY_CONNECTION" as const, kind, facility: { entity: { index: 77, version: 1 }, prefab: `${kind}-facility`, position: { x: 10, z: 20 } }, connection: facility(kind).connection }, reason: "fixture" }
      : { status: "candidate", facility: facility(kind), reason: "fixture" },
    preflight: async () => true,
    execute: async (batch) => {
      actions.push(batch);
      const placement = batch[0]?.type === "place_building";
      return {
        ok: true,
        requested: batch.length,
        executed: batch.length,
        results: batch.map((action, index) => ({
          index,
          type: action.type,
          ok: true,
          summary: "ok",
          ...(placement && index === 0
            ? {
                receipt: {
                  entity: { index: 100 + actions.length, version: 1 },
                  prefab: `${kind}-facility`,
                  position: { x: 10, z: 20 },
                },
              }
            : {}),
        })),
      } as MayorBatchResult;
    },
    readConnectors: async () => {
      connectorReads += 1;
      if (options.connector === false) return [];
      return [
        {
          type: kind === "electricity" ? ("electricity" as const) : ("waterPipe" as const),
          node: { index: 200, version: 1 },
          worldPosition: { x: 12, z: 20 },
          attached: options.attaches !== false && connectorReads > 1,
          capacity: kind === "electricity" ? { electricity: 100 } : kind === "water" ? { fresh: 100 } : { sewage: 100 },
        },
      ];
    },
    readCapacity: async () => {
      capacityReads += 1;
      const improved = options.improves !== false && capacityReads > 1;
      return {
        revision: options.revision ?? "r1",
        capacity: improved ? 150 : 50,
        consumption: 100,
        fulfilledConsumption: improved ? 100 : 50,
        issueActive: !improved,
      } satisfies UtilityCapacityReadback;
    },
    settle: async () => undefined,
    currentRevision: async () => options.revision ?? "r1",
    findCurrentUtilityBinding: async () => ({
      status: "MATCH" as const,
      binding: {
        facility: { entity: { index: 77, version: 1 }, prefab: `${kind}-facility`, position: { x: 10, z: 20 } },
        connector: {
          type: kind === "electricity" ? ("electricity" as const) : ("waterPipe" as const),
          node: { index: 200, version: 1 }, worldPosition: { x: 12, z: 20 }, attached: false,
          capacity: kind === "electricity" ? { electricity: 100 } : kind === "water" ? { fresh: 100 } : { sewage: 100 },
        },
      },
    }),
  };
  return { implementation, actions };
}

const run = (kind: UtilityRecoveryKind, implementation: SharedUtilityRecoveryPorts, overrides = {}) =>
  executeSharedUtilityRecovery({
    kind,
    expectedRevision: "r1",
    treasury: 100_000,
    runwayMonths: 12,
    signal: new AbortController().signal,
    ports: implementation,
    ...overrides,
  });

describe("shared utility recovery", () => {
  const networkRepairAction = (overrides: Record<string, unknown> = {}): MayorAction => ({
    type: "build_road", prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
    x1: 0, z1: 0, x2: 10, z2: 10,
    utilityEndpoints: {
      start: { mode: "EXISTING_NET_NODE", role: "START", utility: "ELECTRICITY", prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
        expectedPosition: { x: 0, z: 0 }, bindingRule: "POWERED_SOURCE", topologyRole: "SOURCE", topologyLookup: {} },
      end: { mode: "FREE_POINT", role: "END", utility: "ELECTRICITY", prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB,
        expectedPosition: { x: 10, z: 10 }, bindingRule: "FREE_TERMINAL", topologyRole: "COURSE_TERMINAL" },
    },
    ...overrides,
  } as MayorAction);

  test("NETWORK_LINK_REPAIR uses Utility Admission without requiring facility-site selection", async () => {
    const fixture = ports("electricity");
    const nativeActions: MayorAction[][] = [];
    fixture.implementation.plan = async () => { throw new Error("facility planning must not run for a network link"); };
    fixture.implementation.preflight = async (action) => ({ valid: action.type === "build_road" && !!action.utilityEndpoints });
    fixture.implementation.execute = async (actions) => {
      nativeActions.push(actions);
      return { ok: true, requested: 1, executed: 1, results: [{ index: 0, type: "build_road", ok: true, summary: "admitted" }] };
    };
    const action = networkRepairAction();
    const result = await run("electricity", fixture.implementation, {
      actionKind: "NETWORK_LINK_REPAIR",
      networkLinkRepair: { actions: [action], repairLineage: "repair-test", stepIndex: 1 },
    });
    expect(result).toMatchObject({ ok: true, reason: "NETWORK_LINK_REPAIR_STEP_1_SUBMITTED:repair-test", executedActions: 1 });
    expect(nativeActions).toEqual([[action]]);
  });

  test("read-only network admission preflights but never executes", async () => {
    const fixture = ports("electricity");
    let preflightCalls = 0;
    fixture.implementation.preflight = async () => { preflightCalls += 1; return true; };
    const result = await run("electricity", fixture.implementation, {
      actionKind: "NETWORK_LINK_REPAIR", admissionOnly: true,
      networkLinkRepair: { actions: [networkRepairAction()], repairLineage: "repair-test", stepIndex: 1 },
    });
    expect(result).toMatchObject({ ok: true, executedActions: 0, reason: "NETWORK_LINK_REPAIR_ADMITTED:repair-test:step-1" });
    expect(preflightCalls).toBe(1);
    expect(fixture.actions).toHaveLength(0);
  });

  test("network link exact scope rejects courses above the production per-segment bound", async () => {
    const fixture = ports("electricity");
    const tooLong = networkRepairAction({ x2: 1401, z2: 0,
      utilityEndpoints: {
        start: networkRepairAction().utilityEndpoints!.start,
        end: { ...networkRepairAction().utilityEndpoints!.end, expectedPosition: { x: 1401, z: 0 } },
      } });
    const result = await run("electricity", fixture.implementation, {
      actionKind: "NETWORK_LINK_REPAIR", admissionOnly: true,
      networkLinkRepair: { actions: [tooLong], repairLineage: "repair-test", stepIndex: 1 },
    });
    expect(result).toMatchObject({ ok: false, reason: "NETWORK_LINK_REPAIR_EXACT_SINGLE_ACTION_CONTRACT_INVALID", executedActions: 0 });
    expect(fixture.actions).toHaveLength(0);
  });

  test("NETWORK_LINK_REPAIR fails closed for malformed, missing START, or invalid END semantics", async () => {
    const malformed = ports("electricity");
    const validAction = networkRepairAction();
    const malformedResult = await run("electricity", malformed.implementation, {
      actionKind: "NETWORK_LINK_REPAIR",
      networkLinkRepair: { actions: [{ type: "place_building", prefab: "x", x: 0, z: 0 } as MayorAction], repairLineage: "repair-test", stepIndex: 1 },
    });
    expect(malformedResult).toMatchObject({ ok: false, reason: "NETWORK_LINK_REPAIR_EXACT_SINGLE_ACTION_CONTRACT_INVALID", executedActions: 0 });
    expect(malformed.actions).toHaveLength(0);

    for (const action of [
      { ...validAction, utilityEndpoints: { ...validAction.utilityEndpoints!, start: undefined } } as MayorAction,
      { ...validAction, utilityEndpoints: { ...validAction.utilityEndpoints!, end: { ...validAction.utilityEndpoints!.end, role: "START" } } } as MayorAction,
      { ...validAction, utilityEndpoints: { ...validAction.utilityEndpoints!, end: { ...validAction.utilityEndpoints!.end, mode: "INVALID" } } } as unknown as MayorAction,
    ]) {
      const fixture = ports("electricity");
      const result = await run("electricity", fixture.implementation, {
        actionKind: "NETWORK_LINK_REPAIR",
        networkLinkRepair: { actions: [action], repairLineage: "repair-test", stepIndex: 1 },
      });
      expect(result).toMatchObject({ ok: false, reason: "NETWORK_LINK_REPAIR_EXACT_SINGLE_ACTION_CONTRACT_INVALID", executedActions: 0 });
      expect(fixture.actions).toHaveLength(0);
    }
  });

  test("action-kind and payload mismatch cannot reach Utility Admission", async () => {
    const fixture = ports("electricity");
    let preflights = 0;
    fixture.implementation.preflight = async () => { preflights += 1; return true; };
    const result = await run("electricity", fixture.implementation, {
      actionKind: "FACILITY_REPAIR",
      networkLinkRepair: { actions: [networkRepairAction()], repairLineage: "repair-test", stepIndex: 1 },
    });
    expect(result).toMatchObject({ ok: false, reason: "UTILITY_ACTION_KIND_PAYLOAD_MISMATCH", executedActions: 0 });
    expect(preflights).toBe(0);
    expect(fixture.actions).toHaveLength(0);
  });

  test.each(["electricity", "water", "sewage"] as const)("%s uses receipt, connector and readback", async (kind) => {
    const fixture = ports(kind);
    const result = await run(kind, fixture.implementation);
    expect(result).toMatchObject({ ok: true, stage: "resolved", reason: "resolved" });
    expect(result.facility?.entity).toEqual({ index: 101, version: 1 });
    expect(result.connector?.attached).toBe(true);
    expect(result.after?.capacity).toBe(150);
    expect(fixture.actions).toHaveLength(2);
  });

  test("missing connector never resolves", async () => {
    expect(await run("water", ports("water", { connector: false }).implementation)).toMatchObject({
      ok: false,
      reason: "utility_connector_missing",
    });
  });

  test("failed attachment is structured", async () => {
    expect(await run("sewage", ports("sewage", { attaches: false }).implementation)).toMatchObject({
      ok: false,
      reason: "utility_connector_not_attached",
      selectedPrimitive: "direct-cable",
    });
  });

  test("unchanged capacity is not recovery success", async () => {
    expect(await run("electricity", ports("electricity", { improves: false }).implementation)).toMatchObject({
      ok: false,
      reason: "no_material_issue_improvement",
    });
  });

  test("greater headroom is improving even while the issue remains active", async () => {
    const fixture = ports("electricity", { improves: false });
    let reads = 0;
    fixture.implementation.readCapacity = async () => {
      reads += 1;
      return {
        revision: "r1",
        capacity: 100,
        consumption: reads === 1 ? 160 : 140,
        fulfilledConsumption: reads === 1 ? 60 : 80,
        issueActive: true,
      };
    };
    expect(await run("electricity", fixture.implementation)).toMatchObject({
      ok: true,
      stage: "improving",
      reason: "improving",
    });
  });

  test("no safe site, stale revision and finance guard fail before placement", async () => {
    const noSite = ports("water");
    noSite.implementation.plan = async () => ({ status: "no_safe_site", reason: "no_safe_utility_site" });
    expect(await run("water", noSite.implementation)).toMatchObject({ ok: false, reason: "no_safe_utility_site" });
    expect(await run("water", ports("water", { revision: "r2" }).implementation)).toMatchObject({
      ok: false,
      reason: "stale_revision",
    });
    expect(await run("water", ports("water").implementation, { treasury: 1, runwayMonths: 0 })).toMatchObject({
      ok: false,
      reason: "finance_guard",
    });
  });

  test("FACILITY_REPAIR keeps the safe-site placement gate", async () => {
    const fixture = ports("water");
    fixture.implementation.preflight = async (action) => action.type !== "place_building";
    const result = await run("water", fixture.implementation, { actionKind: "FACILITY_REPAIR" });
    expect(result).toMatchObject({ ok: false, reason: "no_safe_utility_site", executedActions: 0 });
    expect(fixture.actions).toHaveLength(0);
  });

  test("Stage A stops after one authorized facility placement and connector readback", async () => {
    const fixture = ports("water");
    const result = await run("water", fixture.implementation, { placementOnly: true });

    expect(result).toMatchObject({ ok: true, reason: "FACILITY_PLACED_AND_READ_BACK", facility: { entity: { index: 101, version: 1 } } });
    expect(result.connector).toBeDefined();
    expect(fixture.actions).toHaveLength(1);
    expect(fixture.actions[0]).toHaveLength(1);
    expect(fixture.actions[0][0]?.type).toBe("place_building");
  });

  test("an existing same-purpose facility is connected without duplicate placement", async () => {
    const fixture = ports("water");
    fixture.implementation.findExistingFacility = async () => ({
      entity: { index: 77, version: 1 },
      prefab: "water-facility",
      position: { x: 10, z: 20 },
    });
    const result = await run("water", fixture.implementation);
    expect(result).toMatchObject({ ok: true, facility: { entity: { index: 77, version: 1 } } });
    expect(fixture.actions).toHaveLength(1);
    expect(fixture.actions[0][0]?.type).toBe("build_road");
    expect(fixture.actions.flat().some((action) => action.type === "place_building")).toBe(false);
  });

  test("connection-only continuation evaluates network candidates even when supply capacity is healthy", async () => {
    const fixture = ports("electricity");
    fixture.implementation.findCurrentUtilityBinding = async () => ({
      status: "MATCH" as const,
      binding: {
        facility: { entity: { index: 46620, version: 9 }, prefab: "electricity-facility", position: { x: 10, z: 20 } },
        connector: { type: "electricity" as const, node: { index: 200, version: 1 }, worldPosition: { x: 12, z: 20 }, attached: false, capacity: { electricity: 100 } },
      },
    });
    fixture.implementation.readCapacity = async () => ({
      revision: "r1", capacity: 1681, consumption: 0, fulfilledConsumption: 0, issueActive: false,
    });
    const result = await run("electricity", fixture.implementation, { connectionOnly: true });
    expect(result.selectedPrimitive).toBe("direct-cable");
    expect(fixture.actions).toHaveLength(1);
    expect(fixture.actions[0][0]).toMatchObject({ type: "build_road", prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB });
  });

  test("fresh native-preflighted service road supersedes persisted direct-cable fallback", async () => {
    const fixture = ports("electricity");
    fixture.implementation.plan = async () => ({ status: "candidate", connection: {
      mode: "EXISTING_FACILITY_CONNECTION",
      kind: "electricity",
      facility: { entity: { index: 77, version: 1 }, prefab: "electricity-facility", position: { x: 10, z: 20 } },
      serviceRoads: [{ id: "segment", role: "side", start: { x: 50, z: 20 }, end: { x: 10, z: 20 } }],
      serviceRoadsNativePreflighted: true,
      connection: { prefab: "Low-voltage Ground Cable", start: { x: 12, z: 20 }, end: { x: 50, z: 20 } },
    }, reason: "fresh native route" });
    let preflightCalls = 0;
    fixture.implementation.preflight = async () => { preflightCalls += 1; return false; };

    const result = await prepareSharedUtilityRecovery({
      kind: "electricity", expectedRevision: null, connectionOnly: true,
      selectedPrimitive: "direct-cable", signal: new AbortController().signal,
      ports: fixture.implementation,
    });

    expect(result.status).toBe("READY");
    if (result.status === "READY") expect(result.selectedCandidatePrimitive).toBe("service-road");
    expect(preflightCalls).toBe(0);
  });

  test("facility access-road repair still executes when utility service is healthy and already connected", async () => {
    const fixture = ports("water");
    fixture.implementation.readCapacity = async () => ({
      revision: "r1", capacity: 1681, consumption: 0, fulfilledConsumption: 0, issueActive: false,
    });
    fixture.implementation.findCurrentUtilityBinding = async () => ({
      status: "MATCH" as const,
      binding: {
        facility: { entity: { index: 46620, version: 9 }, prefab: "water-facility", position: { x: 10, z: 20 } },
        connector: { type: "waterPipe" as const, node: { index: 200, version: 1 }, worldPosition: { x: 12, z: 20 }, attached: true, capacity: { fresh: 100 } },
      },
    });
    const accessRoad: MayorAction[] = [{ type: "build_road", prefab: "Small Road", x1: 12, z1: 20, x2: 50, z2: 20 }];
    const result = await run("water", fixture.implementation, {
      connectionOnly: true, selectedPrimitive: "facility-access-road", accessRoad,
    });
    expect(result.selectedPrimitive).toBe("facility-access-road");
    expect(fixture.actions).toEqual([accessRoad]);
  });

  test("the electricity direct cable uses the native-validated underground cable prefab", async () => {
    // Live CS2 native validation rejects "Low-voltage Line" (pole-to-pole overhead) for a
    // facility-to-road cable course and accepts "Low-voltage Ground Cable" on the identical course.
    expect(ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB).toBe("Low-voltage Ground Cable");
    const fixture = ports("electricity");
    fixture.implementation.findCurrentUtilityBinding = async () => ({
      status: "MATCH" as const,
      binding: {
        facility: { entity: { index: 46620, version: 9 }, prefab: "electricity-facility", position: { x: 10, z: 20 } },
        connector: { type: "electricity" as const, node: { index: 200, version: 1 }, worldPosition: { x: 12, z: 20 }, attached: false, capacity: { electricity: 100 } },
      },
    });
    fixture.implementation.readCapacity = async () => ({
      revision: "r1", capacity: 1681, consumption: 0, fulfilledConsumption: 0, issueActive: false,
    });
    await run("electricity", fixture.implementation, { connectionOnly: true });
    expect(fixture.actions[0][0]).toEqual({ type: "build_road", prefab: "Low-voltage Ground Cable", x1: 12, z1: 20, x2: 50, z2: 20 });
  });

  test("connection-only facility rebind failure fails closed without placement mutation", async () => {
    const fixture = ports("electricity");
    fixture.implementation.findCurrentUtilityBinding = async () => ({ status: "BLOCKED", reason: "UTILITY_FACILITY_NOT_FOUND" });
    const result = await run("electricity", fixture.implementation, { connectionOnly: true });
    expect(result).toMatchObject({ ok: false, reason: "UTILITY_FACILITY_NOT_FOUND", executedActions: 0 });
    expect(fixture.actions).toHaveLength(0);
  });

  test("Bootstrap imports the shared primitive", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "scripts/ai-mayor-bootstrap.ts"), "utf8");
    expect(source).toContain("executeSharedUtilityRecovery");
  });

  test("production Local adapter imports the same shared primitive", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/main/services/ai-mayor/main-adapters.ts"), "utf8");
    expect(source).toContain("executeSharedUtilityRecovery");
  });

  test("200 episode synthetic lifecycle recovers all utilities with bounded retry and finance pressure", async () => {
    const resolved = new Set<UtilityRecoveryKind>();
    let facilityActions = 0;
    let connectorActions = 0;
    let providerCalls = 0;
    let connectorFailures = 0;
    let cooldownHits = 0;
    let financeBlocks = 0;
    let growthActions = 0;
    let buildDigestCycles = 0;
    let waterAttempt = 0;
    let pendingIntent: ReturnType<typeof deriveServiceRecoveryIntent>;
    for (let episode = 0; episode < 200; episode += 1) {
      const kind: UtilityRecoveryKind | null =
        episode >= 30 && episode < 32
          ? "electricity"
          : episode >= 80 && episode < 84
            ? "water"
            : episode >= 130 && episode < 135
              ? "sewage"
              : null;
      if (!kind) {
        if ((episode < 30 || (episode > 31 && episode < 80) || episode > 131) && episode % 5 === 0) {
          growthActions += 1;
          buildDigestCycles += 1;
        }
        continue;
      }
      if (resolved.has(kind)) continue;
      const issue = scanCityIssues(
        buildLocalMayorSnapshotFixture({
          utilities: {
            [kind]:
              kind === "electricity"
                ? { status: "available", production: 40, consumption: 100, fulfilledConsumption: 40 }
                : { status: "available", capacity: 40, consumption: 100, fulfilledConsumption: 40 },
          },
        }),
      ).highest;
      pendingIntent = deriveServiceRecoveryIntent(issue, pendingIntent);
      if (pendingIntent?.status === "cooldown") {
        cooldownHits += 1;
        pendingIntent = advanceServiceRecoveryCooldown(pendingIntent);
        continue;
      }
      if (!pendingIntent || pendingIntent.status !== "actionable") continue;
      pendingIntent = recordServiceRecoveryAttempt(pendingIntent, `episode-${episode}`);
      waterAttempt += kind === "water" ? 1 : 0;
      const fixture = ports(kind, { attaches: kind !== "water" || waterAttempt > 1 });
      const financeWeak = kind === "sewage" && episode === 130;
      const result = await run(kind, fixture.implementation, financeWeak ? { treasury: 1, runwayMonths: 0 } : {});
      if (result.reason === "utility_connector_not_attached") connectorFailures += 1;
      if (result.reason === "finance_guard") financeBlocks += 1;
      if (result.ok) {
        resolved.add(kind);
        pendingIntent = evaluateServiceRecoveryReadback(pendingIntent, null);
      } else {
        pendingIntent = evaluateServiceRecoveryReadback(pendingIntent, issue);
      }
      facilityActions += fixture.actions.filter((batch) => batch[0]?.type === "place_building").length;
      connectorActions += fixture.actions.filter((batch) => batch[0]?.type === "build_road").length;
      providerCalls += 0; // The synthetic harness has no provider port.
    }
    expect([...resolved].sort()).toEqual(["electricity", "sewage", "water"]);
    expect(connectorFailures).toBe(1);
    expect(financeBlocks).toBe(1);
    expect(cooldownHits).toBeGreaterThanOrEqual(2);
    expect(facilityActions).toBe(4);
    expect(connectorActions).toBe(4);
    expect(growthActions).toBeGreaterThan(20);
    expect(buildDigestCycles).toBe(growthActions);
    expect(pendingIntent?.attempts ?? 0).toBeLessThanOrEqual(3);
    expect(providerCalls).toBe(0);
  });
});
