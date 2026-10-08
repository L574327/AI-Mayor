// For each noise icon: the building it hangs on, the nearest roads (prefab, distance, traffic), and industrial / commercial buildings within 250 m.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The repository root is two levels above this file: nothing here depends on where the repository lives.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = (file) => import(pathToFileURL(path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client", file)).href);
const { Client } = await sdk("index.js");
const { StdioClientTransport } = await sdk("stdio.js");

const client = new Client({ name: "noise", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "mayor-bundle", "mcp-server", "dist", "index.js")], stderr: "ignore" }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const icons = (await call("cs2_notifications", { limit: 500 })).notifications.filter((n) => /Noise/i.test(n.type));
const segDist = (p, a, b) => { const dx = b.x - a.x, dz = b.z - a.z, l = dx * dx + dz * dz; const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l)) : 0; return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)); };
for (const icon of icons) {
  const p = { x: icon.location.x, z: icon.location.z };
  const roads = (await call("cs2_list_roads", { x: p.x, z: p.z, radius: 120, limit: 60 })).roads ?? [];
  const near = roads.map((r) => ({ prefab: r.prefab, d: segDist(p, r.start, r.end) })).sort((a, b) => a.d - b.d).slice(0, 3);
  const detail = await call("cs2_site_detail", { x: p.x, z: p.z, radius: 250, resolution: 64 }).catch(() => null);
  const buildings = detail?.buildings ?? [];
  const kinds = {};
  for (const b of buildings) { const k = /Industrial|Manufactur|Warehouse|Extractor|Forestry|Farm|Ore|Oil/i.test(b.prefab) ? "industry" : /Commercial/i.test(b.prefab) ? "commercial" : /Office/i.test(b.prefab) ? "office" : /Residential/i.test(b.prefab) ? "home" : "other"; kinds[k] = (kinds[k] ?? 0) + 1; }
  const nearestIndustry = buildings.filter((b) => /Industrial|Manufactur|Warehouse/i.test(b.prefab)).map((b) => Math.hypot(b.position.x - p.x, b.position.z - p.z)).sort((a, b) => a - b)[0];
  console.log(`${icon.target?.prefab} @(${p.x.toFixed(0)},${p.z.toFixed(0)}) roads: ${near.map((r) => `${r.prefab} ${r.d.toFixed(0)}m`).join(", ")} | within 250m ${JSON.stringify(kinds)} | nearest industry ${nearestIndustry?.toFixed(0) ?? "-"} m`);
}
await client.close();
