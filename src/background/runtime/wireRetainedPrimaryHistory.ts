import { recordingHistoryFileId } from '../../shared/recordingHistory';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingSession } from '../recording/session/RecordingSession';

/** Projects external-primary OPFS retention into canonical history before ACKing it. */
export function wireRetainedPrimaryHistory(deps: {
  offscreen: OffscreenManager;
  session: RecordingSession;
  history: RecordingHistoryService;
  warn: (...args: any[]) => void;
}): void {
  deps.offscreen.onRetainedPrimary = (retained) => {
    const durationMs = deps.session.runDurationMs(retained.historyId);
    void (async () => {
      const fileId = recordingHistoryFileId(retained.historyId, retained.stream);
      await deps.history.createPending(
        retained.historyId,
        [{
          id: fileId,
          stream: retained.stream,
          filename: retained.filename,
          bytes: retained.bytes,
          ...(retained.startOffsetMs != null ? { captureStartOffsetMs: retained.startOffsetMs } : {}),
        }],
        { kind: 'external', destinationId: retained.destinationId },
      );
      await deps.history.setDuration(retained.historyId, durationMs);
      await deps.history.recordArtifactLocation(retained.historyId, fileId, {
        kind: 'opfs',
        key: retained.retainedKey,
        retainedAt: retained.retainedAt,
      });
      deps.offscreen.acknowledgeRetainedPrimary(retained.historyId, retained.stream);
    })().catch((error) => deps.warn('External primary retention handoff deferred:', error));
  };
}
