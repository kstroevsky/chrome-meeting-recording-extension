/**
 * @file background/RecordingTranscriptRepository.ts
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

import { normalizeTranscript, type Transcript } from '../shared/transcript';
import { TRANSCRIPTS_STORE as STORE_NAME, openRecordingHistoryDatabase } from './recordingHistoryDatabase';

export type RecordingTranscriptMutation = (current: Transcript | undefined) => Transcript | undefined;

export interface RecordingTranscriptRepositoryPort {
  get(recordingId: string): Promise<Transcript | undefined>;
  update(recordingId: string, mutate: RecordingTranscriptMutation): Promise<Transcript | undefined>;
  remove(recordingId: string): Promise<void>;
}

type StoredTranscript = Transcript & { recordingId: string; updatedAt: number };

export class RecordingTranscriptRepository implements RecordingTranscriptRepositoryPort {
  constructor(
    private readonly factory?: IDBFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(recordingId: string): Promise<Transcript | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(recordingId);
      request.onsuccess = () => resolve(readStored(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read recording transcript'));
    });
  }

  /**
   * Read-modify-write in a single `readwrite` transaction. A throwing mutator
   * aborts the transaction and rejects rather than committing a partial write.
   */
  async update(recordingId: string, mutate: RecordingTranscriptMutation): Promise<Transcript | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(recordingId);
      let result: Transcript | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not read recording transcript'));
      request.onsuccess = () => {
        try {
          // Normalize on the way back out too: the mutator's result is durable
          // data, so it goes through the same decode as anything read from disk.
          const next = normalizeTranscript(mutate(readStored(request.result)));
          result = next;
          if (next && next.segments.length) {
            store.put({ recordingId, ...next, updatedAt: this.now() } satisfies StoredTranscript);
          } else {
            // A transcript with no words is a deletion, not an empty row to read.
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
        resolve(result && result.segments.length ? result : undefined);
      };
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not write recording transcript'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Recording transcript write aborted'));
    });
  }

  async remove(recordingId: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(recordingId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete recording transcript'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording transcript delete aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}

function readStored(value: unknown): Transcript | undefined {
  const transcript = normalizeTranscript(value);
  return transcript && transcript.segments.length ? transcript : undefined;
}
