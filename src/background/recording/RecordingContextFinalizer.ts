import type { RecordingContextService } from '../library/context/RecordingContextService';
import type { RecordingSession } from './session/RecordingSession';

export async function finishRecordingContext(
  recordingContexts: Pick<RecordingContextService, 'finish'> | undefined,
  historyId: string | undefined,
  snapshot: ReturnType<RecordingSession['getSnapshot']>,
  warn: (...args: any[]) => void,
): Promise<void> {
  if (!historyId) return;
  const endedAt = [...(snapshot.recordedSpans ?? [])]
    .reverse()
    .find((span) => span.wallEndMs != null)?.wallEndMs ?? snapshot.updatedAt;
  await recordingContexts?.finish(historyId, endedAt)
    .catch((error) => warn('Could not finish recording context:', error));
}
