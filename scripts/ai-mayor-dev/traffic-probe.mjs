// Read-only: the jammed corridors, each road's edges in full, and the nodes at the jam's boundary (what road-care.ts will see).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The repository root is two levels above this file: nothing here depends on where the repository lives.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = (file) => import(pathToFileURL(path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client", file)).href);
const { Client } = await sdk("index.js");
const { StdioClientTransport } = await sdk("stdio.js");

const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "mayor-bundle", "mcp-server", "dist", "index.js")], stderr: "ignore" }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const key = (r) => `${r.index}:${r.version}`;
const t = await call("cs2_traffic", { limit: 40, minVolume: 50 });
console.log(`city flow ${t.cityFlowPercent.toFixed(1)}%`);
const jam = t.worst.filter((e) => e.flowPercent < 35 && e.volume >= 150);
const byAgg = new Map();
for (const e of jam) { const k = e.aggregate ? key(e.aggregate) : key(e.entity); byAgg.set(k, [...(byAgg.get(k) ?? []), e]); }
for (const [agg, edges] of [...byAgg].slice(0, 3)) {
  console.log(`\n== corridor ${agg}: ${edges.length} jammed edges, ${edges[0].prefab}`);
  const all = edges[0].aggregate ? (await call("cs2_traffic", { aggregate: edges[0].aggregate.index })).worst : edges;
  for (const e of all.sort((a, b) => a.position.x - b.position.x)) console.log(`  ${key(e.entity)} ${e.prefab} (${e.position.x.toFixed(0)},${e.position.z.toFixed(0)}) flow ${e.flowPercent.toFixed(0)}% [A ${e.flowA?.toFixed(0)} B ${e.flowB?.toFixed(0)}] vol ${e.volume.toFixed(0)} wear ${e.wear.toFixed(0)} nodes ${key(e.startNode)}->${key(e.endNode)}`);
  const nodes = new Set(edges.flatMap((e) => [key(e.startNode), key(e.endNode)]));
  for (const n of nodes) {
    const [index, version] = n.split(":").map(Number);
    const node = await call("cs2_traffic_node", { index, version });
    if (!node.edges || node.roads < 3) continue;
    console.log(`  node ${n} (${node.position.x.toFixed(0)},${node.position.z.toFixed(0)}) lights=${node.trafficLights} stop=${node.allWayStop} ra=${node.roundabout} legs=${node.roads}: ` +
      node.edges.filter((l) => l.road).map((l) => `${l.prefab} ${((l.flowA * l.volumeA + l.flowB * l.volumeB) / Math.max(1, l.volumeA + l.volumeB)).toFixed(0)}%/${(l.volumeA + l.volumeB).toFixed(0)}`).join(" | "));
  }
}
await client.close();
