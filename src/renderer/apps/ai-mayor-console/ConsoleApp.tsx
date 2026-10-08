import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleState } from "@/main/services/ai-mayor/host/mayor-supervisor";
import type { TakeoverPermissions } from "@/main/services/ai-mayor/host/protocol";
import { detectPreset, PRESETS, type ProviderPreset } from "@/main/services/ai-mayor/host/ai-providers";
import { BRAND, FREE_AI_PAGES } from "./brand";
import { type ConsoleKey, type ConsoleLang, DICTIONARIES, defaultLang, iconName, NOT_A_PROBLEM_ICON } from "./i18n";
import "./ConsoleApp.scss";

type FullState = ConsoleState & { mod?: { status: string; detail: string; needsGameRestart: boolean } | null; appVersion?: string };
type Page = "home" | "settings" | "about";
type Mode = "api" | "assisted";
interface LanguageSettings { mode: Mode; preset: ProviderPreset; baseUrl: string; model: string; hasKey: boolean; clipboardWatch: boolean; dailyTokenLimit?: number }
interface AiUsage { date: string; tokens: number; calls: number; limit: number }
interface Balance { supported: boolean; amount: number | null; currency: string | null; detail: string }
const PRESET_OPTIONS: Array<[ProviderPreset, string]> = [["auto", "auto"], ["deepseek", "DeepSeek"], ["openai", "OpenAI (GPT)"], ["claude", "Anthropic (Claude)"], ["gemini", "Google (Gemini)"],
  ["openrouter", "OpenRouter"], ["custom-openai", "custom-openai"], ["custom-claude", "custom-claude"]];
interface Parsed { understood: boolean; confident?: boolean; summary: string; unsupported: string[] }
type ReplyCheck = { ok: true; intent: { type: string; scope?: Record<string, unknown>; priority: string } | null } | { ok: false; error: string; detail: string };

const api = () => (window as unknown as { electron: { aiMayorConsole: Record<string, (...args: unknown[]) => Promise<any>>; ipcRenderer: { on: (channel: string, listener: (payload: unknown) => void) => () => void } } }).electron;
const fmt = (value: number | null | undefined, lang: ConsoleLang) => (value === null || value === undefined ? "—" : Math.round(value).toLocaleString(lang === "zh" ? "zh-CN" : "en-US"));

// Icons: inline strokes, no icon font. The About icon is an open circle (an arc that does not close).
const IconHome = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></svg>;
const IconGear = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
const IconOpenCircle = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 9.2A8 8 0 1 1 12 4" /></svg>;

/** The logo slot (top-left and About): the owner's image when it is in place, the monogram until then. */
function BrandMark() {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="mc-logo mc-logo-fallback" aria-label="AI Mayor">M</span>
    : <img className="mc-logo" src={BRAND.logo} alt="AI Mayor" onError={() => setFailed(true)} />;
}

export default function ConsoleApp() {
  const [lang, setLang] = useState<ConsoleLang>(defaultLang);
  const [theme, setTheme] = useState<"dark" | "light">(() => { try { return (window.localStorage.getItem("ai-mayor-console-theme-v3") as "dark" | "light") || "light"; } catch { return "light"; } });
  const [page, setPage] = useState<Page>("home");
  const [state, setState] = useState<FullState | null>(null);
  const [language, setLanguage] = useState<LanguageSettings | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [limitText, setLimitText] = useState("");
  const [mode, setMode] = useState<Mode>("assisted");
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [permissions, setPermissions] = useState<TakeoverPermissions>({ allowLand: true, allowEconomy: true, preservePlayerAssets: false });
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [assist, setAssist] = useState<{ code: string; requestText: string } | null>(null);
  const [reply, setReply] = useState("");
  const [replyCheck, setReplyCheck] = useState<ReplyCheck | null>(null);
  const [result, setResult] = useState<{ ok: boolean; detail: string; notes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [commentaryOn, setCommentaryOn] = useState(() => { try { return window.localStorage.getItem("ai-mayor-console-commentary") !== "off"; } catch { return true; } });
  useEffect(() => { try { window.localStorage.setItem("ai-mayor-console-commentary", commentaryOn ? "on" : "off"); } catch { /* */ } }, [commentaryOn]);
  const [copied, setCopied] = useState(false);
  const [subtitleOn, setSubtitleOn] = useState(true);
  // Growth: "autonomy, no outward expansion" and the population at which growth stops. The engine holds them (and keeps them across restarts); the box shows what it holds.
  const [targetText, setTargetText] = useState("");
  const [growthNote, setGrowthNote] = useState(false);
  const heldNow = state?.growth?.held === true;
  const targetHeld = state?.growth?.targetPopulation ?? null;
  useEffect(() => { if (targetHeld !== null && targetHeld !== 100_000) setTargetText(String(targetHeld)); }, [targetHeld]);
  const sendGrowth = (change: { held?: boolean; targetPopulation?: number }) => {
    void api().aiMayorConsole.growth?.(change).then(() => { setGrowthNote(true); window.setTimeout(() => setGrowthNote(false), 1800); });
  };
  // The product's own update check (the owner's site publishes one JSON file): quietly on start and every 6 hours; the player decides to install.
  type UpdateInfo = { kind: "UP_TO_DATE" | "AVAILABLE"; manifest?: { version: string; notes: string; pageUrl: string | null }; required?: boolean; canInstallInApp?: boolean };
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState<"checking" | "installing" | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const checkUpdate = useCallback((force: boolean) => {
    setUpdateBusy("checking"); setUpdateMessage("");
    void api().aiMayorConsole.updateCheck?.(force).then((out: { ok: boolean; verdict: UpdateInfo | null }) => {
      if (out?.verdict) setUpdate(out.verdict);
      if (force) setUpdateMessage(!out?.ok ? "failed" : out.verdict?.kind === "AVAILABLE" ? "" : "latest");
    }).finally(() => setUpdateBusy(null));
  }, []);
  useEffect(() => { checkUpdate(false); const timer = window.setInterval(() => checkUpdate(false), 6 * 60 * 60_000); return () => window.clearInterval(timer); }, [checkUpdate]);
  const installUpdate = () => {
    setUpdateBusy("installing"); setUpdateMessage("");
    void api().aiMayorConsole.updateInstall?.().then((out: { ok: boolean; error?: string }) => { if (!out?.ok) setUpdateMessage(`error:${out?.error ?? ""}`); }).finally(() => setUpdateBusy(null));
  };
  // The game in exclusive full screen hides every window over it: read from its own settings, so the console can say how to see the subtitles.
  const [gameFullscreen, setGameFullscreen] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => void api().aiMayorConsole.gameFullscreen?.().then((value: boolean | null) => setGameFullscreen(value));
    read();
    const timer = window.setInterval(read, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { void api().aiMayorConsole.subtitleState?.().then((on: boolean) => setSubtitleOn(on !== false)); }, []);
  const [saved, setSaved] = useState(false);
  const [apiForm, setApiForm] = useState<{ preset: ProviderPreset; baseUrl: string; model: string; apiKey: string }>({ preset: "auto", baseUrl: "", model: "", apiKey: "" });
  const [balance, setBalance] = useState<Balance | null>(null);
  const [aiTest, setAiTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const lastClipboard = useRef("");
  const t = useCallback((key: ConsoleKey) => DICTIONARIES[lang][key], [lang]);

  useEffect(() => {
    void api().aiMayorConsole.getState().then((next: FullState) => { setState(next); if (next?.permissions) setPermissions(next.permissions); });
    void api().aiMayorConsole.usage?.().then((next: AiUsage) => setUsage(next));
    void api().aiMayorConsole.languageGet().then((next: LanguageSettings) => { setLimitText(String(next.dailyTokenLimit ?? 200000)); setLanguage(next); setMode(next.mode === "api" && !next.hasKey ? "assisted" : next.mode); setApiForm({ preset: next.preset, baseUrl: next.baseUrl, model: next.model, apiKey: "" }); if (next.hasKey) void api().aiMayorConsole.balance().then(setBalance); });
    return api().ipcRenderer.on("ai-mayor-console-state", (next) => setState((previous) => ({ ...(previous ?? {}), ...(next as FullState) })));
  }, []);
  useEffect(() => { try { window.localStorage.setItem("ai-mayor-console-theme-v3", theme); } catch { /* */ } void api().aiMayorConsole.setTheme?.(theme); }, [theme]);
  useEffect(() => { try { window.localStorage.setItem("ai-mayor-console-lang", lang); } catch { /* */ } document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"; document.title = BRAND.name[lang]; }, [lang]);
  // The local reading, while typing: free and offline; nothing is sent until the player sends it.
  useEffect(() => {
    // A sent instruction empties the box: its result stays until the player types again.
    if (!text.trim()) { setParsed(null); return; }
    setResult(null);
    const handle = window.setTimeout(() => void api().aiMayorConsole.parse(text).then(setParsed), 250);
    return () => window.clearTimeout(handle);
  }, [text]);
  // Assisted mode with the opted-in clipboard watch: only while a reply is awaited, and a clipboard text is only offered, never sent.
  useEffect(() => {
    if (!assist || !language?.clipboardWatch) return;
    const timer = window.setInterval(() => {
      void api().aiMayorConsole.readClipboard().then((clip: string) => {
        if (!clip || clip === lastClipboard.current || !clip.includes(`MAYOR-${assist.code}`)) return;
        lastClipboard.current = clip;
        setReply(clip);
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [assist, language?.clipboardWatch]);
  useEffect(() => {
    if (!assist || !reply.trim()) { setReplyCheck(null); return; }
    void api().aiMayorConsole.checkReply(reply).then(setReplyCheck);
  }, [assist, reply]);

  const phase = state?.phase ?? "IDLE";
  const snapshot = state?.snapshot ?? null;
  const connected = state?.gameConnection === "CONNECTED";
  const active = phase === "RUNNING" || phase === "PAUSING" || phase === "PAUSED" || phase === "WAITING_FOR_GAME" || phase === "BACKING_UP" || phase === "STARTING";
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { const next = await fn(); if (next && typeof next === "object" && "phase" in (next as object)) setState((previous) => ({ ...(previous ?? {}), ...(next as FullState) })); } finally { setBusy(false); } };
  const finish = (outcome: { ok: boolean; detail?: string; notes?: string[] }) => {
    setResult({ ok: outcome.ok, detail: outcome.detail ?? "", notes: Array.isArray(outcome.notes) ? outcome.notes : [] });
    if (outcome.ok) { setText(""); setAssist(null); setReply(""); }
  };

  const sendApi = async () => { setBusy(true); try { finish(await api().aiMayorConsole.interpret(text)); void api().aiMayorConsole.balance().then(setBalance); } finally { setBusy(false); } };
  // The balance, where the service publishes one: on open, after each request, and every 5 minutes in API mode (never a tight poll).
  useEffect(() => {
    if (mode !== "api" || !language?.hasKey) return;
    const timer = window.setInterval(() => void api().aiMayorConsole.balance().then(setBalance), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [mode, language?.hasKey]);
  const balanceText = balance?.supported && balance.amount !== null && Number.isFinite(balance.amount) ? `${t("ai.balance")} ${balance.currency === "USD" ? "$" : balance.currency === "CNY" ? "¥" : ""}${balance.amount.toFixed(2)}` : null;
  const sendLocal = async () => { setBusy(true); try { finish(await api().aiMayorConsole.sendLocal(text)); } finally { setBusy(false); } };
  const startAssist = async () => { const prompt = await api().aiMayorConsole.prompt(text) as { code: string }; setAssist({ code: prompt.code, requestText: text }); setReply(""); setReplyCheck(null); lastClipboard.current = ""; };
  const confirmAssist = async () => { if (!assist) return; setBusy(true); try { finish(await api().aiMayorConsole.sendIntent({ text: assist.requestText, reply })); } finally { setBusy(false); } };

  // What the player's spoken limits hold the Mayor to right now (as the engine reports them, not as the console remembers sending them).
  const limitChips = useMemo(() => {
    const chips = (state?.protectedAreas ?? []).map((name) => `${t("limits.protected")}: ${name}`);
    const settings = state?.permissions;
    const effective = state?.effectivePermissions;
    if (settings && effective) {
      if (settings.allowLand && !effective.allowLand) chips.push(t("limits.no_land"));
      if (settings.allowEconomy && !effective.allowEconomy) chips.push(t("limits.no_loan"));
      if (!settings.preservePlayerAssets && effective.preservePlayerAssets) chips.push(t("limits.keep_assets"));
    }
    if (state?.keep?.zoning) chips.push(t("limits.keep_zoning"));
    if (state?.keep?.roads) chips.push(t("limits.keep_roads"));
    return chips;
  }, [state?.protectedAreas, state?.permissions, state?.effectivePermissions, state?.keep, t]);
  const cycle = state?.lastCycle ?? null;
  const doing = cycle ? (cycle.waitReason && DICTIONARIES[lang][`work.wait.${cycle.waitReason}` as ConsoleKey]) || (cycle.status && DICTIONARIES[lang][`work.${cycle.status}` as ConsoleKey]) || t("work.watching") : t("work.watching");
  // The subtitle: the Mayor's latest line (the language expressor in the engine), fresh for 15 minutes; the work dictionary otherwise.
  const said = state?.commentary ?? [];
  const latest = said.length > 0 ? said[said.length - 1]! : null;
  const fresh = commentaryOn && latest && Date.now() - new Date(latest.at).getTime() < 15 * 60_000 ? latest : null;
  const issues = useMemo(() => Object.entries(snapshot?.icons ?? {}).filter(([type, count]) => count > 0 && !NOT_A_PROBLEM_ICON.test(type)).sort((a, b) => b[1] - a[1]).slice(0, 5), [snapshot]);

  const notices: Array<{ tone: "amber" | "red"; text: string }> = [];
  if (state?.gameConnection === "NOT_RUNNING" && active) notices.push({ tone: "red", text: t("notice.game_missing") });
  if (phase === "FAILED") notices.push({ tone: "red", text: `${t("notice.failed")}${state?.phaseDetail ?? ""}` });
  if (state?.backup && !state.backup.ok) notices.push({ tone: "red", text: t("notice.backup_failed") });
  if (state?.gamePaused && active) notices.push({ tone: "amber", text: t("notice.game_paused") });
  if (state?.supervision && /STALLED|CHILD_EXITED/.test(state.supervision.state)) notices.push({ tone: "amber", text: t("notice.recovery") });
  if (state?.supervision?.state === "GAVE_UP") notices.push({ tone: "red", text: t("notice.gave_up") });
  if (state?.mod?.needsGameRestart) notices.push({ tone: "amber", text: t("notice.mod_restart") });
  if (active && subtitleOn && gameFullscreen === true) notices.push({ tone: "amber", text: t("notice.fullscreen") });

  const mainButton = phase === "RUNNING"
    ? <button type="button" disabled={busy} onClick={() => void run(() => api().aiMayorConsole.pause())}>{t("action.pause")}</button>
    : phase === "PAUSED" || phase === "PAUSING"
      ? <button type="button" className="primary" disabled={busy || phase === "PAUSING"} onClick={() => void run(() => api().aiMayorConsole.resume())}>{phase === "PAUSING" ? t("phase.PAUSING") : t("action.resume")}</button>
      : active ? <button type="button" disabled>{t(`phase.${phase}` as ConsoleKey)}</button>
        : <button type="button" className="primary big" disabled={busy || !connected} onClick={() => setTakeoverOpen(true)}>{t("action.takeover")}</button>;

  // Stopping the Mayor is on the home page too, not only at the bottom of Settings: the player must be able to end the takeover where they started it.
  const stopButton = active ? <button type="button" className="ghost danger-text" disabled={busy} onClick={() => void run(() => api().aiMayorConsole.stop())}>{t("action.stop")}</button> : null;
  const switchRow = (field: keyof TakeoverPermissions, title: ConsoleKey, desc: ConsoleKey, value: TakeoverPermissions, onChange: (next: TakeoverPermissions) => void) => (
    <label key={field} className="mc-row-setting"><span><strong>{t(title)}</strong><small>{t(desc)}</small></span>
      <input type="checkbox" className="mc-switch" checked={value[field]} onChange={(event) => onChange({ ...value, [field]: event.target.checked })} /></label>
  );
  const scopeRows = (value: TakeoverPermissions, onChange: (next: TakeoverPermissions) => void) => (
    <>{switchRow("allowLand", "take.land", "take.land.desc", value, onChange)}{switchRow("allowEconomy", "take.economy", "take.economy.desc", value, onChange)}
      {switchRow("preservePlayerAssets", "take.preserve", "take.preserve.desc", value, onChange)}</>
  );
  const flashSaved = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1500); };

  const home = (
    <div className="mc-home">
      <section className="mc-hero">
        <div className="mc-chips">
          <span className={`mc-chip ${connected ? "ok" : state?.gameConnection === "NOT_RUNNING" ? "bad" : ""}`}>{t(connected ? "conn.connected" : state?.gameConnection === "NOT_RUNNING" ? "conn.not_running" : "conn.unknown")}</span>
          <span className={`mc-chip ${phase === "RUNNING" ? "run" : phase === "FAILED" ? "bad" : phase === "PAUSED" ? "warn" : ""}`}>{t(`phase.${phase}` as ConsoleKey)}</span>
          {snapshot?.gameDateTime ? <span className="mc-chip">{snapshot.gameDateTime}</span> : null}
        </div>
        <h1>{snapshot?.cityName ?? BRAND.name[lang]}</h1>
        <p className={`mc-lead${fresh ? ` mc-say ${fresh.tone ?? ""}` : ""}`} aria-live="polite">{active ? (fresh ? fresh.text : `${t("hero.doing")}：${doing}`) : connected ? t("hero.idle") : t("hero.no_game")}</p>
        <div className="mc-hero-action">{mainButton}{stopButton}</div>
      </section>
      {update?.kind === "AVAILABLE" && !updateDismissed ? (
        <div className="mc-notice amber mc-update">
          <span><strong>{t(update.required ? "update.required" : "update.available")} {update.manifest?.version}</strong>{update.manifest?.notes ? ` · ${update.manifest.notes.split("\n").slice(0, 3).join(" / ")}` : ""}</span>
          <span className="mc-update-actions">
            <button type="button" className="primary" disabled={updateBusy === "installing"} onClick={installUpdate}>{updateBusy === "installing" ? t("update.installing") : t(update.canInstallInApp ? "update.install" : "update.open_page")}</button>
            {!update.required ? <button type="button" className="ghost" onClick={() => setUpdateDismissed(true)}>{t("update.later")}</button> : null}
          </span>
          {updateMessage.startsWith("error:") ? <small>{t("update.error")}{updateMessage.slice(6)}</small> : null}
        </div>
      ) : null}
      {notices.map((notice, index) => <div key={index} className={`mc-notice ${notice.tone}`}>{notice.text}</div>)}
      {snapshot ? (
        <section className="mc-numbers">
          <div><small>{t("metric.population")}</small><strong className="num">{fmt(snapshot.population, lang)}</strong></div>
          <div><small>{t("metric.money")}</small><strong className="num">{fmt(snapshot.treasury, lang)}</strong></div>
          <div><small>{t("metric.balance")}</small><strong className={`num ${(snapshot.monthlyBalance ?? 0) >= 0 ? "pos" : "neg"}`}>{fmt(snapshot.monthlyBalance, lang)}</strong></div>
          <div><small>{t("metric.traffic")}</small><strong className="num">{snapshot.traffic ? `${Math.round(snapshot.traffic.flowPercent)}%` : "—"}</strong></div>
        </section>
      ) : null}
      {commentaryOn && said.length > 1 ? (
        <section className="mc-said">
          <div className="mc-said-head"><h2>{t("say.title")}</h2></div>
          <ul>{[...said].reverse().slice(1, 7).map((line, index) => <li key={index} className={line.tone ?? ""}><time>{new Date(line.at).toLocaleTimeString()}</time>{line.text}</li>)}</ul>
        </section>
      ) : null}
      <section className="mc-box">
        <div className="mc-box-head">
          <h2>{t("box.title")}</h2>
          {mode === "api" && balanceText ? <span className="mc-hint">{balanceText}</span> : null}
          <div className="mc-segment" role="tablist">
            {(["api", "assisted"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={mode === value} className={mode === value ? "on" : ""} title={t(value === "api" ? "box.mode.api.tip" : "box.mode.assisted.tip")}
                onClick={() => { setMode(value); setAssist(null); void api().aiMayorConsole.languageSet({ mode: value }); }}>{t(value === "api" ? "box.mode.api" : "box.mode.assisted")}</button>
            ))}
          </div>
        </div>
        <div className="mc-input">
          <textarea rows={2} value={text} placeholder={t("box.placeholder")} aria-label={t("box.title")} onChange={(event) => { setText(event.target.value); setAssist(null); }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (mode === "api" && language?.hasKey) void sendApi(); else if (parsed?.understood) void sendLocal(); } }} />
          {mode === "api" && language?.hasKey
            ? <button type="button" className="primary" disabled={busy || !text.trim() || !active} onClick={() => void sendApi()}>{t("box.send")}</button>
            : <button type="button" className="primary" disabled={busy || !parsed?.understood || !active} onClick={() => void sendLocal()}>{t("box.send")}</button>}
        </div>
        <div className="mc-growth">
          {growthNote ? <span className="mc-hint pos">{t("growth.saved")}</span> : null}
          <label title={t("growth.hold.tip")}><input type="checkbox" checked={heldNow} disabled={!active} onChange={(event) => sendGrowth({ held: event.target.checked })} /> {t("growth.hold")}</label>
          <label title={t("growth.target.tip")}>{t("growth.target")}
            <input type="text" inputMode="numeric" className="mc-target" value={targetText} placeholder="100000" disabled={!active}
              onChange={(event) => setTargetText(event.target.value.replace(/[^\d]/g, "").slice(0, 7))}
              onBlur={() => { const value = Number(targetText); if (targetText && value >= 1000) sendGrowth({ targetPopulation: value }); }}
              onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} /></label>
        </div>
        {mode === "api" && !language?.hasKey ? <p className="mc-hint">{t("box.no_api")} · <button type="button" className="link" onClick={() => setPage("settings")}>{t("box.go_settings")}</button></p> : null}
        {parsed && text.trim() && !assist ? (
          <p className={`mc-hint ${parsed.understood ? "pos" : ""}`}>{parsed.understood ? `${t("box.understood")}：${parsed.summary}` : t("box.not_understood")}
            {!parsed.understood && mode === "assisted" ? <> · <button type="button" className="link" onClick={() => void startAssist()}>{t("box.copy_prompt")}</button></> : null}
            {parsed.understood && parsed.confident === false ? <> · {t(mode === "api" && language?.hasKey ? "box.partial_api" : "box.partial")}{mode === "assisted" ? <> <button type="button" className="link" onClick={() => void startAssist()}>{t("box.copy_prompt")}</button></> : null}</> : null}</p>
        ) : null}
        {assist ? (
          <div className="mc-assist">
            <p>{t("assist.step1")}</p>
            <div className="mc-links">{FREE_AI_PAGES.map((site) => <button key={site.name} type="button" className="small" onClick={() => void api().aiMayorConsole.open(site.url)}>{site.name}</button>)}</div>
            <p>{t("assist.step2")}</p>
            <input value={reply} placeholder={t("assist.reply_placeholder")} onChange={(event) => setReply(event.target.value)} aria-label={t("assist.step2")} />
            {language?.clipboardWatch && !replyCheck?.ok ? <p className="mc-hint">{t("assist.watching")}</p> : null}
            {replyCheck ? <p className={`mc-hint ${replyCheck.ok ? "pos" : "neg"}`}>{replyCheck.ok ? `${t("assist.valid")}${lang === "zh" ? "：" : ": "}${(replyCheck as { summary?: { zh: string; en: string } }).summary?.[lang] ?? replyCheck.intent?.type ?? t("assist.limits_only")}` : (DICTIONARIES[lang][`assist.err.${replyCheck.error}` as ConsoleKey] ?? replyCheck.detail)}</p> : null}
            <div className="mc-actions"><button type="button" className="ghost" onClick={() => setAssist(null)}>{t("assist.cancel")}</button>
              <button type="button" className="primary" disabled={busy || !replyCheck?.ok || !active} onClick={() => void confirmAssist()}>{t("assist.confirm")}</button></div>
          </div>
        ) : null}
        {result ? <p className={`mc-hint ${result.ok ? "pos" : "neg"}`}>{result.ok ? t(result.detail === "limits recorded" ? "result.limits" : "result.sent") : `${t("result.failed")}${result.detail}`}</p> : null}
        {result?.notes.length ? <ul className="mc-notes mc-result-notes">{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
        {limitChips.length > 0 ? (
          <div className="mc-limits">
            <small>{t("limits.title")}</small>
            {limitChips.map((chip) => <span key={chip} className="mc-chip">{chip}</span>)}
            <button type="button" className="link" disabled={busy || !active} onClick={() => void run(() => api().aiMayorConsole.clearLimits())}>{t("limits.clear")}</button>
          </div>
        ) : null}
      </section>
      {active || cycle ? (
        <section className="mc-details">
          <button type="button" className="ghost small" onClick={() => setDetails(!details)}>{details ? t("details.hide") : t("details.show")}</button>
          {details ? (
            <div className="mc-details-body">
              <h3>{t("details.issues")}</h3>
              {issues.length === 0 ? <p className="mc-muted">{t("details.none")}</p> : <ul>{issues.map(([type, count]) => <li key={type}>{iconName(type, lang)} <span className="mc-muted">× {count}</span></li>)}</ul>}
              <h3>{t("details.work")}</h3>
              {cycle?.notes.length ? <ul className="mc-notes">{cycle.notes.slice(0, 18).map((note, index) => <li key={index}>{note}</li>)}</ul> : <p className="mc-muted">{t("details.none")}</p>}
              <h3>{t("details.activity")}</h3>
              <ul className="mc-notes">{[...(state?.activity ?? [])].reverse().slice(0, 8).map((event, index) => <li key={index}>{new Date(event.at).toLocaleTimeString()} · {event.text}</li>)}</ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );

  const settings = (
    <div className="mc-page">
      <h1>{t("settings.title")}</h1>
      <section className="mc-card"><h2>{t("settings.scope")}</h2>{scopeRows(permissions, setPermissions)}
        <div className="mc-actions"><button type="button" disabled={busy} onClick={() => void run(() => api().aiMayorConsole.setPermissions(permissions)).then(flashSaved)}>{saved ? t("settings.saved") : t("settings.scope.save")}</button></div></section>
      <section className="mc-card"><h2>{t("settings.ai")}</h2>
        <label className="mc-row-setting"><span><strong>{t("settings.ai.default")}</strong></span>
          <select value={mode} onChange={(event) => { const value = event.target.value as Mode; setMode(value); void api().aiMayorConsole.languageSet({ mode: value }); }}>
            <option value="assisted">{t("box.mode.assisted")}</option><option value="api">{t("box.mode.api")}</option></select></label>
        <label className="mc-field"><span>{t("settings.ai.key")}</span><input type="password" value={apiForm.apiKey} placeholder={language?.hasKey ? t("settings.ai.key.set") : "sk-…"}
          onChange={(event) => { const apiKey = event.target.value; const detected = detectPreset(apiKey, apiForm.baseUrl); setApiForm({ ...apiForm, apiKey, ...(apiForm.preset === "auto" && detected ? { preset: detected } : {}) }); }} /></label>
        <label className="mc-field"><span>{t("settings.ai.service")}</span>
          <select value={apiForm.preset} onChange={(event) => setApiForm({ ...apiForm, preset: event.target.value as ProviderPreset })}>
            {PRESET_OPTIONS.map(([value, label]) => <option key={value} value={value}>{value === "auto" ? t("settings.ai.auto") : value === "custom-openai" ? t("settings.ai.custom_openai") : value === "custom-claude" ? t("settings.ai.custom_claude") : label}</option>)}
          </select></label>
        <label className="mc-field"><span>{t("settings.ai.url")}</span><input value={apiForm.baseUrl} placeholder={apiForm.preset !== "auto" ? PRESETS[apiForm.preset].baseUrl || "https://…/v1" : "https://…/v1"} onChange={(event) => setApiForm({ ...apiForm, baseUrl: event.target.value })} /></label>
        <label className="mc-field"><span>{t("settings.ai.model")}</span><input value={apiForm.model} placeholder={apiForm.preset !== "auto" ? PRESETS[apiForm.preset].model : ""} onChange={(event) => setApiForm({ ...apiForm, model: event.target.value })} /></label>
        <label className="mc-field"><span>{t("settings.ai.limit")}</span>{/* A text field, not type="number": the native number box (its spin buttons) crashed the renderer on this Electron build (measured 2026-10-07). */}
          <input type="text" inputMode="numeric" value={limitText} onChange={(event) => setLimitText(event.target.value.replace(/[^\d]/g, ""))}
          onBlur={() => { const value = Math.max(0, Math.floor(Number(limitText) || 0)); setLimitText(String(value)); void api().aiMayorConsole.languageSet({ dailyTokenLimit: value }).then(() => api().aiMayorConsole.usage?.().then((next: AiUsage) => setUsage(next))); }} /></label>
        <p className="mc-hint">{usage ? `${t("settings.ai.used")}: ${usage.tokens} / ${usage.limit > 0 ? usage.limit : "∞"} tokens` : ""}</p>
        <p className="mc-hint">{t("settings.ai.note")}</p>
        {aiTest ? <p className={`mc-hint ${aiTest.ok ? "pos" : "neg"}`}>{aiTest.ok ? `${t("settings.ai.test.ok")} · ${aiTest.detail}` : `${t("settings.ai.test.fail")}${aiTest.detail}`}</p> : null}
        {language?.hasKey ? <p className="mc-hint">{balanceText ?? (balance ? t("settings.ai.no_balance") : "")}</p> : null}
        <div className="mc-actions">
          <button type="button" disabled={busy || !language?.hasKey} onClick={() => { setBusy(true); setAiTest(null); void api().aiMayorConsole.aiTest().then((outcome: { ok: boolean; detail: string }) => { setAiTest(outcome); void api().aiMayorConsole.balance().then(setBalance); }).finally(() => setBusy(false)); }}>{t("settings.ai.test")}</button>
          <button type="button" onClick={() => void api().aiMayorConsole.languageSet({ preset: apiForm.preset, baseUrl: apiForm.baseUrl, model: apiForm.model, ...(apiForm.apiKey ? { apiKey: apiForm.apiKey } : {}) })
          .then((outcome: { hasKey: boolean }) => { setLanguage((previous) => previous ? { ...previous, hasKey: outcome.hasKey, preset: apiForm.preset } : previous); setApiForm({ ...apiForm, apiKey: "" }); setAiTest(outcome.hasKey ? null : { ok: false, detail: t("settings.ai.need_provider") }); flashSaved(); if (outcome.hasKey) void api().aiMayorConsole.balance().then(setBalance); })}>{saved ? t("settings.saved") : t("settings.ai.save")}</button></div>
        <label className="mc-row-setting"><span><strong>{t("settings.clipboard")}</strong><small>{t("settings.clipboard.desc")}</small></span>
          <input type="checkbox" className="mc-switch" checked={language?.clipboardWatch ?? false} onChange={(event) => { const clipboardWatch = event.target.checked; setLanguage((previous) => previous ? { ...previous, clipboardWatch } : previous); void api().aiMayorConsole.languageSet({ clipboardWatch }); }} /></label>
      </section>
      <section className="mc-card"><h2>{t("settings.ui")}</h2>
        <label className="mc-row-setting"><span><strong>{t("settings.subtitle")}</strong><small>{gameFullscreen ? t("notice.fullscreen") : t("settings.subtitle.desc")}</small></span>
          <input type="checkbox" className="mc-switch" checked={subtitleOn} onChange={(event) => { setSubtitleOn(event.target.checked); void api().aiMayorConsole.subtitle?.(event.target.checked); }} /></label>
        <label className="mc-row-setting"><span><strong>{t("settings.commentary")}</strong><small>{t("settings.commentary.desc")}</small></span>
          <input type="checkbox" className="mc-switch" checked={commentaryOn} onChange={(event) => setCommentaryOn(event.target.checked)} /></label>
        <label className="mc-row-setting"><span><strong>{t("settings.language")}</strong></span><select value={lang} onChange={(event) => setLang(event.target.value as ConsoleLang)}><option value="zh">简体中文</option><option value="en">English</option></select></label>
        <label className="mc-row-setting"><span><strong>{t("settings.theme")}</strong></span><select value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}><option value="dark">{t("settings.dark")}</option><option value="light">{t("settings.light")}</option></select></label>
        <div className="mc-row-setting"><span><strong>{t("settings.mod")}</strong><small>{state?.mod?.status ?? "—"}</small></span>
          <button type="button" onClick={() => void api().aiMayorConsole.installMod().then((mod: FullState["mod"]) => setState((previous) => previous ? { ...previous, mod } : previous))}>{t("settings.mod.reinstall")}</button></div>
        {active ? <div className="mc-row-setting"><span><strong>{t("settings.danger")}</strong></span><button type="button" className="danger" onClick={() => void run(() => api().aiMayorConsole.stop())}>{t("action.stop")}</button></div> : null}
      </section>
    </div>
  );

  // Links appear only when the owner has set them (`brand.ts`); an unset link is simply absent, never a disabled button.
  const linkButton = (url: string, label: ConsoleKey) => (url ? <button type="button" onClick={() => void api().aiMayorConsole.open(url)}>{t(label)}</button> : null);
  const about = (
    <div className="mc-page">
      <div className="mc-about-head"><BrandMark /><div><h1>{BRAND.name[lang]}</h1><p className="mc-muted">{t("about.version")} {state?.appVersion ?? "—"}</p>
        <p className="mc-update-line"><button type="button" className="small" disabled={updateBusy !== null} onClick={() => checkUpdate(true)}>{updateBusy === "checking" ? t("update.checking") : t("update.check")}</button>
          {updateMessage === "latest" ? <span className="mc-hint pos"> {t("update.latest")}</span> : updateMessage === "failed" ? <span className="mc-hint neg"> {t("update.failed")}</span> : null}
          {update?.kind === "AVAILABLE" ? <span className="mc-hint"> {t("update.available")} {update.manifest?.version}</span> : null}</p></div></div>
      <section className="mc-card"><p className="mc-about-basis">{t("about.basis")}</p></section>
      <section className="mc-card"><h2>{t("about.feedback")}</h2>
        <div className="mc-actions left"><button type="button" onClick={() => void api().aiMayorConsole.copyDiagnostics().then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); })}>{copied ? t("about.copied") : t("about.copy_diag")}</button>
          {linkButton(BRAND.feedbackUrl, "about.feedback")}</div></section>
      <section className="mc-card"><h2>{t("about.stage")}</h2><p className="mc-muted">{t("about.stage.desc")}</p></section>
      <section className="mc-card"><h2>{t("about.support")}</h2><p className="mc-muted">{t("about.support.desc")}</p>
        <div className="mc-actions left">{linkButton(BRAND.supportUrl, "about.donate")}{linkButton(BRAND.websiteUrl, "about.website")}</div></section>
      {BRAND.githubUrl ? <section className="mc-card"><h2>{t("about.github")}</h2><p className="mc-muted">{t("about.github.desc")}</p><p className="mc-muted">{t("about.github.network")}</p>
        <div className="mc-actions left">{linkButton(BRAND.githubUrl, "about.github.open")}</div></section> : null}
    </div>
  );

  return (
    <div className="mc-shell" data-mc-theme={theme}>
      <nav className="mc-rail" aria-label={BRAND.name[lang]}>
        <div className="mc-rail-logo"><BrandMark /></div>
        <button type="button" aria-current={page === "home" ? "page" : undefined} onClick={() => setPage("home")} title={t("nav.home")}><IconHome /><span>{t("nav.home")}</span></button>
        <button type="button" aria-current={page === "settings" ? "page" : undefined} onClick={() => setPage("settings")} title={t("nav.settings")}><IconGear /><span>{t("nav.settings")}</span></button>
        <div className="mc-rail-spacer" />
        <button type="button" aria-current={page === "about" ? "page" : undefined} onClick={() => setPage("about")} title={t("nav.about")}><IconOpenCircle /><span>{t("nav.about")}</span></button>
      </nav>
      <main className="mc-content">
        <div className="mc-dragbar" />
        {page === "home" ? home : page === "settings" ? settings : about}
      </main>
      {takeoverOpen ? (
        <div className="mc-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") setTakeoverOpen(false); }}>
          <div className="mc-dialog" role="dialog" aria-modal="true" aria-labelledby="mc-take-title">
            <h2 id="mc-take-title">{t("take.title")}</h2><p className="mc-muted">{t("take.intro")}</p>
            {scopeRows(permissions, setPermissions)}
            <div className="mc-actions"><button type="button" className="ghost" onClick={() => setTakeoverOpen(false)}>{t("take.cancel")}</button>
              <button type="button" className="primary" disabled={busy} onClick={() => { setTakeoverOpen(false); void run(() => api().aiMayorConsole.takeOver(permissions)); }}>{t("take.confirm")}</button></div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
