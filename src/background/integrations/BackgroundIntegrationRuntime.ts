import { containsHostPermission, removeHostPermission } from '../../platform/chrome/permissions';
import type { StoredAnalysis } from '../../shared/analysis/storedAnalysis';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { Transcript } from '../../shared/transcript';
import { integrationEventTypePrefix } from '../../integrations/config';
import { IntegrationCoordinator } from '../../integrations/IntegrationCoordinator';
import { IntegrationDeliveryRepository } from '../../integrations/IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../../integrations/IntegrationDestinationRepository';
import { IntegrationSecretRepository } from '../../integrations/IntegrationSecretRepository';
import { IntegrationStreamRepository } from '../../integrations/IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../../integrations/IntegrationUnitOfWork';
import type { CreateIntegrationDestinationInput } from '../../integrations/management';
import type { IntegrationDataPolicy } from '../../integrations/contracts';
import { WebhookTransport } from '../../integrations/webhook/WebhookTransport';
import { IntegrationPreviewService } from './IntegrationPreviewService';

type CanonicalRecordingReaders = {
  getHistory(recordingId: string): Promise<RecordingHistoryEntry | undefined>;
  getContext(recordingId: string): Promise<RecordingContext | undefined>;
  listNotations(recordingId: string): Promise<RecordingNotation[]>;
  getTranscript(recordingId: string): Promise<Transcript | undefined>;
  getAnalysis(recordingId: string): Promise<StoredAnalysis | undefined>;
};

/** Background composition boundary for all external-integration operations. */
export class BackgroundIntegrationRuntime {
  private readonly previewService: IntegrationPreviewService;
  private readonly coordinator: IntegrationCoordinator;

  constructor(readers: CanonicalRecordingReaders, factory?: IDBFactory) {
    this.previewService = new IntegrationPreviewService(readers);
    this.coordinator = new IntegrationCoordinator({
      destinations: new IntegrationDestinationRepository(factory),
      secrets: new IntegrationSecretRepository(factory),
      streams: new IntegrationStreamRepository(factory),
      deliveries: new IntegrationDeliveryRepository(factory),
      unitOfWork: new IntegrationUnitOfWork(factory),
      snapshots: this.previewService,
      transport: new WebhookTransport(),
      containsHostPermission,
      removeHostPermission,
      eventTypePrefix: integrationEventTypePrefix(),
    });
  }

  preview(recordingId: string, policy: IntegrationDataPolicy) {
    return this.previewService.preview(recordingId, policy);
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
}
