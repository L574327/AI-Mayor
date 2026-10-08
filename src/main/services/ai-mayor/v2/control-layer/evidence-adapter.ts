import type { CommandObservationEvidence, ObservationCoherence, V2CommandJournal } from "../foundation";
import type { ActionEvidence } from "./types";
import type { EvidenceRecorder } from "./ports";

export interface ControlLayerEvidenceAdapter extends EvidenceRecorder {
  toCommandObservationEvidence(evidence: ActionEvidence): CommandObservationEvidence;
}

export interface CommandObservationEvidenceSink {
  append(commandId: string, evidence: CommandObservationEvidence): Promise<void>;
}

/**
 * Minimal bridge into the existing V2 journal. Control Layer only appends
 * observation evidence; command authorization, submission, and status
 * transitions remain owned by the existing V2 kernels.
 */
export class V2CommandJournalEvidenceSink implements CommandObservationEvidenceSink {
  constructor(private readonly journal: V2CommandJournal) {}

  async append(commandId: string, evidence: CommandObservationEvidence): Promise<void> {
    this.journal.update(commandId, (current) => ({
      ...current,
      observationEvidence: [...current.observationEvidence, evidence],
    }));
  }
}

export class V2CommandObservationEvidenceAdapter implements ControlLayerEvidenceAdapter {
  constructor(
    private readonly sink?: CommandObservationEvidenceSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  toCommandObservationEvidence(evidence: ActionEvidence): CommandObservationEvidence {
    const observationId = `control-layer:${evidence.sequenceId}:${evidence.timestamp}`;
    const coherence: ObservationCoherence = evidence.stateAfter === "VERIFYING" ? "UNKNOWN" : "STABLE_FRAME";
    return {
      phase: "RECONCILIATION",
      observationId,
      coherence,
      recordedAt: this.now().toISOString(),
      summary: `${evidence.stateBefore}->${evidence.stateAfter}:${String(evidence.observed)}`,
      details: {
        schemaVersion: "ai-mayor-v2-control-layer-evidence/1",
        actionId: evidence.actionId,
        skillId: evidence.skillId,
        sequenceId: evidence.sequenceId,
        expected: evidence.expected,
        observed: evidence.observed,
        finalStatus: evidence.finalStatus,
        actuatorCommandIds: evidence.actuatorCommandIds,
        recoveryAttempts: evidence.recoveryAttempts,
        error: evidence.error,
      },
    };
  }

  async record(evidence: ActionEvidence): Promise<void> {
    if (!this.sink) return;
    const mapped = this.toCommandObservationEvidence(evidence);
    await Promise.all(evidence.actuatorCommandIds.map((commandId) => this.sink?.append(commandId, mapped)));
  }
}
