import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationRoutingRepository } from '../IntegrationRoutingRepository';
import { IntegrationSecretRepository } from '../IntegrationSecretRepository';
import { IntegrationStreamRepository } from '../IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../IntegrationUnitOfWork';
import type { IntegrationDelivery } from '../persistence';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';

const DATA_POLICY = {
  ...CONSERVATIVE_INTEGRATION_POLICY,
  metadata: true,
  transcript: true,
  transcriptSpeakers: 'pseudonyms' as const,
};

describe('integration persistence repositories', () => {
  it('survives repository reconstruction while keeping external identities destination-scoped', async () => {
    const factory = new IDBFactory();
    const destinations = new IntegrationDestinationRepository(factory);
    const secrets = new IntegrationSecretRepository(factory);
    const routing = new IntegrationRoutingRepository(factory);
    const streams = new IntegrationStreamRepository(factory);
    const deliveries = new IntegrationDeliveryRepository(factory);

    await secrets.put({
      id: 'secret_signing',
      kind: 'signing',
      value: 'whsec_private-value',
      createdAt: 10,
      updatedAt: 10,
    });
    await destinations.put({
      id: 'destination_crm',
      producerId: 'producer_crm',
      name: 'CRM',
      type: 'webhook',
      enabled: true,
      endpoint: 'https://crm.example.test/events',
      routingDefault: 'review',
      dataPolicy: DATA_POLICY,
      requestAuth: { type: 'none' },
      signingSecretId: 'secret_signing',
      connectionVersion: 1,
      createdAt: 10,
      updatedAt: 10,
    });
    await routing.put({
      recordingId: 'recording:internal',
      destinations: [{
        destinationId: 'destination_crm',
        mode: 'review',
        state: 'needs-review',
        allowedPolicy: DATA_POLICY,
        connectionVersion: 1,
      }],
    });
    await streams.put({
      destinationId: 'destination_crm',
      recordingId: 'recording:internal',
      externalRecordingId: 'recording_external_crm',
      nextRevision: 2,
      readyCreated: true,
      everAttempted: true,
      lastPlannedProjectionHash: 'projection-hash',
    });
    await streams.put({
      destinationId: 'destination_analyzer',
      recordingId: 'recording:internal',
      externalRecordingId: 'recording_external_analyzer',
      nextRevision: 1,
      readyCreated: false,
      everAttempted: false,
    });
    await deliveries.put({
      id: 'delivery_1',
      destinationId: 'destination_crm',
      recordingId: 'recording:internal',
      externalRecordingId: 'recording_external_crm',
      eventId: 'event_1',
      eventType: 'recording.ready.v1',
      revision: 1,
      eventTime: 20,
      connectionVersion: 1,
      allowedPolicy: DATA_POLICY,
      state: 'retrying',
      attemptCount: 1,
      nextAttemptAt: 30,
      bodyHash: 'a'.repeat(64),
      lastStatus: 503,
      lastErrorCode: 'http-503',
      createdAt: 20,
      updatedAt: 25,
      body: '{"must":"not persist"}',
    } as IntegrationDelivery & { body: string });

    const restartedDestinations = new IntegrationDestinationRepository(factory);
    const restartedSecrets = new IntegrationSecretRepository(factory);
    const restartedRouting = new IntegrationRoutingRepository(factory);
    const restartedStreams = new IntegrationStreamRepository(factory);
    const restartedDeliveries = new IntegrationDeliveryRepository(factory);

    await expect(restartedDestinations.list()).resolves.toEqual([
      expect.objectContaining({ id: 'destination_crm', producerId: 'producer_crm' }),
    ]);
    await expect(restartedSecrets.get('secret_signing')).resolves.toEqual(expect.objectContaining({
      value: 'whsec_private-value',
    }));
    expect('list' in restartedSecrets).toBe(false);
    await expect(restartedRouting.get('recording:internal')).resolves.toEqual(expect.objectContaining({
      destinations: [expect.objectContaining({ destinationId: 'destination_crm', state: 'needs-review' })],
    }));
    await expect(restartedStreams.get('destination_crm', 'recording:internal')).resolves.toEqual(
      expect.objectContaining({ externalRecordingId: 'recording_external_crm' }),
    );
    await expect(restartedStreams.get('destination_analyzer', 'recording:internal')).resolves.toEqual(
      expect.objectContaining({ externalRecordingId: 'recording_external_analyzer' }),
    );
    await expect(restartedDeliveries.listStream('destination_crm', 'recording:internal')).resolves.toEqual([
      expect.not.objectContaining({ body: expect.anything() }),
    ]);
  });

  it('rejects delivery state that cannot be safely reconstructed', async () => {
    const repository = new IntegrationDeliveryRepository(new IDBFactory());
    const invalid = {
      id: 'delivery_bad',
      destinationId: 'destination_crm',
      recordingId: 'recording:internal',
      externalRecordingId: 'recording_external_crm',
      eventId: 'event_bad',
      eventType: 'recording.ready.v1',
      revision: 1,
      eventTime: 20,
      connectionVersion: 1,
      state: 'retrying',
      attemptCount: 1,
      bodyHash: 'not-a-sha256',
      createdAt: 20,
      updatedAt: 20,
    } as IntegrationDelivery;

    await expect(repository.put(invalid)).rejects.toThrow('Invalid integration delivery');
  });

  it('rolls back the stream update when delivery planning violates the unique revision index', async () => {
    const factory = new IDBFactory();
    const streams = new IntegrationStreamRepository(factory);
    const deliveries = new IntegrationDeliveryRepository(factory);
    const unitOfWork = new IntegrationUnitOfWork(factory);
    const stream = {
      destinationId: 'destination_crm',
      recordingId: 'recording:internal',
      externalRecordingId: 'recording_external_crm',
      nextRevision: 2,
      readyCreated: true,
      everAttempted: true,
    };
    await streams.put(stream);
    const delivery: IntegrationDelivery = {
      id: 'delivery_1',
      destinationId: stream.destinationId,
      recordingId: stream.recordingId,
      externalRecordingId: stream.externalRecordingId,
      eventId: 'event_1',
      eventType: 'recording.ready.v1',
      revision: 1,
      eventTime: 20,
      connectionVersion: 1,
      allowedPolicy: DATA_POLICY,
      state: 'pending',
      attemptCount: 0,
      bodyHash: 'a'.repeat(64),
      totalBytes: 100,
      transcriptBytes: 40,
      createdAt: 20,
      updatedAt: 20,
    };
    await deliveries.put(delivery);

    await expect(unitOfWork.planDelivery(
      { ...delivery, id: 'delivery_2', eventId: 'event_2' },
      { ...stream, nextRevision: 3 },
    )).rejects.toBeDefined();

    await expect(streams.get(stream.destinationId, stream.recordingId)).resolves.toEqual(stream);
    await expect(deliveries.listStream(stream.destinationId, stream.recordingId)).resolves.toEqual([delivery]);
  });
});
