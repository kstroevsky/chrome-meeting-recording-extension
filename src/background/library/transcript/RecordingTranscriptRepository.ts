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
  type TranscriptIdentity,
  type TranscriptSnapshot,
} from '../../../shared/transcriptIdentity';
import {
  ANALYSIS_WORK_STORE,
  TRANSCRIPTS_STORE as STORE_NAME,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';
import {
  normalizeRecordingAnalysisWork,
  requestAnalysisWork,
} from '../analysis/RecordingAnalysisWork';

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

type DurableTranscript = {
  recordingId: string;
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  canonicalizationVersion: typeof TRANSCRIPT_CANONICALIZATION_VERSION;
  generation: string;
  revision: number;
  contentHash?: string;
  committedAt: number;
  transcript: Transcript;
};

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
      request.onsuccess = () => resolve(readStored(request.result));
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
          const current = readStored(request.result);
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
            store.put({
              recordingId,
              schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
              canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
              generation: result.generation,
              revision: result.revision,
              committedAt,
              transcript: next,
            } satisfies DurableTranscript);
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
    if (!isSha256Hex(contentHash)) throw new Error('Transcript hash must be a SHA-256 hex digest');
    const next = normalizeTranscript(transcript);
    if (!next?.segments.length) throw new Error('Transcript replacement must contain at least one segment');
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ANALYSIS_WORK_STORE], 'readwrite');
      const transcriptStore = transaction.objectStore(STORE_NAME);
      const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
      const transcriptRequest = transcriptStore.get(recordingId);
      let result: TranscriptSnapshot | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      transcriptRequest.onerror = () => fail(transcriptRequest.error ?? new Error('Could not read recording transcript'));
      transcriptRequest.onsuccess = () => {
        try {
          const current = readStored(transcriptRequest.result);
          if (current && sameTranscript(current.transcript, next)) {
            result = current.contentHash === contentHash ? current : { ...current, contentHash };
            if (result !== current) transcriptStore.put(toDurableTranscript(recordingId, result));
          } else {
            const committedAt = this.now();
            result = {
              schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
              canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
              generation: this.makeGeneration(),
              revision: (current?.revision ?? 0) + 1,
              contentHash,
              committedAt,
              transcript: next,
            };
            transcriptStore.put(toDurableTranscript(recordingId, result));
          }
          const workRequest = workStore.get(recordingId);
          workRequest.onerror = () => fail(workRequest.error ?? new Error('Could not read desired analysis work'));
          workRequest.onsuccess = () => {
            try {
              const currentWork = normalizeRecordingAnalysisWork(workRequest.result);
              workStore.put(requestAnalysisWork(
                currentWork,
                recordingId,
                identityOf(result!),
                environment,
                this.now(),
              ));
            } catch (error) {
              try { transaction.abort(); } catch {}
              fail(error);
            }
          };
        } catch (error) {
          try { transaction.abort(); } catch {}
          fail(error);
        }
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        if (!result) {
          reject(new Error('Transcript replacement did not persist'));
          return;
        }
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not replace recording transcript'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Recording transcript replacement aborted'));
    });
  }

  /** Requests analysis for the exact transcript row observed by this transaction. */
  async requestCurrentAnalysis(
    recordingId: string,
    environment: AnalysisEnvironmentProvenance,
    options: { force?: boolean } = {},
  ): Promise<TranscriptSnapshot | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ANALYSIS_WORK_STORE], 'readwrite');
      const transcriptStore = transaction.objectStore(STORE_NAME);
      const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
      const transcriptRequest = transcriptStore.get(recordingId);
      let result: TranscriptSnapshot | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      transcriptRequest.onerror = () => fail(transcriptRequest.error ?? new Error('Could not read recording transcript'));
      transcriptRequest.onsuccess = () => {
        try {
          result = readStored(transcriptRequest.result);
          if (!result) return;
          const workRequest = workStore.get(recordingId);
          workRequest.onerror = () => fail(workRequest.error ?? new Error('Could not read desired analysis work'));
          workRequest.onsuccess = () => {
            try {
              const currentWork = normalizeRecordingAnalysisWork(workRequest.result);
              const nextWork = requestAnalysisWork(
                currentWork,
                recordingId,
                identityOf(result!),
                environment,
                this.now(),
                options.force === true,
              );
              if (nextWork !== currentWork) workStore.put(nextWork);
            } catch (error) {
              try { transaction.abort(); } catch {}
              fail(error);
            }
          };
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
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not request transcript analysis'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Transcript analysis request aborted'));
    });
  }

  /** Caches a derived hash only if the exact transcript mutation is still current. */
  async cacheContentHash(recordingId: string, generation: string, revision: number, contentHash: string): Promise<void> {
    if (!isSha256Hex(contentHash)) throw new Error('Transcript hash must be a SHA-256 hex digest');
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ANALYSIS_WORK_STORE], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
      const request = store.get(recordingId);
      request.onerror = () => reject(request.error ?? new Error('Could not read recording transcript'));
      request.onsuccess = () => {
        const current = readStored(request.result);
        if (!current
          || current.generation !== generation
          || current.revision !== revision) return;
        if (current.contentHash !== contentHash) {
          store.put(toDurableTranscript(recordingId, { ...current, contentHash }));
        }
        const workRequest = workStore.get(recordingId);
        workRequest.onerror = () => reject(workRequest.error ?? new Error('Could not read desired analysis work'));
        workRequest.onsuccess = () => {
          const currentWork = normalizeRecordingAnalysisWork(workRequest.result);
          if (!currentWork
            || currentWork.transcriptGeneration !== generation
            || currentWork.transcriptRevision !== revision
            || (currentWork.transcriptHash && currentWork.transcriptHash !== contentHash)) return;
          const nextWork = requestAnalysisWork(
            currentWork,
            recordingId,
            { generation, revision, contentHash },
            currentWork.environment,
            this.now(),
          );
          if (nextWork !== currentWork) workStore.put(nextWork);
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not cache transcript hash'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Transcript hash write aborted'));
    });
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

function identityOf(snapshot: TranscriptSnapshot): TranscriptIdentity {
  return {
    generation: snapshot.generation,
    revision: snapshot.revision,
    contentHash: snapshot.contentHash,
  };
}

function toDurableTranscript(recordingId: string, snapshot: TranscriptSnapshot): DurableTranscript {
  return {
    recordingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
    generation: snapshot.generation,
    revision: snapshot.revision,
    ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
    committedAt: snapshot.committedAt,
    transcript: snapshot.transcript,
  };
}

function readStored(value: unknown): TranscriptSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const nested = normalizeTranscript(candidate.transcript);
  if (nested?.segments.length) {
    const revision = finitePositiveInteger(candidate.revision) ?? 1;
    const committedAt = finiteNonNegative(candidate.committedAt) ?? finiteNonNegative(candidate.updatedAt) ?? 0;
    const generation = typeof candidate.generation === 'string' && candidate.generation
      ? candidate.generation
      : legacyGeneration(candidate.recordingId, revision, committedAt);
    const contentHash = candidate.canonicalizationVersion === TRANSCRIPT_CANONICALIZATION_VERSION
      && typeof candidate.contentHash === 'string'
      && isSha256Hex(candidate.contentHash)
      ? candidate.contentHash
      : '';
    return {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
      generation,
      revision,
      contentHash,
      committedAt,
      transcript: nested,
    };
  }

  // Legacy v5-v8 rows flattened the Transcript fields into the store row.
  const legacy = normalizeTranscript(value);
  if (!legacy?.segments.length) return undefined;
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
    generation: legacyGeneration(candidate.recordingId, 1, finiteNonNegative(candidate.updatedAt) ?? 0),
    revision: 1,
    contentHash: '',
    committedAt: finiteNonNegative(candidate.updatedAt) ?? 0,
    transcript: legacy,
  };
}

function legacyGeneration(recordingId: unknown, revision: number, committedAt: number): string {
  return `legacy:${typeof recordingId === 'string' ? recordingId : 'unknown'}:${revision}:${committedAt}`;
}

function createTranscriptGeneration(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function sameTranscript(left: Transcript, right: Transcript): boolean {
  if (left.source !== right.source || left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => {
    const other = right.segments[index];
    return segment.tStartMs === other.tStartMs
      && segment.tEndMs === other.tEndMs
      && segment.speaker === other.speaker
      && segment.text === other.text;
  });
}
