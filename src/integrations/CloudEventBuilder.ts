import type {
  IntegrationEventKind,
  IntegrationReadiness,
  IntegrationRecordingV1,
  RecordingSnapshotEventData,
  StructuredCloudEvent,
} from './contracts';

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
  if (!input.eventTypePrefix.trim()) throw new Error('Integration event type prefix is required');
  if (input.eventTypePrefix === 'com.example' || input.eventTypePrefix.startsWith('com.example.')) {
    throw new Error('Integration event type prefix must use a project-controlled domain');
  }
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
