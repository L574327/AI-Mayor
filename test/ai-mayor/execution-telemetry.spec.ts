import { DistrictBuilder, type DistrictBuilderPort } from "../../src/main/services/ai-mayor/v2/district-builder";
import { ExecutionOutcomeRecorder, instrumentDistrictPort, refusalReason } from "../../src/main/services/ai-mayor/v2/execution-telemetry";

const basePort = (overrides: Partial<DistrictBuilderPort> = {}): DistrictBuilderPort => ({
  scanWorld: async () => ({ roadGraph: { nodes: [], edges: [] }, ownedTiles: [] }) as never,
  listBuildings: async () => [],
  siteDetail: async () => null,
  buildRoad: async () => ({ ok: true, detail: "ok" }),
  zone: async () => ({ ok: true, detail: "ok" }),
  ...overrides,
});

describe("execution outcome telemetry: records execution, decides nothing", () => {
  test("a refusal code is taken from the game's message", () => {
    expect(refusalReason('{"error":"NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED","x":1}')).toBe("NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED");
    expect(refusalReason("blocked by game validation near the junction")).toBe("blocked by game validation near the junction");
  });

  test("each primitive leaves one row with context, result, reason, attempt and latency; the call itself is unchanged", async () => {
    let clock = 1_000;
    const recorder = new ExecutionOutcomeRecorder(() => clock);
    const calls: string[] = [];
    const port = instrumentDistrictPort(basePort({
      buildRoad: async (course) => { calls.push("road"); clock += 30; return course.end.x > 100 ? { ok: false, detail: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED" } : { ok: true, detail: "ok" }; },
      purchaseTile: async () => ({ ok: true, detail: "purchased" }),
      demolishRoad: async () => false,
    }), recorder, () => clock);
    const course = { start: { x: 0, z: 0 }, end: { x: 200, z: 0 } };
    expect((await port.buildRoad(course, "Medium Road")).ok).toBe(false);
    expect((await port.buildRoad(course, "Medium Road")).ok).toBe(false);
    expect((await port.buildRoad({ start: { x: 0, z: 0 }, end: { x: 40, z: 0 } }, "Medium Road")).ok).toBe(true);
    await port.zone("EU Residential Low", { x: 10, z: 10 }, 36);
    await port.purchaseTile!({ x: 5, z: 6 });
    await port.demolishRoad!({ index: 3, version: 1 });
    expect(calls).toHaveLength(3);
    const rows = recorder.rows();
    expect(rows.map((row) => `${row.primitive}:${row.ok}:${row.attempt}`)).toEqual(["ROAD:false:1", "ROAD:false:2", "ROAD:true:1", "ZONE:true:1", "PURCHASE_TILE:true:1", "DEMOLISH_ROAD:false:1"]);
    expect(rows[0]).toMatchObject({ reason: "NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED", latencyMs: 30, context: { prefab: "Medium Road", from: "0,0", to: "200,0", meters: 200 } });
    expect(recorder.summary()).toMatch(/ROAD 1 ok\/2 refused \(NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED x2\), 1 retries/);
  });

  test("a thrown error is recorded and still thrown", async () => {
    const recorder = new ExecutionOutcomeRecorder();
    const port = instrumentDistrictPort(basePort({ zone: async () => { throw new Error("bridge busy"); } }), recorder);
    await expect(port.zone("Z", { x: 0, z: 0 }, 10)).rejects.toThrow("bridge busy");
    expect(recorder.rows()[0]).toMatchObject({ primitive: "ZONE", ok: false, reason: "bridge busy" });
  });

  test("the builder attaches the telemetry summary to its notes and behaves the same without a recorder", async () => {
    const recorder = new ExecutionOutcomeRecorder();
    const withTelemetry = new DistrictBuilder(basePort(), { outcomes: recorder });
    const result = await withTelemetry.runCycle({ demand: { residential: 50, commercial: 0, industrial: 0 }, zoneFor: () => "R" });
    const bare = await new DistrictBuilder(basePort()).runCycle({ demand: { residential: 50, commercial: 0, industrial: 0 }, zoneFor: () => "R" });
    expect(result.status).toBe(bare.status);
    expect(result.notes.filter((note) => !note.startsWith("telemetry:"))).toEqual(bare.notes);
  });
});
