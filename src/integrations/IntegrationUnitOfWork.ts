import {
  INTEGRATION_DELIVERIES_STORE,
  INTEGRATION_DESTINATIONS_STORE,
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
