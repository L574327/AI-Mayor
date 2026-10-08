import { linkTrainStation, mergeTargets, railAnchor, stationTrackEnds, yawFacing, type OwnedTrack, type TrainLinkPort } from "../../src/main/services/ai-mayor/v2/train-link";

/**
 * Shaped on 萨利克斯 (live 2026-10-05): a native railway running north-south at x = 1400 (nodes every 200 m), the owned land ending at x = 935 and
 * the served streets reaching x = 900. Not yet run live: the station's own tracks are read through the Bridge's owner read, which loads on restart.
 */
const rail = Array.from({ length: 12 }, (_, i) => ({ start: { x: 1400, z: -1200 + i * 200 }, end: { x: 1400, z: -1000 + i * 200 }, native: true }));
const served = [{ x: 900, z: 0 }, { x: 900, z: 200 }, { x: 600, z: 0 }];

/** A station whose own tracks run along its local X axis (front = +Z), 160 m long, centred on its position. */
function stationTracks(at: { x: number; z: number }, rotation: number, joined: { ahead: boolean; behind: boolean }): OwnedTrack[] {
  const radians = (rotation * Math.PI) / 180;
  const axis = { x: Math.cos(radians), z: -Math.sin(radians) };
  const a = { x: at.x - axis.x * 80, z: at.z - axis.z * 80 };
  const b = { x: at.x + axis.x * 80, z: at.z + axis.z * 80 };
  // Which end is "ahead" along +Z (the line's direction here) decides which merge joins it.
  const aAhead = a.z > b.z;
  return [{ prefab: "Double Train Track - Station Side", start: a, end: b,
    startDegree: (aAhead ? joined.ahead : joined.behind) ? 2 : 1, endDegree: (aAhead ? joined.behind : joined.ahead) ? 2 : 1 }];
}

/** `tracksAcross`: a station whose tracks run along its local Z (front to back), so the first placement lies across the line. */
function world(options: { locked?: boolean; owned?: (point: { x: number }) => boolean; refuseTrack?: boolean; ownerRead?: boolean; tracksAcross?: boolean } = {}) {
  let station: { at: { x: number; z: number }; rotation: number } | null = null;
  const joined = { ahead: false, behind: false };
  const laid: Array<{ prefab: string; from: { x: number; z: number }; to: { x: number; z: number } }> = [];
  const removed: number[] = [];
  const bought: Array<{ x: number; z: number }> = [];
  let nextNet = 900;
  const port: TrainLinkPort = {
    railEdges: async () => rail,
    stationPrefabs: async () => (options.locked ? [] : ["TrainStation01"]),
    trackPrefab: async () => (options.locked ? null : "Double Train Track"),
    listStations: async () => (station ? [{ entity: { index: 77, version: 1 }, position: station.at }] : []),
    preflight: async () => true,
    place: async (_prefab, point, rotation) => { station = { at: point, rotation }; return { ok: true, detail: "placed" }; },
    ownedTracks: async () => (options.ownerRead === false ? null : station ? stationTracks(station.at, station.rotation + (options.tracksAcross ? 90 : 0), joined) : []),
    frontage: async () => (station ? { x: station.at.x - 40, z: station.at.z } : null),
    lay: async (prefab, from, to) => {
      if (options.refuseTrack && /Train/.test(prefab)) return { ok: false, detail: "blocked" };
      laid.push({ prefab, from, to });
      if (/Train/.test(prefab)) { if (to.z > from.z) joined.ahead = true; else joined.behind = true; }
      nextNet += 1;
      return { ok: true, detail: "accepted", created: [{ index: nextNet, version: 1 }] };
    },
    remove: async (entity) => { removed.push(entity.index); if (entity.index === 77) station = null; return true; },
  };
  const input = { servedNodes: served, isOwned: options.owned ?? ((point: { x: number }) => point.x <= 935),
    acquire: async (point: { x: number; z: number }) => { bought.push(point); return true; } };
  return { port, input, laid, removed, bought };
}

describe("passenger trains from outside: a station on the map's own railway, joined to it on both sides and to the streets", () => {
  test("the anchor is the native rail node nearest a served street, with the line's direction and the side the city is on", () => {
    const anchor = railAnchor(rail, served)!;
    expect(anchor.node).toEqual({ x: 1400, z: 0 });
    expect(Math.abs(anchor.along.z)).toBeCloseTo(1);
    expect(anchor.toCity.x).toBeCloseTo(-1);
    expect(railAnchor(rail.map((edge) => ({ ...edge, native: false })), served)).toBeNull();
    expect(railAnchor(rail, [{ x: -3000, z: 0 }])).toBeNull();
  });

  test("a building faces where it is told: yaw 0 faces +Z, 270 faces -X (toward the city here)", () => {
    expect(yawFacing({ x: 0, z: 1 })).toBeCloseTo(0);
    expect(yawFacing({ x: -1, z: 0 })).toBeCloseTo(270);
  });

  test("the station's free track ends are split ahead/behind along the line, and a station turned across the line is recognised", () => {
    const along = { x: 0, z: 1 };
    const withLine = stationTrackEnds(stationTracks({ x: 1345, z: 0 }, 90, { ahead: false, behind: false }), { x: 1345, z: 0 }, along);
    expect(withLine).toMatchObject({ parallel: true });
    expect(withLine.ahead).toHaveLength(1);
    expect(withLine.behind).toHaveLength(1);
    expect(stationTrackEnds(stationTracks({ x: 1345, z: 0 }, 0, { ahead: false, behind: false }), { x: 1345, z: 0 }, along).parallel).toBe(false);
  });

  test("merges join native nodes far enough along the line beyond the end, nearest first", () => {
    const anchor = railAnchor(rail, served)!;
    const targets = mergeTargets({ x: 1345, z: 80 }, 1, anchor);
    expect(targets[0]).toEqual({ x: 1400, z: 200 });
    expect(targets.every((node) => node.z - 80 >= 120)).toBe(true);
  });

  test("the whole link: the railway tile is bought, the station placed facing the city, both sides merged, a road to the street", async () => {
    const { port, input, laid, bought, removed } = world();
    const notes: string[] = [];
    const outcome = await linkTrainStation(port, input, notes);
    expect(outcome.status).toBe("LINKED");
    expect(bought.length).toBeGreaterThan(0);
    expect(removed).toHaveLength(0);
    expect(laid.filter((entry) => /Train/.test(entry.prefab))).toHaveLength(2);
    expect(laid.some((entry) => entry.prefab === "Medium Road")).toBe(true);
    expect(notes.join(" | ")).toMatch(/joined to the map's railway on both sides/);
  });

  test("a station whose tracks lie across the line is taken down and placed again turned a quarter", async () => {
    const { port, input, removed } = world({ tracksAcross: true });
    const notes: string[] = [];
    expect((await linkTrainStation(port, input, notes)).status).toBe("LINKED");
    expect(removed).toEqual([77]);
    expect(notes.join(" | ")).toMatch(/tracks do not run with the line/);
  });

  test("control: trains still locked, or a station already standing: nothing is done", async () => {
    const locked = world({ locked: true });
    expect((await linkTrainStation(locked.port, locked.input, [])).status).toBe("LOCKED");
    const twice = world();
    await linkTrainStation(twice.port, twice.input, []);
    expect((await linkTrainStation(twice.port, twice.input, [])).status).toBe("STANDING");
  });

  test("control: the main line refuses the merges: the station and every piece laid for it are taken down", async () => {
    const { port, input, removed } = world({ refuseTrack: true });
    const notes: string[] = [];
    expect((await linkTrainStation(port, input, notes)).status).toBe("LINK_FAILED");
    expect(removed).toContain(77);
    expect(notes.join(" ")).toMatch(/joined the main line on 0 of 2 sides; taken down/);
  });

  test("control: an older Bridge that cannot read the station's own tracks: taken down at once, and the note says a restart is needed", async () => {
    const { port, input, removed } = world({ ownerRead: false });
    const notes: string[] = [];
    expect((await linkTrainStation(port, input, notes)).status).toBe("NO_TRACK_READ");
    expect(removed).toEqual([77]);
    expect(notes.join(" ")).toMatch(/restart the game after the Bridge build/);
  });

  test("control: the railway land is not owned and cannot be bought: no station is placed", async () => {
    const { port, input, laid } = world();
    const outcome = await linkTrainStation(port, { ...input, acquire: async () => false }, []);
    expect(outcome.status).toBe("NO_LAND");
    expect(laid).toHaveLength(0);
  });
});
