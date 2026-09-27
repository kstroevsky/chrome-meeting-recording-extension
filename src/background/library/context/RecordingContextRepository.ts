import {
  normalizeRecordingContext,
  type RecordingContext,
} from '../../../shared/recordingContext';
import {
  RECORDING_CONTEXTS_STORE as STORE_NAME,
  openRecordingHistoryDatabase,
} from '../RecordingLibraryDatabase';

export interface RecordingContextRepositoryPort {
  get(recordingId: string): Promise<RecordingContext | undefined>;
  put(context: RecordingContext): Promise<void>;
  finish(recordingId: string, endedAt: number): Promise<RecordingContext | undefined>;
  remove(recordingId: string): Promise<void>;
}

export class RecordingContextRepository implements RecordingContextRepositoryPort {
  constructor(private readonly factory?: IDBFactory) {}

  async get(recordingId: string): Promise<RecordingContext | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(recordingId);
      request.onsuccess = () => resolve(normalizeRecordingContext(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read recording context'));
    });
  }

  async put(context: RecordingContext): Promise<void> {
    const normalized = normalizeRecordingContext(context);
    if (!normalized) throw new Error('Invalid recording context');
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(normalized);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not write recording context'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording context write aborted'));
    });
  }

  async finish(recordingId: string, endedAt: number): Promise<RecordingContext | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(recordingId);
      let result: RecordingContext | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not read recording context'));
      request.onsuccess = () => {
        const current = normalizeRecordingContext(request.result);
        if (!current) return;
        const next = normalizeRecordingContext({
          ...current,
          endedAt: current.endedAt ?? Math.max(current.startedAt, endedAt),
        });
        if (!next) return;
        result = next;
        store.put(next);
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(transaction.error ?? new Error('Could not finish recording context'));
      transaction.onabort = () => fail(transaction.error ?? new Error('Recording context finish aborted'));
    });
  }

  async remove(recordingId: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(recordingId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete recording context'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Recording context delete aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return openRecordingHistoryDatabase(this.factory);
  }
}
