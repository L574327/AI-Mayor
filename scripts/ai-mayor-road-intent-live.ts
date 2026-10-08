#!/usr/bin/env tsx
/**
 * Read-only. Drive one `ROAD{from,to}` through the road-intent module against
 * the live Bridge.
 *
 * WHY THIS EXISTS
 * ---------------
 * `road-intent.ts` claims it can turn a source node plus a target into an
 * executable, natively certified road by sweeping heading × length, because the
 * set of courses a node certifies is sparse and varies per node AND per length
 * (measured 2026-10-01: 1 of 24 at `75948:215`, 10 of 24 at `52196:1`). That is
 * a claim about native, so it can only be checked against native.
 *
 * This runs the module itself — `resolveRoadIntent` over the real
 * `mode=preflight` dry run the product previews with — so the report is the
 * module's own answer, not a re-implementation of it. Nothing is built and
 * nothing is authorized: every probe is a dry run.
 *
 * USAGE
 *   npx tsx scripts/ai-mayor-road-intent-live.ts
 *   npx tsx scripts/ai-mayor-road-intent-live.ts --node 75948:215
 *   npx tsx scripts/ai-mayor-road-intent-live.ts --node 52196:1 --to 900,622
 *   npx tsx scripts/ai-mayor-road-intent-live.ts --repeat 2      # show the cache removing probes
 *
 * The world must be paused and native idle, or the Bridge answers its
 * single-flight 409 and the module retries (which is itself worth watching —
 * `retries` below counts them).
 */
import {
  createRoadCourseCertificationCache,
  type RoadCourseCertificationCache,
} from "../src/main/services/ai-mayor/v2/road-course-sweep";
import {
  roadGraphRevision,
  resolveRoadIntent,
  type RoadIntent,
  type RoadIntentWorld,
} from "../src/main/services/ai-mayor/v2/road-intent";
import type { RoadGeometryInput } from "../src/main/services/ai-mayor/v2/road-kernel";
import type { SpatialRoadEdge, SpatialRoadNode } from "../src/main/services/ai-mayor/spatial/types";

const BASE = process.env.CS2_BRIDGE ?? "http://127.0.0.1:8642";
const PREFAB = process.env.CS2_ROAD_PREFAB ?? "Medium Road";
/** Cache scope only; the two measured runs used `cs2-session:d8413e4f`. */
const WORLD_ID = process.env.CS2_WORLD_ID ?? "cs2-session:live";

const argv = process.argv.slice(2);
const argOf = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const NODE_ARG = argOf("--node");
const TO_ARG = argOf("--to");
const REPEAT = Math.max(1, Number(argOf("--repeat") ?? 1) || 1);

/** Seeds only pick which node to drive; every coordinate comes from the scan. */
const SEED_TARGETS = [
  { name: "electricity-goal-target", x: 1355, z: 425 },
  { name: "commercial-cluster-centre", x: 750, z: 600 },
];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const get = async (path: string): Promise<Record<string, unknown>> => {
  const response = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) });
  return record(await response.json());
};

let probeCount = 0;
let contentionRetries = 0;

/**
 * The real dry run, built from the exact geometry the module hands back.
 *
 * The result is the module's own answer — the verdict classification, the
 * retry, and the fall-through between courses all live in `road-course-sweep`,
 * not here.
 */
const probe = async (input: RoadGeometryInput): Promise<unknown> => {
  probeCount += 1;
  const params = new URLSearchParams({
    mode: "preflight",
    kind: "net",
    prefab: input.prefab,
    x1: String(input.x1),
    z1: String(input.z1),
    x2: String(input.x2),
    z2: String(input.z2),
  });
  if (input.startEndpoint) params.set("startEndpoint", JSON.stringify(input.startEndpoint));
  const response = await fetch(`${BASE}/spatial/preflight?${params.toString()}`, { signal: AbortSignal.timeout(60000) });
  const body = record(await response.json());
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message
      : typeof body.error === "string" ? body.error
        : `HTTP ${response.status}`;
    if (/another build operation is in progress/i.test(message)) contentionRetries += 1;
    throw Object.assign(new Error(message), { status: response.status, body });
  }
  return body;
};

(async () => {
  const scan = await get("/spatial/bootstrap-scan?roadLimit=800");
  const roadGraph = record(scan.roadGraph);
  const nodes = (Array.isArray(roadGraph.nodes) ? roadGraph.nodes : []) as SpatialRoadNode[];
  const edges = (Array.isArray(roadGraph.edges) ? roadGraph.edges : []) as SpatialRoadEdge[];
  if (!nodes.length) throw new Error("scan returned no road nodes; is a city loaded and the bridge up?");

  const topologyRevision = roadGraphRevision({ nodes, edges });
  const world: RoadIntentWorld = {
    worldId: WORLD_ID,
    worldEpoch: String(scan.worldEpoch ?? "epoch"),
    topologyRevision,
    nodes,
  };
  console.log(`scan: nodes=${nodes.length} edges=${edges.length} topologyRevision=${topologyRevision} prefab="${PREFAB}"`);

  const chosen: Array<{ name: string; node: SpatialRoadNode }> = [];
  if (NODE_ARG) {
    const node = nodes.find((candidate) => `${candidate.entity.index}:${candidate.entity.version}` === NODE_ARG);
    if (!node) throw new Error(`node ${NODE_ARG} is not in the live topology`);
    chosen.push({ name: `node ${NODE_ARG}`, node });
  } else {
    for (const seed of SEED_TARGETS) {
      const nearest = nodes
        .map((node) => ({ node, distance: Math.hypot(node.position.x - seed.x, node.position.z - seed.z) }))
        .sort((left, right) => left.distance - right.distance)[0];
      chosen.push({ name: `${seed.name} (${seed.x},${seed.z})`, node: nearest.node });
    }
  }

  const cache: RoadCourseCertificationCache = createRoadCourseCertificationCache({
    worldId: world.worldId,
    topologyRevision: world.topologyRevision,
  });

  for (const { name, node } of chosen) {
    const to = TO_ARG
      ? { x: Number(TO_ARG.split(",")[0]), y: node.position.y, z: Number(TO_ARG.split(",")[1]) }
      : { x: node.position.x + 40, y: node.position.y, z: node.position.z };
    const intent: RoadIntent = {
      intentId: process.env.CS2_ROAD_INTENT_ID ?? "LIVE:ROAD:PROBE",
      prefab: PREFAB,
      from: { kind: "EXISTING_NET_NODE", entity: node.entity },
      to: { kind: "FREE_POINT", position: to },
      owner: { ownerType: "MANUAL", ownerId: "ai-mayor-road-intent-live" },
    };
    console.log(`\n=== ${name} -> node ${node.entity.index}:${node.entity.version} `
      + `(${node.position.x.toFixed(1)},${node.position.z.toFixed(1)}) roadDegree=${node.roadDegree}`);
    console.log(`    to (${to.x.toFixed(1)},${to.z.toFixed(1)})  intentId=${intent.intentId}`);

    for (let run = 0; run < REPEAT; run += 1) {
      probeCount = 0;
      contentionRetries = 0;
      const resolution = await resolveRoadIntent(intent, world, { probe, cache, retry: { attempts: 3, delayMs: 250 } });
      const suffix = REPEAT > 1 ? ` [run ${run + 1}/${REPEAT}]` : "";
      if (resolution.status === "CERTIFIED") {
        const { course } = resolution;
        console.log(`  CERTIFIED${suffix}: ordinal=${resolution.ordinal} heading=${course.headingDegrees.toFixed(1)}°`
          + ` (offset ${course.offsetDegrees}°) length=${course.lengthMeters}m`
          + ` endpoint=(${course.endpoint.x.toFixed(1)},${course.endpoint.z.toFixed(1)})`);
        console.log(`    operationId=${resolution.operationId}`);
        console.log(`    startEndpoint=${JSON.stringify(resolution.input.startEndpoint ?? null)}`);
        console.log(`    probes=${resolution.probes} cacheHit=${resolution.cacheHit} contentionRetries=${contentionRetries}`);
      } else if (resolution.status === "UNRESOLVED_CONTENTION") {
        console.log(`  UNRESOLVED_CONTENTION${suffix}: ${resolution.reason} (retries=${contentionRetries})`);
      } else {
        const histogram = new Map<string, number>();
        for (const rejection of resolution.rejections) {
          histogram.set(rejection.verdict, (histogram.get(rejection.verdict) ?? 0) + 1);
        }
        console.log(`  ${resolution.reason}${suffix}: ${resolution.detail ?? ""}`);
        console.log(`    refusals: ${[...histogram].map(([verdict, count]) => `${verdict}×${count}`).join(", ") || "none"}`);
        console.log(`    probes=${probeCount} contentionRetries=${contentionRetries}`);
      }
    }
  }
})().catch((error) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
