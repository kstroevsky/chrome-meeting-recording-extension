import {
  DELIVERY_NEXT_ATTEMPT_INDEX,
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
    if (
      !normalized.allowedPolicy
      && (normalized.state === 'pending' || normalized.state === 'delivering' || normalized.state === 'retrying')
    ) {
      throw new Error('Integration delivery authorization ceiling is required');
    }
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

  async listDue(now: number, limit = 50): Promise<IntegrationDelivery[]> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const store = database.transaction(INTEGRATION_DELIVERIES_STORE, 'readonly')
        .objectStore(INTEGRATION_DELIVERIES_STORE);
      const rows: IntegrationDelivery[] = [];
      const request = store.index(DELIVERY_NEXT_ATTEMPT_INDEX).openCursor(IDBKeyRange.upperBound(now));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) {
          resolve(rows);
          return;
        }
        const row = normalizeIntegrationDelivery(cursor.value);
        if (row && (row.state === 'pending' || row.state === 'retrying')) rows.push(row);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Could not list due integration deliveries'));
    });
  }

  async earliestNextAttemptAt(): Promise<number | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const store = database.transaction(INTEGRATION_DELIVERIES_STORE, 'readonly')
        .objectStore(INTEGRATION_DELIVERIES_STORE);
      const request = store.index(DELIVERY_NEXT_ATTEMPT_INDEX).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(undefined);
          return;
        }
        const row = normalizeIntegrationDelivery(cursor.value);
        if (
          row
          && row.nextAttemptAt != null
          && (row.state === 'pending' || row.state === 'retrying')
        ) {
          resolve(row.nextAttemptAt);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read next integration delivery attempt'));
    });
  }

  remove(id: string): Promise<void> {
    return this.deleteRow(INTEGRATION_DELIVERIES_STORE, id, 'Could not delete integration delivery');
  }
}
