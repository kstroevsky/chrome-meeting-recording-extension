/**
 * @file background/RecordingNotationRepository.ts
 *
 * IndexedDB adapter for notations. Its update operation is the notation
 * module's atomic seam, mirroring `RecordingHistoryRepository.update`.
 *
 * Notations are their own aggregate keyed by the recording's history id rather
 * than a field on `RecordingHistoryEntry`, because a mark is made *during*
 * capture while the history row is not created until finalize (ADR-0005).
 */

import { normalizeRecordingNotations, type RecordingNotation } from '../shared/notations';
import { NOTATIONS_STORE as STORE_NAME, openRecordingHistoryDatabase } from './recordingHistoryDatabase';

export type RecordingNotationsMutation = (current: RecordingNotation[]) => RecordingNotation[];

export interface RecordingNotationRepositoryPort {
  list(recordingId: string): Promise<RecordingNotation[]>;
  update(recordingId: string, mutate: RecordingNotationsMutation): Promise<RecordingNotation[]>;
  remove(recordingId: string): Promise<void>;
}

type StoredNotations = { recordingId: string; notations: RecordingNotation[]; updatedAt: number };

export class RecordingNotationRepository implements RecordingNotationRepositoryPort {
  constructor(
    private readonly factory?: IDBFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(recordingId: string): Promise<RecordingNotation[]> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(recordingId);
      request.onsuccess = () => resolve(readStored(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read recording notations'));
    });
  }

  /**
   * Read-modify-write in a single `readwrite` transaction, so concurrent marks
   * cannot lose each other. A throwing mutator aborts the transaction and
   * rejects rather than committing a partial list.
   */
  async update(recordingId: string, mutate: RecordingNotationsMutation): Promise<RecordingNotation[]> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(recordingId);
      let result: RecordingNotation[] = [];
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not read recording notations'));
      request.onsuccess = () => {
        try {
          // Normalize on the way back out too: the mutator's result is durable
          // data, so it goes through the same decode as anything read from disk.
          const next = normalizeRecordingNotations(mutate(readStored(request.result)));
          result = next;
          if (next.length) {
            store.put({ recordingId, notations: next, updatedAt: this.now() } satisfies StoredNotations);
          } else {
            // An emptied list is a deletion, not an empty row to page over.
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
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not write recording notations'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Recording notation write aborted'));
    });
  }

  async remove(recordingId: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(recordingId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete recording notations'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording notation delete aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}

function readStored(value: unknown): RecordingNotation[] {
  if (!value || typeof value !== 'object') return [];
  return normalizeRecordingNotations((value as Partial<StoredNotations>).notations);
}
