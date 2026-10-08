import type { Gate1WorldBoundary, StarterResidentialIntentInput } from "./gate1";
import {
  authoritativeGate1RouteAnchor,
  createGate1ObservationProjector,
  type Gate1ObservationProjectorOptions,
} from "./gate1-observation";
import { V2LocalGate1ProductionRunner, type V2LocalGate1ProductionRunnerOptions } from "./local-gate1-runner";
import type { V2FoundationPorts } from "./main-adapter";

export interface V2LocalGate1FoundationRunnerOptions {
  foundation: V2FoundationPorts;
  boundary: Gate1WorldBoundary;
  /**
   * Only needed for a world with no durable Gate 1 state. When the coordinator
   * already holds one, the runner restores it and omitting this stays correct;
   * with neither, `createGate1VerticalSlice` fails closed.
   */
  initial?: StarterResidentialIntentInput;
  resolveRouteAnchor?: Gate1ObservationProjectorOptions["resolveRouteAnchor"];
  nextDecision?: V2LocalGate1ProductionRunnerOptions["nextDecision"];
}

/**
 * Production composition for the V2 Local Gate 1 path.
 *
 * The caller supplies only the V2 Foundation ports and the already-admitted
 * execution boundary. This factory binds world activation before constructing
 * the scoped observation projector and the durable deterministic runner.
 */
export async function createV2LocalGate1FoundationRunner(
  options: V2LocalGate1FoundationRunnerOptions,
  signal?: AbortSignal,
): Promise<V2LocalGate1ProductionRunner> {
  if (!options.foundation.durability || !options.foundation.activateDurableWorld) {
    throw new Error("V2 Local Gate 1 production runner requires V2 durable Foundation ports");
  }
  const activation = await options.foundation.activateDurableWorld(signal);
  if (activation.blockedReason) throw new Error(`V2 durable world blocked: ${activation.blockedReason}`);
  if (!options.foundation.durability.isExecutionDurablyActivated(activation)) {
    throw new Error(`${activation.status}: Local V2 durable execution boundary is not certified for this world`);
  }
  const projector = createGate1ObservationProjector({
    foundation: options.foundation,
    world: activation.world,
    resolveRouteAnchor: options.resolveRouteAnchor ?? ((input) => authoritativeGate1RouteAnchor(input.access)),
  });
  const runnerOptions: V2LocalGate1ProductionRunnerOptions = {
    durability: {
      coordinator: options.foundation.durability,
      activate: options.foundation.activateDurableWorld,
    },
    boundary: options.boundary,
    initial: options.initial,
    observe: projector.observe,
    nextDecision: options.nextDecision,
  };
  return V2LocalGate1ProductionRunner.create(runnerOptions, signal);
}
