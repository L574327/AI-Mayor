import type { SpatialEntityRef, SpatialPoint2 } from "../spatial/types";

export type UtilityNetKind = "ELECTRICITY" | "WATER" | "SEWAGE";

/**
 * Which of the three nets a district still needs a facility for.
 *
 * WHY CONNECTIVITY AND NOT DISTANCE. A facility's marker attaches to ONE road
 * edge, and its service reaches every street road-connected to it — measured
 * 2026-10-02: a district 300-800 m from the nearest water facility read 9/10
 * water and 9/10 sewage with no pipe of either kind laid in it. So "is there a
 * water facility nearby" is the wrong question: a facility on the far side of a
 * river is near and useless, and one 800 m up the same component is far and
 * works. The question is whether a facility of that net sits on the SAME road
 * component as the district's streets.
 *
 * The component is computed over the street node graph the caller already read;
 * nothing here talks to the world.
 */
export interface ServiceReachStreet {
  ref: SpatialEntityRef;
  startNode: SpatialEntityRef;
  endNode: SpatialEntityRef;
  start: SpatialPoint2;
  end: SpatialPoint2;
}

export interface ServiceReachFacility {
  kind: UtilityNetKind;
  position: SpatialPoint2;
}

export interface ServiceReachReport {
  /** Nets with no facility on the district's component: these are the ones to place. */
  missing: UtilityNetKind[];
  /** Nets already served from the component, and the facility that serves them. */
  served: Array<{ kind: UtilityNetKind; facilityIndex: number; streetRef: SpatialEntityRef }>;
  /** Facility indices that landed on no street at all and were ignored. */
  unreachable: number[];
  componentStreets: number;
}

const key = (ref: SpatialEntityRef): string => `${ref.index}:${ref.version}`;

const pointToSegmentDistance = (point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number => {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.z - (start.z + ratio * dz));
};

/**
 * How far a facility's marker can carry its net to a district.
 *
 * WHY 600 m AND WHY THIS IS A CEILING, NOT A LAW. `netsMissingService` asks
 * whether the facility is on the SAME component, which the 2026-10-02 district
 * showed is necessary but NOT sufficient: on one component it read water 18/18
 * and electricity 1/18, and the difference was where the facilities sat. Placing
 * a turbine 569 m away, cabled onto the district's own street, took electricity
 * from 1/18 to 18/18 in eight in-game hours.
 *
 * The measurements that bound it (2026-10-02, this world, euclidean / graph-path
 * metres from the district to the facility's attached street, and whether the
 * district was served):
 *
 *   WindTurbine03        569 /  680  served 18/18
 *   GroundwaterPumping   611 / 1145  served 18/18
 *   WindTurbine03       1122 / 1265  served  ~8%
 *   WindTurbine03       1021 / 1323  served  ~8%
 *   SewageOutlet01      1389 / 1465  served   0%
 *
 * No single metric is pinned by this data — a euclidean bound in (611, 1021] and
 * a graph bound in (1145, 1265] both fit every row — so 600 m is chosen as the
 * CONSERVATIVE euclidean radius that is proven sufficient for every net, and
 * exceeding it is not a verdict that the facility is useless: it is the point at
 * which the caller must place a nearer one instead of trusting the far one.
 */
export const DEFAULT_SERVICE_REACH_METERS = 600;

export interface ServiceReachFacilityReport {
  kind: UtilityNetKind;
  /** Facility indices of this net, nearest first. */
  facilityIndices: number[];
  /** Euclidean distance from the district's own streets to the nearest one. */
  nearestEuclideanMeters: number;
  /** Shortest path over the street graph to the street the facility sits on, or null when unreachable. */
  nearestGraphMeters: number | null;
  /** True when a facility of this net is inside `maxReachMeters` of the district. */
  withinReach: boolean;
  /** True when that facility is road-connected to the district at all. */
  onComponent: boolean;
}

export interface ServiceReachByNetReport {
  nets: ServiceReachFacilityReport[];
  /** Nets with no facility inside the reach: place one of these near the district. */
  needsPlacement: UtilityNetKind[];
}

/**
 * Per net: is there a facility close enough to serve this district, and if not,
 * how far is the nearest one?
 *
 * `netsMissingService` answers "is there a facility on my component". This
 * answers the question that measurement left open — "is one close enough to
 * actually reach me" — and the two disagree exactly when the far side of the
 * component holds the facility. Distance is measured from the district's OWN
 * streets, so a facility across the map on the same component is far, not
 * present.
 */
export function serviceReachByNet(input: {
  streets: readonly ServiceReachStreet[];
  districtStreetRefs: readonly SpatialEntityRef[];
  facilities: readonly ServiceReachFacility[];
  nets?: readonly UtilityNetKind[];
  maxReachMeters?: number;
}): ServiceReachByNetReport {
  const nets = input.nets ?? (["ELECTRICITY", "WATER", "SEWAGE"] as const);
  const maxReachMeters = input.maxReachMeters ?? DEFAULT_SERVICE_REACH_METERS;

  const districtRefs = new Set(input.districtStreetRefs.map(key));
  const districtStreets = input.streets.filter((street) => districtRefs.has(key(street.ref)));
  const districtNodes = new Set<string>();
  for (const street of districtStreets) {
    districtNodes.add(key(street.startNode));
    districtNodes.add(key(street.endNode));
  }

  // Graph distances from the district, over the streets the caller read.
  const adjacency = new Map<string, Array<{ to: string; weight: number }>>();
  for (const street of input.streets) {
    const start = key(street.startNode); const end = key(street.endNode);
    const weight = Math.hypot(street.end.x - street.start.x, street.end.z - street.start.z);
    adjacency.set(start, [...(adjacency.get(start) ?? []), { to: end, weight }]);
    adjacency.set(end, [...(adjacency.get(end) ?? []), { to: start, weight }]);
  }
  const distance = new Map<string, number>();
  for (const node of districtNodes) distance.set(node, 0);
  const frontier = [...districtNodes];
  while (frontier.length > 0) {
    let best = 0;
    for (let index = 1; index < frontier.length; index += 1) {
      if ((distance.get(frontier[index]!) ?? Number.POSITIVE_INFINITY) < (distance.get(frontier[best]!) ?? Number.POSITIVE_INFINITY)) best = index;
    }
    const current = frontier.splice(best, 1)[0]!;
    for (const step of adjacency.get(current) ?? []) {
      const candidate = (distance.get(current) ?? 0) + step.weight;
      if (candidate < (distance.get(step.to) ?? Number.POSITIVE_INFINITY)) {
        distance.set(step.to, candidate);
        frontier.push(step.to);
      }
    }
  }

  const reports = nets.map((kind) => {
    const ofKind = input.facilities.flatMap((facility, index) => facility.kind === kind ? [{ facility, index }] : []);
    let best: { index: number; euclidean: number; graph: number | null } | null = null;
    for (const { facility, index } of ofKind) {
      let euclidean = Number.POSITIVE_INFINITY;
      let graph: number | null = null;
      for (const street of districtStreets) {
        euclidean = Math.min(euclidean, pointToSegmentDistance(facility.position, street.start, street.end));
      }
      // The graph distance is to the street the facility ATTACHES to: the
      // nearest street in the whole read, which is where its marker lands.
      let attached: ServiceReachStreet | null = null;
      let attachedDistance = Number.POSITIVE_INFINITY;
      for (const street of input.streets) {
        const candidate = pointToSegmentDistance(facility.position, street.start, street.end);
        if (candidate < attachedDistance) { attachedDistance = candidate; attached = street; }
      }
      if (attached) {
        const reachA = distance.get(key(attached.startNode)) ?? Number.POSITIVE_INFINITY;
        const reachB = distance.get(key(attached.endNode)) ?? Number.POSITIVE_INFINITY;
        graph = Number.isFinite(reachA) || Number.isFinite(reachB) ? Math.min(reachA, reachB) : null;
      }
      if (!best || euclidean < best.euclidean) best = { index, euclidean, graph };
    }
    const withinReach = best !== null && best.euclidean <= maxReachMeters;
    return {
      kind,
      facilityIndices: ofKind.map((entry) => entry.index),
      nearestEuclideanMeters: best?.euclidean ?? Number.POSITIVE_INFINITY,
      nearestGraphMeters: best?.graph ?? null,
      withinReach,
      onComponent: best?.graph !== null && best?.graph !== undefined,
    };
  });

  return { nets: reports, needsPlacement: reports.filter((report) => !report.withinReach).map((report) => report.kind) };
}

/**
 * Whether THIS scope's own service is unsatisfied, given what the city says.
 *
 * WHY THE CITY READ IS NOT ENOUGH. The capacity a commissioning pass reads is
 * city-wide: `supply >= load` over the whole map. That is a true statement about
 * the city and a false one about a district. Measured live 2026-10-02 (this
 * world): the district the Mayor was growing sits on its own 66-street road
 * component, while the city's spare capacity lived on the main network 1.7 km
 * away across it. `issueActive` was false, the recovery seam answered
 * `no_action_needed`, and the district stayed unserved while the snapshot said
 * there was headroom to spare.
 *
 * So the scope's own reach joins the predicate. `cityIssueActive` stands as
 * given — this function never turns an active city issue off, it only refuses to
 * let a quiet city speak for a scope that cannot be reached.
 *
 * A scope whose streets the read does not contain is left alone: an unread world
 * is not evidence of a missing facility, and answering "place one" out of a
 * failed read is exactly the fabricated capability this file exists to avoid.
 */
export function scopeNeedsService(input: {
  cityIssueActive: boolean;
  kind: UtilityNetKind;
  streets: readonly ServiceReachStreet[];
  /** The scope's own streets — the ones its service has to reach. */
  districtStreetRefs: readonly SpatialEntityRef[];
  facilities: readonly ServiceReachFacility[];
  maxReachMeters?: number;
}): boolean {
  if (input.cityIssueActive) return true;
  if (input.districtStreetRefs.length === 0) return false;
  const known = new Set(input.streets.map((street) => key(street.ref)));
  if (!input.districtStreetRefs.some((ref) => known.has(key(ref)))) return false;
  return serviceReachByNet({
    streets: input.streets,
    districtStreetRefs: input.districtStreetRefs,
    facilities: input.facilities,
    nets: [input.kind],
    maxReachMeters: input.maxReachMeters,
  }).needsPlacement.includes(input.kind);
}

export function netsMissingService(input: {
  streets: readonly ServiceReachStreet[];
  /** The district's own streets; their component is the one that matters. */
  districtStreetRefs: readonly SpatialEntityRef[];
  facilities: readonly ServiceReachFacility[];
  nets?: readonly UtilityNetKind[];
}): ServiceReachReport {
  const nets = input.nets ?? (["ELECTRICITY", "WATER", "SEWAGE"] as const);
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    let root = value;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };
  for (const street of input.streets) {
    for (const node of [street.startNode, street.endNode]) {
      const nodeKey = key(node);
      if (!parent.has(nodeKey)) parent.set(nodeKey, nodeKey);
    }
    union(key(street.startNode), key(street.endNode));
  }

  const districtRefs = new Set(input.districtStreetRefs.map(key));
  const districtStreet = input.streets.find((street) => districtRefs.has(key(street.ref)));
  const districtRoot = districtStreet ? find(key(districtStreet.startNode)) : null;
  const componentStreets = districtRoot === null
    ? 0
    : input.streets.filter((street) => find(key(street.startNode)) === districtRoot).length;

  const served: ServiceReachReport["served"] = [];
  const unreachable: number[] = [];
  const servedNets = new Set<UtilityNetKind>();

  for (const [facilityIndex, facility] of input.facilities.entries()) {
    let nearest: { street: ServiceReachStreet; distance: number } | null = null;
    for (const street of input.streets) {
      const distance = pointToSegmentDistance(facility.position, street.start, street.end);
      if (!nearest || distance < nearest.distance) nearest = { street, distance };
    }
    if (!nearest) {
      unreachable.push(facilityIndex);
      continue;
    }
    const onDistrictComponent = districtRoot !== null && find(key(nearest.street.startNode)) === districtRoot;
    if (!onDistrictComponent) continue;
    served.push({ kind: facility.kind, facilityIndex, streetRef: nearest.street.ref });
    servedNets.add(facility.kind);
  }

  return {
    missing: nets.filter((net) => !servedNets.has(net)),
    served,
    unreachable,
    componentStreets,
  };
}
