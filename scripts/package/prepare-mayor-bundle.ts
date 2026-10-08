/**
 * Stages what the AI Mayor installer ships besides the app itself, under mayor-bundle/ (packaged to resources/mayor):
 *   mcp-server/   the game connector (MCP server): one minified bundle (dist/index.js) + a minimal package.json
 *   bridge-mod/   the game mod (CS2MCP.dll), installed into the game's Mods folder by the app on first start
 *
 *   npx tsx scripts/package/prepare-mayor-bundle.ts
 *
 * Sources default to this workstation's repositories and can be overridden with AI_MAYOR_MCP_SERVER_DIR / AI_MAYOR_BRIDGE_BUILD.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";

const root = path.resolve(__dirname, "..", "..");
// Outside build/ (which rsbuild copies into the app itself): this goes to resources/mayor only.
const out = path.join(root, "mayor-bundle");
const serverDir = process.env.AI_MAYOR_MCP_SERVER_DIR ?? "D:\\github\\cities-skylines-2-mcp-reconstruction\\mcp-server";
const bridgeBuild = process.env.AI_MAYOR_BRIDGE_BUILD ?? "D:\\github\\cities-skylines-2-mcp-master\\CS2MCP.Bridge\\bin\\Release";

const need = (file: string) => { if (!fs.existsSync(file)) throw new Error(`missing: ${file}`); return file; };

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "mcp-server"), { recursive: true });
fs.mkdirSync(path.join(out, "bridge-mod"), { recursive: true });

// The game connector: its built output and dependencies bundled into ONE minified file (no node_modules, no source maps, no comments), like the
// engine. Its own dependencies are installed (production only) in the source repository first, so the bundle is made from what it runs with.
if (!fs.existsSync(path.join(serverDir, "node_modules", "@modelcontextprotocol"))) execSync("npm install --omit=dev --no-audit --no-fund", { cwd: serverDir, stdio: "inherit" });
const bundled = buildSync({
  entryPoints: [need(path.join(serverDir, "dist", "index.js"))], outfile: path.join(out, "mcp-server", "dist", "index.js"),
  bundle: true, platform: "node", format: "esm", target: "node20", minify: true, sourcemap: false, legalComments: "none", logLevel: "warning",
  // The bundled CommonJS dependencies still call require() for Node's own modules.
  banner: { js: "import { createRequire as __mayorRequire } from 'node:module'; const require = __mayorRequire(import.meta.url);" },
});
if (bundled.errors.length > 0) throw new Error(`bundling the game connector failed: ${bundled.errors.map((error) => error.text).join("; ")}`);
fs.writeFileSync(path.join(out, "mcp-server", "package.json"), JSON.stringify({ name: "ai-mayor-connector", private: true, type: "module", main: "dist/index.js" }, null, 2));

// The game mod (no debug symbols).
fs.copyFileSync(need(path.join(bridgeBuild, "CS2MCP.dll")), path.join(out, "bridge-mod", "CS2MCP.dll"));

const size = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? size(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size), 0);
console.log(`mayor bundle staged at ${out}: ${(size(out) / 1048576).toFixed(1)} MB`);
