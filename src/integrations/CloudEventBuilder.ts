import type {
  IntegrationEventKind,
  IntegrationReadiness,
  IntegrationRecordingV1,
  RecordingSnapshotEventData,
  StructuredCloudEvent,
} from './contracts';
import { INTEGRATION_EVENT_TYPE_PREFIX } from './config';

export type RecordingCloudEventInput = {
  eventTypePrefix: string;
  eventKind: Extract<IntegrationEventKind, 'recording.ready.v1' | 'recording.updated.v1'>;
  eventId: string;
  eventTime: number;
  producerId: string;
  externalRecordingId: string;
  revision: number;
  readiness: IntegrationReadiness;
  recording: IntegrationRecordingV1;
};

export function buildRecordingCloudEvent(
  input: RecordingCloudEventInput,
): StructuredCloudEvent<RecordingSnapshotEventData> {
  assertIntegrationEventTypePrefix(input.eventTypePrefix);
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error('Integration revision must be a positive integer');
  }

  return {
    specversion: '1.0',
    id: input.eventId,
    source: `urn:meeting-recorder:destination:${input.producerId}`,
    type: `${input.eventTypePrefix}.${input.eventKind}`,
    subject: `recording/${input.externalRecordingId}`,
    time: new Date(input.eventTime).toISOString(),
    datacontenttype: 'application/json',
    data: {
      revision: input.revision,
      readiness: {
        complete: input.readiness.complete,
        release: input.readiness.release,
        pending: [...input.readiness.pending],
      },
      recording: input.recording,
    },
  };
}

export function assertIntegrationEventTypePrefix(prefix: string): void {
  if (prefix !== INTEGRATION_EVENT_TYPE_PREFIX) {
    throw new Error(`Integration event type prefix must be ${INTEGRATION_EVENT_TYPE_PREFIX}`);
  }
}
