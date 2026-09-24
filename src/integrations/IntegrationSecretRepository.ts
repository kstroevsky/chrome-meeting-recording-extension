import { INTEGRATION_SECRETS_STORE } from './IntegrationDatabase';
import { IntegrationRepositorySupport } from './IntegrationRepositorySupport';
import { normalizeIntegrationSecret, type IntegrationSecret } from './persistence';

/** Internal-only credential boundary. Deliberately has no list() method. */
export class IntegrationSecretRepository extends IntegrationRepositorySupport {
  get(id: string): Promise<IntegrationSecret | undefined> {
    return this.readRow(
      INTEGRATION_SECRETS_STORE,
      id,
      normalizeIntegrationSecret,
      'Could not read integration secret',
    );
  }

  async put(secret: IntegrationSecret): Promise<void> {
    const normalized = normalizeIntegrationSecret(secret);
    if (!normalized) throw new Error('Invalid integration secret');
    await this.writeRow(INTEGRATION_SECRETS_STORE, normalized, 'Could not write integration secret');
  }

  remove(id: string): Promise<void> {
    return this.deleteRow(INTEGRATION_SECRETS_STORE, id, 'Could not delete integration secret');
  }
}
