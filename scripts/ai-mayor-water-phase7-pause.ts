import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const rec = (value: unknown): Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};

async function main() {
  const client = new Client({ name: "water-phase7-pause-for-read-only-certification", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  try {
    const pauseResult = await client.callTool({ name: "cs2_set_simulation", arguments: { paused: true } });
    const stateResult = await client.callTool({ name: "cs2_game_state", arguments: {} });
    const pauseText = rec(pauseResult).content instanceof Array ? rec((rec(pauseResult).content as unknown[])[0]).text : null;
    const stateText = rec(stateResult).content instanceof Array ? rec((rec(stateResult).content as unknown[])[0]).text : null;
    const paused = typeof stateText === "string" ? JSON.parse(stateText) : {};
    const game = rec(paused);
    process.stdout.write(JSON.stringify({
      pauseControlResponse: typeof pauseText === "string" ? JSON.parse(pauseText) : pauseText,
      world: game.world,
      simulation: game.simulation,
    }, null, 2) + "\n");
  } finally { await client.close(); }
}
void main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
