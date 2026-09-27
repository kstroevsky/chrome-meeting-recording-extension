import {
  ANALYSIS_WORK_DUE_INDEX,
  ANALYSIS_WORK_STORE,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';
import {
  normalizeRecordingAnalysisWork,
  type AnalysisWorkDisposition,
  type RecordingAnalysisWork,
} from './RecordingAnalysisWork';

const DEFAULT_LEASE_MS = 2 * 60_000;

export type ClaimedAnalysisWork = RecordingAnalysisWork & {
  disposition: 'claimed';
  transcriptHash: string;
  claim: NonNullable<RecordingAnalysisWork['claim']>;
};

/**
 * Durable scheduler state for ADR-0009 TECH-04.
 *
 * Claims are leases, not locks. A worker may outlive its lease, so every later
 * transition still compares requestEpoch + attemptToken before changing state.
 */
export class RecordingAnalysisWorkRepository {
  constructor(
    private readonly factory?: IDBFactory,
    private readonly now: () => number = () => Date.now(),
    private readonly makeAttemptToken: () => string = createAttemptToken,
  ) {}

  async get(recordingId: string): Promise<RecordingAnalysisWork | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(ANALYSIS_WORK_STORE, 'readonly')
        .objectStore(ANALYSIS_WORK_STORE)
        .get(recordingId);
      request.onsuccess = () => resolve(normalizeRecordingAnalysisWork(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read desired analysis work'));
    });
  }

  /** Earliest future retry/lease expiry, excluding rows already due now. */
  async nextAttemptAfter(now: number): Promise<number | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(ANALYSIS_WORK_STORE, 'readonly');
      const index = transaction.objectStore(ANALYSIS_WORK_STORE).index(ANALYSIS_WORK_DUE_INDEX);
      const request = index.openCursor(IDBKeyRange.lowerBound([now + 1, '']));
      let result: number | undefined;
      request.onerror = () => reject(request.error ?? new Error('Could not inspect future analysis work'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const work = normalizeRecordingAnalysisWork(cursor.value);
        if (work && (work.disposition === 'retry-wait' || work.disposition === 'claimed')) {
          result = work.nextAttemptAt;
          return;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not inspect future analysis work'));
    });
  }

  /**
   * Claims at most the requested number of rows that are due now.
   *
   * Claimed rows remain on the due index at lease expiry. Reclaiming an expired
   * attempt creates a new token; the old worker may still finish, but its token
   * can no longer publish or retire the row.
   */
  async claimDue(
    limit: number,
    options: { now?: number; leaseMs?: number } = {},
  ): Promise<ClaimedAnalysisWork[]> {
    if (limit <= 0) return [];
    const now = options.now ?? this.now();
    const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(ANALYSIS_WORK_STORE, 'readwrite');
      const store = transaction.objectStore(ANALYSIS_WORK_STORE);
      const index = store.index(ANALYSIS_WORK_DUE_INDEX);
      const range = IDBKeyRange.bound([0, ''], [now, '\uffff']);
      const request = index.openCursor(range);
      const claimed: ClaimedAnalysisWork[] = [];
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not scan due analysis work'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || claimed.length >= limit) return;
        const current = normalizeRecordingAnalysisWork(cursor.value);
        if (current && isClaimable(current, now) && current.transcriptHash) {
          const next = claimWork(
            { ...current, transcriptHash: current.transcriptHash },
            now,
            leaseMs,
            this.makeAttemptToken(),
          );
          cursor.update(next);
          claimed.push(next);
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(claimed);
      };
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not claim analysis work'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Analysis work claim aborted'));
    });
  }

  /** Claims one known recording without scanning unrelated due work. */
  async claim(
    recordingId: string,
    options: { now?: number; leaseMs?: number } = {},
  ): Promise<ClaimedAnalysisWork | undefined> {
    const now = options.now ?? this.now();
    const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(ANALYSIS_WORK_STORE, 'readwrite');
      const store = transaction.objectStore(ANALYSIS_WORK_STORE);
      const request = store.get(recordingId);
      let claimed: ClaimedAnalysisWork | undefined;
      request.onerror = () => reject(request.error ?? new Error('Could not read desired analysis work'));
      request.onsuccess = () => {
        const current = normalizeRecordingAnalysisWork(request.result);
        if (!current
          || !current.transcriptHash
          || (current.nextAttemptAt ?? Number.POSITIVE_INFINITY) > now
          || !isClaimable(current, now)) return;
        claimed = claimWork(
          { ...current, transcriptHash: current.transcriptHash },
          now,
          leaseMs,
          this.makeAttemptToken(),
        );
        store.put(claimed);
      };
      transaction.oncomplete = () => resolve(claimed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not claim recording analysis work'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording analysis claim aborted'));
    });
  }

  /** Returns a failed attempt to the due queue only if it still owns the row. */
  async retryClaim(
    recordingId: string,
    requestEpoch: number,
    attemptToken: string,
    error: string,
    nextAttemptAt: number,
  ): Promise<boolean> {
    return await this.transitionClaim(recordingId, requestEpoch, attemptToken, (current) => ({
      ...current,
      disposition: 'retry-wait',
      nextAttemptAt: Math.max(0, nextAttemptAt),
      error: cleanError(error),
      updatedAt: this.now(),
      claim: undefined,
    }));
  }

  /** Records an explicit terminal disposition for the exact claimed request. */
  async finishClaim(
    recordingId: string,
    requestEpoch: number,
    attemptToken: string,
    disposition: Extract<AnalysisWorkDisposition, 'canceled' | 'unsupported'>,
    error?: string,
  ): Promise<boolean> {
    return await this.transitionClaim(recordingId, requestEpoch, attemptToken, (current) => {
      const next: RecordingAnalysisWork = {
        ...current,
        disposition,
        updatedAt: this.now(),
      };
      delete next.claim;
      delete next.nextAttemptAt;
      if (error) next.error = cleanError(error);
      else delete next.error;
      return next;
    });
  }

  /** Releases a claim that was selected but should not be dispatched yet. */
  async releaseClaim(
    recordingId: string,
    requestEpoch: number,
    attemptToken: string,
  ): Promise<boolean> {
    return await this.transitionClaim(recordingId, requestEpoch, attemptToken, (current) => {
      const next: RecordingAnalysisWork = {
        ...current,
        disposition: 'pending',
        attemptCount: Math.max(0, current.attemptCount - 1),
        nextAttemptAt: 0,
        updatedAt: this.now(),
      };
      delete next.claim;
      delete next.error;
      return next;
    });
  }

  private async transitionClaim(
    recordingId: string,
    requestEpoch: number,
    attemptToken: string,
    update: (current: RecordingAnalysisWork) => RecordingAnalysisWork,
  ): Promise<boolean> {
    const database = await this.open();
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

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}

function isClaimable(work: RecordingAnalysisWork, now: number): boolean {
  if (work.disposition === 'pending' || work.disposition === 'retry-wait') return true;
  return work.disposition === 'claimed'
    && Boolean(work.claim)
    && work.claim!.leaseUntil <= now;
}

function claimWork(
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

export function matchesClaim(
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

function cleanError(error: string): string {
  return error.trim().slice(0, 2_048) || 'Analysis attempt failed';
}

function stripUndefined(work: RecordingAnalysisWork): RecordingAnalysisWork {
  return Object.fromEntries(Object.entries(work).filter(([, value]) => value !== undefined)) as RecordingAnalysisWork;
}

function createAttemptToken(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
