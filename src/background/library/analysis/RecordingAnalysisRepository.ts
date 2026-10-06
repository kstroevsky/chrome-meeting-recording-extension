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
import type { AnalysisJob } from '../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import {
  ANALYSES_STORE as STORE_NAME,
  ANALYSIS_OUTCOMES_STORE as OUTCOMES_STORE,
  ANALYSIS_WORK_STORE,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';
import {
  isOutcomeAtLeastAsRecent,
  normalizeRecordingAnalysisOutcome,
  type RecordingAnalysisOutcome,
} from './RecordingAnalysisOutcome';
import {
  normalizeRecordingAnalysisWork,
  type RecordingAnalysisWork,
} from './RecordingAnalysisWork';
import {
  cancelDesiredAnalysis,
  publishAttemptResult as publishFencedAttemptResult,
  putAttemptOutcome as putFencedAttemptOutcome,
  putCompletedAnalysis,
  type AnalysisAttemptTransition,
} from './RecordingAnalysisTransactions';

export type { AnalysisAttemptTransition } from './RecordingAnalysisTransactions';

export type RecordingAnalysisSnapshot = {
  analysis?: StoredAnalysis;
  outcome?: RecordingAnalysisOutcome;
  work?: RecordingAnalysisWork;
};

export interface RecordingAnalysisRepositoryPort {
  get(recordingId: string): Promise<StoredAnalysis | undefined>;
  getOutcome(recordingId: string): Promise<RecordingAnalysisOutcome | undefined>;
  getSnapshot(recordingId: string): Promise<RecordingAnalysisSnapshot>;
  put(recordingId: string, analysis: StoredAnalysis): Promise<void>;
  putOutcome(recordingId: string, outcome: RecordingAnalysisOutcome): Promise<void>;
  putCompleted(
    recordingId: string,
    analysis: StoredAnalysis,
    outcome: RecordingAnalysisOutcome,
  ): Promise<boolean>;
  putAttemptOutcome(
    recordingId: string,
    job: AnalysisJob,
    outcome: RecordingAnalysisOutcome,
    transition?: AnalysisAttemptTransition,
  ): Promise<boolean>;
  publishAttemptResult(
    recordingId: string,
    job: AnalysisJob,
    analysis: StoredAnalysis,
    outcome: RecordingAnalysisOutcome,
    provenance: AnalysisProvenance,
  ): Promise<boolean>;
  cancelDesired(recordingId: string, now: number): Promise<{ changed: boolean; attemptToken?: string }>;
  remove(recordingId: string): Promise<void>;
  removeAll(recordingId: string): Promise<void>;
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

  async getOutcome(recordingId: string): Promise<RecordingAnalysisOutcome | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTCOMES_STORE, 'readonly');
      const request = transaction.objectStore(OUTCOMES_STORE).get(recordingId);
      request.onsuccess = () => resolve(normalizeRecordingAnalysisOutcome(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read recording analysis outcome'));
    });
  }

  async getSnapshot(recordingId: string): Promise<RecordingAnalysisSnapshot> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, OUTCOMES_STORE, ANALYSIS_WORK_STORE], 'readonly');
      const analysisRequest = transaction.objectStore(STORE_NAME).get(recordingId);
      const outcomeRequest = transaction.objectStore(OUTCOMES_STORE).get(recordingId);
      const workRequest = transaction.objectStore(ANALYSIS_WORK_STORE).get(recordingId);
      transaction.oncomplete = () => resolve({
        analysis: normalizeStoredAnalysis(analysisRequest.result),
        outcome: normalizeRecordingAnalysisOutcome(outcomeRequest.result),
        work: normalizeRecordingAnalysisWork(workRequest.result),
      });
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not read recording analysis state'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording analysis state read aborted'));
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

  async putOutcome(recordingId: string, outcome: RecordingAnalysisOutcome): Promise<void> {
    const checked = normalizeRecordingAnalysisOutcome(outcome);
    if (!checked) throw new Error('Refusing to store an analysis outcome that does not decode');

    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTCOMES_STORE, 'readwrite');
      const store = transaction.objectStore(OUTCOMES_STORE);
      const request = store.get(recordingId);
      request.onsuccess = () => {
        const current = normalizeRecordingAnalysisOutcome(request.result);
        if (!current || isOutcomeAtLeastAsRecent(checked, current)) {
          store.put({ recordingId, ...checked });
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not write recording analysis outcome'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording analysis outcome write aborted'));
    });
  }

  /** Atomically publishes the completed graph and the outcome that says it is available. */
  async putCompleted(
    recordingId: string,
    analysis: StoredAnalysis,
    outcome: RecordingAnalysisOutcome,
  ): Promise<boolean> {
    return await putCompletedAnalysis(this.factory, recordingId, analysis, outcome);
  }

  /**
   * Persists attempt state only while the durable request still belongs to this
   * exact epoch/token. A replay from an older attempt cannot overwrite a newer
   * request's outcome or retire its work.
   */
  async putAttemptOutcome(
    recordingId: string,
    job: AnalysisJob,
    outcome: RecordingAnalysisOutcome,
    transition?: AnalysisAttemptTransition,
  ): Promise<boolean> {
    return await putFencedAttemptOutcome(this.factory, recordingId, job, outcome, transition);
  }

  /**
   * Conditionally publishes a completed result and satisfies its desired work
   * in one library transaction.
   */
  async publishAttemptResult(
    recordingId: string,
    job: AnalysisJob,
    analysis: StoredAnalysis,
    outcome: RecordingAnalysisOutcome,
    provenance: AnalysisProvenance,
  ): Promise<boolean> {
    return await publishFencedAttemptResult(this.factory, recordingId, job, analysis, outcome, provenance);
  }

  /** Durably cancels pending or claimed work before best-effort worker cancel. */
  async cancelDesired(
    recordingId: string,
    now: number,
  ): Promise<{ changed: boolean; attemptToken?: string }> {
    return await cancelDesiredAnalysis(this.factory, recordingId, now);
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

  async removeAll(recordingId: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, OUTCOMES_STORE, ANALYSIS_WORK_STORE], 'readwrite');
      transaction.objectStore(STORE_NAME).delete(recordingId);
      transaction.objectStore(OUTCOMES_STORE).delete(recordingId);
      transaction.objectStore(ANALYSIS_WORK_STORE).delete(recordingId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete recording analysis state'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording analysis state delete aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}
