import { normalizeTranscript, type Transcript } from '../../../shared/transcript';
import type { AnalysisEnvironmentProvenance } from '../../../shared/analysis/provenance';
import {
  TRANSCRIPT_CANONICALIZATION_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptSnapshot,
} from '../../../shared/transcriptIdentity';
import {
  ANALYSIS_WORK_STORE,
  TRANSCRIPTS_STORE,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';
import {
  normalizeRecordingAnalysisWork,
  requestAnalysisWork,
} from '../analysis/RecordingAnalysisWork';
import {
  isSha256Hex,
  readStoredTranscript,
  sameTranscript,
  toDurableTranscript,
  transcriptIdentityOf,
} from './RecordingTranscriptCodec';

export async function replaceTranscriptAndRequestAnalysis(
  factory: IDBFactory | undefined,
  now: () => number,
  makeGeneration: () => string,
  recordingId: string,
  transcript: Transcript,
  contentHash: string,
  environment: AnalysisEnvironmentProvenance,
): Promise<TranscriptSnapshot> {
  if (!isSha256Hex(contentHash)) throw new Error('Transcript hash must be a SHA-256 hex digest');
  const next = normalizeTranscript(transcript);
  if (!next?.segments.length) throw new Error('Transcript replacement must contain at least one segment');
  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction([TRANSCRIPTS_STORE, ANALYSIS_WORK_STORE], 'readwrite');
    const transcriptStore = transaction.objectStore(TRANSCRIPTS_STORE);
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
        const current = readStoredTranscript(transcriptRequest.result);
        if (current && sameTranscript(current.transcript, next)) {
          result = current.contentHash === contentHash ? current : { ...current, contentHash };
          if (result !== current) transcriptStore.put(toDurableTranscript(recordingId, result));
        } else {
          const committedAt = now();
          result = {
            schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
            canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
            generation: makeGeneration(),
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
              transcriptIdentityOf(result!),
              environment,
              now(),
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

export async function requestCurrentTranscriptAnalysis(
  factory: IDBFactory | undefined,
  now: () => number,
  recordingId: string,
  environment: AnalysisEnvironmentProvenance,
  options: { force?: boolean } = {},
): Promise<TranscriptSnapshot | undefined> {
  const database = await openRecordingHistoryDatabase(factory);
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction([TRANSCRIPTS_STORE, ANALYSIS_WORK_STORE], 'readwrite');
    const transcriptStore = transaction.objectStore(TRANSCRIPTS_STORE);
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
        result = readStoredTranscript(transcriptRequest.result);
        if (!result) return;
        const workRequest = workStore.get(recordingId);
        workRequest.onerror = () => fail(workRequest.error ?? new Error('Could not read desired analysis work'));
        workRequest.onsuccess = () => {
          try {
            const currentWork = normalizeRecordingAnalysisWork(workRequest.result);
            const nextWork = requestAnalysisWork(
              currentWork,
              recordingId,
              transcriptIdentityOf(result!),
              environment,
              now(),
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

export async function cacheTranscriptContentHash(
  factory: IDBFactory | undefined,
  now: () => number,
  recordingId: string,
  generation: string,
  revision: number,
  contentHash: string,
): Promise<void> {
  if (!isSha256Hex(contentHash)) throw new Error('Transcript hash must be a SHA-256 hex digest');
  const database = await openRecordingHistoryDatabase(factory);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([TRANSCRIPTS_STORE, ANALYSIS_WORK_STORE], 'readwrite');
    const store = transaction.objectStore(TRANSCRIPTS_STORE);
    const workStore = transaction.objectStore(ANALYSIS_WORK_STORE);
    const request = store.get(recordingId);
    request.onerror = () => reject(request.error ?? new Error('Could not read recording transcript'));
    request.onsuccess = () => {
      const current = readStoredTranscript(request.result);
      if (!current || current.generation !== generation || current.revision !== revision) return;
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
          now(),
        );
        if (nextWork !== currentWork) workStore.put(nextWork);
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not cache transcript hash'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Transcript hash write aborted'));
  });
}
