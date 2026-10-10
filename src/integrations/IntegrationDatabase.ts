import { hasStores, openAdditiveDatabase } from '../shared/storage/openAdditiveDatabase';

const DATABASE_NAME = 'meeting-integrations';
/**
 * v1 held destination credentials; v2 added routing/outbox state; v3 fences
 * unresolved pre-authorization-ceiling deliveries from automatic replay.
 */
const DATABASE_VERSION = 3;

export const INTEGRATION_DESTINATIONS_STORE = 'destinations';
export const INTEGRATION_SECRETS_STORE = 'secrets';
export const INTEGRATION_ROUTING_INTENTS_STORE = 'routingIntents';
export const INTEGRATION_STREAMS_STORE = 'streams';
export const INTEGRATION_DELIVERIES_STORE = 'deliveries';

export const DELIVERY_STREAM_REVISION_INDEX = 'streamRevision';
export const DELIVERY_NEXT_ATTEMPT_INDEX = 'nextAttemptAt';

const connections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

export function openIntegrationDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const resolved = factory ?? globalThis.indexedDB;
  if (!resolved) return Promise.reject(new Error('IndexedDB is unavailable in this context'));
  const cached = connections.get(resolved);
  if (cached) return cached;

  // Additive, so a build from any branch opens a profile any other build has
  // touched — see openAdditiveDatabase.
  const opening = openAdditiveDatabase(resolved, {
    name: DATABASE_NAME,
    version: DATABASE_VERSION,
    upgrade,
    isSatisfied,
    blockedError: () => new Error('Integration database upgrade is blocked by another extension context'),
  }).then((database) => {
    database.onversionchange = () => {
      database.close();
      if (connections.get(resolved) === tracked) connections.delete(resolved);
    };
    return database;
  });
  const tracked = opening.catch((error) => {
    if (connections.get(resolved) === tracked) connections.delete(resolved);
    throw error;
  });
  connections.set(resolved, tracked);
  return tracked;
}

/** Every store and index this build reads — all that `upgrade` creates. */
function isSatisfied(database: IDBDatabase): boolean {
  const stores = [
    INTEGRATION_DESTINATIONS_STORE,
    INTEGRATION_SECRETS_STORE,
    INTEGRATION_ROUTING_INTENTS_STORE,
    INTEGRATION_STREAMS_STORE,
    INTEGRATION_DELIVERIES_STORE,
  ];
  if (!hasStores(database, stores)) return false;
  const indexes = database.transaction(INTEGRATION_DELIVERIES_STORE, 'readonly').objectStore(INTEGRATION_DELIVERIES_STORE).indexNames;
  return indexes.contains(DELIVERY_STREAM_REVISION_INDEX) && indexes.contains(DELIVERY_NEXT_ATTEMPT_INDEX);
}

function upgrade(database: IDBDatabase, transaction: IDBTransaction): void {
  if (!database.objectStoreNames.contains(INTEGRATION_DESTINATIONS_STORE)) {
    database.createObjectStore(INTEGRATION_DESTINATIONS_STORE, { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains(INTEGRATION_SECRETS_STORE)) {
    database.createObjectStore(INTEGRATION_SECRETS_STORE, { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains(INTEGRATION_ROUTING_INTENTS_STORE)) {
    database.createObjectStore(INTEGRATION_ROUTING_INTENTS_STORE, { keyPath: 'recordingId' });
  }
  if (!database.objectStoreNames.contains(INTEGRATION_STREAMS_STORE)) {
    database.createObjectStore(INTEGRATION_STREAMS_STORE, {
      keyPath: ['destinationId', 'recordingId'],
    });
  }
  const deliveries = database.objectStoreNames.contains(INTEGRATION_DELIVERIES_STORE)
    ? transaction.objectStore(INTEGRATION_DELIVERIES_STORE)
    : database.createObjectStore(INTEGRATION_DELIVERIES_STORE, { keyPath: 'id' });
  if (!deliveries.indexNames.contains(DELIVERY_STREAM_REVISION_INDEX)) {
    deliveries.createIndex(
      DELIVERY_STREAM_REVISION_INDEX,
      ['destinationId', 'recordingId', 'revision'],
      { unique: true },
    );
  }
  if (!deliveries.indexNames.contains(DELIVERY_NEXT_ATTEMPT_INDEX)) {
    deliveries.createIndex(DELIVERY_NEXT_ATTEMPT_INDEX, 'nextAttemptAt');
  }
  if (transaction.db.version >= 3 && transaction.objectStore(INTEGRATION_DELIVERIES_STORE)) {
    fenceLegacyDeliveries(deliveries);
  }
}

function fenceLegacyDeliveries(deliveries: IDBObjectStore): void {
  const request = deliveries.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as Record<string, unknown>;
    if (
      row.allowedPolicy == null
      && (row.state === 'pending' || row.state === 'delivering' || row.state === 'retrying')
    ) {
      const next = {
        ...row,
        state: 'action-required',
        lastErrorCode: 'authorization-ceiling-missing',
        updatedAt: Date.now(),
      };
      delete (next as { nextAttemptAt?: unknown }).nextAttemptAt;
      cursor.update(next);
    }
    cursor.continue();
  };
}
