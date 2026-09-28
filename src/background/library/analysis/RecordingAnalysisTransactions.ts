import type { AnalysisJob } from '../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import { normalizeStoredAnalysis, toDurableRow, type StoredAnalysis } from '../../../shared/analysis/storedAnalysis';
import { normalizeRecordingHistoryEntry } from '../../../shared/recordingHistory';
import {
  ANALYSES_STORE,
  ANALYSIS_OUTCOMES_STORE,
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
import {
  applyAnalysisAttemptTransition,
  matchesAnalysisAttempt,
  type AnalysisAttemptTransition,
} from './RecordingAnalysisWorkClaims';

export type { AnalysisAttemptTransition } from './RecordingAnalysisWorkClaims';

export async function putCompletedAnalysis(
  factory: IDBFactory | undefined,
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

  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction([ANALYSES_STORE, ANALYSIS_OUTCOMES_STORE], 'readwrite');
    const outcomes = transaction.objectStore(ANALYSIS_OUTCOMES_STORE);
    const request = outcomes.get(recordingId);
    let committed = false;
    request.onsuccess = () => {
      const current = normalizeRecordingAnalysisOutcome(request.result);
      if (current && !isOutcomeAtLeastAsRecent(checkedOutcome, current)) return;
      transaction.objectStore(ANALYSES_STORE).put({ recordingId, ...toDurableRow(checkedAnalysis) });
      outcomes.put({ recordingId, ...checkedOutcome });
      committed = true;
    };
    transaction.oncomplete = () => resolve(committed);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not publish completed recording analysis'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Completed recording analysis write aborted'));
  });
}

export async function putAttemptOutcome(
  factory: IDBFactory | undefined,
  recordingId: string,
  job: AnalysisJob,
  outcome: RecordingAnalysisOutcome,
  transition?: AnalysisAttemptTransition,
): Promise<boolean> {
  const checkedOutcome = normalizeRecordingAnalysisOutcome(outcome);
  if (!checkedOutcome) throw new Error('Refusing to store an analysis outcome that does not decode');
  if (!job.requestEpoch) return false;

  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction([ANALYSIS_OUTCOMES_STORE, ANALYSIS_WORK_STORE], 'readwrite');
    const outcomes = transaction.objectStore(ANALYSIS_OUTCOMES_STORE);
    const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
    const workRequest = workStore.get(recordingId);
    let committed = false;
    workRequest.onerror = () => reject(workRequest.error ?? new Error('Could not read desired analysis work'));
    workRequest.onsuccess = () => {
      const work = normalizeRecordingAnalysisWork(workRequest.result);
      if (!matchesAnalysisAttempt(work, job)) return;

      const currentOutcomeRequest = outcomes.get(recordingId);
      currentOutcomeRequest.onerror = () => reject(
        currentOutcomeRequest.error ?? new Error('Could not read recording analysis outcome'),
      );
      currentOutcomeRequest.onsuccess = () => {
        const currentOutcome = normalizeRecordingAnalysisOutcome(currentOutcomeRequest.result);
        if (!currentOutcome || isOutcomeAtLeastAsRecent(checkedOutcome, currentOutcome)) {
          outcomes.put({ recordingId, ...checkedOutcome });
        }
        if (transition) workStore.put(applyAnalysisAttemptTransition(work, transition, checkedOutcome.updatedAt));
        committed = true;
      };
    };
    transaction.oncomplete = () => resolve(committed);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not persist analysis attempt state'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Analysis attempt state write aborted'));
  });
}

export async function publishAttemptResult(
  factory: IDBFactory | undefined,
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

  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(
      [RECORDINGS_STORE, TRANSCRIPTS_STORE, ANALYSIS_WORK_STORE, ANALYSES_STORE, ANALYSIS_OUTCOMES_STORE],
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
      if (!matchesAnalysisAttempt(work, job)) return;
      if (!matchesTranscriptRow(transcriptRequest.result, provenance)) return;
      if (work.transcriptGeneration !== provenance.transcriptGeneration
        || work.transcriptRevision !== provenance.transcriptRevision
        || work.transcriptHash !== provenance.transcriptHash
        || !sameRequiredAnalysisEnvironment(work.environment, requiredAnalysisEnvironment(provenance))) return;

      try {
        transaction.objectStore(ANALYSES_STORE).put({ recordingId, ...toDurableRow(checkedAnalysis) });
        transaction.objectStore(ANALYSIS_OUTCOMES_STORE).put({ recordingId, ...checkedOutcome });
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

export async function cancelDesiredAnalysis(
  factory: IDBFactory | undefined,
  recordingId: string,
  now: number,
): Promise<{ changed: boolean; attemptToken?: string }> {
  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction([ANALYSIS_WORK_STORE, ANALYSIS_OUTCOMES_STORE], 'readwrite');
    const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
    const outcomes = transaction.objectStore(ANALYSIS_OUTCOMES_STORE);
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

function matchesTranscriptRow(value: unknown, provenance: AnalysisProvenance): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.generation === provenance.transcriptGeneration
    && row.revision === provenance.transcriptRevision
    && row.contentHash === provenance.transcriptHash;
}
