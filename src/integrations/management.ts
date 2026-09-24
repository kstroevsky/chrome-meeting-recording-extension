import type { IntegrationDataPolicy } from './contracts';
import type { IntegrationDestination, IntegrationRoutingDefault } from './persistence';

export type IntegrationRequestAuthDraft =
  | { type: 'none' }
  | { type: 'bearer'; value: string }
  | { type: 'api-key'; header: string; value: string };

export type CreateIntegrationDestinationInput = {
  name: string;
  endpoint: string;
  routingDefault: IntegrationRoutingDefault;
  dataPolicy: IntegrationDataPolicy;
  requestAuth: IntegrationRequestAuthDraft;
};

export type CreatedIntegrationDestination = {
  destination: IntegrationDestination;
  /** One-time display value. Normal list/read operations never return it. */
  signingSecret: string;
};

export type IntegrationConnectionTestResult = {
  ok: boolean;
  status: number;
  eventId: string;
};
