export type IntegrationIdPrefix =
  | 'destination'
  | 'producer'
  | 'recording'
  | 'event'
  | 'delivery'
  | 'secret';

export function createIntegrationId(prefix: IntegrationIdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
