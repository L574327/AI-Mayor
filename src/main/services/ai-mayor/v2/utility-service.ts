import type { SpatialEntityRef } from "../spatial/types";
import type { ObservationCoherence, ObservationSourceStatus, V2SourcePayload } from "./foundation";

export const V2_TARGET_UTILITY_SCHEMA_VERSION = "ai-mayor-v2-target-utility/1";

export type TargetUtilityStatus =
  | "SERVED"
  | "UNSERVED"
  | "CONNECTED_BUT_UNFULFILLED"
  | "CONFLICT"
  | "UNKNOWN"
  | "UNAVAILABLE";

export interface ElectricityConsumerFacts {
  connected: boolean;
  wantedConsumption: number;
  fulfilledConsumption: number;
  noElectricityWarning: boolean;
  bottleneckWarning: boolean;
  flags: string;
}

export interface WaterConsumerFacts {
  waterConnected: boolean;
  sewageConnected: boolean;
  wantedConsumption: number;
  fulfilledFresh: number;
  fulfilledSewage: number;
  pollution: number;
  flags: string;
}

export interface TargetUtilityResult<TFacts> {
  status: TargetUtilityStatus;
  statusProvenance: "DERIVED_WITH_EXPLICIT_RULE" | "UNKNOWN";
  observed: (TFacts & { provenance: "OBSERVED_NATIVE_COMPONENT" }) | null;
  rule: string | null;
  assumptions: string[];
  invalidityConditions: string[];
  reason: string;
}

export interface TargetUtilityServiceObservation {
  schemaVersion: typeof V2_TARGET_UTILITY_SCHEMA_VERSION;
  buildingRef: SpatialEntityRef;
  runtimeEpoch: string;
  observationId: string;
  readStartedAt: string;
  readEndedAt: string;
  simulationFrameStart: number | null;
  simulationFrameEnd: number | null;
  pausedBefore: boolean | null;
  pausedAfter: boolean | null;
  coherence: ObservationCoherence;
  source: {
    status: ObservationSourceStatus;
    reason: string | null;
    readStartedAt: string;
    readEndedAt: string;
    authoritativeBasis:
      | "Game.Buildings.ElectricityConsumer+Game.Buildings.WaterConsumer"
      | "UNAVAILABLE";
  };
  electricity: TargetUtilityResult<ElectricityConsumerFacts>;
  water: TargetUtilityResult<WaterConsumerFacts>;
  sewage: TargetUtilityResult<WaterConsumerFacts>;
  globalCapacityPolicy: "SUPPORTING_CONTEXT_ONLY_NOT_USED_FOR_TARGET_STATUS";
  facilityConnectorPolicy: "ABSENCE_DOES_NOT_IMPLY_CONSUMER_UNSERVED";
}

export interface TargetUtilityServicePorts {
  readonly runtimeEpoch: string;
  observe(input: { buildingRef: SpatialEntityRef; signal?: AbortSignal }): Promise<TargetUtilityServiceObservation>;
}

interface RawTargetUtilityPayload {
  consumerService?: {
    electricity?: unknown;
    water?: unknown;
  };
}

type Clock = () => Date;

const objectRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finiteNonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function stateFacts(value: unknown): { frame: number | null; paused: boolean | null } {
  const root = objectRecord(value);
  const simulation = objectRecord(root.simulation);
  const frameValue = simulation.frameIndex ?? root.frameIndex;
  const pausedValue = simulation.paused ?? root.paused;
  return {
    frame: typeof frameValue === "number" && Number.isFinite(frameValue) ? frameValue : null,
    paused: typeof pausedValue === "boolean" ? pausedValue : null,
  };
}

function parseElectricity(value: unknown): ElectricityConsumerFacts | null {
  const item = objectRecord(value);
  const wantedConsumption = finiteNonNegative(item.wantedConsumption);
  const fulfilledConsumption = finiteNonNegative(item.fulfilledConsumption);
  if (
    typeof item.connected !== "boolean" ||
    wantedConsumption === null ||
    fulfilledConsumption === null ||
    typeof item.noElectricityWarning !== "boolean" ||
    typeof item.bottleneckWarning !== "boolean"
  ) {
    return null;
  }
  return {
    connected: item.connected,
    wantedConsumption,
    fulfilledConsumption,
    noElectricityWarning: item.noElectricityWarning,
    bottleneckWarning: item.bottleneckWarning,
    flags: typeof item.flags === "string" ? item.flags : "",
  };
}

function parseWater(value: unknown): WaterConsumerFacts | null {
  const item = objectRecord(value);
  const wantedConsumption = finiteNonNegative(item.wantedConsumption);
  const fulfilledFresh = finiteNonNegative(item.fulfilledFresh);
  const fulfilledSewage = finiteNonNegative(item.fulfilledSewage);
  const pollution = finiteNonNegative(item.pollution);
  if (
    typeof item.waterConnected !== "boolean" ||
    typeof item.sewageConnected !== "boolean" ||
    wantedConsumption === null ||
    fulfilledFresh === null ||
    fulfilledSewage === null ||
    pollution === null
  ) {
    return null;
  }
  return {
    waterConnected: item.waterConnected,
    sewageConnected: item.sewageConnected,
    wantedConsumption,
    fulfilledFresh,
    fulfilledSewage,
    pollution,
    flags: typeof item.flags === "string" ? item.flags : "",
  };
}

const unavailable = <T>(reason: string): TargetUtilityResult<T> => ({
  status: "UNAVAILABLE",
  statusProvenance: "UNKNOWN",
  observed: null,
  rule: null,
  assumptions: [],
  invalidityConditions: ["the authoritative per-building consumer component was not available"],
  reason,
});

function classifyFulfillment<TFacts>(input: {
  facts: TFacts;
  connected: boolean;
  wanted: number;
  fulfilled: number;
  source: string;
  explicitProblem?: boolean;
}): TargetUtilityResult<TFacts> {
  const observed = { ...input.facts, provenance: "OBSERVED_NATIVE_COMPONENT" as const };
  const common = {
    statusProvenance: "DERIVED_WITH_EXPLICIT_RULE" as const,
    observed,
    assumptions: ["wanted and fulfilled values refer to the same current per-building consumer component"],
    invalidityConditions: [
      "entity became stale or was replaced",
      "the observation frame drifted",
      "the game changes the component field semantics",
    ],
  };
  if (!input.connected && input.fulfilled > 0) {
    return {
      ...common,
      status: "CONFLICT",
      rule: "disconnected with positive fulfilled consumption is internally conflicting",
      reason: `${input.source} reports disconnected while fulfilled consumption is positive`,
    };
  }
  if (!input.connected) {
    return {
      ...common,
      status: "UNSERVED",
      rule: "authoritative consumer connection flag is false",
      reason: `${input.source} reports no consumer connection`,
    };
  }
  if (input.wanted === 0) {
    return {
      ...common,
      status: "UNKNOWN",
      rule: "a connected consumer with zero current demand cannot prove delivered service",
      reason: `${input.source} is connected but has zero wanted consumption`,
    };
  }
  if (input.fulfilled < input.wanted) {
    return {
      ...common,
      status: "CONNECTED_BUT_UNFULFILLED",
      rule: "connected AND wanted > 0 AND fulfilled < wanted",
      reason: `${input.source} is connected but current fulfilled consumption is below wanted consumption`,
    };
  }
  if (input.explicitProblem === true) {
    return {
      ...common,
      status: "CONFLICT",
      rule: "fulfilled >= wanted conflicts with an explicit active utility problem flag",
      reason: `${input.source} fulfillment and explicit problem evidence conflict`,
    };
  }
  return {
    ...common,
    status: "SERVED",
    rule: "connected AND wanted > 0 AND fulfilled >= wanted AND no conflicting explicit problem",
    reason: `${input.source} reports current per-building demand fully fulfilled`,
  };
}

export function projectTargetUtilityService(
  buildingRef: SpatialEntityRef,
  payload: RawTargetUtilityPayload,
): Pick<TargetUtilityServiceObservation, "buildingRef" | "electricity" | "water" | "sewage"> {
  const consumerService = objectRecord(payload.consumerService);
  const electricity = parseElectricity(consumerService.electricity);
  const water = parseWater(consumerService.water);
  return {
    buildingRef,
    electricity: electricity
      ? classifyFulfillment({
          facts: electricity,
          connected: electricity.connected,
          wanted: electricity.wantedConsumption,
          fulfilled: electricity.fulfilledConsumption,
          explicitProblem: electricity.noElectricityWarning || electricity.bottleneckWarning,
          source: "Game.Buildings.ElectricityConsumer",
        })
      : unavailable("Game.Buildings.ElectricityConsumer was absent or malformed"),
    water: water
      ? classifyFulfillment({
          facts: water,
          connected: water.waterConnected,
          wanted: water.wantedConsumption,
          fulfilled: water.fulfilledFresh,
          source: "Game.Buildings.WaterConsumer fresh-water fields",
        })
      : unavailable("Game.Buildings.WaterConsumer was absent or malformed"),
    sewage: water
      ? classifyFulfillment({
          facts: water,
          connected: water.sewageConnected,
          wanted: water.wantedConsumption,
          fulfilled: water.fulfilledSewage,
          source: "Game.Buildings.WaterConsumer sewage fields",
        })
      : unavailable("Game.Buildings.WaterConsumer was absent or malformed"),
  };
}

export function createTargetUtilityServicePorts(options: {
  runtimeEpoch: string;
  readGameState(signal?: AbortSignal): Promise<V2SourcePayload>;
  readTarget(buildingRef: SpatialEntityRef, signal?: AbortSignal): Promise<V2SourcePayload<RawTargetUtilityPayload>>;
  now?: Clock;
  createId?: () => string;
}): TargetUtilityServicePorts {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  return {
    runtimeEpoch: options.runtimeEpoch,
    async observe({ buildingRef, signal }) {
      const started = now();
      let before: V2SourcePayload = { status: "UNAVAILABLE", reason: "state read not attempted" };
      let target: V2SourcePayload<RawTargetUtilityPayload> = {
        status: "UNAVAILABLE",
        reason: "target read not attempted",
      };
      let after: V2SourcePayload = { status: "UNAVAILABLE", reason: "state read not attempted" };
      const sourceStarted = now();
      try {
        before = await options.readGameState(signal);
        target = await options.readTarget(buildingRef, signal);
        after = await options.readGameState(signal);
      } catch (error) {
        target = { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : String(error) };
        try {
          after = await options.readGameState(signal);
        } catch {
          // Keep the unavailable state evidence.
        }
      }
      const sourceEnded = now();
      const beforeFacts = stateFacts(before.data);
      const afterFacts = stateFacts(after.data);
      const allAvailable = before.status !== "UNAVAILABLE" && target.status !== "UNAVAILABLE" && after.status !== "UNAVAILABLE";
      const coherence: ObservationCoherence =
        beforeFacts.frame === null || afterFacts.frame === null || !allAvailable
          ? "UNKNOWN"
          : beforeFacts.frame === afterFacts.frame
            ? "STABLE_FRAME"
            : "BOUNDED_DRIFT";
      const projected = projectTargetUtilityService(buildingRef, target.data ?? {});
      const unavailableReason = target.reason ?? "target utility source unavailable";
      const ended = now();
      return {
        schemaVersion: V2_TARGET_UTILITY_SCHEMA_VERSION,
        ...projected,
        ...(target.status === "UNAVAILABLE"
          ? {
              electricity: unavailable<ElectricityConsumerFacts>(unavailableReason),
              water: unavailable<WaterConsumerFacts>(unavailableReason),
              sewage: unavailable<WaterConsumerFacts>(unavailableReason),
            }
          : {}),
        runtimeEpoch: options.runtimeEpoch,
        observationId: createId(),
        readStartedAt: started.toISOString(),
        readEndedAt: ended.toISOString(),
        simulationFrameStart: beforeFacts.frame,
        simulationFrameEnd: afterFacts.frame,
        pausedBefore: beforeFacts.paused,
        pausedAfter: afterFacts.paused,
        coherence,
        source: {
          status: target.status,
          reason: target.reason ?? null,
          readStartedAt: sourceStarted.toISOString(),
          readEndedAt: sourceEnded.toISOString(),
          authoritativeBasis:
            target.status === "UNAVAILABLE"
              ? "UNAVAILABLE"
              : "Game.Buildings.ElectricityConsumer+Game.Buildings.WaterConsumer",
        },
        globalCapacityPolicy: "SUPPORTING_CONTEXT_ONLY_NOT_USED_FOR_TARGET_STATUS",
        facilityConnectorPolicy: "ABSENCE_DOES_NOT_IMPLY_CONSUMER_UNSERVED",
      };
    },
  };
}
