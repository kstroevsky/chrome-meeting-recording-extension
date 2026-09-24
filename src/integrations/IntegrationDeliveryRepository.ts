import {
  DELIVERY_STREAM_REVISION_INDEX,
  INTEGRATION_DELIVERIES_STORE,
} from './IntegrationDatabase';
import { IntegrationRepositorySupport } from './IntegrationRepositorySupport';
import { normalizeIntegrationDelivery, type IntegrationDelivery } from './persistence';

export class IntegrationDeliveryRepository extends IntegrationRepositorySupport {
  get(id: string): Promise<IntegrationDelivery | undefined> {
    return this.readRow(
      INTEGRATION_DELIVERIES_STORE,
      id,
      normalizeIntegrationDelivery,
      'Could not read integration delivery',
    );
  }

  async put(delivery: IntegrationDelivery): Promise<void> {
    const normalized = normalizeIntegrationDelivery(delivery);
    if (!normalized) throw new Error('Invalid integration delivery');
    await this.writeRow(INTEGRATION_DELIVERIES_STORE, normalized, 'Could not write integration delivery');
  }

  async listStream(destinationId: string, recordingId: string): Promise<IntegrationDelivery[]> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const store = database.transaction(INTEGRATION_DELIVERIES_STORE, 'readonly')
        .objectStore(INTEGRATION_DELIVERIES_STORE);
      const range = IDBKeyRange.bound(
        [destinationId, recordingId, Number.MIN_SAFE_INTEGER],
        [destinationId, recordingId, Number.MAX_SAFE_INTEGER],
      );
      const request = store.index(DELIVERY_STREAM_REVISION_INDEX).getAll(range);
      request.onsuccess = () => resolve(
        request.result
          .map(normalizeIntegrationDelivery)
          .filter((row): row is IntegrationDelivery => row != null),
      );
      request.onerror = () => reject(request.error ?? new Error('Could not list integration deliveries'));
    });
  }

  list(): Promise<IntegrationDelivery[]> {
    return this.readAllRows(
      INTEGRATION_DELIVERIES_STORE,
      normalizeIntegrationDelivery,
      'Could not list integration deliveries',
    );
  }

  remove(id: string): Promise<void> {
    return this.deleteRow(INTEGRATION_DELIVERIES_STORE, id, 'Could not delete integration delivery');
  }
}
