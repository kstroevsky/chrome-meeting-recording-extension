import type { AnalysisJob } from '../../../shared/analysis/job';
import { ANALYSIS_WORK_STORE, openRecordingHistoryDatabase } from '../RecordingLibraryDatabase';
import {
  normalizeRecordingAnalysisWork,
  type RecordingAnalysisWork,
} from './RecordingAnalysisWork';

export type ClaimedAnalysisWork = RecordingAnalysisWork & {
  disposition: 'claimed';
  transcriptHash: string;
  claim: NonNullable<RecordingAnalysisWork['claim']>;
};

export type AnalysisAttemptTransition =
  | { disposition: 'retry-wait'; nextAttemptAt: number; error?: string }
  | { disposition: 'canceled' | 'unsupported'; error?: string };

export function isClaimable(work: RecordingAnalysisWork, now: number): boolean {
  if (work.disposition === 'pending' || work.disposition === 'retry-wait') return true;
  return work.disposition === 'claimed'
    && Boolean(work.claim)
    && work.claim!.leaseUntil <= now;
}

export function claimWork(
  current: RecordingAnalysisWork & { transcriptHash: string },
  now: number,
  leaseMs: number,
  attemptToken: string,
): ClaimedAnalysisWork {
  const claim = { attemptToken, claimedAt: now, leaseUntil: now + leaseMs };
  const next: ClaimedAnalysisWork = {
    ...current,
    transcriptHash: current.transcriptHash,
    disposition: 'claimed',
    attemptCount: current.attemptCount + 1,
    nextAttemptAt: claim.leaseUntil,
    claim,
    updatedAt: now,
  };
  delete next.error;
  return next;
}

export async function transitionClaim(
  factory: IDBFactory | undefined,
  recordingId: string,
  requestEpoch: number,
  attemptToken: string,
  update: (current: RecordingAnalysisWork) => RecordingAnalysisWork,
): Promise<boolean> {
  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(ANALYSIS_WORK_STORE, 'readwrite');
    const store = transaction.objectStore(ANALYSIS_WORK_STORE);
    const request = store.get(recordingId);
    let changed = false;
    request.onerror = () => reject(request.error ?? new Error('Could not read claimed analysis work'));
    request.onsuccess = () => {
      const current = normalizeRecordingAnalysisWork(request.result);
      if (!matchesClaim(current, requestEpoch, attemptToken)) return;
      store.put(stripUndefined(update(current)));
      changed = true;
    };
    transaction.oncomplete = () => resolve(changed);
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not update claimed analysis work'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Claimed analysis work update aborted'));
  });
}

export function cleanAnalysisWorkError(error: string): string {
  return error.trim().slice(0, 2_048) || 'Analysis attempt failed';
}

export function createAttemptToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function matchesAnalysisAttempt(
  work: RecordingAnalysisWork | undefined,
  job: AnalysisJob,
): work is RecordingAnalysisWork {
  return Boolean(
    work
    && job.requestEpoch
    && work.requestEpoch === job.requestEpoch
    && work.disposition === 'claimed'
    && work.claim?.attemptToken === job.id,
  );
}

export function applyAnalysisAttemptTransition(
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

function matchesClaim(
  work: RecordingAnalysisWork | undefined,
  requestEpoch: number,
  attemptToken: string,
): work is RecordingAnalysisWork & { claim: NonNullable<RecordingAnalysisWork['claim']> } {
  return Boolean(
    work
    && work.requestEpoch === requestEpoch
    && work.disposition === 'claimed'
    && work.claim?.attemptToken === attemptToken,
  );
}

function stripUndefined(work: RecordingAnalysisWork): RecordingAnalysisWork {
  return Object.fromEntries(Object.entries(work).filter(([, value]) => value !== undefined)) as RecordingAnalysisWork;
}
