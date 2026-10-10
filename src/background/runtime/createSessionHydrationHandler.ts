import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingSession } from '../recording/session/RecordingSession';
import type { BackgroundReadiness } from './BackgroundReadiness';

/** Restores transcript capture and releases buffered ingress after durable session hydration. */
export function createSessionHydrationHandler(deps: {
  session: RecordingSession;
  transcriptCapture: RecordingTranscriptCapture;
  offscreen: OffscreenManager;
  readiness: BackgroundReadiness;
  markHydrated: () => void;
}): () => void {
  return () => {
    deps.markHydrated();
    const snapshot = deps.session.getSnapshot();
    if (snapshot.phase !== 'idle') {
      const finalization = snapshot.finalization;
      const targetTabId = finalization?.targetTabId ?? snapshot.targetTabId;
      const epoch = finalization?.epoch ?? snapshot.epoch;
      if (targetTabId != null && epoch != null) {
        void deps.transcriptCapture.restore(
          targetTabId,
          epoch,
          finalization?.disposition ?? 'kept',
        );
      }
    }
    deps.offscreen.releaseBufferedIngress();
    deps.readiness.markReady();
  };
}
