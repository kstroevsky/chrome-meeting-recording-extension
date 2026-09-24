import { containsHostPermission, removeHostPermission } from '../../platform/chrome/permissions';
import { clearAlarm, createAlarm, getAlarm } from '../../platform/chrome/alarms';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { Transcript } from '../../shared/transcript';
import { integrationEventTypePrefix } from '../../integrations/config';
import { IntegrationCoordinator } from '../../integrations/IntegrationCoordinator';
import { IntegrationDispatcher } from '../../integrations/IntegrationDispatcher';
import { IntegrationDeliveryRepository } from '../../integrations/IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../../integrations/IntegrationDestinationRepository';
import { IntegrationSecretRepository } from '../../integrations/IntegrationSecretRepository';
import { IntegrationStreamRepository } from '../../integrations/IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../../integrations/IntegrationUnitOfWork';
import { IntegrationScheduler } from '../../integrations/IntegrationScheduler';
import type { CreateIntegrationDestinationInput } from '../../integrations/management';
import type { IntegrationDataPolicy, IntegrationRecordingOption } from '../../integrations/contracts';
import { WebhookTransport } from '../../integrations/webhook/WebhookTransport';
import { IntegrationPreviewService } from './IntegrationPreviewService';
import type { AnalysisExportState } from '../library/analysis/RecordingAnalysisService';

type CanonicalRecordingReaders = {
  listHistory(): Promise<RecordingHistoryEntry[]>;
  getHistory(recordingId: string): Promise<RecordingHistoryEntry | undefined>;
  getContext(recordingId: string): Promise<RecordingContext | undefined>;
  listNotations(recordingId: string): Promise<RecordingNotation[]>;
  getTranscript(recordingId: string): Promise<Transcript | undefined>;
  getAnalysisState(recordingId: string): Promise<AnalysisExportState>;
};

/** Background composition boundary for all external-integration operations. */
export class BackgroundIntegrationRuntime {
  private readonly previewService: IntegrationPreviewService;
  private readonly coordinator: IntegrationCoordinator;
  private readonly dispatcher: IntegrationDispatcher;
  private readonly scheduler: IntegrationScheduler;

  constructor(private readonly readers: CanonicalRecordingReaders, factory?: IDBFactory) {
    this.previewService = new IntegrationPreviewService(readers);
    const destinations = new IntegrationDestinationRepository(factory);
    const secrets = new IntegrationSecretRepository(factory);
    const streams = new IntegrationStreamRepository(factory);
    const deliveries = new IntegrationDeliveryRepository(factory);
    const unitOfWork = new IntegrationUnitOfWork(factory);
    const transport = new WebhookTransport();
    let scheduler!: IntegrationScheduler;
    this.dispatcher = new IntegrationDispatcher({
      destinations,
      secrets,
      streams,
      deliveries,
      unitOfWork,
      snapshots: this.previewService,
      transport,
      containsHostPermission,
      eventTypePrefix: integrationEventTypePrefix(),
      onStateChanged: () => scheduler.stateChanged(),
    });
    scheduler = new IntegrationScheduler({
      deliveries,
      dispatcher: this.dispatcher,
      createAlarm,
      getAlarm,
      clearAlarm,
      warn: (...args) => console.warn('[integrations]', ...args),
    });
    this.scheduler = scheduler;
    this.coordinator = new IntegrationCoordinator({
      destinations,
      secrets,
      streams,
      deliveries,
      unitOfWork,
      dispatcher: this.dispatcher,
      snapshots: this.previewService,
      transport,
      containsHostPermission,
      removeHostPermission,
      eventTypePrefix: integrationEventTypePrefix(),
    });
  }

  preview(recordingId: string, policy: IntegrationDataPolicy) {
    return this.previewService.preview(recordingId, policy);
  }

  async listRecordings(): Promise<IntegrationRecordingOption[]> {
    const entries = await this.readers.listHistory();
    return await Promise.all(entries.map(async (entry) => {
      const context = await this.readers.getContext(entry.id);
      return context
        ? { id: entry.id, name: entry.name, available: true }
        : {
            id: entry.id,
            name: entry.name,
            available: false,
            unavailableReason: 'missing-recording-context' as const,
          };
    }));
  }

  listDestinations() {
    return this.coordinator.listDestinations();
  }

  createDestination(input: CreateIntegrationDestinationInput) {
    return this.coordinator.createDestination(input);
  }

  testDestination(destinationId: string) {
    return this.coordinator.testDestination(destinationId);
  }

  deleteDestination(destinationId: string) {
    return this.coordinator.deleteDestination(destinationId);
  }

  sendRecording(destinationId: string, recordingId: string) {
    return this.coordinator.sendRecording(destinationId, recordingId);
  }

  listDeliveries() {
    return this.coordinator.listDeliveries();
  }

  retryDelivery(deliveryId: string) {
    return this.dispatcher.retry(deliveryId);
  }

  reconcile() {
    return this.scheduler.reconcile();
  }

  handleAlarm(alarm: { name: string }): void {
    this.scheduler.handleAlarm(alarm);
  }
}
