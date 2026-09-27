import { buildRecordingCloudEvent, type RecordingCloudEventInput } from './CloudEventBuilder';
import type { IntegrationProjectionInput } from './IntegrationProjector';
import { projectIntegrationRecording } from './IntegrationProjector';
import { measureIntegrationPayload, type IntegrationPayloadMeasurement } from './payload';

export type IntegrationSnapshotBuildInput = Omit<RecordingCloudEventInput, 'recording'> & {
  projection: IntegrationProjectionInput;
};

/**
 * The single production path from canonical recording state to transmitted JSON.
 * Preview, downloads and webhook delivery must all call this boundary rather than
 * serializing their own lookalike payloads.
 */
export function buildIntegrationSnapshotPayload(
  input: IntegrationSnapshotBuildInput,
): IntegrationPayloadMeasurement {
  const recording = projectIntegrationRecording(input.projection);
  const event = buildRecordingCloudEvent({
    eventTypePrefix: input.eventTypePrefix,
    eventKind: input.eventKind,
    eventId: input.eventId,
    eventTime: input.eventTime,
    producerId: input.producerId,
    externalRecordingId: input.externalRecordingId,
    revision: input.revision,
    readiness: input.readiness,
    recording,
  });
  return measureIntegrationPayload(event);
}
