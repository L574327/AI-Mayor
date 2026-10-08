import {
  BUS_MINIMUM_POPULATION, BUS_SECTOR_FAILURE_LIMIT, busLinesWanted, ensureBusLine, newBusMemory, planBusSpokes, rightSideOf, type BusPort,
} from "../../src/main/services/ai-mayor/v2/bus-lines";
import { withBusGap, servicesWanted } from "../../src/main/services/ai-mayor/v2/district-services";
import type { TransitLine, TransitStop } from "../../src/main/services/ai-mayor/v2/transit-lines";

/** A 2.4 km cross of streets through (0,0), with nodes every 200 m. */
const nodes: Array<{ x: number; z: number }> = [];
const edges: Array<{ start: { x: number; z: number }; end: { x: number; z: number } }> = [];
for (let step = -6; step < 6; step += 1) {
  edges.push({ start: { x: step * 200, z: 0 }, end: { x: (step + 1) * 200, z: 0 } });
  edges.push({ start: { x: 0, z: step * 200 }, end: { x: 0, z: (step + 1) * 200 } });
}
for (let step = -6; step <= 6; step += 1) { nodes.push({ x: step * 200, z: 0 }); nodes.push({ x: 0, z: step * 200 }); }
const stamp = (hour: number) => ({ frame: Math.round(hour * 10_922.67), cycle: hour });

function fakePort(options: { locked?: boolean; stopsLocked?: boolean; refuseStops?: boolean; lines?: TransitLine[] } = {}) {
  const stops: TransitStop[] = [];
  const placed: Array<{ x: number; z: number }> = [];
  const created: string[][] = [];
  // The game's chain: a stop built unlocks the line.
  let lineLocked = options.locked === true;
  const port: BusPort = {
    stops: async () => stops.map((stop) => ({ ...stop })),
    lines: async () => ({ lines: options.lines ?? [], prefabs: [{ name: "Bus Line", transportType: "Bus", passenger: true, locked: lineLocked }] }),
    createLine: async (_prefab, waypoints) => { created.push(waypoints); return { ok: true, detail: "ok" }; },
    runBriefly: async () => undefined,
    stopPrefabs: async () => [
      { name: "Road Outside Connection - Twoway", locked: false }, { name: "Integrated Bus Stop", locked: false },
      { name: "EU_BusStopBicycle01", locked: options.stopsLocked === true }, { name: "EU_BusStop01", locked: options.stopsLocked === true },
    ],
    placeStop: async (prefab, point) => {
      if (options.refuseStops) return { ok: false, detail: "409 blocked" };
      expect(prefab).toBe("EU_BusStop01");
      lineLocked = false;
      placed.push(point);
      stops.push({ entity: { index: 100 + stops.length, version: 1 }, prefab: "BusStop01", transportType: "Bus", outsideConnection: false, ownerPrefab: null, position: { x: point.x, z: point.z }, waitingPassengers: 0 });
      return { ok: true, detail: "ok" };
    },
  };
  return { port, placed, created };
}

describe("bus lines: how many, and where", () => {
  test("no bus below the population a line pays at; one more line for every few thousand people", () => {
    expect(busLinesWanted(BUS_MINIMUM_POPULATION - 1)).toBe(0);
    expect(busLinesWanted(BUS_MINIMUM_POPULATION)).toBe(1);
    expect(busLinesWanted(10_056)).toBe(2);
  });

  test("spokes run from the hub to the far end of the streets in each direction; the one through the traffic icons first", () => {
    const spokes = planBusSpokes({ x: 0, z: 0 }, nodes, edges, [{ x: 0, z: 700 }, { x: 10, z: 900 }]);
    expect(spokes.length).toBe(4);
    expect(spokes[0]!.far).toEqual({ x: 0, z: 1200 });
    expect(spokes[0]!.hotspots).toBe(2);
    // Out and back, a handful of stops each way.
    expect(spokes[0]!.stops.filter((stop) => stop.outbound).length).toBeGreaterThanOrEqual(2);
    expect(spokes[0]!.stops.filter((stop) => !stop.outbound).length).toBeGreaterThanOrEqual(2);
  });

  test("a stop stands on the right of the way the bus goes (right-hand traffic): the way out and the way back use opposite sidewalks", () => {
    // A street along +z; going +z the right side is +x.
    expect(rightSideOf({ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 0, z: 1 }, 6)).toEqual({ x: 6, z: 0 });
    const back = rightSideOf({ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }, 6);
    expect(back.x).toBeCloseTo(-6);
    expect(back.z).toBeCloseTo(0);
    // On the spoke along +z: the outbound stops stand at +x, the inbound ones at -x.
    const spoke = planBusSpokes({ x: 0, z: 0 }, nodes, edges).find((candidate) => candidate.far.z === 1200)!;
    expect(spoke.stops.filter((stop) => stop.outbound).every((stop) => stop.point.x > 0)).toBe(true);
    expect(spoke.stops.filter((stop) => !stop.outbound).every((stop) => stop.point.x < 0)).toBe(true);
  });
});

describe("bus lines: made through the game's own tools", () => {
  const context = (over: Partial<Parameters<typeof ensureBusLine>[1]> = {}) => ({
    population: 10_000, hub: { x: 0, z: 0 }, nodes, edges, stamp: stamp(10), memory: newBusMemory(), mayWrite: () => true, ...over,
  });

  test("live 2026-10-08 chain: stops locked = no depot yet: nothing is written, the care round places the depot", async () => {
    const { port, placed } = fakePort({ locked: true, stopsLocked: true });
    const notes: string[] = [];
    expect((await ensureBusLine(port, context(), notes)).status).toBe("LINE_LOCKED");
    expect(placed).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/bus depot/);
  });

  test("live 2026-10-08 chain: the depot stands (stops unlocked) but the line is locked: placing the stops unlocks it, and the line is drawn", async () => {
    const { port, placed, created } = fakePort({ locked: true });
    expect((await ensureBusLine(port, context(), [])).status).toBe("CREATED");
    expect(placed.length).toBeGreaterThanOrEqual(4);
    expect(created).toHaveLength(1);
  });

  test("an unserved direction gets its stops placed and one closed line through them", async () => {
    const { port, placed, created } = fakePort();
    const notes: string[] = [];
    const outcome = await ensureBusLine(port, context(), notes);
    expect(outcome.status).toBe("CREATED");
    expect(created).toHaveLength(1);
    expect(created[0]!.length).toBe(placed.length);
    expect(placed.length).toBeGreaterThanOrEqual(4);
  });

  test("enough lines for the people: nothing more is built", async () => {
    const line: TransitLine = { entity: { index: 1, version: 1 }, transportType: "Bus", stops: [], vehicleCount: 3, passengersOnBoard: 20, passengersWaiting: 4 };
    const { port, placed } = fakePort({ lines: [line, { ...line, entity: { index: 2, version: 1 } }] });
    expect((await ensureBusLine(port, context(), [])).status).toBe("ENOUGH");
    expect(placed).toHaveLength(0);
  });

  test("a direction whose stops the game refuses rests after a few refusals instead of being tried every look", async () => {
    const { port } = fakePort({ refuseStops: true });
    const memory = newBusMemory();
    const first = await ensureBusLine(port, context({ memory }), []);
    expect(first.status).toBe("STOPS_REFUSED");
    for (let index = 1; index < BUS_SECTOR_FAILURE_LIMIT; index += 1) await ensureBusLine(port, context({ memory }), []);
    const failedSector = [...memory.failures.entries()].find(([, entry]) => entry.count >= BUS_SECTOR_FAILURE_LIMIT)?.[0];
    expect(failedSector).toBeDefined();
    // The next look goes to another direction.
    const notes: string[] = [];
    await ensureBusLine(port, context({ memory }), notes);
    expect(memory.failures.size).toBeGreaterThan(1);
  });
});

describe("bus depot: evidence for the care round", () => {
  test("a city big enough for buses with the Bus Line locked wants one depot at its heart", () => {
    const reading = withBusGap({ counts: {}, items: [] }, true, { x: 5, z: 5 });
    expect(servicesWanted(reading).map((entry) => entry.need)).toContain("transit");
    expect(withBusGap({ counts: {}, items: [] }, false, { x: 5, z: 5 }).items).toHaveLength(0);
  });
});
