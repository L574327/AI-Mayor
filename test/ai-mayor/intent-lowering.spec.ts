import { lowerInstruction, matchDistrict, mergeProtectedAreas, type CityDistrict } from "../../src/main/services/ai-mayor/host/intent-lowering";

const square = (x: number, z: number) => [{ x, z }, { x: x + 100, z }, { x: x + 100, z: z + 100 }, { x, z: z + 100 }];
const districts: CityDistrict[] = [
  { key: "district:11", name: "老城区", outline: square(0, 0) },
  { key: "district:12", name: "East Bank", outline: square(500, 0) },
  { key: "district:13", name: "East Bank Docks", outline: square(900, 0) },
];
const base = { districts, session: "s1", generation: 1, population: 12000, cash: 500000, previous: null, lang: "zh" as const };

describe("intent lowering (compiler subset)", () => {
  it("finds a district by the name the player used", () => {
    expect(matchDistrict("老城", districts).district?.key).toBe("district:11");
    expect(matchDistrict("east bank", districts).district?.key).toBe("district:12");
    expect(matchDistrict("East", districts).district).toBeNull();
    expect(matchDistrict("East", districts).ambiguous).toHaveLength(2);
  });

  it("a preserved district becomes a protected area with its own outline, through the compiler", () => {
    const lowered = lowerInstruction({ ...base, updateId: "u1", instruction: { goal: { kind: "GOAL", type: "GROW_POPULATION", priority: "NORMAL" }, forbid: [], preserve: ["老城区"], unsupported: [] } });
    expect(lowered.accepted).toBe(true);
    expect(lowered.protectedAreas).toEqual([{ name: "老城区", polygon: square(0, 0), source: "player instruction" }]);
    expect(lowered.goal?.type).toBe("GROW_POPULATION");
    expect(lowered.revision?.revision).toBe(1);
  });

  it("forbids turn into the permissions the runtime reads; land is the product's own permission", () => {
    const lowered = lowerInstruction({ ...base, updateId: "u2", instruction: { goal: null, forbid: ["loan", "demolition", "land_purchase"], preserve: [], unsupported: [] } });
    expect(lowered.accepted).toBe(true);
    expect(lowered.permissions).toEqual({ allowEconomy: false, preservePlayerAssets: true, allowLand: false });
  });

  it("a later instruction keeps what was asked before (the revision carries it)", () => {
    const first = lowerInstruction({ ...base, updateId: "u3", instruction: { goal: null, forbid: [], preserve: ["老城区"], unsupported: [] } });
    const second = lowerInstruction({ ...base, previous: first.revision, updateId: "u4", instruction: { goal: null, forbid: ["loan"], preserve: ["East Bank"], unsupported: [] } });
    expect(second.accepted).toBe(true);
    expect(second.protectedAreas.map((area) => area.name).sort()).toEqual(["East Bank", "老城区"]);
    expect(second.revision?.revision).toBe(2);
  });

  it("'don't rezone' and 'don't change the roads' become the runtime's keep switches", () => {
    const lowered = lowerInstruction({ ...base, updateId: "u6", instruction: { goal: null, forbid: ["zoning_change", "road_rebuild"], preserve: [], unsupported: [] } });
    expect(lowered.accepted).toBe(true);
    expect(lowered.permissions).toEqual({ keepZoning: true, keepRoads: true });
  });

  it("an older forbid does not come back with a later, unrelated instruction (Settings may have lifted it)", () => {
    const first = lowerInstruction({ ...base, updateId: "u7", instruction: { goal: null, forbid: ["loan"], preserve: [], unsupported: [] } });
    const second = lowerInstruction({ ...base, previous: first.revision, updateId: "u8", instruction: { goal: null, forbid: [], preserve: ["老城区"], unsupported: [] } });
    expect(second.accepted).toBe(true);
    expect(second.permissions).toEqual({});
    expect(second.protectedAreas.map((area) => area.name)).toEqual(["老城区"]);
  });

  it("kept areas add up across instructions: a later forbid or an unknown name never drops one (live bug, 2026-10-06)", () => {
    const first = lowerInstruction({ ...base, updateId: "m1", instruction: { goal: null, forbid: [], preserve: ["老城区", "East Bank"], unsupported: [] } });
    expect(first.protectedAreas).toHaveLength(2);
    // The engine reads districts only for an instruction that names one: a forbid alone resolves none of them.
    const loans = lowerInstruction({ ...base, districts: [], previous: first.revision, updateId: "m2", instruction: { goal: null, forbid: ["loan"], preserve: [], unsupported: [] } });
    const unknown = lowerInstruction({ ...base, previous: loans.revision, updateId: "m3", instruction: { goal: null, forbid: [], preserve: ["Primrose Hills"], unsupported: [] } });
    let kept = mergeProtectedAreas([], first.protectedAreas);
    kept = mergeProtectedAreas(kept, loans.protectedAreas);
    kept = mergeProtectedAreas(kept, unknown.protectedAreas);
    expect(kept.map((area) => area.name).sort()).toEqual(["East Bank", "老城区"]);
    // Named again with a new outline: replaced, not doubled.
    const moved = { name: "老城区", polygon: square(10, 10), source: "player instruction" };
    expect(mergeProtectedAreas(kept, [moved]).filter((area) => area.name === "老城区")).toEqual([moved]);
  });

  it("an unknown or ambiguous district is said plainly and protects nothing by guess", () => {
    const lowered = lowerInstruction({ ...base, updateId: "u5", instruction: { goal: null, forbid: [], preserve: ["新城区", "East"], unsupported: ["metro lines"] } });
    expect(lowered.protectedAreas).toEqual([]);
    expect(lowered.notes.join(" | ")).toMatch(/没有叫“新城区”的区/);
    expect(lowered.notes.join(" | ")).toMatch(/多个区/);
    expect(lowered.notes.join(" | ")).toMatch(/暂不支持：metro lines/);
  });
});
