const DATABASE_NAME = 'meeting-integrations';
/** v1 held destination credentials; v2 adds recording routing and durable delivery state. */
const DATABASE_VERSION = 2;

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
    request.onerror = () => reject(request.error ?? new Error('Could not open integration database'));
    request.onblocked = () => reject(new Error('Integration database upgrade is blocked by another extension context'));
  });
  const tracked = opening.catch((error) => {
    if (connections.get(resolved) === tracked) connections.delete(resolved);
    throw error;
  });
  connections.set(resolved, tracked);
  return tracked;
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
}
