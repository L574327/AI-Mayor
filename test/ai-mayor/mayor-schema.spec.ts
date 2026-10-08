import {
  MAYOR_MEMORY_MAX_BYTES,
  MayorPlanSchema,
  mergeMayorMemory,
  normalizeMayorPlanForSpeed,
  normalizeMayorPlanWirePayload,
  parseMayorPlan,
  validateMayorPlanAgainstSnapshot,
} from "../../src/main/services/ai-mayor/schema";

describe("MayorPlan schema", () => {
  test("keeps Normal actions and normalizes Fast multi-candidate actions without inventing actions", () => {
    const source = MayorPlanSchema.parse({
      status: "Build",
      objective: "Grow safely",
      rationale: "Two separate validated opportunities support the goal.",
      actions: [
        { type: "choose_candidate", candidateId: "A", reason: "A" },
        { type: "choose_candidate", candidateId: "B", reason: "B" },
      ],
      simulation: { run: true, hours: 2 },
      memoryUpdate: {},
      stop: { requested: false },
    });
    expect(normalizeMayorPlanForSpeed(source, "normal")).toEqual({
      plan: source,
      modelPlanFormat: "actions",
      normalizedToConstructionPhase: false,
    });
    const normalized = normalizeMayorPlanForSpeed(source, "fast");
    expect(normalized.modelPlanFormat).toBe("actions");
    expect(normalized.normalizedToConstructionPhase).toBe(true);
    expect(normalized.plan.constructionPhase?.candidateIds).toEqual(["A", "B"]);
    expect(normalized.plan.actions).toEqual([]);
  });

  test("keeps Fast no-op actions unchanged and preserves native constructionPhase", () => {
    const empty = MayorPlanSchema.parse({
      status: "Wait",
      objective: "Observe",
      rationale: "No safe action is justified.",
      blockingReason: "No validated opportunity is available.",
      actions: [],
      simulation: { run: false },
      memoryUpdate: {},
      stop: { requested: false },
    });
    expect(normalizeMayorPlanForSpeed(empty, "fast").normalizedToConstructionPhase).toBe(false);
    const native = MayorPlanSchema.parse({
      ...empty,
      blockingReason: undefined,
      constructionPhase: { objective: "Grow", candidateIds: ["A", "B"], rationale: "Validated demand." },
    });
    expect(normalizeMayorPlanForSpeed(native, "fast").normalizedToConstructionPhase).toBe(false);
  });
  test("expands a bounded construction phase into validated candidate actions", () => {
    const plan = parseMayorPlan(
      JSON.stringify({
        status: "Build a small phase",
        objective: "Use two compatible opportunities",
        rationale: "Both validated candidates support the current goal.",
        actions: [],
        constructionPhase: {
          objective: "Two safe zones",
          candidateIds: ["R-01", "C-01"],
          rationale: "Demand supports both.",
        },
        simulation: { run: true, hours: 2, speed: 4 },
        memoryUpdate: {},
        stop: { requested: false },
      }),
    );
    const validated = validateMayorPlanAgainstSnapshot(plan, {
      economy: { treasury: 1000 },
      actionablePlanning: {
        candidates: [
          { id: "R-01", validationStatus: "validated", conflictGroup: "r" },
          { id: "C-01", validationStatus: "validated", conflictGroup: "c" },
        ],
      },
    });
    expect(validated.actions.map((action) => action.type === "choose_candidate" && action.candidateId)).toEqual([
      "R-01",
      "C-01",
    ]);
  });

  test("rejects construction phases over the configured safety limit and conflicting candidates", () => {
    const base = {
      status: "Build",
      objective: "Build safely",
      rationale: "Validated opportunities are available.",
      actions: [],
      simulation: { run: false },
      memoryUpdate: {},
      stop: { requested: false },
    };
    expect(() =>
      validateMayorPlanAgainstSnapshot(
        {
          ...base,
          constructionPhase: { objective: "Too much", candidateIds: ["A", "B", "C"], rationale: "All" },
        } as never,
        { actionablePlanning: { candidates: [] } },
        { maxCandidateCount: 2 },
      ),
    ).toThrow("safety limit");
    const phase = MayorPlanSchema.parse({
      ...base,
      constructionPhase: { objective: "Conflict", candidateIds: ["A", "B"], rationale: "Both" },
    });
    expect(() =>
      validateMayorPlanAgainstSnapshot(phase, {
        actionablePlanning: {
          candidates: [
            { id: "A", validationStatus: "validated", conflictGroup: "same" },
            { id: "B", validationStatus: "validated", conflictGroup: "same" },
          ],
        },
      }),
    ).toThrow("conflicts");
  });
  test("accepts a compact safe plan", () => {
    const plan = parseMayorPlan(
      '```json\n{"status":"Wait for growth","objective":"Observe growth","rationale":"Demand is not actionable yet","blockingReason":"No validated candidate is available","actions":[],"simulation":{"run":true,"hours":4,"speed":4},"memoryUpdate":{"nextGoal":"Review demand"},"stop":{"requested":false}}\n```',
    );
    expect(plan.simulation.hours).toBe(4);
  });

  test("regresses the live UDL payload without repairing semantic omissions", () => {
    const failedPayload = {
      status: "Planning a district",
      objective: "Plan a district",
      rationale: "x".repeat(501),
      actions: [],
      urbanDesignIntent: {
        goal: "Compact infill",
        primaryStyle: "compact-urban",
        secondaryInfluence: "terrain-organic",
        rationale: "Adapt to terrain",
      },
      blockingReason: "none",
      simulation: { run: false },
      memoryUpdate: {},
      stop: { requested: false },
    };
    const normalized = normalizeMayorPlanWirePayload(failedPayload) as typeof failedPayload;
    expect(normalized.urbanDesignIntent).toMatchObject({ version: 1 });
    expect(() => MayorPlanSchema.parse(normalized)).toThrow();
    expect(() => parseMayorPlan(JSON.stringify(failedPayload))).toThrow(/status|secondaryInfluence|500/);
  });

  test("accepts the canonical strict UDL intent wire shape", () => {
    expect(
      MayorPlanSchema.parse({
        status: "Design",
        objective: "Plan a district",
        rationale: "Use a compact site-adapted district.",
        actions: [],
        blockingReason: "The design proposal will provide candidates next.",
        urbanDesignIntent: {
          version: 1,
          status: "design",
          goal: "Compact district adapted to this site.",
          primaryStyle: "compact-urban",
          secondaryInfluence: { styleId: "terrain-organic", strength: "subtle", dimensions: ["density"] },
          preferredAnchorId: "anchor-1",
          density: "medium",
          developmentEmphasis: "infill",
          roadCharacter: "balanced",
          commercialTendency: "nodes",
          greenSpaceTendency: "distributed",
          rationale: "Short site-based reason.",
        },
        simulation: { run: false },
        memoryUpdate: {},
        stop: { requested: false },
      }),
    ).toHaveProperty("urbanDesignIntent.version", 1);
  });

  test("requires UDL intent before selecting a road expansion candidate", () => {
    const plan = MayorPlanSchema.parse({
      status: "Expand",
      objective: "Open a new district edge",
      rationale: "A road expansion is needed.",
      actions: [{ type: "choose_candidate", candidateId: "E-1-1-east", reason: "Open frontage" }],
      simulation: { run: false },
      memoryUpdate: {},
      stop: { requested: false },
    });
    expect(() =>
      validateMayorPlanAgainstSnapshot(plan, {
        economy: { treasury: 1000 },
        actionablePlanning: {
          candidates: [
            {
              id: "E-1-1-east",
              candidateType: "road_expansion",
              validationStatus: "validated",
              conflictGroup: "e",
            },
          ],
        },
      }),
    ).toThrow("require urbanDesignIntent");
  });

  test("rejects high-risk and arbitrary actions", () => {
    const base = {
      status: "unsafe",
      objective: "Unsafe request",
      rationale: "Test rejection",
      simulation: { run: false },
      memoryUpdate: {},
      stop: { requested: false },
    };
    expect(() => MayorPlanSchema.parse({ ...base, actions: [{ type: "demolish", index: 1, version: 1 }] })).toThrow();
    expect(() => MayorPlanSchema.parse({ ...base, actions: [{ type: "set_loan", amount: 100_000 }] })).toThrow();
    expect(() => MayorPlanSchema.parse({ ...base, actions: [{ type: "shell", command: "anything" }] })).toThrow();
  });

  test("rejects invented or locked names that are absent from the live snapshot catalog", () => {
    const plan = parseMayorPlan(
      '{"status":"Build","objective":"Extend roads","rationale":"Test invented prefab rejection","actions":[{"type":"build_road","prefab":"Invented Road","x1":0,"z1":0,"x2":100,"z2":0}],"simulation":{"run":false},"memoryUpdate":{},"stop":{"requested":false}}',
    );
    expect(() =>
      validateMayorPlanAgainstSnapshot(plan, {
        planningCatalog: { roadPrefabs: ["Small Road"], zoneTypes: [], buildingPrefabs: {}, roadAnchors: [] },
      }),
    ).toThrow(/not in the unlocked snapshot catalog/);
  });

  test("requires an explicit blocking reason for a no-op", () => {
    expect(() =>
      MayorPlanSchema.parse({
        status: "Wait",
        objective: "Observe",
        rationale: "More evidence may help",
        actions: [],
        simulation: { run: true, hours: 2 },
        memoryUpdate: {},
        stop: { requested: false },
      }),
    ).toThrow(/blockingReason/);
  });

  test("accepts a current validated candidate and rejects stale, conflicting, or direct zoning", () => {
    const snapshot = {
      economy: { treasury: 100_000 },
      planningCatalog: { roadPrefabs: [], zoneTypes: [], buildingPrefabs: {}, roadAnchors: [] },
      actionablePlanning: {
        candidates: [
          { id: "I-01", validationStatus: "validated", conflictGroup: "P-01" },
          { id: "C-01", validationStatus: "validated", conflictGroup: "P-01" },
        ],
      },
    };
    const base = {
      status: "Invest",
      objective: "Add a small employment zone",
      rationale: "Demand is persistent and treasury runway is ample",
      simulation: { run: true, hours: 4 },
      memoryUpdate: {},
      stop: { requested: false },
    };
    expect(
      validateMayorPlanAgainstSnapshot(
        MayorPlanSchema.parse({
          ...base,
          actions: [{ type: "choose_candidate", candidateId: "I-01", reason: "Persistent industrial demand" }],
        }),
        snapshot,
      ).actions,
    ).toHaveLength(1);
    expect(() =>
      validateMayorPlanAgainstSnapshot(
        MayorPlanSchema.parse({
          ...base,
          actions: [{ type: "choose_candidate", candidateId: "I-stale", reason: "Try stale id" }],
        }),
        snapshot,
      ),
    ).toThrow(/not currently validated/);
    expect(() =>
      validateMayorPlanAgainstSnapshot(
        MayorPlanSchema.parse({
          ...base,
          actions: [
            { type: "choose_candidate", candidateId: "I-01", reason: "Industrial" },
            { type: "choose_candidate", candidateId: "C-01", reason: "Commercial" },
          ],
        }),
        snapshot,
      ),
    ).toThrow(/conflicts/);
    expect(() =>
      validateMayorPlanAgainstSnapshot(
        MayorPlanSchema.parse({
          ...base,
          actions: [{ type: "zone", zone: "Industrial Manufacturing", x: 1, z: 2, radius: 24 }],
        }),
        snapshot,
      ),
    ).toThrow(/choose a validated zoning candidate/);
  });

  test("blocks new construction only when city treasury is actually depleted", () => {
    const plan = MayorPlanSchema.parse({
      status: "Build",
      objective: "Extend one road",
      rationale: "A validated connection is useful",
      actions: [{ type: "build_road", prefab: "Small Road", x1: 0, z1: 0, x2: 100, z2: 0 }],
      simulation: { run: false },
      memoryUpdate: {},
      stop: { requested: false },
    });
    expect(() =>
      validateMayorPlanAgainstSnapshot(plan, {
        economy: { treasury: 0 },
        planningCatalog: { roadPrefabs: ["Small Road"], zoneTypes: [], buildingPrefabs: {}, roadAnchors: [] },
      }),
    ).toThrow(/extreme-solvency/);
  });

  test("keeps memory strictly bounded", () => {
    const memory = mergeMayorMemory(
      {
        phase: "start",
        strategy: "safe",
        importantAreas: [],
        recentMilestones: [],
        unresolvedProblems: [],
        nextGoal: "observe",
      },
      {
        importantAreas: Array.from({ length: 8 }, (_, index) => `${index}-${"x".repeat(240)}`),
        recentMilestones: Array.from({ length: 8 }, (_, index) => `${index}-${"y".repeat(240)}`),
        unresolvedProblems: Array.from({ length: 8 }, (_, index) => `${index}-${"z".repeat(240)}`),
      },
    );
    expect(Buffer.byteLength(JSON.stringify(memory), "utf8")).toBeLessThanOrEqual(MAYOR_MEMORY_MAX_BYTES);
  });
});
