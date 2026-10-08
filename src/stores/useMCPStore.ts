import Debug from 'debug';
import { IMCPConfig, IMCPServer } from 'types/mcp';
import { create } from 'zustand';

const debug = Debug('app:stores:useMCPStore');

export interface IMCPStore {
  isLoading: boolean;
  config: IMCPConfig;
  updateLoadingState: (isLoading: boolean) => void;
  loadConfig: (force?: boolean) => Promise<IMCPConfig>;
  addServer: (server: IMCPServer) => Promise<boolean>;
  updateServer: (server: IMCPServer) => Promise<boolean>;
  deleteServer: (key: string) => Promise<boolean>;
  activateServer: (
    key: string,
    command?: string,
    args?: string[],
    env?: Record<string, string>,
  ) => Promise<boolean>;
  deactivateServer: (key: string) => Promise<boolean>;
}

const useMCPStore = create<IMCPStore>((set, get) => ({
  isLoading: true,
  config: { mcpServers: {} },
  updateLoadingState: (isLoading: boolean) => {
    set({ isLoading });
  },
  loadConfig: async (force?: boolean) => {
    if (!force && Object.keys(get().config.mcpServers).length > 0) {
      return get().config;
    }
    const config = await window.electron.mcp.getConfig();
    set({ config });
    return config;
  },
  addServer: async (server: IMCPServer) => {
    const ok = await window.electron.mcp.addServer(server);
    if (ok) {
      get().loadConfig(true);
      return true;
    }
    return false;
  },
  updateServer: async (server: IMCPServer) => {
    const ok = await window.electron.mcp.updateServer(server);
    if (ok) {
      get().loadConfig(true);
      return true;
    }
    return false;
  },
  deleteServer: async (key: string) => {
    const { mcpServers } = get().config;
    const server = mcpServers[key];
    if (server) {
      let ok = true;
      if (server.isActive) {
        ok = await get().deactivateServer(key);
      }
      if (ok) {
        delete mcpServers[key];
        const newConfig = { mcpServers: { ...mcpServers } };
        set({ config: newConfig });
        await window.electron.mcp.putConfig(newConfig);
        return true;
      }
    }
    return false;
  },
  activateServer: async (
    key: string,
    command?: string,
    args?: string[],
    env?: Record<string, string>,
  ) => {
    debug('Activating server:', {
      key,
      command,
      args,
      env,
    });
    const { error } = await window.electron.mcp.activate({
      key,
      command,
      args,
      env,
    });
    if (error) {
      throw new Error(error);
    }
    await get().loadConfig(true);
    return true;
  },
  deactivateServer: async (key: string) => {
    const { error } = await window.electron.mcp.deactivated(key);
    if (error) {
      throw new Error(error);
    }
    await get().loadConfig(true);
    return true;
  },
}));

export default useMCPStore;
