import fs from "node:fs";
import path from "node:path";
import { parseV2McpJson } from "../../src/main/services/ai-mayor/v2/main-adapter";

/**
 * The Water Phase 7 driver is a script, so it cannot be imported by a test —
 * importing it would run it against a live world. These cases are therefore
 * source-text guards over the invariants the driver's own evidence claims, in the
 * same style as `live-harness-entrypoints.spec.ts`, plus a direct unit test of the
 * production function the driver's payload handling rests on.
 */

const root = path.resolve(__dirname, "../..");
const driverPath = path.join(root, "scripts/ai-mayor-water-phase7-live.ts");
const source = fs.readFileSync(driverPath, "utf8");

const between = (start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to < 0 || to <= from) throw new Error(`DRIVER_SECTION_NOT_FOUND:${start}`);
  return source.slice(from, to);
};

describe("the Water Phase 7 driver reads MCP payloads, not MCP envelopes", () => {
  test("unwraps the content envelope the transport actually returns", () => {
    // The exact shape `client.callTool` hands back, and the exact shape a native
    // preflight answers with. Reading `valid` off the envelope is what made every
    // rung of the access-road ladder look refused with an empty reason.
    expect(parseV2McpJson({ content: [{ type: "text", text: JSON.stringify({ valid: true, previewOnly: true, amount: 448 }) }] }))
      .toEqual({ valid: true, previewOnly: true, amount: 448 });
    expect(parseV2McpJson({ structuredContent: { valid: true, previewOnly: true } }))
      .toEqual({ valid: true, previewOnly: true });
    // An envelope is not a payload, and asking one for a payload field is exactly
    // the defect the driver had: the field is not there.
    expect(({ content: [{ type: "text", text: "{}" }] } as Record<string, unknown>).valid).toBeUndefined();
  });

  test("the native access-road preflight goes through the parsing helper", () => {
    const preflight = between("preflight: async (candidate: FacilityAccessRoadCandidate)", "report.accessRoadPlanning");
    expect(preflight).toContain('await tool("cs2_spatial"');
    // No raw transport result is ever read for a payload field in this block.
    expect(preflight).not.toContain("callTool(");
    expect(preflight).toContain("readNativeUtilityQuote");
  });

  test("every tool call in the driver is issued through the parsing helper or the adapter bridge", () => {
    // `callTool` exists twice by design: the `tool` helper that parses, and the
    // `manager.legacyCall` shim that re-wraps for the production foundation. Any
    // other call site would be a place a raw envelope could escape unparsed.
    const callSites = source.match(/await callTool\(/g) ?? [];
    expect(callSites).toHaveLength(2);
    expect(source).toContain("const tool = async (name: string, args: Record<string, unknown> = {}) => parseV2McpJson(await callTool(name, args));");
  });
});

describe("the Water Phase 7 driver always tears its transport down", () => {
  test("closes the MCP client in a finally, and exits on the failure path", () => {
    expect(source).toContain("} finally {");
    expect(source).toContain("await client.close()");
    // The last resort, for anything the finally itself could not do.
    expect(source).toContain("process.exit(1)");
    expect(source).toContain('process.stderr.write("", resolve)');
    // The old shape — close only on the success path — is what hung a failed run
    // forever with its error already written.
    expect(source).not.toMatch(/\n  await client\.close\(\);\n\}/);
  });
});

describe("the Water Phase 7 driver stays inside its bounded mandate", () => {
  test("narrows the commissioning mandate to water", () => {
    expect(source).toContain('commissionedKinds: ["water"]');
  });

  test("bounds the native attempts and forbids the tools outside the phase", () => {
    expect(source).toContain("const MAXIMUM_ACCESS_ROAD_NATIVE_ATTEMPTS = 1;");
    // Declared AND enforced: the count is read back from the durable journal after
    // the first run and the run refuses to continue past it. A bound that only
    // exists as a constant is a comment.
    expect(source).toContain("attemptsAfterFirstRun <= MAXIMUM_ACCESS_ROAD_NATIVE_ATTEMPTS");
    expect(source).toContain("ACCESS_ROAD_NATIVE_ATTEMPTS_EXCEEDED");
    expect(source).toContain('"cs2_save_game"');
    expect(source).toContain('"cs2_place_building"');
    expect(source).toContain('"cs2_zone"');
    expect(source).toContain('"cs2_demolish"');
    expect(source).toContain("FORBIDDEN_TOOL_CALLED");
  });

  test("records the verdicts the phase is judged on", () => {
    for (const verdict of [
      "ACCESS_ROAD_NATIVE_ATTEMPT_COUNT",
      "ACCESS_ROAD_EFFECT",
      "FACILITY_ROAD_ATTACHMENT",
      "NO_ROAD_ACCESS_WARNING",
      "NO_ELECTRICITY_WARNING",
      "FULFILLED_ELECTRIC_CONSUMPTION",
      "WATER_SOURCE_OPERATIONAL",
      "WATER_SERVICE_AVAILABLE",
      "WATER_SKILL_RESULT",
      "LIVE_WATER_PROOF_COMPLETE",
      "DUPLICATE_FACILITY_COUNT",
      "DUPLICATE_PIPE_COUNT",
      "FORCED_SAVE_COUNT",
    ]) {
      expect(source).toContain(verdict);
    }
  });
});
