/**
 * @file background/RecordingTranscriptService.ts
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
  type Transcript,
  type TranscriptSegment,
  type TranscriptSource,
} from '../shared/transcript';
import type { TranscriptStatus } from '../shared/playback';
import type { RecordingTranscriptRepositoryPort } from './RecordingTranscriptRepository';

/** Owns every transcript transition for a recording, keyed by its history id. */
export class RecordingTranscriptService {
  constructor(private readonly repository: RecordingTranscriptRepositoryPort) {}

  async get(recordingId: string): Promise<Transcript | undefined> {
    return await this.repository.get(recordingId);
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
    const transcript = await this.repository.get(recordingId);
    return transcript ? 'ready' : 'none';
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
      const fresh = segments.filter((segment) => {
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
    return added;
  }

  /** Drops a recording's transcript — a discarded run, or a deleted entry. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.remove(recordingId);
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
