import type { V2CommandRecord } from "../../src/main/services/ai-mayor/v2/foundation";
import {
  matchRecordedAuthorizedZoningEffect,
  matchRecordedZoningCells,
  recordedZoningCellPositions,
} from "../../src/main/services/ai-mayor/v2/main-adapter";
import type { SpatialZoningCell } from "../../src/main/services/ai-mayor/spatial/types";

/**
 * The live zoning command whose descendant confirmation refused (2026-09-28):
 * five cells of block `54423:1` authorized as residential by command
 * `478da38a`.
 *
 * The positions below are the ones the command itself recorded in its PRE_SUBMIT
 * evidence, and the ids are the ones it authorized. On the reloaded world the
 * block entity is gone -- the same cells are now `196832:1` -- which is why a
 * lookup keyed on the recorded block id finds nothing at all.
 */
const AUTHORIZED: Array<{ index: number; x: number; z: number }> = [
  { index: 1, x: -1209.924, z: -295.976 },
  { index: 2, x: -1217.924, z: -296.023 },
  { index: 3, x: -1225.924, z: -296.070 },
  { index: 6, x: -1209.877, z: -303.976 },
  { index: 7, x: -1217.877, z: -304.023 },
];

const RECORDED_BLOCK = { index: 54423, version: 1 };
/** One extra cell the recorded read saw but the command never authorized. */
const RECORDED_NEIGHBOUR = { block: { index: 54423, version: 1 }, index: 4, x: -1219.924, z: -309.117 };

function zoningCommand(overrides: { evidence?: unknown[] | null } = {}): V2CommandRecord {
  const cells =
    overrides.evidence === null
      ? []
      : (overrides.evidence ??
        [
          ...AUTHORIZED.map((cell) => ({
            block: RECORDED_BLOCK,
            index: cell.index,
            position: { x: cell.x, y: 328.9, z: cell.z },
            visible: true,
            zoneType: 0,
            zoneCategory: "none",
          })),
          {
            block: RECORDED_NEIGHBOUR.block,
            index: RECORDED_NEIGHBOUR.index,
            position: { x: RECORDED_NEIGHBOUR.x, y: 328.9, z: RECORDED_NEIGHBOUR.z },
            visible: true,
            zoneType: 0,
            zoneCategory: "none",
          },
        ]);
  return {
    schemaVersion: "ai-mayor-v2-command/1",
    commandId: "zoning-command",
    actionFamily: "ZONING",
    actionType: "zone",
    authorizedScope: {
      owner: { ownerType: "TASK", ownerId: "zoning-task" },
      actionFamily: "ZONING",
      allowedCells: AUTHORIZED.map((cell) => ({ block: RECORDED_BLOCK, cellIndex: cell.index })),
      spatialEnvelope: { center: { x: -1199.9711519313878, z: -287.9176788274782 }, radius: 27.203807598087373 },
      maximumAffectedArea: { maxCellCount: 5, maxRadiusMeters: 28 },
      budget: { maximumCost: null, currency: null, status: "PLACEHOLDER" },
      observationPrecondition: { observationId: "observation", runtimeEpoch: "runtime", coherence: "STABLE_FRAME" },
      intendedEffect: { zoneCategory: "residential" },
    },
    createdAt: "2026-09-28T20:26:40.647Z",
    submittedAt: "2026-09-28T20:26:41.316Z",
    nativeResultSummary: null,
    status: "OBSERVED_MATCH",
    statusHistory: [],
    reconciliationStatus: "MATCH",
    observationEvidence: cells.length > 0
      ? [{ phase: "PRE_SUBMIT", observationId: "pre", coherence: "STABLE_FRAME", recordedAt: "t", summary: "s", details: { cells } }]
      : [],
    failureOrUnknownReason: null,
    effectAbsenceProven: false,
  } as unknown as V2CommandRecord;
}

/** The reloaded world's own cells: a different block entity, the same positions. */
function currentCell(
  block: { index: number; version: number },
  index: number,
  x: number,
  z: number,
  zoneCategory: SpatialZoningCell["zoneCategory"],
  occupied = false,
): SpatialZoningCell {
  return {
    block, index, position: { x, y: 328.9, z }, visible: true, roadside: true,
    occupied, blocked: false, overridden: false, zoneType: zoneCategory === "none" ? 0 : 1, zoneCategory,
  };
}

const RELOADED_BLOCK = { index: 196832, version: 1 };
const reloadedZoned = AUTHORIZED.map((cell) =>
  currentCell(RELOADED_BLOCK, cell.index, cell.x, cell.z, "residential", true),
).concat(currentCell(
  RELOADED_BLOCK,
  RECORDED_NEIGHBOUR.index,
  RECORDED_NEIGHBOUR.x,
  RECORDED_NEIGHBOUR.z,
  "none",
));

describe("ZONING cells are re-read by position, not by block entity", () => {
  test("the authorized cells are found at their recorded positions after the block entity was replaced", () => {
    const positions = recordedZoningCellPositions(zoningCommand());
    expect(positions?.map((entry) => entry.ref.cellIndex)).toEqual([1, 2, 3, 6, 7]);
    expect(positions?.[0]?.position).toEqual({ x: -1209.924, z: -295.976 });

    const report = matchRecordedZoningCells({ command: zoningCommand(), currentCells: reloadedZoned });
    expect(report.result).toBe("MATCH");
  });

  test("a cell that is really a different category at its recorded position is unprovable, never absent", () => {
    const drifted = reloadedZoned.map((cell, i) => (i === 2 ? { ...cell, zoneCategory: "commercial" as const } : cell));
    const report = matchRecordedZoningCells({ command: zoningCommand(), currentCells: drifted });
    expect(report.result).toBe("INCONCLUSIVE");
    expect(report.reason).toContain("54423:1:3");
  });

  test("a cell missing from its recorded position is unprovable", () => {
    const trimmed = reloadedZoned.filter((cell) => cell.index !== 6);
    expect(matchRecordedZoningCells({ command: zoningCommand(), currentCells: trimmed }).result).toBe("INCONCLUSIVE");
  });

  test("a nearby zoned cell never stands in for an authorized one", () => {
    // The intended category is present in the envelope, just not where this
    // command put it: an envelope-wide match would accept it, this does not.
    const elsewhere = [
      ...reloadedZoned.filter((cell) => cell.index !== 2),
      currentCell(RELOADED_BLOCK, 2, -1217.924 + 40, -296.023, "residential"),
    ];
    expect(matchRecordedZoningCells({ command: zoningCommand(), currentCells: elsewhere }).result).toBe("INCONCLUSIVE");
  });

  test("an invisible neighbour inside the tolerance band is not a second candidate", () => {
    // Measured live (2026-10-01) after a save reload: authorized cell
    // `74929:23#3` at (-22.9317, -80.7988) matched its own successor at distance
    // 0.0000 (residential, visible, roadside) AND an invisible cell of a
    // neighbouring block 0.94 m away (category none, visible false). Counting
    // the invisible one made the match ambiguous, so the command read as
    // unproven, `confirmDescendantSaveReload` threw, and EVERY Brain tick
    // blocked on it. The recorded side is built from visible cells only, so the
    // current side must be read the same way.
    const anchor = AUTHORIZED[1];
    const withInvisibleNeighbour = [
      ...reloadedZoned,
      {
        ...currentCell({ index: 50551, version: 1 }, 27, anchor.x + 0.94, anchor.z, "none"),
        visible: false,
        roadside: false,
      },
    ];
    expect(matchRecordedZoningCells({ command: zoningCommand(), currentCells: withInvisibleNeighbour }).result)
      .toBe("MATCH");
    expect(matchRecordedAuthorizedZoningEffect({ command: zoningCommand(), currentCells: withInvisibleNeighbour }).result)
      .toBe("MATCH");
  });

  test("a visible second cell at the same recorded position is still unprovable", () => {
    // The uniqueness discipline is intact: two cells the game WOULD zone at one
    // recorded position cannot be told apart, so the effect stays unproven.
    const anchor = AUTHORIZED[1];
    const ambiguous = [
      ...reloadedZoned,
      currentCell({ index: 50551, version: 1 }, 27, anchor.x + 0.94, anchor.z, "residential"),
    ];
    expect(matchRecordedAuthorizedZoningEffect({ command: zoningCommand(), currentCells: ambiguous }).result)
      .toBe("INCONCLUSIVE");
  });

  test("an unauthorized changed cell in the native square corner is a mismatch", () => {
    const withUnauthorizedCorner = [
      ...reloadedZoned.filter((cell) => cell.index !== RECORDED_NEIGHBOUR.index),
      currentCell(RELOADED_BLOCK, RECORDED_NEIGHBOUR.index, RECORDED_NEIGHBOUR.x, RECORDED_NEIGHBOUR.z, "residential"),
    ];
    const report = matchRecordedZoningCells({ command: zoningCommand(), currentCells: withUnauthorizedCorner });
    expect(report.result).toBe("MISMATCH");
    expect(report.reason).toContain("unauthorized native marquee cell");
  });

  test("a pre-submit detail window that misses marquee corners remains inconclusive", () => {
    const command = zoningCommand();
    command.authorizedScope.spatialEnvelope.radius = 50;
    const report = matchRecordedZoningCells({ command, currentCells: reloadedZoned });
    expect(report.result).toBe("INCONCLUSIVE");
    expect(report.reason).toContain("complete native marquee square");
  });

  test("a record that never recorded the cells is unprovable rather than id-keyed", () => {
    expect(recordedZoningCellPositions(zoningCommand({ evidence: null }))).toBeNull();
    expect(
      matchRecordedZoningCells({ command: zoningCommand({ evidence: null }), currentCells: reloadedZoned }).result,
    ).toBe("INCONCLUSIVE");
  });

  test("an authorized cell the recorded read never saw is unprovable", () => {
    // The evidence covers four of the five authorized cells.
    const partial = zoningCommand().observationEvidence.slice();
    const cells = (partial[0] as { details: { cells: unknown[] } }).details.cells.slice(0, 4);
    const command = zoningCommand({ evidence: cells });
    expect(recordedZoningCellPositions(command)).toBeNull();
    expect(matchRecordedZoningCells({ command, currentCells: reloadedZoned }).result).toBe("INCONCLUSIVE");
  });

  test("cells that are all still Visible match without a visibility caveat", () => {
    // The control for the two tests below: nothing here should be reported as
    // unconfirmed, so `visibleUnconfirmed` must stay absent rather than zero.
    const report = matchRecordedAuthorizedZoningEffect({ command: zoningCommand(), currentCells: reloadedZoned });
    expect(report.result).toBe("MATCH");
    expect(report.visibleUnconfirmed).toBeUndefined();
    expect(report.reason).not.toContain("UNCONFIRMED");
  });

  test("authorized cells that lost CellFlags.Visible are still provable, and say so", () => {
    // Measured live (2026-10-02) on command `687c1f35`: all 8 authorized cells
    // sat at distance 0.00 m carrying `residential` and ALL read
    // `visible: false`, and a full 0.5 h simulation window (frame 11418507 ->
    // 11423968) did not refresh a single one. The current side's `visible`
    // filter then deleted the only candidate, `confirmDescendantSaveReload`
    // threw, and every durable write in that world was refused.
    //
    // A cell keeps its zone when it loses a simulation state bit, so an
    // unzoned-in-name-only cell is still the authorized cell -- provided it is
    // the ONLY thing at that position.
    const invisible = reloadedZoned.map((cell) => ({ ...cell, visible: false }));
    const report = matchRecordedAuthorizedZoningEffect({ command: zoningCommand(), currentCells: invisible });
    expect(report.result).toBe("MATCH");
    expect(report.visibleUnconfirmed).toBe(AUTHORIZED.length);
    expect(report.reason).toContain("UNCONFIRMED");
    expect(report.reason).toContain("CellFlags.Visible");
  });

  test("the visibility relaxation does not reopen the invisible-neighbour ambiguity", () => {
    // Two candidates in the tolerance band: the `visible` filter is final and
    // the relaxation is not reached. This is the case the relaxation must NOT
    // cover, both when the intruder sits inside the half-metre window and when
    // it sits further out but still inside the band.
    const invisible = reloadedZoned.map((cell) => ({ ...cell, visible: false }));
    const anchor = AUTHORIZED[1];
    for (const offset of [0.4, 0.94]) {
      const crowded = [
        ...invisible,
        { ...currentCell({ index: 50551, version: 1 }, 27, anchor.x + offset, anchor.z, "residential"), visible: false },
      ];
      expect(matchRecordedAuthorizedZoningEffect({ command: zoningCommand(), currentCells: crowded }).result)
        .toBe("INCONCLUSIVE");
    }
  });

  test("an invisible intruder beside a VISIBLE authorized cell still does not steal the match", () => {
    // The earlier fix must survive this one: with the target visible, a single
    // visible candidate is found and the intruder is never consulted.
    const anchor = AUTHORIZED[1];
    const withInvisibleNeighbour = [
      ...reloadedZoned,
      { ...currentCell({ index: 50551, version: 1 }, 27, anchor.x + 0.94, anchor.z, "none"), visible: false },
    ];
    const report = matchRecordedAuthorizedZoningEffect({ command: zoningCommand(), currentCells: withInvisibleNeighbour });
    expect(report.result).toBe("MATCH");
    expect(report.visibleUnconfirmed).toBeUndefined();
  });

  test("a non-zoning command has no recorded cell positions", () => {
    // The scope is what governs: a command whose scope is another family never
    // enters this path, whatever else the record happens to carry.
    const zoning = zoningCommand();
    const road = {
      ...zoning,
      actionFamily: "ROAD",
      authorizedScope: { ...zoning.authorizedScope, actionFamily: "ROAD" },
    } as unknown as V2CommandRecord;
    expect(recordedZoningCellPositions(road)).toBeNull();
    expect(matchRecordedZoningCells({ command: road, currentCells: reloadedZoned }).result).toBe("INCONCLUSIVE");
  });
});
