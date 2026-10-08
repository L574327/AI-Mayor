/** @jest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OverlayApp from "../../src/renderer/apps/ai-mayor-overlay/OverlayApp";

type Api = {
  aiMayor: {
    getState: jest.Mock;
    sessionStatus: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    productionReadiness: jest.Mock;
    k05Preflight: jest.Mock;
    dispatchProductionSkill: jest.Mock;
    command: jest.Mock;
    advanceGate1: jest.Mock;
    runAutonomousConstructionCycle: jest.Mock;
  };
  aiMayorOverlay: Record<string, jest.Mock>;
  ipcRenderer: { on: jest.Mock };
};

type ConnectionStream = {
  emit: (state: Record<string, { status: string }>) => void;
  stop: jest.Mock;
};

const readiness = {
  state: { tranche: { stage: "ROAD_DELIVERED" } },
  certifiedRoadRefs: [{ index: 42, version: 1 }],
  firstFacilityPlacement: { status: "NONE" },
};
const passingPreflight = {
  admitted: true,
  stage: "ROAD_DELIVERED",
  preparation: {
    facilityPlacementAuthorization: { recipe: "basic-electricity-provision" },
    firstFacilityPlacement: { status: "NONE" },
  },
};

function installApi(options: {
  readiness?: unknown;
  preflight?: unknown;
  dispatch?: jest.Mock;
  connectionStream?: ConnectionStream;
  getReadiness?: jest.Mock;
} = {}): Api {
  let currentSessionStatus: { status: "STOPPED" | "RUNNING"; lastError: string | null } = {
    status: "STOPPED",
    lastError: null,
  };
  const api: Api = {
    aiMayor: {
      getState: jest.fn().mockResolvedValue(null),
      sessionStatus: jest.fn().mockImplementation(async () => currentSessionStatus),
      start: jest.fn().mockImplementation(async () => {
        currentSessionStatus = { status: "RUNNING", lastError: null };
        return { status: "running", sessionId: "test-session" };
      }),
      stop: jest.fn().mockImplementation(async () => {
        currentSessionStatus = { status: "STOPPED", lastError: null };
        return { status: "stopped", sessionId: "test-session" };
      }),
      productionReadiness: jest.fn().mockResolvedValue(options.readiness ?? readiness),
      k05Preflight: jest.fn().mockResolvedValue(options.preflight ?? passingPreflight),
      dispatchProductionSkill: options.dispatch ?? jest.fn().mockResolvedValue({ status: "SUCCESS", evidence: [] }),
      command: jest.fn().mockResolvedValue({ status: "running", sessionId: "test-session", pendingUserCommand: null }),
      advanceGate1: jest.fn().mockResolvedValue({ status: "MILESTONE_REACHED", stage: "ROAD_DELIVERED", reason: "done" }),
      runAutonomousConstructionCycle: jest.fn().mockResolvedValue({ status: "MILESTONE_REACHED", stage: "OCCUPIED", reason: "done" }),
    },
    aiMayorOverlay: {
      collapse: jest.fn().mockResolvedValue(undefined),
      getReadiness: options.getReadiness ?? jest.fn().mockResolvedValue({ status: "online", cityLoaded: true }),
      getSettings: jest.fn().mockResolvedValue({ showOnStartup: true, alwaysOnTop: true, mayorSpeed: "normal" }),
      expand: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      setSettings: jest.fn().mockResolvedValue(undefined),
      resetPosition: jest.fn().mockResolvedValue(undefined),
      copyDiagnostics: jest.fn().mockResolvedValue(undefined),
    },
    ipcRenderer: { on: jest.fn().mockReturnValue(jest.fn()) },
  };
  (window as unknown as { electron: Api; bridge: { renderer: { focus: jest.Mock } } }).electron = api;
  (window as unknown as { electron: Api; bridge: { renderer: { focus: jest.Mock; mcpConnectionsManager?: unknown } } }).bridge = {
    renderer: { focus: jest.fn() },
  };
  if (options.connectionStream) {
    (window as unknown as { bridge: { mcpConnectionsManager: unknown } }).bridge.mcpConnectionsManager = {
      createStateStream: jest.fn().mockResolvedValue({
        next: async () => await new Promise<IteratorResult<Record<string, { status: string }>>>((resolve) => {
          options.connectionStream!.emit = (state) => resolve({ done: false, value: state });
        }),
        stop: options.connectionStream.stop,
      }),
    };
  }
  return api;
}

afterEach(() => {
  cleanup();
});

async function openPanel() {
  await waitFor(() => expect(screen.getByRole("button", { name: "AI Mayor" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "AI Mayor" }));
  await waitFor(() => expect(screen.getByText(/Session:/)).toBeTruthy());
}

describe("AI Mayor renderer execution boundary", () => {
  test("sends a fixed road command as a typed Goal without submitting a text prompt", async () => {
    const api = installApi();
    render(<OverlayApp />);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Grid roads" }));

    await waitFor(() => expect(api.aiMayor.command).toHaveBeenCalledWith({
      text: "Extend road network",
      source: "text",
      structuredIntent: { kind: "GOAL", type: "ESTABLISH_ROAD_NETWORK", priority: "NORMAL" },
    }));
  });

  test("does not expose manual Gate1 or K05 construction controls", async () => {
    const api = installApi();
    render(<OverlayApp />);
    await openPanel();

    expect(api.aiMayor.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Run autonomous construction/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Run K05/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deliver ROAD/i })).toBeNull();
  });

  test("refreshes the authoritative connection state after MCP connects", async () => {
    let online = false;
    const connectionStream = { emit: (_state: Record<string, { status: string }>) => {}, stop: jest.fn() };
    const getReadiness = jest.fn().mockImplementation(async () =>
      online ? { status: "online", cityLoaded: true } : { status: "offline", cityLoaded: false },
    );
    installApi({ connectionStream, getReadiness });
    render(<OverlayApp />);
    await openPanel();

    await waitFor(() => expect(screen.getByText("Game Offline")).toBeTruthy());
    online = true;
    connectionStream.emit({ mcp: { status: "connected" } });

    await waitFor(() => expect(screen.getByText("Session: RUNNING")).toBeTruthy());
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect((window as unknown as { electron: Api }).electron.aiMayor.start).toHaveBeenCalledTimes(1);
    connectionStream.emit({ mcp: { status: "connected" } });
    await waitFor(() => expect((window as unknown as { electron: Api }).electron.aiMayor.start).toHaveBeenCalledTimes(1));
    expect(connectionStream.stop).not.toHaveBeenCalled();
  });

  test("does not start while the authoritative game state is offline", async () => {
    const connectionStream = { emit: (_state: Record<string, { status: string }>) => {}, stop: jest.fn() };
    const getReadiness = jest.fn().mockResolvedValue({ status: "offline", cityLoaded: false });
    const api = installApi({ connectionStream, getReadiness });
    render(<OverlayApp />);
    await openPanel();
    expect(api.aiMayor.start).not.toHaveBeenCalled();
  });

  test("does not show Mayor Running when the authoritative session remains STOPPED", async () => {
    const api = installApi();
    api.aiMayor.sessionStatus.mockResolvedValue({ status: "STOPPED", lastError: null, startInFlight: false });
    render(<OverlayApp />);
    await openPanel();

    await waitFor(() => expect(screen.getByText("Session: STOPPED")).toBeTruthy());
    expect(screen.queryByText("Mayor Running")).toBeNull();
    expect(api.aiMayor.start).toHaveBeenCalledTimes(1);
  });

});
