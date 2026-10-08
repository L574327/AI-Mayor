/* eslint global-require: off, no-console: off, promise/always-return: off */
// import 'v8-compile-cache';

import "@/main/services/ai-mayor/brand/user-data";
import "@/main/setup";

import crypto, { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path, { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { asError } from "catch-unknown";
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  nativeImage,
  nativeTheme,
  safeStorage,
  shell,
  Tray,
} from "electron";
import Store from "electron-store";
import { ensureDirSync } from "fs-extra";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";
import type { IMCPServer } from "types/mcp";
import { isValidMCPServer, isValidMCPServerKey } from "utils/validators";
import { KNOWLEDGE_IMPORT_MAX_FILE_SIZE, SUPPORTED_IMAGE_TYPES } from "@/consts";
import { DeepLinkHandlerBridge } from "@/main/bridge/deep-link-handler-bridge";
import { DocumentEmbedderBridge } from "@/main/bridge/document-embedder-bridge";
import { DocumentManagerBridge } from "@/main/bridge/document-manager-bridge";
import { DownloaderBridge } from "@/main/bridge/downloader-bridge";
import { EmbedderBridge } from "@/main/bridge/embedder-bridge";
import { EncryptorBridge } from "@/main/bridge/encryptor-bridge";
import { LegacyDataMigratorBridge } from "@/main/bridge/legacy-data-migrator-bridge";
import { MCPConnectionsManagerBridge } from "@/main/bridge/mcp-connections-manager-bridge";
import { MCPServersManagerBridge } from "@/main/bridge/mcp-servers-manager-bridge";
import { PromptManagerBridge } from "@/main/bridge/prompt-manager-bridge";
import { RendererBridge } from "@/main/bridge/renderer-bridge";
import { SettingsBridge } from "@/main/bridge/settings-bridge";
import { UpdaterBridge } from "@/main/bridge/updater-bridge";
import { Database } from "@/main/database";
import { Environment } from "@/main/environment";
import { Container } from "@/main/internal/container";
import { createMainMayorPorts } from "@/main/services/ai-mayor/main-adapters";
import { parseInstruction } from "@/main/services/ai-mayor/host/intent-parser";
import { DEFAULT_MANIFEST_URL, hashMatches, judgeUpdate, parseManifest, type UpdateVerdict } from "@/main/services/ai-mayor/host/update-check";
import type { Instruction } from "@/main/services/ai-mayor/host/intent-lowering";
import { buildPrompt, checkReply, interpretViaApi, newRequestCode } from "@/main/services/ai-mayor/host/semantic-frontend";
import { createFileUsageMeter, DEFAULT_DAILY_TOKEN_LIMIT } from "@/main/services/ai-mayor/host/ai-usage";
import { type ProviderConfig, type ProviderPreset, queryBalance, resolveProvider, setUsageMeter } from "@/main/services/ai-mayor/host/ai-providers";
import { installBridgeMod, productSupervisor, resolveProductPaths } from "@/main/services/ai-mayor/host/product-host";
import type { TakeoverPermissions } from "@/main/services/ai-mayor/host/protocol";
import { MayorRuntime } from "@/main/services/ai-mayor/runtime";
import { createCanonicalDurableStateStorage } from "@/main/services/ai-mayor/v2/durable-storage";
import type { MayorCommand, StartMayorSessionOptions } from "@/main/services/ai-mayor/types";
import {
  AI_MAYOR_OVERLAY_SHORTCUT,
  AI_MAYOR_PRODUCT_MODE_ENV,
  hasAiMayorCityObservationTools,
  isAiMayorProductMode,
} from "@/main/services/ai-mayor-product-mode";
import { DeepLinkHandler } from "@/main/services/deep-link-handler";
import { fetchDeepSeekBalance } from "@/main/services/deepseek-balance";
import { DocumentEmbedder } from "@/main/services/document-embedder";
import { DocumentExtractor } from "@/main/services/document-extractor";
import { DocumentManager } from "@/main/services/document-manager";
import { Downloader } from "@/main/services/downloader";
import { Embedder } from "@/main/services/embedder";
import { Encryptor } from "@/main/services/encryptor";
import { LegacyDataMigrator } from "@/main/services/legacy-data-migrator";
import { LegacyServersConfigLoader } from "@/main/services/legacy-servers-config-loader";
import { LegacyVectorDatabaseLoader } from "@/main/services/legacy-vector-database-loader";
import { Logger } from "@/main/services/logger";
import { MCPCompletionHandler } from "@/main/services/mcp-completion-handler";
import { MCPConnectionsManager } from "@/main/services/mcp-connections-manager";
import { MCPContentConverter } from "@/main/services/mcp-content-converter";
import { MCPPromptsManager } from "@/main/services/mcp-prompts-manager";
import { MCPResourcesManager } from "@/main/services/mcp-resources-manager";
import { MCPServersManager } from "@/main/services/mcp-servers-manager";
import { MCPToolsManager } from "@/main/services/mcp-tools-manager";
import { PromptManager } from "@/main/services/prompt-manager";
import { Renderer } from "@/main/services/renderer";
import { Settings } from "@/main/services/settings";
import { ShutdownCoordinator } from "@/main/services/shutdown-coordinator";
import { Updater } from "@/main/services/updater";
import { URLParser } from "@/main/services/url-parser";
import ModuleContext from "./mcp";
import { DocumentLoader } from "./next/document-loader/DocumentLoader";
import { initLegacyDatabase } from "./sqlite";
import { decodeBase64, getFileInfo, getFileType } from "./util";

Container.singleton(Environment, () => {
  let userDataFolder = app.getPath("userData");

  if (!app.isPackaged) {
    if (process.env.SOURCE_ROOT) {
      userDataFolder = join(app.getPath("userData"), "__DEV__");
    }
  }

  const env: Environment = {
    mode: app.isPackaged ? "production" : "development",
    cryptoSecret: process.env.CRYPTO_SECRET || "",
    rendererDevServer: process.env.RENDERER_DEV_SERVER || "",
    rendererEntry: resolve(__dirname, "./renderer/index.html"),
    preloadEntry: resolve(__dirname, "./preload.js"),
    assetsFolder: resolve(__dirname, "./assets"),
    embedderCacheFolder: resolve(userDataFolder, "Embedding/Cache"),
    embedderModelsFolder: resolve(userDataFolder, "Embedding/Models"),
    storiesFolder: resolve(userDataFolder, "Stories"),
    databaseDataFolder: resolve(userDataFolder, "Database"),
    databaseMigrationsFolder: resolve(__dirname, "./migrations"),
    userDataFolder,
    legacyDatabasePath: resolve(app.getPath("userData"), "./legacy.db"),
    legacyVectorDatabaseFolder: resolve(app.getPath("userData"), "./lancedb.db"),
    legacyMCPConfigPath: resolve(app.getPath("userData"), "./mcp.json"),
    legacyProviderConfigPath: resolve(app.getPath("userData"), "./config.json"),
    sentryDsn: process.env.SENTRY_DSN,
    sentryKey: process.env.SENTRY_KEY,
    axiomToken: process.env.AXIOM_TOKEN,
    axiomOrgId: process.env.AXIOM_ORG_ID,
    logsFolder: resolve(userDataFolder, "Logs"),
    deepLinkProtocol: app.isPackaged ? "app.aimayor" : "dev.aimayor",
  };

  ensureDirSync(env.embedderCacheFolder);
  ensureDirSync(env.embedderModelsFolder);
  ensureDirSync(env.storiesFolder);
  ensureDirSync(env.databaseDataFolder);
  ensureDirSync(env.logsFolder);

  return env;
});

Container.singleton(Logger, () => new Logger());
Container.singleton(Encryptor, () => new Encryptor());
Container.singleton(EncryptorBridge, () => new EncryptorBridge());
Container.singleton(Renderer, () => new Renderer());
Container.singleton(RendererBridge, () => new RendererBridge());
Container.singleton(Updater, () => new Updater());
Container.singleton(UpdaterBridge, () => new UpdaterBridge());
Container.singleton(Downloader, () => new Downloader());
Container.singleton(DownloaderBridge, () => new DownloaderBridge());
Container.singleton(Settings, () => new Settings());
Container.singleton(SettingsBridge, () => new SettingsBridge());
Container.singleton(Embedder, () => new Embedder());
Container.singleton(EmbedderBridge, () => new EmbedderBridge());
Container.singleton(Database, () => new Database());
Container.singleton(LegacyDataMigrator, () => new LegacyDataMigrator());
Container.singleton(LegacyDataMigratorBridge, () => new LegacyDataMigratorBridge());
Container.singleton(LegacyVectorDatabaseLoader, () => new LegacyVectorDatabaseLoader());
Container.singleton(LegacyServersConfigLoader, () => new LegacyServersConfigLoader());
Container.singleton(DocumentManager, () => new DocumentManager());
Container.singleton(DocumentManagerBridge, () => new DocumentManagerBridge());
Container.singleton(DocumentExtractor, () => new DocumentExtractor());
Container.singleton(DocumentEmbedder, () => new DocumentEmbedder());
Container.singleton(DocumentEmbedderBridge, () => new DocumentEmbedderBridge());
Container.singleton(PromptManager, () => new PromptManager());
Container.singleton(PromptManagerBridge, () => new PromptManagerBridge());
Container.singleton(URLParser, () => new URLParser());
Container.singleton(MCPContentConverter, () => new MCPContentConverter());
Container.singleton(MCPServersManager, () => new MCPServersManager());
Container.singleton(MCPConnectionsManager, () => new MCPConnectionsManager());
Container.singleton(MCPToolsManager, () => new MCPToolsManager());
Container.singleton(MCPPromptsManager, () => new MCPPromptsManager());
Container.singleton(MCPResourcesManager, () => new MCPResourcesManager());
Container.singleton(MCPCompletionHandler, () => new MCPCompletionHandler());
Container.singleton(MCPConnectionsManagerBridge, () => new MCPConnectionsManagerBridge());
Container.singleton(MCPServersManagerBridge, () => new MCPServersManagerBridge());
Container.singleton(DeepLinkHandler, () => new DeepLinkHandler());
Container.singleton(DeepLinkHandlerBridge, () => new DeepLinkHandlerBridge());
Container.singleton(ShutdownCoordinator, () => new ShutdownCoordinator());

// init crash reporter
(() => {
  const logger = Container.inject(Logger).scope("Main:InitCrashReporter");
  const env = Container.inject(Environment);

  if (env.mode === "production" && env.sentryDsn && env.sentryKey) {
    crashReporter.start({
      submitURL: `${env.sentryDsn}/minidump/?sentry_key=${env.sentryKey}`,
    });

    logger.debug("CrashReporter initialized");
  }
})();

const mcp = new ModuleContext();
const store = new Store();
// Keep V2 durability independent from Electron's default app name. In
// development, direct Electron launches otherwise resolve to the `Electron`
// userData profile while packaged launches resolve to the product folder.
const v2DurableStateStorage = createCanonicalDurableStateStorage(app.getPath("appData"));
// The Brain's own narration. Every cycle re-reads the world and reports what it
// concluded, and an operator watching a long unattended run has no other way to
// tell "still working on it" apart from "quietly stopped". Logged only when the
// status actually changes, so a busy loop does not flood the log.
let lastLoggedBrainStatus: string | null = null;
const mayorRuntime = new MayorRuntime(
  createMainMayorPorts({
    getProvider: () =>
      (store.get("providers", []) as Array<{ name?: string; apiBase?: string; apiKey?: string; proxy?: string }>).find(
        (candidate) => candidate.name === "DeepSeek",
      ),
    getToolsManager: () => Container.inject(MCPToolsManager),
    durableStateStorage: v2DurableStateStorage,
    emit: (event, state) => {
      getMainWindow()?.webContents.send(`ai-mayor-${event}`, state);
      // The overlay is its own window and is the one the player actually sees.
      // Product mode never shows the main chat window, so sending the session
      // events there alone meant the Mayor narrated to nobody.
      Container.inject(Renderer).broadcastToOverlay(`ai-mayor-${event}`, state);
      if (event !== "tick" && event !== "status") return;
      const session = state as { lastStatus?: unknown; tickCount?: unknown; status?: unknown } | null;
      const status = typeof session?.lastStatus === "string" ? session.lastStatus : null;
      if (!status || status === lastLoggedBrainStatus) return;
      lastLoggedBrainStatus = status;
      Container.inject(Logger).scope("AI Mayor").info("V2 Brain status", {
        tick: session?.tickCount ?? null, sessionStatus: session?.status ?? null, lastStatus: status,
      });
    },
    emitMayorCommentary: (line) => {
      if (!Container.inject(Renderer).getOverlaySettings().commentaryEnabled) return;
      getMainWindow()?.webContents.send("ai-mayor-commentary", line);
      Container.inject(Renderer).broadcastToOverlay("ai-mayor-commentary", line);
    },
  }),
);

Container.inject(ShutdownCoordinator).register(async () => {
  if (mayorRuntime.getState()?.status === "running") await mayorRuntime.stop("AI Mayor is shutting down");
});

let rendererReady = false;
let pendingInstallTool: any = null;
let aiMayorProductAutonomyStartPending = false;

const protocol = app.isPackaged ? "app.aimayor" : "dev.aimayor";
// The installed app IS the AI Mayor product; the chat client underneath is for development (or AI_MAYOR_CHAT_CLIENT=1).
const AI_MAYOR_PRODUCT_MODE = isAiMayorProductMode() || (app.isPackaged && process.env.AI_MAYOR_CHAT_CLIENT !== "1");
let aiMayorTray: Tray | null = null;
if (AI_MAYOR_PRODUCT_MODE) process.env[AI_MAYOR_PRODUCT_MODE_ENV] = "1";

const startProductAutonomyWhenCityToolsAreReady = () => {
  if (!AI_MAYOR_PRODUCT_MODE) return;
  const toolsManager = Container.inject(MCPToolsManager);
  Container.inject(MCPConnectionsManager).emitter.on("server-connected", ({ connection }) => {
    Container.inject(Logger).scope("AI Mayor").info("Product MCP server capability state", {
      toolsCapability: !!connection.capabilities.tools,
      toolListChanged: !!connection.capabilities.tools?.listChanged,
    });
  });
  const tryStart = () => {
    if (aiMayorProductAutonomyStartPending || mayorRuntime.getState()?.status === "running") return;
    const availableTools = Array.from(toolsManager.state.collections.values())
      .filter((collection) => collection.status === "loaded")
      .flatMap((collection) => collection.tools.map((tool) => tool.name));
    // A generic connected MCP server is insufficient: wait for both city
    // observation contracts before the product enters the native execution path.
    if (!hasAiMayorCityObservationTools(availableTools)) {
      Container.inject(Logger).scope("AI Mayor").info("Product autonomy waiting for city observation tools", {
        loadedToolCount: availableTools.length,
        gameStateAvailable: availableTools.includes("cs2_game_state"),
        mayorSnapshotAvailable: availableTools.includes("cs2_mayor_snapshot"),
      });
      return;
    }
    aiMayorProductAutonomyStartPending = true;
    try {
      // The Brain IS the product's driver: it keeps observing, deciding and
      // building until the session is stopped. One bounded cycle would leave the
      // city frozen the moment that cycle ended, which is not a mayor.
      mayorRuntime.start({
        goal: "Build an occupied starter city and autonomously expand it",
        maxSessionSpend: 0.2,
        minimumBalance: 1,
        continuous: true,
        tickDelayMs: Container.inject(Renderer).getOverlaySettings().mayorSpeed === "fast" ? 100 : 1_000,
        speed: Container.inject(Renderer).getOverlaySettings().mayorSpeed,
        decisionMode: "local",
      });
      Container.inject(Logger).scope("AI Mayor").info("Product V2 Brain session started", {
        decisionMode: "local", continuous: true,
      });
      void mayorRuntime.continuousRun().then(() => {
        const session = mayorRuntime.getState();
        Container.inject(Logger).scope("AI Mayor").info("Product V2 Brain loop ended", {
          status: session?.status ?? null,
          stopReason: session?.stopReason ?? null,
          lastStatus: session?.lastStatus ?? null,
        });
      }).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        Container.inject(Logger).scope("AI Mayor").error("Product V2 Brain loop failed", error);
        void mayorRuntime.stop(`V2 Brain blocked: ${reason}`).catch(() => undefined);
      }).finally(() => {
        aiMayorProductAutonomyStartPending = false;
      });
    } catch (error) {
      aiMayorProductAutonomyStartPending = false;
      Container.inject(Logger).scope("AI Mayor").error("Product V2 Brain session could not start", error);
    }
  };
  toolsManager.subscribe((_previous, next) => {
    const availableTools = Array.from(next.collections.values())
      .filter((collection) => collection.status === "loaded")
      .flatMap((collection) => collection.tools.map((tool) => tool.name));
    Container.inject(Logger).scope("AI Mayor").info("Product MCP tool collection state", {
      loadedToolCount: availableTools.length,
      loadedCollectionCount: Array.from(next.collections.values()).filter((collection) => collection.status === "loaded").length,
      observationToolsAvailable: hasAiMayorCityObservationTools(availableTools),
    });
    if (hasAiMayorCityObservationTools(availableTools)) tryStart();
  });
  tryStart();
};

Container.inject(DeepLinkHandler).setAsDefaultProtocolClient();

const getMainWindow = () => {
  return Container.inject(Renderer).state.window;
};

const onDeepLink = (link: string) => {
  const logger = Container.inject(Logger).scope("Main:OnDeepLink");
  const deepLinkHandler = Container.inject(DeepLinkHandler);

  deepLinkHandler.parse(link);

  const { host, hash } = new URL(link);
  if (host === "login-callback") {
    const params = new URLSearchParams(hash.substring(1));
    getMainWindow()?.webContents.send("sign-in", {
      accessToken: params.get("access_token"),
      refreshToken: params.get("refresh_token"),
    });
  } else if (host === "install-tool") {
    const base64 = hash.substring(1);
    const data = decodeBase64(base64);
    if (data) {
      try {
        const json = JSON.parse(data);
        if (isValidMCPServer(json) && isValidMCPServerKey(json.name)) {
          if (mcp.isServerExist(json.name)) {
            const dialogOpts = {
              type: "info",
              buttons: ["Ok"],
              title: "Server Exists",
              message: `The server ${json.name} already exists`,
            } as MessageBoxOptions;
            dialog.showMessageBox(dialogOpts);
            return;
          }
          if (!rendererReady) {
            pendingInstallTool = json;
          } else {
            getMainWindow()?.webContents.send("install-tool", json);
          }
          return;
        }
        const dialogOpts = {
          type: "error",
          buttons: ["Ok"],
          title: "Install Tool Failed",
          message: "Invalid Format, please check the link and try again.",
        } as MessageBoxOptions;
        dialog.showMessageBox(dialogOpts);
      } catch (error) {
        console.error(error);
        const dialogOpts = {
          type: "error",
          buttons: ["Ok"],
          title: "Install Tool Failed",
          message: "Invalid JSON, please check the link and try again.",
        } as MessageBoxOptions;
        dialog.showMessageBox(dialogOpts);
      }
    } else {
      const dialogOpts = {
        type: "error",
        buttons: ["Ok"],
        title: "Install Tool Failed",
        message: "Invalid base64 data, please check the link and try again.",
      } as MessageBoxOptions;
      dialog.showMessageBox(dialogOpts);
    }
  } else {
    logger.capture(`Invalid deeplink, ${link}`);
  }
};

const openSafeExternal = (url: string) => {
  const logger = Container.inject(Logger).scope("Main:OpenSafeExternal");
  try {
    const parsedUrl = new URL(url);
    const allowedProtocols = ["http:", "https:", "mailto:"];
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      logger.warning(`Blocked unsafe protocol: ${parsedUrl.protocol}`);
      return;
    }
    shell.openExternal(url);
  } catch (e) {
    logger.warning("Invalid URL:", url);
  }
};

const handleDeepLinkOnColdStart = () => {
  // windows & linux
  const deepLinkingUrl = process.argv.length > 1 ? process.argv[process.argv.length - 1] : null;
  if (deepLinkingUrl && deepLinkingUrl.startsWith(`${protocol}://`)) {
    app.once("ready", () => {
      onDeepLink(deepLinkingUrl);
    });
  }
  // macOS
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady()) {
      onDeepLink(url);
    } else {
      app.once("ready", () => {
        onDeepLink(url);
      });
    }
  });
};
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_, commandLine) => {
    Container.inject(Renderer)
      .focus()
      .catch(() => {
        // ignore
      });
    const link = commandLine.pop();
    if (link) {
      onDeepLink(link);
    }
  });

  app
    .whenReady()
    .then(async () => {
      const logger = Container.inject(Logger).scope("Main:WhenReady");
      const environment = Container.inject(Environment);
      const legacySqliteDatabase = initLegacyDatabase();

      logger.info("User data folder:", environment.userDataFolder);

      Container.inject(EncryptorBridge).expose(ipcMain);
      Container.inject(UpdaterBridge).expose(ipcMain);
      Container.inject(RendererBridge).expose(ipcMain);
      Container.inject(DownloaderBridge).expose(ipcMain);
      Container.inject(SettingsBridge).expose(ipcMain);
      Container.inject(EmbedderBridge).expose(ipcMain);
      Container.inject(DocumentManagerBridge).expose(ipcMain);
      Container.inject(DocumentEmbedderBridge).expose(ipcMain);
      Container.inject(LegacyDataMigratorBridge).expose(ipcMain);
      Container.inject(PromptManagerBridge).expose(ipcMain);
      Container.inject(MCPConnectionsManagerBridge).expose(ipcMain);
      Container.inject(MCPServersManagerBridge).expose(ipcMain);
      Container.inject(DeepLinkHandlerBridge).expose(ipcMain);

      await Container.inject(Database).init();
      await Container.inject(Renderer).init();
      if (AI_MAYOR_PRODUCT_MODE) setupAiMayorProductMode();
      if (AI_MAYOR_PRODUCT_MODE) {
        // The console is a working window: room for the city panel and the Mayor's report side by side.
        const consoleWindow = getMainWindow();
        consoleWindow?.setTitle("AI Mayor");
        // The window buttons sit on the console's own dark surface.
        try { consoleWindow?.setTitleBarOverlay({ color: "#f4f6fa", symbolColor: "#4a5568", height: 32 }); } catch { /* no overlay on this platform */ }
        consoleWindow?.setMinimumSize(980, 680);
        if (consoleWindow && consoleWindow.getSize()[0] < 1280) { consoleWindow.setSize(1320, 880); consoleWindow.center(); }
      }
      // The product's Mayor is the supervised engine process (`host/`); the old in-process start stays for development only.
      if (process.env.AI_MAYOR_LEGACY_IN_PROCESS === "1") startProductAutonomyWhenCityToolsAreReady();

      Container.inject(Embedder)
        .init()
        .catch((error) => {
          logger.error("Failed to init embedder:", error);
        });

      Container.inject(Updater)
        .checkForUpdates()
        .catch((error) => {
          logger.error("Failed to check for updates:", error);
        });

      Container.inject(DocumentEmbedder)
        .init()
        .catch((err) => {
          logger.error("Failed to init document embedder:", err);
        });

      Container.inject(LegacyDataMigrator)
        .migrate(legacySqliteDatabase)
        .catch((error) => {
          logger.error("Failed to migrate legacy data:", error);
        });

      Container.inject(MCPServersManager)
        .init()
        .catch((error) => {
          logger.error("Failed to init MCP servers manager:", error);
        });

      Container.inject(MCPConnectionsManager)
        .init()
        .catch((error) => {
          logger.error("Failed to init MCP connections manager:", error);
        });

      app.on("activate", () => {
        const logger = Container.inject(Logger).scope("Main:AppOnActivate");

        Container.inject(Renderer).focus().catch(
          (error) => {
            logger.error("Failed to focus main window:", error);
          },
        );
      });

      app.on("window-all-closed", () => {
        logger.flush();

        // Respect the OSX convention of having the application in memory even
        // after all windows have been closed
        if (process.platform !== "darwin" && !AI_MAYOR_PRODUCT_MODE) {
          app.quit();
          process.exit(0);
        }
      });

      app.on("before-quit", async () => {
        const logger = Container.inject(Logger).scope("Main:AppOnBeforeQuit");
        ipcMain.removeAllListeners();
        globalShortcut.unregister(AI_MAYOR_OVERLAY_SHORTCUT);
        mayorConsoleSupervisor?.dispose();
        aiMayorTray?.destroy();
        aiMayorTray = null;
        try {
          await mcp.close();
        } catch (error) {
          logger.error("Failed to close MCP:", error);
        }
        process.stdin.destroy();
      });

      app.on("certificate-error", (event, _webContents, _url, _error, _certificate, callback) => {
        // 允许私有证书
        event.preventDefault();
        callback(true);
      });

      logger.track({ event: "launch" });
    })
    .catch((error) => {
      const logger = Container.inject(Logger).scope("Main:WhenReadyError");

      logger.capture(error, {
        reason: "Failed to initialize main process",
      });

      dialog.showErrorBox(
        "Application Launch Failed",
        [
          "The application could not start correctly.",
          "",
          "Please try restarting the app. If the problem persists,",
          "contact support and provide the error logs.",
        ].join("\n"),
      );

      app.quit();
    });
  handleDeepLinkOnColdStart();
}

// IPCs

ipcMain.on("install-tool-listener-ready", () => {
  rendererReady = true;
  if (pendingInstallTool !== null) {
    getMainWindow()?.webContents.send("install-tool", pendingInstallTool);
    pendingInstallTool = null;
  }
});

const activeRequests = new Map<string, AbortController>();

ipcMain.handle("deepseek-balance", async () => {
  const providers = store.get("providers", []) as Array<{
    name?: string;
    apiBase?: string;
    apiKey?: string;
    proxy?: string;
  }>;
  const provider = providers.find((candidate) => candidate.name === "DeepSeek");
  if (!provider?.apiKey?.trim()) {
    throw new Error("DeepSeek API key is not configured");
  }

  return fetchDeepSeekBalance({
    apiBase: provider.apiBase?.trim() || "https://api.deepseek.com/v1",
    apiKey: provider.apiKey,
    proxy: provider.proxy,
  });
});

ipcMain.handle("ai-mayor-start", (_, options: StartMayorSessionOptions) => {
  // Product sessions always enter the deterministic V2 dispatch route. Legacy
  // LLM-action modes remain readable for stored session compatibility only.
  // The session drives the Brain loop itself rather than a single bounded cycle.
  const settings = Container.inject(Renderer).getOverlaySettings();
  const state = mayorRuntime.start({ ...options, decisionMode: "local", continuous: true,
    speed: options.speed ?? settings.mayorSpeed,
    tickDelayMs: options.tickDelayMs ?? (settings.mayorSpeed === "fast" ? 100 : 1_000),
  });
  void mayorRuntime.continuousRun().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    Container.inject(Logger).scope("AI Mayor").error("V2 Brain loop failed", error);
    void mayorRuntime.stop(`V2 Brain blocked: ${reason}`).catch(() => undefined);
  });
  return state;
});
ipcMain.handle("ai-mayor-stop", (_, reason?: string) => mayorRuntime.stop(reason));
ipcMain.handle("ai-mayor-focus-activity", () => mayorRuntime.focusActivityTarget());
ipcMain.handle("ai-mayor-production-readiness", () => mayorRuntime.productionRuntimeReadiness());
ipcMain.handle("ai-mayor-k05-preflight", () => mayorRuntime.productionK05Preflight());
ipcMain.handle("ai-mayor-state", () => mayorRuntime.getState());
ipcMain.handle("ai-mayor-session-status", () => mayorRuntime.getSessionStatus());
ipcMain.handle("ai-mayor-command", (_, command: Omit<MayorCommand, "createdAt">) =>
  mayorRuntime.setPendingUserCommand(command),
);
ipcMain.handle("ai-mayor-overlay-show", () => Container.inject(Renderer).showOverlay());
ipcMain.handle("ai-mayor-overlay-close", () => Container.inject(Renderer).closeOverlay());
ipcMain.handle("ai-mayor-overlay-hide", () => Container.inject(Renderer).hideOverlay());
ipcMain.handle("ai-mayor-overlay-collapse", () => Container.inject(Renderer).resizeOverlay(390, 72));
ipcMain.handle("ai-mayor-overlay-expand", () => Container.inject(Renderer).resizeOverlay(390, 560));
ipcMain.handle("ai-mayor-overlay-settings", () => Container.inject(Renderer).getOverlaySettings());
ipcMain.handle("ai-mayor-overlay-settings-set", (_, settings) =>
  Container.inject(Renderer).setOverlaySettings(settings),
);
ipcMain.handle("ai-mayor-overlay-reset-position", () => Container.inject(Renderer).resetOverlayPosition());
ipcMain.handle("ai-mayor-readiness", async () => {
  try {
    const listed = await Container.inject(MCPToolsManager).legacyList();
    return { status: listed.tools.length > 0 ? "ready" : "offline", cityLoaded: listed.tools.length > 0 };
  } catch {
    return { status: "offline", cityLoaded: false };
  }
});
ipcMain.handle("ai-mayor-copy-diagnostics", async () => {
  const renderer = Container.inject(Renderer);
  const state = mayorRuntime.getState();
  const readiness = await (async () => {
    try {
      const listed = await Container.inject(MCPToolsManager).legacyList();
      return { status: listed.tools.length > 0 ? "ready" : "offline", cityLoaded: listed.tools.length > 0 };
    } catch {
      return { status: "offline", cityLoaded: false };
    }
  })();
  const runtime = state?.status === "running" ? "running" : state ? "paused" : "idle";
  const text = [
    `AI Mayor version: ${app.getVersion()}`,
    `Product Mode: ${AI_MAYOR_PRODUCT_MODE}`,
    `Platform: ${process.platform}`,
    `Overlay: ${renderer.isOverlayVisible() ? "visible" : "hidden"}`,
    `Game connection: ${readiness.status}`,
    `City loaded: ${readiness.cityLoaded ? "yes" : "no"}`,
    `Mayor Runtime: ${runtime}`,
    "Generated by AI Mayor Diagnostics",
  ].join("\n");
  clipboard.writeText(text);
  return { copied: true };
});

// ---- The product console (host/): one supervised Mayor engine, the console window shows it -------------------------------------------------
let mayorConsoleSupervisor: ReturnType<typeof productSupervisor> | null = null;
const subtitleStore = new Store<{ enabled?: boolean }>({ name: "ai-mayor-subtitle" });
let lastSubtitleAt: string | null = null;
let mayorModInstall: ReturnType<typeof installBridgeMod> | null = null;
const mayorConsole = () => {
  if (mayorConsoleSupervisor) return mayorConsoleSupervisor;
  const paths = resolveProductPaths({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"), mainDir: __dirname });
  const logger = Container.inject(Logger).scope("AI Mayor");
  mayorConsoleSupervisor = productSupervisor(paths, (line, detail) => logger.info(line, detail ?? {}));
  mayorConsoleSupervisor.on("state", (state) => {
    getMainWindow()?.webContents.send("ai-mayor-console-state", state);
    // The subtitle over the game: each new line of the Mayor while it runs (the player can switch it off in the console).
    const latest = state.commentary.at(-1);
    const running = state.phase === "RUNNING" || state.phase === "PAUSING";
    if (!running || subtitleStore.get("enabled") === false) { if (lastSubtitleAt) { Container.inject(Renderer).hideSubtitle(); lastSubtitleAt = null; } return; }
    if (latest && latest.at !== lastSubtitleAt) { lastSubtitleAt = latest.at; void Container.inject(Renderer).showSubtitle(latest).catch(() => undefined); }
  });
  return mayorConsoleSupervisor;
};
const mayorPaths = () => resolveProductPaths({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
  userData: app.getPath("userData"), mainDir: __dirname });
ipcMain.handle("ai-mayor-console-state", () => ({ ...mayorConsole().state, mod: mayorModInstall, appVersion: app.getVersion() }));
ipcMain.handle("ai-mayor-console-takeover", (_, permissions: TakeoverPermissions) => mayorConsole().takeOver(permissions));
ipcMain.handle("ai-mayor-console-resume", () => mayorConsole().resumeOrStart());
ipcMain.handle("ai-mayor-console-pause", () => mayorConsole().pause());
ipcMain.handle("ai-mayor-console-stop", () => mayorConsole().stop());
ipcMain.handle("ai-mayor-console-permissions", (_, permissions: TakeoverPermissions) => mayorConsole().setPermissions(permissions));
ipcMain.handle("ai-mayor-console-parse", (_, text: string) => parseInstruction(String(text ?? "")));
/** The language the Mayor answers in: the player's own sentence decides (any CJK character reads as Chinese). */
const langOf = (text: string): "zh" | "en" => (/[㐀-鿿]/.test(text) ? "zh" : "en");
/** Hand a read instruction (goal, forbids, districts to keep) to the Mayor, which lowers it through the compiler subset against the real city. */
const sendInstruction = (text: string, instruction: Instruction) => mayorConsole().command(String(text ?? ""), instruction, langOf(String(text ?? "")));
ipcMain.handle("ai-mayor-console-command", async (_, text: string) => {
  const parsed = parseInstruction(String(text ?? ""));
  if (!parsed.understood) return { ok: false, detail: parsed.summary, parsed };
  return { ...(await sendInstruction(text, parsed.instruction)), parsed };
});
// ---- The language side (host/semantic-frontend.ts): API mode reads the sentence with the player's own AI service; assisted mode copies a short
// prompt for any free AI and validates the one-line reply by this request's code. The key is stored with the OS's own encryption.
const mayorAiStore = new Store<{ mode?: "api" | "assisted"; preset?: ProviderPreset; baseUrl?: string; model?: string; apiKeyEncrypted?: string; apiKeyPlain?: string; clipboardWatch?: boolean; dailyTokenLimit?: number }>({ name: "ai-mayor-language" });
// Every call to the player's AI service is counted and held to a daily token cap (host/ai-usage.ts); 0 = no cap.
const aiUsage = createFileUsageMeter({ file: join(app.getPath("userData"), "ai-mayor", "ai-usage.json"), limit: () => mayorAiStore.get("dailyTokenLimit") ?? DEFAULT_DAILY_TOKEN_LIMIT });
setUsageMeter(aiUsage);
const readApiConfig = (): ProviderConfig | null => {
  const preset = mayorAiStore.get("preset") ?? "auto";
  const baseUrl = mayorAiStore.get("baseUrl") ?? "";
  const model = mayorAiStore.get("model") ?? "";
  let apiKey = "";
  const encrypted = mayorAiStore.get("apiKeyEncrypted");
  if (encrypted && safeStorage.isEncryptionAvailable()) { try { apiKey = safeStorage.decryptString(Buffer.from(encrypted, "base64")); } catch { apiKey = ""; } }
  else apiKey = mayorAiStore.get("apiKeyPlain") ?? "";
  const config: ProviderConfig = { preset, baseUrl, model, apiKey };
  return apiKey && resolveProvider(config) ? config : null;
};
let pendingAssistedCode: string | null = null;
ipcMain.handle("ai-mayor-console-language-get", () => ({ mode: mayorAiStore.get("mode") ?? "assisted", preset: mayorAiStore.get("preset") ?? "auto", baseUrl: mayorAiStore.get("baseUrl") ?? "",
  model: mayorAiStore.get("model") ?? "", hasKey: readApiConfig() !== null, clipboardWatch: mayorAiStore.get("clipboardWatch") ?? false,
  dailyTokenLimit: mayorAiStore.get("dailyTokenLimit") ?? DEFAULT_DAILY_TOKEN_LIMIT }));
ipcMain.handle("ai-mayor-console-usage", () => aiUsage.snapshot());
ipcMain.handle("ai-mayor-console-language-set", (_, settings: { mode?: "api" | "assisted"; preset?: ProviderPreset; baseUrl?: string; model?: string; apiKey?: string; clipboardWatch?: boolean; dailyTokenLimit?: number }) => {
  if (typeof settings.dailyTokenLimit === "number" && Number.isFinite(settings.dailyTokenLimit) && settings.dailyTokenLimit >= 0) mayorAiStore.set("dailyTokenLimit", Math.floor(settings.dailyTokenLimit));
  if (settings.mode === "api" || settings.mode === "assisted") mayorAiStore.set("mode", settings.mode);
  if (typeof settings.preset === "string") mayorAiStore.set("preset", settings.preset);
  if (typeof settings.baseUrl === "string") mayorAiStore.set("baseUrl", settings.baseUrl.trim());
  if (typeof settings.model === "string") mayorAiStore.set("model", settings.model.trim());
  if (typeof settings.clipboardWatch === "boolean") mayorAiStore.set("clipboardWatch", settings.clipboardWatch);
  if (typeof settings.apiKey === "string") {
    if (safeStorage.isEncryptionAvailable()) { mayorAiStore.set("apiKeyEncrypted", safeStorage.encryptString(settings.apiKey.trim()).toString("base64")); mayorAiStore.delete("apiKeyPlain"); }
    else mayorAiStore.set("apiKeyPlain", settings.apiKey.trim());
  }
  return { ok: true, hasKey: readApiConfig() !== null };
});
/**
 * API mode: a sentence the local reader understood completely goes to the Mayor at once (free, offline, no token spent); only a sentence it did not fully
 * understand is read by the configured AI through the filter (the local reading answers when the AI does not).
 */
ipcMain.handle("ai-mayor-console-interpret", async (_, text: string) => {
  const config = readApiConfig();
  const sure = parseInstruction(String(text ?? ""));
  if (sure.understood && sure.confident) return { ...(await sendInstruction(text, sure.instruction)), source: "local", intent: sure.intent };
  if (config) {
    const read = await interpretViaApi(config, String(text ?? ""));
    if (read.ok) return { ...(await sendInstruction(text, read.instruction)), source: "api", intent: read.intent };
    const local = parseInstruction(String(text ?? ""));
    if (local.understood) return { ...(await sendInstruction(text, local.instruction)), source: "local", intent: local.intent, apiError: read.detail };
    // The service did not answer (or not in the format): the Mayor still looks after the city rather than turning the player away.
    return { ...(await sendInstruction(text, { goal: { kind: "GOAL", type: "RESOLVE_ISSUES", priority: "NORMAL" }, forbid: [], preserve: [], unsupported: [], fallback: true })), source: "api", apiError: read.detail };
  }
  const local = parseInstruction(String(text ?? ""));
  if (local.understood) return { ...(await sendInstruction(text, local.instruction)), source: "local", intent: local.intent };
  return { ok: false, detail: local.summary, source: "local", noApi: true };
});
/** Settings: one real request ("grow the population") through the configured service, checked like any reply; the service's own error otherwise. */
ipcMain.handle("ai-mayor-console-ai-test", async () => {
  const config = readApiConfig();
  if (!config) return { ok: false, detail: "no service configured" };
  const read = await interpretViaApi(config, "grow the population");
  return read.ok ? { ok: true, detail: `${resolveProvider(config)?.preset} · ${resolveProvider(config)?.model}` } : { ok: false, detail: read.detail };
});
ipcMain.handle("ai-mayor-console-balance", async () => { const config = readApiConfig(); return config ? queryBalance(config) : { supported: false, amount: null, currency: null, detail: "no service configured" }; });
/** Assisted mode: the prompt for this request (copied by the console), with a fresh one-time code. */
ipcMain.handle("ai-mayor-console-prompt", (_, text: string) => {
  pendingAssistedCode = newRequestCode();
  const prompt = buildPrompt(String(text ?? ""), pendingAssistedCode);
  clipboard.writeText(prompt);
  return { code: pendingAssistedCode, copied: true, length: prompt.length };
});
ipcMain.handle("ai-mayor-console-check-reply", (_, reply: string) => {
  if (!pendingAssistedCode) return { ok: false, error: "NO_CODE", detail: "no request is waiting for a reply" };
  return checkReply(String(reply ?? ""), pendingAssistedCode);
});
/** Read the clipboard ONLY when the console asks (the player ticked the box, and a request is waiting): never in the background on our own. */
ipcMain.handle("ai-mayor-console-read-clipboard", () => (pendingAssistedCode ? clipboard.readText().slice(0, 4000) : ""));
ipcMain.handle("ai-mayor-console-send-intent", async (_, payload: { text: string; reply: string }) => {
  if (!pendingAssistedCode) return { ok: false, detail: "no request is waiting" };
  const checked = checkReply(String(payload?.reply ?? ""), pendingAssistedCode);
  if (!checked.ok) return { ok: false, detail: checked.detail };
  pendingAssistedCode = null;
  return { ...(await sendInstruction(String(payload.text ?? ""), checked.instruction)), intent: checked.intent };
});
ipcMain.handle("ai-mayor-console-send-local", async (_, text: string) => {
  const local = parseInstruction(String(text ?? ""));
  if (!local.understood) return { ok: false, detail: local.summary };
  return { ...(await sendInstruction(text, local.instruction)), intent: local.intent };
});
// ---- The product's own update check (host/update-check.ts; the protocol for the website is docs/UPDATE-MANIFEST.md) ----------------------------------------
let lastUpdateVerdict: UpdateVerdict | null = null;
let lastUpdateCheckAt = 0;
const updateManifestUrl = () => (/^https:\/\//i.test(process.env.AI_MAYOR_UPDATE_URL ?? "") && /\.json(\?|$)/i.test(process.env.AI_MAYOR_UPDATE_URL!) ? process.env.AI_MAYOR_UPDATE_URL! : DEFAULT_MANIFEST_URL);
const checkForProductUpdate = async (force: boolean): Promise<{ ok: boolean; verdict: UpdateVerdict | null; error?: string }> => {
  if (!force && lastUpdateVerdict && Date.now() - lastUpdateCheckAt < 6 * 60 * 60_000) return { ok: true, verdict: lastUpdateVerdict };
  try {
    const response = await fetch(updateManifestUrl(), { signal: AbortSignal.timeout(8_000), headers: { "cache-control": "no-cache" } });
    if (!response.ok) return { ok: false, verdict: lastUpdateVerdict, error: `HTTP ${response.status}` };
    const manifest = parseManifest(await response.json());
    if (!manifest) return { ok: false, verdict: lastUpdateVerdict, error: "the update file is not valid" };
    lastUpdateCheckAt = Date.now();
    lastUpdateVerdict = judgeUpdate(app.getVersion(), manifest);
    return { ok: true, verdict: lastUpdateVerdict };
  } catch (error) { return { ok: false, verdict: lastUpdateVerdict, error: error instanceof Error ? error.message : String(error) }; }
};
ipcMain.handle("ai-mayor-console-update-check", (_, force: boolean) => checkForProductUpdate(force === true));
/** Download the installer to a temp folder, verify its SHA-256 against the manifest, start it and quit. Anything that does not verify is deleted and never run. */
ipcMain.handle("ai-mayor-console-update-install", async () => {
  const verdict = lastUpdateVerdict;
  if (!verdict || verdict.kind !== "AVAILABLE") return { ok: false, error: "no update is waiting" };
  const { manifest } = verdict;
  if (!verdict.canInstallInApp || !manifest.downloadUrl) {
    if (manifest.pageUrl) void shell.openExternal(manifest.pageUrl);
    return { ok: manifest.pageUrl !== null, opened: "page", error: manifest.pageUrl ? undefined : "the update has no download page" };
  }
  const file = join(app.getPath("temp"), `AI-Mayor-Setup-${manifest.version}.exe`);
  try {
    const response = await fetch(manifest.downloadUrl, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) return { ok: false, error: `download failed: HTTP ${response.status}` };
    const hash = createHash("sha256");
    const out = fs.createWriteStream(file);
    for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) { hash.update(chunk); if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve())); }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    if (!hashMatches(hash.digest("hex"), manifest)) { try { fs.unlinkSync(file); } catch { /* gone anyway */ } return { ok: false, error: "the download does not match its published hash; it was deleted" }; }
    // The engine is stopped first (the game is handed back running, `stop`), then the installer starts and this process quits so the files can be replaced.
    try { await mayorConsole().stop(); } catch { /* nothing running */ }
    spawn(file, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 800);
    return { ok: true, opened: "installer" };
  } catch (error) { try { fs.unlinkSync(file); } catch { /* none */ } return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});/** The two growth controls on the home page: autonomy without outward expansion (a tick box) and the population at which growth stops. Same road as a spoken instruction. */
ipcMain.handle("ai-mayor-console-growth", async (_, change: { held?: boolean; targetPopulation?: number }) => {
  const instruction: Instruction = { goal: null, forbid: [], preserve: [], unsupported: [],
    ...(typeof change?.held === "boolean" ? { growth: change.held ? "PAUSE" as const : "RESUME" as const } : {}),
    ...(Number.isFinite(change?.targetPopulation) ? { targetPopulation: Math.round(change.targetPopulation!) } : {}) };
  const text = change?.held === true ? "自治，不再主动扩张" : change?.held === false ? "恢复扩张" : `人口目标 ${instruction.targetPopulation ?? ""}`;
  return sendInstruction(text, instruction);
});
ipcMain.handle("ai-mayor-console-clear-limits", () => mayorConsole().clearLimits());
ipcMain.handle("ai-mayor-console-subtitle", (_, on: boolean) => { subtitleStore.set("enabled", on === true); if (on !== true) { Container.inject(Renderer).hideSubtitle(); lastSubtitleAt = null; } return on === true; });
/** The window buttons (minimise, maximise, close) follow the console's theme. */
ipcMain.handle("ai-mayor-console-theme", (_, theme: string) => {
  try { getMainWindow()?.setTitleBarOverlay(theme === "dark" ? { color: "#0e131b", symbolColor: "#a3b0c2", height: 32 } : { color: "#f4f6fa", symbolColor: "#4a5568", height: 32 }); } catch { /* no overlay on this platform */ }
});
/**
 * Whether the game runs in exclusive full screen (its Settings.coc `displayMode: "Fullscreen"`): no window can show over it then, so the subtitle bar is
 * invisible and the console says how to fix it (borderless or windowed). Unknown = not claimed.
 */
const gameExclusiveFullscreen = (): boolean | null => {
  try {
    const text = fs.readFileSync(path.join(app.getPath("home"), "AppData", "LocalLow", "Colossal Order", "Cities Skylines II", "Settings.coc"), "utf8");
    const mode = /"displayMode"\s*:\s*"(\w+)"/.exec(text)?.[1];
    return mode ? mode === "Fullscreen" : null;
  } catch { return null; }
};
ipcMain.handle("ai-mayor-console-subtitle-state", () => subtitleStore.get("enabled") !== false);
ipcMain.handle("ai-mayor-console-game-fullscreen", () => gameExclusiveFullscreen());
/** Links the console may open: web pages only. */
ipcMain.handle("ai-mayor-console-open", (_, url: string) => { if (/^https:\/\/[^\s]+$/i.test(String(url ?? ""))) void shell.openExternal(url); });
ipcMain.handle("ai-mayor-console-install-mod", () => { mayorModInstall = installBridgeMod(mayorPaths().modSourceDir); return mayorModInstall; });
ipcMain.handle("ai-mayor-console-diagnostics", () => {
  const state = mayorConsole().state;
  const text = JSON.stringify({ appVersion: app.getVersion(), platform: process.platform, mod: mayorModInstall, phase: state.phase, phaseDetail: state.phaseDetail,
    gameConnection: state.gameConnection, supervision: state.supervision, permissions: state.permissions, backup: state.backup, status: state.status,
    snapshot: state.snapshot, lastCycle: state.lastCycle, activity: state.activity.slice(-60) }, null, 2);
  clipboard.writeText(text);
  return { copied: true, bytes: text.length };
});

const setupAiMayorProductMode = () => {
  const renderer = Container.inject(Renderer);
  // The game mod this product ships goes where the game loads it (a running game keeps the old one until it restarts).
  mayorModInstall = installBridgeMod(mayorPaths().modSourceDir);
  Container.inject(Logger).scope("AI Mayor").info("Bridge mod", mayorModInstall);
  mayorConsole();
  aiMayorTray = new Tray(nativeImage.createFromPath(resolve(__dirname, "./build/icon.png")));
  aiMayorTray.setToolTip("AI Mayor");
  aiMayorTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "AI Mayor", enabled: false },
      { type: "separator" },
      { label: "Open AI Mayor", click: () => void renderer.focus() },
      { label: "Show in-game overlay", click: () => void renderer.showOverlay() },
      { type: "separator" },
      { label: "Pause Mayor", click: () => void mayorConsole().pause() },
      { label: "Resume Mayor", click: () => void mayorConsole().resumeOrStart() },
      { type: "separator" },
      { label: "Quit (stops the Mayor)", click: () => app.quit() },
    ]),
  );
  aiMayorTray.on("click", () => void renderer.focus());
  if (!globalShortcut.register(AI_MAYOR_OVERLAY_SHORTCUT, () => void renderer.focus())) {
    Container.inject(Logger).warning(`Could not register ${AI_MAYOR_OVERLAY_SHORTCUT}`);
  }
};

ipcMain.handle("request", async (event, options) => {
  const logger = Container.inject(Logger).scope("Main:Request");
  const { url, method, headers, body, proxy, isStream } = options;
  const requestId = Math.random().toString(36).substr(2, 9);
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);
  try {
    let agent: HttpsProxyAgent<string> | undefined;
    if (proxy) {
      try {
        agent = new HttpsProxyAgent(proxy);
        logger.info(`Using proxy: ${proxy}`);
      } catch (error) {
        logger.error(`Invalid proxy URL: ${proxy}`, error);
      }
    }

    const fetchOptions: any = {
      method,
      headers,
      signal: abortController.signal,
      ...(agent && { agent }),
    };

    if (body && method !== "GET") {
      fetchOptions.body = body;
    }

    const response = await fetch(url, fetchOptions);
    // activeRequests.delete(requestId);

    if (isStream) {
      const nodeStream = response.body as Readable;

      if (nodeStream) {
        nodeStream.on("data", (chunk: Buffer) => {
          if (!abortController.signal.aborted) {
            event.sender.send("stream-data", requestId, new Uint8Array(chunk));
          }
        });

        nodeStream.on("end", () => {
          event.sender.send("stream-end", requestId);
        });

        nodeStream.on("error", (error) => {
          event.sender.send("stream-error", requestId, error.message);
        });

        abortController.signal.addEventListener("abort", () => {
          if (nodeStream && !nodeStream.destroyed) {
            nodeStream.destroy(new Error("Request cancelled"));
          }
          event.sender.send("stream-end", requestId);
        });
      } else {
        event.sender.send("stream-end", requestId);
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        requestId,
        isStream: true,
      };
    }
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      requestId,
    };
  } catch (error: unknown) {
    activeRequests.delete(requestId);
    if (error instanceof Error && error.name === "AbortError") {
      logger.info(`Request ${requestId} was cancelled`);
    } else {
      logger.error("Request failed:", error);
    }
    throw error;
  }
});

ipcMain.handle("cancel-request", async (event, requestId: string) => {
  const controller = activeRequests.get(requestId);
  if (controller) {
    console.log(`Cancelling request ${requestId}`);
    controller.abort(); // 真正取消网络请求
    activeRequests.delete(requestId);
    return true;
  }
  console.warn(`Request ${requestId} not found or already completed`);
  return false;
});

ipcMain.on("ipc-app", async (event) => {
  event.reply("ipc-app", {
    darkMode: nativeTheme.shouldUseDarkColors,
  });
});

ipcMain.on("get-store", (evt, key, defaultValue) => {
  evt.returnValue = store.get(key, defaultValue);
});

ipcMain.on("set-store", (evt, key, val) => {
  store.set(key, val);
  evt.returnValue = val;
});

ipcMain.on("minimize-app", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (window) {
    window.minimize();
  }
});
ipcMain.on("maximize-app", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (window) {
    window.isMaximized() ? window.unmaximize() : window.maximize();
  }
});
ipcMain.on("close-app", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    window.destroy();
  }
  if (process.platform !== "darwin") {
    app.quit();
    process.exit(0);
  }
});

ipcMain.handle("get-protocol", () => {
  return protocol;
});

ipcMain.handle("get-device-info", async () => {
  return {
    arch: os.arch(),
    platform: os.platform(),
    type: os.type(),
  };
});

ipcMain.handle("hmac-sha256-hex", (_, data: string, key: string) => {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.handle("ingest-event", (_, data) => {
  Container.inject(Logger).track({ event: data.app as string });
});

ipcMain.handle("open-external", (_, url) => {
  openSafeExternal(url);
});

ipcMain.handle("get-user-data-path", (_, paths) => {
  if (paths) {
    return path.join(app.getPath("userData"), ...paths);
  }
  return app.getPath("userData");
});

ipcMain.handle("get-system-language", () => {
  return app.getLocale();
});

// eslint-disable-next-line consistent-return
ipcMain.handle("select-image-with-base64", async () => {
  const logger = Container.inject(Logger).scope("Main:SelectImageWithBase64");
  try {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "png", "jpeg"],
        },
      ],
    });
    const filePath = result.filePaths[0];
    const fileType = await getFileType(filePath);
    if (!SUPPORTED_IMAGE_TYPES[fileType]) {
      dialog.showErrorBox("Error", `Unsupported file type ${fileType} for ${filePath}`);
      return null;
    }
    const fileInfo: any = await getFileInfo(filePath);
    if (fileInfo.size > KNOWLEDGE_IMPORT_MAX_FILE_SIZE) {
      dialog.showErrorBox(
        "Error",
        `the size of ${filePath} exceeds the limit (${KNOWLEDGE_IMPORT_MAX_FILE_SIZE / (1024 * 1024)} MB})`,
      );
      return null;
    }
    const blob = fs.readFileSync(filePath);
    const base64 = Buffer.from(blob).toString("base64");
    return JSON.stringify({
      name: fileInfo.name,
      path: filePath,
      size: fileInfo.size,
      type: fileInfo.type,
      base64: `data:image/${fileType};base64,${base64}`,
    });
  } catch (err: any) {
    logger.capture(err, {
      reason: "Failed to select image with base64",
    });
  }
});

/** mcp */
ipcMain.handle("mcp-init", () => {
  // const logger = Container.inject(Logger).scope("Main:MCPInit");
  // // eslint-disable-next-line promise/catch-or-return
  // mcp.init().then(async () => {
  //   // https://github.com/sindresorhus/fix-path
  //   logger.info("mcp initialized");
  //   await mcp.load();
  //   getMainWindow()?.webContents.send("mcp-server-loaded", mcp.getClientNames());
  // });
});
ipcMain.handle("mcp-add-server", (_, server: IMCPServer) => {
  // return mcp.addServer(server);
});
ipcMain.handle("mcp-update-server", (_, server: IMCPServer) => {
  // return mcp.updateServer(server);
});
ipcMain.handle("mcp-activate", async (_, server: IMCPServer) => {
  // return mcp.activate(server);
});
ipcMain.handle("mcp-deactivate", async (_, clientName: string) => {
  // return mcp.deactivate(clientName);
});
ipcMain.handle("mcp-list-tools", async (_, __: string) => {
  const logger = Container.inject(Logger).scope("Main:MCPListTools");
  const toolsManager = Container.inject(MCPToolsManager);
  try {
    return await toolsManager.legacyList();
  } catch (error) {
    logger.error("Error listing MCP tools:", error);
    return {
      tools: [],
      error: {
        message: asError(error).message || "Unknown error listing tools",
        code: "unexpected_error",
      },
    };
  }
});
ipcMain.handle("mcp-call-tool", async (_, args: { client: string; name: string; args: any; requestId?: string }) => {
  const logger = Container.inject(Logger).scope("Main:MCPCallTool");
  const toolsManager = Container.inject(MCPToolsManager);
  try {
    return await toolsManager.legacyCall({
      client: args.client,
      name: args.name,
      arguments: args.args,
      requestId: args.requestId,
    });
  } catch (error) {
    logger.error("Error invoking MCP tool:", error);
    return {
      isError: true,
      content: [
        {
          error: asError(error).message || "Unknown error calling tool",
          code: "unexpected_error",
        },
      ],
    };
  }
});
ipcMain.handle("mcp-cancel-tool", (_, requestId: string) => {
  return Container.inject(MCPToolsManager).legacyCancelCall({ requestId });
});
ipcMain.handle("mcp-list-prompts", async (_, name: string) => {
  const logger = Container.inject(Logger).scope("Main:MCPListPrompts");
  try {
    return await Container.inject(MCPPromptsManager).legacyList();
  } catch (error) {
    logger.error("Error listing MCP prompts:", error);
    return {
      prompts: [],
      error: {
        message: asError(error).message || "Unknown error listing prompts",
        code: "unexpected_error",
      },
    };
  }
});

ipcMain.handle("mcp-get-prompt", async (_, args: { client: string; name: string; args?: any }) => {
  const logger = Container.inject(Logger).scope("Main:MCPGetPrompt");
  try {
    return await Container.inject(MCPPromptsManager).legacyGet({
      client: args.client,
      name: args.name,
      arguments: args.args,
    });
  } catch (error) {
    logger.error("Error getting MCP prompt:", error);
    return {
      isError: true,
      content: [
        {
          error: asError(error).message || "Unknown error getting prompt",
          code: "unexpected_error",
        },
      ],
    };
  }
});

ipcMain.handle("mcp-get-config", () => {
  return mcp.getConfig();
});

ipcMain.handle("mcp-put-config", (_, config) => {
  return mcp.putConfig(config);
});
ipcMain.handle("mcp-get-active-servers", () => {
  return mcp.getClientNames();
});

ipcMain.on("show-context-menu", (event, params) => {
  const template = [];
  if (params.type === "chat-folder") {
    template.push({
      label: "Rename",
      click: () => {
        event.sender.send("context-menu-command", "rename-chat-folder", {
          type: "chat-folder",
          id: params.targetId,
        });
      },
    });
    template.push({
      label: "Settings",
      click: () => {
        event.sender.send("context-menu-command", "folder-chat-settings", {
          type: "chat-folder",
          id: params.targetId,
        });
      },
    });
    template.push({
      label: "Delete",
      click: () => {
        event.sender.send("context-menu-command", "delete-chat-folder", {
          type: "chat-folder",
          id: params.targetId,
        });
      },
    });
  } else if (params.type === "chat") {
    template.push({
      label: "Rename",
      click: () => {
        event.sender.send("context-menu-command", "rename-chat", {
          type: "chat",
          id: params.targetId,
        });
      },
    });
    template.push({
      label: "Delete",
      click: () => {
        event.sender.send("context-menu-command", "delete-chat", {
          type: "chat",
          id: params.targetId,
        });
      },
    });
  }
  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: getMainWindow() as BrowserWindow, x: params.x, y: params.y });
});

ipcMain.handle("DocumentLoader::loadFromBuffer", (_, buffer, mimeType) => {
  return DocumentLoader.loadFromBuffer(buffer, mimeType);
});
ipcMain.handle("DocumentLoader::loadFromURI", (_, url, mimeType) => {
  return DocumentLoader.loadFromURI(url, mimeType);
});
ipcMain.handle("DocumentLoader::loadFromFilePath", (_, file, mimeType) => {
  return DocumentLoader.loadFromFilePath(file, mimeType);
});

const isDebug = process.env.NODE_ENV === "development" || process.env.DEBUG_PROD === "true";

if (isDebug) {
  require("electron-debug")();
}

/**
 * Set Dock icon
 */
if (app.dock) {
  const dockIcon = nativeImage.createFromPath(`${__dirname}/build/dockicon.png`);
  app.dock.setIcon(dockIcon);
}

app.setName("AI Mayor");

process.on("uncaughtException", (error) => {
  Container.inject(Logger, false)?.scope("App:UncaughtException").capture(error, {
    reason: "Uncaught Exception",
  });
});

process.on("unhandledRejection", (reason) => {
  Container.inject(Logger, false)?.scope("App:UnhandledRejection").capture(reason, {
    reason: "Unhandled Rejection",
  });
});
