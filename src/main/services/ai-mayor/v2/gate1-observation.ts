import type { SpatialEntityRef, SpatialSiteDetail, SpatialZoningCell } from "../spatial/types";
import type { NativeWorldIdentity } from "./durability";
import type { Gate1Observation, Gate1State } from "./gate1";
import type { ObservationCoherence, V2ObservationEnvelope, V2SourcePayload } from "./foundation";
import type { TargetAccessObservation } from "./route-access";
import type { TargetRouteQueryPorts } from "./route-query";
import type { TargetUtilityServiceObservation } from "./utility-service";
import type { V2ObservationPorts } from "./foundation";

export interface Gate1ResidentObservation {
  residentCount: number;
  occupied: boolean;
  provenance: "OBSERVED_NATIVE_COMPONENT";
}

export interface Gate1ObservationFoundation {
  observation: V2ObservationPorts;
  targetAccess: { observe(input: { buildingRef: SpatialEntityRef; signal?: AbortSignal }): Promise<TargetAccessObservation> };
  routeQuery?: Pick<TargetRouteQueryPorts, "submit">;
  utilityService: {
    observe(input: { buildingRef: SpatialEntityRef; signal?: AbortSignal }): Promise<TargetUtilityServiceObservation>;
  };
  readBuildingResidents(
    buildingRef: SpatialEntityRef,
    signal?: AbortSignal,
  ): Promise<V2SourcePayload<Gate1ResidentObservation>>;
}

export interface Gate1RouteAnchor {
  lane: SpatialEntityRef;
  delta: number;
}

export interface Gate1ObservationProjectorOptions {
  foundation: Gate1ObservationFoundation;
  world: NativeWorldIdentity;
  resolveRouteAnchor?(input: {
    buildingRef: SpatialEntityRef;
    detail: SpatialSiteDetail;
    state: Gate1State;
    access: TargetAccessObservation;
  }): Gate1RouteAnchor | null;
}

const key = (value: SpatialEntityRef) => `${value.index}:${value.version}`;
const inside = (cell: SpatialZoningCell, state: Gate1State) => {
  const dx = cell.position.x - state.tranche.target.center.x;
  const dz = cell.position.z - state.tranche.target.center.z;
  return dx * dx + dz * dz <= state.tranche.target.radius * state.tranche.target.radius;
};

const mergeCoherence = (values: ObservationCoherence[]): ObservationCoherence =>
  values.includes("UNKNOWN") ? "UNKNOWN" : values.includes("BOUNDED_DRIFT") ? "BOUNDED_DRIFT" : "STABLE_FRAME";

const sourceAvailable = <T>(source: V2SourcePayload<T> | undefined): source is V2SourcePayload<T> & { data: T } =>
  source?.status === "AVAILABLE" && source.data !== undefined;

/**
 * A tranche's own land use, as a zone category.
 *
 * Every tranche is planned for one of R/C/I, and its observation has to read
 * that land use's own facts. Reading residential buildings for a commercial
 * Goal is not a near miss: the Goal's own zoning can never produce one, so the
 * wait can only ever time out.
 */
export const gate1LandUseZone = (state: Gate1State): "residential" | "commercial" | "industrial" =>
  // A state restored from an older schema may not carry a plan at all. Resuming
  // as RESIDENTIAL is the same default the zoning resolver already uses, so the
  // two never disagree about what an unstated land use means.
  ((state.districtPlan?.landUse ?? "RESIDENTIAL").toLowerCase()) as "residential" | "commercial" | "industrial";

/**
 * Which prefab belongs to this land use.
 *
 * A bounded, documented heuristic over the prefab name — the same shape the
 * residential-only version already used. A prefab that does not name its use
 * simply never matches, which fails closed rather than attributing another
 * land use's building to this tranche.
 */
const buildingOfZone = (prefab: string, zone: string) => prefab.toLowerCase().includes(zone);

/**
 * Resolve the route-query anchor from the authoritative native building access
 * evidence.  This deliberately does not infer a lane from nearby geometry or
 * scan the road catalogue: the lane must be a live native road-path lane
 * selected by the building's SpawnLocation relation.
 */
export function authoritativeGate1RouteAnchor(access: TargetAccessObservation): Gate1RouteAnchor | null {
  const lane = access.entrances
    .flatMap((entrance) => [entrance.connectedLane1, entrance.connectedLane2])
    .find(
      (candidate) =>
        candidate !== null &&
        candidate.exists &&
        candidate.isLane &&
        candidate.fromRoadEdgeSubLane &&
        candidate.isRoadPath &&
        (candidate.isCarLane || candidate.isConnectionLane),
    );
  if (!lane) return null;
  const delta = access.roadAttachment?.curvePosition;
  return { lane: lane.entity, delta: delta !== null && delta !== undefined && Number.isFinite(delta) ? Math.max(0, Math.min(1, delta)) : 0.5 };
}

function unknownObservation(state: Gate1State, envelope: V2ObservationEnvelope, world: NativeWorldIdentity): Gate1Observation {
  return {
    observationId: envelope.observationId,
    runtimeEpoch: envelope.runtimeEpoch,
    coherence: "UNKNOWN",
    capturedAt: envelope.readEndedAt,
    trancheId: state.tranche.id,
    access: { value: "UNKNOWN", provenance: "OBSERVED" },
    productiveFrontage: { value: "UNKNOWN", provenance: "OBSERVED" },
    utilities: {
      value: "UNKNOWN",
      provenance: "OBSERVED",
      evidenceKind: "UNKNOWN",
      buildingRefs: [],
    },
    residentialBuildings: { value: null, provenance: "OBSERVED" },
    actualResidents: { value: null, provenance: "OBSERVED" },
    occupiedResidentialBuildings: { value: null, provenance: "OBSERVED" },
    world: {
      worldId: world.worldId,
      worldEpochId: world.worldEpochId,
      checkpointId: world.checkpointId,
      generation: world.generation,
      provenance: "OBSERVED_NATIVE_IDENTITY",
    },
    incoherence: {
      unavailableSources: (Object.keys(envelope.sources) as Array<keyof typeof envelope.sources>)
        .filter((name) => envelope.sources[name]?.status === "UNAVAILABLE"),
      frameBefore: envelope.simulationFrameStart,
      frameAfter: envelope.simulationFrameEnd,
    },
  };
}

export function createGate1ObservationProjector(options: Gate1ObservationProjectorOptions) {
  return {
    async observe(state: Gate1State, signal?: AbortSignal): Promise<Gate1Observation> {
      const envelope = await options.foundation.observation.capture({
        spatialDetail: {
          x: state.tranche.target.center.x,
          z: state.tranche.target.center.z,
          radius: Math.max(64, state.tranche.target.radius),
          resolution: 16,
        },
        signal,
      });
      const detailSource = envelope.sources.spatialDetail;
      if (!sourceAvailable(detailSource) || envelope.coherence === "UNKNOWN") {
        return unknownObservation(state, envelope, options.world);
      }

      const detail = detailSource.data;
      const landUseZone = gate1LandUseZone(state);
      const buildings = detail.buildings.filter(
        (building) => buildingOfZone(building.prefab, landUseZone) &&
          Math.hypot(building.position.x - state.tranche.target.center.x, building.position.z - state.tranche.target.center.z) <=
            state.tranche.target.radius,
      );
      const buildingFacts = await Promise.all(
        buildings.map(async (building) => {
          const [access, utility, resident] = await Promise.all([
            options.foundation.targetAccess.observe({ buildingRef: building.entity, signal }),
            options.foundation.utilityService.observe({ buildingRef: building.entity, signal }),
            options.foundation.readBuildingResidents(building.entity, signal),
          ]);
          let route: Awaited<ReturnType<NonNullable<Gate1ObservationFoundation["routeQuery"]>["submit"]>> | null = null;
          const anchor = options.resolveRouteAnchor
            ? options.resolveRouteAnchor({ buildingRef: building.entity, detail, state, access })
            : authoritativeGate1RouteAnchor(access);
          if (anchor && options.foundation.routeQuery) {
            route = await options.foundation.routeQuery.submit({
              queryId: `${state.tranche.id}:route:${key(building.entity)}`,
              buildingRef: building.entity,
              targetAnchor: anchor,
              signal,
            });
          }
          return { building, access, utility, resident, route };
        }),
      );

      // Two different questions, deliberately not merged.
      //
      // `coherence` is the ENVELOPE's own integrity: one frame across one read
      // window, every required source available. It is a statement about the
      // whole snapshot, so it fails the whole snapshot closed — and it is the
      // only thing that should. SITE_SELECTION and zoning planning read the
      // census, not a building, and must not be blocked by a fact they never
      // consult.
      //
      // A building's own read is a FACT about that building. It stays on that
      // fact's coherence below, so only the predicates that actually need
      // access or consumer service are refused. Merging it up is what made one
      // optional access endpoint able to stop an entire tranche: measured live
      // (2026-09-30), every successor of a residential Goal sat at `PLANNED`
      // with `incoherent access:339614:555` and no task could take a step.
      const coherence = envelope.coherence;
      const targetCoherence = mergeCoherence(buildingFacts.length > 0
        ? buildingFacts.flatMap((fact) => [fact.access.coherence, fact.utility.coherence])
        : ["STABLE_FRAME"]);
      const observedBuildings = buildingFacts.map((fact) => fact.building.entity);
      const residentSourcesKnown = buildingFacts.every((fact) => sourceAvailable(fact.resident));
      const actualResidents = residentSourcesKnown
        ? buildingFacts.reduce((sum, fact) => sum + (fact.resident.data?.residentCount ?? 0), 0)
        : null;
      const occupied = residentSourcesKnown
        ? buildingFacts.filter((fact) => fact.resident.data?.occupied === true).map((fact) => fact.building.entity)
        : null;
      const accessKnown = buildingFacts.length > 0 && buildingFacts.every(
        (fact) => fact.access.status === "ATTACHED_ONLY" && (!options.foundation.routeQuery || fact.route?.state === "ROUTABLE"),
      );
      const routeWaiting = buildingFacts.some(
        (fact) => fact.route?.state === "ACCEPTED" || fact.route?.state === "PENDING",
      );
      const accessFailed = buildingFacts.some(
        (fact) => fact.access.status === "DISCONNECTED" || fact.route?.state === "UNROUTABLE",
      );
      const utilityKnown = buildingFacts.length > 0 && buildingFacts.every(
        (fact) => fact.utility.electricity.status === "SERVED" &&
          fact.utility.water.status === "SERVED" &&
          fact.utility.sewage.status === "SERVED",
      );
      const utilityFailed = buildingFacts.some(
        (fact) => fact.utility.electricity.status === "UNSERVED" ||
          fact.utility.water.status === "UNSERVED" ||
          fact.utility.sewage.status === "UNSERVED",
      );
      const consumerInitializationWaiting = buildingFacts.some((fact) =>
        [fact.utility.electricity, fact.utility.water, fact.utility.sewage].some((utility) =>
          utility.status === "UNKNOWN" && /zero wanted consumption|not initialized|initiali[sz]ation/i.test(utility.reason),
        ),
      );
      const frontageCells = detail.zoningCells.filter(
        (cell) => inside(cell, state) && cell.visible && cell.roadside && !cell.blocked && !cell.overridden &&
          (cell.zoneCategory === "none" || cell.zoneCategory === landUseZone),
      );
      const frontage = frontageCells.length > 0 ? "PASS" : observedBuildings.length > 0 ? "FAIL" : "UNKNOWN";

      return {
        observationId: envelope.observationId,
        runtimeEpoch: envelope.runtimeEpoch,
        coherence,
        capturedAt: envelope.readEndedAt,
        trancheId: state.tranche.id,
        access: {
          value: accessKnown ? "PASS" : accessFailed ? "FAIL" : "UNKNOWN",
          provenance: accessKnown || accessFailed ? "DERIVED" : "OBSERVED",
        },
        productiveFrontage: { value: frontage, provenance: frontage === "UNKNOWN" ? "OBSERVED" : "DERIVED" },
        utilities: {
          value: utilityKnown ? "PASS" : utilityFailed ? "FAIL" : "UNKNOWN",
          provenance: utilityKnown || utilityFailed ? "DERIVED" : "OBSERVED",
          evidenceKind: "ACTUAL_CONSUMER_SERVICE",
          buildingRefs: observedBuildings,
        },
        residentialBuildings: { value: observedBuildings, provenance: "OBSERVED" },
        actualResidents: { value: actualResidents, provenance: "OBSERVED" },
        occupiedResidentialBuildings: { value: occupied, provenance: "OBSERVED" },
        ...(routeWaiting
          ? { waitingFor: "ROUTE_RESULT" as const }
          : consumerInitializationWaiting
            ? { waitingFor: "CONSUMER_INITIALIZATION" as const }
            : {}),
        world: {
          worldId: options.world.worldId,
          worldEpochId: options.world.worldEpochId,
          checkpointId: options.world.checkpointId,
          generation: options.world.generation,
          provenance: "OBSERVED_NATIVE_IDENTITY",
        },
        // Which fact-level reads were incoherent, for a caller that has to say
        // so. This is data, not a verdict: `coherence` above already answers
        // whether the snapshot as a whole may be acted on.
        factCoherence: {
          access: mergeCoherence(buildingFacts.map((fact) => fact.access.coherence)),
          utilities: mergeCoherence(buildingFacts.map((fact) => fact.utility.coherence)),
          ...(buildingFacts.some((fact) => fact.access.coherence === "UNKNOWN" || fact.utility.coherence === "UNKNOWN")
            ? { incoherentRefs: buildingFacts.flatMap((fact) => [
              ...(fact.access.coherence === "UNKNOWN" ? [`access:${key(fact.building.entity)}`] : []),
              ...(fact.utility.coherence === "UNKNOWN" ? [`utility:${key(fact.building.entity)}`] : []),
            ]) }
            : {}),
        },
      };
    },
  };
}
