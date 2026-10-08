import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import type {
  RoadEffectMatcher,
  V2CommandRecord,
  V2ObservationEnvelope,
  V2RoadEffectProvenance,
} from "../../src/main/services/ai-mayor/v2/foundation";
import type { RoadExecutionResult, RoadGeometryInput } from "../../src/main/services/ai-mayor/v2/road-kernel";
import {
  createNetEdgeCourseEffectMatcher,
  isUtilityNetPrefab,
  layUtilityAlongRoadComponent,
  allocateUtilityStreets,
  matchNetEdgeCourseEffect,
  planUtilityStreetsAlongComponent,
  selectUtilityStreetsInBounds,
} from "../../src/main/services/ai-mayor/v2/utility-network-laying";

const worldId = "cs2-session:session-a";
const nativeSessionGuid = "session-a";

/**
 * A pipe course that is really in the world, taken from the live reading that
 * produced the first east-cluster survey: 123 m of `Small Sewage Pipe` west of
 * the settled cluster.
 */
const pipeCourse: RoadGeometryInput = {
  prefab: "Small Sewage Pipe",
  x1: 40.70558,
  z1: -148.313919,
  x2: 112.547,
  z2: -247.6503,
};

function command(input: RoadGeometryInput = pipeCourse, commandId = "net-command"): V2CommandRecord {
  const exactInput = stableRoadInput(input);
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId,
    actionFamily: "ROAD",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: "net-task" },
      actionFamily: "ROAD",
      proposalId: "net-proposal",
      quoteId: "net-quote",
      fingerprint: exactInput,
      exactInput,
      budget: { authorizedMaxSpend: 200, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
      observationPrecondition: { runtimeEpoch: "bridge:10", frame: 10 },
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    createdAt: "2026-10-02T00:00:00.000Z",
    submittedAt: "2026-10-02T00:00:01.000Z",
    nativeResultSummary: null,
    status: "NATIVE_COMPLETED",
    statusHistory: [],
    reconciliationStatus: "NOT_STARTED",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

function netEdge(prefab: string, start: { x: number; z: number }, end: { x: number; z: number }, index: number) {
  return { entity: { index, version: 1 }, prefab, start, end, length: Math.hypot(end.x - start.x, end.z - start.z) };
}

function envelope(options: {
  listings?: Record<string, unknown>;
  netEdgesUnavailable?: boolean;
  noNetEdgesSource?: boolean;
  coherence?: V2ObservationEnvelope["coherence"];
  busy?: boolean;
  worldId?: string;
  nativeSessionGuid?: string;
} = {}): V2ObservationEnvelope {
  const world = {
    worldId: options.worldId ?? worldId,
    nativeSessionGuid: options.nativeSessionGuid ?? nativeSessionGuid,
    nativeOperationBusy: options.busy ?? false,
  };
  const game = { world };
  const source = (data: unknown) => ({
    status: "AVAILABLE" as const,
    data,
    readStartedAt: "2026-10-02T00:00:00.000Z",
    readEndedAt: "2026-10-02T00:00:00.001Z",
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 },
  });
  const netEdges = options.netEdgesUnavailable
    ? { status: "UNAVAILABLE" as const, reason: "bridge listing unavailable",
        readStartedAt: "2026-10-02T00:00:00.000Z", readEndedAt: "2026-10-02T00:00:00.001Z",
        simulationFrameStart: null, simulationFrameEnd: null,
        freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 } }
    : source({ listings: options.listings ?? {} });
  return {
    schemaVersion: "ai-mayor-v2-observation/1",
    observationId: "net-observation",
    runtimeEpoch: "runtime-a",
    worldEpoch: { kind: "RUNTIME_SESSION", value: "runtime-a", durableAcrossSaveLoad: false },
    readStartedAt: "2026-10-02T00:00:00.000Z",
    readEndedAt: "2026-10-02T00:00:00.002Z",
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    gameTimeStart: null,
    gameTimeEnd: null,
    pausedBefore: true,
    pausedAfter: true,
    coherence: options.coherence ?? "STABLE_FRAME",
    sourceFreshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", maximumAgeMs: 2, allRequiredSourcesAvailable: true },
    revision: { authoritativeWorldRevision: null },
    sources: {
      gameStateBefore: source(game),
      snapshot: source({}),
      spatialScan: source({ worldEpoch: "generation-a", roadGraph: { nodes: [], edges: [], truncated: false } }),
      spatialDetail: source({} as never),
      gameStateAfter: source(game),
      ...(options.noNetEdgesSource ? {} : { netEdges }),
    },
  };
}

const provenance: V2RoadEffectProvenance = {
  worldId,
  nativeSessionGuid,
  baseCheckpointId: "save:meta-a:data-a",
  lineageCheckpointIds: ["save:meta-a:data-a"],
  proof: "CERTIFIED_DURABLE_LINEAGE",
};

/** The complete listing that holds exactly the course above, as one edge. */
const pipeListings = {
  "Small Sewage Pipe": {
    prefab: "Small Sewage Pipe",
    roads: [netEdge("Small Sewage Pipe", { x: 40.70558, z: -148.313919 }, { x: 112.547, z: -247.6503 }, 50445)],
    totalMatches: 1,
    returned: 1,
  },
};

describe("net edge course effect matching", () => {
  it("names the pipe prefabs it can judge, and nothing else", () => {
    expect(isUtilityNetPrefab("Small Sewage Pipe")).toBe(true);
    expect(isUtilityNetPrefab("Low-voltage Ground Cable")).toBe(true);
    expect(isUtilityNetPrefab("Medium Road")).toBe(false);
    expect(isUtilityNetPrefab("Water Tower")).toBe(false);
  });

  it("matches a pipe course that is present in the net listing", () => {
    const report = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({ listings: pipeListings }),
      provenance,
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.effectAbsenceProven).toBe(false);
    expect(report.matchedEdges).toEqual([{ index: 50445, version: 1 }]);
  });

  it("accepts a course the world realized as a contiguous chain", () => {
    const mid = { x: (40.70558 + 112.547) / 2, z: (-148.313919 + -247.6503) / 2 };
    const report = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({
        listings: {
          "Small Sewage Pipe": {
            prefab: "Small Sewage Pipe",
            roads: [
              netEdge("Small Sewage Pipe", { x: 40.70558, z: -148.313919 }, mid, 1),
              netEdge("Small Sewage Pipe", mid, { x: 112.547, z: -247.6503 }, 2),
            ],
            totalMatches: 2,
            returned: 2,
          },
        },
      }),
      provenance,
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.matchedEdges).toHaveLength(2);
  });

  it("proves absence only from a complete listing of an idle world", () => {
    const report = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({
        listings: { "Small Sewage Pipe": { prefab: "Small Sewage Pipe", roads: [], totalMatches: 0, returned: 0 } },
      }),
      provenance,
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });

  it("refuses to prove absence while native is busy", () => {
    const report = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({
        listings: { "Small Sewage Pipe": { prefab: "Small Sewage Pipe", roads: [], totalMatches: 0, returned: 0 } },
        busy: true,
      }),
      provenance,
    });
    expect(report.matcherResult).toBe("INCONCLUSIVE");
    expect(report.effectAbsenceProven).toBe(false);
  });

  it("treats a truncated listing as missing evidence, never as absence", () => {
    const report = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({
        listings: {
          "Small Sewage Pipe": {
            prefab: "Small Sewage Pipe",
            roads: [netEdge("Small Sewage Pipe", { x: 0, z: 0 }, { x: 10, z: 0 }, 1)],
            totalMatches: 900,
            returned: 1,
          },
        },
      }),
      provenance,
    });
    expect(report.matcherResult).toBe("INCONCLUSIVE");
    expect(report.effectAbsenceProven).toBe(false);
  });

  it("is inconclusive when the observation carries no net listing", () => {
    for (const observation of [envelope({ noNetEdgesSource: true }), envelope({ netEdgesUnavailable: true })]) {
      const report = matchNetEdgeCourseEffect({ command: command(), observation, provenance });
      expect(report.matcherResult).toBe("INCONCLUSIVE");
      expect(report.effectAbsenceProven).toBe(false);
    }
  });

  it("is inconclusive when the listing does not cover the command's prefab", () => {
    const report = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({ listings: pipeListings }),
      provenance: provenance,
    });
    expect(report.matcherResult).toBe("MATCH");
    const other = matchNetEdgeCourseEffect({
      command: command({ ...pipeCourse, prefab: "Low-voltage Ground Cable" }),
      observation: envelope({ listings: pipeListings }),
      provenance,
    });
    expect(other.matcherResult).toBe("INCONCLUSIVE");
  });

  it("fails closed without a durable lineage, or against another world", () => {
    const noLineage = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({ listings: pipeListings }),
      provenance: null,
    });
    expect(noLineage.matcherResult).toBe("INCONCLUSIVE");
    const otherWorld = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({ listings: pipeListings, nativeSessionGuid: "session-b" }),
      provenance,
    });
    expect(otherWorld.matcherResult).toBe("INCONCLUSIVE");
    const incoherent = matchNetEdgeCourseEffect({
      command: command(),
      observation: envelope({ listings: pipeListings, coherence: "UNKNOWN" }),
      provenance,
    });
    expect(incoherent.matcherResult).toBe("INCONCLUSIVE");
  });

  it("refuses to judge a prefab that is not a net course", () => {
    const report = matchNetEdgeCourseEffect({
      command: command({ prefab: "Medium Road", x1: 0, z1: 0, x2: 40, z2: 0 }),
      observation: envelope({ listings: pipeListings }),
      provenance,
    });
    expect(report.matcherResult).toBe("INCONCLUSIVE");
    expect(report.reason).toContain("not a net pipe/cable course");
  });
});

describe("net edge dispatching matcher", () => {
  const roadCalls: V2CommandRecord[] = [];
  const road: RoadEffectMatcher = {
    match: ({ command: entry }) => {
      roadCalls.push(entry);
      return { result: "MATCH", evidence: {}, reason: "road matcher answered", effectAbsenceProven: false };
    },
  };
  const matcher = createNetEdgeCourseEffectMatcher({ road, resolveProvenance: () => provenance });

  it("asks the capture for the net listing only for a net course", () => {
    expect(matcher.netEdgePrefabs?.(command())).toEqual(["Small Sewage Pipe"]);
    expect(matcher.netEdgePrefabs?.(command({ prefab: "Medium Road", x1: 0, z1: 0, x2: 40, z2: 0 }))).toBeNull();
  });

  it("sends a road course to the road matcher and a pipe course to the net listing", () => {
    roadCalls.length = 0;
    const roadReport = matcher.match({
      command: command({ prefab: "Medium Road", x1: 0, z1: 0, x2: 40, z2: 0 }),
      observation: envelope({ listings: pipeListings }),
    });
    expect(roadCalls).toHaveLength(1);
    expect(roadReport.result).toBe("MATCH");
    expect(roadReport.reason).toBe("road matcher answered");

    const pipeReport = matcher.match({ command: command(), observation: envelope({ listings: pipeListings }) });
    expect(roadCalls).toHaveLength(1);
    expect(pipeReport.result).toBe("MATCH");
    expect(pipeReport.reason).toContain("Small Sewage Pipe");
  });
});

describe("laying one course along every street of a component", () => {
  const street = (index: number, x: number, z: number) => ({
    entity: { index, version: 1 },
    start: { x, z },
    end: { x: x + 40, z },
  });

  it("plans one course per street, dropping duplicates and degenerate edges", () => {
    const courses = planUtilityStreetsAlongComponent({
      prefab: "Small Sewage Pipe",
      edges: [street(1, 0, 0), street(2, 40, 0), { entity: { index: 1, version: 1 }, start: { x: 0, z: 0 }, end: { x: 40, z: 0 } },
        { entity: { index: 3, version: 1 }, start: { x: 5, z: 5 }, end: { x: 5, z: 5 } }],
    });
    expect(courses.map((course) => course.edgeRef.index)).toEqual([1, 2]);
    expect(courses[0]!.input).toEqual({ prefab: "Small Sewage Pipe", x1: 0, z1: 0, x2: 40, z2: 0 });
  });

  it("refuses to lay a prefab that is not a net course", () => {
    expect(() => planUtilityStreetsAlongComponent({ prefab: "Medium Road", edges: [street(1, 0, 0)] }))
      .toThrow("UTILITY_NET_PREFAB_NOT_LAYABLE");
  });

  it("gives every street its own command and readback", async () => {
    const seen: string[] = [];
    const report = await layUtilityAlongRoadComponent({
      prefab: "Small Sewage Pipe",
      edges: [street(1, 0, 0), street(2, 40, 0), street(3, 80, 0)],
      owner: { ownerType: "TASK", ownerId: "net-task" },
      execute: async ({ input }): Promise<RoadExecutionResult> => {
        const commandId = `command-${input.x1}`;
        seen.push(commandId);
        return {
          command: { ...command(), commandId, status: "OBSERVED_MATCH", reconciliationStatus: "MATCH" },
          admission: {} as never,
          bridgeCalled: true,
          authorizationConsumed: true,
          effectReport: { matcherResult: "MATCH", effectAbsenceProven: false, reason: "present", evidence: {} },
        };
      },
    });
    expect(seen).toEqual(["command-0", "command-40", "command-80"]);
    expect(report.planned).toBe(3);
    expect(report.attempted).toBe(3);
    expect(report.matched).toBe(3);
    expect(report.stopped).toBe(false);
    expect(report.streets.map((entry) => entry.commandId)).toEqual(["command-0", "command-40", "command-80"]);
  });

  it("stops at the first street that does not read back, and reports which", async () => {
    const attempted: number[] = [];
    const report = await layUtilityAlongRoadComponent({
      prefab: "Small Sewage Pipe",
      edges: [street(1, 0, 0), street(2, 40, 0), street(3, 80, 0)],
      owner: { ownerType: "TASK", ownerId: "net-task" },
      execute: async ({ input }): Promise<RoadExecutionResult> => {
        attempted.push(input.x1);
        const matched = input.x1 !== 40;
        return {
          command: { ...command(), commandId: `command-${input.x1}`,
            status: matched ? "OBSERVED_MATCH" : "OBSERVED_MISMATCH",
            reconciliationStatus: matched ? "MATCH" : "MISMATCH" },
          admission: {} as never,
          bridgeCalled: true,
          authorizationConsumed: true,
          effectReport: matched
            ? { matcherResult: "MATCH", effectAbsenceProven: false, reason: "present", evidence: {} }
            : { matcherResult: "MISMATCH", effectAbsenceProven: true, reason: "absent", evidence: {} },
        };
      },
    });
    expect(attempted).toEqual([0, 40]);
    expect(report.planned).toBe(3);
    expect(report.matched).toBe(1);
    expect(report.stopped).toBe(true);
    expect(report.streets.at(-1)).toMatchObject({ edgeRef: { index: 2, version: 1 }, matcherResult: "MISMATCH" });
  });
});

describe("utility street allocation across the three nets", () => {
  const street = (index: number, startNode: number, endNode: number) => ({
    ref: { index, version: 1 }, startNode: { index: startNode, version: 1 }, endNode: { index: endNode, version: 1 },
  });

  it("never gives two nets a street that shares a node", () => {
    // 1-2, 2-3, 3-4, 4-5, 5-6, 6-7: consecutive streets share a node.
    const streets = [1, 2, 3, 4, 5, 6].map((n) => street(n, n, n + 1));
    const allocation = allocateUtilityStreets({ streets });
    expect(allocation.detail).toContain("6 streets");
    const byNode = new Map<number, Set<string>>();
    for (const assignment of allocation.assignments) {
      for (const ref of assignment.streets) {
        const entry = streets.find((candidate) => candidate.ref.index === ref.index)!;
        for (const node of [entry.startNode.index, entry.endNode.index]) {
          byNode.set(node, (byNode.get(node) ?? new Set()).add(assignment.net));
        }
      }
    }
    // Nodes may still be shared in the output ONLY where the greedy gave up and
    // reported a conflict; those are named rather than hidden.
    const shared = [...byNode.values()].filter((nets) => nets.size > 1).length;
    expect(shared).toBe(allocation.conflicts.length);
    expect(allocation.unassigned.length + allocation.assignments.reduce((sum, a) => sum + a.streets.length, 0)).toBe(streets.length);
  });

  it("splits disjoint streets evenly across the three nets", () => {
    const streets = [10, 20, 30, 40, 50, 60].map((n) => street(n, n, n + 1));
    const allocation = allocateUtilityStreets({ streets });
    expect(allocation.unassigned).toEqual([]);
    expect(allocation.assignments.map((a) => a.streets.length)).toEqual([2, 2, 2]);
    expect(allocation.assignments.map((a) => a.net)).toEqual(["ELECTRICITY", "SEWAGE", "WATER"]);
  });

  it("respects the caller's net order and honours an empty district", () => {
    const streets = [1, 2].map((n) => street(n, n, n + 1));
    const ordered = allocateUtilityStreets({ streets, nets: ["WATER", "ELECTRICITY"] });
    expect(ordered.assignments[0]!.net).toBe("WATER");
    expect(ordered.assignments[0]!.streets).toHaveLength(1);
    expect(allocateUtilityStreets({ streets: [] }).detail).toContain("0 streets");
    expect(() => allocateUtilityStreets({ streets, nets: [] })).toThrow(/AT_LEAST_ONE_NET/);
  });
});

describe("utility street selection by sub-area", () => {
  const edge = (index: number, start: { x: number; z: number }, end: { x: number; z: number }) =>
    ({ entity: { index, version: 1 }, start, end });

  it("keeps only the streets whose midpoint is inside the box", () => {
    const edges = [
      edge(1, { x: 0, z: 0 }, { x: 40, z: 0 }),      // midpoint (20,0)   inside
      edge(2, { x: 100, z: 0 }, { x: 140, z: 0 }),    // midpoint (120,0)  outside
      edge(3, { x: 30, z: 30 }, { x: 50, z: 30 }),    // midpoint (40,30)  inside
    ];
    const selected = selectUtilityStreetsInBounds({ edges, bounds: { minX: 0, minZ: 0, maxX: 60, maxZ: 60 } });
    expect(selected.map((entry) => entry.entity.index)).toEqual([1, 3]);
  });

  it("does not drag in a street that only reaches the box across a junction", () => {
    // Start inside, midpoint outside: the street belongs to the far side, and
    // pulling it in would take its net with it.
    const edges = [edge(1, { x: 0, z: 0 }, { x: 400, z: 0 })];
    const selected = selectUtilityStreetsInBounds({ edges, bounds: { minX: -10, minZ: -10, maxX: 50, maxZ: 10 } });
    expect(selected).toHaveLength(0);
  });

  it("passes everything through when the box is the whole map", () => {
    const edges = [edge(1, { x: 0, z: 0 }, { x: 40, z: 0 }), edge(2, { x: 900, z: 900 }, { x: 940, z: 900 })];
    expect(selectUtilityStreetsInBounds({ edges, bounds: { minX: -1e6, minZ: -1e6, maxX: 1e6, maxZ: 1e6 } })).toHaveLength(2);
  });
});
