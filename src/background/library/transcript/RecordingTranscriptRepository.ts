/**
 * @file background/library/transcript/RecordingTranscriptRepository.ts
 *
 * IndexedDB adapter for transcripts. Its update operation is the transcript
 * module's atomic seam, mirroring `RecordingNotationRepository.update`.
 *
 * A transcript is its own aggregate keyed by the recording's history id rather
 * than a field on `RecordingHistoryEntry`, for the same reason notations are
 * (ADR-0005, ADR-0007 Decision 2): captions are committed while the call is
 * still running, and the history row is not created until finalize.
 *
 * Appends arrive one utterance at a time from a live call, so read-modify-write
 * inside a single `readwrite` transaction is what stops two commits landing in
 * the same tick from losing each other.
 */

import { normalizeTranscript, type Transcript } from '../../../shared/transcript';
import type { AnalysisEnvironmentProvenance } from '../../../shared/analysis/provenance';
import {
  TRANSCRIPT_CANONICALIZATION_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptSnapshot,
} from '../../../shared/transcriptIdentity';
import {
  ANALYSIS_WORK_STORE,
  TRANSCRIPTS_STORE as STORE_NAME,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';
import {
  cacheTranscriptContentHash,
  replaceTranscriptAndRequestAnalysis,
  requestCurrentTranscriptAnalysis,
} from './RecordingTranscriptAnalysisRequests';
import {
  createTranscriptGeneration,
  readStoredTranscript,
  sameTranscript,
  toDurableTranscript,
} from './RecordingTranscriptCodec';

export type RecordingTranscriptMutation = (current: Transcript | undefined) => Transcript | undefined;

export interface RecordingTranscriptRepositoryPort {
  get(recordingId: string): Promise<TranscriptSnapshot | undefined>;
  update(recordingId: string, mutate: RecordingTranscriptMutation): Promise<TranscriptSnapshot | undefined>;
  replaceAndRequestAnalysis(
    recordingId: string,
    transcript: Transcript,
    contentHash: string,
    environment: AnalysisEnvironmentProvenance,
  ): Promise<TranscriptSnapshot>;
  requestCurrentAnalysis(
    recordingId: string,
    environment: AnalysisEnvironmentProvenance,
    options?: { force?: boolean },
  ): Promise<TranscriptSnapshot | undefined>;
  cacheContentHash(recordingId: string, generation: string, revision: number, contentHash: string): Promise<void>;
  listRecordingIds(limit: number, after?: string): Promise<{
    recordingIds: string[];
    nextCursor?: string;
  }>;
  remove(recordingId: string): Promise<void>;
}

export class RecordingTranscriptRepository implements RecordingTranscriptRepositoryPort {
  constructor(
    private readonly factory?: IDBFactory,
    private readonly now: () => number = () => Date.now(),
    private readonly makeGeneration: () => string = createTranscriptGeneration,
  ) {}

  async get(recordingId: string): Promise<TranscriptSnapshot | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(recordingId);
      request.onsuccess = () => resolve(readStoredTranscript(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read recording transcript'));
    });
  }

  /**
   * Read-modify-write in a single `readwrite` transaction. A throwing mutator
   * aborts the transaction and rejects rather than committing a partial write.
   */
  async update(recordingId: string, mutate: RecordingTranscriptMutation): Promise<TranscriptSnapshot | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(recordingId);
      let result: TranscriptSnapshot | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not read recording transcript'));
      request.onsuccess = () => {
        try {
          const current = readStoredTranscript(request.result);
          const next = normalizeTranscript(mutate(current?.transcript));
          if (next && next.segments.length) {
            if (current && sameTranscript(current.transcript, next)) {
              result = current;
              return;
            }
            const committedAt = this.now();
            result = {
              schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
              canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
              generation: this.makeGeneration(),
              revision: (current?.revision ?? 0) + 1,
              contentHash: '',
              committedAt,
              transcript: next,
            };
            store.put(toDurableTranscript(recordingId, result));
          } else {
            // A transcript with no words is a deletion, not an empty row to read.
            result = undefined;
            store.delete(recordingId);
          }
        } catch (error) {
          try { transaction.abort(); } catch {}
          fail(error);
        }
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not write recording transcript'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Recording transcript write aborted'));
    });
  }

  /**
   * Replaces the canonical transcript and requests analysis in one transaction.
   *
   * Computing the hash happens before this boundary. Once the transaction
   * commits, the exact transcript identity and its desired analysis request are
   * durable together.
   */
  async replaceAndRequestAnalysis(
    recordingId: string,
    transcript: Transcript,
    contentHash: string,
    environment: AnalysisEnvironmentProvenance,
  ): Promise<TranscriptSnapshot> {
    return await replaceTranscriptAndRequestAnalysis(
      this.factory,
      this.now,
      this.makeGeneration,
      recordingId,
      transcript,
      contentHash,
      environment,
    );
  }

  /** Requests analysis for the exact transcript row observed by this transaction. */
  async requestCurrentAnalysis(
    recordingId: string,
    environment: AnalysisEnvironmentProvenance,
    options: { force?: boolean } = {},
  ): Promise<TranscriptSnapshot | undefined> {
    return await requestCurrentTranscriptAnalysis(
      this.factory,
      this.now,
      recordingId,
      environment,
      options,
    );
  }

  /** Caches a derived hash only if the exact transcript mutation is still current. */
  async cacheContentHash(
    recordingId: string,
    generation: string,
    revision: number,
    contentHash: string,
  ): Promise<void> {
    await cacheTranscriptContentHash(
      this.factory,
      this.now,
      recordingId,
      generation,
      revision,
      contentHash,
    );
  }

  async listRecordingIds(limit: number, after?: string): Promise<{
    recordingIds: string[];
    nextCursor?: string;
  }> {
    if (limit <= 0) return { recordingIds: [] };
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const ids: string[] = [];
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const range = after ? IDBKeyRange.lowerBound(after, true) : undefined;
      const request = transaction.objectStore(STORE_NAME).openKeyCursor(range);
      request.onerror = () => reject(request.error ?? new Error('Could not list recording transcripts'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ recordingIds: ids });
          return;
        }
        if (ids.length >= limit) {
          resolve({ recordingIds: ids, nextCursor: ids[ids.length - 1] });
          return;
        }
        if (typeof cursor.primaryKey === 'string') ids.push(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  async remove(recordingId: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ANALYSIS_WORK_STORE], 'readwrite');
      transaction.objectStore(STORE_NAME).delete(recordingId);
      transaction.objectStore(ANALYSIS_WORK_STORE).delete(recordingId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete recording transcript'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording transcript delete aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}
