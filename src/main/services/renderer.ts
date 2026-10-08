import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import Store from "electron-store";
import { Environment } from "@/main/environment";
import { Container } from "@/main/internal/container";
import { Stateful } from "@/main/internal/stateful";
import MenuBuilder from "@/main/menu";
import { type AiMayorOverlaySettings, normalizeAiMayorOverlaySettings } from "@/main/services/ai-mayor-product-mode";
import { Logger } from "@/main/services/logger";

/** The bar over the game: the folded button's side and the unfolded strip's width (px). */
const GAME_BAR_BUTTON = 56;
const GAME_BAR_STRIP_WIDTH = 460;

const TITLE_BAR_OVERLAY_STYLES = {
  light: {
    color: "rgba(227, 227, 227, 1)",
    height: 30,
    symbolColor: "black",
  },
  dark: {
    color: "rgba(44, 42, 43, 1)",
    height: 30,
    symbolColor: "white",
  },
};

/**
 * Renderer class is used to manage the application's rendering process and browser window
 * Responsible for creating, configuring and managing Electron's BrowserWindow instances
 * @extends Stateful<Renderer.State>
 */
export class Renderer extends Stateful<Renderer.State> {
  #environment = Container.inject(Environment);
  #logger = Container.inject(Logger).scope("Renderer");
  #overlayWindow: BrowserWindow | null = null;
  #overlayStore = new Store<{ bounds?: Electron.Rectangle; settings?: AiMayorOverlaySettings }>({
    name: "ai-mayor-overlay",
  });

  /**
   * Create Renderer instance
   * Initialize window state and system theme listeners
   */
  constructor() {
    super(() => {
      return {
        window: null,
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
        shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
        inForcedColorsMode: nativeTheme.inForcedColorsMode,
        prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
        preferredSystemLanguages: app.getPreferredSystemLanguages(),
        locale: app.getLocale(),
        localeCountryCode: app.getLocaleCountryCode(),
        systemLocale: app.getSystemLocale(),
      };
    });

    nativeTheme.addListener("updated", () => {
      this.update((draft) => {
        draft.shouldUseDarkColors = nativeTheme.shouldUseDarkColors;
        draft.shouldUseHighContrastColors = nativeTheme.shouldUseHighContrastColors;
        draft.shouldUseInvertedColorScheme = nativeTheme.shouldUseInvertedColorScheme;
        draft.inForcedColorsMode = nativeTheme.inForcedColorsMode;
        draft.prefersReducedTransparency = nativeTheme.prefersReducedTransparency;
      });
      if (this.state.window?.setTitleBarOverlay) {
        this.state.window?.setTitleBarOverlay(this.#getTitleBarOverlayStyle());
      }
    });
  }

  /**
   * Get title bar overlay style
   */
  #getTitleBarOverlayStyle() {
    return TITLE_BAR_OVERLAY_STYLES[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
  }

  /**
   * Get browser window configuration options
   * Set specific window styles and behaviors based on different platforms
   * @returns Electron.BrowserWindowConstructorOptions Browser window configuration options
   */
  get #windowOptions() {
    // The first size follows the screen (the console's content is about 900 x 700): no wide blank margins on a large screen, nothing cut on a small one.
    let size = { width: 1024, height: 728 };
    try {
      const area = screen.getPrimaryDisplay().workArea;
      size = { width: Math.round(Math.min(Math.max(880, area.width * 0.5), 1100, area.width - 40)), height: Math.round(Math.min(Math.max(640, area.height * 0.78), 820, area.height - 40)) };
    } catch { /* before the screen can be read: the old default */ }
    const options: Electron.BrowserWindowConstructorOptions = {
      width: size.width,
      height: size.height,
      minWidth: 468,
      minHeight: 600,
      center: true,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        webSecurity: false,
        preload: this.#environment.preloadEntry,
      },
    };

    if (process.platform === "win32") {
      options.titleBarStyle = "hidden";
      options.titleBarOverlay = this.#getTitleBarOverlayStyle();
    }

    if (process.platform === "darwin") {
      options.vibrancy = "sidebar";
      options.visualEffectState = "active";
      options.transparent = true;
    }

    return options;
  }

  /**
   * Initialize browser window
   * Create a new BrowserWindow instance and configure related event handling
   * @returns Promise<void>
   */
  async init() {
    const logger = this.#logger.scope("Init");

    if (this.state.window && !this.state.window.isDestroyed()) {
      return logger.error("Cannot init renderer: renderer is already initialized");
    }

    const window = new BrowserWindow(this.#windowOptions);

    this.update((draft) => {
      draft.window = window;
    });

    new MenuBuilder(window).buildMenu();

    window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url).catch((error) => {
        logger.capture(error, {
          reason: `Failed to open external link: ${url}`,
        });
      });

      return {
        action: "deny",
      };
    });

    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });

    window.webContents.on("did-finish-load", () => {
      // window?.show();
      // window?.focus();
    });

    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logger.error("Renderer failed to load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
      // ERR_ABORTED is commonly emitted when Electron supersedes a navigation.
      // Reloading from this callback aborts the original loadFile/loadURL promise
      // and masks the actual renderer boot result as another ERR_ABORTED.
      if (errorCode === -3 || window.isDestroyed()) return;
      window.reload();
    });

    window.on("closed", () => {
      this.update((draft) => {
        draft.window = null;
      });
    });

    if (!app.isPackaged && this.#environment.rendererDevServer) {
      await window.loadURL(this.#environment.rendererDevServer);
    } else {
      await window.loadFile(this.#environment.rendererEntry);
    }
  }

  /**
   * Focus on the browser window
   * If the window does not exist or has been destroyed, initialize the window first
   * @returns Promise<void>
   */
  async focus() {
    if (!this.state.window || this.state.window.isDestroyed()) {
      await this.init();
    }

    if (this.state.window) {
      if (this.state.window.isMinimized()) {
        this.state.window.restore();
      }

      this.state.window.focus();
    }
  }

  async showOverlay() {
    if (this.#overlayWindow && !this.#overlayWindow.isDestroyed()) {
      this.#overlayWindow.setAlwaysOnTop(this.getOverlaySettings().alwaysOnTop, "floating");
      this.#overlayWindow.show();
      this.#overlayWindow.focus();
      return;
    }

    const savedBounds = this.#overlayStore.get("bounds");
    const window = new BrowserWindow({
      width: savedBounds?.width ?? 390,
      height: savedBounds?.height ?? 560,
      x: savedBounds?.x,
      y: savedBounds?.y,
      minWidth: 320,
      minHeight: 64,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: this.getOverlaySettings().alwaysOnTop,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        webSecurity: false,
        preload: this.#environment.preloadEntry,
      },
    });
    this.#overlayWindow = window;
    window.setAlwaysOnTop(this.getOverlaySettings().alwaysOnTop, "floating");
    window.on("move", () => this.#saveOverlayBounds(window));
    window.on("resize", () => this.#saveOverlayBounds(window));
    window.on("closed", () => {
      this.#overlayWindow = null;
    });

    if (!app.isPackaged && this.#environment.rendererDevServer) {
      const url = new URL(this.#environment.rendererDevServer);
      url.searchParams.set("ai-mayor-overlay", "1");
      await window.loadURL(url.toString());
    } else {
      await window.loadFile(this.#environment.rendererEntry, { search: "ai-mayor-overlay=1" });
    }
    window.showInactive();
  }

  /**
   * Push an AI Mayor event to the window the player is actually watching.
   *
   * The overlay runs in its own BrowserWindow, and the session events used to
   * be sent to the main chat window only — which product mode never shows. The
   * player therefore saw a Mayor that never said anything, however much it was
   * narrating. Both windows are served so the overlay is not the only casualty
   * of a future change to which window is visible.
   */
  broadcastToOverlay(channel: string, payload: unknown) {
    if (!this.#overlayWindow || this.#overlayWindow.isDestroyed()) return;
    this.#overlayWindow.webContents.send(channel, payload);
  }

  #subtitleWindow: BrowserWindow | null = null;
  #subtitleLoading: Promise<void> | null = null;

  /**
   * The subtitle bar over the game: a transparent, click-through strip at the bottom centre of the primary screen, above other windows (the game
   * must run windowed or borderless; an exclusive full-screen game covers every window). It never takes focus.
   */
  async showSubtitle(line: { text: string; tone?: string; at: string }) {
    if (!this.#subtitleWindow || this.#subtitleWindow.isDestroyed()) {
      if (!this.#subtitleLoading) {
        this.#subtitleLoading = (async () => {
          const { screen } = await import("electron");
          const area = screen.getPrimaryDisplay().workArea;
          const width = Math.min(1100, Math.round(area.width * 0.7));
          const height = 96;
          const window = new BrowserWindow({
            width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height - height - 48),
            frame: false, transparent: true, backgroundColor: "#00000000", show: false, resizable: false, movable: false, focusable: false,
            skipTaskbar: true, alwaysOnTop: true, hasShadow: false, autoHideMenuBar: true,
            webPreferences: { nodeIntegration: true, webSecurity: false, preload: this.#environment.preloadEntry },
          });
          window.setAlwaysOnTop(true, "screen-saver");
          window.setIgnoreMouseEvents(true);
          window.on("closed", () => { this.#subtitleWindow = null; });
          this.#subtitleWindow = window;
          if (!app.isPackaged && this.#environment.rendererDevServer) {
            const url = new URL(this.#environment.rendererDevServer);
            url.searchParams.set("ai-mayor-subtitle", "1");
            await window.loadURL(url.toString());
          } else {
            await window.loadFile(this.#environment.rendererEntry, { search: "ai-mayor-subtitle=1" });
          }
          window.showInactive();
        })().finally(() => { this.#subtitleLoading = null; });
      }
      await this.#subtitleLoading;
    }
    const window = this.#subtitleWindow;
    if (!window || window.isDestroyed()) return;
    if (!window.isVisible()) window.showInactive();
    window.webContents.send("ai-mayor-subtitle", line);
  }

  hideSubtitle() {
    if (this.#subtitleWindow && !this.#subtitleWindow.isDestroyed()) this.#subtitleWindow.hide();
  }

  #gameBarWindow: BrowserWindow | null = null;
  #gameBarLoading: Promise<void> | null = null;

  /**
   * The bar over the game: a small, half-transparent input and a pause button, always on top (windowed or borderless game), so the player speaks to the
   * Mayor without leaving the game. It takes focus only while the player types (the bar gives it back after a send or Esc). Draggable; `onMoved` keeps where
   * the player put it.
   */
  async showGameBar(at: { x: number; y: number } | null, onMoved: (at: { x: number; y: number }) => void) {
    if (!this.#gameBarWindow || this.#gameBarWindow.isDestroyed()) {
      if (!this.#gameBarLoading) {
        this.#gameBarLoading = (async () => {
          const { screen } = await import("electron");
          const area = screen.getPrimaryDisplay().workArea;
          // Folded: a small round button; unfolded: a white strip (`layoutGameBar`). Default spot: the left edge, a third of the way down (clear of the game's own bars).
          const width = GAME_BAR_BUTTON;
          const height = GAME_BAR_BUTTON;
          const inside = at && at.x >= area.x && at.x <= area.x + area.width - 40 && at.y >= area.y && at.y <= area.y + area.height - 40;
          const window = new BrowserWindow({
            width, height, x: inside ? at!.x : Math.round(area.x + 10), y: inside ? at!.y : Math.round(area.y + area.height * 0.32),
            frame: false, transparent: true, backgroundColor: "#00000000", show: false, resizable: false, movable: true, focusable: true, minimizable: false,
            maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, autoHideMenuBar: true,
            webPreferences: { nodeIntegration: true, webSecurity: false, preload: this.#environment.preloadEntry },
          });
          window.setAlwaysOnTop(true, "screen-saver");
          this.#gameBarMoved = onMoved;
          window.on("closed", () => { this.#gameBarWindow = null; });
          this.#gameBarWindow = window;
          if (!app.isPackaged && this.#environment.rendererDevServer) {
            const url = new URL(this.#environment.rendererDevServer);
            url.searchParams.set("ai-mayor-gamebar", "1");
            await window.loadURL(url.toString());
          } else {
            await window.loadFile(this.#environment.rendererEntry, { search: "ai-mayor-gamebar=1" });
          }
          window.showInactive();
        })().finally(() => { this.#gameBarLoading = null; });
      }
      await this.#gameBarLoading;
    }
    const window = this.#gameBarWindow;
    if (window && !window.isDestroyed() && !window.isVisible()) window.showInactive();
  }

  sendToGameBar(channel: string, payload: unknown) {
    if (this.#gameBarWindow && !this.#gameBarWindow.isDestroyed()) this.#gameBarWindow.webContents.send(channel, payload);
  }

  #gameBarMoved: ((at: { x: number; y: number }) => void) | null = null;

  /** Fold to the button or unfold to the strip (wider, plus a line for the answer); unfolding takes the focus so the player can type at once. */
  layoutGameBar(open: boolean, withReply: boolean) {
    const window = this.#gameBarWindow;
    if (!window || window.isDestroyed()) return;
    const [x, y] = window.getPosition();
    window.setBounds({ x: x!, y: y!, width: open ? GAME_BAR_STRIP_WIDTH : GAME_BAR_BUTTON, height: open ? (withReply ? 96 : 60) : GAME_BAR_BUTTON });
    if (open) window.focus(); else window.blur();
  }

  /** The player drags the button: the window follows, and its place is kept. */
  moveGameBarBy(dx: number, dy: number) {
    const window = this.#gameBarWindow;
    if (!window || window.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = window.getPosition();
    window.setPosition(Math.round(x! + dx), Math.round(y! + dy));
    this.#gameBarMoved?.({ x: Math.round(x! + dx), y: Math.round(y! + dy) });
  }

  /** Give the focus back (to the game, the window the player was in) after a send or Esc. */
  releaseGameBar() {
    if (this.#gameBarWindow && !this.#gameBarWindow.isDestroyed()) this.#gameBarWindow.blur();
  }

  hideGameBar() {
    if (this.#gameBarWindow && !this.#gameBarWindow.isDestroyed()) this.#gameBarWindow.hide();
  }

  closeOverlay() {
    if (this.#overlayWindow && !this.#overlayWindow.isDestroyed()) this.#overlayWindow.close();
  }

  hideOverlay() {
    if (this.#overlayWindow && !this.#overlayWindow.isDestroyed()) this.#overlayWindow.hide();
  }

  async toggleOverlay() {
    if (this.#overlayWindow && !this.#overlayWindow.isDestroyed() && this.#overlayWindow.isVisible()) {
      this.#overlayWindow.hide();
      return;
    }
    await this.showOverlay();
  }

  resizeOverlay(width: number, height: number) {
    if (!this.#overlayWindow || this.#overlayWindow.isDestroyed()) return;
    const bounds = this.#overlayWindow.getBounds();
    this.#overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
    this.#saveOverlayBounds(this.#overlayWindow);
  }

  getOverlaySettings() {
    return normalizeAiMayorOverlaySettings(this.#overlayStore.get("settings"));
  }

  setOverlaySettings(settings: Partial<AiMayorOverlaySettings>) {
    const next = normalizeAiMayorOverlaySettings({ ...this.getOverlaySettings(), ...settings });
    this.#overlayStore.set("settings", next);
    this.#overlayWindow?.setAlwaysOnTop(next.alwaysOnTop, "floating");
    return next;
  }

  resetOverlayPosition() {
    const display = screen.getPrimaryDisplay();
    const bounds = this.#overlayWindow?.getBounds() ?? { width: 390, height: 560 };
    const { x, y, width, height } = display.workArea;
    const nextBounds = {
      x: Math.round(x + (width - bounds.width) / 2),
      y: Math.round(y + (height - bounds.height) / 2),
      width: bounds.width,
      height: bounds.height,
    };
    this.#overlayStore.set("bounds", nextBounds);
    this.#overlayWindow?.setBounds(nextBounds);
  }

  isOverlayVisible() {
    return Boolean(this.#overlayWindow && !this.#overlayWindow.isDestroyed() && this.#overlayWindow.isVisible());
  }

  #saveOverlayBounds(window: BrowserWindow) {
    if (!window.isDestroyed()) this.#overlayStore.set("bounds", window.getBounds());
  }
}

export namespace Renderer {
  /**
   * Renderer state definition
   * Contains window instance and system theme related information
   */
  export type State = {
    /**
     * Browser window instance
     * Null if window is not created or has been closed
     */
    window: Electron.BrowserWindow | null;
    /**
     * Whether dark theme should be used
     * Determined based on system theme settings
     */
    shouldUseDarkColors: boolean;
    /**
     * Whether high contrast theme should be used
     * Determined based on system theme settings
     */
    shouldUseHighContrastColors: boolean;
    /**
     * Whether inverted color scheme should be used
     * Determined based on system theme settings
     */
    shouldUseInvertedColorScheme: boolean;
    /**
     * Whether in forced colors mode
     * Determined based on system theme settings
     */
    inForcedColorsMode: boolean;
    /**
     * Whether reduced transparency is preferred
     * Determined based on system theme settings
     */
    prefersReducedTransparency: boolean;
    /**
     * System preferred language list
     * Array of language codes sorted by priority
     */
    locale: string;
    /**
     * Localization country code
     * Represents the country/region part of the current locale setting
     */
    localeCountryCode: string;
    /**
     * System preferred language list
     * Array of language codes sorted by priority
     */
    preferredSystemLanguages: string[];
    /**
     * System localization settings
     * Represents the complete localization information of the system
     */
    systemLocale: string;
  };
}
