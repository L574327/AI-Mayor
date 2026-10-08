import type {
  BlockingModalObservation,
  BlockingModalSurface,
} from "./blocking-modal-guard";

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};

export interface BlockingModalMcpCaller {
  call(name: "cs2_read_blocking_modal" | "cs2_dismiss_blocking_modal", args?: RecordValue, signal?: AbortSignal): Promise<unknown>;
}

/** An ordinary milestone popup: identified by the milestone entity the game shows. */
export interface BlockingModalIdentity {
  kind: "PROGRESSION_MILESTONE";
  entity: { index: number; version: number };
  milestoneIndex: number;
  isVictory: boolean;
}

/**
 * The "new signature building unlocked" popup: identified by the exact list of unlocked entities it shows ("index:version,..."), as the Bridge
 * read it from the frontend. It carries a building to look at and an OK button, never a decision; it is never a victory modal.
 */
export interface SignatureUnlockIdentity {
  kind: "SIGNATURE_UNLOCK";
  key: string;
  count: number;
  isVictory: false;
}

export type KnownModalIdentity = BlockingModalIdentity | SignatureUnlockIdentity;

const identityOf = (value: unknown): KnownModalIdentity | null => {
  const root = record(value);
  const identity = record(root.modalIdentity);
  if (identity.kind === "SIGNATURE_UNLOCK") {
    if (typeof identity.key !== "string" || identity.key.length === 0 || !Number.isInteger(identity.count) || (identity.count as number) < 1) return null;
    return { kind: "SIGNATURE_UNLOCK", key: identity.key, count: identity.count as number, isVictory: false };
  }
  const entity = record(identity.entity);
  if (
    identity.kind !== "PROGRESSION_MILESTONE" ||
    !Number.isInteger(entity.index) ||
    !Number.isInteger(entity.version) ||
    !Number.isInteger(identity.milestoneIndex) ||
    typeof identity.isVictory !== "boolean"
  ) return null;
  return {
    kind: "PROGRESSION_MILESTONE",
    entity: { index: entity.index as number, version: entity.version as number },
    milestoneIndex: identity.milestoneIndex as number,
    isVictory: identity.isVictory as boolean,
  };
};

export const stableBlockingModalIdentity = (identity: KnownModalIdentity): string => JSON.stringify(identity);

function toObservation(value: unknown): BlockingModalObservation {
  const root = record(value);
  const identity = identityOf(root);
  const modalClass = typeof root.modalClass === "string" ? root.modalClass : "UNKNOWN_BLOCKING_MODAL";
  const unavailable = root.surfaceAvailable === false || modalClass === "UI_SURFACE_UNAVAILABLE";
  return {
    identity: identity ? stableBlockingModalIdentity(identity) : null,
    type: identity ? (identity.kind === "SIGNATURE_UNLOCK" ? "SIGNATURE_UNLOCK" : "MILESTONE") : modalClass,
    blocking: unavailable || modalClass === "UNKNOWN_BLOCKING_MODAL" || modalClass === "KNOWN_SAFE_DISMISSIBLE_MODAL",
    surfaceAvailable: !unavailable,
    isVictory: identity?.isVictory,
    detectionSource: typeof root.detectionSource === "string" ? root.detectionSource : "BRIDGE_UI_BINDING_SURFACE",
    runtimeCorrelation: typeof root.commandId === "string" ? root.commandId : undefined,
  };
}

export function createBlockingModalSurface(caller: BlockingModalMcpCaller, signal?: AbortSignal): BlockingModalSurface {
  return {
    async observe() {
      return toObservation(await caller.call("cs2_read_blocking_modal", {}, signal));
    },
    // Named for the first popup it learned to close; it closes the exact known identity it was handed, milestone or signature building.
    async dismissKnownMilestone(observation) {
      if (!observation.identity) throw new Error("blocking modal identity is missing");
      const identity = JSON.parse(observation.identity) as KnownModalIdentity;
      if (identity.kind === "SIGNATURE_UNLOCK") {
        if (identity.isVictory !== false || !identity.key) throw new Error("signature popup identity is not safe to dismiss");
      } else if (identity.kind !== "PROGRESSION_MILESTONE" || identity.isVictory) throw new Error("milestone is not safe to dismiss");
      await caller.call("cs2_dismiss_blocking_modal", { expected: identity }, signal);
    },
  };
}
