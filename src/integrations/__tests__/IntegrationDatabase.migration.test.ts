import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationSecretRepository } from '../IntegrationSecretRepository';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';

function seedVersion1(factory: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open('meeting-integrations', 1);
    request.onupgradeneeded = () => {
      const destinations = request.result.createObjectStore('destinations', { keyPath: 'id' });
      const secrets = request.result.createObjectStore('secrets', { keyPath: 'id' });
      destinations.put({
        id: 'destination_v1',
        producerId: 'producer_v1',
        name: 'Existing CRM',
        type: 'webhook',
        enabled: true,
        endpoint: 'https://crm.example.test/hook',
        routingDefault: 'manual',
        dataPolicy: { ...CONSERVATIVE_INTEGRATION_POLICY, metadata: true },
        requestAuth: { type: 'none' },
        signingSecretId: 'secret_signing',
        connectionVersion: 1,
        createdAt: 100,
        updatedAt: 100,
      });
      secrets.put({
        id: 'secret_signing',
        kind: 'signing',
        value: 'whsec_existing',
        createdAt: 100,
        updatedAt: 100,
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function seedVersion2WithQueuedLegacyDelivery(factory: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open('meeting-integrations', 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('destinations', { keyPath: 'id' });
      database.createObjectStore('secrets', { keyPath: 'id' });
      database.createObjectStore('routingIntents', { keyPath: 'recordingId' });
      database.createObjectStore('streams', { keyPath: ['destinationId', 'recordingId'] });
      const deliveries = database.createObjectStore('deliveries', { keyPath: 'id' });
      deliveries.createIndex('streamRevision', ['destinationId', 'recordingId', 'revision'], { unique: true });
      deliveries.createIndex('nextAttemptAt', 'nextAttemptAt');
      deliveries.put({
        id: 'delivery_legacy',
        destinationId: 'destination_legacy',
        recordingId: 'recording_legacy',
        externalRecordingId: 'external_legacy',
        eventId: 'event_legacy',
        eventType: 'recording.ready.v1',
        revision: 1,
        eventTime: 100,
        connectionVersion: 1,
        state: 'retrying',
        attemptCount: 1,
        nextAttemptAt: 200,
        bodyHash: 'a'.repeat(64),
        createdAt: 100,
        updatedAt: 150,
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('meeting-integrations migration', () => {
  it('upgrades v1 credentials to the full routing/outbox schema without losing them', async () => {
    const factory = new IDBFactory();
    await seedVersion1(factory);

    const destinations = new IntegrationDestinationRepository(factory);
    const secrets = new IntegrationSecretRepository(factory);
    await expect(destinations.get('destination_v1')).resolves.toEqual(expect.objectContaining({
      id: 'destination_v1',
      producerId: 'producer_v1',
    }));
    await expect(secrets.get('secret_signing')).resolves.toEqual(expect.objectContaining({
      value: 'whsec_existing',
    }));

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('meeting-integrations');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(database.version).toBe(3);
    expect(Array.from(database.objectStoreNames)).toEqual(expect.arrayContaining([
      'destinations',
      'secrets',
      'routingIntents',
      'streams',
      'deliveries',
    ]));
    const deliveryStore = database.transaction('deliveries', 'readonly').objectStore('deliveries');
    expect(deliveryStore.indexNames.contains('streamRevision')).toBe(true);
    expect(deliveryStore.indexNames.contains('nextAttemptAt')).toBe(true);
    database.close();
  });

  it('fences unresolved v2 deliveries whose original authorization ceiling is unknowable', async () => {
    const factory = new IDBFactory();
    await seedVersion2WithQueuedLegacyDelivery(factory);

    const deliveries = new IntegrationDeliveryRepository(factory);
    await expect(deliveries.get('delivery_legacy')).resolves.toEqual(expect.objectContaining({
      state: 'action-required',
      lastErrorCode: 'authorization-ceiling-missing',
    }));
    const migrated = await deliveries.get('delivery_legacy');
    expect(migrated?.allowedPolicy).toBeUndefined();
    expect(migrated?.nextAttemptAt).toBeUndefined();
  });
});
