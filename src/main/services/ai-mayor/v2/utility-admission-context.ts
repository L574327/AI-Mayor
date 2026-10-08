import type { SpatialEntityRef, SpatialPoint2 } from "../spatial/types";
import type { UtilityRecoveryKind } from "../utility-recovery";
import type { Gate1State } from "./gate1";
import type { NativeWorldIdentity, V2UtilityBudgetAmendmentRecord } from "./durability";
import {
  type UtilityFacilityPlacementAuthorization,
  type UtilityPreparationInput,
  utilityFacilityRecipe,
} from "./utility-execution-planner";
import type { FirstFacilityPlacementDurability } from "./utility-placement-durability";

/**
 * The utility kind this admission contract serves by default: K05's
 * basic-electricity provision. Exported so the composition root asks durability
 * about the same kind the builder admits, instead of restating it.
 */
export const AUTHORITATIVE_UTILITY_KIND = "electricity" as const;

export interface AuthoritativeUtilityAdmissionContext {
  state: Gate1State;
  world: NativeWorldIdentity;
  treasury: number;
  /**
   * The supply-side utility family this admission serves. Defaults to
   * {@link AUTHORITATIVE_UTILITY_KIND}.
   *
   * The kind is not a label: it selects the production recipe the placement is
   * authorized under, the connector family the facility must expose, and the
   * capacity field service certification is read from. Water and sewage run
   * through exactly this contract, so the caller — not this module — decides
   * which family is being commissioned.
   */
  kind?: UtilityRecoveryKind;
  connectionOnly?: boolean;
  /** Authorize only first facility placement while Gate 1 remains pre-road. */
  facilityPlacementOnly?: boolean;
  deferConnectionUntilPlaced?: boolean;
  /** Read-only Stage B feasibility against a facility already present in-world. */
  stageBReadOnly?: boolean;
  selectedPrimitive?: "service-road" | "direct-cable" | "facility-access-road";
  /**
   * The road the Gate 1 state machine already delivered and certified for this
   * tranche, read from durable ROAD_DELIVERED evidence (the ROAD_CONNECTION
   * terminal outcome's durable command). It is the only road authority a first
   * facility placement may use; when it is absent, placement stays
   * unauthorized and preparation keeps failing closed.
   */
  certifiedRoad?: { entity: SpatialEntityRef; position: SpatialPoint2; prefab: string; farEnd?: SpatialPoint2 };
  /** Every road ref certified for this tranche. Defaults to the delivered road alone. */
  certifiedRoadRefs?: readonly SpatialEntityRef[];
  /**
   * Durable, restart-stable state of this tranche's first-facility placement
   * operations, read from the durable command journal by the composition root.
   *
   * Absent means no durable proof was supplied. Preparation treats that as
   * "unproven" and withholds placement rather than assuming a clean scope: a
   * crash between the native placement and the durable utility completion can
   * hide an already-built facility from the current observation.
   */
  firstFacilityPlacement?: FirstFacilityPlacementDurability;
  /**
   * The one append-only budget amendment this project may hold, read from the
   * durable store.
   *
   * The admitted budget is part of an immutable admission record, so a project
   * whose plan costs more than it was admitted with is funded by an amendment
   * rather than by rewriting that record. When one is supplied it is the
   * effective budget; when none is, the admitted budget stands. A record that
   * does not belong to this exact project is refused rather than ignored,
   * because silently ignoring it would execute under a budget nobody chose.
   */
  utilityBudgetAmendment?: V2UtilityBudgetAmendmentRecord | null;
}

/**
 * What utility execution for this project is authorized to spend.
 *
 * The amendment can only ever raise the budget, and only for the project it
 * names: its identity fields are compared against the live state rather than
 * trusted, and it carries no reservation, no facility count and no scope, so
 * there is nothing in it that could widen the execution beyond the spend.
 */
function effectiveProjectBudget(input: AuthoritativeUtilityAdmissionContext, state: Gate1State): number {
  const amendment = input.utilityBudgetAmendment;
  if (!amendment) return state.project.maximumBudget;
  if (
    amendment.projectId !== state.project.id ||
    amendment.intentId !== state.intent.id ||
    amendment.trancheId !== state.tranche.id ||
    amendment.reservationRef !== state.tranche.reservationRef
  ) {
    throw new Error("UTILITY_ADMISSION_BUDGET_AMENDMENT_SCOPE_MISMATCH");
  }
  return Math.max(state.project.maximumBudget, amendment.amendedEffectiveBudget);
}

/**
 * The first-facility placement authorization for the admitted utility kind's
 * recipe.
 *
 * Authority comes only from production state: the recipe that kind is provided
 * by, the admitted Gate 1 scope, the observed treasury and admitted project
 * budget, and the certified road Gate 1 actually delivered. A connection-only
 * request never receives one.
 */
function facilityPlacementAuthorization(
  input: AuthoritativeUtilityAdmissionContext,
  state: Gate1State,
  kind: UtilityRecoveryKind,
): UtilityFacilityPlacementAuthorization | undefined {
  if (input.connectionOnly === true) return undefined;
  const targetRoad = input.certifiedRoad;
  if (!targetRoad && input.facilityPlacementOnly !== true) return undefined;
  return {
    // The recipe is derived from the kind, never restated here: a placement
    // authorized for electricity can never be replayed as a water placement.
    recipe: utilityFacilityRecipe(kind),
    kind,
    intentId: state.intent.id,
    projectId: state.project.id,
    trancheId: state.tranche.id,
    reservationRef: state.tranche.reservationRef,
    placementScopeId: state.tranche.utilityExecution?.utilities[kind]?.placementScopeId ?? "utility-placement:legacy",
    spatialEnvelope: state.project.utilityReservation,
    maximumSpend: Math.min(effectiveProjectBudget(input, state), input.treasury),
    maximumPlacements: 1,
    facilityPlacementOnly: input.facilityPlacementOnly === true,
    certifiedRoadRefs: targetRoad ? input.certifiedRoadRefs ?? [targetRoad.entity] : [],
    ...(targetRoad ? { targetRoad } : {}),
  };
}

/**
 * The certified road refs this context supplies, in one place.
 *
 * The refs are supplied either as a set or as the single road the placement was
 * authorized against; both describe the same durable fact, and restating the
 * fallback at each use site is how the two would drift.
 */
function certifiedRoadRefsOf(input: AuthoritativeUtilityAdmissionContext): SpatialEntityRef[] {
  if (input.certifiedRoadRefs && input.certifiedRoadRefs.length > 0) return [...input.certifiedRoadRefs];
  return input.certifiedRoad ? [input.certifiedRoad.entity] : [];
}

/** Maps already-authoritative V2 state into the existing utility admission contract. */
export function buildUtilityPreparationInput(input: AuthoritativeUtilityAdmissionContext): UtilityPreparationInput {
  const { state, world } = input;
  const kind = input.kind ?? AUTHORITATIVE_UTILITY_KIND;
  const currentRoadTaskId = state.tranche.currentTaskIds?.ROAD_CONNECTION;
  const currentRoadTask = currentRoadTaskId
    ? state.tasks.find((task) => task.id === currentRoadTaskId && task.kind === "ROAD_CONNECTION")
    : state.tasks.find((task) => task.kind === "ROAD_CONNECTION");
  const stagedPlacementUnderRoadBlock = input.facilityPlacementOnly === true &&
    state.tranche.stage === "SITE_SELECTED" && state.project.status === "BLOCKED" &&
    state.tasks.some((task) => task.kind === "ROAD_CONNECTION" && task.status === "BLOCKED") &&
    state.tasks.filter((task) => task.status === "BLOCKED").every((task) => task.kind === "ROAD_CONNECTION");
  const readOnlyPlannerInputReplacement = input.stageBReadOnly === true && input.connectionOnly === true &&
    state.tranche.stage === "SITE_SELECTED" && currentRoadTask?.terminalOutcomeId !== null &&
    ["BLOCKED", "FAILED"].includes(currentRoadTask?.status ?? "") && !!currentRoadTask?.childOperationAmendmentId &&
    state.tasks.filter((task) => task.status === "BLOCKED").every((task) => task.kind === "ROAD_CONNECTION");
  if (world.worldReady !== true) throw new Error("UTILITY_ADMISSION_WORLD_NOT_READY");
  if (!Number.isFinite(input.treasury) || input.treasury < 0) throw new Error("UTILITY_ADMISSION_TREASURY_UNKNOWN");
  if (state.project.status !== "ACTIVE" && !stagedPlacementUnderRoadBlock && !readOnlyPlannerInputReplacement) {
    throw new Error("UTILITY_ADMISSION_PROJECT_NOT_ACTIVE");
  }
  // Gate 1 admits supply-side utility execution at ROAD_DELIVERED. That is the
  // stage where the Gate 1 state machine requires `tranche.utilityExecution`
  // (`recordUtilityExecution` rejects any other stage) and where the ZONING task
  // is gated on every utility reaching SERVICE_CERTIFIED. `BUILDING_OBSERVED` is
  // a later consumer-service certification boundary and can never admit a
  // supply-side utility: requiring it made production K05 unreachable.
  if (state.tranche.stage !== "ROAD_DELIVERED" &&
    !(input.facilityPlacementOnly === true && state.tranche.stage === "SITE_SELECTED") &&
    !(input.stageBReadOnly === true && input.connectionOnly === true && state.tranche.stage === "SITE_SELECTED")) {
    throw new Error("UTILITY_ADMISSION_STAGE_NOT_ROAD_DELIVERED");
  }
  if (state.tranche.projectId !== state.project.id || state.tranche.reservationRef !== state.district.reservationRef) {
    throw new Error("UTILITY_ADMISSION_SCOPE_IDENTITY_MISMATCH");
  }
  return {
    kind,
    intentId: state.intent.id,
    projectId: state.project.id,
    trancheId: state.tranche.id,
    reservationRef: state.tranche.reservationRef,
    placementScopeId: state.tranche.utilityExecution?.utilities[kind]?.placementScopeId ?? "utility-placement:legacy",
    worldId: world.worldId,
    worldEpochId: world.worldEpochId,
    generation: world.generation,
    topologyRevision: `${world.generation}:production`,
    spatialEnvelope: state.project.utilityReservation,
    maximumSpend: Math.min(effectiveProjectBudget(input, state), input.treasury),
    treasury: input.treasury,
    treasurySafetyReserve: 0,
    ...(input.connectionOnly === undefined ? {} : { connectionOnly: input.connectionOnly }),
    ...(input.facilityPlacementOnly === undefined ? {} : { facilityPlacementOnly: input.facilityPlacementOnly }),
    ...(input.deferConnectionUntilPlaced === undefined ? {} : { deferConnectionUntilPlaced: input.deferConnectionUntilPlaced }),
    ...(input.selectedPrimitive === undefined ? {} : { selectedPrimitive: input.selectedPrimitive }),
    ...(() => {
      const authorization = facilityPlacementAuthorization(input, state, kind);
      return authorization ? { facilityPlacementAuthorization: authorization } : {};
    })(),
    // Certified road identity travels on the input itself, not only inside the
    // placement authorization. A connection-only preparation carries no
    // authorization — the facility is already placed — and it is exactly the
    // case that needs the ref: it is the one that has to decide which road the
    // pipe enters when the contact point alone cannot.
    ...(certifiedRoadRefsOf(input).length > 0 ? { certifiedRoadRefs: certifiedRoadRefsOf(input) } : {}),
    // The same road as durable geometry: its prefab and the command's committed
    // far endpoint. A connection-only preparation carries no placement
    // authorization, so this is the only place those two can travel — and they
    // are exactly what the road is reacquired from once its durable refs stop
    // naming anything after a reload.
    ...(input.certifiedRoad ? { certifiedRoad: { ...input.certifiedRoad } } : {}),
    // The durable placement state travels with the admission. Preparation is
    // the boundary that decides whether it permits a new attempt, so the
    // authorization is attached (and reported as withheld) rather than silently
    // dropped — but a caller that supplies no durable proof never gets one.
    ...(input.firstFacilityPlacement === undefined ? {} : { firstFacilityPlacement: input.firstFacilityPlacement }),
  };
}
