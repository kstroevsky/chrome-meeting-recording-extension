import { TELEMETRY_MAX_BATCH_BYTES, type TelemetryBatchV1 } from './contracts';
import { hasStores, openAdditiveDatabase } from '../storage/openAdditiveDatabase';

const DB_NAME = 'recording-extension-telemetry-v1';
const DB_VERSION = 1;
const OUTBOX = 'outbox';
const CHECKPOINTS = 'checkpoints';
const MAX_OUTBOX_BATCHES = 10;
const MAX_OUTBOX_BYTES = 256 * 1024;
const MAX_CHECKPOINTS = 4;
const MAX_CHECKPOINT_BYTES = 64 * 1024;

export type TelemetryCheckpoint = {
  runId: string;
  epoch?: number;
  updatedAt: number;
  payload: unknown;
};

type OutboxRecord = { batchId: string; createdAt: number; bytes: number; batch: TelemetryBatchV1 };

const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class TelemetryStore {
  private open(): Promise<IDBDatabase> {
    return openAdditiveDatabase(indexedDB, {
      name: DB_NAME,
      version: DB_VERSION,
      upgrade: (db) => {
        if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'batchId' });
        if (!db.objectStoreNames.contains(CHECKPOINTS)) db.createObjectStore(CHECKPOINTS, { keyPath: 'runId' });
      },
      isSatisfied: (db) => hasStores(db, [OUTBOX, CHECKPOINTS]),
    });
  }

  private async transact<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result: T;
      action(store, (value) => { result = value; }, reject);
      transaction.oncomplete = () => { db.close(); resolve(result!); };
      transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error('Telemetry transaction failed')); };
      transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Telemetry transaction aborted')); };
    });
  }

  async enqueue(batch: TelemetryBatchV1): Promise<boolean> {
    const bytes = encodedBytes(batch);
    if (bytes > TELEMETRY_MAX_BATCH_BYTES) return false;
    return this.transact<boolean>(OUTBOX, 'readwrite', (store, done, fail) => {
      const request = store.getAll();
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const records = (request.result as OutboxRecord[]).sort((a, b) => a.createdAt - b.createdAt);
        const existing = records.find((record) => record.batchId === batch.batchId);
        if (existing) { done(false); return; }
        let total = records.reduce((sum, record) => sum + record.bytes, 0);
        while (records.length >= MAX_OUTBOX_BATCHES || total + bytes > MAX_OUTBOX_BYTES) {
          const evicted = records.shift();
          if (!evicted) break;
          total -= evicted.bytes;
          store.delete(evicted.batchId);
        }
        store.put({ batchId: batch.batchId, createdAt: Date.now(), bytes, batch } satisfies OutboxRecord);
        done(true);
      };
    });
  }

  async listOutbox(): Promise<TelemetryBatchV1[]> {
    return this.transact<TelemetryBatchV1[]>(OUTBOX, 'readonly', (store, done, fail) => {
      const request = store.getAll();
      request.onerror = () => fail(request.error);
      request.onsuccess = () => done((request.result as OutboxRecord[]).sort((a, b) => a.createdAt - b.createdAt).map((record) => record.batch));
    });
  }

  async removeBatch(batchId: string): Promise<void> {
    return this.transact<void>(OUTBOX, 'readwrite', (store, done) => { store.delete(batchId); done(); });
  }

  async putCheckpoint(checkpoint: TelemetryCheckpoint): Promise<boolean> {
    if (encodedBytes(checkpoint) > MAX_CHECKPOINT_BYTES) return false;
    return this.transact<boolean>(CHECKPOINTS, 'readwrite', (store, done, fail) => {
      const request = store.getAll();
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const records = (request.result as TelemetryCheckpoint[]).sort((a, b) => a.updatedAt - b.updatedAt);
        const otherRecords = records.filter((record) => record.runId !== checkpoint.runId);
        while (otherRecords.length >= MAX_CHECKPOINTS) store.delete(otherRecords.shift()!.runId);
        store.put(checkpoint); done(true);
      };
    });
  }

  async listCheckpoints(): Promise<TelemetryCheckpoint[]> {
    return this.transact<TelemetryCheckpoint[]>(CHECKPOINTS, 'readonly', (store, done, fail) => {
      const request = store.getAll(); request.onerror = () => fail(request.error); request.onsuccess = () => done(request.result as TelemetryCheckpoint[]);
    });
  }

  async removeCheckpoint(runId: string): Promise<void> {
    return this.transact<void>(CHECKPOINTS, 'readwrite', (store, done) => { store.delete(runId); done(); });
  }

  async clear(): Promise<void> {
    await this.transact<void>(OUTBOX, 'readwrite', (store, done) => { store.clear(); done(); });
    await this.transact<void>(CHECKPOINTS, 'readwrite', (store, done) => { store.clear(); done(); });
  }
}
