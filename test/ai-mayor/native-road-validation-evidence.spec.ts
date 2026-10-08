import { normalizeNativeRoadDiagnostics } from "../../src/main/services/ai-mayor/v2/runtime-road-caller";

/**
 * The Bridge already returns the game's own refusal reasons; these pin that this
 * side actually reads them instead of collapsing the whole response to "some
 * native evidence exists".
 */
describe("native road validation evidence", () => {
  it("carries the game's own error type, offending position and tool error", () => {
    const diagnostics = normalizeNativeRoadDiagnostics({
      validation: { status: "REJECTED", allowApply: false, detailAvailable: false },
      structural: { generatedEdge: false, generatedEdgeCount: 0 },
      nativeToolErrors: [
        { errorType: "SteepTerrain", errorPrefab: { name: "ToolErrorSteepSlope" },
          position: { x: -612.5, z: -1062.5 }, priority: "High" },
        { errorType: "Water", errorPrefab: { name: "ToolErrorWater" }, position: { x: -600.0, z: -1050.0 } },
      ],
    });
    expect(diagnostics).toBeDefined();
    const errors = diagnostics!.validation?.errors ?? [];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ errorType: "SteepTerrain", severity: "NATIVE_TOOL_ERROR",
      toolError: "ToolErrorSteepSlope", atX: -612.5, atZ: -1062.5 });
    expect(errors[1]).toMatchObject({ errorType: "Water", toolError: "ToolErrorWater" });
  });

  it("keeps the validation-error shape it already had alongside the tool errors", () => {
    const diagnostics = normalizeNativeRoadDiagnostics({
      validation: { status: "REJECTED", detailAvailable: true,
        errors: [{ errorType: "Overlap", severity: "Error" }] },
      nativeToolErrors: [{ errorType: "ProtectedEntity", position: { x: 1, z: 2 } }],
    });
    const errors = diagnostics!.validation?.errors ?? [];
    expect(errors.map((entry) => entry.errorType)).toEqual(["Overlap", "ProtectedEntity"]);
  });

  it("ignores an entry the game gave no reason for, and invents nothing", () => {
    const diagnostics = normalizeNativeRoadDiagnostics({
      validation: { status: "REJECTED", detailAvailable: false },
      nativeToolErrors: [{ position: { x: 1, z: 2 } }, { errorType: "Water" }],
    });
    const errors = diagnostics!.validation?.errors ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0].errorType).toBe("Water");
    // No position named means no position claimed.
    expect(errors[0].atX).toBeUndefined();
  });
});
