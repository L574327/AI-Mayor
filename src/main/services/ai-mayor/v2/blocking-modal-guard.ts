export type BlockingModalClass =
  | "NO_MODAL"
  | "KNOWN_SAFE_DISMISSIBLE_MODAL"
  | "UNKNOWN_BLOCKING_MODAL"
  | "NON_BLOCKING_UI";

export interface BlockingModalObservation {
  identity: string | null;
  type: string | null;
  blocking: boolean;
  surfaceAvailable?: boolean;
  isVictory?: boolean;
  displayText?: string;
  detectionSource: string;
  runtimeCorrelation?: string;
}

export interface BlockingModalGuardEvidence {
  modalGuardCheckId: string;
  detected: boolean;
  modalClass: BlockingModalClass;
  modalIdentity: string | null;
  detectionSource: string;
  dismissAttempted: boolean;
  dismissMethod: string | null;
  dismissSucceeded: boolean | "UNKNOWN";
  verificationObservation: BlockingModalObservation | null;
  timestamp: string;
  runtimeCorrelation: string | null;
}

export interface BlockingModalSurface {
  observe(): Promise<BlockingModalObservation | null>;
  dismissKnownMilestone(observation: BlockingModalObservation): Promise<void>;
}

export interface BlockingModalJournal {
  append(evidence: BlockingModalGuardEvidence): void;
}

export interface BlockingModalGuardOptions {
  surface: BlockingModalSurface;
  journal: BlockingModalJournal;
  allowedMilestoneIdentities?: readonly string[];
  allowMilestoneIdentity?: (observation: BlockingModalObservation) => boolean;
  handledModalIdentities?: Set<string>;
  now?: () => string;
  checkId?: () => string;
  /**
   * Whether the Mayor may clear an ordinary milestone popup itself. Asked at the moment of the check (a player's switch, not a constant).
   * Absent: it may. When it may not, a known-safe popup is left alone and the guard waits for the PLAYER to close it
   * (`waitForPlayerMs`), then lets the run continue; if the player never does, the run does not continue.
   */
  autoDismiss?: (observation: BlockingModalObservation) => boolean;
  /** How long to wait for a player who closes the popup themselves, and how often to look. */
  waitForPlayerMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const PLAYER_DISMISS_WAIT_MS = 120_000;
export const PLAYER_DISMISS_POLL_MS = 1_500;

export interface BlockingModalGuardResult {
  allowedToContinue: boolean;
  modalClass: BlockingModalClass;
  evidence: BlockingModalGuardEvidence;
}

const defaultCheckId = () => `modal-guard-${Date.now().toString(36)}`;

function classifyModal(
  observation: BlockingModalObservation | null,
  allowedMilestoneIdentities: ReadonlySet<string>,
  allowMilestoneIdentity?: (observation: BlockingModalObservation) => boolean,
): BlockingModalClass {
  if (!observation) return "NO_MODAL";
  if (observation.surfaceAvailable === false) return "UNKNOWN_BLOCKING_MODAL";
  if (!observation.blocking) return "NON_BLOCKING_UI";
  if (
    (observation.type === "MILESTONE" || observation.type === "SIGNATURE_UNLOCK") &&
    observation.isVictory !== true &&
    observation.identity !== null &&
    (allowedMilestoneIdentities.has(observation.identity) || allowMilestoneIdentity?.(observation) === true)
  ) {
    return "KNOWN_SAFE_DISMISSIBLE_MODAL";
  }
  return "UNKNOWN_BLOCKING_MODAL";
}

function evidenceBase(
  checkId: string,
  observation: BlockingModalObservation | null,
  modalClass: BlockingModalClass,
  now: () => string,
): BlockingModalGuardEvidence {
  return {
    modalGuardCheckId: checkId,
    detected: observation !== null,
    modalClass,
    modalIdentity: observation?.identity ?? null,
    detectionSource: observation?.detectionSource ?? "NO_MODAL_SURFACE_OBSERVATION",
    dismissAttempted: false,
    dismissMethod: null,
    dismissSucceeded: false,
    verificationObservation: null,
    timestamp: now(),
    runtimeCorrelation: observation?.runtimeCorrelation ?? null,
  };
}

export async function checkBlockingModal(options: BlockingModalGuardOptions): Promise<BlockingModalGuardResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const checkId = (options.checkId ?? defaultCheckId)();
  const allowed = new Set(options.allowedMilestoneIdentities ?? []);
  const observation = await options.surface.observe();
  const alreadyHandled = observation?.identity !== null && observation?.identity !== undefined && options.handledModalIdentities?.has(observation.identity);
  const modalClass = alreadyHandled
    ? "UNKNOWN_BLOCKING_MODAL"
    : classifyModal(observation, allowed, options.allowMilestoneIdentity);
  const evidence = evidenceBase(checkId, observation, modalClass, now);

  if (modalClass === "NO_MODAL" || modalClass === "NON_BLOCKING_UI") {
    evidence.dismissSucceeded = false;
    options.journal.append(evidence);
    return { allowedToContinue: true, modalClass, evidence };
  }
  if (modalClass === "UNKNOWN_BLOCKING_MODAL" || !observation) {
    options.journal.append(evidence);
    return { allowedToContinue: false, modalClass: "UNKNOWN_BLOCKING_MODAL", evidence };
  }

  // The player turned automatic closing off: the popup is theirs. Do not touch it; wait for them to close it.
  if (options.autoDismiss && !options.autoDismiss(observation)) {
    evidence.dismissMethod = "PLAYER_DISMISS_EXPECTED";
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const pollMs = Math.max(1, options.pollMs ?? PLAYER_DISMISS_POLL_MS);
    const deadline = Date.now() + (options.waitForPlayerMs ?? PLAYER_DISMISS_WAIT_MS);
    let current: BlockingModalObservation | null = observation;
    for (;;) {
      if (!current || current.blocking !== true || current.identity !== observation.identity) break;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
      current = await options.surface.observe();
    }
    evidence.verificationObservation = current;
    const gone = !current || current.blocking !== true || current.identity !== observation.identity;
    evidence.dismissSucceeded = gone;
    options.journal.append(evidence);
    return { allowedToContinue: gone, modalClass, evidence };
  }

  evidence.dismissAttempted = true;
  evidence.dismissMethod = "EXPLICIT_ALLOWLISTED_MILESTONE_ACTION";
  try {
    await options.surface.dismissKnownMilestone(observation);
  } catch {
    evidence.dismissSucceeded = false;
    options.journal.append(evidence);
    return { allowedToContinue: false, modalClass, evidence };
  }

  const verificationObservation = await options.surface.observe();
  evidence.verificationObservation = verificationObservation;
  evidence.dismissSucceeded = verificationObservation === null || verificationObservation.blocking !== true;
  if (evidence.dismissSucceeded === true && observation.identity !== null) options.handledModalIdentities?.add(observation.identity);
  options.journal.append(evidence);
  return {
    allowedToContinue: evidence.dismissSucceeded === true,
    modalClass,
    evidence,
  };
}

// Future simulation drivers must call this bounded hook before advancing time.
export const guardBeforeSimulationProgress = checkBlockingModal;
