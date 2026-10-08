import { nearestFirst } from "../../src/main/services/ai-mayor/v2/district-builder";
import { ensureTrainLoop, trainLinePrefab, trainLoopStops, type TransitPort, type TransitStop } from "../../src/main/services/ai-mayor/v2/transit-lines";

const stop = (index: number, x: number, z: number, outsideConnection = false): TransitStop => ({
  entity: { index, version: 1 }, prefab: outsideConnection ? "Train Outside Stop" : "Integrated Passenger Train Stop", transportType: "Train",
  outsideConnection, ownerPrefab: null, position: { x, z }, waitingPassengers: 0,
});
const prefabs = [
  { name: "Cargo Train Line", transportType: "Train", passenger: false, locked: false },
  { name: "Passenger Train Line", transportType: "Train", passenger: true, locked: false },
];

function port(overrides: Partial<TransitPort> = {}): TransitPort & { created: string[][] } {
  const created: string[][] = [];
  return {
    created,
    stops: async () => [stop(1, 1570, -757), stop(2, 1579, -746), stop(9, 7172, -906, true), stop(8, -7000, 300, true)],
    lines: async () => ({ lines: [], prefabs }),
    createLine: async (_prefab, stops) => { created.push(stops); return { ok: true, detail: "{\"created\":true}" }; },
    runBriefly: async () => undefined,
    ...overrides,
  };
}

describe("transit lines", () => {
  it("picks the unlocked passenger train line, never cargo", () => {
    expect(trainLinePrefab(prefabs)).toBe("Passenger Train Line");
    expect(trainLinePrefab([{ ...prefabs[1]!, locked: true }])).toBeNull();
  });

  it("joins our platform to the nearest outside-connection stop", () => {
    const { platform, outside } = trainLoopStops([stop(1, 1570, -757), stop(9, 7172, -906, true), stop(8, -7000, 300, true)]);
    expect(platform?.entity.index).toBe(1);
    expect(outside?.entity.index).toBe(9);
  });

  it("creates the loop platform -> outside connection (the Bridge closes it)", async () => {
    const transit = port();
    const notes: string[] = [];
    const outcome = await ensureTrainLoop(transit, notes);
    expect(outcome.status).toBe("CREATED");
    // Platform 2 is the one nearest the outside connection.
    expect(transit.created).toEqual([["2:1", "9:1"]]);
  });

  it("never makes a second line when one already joins a platform to an outside connection", async () => {
    const transit = port({ lines: async () => ({ prefabs, lines: [{ entity: { index: 50, version: 1 }, transportType: "Train", vehicleCount: 2, passengersOnBoard: 31, passengersWaiting: 4,
      stops: [{ stop: { index: 2, version: 1 }, position: { x: 0, z: 0 }, waitingPassengers: 4 }, { stop: { index: 9, version: 1 }, position: { x: 0, z: 0 }, waitingPassengers: 0 }] }] }) });
    const outcome = await ensureTrainLoop(transit, []);
    expect(outcome).toMatchObject({ status: "EXISTS", passengersOnBoard: 31 });
    expect(transit.created).toEqual([]);
  });

  it("lets the simulation run once and retries when the pathfinder has not finished", async () => {
    let calls = 0; let ran = 0;
    const transit = port({ createLine: async () => { calls += 1; return calls === 1 ? { ok: false, detail: "ROUTE_PATH_PENDING" } : { ok: true, detail: "" }; },
      runBriefly: async () => { ran += 1; } });
    expect((await ensureTrainLoop(transit, [])).status).toBe("CREATED");
    expect([calls, ran]).toEqual([2, 1]);
  });

  it("reports a missing outside stop and an unreadable Bridge instead of guessing", async () => {
    expect((await ensureTrainLoop(port({ stops: async () => [stop(1, 0, 0)] }), [])).status).toBe("NO_OUTSIDE_STOP");
    expect((await ensureTrainLoop(port({ stops: async () => null }), [])).status).toBe("UNREADABLE");
  });

  it("orders high-density sites nearest the station first, keeping ties in order", () => {
    const sites = [{ id: "far", x: 900, z: 0 }, { id: "near", x: 100, z: 0 }, { id: "tie", x: 0, z: 100 }];
    expect(nearestFirst(sites, { x: 0, z: 0 }, (site) => site).map((site) => site.id)).toEqual(["near", "tie", "far"]);
  });
});
