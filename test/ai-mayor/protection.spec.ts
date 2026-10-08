import { guardDistrictPort, pointInPolygon, ProtectionRegistry } from "../../src/main/services/ai-mayor/v2/protection";

const oldTown = { name: "Old Town", source: "test", polygon: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }] };

describe("protection filter", () => {
  it("knows inside from outside", () => {
    expect(pointInPolygon({ x: 50, z: 50 }, oldTown.polygon)).toBe(true);
    expect(pointInPolygon({ x: 150, z: 50 }, oldTown.polygon)).toBe(false);
  });

  it("a course that crosses the area is caught even when both ends are outside", () => {
    const registry = new ProtectionRegistry();
    registry.set([oldTown]);
    expect(registry.segment({ x: -50, z: 50 }, { x: 150, z: 50 })?.name).toBe("Old Town");
    expect(registry.segment({ x: -50, z: 150 }, { x: 150, z: 150 })).toBeNull();
  });

  it("a footprint that reaches the edge is caught; one clear of it is not", () => {
    const registry = new ProtectionRegistry();
    registry.set([oldTown]);
    expect(registry.circle({ x: 110, z: 50 }, 24)?.name).toBe("Old Town");
    expect(registry.circle({ x: 140, z: 50 }, 24)).toBeNull();
  });

  it("the guarded port refuses writes into the area before they reach the game, and passes the rest unchanged", async () => {
    const registry = new ProtectionRegistry();
    registry.set([oldTown]);
    const calls: string[] = [];
    const port = {
      buildRoad: async () => { calls.push("road"); return { ok: true, detail: "built" }; },
      zone: async () => { calls.push("zone"); return { ok: true, detail: "zoned" }; },
      utilities: { place: async () => { calls.push("place"); return { ok: true, detail: "placed" }; } },
    } as never;
    const guarded = guardDistrictPort(port, registry) as unknown as {
      buildRoad: (c: unknown, p: string) => Promise<{ ok: boolean; detail: string }>;
      zone: (z: string, c: unknown, r: number) => Promise<{ ok: boolean; detail: string }>;
      utilities: { place: (p: string, at: unknown, r: number) => Promise<{ ok: boolean; detail: string }> };
    };
    expect(await guarded.buildRoad({ start: { x: 50, z: -40 }, end: { x: 50, z: 40 } }, "Small Road")).toMatchObject({ ok: false, detail: expect.stringMatching(/^PROTECTED_AREA:Old Town/) });
    expect(await guarded.zone("Residential", { x: 90, z: 50 }, 30)).toMatchObject({ ok: false });
    expect(await guarded.utilities.place("WindTurbine01", { x: 50, z: 50 }, 0)).toMatchObject({ ok: false });
    expect(await guarded.buildRoad({ start: { x: 200, z: 0 }, end: { x: 300, z: 0 } }, "Small Road")).toEqual({ ok: true, detail: "built" });
    expect(calls).toEqual(["road"]);
  });

  it("'don't change the roads' stops every road removal, and only while it is in force", async () => {
    const removed: number[] = [];
    const port = { buildRoad: async () => ({ ok: true, detail: "built" }), zone: async () => ({ ok: true, detail: "zoned" }),
      demolishRoad: async (entity: { index: number }) => { removed.push(entity.index); return true; } } as never;
    const guarded = guardDistrictPort(port, new ProtectionRegistry()) as unknown as { demolishRoad: (e: { index: number; version: number }) => Promise<boolean> };
    const previous = process.env.AI_MAYOR_KEEP_ROADS;
    try {
      process.env.AI_MAYOR_KEEP_ROADS = "1";
      expect(await guarded.demolishRoad({ index: 7, version: 1 })).toBe(false);
      process.env.AI_MAYOR_KEEP_ROADS = "0";
      expect(await guarded.demolishRoad({ index: 8, version: 1 })).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AI_MAYOR_KEEP_ROADS; else process.env.AI_MAYOR_KEEP_ROADS = previous;
    }
    expect(removed).toEqual([8]);
  });

  it("an empty registry changes nothing", async () => {
    const registry = new ProtectionRegistry();
    const port = { buildRoad: async () => ({ ok: true, detail: "built" }), zone: async () => ({ ok: true, detail: "zoned" }) } as never;
    const guarded = guardDistrictPort(port, registry) as unknown as { buildRoad: (c: unknown, p: string) => Promise<{ ok: boolean }> };
    expect(await guarded.buildRoad({ start: { x: 50, z: 50 }, end: { x: 60, z: 60 } }, "Small Road")).toMatchObject({ ok: true });
  });
});
