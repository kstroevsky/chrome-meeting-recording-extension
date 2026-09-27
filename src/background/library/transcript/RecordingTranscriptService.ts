/**
 * @file background/library/transcript/RecordingTranscriptService.ts
 *
 * Owns every transcript transition. Decode is tolerant (see
 * `shared/transcript.ts`), but this layer is strict: it rejects a source change
 * or an over-long transcript rather than silently degrading, so a caller learns
 * its write did not land.
 *
 * Appends arrive one utterance at a time from a live call over a
 * fire-and-forget channel, which is at-least-once: the same utterance can
 * legitimately arrive twice after a reconnect. Identical segments are therefore
 * dropped on append rather than duplicated.
 */

import {
  MAX_TRANSCRIPT_SEGMENTS,
  sortTranscriptSegments,
  validateTranscriptForWrite,
  validateTranscriptSegmentForWrite,
  type Transcript,
  type TranscriptSegment,
  type TranscriptSource,
} from '../../../shared/transcript';
import type { TranscriptStatus } from '../../../shared/playback';
import { hashTranscript, type TranscriptSnapshot } from '../../../shared/transcriptIdentity';
import type { RecordingTranscriptRepositoryPort } from './RecordingTranscriptRepository';

type TranscriptCommitListener = (recordingId: string, snapshot: TranscriptSnapshot) => void | Promise<void>;

/** Owns every transcript transition for a recording, keyed by its history id. */
export class RecordingTranscriptService {
  private onCommitted?: TranscriptCommitListener;

  constructor(
    private readonly repository: RecordingTranscriptRepositoryPort,
    onCommitted?: TranscriptCommitListener,
    /** Any change to the stored transcript; integrations re-read the recording. */
    private readonly onChanged?: (recordingId: string) => void,
  ) {
    this.onCommitted = onCommitted;
  }

  setCommitListener(listener: TranscriptCommitListener): void {
    this.onCommitted = listener;
  }

  async get(recordingId: string): Promise<Transcript | undefined> {
    return (await this.getSnapshot(recordingId))?.transcript;
  }

  async getSnapshot(recordingId: string): Promise<TranscriptSnapshot | undefined> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return undefined;
    if (stored.contentHash) return stored;
    const contentHash = await hashTranscript(stored.transcript);
    await this.repository.cacheContentHash(recordingId, stored.generation, stored.revision, contentHash).catch(() => {});
    return { ...stored, contentHash };
  }

  /**
   * What the player's rail should do with this recording.
   *
   * `'processing'` is deliberately unreachable from here: caption transcripts
   * are complete the moment the call ends, and nothing else produces one yet.
   * The state exists for the stages that will — audio STT
   * (`docs/plans/portable-transcription.md` §B2) and topic analysis — so the
   * player branches on data rather than on a feature flag.
   */
  async status(recordingId: string): Promise<TranscriptStatus> {
    return await this.repository.get(recordingId) ? 'ready' : 'none';
  }

  /**
   * Appends utterances to a recording's transcript, creating it on first write.
   *
   * Returns the number of segments actually stored, which is fewer than were
   * offered when a redelivery is dropped.
   */
  async append(
    recordingId: string,
    source: TranscriptSource,
    segments: TranscriptSegment[],
  ): Promise<number> {
    if (!segments.length) return 0;
    const validatedSegments = segments.map(validateTranscriptSegmentForWrite);

    let added = 0;
    await this.repository.update(recordingId, (current) => {
      if (current && current.source !== source) {
        // Only one source can own a recording's transcript today. Choosing
        // between two is Plan B's source-selection policy, which lands with the
        // second source; guessing here would bake in a policy nobody approved.
        throw new Error(
          `A ${current.source} transcript already exists for this recording; refusing to append ${source}`,
        );
      }

      const existing = current?.segments ?? [];
      const seen = new Set(existing.map(segmentKey));
      const fresh = validatedSegments.filter((segment) => {
        const key = segmentKey(segment);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!fresh.length) return current;

      if (existing.length + fresh.length > MAX_TRANSCRIPT_SEGMENTS) {
        throw new Error(`A transcript cannot hold more than ${MAX_TRANSCRIPT_SEGMENTS} segments`);
      }

      added = fresh.length;
      return { source, segments: sortTranscriptSegments([...existing, ...fresh]) };
    });
    if (added > 0) this.onChanged?.(recordingId);
    return added;
  }

  /** Replaces the canonical transcript and announces the committed revision. */
  async replace(recordingId: string, transcript: Transcript): Promise<TranscriptSnapshot> {
    const validated = validateTranscriptForWrite(transcript);
    const stored = await this.repository.update(recordingId, () => validated);
    if (!stored) throw new Error('Transcript replacement did not persist');
    const snapshot = await this.requireHash(recordingId, stored);
    this.onChanged?.(recordingId);
    await this.onCommitted?.(recordingId, snapshot);
    return snapshot;
  }

  /** Announces that the current transcript is complete enough for derived work. */
  async commit(recordingId: string): Promise<TranscriptSnapshot | undefined> {
    const snapshot = await this.getSnapshot(recordingId);
    if (snapshot) await this.onCommitted?.(recordingId, snapshot);
    return snapshot;
  }

  async listRecordingIds(limit: number, after?: string): Promise<{
    recordingIds: string[];
    nextCursor?: string;
  }> {
    return await this.repository.listRecordingIds(limit, after);
  }

  /** Drops a recording's transcript — a discarded run, or a deleted entry. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.remove(recordingId);
  }

  private async requireHash(recordingId: string, stored: TranscriptSnapshot): Promise<TranscriptSnapshot> {
    if (stored.contentHash) return stored;
    const contentHash = await hashTranscript(stored.transcript);
    await this.repository.cacheContentHash(recordingId, stored.generation, stored.revision, contentHash).catch(() => {});
    return { ...stored, contentHash };
  }
}

/**
 * Identity of an utterance for redelivery detection. Two utterances that share
 * a start, an end, a speaker and their words are the same utterance; a genuine
 * repeat of the same words is separated by the caption grace window, so it
 * cannot collide.
 */
function segmentKey(segment: TranscriptSegment): string {
  return `${segment.tStartMs}:${segment.tEndMs}:${segment.speaker ?? ''}:${segment.text}`;
}
