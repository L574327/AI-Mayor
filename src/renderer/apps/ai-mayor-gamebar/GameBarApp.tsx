import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

/**
 * The control over the game: a small round Mayor button (the product's own icon) at the edge of the screen. A click unfolds a short white strip — the input
 * and the Mayor's pause button — and Enter sends the sentence by the console's own road (the local reader first, the player's AI only when needed). After
 * the answer has been read, or on Esc, it folds back and the game has the focus again. The button is dragged with the mouse; its place is kept. Its picture
 * is chosen in the console (a dialog opened from this always-on-top button sat behind the game and the button seemed to vanish, live 2026-10-08).
 */
type Phase = string;
interface BarState { phase: Phase }
interface Outcome { ok?: boolean; detail?: string; notes?: string[] }
const electron = () => (window as unknown as { electron: {
  ipcRenderer: { on: (channel: string, listener: (payload: unknown) => void) => () => void };
  aiMayorConsole: { interpret: (text: string) => Promise<Outcome>; pause: () => Promise<unknown>; resume: () => Promise<unknown>; getState: () => Promise<BarState>;
    gameBarRelease: () => Promise<unknown>; gameBarAvatar: () => Promise<string | null>; gameBarLayout: (layout: { open: boolean; reply: boolean }) => Promise<unknown>; gameBarMove: (delta: { dx: number; dy: number }) => Promise<unknown> };
} }).electron;
const zh = /^zh/i.test(navigator.language);
const say = (cn: string, en: string) => (zh ? cn : en);
const FONT = "500 14px/1.3 'Microsoft YaHei UI', 'PingFang SC', 'Segoe UI', sans-serif";

function Avatar({ ring, custom }: { ring: string; custom: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span style={{ width: 46, height: 46, borderRadius: "50%", display: "grid", placeItems: "center", background: "#141c28", boxShadow: `0 0 0 3px ${ring}, 0 3px 10px rgba(0,0,0,0.35)`, overflow: "hidden" }}>
      {failed ? <span style={{ font: "700 18px/1 'Microsoft YaHei UI', sans-serif", color: "#8ab9ff" }}>{say("市", "M")}</span>
        : <img src={custom ?? "./brand/logo.png"} alt="" draggable={false} onError={() => setFailed(true)} style={{ width: custom ? "100%" : "118%", height: custom ? "100%" : "118%", objectFit: "cover" }} />}
    </span>
  );
}

export default function GameBarApp() {
  const [phase, setPhase] = useState<Phase>("RUNNING");
  const [open, setOpen] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ text: string; ok: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    for (const element of [document.documentElement, document.body]) { element.style.background = "transparent"; }
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    void electron().aiMayorConsole.getState().then((state) => { if (state?.phase) setPhase(state.phase); }).catch(() => undefined);
    void electron().aiMayorConsole.gameBarAvatar().then((url) => setAvatar(typeof url === "string" && url.startsWith("data:image/") ? url : null)).catch(() => undefined);
    const offAvatar = electron().ipcRenderer.on("ai-mayor-gamebar-avatar", (url) => setAvatar(typeof url === "string" && url.startsWith("data:image/") ? url : null));
    const offState = electron().ipcRenderer.on("ai-mayor-console-state", (payload) => { const state = payload as BarState | null; if (state?.phase) setPhase(state.phase); });
    return () => { offAvatar(); offState(); };
  }, []);
  useEffect(() => { void electron().aiMayorConsole.gameBarLayout({ open, reply: open && reply !== null }); if (open) window.setTimeout(() => input.current?.focus(), 30); }, [open, reply]);
  // The answer is read, then the strip folds back by itself.
  useEffect(() => {
    if (!reply) return;
    const timer = window.setTimeout(() => { setReply(null); if (!text) setOpen(false); }, 5_000);
    return () => window.clearTimeout(timer);
  }, [reply, text]);

  const fold = () => { setOpen(false); setReply(null); void electron().aiMayorConsole.gameBarRelease(); };
  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true);
    try {
      const outcome = await electron().aiMayorConsole.interpret(said);
      const first = outcome?.notes?.find((note) => note && note.trim()) ?? "";
      setReply(outcome?.ok !== false ? { ok: true, text: first ? `${say("收到", "Got it")}：${first}` : say("收到，下一轮开始做", "Got it; it starts next round") }
        : { ok: false, text: outcome?.detail || say("没听懂，换个说法试试", "Not understood; try other words") });
      if (outcome?.ok !== false) setText("");
    } catch (error) {
      setReply({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void send(); }
    if (event.key === "Escape") { event.preventDefault(); fold(); }
  };
  const paused = phase === "PAUSED" || phase === "PAUSING";
  const ring = paused ? "#f0b955" : phase === "RUNNING" ? "#3fb37f" : "#8fb8ff";
  const togglePause = async () => { setBusy(true); try { await (paused ? electron().aiMayorConsole.resume() : electron().aiMayorConsole.pause()); } finally { setBusy(false); } };

  // A press that moves is a drag (the window follows); a press that does not is a click.
  const onDown = (event: PointerEvent<HTMLElement>) => { (event.target as HTMLElement).setPointerCapture(event.pointerId); drag.current = { x: event.screenX, y: event.screenY, moved: false }; };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = event.screenX - start.x; const dy = event.screenY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true; start.x = event.screenX; start.y = event.screenY;
    void electron().aiMayorConsole.gameBarMove({ dx, dy });
  };
  const onUp = (toggle: () => void) => () => { const was = drag.current; drag.current = null; if (was && !was.moved) toggle(); };

  if (!open) {
    return (
      <button type="button" title={say("市长：点开说话，拖动换位置", "Mayor: click to speak, drag to move")}
        onContextMenu={(event) => event.preventDefault()} onPointerDown={(event) => { if (event.button === 0) onDown(event); }} onPointerMove={onMove} onPointerUp={(event) => { if (event.button === 0) onUp(() => setOpen(true))(); }}
        style={{ position: "fixed", inset: 0, margin: 0, padding: 0, border: 0, background: "transparent", display: "grid", placeItems: "center", cursor: "pointer" }}>
        <Avatar ring={ring} custom={avatar} />
      </button>
    );
  }
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", gap: 4, padding: 4, boxSizing: "border-box", font: FONT }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 50, padding: "0 8px 0 2px", borderRadius: 26, background: "rgba(255,255,255,0.96)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)" }}>
        <span onContextMenu={(event) => event.preventDefault()} onPointerDown={(event) => { if (event.button === 0) onDown(event); }} onPointerMove={onMove} onPointerUp={(event) => { if (event.button === 0) onUp(fold)(); }} title={say("收起（拖动换位置）", "Fold (drag to move)")} style={{ cursor: "pointer", display: "grid", placeItems: "center", transform: "scale(0.85)" }}>
          <Avatar ring={ring} custom={avatar} />
        </span>
        <input ref={input} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
          placeholder={busy ? say("市长在听…", "Listening…") : say("对市长说…（回车发送，Esc 收起）", "Tell the Mayor… (Enter sends, Esc folds)")}
          style={{ flex: 1, minWidth: 0, height: 34, border: "1px solid #dfe5ee", borderRadius: 17, background: "#f6f8fb", color: "#172338", padding: "0 14px", outline: "none", font: FONT }} />
        <button type="button" disabled={busy} onClick={() => void togglePause()} title={paused ? say("继续市长", "Resume the Mayor") : say("暂停市长", "Pause the Mayor")}
          style={{ width: 34, height: 34, borderRadius: "50%", border: "1px solid #dfe5ee", background: paused ? "#e8f5ee" : "#fcf2e3", color: paused ? "#24664b" : "#855217",
            cursor: "pointer", font: "700 12px/1 'Segoe UI Symbol', 'Segoe UI', sans-serif", padding: 0 }}>{paused ? "▶" : "❚❚"}</button>
      </div>
      {reply ? (
        <div style={{ alignSelf: "flex-start", maxWidth: "100%", boxSizing: "border-box", padding: "5px 12px", borderRadius: 14, background: "rgba(255,255,255,0.96)",
          color: reply.ok ? "#24664b" : "#855217", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", boxShadow: "0 3px 10px rgba(0,0,0,0.25)" }}>{reply.text}</div>
      ) : null}
    </div>
  );
}
