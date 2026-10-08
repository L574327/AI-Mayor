import { app } from "electron";
import { resolveUserDataFolder } from "./user-data-folder";

// Must run before anything reads `userData`: `main.ts` imports this first. See `user-data-folder.ts`.
try { app.setPath("userData", resolveUserDataFolder(app.getPath("appData"))); } catch { /* keep Electron's default */ }