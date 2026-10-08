import {
  boundedValidationSimulationHours,
  createMainMayorPorts,
  defaultSimulationTimeoutMs,
  filterRetiredRoadCandidates,
  isCandidateAvailable,
  milestoneIsNear,
  noteMilestoneProgress,
  isRoadAttemptBlocked,
  roadAttemptKey,
  roadActionKey,
  roadSourceDirectionKey,
  resolveAvailableCandidate,
  resolveSpatialRevision,
  type MayorFetch,
  parseMcpJson,
  pinCanonicalRoadAnchors,
  nextUtilityGoalSiteScopeId,
  utilityGoalSiteScopes,
  withBoundedNativeBuildBackpressure,
} from "../../src/main/services/ai-mayor/main-adapters";
import { decideLocalMayorEpisode } from "../../src/main/services/ai-mayor/local-mayor/decision";
import { buildLocalMayorSnapshotFixture } from "../../src/main/services/ai-mayor/local-mayor/replay-fixtures";
import { toMayorPlanActions } from "../../src/main/services/ai-mayor/local-mayor/types";
import { MayorRuntime } from "../../src/main/services/ai-mayor/runtime";
import { PlanningAnchorSchema } from "../../src/main/services/ai-mayor/urban-design/site-context";
import { committedUtilityPlacementPlan, nativeCompletionTelemetryForUtilityBatch,
  reconcileExactUtilityFacilityListing, utilityCommandMatchesPlacementScope } from "../../src/main/services/ai-mayor/v2/main-adapter";

describe("AI Mayor main adapters", () => {
  test("rebinds a matched utility placement from its exact committed action, not the planner point", () => {
    const scope = {
      projectId: "project", trancheId: "tranche", reservationRef: "reservation",
      worldEpochId: "epoch", generation: "generation", placementScopeId: "placement",
    } as any;
    const plan = { kind: "power", prefab: "WindTurbine03", position: { x: -1247.99, z: 50.93 } } as any;
    const command = {
      commandId: "placement-command", status: "OBSERVED_MATCH", actionType: "place_building",
      authorizedScope: {
        actionFamily: "UTILITY", utilityKind: "electricity", projectId: "project", trancheId: "tranche",
        reservationRef: "reservation", worldEpochId: "epoch", generation: "generation", placementScopeId: "placement",
        exactInput: JSON.stringify([{ type: "place_building", prefab: "WindTurbine03", x: -1223.99, z: 50.93, rotation: 0 }]),
      },
    } as any;
    expect(committedUtilityPlacementPlan({ kind: "electricity", plan, facilityCommandId: "placement-command", command, scope })?.position)
      .toEqual({ x: -1223.99, z: 50.93 });
    expect(committedUtilityPlacementPlan({ kind: "electricity", plan, facilityCommandId: "placement-command",
      command: { ...command, authorizedScope: { ...command.authorizedScope, generation: "stale-generation" } }, scope })?.position)
      .toEqual(plan.position);
  });

  test("does not mix terminal utility commands from another placement scope into the current outcome", () => {
    const scope = { projectId: "project", trancheId: "tranche", reservationRef: "reservation",
      worldEpochId: "epoch", generation: "generation", placementScopeId: "successor" } as any;
    const command = { commandId: "current-command", actionFamily: "UTILITY", authorizedScope: { actionFamily: "UTILITY", utilityKind: "electricity",
      projectId: "project", trancheId: "tranche", reservationRef: "reservation", worldEpochId: "epoch",
      generation: "generation", placementScopeId: "utility-placement:legacy", exactInput: JSON.stringify([{ type: "build_road", prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 1, z2: 1 }]) } } as any;
    expect(utilityCommandMatchesPlacementScope({ command, kind: "electricity", scope })).toBe(false);
    expect(utilityCommandMatchesPlacementScope({ command, kind: "electricity", scope, currentCandidates: [
      { commandId: "different-command", exactActions: JSON.parse(command.authorizedScope.exactInput) },
    ] })).toBe(false);
    expect(utilityCommandMatchesPlacementScope({ command, kind: "electricity", scope, currentCandidates: [
      { commandId: "current-command", exactActions: JSON.parse(command.authorizedScope.exactInput) },
    ] })).toBe(true);
  });

  test("proves an absent utility placement only from a complete exact-prefab census", () => {
    const common = {
      commandId: "utility-command",
      action: { type: "place_building" as const, prefab: "WindTurbine03", x: -77.21955, z: 1313.07434, rotation: 0 },
      worldId: "cs2-session:world",
      generation: "generation-1",
      frameIndex: 12030456,
      recordedAt: "2026-09-29T07:50:00.000Z",
    };
    const census = { query: "WindTurbine03", returned: 1, totalMatches: 1, truncated: false, hasMore: false,
      buildings: [{ entity: { index: 1, version: 1 }, prefab: "WindTurbine03", position: { x: -78.5, z: 1380 } }] };
    expect(reconcileExactUtilityFacilityListing({ ...common, listed: census })).toMatchObject({
      result: "MISMATCH", effectAbsenceProven: true,
      evidence: { coherence: "STABLE_FRAME", details: { completeness: { complete: true }, exactPositionMatchCount: 0 } },
    });
    expect(reconcileExactUtilityFacilityListing({ ...common, listed: { ...census, truncated: true } })).toMatchObject({
      result: "INCONCLUSIVE", evidence: { coherence: "UNKNOWN", details: { completeness: { complete: false } } },
    });
    expect(reconcileExactUtilityFacilityListing({ ...common, listed: { ...census, buildings: [
      { entity: { index: 2, version: 1 }, prefab: "WindTurbine03", position: { x: -77.5, z: 1313.1 } },
    ] } })).toMatchObject({ result: "MATCH", evidence: { details: { exactPositionMatchCount: 1 } } });
    const exact = { entity: { index: 2, version: 1 }, prefab: "WindTurbine03", position: { x: -77.5, z: 1313.1 } };
    expect(reconcileExactUtilityFacilityListing({ ...common, listed: { ...census, returned: 2, totalMatches: 2,
      buildings: [exact, { ...exact, entity: { index: 3, version: 1 } }] } })).toMatchObject({ result: "INCONCLUSIVE" });
  });

  test("reports an explicit provider error only when cloud-backed adapter work is requested", async () => {
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => ({
        legacyList: async () => ({ tools: [] }),
        legacyCall: async () => ({}),
      }),
    });

    await expect(ports.getBalance()).rejects.toThrow("PROVIDER_NOT_CONFIGURED");
  });

  test("preserves text from an MCP error response", () => {
    expect(() =>
      parseMcpJson({
        isError: true,
        content: [{ type: "text", text: "another build operation is in progress, retry shortly" }],
      }),
    ).toThrow("another build operation is in progress, retry shortly");
  });

  test("preserves course-split diagnostics alongside native completion telemetry", () => {
    const diagnostics = {
      ticketLifecycle: { created: true, observed: true, consumed: true },
      yOffset: { Y0_TYPED_END: 10, Y4_FINAL_EMITTED_NETCOURSE_curveD: 9.75 },
      matchingDiagnostics: { CandidateCount: 1, MatchingCount: 0 },
      predicateTrace: [],
    };
    const evidence = nativeCompletionTelemetryForUtilityBatch({
      results: [{
        type: "build_road",
        nativeCompletion: {
          courseSplitDiagnostics: diagnostics,
          endRealizationTelemetry: { commandId: "bridge-1", telemetrySchemaVersion: "phase-aware-v1" },
        },
      }],
    }, "bridge-1") as Record<string, any>;
    expect(evidence.courseSplitDiagnostics).toEqual(diagnostics);
    expect(evidence.telemetrySchemaVersion).toBe("phase-aware-v1");
  });

  test("recovers one transient native build busy response with bounded backpressure", async () => {
    let attempts = 0;
    const result = await withBoundedNativeBuildBackpressure(
      async () => {
        attempts += 1;
        return attempts === 1 ? { busy: true } : { busy: false, committed: true };
      },
      (value) => value.busy,
      undefined,
      [1, 1],
    );
    expect(result).toEqual({ busy: false, committed: true });
    expect(attempts).toBe(2);
  });

  test("fails bounded native build backpressure without infinite retry", async () => {
    let attempts = 0;
    await expect(
      withBoundedNativeBuildBackpressure(
        async () => {
          attempts += 1;
          throw new Error("another build operation is in progress, retry shortly");
        },
        () => false,
        undefined,
        [1, 1],
      ),
    ).rejects.toThrow("another build operation is in progress");
    expect(attempts).toBe(3);
  });

  test("retires only the rejected road geometry for the current spatial revision", () => {
    const road = (x2: number) => ({
      type: "build_road" as const,
      prefab: "Small Road",
      x1: 0,
      z1: 0,
      x2,
      z2: 100,
    });
    const firstAction = road(100);
    const secondAction = road(120);
    const thirdAction = road(140);
    const first = {
      id: "road-1",
      actionType: "build_road" as const,
      candidateType: "road_expansion" as const,
      approximateLength: 100,
      approximateNewFrontage: 100,
      approximateDirection: "north",
      sourceRoad: { index: 1, version: 1 },
      adjacentRoad: { entity: { index: 1, version: 1 }, prefab: "Small Road" },
      accessibility: "connected_endpoint" as const,
      spatialRole: "small_expansion" as const,
      relevantDemand: { category: "residential" as const, value: null },
      estimatedCost: null,
      constraints: ["native_preview_required"],
      validationStatus: "validated" as const,
      conflictGroup: "source-1",
    };
    const second = { ...first, id: "road-2", approximateLength: 120 };
    const third = { ...first, id: "road-3", approximateLength: 140 };
    const set = {
      status: "available" as const,
      candidates: [first, second, third],
      note: "",
      registry: new Map([
        [first.id, { summary: first, action: firstAction, center: { x: 100, z: 100 }, radius: 100 }],
        [second.id, { summary: second, action: secondAction, center: { x: 120, z: 100 }, radius: 120 }],
        [third.id, { summary: third, action: thirdAction, center: { x: 140, z: 100 }, radius: 140 }],
      ]),
      ownedTiles: [],
    };
    const liveShapedSnapshot = {};
    const liveSpatialContext = { siteContext: { snapshotRevision: "site-af109c99" } };
    expect(resolveSpatialRevision(liveShapedSnapshot)).toBeNull();
    expect(resolveSpatialRevision(liveSpatialContext)).toBe("site-af109c99");
    expect(roadSourceDirectionKey(first)).toBe("1:1|north|100");
    const retired = new Map([
      [
        resolveSpatialRevision(liveSpatialContext)!,
        new Map([
          [roadActionKey(firstAction)!, "rejected" as const],
          [roadActionKey(secondAction)!, "rejected" as const],
        ]),
      ],
    ]);

    expect(filterRetiredRoadCandidates(set, "site-af109c99", retired).candidates.map((item) => item.id)).toEqual(["road-3"]);
    expect(filterRetiredRoadCandidates(set, "rev-2", retired).candidates.map((item) => item.id)).toEqual([
      "road-1",
      "road-2",
      "road-3",
    ]);
    const ledger = new Map([
      [
        "site-af109c99",
        new Map([[roadAttemptKey("site-af109c99", firstAction, first)!, "success" as const]]),
      ],
    ]);
    expect(isRoadAttemptBlocked("site-af109c99", firstAction, ledger, first)).toBe(true);
    expect(isRoadAttemptBlocked("site-af109c99", secondAction, ledger, second)).toBe(false);
    ledger.get("site-af109c99")!.set(roadAttemptKey("site-af109c99", secondAction, second)!, "rejected");
    expect(isRoadAttemptBlocked("site-af109c99", secondAction, ledger, second)).toBe(true);
    expect(isRoadAttemptBlocked("site-af109c99", thirdAction, ledger, third)).toBe(false);
    ledger.get("site-af109c99")!.set(roadAttemptKey("site-af109c99", thirdAction, third)!, "available");
    expect(isCandidateAvailable("site-af109c99", thirdAction, ledger, third)).toBe(true);
  });

  test("keeps a regenerated retired road unavailable to the selector", () => {
    const action = {
      type: "build_road" as const,
      prefab: "Small Road",
      x1: 0,
      z1: 0,
      x2: 100,
      z2: 90,
    };
    const summary = {
      id: "E-50961-1-south-100--90",
      actionType: "build_road" as const,
      candidateType: "road_expansion" as const,
      approximateLength: 100,
      approximateNewFrontage: 100,
      approximateDirection: "south",
      sourceRoad: { index: 50961, version: 1 },
      adjacentRoad: { entity: { index: 50961, version: 1 }, prefab: "Small Road" },
      accessibility: "connected_endpoint" as const,
      spatialRole: "small_expansion" as const,
      relevantDemand: { category: "residential" as const, value: 80 },
      estimatedCost: null,
      constraints: [],
      validationStatus: "validated" as const,
      conflictGroup: "50961:1",
    };
    const regenerated = {
      status: "available" as const,
      candidates: [summary],
      note: "regenerated by recovery",
      registry: new Map([[summary.id, { summary, action, center: { x: 50, z: 45 }, radius: 100 }]]),
      ownedTiles: [],
    };
    const retired = new Map([
      ["site-af109c99", new Map([[roadActionKey(action)!, "succeeded" as const]])],
    ]);

    const filtered = filterRetiredRoadCandidates(regenerated, "site-af109c99", retired);
    expect(filtered.candidates).toEqual([]);
    expect(filtered.registry.size).toBe(0);
  });

  test("uses authoritative availability before the production local decision selects a road", () => {
    const road = (id: string, source: number, direction: "south" | "north", z2: number) => {
      const action = {
        type: "build_road" as const,
        prefab: "Small Road",
        x1: source,
        z1: 0,
        x2: source,
        z2,
      };
      const summary = {
        id,
        actionType: "build_road" as const,
        candidateType: "road_expansion" as const,
        approximateLength: 80,
        approximateNewFrontage: 80,
        approximateDirection: direction,
        sourceRoad: { index: source, version: 1 },
        adjacentRoad: { entity: { index: source, version: 1 }, prefab: "Small Road" },
        accessibility: "connected_endpoint" as const,
        spatialRole: "small_expansion" as const,
        relevantDemand: { category: "residential" as const, value: 100 },
        estimatedCost: null,
        constraints: [],
        validationStatus: "validated" as const,
        conflictGroup: `${source}:1`,
      };
      return { action, summary, private: { summary, action, center: { x: source, z: z2 / 2 }, radius: 80 } };
    };
    const a = road("A", 345037, "north", 80);
    const b = road("B", 345037, "south", -80);
    const c = road("C", 345044, "north", 80);
    const revision = "site-af109c99";
    const availability = new Map([
      [
        revision,
        new Map([
          [roadAttemptKey(revision, a.action, a.summary)!, "succeeded" as const],
          [roadAttemptKey(revision, b.action, b.summary)!, "rejected" as const],
        ]),
      ],
    ]);
    const registry = new Map([
      [a.summary.id, a.private],
      [b.summary.id, b.private],
      [c.summary.id, c.private],
    ]);
    const productionSet = {
      status: "available" as const,
      candidates: [a.summary, b.summary, c.summary],
      note: "production registry",
      registry,
      ownedTiles: [],
    };
    const selectedAtChokePoint = ["A", "B", "C"]
      .map((candidateId) => resolveAvailableCandidate(productionSet, candidateId, revision, availability))
      .filter((candidate) => candidate !== null);
    const filtered = filterRetiredRoadCandidates(
      productionSet,
      revision,
      availability,
    );
    const episode = decideLocalMayorEpisode(
      buildLocalMayorSnapshotFixture({
        population: { current: 260 },
        demand: { residential: { low: 100, medium: 100, high: 100 } },
        actionablePlanning: { status: "available", candidates: filtered.candidates },
        urbanDesign: { siteContext: { snapshotRevision: revision } },
      }),
    );
    const planActions = toMayorPlanActions(episode.chosen.action);

    expect(selectedAtChokePoint.map((candidate) => candidate.summary.id)).toEqual(["C"]);
    expect(filtered.candidates.map((candidate) => candidate.id)).toEqual(["C"]);
    expect(episode.chosen.action).toMatchObject({ kind: "choose_candidate", candidateId: "C" });
    expect(planActions).toEqual([expect.objectContaining({ candidateId: "C" })]);
    expect(isCandidateAvailable(revision, c.action, availability, c.summary)).toBe(true);
    expect(planActions.filter((action) => {
      const candidate = registry.get(action.candidateId);
      return candidate && !isCandidateAvailable(revision, candidate.action, availability, candidate.summary);
    })).toHaveLength(0);
  });

  test("applies the same authoritative disposition contract to zoning candidates", () => {
    const action = { type: "zone" as const, zone: "EU Residential Low", x: 10, z: 20 };
    const summary = {
      id: "zone-A",
      actionType: "zone" as const,
      candidateType: "zoning" as const,
      approximateCells: 25,
      adjacentRoad: { entity: { index: 1, version: 1 }, prefab: "Small Road" },
      accessibility: "roadside" as const,
      spatialRole: "infill" as const,
      relevantDemand: { category: "residential" as const, value: 100 },
      estimatedCost: null,
      constraints: [],
      validationStatus: "validated" as const,
      conflictGroup: "zone-A",
    };
    const candidate = { summary, action, center: { x: 10, z: 20 }, radius: 64 };
    const set = {
      status: "available" as const,
      candidates: [summary],
      note: "",
      registry: new Map([[summary.id, candidate]]),
      ownedTiles: [],
    };
    const availability = new Map([[
      "site-1",
      new Map([[summary.id, "rejected" as const]]),
    ]]);

    expect(resolveAvailableCandidate(set, summary.id, "site-1", availability)).toBeNull();
    expect(isCandidateAvailable("site-1", action, availability, summary, summary.id)).toBe(false);
  });

  test("bounds simulation timeout while allowing a normal four-hour tick to run longer", () => {
    expect(defaultSimulationTimeoutMs(1, 4)).toBe(5 * 60_000);
    expect(defaultSimulationTimeoutMs(4, 4)).toBe(8 * 60_000);
    expect(defaultSimulationTimeoutMs(24, 0.5)).toBe(15 * 60_000);
  });

  test("bounds the opt-in UDL validation burst without changing normal simulation policy", () => {
    expect(boundedValidationSimulationHours(4)).toBe(0.5);
    expect(boundedValidationSimulationHours(0.25)).toBe(0.25);
  });

  test("parses structured and text MCP JSON", () => {
    expect(parseMcpJson({ structuredContent: { ok: true } })).toEqual({ ok: true });
    expect(parseMcpJson({ content: [{ type: "text", text: '{"population":42}' }] })).toEqual({ population: 42 });
  });

  test("pins selected canonical road sources without expanding the compact catalog unboundedly", () => {
    const snapshot = {
      planningCatalog: {
        roadAnchors: Array.from({ length: 8 }, (_, index) => ({
          entity: { index: 73622 + index, version: 1 },
          prefab: "Small Road",
          start: { x: index, z: 0 },
          end: { x: index + 1, z: 0 },
        })),
      },
    };
    const anchor = PlanningAnchorSchema.parse({
      id: "anchor-undeveloped_edge-road-node-1:1",
      kind: "undeveloped_edge",
      sourceId: "road-node-1:1",
      sourceEntity: { index: 1, version: 1 },
      canonicalSource: {
        kind: "road_node",
        node: { index: 1, version: 1 },
        incidentRoads: [{ edge: { index: 73594, version: 1 }, endpointRole: "end" }],
      },
      rank: 0,
      orientation: "unknown",
      areaClass: "edge",
      terrainProfile: "flat",
      waterfrontEligible: false,
      availableFrontageCells: 20,
      adaptationHints: [],
    });
    const edge = {
      entity: { index: 73594, version: 1 },
      prefab: "Small Road",
      native: true,
      startNode: { index: 2, version: 1 },
      endNode: { index: 1, version: 1 },
      start: { x: 0, z: 0 },
      end: { x: 10, z: 0 },
      length: 10,
    };
    const pinned = pinCanonicalRoadAnchors(snapshot, [edge], anchor);
    expect(pinned).toEqual({
      planningCatalog: {
        roadAnchors: [
          { entity: edge.entity, prefab: edge.prefab, start: edge.start, end: edge.end },
          ...snapshot.planningCatalog.roadAnchors,
        ],
      },
    });
    expect((pinned as typeof snapshot).planningCatalog.roadAnchors).toHaveLength(9);
    expect(pinCanonicalRoadAnchors(pinned, [edge], anchor)).toEqual(pinned);
  });

  test("does not invent a catalog source when the authoritative graph edge is stale", () => {
    const snapshot = { planningCatalog: { roadAnchors: [] } };
    const anchor = PlanningAnchorSchema.parse({
      id: "anchor-road-node-1:1",
      kind: "road_endpoint",
      sourceId: "road-node-1:1",
      sourceEntity: { index: 1, version: 1 },
      canonicalSource: {
        kind: "road_node",
        node: { index: 1, version: 1 },
        incidentRoads: [{ edge: { index: 999, version: 1 }, endpointRole: "start" }],
      },
      rank: 0,
      orientation: "unknown",
      areaClass: "edge",
      terrainProfile: "flat",
      waterfrontEligible: false,
      availableFrontageCells: 0,
      adaptationHints: [],
    });
    expect(pinCanonicalRoadAnchors(snapshot, [], anchor)).toBe(snapshot);
  });

  test("exposes spatial design decisions through the same provider function as routine decisions", () => {
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test-key" }),
      getToolsManager: () => ({ legacyList: async () => ({ tools: [] }), legacyCall: async () => ({}) }),
    });
    expect(ports.decideUrbanDesign).toBe(ports.decide);
  });

  test("rejects MCP business and protocol errors", () => {
    expect(() => parseMcpJson({ isError: true, content: [{ error: "bridge unreachable" }] })).toThrow(
      "bridge unreachable",
    );
    expect(() => parseMcpJson({ content: [{ type: "text", text: "not json" }] })).toThrow("no JSON");
  });

  test("serializes process-wide saves and never dispatches a second native request", async () => {
    let saveCalls = 0;
    let releaseSave!: () => void;
    const saveResponse = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_save_status", "cs2_save_game"].map((name) => ({ name: `t_save--${name}` })),
      }),
      legacyCall: async ({ name, arguments: input }: { name: string; arguments?: Record<string, unknown> }) => {
        if (name === "cs2_save_status" && input?.requestId)
          return { content: [{ type: "text", text: JSON.stringify({ status: "COMPLETED", durable: true }) }] };
        if (name === "cs2_save_status") return { content: [{ type: "text", text: JSON.stringify({ state: "IDLE" }) }] };
        saveCalls += 1;
        await saveResponse;
        return { content: [{ type: "text", text: JSON.stringify({ status: "SUBMITTED", saveRequestId: "save-first" }) }] };
      },
    };
    const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager });
    const first = ports.save("first");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(ports.save("second")).rejects.toThrow("SAVE_BUSY");
    expect(saveCalls).toBe(1);
    releaseSave();
    await first;
  });

  test("fails closed on a non-idle authoritative Bridge save state", async () => {
    let saveCalls = 0;
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_save_status", "cs2_save_game"].map((name) => ({ name: `t_save--${name}` })),
      }),
      legacyCall: async ({ name }: { name: string }) => {
        if (name === "cs2_save_status") return { content: [{ type: "text", text: JSON.stringify({ state: "IN_FLIGHT" }) }] };
        saveCalls += 1;
        return { content: [{ type: "text", text: JSON.stringify({ status: "SUBMITTED" }) }] };
      },
    };
    const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager });
    await expect(ports.save("blocked")).rejects.toThrow("SAVE_BUSY");
    expect(saveCalls).toBe(0);
  });

  /**
   * A progression milestone raises a modal, and a modal PAUSES the game, so a
   * window that waits for an "auto-pause" never sees a frame advance and ends on
   * `CS2 simulation did not auto-pause before timeout` every tick. Measured live
   * (2026-10-01): zero `cs2_read_blocking_modal` calls appeared in a whole
   * growth run, because the guard was attached to two of the four call sites
   * that reach `runSimulation` — and the growth path, `runBoundedSimulation`,
   * was one of the two with none.
   */
  describe("simulation windows dismiss a progression milestone first", () => {
    const tools = ["cs2_read_blocking_modal", "cs2_dismiss_blocking_modal", "cs2_run_simulation", "cs2_game_state"];
    const milestoneIdentity = {
      kind: "PROGRESSION_MILESTONE", entity: { index: 7, version: 1 }, milestoneIndex: 3, isVictory: false,
    };

    test("a modal the guard cannot classify stops the world before any simulation starts", async () => {
      const called: string[] = [];
      const manager = {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_modal--${name}` })) }),
        legacyCall: async ({ name }: { name: string }) => {
          const tool = name.replace(/^t_modal--/, "");
          called.push(tool);
          if (tool === "cs2_read_blocking_modal") {
            return { content: [{ type: "text", text: JSON.stringify({
              modalClass: "UNKNOWN_BLOCKING_MODAL", modalIdentity: null,
              active: true, visible: true, surfaceAvailable: true,
            }) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({}) }] };
        },
      };
      const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager });

      await expect(ports.runSimulation({ hours: 0.25, speed: 4 }, new AbortController().signal))
        .rejects.toThrow("blocking_modal_guard:UNKNOWN_BLOCKING_MODAL");
      expect(called).toEqual(["cs2_read_blocking_modal"]);
    });

    test("a dismissible milestone is dismissed before the world is advanced", async () => {
      const called: string[] = [];
      let reads = 0;
      let gameStates = 0;
      const manager = {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_modal--${name}` })) }),
        legacyCall: async ({ name }: { name: string }) => {
          const tool = name.replace(/^t_modal--/, "");
          called.push(tool);
          if (tool === "cs2_read_blocking_modal") {
            reads += 1;
            // The modal is up until it is dismissed; the guard then re-reads to
            // verify the dismissal actually took.
            return { content: [{ type: "text", text: JSON.stringify(reads === 1
              ? { modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL", modalIdentity: milestoneIdentity,
                  active: true, visible: true, surfaceAvailable: true }
              : { modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true }) }] };
          }
          if (tool === "cs2_dismiss_blocking_modal") return { content: [{ type: "text", text: JSON.stringify({ dismissed: true }) }] };
          if (tool === "cs2_run_simulation") return { content: [{ type: "text", text: JSON.stringify({ targetFrame: 200 }) }] };
          if (tool === "cs2_game_state") {
            gameStates += 1;
            const done = gameStates > 1;
            return { content: [{ type: "text", text: JSON.stringify({
              simulation: { paused: done, frameIndex: done ? 200 : 100 },
            }) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({}) }] };
        },
      };
      const ports = createMainMayorPorts({
        getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1,
      });

      await ports.runSimulation({ hours: 0.25, speed: 4 }, new AbortController().signal);

      expect(called.indexOf("cs2_dismiss_blocking_modal"))
        .toBeLessThan(called.indexOf("cs2_run_simulation"));
      expect(called.filter((name) => name === "cs2_read_blocking_modal")).toHaveLength(2);
    });

    test("a popup that pauses the game in the MIDDLE of a window is closed within a few polls and the window runs again (no 5-minute wait)", async () => {
      const called: string[] = [];
      let modalUp = false;
      let polls = 0;
      let runs = 0;
      const reply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
      const manager = {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_modal--${name}` })) }),
        legacyCall: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
          const tool = name.replace(/^t_modal--/, "");
          called.push(args?.cancel === true ? "cancel_run" : tool);
          if (tool === "cs2_read_blocking_modal") {
            return reply(modalUp
              ? { modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL", modalIdentity: milestoneIdentity, active: true, visible: true, surfaceAvailable: true }
              : { modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true });
          }
          if (tool === "cs2_dismiss_blocking_modal") { modalUp = false; return reply({ dismissed: true }); }
          if (tool === "cs2_run_simulation") {
            if (args?.cancel === true) return reply({ cancelRequested: true });
            runs += 1;
            return reply({ targetFrame: runs === 1 ? 200 : 400 });
          }
          if (tool === "cs2_game_state") {
            polls += 1;
            // Before the run: stopped at frame 100. First window: runs to 120, then a milestone popup raises and the game stands paused at 120.
            // After the popup is closed and the window run again: runs to 300, then pauses at its target 400.
            if (polls === 1) return reply({ simulation: { paused: true, frameIndex: 100 } });
            if (polls === 2) return reply({ simulation: { paused: false, frameIndex: 120 } });
            if (runs === 1) { modalUp = true; return reply({ simulation: { paused: true, frameIndex: 120 } }); }
            return reply(polls < 8 ? { simulation: { paused: false, frameIndex: 300 } } : { simulation: { paused: true, frameIndex: 400 } });
          }
          return reply({});
        },
      };
      const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1 });

      await ports.runSimulation({ hours: 0.25, speed: 4 }, new AbortController().signal);

      // The window noticed the stall, closed the popup, cleared the old timed run and ran the window again.
      expect(called).toContain("cs2_dismiss_blocking_modal");
      expect(runs).toBe(2);
      expect(called.indexOf("cancel_run")).toBeGreaterThan(called.indexOf("cs2_dismiss_blocking_modal"));
      // Seconds of polling, not the minutes of the no-progress budget.
      expect(polls).toBeLessThan(14);
    });

    test("close to a milestone (by XP) the window looks for the popup after ONE paused poll; far from one it waits for three", async () => {
      const pollsUntilDismiss = async (near: boolean) => {
        noteMilestoneProgress(near ? 4_900 : 1_000, 5_000);
        const called: string[] = [];
        let pausedPolls = 0;
        let modalUp = true;
        const reply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
        const manager = {
          legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_modal--${name}` })) }),
          legacyCall: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
            const tool = name.replace(/^t_modal--/, "");
            called.push(args?.cancel === true ? "cancel_run" : tool);
            if (tool === "cs2_read_blocking_modal") {
              // The window-start read is blind (the popup is raised after it); every later read shows what is up.
              const firstRead = called.filter((entry) => entry === "cs2_read_blocking_modal").length === 1;
              return reply(modalUp && !firstRead
                ? { modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL", modalIdentity: milestoneIdentity, active: true, visible: true, surfaceAvailable: true }
                : { modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true });
            }
            if (tool === "cs2_dismiss_blocking_modal") { modalUp = false; return reply({ dismissed: true }); }
            if (tool === "cs2_run_simulation") return reply(args?.cancel === true ? { cancelRequested: true } : { targetFrame: 200 });
            if (tool === "cs2_game_state") {
              if (!modalUp) return reply({ simulation: { paused: true, frameIndex: 200 } });
              pausedPolls += 1;
              return reply({ simulation: { paused: true, frameIndex: 100 } });
            }
            return reply({});
          },
        };
        const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1 });
        await ports.runSimulation({ hours: 0.25, speed: 4 }, new AbortController().signal);
        return pausedPolls;
      };
      const farPolls = await pollsUntilDismiss(false);
      const nearPolls = await pollsUntilDismiss(true);
      noteMilestoneProgress(null, null);
      expect(nearPolls).toBeLessThan(farPolls);
      expect(milestoneIsNear()).toBe(false);
    });
  });

  /**
   * BALANCED waits without stopping the city. Measured live (2026-10-04): every timed run ended in the Bridge's auto-pause and every failed
   * one in a cancel (which pauses too), so the city stopped several times a minute.
   */
  describe("a wait that keeps the city running", () => {
    const tools = ["cs2_read_blocking_modal", "cs2_dismiss_blocking_modal", "cs2_run_simulation", "cs2_set_simulation", "cs2_game_state"];
    const reply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    const milestoneIdentity = { kind: "PROGRESSION_MILESTONE", entity: { index: 7, version: 1 }, milestoneIndex: 3, isVictory: false };
    /** A city that advances 600 frames a poll from frame 1000 (0.1 h is 1092 frames), optionally paused by a popup on its second poll. */
    const city = (options: { popupOnPoll?: number } = {}) => {
      const called: Array<{ tool: string; args: Record<string, unknown> }> = [];
      let frame = 1000;
      let paused = true;
      let polls = 0;
      let modalUp = false;
      const manager = {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_run--${name}` })) }),
        legacyCall: async ({ name, arguments: args = {} }: { name: string; arguments?: Record<string, unknown> }) => {
          const tool = name.replace(/^t_run--/, "");
          called.push({ tool, args });
          if (tool === "cs2_read_blocking_modal") {
            return reply(modalUp
              ? { modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL", modalIdentity: milestoneIdentity, active: true, visible: true, surfaceAvailable: true }
              : { modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true });
          }
          if (tool === "cs2_dismiss_blocking_modal") { modalUp = false; return reply({ dismissed: true }); }
          if (tool === "cs2_set_simulation") { paused = args.paused === true; return reply({ paused }); }
          if (tool === "cs2_run_simulation") {
            paused = args.cancel === true;
            return reply(args.cancel === true ? { cancelRequested: true } : { targetFrame: frame + 1092 });
          }
          if (tool === "cs2_game_state") {
            if (options.popupOnPoll !== undefined && polls === options.popupOnPoll) { modalUp = true; paused = true; }
            polls += 1;
            if (!paused) frame += 600;
            // A timed run stops itself at its target, as the Bridge's does.
            return reply({ simulation: { paused, frameIndex: frame } });
          }
          return reply({});
        },
      };
      const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1 });
      return { ports, called, state: () => ({ frame, paused }) };
    };

    test("waits for the game time on the frame counter, and neither starts a timed run nor cancels one", async () => {
      const { ports, called, state } = city();
      await ports.observeRunningSimulation!({ hours: 0.1, speed: 4 }, new AbortController().signal);
      expect(called.some((call) => call.tool === "cs2_run_simulation")).toBe(false);
      expect(called.some((call) => call.tool === "cs2_set_simulation" && call.args.paused === true)).toBe(false);
      expect(called.find((call) => call.tool === "cs2_set_simulation")?.args).toEqual({ paused: false, speed: 4 });
      expect(state().frame).toBeGreaterThanOrEqual(1000 + 1092);
      // The city is left running.
      expect(state().paused).toBe(false);
    });

    test("control: the timed run on the same city starts `cs2_run_simulation`, the run that ends in a pause", async () => {
      const { ports, called } = city();
      // The fake Bridge never auto-pauses at the target, so the timed run would wait out its budget; only its first calls matter here.
      const abort = new AbortController();
      const run = ports.runSimulation({ hours: 0.1, speed: 4 }, abort.signal).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      abort.abort(new Error("test done"));
      await run;
      expect(called.some((call) => call.tool === "cs2_run_simulation" && call.args.hours === 0.1)).toBe(true);
    });

    test("a popup that pauses the city mid-wait is closed and the city resumed, without a cancel", async () => {
      const { ports, called, state } = city({ popupOnPoll: 2 });
      await ports.observeRunningSimulation!({ hours: 0.1, speed: 4 }, new AbortController().signal);
      expect(called.some((call) => call.tool === "cs2_dismiss_blocking_modal")).toBe(true);
      expect(called.filter((call) => call.tool === "cs2_set_simulation" && call.args.paused === false).length).toBeGreaterThanOrEqual(2);
      expect(called.some((call) => call.tool === "cs2_run_simulation")).toBe(false);
      expect(state().paused).toBe(false);
    });
  });

  /**
   * The Bridge answers "in progress" for a moment after a placement. A busy answer is not "this site is illegal", and the next check must not be
   * asked before the Bridge is idle again (live 2026-10-04: the pump search was cut short right after the turbine was placed).
   */
  describe("the Bridge answers busy", () => {
    const tools = ["cs2_build_road", "cs2_game_state", "cs2_spatial"];
    const reply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    const course = { start: { x: 0, z: 0 }, end: { x: 40, z: 0 } };
    const bridge = (busy: { value: boolean }) => {
      const calls: string[] = [];
      const manager = {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_busy--${name}` })) }),
        legacyCall: async ({ name }: { name: string }) => {
          const tool = name.replace(/^t_busy--/, "");
          calls.push(tool);
          if (tool === "cs2_game_state") return reply({ world: { nativeOperationBusy: busy.value, nativeOperationStage: busy.value ? "Finish" : "Idle" }, simulation: { paused: false, frameIndex: 1 } });
          if (busy.value) throw new Error("another build operation is in progress, retry shortly");
          return reply(tool === "cs2_spatial" ? { valid: true } : { success: true });
        },
      };
      return { calls, ports: createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1 }) };
    };

    test("a placement check that finds the Bridge busy through every retry is NO ANSWER (null), not 'illegal' (false): the site is not remembered as refused", async () => {
      const { ports } = bridge({ value: true });
      expect(await ports.districtBuilder!.port.utilities!.preflight("WindTurbine01", { x: 0, z: 0 }, 0)).toBeNull();
    }, 20_000);

    test("a placement waits for the Bridge to be idle again, so the next check is not answered 'busy' by the placement just made", async () => {
      const state = { busyPolls: 3, polls: 0, placed: false };
      const calls: string[] = [];
      const manager = {
        legacyList: async () => ({ tools: ["cs2_mayor_execute_actions", "cs2_game_state"].map((name) => ({ name: `t_idle--${name}` })) }),
        legacyCall: async ({ name }: { name: string }) => {
          const tool = name.replace(/^t_idle--/, "");
          calls.push(tool);
          if (tool === "cs2_mayor_execute_actions") { state.placed = true; return reply({ success: true }); }
          state.polls += 1;
          return reply({ world: { nativeOperationBusy: state.placed && state.polls <= state.busyPolls, nativeOperationStage: "Finish" } });
        },
      };
      const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1 });
      const placed = await ports.districtBuilder!.port.utilities!.place("WindTurbine01", { x: 0, z: 0 }, 0);
      expect(placed.ok).toBe(true);
      // It polled the state until the Bridge was idle (the busy flag cleared on the 4th poll), and only then returned.
      expect(calls.filter((tool) => tool === "cs2_game_state").length).toBeGreaterThanOrEqual(state.busyPolls + 1);
    });

    test("control: a Bridge that answers is written to normally, and a placement check answers true", async () => {
      const { ports } = bridge({ value: false });
      const port = ports.districtBuilder!.port;
      expect((await port.buildRoad(course, "Medium Road")).ok).toBe(true);
      expect(await port.utilities!.preflight("WindTurbine01", { x: 0, z: 0 }, 0)).toBe(true);
    });
  });

  /**
   * After a facility is placed the Mayor waits until the utility reading SHOWS it, not for a fixed span (measured live 2026-10-04: a fixed 0.5 game hour
   * was 24 s of nothing, twice at the start of every city, and no one had measured how long a facility needs).
   */
  describe("awaiting the capacity of a placed facility", () => {
    const tools = ["cs2_read_blocking_modal", "cs2_dismiss_blocking_modal", "cs2_run_simulation", "cs2_set_simulation", "cs2_game_state", "cs2_city_services"];
    const reply = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    /** Each state poll advances 600 frames (0.055 game hours); `rises` says on which poll the named reading goes up. */
    const city = (rises: { electricity?: number; water?: number }) => {
      const called: Array<{ tool: string; args: Record<string, unknown> }> = [];
      let frame = 1000; let polls = 0;
      const manager = {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_cap--${name}` })) }),
        legacyCall: async ({ name, arguments: args = {} }: { name: string; arguments?: Record<string, unknown> }) => {
          const tool = name.replace(/^t_cap--/, "");
          called.push({ tool, args });
          if (tool === "cs2_read_blocking_modal") return reply({ modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true });
          if (tool === "cs2_game_state") { polls += 1; frame += 600; return reply({ simulation: { paused: false, frameIndex: frame } }); }
          if (tool === "cs2_city_services") {
            return reply({ electricity: { production: rises.electricity !== undefined && polls >= rises.electricity ? 60_000 : 12_000 },
              water: { freshCapacity: rises.water !== undefined && polls >= rises.water ? 20_000 : 10_000 } });
          }
          return reply({});
        },
      };
      return { ports: createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager, pollIntervalMs: 1 }), called, polls: () => polls };
    };

    test("ends as soon as the reading shows the capacity, long before the cap, and never pauses or starts a timed run", async () => {
      const { ports, called, polls } = city({ electricity: 3 });
      const result = await ports.awaitUtilityCapacity!({ kinds: ["electricity"], maximumHours: 0.5, speed: 4 }, new AbortController().signal);
      expect(result.ready).toBe(true);
      expect(result.gameHours).toBeLessThan(0.5);
      expect(polls()).toBeLessThan(8);
      expect(called.some((call) => call.tool === "cs2_run_simulation")).toBe(false);
      expect(called.some((call) => call.tool === "cs2_set_simulation" && call.args.paused === true)).toBe(false);
    });
    test("control: a reading that never rises ends at the cap, reported as not shown (the old fixed wait is the worst case, not the usual one)", async () => {
      const { ports } = city({});
      const result = await ports.awaitUtilityCapacity!({ kinds: ["electricity"], maximumHours: 0.1, speed: 4 }, new AbortController().signal);
      expect(result.ready).toBe(false);
      expect(result.gameHours).toBeGreaterThanOrEqual(0.1);
    });
    test("water and electricity do not stand in for each other: waiting for water ignores a rise in power", async () => {
      const { ports } = city({ electricity: 2 });
      const result = await ports.awaitUtilityCapacity!({ kinds: ["water"], maximumHours: 0.1, speed: 4 }, new AbortController().signal);
      expect(result.ready).toBe(false);
      const both = city({ electricity: 2, water: 3 });
      expect((await both.ports.awaitUtilityCapacity!({ kinds: ["electricity", "water"], maximumHours: 0.5, speed: 4 }, new AbortController().signal)).ready).toBe(true);
    });
  });

  test("keeps the process save slot occupied after caller timeout", async () => {
    let terminal = false;
    let saveCalls = 0;
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_save_status", "cs2_save_game"].map((name) => ({ name: `t_save--${name}` })),
      }),
      legacyCall: async ({ name, arguments: input }: { name: string; arguments?: Record<string, unknown> }) => {
        if (name === "cs2_save_status" && input?.requestId) {
          return {
            content: [{ type: "text", text: JSON.stringify(terminal ? { status: "FAILED", reason: "test terminal failure" } : { status: "SUBMITTED" }) }],
          };
        }
        if (name === "cs2_save_status") return { content: [{ type: "text", text: JSON.stringify({ state: "IDLE" }) }] };
        saveCalls += 1;
        return { content: [{ type: "text", text: JSON.stringify({ status: "SUBMITTED", saveRequestId: "save-test" }) }] };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
      saveCompletionTimeoutMs: 5,
    });
    await expect(ports.save("slow")).rejects.toThrow("SAVE_COMPLETION_UNKNOWN");
    expect(saveCalls).toBe(1);
    await expect(ports.save("second")).rejects.toThrow("SAVE_BUSY");
    terminal = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(ports.save("third")).rejects.toThrow("native save failed");
    expect(saveCalls).toBe(2);
  });

  test("runs a mock integrated tick through MCP and one DeepSeek request", async () => {
    const mcpCalls: string[] = [];
    let apiRequests = 0;
    const tools = [
      "cs2_mayor_snapshot",
      "cs2_mayor_execute_actions",
      "cs2_run_simulation",
      "cs2_game_state",
      "cs2_save_game",
    ];
    const manager = {
      legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_01--${name}` })) }),
      legacyCall: async ({ name }: { name: string }) => {
        mcpCalls.push(name);
        const payload =
          name === "cs2_mayor_snapshot"
            ? { schemaVersion: "1.0", economy: { treasury: 100_000 }, demand: { residential: { low: 120 } } }
            : { ok: true, requested: 0, executed: 0, results: [] };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    const fetchImpl: MayorFetch = async () => {
      apiRequests++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "mock-request",
          model: "deepseek-chat",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "Wait for development",
                  objective: "Observe development safely",
                  rationale: "No validated action is available in this mock snapshot.",
                  blockingReason: "The mock has no actionable planning candidate.",
                  actions: [],
                  simulation: { run: false },
                  memoryUpdate: { nextGoal: "Review demand" },
                  stop: { requested: false },
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 800,
            prompt_cache_hit_tokens: 600,
            prompt_cache_miss_tokens: 200,
            completion_tokens: 90,
            total_tokens: 890,
          },
        }),
      };
    };
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test-key" }),
      getToolsManager: () => manager,
      fetchImpl,
      fetchBalance: async () => ({
        isAvailable: true,
        currency: "CNY",
        totalBalance: 50,
        grantedBalance: 0,
        toppedUpBalance: 50,
        fetchedAt: new Date().toISOString(),
      }),
    });
    const runtime = new MayorRuntime(ports);
    runtime.start({ goal: "Grow safely", maxSessionSpend: 1, minimumBalance: 2 });
    const state = await runtime.singleTick();

    expect(state.tickCount).toBe(1);
    expect(apiRequests).toBe(1);
    expect(mcpCalls).toEqual(["cs2_mayor_snapshot"]);
    expect(state.telemetryTotals.apiRequestCount).toBe(1);
  });

  test("ignores a stale paused state until simulation advances and pauses at its target", async () => {
    const calls: string[] = [];
    let gameStateCalls = 0;
    const tools = ["cs2_run_simulation", "cs2_game_state", "cs2_read_blocking_modal"];
    const manager = {
      legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_01--${name}` })) }),
      legacyCall: async ({ name }: { name: string }) => {
        calls.push(name);
        let payload: unknown;
        if (name === "cs2_read_blocking_modal") {
          payload = { modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true };
        } else if (name === "cs2_run_simulation") {
          payload = { running: true, targetFrame: 200 };
        } else {
          gameStateCalls++;
          payload =
            gameStateCalls <= 2
              ? { simulation: { paused: true, frameIndex: 100 } }
              : gameStateCalls === 3
                ? { simulation: { paused: false, frameIndex: 150 } }
                : { simulation: { paused: true, frameIndex: 200 } };
        }
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test-key" }),
      getToolsManager: () => manager,
      pollIntervalMs: 0,
      simulationTimeoutMs: 50,
    });
    await ports.runSimulation({ hours: 1, speed: 4 }, new AbortController().signal);
    // The window dismisses any progression milestone BEFORE it advances time: a
    // milestone modal pauses the game, so a window that starts the simulation
    // first waits for an auto-pause that has already happened.
    expect(calls).toEqual([
      "cs2_read_blocking_modal",
      "cs2_game_state",
      "cs2_run_simulation",
      "cs2_game_state",
      "cs2_game_state",
      "cs2_game_state",
    ]);
  });

  test("does not finish pause until the game confirms paused state", async () => {
    let stateCalls = 0;
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_run_simulation", "cs2_game_state"].map((name) => ({ name: `t_01--${name}` })),
      }),
      legacyCall: async ({ name }: { name: string }) => {
        const payload =
          name === "cs2_run_simulation"
            ? { cancelRequested: true }
            : { simulation: { paused: ++stateCalls >= 2, frameIndex: 150 + stateCalls } };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
    });

    await ports.pause();

    expect(stateCalls).toBe(2);
  });

  test("cancels an unfinished timed run after its adapter timeout", async () => {
    const calls: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_run_simulation", "cs2_game_state", "cs2_read_blocking_modal"].map((name) => ({ name: `t_01--${name}` })),
      }),
      legacyCall: async ({ name, signal }: { name: string; signal?: AbortSignal }) => {
        calls.push(name);
        signals.push(signal);
        if (name === "cs2_read_blocking_modal") {
          return { content: [{ type: "text", text: JSON.stringify({ modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true }) }] };
        }
        if (name === "cs2_run_simulation") {
          return { content: [{ type: "text", text: JSON.stringify({ running: true, targetFrame: 200 }) }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ simulation: { paused: false, frameIndex: 101 } }) }],
        };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
      pollIntervalMs: 1,
      simulationTimeoutMs: 15,
    });

    await expect(ports.runSimulation({ hours: 1, speed: 4 }, new AbortController().signal)).rejects.toThrow(
      "CS2 simulation did not auto-pause before timeout",
    );
    expect(calls.at(-1)).toBe("cs2_run_simulation");
    expect(signals.at(-1)).toBeUndefined();
  });

  test("keeps waiting while the simulation advances, past the stall budget", async () => {
    // A city that is still running is not stuck, however slow it is. Four polls
    // at 30 ms each is 120 ms — past the 100 ms stall budget, and inside the
    // 200 ms absolute one. Only resetting the stall clock on real frame progress
    // lets this run finish; a fixed wall clock would end it at 100 ms.
    let frame = 100;
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_run_simulation", "cs2_game_state", "cs2_read_blocking_modal"].map((name) => ({ name: `t_01--${name}` })),
      }),
      legacyCall: async ({ name }: { name: string }) => {
        if (name === "cs2_read_blocking_modal") {
          return { content: [{ type: "text", text: JSON.stringify({ modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true }) }] };
        }
        if (name === "cs2_run_simulation") {
          return { content: [{ type: "text", text: JSON.stringify({ running: true, targetFrame: 500 }) }] };
        }
        frame += 100;
        return {
          content: [{ type: "text", text: JSON.stringify({ simulation: { paused: frame >= 600, frameIndex: frame } }) }],
        };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
      pollIntervalMs: 30,
      simulationTimeoutMs: 100,
    });

    const startedAt = Date.now();
    await ports.runSimulation({ hours: 1, speed: 4 }, new AbortController().signal);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  test("ends a still-progressing run at its absolute budget rather than reporting a stall", async () => {
    // Frame progress continues every poll, so this is not a stall; the target is
    // simply unreachable. It must still be bounded, and it must not be reported
    // with the stall message — a soak has to tell the two apart.
    let frame = 0;
    const manager = {
      legacyList: async () => ({
        tools: ["cs2_run_simulation", "cs2_game_state", "cs2_read_blocking_modal"].map((name) => ({ name: `t_01--${name}` })),
      }),
      legacyCall: async ({ name }: { name: string }) => {
        const payload =
          name === "cs2_read_blocking_modal"
            ? { modalClass: "NO_MODAL", modalIdentity: null, active: false, visible: false, surfaceAvailable: true }
            : name === "cs2_run_simulation"
              ? { running: true, targetFrame: 10_000_000 }
              : { simulation: { paused: false, frameIndex: (frame += 1) } };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => undefined,
      getToolsManager: () => manager,
      pollIntervalMs: 5,
      // The stall budget is generous next to a 5 ms poll, so the run cannot be
      // reported as stalled by a slow poll; only the absolute budget can end it.
      simulationTimeoutMs: 120,
    });

    await expect(ports.runSimulation({ hours: 1, speed: 4 }, new AbortController().signal)).rejects.toThrow(
      "CS2 simulation exceeded its absolute wait budget",
    );
  });

  test("rejects an unsupported simulation speed before touching Bridge", async () => {
    const calls: string[] = [];
    const manager = {
      legacyList: async () => ({ tools: [{ name: "t_01--cs2_run_simulation" }] }),
      legacyCall: async ({ name }: { name: string }) => {
        calls.push(name);
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
    const ports = createMainMayorPorts({ getProvider: () => undefined, getToolsManager: () => manager });

    await expect(ports.runSimulation({ hours: 1, speed: 9 }, new AbortController().signal)).rejects.toThrow(
      "INVALID_SIMULATION_SPEED",
    );
    expect(calls).toEqual([]);
  });

  test("resolves a public candidate id into private zoning geometry after live revalidation", async () => {
    let executedActions: unknown;
    let providerCalls = 0;
    const cells = Array.from({ length: 25 }, (_, index) => ({
      block: { index: 50, version: 1 },
      index,
      position: { x: 34 + (index % 5) * 8, y: 0, z: -16 + Math.floor(index / 5) * 8 },
      visible: true,
      roadside: true,
      occupied: false,
      blocked: false,
      overridden: false,
      zoneType: 0,
      zoneCategory: "none" as const,
    }));
    const reserveCells = [
      { zoneType: 29, zoneCategory: "residential" as const }, // low-density residential
      { zoneType: 501, zoneCategory: "residential" as const }, // mixed residential (official AreaType)
      { zoneType: 27, zoneCategory: "commercial" as const },
      { zoneType: 31, zoneCategory: "industrial" as const },
      { zoneType: 777, zoneCategory: "industrial" as const }, // specialized industry
      { zoneType: 33, zoneCategory: "office" as const },
      { zoneType: 34, zoneCategory: "office" as const },
      { zoneType: 1, zoneCategory: "unknown" as const }, // proves raw ids are not guessed
    ].map((zone, index) => ({
      block: { index: 60, version: 1 },
      index,
      position: { x: -150 + index * 8, y: 0, z: 150 },
      visible: true,
      roadside: true,
      occupied: false,
      blocked: false,
      overridden: false,
      ...zone,
    }));
    const bulkCommercialCells = Array.from({ length: 520 }, (_, index) => ({
      block: { index: 61 + Math.floor(index / 64), version: 1 },
      index: index % 64,
      position: { x: -190 + (index % 40) * 8, y: 0, z: 180 },
      visible: true,
      roadside: false,
      occupied: false,
      blocked: false,
      overridden: false,
      zoneType: 27,
      zoneCategory: "commercial" as const,
    }));
    const detail = {
      center: { x: 50, z: 0 },
      radius: 256,
      terrain: {
        resolution: 2,
        bounds: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 },
        cellSize: { x: 200, z: 200 },
        heights: [0, 0, 0, 0],
        waterDepths: [0, 0, 0, 0],
        groundWater: [0, 0, 0, 0],
        groundWaterPollution: [0, 0, 0, 0],
        windSpeed: [0, 0, 0, 0],
      },
      roadGraph: { nodes: [], edges: [] },
      buildings: [],
      zoningCells: [...cells, ...reserveCells, ...bulkCommercialCells],
    };
    const tools = ["cs2_mayor_snapshot", "cs2_spatial", "cs2_mayor_execute_actions"];
    let spatialCalls = 0;
    const manager = {
      legacyList: async () => ({ tools: tools.map((name) => ({ name: `t_01--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown;
        if (name === "cs2_mayor_snapshot") {
          payload = {
            economy: { treasury: 100_000 },
            demand: { residential: { low: 0, medium: 0, high: 0 }, commercial: 100, industrial: 100, office: 0 },
            planningCatalog: {
              zoneTypes: [
                { name: "EU Residential Low", areaType: "Residential", office: false },
                { name: "EU Commercial Low", areaType: "Commercial", office: false },
                { name: "Industrial Manufacturing", areaType: "Industrial", office: false },
              ],
              roadAnchors: [
                {
                  entity: { index: 10, version: 2 },
                  prefab: "Small Road",
                  start: { x: 0, z: 0 },
                  end: { x: 100, z: 0 },
                },
              ],
            },
          };
        } else if (name === "cs2_spatial" && args.mode === "scan") {
          spatialCalls += 1;
          payload = {
            world: { min: -1000, max: 1000, size: 2000 },
            tiles: [
              {
                entity: { index: 1, version: 1 },
                owned: true,
                bounds: { min: { x: -200, z: -200 }, max: { x: 200, z: 200 } },
                center: { x: 0, z: 0 },
                polygon: [
                  { x: -200, z: -200 },
                  { x: 200, z: -200 },
                  { x: 200, z: 200 },
                  { x: -200, z: 200 },
                ],
              },
            ],
            outsideConnections: [],
            bootstrapAssets: [],
            roadGraph: { truncated: false, nodes: [], edges: [] },
          };
        } else if (name === "cs2_spatial") {
          spatialCalls += 1;
          payload = detail;
        } else {
          executedActions = args.actions;
          payload = {
            ok: true,
            requested: 1,
            executed: 1,
            results: [{ index: 0, type: "zone", ok: true, summary: "zoned 25 cells" }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    const ports = createMainMayorPorts({
      getProvider: () => ({ apiBase: "https://api.deepseek.com/v1", apiKey: "test-key" }),
      getToolsManager: () => manager,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error("provider must not be called during authoritative zoning classification");
      },
    });
    const strategic = (await ports.getSnapshot(undefined, { strategicOnly: true })) as { economy: { treasury: number } };
    expect(strategic.economy.treasury).toBe(100_000);
    expect(spatialCalls).toBe(0);
    const snapshot = (await ports.getSnapshot()) as {
      actionablePlanning: { candidates: Array<{ id: string; areaType: string }> };
      developmentCapacity: {
        existingZonedUnoccupiedCells: number;
        availableDevelopmentCells: number;
        zonedUnoccupiedByType: Record<string, number>;
      };
    };
    expect(snapshot.developmentCapacity.zonedUnoccupiedByType).toEqual({
      residential: 2,
      commercial: 521,
      industrial: 2,
      office: 2,
      unknown: 1,
    });
    expect(snapshot.developmentCapacity.existingZonedUnoccupiedCells).toBe(528);
    expect(
      Object.values(snapshot.developmentCapacity.zonedUnoccupiedByType).reduce((sum, value) => sum + value, 0),
    ).toBe(528);
    expect(snapshot.developmentCapacity.availableDevelopmentCells).toBe(512);
    expect(providerCalls).toBe(0);
    const selected = snapshot.actionablePlanning.candidates.find((candidate) => candidate.areaType === "Commercial");
    expect(selected).toBeDefined();
    if (!selected) throw new Error("expected a commercial candidate");
    expect(JSON.stringify(selected)).not.toMatch(/"[xz]":/);

    // An observational Snapshot between selection and dispatch must not erase
    // the registry entry that execution still needs.
    await ports.getSnapshot();

    const batch = await ports.executeActions([
      { type: "choose_candidate", candidateId: "candidate-A", reason: "Highest-ranked candidate" },
      { type: "choose_candidate", candidateId: selected.id, reason: "Bounded fallback candidate" },
    ]);

    expect(batch.executed).toBe(1);
    expect(executedActions).toEqual([
      expect.objectContaining({
        type: "zone",
        zone: "EU Commercial Low",
        x: expect.any(Number),
        z: expect.any(Number),
      }),
    ]);

    const refreshed = (await ports.getSnapshot()) as {
      actionablePlanning: { candidates: Array<{ id: string }> };
    };
    expect(refreshed.actionablePlanning.candidates.map((candidate) => candidate.id)).not.toContain("candidate-A");
  });
});

/**
 * A water Goal's spent site scopes are read from the work orders it produced.
 * Counting goal ids by prefix is wrong in both directions: a scope's bounded
 * Road prerequisites are descendants of it, so a prefix match reads the first
 * scope's first few corridor steps as "the scope budget is spent"; and a scope
 * whose admission always succeeded into a prerequisite has no work-order record
 * of its own, so counting exact ids reads as "no scope was ever tried" and
 * re-mints the scope whose budget is already gone.
 */
describe("water Goal site-scope succession", () => {
  const order = (goalId: string, parentGoalId?: string) => ({ goalId, parentGoalId });

  test("a scope counts once however many corridor steps it took", () => {
    const orders = [
      order("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:1:aa", "UTILITY_SERVICE:water:city:site_scope:1"),
      order("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:2:bb", "UTILITY_SERVICE:water:city:site_scope:1"),
      order("UTILITY_SERVICE:water:city:site_scope:1:prerequisite:ROAD_ACCESS:3:cc", "UTILITY_SERVICE:water:city:site_scope:1"),
    ];
    expect(utilityGoalSiteScopes(orders)).toEqual(["UTILITY_SERVICE:water:city:site_scope:1"]);
  });

  test("the next scope skips every scope already spent", () => {
    const spent = ["UTILITY_SERVICE:water:city:site_scope:1", "UTILITY_SERVICE:water:city:site_scope:2"];
    expect(nextUtilityGoalSiteScopeId("UTILITY_SERVICE:water:city", spent))
      .toBe("UTILITY_SERVICE:water:city:site_scope:3");
    expect(nextUtilityGoalSiteScopeId("UTILITY_SERVICE:water:city", [])).toBe("UTILITY_SERVICE:water:city:site_scope:1");
  });

  test("another Goal's work orders are never counted as water scopes", () => {
    const orders = [
      order("PROVIDE_SERVICE:electricity:facts:dab0fcde"),
      order("UTILITY_SERVICE:water:city:prerequisite:ROAD_ACCESS:1:aa", "UTILITY_SERVICE:water:city"),
      order("EXPAND_RESIDENTIAL:residential:facts:ff"),
    ];
    expect(utilityGoalSiteScopes(orders)).toEqual([]);
  });
});

describe("utility Goal site-scope escape", () => {
  test("counts both piped utilities' scopes and advances either", () => {
    const sewage = "PROVIDE_SERVICE:sewage:facts:f588de8b";
    const orders = [
      { goalId: `${sewage}:site_scope:1` },
      { goalId: `${sewage}:site_scope:1:ROAD`, parentGoalId: `${sewage}:site_scope:1` },
      { goalId: "PROVIDE_SERVICE:sewage:facts:f588de8b" },
      { goalId: "EXPAND_RESIDENTIAL:residential:facts:abc" },
    ];
    expect(utilityGoalSiteScopes(orders)).toEqual([`${sewage}:site_scope:1`]);
    expect(nextUtilityGoalSiteScopeId(sewage, [`${sewage}:site_scope:1`])).toBe(`${sewage}:site_scope:2`);
    expect(nextUtilityGoalSiteScopeId(sewage, [])).toBe(`${sewage}:site_scope:1`);
  });

  test("a non-utility Goal never counts as a site scope", () => {
    expect(utilityGoalSiteScopes([{ goalId: "EXPAND_INDUSTRIAL:industrial:facts:abc:site_scope:1" }])).toEqual([]);
  });
});
