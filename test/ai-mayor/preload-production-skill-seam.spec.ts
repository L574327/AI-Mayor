import fs from "node:fs";
import path from "node:path";

/** Renderer boundary contract: construction dispatch stays inside the main process. */

const invoked: Array<{ channel: string; args: unknown[] }> = [];
const exposed: Record<string, unknown> = {};

jest.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed[key] = value;
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      return Promise.resolve(undefined);
    },
    send: () => undefined,
    sendSync: () => undefined,
    on: () => undefined,
    once: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  },
}));

type ExposedApi = {
  aiMayor: Record<string, (...args: never[]) => unknown>;
};

describe("renderer production Skill seam", () => {
  beforeAll(async () => {
    await import("../../src/main/preload");
  });

  beforeEach(() => {
    invoked.length = 0;
  });

  const rendererApi = () => (exposed.electron as ExposedApi).aiMayor;

  test("does not expose the internal production Skill dispatcher to the renderer", async () => {
    const api = rendererApi();
    expect(api).not.toHaveProperty("dispatchProductionSkill");
    expect(api).not.toHaveProperty("resumeProductionSkill");
    expect(api).not.toHaveProperty("advanceGate1");
    expect(api).not.toHaveProperty("runAutonomousConstructionCycle");
  });

  test("exposes a read-only authoritative Mayor session status", async () => {
    const api = rendererApi();
    expect(typeof api.sessionStatus).toBe("function");

    await api.sessionStatus();
    expect(invoked).toContainEqual({ channel: "ai-mayor-session-status", args: [] });
  });

  test("registers no renderer-reachable construction dispatch IPC", () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../src/main/main.ts"), "utf8");
    for (const channel of ["ai-mayor-production-skill", "ai-mayor-production-skill-resume", "ai-mayor-gate1-progression", "ai-mayor-autonomous-construction-cycle"]) {
      expect(mainSource).not.toContain(`ipcMain.handle("${channel}"`);
    }

    const preloadSource = fs.readFileSync(path.resolve(__dirname, "../../src/main/preload.ts"), "utf8");
    expect(preloadSource).not.toMatch(/ipcRenderer\.invoke\(\s*"ai-mayor-(?:production-skill|gate1-progression|autonomous-construction-cycle)/);
  });

  test("never hands the renderer a runtime, registry, or workflow object", () => {
    const api = rendererApi();
    expect(api).not.toHaveProperty("mayorRuntime");
    expect(api).not.toHaveProperty("v2ProductionSkillRuntime");
    expect(api).not.toHaveProperty("registry");
    expect(api).not.toHaveProperty("workflows");
    // Read-only production status remains available for product observability.
    expect(typeof api.productionReadiness).toBe("function");
    expect(typeof api.k05Preflight).toBe("function");
  });
});
