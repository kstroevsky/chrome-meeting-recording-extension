/**
 * @file background/recordingHistoryDatabase.ts
 *
 * Owns the `recording-history` IndexedDB connection and schema for every
 * repository that reads it. Three repositories now share this database — history
 * entries, notations and transcripts — and a database has exactly one version, so the
 * version number and the `onupgradeneeded` that satisfies it must live in one
 * place. A repository that declared its own version would downgrade-block the
 * other on open.
 *
 * The upgrade is idempotent and presence-driven (`contains(...)` checks) rather
 * than switched on `oldVersion`, so a profile arriving from any earlier version
 * converges on the same schema.
 */

import { normalizeRecordingHistoryEntry, type RecordingHistoryEntry } from '../shared/recordingHistory';

const DATABASE_NAME = 'recording-history';
/**
 * v3 → v4 adds the `notations` store (ADR-0005).
 * v4 → v5 adds the `transcripts` store (ADR-0007).
 */
const DATABASE_VERSION = 5;

export const RECORDINGS_STORE = 'recordings';
export const NOTATIONS_STORE = 'notations';
export const TRANSCRIPTS_STORE = 'transcripts';
export const CREATED_AT_ID_INDEX = 'createdAtId';
export const ACTIVE_CREATED_AT_ID_INDEX = 'activeCreatedAtId';

/**
 * Tombstones remain durable so late upload/recovery work cannot recreate a
 * deleted history entry. This storage-only key excludes them from the paged
 * index, keeping list work proportional to visible recordings rather than all
 * historical deletions.
 */
export type StoredRecordingHistoryEntry = RecordingHistoryEntry & { activeCreatedAt?: number };

export function toStoredEntry(entry: RecordingHistoryEntry): StoredRecordingHistoryEntry {
  const stored: StoredRecordingHistoryEntry = { ...entry };
  if (entry.deletedAt != null) {
    delete stored.activeCreatedAt;
  } else {
    stored.activeCreatedAt = entry.createdAt;
  }
  return stored;
}

/**
 * One connection per factory, so the repositories sharing this database share a
 * connection rather than blocking each other's upgrade. Keyed weakly on the
 * factory so each test's isolated `IDBFactory` gets its own entry and is
 * collected with it.
 */
const connections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

export function openRecordingHistoryDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const resolved = factory ?? globalThis.indexedDB;
  if (!resolved) return Promise.reject(new Error('IndexedDB is unavailable in this context'));

  const cached = connections.get(resolved);
  if (cached) return cached;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = resolved.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => upgrade(request.result, request.transaction!);
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (connections.get(resolved) === tracked) connections.delete(resolved);
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open recording history'));
    request.onblocked = () => reject(new Error('Recording history upgrade is blocked by another extension context'));
  });

  const tracked = opening.catch((error) => {
    if (connections.get(resolved) === tracked) connections.delete(resolved);
    throw error;
  });
  connections.set(resolved, tracked);
  return tracked;
}

function upgrade(database: IDBDatabase, transaction: IDBTransaction): void {
  const recordings = database.objectStoreNames.contains(RECORDINGS_STORE)
    ? transaction.objectStore(RECORDINGS_STORE)
    : database.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' });
  if (!recordings.indexNames.contains(CREATED_AT_ID_INDEX)) {
    recordings.createIndex(CREATED_AT_ID_INDEX, ['createdAt', 'id'], { unique: true });
  }
  if (!recordings.indexNames.contains(ACTIVE_CREATED_AT_ID_INDEX)) {
    recordings.createIndex(ACTIVE_CREATED_AT_ID_INDEX, ['activeCreatedAt', 'id'], { unique: true });
    migrateVisibilityKeys(recordings);
  }

  // Notations are keyed by the recording's history id and hold the whole list,
  // so a mark can be written before the history row it belongs to exists.
  if (!database.objectStoreNames.contains(NOTATIONS_STORE)) {
    database.createObjectStore(NOTATIONS_STORE, { keyPath: 'recordingId' });
  }

  // Transcripts key the same way and for the same reason: captions are committed
  // while the call is still running, long before finalize creates the row.
  if (!database.objectStoreNames.contains(TRANSCRIPTS_STORE)) {
    database.createObjectStore(TRANSCRIPTS_STORE, { keyPath: 'recordingId' });
  }
}

/** Adds the active-list index key to v2 rows without changing their public shape. */
function migrateVisibilityKeys(store: IDBObjectStore): void {
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const entry = normalizeRecordingHistoryEntry(cursor.value);
    if (entry) {
      const stored = toStoredEntry(entry);
      const current = cursor.value as StoredRecordingHistoryEntry;
      if (current.activeCreatedAt !== stored.activeCreatedAt) cursor.update(stored);
    }
    cursor.continue();
  };
}
