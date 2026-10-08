import { evaluateBootstrapSites } from "../src/main/services/ai-mayor/spatial/site-finder";
import type { SpatialSiteDetail } from "../src/main/services/ai-mayor/spatial/types";
import { planBootstrapUtilities, splitUtilityConnection } from "../src/main/services/ai-mayor/spatial/utility-planner";
import { buildSpatialWorldModel, parseSpatialBootstrapScan } from "../src/main/services/ai-mayor/spatial/world-scanner";

const bridgeBase = process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642";
const runPreflight = process.argv.includes("--preflight");

async function bridgeJson(path: string): Promise<unknown> {
  const response = await fetch(`${bridgeBase}${path}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`Bridge ${response.status}: ${body}`);
  return JSON.parse(body);
}

async function preflight(params: URLSearchParams): Promise<{ valid: boolean; response?: unknown; error?: string }> {
  try {
    const response = await bridgeJson(`/spatial/preflight?${params.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { valid: true, response };
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseSiteDetail(value: unknown): SpatialSiteDetail {
  if (!value || typeof value !== "object") throw new Error("site detail response must be an object");
  const detail = value as Partial<SpatialSiteDetail>;
  if (!detail.center || !detail.terrain || !detail.roadGraph) throw new Error("site detail response is incomplete");
  if (!Array.isArray(detail.terrain.heights) || !Array.isArray(detail.terrain.waterDepths)) {
    throw new Error("site detail response lacks terrain arrays");
  }
  if (!Array.isArray(detail.buildings) || !Array.isArray(detail.zoningCells)) {
    throw new Error("site detail response lacks building or zoning arrays");
  }
  return detail as SpatialSiteDetail;
}

async function main(): Promise<void> {
  const state = (await bridgeJson("/state")) as {
    cityLoaded?: boolean;
    cityName?: string;
    simulation?: { paused?: boolean };
  };
  if (!state.cityLoaded) throw new Error("load a city before running spatial dry-run");
  if (!state.simulation?.paused) throw new Error("spatial dry-run requires a paused simulation");

  const scan = parseSpatialBootstrapScan(await bridgeJson("/spatial/bootstrap-scan?roadLimit=2000"));
  const model = buildSpatialWorldModel(scan);
  const candidateConnections = model.connectionCandidates.slice(0, 12);
  const details = new Map<string, SpatialSiteDetail>();
  for (const candidate of candidateConnections) {
    const { x, z } = candidate.node.position;
    const detail = parseSiteDetail(await bridgeJson(`/spatial/site-detail?x=${x}&z=${z}&radius=512&resolution=128`));
    details.set(`${candidate.node.entity.index}:${candidate.node.entity.version}`, detail);
  }
  const evaluations = evaluateBootstrapSites(model, details);
  const selected = evaluations.find((evaluation) => evaluation.valid) ?? null;
  let utilityPlan = null;
  if (selected) {
    const tileBounds = model.ownedTiles.flatMap((tile) => (tile.bounds ? [tile.bounds] : []));
    if (tileBounds.length === 0) throw new Error("owned tiles have no bounds for utility scan");
    const minX = Math.min(...tileBounds.map((bounds) => bounds.min.x));
    const minZ = Math.min(...tileBounds.map((bounds) => bounds.min.z));
    const maxX = Math.max(...tileBounds.map((bounds) => bounds.max.x));
    const maxZ = Math.max(...tileBounds.map((bounds) => bounds.max.z));
    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const radius = Math.min(2048, Math.ceil(Math.max(maxX - minX, maxZ - minZ) * 0.5 + 64));
    const areaDetail = parseSiteDetail(
      await bridgeJson(`/spatial/site-detail?x=${centerX}&z=${centerZ}&radius=${radius}&resolution=128`),
    );
    utilityPlan = planBootstrapUtilities(model, selected, areaDetail, scan.bootstrapAssets);
  }
  const preflightResults: Array<Record<string, unknown>> = [];
  if (runPreflight && selected && utilityPlan) {
    const roadSegments = [
      ...selected.layout.segments,
      ...utilityPlan.facilities.flatMap((facility) => facility.serviceRoads ?? []),
    ];
    for (const segment of roadSegments) {
      const params = new URLSearchParams({
        kind: "net",
        prefab: "Small Road",
        x1: String(segment.start.x),
        z1: String(segment.start.z),
        x2: String(segment.end.x),
        z2: String(segment.end.z),
      });
      preflightResults.push({ type: "road", id: segment.id, ...(await preflight(params)) });
    }
    for (const utility of utilityPlan.facilities) {
      if ((utility.serviceRoads?.length ?? 0) > 0) {
        preflightResults.push({
          type: "utility_connection",
          kind: utility.kind,
          skipped: true,
          reason: "service_road_network",
          valid: true,
        });
      }
      for (const [segmentIndex, connection] of ((utility.serviceRoads?.length ?? 0) > 0
        ? []
        : splitUtilityConnection(utility.connection)
      ).entries()) {
        const netParams = new URLSearchParams({
          kind: "net",
          prefab: connection.prefab,
          x1: String(connection.start.x),
          z1: String(connection.start.z),
          x2: String(connection.end.x),
          z2: String(connection.end.z),
        });
        preflightResults.push({
          type: "utility_connection",
          kind: utility.kind,
          segmentIndex,
          ...(await preflight(netParams)),
        });
      }

      const rotationAttempts: Array<Record<string, unknown>> = [];
      for (const rotation of utility.rotationCandidates) {
        const objectParams = new URLSearchParams({
          kind: "object",
          prefab: utility.prefab,
          x: String(utility.position.x),
          z: String(utility.position.z),
          rotation: String(rotation),
        });
        const result = await preflight(objectParams);
        rotationAttempts.push({ rotation, ...result });
        if (result.valid) break;
      }
      preflightResults.push({
        type: "facility",
        kind: utility.kind,
        prefab: utility.prefab,
        valid: rotationAttempts.some((attempt) => attempt.valid),
        attempts: rotationAttempts,
      });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "dry-run",
        mutatesGame: false,
        usesDeepSeek: false,
        cityName: state.cityName,
        candidateLimit: 12,
        candidates: evaluations,
        selected,
        utilityPlan,
        preflightRequested: runPreflight,
        preflightPassed:
          runPreflight && preflightResults.length > 0 && preflightResults.every((result) => result.valid === true),
        preflightResults,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
