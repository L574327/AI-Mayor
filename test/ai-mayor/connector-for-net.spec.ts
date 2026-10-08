import { connectorForNet } from "../../src/main/services/ai-mayor/v2/district-utilities";

// The coal plant's real connector list, read live 2026-10-06 (cs2_utility_connectors on SmallCoalPowerPlant01): the high-voltage marker comes first.
const coalPlant = [
  { type: "electricity", prefab: "High-voltage Marker", voltage: "High", worldPosition: { x: 257, z: -78 } },
  { type: "electricity", prefab: "Low-voltage Marker", voltage: "Low", worldPosition: { x: 135, z: -66 } },
  { type: "electricity", prefab: "Low-voltage Marker", voltage: "Low", worldPosition: { x: 135, z: -75 } },
];

describe("connector the low-voltage cable starts from", () => {
  it("is a low-voltage connector, never the plant's high-voltage marker listed first", () => {
    expect(connectorForNet(coalPlant, "electricity")).toMatchObject({ voltage: "Low", worldPosition: { x: 135, z: -66 } });
  });
  it("a turbine with one electricity connector uses it; a facility with none falls back to the first connector", () => {
    expect(connectorForNet([{ type: "electricity", prefab: "Marker", voltage: "Low" }], "electricity")).toMatchObject({ voltage: "Low" });
    expect(connectorForNet([{ type: "water", prefab: "Pipe Marker" }], "electricity")).toMatchObject({ type: "water" });
  });
  it("only a high-voltage marker: it is used (nothing better exists)", () => {
    expect(connectorForNet([coalPlant[0]!], "electricity")).toMatchObject({ voltage: "High" });
  });
  it("water and sewage keep the first connector", () => {
    expect(connectorForNet([{ type: "water", prefab: "A" }, { type: "water", prefab: "B" }], "water")).toMatchObject({ prefab: "A" });
  });
});
