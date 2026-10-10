import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import type { RecordingContextService } from '../library/context/RecordingContextService';
import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';
import type { RecordingSession } from './session/RecordingSession';
import type { RecordingRoutingPort } from './recordingRoutingPorts';

/** Fences live transcript ingress, then removes derived data after discard acceptance. */
export class DiscardDerivedDataCleanup {
  constructor(private readonly deps: {
    L: { warn: (...a: any[]) => void };
    session: RecordingSession;
    notations?: RecordingNotationService;
    recordingContexts?: Pick<RecordingContextService, 'remove'>;
    transcripts?: RecordingTranscriptService;
    transcriptCapture?: RecordingTranscriptCapture;
    routing?: Pick<RecordingRoutingPort, 'forget'>;
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
    await this.deps.recordingContexts?.remove(historyId)
      .catch((error) => {
        complete = false;
        this.deps.L.warn('Discarding recording context failed:', error);
      });
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
    // A discarded run never confirmed its save, so its routes were still held:
    // forgetting them means nothing about it ever leaves the browser.
    await this.deps.routing?.forget(historyId)
      .catch((error) => {
        complete = false;
        this.deps.L.warn('Discarding recording routing failed:', error);
      });

    if (complete) {
      this.deps.session.markBackgroundFinalized(historyId);
      await this.deps.session.flush();
    }
    return complete;
  }
}
