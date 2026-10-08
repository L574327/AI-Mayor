import type { MayorAction } from "../types";
import { ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB, type PlannedUtilityFacility, type SpatialEntityRef, type SpatialPoint2, type SpatialRoadEdge } from "../spatial/types";
import {
  prepareSharedUtilityRecovery,
  type PreparedSharedUtilityRecovery,
  type SharedUtilityPreparationPorts,
  type UtilityConnectionPrimitive,
  type UtilityConnectionPlan,
  type UtilityRecoveryKind,
} from "../utility-recovery";
import { electricityTargetSemantics, reacquireTargetRoadByApprovedContact, type ImmutableElectricityTargetSemantics } from "./utility-target-binding";
import { EXECUTION_MECHANISM_REVISION, type GreenfieldUtilityExecutionScope } from "./greenfield-utility-bootstrap";
import {
  firstFacilityPlacementPermitted,
  type FirstFacilityPlacementDurability,
} from "./utility-placement-durability";

/**
 * The production recipe that requires each utility family's first facility.
 *
 * The recipe string is an authorization marker: it names *why* a placement is
 * permitted, and it is the reason a placement cannot be borrowed from another
 * utility family. It is derived from the kind rather than restated per call
 * site, so a kind can never be authorized by a different family's recipe.
 *
 * Electricity keeps the exact literal K05 has always carried, so no existing
 * durable authorization changes meaning.
 */
export const UTILITY_FACILITY_RECIPES = {
  electricity: "basic-electricity-provision",
  water: "basic-water-provision",
  sewage: "basic-sewage-provision",
} as const satisfies Record<UtilityRecoveryKind, string>;

export type UtilityFacilityRecipe = (typeof UTILITY_FACILITY_RECIPES)[UtilityRecoveryKind];

/** The recipe a given utility kind's first facility placement must be authorized by. */
export function utilityFacilityRecipe(kind: UtilityRecoveryKind): UtilityFacilityRecipe {
  return UTILITY_FACILITY_RECIPES[kind];
}

export type UtilityPreparationFailureReason =
  | "UTILITY_WORLD_IDENTITY_INCOMPLETE"
  | "UTILITY_PLAN_UNAVAILABLE"
  | "UTILITY_FACILITY_NOT_FOUND"
  | "UTILITY_FACILITY_AMBIGUOUS"
  | "UTILITY_CONNECTOR_NOT_FOUND"
  | "UTILITY_CONNECTOR_AMBIGUOUS"
  | "UTILITY_CONNECTOR_OBSERVATION_INCOMPLETE"
  | "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY"
  | "EMPTY_DIRECT_CABLE_ACTIONS"
  | "EMPTY_UTILITY_CANDIDATE_ACTIONS"
  | "DIRECT_CABLE_PREFLIGHT_REJECTED"
  | "UTILITY_CONNECTION_CANDIDATE_MISSING"
  | "UTILITY_TARGET_ROAD_NOT_FOUND"
  | "UTILITY_TARGET_ROAD_AMBIGUOUS"
  | "UTILITY_TARGET_CONTACT_MISMATCH"
  | "NO_FEASIBLE_ROAD_CANDIDATE"
  | "UTILITY_SCOPE_INVALID"
  /**
   * A durable first-facility placement operation already exists for this scope
   * and is not proven to have left no facility. Placing again could duplicate a
   * WindTurbine that a crash hid from the current observation, so preparation
   * holds the scope in reconciliation instead of admitting a new attempt.
   */
  | "UTILITY_FACILITY_PLACEMENT_UNRESOLVED";

/**
 * Explicit, bounded authorization to place the FIRST utility facility a recipe
 * requires.
 *
 * Planning alone never grants placement: the shared preparation refuses the
 * greenfield branch without an authorization, so a bare workflow invocation
 * still fails closed with `UTILITY_FACILITY_NOT_FOUND`. Every field here is
 * derived from authoritative production state — the admitted Gate 1 scope, the
 * K05 recipe, the observed treasury, and the road the Gate 1 state machine
 * actually delivered. None of it is a default, an environment flag, a fixture,
 * or a search of the world.
 */
export interface UtilityFacilityPlacementAuthorization {
  /** The production recipe that requires this facility family. */
  recipe: UtilityFacilityRecipe;
  kind: UtilityRecoveryKind;
  /** The admitted Gate 1 scope this placement descends from. */
  intentId: string;
  projectId: string;
  trancheId: string;
  reservationRef: string;
  placementScopeId?: string;
  /** Placement is confined to this reservation. */
  spatialEnvelope: { center: SpatialPoint2; radius: number };
  /** Spend ceiling for the placement, from the admitted project budget and observed treasury. */
  maximumSpend: number;
  /** How many facilities this authorization may create. */
  maximumPlacements: number;
  /** Limit this authorization to Stage A facility creation and readback. */
  facilityPlacementOnly?: boolean;
  /**
   * Roads the Gate 1 state machine already delivered and certified for this
   * tranche, taken from durable ROAD_DELIVERED evidence. This is the only road
   * authority a first placement may use.
   */
  certifiedRoadRefs: readonly SpatialEntityRef[];
  /**
   * The certified road this tranche's utility service entry is bound to.
   *
   * `farEnd` is the ROAD command's own committed far endpoint. It joins the
   * contact point as reacquisition geometry, which is what keeps the entry
   * identifiable after a reload once the game has split the delivered course.
   */
  targetRoad?: { entity: SpatialEntityRef; position: SpatialPoint2; prefab: string; farEnd?: SpatialPoint2 };
}

export interface UtilityPreparationInput {
  kind: UtilityRecoveryKind;
  intentId: string;
  projectId: string;
  trancheId: string;
  reservationRef: string;
  placementScopeId?: string;
  worldId: string;
  worldEpochId: string;
  generation: string;
  topologyRevision: string;
  spatialEnvelope: { center: SpatialPoint2; radius: number };
  maximumSpend: number;
  treasury: number;
  treasurySafetyReserve: number;
  connectionOnly?: boolean;
  selectedPrimitive?: UtilityConnectionPrimitive;
  candidatePreference?: readonly UtilityConnectionPrimitive[];
  facilityPlacementOnly?: boolean;
  /** Place and authoritatively read back an alternate site before network work. */
  deferConnectionUntilPlaced?: boolean;
  /**
   * Present only when production admission authorizes placing this recipe's
   * first facility. Absent means placement is not authorized, and preparation
   * still fails closed with `UTILITY_FACILITY_NOT_FOUND`.
   */
  facilityPlacementAuthorization?: UtilityFacilityPlacementAuthorization;
  /**
   * The durable, restart-stable state of this scope's first-facility placement
   * operations, read from the durable command journal.
   *
   * Required for a placement to be authorized: an authorization is honored only
   * when this is present and permits a first placement. Absent means the caller
   * supplied no durable proof, which is treated exactly like an unresolved
   * operation — a crash can hide an already-placed facility from the current
   * observation, so "not proven clear" must never read as "clear".
   */
  firstFacilityPlacement?: FirstFacilityPlacementDurability;
  /**
   * The road refs this tranche's delivered ROAD_CONNECTION certified.
   *
   * Durable identity, not geometry, and it is what decides which road a
   * connection enters when the contact point alone cannot. A contact is a point
   * where roads meet: a delivered road ending on a node an older road already
   * occupies is within tolerance of both, so `≤ 0.25 m` identifies candidates
   * rather than choosing one. The tranche certified its own road, so that ref is
   * the authority and geometry is only the search.
   *
   * Absent means nothing is certified, and the pre-existing rule stands exactly
   * as it was: one geometric match or a refusal.
   */
  certifiedRoadRefs?: readonly SpatialEntityRef[];
  /**
   * The same delivered road as durable geometry: the refs' own prefab and
   * committed far endpoint.
   *
   * Durable identity chooses the road while its refs still resolve. After a
   * reload they do not — they name entities of the generation the command ran
   * in — and geometry takes over. The contact point alone is not enough then:
   * the game splits a delivered course into several edges meeting at that node,
   * so the command's own prefab and far endpoint are what keep the choice
   * unique. Absent, the pre-existing geometric rule stands unchanged.
   */
  certifiedRoad?: { entity: SpatialEntityRef; position: SpatialPoint2; prefab: string; farEnd?: SpatialPoint2 };
  signal?: AbortSignal;
}

/**
 * Admission of a first facility placement.
 *
 * Nothing has been placed. `prepare` admits only the bounded execution scope;
 * the facility and its connection are placed and certified by `run()` through
 * the existing durable utility execution boundary, so `prepare` still sends no
 * native command.
 */
export interface PreparedUtilityFirstPlacement {
  status: "READY";
  mode: "GREENFIELD_FIRST_PLACEMENT";
  plan: PlannedUtilityFacility;
  targetServiceEntry: { road: SpatialEntityRef; position: SpatialPoint2 };
  targetSemantics?: ImmutableElectricityTargetSemantics;
  executionScope: GreenfieldUtilityExecutionScope;
  diagnostics?: Record<string, unknown>;
}

export type UtilityPreparationResult =
  | PreparedUtilityExecution
  | PreparedUtilityFirstPlacement
  | UtilityPreparationFailure;

export interface PreparedUtilityExecution {
  status: "READY";
  currentFacility: NonNullable<PreparedSharedUtilityRecovery["facility"]>;
  currentConnector: NonNullable<PreparedSharedUtilityRecovery["connector"]>;
  plan: PlannedUtilityFacility | UtilityConnectionPlan;
  candidate: NonNullable<PreparedSharedUtilityRecovery["selected"]>;
  targetServiceEntry: { road: SpatialEntityRef; position: SpatialPoint2 };
  targetSemantics?: ImmutableElectricityTargetSemantics;
  approvedContact: SpatialPoint2;
  nativeActions: MayorAction[];
  executionScope: GreenfieldUtilityExecutionScope;
  diagnostics?: Record<string, unknown>;
  boundary1Contract?: {
    prefab: typeof ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB;
    creationFlags: 65536;
    original: null;
    start: { entity: null; flags: 51 };
    end: { entity: null; flags: 51 };
  };
}

export interface UtilityPreparationFailure {
  status: "BLOCKED";
  reason: UtilityPreparationFailureReason;
  diagnostics?: Record<string, unknown>;
  nativeActionsSubmitted: 0;
}

export interface UtilityExecutionPlannerPorts extends SharedUtilityPreparationPorts {
  roadEdges(input: { center: SpatialPoint2; radius: number; signal?: AbortSignal }): Promise<SpatialRoadEdge[]>;
  /**
   * Exact-action fingerprints of this scope's durable UTILITY connection
   * commands that already reached the world. A course listed here was submitted
   * natively, so preparation admits it instead of asking the game to validate a
   * duplicate; the durable submission owns the effect until reconciliation
   * settles it. Absent or unreadable means nothing is proven, and the course is
   * validated natively as before.
   */
  durablySubmittedConnectionCourses?(): Promise<readonly string[]>;
}

const blocked = (reason: UtilityPreparationFailureReason, diagnostics?: Record<string, unknown>): UtilityPreparationFailure => ({
  status: "BLOCKED", reason, diagnostics, nativeActionsSubmitted: 0,
});

const contactOf = (actions: MayorAction[], primitive: UtilityConnectionPrimitive): SpatialPoint2 | null => {
  if (primitive === "service-road") {
    const first = actions[0];
    return first?.type === "build_road" && Number.isFinite(first.x1) && Number.isFinite(first.z1)
      ? { x: first.x1, z: first.z1 } : null;
  }
  const action = actions.at(-1);
  return action?.type === "build_road" && Number.isFinite(action.x2) && Number.isFinite(action.z2)
    ? { x: action.x2, z: action.z2 } : null;
};

const pointToSegment = (point: SpatialPoint2, edge: SpatialRoadEdge): number => {
  const dx = edge.end.x - edge.start.x;
  const dz = edge.end.z - edge.start.z;
  const length2 = dx * dx + dz * dz;
  const ratio = length2 === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - edge.start.x) * dx + (point.z - edge.start.z) * dz) / length2));
  return Math.hypot(point.x - edge.start.x - ratio * dx, point.z - edge.start.z - ratio * dz);
};

const sameEntityRef = (left: SpatialEntityRef, right: SpatialEntityRef) =>
  left.index === right.index && left.version === right.version;

const plannedFacilityOf = (
  value: PlannedUtilityFacility | UtilityConnectionPlan | undefined,
): PlannedUtilityFacility | undefined => (value && !("mode" in value) ? value : undefined);

/**
 * Validate the authorization against the preparation it would apply to.
 *
 * A mismatched, stale, over-budget, or out-of-reservation authorization is
 * discarded rather than repaired, so the caller keeps failing closed. This is
 * the only place placement authority is granted, and it is never inferred.
 */
/**
 * The durable placement state, defaulting to "unproven" when the caller
 * supplied none. Absence is never read as "no placement happened".
 */
const placementClearance = (input: UtilityPreparationInput): FirstFacilityPlacementDurability =>
  input.firstFacilityPlacement ?? {
    status: "UNPROVEN",
    reason: "DURABLE_PLACEMENT_STATE_NOT_SUPPLIED",
  };

const authorizingPlacement = (input: UtilityPreparationInput): UtilityFacilityPlacementAuthorization | undefined => {
  const authorization = input.facilityPlacementAuthorization;
  if (!authorization) return undefined;
  // A connection-only request never places anything.
  if (input.connectionOnly === true) return undefined;
  // Durable, restart-stable clearance. A placement operation that may already
  // have mutated the world — or one that was never proven absent — blocks a
  // second attempt no matter what the current observation shows.
  if (!firstFacilityPlacementPermitted(placementClearance(input))) return undefined;
  // The recipe must be the one this kind is actually provided by. Checking the
  // pair, not just the kind, keeps a placement authorized for one utility family
  // from being replayed as another.
  if (authorization.recipe !== utilityFacilityRecipe(input.kind) || authorization.kind !== input.kind) return undefined;
  if (!Number.isInteger(authorization.maximumPlacements) || authorization.maximumPlacements < 1) return undefined;
  if (
    authorization.intentId !== input.intentId ||
    authorization.projectId !== input.projectId ||
    authorization.trancheId !== input.trancheId ||
    authorization.reservationRef !== input.reservationRef
  ) {
    return undefined;
  }
  if (
    authorization.spatialEnvelope.center.x !== input.spatialEnvelope.center.x ||
    authorization.spatialEnvelope.center.z !== input.spatialEnvelope.center.z ||
    authorization.spatialEnvelope.radius !== input.spatialEnvelope.radius
  ) {
    return undefined;
  }
  if (
    !Number.isFinite(authorization.maximumSpend) ||
    authorization.maximumSpend <= 0 ||
    authorization.maximumSpend > input.maximumSpend
  ) {
    return undefined;
  }
  if (authorization.facilityPlacementOnly === true) {
    if (input.facilityPlacementOnly !== true || authorization.certifiedRoadRefs.length !== 0 || authorization.targetRoad) return undefined;
  } else {
    if (!authorization.targetRoad || authorization.certifiedRoadRefs.length === 0) return undefined;
    if (!authorization.certifiedRoadRefs.some((ref) => sameEntityRef(ref, authorization.targetRoad!.entity))) return undefined;
    if (!Number.isFinite(authorization.targetRoad.position.x) || !Number.isFinite(authorization.targetRoad.position.z)) return undefined;
  }
  return authorization;
};

/**
 * Admit a bounded execution scope for a first facility placement.
 *
 * No native command is sent here. The scope's road authority is the certified
 * road set the Gate 1 state machine already delivered, so nothing searches the
 * world and nothing is invented; the placement and the connection are performed
 * by `run()` through the existing durable utility execution boundary.
 */
const admitFirstPlacement = (
  input: UtilityPreparationInput,
  plan: PlannedUtilityFacility,
  authorization: UtilityFacilityPlacementAuthorization,
  diagnostics?: Record<string, unknown>,
): PreparedUtilityFirstPlacement | UtilityPreparationFailure => {
  const envelope = authorization.spatialEnvelope;
  const distanceFromEnvelopeCentre = Math.hypot(
    plan.position.x - envelope.center.x,
    plan.position.z - envelope.center.z,
  );
  if (distanceFromEnvelopeCentre > envelope.radius) {
    // The refused site is reported with its geometry: "outside the reservation"
    // alone does not say whether the planner searched past the reservation or
    // the reservation is simply too small for the asset.
    return blocked("UTILITY_FACILITY_NOT_FOUND", {
      preparationReason: "placement_outside_authorized_reservation",
      plannedPrefab: plan.prefab,
      plannedPosition: plan.position,
      authorizedEnvelope: envelope,
      distanceFromEnvelopeCentre,
    });
  }
  if (!Number.isFinite(plan.constructionCost) || plan.constructionCost > authorization.maximumSpend) {
    return blocked("UTILITY_FACILITY_NOT_FOUND", {
      preparationReason: "placement_exceeds_authorized_budget",
      constructionCost: plan.constructionCost,
      authorizedMaximumSpend: authorization.maximumSpend,
    });
  }
  const targetServiceEntry = authorization.targetRoad ? {
    road: authorization.targetRoad.entity,
    position: authorization.targetRoad.position,
    prefab: authorization.targetRoad.prefab,
    ...(authorization.targetRoad.farEnd ? { farEnd: authorization.targetRoad.farEnd } : {}),
  } : { road: { index: -1, version: -1 }, position: { ...envelope.center } };
  const targetSemantics =
    input.kind === "electricity" && authorization.targetRoad
      ? electricityTargetSemantics({
          contact: authorization.targetRoad.position,
          targetRoad: {
            prefab: authorization.targetRoad.prefab,
            endpointRole: "start",
            anchor: authorization.targetRoad.position,
          },
          approvedPlanRevision: input.topologyRevision,
        })
      : undefined;
  const executionScope: GreenfieldUtilityExecutionScope = {
    intentId: input.intentId,
    projectId: input.projectId,
    trancheId: input.trancheId,
    reservationRef: input.reservationRef,
    placementScopeId: authorization.placementScopeId ?? input.placementScopeId ?? "utility-placement:legacy",
    worldId: input.worldId,
    worldEpochId: input.worldEpochId,
    generation: input.generation,
    topologyRevision: input.topologyRevision,
    executionMechanismRevision: EXECUTION_MECHANISM_REVISION,
    ...(authorization.facilityPlacementOnly ? { facilityPlacementOnly: true, commissionedKinds: [input.kind] } : {}),
    ...(input.deferConnectionUntilPlaced === true ? { deferConnectionUntilPlaced: true } : {}),
    certifiedRoadRefs: [...authorization.certifiedRoadRefs],
    targetServiceEntry,
    ...(targetSemantics ? { targetSemantics } : {}),
    spatialEnvelope: input.spatialEnvelope,
    maximumSpend: input.maximumSpend,
    treasury: input.treasury,
    treasurySafetyReserve: input.treasurySafetyReserve,
  };
  return {
    status: "READY",
    mode: "GREENFIELD_FIRST_PLACEMENT",
    plan,
    targetServiceEntry,
    ...(targetSemantics ? { targetSemantics } : {}),
    executionScope,
    ...(diagnostics ? { diagnostics } : {}),
  };
};

/**
 * The planning scope a preparation input plans inside.
 *
 * Its road authority is the certified road the placement was authorized
 * against, never an empty set: planning with no certified road let the
 * planner search the whole world road network and choose a site outside the
 * authorized reservation, which the placement admission then had to reject.
 * Only a preparation without a placement authorization (an existing-facility
 * connection) keeps the empty placeholder, and it plans no greenfield site.
 */
export function utilityPlanningScope(input: UtilityPreparationInput): GreenfieldUtilityExecutionScope {
  const authorization = input.facilityPlacementAuthorization;
  const certifiedRoad = input.certifiedRoad;
  const certifiedRoadRefs = authorization?.certifiedRoadRefs ?? input.certifiedRoadRefs ??
    (certifiedRoad ? [certifiedRoad.entity] : []);
  return {
    intentId: input.intentId, projectId: input.projectId, trancheId: input.trancheId, reservationRef: input.reservationRef,
    ...((authorization?.placementScopeId ?? input.placementScopeId)
      ? { placementScopeId: authorization?.placementScopeId ?? input.placementScopeId }
      : {}),
    worldId: input.worldId, worldEpochId: input.worldEpochId, generation: input.generation, topologyRevision: input.topologyRevision,
    executionMechanismRevision: EXECUTION_MECHANISM_REVISION,
    certifiedRoadRefs: [...certifiedRoadRefs],
    ...(input.facilityPlacementOnly === true ? { facilityPlacementOnly: true, commissionedKinds: [input.kind] } : {}),
    ...(input.deferConnectionUntilPlaced === true ? { deferConnectionUntilPlaced: true } : {}),
    targetServiceEntry: authorization?.targetRoad
      ? {
        road: authorization.targetRoad.entity,
        position: authorization.targetRoad.position,
        prefab: authorization.targetRoad.prefab,
        ...(authorization.targetRoad.farEnd ? { farEnd: authorization.targetRoad.farEnd } : {}),
      }
      : certifiedRoad
        ? {
          road: certifiedRoad.entity,
          position: certifiedRoad.position,
          prefab: certifiedRoad.prefab,
          ...(certifiedRoad.farEnd ? { farEnd: certifiedRoad.farEnd } : {}),
        }
        : { road: { index: -1, version: -1 }, position: input.spatialEnvelope.center },
    ...(input.kind === "electricity" && certifiedRoad ? {
      targetSemantics: electricityTargetSemantics({
        contact: certifiedRoad.position,
        targetRoad: { prefab: certifiedRoad.prefab, endpointRole: "start", anchor: certifiedRoad.position },
        approvedPlanRevision: input.topologyRevision,
      }),
    } : {}),
    spatialEnvelope: input.spatialEnvelope, maximumSpend: input.maximumSpend, treasury: input.treasury,
    treasurySafetyReserve: input.treasurySafetyReserve,
  };
}

export async function prepareScopedUtilityExecution(
  input: UtilityPreparationInput,
  ports: UtilityExecutionPlannerPorts,
): Promise<UtilityPreparationResult> {
  const requiredIdentity = [input.intentId, input.projectId, input.trancheId, input.reservationRef,
    input.worldId, input.worldEpochId, input.generation, input.topologyRevision];
  if (!requiredIdentity.every((value) => value.trim().length > 0)) return blocked("UTILITY_WORLD_IDENTITY_INCOMPLETE");
  if (!(input.spatialEnvelope.radius > 0) || !Number.isFinite(input.maximumSpend) ||
    !Number.isFinite(input.treasury) || !Number.isFinite(input.treasurySafetyReserve)) {
    return blocked("UTILITY_SCOPE_INVALID");
  }

  // A first placement that the durable journal already recorded and whose
  // authoritative effect match settled proves this scope's facility exists. The
  // only legal continuation is to rebind that facility from the current world
  // and connect it, so the preparation is re-entered as connection-only.
  // Placement admission would ask for a second facility that the durable
  // submission guard refuses anyway, and would leave the attempt held behind a
  // placement hold forever.
  const settledFirstPlacement = (() => {
    const clearance = placementClearance(input);
    return clearance.status === "PLACED" && input.connectionOnly !== true ? clearance : null;
  })();
  let durablySubmittedFingerprints: readonly string[] = [];
  try {
    durablySubmittedFingerprints = (await ports.durablySubmittedConnectionCourses?.()) ?? [];
  } catch {
    // An unreadable journal proves nothing about any course, so every candidate
    // is validated natively exactly as before.
    durablySubmittedFingerprints = [];
  }
  const prepared = await prepareSharedUtilityRecovery({
    durablySubmittedFingerprints,
    kind: input.kind,
    expectedRevision: null,
    connectionOnly: input.connectionOnly === true || settledFirstPlacement !== null,

    selectedPrimitive: input.selectedPrimitive,
    candidatePreference: input.candidatePreference,
    signal: input.signal ?? new AbortController().signal,
    ports,
  });
  if (prepared.status !== "READY" || !prepared.plan || !prepared.facility || !prepared.connector || !prepared.selected) {
    // First-facility placement admission. The shared preparation has no native
    // execution authority here and must not gain one: when it reports that no
    // facility exists yet, and production explicitly authorizes this recipe's
    // first placement, admit a bounded scope instead of blocking. Nothing is
    // sent — `run()` performs the placement through the existing durable path.
    const plannedFacility = plannedFacilityOf(prepared.plan);
    if (prepared.reason === "UTILITY_FACILITY_NOT_FOUND" && plannedFacility) {
      const authorization = authorizingPlacement(input);
      if (authorization) return admitFirstPlacement(input, plannedFacility, authorization, prepared.diagnostics);
      // An authorization was presented but withheld because durable state does
      // not permit a new attempt. Report that distinctly, so the caller
      // reconciles the existing operation instead of reading a plain
      // facility-not-found and retrying a placement.
      const clearance = placementClearance(input);
      if (input.connectionOnly !== true && input.facilityPlacementAuthorization &&
        !firstFacilityPlacementPermitted(clearance)) {
        return blocked("UTILITY_FACILITY_PLACEMENT_UNRESOLVED", {
          preparationReason: prepared.reason,
          placementDurability: clearance.status,
          ...(clearance.status === "PLACED" || clearance.status === "UNRESOLVED"
            ? { placementCommandId: clearance.commandId, placementOutcome: clearance.status === "UNRESOLVED" ? clearance.outcome : null }
            : {}),
          ...(clearance.status === "UNPROVEN" ? { placementUnprovenReason: clearance.reason } : {}),
        });
      }
    }
    // The journal proves a first facility exists for this scope, but the world
    // readback could not be bound to it. Hold for reconciliation instead of
    // reporting a plain facility-not-found that callers would retry as a
    // placement. Fail-closed: nothing is submitted. Any other cause is reported
    // as itself, so it is never mislabelled as an unresolved placement.
    if (settledFirstPlacement && prepared.reason === "UTILITY_FACILITY_NOT_FOUND") {
      return blocked("UTILITY_FACILITY_PLACEMENT_UNRESOLVED", {
        preparationReason: prepared.reason,
        placementDurability: settledFirstPlacement.status,
        placementCommandId: settledFirstPlacement.commandId,
      });
    }
    const reason = prepared.reason === "NO_SUPPORTED_WATER_TOPOLOGY" || prepared.reason === "NO_FEASIBLE_ROAD_CANDIDATE" ? prepared.reason :
      prepared.reason === "no_safe_site" || prepared.reason === "unsupported" || prepared.reason === "stale_revision" ? "UTILITY_PLAN_UNAVAILABLE" :
      (prepared.reason === "UTILITY_FACILITY_NOT_FOUND" || prepared.reason === "connection_only_facility_rebind_failed") ? "UTILITY_FACILITY_NOT_FOUND" :
      prepared.reason === "UTILITY_CONNECTOR_NOT_FOUND" ? "UTILITY_CONNECTOR_NOT_FOUND" :
      prepared.reason === "UTILITY_CONNECTOR_AMBIGUOUS" ? "UTILITY_CONNECTOR_AMBIGUOUS" :
      prepared.reason === "UTILITY_CONNECTOR_OBSERVATION_INCOMPLETE" ? "UTILITY_CONNECTOR_OBSERVATION_INCOMPLETE" :
      prepared.reason === "EMPTY_DIRECT_CABLE_ACTIONS" ? "EMPTY_DIRECT_CABLE_ACTIONS" :
        prepared.reason === "EMPTY_UTILITY_CANDIDATE_ACTIONS" ? "EMPTY_UTILITY_CANDIDATE_ACTIONS" :
          prepared.reason === "DIRECT_CABLE_PREFLIGHT_REJECTED" ? "DIRECT_CABLE_PREFLIGHT_REJECTED" :
      prepared.reason === "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY" ? "UTILITY_PLAYER_ROAD_AUTHORITY_EMPTY" :
          prepared.reason === "UTILITY_FACILITY_AMBIGUOUS" ? "UTILITY_FACILITY_AMBIGUOUS" : "UTILITY_CONNECTION_CANDIDATE_MISSING";
    return blocked(reason, {
      preparationReason: prepared.reason,
      ...(prepared.diagnostics ?? {}),
      ...(prepared.currentBinding ? { currentBinding: prepared.currentBinding } : {}),
      ...(prepared.currentBindingResolved !== undefined ? { currentBindingResolved: prepared.currentBindingResolved } : {}),
      ...(prepared.candidateBuilderCalled !== undefined ? { candidateBuilderCalled: prepared.candidateBuilderCalled } : {}),
      ...(prepared.candidateCount !== undefined ? { candidateCount: prepared.candidateCount } : {}),
      ...(prepared.selectedCandidatePrimitive ? { selectedCandidatePrimitive: prepared.selectedCandidatePrimitive } : {}),
      ...(prepared.candidateActionCount !== undefined ? { candidateActionCount: prepared.candidateActionCount } : {}),
      ...(prepared.splitDiagnostics ? { splitDiagnostics: prepared.splitDiagnostics } : {}),
      connectionDiagnostics: prepared.connectionDiagnostics,
      preflightDiagnostics: prepared.preflightDiagnostics,
    });
  }

  const approvedContact = contactOf(prepared.selected.actions, prepared.selected.primitive);
  if (!approvedContact) return blocked("UTILITY_TARGET_CONTACT_MISMATCH", { candidate: prepared.selected.primitive });
  const edges = await ports.roadEdges({ center: approvedContact, radius: Math.max(64, input.spatialEnvelope.radius), signal: input.signal });
  const matches = edges.filter((edge) => pointToSegment(approvedContact, edge) <= 0.25);
  if (matches.length === 0) return blocked("UTILITY_TARGET_ROAD_NOT_FOUND", { approvedContact, edgeCount: edges.length });
  // Geometry identifies candidates; the certified ref chooses between them.
  //
  // Several edges can share the contact point — two roads meeting at one node,
  // or a road delivered later ending on a node an earlier one already occupies.
  // Which road a connection must enter is not a geometric question, and the
  // answer is already durable: the tranche certified its own ROAD_CONNECTION,
  // and the connection is bound to that road. So a contact that matches several
  // edges is resolved by the certified set rather than refused.
  //
  // Strictly narrower than the rule it replaces, and never wider: with nothing
  // certified, or with several certified edges matching, the old refusal stands
  // unchanged. An implementation that preferred a nearest edge instead would be
  // choosing a road by a heuristic, which is the thing this must not do.
  const planRoadRefs = "mode" in prepared.plan && prepared.plan.mode === "EXISTING_FACILITY_CONNECTION"
    ? prepared.plan.authoritativeRoadRefs ?? [] : [];
  const roadRefsForContact = planRoadRefs.length > 0 ? planRoadRefs : (input.certifiedRoadRefs ?? []);
  const certifiedRoads = new Set(roadRefsForContact.map((ref) => `${ref.index}:${ref.version}`));
  const certifiedMatches = matches.filter((edge) => certifiedRoads.has(`${edge.entity.index}:${edge.entity.version}`));
  if (certifiedMatches.length > 1) {
    return blocked("UTILITY_TARGET_ROAD_AMBIGUOUS", { approvedContact, count: certifiedMatches.length });
  }
  let targetRoad = certifiedMatches[0] ?? null;
  if (!targetRoad && matches.length !== 1) {
    // The durable refs no longer name anything — this is the post-reload case —
    // so the road is reacquired from the delivered command's own geometry. It is
    // the same reacquisition the planning scope uses, keyed on the same durable
    // facts, so the two cannot disagree about which road the slice entered. A
    // contact the command's own prefab and far endpoint still do not single out
    // fails closed with the original refusal.
    const reacquired = input.certifiedRoad
      ? reacquireTargetRoadByApprovedContact({
          edges,
          approvedContact,
          prefab: input.certifiedRoad.prefab,
          ...(input.certifiedRoad.farEnd ? { farEndpoint: input.certifiedRoad.farEnd } : {}),
        })
      : null;
    if (reacquired?.status !== "YES") {
      return blocked("UTILITY_TARGET_ROAD_AMBIGUOUS", { approvedContact, count: matches.length });
    }
    targetRoad = reacquired.road;
  }
  targetRoad ??= matches[0];
  // The service entry carries the durable command's own prefab and far endpoint
  // when the caller supplied them, and never the current world's: narrowing the
  // next reacquisition by what the current world happens to show would make the
  // search read its own answer back.
  const serviceEntryPrefab = input.certifiedRoad?.prefab;
  const serviceEntryFarEnd = input.certifiedRoad?.farEnd;
  const targetSemantics = input.kind === "electricity" ? electricityTargetSemantics({
    contact: approvedContact,
    targetRoad: { prefab: targetRoad.prefab, endpointRole: "start", anchor: approvedContact },
    approvedPlanRevision: input.topologyRevision,
  }) : undefined;
  const executionScope: GreenfieldUtilityExecutionScope = {
    intentId: input.intentId, projectId: input.projectId, trancheId: input.trancheId, reservationRef: input.reservationRef,
    worldId: input.worldId, worldEpochId: input.worldEpochId, generation: input.generation, topologyRevision: input.topologyRevision,
    executionMechanismRevision: EXECUTION_MECHANISM_REVISION,
    certifiedRoadRefs: [targetRoad.entity],
    targetServiceEntry: {
      road: targetRoad.entity,
      position: approvedContact,
      ...(serviceEntryPrefab ? { prefab: serviceEntryPrefab } : {}),
      ...(serviceEntryFarEnd ? { farEnd: { ...serviceEntryFarEnd } } : {}),
    },
    targetSemantics,
    spatialEnvelope: input.spatialEnvelope,
    maximumSpend: input.maximumSpend, treasury: input.treasury, treasurySafetyReserve: input.treasurySafetyReserve,
  };
  return {
    status: "READY", currentFacility: prepared.facility, currentConnector: prepared.connector, plan: prepared.plan,
    candidate: prepared.selected, targetServiceEntry: executionScope.targetServiceEntry, targetSemantics,
    approvedContact, nativeActions: prepared.selected.actions, executionScope, diagnostics: prepared.diagnostics,
    ...(input.kind === "electricity" && prepared.selected.primitive === "direct-cable" ? {
      boundary1Contract: {
        prefab: ELECTRICITY_NATIVE_DIRECT_CABLE_PREFAB, creationFlags: 65536 as const, original: null,
        start: { entity: null, flags: 51 as const }, end: { entity: null, flags: 51 as const },
      },
    } : {}),
  };
}
