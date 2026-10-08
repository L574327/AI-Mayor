import {
  checkBlockingModal,
  type BlockingModalGuardEvidence,
  type BlockingModalGuardResult,
  type BlockingModalObservation,
} from "./blocking-modal-guard";
import { createBlockingModalSurface, stableBlockingModalIdentity, type BlockingModalMcpCaller } from "./blocking-modal-surface";
import { mayorUiSettings } from "../ui-settings";

export interface BlockingModalRuntimePort {
  check(signal?: AbortSignal): Promise<BlockingModalGuardResult>;
  evidence(): readonly BlockingModalGuardEvidence[];
  /**
   * Keep an eye on the popup for as long as `signal` is live, so an ordinary milestone popup is cleared within a few seconds of appearing —
   * not at the start of the next simulation window, which can be a minute of building later. Looks only while the player's switch allows the
   * Mayor to close it; never throws.
   */
  watch(signal: AbortSignal): Promise<void>;
  /** Forget which popups were already handled (the world changed or was reloaded: the same milestone can be raised again). */
  reset(): void;
}

export interface BlockingModalRuntimeOptions {
  /**
   * The player's switch for THIS popup, read at the moment of each check. Default: `mayorUiSettings` — the milestone switch for a milestone popup,
   * the signature-unlock switch for the "new signature building unlocked" popup.
   */
  autoDismiss?: (observation: BlockingModalObservation) => boolean;
  waitForPlayerMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the watcher looks. */
  watchEveryMs?: number;
}

/**
 * The watcher's rhythm. At 3 s it made 108 Bridge calls in a 12-minute run (89 s, 12% of the wall clock: each call queues behind whatever the
 * Bridge is reading). A popup also pauses the game, and every simulation window checks first anyway; 20 s is soon enough.
 */
export const BLOCKING_MODAL_WATCH_EVERY_MS = 20_000;

export function createBlockingModalRuntimePort(caller: BlockingModalMcpCaller, options: BlockingModalRuntimeOptions = {}): BlockingModalRuntimePort {
  const entries: BlockingModalGuardEvidence[] = [];
  const handled = new Set<string>();
  const autoDismiss = options.autoDismiss ?? ((observation: BlockingModalObservation) => {
    const settings = mayorUiSettings.get();
    return observation.type === "SIGNATURE_UNLOCK" ? settings.autoDismissSignatureUnlockModal : settings.autoDismissMilestoneModal;
  });
  // The watcher looks while the Mayor may close ANY kind of popup; the guard still asks the switch for the kind it actually finds.
  const probe = (type: string): BlockingModalObservation => ({ identity: null, type, blocking: true, detectionSource: "WATCH_PROBE" });
  const mayCloseAny = () => autoDismiss(probe("MILESTONE")) || autoDismiss(probe("SIGNATURE_UNLOCK"));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // One check at a time: the watcher and a simulation window must not both try to close the same popup (the second dismiss would find
  // the identity already gone and be read as a failure).
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };
  const check = (signal?: AbortSignal) => serialized(async () => {
    const surface = createBlockingModalSurface(caller, signal);
    const result = await checkBlockingModal({
      surface,
      handledModalIdentities: handled,
      autoDismiss,
      ...(options.waitForPlayerMs !== undefined ? { waitForPlayerMs: options.waitForPlayerMs } : {}),
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      // The Bridge adapter has already validated the exact structured
      // identity; the shared guard still rejects victory observations.
      allowMilestoneIdentity: (observation) =>
        observation.isVictory === false && typeof observation.identity === "string" && (
          (observation.type === "MILESTONE" && observation.identity.startsWith('{"kind":"PROGRESSION_MILESTONE"')) ||
          (observation.type === "SIGNATURE_UNLOCK" && observation.identity.startsWith('{"kind":"SIGNATURE_UNLOCK"'))),
      journal: { append: (entry) => entries.push(entry) },
    });
    // The popup is gone: if the same milestone is raised again later (the save was loaded again) it is a new occurrence, not a loop.
    // (The Bridge's "no popup" answer arrives as a non-blocking observation, i.e. NON_BLOCKING_UI, as often as a bare NO_MODAL.)
    if (result.modalClass === "NO_MODAL" || result.modalClass === "NON_BLOCKING_UI") handled.clear();
    return result;
  });
  return {
    check,
    evidence: () => entries.slice(),
    reset: () => { handled.clear(); },
    async watch(signal) {
      // Off by default: the popup is closed by the check that opens every simulation window (a milestone popup pauses the game, and that is the
      // only moment the Mayor needs it gone). The background look cost 12% of a run's wall clock for popups nobody was waiting on.
      // AI_MAYOR_MODAL_BACKGROUND_WATCH=1 turns it back on.
      if (options.watchEveryMs === undefined && process.env.AI_MAYOR_MODAL_BACKGROUND_WATCH !== "1") return;
      const every = options.watchEveryMs ?? BLOCKING_MODAL_WATCH_EVERY_MS;
      while (!signal.aborted) {
        await sleep(every);
        if (signal.aborted) break;
        // Switch off: the popup is the player's. The guard of the next simulation window still waits for them; this loop stays out of it.
        if (!mayCloseAny()) continue;
        try { await check(signal); } catch { /* a missed look is retried at the next one */ }
      }
    },
  };
}

export { stableBlockingModalIdentity };
