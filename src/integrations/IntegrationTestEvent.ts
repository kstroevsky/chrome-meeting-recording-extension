import type { StructuredCloudEvent } from './contracts';
import { assertIntegrationEventTypePrefix } from './CloudEventBuilder';
import { stableJsonSerialize } from './serialization';

export type IntegrationTestEventData = { test: true };

export function buildIntegrationTestPayload(input: {
  eventTypePrefix: string;
  eventId: string;
  eventTime: number;
  producerId: string;
}): string {
  assertIntegrationEventTypePrefix(input.eventTypePrefix);
  const event: StructuredCloudEvent<IntegrationTestEventData> = {
    specversion: '1.0',
    id: input.eventId,
    source: `urn:meeting-recorder:destination:${input.producerId}`,
    type: `${input.eventTypePrefix}.integration.test.v1`,
    subject: 'integration/test',
    time: new Date(input.eventTime).toISOString(),
    datacontenttype: 'application/json',
    data: { test: true },
  };
  return stableJsonSerialize(event);
}
