import type { SpatialEntityRef, SpatialPoint2, SpatialRoadEdge, SpatialRoadNode } from "../spatial/types";
import type {
  EffectMatcherResult,
  RoadEffectMatcher,
  V2CommandRecord,
  V2ObservationEnvelope,
  V2RoadEffectProvenance,
} from "./foundation";
import type { RoadEndpointAttachment, RoadGeometryInput } from "./road-kernel";

export interface RoadEffectReport {
  matcherResult: EffectMatcherResult;
  effectAbsenceProven: boolean;
  matchedEdges: SpatialEntityRef[];
  reason: string;
  observedEnvelope: {
    observationId: string;
    runtimeEpoch: string;
    coherence: V2ObservationEnvelope["coherence"];
    worldGeneration: string | null;
  };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const entityRef = (value: unknown): SpatialEntityRef | null => {
  const item = record(value);
  return Number.isInteger(item.index) && Number.isInteger(item.version)
    ? { index: Number(item.index), version: Number(item.version) }
    : null;
};

const point2 = (value: unknown): SpatialPoint2 | null => {
  const item = record(value);
  return finite(item.x) && finite(item.z) ? { x: item.x, z: item.z } : null;
};

const sameEntity = (left: SpatialEntityRef | null, right: SpatialEntityRef | undefined) =>
  !!left && !!right && left.index === right.index && left.version === right.version;

const distance = (left: SpatialPoint2, right: SpatialPoint2) => Math.hypot(left.x - right.x, left.z - right.z);

function distanceToSegment(point: SpatialPoint2, start: SpatialPoint2, end: SpatialPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return distance(point, start);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return distance(point, { x: start.x + projection * dx, z: start.z + projection * dz });
}

function parseRoadInput(command: V2CommandRecord): RoadGeometryInput | null {
  if (command.authorizedScope.actionFamily !== "ROAD") return null;
  try {
    const input = record(JSON.parse(command.authorizedScope.exactInput));
    if (
      typeof input.prefab !== "string" ||
      !finite(input.x1) ||
      !finite(input.z1) ||
      !finite(input.x2) ||
      !finite(input.z2)
    ) return null;
    return input as unknown as RoadGeometryInput;
  } catch {
    return null;
  }
}

function parseEdges(value: unknown): SpatialRoadEdge[] {
  if (!Array.isArray(value)) return [];
  const edges: SpatialRoadEdge[] = [];
  for (const raw of value) {
    const item = record(raw);
    const entity = entityRef(item.entity);
    const startNode = entityRef(item.startNode);
    const endNode = entityRef(item.endNode);
    const start = point2(item.start);
    const end = point2(item.end);
    if (!entity || !startNode || !endNode || !start || !end || typeof item.prefab !== "string") continue;
    edges.push({
      entity,
      prefab: item.prefab,
      native: item.native === true,
      startNode,
      endNode,
      start,
      end,
      length: finite(item.length) ? item.length : distance(start, end),
    });
  }
  return edges;
}

function parseNodes(value: unknown): SpatialRoadNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: SpatialRoadNode[] = [];
  for (const raw of value) {
    const item = record(raw);
    const entity = entityRef(item.entity);
    const position = record(item.position);
    if (!entity || !finite(position.x) || !finite(position.y) || !finite(position.z)) continue;
    nodes.push({
      entity,
      position: { x: position.x, y: position.y, z: position.z },
      native: item.native === true,
      outsideConnection: item.outsideConnection === true,
      roadDegree: Number.isInteger(item.roadDegree) ? Number(item.roadDegree) : 0,
    });
  }
  return nodes;
}

function endpointAttachment(input: RoadGeometryInput): RoadEndpointAttachment | undefined {
  return input.startEndpoint?.kind === "EXISTING_NET_NODE" ? input.startEndpoint : undefined;
}

/**
 * How far a node carrying the recorded attachment id may sit from the recorded
 * source position and still be that same source.
 *
 * The recorded `startEndpoint.expectedPosition` is the source node's own
 * transform, so a node that is still the source sits on it; the window exists
 * for the same reason `junctionRealizationTolerance` does -- native realizes a
 * join by pulling it in along the existing edge, and this lineage's own
 * certified junction lands 1.0957 m from the point it was asked for. It is
 * deliberately no wider: every metre added is room for a recycled id to pass as
 * the original source.
 */
const sourceIdentityTolerance = 2.5;

/**
 * Whether the course's attached source node is still the same node in the
 * world observed now.
 *
 * The recorded entity id cannot answer this on its own. Entity ids are
 * generation-scoped: a reload produces a new world generation in which the same
 * junction is a different entity, and the recorded index may be recycled onto an
 * unrelated node. The id then still *resolves*, and reading that as "the source
 * survived" makes the identity test in `orientedMatch` demand that the realized
 * start node be that stranger -- which it never is, so the geometric fallback
 * below it is unreachable and a course that is really in the world is certified
 * absent. That is the one direction this matcher must never get wrong: a false
 * absence is the input to a rollback decision against a healthy world.
 *
 * The key that does survive is the one the durable command already carries.
 * `startEndpoint.expectedPosition` is the source node's position, recorded when
 * the course was authorized, and a node position is world geometry rather than
 * generation-local identity -- the same reason every other tolerance in this
 * file is a distance rather than an id. So the source counts as still present
 * only where a node carries the recorded id *and* sits inside the bounded window
 * of that position. An id recycled elsewhere is a different node, which means
 * the source is gone -- exactly the situation the geometric fallback exists for.
 */
function sourceNodeStillPresent(
  attachment: RoadEndpointAttachment | undefined,
  nodes: SpatialRoadNode[],
): boolean {
  const entity = attachment?.entity;
  const expected = attachment?.expectedPosition;
  if (!entity) return false;
  // Without the recorded position the id is all there is, and an id alone is
  // not an identity: refuse rather than fall back to trusting it.
  if (!expected || !finite(expected.x) || !finite(expected.z)) return false;
  const recorded = { x: expected.x, z: expected.z };
  return nodes.some((node) => {
    if (!sameEntity(node.entity, entity)) return false;
    return distance({ x: node.position.x, z: node.position.z }, recorded) <= sourceIdentityTolerance;
  });
}

function orientedMatch(input: RoadGeometryInput, edge: SpatialRoadEdge, reverse: boolean, nodes: SpatialRoadNode[]): boolean {
  const expectedStart = { x: input.x1, z: input.z1 };
  const expectedEnd = { x: input.x2, z: input.z2 };
  const observedStart = reverse ? edge.end : edge.start;
  const observedEnd = reverse ? edge.start : edge.end;
  const observedStartNode = reverse ? edge.endNode : edge.startNode;
  const observedEndNode = reverse ? edge.startNode : edge.endNode;
  const endpointTolerance = 1;
  const corridorTolerance = 1.5;
  /**
   * How far the node native actually built may sit from the anchor it was asked
   * for.
   *
   * A course whose endpoint is aimed at an existing network is realized AT the
   * junction node native creates for the join, and that node is not required to
   * be the requested point: the join is pulled in along the existing edge so its
   * geometry is legal. This lineage's own certified course realizes its junction
   * 1.0957 m from the requested anchor, and its straight mirror 1.186 m, so a 1 m
   * window would prove absence of a road that is really in the world -- the one
   * direction this matcher must never get wrong.
   */
  const junctionRealizationTolerance = 2.5;

  const endIsExact = distance(observedEnd, expectedEnd) <= endpointTolerance;
  /**
   * Proximity alone is not evidence, and it is not the test. The realized end is
   * accepted only where the authoritative topology says it is the junction the
   * join created: a node carrying at least one other edge, within the bounded
   * window above. A free end that merely lies near the anchor is another road's
   * endpoint, and an unrelated road is excluded a second time by the source end,
   * which still has to be this course's own.
   */
  const realizedEndNode = observedEndNode
    ? nodes.find((node) => sameEntity(node.entity, observedEndNode)) ?? null
    : null;
  const endIsRealizedJunction = !endIsExact && realizedEndNode !== null && realizedEndNode.roadDegree >= 2 &&
    distance(observedEnd, expectedEnd) <= junctionRealizationTolerance;
  if (!endIsExact && !endIsRealizedJunction) return false;
  const exactSource = distance(observedStart, expectedStart) <= endpointTolerance;
  const mergedContinuation = distanceToSegment(expectedStart, observedStart, observedEnd) <= corridorTolerance;
  if (!exactSource && !mergedContinuation) return false;

  const attachment = endpointAttachment(input);
  if (!attachment?.entity) return exactSource || (input.cx === undefined && input.cz === undefined && mergedContinuation);
  const attachmentEntity = attachment.entity ?? undefined;
  const sourceStillExists = sourceNodeStillPresent(attachment, nodes);
  if (sourceStillExists) return exactSource && sameEntity(observedStartNode, attachmentEntity);

  // The source is not in this world as the same node: native either merged or
  // rebound it, or this is a later generation in which the recorded id resolves
  // somewhere else entirely (see `sourceNodeStillPresent`). Identity cannot
  // decide either way, so the stable proof is geometry: the old authoritative
  // source position lies on the permanent same-prefab edge and the requested
  // free endpoint is exact.
  return input.cx === undefined && input.cz === undefined && mergedContinuation;
}

/**
 * Native can split one submitted course into several permanent edges when the
 * course joins an existing network. Treat that realization as one effect only
 * when the same-prefab edges form a connected, ordered path from the submitted
 * start to its end and stay close to the authorized straight course.
 */
function matchingStraightChains(
  input: RoadGeometryInput,
  edges: SpatialRoadEdge[],
  nodes: SpatialRoadNode[],
): SpatialEntityRef[][] {
  if (input.cx !== undefined || input.cz !== undefined) return [];
  const start = { x: input.x1, z: input.z1 };
  const end = { x: input.x2, z: input.z2 };
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0) return [];

  const endpointTolerance = 1;
  const corridorTolerance = 1.5;
  const attachment = endpointAttachment(input);
  // The same identity key `orientedMatch` uses. An id recycled onto another node
  // by a reload must not be read as the attached source still being here, or the
  // first edge of the chain is required to start on a stranger and every real
  // chain is rejected.
  const attachedNodeExists = sourceNodeStillPresent(attachment, nodes);
  const maxChainEdges = Math.min(32, edges.length);
  const matches: SpatialEntityRef[][] = [];
  const seen = new Set<string>();
  const progress = (point: SpatialPoint2) => ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared;
  const onCourse = (point: SpatialPoint2) => distanceToSegment(point, start, end) <= corridorTolerance;

  const visit = (
    path: Array<{ edge: SpatialRoadEdge; start: SpatialPoint2; end: SpatialPoint2; startNode: SpatialEntityRef; endNode: SpatialEntityRef }>,
    used: Set<string>,
  ) => {
    if (path.length > 0) {
      const last = path[path.length - 1]!;
      const endpointDistance = distance(last.end, end);
      const lastNode = nodes.find((node) => sameEntity(node.entity, last.endNode));
      const reachesEnd = endpointDistance <= endpointTolerance ||
        (lastNode !== undefined && lastNode.roadDegree >= 2 && endpointDistance <= 2.5);
      if (reachesEnd) {
        const refs = path.map(({ edge }) => edge.entity);
        const key = refs.map((ref) => `${ref.index}:${ref.version}`).join(",");
        if (!seen.has(key)) { seen.add(key); matches.push(refs); }
        return;
      }
    }
    if (path.length >= maxChainEdges) return;
    for (const edge of edges) {
      if (edge.prefab !== input.prefab) continue;
      const edgeKey = `${edge.entity.index}:${edge.entity.version}`;
      if (used.has(edgeKey)) continue;
      for (const reverse of [false, true]) {
        const candidate = {
          edge,
          start: reverse ? edge.end : edge.start,
          end: reverse ? edge.start : edge.end,
          startNode: reverse ? edge.endNode : edge.startNode,
          endNode: reverse ? edge.startNode : edge.endNode,
        };
        const prior = path[path.length - 1];
        if (prior) {
          if (!sameEntity(prior.endNode, candidate.startNode) || distance(prior.end, candidate.start) > 0.5) continue;
        } else {
          if (distance(candidate.start, start) > endpointTolerance) continue;
          if (attachedNodeExists && !sameEntity(candidate.startNode, attachment?.entity)) continue;
          if (attachment?.entity && !attachedNodeExists && (input.cx !== undefined || input.cz !== undefined)) continue;
        }
        if (!onCourse(candidate.start) || !onCourse(candidate.end)) continue;
        const from = progress(candidate.start);
        const to = progress(candidate.end);
        const priorProgress = prior ? progress(prior.end) : 0;
        if (from < priorProgress - 0.01 || to <= from + 0.0001 || from > 1.02 || to > 1.02) continue;
        used.add(edgeKey);
        path.push(candidate);
        visit(path, used);
        path.pop();
        used.delete(edgeKey);
      }
    }
  };
  visit([], new Set());
  return matches;
}

/**
 * Whether native was authoritatively Idle across the observation window, which
 * is what makes a complete topology readable as "this is everything there is"
 * rather than "this is everything the game had finished committing".
 *
 * Exported so a matcher over a different topology view can apply the same
 * condition instead of writing a second, subtly different one.
 */
export function operationIdle(envelope: V2ObservationEnvelope): boolean {
  const before = record(record(envelope.sources.gameStateBefore.data).world);
  const after = record(record(envelope.sources.gameStateAfter.data).world);
  return before.nativeOperationBusy === false && after.nativeOperationBusy === false;
}

const identityText = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * The native world an observation envelope was captured from.
 *
 * Deliberately read from the game state payload the envelope carries, and not
 * from `worldEpoch`: the envelope's own epoch is a runtime session identity,
 * minted per load, so it can never answer "which world is this". The persistent
 * identity is the native world and the session guid of the save it was loaded
 * from — the same fields the durability checkpoints are keyed on.
 *
 * A world that differs between the envelope's two game state reads is not one
 * authoritative world, so it reports as unknown rather than picking a side.
 *
 * Exported so a caller that needs "which native world is this envelope from"
 * for a purpose other than the ROAD matcher reads it the same way instead of
 * writing a second identity reader over the same payload.
 */
export function observedWorldIdentity(envelope: V2ObservationEnvelope): {
  worldId: string | null;
  nativeSessionGuid: string | null;
} {
  const unknown = { worldId: null, nativeSessionGuid: null };
  const before = record(record(envelope.sources.gameStateBefore.data).world);
  const after = record(record(envelope.sources.gameStateAfter.data).world);
  const worldId = identityText(before.worldId);
  const nativeSessionGuid = identityText(before.nativeSessionGuid);
  if (worldId === null || nativeSessionGuid === null) return unknown;
  if (identityText(after.worldId) !== worldId || identityText(after.nativeSessionGuid) !== nativeSessionGuid) {
    return unknown;
  }
  return { worldId, nativeSessionGuid };
}

export function matchRoadEffect(input: {
  command: V2CommandRecord;
  observation: V2ObservationEnvelope;
  /**
   * The durable world lineage this command belongs to, as the durability layer
   * proved it. Absent means no lineage owns the command, which is not the same
   * as "a lineage was checked and matched" — the matcher fails closed on it.
   */
  provenance?: V2RoadEffectProvenance | null;
}): RoadEffectReport {
  const { command, observation } = input;
  const scan = record(observation.sources.spatialScan.data);
  const graph = record(scan.roadGraph);
  const generation = typeof scan.worldEpoch === "string" ? scan.worldEpoch : null;
  const base = {
    observedEnvelope: {
      observationId: observation.observationId,
      runtimeEpoch: observation.runtimeEpoch,
      coherence: observation.coherence,
      worldGeneration: generation,
    },
  };
  const inconclusive = (reason: string): RoadEffectReport => ({
    matcherResult: "INCONCLUSIVE",
    effectAbsenceProven: false,
    matchedEdges: [],
    reason,
    ...base,
  });

  if (observation.coherence === "UNKNOWN" || observation.sources.spatialScan.status !== "AVAILABLE") {
    return inconclusive("authoritative ROAD topology observation is unavailable or incoherent");
  }
  const road = parseRoadInput(command);
  if (!road || command.authorizedScope.actionFamily !== "ROAD") return inconclusive("durable ROAD exact input is malformed");
  // Provenance. The observation has to come from the very native world this
  // command's durable lineage belongs to, and that lineage has to rest on a
  // durable checkpoint owning this command.
  //
  // The runtime generation is deliberately absent from this test. The bridge
  // mints a fresh generation on every load, so requiring the current scan to
  // carry the command's execution-time generation made every ordinary reload
  // unprovable — and a generation that happens to match proves nothing, since
  // two different saves never share one and two loads of the same save never
  // do. The identity that survives a reload is the native world plus the
  // session guid of its save, which is exactly what the durability checkpoints
  // — and therefore the provenance — are already keyed on.
  const provenance = input.provenance ?? null;
  if (!provenance) {
    return inconclusive(
      "no durable world lineage owns this ROAD command, so this observation cannot be attributed to a world",
    );
  }
  if (
    provenance.lineageCheckpointIds.length === 0 ||
    !provenance.lineageCheckpointIds.includes(provenance.baseCheckpointId)
  ) {
    return inconclusive("ROAD provenance does not rest on a durable checkpoint owning this command");
  }
  const observedWorld = observedWorldIdentity(observation);
  if (
    observedWorld.worldId === null ||
    observedWorld.worldId !== provenance.worldId ||
    observedWorld.nativeSessionGuid !== provenance.nativeSessionGuid
  ) {
    return inconclusive(
      "authoritative ROAD topology was observed in a world that is not the native world of this command's durable lineage",
    );
  }
  // The scan must be attributed to a world at all. Its value is recorded as
  // evidence, never compared against the command's execution-time generation.
  if (!generation) return inconclusive("authoritative ROAD topology carries no world attribution");
  if (!Array.isArray(graph.edges) || !Array.isArray(graph.nodes) || typeof graph.truncated !== "boolean") {
    return inconclusive("authoritative ROAD topology payload is incomplete");
  }
  const edges = parseEdges(graph.edges);
  const nodes = parseNodes(graph.nodes);
  const matches = edges.filter(
    (edge) => edge.prefab === road.prefab && (orientedMatch(road, edge, false, nodes) || orientedMatch(road, edge, true, nodes)),
  );
  const chains = matches.length === 0 ? matchingStraightChains(road, edges, nodes) : [];
  if (matches.length > 0 || chains.length > 0) {
    const matchedEdges = matches.length > 0
      ? matches.map((edge) => edge.entity)
      : [...new Map(chains.flat().map((entity) => [`${entity.index}:${entity.version}`, entity])).values()];
    return {
      matcherResult: "MATCH",
      effectAbsenceProven: false,
      matchedEdges,
      reason: chains.length > 0
        ? `authoritative permanent topology contains ${chains.length} connected ${road.prefab} course chain match(es)`
        : `authoritative permanent topology contains ${matches.length} connected ${road.prefab} effect match(es)`,
      ...base,
    };
  }
  if (graph.truncated === true || !operationIdle(observation)) {
    return inconclusive(
      graph.truncated === true
        ? "authoritative ROAD topology is truncated"
        : "native operation is not authoritatively Idle; effect absence cannot be certified",
    );
  }
  return {
    matcherResult: "MISMATCH",
    effectAbsenceProven: true,
    matchedEdges: [],
    reason: `complete authoritative Idle topology contains no connected ${road.prefab} effect matching the proposal`,
    ...base,
  };
}

/**
 * The production ROAD effect matcher.
 *
 * It is only as authoritative as the lineage it can attribute an observation
 * to, so the caller must supply the resolver: without a durable world lineage
 * owning the command, the matcher reports INCONCLUSIVE instead of certifying a
 * MATCH or, worse, an absence. The resolver is a seam rather than an import so
 * this module keeps knowing nothing about the durability store — it reuses the
 * identity that store already proved instead of building a second one.
 */
export function createAuthoritativeRoadEffectMatcher(options: {
  resolveProvenance(command: V2CommandRecord): V2RoadEffectProvenance | null;
}): RoadEffectMatcher {
  return {
    match: ({ command, observation }) => {
      const report = matchRoadEffect({ command, observation, provenance: options.resolveProvenance(command) });
      return { result: report.matcherResult, evidence: report, reason: report.reason, effectAbsenceProven: report.effectAbsenceProven };
    },
  };
}

/** A complete, stable, idle observation is sufficient to prove a checkpoint rollback. */
export function isSafeCheckpointRollbackObservation(observation: V2ObservationEnvelope): boolean {
  const scan = record(observation.sources.spatialScan.data);
  const graph = record(scan.roadGraph);
  return (
    observation.coherence !== "UNKNOWN" &&
    observation.sources.spatialScan.status === "AVAILABLE" &&
    typeof scan.worldEpoch === "string" &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges) &&
    graph.truncated === false &&
    operationIdle(observation)
  );
}
