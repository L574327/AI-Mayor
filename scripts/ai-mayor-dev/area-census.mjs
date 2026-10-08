// node area-census.mjs <out.json> — roads and zoned/occupied cells touching each named district (read from the live game), saved for a before/after diff.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The repository root is two levels above this file: nothing here depends on where the repository lives.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = (file) => import(pathToFileURL(path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client", file)).href);
const { Client } = await sdk("index.js");
const { StdioClientTransport } = await sdk("stdio.js");

const client = new Client({ name: "census", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "mayor-bundle", "mcp-server", "dist", "index.js")], stderr: "ignore" }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const inPoly = (p, poly) => { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside; } return inside; };
const districts = (await call("cs2_list_districts")).districts;
const result = { at: new Date().toISOString(), districts: [] };
for (const d of districts) {
  const xs = d.outline.map((p) => p.x), zs = d.outline.map((p) => p.z);
  const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
  const radius = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 + 20;
  const roads = (await call("cs2_list_roads", { x: center.x, z: center.z, radius, limit: 500 })).roads ?? [];
  const inside = roads.filter((r) => inPoly(r.start, d.outline) || inPoly(r.end, d.outline) || inPoly({ x: (r.start.x + r.end.x) / 2, z: (r.start.z + r.end.z) / 2 }, d.outline));
  result.districts.push({ name: d.name, outline: d.outline, roads: inside.map((r) => `${r.entity.index}:${r.entity.version} ${r.prefab} (${r.start.x.toFixed(0)},${r.start.z.toFixed(0)})-(${r.end.x.toFixed(0)},${r.end.z.toFixed(0)})`) });
}
fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
for (const d of result.districts) console.log(`${d.name}: ${d.roads.length} road segments inside`);
await client.close();
