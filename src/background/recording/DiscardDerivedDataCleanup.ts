import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';
import type { RecordingSession } from './session/RecordingSession';

/** Fences live transcript ingress, then removes derived data after discard acceptance. */
export class DiscardDerivedDataCleanup {
  constructor(private readonly deps: {
    L: { warn: (...a: any[]) => void };
    session: RecordingSession;
    notations?: RecordingNotationService;
    transcripts?: RecordingTranscriptService;
    transcriptCapture?: RecordingTranscriptCapture;
  }) {}

  async fence(epoch: number | undefined): Promise<void> {
    await this.deps.transcriptCapture?.abandon(epoch)
      .catch((error) => this.deps.L.warn(
        'Could not disarm transcript capture for the discarded run:',
        error,
      ));
  }

  async cleanup(historyId: string): Promise<boolean> {
    let complete = true;
    await this.deps.notations?.removeAll(historyId)
      .catch((error) => {
        complete = false;
        this.deps.L.warn('Discarding recording notations failed:', error);
      });
    await this.deps.transcripts?.removeAll(historyId)
      .catch((error) => {
        complete = false;
        this.deps.L.warn('Discarding recording transcript failed:', error);
      });

    if (complete) {
      this.deps.session.markBackgroundFinalized(historyId);
      await this.deps.session.flush();
    }
    return complete;
  }
}
