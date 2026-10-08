/**
 * Live driver for the utility street-covering primitive
 * (`v2/utility-network-laying.ts`).
 *
 * TWO MODES, and the safe one is the default.
 *
 *   PLAN (default, READ-ONLY). Picks ONE road component, plans one course per
 *   street of it, and asks native — with the same `kind=net` dry run the
 *   product previews with — whether each course would be accepted. Nothing is
 *   built, nothing is authorized, no durable command is written. This is the
 *   run that says which streets are already occupied, which are on a bridge,
 *   and which are clean, BEFORE anything is applied.
 *
 *   APPLY (`--apply`). The same plan, executed through the production path:
 *   `createV2FoundationPorts` -> `createV2RuntimeRoadCaller` ->
 *   `layUtilityAlongRoadComponent`, one command per street, each with its own
 *   commandId and its own reconciliation. It stops at the first street that
 *   does not read back.
 *
 * This script PICKS the component; the primitive does not. Deciding which
 * neighbourhood gets service is the plan layer's question, and a live driver
 * is where that decision is made explicit and reviewable.
 *
 * USAGE
 *   npx tsx scripts/ai-mayor-utility-laying-live.ts --prefab "Low-voltage Ground Cable"
 *   npx tsx scripts/ai-mayor-utility-laying-live.ts --prefab "Small Sewage Pipe" --apply
 *   npx tsx scripts/ai-mayor-utility-laying-live.ts --prefab "Small Sewage Pipe" --seed 1039,536
 *
 * The world must be paused and native Idle, or the Bridge answers its
 * single-flight 409 and every probe retries.
 */
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCanonicalDurableStateStorage } from "../src/main/services/ai-mayor/v2/durable-storage";
import { createV2FoundationPorts, parseV2McpJson } from "../src/main/services/ai-mayor/v2/main-adapter";
import { createV2RuntimeRoadCaller } from "../src/main/services/ai-mayor/v2/runtime-road-caller";
import type { RoadGeometryInput } from "../src/main/services/ai-mayor/v2/road-kernel";
import {
  isUtilityNetPrefab,
  layUtilityAlongRoadComponent,
  planUtilityStreetsAlongComponent,
  selectUtilityStreetsInBounds,
  UTILITY_NET_PREFABS,
  type UtilityComponentLayingReport,
  type UtilityStreetSourceEdge,
} from "../src/main/services/ai-mayor/v2/utility-network-laying";

const serverPath = process.env.CS2_MCP_SERVER ?? "D:\\github\\cities-skylines-2-mcp-master\\mcp-server\\dist\\index.js";
const BRIDGE = process.env.CS2_BRIDGE ?? "http://127.0.0.1:8642";

/**
 * Tools the durability layer requires that this MCP server build does not
 * expose, served from the HTTP bridge instead.
 *
 * `cs2_saves` is the only one: `findLoadedWorldSave` needs the save catalogue to
 * bind the loaded save to the durable lineage, and it is present on the bridge
 * as `/game/saves` with exactly the fields that reader consumes. Without it
 * every durable write dies on "Required MCP tool is not connected: cs2_saves",
 * which has nothing to do with what this script is proving.
 */
const HTTP_SHIMS: Record<string, string> = { cs2_saves: "/game/saves" };

const argv = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const PREFAB = argOf("--prefab") ?? "Low-voltage Ground Cable";
const SEED = (argOf("--seed") ?? "1039,536").split(",").map(Number) as [number, number];
const APPLY = argv.includes("--apply");
/** Cap on how many streets this run may touch. 0 means every street of the component. */
const MAX_STREETS = Number(argOf("--max-streets") ?? 0) || 0;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

interface GraphNode { entity: { index: number; version: number }; position: { x: number; y: number; z: number } }
interface GraphEdge {
  entity: { index: number; version: number };
  prefab: string;
  startNode: { index: number; version: number };
  endNode: { index: number; version: number };
  start: { x: number; z: number };
  end: { x: number; z: number };
  length: number;
}

/**
 * The road component holding the node nearest the seed.
 *
 * Components are the connected components of the road graph: a facility's
 * Marker attaches to ONE road edge, and every street road-connected to it is
 * what that attachment can reach. So the streets to cover are exactly the
 * edges of this component, not a radius.
 */
function componentEdges(nodes: GraphNode[], edges: GraphEdge[], seed: [number, number]): { root: string; edges: GraphEdge[]; nodes: GraphNode[] } {
  const key = (ref: { index: number }) => String(ref.index);
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    let root = value;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const node of nodes) if (!parent.has(key(node.entity))) parent.set(key(node.entity), key(node.entity));
  for (const edge of edges) {
    if (!parent.has(key(edge.startNode))) parent.set(key(edge.startNode), key(edge.startNode));
    if (!parent.has(key(edge.endNode))) parent.set(key(edge.endNode), key(edge.endNode));
    union(key(edge.startNode), key(edge.endNode));
  }
  const nearest = nodes
    .map((node) => ({ node, distance: Math.hypot(node.position.x - seed[0], node.position.z - seed[1]) }))
    .sort((left, right) => left.distance - right.distance)[0];
  if (!nearest) throw new Error("road graph has no nodes");
  const root = find(key(nearest.node.entity));
  return {
    root,
    edges: edges.filter((edge) => find(key(edge.startNode)) === root),
    nodes: nodes.filter((node) => find(key(node.entity)) === root),
  };
}

/** The net edges this prefab already has, read from the listing the bridge holds. */
async function placedNetEdges(prefab: string): Promise<Array<{ sx: number; sz: number; ex: number; ez: number }>> {
  const response = await fetch(`${BRIDGE}/city/roads?query=${encodeURIComponent(prefab)}`, { signal: AbortSignal.timeout(60000) });
  const body = record(await response.json());
  const roads = Array.isArray(body.roads) ? body.roads.map(record) : [];
  const edges: Array<{ sx: number; sz: number; ex: number; ez: number }> = [];
  for (const road of roads) {
    if (String(road.prefab ?? "") !== prefab) continue;
    const start = record(road.start);
    const end = record(road.end);
    const sx = Number(start.x); const sz = Number(start.z); const ex = Number(end.x); const ez = Number(end.z);
    if (![sx, sz, ex, ez].every(Number.isFinite)) continue;
    edges.push({ sx, sz, ex, ez });
  }
  return edges;
}

/** Whether a planned course is already carried by one of those edges, either way round. */
function courseAlreadyPlaced(
  course: RoadGeometryInput,
  placed: ReadonlyArray<{ sx: number; sz: number; ex: number; ez: number }>,
): boolean {
  const near = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz) <= 1;
  return placed.some((edge) =>
    (near(edge.sx, edge.sz, course.x1, course.z1) && near(edge.ex, edge.ez, course.x2, course.z2)) ||
    (near(edge.sx, edge.sz, course.x2, course.z2) && near(edge.ex, edge.ez, course.x1, course.z1)));
}

/** Native's own words for why a course was refused, taken from the 409 body. */
function refusalOf(error: unknown): string {
  const details = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const body = record(details.body);
  const nativeErrors = Array.isArray(body.nativeToolErrors) ? body.nativeToolErrors.map(record) : [];
  const names = nativeErrors
    .map((entry) => {
      const prefab = record(entry.errorPrefab);
      return String(prefab.name ?? entry.errorType ?? "unknown");
    })
    .filter((name, index, all) => all.indexOf(name) === index);
  if (names.length > 0) return `nativeToolErrors=[${names.join(", ")}]`;
  const diagnostics = record(body.rejectionDiagnostics);
  if (typeof diagnostics.stage === "string") return `${diagnostics.stage}:${diagnostics.errorType ?? "unknown"}`;
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  if (!isUtilityNetPrefab(PREFAB)) {
    throw new Error(`prefab '${PREFAB}' is not a net pipe/cable. Known: ${UTILITY_NET_PREFABS.join(", ")}`);
  }

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "5ire-ai-mayor-utility-laying", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => parseV2McpJson(await client.callTool({ name, arguments: args }));

  const gameState = record(await call("cs2_game_state", {}));
  const world = record(gameState.world);
  const simulation = record(gameState.simulation);
  console.log(`world=${world.worldId} gen=${world.generation} busy=${world.nativeOperationBusy} paused=${simulation.paused}`);
  if (gameState.gameMode !== "Game" || gameState.cityLoaded !== true || gameState.isLoading !== false ||
    world.worldReady !== true || simulation.paused !== true || world.nativeOperationBusy !== false) {
    throw new Error("LIVE_WORLD_NOT_PAUSED_READY_AND_IDLE");
  }

  const scan = record(await call("cs2_spatial", { mode: "scan", roadLimit: 2000 }));
  const graph = record(scan.roadGraph);
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []) as GraphNode[];
  const edges = (Array.isArray(graph.edges) ? graph.edges : []) as GraphEdge[];
  if (graph.truncated === true) throw new Error("ROAD_GRAPH_TRUNCATED");
  const component = componentEdges(nodes, edges, SEED);
  console.log(`\ncomponent root=${component.root}: ${component.nodes.length} nodes, ${component.edges.length} streets, ` +
    `${component.edges.reduce((sum, edge) => sum + edge.length, 0).toFixed(0)} m`);

  const componentStreets = component.edges.map((edge): UtilityStreetSourceEdge => ({
    entity: edge.entity, start: { x: edge.start.x, z: edge.start.z }, end: { x: edge.end.x, z: edge.end.z },
  }));
  // Without --bbox the work unit is the whole component; with it, only the
  // streets whose midpoint is inside the box. A new district is road-connected
  // to the old city the moment it is built, so "the component" is the whole map.
  const BBOX = (argOf("--bbox") ?? "").split(",").map(Number);
  const scopedStreets = BBOX.length === 4 && BBOX.every(Number.isFinite)
    ? selectUtilityStreetsInBounds({
        edges: componentStreets,
        bounds: { minX: BBOX[0]!, minZ: BBOX[1]!, maxX: BBOX[2]!, maxZ: BBOX[3]! },
      })
    : componentStreets;
  if (BBOX.length === 4) {
    console.log(`bbox ${BBOX.join(",")} selects ${scopedStreets.length}/${componentStreets.length} streets`);
  }

  const plan = planUtilityStreetsAlongComponent({ prefab: PREFAB, edges: scopedStreets });
  console.log(`planned ${plan.length} course(s) with '${PREFAB}'`);

  if (!APPLY) {
    // READ-ONLY: the same `kind=net` dry run the product previews with.
    const verdicts: Array<{ edgeRef: string; length: number; status: string; detail?: string }> = [];
    for (const course of plan) {
      const length = Math.hypot(course.input.x2 - course.input.x1, course.input.z2 - course.input.z1);
      let status = "CERTIFIABLE";
      let detail: string | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const preview = record(await call("cs2_spatial", {
            mode: "preflight", kind: "net", ...course.input,
          }));
          if (preview.valid === true && preview.validNewRoadProposal === true) { status = "CERTIFIABLE"; break; }
          status = "REFUSED";
          detail = `valid=${preview.valid} validNewRoadProposal=${preview.validNewRoadProposal}`;
          break;
        } catch (error) {
          if (/another build operation is in progress/i.test(String(error))) { await new Promise((r) => setTimeout(r, 400)); continue; }
          status = "REFUSED";
          detail = refusalOf(error);
          break;
        }
      }
      if (status !== "CERTIFIABLE" && !detail) detail = "contention not resolved after 3 attempts";
      verdicts.push({ edgeRef: `${course.edgeRef.index}:${course.edgeRef.version}`, length: Math.round(length), status, ...(detail ? { detail } : {}) });
    }
    const byStatus = new Map<string, number>();
    for (const verdict of verdicts) byStatus.set(verdict.status, (byStatus.get(verdict.status) ?? 0) + 1);
    console.log(`\n--- PLAN ONLY (read-only) ---`);
    console.log(`verdicts: ${[...byStatus].map(([status, count]) => `${status}×${count}`).join(", ")}`);
    for (const verdict of verdicts) {
      console.log(`  ${verdict.edgeRef.padEnd(14)} ${String(verdict.length).padStart(4)}m  ${verdict.status}${verdict.detail ? `  ${verdict.detail}` : ""}`);
    }
    const report = { mode: "PLAN_ONLY", prefab: PREFAB, generation: world.generation, componentRoot: component.root, verdicts };
    // One file per prefab: a single plan path would let the second prefab's run
    // silently overwrite the first one's evidence.
    const planPath = `docs/ai-mayor/evidence/utility-laying-plan-${PREFAB.replace(/\W+/g, "-").toLowerCase()}.json`;
    fs.writeFileSync(planPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwrote ${planPath}`);
    // Close the stdio transport before returning: without this the MCP child
    // keeps the event loop alive and the process never exits, so a caller that
    // runs this once per prefab in a loop waits forever after the first one.
    await client.close().catch(() => {});
    return;
  }

  // APPLY: the production path, one command per street.
  //
  // The storage is the PRODUCTION one, not a memory copy: a command this run
  // writes must land in the same branch the running app reads, and be
  // reconcilable after a restart. `createCanonicalDurableStateStorage` resolves
  // the active execution branch itself, so the namespace it reports below is
  // the file that actually changed -- read the report, not this comment.
  const appDataPath = process.env.APPDATA;
  if (!appDataPath) throw new Error("APPDATA_UNAVAILABLE");
  const storage = createCanonicalDurableStateStorage(appDataPath);
  console.log(`\ndurable namespace in use: ${storage.namespaceId}`);
  const manager = {
    legacyList: async () => {
      const tools = (await client.listTools()).tools.map((tool) => ({ name: `live--${tool.name}` }));
      for (const name of Object.keys(HTTP_SHIMS)) {
        if (!tools.some((tool) => tool.name === `live--${name}`)) tools.push({ name: `live--${name}` });
      }
      return { tools };
    },
    legacyCall: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const shim = HTTP_SHIMS[name];
      let value: unknown;
      if (shim) {
        const params = new URLSearchParams(Object.entries(args ?? {}).map(([key, entry]) => [key, String(entry)]));
        const response = await fetch(`${BRIDGE}${shim}?${params.toString()}`, { signal: AbortSignal.timeout(120000) });
        value = await response.json();
      } else {
        value = parseV2McpJson(await client.callTool({ name, arguments: args }));
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };
  const ports = createV2FoundationPorts({
    getToolsManager: () => manager as never,
    durableStateStorage: storage,
  });
  const durability = ports.durability;
  if (!durability) throw new Error("V2_DURABILITY_NOT_CONFIGURED");
  const activation = durability.activate(gameState as never);
  console.log(`\nactivation: kind=${activation.kind} status=${activation.status} generation=${activation.world.generation}`);

  const caller = createV2RuntimeRoadCaller({
    road: ports.road,
    readWorldGeneration: async () => {
      const state = record(await call("cs2_game_state", {}));
      const generation = record(state.world).generation;
      if (typeof generation !== "string" || !generation) throw new Error("ROAD_CURRENT_WORLD_GENERATION_UNAVAILABLE");
      return generation;
    },
    preview: (input: RoadGeometryInput) => call("cs2_spatial", { mode: "preflight", kind: "net", ...input }) as Promise<unknown>,
  });

  const streetPrefabOf = new Map<string, string>(
    component.edges.map((edge) => [`${edge.entity.index}:${edge.entity.version}`, edge.prefab]),
  );
  const toSourceEdge = (edge: GraphEdge): UtilityStreetSourceEdge => ({
    entity: edge.entity, start: { x: edge.start.x, z: edge.start.z }, end: { x: edge.end.x, z: edge.end.z },
  });
  const owner = { ownerType: "MANUAL" as const, ownerId: "ai-mayor-utility-laying-live" };
  // A re-run must not stop on its own work. Native refuses a course whose pipe is
  // already there ("overlap"), and a refusal is fatal to the loop below, so a
  // street that already carries this prefab is dropped before the first command
  // instead of being rediscovered as a stop.
  const placed = await placedNetEdges(PREFAB);
  const pendingEdges: GraphEdge[] = [];
  const alreadyCovered: string[] = [];
  for (const course of plan) {
    if (courseAlreadyPlaced(course.input, placed)) {
      alreadyCovered.push(`${course.edgeRef.index}:${course.edgeRef.version}`);
      continue;
    }
    const edge = component.edges.find((candidate) =>
      candidate.entity.index === course.edgeRef.index && candidate.entity.version === course.edgeRef.version);
    if (edge) pendingEdges.push(edge);
  }
  if (alreadyCovered.length > 0) console.log(`already carrying '${PREFAB}': ${alreadyCovered.join(", ")}`);
  let remaining = pendingEdges.slice(0, MAX_STREETS > 0 ? MAX_STREETS : pendingEdges.length);
  if (MAX_STREETS > 0) console.log(`--max-streets ${MAX_STREETS}: this run may touch at most ${remaining.length} street(s)`);

  const streets: Array<Record<string, unknown>> = [];
  const skipped: Array<{ edgeRef: string; reason: string }> = [];
  let stoppedOn: string | null = null;
  // One street per call, so a native refusal is contained to the street that
  // earned it. `layUtilityAlongRoadComponent` is still the executor; it is just
  // handed one edge, which yields exactly one course.
  for (const edge of remaining) {
    const key = `${edge.entity.index}:${edge.entity.version}`;
    let report: UtilityComponentLayingReport;
    try {
      report = await layUtilityAlongRoadComponent({
        prefab: PREFAB,
        edges: [toSourceEdge(edge)],
        owner,
        execute: (task, signal) => {
          const input = task.input as RoadGeometryInput;
          console.log(`  → ${key} ${input.x1.toFixed(1)},${input.z1.toFixed(1)} → ${input.x2.toFixed(1)},${input.z2.toFixed(1)}`);
          return caller.execute(task as never, signal);
        },
      });
    } catch (error) {
      // Native refused the course before it was ever submitted (game validation:
      // overlap / water / steep terrain / protected entity). That is a property
      // of this street, not of the channel, so it is recorded and stepped over
      // rather than allowed to hide every street after it. This is the same
      // treatment a bridge street already got, and it is why each refusal is
      // named in the report instead of being silently dropped.
      skipped.push({ edgeRef: key, reason: refusalOf(error) });
      console.log(`  SKIP refused ${key} (${streetPrefabOf.get(key)}): ${refusalOf(error)}`);
      continue;
    }
    const street = report.streets[0]!;
    streets.push({
      edgeRef: key,
      streetPrefab: streetPrefabOf.get(key) ?? null,
      commandId: street.commandId, status: street.status, reconciliationStatus: street.reconciliationStatus,
      matcherResult: street.matcherResult, effectAbsenceProven: street.effectAbsenceProven, reason: street.reason,
    });
    if (street.matcherResult !== "MATCH") {
      stoppedOn = key;
      console.log(`\nSTOP: street ${key} (${streetPrefabOf.get(key)}) was submitted but did not read back`);
      break;
    }
  }

  console.log(`\n--- APPLY ---`);
  const matched = streets.filter((street) => street.matcherResult === "MATCH").length;
  console.log(`planned=${plan.length} alreadyCovered=${alreadyCovered.length} attempted=${streets.length} matched=${matched} skipped=${skipped.length} stoppedOn=${stoppedOn ?? "none"}`);
  for (const street of streets) {
    console.log(`  ${String(street.edgeRef).padEnd(14)} ${String(street.streetPrefab).padEnd(30)} commandId=${street.commandId}  ${street.status}/${street.reconciliationStatus}  ${street.matcherResult ?? "-"}  ${street.reason}`);
  }
  // One file per prefab, for the same reason the plan path is per prefab: a
  // single apply path lets the second prefab's run silently overwrite the first
  // one's evidence.
  const evidencePath = `docs/ai-mayor/evidence/utility-laying-apply-${PREFAB.replace(/\W+/g, "-").toLowerCase()}.json`;
  fs.writeFileSync(evidencePath, `${JSON.stringify({
    mode: "APPLY", prefab: PREFAB, generation: world.generation, componentRoot: component.root,
    durableNamespace: storage.namespaceId, maxStreets: MAX_STREETS,
    planned: plan.length, alreadyCovered, matched, skipped, stoppedOn, streets,
  }, null, 2)}\n`);
  console.log(`\nwrote ${evidencePath}`);
  console.log(`\nNEXT: run a bounded simulation window, then census consumerService for this component.`);
  // Only a run that was meant to cover the whole component is required to have
  // covered it, and "covered it" means every street is accounted for: laid,
  // already carrying the prefab, or refused by native. A refusal is an outcome
  // this run reports, not a street it lost track of. A deliberately bounded run
  // (`--max-streets`) is a probe and is never an error.
  const accountedFor = streets.length + skipped.length + alreadyCovered.length;
  if (MAX_STREETS === 0 && (stoppedOn || accountedFor < plan.length)) {
    throw new Error(`UTILITY_LAYING_RUN_INCOMPLETE: accounted ${accountedFor}/${plan.length} (laid ${streets.length}, refused ${skipped.length}, alreadyCovered ${alreadyCovered.length}), stoppedOn=${stoppedOn ?? "none"}`);
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
