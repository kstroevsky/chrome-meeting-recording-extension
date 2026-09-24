import { INTEGRATION_DESTINATIONS_STORE } from './IntegrationDatabase';
import {
  normalizeIntegrationDestination,
  type IntegrationDestination,
} from './persistence';
import { IntegrationRepositorySupport } from './IntegrationRepositorySupport';

export class IntegrationDestinationRepository extends IntegrationRepositorySupport {
  get(id: string): Promise<IntegrationDestination | undefined> {
    return this.readRow(
      INTEGRATION_DESTINATIONS_STORE,
      id,
      normalizeIntegrationDestination,
      'Could not read integration destination',
    );
  }

  list(): Promise<IntegrationDestination[]> {
    return this.readAllRows(
      INTEGRATION_DESTINATIONS_STORE,
      normalizeIntegrationDestination,
      'Could not list integration destinations',
    );
  }

  async put(destination: IntegrationDestination): Promise<void> {
    const normalized = normalizeIntegrationDestination(destination);
    if (!normalized) throw new Error('Invalid integration destination');
    await this.writeRow(INTEGRATION_DESTINATIONS_STORE, normalized, 'Could not write integration destination');
  }

  remove(id: string): Promise<void> {
    return this.deleteRow(INTEGRATION_DESTINATIONS_STORE, id, 'Could not delete integration destination');
  }
}
