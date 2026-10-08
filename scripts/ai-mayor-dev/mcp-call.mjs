// node mcp-call.mjs <tool> '<json args>' [<tool> '<json args>' ...]  — calls the live MCP server (the shipped bundle) and prints each result.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The repository root is two levels above this file: nothing here depends on where the repository lives.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = (file) => import(pathToFileURL(path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client", file)).href);
const { Client } = await sdk("index.js");
const { StdioClientTransport } = await sdk("stdio.js");

const server = process.env.MCP_SERVER ?? path.join(root, "mayor-bundle", "mcp-server", "dist", "index.js");
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
const args = process.argv.slice(2);
const limit = Number(process.env.MAX ?? 4000);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  const input = args[i + 1] ? JSON.parse(args[i + 1]) : {};
  try {
    const result = await client.callTool({ name, arguments: input });
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    console.log(`== ${name}${result.isError ? " (ERROR)" : ""}\n${text.slice(0, limit)}`);
  } catch (error) { console.log(`== ${name} THREW ${error?.message ?? error}`); }
}
await client.close();
