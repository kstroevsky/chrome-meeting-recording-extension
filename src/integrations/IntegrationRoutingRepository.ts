import { INTEGRATION_ROUTING_INTENTS_STORE } from './IntegrationDatabase';
import { IntegrationRepositorySupport } from './IntegrationRepositorySupport';
import {
  normalizeRecordingIntegrationIntent,
  type RecordingIntegrationIntent,
} from './persistence';

export class IntegrationRoutingRepository extends IntegrationRepositorySupport {
  get(recordingId: string): Promise<RecordingIntegrationIntent | undefined> {
    return this.readRow(
      INTEGRATION_ROUTING_INTENTS_STORE,
      recordingId,
      normalizeRecordingIntegrationIntent,
      'Could not read integration routing intent',
    );
  }

  async put(intent: RecordingIntegrationIntent): Promise<void> {
    const normalized = normalizeRecordingIntegrationIntent(intent);
    if (!normalized) throw new Error('Invalid integration routing intent');
    await this.writeRow(INTEGRATION_ROUTING_INTENTS_STORE, normalized, 'Could not write integration routing intent');
  }

  remove(recordingId: string): Promise<void> {
    return this.deleteRow(INTEGRATION_ROUTING_INTENTS_STORE, recordingId, 'Could not delete integration routing intent');
  }
}
