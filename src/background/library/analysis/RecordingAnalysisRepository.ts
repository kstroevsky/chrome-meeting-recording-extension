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
import { normalizeRecordingHistoryEntry } from '../../../shared/recordingHistory';
import {
  ANALYSES_STORE as STORE_NAME,
  ANALYSIS_OUTCOMES_STORE as OUTCOMES_STORE,
  ANALYSIS_WORK_STORE,
  RECORDINGS_STORE,
  TRANSCRIPTS_STORE,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';
import {
  isOutcomeAtLeastAsRecent,
  normalizeRecordingAnalysisOutcome,
  type RecordingAnalysisOutcome,
} from './RecordingAnalysisOutcome';
import {
  normalizeRecordingAnalysisWork,
  requiredAnalysisEnvironment,
  sameRequiredAnalysisEnvironment,
  type RecordingAnalysisWork,
} from './RecordingAnalysisWork';

export type RecordingAnalysisSnapshot = {
  analysis?: StoredAnalysis;
  outcome?: RecordingAnalysisOutcome;
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

export type AnalysisAttemptTransition =
  | { disposition: 'retry-wait'; nextAttemptAt: number; error?: string }
  | { disposition: 'canceled' | 'unsupported'; error?: string };

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
      const transaction = database.transaction([STORE_NAME, OUTCOMES_STORE], 'readonly');
      const analysisRequest = transaction.objectStore(STORE_NAME).get(recordingId);
      const outcomeRequest = transaction.objectStore(OUTCOMES_STORE).get(recordingId);
      transaction.oncomplete = () => resolve({
        analysis: normalizeStoredAnalysis(analysisRequest.result),
        outcome: normalizeRecordingAnalysisOutcome(outcomeRequest.result),
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
    const checkedAnalysis = normalizeStoredAnalysis(analysis);
    if (!checkedAnalysis) throw new Error('Refusing to store an analysis that does not decode');
    const checkedOutcome = normalizeRecordingAnalysisOutcome(outcome);
    if (!checkedOutcome || checkedOutcome.status !== 'completed') {
      throw new Error('Refusing to store a completed analysis without a completed outcome');
    }

    const database = await this.open();
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, OUTCOMES_STORE], 'readwrite');
      const outcomes = transaction.objectStore(OUTCOMES_STORE);
      const request = outcomes.get(recordingId);
      let committed = false;
      request.onsuccess = () => {
        const current = normalizeRecordingAnalysisOutcome(request.result);
        if (current && !isOutcomeAtLeastAsRecent(checkedOutcome, current)) return;
        transaction.objectStore(STORE_NAME).put({ recordingId, ...toDurableRow(checkedAnalysis) });
        outcomes.put({ recordingId, ...checkedOutcome });
        committed = true;
      };
      transaction.oncomplete = () => resolve(committed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not publish completed recording analysis'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Completed recording analysis write aborted'));
    });
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
    const checkedOutcome = normalizeRecordingAnalysisOutcome(outcome);
    if (!checkedOutcome) throw new Error('Refusing to store an analysis outcome that does not decode');
    if (!job.requestEpoch) return false;

    const database = await this.open();
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction([OUTCOMES_STORE, ANALYSIS_WORK_STORE], 'readwrite');
      const outcomes = transaction.objectStore(OUTCOMES_STORE);
      const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
      const workRequest = workStore.get(recordingId);
      let committed = false;
      workRequest.onerror = () => reject(workRequest.error ?? new Error('Could not read desired analysis work'));
      workRequest.onsuccess = () => {
        const work = normalizeRecordingAnalysisWork(workRequest.result);
        if (!matchesAttempt(work, job)) return;

        const currentOutcomeRequest = outcomes.get(recordingId);
        currentOutcomeRequest.onerror = () => reject(
          currentOutcomeRequest.error ?? new Error('Could not read recording analysis outcome'),
        );
        currentOutcomeRequest.onsuccess = () => {
          const currentOutcome = normalizeRecordingAnalysisOutcome(currentOutcomeRequest.result);
          if (!currentOutcome || isOutcomeAtLeastAsRecent(checkedOutcome, currentOutcome)) {
            outcomes.put({ recordingId, ...checkedOutcome });
          }
          if (transition) workStore.put(applyAttemptTransition(work, transition, checkedOutcome.updatedAt));
          committed = true;
        };
      };
      transaction.oncomplete = () => resolve(committed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not persist analysis attempt state'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Analysis attempt state write aborted'));
    });
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
    const checkedAnalysis = normalizeStoredAnalysis(analysis);
    if (!checkedAnalysis) throw new Error('Refusing to store an analysis that does not decode');
    const checkedOutcome = normalizeRecordingAnalysisOutcome(outcome);
    if (!checkedOutcome || checkedOutcome.status !== 'completed') {
      throw new Error('Refusing to publish an analysis without a completed outcome');
    }
    if (!job.requestEpoch) return false;

    const database = await this.open();
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(
        [RECORDINGS_STORE, TRANSCRIPTS_STORE, ANALYSIS_WORK_STORE, STORE_NAME, OUTCOMES_STORE],
        'readwrite',
      );
      const historyRequest = transaction.objectStore(RECORDINGS_STORE).get(recordingId);
      const transcriptRequest = transaction.objectStore(TRANSCRIPTS_STORE).get(recordingId);
      const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
      const workRequest = workStore.get(recordingId);
      let readsRemaining = 3;
      let committed = false;
      let decided = false;

      const failRead = (request: IDBRequest, message: string) => {
        request.onerror = () => reject(request.error ?? new Error(message));
      };
      const maybePublish = () => {
        readsRemaining -= 1;
        if (readsRemaining !== 0 || decided) return;
        decided = true;

        const history = normalizeRecordingHistoryEntry(historyRequest.result);
        if (history?.deletedAt != null) return;
        const work = normalizeRecordingAnalysisWork(workRequest.result);
        if (!matchesAttempt(work, job)) return;
        if (!matchesTranscriptRow(transcriptRequest.result, provenance)) return;
        if (work.transcriptGeneration !== provenance.transcriptGeneration
          || work.transcriptRevision !== provenance.transcriptRevision
          || work.transcriptHash !== provenance.transcriptHash
          || !sameRequiredAnalysisEnvironment(work.environment, requiredAnalysisEnvironment(provenance))) return;

        try {
          transaction.objectStore(STORE_NAME).put({ recordingId, ...toDurableRow(checkedAnalysis) });
          transaction.objectStore(OUTCOMES_STORE).put({ recordingId, ...checkedOutcome });
          const satisfied: RecordingAnalysisWork = {
            ...work,
            disposition: 'satisfied',
            updatedAt: checkedOutcome.updatedAt,
          };
          delete satisfied.claim;
          delete satisfied.nextAttemptAt;
          delete satisfied.error;
          workStore.put(satisfied);
          committed = true;
        } catch (error) {
          committed = false;
          try { transaction.abort(); } catch {}
          reject(error);
        }
      };

      failRead(historyRequest, 'Could not read recording deletion fence');
      failRead(transcriptRequest, 'Could not read recording transcript identity');
      failRead(workRequest, 'Could not read desired analysis work');
      historyRequest.onsuccess = maybePublish;
      transcriptRequest.onsuccess = maybePublish;
      workRequest.onsuccess = maybePublish;
      transaction.oncomplete = () => resolve(committed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not publish fenced analysis result'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Fenced analysis publication aborted'));
    });
  }

  /** Durably cancels pending or claimed work before best-effort worker cancel. */
  async cancelDesired(
    recordingId: string,
    now: number,
  ): Promise<{ changed: boolean; attemptToken?: string }> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([ANALYSIS_WORK_STORE, OUTCOMES_STORE], 'readwrite');
      const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
      const outcomes = transaction.objectStore(OUTCOMES_STORE);
      const request = workStore.get(recordingId);
      let result: { changed: boolean; attemptToken?: string } = { changed: false };
      request.onerror = () => reject(request.error ?? new Error('Could not read desired analysis work'));
      request.onsuccess = () => {
        const current = normalizeRecordingAnalysisWork(request.result);
        if (!current
          || current.disposition === 'canceled'
          || current.disposition === 'unsupported'
          || current.disposition === 'satisfied') return;
        const attemptToken = current.claim?.attemptToken;
        const canceled: RecordingAnalysisWork = {
          ...current,
          disposition: 'canceled',
          updatedAt: now,
        };
        delete canceled.claim;
        delete canceled.nextAttemptAt;
        delete canceled.error;
        workStore.put(canceled);
        outcomes.put({
          recordingId,
          status: 'canceled',
          ...(attemptToken ? { jobId: attemptToken } : {}),
          startedAt: now,
          updatedAt: now,
        });
        result = { changed: true, ...(attemptToken ? { attemptToken } : {}) };
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not cancel desired analysis work'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Desired analysis cancellation aborted'));
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

function matchesAttempt(work: RecordingAnalysisWork | undefined, job: AnalysisJob): work is RecordingAnalysisWork {
  return Boolean(
    work
    && job.requestEpoch
    && work.requestEpoch === job.requestEpoch
    && work.disposition === 'claimed'
    && work.claim?.attemptToken === job.id,
  );
}

function applyAttemptTransition(
  work: RecordingAnalysisWork,
  transition: AnalysisAttemptTransition,
  updatedAt: number,
): RecordingAnalysisWork {
  const next: RecordingAnalysisWork = {
    ...work,
    disposition: transition.disposition,
    updatedAt,
  };
  delete next.claim;
  if (transition.disposition === 'retry-wait') next.nextAttemptAt = Math.max(0, transition.nextAttemptAt);
  else delete next.nextAttemptAt;
  if (transition.error?.trim()) next.error = transition.error.trim().slice(0, 2_048);
  else delete next.error;
  return next;
}

function matchesTranscriptRow(value: unknown, provenance: AnalysisProvenance): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.generation === provenance.transcriptGeneration
    && row.revision === provenance.transcriptRevision
    && row.contentHash === provenance.transcriptHash;
}
