/**
 * The product's wiring in the desktop app: where the engine, the game connector and the game mod are (packaged or in development), installing the
 * mod into the game's Mods folder, and the one supervisor the console talks to.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MayorSupervisor } from "./mayor-supervisor";

export interface ProductPaths {
  execPath: string;
  enginePath: string;
  serverPath: string;
  modSourceDir: string;
  dataDir: string;
}

/** The game's own Mods folder (it scans LocalLow, never Local\Low). */
export function gameModsDir(): string {
  return path.join(os.homedir(), "AppData", "LocalLow", "Colossal Order", "Cities Skylines II", "Mods", "CS2MCP");
}

export function resolveProductPaths(input: { isPackaged: boolean; appPath: string; resourcesPath: string; userData: string; mainDir: string }): ProductPaths {
  const dataDir = path.join(input.userData, "ai-mayor");
  if (input.isPackaged) {
    const bundle = path.join(input.resourcesPath, "mayor");
    return { execPath: process.execPath, enginePath: path.join(input.mainDir, "mayor-engine.cjs"),
      serverPath: path.join(bundle, "mcp-server", "dist", "index.js"), modSourceDir: path.join(bundle, "bridge-mod"), dataDir };
  }
  // Development: the repository's TypeScript engine (run through tsx), the reconstruction MCP server and the Bridge build output.
  const repo = process.env.SOURCE_ROOT ?? path.resolve(input.appPath, "..");
  return { execPath: process.execPath, enginePath: path.join(repo, "src", "main", "services", "ai-mayor", "host", "mayor-engine.ts"),
    serverPath: process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-reconstruction\\mcp-server\\dist\\index.js",
    modSourceDir: process.env.AI_MAYOR_BRIDGE_BUILD ?? "D:\\github\\cities-skylines-2-mcp-master\\CS2MCP.Bridge\\bin\\Release", dataDir };
}

export interface ModInstallResult { status: "UP_TO_DATE" | "INSTALLED" | "SOURCE_MISSING" | "FAILED"; detail: string; needsGameRestart: boolean }

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Put the game mod (the Bridge, `CS2MCP.dll`) where the game loads it, when it is missing or differs from the one this product ships. A game that is
 * running holds the old one: the copy may be refused (reported) or take effect at the game's next start (reported as needing a restart).
 */
export function installBridgeMod(sourceDir: string, targetDir = gameModsDir()): ModInstallResult {
  const source = path.join(sourceDir, "CS2MCP.dll");
  if (!fs.existsSync(source)) return { status: "SOURCE_MISSING", detail: `no CS2MCP.dll in ${sourceDir}`, needsGameRestart: false };
  const target = path.join(targetDir, "CS2MCP.dll");
  try {
    if (fs.existsSync(target) && sha(target) === sha(source)) return { status: "UP_TO_DATE", detail: target, needsGameRestart: false };
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, target);
    const pdb = path.join(sourceDir, "CS2MCP.pdb");
    if (fs.existsSync(pdb)) { try { fs.copyFileSync(pdb, path.join(targetDir, "CS2MCP.pdb")); } catch { /* symbols are optional */ } }
    return { status: "INSTALLED", detail: target, needsGameRestart: true };
  } catch (error) {
    return { status: "FAILED", detail: `${error instanceof Error ? error.message : String(error)} (close Cities: Skylines II and start AI Mayor again)`, needsGameRestart: true };
  }
}

let supervisor: MayorSupervisor | null = null;

export function productSupervisor(paths: ProductPaths, log?: (line: string, detail?: Record<string, unknown>) => void): MayorSupervisor {
  supervisor ??= new MayorSupervisor({ execPath: paths.execPath, enginePath: paths.enginePath, serverPath: paths.serverPath, dataDir: paths.dataDir, ...(log ? { log } : {}) });
  return supervisor;
}
