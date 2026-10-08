#!/usr/bin/env node
/**
 * Read-only. Road-course certification sweep.
 *
 * WHY THIS EXISTS
 * ---------------
 * A live Mayor cycle that cannot find a road reports
 * `NO_FEASIBLE_GATE1_ROAD_CANDIDATE`, and its candidates come from the bounded
 * heading family (`site-selection.ts:1064 resolveBoundedRoadCandidates`, a 25
 * degree cone) — not from a systematic search. Measured 2026-10-01: the set of
 * courses a node will actually certify is SPARSE and varies per node AND per
 * length (at `75948:215`, one of sixteen heading×length probes was accepted; at
 * `52196:1`, five of eight headings were). A cone fan does not contain those.
 *
 * This sweeps heading × length against the same dry-run endpoint the product
 * previews with (`main-adapter.ts:6681`, tool `cs2_spatial` mode=preflight),
 * so it answers "what can be built here" with native as the only authority.
 * Nothing is built and nothing is authorized: `/spatial/preflight` is a dry run.
 *
 * USAGE
 *   node scripts/ai-mayor-road-certification-sweep.cjs                 # nearest node to each seed target
 *   node scripts/ai-mayor-road-certification-sweep.cjs --node 75948:215
 *   node scripts/ai-mayor-road-certification-sweep.cjs --json out.json
 *
 * HARD CONSTRAINT (learned the hard way): when `startEndpoint` is sent, native
 * validates `expectedPosition` EXACTLY. The coordinates MUST come from
 * `/spatial/bootstrap-scan`, never from arithmetic — a rounded value fails with
 * `ROAD_ENDPOINT_POSITION_MISMATCH` before any road question is asked.
 *
 * The two native verdicts mean different things and must not be collapsed:
 *   NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED -> no proposal edge at this heading (try another)
 *   operation blocked by game validation  -> edge formed, placement refused   (try another length/position)
 */
const fs = require("fs");

const BASE = process.env.CS2_BRIDGE ?? "http://127.0.0.1:8642";
const PREFAB = process.env.CS2_ROAD_PREFAB ?? "Medium Road";
const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const LENGTHS = [16, 24, 40];

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const NODE_ARG = argOf("--node");
const JSON_OUT = argOf("--json");

/** Seeds used only to pick which nodes to sweep; the coordinates come from the scan. */
const SEED_TARGETS = [
  { name: "electricity-goal-target", x: 1355, z: 425 },
  { name: "commercial-cluster-centre", x: 750, z: 600 },
];

const q = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const get = async (path) => {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) });
  const body = await res.json();
  return body;
};

async function preflight(epoch, node, x2, z2) {
  const startEndpoint = {
    kind: "EXISTING_NET_NODE", role: "START",
    entity: node.entity,
    expectedPosition: { x: node.position.x, y: node.position.y, z: node.position.z },
    worldEpoch: epoch,
  };
  const r = await get("/spatial/preflight?" + q({
    mode: "preflight", kind: "net", prefab: PREFAB,
    x1: node.position.x, z1: node.position.z, x2, z2,
    startEndpoint: JSON.stringify(startEndpoint),
  }));
  return {
    valid: r.valid === true,
    error: r.error ?? null,
    firstFailure: r.courseIntegrity?.firstFailure ?? null,
    proposalEdgeCount: r.courseIntegrity?.proposalEdgeCount ?? null,
  };
}

(async () => {
  const scan = await get("/spatial/bootstrap-scan?roadLimit=800");
  const nodes = scan.roadGraph?.nodes ?? [];
  const epoch = String(scan.worldEpoch ?? "epoch");
  if (!nodes.length) throw new Error("scan returned no road nodes; is the city loaded and the bridge up?");
  console.log(`scan: nodes=${nodes.length} edges=${(scan.roadGraph?.edges ?? []).length} worldEpoch=${epoch} prefab="${PREFAB}"`);

  const byRef = new Map(nodes.map((n) => [`${n.entity.index}:${n.entity.version}`, n]));
  const chosen = [];
  if (NODE_ARG) {
    const n = byRef.get(NODE_ARG);
    if (!n) throw new Error(`node ${NODE_ARG} is not in the live topology`);
    chosen.push({ name: `node ${NODE_ARG}`, node: n });
  } else {
    for (const t of SEED_TARGETS) {
      let best = null;
      for (const n of nodes) {
        const d = Math.hypot(n.position.x - t.x, n.position.z - t.z);
        if (!best || d < best.d) best = { node: n, d };
      }
      chosen.push({ name: `${t.name} (${t.x},${t.z})`, node: best.node, distance: best.d });
    }
  }

  const evidence = { prefab: PREFAB, worldEpoch: epoch, sweptAt: null, nodes: [] };
  for (const c of chosen) {
    const n = c.node;
    console.log(`\n=== ${c.name} -> node ${n.entity.index}:${n.entity.version} `
      + `(${n.position.x.toFixed(1)},${n.position.z.toFixed(1)}) roadDegree=${n.roadDegree}`
      + (c.distance !== undefined ? ` d=${c.distance.toFixed(1)}m` : ""));
    const entry = { node: n.entity, position: n.position, roadDegree: n.roadDegree, courses: [] };
    for (const len of LENGTHS) {
      const row = [];
      for (const heading of HEADINGS) {
        const rad = (heading * Math.PI) / 180;
        const r = await preflight(epoch, n, n.position.x + Math.cos(rad) * len, n.position.z + Math.sin(rad) * len);
        const label = r.valid ? "OK" : String(r.error ?? r.firstFailure ?? "?").replace(/^operation blocked.*/, "placement refused").slice(0, 20);
        row.push(`${String(heading).padStart(3)}°=${label.padEnd(20)}`);
        entry.courses.push({ heading, lengthMeters: len, valid: r.valid, error: r.error, firstFailure: r.firstFailure, proposalEdgeCount: r.proposalEdgeCount });
      }
      console.log(`  len=${String(len).padStart(2)}m  ` + row.join(" "));
    }
    const ok = entry.courses.filter((x) => x.valid);
    console.log(`  certifiable: ${ok.length}/${entry.courses.length}`
      + (ok.length ? `  -> ${ok.map((x) => `${x.heading}°@${x.lengthMeters}m`).join(", ")}` : "  -> none at these headings/lengths"));
    evidence.nodes.push(entry);
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`\nevidence written to ${JSON_OUT}`);
  }
})().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
