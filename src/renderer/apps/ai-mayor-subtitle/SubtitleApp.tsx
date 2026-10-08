import { useEffect, useState } from "react";

/**
 * The subtitle bar over the game: the Mayor's latest line (the engine's language expressor), centred near the bottom of the screen, click-through,
 * fading out after a while so it never sits on the city for good. It only shows; everything else is in the console.
 */
interface SaidLine { text: string; tone?: string; at: string }
const api = () => (window as unknown as { electron: { ipcRenderer: { on: (channel: string, listener: (payload: unknown) => void) => () => void } } }).electron;

export default function SubtitleApp() {
  const [line, setLine] = useState<SaidLine | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return api().ipcRenderer.on("ai-mayor-subtitle", (payload) => {
      const next = payload as SaidLine | null;
      if (!next?.text) return;
      setLine(next);
      setVisible(true);
    });
  }, []);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [visible, line]);
  const accent = line?.tone === "done" ? "#5fd39a" : line?.tone === "blocked" || line?.tone === "warn" ? "#f0b955" : "#8fb8ff";
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" }}>
      <p style={{ margin: "0 0 6px", maxWidth: "96%", padding: "8px 18px", borderRadius: 10, background: "rgba(10, 14, 22, 0.78)", color: "#f2f5fa",
        font: "500 19px/1.45 'Microsoft YaHei UI', 'PingFang SC', 'Segoe UI', sans-serif", textShadow: "0 1px 2px rgba(0,0,0,0.9)",
        borderLeft: `4px solid ${accent}`, opacity: visible && line ? 1 : 0, transition: "opacity 600ms ease", textAlign: "center" }}>
        {line ? <><span style={{ color: accent, marginRight: 8 }}>市长</span>{line.text}</> : null}
      </p>
    </div>
  );
}