import {
  INTEGRATION_DELIVERIES_STORE,
  INTEGRATION_DESTINATIONS_STORE,
  INTEGRATION_ROUTING_INTENTS_STORE,
  INTEGRATION_SECRETS_STORE,
  INTEGRATION_STREAMS_STORE,
  openIntegrationDatabase,
} from './IntegrationDatabase';
import {
  normalizeIntegrationDelivery,
  normalizeIntegrationDestination,
  normalizeIntegrationSecret,
  normalizeIntegrationStream,
  type IntegrationDelivery,
  type IntegrationDestination,
  type IntegrationSecret,
  type IntegrationStream,
} from './persistence';

/**
 * Multi-store mutations whose invariants would be broken by separate
 * transactions. Every method resolves only after its transaction commits.
 */
export class IntegrationUnitOfWork {
  constructor(private readonly factory?: IDBFactory) {}

  async createDestination(
    destination: IntegrationDestination,
    secrets: IntegrationSecret[],
  ): Promise<void> {
    const normalizedDestination = normalizeIntegrationDestination(destination);
    const normalizedSecrets = secrets.map(normalizeIntegrationSecret);
    if (!normalizedDestination || normalizedSecrets.some((secret) => !secret)) {
      throw new Error('Invalid integration destination transaction');
    }

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DESTINATIONS_STORE, INTEGRATION_SECRETS_STORE],
      (transaction) => {
        const secretStore = transaction.objectStore(INTEGRATION_SECRETS_STORE);
        for (const secret of normalizedSecrets as IntegrationSecret[]) {
          secretStore.put(secret);
        }
        transaction.objectStore(INTEGRATION_DESTINATIONS_STORE).put(normalizedDestination);
      },
      'Could not create integration destination',
    );
  }

  async planDelivery(delivery: IntegrationDelivery, stream: IntegrationStream): Promise<void> {
    const normalizedDelivery = normalizeIntegrationDelivery(delivery);
    const normalizedStream = normalizeIntegrationStream(stream);
    if (!normalizedDelivery || !normalizedStream) {
      throw new Error('Invalid integration delivery transaction');
    }

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DELIVERIES_STORE, INTEGRATION_STREAMS_STORE],
      (transaction) => {
        transaction.objectStore(INTEGRATION_DELIVERIES_STORE).put(normalizedDelivery);
        transaction.objectStore(INTEGRATION_STREAMS_STORE).put(normalizedStream);
      },
      'Could not atomically plan integration delivery',
    );
  }

  async deleteDestination(destination: IntegrationDestination, updatedAt: number): Promise<void> {
    const normalizedDestination = normalizeIntegrationDestination(destination);
    if (!normalizedDestination) throw new Error('Invalid integration destination deletion');
    const secretIds = [
      normalizedDestination.signingSecretId,
      ...(normalizedDestination.requestAuth.type === 'none'
        ? []
        : [normalizedDestination.requestAuth.secretId]),
    ];

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [
        INTEGRATION_DESTINATIONS_STORE,
        INTEGRATION_SECRETS_STORE,
        INTEGRATION_ROUTING_INTENTS_STORE,
        INTEGRATION_STREAMS_STORE,
        INTEGRATION_DELIVERIES_STORE,
      ],
      (transaction) => {
        transaction.objectStore(INTEGRATION_DESTINATIONS_STORE).delete(normalizedDestination.id);
        const secrets = transaction.objectStore(INTEGRATION_SECRETS_STORE);
        for (const secretId of secretIds) secrets.delete(secretId);
        deleteMatchingStreams(transaction, normalizedDestination.id);
        removeDestinationFromRouting(transaction, normalizedDestination.id);
        cancelDestinationDeliveries(transaction, normalizedDestination.id, updatedAt);
      },
      'Could not delete integration destination',
    );
  }
}

function deleteMatchingStreams(transaction: IDBTransaction, destinationId: string): void {
  const request = transaction.objectStore(INTEGRATION_STREAMS_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if ((cursor.value as { destinationId?: unknown }).destinationId === destinationId) {
      cursor.delete();
    }
    cursor.continue();
  };
}

function removeDestinationFromRouting(transaction: IDBTransaction, destinationId: string): void {
  const request = transaction.objectStore(INTEGRATION_ROUTING_INTENTS_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as { destinations?: Array<{ destinationId?: unknown }> };
    if (Array.isArray(row.destinations)) {
      const destinations = row.destinations.filter((item) => item.destinationId !== destinationId);
      if (destinations.length !== row.destinations.length) {
        if (destinations.length) cursor.update({ ...row, destinations });
        else cursor.delete();
      }
    }
    cursor.continue();
  };
}

function cancelDestinationDeliveries(
  transaction: IDBTransaction,
  destinationId: string,
  updatedAt: number,
): void {
  const request = transaction.objectStore(INTEGRATION_DELIVERIES_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as IntegrationDelivery;
    const unresolved = row.destinationId === destinationId
      && ['pending', 'delivering', 'retrying', 'action-required'].includes(row.state);
    if (unresolved) {
      const next = {
        ...row,
        state: 'canceled' as const,
        lastErrorCode: 'destination-deleted',
        updatedAt,
      };
      delete next.nextAttemptAt;
      cursor.update(next);
    }
    cursor.continue();
  };
}

async function runTransaction(
  database: IDBDatabase,
  storeNames: string[],
  mutate: (transaction: IDBTransaction) => void,
  errorMessage: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeNames, 'readwrite');
    mutate(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
    transaction.onabort = () => reject(transaction.error ?? new Error(`${errorMessage} (aborted)`));
  });
}
