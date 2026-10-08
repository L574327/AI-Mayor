import { useCallback, useEffect, useRef, useState } from "react";
import type { MayorSessionState, MayorStructuredGoalIntent } from "@/main/services/ai-mayor/types";
import { mayorSubtitle } from "@/main/services/ai-mayor/v2/mayor-subtitle";
import QuickPrompts from "../../pages/chat/Editor/QuickPrompts";
import "./OverlayApp.scss";

type MayorLifecycleStatus = "OFFLINE" | "STARTING" | "RUNNING" | "FAILED" | "STOPPED";
type MayorSessionStatus = {
  status: MayorLifecycleStatus;
  lastError: string | null;
  startCallCount?: number;
  lastStartResult?: "RUNNING" | "FAILED" | null;
  startInFlight?: boolean;
};

const LIFECYCLE_START_GOAL = "Initialize deterministic AI Mayor production runtime";

export default function OverlayApp() {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<MayorSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<{ status: string; cityLoaded: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({
    showOnStartup: true,
    alwaysOnTop: true,
    mayorSpeed: "fast" as "normal" | "fast",
    commentaryEnabled: true,
  });
  const [commentary, setCommentary] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<MayorSessionStatus | null>(null);
  const startInFlight = useRef<Promise<MayorSessionState> | null>(null);
  const sessionStatusReadVersion = useRef(0);

  const refreshState = useCallback(async () => {
    try {
      setState((await window.electron.aiMayor.getState()) as MayorSessionState | null);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSessionStatus = useCallback(async () => {
    const readVersion = ++sessionStatusReadVersion.current;
    const nextStatus = (await window.electron.aiMayor.sessionStatus()) as MayorSessionStatus;
    if (readVersion === sessionStatusReadVersion.current) {
      setSessionStatus(nextStatus);
      setLifecycleError(nextStatus.lastError);
      return nextStatus;
    }
    return nextStatus;
  }, []);

  const startMayor = useCallback(async () => {
    if (startInFlight.current) return startInFlight.current;
    const promise = window.electron.aiMayor
      .start({
        goal: LIFECYCLE_START_GOAL,
        maxSessionSpend: 0.2,
        minimumBalance: 1,
        continuous: false,
        decisionMode: "local",
        speed: settings.mayorSpeed,
      })
      .then(async (nextState) => {
        const typedState = nextState as MayorSessionState;
        setState(typedState);
        setLifecycleError(null);
        await refreshSessionStatus();
        return typedState;
      })
      .catch(async (startError) => {
        const message = startError instanceof Error ? startError.message : "Unable to start AI Mayor";
        setLifecycleError(message);
        await refreshSessionStatus().catch(() => undefined);
        throw startError;
      })
      .finally(() => {
        startInFlight.current = null;
        setStarting(false);
      });
    startInFlight.current = promise;
    setStarting(true);
    return promise;
  }, [refreshSessionStatus, settings.mayorSpeed]);

  const ensureMayorStarted = useCallback(async () => {
    const currentStatus = await refreshSessionStatus();
    const current = (await window.electron.aiMayor.getState()) as MayorSessionState | null;
    if (currentStatus.status === "RUNNING" || currentStatus.status === "STARTING" || current?.status === "running") {
      setState(current);
      return current;
    }
    return startMayor();
  }, [refreshSessionStatus, startMayor]);

  const refreshConnectionState = useCallback(async () => {
    try {
      const nextReadiness = await window.electron.aiMayorOverlay.getReadiness();
      setReadiness(nextReadiness);
      setUnavailable(false);
      await refreshSessionStatus();
      if (nextReadiness.status !== "offline") {
        await ensureMayorStarted();
      }
    } catch {
      setUnavailable(true);
    }
  }, [ensureMayorStarted, refreshSessionStatus]);

  useEffect(() => {
    void window.electron.aiMayorOverlay.collapse();
    void refreshState();
    void refreshSessionStatus();
    void refreshConnectionState();
    void window.electron.aiMayorOverlay.getSettings().then(setSettings);
    const unsubscribe = ["ai-mayor-status", "ai-mayor-balance", "ai-mayor-tick"].map((channel) =>
      window.electron.ipcRenderer.on(channel as "ai-mayor-status", (nextState) => {
        setState(nextState as MayorSessionState);
      }),
    );
    const unsubscribeCommentary = window.electron.ipcRenderer.on("ai-mayor-commentary", (payload) => {
      const line = payload as { text?: unknown } | null;
      if (typeof line?.text === "string") setCommentary(line.text);
    });
    let stopped = false;
    type MayorStateStream = { next: () => Promise<{ done: boolean }>; stop?: () => Promise<unknown> };
    const streams: MayorStateStream[] = [];
    const watchStateStream = async (createStateStream: (() => Promise<MayorStateStream>) | undefined) => {
      if (!createStateStream) return;
      const stream = await createStateStream();
      streams.push(stream);
      while (!stopped) {
        const next = await stream.next();
        if (next.done) break;
        await refreshConnectionState();
      }
    };
    void Promise.all([
      watchStateStream(window.bridge?.mcpConnectionsManager?.createStateStream),
      watchStateStream(window.bridge?.mcpConnectionsManager?.tool?.createStateStream),
    ]).catch(() => {
      // The readiness read remains authoritative if a state stream closes.
    });
    return () => {
      stopped = true;
      streams.forEach((stream) => void Promise.resolve(stream.stop?.()).catch(() => {}));
      unsubscribe.forEach((remove) => {
        remove();
      });
      unsubscribeCommentary();
    };
  }, [refreshConnectionState, refreshSessionStatus, refreshState]);

  const lifecycleStatus: MayorLifecycleStatus =
    sessionStatus?.status ?? (readiness?.status === "offline" || unavailable ? "OFFLINE" : starting ? "STARTING" : "OFFLINE");
  const lifecycleLastError = sessionStatus?.lastError ?? lifecycleError;

  const playerStatus = loading
    ? "Connecting"
    : unavailable || readiness?.status === "offline"
      ? "Game Offline"
      : lifecycleStatus === "STARTING"
        ? "Mayor Session Starting"
        : lifecycleStatus === "RUNNING"
          ? "Mayor Running"
          : lifecycleStatus === "FAILED"
            ? "Mayor Failed"
            : lifecycleStatus === "STOPPED"
              ? "Mayor Stopped"
              : readiness?.cityLoaded
                ? "Game Online"
                : "City Loading";

  const statusMessage =
    {
      "Game Offline": "Cities: Skylines II is not connected. Start the game and load a city; AI Mayor will wait here.",
      Connecting: "The game was detected. AI Mayor is connecting...",
      "Mayor Session Starting": "Game connection is ready. Starting AI Mayor...",
      "Mayor Failed": lifecycleLastError ?? "AI Mayor failed to start.",
      "Mayor Stopped": "AI Mayor is stopped. Start it when you are ready.",
      "City Loading": "The game is connected. Waiting for your city to finish loading...",
      "Game Online": "Game connection is ready. AI Mayor can be started.",
      "Mayor Running": state?.goal ? `Working on: ${state.goal}` : "AI Mayor is working on your city.",
      Paused: "AI Mayor is paused. Your game connection is ready.",
      Error: "AI Mayor needs attention. Check the instruction and try again.",
    }[playerStatus] ?? "AI Mayor is ready.";

  // Only while the Mayor is actually running: a stopped session's last window
  // is history, not a status.
  const mayorSubtitleLine = lifecycleStatus === "RUNNING" ? mayorSubtitle(state as never) : null;

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    void (next ? window.electron.aiMayorOverlay.expand() : window.electron.aiMayorOverlay.collapse());
  };

  const send = async () => {
    const goal = input.trim();
    if (!goal || starting) return;
    setError(null);
    setStarting(true);
    try {
      if (state?.status !== "running") await ensureMayorStarted();
      const nextState =
        state?.status === "running"
          ? await window.electron.aiMayor.command({ text: goal, source: "text" })
          : await window.electron.aiMayor.command({ text: goal, source: "text" });
      setState(nextState as MayorSessionState);
      setInput("");
      await refreshConnectionState();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to start AI Mayor");
    } finally {
      setStarting(false);
    }
  };

  const sendQuickCommand = async (label: string, structuredIntent: MayorStructuredGoalIntent) => {
    if (starting || playerStatus === "Game Offline" || playerStatus === "Connecting") return;
    setError(null);
    setStarting(true);
    try {
      if (state?.status !== "running") await ensureMayorStarted();
      const nextState = await window.electron.aiMayor.command({
        text: label,
        source: "text",
        structuredIntent,
      });
      setState(nextState as MayorSessionState);
      await refreshConnectionState();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send fixed Mayor command");
    } finally {
      setStarting(false);
    }
  };

  const stopMayor = async () => {
    try {
      const nextState = (await window.electron.aiMayor.stop("Stopped by user")) as MayorSessionState;
      setState(nextState);
      await refreshSessionStatus();
    } catch (stopError) {
      setLifecycleError(stopError instanceof Error ? stopError.message : "Unable to stop AI Mayor");
    }
  };

  if (!expanded) {
    return (
      <button className="ai-mayor-overlay-collapsed" type="button" onClick={toggleExpanded} title="Open AI Mayor">
        AI Mayor
      </button>
    );
  }

  return (
    <section className="ai-mayor-overlay-panel" aria-label="AI Mayor">
      <header className="ai-mayor-overlay-header">
        <div className="ai-mayor-overlay-drag-region">
          <strong>AI Mayor</strong>
          <span className={`ai-mayor-overlay-status status-${playerStatus.toLowerCase().replaceAll(" ", "-")}`}>
            {playerStatus}
          </span>
        </div>
        <button type="button" className="ai-mayor-overlay-window-button" onClick={toggleExpanded} aria-label="Collapse">
          −
        </button>
        <button
          type="button"
          className="ai-mayor-overlay-window-button"
          onClick={() => void window.electron.aiMayorOverlay.close()}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      <div className="ai-mayor-overlay-content">
        <p className="ai-mayor-overlay-status-message">{statusMessage}</p>
        {/*
          What the Mayor is doing, why, and what it just finished — derived from
          the session state on every push. It is the difference between a Mayor
          the player can watch and one that looks switched off.
        */}
        {mayorSubtitleLine ? (
          <p className="ai-mayor-overlay-subtitle" aria-live="polite" aria-label="Mayor status">{mayorSubtitleLine}</p>
        ) : null}
        {commentary && settings.commentaryEnabled ? (
          <p className="ai-mayor-overlay-commentary" aria-live="polite" aria-label="Mayor commentary">{commentary}</p>
        ) : null}
        <section className="ai-mayor-overlay-lifecycle" aria-label="Mayor lifecycle">
          <strong>Session: {lifecycleStatus}</strong>
          {lifecycleLastError ? <small>{lifecycleLastError}</small> : null}
          <div>
            <button
              type="button"
              onClick={() => void ensureMayorStarted()}
              disabled={
                starting ||
                lifecycleStatus === "RUNNING" ||
                lifecycleStatus === "STARTING" ||
                readiness?.status === "offline" ||
                unavailable
              }
            >
              Start AI Mayor
            </button>
            <button type="button" onClick={() => void stopMayor()} disabled={lifecycleStatus !== "RUNNING"}>
              Stop AI Mayor
            </button>
          </div>
        </section>
        <p className="ai-mayor-overlay-goal">{state?.goal || "What should I help with in your city?"}</p>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send();
          }}
          placeholder="Tell AI Mayor what to do..."
          aria-label="AI Mayor instruction"
          rows={3}
        />
        <button
          type="button"
          className="ai-mayor-overlay-send"
          onClick={() => void send()}
          disabled={
            !input.trim() || starting || playerStatus === "Game Offline" || playerStatus === "Connecting"
          }
        >
          {starting ? "Starting AI Mayor..." : "Send"}
        </button>
        <QuickPrompts onSelect={setInput} />
        <fieldset className="ai-mayor-overlay-settings" aria-label="Quick Commands">
          <legend>Quick Commands · no LLM</legend>
          <div>
            <button type="button" disabled={starting || playerStatus === "Game Offline" || playerStatus === "Connecting"}
              onClick={() => void sendQuickCommand("Automatic development", { kind: "GOAL", type: "GROW_POPULATION", priority: "NORMAL" })}>Automatic development</button>
            <button type="button" disabled={starting || playerStatus === "Game Offline" || playerStatus === "Connecting"}
              onClick={() => void sendQuickCommand("Expand residential", { kind: "GOAL", type: "EXPAND_RESIDENTIAL", priority: "NORMAL" })}>Residential</button>
            <button type="button" disabled={starting || playerStatus === "Game Offline" || playerStatus === "Connecting"}
              onClick={() => void sendQuickCommand("Expand commercial", { kind: "GOAL", type: "EXPAND_COMMERCIAL", priority: "NORMAL" })}>Commercial</button>
            <button type="button" disabled={starting || playerStatus === "Game Offline" || playerStatus === "Connecting"}
              onClick={() => void sendQuickCommand("Expand industrial", { kind: "GOAL", type: "EXPAND_INDUSTRIAL", priority: "NORMAL" })}>Industrial</button>
            <button type="button" disabled={starting || playerStatus === "Game Offline" || playerStatus === "Connecting"}
              onClick={() => void sendQuickCommand("Extend road network", { kind: "GOAL", type: "ESTABLISH_ROAD_NETWORK", priority: "NORMAL" })}>Grid roads</button>
            {(["WATER", "ELECTRICITY", "SEWAGE"] as const).map((serviceKind) => (
              <button key={serviceKind} type="button" disabled={starting || playerStatus === "Game Offline" || playerStatus === "Connecting"}
                onClick={() => void sendQuickCommand(`Provide ${serviceKind.toLowerCase()}`, {
                  kind: "GOAL", type: "PROVIDE_SERVICE", scope: { serviceKind }, priority: "NORMAL",
                })}>{serviceKind[0] + serviceKind.slice(1).toLowerCase()}</button>
            ))}
          </div>
        </fieldset>
        <button
          type="button"
          className="ai-mayor-overlay-settings-toggle"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          Settings
        </button>
        {settingsOpen ? (
          <fieldset className="ai-mayor-overlay-settings">
            <legend>AI Mayor settings</legend>
            <label>
              <input
                type="checkbox"
                checked={settings.commentaryEnabled}
                onChange={(event) => {
                  const next = { ...settings, commentaryEnabled: event.target.checked };
                  setSettings(next);
                  if (!next.commentaryEnabled) setCommentary(null);
                  void window.electron.aiMayorOverlay.setSettings(next);
                }}
              />
              Mayor Commentary
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.showOnStartup}
                onChange={(event) => {
                  const next = { ...settings, showOnStartup: event.target.checked };
                  setSettings(next);
                  void window.electron.aiMayorOverlay.setSettings(next);
                }}
              />
              Show AI Mayor when the app starts
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.alwaysOnTop}
                onChange={(event) => {
                  const next = { ...settings, alwaysOnTop: event.target.checked };
                  setSettings(next);
                  void window.electron.aiMayorOverlay.setSettings(next);
                }}
              />
              Always on top
            </label>
            <p>Shortcut: Ctrl+Shift+M</p>
            <label>
              Mayor Speed
              <select
                value={settings.mayorSpeed}
                onChange={(event) => {
                  const mayorSpeed: "normal" | "fast" = event.target.value === "fast" ? "fast" : "normal";
                  const next = { ...settings, mayorSpeed };
                  setSettings(next);
                  void window.electron.aiMayorOverlay.setSettings(next);
                }}
              >
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
              </select>
            </label>
            {settings.mayorSpeed === "fast" ? (
              <p>Fast groups multiple safe construction actions before simulating the city.</p>
            ) : null}
            <button type="button" onClick={() => void window.electron.aiMayorOverlay.resetPosition()}>
              Reset overlay position
            </button>
            <button
              type="button"
              onClick={() => {
                void window.electron.aiMayorOverlay.copyDiagnostics().then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                });
              }}
            >
              Copy Diagnostics
            </button>
            {copied ? <span className="ai-mayor-overlay-copied">Copy succeeded</span> : null}
            <button type="button" onClick={() => void window.bridge.renderer.focus()}>
              Open Developer Window
            </button>
          </fieldset>
        ) : null}
        {error ? <p className="ai-mayor-overlay-error">{error}</p> : null}
      </div>
    </section>
  );
}
