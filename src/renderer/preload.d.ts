import { ElectronHandler, EnvVars } from 'main/preload';

declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    electron: ElectronHandler;
    envVars: EnvVars;
  }
}

export {};
