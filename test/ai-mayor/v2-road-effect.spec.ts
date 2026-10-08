import { stableRoadInput } from "../../src/main/services/ai-mayor/v2/finance";
import type {
  V2CommandRecord,
  V2ObservationEnvelope,
  V2RoadEffectProvenance,
} from "../../src/main/services/ai-mayor/v2/foundation";
import { matchRoadEffect } from "../../src/main/services/ai-mayor/v2/road-effect";
import type { RoadGeometryInput } from "../../src/main/services/ai-mayor/v2/road-kernel";

const generation = "generation-a";
const worldId = "cs2-session:session-a";
const nativeSessionGuid = "session-a";
const baseCheckpointId = "save:meta-a:data-a";

const attached: RoadGeometryInput = {
  prefab: "Medium Road",
  x1: -541.6216,
  z1: -47.279007,
  x2: -543.18,
  z2: -22.33,
  startEndpoint: {
    kind: "EXISTING_NET_NODE",
    role: "START",
    entity: { index: 193372, version: 3 },
    expectedPosition: { x: -541.6216, y: 0, z: -47.279007 },
    worldEpoch: generation,
  },
  endEndpoint: {
    kind: "NEW_FREE_ENDPOINT",
    role: "END",
    expectedPosition: { x: -543.18, y: 0, z: -22.33 },
    worldEpoch: generation,
  },
};

function command(input: RoadGeometryInput = attached): V2CommandRecord {
  const exactInput = stableRoadInput(input);
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: "road-command",
    actionFamily: "ROAD",
    actionType: "build_road",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: "road-task" },
      actionFamily: "ROAD",
      proposalId: "road-proposal",
      quoteId: "road-quote",
      fingerprint: exactInput,
      exactInput,
      budget: { authorizedMaxSpend: 200, treasurySafetyReserve: 0, currency: "GAME_MONEY" },
      observationPrecondition: { runtimeEpoch: "bridge:10", frame: 10 },
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    createdAt: "2026-09-14T00:00:00.000Z",
    submittedAt: "2026-09-14T00:00:01.000Z",
    nativeResultSummary: null,
    status: "NATIVE_COMPLETED",
    statusHistory: [],
    reconciliationStatus: "NOT_STARTED",
    observationEvidence: [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  };
}

function envelope(options: {
  edges?: unknown[];
  nodes?: unknown[];
  truncated?: boolean;
  busy?: boolean;
  worldGeneration?: string;
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
    readStartedAt: "2026-09-14T00:00:00.000Z",
    readEndedAt: "2026-09-14T00:00:00.001Z",
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 },
  });
  return {
    schemaVersion: "ai-mayor-v2-observation/1",
    observationId: "road-observation",
    runtimeEpoch: "runtime-a",
    worldEpoch: { kind: "RUNTIME_SESSION", value: "runtime-a", durableAcrossSaveLoad: false },
    readStartedAt: "2026-09-14T00:00:00.000Z",
    readEndedAt: "2026-09-14T00:00:00.002Z",
    simulationFrameStart: 10,
    simulationFrameEnd: 10,
    gameTimeStart: null,
    gameTimeEnd: null,
    pausedBefore: true,
    pausedAfter: true,
    coherence: "STABLE_FRAME",
    sourceFreshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW", maximumAgeMs: 2, allRequiredSourcesAvailable: true },
    revision: { authoritativeWorldRevision: null },
    sources: {
      gameStateBefore: source(game),
      snapshot: source({}),
      spatialScan: source({
        worldEpoch: options.worldGeneration ?? generation,
        roadGraph: {
          nodes: options.nodes ?? [],
          edges: options.edges ?? [],
          truncated: options.truncated ?? false,
        },
      }),
      spatialDetail: source({} as never),
      gameStateAfter: source(game),
    },
  };
}

/** The durable lineage the durability layer proves for this command. */
function provenance(overrides: Partial<V2RoadEffectProvenance> = {}): V2RoadEffectProvenance {
  return {
    worldId,
    nativeSessionGuid,
    baseCheckpointId,
    lineageCheckpointIds: [baseCheckpointId],
    proof: "PENDING_DESCENDANT_LINEAGE",
    ...overrides,
  };
}

const edge = {
  entity: { index: 48778, version: 9 },
  prefab: "Medium Road",
  native: false,
  startNode: { index: 188338, version: 3 },
  endNode: { index: 48759, version: 9 },
  start: { x: -533.3453, z: -179.916824 },
  end: { x: -543.18, z: -22.33 },
  length: 157.9,
};

const splitCourse: RoadGeometryInput = {
  prefab: "Small Road",
  x1: 0,
  z1: 0,
  x2: 10,
  z2: 0,
};

const splitCourseEdges = [
  {
    entity: { index: 1, version: 2 }, prefab: "Small Road", native: false,
    startNode: { index: 101, version: 1 }, endNode: { index: 102, version: 1 },
    start: { x: 0, z: 0 }, end: { x: 5, z: 0 }, length: 5,
  },
  {
    entity: { index: 2, version: 2 }, prefab: "Small Road", native: false,
    startNode: { index: 102, version: 1 }, endNode: { index: 103, version: 1 },
    start: { x: 5, z: 0 }, end: { x: 10, z: 0 }, length: 5,
  },
];

const splitCourseNodes = [
  { entity: { index: 101, version: 1 }, position: { x: 0, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 },
  { entity: { index: 102, version: 1 }, position: { x: 5, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 2 },
  { entity: { index: 103, version: 1 }, position: { x: 10, y: 0, z: 0 }, native: false, outsideConnection: false, roadDegree: 1 },
];

describe("authoritative ROAD effect certification", () => {
  test("certifies the known-good native continuation even when the source node was merged", () => {
    expect(
      matchRoadEffect({ command: command(), observation: envelope({ edges: [edge] }), provenance: provenance() }),
    ).toMatchObject({
      matcherResult: "MATCH",
      matchedEdges: [{ index: 48778, version: 9 }],
    });
  });

  test("receipt/native completion without permanent topology cannot certify effect", () => {
    expect(matchRoadEffect({ command: command(), observation: envelope(), provenance: provenance() })).toMatchObject({
      matcherResult: "MISMATCH",
      effectAbsenceProven: true,
    });
  });

  test("matches a native course realized as a connected same-prefab edge chain", () => {
    expect(matchRoadEffect({
      command: command(splitCourse),
      observation: envelope({ edges: splitCourseEdges, nodes: splitCourseNodes }),
      provenance: provenance(),
    })).toMatchObject({
      matcherResult: "MATCH",
      effectAbsenceProven: false,
      matchedEdges: [{ index: 1, version: 2 }, { index: 2, version: 2 }],
    });
  });

  test("does not join geometrically touching edges with different native nodes", () => {
    const disconnected = splitCourseEdges.map((candidate) => ({ ...candidate }));
    disconnected[1] = { ...disconnected[1]!, startNode: { index: 999, version: 1 } };
    expect(matchRoadEffect({
      command: command(splitCourse),
      observation: envelope({ edges: disconnected, nodes: splitCourseNodes }),
      provenance: provenance(),
    })).toMatchObject({ matcherResult: "MISMATCH", effectAbsenceProven: true });
  });

  test("does not accept a split chain that leaves the authorized course corridor", () => {
    const displaced = [splitCourseEdges[0]!, {
      ...splitCourseEdges[1]!, start: { x: 5, z: 4 }, end: { x: 10, z: 4 },
    }];
    expect(matchRoadEffect({
      command: command(splitCourse),
      observation: envelope({ edges: displaced, nodes: splitCourseNodes }),
      provenance: provenance(),
    })).toMatchObject({ matcherResult: "MISMATCH", effectAbsenceProven: true });
  });

  test.each([
    ["wrong prefab", { ...edge, prefab: "Highway" }, []],
    [
      "wrong live attachment",
      edge,
      [{ entity: { index: 193372, version: 3 }, position: { x: -541.6216, y: 0, z: -47.279007 }, native: false, outsideConnection: false, roadDegree: 1 }],
    ],
  ])("rejects %s", (_label, candidate, nodes) => {
    expect(
      matchRoadEffect({
        command: command(),
        observation: envelope({ edges: [candidate], nodes }),
        provenance: provenance(),
      }).matcherResult,
    ).toBe("MISMATCH");
  });

  test("fails closed for incomplete topology", () => {
    expect(
      matchRoadEffect({ command: command(), observation: envelope({ edges: [edge], truncated: true }), provenance: provenance() })
        .matcherResult,
    ).toBe("MATCH");
    expect(
      matchRoadEffect({ command: command(), observation: envelope({ truncated: true }), provenance: provenance() })
        .effectAbsenceProven,
    ).toBe(false);
  });
});

/**
 * The provenance guard.
 *
 * The rule these pin down is `RUNTIME_GENERATION_IS_NOT_PERSISTENT_WORLD_IDENTITY`:
 * the bridge mints a fresh runtime generation on every load, so a guard built on
 * "the current scan's generation equals the command's execution-time generation"
 * fails after every ordinary reload while proving nothing when it happens to
 * pass. What decides whether an observation may be attributed to a command is
 * the durable world lineage — the native world, the session guid of its save,
 * and the durable checkpoint the command was recorded against.
 */
describe("ROAD effect provenance", () => {
  test("A. a descendant reload with a changed generation still proves a surviving effect", () => {
    const report = matchRoadEffect({
      command: command(),
      observation: envelope({ edges: [edge], worldGeneration: "generation-descendant" }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.matchedEdges).toEqual([{ index: 48778, version: 9 }]);
    // The reload is visible in the evidence, and it is not what decided.
    expect(report.observedEnvelope.worldGeneration).toBe("generation-descendant");
  });

  test("B. an actual rollback that lost the effect still proves absence", () => {
    const report = matchRoadEffect({
      command: command(),
      observation: envelope({ worldGeneration: "generation-after-rollback" }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });

  test("C. similar geometry in a world no lineage owns is never inherited", () => {
    // The exact authorized geometry is present in every case below; inheriting
    // authority from it is precisely the mistake being refused.
    const observation = envelope({ edges: [edge], worldGeneration: "generation-other" });
    expect(matchRoadEffect({ command: command(), observation, provenance: null }).matcherResult).toBe("INCONCLUSIVE");
    expect(
      matchRoadEffect({ command: command(), observation, provenance: provenance({ worldId: "cs2-session:other" }) })
        .matcherResult,
    ).toBe("INCONCLUSIVE");
    expect(
      matchRoadEffect({
        command: command(),
        observation,
        provenance: provenance({ nativeSessionGuid: "session-other" }),
      }).matcherResult,
    ).toBe("INCONCLUSIVE");
    expect(
      matchRoadEffect({ command: command(), observation, provenance: provenance({ lineageCheckpointIds: [] }) })
        .matcherResult,
    ).toBe("INCONCLUSIVE");
    // A refusal must never be readable as a proven absence either.
    expect(
      matchRoadEffect({ command: command(), observation, provenance: null }).effectAbsenceProven,
    ).toBe(false);
  });

  test("D. an equal runtime generation never substitutes for a lineage", () => {
    // The observation carries the command's own execution-time generation.
    const sameGeneration = envelope({ edges: [edge], worldGeneration: generation });
    expect(matchRoadEffect({ command: command(), observation: sameGeneration, provenance: null }).matcherResult).toBe(
      "INCONCLUSIVE",
    );
    // A different world whose scan happens to carry the same generation is
    // still a different world.
    expect(
      matchRoadEffect({
        command: command(),
        observation: envelope({
          edges: [edge],
          worldGeneration: generation,
          worldId: "cs2-session:other",
          nativeSessionGuid: "session-other",
        }),
        provenance: provenance(),
      }).matcherResult,
    ).toBe("INCONCLUSIVE");
  });

  test("an observation whose two game state reads disagree about the world is not attributable", () => {
    const observation = envelope({ edges: [edge] });
    observation.sources.gameStateAfter = {
      ...observation.sources.gameStateAfter,
      data: { world: { worldId: "cs2-session:other", nativeSessionGuid: "session-other", nativeOperationBusy: false } },
    };
    expect(matchRoadEffect({ command: command(), observation, provenance: provenance() }).matcherResult).toBe(
      "INCONCLUSIVE",
    );
  });
});

// ---------------------------------------------------------------------------
// The realized junction of a course aimed at an existing network
// ---------------------------------------------------------------------------

/** The certified water access-road repair course: a curve aimed at the network. */
const REPAIR_COURSE: RoadGeometryInput = {
  prefab: "Small Road",
  x1: -226.909, z1: 1316.5,
  x2: -156.6602929, z2: 1312.469691,
  cx: -191.09731268615568, cz: 1326.4651448408797,
};

/**
 * The edge native really builds: a curved road from the requested source to the
 * junction it creates on the existing network, whose node is pulled in 1.0957 m
 * from the anchor the course asked for.
 */
const REALIZED_CURVE = {
  entity: { index: 900002, version: 1 },
  prefab: "Small Road",
  native: false,
  startNode: { index: 900003, version: 1 },
  endNode: { index: 900001, version: 1 },
  start: { x: -226.909, z: 1316.5 },
  end: { x: -157.7378, z: 1312.271 },
  length: 70.401,
};
const REALIZED_JUNCTION_NODE = {
  entity: { index: 900001, version: 1 },
  position: { x: -157.7378, y: 367.4, z: 1312.271 },
  native: true,
  outsideConnection: false,
  roadDegree: 3,
};

describe("the realized junction of a course aimed at an existing network", () => {
  test("a bounded native junction pull-in is the effect, not its absence", () => {
    const report = matchRoadEffect({
      command: command(REPAIR_COURSE),
      observation: envelope({ edges: [REALIZED_CURVE], nodes: [REALIZED_JUNCTION_NODE] }),
      provenance: provenance(),
    });
    // The realized node is 1.0957 m from the requested anchor, which is further
    // than the endpoint window and is exactly what a legal join looks like.
    expect(Math.hypot(REALIZED_CURVE.end.x - REPAIR_COURSE.x2, REALIZED_CURVE.end.z - REPAIR_COURSE.z2))
      .toBeGreaterThan(1);
    expect(report.matcherResult).toBe("MATCH");
    expect(report.effectAbsenceProven).toBe(false);
    expect(report.matchedEdges).toEqual([{ index: 900002, version: 1 }]);
  });

  test("a free end that merely lies near the anchor is not this course", () => {
    // The same shape with the same bounded offset, but the realized node carries
    // no other edge: proximity alone is not evidence of a join.
    const report = matchRoadEffect({
      command: command(REPAIR_COURSE),
      observation: envelope({
        edges: [{ ...REALIZED_CURVE, end: { x: -158.2, z: 1312.4 } }],
        nodes: [{ ...REALIZED_JUNCTION_NODE, position: { x: -158.2, y: 367.4, z: 1312.4 }, roadDegree: 1 }],
      }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });

  test("an unrelated nearby road is never inherited as this course", () => {
    // A different same-prefab road that happens to end near the anchor: its own
    // source is not this course source, so it is not this course effect.
    const report = matchRoadEffect({
      command: command(REPAIR_COURSE),
      observation: envelope({
        edges: [{ ...REALIZED_CURVE, start: { x: -140, z: 1300 }, end: { x: -157.2, z: 1312.6 } }],
        nodes: [REALIZED_JUNCTION_NODE,
          { entity: { index: 900003, version: 1 }, position: { x: -140, z: 1300 }, native: false, outsideConnection: false, roadDegree: 1 }],
      }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
  });

  test("a rolled-back world still proves the curved course absent", () => {
    const report = matchRoadEffect({
      command: command(REPAIR_COURSE),
      observation: envelope({ worldGeneration: "generation-after-rollback" }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });

  test("a curved course is never certified by its chord", () => {
    // An edge along the chord, ending exactly at the requested anchor: the same
    // endpoints, a different course. It is not this command effect, and since the
    // course carries a control point the chord is not even a candidate.
    const report = matchRoadEffect({
      command: command(REPAIR_COURSE),
      observation: envelope({
        edges: [{ ...REALIZED_CURVE, end: { x: REPAIR_COURSE.x2, z: REPAIR_COURSE.z2 } }],
        nodes: [{ ...REALIZED_JUNCTION_NODE, position: { x: REPAIR_COURSE.x2, y: 367.4, z: REPAIR_COURSE.z2 } }],
      }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.effectAbsenceProven).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The reloaded world: the recorded source id survives as a different node
// ---------------------------------------------------------------------------

/**
 * The live course whose descendant confirmation refused (2026-09-28): a
 * straight `Small Road` from a junction at (-69.9983, 1348.12158) to a free end
 * at (-56.278, 1388.368), committed by command `64bf00d4`.
 *
 * Both of the facts below were measured on the live world, not invented: the
 * road is there to two decimals, and a node answering to the recorded source id
 * `193361:1` is there too -- 7 km away, attached to nothing this course touches.
 * Entity indices are recycled across generations, which is why the id alone
 * could not answer "is this still the source".
 */
const RELOAD_COURSE: RoadGeometryInput = {
  prefab: "Small Road",
  x1: -69.9983,
  z1: 1348.12158,
  x2: -56.278115325127416,
  z2: 1388.367778981859,
  startEndpoint: {
    kind: "EXISTING_NET_NODE",
    role: "START",
    entity: { index: 193361, version: 1 },
    expectedPosition: { x: -69.9983, y: 382.46933, z: 1348.12158 },
    worldEpoch: "6af6aa03dfca45be8ecc742853029f70",
  },
  endEndpoint: {
    kind: "NEW_FREE_ENDPOINT",
    role: "END",
    expectedPosition: { x: -56.278115325127416, y: 382.46933, z: 1388.367778981859 },
    worldEpoch: "6af6aa03dfca45be8ecc742853029f70",
  },
};

/** The committed course itself, as the reloaded world really carries it. */
const RELOAD_EDGE = {
  entity: { index: 195476, version: 1 },
  prefab: "Small Road",
  native: false,
  startNode: { index: 195856, version: 1 },
  endNode: { index: 184231, version: 1 },
  start: { x: -70.0, z: 1348.12 },
  end: { x: -56.28, z: 1388.37 },
  length: 42.13,
};

const RELOAD_END_NODE = {
  entity: { index: 184231, version: 1 },
  position: { x: -56.28, y: 382.46933, z: 1388.37 },
  native: false,
  outsideConnection: false,
  roadDegree: 1,
};

/** Where the recorded source id actually resolves now: a stranger, 7 km away. */
const RECYCLED_SOURCE_NODE = {
  entity: { index: 193361, version: 1 },
  position: { x: 5891.653, y: 323.061, z: -3199.917 },
  native: false,
  outsideConnection: false,
  roadDegree: 2,
};

/** The source node as it looks when it really is still the source. */
const SOURCE_IN_PLACE = {
  entity: { index: 193361, version: 1 },
  position: { x: -69.9983, y: 382.46933, z: 1348.12158 },
  native: false,
  outsideConnection: false,
  roadDegree: 3,
};

describe("the recorded source id after a reload", () => {
  test("an id recycled 7 km away is not this course's source, and the road is still proved", () => {
    // The regression this contract exists for. Every coordinate agrees -- prefab,
    // both endpoints, the whole corridor -- and the one id-keyed test used to
    // override all of it and certify absence.
    expect(
      Math.hypot(
        RECYCLED_SOURCE_NODE.position.x - RELOAD_COURSE.x1,
        RECYCLED_SOURCE_NODE.position.z - RELOAD_COURSE.z1,
      ),
    ).toBeGreaterThan(1000);
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({ edges: [RELOAD_EDGE], nodes: [RECYCLED_SOURCE_NODE, RELOAD_END_NODE] }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.effectAbsenceProven).toBe(false);
    expect(report.matchedEdges).toEqual([{ index: 195476, version: 1 }]);
  });

  test("a source that is gone from the world entirely still leaves the course provable", () => {
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({ edges: [RELOAD_EDGE], nodes: [RELOAD_END_NODE] }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.effectAbsenceProven).toBe(false);
  });

  test("a source still at its recorded position is this course's source", () => {
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({
        edges: [{ ...RELOAD_EDGE, startNode: SOURCE_IN_PLACE.entity, start: { x: -69.9983, z: 1348.12158 } }],
        nodes: [SOURCE_IN_PLACE, RELOAD_END_NODE],
      }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MATCH");
    expect(report.effectAbsenceProven).toBe(false);
  });

  test("a live source is still required to be the road's own start, not merely nearby", () => {
    // The identity test is not loosened by any of this: while the source really
    // is in the world, the realized course has to start on it.
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({ edges: [RELOAD_EDGE], nodes: [SOURCE_IN_PLACE, RELOAD_END_NODE] }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });

  test("an id recycled outside the bounded window is a different node too", () => {
    // Position, not adjacency: ten metres away is not the node that was there.
    const displaced = {
      ...RECYCLED_SOURCE_NODE,
      position: { ...RECYCLED_SOURCE_NODE.position, x: RELOAD_COURSE.x1 + 10 },
    };
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({ edges: [RELOAD_EDGE], nodes: [displaced, RELOAD_END_NODE] }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MATCH");
  });

  test("with the source recycled and no course in the world, absence is still proven", () => {
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({ edges: [], nodes: [RECYCLED_SOURCE_NODE] }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });

  test("an unrelated road near the source is never inherited as this course", () => {
    // A same-prefab road that leaves the source and goes somewhere else: it is
    // near the anchor and it is not this course.
    const report = matchRoadEffect({
      command: command(RELOAD_COURSE),
      observation: envelope({
        edges: [{ ...RELOAD_EDGE, end: { x: -30, z: 1300 } }],
        nodes: [RECYCLED_SOURCE_NODE, {
          entity: { index: 184231, version: 1 },
          position: { x: -30, y: 382, z: 1300 },
          native: false,
          outsideConnection: false,
          roadDegree: 1,
        }],
      }),
      provenance: provenance(),
    });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.effectAbsenceProven).toBe(true);
  });
});
