import Debug from "debug";
import useToast from "hooks/useToast";
import Mousetrap from "mousetrap";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import useAuthStore from "stores/useAuthStore";
import useKnowledgeStore from "stores/useKnowledgeStore";
import useMCPStore from "stores/useMCPStore";
import FluentApp from "./components/FluentApp";
import * as logging from "./logging";

import "./App.scss";
import "./fluentui.scss";
import { ContextMenuProvider } from "./components/ContextMenuProvider";
import OverlayApp from "./apps/ai-mayor-overlay/OverlayApp";
import ConsoleApp from "./apps/ai-mayor-console/ConsoleApp";
import SubtitleApp from "./apps/ai-mayor-subtitle/SubtitleApp";

const isAiMayorOverlay = new URLSearchParams(window.location.search).has("ai-mayor-overlay");
const isAiMayorSubtitle = new URLSearchParams(window.location.search).has("ai-mayor-subtitle");
// The product: the main window is the AI Mayor console (the chat client underneath stays for development).
const isAiMayorConsole = !isAiMayorOverlay && !isAiMayorSubtitle && window.envVars.AI_MAYOR_PRODUCT_MODE === "1";

if (window.envVars.NODE_ENV === "development") {
  Debug.enable("app:*");
}

const debug = Debug("app:App");

logging.init();

/**
 * Main application component that initializes the app and manages global state.
 * Handles authentication, MCP server initialization, and IPC communication setup.
 *
 * @returns {JSX.Element} The main application wrapped in context providers
 */
export default function App() {
  const loadAuthData = useAuthStore((state) => state.load);
  const setSession = useAuthStore((state) => state.setSession);
  const { loadConfig, updateLoadingState } = useMCPStore();
  const { onAuthStateChange } = useAuthStore();
  const { notifyError } = useToast();
  const { t } = useTranslation();
  const { createFile } = useKnowledgeStore();

  useEffect(() => {
    if (isAiMayorOverlay || isAiMayorConsole) return;
    loadAuthData();
    Mousetrap.prototype.stopCallback = () => {
      return false;
    };
    const subscription = onAuthStateChange();
    window.electron.mcp.init();
    window.electron.ipcRenderer.on("mcp-server-loaded", async (serverNames: any) => {
      debug("🚩 MCP Server Loaded:", serverNames);
      loadConfig(true);
      updateLoadingState(false);
    });

    window.electron.ipcRenderer.on("sign-in", async (authData: any) => {
      if (authData.accessToken && authData.refreshToken) {
        const { error } = await setSession(authData);
        if (error) {
          notifyError(error.message);
        }
      } else {
        debug("🚩 Invalid Auth Data:", authData);
        notifyError(t("Auth.Notification.LoginCallbackFailed"));
      }
    });

    /**
     * Handles knowledge base import completion events from the main process.
     * Creates a new file entry in the knowledge store when import succeeds.
     * This listener is placed at the app level to ensure it persists across component unmounts.
     *
     * @param {unknown} data - Import completion data containing collection ID, file info, and chunk count
     */
    window.electron.ipcRenderer.on("knowledge-import-success", (data: unknown) => {
      const { collectionId, file, numOfChunks } = data as any;
      createFile({
        id: file.id,
        collectionId,
        name: file.name,
        size: file.size,
        numOfChunks,
      });
    });

    return () => {
      window.electron.ipcRenderer.unsubscribeAll("mcp-server-loaded");
      window.electron.ipcRenderer.unsubscribeAll("sign-in");
      window.electron.ipcRenderer.unsubscribeAll("knowledge-import-success");
      subscription.unsubscribe();
    };
  }, [loadAuthData, onAuthStateChange]);

  if (isAiMayorSubtitle) return <SubtitleApp />;
  if (isAiMayorOverlay) return <OverlayApp />;
  if (isAiMayorConsole) return <ConsoleApp />;

  return (
    <ContextMenuProvider>
      <FluentApp />
    </ContextMenuProvider>
  );
}
