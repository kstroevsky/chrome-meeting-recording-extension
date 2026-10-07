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
import { IntegrationEventPlanner } from '../../integrations/IntegrationEventPlanner';
import { IntegrationReadinessScheduler } from '../../integrations/IntegrationReadinessScheduler';
import { IntegrationRoutingRepository } from '../../integrations/IntegrationRoutingRepository';
import { IntegrationSecretRepository } from '../../integrations/IntegrationSecretRepository';
import { IntegrationStreamRepository } from '../../integrations/IntegrationStreamRepository';
import { KeyedCoalescer } from '../../integrations/KeyedCoalescer';
import { IntegrationUnitOfWork } from '../../integrations/IntegrationUnitOfWork';
import { IntegrationScheduler } from '../../integrations/IntegrationScheduler';
import { RecordingRoutingService } from '../../integrations/RecordingRoutingService';
import type { RecordingDestinationRoute } from '../../shared/recordingDestinations';
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
  private readonly deliveryScheduler: IntegrationScheduler;
  private readonly readinessScheduler: IntegrationReadinessScheduler;
  private readonly planner: IntegrationEventPlanner;
  private readonly routing: IntegrationRoutingRepository;
  private readonly recordingRouting: RecordingRoutingService;
  /** Upload progress and captions notify in bursts; each recording is considered once at a time. */
  private readonly considerations = new KeyedCoalescer((recordingId) => this.considerRecording(recordingId));

  constructor(private readonly readers: CanonicalRecordingReaders, factory?: IDBFactory) {
    this.previewService = new IntegrationPreviewService(readers);
    const destinations = new IntegrationDestinationRepository(factory);
    const secrets = new IntegrationSecretRepository(factory);
    const streams = new IntegrationStreamRepository(factory);
    const routing = new IntegrationRoutingRepository(factory);
    const deliveries = new IntegrationDeliveryRepository(factory);
    const unitOfWork = new IntegrationUnitOfWork(factory);
    const transport = new WebhookTransport();
    this.routing = routing;
    let deliveryScheduler!: IntegrationScheduler;
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
      onStateChanged: () => deliveryScheduler.stateChanged(),
    });
    deliveryScheduler = new IntegrationScheduler({
      deliveries,
      dispatcher: this.dispatcher,
      createAlarm,
      getAlarm,
      clearAlarm,
      warn: (...args) => console.warn('[integrations]', ...args),
    });
    this.deliveryScheduler = deliveryScheduler;
    this.planner = new IntegrationEventPlanner({
      destinations,
      routing,
      streams,
      unitOfWork,
      snapshots: this.previewService,
      isRecordingFinalized: async (recordingId) => (await readers.getContext(recordingId))?.endedAt != null,
      eventTypePrefix: integrationEventTypePrefix(),
    });
    this.readinessScheduler = new IntegrationReadinessScheduler({
      streams,
      consider: (destinationId, recordingId) => this.considerStream(destinationId, recordingId),
      createAlarm,
      getAlarm,
      clearAlarm,
      warn: (...args) => console.warn('[integrations]', ...args),
    });
    this.recordingRouting = new RecordingRoutingService({
      destinations,
      routing,
      unitOfWork,
      consider: (recordingId) => this.consider(recordingId),
    });
    this.coordinator = new IntegrationCoordinator({
      destinations,
      secrets,
      deliveries,
      unitOfWork,
      planner: this.planner,
      dispatcher: this.dispatcher,
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

  async deleteDestination(destinationId: string) {
    const result = await this.coordinator.deleteDestination(destinationId);
    await this.readinessScheduler.stateChanged();
    return result;
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

  /** Holds the routes of a "Save to" destination for a recording that is starting. */
  beginRecordingRouting(recordingId: string, routes: readonly RecordingDestinationRoute[]) {
    return this.recordingRouting.begin(recordingId, routes);
  }

  /** The end dialog's answer: release the held routes, except the removed ones. */
  confirmRecordingRoutes(recordingId: string, removedDestinationIds: readonly string[]) {
    return this.recordingRouting.confirm(recordingId, removedDestinationIds);
  }

  /** A discarded run or a removed recording: nothing about it leaves the browser any more. */
  forgetRecordingRouting(recordingId: string): Promise<void> {
    return this.recordingRouting.forget(recordingId);
  }

  heldRecordings(): Promise<string[]> {
    return this.recordingRouting.held();
  }

  recordingRoutes(recordingId: string, expected: readonly RecordingDestinationRoute[] = []) {
    return this.recordingRouting.routes(recordingId, expected);
  }

  consider(recordingId: string): Promise<void> {
    return this.considerations.request(recordingId);
  }

  private async considerRecording(recordingId: string): Promise<void> {
    const intent = await this.routing.get(recordingId);
    if (!intent) return;
    const results = await Promise.allSettled(
      intent.destinations.map(({ destinationId }) => this.considerStream(destinationId, recordingId)),
    );
    for (const result of results) {
      if (result.status === 'rejected') console.warn('[integrations] recording consideration failed:', result.reason);
    }
  }

  async reconcile(): Promise<void> {
    const intents = await this.routing.list();
    for (const intent of intents) await this.consider(intent.recordingId);
    await this.readinessScheduler.reconcile();
    await this.deliveryScheduler.reconcile();
  }

  handleAlarm(alarm: { name: string }): void {
    this.deliveryScheduler.handleAlarm(alarm);
    this.readinessScheduler.handleAlarm(alarm);
  }

  private async considerStream(destinationId: string, recordingId: string): Promise<void> {
    const result = await this.planner.consider(destinationId, recordingId);
    await this.readinessScheduler.stateChanged();
    if (result.kind === 'planned') {
      await this.dispatcher.dispatch(result.delivery.id, result.body);
    }
  }
}
