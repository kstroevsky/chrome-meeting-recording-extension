/**
 * @file background/library/analysis/RecordingAnalysisRepository.ts
 *
 * IndexedDB adapter for topic analyses, keyed by the recording's history id —
 * the same shape as notations (ADR-0005) and transcripts (ADR-0007).
 *
 * Simpler than either, because an analysis is written **whole or not at all**.
 * Notations and transcripts accumulate while a run is live, so both need a
 * read-modify-write seam to stop concurrent appends losing each other. An
 * analysis is the output of one job over a finished transcript: there is
 * nothing to merge, and a partial one is worthless.
 */

import { normalizeStoredAnalysis, toDurableRow, type StoredAnalysis } from '../../../shared/analysis/storedAnalysis';
import { ANALYSES_STORE as STORE_NAME, openRecordingHistoryDatabase } from '../RecordingLibraryDatabase';

export interface RecordingAnalysisRepositoryPort {
  get(recordingId: string): Promise<StoredAnalysis | undefined>;
  put(recordingId: string, analysis: StoredAnalysis): Promise<void>;
  remove(recordingId: string): Promise<void>;
}

export class RecordingAnalysisRepository implements RecordingAnalysisRepositoryPort {
  constructor(private readonly factory?: IDBFactory) {}

  async get(recordingId: string): Promise<StoredAnalysis | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(recordingId);
      request.onsuccess = () => resolve(normalizeStoredAnalysis(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read recording analysis'));
    });
  }

  /**
   * Replaces any previous analysis for this recording.
   *
   * Normalized on the way in as well as out: what a job hands over is durable
   * data, so it goes through the same decode as anything read from disk, and a
   * result that cannot survive that round trip is rejected before it is stored
   * rather than discovered unreadable later.
   */
  async put(recordingId: string, analysis: StoredAnalysis): Promise<void> {
    const checked = normalizeStoredAnalysis(analysis);
    if (!checked) throw new Error('Refusing to store an analysis that does not decode');

    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ recordingId, ...toDurableRow(checked) });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not write recording analysis'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording analysis write aborted'));
    });
  }

  async remove(recordingId: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(recordingId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete recording analysis'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording analysis delete aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}
