/**
 * @file offscreen/storage/indexedDbKeyValueArea.ts
 *
 * A small key-value store over IndexedDB, for durable state the **offscreen
 * document** owns.
 *
 * **Why not `chrome.storage.local`.** An offscreen document's `chrome` object
 * exposes `runtime` and nothing else — measured against the built extension,
 * where it is exactly `csi`, `loadTimes`, `runtime`. Worse than unavailable, it
 * is *quietly* unavailable: the wrappers in `platform/chrome/storage.ts`
 * deliberately degrade to a no-op rather than throw, so that the stop/finalize
 * pipeline cannot be aborted by a failed bookkeeping write. In the offscreen
 * document that turns every durable write into a successful-looking discard.
 *
 * IndexedDB belongs to the extension *origin*, so the offscreen document, the
 * service worker and extension pages all see the same data — which is what
 * durable state written here needs.
 *
 * Deliberately not a cache: `getAll` returns what is on disk, and a write that
 * fails rejects rather than resolving, so a caller can decide what to do.
 */

import { hasStores, openAdditiveDatabase } from '../../shared/storage/openAdditiveDatabase';

export interface KeyValueArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export type IndexedDbAreaOptions = {
  databaseName: string;
  storeName: string;
  version?: number;
  factory?: IDBFactory;
};

/**
 * Opens (lazily, once) a database holding one object store, and exposes it as
 * a key-value area.
 *
 * Where `indexedDB` does not exist at all, every operation succeeds and holds
 * nothing. That keeps a host without storage — a test environment, a stripped
 * runtime — from failing callers that only wanted to record bookkeeping, which
 * is the same tolerance `platform/chrome/storage.ts` has. The difference is
 * that here it is the exception rather than the production path.
 */
export function createIndexedDbKeyValueArea(options: IndexedDbAreaOptions): KeyValueArea {
  const { databaseName, storeName, version = 1 } = options;
  const factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  if (!factory) {
    return { getAll: async () => ({}), set: async () => {}, remove: async () => {} };
  }

  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= openAdditiveDatabase(factory, {
      name: databaseName,
      version,
      upgrade: (database) => {
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      },
      isSatisfied: (database) => hasStores(database, [storeName]),
    }).then((database) => {
      // Another context upgrading must not be blocked by a handle held here.
      database.onversionchange = () => {
        database.close();
        opening = null;
      };
      return database;
    }, (error) => {
      opening = null;
      throw error;
    });
    return opening;
  };

  const run = async (mode: IDBTransactionMode, body: (store: IDBObjectStore) => void): Promise<void> => {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      body(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error(`${databaseName} transaction aborted`));
      transaction.onerror = () => reject(transaction.error ?? new Error(`${databaseName} transaction failed`));
    });
  };

  return {
    async getAll() {
      const entries: Record<string, unknown> = {};
      await run('readonly', (store) => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          entries[String(current.key)] = current.value;
          current.continue();
        };
      });
      return entries;
    },
    async set(items) {
      await run('readwrite', (store) => {
        for (const [key, value] of Object.entries(items)) store.put(value, key);
      });
    },
    async remove(key) {
      // Deleting an absent key succeeds, so a replayed removal is harmless.
      await run('readwrite', (store) => { store.delete(key); });
    },
  };
}
