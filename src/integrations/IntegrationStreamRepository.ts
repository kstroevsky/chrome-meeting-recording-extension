import { INTEGRATION_STREAMS_STORE } from './IntegrationDatabase';
import { IntegrationRepositorySupport } from './IntegrationRepositorySupport';
import { normalizeIntegrationStream, type IntegrationStream } from './persistence';

export class IntegrationStreamRepository extends IntegrationRepositorySupport {
  get(destinationId: string, recordingId: string): Promise<IntegrationStream | undefined> {
    return this.readRow(
      INTEGRATION_STREAMS_STORE,
      [destinationId, recordingId],
      normalizeIntegrationStream,
      'Could not read integration stream',
    );
  }

  async put(stream: IntegrationStream): Promise<void> {
    const normalized = normalizeIntegrationStream(stream);
    if (!normalized) throw new Error('Invalid integration stream');
    await this.writeRow(INTEGRATION_STREAMS_STORE, normalized, 'Could not write integration stream');
  }

  list(): Promise<IntegrationStream[]> {
    return this.readAllRows(
      INTEGRATION_STREAMS_STORE,
      normalizeIntegrationStream,
      'Could not list integration streams',
    );
  }

  remove(destinationId: string, recordingId: string): Promise<void> {
    return this.deleteRow(
      INTEGRATION_STREAMS_STORE,
      [destinationId, recordingId],
      'Could not delete integration stream',
    );
  }
}
