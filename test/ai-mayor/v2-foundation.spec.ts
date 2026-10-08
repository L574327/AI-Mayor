import {
  availableSource,
  commandRetrySafety,
  createMemoryCommandJournal,
  createV2ObservationPorts,
  createV2ZoningKernel,
  matchZoningEffect,
  nativeZoningMarqueeFootprint,
  observationRequestForZoning,
  V2SubmissionTimeoutError,
  type AuthorizedMutationScope,
  type V2ObservationEnvelope,
  type V2ObservationPorts,
  type ZoningIntent,
} from "../../src/main/services/ai-mayor/v2/foundation";
import { createV2FoundationPorts } from "../../src/main/services/ai-mayor/v2/main-adapter";
import type { SpatialSiteDetail, SpatialZoningCell } from "../../src/main/services/ai-mayor/spatial/types";

const terrain = {
  resolution: 1,
  bounds: { minX: -20, minZ: -20, maxX: 20, maxZ: 20 },
  cellSize: { x: 40, z: 40 },
  heights: [0],
  waterDepths: [0],
  groundWater: [0],
  groundWaterPollution: [0],
  windSpeed: [0],
};

function cell(index: number, overrides: Partial<SpatialZoningCell> = {}): SpatialZoningCell {
  return {
    block: { index: 10, version: 1 },
    index,
    position: { x: index * 4, y: 0, z: 0 },
    visible: true,
    roadside: true,
    occupied: false,
    blocked: false,
    overridden: false,
    zoneType: 0,
    zoneCategory: "none",
    ...overrides,
  };
}

function detail(cells: SpatialZoningCell[]): SpatialSiteDetail {
  return {
    center: { x: 0, z: 0 },
    radius: 16,
    terrain,
    roadGraph: { nodes: [], edges: [] },
    buildings: [],
    zoningCells: cells,
  };
}

let envelopeSequence = 0;
function envelope(cells: SpatialZoningCell[], coherence: V2ObservationEnvelope["coherence"] = "STABLE_FRAME") {
  const observationId = `observation-${++envelopeSequence}`;
  const source = (data: unknown) => ({
    status: "AVAILABLE" as const,
    data,
    readStartedAt: "2026-09-12T00:00:00.000Z",
    readEndedAt: "2026-09-12T00:00:00.001Z",
    simulationFrameStart: 100,
    simulationFrameEnd: 100,
    freshness: { basis: "WALL_CLOCK_CAPTURE_WINDOW" as const, ageAtEnvelopeEndMs: 0 },
  });
  return {
    schemaVersion: "ai-mayor-v2-observation/1" as const,
    observationId,
    runtimeEpoch: "runtime:test",
    worldEpoch: { kind: "RUNTIME_SESSION" as const, value: "runtime:test", durableAcrossSaveLoad: false as const },
    readStartedAt: "2026-09-12T00:00:00.000Z",
    readEndedAt: "2026-09-12T00:00:00.002Z",
    simulationFrameStart: 100,
    simulationFrameEnd: 100,
    gameTimeStart: "2027-01-01 12:00",
    gameTimeEnd: "2027-01-01 12:00",
    pausedBefore: true,
    pausedAfter: true,
    coherence,
    sourceFreshness: {
      basis: "WALL_CLOCK_CAPTURE_WINDOW" as const,
      maximumAgeMs: 0,
      allRequiredSourcesAvailable: true,
    },
    revision: { authoritativeWorldRevision: null },
    sources: {
      gameStateBefore: source({ simulation: { frameIndex: 100, paused: true } }),
      snapshot: source({}),
      spatialScan: source({}),
      spatialDetail: source(detail(cells)),
      gameStateAfter: source({ simulation: { frameIndex: 100, paused: true } }),
    },
  } satisfies V2ObservationEnvelope;
}

function zoningIntent(baseline: V2ObservationEnvelope, cells: SpatialZoningCell[]): ZoningIntent {
  const refs = cells.map((entry) => ({
    block: entry.block,
    cellIndex: entry.index,
    expected: {
      zoneType: entry.zoneType,
      zoneCategory: entry.zoneCategory,
      visible: entry.visible,
      roadside: entry.roadside,
      occupied: entry.occupied,
      blocked: entry.blocked,
      overridden: entry.overridden,
    },
  }));
  const scope: AuthorizedMutationScope = {
    owner: { ownerType: "TRANCHE", ownerId: "tranche-test" },
    actionFamily: "ZONING",
    allowedCells: refs.map(({ block, cellIndex }) => ({ block, cellIndex })),
    spatialEnvelope: { center: { x: 0, z: 0 }, radius: 8 },
    maximumAffectedArea: { maxCellCount: refs.length, maxRadiusMeters: 8 },
    budget: { maximumCost: null, currency: null, status: "PLACEHOLDER" },
    observationPrecondition: {
      observationId: baseline.observationId,
      runtimeEpoch: baseline.runtimeEpoch,
      coherence: baseline.coherence,
    },
  };
  return {
    intentId: "intent-test",
    scope,
    zoneCategory: "residential",
    nativeZone: "EU Residential Low",
    authorizedCells: refs,
    spatialEnvelope: { center: { x: 0, z: 0 }, radius: 8, resolution: 8 },
  };
}

function sequenceObservation(...values: V2ObservationEnvelope[]): V2ObservationPorts {
  let index = 0;
  return {
    runtimeEpoch: "runtime:test",
    capture: async () => values[Math.min(index++, values.length - 1)],
  };
}

describe("V2 pure observation boundary and envelope", () => {
  function observationWithFrames(frames: Array<number | null>) {
    let stateRead = 0;
    const calls: string[] = [];
    const ports = createV2ObservationPorts({
      runtimeEpoch: "runtime:test",
      createId: () => "observation-test",
      readers: {
        readGameState: async () => {
          calls.push("state");
          const frame = frames[stateRead++];
          return availableSource({ simulation: { frameIndex: frame, paused: true }, gameDateTime: "2027-01-01" });
        },
        readSnapshot: async () => {
          calls.push("snapshot");
          return availableSource({ population: { current: 100 } });
        },
        readSpatialScan: async () => {
          calls.push("spatialScan");
          return availableSource({ roadGraph: { edges: [] } });
        },
        readSpatialDetail: async () => {
          calls.push("spatialDetail");
          return availableSource(detail([cell(0)]));
        },
      },
    });
    return { ports, calls };
  }

  test("marks a paused unchanged frame as STABLE_FRAME without planner calls", async () => {
    const { ports, calls } = observationWithFrames([100, 100]);
    const result = await ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 } });
    expect(result.coherence).toBe("STABLE_FRAME");
    expect(result.pausedBefore).toBe(true);
    expect(result.pausedAfter).toBe(true);
    expect(calls.sort()).toEqual(["snapshot", "spatialDetail", "spatialScan", "state", "state"].sort());
  });

  test("marks frame movement inside the read window as BOUNDED_DRIFT", async () => {
    const { ports } = observationWithFrames([100, 104]);
    await expect(ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 } })).resolves.toMatchObject({
      coherence: "BOUNDED_DRIFT",
      simulationFrameStart: 100,
      simulationFrameEnd: 104,
    });
  });

  test("marks missing frame evidence as UNKNOWN", async () => {
    const { ports } = observationWithFrames([null, null]);
    await expect(ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 } })).resolves.toMatchObject({
      coherence: "UNKNOWN",
      simulationFrameStart: null,
      simulationFrameEnd: null,
    });
  });

  test("labels a synthetic spatial hash as cache-only, never authoritative", async () => {
    const { ports } = observationWithFrames([100, 100]);
    const result = await ports.capture({
      spatialDetail: { x: 0, z: 0, radius: 16 },
      syntheticCacheRevision: "synthetic-site-hash",
    });
    expect(result.revision).toEqual({
      authoritativeWorldRevision: null,
      syntheticCacheRevision: { value: "synthetic-site-hash", authority: "SYNTHETIC_CACHE_ONLY" },
    });
  });

  test("keeps source unavailability distinct from temporal frame drift", async () => {
    const ports = createV2ObservationPorts({
      runtimeEpoch: "runtime:test",
      readers: {
        readGameState: async () => availableSource({ simulation: { frameIndex: 100, paused: true } }),
        readSnapshot: async () => availableSource({}),
        readSpatialScan: async () => availableSource({}),
        readSpatialDetail: async () => {
          throw new Error("MCP schema rejected observation window");
        },
      },
    });
    const result = await ports.capture({ spatialDetail: { x: 0, z: 0, radius: 64, resolution: 16 } });
    expect(result.coherence).toBe("UNKNOWN");
    expect(result.sources.spatialDetail.status).toBe("UNAVAILABLE");
    expect(result.sources.spatialDetail.reason).toContain("schema rejected");
    expect(result.simulationFrameStart).toBe(100);
    expect(result.simulationFrameEnd).toBe(100);
  });

  // Throughput, 2026-10-02. A site search reads one anchor's detail grid at a
  // time and drops the snapshot and the whole road-graph scan of every capture
  // it takes. Live, that was 162 scans and 162 snapshots in a single blocked
  // tick, 45.5 s of scan alone across three ticks. Declining a source has to
  // cost nothing AND change nothing about the answer the caller gets.
  test("a declined global source is not read, and does not decide coherence", async () => {
    const { ports, calls } = observationWithFrames([100, 100]);
    const result = await ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 }, globalSources: [] });
    expect(calls.sort()).toEqual(["spatialDetail", "state", "state"]);
    expect(result.sources.snapshot.status).toBe("UNAVAILABLE");
    expect(result.sources.spatialScan.status).toBe("UNAVAILABLE");
    expect(result.sources.snapshot.reason).toBe("NOT_REQUESTED");
    expect(result.sources.spatialScan.reason).toBe("NOT_REQUESTED");
    // The detail and both frame reads still happened, so coherence is still the
    // same answer to the same question.
    expect(result.coherence).toBe("STABLE_FRAME");
    expect(result.sources.spatialDetail.status).toBe("AVAILABLE");
    expect(result.sourceFreshness.allRequiredSourcesAvailable).toBe(true);
  });

  test("naming one global source reads that one and only that one", async () => {
    const { ports, calls } = observationWithFrames([100, 100]);
    const result = await ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 }, globalSources: ["snapshot"] });
    expect(calls.sort()).toEqual(["snapshot", "spatialDetail", "state", "state"]);
    expect(result.sources.snapshot.status).toBe("AVAILABLE");
    expect(result.sources.spatialScan.status).toBe("UNAVAILABLE");
  });

  test("a source the caller declined cannot make an observation incoherent", async () => {
    // The road-graph scan is the expensive read and the one a detail-only caller
    // has no use for. If it is broken, that is not that caller's problem.
    const ports = createV2ObservationPorts({
      runtimeEpoch: "runtime:test",
      readers: {
        readGameState: async () => availableSource({ simulation: { frameIndex: 100, paused: true } }),
        readSnapshot: async () => { throw new Error("snapshot unavailable"); },
        readSpatialScan: async () => { throw new Error("scan unavailable"); },
        readSpatialDetail: async () => availableSource(detail([cell(0)])),
      },
    });
    const declined = await ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 }, globalSources: [] });
    expect(declined.coherence).toBe("STABLE_FRAME");
    // The same world, read by a caller that asked for everything, is incoherent:
    // the option narrows what is asked, never what counts as an answer.
    const full = await ports.capture({ spatialDetail: { x: 0, z: 0, radius: 16 } });
    expect(full.coherence).toBe("UNKNOWN");
  });

  test("production V2 observation calls only fact readers and has no candidate registry dependency", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = ["cs2_game_state", "cs2_mayor_snapshot", "cs2_spatial", "cs2_mayor_execute_actions"];
    const manager = new Proxy(
      {
        legacyList: async () => ({ tools: tools.map((name) => ({ name: `client--${name}` })) }),
        legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
          calls.push({ name, args });
          const payload =
            name === "cs2_game_state"
              ? { simulation: { frameIndex: 7, paused: true } }
              : name === "cs2_spatial" && args.mode === "detail"
                ? detail([cell(0)])
                : {};
          return { content: [{ type: "text", text: JSON.stringify(payload) }] };
        },
      },
      {
        get(target, property, receiver) {
          if (String(property).toLowerCase().includes("candidate")) throw new Error("legacy candidate registry touched");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const ports = createV2FoundationPorts({ getToolsManager: () => manager, runtimeEpoch: "runtime:test" });
    const result = await ports.observation.capture({ spatialDetail: { x: 0, z: 0, radius: 16 } });
    expect(result.coherence).toBe("STABLE_FRAME");
    expect(calls.map((entry) => entry.name)).toEqual([
      "cs2_game_state",
      "cs2_mayor_snapshot",
      "cs2_spatial",
      "cs2_spatial",
      "cs2_game_state",
    ]);
    expect(calls.some((entry) => entry.args.mode === "preflight")).toBe(false);
    expect(calls.some((entry) => entry.name === "cs2_mayor_execute_actions")).toBe(false);
  });
});

describe("V2 command journal and exact zoning reconciliation", () => {
  test("models the native axis-aligned visible-cell marquee footprint", () => {
    const diagonal = cell(1, { position: { x: 7, y: 0, z: 7 } });
    const outside = cell(2, { position: { x: 8.01, y: 0, z: 0 } });
    const invisible = cell(3, { position: { x: 0, y: 0, z: 0 }, visible: false });
    expect(nativeZoningMarqueeFootprint(detail([diagonal, outside, invisible]), { x: 0, z: 0 }, 8))
      .toEqual([diagonal]);
  });

  test("records a definite native rejection as REJECTED", async () => {
    const beforeCells = [cell(0), cell(1)];
    const baseline = envelope(beforeCells);
    const journal = createMemoryCommandJournal();
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope(beforeCells)),
      journal,
      createId: () => "command-rejected",
      submit: async () => ({ kind: "REJECTED", reason: "native validation rejected" }),
    });
    const result = await kernel.execute(zoningIntent(baseline, beforeCells), baseline);
    expect(result.command.status).toBe("REJECTED");
    expect(result.command.submittedAt).not.toBeNull();
    expect(result.command.statusHistory.map((entry) => entry.status)).toEqual([
      "CREATED",
      "AUTHORIZED",
      "SUBMITTED",
      "REJECTED",
    ]);
  });

  test("separates commit acknowledgement from matching observed world effect", async () => {
    const beforeCells = [cell(0), cell(1)];
    const afterCells = beforeCells.map((entry) => cell(entry.index, { zoneType: 29, zoneCategory: "residential" }));
    const baseline = envelope(beforeCells);
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope(beforeCells), envelope(afterCells)),
      journal: createMemoryCommandJournal(),
      createId: () => "command-match",
      submit: async () => ({ kind: "COMMIT_ACK", summary: "committed this frame" }),
    });
    const result = await kernel.execute(zoningIntent(baseline, beforeCells), baseline);
    expect(result.command.status).toBe("OBSERVED_MATCH");
    expect(result.command.statusHistory.map((entry) => entry.status)).toEqual([
      "CREATED",
      "AUTHORIZED",
      "SUBMITTED",
      "COMMIT_ACK",
      "OBSERVED_MATCH",
    ]);
    expect(result.effectReport?.changedAuthorizedCells).toHaveLength(2);
  });

  test("records commit acknowledgement with wrong effect as OBSERVED_MISMATCH", async () => {
    const beforeCells = [cell(0)];
    const baseline = envelope(beforeCells);
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope(beforeCells), envelope(beforeCells)),
      journal: createMemoryCommandJournal(),
      createId: () => "command-mismatch",
      submit: async () => ({ kind: "COMMIT_ACK", summary: "committed" }),
    });
    const result = await kernel.execute(zoningIntent(baseline, beforeCells), baseline);
    expect(result.command.status).toBe("OBSERVED_MISMATCH");
    expect(result.command.effectAbsenceProven).toBe(true);
    expect(result.effectReport?.unchangedAuthorizedCells).toHaveLength(1);
  });

  test("transport timeout remains UNKNOWN_TIMEOUT and forbids automatic resend", async () => {
    const beforeCells = [cell(0)];
    const baseline = envelope(beforeCells);
    const journal = createMemoryCommandJournal();
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope(beforeCells)),
      journal,
      createId: () => "command-timeout",
      submit: async () => {
        throw new V2SubmissionTimeoutError("timeout after possible commit");
      },
    });
    const result = await kernel.execute(zoningIntent(baseline, beforeCells), baseline);
    expect(result.command.status).toBe("UNKNOWN_TIMEOUT");
    expect(commandRetrySafety(result.command)).toMatchObject({
      automaticResendAllowed: false,
      next: "RECONCILE_FIRST",
    });
  });

  test("inconclusive readback preserves the unknown timeout state", async () => {
    const beforeCells = [cell(0)];
    const baseline = envelope(beforeCells);
    const journal = createMemoryCommandJournal();
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope(beforeCells), envelope([], "UNKNOWN")),
      journal,
      createId: () => "command-inconclusive",
      submit: async () => {
        throw new V2SubmissionTimeoutError();
      },
    });
    const submitted = await kernel.execute(zoningIntent(baseline, beforeCells), baseline);
    const reconciled = await kernel.reconcile(submitted.command.commandId);
    expect(reconciled.effectReport.matcherResult).toBe("INCONCLUSIVE");
    expect(reconciled.command.status).toBe("UNKNOWN_TIMEOUT");
    expect(reconciled.command.reconciliationStatus).toBe("INCONCLUSIVE");
  });

  test("reports unauthorized changed cells as MISMATCH", () => {
    const beforeCells = [cell(0), cell(1)];
    const baseline = envelope(beforeCells);
    const intent = zoningIntent(baseline, [beforeCells[0]]);
    const afterCells = beforeCells.map((entry) => cell(entry.index, { zoneType: 29, zoneCategory: "residential" }));
    const report = matchZoningEffect({ intent, before: detail(beforeCells), afterEnvelope: envelope(afterCells) });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.changedUnauthorizedCells).toEqual([{ block: { index: 10, version: 1 }, cellIndex: 1 }]);
  });

  test("matches the native square corners outside the old circular radius", () => {
    const authorized = cell(0);
    const squareCorner = cell(1, { position: { x: 7, y: 0, z: 7 }, occupied: true });
    const baseline = envelope([authorized, squareCorner]);
    const intent = zoningIntent(baseline, [authorized]);
    const afterCells = [
      cell(0, { zoneType: 29, zoneCategory: "residential" }),
      cell(1, { position: { x: 7, y: 0, z: 7 }, occupied: true, zoneType: 29, zoneCategory: "residential" }),
    ];
    const report = matchZoningEffect({ intent, before: detail([authorized, squareCorner]), afterEnvelope: envelope(afterCells) });
    expect(report.matcherResult).toBe("MISMATCH");
    expect(report.changedUnauthorizedCells).toEqual([{ block: { index: 10, version: 1 }, cellIndex: 1 }]);
  });

  test("rejects occupied marquee cells before Apply instead of omitting them from authorization", async () => {
    const target = cell(0);
    const occupiedCorner = cell(1, { position: { x: 7, y: 0, z: 7 }, occupied: true });
    const baseline = envelope([target, occupiedCorner]);
    const submit = jest.fn(async () => ({ kind: "COMMIT_ACK" as const, summary: "must not run" }));
    const result = await createV2ZoningKernel({
      observation: sequenceObservation(envelope([target, occupiedCorner])),
      journal: createMemoryCommandJournal(),
      createId: () => "command-occupied-marquee-cell",
      submit,
    }).execute(zoningIntent(baseline, [target]), baseline);
    expect(result.command.status).toBe("FAILED_BEFORE_SUBMIT");
    expect(result.command.failureOrUnknownReason).toMatch(/marquee footprint.*unauthorized cell/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("rejects a disappeared exact cell before native submission", async () => {
    const baselineCells = [cell(0)];
    const baseline = envelope(baselineCells);
    const submit = jest.fn(async () => ({ kind: "COMMIT_ACK" as const, summary: "must not run" }));
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope([])),
      journal: createMemoryCommandJournal(),
      createId: () => "command-stale",
      submit,
    });
    const result = await kernel.execute(zoningIntent(baseline, baselineCells), baseline);
    expect(result.command.status).toBe("FAILED_BEFORE_SUBMIT");
    expect(result.command.failureOrUnknownReason).toMatch(/disappeared|stale/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("rejects a radius the Bridge would silently clamp before native submission", async () => {
    const baselineCells = [cell(0)];
    const baseline = envelope(baselineCells);
    const intent = zoningIntent(baseline, baselineCells);
    intent.spatialEnvelope.radius = 7;
    intent.scope.spatialEnvelope.radius = 7;
    const submit = jest.fn(async () => ({ kind: "COMMIT_ACK" as const, summary: "must not run" }));
    const result = await createV2ZoningKernel({
      observation: sequenceObservation(envelope(baselineCells)),
      journal: createMemoryCommandJournal(),
      createId: () => "command-clamped-radius",
      submit,
    }).execute(intent, baseline);
    expect(result.command.status).toBe("FAILED_BEFORE_SUBMIT");
    expect(result.command.failureOrUnknownReason).toMatch(/clamped 8m to 200m range/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("rejects a concurrent zone-type change before native submission", async () => {
    const baselineCells = [cell(0)];
    const baseline = envelope(baselineCells);
    const submit = jest.fn(async () => ({ kind: "COMMIT_ACK" as const, summary: "must not run" }));
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope([cell(0, { zoneType: 27, zoneCategory: "commercial" })])),
      journal: createMemoryCommandJournal(),
      createId: () => "command-concurrent",
      submit,
    });
    const result = await kernel.execute(zoningIntent(baseline, baselineCells), baseline);
    expect(result.command.status).toBe("FAILED_BEFORE_SUBMIT");
    expect(result.command.failureOrUnknownReason).toMatch(/changed concurrently/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("rejects radius operations that could affect unapproved cells", async () => {
    const baselineCells = [cell(0), cell(1)];
    const baseline = envelope(baselineCells);
    const intent = zoningIntent(baseline, [baselineCells[0]]);
    const submit = jest.fn(async () => ({ kind: "COMMIT_ACK" as const, summary: "must not run" }));
    const kernel = createV2ZoningKernel({
      observation: sequenceObservation(envelope(baselineCells)),
      journal: createMemoryCommandJournal(),
      createId: () => "command-radius-extra",
      submit,
    });
    const result = await kernel.execute(intent, baseline);
    expect(result.command.status).toBe("FAILED_BEFORE_SUBMIT");
    expect(result.command.failureOrUnknownReason).toMatch(/unauthorized cell/);
    expect(submit).not.toHaveBeenCalled();
  });

  test("V2 direct zoning submits a concrete zone action without choose_candidate", async () => {
    const beforeCells = [cell(0)];
    const afterCells = [cell(0, { zoneType: 29, zoneCategory: "residential" })];
    let detailReads = 0;
    const submitted: unknown[] = [];
    const tools = ["cs2_game_state", "cs2_mayor_snapshot", "cs2_spatial", "cs2_mayor_execute_actions"];
    const manager = {
      legacyList: async () => ({ tools: tools.map((name) => ({ name: `client--${name}` })) }),
      legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        let payload: unknown = {};
        if (name === "cs2_game_state") payload = { simulation: { frameIndex: 9, paused: true } };
        if (name === "cs2_spatial" && args.mode === "detail") {
          payload = detail(detailReads++ < 2 ? beforeCells : afterCells);
        }
        if (name === "cs2_mayor_execute_actions") {
          submitted.push(...(args.actions as unknown[]));
          payload = {
            ok: true,
            requested: 1,
            executed: 1,
            results: [{ index: 0, type: "zone", ok: true, summary: "committed this frame" }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    };
    const ports = createV2FoundationPorts({
      getToolsManager: () => manager,
      runtimeEpoch: "runtime:test",
      createId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    const baseline = await ports.observation.capture({ spatialDetail: { x: 0, z: 0, radius: 8 } });
    const result = await ports.zoning.execute(zoningIntent(baseline, beforeCells), baseline);
    expect(result.command.status).toBe("OBSERVED_MATCH");
    expect(submitted).toEqual([
      {
        type: "zone",
        zone: "EU Residential Low",
        x: 0,
        z: 0,
        radius: 8,
        force: false,
      },
    ]);
    expect(JSON.stringify(submitted)).not.toContain("choose_candidate");
  });

  test("uses a valid observation window while keeping an 8m mutation scope local", async () => {
    const target = cell(0);
    const unrelated = cell(10, { position: { x: 100, y: 0, z: 100 } });
    const baseline = envelope([target]);
    const before = envelope([target, unrelated]);
    const after = envelope([
      cell(0, { zoneType: 29, zoneCategory: "residential" }),
      cell(10, { position: { x: 100, y: 0, z: 100 }, zoneType: 27, zoneCategory: "commercial" }),
    ]);
    const requests: Array<{ radius: number; resolution?: number }> = [];
    const observation = {
      runtimeEpoch: "runtime:test",
      capture: async (request: { spatialDetail: { radius: number; resolution?: number } }) => {
        requests.push(request.spatialDetail);
        return requests.length === 1 ? before : after;
      },
    };
    const intent = zoningIntent(baseline, [target]);
    const result = await createV2ZoningKernel({
      observation,
      journal: createMemoryCommandJournal(),
      createId: () => "command-local-scope",
      submit: async () => ({ kind: "COMMIT_ACK", summary: "committed" }),
    }).execute(intent, baseline);
    expect(requests).toEqual([
      { x: 0, z: 0, radius: 64, resolution: 16 },
      { x: 0, z: 0, radius: 64, resolution: 16 },
    ]);
    expect(result.command.status).toBe("OBSERVED_MATCH");
    expect(result.effectReport?.authorizedCellCount).toBe(1);
    expect(result.effectReport?.changedUnauthorizedCells).toEqual([]);
    expect(result.effectReport?.cellOutcomes).toHaveLength(1);
    expect(observationRequestForZoning(intent)).toEqual({ x: 0, z: 0, radius: 64, resolution: 16 });
  });
});
