import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("AI Mayor live harness entrypoints", () => {
  test("uses explicit Local and DeepSeek commands", () => {
    expect(packageJson.scripts["mayor:live:local"]).toBe("tsx scripts/local-mayor-live.ts");
    expect(packageJson.scripts["mayor:live:deepseek"]).toBe("tsx scripts/ai-mayor-live.ts");
    expect(packageJson.scripts["mayor:live"]).toBe("node scripts/ai-mayor-live-entrypoint.cjs");
  });

  test("Local harness is explicitly local and provider-disabled", () => {
    const source = fs.readFileSync(path.join(root, "scripts/local-mayor-live.ts"), "utf8");
    expect(source).toContain('const decisionMode = "local" as const');
    expect(source).toContain("LIVE HARNESS: LOCAL MAYOR");
    expect(source).toContain("providerAccess=disabled");
    expect(source).toContain("LOCAL_MODE_PROVIDER_VIOLATION");
    expect(source).toContain("decisionMode,");
    expect(source).toContain("missingLocalMayorLiveTools");
  });

  test("DeepSeek harness has its own explicit mode banner", () => {
    const source = fs.readFileSync(path.join(root, "scripts/ai-mayor-live.ts"), "utf8");
    expect(source).toContain("LIVE HARNESS: DEEPSEEK MAYOR");
    expect(source).toContain("decisionMode=deepseek");
  });

  test("ambiguous legacy command fails with explicit instructions", () => {
    const source = fs.readFileSync(path.join(root, "scripts/ai-mayor-live-entrypoint.cjs"), "utf8");
    expect(source).toContain("mayor:live:local");
    expect(source).toContain("mayor:live:deepseek");
    expect(source).toContain("process.exitCode = 2");
  });
});
